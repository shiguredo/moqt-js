import { expect, test, type Page } from "@playwright/test";
import type { PublisherStats, SubscriberStats } from "../../../devtools/src/testApi";
import { RELAY_TEST_TIMEOUT_MS, requireRelayUri } from "./support";

/**
 * 実リレー経由で、同じブラウザ (同じ devtools のページ) から音声と映像を配信し、
 * 同じページで購読して、送る側の TIMESTAMP と受信側の音声の基準が実時間からずれない
 * ことを確かめる。
 *
 * 判定は「音声の基準の遅れが何 ms に収まるか」ではなく、実装が保証する不変条件にする。
 * 基準の遅れは、経路の遅れと、送信側が実時間に追いつけているか (runner の処理能力) に
 * 依存するため、絶対値を判定にすると runner の速さを測ることになる。遅い runner でも、
 * 送る TIMESTAMP が壁時計からずれず、受信側の基準が段差やドリフトで伸びなければ、
 * その実装は正しい。そこで次の不変条件だけを判定し、観測値そのものは判定に使わず、
 * 失敗したときに「環境が遅いのか実装が壊れているのか」を切り分けられるようメッセージへ残す。
 *
 * 1. 受信側の音声の基準の遅れが、観測の間に増え続けない (段差とドリフトを捕まえる)
 * 2. 音声と映像の基準の共有が解除されない (`sharingBases` が真、`unsharedReason` が none)
 * 3. 音声が復号され続け、鳴らなかった音 (`missedFrames`) が増えず、基準の取り直しも
 *    過度に増えない
 * 4. 配信側の「読み出した壁時計 - `AudioData.timestamp`」の傾きが 0 近傍で、観測した
 *    最小と最大の幅が広がらない (送る TIMESTAMP が壁時計からずれていかないことの直接の検証)
 * 5. 音声と映像の基準の差が妥当な範囲に収まり、増え続けない
 *
 * 偽のマイク (Chromium の fake device) を使い、受信側の音声の再生を有効にする
 * (再生しないと復号の出力が再生の時間軸へ記録されず、基準が出ない)。
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
 * 基準が定常に達してから 25 秒あれば、1 秒ごとの観測の前半と後半を比べられ、段差や
 * ドリフトが出れば観測に現れる
 */
const OBSERVE_SECONDS = 25;

/** 観測の間隔 (ミリ秒) */
const SAMPLE_INTERVAL_MS = 1_000;

/**
 * 受信側が基準の遅れを観測し、共有を始め、relay の cache からの追いつきを終えるまで
 * 待つ上限 (ミリ秒)
 *
 * 待つのは「受信側が実際に観測できるようになったか」である。配信側の補正が落ち着いた
 * ことを条件にすると、補正の落ち着き方 (符号化が実時間に追いつけるか) がそのまま条件に
 * なり、遅い runner で原理的に成立しなくなる
 */
const READY_TIMEOUT_MS = 90_000;

/**
 * 待てなかったときに表示する、直近の観測の数
 *
 * 待つ間の観測は 1 秒ごとに増えるため、失敗したときのメッセージが長くなりすぎないように
 * 直近だけを出す
 */
const READINESS_REPORT_SAMPLES = 30;

/**
 * 観測を始める前に、音声の基準の遅れが動かないでいることを確かめる時間 (ミリ秒)
 *
 * 追いつきの途中や、処理能力が足りずに段差が出た直後から観測を始めると、その段差を
 * 「観測の間の動き」として数えてしまう。受信側の値そのものを見て、動かなくなってから
 * 始める (配信側の補正の落ち着きを見ると、遅い runner では成立しない)
 */
const READY_SETTLED_MS = 3_000;

/**
 * 定常とみなす、1 秒ごとの音声の基準の遅れの動き (ミリ秒)
 *
 * 定常状態の観測は 1 ms 以内で動く (実測)。段差 (実測で 66 ms) はこれを超える
 */
const READY_SETTLE_TOLERANCE_MS = 20;

