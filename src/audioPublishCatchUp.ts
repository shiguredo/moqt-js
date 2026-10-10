/**
 * 配信側の音声が live から遅れたときに、古いフレームを捨てて追いつく
 *
 * 音声の配信は、読み出したフレームを符号化の出力を待たずに投入する。符号化が実時間に
 * 追いつかなくなると、投入したフレームはキューに溜まり、符号化の出力が返るまでの待ちが
 * 伸びる。映像は `encodeQueueSize` が上限を超えたフレームを捨てて待ちを伸ばさないが
 * (src/createMediaPublisher.ts の processVideoFrames)、音声は同じことをしていなかった。
 * 音声のキューは一度詰まると戻らず、遅れは受信側の基準 (復号の出力 - 送られた TIMESTAMP) を
 * そのまま押し上げ、音声と映像の基準の差を開かせる。
 *
 * 実測 (実リレーへ同じページから配信と購読を行い、メインスレッドを 1 秒止める):
 *
 * - 読み出しの遅れ (読み出した壁時計 - (AudioData.timestamp + 補正)) は 0.7 ms のままで、
 *   フレームは撮った時刻どおりに読めていた
 * - 符号化の遅れ (読み出してから出力が返るまで) は 10 ms から 910 ms へ伸び、負荷を
 *   やめて 10 秒たっても 910 ms のまま戻らなかった
 * - 受信側の音声の基準の遅れは 19 ms から 919 ms へ伸びた (映像は 12 ms のまま)
 *
 * つまり遅れが溜まるのは符号化のキューであり、キューに溜まった分は実時間と同じ速さでしか
 * はけない (出力の速さが実時間と同じため、キューは詰まったまま戻らない)。投入を続ける
 * 限り遅れは減らないため、捨てる以外に live へ戻る道が無い。
 *
 * このクラスは、配信側が足した遅れを
 *
 * - 符号化のキューに溜まっている音声の長さ (投入したまま出力が返っていない分)
 * - いま読んだフレームの読み出しの遅れ (読み出した壁時計 - (timestamp + 補正))
 *
 * の和として観測し、健全時に観測した遅れ (床) から一定を超えたら、読んだフレームを符号化
 * せずに捨てて live へ追いつく。捨てるとキューが減って遅れが下がるため、キューがはければ
 * 投入を再開する。数フレームの穴は Opus の concealment が埋めるため、遅れたまま送り続ける
 * より聴感は良い。
 *
 * 投入を再開する条件は「キューが 1 パケット以下まで減ったこと」である。上限を少し下回った
 * ところで再開すると、キューに残った分がはけないまま次のフレームが入り、捨てるかどうかが
 * 1 フレームごとに往復する。実測では、上限 (60 ms) と 40 ms の間で往復させたところ、投入が
 * 出力のたびに 1 フレームだけになり、出力が入力の半分ずつ減って (opus の 1 パケットは 20 ms の
 * 入力が要る) 音声がほとんど送られなくなった。また、符号化器は 1 パケット分の入力を保持した
 * まま出力を返すため、キューは 0 にはならない。完全に空になるまで待つと、保持された 1 パケットを
 * 出すための入力が入らず、記録を捨てるまでの間 (既定で 5 秒) 音声が送られなくなる。
 *
 * 閾値を絶対値ではなく床からの増加で測るのは、健全時の遅れが環境で決まるためである
 * (実測: 手元の 1 台では 11 ms、4 vCPU の runner では 30〜190 ms)。絶対値で測ると、遅い
 * 環境では健全な状態でも捨て続けることになる。
 *
 * 始めるかどうかは、上限を超えた状態が続いたかで決める。1 フレームの観測だけで始めると、
 * 読み出しがまとめて行われた分でも始まる。実測 (実リレー、メインスレッドを 60 ms 占有して
 * 40 ms 明け渡す負荷を 10 秒) では、上限を超えた状態は 66 回現れ、そのうち 25 回は 1 フレーム
 * で終わった (継続時間は p50 が 1 ms、最長が 18 ms)。負荷の間は、止まっている間に届いた
 * フレームが止まった後にまとめて読まれるため、読み出しの遅れと符号化のキューの和が 53〜71 ms
 * になって上限 (60 ms) をまたぐが、読み出しの遅れはその 1 フレームが遅れているだけで、次に
 * 読むフレームは新しくなっている。この状態で始めると、遅れが減らないまま開始と再開が負荷の
 * 周期 (100 ms) ごとに往復し、捨てた音だけが増える (実測: 開始 69 回、捨てたフレーム 113)。
 *
 * これに対して、符号化が実時間に追いつかなくなった場合は、キューに溜まった分がはけない限り
 * 次のフレームも上限を超え続けるため、状態は数百 ms 以上続く。そのため、始める条件は
 * (1) 上限を超えた状態が `AUDIO_PUBLISH_CATCH_UP_CONFIRM_MS` 続いたこと、(2) 符号化の
 * キューが単独で上限を超えた状態が `AUDIO_PUBLISH_CATCH_UP_QUEUE_CONFIRM_FRAMES` 続いたこと、
 * の 2 つとし、やめた後は `AUDIO_PUBLISH_CATCH_UP_COOLDOWN_MS` は始めない (詳しくは各定数の
 * コメント)。負荷では、キューが単独で上限を超えることが無く (実測: 2600 フレーム中 0 回)、
 * 上限の超過も数 ms で終わるため、どちらの条件も満たさない。
 *
 * もう 1 つ、フレームを捨てるときに効く性質がある。WebCodecs の `AudioEncoder` は、出力する
 * chunk の timestamp を「投入したフレームの timestamp」ではなく「最初のフレームの
 * timestamp + 符号化したサンプル数」で作る (連続した値になる)。そのため、フレームを捨てて
 * 投入に穴が空くと、出力の timestamp は投入したフレームの timestamp より古くなる。実測では、
 * 穴が空いた直後から出力の timestamp が投入と対応しなくなり、キューに溜まっている音声が
 * はけなくなった。LOC TIMESTAMP は送るサンプルの取得時刻でなければならないため、このクラスは
 * 「どの出力がどの投入を覆ったか」を順番 (FIFO) で対応づけ、覆った最初の投入の timestamp を
 * `recordEncodedChunk()` の返り値で呼び出し側へ渡す。
 *
 * ブラウザ API に依存しない (時刻と値は呼び出し側が渡す)。
 */

