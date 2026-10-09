/**
 * 音声の再生 (鳴らす時刻) の観測値
 *
 * 受信した音声の「鳴るはずの時刻 (再生予定時刻)」「届いた時刻」「実際に鳴り始める時刻」を
 * 記録し、予定に対する余裕 (間に合ったか) と、鳴らなかった量を出す。
 *
 * 音声の語尾が聞こえないとき、原因が「再生予定に間に合わなかったこと」なのか、それとも
 * 別の段 (受信・復号・音声出力) なのかを数値で切り分けるために使う。累積のカウンタだけでは
 * 「何ミリ秒分の音が鳴らなかったか」が分からないため、長さも数える。
 *
 * - 時刻はすべて `performance.now()` と同じ軸のミリ秒である。再生予定時刻は LOC の
 *   TIMESTAMP から `playbackTimeline.ts` が決めた時刻であり、鳴り始める時刻は
 *   `AudioContext` の時計へ予約した時刻を `AudioClockBridge` で同じ軸へ換算した値である
 *   (音声出力の遅延は含まない)
 * - 分布 (p50 / p95 / max) は直近の窓 (既定 10 秒) の値から求める
 * - 鳴らなかった量は購読の開始 (reset) からの累積である。理由ごとに数え、和は合計に一致する
 * - 時間軸の再生予定時刻を使わずに鳴らした音 (LOC TIMESTAMP が壁時計でない、jitter buffer
 *   が無効、トラックの基準が共有されていない) は、到着から一定の遅れで鳴らす計画に載せ、
 *   `arrivalPlannedFrames` に数える。時間軸が予定を決めていれば、その予定との差 (余裕と
 *   遅れ) は分布へ入れる (`unplannedFrames` は、どちらの計画も持たないまま鳴らした音の数)
 * - ブラウザ API に依存しない。時刻は呼び出し側が引数で渡す
 */

import type { AudioPlayoutBasis } from "./audioPlayout";
import { TimedValues } from "./timedValues";
import { summarizeTimings, type TimingSummary } from "./timingSummary";

/** 分布を求める直近の窓 (ミリ秒)。映像の Playback Timing と同じ長さにする */
export const AUDIO_PLAYOUT_TIMING_WINDOW_MS = 10_000;

/** 残す直近の「鳴らさなかった音」の数 */
export const MAX_RECENT_AUDIO_MISSES = 30;

/**
 * 鳴らさなかった理由
 *
 * - `backlog`: 並べすぎて捨てた (再生が追いついていない)
 * - `catchUp`: relay の cache から追いつく途中で鳴らさなかった (意図的なもの)
 * - `error`: 鳴らす準備 (詰め・補間・予約) の途中で失敗した
 * - `stopped`: 予約したまま再生を止めた (予約済みの音が切り捨てられた)
 *
 * 鳴り遅れを理由に捨てることはない。音がまだ鳴っている間は遅れたまま鳴らし続け、音が
 * 途切れたときだけ到着基準へ並べ直す (src/audioPlayout.ts)
 */
export const AUDIO_MISS_REASONS = ["backlog", "catchUp", "error", "stopped"] as const;

/** 鳴らさなかった理由 */
export type AudioMissReason = (typeof AUDIO_MISS_REASONS)[number];

/** 理由ごとの、鳴らさなかった音の数と長さの累積 */
export interface AudioMissTotal {
  readonly count: number;
  /** 鳴らさなかった音の長さの合計 (ミリ秒) */
  readonly ms: number;
}

/** 1 回、音を鳴らさなかったこと */
export interface AudioMissEvent {
  /** 鳴らさなかった時刻 (壁時計、Unix epoch ミリ秒) */
  readonly wallClockMs: number;
  readonly reason: AudioMissReason;
  /** 鳴らさなかった音の長さ (ミリ秒) */
  readonly durationMs: number;
  /** そのときの、予定に対する余裕 (ミリ秒)。予定が無ければ null */
  readonly slackMs: number | null;
}

/** 鳴らさなかった 1 件の記録 (時刻は `performance.now()` と同じ軸のミリ秒) */
export interface AudioPlayoutMiss {
  /** 鳴らさなかった時刻 */
  readonly atMs: number;
  readonly reason: AudioMissReason;
  /** 鳴らさなかった音の長さ (ミリ秒) */
  readonly durationMs: number;
  /** 再生予定時刻。予定が無ければ null */
  readonly targetMs: number | null;
  /** 到着した時刻。分からなければ null */
  readonly arrivalMs: number | null;
}

