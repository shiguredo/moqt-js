/**
 * moqt-js の公開型定義
 *
 * session.ts から公開 API の型 (ConnectOptions / SessionStatistics 以外の
 * コールバックとオプション、および購読 / 配信オブジェクトのインターフェース) を
 * まとめる。Session インターフェースと SessionImpl は session.ts に残し、
 * ここでは型のみを定義して session.ts から再エクスポートする。
 */

import type { DataStreamErrorCode } from "../error";
import type {
  AuthorizationToken,
  LocationFilter,
  Parameter,
  PublishDoneStatusCode,
  RangeFilterSpec,
} from "../message";
import type { MoqtObject } from "../dataStream";
import type { PendingSubgroupBufferOptions } from "../pendingSubgroupBuffer";
import type { Property } from "../properties";

/**
 * fill fetch の要求内容
 * draft-ietf-moq-transport-23 Section 3.4 (Fill Semantics) /
 * Section 9.19.15 (FILL PARAMETERS Parameter)
 *
 * SUBSCRIBE / subscription の REQUEST_UPDATE に FILL_PARAMETERS (0x23) として
 * 載せ、live 手前の範囲を fill fetch ストリームで取得する。内側に載せられる
 * のは FILL_TIMEOUT / SUBSCRIBER_PRIORITY / LOCATION_FILTER / GROUP_ORDER /
 * Range Filters (0x25-0x28) のみ (§9.19.15 Table 7)。
 */
export interface FillRequestOptions {
  /**
   * fill 範囲の Location Filter
   *
   * 省略時は subscription の Location Filter を使う。Location Filter Type 0x00
   * (None) を指定するとトラック全体 (Largest Object まで) が fill 範囲になる
   * (§3.4 は Length を持たない 0x00 を "zero-length" と表現している)。
   * Next Object (0x05) は Next Object として解決されるため、トラック全体には
   * ならない。
   */
  filter?: LocationFilter;
  /**
   * Fill Timeout（ミリ秒）
   * draft-ietf-moq-transport-23 Section 9.19.5 (FILL TIMEOUT Parameter)
   */
  fillTimeout?: bigint;
  /**
   * Subscriber Priority（0-255）
   * draft-ietf-moq-transport-23 Section 9.19.7 (SUBSCRIBER PRIORITY Parameter)
   */
  subscriberPriority?: number;
  /**
   * Group Order
   * draft-ietf-moq-transport-23 Section 9.19.8 (GROUP ORDER Parameter)
   */
  groupOrder?: "Ascending" | "Descending";
  /**
   * Range Filters
   * draft-ietf-moq-transport-23 Section 3.3.2 (Range Filters)
   *
   * ピアの MAX_FILTER_RANGES が 0（未広告含む）の場合、および購読単位の Ranges
   * 合計が上限を超える場合に指定すると throw する。合計にはこの fill 内側の
   * Range Filter も含まれる（SUBSCRIBE / SUBSCRIBE_TRACKS の初回送信では外側の
   * rangeFilters との合計、REQUEST_UPDATE ではマージ後の購読フィルタ・in-flight の
   * 更新・in-flight の fill との合計）。
   */
  rangeFilters?: RangeFilterSpec[];
}

/**
 * セッション状態
 */
export type SessionState = "connected" | "closed";

/**
 * MOQT プロトコルメッセージをログ出力するためのデバッグメッセージ
 */
export interface DebugMessage {
  /** メッセージの方向 */
  direction: "send" | "recv";
  /** メッセージタイプ番号 */
  type: number;
  /** メッセージタイプ名 (例: "SETUP", "SUBSCRIBE") */
  typeName: string;
  /**
   * 生のペイロードバイト列。
   *
   * Uint8Array は moqt-js 内部のバッファとは独立しており、受信側は
   * コールバックを超えて保持してよい。ただし受信側はこれを変更してはならない。
   * コールバックの返却後も同一インスタンスが moqt-js 内部から参照される
   * 可能性があるためである (例: 再送やさらなるエンコードのため)。
   */
  payload: Uint8Array;
  /** デコードされたメッセージ内容 (利用可能な場合) */
  decoded?: Record<string, unknown>;
  /** ミリ秒単位のタイムスタンプ */
  timestamp: number;
}

/**
 * 接続コールバック
 */
export interface ConnectCallbacks {
  close?: (closeInfo: WebTransportCloseInfo) => void;
  error?: (error: Error) => void;
  /** MOQT プロトコルメッセージをログ出力するためのデバッグコールバック */
  debug?: (message: DebugMessage) => void;
  /**
   * GOAWAY 受信時のコールバック
   * draft-ietf-moq-transport-23 Section 9.2 (GOAWAY)
   * @param newSessionUri - 新しいセッション URI（セッションマイグレーション用）
   */
  goaway?: (newSessionUri: string) => void;
}

/**
 * 自己署名証明書用の証明書ハッシュ
 * WebTransport の serverCertificateHashes オプションと共に使用する
 * 注意: 証明書の有効期間は 14 日以下でなければならない
 */
export interface CertificateHash {
  algorithm: "sha-256";
  value: ArrayBuffer;
}

/**
 * 接続オプション
 */
export interface ConnectOptions {
  /**
   * 自己署名証明書用の証明書ハッシュ
   * 自己署名証明書を使ったローカル開発で使用する
   * 注意: 証明書の有効期間は 14 日以下でなければならない
   */
  serverCertificateHashes?: CertificateHash[];

  /**
   * SETUP Option (Option Type 0x03) として送信する Authorization Token
   * draft-ietf-moq-transport-23 §9.1.4 (AUTHORIZATION TOKEN)
   *
   * SETUP では Alias Type DELETE (0x0) / USE_ALIAS (0x2) は仕様上禁止 (§9.1.4)。
   * REGISTER (0x1) または USE_VALUE (0x3) のみ指定できる。
   *
   * REGISTER を指定した場合、ピアの SETUP を受信して MAX_AUTH_TOKEN_CACHE_SIZE
   * (§9.1.3: 1 件 16 バイト + Token Value 長) が判明した時点で登録成否を確定し、
   * 後続メッセージへ同じトークンを付与するときは自動で正規化する (§8.9 / §9.1.4)。
   * - 登録に成功した Alias → USE_ALIAS (同じ Alias の再 REGISTER は
   *   DUPLICATE_AUTH_TOKEN_ALIAS になるため)
   * - 登録に失敗した Alias → USE_VALUE (値を持たないため §9.1.4 の purge MUST)
   *
   * 省略した場合、MOQT URI の msf fragment に c4m があれば、その値を復号した
   * C4M のトークンを Token Type 0x01 (CAT) / USE_VALUE として送る
   * (draft-ietf-moq-msf-01 §11.1.1 / §11.4.3, draft-ietf-moq-c4m-01 §7.1 Table 4)。
   * 指定した場合は URI の c4m より優先する。
   */
  authorizationToken?: AuthorizationToken;

  /**
   * SETUP Option (Option Type 0x04) として広告する MAX_AUTH_TOKEN_CACHE_SIZE
   * draft-ietf-moq-transport-23 §9.1.3 (MAX_AUTH_TOKEN_CACHE_SIZE)
   *
   * ピアが保持してよい Authorization Token Alias の最大バイト数。
   * 省略時は SETUP Option を送信せず、既定値 0（Alias 使用禁止）となる。
   */
  maxAuthTokenCacheSize?: number;

  /**
   * SETUP Option (Option Type 0x08) として広告する MAX_REQUEST_UPDATES
   * draft-ietf-moq-transport-23 §9.1.7 (MAX_REQUEST_UPDATES)
   *
   * リクエストストリームごとに未応答で許可する REQUEST_UPDATE の最大数。
   * 0 は無制限。省略時は SETUP Option を送信せず、既定値 0（無制限）となる。
   */
  maxRequestUpdates?: number;

  /**
   * SETUP Option (Option Type 0x06) として広告する MAX_FILTER_RANGES
   * draft-ietf-moq-transport-23 §9.1.6 (MAX FILTER RANGES)
   *
   * ピアが購読・FETCH ごとに送信できる Range Filter の合計 Ranges 数。
   * 省略時は SETUP Option を送信せず、既定値 0（Range Filter 受信拒否）となり、
   * ピアから REQUEST_UPDATE 等で Range Filter を受信した場合は
   * REQUEST_ERROR (INVALID_FILTER) で拒否する。
   */
  maxFilterRanges?: number;

