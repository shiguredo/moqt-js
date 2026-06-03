/**
 * MOQT Session
 * draft-ietf-moq-transport-18 Section 3 (Sessions)
 */

import { ControlStreamReader, ControlStreamWriter } from "./controlStream";
import {
  encodeSubgroupHeader,
  SubgroupHeaderType,
  decodeSubgroupHeader,
  encodeObjectDatagram,
  decodeObjectDatagram,
  encodeObjectFields,
  DatagramType,
  type MoqtObject,
} from "./dataStream";
export type { MoqtObject } from "./dataStream";
import {
  ClosedSubgroupError,
  DataStreamErrorCode,
  IncompleteDataError,
  MalformedTrackError,
  ProtocolViolationError,
  RequestError,
  SessionError,
  SessionErrorCode,
  normalizeRequestErrorCode,
} from "./error";
import {
  MessageType,
  PublishDoneStatusCode,
  ObjectStatus,
  createTrackNamespace,
  encodeTrackName,
  trackNamespaceToStrings,
  decodeGoawayPayload,
  decodeNamespaceDonePayload,
  decodeNamespacePayload,
  decodePublishBlockedPayload,
  decodeRequestErrorPayload,
  decodeRequestOkPayload,
  decodeSetupPayload,
  getSetupAuthority,
  getSetupPath,
  encodeSetupPayload,
  encodeFetchPayload,
  encodeGoawayPayload,
  encodePublishNamespacePayload,
  encodePublishPayload,
  encodeSubscribeNamespacePayload,
  encodeSubscribeTracksPayload,
  encodeSubscribePayload,
  encodeTrackStatusPayload,
  createSetup,
  getMessageTypeName,
  FetchType,
  type AuthorizationToken,
  type Location,
  type Parameter,
  type SubscriptionFilter,
} from "./message";
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
  calculateObjectIdDelta,
} from "./session/params";
import * as bidi from "./session/bidi";
import {
  processFetchObjects,
  processSubgroupObjects,
  concatChunks,
  cancelStreamQuiet,
} from "./session/stream";
import { isSessionClosedError } from "./session/errors";

/**
 * Session state
 */
export type SessionState = "connected" | "closed";

/**
 * Debug message for logging MOQT protocol messages
 */
export interface DebugMessage {
  /** Message direction */
  direction: "send" | "recv";
  /** Message type number */
  type: number;
  /** Message type name (e.g., "SETUP", "SUBSCRIBE") */
  typeName: string;
  /**
   * Raw payload bytes.
   *
   * The Uint8Array is independent of moqt-js internal buffers and the receiver
   * MAY retain it beyond the callback. The receiver MUST NOT mutate it because
   * the same instance may be referenced by moqt-js internals after the callback
   * returns (e.g. for retransmission or further encoding).
   */
  payload: Uint8Array;
  /** Decoded message content (when available) */
  decoded?: Record<string, unknown>;
  /** Timestamp in milliseconds */
  timestamp: number;
}

/**
 * Connect callbacks
 */
export interface ConnectCallbacks {
  close?: (closeInfo: WebTransportCloseInfo) => void;
  error?: (error: Error) => void;
  /** Debug callback for logging MOQT protocol messages */
  debug?: (message: DebugMessage) => void;
  /**
   * GOAWAY 受信時のコールバック
   * draft-ietf-moq-transport-18 Section 10.4 (GOAWAY)
   * @param newSessionUri - 新しいセッション URI（セッションマイグレーション用）
   */
  goaway?: (newSessionUri: string) => void;
}

/**
 * Certificate hash for self-signed certificates
 * Used with WebTransport's serverCertificateHashes option
 * Note: The certificate must have a validity period of 14 days or less
 */
export interface CertificateHash {
  algorithm: "sha-256";
  value: ArrayBuffer;
}

/**
 * Connect options
 */
export interface ConnectOptions {
  /**
   * Certificate hashes for self-signed certificates
   * Use this for local development with self-signed certificates
   * Note: Certificate validity period must be 14 days or less
   */
  serverCertificateHashes?: CertificateHash[];

  /**
   * Authorization Token to send as SETUP Option (Option Type 0x03)
   * draft-ietf-moq-transport-18 Section 10.3.1.4 (AUTHORIZATION TOKEN Setup Option)
   *
   * SETUP では Alias Type DELETE (0x0) / USE_ALIAS (0x2) は仕様上禁止 (Section 10.2.2)。
   * REGISTER (0x1) または USE_VALUE (0x3) のみ指定できる。
   */
  authorizationToken?: AuthorizationToken;

  /**
   * Pending Subgroup Stream の buffer 設定
   * draft-ietf-moq-transport-18 §11.4.2 の "MAY ... choose to buffer it for a brief
   * period to handle reordering with the control message that establishes the Track
   * Alias" を実現する buffer の上限を制御する。
   *
   * 指定しなかった field は `DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS` の値が使われる。
   */
  pendingSubgroup?: Partial<PendingSubgroupBufferOptions>;
}

/**
 * SessionImpl のコンストラクタが受け取るオプション
 * `connect()` から `ConnectOptions` の該当フィールドが渡される
 */
export interface SessionImplOptions {
  /** ConnectOptions.pendingSubgroup と同じ */
  pendingSubgroup?: Partial<PendingSubgroupBufferOptions>;
  /**
   * moqt URI の Fragment Identifier
   * draft-ietf-moq-transport-18 §3.1.2
   */
  fragment?: MoqtFragment | null;
}

/**
 * Session interface
 */
/**
 * Publish callbacks
 */
export interface PublishCallbacks {
  error?: (error: Error) => void;
  /**
   * Forward State が変更された時のコールバック
   * draft-ietf-moq-transport-18 Section 10.2.12 (FORWARD Parameter)
   *
   * PUBLISH_OK または REQUEST_UPDATE で Forward State が変更された時に呼ばれる。
   * - true (1): Subscriber がいる（オブジェクトを送信すべき）
   * - false (0): Subscriber がいない（オブジェクト送信を止めても良い）
   */
  onForwardStateChange?: (forward: boolean) => void;
  /**
   * リクエストストリーム上で GOAWAY を受信した時のコールバック
   * draft-ietf-moq-transport-18 Section 10.4 (GOAWAY):
   * 当該リクエストのマイグレーション先 URI を通知する。
   */
  goaway?: (newSessionUri: string) => void;
}

/**
 * Publish options
 */
export interface PublishOptions {
  /**
   * キャッシュの最大保持時間（ミリ秒）
   * draft-ietf-moq-transport-18 Section 12.3 (MAX CACHE DURATION)
   *
   * Relay がオブジェクトをキャッシュして良い最大時間を指定する。
   * 0 を指定するとキャッシュを無効にする。
   */
  maxCacheDuration?: bigint;

  /**
   * Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-18 Section 12.2 (OBJECT_DELIVERY_TIMEOUT)
   *
   * PUBLISH の Track Properties として送信される OBJECT_DELIVERY_TIMEOUT（Message Parameter の定義は Section 10.2.4）。
   *
   * オブジェクトを受信してから配信を試みる最大時間。
   * Publisher と Subscriber の両方が指定した場合、小さい方の値が使用される。
   * タイムアウトを超過したオブジェクトは配信されない。
   */
  deliveryTimeout?: bigint;

  /**
   * Publisher Priority（0-255）
   * draft-ietf-moq-transport-18 Section 12.4 (DEFAULT PUBLISHER PRIORITY)
   *
   * パブリッシュの優先度。小さい値ほど高優先度。
   * 指定しない場合は 128（デフォルト）
   */
  publisherPriority?: number;

  /**
   * Group Order
   * draft-ietf-moq-transport-18 Section 12.5 (DEFAULT PUBLISHER GROUP ORDER)
   *
   * グループの配信順序。
   * - "Ascending": 古いグループから順に配信
   * - "Descending": 新しいグループから順に配信
   */
  groupOrder?: "Ascending" | "Descending";

  /**
   * Dynamic Groups サポートの通知
   * draft-ietf-moq-transport-18 Section 12.6 (DYNAMIC GROUPS)
   *
   * true を設定すると、Subscriber が NEW_GROUP_REQUEST パラメータで
   * 新しいグループの生成を要求できることを通知する。
   */
  dynamicGroups?: boolean;

  /**
   * Expires（ミリ秒）
   * draft-ietf-moq-transport-18 Section 10.2.10 (EXPIRES Parameter)
   *
   * パブリッシュが自動終了するまでの時間（ミリ秒）。
   * 0 または未指定の場合は期限なし。
   */
  expires?: bigint;

  /**
   * Forward State
   * draft-ietf-moq-transport-18 Section 10.2.12 (FORWARD Parameter)
   *
   * オブジェクトの転送状態を指定する。
   * - true (1): オブジェクトを転送する（デフォルト）
   * - false (0): オブジェクトを転送しない
   *
   * 省略した場合は 1（転送する）がデフォルト。
   * Relay は Subscriber がいない間は forward=0 で PUBLISH_OK を返す可能性がある。
   */
  forward?: boolean;
}

/**
 * Subscribe callbacks
 */
export interface SubscribeCallbacks {
  object: (object: MoqtObject) => void;
  /**
   * Datagram で受信したオブジェクトのコールバック
   * draft-ietf-moq-transport-18 Section 11.3 (Datagrams)
   *
   * 注意: Datagram は信頼性がなく、順序も保証されない
   */
  datagram?: (object: MoqtObject) => void;
  end?: () => void;
  error?: (error: Error) => void;
  /**
   * リクエストストリーム上で GOAWAY を受信した時のコールバック
   * draft-ietf-moq-transport-18 Section 10.4 (GOAWAY):
   * 当該リクエストのマイグレーション先 URI を通知する。
   */
  goaway?: (newSessionUri: string) => void;
}

/**
 * Joining Fetch オプション
 * draft-ietf-moq-transport-18 Section 10.12.2 (Joining Fetches)
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
}

/**
 * Subscribe options
 */
export interface SubscribeOptions {
  /**
   * Subscription Filter
   * draft-ietf-moq-transport-18 Section 5.1.2, Section 10.2.11
   *
   * どのオブジェクトを受信するかを指定するフィルタ。
   * - NextGroupStart: 次のグループから開始
   * - LargestObject: 最新のオブジェクトから開始
   * - AbsoluteStart: 指定した位置から開始（終了なし）
   * - AbsoluteRange: 指定した範囲のオブジェクトのみ
   *
   * 指定しない場合、フィルタなし（全オブジェクト）
   */
  filter?: SubscriptionFilter;

  /**
   * Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-18 Section 10.2.4 (OBJECT_DELIVERY_TIMEOUT Parameter)
   *
   * オブジェクトを受信してから配信を試みる最大時間。
   * Publisher と Subscriber の両方が指定した場合、小さい方の値が使用される。
   * タイムアウトを超過したオブジェクトは配信されない。
   */
  deliveryTimeout?: bigint;

  /**
   * Subscriber Priority（0-255）
   * draft-ietf-moq-transport-18 Section 10.2.7 (SUBSCRIBER PRIORITY Parameter)
   *
   * サブスクリプションの優先度。小さい値ほど高優先度。
   * 指定しない場合は 128（デフォルト）
   */
  subscriberPriority?: number;

