/**
 * 復号した音声を鳴らす時刻を決める
 *
 * 復号した音声 (Opus なら 20 ms ごとの `AudioData`) を、復号の出力が届いたその場で
 * `AudioBufferSourceNode.start()` で鳴らすと、届く間隔の揺らぎ (経路と復号) で前の音と
 * 重なって足されるか、隙間が空いて、ノイズに聞こえる。鳴らす時刻は、映像と同じ
 * `src/playout/timeline.ts` の時間軸が決めた目標の時刻に従う。
 *
 * - 目標の時刻は `AudioContext.currentTime` と同じ秒で受け取る。壁時計の TIMESTAMP を
 *   持たない音は目標を持たず、到着基準の小さな目標 (`arrivalDelaySeconds`、
 *   `AUDIO_PLAYOUT_ARRIVAL_DELAY_SECONDS` 以下) で鳴らす
 * - 到着基準の遅れは「実際に鳴る位置」から数える。`AudioContext` の時計
 *   (`currentTime`) は、既に出力のバッファへ積まれて実際に鳴る位置より先に進む
 *   (`getOutputTimestamp()` の `contextTime` との差)。これまではこの差を無視して
 *   `currentTime + arrivalDelaySeconds` を目標にしていたため、実際に鳴るのは
 *   「到着 + 到着基準の遅れ + バッファの分」になり、実測では目標 100 ms に対して
 *   startDelayMs が 195.5 ms になっていた。呼び出し側が `arrivalSeconds`
 *   (`AudioClockBridge.toAudioSeconds(到着時刻)`) を渡し、ここではその位置を到着の
 *   基準にして「到着 + 遅れ」に鳴る時刻を求める
 * - 目標の時刻を過ぎて届いた音も、前の音と重なる音も捨てない。今から鳴らせる最も早い
 *   時刻へずらして鳴らし、ずらした分を、遅れと音の長さの半分とキューの余裕 (直前の音の
 *   終わり − (今 + 余裕)) の最小値まで波形の周期で詰める (詰められなかった分は遅れとして
 *   残る)。キューの余裕が 0 以下なら詰めない。出力のバッファが下限を決めているときは、
 *   詰めても次の音の下限は実時間と同じ速さで進むため遅れは減らず、削った分がそのまま
 *   無音の穴になるためである
 * - 目標から `AUDIO_PLAYOUT_MAX_LATENESS_SECONDS` を超えて離れた音も、捨てずに鳴らす。音が
 *   まだ鳴っている (キューが空でない) 間は到着基準へ並べ直さず、遅れたまま鳴らし続ける
 *   (並べ直すと媒体時刻が跳び、鳴っている音の続きが前へずれるため)。音が本当に途切れた
 *   とき (まだ一度も鳴らしていない、または直前の音が既に鳴り終わっているとき) だけ、
 *   到着基準の小さな目標へ並べ直して鳴らす。ずれているのは予定 (TIMESTAMP が壁時計から
 *   ずれている) であり、鳴らしても遅れないためである
 * - 捨てるのは並べすぎの音 (`backlog`) だけである。鳴り遅れを理由に音を捨てると語尾が
 *   切れる
 * - 目標を守るときは、音が途切れていない限り基準を取り直さない (到着基準へ並べ直さない)。
 *   取り直すと音声だけが前へずれ、同じ時間軸で並べている映像とずれるためである
 * - 目標を守らないとき (`enforceTarget` が false) や、目標を作れないとき (壁時計の
 *   TIMESTAMP を持たない音など) は、揃える相手がいない、または目標を作れないため、
 *   鳴らす時刻を過ぎて届いた音は捨てずに基準を取り直す (最初の実装の挙動)
 * - どの音も前の音の終わりより前には鳴らさない (重ねない)。前の音の終わりと今回の開始の
 *   間に空いた分は `gapStartSeconds` / `gapSeconds` / `totalGapSeconds` /
 *   `unrecoverableGapSeconds` として返し、呼び出し側が上限
 *   (`AUDIO_PLAYOUT_MAX_CONCEAL_SECONDS`) まで補間できる。前の音の終わりが既に過去でも、
 *   今回の開始が今 + 余裕より未来なら、その未来の分だけは補間を予約できる
 *   (0.5 ms 以下の隙間は、前の音の終わりに揃えて穴を作らない。目標の表示時刻は時間軸の
 *   基準の更新や浮動小数点の丸めで 20 µs〜0.5 ms 動くことがあり、これを穴として扱うと
 *   1〜2 サンプルのデジタル無音が残るためである。予約できる先頭より前は
 *   `unrecoverableGapSeconds` として返し、呼び出し側が次の音の先頭をフェードインして
 *   段差を消す)
 * - 並べすぎの上限は、目標を守るときは「表示の遅れ (`presentationDelaySeconds`) と再生の
 *   遅れ (`delaySeconds`) の大きい方 + 余裕 (`AUDIO_PLAYOUT_BACKLOG_SECONDS`)」、目標を
 *   使わないときは「到着基準の再生の遅れ (`arrivalDelaySeconds`) + 余裕」である
 *
 * 時刻は `AudioContext.currentTime` と同じ秒、timestamp は `AudioData.timestamp` と同じ
 * マイクロ秒で扱う。ブラウザ API に依存しない。
 */

import {
  AUDIO_PLAYOUT_ARRIVAL_DELAY_MS,
  AUDIO_PLAYOUT_DELAY_FLOOR_MS,
  audioArrivalPlayoutDelayMs,
} from "./timeline";

/**
 * 時間圧縮を始める遅れ (秒)
 *
 * 時間圧縮は波形の周期を 1 つ削る操作であり、削る長さは周期 (2.5 ms から 15 ms) で決まる。
 * 遅れが数 ms しかないときに動かすと、削った分だけ「早すぎる」側へ振れ、すぐまた遅れて
 * 詰める往復になる。実測 (2026-10-14、実リレー経由の 60 秒) では、遅れが約 2.5 ms で
 * 安定しているのに 58 秒の再生で 2479 ms を詰めており、声では粗さとして聞こえる。
 * そこで、遅れが 20 ms 未満のときは詰めない。時計の対応付けの不感帯 (30 ms) の中で吸収できる幅で
 * あり、実測 (2026-10-14、実リレー経由の 60 秒) では圧縮が 1911 ms から 796 ms へ減り、
 * 鳴り始めの遅れは 103 ms から 114 ms へ僅かに伸びるだけだった。
 * 時計の対応付けは読み取りごとの数 ms の揺れを意図して無視しており、その範囲の遅れは
 * 「予定の方が僅かにずれている」だけである。ここで追いかけると、時計層が無視した誤差を
 * 音の加工で打ち消すことになる。実測 (2026-10-14、実リレー経由の 60 秒) では、不感帯を
 * 5 ms にすると 1691 ms、10 ms にすると 1911 ms を時間圧縮し、20 ms にすると 796 ms まで
 * 減った (遅れの代表値は 0、鳴り始めの遅れは 98〜114 ms でほぼ変わらない)。遅れがこの幅を
 * 超えたときだけ詰め、超えた分は周期 1 つずつ減らす (削りすぎない)。不感帯を超えていても、
 * 詰める量はキューの余裕 (直前の音の終わり − (今 + 余裕)) までに切る (`schedule` を参照)
 */
