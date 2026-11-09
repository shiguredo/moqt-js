/** 予約は実投入の確定後だけ進める。欠落の判断と補間は出力側が所有する。 */
import {
  AUDIO_PLAYOUT_DELAY_FLOOR_MS,
  AUDIO_PLAYOUT_ARRIVAL_DELAY_MS,
  audioArrivalPlayoutDelayMs,
} from "./timeline";
/** 波形を継続的に加工しないための、時間伸縮の不感帯。 */
export const AUDIO_PLAYOUT_STRETCH_MIN_SECONDS = 0.02;
export const AUDIO_PLAYOUT_DELAY_SECONDS = AUDIO_PLAYOUT_DELAY_FLOOR_MS / 1000;
export const AUDIO_PLAYOUT_MAX_DELAY_SECONDS = 0.3;
export const AUDIO_PLAYOUT_BACKLOG_SECONDS =
  AUDIO_PLAYOUT_MAX_DELAY_SECONDS - AUDIO_PLAYOUT_DELAY_SECONDS;
/** 描画量子とメッセージ配送のための先行量。実投入直前にも時計を読み直す。 */
export const AUDIO_PLAYOUT_MIN_LEAD_SECONDS = 0.01;
export const AUDIO_PLAYOUT_PUSH_START_LEAD_SECONDS = 0.003;
export const AUDIO_PLAYOUT_MAX_LATENESS_SECONDS = 0.5;
export const AUDIO_PLAYOUT_ARRIVAL_DELAY_SECONDS = AUDIO_PLAYOUT_ARRIVAL_DELAY_MS / 1000;
export function arrivalPlayoutDelaySeconds(
  learnedDelaySeconds: number,
  minimumDelayMs = AUDIO_PLAYOUT_DELAY_FLOOR_MS,
): number {
  return audioArrivalPlayoutDelayMs(learnedDelaySeconds * 1000, minimumDelayMs) / 1000;
}
/** 連続予約の丸め誤差を吸収する範囲。過去の音にはスナップしない。 */
export const AUDIO_PLAYOUT_MIN_CONCEAL_SECONDS = 0.0005;
export const AUDIO_PLAYOUT_MAX_CONCEAL_SECONDS = 0.1;
export const AUDIO_PLAYOUT_CONCEAL_END_GAIN = 0.5;
export function concealmentEndGain(gapSeconds: number): number {
  return (
    1 -
    (1 - AUDIO_PLAYOUT_CONCEAL_END_GAIN) *
      Math.min(1, Math.max(0, gapSeconds / AUDIO_PLAYOUT_MAX_CONCEAL_SECONDS))
  );
}
/** 出力時計の観測ノイズを均す時定数。定常の小さなずれも残さない。 */
export const AUDIO_CLOCK_SMOOTHING_MS = 100;
export const AUDIO_CLOCK_MAX_CHANGE_MS = 80;
export const AUDIO_CLOCK_STALL_MS = 250;
const EPSILON_SECONDS = 1e-9;

interface AudioPlayoutOptions {
  backlogSeconds?: number;
  minLeadSeconds?: number;
  stretchMinSeconds?: number;
}
/** 到着・目標は同じ AudioContext の秒。到着は出力時計から換算する。 */
export interface AudioPlayoutTarget {
  targetStartSeconds: number | null;
  arrivalSeconds: number;
  enforceTarget: boolean;
  delaySeconds: number;
  arrivalDelaySeconds: number;
  presentationDelaySeconds: number;
  stretchMinSeconds?: number;
}
export type AudioPlayoutBasis = "timestamp" | "arrival";
/** PCM の加工と投入に必要な計画だけを返す。補間の予約は作らない。 */
export type AudioPlayoutDecision =
  | {
      kind: "play";
      startAt: number;
      basis: AudioPlayoutBasis;
      compressSeconds: number;
      expandSeconds?: number;
      totalGapSeconds: number;
    }
  | { kind: "drop"; reason: "backlog" };
