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
 *   TIMESTAMP から `src/playout/timeline.ts` が決めた時刻であり、鳴り始める時刻は
 *   `AudioContext` の時計へ予約した時刻を `AudioClockBridge` で同じ軸へ換算した値である
 *   (音声出力の遅延は含まない)
 * - 分布 (p50 / p95 / max) は直近の窓 (既定 10 秒) の値から求める
 * - 鳴らなかった量は購読の開始 (reset) からの累積である。理由ごとに数え、和は合計に一致する
 * - 鳴ったが無音だった区間 (穴)、バッファ境界の段差、予約の追い越しも累積で数える。
 *   実リレーの波形収録では、鳴らした音の境界にデジタル無音が入り、その両端がクリックに
 *   なっていた。鳴らなかった音の計器だけでは検出できなかったため、出力の穴として数える
 * - 時間軸の再生予定時刻を使わずに鳴らした音 (LOC TIMESTAMP が壁時計でない、jitter buffer
 *   が無効、トラックの基準が共有されていない) は、到着から一定の遅れで鳴らす計画に載せ、
 *   `arrivalPlannedFrames` に数える。時間軸が予定を決めていれば、その予定との差 (余裕と
 *   遅れ) は分布へ入れる (`unplannedFrames` は、どちらの計画も持たないまま鳴らした音の数)
 * - ブラウザ API に依存しない。時刻は呼び出し側が引数で渡す
 */

import type { AudioPlayoutBasis } from "./audioPlayout";
import {
  AUDIO_DELAY_FEEDBACK_WINDOW_MS,
  type AudioDelayFeedbackObservation,
} from "./audioDelayFeedback";
import { TimedValues } from "./timedValues";
import { summarizeTimings, type TimingSummary } from "./timingSummary";

/** 分布を求める直近の窓 (ミリ秒)。映像の Playout Timing と同じ長さにする */
export const AUDIO_PLAYOUT_TIMING_WINDOW_MS = 10_000;

/** 残す直近の「鳴らさなかった音」の数 */
export const MAX_RECENT_AUDIO_MISSES = 30;

/**
 * バッファ境界の段差を異常とみなす振幅 (0 から 1)
 *
 * 実リレーの 440 Hz トーンの正常な 1 階差分は p99.9 で 0.0174 であり、その約 3 倍を
 * 異常とする (実リレーの波形計測の判定と同じ倍率)。自然な差分は音の種類で変わるため、
 * 値を絶対値で決めるのではなく、記録した最大値と併せて読む
 */
export const AUDIO_PLAYOUT_BOUNDARY_STEP_THRESHOLD = 0.05;