  /**
   * SETUP Option (Option Type 0x09) として広告する MAX_CONTROL_MESSAGE_SIZE
   * draft-ietf-moq-transport-23 §9.1.8 (MAX_CONTROL_MESSAGE_SIZE)
   *
   * 自 endpoint が受信を許す制御メッセージの Message Length (本文長) の上限 (バイト)。
   * 制御ストリームとすべてのリクエストストリームに適用する。
   * 65535 以上を指定する。省略時は SETUP Option を送信せず、既定値 65535 を使う。
   *
   * draft-ietf-moq-transport-23 §15.5 (Resource Exhaustion):
   * 完成した制御メッセージをバッファする実装は、その上限ぶんのメモリを
   * ストリームごとに確保する。また、メッセージ全体を受け取れるだけの
   * フロー制御を確保できない場合はデッドロックし得るため、大きくしすぎないこと。
   * この上限は Message Parameter 個々の値の上限ではなく、大きな
   * Authorization Token などもメッセージ全体に収まれば受け取れる。
   *
   * 65535 未満の値、Number.MAX_SAFE_INTEGER を超える値、整数でない値を指定すると、
   * connect() では接続を確立する前に、initialize() を直接呼ぶ場合は制御ストリームを
   * 開く前にエラーになる。
   */
  maxControlMessageSize?: number;

  /**
   * Pending Subgroup Stream の buffer 設定
   * draft-ietf-moq-transport-23 §3.1.3.1 (Unknown Track Alias) の "MAY drop the data
   * or buffer it briefly to handle reordering with the control message that
   * establishes the Track Alias" を実現する buffer の上限を制御する。
   *
   * 指定しなかった field は `DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS` の値が使われる。
   */
  pendingSubgroup?: Partial<PendingSubgroupBufferOptions>;

  /**
   * 制御メッセージの受信タイムアウト (ミリ秒)
   *
   * draft-ietf-moq-transport-23 §12.2 の CONTROL_MESSAGE_TIMEOUT (0x11) に対応する。
   * 制御ストリームで半端なメッセージを保持したままこの時間が経過したら、
   * CONTROL_MESSAGE_TIMEOUT でセッションを閉じ、ストリームを打ち切る。
   * 0 以下を指定するとタイムアウトしない (既定は 10,000)。
   */
  controlMessageTimeoutMs?: number;

  /**
   * データストリームの受信タイムアウト (ミリ秒)
   *
   * draft-ietf-moq-transport-23 §12.2 の DATA_STREAM_TIMEOUT (0x12) に対応する。
   * Subgroup / Fetch のヘッダーまたは Object の途中バイトを保持したままこの
   * 時間が経過したら、DATA_STREAM_TIMEOUT でセッションを閉じ、当該ストリームを
   * 打ち切る。0 以下を指定するとタイムアウトしない (既定は 30,000)。
   */
  dataStreamTimeoutMs?: number;

  /**
   * 確立後の受信データストリームが保持してよいバッファの上限 (バイト)
   *
   * draft-ietf-moq-transport-23 §12.5 (EXCESSIVE_LOAD 0x9):
   * 完成前の Object の payload 全長を受けられる値を指定する。上限を超えた
   * データストリームは EXCESSIVE_LOAD として打ち切り、セッションは閉じない
   * (アプリへは失敗として通知する)。0 以下を指定すると上限を設けない
   * (既定は 33,554,432 バイト = 32 MiB)。
   */
  dataStreamMaxBufferBytes?: number;

  /**
   * 確立後の受信データストリームがセッション全体で保持してよいバッファの合計上限 (バイト)
   *
   * draft-ietf-moq-transport-23 §12.5 (EXCESSIVE_LOAD 0x9):
   * ストリーム単位の `dataStreamMaxBufferBytes` だけでは、上限近くまで溜めた
   * ストリームを同時に何本も開かれると合計が上限 × 本数まで増える。ストリームの
   * 本数はピアが決められるため、すべての受信データストリームが保持するバイト数の
   * 合計にも上限を設ける。合計がこの値を超えたら、超過の原因になったストリームを
   * EXCESSIVE_LOAD として打ち切り、他のストリームとセッションは継続する
   * (アプリへは失敗として通知する)。0 以下を指定すると上限を設けない
   * (既定は 67,108,864 バイト = 64 MiB)。
   */
  dataStreamMaxTotalBufferBytes?: number;

  /**
   * MOQT_IMPLEMENTATION Setup Option (Option Type 0x07) の送信制御
   * draft-ietf-moq-transport-23 §9.1.5 (MOQT IMPLEMENTATION) /
   * §15.8 (Implementation Identification Fingerprinting)
   *
   * - 未指定（既定）: `moqt-js/${version}` を送信する。
   * - false: MOQT_IMPLEMENTATION Option を送信しない（opt-out）。
   * - 文字列: その値をそのまま送信する（override）。値の妥当性検証は行わないため、
   *   内容は呼び出し側の責任（§9.1.5 は実装名とバージョンに限定する SHOULD を定める）。
   */
  moqtImplementation?: string | false;

  /**
   * GREASE Setup Option の送信（opt-in）
   * draft-ietf-moq-transport-23 §13 (Grease)
   *
   * true のとき、SETUP に GREASE Setup Option（0x7f * N + 0x9D パターンの予約値）を
   * 1 つ追加する。対向が未知の Option を gracefully に扱えることを保証する。
   * 既定（未指定 / false）では送信しない。
   */
  grease?: boolean;
}

/**
 * SessionImpl のコンストラクタが受け取るオプション
 * `connect()` から `ConnectOptions` の該当フィールドが渡される
 */
/**
 * パブリッシュコールバック
 */
export interface PublishCallbacks {
  error?: (error: Error) => void;
  /**
   * paused 状態が変更された時のコールバック
   * draft-ietf-moq-transport-23 Section 9.19.18 (PAUSED Parameter)
   *
   * REQUEST_UPDATE で paused 状態が変更された時に呼ばれる。
   * PUBLISH 送信時の options.paused による初期設定で変化した場合も呼ばれる。
   * - true (1): paused（オブジェクトを送らない）
   * - false (0): paused でない（オブジェクトを送る）
   */
  onPausedChange?: (paused: boolean) => void;
  /**
   * リクエストストリーム上で GOAWAY を受信した時のコールバック
   * draft-ietf-moq-transport-23 Section 9.2 (GOAWAY):
   * 当該リクエストのマイグレーション先 URI を通知する。
   */
  goaway?: (newSessionUri: string) => void;
  /**
   * 新しい Group の要求 (NEW_GROUP_REQUEST) を受けた時のコールバック
   * draft-ietf-moq-transport-23 Section 9.19.19 (NEW GROUP REQUEST Parameter)
   *
   * 購読者が SUBSCRIBE / REQUEST_UPDATE に載せた NEW_GROUP_REQUEST を、relay は
   * REQUEST_UPDATE で publisher へ伝える。`PublishOptions.dynamicGroups` を true にした
   * PUBLISH で、値が 0 か現在の Group (送った最大の Group) より大きいときに呼ばれる。
   * dynamic Groups に対応する publisher は、現在の Group を終えて新しい Group を
   * できるだけ早く始める SHOULD (映像なら次のフレームをキーフレームにする)。
   * 次の Group ID は publisher が決める (要求の値と一致させる必要は無い)。
   *
   * @param newGroupRequest - 要求の値 (購読者が知る最大の Group ID + 1、知らなければ 0)
   */
  onNewGroupRequest?: (newGroupRequest: bigint) => void;
}

/**
 * パブリッシュオプション
 *
 * draft-ietf-moq-transport-23 §3.4 / §3.4.1 (Fill Semantics):
 * PUBLISH の FILL_PARAMETERS による初期 fill は、購読側 (本ライブラリの
 * 受信経路) が受理して購読へ関連付ける。moqt-js の publisher は履歴 Object を
 * 保持せず、送信側として fill fetch を提供する機能を持たないため、この
 * インターフェースに fill 指定は無い (受信対応のみ)。
 */
export interface PublishOptions {
  /**
   * キャッシュの最大保持時間（ミリ秒）
   * draft-ietf-moq-transport-23 Section 10.3 (MAX CACHE DURATION)
   *
   * Relay がオブジェクトをキャッシュして良い最大時間を指定する。
   * 0 を指定するとキャッシュを無効にする。
   */
  maxCacheDuration?: bigint;