export const AUDIO_PLAYOUT_STRETCH_MIN_SECONDS = 0.02;

/**
 * 不感帯とキューの余裕の判定に置く許容 (秒)
 *
 * 遅れもキューの余裕も時刻の引き算で求めるため、境目ちょうどの値が浮動小数点の誤差で
 * ずれる。不感帯ちょうどの遅れが下回ることと、余裕が 0 のはずのときに 1e-15 程度の正に
 * なることを防ぐ。この許容以下の余裕で詰めても、削れるのは 48 kHz の 1 サンプル (約 21 µs)
 * にも満たないため、詰めないものとして扱う
 */
export const AUDIO_PLAYOUT_STRETCH_MIN_EPSILON_SECONDS = 1e-9;

/**
 * 再生の遅れの下限 (秒)
 *
 * 目標を使えないとき (壁時計の TIMESTAMP を持たない音、音声だけの購読) の再生の遅れの
 * 下限に使う (上限は `AUDIO_PLAYOUT_ARRIVAL_DELAY_SECONDS`)。共有の時間軸が使う下限
 * (`AUDIO_PLAYOUT_DELAY_FLOOR_MS`) と同じ値であり、定義は時間軸側に置く (揺らぎから
 * 求めた遅れをこの値で下限にするため)
 */
export const AUDIO_PLAYOUT_DELAY_SECONDS = AUDIO_PLAYOUT_DELAY_FLOOR_MS / 1_000;

/**
 * 再生の遅れの合計の上限 (秒)
 *
 * 並べすぎの判定に使う「再生の遅れ + 余裕」の合計。余裕はこの値から
 * `AUDIO_PLAYOUT_DELAY_SECONDS` を引いた分である
 */
export const AUDIO_PLAYOUT_MAX_DELAY_SECONDS = 0.3;

/** 並べすぎとみなす、再生の遅れを超える余裕 (秒) */
export const AUDIO_PLAYOUT_BACKLOG_SECONDS =
  AUDIO_PLAYOUT_MAX_DELAY_SECONDS - AUDIO_PLAYOUT_DELAY_SECONDS;

/**
 * 鳴らす時刻を今からどれだけ先にするかの下限 (秒)
 *
 * AudioContext は 128 フレーム (48 kHz で約 2.7 ms) ずつ描くため、それより先の時刻を指定する。
 * 画面のスレッドが混んで `start()` が遅れる分も見込む
 */
export const AUDIO_PLAYOUT_MIN_LEAD_SECONDS = 0.01;

/**
 * 予約した開始時刻を押し直すときに確保する余裕 (秒)
 *
 * `AudioBufferSourceNode.start(when)` の直前に取り直した `AudioContext.currentTime` に対して
 * `when` がこの余裕より近いと、レンダリング量子 (128 フレーム = 48 kHz で約 2.7 ms) の
 * 境界をまたいで即時開始になり、直前の音と重なり得る。量子 1 つ分より少し大きい 3 ms を
 * 確保する。予約の判断に使う `AUDIO_PLAYOUT_MIN_LEAD_SECONDS` (10 ms) を押し直しにも使うと、
 * 余裕の分だけ遅れが増えるため別の値にする
 */
export const AUDIO_PLAYOUT_PUSH_START_LEAD_SECONDS = 0.003;

/**
 * 目標から離れすぎた音を、到着基準へ並べ直す境目 (秒)
 *
 * 経路の停止などで目標から大きく離れた音を鳴らすと、その分だけ音が遅れたままになる。
 * 表示の遅れの上限 (`MAX_PLAYOUT_DELAY_MS` = 500 ms) を超えたら、目標に合わせることを
 * やめる。音がまだ鳴っている間は到着基準へ並べ直さず、遅れたまま鳴らし続ける (並べ直すと
 * 媒体時刻が跳び、鳴っている音の続きが前へずれるため)。音が途切れたときだけ、ずれている
 * のは予定 (TIMESTAMP が壁時計からずれている) として、到着基準の小さな目標へ並べ直す
 */
export const AUDIO_PLAYOUT_MAX_LATENESS_SECONDS = 0.5;

/**
 * 到着基準の並べ方で、基準を取り直したとみなす、ずらす幅の下限 (秒)
 *
 * 予約できる最も早い時刻へずらすだけのとき (出力のバッファが既に到着 + 再生の遅れより先に
 * 進んでいて、音が連続したまま鳴るとき) は、ずらす幅が数 ms 以下になる。遅れて届いた音を
 * 到着 + 再生の遅れへ置き直すときは数百 ms になる。音 1 つ (Opus で 20 ms) の半分未満の
 * ずれは、媒体時刻が跳んだとはみなさない (「並べ直し」として数えない)
 */
export const AUDIO_PLAYOUT_RESYNC_MIN_JUMP_SECONDS = 0.01;

/**
 * 到着基準で鳴らすときの再生の遅れの上限 (秒)
 *
 * 到着基準の並べ方 (壁時計の TIMESTAMP を持たない音、jitter buffer が無効、トラックの
 * 基準が共有されていないとき) に使う。共有の時間軸が学習した再生の遅れ (`delaySeconds`)
 * は、TIMESTAMP が壁時計からずれているトラックではそのずれの分だけ大きく育ち、実測では
 * 316〜500 ms になって音がその分だけ遅れて鳴った。目標を使えないときは、ずれの影響を
 * 受けない小さな値 (表示の遅れの下限 50 ms の 2 倍の 100 ms) を超えないようにする。
 *
 * 定義は時間軸側 (`AUDIO_PLAYOUT_ARRIVAL_DELAY_MS`) に置く。時間軸も同じ値を使って映像を
 * 音声の到着基準の時刻へ合わせるため、片方だけを変えると A/V のずれが残る
 */
export const AUDIO_PLAYOUT_ARRIVAL_DELAY_SECONDS = AUDIO_PLAYOUT_ARRIVAL_DELAY_MS / 1_000;

/**
 * 到着基準で鳴らすときの再生の遅れを決める (秒)
 *
 * 規則は時間軸と共通である (`audioArrivalPlayoutDelayMs`)。学習した値
 * (`learnedDelaySeconds`) は経路の揺らぎを吸収するために必要であるが、上限
 * (`AUDIO_PLAYOUT_ARRIVAL_DELAY_SECONDS`) を超える分は使わず、下限は既存の
 * `AUDIO_PLAYOUT_DELAY_SECONDS` にする。
 *
 * @param learnedDelaySeconds - 共有の時間軸が学習した再生の遅れ (秒)
 * @returns 到着基準で鳴らすときの再生の遅れ (秒)
 */
