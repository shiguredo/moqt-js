import { expect, test, type Page } from "@playwright/test";
import { RELAY_TEST_TIMEOUT_MS, requireRelayUri } from "./support";
import { AUDIO_PUBLISH_CATCH_UP_GROWTH_MS } from "../../../src/audioPublishCatchUp";

/**
 * 実リレー経由で配信し、負荷で音声が遅れた状態を作って、遅れが解消されることを確かめる。
 *
 * 音声は、符号化が実時間に追いつかなくなるとキューに溜まった分だけ遅れが固定される
 * (映像は encodeQueueSize が上限を超えたフレームを捨てるが、音声には同じ仕組みが無かった)。
 * メインスレッドを止めると、止まっている間に届いたフレームが MediaStreamTrackProcessor の
 * キューに溜まり、止まった後にまとめて符号化へ入る。実測では、1 秒止めると符号化の遅れが
 * 10 ms から 910 ms へ伸び、負荷をやめて 10 秒たっても戻らなかった。
 *
 * 実装 (src/audioPublishCatchUp.ts) は、配信側が足した遅れ (読み出しの遅れ + 符号化の
 * キューに溜まっている音声) が健全時の値から一定を超えたら、読んだフレームを符号化せずに
 * 捨てて live へ追いつく。このテストは次の不変条件を判定する。
 *
 * 1. 負荷の後に、配信側の遅れが健全時の値の近くへ戻る (戻らなければ捨てていない)
 * 2. 追いつくために捨てたフレームがあること (捨てずに戻ることは無い)
 * 3. 戻った後に、遅れが再び伸びないこと
 *
 * 判定に使う値は配信側の統計 (window.moqtDevTools の getPublisher().audio.catchUp) だけ
 * であり、音声の経路そのものを測る。受信側の基準の遅れは、窓の最小値で動くためすぐには
 * 現れず、判定に使うと runner の処理能力を測ることになる。観測値としてログへ残す。
 *
 * 偽のマイク (Chromium の fake device) を使う。CI の runner は入力デバイスを持たないため、
 * 偽デバイスが無いと音声の Object が 1 つも送られない (tests/e2e/relay/audio-timestamp.spec.ts
 * と同じ条件に揃える)。
 */
test.use({
  launchOptions: {
    channel: "chromium",
    args: ["--use-fake-device-for-media-stream"],
  },
  permissions: ["microphone", "clipboard-read", "clipboard-write"],
});

/** devtools のページ (playwright.config.ts の webServer、port 5173) */
const DEVTOOLS_URL = "http://localhost:5173/index.html";

/** 負荷をかける前に、遅れが落ち着くのを待つ時間 (ミリ秒) */
const BASELINE_SETTLE_MS = 5_000;

/**
 * 負荷をかける時間 (ミリ秒)
 *
 * 遅い runner では、配信側の処理 (フレームの読み出しと符号化の出力の処理) が定期的に
 * 止められる。実測では、メインスレッドを 1 秒止めると、以降の符号化の遅れが 910 ms へ
 * 伸び、負荷をやめて 10 秒たっても戻らなかった
 */
const LOAD_MS = 10_000;

/**
 * 負荷の間にメインスレッドを占有する割合と、1 回に占有する長さ (ミリ秒)
 *
 * 1 回の処理が 60 ms 続くと、その間に届いた音声のフレームがまとめて読まれる
 */
const LOAD_SPIN_MS = 60;

/** 負荷の間に明け渡す時間 (ミリ秒) */
const LOAD_YIELD_MS = 40;

/**
 * 負荷の後で遅れが戻るのを待つ上限 (ミリ秒)
 *
 * 溜まったキューは実時間と同じ速さでしかはけない (実測: 1 秒止めると 910 ms の遅れが
 * 残り、負荷をやめても戻らなかった)。捨て始めてからはキューが減るため、遅れの長さと
 * 同じ程度の時間で戻る。遅い runner を見込んで余裕を取る
 */
