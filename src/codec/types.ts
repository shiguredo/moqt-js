/**
 * コーデック関連の型定義
 */

import type { PlayoutDelayBreakdown } from "../playout/timeline";
import type { AudioPlayoutTimingSnapshot } from "../playout/audioPlayoutTimingStats";
import type { AudioTimestampOffsetStats } from "../audioTimestampClock";
import type { AudioPublishCatchUpStats } from "../audioPublishCatchUp";
import type { AudioReceiveCatchUpStats } from "../playout/audioReceiveCatchUp";

// オーディオコーデック
export type AudioCodecType = "opus" | "aac";

// ビデオコーデック
export type VideoCodecType = "h264" | "h265" | "vp8" | "vp9" | "av1";

// MediaPublisher の状態
export type MediaPublisherState = "created" | "publishing" | "paused" | "stopped" | "closed";

// MediaSubscriber の状態
export type MediaSubscriberState = "created" | "subscribing" | "active" | "stopped" | "closed";

// オーディオ統計
export interface AudioStats {
  framesSent: number;
  bytesSent: number;
  currentGroupId: number;
  // 音声の TIMESTAMP を壁時計へ合わせるための観測。
  // 「読み出した壁時計 - AudioData.timestamp」の現在値・最小・最大と 10 秒 / 60 秒の傾き。
  // まだ観測していないときは null
  timestampOffset: AudioTimestampOffsetStats | null;
  // 遅れが上限を超えたときに古いフレームを捨てて live へ追いついた量
  // (src/audioPublishCatchUp.ts)。捨てた数と長さ、観測した遅れを出す。
  // 実測値は getStats() が読む時点の観測から作る
  catchUp: AudioPublishCatchUpStats | null;
  // 停止時に encoder の flush で送ろうとした末尾の量 (累積。停止のたびに増える)。
  // 数は符号化の出力 (chunk) の数、長さは chunk の duration の合計 (ミリ秒)。
  // 送信を試みた時点で数えるため、write が失敗した分も含む。停止以外の経路 (pause) では
  // 増えない
  tailFlushedFrames: number;
  tailFlushedMs: number;
  // 停止時に取り込みキューから読み出したが、送れなかった入力の量 (累積)。
  // 数は取り込みブロック (10 ms) の数、長さは送信した chunk が覆わなかった範囲
  // (ミリ秒)。0 でも、drain の打ち切りで読まなかった取り込みキューと、write の
  // 失敗は含まない
  tailDroppedFrames: number;
  tailDroppedMs: number;
  // 停止時の drain・flush・送信の待ちが上限で打ち切られた停止の回数 (累積)。
  // 1 つの停止で複数の待ちが打ち切られても 1 回と数える。1 以上なら、入力が途切れた・
  // worker が応答しなかったなどの打ち切りがあったことを示す
  tailFlushTimeoutCount: number;
}

