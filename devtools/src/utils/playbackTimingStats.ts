/**
 * 受信した映像の到着・復号・表示の時間の統計
 *
 * 受信側の映像がかくつくとき、原因は到着の揺らぎ、送信から受信までの遅延、復号の
 * 遅れ、表示の止まり、表示キューのあふれのいずれか (または組み合わせ) である。
 * 累積のカウンタだけでは区別できないため、時刻を記録して分布と累積の値を出す。
 *
 * ブラウザ API に依存しないよう、時刻は呼び出し側が引数で渡す
 * (`performance.now()` と `performance.timeOrigin + performance.now()`)。
 *
 * - 分布 (p50 / p95 / max) は直近の窓 (既定 10 秒) の値から求める
 * - 止まりの回数と時間、表示キューのあふれは購読の開始 (reset) からの累積である
 * - 止まりごとに原因を 1 つ決め (stallAnalysis.ts)、原因ごとの回数と時間、直近の止まりを
 *   残す。原因ごとの回数と時間の和は、止まりの回数と時間に一致する
 * - Subgroup の stream の reset を error code ごとに数え、reset と欠落 (loss) の止まりを
 *   止まりの一覧とは別に残す。到着の遅れの止まりが多くても押し出されない
 * - 描いたフレームの遅延を区間ごと (到着・保留・復号待ち・復号・表示待ち・表示の遅延) に
 *   分けて出す (latencyBreakdown.ts)。遅延が publisher・経路・relay と subscriber のどちらで
 *   生じたかを分けるため
 */

import { DataStreamErrorCode } from "moqt-js";
import { LATENCY_SEGMENTS, LatencyBreakdown, type LatencySegment } from "./latencyBreakdown";
import { STALL_CAUSES, StallAnalyzer, type ObjectPosition, type StallCause } from "./stallAnalysis";
import { TimedValues } from "../../../src/timedValues.ts";

/** 分布を求める直近の窓 (ミリ秒) */
export const PLAYBACK_TIMING_WINDOW_MS = 10_000;

/** 表示 fps を数える窓 (ミリ秒) */
export const DISPLAY_FPS_WINDOW_MS = 1_000;

/** 表示間隔がフレーム間隔のこの倍数を超えたら止まりとみなす */
export const DISPLAY_STALL_FACTOR = 1.5;

/** 残す直近の止まりの数 */
export const MAX_RECENT_STALLS = 30;

/** 残す直近の reset と欠落の止まりの数 */
export const MAX_RECENT_LOSS_EVENTS = 30;

/** 原因ごとの止まりの回数と時間の累積 */
export interface StallCauseTotal {
  readonly count: number;
  /** 止まりとみなした表示間隔の合計 (ミリ秒) */
  readonly ms: number;
}

/** 1 回の止まり */
export interface StallEvent {
  /** 止まりの後にフレームを描いた時刻 (壁時計、Unix epoch ミリ秒) */
  readonly wallClockMs: number;
  /** 止まりとみなした表示間隔 (ミリ秒) */
  readonly durationMs: number;
  readonly cause: StallCause;
  /** 止まりの後に描いたフレームの Group ID と Object ID (10 進の文字列)。記録が無ければ null */
  readonly groupId: string | null;
  readonly objectId: string | null;
  /** 止まりの前後に描いたフレームの TIMESTAMP の差 (ミリ秒) */
  readonly mediaStepMs: number;
}

/** 1 回の Subgroup の stream の reset */
export interface StreamResetEvent {
  /** reset を受け取った時刻 (壁時計、Unix epoch ミリ秒) */
  readonly wallClockMs: number;
  /** stream の Group ID と Subgroup ID (10 進の文字列)。Subgroup ID が未確定なら null */
  readonly groupId: string;
  readonly subgroupId: string | null;
  /** RESET_STREAM の error code (draft-ietf-moq-transport-21 Section 12.5)。無ければ null */
  readonly errorCode: number | null;
}

