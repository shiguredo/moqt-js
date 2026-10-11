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
 * 2. 音声と映像の表示時刻の差 (`avSync.skewMs`) が予算に収まる (利用者に見えるリップシンク)。
 *    値が作られるのは基準を共有できている間だけであるため、共有が戻った後に見る
 * 3. 音声が復号され続け、鳴らなかった音 (`missedFrames`) が増えず、基準の取り直しも
 *    過度に増えない
 * 4. 配信側の「読み出した壁時計 - `AudioData.timestamp`」の傾きが 0 近傍で、TIMESTAMP に
 *    足す補正が動かない (送る TIMESTAMP が壁時計からずれていかないことの直接の検証)
 * 5. 音声と映像の基準の差が妥当な範囲に収まり、増え続けない
 * 6. 基準の共有が解除された場合は、`AV_UNSHARED_RECOVERY_MAX_MS` 以内に戻る (解除そのものは
 *    到着と復号の乱れでも起きるため判定にしない。記録としてログに出す)
 *
 * 観測を始める前に待つのは「受信側が音声と映像の基準の遅れを観測でき、その値が動かなく
 * なること」だけである。追いつきの終了、基準の共有の成立、基準の遅れの大きさは runner の
 * 処理能力で決まるため待たない (待つと、遅い runner で原理的に成立しなくなる)。
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
 * 受信側が音声と映像の基準の遅れを観測し、その値が動かなくなるまで待つ上限 (ミリ秒)
 *
 * 待つのは「受信側が実際に観測できるようになったか」だけである。追いつきの終了、基準の
 * 共有の成立、基準の遅れの大きさは、いずれも runner の処理能力で決まるため待ちに含めない
 * (遅い runner で原理的に成立しない条件を待つと、実装が正しくてもタイムアウトする)。
 * これらは観測の間の不変条件として本体で見る
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
 * 観測を始める前に、基準の遅れが動かないでいることを確かめる時間 (ミリ秒)
 *
 * 追いつきの途中や、処理能力が足りずに段差が出た直後から観測を始めると、その段差を
 * 「観測の間の動き」として数えてしまう。受信側の値そのものを見て、動かなくなってから
 * 始める (追いつきの終了や配信側の補正の落ち着きを見ると、遅い runner では成立しない)
 */
const READY_SETTLED_MS = 3_000;

/**
 * 定常とみなす、`READY_SETTLED_MS` の間に許す動き (ミリ秒)
 *
 * 1 つの値を、定常とみなす区間の始まりに観測した値と比べる。この値を超えて動いたら、
 * その時点から区間をやり直す。定常状態の観測はこの値の 1 桁下で動く (実測: CI の runner で
 * 直近 30 秒の観測のうち、音声の基準の遅れが 0.0 ms、映像が 1.3 ms、基準の差が 1.3 ms
 * しか動かなかった)。段差 (実測で 66 ms) はこれを超える
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
 * 音声と映像の表示時刻の差 (利用者に見えるリップシンク) として許す絶対値 (ミリ秒)
 *
 * 実際に表示した実績の差 (`avSync.skewMs`) を見る。実装は 2 つの表示時刻の差を不感帯
 * (`SYNC_MIN_DELTA_MS` = 30 ms) に収め、基準を共有できないときも映像を音声の到着基準の
 * 時刻へ合わせる。ただし実績には、映像の write の遅れ (最大 `MAX_PRESENTATION_LAG_MS` =
 * 20 ms)、音声の時計の対応付けの不感帯 (`AUDIO_CLOCK_DEADBAND_MS` = 30 ms)、表示周期
 * (rAF、60 Hz で 16.7 ms) が乗る。実測 (手元の実リレー) では -87〜-6 ms であり、30 ms を
 * 判定にすると環境そのものを測ることになる。桁が変わるずれ (0754 の症状では数百 ms) を
 * 捕まえる値にする
 */
const AV_SKEW_MAX_MS = 150;

/**
 * 基準の共有が解除された後、共有が戻るまでに許す時間 (ミリ秒)
 *
 * 実装は一度解除すると `PLAYOUT_BASE_UNSHARED_HOLD_MS` (30 秒) は戻さず、解除のきっかけが
 * 去った場合は `PLAYOUT_BASE_UNSHARED_RELEASE_MS` (2 秒) で戻る。解除が解けなくなると
 * 音声が共有の時間軸で並ばないままになるため、それを捕まえる。解除そのものは runner の
 * 処理能力でも起きる (実測: CI の 4 vCPU の runner、run 38035814270) ため判定にしない
 */