const RECOVERY_TIMEOUT_MS = 30_000;

/** 負荷をかけた直後に、遅れが増えたことを待つ上限 (ミリ秒) */
const DELAY_TIMEOUT_MS = 10_000;

/** 観測の間隔 (ミリ秒) */
const SAMPLE_INTERVAL_MS = 500;

/** 配信側の音声の追いつきの観測値 */
interface CatchUpObservation {
  /** 送った音声 Object の数 */
  objectsSent: number;
  /** 捨てたフレームの数 (累積) */
  droppedFrames: number;
  /** 捨てた音声の長さ (ミリ秒、累積) */
  droppedMs: number;
  /** いま観測している、配信側が足した遅れ (ミリ秒)。未観測は null */
  lagMs: number | null;
  /** 健全時に観測した遅れ (床、ミリ秒)。未観測は null */
  floorMs: number | null;
  /** 観測した最大の遅れ (ミリ秒)。未観測は null */
  maxLagMs: number | null;
  /** 符号化へ渡したまま出力が返っていない音声の長さ (ミリ秒) */
  pendingMs: number;
  /** 符号化へ渡したまま出力が返っていないフレームの数 */
  pendingFrames: number;
  /** 送信キューへ入れたまま送信が終わっていない音声の長さ (ミリ秒) */
  sendQueueMs: number;
  /** 送信キューへ入れたまま送信が終わっていないフレームの数 */
  sendQueueFrames: number;
  /** 撮ってから送信が終わるまでの遅れ (ミリ秒)。まだ送信が終わっていなければ null */
  sendLagMs: number | null;
  /** 直近に読んだフレームの読み出しの遅れ (ミリ秒) */
  readLagMs: number;
  /** 追いつきを始めた回数 (累積) */
  catchUpStarts: number;
  /** 追いつきのために捨てているか */
  catchingUp: boolean;
  /** 受信側の音声の基準の遅れ (ミリ秒)。購読していなければ null */
  audioBaseDelayMs: number | null;
  /** 読んだ時刻 (ミリ秒) */
  atMs: number;
}

/** 配信側と購読側の統計から、判定に使う値だけを 1 回の往復で読む */
async function readObservation(page: Page): Promise<CatchUpObservation> {
  return page.evaluate(() => {
    const api = (
      window as unknown as {
        moqtDevTools: {
          getPublisher: () => {
            audio: {
              objectsSent: number;
              catchUp: {
                droppedFrames: number;
                droppedMs: number;
                lagMs: number | null;
                floorMs: number | null;
                maxLagMs: number | null;
                pendingMs: number;
                pendingFrames: number;
                sendQueueMs: number;
                sendQueueFrames: number;
                sendLagMs: number | null;
                readLagMs: number;
                catchUpStarts: number;
                catchingUp: boolean;
              };
            };
          };
          getSubscribers: () => {
            avSync: { delays: { audio: { baseDelayMs: number | null } } };
          }[];
        };
      }
    ).moqtDevTools;
    const audio = api.getPublisher().audio;
    const subscriber = api.getSubscribers()[0] ?? null;
    return {
      objectsSent: audio.objectsSent,
      droppedFrames: audio.catchUp.droppedFrames,
      droppedMs: audio.catchUp.droppedMs,
      lagMs: audio.catchUp.lagMs,
      floorMs: audio.catchUp.floorMs,
      maxLagMs: audio.catchUp.maxLagMs,
      pendingMs: audio.catchUp.pendingMs,
      pendingFrames: audio.catchUp.pendingFrames,
      sendQueueMs: audio.catchUp.sendQueueMs,
      sendQueueFrames: audio.catchUp.sendQueueFrames,
      sendLagMs: audio.catchUp.sendLagMs,
      readLagMs: audio.catchUp.readLagMs,
      catchUpStarts: audio.catchUp.catchUpStarts,
      catchingUp: audio.catchUp.catchingUp,
      audioBaseDelayMs: subscriber?.avSync.delays.audio.baseDelayMs ?? null,
      atMs: performance.now(),
    };
  });
}

