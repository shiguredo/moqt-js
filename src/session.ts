/**
 * MOQT セッション
 * draft-ietf-moq-transport-19 Section 3 (Sessions)
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
} from "./error";
import {
  MessageType,
  createTrackNamespace,
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
  encodeGoawayPayload,
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
  FetchType,
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
  type SendObjectParams,
  type SendDatagramParams,
} from "./publisher";
import { type Subscriber, type RequestUpdateOptions, SubscriberImpl } from "./subscriber";
import { type Fetcher, FetcherImpl } from "./fetcher";
import { decodeFetchHeader, FetchHeaderType } from "./dataStream";
import { PendingSubgroupBuffer, type PendingSubgroupBufferOptions } from "./pendingSubgroupBuffer";
import type { MoqtFragment } from "./moqtUri";
import {
  buildPublishParameters,
  buildPublishTrackProperties,
  buildSubscribeParameters,
  buildSubscribeTracksParameters,
  buildFetchParameters,
  buildSubscribeNamespaceParameters,
  clampTimeoutMs,
  compareLocations,
  extractForwardState,
  matchNamespacePrefix,
  validateRangeFilterLimits,
  validateRangeFilterSpecs,
  validateTrackNamespaceForSend,
} from "./session/params";
import * as bidi from "./session/bidi";
import { concatChunks, cancelStreamQuiet } from "./session/stream";
import { trackPropertyFiltersMatch } from "./filter";
import {
  isPeerStreamError,
  isSessionClosedError,
  toProtocolViolationSessionError,
} from "./session/errors";
import type { SessionInternal } from "./session/types";
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

export type { MoqtObject } from "./dataStream";

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
   * draft-ietf-moq-transport-19 Section 10.4 (GOAWAY)
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
   * draft-ietf-moq-transport-19 Section 10.3.1.4 (AUTHORIZATION TOKEN Setup Option)
   *
   * SETUP では Alias Type DELETE (0x0) / USE_ALIAS (0x2) は仕様上禁止 (Section 10.2.2)。
   * REGISTER (0x1) または USE_VALUE (0x3) のみ指定できる。
   */
  authorizationToken?: AuthorizationToken;

  /**
   * Pending Subgroup Stream の buffer 設定
   * draft-ietf-moq-transport-19 §11.4.2 の "MAY ... choose to buffer it for a brief
   * period to handle reordering with the control message that establishes the Track
   * Alias" を実現する buffer の上限を制御する。
   *
   * 指定しなかった field は `DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS` の値が使われる。
   */
  pendingSubgroup?: Partial<PendingSubgroupBufferOptions>;

  /**
   * MOQT_IMPLEMENTATION Setup Option (Option Type 0x07) の送信制御
   * draft-ietf-moq-transport-19 §10.3.1.5 (MOQT IMPLEMENTATION) /
   * §13.8 (Implementation Identification Fingerprinting)
   *
   * - 未指定（既定）: `moqt-js/${version}` を送信する。
   * - false: MOQT_IMPLEMENTATION Option を送信しない（opt-out）。
   * - 文字列: その値をそのまま送信する（override）。値の妥当性検証は行わないため、
   *   内容は呼び出し側の責任（§10.3.1.5 は実装名とバージョンに限定する SHOULD を定める）。
   */
  moqtImplementation?: string | false;

  /**
   * GREASE Setup Option の送信（opt-in）
   * draft-ietf-moq-transport-19 §14 (Grease)
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
   * draft-ietf-moq-transport-19 §3.1.2
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
   * draft-ietf-moq-transport-19 Section 10.2.17 (FORWARD Parameter)
   *
   * PUBLISH_OK または REQUEST_UPDATE で Forward State が変更された時に呼ばれる。
   * - true (1): Subscriber がいる（オブジェクトを送信すべき）
   * - false (0): Subscriber がいない（オブジェクト送信を止めても良い）
   */
  onForwardStateChange?: (forward: boolean) => void;
  /**
   * リクエストストリーム上で GOAWAY を受信した時のコールバック
   * draft-ietf-moq-transport-19 Section 10.4 (GOAWAY):
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
   * draft-ietf-moq-transport-19 Section 12.3 (MAX CACHE DURATION)
   *
   * Relay がオブジェクトをキャッシュして良い最大時間を指定する。
   * 0 を指定するとキャッシュを無効にする。
   */
  maxCacheDuration?: bigint;

  /**
   * Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-19 Section 12.2 (OBJECT_DELIVERY_TIMEOUT)
   *
   * PUBLISH の Track Properties として送信される OBJECT_DELIVERY_TIMEOUT（Message Parameter の定義は Section 10.2.4）。
   *
   * オブジェクトを受信してから配信を試みる最大時間。
   * moqt-js はこの値の強制は行わない。比較と強制は Publisher 値と Subscriber 値の両方を持つ
   * エンドポイント（典型的にはリレー）の責務であり、詳細は Section 8
   * (Delivery Timeouts and Data Reliability) を参照。
   */
  deliveryTimeout?: bigint;

  /**
   * Subgroup Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-19 Section 12.1 (SUBGROUP_DELIVERY_TIMEOUT)
   *
   * Subgroup 内のオブジェクトを配信する最大時間。
   * 0 はタイムアウトなしを意味する。
   */
  subgroupDeliveryTimeout?: bigint;

  /**
   * Publisher Priority（0-255）
   * draft-ietf-moq-transport-19 Section 12.4 (DEFAULT PUBLISHER PRIORITY)
   *
   * パブリッシュの優先度。小さい値ほど高優先度。
   * 指定しない場合は 128（デフォルト）
   */
  publisherPriority?: number;

  /**
   * Group Order
   * draft-ietf-moq-transport-19 Section 12.5 (DEFAULT PUBLISHER GROUP ORDER)
   *
   * グループの配信順序。
   * - "Ascending": 古いグループから順に配信
   * - "Descending": 新しいグループから順に配信
   */
  groupOrder?: "Ascending" | "Descending";

  /**
   * Dynamic Groups サポートの通知
   * draft-ietf-moq-transport-19 Section 12.6 (DYNAMIC GROUPS)
   *
   * true を設定すると、Subscriber が NEW_GROUP_REQUEST パラメータで
   * 新しいグループの生成を要求できることを通知する。
   */
  dynamicGroups?: boolean;

  /**
   * Expires（ミリ秒）
   * draft-ietf-moq-transport-19 Section 10.2.15 (EXPIRES Parameter)
   *
   * パブリッシュが自動終了するまでの時間（ミリ秒）。
   * 0 または未指定の場合は期限なし。
   */
  expires?: bigint;

  /**
   * Forward State
   * draft-ietf-moq-transport-19 Section 10.2.17 (FORWARD Parameter)
   *
   * オブジェクトの転送状態を指定する。
   * - true (1): オブジェクトを転送する（デフォルト）
   * - false (0): オブジェクトを転送しない
   *
   * 省略した場合は 1（転送する）がデフォルト。
   * Relay は Subscriber がいない間は forward=0 で PUBLISH_OK を返す可能性がある。
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
   * draft-ietf-moq-transport-19 Section 11.3 (Datagrams)
   *
   * 注意: Datagram は信頼性がなく、順序も保証されない
   */
  datagram?: (object: MoqtObject) => void;
  end?: () => void;
  error?: (error: Error) => void;
  /**
   * リクエストストリーム上で GOAWAY を受信した時のコールバック
   * draft-ietf-moq-transport-19 Section 10.4 (GOAWAY):
   * 当該リクエストのマイグレーション先 URI を通知する。
   */
  goaway?: (newSessionUri: string) => void;
}

/**
 * Joining Fetch オプション
 * draft-ietf-moq-transport-19 Section 10.12.2 (Joining Fetches)
 *
 * 重要な制約:
 * 1. Joining Fetch は Filter Type が LargestObject のサブスクリプションでのみ使用可能。
 *    他の Filter Type を使用すると PROTOCOL_VIOLATION でセッションが終了する。
 *    subscribe() の options.filter を { type: "LargestObject" } に設定する必要がある。
 *
 * 2. SUBSCRIBE_OK に LARGEST_OBJECT パラメータがない場合（まだオブジェクトが
 *    発行されていない場合）、Joining Fetch は送信されず onError が呼び出される。
 *
 * 範囲の計算:
 * - End Location: {Subscribe Largest Location.Group, Subscribe Largest Location.Object + 1}
 * - Relative の場合の Start: {Subscribe Largest Location.Group - start, 0}
 * - Absolute の場合の Start: {start, 0}
 */
export interface JoiningFetchOptions {
  /**
   * Fetch タイプ
   * - "relative": 現在の位置から相対的にグループ数を指定
   *   Start Location = {Largest Location.Group - start, 0}
   * - "absolute": 絶対的なグループ ID を指定
   *   Start Location = {start, 0}
   */
  type: "relative" | "absolute";

  /**
   * 取得開始位置
   * - relative の場合: 何グループ前から取得するか（例: 3n → 3 グループ前から）
   * - absolute の場合: 開始グループ ID
   */
  start: bigint;

  /**
   * Joining Fetch で受信したオブジェクトのコールバック
   * 指定しない場合は subscribe のコールバックと同じものが使われる
   */
  onObject?: (object: MoqtObject) => void;

  /**
   * Joining Fetch 完了時のコールバック
   */
  onEnd?: () => void;

  /**
   * Joining Fetch エラー時のコールバック
   * LARGEST_OBJECT がない場合や、サーバーからのエラーを受け取る
   */
  onError?: (error: Error) => void;

  /**
   * Fill Timeout（ミリ秒）
   * draft-ietf-moq-transport-19 Section 10.2.5 (FILL TIMEOUT Parameter)
   *
   * relay が欠損 object の fill 待機に費やす最大時間。
   * 0 は即座に利用可能な object のみを要求。
   */
  fillTimeout?: bigint;

  /**
   * Range Filters
   * draft-ietf-moq-transport-19 Section 5.1.3 (Range Filters)
   *
   * ピアの MAX_FILTER_RANGES が 0 (未広告含む) の場合に指定すると throw する。
   */
  rangeFilters?: RangeFilterSpec[];
}

/**
 * サブスクライブオプション
 */
export interface SubscribeOptions {
  /**
   * Location Filter
   * draft-ietf-moq-transport-19 Section 5.1.2, Section 10.2.9, Section 10.2.16
   *
   * どのオブジェクトを受信するかを指定するフィルタ。
   * - NextGroupStart: 配信済み時は LARGEST_OBJECT の次のグループから開始、
   *   未配信時は {0, 0} から開始
   * - LargestObject: 最新オブジェクトの次から開始、未配信時は {0, 0} から開始
   * - AbsoluteStart: 指定した位置から開始（終了なし）
   * - AbsoluteRange: 指定した範囲のオブジェクトのみ。End Group
   *   (Start Location の Group + End Group Delta) が 2^64-1 を超えると
   *   送信前に InvalidFilterError で throw する（§5.1.2）
   *
   * 指定しない場合、フィルタなし（全オブジェクト）
   */
  filter?: LocationFilter;

  /**
   * Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-19 Section 10.2.4 (OBJECT_DELIVERY_TIMEOUT Parameter)
   *
   * オブジェクトを受信してから配信を試みる最大時間。
   * moqt-js はこの値を SUBSCRIBE の Message Parameter として送信するが、この値の強制は行わない。
   * 比較と強制は Publisher 値と Subscriber 値の両方を持つエンドポイント（典型的にはリレー）の
   * 責務であり、詳細は Section 8 (Delivery Timeouts and Data Reliability) を参照。
   */
  deliveryTimeout?: bigint;

  /**
   * Subgroup Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-19 Section 10.2.3 (SUBGROUP_DELIVERY_TIMEOUT)
   *
   * Subgroup 内のオブジェクトを配信する最大時間。
   * 0 はタイムアウトなしを意味する。
   */
  subgroupDeliveryTimeout?: bigint;

  /**
   * Subscriber Priority（0-255）
   * draft-ietf-moq-transport-19 Section 10.2.7 (SUBSCRIBER PRIORITY Parameter)
   *
   * サブスクリプションの優先度。小さい値ほど高優先度。
   * 指定しない場合は 128（デフォルト）
   */
  subscriberPriority?: number;

  /**
   * Group Order
   * draft-ietf-moq-transport-19 Section 10.2.8 (GROUP ORDER Parameter)
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
   * draft-ietf-moq-transport-19 Section 10.2.18 (NEW GROUP REQUEST Parameter)
   *
   * 0 を指定すると、Publisher は新しい Group を開始する
   * Publisher が DYNAMIC_GROUPS をサポートしていない場合は無視される
   */
  newGroupRequest?: bigint;

  /**
   * Joining Fetch オプション
   * draft-ietf-moq-transport-19 Section 10.12.2 (Joining Fetches)
   *
   * SUBSCRIBE と同時に過去のデータを取得する。
   * Relay がキャッシュを持っていれば、過去のグループを取得できる。
   *
   * 重要: Joining Fetch を使用する場合、filter を { type: "LargestObject" } に
   * 設定する必要がある。他の Filter Type では PROTOCOL_VIOLATION エラーとなる。
   */
  joiningFetch?: JoiningFetchOptions;

  /**
   * Forward State
   * draft-ietf-moq-transport-19 Section 10.2.17 (FORWARD Parameter)
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
   * draft-ietf-moq-transport-19 Section 10.2.6 (RENDEZVOUS TIMEOUT Parameter)
   *
   * リレーが Publisher を待つ時間。
   * 0 は即時応答を要求。指定しない場合のデフォルトは 0。
   * draft-ietf-moq-transport-19 Section 10.2.6
   */
  rendezvousTimeout?: bigint;

