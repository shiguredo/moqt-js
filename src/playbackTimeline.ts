/**
 * 音声と映像の表示時刻を決める時間軸
 *
 * 同じ render group の track は同じ targetLatency を持ち (draft-ietf-moq-msf-01 §5.2.8)、
 * 同時に描画するよう設計されている (§5.2.11)。LOC の TIMESTAMP は Timescale が無ければ
 * Unix epoch マイクロ秒の壁時計である (draft-ietf-moq-loc-04 §2.3.1.1)。
 *
 * 表示時刻 = TIMESTAMP + 基準の遅れ + 表示の遅れ
 *
 * - 基準の遅れ: トラックごとの「復号の出力の壁時計の時刻 - TIMESTAMP」の直近 10 秒の
 *   最小値 (ミリ秒)。受信側と送信側の時計のずれと、経路と復号の最小遅延を含む。遅れは
 *   到着ではなく復号の出力の時刻で測る (表示できる時刻には復号の時間も含まれるため)
 * - 表示の遅れ: トラックごとの jitter buffer の遅延 (ミリ秒)。経路の揺らぎから求める
 *   - 音声は NetEq と同じ規則 (`src/audioDelayManager.ts`)。到着の遅れの 0.95 分位である
 *   - 映像は「遅れ - 基準の遅れ」の百分位から求めた揺らぎ (`playoutDelayPercentile`)。
 *     表示時刻の後に届くフレームが 1 秒に `LATE_FRAMES_PER_SECOND` 枚までになる値である
 * - A/V 同期: 2 つのトラックの表示時刻の差が `SYNC_MIN_DELTA_MS` を超えたときだけ、先行する
 *   側の表示の遅れを「後行側 - 不感帯」まで上げる (不感帯の中では 2 つの遅延は独立であり、
 *   映像は音声の jitter buffer の遅延に引きずられない。差が不感帯を超えると、先行する側は
 *   後行側の表示の遅れに合わせて上がる)。合わせる量は「基準の遅れ + 表示の
 *   遅れ」の差そのものであり、経路の相対遅延 (直近の観測) ではない。ただし合わせる量は
 *   `PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS` までにする。時計のずれの証拠を見たかどうかに
 *   関わらず常に掛ける (実測では、証拠を見る前に音声の TIMESTAMP が 600 ms 段差でずれ、
 *   段差を揺らぎとして学習した音声の遅延へ映像を合わせて 600 ms 足し、映像が 500 ms
 *   遅れたまま数十秒戻らなかった)。観測のたびに行い、上げるのは即座、下げるのは毎秒
 *   `PLAYBACK_DELAY_DECAY_MS_PER_SECOND` までにする (急に下げると、既に積んだフレームより
 *   後ろに並ぶフレームが出る)
 * - `targetLatency` は 2 つのトラックの表示の遅れの下限になり、同期の制御の分はその上に乗る
 * - 表示の遅れの上限: `MAX_PLAYOUT_DELAY_MS` と、表示待ちのキューが吸収できる長さの
 *   小さい方を表示の遅れに掛ける。基準の遅れは送受信の時計のずれでありキューを消費しない
 *   ため、上限は掛けない
 * - 2 つのトラックの基準の差が、表示の遅れの上限から下限を引いた閾値を超えたら同期しない。
 *   TIMESTAMP が壁時計からずれているトラック (音声のドリフトなど) に、もう片方を
 *   合わせないため
 * - 基準の差が `PLAYOUT_BASE_DRIFT_MS` を超えて動いたら (差が経路の遅れではなく時計の
 *   ずれである)、大きさの閾値を待たずに同期しない。合わせると片側の表示の遅れが上限まで
 *   伸びて戻せなくなるためである。同期しない間は、その時点までに足した分を毎秒
 *   `PLAYBACK_DELAY_DECAY_MS_PER_SECOND` までで戻す
 * - 遅延の内訳 (基準の遅れ・jitter buffer の遅延・足した分・共有できているかとその理由・
 *   差の動き) は `delayBreakdown` が返す。音声と映像の遅れを比べて改善するために使う
 *
 * ブラウザ API に依存せず、時刻は引数で受ける (`performance.now()` と
 * `performance.timeOrigin` は呼び出し側が渡す)。
 */

import { AudioDelayManager, type AudioDelayManagerOptions } from "./audioDelayManager";
import { TimedValues } from "./timedValues";

/** 基準の遅れと揺らぎを求める直近の窓 (ミリ秒) */
export const PLAYBACK_WINDOW_MS = 10_000;

/**
 * 表示時刻の後に届くことを許すフレームの数 (1 秒あたり)
 *
 * 表示時刻の後に届いたフレームは、その表示周期に描けず止まりになる。見る側が感じるのは
 * 1 秒あたりの止まりの数であり、同じ割合で遅れを許すと、配信 fps が高いほど止まりが
 * 増える (5% なら 30 fps で 1 秒に 1.5 回、120 fps で 6 回)。許す数を 1 秒あたりで決め、
 * 再生遅延の目標にする揺らぎの百分位を配信 fps から求める (`playoutDelayPercentile`)
 */
export const LATE_FRAMES_PER_SECOND = 1;

/**
 * 再生遅延の目標にする揺らぎの百分位の下限
 *
 * 配信 fps が低い (20 fps 以下) と 1 秒に 1 枚は 5% を超えるため、95% のフレームは
 * 表示時刻までに届く長さを保つ。経路のまれな大きな遅延の跳ね (数分に数回、300 ms 前後)
 * まで吸収しようとすると、常に大きく遅れて表示することになるため、百分位は 100% にしない
 */
export const MIN_PLAYOUT_DELAY_PERCENTILE = 0.95;

/** 表示の遅れの上限 (ミリ秒)。これ以上遅らせるよりは、止まりを受け入れる */
export const MAX_PLAYOUT_DELAY_MS = 500;

/** 追いつき中かを確かめる間隔 (ミリ秒) */
export const CATCH_UP_CHECK_INTERVAL_MS = 250;

/**
 * 追いつき中とみなす、`CATCH_UP_CHECK_INTERVAL_MS` の間の基準の遅れの下がり幅 (ミリ秒)
 *
 * 実時間の 1.1 倍の速さで追いつく場合も 25 ms 下がる。live に追いついた後の経路の
 * 最小の遅延の変化 (数ミリ秒) より十分大きくする
 */
export const CATCH_UP_MIN_BASE_DROP_MS = 20;

/** 目標が下がったときに再生遅延を下げる速さ (ミリ秒 / 秒) */
export const PLAYBACK_DELAY_DECAY_MS_PER_SECOND = 20;

/**
 * 遅れが基準からこれ以上離れたら、TIMESTAMP の飛びとみなして基準を取り直す (ミリ秒)
 *
 * publisher の時計の変更や別の publisher への切り替えで TIMESTAMP が大きく戻ると、以降の
 * フレームがすべて遅れて見えて再生遅延が上限に張り付き、大きく進むとフレームが先の時刻で
 * 待ち続ける。再生遅延の上限 (500 ms) と通常の揺らぎより十分大きくする
 */
export const PLAYBACK_DISCONTINUITY_MS = 2_000;

/**
 * 音声の再生遅延の下限 (ミリ秒)
 *
 * 壁時計の TIMESTAMP を持たない音 (TIMESTAMP 無し、Timescale あり) と、時間軸がまだ
 * 音声を観測していないときに使う。NetEq の目標遅延も観測が無い間は同じ値 (80 ms) から
 * 始まるため、`src/audioDelayManager.ts` の `AUDIO_DELAY_START_MS` と揃える
 */
