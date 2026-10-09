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
//
// `channel: "chromium"` は getUserMedia を「使えるようにする」だけで、マイクの実体は
// 用意しない。CI の runner は音声の入力デバイスを持たないため、
// getUserMedia は NotFoundError になり、publisher は音声を諦めて (devtools の
// `prepareAudioForPublishing` が warn を残す) Object を 1 つも送らない。手元では実機の
// マイクがあるため、この違いが表面化していなかった。
// `--use-fake-device-for-media-stream` で Chromium の偽デバイスを用意し、手元と CI を
// 同じ条件にする (偽デバイスも音を 20 ms ごとに渡すため、配信と購読の経路はそのまま
// 検証できる)
test.use({
  launchOptions: {
    channel: "chromium",
    args: ["--use-fake-device-for-media-stream"],
  },
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

/**
 * 配信側の TIMESTAMP の補正が落ち着いたとみなす、値が動かない時間 (ミリ秒)
 *
 * 補正は「読み出した壁時計 - `AudioData.timestamp`」の直近の窓 (2 秒、
 * `AUDIO_TIMESTAMP_OFFSET_WINDOW_MS`) の最小値である。2 秒続けて同じ値なら、窓 1 つ分が
 * 同じ値で埋まったことになり、最小値が定まったとみなせる
 */
const TIMESTAMP_OFFSET_STABLE_MS = 2_000;

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
 * 追いつき中かを確かめる間隔 (ミリ秒)
 *
 * 実装 (`src/playbackTimeline.ts` の `CATCH_UP_CHECK_INTERVAL_MS`) と同じ間隔で見る。
 * 実装はこの間隔で基準の遅れの下がり幅を見て、live に追いついたかを決めている
 */
const CATCH_UP_CHECK_INTERVAL_MS = 250;

/**
 * 追いつき中とみなす、`CATCH_UP_CHECK_INTERVAL_MS` の間の基準の遅れの動き (ミリ秒)
 *
 * 実装は同じ間隔で見た下がり幅が `CATCH_UP_MIN_BASE_DROP_MS` (20 ms) 未満になったら
 * live に追いついたとみなす。テストはもっと小さな値で見る。live に追いついた後の基準の
 * 遅れは実測で 15 秒間に 0.7 ms しか動かないため、この値 (2 ms) を超える動きは追いつきの
 * 途中である。下がる方向 (古い音をまとめて復号している) と、上がる方向 (届いた分の復号が
 * 追いついていない) のどちらも遷移中として扱う
 */
const CATCH_UP_MOVEMENT_MS = 2;

/**
 * 追いつきが終わったとみなす、基準の遅れが動かない時間 (ミリ秒)
 */
const CATCH_UP_SETTLED_MS = 2_000;

/**
 * 追いつきが終わるまで待つ上限 (ミリ秒)
 *
 * 購読の直後の追いつきは、遅い runner でも数秒で終わる。終わらないのは、音声の経路が
 * 実時間に追いついていない場合であり、そのときは定常状態が無いため観測を始めずに落とす
 * (タイムアウトを伸ばして逃げない)
 */
const CATCH_UP_SETTLE_TIMEOUT_MS = 45_000;

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

/**
 * 後始末の停止ボタンを押すときの待ち時間 (ミリ秒)
 *
 * 停止ボタンは、リレー側から先に切れて購読 / 配信が後始末されると無効になる
 * (devtools の `subscriberControlState` は購読が確立していないとき `stopDisabled` にする)。
 * 無効になった後に押そうとすると、Playwright はテストのタイムアウト (180 秒) まで
 * 「押せるようになるのを待ち」続ける。実際に押せるかを短い時間で確かめる
 */
const STOP_CLICK_TIMEOUT_MS = 5_000;

/**
 * まだ動いているときだけ停止ボタンを押す
 *
 * 「押せるかを確かめてから押す」までに、リレー側から切れてボタンが無効になることがある
 * (実測: コンテナでは 4 回中 2 回、無効になった後のクリックがテストのタイムアウトを
 * 使い切った)。押せなかった理由が「無効になった」である場合だけ見送り、それ以外の理由は
 * そのまま投げる (本当に押せない不具合を隠さない)
 */
async function stopIfRunning(page: Page, testId: string): Promise<void> {
  const button = page.getByTestId(testId);
  if (!(await button.isEnabled())) {
    return;
  }
  try {
    await button.click({ timeout: STOP_CLICK_TIMEOUT_MS });
  } catch (error) {
    // ボタンごと消えた場合も、切れて後始末された証拠である。押せるままなら本当の失敗である
    const stillEnabled = await button.isEnabled().catch(() => false);
    if (stillEnabled) {
      throw error;
    }
  }
}

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

/**
 * 配信側の音声の TIMESTAMP の補正が落ち着くまで待つ
 *
 * 補正 (`publisher.audio.timestampOffset.appliedMs`) は音声フレームを読み出すたびに
 * 見直され、実測では公開から 4 秒ほど数 µs から 100 µs ずつ動いてから落ち着いた。
 *
 * 購読側は、復号へ渡した TIMESTAMP と復号の出力の TIMESTAMP が完全に一致することを
 * 前提に対応表を引く (devtools の useSubscriber)。復号の出力の TIMESTAMP は入力の
 * TIMESTAMP からサンプル数で組み立て直されるため、購読の途中で補正が動くと両者が数 µs
 * ずれて一致しなくなる。ずれたままだと音が共有の時間軸へ記録されず、基準の遅れが
 * 観測されないまま 30 秒を待ち切ることになる (実測で 5 回に 1 回落ちていた)。
 * 動かなくなってから購読する
 */
async function waitForTimestampOffsetStable(page: Page): Promise<void> {
  let previousMs: number | null = null;
  let unchangedSinceMs = 0;
  await expect
    .poll(
      async () => {
        // 待つ間も必要な値だけを読む。統計全体を繰り返し読むと配信側の音声の処理が
        // 実時間に追いつかなくなり、購読したときに古い音を受け取ることになる
        // (`readSubscriberObservation` の説明を参照)
        const publisherAudio = await readPublisherAudioObservation(page);
        const appliedMs = publisherAudio.appliedMs;
        if (appliedMs === null) {
          return false;
        }
        const nowMs = performance.now();
        if (appliedMs !== previousMs) {
          previousMs = appliedMs;
          unchangedSinceMs = nowMs;
          return false;
        }
        return nowMs - unchangedSinceMs >= TIMESTAMP_OFFSET_STABLE_MS;
      },
      {
        message: "配信側の TIMESTAMP の補正が落ち着くのを待つ",
        timeout: 30_000,
        intervals: [500],
      },
    )
    .toBe(true);
}

/** 配信側と購読側の統計を読む (1 回だけ読む検査に使う) */
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

/**
 * 待つ間と観測する間に読む、購読側の音声の値
 */
interface SubscriberObservation {
  /** 音声の基準の遅れ (ミリ秒)。まだ観測していなければ null */
  baseDelayMs: number | null;
  /** 基準を共有できていない理由 */
  unsharedReason: string | null;
  /** 復号した音声 Chunk の数 */
  chunksDecoded: number;
}

/**
 * 待つ間と観測する間に読む、配信側の音声の値
 */
interface PublisherAudioObservation {
  /** 送った音声 Object の数 */
  objectsSent: number;
  /** TIMESTAMP に足している補正 (ミリ秒)。まだ決まっていなければ null */
  appliedMs: number | null;
}

/**
 * 観測に使う値だけを読む
 *
 * `window.moqtDevTools` の `getPublisher()` / `getSubscribers()` が返す統計は、カタログの
 * JSON・セッション統計・音声の波形まで含む (実測で 7.6 KB)。`page.evaluate` はその組み立てと
 * 受け渡しをブラウザのメインスレッドで行うため、待つ間と観測する間ずっと繰り返すと、同じ
 * スレッドで音声の Object を配信・復号している処理を止める。
 *
 * 基準の遅れ (`avSync.delays.audio.baseDelayMs`) は「今 - 復号した音の TIMESTAMP」であり、
 * 音声が実時間から遅れると、その遅れは戻らない。実測では、メインスレッドを 8 秒止めると
 * 7919 ms の遅れが出て、止めるのをやめて 30 秒たっても戻らなかった (relay は遅れた購読者へ
 * まとめて配り直さない)。テスト自身がこの遅れを作ると、時計の合わせ方ではなくテストの負荷を
 * 測ることになる。
 *
 * そこで待つ間と観測する間は必要な値だけを読み (実測で 3.2 ms → 0.5 ms)、統計全体は
 * 落ち着いてから 1 回だけ読む。
 */
async function readSubscriberObservation(page: Page): Promise<SubscriberObservation> {
  return page.evaluate(() => {
    const api = (
      window as unknown as {
        moqtDevTools: {
          getSubscribers: () => SubscriberStats[];
        };
      }
    ).moqtDevTools;
    const subscriber = api.getSubscribers()[0] ?? null;
    return {
      baseDelayMs: subscriber?.avSync.delays.audio.baseDelayMs ?? null,
      unsharedReason: subscriber?.avSync.delays.unsharedReason ?? null,
      chunksDecoded: subscriber?.audio.chunksDecoded ?? 0,
    };
  });
}

/** 配信側の音声の観測に使う値だけを読む (`readSubscriberObservation` と同じ理由) */
async function readPublisherAudioObservation(page: Page): Promise<PublisherAudioObservation> {
  return page.evaluate(() => {
    const api = (
      window as unknown as {
        moqtDevTools: {
          getPublisher: () => PublisherStats;
        };
      }
    ).moqtDevTools;
    const audio = api.getPublisher().audio;
    return {
      objectsSent: audio.objectsSent,
      appliedMs: audio.timestampOffset?.appliedMs ?? null,
    };
  });
}

/**
 * 購読の直後の追いつきが終わるまで待つ
 *
 * 購読の直後は、relay の cache から届いた分と、購読を始めるまでに配信側と受信側へたまった
 * 分をまとめて復号する。この間、復号の出力の TIMESTAMP は実際より古いままであり、基準の
 * 遅れ (`avSync.delays.audio.baseDelayMs`) は「復号した音がどれだけ古いか」をそのまま拾う。
 * つまりこの値は、時計の合わせ方ではなく、音声の経路 (配信側で読んでから符号化して送り、
 * 受信側が復号して出力するまで) が実時間からどれだけ遅れているかを表す。遅れは一度できると
 * 戻らない (実測: メインスレッドを 8 秒止めると 7919 ms の遅れが出て、30 秒後も戻らなかった)。
 *
 * そこで購読の直後に落ち着いていない値を観測しないよう、実装 (`src/playbackTimeline.ts` の
 * `isCatchingUp`) と同じ考え方で基準の遅れの動きから追いつき中を判定し、
 * `CATCH_UP_SETTLED_MS` の間、動かなくなってから観測を始める。CI の遅い runner では、
 * この落ち着く前の値を拾って 14460 ms を観測していた (定常状態ではなく過渡)。
 * 観測そのものは弱めない (追いついた後の 15 秒を、これまでと同じ条件で確かめる)。
 */
async function waitForAudioBaseDelaySettled(page: Page): Promise<void> {
  let previousMs: number | null = null;
  let previousAtMs = 0;
  let settledSinceMs = 0;
  await expect
    .poll(
      async () => {
        const observation = await readSubscriberObservation(page);
        const baseDelayMs = observation.baseDelayMs;
        const nowMs = performance.now();
        if (baseDelayMs === null) {
          // まだ観測できていない (購読が切れた場合も含む)。待ち直す
          previousMs = null;
          return false;
        }
        if (previousMs === null) {
          previousMs = baseDelayMs;
          previousAtMs = nowMs;
          settledSinceMs = nowMs;
          return false;
        }
        // 前回から動いた量を、見た間隔に比例させた閾値で見る (poll の間隔は厳密ではない)
        const thresholdMs =
          (CATCH_UP_MOVEMENT_MS * Math.max(nowMs - previousAtMs, CATCH_UP_CHECK_INTERVAL_MS)) /
          CATCH_UP_CHECK_INTERVAL_MS;
        const movedMs = Math.abs(baseDelayMs - previousMs);
        previousMs = baseDelayMs;
        previousAtMs = nowMs;
        if (movedMs > thresholdMs) {
          settledSinceMs = nowMs;
          return false;
        }
        return nowMs - settledSinceMs >= CATCH_UP_SETTLED_MS;
      },
      {
        message: "受信側の音声の基準の遅れが追いつきを終えて定常になるのを待つ",
        timeout: CATCH_UP_SETTLE_TIMEOUT_MS,
        intervals: [CATCH_UP_CHECK_INTERVAL_MS],
      },
    )
    .toBe(true);
}

/** 観測値を 1 行にする (落ちたときに CI のログから追いつきの形を読めるようにする) */
function formatBaseDelays(baseDelays: readonly number[]): string {
  return baseDelays.map((value) => value.toFixed(2)).join(", ");
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
        const publisherAudio = await readPublisherAudioObservation(page);
        return publisherAudio.objectsSent;
      },
      {
        message: "Publisher が音声の Object を送信し始めるのを待つ",
        timeout: 30_000,
      },
    )
    .toBeGreaterThan(0);

  // 配信側の補正が落ち着いてから購読する (補正が動いている間に購読すると、受信側が
  // 音声を共有の時間軸へ記録できず、基準の遅れが観測されない)
  await waitForTimestampOffsetStable(page);

  // 同じページで購読する
  await page.getByTestId("subscriber-subscribe-button").click();
  // 待つ間も観測する間も、必要な値だけを読む。統計全体を繰り返し readStats で読むと、
  // その組み立てと受け渡しがブラウザのメインスレッドを占め、音声の処理が実時間に
  // 追いつかなくなる (`readSubscriberObservation` の説明を参照)
  await expect
    .poll(
      async () => {
        const observation = await readSubscriberObservation(page);
        return observation.chunksDecoded;
      },
      {
        message: "Subscriber が音声を復号し始めるのを待つ",
        timeout: 30_000,
      },
    )
    .toBeGreaterThan(0);

  // 基準が観測され、購読の直後の追いつきが終わるまで待つ (購読の直後はまだ復号の出力が
  // 再生の時間軸へ入っていないうえ、たまった分をまとめて復号している途中である)
  await expect
    .poll(
      async () => {
        const observation = await readSubscriberObservation(page);
        return observation.baseDelayMs;
      },
      {
        message: "受信側が音声の基準の遅れを観測し始めるのを待つ",
        timeout: 30_000,
      },
    )
    .not.toBeNull();
  await waitForAudioBaseDelaySettled(page);

  // 数十秒の間、受信側の音声の基準の遅れを観測する
  const baseDelays: number[] = [];
  let previousDecoded = 0;
  for (let second = 0; second < OBSERVE_SECONDS; second++) {
    const observation = await readSubscriberObservation(page);
    // リレー側から切れると値が古いまま固定され、段差が無いように見えてしまう。購読が
    // 生きていて、音声を復号し続けていることを確かめてから値を読む
    expect(observation.chunksDecoded, `${second} 秒目も音声を復号している`).toBeGreaterThan(
      previousDecoded,
    );
    previousDecoded = observation.chunksDecoded;

    const baseDelayMs = observation.baseDelayMs;
    // 未観測 (-) にならないこと。なると受信側は到着基準へ落ち、映像との基準を共有できない
    expect(baseDelayMs, `${second} 秒目に音声の基準の遅れが観測されている`).not.toBeNull();
    expect(observation.unsharedReason, `${second} 秒目の基準を共有できない理由`).not.toBe(
      "unobserved",
    );
    baseDelays.push(baseDelayMs ?? Number.NaN);
    await page.waitForTimeout(1_000);
  }

  // 受け入れ条件: 基準の遅れが 10〜30 ms に収まる。観測値は、落ちたときに追いつきの形
  // (最初だけ大きいのか、ずっと大きいのか) を CI のログから読めるように付ける
  expect(
    Math.min(...baseDelays),
    `音声の基準の遅れの最小値 (観測値: ${formatBaseDelays(baseDelays)})`,
  ).toBeGreaterThanOrEqual(AUDIO_BASE_DELAY_MIN_MS);
  expect(
    Math.max(...baseDelays),
    `音声の基準の遅れの最大値 (観測値: ${formatBaseDelays(baseDelays)})`,
  ).toBeLessThanOrEqual(AUDIO_BASE_DELAY_MAX_MS);
  // 数十秒流しても段差で動かない (最小値と最大値の差)
  expect(
    Math.max(...baseDelays) - Math.min(...baseDelays),
    `音声の基準の遅れの動きの幅 (観測値: ${formatBaseDelays(baseDelays)})`,
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
  await stopIfRunning(page, "publisher-stop-button");
  await stopIfRunning(page, "subscriber-stop-button");
});