  /**
   * Range Filters
   * draft-ietf-moq-transport-19 Section 5.1.3 (Range Filters)
   *
   * ピアの MAX_FILTER_RANGES が 0（未広告含む）の場合に指定すると throw する。
   */
  rangeFilters?: RangeFilterSpec[];

  /**
   * AUTHORIZATION_TOKEN Message Parameter (0x03) として送信する Authorization Token
   * draft-ietf-moq-transport-19 Section 10.2.2 (AUTHORIZATION TOKEN Parameter)
   *
   * draft-ietf-moq-msf-01 §11.4.3: track に関連するトークンは SUBSCRIBE に MUST 付与。
   * SETUP にトークンを載せていても免除されない。
   */
  authorizationToken?: AuthorizationToken;
}

/**
 * SUBSCRIBE_TRACKS のオプション
 * draft-ietf-moq-transport-19 Section 10.19.1 (Parameters on SUBSCRIBE_TRACKS)
 *
 * SUBSCRIBE のパラメータのうち SUBSCRIBE_TRACKS で有効なもののサブセット。
 */
export interface SubscribeTracksOptions {
  /**
   * Group Order
   * draft-ietf-moq-transport-19 Section 10.2.8 (GROUP ORDER Parameter)
   */
  groupOrder?: "Ascending" | "Descending";

  /**
   * Forward State
   * draft-ietf-moq-transport-19 Section 10.2.17 (FORWARD Parameter)
   *
   * 省略した場合は 1（転送する）がデフォルト。
   * 明示的に false のときだけワイヤに FORWARD=0 を載せる。
   */
  forward?: boolean;

  /**
   * Range Filters
   * draft-ietf-moq-transport-19 Section 5.1.3 (Range Filters)
   *
   * ピアの MAX_FILTER_RANGES が 0（未広告含む）の場合に指定すると throw する。
   */
  rangeFilters?: RangeFilterSpec[];
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
   * draft-ietf-moq-transport-19 Section 10.4 (GOAWAY):
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
   * draft-ietf-moq-transport-19 Section 10.2.5 (FILL TIMEOUT Parameter)
   *
   * relay が欠損 object の fill 待機に費やす最大時間。
   * 0 は即座に利用可能な object のみを要求。
   */
  fillTimeout?: bigint;

  /**
   * 開始位置
   */
  startLocation: Location;
  /**
   * 終了位置
   */
  endLocation: Location;

  /**
   * Range Filters
   * draft-ietf-moq-transport-19 Section 5.1.3 (Range Filters)
   *
   * ピアの MAX_FILTER_RANGES が 0 (未広告含む) の場合に指定すると throw する。
   */
  rangeFilters?: RangeFilterSpec[];

  /**
   * AUTHORIZATION_TOKEN Message Parameter (0x03) として送信する Authorization Token
   * draft-ietf-moq-transport-19 Section 10.2.2 (AUTHORIZATION TOKEN Parameter)
   *
   * draft-ietf-moq-msf-01 §11.4.3: track に関連するトークンは FETCH に MUST 付与。
   */
  authorizationToken?: AuthorizationToken;
}

/**
 * TRACK_STATUS の結果
 * draft-ietf-moq-transport-19 Section 10.14 (TRACK_STATUS)
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
 * draft-ietf-moq-transport-19 §10.18 (SUBSCRIBE_NAMESPACE):
 * SUBSCRIBE_NAMESPACE への応答として、NAMESPACE / NAMESPACE_DONE が送信される。
 * draft-18 で旧 SUBSCRIBE_NAMESPACE (0x11) が SUBSCRIBE_NAMESPACE (0x50) と
 * SUBSCRIBE_TRACKS (0x51) に分割され、PUBLISH_SKIPPED は SUBSCRIBE_TRACKS 応答に移動した。
 */
export interface NamespaceSubscriptionCallbacks {
  /**
   * NAMESPACE を受信したときに呼ばれる
   * draft-ietf-moq-transport-19 §10.16 (NAMESPACE)
   *
   * @param namespaceSuffix - Track Namespace Prefix を除いた Suffix
   */
  onNamespace?: (namespaceSuffix: string[]) => void;
  /**
   * NAMESPACE_DONE を受信したときに呼ばれる
   * draft-ietf-moq-transport-19 §10.17 (NAMESPACE_DONE)
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
   * draft-ietf-moq-transport-19 §10.4 (GOAWAY):
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
 * draft-ietf-moq-transport-19 §10.9.2 (Updating Namespace Subscriptions):
 * REQUEST_UPDATE に TRACK_NAMESPACE_PREFIX パラメータ (0x34) を含めて
 * 確立済みの SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS の Track Namespace Prefix を
 * 更新する。
 */
export interface NamespaceUpdateOptions {
  /**
   * 更新後の Track Namespace Prefix
   * draft-ietf-moq-transport-19 §10.2.19 (TRACK_NAMESPACE_PREFIX Parameter)
   */
  trackNamespacePrefix: string[];
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
   * draft-ietf-moq-transport-19 §10.9.2 (Updating Namespace Subscriptions):
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
 * draft-ietf-moq-transport-19 §10.19 (SUBSCRIBE_TRACKS):
 * SUBSCRIBE_TRACKS への応答として PUBLISH メッセージが新規双方向ストリームで
 * 送信される。応答ストリームでは PUBLISH_SKIPPED が送られる。
 */
export interface TracksSubscriptionCallbacks {
  /**
   * サーバーから PUBLISH メッセージを受信したときに呼ばれる
   * draft-ietf-moq-transport-19 §10.19 / §10.10
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
   * draft-ietf-moq-transport-19 §10.20 (PUBLISH_SKIPPED):
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
   * draft-ietf-moq-transport-19 §10.4 (GOAWAY):
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
 * draft-ietf-moq-transport-19 §10.19 (SUBSCRIBE_TRACKS)
 */
export interface TracksSubscription {
  readonly state: "active" | "closed";
  /**
   * サブスクリプションを解除する
   */
  unsubscribe(): Promise<void>;
  /**
   * Track Namespace Prefix を更新する (REQUEST_UPDATE を送信)
   *
   * draft-ietf-moq-transport-19 §10.9.2 (Updating Namespace Subscriptions):
   * "Updating the prefix of a SUBSCRIBE_TRACKS has no effect on existing
   *  subscriptions." (既存の確立済み SubscriberImpl には影響しない)
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
   * @param options - 更新内容 (TRACK_NAMESPACE_PREFIX)
   */
  update(options: NamespaceUpdateOptions): Promise<void>;
}

/**
 * Namespace 公開のコールバック
 * draft-ietf-moq-transport-19 Section 10.15 (PUBLISH_NAMESPACE)
 */
export interface NamespacePublicationCallbacks {
  /**
   * エラー時のコールバック
   */
  error?: (error: Error) => void;
  /**
   * GOAWAY 受信時に呼ばれる
   * draft-ietf-moq-transport-19 §10.4 (GOAWAY):
   * リクエストストリーム上の GOAWAY は当該リクエストの
   * マイグレーションのみを目的とする。
   *
   * @param newSessionUri - 新しいセッション URI
   */
  goaway?: (newSessionUri: string) => void;
}

/**
 * Namespace 公開
 * draft-ietf-moq-transport-19 Section 10.15 (PUBLISH_NAMESPACE)
 */
export interface NamespacePublication {
  readonly state: "active" | "closed";
  /**
   * 公開している Namespace
   */
  readonly namespace: string[];
  /**
   * 公開を終了する
   * draft-ietf-moq-transport-19: ストリームの close で終了を通知する。
   */
  done(): Promise<void>;
}

/**
 * セッションレベルの統計情報
 */
export interface SessionStatistics {
  // オブジェクト受信
  /** FETCH 経由で受信したオブジェクト数 */
  objectsReceivedViaFetch: number;
  /** SUBSCRIBE 経由で受信したオブジェクト数 */
  objectsReceivedViaSubscribe: number;
  /** FETCH 経由で受信したバイト数 */
  bytesReceivedViaFetch: number;
  /** SUBSCRIBE 経由で受信したバイト数 */
  bytesReceivedViaSubscribe: number;

  // バッファ状態
  /** SUBSCRIBE_OK 前に到着した Subgroup ストリーム数 */
  pendingSubgroupStreamsCount: number;
  /** SUBSCRIBE_OK 前に到着した Subgroup ストリームのバイト数 */
  pendingSubgroupStreamsBytes: number;

  // ストリーム状態
  /** アクティブな Publisher 数 */
  activePublishers: number;
  /** アクティブな Subscriber 数 */
  activeSubscribers: number;
  /** アクティブな Fetcher 数 */
  activeFetchers: number;

  // WebTransport ストリーム統計
  /** Publisher が開いている送信ストリーム数 */
  publisherStreamsOpen: number;
  /** 現在読み取り中の受信ストリーム数 */
  subscriberStreamsActive: number;

  // データストリーム統計（累計）
  /** Publisher が開いた送信ストリーム数（累計） */
  unidirectionalStreamsOpened: number;
  /** 受信した Unidirectional ストリーム数 */
  unidirectionalStreamsReceived: number;
  /** パースした Subgroup ヘッダー数 */
  subgroupHeadersReceived: number;
  /** パースした Fetch ヘッダー数 */
  fetchHeadersReceived: number;

  // Control Stream 統計（累計）
  /** 送信した Control Message 数 */
  controlMessagesSent: number;
  /** 受信した Control Message 数 */
  controlMessagesReceived: number;
}

export interface Session {
  readonly state: SessionState;
  /**
   * GOAWAY を受信したかどうか
   * draft-ietf-moq-transport-19 Section 10.4 (GOAWAY)
   */
  readonly goawayReceived: boolean;
  /**
   * 接続時に渡された moqt URI の Fragment Identifier
   *
   * draft-ietf-moq-transport-19 §3.1.2:
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
   * draft-ietf-moq-transport-19 Section 10.12 (FETCH)
   */
  fetch(
    namespace: string[],
    trackName: string,
    options: FetchOptions,
    callbacks: FetchCallbacks,
  ): Promise<Fetcher>;
  /**
   * トラックの状態を問い合わせる
   * draft-ietf-moq-transport-19 Section 10.14 (TRACK_STATUS)
   */
  trackStatus(namespace: string[], trackName: string): Promise<TrackStatusResult>;
  /**
   * Namespace をサブスクライブする（namespace discovery 用）
   *
   * draft-ietf-moq-transport-19 §10.18 (SUBSCRIBE_NAMESPACE):
   * SUBSCRIBE_NAMESPACE は新しい双方向ストリームで送信される。
   * 応答として NAMESPACE / NAMESPACE_DONE が送られる。
   *
   * @param namespacePrefix - Track Namespace Prefix
   * @param callbacks - コールバック関数
   * @param options - オプション（authorizationToken: §11.4.3 により SUBSCRIBE_NAMESPACE に MUST 付与）
   */
  subscribeNamespace(
    namespacePrefix: string[],
    callbacks: NamespaceSubscriptionCallbacks,
    options?: { authorizationToken?: AuthorizationToken },
  ): Promise<NamespaceSubscription>;
  /**
   * Track をサブスクライブする（track subscription 用）
   *
   * draft-ietf-moq-transport-19 §10.19 (SUBSCRIBE_TRACKS):
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
   * draft-ietf-moq-transport-19 Section 10.15 (PUBLISH_NAMESPACE)
   *
   * Publisher が Track Namespace 内にトラックがあることを通知する。
   * Subscriber は SUBSCRIBE_NAMESPACE でこの通知を受け取れる。
   */
  publishNamespace(
    namespace: string[],
    callbacks?: NamespacePublicationCallbacks,
  ): Promise<NamespacePublication>;
  /**
   * GOAWAY を送信してセッション終了を通知する
   * draft-ietf-moq-transport-19 Section 10.4 (GOAWAY)
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
 * 内部セッション実装
 */
export class SessionImpl implements Session {
  private sessionState: SessionState = "connected";
  private readonly transport: WebTransport;
  private readonly callbacks: ConnectCallbacks;
  // draft-ietf-moq-transport-19 §3.1.2 (Fragment Identifiers)
  private readonly sessionFragment: MoqtFragment | null;
  /**
   * draft-ietf-moq-transport-19 Section 4 (Extensibility):
   * 制御ストリームは単方向ストリームのペアに変更された。
   * クライアントとサーバーがそれぞれ 1 本ずつ単方向ストリームを開く。
   * draft-ietf-moq-transport-19 Section 4
   */
  private controlSendStream?: WritableStream<Uint8Array>;
  private controlReceiveStream?: ReadableStream<Uint8Array>;
  private controlReader?: ControlStreamReader;
  private controlWriter?: ControlStreamWriter;

  // datagram 送信用 writer。保持して使い回す理由は getDatagramWriter を参照。
  private datagramWriter?: WritableStreamDefaultWriter<Uint8Array>;

  // 受信双方向ストリームの reader。
  // draft-ietf-moq-transport-19 §10.19: SUBSCRIBE_TRACKS への応答として
  // サーバーが新規双方向ストリームを開き PUBLISH を送信する。
  // この reader で incomingBidirectionalStreams を監視する。
  private incomingBidiStreamReader?: ReadableStreamDefaultReader<WebTransportBidirectionalStream>;

  // リクエスト ID 管理
  private nextRequestId = 0n;
  private nextTrackAlias = 0n;