/**
 * Object の欠落に関わる 1 件。Subgroup の stream の reset と、Object が届かなかったことに
 * よる止まり (loss) を時刻順に並べる
 */
export type LossEvent =
  | { readonly kind: "streamReset"; readonly event: StreamResetEvent }
  | { readonly kind: "lossStall"; readonly event: StallEvent };

/** 分布の要約 (ミリ秒) */
export interface TimingSummary {
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

/** 統計の値 */
export interface PlaybackTimingSnapshot {
  /**
   * 到着の揺らぎ。到着時刻 - メディア時刻 (LOC TIMESTAMP) の、窓の中の最小値からの差。
   * 送信側と受信側の時計のずれに依らない
   */
  readonly arrivalJitterMs: TimingSummary | null;
  /**
   * 遅延。受信側の壁時計 - 送信側の壁時計の LOC TIMESTAMP。
   * Timescale の無い (壁時計の) TIMESTAMP だけで求める。別のマシンでは時計のずれを含む
   */
  readonly latencyMs: TimingSummary | null;
  /** 復号時間。decoder に渡してから出力されるまで */
  readonly decodeTimeMs: TimingSummary | null;
  /** 表示間隔 */
  readonly displayIntervalMs: TimingSummary | null;
  /** 直近 1 秒に描いたフレーム数 */
  readonly displayFps: number;
  /** 表示間隔がフレーム間隔の 1.5 倍を超えた回数 (累積) */
  readonly displayStalls: number;
  /** 止まりとみなした表示間隔の合計 (ミリ秒、累積) */
  readonly displayStallMs: number;
  /** 表示キューがあふれて捨てたフレーム数 (累積) */
  readonly displayQueueDrops: number;
  /**
   * jitter buffer の現在の再生遅延 (ミリ秒)。jitter buffer が働いていない
   * (無効 / 壁時計の TIMESTAMP のフレームがまだ無い) ときは null
   */
  readonly playoutDelayMs: number | null;
  /**
   * jitter buffer が間に合わずに捨てたフレーム数 (累積)。表示時刻を過ぎたフレームが
   * 3 枚以上あるとき、最新とその 1 つ前より古いものを捨てる
   */
  readonly lateFramesDropped: number;
  /** 原因ごとの止まりの回数と時間 (累積)。和は displayStalls / displayStallMs に一致する */
  readonly stallCauses: Readonly<Record<StallCause, StallCauseTotal>>;
  /** 直近の止まり (古い順、最大 `MAX_RECENT_STALLS` 回) */
  readonly recentStalls: readonly StallEvent[];
  /** Group の中の Object ID の飛びで届かなかった Object の数 (累積) */
  readonly missingObjects: number;
  /** Group ID の飛びで届かなかった Group の数 (累積) */
  readonly missingGroups: number;
  /** RESET_STREAM で終わった Subgroup の stream の数 (累積) */
  readonly subgroupStreamResets: number;
  /**
   * RESET_STREAM で終わった Subgroup の stream の数を error code ごとに数えた値 (累積)。
   * キーは `formatStreamResetCode` の文字列
   */
  readonly subgroupStreamResetsByCode: Readonly<Record<string, number>>;
  /** 直近の reset と欠落の止まり (古い順、最大 `MAX_RECENT_LOSS_EVENTS` 件) */
  readonly recentLossEvents: readonly LossEvent[];
  /**
   * 描いたフレームの区間ごとの遅延 (latencyBreakdown.ts の区間)。フレームごとに、到着・保留・
   * 復号待ち・復号・表示待ちの和が表示の遅延になる。到着と表示の遅延は壁時計の TIMESTAMP の
   * フレームだけで求め、別のマシンでは時計のずれを含む
   */
  readonly latencyBreakdown: Readonly<Record<LatencySegment, TimingSummary | null>>;
  /**
   * Group の切り替えの保留が、前の Group の stream の終わりを待たずに上限の時間で
   * 解けた回数 (累積)
   */
  readonly groupSwitchHoldExpirations: number;
}

/** どの原因も 0 回の累積 */
function emptyStallCauses(): Record<StallCause, StallCauseTotal> {
  const totals = {} as Record<StallCause, StallCauseTotal>;
  for (const cause of STALL_CAUSES) {
    totals[cause] = { count: 0, ms: 0 };
  }
  return totals;
}

/** どの区間も記録が無いときの区間ごとの遅延 */
function emptyLatencyBreakdown(): Record<LatencySegment, TimingSummary | null> {
  const breakdown = {} as Record<LatencySegment, TimingSummary | null>;
  for (const segment of LATENCY_SEGMENTS) {
    breakdown[segment] = null;
  }
  return breakdown;
}

/** 何も記録していないときの統計 */
export const EMPTY_PLAYBACK_TIMING: PlaybackTimingSnapshot = {
  arrivalJitterMs: null,
  latencyMs: null,
  decodeTimeMs: null,
  displayIntervalMs: null,
  displayFps: 0,
  displayStalls: 0,
  displayStallMs: 0,
  displayQueueDrops: 0,
  playoutDelayMs: null,
  lateFramesDropped: 0,
  stallCauses: emptyStallCauses(),
  recentStalls: [],
  missingObjects: 0,
  missingGroups: 0,
  subgroupStreamResets: 0,
  subgroupStreamResetsByCode: {},
  recentLossEvents: [],
  latencyBreakdown: emptyLatencyBreakdown(),
  groupSwitchHoldExpirations: 0,
};

/**
 * 値の分布を p50 / p95 / max に要約する
 *
 * 百分位は nearest-rank 法 (昇順に並べて ceil(p * n) 番目) で求める。値が無ければ null。
 */
export function summarizeTimings(values: readonly number[]): TimingSummary | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    max: nearestRank(sorted, 1),
  };
}