export function arrivalPlayoutDelaySeconds(learnedDelaySeconds: number): number {
  return audioArrivalPlayoutDelayMs(learnedDelaySeconds * 1_000) / 1_000;
}

/**
 * 補間する隙間の下限 (秒)
 *
 * これ以下の隙間は補間せず、無音のまま残す。以前は 5 ms だったが、実リレーの収録では
 * 5 ms 以下の無音が 27 個 (合計 62.9 ms) あり、その両端の段差がクリックとして聞こえていた。
 * 440 Hz のトーンでは補間が失敗しないため、隙間を埋める方がよい。0.5 ms は 48 kHz で
 * 24 サンプルである。これ以下の隙間も無音として残さず、
 * 前の音の終わりへ揃えて穴を作らない (`snapToPreviousEnd`)。目標の
 * 表示時刻の更新や浮動小数点の丸めで生じる 20 µs〜0.5 ms の前進を連続再生で吸収するため。
 * 前の音の終わりが今より過去で揃えられないときは、実際に無音として出るため
 * `concealmentOf` が隙間として返し、呼び出し側が先頭をフェードする
 */
export const AUDIO_PLAYOUT_MIN_CONCEAL_SECONDS = 0.0005;

/**
 * 補間する隙間の上限 (秒)
 *
 * これより長い欠落は補間で埋めきらず、超えた分は無音のまま残す
 */
export const AUDIO_PLAYOUT_MAX_CONCEAL_SECONDS = 0.1;

/**
 * 補間した音の末尾の振幅
 *
 * 長い補間ほど末尾の振幅をこの値まで徐々に下げる (繰り返しの音を目立たなくする)
 */
export const AUDIO_PLAYOUT_CONCEAL_END_GAIN = 0.5;

/**
 * 補間した音の末尾の振幅を、隙間の長さから求める
 *
 * 長い補間ほど末尾の振幅を `AUDIO_PLAYOUT_CONCEAL_END_GAIN` まで下げる。呼び出し側は
 * `concealSamples` の `endGain` に渡す (規則を呼び出し側ごとに書かない)
 */
export function concealmentEndGain(gapSeconds: number): number {
  const ratio = Math.min(1, Math.max(0, gapSeconds / AUDIO_PLAYOUT_MAX_CONCEAL_SECONDS));
  return 1 - (1 - AUDIO_PLAYOUT_CONCEAL_END_GAIN) * ratio;
}

/**
 * 時計の対応付けをやり直す最小の差 (ミリ秒)
 *
 * `AudioContext.getOutputTimestamp()` はデバイスの位置の推定であり、読み取りごとに数 ms
 * 揺れる。libwebrtc の `video/stream_synchronization.cc` の不感帯 (`kMinDeltaMs` = 30 ms)
 * と同じ考え方で、これ未満の差は無視する。無視した分はそのまま A/V のずれとして残る
 */
export const AUDIO_CLOCK_DEADBAND_MS = 30;

/**
 * 時計の対応付けを 1 回で動かす上限 (ミリ秒)
 *
 * libwebrtc の `kMaxChangeMs` = 80 ms と同じ考え方。段差のある補正で音が飛ばないようにする
 */
export const AUDIO_CLOCK_MAX_CHANGE_MS = 80;

/**
 * `AudioContext` の時計が止まっていたと判定する、`performance.now()` との進みの差 (ミリ秒)
 *
 * 予約は音声 1 つ分 (20 ms) ごとに行われ、その間の 2 つの時計の進みの差は数 ms に収まる。
 * これ以上 `performance.now()` だけが進んでいたら、`AudioContext` が停止していた
 * (`suspend` / `resume`、または音声のレンダリングが止まった) とみなす。停止中は
 * `currentTime` が止まり `performance.now()` は進むため、再開後の対応は数百 ms の段差になる。
 * 段差を `AUDIO_CLOCK_MAX_CHANGE_MS` (80 ms) ずつ補正すると、再開直後の予約が数百 ms
 * 未来になって破棄される (CI の実測: 1 秒の停止後に約 900 ms 古い対応が残り、backlog で破棄)。
 * 停止を検出したときは段差をそのまま取り直す
 */
export const AUDIO_CLOCK_STALL_MS = 250;

/** 再生の余裕、下限 (省略時は既定の値) */
export interface AudioPlayoutOptions {
  backlogSeconds?: number;
  minLeadSeconds?: number;
  /**
   * 時間圧縮を始める遅れ (秒)
   *
   * 省略時は `AUDIO_PLAYOUT_STRETCH_MIN_SECONDS` (20 ms。時計の対応付けの不感帯 (30 ms) の
   * 中で吸収できる幅であり、不感帯そのものではない)。機構そのものを確かめるテストは 0 を渡す
   */
  stretchMinSeconds?: number;
}

/**
 * 1 つの音を鳴らすときの目標
 *
 * 壁時計の TIMESTAMP を持たない音は `targetStartSeconds` を null にする
 */
export interface AudioPlayoutTarget {
  /** 目標の開始時刻 (`AudioContext.currentTime` の秒) */
  targetStartSeconds: number | null;
  /** 到着の観測が揃った経路で使う回復の不感帯。省略時は既存の幅を使う。 */
  stretchMinSeconds?: number;
  /**
   * 到着した音を「まだ鳴っていない位置」として扱う時刻 (`AudioContext.currentTime` の秒)
   *
   * 呼び出し側が `AudioClockBridge.toAudioSeconds(到着時刻)` を渡す。`AudioContext` の時計
   * (`currentTime`) は、既に出力のバッファへ積まれた分だけ実際に鳴る位置より先に進むため、
   * 到着基準の遅れはこの位置から数えなければならない。`currentTime` から数えると、実際に
   * 鳴るのは「到着 + 到着基準の遅れ + バッファの分」になり、実測では目標 100 ms に対して
   * 195.5 ms になっていた。時計の対応が無いときは `nowSeconds` と同じ値を渡す
   * (`AudioClockBridge.toAudioSeconds` が null を返すとき)
   */
  arrivalSeconds: number;
  /**
   * 目標を守るか
   *
   * false のとき (音声だけを購読していて揃える相手がいないとき) は、鳴らす時刻を過ぎて
   * 届いた音は基準を取り直して鳴らす
   */
  enforceTarget: boolean;
  /**
   * 共有の時間軸が学習した再生の遅れ (秒)
   *
   * 並べすぎの上限 (`AUDIO_PLAYOUT_BACKLOG_SECONDS` を足す相手) に使う。到着基準で鳴らす
   * ときの再生の遅れは `arrivalDelaySeconds` を使う
   */
  delaySeconds: number;
  /**
   * 到着基準で鳴らすときの再生の遅れ (秒)
   *
   * 目標を使えないとき (壁時計の TIMESTAMP を持たない、jitter buffer が無効、トラックの
   * 基準が共有されていない) と、目標から離れすぎて並べ直すときに使う。`delaySeconds` に
   * 共有の時間軸が学習した値をそのまま渡すと、TIMESTAMP が壁時計からずれているトラックでは
   * そのずれの分だけ大きく育った値で鳴ってしまうため、`arrivalPlayoutDelaySeconds` で
   * 上限 (`AUDIO_PLAYOUT_ARRIVAL_DELAY_SECONDS`) を掛けた値を渡す
   */
  arrivalDelaySeconds: number;
  /**
   * 表示に使っている遅れ (秒)
   *
   * `max(targetLatency, 揺らぎから求めた再生遅延)` に同期の制御が足した分を加え、上限で
   * 切った値である (呼び出し側が `PlayoutTimeline.presentationExtraDelayMs` を渡す)。
   * 目標の表示時刻は今からこの値だけ先にあるため、並べすぎの上限はこの値から決める。
   * 同期の制御の分を落とすと上限を過小に見積もる
   */
  presentationDelaySeconds: number;
}