  // GOAWAY 状態
  private receivedGoaway = false;
  // リクエストストリームごとの GOAWAY 受信済みフラグ
  // draft-ietf-moq-transport-19 §10.4 (GOAWAY):
  // 単一リクエストストリーム上の重複 GOAWAY は PROTOCOL_VIOLATION
  private goawayReceivedOnRequestStreams = new Set<bigint>();
  // 受信済み Request ID の追跡 (重複検出用)
  // draft-ietf-moq-transport-19 §10.1:
  // 重複 Request ID の受信は INVALID_REQUEST_ID でセッションを閉じる。
  // Set には add のみ行い、リクエスト完了後も削除しない (セッション内での
  // 再出現の禁止のため)。セッションクローズ時にクリアする。
  private receivedRequestIds = new Set<bigint>();
  private sentGoaway = false;
  private goawayTimeoutId: ReturnType<typeof setTimeout> | null = null;
  // draft-ietf-moq-transport-19 §10.3.1.7: ピアの MAX_REQUEST_UPDATES（0 = 無制限）
  peerMaxRequestUpdates = 0;
  // draft-ietf-moq-transport-19 §10.3.1.6: ピアの MAX_FILTER_RANGES（0 = Range Filter 送信禁止）
  peerMaxFilterRanges = 0;
  // draft-ietf-moq-transport-19 §14 (Grease): true のとき Track / Object Properties に
  // GREASE Property を 1 つ注入する。initialize() で ConnectOptions.grease を受け渡す。
  grease = false;

  // アクティブなパブリッシャー、サブスクライバー、フェッチャー
  private publishers = new Map<bigint, PublisherImpl>();
  private subscribers = new Map<bigint, SubscriberImpl>();
  private subscribersByAlias = new Map<bigint, SubscriberImpl[]>();
  private fetchers = new Map<bigint, FetcherImpl>();

  // Subscriber 登録前に到着した Subgroup ストリームをバッファリング
  // draft-ietf-moq-transport-19 §11.4.2:
  // "MAY ... choose to buffer it for a brief period to handle reordering with the
  //  control message that establishes the Track Alias."
  // QUIC ではストリーム間の順序が保証されないため、SUBSCRIBE_OK より先にデータストリームが
  // 到着する可能性があり、それを buffer して reordering を吸収する
  // 上限・タイムアウトは ConnectOptions.pendingSubgroup でユーザーから指定可能
  private readonly pendingSubgroupBuffer: PendingSubgroupBuffer;

  // Fetcher 登録待ちの Promise を管理
  // draft-ietf-moq-transport-19 Section 10.13 (FETCH_OK):
  // "A publisher MAY send Objects in response to a FETCH before the
  //  FETCH_OK message is sent."
  // FETCH_OK より先にデータストリームが到着する可能性がある
  private fetcherReadyCallbacks = new Map<bigint, Array<() => void>>();

  // リクエストごとの双方向ストリーム管理
  // draft-ietf-moq-transport-19 Section 3.3:
  // リクエストは双方向ストリーム上で送受信される。
  // draft-ietf-moq-transport-19 Section 3.3
  private requestStreams = new Map<
    bigint,
    {
      stream: WebTransportBidirectionalStream;
      writer: WritableStreamDefaultWriter<Uint8Array>;
      controlReader: ControlStreamReader;
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
      joiningFetch?: JoiningFetchOptions;
      objectCallback: (object: MoqtObject) => void;
    }
  >();
  private pendingRequestUpdate = new Map<
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
  private pendingTrackStatus = new Map<
    bigint,
    { resolve: (result: TrackStatusResult) => void; reject: (err: Error) => void }
  >();
  /**
   * SUBSCRIBE_NAMESPACE の状態管理
   *
   * draft-ietf-moq-transport-19 §10.18 (SUBSCRIBE_NAMESPACE):
   * SUBSCRIBE_NAMESPACE は専用の双方向ストリームで送受信される。
   * 応答として NAMESPACE / NAMESPACE_DONE のみが送られる。
   */
  private namespaceSubscriptions = new Map<
    bigint,
    {
      callbacks: NamespaceSubscriptionCallbacks;
      state: "active" | "closed";
      namespacePrefix: string[];
      pendingPrefix?: string[];
      stream?: WebTransportBidirectionalStream;
      streamReader?: ReadableStreamDefaultReader<Uint8Array>;
      controlReader?: ControlStreamReader;
      writer?: WritableStreamDefaultWriter<Uint8Array>;
    }
  >();
  /**
   * SUBSCRIBE_TRACKS の状態管理
   *
   * draft-ietf-moq-transport-19 §10.19 (SUBSCRIBE_TRACKS):
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
      rangeFilters?: RangeFilterSpec[];
      pendingPrefix?: string[];
      stream?: WebTransportBidirectionalStream;
      streamReader?: ReadableStreamDefaultReader<Uint8Array>;
      controlReader?: ControlStreamReader;
      writer?: WritableStreamDefaultWriter<Uint8Array>;
    }
  >();
  /**
   * PUBLISH_NAMESPACE の状態管理
   *
   * draft-ietf-moq-transport-19 Section 10.15 (PUBLISH_NAMESPACE):
   * PUBLISH_NAMESPACE は新しい双方向ストリームの先頭メッセージとして送信される。
   * REQUEST_OK / REQUEST_ERROR が同じ双方向ストリームで応答される。
   * https://www.ietf.org/archive/id/draft-ietf-moq-transport-19.html#section-10.15
   */
  private namespacePublications = new Map<
    bigint,
    {
      callbacks?: NamespacePublicationCallbacks;
      state: "pending" | "active" | "closed";
      namespace: string[];
      stream: WebTransportBidirectionalStream;
      streamReader: ReadableStreamDefaultReader<Uint8Array>;
      controlReader: ControlStreamReader;
      writer: WritableStreamDefaultWriter<Uint8Array>;
    }
  >();

  // Publisher ごとのストリーム状態
  // draft-ietf-moq-transport-19 Section 2.2:
  // "Objects in a subgroup ... are sent on a single stream whenever possible."
  private publisherStreams = new Map<
    bigint,
    {
      groupId: bigint;
      writer: WritableStreamDefaultWriter<Uint8Array>;
      previousObjectId: bigint;
    }
  >();

  // Publisher ごとの送信キュー
  // sendObject は async だが fire-and-forget で呼ばれるため、
  // 同一トラック内で並行実行されるとストリームの二重作成が発生する。
  // Promise チェーンでトラック単位のシリアライズを行う。
  publisherSendQueues = new Map<bigint, Promise<void>>();

  // STOP_SENDING / delivery timeout で閉じた Subgroup の追跡
  // draft-ietf-moq-transport-19 §11.4.3 (Closing Subgroup Streams):
  // "A publisher that receives a STOP_SENDING on a Subgroup stream SHOULD NOT
  //  attempt to open a new stream to deliver additional Objects in that Subgroup."
  //
  // 1 Group = 1 Subgroup = 1 Stream モデルでは groupId が subgroupId を一意に決定するため、
  // キーは `${trackAlias}:${groupId}` で十分である。
  // sendObject 時にこの Set をチェックし、閉じた Subgroup への送信を拒否する。
  private closedSubgroups = new Set<string>();