function nearestRank(sorted: readonly number[], ratio: number): number {
  const index = Math.max(0, Math.ceil(ratio * sorted.length) - 1);
  return sorted[index] ?? Number.NaN;
}

/**
 * 分布の要約を「p50 / p95 / max」(ミリ秒、小数 1 桁) の文字列にする。値が無ければ "-"
 */
export function formatTimingSummary(summary: TimingSummary | null): string {
  if (summary === null) {
    return "-";
  }
  return `${summary.p50.toFixed(1)} / ${summary.p95.toFixed(1)} / ${summary.max.toFixed(1)}`;
}

/**
 * 原因ごとの止まりの累積を「回数 / 時間 ms」の文字列にする
 */
export function formatStallCauseTotal(total: StallCauseTotal): string {
  return `${total.count} / ${Math.round(total.ms)} ms`;
}

/**
 * 1 回の止まりを 1 行の文字列にする
 *
 * 時刻は UTC の ISO 8601 (ミリ秒まで) にする。relay のログと突き合わせるときに時差で
 * 迷わないため
 */
export function formatStallEvent(stall: StallEvent): string {
  const position =
    stall.groupId === null || stall.objectId === null
      ? "position=-"
      : `group=${stall.groupId} object=${stall.objectId}`;
  return [
    new Date(stall.wallClockMs).toISOString(),
    stall.cause,
    `${Math.round(stall.durationMs)} ms`,
    position,
    `step=${Math.round(stall.mediaStepMs)} ms`,
  ].join(" ");
}

/**
 * RESET_STREAM の error code を「名前 (16 進の値)」にする
 *
 * 名前は draft-ietf-moq-transport-21 Section 12.5 の code の名前である。未知の値は名前を
 * 付けず 16 進の値だけにし、code が無ければ "no code" にする
 */
export function formatStreamResetCode(errorCode: number | null): string {
  if (errorCode === null) {
    return "no code";
  }
  const hex = `0x${errorCode.toString(16)}`;
  for (const [name, value] of Object.entries(DataStreamErrorCode)) {
    if (value === errorCode) {
      return `${name} (${hex})`;
    }
  }
  return hex;
}