/**
 * 観測の間に許す、音声の基準の遅れの増加 (ミリ秒)
 *
 * 実装が保証するのは「増えない」ことである。基準の遅れの値そのものは経路と runner の
 * 処理能力で決まるため判定しない。実測では、遅い runner でも定常値のまわりを数十 ms
 * の幅で動くだけで、ドリフトや段差 (実測で 485〜627 ms) はこの値を超えて増える
 */
const BASE_DELAY_GROWTH_MAX_MS = 50;

/** 観測の間に許す、音声と映像の基準の差の増加 (ミリ秒。基準の遅れと同じ考え方) */
const BASE_DIFFERENCE_GROWTH_MAX_MS = 50;

/**
 * 音声と映像の基準の差として許す絶対値 (ミリ秒)
 *
 * 差が実装の上限を超えると共有が解除される (`unsharedReason` が difference になる) ため、
 * 共有が続いていること自体が差の妥当性を担保する。ここでは桁が変わるずれ (時計の取り違え)
 * だけを捕まえる
 */
const BASE_DIFFERENCE_MAX_MS = 1_000;

/**
 * 配信側の原点の傾きとして許す上限 (ミリ秒 / 秒)
 *
 * 実装が保証するのは「一定のずれに収まる」ことである。観測した速さの実測は 0.0 ms/秒で
 * あり、壁時計からずれていく場合は 20 ms/秒 を超える (10 秒で 217 ms、200 秒で 4802 ms)。
 * 読み出しの遅れが段差で動く環境 (実測で 160 ms) でも、この値には届かない
 */
const TIMESTAMP_SLOPE_MAX_MS_PER_SECOND = 5;

/**
 * 観測の間に許す、配信側の原点の最小と最大の幅の増加 (ミリ秒)
 *
 * 幅そのものではなく増加を見る。最小と最大は配信を始めてからの累積であり、最初の数秒に
 * 落ち着くまでの分 (実測で 10 ms 程度) を含むためである
 */
const TIMESTAMP_WIDTH_GROWTH_MAX_MS = 75;

/**
 * 配信側の原点の最小と最大の幅として許す絶対値 (ミリ秒)
 *
 * 桁が変わる取り違え (単位や時計の取り違え) を捕まえる。最小と最大は配信を始めてからの
 * 累積であり、読み出しが一瞬遅れた分 (実測: 1 vCPU のコンテナで 190 ms) を含む。段差の
 * 実測 (485〜627 ms) はこれを超える
 */
const TIMESTAMP_WIDTH_MAX_MS = 500;

/**
 * 観測の間に許す、鳴らす基準を取り直した回数の増加
 *
 * 定常状態では取り直しは起きない。段差やドリフトで受信側の基準が合わなくなると、
 * 取り直しが続く
 */
const PLAYOUT_REBASE_GROWTH_MAX = 2;

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

/** 観測に使う、購読側の音声と映像の値 */
interface SubscriberObservation {
  /** 音声の基準の遅れ (ミリ秒)。まだ観測していなければ null */
  baseDelayMs: number | null;
  /** 映像の基準の遅れ (ミリ秒)。まだ観測していなければ null */
  videoBaseDelayMs: number | null;
  /** 基準の差「音声 - 映像」(ミリ秒)。そろっていなければ null */
  baseDifferenceMs: number | null;
  /** 直近の基準の差の動き (ミリ秒 / 秒)。まだ履歴が無ければ null */
  baseDriftMsPerSecond: number | null;
  /** 基準を共有できているか */
  sharingBases: boolean;
  /** 基準を共有できていない理由 */
  unsharedReason: string;
  /** 復号した音声 Chunk の数 */
  chunksDecoded: number;
  /** 鳴らす基準を取り直した回数 */
  playoutRebases: number;
  /** 遅れが上限を超えて捨てた音の数 */
  playoutDrops: number;
  /** 鳴らさなかった音の数 */
  missedFrames: number;
  /** relay の cache から追いつく途中かどうか */
  catchUpPending: boolean;
}