export const AUDIO_PLAYOUT_DELAY_FLOOR_MS = 80;

/**
 * 表示待ちのキューの上限のうち、揺らぎで一時的に増える分として空けておく枚数
 *
 * 再生遅延は (上限 - この枚数) 枚分のフレーム間隔までに抑える。フレーム間隔が短い
 * (120 fps など) ほど長く待てない
 */
export const PLAYOUT_QUEUE_HEADROOM_FRAMES = 4;

/**
 * 2 つのトラックの基準の差の閾値の下限 (ミリ秒)
 *
 * 閾値は表示の遅れの上限から下限を引いた値になる。これが 0 に近いと、同期の制御と解除を
 * 往復して基準の学習とキューの到着順化が繰り返し起きるため、下限を置く
 */
export const PLAYOUT_BASE_MAX_DIFFERENCE_MIN_MS = 100;

/**
 * 2 つのトラックの基準の差が、この幅を超えて動いたら時計がずれているとみなす (ミリ秒)
 *
 * 差が大きいだけなら「経路と復号の遅い側」であり、同期の制御で合わせられる。しかし
 * 差が動き続ける場合、それは経路の遅れではなく、片方の TIMESTAMP が壁時計から
 * ずれていくこと (0754 の音声のドリフトなど) を意味する。ずれ続ける差を合わせると、
 * もう片方の表示の遅れが上限まで伸びて戻せなくなるため、動きで見分ける。
 *
 * 実時間に対する時計の進み方の違いは 500 ppm (毎秒 0.5 ms) 未満であり、経路と復号の
 * 最小遅延の差も毎秒ミリ秒の桁でしか動かない。したがってこの幅 (5 秒で 50 ms =
 * 毎秒 10 ms) を超える動きは時計のずれとみなしてよい
 */
export const PLAYOUT_BASE_DRIFT_MS = 50;

/** 基準の差の動きを見る窓 (ミリ秒) */
export const PLAYOUT_BASE_DRIFT_WINDOW_MS = 5_000;

/**
 * A/V 同期で合わせる、2 つのトラックの基準の差の上限 (ミリ秒)
 *
 * 同じ publisher・同じ経路の 2 つのトラックで、経路と復号の「最小」遅延がこれ以上違う
 * ことはない。これを超える差は TIMESTAMP の時計のずれであることが多く、合わせても実際の
 * ずれは減らないまま、相手側の表示の遅れだけが伸びる (実測では音声の基準が 313 ms・映像が
 * 13 ms のとき、映像へ 378 ms を足して表示の遅延が 483 ms になっていた)。合わせるのは
 * この分までにし、残りは A/V のずれとして受け入れる。時計のずれの証拠を見たかどうかには
 * 依らず、常に掛ける (証拠を見る前に 600 ms の段差を合わせて映像を 500 ms 遅らせた実測が
 * あるため)
 */
export const PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS = 100;

/**
 * いったん基準を共有しないと決めた後、判定を戻さない時間 (ミリ秒)
 *
 * 閾値は「表示の遅れの上限 - そのトラックの遅延」で決まるため、jitter buffer の目標遅延が
 * 段差で動くたびに閾値も動く。実測では差が 300 ms でほぼ動かないまま、音声の目標遅延が
 * 380 ms と 100 ms を行き来して閾値が 120 ms と 400 ms を行き来し、13 秒間に 5 回
 * 共有と解除を往復した。往復のたびに、足した分を戻して (間に合わないフレームを捨てる)
 * すぐ足し直す (表示が待って止まる) ことになるため、しばらくは戻さない
 */
export const PLAYOUT_BASE_UNSHARED_HOLD_MS = 30_000;

/** 基準の差を記録する間隔 (ミリ秒) */
const BASE_DIFFERENCE_SAMPLE_INTERVAL_MS = 250;

/**
 * 基準の差の動きを見るときに使う、直近の基準を求める窓 (ミリ秒)
 *
 * 窓全体 (`PLAYBACK_WINDOW_MS`) の最小値は、TIMESTAMP が壁時計から遅れていくときも
 * 窓が埋まるまで動かない。短い窓で取り直すことで、合わせる側の遅れが上限へ伸びる前に
 * 動きを見つける。短くするほど経路の揺らぎの影響を受けやすいため、映像の到着が
 * まとまっていても最小値が動かない長さにする
 */
const BASE_DIFFERENCE_RECENT_WINDOW_MS = 2_000;

/**
 * 同期の制御を行うずれの下限 (ミリ秒)
 *
 * libwebrtc の `kMinDeltaMs` と同じ値。この不感帯の中では遅延を変えないため、映像は
 * 音声より最大この値だけ先行できる
 */
export const SYNC_MIN_DELTA_MS = 30;

// フレーム間隔を求めるために保持する TIMESTAMP の差の数
const FRAME_INTERVAL_SAMPLES = 32;

// 実績を同期の推定に使う期間 (ミリ秒)
const SKEW_SAMPLE_WINDOW_MS = 1_000;

/** 表示時刻を求める相手 (音声と映像) */
export type PlaybackStream = "audio" | "video";

/** 2 つのトラックで基準を共有できているか、できていない理由 */
export type PlaybackUnsharedReason =
  // 共有している (どちらも TIMESTAMP を使えている)
  | "none"
  // 基準がまだ足りない (どちらかを観測していない、表示の遅れがまだ決まっていない)
  | "unobserved"
  // 基準の差が表示の遅れの上限を超えている (上限では合わせられない)
  | "difference"
  // 基準の差が動き続けている (TIMESTAMP が壁時計からずれている)
  | "drift"
  // 直前にやめた判定を保持している (閾値が動いても往復させない)
  | "hold";

/**
 * トラックごとの表示時刻の内訳 (遅延の解析に使う)
 *
 * 表示時刻 = TIMESTAMP + 基準の遅れ + 表示の遅れ であり、表示の遅れは jitter buffer の
 * 遅延と `targetLatency` の大きい方に、同期の制御が足した分を加えて上限で切った値である。
 * どこで遅れが生じているかを分けるために、この 3 つを別々に出す。
 */
export interface PlaybackTrackBreakdown {
  /** 基準の遅れ (ミリ秒)。送受信の時計のずれと、経路と復号の最小遅延。未観測なら null */
  baseDelayMs: number | null;
  /** jitter buffer の遅延 (ミリ秒)。自分の揺らぎから求めた値。未観測なら null */
  jitterDelayMs: number | null;
  /** 同期の制御が足した分 (ミリ秒)。0 以上 */
  syncExtraDelayMs: number;
  /**
   * 表示の遅れ (ミリ秒)。TIMESTAMP から表示時刻までの差そのものである。上限で切った後の
   * 値であり、`presentationDelayMsOf` が null を返すとき (未観測、または基準がずれている) は
   * null。この値が null のトラックは、TIMESTAMP を使わず到着基準で再生される
   */
  presentationDelayMs: number | null;
  /** 表示の遅れの上限 (ミリ秒)。切り下げが起きているかはこの値との比較で分かる */
  presentationDelayCapMs: number;
}

