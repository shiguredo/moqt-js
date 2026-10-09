/**
 * 音声の jitter buffer の目標遅延を、実際に鳴った結果から閉ループで決める
 *
 * `src/audioDelayManager.ts` の学習 (NetEq の移植) は「直近の窓で最も早く届いた音を基準に
 * した相対的な到着の遅れ」の分位点であり、経路の揺らぎは吸収できるが、**ストリーム全体が
 * 一様に遅れている分は見えない**。基準 (最小値) そのものが下へ動くため、相対の遅れは 0 の
 * ままになるためである。実際には、到着から鳴り始めるまでに復号・予約・出力のバッファ・
 * まとめて届いた山の分だけ時間がかかり、目標 (実測で 40 ms) より遅れて鳴る。すると
 * 予定を過ぎて鳴り続け、並べすぎの音が捨てられる。
 *
 * そこで、実際に観測した「予定をどれだけ過ぎて鳴ったか」(`latenessMs`) と「到着から鳴り
 * 始めるまで」(`startDelayMs`)、そして「並べすぎで捨てた量」(`missedByReason.backlog`) を
 * 見て目標を増減する。
 *
 * - 遅れが続くなら目標を増やす (乱れと、到着から鳴るまでの経路の分を吸収する)
 * - 並べすぎで捨てたなら、捨てた長さぶんを吸収できるだけ増やす
 * - 遅れが許容の中に収まり、捨てが無いなら目標を減らす (必要以上に遅らせない)
 * - 増減は毎秒 1 回までとし、1 回の増加は上限までにする (数秒スケール。行き過ぎを防ぐ)
 * - 目標は `AUDIO_DELAY_FEEDBACK_MIN_MS` から `AUDIO_DELAY_FEEDBACK_MAX_MS` の間に収める
 * - `targetLatencyMs` を明示設定したときは、その値を自動で超えない (呼び出し側が
 *   `setCeilingMs` で渡す)。NetEq が求めた遅れ (揺らぎの分) には掛けない。既存の
 *   揺らぎの吸収を変えないためである
 *
 * 判断に使う分布は、表示用の 10 秒の窓ではなく短い窓 (`AUDIO_DELAY_FEEDBACK_WINDOW_MS`) の
 * 値にする。目標を増やした結果が現れるまで 10 秒の窓は待つため、その窓だけで増やすと
 * 行き過ぎる (実測の遅れが消えた後も増え続けて上限に張り付く)。増やす量も、遅れの p50 を
 * 使う。まれな大きな跳ね (p95) まで吸収しようとすると、目標が上限に張り付いて遅延だけが
 * 増えるためである (映像の `MIN_PLAYOUT_DELAY_PERCENTILE` と同じ考え方)。
 *
 * 時刻は呼び出し側が引数で渡す。ブラウザ API に依存しない。
 */

import type { TimingSummary } from "./timingSummary";

/** 目標遅延の下限 (ミリ秒) */
export const AUDIO_DELAY_FEEDBACK_MIN_MS = 80;

/**
 * 目標遅延の上限 (ミリ秒)
 *
 * まれな大きな乱れまで吸収しようとすると、常に大きく遅れて鳴ることになるため上限を置く。
 * 表示の遅れの上限 (`MAX_PLAYOUT_DELAY_MS` = 500 ms) より小さく、実測の到着の跳ね
 * (最大 271 ms) を概ね収められる値にする
 */
export const AUDIO_DELAY_FEEDBACK_MAX_MS = 300;

/**
 * 最初の目標遅延 (ミリ秒)
 *
 * 観測がまだ無いときに使う。NetEq の初期値 (80 ms) より少し大きくし、到着から鳴るまでの
 * 経路の分を最初から見込む (実測の目標は 40 ms であり、これが小さすぎた)
 */
export const AUDIO_DELAY_FEEDBACK_START_MS = 100;

/**
 * 目標を動かす間隔 (ミリ秒)
 *
 * 数秒スケールで動かし、行き過ぎと往復を避ける。観測が来るたびに動かすと、増やした結果が
 * 観測へ現れる前に増やし続けて上限に張り付く
 */
export const AUDIO_DELAY_FEEDBACK_INTERVAL_MS = 1_000;

