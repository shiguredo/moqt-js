/**
 * コーデック関連の型定義
 */

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
}

// 受信側オーディオ統計
export interface AudioReceiverStats {
  framesReceived: number;
  bytesReceived: number;
}

// ビデオ統計
export interface VideoStats {
  framesSent: number;
  // エンコードが追いつかないため待たずに破棄したフレーム数 (閾値は createMediaPublisher の判定)
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
  // どちらかの実績が 1 秒より古いときは null
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
}

// 受信側メディア統計
export interface MediaReceiverStats {
  audio: AudioReceiverStats | null;
  video: VideoReceiverStats | null;
  // 音声と映像の同期の推定値。片方しか購読していない、またはどちらかが壁時計の
  // TIMESTAMP を使えないときは null
  avSync: AvSyncStats | null;
}

// オーディオ配信オプション
export interface AudioPublishOptions {
  trackName?: string;
  codec: AudioCodecType;
  bitrate: number;
  sampleRate?: number;
  channels?: number;
}

// ビデオ配信オプション
export interface VideoPublishOptions {
  trackName?: string;
  codec: VideoCodecType;
  bitrate: number;
  framerate?: number;
  // キーフレームを送るフレーム間隔 (1 以上の整数)。
  // 既定は Math.round(framerate * 2) で、framerate の既定 30 なら 60。
  // 0 / 負値 / 非整数 / NaN / ±Infinity は createMediaPublisher() が reject する。
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
  // draft-ietf-moq-transport-21 Section 9.1.4 (AUTHORIZATION TOKEN Setup Option)
  // SETUP では Alias Type DELETE (0x0) / USE_ALIAS (0x2) は仕様上禁止 (Section 9.1.4)
  // draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは PUBLISH へも MUST 付与する。
  // 省略した場合、MOQT URI の msf fragment の c4m を SETUP に載せ、同じトークンを
  // catalog / 音声 / 映像の PUBLISH にも付与する。
  authorizationToken?: import("../message").AuthorizationToken;
  // Pending Subgroup Stream の buffer 設定 (低レベル API の ConnectOptions.pendingSubgroup)
  // draft-ietf-moq-transport-21 §11.3.1
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
  namespace: string[];
  audio?: AudioSubscribeOptions;
  video?: VideoSubscribeOptions;
  useWorker?: boolean;
  serverCertificateHashes?: ArrayBuffer[];
  // SETUP Option (Option Type 0x03) として送出する Authorization Token
  // draft-ietf-moq-transport-21 Section 9.1.4 (AUTHORIZATION TOKEN Setup Option)
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
  // draft-ietf-moq-transport-21 §11.3.1
  // 未指定 field は DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS で補完される
  pendingSubgroup?: Partial<import("../pendingSubgroupBuffer").PendingSubgroupBufferOptions>;
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
  pause(): void;
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
  requestKeyframe(): void;
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
   */
  stop(): Promise<void>;
  requestKeyframe(): Promise<void>;
  /**
   * リソースを解放する (終端)
   *
   * stop と同じ解放を行い、以後 start 不可の終端 ("closed") とする。
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