/**
 * 鳴らさなかった理由
 *
 * - `backlog`: 並べすぎて捨てた (再生が追いついていない)
 * - `catchUp`: relay の cache から追いつく途中で鳴らさなかった (意図的なもの)
 * - `error`: 鳴らす準備 (詰め・補間・予約) の途中で失敗した
 * - `stopped`: 予約したまま再生を止めた (予約済みの音が切り捨てられた)
 *
 * 鳴り遅れを理由に捨てることはない。音がまだ鳴っている間は遅れたまま鳴らし続け、音が
 * 途切れたときだけ到着基準へ並べ直す (src/playout/audioPlayout.ts)
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
   * 到着基準の計画で鳴らした音の数 (累積)
   *
   * 時間軸の再生予定時刻を使えなかった音 (TIMESTAMP が壁時計でない、jitter buffer が無効)
   * だけでなく、予定を決められても使わなかった音 (揃える相手がいないため `enforceTarget` が
   * false のとき。音声だけの購読) も数える。したがって、この数だけでは「時間軸が目標を
   * 決められていない」と読めない。予定を決められた音が 1 つも無ければ `slackMs` と
   * `latenessMs` のどちらも null になるため、時間軸が予定を決められているかはその 2 つで読む
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
  /**
   * 時間圧縮と補間を使えないサンプルレートで鳴らした音の数 (累積)
   *
   * 4 kHz へ間引くフィルタの表 (8 / 16 / 32 / 48 kHz) に無いサンプルレート (44.1 kHz の
   * AAC など) では、ピッチの周期を求められないため時間圧縮も補間も働かない。落ちずに
   * 「操作しない」を返すので、この数が増えていることで気付く
   * (`src/playout/audioTimeStretch.ts` の `isTimeStretchAvailable`)。0 なら使えている
   */
  readonly stretchUnavailableFrames: number;
  /**
   * 穴として残した回数 (累積)
   *
   * 前の音の終わりと今回の音の開始の間の隙間から、実際に補間で埋めた長さを引いた残りを
   * 1 回として数える。予約できる最も早い時刻より前だった分 (アンダーランと余裕不足)、
   * 補間が失敗した分、補間の上限 (100 ms) を超えた分を含む。補間の生成長は半サンプル以内で
   * 丸められるため、その範囲の差は補間で埋まったものとして数えない。購読の開始からの累積で
   * あり、波形を収録して数えた無音の区間 (収録区間だけ) とは範囲が違うため一致しない
   */
  readonly gapCount: number;
  /**
   * 穴として残した長さの合計 (ミリ秒、累積)
   *
   * 「補間で埋まらなかった長さ」である。2 ms のフェードは補間の長さに数えるため含まない。
   * 秒単位の長い途絶 (配信の停止、経路の断) も 1 回の穴として含む。購読の開始からの累積で
   * あり、波形を収録して数えた無音の合計 (収録区間だけ) とは範囲が違うため一致しないほか、
   * フェード中のサンプルは 0 でないためビット完全な 0 の合計とも一致しない。クリックは 0 の
   * 長さではなく境界の段差で決まるため、`boundaryStepCount` / `boundaryStepMax` と併せて読む
   */
  readonly gapMs: number;
  /** 穴として残した 1 回の最大 (ミリ秒。記録期間中の最大であり、最初の音より前の無音は含まない) */
  readonly gapMaxMs: number;
  /**
   * 予約できる最も早い時刻より前だった無音の回数 (累積)
   *
   * `gapCount` のうち、前の音の終わりが「今 + 余裕」より前だったために補間バッファを
   * 置けなかった回数である。既に過去の分だけでなく、今より未来でも余裕に満たない分も含む。
   * 事後には埋められないため、目標遅延を増やす判断に使う
   */
  readonly unrecoverableGapCount: number;
  /** 予約できなかった無音の合計 (ミリ秒、累積)。`gapMs` に含まれる */
  readonly unrecoverableGapMs: number;
  /**
   * 予約した時刻を `AudioContext.currentTime` が追い越した回数 (累積)
   *
   * `source.start(when)` の直前に読んだ `currentTime` が `when` を過ぎていた回数である。
   * Web Audio は過去の時刻を即時開始にするため、1 件でも出たら直前の音と重なっている
   * 可能性がある (重なりそのものはこの計器では分からない)
   */
  readonly lateStartCount: number;
  /** 予約を追い越した最大の長さ (ミリ秒。記録期間中の最大) */
  readonly lateStartMaxMs: number;
  /**
   * バッファ境界の段差が `AUDIO_PLAYOUT_BOUNDARY_STEP_THRESHOLD` を超えた回数 (累積)
   *
   * すべてのバッファ境界の段差 (直前のバッファの末尾と次のバッファの先頭の差) を測り、
   * しきい値を超えた回数を数える。無音の穴の前後と、media 時刻が飛んだ境界 (損失・復号器の
   * 作り直し) のほか、通常の音の切れ目も含む。しきい値は 440 Hz のトーンの正常な 1 階差分
   * から決めた絶対値であり、実音声では正常な段差がこれを超えることがある
   */
  readonly boundaryStepCount: number;
  /** バッファ境界の段差の最大 (0 から 1 の振幅。記録期間中の最大) */
  readonly boundaryStepMax: number;
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
  stretchUnavailableFrames: 0,
  gapCount: 0,
  gapMs: 0,
  gapMaxMs: 0,
  unrecoverableGapCount: 0,
  unrecoverableGapMs: 0,
  lateStartCount: 0,
  lateStartMaxMs: 0,
  boundaryStepCount: 0,
  boundaryStepMax: 0,
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
  // まだ鳴り終わっていない音の区間 (ミリ秒)。鳴らさずに止めた分を数えるために持つ
  // (鳴り始めていても終わっていない区間を含む。`recordStopped` が残りの長さを数える)
  private pending: { startMs: number; endMs: number }[] = [];
  private playedFrames = 0;
  private playedMs = 0;
  private arrivalPlannedFrames = 0;
  private unplannedFrames = 0;
  private missedFrames = 0;
  private missedMs = 0;
  private missedTotals = emptyMissTotals();
  private recentMisses: AudioMissEvent[] = [];
  private stretchUnavailableFrames = 0;
  // 補間で埋まらなかった無音の穴 (回数・合計 ms・最大 ms) と、そのうち予約できなかった分
  private gapCount = 0;
  private gapMs = 0;
  private gapMaxMs = 0;
  private unrecoverableGapCount = 0;
  private unrecoverableGapMs = 0;
  // 予約した時刻を currentTime が追い越した回数と最大 (ms)
  private lateStartCount = 0;
  private lateStartMaxMs = 0;
  // バッファ境界の段差 (しきい値を超えた回数と最大)
  private boundaryStepCount = 0;
  private boundaryStepMax = 0;

  /**
   * @param windowMs - 分布を求める直近の窓 (ミリ秒)。既定値を置かないのは、窓の長さが
   *   統計の読み方を決める値であり、呼び出し側が選ぶものだからである
   * @param timeOriginMs - `performance.timeOrigin`。鳴らさなかった時刻を壁時計に換算する。
   *   既定を置くと `AudioMissEvent.wallClockMs` が 1970 年になり、relay や publisher の
   *   ログと突き合わせられなくなる (この値を `formatAudioMissEvent` が UTC の ISO 8601 で
   *   出す) ため、受け取ることを必須にする
   */
  constructor(windowMs: number, timeOriginMs: number) {
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
    // 前の音の終わりへ揃えるスナップで、音が予定より最大 0.5 ms 早く鳴ることがある。
    // playout 側の遅れ (`AudioPlayoutScheduler.latenessSeconds`) と同じく 0 で丸める
    const latenessMs = targetMs === null ? null : Math.max(0, startMs - targetMs);
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
   * 目標遅延を閉ループで決めるための観測を求める
   *
   * 表示用の分布 (`snapshot`) は直近 10 秒の窓である。目標を増やした結果がそこへ現れる
   * までには数秒かかるため、制御には短い窓 (`AUDIO_DELAY_FEEDBACK_WINDOW_MS`) の値を使う。
   * 捨てた量は購読の開始からの累積であり、差を取るのは呼び出し側 (`AudioDelayFeedback`) の
   * 仕事である (`src/playout/audioDelayFeedback.ts`)
   *
   * 揺らぎだけから求めた目標 (NetEq) は時間軸が持っているため、この戻り値には含めない
   * (`PlayoutTimeline.observeAudioPlayout` が足す)。圧縮の増分も購読側
   * (`AudioPlayoutSession`) が足す (省略したときは 0 とみなされる)
   *
   * @param nowMs - 求める時刻 (ミリ秒)
   */
  audioDelayFeedback(nowMs: number): Omit<AudioDelayFeedbackObservation, "jitterTargetMs"> {
    // 表示用の分布と同じ長さまでを残し、制御にはその中でも短い窓を使う
    const minAtMs = nowMs - this.windowMs;
    for (const series of [this.slacks, this.startDelays, this.latenesses]) {
      series.prune(minAtMs);
    }
    const controlMinAtMs = nowMs - AUDIO_DELAY_FEEDBACK_WINDOW_MS;
    return {
      atMs: nowMs,
      latenessMs: summarizeTimings(this.latenesses.since(controlMinAtMs)),
      startDelayMs: summarizeTimings(this.startDelays.since(controlMinAtMs)),
      slackMs: summarizeTimings(this.slacks.since(controlMinAtMs)),
      backlogMisses: this.missedTotals.backlog.count,
      backlogMs: this.missedTotals.backlog.ms,
      // 補間で埋まらなかった無音の穴。目標遅延を増やす判断に使う
      gapCount: this.gapCount,
      gapMs: this.gapMs,
    };
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
      stretchUnavailableFrames: this.stretchUnavailableFrames,
      gapCount: this.gapCount,
      gapMs: this.gapMs,
      gapMaxMs: this.gapMaxMs,
      unrecoverableGapCount: this.unrecoverableGapCount,
      unrecoverableGapMs: this.unrecoverableGapMs,
      lateStartCount: this.lateStartCount,
      lateStartMaxMs: this.lateStartMaxMs,
      boundaryStepCount: this.boundaryStepCount,
      boundaryStepMax: this.boundaryStepMax,
    };
  }

  /**
   * 穴として残した区間を 1 つ記録する
   *
   * 呼び出し側 (`AudioPlayoutSession`) が、隙間の合計から実際に補間で埋めた長さを引いた
   * 残りを渡す。端の 2 ms フェードは補間の長さに数えるため、この値には含まれない。
   * 予約できる最も早い時刻より前だった長さは `unrecoverableMs` として別に数える
   * (`unrecoverableMs` は `uncoveredMs` に含まれる)
   *
   * @param gap.uncoveredMs - 補間で埋まらなかった長さ (ミリ秒。0 以下と非有限は無視する)
   * @param gap.unrecoverableMs - そのうち予約できる最も早い時刻より前だった長さ (ミリ秒)
   */
  recordGap(gap: { uncoveredMs: number; unrecoverableMs: number }): void {
    if (!Number.isFinite(gap.uncoveredMs) || !Number.isFinite(gap.unrecoverableMs)) {
      return;
    }
    const uncoveredMs = Math.max(0, gap.uncoveredMs);
    if (uncoveredMs <= 0) {
      return;
    }
    this.gapCount += 1;
    this.gapMs += uncoveredMs;
    this.gapMaxMs = Math.max(this.gapMaxMs, uncoveredMs);
    const unrecoverableMs = Math.min(uncoveredMs, Math.max(0, gap.unrecoverableMs));
    if (unrecoverableMs > 0) {
      this.unrecoverableGapCount += 1;
      this.unrecoverableGapMs += unrecoverableMs;
    }
  }

  /**
   * 予約した時刻を `AudioContext.currentTime` が追い越したことを記録する
   *
   * @param lateMs - 追い越した長さ (ミリ秒)。0 以下と非有限なら記録しない
   */
  recordLateStart(lateMs: number): void {
    if (!Number.isFinite(lateMs) || !(lateMs > 0)) {
      return;
    }
    this.lateStartCount += 1;
    this.lateStartMaxMs = Math.max(this.lateStartMaxMs, lateMs);
  }

  /**
   * バッファ境界の段差を 1 つ記録する
   *
   * 段差が `AUDIO_PLAYOUT_BOUNDARY_STEP_THRESHOLD` を超えたときだけ回数を数え、最大は
   * しきい値以下でも更新する (実際にどれだけ近づいたかを読めるようにする)
   *
   * @param step - 境界の段差 (0 から 1 の振幅)。非有限なら記録しない
   */
  recordBoundaryStep(step: number): void {
    if (!Number.isFinite(step)) {
      return;
    }
    const amplitude = Math.abs(step);
    this.boundaryStepMax = Math.max(this.boundaryStepMax, amplitude);
    if (amplitude > AUDIO_PLAYOUT_BOUNDARY_STEP_THRESHOLD) {
      this.boundaryStepCount += 1;
    }
  }

  /**
   * 時間圧縮と補間を使えないサンプルレートの音を 1 つ数える
   *
   * 鳴らす側 (`src/playout/audioPlayoutSession.ts`) が、音を渡す前に
   * `isTimeStretchAvailable` で確かめて呼ぶ。数えるだけで鳴らし方は変えない
   */
  recordStretchUnavailable(): void {
    this.stretchUnavailableFrames++;
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
    this.stretchUnavailableFrames = 0;
    this.gapCount = 0;
    this.gapMs = 0;
    this.gapMaxMs = 0;
    this.unrecoverableGapCount = 0;
    this.unrecoverableGapMs = 0;
    this.lateStartCount = 0;
    this.lateStartMaxMs = 0;
    this.boundaryStepCount = 0;
    this.boundaryStepMax = 0;
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