/** 音声の再生の観測値 (表示とテスト用 API へ出す snapshot) */
export interface AudioPlayoutTimingSnapshot {
  /** 直近に鳴らすと決めた音の再生予定時刻 (ミリ秒)。予定を決められなければ null */
  readonly lastTargetMs: number | null;
  /** 直近に鳴らすと決めた音の到着時刻 (ミリ秒) */
  readonly lastArrivalMs: number | null;
  /** 直近に鳴らすと決めた音が鳴り始める時刻 (ミリ秒) */
  readonly lastStartMs: number | null;
  /** 直近に鳴らすと決めた音の、予定に対する余裕 (ミリ秒。負なら予定を過ぎて届いた) */
  readonly lastSlackMs: number | null;
  /** 直近に鳴らすと決めた音の、到着から鳴り始めるまでの時間 (ミリ秒) */
  readonly lastStartDelayMs: number | null;
  /** 直近に鳴らすと決めた音の、予定からどれだけ過ぎて鳴るか (ミリ秒) */
  readonly lastLatenessMs: number | null;
  /**
   * 予定に対する余裕 (予定 - 到着) の分布 (直近の窓、ミリ秒)。負なら、届いた時点で
   * すでに予定を過ぎている (間に合っていない)
   */
  readonly slackMs: TimingSummary | null;
  /** 到着から鳴り始めるまでの時間の分布 (直近の窓、ミリ秒) */
  readonly startDelayMs: TimingSummary | null;
  /** 予定からどれだけ過ぎて鳴るかの分布 (直近の窓、ミリ秒)。0 なら予定どおり */
  readonly latenessMs: TimingSummary | null;
  /** 鳴らすと決めた音の数 (累積。到着基準で鳴らした音を含む) */
  readonly playedFrames: number;
  /** 鳴らすと決めた音の長さの合計 (ミリ秒、累積。詰めた分を引いた後) */
  readonly playedMs: number;
  /**
   * 時間軸の再生予定時刻を使えず、到着基準の計画で鳴らした音の数 (累積)
   *
   * 時間軸が目標を決められていない (TIMESTAMP が壁時計からずれているなど) ことを、
   * この数と `unplannedFrames` 0 の組み合わせで読む
   */
  readonly arrivalPlannedFrames: number;
  /** 到着基準の計画も持たないまま鳴らした音の数 (累積。通常は 0) */
  readonly unplannedFrames: number;
  /** 鳴らさなかった音の数 (累積) */
  readonly missedFrames: number;
  /** 鳴らさなかった音の長さの合計 (ミリ秒、累積) */
  readonly missedMs: number;
  /** 鳴らさなかった理由ごとの数と長さ (累積)。和は missedFrames / missedMs に一致する */
  readonly missedByReason: Readonly<Record<AudioMissReason, AudioMissTotal>>;
  /** 直近に鳴らさなかった音 (古い順、最大 `MAX_RECENT_AUDIO_MISSES` 件) */
  readonly recentMisses: readonly AudioMissEvent[];
}

/** どの理由も 0 件の累積 */
function emptyMissTotals(): Record<AudioMissReason, AudioMissTotal> {
  const totals = {} as Record<AudioMissReason, AudioMissTotal>;
  for (const reason of AUDIO_MISS_REASONS) {
    totals[reason] = { count: 0, ms: 0 };
  }
  return totals;
}

/** 何も記録していないときの観測値 */
export const EMPTY_AUDIO_PLAYOUT_TIMING: AudioPlayoutTimingSnapshot = {
  lastTargetMs: null,
  lastArrivalMs: null,
  lastStartMs: null,
  lastSlackMs: null,
  lastStartDelayMs: null,
  lastLatenessMs: null,
  slackMs: null,
  startDelayMs: null,
  latenessMs: null,
  playedFrames: 0,
  playedMs: 0,
  arrivalPlannedFrames: 0,
  unplannedFrames: 0,
  missedFrames: 0,
  missedMs: 0,
  missedByReason: emptyMissTotals(),
  recentMisses: [],
};

/**
 * 鳴らさなかった 1 件を 1 行の文字列にする
 *
 * 時刻は UTC の ISO 8601 (ミリ秒まで) にする。映像の止まりの一覧
 * (`formatStallEvent`) と同じ形にし、relay や publisher のログと突き合わせるときに
 * 時差で迷わないため
 */