/**
 * 鳴らす時刻を決めるのに使った計画
 *
 * - `timestamp`: 時間軸が TIMESTAMP から決めた目標の時刻に従う
 * - `arrival`: 目標の時刻を使えない、または守れないため、到着から一定の遅れで鳴らす
 */
export type AudioPlayoutBasis = "timestamp" | "arrival";

/** 音を鳴らす時刻 (`AudioContext.currentTime` の秒) と、詰める長さ、または捨てる */
export type AudioPlayoutDecision =
  | {
      kind: "play";
      startAt: number;
      /**
       * 鳴らす時刻を決めるのに使った計画。到着基準 (`arrival`) のときは、時間軸の再生予定
       * 時刻に従っていない (予定そのものは観測値として渡してよい)
       */
      basis: AudioPlayoutBasis;
      /**
       * 波形の周期を使って詰める長さ (秒)。目標を過ぎて届いた分を目標へ戻すために要求する。
       * 遅れと音の長さの半分とキューの余裕 (直前の音の終わり − (今 + 余裕)) の最小値であり、
       * キューの余裕が 0 以下 (出力のバッファが下限を決めている) ときは 0 である。
       * 実際に詰められるかは波形しだいであり、適用した結果を `confirmStretch` で返す
       */
      compressSeconds: number;
      /**
       * 補間する隙間の開始時刻 (`AudioContext.currentTime` の秒)。
       *
       * 通常は直前の音の終わり (`lastEnd`) と同じである。前の音の終わりが予約できる
       * 最も早い時刻 (`now + minLead`) より前のときは、その時刻になるため、直前の音の
       * 終わりとは一致しない (`unrecoverableGapSeconds` が正になる)。補間しないとき
       * (`gapSeconds` が 0) は 0 であり、使わない
       */
      gapStartSeconds: number;
      /**
       * 補間を予約した長さ (秒)。`AUDIO_PLAYOUT_MAX_CONCEAL_SECONDS` で切った値であり、
       * 実際に補間できた長さは `confirmConcealment` で返す。補間しないときは 0
       *
       * `gapStartSeconds + gapSeconds` は今回の音の開始 (`startAt`) 以前になる。隙間の
       * うち、この区間だけが予約できる (補間の候補になる)
       */
      gapSeconds: number;
      /**
       * 今回の音の開始までの隙間の合計 (秒)。補間の上限で切る前の値である
       *
       * 隙間は `previousEnd` から `startAt` までであり、次の 3 つに分かれる。
       * - `gapStartSeconds - previousEnd`: 予約できる最も早い時刻より前であり、補間バッファを
       *   置けない (`unrecoverableGapSeconds`)。既に過去の分も含む
       * - `gapSeconds`: 補間を予約した長さ
       * - 残り (上限 `AUDIO_PLAYOUT_MAX_CONCEAL_SECONDS` を超えた分): 無音で残る
       *
       * 隙間が無いときは 0。下限 (`AUDIO_PLAYOUT_MIN_CONCEAL_SECONDS`) 以下でも、前の音の
       * 終わりが今より過去で揃えられないときは正の値になる (補間はせず無音として残る。
       * このとき `gapStartSeconds` は 0 で `gapSeconds` も 0)
       */
      totalGapSeconds: number;
      /**
       * 予約できる最も早い時刻より前の隙間の長さ (秒)
       *
       * 直前の音の終わり (`previousEnd`) が「今 + 余裕 (`now + minLead`)」より前のとき、
       * その分の区間は補間バッファを予約できないため無音のまま残る。**既に過去の分だけでなく、
       * 今より未来でも余裕 (`minLead`) に満たない分も含む**。アンダーランと、予約の余裕が
       * 足りないだけの両方がここに入る。この場合、補間の先頭は前の音の末尾と連続しない
       * (間に無音がある) ため、呼び出し側は補間の先頭と今回の音の先頭をフェードインして
       * 段差を消す。0 なら隙間の先頭は直前の音の終わりに接しており、補間の先頭は前の音と
       * 連続する
       */
      unrecoverableGapSeconds: number;
    }
  | {
      kind: "drop";
      /**
       * 捨てた理由
       *
       * - `backlog`: 並べる音が溜まりすぎている (再生が追いついていない)
       */
      reason: "backlog";
    };

/** 基準: この timestamp の音をこの時刻に鳴らす */
interface PlayoutAnchor {
  time: number;
  timestampMicroseconds: number;
}

export class AudioPlayoutScheduler {
  private readonly backlogSeconds: number;
  private readonly minLeadSeconds: number;
  /** 時間圧縮を始める遅れ (秒) */
  private readonly stretchMinSeconds: number;
  private anchor: PlayoutAnchor | null = null;
  // 直前に鳴らすと決めた音の終わりの時刻と timestamp
  private lastEnd: number | null = null;
  private lastTimestampMicroseconds: number | null = null;
  private rebaseCount = 0;
  private dropCount = 0;
  // 目標に対して今どれだけ遅れているか (秒)。遅れて鳴らした分を足し、詰めた分を引く
  private latenessSeconds = 0;
  // 直前の音に要求した詰める量 (秒)。`confirmStretch` で実際の値に置き換える
  private requestedSeconds = 0;
  // 到着基準の圧縮では、確定した削減量だけ timestamp と再生時刻の対応も前へ戻す。
  private requestedByArrival = false;
  // 詰めた合計 (秒)。統計に出す
  private compressedSeconds = 0;
  // 補間した合計 (秒) と回数。統計に出す
  private concealedSeconds = 0;
  private concealCount = 0;
  // 直前の音に要求した補間の長さ (秒)。`confirmConcealment` で実際の値に置き換える
  private requestedConcealSeconds = 0;