/** 音声が遅れたときの追いつき方 */
export type AudioPublishCatchUpPolicy =
  /**
   * 遅れが上限を超えたら、読んだフレームを符号化せずに捨てて live へ追いつく (既定)
   *
   * opus のパケットは独立しており、欠けた区間は受信側の concealment が埋める。会話は
   * 遅れて届くより、数フレーム欠ける方が良い。
   */
  | "drop"
  /**
   * 捨てずに順に符号化して送る
   *
   * 音楽や効果音のように、間引くと内容が壊れる用途で使う。キューに溜まった遅れは戻らない
   * ため、受信側の基準の遅れは増えたままになる (受信側は遅れたまま鳴らす)。
   */
  | "keep";

/**
 * 健全時の遅れが小さく観測されたときに許す、遅れの上限 (ミリ秒)
 *
 * 音声の 1 パケットは 20 ms であり、これは 3 パケット分にあたる。符号化の出力が返るまでに
 * 少なくとも 1 パケットはキューに残るため、健全な状態でも 10〜20 ms の遅れがある。床
 * (健全時の遅れ) を実際より小さく観測しても、上限がこれより下がらないようにする。
 * 実測では、負荷で 100 ms 前後へ伸びた遅れを、この上限で 1 秒未満に床へ戻せた
 */
export const AUDIO_PUBLISH_CATCH_UP_MIN_MS = 60;

/**
 * 健全時の遅れが大きい環境で、そこからさらに許す遅れ (ミリ秒)
 *
 * 床は「今までで最も早く符号化できたとき」であり、環境が悪化したままになると床そのものが
 * 上がる。床からの増加だけを見ると、その状態では追いつきが始まらず遅れが固定されるため、
 * 絶対値の下限 (`AUDIO_PUBLISH_CATCH_UP_MIN_MS`) との大きい方を上限にする
 */
export const AUDIO_PUBLISH_CATCH_UP_GROWTH_MS = 40;

/**
 * 追いつきをやめて投入を再開する、キューに残ってよい音声の長さ (ミリ秒)
 *
 * 音声の 1 パケット分にあたる。符号化器は 1 パケット分の入力を保持したまま出力を返すため、
 * キューは 0 にはならない。1 パケット以下まで減っていれば、残っているのは最も新しい
 * フレームだけであり、遅れは残っていない
 */
export const AUDIO_PUBLISH_CATCH_UP_RESUME_MS = 20;