// 受信側オーディオ統計
export interface AudioReceiverStats {
  // 復号へ渡した音声 Object の数。`subgroupFramesReceived` と `datagramFramesReceived` の和
  framesReceived: number;
  // Subgroup (Data Stream) で届いた数 (draft-ietf-moq-transport-22 §11)
  subgroupFramesReceived: number;
  // Datagram で届いた数 (draft-ietf-moq-transport-22 §11.2)。QUIC 上の WebTransport では
  // 再送されないため、経路の欠落がそのままこの数の不足になる (HTTP/2 上の WebTransport では
  // 再送される。§6.2)。補間と捨ての割合 (`playoutConcealments` / `playoutDrops` /
  // `playoutTiming`) を経路ごとに比べられるようにする
  datagramFramesReceived: number;
  bytesReceived: number;
  // SUBSCRIBE_OK の LARGEST_OBJECT 以前の音声 Object を、relay の cache から届いた分として
  // 復号へ渡さず捨てた数 (累積)。購読を始めるたびに境界を設定し直し、停止すると境界を消す。
  // 境界が無い (LARGEST_OBJECT が省略された) 購読では 0 のまま
  // (src/catchUpGate.ts)
  catchUpObjectsSkipped: number;
  // 目標を使わない並べ方で、基準を取り直した回数
  // (鳴らす時刻を過ぎて届いた音、timestamp が大きく飛んだ音)
  playoutRebases: number;
  // 並べすぎの音と、目標から離れすぎて到着も途切れていた音として捨てた数
  playoutDrops: number;
  // 欠落した区間や、時間軸の目標の遅延が増えたときに補間した回数
  playoutConcealments: number;
  // 波形の周期を使って詰めた合計 (ms)
  playoutCompressedMs: number;
  // 補間した合計 (ms)
  playoutConcealedMs: number;
  // 目標を守る並べ方で最後に並べた音の遅れ (ms)。基準を消すと 0 に戻る
  playoutLatenessMs: number;
  // 音声の再生の観測値。鳴るはずの時刻 (再生予定時刻)・届いた時刻・鳴り始める時刻と、
  // 予定に対する余裕の分布 (直近 10 秒の p50 / p95 / max)、鳴らなかった量 (件数と ms) を
  // 理由ごとに出す。加えて、補間で埋まらなかった無音の穴 (回数 / 合計 ms / 最大 ms と、
  // 予約できる最も早い時刻より前だった分)、予約した時刻を currentTime が追い越した回数と
  // 最大、バッファ境界の段差の回数と最大を累積で持つ。加えて、直近の停止で予約済みの音を
  // 鳴らし切った drain の結果 (鳴らせた量・切った量・待ち時間・flush 件数、`lastDrain`)
  // を持つ。時刻は performance.now() と同じ軸のミリ秒 (src/playout/audioPlayoutTimingStats.ts)
  playoutTiming: AudioPlayoutTimingSnapshot;
  // 受信側の音声の追いつき。復号の出力が送られた TIMESTAMP から遅れ続けたときに、
  // 復号器を作り直して live へ戻した量 (src/playout/audioReceiveCatchUp.ts)。観測した遅れと
  // 健全時の遅れ (床)、遅れの上限、追いつきの最中かどうか、作り直した回数、飛んだ音の
  // 数と長さ (timestamp の跳びから求めた推定) を出す
  playoutCatchUp: AudioReceiveCatchUpStats;
}

// ビデオ統計
export interface VideoStats {
  framesSent: number;
  // エンコード能力を超えたため、または実行時エラーでエンコーダーが使えなくなったために
  // 破棄したフレーム数 (エンコーダーが閉じたときに読み取っていたフレームを含む。閉じた後は
  // 処理ループが終了するため、以後のフレームは読み取らず数えない。世代が変わった後に
  // 読んだフレームと encode が同期 throw したフレームは数えない)。閾値は
  // createMediaPublisher の判定
  droppedFrames: number;
  keyFramesSent: number;
  bytesSent: number;
  currentGroupId: number;
}

// 受信側ビデオ統計
export interface VideoReceiverStats {
  framesReceived: number;
  keyFramesReceived: number;
  bytesReceived: number;
  // 復号中の Group より古い Group の Object、または重複・遅着の Object として復号せずに
  // 捨てたフレーム数 (VideoDecodeOrder の stale)
  staleFramesDropped: number;
  // 参照するフレームが欠けているためキーフレームを待つ間に捨てたフレーム数
  // (VideoDecodeOrder の missing-reference)
  missingReferenceFramesDropped: number;
}

// 送信側メディア統計
export interface MediaStats {
  audio: AudioStats | null;
  video: VideoStats | null;
}

