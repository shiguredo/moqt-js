/**
 * 音声と映像で共有する表示時刻の時間軸
 *
 * 同じ render group の track は同じ targetLatency を持ち (draft-ietf-moq-msf-01 §5.2.8)、
 * 同時に描画するよう設計されている (§5.2.11)。LOC の TIMESTAMP は Timescale が無ければ
 * Unix epoch マイクロ秒の壁時計である (draft-ietf-moq-loc-04 §2.3.1.1)。
 *
 * 表示時刻 = TIMESTAMP + 基準の遅れ + max(targetLatency, 再生遅延)
 *
 * - 基準の遅れ: トラックごとの「復号の出力の壁時計の時刻 - TIMESTAMP」の直近 10 秒の
 *   最小値 (ミリ秒)。受信側と送信側の時計のずれと、経路と復号の最小遅延を含む。遅れは
 *   到着ではなく復号の出力の時刻で測る (表示できる時刻には復号の時間も含まれるため)
 * - 共有の基準の遅れ: 2 つのトラックの大きい方。復号の遅い側に合わせるのが安全側であり
 *   (表示が期限より前にならない)、両方に同じ値を与えるため同期する
 * - 再生遅延: トラックごとの「遅れ - 基準の遅れ」の百分位から求めた揺らぎ。大きい方を
 *   共有し、音声は `AUDIO_PLAYOUT_DELAY_FLOOR_MS` を下限にする
 * - 表示の遅れの上限: `MAX_PLAYOUT_DELAY_MS` と、表示待ちのキューが吸収できる長さの
 *   小さい方を `max(targetLatency, 再生遅延)` に掛ける。基準の遅れは送受信の時計の
 *   ずれでありキューを消費しないため、上限は掛けない
 * - 2 つのトラックの基準の差が、キューが吸収できる長さを超えたら基準を共有しない。
 *   大きい方のトラックは TIMESTAMP が壁時計からずれているとみなして表示時刻を返さず、
 *   使う側が到着基準の再生へフォールバックする。もう片方は自分の基準を使う
 *
 * ブラウザ API に依存せず、時刻は引数で受ける (`performance.now()` と
 * `performance.timeOrigin` は呼び出し側が渡す)。
 */

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
 * 配備の relay で復号の出力の間隔は p95 約 33 ms、映像も配信しているときにまれに
 * 160 ms 前後の途切れがある (2026-09-25 の実測)。音声は途切れがノイズに聞こえるため、
 * 揺らぎから求めた遅れがこれより小さくてもこの値を下限にする
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
 * 閾値はキューが吸収できる長さから `max(targetLatency, 再生遅延)` を引いた値になる。
 * これが 0 に近いと、共有とフォールバックを往復して基準の学習とキューの到着順化が
 * 繰り返し起きるため、下限を置く
 */
export const PLAYOUT_BASE_MAX_DIFFERENCE_MIN_MS = 100;

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
  /** 音声の再生遅延の下限 (ミリ秒)。省略時は `AUDIO_PLAYOUT_DELAY_FLOOR_MS` */
  audioDelayFloorMs?: number;
  /** 表示の遅れの上限 (ミリ秒)。省略時は `MAX_PLAYOUT_DELAY_MS` */
  maxPresentationDelayMs?: number;
}

export class PlaybackTimeline {
  private readonly timeOriginMs: number;
  private readonly maxQueuedFrames: number;
  private readonly audioDelayFloorMs: number;
  private readonly maxPresentationDelayMs: number;
  private readonly streams: Record<PlaybackStream, StreamState>;
  private targetLatencyValue: number | null = null;
  private limitedValue = 0;
  private generationValue = 0;
  private audioPresentation: PresentationRecord | null = null;
  private videoPresentation: PresentationRecord | null = null;

  constructor(options: PlaybackTimelineOptions) {
    this.timeOriginMs = options.timeOriginMs;
    this.maxQueuedFrames = options.maxQueuedFrames;
    this.audioDelayFloorMs = options.audioDelayFloorMs ?? AUDIO_PLAYOUT_DELAY_FLOOR_MS;
    this.maxPresentationDelayMs = options.maxPresentationDelayMs ?? MAX_PLAYOUT_DELAY_MS;
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
    const targetMs = Math.min(percentile(jitters, playoutDelayPercentile(frameIntervalMs)), capMs);
    if (state.delayMs === null || targetMs >= state.delayMs) {
      state.delayMs = targetMs;
    } else {
      const elapsedMs = Math.max(0, wallClockMs - state.lastUpdateMs);
      const decayedMs = state.delayMs - (PLAYBACK_DELAY_DECAY_MS_PER_SECOND * elapsedMs) / 1_000;
      // フレーム間隔が短くなって上限が下がったときは、上限まで直ちに下げる
      state.delayMs = Math.min(Math.max(targetMs, decayedMs), capMs);
    }
    state.lastUpdateMs = wallClockMs;
    this.updateLimitedMs();
  }