/**
 * 目標の判断に使う分布の窓 (ミリ秒)
 *
 * 表示用の 10 秒の窓 (`AUDIO_PLAYOUT_TIMING_WINDOW_MS`) は、目標を増やした結果が p50 へ
 * 現れるまでに数秒かかる。制御には短い窓を使う
 */
export const AUDIO_DELAY_FEEDBACK_WINDOW_MS = 1_000;

/**
 * 遅れを許容する量 (ミリ秒)
 *
 * これ以下なら「予定どおり鳴っている」とみなし、目標を減らす向きに動かす
 */
export const AUDIO_DELAY_FEEDBACK_TOLERANCE_MS = 10;

/** 目標を増やすときに足す余白 (ミリ秒)。許容の境目で往復しないようにする */
export const AUDIO_DELAY_FEEDBACK_MARGIN_MS = 20;

/** 1 回で増やす下限 (ミリ秒) */
export const AUDIO_DELAY_FEEDBACK_MIN_STEP_MS = 20;

/** 1 回で増やす上限 (ミリ秒)。数秒で収束させつつ、行き過ぎないようにする */
export const AUDIO_DELAY_FEEDBACK_MAX_STEP_MS = 40;

/**
 * 目標を減らす速さ (ミリ秒 / 秒)
 *
 * 増やす向きより遅くし、往復を避ける。速すぎると、遅れが現れるまでに下げすぎて
 * (観測の窓が追いつく前に) 遅れを作り直す
 */
export const AUDIO_DELAY_FEEDBACK_DECREASE_MS_PER_SECOND = 10;

/** 目標を動かした理由 */
export type AudioDelayFeedbackReason =
  // まだ動かしていない (初期値のまま)
  | "initial"
  // 並べすぎで捨てたため増やした
  | "backlog"
  // 予定を過ぎて鳴ったため増やした
  | "lateness"
  // 遅れが許容の中に収まり、捨てが無いため減らした
  | "settled"
  // 動かす条件がそろっていない (観測が無い、または前回から間隔が空いていない)
  | "waiting";

/**
 * 音声の再生の観測 (呼び出し側が `AudioPlayoutTimingStats` から渡す)
 *
 * 分布は `AUDIO_DELAY_FEEDBACK_WINDOW_MS` の窓の値である。捨てた量は購読の開始からの
 * 累積であり、このクラスが前回との差を取る
 */
export interface AudioDelayFeedbackObservation {
  /** 観測した時刻 (ミリ秒) */
  readonly atMs: number;
  /** 予定をどれだけ過ぎて鳴ったか (ミリ秒) の分布。まだ鳴らしていなければ null */
  readonly latenessMs: TimingSummary | null;
  /** 到着から鳴り始めるまでの時間 (ミリ秒) の分布。まだ鳴らしていなければ null */
  readonly startDelayMs: TimingSummary | null;
  /** 予定に対する余裕 (ミリ秒) の分布。まだ鳴らしていなければ null */
  readonly slackMs: TimingSummary | null;
  /** 並べすぎで捨てた音の数 (累積) */
  readonly backlogMisses: number;
  /** 並べすぎで捨てた音の長さ (ミリ秒、累積) */
  readonly backlogMs: number;
}

/** 閉ループの状態 (計器とテスト用) */
export interface AudioDelayFeedbackSnapshot {
  /** 閉ループが決めた目標遅延 (ミリ秒) */
  readonly targetMs: number;
  /** 揺らぎだけから求めた目標遅延 (NetEq、ミリ秒)。実際に使う値はこの値との大きい方 */
  readonly jitterTargetMs: number;
  /** 実際に使う目標遅延 (ミリ秒) */
  readonly appliedMs: number;
  /** 直前に目標を動かした理由 */
  readonly reason: AudioDelayFeedbackReason;
  /** 明示設定の上限 (ミリ秒)。無ければ null */
  readonly ceilingMs: number | null;
  /** 直前の制御で動かした量 (ミリ秒)。0 なら動かしていない */
  readonly lastChangeMs: number;
  /** 目標を動かした回数 */
  readonly adjustments: number;
  /** 直近の観測の、予定を過ぎて鳴った量 (ミリ秒) */
  readonly latenessP50Ms: number | null;
  /** 直近の観測の、到着から鳴り始めるまでの時間 (ミリ秒) */
  readonly startDelayP50Ms: number | null;
  /** 直近の観測の、予定に対する余裕 (ミリ秒) */
  readonly slackP50Ms: number | null;
}