/** 音声と映像の遅延の内訳 (遅延の解析に使う) */
export interface PlaybackDelayBreakdown {
  audio: PlaybackTrackBreakdown;
  video: PlaybackTrackBreakdown;
  /** 基準の差「音声 - 映像」(ミリ秒)。どちらかを観測していなければ null */
  baseDifferenceMs: number | null;
  /** 2 つのトラックで基準を共有しているか */
  sharingBases: boolean;
  /** 共有できていない理由 */
  unsharedReason: PlaybackUnsharedReason;
  /**
   * 直近の基準の差の動き (ミリ秒 / 秒)。まだ履歴が無ければ null
   *
   * `PLAYOUT_BASE_DRIFT_MS` を超えると、経路の遅れではなく時計のずれとみなして共有をやめる
   */
  baseDriftMsPerSecond: number | null;
  /** 時計のずれとみなす、基準の差の動きの幅 (ミリ秒) */
  baseDriftLimitMs: number;
  /** jitter buffer の遅延を切り下げる上限 (ミリ秒。`MAX_PLAYOUT_DELAY_MS` とキューの小さい方) */
  presentationDelayCapMs: number;
}

/** 直近に表示すると決めた実績 */
interface PresentationRecord {
  timestampMicros: number;
  presentedWallClockMicros: bigint;
  atMs: number;
}

/** トラックごとの窓と学習 */
interface StreamState {
  readonly offsets: TimedValues;
  readonly learningOffsets: TimedValues;
  baseMs: number | null;
  delayMs: number | null;
  lastArrivalMs: number | null;
  lastTimestampMs: number | null;
  lastUpdateMs: number;
  frameIntervals: number[];
  catchingUp: boolean;
  catchUpCheckpoint: { atMs: number; baseMs: number } | null;
}

/** 昇順に並べた値の nearest-rank 法の百分位 */
function percentile(sorted: readonly number[], ratio: number): number {
  return sorted[Math.max(0, Math.ceil(ratio * sorted.length) - 1)] ?? 0;
}

/**
 * 再生遅延の目標にする揺らぎの百分位
 *
 * 表示時刻の後に届くフレームが 1 秒に `LATE_FRAMES_PER_SECOND` 枚までになる百分位
 * (1 - フレーム間隔 × 枚数 / 1 秒) と下限の大きい方。30 fps で約 96.7%、60 fps で約 98.3%、
 * 120 fps で約 99.2% になる。
 *
 * @param frameIntervalMs - フレーム間隔 (ミリ秒)。不明なら null
 */
export function playoutDelayPercentile(frameIntervalMs: number | null): number {
  if (frameIntervalMs === null || frameIntervalMs <= 0) {
    return MIN_PLAYOUT_DELAY_PERCENTILE;
  }
  return Math.max(
    MIN_PLAYOUT_DELAY_PERCENTILE,
    1 - (frameIntervalMs * LATE_FRAMES_PER_SECOND) / 1_000,
  );
}

/**
 * 表示待ちのキューが吸収できる表示の遅れ (ミリ秒)
 *
 * (キューの上限 - 余裕) 枚分のフレーム間隔。フレーム間隔が分からないときは上限
 * (`MAX_PLAYOUT_DELAY_MS`) を返す。
 */
export function playoutQueueCapMs(maxQueuedFrames: number, frameIntervalMs: number | null): number {
  if (frameIntervalMs === null) {
    return MAX_PLAYOUT_DELAY_MS;
  }
  return Math.max(0, maxQueuedFrames - PLAYOUT_QUEUE_HEADROOM_FRAMES) * frameIntervalMs;
}

/** `PlaybackTimeline` の設定 */
export interface PlaybackTimelineOptions {
  /** 時刻原点の壁時計 (ミリ秒。呼び出し側が `performance.timeOrigin` を渡す) */
  timeOriginMs: number;
  /** 映像の表示待ちのキューの上限 (枚) */
  maxQueuedFrames: number;
  /** 表示の遅れの上限 (ミリ秒)。省略時は `MAX_PLAYOUT_DELAY_MS` */
  maxPresentationDelayMs?: number;
  /** 音声の目標遅延の学習の設定 (省略時は libwebrtc の既定値) */
  audioDelay?: AudioDelayManagerOptions;
}

export class PlaybackTimeline {
  private readonly timeOriginMs: number;
  private readonly maxQueuedFrames: number;
  private readonly maxPresentationDelayMs: number;
  private readonly streams: Record<PlaybackStream, StreamState>;
  // 音声の jitter buffer の目標遅延 (NetEq と同じ規則)
  private readonly audioDelayManager: AudioDelayManager;
  // 同期の制御が各トラックへ足した遅延 (ミリ秒)。0 以上
  private syncExtraMs: Record<PlaybackStream, number> = { audio: 0, video: 0 };
  // 直前に同期の制御を行った時刻 (ミリ秒)。まだ行っていなければ null
  private lastSyncMs: number | null = null;
  // 基準を共有しないと決めた直近の時刻と、そのときの側 (ミリ秒、トラック)。往復を防ぐ
  private lastUnsharedAtMs: number | null = null;
  private lastUnsharedStream: PlaybackStream | null = null;
  // 直前に同期の制御に使った「自分の遅延の下限」(ミリ秒)。下げる速さの残りを求めるために持つ
  private lastOwnFloorMs: Record<PlaybackStream, number> | null = null;
  // 2 つのトラックの基準の差の直近の履歴 (ミリ秒)。差が動き続けていれば時計のずれである
  private readonly baseDifferences = new TimedValues();
  // 直前に基準の差を記録した時刻 (ミリ秒)。まだ記録していなければ null
  private lastBaseDifferenceAtMs: number | null = null;
  // 直前に記録した基準の差 (ミリ秒)。履歴と同じ求め方であり、動きの今側の値になる
  private lastBaseDifferenceValue: number | null = null;
  private targetLatencyValue: number | null = null;
  private limitedValue = 0;
  private generationValue = 0;
  private audioPresentation: PresentationRecord | null = null;
  private videoPresentation: PresentationRecord | null = null;

  constructor(options: PlaybackTimelineOptions) {
    this.timeOriginMs = options.timeOriginMs;
    this.maxQueuedFrames = options.maxQueuedFrames;
    this.maxPresentationDelayMs = options.maxPresentationDelayMs ?? MAX_PLAYOUT_DELAY_MS;
    this.audioDelayManager = new AudioDelayManager(options.audioDelay);
    this.streams = {
      audio: this.createStreamState(),
      video: this.createStreamState(),
    };
  }