  constructor(options: AudioPlayoutOptions = {}) {
    this.backlogSeconds = options.backlogSeconds ?? AUDIO_PLAYOUT_BACKLOG_SECONDS;
    this.minLeadSeconds = options.minLeadSeconds ?? AUDIO_PLAYOUT_MIN_LEAD_SECONDS;
    this.stretchMinSeconds = options.stretchMinSeconds ?? AUDIO_PLAYOUT_STRETCH_MIN_SECONDS;
  }

  /** 基準を取り直した回数 (目標を使わないときの、過ぎてから届いた音と timestamp が大きく飛んだ音) */
  get rebases(): number {
    return this.rebaseCount;
  }

  /** 捨てた音の数 (並べすぎの音、目標から離れすぎて到着も途切れていた音) */
  get drops(): number {
    return this.dropCount;
  }

  /** 波形の周期を使って詰めた合計 (秒) */
  get compressed(): number {
    return this.compressedSeconds;
  }

  /** 目標に対して今どれだけ遅れているか (秒) */
  get lateness(): number {
    return this.latenessSeconds;
  }

  /** 補間した合計 (秒) */
  get concealed(): number {
    return this.concealedSeconds;
  }

  /** 補間した回数 (実際に補間できた音の数) */
  get concealments(): number {
    return this.concealCount;
  }

  /**
   * 音を鳴らす時刻を決める
   *
   * @param nowSeconds - 今の時刻 (`AudioContext.currentTime`)
   * @param timestampMicroseconds - 音の timestamp (`AudioData.timestamp`)
   * @param durationSeconds - 音の長さ (`AudioBuffer.duration`)
   * @param target - 目標の開始時刻と、それを守るか
   */
  schedule(
    nowSeconds: number,
    timestampMicroseconds: number,
    durationSeconds: number,
    target: AudioPlayoutTarget,
  ): AudioPlayoutDecision {
    // 前の音の補間と圧縮の確定が返っていなければ、適用されなかったものとして扱う。
    this.requestedConcealSeconds = 0;
    this.confirmStretch(0);
    if (target.targetStartSeconds === null || !target.enforceTarget) {
      return this.scheduleByArrival(
        nowSeconds,
        target.arrivalSeconds,
        timestampMicroseconds,
        durationSeconds,
        target.arrivalDelaySeconds,
      );
    }
    const stretchMinSeconds = target.stretchMinSeconds ?? this.stretchMinSeconds;
    const targetStartSeconds = target.targetStartSeconds;
    const limit =
      Math.max(target.delaySeconds, target.presentationDelaySeconds) + this.backlogSeconds;
    if (targetStartSeconds > nowSeconds + limit) {
      // 並べる音が溜まりすぎている
      this.dropCount += 1;
      return { kind: "drop", reason: "backlog" };
    }
    // 目標を過ぎて届いた音も、前の音と重なる音も捨てない。今から鳴らせる最も早い時刻へ
    // ずらして鳴らし、ずらした分を波形の周期を使って詰めることで目標へ戻す
    // (libwebrtc の NetEq は遅れて届いたパケットを捨てず、accelerate で目標へ戻す)
    const previousEnd = this.lastEnd;
    const earliestSeconds = Math.max(nowSeconds + this.minLeadSeconds, previousEnd ?? -Infinity);
    // 前の音の終わりとの差が下限 (0.5 ms) 以下なら、前の音の終わりに揃えて穴を作らない。
    // 目標の表示時刻が前のフレームから 20 µs〜0.5 ms だけ動くことがあり、その分を穴として
    // 扱うと 1〜2 サンプルのデジタル無音が残って段差になるためである。補間やフェードでは
    // なく連続再生で吸収する (最大 0.5 ms 早く鳴るだけで、目標に対する遅れは無視できる)
    const startAt = this.snapToPreviousEnd(
      Math.max(targetStartSeconds, earliestSeconds),
      previousEnd,
      nowSeconds,
    );
    // スナップで目標より前に鳴ることがあるため、遅れは負にしない。統計側も同じ丸めをする
    // (`AudioPlayoutTimingStats.recordPlay`)
    const latenessSeconds = Math.max(0, startAt - targetStartSeconds);
    if (latenessSeconds > AUDIO_PLAYOUT_MAX_LATENESS_SECONDS) {
      // 目標から離れすぎている。直前の音がまだ鳴っている間は、音が連続しているため到着基準へ
      // 並べ直さない (並べ直すと媒体時刻が跳び、鳴っている音の続きが前へずれる)。遅れたままでも
      // 順序と連続性を保つ方がよい。並べ直すのは音が本当に途切れたときだけにする
      const interrupted = previousEnd === null || previousEnd <= nowSeconds;
      if (interrupted) {
        // キューが空である (まだ一度も鳴らしていない、または直前の音が既に鳴り終わっている)。
        // 到着は乱れていないのに予定だけが過去にある = TIMESTAMP が壁時計からずれている。
        // 捨てると語尾が切れるため、到着基準の小さな目標へ並べ直して鳴らす
        return this.rebaseByArrival(
          nowSeconds,
          target.arrivalSeconds,
          timestampMicroseconds,
          durationSeconds,
          target.arrivalDelaySeconds,
        );
      }
    }
    // 遅れは前の音から引き継いだ分も含めた「今の音のずれ」である (積み上げない)。
    // 詰めた分は前の音の終わりが早くなることで次の音へ引き継がれる
    this.latenessSeconds = latenessSeconds;
    // キューの余裕 = 直前の音の終わり − (今 + 余裕)。既に並べてある音のうち、予約できる
    // 最も早い時刻 (今 + 余裕) より先に置かれている分である。詰めるとこの音の終わりが
    // 早くなり、次に並べる音の下限がその分だけ前へ動くため、余裕の範囲でだけ遅れを
    // 減らせる。余裕が 0 以下 (出力のバッファが下限を決めている) ときは、次に並べる音が
    // 今 + 余裕で決まり、その下限は実時間と同じ速さで進むため、詰めても遅れは 1 ms も
    // 減らない。削った分は次の音の開始との間の穴になる。実測 (2026-10-16、実装を直接駆動。
    // 出力のリード 95.5 ms、表示の遅れ 66 ms、10 ms の音 100 フレーム) では、100 件すべてが
    // 圧縮を要求して 5 ms ずつ削れ、99 件・495 ms の穴 (当時 5 ms 以下は `concealmentOf` の規則で
    // 補間されないため無音) が空き、遅れは 39.5 ms のまま 1 ms も減らなかった
    const queueSlackSeconds = (previousEnd ?? -Infinity) - (nowSeconds + this.minLeadSeconds);
    // 詰める量は「遅れ」「音の長さの半分」「キューの余裕」の最小値にする (1 つの音で
    // 詰めすぎない。余裕を超えて詰めると、削った分がそのまま無音の穴になる)。
    // 余裕が 0 以下 (出力のバッファが下限) のときは詰めない。浮動小数点の誤差で余裕が
    // ちょうど 0 にならず 1e-15 程度の正になることがあるため、許容を置いて比べる
    // (この許容以下の余裕で削れるのは 48 kHz の 1 サンプルにも満たない)
    // 遅れが `AUDIO_PLAYOUT_STRETCH_MIN_SECONDS` 未満のときも詰めない (不感帯)。系統的に
    // 数 ms 遅れて届く音で毎回わずかに詰めると、削った分だけ早すぎる側へ振れて往復する。
    // 実際に削れる長さは周期で決まるため、周期がこの量を超える音でも詰めない
    // (src/playout/audioTimeStretch.ts の compressSamples)
    // 浮動小数点の誤差で不感帯ちょうどの遅れが下回らないように、比較には小さな許容を置く
    // (時刻は performance.now 系の秒であり、引き算の結果は 1e-15 程度ずれる)
    const compressSeconds =
      queueSlackSeconds > AUDIO_PLAYOUT_STRETCH_MIN_EPSILON_SECONDS &&
      this.latenessSeconds + AUDIO_PLAYOUT_STRETCH_MIN_EPSILON_SECONDS >= stretchMinSeconds
        ? Math.min(this.latenessSeconds, durationSeconds / 2, queueSlackSeconds)
        : 0;
    this.requestedSeconds = compressSeconds;
    this.lastEnd = startAt + durationSeconds - compressSeconds;
    this.lastTimestampMicroseconds = timestampMicroseconds;
    const concealment = this.concealmentOf(nowSeconds, previousEnd, startAt);
    return { kind: "play", startAt, basis: "timestamp", compressSeconds, ...concealment };
  }