  // 統計カウンター
  private statsObjectsReceivedViaFetch = 0;
  private statsObjectsReceivedViaSubscribe = 0;
  private statsBytesReceivedViaFetch = 0;
  private statsBytesReceivedViaSubscribe = 0;
  private statsUnidirectionalStreamsOpened = 0;
  private statsUnidirectionalStreamsReceived = 0;
  private statsSubscriberStreamsActive = 0;
  private statsSubgroupHeadersReceived = 0;
  private statsFetchHeadersReceived = 0;
  private statsControlMessagesSent = 0;
  private statsControlMessagesReceived = 0;

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
    // draft-ietf-moq-transport-19 Section 3.5:
    // peer 起点でセッションが閉じた場合、各ストリームの read は reject するが
    // これは正常な終了通知である。read loop の catch 側で正しくスキップできるよう
    // callbacks.close を呼ぶ前に sessionState を遷移させておく。
    this.transport.closed
      .then((closeInfo) => {
        if (this.sessionState !== "closed") {
          this.sessionState = "closed";
        }
        this.callbacks.close?.(closeInfo);
      })
      .catch((error: unknown) => {
        if (this.sessionState !== "closed") {
          this.sessionState = "closed";
        }
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

  // draft-ietf-moq-transport-19 §3.1.2 (Fragment Identifiers)
  get fragment(): MoqtFragment | null {
    return this.sessionFragment;
  }

  /**
   * セッションを初期化する (WebTransport 接続後に呼ばれる)
   *
   * options に authorizationToken を指定すると、SETUP Option (0x03) として
   * draft-ietf-moq-transport-19 Section 10.3.1.4 に従い認証トークンを送出する。
   * options に moqtImplementation を指定すると、SETUP Option (0x07) の送信を制御する。
   * options に grease: true を指定すると、SETUP に GREASE Setup Option (§14) を追加する。
   */
  async initialize(options?: {
    authorizationToken?: AuthorizationToken;
    moqtImplementation?: string | false;
    grease?: boolean;
  }): Promise<void> {
    // draft-ietf-moq-transport-19 Section 4 (Extensibility):
    // 制御ストリームは単方向ストリームのペアに変更された。
    // クライアントは送信用単方向ストリームを開き、サーバーの単方向ストリームを受信する。
    // draft-ietf-moq-transport-19 Section 4

    this.controlReader = new ControlStreamReader();
    this.controlWriter = new ControlStreamWriter();

    // 送信用単方向ストリームを開く
    this.controlSendStream = await this.transport.createUnidirectionalStream();

    // draft-ietf-moq-transport-19 Section 3.4:
    // All unidirectional MOQT streams start with a variable-length integer
    // indicating the type of the stream.
    // 制御ストリームのストリームタイプは 0x2F00 (Table 3)
    const streamTypeBytes = encodeVarint(MessageType.SETUP);

    // SETUP を送信
    // draft-ietf-moq-transport-19 §10.3.1.1 / §10.3.1.2:
    // AUTHORITY (0x05) / PATH (0x01) は WebTransport 使用時には MUST NOT 送信。
    // moqt-js は WebTransport 専用クライアントのため `createSetup` には渡さない。
    // grease は SETUP 送信だけでなく、Track / Object Properties への注入にも使うため
    // セッション状態として保持する。
    this.grease = options?.grease === true;
    const setup = createSetup({
      authorizationToken: options?.authorizationToken,
      moqtImplementation: options?.moqtImplementation,
      grease: options?.grease,
    });
    const setupPayload = encodeSetupPayload(setup);
    const setupMessage = this.controlWriter.encode(MessageType.SETUP, setupPayload);

    this.emitDebug("send", MessageType.SETUP, setupPayload, {});

    const writer = this.controlSendStream.getWriter();
    await writer.write(streamTypeBytes);
    await writer.write(setupMessage);
    writer.releaseLock();

    // サーバーからの単方向ストリームを受信する
    const incomingReader = this.transport.incomingUnidirectionalStreams.getReader();
    const { value: incomingStream, done: streamDone } = await incomingReader.read();
    incomingReader.releaseLock();

    if (streamDone || !incomingStream) {
      throw new SessionError(
        "Connection closed before receiving control stream",
        SessionErrorCode.NO_ERROR,
      );
    }

    this.controlReceiveStream = incomingStream;

    // draft-ietf-moq-transport-19 Section 3.4:
    // 単方向ストリームの先頭にストリームタイプ varint が含まれる。
    // 制御ストリームのストリームタイプ 0x2F00 を読み取って検証する。
    // WebTransport の read() はチャンク境界を保証しないため、ストリームタイプ varint も
    // SETUP メッセージ本体も複数チャンクに分割されて届きうる。揃うまで読み続ける。
    // reader は 1 つだけ保持し、後続の制御ストリーム読み取り (startControlMessageLoop)
    // が getReader() で再取得できるよう finally で必ず releaseLock する。
    const reader = incomingStream.getReader();
    let messages: ControlMessage[] = [];
    try {
      // ストリームタイプ varint を読み切るまで read + 連結を繰り返す
      let buffer: Uint8Array = new Uint8Array(0);
      let streamType: bigint;
      let streamTypeConsumed: number;
      for (;;) {
        const { value, done } = await reader.read();
        if (done || !value) {
          throw new SessionError(
            "Connection closed before control stream type",
            SessionErrorCode.NO_ERROR,
          );
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

      if (Number(streamType) !== MessageType.SETUP) {
        throw new SessionError(
          `expected control stream type 0x2F00, got 0x${streamType.toString(16)}`,
          SessionErrorCode.PROTOCOL_VIOLATION,
        );
      }

      // draft-ietf-moq-transport-19 Section 10.3 (SETUP):
      // SETUP は制御ストリーム上で最初に送られる制御メッセージである。
      // SETUP メッセージが揃うまで read + feed を繰り返す。
      // ControlStreamReader.feed は部分データを内部バッファに蓄積し、
      // 揃ったメッセージだけを返す。
      messages = this.controlReader.feed(buffer.slice(streamTypeConsumed));
      while (messages.length === 0) {
        const { value: chunk, done } = await reader.read();
        if (done || !chunk) {
          throw new SessionError("Connection closed before SETUP", SessionErrorCode.NO_ERROR);
        }
        messages = this.controlReader.feed(chunk);
      }
    } finally {
      reader.releaseLock();
    }

    const msg = messages[0];
    if (msg.type !== MessageType.SETUP) {
      throw new SessionError(
        `Expected SETUP, got ${msg.type}`,
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }

    // SETUP をデコードしてバリデーションする
    const decodedSetup = decodeSetupPayload(msg.payload);

    // draft-ietf-moq-transport-19 §10.3.1.1 / §10.3.1.2:
    // AUTHORITY (0x05) / PATH (0x01) は server から送信されてはならない。
    // また WebTransport 使用時には MUST NOT 送信されるため、moqt-js は受信したら
    // INVALID_AUTHORITY / INVALID_PATH でセッションを閉じなければならない。
    if (getSetupAuthority(decodedSetup) !== undefined) {
      throw new SessionError(
        "received AUTHORITY in SETUP from server (forbidden under WebTransport)",
        SessionErrorCode.INVALID_AUTHORITY,
      );
    }
    if (getSetupPath(decodedSetup) !== undefined) {
      throw new SessionError(
        "received PATH in SETUP from server (forbidden under WebTransport)",
        SessionErrorCode.INVALID_PATH,
      );
    }

    // draft-ietf-moq-transport-19 §10.3.1.3:
    // ピアの MAX_AUTH_TOKEN_CACHE_SIZE を取得（デフォルト 0 = Alias 使用禁止）
    const peerMaxAuthTokenCacheSize = getSetupMaxAuthTokenCacheSize(decodedSetup);

    // draft-ietf-moq-transport-19 §10.3.1.7:
    // ピアの MAX_REQUEST_UPDATES を取得（デフォルト 0 = 無制限）
    this.peerMaxRequestUpdates = getSetupMaxRequestUpdates(decodedSetup);

    // draft-ietf-moq-transport-19 §10.3.1.6:
    // ピアの MAX_FILTER_RANGES を取得（デフォルト 0 = Range Filter 送信禁止）
    this.peerMaxFilterRanges = getSetupMaxFilterRanges(decodedSetup);

    this.emitDebug("recv", MessageType.SETUP, msg.payload, {
      peerMaxAuthTokenCacheSize: peerMaxAuthTokenCacheSize.toString(),
      peerMaxRequestUpdates: this.peerMaxRequestUpdates.toString(),
      peerMaxFilterRanges: this.peerMaxFilterRanges.toString(),
    });

    // draft-ietf-moq-transport-19 Section 10.3 (SETUP) / Section 3.3 (Control Streams):
    // SETUP は制御ストリーム上の最初の制御メッセージであり、後続メッセージが同一 read
    // チャンクに相乗りして届くことがある。ControlStreamReader.feed は揃った全メッセージを
    // 返し内部バッファから削除するため、messages[0] (SETUP) 以外を処理しないと、後続の
    // startControlMessageLoop は新規 read 分しか処理せず相乗りメッセージが恒久的に失われる。
    // SETUP 確立後に messages[1..] を通常の制御メッセージ処理経路へ順次流す。
    for (let i = 1; i < messages.length; i++) {
      this.handleControlMessage(messages[i].type, messages[i].payload);
    }

    // バックグラウンドで制御メッセージの読み取りを開始
    this.startControlMessageLoop();

    // 受信データストリームの受け入れを開始
    this.startIncomingStreamLoop();

    // データグラムの受信を開始
    this.startDatagramLoop();

    // 受信双方向ストリームの監視を開始
    // draft-ietf-moq-transport-19 §10.19: SUBSCRIBE_TRACKS への応答として
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
    // draft-ietf-moq-transport-19 Section 10.4 (GOAWAY)
    if (this.receivedGoaway) {
      throw new Error("Cannot publish after receiving GOAWAY");
    }

    const requestId = this.nextRequestId;
    // draft-ietf-moq-transport-19 Section 10.1: クライアントは偶数の Request ID を使うため 2 ずつ加算する
    this.nextRequestId += 2n;

    const trackAlias = this.nextTrackAlias++;

    const trackNamespace = createTrackNamespace(namespace);
    const trackNameBytes = encodeTrackName(trackName);
    // draft-ietf-moq-transport-19 §2.4.1: Full Track Name 合計長検証
    validateFullTrackName(trackNamespace, trackName);
    // draft-ietf-moq-transport-19 §3.2.1 / §3.2.2: 予約 namespace / .session の送信拒否
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

    // 送信コールバックを設定
    impl.onSendObject = (params: SendObjectParams) => this.sendObject(impl, params);

    // データグラム送信コールバックを設定
    impl.onSendDatagram = (params: SendDatagramParams) => {
      this.sendDatagram(impl, params);
    };

    impl.onDoneInternal = async () => {
      // まずデータストリーム（subgroup 単方向ストリーム）を閉じる（FIN 送信）
      await this.closePublisherStream(impl.getTrackAlias());
      // その後 PUBLISH_DONE を送信（リクエストストリーム（PUBLISH の bidi ストリーム）の FIN は sendPublishDone 内で送信、draft-ietf-moq-transport-19 §10.11）
      await this.sendPublishDone(impl);
    };

    // PUBLISH_OK の Promise を作成
    const promise = new Promise<Publisher>((resolve, reject) => {
      this.pendingPublish.set(requestId, {
        resolve,
        reject,
        impl,
      });
    });

    const parameters = buildPublishParameters(options);
    const trackProperties = buildPublishTrackProperties(options, this.grease);

    // PUBLISH メッセージを双方向ストリームで送信
    // draft-ietf-moq-transport-19 Section 10.10 (PUBLISH):
    // "The publisher sends PUBLISH as the first message on a new
    //  bidirectional stream to initiate a subscription for a Track."
    // draft-ietf-moq-transport-19 Section 3.3
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
    const streamInfo = await this.sendRequestOnBidiStream(requestId, MessageType.PUBLISH, payload, {
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

    // 双方向ストリームからレスポンスを読み取る
    void this.readPublishResponse(requestId, streamInfo.stream, streamInfo.controlReader);

    return promise;
  }

  /**
   * トラックを subscribe する
   *
   * draft-ietf-moq-transport-19 Section 10.8 (SUBSCRIBE_OK):
   * SUBSCRIBE は Track Alias を含まない。
   * Track Alias は SUBSCRIBE_OK で publisher から返される (Section 10.8 SUBSCRIBE_OK)。
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
    // draft-ietf-moq-transport-19 Section 10.4 (GOAWAY)
    if (this.receivedGoaway) {
      throw new Error("Cannot subscribe after receiving GOAWAY");
    }

    // Joining Fetch は Forward State 1 の場合のみ許可
    // draft-ietf-moq-transport-19 Section 10.12.2 (Joining Fetches):
    // "A Joining Fetch is only permitted when the associated subscription
    //  has Forward State 1; otherwise the publisher MUST respond with a
    //  REQUEST_ERROR with error code INVALID_RANGE."
    // joiningFetch が有効な場合、自動的に LargestObject フィルターを設定する
    if (options?.joiningFetch) {
      // draft-ietf-moq-transport-19 Section 10.12.2 (Joining Fetches):
      // "A Joining Fetch is only permitted when the associated subscription
      //  has Forward State 1; otherwise the publisher MUST respond with a
      //  REQUEST_ERROR with error code INVALID_RANGE."
      if (options.forward === false) {
        throw new Error(
          "Joining Fetch requires Forward State 1. " +
            "Remove options.forward or set options.forward = true",
        );
      }

      if (options.filter === undefined) {
        options = { ...options, filter: { type: "LargestObject" } };
      } else if (options.filter.type !== "LargestObject") {
        throw new Error(
          "Joining Fetch requires filter type LargestObject. " +
            'Remove options.filter or set options.filter = { type: "LargestObject" }',
        );
      }
    }

    const requestId = this.nextRequestId;
    // draft-ietf-moq-transport-19 Section 10.1: クライアントは偶数の Request ID を使うため 2 ずつ加算する
    this.nextRequestId += 2n;

    const trackNamespace = createTrackNamespace(namespace);
    const trackNameBytes = encodeTrackName(trackName);
    // draft-ietf-moq-transport-19 §2.4.1: Full Track Name 合計長検証
    validateFullTrackName(trackNamespace, trackName);
    // draft-ietf-moq-transport-19 §3.2.1 / §3.2.2: 予約 namespace / .session の送信拒否
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

    // draft-ietf-moq-transport-19 §5.1 (Subscriptions):
    // "The initiator of the subscription sets the initial Forward State in
    //  either PUBLISH or SUBSCRIBE."
    // SUBSCRIBE 送信時の options.forward (省略時は §10.2.17 のデフォルト 1)
    // を Forward State として保持する。
    impl.setForwardState(options?.forward ?? true);

    // draft-ietf-moq-transport-19 Section 5.1.2: Location Filter を設定
    impl.setLocationFilter(options?.filter);

    // draft-ietf-moq-transport-19 Section 5.1.3: Range Filters を設定
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

    // draft-ietf-moq-transport-19 §10.3.1.6: ピアの MAX_FILTER_RANGES が 0 のとき Range Filter 送信禁止
    // pendingSubscribe.set より前に配置し、throw 時に pending エントリが残らないようにする
    validateRangeFilterLimits(options?.rangeFilters, this.peerMaxFilterRanges, "SUBSCRIBE");

    // draft-ietf-moq-transport-19 §5.1.3:
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
        joiningFetch: options?.joiningFetch,
        objectCallback: callbacks.object,
      });
    });

    // SUBSCRIBE メッセージを双方向ストリームで送信
    // draft-ietf-moq-transport-19 Section 10.7 (SUBSCRIBE):
    // SUBSCRIBE は新しい双方向ストリームで送信される。
    // draft-ietf-moq-transport-19 Section 3.3
    const subscribeMsg = {
      type: MessageType.SUBSCRIBE,
      requestId,
      trackNamespace,
      trackName: trackNameBytes,
      parameters,
    };

    const payload = encodeSubscribePayload(subscribeMsg);
    const streamInfo = await this.sendRequestOnBidiStream(
      requestId,
      MessageType.SUBSCRIBE,
      payload,
      {
        requestId: requestId.toString(),
        trackNamespace: namespace,
        trackName,
        filterType: options?.filter?.type,
        OBJECT_DELIVERY_TIMEOUT: options?.deliveryTimeout?.toString(),
        SUBSCRIBER_PRIORITY: options?.subscriberPriority,
        GROUP_ORDER: options?.groupOrder,
        NEW_GROUP_REQUEST: options?.newGroupRequest?.toString(),
      },
    );

    // 双方向ストリームからレスポンスを読み取る
    void this.readSubscribeResponse(requestId, streamInfo.stream, streamInfo.controlReader);

    return promise;
  }

  /**
   * 過去のデータを取得する（Standalone Fetch）
   *
   * draft-ietf-moq-transport-19 Section 10.12 (FETCH):
   * FETCH はトラックから Object の範囲を要求する
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
    // draft-ietf-moq-transport-19 §2.4.1: Full Track Name 合計長検証
    validateFullTrackName(trackNamespace, trackName);
    // draft-ietf-moq-transport-19 §3.2.1 / §3.2.2: 予約 namespace / .session の送信拒否
    validateTrackNamespaceForSend(namespace, trackName);

    // draft-ietf-moq-transport-19 §10.12.3 (Fetch Handling):
    // "End Location MUST specify the same or a larger Location than Start
    //  Location for Standalone and Absolute Joining Fetches."
    // 不正な範囲をワイヤに載せないよう送信前に検証する
    if (compareLocations(options.endLocation, options.startLocation) < 0) {
      throw new Error(
        `FETCH end location (${options.endLocation.group}:${options.endLocation.object}) is smaller than start location (${options.startLocation.group}:${options.startLocation.object})`,
      );
    }

    // draft-ietf-moq-transport-19 §10.3.1.6: ピアの MAX_FILTER_RANGES を超える Range Filter 送信をガード
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

    // draft-ietf-moq-transport-19 Section 5.2:
    // キャンセルはストリームを閉じることで行う。
    impl.onCancel = async () => {
      await this.cancelFetch(impl);
    };

    // FETCH メッセージを構築する（Standalone Fetch）
    // draft-ietf-moq-transport-19 Section 10.12 (FETCH):
    // FETCH は新しい双方向ストリームで送信される。
    // draft-ietf-moq-transport-19 Section 3.3
    // buildFetchParameters (buildRangeFilterParameters を含む) が throw する場合、
    // pendingFetch.set より前で失敗させるため、構築は Promise 作成より前に行う。
    const fetchMsg = {
      type: MessageType.FETCH,
      requestId,
      fetchType: FetchType.STANDALONE,
      standalone: {
        trackNamespace,
        trackName: trackNameBytes,
        startLocation: options.startLocation,
        endLocation: options.endLocation,
      },
      parameters: buildFetchParameters(options),
    };

    // FETCH_OK を待つ Promise
    const promise = new Promise<Fetcher>((resolve, reject) => {
      this.pendingFetch.set(requestId, {
        resolve,
        reject,
        impl,
        startLocation: options.startLocation,
      });
    });

    const payload = encodeFetchPayload(fetchMsg);
    const streamInfo = await this.sendRequestOnBidiStream(requestId, MessageType.FETCH, payload, {
      requestId: requestId.toString(),
      trackNamespace: namespace,
      trackName,
      startLocation: `${options.startLocation.group}:${options.startLocation.object}`,
      endLocation: `${options.endLocation.group}:${options.endLocation.object}`,
    });

    // 双方向ストリームからレスポンスを読み取る
    void this.readFetchResponse(requestId, streamInfo.stream, streamInfo.controlReader);

    return promise;
  }

  /**
   * トラックの状態を問い合わせる
   *
   * draft-ietf-moq-transport-19 Section 10.14 (TRACK_STATUS):
   * TRACK_STATUS は subscribe せずにトラックの情報を要求する
   * 応答は SUBSCRIBE_OK と同じパラメータを持つ REQUEST_OK である
   */
  async trackStatus(namespace: string[], trackName: string): Promise<TrackStatusResult> {
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
    // draft-ietf-moq-transport-19 §2.4.1: Full Track Name 合計長検証
    validateFullTrackName(trackNamespace, trackName);
    // draft-ietf-moq-transport-19 §3.2.1 / §3.2.2: 予約 namespace / .session の送信拒否
    validateTrackNamespaceForSend(namespace, trackName);

    // REQUEST_OK を待つ Promise
    const promise = new Promise<TrackStatusResult>((resolve, reject) => {
      this.pendingTrackStatus.set(requestId, { resolve, reject });
    });

    // TRACK_STATUS メッセージを双方向ストリームで送信
    // draft-ietf-moq-transport-19 Section 10.14 (TRACK_STATUS):
    // TRACK_STATUS は新しい双方向ストリームで送信される。
    // draft-ietf-moq-transport-19 Section 3.3
    const trackStatusMsg = {
      type: MessageType.TRACK_STATUS,
      requestId,
      trackNamespace,
      trackName: trackNameBytes,
      parameters: [],
    };

    const payload = encodeTrackStatusPayload(trackStatusMsg);
    const streamInfo = await this.sendRequestOnBidiStream(
      requestId,
      MessageType.TRACK_STATUS,
      payload,
      {
        requestId: requestId.toString(),
        trackNamespace: namespace,
        trackName,
      },
    );

    // 双方向ストリームからレスポンスを読み取る
    void this.readTrackStatusResponse(requestId, streamInfo.stream, streamInfo.controlReader);

    return promise;
  }

  /**
   * Namespace をサブスクライブする（namespace discovery 用）
   *
   * draft-ietf-moq-transport-19 §10.18 (SUBSCRIBE_NAMESPACE):
   * SUBSCRIBE_NAMESPACE (0x50) は新しい双方向ストリームで送信される。
   * REQUEST_OK または REQUEST_ERROR が最初のレスポンスとして返され、
   * 以降は NAMESPACE / NAMESPACE_DONE のみが応答ストリーム上で送られる。
   *
   * draft-18 で旧 SUBSCRIBE_NAMESPACE (0x11) が 0x50 と SUBSCRIBE_TRACKS (0x51)
   * に分割され、Subscribe Options フィールドは廃止された。
   *
   * draft-ietf-moq-transport-19 §6.1:
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

    // draft-ietf-moq-transport-19 §3.2.1 / §3.2.2: 予約 namespace / .session の送信拒否
    validateTrackNamespaceForSend(namespacePrefix);

    // 専用の双方向ストリームを作成
    const stream = await this.transport.createBidirectionalStream();
    const streamReader = stream.readable.getReader();
    const controlReader = new ControlStreamReader();
    const writer = stream.writable.getWriter();

    // SUBSCRIBE_NAMESPACE メッセージを構築
    // AUTHORIZATION_TOKEN (0x03) - draft-ietf-moq-msf-01 §11.4.3: SUBSCRIBE_NAMESPACE に MUST 付与。
    const subscribeNamespaceMsg = {
      type: MessageType.SUBSCRIBE_NAMESPACE,
      requestId,
      trackNamespacePrefix,
      parameters: buildSubscribeNamespaceParameters(options),
    };

    // メッセージをエンコードして送信
    // draft-ietf-moq-transport-19 §10.18 (SUBSCRIBE_NAMESPACE):
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
   * draft-ietf-moq-transport-19 §10.19 (SUBSCRIBE_TRACKS):
   * SUBSCRIBE_TRACKS (0x51) は新しい双方向ストリームで送信される。
   * REQUEST_OK または REQUEST_ERROR が最初のレスポンスとして返され、
   * 以降は PUBLISH_SKIPPED のみが応答ストリーム上で送られる。
   * PUBLISH メッセージは別の新規双方向ストリームで非同期に到着する。
   *
   * draft-ietf-moq-transport-19 §6.1:
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

    // draft-ietf-moq-transport-19 §3.2.1 / §3.2.2: 予約 namespace / .session の送信拒否
    validateTrackNamespaceForSend(namespacePrefix);

    // draft-ietf-moq-transport-19 §10.3.1.6: ピアの MAX_FILTER_RANGES が 0 のとき Range Filter 送信禁止
    // draft-ietf-moq-transport-19 §6.3: SUBSCRIBE_TRACKS で Range Filter を送信できる
    validateRangeFilterLimits(options?.rangeFilters, this.peerMaxFilterRanges, "SUBSCRIBE_TRACKS");

    // 専用の双方向ストリームを作成
    const stream = await this.transport.createBidirectionalStream();
    const streamReader = stream.readable.getReader();
    const controlReader = new ControlStreamReader();
    const writer = stream.writable.getWriter();

    // SUBSCRIBE_TRACKS メッセージを構築
    // draft-ietf-moq-transport-19 §10.19.1: GROUP_ORDER / FORWARD / Range Filters を送信可能
    const subscribeTracksMsg = {
      type: MessageType.SUBSCRIBE_TRACKS,
      requestId,
      trackNamespacePrefix,
      parameters: buildSubscribeTracksParameters(options),
    };

    // メッセージをエンコードして送信
    // draft-ietf-moq-transport-19 §10.19 (SUBSCRIBE_TRACKS):
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

    // REQUEST_OK/REQUEST_ERROR を待つ Promise
    return new Promise<TracksSubscription>((resolve, reject) => {
      // 状態を登録
      this.tracksSubscriptions.set(requestId, {
        callbacks,
        state: "active",
        namespacePrefix,
        // draft-ietf-moq-transport-19 §5.1.3:
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
   * draft-ietf-moq-transport-19 §10.18 (SUBSCRIBE_NAMESPACE):
   * REQUEST_OK / REQUEST_ERROR、NAMESPACE、NAMESPACE_DONE のみを処理する。
   * PUBLISH_SKIPPED は SUBSCRIBE_TRACKS 応答ストリーム側 (startTracksStreamLoop) で扱う。
   */
  private async startNamespaceStreamLoop(
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
   * draft-ietf-moq-transport-19 §10.19 (SUBSCRIBE_TRACKS):
   * REQUEST_OK / REQUEST_ERROR、PUBLISH_SKIPPED のみを処理する。
   * PUBLISH メッセージは別の新規双方向ストリームで到着するためここでは扱わない。
   */
  private async startTracksStreamLoop(
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
   * draft-ietf-moq-transport-19 Section 10.15 (PUBLISH_NAMESPACE):
   * PUBLISH_NAMESPACE は新しい双方向ストリームの先頭メッセージとして送信される。
   * REQUEST_OK / REQUEST_ERROR が同じ双方向ストリームで応答される。
   * https://www.ietf.org/archive/id/draft-ietf-moq-transport-19.html#section-10.15
   *
   * draft-ietf-moq-transport-19 §6.2:
   * 公開のキャンセルはストリームを FIN または RESET_STREAM で閉じることで行う。
   * https://www.ietf.org/archive/id/draft-ietf-moq-transport-19.html#section-6.2
   */
  async publishNamespace(
    namespace: string[],
    callbacks?: NamespacePublicationCallbacks,
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

    // draft-ietf-moq-transport-19 §3.2.1 / §3.2.2: 予約 namespace / .session の送信拒否
    validateTrackNamespaceForSend(namespace);

    // 専用の双方向ストリームを作成
    const stream = await this.transport.createBidirectionalStream();
    const streamReader = stream.readable.getReader();
    const controlReader = new ControlStreamReader();
    const writer = stream.writable.getWriter();

    // PUBLISH_NAMESPACE メッセージを構築
    const publishNamespaceMsg = {
      type: MessageType.PUBLISH_NAMESPACE,
      requestId,
      trackNamespace,
      parameters: [],
    };

    // メッセージをエンコードして送信
    // draft-ietf-moq-transport-19 Section 10.15 (PUBLISH_NAMESPACE):
    // Type (vi64) + Length (16-bit big-endian) + Payload のフレーミングを
    // ControlStreamWriter に委譲する。
    // https://www.ietf.org/archive/id/draft-ietf-moq-transport-19.html#section-10.15
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
   * draft-ietf-moq-transport-19 Section 10.15 (PUBLISH_NAMESPACE):
   * 応答は REQUEST_OK / REQUEST_ERROR のみが想定される。
   * それ以外のメッセージを受信した場合は PROTOCOL_VIOLATION でセッションを閉じる。
   */
  private async startNamespacePublicationStreamLoop(
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
   * draft-ietf-moq-transport-19 Section 10.4 (GOAWAY):
   * エンドポイントは間もなくセッションを閉じる意図を peer に通知するために
   * GOAWAY メッセージを送信する。
   */
  async goaway(newSessionUri?: string, timeout?: bigint): Promise<void> {
    if (this.sessionState === "closed") {
      throw new Error("Session is closed");
    }

    // 複数回の GOAWAY 送信は許可しない
    if (this.sentGoaway) {
      throw new Error("GOAWAY already sent");
    }

    // draft-ietf-moq-transport-19 Section 10.4 (GOAWAY):
    // "When sent by a client, the New Session URI MUST be zero length."
    // moqt-js はクライアント実装のため、newSessionUri は常に空文字列
    if (newSessionUri !== undefined && newSessionUri !== "") {
      throw new Error("client MUST send GOAWAY with empty New Session URI");
    }

    this.sentGoaway = true;

    const goawayTimeout = timeout ?? 0n;
    const payload = encodeGoawayPayload({
      type: MessageType.GOAWAY,
      newSessionUri: "",
      timeout: goawayTimeout,
    });

    await this.sendControlMessage(MessageType.GOAWAY, payload, {
      newSessionUri: newSessionUri ?? "",
      timeout: goawayTimeout.toString(),
    });

    // draft-ietf-moq-transport-19 Section 3.6:
    // "The sender SHOULD close the session with GOAWAY_TIMEOUT after
    // the indicated timeout if there are still open subscriptions or
    // fetches on a connection."
    if (goawayTimeout > 0n) {
      this.goawayTimeoutId = setTimeout(() => {
        if (this.sessionState === "connected") {
          this.closeWithError(
            new SessionError("GOAWAY timeout expired", SessionErrorCode.GOAWAY_TIMEOUT),
          );
        }
      }, clampTimeoutMs(goawayTimeout));
    }
  }

  /**
   * セッションレベルの統計情報を取得する
   */
  getStatistics(): SessionStatistics {
    return {
      objectsReceivedViaFetch: this.statsObjectsReceivedViaFetch,
      objectsReceivedViaSubscribe: this.statsObjectsReceivedViaSubscribe,
      bytesReceivedViaFetch: this.statsBytesReceivedViaFetch,
      bytesReceivedViaSubscribe: this.statsBytesReceivedViaSubscribe,
      pendingSubgroupStreamsCount: this.pendingSubgroupBuffer.streamCount,
      pendingSubgroupStreamsBytes: this.pendingSubgroupBuffer.totalBytes,
      activePublishers: this.publishers.size,
      activeSubscribers: this.subscribers.size,
      activeFetchers: this.fetchers.size,
      publisherStreamsOpen: this.publisherStreams.size,
      subscriberStreamsActive: this.statsSubscriberStreamsActive,
      unidirectionalStreamsOpened: this.statsUnidirectionalStreamsOpened,
      unidirectionalStreamsReceived: this.statsUnidirectionalStreamsReceived,
      subgroupHeadersReceived: this.statsSubgroupHeadersReceived,
      fetchHeadersReceived: this.statsFetchHeadersReceived,
      controlMessagesSent: this.statsControlMessagesSent,
      controlMessagesReceived: this.statsControlMessagesReceived,
    };
  }

  /**
   * セッションを閉じる
   *
   * draft-ietf-moq-transport-19 Section 3.5:
   * "When WebTransport is used, the session is closed using the
   *  CLOSE_WEBTRANSPORT_SESSION capsule."
   * 正常終了時もユーザー起点で WebTransport を閉じる必要がある。
   * 保持している双方向 / 単方向ストリームの writer を閉じてから transport を閉じることで、
   * QUIC ストリームの FIN 送信とセッション終了通知を行う。
   */
  async close(closeCode: number = SessionErrorCode.NO_ERROR, reason = ""): Promise<void> {
    if (this.sessionState === "closed") {
      return;
    }

    this.sessionState = "closed";

    // GOAWAY タイムアウトタイマーをクリア
    if (this.goawayTimeoutId !== null) {
      clearTimeout(this.goawayTimeoutId);
      this.goawayTimeoutId = null;
    }

    // すべてのパブリッシャー、サブスクライバー、フェッチャーを閉じる
    // 注意: セッションクローズはトラックレベルの PUBLISH_DONE ではなく
    // セッションレベルの終了 (Section 3.5 Termination) であるため handleEnd() ではなく
    // markClosed() を使用する。end コールバックは PUBLISH_DONE 専用。
    for (const pub of this.publishers.values()) {
      pub.markClosed();
    }
    for (const sub of this.subscribers.values()) {
      sub.markClosed();
    }
    for (const fetcher of this.fetchers.values()) {
      fetcher.markClosed();
    }

    // Pending リクエストの Promise を reject する
    const sessionClosedError = new Error("session closed");
    for (const [, pending] of this.pendingPublish) {
      pending.reject(sessionClosedError);
    }
    this.pendingPublish.clear();
    for (const [, pending] of this.pendingSubscribe) {
      pending.reject(sessionClosedError);
    }
    this.pendingSubscribe.clear();
    for (const [, pending] of this.pendingFetch) {
      pending.reject(sessionClosedError);
    }
    this.pendingFetch.clear();
    for (const [, pending] of this.pendingRequestUpdate) {
      pending.reject(sessionClosedError);
    }
    this.pendingRequestUpdate.clear();
    for (const [, pending] of this.pendingTrackStatus) {
      pending.reject(sessionClosedError);
    }
    this.pendingTrackStatus.clear();

    // 閉じた Subgroup の追跡をクリア
    this.closedSubgroups.clear();

    // GOAWAY 受信追跡をクリア
    this.goawayReceivedOnRequestStreams.clear();

    // 受信済み Request ID の追跡をクリア
    this.receivedRequestIds.clear();

    // Pending Subgroup ストリームの buffer を解放
    // 各 entry の所有者 (handleIncomingStream) が remove で実体を削除する
    this.pendingSubgroupBuffer.notifyAll("session-close");

    // Fetcher の登録待ちコールバックを解放
    for (const callbacks of this.fetcherReadyCallbacks.values()) {
      for (const cb of callbacks) {
        cb();
      }
    }
    this.fetcherReadyCallbacks.clear();

    // 保持している双方向 / 単方向ストリームの writer / reader を閉じる。
    // peer 側に FIN / RESET_STREAM を送って受信ループを解除させる。
    // 既に閉じている等の理由で例外が出ても無視する。
    //
    // draft-ietf-moq-transport-19 §3.3.2: セッション解体は graceful request completion
    // ではないため、リクエストストリームには FIN ではなく abort（RESET 相当）を使う。
    // PUBLISH_DONE 無しの FIN は MUST 違反になり得る。
    const abortWriterSafely = async (
      writer: WritableStreamDefaultWriter<Uint8Array>,
    ): Promise<void> => {
      try {
        await writer.abort();
      } catch {
        // ストリームが既に閉じている / abort されている場合は無視
      }
    };
    const closeWriterSafely = async (
      writer: WritableStreamDefaultWriter<Uint8Array>,
    ): Promise<void> => {
      try {
        await writer.close();
      } catch {
        // ストリームが既に閉じている / abort されている場合は無視
      }
    };
    const cancelReaderSafely = async (
      reader: ReadableStreamDefaultReader<Uint8Array>,
    ): Promise<void> => {
      try {
        await reader.cancel();
      } catch {
        // 既に解放されている場合は無視
      }
    };

    // SUBSCRIBE_NAMESPACE 用の双方向ストリーム
    for (const subscription of this.namespaceSubscriptions.values()) {
      subscription.state = "closed";
      if (subscription.writer) {
        void abortWriterSafely(subscription.writer);
      }
      if (subscription.streamReader) {
        void cancelReaderSafely(subscription.streamReader);
      }
    }
    this.namespaceSubscriptions.clear();

    // SUBSCRIBE_TRACKS 用の双方向ストリーム
    // draft-ietf-moq-transport-19 §10.19 (SUBSCRIBE_TRACKS)
    for (const subscription of this.tracksSubscriptions.values()) {
      subscription.state = "closed";
      if (subscription.writer) {
        void abortWriterSafely(subscription.writer);
      }
      if (subscription.streamReader) {
        void cancelReaderSafely(subscription.streamReader);
      }
    }
    this.tracksSubscriptions.clear();

    // PUBLISH_NAMESPACE 用の双方向ストリーム
    for (const publication of this.namespacePublications.values()) {
      publication.state = "closed";
      void abortWriterSafely(publication.writer);
      void cancelReaderSafely(publication.streamReader);
    }
    this.namespacePublications.clear();

    // SUBSCRIBE / PUBLISH / FETCH 等のリクエスト用双方向ストリーム
    for (const entry of this.requestStreams.values()) {
      void abortWriterSafely(entry.writer);
    }
    this.requestStreams.clear();

    // Publisher 用の単方向ストリーム (Subgroup ストリーム)
    for (const entry of this.publisherStreams.values()) {
      void closeWriterSafely(entry.writer);
    }
    this.publisherStreams.clear();

    // 制御用送信ストリーム (単方向) を閉じる。
    // writer は SETUP 送信時に releaseLock しているため、ここでは underlying stream を閉じる。
    if (this.controlSendStream) {
      try {
        await this.controlSendStream.close();
      } catch {
        // ストリームが既に閉じている場合は無視
      }
    }

    // 保持している datagram writer を解放する。
    // 一度も sendDatagram していない場合は未取得 (undefined) なので何もしない。
    if (this.datagramWriter !== undefined) {
      try {
        this.datagramWriter.releaseLock();
      } catch {
        // 既に解放されている場合は無視
      }
      this.datagramWriter = undefined;
    }

    // 受信双方向ストリームの reader を解放する
    if (this.incomingBidiStreamReader) {
      try {
        await this.incomingBidiStreamReader.cancel();
      } catch {
        // 既にキャンセル済みの場合は無視
      }
      try {
        this.incomingBidiStreamReader.releaseLock();
      } catch {
        // 既に解放されている場合は無視
      }
      this.incomingBidiStreamReader = undefined;
    }

    // WebTransport セッションを閉じて peer に終了を通知する
    try {
      this.transport.close({ closeCode, reason });
    } catch {
      // 既に閉じている場合は無視
    }

    // close コールバックはコンストラクタの transport.closed 監視で呼ばれる
  }

  // プライベートメソッド

  /**
   * セッションエラーを通知してセッションを閉じる
   *
   * draft-ietf-moq-transport-19 Section 3.5:
   * プロトコル違反等のエラーが発生した場合、セッションを閉じる必要がある。
   */
  private closeWithError(error: SessionError): void {
    this.callbacks.error?.(error);
    void this.close(error.code, error.message);
  }

  /**
   * read loop で発生したエラーを必要なときだけ callbacks.error に通知する
   *
   * draft-ietf-moq-transport-19 Section 3.5:
   * peer 起点で WebTransport セッションが閉じた場合、各ストリームの read() は
   * reject するが、これは正常な終了通知であり onError には流さない。
   * sessionState がすでに connected でない、または error が WebTransport セッション
   * 終了起源の場合はスキップし、それ以外のみ通知する。
   */
  private notifyErrorIfActive(error: Error): void {
    if (this.sessionState !== "connected") {
      return;
    }
    if (isSessionClosedError(error)) {
      this.sessionState = "closed";
      return;
    }
    this.callbacks.error?.(error);
  }

  private emitDebug(
    direction: "send" | "recv",
    type: number,
    payload: Uint8Array,
    decoded?: Record<string, unknown>,
  ): void {
    if (!this.callbacks.debug) return;

    this.callbacks.debug({
      direction,
      type,
      typeName: getMessageTypeName(type),
      payload,
      decoded,
      timestamp: Date.now(),
    });
  }

  private async sendControlMessage(
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
   * draft-ietf-moq-transport-19 Section 3.3:
   * リクエスト (SUBSCRIBE, PUBLISH, FETCH, TRACK_STATUS 等) は
   * 双方向ストリーム上で送受信される。
   * draft-ietf-moq-transport-19 Section 3.3
   *
   * @param requestId - リクエスト ID
   * @param type - メッセージタイプ
   * @param payload - エンコード済みペイロード
   * @param decoded - デバッグ用のデコード済みメッセージ
   * @returns 双方向ストリームの情報
   */
  private async sendRequestOnBidiStream(
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
   * draft-ietf-moq-transport-19 Section 2.2:
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
   * draft-ietf-moq-transport-19 Section 11.3 (Datagrams)
   */
  private sendDatagram(publisher: PublisherImpl, params: SendDatagramParams): void {
    publishSendDatagram(this as unknown as SessionInternal, publisher, params);
  }

  /**
   * draft-ietf-moq-transport-19 Section 10.11 (PUBLISH_DONE):
   * PUBLISH_DONE は双方向ストリーム上で送信される。
   * Request ID フィールドはない（bidi stream で特定可能）。
   */
  private async sendPublishDone(publisher: PublisherImpl): Promise<void> {
    return publishSendPublishDone(this as unknown as SessionInternal, publisher);
  }

  /**
   * サブスクリプションをキャンセルする
   *
   * draft-ietf-moq-transport-19 Section 3.3.1:
   * subscription のキャンセルは双方向ストリームの close で行う。
   */
  private async cancelSubscription(subscriber: SubscriberImpl): Promise<void> {
    return bidi.bidiCancelSubscription(this as unknown as bidi.BidiSessionInternal, subscriber);
  }

  /**
   * Fetch をキャンセルする
   *
   * draft-ietf-moq-transport-19 Section 5.2:
   * "It MUST send STOP_SENDING for the bidi request stream."
   */
  private async cancelFetch(fetcher: FetcherImpl): Promise<void> {
    return bidi.bidiCancelFetch(this as unknown as bidi.BidiSessionInternal, fetcher);
  }

  /**
   * REQUEST_UPDATE を送信する
   *
   * draft-ietf-moq-transport-19 Section 10.9 (REQUEST_UPDATE):
   * REQUEST_UPDATE はリクエストと同じ双方向ストリーム上で送信する。
   *
   * REQUEST_UPDATE Message {
   *   Type (i) = 0x2,
   *   Length (16),
   *   Request ID (i),
   *   Parameters (..) ...
   * }
   */
  private async sendRequestUpdate(
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
   * draft-ietf-moq-transport-19 Section 10.5 (REQUEST_OK):
   * PUBLISH_OK は双方向ストリーム上の最初のレスポンスとして送信される。
   * その後、同じストリームで REQUEST_UPDATE の応答も受信する。
   * draft-ietf-moq-transport-19 Section 3.3
   */
  private async readPublishResponse(
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
   * draft-ietf-moq-transport-19 Section 10.8 (SUBSCRIBE_OK):
   * SUBSCRIBE_OK は双方向ストリーム上の最初のレスポンスとして送信される。
   * draft-ietf-moq-transport-19 Section 3.3
   */
  private async readSubscribeResponse(
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
   * draft-ietf-moq-transport-19 Section 10.13 (FETCH_OK):
   * FETCH_OK は双方向ストリーム上の最初のレスポンスとして送信される。
   * draft-ietf-moq-transport-19 Section 3.3
   */
  private async readFetchResponse(
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
   * draft-ietf-moq-transport-19 Section 10.14 (TRACK_STATUS):
   * TRACK_STATUS へのレスポンスは REQUEST_OK で返される。
   * draft-ietf-moq-transport-19 Section 3.3
   */
  private async readTrackStatusResponse(
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

  private startControlMessageLoop(): void {
    void (async () => {
      if (!this.controlReceiveStream || !this.controlReader) return;

      const reader = this.controlReceiveStream.getReader();

      try {
        while (this.sessionState === "connected") {
          const { value, done } = await reader.read();
          if (done) {
            // draft-ietf-moq-transport-19 Section 3.3:
            // "A control stream MUST NOT be closed at the underlying transport layer
            // during the session's lifetime. Doing so results in the session being
            // closed as a PROTOCOL_VIOLATION."
            if (this.sessionState === "connected") {
              this.closeWithError(
                new SessionError(
                  "control stream closed unexpectedly",
                  SessionErrorCode.PROTOCOL_VIOLATION,
                ),
              );
            }
            break;
          }

          const messages = this.controlReader.feed(value);
          for (const msg of messages) {
            this.handleControlMessage(msg.type, msg.payload);
          }
        }
      } catch (err) {
        this.notifyErrorIfActive(err instanceof Error ? err : new Error(String(err)));
      } finally {
        reader.releaseLock();
      }
    })();
  }

  /**
   * 制御ストリーム上のメッセージを処理する
   *
   * draft-ietf-moq-transport-19 Section 3.3:
   * リクエスト/レスポンス (SUBSCRIBE_OK, PUBLISH_OK, FETCH_OK, REQUEST_OK,
   * REQUEST_ERROR) は双方向ストリームに移動した。
   * 制御ストリームに残るのは GOAWAY のみ。
   * draft-ietf-moq-transport-19 Section 3.3
   *
   * draft-ietf-moq-transport-19 Section 10.15 (PUBLISH_NAMESPACE):
   * PUBLISH_NAMESPACE は新しい双方向ストリームの先頭メッセージとして送信される。
   * 制御ストリーム上で受信した場合は PROTOCOL_VIOLATION でセッションを閉じる。
   */
  private handleControlMessage(type: number, payload: Uint8Array): void {
    this.statsControlMessagesReceived++;
    let decoded: Record<string, unknown> | undefined;

    switch (type) {
      case MessageType.PUBLISH_DONE:
        // draft-ietf-moq-transport-19 Section 10.11 (PUBLISH_DONE):
        // PUBLISH_DONE は双方向ストリーム上でのみ送信される。
        // 制御ストリーム上で受信した場合は仕様違反。
        this.closeWithError(
          new SessionError(
            "received PUBLISH_DONE on control stream, expected on bidirectional stream",
            SessionErrorCode.PROTOCOL_VIOLATION,
          ),
        );
        return;
      case MessageType.GOAWAY:
        decoded = this.handleGoaway(payload);
        break;
      default:
        // draft-ietf-moq-transport-19 Section 10 (Control Messages):
        // "An endpoint that receives an unknown message type MUST close the session."
        this.closeWithError(
          new SessionError(
            `unknown control message type: 0x${type.toString(16)}`,
            SessionErrorCode.PROTOCOL_VIOLATION,
          ),
        );
        return;
    }

    this.emitDebug("recv", type, payload, decoded);
  }

  /**
   * GOAWAY メッセージを処理する
   *
   * draft-ietf-moq-transport-19 Section 10.4 (GOAWAY):
   * GOAWAY を受信したエンドポイントは SUBSCRIBE, PUBLISH, FETCH, PUBLISH_NAMESPACE,
   * SUBSCRIBE_NAMESPACE, TRACK_STATUS を含む新規リクエストを peer に対して
   * 開始すべきでない。
   *
   * 複数の GOAWAY メッセージを受信した場合、エンドポイントは PROTOCOL_VIOLATION で
   * セッションを終了しなければならない。
   */
  private handleGoaway(payload: Uint8Array): Record<string, unknown> {
    // 複数回の GOAWAY 受信は PROTOCOL_VIOLATION
    if (this.receivedGoaway) {
      this.closeWithError(
        new SessionError("received multiple GOAWAY messages", SessionErrorCode.PROTOCOL_VIOLATION),
      );
      return { error: "Multiple GOAWAY messages received" };
    }

    // デコードに失敗した場合（trailing data 等）は PROTOCOL_VIOLATION でセッションを閉じる。
    // receivedGoaway はデコード成功後に立てることで、半端状態を避ける
    let msg: ReturnType<typeof decodeGoawayPayload>;
    try {
      msg = decodeGoawayPayload(payload);
    } catch (error) {
      const sessionError = toProtocolViolationSessionError(error);
      if (sessionError) {
        this.closeWithError(sessionError);
        return { error: "GOAWAY decode failed" };
      }
      throw error;
    }

    this.receivedGoaway = true;

    // GOAWAY コールバックを呼び出す
    this.callbacks.goaway?.(msg.newSessionUri);

    // draft-ietf-moq-transport-19 Section 3.6:
    // サーバーが指定した timeout 内にセッションを閉じなければ、
    // サーバーが GOAWAY_TIMEOUT でセッションを切断する。
    // クライアント側でもタイムアウトを設定し、期限内にグレースフルシャットダウンを試みる。
    if (msg.timeout > 0n) {
      this.goawayTimeoutId = setTimeout(() => {
        if (this.sessionState === "connected") {
          void this.close();
          this.transport.close({
            closeCode: SessionErrorCode.NO_ERROR,
            reason: "graceful shutdown after receiving GOAWAY",
          });
        }
      }, clampTimeoutMs(msg.timeout));
    }

    return {
      newSessionUri: msg.newSessionUri,
      timeout: msg.timeout.toString(),
    };
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
   * draft-ietf-moq-transport-19 §10.9.2 (Updating Namespace Subscriptions):
   * REQUEST_UPDATE に TRACK_NAMESPACE_PREFIX パラメータを含めて送信する。
   * 送信と応答待ちは bidi.bidiSendNamespaceRequestUpdate が行う。
   */
  private async sendNamespaceRequestUpdate(
    requestId: bigint,
    kind: "namespace" | "tracks",
    options: NamespaceUpdateOptions,
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
   * draft-ietf-moq-transport-19 §6.1:
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

    // ストリームを閉じる（FIN を送信）
    try {
      if (subscription.writer) {
        await subscription.writer.close();
      }
    } catch {
      // ストリームが既に閉じられている場合は無視
    }

    this.namespaceSubscriptions.delete(requestId);
  }

  /**
   * TracksSubscription オブジェクトを作成する
   *
   * draft-ietf-moq-transport-19 §10.19 (SUBSCRIBE_TRACKS)
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
    const update = (options: NamespaceUpdateOptions): Promise<void> => {
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
   * draft-ietf-moq-transport-19 §6.1:
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

    try {
      if (subscription.writer) {
        await subscription.writer.close();
      }
    } catch {
      // ストリームが既に閉じられている場合は無視
    }

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
   * draft-ietf-moq-transport-19 §6.2:
   * PUBLISH_NAMESPACE_DONE / PUBLISH_NAMESPACE_CANCEL は廃止され、
   * 公開の終了は双方向ストリームを FIN または RESET_STREAM で閉じることで通知する。
   * https://www.ietf.org/archive/id/draft-ietf-moq-transport-19.html#section-6.2
   */
  private async closeNamespacePublication(requestId: bigint): Promise<void> {
    const publication = this.namespacePublications.get(requestId);
    if (!publication || publication.state === "closed") {
      return;
    }

    publication.state = "closed";

    // ストリームを閉じる（FIN を送信）
    try {
      await publication.writer.close();
    } catch {
      // ストリームが既に閉じられている場合は無視
    }

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
   * draft-ietf-moq-transport-19 Section 11.3 (Datagrams)
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
   * draft-ietf-moq-transport-19 §10.19 (SUBSCRIBE_TRACKS):
   * SUBSCRIBE_TRACKS への応答として、サーバーは新規双方向ストリームを開き
   * PUBLISH メッセージを送信する。このループで incomingBidirectionalStreams を
   * 監視し、到着した双方向ストリームを処理する。
   *
   * draft-ietf-moq-transport-19 §3.3 (Bidirectional Streams):
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
    callbacks: SubscribeCallbacks,
  ): Promise<void> {
    // draft-ietf-moq-transport-19 §10.4:
    // GOAWAY 受信後も読み取りを継続して 2 通目以降の GOAWAY を検出するための
    // フラグ。GOAWAY 受信時は state 遷移を行わないため、catch での spurious
    // error 通知を抑止する判定に使う。
    let goawayReceived = false;
    try {
      while (impl.state === "active") {
        const { value, done } = await subReader.read();
        if (done) {
          // draft-ietf-moq-transport-19 §10.9.1:
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
          // draft-ietf-moq-transport-19 §3.3.2:
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
          if (msg.type === MessageType.GOAWAY) {
            if (
              !bidi.validateNoDuplicateGoawayOnRequestStream(
                publishRequestId,
                this.goawayReceivedOnRequestStreams,
                (error) => this.closeWithError(error),
              )
            ) {
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
            // draft-ietf-moq-transport-19 §10.4:
            // GOAWAY 受信時点で旧ストリーム上の未応答 REQUEST_UPDATE は失敗
            // として扱う (受信 PUBLISH の subscriber として送信済みの update()
            // の Promise を未解決のまま残さない)。GOAWAY 後の読み取り継続中に
            // REQUEST_OK / REQUEST_ERROR が届いても、エントリ削除済みのため
            // 二重解決しない。
            bidi.rejectPendingRequestUpdates(
              this as unknown as bidi.BidiSessionInternal,
              publishRequestId,
              new RequestError(bidi.REQUEST_GOING_AWAY_REASON, RequestErrorCode.GOING_AWAY),
            );
            // GOAWAY 受信後も読み取りを継続して 2 通目以降の GOAWAY を検出する
            // (§10.4 MUST)。受信 PUBLISH の subscriber (impl) は送信方向を
            // FIN (writer.close()) で閉じ、受信方向は読み取りを継続する。
            const streamInfo = this.requestStreams.get(publishRequestId);
            if (streamInfo) {
              try {
                await streamInfo.writer.close();
              } catch {
                // ストリームが既に閉じている場合は無視
              }
            }
            continue;
          }
          if (msg.type === MessageType.REQUEST_UPDATE) {
            // draft-ietf-moq-transport-19 §10.9 ケース 1:
            // 「The sender of a request (SUBSCRIBE, PUBLISH, FETCH,
            // PUBLISH_NAMESPACE, SUBSCRIBE_NAMESPACE, SUBSCRIBE_TRACKS) can
            // later send a REQUEST_UPDATE on the same bidi stream as the
            // request to modify it.」
            // 受信 PUBLISH の publisher (ピア) による REQUEST_UPDATE を処理し、
            // REQUEST_OK / REQUEST_ERROR を 1 通応答する (§10.9 MUST)。
            // GOAWAY 受信後 / パラメータスコープ検証 / 文脈限定パラメータの
            // 判定は free function 内で行う (GOING_AWAY 応答も同関数の判定
            // 順序 (1) が担う)。スコープ違反等でセッションが閉じた場合は、
            // 同一チャンクの残りメッセージの処理を打ち切る。
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
            continue;
          }
          if (msg.type === MessageType.REQUEST_ERROR) {
            const decoded = decodeRequestErrorPayload(msg.payload);
            const error = new RequestError(
              decoded.reasonPhrase || `Request failed with code ${decoded.errorCode}`,
              normalizeRequestErrorCode(Number(decoded.errorCode)),
            );
            // draft-ietf-moq-transport-19 §10.9: coalescing により単一 REQUEST_ERROR で
            // 複数の REQUEST_UPDATE が失敗し得る。該当 pending をすべて reject する
            bidi.rejectPendingRequestUpdates(
              this as unknown as bidi.BidiSessionInternal,
              publishRequestId,
              error,
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
      }
    } catch (err) {
      // draft-ietf-moq-transport-19 §10.4:
      // GOAWAY 受信後 (goawayReceived) は state が active のままのため、
      // spurious error 通知を抑止する (namespace ループと同様)
      if (impl.state === "active" && !goawayReceived) {
        // WebTransport セッション終了起因のエラーは購読者へ通知しない (従来どおり)
        const normalizedError = err instanceof Error ? err : new Error(String(err));
        if (!isSessionClosedError(normalizedError)) {
          // bidiReadRequestStreamMessages の subscribe ロールと同じ判定になるよう、
          // 正規化前の生のエラーを評価する
          if (isPeerStreamError(err)) {
            // draft-ietf-moq-transport-19 §3.3.3:
            // ピアの RESET_STREAM で readable がエラー終了した場合 (source: "stream") は、
            // subscribe ロール側と同じく error 通知 + state closed にする。仕様は
            // ピアの RESET_STREAM を受けた側のアプリへの通知内容も subscription state
            // の扱いも規定していない (§3.3.3 は RESET_STREAM / STOP_SENDING の手段と
            // rejection 時の応答を定めるのみ) ため、subscribe ロール側と同じ実装上の
            // 判断として揃える。
            // 通知と markClosed は notifySubscriberFailure の内部契約 (try/finally) に
            // 委ねるため、生の callbacks.error は呼ばない (二重通知になる)。
            // notifySubscriberFailure は subscribers から引くため、unsubscribe 済みで
            // エントリが削除された窓では通知しない (subscribe ロール側と同じ)。
            // 通知メッセージは subscribe ロール側と同一の固定文言を使う。
            // 内側に try/catch が必要なのは、catch ブロック内で throw すると戻り値の
            // Promise が reject し、呼び出し元の requestStreams / subscribers の
            // クリーンアップがスキップされるためである。ここが守るのはこの通知経路
            // だけである (セッションレベルの error コールバック例外が伝播する経路は
            // 別途対応)。
            try {
              bidi.notifySubscriberFailure(
                this as unknown as bidi.BidiSessionInternal,
                publishRequestId,
                new Error(bidi.RESET_REQUEST_STREAM_MESSAGE),
              );
            } catch {
              // アプリの error コールバック例外は吸収する (markClosed は
              // notifySubscriberFailure 内の finally で実行済み)。
            }
          } else {
            // source: "stream" 以外 (ProtocolViolationError 経由等の内部例外) は
            // 従来どおり生のエラーを通知し、state は変更しない。アプリの error
            // コールバック例外を吸収するのは、上記と同じく呼び出し元の後始末を
            // スキップさせないため (FIN 経路の notifySubscriberFailure は外側 try 内
            // で呼ばれるため元々吸収されている)。
            try {
              callbacks.error?.(normalizedError);
            } catch {
              // アプリの error コールバック例外は吸収する
            }
          }
        }
      }
      const sessionError = toProtocolViolationSessionError(err);
      if (sessionError !== null) {
        this.closeWithError(sessionError);
      }
    }
  }

  /**
   * 受信した双方向ストリームを処理する
   *
   * draft-ietf-moq-transport-19 §10.19 (SUBSCRIBE_TRACKS):
   * SUBSCRIBE_TRACKS への応答としてサーバーが開く双方向ストリームでは、
   * 先頭メッセージとして PUBLISH が送信される。
   *
   * draft-ietf-moq-transport-19 §3.3:
   * 双方向ストリームは特定のメッセージタイプで開始されなければならない。
   */
  private async handleIncomingBidirectionalStream(
    stream: WebTransportBidirectionalStream,
  ): Promise<void> {
    if (this.sessionState !== "connected") {
      try {
        await stream.readable.cancel();
      } catch {
        /* ignore */
      }
      return;
    }

    const firstMsg = await this.readFirstBidiMessage(stream);
    if (firstMsg === null) {
      return;
    }

    // 先頭メッセージを 3 分類して処理する
    // draft-ietf-moq-transport-19 §3.3 (Session initialization):
    // 先頭が 7 種以外のメッセージタイプの場合は PROTOCOL_VIOLATION でセッションを閉じる。
    // 7 種のうち未対応のリクエストには NOT_SUPPORTED を応答する (§4 SHOULD)。
    // true が返れば先頭メッセージの処理が完了しているため return する。
    if (
      await incomingHandleFirstBidiMessage(this as unknown as SessionInternal, stream, firstMsg)
    ) {
      return;
    }

    // PUBLISH ペイロードをデコード
    // draft-ietf-moq-transport-19 §10.10
    let decodedPublish: ReturnType<typeof decodePublishPayload>;
    try {
      decodedPublish = decodePublishPayload(firstMsg.payload);
    } catch (err) {
      // draft-ietf-moq-transport-19 §2.5.1:
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
      const sessionError = toProtocolViolationSessionError(err);
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

    // draft-ietf-moq-transport-19 §10.1 (Request ID):
    // 受信 PUBLISH の Request ID のパリティ (奇数) と重複を検証する。
    // 違反時は INVALID_REQUEST_ID でセッションを閉じる。
    if (!this.validateIncomingPublishRequestId(publishRequestId)) {
      return;
    }

    // draft-ietf-moq-transport-19 §3.2.1 / §3.2.2:
    // 受信 PUBLISH の Track Namespace 先頭フィールドが "." 単体または
    // ".session" の場合、REQUEST_ERROR (DOES_NOT_EXIST) で拒否してアプリへ
    // 渡さない (§3.2.1 / §3.2.2 の MUST)。それ以外の予約名前空間
    // (例: ".foo") は §3.2.1 によりアプリへ渡す。
    // 拒否時は §3.3.3 の SHOULD に従い REQUEST_ERROR 送信後に送信方向を
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

    // draft-ietf-moq-transport-19 §10.2.1 (Parameter Scope):
    // PUBLISH に許可されていないパラメータは PROTOCOL_VIOLATION
    if (
      !validateParameterScope(
        decodedPublish.parameters,
        PUBLISH_ALLOWED_PARAMS,
        "PUBLISH",
        (error) => this.closeWithError(error),
      )
    ) {
      return;
    }

    // trackNamespace がアクティブな tracksSubscriptions の namespacePrefix に前方一致するか検証
    const match = this.matchPublishToSubscription(publishTrackNamespace);
    if (match === null) {
      // draft-ietf-moq-transport-19 §10.10 (SHOULD): マッチしない PUBLISH は UNINTERESTED
      await incomingSendRequestErrorAndClose(stream, RequestErrorCode.UNINTERESTED, "uninterested");
      return;
    }

    // draft-ietf-moq-transport-19 §11.1 (Track Alias):
    // 同一 Track Alias が異なる Track に使われている場合は DUPLICATE_TRACK_ALIAS でセッション終了。
    // 同一 Track への複数 PUBLISH は draft-19 §5.1 で許可される。
    // TRACK_PROPERTY_FILTER 評価より先に検証する (フィルタ不通過で UNINTERESTED 応答すると
    // alias 重複というセッション違反が検出されず隠れるため)。
    const existingSubscribers = this.subscribersByAlias.get(publishTrackAlias);
    if (existingSubscribers !== undefined && existingSubscribers.length > 0) {
      const fullTrackName = `${publishTrackNamespace.join("/")}/${publishTrackName}`;
      if (existingSubscribers[0].getFullTrackName() !== fullTrackName) {
        this.closeWithError(
          new SessionError(
            `track alias 0x${publishTrackAlias.toString(16)} used for different tracks`,
            SessionErrorCode.DUPLICATE_TRACK_ALIAS,
          ),
        );
        return;
      }
    }

    // draft-ietf-moq-transport-19 §5.1.3:
    // TRACK_PROPERTY_FILTER の評価 (受信 PUBLISH の Track Properties に対する検索)。
    // 通過しない PUBLISH は onPublish を呼ばず、§10.10 の SHOULD に従い
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

    // draft-ietf-moq-transport-19 §5.1 (Subscriptions):
    // "The initiator of the subscription sets the initial Forward State in
    //  either PUBLISH or SUBSCRIBE."
    // 受信 PUBLISH の FORWARD パラメータ (省略時は §10.2.17 のデフォルト 1)
    // を Forward State として保持する。
    impl.setForwardState(extractForwardState(decodedPublish.parameters));

    // draft-ietf-moq-transport-19 §5.1.3:
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
    });

    impl.onUnsubscribe = async () => {
      return bidi.bidiCancelSubscription(this as unknown as bidi.BidiSessionInternal, impl);
    };
    impl.onUpdate = async (options: RequestUpdateOptions) => {
      return bidi.bidiSendRequestUpdate(this as unknown as bidi.BidiSessionInternal, impl, options);
    };

    this.pendingSubgroupBuffer.notifyAlias(publishTrackAlias, "subscriber");

    // PUBLISH_OK を送信 (draft-ietf-moq-transport-19 §5.1 MUST)
    {
      const publishOkPayload = encodeRequestOkPayload({
        type: MessageType.REQUEST_OK,
        parameters: [],
        trackProperties: [],
      });
      const controlWriter = new ControlStreamWriter();
      const framed = controlWriter.encode(MessageType.REQUEST_OK, publishOkPayload);
      await subWriter.write(framed);
    }

    // 後続メッセージのサブループ
    await this.runPublishStreamSubLoop(
      impl,
      publishRequestId,
      subReader,
      subControlReader,
      subscribeCallbacks,
    );

    this.requestStreams.delete(publishRequestId);
    this.subscribers.delete(publishRequestId);
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
        return {
          callbacks: subscription.callbacks,
          suffix,
          rangeFilters: subscription.rangeFilters,
        };
      }
    }
    return null;
  }

  /**
   * 受信した datagram を処理する
   * draft-ietf-moq-transport-19 Section 11.3 (Datagrams)
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
            return messages[0];
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
   * 受信 PUBLISH の Request ID のパリティ・重複検証を行う
   *
   * draft-ietf-moq-transport-19 §10.1 (Request ID):
   * moqt-js はクライアントロールのため、受信 Request ID はサーバー発の奇数が
   * 期待値。違反時は INVALID_REQUEST_ID でセッションを閉じる。
   * 予約 namespace 拒否 / パラメータスコープ検証 / DUPLICATE_TRACK_ALIAS の
   * 各既存検証より前に配置する (§10.1 の MUST は受信即時閉鎖のため)。
   *
   * 適用範囲は受信 PUBLISH のみ。受信リクエスト 6 種 (ペイロード非デコードの
   * ため検証は発火しない) と受信 REQUEST_UPDATE (スコープ外) では適用されない
   * (残余リスク)。
   *
   * @returns 検証に合格した場合は true、違反でセッションを閉じた場合は false
   */
  private validateIncomingPublishRequestId(requestId: bigint): boolean {
    return incomingValidateRequestId(requestId, this.receivedRequestIds, (error) =>
      this.closeWithError(error),
    );
  }

  /**
   * Fetcher の登録を待つ
   *
   * draft-ietf-moq-transport-19 Section 10.13 (FETCH_OK):
   * "A publisher MAY send Objects in response to a FETCH before the
   *  FETCH_OK message is sent."
   * FETCH_OK より先にデータストリームが到着した場合に使用。
   */
  private waitForFetcher(requestId: bigint): Promise<FetcherImpl | null> {
    return incomingWaitForFetcher(this as unknown as SessionInternal, requestId);
  }

  /**
   * 受信した単方向データストリームを処理する
   * draft-ietf-moq-transport-19 Section 11.4 (Streams)
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

    try {
      while (true) {
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
              // draft-ietf-moq-transport-19 Section 10.13 (FETCH_OK):
              // FETCH_OK より先にデータストリームが到着する可能性がある
              fetcher = this.fetchers.get(header.requestId) ?? null;
              if (!fetcher) {
                fetcher = await this.waitForFetcher(header.requestId);
                if (!fetcher) {
                  // タイムアウトで Fetcher が登録されなかった場合は、
                  // peer に STOP_SENDING (cancel) を送って受信を打ち切る。
                  // draft-ietf-moq-transport-19 Section 5.2 (Fetch State Management) に倣ってストリームを reset する。
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
              // draft-ietf-moq-transport-19 Section 11.4.2:
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
              // draft-ietf-moq-transport-19 §11.4.2 の buffer 経路はこのハンドラ内に集約
              await this.handleSubgroupStream(reader, header, initialPayloadBuffer);
              return;
            } else if (streamTypeNum === 0x132b3e28) {
              // draft-ietf-moq-transport-19 §11.5.1 (Padding Streams):
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
              // draft-ietf-moq-transport-19 Section 3.4 (Unidirectional Stream Types):
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
              // §11.4 の未完成 Object 判定 (FIN 直後の残バッファ検査) の
              // 対象外として黙殺する
              if (done) break;
              continue;
            }
            const sessionError = toProtocolViolationSessionError(err);
            if (sessionError !== null) {
              // 仕様違反: PROTOCOL_VIOLATION でセッションを閉じる
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
            // draft-ietf-moq-transport-19 Section 11.4.4.1 (Flags):
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
        // draft-ietf-moq-transport-19 Section 11.4 (Streams):
        // "If a stream ends gracefully (i.e., the stream terminates with a
        //  FIN) in the middle of a serialized Object, the session SHOULD be
        //  closed with a PROTOCOL_VIOLATION."
        // fetcher.handleEnd() も fetchers.delete も行わず、セッションを
        // PROTOCOL_VIOLATION で閉じる (fetcher の無効化はセッション終了側
        // に委ねる)。
        // close() を経ずに sessionState が closed へ遷移する経路
        // (transport.closed ハンドラ、条件付きで遷移する
        // notifyErrorIfActive) では fetcher が active のまま残るが、
        // いずれの close 済み経路でも end を通知せず return する
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
      }
    } catch (err) {
      // デバッグ: ストリームエラーをログ
      this.emitDataStreamErrorDebug(err, fetchHeader);
      // ProtocolViolationError は仕様違反のため PROTOCOL_VIOLATION でセッションを閉じる
      const sessionError = toProtocolViolationSessionError(err);
      if (sessionError !== null) {
        this.closeWithError(sessionError);
      } else if (err instanceof MalformedTrackError) {
        await this.handleMalformedFetchTrack(reader, err, fetcher);
      }
    } finally {
      this.statsSubscriberStreamsActive--;
      reader.releaseLock();
    }
  }

  /**
   * DATA_STREAM_ERROR のデバッグログを出力する
   *
   * FETCH データストリームの場合は対象の requestId を含めて追跡できるようにする。
   * fetchHeader は Fetch ヘッダーパース時にのみ設定されるため、非 null なら
   * FETCH データストリームと判定できる。
   */
  private emitDataStreamErrorDebug(
    err: unknown,
    fetchHeader: import("./dataStream").FetchHeader | null,
  ): void {
    this.callbacks.debug?.({
      direction: "recv",
      type: 0,
      typeName: "DATA_STREAM_ERROR",
      payload: new Uint8Array(0),
      decoded: {
        error: err instanceof Error ? err.message : String(err),
        ...(fetchHeader ? { requestId: fetchHeader.requestId.toString() } : {}),
      },
      timestamp: Date.now(),
    });
  }

  /**
   * Malformed Track 検出時の FETCH キャンセル処理
   *
   * draft-ietf-moq-transport-19 §2.4.2 (Malformed Tracks):
   * Malformed Track 検出時は「cancel any corresponding subscription or fetches
   * for that Track from that publisher」であり、セッションを閉じない。
   * まず受信データストリームを STOP_SENDING 相当 (cancelStreamQuiet) で打ち切る。
   * fetcher が存在する場合 (FETCH データストリーム)、fetcher の error コールバックで
   * アプリへ通知し (§2.4.2 SHOULD)、FetcherImpl.cancel() 経由で
   * draft-ietf-moq-transport-19 §5.2 の MUST「It MUST send STOP_SENDING for
   * the bidi request stream.」に従い bidi リクエストストリームへ STOP_SENDING
   * を送り、fetchers Map から削除する。
   *
   * §2.4.2 の「fetches for that Track」は複数形だが、FETCH ごとにデータストリーム
   * と検出が独立するため、対象は該当 requestId の FETCH のみとする (同一 Track の
   * 他 FETCH には波及しない)。Joining Fetch も bidiSendJoiningFetch が新規 bidi
   * ストリームを開いて requestStreams に登録するため (§10.12「A subscriber sends
   * FETCH as the first message on a new bidi stream」)、同じく STOP_SENDING が送られる。
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
      try {
        fetcher.handleError(error);
      } catch {
        // アプリの error コールバックの throw は握り潰す (キャンセルは継続する)
      } finally {
        await fetcher.cancel();
      }
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
    );
  }

  /**
   * Subgroup オブジェクトをストリーミング処理
   * パース可能なオブジェクトを全て処理し、残りのバッファと状態を返す
   */
  private processSubgroupObjects(
    buffer: Uint8Array,
    subscribers: SubscriberImpl[],
    header: import("./dataStream").SubgroupHeader,
    previousObjectId: bigint,
  ): { remainingBuffer: Uint8Array; previousObjectId: bigint } {
    return incomingProcessSubgroupObjects(
      this as unknown as SessionInternal,
      buffer,
      subscribers,
      header,
      previousObjectId,
    );
  }

  /**
   * Subgroup ストリームを処理する
   *
   * draft-ietf-moq-transport-19 §11.4.2:
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
    let subscribers: SubscriberImpl[] = this.subscribersByAlias.get(header.trackAlias) ?? [];

    // pending mode で発火された read Promise を subscriber mode に持ち越すための変数
    // ReadableStreamDefaultReader.read() は中断不能なため、Promise.race で別経路が
    // 勝ったときに pendingRead を破棄せず保持し、subscriber mode の最初の read として消費する
    let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;

    if (subscribers.length === 0) {
      const entry = this.pendingSubgroupBuffer.add(header.trackAlias, header);
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
              entry.notify("end-of-stream");
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
    while (true) {
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

      const processResult = this.processSubgroupObjects(
        buffer,
        subscribers,
        header,
        previousObjectId,
      );
      buffer = processResult.remainingBuffer;
      previousObjectId = processResult.previousObjectId;

      if (result.done) break;
    }

    // ここに到達した時点でピアの FIN を検出している (上記ループは
    // result.done でしか抜けない)。
    // draft-ietf-moq-transport-19 Section 11.4 (Streams):
    // "If a stream ends gracefully (i.e., the stream terminates with a
    //  FIN) in the middle of a serialized Object, the session SHOULD be
    //  closed with a PROTOCOL_VIOLATION."
    // §11.4.3 (Closing Subgroup Streams) は全 Object を配信せずに閉じる場合
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