export function formatAudioMissEvent(miss: AudioMissEvent): string {
  const slack = miss.slackMs === null ? "slack=-" : `slack=${Math.round(miss.slackMs)} ms`;
  return [
    new Date(miss.wallClockMs).toISOString(),
    miss.reason,
    `${Math.round(miss.durationMs)} ms`,
    slack,
  ].join(" ");
}

/** 直近に鳴らすと決めた音の値 */
interface LastPlayRecord {
  readonly targetMs: number | null;
  readonly arrivalMs: number;
  readonly startMs: number;
  readonly slackMs: number | null;
  readonly startDelayMs: number;
  readonly latenessMs: number | null;
}

/**
 * 音声の再生の観測を記録し、観測値を求める
 */
export class AudioPlayoutTimingStats {
  private readonly windowMs: number;
  private readonly timeOriginMs: number;
  // 予定に対する余裕 (予定 - 到着) と、到着から鳴り始めるまでの時間、予定からの遅れ
  private readonly slacks = new TimedValues();
  private readonly startDelays = new TimedValues();
  private readonly latenesses = new TimedValues();
  private lastPlay: LastPlayRecord | null = null;
  // 予約したが、まだ鳴り始めていない音の区間 (ミリ秒)。鳴らさずに止めた分を数えるために持つ
  private pending: { startMs: number; endMs: number }[] = [];
  private playedFrames = 0;
  private playedMs = 0;
  private arrivalPlannedFrames = 0;
  private unplannedFrames = 0;
  private missedFrames = 0;
  private missedMs = 0;
  private missedTotals = emptyMissTotals();
  private recentMisses: AudioMissEvent[] = [];

  /**
   * @param windowMs - 分布を求める直近の窓 (ミリ秒)
   * @param timeOriginMs - `performance.timeOrigin`。鳴らさなかった時刻を壁時計に換算する
   */
  constructor(windowMs: number = AUDIO_PLAYOUT_TIMING_WINDOW_MS, timeOriginMs = 0) {
    this.windowMs = windowMs;
    this.timeOriginMs = timeOriginMs;
  }

  /**
   * 鳴らすと決めた音を記録する
   *
   * 余裕と遅れは、時間軸が決めた再生予定時刻との差である。到着基準で鳴らした音でも、
   * 時間軸が予定を決めていればその予定との差を記録する (音が予定よりどれだけ遅れて
   * 鳴っているかを読むため)。
   *
   * @param arrivalMs - 到着した時刻 (ミリ秒)
   * @param targetMs - 時間軸が決めた再生予定時刻 (ミリ秒)。決められないときは null
   * @param startMs - 鳴り始める時刻 (ミリ秒)
   * @param playedMs - 鳴る長さ (ミリ秒。詰めた分を引いた後)
   * @param basis - 鳴らす時刻を決めるのに使った計画。到着基準 (`arrival`) の音は
   *   `arrivalPlannedFrames` に数える
   */
  recordPlay(
    arrivalMs: number,
    targetMs: number | null,
    startMs: number,
    playedMs: number,
    basis: AudioPlayoutBasis,
  ): void {
    this.prunePending(arrivalMs);
    const startDelayMs = startMs - arrivalMs;
    const slackMs = targetMs === null ? null : targetMs - arrivalMs;
    const latenessMs = targetMs === null ? null : startMs - targetMs;
    this.startDelays.push(arrivalMs, startDelayMs);
    if (basis === "arrival") {
      // 到着基準の計画に載せた音である (時間軸が予定を決めていても使っていない)
      this.arrivalPlannedFrames++;
    } else if (targetMs === null) {
      // 到着基準の計画も持たない音。呼び出し側が計画を渡していない取りこぼしであり、
      // 通常は 0 になる
      this.unplannedFrames++;
    }
    if (slackMs !== null && latenessMs !== null) {
      this.slacks.push(arrivalMs, slackMs);
      this.latenesses.push(arrivalMs, latenessMs);
    }
    this.lastPlay = { targetMs, arrivalMs, startMs, slackMs, startDelayMs, latenessMs };
    this.playedFrames++;
    this.playedMs += Math.max(0, playedMs);
    this.pending.push({ startMs, endMs: startMs + Math.max(0, playedMs) });
  }