// 受信側の音声と映像の同期の推定値
export interface AvSyncStats {
  // 同期ずれの推定値 (ms)。映像の表示が音声より遅れていれば正。
  // 音声は予約した時刻、映像は write した時刻の実績から求める (実際に音が出るまでの
  // 出力遅延と、映像が表示されるまでの表示周期の遅れは含まない)。
  // どちらかの実績が 1 秒より古いときは null。基準を共有できないと保持された側は到着
  // 基準で再生され、その側は実績を作らないため、解除している間も null になる
  skewMs: number | null;
  // 表示の遅れ (ms)。TIMESTAMP から表示時刻までの差で、時計のずれの分だけ負にもなる。
  // 基準が未確立なら null
  presentationDelayMs: number | null;
  // catalog から解決した目標遅延 (ms)。無い、または使えないときは null。
  // 実際に表示の遅れに使う値は、上限に収まらない分 (targetLatencyLimitedMs) を
  // 切り下げた値になる
  targetLatencyMs: number | null;
  // 表示の遅れの上限に収まらず切り下げた分 (ms)
  targetLatencyLimitedMs: number;
  // AudioContext.getOutputTimestamp() を使えず currentTime で代用しているか
  audioClockFallback: boolean;
  // 遅延の内訳。トラックごとの基準の遅れ・jitter buffer の遅延・同期の制御が足した分・
  // 表示の遅れと、2 つのトラックで基準を共有できているか (遅延の解析に使う)
  delays: PlayoutDelayBreakdown;
}

// 受信側メディア統計
export interface MediaReceiverStats {
  audio: AudioReceiverStats | null;
  video: VideoReceiverStats | null;
  // 音声と映像の同期の推定値。片方しか購読していない、またはどちらかが壁時計の
  // TIMESTAMP を使えないときは null
  avSync: AvSyncStats | null;
}

// 音声 Object の送り方 (draft-ietf-moq-transport-22 §11: Data Streams and Datagrams)
//
// - "datagram": Datagram で送る (既定)。再送の有無は下位の transport に依存し、QUIC 上の
//   WebTransport では再送されず (RFC 9221)、経路の欠落がそのまま音の欠落になる。
//   HTTP/2 上の WebTransport (draft-ietf-webtrans-http2) では datagram も再送され、順序も
//   保たれる (§6.2)。サイズが上限を超えた Object は明示なく drop される (§11.2)。
//   WebTransport が datagram を運べないセッション (reliability が "reliable-only") では、
//   指定を黙って戻さず `createMediaPublisher` の start がエラーになる (datagram の意味が
//   transport で変わるため、呼び出し側に明示させる)。送信の完了を待つ戻り値が無いため、
//   送信のキューの計器 (`AudioStats.catchUp.sendQueueMs` / `sendQueueFrames`) は 0 のままになる
// - "subgroup": Subgroup の Data Stream で送る。再送され、欠落しない。reliable-only の
//   transport で datagram を使わない場合などに明示する
export type AudioDelivery = "subgroup" | "datagram";

// オーディオ配信オプション
export interface AudioPublishOptions {
  trackName?: string;
  codec: AudioCodecType;
  bitrate: number;
  // 音声の取り出し経路へ要求するサンプルレート。省略時は 48000。
  // Catalog の samplerate と AudioEncoder の sampleRate には、経路が実際に流す値を使う
  // (マイクの形式はデバイスが決めるため、要求と違う値になることがある)
  sampleRate?: number;
  // 音声の取り出し経路へ要求するチャンネル数。省略時は 2。使い道は sampleRate と同じ
  channels?: number;
  // 音声 Object の送り方 (既定は "datagram")
  delivery?: AudioDelivery;
  // 音声 Object を 1 つにつき何回送るか (1〜3 の整数。既定は 1)。
  //
  // datagram は再送されない (RFC 9221) ため、n 回送ると全ての copy が落ちる確率が損失率の
  // n 乗になる。実測 (実リレー、経路の損失を注入、30〜40 秒) では、鳴った割合は
  //
  // | 損失 | 1 回   | 2 回   | 3 回   |
  // | ---- | ------ | ------ | ------ |
  // | 5 %  | 94.5 % | 99.4 % | -      |
  // | 10 % | 89.3 % | 96.9 % | -      |
  // | 20 % | 77.6 % | 96.3 % | 99.4 % |
  //
  // である。損失の無い経路では品質が変わらない (欠落 0、飛ばし 0)。代わりに音声の帯域と
  // datagram の数が n 倍になる。4 以上は帯域を無駄にするため start() がエラーにする
  //
  // delivery が "subgroup" のときは Data Stream が再送されるため、2 以上を指定できない
  // (冗長化は datagram の送信経路でしか実装しておらず、黙って無視せず start() がエラーにする)
  redundancy?: number;
}