  /**
   * Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-23 Section 10.2 (OBJECT_DELIVERY_TIMEOUT)
   *
   * PUBLISH の Track Properties として送信される OBJECT_DELIVERY_TIMEOUT（Message Parameter の定義は Section 9.19.4）。
   *
   * オブジェクトを受信してから配信を試みる最大時間。
   * moqt-js はこの値の強制は行わない。比較と強制は Publisher 値と Subscriber 値の両方を持つ
   * エンドポイント（典型的にはリレー）の責務であり、詳細は Section 5.2
   * (Delivery Timeouts and Data Reliability) を参照。
   */
  deliveryTimeout?: bigint;

  /**
   * Subgroup Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-23 Section 10.1 (SUBGROUP_DELIVERY_TIMEOUT)
   *
   * PUBLISH の Track Properties として送信される SUBGROUP_DELIVERY_TIMEOUT（Message Parameter の定義は Section 9.19.3）。
   *
   * Subgroup 内のオブジェクトを配信する最大時間。0 はタイムアウトなしを意味する。
   * moqt-js はこの値の強制は行わない。比較と強制は Publisher 値と Subscriber 値の両方を持つ
   * エンドポイント（典型的にはリレー）の責務であり、詳細は Section 5.2
   * (Delivery Timeouts and Data Reliability) を参照。
   */
  subgroupDeliveryTimeout?: bigint;

  /**
   * Publisher Priority（0-255）
   * draft-ietf-moq-transport-23 Section 10.4 (DEFAULT PUBLISHER PRIORITY)
   *
   * パブリッシュの優先度。小さい値ほど高優先度。
   * 指定しない場合は 128（デフォルト）
   */
  publisherPriority?: number;

  /**
   * Group Order
   * draft-ietf-moq-transport-23 Section 10.5 (DEFAULT PUBLISHER GROUP ORDER)
   *
   * グループの配信順序。
   * - "Ascending": 古いグループから順に配信
   * - "Descending": 新しいグループから順に配信
   */
  groupOrder?: "Ascending" | "Descending";

  /**
   * Dynamic Groups サポートの通知
   * draft-ietf-moq-transport-23 Section 10.6 (DYNAMIC GROUPS)
   *
   * true を設定すると、Subscriber が NEW_GROUP_REQUEST パラメータで
   * 新しいグループの生成を要求できることを通知する。
   */
  dynamicGroups?: boolean;

  /**
   * Expires（ミリ秒）
   * draft-ietf-moq-transport-23 Section 9.19.16 (EXPIRES Parameter)
   *
   * パブリッシュが自動終了するまでの時間（ミリ秒）。
   * 0 または未指定の場合は期限なし。
   */
  expires?: bigint;

  /**
   * subscription が paused かどうか (PAUSED パラメータ)
   * draft-ietf-moq-transport-23 §9.19.18 (PAUSED Parameter) / §3.1.1 (Pausing Subscriptions)
   *
   * - true (1): paused。オブジェクトを送らず、PUBLISH_DONE などの制御メッセージは送る
   * - false (0): paused でない。オブジェクトを送る
   *
   * 省略した場合は 0（paused でない）がデフォルト。subscription の初期状態は
   * initiator が PUBLISH で設定し、以後は REQUEST_UPDATE の PAUSED で更新する。
   * draft-22 の FORWARD は 1 = 転送するだったため、値の意味が反転している。
   */
  paused?: boolean;

  /**
   * LOC Timescale（Track Property として送信）
   * draft-ietf-moq-loc-05 Table 1 (TIMESCALE, Scope: Track, Object)
   *
   * 1 秒あたりの Timestamp 単位数。Track 初期化時に Track Property として広告し、
   * Object 単位の冗長送信を削減する。送らない場合は既存どおり Object Properties のみ。
   */
  locTimescale?: bigint;

  /**
   * LOC Video Config（Track Property として送信）
   * draft-ietf-moq-loc-05 Table 1 (VIDEO_CONFIG, Scope: Track, Object)
   *
   * VideoDecoderConfig の description。Track 初期化時に Track Property として広告する。
   */
  locVideoConfig?: Uint8Array;

  /**
   * LOC Audio Config（Track Property として送信）
   * draft-ietf-moq-loc-05 Table 1 (AUDIO_CONFIG, Scope: Track, Object)
   *
   * AudioDecoderConfig の description。Track 初期化時に Track Property として広告する。
   */
  locAudioConfig?: Uint8Array;

  /**
   * LOC Codec String（Track Property として送信）
   * draft-ietf-moq-loc-05 Section 2.3.1.3 (CODEC_STRING, Scope: Track, Object)
   *
   * WebCodecs の codec に対応する UTF-8 文字列。Track 初期化時に Track Property として
   * 広告し、Object 単位の冗長送信を削減する。送らない場合は Object Properties のみ。
   */
  locCodecString?: string;

  /**
   * PUBLISH に付与する認可トークン
   * draft-ietf-moq-transport-23 Section 9.19.2 (AUTHORIZATION TOKEN Parameter)
   *
   * "It MAY appear in a PUBLISH, SUBSCRIBE, REQUEST_UPDATE, SUBSCRIBE_NAMESPACE,
   *  SUBSCRIBE_TRACKS, PUBLISH_NAMESPACE, TRACK_STATUS or FETCH message."
   * 省略時は送らない。
   *
   * draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは、そのトラックに関係する
   * AUTHORIZATION TOKEN パラメータを受け付けるすべての制御メッセージへ MUST 付与する
   * (publisher は PUBLISH と PUBLISH_NAMESPACE)。高レベル API は SETUP に載せた
   * トークンを既定で付与する (`Session.setupAuthorizationToken`)。
   */
  authorizationToken?: AuthorizationToken;
}

/**
 * サブスクライブコールバック
 */
/**
 * Subgroup の stream の終わり
 *
 * draft-ietf-moq-transport-23 Section 2.1 ("Objects can be delivered out of order"):
 * Group ごとに別の stream で届くため、前の Group の Object が次の Group の Object より後に
 * 届くことがある。stream が終わったことを知れば、アプリはそれ以上その Subgroup の Object が
 * 届かないと判断できる。
 */
export interface SubgroupStreamEnd {
  /** stream の Group ID */
  groupId: bigint;
  /**
   * stream で確定した Subgroup ID。Subgroup ID を最初の Object から決める Subgroup Header の
   * stream で、Object を 1 つも受け取らずに終わった場合は未設定
   */
  subgroupId?: bigint;
  /** FIN で終わったら `"fin"`、ピアの RESET_STREAM で終わったら `"reset"` */
  reason: "fin" | "reset";
  /**
   * RESET_STREAM の error code (draft-ietf-moq-transport-23 Section 12.5)。reset の理由を
   * 表す (期限切れは DELIVERY_TIMEOUT、停滞の打ち切りは TOO_FAR_BEHIND など)。未知の code は
   * INTERNAL_ERROR として扱う (Section 13)。FIN で終わったときと、WebTransport が code を
   * 渡さなかったときは未設定
   */
  errorCode?: DataStreamErrorCode;
}

/**
 * PUBLISH_DONE による購読の終了
 *
 * draft-ietf-moq-transport-23 §9.9 (PUBLISH_DONE): publisher は購読の最後のメッセージとして
 * PUBLISH_DONE を送って購読を終える。終了の理由は §12.4 (Publish Done Codes) の Status Code が
 * 表し、TRACK_ENDED / GOING_AWAY / EXPIRED / TOO_FAR_BEHIND / INTERNAL_ERROR などを区別できる。
 * §13 (Grease) により、未知の Status Code は INTERNAL_ERROR に正規化した値を渡す。
 *
 * `src/message/publish.ts` の `PublishDone` は PUBLISH_DONE のワイヤ表現 (`statusCode` は
 * `bigint`、`streamCount` を持つ) であり、本型とは別である。本型の `statusCode` は正規化済みの
 * 列挙値である。
 */
