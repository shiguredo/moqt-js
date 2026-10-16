/**
 * 音声の jitter buffer の目標遅延を、実際に鳴った結果から閉ループで決める
 *
 * `src/playout/audioDelayEstimator.ts` の学習 (NetEq の移植) は「直近の窓で最も早く届いた音を基準に
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
 * - 目標は `AUDIO_DELAY_FEEDBACK_MIN_MS` から、**実際に適用される上限**の間に収める
 *   (`upperMs()` = min(AUDIO_DELAY_FEEDBACK_MAX_MS, ceilingMs, appliedCeilingMs))。適用も同じ
 *   上限 (`targetDelayMs` が `appliedCeilingMs` で切る) を使うため、内部の目標が適用されない
 *   ことはない。以前は適用側が常に 100 ms で切っていたため、内部の目標だけがそれを超えて
 *   育つと超えた分は決して適用されず、遅れが収まった後に減らし切るまで (毎秒
 *   `AUDIO_DELAY_FEEDBACK_DECREASE_MS_PER_SECOND`) の時間だけ復帰が遅れていた
 *   (実測: 内部 198.4 ms / 適用 100 ms。この差 98.4 ms を減らすのに 10 秒かかった)。
 *   実測 198.4 ms は `docs/AUDIO_PLAYOUT_LATENCY.md` の 2026-10-16 の計測にある
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

/**
 * 目標遅延の下限 (ミリ秒)
 *
 * 閉ループが「遅れが許容の中に収まり、捨てが無い」と判断して下げ続けても、これ以下には
 * しない。時間軸側の下限 (`AUDIO_PLAYOUT_DELAY_FLOOR_MS`) と同じ値にする。閉ループの値は
 * 到着基準で鳴らすときの遅れと、映像を合わせる先の両方に効くため、片方だけを変えると
 * 基準を共有できない状態で A/V のずれが残る
 *
 * 値は実リレーの実測で決めた (表と根拠は `src/playout/timeline.ts` の
 * `AUDIO_PLAYOUT_DELAY_FLOOR_MS` にある)。観測が無い間の NetEq の初期値
 * (`AUDIO_DELAY_START_MS` = 80 ms) とは別の値であり、揃える必要はない。初期値は閉ループの
 * 観測が始まる前にだけ使われ、閉ループは観測が 1 つでも届けば目標を実測から動かす
 */
export const AUDIO_DELAY_FEEDBACK_MIN_MS = 50;

/**
 * 目標遅延の上限 (ミリ秒。src/playout/timeline.ts の AUDIO_PLAYOUT_ARRIVAL_DELAY_MS と同値)
 *
 * 実際に鳴らす側へ渡す値の上限である (`targetDelayMs`)。閉ループが決めた目標も、この値で
 * 切ってから持つ。内部の目標だけがこれを超えて育つと、超えた分は決して適用されないまま
 * 残り、遅れが収まってから減らし切るまでの間ずっと「適用は 100 ms のまま」になる
 * (欠陥 5。実測: 内部 198.4 ms / 適用 100 ms)。NetEq が求めた揺らぎの分は、この値で
 * 切られる前から `targetDelayMs` が切るため、内部の目標として持つ必要が無い
 */
export const AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS = 100;

/**
 * 圧縮 (時間圧縮) が続くときにだけ使う上限 (ミリ秒)
 *
 * 既定の上限 (`AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS` = 100 ms) を超えて目標を上げてよいのは、
 * 圧縮 = 粗さが続いているときだけである。圧縮は「経路が 100 ms では足りていない」証拠で
 * あり、目標を上げれば遅れて届く音が減って圧縮そのものが減る。実測 (2026-10-16、実リレー
 * 60 秒) では揺らぎだけの目標 (NetEq) が 100〜340 ms に育ち、上限 100 ms が常時拘束されて
 * 時間圧縮が 60 秒で 550〜1000 ms (静かな回でも 556〜996 ms) 続いた。上限を静的に 160 ms へ
 * 上げると圧縮は約 3 割減る回がある一方、鳴り始めが 115 ms から 155 ms へ +40 ms になる
 * (2026-10-15 の A/B と同日の計測)。160 ms は、実測の揺らぎ (100〜340 ms) の下限側と遅延の
 * 代償 (+40 ms) の釣り合いで決めた、圧縮を止められる最小限の幅である
 */
export const AUDIO_DELAY_FEEDBACK_ARTIFACT_CEILING_MS = 160;