/**
 * reset と欠落の止まりの 1 件を 1 行の文字列にする
 *
 * 時刻は UTC の ISO 8601 (ミリ秒まで) にする。欠落の止まりは `formatStallEvent` と同じ形にする
 */
export function formatLossEvent(lossEvent: LossEvent): string {
  if (lossEvent.kind === "lossStall") {
    return formatStallEvent(lossEvent.event);
  }
  const reset = lossEvent.event;
  return [
    new Date(reset.wallClockMs).toISOString(),
    "stream reset",
    `group=${reset.groupId}`,
    `subgroup=${reset.subgroupId ?? "-"}`,
    `code=${formatStreamResetCode(reset.errorCode)}`,
  ].join(" ");
}

/**
 * 受信した映像の到着・復号・表示の時間を記録し、統計を求める
 */
export class PlaybackTimingStats {
  private readonly windowMs: number;
  private readonly timeOriginMs: number;
  // 到着時刻 - メディア時刻 (ミリ秒)
  private readonly lateness = new TimedValues();
  // 受信側の壁時計 - 送信側の壁時計の TIMESTAMP (ミリ秒)
  private readonly latency = new TimedValues();
  private readonly decodeTimes = new TimedValues();
  // decoder に渡したフレームの timestamp (マイクロ秒) と渡した時刻 (ミリ秒)。
  // 挿入順 (渡した順) に並ぶ
  private decodeStarts = new Map<number, number>();
  private readonly displayIntervals = new TimedValues();
  // 続けて描いたフレームのメディア時刻の差 (ミリ秒)。フレーム間隔を求めるために使う
  private readonly frameSteps = new TimedValues();
  // 描いた時刻 (表示 fps を数えるために使う。値は使わない)
  private readonly displays = new TimedValues();
  private lastDisplay: { nowMs: number; timestampMicros: number } | null = null;
  private displayStalls = 0;
  private displayStallMs = 0;
  private displayQueueDrops = 0;
  private playoutDelayMs: number | null = null;
  private lateFramesDropped = 0;
  // フレームごとの受け取りから表示までの記録と、受信の欠け
  private readonly stalls: StallAnalyzer;
  private stallCauses = emptyStallCauses();
  private recentStalls: StallEvent[] = [];
  private subgroupStreamResetsByCode: Record<string, number> = {};
  private recentLossEvents: LossEvent[] = [];
  private groupSwitchHoldExpirations = 0;
  // 描いたフレームの区間ごとの遅延
  private readonly breakdown: LatencyBreakdown;

  /**
   * @param windowMs - 分布を求める直近の窓 (ミリ秒)。止まりの原因を決めるフレームの記録も
   *   この間残す
   * @param timeOriginMs - `performance.timeOrigin`。止まりの時刻を壁時計に換算する
   */
  constructor(windowMs: number = PLAYBACK_TIMING_WINDOW_MS, timeOriginMs = 0) {
    this.windowMs = windowMs;
    this.timeOriginMs = timeOriginMs;
    this.stalls = new StallAnalyzer(windowMs);
    this.breakdown = new LatencyBreakdown(windowMs, timeOriginMs);
  }

  /**
   * 映像の Object の到着を記録する
   *
   * @param nowMs - 到着した時刻 (`performance.now()`)
   * @param timestampMicros - Object の LOC TIMESTAMP (マイクロ秒)
   * @param wallClockNowMs - 到着した時刻の壁時計 (`performance.timeOrigin + performance.now()`)。
   *   TIMESTAMP が壁時計でない (Timescale がある) ときは null を渡し、遅延を求めない
   */
  recordArrival(nowMs: number, timestampMicros: number, wallClockNowMs: number | null): void {
    this.breakdown.recordReceived(timestampMicros, nowMs, wallClockNowMs !== null);
    this.lateness.push(nowMs, nowMs - timestampMicros / 1_000);
    if (wallClockNowMs !== null) {
      this.latency.push(nowMs, wallClockNowMs - timestampMicros / 1_000);
    }
  }