export interface PublishDoneInfo {
  /**
   * draft-ietf-moq-transport-23 §12.4 の Status Code
   *
   * エラーを示すかどうかは `isPublishDoneErrorStatus` で判定できる。
   */
  statusCode: PublishDoneStatusCode;
  /**
   * publisher がこの購読のために開いたデータストリーム数
   *
   * draft-ietf-moq-transport-23 §9.9 (PUBLISH_DONE): Stream Count は空の Subgroup を
   * 含むデータストリームと fill fetch ストリームを数える。購読者は受信済みの
   * ストリーム数と比較することで、この購読で配信されたデータをすべて受け取ったかを
   * 判断でき、同じ数まで処理した時点で購読状態を破棄できる。
   *
   * 2^64-1 は publisher が正確な値を設定できなかったことを表す。この場合、受信済み
   * ストリーム数との比較には使えないため、購読者はタイムアウトなどの別の手段で
   * 購読状態を破棄する。
   */
  streamCount: bigint;
  /**
   * PUBLISH_DONE の Reason Phrase
   *
   * draft-ietf-moq-transport-23 §8.5 (Reason Phrase Structure) は Reason Phrase Length を
   * vi64 と定めるため、長さ 0 の Reason Phrase を受信しうる (空文字列がありうる)。
   */
  reasonPhrase: string;
}

export interface SubscribeCallbacks {
  object: (object: MoqtObject) => void;
  /**
   * Datagram で受信したオブジェクトのコールバック
   * draft-ietf-moq-transport-23 Section 11.2 (Datagrams)
   *
   * 注意: Datagram は信頼性がなく、順序も保証されない
   */
  datagram?: (object: MoqtObject) => void;
  /**
   * 購読が PUBLISH_DONE で終わったときのコールバック
   *
   * draft-ietf-moq-transport-23 §9.9 (PUBLISH_DONE): publisher は購読の最後のメッセージとして
   * PUBLISH_DONE を送って購読を終える。終了の理由を `PublishDoneInfo` で渡す。
   *
   * エラーを示す Status Code の PUBLISH_DONE でもこのコールバックだけを呼び、`error` は
   * 呼ばない。`error` が呼ばれる場合は `error` の説明を参照。
   */
  end?: (publishDone: PublishDoneInfo) => void;
  /**
   * 購読の受信でエラーが起きたときのコールバック
   *
   * 次の 2 つの場合に呼ぶ。
   *
   * - 購読が PUBLISH_DONE を伴わない失敗で終わった場合 (PUBLISH_DONE の前の FIN §6.4.2.2、
   *   RESET_STREAM、Malformed Track §12.1)
   * - アプリのコールバック (`object` / `datagram` / `subgroupEnd`) が throw した場合。
   *   このとき購読は終わらない (state は `"active"` のまま) ため、受信を続けるアプリは状態を
   *   破棄しないこと
   *
   * セッション終了 (draft-ietf-moq-transport-23 §6.6 Termination) では呼ばない。セッションの
   * 終了は ConnectCallbacks.close が通知する。
   */
  error?: (error: Error) => void;
  /**
   * fill fetch ストリームが失敗した時のコールバック
   *
   * draft-ietf-moq-transport-23 §3.4.1 (Opening and Closing Fill Fetch Streams):
   * "Because there is no REQUEST_ERROR associated with a fill fetch stream, the
   *  publisher signals a fill failure by resetting the stream" および
   * "Resetting or cancelling a fill fetch stream, by either endpoint, does not
   *  affect the subscription, which continues to deliver objects using
   *  subscribe subgroups and datagrams."
   * fill の失敗は購読の継続を妨げないため、購読の終了を意味する error とは
   * 別のコールバックで通知する。アプリは fill が欠けたことを検知して
   * 再取得を判断できる。FIN による正常完了では呼ばない。
   */
  fillError?: (error: Error) => void;
  /**
   * リクエストストリーム上で GOAWAY を受信した時のコールバック
   * draft-ietf-moq-transport-23 Section 9.2 (GOAWAY):
   * 当該リクエストのマイグレーション先 URI を通知する。
   */
  goaway?: (newSessionUri: string) => void;
  /**
   * 購読の Subgroup の stream が終わった時のコールバック
   *
   * その stream で届いた最後の Object を object コールバックへ渡した後に呼ぶ。
   * FIN (§11.3.2) とピアの RESET_STREAM で呼び、購読の終了や打ち切り (Malformed Track、
   * バッファ上限) では呼ばない。draft-ietf-moq-transport-23 Section 2.1 のとおり Object は
   * 順不同で届きうるため、前の Group の stream が終わるまで次の Group の Object を保留する
   * アプリ (映像の復号順を守る受信側など) が使う。
   */
  subgroupEnd?: (end: SubgroupStreamEnd) => void;
}

/**
 * サブスクライブオプション
 */
export interface SubscribeOptions {
  /**
   * Location Filter
   * draft-ietf-moq-transport-23 Section 3.3.1, Section 9.19.9
   *
   * どのオブジェクトを受信するかを指定するフィルタ。Location Filter Type
   * (vi64) が形式を決める (§9.19.9 Table 6):
   * - { startGroup }: 0x01 (相対指定)。Start Location =
   *   {LARGEST_OBJECT の Group + 1 - startGroup, 0} (startGroup = 0 は Next Group)。
   *   負値は 0、2^64-1 超は 2^64-1 にクランプし、未配信時は {0, 0} から開始
   * - { startGroup, startObject }: 0x02 (絶対開始、終了なし)。0:0 は絶対位置
   *   {0, 0} の指定であり Next Object ではない
   * - { startGroup, startObject, endGroupDelta }: 0x03 (絶対範囲)。End Group =
   *   StartGroup + endGroupDelta が 2^64-1 を超えると送信前に
   *   InvalidFilterError で throw する（§9.19.9）
   * - { startGroup, startObject, endGroupDelta, endObject }: 0x04 (絶対範囲 +
   *   End Object)
   * - { nextObject: true }: 0x05 (Next Object)。LARGEST_OBJECT の次の Object から。
   *   未配信時は {0, 0} から開始
   * - { reset: true }: 0x00 (None)。REQUEST_UPDATE でのフィルタ除去
   *
   * 指定しない場合、フィルタなし（全オブジェクト）
   */
  filter?: LocationFilter;

  /**
   * Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-23 Section 9.19.4 (OBJECT_DELIVERY_TIMEOUT Parameter)
   *
   * オブジェクトを受信してから配信を試みる最大時間。
   * moqt-js はこの値を SUBSCRIBE の Message Parameter として送信するが、この値の強制は行わない。
   * 比較と強制は Publisher 値と Subscriber 値の両方を持つエンドポイント（典型的にはリレー）の
   * 責務であり、詳細は Section 5.2 (Delivery Timeouts and Data Reliability) を参照。
   */
  deliveryTimeout?: bigint;

  /**
   * Subgroup Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-23 Section 9.19.3 (SUBGROUP_DELIVERY_TIMEOUT Parameter)
   *
   * Subgroup 内のオブジェクトを配信する最大時間。0 はタイムアウトなしを意味する。
   * moqt-js はこの値を SUBSCRIBE の Message Parameter として送信するが、この値の強制は行わない。
   * 比較と強制は Publisher 値と Subscriber 値の両方を持つエンドポイント（典型的にはリレー）の
   * 責務であり、詳細は Section 5.2 (Delivery Timeouts and Data Reliability) を参照。
   */
  subgroupDeliveryTimeout?: bigint;

  /**
   * Subscriber Priority（0-255）
   * draft-ietf-moq-transport-23 Section 9.19.7 (SUBSCRIBER PRIORITY Parameter)
   *
   * サブスクリプションの優先度。小さい値ほど高優先度。
   * 指定しない場合は 128（デフォルト）
   */
  subscriberPriority?: number;

  /**
   * Group Order
   * draft-ietf-moq-transport-23 Section 9.19.8 (GROUP ORDER Parameter)
   *
   * グループの配信順序の希望。
   * - "Ascending": 古いグループから順に配信
   * - "Descending": 新しいグループから順に配信
   *
   * 指定しない場合は Publisher の preference を使用
   */
  groupOrder?: "Ascending" | "Descending";

  /**
   * 新しいグループ（キーフレーム）を要求する
   * draft-ietf-moq-transport-23 Section 9.19.19 (NEW GROUP REQUEST Parameter)
   *
   * 0 を指定すると、Publisher は新しい Group を開始する
   * Publisher が DYNAMIC_GROUPS をサポートしていない場合は無視される
   */
  newGroupRequest?: bigint;

  /**
   * subscription が paused かどうか (PAUSED パラメータ)
   * draft-ietf-moq-transport-23 §9.19.18 (PAUSED Parameter) / §3.1.1 (Pausing Subscriptions)
   *
   * - true (1): paused。オブジェクトが届かず、PUBLISH_DONE などの制御メッセージは届く
   * - false (0): paused でない。オブジェクトが届く
   *
   * 省略した場合は 0（paused でない）がデフォルト。subscription の初期状態は
   * initiator が SUBSCRIBE で設定し、以後は update({ paused }) の REQUEST_UPDATE で
   * 更新する。draft-22 の FORWARD は 1 = 転送するだったため、値の意味が反転している。
   *
   * paused 中の購読では publisher は fill fetch ストリームを開かない
   * (§3.4.1)。fill と併用した場合も同様である。
   */
  paused?: boolean;