  /**
   * 復号の出力の到着を記録する (音声と映像の両方から呼ぶ)
   *
   * @param stream - 音声か映像
   * @param wallClockMs - 復号の出力の時刻 (Unix epoch ミリ秒。
   *   呼び出し側が `performance.timeOrigin + performance.now()` を渡す)
   * @param timestampMicros - 復号の出力の TIMESTAMP (Unix epoch マイクロ秒)
   */
  observe(stream: PlaybackStream, wallClockMs: number, timestampMicros: number): void {
    const current = this.streams[stream];
    const timestampMs = timestampMicros / 1_000;
    const offsetMs = wallClockMs - timestampMs;
    if (
      current.baseMs !== null &&
      Math.abs(offsetMs - current.baseMs) >= PLAYBACK_DISCONTINUITY_MS
    ) {
      // 共有の時間軸ごと取り直す。両方のトラックが同じだけ動くため同期は保たれる
      this.reset();
    }
    // reset で作り直されているため、取り直した後の状態を使う
    const state = this.streams[stream];

    // 最初のフレームと、まとまって届いたフレームは再生遅延の目標に使わない
    let learns = false;
    if (state.lastTimestampMs !== null && state.lastArrivalMs !== null) {
      const intervalMs = timestampMs - state.lastTimestampMs;
      if (intervalMs > 0) {
        state.frameIntervals.push(intervalMs);
        if (state.frameIntervals.length > FRAME_INTERVAL_SAMPLES) {
          state.frameIntervals.shift();
        }
      }
      learns = wallClockMs - state.lastArrivalMs >= intervalMs / 2;
    }
    state.lastTimestampMs = timestampMs;
    state.lastArrivalMs = wallClockMs;

    const minAtMs = wallClockMs - PLAYBACK_WINDOW_MS;
    state.offsets.push(wallClockMs, offsetMs);
    state.offsets.prune(minAtMs);
    const window = state.offsets.current();
    if (window.length === 0) {
      // 窓の外の観測だけになった (呼び出し側が時刻を戻したなど)。基準は更新しない
      return;
    }
    const baseMs = Math.min(...window);
    state.baseMs = baseMs;
    this.recordBaseDifference(wallClockMs);

    if (stream === "audio") {
      // 音声の表示の遅れは NetEq と同じ規則で求める (到着の遅れの 0.95 分位)
      this.audioDelayManager.observe(wallClockMs, timestampMs);
      state.delayMs = this.audioDelayManager.targetDelayMs;
    } else {
      // 映像の表示の遅れは、遅れの揺らぎの百分位から求める
      // live に追いつくまでに届いたフレームの遅れは経路の揺らぎではない
      if (learns && !this.isCatchingUp(state, wallClockMs, baseMs)) {
        state.learningOffsets.push(wallClockMs, offsetMs);
      }
      state.learningOffsets.prune(minAtMs);

      const frameIntervalMs = this.frameIntervalMs(state);
      const capMs = this.delayCapMs(frameIntervalMs);
      // 再生遅延の上限を超える揺らぎは吸収できないため目標に使わない
      const jitters = state.learningOffsets
        .current()
        .map((offset) => offset - baseMs)
        .filter((jitter) => jitter <= MAX_PLAYOUT_DELAY_MS)
        .sort((a, b) => a - b);
      const targetMs = Math.min(
        percentile(jitters, playoutDelayPercentile(frameIntervalMs)),
        capMs,
      );
      if (state.delayMs === null || targetMs >= state.delayMs) {
        state.delayMs = targetMs;
      } else {
        const elapsedMs = Math.max(0, wallClockMs - state.lastUpdateMs);
        const decayedMs = state.delayMs - (PLAYBACK_DELAY_DECAY_MS_PER_SECOND * elapsedMs) / 1_000;
        // フレーム間隔が短くなって上限が下がったときは、上限まで直ちに下げる
        state.delayMs = Math.min(Math.max(targetMs, decayedMs), capMs);
      }
      state.lastUpdateMs = wallClockMs;
    }

    this.updateSyncDelays(wallClockMs);
    this.updateLimitedMs();
  }

  /**
   * 使う `targetLatency` を決める (ミリ秒。使わないときは null)
   *
   * 同じ render group の track は同じ値でなければならない (draft-ietf-moq-msf-01 §5.2.8)
   * ため、音声と映像で 1 つの値を使う。解決の規則は呼び出し側が持ち、ここへは確定した
   * 値だけを渡す。値は同期の基準の遅延になり、2 つのトラックの表示の遅れの下限になる。
   */
  setTargetLatencyMs(value: number | null): void {
    this.targetLatencyValue = value;
    // 基準の遅延は 2 つのトラックの表示の遅れの下限になる。片方だけがこの下限に当たる
    // ことがあるため、差が開いていればその場で合わせ直す (次の観測を待つと、その間だけ
    // 表示時刻の差が開いたままになる)。戻す向きは毎秒の速さに限るため、ここでは足す
    // 向きだけを直す
    const naturalMs = this.syncNaturalPresentationMs();
    if (naturalMs !== null) {
      this.alignSyncExtras(naturalMs);
    }
    this.updateLimitedMs();
  }

  /** 使っている `targetLatency` (ミリ秒)。無い、または使わないときは null */
  get targetLatencyMs(): number | null {
    return this.targetLatencyValue;
  }

  /** 上限に収まらず切り下げた分 (ミリ秒) */
  get targetLatencyLimitedMs(): number {
    return this.limitedValue;
  }

  /**
   * 映像の表示の遅れ (ミリ秒)。TIMESTAMP から表示時刻までの差で、時計のずれの分だけ
   * 負にもなる。映像を観測していなければ音声の値、どちらも無ければ null
   */
  get presentationDelayMs(): number | null {
    return this.presentationDelayMsOf("video") ?? this.presentationDelayMsOf("audio");
  }

  /**
   * トラックの表示の遅れ (ミリ秒)。TIMESTAMP から表示時刻までの差。まだ基準が無い、
   * またはそのトラックがずれた側 (TIMESTAMP を使わない) ときは null
   */
  presentationDelayFor(stream: PlaybackStream): number | null {
    return this.presentationDelayMsOf(stream);
  }

  /**
   * 音声の jitter buffer の遅延 (ミリ秒)。自分の揺らぎだけから求めた値である。まだ観測して
   * いなければ null
   *
   * 壁時計の TIMESTAMP を持たない音を到着基準で並べるときの再生の遅れに使う。`targetLatency`
   * と同期の制御による下限は含まない (`presentationExtraDelayMs` を使う)
   */
  get playoutDelayMs(): number | null {
    const ownDelayMs = this.streams.audio.delayMs;
    if (ownDelayMs === null) {
      return null;
    }
    return Math.min(ownDelayMs, this.presentationDelayCapMs());
  }

  /**
   * 音声の表示の遅れのうち、基準の遅れを除いた分 (ミリ秒)。自分の揺らぎと `targetLatency` の
   * 大きい方に同期の制御が足した分を加えた値であり、上限で切る。まだ観測していなければ null
   *
   * 音声の並べすぎの上限は、この値と揺らぎから求めた値の大きい方から決める
   */
  get presentationExtraDelayMs(): number | null {
    return this.delayMsOf("audio");
  }

  /**
   * 音声の jitter buffer の遅延 (ミリ秒)。`targetLatency` と同期の制御が足した分を含む。
   * まだ観測していなければ null
   */
  get audioDelayMs(): number | null {
    return this.delayMsOf("audio");
  }

  /**
   * 映像の jitter buffer の遅延 (ミリ秒)。映像の表示待ちのキューが保持する長さである。
   * `targetLatency` と同期の制御が足した分を含む。まだ観測していなければ null
   */
  get videoDelayMs(): number | null {
    return this.delayMsOf("video");
  }

  /**
   * 目標の表示時刻 (Unix epoch マイクロ秒)
   *
   * @returns 表示時刻。このトラックの TIMESTAMP を使わない (基準がまだ無い) ときは null
   */
  presentationWallClockMicros(stream: PlaybackStream, timestampMicros: number): bigint | null {
    const delayMs = this.presentationDelayMsOf(stream);
    if (delayMs === null) {
      return null;
    }
    return BigInt(Math.round(timestampMicros + delayMs * 1_000));
  }

  /**
   * 目標の表示時刻 (`performance.now()` のミリ秒)
   *
   * @returns 表示時刻。このトラックの TIMESTAMP を使わないときは null
   */
  presentationPerformanceMs(stream: PlaybackStream, timestampMicros: number): number | null {
    const wallClockMicros = this.presentationWallClockMicros(stream, timestampMicros);
    if (wallClockMicros === null) {
      return null;
    }
    return Number(wallClockMicros) / 1_000 - this.timeOriginMs;
  }