  /**
   * 映像の Object を受け取ったことを記録する (止まりの原因と受信の欠けに使う)
   *
   * @param subgroupId - Object が届いた Subgroup の ID。stream で届かない Object
   *   (Datagram) は undefined
   * @param timestampMicros - Object の TIMESTAMP (マイクロ秒)。無ければ null
   * @param nowMs - 受け取った時刻 (`performance.now()`)
   */
  recordObjectReceived(
    position: ObjectPosition,
    subgroupId: bigint | undefined,
    timestampMicros: number | null,
    nowMs: number,
  ): void {
    this.stalls.recordReceived(position, subgroupId, timestampMicros, nowMs);
  }

  /** 映像の Object が Group の切り替えの保留から出たことを記録する */
  recordObjectReleased(timestampMicros: number, nowMs: number): void {
    this.stalls.recordReleased(timestampMicros, nowMs);
    this.breakdown.recordReleased(timestampMicros, nowMs);
  }

  /** 映像の Object を復号せずに捨てたことを記録する */
  recordDiscarded(timestampMicros: number): void {
    this.stalls.recordDiscarded(timestampMicros);
  }

  /**
   * Subgroup の stream の終わりを記録する
   *
   * @param errorCode - RESET_STREAM の error code。FIN のときと、code が無いときは null
   * @param nowMs - 終わりを受け取った時刻 (`performance.now()`)
   */
  recordSubgroupEnd(
    groupId: bigint,
    subgroupId: bigint | undefined,
    reason: "fin" | "reset",
    errorCode: number | null,
    nowMs: number,
  ): void {
    this.stalls.recordSubgroupEnd(groupId, subgroupId, reason);
    if (reason !== "reset") {
      return;
    }
    const label = formatStreamResetCode(errorCode);
    this.subgroupStreamResetsByCode[label] = (this.subgroupStreamResetsByCode[label] ?? 0) + 1;
    this.pushLossEvent({
      kind: "streamReset",
      event: {
        wallClockMs: this.timeOriginMs + nowMs,
        groupId: groupId.toString(),
        subgroupId: subgroupId === undefined ? null : subgroupId.toString(),
        errorCode,
      },
    });
  }

  /** Group の切り替えの保留が上限の時間で解けたことを記録する */
  recordGroupSwitchHoldExpired(): void {
    this.groupSwitchHoldExpirations++;
  }

  /**
   * フレームを decoder に渡したことを記録する
   *
   * 出力されなかったフレームの記録が残り続けないよう、窓より古い記録を捨てる。
   */
  recordDecodeStart(nowMs: number, timestampMicros: number): void {
    this.stalls.recordDecodeStart(timestampMicros);
    this.breakdown.recordDecodeStart(timestampMicros, nowMs);
    const minAtMs = nowMs - this.windowMs;
    for (const [timestamp, startMs] of this.decodeStarts) {
      if (startMs >= minAtMs) {
        break;
      }
      this.decodeStarts.delete(timestamp);
    }
    // 同じ timestamp を渡し直したときは新しい記録にし、挿入順の末尾へ移す
    this.decodeStarts.delete(timestampMicros);
    this.decodeStarts.set(timestampMicros, nowMs);
  }

  /**
   * decoder がフレームを出力したことを記録する。同じ timestamp の開始との差を復号時間にする
   */
  recordDecodeOutput(nowMs: number, timestampMicros: number): void {
    this.stalls.recordDecodeOutput(timestampMicros, nowMs);
    this.breakdown.recordDecodeOutput(timestampMicros, nowMs);
    const startMs = this.decodeStarts.get(timestampMicros);
    if (startMs === undefined) {
      return;
    }
    this.decodeStarts.delete(timestampMicros);
    this.decodeTimes.push(nowMs, nowMs - startMs);
  }