  /**
   * Rendezvous Timeout（ミリ秒）
   * draft-ietf-moq-transport-23 Section 9.19.6 (RENDEZVOUS TIMEOUT Parameter)
   *
   * リレーが Publisher を待つ時間。
   * 0 は即時応答を要求。指定しない場合のデフォルトは 0。
   * draft-ietf-moq-transport-23 Section 9.19.6
   */
  rendezvousTimeout?: bigint;

  /**
   * Range Filters
   * draft-ietf-moq-transport-23 Section 3.3.2 (Range Filters)
   *
   * ピアの MAX_FILTER_RANGES が 0（未広告含む）の場合、および購読単位の Ranges
   * 合計（この rangeFilters と fill 内側の合計）が上限を超える場合に指定すると
   * throw する。
   */
  rangeFilters?: RangeFilterSpec[];

  /**
   * AUTHORIZATION_TOKEN Message Parameter (0x03) として送信する Authorization Token
   * draft-ietf-moq-transport-23 Section 9.19.2 (AUTHORIZATION TOKEN Parameter)
   *
   * draft-ietf-moq-msf-01 §11.4.3: track に関連するトークンは SUBSCRIBE に MUST 付与。
   * SETUP にトークンを載せていても免除されない。
   */
  authorizationToken?: AuthorizationToken;

  /**
   * fill fetch の要求
   * draft-ietf-moq-transport-23 Section 3.4 (Fill Semantics) /
   * Section 9.19.15 (FILL PARAMETERS Parameter)
   *
   * FILL_PARAMETERS (0x23) として送信し、live 手前の範囲を fill fetch
   * ストリームで取得する。対向が開いた fill fetch ストリームは購読に紐付けて
   * 受信する。fill 経由のオブジェクトは fillDelivered を true にして渡すため、
   * subscription 経由と区別できる。各 Object を一度だけ受け取りたい場合は、
   * Next Object の subscription ({ nextObject: true }、Location Filter Type 0x05) と
   * open-ended な fill を組み合わせる (publisher が fill を Largest Object で
   * 終えるため重複なくつながる。§3.4 の exactly-once パターン)。
   *
   * paused: true と併用した場合、publisher は fill fetch ストリームを開かない
   * (§3.4.1)。paused を解除しても FILL_PARAMETERS を再送しない限り開かれない。
   */
  fill?: FillRequestOptions;

  /**
   * Track Properties の受信要求
   * draft-ietf-moq-transport-23 Section 9.19.22 (INCLUDE_PROPERTIES Parameter)
   *
   * true (1) は応答に Track Properties を載せるよう要求し、
   * false (0) は空にするよう要求する。省略時はパラメータ自体を送らず、
   * 対向のデフォルト (1 と同等) に従う。
   */
  includeProperties?: boolean;
}

/**
 * SUBSCRIBE_TRACKS のオプション
 *
 * draft-ietf-moq-transport-23 §9.17 (SUBSCRIBE_TRACKS) が列挙する許可パラメータ
 * (OBJECT_DELIVERY_TIMEOUT / AUTHORIZATION_TOKEN / SUBGROUP_DELIVERY_TIMEOUT /
 *  PAUSED / SUBSCRIBER_PRIORITY / LOCATION_FILTER / GROUP_ORDER /
 *  FILL_PARAMETERS / SUBGROUP_FILTER / OBJECTID_FILTER / PRIORITY_FILTER /
 *  OBJECT_PROPERTY_FILTER / TRACK_PROPERTY_FILTER / INCLUDE_PROPERTIES) のうち、
 * RENDEZVOUS_TIMEOUT / NEW_GROUP_REQUEST を除く型を扱う。
 *
 * draft-ietf-moq-transport-23 §3.6.2 (Parameters on SUBSCRIBE_TRACKS):
 * AUTHORIZATION_TOKEN と TRACK_PROPERTY_FILTER は SUBSCRIBE_TRACKS 自身に適用され、
 * それ以外は結果 PUBLISH で確立する subscription の初期条件として publisher が
 * PUBLISH に含める。RENDEZVOUS_TIMEOUT / NEW_GROUP_REQUEST は単一 Track の
 * SUBSCRIBE 専用であり、SUBSCRIBE_TRACKS には出現できないため扱わない。
 */
export interface SubscribeTracksOptions {
  /**
   * Location Filter
   * draft-ietf-moq-transport-23 §9.17 (SUBSCRIBE_TRACKS) /
   * §9.19.9 (LOCATION_FILTER Parameter) / §3.6.2
   *
   * 結果 PUBLISH で確立する subscription の初期 Location Filter。
   * 形式は SubscribeOptions.filter と同じ (§9.19.9 Table 6)。省略時はパラメータを
   * 送らず、publisher の既定値 (フィルタ無し) に従う。
   */
  filter?: LocationFilter;

  /**
   * Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-23 §9.17 (SUBSCRIBE_TRACKS) /
   * §9.19.4 (OBJECT_DELIVERY_TIMEOUT Parameter) / §3.6.2
   *
   * 結果 PUBLISH で確立する subscription の初期値。省略時は送らず、
   * publisher の既定値に従う。
   */
  deliveryTimeout?: bigint;

  /**
   * Subgroup Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-23 §9.17 (SUBSCRIBE_TRACKS) /
   * §9.19.3 (SUBGROUP_DELIVERY_TIMEOUT Parameter) / §3.6.2
   *
   * 結果 PUBLISH で確立する subscription の初期値。省略時は送らず、
   * publisher の既定値に従う。
   */
  subgroupDeliveryTimeout?: bigint;

  /**
   * Subscriber Priority（0-255）
   * draft-ietf-moq-transport-23 §9.17 (SUBSCRIBE_TRACKS) /
   * §9.19.7 (SUBSCRIBER PRIORITY Parameter) / §3.6.2
   *
   * 結果 PUBLISH で確立する subscription の初期値。省略時は送らず、
   * publisher の既定値 (128) に従う。
   */
  subscriberPriority?: number;

  /**
   * fill fetch の要求
   * draft-ietf-moq-transport-23 §9.17 (SUBSCRIBE_TRACKS) /
   * §9.19.15 (FILL_PARAMETERS Parameter) / §3.6.2
   *
   * FILL_PARAMETERS として送り、結果 PUBLISH の subscription に適用する初期
   * fill 要求。内側の Parameter は §9.19.15 の制限に従う。省略時は送らない。
   *
   * paused: true を併用した場合、結果 PUBLISH の subscription は paused であり、
   * publisher は fill fetch ストリームを開かない (§3.4.1)。paused を解除しても
   * FILL_PARAMETERS を再送しない限り開かれない。
   */
  fill?: FillRequestOptions;

  /**
   * Group Order
   * draft-ietf-moq-transport-23 Section 9.19.8 (GROUP ORDER Parameter)
   */
  groupOrder?: "Ascending" | "Descending";

  /**
   * 将来の subscription が paused かどうか (PAUSED パラメータ)
   * draft-ietf-moq-transport-23 §9.19.18 (PAUSED Parameter) / §3.1.1 (Pausing Subscriptions)
   *
   * 省略した場合は 0（paused でない）がデフォルト。
   * 明示的に true のときだけワイヤに PAUSED=1 を載せる。
   * SUBSCRIBE_TRACKS の REQUEST_UPDATE では、prefix に一致する将来の subscription に
   * だけ作用し、既存の subscription は変わらない。
   *
   * paused 中の購読では publisher は fill fetch ストリームを開かない
   * (§3.4.1)。fill と併用した場合も同様である。
   */
  paused?: boolean;

  /**
   * Range Filters
   * draft-ietf-moq-transport-23 Section 3.3.2 (Range Filters)
   *
   * ピアの MAX_FILTER_RANGES が 0（未広告含む）の場合、および購読単位の Ranges
   * 合計が上限を超える場合に指定すると throw する。合計には fill 内側の
   * fill.rangeFilters も含む (FILL_PARAMETERS の内側も同じ購読に載るため)。
   */
  rangeFilters?: RangeFilterSpec[];