export interface AudioPlayoutCommit {
  readonly startAt: number;
  readonly playedSeconds: number;
}
interface PlayoutAnchor {
  time: number;
  timestampMicroseconds: number;
}
interface PendingPlayout {
  decision: Extract<AudioPlayoutDecision, { kind: "play" }>;
  timestampMicroseconds: number;
  durationSeconds: number;
  targetSeconds: number;
  rebased: boolean;
}

/**
 * 時刻基準と到着基準は目標の作り方だけを変え、予約・上限・伸縮は同じ規則を使う。
 * schedule は計画を作るだけであり、PCM の投入に失敗しても補正を巻き戻す必要がない。
 * commit は投入済みの開始と長さを一度に受け取り、時計の対応と統計を同時に更新する。
 */
export class AudioPlayoutScheduler {
  private anchor: PlayoutAnchor | null = null;
  private lastEnd: number | null = null;
  private pending: PendingPlayout | null = null;
  private rebaseCount = 0;
  private dropCount = 0;
  private compressedSeconds = 0;
  private expandedSeconds = 0;
  private concealedSeconds = 0;
  private concealCount = 0;
  private latenessSeconds = 0;
  private readonly backlogSeconds: number;
  private readonly minLeadSeconds: number;
  private readonly stretchMinSeconds: number;

  constructor(options: AudioPlayoutOptions = {}) {
    this.backlogSeconds = options.backlogSeconds ?? AUDIO_PLAYOUT_BACKLOG_SECONDS;
    this.minLeadSeconds = options.minLeadSeconds ?? AUDIO_PLAYOUT_MIN_LEAD_SECONDS;
    this.stretchMinSeconds = options.stretchMinSeconds ?? AUDIO_PLAYOUT_STRETCH_MIN_SECONDS;
  }
  get rebases(): number {
    return this.rebaseCount;
  }
  get drops(): number {
    return this.dropCount;
  }
  get compressed(): number {
    return this.compressedSeconds;
  }
  get expanded(): number {
    return this.expandedSeconds;
  }
  get concealed(): number {
    return this.concealedSeconds;
  }
  get concealments(): number {
    return this.concealCount;
  }
  get lateness(): number {
    return this.latenessSeconds;
  }