/**
 * 上限を上げる根拠にする圧縮の速さ (ミリ秒 / 秒)
 *
 * 実測の圧縮は 60 秒で 550〜1000 ms であり、毎秒 9〜17 ms に相当する。5 ms/秒 はその半分
 * 以下である。不感帯 (20 ms) を超える遅れが続く正常な状態でも数 ms/秒 の圧縮は出るため
 * (実測: 圧縮が 0 だった秒は 59 秒中 4〜7 秒)、これを下回る圧縮で上限を上げると遅延の代償
 * だけを払うことになる。逆に、これを超える圧縮が続くなら 100 ms では足りていないと
 * 判断できる
 */
export const AUDIO_DELAY_FEEDBACK_COMPRESSION_MIN_MS_PER_SECOND = 5;

/**
 * 上限を上げるまでに、圧縮が続くのを待つ時間 (ミリ秒)
 *
 * 到着が一時的に乱れただけでも圧縮は出る。2 秒続いたときだけ「経路が 100 ms では足りない」と
 * みなす。詰め始めてから、その結果が観測の窓 (1 秒) に現れるまでを待つ意味もある。制御は
 * 毎秒 1 回であるため、観測 2 回ぶんになる
 */
export const AUDIO_DELAY_FEEDBACK_COMPRESSION_CONFIRM_MS = 2_000;

/**
 * 上限を 100 ms へ戻すまでに、圧縮が 0 で経路が静かな状態が続くのを待つ時間 (ミリ秒)
 *
 * 戻す条件に「揺らぎだけの目標 (`jitterTargetMs`) が 100 ms 以下」を必ず入れる。圧縮が 0 に
 * なっただけで戻すと、揺らぎが 100 ms を超えている経路では、戻した直後に遅れが生じて圧縮が
 * 再発し、2 秒でまた 160 ms へ上げる往復になる (周期 20 秒前後で遅延が 60 ms 上下する)。
 * 15 秒は、実測のまれな跳ね (最大 271 ms) が引いてから揺らぎの推定が下がるまでの数秒より
 * 十分に長い
 */
export const AUDIO_DELAY_FEEDBACK_ARTIFACT_RELEASE_MS = 15_000;

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
  /**
   * 前の観測から増えた圧縮 (時間圧縮) の長さ (ミリ秒、増分)
   *
   * 購読側 (`AudioPlayoutSession`) が `AudioPlayoutScheduler.compressed` (秒) の増分を渡す。
   * 観測は音ごとに来るが、制御は毎秒 1 回であるため、このクラスが制御までの間を足し合わせて
   * 速さ (ミリ秒 / 秒) を求める。累積ではなく増分を渡すのは、購読のやり直しで累積が 0 に
   * 戻っても負の差を作らないためである。省いたときは 0 (圧縮なし) とみなす (購読側以外が
   * 作る観測では分からない値である)
   */
  readonly compressionMs?: number;
  /**
   * 揺らぎだけから求めた目標遅延 (NetEq、ミリ秒)
   *
   * 上限を 100 ms へ戻してよいかの判断に使う。「圧縮が 0」だけでは、揺らぎが 100 ms を
   * 超えている経路で上限を戻した直後に圧縮が再発する (往復になる)。この値が 100 ms 以下で
   * あることを戻す条件に加える
   */
  readonly jitterTargetMs: number;
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
  /**
   * 実際に適用する値に掛けている上限 (ミリ秒)
   *
   * 広げていないときは `AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS` (100 ms)。圧縮が続くと
   * `AUDIO_DELAY_FEEDBACK_ARTIFACT_CEILING_MS` (160 ms) まで広がるが、明示設定
   * (`ceilingMs`) があるときはその値までに切る (既定の 100 ms は下回らない)。実際に適用
   * された値は `appliedMs` に出る
   */
  readonly appliedCeilingMs: number;
  /** 直近の制御で観測した圧縮の速さ (ミリ秒 / 秒)。上限を上げる判断に使った値 */
  readonly compressionMsPerSecond: number;
}

/** 目標を上限と下限の中に収める */
function clampTarget(value: number, lowerMs: number, upperMs: number): number {
  return Math.min(Math.max(value, lowerMs), upperMs);
}

