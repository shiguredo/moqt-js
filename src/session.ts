/**
 * MOQT セッション
 * draft-ietf-moq-transport-21 Section 6 (Sessions)
 */

import { ControlStreamReader, ControlStreamWriter, type ControlMessage } from "./controlStream";
import { decodeSubgroupHeader, type MoqtObject } from "./dataStream";
import {
  DataStreamErrorCode,
  IncompleteDataError,
  MalformedTrackError,
  RequestError,
  RequestErrorCode,
  SessionError,
  SessionErrorCode,
  normalizeRequestErrorCode,
  normalizeSessionErrorCode,
} from "./error";
import {
  MessageType,
  MessageParameterType,
  GroupOrder,
  createTrackNamespace,
  decodeLocationFilterParameter,
  encodeTrackName,
  validateFullTrackName,
  trackNamespaceToStrings,
  decodeGoawayPayload,
  decodePublishPayload,
  decodeRequestErrorPayload,
  decodeSetupPayload,
  getSetupAuthority,
  getSetupPath,
  getSetupMaxAuthTokenCacheSize,
  getSetupMaxFilterRanges,
  getSetupMaxRequestUpdates,
  encodeSetupPayload,
  encodeFetchPayload,
  encodePublishNamespacePayload,
  encodePublishPayload,
  encodeRequestOkPayload,
  encodeSubscribeNamespacePayload,
  encodeSubscribeTracksPayload,
  encodeSubscribePayload,
  encodeTrackStatusPayload,
  createSetup,
  getMessageTypeName,
  isRejectedReceiveNamespace,
  PublishDoneStatusCode,
  type AuthorizationToken,
  type Location,
  type Parameter,
  type LocationFilter,
  type RangeFilterSpec,
} from "./message";
import { PUBLISH_ALLOWED_PARAMS, validateParameterScope } from "./message/parameterScope";
import { decodeVarint, encodeVarint } from "./varint";
import {
  type Publisher,
  PublisherImpl,
  type PublishStateNotifyOptions,
  type SendObjectParams,
  type SendDatagramParams,
} from "./publisher";
import { type Subscriber, type RequestUpdateOptions, SubscriberImpl } from "./subscriber";
import { type Fetcher, FetcherImpl } from "./fetcher";
import { decodeFetchHeader, FetchHeaderType, type FetchHeader } from "./dataStream";
import { fullTrackNameKey } from "./fullTrackName";
import { PendingSubgroupBuffer, type PendingSubgroupBufferOptions } from "./pendingSubgroupBuffer";
import type { MoqtFragment } from "./moqtUri";
import {
  buildPublishParameters,
  buildPublishTrackProperties,
  buildSubscribeParameters,
  buildSubscribeTracksParameters,
  buildFetchParameters,
  buildSubscribeNamespaceParameters,
  buildTrackStatusParameters,
  encodeAuthorizationTokenParameter,
  extractForwardState,
  extractLargestLocation,
  matchNamespacePrefix,
  resolveFetchStartLocation,
  resolveFillGroupOrder,
  validateRangeFilterLimits,
  validateRangeFilterSpecs,
  validateTrackNamespaceForSend,
} from "./session/params";
import * as bidi from "./session/bidi";
import { concatChunks, cancelStreamQuiet } from "./session/stream";
import type { PriorGapTracking } from "./session/priorGapTracking";
import type { FullTrackNameKey } from "./fullTrackName";
import { trackPropertyFiltersMatch } from "./filter";
import {
  isPeerStreamError,
  isSessionClosedError,
  toProtocolViolationSessionError,
  toSessionCloseError,
} from "./session/errors";
import type { PublisherStreamState, SessionInternal } from "./session/types";
import {
  publishSendObject,
  publishClosePublisherStream,
  publishSendDatagram,
  publishSendPublishDone,
} from "./session/publish";
import {
  incomingHandleDatagram,
  incomingWaitForFetcher,
  incomingProcessFetchObjects,
  incomingProcessSubgroupObjects,
  incomingHandleFirstBidiMessage,
  incomingSendRequestErrorAndClose,
  incomingValidateRequestId,
} from "./session/incoming";
import * as namespaceLoops from "./session/namespaceLoops";
import {
  AuthTokenCache,
  type AuthTokenProcessResult,
  processMessageAuthorizationTokens,
  processSetupAuthorizationTokens,
} from "./session/authTokenCache";
import {
  sessionClose,
  sessionCloseControlStreamViolation,
  sessionCloseIfGoawayDrained,
  sessionCloseWithError,
  sessionEmitCallbackErrorDebug,
  sessionEmitDataStreamErrorDebug,
  sessionEmitDebug,
  sessionGoaway,
  sessionHandleControlMessage,
  sessionHandleGoaway,
  sessionHasOpenSubscriptionsOrFetches,
  sessionMarkRequestObjectsClosed,
  sessionNotifyErrorIfActive,
  sessionOnRequestDrained,
  sessionRejectPendingRequests,
  sessionStartControlMessageLoop,
  type SessionLifecycleInternal,
} from "./session/lifecycle";
import {
  sessionGetStatistics,
  type SessionStatistics,
  type SessionStatisticsSource,
} from "./session/statistics";

export type { MoqtObject } from "./dataStream";
export type { SessionStatistics } from "./session/statistics";

/**
 * fill fetch の要求内容
 * draft-ietf-moq-transport-21 Section 3.4 (Fill Semantics) /
 * Section 9.20.16 (FILL PARAMETERS Parameter)
 *
 * SUBSCRIBE / subscription の REQUEST_UPDATE に FILL_PARAMETERS (0x23) として
 * 載せ、live 手前の範囲を fill fetch ストリームで取得する。内側に載せられる
 * のは FILL_TIMEOUT / SUBSCRIBER_PRIORITY / LOCATION_FILTER / GROUP_ORDER /
 * Range Filters (0x25-0x28) のみ (§9.20.16 Table 6)。
 */
export interface FillRequestOptions {
  /**
   * fill 範囲の Location Filter
   *
   * 省略時は subscription の Location Filter、zero-length (reset) はトラック
   * 全体 (Largest Object まで) が fill 範囲になる (§3.4)。
   */
  filter?: LocationFilter;
  /**
   * Fill Timeout（ミリ秒）
   * draft-ietf-moq-transport-21 Section 9.20.6 (FILL TIMEOUT Parameter)
   */
  fillTimeout?: bigint;
  /**
   * Subscriber Priority（0-255）
   * draft-ietf-moq-transport-21 Section 9.20.8 (SUBSCRIBER PRIORITY Parameter)
   */
  subscriberPriority?: number;
  /**
   * Group Order
   * draft-ietf-moq-transport-21 Section 9.20.9 (GROUP ORDER Parameter)
   */
  groupOrder?: "Ascending" | "Descending";
  /**
   * Range Filters
   * draft-ietf-moq-transport-21 Section 3.3.2 (Range Filters)
   */
  rangeFilters?: RangeFilterSpec[];
}

/**
 * セッション状態
 */
export type SessionState = "connected" | "closed";

/**
 * 制御メッセージの受信タイムアウト既定値 (ミリ秒)
 *
 * draft-ietf-moq-transport-21 §12.2:
 * CONTROL_MESSAGE_TIMEOUT (0x11) は「ピアが制御メッセージへの応答に時間を
 * かけすぎた」ことを示す。制御メッセージは最大 65,535 バイトであり、
 * 半端なメッセージを保持したまま 10 秒待たされるのは異常である。
 */
const DEFAULT_CONTROL_MESSAGE_TIMEOUT_MS = 10_000;

/**
 * データストリームの受信タイムアウト既定値 (ミリ秒)
 *
 * draft-ietf-moq-transport-21 §12.2:
 * DATA_STREAM_TIMEOUT (0x12) は「ピアが開いたデータストリームで送るべき
 * データを送るのに時間をかけすぎた」ことを示す。Subgroup / Object ヘッダーの
 * 途中で止まったまま 30 秒経過したストリームは死んでいるものとして扱う。
 */
const DEFAULT_DATA_STREAM_TIMEOUT_MS = 30_000;

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
   * draft-ietf-moq-transport-21 Section 9.2 (GOAWAY)
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
   * draft-ietf-moq-transport-21 Section 9.1.4 (AUTHORIZATION TOKEN Setup Option)
   *
   * SETUP では Alias Type DELETE (0x0) / USE_ALIAS (0x2) は仕様上禁止 (Section 9.1.4)。
   * REGISTER (0x1) または USE_VALUE (0x3) のみ指定できる。
   */
  authorizationToken?: AuthorizationToken;

  /**
   * SETUP Option (Option Type 0x04) として広告する MAX_AUTH_TOKEN_CACHE_SIZE
   * draft-ietf-moq-transport-21 §9.1.3 (MAX_AUTH_TOKEN_CACHE_SIZE)
   *
   * ピアが保持してよい Authorization Token Alias の最大バイト数。
   * 省略時は SETUP Option を送信せず、既定値 0（Alias 使用禁止）となる。
   */
  maxAuthTokenCacheSize?: number;

  /**
   * SETUP Option (Option Type 0x08) として広告する MAX_REQUEST_UPDATES
   * draft-ietf-moq-transport-21 §9.1.7 (MAX_REQUEST_UPDATES)
   *
   * リクエストストリームごとに未応答で許可する REQUEST_UPDATE の最大数。
   * 0 は無制限。省略時は SETUP Option を送信せず、既定値 0（無制限）となる。
   */
  maxRequestUpdates?: number;

  /**
   * SETUP Option (Option Type 0x06) として広告する MAX_FILTER_RANGES
   * draft-ietf-moq-transport-21 §9.1.6 (MAX FILTER RANGES)
   *
   * ピアが購読・FETCH ごとに送信できる Range Filter の合計 Ranges 数。
   * 省略時は SETUP Option を送信せず、既定値 0（Range Filter 受信拒否）となり、
   * ピアから REQUEST_UPDATE 等で Range Filter を受信した場合は
   * REQUEST_ERROR (INVALID_FILTER) で拒否する。
   */
  maxFilterRanges?: number;

  /**
   * Pending Subgroup Stream の buffer 設定
   * draft-ietf-moq-transport-21 §11.3.1 の "MAY ... choose to buffer it for a brief
   * period to handle reordering with the control message that establishes the Track
   * Alias" を実現する buffer の上限を制御する。
   *
   * 指定しなかった field は `DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS` の値が使われる。
   */
  pendingSubgroup?: Partial<PendingSubgroupBufferOptions>;

  /**
   * 制御メッセージの受信タイムアウト (ミリ秒)
   *
   * draft-ietf-moq-transport-21 §12.2 の CONTROL_MESSAGE_TIMEOUT (0x11) に対応する。
   * 制御ストリームで半端なメッセージを保持したままこの時間が経過したら、
   * CONTROL_MESSAGE_TIMEOUT でセッションを閉じ、ストリームを打ち切る。
   * 0 以下を指定するとタイムアウトしない (既定は 10,000)。
   */
  controlMessageTimeoutMs?: number;

  /**
   * データストリームの受信タイムアウト (ミリ秒)
   *
   * draft-ietf-moq-transport-21 §12.2 の DATA_STREAM_TIMEOUT (0x12) に対応する。
   * Subgroup / Fetch のヘッダーまたは Object の途中バイトを保持したままこの
   * 時間が経過したら、DATA_STREAM_TIMEOUT でセッションを閉じ、当該ストリームを
   * 打ち切る。0 以下を指定するとタイムアウトしない (既定は 30,000)。
   */
  dataStreamTimeoutMs?: number;

  /**
   * MOQT_IMPLEMENTATION Setup Option (Option Type 0x07) の送信制御
   * draft-ietf-moq-transport-21 §9.1.5 (MOQT IMPLEMENTATION) /
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
   * draft-ietf-moq-transport-21 §13 (Grease)
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
interface SessionImplOptions {
  /** ConnectOptions.pendingSubgroup と同じ */
  pendingSubgroup?: Partial<PendingSubgroupBufferOptions>;
  /**
   * moqt URI の Fragment Identifier
   * draft-ietf-moq-transport-21 §6.1.1
   */
  fragment?: MoqtFragment | null;
}

/**
 * セッションインターフェース
 */
/**
 * パブリッシュコールバック
 */
export interface PublishCallbacks {
  error?: (error: Error) => void;
  /**
   * Forward State が変更された時のコールバック
   * draft-ietf-moq-transport-21 Section 9.20.19 (FORWARD Parameter)
   *
   * REQUEST_UPDATE で Forward State が変更された時に呼ばれる。
   * PUBLISH 送信時の options.forward による初期設定で変化した場合も呼ばれる。
   * - true (1): Subscriber がいる（オブジェクトを送信すべき）
   * - false (0): Subscriber がいない（オブジェクト送信を止めても良い）
   */
  onForwardStateChange?: (forward: boolean) => void;
  /**
   * リクエストストリーム上で GOAWAY を受信した時のコールバック
   * draft-ietf-moq-transport-21 Section 9.2 (GOAWAY):
   * 当該リクエストのマイグレーション先 URI を通知する。
   */
  goaway?: (newSessionUri: string) => void;
}

/**
 * パブリッシュオプション
 */
export interface PublishOptions {
  /**
   * キャッシュの最大保持時間（ミリ秒）
   * draft-ietf-moq-transport-21 Section 10.3 (MAX CACHE DURATION)
   *
   * Relay がオブジェクトをキャッシュして良い最大時間を指定する。
   * 0 を指定するとキャッシュを無効にする。
   */
  maxCacheDuration?: bigint;

  /**
   * Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-21 Section 10.2 (OBJECT_DELIVERY_TIMEOUT)
   *
   * PUBLISH の Track Properties として送信される OBJECT_DELIVERY_TIMEOUT（Message Parameter の定義は Section 9.20.5）。
   *
   * オブジェクトを受信してから配信を試みる最大時間。
   * moqt-js はこの値の強制は行わない。比較と強制は Publisher 値と Subscriber 値の両方を持つ
   * エンドポイント（典型的にはリレー）の責務であり、詳細は Section 5.2
   * (Delivery Timeouts and Data Reliability) を参照。
   */
  deliveryTimeout?: bigint;

  /**
   * Subgroup Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-21 Section 10.1 (SUBGROUP_DELIVERY_TIMEOUT)
   *
   * PUBLISH の Track Properties として送信される SUBGROUP_DELIVERY_TIMEOUT（Message Parameter の定義は Section 9.20.4）。
   *
   * Subgroup 内のオブジェクトを配信する最大時間。0 はタイムアウトなしを意味する。
   * moqt-js はこの値の強制は行わない。比較と強制は Publisher 値と Subscriber 値の両方を持つ
   * エンドポイント（典型的にはリレー）の責務であり、詳細は Section 5.2
   * (Delivery Timeouts and Data Reliability) を参照。
   */
  subgroupDeliveryTimeout?: bigint;

  /**
   * Publisher Priority（0-255）
   * draft-ietf-moq-transport-21 Section 10.4 (DEFAULT PUBLISHER PRIORITY)
   *
   * パブリッシュの優先度。小さい値ほど高優先度。
   * 指定しない場合は 128（デフォルト）
   */
  publisherPriority?: number;

  /**
   * Group Order
   * draft-ietf-moq-transport-21 Section 10.5 (DEFAULT PUBLISHER GROUP ORDER)
   *
   * グループの配信順序。
   * - "Ascending": 古いグループから順に配信
   * - "Descending": 新しいグループから順に配信
   */
  groupOrder?: "Ascending" | "Descending";

  /**
   * Dynamic Groups サポートの通知
   * draft-ietf-moq-transport-21 Section 10.6 (DYNAMIC GROUPS)
   *
   * true を設定すると、Subscriber が NEW_GROUP_REQUEST パラメータで
   * 新しいグループの生成を要求できることを通知する。
   */
  dynamicGroups?: boolean;

  /**
   * Expires（ミリ秒）
   * draft-ietf-moq-transport-21 Section 9.20.17 (EXPIRES Parameter)
   *
   * パブリッシュが自動終了するまでの時間（ミリ秒）。
   * 0 または未指定の場合は期限なし。
   */
  expires?: bigint;

  /**
   * Forward State
   * draft-ietf-moq-transport-21 Section 9.20.19 (FORWARD Parameter)
   *
   * オブジェクトの転送状態を指定する。
   * - true (1): オブジェクトを転送する（デフォルト）
   * - false (0): オブジェクトを転送しない
   *
   * 省略した場合は 1（転送する）がデフォルト。
   * 初期値は PUBLISH 送信時に宣言し、以後は REQUEST_UPDATE で更新する。
   */
  forward?: boolean;

  /**
   * LOC Timescale（Track Property として送信）
   * draft-ietf-moq-loc-04 Table 1 (TIMESCALE, Scope: Track, Object)
   *
   * 1 秒あたりの Timestamp 単位数。Track 初期化時に Track Property として広告し、
   * Object 単位の冗長送信を削減する。送らない場合は既存どおり Object Properties のみ。
   */
  locTimescale?: bigint;

  /**
   * LOC Video Config（Track Property として送信）
   * draft-ietf-moq-loc-04 Table 1 (VIDEO_CONFIG, Scope: Track, Object)
   *
   * VideoDecoderConfig の description。Track 初期化時に Track Property として広告する。
   */
  locVideoConfig?: Uint8Array;

  /**
   * LOC Audio Config（Track Property として送信）
   * draft-ietf-moq-loc-04 Table 1 (AUDIO_CONFIG, Scope: Track, Object)
   *
   * AudioDecoderConfig の description。Track 初期化時に Track Property として広告する。
   */
  locAudioConfig?: Uint8Array;
}

/**
 * サブスクライブコールバック
 */
export interface SubscribeCallbacks {
  object: (object: MoqtObject) => void;
  /**
   * Datagram で受信したオブジェクトのコールバック
   * draft-ietf-moq-transport-21 Section 11.2 (Datagrams)
   *
   * 注意: Datagram は信頼性がなく、順序も保証されない
   */
  datagram?: (object: MoqtObject) => void;
  end?: () => void;
  error?: (error: Error) => void;
  /**
   * fill fetch ストリームが失敗した時のコールバック
   *
   * draft-ietf-moq-transport-21 §3.4.1 (Opening and Closing Fill Fetch Streams):
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
   * draft-ietf-moq-transport-21 Section 9.2 (GOAWAY):
   * 当該リクエストのマイグレーション先 URI を通知する。
   */
  goaway?: (newSessionUri: string) => void;
}

/**
 * サブスクライブオプション
 */
export interface SubscribeOptions {
  /**
   * Location Filter
   * draft-ietf-moq-transport-21 Section 3.3.1, Section 9.20.10
   *
   * どのオブジェクトを受信するかを指定するフィルタ。フィールドの有無で意味が
   * 変わる (Length ベースのワイヤに対応、§9.20.10):
   * - { startGroup }: 相対指定。Start Group = LARGEST_OBJECT の Group + 1 - startGroup
   *   (startGroup = 0 は Next Group)。未配信時は {0, 0} から開始
   * - { startGroup, startObject }: 絶対開始（終了なし）。両方 0 は Next Object
   *   (LARGEST_OBJECT の次、未配信時は {0, 0})
   * - { startGroup, startObject, endGroupDelta }: 絶対範囲。End Group =
   *   StartGroup + endGroupDelta が 2^64-1 を超えると送信前に
   *   InvalidFilterError で throw する（§9.20.10）
   * - { startGroup, startObject, endGroupDelta, endObject }: 絶対範囲 +
   *   End Object
   * - { reset: true }: Length 0 (REQUEST_UPDATE でのフィルタ除去)
   *
   * 指定しない場合、フィルタなし（全オブジェクト）
   */
  filter?: LocationFilter;

  /**
   * Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-21 Section 9.20.5 (OBJECT_DELIVERY_TIMEOUT Parameter)
   *
   * オブジェクトを受信してから配信を試みる最大時間。
   * moqt-js はこの値を SUBSCRIBE の Message Parameter として送信するが、この値の強制は行わない。
   * 比較と強制は Publisher 値と Subscriber 値の両方を持つエンドポイント（典型的にはリレー）の
   * 責務であり、詳細は Section 5.2 (Delivery Timeouts and Data Reliability) を参照。
   */
  deliveryTimeout?: bigint;

  /**
   * Subgroup Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-21 Section 9.20.4 (SUBGROUP_DELIVERY_TIMEOUT Parameter)
   *
   * Subgroup 内のオブジェクトを配信する最大時間。0 はタイムアウトなしを意味する。
   * moqt-js はこの値を SUBSCRIBE の Message Parameter として送信するが、この値の強制は行わない。
   * 比較と強制は Publisher 値と Subscriber 値の両方を持つエンドポイント（典型的にはリレー）の
   * 責務であり、詳細は Section 5.2 (Delivery Timeouts and Data Reliability) を参照。
   */
  subgroupDeliveryTimeout?: bigint;

  /**
   * Subscriber Priority（0-255）
   * draft-ietf-moq-transport-21 Section 9.20.8 (SUBSCRIBER PRIORITY Parameter)
   *
   * サブスクリプションの優先度。小さい値ほど高優先度。
   * 指定しない場合は 128（デフォルト）
   */
  subscriberPriority?: number;

  /**
   * Group Order
   * draft-ietf-moq-transport-21 Section 9.20.9 (GROUP ORDER Parameter)
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
   * draft-ietf-moq-transport-21 Section 9.20.20 (NEW GROUP REQUEST Parameter)
   *
   * 0 を指定すると、Publisher は新しい Group を開始する
   * Publisher が DYNAMIC_GROUPS をサポートしていない場合は無視される
   */
  newGroupRequest?: bigint;

  /**
   * Forward State
   * draft-ietf-moq-transport-21 Section 9.20.19 (FORWARD Parameter)
   *
   * オブジェクトの転送状態を指定する。
   * - true (1): オブジェクトを転送する（デフォルト）
   * - false (0): オブジェクトを転送しない
   *
   * 省略した場合は 1（転送する）がデフォルト。
   */
  forward?: boolean;

  /**
   * Rendezvous Timeout（ミリ秒）
   * draft-ietf-moq-transport-21 Section 9.20.7 (RENDEZVOUS TIMEOUT Parameter)
   *
   * リレーが Publisher を待つ時間。
   * 0 は即時応答を要求。指定しない場合のデフォルトは 0。
   * draft-ietf-moq-transport-21 Section 9.20.7
   */
  rendezvousTimeout?: bigint;

  /**
   * Range Filters
   * draft-ietf-moq-transport-21 Section 3.3.2 (Range Filters)
   *
   * ピアの MAX_FILTER_RANGES が 0（未広告含む）の場合に指定すると throw する。
   */
  rangeFilters?: RangeFilterSpec[];

  /**
   * AUTHORIZATION_TOKEN Message Parameter (0x03) として送信する Authorization Token
   * draft-ietf-moq-transport-21 Section 9.20.3 (AUTHORIZATION TOKEN Parameter)
   *
   * draft-ietf-moq-msf-01 §11.4.3: track に関連するトークンは SUBSCRIBE に MUST 付与。
   * SETUP にトークンを載せていても免除されない。
   */
  authorizationToken?: AuthorizationToken;

  /**
   * fill fetch の要求
   * draft-ietf-moq-transport-21 Section 3.4 (Fill Semantics) /
   * Section 9.20.16 (FILL PARAMETERS Parameter)
   *
   * FILL_PARAMETERS (0x23) として送信し、live 手前の範囲を fill fetch
   * ストリームで取得する。対向が開いた fill fetch ストリームは購読に紐付けて
   * 受信する。fill 経由のオブジェクトは fillDelivered を true にして渡すため、
   * subscription 経由と区別できる。各 Object を一度だけ受け取りたい場合は、
   * Next Object の subscription (StartGroup = 0 かつ StartObject = 0) と
   * open-ended な fill を組み合わせる (publisher が fill を Largest Object で
   * 終えるため重複なくつながる。§3.4 の exactly-once パターン)。
   */
  fill?: FillRequestOptions;

  /**
   * Track Properties の受信要求
   * draft-ietf-moq-transport-21 Section 9.20.22 (INCLUDE_PROPERTIES Parameter)
   *
   * true (1) は応答に Track Properties を載せるよう要求し、
   * false (0) は空にするよう要求する。省略時はパラメータ自体を送らず、
   * 対向のデフォルト (1 と同等) に従う。
   */
  includeProperties?: boolean;
}

/**
 * SUBSCRIBE_TRACKS のオプション
 * draft-ietf-moq-transport-21 Section 9.18.1 (Parameters on SUBSCRIBE_TRACKS)
 *
 * SUBSCRIBE のパラメータのうち SUBSCRIBE_TRACKS で有効なもののサブセット。
 */
export interface SubscribeTracksOptions {
  /**
   * Group Order
   * draft-ietf-moq-transport-21 Section 9.20.9 (GROUP ORDER Parameter)
   */
  groupOrder?: "Ascending" | "Descending";

  /**
   * Forward State
   * draft-ietf-moq-transport-21 Section 9.20.19 (FORWARD Parameter)
   *
   * 省略した場合は 1（転送する）がデフォルト。
   * 明示的に false のときだけワイヤに FORWARD=0 を載せる。
   */
  forward?: boolean;

  /**
   * Range Filters
   * draft-ietf-moq-transport-21 Section 3.3.2 (Range Filters)
   *
   * ピアの MAX_FILTER_RANGES が 0（未広告含む）の場合に指定すると throw する。
   */
  rangeFilters?: RangeFilterSpec[];

  /**
   * Track Properties の受信要求
   * draft-ietf-moq-transport-21 Section 9.20.22 (INCLUDE_PROPERTIES Parameter)
   *
   * true (1) は結果 PUBLISH に Track Properties を載せるよう要求し、
   * false (0) は空にするよう要求する。省略時は送らない (デフォルト 1 と同等)。
   */
  includeProperties?: boolean;

  /**
   * Subscriber Priority
   * draft-ietf-moq-transport-21 Section 9.20.8 (SUBSCRIBER PRIORITY Parameter)
   *
   * 結果 PUBLISH の初期 Subscription Parameter になる (0-255、小さいほど高優先)。
   * 省略時は送らない。
   */
  subscriberPriority?: number;

  /**
   * Location Filter
   * draft-ietf-moq-transport-21 Section 9.18.1 (Parameters on SUBSCRIBE_TRACKS):
   * "To join Tracks initiated via the resulting PUBLISHes, the subscriber can
   *  specify a Location Filter and optionally include FILL_PARAMETERS, as
   *  described in Section 3.5."
   *
   * 結果 PUBLISH の初期 Location Filter になる。
   */
  filter?: LocationFilter;

  /**
   * Fill Parameters
   * draft-ietf-moq-transport-21 Section 9.20.16 (FILL_PARAMETERS Parameter)
   *
   * 結果 PUBLISH の購読で fill fetch を要求する。省略時は送らない。
   */
  fill?: FillRequestOptions;

  /**
   * 認可トークン
   * draft-ietf-moq-transport-21 Section 9.20.3 (AUTHORIZATION TOKEN Parameter)
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
  end?: () => void;
  error?: (error: Error) => void;
  /**
   * リクエストストリーム上で GOAWAY を受信した時のコールバック
   * draft-ietf-moq-transport-21 Section 9.2 (GOAWAY):
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
   * draft-ietf-moq-transport-21 Section 9.20.6 (FILL TIMEOUT Parameter)
   *
   * relay が欠損 object の fill 待機に費やす最大時間。
   * 0 は即座に利用可能な object のみを要求。
   */
  fillTimeout?: bigint;

  /**
   * Subscriber Priority
   * draft-ietf-moq-transport-21 Section 9.20.9 (SUBSCRIBER PRIORITY Parameter)
   *
   * FETCH 応答の優先度 (0-255、小さいほど高優先)。
   * "It MAY appear in a SUBSCRIBE, PUBLISH, FETCH, or REQUEST_UPDATE"。
   * 省略時は送らない (受信側は既定値として扱う)。
   */
  subscriberPriority?: number;

  /**
   * Group Order
   * draft-ietf-moq-transport-21 Section 9.20.9 (GROUP ORDER Parameter)
   *
   * FETCH 応答で Object を Group 順に並べる順序を要求する。
   * "It MAY appear in a SUBSCRIBE, PUBLISH, SUBSCRIBE_TRACKS, or FETCH"。
   * 省略時は送らない (FETCH_OK に出現できるパラメータではないため、
   * 応答でエコーされることはない)。
   */
  groupOrder?: "Ascending" | "Descending";

