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
 * - A/V 同期: libwebrtc の `StreamSynchronization` (`src/streamSynchronization.ts`) が、
 *   2 つのトラックのずれが `SYNC_MIN_DELTA_MS` を超えたときだけ片側の遅延を動かす。ずれは
 *   「映像の遅延 - 音声の遅延 + 経路の相対遅延」であり、映像が音声よりどれだけ遅れて出るかに
 *   等しい。不感帯の中では 2 つの遅延は独立であり、映像は音声の jitter buffer の遅延に
 *   引きずられない (旧実装は 2 つの遅れの大きい方を共有し、音声の下限 80 ms が常に映像へ
 *   乗っていた)。制御は `SYNC_INTERVAL_MS` ごとに 1 回だけ行う
 * - `targetLatency` は同期の基準の遅延 (`setTargetBufferingDelay`) になり、2 つのトラックの
 *   表示の遅れの下限になる
 * - 表示の遅れの上限: `MAX_PLAYOUT_DELAY_MS` と、表示待ちのキューが吸収できる長さの
 *   小さい方を表示の遅れに掛ける。基準の遅れは送受信の時計のずれでありキューを消費しない
 *   ため、上限は掛けない
 * - 2 つのトラックの基準の差が、キューが吸収できる長さを超えたら同期しない。TIMESTAMP が
 *   壁時計からずれているトラック (0754 の音声のドリフトなど) に、もう片方を合わせないため
 *
 * ブラウザ API に依存せず、時刻は引数で受ける (`performance.now()` と
 * `performance.timeOrigin` は呼び出し側が渡す)。
 */

import { AudioDelayManager, type AudioDelayManagerOptions } from "./audioDelayManager";
import { StreamSynchronization, computeRelativeDelay } from "./streamSynchronization";
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
 * 閾値はキューが吸収できる長さから表示の遅れを引いた値になる。これが 0 に近いと、同期の
 * 制御と解除を往復して基準の学習とキューの到着順化が繰り返し起きるため、下限を置く
 */
export const PLAYOUT_BASE_MAX_DIFFERENCE_MIN_MS = 100;

/**
 * 同期の制御を行う間隔 (ミリ秒)
 *
 * libwebrtc の `video/rtp_streams_synchronizer2.cc` の `kSyncInterval` と同じ値である。
 * フレームごとに制御すると、経路の到着の揺らぎがそのまま遅延の揺れになる
 */
export const SYNC_INTERVAL_MS = 1_000;

// フレーム間隔を求めるために保持する TIMESTAMP の差の数
const FRAME_INTERVAL_SAMPLES = 32;

// 実績を同期の推定に使う期間 (ミリ秒)
const SKEW_SAMPLE_WINDOW_MS = 1_000;