  /**
   * Group Order
   * draft-ietf-moq-transport-18 Section 10.2.8 (GROUP ORDER Parameter)
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
   * draft-ietf-moq-transport-18 Section 10.2.13 (NEW GROUP REQUEST Parameter)
   *
   * 0 を指定すると、Publisher は新しい Group を開始する
   * Publisher が DYNAMIC_GROUPS をサポートしていない場合は無視される
   */
  newGroupRequest?: bigint;

  /**
   * Joining Fetch オプション
   * draft-ietf-moq-transport-18 Section 10.12.2 (Joining Fetches)
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
   * draft-ietf-moq-transport-18 Section 10.2.12 (FORWARD Parameter)
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
   * draft-ietf-moq-transport-18 Section 10.2.6 (RENDEZVOUS TIMEOUT Parameter)
   *
   * リレーが Publisher を待つ時間。
   * 0 は即時応答を要求。指定しない場合のデフォルトは 0。
   * draft-ietf-moq-transport-18 Section 10.2.6
   */
  rendezvousTimeout?: bigint;
}

/**
 * Fetch callbacks
 */
export interface FetchCallbacks {
  object: (object: MoqtObject) => void;
  end?: () => void;
  error?: (error: Error) => void;
  /**
   * リクエストストリーム上で GOAWAY を受信した時のコールバック
   * draft-ietf-moq-transport-18 Section 10.4 (GOAWAY):
   * 当該リクエストのマイグレーション先 URI を通知する。
   */
  goaway?: (newSessionUri: string) => void;
}

/**
 * Fetch options
 */
export interface FetchOptions {
  /**
   * 開始位置
   */
  startLocation: Location;
  /**
   * 終了位置
   */
  endLocation: Location;
}

/**
 * TRACK_STATUS の結果
 * draft-ietf-moq-transport-18 Section 10.14 (TRACK_STATUS)
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
 * draft-ietf-moq-transport-18 §10.18 (SUBSCRIBE_NAMESPACE):
 * SUBSCRIBE_NAMESPACE への応答として、NAMESPACE / NAMESPACE_DONE が送信される。
 * draft-18 で旧 SUBSCRIBE_NAMESPACE (0x11) が SUBSCRIBE_NAMESPACE (0x50) と
 * SUBSCRIBE_TRACKS (0x51) に分割され、PUBLISH_BLOCKED は SUBSCRIBE_TRACKS 応答に移動した。
 */
export interface NamespaceSubscriptionCallbacks {
  /**
   * NAMESPACE を受信したときに呼ばれる
   * draft-ietf-moq-transport-18 §10.16 (NAMESPACE)
   *
   * @param namespaceSuffix - Track Namespace Prefix を除いた Suffix
   */
  onNamespace?: (namespaceSuffix: string[]) => void;
  /**
   * NAMESPACE_DONE を受信したときに呼ばれる
   * draft-ietf-moq-transport-18 §10.17 (NAMESPACE_DONE)
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
   * draft-ietf-moq-transport-18 §10.4 (GOAWAY):
   * リクエストストリーム上の GOAWAY は当該リクエストの
   * マイグレーションのみを目的とする。
   *
   * @param newSessionUri - 新しいセッション URI
   */
  goaway?: (newSessionUri: string) => void;
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
}

/**
 * Tracks サブスクリプションのコールバック
 *
 * draft-ietf-moq-transport-18 §10.19 (SUBSCRIBE_TRACKS):
 * SUBSCRIBE_TRACKS への応答として PUBLISH メッセージが新規双方向ストリームで
 * 送信される。応答ストリームでは PUBLISH_BLOCKED が送られる。
 */
export interface TracksSubscriptionCallbacks {
  /**
   * PUBLISH_BLOCKED を受信したときに呼ばれる
   * draft-ietf-moq-transport-18 §10.20 (PUBLISH_BLOCKED):
   *
   * > The publisher sends the PUBLISH_BLOCKED control message to indicate
   * > it cannot send a PUBLISH message to initiate a new Subscription for a
   * > Track in the SUBSCRIBE_TRACKS's Track Namespace.
   *
   * @param namespaceSuffix - Track Namespace Prefix を除いた Suffix
   * @param trackName - 確立できなかった Subscription の Track Name
   */
  onPublishBlocked?: (namespaceSuffix: string[], trackName: string) => void;
  /**
   * エラー時のコールバック
   */
  error?: (error: Error) => void;
  /**
   * GOAWAY 受信時に呼ばれる
   * draft-ietf-moq-transport-18 §10.4 (GOAWAY):
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
 * draft-ietf-moq-transport-18 §10.19 (SUBSCRIBE_TRACKS)
 */
export interface TracksSubscription {
  readonly state: "active" | "closed";
  /**
   * サブスクリプションを解除する
   */
  unsubscribe(): Promise<void>;
}

/**
 * Namespace 公開のコールバック
 * draft-ietf-moq-transport-18 Section 10.15 (PUBLISH_NAMESPACE)
 */
export interface NamespacePublicationCallbacks {
  /**
   * エラー時のコールバック
   */
  error?: (error: Error) => void;
  /**
   * GOAWAY 受信時に呼ばれる
   * draft-ietf-moq-transport-18 §10.4 (GOAWAY):
   * リクエストストリーム上の GOAWAY は当該リクエストの
   * マイグレーションのみを目的とする。
   *
   * @param newSessionUri - 新しいセッション URI
   */
  goaway?: (newSessionUri: string) => void;
}

/**
 * Namespace 公開
 * draft-ietf-moq-transport-18 Section 10.15 (PUBLISH_NAMESPACE)
 */
export interface NamespacePublication {
  readonly state: "active" | "closed";
  /**
   * 公開している Namespace
   */
  readonly namespace: string[];
  /**
   * 公開を終了する
   * draft-ietf-moq-transport-18: ストリームの close で終了を通知する。
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
   * draft-ietf-moq-transport-18 Section 10.4 (GOAWAY)
   */
  readonly goawayReceived: boolean;
  /**
   * 接続時に渡された moqt URI の Fragment Identifier
   *
   * draft-ietf-moq-transport-18 §3.1.2:
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
   * draft-ietf-moq-transport-18 Section 10.12 (FETCH)
   */
  fetch(
    namespace: string[],
    trackName: string,
    options: FetchOptions,
    callbacks: FetchCallbacks,
  ): Promise<Fetcher>;
  /**
   * トラックの状態を問い合わせる
   * draft-ietf-moq-transport-18 Section 10.14 (TRACK_STATUS)
   */
  trackStatus(namespace: string[], trackName: string): Promise<TrackStatusResult>;
  /**
   * Namespace をサブスクライブする（namespace discovery 用）
   *
   * draft-ietf-moq-transport-18 §10.18 (SUBSCRIBE_NAMESPACE):
   * SUBSCRIBE_NAMESPACE は新しい双方向ストリームで送信される。
   * 応答として NAMESPACE / NAMESPACE_DONE が送られる。
   *
   * @param namespacePrefix - Track Namespace Prefix
   * @param callbacks - コールバック関数
   */
  subscribeNamespace(
    namespacePrefix: string[],
    callbacks: NamespaceSubscriptionCallbacks,
  ): Promise<NamespaceSubscription>;
  /**
   * Track をサブスクライブする（track subscription 用）
   *
   * draft-ietf-moq-transport-18 §10.19 (SUBSCRIBE_TRACKS):
   * SUBSCRIBE_TRACKS は新しい双方向ストリームで送信される。
   * Publisher はマッチするネームスペース内のトラックに対して PUBLISH メッセージを
   * 別の新規双方向ストリームで送信する。応答ストリーム上では PUBLISH_BLOCKED が
   * 送られる場合がある。
   *
   * @param namespacePrefix - Track Namespace Prefix
   * @param callbacks - コールバック関数
   */
  subscribeTracks(
    namespacePrefix: string[],
    callbacks: TracksSubscriptionCallbacks,
  ): Promise<TracksSubscription>;
  /**
   * Namespace を公開する（トラック発見用）
   * draft-ietf-moq-transport-18 Section 10.15 (PUBLISH_NAMESPACE)
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
   * draft-ietf-moq-transport-18 Section 10.4 (GOAWAY)
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
 * Internal Session implementation
 */
export class SessionImpl implements Session {
  private sessionState: SessionState = "connected";
  private readonly transport: WebTransport;
  private readonly callbacks: ConnectCallbacks;
  // draft-ietf-moq-transport-18 §3.1.2 (Fragment Identifiers)
  private readonly sessionFragment: MoqtFragment | null;
  /**
   * draft-ietf-moq-transport-18 Section 4 (Extensibility):
   * 制御ストリームは単方向ストリームのペアに変更された。
   * クライアントとサーバーがそれぞれ 1 本ずつ単方向ストリームを開く。
   * draft-ietf-moq-transport-18 Section 4
   */
  private controlSendStream?: WritableStream<Uint8Array>;
  private controlReceiveStream?: ReadableStream<Uint8Array>;
  private controlReader?: ControlStreamReader;
  private controlWriter?: ControlStreamWriter;

  // リクエスト ID 管理
  private nextRequestId = 0n;
  private nextTrackAlias = 0n;

  // GOAWAY 状態
  private receivedGoaway = false;
  // リクエストストリームごとの GOAWAY 受信済みフラグ
  // draft-ietf-moq-transport-18 §10.4 (GOAWAY):
  // 単一リクエストストリーム上の重複 GOAWAY は PROTOCOL_VIOLATION
  private goawayReceivedOnRequestStreams = new Set<bigint>();
  private sentGoaway = false;
  private goawayTimeoutId: ReturnType<typeof setTimeout> | null = null;

  // アクティブなパブリッシャー、サブスクライバー、フェッチャー
  private publishers = new Map<bigint, PublisherImpl>();
  private subscribers = new Map<bigint, SubscriberImpl>();
  private subscribersByAlias = new Map<bigint, SubscriberImpl>();
  private fetchers = new Map<bigint, FetcherImpl>();

  // Subscriber 登録前に到着した Subgroup ストリームをバッファリング
  // draft-ietf-moq-transport-18 §11.4.2:
  // "MAY ... choose to buffer it for a brief period to handle reordering with the
  //  control message that establishes the Track Alias."
  // QUIC ではストリーム間の順序が保証されないため、SUBSCRIBE_OK より先にデータストリームが
  // 到着する可能性があり、それを buffer して reordering を吸収する
  // 上限・タイムアウトは ConnectOptions.pendingSubgroup でユーザーから指定可能
  private readonly pendingSubgroupBuffer: PendingSubgroupBuffer;

  // Fetcher 登録待ちの Promise を管理
  // draft-ietf-moq-transport-18 Section 10.13 (FETCH_OK):
  // "A publisher MAY send Objects in response to a FETCH before the
  //  FETCH_OK message is sent."
  // FETCH_OK より先にデータストリームが到着する可能性がある
  private fetcherReadyCallbacks = new Map<bigint, Array<() => void>>();