/** 観測に使う、配信側の音声の TIMESTAMP の値 */
interface PublisherAudioObservation {
  /** 送った音声 Object の数 */
  objectsSent: number;
  /** TIMESTAMP に足している補正 (ミリ秒)。まだ決まっていなければ null */
  appliedMs: number | null;
  /** 直近に観測した「読み出した壁時計 - `AudioData.timestamp`」(ミリ秒) */
  currentMs: number | null;
  /** 観測した最小値 (ミリ秒) */
  minMs: number | null;
  /** 観測した最大値 (ミリ秒) */
  maxMs: number | null;
  /** 直近 10 秒の傾き (ミリ秒 / 秒) */
  slope10sMsPerSecond: number | null;
  /** 直近 60 秒の傾き (ミリ秒 / 秒) */
  slope60sMsPerSecond: number | null;
  /** 観測した数 */
  samples: number;
}

/**
 * 1 回の観測で読む値
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
 * そこで待つ間と観測する間は 1 秒に 1 回だけ、判定に使う値だけを読む。
 */
interface RelayObservation {
  /** 読んだ時刻 (`performance.now()`、ミリ秒) */
  atMs: number;
  publisher: PublisherAudioObservation;
  /** 購読していなければ null */
  subscriber: SubscriberObservation | null;
}

/** 購読側がまだ読めないときに代わりに置く値 (観測のたびに null を書かなくて済むようにする) */
const EMPTY_SUBSCRIBER_OBSERVATION: SubscriberObservation = {
  baseDelayMs: null,
  videoBaseDelayMs: null,
  baseDifferenceMs: null,
  baseDriftMsPerSecond: null,
  sharingBases: false,
  unsharedReason: "unsubscribed",
  chunksDecoded: 0,
  playoutRebases: 0,
  playoutDrops: 0,
  missedFrames: 0,
  catchUpPending: true,
};

/** 判定に使う値だけを 1 回の往復で読む (`RelayObservation` の説明を参照) */
async function readObservation(page: Page): Promise<RelayObservation> {
  return page.evaluate(() => {
    const api = (
      window as unknown as {
        moqtDevTools: {
          getPublisher: () => PublisherStats;
          getSubscribers: () => SubscriberStats[];
        };
      }
    ).moqtDevTools;
    const audio = api.getPublisher().audio;
    const offset = audio.timestampOffset;
    const subscriber = api.getSubscribers()[0] ?? null;
    const delays = subscriber?.avSync.delays ?? null;
    return {
      atMs: performance.now(),
      publisher: {
        objectsSent: audio.objectsSent,
        appliedMs: offset?.appliedMs ?? null,
        currentMs: offset?.currentMs ?? null,
        minMs: offset?.minMs ?? null,
        maxMs: offset?.maxMs ?? null,
        slope10sMsPerSecond: offset?.slope10sMsPerSecond ?? null,
        slope60sMsPerSecond: offset?.slope60sMsPerSecond ?? null,
        samples: offset?.samples ?? 0,
      },
      subscriber:
        subscriber === null || delays === null
          ? null
          : {
              baseDelayMs: delays.audio.baseDelayMs,
              videoBaseDelayMs: delays.video.baseDelayMs,
              baseDifferenceMs: delays.baseDifferenceMs,
              baseDriftMsPerSecond: delays.baseDriftMsPerSecond,
              sharingBases: delays.sharingBases,
              unsharedReason: delays.unsharedReason,
              chunksDecoded: subscriber.audio.chunksDecoded,
              playoutRebases: subscriber.audio.playoutRebases,
              playoutDrops: subscriber.audio.playoutDrops,
              missedFrames: subscriber.audio.playoutTiming.missedFrames,
              catchUpPending: subscriber.catchUpPending,
            },
    };
  });
}

/** 購読側がまだ読めないときは代わりの値を返す (観測のたびに null を書かなくて済むようにする) */
function subscriberOf(observation: RelayObservation): SubscriberObservation {
  return observation.subscriber ?? EMPTY_SUBSCRIBER_OBSERVATION;
}

/** 観測を始められる状態になったかと、待つ間に見た観測 */
interface ReadinessWait {
  ready: boolean;
  /** 待つ間に見た観測 (待てなかったときの切り分けに使う) */
  observations: RelayObservation[];
}