// ビデオ配信オプション
export interface VideoPublishOptions {
  trackName?: string;
  codec: VideoCodecType;
  bitrate: number;
  framerate?: number;
  // キーフレームを送る間隔 (秒)。0 より大きい有限数を指定する。
  // 既定は 2 秒。フレーム数ではなく時間で指定するため、framerate を変えても実際の
  // 間隔は変わらない。0 / 負値 / NaN / ±Infinity は createMediaPublisher() が reject する。
  keyframeInterval?: number;
  width?: number;
  height?: number;
}

// オーディオ購読オプション
// codec を省略した場合は Catalog から自動取得
export interface AudioSubscribeOptions {
  trackName?: string;
  codec?: AudioCodecType;
}

// ビデオ購読オプション
// codec を省略した場合は Catalog から自動取得
export interface VideoSubscribeOptions {
  trackName?: string;
  codec?: VideoCodecType;
}

// MediaPublisher オプション
export interface MediaPublisherOptions {
  namespace: string[];
  audio?: AudioPublishOptions;
  video?: VideoPublishOptions;
  // 音声が live から遅れたときの追いつき方 (src/audioPublishCatchUp.ts)。
  // draft-ietf-moq-loc-04 §4.1: 音声は 1 chunk = 1 Object = 1 Group であり、映像のような
  // 抑制が無いため、符号化が実時間に追いつかなくなるとキューに溜まった分だけ遅れが
  // 固定される。既定の "drop" は、遅れが健全時の値から一定を超えたら読んだフレームを
  // 符号化せずに捨てて live へ追いつく (数フレームの穴は受信側の concealment が埋める)。
  // "keep" は捨てずに順に送る (音楽や効果音のように、間引くと内容が壊れる用途)。
  // 省略した場合は "drop"
  audioCatchUp?: import("../audioPublishCatchUp").AudioPublishCatchUpPolicy;
  // 符号化から表示までの wallclock の差 (ms)
  // draft-ietf-moq-msf-01 §5.2.8 (targetLatency)
  // 指定すると catalog の音声と映像の両方の track に同じ値を載せる。同じ render group と
  // alternate group の track は同一の値でなければならない (§5.2.8 の MUST) ため、値は
  // publisher で 1 つだけ持ち、全 track に同じ値を載せる。
  // 指定しないときは catalog に載せない。宣言が無く isLive が true のときは購読側が
  // 表示の遅れを選んでよい (§5.2.8 の MAY) ため、載せないことが購読側のフォールバックになる。
  // 有限数であることは publisher が検証する。それ以外の範囲は呼び出し側の責任になる。
  // この節番号は draft 由来であり将来の draft 改版で変わる可能性がある。
  targetLatency?: number;
  // 同時レンダリンググループ
  // draft-ietf-moq-msf-01 §5.2.11 (renderGroup)
  // 指定すると catalog の音声と映像の両方の track に同じ値を載せる。同じ group の track は
  // 同時に描画する SHOULD (§5.2.11) を表明する。
  // 有限数であることと整数であることは publisher が検証する。それ以外の範囲は呼び出し側の
  // 責任になる。
  // この節番号は draft 由来であり将来の draft 改版で変わる可能性がある。
  renderGroup?: number;
  useWorker?: boolean;
  serverCertificateHashes?: ArrayBuffer[];
  // SETUP Option (Option Type 0x03) として送出する Authorization Token
  // draft-ietf-moq-transport-22 Section 9.1.4 (AUTHORIZATION TOKEN Setup Option)
  // SETUP では Alias Type DELETE (0x0) / USE_ALIAS (0x2) は仕様上禁止 (Section 9.1.4)
  // draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは PUBLISH へも MUST 付与する。
  // 省略した場合、MOQT URI の msf fragment の c4m を SETUP に載せ、同じトークンを
  // catalog / 音声 / 映像の PUBLISH にも付与する。
  authorizationToken?: import("../message").AuthorizationToken;
  // Pending Subgroup Stream の buffer 設定 (低レベル API の ConnectOptions.pendingSubgroup)
  // draft-ietf-moq-transport-22 §11.3.1
  // 未指定 field は DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS で補完される
  pendingSubgroup?: Partial<import("../pendingSubgroupBuffer").PendingSubgroupBufferOptions>;
}