  /**
   * Track Properties の受信要求
   * draft-ietf-moq-transport-23 Section 9.19.22 (INCLUDE_PROPERTIES Parameter)
   *
   * true (1) は結果 PUBLISH に Track Properties を載せるよう要求し、
   * false (0) は空にするよう要求する。省略時は送らない (デフォルト 1 と同等)。
   * §9.17 は SUBSCRIBE_TRACKS での出現を許可するが、§9.8 の PUBLISH 許可一覧には
   * 無いため、結果 PUBLISH にこのパラメータが載ることは想定しない。
   */
  includeProperties?: boolean;

  /**
   * 認可トークン
   * draft-ietf-moq-transport-23 Section 9.19.2 (AUTHORIZATION TOKEN Parameter)
   *
   * 省略時は送らない。
   */
  authorizationToken?: AuthorizationToken;
}

/**
 * フェッチコールバック
 */
export interface FetchCallbacks {
  object: (object: MoqtObject) => void;
  /**
   * FETCH データストリームの終了通知
   *
   * FIN を受信したときに呼ばれる既存の通知であり、Fetcher.endOfTrack
   * (Track の終端を確認済み) とは独立している。単なる FIN では endOfTrack は
   * 変わらず、FETCH データストリームの End of Track indicator
   * (draft-ietf-moq-transport-23 §11.4.1 (Fetch Header) / Table 8 / §11.4.2.2) を
   * 受理したときだけ true になる。End of Track indicator を受信してもこの通知は
   * 呼ばれず、Track の終端確認は Fetcher.endOfTrack で判断する。indicator の後に
   * データストリームが FIN すれば、その時点でこの通知が呼ばれる。
   */
  end?: () => void;
  error?: (error: Error) => void;
  /**
   * リクエストストリーム上で GOAWAY を受信した時のコールバック
   * draft-ietf-moq-transport-23 Section 9.2 (GOAWAY):
   * 当該リクエストのマイグレーション先 URI を通知する。
   */
  goaway?: (newSessionUri: string) => void;
}

/**
 * フェッチオプション
 */
export interface FetchOptions {
  /**
   * Fill Timeout（ミリ秒）
   * draft-ietf-moq-transport-23 Section 9.19.5 (FILL TIMEOUT Parameter)
   *
   * relay が欠損 object の fill 待機に費やす最大時間。
   * 0 は即座に利用可能な object のみを要求。
   */
  fillTimeout?: bigint;

  /**
   * Subscriber Priority
   * draft-ietf-moq-transport-23 Section 9.19.7 (SUBSCRIBER PRIORITY Parameter)
   *
   * FETCH 応答の優先度 (0-255、小さいほど高優先)。
   * "It MAY appear in a SUBSCRIBE, PUBLISH, FETCH, or REQUEST_UPDATE"。
   * 省略時は送らない (受信側は既定値として扱う)。
   */
  subscriberPriority?: number;

  /**
   * Group Order
   * draft-ietf-moq-transport-23 Section 9.19.8 (GROUP ORDER Parameter)
   *
   * FETCH 応答で Object を Group 順に並べる順序を要求する。
   * "It MAY appear in a SUBSCRIBE, PUBLISH, SUBSCRIBE_TRACKS, or FETCH"。
   * 省略時は送らない (FETCH の成功応答 (REQUEST_OK) に出現できるパラメータでは
   * ないため、応答でエコーされることはない)。
   */
  groupOrder?: "Ascending" | "Descending";

  /**
   * Location Filter
   * draft-ietf-moq-transport-23 §3.3.1 / §9.19.9 (Table 6)
   *
   * 取得する範囲を指定する。FETCH で使える形式は None (0x00) と絶対指定
   * (0x02 / 0x03 / 0x04) だけである。相対指定 (0x01) は §3.2 により publisher が
   * INVALID_RANGE を返し、Next Object (0x05) も既存 Object の範囲を指さないため、
   * 送信前に InvalidFilterError で拒否する。Location Filter Type (vi64) が形式を
   * 決める (§9.19.9 Table 6):
   * - { startGroup, startObject }: 0x02 (絶対開始)。0:0 は絶対位置 {0, 0} の
   *   指定であり Next Object ではない
   * - { startGroup, startObject, endGroupDelta }: 0x03 (絶対開始 + Group 終端)。
   *   End Group = StartGroup + endGroupDelta が 2^64-1 を超えると送信前に
   *   InvalidFilterError で throw する (§9.19.9 は超過時に
   *   DELTA_ENCODING_OVERFLOW を要求するため、ワイヤに載せる前にローカルで拒否する)
   * - { startGroup, startObject, endGroupDelta, endObject }: 0x04 (絶対範囲 +
   *   End Object)。同一 Group で End Object が Start Object より小さい空範囲は
   *   送信前に InvalidFilterError で拒否する
   * - { reset: true }: 0x00 (None。フィルタなし。FETCH では省略と等価)
   *
   * 指定しない場合と 0x00 / 0x02 は、{0, 0} または Start Location から Largest
   * Object までの範囲を要求する (§3.2 / §9.19.9)。この場合、応答の LARGEST_OBJECT が
   * 要求 End そのものになるため、LARGEST_OBJECT を欠く成功応答は
   * MALFORMED_MESSAGE になる。
   *
   * 応答がカバーする範囲の終端は、要求した End Location と応答の LARGEST_OBJECT から
   * §3.2 に従って確定する (Fetcher.endLocation)。0x03 で LARGEST_OBJECT による
   * 終端が得られない場合、終端は {StartGroup + endGroupDelta, 2^64-1} に正規化される。
   * この Object ID は Group 全体を含む境界値であり、実在する最後の Object ID では
   * ない。
   */
  filter?: LocationFilter;

  /**
   * Range Filters
   * draft-ietf-moq-transport-23 Section 3.3.2 (Range Filters)
   *
   * ピアの MAX_FILTER_RANGES が 0（未広告含む）の場合、および Ranges の合計が
   * 上限を超える場合に指定すると throw する。
   */
  rangeFilters?: RangeFilterSpec[];

  /**
   * AUTHORIZATION_TOKEN Message Parameter (0x03) として送信する Authorization Token
   * draft-ietf-moq-transport-23 Section 9.19.2 (AUTHORIZATION TOKEN Parameter)
   *
   * draft-ietf-moq-msf-01 §11.4.3: track に関連するトークンは FETCH に MUST 付与。
   */
  authorizationToken?: AuthorizationToken;

  /**
   * Track Properties の受信要求
   * draft-ietf-moq-transport-23 Section 9.19.22 (INCLUDE_PROPERTIES Parameter)
   *
   * true (1) は応答に Track Properties を載せるよう要求し、
   * false (0) は空にするよう要求する。省略時は送らない (デフォルト 1 と同等)。
   */
  includeProperties?: boolean;
}

/**
 * TRACK_STATUS のオプション
 * draft-ietf-moq-transport-23 Section 9.19.22 (INCLUDE_PROPERTIES Parameter)
 */
export interface TrackStatusOptions {
  /**
   * Track Properties の受信要求
   * draft-ietf-moq-transport-23 Section 9.19.22 (INCLUDE_PROPERTIES Parameter)
   *
   * true (1) は応答に Track Properties を載せるよう要求し、
   * false (0) は空にするよう要求する。省略時は送らない (デフォルト 1 と同等)。
   */
  includeProperties?: boolean;

  /**
   * 認可トークン
   * draft-ietf-moq-transport-23 Section 9.19.2 (AUTHORIZATION TOKEN Parameter)
   *
   * "It MAY appear in a PUBLISH, SUBSCRIBE, REQUEST_UPDATE, SUBSCRIBE_NAMESPACE,
   *  SUBSCRIBE_TRACKS, PUBLISH_NAMESPACE, TRACK_STATUS or FETCH message."
   * 省略時は送らない。
   */
  authorizationToken?: AuthorizationToken;
}

/**
 * TRACK_STATUS の結果
 * draft-ietf-moq-transport-23 §9.12 (TRACK_STATUS) / §9.3 (REQUEST_OK)
 */