  /**
   * フレームを描いたことを記録する
   *
   * 直前に描いたフレームからの表示間隔が、フレーム間隔 (窓の中の、続けて描いたフレームの
   * メディア時刻の差の中央値) の 1.5 倍を超えたら止まりとして数え、原因を 1 つ決める。
   * フレーム間隔はこの表示より前の値から求める。
   *
   * @param presentationMs - jitter buffer の表示時刻 (`performance.now()` の時間軸)。
   *   jitter buffer が表示時刻を決めずに描いたときは null
   * @returns 止まりとして数えたときはその止まり。数えなければ null
   */
  recordDisplay(
    nowMs: number,
    timestampMicros: number,
    presentationMs: number | null = null,
  ): StallEvent | null {
    this.stalls.recordDisplayed(timestampMicros, presentationMs);
    this.breakdown.recordDisplayed(timestampMicros, nowMs);
    const previous = this.lastDisplay;
    let stall: StallEvent | null = null;
    if (previous !== null) {
      const intervalMs = nowMs - previous.nowMs;
      this.frameSteps.prune(nowMs - this.windowMs);
      const frameIntervalMs = summarizeTimings(this.frameSteps.current())?.p50;
      if (frameIntervalMs !== undefined && intervalMs > frameIntervalMs * DISPLAY_STALL_FACTOR) {
        this.displayStalls++;
        this.displayStallMs += intervalMs;
        stall = this.recordStall(previous, nowMs, timestampMicros, intervalMs, frameIntervalMs);
      }
      this.displayIntervals.push(nowMs, intervalMs);
      const stepMs = (timestampMicros - previous.timestampMicros) / 1_000;
      // メディア時刻が進んでいない (同じフレーム、巻き戻り) 差はフレーム間隔に含めない
      if (stepMs > 0) {
        this.frameSteps.push(nowMs, stepMs);
      }
    }
    this.displays.push(nowMs, 0);
    this.lastDisplay = { nowMs, timestampMicros };
    return stall;
  }

  /** 表示キューがあふれてフレームを捨てたことを記録する */
  recordQueueDrop(timestampMicros: number): void {
    this.displayQueueDrops++;
    this.stalls.recordQueueDropped(timestampMicros);
  }

  /**
   * jitter buffer が間に合わなかったフレームを捨てたことを記録する
   *
   * @param presentationMs - 捨てたフレームの表示時刻 (`performance.now()` の時間軸)
   */
  recordLateDrop(timestampMicros: number, presentationMs: number): void {
    this.lateFramesDropped++;
    this.stalls.recordLateDropped(timestampMicros, presentationMs);
  }

  /** jitter buffer の現在の再生遅延を記録する (働いていなければ null) */
  recordPlayoutDelay(delayMs: number | null): void {
    this.playoutDelayMs = delayMs;
  }

  /**
   * 統計を求める
   *
   * @param nowMs - 求める時刻 (`performance.now()`)。窓はこの時刻から遡る
   */
  snapshot(nowMs: number): PlaybackTimingSnapshot {
    const gaps = this.stalls.receptionGaps();
    const minAtMs = nowMs - this.windowMs;
    for (const series of [
      this.lateness,
      this.latency,
      this.decodeTimes,
      this.displayIntervals,
      this.frameSteps,
      this.displays,
    ]) {
      series.prune(minAtMs);
    }
    const lateness = this.lateness.current();
    const earliest = Math.min(...lateness);
    const breakdownValues = this.breakdown.current(nowMs);
    const latencyBreakdown = emptyLatencyBreakdown();
    for (const segment of LATENCY_SEGMENTS) {
      latencyBreakdown[segment] = summarizeTimings(breakdownValues[segment]);
    }
    return {
      arrivalJitterMs: summarizeTimings(lateness.map((value) => value - earliest)),
      latencyMs: summarizeTimings(this.latency.current()),
      decodeTimeMs: summarizeTimings(this.decodeTimes.current()),
      displayIntervalMs: summarizeTimings(this.displayIntervals.current()),
      displayFps: this.displays.countAfter(nowMs - DISPLAY_FPS_WINDOW_MS),
      displayStalls: this.displayStalls,
      displayStallMs: this.displayStallMs,
      displayQueueDrops: this.displayQueueDrops,
      playoutDelayMs: this.playoutDelayMs,
      lateFramesDropped: this.lateFramesDropped,
      stallCauses: { ...this.stallCauses },
      recentStalls: [...this.recentStalls],
      missingObjects: gaps.missingObjects,
      missingGroups: gaps.missingGroups,
      subgroupStreamResets: gaps.subgroupStreamResets,
      subgroupStreamResetsByCode: { ...this.subgroupStreamResetsByCode },
      recentLossEvents: [...this.recentLossEvents],
      latencyBreakdown,
      groupSwitchHoldExpirations: this.groupSwitchHoldExpirations,
    };
  }