// MediaPublisher コールバック
export interface MediaPublisherCallbacks {
  onStateChange?: (state: MediaPublisherState) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}

// MediaSubscriber オプション
export interface MediaSubscriberOptions {
  // 購読する Track Namespace のフィールド列。
  // draft-ietf-moq-msf-01 §5.2.2 のとおり、catalog の track が namespace を宣言しない
  // 場合は catalog track の namespace を継承する。catalog の namespace フィールドは
  // 文字列であり、MOQT の Track Namespace のフィールド列との対応は仕様で定まっていない
  // (フィールド列の文字列表現は draft-ietf-moq-transport-22 §8.8 と msf-01 §11.1.2 が
  // "-" 区切りと "." + 16 進で定めるが、catalog の namespace フィールドがこの表現を
  // 使うとは定めていない)。本実装は、このフィールド列を "/" で連結した文字列を
  // catalog track の namespace として扱う (実装固有の規約。namespace が空配列のときは
  // 継承を解決しない)
  namespace: string[];
  audio?: AudioSubscribeOptions;
  video?: VideoSubscribeOptions;
  useWorker?: boolean;
  serverCertificateHashes?: ArrayBuffer[];
  // SETUP Option (Option Type 0x03) として送出する Authorization Token
  // draft-ietf-moq-transport-22 Section 9.1.4 (AUTHORIZATION TOKEN Setup Option)
  // SETUP では Alias Type DELETE (0x0) / USE_ALIAS (0x2) は仕様上禁止 (Section 9.1.4)
  // draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは SUBSCRIBE / FETCH へも
  // MUST 付与する。省略した場合、MOQT URI の msf fragment の c4m を SETUP に載せ、
  // catalog の SUBSCRIBE / FETCH と authInfo を持つ track の SUBSCRIBE にも付与する。
  // getAuthorizationToken を指定した場合はそちらが優先される。
  authorizationToken?: import("../message").AuthorizationToken;
  // draft-ietf-moq-msf-01 §11.4.2: トークン取得は仕様の対象外のためコールバックで注入する。
  // §5.2.42 authInfo を持つ track の subscribe 時に呼ばれ、AUTHORIZATION_TOKEN を返す。
  // authInfo があるのにトークンを返せない（undefined）場合、subscribe はエラーになる（§11.4.4）。
  // 未指定の場合は authorizationToken (SETUP に載せたトークン) を既定のトークンとして使う。
  getAuthorizationToken?: (
    authInfo: import("../msf").AuthInfo,
  ) =>
    | import("../message").AuthorizationToken
    | undefined
    | Promise<import("../message").AuthorizationToken | undefined>;
  // Pending Subgroup Stream の buffer 設定 (低レベル API の ConnectOptions.pendingSubgroup)
  // draft-ietf-moq-transport-22 §11.3.1
  // 未指定 field は DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS で補完される
  pendingSubgroup?: Partial<import("../pendingSubgroupBuffer").PendingSubgroupBufferOptions>;
  // 初期 configure (SUBSCRIBE_OK の Track Property の VIDEO_CONFIG / AUDIO_CONFIG。
  // draft-ietf-moq-loc-04 Table 1) の完了まで保留する Object の上限
  // (件数 / payload と properties の長さの合計)。0 以下で上限なし
  // 未指定 field は DEFAULT_PENDING_OBJECT_QUEUE_OPTIONS で補完される
  // 音声と映像は別々のキューを持ち、上限もキューごとに判定する。上限を超えた Object は
  // 保持せず破棄し、超過は onError でキューごとに購読期間あたり 1 回だけ通知する
  // (音声と映像が同時に溢れれば 1 購読期間に最大 2 回。破棄した Object は受信統計に
  // 数えない)
  pendingObjectQueue?: Partial<import("../createMediaSubscriber").PendingObjectQueueOptions>;
  // 受信した Object を復号へ渡すまでの追加遅延 (ms)。既定 0
  // 2 秒以上の遅延も指定できる。上限は MAX_PRE_DECODE_DELAY_MS
  // 実際の表示遅延は、この値に経路・復号・jitter buffer の遅れが加わる。
  // catalog の targetLatency とは加算される。受信バッファの上限
  // (ConnectOptions.dataStreamMaxBufferBytes) とは無関係であり、その値は変えない
  preDecodeDelayMs?: number;
}