  /**
   * 実際に詰めた長さを記録する (呼び出し側が時間圧縮を適用した後に呼ぶ)
   *
   * 要求した量より少なくしか詰められなかったとき (波形が繰り返していないとき) は、
   * 詰められなかった分だけ音が後ろへ伸び、遅れとして残る
   *
   * @param appliedSeconds - 実際に詰めた長さ (秒)
   */
  confirmStretch(appliedSeconds: number): void {
    const requestedSeconds = this.requestedSeconds;
    this.requestedSeconds = 0;
    if (requestedSeconds === 0) {
      return;
    }
    const applied = Math.max(0, Math.min(appliedSeconds, requestedSeconds));
    if (this.requestedByArrival && this.anchor !== null) {
      this.anchor.time -= applied;
    }
    this.requestedByArrival = false;
    this.compressedSeconds += applied;
    if (applied < requestedSeconds && this.lastEnd !== null) {
      // 詰められなかった分は音が後ろへ伸びる
      this.lastEnd += requestedSeconds - applied;
    }
  }

  /**
   * 実際に補間した長さを記録する (呼び出し側が補間を予約した後に呼ぶ)
   *
   * 要求した長さより長い分は要求までに切り、0 のときは数えない (相関が足りない、
   * 上限を超えた、予約できない場合に数えないため)
   *
   * @param appliedSeconds - 実際に補間した長さ (秒)
   */
  confirmConcealment(appliedSeconds: number): void {
    const requestedSeconds = this.requestedConcealSeconds;
    this.requestedConcealSeconds = 0;
    if (requestedSeconds === 0) {
      return;
    }
    const applied = Math.max(0, Math.min(appliedSeconds, requestedSeconds));
    if (applied === 0) {
      return;
    }
    this.concealCount += 1;
    this.concealedSeconds += applied;
  }

  /** サンプルへの丸めと開始の押し直しを含む、実際のバッファの終わりを確定する。 */
  confirmPlayoutEnd(endSeconds: number): void {
    if (this.lastEnd !== null && Number.isFinite(endSeconds) && endSeconds >= 0) {
      this.lastEnd = endSeconds;
    }
  }

  /**
   * 前の音の終わりとの差が下限 (0.5 ms) 以下なら、開始時刻を前の音の終わりへ揃える
   *
   * 目標の表示時刻は、時間軸の基準 (直近 10 秒の最小値) の更新や浮動小数点の丸めで、
   * 前のフレームの目標から 20 µs〜0.5 ms だけ後ろへ動くことがある。その分を隙間として
   * 扱うと、補間にもフェードにもならない 1〜2 サンプル (20〜40 µs) のデジタル無音が残り、
   * 両側の段差がクリックになる。補間やフェードではなく、前の音の終わりに揃えて連続再生で
   * 吸収する (最大 0.5 ms 早く鳴るだけで、目標に対する遅れは無視できる)。
   *
   * 前の音の終わりが今 + 余裕よりわずかに過去のときも、この範囲なら前の音の終わりは
   * まだ未来 (今 + 余裕 − 0.5 ms 以降) であり、予約できる。ただし今より過去へは戻さない
   * (余裕 (`minLeadSeconds`) を 0 に設定したときに、過去への予約にならないようにするため)
   *
   * @param startAt - 決めた開始時刻 (秒)
   * @param previousEnd - 直前の音の終わりの時刻 (秒)。無ければ null
   * @param nowSeconds - 今の時刻 (`AudioContext.currentTime`。秒)
   * @returns 揃えた開始時刻 (秒)
   */
  private snapToPreviousEnd(
    startAt: number,
    previousEnd: number | null,
    nowSeconds: number,
  ): number {
    if (previousEnd === null) {
      return startAt;
    }
    const gapSeconds = startAt - previousEnd;
    if (gapSeconds <= 0 || gapSeconds > AUDIO_PLAYOUT_MIN_CONCEAL_SECONDS) {
      return startAt;
    }
    if (previousEnd < nowSeconds) {
      // 過去へは予約しない (時計の進み方によっては start() が即時開始になり重なる)
      return startAt;
    }
    return previousEnd;
  }