/**
 * 観測を始められる状態になるまで待つ
 *
 * 待つのは「受信側が基準を観測し、映像と共有し、relay の cache からの追いつきを終え、
 * 基準の遅れが動かなくなったか」である。配信側の補正が落ち着いたことを条件にすると、
 * 補正の落ち着き方 (符号化が実時間に追いつけるか) がそのまま条件になり、遅い runner で
 * 原理的に成立しなくなる。
 *
 * `expect.poll` ではなく自前のループにするのは、待てなかったときに観測値の推移を
 * メッセージへ出して「環境が遅いのか実装が壊れているのか」を切り分けられるようにするためである
 *
 * @returns 待てたかどうかと、待つ間に見た観測
 */
async function waitForSharedAudioBase(page: Page): Promise<ReadinessWait> {
  const observations: RelayObservation[] = [];
  let previousBaseDelayMs: number | null = null;
  let settledSinceMs = 0;
  const deadlineMs = performance.now() + READY_TIMEOUT_MS;
  while (performance.now() < deadlineMs) {
    const observation = await readObservation(page);
    observations.push(observation);
    const subscriber = observation.subscriber;
    const baseDelayMs = subscriber === null ? null : subscriber.baseDelayMs;
    const ready =
      subscriber !== null &&
      baseDelayMs !== null &&
      subscriber.videoBaseDelayMs !== null &&
      subscriber.sharingBases &&
      subscriber.unsharedReason === "none" &&
      !subscriber.catchUpPending;
    if (!ready) {
      previousBaseDelayMs = null;
      await page.waitForTimeout(SAMPLE_INTERVAL_MS);
      continue;
    }
    const nowMs = performance.now();
    if (
      previousBaseDelayMs === null ||
      Math.abs(baseDelayMs - previousBaseDelayMs) > READY_SETTLE_TOLERANCE_MS
    ) {
      previousBaseDelayMs = baseDelayMs;
      settledSinceMs = nowMs;
      await page.waitForTimeout(SAMPLE_INTERVAL_MS);
      continue;
    }
    previousBaseDelayMs = baseDelayMs;
    if (nowMs - settledSinceMs >= READY_SETTLED_MS) {
      return { ready: true, observations };
    }
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  }
  return { ready: false, observations };
}

/** 昇順に並べた値の中央値。空なら NaN */
function median(values: readonly number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? Number.NaN;
  }
  return ((sorted[middle - 1] ?? Number.NaN) + (sorted[middle] ?? Number.NaN)) / 2;
}

/** 3 等分した区間ごとの中央値を求める (前半と後半の比較に使う) */
function thirdsMedians(values: readonly number[]): number[] {
  const length = Math.ceil(values.length / 3);
  return [
    median(values.slice(0, length)),
    median(values.slice(length, length * 2)),
    median(values.slice(length * 2)),
  ];
}

/** 観測値の推移を 1 行にする (落ちたときに CI のログから形を読めるようにする) */
function formatSeries(values: readonly (number | null)[], digits = 1): string {
  return values.map((value) => (value === null ? "-" : value.toFixed(digits))).join(", ");
}

/** 区間ごとの中央値を 1 行にする */
function formatThirds(label: string, values: readonly number[]): string {
  const medians = thirdsMedians(values);
  return `${label}: 前半 ${medians[0]?.toFixed(1)} ms / 中盤 ${medians[1]?.toFixed(1)} ms / 後半 ${medians[2]?.toFixed(1)} ms`;
}

/**
 * 観測値の推移と、この環境での定常値をまとめる
 *
 * 判定に使う値そのものは runner の処理能力で変わるため、失敗したときに「環境が遅いのか
 * 実装が壊れているのか」を切り分けられるよう、すべての観測値をメッセージへ残す
 */