  /**
   * 使う `targetLatency` を決める (ミリ秒。使わないときは null)
   *
   * 同じ render group の track は同じ値でなければならない (draft-ietf-moq-msf-01 §5.2.8)
   * ため、音声と映像で 1 つの値を使う。解決の規則は呼び出し側が持ち、ここへは確定した
   * 値だけを渡す。
   */
  setTargetLatencyMs(value: number | null): void {
    this.targetLatencyValue = value;
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
   * 表示の遅れ (ミリ秒)。TIMESTAMP から表示時刻までの差で、時計のずれの分だけ負にもなる。
   * 基準が確立していなければ null
   */
  get presentationDelayMs(): number | null {
    const baseMs = this.sharedBaseMs();
    if (baseMs === null) {
      return null;
    }
    return baseMs + this.extraDelayMs();
  }

  /** 2 つのトラックで基準を共有しているか */
  get sharingBases(): boolean {
    return this.driftedStream() === null;
  }

  /** 共有の再生遅延 (ミリ秒)。まだ観測していなければ null */
  get playoutDelayMs(): number | null {
    if (this.sharedBaseMs() === null) {
      return null;
    }
    return this.sharedDelayMs();
  }

  /**
   * 表示時刻に足している追加分 (`max(targetLatency, 再生遅延)` を上限で切った値、ミリ秒)。
   * まだ観測していなければ null
   *
   * 音声の並べすぎの上限は、この値と揺らぎから求めた再生遅延の大きい方から決める。目標の
   * 表示時刻は「今」から `max(targetLatency, 再生遅延)` だけ先にあるため、揺らぎから求めた
   * 再生遅延だけを上限にすると、`targetLatency` が大きいときに鳴らす音をすべて捨てて無音に
   * なる
   */
  get presentationExtraDelayMs(): number | null {
    if (this.sharedBaseMs() === null) {
      return null;
    }
    return this.extraDelayMs();
  }

  /**
   * 目標の表示時刻 (Unix epoch マイクロ秒)
   *
   * @returns 表示時刻。このトラックの TIMESTAMP を使わない (基準の差が閾値を超えた側)
   *   ときは null
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
   * 1 つのトラックの基準と学習と実績だけを消す。世代は進めない
   *
   * 音声の再生を止めたときなど、そのトラックを観測していない状態に戻す。表示時刻の式は
   * 残ったトラックの値だけで決まるようになる (音声の下限も入らない)。世代を進めると、
   * 既に積んでいる映像フレームの表示時刻が決められなくなり、到着順に落ちてしまう
   */
  resetStream(stream: PlaybackStream): void {
    this.streams[stream] = this.createStreamState();
    if (stream === "audio") {
      this.audioPresentation = null;
    } else {
      this.videoPresentation = null;
    }
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

  /** 共有の基準の遅れ (ミリ秒)。まだ観測していなければ null */
  private sharedBaseMs(): number | null {
    const bases: number[] = [];
    for (const stream of ["audio", "video"] as const) {
      const baseMs = this.streams[stream].baseMs;
      if (baseMs !== null) {
        bases.push(baseMs);
      }
    }
    if (bases.length === 0) {
      return null;
    }
    return Math.max(...bases);
  }

  /**
   * 基準の差が閾値を超えたトラック。無ければ null (共有している)
   *
   * 閾値はキューが吸収できる長さから `max(targetLatency, 再生遅延)` を引いた値である。
   * キューが保持する時間は「表示時刻 - 復号の出力時刻」= 2 つのトラックの基準の差 +
   * `max(targetLatency, 再生遅延)` であり、基準の遅れそのものは含まない。
   */
  private driftedStream(): PlaybackStream | null {
    const audioBase = this.streams.audio.baseMs;
    const videoBase = this.streams.video.baseMs;
    if (audioBase === null || videoBase === null) {
      return null;
    }
    const differenceMs = Math.abs(audioBase - videoBase);
    if (differenceMs <= this.baseDifferenceLimitMs()) {
      return null;
    }
    return audioBase > videoBase ? "audio" : "video";
  }

  /** 2 つのトラックの基準の差の閾値 (ミリ秒) */
  private baseDifferenceLimitMs(): number {
    const restMs = this.queueCapMs() - this.uncappedExtraDelayMs();
    return Math.max(PLAYOUT_BASE_MAX_DIFFERENCE_MIN_MS, restMs);
  }

  /** トラックの表示の遅れ (ミリ秒)。TIMESTAMP を使わないときは null */
  private presentationDelayMsOf(stream: PlaybackStream): number | null {
    const drifted = this.driftedStream();
    if (drifted !== null) {
      if (drifted === stream) {
        return null;
      }
      const ownBaseMs = this.streams[stream].baseMs;
      if (ownBaseMs === null) {
        return null;
      }
      return ownBaseMs + this.extraDelayMs();
    }
    const baseMs = this.sharedBaseMs();
    if (baseMs === null) {
      return null;
    }
    return baseMs + this.extraDelayMs();
  }

  /** 上限を掛けない `max(targetLatency, 共有の再生遅延)` (ミリ秒) */
  private uncappedExtraDelayMs(): number {
    return Math.max(this.targetLatencyValue ?? 0, this.sharedDelayMs());
  }

  /** 上限を掛けた表示の遅れの追加分 (ミリ秒) */
  private extraDelayMs(): number {
    return Math.min(this.uncappedExtraDelayMs(), this.presentationDelayCapMs());
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

  /** 共有の再生遅延 (ミリ秒)。音声を購読しているときは下限を置く */
  private sharedDelayMs(): number {
    const audioDelayMs =
      this.streams.audio.delayMs === null
        ? 0
        : Math.max(this.streams.audio.delayMs, this.audioDelayFloorMs);
    const videoDelayMs = this.streams.video.delayMs ?? 0;
    return Math.max(audioDelayMs, videoDelayMs);
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