  schedule(
    nowSeconds: number,
    timestampMicroseconds: number,
    durationSeconds: number,
    target: AudioPlayoutTarget,
  ): AudioPlayoutDecision {
    this.pending = null;
    const previousEnd = this.lastEnd;
    const earliest = Math.max(nowSeconds + this.minLeadSeconds, previousEnd ?? -Infinity);
    const arrivalTarget = target.arrivalSeconds + target.arrivalDelaySeconds;
    let basis: AudioPlayoutBasis =
      target.enforceTarget && target.targetStartSeconds !== null ? "timestamp" : "arrival";
    let desired: number;
    let rebased = false;
    let limit =
      (basis === "timestamp"
        ? Math.max(target.delaySeconds, target.presentationDelaySeconds)
        : target.arrivalDelaySeconds) + this.backlogSeconds;
    if (basis === "timestamp") {
      desired = target.targetStartSeconds ?? arrivalTarget;
      // 共有時刻が大きく外れ、出力も途切れていた場合だけ到着の基準を取り直す。
      if (
        earliest - desired > AUDIO_PLAYOUT_MAX_LATENESS_SECONDS &&
        (previousEnd === null || previousEnd <= nowSeconds)
      ) {
        desired = arrivalTarget;
        basis = "arrival";
        limit = target.arrivalDelaySeconds + this.backlogSeconds;
        rebased = true;
      }
    } else {
      desired =
        this.anchor === null
          ? arrivalTarget
          : timestampMicroseconds > this.anchor.timestampMicroseconds
            ? this.anchor.time +
              (timestampMicroseconds - this.anchor.timestampMicroseconds) / 1000000
            : (previousEnd ?? arrivalTarget);
      // 媒体時刻の飛びは新しい到着位置へ置く。確定するまでは基準を変更しない。
      if (desired > nowSeconds + limit) {
        desired = arrivalTarget;
        rebased = true;
      }
      if (nowSeconds + this.minLeadSeconds - desired >= 0.01 - EPSILON_SECONDS) rebased = true;
    }
    let startAt = Math.max(desired, earliest);
    if (
      previousEnd !== null &&
      previousEnd >= nowSeconds &&
      startAt - previousEnd <= AUDIO_PLAYOUT_MIN_CONCEAL_SECONDS + EPSILON_SECONDS
    )
      startAt = previousEnd;
    // 音質判定で圧縮を断る場合も、未加工の終端が上限を越えない。
    if (startAt + durationSeconds - nowSeconds > limit + EPSILON_SECONDS) {
      this.dropCount++;
      return { kind: "drop", reason: "backlog" };
    }
    const totalGapSeconds = previousEnd === null ? 0 : Math.max(0, startAt - previousEnd);
    const targetSeconds = basis === "timestamp" ? desired : arrivalTarget;
    const errorSeconds = startAt - targetSeconds;
    const slack = Math.max(0, (previousEnd ?? -Infinity) - nowSeconds - this.minLeadSeconds);
    const deadband = target.stretchMinSeconds ?? this.stretchMinSeconds;
    const compressSeconds =
      errorSeconds + EPSILON_SECONDS >= deadband &&
      slack > EPSILON_SECONDS &&
      (basis === "timestamp" || totalGapSeconds <= EPSILON_SECONDS)
        ? Math.min(errorSeconds, durationSeconds / 2, slack)
        : 0;
    // 浅いキューは停止を挟まずに伸ばす。同じ誤差の符号で圧縮と伸長を排他的に選ぶ。
    const expandSeconds =
      basis === "arrival" && -errorSeconds > deadband + EPSILON_SECONDS
        ? Math.min(
            -errorSeconds,
            durationSeconds,
            Math.max(0, nowSeconds + limit - startAt - durationSeconds),
          )
        : 0;
    const decision: Extract<AudioPlayoutDecision, { kind: "play" }> = {
      kind: "play",
      startAt,
      basis,
      compressSeconds,
      expandSeconds,
      totalGapSeconds,
    };
    this.pending = { decision, timestampMicroseconds, durationSeconds, targetSeconds, rebased };
    return decision;
  }

  commit(
    decision: Extract<AudioPlayoutDecision, { kind: "play" }>,
    actual: AudioPlayoutCommit,
  ): void {
    const pending = this.pending;
    if (pending === null || pending.decision !== decision)
      throw new Error("Cannot commit an expired or already committed audio plan");
    if (
      !Number.isFinite(actual.startAt) ||
      !Number.isFinite(actual.playedSeconds) ||
      actual.playedSeconds <= 0 ||
      actual.startAt + EPSILON_SECONDS < decision.startAt
    )
      throw new Error(
        "Audio commit must have a finite start and positive duration within the plan",
      );
    this.pending = null;
    this.lastEnd = actual.startAt + actual.playedSeconds;
    // 現在の媒体先頭に、加工後の長さの差を加えた一点を持つ。次の媒体位置からの
    // 差分だけで、圧縮・伸長・投入時の押し直しと本当の媒体欠落を同時に表せる。
    this.anchor = {
      time: this.lastEnd - pending.durationSeconds,
      timestampMicroseconds: pending.timestampMicroseconds,
    };
    this.compressedSeconds += Math.max(0, pending.durationSeconds - actual.playedSeconds);
    this.expandedSeconds += Math.max(0, actual.playedSeconds - pending.durationSeconds);
    this.latenessSeconds = Math.max(0, actual.startAt - pending.targetSeconds);
    if (pending.rebased) this.rebaseCount++;
  }