  /**
   * Location Filter
   * draft-ietf-moq-transport-21 Section 3.3.1 / Section 9.20.10
   *
   * 取得する範囲を指定する。フィールドの有無で意味が変わる (Length
   * ベースのワイヤに対応、§9.20.10):
   * - { startGroup }: 相対指定。Start Group = LARGEST_OBJECT の Group + 1 - startGroup
   * - { startGroup, startObject }: 絶対開始。両方 0 は Next Object
   * - { startGroup, startObject, endGroupDelta }: 絶対範囲。End Group =
   *   StartGroup + endGroupDelta が 2^64-1 を超えると送信前に
   *   InvalidFilterError で throw する（§9.20.10 は超過時に PROTOCOL_VIOLATION
   *   を要求するため、ワイヤに載せる前にローカルで拒否する）
   * - { startGroup, startObject, endGroupDelta, endObject }: 絶対範囲 +
   *   End Object
   * - { reset: true }: Length 0 (フィルタなし。FETCH では省略と等価)
   *
   * 指定しない場合、フィルタなしとして {0, 0} から Largest Object までの
   * 全オブジェクトを要求する (§9.20.10。Fetch では End Group / End Object を
   * 省略した場合の終端が Largest Object になる)。
   */
  filter?: LocationFilter;

  /**
   * Range Filters
   * draft-ietf-moq-transport-21 Section 3.3.2 (Range Filters)
   *
   * ピアの MAX_FILTER_RANGES が 0 (未広告含む) の場合に指定すると throw する。
   */
  rangeFilters?: RangeFilterSpec[];

  /**
   * AUTHORIZATION_TOKEN Message Parameter (0x03) として送信する Authorization Token
   * draft-ietf-moq-transport-21 Section 9.20.3 (AUTHORIZATION TOKEN Parameter)
   *
   * draft-ietf-moq-msf-01 §11.4.3: track に関連するトークンは FETCH に MUST 付与。
   */
  authorizationToken?: AuthorizationToken;

  /**
   * Track Properties の受信要求
   * draft-ietf-moq-transport-21 Section 9.20.22 (INCLUDE_PROPERTIES Parameter)
   *
   * true (1) は応答に Track Properties を載せるよう要求し、
   * false (0) は空にするよう要求する。省略時は送らない (デフォルト 1 と同等)。
   */
  includeProperties?: boolean;
}

/**
 * TRACK_STATUS のオプション
 * draft-ietf-moq-transport-21 Section 9.20.22 (INCLUDE_PROPERTIES Parameter)
 */
export interface TrackStatusOptions {
  /**
   * Track Properties の受信要求
   * draft-ietf-moq-transport-21 Section 9.20.22 (INCLUDE_PROPERTIES Parameter)
   *
   * true (1) は応答に Track Properties を載せるよう要求し、
   * false (0) は空にするよう要求する。省略時は送らない (デフォルト 1 と同等)。
   */
  includeProperties?: boolean;

  /**
   * 認可トークン
   * draft-ietf-moq-transport-21 Section 9.20.3 (AUTHORIZATION TOKEN Parameter)
   *
   * "It MAY appear in a PUBLISH, SUBSCRIBE, REQUEST_UPDATE, SUBSCRIBE_NAMESPACE,
   *  SUBSCRIBE_TRACKS, PUBLISH_NAMESPACE, TRACK_STATUS or FETCH message."
   * 省略時は送らない。
   */
  authorizationToken?: AuthorizationToken;
}

/**
 * TRACK_STATUS の結果
 * draft-ietf-moq-transport-21 Section 9.13 (TRACK_STATUS)
 */
export interface TrackStatusResult {
  /**
   * 応答パラメータ（SUBSCRIBE_OK と同様）
   */
  parameters: Parameter[];
}

/**
 * Namespace サブスクリプションのコールバック
 *
 * draft-ietf-moq-transport-21 §9.15 (SUBSCRIBE_NAMESPACE):
 * SUBSCRIBE_NAMESPACE への応答として、NAMESPACE / NAMESPACE_DONE が送信される。
 * draft-18 で旧 SUBSCRIBE_NAMESPACE (0x11) が SUBSCRIBE_NAMESPACE (0x50) と
 * SUBSCRIBE_TRACKS (0x51) に分割され、PUBLISH_SKIPPED は SUBSCRIBE_TRACKS 応答に移動した。
 */