const AV_UNSHARED_RECOVERY_MAX_MS = 35_000;

/**
 * 共有が戻った後に、音声と映像の表示時刻の差が観測できるのを待つ上限 (ミリ秒)
 *
 * 表示の実績は 1 秒以内に作られ (`SKEW_SAMPLE_WINDOW_MS`)、共有が戻れば値も戻る。遅い
 * runner で表示が一瞬 (1 秒以上) 途切れることを見込んで余裕を取る。ここで待つのは
 * 「値が作られるか」だけであり、値そのものは予算で判定する
 */
const SKEW_OBSERVE_TIMEOUT_MS = 15_000;

/**
 * 配信側の原点の傾きとして許す上限 (ミリ秒 / 秒)
 *
 * 実装が保証するのは「一定のずれに収まる」ことである。観測した速さの実測は 0.0 ms/秒で
 * あり、壁時計からずれていく場合は 20 ms/秒 を超える (10 秒で 217 ms、200 秒で 4802 ms)。
 * 読み出しの遅れが段差で動く環境 (実測で 160 ms) でも、この値には届かない
 */
const TIMESTAMP_SLOPE_MAX_MS_PER_SECOND = 5;

/**
 * 観測の間に許す、配信側が TIMESTAMP に足している補正の動き (ミリ秒)
 *
 * 送る TIMESTAMP の対応が観測の間に変わらないことを見る。補正は窓の最小 (床) へ合わせる
 * ため、読み出しが一瞬遅れて原点の最大が跳ねても動かない (実測: CI の 4 vCPU の runner、
 * run 38099573874 では、観測の 5 秒目に読み出しの遅れで最大値が 99.1 ms 跳ね、同じ観測で
 * 23 フレーム (230 ms) を捨てていたが、補正は 5251.3〜5251.4 ms のままだった)。実装が
 * 段差とみなして取り直すのは、床が 200 ms 以上 (`AUDIO_TIMESTAMP_OFFSET_STEP_MICROS`)
 * 上がったときだけである。ゆっくりしたドリフトでは、床の上昇が 5 秒続いた分だけ動く
 * (`AUDIO_TIMESTAMP_OFFSET_RISE_HOLD_MS`。1 ms/秒 のドリフトが 25 秒続いても 20 ms 程度)
 */
const TIMESTAMP_CORRECTION_MAX_MS = 75;