  /** 出力側が描画した実績だけを数える。予定した補間量は持たない。 */
  recordRenderedConcealment(seconds: number, count: number): void {
    if (!Number.isFinite(seconds) || seconds < 0 || !Number.isInteger(count) || count < 0) return;
    this.concealedSeconds += seconds;
    this.concealCount += count;
  }
  reset(): void {
    this.anchor = null;
    this.lastEnd = null;
    this.pending = null;
    this.latenessSeconds = 0;
  }
}

/** `AudioContext.getOutputTimestamp()` が返す対応 */
interface AudioClockMapping {
  /** デバイスが今鳴らしている位置 (`getOutputTimestamp().contextTime`、秒) */
  contextTime: number;
  /** その位置を `performance.now()` と同じ原点で表した時刻 (ミリ秒) */
  performanceTime: number;
}

/**
 * `AudioContext` の時計と `performance.now()` の対応
 *
 * 音声は `AudioContext.currentTime` の秒で予約し、映像は `performance.now()` のミリ秒で
 * 表示する。2 つは別の時計であり、`AudioContext.getOutputTimestamp()` が返す
 * `{ contextTime, performanceTime }` だけが仕様に定められた対応である
 * (https://webaudio.github.io/web-audio-api/#dom-audiocontext-getoutputtimestamp)。
 *
 * - 新しい出力観測に 100 ms の時定数で追従し、小さな恒常誤差も除去する。
 *   重みは観測の時間差で決め、同じサンプルの再読では更新しない。
 *   1 回の変更は `AUDIO_CLOCK_MAX_CHANGE_MS` までにする
 * - `AudioContext` が停止していた (2 つの時計の進みの差が `AUDIO_CLOCK_STALL_MS` 以上) ときは、
 *   段差をそのまま取り直す。停止中の `currentTime` は止まるため、上限までずつ補正すると
 *   再開直後の予約が未来になり破棄される
 * - `AudioContext` を作り直したときは `reset()` で対応を消し、次の予約で取り直す
 * - `getOutputTimestamp()` が未開始 (両方 0) のときは `currentTime` と `performance.now()` の
 *   差で代用する。この差は音声の出力遅延を含まないため、鳴るのは目標より出力遅延の分だけ
 *   後ろになる (`usingFallback` で分かる)
 * - 代用と実出力の対応が切り替わるときは、平滑化せず新しい観測を採る
 *
 * ブラウザ API に依存せず、値は引数で受ける。
 */
export class AudioClockBridge {
  private offsetMs: number | null = null;
  private fallback = false;
  private lastObservationMs: number | null = null;
  // 前回の update の 2 つの時計。停止 (performance.now() だけが進む) の検出に使う
  private lastCurrentTimeSeconds: number | null = null;
  private lastPerformanceNowMs: number | null = null;