// MediaSubscriber コールバック
export interface MediaSubscriberCallbacks {
  onStateChange?: (state: MediaSubscriberState) => void;
  onCatalog?: (catalog: import("../msf").Catalog) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}

// MediaPublisher インターフェース
export interface MediaPublisher {
  readonly state: MediaPublisherState;
  /**
   * 配信を開始する
   *
   * "created" と "stopped" から呼べる。"stopped" は停止 (`stop()`) で解放した資源を
   * 作り直して再接続する再開であり、"created" と同じく `start()` を受け付ける
   * (状態遷移と停止 / 再開の契約は docs/HIGH_LEVEL_API.md の MediaPublisher を参照)。
   * 失敗した場合は確保済みを解放し、state は変えずに再試行できる。
   * `close()` のあとは終端であり `cannot start in state` で拒否される。
   * 実行中にピア起点の close または利用者の `close()` が重なった場合は "closed" を
   * 優先するため `start()` は失敗する (`onError` と `onClose` が続けて呼ばれ得る)。
   * 解放が先行した場合はそれ以上リソースを作らず、接続で受け取った session も閉じる。
   * 解放 (`close()` とピア起点の close / `stop()` の解放) が進行している間は
   * `cannot start while closing` で拒否する (解放の進行中は一律に開始しない。進行中の
   * 解放が `start()` の完了後に終端へ進むと、開始した資源を解放する経路が残らないため)。
   * 入口の拒否は `onError` を通知しない。
   * 並行呼び出しは未対応であり直列に呼ぶこと。
   */
  start(stream: MediaStream): Promise<void>;
  /**
   * 配信を一時停止する
   *
   * `"publishing"` からのみ呼べる。エンコードを止めるだけでなく、開いている Subgroup
   * ストリームを閉じる (draft-ietf-moq-transport-22 §11.3.2)。止めた時点で「その Subgroup に
   * 続く Object は無い」ため FIN の MUST を満たせる。閉じないと、次の Object を待つ購読側が
   * `DATA_STREAM_TIMEOUT` (0x12) でセッションを閉じうる。詳細は docs/HIGH_LEVEL_API.md を参照。
   */
  pause(): void;
  /**
   * 配信を再開する
   *
   * `"paused"` からのみ呼べる。一度閉じた Group へは送れないため、次に encode する
   * フレームをキーフレームにして新しい Group から送り直す (`startNewGroup()` と同じ効果)。
   * 詳細は docs/HIGH_LEVEL_API.md を参照。
   */
  resume(): void;
  /**
   * 配信を停止する
   *
   * "publishing" と "paused" からのみ呼べる。それ以外 ("stopped" での再 stop を含む) は
   * `cannot stop in state` で throw し、解放もしない。
   * `close()` と同じ解放を行い、state は再 start 可能な "stopped" になる ("stopped" は
   * 終端ではなく、`start()` で再開できる)。session は閉じて再 start 時に再接続する。
   * ピア起点の close と違い `onClose` は通知せず、state が "closed" を経由することもない
   * (解放で閉じる session の close 通知は自己起点であり、世代不一致で捨てる)。
   * ピア起点の close の解放が進行中なら進行中の解放を共有して完了を待ち、解放のあとに
   * "stopped" にする (あとから解放を終えたピア起点の経路は state も `onClose` も動かさない)。
   * 解放が失敗した場合は state を変えず元のエラーを throw する (詳細は `close()` を参照)。
   * `close()` が解放と終端遷移を進めている間は `cannot stop while closing` で拒否する。
   */
  stop(): Promise<void>;
  /**
   * 次の encode するフレームで新しい Group を始める (キーフレームにする)
   *
   * MOQT にはキーフレームの要求というメッセージは無い。NEW_GROUP_REQUEST を受けた
   * publisher が新しい Group を始めるための操作であり、映像では次のフレームが新しい
   * Group の先頭 (キーフレーム) になる (draft-ietf-moq-transport-22 §9.20.19)。
   */
  startNewGroup(): void;
  /**
   * リソースを解放する (終端)
   *
   * `stop()` と同じ解放を行い、以後 start 不可の終端 ("closed") とする。
   * 解放のあとに "closed" にして `onClose` を通知する。"closed" での再 close は早期
   * return するため `onClose` は 1 回だけ通知される。
   * 解放が失敗した場合は state を変えず `onClose` も呼ばず、元のエラーを throw する
   * (破棄の前に参照を切り離しているため、失敗した段階はやり直されず、呼び直しが進める
   * のは失敗した段階より後の解放である)。
   * ピア起点の close の通知も同じく解放してから "closed" と `onClose` を通知する (解放せずに
   * 終端にすると `close()` の早期 return で解放経路が消える)。解放のあとに届く旧 session の
   * close 通知では state も `onClose` も変わらない。
   * 進行中の解放 (`stop()` またはピア起点の close が始めた解放) は共有して完了を待つため、
   * その成否がこの `close()` の結果になる (解放が失敗した場合は state を変えず同じエラーを
   * throw し、呼び直しが残りの解放を進める)。解放を共有する通知が重なっても終端の遷移と
   * `onClose` は 1 回だけであり、同時に呼ばれた `close()` も同じ解放と終端遷移を共有する。
   * `close()` が解放と終端遷移を進めている間は `start()` と `stop()` を
   * `cannot start while closing` / `cannot stop while closing` で拒否する。
   */
  close(): Promise<void>;
  getStats(): MediaStats;
  getCatalog(): import("../msf").Catalog | null;
}