/**
 * 観測の間に観測した、配信側の原点の幅として許す絶対値 (ミリ秒)
 *
 * 桁が変わる取り違え (単位や時計の取り違え) を捕まえる。配信側の `minMs` / `maxMs` の
 * 累積の幅は絶対値の判定には使わない。観測を始める前の過渡を含むためである。実測 (CI の
 * 4 vCPU の runner、run 38059225640) では、観測の 25 秒の間ずっと最小 1791642117229.2 ms /
 * 最大 1791642117834.4 ms (幅 605.2 ms) であり、観測の間の増加は 0 ms だった。この幅は、
 * 購読が定常になるまでの間に読み出しがまとめて行われた分 (runner がメインスレッドを
 * 止めた 1 回の分) である。段差のように観測の間に原点の対応が動けば、補正
 * (`TIMESTAMP_CORRECTION_MAX_MS` で見る) と傾きに現れる
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
  /**
   * 動きの判定が使う、直近の窓の最小値で見た基準の差 (ミリ秒)
   *
   * 基準 (`baseDifferenceMs`) との隔たりが、経路と復号の乱れの大きさになる
   */
  baseDifferenceRecentMs: number | null;
  /** 動きの判定が使う水準からの隔たり (ミリ秒)。水準がまだ無ければ null */
  baseDifferenceDeviationMs: number | null;
  /** 直近に表示した音声と映像の表示時刻の差 (ミリ秒)。揃っていなければ null */
  skewMs: number | null;
  /** 直近の基準の差の動き (ミリ秒 / 秒)。まだ履歴が無ければ null */
  baseDriftMsPerSecond: number | null;
  /** 基準を共有できているか */
  sharingBases: boolean;
  /** 基準を共有できていない理由 */
  unsharedReason: string;
  /** 復号した音声 Chunk の数 */
  chunksDecoded: number;
  /** 受信した音声を音声出力デバイスで再生するか (これが偽の間は基準が記録されない) */
  playbackEnabled: boolean;
  /** 鳴らす基準を取り直した回数 */
  playoutRebases: number;
  /** 遅れが上限を超えて捨てた音の数 */
  playoutDrops: number;
  /** 鳴らさなかった音の数 */
  missedFrames: number;
  /** relay の cache から追いつく途中かどうか */
  catchUpPending: boolean;
  /** 直近に受信した音声 Object の到着の遅れ (ミリ秒)。まだ観測していなければ null */
  receiveDelayMs: number | null;
  /** 受信した音声 Object の到着の遅れの最大 (ミリ秒)。まだ観測していなければ null */
  maxReceiveDelayMs: number | null;
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
  /** 配信側が足した遅れ (ミリ秒)。まだ観測していなければ null */
  lagMs: number | null;
  /** 健全時の遅れ (床、ミリ秒)。まだ観測していなければ null */
  floorMs: number | null;
  /** 直近に読んだフレームの読み出しの遅れ (ミリ秒) */
  readLagMs: number;
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
  /** 追いつきのために捨てたフレームの数 (累積) */
  droppedFrames: number;
  /** 追いつきのために捨てた音声の長さ (ミリ秒、累積) */
  droppedMs: number;
  /** 追いつきを始めた回数 (累積) */
  catchUpStarts: number;
  /** いま追いつきのために捨てているか */
  catchingUp: boolean;
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
  baseDifferenceRecentMs: null,
  baseDifferenceDeviationMs: null,
  skewMs: null,
  baseDriftMsPerSecond: null,
  sharingBases: false,
  unsharedReason: "unsubscribed",
  chunksDecoded: 0,
  playbackEnabled: false,
  playoutRebases: 0,
  playoutDrops: 0,
  missedFrames: 0,
  catchUpPending: true,
  receiveDelayMs: null,
  maxReceiveDelayMs: null,
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
    const catchUp = audio.catchUp;
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
        lagMs: catchUp.lagMs,
        floorMs: catchUp.floorMs,
        readLagMs: catchUp.readLagMs,
        pendingMs: catchUp.pendingMs,
        pendingFrames: catchUp.pendingFrames,
        sendQueueMs: catchUp.sendQueueMs,
        sendQueueFrames: catchUp.sendQueueFrames,
        sendLagMs: catchUp.sendLagMs,
        droppedFrames: catchUp.droppedFrames,
        droppedMs: catchUp.droppedMs,
        catchUpStarts: catchUp.catchUpStarts,
        catchingUp: catchUp.catchingUp,
      },
      subscriber:
        subscriber === null || delays === null
          ? null
          : {
              baseDelayMs: delays.audio.baseDelayMs,
              videoBaseDelayMs: delays.video.baseDelayMs,
              baseDifferenceMs: delays.baseDifferenceMs,
              baseDifferenceRecentMs: delays.baseDifferenceRecentMs,
              baseDifferenceDeviationMs: delays.baseDifferenceDeviationMs,
              skewMs: subscriber.avSync.skewMs,
              baseDriftMsPerSecond: delays.baseDriftMsPerSecond,
              sharingBases: delays.sharingBases,
              unsharedReason: delays.unsharedReason,
              chunksDecoded: subscriber.audio.chunksDecoded,
              playbackEnabled: subscriber.audio.playbackEnabled,
              playoutRebases: subscriber.audio.playoutRebases,
              playoutDrops: subscriber.audio.playoutDrops,
              missedFrames: subscriber.audio.playoutTiming.missedFrames,
              catchUpPending: subscriber.catchUpPending,
              receiveDelayMs: subscriber.audio.receiveDelayMs,
              maxReceiveDelayMs: subscriber.audio.maxReceiveDelayMs,
            },
    };
  });
}

/** 購読側がまだ読めないときは代わりの値を返す (観測のたびに null を書かなくて済むようにする) */
function subscriberOf(observation: RelayObservation): SubscriberObservation {
  return observation.subscriber ?? EMPTY_SUBSCRIBER_OBSERVATION;
}