  /**
   * 対応を取り直す (予約のたびに呼ぶ)
   *
   * @param mapping - `getOutputTimestamp()` の値。未開始のときは null
   * @param currentTimeSeconds - `AudioContext.currentTime` (秒)
   * @param performanceNowMs - `performance.now()` (ミリ秒)
   */
  update(
    mapping: AudioClockMapping | null,
    currentTimeSeconds: number,
    performanceNowMs: number,
  ): void {
    const observedMs =
      mapping === null
        ? currentTimeSeconds * 1_000 - performanceNowMs
        : mapping.contextTime * 1_000 - mapping.performanceTime;
    // 2 つの時計の進みの差が大きいときは、AudioContext が停止していたとみなす。
    // 停止中は currentTime が止まり performance.now() だけが進むため、再開後の対応は
    // 段差になる。80 ms ずつ補正すると数百 ms 残り、再開直後の予約が未来になって
    // 破棄されるため、段差をそのまま取り直す。currentTime が戻る入力 (時計の巻き戻し) は
    // 停止ではないため、進んだ場合だけを対象にする
    const audioElapsedMs =
      this.lastCurrentTimeSeconds === null
        ? null
        : (currentTimeSeconds - this.lastCurrentTimeSeconds) * 1_000;
    const performanceElapsedMs =
      this.lastPerformanceNowMs === null ? null : performanceNowMs - this.lastPerformanceNowMs;
    const stalled =
      audioElapsedMs !== null &&
      performanceElapsedMs !== null &&
      audioElapsedMs >= 0 &&
      performanceElapsedMs - audioElapsedMs >= AUDIO_CLOCK_STALL_MS;
    const observationMs = mapping?.performanceTime ?? performanceNowMs;
    // 代用は出力の先行量を含まない別の測定方法である。方法の切り替えを平滑化で
    // 抑えると、実時計へ戻った表示のまま古い代用値の誤差を保持してしまう。
    if (this.offsetMs === null || stalled || this.fallback !== (mapping === null)) {
      this.offsetMs = observedMs;
      this.lastObservationMs = observationMs;
    } else if (this.lastObservationMs !== null && observationMs > this.lastObservationMs) {
      // 呼び出し回数ではなく実観測の経過時間で重みを決める。サンプル再読による
      // 多重更新と、短フレームほど速く追従してしまう依存を作らない。
      const weight = -Math.expm1(
        -(observationMs - this.lastObservationMs) / AUDIO_CLOCK_SMOOTHING_MS,
      );
      const changeMs = (observedMs - this.offsetMs) * weight;
      this.offsetMs += Math.max(
        -AUDIO_CLOCK_MAX_CHANGE_MS,
        Math.min(AUDIO_CLOCK_MAX_CHANGE_MS, changeMs),
      );
      this.lastObservationMs = observationMs;
    }
    this.fallback = mapping === null;
    this.lastCurrentTimeSeconds = currentTimeSeconds;
    this.lastPerformanceNowMs = performanceNowMs;
  }

  /**
   * 対応を消す。呼び出し側が `AudioContext` を作り直すときに呼ぶ
   *
   * 消したあとは、次の予約 (`update`) が観測値から対応を作り直す。
   * 対応は「`AudioContext` の時計 − `performance.now()`」であり、AudioContext ごとに
   * 異なる。作り直した AudioContext に古い対応を使い続けると、`currentTime` が 0 から
   * 始まる分だけ目標の時刻がずれ、`update()` が 1 回で動かせる上限
   * (`AUDIO_CLOCK_MAX_CHANGE_MS`) では追いつかない。
   */
  reset(): void {
    this.offsetMs = null;
    this.fallback = false;
    this.lastObservationMs = null;
    // 停止の判定に使う前回の時計も消す。作り直した AudioContext は 0 から始まるため、
    // 前の Context の currentTime と比べると、停止していなくても段差として扱ってしまう
    this.lastCurrentTimeSeconds = null;
    this.lastPerformanceNowMs = null;
  }

  /**
   * `performance.now()` の軸の時刻 (ミリ秒) を `AudioContext` の秒へ換算する
   *
   * @returns `AudioContext.currentTime` と同じ座標の秒。まだ対応が無ければ null
   */
  toAudioSeconds(presentationMs: number): number | null {
    if (this.offsetMs === null) {
      return null;
    }
    return (presentationMs + this.offsetMs) / 1_000;
  }

  /**
   * `AudioContext` の秒を `performance.now()` の軸の時刻 (ミリ秒) へ換算する
   *
   * @returns `performance.now()` と同じ座標のミリ秒。まだ対応が無ければ null
   */
  toPerformanceMs(audioSeconds: number): number | null {
    if (this.offsetMs === null) {
      return null;
    }
    return audioSeconds * 1_000 - this.offsetMs;
  }

  /** `getOutputTimestamp()` を使えず、`currentTime` で代用しているか */
  get usingFallback(): boolean {
    return this.fallback;
  }

  /** 今の対応 (ミリ秒)。まだ取り直していなければ null */
  get currentOffsetMs(): number | null {
    return this.offsetMs;
  }
}