  /**
   * 表示した (鳴らすと決めた) 実績を記録する
   *
   * @param stream - 音声か映像
   * @param timestampMicros - 表示した TIMESTAMP (Unix epoch マイクロ秒)
   * @param presentedWallClockMicros - 実際に表示する (鳴らす) 時刻 (Unix epoch マイクロ秒)
   */
  recordPresentation(
    stream: PlaybackStream,
    timestampMicros: number,
    presentedWallClockMicros: bigint,
  ): void {
    const record: PresentationRecord = {
      timestampMicros,
      presentedWallClockMicros,
      atMs: Number(presentedWallClockMicros) / 1_000 - this.timeOriginMs,
    };
    if (stream === "audio") {
      this.audioPresentation = record;
    } else {
      this.videoPresentation = record;
    }
  }

  /**
   * 同期ずれの推定値 (ミリ秒)。映像の表示が音声より遅れていれば正
   *
   * 直近に表示した音声と映像それぞれの「表示時刻 - TIMESTAMP」の差を取る。両方が
   * `SKEW_SAMPLE_WINDOW_MS` 以内の実績を持つときだけ値を返す。捨てた音と write しなかった
   * フレームは実績に含めないため、捨てが続くと実績が古くなり null になる。
   */
  skewMs(): number | null {
    const audio = this.audioPresentation;
    const video = this.videoPresentation;
    if (audio === null || video === null) {
      return null;
    }
    const nowMs = Math.max(audio.atMs, video.atMs);
    if (nowMs - audio.atMs > SKEW_SAMPLE_WINDOW_MS || nowMs - video.atMs > SKEW_SAMPLE_WINDOW_MS) {
      return null;
    }
    const audioOffsetMs =
      Number(audio.presentedWallClockMicros) / 1_000 - audio.timestampMicros / 1_000;
    const videoOffsetMs =
      Number(video.presentedWallClockMicros) / 1_000 - video.timestampMicros / 1_000;
    return videoOffsetMs - audioOffsetMs;
  }

  /**
   * 2 つのトラックで基準を共有しているか
   *
   * 共有できないのは、どちらかをまだ観測していないときと、基準の差が
   * 「遅い側を待つ」ことで合わせられないときである (差が表示の遅れの上限を超えている、
   * または差が動き続けている = TIMESTAMP が壁時計からずれている)。理由は
   * `delayBreakdown` の `unsharedReason` に出る
   */
  get sharingBases(): boolean {
    return this.unsharedReason() === "none";
  }

  /**
   * 音声と映像の遅延の内訳 (遅延の解析に使う)
   *
   * 「表示の遅れがどこで生じているか」と「2 つのトラックを同じ時計として扱えているか」を
   * 1 つの値にまとめる。表示時刻そのものは `presentationPerformanceMs` が返す。
   */
  get delayBreakdown(): PlaybackDelayBreakdown {
    return {
      audio: this.trackBreakdownOf("audio"),
      video: this.trackBreakdownOf("video"),
      baseDifferenceMs: this.currentBaseDifferenceMs(),
      sharingBases: this.sharingBases,
      unsharedReason: this.unsharedReason(),
      baseDriftMsPerSecond: this.baseDriftMsPerSecond(),
      baseDriftLimitMs: PLAYOUT_BASE_DRIFT_MS,
      presentationDelayCapMs: this.presentationDelayCapMs(),
    };
  }

  /**
   * 基準を共有できていない理由
   *
   * 未観測 (どちらかの基準か表示の遅れがまだ無い) を先に見る。差と動きの判定は基準が
   * そろってから意味を持つ (差が 0 であるとも、動きが無いとも言えない)。動きは差より
   * 先に見る。動き続けている差は経路の遅れではなく時計のずれであり、合わせることを
   * やめる原因そのものであるため、差の大きさより先に知りたい
   */
  private unsharedReason(): PlaybackUnsharedReason {
    const audio = this.streams.audio;
    const video = this.streams.video;
    if (
      audio.baseMs === null ||
      video.baseMs === null ||
      audio.delayMs === null ||
      video.delayMs === null
    ) {
      return "unobserved";
    }
    if (this.baseDifferenceDrifted()) {
      return "drift";
    }
    if (Math.abs(this.currentBaseDifferenceMs() ?? 0) > this.baseDifferenceLimitMs()) {
      return "difference";
    }
    // 直前にやめた判定を保持している (閾値が動いても往復させない)
    return this.heldUnsharedStream() === null ? "none" : "hold";
  }

  /** 直近の基準の差の動き (ミリ秒 / 秒)。まだ履歴が無ければ null */
  private baseDriftMsPerSecond(): number | null {
    const history = this.baseDifferenceHistory();
    if (history === null || history.spanMs <= 0) {
      return null;
    }
    return (history.movementMs * 1_000) / history.spanMs;
  }

  /** トラックごとの表示時刻の内訳 */
  private trackBreakdownOf(stream: PlaybackStream): PlaybackTrackBreakdown {
    return {
      baseDelayMs: this.streams[stream].baseMs,
      jitterDelayMs: this.streams[stream].delayMs,
      syncExtraDelayMs: this.syncExtraMs[stream],
      presentationDelayMs: this.presentationDelayMsOf(stream),
      presentationDelayCapMs: this.presentationDelayCapMs(),
    };
  }

  /**
   * 2 つのトラックの基準の差を記録する (`BASE_DIFFERENCE_SAMPLE_INTERVAL_MS` ごと)
   *
   * 差が動き続けているかを見るために使う (`baseDifferenceDrifted`)。記録するのは窓全体の
   * 最小値ではなく短い区間の最小値である。窓全体の最小値は、TIMESTAMP が壁時計から
   * 遅れていくときも窓が埋まるまで動かないため、動きを早く見つけられない
   */
  private recordBaseDifference(nowMs: number): void {
    if (
      this.lastBaseDifferenceAtMs !== null &&
      nowMs - this.lastBaseDifferenceAtMs < BASE_DIFFERENCE_SAMPLE_INTERVAL_MS
    ) {
      return;
    }
    const audioMs = this.recentBaseMs("audio", nowMs);
    const videoMs = this.recentBaseMs("video", nowMs);
    if (audioMs === null || videoMs === null) {
      return;
    }
    this.lastBaseDifferenceAtMs = nowMs;
    this.lastBaseDifferenceValue = audioMs - videoMs;
    this.baseDifferences.push(nowMs, this.lastBaseDifferenceValue);
    this.baseDifferences.prune(nowMs - PLAYOUT_BASE_DRIFT_WINDOW_MS);
  }

  /**
   * 直近の基準 (ミリ秒。まだ観測していなければ null)
   *
   * 窓全体の最小値 (`baseMs`) ではなく `BASE_DIFFERENCE_RECENT_WINDOW_MS` の最小値である。
   * 基準が単調に動いているとき、窓全体の最小値は最も古い観測を指したままになるため
   */
  private recentBaseMs(stream: PlaybackStream, nowMs: number): number | null {
    return this.streams[stream].offsets.minAfter(nowMs - BASE_DIFFERENCE_RECENT_WINDOW_MS);
  }

  /**
   * 基準の差が動き続けているか (時計がずれているとみなすか)
   *
   * 窓の中の最も古い記録と今の差を比べる。差が大きいだけでは動きとみなさないため、
   * 同期の制御で合わせられる差 (経路と復号の遅い側) を時計のずれと誤判定しない
   */
  private baseDifferenceDrifted(): boolean {
    const history = this.baseDifferenceHistory();
    if (history === null) {
      return false;
    }
    return Math.abs(history.movementMs) > PLAYOUT_BASE_DRIFT_MS;
  }