// MediaSubscriber インターフェース
export interface MediaSubscriber {
  readonly state: MediaSubscriberState;
  readonly mediaStream: MediaStream | null;
  readonly catalog: import("../msf").Catalog | null;
  /**
   * 購読を開始する
   *
   * "created" と "stopped" から呼べる。"stopped" からは停止で解放した資源を
   * 作り直して再接続するため、`mediaStream` と `catalog` は再 start 後の新しい値を
   * 読むこと。開始を取り消すには close() を使う (状態遷移と停止 / 再開の契約は
   * docs/HIGH_LEVEL_API.md の MediaSubscriber を参照)。
   * "subscribing" (開始の途中) の stop() は拒否される。解放 (close() とピア起点の close /
   * stop() の解放) が進行している間は cannot start while closing で拒否し、入口の拒否は
   * onError を通知しない (進行中の解放が start の完了後に終端へ進むと、開始した資源を
   * 解放する経路が残らないため)。
   * 失敗した場合は確保済みを解放して遷移前の state に戻るため再試行できる。解放が
   * 先行した場合はそれ以上購読も通知もリソース作成も行わず、接続で受け取った session も
   * 閉じる。ピア起点の close または利用者の close() が実行中に重なった場合は "closed" を
   * 優先するため start は失敗し、onError と onClose が続けて呼ばれ得る。巻き戻しの
   * onStateChange が throw しても onError の通知と元のエラーは失われない。
   * 並行呼び出しは未対応であり直列に呼ぶこと。
   */
  start(): Promise<void>;
  /**
   * 購読を停止する
   *
   * "active" からのみ呼べる。それ以外 ("stopped" での再 stop を含む) は
   * cannot stop in state で throw し、解放もしない。"subscribing" (開始の途中) も
   * 拒否される (開始を取り消すには close() を使う)。
   * close と同じ解放を行い、state は再 start 可能な "stopped" になる。
   * `mediaStream` と `catalog` は解放で無効になる。解放が失敗した場合は
   * state を変えず onClose も呼ばず、元のエラーを throw する (失敗した段階は
   * やり直されず、呼び直しが進めるのは残りの段階と終端遷移である)。ピア起点の
   * close と違い onClose は通知しない。ピア起点の close の解放中に呼ばれた場合は
   * 進行中の解放を共有して完了を待ち、この stop が state を "stopped" にする
   * (あとから解放を終えたピア起点の経路は state も onClose も動かさない)。
   * close() が解放と終端遷移を進めている間は cannot stop while closing で拒否する。
   * 停止の要求後は新しい音声 Object を受け付けず、復号前の遅延の段に保持していた音声は
   * flush して復号へ流す。予約済みの音が鳴り終わるまで待ってから `AudioContext` を
   * 閉じる (最大 300 ms。`MediaPlayoutDrainOptions.maxWaitMs` の既定)。
   * 待って鳴らせた量と切った量は
   * `getStats().audio.playoutTiming.lastDrain` で読める。
   */
  stop(): Promise<void>;
  /**
   * REQUEST_UPDATE で NEW_GROUP_REQUEST を送り、新しい Group の開始を要求する
   *
   * MOQT にはキーフレームの要求というメッセージは無い (draft-ietf-moq-transport-22
   * §9.20.19)。映像では新しい Group の先頭がキーフレームになる。
   */
  requestNewGroup(): Promise<void>;
  /**
   * リソースを解放する (終端)
   *
   * stop と同じ解放を行い、解放に成功した場合は以後 start 不可の終端 ("closed") とする。
   * 呼ぶと解放の完了を待たずに閉じたものとして扱い、解放の await 中に届いた Object は
   * 統計に数えず復号にも渡さない。解放が失敗した場合は "active" なら stop() を経由して
   * start() で作り直す (詳細は docs/HIGH_LEVEL_API.md の MediaSubscriber を参照)。
   * "closed" での再 close は何もしない。解放が失敗した場合は state を変えず
   * onClose も呼ばず、元のエラーを throw する (失敗した段階はやり直されず、
   * 呼び直しが進めるのは残りの段階と終端遷移である)。解放のあとに届いた session の
   * close 通知では state も onClose も変わらない。進行中の解放 (stop() または
   * ピア起点の close が始めた解放) があればそれを共有して完了を待つため、その成否が
   * この close() にも伝わる (解放が失敗すれば終端へ進まず同じエラーを throw する)。
   * ピア起点の close の解放中に呼ばれた場合も onClose は 1 回だけ通知される。
   * await せずに close を重ねて呼んだ場合も解放は 1 回で、onStateChange の "closed" と
   * onClose は 1 回だけ通知される (終端の遷移は冪等)。close() が解放と終端遷移を
   * 進めている間は start() と stop() を cannot start while closing /
   * cannot stop while closing で拒否する。
   */
  close(): Promise<void>;
  getStats(): MediaReceiverStats;
}