function formatObservationReport(
  observations: readonly RelayObservation[],
  subscriberOf: (observation: RelayObservation) => SubscriberObservation,
): string {
  const baseDelays = observations
    .map((observation) => subscriberOf(observation).baseDelayMs)
    .filter((value): value is number => value !== null);
  const videoBaseDelays = observations
    .map((observation) => subscriberOf(observation).videoBaseDelayMs)
    .filter((value): value is number => value !== null);
  const baseDifferences = observations
    .map((observation) => subscriberOf(observation).baseDifferenceMs)
    .filter((value): value is number => value !== null);
  const lines = [
    "観測値 (1 秒ごと。この値そのものは runner の処理能力で変わるため判定には使わない)",
    `  音声の基準の遅れ (ミリ秒): ${formatSeries(observations.map((observation) => subscriberOf(observation).baseDelayMs))}`,
    `  映像の基準の遅れ (ミリ秒): ${formatSeries(observations.map((observation) => subscriberOf(observation).videoBaseDelayMs))}`,
    `  基準の差 音声 - 映像 (ミリ秒): ${formatSeries(observations.map((observation) => subscriberOf(observation).baseDifferenceMs))}`,
    // 基準の差の動きは、受信側の直近の窓の最小値から求まるため、runner が混んでいると
    // 実際の差が動いていなくても大きい値になる (実測: 差が動かないまま 12 ms/秒)。判定には
    // 使わず、解除があったときの切り分けのために残す
    `  基準の差の動き (ミリ秒 / 秒): ${formatSeries(observations.map((observation) => subscriberOf(observation).baseDriftMsPerSecond))}`,
    `  配信側の原点の現在値 (ミリ秒): ${formatSeries(observations.map((observation) => observation.publisher.currentMs))}`,
    `  配信側の原点の最小値 (ミリ秒): ${formatSeries(observations.map((observation) => observation.publisher.minMs))}`,
    `  配信側の原点の最大値 (ミリ秒): ${formatSeries(observations.map((observation) => observation.publisher.maxMs))}`,
    `  配信側の傾き 10 秒 / 60 秒 (ミリ秒 / 秒): ${formatSeries(observations.map((observation) => observation.publisher.slope10sMsPerSecond))} / ${formatSeries(observations.map((observation) => observation.publisher.slope60sMsPerSecond))}`,
    `  配信側が TIMESTAMP に足している補正 (ミリ秒): ${formatSeries(observations.map((observation) => observation.publisher.appliedMs))}`,
    `  復号した音声 Chunk の数: ${formatSeries(
      observations.map((observation) => subscriberOf(observation).chunksDecoded),
      0,
    )}`,
    `  基準の取り直し / 鳴らなかった音 / 捨てた音: ${formatSeries(
      observations.map((observation) => subscriberOf(observation).playoutRebases),
      0,
    )} / ${formatSeries(
      observations.map((observation) => subscriberOf(observation).missedFrames),
      0,
    )} / ${formatSeries(
      observations.map((observation) => subscriberOf(observation).playoutDrops),
      0,
    )}`,
    `  基準の共有 (unsharedReason): ${observations.map((observation) => subscriberOf(observation).sharingBases).join(", ")} (${observations.map((observation) => subscriberOf(observation).unsharedReason).join(", ")})`,
    formatThirds("  この環境での音声の基準の遅れの定常値", baseDelays),
  ];
  if (videoBaseDelays.length > 0) {
    lines.push(formatThirds("  この環境での映像の基準の遅れの定常値", videoBaseDelays));
  }
  if (baseDifferences.length > 0) {
    lines.push(formatThirds("  この環境での基準の差の定常値", baseDifferences));
  }
  return lines.join("\n");
}