  // リクエストごとの双方向ストリーム管理
  // draft-ietf-moq-transport-18 Section 3.3:
  // リクエストは双方向ストリーム上で送受信される。
  // draft-ietf-moq-transport-18 Section 3.3
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
      goawayCallback?: (newSessionUri: string) => void;
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
      goawayCallback?: (newSessionUri: string) => void;
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
      goawayCallback?: (newSessionUri: string) => void;
    }
  >();
  private pendingTrackStatus = new Map<
    bigint,
    { resolve: (result: TrackStatusResult) => void; reject: (err: Error) => void }
  >();
  /**
   * SUBSCRIBE_NAMESPACE の状態管理
   *
   * draft-ietf-moq-transport-18 §10.18 (SUBSCRIBE_NAMESPACE):
   * SUBSCRIBE_NAMESPACE は専用の双方向ストリームで送受信される。
   * 応答として NAMESPACE / NAMESPACE_DONE のみが送られる。
   */
  private namespaceSubscriptions = new Map<
    bigint,
    {
      callbacks: NamespaceSubscriptionCallbacks;
      state: "active" | "closed";
      namespacePrefix: string[];
      stream?: WebTransportBidirectionalStream;
      streamReader?: ReadableStreamDefaultReader<Uint8Array>;
      controlReader?: ControlStreamReader;
      writer?: WritableStreamDefaultWriter<Uint8Array>;
    }
  >();
  /**
   * SUBSCRIBE_TRACKS の状態管理
   *
   * draft-ietf-moq-transport-18 §10.19 (SUBSCRIBE_TRACKS):
   * SUBSCRIBE_TRACKS は SUBSCRIBE_NAMESPACE とは別の専用の双方向ストリームで
   * 送受信される。応答ストリーム上では PUBLISH_BLOCKED が送られる。PUBLISH は
   * 別の新規双方向ストリームで到着する。
   */
  private tracksSubscriptions = new Map<
    bigint,
    {
      callbacks: TracksSubscriptionCallbacks;
      state: "active" | "closed";
      namespacePrefix: string[];
      stream?: WebTransportBidirectionalStream;
      streamReader?: ReadableStreamDefaultReader<Uint8Array>;
      controlReader?: ControlStreamReader;
      writer?: WritableStreamDefaultWriter<Uint8Array>;
    }
  >();
  /**
   * PUBLISH_NAMESPACE の状態管理
   *
   * draft-ietf-moq-transport-18 Section 10.15 (PUBLISH_NAMESPACE):
   * PUBLISH_NAMESPACE は新しい双方向ストリームの先頭メッセージとして送信される。
   * REQUEST_OK / REQUEST_ERROR が同じ双方向ストリームで応答される。
   * https://www.ietf.org/archive/id/draft-ietf-moq-transport-18.html#section-10.15
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
  // draft-ietf-moq-transport-18 Section 2.2:
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
  private publisherSendQueues = new Map<bigint, Promise<void>>();

  // STOP_SENDING / delivery timeout で閉じた Subgroup の追跡
  // draft-ietf-moq-transport-18 §11.4.3 (Closing Subgroup Streams):
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
    // draft-ietf-moq-transport-18 Section 3.5:
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

  // draft-ietf-moq-transport-18 §3.1.2 (Fragment Identifiers)
  get fragment(): MoqtFragment | null {
    return this.sessionFragment;
  }

  /**
   * Initialize the session (called after WebTransport connect)
   *
   * options に authorizationToken を指定すると、SETUP Option (0x03) として
   * draft-ietf-moq-transport-18 Section 10.3.1.4 に従い認証トークンを送出する。
   */
  async initialize(options?: { authorizationToken?: AuthorizationToken }): Promise<void> {
    // draft-ietf-moq-transport-18 Section 4 (Extensibility):
    // 制御ストリームは単方向ストリームのペアに変更された。
    // クライアントは送信用単方向ストリームを開き、サーバーの単方向ストリームを受信する。
    // draft-ietf-moq-transport-18 Section 4

    this.controlReader = new ControlStreamReader();
    this.controlWriter = new ControlStreamWriter();

    // 送信用単方向ストリームを開く
    this.controlSendStream = await this.transport.createUnidirectionalStream();

    // draft-ietf-moq-transport-18 Section 3.4:
    // All unidirectional MOQT streams start with a variable-length integer
    // indicating the type of the stream.
    // 制御ストリームのストリームタイプは 0x2F00 (Table 3)
    const streamTypeBytes = encodeVarint(MessageType.SETUP);

    // SETUP を送信
    // draft-ietf-moq-transport-18 §10.3.1.1 / §10.3.1.2:
    // AUTHORITY (0x05) / PATH (0x01) は WebTransport 使用時には MUST NOT 送信。
    // moqt-js は WebTransport 専用クライアントのため `createSetup` には渡さない。
    const setup = createSetup({
      authorizationToken: options?.authorizationToken,
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

    // draft-ietf-moq-transport-18 Section 3.4:
    // 単方向ストリームの先頭にストリームタイプ varint が含まれる。
    // 制御ストリームのストリームタイプ 0x2F00 を読み取って検証する。
    const reader = incomingStream.getReader();
    const { value, done } = await reader.read();
    reader.releaseLock();

    if (done || !value) {
      throw new SessionError("Connection closed before SETUP", SessionErrorCode.NO_ERROR);
    }

    // ストリームタイプを読み取る
    const [streamType, streamTypeConsumed] = decodeVarint(value, 0);
    if (Number(streamType) !== MessageType.SETUP) {
      throw new SessionError(
        `expected control stream type 0x2F00, got 0x${streamType.toString(16)}`,
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }

    // ストリームタイプ以降のデータを ControlStreamReader に供給
    const remaining = value.slice(streamTypeConsumed);
    let messages = remaining.length > 0 ? this.controlReader.feed(remaining) : [];

    // SETUP メッセージがまだ届いていない場合は追加で読み取る
    if (messages.length === 0) {
      const setupReader = incomingStream.getReader();
      const { value: setupValue, done: setupDone } = await setupReader.read();
      setupReader.releaseLock();

      if (setupDone || !setupValue) {
        throw new SessionError("Connection closed before SETUP", SessionErrorCode.NO_ERROR);
      }
      messages = this.controlReader.feed(setupValue);
    }

    if (messages.length === 0) {
      throw new SessionError("No SETUP received", SessionErrorCode.PROTOCOL_VIOLATION);
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

    // draft-ietf-moq-transport-18 §10.3.1.1 / §10.3.1.2:
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

    this.emitDebug("recv", MessageType.SETUP, msg.payload, {});

    // バックグラウンドで制御メッセージの読み取りを開始
    this.startControlMessageLoop();

    // 受信データストリームの受け入れを開始
    this.startIncomingStreamLoop();

    // データグラムの受信を開始
    this.startDatagramLoop();
  }

  /**
   * Publish a track
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
    // draft-ietf-moq-transport-18 Section 10.4 (GOAWAY)
    if (this.receivedGoaway) {
      throw new Error("Cannot publish after receiving GOAWAY");
    }

    const requestId = this.nextRequestId;
    this.nextRequestId += 2n; // Client uses even IDs

    const trackAlias = this.nextTrackAlias++;

    const trackNamespace = createTrackNamespace(namespace);
    const trackNameBytes = encodeTrackName(trackName);

    // パブリッシャー実装を作成
    const impl = new PublisherImpl(
      namespace,
      trackName,
      requestId,
      trackAlias,
      callbacks?.error,
      callbacks?.onForwardStateChange,
    );

    // 送信コールバックを設定
    impl.onSendObject = (params: SendObjectParams) => this.sendObject(impl, params);

    // データグラム送信コールバックを設定
    impl.onSendDatagram = (params: SendDatagramParams) => {
      this.sendDatagram(impl, params);
    };

    impl.onDoneInternal = async () => {
      // まずストリームを閉じる（FIN を送信）
      await this.closePublisherStream(impl.getTrackAlias());
      // その後 PUBLISH_DONE を送信
      await this.sendPublishDone(impl);
    };

    // PUBLISH_OK の Promise を作成
    const promise = new Promise<Publisher>((resolve, reject) => {
      this.pendingPublish.set(requestId, {
        resolve,
        reject,
        impl,
        goawayCallback: callbacks?.goaway,
      });
    });

    const parameters = buildPublishParameters(options);
    const trackProperties = buildPublishTrackProperties(options);

    // PUBLISH メッセージを双方向ストリームで送信
    // draft-ietf-moq-transport-18 Section 10.10 (PUBLISH):
    // "The publisher sends PUBLISH as the first message on a new
    //  bidirectional stream to initiate a subscription for a Track."
    // draft-ietf-moq-transport-18 Section 3.3
    const publishMsg = {
      type: MessageType.PUBLISH,
      requestId,
      trackNamespace,
      trackName: trackNameBytes,
      trackAlias,
      parameters,
      trackProperties,
    };

    const payload = encodePublishPayload(publishMsg as Parameters<typeof encodePublishPayload>[0]);
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
   * Subscribe to a track
   *
   * draft-ietf-moq-transport-18 Section 10.8 (SUBSCRIBE_OK):
   * SUBSCRIBE does not include Track Alias.
   * Track Alias is returned by the publisher in SUBSCRIBE_OK (Section 10.8 SUBSCRIBE_OK).
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
    // draft-ietf-moq-transport-18 Section 10.4 (GOAWAY)
    if (this.receivedGoaway) {
      throw new Error("Cannot subscribe after receiving GOAWAY");
    }

    // Joining Fetch は Forward State 1 の場合のみ許可
    // draft-ietf-moq-transport-18 Section 10.12.2 (Joining Fetches):
    // "A Joining Fetch is only permitted when the associated subscription
    //  has Forward State 1; otherwise the publisher MUST respond with a
    //  REQUEST_ERROR with error code INVALID_RANGE."
    // joiningFetch が有効な場合、自動的に LargestObject フィルターを設定する
    if (options?.joiningFetch) {
      // draft-ietf-moq-transport-18 Section 10.12.2 (Joining Fetches):
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
    this.nextRequestId += 2n; // Client uses even IDs

    const trackNamespace = createTrackNamespace(namespace);
    const trackNameBytes = encodeTrackName(trackName);

    // サブスクライバー実装を作成
    // 注意: trackAlias は SUBSCRIBE_OK 受信時に設定される
    const impl = new SubscriberImpl(
      namespace,
      trackName,
      requestId,
      0n, // Placeholder, will be updated from SUBSCRIBE_OK
      callbacks.object,
      callbacks.datagram,
      callbacks.end,
      callbacks.error,
    );

    // サブスクリプションキャンセルのコールバック
    impl.onUnsubscribe = async () => {
      await this.cancelSubscription(impl);
    };

    // 更新コールバックを設定
    impl.onUpdate = async (updateOptions: RequestUpdateOptions) => {
      await this.sendRequestUpdate(impl, updateOptions);
    };

    // SUBSCRIBE_OK の Promise を作成
    const promise = new Promise<Subscriber>((resolve, reject) => {
      this.pendingSubscribe.set(requestId, {
        resolve,
        reject,
        impl,
        joiningFetch: options?.joiningFetch,
        objectCallback: callbacks.object,
        goawayCallback: callbacks.goaway,
      });
    });

    const parameters = buildSubscribeParameters(options);

    // SUBSCRIBE メッセージを双方向ストリームで送信
    // draft-ietf-moq-transport-18 Section 10.7 (SUBSCRIBE):
    // SUBSCRIBE は新しい双方向ストリームで送信される。
    // draft-ietf-moq-transport-18 Section 3.3
    const subscribeMsg = {
      type: MessageType.SUBSCRIBE,
      requestId,
      trackNamespace,
      trackName: trackNameBytes,
      parameters,
    };

    const payload = encodeSubscribePayload(
      subscribeMsg as Parameters<typeof encodeSubscribePayload>[0],
    );
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
   * draft-ietf-moq-transport-18 Section 10.12 (FETCH):
   * FETCH requests a range of Objects from a track.
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

    // Fetcher 実装を作成
    const impl = new FetcherImpl(
      namespace,
      trackName,
      requestId,
      callbacks.object,
      callbacks.end,
      callbacks.error,
    );

    // draft-ietf-moq-transport-18 Section 5.2:
    // キャンセルはストリームを閉じることで行う。
    impl.onCancel = async () => {
      await this.cancelFetch(impl);
    };

    // FETCH_OK を待つ Promise
    const promise = new Promise<Fetcher>((resolve, reject) => {
      this.pendingFetch.set(requestId, {
        resolve,
        reject,
        impl,
        startLocation: options.startLocation,
        goawayCallback: callbacks.goaway,
      });
    });

    // FETCH メッセージを双方向ストリームで送信（Standalone Fetch）
    // draft-ietf-moq-transport-18 Section 10.12 (FETCH):
    // FETCH は新しい双方向ストリームで送信される。
    // draft-ietf-moq-transport-18 Section 3.3
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
      parameters: [],
    };

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
   * draft-ietf-moq-transport-18 Section 10.14 (TRACK_STATUS):
   * TRACK_STATUS requests information about a track without subscribing.
   * The response is REQUEST_OK with the same parameters as SUBSCRIBE_OK.
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

    // REQUEST_OK を待つ Promise
    const promise = new Promise<TrackStatusResult>((resolve, reject) => {
      this.pendingTrackStatus.set(requestId, { resolve, reject });
    });

    // TRACK_STATUS メッセージを双方向ストリームで送信
    // draft-ietf-moq-transport-18 Section 10.14 (TRACK_STATUS):
    // TRACK_STATUS は新しい双方向ストリームで送信される。
    // draft-ietf-moq-transport-18 Section 3.3
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
   * draft-ietf-moq-transport-18 §10.18 (SUBSCRIBE_NAMESPACE):
   * SUBSCRIBE_NAMESPACE (0x50) は新しい双方向ストリームで送信される。
   * REQUEST_OK または REQUEST_ERROR が最初のレスポンスとして返され、
   * 以降は NAMESPACE / NAMESPACE_DONE のみが応答ストリーム上で送られる。
   *
   * draft-18 で旧 SUBSCRIBE_NAMESPACE (0x11) が 0x50 と SUBSCRIBE_TRACKS (0x51)
   * に分割され、Subscribe Options フィールドは廃止された。
   *
   * draft-ietf-moq-transport-18 §6.1:
   * キャンセルはストリームを FIN または RESET_STREAM で閉じることで行う。
   */
  async subscribeNamespace(
    namespacePrefix: string[],
    callbacks: NamespaceSubscriptionCallbacks,
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

    // 専用の双方向ストリームを作成
    const stream = await this.transport.createBidirectionalStream();
    const streamReader = stream.readable.getReader();
    const controlReader = new ControlStreamReader();
    const writer = stream.writable.getWriter();

    // SUBSCRIBE_NAMESPACE メッセージを構築
    const subscribeNamespaceMsg = {
      type: MessageType.SUBSCRIBE_NAMESPACE,
      requestId,
      trackNamespacePrefix,
      parameters: [] as [],
    };

    // メッセージをエンコードして送信
    // draft-ietf-moq-transport-18 §10.18 (SUBSCRIBE_NAMESPACE):
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
   * draft-ietf-moq-transport-18 §10.19 (SUBSCRIBE_TRACKS):
   * SUBSCRIBE_TRACKS (0x51) は新しい双方向ストリームで送信される。
   * REQUEST_OK または REQUEST_ERROR が最初のレスポンスとして返され、
   * 以降は PUBLISH_BLOCKED のみが応答ストリーム上で送られる。
   * PUBLISH メッセージは別の新規双方向ストリームで非同期に到着する。
   *
   * draft-ietf-moq-transport-18 §6.1:
   * キャンセルはストリームを FIN または RESET_STREAM で閉じることで行う。
   */
  async subscribeTracks(
    namespacePrefix: string[],
    callbacks: TracksSubscriptionCallbacks,
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

    // 専用の双方向ストリームを作成
    const stream = await this.transport.createBidirectionalStream();
    const streamReader = stream.readable.getReader();
    const controlReader = new ControlStreamReader();
    const writer = stream.writable.getWriter();

    // SUBSCRIBE_TRACKS メッセージを構築
    const subscribeTracksMsg = {
      type: MessageType.SUBSCRIBE_TRACKS,
      requestId,
      trackNamespacePrefix,
      parameters: [] as [],
    };

    // メッセージをエンコードして送信
    // draft-ietf-moq-transport-18 §10.19 (SUBSCRIBE_TRACKS):
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
   * draft-ietf-moq-transport-18 §10.18 (SUBSCRIBE_NAMESPACE):
   * REQUEST_OK / REQUEST_ERROR、NAMESPACE、NAMESPACE_DONE のみを処理する。
   * PUBLISH_BLOCKED は SUBSCRIBE_TRACKS 応答ストリーム側 (startTracksStreamLoop) で扱う。
   */
  private async startNamespaceStreamLoop(
    requestId: bigint,
    resolve: (subscription: NamespaceSubscription) => void,
    reject: (err: Error) => void,
  ): Promise<void> {
    const subscription = this.namespaceSubscriptions.get(requestId);
    if (!subscription || !subscription.streamReader || !subscription.controlReader) {
      reject(new Error("namespace subscription not found"));
      return;
    }

    const { streamReader, controlReader, callbacks } = subscription;
    let resolved = false;
    // NAMESPACE 受信済 suffix を追跡し、NAMESPACE_DONE が先行で来たら PROTOCOL_VIOLATION で閉じる
    // draft-ietf-moq-transport-18 §10.18
    const seenNamespaceSuffixes = new Set<string>();
    const namespaceSuffixKey = (suffix: string[]): string => JSON.stringify(suffix);

    try {
      while (subscription.state === "active") {
        const { value, done } = await streamReader.read();
        if (done) {
          // ストリームが閉じられた
          break;
        }

        const messages = controlReader.feed(value);
        for (const msg of messages) {
          const messageType = msg.type;
          const messagePayload = msg.payload;

          // デバッグコールバック
          this.callbacks.debug?.({
            direction: "recv",
            type: messageType,
            typeName: getMessageTypeName(messageType),
            payload: messagePayload,
            timestamp: Date.now(),
          });

          // draft-ietf-moq-transport-18 §10.18:
          // "If the subscriber receives any message other than a REQUEST_OK or a
          //  REQUEST_ERROR as the first message on the response half of the stream,
          //  then it MUST close the session with a PROTOCOL_VIOLATION."
          if (
            !resolved &&
            messageType !== MessageType.REQUEST_OK &&
            messageType !== MessageType.REQUEST_ERROR
          ) {
            this.closeWithError(
              new SessionError(
                `expected REQUEST_OK or REQUEST_ERROR as first message on namespace stream, got 0x${messageType.toString(16)}`,
                SessionErrorCode.PROTOCOL_VIOLATION,
              ),
            );
            return;
          }

          switch (messageType) {
            case MessageType.REQUEST_OK: {
              if (resolved) {
                this.closeWithError(
                  new SessionError(
                    "received second REQUEST_OK on namespace stream",
                    SessionErrorCode.PROTOCOL_VIOLATION,
                  ),
                );
                return;
              }
              // draft-ietf-moq-transport-18 §10.5 (REQUEST_OK):
              // Request ID はストリームが特定するため不要 (§10.1 Request ID)
              const requestOk = decodeRequestOkPayload(messagePayload);
              // draft-ietf-moq-transport-18 §10.5 (REQUEST_OK)
              if (
                !bidi.validateRequestOkNoTrackProperties(
                  requestOk.trackProperties,
                  "SUBSCRIBE_NAMESPACE_OK",
                  (error) => this.closeWithError(error),
                )
              ) {
                return;
              }
              resolved = true;
              const namespaceSubscription = this.createNamespaceSubscription(requestId);
              resolve(namespaceSubscription);
              break;
            }

            case MessageType.REQUEST_ERROR: {
              if (resolved) {
                this.closeWithError(
                  new SessionError(
                    "received REQUEST_ERROR after REQUEST_OK on namespace stream",
                    SessionErrorCode.PROTOCOL_VIOLATION,
                  ),
                );
                return;
              }
              // draft-ietf-moq-transport-18 §10.6 (REQUEST_ERROR)
              const decodedMsg = decodeRequestErrorPayload(messagePayload);
              const error = new RequestError(
                decodedMsg.reasonPhrase,
                normalizeRequestErrorCode(Number(decodedMsg.errorCode)),
                decodedMsg.retryInterval,
                decodedMsg.redirect
                  ? {
                      connectUri: decodedMsg.redirect.connectUri,
                      trackNamespace: decodedMsg.redirect.trackNamespace.tuple,
                      trackName: decodedMsg.redirect.trackName,
                    }
                  : undefined,
              );
              subscription.state = "closed";
              callbacks.error?.(error);
              reject(error);
              return;
            }

            case MessageType.GOAWAY: {
              // draft-ietf-moq-transport-18 §10.4:
              // リクエストストリーム上の GOAWAY は当該リクエストのみに適用される
              // 同一リクエストストリーム上の重複 GOAWAY は PROTOCOL_VIOLATION
              if (this.goawayReceivedOnRequestStreams.has(requestId)) {
                this.closeWithError(
                  new SessionError(
                    "received duplicate goaway on request stream",
                    SessionErrorCode.PROTOCOL_VIOLATION,
                  ),
                );
                return;
              }
              this.goawayReceivedOnRequestStreams.add(requestId);
              const decodedMsg = decodeGoawayPayload(messagePayload);
              if (decodedMsg.requestId !== null) {
                this.closeWithError(
                  new SessionError(
                    "goaway on request stream must not include request id",
                    SessionErrorCode.PROTOCOL_VIOLATION,
                  ),
                );
                return;
              }
              callbacks.goaway?.(decodedMsg.newSessionUri);
              subscription.state = "closed";
              callbacks.error?.(
                new Error(
                  `request stream goaway: ${decodedMsg.newSessionUri || "no redirect URI"}`,
                ),
              );
              reject(
                new Error(
                  `request stream goaway: ${decodedMsg.newSessionUri || "no redirect URI"}`,
                ),
              );
              return;
            }

            case MessageType.NAMESPACE: {
              const decodedMsg = decodeNamespacePayload(messagePayload);
              const suffixStrings = trackNamespaceToStrings(decodedMsg.trackNamespaceSuffix);
              seenNamespaceSuffixes.add(namespaceSuffixKey(suffixStrings));
              callbacks.onNamespace?.(suffixStrings);
              break;
            }

            case MessageType.NAMESPACE_DONE: {
              const decodedMsg = decodeNamespaceDonePayload(messagePayload);
              const suffixStrings = trackNamespaceToStrings(decodedMsg.trackNamespaceSuffix);
              // draft-ietf-moq-transport-18 §10.18:
              // "The publisher MUST NOT send NAMESPACE_DONE for a namespace suffix before
              //  the corresponding NAMESPACE. If a subscriber receives a NAMESPACE_DONE
              //  before the corresponding NAMESPACE, it MUST close the session with a
              //  'PROTOCOL_VIOLATION'."
              if (!seenNamespaceSuffixes.has(namespaceSuffixKey(suffixStrings))) {
                this.closeWithError(
                  new SessionError(
                    `received NAMESPACE_DONE before corresponding NAMESPACE: suffix=${JSON.stringify(suffixStrings)}`,
                    SessionErrorCode.PROTOCOL_VIOLATION,
                  ),
                );
                return;
              }
              callbacks.onNamespaceDone?.(suffixStrings);
              break;
            }

            default:
              // draft-ietf-moq-transport-18 §10 (Control Messages):
              // "An endpoint that receives an unknown message type MUST close the session."
              // PUBLISH_BLOCKED は SUBSCRIBE_TRACKS 応答ストリーム側で処理するので
              // SUBSCRIBE_NAMESPACE 応答ストリームでは PROTOCOL_VIOLATION 扱い。
              this.closeWithError(
                new SessionError(
                  `unknown namespace stream message type: 0x${messageType.toString(16)}`,
                  SessionErrorCode.PROTOCOL_VIOLATION,
                ),
              );
              return;
          }
        }
      }
    } catch (error) {
      if (subscription.state === "active") {
        subscription.state = "closed";
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        // draft-ietf-moq-transport-18 §3.5:
        // WebTransport セッション終了起源の read 中断は subscription の error には
        // 流さない (session-level の close で通知される)。
        // ただし subscribe Promise が未解決ならユーザーが await しているので reject する必要がある。
        if (!isSessionClosedError(normalizedError)) {
          callbacks.error?.(normalizedError);
        }
        if (!resolved) {
          reject(normalizedError);
        }
      }
    } finally {
      // クリーンアップ
      subscription.state = "closed";
      streamReader.releaseLock();
      this.namespaceSubscriptions.delete(requestId);
    }
  }

  /**
   * SUBSCRIBE_TRACKS 専用ストリームの受信ループ
   *
   * draft-ietf-moq-transport-18 §10.19 (SUBSCRIBE_TRACKS):
   * REQUEST_OK / REQUEST_ERROR、PUBLISH_BLOCKED のみを処理する。
   * PUBLISH メッセージは別の新規双方向ストリームで到着するためここでは扱わない。
   */
  private async startTracksStreamLoop(
    requestId: bigint,
    resolve: (subscription: TracksSubscription) => void,
    reject: (err: Error) => void,
  ): Promise<void> {
    const subscription = this.tracksSubscriptions.get(requestId);
    if (!subscription || !subscription.streamReader || !subscription.controlReader) {
      reject(new Error("tracks subscription not found"));
      return;
    }

    const { streamReader, controlReader, callbacks } = subscription;
    let resolved = false;

    try {
      while (subscription.state === "active") {
        const { value, done } = await streamReader.read();
        if (done) {
          break;
        }

        const messages = controlReader.feed(value);
        for (const msg of messages) {
          const messageType = msg.type;
          const messagePayload = msg.payload;

          this.callbacks.debug?.({
            direction: "recv",
            type: messageType,
            typeName: getMessageTypeName(messageType),
            payload: messagePayload,
            timestamp: Date.now(),
          });

          // draft-ietf-moq-transport-18 §10.19:
          // "If the subscriber receives any message other than a REQUEST_OK or a
          //  REQUEST_ERROR as the first message on the response half of the stream,
          //  then it MUST close the session with a PROTOCOL_VIOLATION."
          if (
            !resolved &&
            messageType !== MessageType.REQUEST_OK &&
            messageType !== MessageType.REQUEST_ERROR
          ) {
            this.closeWithError(
              new SessionError(
                `expected REQUEST_OK or REQUEST_ERROR as first message on tracks stream, got 0x${messageType.toString(16)}`,
                SessionErrorCode.PROTOCOL_VIOLATION,
              ),
            );
            return;
          }

          switch (messageType) {
            case MessageType.REQUEST_OK: {
              if (resolved) {
                this.closeWithError(
                  new SessionError(
                    "received second REQUEST_OK on tracks stream",
                    SessionErrorCode.PROTOCOL_VIOLATION,
                  ),
                );
                return;
              }
              resolved = true;
              const tracksSubscription = this.createTracksSubscription(requestId);
              resolve(tracksSubscription);
              break;
            }

            case MessageType.REQUEST_ERROR: {
              if (resolved) {
                this.closeWithError(
                  new SessionError(
                    "received REQUEST_ERROR after REQUEST_OK on tracks stream",
                    SessionErrorCode.PROTOCOL_VIOLATION,
                  ),
                );
                return;
              }
              const decodedMsg = decodeRequestErrorPayload(messagePayload);
              const error = new RequestError(
                decodedMsg.reasonPhrase,
                normalizeRequestErrorCode(Number(decodedMsg.errorCode)),
                decodedMsg.retryInterval,
                decodedMsg.redirect
                  ? {
                      connectUri: decodedMsg.redirect.connectUri,
                      trackNamespace: decodedMsg.redirect.trackNamespace.tuple,
                      trackName: decodedMsg.redirect.trackName,
                    }
                  : undefined,
              );
              subscription.state = "closed";
              callbacks.error?.(error);
              reject(error);
              return;
            }

            case MessageType.GOAWAY: {
              if (this.goawayReceivedOnRequestStreams.has(requestId)) {
                this.closeWithError(
                  new SessionError(
                    "received duplicate goaway on request stream",
                    SessionErrorCode.PROTOCOL_VIOLATION,
                  ),
                );
                return;
              }
              this.goawayReceivedOnRequestStreams.add(requestId);
              const decodedMsg = decodeGoawayPayload(messagePayload);
              if (decodedMsg.requestId !== null) {
                this.closeWithError(
                  new SessionError(
                    "goaway on request stream must not include request id",
                    SessionErrorCode.PROTOCOL_VIOLATION,
                  ),
                );
                return;
              }
              callbacks.goaway?.(decodedMsg.newSessionUri);
              subscription.state = "closed";
              callbacks.error?.(
                new Error(
                  `request stream goaway: ${decodedMsg.newSessionUri || "no redirect URI"}`,
                ),
              );
              reject(
                new Error(
                  `request stream goaway: ${decodedMsg.newSessionUri || "no redirect URI"}`,
                ),
              );
              return;
            }

            case MessageType.PUBLISH_BLOCKED: {
              // draft-ietf-moq-transport-18 §10.20 (PUBLISH_BLOCKED):
              // SUBSCRIBE_TRACKS への応答ストリーム上で送られる。
              const decodedMsg = decodePublishBlockedPayload(messagePayload);
              const suffixStrings = trackNamespaceToStrings(decodedMsg.trackNamespaceSuffix);
              const trackName = new TextDecoder().decode(decodedMsg.trackName);
              callbacks.onPublishBlocked?.(suffixStrings, trackName);
              break;
            }

            default:
              this.closeWithError(
                new SessionError(
                  `unknown tracks stream message type: 0x${messageType.toString(16)}`,
                  SessionErrorCode.PROTOCOL_VIOLATION,
                ),
              );
              return;
          }
        }
      }
    } catch (error) {
      if (subscription.state === "active") {
        subscription.state = "closed";
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        if (!isSessionClosedError(normalizedError)) {
          callbacks.error?.(normalizedError);
        }
        if (!resolved) {
          reject(normalizedError);
        }
      }
    } finally {
      subscription.state = "closed";
      streamReader.releaseLock();
      this.tracksSubscriptions.delete(requestId);
    }
  }

  /**
   * Namespace を公開する（トラック発見用）
   *
   * draft-ietf-moq-transport-18 Section 10.15 (PUBLISH_NAMESPACE):
   * PUBLISH_NAMESPACE は新しい双方向ストリームの先頭メッセージとして送信される。
   * REQUEST_OK / REQUEST_ERROR が同じ双方向ストリームで応答される。
   * https://www.ietf.org/archive/id/draft-ietf-moq-transport-18.html#section-10.15
   *
   * draft-ietf-moq-transport-18 Section 6.1:
   * 公開のキャンセルはストリームを FIN または RESET_STREAM で閉じることで行う。
   * https://www.ietf.org/archive/id/draft-ietf-moq-transport-18.html#section-6.1
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
    // draft-ietf-moq-transport-18 Section 10.15 (PUBLISH_NAMESPACE):
    // Type (vi64) + Length (16-bit big-endian) + Payload のフレーミングを
    // ControlStreamWriter に委譲する。
    // https://www.ietf.org/archive/id/draft-ietf-moq-transport-18.html#section-10.15
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
   * draft-ietf-moq-transport-18 Section 10.15 (PUBLISH_NAMESPACE):
   * 応答は REQUEST_OK / REQUEST_ERROR のみが想定される。
   * それ以外のメッセージを受信した場合は PROTOCOL_VIOLATION でセッションを閉じる。
   */
  private async startNamespacePublicationStreamLoop(
    requestId: bigint,
    resolve: (publication: NamespacePublication) => void,
    reject: (err: Error) => void,
  ): Promise<void> {
    const publication = this.namespacePublications.get(requestId);
    if (!publication) {
      reject(new Error("namespace publication not found"));
      return;
    }

    const { streamReader, controlReader, callbacks } = publication;
    let resolved = false;

    try {
      while (publication.state !== "closed") {
        const { value, done } = await streamReader.read();
        if (done) {
          // ストリームが peer により閉じられた
          break;
        }

        const messages = controlReader.feed(value);
        for (const msg of messages) {
          const messageType = msg.type;
          const messagePayload = msg.payload;

          // デバッグコールバック
          this.callbacks.debug?.({
            direction: "recv",
            type: messageType,
            typeName: getMessageTypeName(messageType),
            payload: messagePayload,
            timestamp: Date.now(),
          });

          switch (messageType) {
            case MessageType.REQUEST_OK: {
              // draft-ietf-moq-transport-18 Section 10.5 (REQUEST_OK):
              // Request ID はストリームが特定するため不要
              // draft-ietf-moq-transport-18 Section 10.1
              const requestOk = decodeRequestOkPayload(messagePayload);
              // draft-ietf-moq-transport-18 §10.5 (REQUEST_OK)
              if (
                !bidi.validateRequestOkNoTrackProperties(
                  requestOk.trackProperties,
                  "PUBLISH_NAMESPACE_OK",
                  (error) => this.closeWithError(error),
                )
              ) {
                return;
              }
              if (resolved) {
                // 二重応答は仕様違反
                this.closeWithError(
                  new SessionError(
                    "received duplicate REQUEST_OK on PUBLISH_NAMESPACE stream",
                    SessionErrorCode.PROTOCOL_VIOLATION,
                  ),
                );
                return;
              }
              publication.state = "active";
              resolved = true;
              resolve(this.createNamespacePublication(requestId));
              break;
            }

            case MessageType.REQUEST_ERROR: {
              // draft-ietf-moq-transport-18 Section 10.6.2 (REQUEST_ERROR):
              // Request ID はストリームが特定するため不要
              const decodedMsg = decodeRequestErrorPayload(messagePayload);
              const error = new RequestError(
                decodedMsg.reasonPhrase || `Request failed with code ${decodedMsg.errorCode}`,
                normalizeRequestErrorCode(Number(decodedMsg.errorCode)),
                decodedMsg.retryInterval,
                decodedMsg.redirect
                  ? {
                      connectUri: decodedMsg.redirect.connectUri,
                      trackNamespace: decodedMsg.redirect.trackNamespace.tuple,
                      trackName: decodedMsg.redirect.trackName,
                    }
                  : undefined,
              );
              publication.state = "closed";
              callbacks?.error?.(error);
              if (!resolved) {
                reject(error);
              }
              return;
            }

            case MessageType.GOAWAY: {
              if (this.goawayReceivedOnRequestStreams.has(requestId)) {
                this.closeWithError(
                  new SessionError(
                    "received duplicate goaway on request stream",
                    SessionErrorCode.PROTOCOL_VIOLATION,
                  ),
                );
                return;
              }
              this.goawayReceivedOnRequestStreams.add(requestId);
              const decodedMsg = decodeGoawayPayload(messagePayload);
              if (decodedMsg.requestId !== null) {
                this.closeWithError(
                  new SessionError(
                    "goaway on request stream must not include request id",
                    SessionErrorCode.PROTOCOL_VIOLATION,
                  ),
                );
                return;
              }
              callbacks?.goaway?.(decodedMsg.newSessionUri);
              publication.state = "closed";
              callbacks?.error?.(
                new Error(
                  `request stream goaway: ${decodedMsg.newSessionUri || "no redirect URI"}`,
                ),
              );
              if (!resolved) {
                reject(
                  new Error(
                    `request stream goaway: ${decodedMsg.newSessionUri || "no redirect URI"}`,
                  ),
                );
              }
              return;
            }

            default:
              // draft-ietf-moq-transport-18 Section 10 (Control Messages):
              // "An endpoint that receives an unknown message type MUST close the session."
              this.closeWithError(
                new SessionError(
                  `unknown publish namespace stream message type: 0x${messageType.toString(16)}`,
                  SessionErrorCode.PROTOCOL_VIOLATION,
                ),
              );
              return;
          }
        }
      }
    } catch (error) {
      if (publication.state !== "closed") {
        publication.state = "closed";
        const wrapped = error instanceof Error ? error : new Error(String(error));
        callbacks?.error?.(wrapped);
        if (!resolved) {
          reject(wrapped);
        }
      }
    } finally {
      // クリーンアップ
      publication.state = "closed";
      try {
        streamReader.releaseLock();
      } catch {
        // 既に解放済みの場合は無視
      }
      this.namespacePublications.delete(requestId);
    }
  }

  /**
   * GOAWAY を送信してセッション終了を通知する
   *
   * draft-ietf-moq-transport-18 Section 10.4 (GOAWAY):
   * An endpoint sends a GOAWAY message to inform the peer it intends to
   * close the session soon.
   */
  async goaway(newSessionUri?: string, timeout?: bigint): Promise<void> {
    if (this.sessionState === "closed") {
      throw new Error("Session is closed");
    }

    // 複数回の GOAWAY 送信は許可しない
    if (this.sentGoaway) {
      throw new Error("GOAWAY already sent");
    }

    // draft-ietf-moq-transport-18 Section 10.4 (GOAWAY):
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
      requestId: 1n, // draft-ietf-moq-transport-18 §10.4: クライアントの GOAWAY Request ID はピア（サーバー）の最小 Request ID (奇数パリティ、1 から開始)
    });

    await this.sendControlMessage(MessageType.GOAWAY, payload, {
      newSessionUri: newSessionUri ?? "",
      timeout: goawayTimeout.toString(),
    });

    // draft-ietf-moq-transport-18 Section 3.6:
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
      }, Number(goawayTimeout));
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
   * Close the session
   *
   * draft-ietf-moq-transport-18 Section 3.5:
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
        void closeWriterSafely(subscription.writer);
      }
      if (subscription.streamReader) {
        void cancelReaderSafely(subscription.streamReader);
      }
    }
    this.namespaceSubscriptions.clear();

    // SUBSCRIBE_TRACKS 用の双方向ストリーム
    // draft-ietf-moq-transport-18 §10.19 (SUBSCRIBE_TRACKS)
    for (const subscription of this.tracksSubscriptions.values()) {
      subscription.state = "closed";
      if (subscription.writer) {
        void closeWriterSafely(subscription.writer);
      }
      if (subscription.streamReader) {
        void cancelReaderSafely(subscription.streamReader);
      }
    }
    this.tracksSubscriptions.clear();

    // PUBLISH_NAMESPACE 用の双方向ストリーム
    for (const publication of this.namespacePublications.values()) {
      publication.state = "closed";
      void closeWriterSafely(publication.writer);
      void cancelReaderSafely(publication.streamReader);
    }
    this.namespacePublications.clear();

    // SUBSCRIBE / PUBLISH / FETCH 等のリクエスト用双方向ストリーム
    for (const entry of this.requestStreams.values()) {
      void closeWriterSafely(entry.writer);
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
   * draft-ietf-moq-transport-18 Section 3.5:
   * プロトコル違反等のエラーが発生した場合、セッションを閉じる必要がある。
   */
  private closeWithError(error: SessionError): void {
    this.callbacks.error?.(error);
    void this.close(error.code, error.message);
  }

  /**
   * read loop で発生したエラーを必要なときだけ callbacks.error に通知する
   *
   * draft-ietf-moq-transport-18 Section 3.5:
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
   * draft-ietf-moq-transport-18 Section 3.3:
   * リクエスト (SUBSCRIBE, PUBLISH, FETCH, TRACK_STATUS 等) は
   * 双方向ストリーム上で送受信される。
   * draft-ietf-moq-transport-18 Section 3.3
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
   * Send an object on a subgroup stream
   * draft-ietf-moq-transport-18 Section 2.2:
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
    const trackAlias = publisher.getTrackAlias();
    const groupId = BigInt(params.groupId);
    const previousPromise = this.publisherSendQueues.get(trackAlias) ?? Promise.resolve();
    // 前の Promise のエラーをキャッチしてチェーンが止まらないようにする。
    // エラーが伝播すると後続の全ての .then() がスキップされ、
    // 新しいオブジェクトが送信されなくなる。
    const currentPromise = previousPromise
      .catch(() => {})
      .then(() => {
        // 閉じた Subgroup への送信を拒否する
        // draft-ietf-moq-transport-18 §11.4.3:
        // "A publisher that receives a STOP_SENDING on a Subgroup stream SHOULD NOT
        //  attempt to open a new stream to deliver additional Objects in that Subgroup."
        if (this.closedSubgroups.has(`${trackAlias}:${groupId}`)) {
          throw new ClosedSubgroupError(
            `subgroup is closed: trackAlias=${trackAlias} groupId=${groupId}`,
            trackAlias,
            groupId,
          );
        }
      })
      .then(() => this.sendObjectInternal(publisher, params))
      .catch((err: unknown) => {
        publisher.handleError(err instanceof Error ? err : new Error(String(err)));
      });
    this.publisherSendQueues.set(trackAlias, currentPromise);
    return currentPromise;
  }

  private async sendObjectInternal(
    publisher: PublisherImpl,
    params: SendObjectParams,
  ): Promise<void> {
    const trackAlias = publisher.getTrackAlias();
    const groupId = BigInt(params.groupId);
    const objectId = BigInt(params.objectId);

    let streamState = this.publisherStreams.get(trackAlias);

    // 新しい Group または最初のオブジェクト → 新しいストリームを開く
    if (!streamState || streamState.groupId !== groupId) {
      // 前のストリームを FIN で閉じる
      // 先に Map から削除して、他の sendObject が同じストリームを閉じようとするのを防ぐ
      if (streamState) {
        this.publisherStreams.delete(trackAlias);
        try {
          await streamState.writer.close();
        } catch {
          // 既に閉じられている場合は無視
          // writer.close() の失敗は STOP_SENDING とみなさない
          // publisher が自発的に閉じるストリームの close 失敗は追跡不要
        }
      }

      // 新しいストリームを開く
      const stream = await this.transport.createUnidirectionalStream();
      this.statsUnidirectionalStreamsOpened++;
      publisher.incrementDataStreamCount();
      const writer = stream.getWriter();

      // Subgroup Header を書き込む
      // draft-ietf-moq-transport-18 Section 11.4.2
      // draft-ietf-moq-transport-18 Section 2.2:
      // "Objects from the same Subgroup MUST NOT be sent on different streams"
      // FirstObjectId モードを使用して、各ストリームの最初の Object ID を
      // Subgroup ID として自動的に一意にする
      //
      // PROPERTIES ビット (0x01):
      // "When set to 1, the Object Properties structure is present in all Objects.
      //  When set to 0, the field is never present."
      // Properties の有無はストリーム開始時に全オブジェクトについて決められないため、
      // 常に FIRST_OBJ_EXT (Properties あり) を使用し、
      // properties がないオブジェクトには Properties Length = 0 を送信する。
      const header = encodeSubgroupHeader({
        type: SubgroupHeaderType.FIRST_OBJ_EXT,
        trackAlias,
        groupId,
        publisherPriority: params.priority ?? 128,
      });

      // writer.write() の失敗 (STOP_SENDING / delivery timeout) を検出して
      // closedSubgroups に追加する。
      // draft-ietf-moq-transport-18 §11.4.3:
      // "A publisher that receives a STOP_SENDING on a Subgroup stream SHOULD NOT
      //  attempt to open a new stream to deliver additional Objects in that Subgroup."
      try {
        await writer.write(header);
      } catch (err) {
        // ヘッダー書き込み失敗時は writer の参照が publisherStreams に残らないため、
        // 明示的にロックを解放する
        writer.releaseLock();
        this.closedSubgroups.add(`${trackAlias}:${groupId}`);
        throw err;
      }

      streamState = { groupId, writer, previousObjectId: -1n };
      this.publisherStreams.set(trackAlias, streamState);
    }

    // Object ID Delta を計算
    // draft-ietf-moq-transport-18 Section 11.4.2:
    // "The Object ID Delta + 1 is added to the previous Object ID ...
    //  The Object ID is the Object ID Delta if it's the first Object"
    const objectIdDelta = calculateObjectIdDelta(streamState.previousObjectId, objectId);

    // Object fields を構築
    // draft-ietf-moq-transport-18 Section 11.4.2 Figure 25
    // Subgroup Header の PROPERTIES ビットを常に 1 に設定しているため、
    // 全オブジェクトに Properties フィールドを含める必要がある。
    // Properties がないオブジェクトには Properties Length = 0 を送信する。
    //
    // encodeObjectFields を使用して、Object ID Delta / Properties / Payload Length /
    // Object Status（ペイロード長 0 の場合）を正しくエンコードする。
    // draft-ietf-moq-transport-18 §11.2.1.1:
    // 「Zero-length objects explicitly encode the Normal status.」
    const data = encodeObjectFields(
      objectIdDelta,
      BigInt(params.payload.length),
      SubgroupHeaderType.FIRST_OBJ_EXT,
      ObjectStatus.NORMAL,
      params.properties,
    );

    // writer.write() の失敗 (STOP_SENDING / delivery timeout) を検出して
    // closedSubgroups に追加する。
    try {
      await streamState.writer.write(data);
      if (params.payload.length > 0) {
        await streamState.writer.write(params.payload);
      }
    } catch (err) {
      // 書き込み失敗時は writer が破損しているためロックを解放する
      streamState.writer.releaseLock();
      this.closedSubgroups.add(`${trackAlias}:${groupId}`);
      throw err;
    }

    // 状態を更新
    streamState.previousObjectId = objectId;
  }

  /**
   * Publisher のストリームを閉じる
   * 送信キューに入れて、進行中の sendObject が完了してから閉じる
   */
  private closePublisherStream(trackAlias: bigint): Promise<void> {
    const previousPromise = this.publisherSendQueues.get(trackAlias) ?? Promise.resolve();
    const currentPromise = previousPromise
      .catch(() => {})
      .then(() => this.closePublisherStreamInternal(trackAlias));
    this.publisherSendQueues.set(trackAlias, currentPromise);
    return currentPromise;
  }

  private async closePublisherStreamInternal(trackAlias: bigint): Promise<void> {
    const streamState = this.publisherStreams.get(trackAlias);
    if (streamState) {
      // 先に Map から削除して二重クローズを防止
      this.publisherStreams.delete(trackAlias);
      try {
        // Safari の WebTransport では WritableStreamDefaultWriter.close() が
        // resolve しないことが確認されている。
        // タイムアウトを設けて FIN 送信の完了を待つが、
        // タイムアウトした場合はストリームを放棄して処理を続行する。
        await Promise.race([
          streamState.writer.close(),
          new Promise<void>((_, reject) => {
            setTimeout(() => reject(new Error("writer.close() timed out")), 5000);
          }),
        ]);
      } catch {
        // タイムアウトまたは既にクローズされている場合は無視
      }
    }

    // publisher done 時に当該 trackAlias の closedSubgroups エントリをクリアする
    // 長時間稼働時のメモリリークを防ぐため、単調増加させない
    //
    // ECMAScript 仕様上、Set のイテレーション中の delete は安全である。
    // キー形式 `${trackAlias}:${groupId}` の `:` 区切りにより、
    // trackAlias=1 が trackAlias=10 のエントリに誤マッチしないことが保証される。
    for (const key of this.closedSubgroups) {
      if (key.startsWith(`${trackAlias}:`)) {
        this.closedSubgroups.delete(key);
      }
    }
  }

  /**
   * Send a datagram
   * draft-ietf-moq-transport-18 Section 11.3 (Datagrams)
   */
  private sendDatagram(publisher: PublisherImpl, params: SendDatagramParams): void {
    const hasProperties = params.properties !== undefined && params.properties.length > 0;
    const hasPriority = params.priority !== undefined;
    const endOfGroup = params.endOfGroup ?? false;

    // Datagram Type を決定
    // Section 11.3.1: Type bits = EndOfGroup(bit 1) | PROPERTIES(bit 0)
    let type: number;
    if (hasPriority) {
      if (endOfGroup) {
        type = hasProperties
          ? DatagramType.PAYLOAD_OBJ_EXT_END_GROUP
          : DatagramType.PAYLOAD_OBJ_END_GROUP;
      } else {
        type = hasProperties ? DatagramType.PAYLOAD_OBJ_EXT : DatagramType.PAYLOAD_OBJ;
      }
    } else {
      if (endOfGroup) {
        type = hasProperties
          ? DatagramType.PAYLOAD_OBJ_EXT_END_GROUP_NO_PRI
          : DatagramType.PAYLOAD_OBJ_END_GROUP_NO_PRI;
      } else {
        type = hasProperties
          ? DatagramType.PAYLOAD_OBJ_EXT_NO_PRI
          : DatagramType.PAYLOAD_OBJ_NO_PRI;
      }
    }

    const datagram = encodeObjectDatagram({
      type,
      trackAlias: publisher.getTrackAlias(),
      groupId: BigInt(params.groupId),
      objectId: BigInt(params.objectId),
      publisherPriority: params.priority ?? 128,
      properties: params.properties,
      payload: params.payload,
    });

    // WebTransport datagram として送信
    const writer = this.transport.datagrams.writable.getWriter();
    writer
      .write(datagram)
      .finally(() => {
        writer.releaseLock();
      })
      .catch((err: unknown) => {
        publisher.handleError(err instanceof Error ? err : new Error(String(err)));
      });
  }

  /**
   * draft-ietf-moq-transport-18 Section 10.11 (PUBLISH_DONE):
   * PUBLISH_DONE は双方向ストリーム上で送信される。
   * Request ID フィールドはない（bidi stream で特定可能）。
   */
  private async sendPublishDone(publisher: PublisherImpl): Promise<void> {
    const requestId = publisher.getRequestId();

    // PUBLISH_DONE ペイロードをエンコード
    // draft-ietf-moq-transport-18 Section 10.11 (PUBLISH_DONE):
    // Stream Count は実際に開いたデータストリーム数を設定する
    const streamCount = publisher.getDataStreamCount();
    const parts: Uint8Array[] = [];
    parts.push(encodeVarint(PublishDoneStatusCode.TRACK_ENDED));
    parts.push(encodeVarint(streamCount));
    parts.push(encodeVarint(0)); // Reason phrase length

    const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
    const payload = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      payload.set(part, offset);
      offset += part.length;
    }

    // draft-ietf-moq-transport-18 Section 10.11 (PUBLISH_DONE):
    // PUBLISH_DONE は subscription の bidi stream 上で送信する
    const streamInfo = this.requestStreams.get(requestId);
    if (streamInfo) {
      const message = this.controlWriter!.encode(MessageType.PUBLISH_DONE, payload);
      this.statsControlMessagesSent++;
      this.emitDebug("send", MessageType.PUBLISH_DONE, payload, {
        requestId: requestId.toString(),
        statusCode: PublishDoneStatusCode.TRACK_ENDED,
        streamCount: streamCount.toString(),
      });
      try {
        await streamInfo.writer.write(message);
      } catch {
        // ストリームが既に閉じている場合は無視
      }
    }

    this.publishers.delete(requestId);
  }

  /**
   * サブスクリプションをキャンセルする
   *
   * draft-ietf-moq-transport-18 Section 3.3.1:
   * subscription のキャンセルは双方向ストリームの close で行う。
   */
  private async cancelSubscription(subscriber: SubscriberImpl): Promise<void> {
    return bidi.bidiCancelSubscription(this as unknown as bidi.BidiSessionInternal, subscriber);
  }

  /**
   * Fetch をキャンセルする
   *
   * draft-ietf-moq-transport-18 Section 5.2:
   * "It MUST send STOP_SENDING for the bidi request stream."
   */
  private async cancelFetch(fetcher: FetcherImpl): Promise<void> {
    return bidi.bidiCancelFetch(this as unknown as bidi.BidiSessionInternal, fetcher);
  }

  /**
   * REQUEST_UPDATE を送信する
   *
   * draft-ietf-moq-transport-18 Section 10.9 (REQUEST_UPDATE):
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
   * draft-ietf-moq-transport-18 Section 10.5 (REQUEST_OK):
   * PUBLISH_OK は双方向ストリーム上の最初のレスポンスとして送信される。
   * その後、同じストリームで REQUEST_UPDATE の応答も受信する。
   * draft-ietf-moq-transport-18 Section 3.3
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
   * draft-ietf-moq-transport-18 Section 10.8 (SUBSCRIBE_OK):
   * SUBSCRIBE_OK は双方向ストリーム上の最初のレスポンスとして送信される。
   * draft-ietf-moq-transport-18 Section 3.3
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
   * draft-ietf-moq-transport-18 Section 10.13 (FETCH_OK):
   * FETCH_OK は双方向ストリーム上の最初のレスポンスとして送信される。
   * draft-ietf-moq-transport-18 Section 3.3
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
   * draft-ietf-moq-transport-18 Section 10.14 (TRACK_STATUS):
   * TRACK_STATUS へのレスポンスは REQUEST_OK で返される。
   * draft-ietf-moq-transport-18 Section 3.3
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
            // draft-ietf-moq-transport-18 Section 3.3:
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
   * draft-ietf-moq-transport-18 Section 3.3:
   * リクエスト/レスポンス (SUBSCRIBE_OK, PUBLISH_OK, FETCH_OK, REQUEST_OK,
   * REQUEST_ERROR) は双方向ストリームに移動した。
   * 制御ストリームに残るのは GOAWAY のみ。
   * draft-ietf-moq-transport-18 Section 3.3
   *
   * draft-ietf-moq-transport-18 Section 10.15 (PUBLISH_NAMESPACE):
   * PUBLISH_NAMESPACE は新しい双方向ストリームの先頭メッセージとして送信される。
   * 制御ストリーム上で受信した場合は PROTOCOL_VIOLATION でセッションを閉じる。
   */
  private handleControlMessage(type: number, payload: Uint8Array): void {
    this.statsControlMessagesReceived++;
    let decoded: Record<string, unknown> | undefined;

    switch (type) {
      case MessageType.PUBLISH_DONE:
        // draft-ietf-moq-transport-18 Section 10.11 (PUBLISH_DONE):
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
        // draft-ietf-moq-transport-18 Section 10 (Control Messages):
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
   * Handle GOAWAY message
   *
   * draft-ietf-moq-transport-18 Section 10.4 (GOAWAY):
   * Upon receiving a GOAWAY, an endpoint SHOULD NOT initiate new requests
   * to the peer including SUBSCRIBE, PUBLISH, FETCH, PUBLISH_NAMESPACE,
   * SUBSCRIBE_NAMESPACE and TRACK_STATUS.
   *
   * The endpoint MUST terminate the session with a PROTOCOL_VIOLATION
   * if it receives multiple GOAWAY messages.
   */
  private handleGoaway(payload: Uint8Array): Record<string, unknown> {
    // 複数回の GOAWAY 受信は PROTOCOL_VIOLATION
    if (this.receivedGoaway) {
      this.closeWithError(
        new SessionError("received multiple GOAWAY messages", SessionErrorCode.PROTOCOL_VIOLATION),
      );
      return { error: "Multiple GOAWAY messages received" };
    }

    this.receivedGoaway = true;

    const msg = decodeGoawayPayload(payload);

    // draft-ietf-moq-transport-18 §10.4:
    // 制御ストリーム上の GOAWAY には Request ID が必須。
    // Request ID が不在の場合は PROTOCOL_VIOLATION でセッションを閉じる。
    if (msg.requestId === null) {
      this.closeWithError(
        new SessionError(
          "goaway on control stream must include request id",
          SessionErrorCode.PROTOCOL_VIOLATION,
        ),
      );
      return { error: "GOAWAY on control stream missing Request ID" };
    }

    // draft-ietf-moq-transport-18 §10.4:
    // GOAWAY の Request ID は送信元のピア空間を指す。
    // クライアントの Request ID パリティは even なため、
    // サーバーからの GOAWAY Request ID は even であることが期待される。
    // 受信した Request ID のパリティがクライアント (even) と一致しなければ
    // INVALID_REQUEST_ID でセッションを閉じる。
    if (msg.requestId % 2n !== 0n) {
      this.closeWithError(
        new SessionError(
          `GOAWAY request ID parity mismatch: ${msg.requestId} (expected even)`,
          SessionErrorCode.INVALID_REQUEST_ID,
        ),
      );
      return { error: "GOAWAY request ID parity mismatch" };
    }

    // GOAWAY コールバックを呼び出す
    this.callbacks.goaway?.(msg.newSessionUri);

    // draft-ietf-moq-transport-18 Section 3.6:
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
      }, Number(msg.timeout));
    }

    return {
      newSessionUri: msg.newSessionUri,
      timeout: msg.timeout.toString(),
    };
  }