// エンコード済みチャンクデータ
export interface EncodedChunkData {
  data: Uint8Array;
  type: "key" | "delta";
  timestamp: number;
  duration: number | null;
  description?: Uint8Array;
}

// エンコーダーコールバック
export interface VideoEncoderWrapperCallbacks {
  output: (chunk: EncodedChunkData) => void;
  error: (error: Error) => void;
}

// デコード済みフレームデータ
export interface DecodedFrameData {
  frame: VideoFrame;
}

// デコーダーコールバック
export interface VideoDecoderWrapperCallbacks {
  output: (data: DecodedFrameData) => void;
  error: (error: Error) => void;
}

// オーディオエンコード済みチャンクデータ
export interface AudioEncodedChunkData {
  data: Uint8Array;
  type: "key" | "delta";
  timestamp: number;
  duration: number | null;
  // AAC の AudioSpecificConfig など、デコーダーへ渡す設定 (opus では未設定)
  description?: Uint8Array;
}

// オーディオエンコーダーコールバック
export interface AudioEncoderWrapperCallbacks {
  output: (chunk: AudioEncodedChunkData) => void;
  error: (error: Error) => void;
}

// オーディオデコード済みデータ
export interface AudioDecodedData {
  data: AudioData;
}

// オーディオデコーダーコールバック
export interface AudioDecoderWrapperCallbacks {
  output: (data: AudioDecodedData) => void;
  error: (error: Error) => void;
}