/** 目標を上限と下限の中に収める */
function clampTarget(value: number, lowerMs: number, upperMs: number): number {
  return Math.min(Math.max(value, lowerMs), upperMs);
}

/**
 * 音声の目標遅延を、実際に鳴った結果から決める
 *
 * 音声トラックごとではなく、共有の時間軸 (`PlaybackTimeline`) に 1 つ持つ。目標は
 * 到着から鳴るまでの経路 (復号・予約・出力のバッファ) の学習であり、購読のやり直しや
 * TIMESTAMP の段差では変わらないためである。
 */
export class AudioDelayFeedback {
  private targetMs = AUDIO_DELAY_FEEDBACK_START_MS;
  private reason: AudioDelayFeedbackReason = "initial";
  // 明示設定の上限 (catalog の targetLatency)。無ければ null
  private ceilingMs: number | null = null;
  private lastUpdateAtMs: number | null = null;
  private lastBacklogMisses = 0;
  private lastBacklogMs = 0;
  private lastChangeMs = 0;
  private adjustments = 0;
  private latest: AudioDelayFeedbackObservation | null = null;
  // 実際に鳴った結果を 1 つでも観測したか。観測が無い間は閉ループの目標を使わない
  private observed = false;

  /**
   * 明示設定の上限を渡す (`targetLatencyMs`)
   *
   * 自動で決めた目標がこれを超えないようにする。値が変わった時点で、既に超えていれば
   * その場で収める
   */
  setCeilingMs(value: number | null): void {
    this.ceilingMs = value;
    this.targetMs = clampTarget(this.targetMs, AUDIO_DELAY_FEEDBACK_MIN_MS, this.upperMs());
  }

  /** 今の上限 (ミリ秒) */
  get ceiling(): number | null {
    return this.ceilingMs;
  }

  /** 閉ループが決めた目標 (ミリ秒)。揺らぎだけの目標を含まない */
  get feedbackTargetMs(): number {
    return clampTarget(this.targetMs, AUDIO_DELAY_FEEDBACK_MIN_MS, this.upperMs());
  }

  /**
   * 実際に使う目標遅延 (ミリ秒)
   *
   * 揺らぎだけから求めた目標 (NetEq) と、閉ループが決めた目標の大きい方にする。上限は
   * 閉ループの値にだけ掛ける。NetEq の値は既存の揺らぎの吸収そのものであり、明示設定で
   * 切り下げると挙動が変わるためである
   *
   * 実際に鳴った結果をまだ 1 つも観測していないときは、閉ループの目標を使わず
   * `jitterTargetMs` をそのまま返す。閉ループは観測を入力にする制御であり、観測が無い間に
   * 目標を動かすと、まだ鳴らしていない間の表示の遅れ (購読を始めた直後の基準) が変わる
   *
   * @param jitterTargetMs - 揺らぎだけから求めた目標遅延 (ミリ秒)
   */
  targetDelayMs(jitterTargetMs: number): number {
    if (!this.observed) {
      return jitterTargetMs;
    }
    return Math.max(jitterTargetMs, this.feedbackTargetMs);
  }