  /**
   * 基準の差の履歴の、最も古い記録から今までの動き (遅延の解析に使う)
   *
   * 履歴の値と今の差は同じ求め方 (直近の窓の最小値の差) でなければ比べられない。
   * 窓全体の最小値と比べると、TIMESTAMP が遅れていくときに符号が逆になる
   *
   * @returns 動いた幅 (ミリ秒) と、その幅を測った時間 (ミリ秒)。まだ記録が無ければ null
   */
  private baseDifferenceHistory(): { movementMs: number; spanMs: number } | null {
    const oldest = this.baseDifferences.oldest();
    if (oldest === null || this.lastBaseDifferenceValue === null) {
      return null;
    }
    return {
      movementMs: this.lastBaseDifferenceValue - oldest.value,
      spanMs: this.lastBaseDifferenceAtMs === null ? 0 : this.lastBaseDifferenceAtMs - oldest.atMs,
    };
  }

  /** 今の「音声の基準 - 映像の基準」(ミリ秒)。どちらかを観測していなければ null */
  private currentBaseDifferenceMs(): number | null {
    const audioBase = this.streams.audio.baseMs;
    const videoBase = this.streams.video.baseMs;
    if (audioBase === null || videoBase === null) {
      return null;
    }
    return audioBase - videoBase;
  }

  /**
   * 1 つのトラックの基準と学習と実績だけを消す。世代は進めない
   *
   * 音声の再生を止めたときなど、そのトラックを観測していない状態に戻す。表示時刻の式は
   * 残ったトラックの値だけで決まるようになる。世代を進めると、既に積んでいる映像フレームの
   * 表示時刻が決められなくなり、到着順に落ちてしまう
   *
   * 同期が足していた分は即座に 0 に戻す。残ったトラックの表示時刻が前に動くため、その
   * トラックのキューに積んだフレームは表示時刻を過ぎ、最新の 1 枚以外が捨てられ得る。
   * 消えたトラックの遅延を引きずり続けるより、この副作用を受け入れる
   */
  resetStream(stream: PlaybackStream): void {
    this.streams[stream] = this.createStreamState();
    if (stream === "audio") {
      this.audioPresentation = null;
      this.audioDelayManager.reset();
    } else {
      this.videoPresentation = null;
    }
    // 同期の制御の状態も、そのトラックの観測が無い状態に戻す。基準の遅延
    // (targetLatency) は呼び出し側が決めた値であり、残す。もう片方に足した分は、消した
    // トラックとの差を合わせるためのものなので残さない (残すと、消えたトラックの遅延を
    // 引きずり続ける)
    this.syncExtraMs = { audio: 0, video: 0 };
    this.lastSyncMs = null;
    this.lastOwnFloorMs = null;
    // 基準の差の履歴も消す (片方の基準が無い状態の差に意味は無い)
    this.baseDifferences.clear();
    this.lastBaseDifferenceAtMs = null;
    this.lastBaseDifferenceValue = null;
    // 学習を消すとキューの上限 (フレーム間隔) も変わるため、切り下げた分を取り直す
    this.updateLimitedMs();
  }

  /** 基準と学習をすべて消す。次の観測で作り直す (TIMESTAMP の飛び、購読のやり直し) */
  reset(): void {
    this.generationValue += 1;
    for (const stream of ["audio", "video"] as const) {
      this.resetStream(stream);
    }
  }

  /**
   * 基準を取り直した回数
   *
   * 取り直すと、それより前に積んだフレームの表示時刻は新しい基準では決められない
   * (飛びの分だけ未来になる)。積む側が世代を見て、古いフレームを到着順に扱えるようにする。
   */
  get generation(): number {
    return this.generationValue;
  }

  private createStreamState(): StreamState {
    return {
      offsets: new TimedValues(),
      learningOffsets: new TimedValues(),
      baseMs: null,
      delayMs: null,
      lastArrivalMs: null,
      lastTimestampMs: null,
      lastUpdateMs: 0,
      frameIntervals: [],
      catchingUp: true,
      catchUpCheckpoint: null,
    };
  }

  /**
   * 2 つのトラックの表示時刻の差を不感帯に収める (観測のたびに行う)
   *
   * 表示時刻は「基準の遅れ + 表示の遅れ」であり、2 つのトラックの差はこの和の差である。
   * したがって合わせる量は「下限を外した表示の遅れ」の差そのものであり、経路の相対遅延
   * (直近の観測の offset) ではない。直近の観測を使うと、観測のたびに動く揺らぎがそのまま
   * 制御量に入り、表示時刻の差を合わせられない。また、合わせる量はどちらのトラックも
   * 平滑化した値 (NetEq の目標遅延と揺らぎの百分位) であり、到着の揺らぎは入らないため、
   * 間隔を空けずに観測のたびに行ってよい
   *
   * - ずれが `SYNC_MIN_DELTA_MS` を超えたら、先行する側へ下限を足して「後行側 - 不感帯」に
   *   合わせる。足すのは即座に行う。遅らせる向きの変更は、既に積んだフレームの表示時刻を
   *   未来へ動かすだけで、並べ替えは起きないためである。観測のたびに行うのは、相手の
   *   目標遅延が段差で動いたときに、次の観測までの間ずれが開くのを防ぐためである
   * - 足した分は、下限を外した表示の遅れから決まる目標へ毎秒
   *   `PLAYBACK_DELAY_DECAY_MS_PER_SECOND` までで戻す。両側を同じ速さで戻すため、戻して
   *   いる間もずれは開かない (片側だけ戻すと、その分だけずれが開いて、また足し戻される)
   * - 映像を下げる速さをこの速さに限るのは、表示待ちのキューが急に縮むと、積んだフレームが
   *   一斉に表示時刻を過ぎ、最新の 1 枚以外が間に合わなかったフレームとして捨てられるため
   *   である。自分の遅延の下限が同時に下がっているときは、その分だけ足した分を戻す量を
   *   減らす
   * - 音声と映像の両方を観測していて、基準の差が閾値の中にあるときだけ行う。TIMESTAMP が
   *   壁時計からずれているトラックがあると、ずれが単調に増えて、もう片方の表示が未来へ
   *   伸びてしまうためである
   */
  private updateSyncDelays(nowMs: number): void {
    const naturalMs = this.syncNaturalPresentationMs();
    if (naturalMs === null) {
      // 2 つのトラックの基準を共有できない (基準がずれている、またはまだ観測していない)。
      // 合わせる相手がいないため、足した分を自分の基準だけの表示時刻へ戻す。戻さないと、
      // ずれたトラックへ合わせて足した分がそのまま残り (観測のたびに増え続けて上限で
      // 頭打ちになる)、その分だけ 2 つの表示時刻が離れたままになる
      this.decaySyncExtras(nowMs, () => 0);
      return;
    }

    // 1) ずれを不感帯に収める (先行する側へ足す。即座に行う)
    this.alignSyncExtras(naturalMs);

    // 2) 足した分を目標へ戻す (毎秒の速さまで。自分の下限が下がった分だけ減らす。
    //    観測の間隔で按分するため、観測が疎でも速さは変わらない)
    const targetExtraMs = this.targetExtraMsOf(naturalMs);
    this.decaySyncExtras(nowMs, (stream) => targetExtraMs[stream]);

    // 3) 戻した後のずれをもう一度そろえる (片側だけ戻すと、その分だけずれが開く)
    this.alignSyncExtras(naturalMs);
  }