  /**
   * 前の音の終わりと今回の開始時刻の間から、補間する隙間を求める
   *
   * 隙間を「予約できる最も早い時刻より前の分 (`unrecoverableGapSeconds`。既に過去の分と、
   * 未来でも余裕に満たない分の両方を含む)」「予約できる分 (`gapSeconds`、上限
   * `AUDIO_PLAYOUT_MAX_CONCEAL_SECONDS` で切る)」「上限を超えて無音で残る分」に分ける。
   * 下限 (`AUDIO_PLAYOUT_MIN_CONCEAL_SECONDS`) 以下の隙間は補間しない。
   *
   * 前の音の終わりが過去でも、今回の開始が今 + 余裕より未来なら、その未来の分は補間を
   * 予約できる。予約する区間は必ず `now + minLead` 以降になる。見つかった隙間は
   * `confirmConcealment` で実際に補間した長さを返す要求として記録する。
   */
  private concealmentOf(
    nowSeconds: number,
    previousEnd: number | null,
    startAt: number,
  ): {
    gapStartSeconds: number;
    gapSeconds: number;
    totalGapSeconds: number;
    unrecoverableGapSeconds: number;
  } {
    if (previousEnd === null) {
      return {
        gapStartSeconds: 0,
        gapSeconds: 0,
        totalGapSeconds: 0,
        unrecoverableGapSeconds: 0,
      };
    }
    // 隙間が無ければ何も返さない。下限以下の隙間は schedule / scheduleByArrival が
    // 前の音の終わりへ揃えるため通常はここへ届かないが、揃えられなかった場合
    // (前の音の終わりが今より過去で、過去へは予約しないため) は、実際に無音として出る。
    // そのため下限以下でも totalGapSeconds / unrecoverableGapSeconds を返す
    const totalGapSeconds = startAt - previousEnd;
    if (totalGapSeconds <= 0) {
      return {
        gapStartSeconds: 0,
        gapSeconds: 0,
        totalGapSeconds: 0,
        unrecoverableGapSeconds: 0,
      };
    }
    // 補間バッファを予約できる最も早い時刻。前の音の終わりが今 + 余裕より前でも、
    // 今回の音の開始がその先なら、未来の分だけは補間できる
    const reservableStartSeconds = Math.max(previousEnd, nowSeconds + this.minLeadSeconds);
    const unrecoverableGapSeconds = Math.max(
      0,
      Math.min(totalGapSeconds, reservableStartSeconds - previousEnd),
    );
    if (totalGapSeconds <= AUDIO_PLAYOUT_MIN_CONCEAL_SECONDS) {
      // 下限以下の隙間は補間しない。揃えられなかった分は無音として残る
      return {
        gapStartSeconds: 0,
        gapSeconds: 0,
        totalGapSeconds,
        unrecoverableGapSeconds,
      };
    }
    // 予約できる区間 = 予約できる先頭から startAt まで (上限で切る)
    const reservableSeconds = Math.min(
      startAt - reservableStartSeconds,
      AUDIO_PLAYOUT_MAX_CONCEAL_SECONDS,
    );
    if (reservableSeconds <= AUDIO_PLAYOUT_MIN_CONCEAL_SECONDS) {
      // 予約できる区間が下限以下。隙間はあるが補間しない
      return {
        gapStartSeconds: 0,
        gapSeconds: 0,
        totalGapSeconds,
        unrecoverableGapSeconds,
      };
    }
    this.requestedConcealSeconds = reservableSeconds;
    return {
      gapStartSeconds: reservableStartSeconds,
      gapSeconds: reservableSeconds,
      totalGapSeconds,
      unrecoverableGapSeconds,
    };
  }

  /** 基準を消す。次の音で作り直す (購読のやり直し、AudioContext の作り直し) */
  reset(): void {
    this.anchor = null;
    this.lastEnd = null;
    this.lastTimestampMicroseconds = null;
    this.latenessSeconds = 0;
    this.requestedSeconds = 0;
    this.requestedByArrival = false;
    this.requestedConcealSeconds = 0;
  }

  /**
   * 目標を使わないときの決め方
   *
   * 最初の音で基準を決め、timestamp の間隔どおりに並べる。過ぎてから届いた音は基準を
   * 取り直し、timestamp が大きく飛んだ音は前の音のすぐ後ろと到着 + 再生の遅れの遅い方から
   * 並べ直し、並べすぎの音は捨てる。
   *
   * 並べる基準は `arrivalSeconds` (到着した音がまだ鳴っていない位置) である。`nowSeconds`
   * (`AudioContext.currentTime`) は既に出力のバッファへ積まれた分だけ先に進んでいるため、
   * ここから遅れを数えると実際に鳴るのは「到着 + 遅れ + バッファの分」になる
   *
   * @param nowSeconds - 今の時刻 (`AudioContext.currentTime`)
   * @param arrivalSeconds - 到着した音がまだ鳴っていない位置 (`AudioContext.currentTime` の秒)
   * @param arrivalDelaySeconds - 到着基準で鳴らすときの再生の遅れ (秒)
   */
  private scheduleByArrival(
    nowSeconds: number,
    arrivalSeconds: number,
    timestampMicroseconds: number,
    durationSeconds: number,
    arrivalDelaySeconds: number,
  ): AudioPlayoutDecision {
    const limitSeconds = arrivalDelaySeconds + this.backlogSeconds;
    const previousEnd = this.lastEnd;
    // 予約できる最も早い時刻。到着から再生の遅れだけ後ろに置いた時刻がこれより前なら、
    // その時刻にはもう予約できない (出力のバッファが先に進んでいる)
    const earliestSeconds = nowSeconds + this.minLeadSeconds;
    let startAt = this.expectedStartAt(timestampMicroseconds, arrivalSeconds, arrivalDelaySeconds);
    if (startAt < earliestSeconds) {
      // 過ぎてから届いた (前の音はすべて今より前に終わっているため、重ならない)。今から
      // 鳴らせる最も早い時刻へずらす。ずらす幅が無視できるときは基準を取り直さない
      // (取り直すと媒体時刻が跳び、その回数を「並べ直し」として数えてしまう)
      // 既に待ちを使い切った音へ、目標の深さを再度足さない。穴の長さと再生の遅延が
      // さらに増えないようにし、回復した音を再び待たせない。
      const resyncedSeconds = earliestSeconds;
      if (resyncedSeconds - startAt >= AUDIO_PLAYOUT_RESYNC_MIN_JUMP_SECONDS) {
        this.rebase(resyncedSeconds, timestampMicroseconds);
      }
      startAt = resyncedSeconds;
    } else if (startAt > nowSeconds + limitSeconds) {
      // timestamp が大きく飛んだ。前の音のすぐ後ろ (か到着 + 再生の遅れ) から並べ直す
      const earliest = Math.max(
        arrivalSeconds + arrivalDelaySeconds,
        earliestSeconds,
        this.lastEnd ?? -Infinity,
      );
      if (earliest > nowSeconds + limitSeconds) {
        // 並べる音が溜まりすぎている。捨てて次の音を目標へ戻す
        this.dropCount += 1;
        return { kind: "drop", reason: "backlog" };
      }
      startAt = earliest;
      this.rebase(startAt, timestampMicroseconds);
    }
    // 前の音の終わりとの差が下限以下なら、前の音の終わりに揃えて穴を作らない
    // (目標の表示時刻の更新や浮動小数点の丸めで生じる 0.5 ms 未満の前進を連続再生で吸収する)
    startAt = this.snapToPreviousEnd(startAt, previousEnd, nowSeconds);
    // 停滞で後ろへ動かした基準は、経路が回復しても自然には戻らない。
    // 到着 + 目標の深さより余分に溜まった分だけを、既存の不感帯とキューの余裕の中で
    // 圧縮する。隙間を挟む音は詰めない。確定した量は confirmStretch で基準へ反映する。
    const arrivalTarget = arrivalSeconds + arrivalDelaySeconds;
    this.latenessSeconds = Math.max(0, startAt - arrivalTarget);
    const queueSlackSeconds = (previousEnd ?? -Infinity) - earliestSeconds;
    const compressSeconds =
      previousEnd !== null &&
      startAt <= previousEnd + AUDIO_PLAYOUT_STRETCH_MIN_EPSILON_SECONDS &&
      queueSlackSeconds > AUDIO_PLAYOUT_STRETCH_MIN_EPSILON_SECONDS &&
      this.latenessSeconds + AUDIO_PLAYOUT_STRETCH_MIN_EPSILON_SECONDS >= this.stretchMinSeconds
        ? Math.min(this.latenessSeconds, durationSeconds / 2, queueSlackSeconds)
        : 0;
    this.requestedSeconds = compressSeconds;
    this.requestedByArrival = compressSeconds > 0;
    this.lastEnd = startAt + durationSeconds - compressSeconds;
    this.lastTimestampMicroseconds = timestampMicroseconds;
    const concealment = this.concealmentOf(nowSeconds, previousEnd, startAt);
    return { kind: "play", startAt, basis: "arrival", compressSeconds, ...concealment };
  }