/**
 * 追いつきを始める前に、上限を超えた状態が続くことを要求する時間 (ミリ秒)
 *
 * 1 フレームの観測だけで始めると、読み出しがまとめて行われた分 (メインスレッドが止まって
 * いる間に届いたフレームを、止まった後に続けて読む) でも始まる。実測では、上限を超えた状態は
 * 66 回現れ、そのうち 25 回は 1 フレームで終わった (継続時間の p50 は 1 ms、最長は 18 ms)。
 * 読み出しの遅れは、そのフレーム 1 つが遅れているだけで、次に読むフレームは新しくなって
 * いるため、1 フレームの超過を追いつきのきっかけにすると、遅れが減らないまま状態だけが
 * 往復する (実測: 開始の間隔の p50 は 100 ms で、負荷の周期と同じ)。
 *
 * これに対して、符号化が実時間に追いつかなくなった場合 (このクラスが追いつくべき状態) は、
 * キューに溜まった分がはけない限り次のフレームも上限を超え続けるため、状態は数百 ms 以上
 * 続く。100 ms は、実測した負荷の超過 (最長 18 ms) より十分に長く、実時間に追いつかない
 * 状態 (キューがはけるまで続く) を待たせない値である
 */
export const AUDIO_PUBLISH_CATCH_UP_CONFIRM_MS = 100;

/**
 * 符号化のキューが単独で上限を超えた状態が続くことを要求するフレーム数
 *
 * 実時間に追いつかない状態 (このクラスが追いつくべき状態) では、キューに溜まった分は
 * はけないため、次のフレームでもキューは上限を超えたままになる。この経路はその場で
 * 始めてよい。実測 (負荷) では、キューは上限 (60 ms) を超えることが無かった (まとめて
 * 読まれた 6 フレーム分で 0 ms から 60 ms まで増え、次の負荷までにはけて 10 ms に戻った)
 * ため、負荷ではこの経路から始まらない。2 フレームにするのは、1 フレームだけの超過
 * (出力がまとめて返った直後など) で始めないためである
 */
export const AUDIO_PUBLISH_CATCH_UP_QUEUE_CONFIRM_FRAMES = 2;

/**
 * 追いつきをやめた後、次を始めない時間 (ミリ秒)
 *
 * 上限をまたぐたびに始め直すと状態が往復する。実測 (負荷の周期が 100 ms) では開始の間隔が
 * 100 ms から 807 ms に分布した。1 秒は、その最長 (807 ms) より長く、実リレーの E2E が
 * 回復を待つ 30 秒に対して十分に短い。
 *
 * このクールダウンを掛けるのは、遅れが上限を超えた状態が続いたことだけを根拠にする開始
 * (`AUDIO_PUBLISH_CATCH_UP_CONFIRM_MS` の経路) である。符号化のキューが単独で上限を
 * 超え続けている場合は、実時間に追いつかない状態そのものであり、待つと遅れが伸びるため
 * 直ちに始める (`AUDIO_PUBLISH_CATCH_UP_QUEUE_CONFIRM_FRAMES` の経路)
 */
export const AUDIO_PUBLISH_CATCH_UP_COOLDOWN_MS = 1_000;

/**
 * 出力が返らない記録を捨てるまでの時間 (ミリ秒)
 *
 * エンコーダーのエラーなどで出力が返らなかったフレームの記録が残り続けると、記録と
 * 「キューに溜まっている音声の長さ」が増え続ける。符号化の遅れとしても、これを超える
 * 遅れは追いつきの対象であり、記録を残す意味が無い
 */
export const AUDIO_PUBLISH_CATCH_UP_PENDING_TIMEOUT_MS = 5_000;

/** `AudioPublishCatchUp.recordSendStart()` の入力 */
export interface AudioPublishCatchUpSendStart {
  /**
   * 送る Object の対応づけに使う timestamp (マイクロ秒)
   *
   * `recordEncodedChunk()` が返した「覆った最初の投入の timestamp」を使う。送出の完了は
   * 送信キューの順に返るが、失敗した分を取り違えないよう、対応づけは timestamp で行う
   */
  readonly timestampMicros: number;
  /** 送る Object の LOC TIMESTAMP (Unix epoch ミリ秒) */
  readonly capturedWallClockMs: number;
  /** フレームの長さ (ミリ秒) */
  readonly durationMs: number;
  /** 送信キューへ入れた時刻 (`performance.now()`、ミリ秒) */
  readonly nowMs: number;
}

/** `AudioPublishCatchUp.recordSendComplete()` の入力 */
export interface AudioPublishCatchUpSendComplete {
  /** `recordSendStart()` に渡した timestamp (マイクロ秒) */
  readonly timestampMicros: number;
  /** 送出が完了した時刻 (Unix epoch ミリ秒) */
  readonly completedWallClockMs: number;
}