  /**
   * 観測を 1 つ受け取り、必要なら目標を動かす
   *
   * 目標を動かすのは `AUDIO_DELAY_FEEDBACK_INTERVAL_MS` ごとに 1 回だけである。観測の窓が
   * 短いため、間隔を空けずに動かすと、増やした結果が現れる前に増やし続ける
   */
  update(observation: AudioDelayFeedbackObservation): void {
    this.latest = observation;
    // 1 つでも観測を受けたら、以降は閉ループの目標を使う
    this.observed = true;
    const elapsedMs =
      this.lastUpdateAtMs === null ? null : Math.max(0, observation.atMs - this.lastUpdateAtMs);
    if (elapsedMs !== null && elapsedMs < AUDIO_DELAY_FEEDBACK_INTERVAL_MS) {
      // まだ間隔に達していない。目標は動かさない
      this.reason = "waiting";
      return;
    }
    // 累積の捨てを、前回からの差にする (購読のやり直しで 0 に戻っても負にしない)
    const backlogDelta = Math.max(0, observation.backlogMisses - this.lastBacklogMisses);
    const backlogMsDelta = Math.max(0, observation.backlogMs - this.lastBacklogMs);
    this.lastBacklogMisses = observation.backlogMisses;
    this.lastBacklogMs = observation.backlogMs;
    this.lastUpdateAtMs = observation.atMs;

    const latenessP50Ms = observation.latenessMs?.p50 ?? null;
    const previousTargetMs = this.feedbackTargetMs;
    let changeMs: number;
    if (backlogDelta > 0) {
      // 並べすぎで捨てた。捨てた長さぶんを吸収できるだけ増やす
      changeMs = clampTarget(
        backlogMsDelta + AUDIO_DELAY_FEEDBACK_MARGIN_MS,
        AUDIO_DELAY_FEEDBACK_MIN_STEP_MS,
        AUDIO_DELAY_FEEDBACK_MAX_STEP_MS,
      );
      this.reason = "backlog";
    } else if (latenessP50Ms !== null && latenessP50Ms > AUDIO_DELAY_FEEDBACK_TOLERANCE_MS) {
      // 予定を過ぎて鳴っている。過ぎた分を吸収できるだけ増やす
      changeMs = clampTarget(
        latenessP50Ms - AUDIO_DELAY_FEEDBACK_TOLERANCE_MS + AUDIO_DELAY_FEEDBACK_MARGIN_MS,
        AUDIO_DELAY_FEEDBACK_MIN_STEP_MS,
        AUDIO_DELAY_FEEDBACK_MAX_STEP_MS,
      );
      this.reason = "lateness";
    } else if (latenessP50Ms !== null) {
      // 遅れが許容の中に収まり、捨てが無い。余裕が続くため減らす。減らす速さは前回の
      // 観測からの時間で決めるため、前回が無いときは動かさない (1 回の観測だけで
      // 「余裕が続いている」とは言えない)
      if (elapsedMs === null) {
        this.reason = "waiting";
        return;
      }
      changeMs = -(AUDIO_DELAY_FEEDBACK_DECREASE_MS_PER_SECOND * elapsedMs) / 1_000;
      this.reason = "settled";
    } else {
      // まだ鳴らしていないため、遅れが分からない。目標は動かさない
      this.reason = "waiting";
      return;
    }
    this.targetMs = clampTarget(
      this.targetMs + changeMs,
      AUDIO_DELAY_FEEDBACK_MIN_MS,
      this.upperMs(),
    );
    this.lastChangeMs = this.targetMs - previousTargetMs;
    if (this.lastChangeMs !== 0) {
      this.adjustments += 1;
    }
  }

  /**
   * 閉ループの状態を求める (計器用)
   *
   * @param jitterTargetMs - 揺らぎだけから求めた目標遅延 (ミリ秒)
   */
  snapshot(jitterTargetMs: number): AudioDelayFeedbackSnapshot {
    return {
      targetMs: this.feedbackTargetMs,
      jitterTargetMs,
      appliedMs: this.targetDelayMs(jitterTargetMs),
      reason: this.reason,
      ceilingMs: this.ceilingMs,
      lastChangeMs: this.lastChangeMs,
      adjustments: this.adjustments,
      latenessP50Ms: this.latest?.latenessMs?.p50 ?? null,
      startDelayP50Ms: this.latest?.startDelayMs?.p50 ?? null,
      slackP50Ms: this.latest?.slackMs?.p50 ?? null,
    };
  }

  /**
   * 学習を消して初期状態に戻す
   *
   * 目標は「到着から鳴るまでの経路」の学習であり購読のやり直しでは変わらないため、
   * 通常は呼ばない (購読のやり直しで目標を初期値へ戻すと、その間だけ遅れが戻る)
   */
  reset(): void {
    this.targetMs = AUDIO_DELAY_FEEDBACK_START_MS;
    this.reason = "initial";
    this.lastUpdateAtMs = null;
    this.lastBacklogMisses = 0;
    this.lastBacklogMs = 0;
    this.lastChangeMs = 0;
    this.adjustments = 0;
    this.latest = null;
    this.observed = false;
  }

  /** 今の上限 (ミリ秒)。明示設定が無ければ `AUDIO_DELAY_FEEDBACK_MAX_MS` */
  private upperMs(): number {
    return Math.min(AUDIO_DELAY_FEEDBACK_MAX_MS, this.ceilingMs ?? AUDIO_DELAY_FEEDBACK_MAX_MS);
  }
}