/** 観測値の推移を 1 行にする (落ちたときに CI のログから形を読めるようにする) */
function formatSeries(values: readonly (number | null)[], digits = 1): string {
  return values.map((value) => (value === null ? "-" : value.toFixed(digits))).join(", ");
}

/** 観測値の推移をまとめる */
function formatReport(observations: readonly CatchUpObservation[]): string {
  return [
    `  送った音声 Object の数: ${formatSeries(
      observations.map((row) => row.objectsSent),
      0,
    )}`,
    `  配信側の遅れ lagMs (ミリ秒): ${formatSeries(observations.map((row) => row.lagMs))}`,
    `  健全時の遅れ floorMs (ミリ秒): ${formatSeries(observations.map((row) => row.floorMs))}`,
    `  観測した最大の遅れ maxLagMs (ミリ秒): ${formatSeries(observations.map((row) => row.maxLagMs))}`,
    `  符号化のキューに溜まっている音声 pendingMs (ミリ秒): ${formatSeries(observations.map((row) => row.pendingMs))}`,
    `  符号化のキューのフレーム数 pendingFrames: ${formatSeries(
      observations.map((row) => row.pendingFrames),
      0,
    )}`,
    `  送信のキューに溜まっている音声 sendQueueMs (ミリ秒): ${formatSeries(observations.map((row) => row.sendQueueMs))}`,
    `  送信のキューのフレーム数 sendQueueFrames: ${formatSeries(
      observations.map((row) => row.sendQueueFrames),
      0,
    )}`,
    `  撮ってから送信が終わるまでの遅れ sendLagMs (ミリ秒): ${formatSeries(observations.map((row) => row.sendLagMs))}`,
    `  読み出しの遅れ readLagMs (ミリ秒): ${formatSeries(observations.map((row) => row.readLagMs))}`,
    `  追いつきを始めた回数 catchUpStarts: ${formatSeries(
      observations.map((row) => row.catchUpStarts),
      0,
    )}`,
    `  追いつきの最中か catchingUp: ${observations.map((row) => row.catchingUp).join(", ")}`,
    `  捨てたフレームの数 (累積): ${formatSeries(
      observations.map((row) => row.droppedFrames),
      0,
    )}`,
    `  捨てた音声の長さ (ミリ秒、累積): ${formatSeries(observations.map((row) => row.droppedMs))}`,
    `  受信側の音声の基準の遅れ (ミリ秒、判定には使わない): ${formatSeries(observations.map((row) => row.audioBaseDelayMs))}`,
  ].join("\n");
}