/** 待つ対象の値 (音声と映像の基準の遅れ)。どちらかをまだ観測できていなければ null */
interface BaseDelayValues {
  audioMs: number;
  videoMs: number;
}

/**
 * 待つ対象の値を観測から取り出す
 *
 * 基準の遅れが観測できていることだけを求める。共有の有無、追いつきの途中かどうか、
 * 値の大きさは見ない (どれも runner の処理能力で決まる)
 */
function baseDelayValuesOf(observation: RelayObservation): BaseDelayValues | null {
  const subscriber = observation.subscriber;
  if (
    subscriber === null ||
    subscriber.baseDelayMs === null ||
    subscriber.videoBaseDelayMs === null
  ) {
    return null;
  }
  return { audioMs: subscriber.baseDelayMs, videoMs: subscriber.videoBaseDelayMs };
}

/** 基準の遅れが動かないでいるのを待てたかと、待つ間に見た観測 */
interface SettleWait {
  ready: boolean;
  /** 待つ間に見た観測 (待てなかったときの切り分けに使う) */
  observations: RelayObservation[];
}

/**
 * 音声と映像の基準の遅れが動かなくなるまで待つ
 *
 * 待つのは「受信側が音声と映像の基準の遅れを観測でき、その値が `READY_SETTLED_MS` の間
 * `READY_SETTLE_TOLERANCE_MS` を超えて動かないか」だけである。次に挙げるものは待たない。
 *
 * - 追いつきの終了 (`catchUpPending`): relay の cache の境界を越えた Object を復号できた
 *   かに依存し、遅い runner では境界に届かないままになり得る
 * - 基準の共有 (`sharingBases` / `unsharedReason`): 受信側の経路が一瞬つまずくと解除され、
 *   実装は解除をしばらく保持するため、同じく runner の処理能力で決まる (実測: CI の runner で
 *   `drift` のまま 90 秒間戻らなかった)
 * - 基準の遅れの大きさ: 経路の遅れと処理能力で決まる
 *
 * これらは実装が保証すべきことであるため、待ち条件ではなく観測の間の不変条件として
 * 本体で見る。待つのは値が動かないことだけであり、runner が遅くても値が動かなければ
 * 待ちは成立する。
 *
 * `expect.poll` ではなく自前のループにするのは、待てなかったときに「何を待っていて、
 * 何が動いていたか」を観測値の推移とあわせてメッセージへ出し、環境が遅いのか実装が
 * 壊れているのかを切り分けられるようにするためである
 *
 * @returns 待てたかどうかと、待つ間に見た観測
 */