  /**
   * 鳴らさなかった音を記録する
   *
   * 音が捨てられた時刻で数える。予定と到着の両方が分かるときだけ、捨てた時点の余裕を残す
   */
  recordMiss(miss: AudioPlayoutMiss): void {
    this.prunePending(miss.atMs);
    const slackMs =
      miss.targetMs === null || miss.arrivalMs === null ? null : miss.targetMs - miss.arrivalMs;
    this.addMiss({
      wallClockMs: this.timeOriginMs + miss.atMs,
      reason: miss.reason,
      durationMs: miss.durationMs,
      slackMs,
    });
  }

  /**
   * 鳴らさずに再生を止めた分を記録する
   *
   * 予約済みでまだ鳴り始めていない音は、`AudioContext` を閉じる (再生の停止、購読の解除、
   * パネルの削除) と鳴らないまま切り捨てられる。ここで数えないと、この分はどの統計にも
   * 現れない。既に鳴り始めている音は、残りの長さだけを数える。
   *
   * @param nowMs - 止めた時刻 (ミリ秒)
   */
  recordStopped(nowMs: number): void {
    this.prunePending(nowMs);
    for (const pending of this.pending) {
      const remainingMs = pending.endMs - Math.max(pending.startMs, nowMs);
      if (remainingMs <= 0) {
        continue;
      }
      this.addMiss({
        wallClockMs: this.timeOriginMs + nowMs,
        reason: "stopped",
        durationMs: remainingMs,
        slackMs: null,
      });
    }
    this.pending = [];
  }

  /**
   * 観測値を求める
   *
   * @param nowMs - 求める時刻 (ミリ秒)。窓はこの時刻から遡る
   */
  snapshot(nowMs: number): AudioPlayoutTimingSnapshot {
    const minAtMs = nowMs - this.windowMs;
    for (const series of [this.slacks, this.startDelays, this.latenesses]) {
      series.prune(minAtMs);
    }
    const missedByReason = {} as Record<AudioMissReason, AudioMissTotal>;
    for (const reason of AUDIO_MISS_REASONS) {
      const total = this.missedTotals[reason];
      missedByReason[reason] = { count: total.count, ms: total.ms };
    }
    const last = this.lastPlay;
    return {
      lastTargetMs: last?.targetMs ?? null,
      lastArrivalMs: last?.arrivalMs ?? null,
      lastStartMs: last?.startMs ?? null,
      lastSlackMs: last?.slackMs ?? null,
      lastStartDelayMs: last?.startDelayMs ?? null,
      lastLatenessMs: last?.latenessMs ?? null,
      slackMs: summarizeTimings(this.slacks.current()),
      startDelayMs: summarizeTimings(this.startDelays.current()),
      latenessMs: summarizeTimings(this.latenesses.current()),
      playedFrames: this.playedFrames,
      playedMs: this.playedMs,
      arrivalPlannedFrames: this.arrivalPlannedFrames,
      unplannedFrames: this.unplannedFrames,
      missedFrames: this.missedFrames,
      missedMs: this.missedMs,
      missedByReason,
      recentMisses: [...this.recentMisses],
    };
  }

  /** 記録をすべて捨てて初期状態に戻す */
  reset(): void {
    this.slacks.clear();
    this.startDelays.clear();
    this.latenesses.clear();
    this.lastPlay = null;
    this.pending = [];
    this.playedFrames = 0;
    this.playedMs = 0;
    this.arrivalPlannedFrames = 0;
    this.unplannedFrames = 0;
    this.missedFrames = 0;
    this.missedMs = 0;
    this.missedTotals = emptyMissTotals();
    this.recentMisses = [];
  }

  /** 鳴り終わった予約を落とす */
  private prunePending(nowMs: number): void {
    this.pending = this.pending.filter((pending) => pending.endMs > nowMs);
  }

  /** 鳴らさなかった 1 件を累積と直近の一覧へ加える */
  private addMiss(miss: {
    wallClockMs: number;
    reason: AudioMissReason;
    durationMs: number;
    slackMs: number | null;
  }): void {
    const durationMs = Math.max(0, miss.durationMs);
    this.missedFrames++;
    this.missedMs += durationMs;
    const total = this.missedTotals[miss.reason];
    this.missedTotals[miss.reason] = { count: total.count + 1, ms: total.ms + durationMs };
    this.recentMisses.push({
      wallClockMs: miss.wallClockMs,
      reason: miss.reason,
      durationMs,
      slackMs: miss.slackMs,
    });
    if (this.recentMisses.length > MAX_RECENT_AUDIO_MISSES) {
      this.recentMisses.shift();
    }
  }
}