/** `AudioPublishCatchUp.recordEncodedChunk()` の結果 */
export interface AudioPublishCatchUpChunkResult {
  /**
   * この chunk が覆う最初の投入の timestamp (マイクロ秒)。対応が無ければ null
   *
   * LOC TIMESTAMP には `chunk.timestamp` ではなくこの値を使う。符号化の出力の timestamp は
   * 連続した値であり、フレームを捨てた分だけ投入したフレームの timestamp より古くなる
   * (このファイルの先頭のコメントを参照)。対応が無ければ呼び出し側が `chunk.timestamp` へ
   * 落とせる
   */
  readonly timestampMicros: number | null;
}

/** 音声の追いつきの観測値 (配信側の統計と devtools に出す) */
export interface AudioPublishCatchUpStats {
  /** 使っている方針 */
  policy: AudioPublishCatchUpPolicy;
  /** 遅れが上限を超えたため符号化せずに捨てたフレームの数 (累積) */
  droppedFrames: number;
  /** 捨てた音声の長さの合計 (ミリ秒、累積) */
  droppedMs: number;
  /** 直近に観測した、配信側が足した遅れ (ミリ秒)。まだ観測していなければ null */
  lagMs: number | null;
  /** 健全時に観測した遅れ (床、ミリ秒)。まだ観測していなければ null */
  floorMs: number | null;
  /** 観測した最大の遅れ (ミリ秒)。まだ観測していなければ null */
  maxLagMs: number | null;
  /** 符号化へ渡したまま出力が返っていない音声の長さ (ミリ秒) */
  pendingMs: number;
  /** 直近に読んだフレームの読み出しの遅れ (ミリ秒) */
  readLagMs: number;
  /** 符号化へ渡したまま出力が返っていないフレームの数 */
  pendingFrames: number;
  /** いま追いつきのために捨てているか */
  catchingUp: boolean;
  /** 追いつきを始めた回数 (累積) */
  catchUpStarts: number;
  /** 送信キューへ入れたまま送信が終わっていない音声の長さ (ミリ秒) */
  sendQueueMs: number;
  /** 送信キューへ入れたまま送信が終わっていないフレームの数 */
  sendQueueFrames: number;
  /**
   * 直近に送信が終わったフレームの、撮ってから送信が終わるまでの遅れ (ミリ秒)。
   * まだ送信が終わっていなければ null
   */
  sendLagMs: number | null;
  /** 観測した送信の遅れの最大 (ミリ秒)。まだ送信が終わっていなければ null */
  maxSendLagMs: number | null;
}

/** 符号化へ渡したフレームの記録 (出力が返るまで持つ) */
interface PendingFrame {
  /** 読み出した時刻 (`performance.now()`、ミリ秒) */
  readonly readAtMs: number;
  /** フレームの長さ (ミリ秒) */
  readonly durationMs: number;
}

/** 送信キューへ入れたフレームの記録 (送信が終わるまで持つ) */
interface PendingSend {
  /** 送信キューへ入れた時刻 (`performance.now()`、ミリ秒) */
  readonly queuedAtMs: number;
  /** 送る Object の LOC TIMESTAMP (Unix epoch ミリ秒) */
  readonly capturedWallClockMs: number;
  /** フレームの長さ (ミリ秒) */
  readonly durationMs: number;
}

/** `AudioPublishCatchUp.evaluate()` の入力 */
export interface AudioPublishCatchUpFrameInput {
  /** `AudioData.timestamp` (マイクロ秒) */
  readonly timestampMicros: number;
  /** 読み出した壁時計 (Unix epoch マイクロ秒) */
  readonly readWallClockMicros: bigint;
  /**
   * TIMESTAMP に足している補正 (マイクロ秒)。まだ決まっていなければ null
   *
   * 呼び出し側が `AudioTimestampClock.appliedMicros` を渡す。これは読み出しの遅れの床で
   * あり、読み出しの遅れはこの値からの増加として測る
   */
  readonly appliedOffsetMicros: bigint | null;
  /** フレームの長さ (マイクロ秒)。分からなければ null */
  readonly durationMicros: number | null;
  /** 読み出した時刻 (`performance.now()`、ミリ秒) */
  readonly nowMs: number;
}