async function waitForSettledBaseDelays(page: Page): Promise<SettleWait> {
  const observations: RelayObservation[] = [];
  // 定常とみなす区間の始まりに観測した値。ここから `READY_SETTLE_TOLERANCE_MS` を超えて
  // 動いたら、その時点を新しい区間の始まりにする (動き続けている間は区間が伸びない)
  let settledValues: BaseDelayValues | null = null;
  let settledSinceMs = 0;
  const deadlineMs = performance.now() + READY_TIMEOUT_MS;
  while (performance.now() < deadlineMs) {
    const observation = await readObservation(page);
    observations.push(observation);
    const values = baseDelayValuesOf(observation);
    const nowMs = performance.now();
    if (
      values === null ||
      settledValues === null ||
      Math.abs(values.audioMs - settledValues.audioMs) > READY_SETTLE_TOLERANCE_MS ||
      Math.abs(values.videoMs - settledValues.videoMs) > READY_SETTLE_TOLERANCE_MS
    ) {
      settledValues = values;
      settledSinceMs = nowMs;
      await page.waitForTimeout(SAMPLE_INTERVAL_MS);
      continue;
    }
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
    // 動きの判定が使う値 (直近 2 秒の窓の最小値の差)。基準との隔たりが、経路と復号の
    // 乱れの大きさになる。解除があったときに「短い窓だけが動いたのか、基準も動いたのか」を
    // CI のログだけで切り分けるために出す
    `  基準の差の直近の窓の値 (ミリ秒): ${formatSeries(observations.map((observation) => subscriberOf(observation).baseDifferenceRecentMs))}`,
    `  基準の差の水準からの隔たり (ミリ秒): ${formatSeries(observations.map((observation) => subscriberOf(observation).baseDifferenceDeviationMs))}`,
    // 利用者に見えるリップシンク。表示した音声と映像の実績の差である
    `  音声と映像の表示時刻の差 skewMs (ミリ秒): ${formatSeries(observations.map((observation) => subscriberOf(observation).skewMs))}`,
    // 基準の差の動きは、受信側の直近の窓の最小値から求まるため、runner が混んでいると
    // 実際の差が動いていなくても大きい値になる (実測: 差が動かないまま 12 ms/秒)。判定には
    // 使わず、解除があったときの切り分けのために残す
    `  基準の差の動き (ミリ秒 / 秒): ${formatSeries(observations.map((observation) => subscriberOf(observation).baseDriftMsPerSecond))}`,
    `  配信側の原点の現在値 (ミリ秒): ${formatSeries(observations.map((observation) => observation.publisher.currentMs))}`,
    `  配信側の原点の最小値 (ミリ秒): ${formatSeries(observations.map((observation) => observation.publisher.minMs))}`,
    `  配信側の原点の最大値 (ミリ秒): ${formatSeries(observations.map((observation) => observation.publisher.maxMs))}`,
    `  配信側の傾き 10 秒 / 60 秒 (ミリ秒 / 秒): ${formatSeries(observations.map((observation) => observation.publisher.slope10sMsPerSecond))} / ${formatSeries(observations.map((observation) => observation.publisher.slope60sMsPerSecond))}`,
    `  配信側が TIMESTAMP に足している補正 (ミリ秒): ${formatSeries(observations.map((observation) => observation.publisher.appliedMs))}`,
    // 配信側が足した遅れの内訳。どの段 (読み出し / 符号化のキュー / 送信のキュー) で
    // 遅れているかを、落ちたときに CI のログだけから切り分けられるようにする
    `  配信側の遅れ lagMs (ミリ秒): ${formatSeries(observations.map((observation) => observation.publisher.lagMs))}`,
    `  配信側の健全時の遅れ floorMs (ミリ秒): ${formatSeries(observations.map((observation) => observation.publisher.floorMs))}`,
    `  配信側の読み出しの遅れ readLagMs (ミリ秒): ${formatSeries(observations.map((observation) => observation.publisher.readLagMs))}`,
    `  配信側の符号化のキュー pendingMs / pendingFrames: ${formatSeries(observations.map((observation) => observation.publisher.pendingMs))} / ${formatSeries(
      observations.map((observation) => observation.publisher.pendingFrames),
      0,
    )}`,
    `  配信側の送信のキュー sendQueueMs / sendQueueFrames: ${formatSeries(observations.map((observation) => observation.publisher.sendQueueMs))} / ${formatSeries(
      observations.map((observation) => observation.publisher.sendQueueFrames),
      0,
    )}`,
    `  配信側の送信の遅れ sendLagMs (ミリ秒): ${formatSeries(observations.map((observation) => observation.publisher.sendLagMs))}`,
    `  配信側の追いつき droppedFrames / droppedMs / catchUpStarts / catchingUp: ${formatSeries(
      observations.map((observation) => observation.publisher.droppedFrames),
      0,
    )} / ${formatSeries(observations.map((observation) => observation.publisher.droppedMs))} / ${formatSeries(
      observations.map((observation) => observation.publisher.catchUpStarts),
      0,
    )} / ${observations.map((observation) => observation.publisher.catchingUp).join(", ")}`,
    `  復号した音声 Chunk の数: ${formatSeries(
      observations.map((observation) => subscriberOf(observation).chunksDecoded),
      0,
    )}`,
    // 音声の再生が有効でないと、復号しても基準が時間軸へ記録されない (基準がいつまでも
    // 出ない原因の切り分けに要る)
    `  音声の再生を有効にできたか (playbackEnabled): ${observations.map((observation) => subscriberOf(observation).playbackEnabled).join(", ")}`,
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
    // 追いつきの終了は待ち条件ではなくなったが、共有が戻らない理由の切り分けに要る
    `  追いつき中 (catchUpPending): ${observations.map((observation) => subscriberOf(observation).catchUpPending).join(", ")}`,
    // 受信側の到着の遅れ。配信側の送信の遅れ (sendLagMs) と対で読み、遅れが配信側と
    // 経路にあるのか、受信側の復号と再生にあるのかを分ける
    `  受信側の到着の遅れ (ミリ秒): ${formatSeries(observations.map((observation) => subscriberOf(observation).receiveDelayMs))}`,
    `  受信側の到着の遅れの最大 (ミリ秒): ${formatSeries(observations.map((observation) => subscriberOf(observation).maxReceiveDelayMs))}`,
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

/**
 * 待てなかったときに、何を待っていて、どの値が動いていたのかをまとめる
 *
 * 待つ条件は「音声と映像の基準の遅れが `READY_SETTLED_MS` の間 `READY_SETTLE_TOLERANCE_MS`
 * を超えて動かないこと」だけである。直近の観測から、待っていた値ごとに動いた幅を出し、
 * どちらが動き続けたのかをログだけで読めるようにする (待ちの条件そのものは、動かなかった
 * 場合には現れないため、失敗したメッセージに残す)
 */
function formatSettleReport(observations: readonly RelayObservation[]): string {
  // 1 秒ごとの観測であるため、直近 `READY_SETTLED_MS` に当たる回数を取る
  const samples = Math.ceil(READY_SETTLED_MS / SAMPLE_INTERVAL_MS) + 1;
  const recent = observations.slice(-samples);
  const lines = [
    `  待っていたこと: 音声と映像の基準の遅れが ${READY_SETTLED_MS / 1_000} 秒の間 ${READY_SETTLE_TOLERANCE_MS} ms を超えて動かないこと (直近 ${recent.length} 回の観測で見る)`,
  ];
  const targets: [string, (observation: RelayObservation) => number | null][] = [
    ["音声の基準の遅れ", (observation) => subscriberOf(observation).baseDelayMs],
    ["映像の基準の遅れ", (observation) => subscriberOf(observation).videoBaseDelayMs],
  ];
  for (const [label, valueOf] of targets) {
    const values = recent
      .map((observation) => valueOf(observation))
      .filter((value): value is number => value !== null);
    if (values.length === 0) {
      lines.push(`  ${label}: 待つ間に 1 回も観測できなかった`);
      continue;
    }
    const movementMs = Math.max(...values) - Math.min(...values);
    lines.push(
      `  ${label}: 動いた幅 ${movementMs.toFixed(1)} ms (許す上限 ${READY_SETTLE_TOLERANCE_MS} ms、直近の値 ${(values[values.length - 1] ?? Number.NaN).toFixed(1)} ms、観測できた回数 ${values.length}/${recent.length})`,
    );
  }
  return lines.join("\n");
}

/**
 * 音声と映像の表示時刻の差 (利用者に見えるリップシンク) が予算に収まっているかを見る
 *
 * 基準の差ではなく、実際に表示した実績の差 (`avSync.skewMs`) を見る。共有が解除されていても、
 * 実装は映像を音声の到着基準の時刻へ合わせるため、見えるずれは予算に収まる。
 *
 * 観測の 1 秒ごとに値があることは要求しない。値は「直近に表示した音声と映像の実績が
 * `SKEW_SAMPLE_WINDOW_MS` (1 秒) 以内にある」ときだけ作られるため、表示が 1 秒以上途切れると
 * null になる。実測 (CI の 4 vCPU の runner、run 38048874698) では、基準の共有を解除した
 * 保持 (hold) が観測の 25 秒間続き、`skewMs` が 25 回すべて null だった (この run の基準の
 * 差は 3.2〜5.8 ms であり、解除は受信側が一瞬つまずいたためである)。判定は 2 つに分ける
 *
 * 1. 観測できた値はすべて予算に収まる (0754 の症状である数百 ms のずれを捕まえる)
 * 2. 共有が戻った後に、値が作られ続ける (基準が合っているのに実績が作られない状態を捕まえる)
 *
 * 2 は `expectUnsharedRecovers` の後に呼ぶ。共有が解除されている間は値が作られないためである
 *
 * @param page - 観測しているページ
 * @param observations - 観測
 * @param report - 失敗したときに出す観測値の推移
 */
async function expectSkewWithinBudget(
  page: Page,
  observations: readonly RelayObservation[],
  report: string,
): Promise<void> {
  const observed = observations
    .map((observation) => subscriberOf(observation).skewMs)
    .filter((value): value is number => value !== null);
  const skewOverflow = observed.find((skew) => Math.abs(skew) > AV_SKEW_MAX_MS);
  expect(
    skewOverflow,
    `音声と映像の表示時刻の差が予算に収まる (許す絶対値 ${AV_SKEW_MAX_MS} ms)\n${report}`,
  ).toBeUndefined();

  // 共有が戻った後に値が作られることを確かめる。1 回の観測だけでなく、値が観測できた
  // ところまでを待つ (その瞬間だけ表示が途切れている場合を失敗にしない)
  let latestSkewMs: number | null = null;
  await expect
    .poll(
      async () => {
        latestSkewMs = subscriberOf(await readObservation(page)).skewMs;
        return latestSkewMs;
      },
      {
        message: `共有が戻った後に、音声と映像の表示時刻の差が観測できる (${SKEW_OBSERVE_TIMEOUT_MS} ms 待つ)\n${report}`,
        timeout: SKEW_OBSERVE_TIMEOUT_MS,
        intervals: [SAMPLE_INTERVAL_MS],
      },
    )
    .not.toBeNull();
  expect(
    Math.abs(latestSkewMs ?? Number.NaN),
    `共有が戻った後の音声と映像の表示時刻の差が予算に収まる (許す絶対値 ${AV_SKEW_MAX_MS} ms)\n${report}`,
  ).toBeLessThanOrEqual(AV_SKEW_MAX_MS);
}

/**
 * 基準の共有が解除されたままにならないことを見る
 *
 * 解除そのものは判定にしない。共有は、基準の差が動き続けている (送る TIMESTAMP が壁時計から
 * ずれている)、または差が上限を超えたときに解除され、実装は一度解除すると 30 秒は戻さない。
 * 遅い runner では受信側が一瞬つまずいただけでも解除が起きる (実測: CI の 4 vCPU の runner、
 * run 38035814270) ため、解除そのものを落とすと runner の処理能力を測ることになる。
 *
 * 代わりに「解除が残り続けないこと」を判定する。解除が解けなくなると、音声が共有の時間軸で
 * 並ばないままになり、A/V の対応が失われる (送る TIMESTAMP がずれる症状そのものである)。
 * 解除したことは記録としてログへ出し、判定には使わない。
 *
 * @param page - 観測しているページ
 * @param observations - 観測
 * @param report - 失敗したときに出す観測値の推移
 */
async function expectUnsharedRecovers(
  page: Page,
  observations: readonly RelayObservation[],
  report: string,
): Promise<void> {
  const unshared = observations.filter(
    (observation) =>
      !subscriberOf(observation).sharingBases ||
      subscriberOf(observation).unsharedReason !== "none",
  );
  if (unshared.length > 0) {
    // 解除そのものは記録としてログへ残す (判定にしない)。理由と、切り分けに要る値も出す
    console.log(
      `実リレーの音声の観測: 基準の共有を解除した観測が ${unshared.length}/${OBSERVE_SECONDS} 回あった (理由: ${[...new Set(unshared.map((observation) => subscriberOf(observation).unsharedReason))].join(", ")}、最初 ${Math.round((unshared[0]?.atMs ?? 0) - (observations[0]?.atMs ?? 0))} ms)。共有が戻るまで待つ\n${report}`,
    );
    // 保持は 30 秒であり、解除のきっかけが去ればさらに 2 秒で戻る。解除を最初に観測した時点を
    // 起点に、`AV_UNSHARED_RECOVERY_MAX_MS` のうちに戻らなければ、解除が解けていない
    const deadlineMs = (unshared[0]?.atMs ?? performance.now()) + AV_UNSHARED_RECOVERY_MAX_MS;
    await expect
      .poll(() => readSharingBases(page), {
        message: `解除された基準の共有が ${AV_UNSHARED_RECOVERY_MAX_MS / 1_000} 秒以内に戻る\n${report}`,
        timeout: Math.max(1_000, deadlineMs - performance.now()),
        intervals: [SAMPLE_INTERVAL_MS],
      })
      .toBe(true);
  }
  expect(await readSharingBases(page), `観測の後、音声と映像の基準を共有している\n${report}`).toBe(
    true,
  );
}

/** いま音声と映像の基準を共有できているかを読む */
async function readSharingBases(page: Page): Promise<boolean> {
  return subscriberOf(await readObservation(page)).sharingBases;
}

test("実リレー経由で同じブラウザから音声を配信し、送る TIMESTAMP と受信側の基準がずれない", async ({
  page,
}): Promise<void> => {
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

  // 受信側が音声と映像の基準の遅れを観測でき、その値が動かなくなるまで待つ。待つのは安定だけ
  // であり、追いつきの終了や基準の共有の成立は待たない (どちらも runner の処理能力で決まる。
  // 実装が保証すべきことは、観測の間の不変条件として本体で見る)。購読の直後は、relay の
  // cache から届いた分と購読を始めるまでにたまった分をまとめて復号しており、値は過渡である
  const settled = await waitForSettledBaseDelays(page);
  expect(
    settled.ready,
    `受信側の音声と映像の基準の遅れが ${READY_SETTLED_MS / 1_000} 秒の間 ${READY_SETTLE_TOLERANCE_MS} ms を超えて動かないのを待つ (${READY_TIMEOUT_MS} ms)\n${formatSettleReport(settled.observations)}\n${formatObservationReport(settled.observations.slice(-READINESS_REPORT_SAMPLES), subscriberOf)}`,
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

  // 基準の共有が解除されたこと自体は判定にしない (理由は `expectUnsharedRecovers` を参照)。
  // 解除の記録はログへ出し、解除が残り続けないことだけを判定する
  await expectUnsharedRecovers(page, observations, report);

  // 音声と映像の表示時刻の差 (利用者に見えるリップシンク) が予算に収まること。基準の差では
  // なく、実際に表示した実績の差を見る。共有が解除されている間は値が作られないため、
  // 共有が戻ったことを確かめた後に見る (`expectSkewWithinBudget` の説明を参照)
  await expectSkewWithinBudget(page, observations, report);

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

  // 配信側が TIMESTAMP に足している補正が、観測の間に動かないこと。原点 (読み出した壁時計 -
  // `AudioData.timestamp`) の累積の最小と最大は、読み出しが遅れれば最大が跳ね、早まれば
  // 最小が下がるため、観測の間の動きをそのまま異常とみなせない (実測: run 38099573874 では、
  // 読み出しの遅れで最大値が 99.1 ms 跳ね、同じ観測で 23 フレーム (230 ms) を捨てていた。
  // 最小値は動かず、傾きも 0.0 ms/秒のままである)。実装は補正を窓の最小 (床) へ合わせる
  // ため、この一跳びは送る TIMESTAMP を動かさない。補正が動けば、TIMESTAMP の対応が
  // 観測の間に変わったことになる
  const appliedSeries = observations
    .map((observation) => observation.publisher.appliedMs)
    .filter((value): value is number => value !== null);
  expect(appliedSeries.length, `配信側の補正が観測されている\n${report}`).toBe(OBSERVE_SECONDS);
  const appliedSpreadMs = Math.max(...appliedSeries) - Math.min(...appliedSeries);
  expect(
    appliedSpreadMs,
    `配信側が TIMESTAMP に足している補正が動かない (動いた幅 ${appliedSpreadMs.toFixed(1)} ms、許す上限 ${TIMESTAMP_CORRECTION_MAX_MS} ms)\n${report}`,
  ).toBeLessThanOrEqual(TIMESTAMP_CORRECTION_MAX_MS);

  // 幅の絶対値は、観測の間に観測した原点そのものから見る。累積の幅は観測を始める前の
  // 過渡を含むため、絶対値の判定には使えない (`TIMESTAMP_WIDTH_MAX_MS` の説明を参照)
  const origins = observations
    .map((observation) => observation.publisher.currentMs)
    .filter((value): value is number => value !== null);
  expect(origins.length, `配信側の原点が観測されている\n${report}`).toBe(OBSERVE_SECONDS);
  const originWidthMs = Math.max(...origins) - Math.min(...origins);
  expect(
    originWidthMs,
    `配信側の原点の幅が小さい (観測した幅 ${originWidthMs.toFixed(1)} ms、許す上限 ${TIMESTAMP_WIDTH_MAX_MS} ms)\n${report}`,
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