  /**
   * NamespaceSubscription オブジェクトを作成する
   */
  private createNamespaceSubscription(requestId: bigint): NamespaceSubscription {
    const getState = (): "active" | "closed" => {
      const sub = this.namespaceSubscriptions.get(requestId);
      return sub?.state ?? "closed";
    };

    const unsubscribe = async (): Promise<void> => {
      await this.closeNamespaceSubscription(requestId);
    };

    return {
      get state() {
        return getState();
      },
      unsubscribe,
    };
  }

  /**
   * Namespace サブスクリプションを閉じる
   *
   * draft-ietf-moq-transport-18 §6.1:
   * A SUBSCRIBE_NAMESPACE can be cancelled by closing the stream with
   * either a FIN or RESET_STREAM.
   */
  private async closeNamespaceSubscription(requestId: bigint): Promise<void> {
    const subscription = this.namespaceSubscriptions.get(requestId);
    if (!subscription || subscription.state === "closed") {
      return;
    }

    subscription.state = "closed";

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
   * draft-ietf-moq-transport-18 §10.19 (SUBSCRIBE_TRACKS)
   */
  private createTracksSubscription(requestId: bigint): TracksSubscription {
    const getState = (): "active" | "closed" => {
      const sub = this.tracksSubscriptions.get(requestId);
      return sub?.state ?? "closed";
    };

    const unsubscribe = async (): Promise<void> => {
      await this.closeTracksSubscription(requestId);
    };

    return {
      get state() {
        return getState();
      },
      unsubscribe,
    };
  }

  /**
   * Tracks サブスクリプションを閉じる
   *
   * draft-ietf-moq-transport-18 §6.1:
   * A SUBSCRIBE_TRACKS can be cancelled by closing the stream with
   * either a FIN or RESET_STREAM.
   */
  private async closeTracksSubscription(requestId: bigint): Promise<void> {
    const subscription = this.tracksSubscriptions.get(requestId);
    if (!subscription || subscription.state === "closed") {
      return;
    }

    subscription.state = "closed";

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
  private createNamespacePublication(requestId: bigint): NamespacePublication {
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
   * draft-ietf-moq-transport-18 Section 6.1:
   * PUBLISH_NAMESPACE_DONE / PUBLISH_NAMESPACE_CANCEL は廃止され、
   * 公開の終了は双方向ストリームを FIN または RESET_STREAM で閉じることで通知する。
   * https://www.ietf.org/archive/id/draft-ietf-moq-transport-18.html#section-6.1
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
   * Start datagram receiving loop
   * draft-ietf-moq-transport-18 Section 11.3 (Datagrams)
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
   * Handle incoming datagram
   * draft-ietf-moq-transport-18 Section 11.3 (Datagrams)
   */
  private handleIncomingDatagram(data: Uint8Array): void {
    try {
      // draft-ietf-moq-transport-18 §11.5.2 (Padding Datagrams):
      // "The receiver MUST discard the contents of a padding datagram."
      // PADDING datagram (0x132b3e29) の 4 バイト varint 先頭バイトは 0xe4。
      // data.length < 4 の場合は完全な varint をデコードできないため PADDING ではない。
      if (data.length >= 4 && data[0] === 0xe4) {
        const [datagramType] = decodeVarint(data, 0);
        if (Number(datagramType) === 0x132b3e29) {
          // PADDING datagram は破棄して何もしない
          return;
        }
      }

      const [datagram] = decodeObjectDatagram(data);

      // Track Alias で Subscriber を検索
      const subscriber = this.subscribersByAlias.get(datagram.trackAlias);
      if (!subscriber) {
        return;
      }

      const object: MoqtObject = {
        groupId: datagram.groupId,
        subgroupId: undefined,
        objectId: datagram.objectId,
        publisherPriority: datagram.publisherPriority,
        status: datagram.status ?? ObjectStatus.NORMAL,
        properties: datagram.properties,
        payload: datagram.payload ?? new Uint8Array(0),
      };

      // Datagram コールバックがあればそちらを使用、なければ通常の object コールバックにフォールバック
      if (subscriber.hasDatagramCallback()) {
        subscriber.handleDatagram(object);
      } else {
        subscriber.handleObject(object);
      }
    } catch (err) {
      this.callbacks.debug?.({
        direction: "recv",
        type: 0,
        typeName: "DATAGRAM_DECODE_ERROR",
        payload: data,
        decoded: {
          error: err instanceof Error ? err.message : String(err),
        },
        timestamp: Date.now(),
      });
      // ProtocolViolationError は仕様違反のため PROTOCOL_VIOLATION でセッションを閉じる
      if (err instanceof ProtocolViolationError) {
        this.closeWithError(new SessionError(err.message, SessionErrorCode.PROTOCOL_VIOLATION));
      }
    }
  }

  /**
   * Fetcher の登録を待つ
   *
   * draft-ietf-moq-transport-18 Section 10.13 (FETCH_OK):
   * "A publisher MAY send Objects in response to a FETCH before the
   *  FETCH_OK message is sent."
   * FETCH_OK より先にデータストリームが到着した場合に使用。
   */
  private waitForFetcher(requestId: bigint): Promise<FetcherImpl | null> {
    return new Promise<FetcherImpl | null>((resolve) => {
      // 既に登録されている場合は即座に返す
      const existing = this.fetchers.get(requestId);
      if (existing) {
        resolve(existing);
        return;
      }

      // pendingFetch に存在しない場合は不明なリクエスト
      if (!this.pendingFetch.has(requestId)) {
        resolve(null);
        return;
      }

      let resolved = false;

      const doResolve = () => {
        if (resolved) return;
        resolved = true;
        resolve(this.fetchers.get(requestId) ?? null);
      };

      // コールバックを登録
      const callbacks = this.fetcherReadyCallbacks.get(requestId) ?? [];
      callbacks.push(doResolve);
      this.fetcherReadyCallbacks.set(requestId, callbacks);

      // タイムアウト: 5 秒以内に FETCH_OK が来なければ null
      setTimeout(doResolve, 5000);
    });
  }

  /**
   * Handle incoming unidirectional data stream
   * draft-ietf-moq-transport-18 Section 11.4 (Streams)
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
              // draft-ietf-moq-transport-18 Section 10.13 (FETCH_OK):
              // FETCH_OK より先にデータストリームが到着する可能性がある
              fetcher = this.fetchers.get(header.requestId) ?? null;
              if (!fetcher) {
                fetcher = await this.waitForFetcher(header.requestId);
                if (!fetcher) {
                  // タイムアウトで Fetcher が登録されなかった場合は、
                  // peer に STOP_SENDING (cancel) を送って受信を打ち切る。
                  // draft-ietf-moq-transport-18 Section 5.2 (Fetch State Management) に倣ってストリームを reset する。
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
              // draft-ietf-moq-transport-18 Section 11.4.2:
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
              // draft-ietf-moq-transport-18 §11.4.2 の buffer 経路はこのハンドラ内に集約
              await this.handleSubgroupStream(reader, header, initialPayloadBuffer);
              return;
            } else if (streamTypeNum === 0x132b3e28) {
              // draft-ietf-moq-transport-18 §11.5.1 (Padding Streams):
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
              // draft-ietf-moq-transport-18 Section 3.4 (Unidirectional Stream Types):
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
              if (done) break;
              continue;
            }
            if (err instanceof ProtocolViolationError) {
              // 仕様違反: PROTOCOL_VIOLATION でセッションを閉じる
              this.closeWithError(
                new SessionError(err.message, SessionErrorCode.PROTOCOL_VIOLATION),
              );
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
            // draft-ietf-moq-transport-18 Section 11.4.3:
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

      // ストリーム終了処理
      if (isFetchStream && fetcher) {
        // 残りのバッファを処理
        if (buffer.length > 0) {
          this.processFetchObjects(buffer, fetcher, fetchContext, isFirstFetchObject);
        }
        fetcher.handleEnd();
        if (fetchHeader) {
          this.fetchers.delete(fetchHeader.requestId);
        }
      }
    } catch (err) {
      // デバッグ: ストリームエラーをログ
      this.callbacks.debug?.({
        direction: "recv",
        type: 0,
        typeName: "DATA_STREAM_ERROR",
        payload: new Uint8Array(0),
        decoded: {
          error: err instanceof Error ? err.message : String(err),
        },
        timestamp: Date.now(),
      });
      // ProtocolViolationError は仕様違反のため PROTOCOL_VIOLATION でセッションを閉じる
      if (err instanceof ProtocolViolationError) {
        this.closeWithError(new SessionError(err.message, SessionErrorCode.PROTOCOL_VIOLATION));
      } else if (err instanceof MalformedTrackError) {
        await cancelStreamQuiet(
          reader,
          `malformed track: code=${DataStreamErrorCode.MALFORMED_TRACK}, reason=${err.message}`,
        );
      }
    } finally {
      this.statsSubscriberStreamsActive--;
      reader.releaseLock();
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
    return processFetchObjects(
      buffer,
      fetcher,
      context,
      isFirst,
      {
        incrementObjectsReceived: () => {
          this.statsObjectsReceivedViaFetch++;
        },
        incrementBytesReceived: (_subscribePath, bytes) => {
          this.statsBytesReceivedViaFetch += bytes;
        },
      },
      fetcher.getGroupOrder(),
    );
  }

  /**
   * Subgroup オブジェクトをストリーミング処理
   * パース可能なオブジェクトを全て処理し、残りのバッファと状態を返す
   */
  private processSubgroupObjects(
    buffer: Uint8Array,
    subscriber: SubscriberImpl,
    header: import("./dataStream").SubgroupHeader,
    previousObjectId: bigint,
  ): { remainingBuffer: Uint8Array; previousObjectId: bigint } {
    return processSubgroupObjects(buffer, subscriber, header, previousObjectId, {
      incrementObjectsReceived: () => {
        this.statsObjectsReceivedViaSubscribe++;
      },
      incrementBytesReceived: (_subscribePath, bytes) => {
        this.statsBytesReceivedViaSubscribe += bytes;
      },
    });
  }

  /**
   * Subgroup ストリームを処理する
   *
   * draft-ietf-moq-transport-18 §11.4.2:
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
    let subscriber: SubscriberImpl | null = this.subscribersByAlias.get(header.trackAlias) ?? null;

    // pending mode で発火された read Promise を subscriber mode に持ち越すための変数
    // ReadableStreamDefaultReader.read() は中断不能なため、Promise.race で別経路が
    // 勝ったときに pendingRead を破棄せず保持し、subscriber mode の最初の read として消費する
    let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;

    if (subscriber === null) {
      const entry = this.pendingSubgroupBuffer.add(header.trackAlias, header);
      let entryRemoved = false;

      try {
        // ヘッダパース直後に余っていた payload を pending entry に移し、ローカル buffer は空にする
        // subscriber mode 復帰時に entry.chunks の concat 結果で buffer を作り直す
        if (initialBuffer.byteLength > 0) {
          this.pendingSubgroupBuffer.appendChunk(entry, initialBuffer);
          buffer = new Uint8Array(0);
        }

        while (subscriber === null) {
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
            subscriber = this.subscribersByAlias.get(header.trackAlias) ?? null;
            if (subscriber === null) {
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
        subscriber,
        header,
        previousObjectId,
      );
      buffer = processResult.remainingBuffer;
      previousObjectId = processResult.previousObjectId;

      if (result.done) break;
    }
  }
}

// 純粋関数群は session/params.ts に移動
export {
  buildPublishParameters,
  buildPublishTrackProperties,
  buildSubscribeParameters,
  extractLargestLocation,
  extractForwardState,
  validateFetchOkEndLocation,
  classifyIncomingStreamType,
  calculateObjectIdDelta,
  type IncomingStreamKind,
} from "./session/params";