  /**
   * 目標から離れすぎた音を、到着基準の小さな目標へ並べ直す
   *
   * 音が途切れていて (キューが空で) 目標だけが過去にあるとき、ずれているのは予定の方である
   * (TIMESTAMP が壁時計からずれている)。詰めて目標へ戻すのではなく、基準そのものを
   * 到着基準へ置き直し、以降の音も同じ遅れで並ぶようにする。音がまだ鳴っている間は
   * 呼ばない (`schedule` を参照)。並べ直すと媒体時刻が跳び、鳴っている音の続きが前へずれる
   * ためである。
   *
   * 音は捨てない。捨てると語尾が切れるためである。並べ直しで空いた分は、前の音の終わりと
   * 今回の開始の間の隙間として返す (呼び出し側が上限まで補間できる)
   *
   * @param nowSeconds - 今の時刻 (`AudioContext.currentTime`)
   * @param arrivalSeconds - 到着した音がまだ鳴っていない位置 (`AudioContext.currentTime` の秒)
   * @param arrivalDelaySeconds - 到着基準で鳴らすときの再生の遅れ (秒)
   */
  private rebaseByArrival(
    nowSeconds: number,
    arrivalSeconds: number,
    timestampMicroseconds: number,
    durationSeconds: number,
    arrivalDelaySeconds: number,
  ): AudioPlayoutDecision {
    const previousEnd = this.lastEnd;
    // 到着から再生の遅れだけ後ろへ置く (到着した音がまだ鳴っていない位置から数える)。前の
    // 音の終わりより前には鳴らさない (重ねない)
    const startAt = Math.max(
      arrivalSeconds + arrivalDelaySeconds,
      nowSeconds + this.minLeadSeconds,
      previousEnd ?? -Infinity,
    );
    // ここでは前の音の終わりに揃えない。この経路は前の音が既に鳴り終わっている
    // (`previousEnd <= now`) ときだけ呼ばれ、揃えても過去への予約になるためである。
    // 下限以下の隙間が残る場合は concealmentOf が無音として返し、呼び出し側が先頭を
    // フェードする
    this.rebase(startAt, timestampMicroseconds);
    this.lastEnd = startAt + durationSeconds;
    this.lastTimestampMicroseconds = timestampMicroseconds;
    // 到着基準へ移ったため、目標に対する遅れは無い (詰めない)
    this.latenessSeconds = 0;
    this.requestedSeconds = 0;
    const concealment = this.concealmentOf(nowSeconds, previousEnd, startAt);
    return {
      kind: "play",
      startAt,
      basis: "arrival",
      compressSeconds: 0,
      ...concealment,
    };
  }

  /**
   * 基準と前の音から、この音を鳴らす時刻を求める (前の音の終わりより前にしない)
   *
   * @param arrivalSeconds - 到着した音がまだ鳴っていない位置 (`AudioContext.currentTime` の秒)。
   *   最初の音の基準は、この位置から再生の遅れだけ後ろへ置いた時刻になる
   */
  private expectedStartAt(
    timestampMicroseconds: number,
    arrivalSeconds: number,
    arrivalDelaySeconds: number,
  ): number {
    if (this.anchor === null) {
      this.anchor = {
        time: arrivalSeconds + arrivalDelaySeconds,
        timestampMicroseconds,
      };
      return this.anchor.time;
    }
    const advanced =
      this.lastTimestampMicroseconds !== null &&
      timestampMicroseconds > this.lastTimestampMicroseconds;
    const byTimestamp =
      this.anchor.time + (timestampMicroseconds - this.anchor.timestampMicroseconds) / 1_000_000;
    const afterPrevious = this.lastEnd ?? byTimestamp;
    return advanced ? Math.max(byTimestamp, afterPrevious) : afterPrevious;
  }

  private rebase(time: number, timestampMicroseconds: number): void {
    this.anchor = { time, timestampMicroseconds };
    this.rebaseCount += 1;
  }
}

/** `AudioContext.getOutputTimestamp()` が返す対応 */
export interface AudioClockMapping {
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
 * - 対応は予約のたびに取り直し、直前の値との差が `AUDIO_CLOCK_DEADBAND_MS` 未満なら無視し、
 *   大きくても 1 回の変更を `AUDIO_CLOCK_MAX_CHANGE_MS` までにする
 * - `AudioContext` が停止していた (2 つの時計の進みの差が `AUDIO_CLOCK_STALL_MS` 以上) ときは、
 *   段差をそのまま取り直す。停止中の `currentTime` は止まるため、上限までずつ補正すると
 *   再開直後の予約が未来になり破棄される
 * - `AudioContext` を作り直したときは `reset()` で対応を消し、次の予約で取り直す
 * - `getOutputTimestamp()` が未開始 (両方 0) のときは `currentTime` と `performance.now()` の
 *   差で代用する。この差は音声の出力遅延を含まないため、鳴るのは目標より出力遅延の分だけ
 *   後ろになる (`usingFallback` で分かる)
 *
 * ブラウザ API に依存せず、値は引数で受ける。
 */
export class AudioClockBridge {
  private offsetMs: number | null = null;
  private fallback = false;
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
    if (this.offsetMs === null || stalled) {
      this.offsetMs = observedMs;
    } else {
      const differenceMs = observedMs - this.offsetMs;
      if (Math.abs(differenceMs) >= AUDIO_CLOCK_DEADBAND_MS) {
        const stepMs = Math.min(Math.abs(differenceMs), AUDIO_CLOCK_MAX_CHANGE_MS);
        this.offsetMs += Math.sign(differenceMs) * stepMs;
      }
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