test("実リレー経由で負荷により遅れた音声が live へ追いつく", async ({ page }) => {
  // 配信と購読の確立、定常までの待ち、負荷、追いつきの待ち、後始末を見込む
  test.setTimeout(RELAY_TEST_TIMEOUT_MS + RECOVERY_TIMEOUT_MS + 60_000);
  const moqtUri = requireRelayUri();
  if (moqtUri === null) {
    return;
  }

  // 偽のマイクを使う。映像は Canvas のダミー (判定は音声)
  await page.goto(`${DEVTOOLS_URL}?audioSource=microphone&videoSource=dummy`);
  await page.waitForFunction(() =>
    Boolean((window as unknown as { moqtDevTools?: unknown }).moqtDevTools),
  );

  // 受信側の音声を再生する。配信だけでなく購読もするのは、実リレーへ送る経路ごと
  // 確かめるためである (配信側の遅れは購読が無くても測れる)
  await page.getByTestId("subscriber-audio-playback-toggle").click();
  await page.getByTestId("moqt-uri").fill(moqtUri);
  await page.getByTestId("publisher-publish-button").click();
  await expect
    .poll(
      async () => {
        const observation = await readObservation(page);
        return observation.objectsSent;
      },
      {
        message: "Publisher が音声の Object を送信し始めるのを待つ",
        timeout: 30_000,
        intervals: [SAMPLE_INTERVAL_MS],
      },
    )
    .toBeGreaterThan(0);

  await page.getByTestId("subscriber-subscribe-button").click();

  const observations: CatchUpObservation[] = [];
  const sample = async (): Promise<CatchUpObservation> => {
    const observation = await readObservation(page);
    observations.push(observation);
    return observation;
  };

  // 遅れが落ち着くまで待つ。実装が保証すること (負荷の後に戻ること) は待ち条件にしない
  for (let index = 0; index < Math.ceil(BASELINE_SETTLE_MS / SAMPLE_INTERVAL_MS); index++) {
    await sample();
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  }
  const baseline = await sample();
  expect(
    baseline.floorMs,
    `負荷の前に、健全時の遅れ (floorMs) を観測している\n${formatReport(observations)}`,
  ).not.toBeNull();

  // メインスレッドを占有する負荷をかける。占有されている間に届いたフレームは
  // MediaStreamTrackProcessor のキューに溜まり、明け渡したときにまとめて読まれる。
  // 負荷の間も観測を続ける (負荷を待ってから観測すると、遅れが現れた時点を見逃す)
  const load = page.evaluate(
    async (options: { loadMs: number; spinMs: number; yieldMs: number }) => {
      const end = performance.now() + options.loadMs;
      while (performance.now() < end) {
        const spinEnd = performance.now() + options.spinMs;
        while (performance.now() < spinEnd) {
          // 実時間を消費する
        }
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            resolve();
          }, options.yieldMs);
        });
      }
    },
    { loadMs: LOAD_MS, spinMs: LOAD_SPIN_MS, yieldMs: LOAD_YIELD_MS },
  );
  const loadDeadlineMs = performance.now() + LOAD_MS;
  while (performance.now() < loadDeadlineMs) {
    await sample();
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  }
  await load;

  // 遅れた状態ができたことを待つ。溜まったフレームは撮った時刻より遅れて読まれるため、
  // 観測した最大の遅れ (maxLagMs) が健全時の値を超える
  const floorMs = baseline.floorMs ?? 0;
  const delayDeadlineMs = performance.now() + DELAY_TIMEOUT_MS;
  let delayed: CatchUpObservation | null = null;
  while (performance.now() < delayDeadlineMs) {
    const observation = await sample();
    if ((observation.maxLagMs ?? 0) > floorMs + AUDIO_PUBLISH_CATCH_UP_GROWTH_MS) {
      delayed = observation;
      break;
    }
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  }
  expect(
    delayed,
    `負荷 (${LOAD_MS} ms の間にメインスレッドを ${LOAD_SPIN_MS} ms 占有) で、音声の遅れが健全時の値 + ${AUDIO_PUBLISH_CATCH_UP_GROWTH_MS} ms を超えるのを待つ (${DELAY_TIMEOUT_MS} ms)
${formatReport(observations)}`,
  ).not.toBeNull();

  // 遅れが健全時の値の近くへ戻るのを待つ。捨てずにいれば、キューに溜まった分は実時間と
  // 同じ速さでしかはけず、遅れは戻らない (実測: 910 ms のまま 10 秒以上戻らなかった)
  const recoveryDeadlineMs = performance.now() + RECOVERY_TIMEOUT_MS;
  let recovered: CatchUpObservation | null = null;
  while (performance.now() < recoveryDeadlineMs) {
    const observation = await sample();
    if (
      (observation.lagMs ?? Number.POSITIVE_INFINITY) <=
      floorMs + AUDIO_PUBLISH_CATCH_UP_GROWTH_MS
    ) {
      recovered = observation;
      break;
    }
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  }
  expect(
    recovered,
    `負荷の後に音声の遅れが健全時の値 + ${AUDIO_PUBLISH_CATCH_UP_GROWTH_MS} ms へ戻るのを待つ (${RECOVERY_TIMEOUT_MS} ms)
${formatReport(observations)}`,
  ).not.toBeNull();

  // 追いつくために捨てたフレームがあること。まだ観測していないだけで、捨てずに遅れが
  // 戻ることは無い (戻ったなら捨てていない)
  expect(
    recovered?.droppedFrames ?? 0,
    `追いつくために捨てたフレームの数 (捨てずに遅れが戻ることは無い)
${formatReport(observations)}`,
  ).toBeGreaterThan(0);

  // 追いついた後も音声を送り続けていること。捨てるのをやめないまま (遅れを戻せないまま)
  // 音声が送られなくなる状態を捕まえる
  const rest: CatchUpObservation[] = [];
  for (let index = 0; index < 10; index++) {
    rest.push(await sample());
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  }
  const stalled = rest.find((observation) => observation.objectsSent === 0);
  expect(
    stalled,
    `追いついた後に音声の Object を送り続けている
${formatReport(observations)}`,
  ).toBeUndefined();
  const sentGrowth = (rest[rest.length - 1]?.objectsSent ?? 0) - (recovered?.objectsSent ?? 0);
  expect(
    sentGrowth,
    `追いついた後に送った音声の Object が増える (増加 ${sentGrowth} 件)\n${formatReport(observations)}`,
  ).toBeGreaterThan(0);

  // 追いついた後に、遅れが再び伸び続けないこと。1 回の観測が上限を超えること自体は
  // 異常にしない。runner がメインスレッドを数十〜数百 ms 止めると、その間に届いた
  // フレームの分だけ読み出しの遅れが跳ねるためである (実測: CI の 4 vCPU の runner、
  // run 38048874698 では、回復後の観測 10 回の遅れが 0.0, 0.1, 89.6, 116.4, 0.0, 218.0,
  // 61.3, 57.7, 10.2, 10.2 ms であり、上限 (健全時の値 + 40 ms) を超えたのは 5 回だった。
  // 実装は超えた分をその場で捨てて戻しており、超えた状態が続いたのは最長で 3 回
  // = 1.5 秒である)。伸び続けていれば、上限を超えた状態が 2 秒 (4 回) より長く続く
  const overflowLimitMs = floorMs + AUDIO_PUBLISH_CATCH_UP_GROWTH_MS;
  let overflowRun = 0;
  let maxOverflowRun = 0;
  for (const observation of rest) {
    const lagMs = observation.lagMs ?? Number.POSITIVE_INFINITY;
    overflowRun = lagMs > overflowLimitMs ? overflowRun + 1 : 0;
    maxOverflowRun = Math.max(maxOverflowRun, overflowRun);
  }
  expect(
    maxOverflowRun,
    `追いついた後に、遅れが上限 (健全時の値 + ${AUDIO_PUBLISH_CATCH_UP_GROWTH_MS} ms = ${overflowLimitMs.toFixed(1)} ms) を超えた状態が続かない (最長 ${maxOverflowRun} 回 = ${maxOverflowRun * SAMPLE_INTERVAL_MS} ms、許す上限 4 回 = 2000 ms)
${formatReport(observations)}`,
  ).toBeLessThanOrEqual(4);

  console.log(`実リレーの音声の追いつきの観測: 遅れが解消した\n${formatReport(observations)}`);

  // 後始末 (リレー側から先に切れていることがあるため、押せるときだけ止める)
  const publisherStop = page.getByTestId("publisher-stop-button");
  if (await publisherStop.isEnabled()) {
    await publisherStop.click({ timeout: 5_000 }).catch(() => {});
  }
  const subscriberStop = page.getByTestId("subscriber-stop-button");
  if (await subscriberStop.isEnabled()) {
    await subscriberStop.click({ timeout: 5_000 }).catch(() => {});
  }
});