export interface NamespaceSubscriptionCallbacks {
  /**
   * NAMESPACE を受信したときに呼ばれる
   * draft-ietf-moq-transport-21 §9.16 (NAMESPACE)
   *
   * @param namespaceSuffix - Track Namespace Prefix を除いた Suffix
   */
  onNamespace?: (namespaceSuffix: string[]) => void;
  /**
   * NAMESPACE_DONE を受信したときに呼ばれる
   * draft-ietf-moq-transport-21 §9.17 (NAMESPACE_DONE)
   *
   * @param namespaceSuffix - Track Namespace Prefix を除いた Suffix
   */
  onNamespaceDone?: (namespaceSuffix: string[]) => void;
  /**
   * エラー時のコールバック
   */
  error?: (error: Error) => void;
  /**
   * GOAWAY 受信時に呼ばれる
   * draft-ietf-moq-transport-21 §9.2 (GOAWAY):
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
 * draft-ietf-moq-transport-21 §9.5.2 (Updating Namespace Subscriptions):
 * REQUEST_UPDATE に TRACK_NAMESPACE_PREFIX パラメータ (0x34) を含めて
 * 確立済みの SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS の Track Namespace Prefix を
 * 更新する。
 */
export interface NamespaceUpdateOptions {
  /**
   * 更新後の Track Namespace Prefix
   * draft-ietf-moq-transport-21 §9.20.21 (TRACK_NAMESPACE_PREFIX Parameter)
   */
  trackNamespacePrefix: string[];
}

/**
 * Tracks 更新のオプション
 * draft-ietf-moq-transport-21 §9.20.19 (FORWARD Parameter):
 * SUBSCRIBE_TRACKS の REQUEST_UPDATE に FORWARD が許可された。
 * FORWARD は prefix に一致する将来の購読の Forwarding State を指定し、
 * 既存購読には影響しない。省略時は不変。
 */
export interface TracksUpdateOptions extends NamespaceUpdateOptions {
  /**
   * 将来の購読の Forward State
   * draft-ietf-moq-transport-21 §9.20.19 (FORWARD Parameter)
   *
   * true (1) / false (0) を明示送信する。省略時は不変。
   * SUBSCRIBE_NAMESPACE 向け REQUEST_UPDATE では許可されないため、
   * NamespaceSubscription.update には露出させない。
   */
  forward?: boolean;
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
   * draft-ietf-moq-transport-21 §9.5.2 (Updating Namespace Subscriptions):
   * REQUEST_OK 受信で resolve、REQUEST_ERROR (PREFIX_OVERLAP 等) / ストリーム
   * クローズで reject する。
   *
   * 以下の場合はローカル検証として throw する:
   * - サブスクリプションが active でない
   * - GOAWAY 受信後 (ストリーム移行中)
   * - ピアの MAX_REQUEST_UPDATES を超える送信
   * - 前の更新が in-flight (REQUEST_OK 未受信) のうちの 2 件目
   *   (前の update() の settle を待ってから呼ぶこと)
   * - 予約 namespace / .session への更新
   * - 同一型のアクティブなサブスクリプション (更新対象自身を除く) と
   *   共通 prefix を持つ更新
   *
   * @param options - 更新内容 (TRACK_NAMESPACE_PREFIX)
   */
  update(options: NamespaceUpdateOptions): Promise<void>;
}

/**
 * Tracks サブスクリプションのコールバック
 *
 * draft-ietf-moq-transport-21 §9.18 (SUBSCRIBE_TRACKS):
 * SUBSCRIBE_TRACKS への応答として PUBLISH メッセージが新規双方向ストリームで
 * 送信される。応答ストリームでは PUBLISH_SKIPPED が送られる。
 */
export interface TracksSubscriptionCallbacks {
  /**
   * サーバーから PUBLISH メッセージを受信したときに呼ばれる
   * draft-ietf-moq-transport-21 §9.18 / §9.8
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
   * draft-ietf-moq-transport-21 §9.19 (PUBLISH_SKIPPED):
   *
   * > The publisher sends the PUBLISH_SKIPPED control message to indicate
   * > it cannot send a PUBLISH message to initiate a new Subscription for a
   * > Track in the SUBSCRIBE_TRACKS's Track Namespace.
   *
   * @param namespaceSuffix - Track Namespace Prefix を除いた Suffix
   * @param trackName - 確立できなかった Subscription の Track Name
   */
  onPublishSkipped?: (namespaceSuffix: string[], trackName: string) => void;
  /**
   * エラー時のコールバック
   */
  error?: (error: Error) => void;
  /**
   * GOAWAY 受信時に呼ばれる
   * draft-ietf-moq-transport-21 §9.2 (GOAWAY):
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
 * draft-ietf-moq-transport-21 §9.18 (SUBSCRIBE_TRACKS)
 */
export interface TracksSubscription {
  readonly state: "active" | "closed";
  /**
   * サブスクリプションを解除する
   */
  unsubscribe(): Promise<void>;
  /**
   * Track Namespace Prefix と Forward State を更新する (REQUEST_UPDATE を送信)
   *
   * draft-ietf-moq-transport-21 §9.5.2 (Updating Namespace Subscriptions):
   * "Updating the prefix of a SUBSCRIBE_TRACKS has no effect on existing
   *  subscriptions." (既存の確立済み SubscriberImpl には影響しない)
   * draft-ietf-moq-transport-21 §9.20.19 (FORWARD Parameter):
   * SUBSCRIBE_TRACKS の REQUEST_UPDATE に FORWARD が許可された。
   * 将来の購読の Forwarding State を指定し、既存購読には影響しない。
   *
   * REQUEST_OK 受信で resolve、REQUEST_ERROR (PREFIX_OVERLAP 等) / ストリーム
   * クローズで reject する。
   *
   * 以下の場合はローカル検証として throw する:
   * - サブスクリプションが active でない
   * - GOAWAY 受信後 (ストリーム移行中)
   * - ピアの MAX_REQUEST_UPDATES を超える送信
   * - 前の更新が in-flight (REQUEST_OK 未受信) のうちの 2 件目
   *   (前の update() の settle を待ってから呼ぶこと)
   * - 予約 namespace / .session への更新
   * - 同一型のアクティブなサブスクリプション (更新対象自身を除く) と
   *   共通 prefix を持つ更新
   *
   * @param options - 更新内容 (TRACK_NAMESPACE_PREFIX + FORWARD)
   */
  update(options: TracksUpdateOptions): Promise<void>;
}

/**
 * Namespace 公開のコールバック
 * draft-ietf-moq-transport-21 Section 9.14 (PUBLISH_NAMESPACE)
 */
export interface NamespacePublicationCallbacks {
  /**
   * エラー時のコールバック
   */
  error?: (error: Error) => void;
  /**
   * GOAWAY 受信時に呼ばれる
   * draft-ietf-moq-transport-21 §9.2 (GOAWAY):
   * リクエストストリーム上の GOAWAY は当該リクエストの
   * マイグレーションのみを目的とする。
   *
   * @param newSessionUri - 新しいセッション URI
   */
  goaway?: (newSessionUri: string) => void;
}

/**
 * Namespace 公開のオプション
 * draft-ietf-moq-transport-21 Section 9.14 (PUBLISH_NAMESPACE)
 */
export interface PublishNamespaceOptions {
  /**
   * 認可トークン
   * draft-ietf-moq-transport-21 Section 9.20.3 (AUTHORIZATION TOKEN Parameter)
   *
   * "It MAY appear in a PUBLISH, SUBSCRIBE, REQUEST_UPDATE, SUBSCRIBE_NAMESPACE,
   *  SUBSCRIBE_TRACKS, PUBLISH_NAMESPACE, TRACK_STATUS or FETCH message."
   * 省略時は送らない。
   */
  authorizationToken?: AuthorizationToken;
}

/**
 * Namespace 公開
 * draft-ietf-moq-transport-21 Section 9.14 (PUBLISH_NAMESPACE)
 */
export interface NamespacePublication {
  readonly state: "active" | "closed";
  /**
   * 公開している Namespace
   */
  readonly namespace: string[];
  /**
   * 公開を終了する
   * draft-ietf-moq-transport-21: ストリームの close で終了を通知する。
   */
  done(): Promise<void>;
}

export interface Session {
  readonly state: SessionState;
  /**
   * 下位 WebTransport の `reliability` をそのまま返す
   * W3C WebTransport spec: https://www.w3.org/TR/webtransport/#dom-webtransport-reliability
   *
   * - "pending": セッション未確立
   * - "reliable-only": HTTP/2 系 (datagram 不可)
   * - "supports-unreliable": HTTP/3 系 (datagram 可)
   *
   * draft-ietf-webtrans-http2 と draft-ietf-webtrans-http3 のどちらで接続しているか
   * を判別する指標として利用する。
   */
  readonly reliability: string;
  /**
   * GOAWAY を受信したかどうか
   * draft-ietf-moq-transport-21 Section 9.2 (GOAWAY)
   */
  readonly goawayReceived: boolean;
  /**
   * 接続時に渡された moqt URI の Fragment Identifier
   *
   * draft-ietf-moq-transport-21 §6.1.1:
   *
   * > Fragment identifiers MAY be used with moqt URIs.  The fragment is not
   * > transmitted to the server; it is processed locally by the client
   * > after establishing the MOQT session.
   *
   * fragment が指定されなかった場合は `null`
   */
  readonly fragment: MoqtFragment | null;
  publish(
    namespace: string[],
    trackName: string,
    callbacks?: PublishCallbacks,
    options?: PublishOptions,
  ): Promise<Publisher>;
  subscribe(
    namespace: string[],
    trackName: string,
    callbacks: SubscribeCallbacks,
    options?: SubscribeOptions,
  ): Promise<Subscriber>;
  /**
   * 過去のデータを取得する
   * draft-ietf-moq-transport-21 Section 9.11 (FETCH)
   */
  fetch(
    namespace: string[],
    trackName: string,
    options: FetchOptions,
    callbacks: FetchCallbacks,
  ): Promise<Fetcher>;
  /**
   * トラックの状態を問い合わせる
   * draft-ietf-moq-transport-21 Section 9.13 (TRACK_STATUS)
   */
  trackStatus(
    namespace: string[],
    trackName: string,
    options?: TrackStatusOptions,
  ): Promise<TrackStatusResult>;
  /**
   * Namespace をサブスクライブする（namespace discovery 用）
   *
   * draft-ietf-moq-transport-21 §9.15 (SUBSCRIBE_NAMESPACE):
   * SUBSCRIBE_NAMESPACE は新しい双方向ストリームで送信される。
   * 応答として NAMESPACE / NAMESPACE_DONE が送られる。
   *
   * @param namespacePrefix - Track Namespace Prefix
   * @param callbacks - コールバック関数
   * @param options - オプション（authorizationToken: draft-ietf-moq-msf-01 §11.4.3 により SUBSCRIBE_NAMESPACE に MUST 付与）
   */
  subscribeNamespace(
    namespacePrefix: string[],
    callbacks: NamespaceSubscriptionCallbacks,
    options?: { authorizationToken?: AuthorizationToken },
  ): Promise<NamespaceSubscription>;
  /**
   * Track をサブスクライブする（track subscription 用）
   *
   * draft-ietf-moq-transport-21 §9.18 (SUBSCRIBE_TRACKS):
   * SUBSCRIBE_TRACKS は新しい双方向ストリームで送信される。
   * Publisher はマッチするネームスペース内のトラックに対して PUBLISH メッセージを
   * 別の新規双方向ストリームで送信する。応答ストリーム上では PUBLISH_SKIPPED が
   * 送られる場合がある。
   *
   * @param namespacePrefix - Track Namespace Prefix
   * @param callbacks - コールバック関数
   * @param options - サブスクリプションパラメータ（groupOrder / forward）
   */
  subscribeTracks(
    namespacePrefix: string[],
    callbacks: TracksSubscriptionCallbacks,
    options?: SubscribeTracksOptions,
  ): Promise<TracksSubscription>;
  /**
   * Namespace を公開する（トラック発見用）
   * draft-ietf-moq-transport-21 Section 9.14 (PUBLISH_NAMESPACE)
   *
   * Publisher が Track Namespace 内にトラックがあることを通知する。
   * Subscriber は SUBSCRIBE_NAMESPACE でこの通知を受け取れる。
   */
  publishNamespace(
    namespace: string[],
    callbacks?: NamespacePublicationCallbacks,
    options?: PublishNamespaceOptions,
  ): Promise<NamespacePublication>;
  /**
   * GOAWAY を送信してセッション終了を通知する
   * draft-ietf-moq-transport-21 Section 9.2 (GOAWAY)
   * @param newSessionUri - 新しいセッション URI（オプション）
   * @param timeout - Graceful shutdown のタイムアウト（ミリ秒、オプション）
   */
  goaway(newSessionUri?: string, timeout?: bigint): Promise<void>;
  close(): Promise<void>;
  /**
   * セッションレベルの統計情報を取得する
   */
  getStatistics(): SessionStatistics;
}

/**
 * Location Filter をデバッグログ用の文字列に要約する
 */
function describeLocationFilter(filter: LocationFilter | undefined): string | undefined {
  if (filter === undefined) {
    return undefined;
  }
  if ("reset" in filter) {
    return "reset";
  }
  const entries: string[] = [`startGroup=${filter.startGroup}`];
  if ("startObject" in filter) {
    entries.push(`startObject=${filter.startObject}`);
  }
  if ("endGroupDelta" in filter) {
    entries.push(`endGroupDelta=${filter.endGroupDelta}`);
  }
  if ("endObject" in filter) {
    entries.push(`endObject=${filter.endObject}`);
  }
  return entries.join(", ");
}

/**
 * 読み取り済みの先頭バイト列をストリームの先頭に戻す
 *
 * initialize() が制御ストリームを探すためにデータストリームの先頭
 * (ストリームタイプ varint を含む) を消費する。SETUP 完了後に
 * handleIncomingStream が通常のストリームとして処理できるよう、
 * 消費済みバイトを先頭に持つ ReadableStream を作り直す
 * (draft-ietf-moq-transport-21 §6.3 のデータストリーム先着バッファリング)。
 */
function prependBytesToStream(
  prefix: Uint8Array,
  source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let prefixSent = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!prefixSent) {
        prefixSent = true;
        if (prefix.byteLength > 0) {
          controller.enqueue(prefix);
        }
        return;
      }
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      if (value) {
        controller.enqueue(value);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * SETUP で広告する MAX_REQUEST_UPDATES の保持値を解決する
 *
 * draft-ietf-moq-transport-21 §9.1.7:
 * 未広告 (undefined) は 0 (無制限) として扱う。§9.1.6 の MAX_FILTER_RANGES の
 * 0 が「Range Filter 受信拒否」なのとは意味が逆である。
 */
function resolveLocalMaxRequestUpdates(options?: { maxRequestUpdates?: number }): number {
  return options?.maxRequestUpdates ?? 0;
}

/**
 * 内部セッション実装
 */
export class SessionImpl implements Session {
  private sessionState: SessionState = "connected";
  private readonly transport: WebTransport;
  private readonly callbacks: ConnectCallbacks;
  // draft-ietf-moq-transport-21 §6.1.1 (Fragment Identifiers)
  private readonly sessionFragment: MoqtFragment | null;
  /**
   * draft-ietf-moq-transport-21 Section 1.5 (Extensibility):
   * 制御ストリームは単方向ストリームのペアに変更された。
   * クライアントとサーバーがそれぞれ 1 本ずつ単方向ストリームを開く。
   * draft-ietf-moq-transport-21 Section 1.5
   */
  private controlSendStream?: WritableStream<Uint8Array>;
  controlReceiveStream?: ReadableStream<Uint8Array>;
  private controlReader?: ControlStreamReader;
  private controlWriter?: ControlStreamWriter;

  // datagram 送信用 writer。保持して使い回す理由は getDatagramWriter を参照。
  // close() 時に明示的に undefined を代入して解放するため `| undefined` を付ける
  datagramWriter?: WritableStreamDefaultWriter<Uint8Array> | undefined;

  // 受信双方向ストリームの reader。
  // draft-ietf-moq-transport-21 §9.18: SUBSCRIBE_TRACKS への応答として
  // サーバーが新規双方向ストリームを開き PUBLISH を送信する。
  // この reader で incomingBidirectionalStreams を監視する。
  // close() 時に明示的に undefined を代入して解放するため `| undefined` を付ける
  incomingBidiStreamReader?:
    | ReadableStreamDefaultReader<WebTransportBidirectionalStream>
    | undefined;

  // リクエスト ID 管理
  private nextRequestId = 0n;
  private nextTrackAlias = 0n;

  // GOAWAY 状態
  private receivedGoaway = false;
  // リクエストストリームごとの GOAWAY 受信済みフラグ
  // draft-ietf-moq-transport-21 §9.2 (GOAWAY):
  // 単一リクエストストリーム上の重複 GOAWAY は PROTOCOL_VIOLATION
  private goawayReceivedOnRequestStreams = new Set<bigint>();
  // pending の無い REQUEST_OK を許容する枠 (coalescing された REQUEST_ERROR で
  // pending を消した件数)。詳細は BidiSessionInternal の同名フィールドの doc を参照
  unmatchedRequestOkAllowances = new Map<bigint, number>();
  // 受信済み Request ID の追跡 (重複検出用)
  // draft-ietf-moq-transport-21 §6.4.2.1:
  // 重複 Request ID の受信は INVALID_REQUEST_ID でセッションを閉じる。
  // Set には add のみ行い、リクエスト完了後も削除しない (セッション内での
  // 再出現の禁止のため)。セッションクローズ時にクリアする。
  private receivedRequestIds = new Set<bigint>();
  /**
   * リクエストストリームごとの未応答 REQUEST_UPDATE 数
   *
   * draft-ietf-moq-transport-21 §9.1.7 (MAX_REQUEST_UPDATES):
   * 受信した REQUEST_UPDATE をストリーム単位で数え、自 endpoint が SETUP で
   * 広告した上限を超えたら TOO_MANY_REQUEST_UPDATES でセッションを閉じる。
   * キーは受信ループが持つ request stream の Request ID である。§6.4.2.1 により
   * REQUEST_UPDATE 自身の Request ID は更新ごとに新規 ID を消費して対象リクエストを
   * 識別しないため、メッセージの Request ID はキーに使わない。
   * 加算は 1 通の受信時、減算は 1 回の read で得たメッセージ列の処理を終えた
   * 時点で行う (減算の単位を応答 1 通にすると、応答の書き込みを await してから
   * 次のメッセージへ進む受信ループでは未応答数が常に 0 か 1 にしかならない)。
   * ストリーム終了時にエントリを削除し、セッション終了時に clear する。
   */
  receivedRequestUpdateCounts = new Map<bigint, number>();
  sentGoaway = false;
  goawayTimeoutId: ReturnType<typeof setTimeout> | null = null;
  // draft-ietf-moq-transport-21 §9.1.7: ピアの MAX_REQUEST_UPDATES（0 = 無制限）
  peerMaxRequestUpdates = 0;
  // draft-ietf-moq-transport-21 §9.1.6: ピアの MAX_FILTER_RANGES（0 = Range Filter 送信禁止）
  peerMaxFilterRanges = 0;
  // draft-ietf-moq-transport-21 §9.1.6: 自 endpoint が SETUP で広告した
  // MAX_FILTER_RANGES（未広告時は 0 = Range Filter 受信拒否）
  localMaxFilterRanges = 0;
  // draft-ietf-moq-transport-21 §9.1.3: 自 endpoint が SETUP で広告した
  // MAX_AUTH_TOKEN_CACHE_SIZE（未広告時は 0 = Alias 使用禁止）
  localMaxAuthTokenCacheSize = 0;
  // draft-ietf-moq-transport-21 §9.1.7: 自 endpoint が SETUP で広告した
  // MAX_REQUEST_UPDATES（未広告時は 0 = 無制限。§9.1.6 の MAX_FILTER_RANGES の
  // 0 が「Range Filter 受信拒否」なのとは意味が逆である）
  localMaxRequestUpdates = 0;
  /**
   * ピアが REGISTER した Authorization Token のキャッシュ
   *
   * draft-ietf-moq-transport-21 §8.9 (Authorization Token Compression):
   * Alias 空間は送信元ごとに独立するため、ピアが登録した Alias だけを保持する。
   * 上限は自 endpoint が SETUP で広告した MAX_AUTH_TOKEN_CACHE_SIZE (§9.1.3)。
   */
  receivedAuthTokens = new AuthTokenCache(0);
  // draft-ietf-moq-transport-21 §13 (Grease): true のとき Track / Object Properties に
  // GREASE Property を 1 つ注入する。initialize() で ConnectOptions.grease を受け渡す。
  grease = false;

  // アクティブなパブリッシャー、サブスクライバー、フェッチャー
  publishers = new Map<bigint, PublisherImpl>();
  private subscribers = new Map<bigint, SubscriberImpl>();
  private subscribersByAlias = new Map<bigint, SubscriberImpl[]>();
  private fetchers = new Map<bigint, FetcherImpl>();

  // Subscriber 登録前に到着した Subgroup ストリームをバッファリング
  // draft-ietf-moq-transport-21 §11.3.1:
  // "MAY ... choose to buffer it for a brief period to handle reordering with the
  //  control message that establishes the Track Alias."
  // QUIC ではストリーム間の順序が保証されないため、SUBSCRIBE_OK より先にデータストリームが
  // 到着する可能性があり、それを buffer して reordering を吸収する
  // 上限・タイムアウトは ConnectOptions.pendingSubgroup でユーザーから指定可能
  private readonly pendingSubgroupBuffer: PendingSubgroupBuffer;

  // Fetcher 登録待ちの Promise を管理
  // draft-ietf-moq-transport-21 Section 9.12 (FETCH_OK):
  // "A publisher MAY send Objects in response to a FETCH before the
  //  FETCH_OK message is sent."
  // FETCH_OK より先にデータストリームが到着する可能性がある
  fetcherReadyCallbacks = new Map<bigint, Array<() => void>>();

  // fill 要求元の Request ID から購読への関連付け
  // draft-ietf-moq-transport-21 §3.4 (Fill Semantics):
  // fill fetch ストリームの FETCH_HEADER が運ぶ Request ID で引く。
  private fillFetchTargets = new Map<bigint, bidi.FillFetchTarget>();

  // リクエストごとの双方向ストリーム管理
  // draft-ietf-moq-transport-21 Section 6.3:
  // リクエストは双方向ストリーム上で送受信される。
  // draft-ietf-moq-transport-21 Section 6.3
  private requestStreams = new Map<
    bigint,
    {
      stream: WebTransportBidirectionalStream;
      writer: WritableStreamDefaultWriter<Uint8Array>;
      controlReader: ControlStreamReader;
      // 読み取りループが保持中の reader (解除時に保持者経由で cancel するため。
      // bidi 側の RequestStreamInfo と同形)。
      reader?: ReadableStreamDefaultReader<Uint8Array>;
    }
  >();

  // 保留中のリクエスト
  private pendingPublish = new Map<
    bigint,
    {
      resolve: (pub: Publisher) => void;
      reject: (err: Error) => void;
      impl: PublisherImpl;
    }
  >();
  private pendingSubscribe = new Map<
    bigint,
    {
      resolve: (sub: Subscriber) => void;
      reject: (err: Error) => void;
      impl: SubscriberImpl;
      objectCallback: (object: MoqtObject) => void;
    }
  >();
  pendingRequestUpdate = new Map<
    bigint,
    { resolve: () => void; reject: (err: Error) => void; targetRequestId: bigint }
  >();
  private pendingFetch = new Map<
    bigint,
    {
      resolve: (fetcher: Fetcher) => void;
      reject: (err: Error) => void;
      impl: FetcherImpl;
      startLocation?: Location;
    }
  >();
  // 型は bidi.PendingTrackStatus に集約する (trackKey の追加が片側だけにならないようにする)
  private pendingTrackStatus = new Map<bigint, bidi.PendingTrackStatus>();
  /**
   * SUBSCRIBE_NAMESPACE の状態管理
   *
   * draft-ietf-moq-transport-21 §9.15 (SUBSCRIBE_NAMESPACE):
   * SUBSCRIBE_NAMESPACE は専用の双方向ストリームで送受信される。
   * 応答として NAMESPACE / NAMESPACE_DONE のみが送られる。
   */
  private namespaceSubscriptions = new Map<
    bigint,
    {
      callbacks: NamespaceSubscriptionCallbacks;
      state: "active" | "closed";
      namespacePrefix: string[];
      // セッション内部の状態オブジェクトで、解放時に明示的に undefined を代入するため `| undefined` を付ける
      pendingPrefix?: string[] | undefined;
      stream?: WebTransportBidirectionalStream | undefined;
      streamReader?: ReadableStreamDefaultReader<Uint8Array> | undefined;
      controlReader?: ControlStreamReader | undefined;
      writer?: WritableStreamDefaultWriter<Uint8Array> | undefined;
    }
  >();
  /**
   * SUBSCRIBE_TRACKS の状態管理
   *
   * draft-ietf-moq-transport-21 §9.18 (SUBSCRIBE_TRACKS):
   * SUBSCRIBE_TRACKS は SUBSCRIBE_NAMESPACE とは別の専用の双方向ストリームで
   * 送受信される。応答ストリーム上では PUBLISH_SKIPPED が送られる。PUBLISH は
   * 別の新規双方向ストリームで到着する。
   */
  private tracksSubscriptions = new Map<
    bigint,
    {
      callbacks: TracksSubscriptionCallbacks;
      state: "active" | "closed";
      namespacePrefix: string[];
      // セッション内部の状態オブジェクトで、解放時に明示的に undefined を代入するため `| undefined` を付ける
      rangeFilters?: RangeFilterSpec[] | undefined;
      pendingPrefix?: string[] | undefined;
      stream?: WebTransportBidirectionalStream | undefined;
      streamReader?: ReadableStreamDefaultReader<Uint8Array> | undefined;
      controlReader?: ControlStreamReader | undefined;
      writer?: WritableStreamDefaultWriter<Uint8Array> | undefined;
    }
  >();
  /**
   * PUBLISH_NAMESPACE の状態管理
   *
   * draft-ietf-moq-transport-21 Section 9.14 (PUBLISH_NAMESPACE):
   * PUBLISH_NAMESPACE は新しい双方向ストリームの先頭メッセージとして送信される。
   * REQUEST_OK / REQUEST_ERROR が同じ双方向ストリームで応答される。
   * https://www.ietf.org/archive/id/draft-ietf-moq-transport-21.html#section-9.14
   */
  private namespacePublications = new Map<
    bigint,
    {
      // セッション内部の状態オブジェクトで、callbacks 未指定時に undefined を保持するため `| undefined` を付ける
      callbacks?: NamespacePublicationCallbacks | undefined;
      state: "pending" | "active" | "closed";
      namespace: string[];
      stream: WebTransportBidirectionalStream;
      streamReader: ReadableStreamDefaultReader<Uint8Array>;
      controlReader: ControlStreamReader;
      writer: WritableStreamDefaultWriter<Uint8Array>;
    }
  >();

  // Publisher ごとのストリーム状態
  // draft-ietf-moq-transport-21 Section 2.2:
  // "Objects in a subgroup ... are sent on a single stream whenever possible."
  private publisherStreams = new Map<bigint, PublisherStreamState>();

  // Publisher ごとの送信キュー
  // sendObject は async だが fire-and-forget で呼ばれるため、
  // 同一トラック内で並行実行されるとストリームの二重作成が発生する。
  // Promise チェーンでトラック単位のシリアライズを行う。
  publisherSendQueues = new Map<bigint, Promise<void>>();

  // STOP_SENDING / delivery timeout で閉じた Subgroup の追跡
  // draft-ietf-moq-transport-21 §11.3.2 (Closing Subgroup Streams):
  // "A publisher that receives a STOP_SENDING on a Subgroup stream SHOULD NOT
  //  attempt to open a new stream to deliver additional Objects in that Subgroup."
  //
  // 1 Group = 1 Subgroup = 1 Stream モデルでは groupId が subgroupId を一意に決定するため、
  // キーは `${trackAlias}:${groupId}` で十分である。
  // sendObject 時にこの Set をチェックし、閉じた Subgroup への送信を拒否する。
  closedSubgroups = new Set<string>();

  /**
   * Group 単位の END_OF_GROUP 既知最終 Object ID
   *
   * draft-ietf-moq-transport-21 §12.1 条件 4 の検出に使う。キーは
   * `${trackAlias}:${groupId}`。closedSubgroups と同じ粒度で、Subgroup ストリームを
   * またいで「この Group の最終 Object はこれ」という既知情報を保持する。
   */
  private receivedEndOfGroupFinalObjectIds = new Map<string, bigint>();

  /**
   * Track 単位の Prior Group ID Gap / Prior Object ID Gap 追跡
   *
   * draft-ietf-moq-transport-21 §10.8 / §10.9 の malformed 条件のうち、同一 Track
   * の複数 Object と過去の受信状態を必要とする条件の判定に使う。キーは
   * fullTrackNameKey が生成する比較キー。購読単位ではなく Track 単位で保持するのは、
   * 同一 Track の複数購読 / FETCH をまたいで判定する必要があるためである。
   * 購読と FETCH が尽きた Track のエントリは bidi 層が削除し、セッション終了時は
   * close() が全消しする。
   */
  priorGapTrackingByTrack = new Map<FullTrackNameKey, PriorGapTracking>();

  // draft-ietf-moq-transport-21 §12.2:
  // 半端な制御メッセージ / データストリームを保持し続けるピアを打ち切る期限。
  // 0 以下はタイムアウトしない。
  controlMessageTimeoutMs = DEFAULT_CONTROL_MESSAGE_TIMEOUT_MS;
  private dataStreamTimeoutMs = DEFAULT_DATA_STREAM_TIMEOUT_MS;

  // 統計カウンター
  //
  // 各カウンターは受信経路 / 送信経路の free function が加算し、
  // sessionGetStatistics が読む。抽出先から読み書きするため private にはしない。
  statsObjectsReceivedViaFetch = 0;
  statsObjectsReceivedViaFill = 0;
  statsObjectsReceivedViaSubscribe = 0;
  statsBytesReceivedViaFetch = 0;
  statsBytesReceivedViaFill = 0;
  statsBytesReceivedViaSubscribe = 0;
  statsUnidirectionalStreamsOpened = 0;
  statsUnidirectionalStreamsReceived = 0;
  statsSubscriberStreamsActive = 0;
  statsSubgroupHeadersReceived = 0;
  statsFetchHeadersReceived = 0;
  statsControlMessagesSent = 0;
  statsControlMessagesReceived = 0;

  constructor(
    transport: WebTransport,
    callbacks: ConnectCallbacks,
    options: SessionImplOptions = {},
  ) {
    this.transport = transport;
    this.callbacks = callbacks;
    this.pendingSubgroupBuffer = new PendingSubgroupBuffer(options.pendingSubgroup);
    this.sessionFragment = options.fragment ?? null;

    // WebTransport の切断を監視し、close 理由をコールバックに渡す
    // draft-ietf-moq-transport-21 Section 6.6:
    // peer 起点でセッションが閉じた場合、各ストリームの read は reject するが
    // これは正常な終了通知である。read loop の catch 側で正しくスキップできるよう
    // callbacks.close を呼ぶ前に sessionState を遷移させておく。
    // request 系オブジェクトの state も close() と同じく閉じる
    // (markRequestObjectsClosed)。通知 (callbacks.close) は 1 回だけ送る。
    this.transport.closed
      .then((closeInfo) => {
        if (this.sessionState !== "closed") {
          this.sessionState = "closed";
        }
        this.markRequestObjectsClosed();
        // draft-ietf-moq-transport-21 §6.6 / §6.6.1:
        // ピア起点でセッションが閉じた場合も、保留中のリクエスト Promise を
        // reject してアプリを待たせ続けない (自前 close() と同じ後始末)。
        this.rejectPendingRequests(new Error("session closed by peer"));
        // draft-ietf-moq-transport-21 §13 (Grease):
        // 未知の Session Termination コードは INTERNAL_ERROR として扱う
        this.callbacks.close?.({
          ...closeInfo,
          closeCode: normalizeSessionErrorCode(closeInfo.closeCode ?? 0),
        });
      })
      .catch((error: unknown) => {
        if (this.sessionState !== "closed") {
          this.sessionState = "closed";
        }
        this.markRequestObjectsClosed();
        this.rejectPendingRequests(error instanceof Error ? error : new Error(String(error)));
        this.callbacks.close?.({ closeCode: 0, reason: String(error) });
      });
  }

  get state(): SessionState {
    return this.sessionState;
  }

  /**
   * 下位 WebTransport の `reliability` をそのまま返す
   * W3C WebTransport spec: https://www.w3.org/TR/webtransport/#dom-webtransport-reliability
   *
   * - "pending": セッション未確立
   * - "reliable-only": HTTP/2 系 (datagram 不可)
   * - "supports-unreliable": HTTP/3 系 (datagram 可)
   *
   * draft-ietf-webtrans-http2 と draft-ietf-webtrans-http3 のどちらで接続しているか
   * を判別する指標として利用する。
   */
  get reliability(): string {
    const wt = this.transport as unknown as { reliability?: string };
    return wt.reliability ?? "pending";
  }

  get goawayReceived(): boolean {
    return this.receivedGoaway;
  }

  // draft-ietf-moq-transport-21 §6.1.1 (Fragment Identifiers)
  get fragment(): MoqtFragment | null {
    return this.sessionFragment;
  }

  /**
   * セッションを初期化する (WebTransport 接続後に呼ばれる)
   *
   * options に authorizationToken を指定すると、SETUP Option (0x03) として
   * draft-ietf-moq-transport-21 Section 9.1.4 に従い認証トークンを送出する。
   * options に moqtImplementation を指定すると、SETUP Option (0x07) の送信を制御する。
   * options に grease: true を指定すると、SETUP に GREASE Setup Option (§13) を追加する。
   */
  async initialize(options?: {
    authorizationToken?: AuthorizationToken;
    moqtImplementation?: string | false;
    grease?: boolean;
    /**
     * SETUP で広告する MAX_AUTH_TOKEN_CACHE_SIZE (§9.1.3)。
     * 省略時は送信しない (既定値 0)。
     */
    maxAuthTokenCacheSize?: number;
    /**
     * SETUP で広告する MAX_REQUEST_UPDATES (§9.1.7)。
     * 省略時は送信しない (既定値 0 = 無制限)。
     */
    maxRequestUpdates?: number;
    /**
     * SETUP で広告する MAX_FILTER_RANGES (§9.1.6)。
     * 省略時は送信しない (既定値 0 = Range Filter 受信拒否)。
     */
    maxFilterRanges?: number;
    /**
     * 制御メッセージの受信タイムアウト (§12.2 CONTROL_MESSAGE_TIMEOUT)。
     * 0 以下でタイムアウトしない。
     */
    controlMessageTimeoutMs?: number;
    /**
     * データストリームの受信タイムアウト (§12.2 DATA_STREAM_TIMEOUT)。
     * 0 以下でタイムアウトしない。
     */
    dataStreamTimeoutMs?: number;
  }): Promise<void> {
    // draft-ietf-moq-transport-21 Section 1.5 (Extensibility):
    // 制御ストリームは単方向ストリームのペアに変更された。
    // クライアントは送信用単方向ストリームを開き、サーバーの単方向ストリームを受信する。
    // draft-ietf-moq-transport-21 Section 1.5

    this.controlReader = new ControlStreamReader();
    this.controlWriter = new ControlStreamWriter();

    // 送信用単方向ストリームを開く
    this.controlSendStream = await this.transport.createUnidirectionalStream();

    // draft-ietf-moq-transport-21 Section 6.4.1:
    // All unidirectional MOQT streams start with a variable-length integer
    // indicating the type of the stream.
    // 制御ストリームのストリームタイプは 0x2F00 (Table 2)
    const streamTypeBytes = encodeVarint(MessageType.SETUP);

    // SETUP を送信
    // draft-ietf-moq-transport-21 §9.1.1 / §9.1.2:
    // AUTHORITY (0x05) / PATH (0x01) は WebTransport 使用時には MUST NOT 送信。
    // moqt-js は WebTransport 専用クライアントのため `createSetup` には渡さない。
    // grease は SETUP 送信だけでなく、Track / Object Properties への注入にも使うため
    // セッション状態として保持する。
    this.grease = options?.grease === true;
    // draft-ietf-moq-transport-21 §9.1.6 (MAX FILTER RANGES):
    // 自 endpoint が広告する上限を保持し、受信 Range Filter の検証に使う。
    // 未広告 (undefined) の既定値は 0（Range Filter 受信拒否）。
    this.localMaxFilterRanges = options?.maxFilterRanges ?? 0;
    // draft-ietf-moq-transport-21 §12.2:
    // 半端な制御メッセージ / データストリームを保持し続けるピアを打ち切る期限。
    this.applyTimeoutOptions(options);
    // draft-ietf-moq-transport-21 §12.2:
    // 半端な制御メッセージ / データストリームを保持し続けるピアを打ち切る期限。
    this.controlMessageTimeoutMs =
      options?.controlMessageTimeoutMs ?? DEFAULT_CONTROL_MESSAGE_TIMEOUT_MS;
    this.dataStreamTimeoutMs = options?.dataStreamTimeoutMs ?? DEFAULT_DATA_STREAM_TIMEOUT_MS;
    // draft-ietf-moq-transport-21 §9.1.3 (MAX_AUTH_TOKEN_CACHE_SIZE):
    // 自 endpoint が広告する上限を保持し、受信 REGISTER の上限判定に使う。
    // 未広告 (undefined) の既定値は 0（Alias の使用禁止）。
    this.localMaxAuthTokenCacheSize = options?.maxAuthTokenCacheSize ?? 0;
    this.receivedAuthTokens = new AuthTokenCache(this.localMaxAuthTokenCacheSize);
    // draft-ietf-moq-transport-21 §9.1.7 (MAX_REQUEST_UPDATES):
    // 自 endpoint が広告する上限を保持し、受信 REQUEST_UPDATE の未応答数の
    // 上限判定に使う。未広告 (undefined) の既定値は 0（無制限）。
    // §9.1.6 の MAX_FILTER_RANGES の 0 = 受信拒否とは意味が逆であるため、
    // 受信側のガードでも 0 を拒否として扱わない。
    this.localMaxRequestUpdates = resolveLocalMaxRequestUpdates(options);
    // exactOptionalPropertyTypes では optional なフィールドに undefined を渡せないため、
    // 値がある場合だけ載せた object を組み立てる (createSetup の型は公開 API のため広げない)
    const setup = createSetup({
      ...(options?.authorizationToken !== undefined
        ? { authorizationToken: options.authorizationToken }
        : {}),
      ...(options?.moqtImplementation !== undefined
        ? { moqtImplementation: options.moqtImplementation }
        : {}),
      ...(options?.grease !== undefined ? { grease: options.grease } : {}),
      ...(options?.maxAuthTokenCacheSize !== undefined
        ? { maxAuthTokenCacheSize: options.maxAuthTokenCacheSize }
        : {}),
      ...(options?.maxRequestUpdates !== undefined
        ? { maxRequestUpdates: options.maxRequestUpdates }
        : {}),
      ...(options?.maxFilterRanges !== undefined
        ? { maxFilterRanges: options.maxFilterRanges }
        : {}),
    });
    const setupPayload = encodeSetupPayload(setup);
    const setupMessage = this.controlWriter.encode(MessageType.SETUP, setupPayload);

    this.emitDebug("send", MessageType.SETUP, setupPayload, {});

    const writer = this.controlSendStream.getWriter();
    await writer.write(streamTypeBytes);
    await writer.write(setupMessage);
    writer.releaseLock();

    // サーバーからの単方向ストリームを受信する
    // draft-ietf-moq-transport-21 §6.3 (Session initialization):
    // "Unidirectional streams containing Objects or bidirectional stream(s)
    //  beginning with a request message could arrive prior to the control
    //  streams, in which case the data SHOULD be buffered until both control
    //  streams arrive and setup is complete."
    // 先頭のストリームタイプを確認し、0x2F00 (SETUP) でなければデータストリーム
    // としてバッファリングし、制御ストリームが到着するまで読み進める。
    const incomingReader = this.transport.incomingUnidirectionalStreams.getReader();
    let controlStream: ReadableStream<Uint8Array> | undefined;
    let controlBuffer: Uint8Array = new Uint8Array(0);
    const bufferedDataStreams: ReadableStream<Uint8Array>[] = [];
    try {
      while (controlStream === undefined) {
        const { value: incomingStream, done: streamDone } = await incomingReader.read();
        if (streamDone || !incomingStream) {
          throw new SessionError(
            "Connection closed before receiving control stream",
            SessionErrorCode.NO_ERROR,
          );
        }

        // draft-ietf-moq-transport-21 Section 6.4.1:
        // 単方向ストリームの先頭にストリームタイプ varint が含まれる。
        // WebTransport の read() はチャンク境界を保証しないため、
        // タイプ varint が揃うまで read + 連結を繰り返す。
        const dataReader = incomingStream.getReader();
        let buffer: Uint8Array = new Uint8Array(0);
        let streamType: bigint | undefined;
        let streamTypeConsumed = 0;
        try {
          for (;;) {
            const { value, done } = await dataReader.read();
            if (done || !value) {
              // タイプが揃う前に FIN した空ストリームは読み飛ばす
              break;
            }
            buffer = concatChunks([buffer, value]);
            try {
              [streamType, streamTypeConsumed] = decodeVarint(buffer, 0);
              break;
            } catch (error) {
              // varint がまだ揃っていない場合は次の read() で続きを読む。
              // それ以外のエラーは再 throw する。
              if (!(error instanceof IncompleteDataError)) {
                throw error;
              }
            }
          }
        } finally {
          dataReader.releaseLock();
        }

        if (streamType === undefined) {
          continue;
        }
        if (Number(streamType) === MessageType.SETUP) {
          controlStream = incomingStream;
          controlBuffer = buffer.slice(streamTypeConsumed);
          break;
        }
        // データストリーム先着: 読み取り済みバイト列 (タイプ varint を含む) を
        // 先頭に戻したストリームを作り、SETUP 完了後に handleIncomingStream へ渡す。
        bufferedDataStreams.push(prependBytesToStream(buffer, incomingStream));
      }
    } finally {
      incomingReader.releaseLock();
    }

    if (controlStream === undefined) {
      throw new SessionError(
        "Connection closed before receiving control stream",
        SessionErrorCode.NO_ERROR,
      );
    }
    this.controlReceiveStream = controlStream;

    // draft-ietf-moq-transport-21 Section 9.1 (SETUP):
    // SETUP は制御ストリーム上で最初に送られる制御メッセージである。
    // SETUP メッセージが揃うまで read + feed を繰り返す。
    // ControlStreamReader.feed は部分データを内部バッファに蓄積し、
    // 揃ったメッセージだけを返す。
    const messages = await this.readSetupMessages(controlStream, controlBuffer);

    // 先頭メッセージ種別の検証・SETUP のデコードと検証・AUTHORIZATION TOKEN の処理で
    // 検出した違反は「セッションを閉じる」MUST の対象である。詳細は
    // decodeAndValidateSetupClosingOnViolation を参照する。
    const { message: msg, decoded: decodedSetup } =
      this.decodeAndValidateSetupClosingOnViolation(messages);

    // draft-ietf-moq-transport-21 §9.1.3:
    // ピアの MAX_AUTH_TOKEN_CACHE_SIZE を取得（デフォルト 0 = Alias 使用禁止）
    const peerMaxAuthTokenCacheSize = getSetupMaxAuthTokenCacheSize(decodedSetup);

    // draft-ietf-moq-transport-21 §9.1.7:
    // ピアの MAX_REQUEST_UPDATES を取得（デフォルト 0 = 無制限）
    this.peerMaxRequestUpdates = getSetupMaxRequestUpdates(decodedSetup);

    // draft-ietf-moq-transport-21 §9.1.6:
    // ピアの MAX_FILTER_RANGES を取得（デフォルト 0 = Range Filter 送信禁止）
    this.peerMaxFilterRanges = getSetupMaxFilterRanges(decodedSetup);

    this.emitDebug("recv", MessageType.SETUP, msg.payload, {
      peerMaxAuthTokenCacheSize: peerMaxAuthTokenCacheSize.toString(),
      peerMaxRequestUpdates: this.peerMaxRequestUpdates.toString(),
      peerMaxFilterRanges: this.peerMaxFilterRanges.toString(),
    });

    // SETUP 確立後の受信ループを開始する
    this.startPostSetupLoops(messages, bufferedDataStreams);
  }

  /**
   * 受信 SETUP の先頭メッセージ検証・デコード・検証を行い、違反時はセッションを閉じる
   *
   * draft-ietf-moq-transport-21 §9 (Control Messages) は Length と Body 長の不一致に
   * PROTOCOL_VIOLATION でのセッションクローズを MUST とし、§9.1.1 (AUTHORITY) /
   * §9.1.2 (PATH) は WebTransport 使用中の受信に INVALID_AUTHORITY / INVALID_PATH での
   * クローズを MUST、§9.1.4 (AUTHORIZATION TOKEN) は AUTHORIZATION TOKEN の処理失敗に
   * クローズを MUST とする。また §9.1 (SETUP) は制御ストリームの先頭が SETUP であることを
   * 要求する。
   *
   * initialize() を失敗させるだけではピアに終了コードが伝わらず、connect() は例外を
   * 伝播するだけでトランスポートを閉じないため、セッションが開いたまま残る。
   * toSessionCloseError で正規化した SessionError で closeWithError してから元の例外を
   * 再送出する (initialize() は失敗を reject で伝える契約であり、ここで握ると初期化に
   * 失敗したセッションを成功として返してしまう)。
   * 正規化できない例外 (ピア起因の終了など) は閉じずにそのまま伝播させる。
   *
   * @param messages - readSetupMessages が返した制御メッセージ列 (先頭が SETUP)
   * @returns 検証済みの先頭メッセージとデコード結果
   */
  private decodeAndValidateSetupClosingOnViolation(messages: ControlMessage[]): {
    message: ControlMessage;
    decoded: ReturnType<typeof decodeSetupPayload>;
  } {
    try {
      const msg = messages[0];
      if (msg === undefined) {
        // readSetupMessages は 1 件以上を返す契約だが、noUncheckedIndexedAccess で
        // 型上 undefined を含むため到達しない防御を置く
        throw new SessionError("No SETUP message received", SessionErrorCode.PROTOCOL_VIOLATION);
      }
      if (msg.type !== MessageType.SETUP) {
        throw new SessionError(
          `Expected SETUP, got ${msg.type}`,
          SessionErrorCode.PROTOCOL_VIOLATION,
        );
      }

      // SETUP をデコードしてバリデーションする (Length と Body 長の不一致は
      // ProtocolViolationError / IncompleteDataError になり、下の catch で
      // PROTOCOL_VIOLATION へ正規化される)
      const decoded = decodeSetupPayload(msg.payload);

      // draft-ietf-moq-transport-21 §9.1.1 / §9.1.2:
      // AUTHORITY (0x05) / PATH (0x01) は server から送信されてはならない。
      // また WebTransport 使用時には MUST NOT 送信されるため、moqt-js は受信したら
      // INVALID_AUTHORITY / INVALID_PATH でセッションを閉じなければならない。
      if (getSetupAuthority(decoded) !== undefined) {
        throw new SessionError(
          "received AUTHORITY in SETUP from server (forbidden under WebTransport)",
          SessionErrorCode.INVALID_AUTHORITY,
        );
      }
      if (getSetupPath(decoded) !== undefined) {
        throw new SessionError(
          "received PATH in SETUP from server (forbidden under WebTransport)",
          SessionErrorCode.INVALID_PATH,
        );
      }

      // draft-ietf-moq-transport-21 §9.1.4 / §8.9:
      // 受信 SETUP の AUTHORIZATION TOKEN オプションを処理する。DELETE / USE_ALIAS は
      // §9.1.4 の MUST に基づく防御的検査として PROTOCOL_VIOLATION、登録済み Alias の
      // 再 REGISTER は DUPLICATE_AUTH_TOKEN_ALIAS でセッションを閉じる。上限超過の
      // REGISTER は §9.1.4 の MUST により USE_VALUE として扱いセッションを閉じない。
      // Token 構造がデコードできない場合は KEY_VALUE_FORMATTING_ERROR になる。
      processSetupAuthorizationTokens(this.receivedAuthTokens, decoded.parameters);

      return { message: msg, decoded };
    } catch (error) {
      const sessionError = toSessionCloseError(error);
      if (sessionError !== null) {
        this.closeWithError(sessionError);
      }
      throw error;
    }
  }

  /**
   * 制御ストリームから SETUP を含む制御メッセージ列を読み取る
   *
   * reader は 1 つだけ保持し、後続の制御ストリーム読み取り (startControlMessageLoop)
   * が getReader() で再取得できるよう finally で必ず releaseLock する。
   *
   * @param controlStream - サーバーが開いた制御ストリーム (単方向)
   * @param controlBuffer - ストリームタイプ varint を読み飛ばした後の残りバイト列
   * @returns 1 件以上の制御メッセージ列 (先頭が SETUP)
   */
  private async readSetupMessages(
    controlStream: ReadableStream<Uint8Array>,
    controlBuffer: Uint8Array,
  ): Promise<ControlMessage[]> {
    const controlReader = this.controlReader;
    if (controlReader === undefined) {
      // initialize() が SETUP 送信前に this.controlReader を生成しているため到達しない
      // (このメソッドは initialize() からのみ呼ばれる)
      throw new SessionError("Control reader not initialized", SessionErrorCode.PROTOCOL_VIOLATION);
    }
    const reader = controlStream.getReader();
    try {
      let messages = controlReader.feed(controlBuffer);
      while (messages.length === 0) {
        const { value: chunk, done } = await reader.read();
        if (done || !chunk) {
          throw new SessionError("Connection closed before SETUP", SessionErrorCode.NO_ERROR);
        }
        messages = controlReader.feed(chunk);
      }
      return messages;
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * SETUP 確立後に受信ループを開始する
   *
   * draft-ietf-moq-transport-21 Section 9.1 (SETUP) / Section 6.3 (Session initialization):
   * SETUP は制御ストリーム上の最初の制御メッセージであり、後続メッセージが同一 read
   * チャンクに相乗りして届くことがある。ControlStreamReader.feed は揃った全メッセージを
   * 返し内部バッファから削除するため、messages[0] (SETUP) 以外を処理しないと、後続の
   * startControlMessageLoop は新規 read 分しか処理せず相乗りメッセージが恒久的に失われる。
   * SETUP 確立後に messages[1..] を通常の制御メッセージ処理経路へ順次流す。
   *
   * @param messages - SETUP 受信時の read で揃った制御メッセージ列 (先頭が SETUP)
   * @param bufferedDataStreams - SETUP 完了前に到着しバッファリングしたデータストリーム
   */
  private startPostSetupLoops(
    messages: ControlMessage[],
    bufferedDataStreams: ReadableStream<Uint8Array>[],
  ): void {
    // 先頭 (SETUP) 以外を index access せずに走査する
    for (const trailingMessage of messages.slice(1)) {
      this.handleControlMessage(trailingMessage.type, trailingMessage.payload);
    }

    // バックグラウンドで制御メッセージの読み取りを開始
    this.startControlMessageLoop();

    // 受信データストリームの受け入れを開始
    this.startIncomingStreamLoop();

    // SETUP 完了前に到着したデータストリームを処理する
    // draft-ietf-moq-transport-21 §6.3:
    // 制御ストリーム確立までバッファリングした Object ストリームを、
    // 読み取り済みバイト列 (ストリームタイプ varint を含む) ごと渡す。
    for (const buffered of bufferedDataStreams) {
      void this.handleIncomingStream(buffered);
    }

    // データグラムの受信を開始
    this.startDatagramLoop();

    // 受信双方向ストリームの監視を開始
    // draft-ietf-moq-transport-21 §9.18: SUBSCRIBE_TRACKS への応答として
    // サーバーが新規双方向ストリームを開き PUBLISH を送信する
    this.startIncomingBidirectionalStreamLoop();
  }

  /**
   * トラックを publish する
   */
  async publish(
    namespace: string[],
    trackName: string,
    callbacks?: PublishCallbacks,
    options?: PublishOptions,
  ): Promise<Publisher> {
    if (this.sessionState === "closed") {
      throw new Error("Session is closed");
    }

    // GOAWAY 受信後は新規リクエストを拒否
    // draft-ietf-moq-transport-21 Section 9.2 (GOAWAY)
    if (this.receivedGoaway) {
      throw new Error("Cannot publish after receiving GOAWAY");
    }

    const requestId = this.nextRequestId;
    // draft-ietf-moq-transport-21 Section 6.4.2.1: クライアントは偶数の Request ID を使うため 2 ずつ加算する
    this.nextRequestId += 2n;

    const trackAlias = this.nextTrackAlias++;

    const trackNamespace = createTrackNamespace(namespace);
    const trackNameBytes = encodeTrackName(trackName);
    // draft-ietf-moq-transport-21 §8.7: Full Track Name 合計長検証
    validateFullTrackName(trackNamespace, trackName);
    // draft-ietf-moq-transport-21 §2.4.2 / §6.5: 予約 namespace / .session の送信拒否
    validateTrackNamespaceForSend(namespace, trackName);

    // パブリッシャー実装を作成
    const impl = new PublisherImpl(
      namespace,
      trackName,
      requestId,
      trackAlias,
      callbacks?.error,
      callbacks?.onForwardStateChange,
    );

    // GOAWAY コールバックを設定（セッション内部コールバック）
    impl.goawayCallback = callbacks?.goaway;

    // draft-ietf-moq-transport-21 §3.1 (Subscriptions):
    // "The initiator of the subscription sets the initial Forward State in
    //  either PUBLISH or SUBSCRIBE."
    // PUBLISH 送信時の options.forward (省略時は §9.20.19 のデフォルト 1)
    // を Forward State として保持する。subscribe() と同パターン。
    impl.setForwardState(options?.forward ?? true);

    // 送信コールバックを設定
    impl.onSendObject = (params: SendObjectParams) => this.sendObject(impl, params);
    // draft-ietf-moq-transport-21 §11.3.2 (Closing Subgroup Streams):
    // Forward State 0 で見送った Object がある Subgroup は、閉じる時に reset を MUST とする。
    // 見送りの事実をストリーム状態へ記録する (閉じる時点では最後に送信した Object より後の
    // 見送りを検出できないため、見送りの時点で記録する)。
    impl.onSendObjectSkipped = () => {
      const streamState = this.publisherStreams.get(impl.getTrackAlias());
      if (streamState) {
        streamState.omittedObjects = true;
      }
    };

    // データグラム送信コールバックを設定
    impl.onSendDatagram = (params: SendDatagramParams) => {
      this.sendDatagram(impl, params);
    };

    // PUBLISH_STATE_NOTIFY 送信コールバックを設定
    impl.onNotifyStateChange = (options) => this.sendPublishStateNotify(impl, options);

    impl.onDoneInternal = async (status) => {
      // まずデータストリーム（subgroup 単方向ストリーム）を閉じる（FIN 送信）
      await this.closePublisherStream(impl.getTrackAlias());
      // その後 PUBLISH_DONE を送信（リクエストストリーム（PUBLISH の bidi ストリーム）の FIN は sendPublishDone 内で送信、draft-ietf-moq-transport-21 §9.9）
      await this.sendPublishDone(impl, status);
      // draft-ietf-moq-transport-21 §6.6.1:
      // GOAWAY 受信後に Established 購読が無くなった時点で NO_ERROR で閉じる。
      this.onRequestDrained();
    };

    // PUBLISH メッセージを構築する。
    // buildPublishParameters / buildPublishTrackProperties / encodePublishPayload
    // が throw する場合、pendingPublish.set より前で失敗させるため、
    // 構築・encode は Promise 作成より前に行う (subscribe() の
    // buildSubscribeParameters / fetch() の buildFetchParameters と同じ手順)。
    const parameters = buildPublishParameters(options);
    const trackProperties = buildPublishTrackProperties(options, this.grease);

    // PUBLISH メッセージを双方向ストリームで送信
    // draft-ietf-moq-transport-21 Section 9.8 (PUBLISH):
    // "The publisher sends PUBLISH as the first message on a new
    //  bidirectional stream to initiate a subscription for a Track."
    // draft-ietf-moq-transport-21 Section 6.3
    const publishMsg = {
      type: MessageType.PUBLISH,
      requestId,
      trackNamespace,
      trackName: trackNameBytes,
      trackAlias,
      parameters,
      trackProperties,
    };

    const payload = encodePublishPayload(publishMsg);

    // PUBLISH_OK の Promise を作成
    const promise = new Promise<Publisher>((resolve, reject) => {
      this.pendingPublish.set(requestId, {
        resolve,
        reject,
        impl,
      });
    });

    let streamInfo: Awaited<ReturnType<SessionImpl["sendRequestOnBidiStream"]>>;
    try {
      streamInfo = await this.sendRequestOnBidiStream(requestId, MessageType.PUBLISH, payload, {
        requestId: requestId.toString(),
        trackNamespace: namespace,
        trackName,
        trackAlias: trackAlias.toString(),
        MAX_CACHE_DURATION: options?.maxCacheDuration?.toString(),
        OBJECT_DELIVERY_TIMEOUT: options?.deliveryTimeout?.toString(),
        DEFAULT_PUBLISHER_PRIORITY: options?.publisherPriority,
        GROUP_ORDER: options?.groupOrder,
        DYNAMIC_GROUPS: options?.dynamicGroups,
        EXPIRES: options?.expires?.toString(),
      });
    } catch (error) {
      // 送信失敗時は保留中の PUBLISH を削除して残留を防ぐ
      // (subscribe() の sendRequestOnBidiStream 失敗時と同パターン)。
      this.pendingPublish.delete(requestId);
      throw error;
    }

    // 双方向ストリームからレスポンスを読み取る
    void this.readPublishResponse(requestId, streamInfo.stream, streamInfo.controlReader);

    return promise;
  }

  /**
   * トラックを subscribe する
   *
   * draft-ietf-moq-transport-21 Section 9.7 (SUBSCRIBE_OK):
   * SUBSCRIBE は Track Alias を含まない。
   * Track Alias は SUBSCRIBE_OK で publisher から返される (Section 9.7 SUBSCRIBE_OK)。
   */
  async subscribe(
    namespace: string[],
    trackName: string,
    callbacks: SubscribeCallbacks,
    options?: SubscribeOptions,
  ): Promise<Subscriber> {
    if (this.sessionState === "closed") {
      throw new Error("Session is closed");
    }

    // GOAWAY 受信後は新規リクエストを拒否
    // draft-ietf-moq-transport-21 Section 9.2 (GOAWAY)
    if (this.receivedGoaway) {
      throw new Error("Cannot subscribe after receiving GOAWAY");
    }

    const requestId = this.nextRequestId;
    // draft-ietf-moq-transport-21 Section 6.4.2.1: クライアントは偶数の Request ID を使うため 2 ずつ加算する
    this.nextRequestId += 2n;

    const trackNamespace = createTrackNamespace(namespace);
    const trackNameBytes = encodeTrackName(trackName);
    // draft-ietf-moq-transport-21 §8.7: Full Track Name 合計長検証
    validateFullTrackName(trackNamespace, trackName);
    // draft-ietf-moq-transport-21 §2.4.2 / §6.5: 予約 namespace / .session の送信拒否
    validateTrackNamespaceForSend(namespace, trackName);

    // サブスクライバー実装を作成
    // 注意: trackAlias は SUBSCRIBE_OK 受信時に設定される
    // Track Alias のプレースホルダー。SUBSCRIBE_OK 受信時に更新する
    const impl = new SubscriberImpl(
      namespace,
      trackName,
      requestId,
      0n,
      callbacks.object,
      callbacks.datagram,
      callbacks.end,
      callbacks.error,
    );

    // GOAWAY コールバックを設定（セッション内部コールバック）
    impl.goawayCallback = callbacks.goaway;
    // fill 失敗コールバックを設定（セッション内部コールバック）
    impl.fillErrorCallback = callbacks.fillError;

    // draft-ietf-moq-transport-21 §3.1 (Subscriptions):
    // "The initiator of the subscription sets the initial Forward State in
    //  either PUBLISH or SUBSCRIBE."
    // SUBSCRIBE 送信時の options.forward (省略時は §9.20.19 のデフォルト 1)
    // を Forward State として保持する。
    impl.setForwardState(options?.forward ?? true);

    // draft-ietf-moq-transport-21 §9.20.9 / §9.20.16:
    // SUBSCRIBE 送信時の options.groupOrder を保持する。fill 要求時の
    // Group Order 解決 (FILL 内の指定が無ければ subscription の値) に使う。
    impl.setGroupOrder(options?.groupOrder);

    // draft-ietf-moq-transport-21 Section 3.3.1: Location Filter を設定
    impl.setLocationFilter(options?.filter);

    // draft-ietf-moq-transport-21 Section 3.3.2: Range Filters を設定
    impl.setRangeFilters(options?.rangeFilters);

    // draft-ietf-moq-msf-01 §11.4.3: 後続の REQUEST_UPDATE に同じトークンを付与するため保持
    impl.setAuthorizationToken(options?.authorizationToken);

    // サブスクリプションキャンセルのコールバック
    impl.onUnsubscribe = async () => {
      await this.cancelSubscription(impl);
    };

    // 更新コールバックを設定
    impl.onUpdate = async (updateOptions: RequestUpdateOptions) => {
      await this.sendRequestUpdate(impl, updateOptions);
    };

    // draft-ietf-moq-transport-21 §9.1.6: ピアの MAX_FILTER_RANGES が 0 のとき Range Filter 送信禁止
    // pendingSubscribe.set より前に配置し、throw 時に pending エントリが残らないようにする
    // fill 内側の Range Filters も購読単位の上限に含める (§9.1.6)。
    validateRangeFilterLimits(
      [...(options?.rangeFilters ?? []), ...(options?.fill?.rangeFilters ?? [])],
      this.peerMaxFilterRanges,
      "SUBSCRIBE",
    );

    // draft-ietf-moq-transport-21 §3.3.2:
    // SUBSCRIBE の Range Filter 送信ガード (削除は REQUEST_UPDATE のみ・0x29 は
    // SUBSCRIBE_TRACKS のみ・組み合わせ重複禁止)。buildSubscribeParameters 内でも
    // 検証されるが、pendingSubscribe.set より前に throw させるため明示的に呼ぶ。
    validateRangeFilterSpecs(options?.rangeFilters, "SUBSCRIBE", {
      allowRemove: false,
      allowTrackProperty: false,
    });

    // SUBSCRIBE の Message Parameters を構築する。
    // buildSubscribeParameters (LOCATION_FILTER の End Group 2^64-1 超過検証を
    // 含む) が throw する場合、pendingSubscribe.set より前で失敗させるため、
    // 構築は Promise 作成より前に行う (fetch の buildFetchParameters と同じ手順)。
    const parameters = buildSubscribeParameters(options);

    // SUBSCRIBE_OK の Promise を作成
    const promise = new Promise<Subscriber>((resolve, reject) => {
      this.pendingSubscribe.set(requestId, {
        resolve,
        reject,
        impl,
        objectCallback: callbacks.object,
      });
    });

    // SUBSCRIBE メッセージを双方向ストリームで送信
    // draft-ietf-moq-transport-21 Section 9.6 (SUBSCRIBE):
    // SUBSCRIBE は新しい双方向ストリームで送信される。
    // draft-ietf-moq-transport-21 Section 6.3
    const subscribeMsg = {
      type: MessageType.SUBSCRIBE,
      requestId,
      trackNamespace,
      trackName: trackNameBytes,
      parameters,
    };

    // draft-ietf-moq-transport-21 §3.4 (Fill Semantics):
    // fill を要求した SUBSCRIBE の Request ID を購読に関連付ける。
    // SUBSCRIBE_OK 受理で pending は消えるが、fill ストリーム到着まで保持する。
    if (options?.fill !== undefined) {
      this.fillFetchTargets.set(requestId, {
        subscriber: impl,
        groupOrder: resolveFillGroupOrder(options.fill.groupOrder, options.groupOrder),
      });
    }

    const payload = encodeSubscribePayload(subscribeMsg);
    let streamInfo: Awaited<ReturnType<SessionImpl["sendRequestOnBidiStream"]>>;
    try {
      streamInfo = await this.sendRequestOnBidiStream(requestId, MessageType.SUBSCRIBE, payload, {
        requestId: requestId.toString(),
        trackNamespace: namespace,
        trackName,
        filter: describeLocationFilter(options?.filter),
        OBJECT_DELIVERY_TIMEOUT: options?.deliveryTimeout?.toString(),
        SUBSCRIBER_PRIORITY: options?.subscriberPriority,
        GROUP_ORDER: options?.groupOrder,
        NEW_GROUP_REQUEST: options?.newGroupRequest?.toString(),
      });
    } catch (error) {
      // 送信失敗時は fill 関連付けと保留中の SUBSCRIBE を削除して残留を防ぐ
      // (bidiSendRequestUpdate の write 失敗時と同パターン)。
      this.fillFetchTargets.delete(requestId);
      this.pendingSubscribe.delete(requestId);
      throw error;
    }

    // 双方向ストリームからレスポンスを読み取る
    void this.readSubscribeResponse(requestId, streamInfo.stream, streamInfo.controlReader);

    return promise;
  }

  /**
   * 過去のデータを取得する
   *
   * draft-ietf-moq-transport-21 Section 9.11 (FETCH):
   * FETCH はトラックから Object の範囲を要求する。範囲は
   * LOCATION_FILTER パラメータで指定する。
   */
  async fetch(
    namespace: string[],
    trackName: string,
    options: FetchOptions,
    callbacks: FetchCallbacks,
  ): Promise<Fetcher> {
    if (this.sessionState === "closed") {
      throw new Error("Session is closed");
    }

    // GOAWAY 受信後は新規リクエストを拒否
    if (this.receivedGoaway) {
      throw new Error("Cannot fetch after receiving GOAWAY");
    }

    const requestId = this.nextRequestId;
    this.nextRequestId += 2n;

    const trackNamespace = createTrackNamespace(namespace);
    const trackNameBytes = encodeTrackName(trackName);
    // draft-ietf-moq-transport-21 §8.7: Full Track Name 合計長検証
    validateFullTrackName(trackNamespace, trackName);
    // draft-ietf-moq-transport-21 §2.4.2 / §6.5: 予約 namespace / .session の送信拒否
    validateTrackNamespaceForSend(namespace, trackName);

    // draft-ietf-moq-transport-21 §9.1.6: ピアの MAX_FILTER_RANGES を超える Range Filter 送信をガード
    // pendingFetch.set より前に配置し、throw 時に pending エントリが残らないようにする
    validateRangeFilterLimits(options?.rangeFilters, this.peerMaxFilterRanges, "FETCH");

    // Fetcher 実装を作成
    const impl = new FetcherImpl(
      namespace,
      trackName,
      requestId,
      callbacks.object,
      callbacks.end,
      callbacks.error,
    );

    // GOAWAY コールバックを設定（セッション内部コールバック）
    impl.goawayCallback = callbacks.goaway;

    // draft-ietf-moq-transport-21 §9.20.9 / §11.4.1.1:
    // FETCH 送信時の options.groupOrder を保持し、FETCH 応答の Group ID 復号に
    // 使う。GROUP_ORDER は FETCH_OK に出現しないため、復号の根拠は要求時の値
    // だけにする。省略時は Ascending (§9.20.9 の既定値であり、fill fetch の
    // resolveFillGroupOrder と同じ扱い)。
    impl.setGroupOrder(
      options.groupOrder === "Descending" ? GroupOrder.DESCENDING : GroupOrder.ASCENDING,
    );

    // draft-ietf-moq-transport-21 Section 3.2.1:
    // キャンセルはストリームを閉じることで行う。
    impl.onCancel = async () => {
      await this.cancelFetch(impl);
    };

    // FETCH メッセージを構築する
    // draft-ietf-moq-transport-21 Section 9.11 (FETCH):
    // FETCH は新しい双方向ストリームで送信される。
    // draft-ietf-moq-transport-21 Section 6.3
    // buildFetchParameters (buildRangeFilterParameters / encodeLocationFilter を含む)
    // が throw する場合、pendingFetch.set より前で失敗させるため、
    // 構築は Promise 作成より前に行う。
    const fetchMsg = {
      type: MessageType.FETCH,
      requestId,
      trackNamespace,
      trackName: trackNameBytes,
      parameters: buildFetchParameters(options),
    };

    // FETCH メッセージのペイロードを構築する。
    // encodeFetchPayload が throw する場合、pendingFetch.set より前で
    // 失敗させるため、encode は Promise 作成より前に行う (publish() と同じ手順)。
    const payload = encodeFetchPayload(fetchMsg);

    // FETCH_OK を待つ Promise。
    // startLocation は FETCH_OK の End Location 検証 (§9.12) に使う。
    // 相対指定 (1 フィールド) と Next Object 形式は Largest Object 依存のため
    // クライアント側では確定できず undefined になる。
    const startLocation = resolveFetchStartLocation(options.filter);
    const promise = new Promise<Fetcher>((resolve, reject) => {
      // exactOptionalPropertyTypes では optional な startLocation に undefined を渡せないため、
      // 値がある場合だけ載せる
      this.pendingFetch.set(requestId, {
        resolve,
        reject,
        impl,
        ...(startLocation !== undefined ? { startLocation } : {}),
      });
    });

    let streamInfo: Awaited<ReturnType<SessionImpl["sendRequestOnBidiStream"]>>;
    try {
      streamInfo = await this.sendRequestOnBidiStream(requestId, MessageType.FETCH, payload, {
        requestId: requestId.toString(),
        trackNamespace: namespace,
        trackName,
        filter: describeLocationFilter(options.filter),
      });
    } catch (error) {
      // 送信失敗時は保留中の FETCH を削除して残留を防ぐ
      // (subscribe() の sendRequestOnBidiStream 失敗時と同パターン)。
      this.pendingFetch.delete(requestId);
      throw error;
    }

    // 双方向ストリームからレスポンスを読み取る
    void this.readFetchResponse(requestId, streamInfo.stream, streamInfo.controlReader);

    return promise;
  }

  /**
   * トラックの状態を問い合わせる
   *
   * draft-ietf-moq-transport-21 Section 9.13 (TRACK_STATUS):
   * TRACK_STATUS は subscribe せずにトラックの情報を要求する
   * 応答は SUBSCRIBE_OK と同じパラメータを持つ REQUEST_OK である
   */
  async trackStatus(
    namespace: string[],
    trackName: string,
    options?: TrackStatusOptions,
  ): Promise<TrackStatusResult> {
    if (this.sessionState === "closed") {
      throw new Error("Session is closed");
    }

    // GOAWAY 受信後は新規リクエストを拒否
    if (this.receivedGoaway) {
      throw new Error("Cannot query track status after receiving GOAWAY");
    }

    const requestId = this.nextRequestId;
    this.nextRequestId += 2n;

    const trackNamespace = createTrackNamespace(namespace);
    const trackNameBytes = encodeTrackName(trackName);
    // draft-ietf-moq-transport-21 §8.7: Full Track Name 合計長検証
    validateFullTrackName(trackNamespace, trackName);
    // draft-ietf-moq-transport-21 §2.4.2 / §6.5: 予約 namespace / .session の送信拒否
    validateTrackNamespaceForSend(namespace, trackName);

    // REQUEST_OK を待つ Promise
    // draft-ietf-moq-transport-21 §12.1: malformed Track の検出時に同一 Track の
    // 購読 / FETCH を cross-cancel するため、比較キーを pending に保持する。
    const promise = new Promise<TrackStatusResult>((resolve, reject) => {
      this.pendingTrackStatus.set(requestId, {
        resolve,
        reject,
        trackKey: fullTrackNameKey(namespace, trackName),
      });
    });

    // TRACK_STATUS メッセージを双方向ストリームで送信
    // draft-ietf-moq-transport-21 Section 9.13 (TRACK_STATUS):
    // TRACK_STATUS は新しい双方向ストリームで送信される。
    // draft-ietf-moq-transport-21 Section 6.3
    // draft-ietf-moq-transport-21 Section 9.20.22:
    // INCLUDE_PROPERTIES は buildTrackStatusParameters で載せる (省略時は送らない)。
    const trackStatusMsg = {
      type: MessageType.TRACK_STATUS,
      requestId,
      trackNamespace,
      trackName: trackNameBytes,
      parameters: buildTrackStatusParameters(options),
    };

    let streamInfo: Awaited<ReturnType<SessionImpl["sendRequestOnBidiStream"]>>;
    try {
      // buildTrackStatusParameters は throw しないが、encode 以降は共通化のため
      // 同一 try 範囲に含める (publish() / fetch() と同じ手順)。
      const payload = encodeTrackStatusPayload(trackStatusMsg);
      streamInfo = await this.sendRequestOnBidiStream(
        requestId,
        MessageType.TRACK_STATUS,
        payload,
        {
          requestId: requestId.toString(),
          trackNamespace: namespace,
          trackName,
        },
      );
    } catch (error) {
      // 送信失敗時は保留中の TRACK_STATUS を削除して残留を防ぐ
      // (subscribe() の sendRequestOnBidiStream 失敗時と同パターン)。
      this.pendingTrackStatus.delete(requestId);
      throw error;
    }

    // 双方向ストリームからレスポンスを読み取る
    void this.readTrackStatusResponse(requestId, streamInfo.stream, streamInfo.controlReader);

    return promise;
  }

  /**
   * 取得済み namespace 系ストリーム資源を掃除する
   *
   * 送信失敗時に呼び出す。登録は成功時のみ行うため Map 側の掃除は不要。
   * 取得済み reader / writer の後始末として cancel / abort で RESET 相当とし
   * (bidiSendRequestOnBidiStream の方針)、 FIN である close は使わない。
   * readable は getReader 済みでロック中のため streamReader 経由で
   * cancel + releaseLock する。 abort / cancel 自体の失敗は無視する。
   * なお reader / writer の取得自体はストリーム生成直後のため
   * 失敗を想定せず、呼び出し側で try 外に置く。
   */
  private async cleanupNamespaceSendFailure(
    streamReader: ReadableStreamDefaultReader<Uint8Array>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
  ): Promise<void> {
    try {
      await streamReader.cancel("namespace request send failed");
    } catch {
      // 閉じかけのストリーム操作の失敗は無視する
    } finally {
      streamReader.releaseLock();
    }
    try {
      await writer.abort("namespace request send failed");
    } catch {
      // 閉じかけのストリーム操作の失敗は無視する
    } finally {
      writer.releaseLock();
    }
  }

  /**
   * namespace 系ストリームを RESET / STOP_SENDING で解除する
   *
   * draft-ietf-moq-transport-21 §4.1 / §4.2 / §6.4.2.3:
   * リクエストのキャンセルは送信方向の RESET_STREAM (writer.abort()) と
   * 受信方向の STOP_SENDING (reader.cancel()) で行う。FIN (writer.close()) は
   * graceful 完了の通知であり、キャンセルには使わない。
   * reader のロック解放は読み取りループの finally に委ねる (ここで解放すると
   * ループ側の releaseLock と二重になる)。
   */
  private async cancelNamespaceStream(
    streamReader: ReadableStreamDefaultReader<Uint8Array> | undefined,
    writer: WritableStreamDefaultWriter<Uint8Array> | undefined,
    reason: string,
  ): Promise<void> {
    if (streamReader !== undefined) {
      try {
        await streamReader.cancel(reason);
      } catch {
        // 既に閉じている / 解放済みの場合は無視
      }
    }
    if (writer !== undefined) {
      try {
        await writer.abort(reason);
      } catch {
        // 既に閉じている / abort 済みの場合は無視
      }
    }
  }

  /**
   * Namespace をサブスクライブする（namespace discovery 用）
   *
   * draft-ietf-moq-transport-21 §9.15 (SUBSCRIBE_NAMESPACE):
   * SUBSCRIBE_NAMESPACE (0x50) は新しい双方向ストリームで送信される。
   * REQUEST_OK または REQUEST_ERROR が最初のレスポンスとして返され、
   * 以降は NAMESPACE / NAMESPACE_DONE のみが応答ストリーム上で送られる。
   *
   * draft-18 で旧 SUBSCRIBE_NAMESPACE (0x11) が 0x50 と SUBSCRIBE_TRACKS (0x51)
   * に分割され、Subscribe Options フィールドは廃止された。
   *
   * draft-ietf-moq-transport-21 §4.1:
   * キャンセルはストリームを FIN または RESET_STREAM で閉じることで行う。
   */
  async subscribeNamespace(
    namespacePrefix: string[],
    callbacks: NamespaceSubscriptionCallbacks,
    options?: { authorizationToken?: AuthorizationToken },
  ): Promise<NamespaceSubscription> {
    if (this.sessionState === "closed") {
      throw new Error("session is closed");
    }

    // GOAWAY 受信後は新規リクエストを拒否
    if (this.receivedGoaway) {
      throw new Error("cannot subscribe namespace after receiving GOAWAY");
    }

    const requestId = this.nextRequestId;
    this.nextRequestId += 2n;

    const trackNamespacePrefix = createTrackNamespace(namespacePrefix);

    // draft-ietf-moq-transport-21 §2.4.2 / §6.5: 予約 namespace / .session の送信拒否
    validateTrackNamespaceForSend(namespacePrefix);

    // 専用の双方向ストリームを作成
    const stream = await this.transport.createBidirectionalStream();
    const streamReader = stream.readable.getReader();
    const controlReader = new ControlStreamReader();
    const writer = stream.writable.getWriter();

    try {
      // SUBSCRIBE_NAMESPACE メッセージを構築
      // AUTHORIZATION_TOKEN (0x03) - draft-ietf-moq-msf-01 §11.4.3: SUBSCRIBE_NAMESPACE に MUST 付与。
      const subscribeNamespaceMsg = {
        type: MessageType.SUBSCRIBE_NAMESPACE,
        requestId,
        trackNamespacePrefix,
        parameters: buildSubscribeNamespaceParameters(options),
      };

      // メッセージをエンコードして送信
      // draft-ietf-moq-transport-21 §9.15 (SUBSCRIBE_NAMESPACE):
      // Type (vi64) + Length (16-bit big-endian) + Payload のフレーミングを
      // ControlStreamWriter に委譲する。
      const payload = encodeSubscribeNamespacePayload(subscribeNamespaceMsg);
      const controlWriter = new ControlStreamWriter();
      const framed = controlWriter.encode(MessageType.SUBSCRIBE_NAMESPACE, payload);

      // デバッグコールバック
      this.callbacks.debug?.({
        direction: "send",
        type: MessageType.SUBSCRIBE_NAMESPACE,
        typeName: getMessageTypeName(MessageType.SUBSCRIBE_NAMESPACE),
        payload,
        decoded: {
          requestId: requestId.toString(),
          trackNamespacePrefix: namespacePrefix,
        },
        timestamp: Date.now(),
      });

      await writer.write(framed);
    } catch (error) {
      // 送信失敗時は取得済みリソースを掃除して throw する
      await this.cleanupNamespaceSendFailure(streamReader, writer);
      throw error;
    }

    // REQUEST_OK/REQUEST_ERROR を待つ Promise
    return new Promise<NamespaceSubscription>((resolve, reject) => {
      // 状態を登録
      this.namespaceSubscriptions.set(requestId, {
        callbacks,
        state: "active",
        namespacePrefix,
        stream,
        streamReader,
        controlReader,
        writer,
      });

      // 専用ストリームの受信ループを開始
      void this.startNamespaceStreamLoop(requestId, resolve, reject);
    });
  }

  /**
   * Track をサブスクライブする（track subscription 用）
   *
   * draft-ietf-moq-transport-21 §9.18 (SUBSCRIBE_TRACKS):
   * SUBSCRIBE_TRACKS (0x51) は新しい双方向ストリームで送信される。
   * REQUEST_OK または REQUEST_ERROR が最初のレスポンスとして返され、
   * 以降は PUBLISH_SKIPPED のみが応答ストリーム上で送られる。
   * PUBLISH メッセージは別の新規双方向ストリームで非同期に到着する。
   *
   * draft-ietf-moq-transport-21 §4.1:
   * キャンセルはストリームを FIN または RESET_STREAM で閉じることで行う。
   */
  async subscribeTracks(
    namespacePrefix: string[],
    callbacks: TracksSubscriptionCallbacks,
    options?: SubscribeTracksOptions,
  ): Promise<TracksSubscription> {
    if (this.sessionState === "closed") {
      throw new Error("session is closed");
    }

    // GOAWAY 受信後は新規リクエストを拒否
    if (this.receivedGoaway) {
      throw new Error("cannot subscribe tracks after receiving GOAWAY");
    }

    const requestId = this.nextRequestId;
    this.nextRequestId += 2n;

    const trackNamespacePrefix = createTrackNamespace(namespacePrefix);

    // draft-ietf-moq-transport-21 §2.4.2 / §6.5: 予約 namespace / .session の送信拒否
    validateTrackNamespaceForSend(namespacePrefix);

    // draft-ietf-moq-transport-21 §9.1.6: ピアの MAX_FILTER_RANGES が 0 のとき Range Filter 送信禁止
    // draft-ietf-moq-transport-21 §4.3: SUBSCRIBE_TRACKS で Range Filter を送信できる
    validateRangeFilterLimits(options?.rangeFilters, this.peerMaxFilterRanges, "SUBSCRIBE_TRACKS");

    // 専用の双方向ストリームを作成
    const stream = await this.transport.createBidirectionalStream();
    const streamReader = stream.readable.getReader();
    const controlReader = new ControlStreamReader();
    const writer = stream.writable.getWriter();

    try {
      // SUBSCRIBE_TRACKS メッセージを構築
      // draft-ietf-moq-transport-21 §9.18.1: GROUP_ORDER / FORWARD / Range Filters を送信可能
      const subscribeTracksMsg = {
        type: MessageType.SUBSCRIBE_TRACKS,
        requestId,
        trackNamespacePrefix,
        parameters: buildSubscribeTracksParameters(options),
      };

      // メッセージをエンコードして送信
      // draft-ietf-moq-transport-21 §9.18 (SUBSCRIBE_TRACKS):
      // Type (vi64) + Length (16-bit big-endian) + Payload のフレーミングを
      // ControlStreamWriter に委譲する。
      const payload = encodeSubscribeTracksPayload(subscribeTracksMsg);
      const controlWriter = new ControlStreamWriter();
      const framed = controlWriter.encode(MessageType.SUBSCRIBE_TRACKS, payload);

      // デバッグコールバック
      this.callbacks.debug?.({
        direction: "send",
        type: MessageType.SUBSCRIBE_TRACKS,
        typeName: getMessageTypeName(MessageType.SUBSCRIBE_TRACKS),
        payload,
        decoded: {
          requestId: requestId.toString(),
          trackNamespacePrefix: namespacePrefix,
        },
        timestamp: Date.now(),
      });

      await writer.write(framed);
    } catch (error) {
      // 送信失敗時は取得済みリソースを掃除して throw する
      await this.cleanupNamespaceSendFailure(streamReader, writer);
      throw error;
    }

    // REQUEST_OK/REQUEST_ERROR を待つ Promise
    return new Promise<TracksSubscription>((resolve, reject) => {
      // 状態を登録
      this.tracksSubscriptions.set(requestId, {
        callbacks,
        state: "active",
        namespacePrefix,
        // draft-ietf-moq-transport-21 §3.3.2:
        // TRACK_PROPERTY_FILTER は受信 PUBLISH の評価に使用するため保持する
        rangeFilters: options?.rangeFilters,
        stream,
        streamReader,
        controlReader,
        writer,
      });

      // 専用ストリームの受信ループを開始
      void this.startTracksStreamLoop(requestId, resolve, reject);
    });
  }

  /**
   * SUBSCRIBE_NAMESPACE 専用ストリームの受信ループ
   *
   * draft-ietf-moq-transport-21 §9.15 (SUBSCRIBE_NAMESPACE):
   * REQUEST_OK / REQUEST_ERROR、NAMESPACE、NAMESPACE_DONE のみを処理する。
   * PUBLISH_SKIPPED は SUBSCRIBE_TRACKS 応答ストリーム側 (startTracksStreamLoop) で扱う。
   */
  private startNamespaceStreamLoop(
    requestId: bigint,
    resolve: (subscription: NamespaceSubscription) => void,
    reject: (err: Error) => void,
  ): Promise<void> {
    return namespaceLoops.namespaceStartNamespaceStreamLoop(
      this as unknown as SessionInternal,
      requestId,
      resolve,
      reject,
    );
  }

  /**
   * SUBSCRIBE_TRACKS 専用ストリームの受信ループ
   *
   * draft-ietf-moq-transport-21 §9.18 (SUBSCRIBE_TRACKS):
   * REQUEST_OK / REQUEST_ERROR、PUBLISH_SKIPPED のみを処理する。
   * PUBLISH メッセージは別の新規双方向ストリームで到着するためここでは扱わない。
   */
  private startTracksStreamLoop(
    requestId: bigint,
    resolve: (subscription: TracksSubscription) => void,
    reject: (err: Error) => void,
  ): Promise<void> {
    return namespaceLoops.namespaceStartTracksStreamLoop(
      this as unknown as SessionInternal,
      requestId,
      resolve,
      reject,
    );
  }

  /**
   * Namespace を公開する（トラック発見用）
   *
   * draft-ietf-moq-transport-21 Section 9.14 (PUBLISH_NAMESPACE):
   * PUBLISH_NAMESPACE は新しい双方向ストリームの先頭メッセージとして送信される。
   * REQUEST_OK / REQUEST_ERROR が同じ双方向ストリームで応答される。
   * https://www.ietf.org/archive/id/draft-ietf-moq-transport-21.html#section-9.14
   *
   * draft-ietf-moq-transport-21 §4.2:
   * 公開のキャンセルはストリームを FIN または RESET_STREAM で閉じることで行う。
   * https://www.ietf.org/archive/id/draft-ietf-moq-transport-21.html#section-4.2
   */
  async publishNamespace(
    namespace: string[],
    callbacks?: NamespacePublicationCallbacks,
    options?: PublishNamespaceOptions,
  ): Promise<NamespacePublication> {
    if (this.sessionState === "closed") {
      throw new Error("session is closed");
    }

    // GOAWAY 受信後は新規リクエストを拒否
    if (this.receivedGoaway) {
      throw new Error("cannot publish namespace after receiving GOAWAY");
    }

    const requestId = this.nextRequestId;
    this.nextRequestId += 2n;

    const trackNamespace = createTrackNamespace(namespace);

    // draft-ietf-moq-transport-21 §2.4.2 / §6.5: 予約 namespace / .session の送信拒否
    validateTrackNamespaceForSend(namespace);

    // 専用の双方向ストリームを作成
    const stream = await this.transport.createBidirectionalStream();
    const streamReader = stream.readable.getReader();
    const controlReader = new ControlStreamReader();
    const writer = stream.writable.getWriter();

    try {
      // PUBLISH_NAMESPACE メッセージを構築
      const publishNamespaceMsg = {
        type: MessageType.PUBLISH_NAMESPACE,
        requestId,
        trackNamespace,
        // AUTHORIZATION_TOKEN (0x03) - draft-ietf-moq-transport-21 Section 9.20.3
        parameters:
          options?.authorizationToken !== undefined
            ? [encodeAuthorizationTokenParameter(options.authorizationToken)]
            : [],
      };

      // メッセージをエンコードして送信
      // draft-ietf-moq-transport-21 Section 9.14 (PUBLISH_NAMESPACE):
      // Type (vi64) + Length (16-bit big-endian) + Payload のフレーミングを
      // ControlStreamWriter に委譲する。
      // https://www.ietf.org/archive/id/draft-ietf-moq-transport-21.html#section-9.14
      const payload = encodePublishNamespacePayload(publishNamespaceMsg);
      const controlWriter = new ControlStreamWriter();
      const framed = controlWriter.encode(MessageType.PUBLISH_NAMESPACE, payload);

      // デバッグコールバック
      this.callbacks.debug?.({
        direction: "send",
        type: MessageType.PUBLISH_NAMESPACE,
        typeName: getMessageTypeName(MessageType.PUBLISH_NAMESPACE),
        payload,
        decoded: {
          requestId: requestId.toString(),
          trackNamespace: namespace,
        },
        timestamp: Date.now(),
      });

      await writer.write(framed);
    } catch (error) {
      // 送信失敗時は取得済みリソースを掃除して throw する
      await this.cleanupNamespaceSendFailure(streamReader, writer);
      throw error;
    }

    // REQUEST_OK / REQUEST_ERROR を待つ Promise
    return new Promise<NamespacePublication>((resolve, reject) => {
      // 状態を登録
      this.namespacePublications.set(requestId, {
        callbacks,
        state: "pending",
        namespace,
        stream,
        streamReader,
        controlReader,
        writer,
      });

      // 専用ストリームの受信ループを開始
      void this.startNamespacePublicationStreamLoop(requestId, resolve, reject);
    });
  }

  /**
   * PUBLISH_NAMESPACE 専用ストリームの受信ループ
   *
   * draft-ietf-moq-transport-21 Section 9.14 (PUBLISH_NAMESPACE):
   * 応答は REQUEST_OK / REQUEST_ERROR のみが想定される。
   * それ以外のメッセージを受信した場合は PROTOCOL_VIOLATION でセッションを閉じる。
   */
  private startNamespacePublicationStreamLoop(
    requestId: bigint,
    resolve: (publication: NamespacePublication) => void,
    reject: (err: Error) => void,
  ): Promise<void> {
    return namespaceLoops.namespaceStartPublicationStreamLoop(
      this as unknown as SessionInternal,
      requestId,
      resolve,
      reject,
    );
  }

  /**
   * GOAWAY を送信してセッション終了を通知する
   *
   * draft-ietf-moq-transport-21 Section 9.2 (GOAWAY):
   * エンドポイントは間もなくセッションを閉じる意図を peer に通知するために
   * GOAWAY メッセージを送信する。
   */
  async goaway(newSessionUri?: string, timeout?: bigint): Promise<void> {
    return sessionGoaway(this as unknown as SessionLifecycleInternal, newSessionUri, timeout);
  }

  /**
   * セッションレベルの統計情報を取得する
   */
  getStatistics(): SessionStatistics {
    return sessionGetStatistics(this as unknown as SessionStatisticsSource);
  }

  /**
   * セッションを閉じる
   *
   * draft-ietf-moq-transport-21 Section 6.6:
   * "When WebTransport is used, the session is closed using the
   *  CLOSE_WEBTRANSPORT_SESSION capsule."
   * 正常終了時もユーザー起点で WebTransport を閉じる必要がある。
   * 保持している双方向 / 単方向ストリームの writer を閉じてから transport を閉じることで、
   * QUIC ストリームの FIN 送信とセッション終了通知を行う。
   */
  async close(closeCode: number = SessionErrorCode.NO_ERROR, reason = ""): Promise<void> {
    return sessionClose(this as unknown as SessionLifecycleInternal, closeCode, reason);
  }

  // プライベートメソッド

  /**
   * request 系オブジェクトの state を閉じる
   *
   * draft-ietf-moq-transport-21 Section 6.6:
   * セッション終了 (自前起点の close() とピア起点の transport.closed) で
   * 共通の後始末。ハンドラから close() を直接呼ぶことはできない
   * (sessionState が既に "closed" のため冒頭ガードで早期 return する) ので、
   * state 遷移だけを本ヘルパーに抽出して両方から呼ぶ。
   * 注意: セッションクローズはトラックレベルの PUBLISH_DONE ではなく
   * セッションレベルの終了 (Section 6.6 Termination) であるため handleEnd() ではなく
   * markClosed() を使用する。end コールバックは PUBLISH_DONE 専用。
   * request 系オブジェクトの handleEnd / handleError は呼ばない。
   * 通知 (ConnectCallbacks.close) や pending の reject は本ヘルパーの範囲外
   * (呼び出し元が担う。transport.closed 時の pending 掃除は現状は行わない)。
   */
  private markRequestObjectsClosed(): void {
    sessionMarkRequestObjectsClosed(this as unknown as SessionLifecycleInternal);
  }

  /**
   * 保留中のリクエスト Promise をすべて reject してエントリを削除する
   *
   * draft-ietf-moq-transport-21 §6.6 (Termination):
   * セッション終了 (自前 close() / ピア起点の transport.closed) のいずれでも
   * アプリが未解決の Promise を待ち続けないようにする共通後始末。
   */
  private rejectPendingRequests(error: Error): void {
    sessionRejectPendingRequests(this as unknown as SessionLifecycleInternal, error);
  }

  /**
   * 未完了の購読・fetch が残っているかを返す
   *
   * draft-ietf-moq-transport-21 §6.6.1 (Graceful Session Migration):
   * "The sender SHOULD close the session with GOAWAY_TIMEOUT after the indicated
   *  timeout if there are still open subscriptions or fetches on a connection."
   * pending なリクエストも未完了として含める。
   */
  hasOpenSubscriptionsOrFetches(): boolean {
    return sessionHasOpenSubscriptionsOrFetches(this as unknown as SessionLifecycleInternal);
  }

  /**
   * GOAWAY 受信後に Established 購読・fetch が無くなっていれば NO_ERROR で閉じる
   *
   * draft-ietf-moq-transport-21 §6.6.1:
   * "After the client receives a GOAWAY, it's RECOMMENDED that the client waits
   *  until there are no more Established subscriptions before closing the
   *  session with NO_ERROR."
   * 購読・fetch の終了通知 (onRequestDrained) から呼ばれる。
   */
  closeIfGoawayDrained(): void {
    sessionCloseIfGoawayDrained(this as unknown as SessionLifecycleInternal);
  }

  /**
   * 確立済みの購読・fetch が 1 つ終了したことを受けて、
   * GOAWAY 後の NO_ERROR クローズ条件を満たすか確認する
   *
   * free function (bidi / publish 系) から `session.onRequestDrained?.()` で
   * 呼ばれる。SessionInternal 経由で参照されるため public とする。
   */
  onRequestDrained(): void {
    sessionOnRequestDrained(this as unknown as SessionLifecycleInternal);
  }

  /**
   * セッションエラーを通知してセッションを閉じる
   *
   * draft-ietf-moq-transport-21 Section 6.6:
   * プロトコル違反等のエラーが発生した場合、セッションを閉じる必要がある。
   * アプリ登録の error コールバックが throw しても close() は必ず実行する
   * (通知の成否で終了手順が止まると、違反を検出しながらセッションが開いた
   * ままになる)。後続処理を継続する点はリクエストストリーム上の GOAWAY
   * ハンドラや fetcher error 通知と同様だが、握り潰しっぱなしにせずデバッグ
   * 記録に残す点は本メソッド固有の配慮である。コールバックの throw は再
   * throw しない (呼び出し元 catch への再流入による誤変換・二重通知を避けるため)。
   */
  private closeWithError(error: SessionError): void {
    sessionCloseWithError(this as unknown as SessionLifecycleInternal, error);
  }

  /**
   * read loop で発生したエラーを必要なときだけ callbacks.error に通知する
   *
   * draft-ietf-moq-transport-21 Section 6.6:
   * peer 起点で WebTransport セッションが閉じた場合、各ストリームの read() は
   * reject するが、これは正常な終了通知であり onError には流さない。
   * sessionState がすでに connected でない、または error が WebTransport セッション
   * 終了起源の場合はスキップし、それ以外のみ通知する。
   */
  private notifyErrorIfActive(error: Error): void {
    sessionNotifyErrorIfActive(this as unknown as SessionLifecycleInternal, error);
  }

  private emitDebug(
    direction: "send" | "recv",
    type: number,
    payload: Uint8Array,
    decoded?: Record<string, unknown>,
  ): void {
    sessionEmitDebug(
      this as unknown as SessionLifecycleInternal,
      direction,
      type,
      payload,
      decoded,
    );
  }

  async sendControlMessage(
    type: number,
    payload: Uint8Array,
    decoded?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.controlSendStream || !this.controlWriter) {
      throw new Error("Control stream not initialized");
    }

    this.statsControlMessagesSent++;
    this.emitDebug("send", type, payload, decoded);

    const message = this.controlWriter.encode(type, payload);
    const writer = this.controlSendStream.getWriter();
    await writer.write(message);
    writer.releaseLock();
  }

  /**
   * リクエストを双方向ストリーム上で送信する
   *
   * draft-ietf-moq-transport-21 Section 6.3:
   * リクエスト (SUBSCRIBE, PUBLISH, FETCH, TRACK_STATUS 等) は
   * 双方向ストリーム上で送受信される。
   * draft-ietf-moq-transport-21 Section 6.3
   *
   * @param requestId - リクエスト ID
   * @param type - メッセージタイプ
   * @param payload - エンコード済みペイロード
   * @param decoded - デバッグ用のデコード済みメッセージ
   * @returns 双方向ストリームの情報
   */
  private sendRequestOnBidiStream(
    requestId: bigint,
    type: number,
    payload: Uint8Array,
    decoded?: Record<string, unknown>,
  ): Promise<{
    stream: WebTransportBidirectionalStream;
    writer: WritableStreamDefaultWriter<Uint8Array>;
    controlReader: ControlStreamReader;
  }> {
    return bidi.bidiSendRequestOnBidiStream(
      this as unknown as bidi.BidiSessionInternal,
      requestId,
      type,
      payload,
      decoded,
    );
  }

  /**
   * Subgroup ストリームでオブジェクトを送信する
   * draft-ietf-moq-transport-21 Section 2.2:
   * "Objects in a subgroup ... are sent on a single stream whenever possible."
   *
   * 同じ Group 内のオブジェクトは同じストリームで送信する
   * 新しい Group が来たら前のストリームを閉じて新規作成する
   *
   * sendObject は async だが fire-and-forget で呼ばれるため、
   * トラック単位で Promise チェーンによるシリアライズを行う。
   * これにより createUnidirectionalStream() の await 中に
   * 次の呼び出しが割り込んでストリームを二重作成する問題を防ぐ。
   */
  private sendObject(publisher: PublisherImpl, params: SendObjectParams): Promise<void> {
    return publishSendObject(this as unknown as SessionInternal, publisher, params);
  }

  /**
   * Publisher のストリームを閉じる
   * 送信キューに入れて、進行中の sendObject が完了してから閉じる
   */
  private closePublisherStream(trackAlias: bigint): Promise<void> {
    return publishClosePublisherStream(this as unknown as SessionInternal, trackAlias);
  }

  /**
   * datagram を送信する
   * draft-ietf-moq-transport-21 Section 11.2 (Datagrams)
   */
  private sendDatagram(publisher: PublisherImpl, params: SendDatagramParams): void {
    publishSendDatagram(this as unknown as SessionInternal, publisher, params);
  }

  /**
   * PUBLISH_STATE_NOTIFY を送信する
   *
   * draft-ietf-moq-transport-21 §9.10 (PUBLISH_STATE_NOTIFY):
   * 購読の双方向ストリーム上で送信し、応答は受け取らない。
   */
  private sendPublishStateNotify(
    publisher: PublisherImpl,
    options: PublishStateNotifyOptions,
  ): Promise<void> {
    return bidi.bidiSendPublishStateNotify(
      this as unknown as bidi.BidiSessionInternal,
      publisher,
      options,
    );
  }

  /**
   * draft-ietf-moq-transport-21 Section 9.9 (PUBLISH_DONE):
   * PUBLISH_DONE は双方向ストリーム上で送信される。
   * Request ID フィールドはない（bidi stream で特定可能）。
   */
  private sendPublishDone(publisher: PublisherImpl, status: PublishDoneStatusCode): Promise<void> {
    return publishSendPublishDone(this as unknown as SessionInternal, publisher, status);
  }

  /**
   * サブスクリプションをキャンセルする
   *
   * draft-ietf-moq-transport-21 Section 6.4.2.3:
   * subscription のキャンセルは双方向ストリームの close で行う。
   */
  private cancelSubscription(subscriber: SubscriberImpl): Promise<void> {
    return bidi.bidiCancelSubscription(this as unknown as bidi.BidiSessionInternal, subscriber);
  }

  /**
   * Fetch をキャンセルする
   *
   * draft-ietf-moq-transport-21 Section 3.2.1:
   * "It MUST send STOP_SENDING for the bidi request stream."
   */
  private cancelFetch(fetcher: FetcherImpl): Promise<void> {
    return bidi.bidiCancelFetch(this as unknown as bidi.BidiSessionInternal, fetcher);
  }

  /**
   * REQUEST_UPDATE を送信する
   *
   * draft-ietf-moq-transport-21 Section 9.5 (REQUEST_UPDATE):
   * REQUEST_UPDATE はリクエストと同じ双方向ストリーム上で送信する。
   *
   * REQUEST_UPDATE Message {
   *   Type (i) = 0x2,
   *   Length (16),
   *   Request ID (i),
   *   Parameters (..) ...
   * }
   */
  private sendRequestUpdate(
    subscriber: SubscriberImpl,
    options: RequestUpdateOptions,
  ): Promise<void> {
    return bidi.bidiSendRequestUpdate(
      this as unknown as bidi.BidiSessionInternal,
      subscriber,
      options,
    );
  }

  /**
   * PUBLISH リクエストの双方向ストリームからレスポンスを読み取る
   *
   * draft-ietf-moq-transport-21 Section 9.3 (REQUEST_OK):
   * PUBLISH_OK は双方向ストリーム上の最初のレスポンスとして送信される。
   * その後、同じストリームで REQUEST_UPDATE の応答も受信する。
   * draft-ietf-moq-transport-21 Section 6.3
   */
  private readPublishResponse(
    requestId: bigint,
    stream: WebTransportBidirectionalStream,
    controlReader: ControlStreamReader,
  ): Promise<void> {
    return bidi.bidiReadPublishResponse(
      this as unknown as bidi.BidiSessionInternal,
      requestId,
      stream,
      controlReader,
    );
  }

  /**
   * SUBSCRIBE リクエストの双方向ストリームからレスポンスを読み取る
   *
   * draft-ietf-moq-transport-21 Section 9.7 (SUBSCRIBE_OK):
   * SUBSCRIBE_OK は双方向ストリーム上の最初のレスポンスとして送信される。
   * draft-ietf-moq-transport-21 Section 6.3
   */
  private readSubscribeResponse(
    requestId: bigint,
    stream: WebTransportBidirectionalStream,
    controlReader: ControlStreamReader,
  ): Promise<void> {
    return bidi.bidiReadSubscribeResponse(
      this as unknown as bidi.BidiSessionInternal,
      requestId,
      stream,
      controlReader,
    );
  }

  /**
   * FETCH リクエストの双方向ストリームからレスポンスを読み取る
   *
   * draft-ietf-moq-transport-21 Section 9.12 (FETCH_OK):
   * FETCH_OK は双方向ストリーム上の最初のレスポンスとして送信される。
   * draft-ietf-moq-transport-21 Section 6.3
   */
  private readFetchResponse(
    requestId: bigint,
    stream: WebTransportBidirectionalStream,
    controlReader: ControlStreamReader,
  ): Promise<void> {
    return bidi.bidiReadFetchResponse(
      this as unknown as bidi.BidiSessionInternal,
      requestId,
      stream,
      controlReader,
    );
  }

  /**
   * TRACK_STATUS リクエストの双方向ストリームからレスポンスを読み取る
   *
   * draft-ietf-moq-transport-21 Section 9.13 (TRACK_STATUS):
   * TRACK_STATUS へのレスポンスは REQUEST_OK で返される。
   * draft-ietf-moq-transport-21 Section 6.3
   */
  private readTrackStatusResponse(
    requestId: bigint,
    stream: WebTransportBidirectionalStream,
    controlReader: ControlStreamReader,
  ): Promise<void> {
    return bidi.bidiReadTrackStatusResponse(
      this as unknown as bidi.BidiSessionInternal,
      requestId,
      stream,
      controlReader,
    );
  }

  /**
   * データストリームの受信待ちタイマーを作る
   *
   * draft-ietf-moq-transport-21 §12.2:
   * DATA_STREAM_TIMEOUT (0x12) は「ピアが開いたデータストリームで送るべき
   * データを送るのに時間をかけすぎた」ことを示す。半端なヘッダー / Object を
   * 保持したまま待ち続けるピアにメモリとコネクションを占有され続けないよう、
   * 途中バイトが残っている間だけ期限を張る。
   *
   * 期限切れではセッションを閉じたうえで reader を cancel する。セッション終了で
   * ストリームの読み取りが終わらない実装でも読み取りループが終わるようにするため
   * である。
   *
   * @param reader - 対象ストリームの reader
   * @param bufferedBytes - エラーメッセージに載せる残バッファ長
   */
  private createDataStreamTimeout(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    bufferedBytes: () => number,
  ): { arm: () => void; clear: () => void } {
    let handle: ReturnType<typeof setTimeout> | null = null;
    const clear = (): void => {
      if (handle !== null) {
        clearTimeout(handle);
        handle = null;
      }
    };
    const arm = (): void => {
      clear();
      if (this.dataStreamTimeoutMs <= 0) {
        return;
      }
      handle = setTimeout(() => {
        handle = null;
        if (this.sessionState === "connected") {
          this.closeWithError(
            new SessionError(
              `data stream timed out waiting for the rest of a header or object: ${bufferedBytes()} bytes buffered`,
              SessionErrorCode.DATA_STREAM_TIMEOUT,
            ),
          );
        }
        void reader.cancel("data stream timeout").catch(() => {});
      }, this.dataStreamTimeoutMs);
    };
    return { arm, clear };
  }

  /**
   * 受信タイムアウトの設定を反映する
   *
   * draft-ietf-moq-transport-21 §12.2:
   * CONTROL_MESSAGE_TIMEOUT (0x11) / DATA_STREAM_TIMEOUT (0x12) は、ピアが
   * 制御メッセージへの応答・データストリームの送信に時間をかけすぎたことを
   * 示すコードである。半端なメッセージや Object を保持したまま待ち続ける
   * ピアにメモリとコネクションを占有され続けないよう、期限を設ける。
   * 0 以下を指定するとタイムアウトしない。
   */
  private applyTimeoutOptions(options?: {
    controlMessageTimeoutMs?: number;
    dataStreamTimeoutMs?: number;
  }): void {
    this.controlMessageTimeoutMs =
      options?.controlMessageTimeoutMs ?? DEFAULT_CONTROL_MESSAGE_TIMEOUT_MS;
    this.dataStreamTimeoutMs = options?.dataStreamTimeoutMs ?? DEFAULT_DATA_STREAM_TIMEOUT_MS;
  }

  private startControlMessageLoop(): void {
    sessionStartControlMessageLoop(this as unknown as SessionLifecycleInternal);
  }

  /**
   * 制御ストリームの閉鎖を PROTOCOL_VIOLATION として扱う
   *
   * draft-ietf-moq-transport-21 §6.3:
   * 「A control stream MUST NOT be closed at the underlying transport layer
   *  during the session's lifetime.  Doing so results in the session being
   *  closed as a PROTOCOL_VIOLATION.」
   * FIN 経路 (done) と RESET_STREAM 経路 (isPeerStreamError) で
   * sessionState === "connected" のガードを共通化し、片方だけの修正漏れと
   * 既に閉じたセッションへの誤通知を防ぐ。
   */
  closeControlStreamViolation(message: string): void {
    sessionCloseControlStreamViolation(this as unknown as SessionLifecycleInternal, message);
  }

  /**
   * 制御ストリーム上のメッセージを処理する
   *
   * draft-ietf-moq-transport-21 Section 6.3:
   * リクエスト/レスポンス (SUBSCRIBE_OK, PUBLISH_OK, FETCH_OK, REQUEST_OK,
   * REQUEST_ERROR) は双方向ストリームに移動した。
   * 制御ストリームに残るのは GOAWAY のみ。
   * draft-ietf-moq-transport-21 Section 6.3
   *
   * draft-ietf-moq-transport-21 Section 9.14 (PUBLISH_NAMESPACE):
   * PUBLISH_NAMESPACE は新しい双方向ストリームの先頭メッセージとして送信される。
   * 制御ストリーム上で受信した場合は PROTOCOL_VIOLATION でセッションを閉じる。
   */
  private handleControlMessage(type: number, payload: Uint8Array): void {
    sessionHandleControlMessage(this as unknown as SessionLifecycleInternal, type, payload);
  }

  /**
   * GOAWAY メッセージを処理する
   *
   * draft-ietf-moq-transport-21 Section 9.2 (GOAWAY):
   * GOAWAY を受信したエンドポイントは SUBSCRIBE, PUBLISH, FETCH, PUBLISH_NAMESPACE,
   * SUBSCRIBE_NAMESPACE, TRACK_STATUS を含む新規リクエストを peer に対して
   * 開始すべきでない。
   *
   * 複数の GOAWAY メッセージを受信した場合、エンドポイントは PROTOCOL_VIOLATION で
   * セッションを終了しなければならない。
   */
  handleGoaway(payload: Uint8Array): Record<string, unknown> {
    return sessionHandleGoaway(this as unknown as SessionLifecycleInternal, payload);
  }

  /**
   * NamespaceSubscription オブジェクトを作成する
   */
  createNamespaceSubscription(requestId: bigint): NamespaceSubscription {
    const getState = (): "active" | "closed" => {
      const sub = this.namespaceSubscriptions.get(requestId);
      return sub?.state ?? "closed";
    };

    const unsubscribe = async (): Promise<void> => {
      await this.closeNamespaceSubscription(requestId);
    };

    // fire-and-forget で update() を呼び出しても、unsubscribe() / ピアの
    // FIN 等による reject が unhandled rejection にならないよう、catch を
    // 付けた promise を返す。async の wrapper 経由にすると wrapper 側の
    // 無観測 reject が unhandled になるため、ここで必ず捕まえる。
    const update = (options: NamespaceUpdateOptions): Promise<void> => {
      const promise = this.sendNamespaceRequestUpdate(requestId, "namespace", options);
      promise.catch(() => {});
      return promise;
    };

    return {
      get state() {
        return getState();
      },
      unsubscribe,
      update,
    };
  }

  /**
   * Namespace / Tracks サブスクリプションの Track Namespace Prefix を更新する
   *
   * draft-ietf-moq-transport-21 §9.5.2 (Updating Namespace Subscriptions):
   * REQUEST_UPDATE に TRACK_NAMESPACE_PREFIX パラメータを含めて送信する。
   * Tracks 系では draft-ietf-moq-transport-21 §9.20.19 の FORWARD も送り得る。
   * 送信と応答待ちは bidi.bidiSendNamespaceRequestUpdate が行う。
   * kind が namespace の場合、forward が混入しても送らない。
   */
  private async sendNamespaceRequestUpdate(
    requestId: bigint,
    kind: "namespace" | "tracks",
    options: TracksUpdateOptions,
  ): Promise<void> {
    const subscription =
      kind === "namespace"
        ? this.namespaceSubscriptions.get(requestId)
        : this.tracksSubscriptions.get(requestId);
    if (!subscription || subscription.state !== "active" || !subscription.writer) {
      throw new Error(`${kind} subscription is not active`);
    }
    return bidi.bidiSendNamespaceRequestUpdate(
      this as unknown as bidi.BidiSessionInternal,
      requestId,
      subscription.writer,
      options,
    );
  }

  /**
   * Namespace サブスクリプションを閉じる
   *
   * draft-ietf-moq-transport-21 §4.1:
   * SUBSCRIBE_NAMESPACE は FIN または RESET_STREAM でストリームを閉じることで
   * キャンセルできる。
   */
  private async closeNamespaceSubscription(requestId: bigint): Promise<void> {
    const subscription = this.namespaceSubscriptions.get(requestId);
    if (!subscription || subscription.state === "closed") {
      return;
    }

    subscription.state = "closed";

    // 保留中の REQUEST_UPDATE (update() の Promise) を失敗させ、pendingPrefix を
    // クリアする。掃除しないと update() が未解決のまま残り、pendingRequestUpdate
    // エントリがセッション close まで残留する (MAX_REQUEST_UPDATES のカウント
    // 継続)。エラー文言は FIN 経路と共通の定数を使う。
    namespaceLoops.rejectPendingNamespaceUpdates(
      this as unknown as SessionInternal,
      requestId,
      subscription,
      new Error(namespaceLoops.REQUEST_UPDATE_STREAM_CLOSED_MESSAGE),
    );

    // draft-ietf-moq-transport-21 §4.1 / §6.4.2.3:
    // SUBSCRIBE_NAMESPACE の解除は RESET_STREAM (writer.abort()) と
    // STOP_SENDING (reader.cancel()) で行う。
    await this.cancelNamespaceStream(
      subscription.streamReader,
      subscription.writer,
      "namespace subscription cancelled",
    );

    this.namespaceSubscriptions.delete(requestId);
  }

  /**
   * TracksSubscription オブジェクトを作成する
   *
   * draft-ietf-moq-transport-21 §9.18 (SUBSCRIBE_TRACKS)
   */
  createTracksSubscription(requestId: bigint): TracksSubscription {
    const getState = (): "active" | "closed" => {
      const sub = this.tracksSubscriptions.get(requestId);
      return sub?.state ?? "closed";
    };

    const unsubscribe = async (): Promise<void> => {
      await this.closeTracksSubscription(requestId);
    };

    // createNamespaceSubscription の update と同様に、fire-and-forget 時の
    // 無観測 reject を抑制する (catch 付き promise を直接返す)。
    const update = (options: TracksUpdateOptions): Promise<void> => {
      const promise = this.sendNamespaceRequestUpdate(requestId, "tracks", options);
      promise.catch(() => {});
      return promise;
    };

    return {
      get state() {
        return getState();
      },
      unsubscribe,
      update,
    };
  }

  /**
   * Tracks サブスクリプションを閉じる
   *
   * draft-ietf-moq-transport-21 §4.1:
   * SUBSCRIBE_TRACKS は FIN または RESET_STREAM でストリームを閉じることで
   * キャンセルできる。
   */
  private async closeTracksSubscription(requestId: bigint): Promise<void> {
    const subscription = this.tracksSubscriptions.get(requestId);
    if (!subscription || subscription.state === "closed") {
      return;
    }

    subscription.state = "closed";

    // 保留中の REQUEST_UPDATE (update() の Promise) を失敗させ、pendingPrefix を
    // クリアする (closeNamespaceSubscription と同様の理由)。
    namespaceLoops.rejectPendingNamespaceUpdates(
      this as unknown as SessionInternal,
      requestId,
      subscription,
      new Error(namespaceLoops.REQUEST_UPDATE_STREAM_CLOSED_MESSAGE),
    );

    // draft-ietf-moq-transport-21 §4.1 / §6.4.2.3:
    // SUBSCRIBE_TRACKS の解除は RESET_STREAM (writer.abort()) と
    // STOP_SENDING (reader.cancel()) で行う。
    await this.cancelNamespaceStream(
      subscription.streamReader,
      subscription.writer,
      "tracks subscription cancelled",
    );

    this.tracksSubscriptions.delete(requestId);
  }

  /**
   * NamespacePublication オブジェクトを作成する
   */
  createNamespacePublication(requestId: bigint): NamespacePublication {
    // 内部状態の "pending" は REQUEST_OK 受信前のみで、外部に公開する前に "active" になる
    const getState = (): "active" | "closed" => {
      const pub = this.namespacePublications.get(requestId);
      if (!pub) return "closed";
      return pub.state === "active" ? "active" : "closed";
    };

    const getNamespace = (): string[] => {
      const pub = this.namespacePublications.get(requestId);
      return pub?.namespace ?? [];
    };

    const done = async (): Promise<void> => {
      await this.closeNamespacePublication(requestId);
    };

    return {
      get state() {
        return getState();
      },
      get namespace() {
        return getNamespace();
      },
      done,
    };
  }

  /**
   * Namespace 公開を終了する
   *
   * draft-ietf-moq-transport-21 §4.2:
   * PUBLISH_NAMESPACE_DONE / PUBLISH_NAMESPACE_CANCEL は廃止され、
   * 公開の終了は双方向ストリームを FIN または RESET_STREAM で閉じることで通知する。
   * https://www.ietf.org/archive/id/draft-ietf-moq-transport-21.html#section-4.2
   */
  private async closeNamespacePublication(requestId: bigint): Promise<void> {
    const publication = this.namespacePublications.get(requestId);
    if (!publication || publication.state === "closed") {
      return;
    }

    publication.state = "closed";

    // draft-ietf-moq-transport-21 §4.2 / §6.4.2.3:
    // PUBLISH_NAMESPACE の撤回は RESET_STREAM (writer.abort()) と
    // STOP_SENDING (reader.cancel()) で行う。
    await this.cancelNamespaceStream(
      publication.streamReader,
      publication.writer,
      "namespace publication cancelled",
    );

    this.namespacePublications.delete(requestId);
  }

  private startIncomingStreamLoop(): void {
    void (async () => {
      const reader = this.transport.incomingUnidirectionalStreams.getReader();

      try {
        while (this.sessionState === "connected") {
          const { value: stream, done } = await reader.read();
          if (done) break;

          void this.handleIncomingStream(stream);
        }
      } catch (err) {
        // デバッグ: ストリームループエラー
        this.callbacks.debug?.({
          direction: "recv",
          type: 0,
          typeName: "STREAM_LOOP_ERROR",
          payload: new Uint8Array(0),
          decoded: {
            error: err instanceof Error ? err.message : String(err),
          },
          timestamp: Date.now(),
        });
        this.notifyErrorIfActive(err instanceof Error ? err : new Error(String(err)));
      } finally {
        reader.releaseLock();
      }
    })();
  }

  /**
   * datagram 受信ループを開始する
   * draft-ietf-moq-transport-21 Section 11.2 (Datagrams)
   */
  private startDatagramLoop(): void {
    void (async () => {
      const reader = this.transport.datagrams.readable.getReader();

      try {
        while (this.sessionState === "connected") {
          const { value, done } = await reader.read();
          if (done) break;

          if (value) {
            this.handleIncomingDatagram(value);
          }
        }
      } catch (err) {
        this.callbacks.debug?.({
          direction: "recv",
          type: 0,
          typeName: "DATAGRAM_LOOP_ERROR",
          payload: new Uint8Array(0),
          decoded: {
            error: err instanceof Error ? err.message : String(err),
          },
          timestamp: Date.now(),
        });
        this.notifyErrorIfActive(err instanceof Error ? err : new Error(String(err)));
      } finally {
        reader.releaseLock();
      }
    })();
  }

  /**
   * 受信双方向ストリームの監視ループを開始する
   *
   * draft-ietf-moq-transport-21 §9.18 (SUBSCRIBE_TRACKS):
   * SUBSCRIBE_TRACKS への応答として、サーバーは新規双方向ストリームを開き
   * PUBLISH メッセージを送信する。このループで incomingBidirectionalStreams を
   * 監視し、到着した双方向ストリームを処理する。
   *
   * draft-ietf-moq-transport-21 §6.3 (Session initialization):
   * 双方向ストリームは特定のメッセージタイプで開始されなければならない。
   */
  private startIncomingBidirectionalStreamLoop(): void {
    void (async () => {
      const reader = this.transport.incomingBidirectionalStreams.getReader();
      this.incomingBidiStreamReader = reader;

      try {
        while (this.sessionState === "connected") {
          const { value: stream, done } = await reader.read();
          if (done) break;

          void this.handleIncomingBidirectionalStream(stream);
        }
      } catch (err) {
        this.notifyErrorIfActive(err instanceof Error ? err : new Error(String(err)));
      } finally {
        reader.releaseLock();
      }
    })();
  }

  /**
   * PUBLISH ストリームの後続メッセージ読み取りサブループ
   */
  private async runPublishStreamSubLoop(
    impl: SubscriberImpl,
    publishRequestId: bigint,
    subReader: ReadableStreamDefaultReader<Uint8Array>,
    subControlReader: ControlStreamReader,
  ): Promise<void> {
    // draft-ietf-moq-transport-21 §9.2:
    // GOAWAY 受信後も読み取りを継続して 2 通目以降の GOAWAY を検出するための
    // フラグ。GOAWAY 受信時は state 遷移を行わないため、catch での spurious
    // error 通知を抑止する判定に使う。
    let goawayReceived = false;
    try {
      while (impl.state === "active") {
        const { value, done } = await subReader.read();
        if (done) {
          // draft-ietf-moq-transport-21 §9.5.1:
          // 応答を待たずにストリームが閉じた場合は保留中の更新の失敗として、
          // アプリの update() の Promise を reject する (bidiReadRequestStreamMessages
          // の FIN ケースと同じ。GOAWAY 掃除と二重 reject にならないよう、
          // エントリ削除済みなら no-op になる)。reject はアプリの error
          // コールバック例外の影響を受けないよう、通知の前に置く。
          bidi.rejectPendingRequestUpdates(
            this as unknown as bidi.BidiSessionInternal,
            publishRequestId,
            new Error(namespaceLoops.REQUEST_UPDATE_STREAM_CLOSED_MESSAGE),
          );
          // draft-ietf-moq-transport-21 §6.4.2.2:
          // 受信 PUBLISH の subscriber (impl) が、ピア (publisher) の
          // PUBLISH_DONE を送らない FIN を受けた場合は失敗扱いであり、
          // subscriber に通知する (通知のガードは free function 内で行う)。
          bidi.notifySubscriberFailure(
            this as unknown as bidi.BidiSessionInternal,
            publishRequestId,
            new Error(bidi.FIN_WITHOUT_PUBLISH_DONE_MESSAGE),
          );
          return;
        }

        const messages = subControlReader.feed(value);
        // draft-ietf-moq-transport-21 §9.1.7 (MAX_REQUEST_UPDATES):
        // この read の先頭の未応答数を記録し、メッセージ列の処理を終えた時点で
        // 記録した値へ戻す (チャンク単位の減算。加算は受信 1 通ごとに
        // bidiHandlePublishRequestUpdate が行う)。1 通ごとに減算すると、応答の
        // 書き込みを await してから次のメッセージへ進む構造のため未応答数が
        // 常に 0 か 1 にしかならず、同じ read に含まれる N+1 通目を検出できない。
        const requestUpdateCountBeforeRead =
          this.receivedRequestUpdateCounts.get(publishRequestId) ?? 0;
        try {
          for (const msg of messages) {
            this.emitDebug("recv", msg.type, msg.payload);

            if (msg.type === MessageType.PUBLISH_DONE) {
              bidi.bidiHandlePublishDone(
                this as unknown as bidi.BidiSessionInternal,
                msg.payload,
                publishRequestId,
              );
              continue;
            }
            if (msg.type === MessageType.PUBLISH_STATE_NOTIFY) {
              // draft-ietf-moq-transport-21 §9.10:
              // 受信 PUBLISH で確立した購読への publisher 発の状態通知を受理する。
              // 応答は送信しない。受信 PUBLISH 経路は subscriber 側のため
              // ロールは subscribe として扱う。閉鎖後は打ち切る。
              if (
                !bidi.bidiHandlePublishStateNotify(
                  this as unknown as bidi.BidiSessionInternal,
                  msg.payload,
                  publishRequestId,
                  "subscribe",
                )
              ) {
                return;
              }
              if (this.sessionState !== "connected") {
                return;
              }
              continue;
            }
            if (msg.type === MessageType.GOAWAY) {
              const goawayError = bidi.validateNoDuplicateGoawayOnRequestStream(
                publishRequestId,
                this.goawayReceivedOnRequestStreams,
              );
              if (goawayError !== null) {
                this.closeWithError(goawayError);
                return;
              }
              const decodedMsg = decodeGoawayPayload(msg.payload);
              try {
                impl.goawayCallback?.(decodedMsg.newSessionUri);
              } catch {
                // アプリのコールバック例外はプロトコル違反ではないため黙殺する。
                // 黙殺しないと後続の pendingRequestUpdate 掃除や close() が
                // 実行されず、update() の Promise が未解決のまま残る。
              }
              goawayReceived = true;
              // draft-ietf-moq-transport-21 §9.2:
              // GOAWAY 受信時点で旧ストリーム上の未応答 REQUEST_UPDATE は失敗
              // として扱う (受信 PUBLISH の subscriber として送信済みの update()
              // の Promise を未解決のまま残さない)。GOAWAY 後の読み取り継続中に
              // REQUEST_OK / REQUEST_ERROR が届いても、エントリ削除済みのため
              // 二重解決しない。
              // 失敗が確定した更新の fill 関連付けも消す (確定済みの fill は残す)。
              bidi.deleteFillTargetsForPendingUpdates(
                this as unknown as bidi.BidiSessionInternal,
                publishRequestId,
              );
              bidi.rejectPendingRequestUpdates(
                this as unknown as bidi.BidiSessionInternal,
                publishRequestId,
                new RequestError(bidi.REQUEST_GOING_AWAY_REASON, RequestErrorCode.GOING_AWAY),
              );
              // GOAWAY 受信後も読み取りを継続して 2 通目以降の GOAWAY を検出する
              // (§9.2 MUST)。受信 PUBLISH の subscriber (impl) は送信方向を
              // FIN (writer.close()) で閉じ、受信方向は読み取りを継続する。
              await bidi.closeRequestStreamWriter(
                this as unknown as bidi.BidiSessionInternal,
                publishRequestId,
              );
              continue;
            }
            if (msg.type === MessageType.REQUEST_UPDATE) {
              // draft-ietf-moq-transport-21 §9.5 ケース 1:
              // 「The sender of a request (SUBSCRIBE, PUBLISH, FETCH,
              // PUBLISH_NAMESPACE, SUBSCRIBE_NAMESPACE, SUBSCRIBE_TRACKS) can
              // later send a REQUEST_UPDATE on the same bidi stream as the
              // request to modify it.」
              // 受信 PUBLISH の publisher (ピア) による REQUEST_UPDATE を処理し、
              // REQUEST_OK / REQUEST_ERROR を 1 通応答する (§9.5 MUST)。
              // GOAWAY 受信後 / ID 検証 / パラメータスコープ検証 /
              // 文脈限定パラメータの判定は free function 内で行う (GOING_AWAY
              // 応答も同関数の判定順序 (2) が担う)。スコープ違反等でセッションが
              // 閉じた場合は、同一チャンクの残りメッセージの処理を打ち切る。
              await bidi.bidiHandlePublishRequestUpdate(
                this as unknown as bidi.BidiSessionInternal,
                publishRequestId,
                msg.payload,
              );
              if (this.sessionState !== "connected") {
                return;
              }
              continue;
            }
            if (msg.type === MessageType.REQUEST_OK) {
              bidi.bidiHandleRequestUpdateOk(
                this as unknown as bidi.BidiSessionInternal,
                msg.payload,
                publishRequestId,
              );
              // draft-ietf-moq-transport-21 §9.5:
              // bidiHandleRequestUpdateOk は REQUEST_UPDATE_OK のパラメータスコープ違反、
              // 未知の Mandatory Track Property、未応答の REQUEST_UPDATE が無い
              // REQUEST_OK の 3 箇所でセッションを閉じ得る。
              // 同一チャンクの残りメッセージを処理し続けると、後続メッセージが
              // 別のセッション終了を検出して error コールバックが二重に通知されるため、
              // 閉じた場合は読み取りループを終える
              // (PUBLISH_STATE_NOTIFY / REQUEST_UPDATE 分岐と同じ判定)。
              if (this.sessionState !== "connected") {
                return;
              }
              continue;
            }
            if (msg.type === MessageType.REQUEST_ERROR) {
              const decoded = decodeRequestErrorPayload(msg.payload);
              const error = new RequestError(
                decoded.reasonPhrase || `Request failed with code ${decoded.errorCode}`,
                normalizeRequestErrorCode(Number(decoded.errorCode)),
              );
              // draft-ietf-moq-transport-21 §9.5: coalescing により単一 REQUEST_ERROR で
              // 複数の REQUEST_UPDATE が失敗し得る。該当 pending をすべて reject する。
              // 失敗が確定した更新の fill 関連付けも消す (確定済みの fill は残す)。
              bidi.deleteFillTargetsForPendingUpdates(
                this as unknown as bidi.BidiSessionInternal,
                publishRequestId,
              );
              // §9.5.1: coalescing は失敗分をまとめるだけであり、in-flight だった
              // 成功分の更新への REQUEST_OK は別途届く。消した件数分を許容枠に積む。
              bidi.allowUnmatchedRequestOks(
                this as unknown as bidi.BidiSessionInternal,
                publishRequestId,
                bidi.rejectPendingRequestUpdates(
                  this as unknown as bidi.BidiSessionInternal,
                  publishRequestId,
                  error,
                ),
              );
              continue;
            }
            // 未知のメッセージタイプは PROTOCOL_VIOLATION
            this.closeWithError(
              new SessionError(
                `unknown message type on publish stream: 0x${msg.type.toString(16)}`,
                SessionErrorCode.PROTOCOL_VIOLATION,
              ),
            );
            return;
          }
        } finally {
          bidi.restoreIncomingRequestUpdateCount(
            this as unknown as bidi.BidiSessionInternal,
            publishRequestId,
            requestUpdateCountBeforeRead,
          );
        }
      }
    } catch (err) {
      // draft-ietf-moq-transport-21 §9.2:
      // GOAWAY 受信後 (goawayReceived) は state が active のままのため、
      // spurious error 通知を抑止する (namespace ループと同様)
      if (impl.state === "active" && !goawayReceived) {
        const normalizedError = err instanceof Error ? err : new Error(String(err));
        // 応答待ちの更新は失敗として reject する (source を問わない。兄弟分岐・
        // namespace ループと同順。通知より先に実行することで、アプリの error
        // コールバックが throw しても reject が実行される。reject しないと
        // update() が永続ハングするため)。
        bidi.rejectPendingRequestUpdates(
          this as unknown as bidi.BidiSessionInternal,
          publishRequestId,
          new Error(namespaceLoops.REQUEST_UPDATE_STREAM_CLOSED_MESSAGE),
        );
        if (isSessionClosedError(normalizedError)) {
          // WebTransport セッション終了起因のエラーは購読者へ通知しないが、
          // state は closed にする (namespace ループと同規則。仕様はセッション
          // 終了時の購読単位の扱いを定めていないため、namespace ループと同じ
          // 実装上の判断として揃える。セッション終了は ConnectCallbacks.close
          // で検知されるが、request 単位の state を active に残す理由はない。
          // ConnectCallbacks.close と購読通知は別チャネルのため二重の失敗通知
          // にはならない)。
          impl.markClosed();
        } else if (isPeerStreamError(err)) {
          // draft-ietf-moq-transport-21 §6.4.2.3:
          // ピアの RESET_STREAM で readable がエラー終了した場合 (source: "stream") は、
          // subscribe ロール側と同じく error 通知 + state closed にする。仕様は
          // ピアの RESET_STREAM を受けた側のアプリへの通知内容も subscription state
          // の扱いも規定していない (§6.4.2.3 は RESET_STREAM / STOP_SENDING の手段と
          // rejection 時の応答を定めるのみ) ため、subscribe ロール側と同じ実装上の
          // 判断として揃える。
          // 通知と markClosed は notifySubscriberFailure の内部契約 (try/finally) に
          // 委ねるため、impl 直結の通知は行わない (二重通知になる)。
          // notifySubscriberFailure は subscribers から引くため、unsubscribe 済みで
          // エントリが削除された窓では通知しない (subscribe ロール側と同じ)。
          // 通知メッセージは subscribe ロール側と同一の組み立てを使う
          // (ピアのエラーコード付き、取得不可時は固定文言)。
          // draft-ietf-moq-transport-21 §6.4.2.2 / §9.5.1:
          // RESET_STREAM は FIN よりも強い終了であり、応答未達の REQUEST_UPDATE は
          // FIN 経路と同様に失敗として扱う (上記の先行 reject)。
          // 内側に try/catch が必要なのは、catch ブロック内で throw すると戻り値の
          // Promise が reject し、呼び出し元の requestStreams / subscribers の
          // クリーンアップがスキップされるためである。ここが守るのはこの通知経路
          // だけである (セッションレベルの error コールバック例外が伝播する経路は
          // 別途対応)。
          try {
            bidi.notifySubscriberFailure(
              this as unknown as bidi.BidiSessionInternal,
              publishRequestId,
              bidi.createResetStreamError(err),
            );
          } catch {
            // アプリの error コールバック例外は吸収する (markClosed は
            // notifySubscriberFailure 内の finally で実行済み)。
          }
        } else {
          // source を持たない内部例外は、namespace ループと同規則で error 通知
          // + state closed にする (従来は通知のみで state が active のまま残った。
          // 仕様は内部エラー時の購読単位の扱いを定めていないため、namespace
          // ループと同じ実装上の判断として揃える)。
          // 通知と markClosed は stream 分岐と同じく notifySubscriberFailure の
          // 内部契約に委ねる (応答待ちの更新は上記で先行 reject 済み)。
          try {
            bidi.notifySubscriberFailure(
              this as unknown as bidi.BidiSessionInternal,
              publishRequestId,
              normalizedError,
            );
          } catch {
            // アプリの error コールバック例外は吸収する (markClosed は
            // notifySubscriberFailure 内の finally で実行済み)。
          }
        }
      }
      // SessionError はそのコードのまま、ProtocolViolationError / IncompleteDataError は PROTOCOL_VIOLATION で閉じる
      const sessionError = toSessionCloseError(err);
      if (sessionError !== null) {
        this.closeWithError(sessionError);
      }
    }
  }

  /**
   * 受信 PUBLISH の AUTHORIZATION TOKEN パラメータを処理する
   *
   * draft-ietf-moq-transport-21 §9.20.3 / §8.9:
   * §8.9 の MUST により REGISTER はメッセージが他の理由 (UNINTERESTED 等) で
   * 失敗しても登録を維持するため、購読マッチング判定より前に処理する。
   * デコード不能 (KEY_VALUE_FORMATTING_ERROR)・登録済み Alias の再 REGISTER
   * (DUPLICATE_AUTH_TOKEN_ALIAS)・上限超過 (AUTH_TOKEN_CACHE_OVERFLOW) は
   * セッションを閉じる。
   *
   * 未登録 Alias の参照も Session Termination の UNKNOWN_AUTH_TOKEN_ALIAS (0x17) で
   * セッションを閉じる。REQUEST_ERROR ではなく Session Termination を選ぶ理由、
   * §6.6 の留保の判断、§9.1.4 の MUST NOT に抵触しないことは
   * `processIncomingRequestUpdateAuthorizationTokens` の JSDoc に集約している
   * (同じ規範判断をこのファイルと bidi.ts で二重に保守しないため)。
   *
   * §9.5.1 の PUBLISH_DONE (UPDATE_FAILED) は REQUEST_UPDATE に対する publisher の
   * MUST であり、受信 PUBLISH の拒否には適用しない。
   *
   * @returns 処理を継続してよい場合は true、セッション終了または当該 PUBLISH の
   *   打ち切りで中断すべき場合は false
   */
  private processIncomingPublishAuthorizationTokens(
    requestId: bigint,
    parameters: Array<{ type: number; value: Uint8Array }>,
  ): boolean {
    let result: AuthTokenProcessResult;
    try {
      result = processMessageAuthorizationTokens(this.receivedAuthTokens, parameters);
    } catch (err) {
      // SessionError はそのコードのままセッションを閉じる。§8.9 が定める
      // DUPLICATE_AUTH_TOKEN_ALIAS / AUTH_TOKEN_CACHE_OVERFLOW /
      // KEY_VALUE_FORMATTING_ERROR がここに来る。
      const sessionError = toSessionCloseError(err);
      if (sessionError === null) {
        // SessionError 以外の例外はセッション終了を意味しない。本メソッドは
        // fire-and-forget で呼ばれる handleIncomingBidirectionalStream の
        // 「throw しない」契約の下にあるため再 throw せず、当該 PUBLISH の
        // 処理だけを打ち切る。processMessageAuthorizationTokens は
        // SessionError しか投げないため、この分岐は防御的である。
        return false;
      }
      this.closeWithError(sessionError);
      return false;
    }
    if (result.status === "unknown-alias") {
      this.closeWithError(
        new SessionError(
          `unknown authorization token alias in PUBLISH: streamRequestId=${requestId} alias=${result.tokenAlias}`,
          SessionErrorCode.UNKNOWN_AUTH_TOKEN_ALIAS,
        ),
      );
      return false;
    }
    return true;
  }

  /**
   * 受信した双方向ストリームを処理する
   *
   * draft-ietf-moq-transport-21 §9.18 (SUBSCRIBE_TRACKS):
   * SUBSCRIBE_TRACKS への応答としてサーバーが開く双方向ストリームでは、
   * 先頭メッセージとして PUBLISH が送信される。
   *
   * draft-ietf-moq-transport-21 §6.3:
   * 双方向ストリームは特定のメッセージタイプで開始されなければならない。
   */
  /**
   * セッションが connected でなければ受信 bidi ストリームを cancel する
   *
   * 接続確立前に届いた受信ストリームは処理せず、読み取りを打ち切る。
   *
   * @param stream - 受信した双方向ストリーム
   * @returns cancel した (呼び出し側は即 return すべき) なら true
   */
  private async cancelIfNotConnected(stream: WebTransportBidirectionalStream): Promise<boolean> {
    if (this.sessionState === "connected") {
      return false;
    }
    try {
      await stream.readable.cancel();
    } catch {
      /* ignore */
    }
    return true;
  }

  /**
   * 受信 bidi ストリームを処理する
   *
   * @param stream - 受信した双方向ストリーム
   */
  private async handleIncomingBidirectionalStream(
    stream: WebTransportBidirectionalStream,
  ): Promise<void> {
    if (await this.cancelIfNotConnected(stream)) {
      return;
    }
    const firstMsg = await this.readFirstBidiMessage(stream);
    if (firstMsg === null) {
      return;
    }

    // 先頭メッセージを 3 分類して処理する
    // draft-ietf-moq-transport-21 §6.3 (Session initialization):
    // 先頭が 7 種以外のメッセージタイプの場合は PROTOCOL_VIOLATION でセッションを閉じる。
    // 7 種のうち未対応のリクエストには NOT_SUPPORTED を応答する (§1.5 SHOULD)。
    // true が返れば先頭メッセージの処理が完了しているため return する。
    if (
      await incomingHandleFirstBidiMessage(this as unknown as SessionInternal, stream, firstMsg)
    ) {
      return;
    }

    // PUBLISH ペイロードをデコード
    // draft-ietf-moq-transport-21 §9.8
    let decodedPublish: ReturnType<typeof decodePublishPayload>;
    try {
      decodedPublish = decodePublishPayload(firstMsg.payload);
    } catch (err) {
      // draft-ietf-moq-transport-21 §3.6:
      // 未知の Mandatory Track Property を含む PUBLISH には
      // REQUEST_ERROR(UNSUPPORTED_EXTENSION) を返す
      if (err instanceof MalformedTrackError) {
        await incomingSendRequestErrorAndClose(
          stream,
          RequestErrorCode.UNSUPPORTED_EXTENSION,
          err.message,
        );
        return;
      }
      // SessionError はそのコードのまま、ProtocolViolationError / IncompleteDataError は PROTOCOL_VIOLATION で閉じる
      const sessionError = toSessionCloseError(err);
      if (sessionError !== null) {
        this.closeWithError(sessionError);
      }
      return;
    }

    const publishRequestId = decodedPublish.requestId;
    const publishTrackAlias = decodedPublish.trackAlias;
    const publishTrackNamespace = trackNamespaceToStrings(decodedPublish.trackNamespace);
    const publishTrackName = new TextDecoder().decode(decodedPublish.trackName);

    this.emitDebug("recv", MessageType.PUBLISH, firstMsg.payload, {
      requestId: publishRequestId.toString(),
      trackAlias: publishTrackAlias.toString(),
      trackNamespace: publishTrackNamespace,
      trackName: publishTrackName,
    });

    // draft-ietf-moq-transport-21 §6.4.2.1 (Request ID):
    // 受信 PUBLISH の Request ID のパリティ (奇数) と重複を検証する。
    // 違反時は INVALID_REQUEST_ID でセッションを閉じる。
    const requestIdError = this.validateIncomingRequestId(publishRequestId);
    if (requestIdError !== null) {
      this.closeWithError(requestIdError);
      return;
    }

    // draft-ietf-moq-transport-21 §9.20.3 / §8.9:
    // PUBLISH の AUTHORIZATION TOKEN パラメータを処理する。§8.9 の MUST は
    // 「セッションエラーにならない限り REGISTER した Alias をキャッシュへ登録する」
    // であるため、セッションエラーにならない拒否 (予約 namespace による
    // DOES_NOT_EXIST 応答等) より前に処理する。
    if (
      !this.processIncomingPublishAuthorizationTokens(publishRequestId, decodedPublish.parameters)
    ) {
      return;
    }

    // draft-ietf-moq-transport-21 §2.4.2 / §6.5:
    // 受信 PUBLISH の Track Namespace 先頭フィールドが "." 単体または
    // ".session" の場合、REQUEST_ERROR (DOES_NOT_EXIST) で拒否してアプリへ
    // 渡さない (§2.4.2 / §6.5 の MUST)。それ以外の予約名前空間
    // (例: ".foo") は §2.4.2 によりアプリへ渡す。
    // 拒否時は §6.4.2.3 の SHOULD に従い REQUEST_ERROR 送信後に送信方向を
    // FIN で閉じ、受信方向を cancel する。パラメータスコープ検証より
    // 先に判定し、両方違反の場合は DOES_NOT_EXIST 拒否を優先する。
    // なお、デコード失敗 (MalformedTrackError 等) はデコード時に先に
    // 検出されるため、この判定に到達するのはデコード成功時のみ。
    if (isRejectedReceiveNamespace(decodedPublish.trackNamespace.tuple)) {
      await incomingSendRequestErrorAndClose(
        stream,
        RequestErrorCode.DOES_NOT_EXIST,
        "request references reserved namespace",
      );
      return;
    }

    // draft-ietf-moq-transport-21 §9.20.1 (Parameter Scope):
    // PUBLISH に許可されていないパラメータは PROTOCOL_VIOLATION
    const scopeError = validateParameterScope(
      decodedPublish.parameters,
      PUBLISH_ALLOWED_PARAMS,
      "PUBLISH",
    );
    if (scopeError !== null) {
      this.closeWithError(scopeError);
      return;
    }

    // trackNamespace がアクティブな tracksSubscriptions の namespacePrefix に前方一致するか検証
    const match = this.matchPublishToSubscription(publishTrackNamespace);
    if (match === null) {
      // draft-ietf-moq-transport-21 §9.8 (SHOULD): マッチしない PUBLISH は UNINTERESTED
      await incomingSendRequestErrorAndClose(stream, RequestErrorCode.UNINTERESTED, "uninterested");
      return;
    }

    // draft-ietf-moq-transport-21 §3.1.2 (Track Alias):
    // 同一 Track Alias が異なる Track に使われている場合は DUPLICATE_TRACK_ALIAS でセッション終了。
    // 同一 Track への複数 PUBLISH は draft-21 §3.1 で許可される。
    // TRACK_PROPERTY_FILTER 評価より先に検証する (フィルタ不通過で UNINTERESTED 応答すると
    // alias 重複というセッション違反が検出されず隠れるため)。
    const existingSubscribers = this.subscribersByAlias.get(publishTrackAlias);
    if (existingSubscribers !== undefined && existingSubscribers.length > 0) {
      // 比較キーは SubscriberImpl.getFullTrackNameKey と同じ生成規則
      // (fullTrackNameKey) に揃える。受信 PUBLISH 側だけ別形式で組み立てると
      // 同一 Track への複数 PUBLISH が不一致になり、DUPLICATE_TRACK_ALIAS で
      // 誤ってセッションを閉じる。
      const trackKey = fullTrackNameKey(publishTrackNamespace, publishTrackName);
      const firstSubscriber = existingSubscribers[0];
      if (firstSubscriber === undefined) {
        // 上の existingSubscribers.length > 0 により到達しない (型を絞るためのガード)
        throw new SessionError(
          `track alias 0x${publishTrackAlias.toString(16)} has no subscriber entry`,
          SessionErrorCode.DUPLICATE_TRACK_ALIAS,
        );
      }
      if (firstSubscriber.getFullTrackNameKey() !== trackKey) {
        this.closeWithError(
          new SessionError(
            `track alias 0x${publishTrackAlias.toString(16)} used for different tracks`,
            SessionErrorCode.DUPLICATE_TRACK_ALIAS,
          ),
        );
        return;
      }
    }

    // draft-ietf-moq-transport-21 §3.3.2:
    // TRACK_PROPERTY_FILTER の評価 (受信 PUBLISH の Track Properties に対する検索)。
    // 通過しない PUBLISH は onPublish を呼ばず、§9.8 の SHOULD に従い
    // REQUEST_ERROR (UNINTERESTED) で応答してストリームの読み取りを放棄する。
    if (
      match.rangeFilters !== undefined &&
      !trackPropertyFiltersMatch(match.rangeFilters, decodedPublish.trackProperties)
    ) {
      await incomingSendRequestErrorAndClose(stream, RequestErrorCode.UNINTERESTED, "uninterested");
      return;
    }

    // onPublish コールバックから SubscribeCallbacks を取得
    let subscribeCallbacks: SubscribeCallbacks;
    try {
      const result = match.callbacks.onPublish?.(match.suffix, publishTrackName);
      if (result === undefined) {
        subscribeCallbacks = { object: () => {} };
      } else {
        const resolved = await result;
        subscribeCallbacks = resolved ?? { object: () => {} };
      }
    } catch {
      // アプリケーションのエラーはプロトコル違反ではない
      try {
        await stream.readable.cancel();
      } catch {
        /* ignore */
      }
      return;
    }

    // SubscriberImpl を生成して登録
    const impl = new SubscriberImpl(
      publishTrackNamespace,
      publishTrackName,
      publishRequestId,
      publishTrackAlias,
      subscribeCallbacks.object,
      subscribeCallbacks.datagram,
      subscribeCallbacks.end,
      subscribeCallbacks.error,
    );
    impl.goawayCallback = subscribeCallbacks.goaway;
    impl.fillErrorCallback = subscribeCallbacks.fillError;

    // draft-ietf-moq-transport-21 §10.4:
    // 受信 PUBLISH の Track Properties から DEFAULT_PUBLISHER_PRIORITY を解決し、
    // Priority 省略時の Subgroup / Datagram に継承させる
    impl.setTrackProperties(decodedPublish.trackProperties);

    // 受信 PUBLISH の初期パラメータを反映する。違反時はセッションを閉じ false を返す。
    if (!this.applyIncomingPublishParameters(impl, decodedPublish.parameters)) {
      return;
    }

    // draft-ietf-moq-transport-21 §3.3.2:
    // SUBSCRIBE_TRACKS 由来のオブジェクトレベル Range Filter (0x25-0x28) を
    // SubscriberImpl に設定し、handleObject / handleDatagram で評価する。
    // TRACK_PROPERTY_FILTER (0x29) は track 単位の評価として既に通過しており、
    // オブジェクト受信経路では評価しないため除外する。
    if (match.rangeFilters !== undefined) {
      const objectLevelFilters = match.rangeFilters.filter(
        (spec) => !("remove" in spec) && spec.type !== "trackProperty",
      );
      impl.setRangeFilters(objectLevelFilters);
    }

    const subControlReader = new ControlStreamReader();
    let subReader: ReadableStreamDefaultReader<Uint8Array>;
    let subWriter: WritableStreamDefaultWriter<Uint8Array>;
    try {
      subReader = stream.readable.getReader();
      subWriter = stream.writable.getWriter();
    } catch {
      // ストリームのロックが取得できない場合
      impl.markClosed();
      return;
    }

    this.subscribers.set(publishRequestId, impl);
    const aliasList = this.subscribersByAlias.get(publishTrackAlias);
    if (aliasList !== undefined) {
      aliasList.push(impl);
    } else {
      this.subscribersByAlias.set(publishTrackAlias, [impl]);
    }
    this.requestStreams.set(publishRequestId, {
      stream,
      writer: subWriter,
      controlReader: subControlReader,
      // 読み取りループ (runPublishStreamSubLoop) が保持する reader を登録し、
      // 解除 (unsubscribe) 時に保持者経由で cancel できるようにする。
      reader: subReader,
    });

    impl.onUnsubscribe = () => {
      return bidi.bidiCancelSubscription(this as unknown as bidi.BidiSessionInternal, impl);
    };
    impl.onUpdate = (options: RequestUpdateOptions) => {
      return bidi.bidiSendRequestUpdate(this as unknown as bidi.BidiSessionInternal, impl, options);
    };

    this.pendingSubgroupBuffer.notifyAlias(publishTrackAlias, "subscriber");

    // PUBLISH_OK を送信 (draft-ietf-moq-transport-21 §3.1 MUST) して
    // 後続メッセージのサブループを回す。
    // 登録以後の一連の処理は try/finally で守り、PUBLISH_OK 書き込み失敗・
    // サブループ脱出のいずれの exit 経路でも後始末 (3 マップの削除 + fill
    // 関連付けの掃除 + ロック解放) を必ず行う。通知は Map 削除より前に行う
    // (notifySubscriberFailure は subscribers.get で対象を引くため)。
    // 本関数は throw しない (fire-and-forget 呼び出しのため。
    // runPublishStreamSubLoop の catch と同形)。
    try {
      const publishOkPayload = encodeRequestOkPayload({
        type: MessageType.REQUEST_OK,
        parameters: [],
        trackProperties: [],
      });
      const controlWriter = new ControlStreamWriter();
      const framed = controlWriter.encode(MessageType.REQUEST_OK, publishOkPayload);
      await subWriter.write(framed);

      // 後続メッセージのサブループ
      await this.runPublishStreamSubLoop(impl, publishRequestId, subReader, subControlReader);
    } catch (error) {
      // PUBLISH_OK 書き込み失敗時は失敗として扱う (§3.1 MUST の PUBLISH_OK を
      // 送れていないため subscription を残さない)。いずれの source でも
      // markClosed し、通知の有無は source で分ける。
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      if (error instanceof Error && isSessionClosedError(error)) {
        // source が "session" の場合: 通知せず state closed とする
        // (runPublishStreamSubLoop のセッション終了起因と同方針)
        impl.markClosed();
      } else {
        // source が "stream" または source なしの場合:
        // error 通知 + state closed とする。ピア起因 (source: "stream") の
        // 場合は subloop 内の RESET 経路と同じ正規化文言で通知する。
        // createResetStreamError は非 Error も吸収するため条件は source のみでよい。
        const notifyError = isPeerStreamError(error)
          ? bidi.createResetStreamError(error)
          : normalizedError;
        try {
          bidi.notifySubscriberFailure(
            this as unknown as bidi.BidiSessionInternal,
            publishRequestId,
            notifyError,
          );
        } catch {
          // アプリの error コールバック例外は吸収する (markClosed は
          // notifySubscriberFailure 内の finally で実行済み)。
        }
      }
    } finally {
      this.cleanupIncomingPublish(publishRequestId, publishTrackAlias, impl, subReader, subWriter);
    }
  }

  /**
   * 受信 PUBLISH の後始末を行う
   *
   * subscribers / subscribersByAlias / requestStreams の削除と fill 関連付けの
   * 掃除、ストリームのロック解放を、exit 経路に依らず必ず実行する。
   *
   * @param publishRequestId - 受信 PUBLISH の Request ID (3 マップの削除キー)
   * @param publishTrackAlias - 受信 PUBLISH の Track Alias (alias 側の特定削除用)
   * @param impl - 生成した SubscriberImpl (alias 側の特定要素削除用)
   * @param subReader - 受信ストリームの reader (ロック解放用)
   * @param subWriter - 応答ストリームの writer (ロック解放用)
   */
  private cleanupIncomingPublish(
    publishRequestId: bigint,
    publishTrackAlias: bigint,
    impl: SubscriberImpl,
    subReader: ReadableStreamDefaultReader<Uint8Array>,
    subWriter: WritableStreamDefaultWriter<Uint8Array>,
  ): void {
    this.requestStreams.delete(publishRequestId);
    this.subscribers.delete(publishRequestId);
    // draft-ietf-moq-transport-21 §9.1.7:
    // ストリーム終了時にストリーム単位の未応答 REQUEST_UPDATE 数を破棄する。
    // 残すと、以後に同じ Request ID のストリームが張られた場合 (および
    // 同一ストリームの残りメッセージ) に古い件数で超過と誤判定する。
    this.receivedRequestUpdateCounts.delete(publishRequestId);
    // 購読の終了に伴い fill 関連付けも不要になるため掃除する。
    bidi.deleteFillTargetsForSubscriber(this as unknown as bidi.BidiSessionInternal, impl);
    // requestId 単位で削除し、alias に他 subscription が無ければエントリ削除
    const aliasSubscribers = this.subscribersByAlias.get(publishTrackAlias);
    if (aliasSubscribers !== undefined) {
      const idx = aliasSubscribers.indexOf(impl);
      if (idx !== -1) {
        aliasSubscribers.splice(idx, 1);
      }
      if (aliasSubscribers.length === 0) {
        this.subscribersByAlias.delete(publishTrackAlias);
      }
    }
    subReader.releaseLock();
    try {
      subWriter.releaseLock();
    } catch {
      /* ignore */
    }
    // draft-ietf-moq-transport-21 §6.6.1:
    // GOAWAY 受信後に受信 PUBLISH の購読が無くなった時点で NO_ERROR で閉じる。
    this.onRequestDrained();
  }

  /**
   * 受信 PUBLISH の初期パラメータを購読に反映する
   *
   * draft-ietf-moq-transport-21 §9.8 (PUBLISH) / §9.20.19:
   * FORWARD (省略時はデフォルト 1) を Forward State として保持する。
   * 値域外は PROTOCOL_VIOLATION でセッションを閉じる。
   * OBJECT_DELIVERY_TIMEOUT / SUBGROUP_DELIVERY_TIMEOUT /
   * SUBSCRIBER_PRIORITY / GROUP_ORDER は publisher の初期値の通知であり
   * 受理のみで状態反映はしない。この関数では再検証しない
   * (FORWARD / GROUP_ORDER の uint8 値域は decode 時に検証済み。
   * varint 系 timeouts / PRIORITY は範囲外で閉じる規定がないため検証しない)。
   * draft-ietf-moq-transport-21 §9.8 / §9.20.10 / §9.18.1:
   * LOCATION_FILTER は購読の初期フィルタとして反映する
   * (省略時は既定値 = 無制限)。End Group 超過は PROTOCOL_VIOLATION で閉じる。
   * draft-ietf-moq-transport-21 §9.20.18 / §3.3.1:
   * LARGEST_OBJECT は LOCATION_FILTER より先に設定する。相対 Location Filter は
   * 「フィルタ適用時点の LARGEST_OBJECT」で解決されるため、この順序で
   * 受信 PUBLISH が運ぶ LARGEST_OBJECT 基準の開始位置に一度だけ確定する。
   * 反映前にすべての値をデコード・検証し、検証通過後にまとめて設定する
   * (違反確定後の部分反映を防ぐ)。
   *
   * @returns 反映できた場合は true、違反でセッションを閉じた場合は false
   */
  private applyIncomingPublishParameters(impl: SubscriberImpl, parameters: Parameter[]): boolean {
    let forwardState: boolean;
    try {
      forwardState = extractForwardState(parameters);
    } catch (error) {
      const sessionError = toProtocolViolationSessionError(error);
      if (sessionError !== null) {
        this.closeWithError(sessionError);
        return false;
      }
      throw error;
    }

    let largestLocation: Location | undefined;
    try {
      largestLocation = extractLargestLocation(parameters);
    } catch (error) {
      const sessionError = toProtocolViolationSessionError(error);
      if (sessionError !== null) {
        this.closeWithError(sessionError);
        return false;
      }
      throw error;
    }

    const locationParam = parameters.find(
      (param) => param.type === MessageParameterType.LOCATION_FILTER,
    );
    let locationFilter: LocationFilter | undefined;
    if (locationParam !== undefined) {
      try {
        locationFilter = decodeLocationFilterParameter(locationParam);
      } catch (error) {
        const sessionError = toProtocolViolationSessionError(error);
        if (sessionError !== null) {
          this.closeWithError(sessionError);
          return false;
        }
        throw error;
      }
    }

    impl.setForwardState(forwardState);
    // LARGEST_OBJECT を先に設定し、setLocationFilter 内の解決に反映させる
    if (largestLocation !== undefined) {
      impl.setLargestLocation(largestLocation);
    }
    if (locationFilter !== undefined) {
      impl.setLocationFilter(locationFilter);
    }
    return true;
  }

  /**
   * PUBLISH の trackNamespace をアクティブな tracksSubscriptions にマッチさせる
   *
   * @returns マッチした subscription の callbacks と suffix、マッチしなければ null
   */
  private matchPublishToSubscription(publishTrackNamespace: string[]): {
    callbacks: TracksSubscriptionCallbacks;
    suffix: string[];
    rangeFilters?: RangeFilterSpec[];
  } | null {
    for (const [, subscription] of this.tracksSubscriptions) {
      if (subscription.state !== "active") {
        continue;
      }
      const suffix = matchNamespacePrefix(publishTrackNamespace, subscription.namespacePrefix);
      if (suffix !== null) {
        // exactOptionalPropertyTypes では optional な rangeFilters に undefined を渡せないため、
        // 値がある場合だけ載せる
        const matched = { callbacks: subscription.callbacks, suffix };
        return subscription.rangeFilters === undefined
          ? matched
          : { ...matched, rangeFilters: subscription.rangeFilters };
      }
    }
    return null;
  }

  /**
   * 受信した datagram を処理する
   * draft-ietf-moq-transport-21 Section 11.2 (Datagrams)
   */
  private handleIncomingDatagram(data: Uint8Array): void {
    incomingHandleDatagram(this as unknown as SessionInternal, data);
  }

  /**
   * 受信 bidi ストリームの先頭メッセージを読み取る
   *
   * 同一チャンクに連結された先頭以降のメッセージは破棄される
   * (先頭メッセージのみを 3 分類の対象とする。既存挙動の継続)。
   *
   * @returns 先頭メッセージ。FIN 検出時・読み取り失敗時は null
   */
  private async readFirstBidiMessage(
    stream: WebTransportBidirectionalStream,
  ): Promise<ControlMessage | null> {
    const firstControlReader = new ControlStreamReader();
    try {
      const firstMsgReader = stream.readable.getReader();
      try {
        while (true) {
          const { value, done } = await firstMsgReader.read();
          if (done) return null;
          const messages = firstControlReader.feed(value);
          if (messages.length > 0) {
            const firstMessage = messages[0];
            if (firstMessage === undefined) {
              // 上の messages.length > 0 により到達しない (型を絞るためのガード)
              return null;
            }
            return firstMessage;
          }
        }
      } finally {
        firstMsgReader.releaseLock();
      }
    } catch (err) {
      this.notifyErrorIfActive(err instanceof Error ? err : new Error(String(err)));
      return null;
    }
  }

  /**
   * 受信リクエストの Request ID のパリティ・重複検証を行う
   *
   * draft-ietf-moq-transport-21 §6.4.2.1 (Request ID):
   * moqt-js はクライアントロールのため、受信 Request ID はサーバー発の奇数が
   * 期待値。違反時は INVALID_REQUEST_ID でセッションを閉じる。
   * 予約 namespace 拒否 / パラメータスコープ検証 / DUPLICATE_TRACK_ALIAS の
   * 各既存検証より前に配置する (§6.4.2.1 の MUST は受信即時閉鎖のため。
   * 未対応経路では検証後に NOT_SUPPORTED 応答が続く)。
   *
   * 適用範囲は受信 PUBLISH と未対応リクエスト 6 種 (先頭メッセージ)
   * および受信 REQUEST_UPDATE の 2 経路 (`bidiHandlePublishRequestUpdate` と
   * `bidiReadRequestStreamMessages` の `REQUEST_UPDATE` ケース)。
   *
   * 注意: `Session` 公開インターフェースの一部ではないが、`SessionImpl` の
   * public メンバーとして露出する。実体は free function の
   * incomingValidateRequestId への純粋委譲である。
   *
   * @returns 検証に合格した場合は true、違反でセッションを閉じた場合は false
   */
  validateIncomingRequestId(requestId: bigint): SessionError | null {
    return incomingValidateRequestId(requestId, this.receivedRequestIds);
  }

  /**
   * Fetcher の登録を待つ
   *
   * draft-ietf-moq-transport-21 Section 9.12 (FETCH_OK):
   * "A publisher MAY send Objects in response to a FETCH before the
   *  FETCH_OK message is sent."
   * FETCH_OK より先にデータストリームが到着した場合に使用。
   */
  private waitForFetcher(requestId: bigint): Promise<FetcherImpl | null> {
    return incomingWaitForFetcher(this as unknown as SessionInternal, requestId);
  }

  /**
   * 受信した単方向データストリームを処理する
   * draft-ietf-moq-transport-21 Section 11.3 / Section 11.4 (Subgroup Streams / Fetch Streams)
   *
   * ストリーミング処理: データが到着するたびにオブジェクトをパースして即座に配信する
   */
  private async handleIncomingStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    // 統計カウンターを更新
    this.statsUnidirectionalStreamsReceived++;
    this.statsSubscriberStreamsActive++;

    const reader = stream.getReader();

    // ストリーミングパーサー状態
    let buffer: Uint8Array = new Uint8Array(0);
    let headerParsed = false;
    let isFetchStream = false;

    // Fetch ストリーム用の状態
    let fetchHeader: import("./dataStream").FetchHeader | null = null;
    let fetcher: FetcherImpl | null = null;
    let fetchContext: import("./dataStream").FetchObjectContext | null = null;
    let isFirstFetchObject = true;

    // draft-ietf-moq-transport-21 §12.2 (DATA_STREAM_TIMEOUT):
    // ヘッダーまたは Object の途中バイトを保持したまま待ち続けるピアを期限で
    // 打ち切る。バッファが空になった時点で期限を解除する。
    const timeout = this.createDataStreamTimeout(reader, () => buffer.byteLength);
    const armTimeout = timeout.arm;
    const clearTimeoutHandle = timeout.clear;

    try {
      while (true) {
        // draft-ietf-moq-transport-21 §12.2 (DATA_STREAM_TIMEOUT):
        // 途中バイトを保持したまま次のチャンクを待つ間だけ期限を張る。
        // バッファを消費しきったら解除する。ループ先頭で行うのは、
        // データ不足で continue する経路 (半端なヘッダー / Object) でも
        // 必ず期限が張られるようにするためである。
        if (buffer.byteLength > 0) {
          armTimeout();
        } else {
          clearTimeoutHandle();
        }

        const { value, done } = await reader.read();

        if (value) {
          // 新しいチャンクをバッファに追加
          const newBuffer = new Uint8Array(buffer.length + value.length);
          newBuffer.set(buffer);
          newBuffer.set(value, buffer.length);
          buffer = newBuffer;
        }

        // ヘッダーがまだパースされていない場合
        if (!headerParsed && buffer.length > 0) {
          try {
            // 先頭のタイプを確認
            const [streamType] = decodeVarint(buffer, 0);

            const streamTypeNum = Number(streamType);

            if (streamTypeNum === FetchHeaderType) {
              // Fetch データストリーム
              isFetchStream = true;
              const [header, consumed] = decodeFetchHeader(buffer);
              fetchHeader = header;
              buffer = buffer.slice(consumed);
              headerParsed = true;

              // 統計カウンターを更新
              this.statsFetchHeadersReceived++;

              // Fetcher を検索
              // draft-ietf-moq-transport-21 Section 9.12 (FETCH_OK):
              // FETCH_OK より先にデータストリームが到着する可能性がある
              fetcher = this.fetchers.get(header.requestId) ?? null;
              if (!fetcher) {
                // draft-ietf-moq-transport-21 §3.4 (Fill Semantics):
                // fill fetch ストリームの FETCH_HEADER は fill を要求した
                // SUBSCRIBE / REQUEST_UPDATE の Request ID を運ぶ。購読に
                // 紐付けて受信する。どちらにも該当しない Request ID は
                // 不明な FETCH として従来どおり扱う。
                const fillTarget = this.fillFetchTargets.get(header.requestId);
                if (fillTarget) {
                  await this.handleFillFetchStream(reader, header.requestId, fillTarget, buffer);
                  return;
                }
                fetcher = await this.waitForFetcher(header.requestId);
                if (!fetcher) {
                  // タイムアウトで Fetcher が登録されなかった場合は、
                  // peer に STOP_SENDING (cancel) を送って受信を打ち切る。
                  // draft-ietf-moq-transport-21 Section 3.2.1 (Fetch State Management) に倣ってストリームを reset する。
                  void reader.cancel(`unknown fetcher: requestId=${header.requestId}`);
                  break;
                }
              }
            } else if (
              (streamTypeNum >= 0x10 && streamTypeNum <= 0x1f) ||
              (streamTypeNum >= 0x30 && streamTypeNum <= 0x3f) ||
              (streamTypeNum >= 0x50 && streamTypeNum <= 0x5f) ||
              (streamTypeNum >= 0x70 && streamTypeNum <= 0x7f)
            ) {
              // draft-ietf-moq-transport-21 Section 11.3.1:
              // SUBGROUP_ID_MODE = 0b11 のタイプ値
              // (0x16, 0x17, 0x1E, 0x1F, 0x36, 0x37, 0x3E, 0x3F) は予約値であり、
              // 受信した場合は PROTOCOL_VIOLATION でセッションを閉じなければならない
              if ((streamTypeNum & 0x06) === 0x06) {
                this.closeWithError(
                  new SessionError(
                    `reserved subgroup header type: 0x${streamTypeNum.toString(16)}`,
                    SessionErrorCode.PROTOCOL_VIOLATION,
                  ),
                );
                break;
              }

              // Subgroup ストリーム
              isFetchStream = false;
              const [header, consumed] = decodeSubgroupHeader(buffer);
              const initialPayloadBuffer = buffer.slice(consumed);
              buffer = new Uint8Array(0);
              headerParsed = true;

              // 統計カウンターを更新
              this.statsSubgroupHeadersReceived++;

              // Subgroup ストリーム本体は専用ハンドラに委譲する
              // pending mode (subscriber 未登録) と subscriber mode を一貫して扱う
              // draft-ietf-moq-transport-21 §11.3.1 の buffer 経路はこのハンドラ内に集約
              await this.handleSubgroupStream(reader, header, initialPayloadBuffer);
              return;
            } else if (streamTypeNum === 0x132b3e28) {
              // draft-ietf-moq-transport-21 §11.5.1 (Padding Streams):
              // "The receiver MUST discard all data received on a padding stream."
              // PADDING stream のデータはすべて読み捨てる
              isFetchStream = false;
              headerParsed = true;
              buffer = new Uint8Array(0);
              // 残りのデータを drain してストリームを読み切る
              let streamDone = false;
              while (!streamDone) {
                const next = await reader.read();
                streamDone = next.done;
              }
              return;
            } else {
              // draft-ietf-moq-transport-21 Section 6.4.1 (Unidirectional Stream Types):
              // "An endpoint that receives an unknown stream type MUST close the session."
              this.closeWithError(
                new SessionError(
                  `unknown unidirectional stream type: 0x${streamTypeNum.toString(16)}`,
                  SessionErrorCode.PROTOCOL_VIOLATION,
                ),
              );
              break;
            }
          } catch (err) {
            if (err instanceof IncompleteDataError) {
              // データ不足: 次のチャンクを待つ
              // ヘッダー途中での FIN (done) は Object が開始する前のため、
              // §11.3 / §11.4 の未完成 Object 判定 (FIN 直後の残バッファ検査) の
              // 対象外として黙殺する
              if (done) break;
              continue;
            }
            // SessionError (KEY_VALUE_FORMATTING_ERROR 等) はそのコードのまま、
            // ProtocolViolationError / IncompleteDataError は PROTOCOL_VIOLATION で閉じる
            const sessionError = toSessionCloseError(err);
            if (sessionError !== null) {
              // 仕様違反: セッションを閉じる
              this.closeWithError(sessionError);
              break;
            }
            // 予期しないエラー: INTERNAL_ERROR でセッションを閉じる
            this.closeWithError(
              new SessionError(
                err instanceof Error ? err.message : String(err),
                SessionErrorCode.INTERNAL_ERROR,
              ),
            );
            break;
          }
        }

        // オブジェクトをパースして配信
        if (headerParsed) {
          if (isFetchStream && fetcher && fetchHeader) {
            // Fetch オブジェクトをストリーミング処理
            // draft-ietf-moq-transport-21 Section 11.4.1.1 (Flags):
            // FETCH オブジェクトは prior context (前オブジェクトの groupId / subgroupId / publisherPriority)
            // を参照するシリアライゼーションフラグを持つため、複数チャンクに分割された場合に備えて
            // context と isFirst を caller 側で永続化する必要がある
            const fetchResult = this.processFetchObjects(
              buffer,
              fetcher,
              fetchContext,
              isFirstFetchObject,
            );
            buffer = fetchResult.remainingBuffer;
            fetchContext = fetchResult.context;
            isFirstFetchObject = fetchResult.isFirst;
          }
        }

        if (done) break;
      }

      // ストリーム終了処理 (条件はループ内のオブジェクト解析部と対称)
      if (isFetchStream && fetcher && fetchHeader) {
        // ループ最終反復で buffer は remainingBuffer に更新済みであり、
        // ここに残る = FIN 時点で未完了 Object の途中バイト。
        // draft-ietf-moq-transport-21 Section 11.3 (Streams):
        // "If a stream ends gracefully (i.e., the stream terminates with a
        //  FIN) in the middle of a serialized Object, the session SHOULD be
        //  closed with a PROTOCOL_VIOLATION."
        // fetcher.handleEnd() も fetchers.delete も行わず、セッションを
        // PROTOCOL_VIOLATION で閉じる (fetcher の無効化はセッション終了側
        // に委ねる)。
        // close() を経ずに sessionState が closed へ遷移する経路では
        // fetcher の扱いが分かれる。transport.closed ハンドラでは
        // markRequestObjectsClosed により closed になるが、条件付きで遷移する
        // notifyErrorIfActive では active のまま残る。いずれの close 済み経路でも
        // end を通知せず return する
        // (未完成 Object を正常終了として扱わないため)。closeWithError は
        // セッション終了済みだと呼ばない (終了済みセッションへの
        // spurious な通知を防ぐため)
        if (buffer.byteLength > 0) {
          if (this.sessionState === "connected") {
            this.closeWithError(
              new SessionError(
                `fetch data stream ended with incomplete object: requestId=${fetchHeader.requestId}, remaining ${buffer.byteLength} bytes`,
                SessionErrorCode.PROTOCOL_VIOLATION,
              ),
            );
          }
          return;
        }
        fetcher.handleEnd();
        this.fetchers.delete(fetchHeader.requestId);
        // draft-ietf-moq-transport-21 §10.8 / §10.9:
        // FETCH の終了に伴い、購読も尽きた Track の Prior ID Gap 追跡を捨てる
        // (bidiCancelFetch と同じ後始末)。
        bidi.clearPriorGapTrackingIfUnused(
          this as unknown as SessionInternal,
          fetcher.getFullTrackNameKey(),
        );
        // draft-ietf-moq-transport-21 §6.6.1:
        // GOAWAY 受信後に Established fetch が無くなった時点で NO_ERROR で閉じる。
        this.onRequestDrained();
      }
    } catch (err) {
      await this.handleIncomingStreamError(err, reader, fetchHeader, fetcher);
    } finally {
      clearTimeoutHandle();
      this.statsSubscriberStreamsActive--;
      reader.releaseLock();
    }
  }

  /**
   * fill fetch ストリームを受信する
   *
   * draft-ietf-moq-transport-21 §3.4 (Fill Semantics) / §3.4.1:
   * fill fetch ストリームは FETCH と同じオブジェクト framing で届き、
   * FIN は fill 完了 (関連付けを消す)、reset は fill 失敗として扱う。
   * オブジェクトは fillDelivered を true にして購読の object コールバックに
   * 渡す (handleFillObject 経由。subscription のフィルタ再適用は通さない)。
   * fill ストリームの reset / STOP_SENDING による通常の失敗は購読に波及しない
   * (§3.4.1)。ただし malformed track の検出は §12.1 が優先し、同一 Track の
   * 全購読と全 FETCH を cancel する。
   */
  private async handleFillFetchStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    fillRequestId: bigint,
    target: bidi.FillFetchTarget,
    initialBuffer: Uint8Array,
  ): Promise<void> {
    let buffer = initialBuffer;
    let context: import("./dataStream").FetchObjectContext | null = null;
    let isFirst = true;
    // アプリの object コールバックの throw を fill ストリーム自体の失敗と
    // 誤認しないよう、ここで受けてデバッグ記録に残す。subgroup 経路が
    // SUBGROUP_CALLBACK_ERROR として記録しつつ配送を継続するのと同じ扱いで、
    // fill の受信も継続する。ここで受けなければ下の catch がストリームの
    // エラーとして扱い、fill 失敗の通知 (fillError) まで誤って発火する。
    const sink = {
      handleObject: (object: MoqtObject): void => {
        try {
          target.subscriber.handleFillObject(object);
        } catch (callbackError) {
          this.emitCallbackErrorDebug("FILL_CALLBACK_ERROR", callbackError);
        }
      },
    };
    try {
      while (true) {
        const { value, done } = await reader.read();

        if (value) {
          const next = new Uint8Array(buffer.length + value.length);
          next.set(buffer);
          next.set(value, buffer.length);
          buffer = next;
        }

        if (buffer.length > 0) {
          const result = incomingProcessFetchObjects(
            this as unknown as SessionInternal,
            buffer,
            sink,
            context,
            isFirst,
            target.groupOrder,
            // fill fetch ストリーム経由のため fill 側統計に計上する
            true,
            // fill fetch の追跡対象 Track は関連付けられた購読が持つ比較キーで決まる
            target.subscriber.getFullTrackNameKey(),
          );
          buffer = result.remainingBuffer;
          context = result.context;
          isFirst = result.isFirst;
        }

        if (done) break;
      }

      // FIN 時に未完了 Object の途中バイトが残る場合は FETCH と同様に
      // PROTOCOL_VIOLATION でセッションを閉じる (§11.3)。
      if (buffer.byteLength > 0) {
        if (this.sessionState === "connected") {
          this.closeWithError(
            new SessionError(
              `fill fetch data stream ended with incomplete object: requestId=${fillRequestId}, remaining ${buffer.byteLength} bytes`,
              SessionErrorCode.PROTOCOL_VIOLATION,
            ),
          );
        }
        return;
      }
      // FIN は fill 完了であり、関連付けを消す。購読自体は継続する (§3.4.1)。
      this.fillFetchTargets.delete(fillRequestId);
    } catch (err) {
      this.emitDataStreamErrorDebug(err, { type: FetchHeaderType, requestId: fillRequestId });
      // エラー時は fill ストリームを使えない (reset / 失敗) ため関連付けを消す。
      // 購読自体は継続する (§3.4.1)。
      this.fillFetchTargets.delete(fillRequestId);
      // draft-ietf-moq-transport-21 §8.3:
      // 既知 Type の serialization 不一致は SessionError (KEY_VALUE_FORMATTING_ERROR)
      // として届くため、エラーコードを保持したまま閉じる (他の受信経路と同じ)。
      const sessionError = toSessionCloseError(err);
      const normalizedError = err instanceof Error ? err : new Error(String(err));
      if (sessionError !== null) {
        this.closeWithError(sessionError);
      } else if (err instanceof MalformedTrackError) {
        // draft-ietf-moq-transport-21 §12.1:
        // malformed track の検出は §3.4.1 の「fill 失敗は購読に波及しない」
        // より優先し、同一 Track の全購読と全 FETCH を cancel する。
        // アプリへの通知は cancelMalformedTrackPeers が購読の error
        // コールバック経由で行うため、fillError は呼ばない (二重通知を防ぐ)。
        bidi.cancelMalformedTrackPeers(
          this as unknown as SessionInternal,
          target.subscriber.getFullTrackNameKey(),
          err,
        );
        await cancelStreamQuiet(
          reader,
          `malformed fill track: requestId=${fillRequestId}, reason=${err instanceof Error ? err.message : String(err)}`,
        );
      } else if (!isSessionClosedError(normalizedError)) {
        // draft-ietf-moq-transport-21 §3.4.1:
        // "Because there is no REQUEST_ERROR associated with a fill fetch
        //  stream, the publisher signals a fill failure by resetting the
        //  stream" および "Resetting or cancelling a fill fetch stream, by
        //  either endpoint, does not affect the subscription, which continues
        //  to deliver objects using subscribe subgroups and datagrams."
        // 購読は継続するため終了通知 (error) は出さず、fill 専用の
        // fillError でアプリに失敗を伝える。アプリはこれで再取得を判断できる。
        // セッション終了起源の失敗 (isSessionClosedError) はセッション単位の
        // error コールバックが通知するため、ここでは通知しない。
        try {
          target.subscriber.handleFillError(normalizedError);
        } catch (callbackError) {
          // アプリの fillError コールバックの throw は握り潰す
          // (fill の後始末を止めない)。
          this.emitCallbackErrorDebug("FILL_ERROR_CALLBACK_ERROR", callbackError);
        }
      }
    }
    // 統計と reader ロックの後始末は呼び出し元の handleIncomingStream の
    // finally に委ねる (Subgroup 経路と同パターン)。
  }

  /**
   * アプリのコールバック例外をデバッグ記録に残す
   *
   * 握り潰した例外を無音にしないための記録である。受信メッセージに対応しない
   * 記録のため payload は空にし、typeName でどのコールバックかを示す。
   * 記録自体の throw (debug コールバックの throw) は呼び出し元へ伝播させない。
   */
  private emitCallbackErrorDebug(typeName: string, error: unknown): void {
    sessionEmitCallbackErrorDebug(this as unknown as SessionLifecycleInternal, typeName, error);
  }

  /**
   * DATA_STREAM_ERROR のデバッグログを出力する
   *
   * FETCH データストリームの場合は対象の requestId を含めて追跡できるようにする。
   * fetchHeader は Fetch ヘッダーパース時にのみ設定されるため、非 null なら
   * FETCH データストリームと判定できる。
   */
  private emitDataStreamErrorDebug(err: unknown, fetchHeader: FetchHeader | null): void {
    sessionEmitDataStreamErrorDebug(this as unknown as SessionLifecycleInternal, err, fetchHeader);
  }

  /**
   * Malformed Track 検出時の FETCH キャンセル処理
   *
   * draft-ietf-moq-transport-21 §12.1 (Malformed Tracks):
   * Malformed Track 検出時は「cancel any corresponding subscription or fetches
   * for that Track from that publisher」であり、セッションを閉じない。
   * まず受信データストリームを STOP_SENDING 相当 (cancelStreamQuiet) で打ち切る。
   * fetcher が存在する場合 (FETCH データストリーム)、fetcher の error コールバックで
   * アプリへ通知し (§12.1 SHOULD)、FetcherImpl.cancel() 経由で
   * draft-ietf-moq-transport-21 §3.2.1 の MUST「It MUST send STOP_SENDING for
   * the bidi request stream.」に従い bidi リクエストストリームへ STOP_SENDING
   * を送り、fetchers Map から削除する。
   *
   * §12.1 の「fetches for that Track」に従い、同一 Full Track Name の全購読と
   * 全 FETCH を cancel する (cancelMalformedTrackPeers)。fetch() は
   * bidiSendRequestOnBidiStream で新規 bidi ストリームを開いて requestStreams に
   * 登録するため (§9.11「A subscriber sends FETCH as the first message on a new
   * bidi stream」)、同じく STOP_SENDING が送られる。
   *
   * アプリの error コールバックが throw した場合は握り潰してキャンセルを継続する。
   * 呼び出し元の handleIncomingStream は fire-and-forget で起動されるため、throw を
   * 伝搬させると unhandled rejection になる。
   */
  private async handleMalformedFetchTrack(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    error: MalformedTrackError,
    fetcher: FetcherImpl | null,
  ): Promise<void> {
    await cancelStreamQuiet(
      reader,
      `malformed track: code=${DataStreamErrorCode.MALFORMED_TRACK}, reason=${error.message}`,
    );
    if (fetcher) {
      // draft-ietf-moq-transport-21 §12.1:
      // 同一 Track の全購読と全 FETCH を cancel する (該当 requestId の FETCH の
      // みではない)。比較キー (fullTrackNameKey の戻り値) で引く。
      bidi.cancelMalformedTrackPeers(
        this as unknown as SessionInternal,
        fetcher.getFullTrackNameKey(),
        error,
      );
    }
  }

  /**
   * 受信データストリームの読み取りループで発生したエラーの処理
   *
   * - ProtocolViolationError は PROTOCOL_VIOLATION でセッションを閉じる
   * - MalformedTrackError は同一 Track の全購読と全 FETCH をキャンセルする
   * - FETCH データストリームの peer RESET_STREAM は fetcher state を破棄する
   */
  private async handleIncomingStreamError(
    err: unknown,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    fetchHeader: import("./dataStream").FetchHeader | null,
    fetcher: FetcherImpl | null,
  ): Promise<void> {
    // デバッグ: ストリームエラーをログ
    this.emitDataStreamErrorDebug(err, fetchHeader);
    // SessionError (KEY_VALUE_FORMATTING_ERROR 等) はそのコードのまま、
    // ProtocolViolationError / IncompleteDataError は PROTOCOL_VIOLATION で閉じる
    const sessionError = toSessionCloseError(err);
    if (sessionError !== null) {
      this.closeWithError(sessionError);
      return;
    }
    if (err instanceof MalformedTrackError) {
      await this.handleMalformedFetchTrack(reader, err, fetcher);
      return;
    }
    if (fetchHeader !== null && isPeerStreamError(err)) {
      // draft-ietf-moq-transport-21 §3.2.1:
      // FETCH データストリームの reset で subscriber は FETCH state を破棄する。
      // fetchHeader が無い場合 (FETCH_HEADER 読取前の reset) は fetcher を
      // 特定できないため何もしない。
      this.handlePeerFetchStreamReset(err, fetchHeader, fetcher);
    }
  }

  /**
   * peer の RESET_STREAM で FETCH データストリームが終了したときの後始末
   *
   * draft-ietf-moq-transport-21 §3.2.1:
   * 「A subscriber keeps FETCH state until it cancels the request (see
   *  Section 6.4.2.3), receives REQUEST_ERROR, or the FETCH data stream
   *  receives a FIN or is reset.」
   * アプリへ error を通知してから fetcher を closed にし、fetchers から削除する
   * (handleMalformedFetchTrack と同じ順序。handleError を markClosed より先に
   * 呼ばないと通知が握り潰される)。FIN 経路 (handleEnd + fetchers.delete) と
   * state 破棄の集合を揃える。エラーには正規化済みの streamErrorCode を載せる。
   * bidi リクエストストリーム (requestStreams) は FIN 経路と同じく削除しない
   * (セッション終了時にまとめて解放される)。
   */
  private handlePeerFetchStreamReset(
    err: unknown,
    fetchHeader: import("./dataStream").FetchHeader | null,
    fetcher: FetcherImpl | null,
  ): void {
    if (fetcher) {
      try {
        fetcher.handleError(bidi.createFetchDataStreamResetError(err));
      } catch {
        // アプリの error コールバックの throw は握り潰す (後始末は継続する)
      } finally {
        fetcher.markClosed();
      }
    }
    if (fetchHeader !== null) {
      this.fetchers.delete(fetchHeader.requestId);
      // draft-ietf-moq-transport-21 §10.8 / §10.9:
      // peer の RESET_STREAM による FETCH の終了でも、購読も尽きた Track の
      // Prior ID Gap 追跡を捨てる (FIN 経路と同じ後始末)。
      if (fetcher) {
        bidi.clearPriorGapTrackingIfUnused(
          this as unknown as SessionInternal,
          fetcher.getFullTrackNameKey(),
        );
      }
      // draft-ietf-moq-transport-21 §6.6.1:
      // GOAWAY 受信後に Established fetch が無くなった時点で NO_ERROR で閉じる。
      this.onRequestDrained();
    }
  }

  /**
   * Fetch オブジェクトをストリーミング処理
   * パース可能なオブジェクトを全て処理し、残りのバッファを返す
   */
  private processFetchObjects(
    buffer: Uint8Array,
    fetcher: FetcherImpl,
    context: import("./dataStream").FetchObjectContext | null,
    isFirst: boolean,
  ): {
    remainingBuffer: Uint8Array;
    context: import("./dataStream").FetchObjectContext | null;
    isFirst: boolean;
  } {
    return incomingProcessFetchObjects(
      this as unknown as SessionInternal,
      buffer,
      fetcher,
      context,
      isFirst,
      fetcher.getGroupOrder(),
      // 通常 FETCH のため fetch 側統計に計上する
      false,
      // 追跡対象 Track は FETCH を発行した Fetcher が持つ比較キーで決まる
      fetcher.getFullTrackNameKey(),
    );
  }

  /**
   * Subgroup オブジェクトをストリーミング処理
   * パース可能なオブジェクトを全て処理し、残りのバッファと状態を返す。
   * resolvedSubgroupId を透過し、feed 間の解決値を引き継ぐ
   * (明示型・0 系はヘッダ値のため透過しても no-op になる)。
   */
  private processSubgroupObjects(
    buffer: Uint8Array,
    subscribers: SubscriberImpl[],
    header: import("./dataStream").SubgroupHeader,
    previousObjectId: bigint,
    resolvedSubgroupId?: bigint,
  ): {
    remainingBuffer: Uint8Array;
    previousObjectId: bigint;
    resolvedSubgroupId: bigint | undefined;
    updatedEndOfGroupFinalObjectId: bigint | undefined;
  } {
    return incomingProcessSubgroupObjects(
      this as unknown as SessionInternal,
      buffer,
      subscribers,
      header,
      previousObjectId,
      resolvedSubgroupId,
    );
  }

  /**
   * Malformed Track (Object Property の Mandatory Track Property) を検出した
   * 同一 Track の全購読と全 FETCH を §12.1 に従って cancel する
   *
   * draft-ietf-moq-transport-21 §12.1:
   * "it MUST cancel any corresponding subscription or fetches for that Track
   *  from that publisher"
   * データストリームを打ち切り、同一 Full Track Name の購読 / FETCH を cancel する。
   * セッションは閉じない (Track 単位の失敗として扱う)。
   */
  private async handleMalformedSubgroupTrack(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    header: import("./dataStream").SubgroupHeader,
    subscribers: SubscriberImpl[],
    error: MalformedTrackError,
  ): Promise<void> {
    // draft-ietf-moq-transport-21 §12.1:
    // 同一 Track の全購読と全 FETCH を cancel する。比較キーは
    // trackAlias から購読を特定して得る (購読が未特定なら cancel 対象が無い)。
    const trackKey = subscribers[0]?.getFullTrackNameKey();
    if (trackKey !== undefined) {
      bidi.cancelMalformedTrackPeers(this as unknown as SessionInternal, trackKey, error);
    }
    await cancelStreamQuiet(
      reader,
      `malformed track: trackAlias=${header.trackAlias}, reason=${error.message}`,
    );
  }

  /**
   * Subgroup ストリームを処理する
   *
   * draft-ietf-moq-transport-21 §11.3.1:
   * "If an endpoint receives a subgroup with an unknown Track Alias, it MAY abandon
   *  the stream, or choose to buffer it for a brief period to handle reordering with
   *  the control message that establishes the Track Alias."
   *
   * subscriber が登録済みであれば即座に通常 mode で読み出す。
   * 未登録なら pending mode に入り、Promise.race で chunk 受信と subscriber 通知を並走させる。
   * subscriber 登録後は累積 chunks を flush して通常 mode に合流する。
   * timeout / overflow / session-close / end-of-stream のいずれかで abandon する。
   */
  private async handleSubgroupStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    header: import("./dataStream").SubgroupHeader,
    initialBuffer: Uint8Array,
  ): Promise<void> {
    let buffer = initialBuffer;
    let previousObjectId = -1n;
    let resolvedSubgroupId: bigint | undefined;
    let subscribers: SubscriberImpl[] = this.subscribersByAlias.get(header.trackAlias) ?? [];

    // pending mode で発火された read Promise を subscriber mode に持ち越すための変数
    // ReadableStreamDefaultReader.read() は中断不能なため、Promise.race で別経路が
    // 勝ったときに pendingRead を破棄せず保持し、subscriber mode の最初の read として消費する
    let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;

    if (subscribers.length === 0) {
      const entry = this.pendingSubgroupBuffer.add(header.trackAlias);
      let entryRemoved = false;

      try {
        // ヘッダパース直後に余っていた payload を pending entry に移し、ローカル buffer は空にする
        // subscriber mode 復帰時に entry.chunks の concat 結果で buffer を作り直す
        if (initialBuffer.byteLength > 0) {
          this.pendingSubgroupBuffer.appendChunk(entry, initialBuffer);
          buffer = new Uint8Array(0);
        }

        while (subscribers.length === 0) {
          pendingRead ??= reader.read();
          const event = await Promise.race([
            pendingRead.then((result) => ({ kind: "chunk" as const, result })),
            entry.notified.then((reason) => ({ kind: "notify" as const, reason })),
          ]);

          if (event.kind === "chunk") {
            pendingRead = null;
            const chunk = event.result.value;
            if (chunk && chunk.byteLength > 0) {
              this.pendingSubgroupBuffer.appendChunk(entry, chunk);
            }
            if (event.result.done) {
              // FIN 検出時はその場で完結させる (race の再登録を待たない)。
              // FIN 済み read() は以後も即解決の done を返すため、再 race すると
              // chunk 分岐が常に勝って notified が発火せず無限ループになる。
              // FIN と subscriber 登録の同時解決は合流を優先し、空の場合のみ
              // abandon する (notified 側が先に勝つ既存経路は変えない)。
              subscribers = this.subscribersByAlias.get(header.trackAlias) ?? [];
              if (subscribers.length > 0) {
                // pending chunks を 1 本に concat して subscriber mode へ合流する
                buffer = concatChunks(entry.chunks);
                this.pendingSubgroupBuffer.remove(entry);
                entryRemoved = true;
                break;
              }
              entry.notify("end-of-stream");
              this.pendingSubgroupBuffer.remove(entry);
              entryRemoved = true;
              await cancelStreamQuiet(
                reader,
                `pending subgroup end-of-stream: trackAlias=${header.trackAlias}`,
              );
              return;
            }
            continue;
          }

          // event.kind === "notify"
          if (event.reason === "subscriber") {
            subscribers = this.subscribersByAlias.get(header.trackAlias) ?? [];
            if (subscribers.length === 0) {
              // 通知発火と subscribers 解放が race した稀なケース: abandon
              this.pendingSubgroupBuffer.remove(entry);
              entryRemoved = true;
              await cancelStreamQuiet(
                reader,
                `inconsistent subscriber state: trackAlias=${header.trackAlias}`,
              );
              return;
            }
            // pending chunks を 1 本に concat して buffer に格納し subscriber mode へ遷移する
            buffer = concatChunks(entry.chunks);
            this.pendingSubgroupBuffer.remove(entry);
            entryRemoved = true;
            break;
          }

          // abandon (timeout / overflow-per-stream / overflow-per-session / session-close / end-of-stream)
          this.pendingSubgroupBuffer.remove(entry);
          entryRemoved = true;
          await cancelStreamQuiet(
            reader,
            `pending subgroup ${event.reason}: trackAlias=${header.trackAlias}`,
          );
          return;
        }
      } finally {
        if (!entryRemoved) {
          // 例外脱出時の救済 cleanup (二重 remove は no-op で安全)
          this.pendingSubgroupBuffer.remove(entry);
        }
      }
    }

    // subscriber mode: 通常の Subgroup ストリーム処理ループ
    // pendingRead が pending mode から持ち越されている場合はそれを最初の read として消費する
    // draft-ietf-moq-transport-21 §12.2 (DATA_STREAM_TIMEOUT):
    // 途中バイトを保持したまま次のチャンクを待つ間だけ期限を張る。
    const timeout = this.createDataStreamTimeout(reader, () => buffer.byteLength);
    try {
      while (true) {
        if (buffer.byteLength > 0) {
          timeout.arm();
        } else {
          timeout.clear();
        }
        let result: ReadableStreamReadResult<Uint8Array>;
        if (pendingRead !== null) {
          result = await pendingRead;
          pendingRead = null;
        } else {
          result = await reader.read();
        }

        if (result.value && result.value.byteLength > 0) {
          const next = new Uint8Array(buffer.byteLength + result.value.byteLength);
          next.set(buffer);
          next.set(result.value, buffer.byteLength);
          buffer = next;
        }

        try {
          const processResult = this.processSubgroupObjects(
            buffer,
            subscribers,
            header,
            previousObjectId,
            resolvedSubgroupId,
          );
          buffer = processResult.remainingBuffer;
          previousObjectId = processResult.previousObjectId;
          resolvedSubgroupId = processResult.resolvedSubgroupId;
          // draft-ietf-moq-transport-21 §12.1 条件 4:
          // 確定した Group 最終 Object を Group 単位で記録する。Subgroup ストリームを
          // またいだ後続 Object の malformed 検出に使う。
          if (processResult.updatedEndOfGroupFinalObjectId !== undefined) {
            this.receivedEndOfGroupFinalObjectIds.set(
              `${header.trackAlias}:${header.groupId}`,
              processResult.updatedEndOfGroupFinalObjectId,
            );
          }
        } catch (err) {
          if (err instanceof MalformedTrackError) {
            // draft-ietf-moq-transport-21 §12.1:
            // malformed track を検出した購読を cancel し、セッションは閉じない
            await this.handleMalformedSubgroupTrack(reader, header, subscribers, err);
            return;
          }
          throw err;
        }

        if (result.done) break;
      }
    } finally {
      timeout.clear();
    }

    // ここに到達した時点でピアの FIN を検出している (上記ループは
    // result.done でしか抜けない)。
    // draft-ietf-moq-transport-21 Section 11.3 (Streams):
    // "If a stream ends gracefully (i.e., the stream terminates with a
    //  FIN) in the middle of a serialized Object, the session SHOULD be
    //  closed with a PROTOCOL_VIOLATION."
    // §11.3.2 (Closing Subgroup Streams) は全 Object を配信せずに閉じる場合
    // の reset を MUST としており、残バッファ非空の FIN は違反ワイヤである。
    // 黙殺して関数を抜けるとアプリはオブジェクト欠落を検知できないため、
    // PROTOCOL_VIOLATION でセッションを閉じる (Fetch 側の判定は
    // handleIncomingStream の終了処理にある)。
    // pending mode (subscribers 未登録) は payload を decode しておらず
    // 未完成 Object を機械的に判定できないため、subscriber mode だけの
    // 対象とする。closeWithError はセッション終了済みだと呼ばない
    // (終了済みセッションへの spurious な通知を防ぐため)
    if (this.sessionState === "connected" && buffer.byteLength > 0) {
      this.closeWithError(
        new SessionError(
          `subgroup data stream ended with incomplete object: trackAlias=${header.trackAlias}, groupId=${header.groupId}, remaining ${buffer.byteLength} bytes`,
          SessionErrorCode.PROTOCOL_VIOLATION,
        ),
      );
    }
  }
}