  /**
   * 足した分を目標へ戻す (毎秒 `PLAYBACK_DELAY_DECAY_MS_PER_SECOND` まで)
   *
   * 観測の間隔で按分するため、観測が疎でも速さは変わらない。自分の遅延の下限が同時に
   * 下がっているときは、その分だけ戻す量を減らす (下限が下がるだけでも表示時刻は前に
   * 動くため、戻しすぎると不感帯を通り越す)
   *
   * @param nowMs - 今の時刻 (ミリ秒)
   * @param targetExtraMs - トラックごとの、戻す先の足した分 (ミリ秒)
   */
  private decaySyncExtras(nowMs: number, targetExtraMs: (stream: PlaybackStream) => number): void {
    const previousSyncMs = this.lastSyncMs;
    this.lastSyncMs = nowMs;
    const elapsedMs = previousSyncMs === null ? 0 : Math.max(0, nowMs - previousSyncMs);
    const budgetMs = (PLAYBACK_DELAY_DECAY_MS_PER_SECOND * elapsedMs) / 1_000;
    for (const stream of ["audio", "video"] as const) {
      const ownDecreaseMs =
        this.lastOwnFloorMs === null
          ? 0
          : Math.max(0, this.lastOwnFloorMs[stream] - (this.naturalDelayMsOf(stream) ?? 0));
      const allowedMs = Math.max(0, budgetMs - ownDecreaseMs);
      const excessMs = this.syncExtraMs[stream] - targetExtraMs(stream);
      this.syncExtraMs[stream] -= Math.min(allowedMs, Math.max(0, excessMs));
    }
    // 次の制御で「自分の下限が下がった分」を求めるために、今の下限を残す
    this.lastOwnFloorMs = {
      audio: this.naturalDelayMsOf("audio") ?? 0,
      video: this.naturalDelayMsOf("video") ?? 0,
    };
  }

  /**
   * ずれが不感帯を超えていれば、先行する側へ足す遅延を増やして合わせる
   *
   * 後行側の表示時刻から `SYNC_MIN_DELTA_MS` だけ手前へ寄せる。既に足している分は
   * 減らさない (減らすのは `updateSyncDelays` の目標へ戻す処理だけにする)。
   *
   * @param naturalMs - 同期が足した分を除いた、トラックごとの表示の遅れ (ミリ秒)
   */
  private alignSyncExtras(naturalMs: Record<PlaybackStream, number>): void {
    const audioMs = naturalMs.audio + this.syncExtraMs.audio;
    const videoMs = naturalMs.video + this.syncExtraMs.video;
    // 目標の差は足した分を含まない素の値から決める
    const targetMs = Math.max(audioMs, videoMs) - this.desiredDifferenceMs(naturalMs);
    if (audioMs < targetMs) {
      this.syncExtraMs.audio = targetMs - naturalMs.audio;
    } else if (videoMs < targetMs) {
      this.syncExtraMs.video = targetMs - naturalMs.video;
    }
  }

  /**
   * 同期の制御で目指す、2 つのトラックの表示時刻の差 (ミリ秒)
   *
   * 不感帯 (`SYNC_MIN_DELTA_MS`) に収める。ただし合わせる量は
   * `PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS` までにする。それを超える差は経路の遅れでは
   * なく TIMESTAMP の時計のずれであることが多く、合わせても実際のずれは減らないまま
   * 相手側の表示の遅れだけが伸びるためである。時計のずれの証拠 (`baseDifferenceDrifted`)
   * を見たかどうかに関わらず常に掛ける。証拠を見る前に 600 ms の段差を合わせて映像を
   * 500 ms 遅らせた実測があるためである。差は「足した分を含まない素の値」から決める。
   * 今の値から決めると、足すたびに目標が上がり続けて上限まで届くまで足してしまう
   */
  private desiredDifferenceMs(naturalMs: Record<PlaybackStream, number>): number {
    const differenceMs = Math.abs(naturalMs.audio - naturalMs.video);
    return Math.max(SYNC_MIN_DELTA_MS, differenceMs - PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS);
  }

  /**
   * 2 つのトラックの遅れが目標の差になるために、先行する側へ足す分 (ミリ秒)
   *
   * 素の値で先行する側 (小さい方) へ、後行側から `desiredDifferenceMs` だけ手前になるまで
   * の分を足す。戻す向きは `updateSyncDelays` の減衰だけが行う
   */
  private targetExtraMsOf(
    naturalMs: Record<PlaybackStream, number>,
  ): Record<PlaybackStream, number> {
    const desiredMs = this.desiredDifferenceMs(naturalMs);
    if (naturalMs.audio <= naturalMs.video) {
      return {
        audio: Math.max(0, naturalMs.video - desiredMs - naturalMs.audio),
        video: 0,
      };
    }
    return {
      audio: 0,
      video: Math.max(0, naturalMs.audio - desiredMs - naturalMs.video),
    };
  }

  /**
   * トラックの表示の遅れ (ミリ秒)。TIMESTAMP から表示時刻までの差であり、基準の遅れと
   * jitter buffer の遅延の和。まだ基準が無ければ null
   */
  private presentationDelayMsOf(stream: PlaybackStream): number | null {
    const state = this.streams[stream];
    if (state.baseMs === null) {
      return null;
    }
    // 基準が大きく離れているときは、大きい方のトラックの TIMESTAMP は壁時計からずれて
    // いるとみなし、表示時刻を返さない (使う側が到着基準の再生へフォールバックする)。
    // 表示時刻を返すと、ずれた分だけ未来の時刻になり、そのトラックがすべて捨てられる
    if (this.driftedStream() === stream) {
      return null;
    }
    const delayMs = this.delayMsOf(stream);
    if (delayMs === null) {
      return null;
    }
    return state.baseMs + delayMs;
  }

  /**
   * トラックの jitter buffer の遅延 (ミリ秒)。自分の揺らぎから求めた値と `targetLatency` の
   * 大きい方に、同期の制御が足した分を加えた値であり、上限 (`presentationDelayCapMs`) で
   * 切る。映像をまだ観測していなければ null
   */
  private delayMsOf(stream: PlaybackStream): number | null {
    const uncappedMs = this.uncappedDelayMsOf(stream);
    if (uncappedMs === null) {
      return null;
    }
    return Math.min(uncappedMs, this.presentationDelayCapMs());
  }

  /**
   * 上限を掛ける前の jitter buffer の遅延 (ミリ秒)
   *
   * 同期が足した分を含む。観測が無ければ null
   */
  private uncappedDelayMsOf(stream: PlaybackStream): number | null {
    const naturalMs = this.naturalDelayMsOf(stream);
    if (naturalMs === null) {
      return null;
    }
    // 同期が足した分は、自分の下限の上に乗る
    return naturalMs + this.syncExtraMs[stream];
  }