export interface TrackStatusResult {
  /**
   * 応答パラメータ (TRACK_STATUS_OK の許可一覧は EXPIRES と LARGEST_OBJECT のみ)
   *
   * draft-ietf-moq-transport-23 §9.19.16 (EXPIRES Parameter):
   * EXPIRES は同じ Track の購読を確立した場合に送る値 (SUBSCRIBE_OK に入れる値)
   * であり、TRACK_STATUS という 1 回限りの問い合わせ自体の存続期限ではない。
   * ミリ秒単位で送信者が request を終了する時期を通知するが、値は advisory で
   * あり、送信者は期限の前後で終了し得る。0 または省略は期限無し / 期限不明を
   * 表す。受信側はこれを自動取消しや自動再認証の必須の契機にしない。
   */
  parameters: Parameter[];
  /**
   * TRACK_STATUS_OK が運ぶ Track Properties
   *
   * draft-ietf-moq-transport-23 §9.3 (REQUEST_OK):
   * "Track Properties are populated in TRACK_STATUS_OK and FETCH_OK"。
   * §9.12 (TRACK_STATUS): "the publisher responds with a TRACK_STATUS_OK with the
   *  same parameters and Track Properties it would have set in a SUBSCRIBE_OK"。
   * そのため応答は SUBSCRIBE_OK と同じ Track Properties を運ぶ。
   * INCLUDE_PROPERTIES (Section 9.19.22) が 0 の場合も Track Properties の
   * フィールド自体はメッセージに残るが、"they SHOULD be empty" であるため空に
   * なることが期待される。moqt-js はデコードした値をそのまま返すため、ピアが
   * 空にしなかった場合は空配列にならない。
   */
  trackProperties: Property[];
}

/**
 * Namespace サブスクリプションのコールバック
 *
 * draft-ietf-moq-transport-23 §9.14 (SUBSCRIBE_NAMESPACE):
 * SUBSCRIBE_NAMESPACE への応答として、NAMESPACE / NAMESPACE_DONE が送信される。
 * draft-18 で旧 SUBSCRIBE_NAMESPACE (0x11) が SUBSCRIBE_NAMESPACE (0x50) と
 * SUBSCRIBE_TRACKS (0x51) に分割され、PUBLISH_SKIPPED は SUBSCRIBE_TRACKS 応答に移動した。
 *
 * draft-ietf-moq-transport-23 §9.15 で NAMESPACE は Track Namespace Suffix の
 * 後ろに Message Parameters を持つようになった。
 */
export interface NamespaceSubscriptionCallbacks {
  /**
   * NAMESPACE を受信したときに呼ばれる
   * draft-ietf-moq-transport-23 §9.15 (NAMESPACE)
   *
   * "When Parameters of a NAMESPACE change, the NAMESPACE message is sent again
   *  with the updated Parameters."
   * そのため同じ suffix で複数回呼ばれ得る。active な期間の 2 回目以降は、
   * 新しい namespace の追加ではなく同じ namespace の Parameters の更新として
   * 扱う。onNamespaceDone は FIN / RESET による補完が明示的な NAMESPACE_DONE と
   * 重複しないことを保証する。同じ suffix の NAMESPACE_DONE を重複して受けた
   * 場合の呼び出し回数は仕様が定めておらず、この保証の対象外である。
   * NAMESPACE_DONE の後に同じ suffix の NAMESPACE を受けた場合は再追加として
   * 扱う。
   *
   * Parameters は draft-ietf-moq-transport-23 §9.19 (Control Message Parameters) の
   * Message Parameter である。現在の draft は NAMESPACE に出現できるパラメータを
   * 定義しておらず、拡張が NAMESPACE 用のパラメータを定義した場合だけ載る。
   * そのため現在は常に空配列である。§9.19 は受信側が理解できない Message Parameter
   * を INVALID_PARAMETER で拒否することを MUST とし、NAMESPACE に定義の無い
   * パラメータを受信した場合はセッションを閉じるため、このコールバックへは届かない。
   *
   * @param namespaceSuffix - Track Namespace Prefix を除いた Suffix
   * @param parameters - NAMESPACE の Message Parameters (§9.19、現在は常に空)
   */
  onNamespace?: (namespaceSuffix: string[], parameters: Parameter[]) => void;
  /**
   * NAMESPACE_DONE を受信したときに呼ばれる
   * draft-ietf-moq-transport-23 §9.16 (NAMESPACE_DONE)
   *
   * NAMESPACE_DONE を受信していない active namespace は、応答ストリームの
   * FIN / RESET 検出時に補完して 1 回だけ呼ばれる
   * (draft-ietf-moq-transport-23 §4.2.2 Namespace Subscription State Management)。
   *
   * @param namespaceSuffix - Track Namespace Prefix を除いた Suffix
   */
  onNamespaceDone?: (namespaceSuffix: string[]) => void;
  /**
   * エラー時のコールバック
   *
   * セッション終了起源の読み取りエラー (`source: "session"`) では呼ばない。
   * セッションを閉じるプロトコル違反 (`ProtocolViolationError` など) でも呼び、
   * `ConnectCallbacks.error` と重複して届き得る。
   */
  error?: (error: Error) => void;
  /**
   * GOAWAY 受信時に呼ばれる
   * draft-ietf-moq-transport-23 §9.2 (GOAWAY):
   * リクエストストリーム上の GOAWAY は当該リクエストの
   * マイグレーションのみを目的とする。
   *
   * @param newSessionUri - 新しいセッション URI
   */
  goaway?: (newSessionUri: string) => void;
}

/**
 * Namespace サブスクリプションの更新オプション
 *
 * draft-ietf-moq-transport-23 §9.5.2 (Updating Namespace Subscriptions):
 * REQUEST_UPDATE に TRACK_NAMESPACE_PREFIX パラメータ (0x34) を含めて
 * 確立済みの SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS の Track Namespace Prefix を
 * 更新する。
 */
export interface NamespaceUpdateOptions {
  /**
   * 更新後の Track Namespace Prefix
   * draft-ietf-moq-transport-23 §9.19.20 (TRACK_NAMESPACE_PREFIX Parameter)
   */
  trackNamespacePrefix: string[];
  // Authorization Token は公開オプションに持たせない。draft-ietf-moq-msf-01 §11.4.3 の
  // MUST に従い、初回要求 (SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS) のトークンを
  // RequestStream 側で保持して REQUEST_UPDATE に引き継ぐ (subscription 系の
  // REQUEST_UPDATE が Subscriber のトークンを使うのと同じ扱い)。
}

/**
 * Tracks 更新のオプション
 * draft-ietf-moq-transport-23 §9.19.18 (PAUSED Parameter):
 * SUBSCRIBE_TRACKS の REQUEST_UPDATE に PAUSED が許可された。
 * PAUSED は prefix に一致する将来の subscription が paused かどうかを指定し、
 * 既存購読には影響しない。省略時は不変。
 */
export interface TracksUpdateOptions extends NamespaceUpdateOptions {
  /**
   * 将来の subscription が paused かどうか (PAUSED パラメータ)
   * draft-ietf-moq-transport-23 §9.19.18 (PAUSED Parameter)
   *
   * wire の PAUSED と同じ意味で、true (1 = paused) / false (0 = unpaused) を
   * 明示送信する。省略時は不変。
   * SUBSCRIBE_NAMESPACE 向け REQUEST_UPDATE では許可されないため、
   * NamespaceSubscription.update には露出させない。
   */
  paused?: boolean;
}

/**
 * Namespace サブスクリプション
 */
export interface NamespaceSubscription {
  readonly state: "active" | "closed";
  /**
   * サブスクリプションを解除する
   */
  unsubscribe(): Promise<void>;
  /**
   * Track Namespace Prefix を更新する (REQUEST_UPDATE を送信)
   *
   * draft-ietf-moq-transport-23 §9.5.2 (Updating Namespace Subscriptions):
   * REQUEST_OK 受信で resolve、REQUEST_ERROR / ストリームクローズで reject する。
   *
   * draft-ietf-moq-transport-23 §9.5.2 (Updating Namespace Subscriptions) /
   * §4.2 (Subscribing to Namespaces):
   * draft-22 の overlap 制約は削除され、他のアクティブな購読と prefix が重なる
   * 更新も送信できる (受理可否はピアが判断する)。REQUEST_OK を受信した時点で、
   * 以後の NAMESPACE / NAMESPACE_DONE は新しい prefix 基準の suffix になる。
   * 新 prefix に一致しなくなった active namespace には NAMESPACE_DONE が暗黙に
   * 適用され、onNamespaceDone が旧 prefix 基準の suffix で 1 回だけ届く。
   *
   * 以下の場合はローカル検証として throw する:
   * - サブスクリプションが active でない
   * - GOAWAY 受信後 (ストリーム移行中)
   * - ピアの MAX_REQUEST_UPDATES を超える送信
   * - 前の更新が in-flight (REQUEST_OK 未受信) のうちの 2 件目
   *   (前の update() の settle を待ってから呼ぶこと)
   * - 予約 namespace / .session への更新
   *
   * @param options - 更新内容 (TRACK_NAMESPACE_PREFIX)
   */
  update(options: NamespaceUpdateOptions): Promise<void>;
}