/** 表示時刻を求める相手 (音声と映像) */
export type PlaybackStream = "audio" | "video";

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
  // 同期の制御に使う直近の受信時刻と、そのデータの TIMESTAMP (どちらも壁時計のミリ秒)
  latestReceiveMs: number | null;
  latestCaptureMs: number | null;
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
  // 2 つのトラックの遅延を相対的に制御する (libwebrtc の StreamSynchronization)
  private readonly synchronization = new StreamSynchronization();
  // 同期の制御が決めた各トラックの遅延の下限 (ミリ秒)
  private syncMinimumMs: Record<PlaybackStream, number> = { audio: 0, video: 0 };
  // 直前に同期の制御を行った時刻 (ミリ秒)。まだ行っていなければ null
  private lastSyncMs: number | null = null;
  // 直前に同期の制御に使った 2 つのトラックの受信時刻。どちらかが新しくなければ制御しない
  // (libwebrtc の `RtpStreamsSynchronizer::UpdateDelay` と同じ)
  private lastSyncReceiveMs: { audio: number | null; video: number | null } = {
    audio: null,
    video: null,
  };
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

    // 同期の制御に使う直近の受信時刻と TIMESTAMP を残す
    state.latestReceiveMs = wallClockMs;
    state.latestCaptureMs = timestampMs;

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
    const targetDelayMs = Math.max(0, value ?? 0);
    this.synchronization.setTargetBufferingDelay(targetDelayMs);
    // 基準の遅延は 2 つのトラックの表示の遅れの下限になる (libwebrtc の
    // SetTargetBufferingDelay と同じで、両方の遅延がこの値になる)
    this.syncMinimumMs = { audio: targetDelayMs, video: targetDelayMs };
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
   * 音声の表示の遅れのうち、基準の遅れを除いた分 (ミリ秒)。自分の揺らぎ、`targetLatency`、
   * 同期の制御が決めた下限の大きい方であり、上限で切る。まだ観測していなければ null
   *
   * 音声の並べすぎの上限は、この値と揺らぎから求めた値の大きい方から決める
   */
  get presentationExtraDelayMs(): number | null {
    return this.delayMsOf("audio");
  }

  /**
   * 音声の jitter buffer の遅延 (ミリ秒)。`targetLatency` と同期の制御が決めた下限を含む。
   * まだ観測していなければ null
   */
  get audioDelayMs(): number | null {
    return this.delayMsOf("audio");
  }

  /**
   * 映像の jitter buffer の遅延 (ミリ秒)。映像の表示待ちのキューが保持する長さである。
   * `targetLatency` と同期の制御が決めた下限を含む。まだ観測していなければ null
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

  /** 2 つのトラックで基準を共有しているか (どちらも TIMESTAMP を使えているか) */
  get sharingBases(): boolean {
    return this.driftedStream() === null;
  }

  /**
   * 1 つのトラックの基準と学習と実績だけを消す。世代は進めない
   *
   * 音声の再生を止めたときなど、そのトラックを観測していない状態に戻す。表示時刻の式は
   * 残ったトラックの値だけで決まるようになる。世代を進めると、既に積んでいる映像フレームの
   * 表示時刻が決められなくなり、到着順に落ちてしまう
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
    // (targetLatency) は呼び出し側が決めた値であり、残す
    this.syncMinimumMs = {
      audio: Math.max(0, this.targetLatencyValue ?? 0),
      video: Math.max(0, this.targetLatencyValue ?? 0),
    };
    this.lastSyncMs = null;
    this.lastSyncReceiveMs = { audio: null, video: null };
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
      latestReceiveMs: null,
      latestCaptureMs: null,
    };
  }

  /**
   * 2 つのトラックの遅延を相対的に制御する (`SYNC_INTERVAL_MS` ごとに 1 回)
   *
   * 音声と映像の両方を観測していて、基準の差が閾値の中にあるときだけ行う。TIMESTAMP が
   * 壁時計からずれているトラックがあると、ずれが単調に増えて、もう片方の表示が未来へ
   * 伸びてしまうためである。
   */
  private updateSyncDelays(nowMs: number): void {
    const audio = this.streams.audio;
    const video = this.streams.video;
    if (audio.latestReceiveMs === null || audio.latestCaptureMs === null) return;
    if (video.latestReceiveMs === null || video.latestCaptureMs === null) return;
    if (this.lastSyncMs !== null && nowMs - this.lastSyncMs < SYNC_INTERVAL_MS) return;
    if (
      this.lastSyncReceiveMs.audio === audio.latestReceiveMs ||
      this.lastSyncReceiveMs.video === video.latestReceiveMs
    ) {
      // どちらかのトラックに新しい観測が無い
      return;
    }
    this.lastSyncMs = nowMs;
    this.lastSyncReceiveMs = {
      audio: audio.latestReceiveMs,
      video: video.latestReceiveMs,
    };
    if (this.driftedStream() !== null) {
      // TIMESTAMP が壁時計からずれているトラックがある。同期の制御は行わない
      return;
    }
    const relativeDelayMs = computeRelativeDelay(
      { latestReceiveTimeMs: audio.latestReceiveMs, latestCaptureTimeMs: audio.latestCaptureMs },
      { latestReceiveTimeMs: video.latestReceiveMs, latestCaptureTimeMs: video.latestCaptureMs },
    );
    if (relativeDelayMs === null) return;
    const audioDelayMs = this.delayMsOf("audio");
    const videoDelayMs = this.delayMsOf("video");
    if (audioDelayMs === null || videoDelayMs === null) return;
    const delays = this.synchronization.computeDelays(relativeDelayMs, audioDelayMs, videoDelayMs);
    if (delays === null) return;
    this.syncMinimumMs = {
      audio: Math.max(0, delays.audioDelayMs),
      video: Math.max(0, delays.videoDelayMs),
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
   * トラックの jitter buffer の遅延 (ミリ秒)。自分の揺らぎから求めた値と、同期の制御が
   * 決めた下限の大きい方であり、上限 (`presentationDelayCapMs`) で切る。映像をまだ
   * 観測していなければ null
   */
  private delayMsOf(stream: PlaybackStream): number | null {
    const uncappedMs = this.uncappedDelayMsOf(stream);
    if (uncappedMs === null) {
      return null;
    }
    return Math.min(uncappedMs, this.presentationDelayCapMs());
  }

  /** 上限を掛ける前の jitter buffer の遅延 (ミリ秒)。観測が無ければ null */
  private uncappedDelayMsOf(stream: PlaybackStream): number | null {
    const ownDelayMs = this.streams[stream].delayMs;
    if (ownDelayMs === null) {
      return null;
    }
    return Math.max(ownDelayMs, this.syncMinimumMs[stream]);
  }

  /**
   * 基準の差が閾値を超えたトラック。無ければ null (共有している)
   *
   * 閾値はキューが吸収できる長さから表示の遅れを引いた値である。キューが保持する時間は
   * 「表示時刻 - 復号の出力時刻」= 2 つのトラックの基準の差 + 表示の遅れであり、基準の
   * 遅れそのものは含まない。
   */
  private driftedStream(): PlaybackStream | null {
    const audioBase = this.streams.audio.baseMs;
    const videoBase = this.streams.video.baseMs;
    if (audioBase === null || videoBase === null) {
      return null;
    }
    if (Math.abs(audioBase - videoBase) <= this.baseDifferenceLimitMs()) {
      return null;
    }
    return audioBase > videoBase ? "audio" : "video";
  }

  /**
   * 2 つのトラックの基準の差の閾値 (ミリ秒)
   *
   * キューが吸収できる長さから、上限を掛ける前の表示の遅れ (2 つのトラックの大きい方) を
   * 引いた値である。下限を置くのは、閾値が 0 に近いと同期の制御と解除を往復するため
   */
  private baseDifferenceLimitMs(): number {
    const delayMs = Math.max(
      this.uncappedDelayMsOf("audio") ?? 0,
      this.uncappedDelayMsOf("video") ?? 0,
    );
    return Math.max(PLAYOUT_BASE_MAX_DIFFERENCE_MIN_MS, this.queueCapMs() - delayMs);
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