  /** 記録をすべて捨てて初期状態に戻す */
  reset(): void {
    this.lateness.clear();
    this.latency.clear();
    this.decodeTimes.clear();
    this.decodeStarts = new Map();
    this.displayIntervals.clear();
    this.frameSteps.clear();
    this.displays.clear();
    this.lastDisplay = null;
    this.displayStalls = 0;
    this.displayStallMs = 0;
    this.displayQueueDrops = 0;
    this.playoutDelayMs = null;
    this.lateFramesDropped = 0;
    this.stalls.reset();
    this.stallCauses = emptyStallCauses();
    this.recentStalls = [];
    this.subgroupStreamResetsByCode = {};
    this.recentLossEvents = [];
    this.groupSwitchHoldExpirations = 0;
    this.breakdown.reset();
  }

  /** reset と欠落の止まりの一覧に加え、上限を超えたら古い方から捨てる */
  private pushLossEvent(lossEvent: LossEvent): void {
    this.recentLossEvents.push(lossEvent);
    if (this.recentLossEvents.length > MAX_RECENT_LOSS_EVENTS) {
      this.recentLossEvents.shift();
    }
  }

  /**
   * 止まりの原因を決め、原因ごとの累積と直近の止まりに加える
   *
   * 通常の復号時間は窓の中の復号時間の中央値とする (受け取りが表示の時刻に間に合ったかは、
   * 復号にかかる時間を見込んで決める)
   */
  private recordStall(
    previous: { nowMs: number; timestampMicros: number },
    nowMs: number,
    timestampMicros: number,
    intervalMs: number,
    frameIntervalMs: number,
  ): StallEvent {
    this.decodeTimes.prune(nowMs - this.windowMs);
    const typicalDecodeMs = summarizeTimings(this.decodeTimes.current())?.p50 ?? 0;
    const cause = this.stalls.classify(
      { timestampMicros: previous.timestampMicros, displayedAtMs: previous.nowMs },
      { timestampMicros, displayedAtMs: nowMs },
      frameIntervalMs * DISPLAY_STALL_FACTOR,
      typicalDecodeMs,
    );
    const total = this.stallCauses[cause];
    this.stallCauses[cause] = { count: total.count + 1, ms: total.ms + intervalMs };
    const position = this.stalls.positionOf(timestampMicros);
    const stall: StallEvent = {
      wallClockMs: this.timeOriginMs + nowMs,
      durationMs: intervalMs,
      cause,
      groupId: position === null ? null : position.groupId.toString(),
      objectId: position === null ? null : position.objectId.toString(),
      mediaStepMs: (timestampMicros - previous.timestampMicros) / 1_000,
    };
    this.recentStalls.push(stall);
    if (this.recentStalls.length > MAX_RECENT_STALLS) {
      this.recentStalls.shift();
    }
    if (cause === "loss") {
      this.pushLossEvent({ kind: "lossStall", event: stall });
    }
    return stall;
  }
}