/**
 * 音声の目標遅延を、実際に鳴った結果から決める
 *
 * 音声トラックごとではなく、共有の時間軸 (`PlayoutTimeline`) に 1 つ持つ。目標は
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
  // 閉ループへ観測が 1 つでも届いたか。届くまでは閉ループの目標を使わない。鳴っていない音の
  // 観測 (捨てた音の通知) でも true になるため、「実際に鳴った結果を観測したか」ではない
  // (`targetDelayMs` が参照する)
  private receivedObservation = false;
  // 圧縮が続くため上限を 160 ms へ広げているか
  private artifactCeilingActive = false;
  // 上限を上げる根拠 (圧縮の速さが閾値を超えた状態) が続いている時間 (ミリ秒)
  private compressionStreakMs = 0;
  // 上限を戻す条件 (圧縮が 0 で、揺らぎだけの目標が 100 ms 以下) が続いている時間 (ミリ秒)
  private quietStreakMs = 0;
  // 前回の制御から増えた圧縮の合計 (ミリ秒)。観測のたびに足し、制御のたびに 0 に戻す
  private compressionSinceUpdateMs = 0;
  // 直近の制御で観測した圧縮の速さ (ミリ秒 / 秒)。計器に出す
  private compressionMsPerSecond = 0;

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
   * `jitterTargetMs` を上限 (`AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS` = 100 ms) で切って返す。
   * 閉ループは観測を入力にする制御であり、観測が無い間に目標を動かすと、まだ鳴らしていない
   * 間の表示の遅れ (購読を始めた直後の基準) が変わる
   *
   * この値に掛ける上限は、圧縮が続いているときだけ `AUDIO_DELAY_FEEDBACK_ARTIFACT_CEILING_MS`
   * (160 ms) になる。圧縮は経路が 100 ms では足りていない証拠であり、そのときだけ遅延の
   * 代償を払う。明示設定 (`targetLatencyMs`) は閉ループの目標にだけ掛ける (既存の規則)
   *
   * @param jitterTargetMs - 揺らぎだけから求めた目標遅延 (ミリ秒)
   */
  targetDelayMs(jitterTargetMs: number): number {
    if (!this.receivedObservation) {
      return Math.min(jitterTargetMs, AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS);
    }
    // 実際に使う値に掛ける上限は、圧縮が続くときだけ広げる (`appliedCeilingMs`)。明示設定
    // (`targetLatencyMs`) は、広げる分にだけ掛ける (既存の規則。揺らぎだけの目標は
    // 切り下げない)
    return Math.min(Math.max(jitterTargetMs, this.feedbackTargetMs), this.appliedCeilingMs);
  }

  /**
   * 観測を 1 つ受け取り、必要なら目標を動かす
   *
   * 目標を動かすのは `AUDIO_DELAY_FEEDBACK_INTERVAL_MS` ごとに 1 回だけである。観測の窓が
   * 短いため、間隔を空けずに動かすと、増やした結果が現れる前に増やし続ける
   */
  update(observation: AudioDelayFeedbackObservation): void {
    this.latest = observation;
    // 1 つでも観測を受けたら、以降は閉ループの目標を使う (鳴っていない音の観測でも同じ)
    this.receivedObservation = true;
    // 圧縮の増分を、次の制御 (毎秒 1 回) まで積む。音ごとの増分をそのまま速さとして見ると、
    // 1 秒間に出た圧縮を取りこぼす
    this.compressionSinceUpdateMs += Math.max(0, observation.compressionMs ?? 0);
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

    // 圧縮が続くときだけ上限を広げる。目標を動かす前に判断する (同じ観測で新しい上限まで
    // 上げてよい)
    this.updateArtifactCeiling(elapsedMs, observation.jitterTargetMs);

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
   * 圧縮 (粗さ) が続くときだけ使う上限を、上げる / 戻す
   *
   * - 上げる: 圧縮の速さが `AUDIO_DELAY_FEEDBACK_COMPRESSION_MIN_MS_PER_SECOND` を超える状態が
   *   `AUDIO_DELAY_FEEDBACK_COMPRESSION_CONFIRM_MS` 続いたとき。100 ms では足りない証拠が
   *   そろったということである
   * - 戻す: 揺らぎだけの目標 (`jitterTargetMs`) が `AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS` 以下で
   *   あり、かつ圧縮が 0 の状態が `AUDIO_DELAY_FEEDBACK_ARTIFACT_RELEASE_MS` 続いたとき。
   *   圧縮が 0 だけでは戻さない。揺らぎが 100 ms を超えている経路では、戻した直後に圧縮が
   *   再発して 2 秒でまた上げる往復になる (このファイルの定数のコメントを参照)
   *
   * 目標そのものは動かさない。上げた上限は `targetDelayMs` が使い、戻した上限は
   * `feedbackTargetMs` が切る。内部の目標を下げるのは既存の減らす規則
   * (`AUDIO_DELAY_FEEDBACK_DECREASE_MS_PER_SECOND`) に任せる
   *
   * @param elapsedMs - 前回の制御からの時間 (ミリ秒)。前回が無ければ null
   * @param jitterTargetMs - 揺らぎだけから求めた目標遅延 (ミリ秒)
   */
  private updateArtifactCeiling(elapsedMs: number | null, jitterTargetMs: number): void {
    const spanMs = elapsedMs ?? 0;
    const compressionMs = this.compressionSinceUpdateMs;
    this.compressionSinceUpdateMs = 0;
    // 観測は音ごとに来るが、制御は毎秒 1 回である。間隔が分からないとき (最初の観測) は
    // 速さを求められないため 0 とする
    const rateMsPerSecond = spanMs > 0 ? (compressionMs / spanMs) * 1_000 : 0;
    this.compressionMsPerSecond = rateMsPerSecond;
    if (rateMsPerSecond > AUDIO_DELAY_FEEDBACK_COMPRESSION_MIN_MS_PER_SECOND) {
      // 100 ms では足りていない証拠が続いている
      this.compressionStreakMs += spanMs;
      this.quietStreakMs = 0;
    } else if (compressionMs === 0 && jitterTargetMs <= AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS) {
      // 圧縮が無く、経路も 100 ms 以内で足りている
      this.quietStreakMs += spanMs;
      this.compressionStreakMs = 0;
    } else {
      // 圧縮は出ているが閾値未満、または経路がまだ 100 ms を必要としている。どちらの
      // 条件も満たしていないため、数え直す
      this.compressionStreakMs = 0;
      this.quietStreakMs = 0;
    }
    if (
      !this.artifactCeilingActive &&
      this.compressionStreakMs >= AUDIO_DELAY_FEEDBACK_COMPRESSION_CONFIRM_MS
    ) {
      this.artifactCeilingActive = true;
    } else if (
      this.artifactCeilingActive &&
      this.quietStreakMs >= AUDIO_DELAY_FEEDBACK_ARTIFACT_RELEASE_MS
    ) {
      // 上限だけを戻す。内部の目標は既存の減らす規則に任せる (`feedbackTargetMs` が新しい
      // 上限で切るため、実際に使う値はここで 100 ms 以下になる)
      this.artifactCeilingActive = false;
    }
  }

  /**
   * 実際に適用する値に掛ける上限 (ミリ秒)
   *
   * 広げていないときは `AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS` (100 ms)。圧縮が続くときに広げる
   * 分は、明示設定 (`targetLatencyMs`) で切る。明示設定は利用者が宣言した遅延の予算であり、
   * 適応で広げる分がそれを超えてはならない。ただし既定の上限は下回らない。既存の規則では
   * 揺らぎだけの目標に明示設定を掛けないため、ここで下回らせると、明示設定が既定より小さい
   * ときに適用する値が既定より小さくなってしまう (実測と決定をやり直すことになる)
   */
  private get appliedCeilingMs(): number {
    if (!this.artifactCeilingActive) {
      return AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS;
    }
    return Math.max(
      AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS,
      Math.min(
        AUDIO_DELAY_FEEDBACK_ARTIFACT_CEILING_MS,
        this.ceilingMs ?? AUDIO_DELAY_FEEDBACK_ARTIFACT_CEILING_MS,
      ),
    );
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
      appliedCeilingMs: this.appliedCeilingMs,
      compressionMsPerSecond: this.compressionMsPerSecond,
    };
  }

  /**
   * 今の上限 (ミリ秒)。閉ループの目標を持つのに使える上限
   *
   * 実際に適用される値の上限と同じにする。適用は `AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS` で
   * 切られる (`targetDelayMs`) ため、それより大きい目標を持っても適用されない。持つと、
   * 遅れが収まった後に減らし切るまでの時間だけ復帰が遅れる (欠陥 5。このファイルの先頭の
   * コメントを参照)
   */
  private upperMs(): number {
    // 圧縮が続くときだけ、既定の上限の代わりに広げた上限を使う。明示設定
    // (`targetLatencyMs`) と絶対上限は常に優先する (小さい方)
    return Math.min(
      AUDIO_DELAY_FEEDBACK_MAX_MS,
      this.ceilingMs ?? AUDIO_DELAY_FEEDBACK_MAX_MS,
      this.appliedCeilingMs,
    );
  }
}