/**
 * Tracks サブスクリプションのコールバック
 *
 * draft-ietf-moq-transport-23 §3.6 (Subscribing to Tracks by Prefix):
 * SUBSCRIBE_TRACKS への応答として PUBLISH メッセージが新規双方向ストリームで
 * 送信される。応答ストリームでは PUBLISH_SKIPPED が送られる。
 */
export interface TracksSubscriptionCallbacks {
  /**
   * サーバーから PUBLISH メッセージを受信したときに呼ばれる
   * draft-ietf-moq-transport-23 §3.6 / §9.17 / §9.8
   *
   * @param namespaceSuffix - Track Namespace Prefix を除いた Suffix
   * @param trackName - PUBLISH に含まれる Track Name
   * @returns SubscribeCallbacks — 内部的に SubscriberImpl を生成しコールバックを伝搬する
   */
  onPublish?: (
    namespaceSuffix: string[],
    trackName: string,
  ) => SubscribeCallbacks | Promise<SubscribeCallbacks>;
  /**
   * PUBLISH_SKIPPED を受信したときに呼ばれる
   * draft-ietf-moq-transport-23 §9.18 (PUBLISH_SKIPPED) / §3.6.3 (Skipped Tracks):
   *
   * > The publisher sends the PUBLISH_SKIPPED control message to indicate
   * > it will not send a PUBLISH message to initiate a new Subscription for a
   * > Track in the SUBSCRIBE_TRACKS's Track Namespace.
   *
   * @param namespaceSuffix - Track Namespace Prefix を除いた Suffix
   * @param trackName - 確立できなかった Subscription の Track Name
   */
  onPublishSkipped?: (namespaceSuffix: string[], trackName: string) => void;
  /**
   * エラー時のコールバック
   *
   * セッション終了起源の読み取りエラー (`source: "session"`) では呼ばない。
   * セッションを閉じるプロトコル違反 (`ProtocolViolationError` など) でも呼び、
   * `ConnectCallbacks.error` と重複して届き得る。
   */
  error?: (error: Error) => void;
  /**
   * GOAWAY 受信時に呼ばれる
   * draft-ietf-moq-transport-23 §9.2 (GOAWAY):
   * リクエストストリーム上の GOAWAY は当該リクエストの
   * マイグレーションのみを目的とする。
   *
   * @param newSessionUri - 新しいセッション URI
   */
  goaway?: (newSessionUri: string) => void;
}

/**
 * Tracks サブスクリプション
 *
 * draft-ietf-moq-transport-23 §3.6 / §9.17 (SUBSCRIBE_TRACKS)
 */
export interface TracksSubscription {
  readonly state: "active" | "closed";
  /**
   * サブスクリプションを解除する
   */
  unsubscribe(): Promise<void>;
  /**
   * Track Namespace Prefix と paused 状態を更新する (REQUEST_UPDATE を送信)
   *
   * draft-ietf-moq-transport-23 §9.5.2 (Updating Namespace Subscriptions):
   * "Updating the prefix of a SUBSCRIBE_TRACKS has no effect on existing
   *  subscriptions." (既存の確立済み SubscriberImpl には影響しない)
   * draft-ietf-moq-transport-23 §9.19.18 (PAUSED Parameter):
   * SUBSCRIBE_TRACKS の REQUEST_UPDATE に PAUSED が許可された。
   * 将来の subscription が paused かどうか (PAUSED パラメータ) を指定し、既存購読には影響しない。
   *
   * REQUEST_OK 受信で resolve、REQUEST_ERROR / ストリームクローズで reject する。
   *
   * 以下の場合はローカル検証として throw する:
   * - サブスクリプションが active でない
   * - GOAWAY 受信後 (ストリーム移行中)
   * - ピアの MAX_REQUEST_UPDATES を超える送信
   * - 前の更新が in-flight (REQUEST_OK 未受信) のうちの 2 件目
   *   (前の update() の settle を待ってから呼ぶこと)
   * - 予約 namespace / .session への更新
   *
   * draft-ietf-moq-transport-23 §9.5.2 (Updating Namespace Subscriptions):
   * draft-22 の overlap 制約は削除され、他のアクティブな購読と prefix が重なる
   * 更新も送信できる (受理可否はピアが判断する)。REQUEST_OK を受信した時点で、
   * 以後に受信する PUBLISH のマッチングは新しい prefix 基準になるが、確立済みの
   * 個別購読は取消さない。
   *
   * @param options - 更新内容 (TRACK_NAMESPACE_PREFIX + PAUSED)
   */
  update(options: TracksUpdateOptions): Promise<void>;
}

/**
 * Namespace 公開のコールバック
 * draft-ietf-moq-transport-23 Section 9.13 (PUBLISH_NAMESPACE)
 */
export interface NamespacePublicationCallbacks {
  /**
   * エラー時のコールバック
   *
   * 次の場合に呼ばれる。
   *
   * - デコードと namespace-scoped Redirect の検証を通った `REQUEST_ERROR` を
   *   受けたとき。ただしこの `PUBLISH_NAMESPACE` の要求ストリームで GOAWAY を
   *   受信した後の `REQUEST_ERROR` は無視するため呼ばない
   * - 読み取りが失敗したとき (確立前後を問わない)。ただしこの
   *   `PUBLISH_NAMESPACE` の要求ストリームで GOAWAY を受信した後、または
   *   対象の publication が既に closed のとき (セッション終了処理が先に
   *   閉じた場合や `done()` の後) は呼ばない。ピア起点のセッション終了
   *   (`source: "session"`) はセッション終了処理との順序により呼ばれることが
   *   ある
   *
   * ライブラリが `closeWithError` でセッションを閉じる原因 (`SessionError` /
   * `ProtocolViolationError` / `IncompleteDataError`) では呼ばず、
   * `ConnectCallbacks.error` だけが通知する (2 つのコールバックで重複して
   * 届けないため)。確立前の未解決の返値の Promise は失敗で settle する。
   * ループが先に settle する場合は、受信した要求の失敗理由 (`RequestError` /
   * `ProtocolViolationError` など。要求ストリームの GOAWAY はマイグレーション
   * 理由の `Error`) で reject する。セッション終了が先行した場合は
   * セッション終了理由で settle する。
   */
  error?: (error: Error) => void;
  /**
   * GOAWAY 受信時に呼ばれる
   * draft-ietf-moq-transport-23 §9.2 (GOAWAY):
   * リクエストストリーム上の GOAWAY は当該リクエストの
   * マイグレーションのみを目的とする。
   *
   * @param newSessionUri - 新しいセッション URI
   */
  goaway?: (newSessionUri: string) => void;
}

/**
 * Namespace 公開のオプション
 * draft-ietf-moq-transport-23 Section 9.13 (PUBLISH_NAMESPACE)
 */
export interface PublishNamespaceOptions {
  /**
   * 認可トークン
   * draft-ietf-moq-transport-23 Section 9.19.2 (AUTHORIZATION TOKEN Parameter)
   *
   * "It MAY appear in a PUBLISH, SUBSCRIBE, REQUEST_UPDATE, SUBSCRIBE_NAMESPACE,
   *  SUBSCRIBE_TRACKS, PUBLISH_NAMESPACE, TRACK_STATUS or FETCH message."
   * 省略時は送らない。
   */
  authorizationToken?: AuthorizationToken;
}

/**
 * Namespace 公開
 * draft-ietf-moq-transport-23 Section 9.13 (PUBLISH_NAMESPACE)
 */
export interface NamespacePublication {
  readonly state: "active" | "closed";
  /**
   * 公開している Namespace
   *
   * `done()` の後も、生成時点の値を返す。
   */
  readonly namespace: string[];
  /**
   * 公開を終了する
   *
   * draft-ietf-moq-transport-23 §4.1 / §6.4.2.3: 公開の終了を通知する専用メッセージは
   * 無く、request のキャンセル (RESET_STREAM と STOP_SENDING) で行う。
   * 根拠の仕様はドラフトであり将来変更される可能性がある。
   */
  done(): Promise<void>;
}