  /**
   * 基準を共有できないトラック。無ければ null (共有している)
   *
   * 次のどちらかで共有できないと判定する。どちらの場合も、遅い側へ合わせて足した分は
   * `updateSyncDelays` が戻す。
   *
   * - 2 つのトラックの基準の差が、表示の遅れの上限 (`presentationDelayCapMs`) から、
   *   同期が足した分を含まない表示の遅れを引いた閾値を超えている。上限で切られる分は
   *   合わせられないため、同期の制御では足りない (キューが保持する時間は「表示時刻 -
   *   復号の出力時刻」= 2 つのトラックの基準の差 + 表示の遅れであり、基準の遅れそのものは
   *   含まない)
   * - 基準の差が動き続けている (`baseDifferenceDrifted`)。これは経路の遅れではなく
   *   TIMESTAMP の時計のずれであり、合わせると片側の表示の遅れが上限まで伸びる
   *
   * 大きい側 (遅れて届いている側) が、TIMESTAMP が壁時計からずれている側である
   */
  private driftedStream(): PlaybackStream | null {
    const difference = this.currentBaseDifferenceMs();
    if (difference === null) {
      return null;
    }
    const stream: PlaybackStream = difference > 0 ? "audio" : "video";
    if (Math.abs(difference) > this.baseDifferenceLimitMs() || this.baseDifferenceDrifted()) {
      this.lastUnsharedAtMs = this.lastBaseDifferenceAtMs;
      this.lastUnsharedStream = stream;
      return stream;
    }
    return this.heldUnsharedStream();
  }

  /**
   * 直前に共有をやめた側。保持の時間 (`PLAYOUT_BASE_UNSHARED_HOLD_MS`) を過ぎていれば null
   *
   * 閾値は jitter buffer の目標遅延で動くため、差が変わらなくても共有と解除を往復し得る。
   * 往復のたびに、足した分を戻して (フレームを捨てる) すぐ足し直す (表示が止まる) ため、
   * 一度やめたらしばらくは戻さない
   */
  private heldUnsharedStream(): PlaybackStream | null {
    if (
      this.lastUnsharedStream === null ||
      this.lastUnsharedAtMs === null ||
      this.lastBaseDifferenceAtMs === null ||
      this.lastBaseDifferenceAtMs - this.lastUnsharedAtMs >= PLAYOUT_BASE_UNSHARED_HOLD_MS
    ) {
      return null;
    }
    return this.lastUnsharedStream;
  }

  /**
   * 2 つのトラックの基準の差の閾値 (ミリ秒)
   *
   * 表示の遅れの上限 (`presentationDelayCapMs`) から、同期が足した分を含まない表示の遅れ
   * (2 つのトラックの大きい方) を引いた値である。上限で切られる分は合わせられないため、
   * キューが吸収できる長さではなく上限から引く。下限を置くのは、閾値が 0 に近いと同期の
   * 制御と解除を往復するため
   */
  private baseDifferenceLimitMs(): number {
    // 同期が足した分は含めない。含めると、合わせるために遅らせた結果で閾値が下がり、
    // 合わせた直後に「基準がずれている」と判定されてしまう。
    // 引くのは表示の遅れの上限 (`presentationDelayCapMs`) である。キューが吸収できる
    // 長さを使うと、上限で切られる分だけ実際には合わせられない差を「共有できる」と
    // 誤判定し、合わせ残しが不感帯を超える
    const delayMs = Math.max(
      this.naturalDelayMsOf("audio") ?? 0,
      this.naturalDelayMsOf("video") ?? 0,
    );
    return Math.max(PLAYOUT_BASE_MAX_DIFFERENCE_MIN_MS, this.presentationDelayCapMs() - delayMs);
  }

  /**
   * 同期の制御に使う、トラックごとの「同期が足した分を除いた表示の遅れ」(ミリ秒)
   *
   * 基準の遅れと、同期が足した分を除いた表示の遅れ (自分の jitter buffer の遅延と
   * `targetLatency` の大きい方) の和である。2 つのトラックのこの値の差が、同期で
   * 合わせる対象になる。どちらかが未観測、または基準がずれているときは null
   */
  private syncNaturalPresentationMs(): Record<PlaybackStream, number> | null {
    const audio = this.streams.audio;
    const video = this.streams.video;
    const audioDelayMs = this.naturalDelayMsOf("audio");
    const videoDelayMs = this.naturalDelayMsOf("video");
    if (audioDelayMs === null || videoDelayMs === null) {
      return null;
    }
    if (audio.baseMs === null || video.baseMs === null) {
      return null;
    }
    if (this.driftedStream() !== null) {
      // TIMESTAMP が壁時計からずれているトラックがある。同期の制御は行わない
      return null;
    }
    return { audio: audio.baseMs + audioDelayMs, video: video.baseMs + videoDelayMs };
  }

  /**
   * 同期が足した分を含まない、トラックの表示の遅れの下限 (ミリ秒)
   *
   * 自分の jitter buffer の遅延と `targetLatency` の大きい方である。観測が無ければ null
   */
  private naturalDelayMsOf(stream: PlaybackStream): number | null {
    const ownDelayMs = this.streams[stream].delayMs;
    if (ownDelayMs === null) {
      return null;
    }
    return Math.max(ownDelayMs, Math.max(0, this.targetLatencyValue ?? 0));
  }

  /** 上限に収まらず切り下げた分を更新する */
  private updateLimitedMs(): void {
    if (this.targetLatencyValue === null) {
      // targetLatency を使っていないときは切り下げも起きない
      this.limitedValue = 0;
      return;
    }
    this.limitedValue = Math.max(0, this.targetLatencyValue - this.presentationDelayCapMs());
  }

  /** 表示の遅れの上限 (ミリ秒) */
  private presentationDelayCapMs(): number {
    return Math.min(this.maxPresentationDelayMs, this.queueCapMs());
  }

  /** キューが吸収できる表示の遅れ (ミリ秒) */
  private queueCapMs(): number {
    return playoutQueueCapMs(this.maxQueuedFrames, this.frameIntervalMs(this.streams.video));
  }

  /**
   * 開始 (と基準の取り直し) の後、live に追いつくまでの間かを決める
   *
   * `CATCH_UP_CHECK_INTERVAL_MS` ごとに基準の遅れの下がり幅を見て、
   * `CATCH_UP_MIN_BASE_DROP_MS` より小さければ追いついたとみなす。一度追いついたら、
   * 基準を取り直すまで追いつき中に戻らない (live の経路の揺らぎは学習する)
   */
  private isCatchingUp(state: StreamState, nowMs: number, baseMs: number): boolean {
    if (!state.catchingUp) {
      return false;
    }
    const checkpoint = state.catchUpCheckpoint;
    if (checkpoint === null) {
      state.catchUpCheckpoint = { atMs: nowMs, baseMs };
      return true;
    }
    if (nowMs - checkpoint.atMs < CATCH_UP_CHECK_INTERVAL_MS) {
      return true;
    }
    if (checkpoint.baseMs - baseMs >= CATCH_UP_MIN_BASE_DROP_MS) {
      state.catchUpCheckpoint = { atMs: nowMs, baseMs };
      return true;
    }
    state.catchingUp = false;
    state.catchUpCheckpoint = null;
    return false;
  }

  /** キューの上限を超えない長さ ((上限 - 余裕) 枚分のフレーム間隔) */
  private delayCapMs(frameIntervalMs: number | null): number {
    return Math.min(
      this.maxPresentationDelayMs,
      playoutQueueCapMs(this.maxQueuedFrames, frameIntervalMs),
    );
  }

  /** 直近のフレーム間隔 (TIMESTAMP の差の中央値、ミリ秒)。まだ分からなければ null */
  private frameIntervalMs(state: StreamState): number | null {
    if (state.frameIntervals.length === 0) {
      return null;
    }
    const sorted = [...state.frameIntervals].sort((a, b) => a - b);
    return percentile(sorted, 0.5);
  }
}