test("実リレー経由で同じブラウザから音声を配信し、送る TIMESTAMP と受信側の基準がずれない", async ({
  page,
}) => {
  // 配信と購読の確立、受信側が定常になるまでの待ち (最大 READY_TIMEOUT_MS)、観測 (25 秒)、
  // 画面と Copy for LLM の確認、後始末を見込む
  test.setTimeout(RELAY_TEST_TIMEOUT_MS + READY_TIMEOUT_MS + 60_000);
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
        const observation = await readObservation(page);
        return observation.publisher.objectsSent;
      },
      {
        message: "Publisher が音声の Object を送信し始めるのを待つ",
        timeout: 30_000,
        intervals: [SAMPLE_INTERVAL_MS],
      },
    )
    .toBeGreaterThan(0);

  // 補正が決まるまで待つ。決まる前の TIMESTAMP は従来の換算であり、受信側が基準を
  // 記録できない。落ち着くまで待つのではなく、決まったことだけを条件にする
  // (落ち着き方は符号化が実時間に追いつけるかに依存し、遅い runner では原理的に
  // 成立しないため)
  await expect
    .poll(
      async () => {
        const observation = await readObservation(page);
        return observation.publisher.appliedMs;
      },
      {
        message: "配信側の TIMESTAMP の補正が決まるのを待つ",
        timeout: 30_000,
        intervals: [SAMPLE_INTERVAL_MS],
      },
    )
    .not.toBeNull();

  // 同じページで購読する
  await page.getByTestId("subscriber-subscribe-button").click();
  await expect
    .poll(
      async () => {
        const observation = await readObservation(page);
        return observation.subscriber?.chunksDecoded ?? 0;
      },
      {
        message: "Subscriber が音声を復号し始めるのを待つ",
        timeout: 30_000,
        intervals: [SAMPLE_INTERVAL_MS],
      },
    )
    .toBeGreaterThan(0);

  // 受信側が基準を観測して共有を始め、relay の cache からの追いつきを終え、基準の遅れが
  // 動かなくなるまで待つ。購読の直後は、relay の cache から届いた分と購読を始めるまでに
  // たまった分をまとめて復号しており、基準の遅れは過渡である
  const readiness = await waitForSharedAudioBase(page);
  expect(
    readiness.ready,
    `受信側が音声と映像の基準を共有して追いつきを終えるのを待つ (${READY_TIMEOUT_MS} ms)\n${formatObservationReport(readiness.observations.slice(-READINESS_REPORT_SAMPLES), subscriberOf)}`,
  ).toBe(true);

  // 受信側の音声の基準の遅れと、配信側の TIMESTAMP の原点を観測する
  const observations: RelayObservation[] = [];
  for (let second = 0; second < OBSERVE_SECONDS; second++) {
    const observation = await readObservation(page);
    observations.push(observation);
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  }

  const report = formatObservationReport(observations, subscriberOf);

  // 購読が生きていること。リレー側から切れると値が古いまま固定され、変化が無いように
  // 見えてしまう
  const missingSubscriber = observations.findIndex(
    (observation) => observation.subscriber === null,
  );
  expect(missingSubscriber, `観測の間に購読側の統計が読める\n${report}`).toBe(-1);

  // 観測の間に音声を復号し続けていること (増え続けていること)。止まれば、以降の値は
  // 古い値のままであり、ずれの判定が意味を持たない
  const decodedCounts = observations.map((observation) => subscriberOf(observation).chunksDecoded);
  const stoppedDecoding = decodedCounts.findIndex(
    (count, index) => index > 0 && count <= (decodedCounts[index - 1] ?? 0),
  );
  expect(stoppedDecoding, `観測の間に復号した音声 Chunk の数が増え続ける\n${report}`).toBe(-1);

  // 受信側の音声の基準の遅れが増え続けないこと。前半の中央値に対して後半の中央値が
  // 増えていないことと、3 等分したどの区間の中央値からも増えていないことを見る
  const baseDelays = observations
    .map((observation) => subscriberOf(observation).baseDelayMs)
    .filter((value): value is number => value !== null);
  expect(baseDelays.length, `音声の基準の遅れが観測されている\n${report}`).toBe(OBSERVE_SECONDS);
  const thirdMedians = thirdsMedians(baseDelays);
  const baseDelayGrowthMs = (thirdMedians[2] ?? Number.NaN) - (thirdMedians[0] ?? Number.NaN);
  expect(
    baseDelayGrowthMs,
    `音声の基準の遅れが前半から後半へ増えない (増加 ${baseDelayGrowthMs.toFixed(1)} ms、許す上限 ${BASE_DELAY_GROWTH_MAX_MS} ms)\n${report}`,
  ).toBeLessThanOrEqual(BASE_DELAY_GROWTH_MAX_MS);
  const baseDelayRiseFromMinimumMs = (thirdMedians[2] ?? Number.NaN) - Math.min(...thirdMedians);
  expect(
    baseDelayRiseFromMinimumMs,
    `音声の基準の遅れが 3 等分したどの区間よりも増えない (増加 ${baseDelayRiseFromMinimumMs.toFixed(1)} ms、許す上限 ${BASE_DELAY_GROWTH_MAX_MS} ms)\n${report}`,
  ).toBeLessThanOrEqual(BASE_DELAY_GROWTH_MAX_MS);

  // 鳴らなかった音が増えないこと。増え続けるなら、受信側が実時間に追いつけていない
  const missedFrames = observations.map((observation) => subscriberOf(observation).missedFrames);
  const missedGrowth = (missedFrames[missedFrames.length - 1] ?? 0) - (missedFrames[0] ?? 0);
  expect(
    missedGrowth,
    `観測の間に鳴らなかった音が増えない (増加 ${missedGrowth} 音)\n${report}`,
  ).toBe(0);

  // 基準の取り直しが過度に増えないこと。段差やドリフトで基準が合わなくなると続く
  const rebases = observations.map((observation) => subscriberOf(observation).playoutRebases);
  const rebaseGrowth = (rebases[rebases.length - 1] ?? 0) - (rebases[0] ?? 0);
  expect(
    rebaseGrowth,
    `観測の間に基準の取り直しが過度に増えない (増加 ${rebaseGrowth} 回、許す上限 ${PLAYOUT_REBASE_GROWTH_MAX} 回)\n${report}`,
  ).toBeLessThanOrEqual(PLAYOUT_REBASE_GROWTH_MAX);

  // 音声と映像の基準の差が妥当な範囲に収まり、増え続けないこと
  const baseDifferences = observations
    .map((observation) => subscriberOf(observation).baseDifferenceMs)
    .filter((value): value is number => value !== null);
  expect(baseDifferences.length, `基準の差が観測されている\n${report}`).toBe(OBSERVE_SECONDS);
  const baseDifferenceOverflow = baseDifferences.find(
    (difference) => Math.abs(difference) > BASE_DIFFERENCE_MAX_MS,
  );
  expect(
    baseDifferenceOverflow,
    `音声と映像の基準の差が妥当な範囲に収まる (許す絶対値 ${BASE_DIFFERENCE_MAX_MS} ms)\n${report}`,
  ).toBeUndefined();
  const differenceThirdMedians = thirdsMedians(baseDifferences);
  const baseDifferenceGrowthMs =
    (differenceThirdMedians[2] ?? Number.NaN) - (differenceThirdMedians[0] ?? Number.NaN);
  expect(
    baseDifferenceGrowthMs,
    `音声と映像の基準の差が前半から後半へ増えない (増加 ${baseDifferenceGrowthMs.toFixed(1)} ms、許す上限 ${BASE_DIFFERENCE_GROWTH_MAX_MS} ms)\n${report}`,
  ).toBeLessThanOrEqual(BASE_DIFFERENCE_GROWTH_MAX_MS);

  // 音声と映像の基準の共有が解除されないこと。共有は、基準の差が動き続けている (送る
  // TIMESTAMP が壁時計からずれている)、または差が上限を超えたときに解除され、実装は一度
  // 解除すると 30 秒は戻さない。解除されたまま音声が共有の時間軸で並ばなくなると、
  // 受信側は到着基準へ落ちて映像との対応を失う (送る TIMESTAMP がずれる症状そのものである)。
  //
  // 遅い runner では、受信側の経路が一瞬つまずいただけでも解除が残るため、この判定は
  // runner の処理能力にも反応する (実測: 1 vCPU のコンテナでは 5 回中 2 回落ちた)。
  // 環境の速度を測らないための切り分けは失敗メッセージに出す (観測値の推移と、その
  // 環境での定常値) ため、ここでは解除そのものを落とす
  const unsharedObservation = observations.find(
    (observation) =>
      !subscriberOf(observation).sharingBases ||
      subscriberOf(observation).unsharedReason !== "none",
  );
  expect(
    unsharedObservation,
    `観測の間に音声と映像の基準の共有が解除されない\n${report}`,
  ).toBeUndefined();

  // 送る側の TIMESTAMP が壁時計からずれていかないこと。原点 (読み出した壁時計 -
  // `AudioData.timestamp`) の傾きが 0 近傍であり、観測した最小と最大の幅も広がらない
  // ことを見る。ここは環境の速度に依存しない (読み出しの遅れが動いても、時計そのものが
  // ずれていなければ傾きは 0 のままである)
  const appliedOffsets = observations.map((observation) => observation.publisher.appliedMs);
  const missingAppliedOffset = appliedOffsets.indexOf(null);
  expect(missingAppliedOffset, `観測の間に配信側の補正が決まっている\n${report}`).toBe(-1);
  const slopes = observations.map((observation) => observation.publisher.slope10sMsPerSecond);
  const longSlopes = observations.map((observation) => observation.publisher.slope60sMsPerSecond);
  const slopeOverflow = slopes.find(
    (slope) => slope !== null && Math.abs(slope) > TIMESTAMP_SLOPE_MAX_MS_PER_SECOND,
  );
  expect(
    slopeOverflow,
    `配信側の原点の 10 秒の傾きが 0 近傍 (許す傾き ${TIMESTAMP_SLOPE_MAX_MS_PER_SECOND} ms/秒)\n${report}`,
  ).toBeUndefined();
  const longSlopeOverflow = longSlopes.find(
    (slope) => slope !== null && Math.abs(slope) > TIMESTAMP_SLOPE_MAX_MS_PER_SECOND,
  );
  expect(
    longSlopeOverflow,
    `配信側の原点の 60 秒の傾きが 0 近傍 (許す傾き ${TIMESTAMP_SLOPE_MAX_MS_PER_SECOND} ms/秒)\n${report}`,
  ).toBeUndefined();
  const lastSlope = slopes[slopes.length - 1] ?? null;
  const lastLongSlope = longSlopes[longSlopes.length - 1] ?? null;
  expect(lastSlope, `10 秒の傾きが観測されている\n${report}`).not.toBeNull();
  expect(lastLongSlope, `60 秒の傾きが観測されている\n${report}`).not.toBeNull();

  const widths = observations
    .map((observation) => {
      const minMs = observation.publisher.minMs;
      const maxMs = observation.publisher.maxMs;
      return minMs === null || maxMs === null ? null : maxMs - minMs;
    })
    .filter((value): value is number => value !== null);
  expect(widths.length, `配信側の原点の幅が観測されている\n${report}`).toBe(OBSERVE_SECONDS);
  const firstWidthMs = widths[0] ?? Number.NaN;
  const lastWidthMs = widths[widths.length - 1] ?? Number.NaN;
  const widthGrowthMs = lastWidthMs - firstWidthMs;
  expect(
    widthGrowthMs,
    `配信側の原点の最小と最大の幅が広がらない (増加 ${widthGrowthMs.toFixed(1)} ms、許す上限 ${TIMESTAMP_WIDTH_GROWTH_MAX_MS} ms)\n${report}`,
  ).toBeLessThanOrEqual(TIMESTAMP_WIDTH_GROWTH_MAX_MS);
  expect(
    Math.max(...widths),
    `配信側の原点の最小と最大の幅が小さい (最大 ${Math.max(...widths).toFixed(1)} ms、許す上限 ${TIMESTAMP_WIDTH_MAX_MS} ms)\n${report}`,
  ).toBeLessThanOrEqual(TIMESTAMP_WIDTH_MAX_MS);

  // ここまでが通ったことを、CI のログからも読めるようにする
  console.log(`実リレーの音声の観測: すべての不変条件を満たした\n${report}`);

  const stats = await readStats(page);

  // 映像の表示待ちの p95 は判定に使わない。音声の基準が動くと、受信側は映像を音声へ
  // 合わせて遅らせるためこの値も伸びるが、runner の処理能力でも伸びる (実測: 1 vCPU の
  // コンテナでは、音声の基準が安定していても上限を超えた)。観測値としてログへ残す
  const videoDisplayWaitP95Ms =
    stats.subscriber?.playbackTiming.latencyBreakdown.displayWait?.p95 ?? null;
  console.log(
    `実リレーの音声の観測: 映像の表示待ちの p95 ${videoDisplayWaitP95Ms === null ? "-" : videoDisplayWaitP95Ms.toFixed(1)} ms (runner の処理能力でも動くため判定には使わない)`,
  );

  // 配信側の観測が統計に出ていること
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