/** `AudioPublishCatchUp.recordEncodedChunk()` の入力 */
export interface AudioPublishCatchUpChunkInput {
  /** 出力された chunk の timestamp (マイクロ秒) */
  readonly timestampMicros: number;
  /**
   * 出力された chunk の長さ (マイクロ秒)。分からなければ null
   *
   * 1 つの出力が複数の投入を覆う (10 ms の `AudioData` を 2 つ読んで 20 ms の opus packet が
   * 出る) ため、覆う範囲の投入まで消費したものとして扱う
   */
  readonly durationMicros: number | null;
  /** 出力された時刻 (`performance.now()`、ミリ秒) */
  readonly nowMs: number;
}

/** `AudioPublishCatchUp` の設定 */
export interface AudioPublishCatchUpOptions {
  /** 追いつき方。既定は "drop" */
  readonly policy?: AudioPublishCatchUpPolicy;
  /** 遅れの上限の下限 (ミリ秒)。既定は `AUDIO_PUBLISH_CATCH_UP_MIN_MS` */
  readonly minMs?: number;
  /** 健全時の遅れからさらに許す遅れ (ミリ秒)。既定は `AUDIO_PUBLISH_CATCH_UP_GROWTH_MS` */
  readonly growthMs?: number;
  /**
   * 追いつきを始める前に、上限を超えた状態が続くことを要求する時間 (ミリ秒)。
   * 既定は `AUDIO_PUBLISH_CATCH_UP_CONFIRM_MS`
   */
  readonly confirmMs?: number;
  /**
   * 追いつきをやめた後、次を始めない時間 (ミリ秒)。既定は
   * `AUDIO_PUBLISH_CATCH_UP_COOLDOWN_MS`
   */
  readonly cooldownMs?: number;
  /** 出力が返らない記録を捨てるまでの時間 (ミリ秒) */
  readonly pendingTimeoutMs?: number;
}

/**
 * 音声の追いつきの判定と観測
 *
 * 配信の音声ごとに 1 つ持つ。読み出したフレームごとに `evaluate()` を呼び、符号化するか
 * どうかを決める。符号化したフレームは `recordEncodedChunk()` で出力と対応づけ、キューに
 * 溜まっている音声の長さを求める。
 */
export class AudioPublishCatchUp {
  private readonly policy: AudioPublishCatchUpPolicy;
  private readonly minMs: number;
  private readonly growthMs: number;
  private readonly confirmMs: number;
  private readonly cooldownMs: number;
  private readonly pendingTimeoutMs: number;

  /** 符号化へ渡したまま出力が返っていないフレーム (timestamp の昇順) */
  private readonly pending = new Map<number, PendingFrame>();
  /** 符号化へ渡したまま出力が返っていない音声の長さ (ミリ秒) */
  private pendingMs = 0;
  /** 送信キューへ入れたまま送信が終わっていないフレーム (対応づけの timestamp ごと) */
  private readonly pendingSends = new Map<number, PendingSend>();
  /** 送信キューへ入れたまま送信が終わっていない音声の長さ (ミリ秒) */
  private pendingSendMs = 0;
  /** 直近に送信が終わったフレームの、撮ってから送信が終わるまでの遅れ (ミリ秒) */
  private lastSendLagMs: number | null = null;
  /** 観測した送信の遅れの最大 (ミリ秒) */
  private maxSendLagMs: number | null = null;
  /** 健全時に観測した遅れ (床、ミリ秒)。下がる方向にだけ動く */
  private floorMs: number | null = null;
  /** 観測した最大の遅れ (ミリ秒) */
  private maxLagMs: number | null = null;
  /** 直近のフレームで観測した、配信側が足した遅れ (ミリ秒) */
  private lastLagMs: number | null = null;
  /** 直近に読んだフレームの読み出しの遅れ (ミリ秒) */
  private lastReadLagMs = 0;
  /** 追いつきのために捨てているか */
  private catchingUp = false;
  /** 上限を超えた状態が始まった時刻 (ミリ秒)。超えていなければ null */
  private overLimitSinceMs: number | null = null;
  /** 符号化のキューが単独で上限を超えた状態が続いたフレームの数 */
  private queueOverFrames = 0;
  /** 直近に追いつきをやめた時刻 (ミリ秒)。まだやめていなければ null */
  private resumedAtMs: number | null = null;
  private catchUpStarts = 0;
  private droppedFrames = 0;
  private droppedMs = 0;
  /** 直前に読んだフレームの長さ (ミリ秒)。長さが分からないフレームの代わりに使う */
  private lastFrameDurationMs = 0;

