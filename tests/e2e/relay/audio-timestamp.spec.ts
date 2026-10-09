import { expect, test, type Page } from "@playwright/test";
import type { PublisherStats, SubscriberStats } from "../../../devtools/src/testApi";
import { RELAY_TEST_TIMEOUT_MS, requireRelayUri } from "./support";

/**
 * 実リレー経由で、同じブラウザ (同じ devtools のページ) から音声と映像を配信し、
 * 同じページで購読して、受信側の音声の基準の遅れと、配信側の TIMESTAMP のずれの
 * 観測を確かめる。
 *
 * マイクの `AudioData.timestamp` は壁時計と同じ時計ではない。そのまま
 * LOC の TIMESTAMP にすると、受信側は音声が遅れて届いたと解釈し、音声の基準の遅れ
 * (`avSync.delays.audio.baseDelayMs`) が動き、jitter buffer の目標と映像の表示が
 * それに引きずられる。
 *
 * 偽のマイク (Chromium の fake device) を使い、受信側の音声の再生を有効にする
 * (再生しないと復号の出力が再生の時間軸へ記録されず、基準が出ない)。数十秒流しても
 * 基準の遅れが 10〜30 ms に収まり、段差で動かないことを固定する。
 */

// 偽のマイクは完全な Chromium (新しい headless) でだけ使える。Playwright の既定の
// headless shell は getUserMedia を NotSupportedError にする
test.use({
  launchOptions: { channel: "chromium" },
  // 偽のマイクの使用と、Copy for LLM の本文を読むためのクリップボード
  permissions: ["microphone", "clipboard-read", "clipboard-write"],
});

/** devtools のページ (playwright.config.ts の webServer、port 5173) */
const DEVTOOLS_URL = "http://localhost:5173/index.html";

/**
 * 観測を続ける秒数
 *
 * 受信側の窓と jitter buffer の学習 (2 秒と 500 ms の区間) が十分に埋まり、
 * 段差があれば観測に出る長さにする
 */
const OBSERVE_SECONDS = 15;

/** 受信側の音声の基準の遅れとして許す範囲 (ミリ秒) */
const AUDIO_BASE_DELAY_MIN_MS = 10;
const AUDIO_BASE_DELAY_MAX_MS = 30;

/**
 * 観測の間で許す、基準の遅れの動きの幅 (ミリ秒)
 *
 * 実測では 0.7 ms 以内で動かなかった。段差 (実測で 485〜627 ms) や、jitter buffer が
 * 段差を学習して膨らむ動きを捉える
 */
const AUDIO_BASE_DELAY_SPREAD_MS = 15;

/**
 * 映像の表示待ち (decoder の出力から描くまで) の p95 として許す上限 (ミリ秒)
 *
 * 実測では約 100 ms だった。音声の基準が動くと、受信側は映像を音声に合わせて遅らせる
 * ため、この値が伸びる
 */
const VIDEO_DISPLAY_WAIT_P95_MAX_MS = 200;

/**
 * 音声の鳴り始めるまでの遅れの p95 として許す上限 (ミリ秒)
 *
 * 実測では約 100〜190 ms だった。音声の基準の遅れを jitter buffer の目標が段差として
 * 学習すると、目標が 700 ms まで膨らむ
 */
const AUDIO_START_DELAY_P95_MAX_MS = 400;

interface DevtoolsStats {
  publisher: PublisherStats;
  subscriber: SubscriberStats | null;
}

/** devtools のページを開き、統計を読めるまで待つ */
async function openDevtoolsPage(page: Page): Promise<void> {
  // 偽のマイクを使う。映像は Canvas のダミー (カメラは使わない。受け入れ条件は音声)
  await page.goto(`${DEVTOOLS_URL}?audioSource=microphone&videoSource=dummy`);
  await page.waitForFunction(() =>
    Boolean((window as unknown as { moqtDevTools?: unknown }).moqtDevTools),
  );
}