  constructor(options: AudioPublishCatchUpOptions = {}) {
    this.policy = options.policy ?? "drop";
    this.minMs = options.minMs ?? AUDIO_PUBLISH_CATCH_UP_MIN_MS;
    this.growthMs = options.growthMs ?? AUDIO_PUBLISH_CATCH_UP_GROWTH_MS;
    this.confirmMs = options.confirmMs ?? AUDIO_PUBLISH_CATCH_UP_CONFIRM_MS;
    this.cooldownMs = options.cooldownMs ?? AUDIO_PUBLISH_CATCH_UP_COOLDOWN_MS;
    this.pendingTimeoutMs = options.pendingTimeoutMs ?? AUDIO_PUBLISH_CATCH_UP_PENDING_TIMEOUT_MS;
  }

  /**
   * 読み出したフレームを符号化するかを決める
   *
   * @returns true なら符号化する。false なら符号化せずに捨てる (呼び出し側が閉じる)
   */
  evaluate(input: AudioPublishCatchUpFrameInput): boolean {
    const readLagMs = this.readLagMs(input);
    const lagMs = readLagMs + this.pendingMs;
    this.lastReadLagMs = readLagMs;
    this.lastLagMs = lagMs;
    this.maxLagMs = this.maxLagMs === null ? lagMs : Math.max(this.maxLagMs, lagMs);
    this.floorMs = this.floorMs === null ? lagMs : Math.min(this.floorMs, lagMs);

    // 長さが分からないフレームは、直前のフレームと同じ長さとみなす (捨てた長さと
    // キューの長さの集計用)
    const durationMs = this.durationMs(input);
    this.lastFrameDurationMs = durationMs;

    // 出力が返らなかった記録を捨てる (記録が増え続けないようにする)
    this.prunePending(input.nowMs);
    // 送信が終わらなかった記録も同じく捨てる
    this.prunePendingSends(input.nowMs);

    if (this.shouldDrop(lagMs, readLagMs, input.nowMs)) {
      this.droppedFrames++;
      this.droppedMs += durationMs;
      return false;
    }

    this.pending.set(input.timestampMicros, { readAtMs: input.nowMs, durationMs });
    this.pendingMs += durationMs;
    return true;
  }

  /**
   * 符号化の出力を記録し、この chunk が覆う最初の投入の timestamp を返す
   *
   * 出力は 1 つ以上の投入を覆いうる (`AudioData` が 10 ms、opus の packet が 20 ms のように)
   * ため、chunk の長さの分だけ投入を古い方から消費する。`chunk.timestamp` で対応づけないのは、
   * 出力の timestamp が「符号化したサンプル数」から作る連続した値であり、フレームを捨てた
   * 分だけ投入より古くなるためである (このファイルの先頭のコメントを参照)。出力は投入の
   * 順に返るため、順番で対応づける
   */
  recordEncodedChunk(input: AudioPublishCatchUpChunkInput): AudioPublishCatchUpChunkResult {
    const first = this.pending.entries().next();
    if (first.done === true) {
      // 対応づけられる投入が無い (配信を始める前の出力、記録を捨てた後など)
      return { timestampMicros: null };
    }
    const firstTimestampMicros = first.value[0];

    // 消費する長さ。長さが分からない chunk は 1 フレーム分だけ消費する
    let remainMs = (input.durationMicros ?? first.value[1].durationMs * 1_000) / 1_000;
    for (const [timestampMicros, frame] of this.pending) {
      if (frame.durationMs <= remainMs) {
        this.pending.delete(timestampMicros);
        this.pendingMs -= frame.durationMs;
        remainMs -= frame.durationMs;
        if (remainMs <= 0) {
          break;
        }
        continue;
      }
      // 1 つの投入が 2 つの出力にまたがる場合は、残りを次に持ち越す
      this.pending.set(timestampMicros, {
        readAtMs: frame.readAtMs,
        durationMs: frame.durationMs - remainMs,
      });
      this.pendingMs -= remainMs;
      break;
    }
    this.pendingMs = Math.max(0, this.pendingMs);
    return { timestampMicros: firstTimestampMicros };
  }

  /**
   * 送信キューへ入れたことを記録する
   *
   * 配信側が足す遅れには、符号化のキューだけでなく送信のキューに残っている分も含まれる。
   * 送信の完了は `Publisher.sendObject` の返値であり、WebTransport のストリーム生成と
   * 書き込みの待ち (backpressure) を含む。送信キューは符号化の出力より後ろにあるため、
   * `recordEncodedChunk()` の待ち (`pendingMs`) では見えない (配信側の統計と devtools に
   * 出す計器として測る)。
   */
  recordSendStart(input: AudioPublishCatchUpSendStart): void {
    this.pendingSends.set(input.timestampMicros, {
      queuedAtMs: input.nowMs,
      capturedWallClockMs: input.capturedWallClockMs,
      durationMs: input.durationMs,
    });
    this.pendingSendMs += input.durationMs;
  }

  /**
   * 送出が完了したことを記録する
   *
   * 「撮ってから送信が終わるまで」を測る。配信側が足した遅れのうち、受信側の基準の遅れへ
   * そのまま出る値である。対応づけは timestamp で行うため、送信の完了が順不同でもよい
   * (送信の失敗・中断で完了が返らない分は `prunePendingSends()` が捨てる)
   */
  recordSendComplete(input: AudioPublishCatchUpSendComplete): void {
    const send = this.pendingSends.get(input.timestampMicros);
    if (send === undefined) {
      return;
    }
    this.pendingSends.delete(input.timestampMicros);
    this.pendingSendMs = Math.max(0, this.pendingSendMs - send.durationMs);
    const lagMs = input.completedWallClockMs - send.capturedWallClockMs;
    this.lastSendLagMs = lagMs;
    this.maxSendLagMs = this.maxSendLagMs === null ? lagMs : Math.max(this.maxSendLagMs, lagMs);
  }

  /** 観測値 (配信側の統計と devtools に出す) */
  snapshot(): AudioPublishCatchUpStats {
    return {
      policy: this.policy,
      droppedFrames: this.droppedFrames,
      droppedMs: this.droppedMs,
      lagMs: this.lastLagMs,
      floorMs: this.floorMs,
      maxLagMs: this.maxLagMs,
      pendingMs: this.pendingMs,
      readLagMs: this.lastReadLagMs,
      pendingFrames: this.pending.size,
      catchingUp: this.catchingUp,
      catchUpStarts: this.catchUpStarts,
      sendQueueMs: this.pendingSendMs,
      sendQueueFrames: this.pendingSends.size,
      sendLagMs: this.lastSendLagMs,
      maxSendLagMs: this.maxSendLagMs,
    };
  }

  /** 配信のやり直しで観測を消す */
  reset(): void {
    this.pending.clear();
    this.pendingMs = 0;
    this.pendingSends.clear();
    this.pendingSendMs = 0;
    this.floorMs = null;
    this.maxLagMs = null;
    this.lastLagMs = null;
    this.lastReadLagMs = 0;
    this.lastSendLagMs = null;
    this.maxSendLagMs = null;
    this.catchingUp = false;
    this.overLimitSinceMs = null;
    this.queueOverFrames = 0;
    this.resumedAtMs = null;
    this.catchUpStarts = 0;
    this.droppedFrames = 0;
    this.droppedMs = 0;
    this.lastFrameDurationMs = 0;
  }