/** 配信側と購読側の統計を読む */
async function readStats(page: Page): Promise<DevtoolsStats> {
  return page.evaluate(() => {
    const api = (
      window as unknown as {
        moqtDevTools: {
          getPublisher: () => PublisherStats;
          getSubscribers: () => SubscriberStats[];
        };
      }
    ).moqtDevTools;
    return { publisher: api.getPublisher(), subscriber: api.getSubscribers()[0] ?? null };
  });
}

test("実リレー経由で同じブラウザから音声を配信し、受信側の音声の基準の遅れが 10〜30 ms に収まる", async ({
  page,
}) => {
  test.setTimeout(RELAY_TEST_TIMEOUT_MS * 2);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  await openDevtoolsPage(page);

  // 受信側の音声を再生する。再生しないと復号の出力が再生の時間軸へ記録されず、
  // 基準 (`avSync.delays.audio.baseDelayMs`) が出ない
  await page.getByTestId("subscriber-audio-playback-toggle").click();

  // 同じページで実リレーへ配信する (接続先は URI の欄に入れると signal へ反映される)
  await page.getByTestId("moqt-uri").fill(moqtUri);
  await page.getByTestId("publisher-publish-button").click();

  // 音声の Object が実際に送られるまで待つ。固定の sleep は遅い runner で flaky になる
  await expect
    .poll(
      async () => {
        const stats = await readStats(page);
        return stats.publisher.audio.objectsSent;
      },
      {
        message: "Publisher が音声の Object を送信し始めるのを待つ",
        timeout: 30_000,
      },
    )
    .toBeGreaterThan(0);

  // 同じページで購読する
  await page.getByTestId("subscriber-subscribe-button").click();
  await expect
    .poll(
      async () => {
        const stats = await readStats(page);
        return stats.subscriber?.audio.chunksDecoded ?? 0;
      },
      {
        message: "Subscriber が音声を復号し始めるのを待つ",
        timeout: 30_000,
      },
    )
    .toBeGreaterThan(0);

  // 基準が観測されるまで待つ (購読の直後はまだ復号の出力が再生の時間軸へ入っていない)
  await expect
    .poll(
      async () => {
        const stats = await readStats(page);
        return stats.subscriber?.avSync.delays.audio.baseDelayMs ?? null;
      },
      {
        message: "受信側が音声の基準の遅れを観測し始めるのを待つ",
        timeout: 30_000,
      },
    )
    .not.toBeNull();

  // 数十秒の間、受信側の音声の基準の遅れを観測する
  const baseDelays: number[] = [];
  let previousDecoded = 0;
  for (let second = 0; second < OBSERVE_SECONDS; second++) {
    const stats = await readStats(page);
    // リレー側から切れると値が古いまま固定され、段差が無いように見えてしまう。購読が
    // 生きていて、音声を復号し続けていることを確かめてから値を読む
    const decoded = stats.subscriber?.audio.chunksDecoded ?? 0;
    expect(decoded, `${second} 秒目も音声を復号している`).toBeGreaterThan(previousDecoded);
    previousDecoded = decoded;

    const baseDelayMs = stats.subscriber?.avSync.delays.audio.baseDelayMs ?? null;
    // 未観測 (-) にならないこと。なると受信側は到着基準へ落ち、映像との基準を共有できない
    expect(baseDelayMs, `${second} 秒目に音声の基準の遅れが観測されている`).not.toBeNull();
    expect(
      stats.subscriber?.avSync.delays.unsharedReason,
      `${second} 秒目の基準を共有できない理由`,
    ).not.toBe("unobserved");
    baseDelays.push(baseDelayMs ?? Number.NaN);
    await page.waitForTimeout(1_000);
  }

  // 受け入れ条件: 基準の遅れが 10〜30 ms に収まる
  expect(Math.min(...baseDelays), "音声の基準の遅れの最小値").toBeGreaterThanOrEqual(
    AUDIO_BASE_DELAY_MIN_MS,
  );
  expect(Math.max(...baseDelays), "音声の基準の遅れの最大値").toBeLessThanOrEqual(
    AUDIO_BASE_DELAY_MAX_MS,
  );
  // 数十秒流しても段差で動かない (最小値と最大値の差)
  expect(
    Math.max(...baseDelays) - Math.min(...baseDelays),
    "音声の基準の遅れの動きの幅",
  ).toBeLessThanOrEqual(AUDIO_BASE_DELAY_SPREAD_MS);

  const stats = await readStats(page);

  // 受信側の映像と音声が悪化していないこと。音声の基準が動くと、受信側は映像を音声へ
  // 合わせて遅らせ、jitter buffer の目標も段差を学習して膨らむ
  expect(
    stats.subscriber?.playbackTiming.latencyBreakdown.displayWait?.p95 ?? Number.NaN,
    "映像の表示待ちの p95",
  ).toBeLessThanOrEqual(VIDEO_DISPLAY_WAIT_P95_MAX_MS);
  expect(
    stats.subscriber?.audio.playoutTiming.startDelayMs?.p95 ?? Number.NaN,
    "音声が鳴り始めるまでの遅れの p95",
  ).toBeLessThanOrEqual(AUDIO_START_DELAY_P95_MAX_MS);

  // 配信側の観測。現在値・最小・最大と 10 秒 / 60 秒の傾きが読める
  const offset = stats.publisher.audio.timestampOffset;
  expect(offset, "配信側の TIMESTAMP のずれの観測").not.toBeNull();
  expect(offset?.samples ?? 0, "観測の数").toBeGreaterThan(0);
  expect(Number.isFinite(offset?.currentMs), "現在値").toBe(true);
  expect(Number.isFinite(offset?.minMs), "最小値").toBe(true);
  expect(Number.isFinite(offset?.maxMs), "最大値").toBe(true);
  expect(offset?.appliedMs, "TIMESTAMP に足している補正").not.toBeNull();

  // 画面からも読めること
  await page.getByTestId("publisher-statistics-toggle").click();
  await expect(page.getByTestId("publisher-audio-offset-current")).not.toHaveText("-");
  await expect(page.getByTestId("publisher-audio-offset-min")).not.toHaveText("-");
  await expect(page.getByTestId("publisher-audio-offset-max")).not.toHaveText("-");
  await expect(page.getByTestId("publisher-audio-offset-samples")).not.toHaveText("-");

  // 「Copy for LLM」の本文にも入ること
  await page.getByRole("button", { name: /^Debug/ }).click();
  const copyButton = page.getByTestId("debug-log-copy-publisher");
  await copyButton.click();
  await expect(copyButton).toHaveText("Copied!");
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain("timestampOffset:");
  expect(text).toContain("slope10sMsPerSecond:");
  expect(text).toContain("slope60sMsPerSecond:");

  // Debug パネルを閉じる。パネルは画面の右側 (幅 640 px、全高) の固定表示であり、開くと本文が
  // 640 px 幅へ狭まる (devtools/src/App.tsx の mr-[640px])。狭い本文では値を出し続ける統計が
  // 折り返して高さを変え、下にある停止ボタンの位置が動き続ける (実測でも位置と高さが変わった)。
  // 位置が定まらない要素や固定表示に覆われた要素は、Playwright が「押せるようになるまで」
  // 待ち続けるため、後始末のクリックがテストのタイムアウトを使い切ることがあった。
  // パネルを閉じて幅を戻し、実際に押せる状態にしてから止める (タイムアウトは伸ばさない)
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Debug Logs" })).toBeHidden();

  // 後始末 (統計を読んでから止める)。リレー側から先に切れていることがあるため、
  // 押せる (まだ配信 / 購読中の) ときだけ止める
  const publisherStop = page.getByTestId("publisher-stop-button");
  if (await publisherStop.isEnabled()) {
    await publisherStop.click();
  }
  const subscriberStop = page.getByTestId("subscriber-stop-button");
  if (await subscriberStop.isEnabled()) {
    await subscriberStop.click();
  }
});