  /**
   * いま符号化せずに捨てるべきか
   *
   * 3 つの規則を持つ。
   *
   * - 読み出しの遅れが上限を超えたフレームは、その場で捨てる。受信側の基準の遅れに
   *   そのまま出るためであり、キューに溜まっていないため状態は持ち越さない (1 フレーム
   *   捨てれば、次に読むフレームは新しくなっている)
   * - 符号化のキューに溜まっている音声が上限を超えたら、1 パケット
   *   (`AUDIO_PUBLISH_CATCH_UP_RESUME_MS`) 以下まで減る間は捨て続ける。減る前に再開すると、
   *   キューに残った分がはけないまま次のフレームが入り、捨てるかどうかが往復して音声が
   *   送られなくなる (このファイルの先頭のコメントを参照)
   * - 始めるのは、上限を超えた状態が続いたときだけにする。条件は 2 つある。
   *   符号化のキューが単独で上限を超えた状態が
   *   `AUDIO_PUBLISH_CATCH_UP_QUEUE_CONFIRM_FRAMES` 続いた場合 (実時間に追いつかない
   *   状態であり、キューがはけるまで続く) と、遅れが上限を超えた状態が
   *   `AUDIO_PUBLISH_CATCH_UP_CONFIRM_MS` 続いた場合である。読み出しがまとめて行われると
   *   1 フレームだけ超過することがあり、その場で始めると遅れが減らないまま状態が往復する。
   *   やめた後も `AUDIO_PUBLISH_CATCH_UP_COOLDOWN_MS` は始めない (詳しくは各定数のコメント)
   */
  private shouldDrop(lagMs: number, readLagMs: number, nowMs: number): boolean {
    if (this.policy === "keep") {
      return false;
    }
    // 上限は、健全時の遅れ (床) からの増加と、絶対値の下限の大きい方にする
    const startMs = Math.max(this.minMs, (this.floorMs ?? 0) + this.growthMs);
    // 上限を超えた状態がいつから続いているかを記録する (始めるかどうかは続いた時間で決める)
    if (lagMs > startMs) {
      this.overLimitSinceMs ??= nowMs;
    } else {
      this.overLimitSinceMs = null;
    }
    // 符号化のキューが単独で上限を超えているか (読み出しの遅れによらない、実時間に
    // 追いつかない状態の証拠)
    this.queueOverFrames = this.pendingMs > startMs ? this.queueOverFrames + 1 : 0;
    if (readLagMs > startMs) {
      return true;
    }
    if (this.catchingUp) {
      if (this.pendingMs <= AUDIO_PUBLISH_CATCH_UP_RESUME_MS) {
        this.catchingUp = false;
        this.resumedAtMs = nowMs;
        // やめた時点から数え直す (続いていた超過をそのまま次の開始の条件に使わない)
        this.overLimitSinceMs = lagMs > startMs ? nowMs : null;
      }
      return this.catchingUp;
    }
    // 始めるには、上限を超えた状態が続いている必要がある
    const queueConfirmed = this.queueOverFrames >= AUDIO_PUBLISH_CATCH_UP_QUEUE_CONFIRM_FRAMES;
    const lagConfirmed =
      this.overLimitSinceMs !== null && nowMs - this.overLimitSinceMs >= this.confirmMs;
    if (!queueConfirmed && !lagConfirmed) {
      return false;
    }
    // 遅れだけが超過している場合 (キューは上限を超えていない) は、やめた直後は始めない。
    // キューが単独で上限を超え続けている場合は実時間に追いつかない状態そのものであり、
    // 待つと遅れが伸びるため直ちに始める
    if (
      !queueConfirmed &&
      this.resumedAtMs !== null &&
      nowMs - this.resumedAtMs < this.cooldownMs
    ) {
      return false;
    }
    this.catchingUp = true;
    this.catchUpStarts++;
    return true;
  }

  /** 読み出した時点の遅れ (ミリ秒)。補正がまだ決まっていなければ 0 */
  private readLagMs(input: AudioPublishCatchUpFrameInput): number {
    const appliedOffsetMicros = input.appliedOffsetMicros;
    if (appliedOffsetMicros === null) {
      return 0;
    }
    const lagMicros =
      Number(input.readWallClockMicros) - input.timestampMicros - Number(appliedOffsetMicros);
    // 補正は読み出しの遅れの床であるため、床より早く読めたフレームの遅れは 0 にする
    return Math.max(0, lagMicros / 1_000);
  }

  /** フレームの長さ (ミリ秒)。分からなければ直前のフレームの長さを使う */
  private durationMs(input: AudioPublishCatchUpFrameInput): number {
    if (input.durationMicros !== null && input.durationMicros > 0) {
      return input.durationMicros / 1_000;
    }
    return this.lastFrameDurationMs;
  }

  /**
   * 出力が返らないままになった記録を捨てる
   *
   * 記録は読み出した順に入るため、古い方から見て残っていれば以降も残っている
   */
  private prunePending(nowMs: number): void {
    const oldestMs = nowMs - this.pendingTimeoutMs;
    for (const [timestampMicros, frame] of this.pending) {
      if (frame.readAtMs >= oldestMs) {
        break;
      }
      this.pending.delete(timestampMicros);
      this.pendingMs -= frame.durationMs;
    }
    this.pendingMs = Math.max(0, this.pendingMs);
  }

  /**
   * 送信が終わらないままになった記録を捨てる
   *
   * 送信の失敗や配信の停止で完了が返らない記録が残り続けると、送信のキューに残っている
   * 長さが増え続ける。`prunePending()` と同じ上限を使う
   */
  private prunePendingSends(nowMs: number): void {
    const oldestMs = nowMs - this.pendingTimeoutMs;
    for (const [timestampMicros, send] of this.pendingSends) {
      if (send.queuedAtMs >= oldestMs) {
        break;
      }
      this.pendingSends.delete(timestampMicros);
      this.pendingSendMs -= send.durationMs;
    }
    this.pendingSendMs = Math.max(0, this.pendingSendMs);
  }
}
