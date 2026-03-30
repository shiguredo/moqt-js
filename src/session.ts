/**
 * MOQT Session
 * draft-ietf-moq-transport-17 Section 3
 */

import { ControlStreamReader, ControlStreamWriter } from "./controlStream";
import {
  encodeSubgroupHeader,
  SubgroupHeaderType,
  decodeSubgroupHeader,
  decodeObjectFields,
  encodeObjectDatagram,
  decodeObjectDatagram,
  DatagramType,
  type MoqtObject,
} from "./dataStream";
export type { MoqtObject } from "./dataStream";
import { RequestError, type RequestErrorCode, SessionError, SessionErrorCode } from "./error";
import {
  MessageType,
  PublishDoneStatusCode,
  ObjectStatus,
  NamespaceSubscribeMode,
  createTrackNamespace,
  encodeTrackName,
  trackNamespaceToStrings,
  decodeFetchOkPayload,
  decodeGoawayPayload,
  decodeNamespaceDonePayload,
  decodeNamespacePayload,
  decodePublishDonePayload,
  decodePublishNamespacePayload,
  decodePublishOkPayload,
  decodeRequestErrorPayload,
  decodeRequestOkPayload,
  decodeSetupPayload,
  decodeSubscribeOkPayload,
  encodeSetupPayload,
  encodeFetchPayload,
  encodeGoawayPayload,
  encodePublishNamespacePayload,
  encodePublishPayload,
  encodeSubscribeNamespacePayload,
  encodeSubscribePayload,
  encodeRequestUpdatePayload,
  encodeTrackStatusPayload,
  createSetup,
  getMessageTypeName,
  getParameterLocationValue,
  encodeSubscriptionFilterParameter,
  validateForwardValue,
  FetchType,
  VersionSpecificParameterType,
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
import { decodeFetchHeader, decodeFetchObjectFields, FetchHeaderType } from "./dataStream";
import { TrackPropertyId, type Property } from "./properties";

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
  /** Raw payload bytes */
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
   * draft-ietf-moq-transport-17 Section 9.4
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
   * draft-ietf-moq-transport-17 Section 9.2.2.8
   *
   * PUBLISH_OK または REQUEST_UPDATE で Forward State が変更された時に呼ばれる。
   * - true (1): Subscriber がいる（オブジェクトを送信すべき）
   * - false (0): Subscriber がいない（オブジェクト送信を止めても良い）
   */
  onForwardStateChange?: (forward: boolean) => void;
}

/**
 * Publish options
 */
export interface PublishOptions {
  /**
   * キャッシュの最大保持時間（ミリ秒）
   * draft-ietf-moq-transport-17 Section 11.1.1
   *
   * Relay がオブジェクトをキャッシュして良い最大時間を指定する。
   * 0 を指定するとキャッシュを無効にする。
   */
  maxCacheDuration?: bigint;

  /**
   * Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-17 Section 9.2.2.2
   *
   * オブジェクトを受信してから配信を試みる最大時間。
   * Publisher と Subscriber の両方が指定した場合、小さい方の値が使用される。
   * タイムアウトを超過したオブジェクトは配信されない。
   */
  deliveryTimeout?: bigint;

  /**
   * Publisher Priority（0-255）
   * draft-ietf-moq-transport-17 Section 11.1.1.1
   *
   * パブリッシュの優先度。小さい値ほど高優先度。
   * 指定しない場合は 128（デフォルト）
   */
  publisherPriority?: number;

  /**
   * Group Order
   * draft-ietf-moq-transport-17 Section 9.2.2.4
   *
   * グループの配信順序。
   * - "Ascending": 古いグループから順に配信
   * - "Descending": 新しいグループから順に配信
   */
  groupOrder?: "Ascending" | "Descending";

  /**
   * Dynamic Groups サポートの通知
   * draft-ietf-moq-transport-17 Section 11.1.1.3
   *
   * true を設定すると、Subscriber が NEW_GROUP_REQUEST パラメータで
   * 新しいグループの生成を要求できることを通知する。
   */
  dynamicGroups?: boolean;

  /**
   * Expires（ミリ秒）
   * draft-ietf-moq-transport-17 Section 9.2.2.6
   *
   * パブリッシュが自動終了するまでの時間（ミリ秒）。
   * 0 または未指定の場合は期限なし。
   */
  expires?: bigint;

  /**
   * Forward State
   * draft-ietf-moq-transport-17 Section 9.2.2.8
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
   * draft-ietf-moq-transport-17 Section 10.3
   *
   * 注意: Datagram は信頼性がなく、順序も保証されない
   */
  datagram?: (object: MoqtObject) => void;
  end?: () => void;
  error?: (error: Error) => void;
}

/**
 * Joining Fetch オプション
 * draft-ietf-moq-transport-17 Section 9.16.2
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
   * draft-ietf-moq-transport-17 Section 5.1.2, Section 9.2.2.5
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
   * draft-ietf-moq-transport-17 Section 9.2.2.2
   *
   * オブジェクトを受信してから配信を試みる最大時間。
   * Publisher と Subscriber の両方が指定した場合、小さい方の値が使用される。
   * タイムアウトを超過したオブジェクトは配信されない。
   */
  deliveryTimeout?: bigint;

  /**
   * Subscriber Priority（0-255）
   * draft-ietf-moq-transport-17 Section 9.2.2.3
   *
   * サブスクリプションの優先度。小さい値ほど高優先度。
   * 指定しない場合は 128（デフォルト）
   */
  subscriberPriority?: number;

  /**
   * Group Order
   * draft-ietf-moq-transport-17 Section 9.2.2.4
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
   * draft-ietf-moq-transport-17 Section 9.2.2.9
   *
   * 0 を指定すると、Publisher は新しい Group を開始する
   * Publisher が DYNAMIC_GROUPS をサポートしていない場合は無視される
   */
  newGroupRequest?: bigint;

  /**
   * Joining Fetch オプション
   * draft-ietf-moq-transport-17 Section 9.16.2
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
   * draft-ietf-moq-transport-17 Section 9.2.2.8
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
   * draft-ietf-moq-transport-17 Section 9.3.4
   *
   * リレーが Publisher を待つ時間。
   * 0 は即時応答を要求。指定しない場合のデフォルトは 0。
   * https://github.com/moq-wg/moq-transport/pull/1447
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
 * draft-ietf-moq-transport-17 Section 9.19
 */
export interface TrackStatusResult {
  /**
   * 応答パラメータ（SUBSCRIBE_OK と同様）
   */
  parameters: Parameter[];
}

/**
 * Namespace 公開通知
 * draft-ietf-moq-transport-17 Section 9.20
 */
export interface NamespaceAnnouncement {
  /**
   * 公開されたトラックの Namespace
   */
  namespace: string[];
  /**
   * パラメータ
   */
  parameters: Parameter[];
}

/**
 * Namespace サブスクリプションのコールバック
 *
 * draft-ietf-moq-transport-17 Section 6.1:
 * SUBSCRIBE_NAMESPACE への応答として、NAMESPACE/NAMESPACE_DONE または PUBLISH が送信される。
 * https://www.ietf.org/archive/id/draft-ietf-moq-transport-17.html#section-6.1
 */
export interface NamespaceSubscriptionCallbacks {
  /**
   * NAMESPACE を受信したときに呼ばれる
   * draft-ietf-moq-transport-17 Section 9.21
   *
   * @param namespaceSuffix - Track Namespace Prefix を除いた Suffix
   */
  onNamespace?: (namespaceSuffix: string[]) => void;
  /**
   * NAMESPACE_DONE を受信したときに呼ばれる
   * draft-ietf-moq-transport-17 Section 9.23
   *
   * @param namespaceSuffix - Track Namespace Prefix を除いた Suffix
   */
  onNamespaceDone?: (namespaceSuffix: string[]) => void;
  /**
   * PUBLISH_NAMESPACE を受信したときに呼ばれる（Control Stream 経由）
   * draft-ietf-moq-transport-17 Section 9.20
   */
  announce?: (announcement: NamespaceAnnouncement) => void;
  /**
   * エラー時のコールバック
   */
  error?: (error: Error) => void;
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
 * Namespace 公開のコールバック
 * draft-ietf-moq-transport-17 Section 9.17
 */
export interface NamespacePublicationCallbacks {
  /**
   * エラー時のコールバック
   */
  error?: (error: Error) => void;
}

/**
 * Namespace 公開
 * draft-ietf-moq-transport-17 Section 9.17
 */
export interface NamespacePublication {
  readonly state: "active" | "closed";
  /**
   * 公開している Namespace
   */
  readonly namespace: string[];
  /**
   * 公開を終了する
   * draft-ietf-moq-transport-17: ストリームの close で終了を通知する。
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
   * draft-ietf-moq-transport-17 Section 9.4
   */
  readonly goawayReceived: boolean;
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
   * draft-ietf-moq-transport-17 Section 9.16
   */
  fetch(
    namespace: string[],
    trackName: string,
    options: FetchOptions,
    callbacks: FetchCallbacks,
  ): Promise<Fetcher>;
  /**
   * トラックの状態を問い合わせる
   * draft-ietf-moq-transport-17 Section 9.19
   */
  trackStatus(namespace: string[], trackName: string): Promise<TrackStatusResult>;
  /**
   * Namespace をサブスクライブする（トラック発見用）
   *
   * draft-ietf-moq-transport-17 Section 9.25:
   * SUBSCRIBE_NAMESPACE は新しい双方向ストリームで送信される。
   * https://www.ietf.org/archive/id/draft-ietf-moq-transport-17.html#section-9.25
   *
   * @param namespacePrefix - Track Namespace Prefix
   * @param callbacks - コールバック関数
   * @param subscribeOptions - Subscribe Options（デフォルト: BOTH）
   */
  subscribeNamespace(
    namespacePrefix: string[],
    callbacks: NamespaceSubscriptionCallbacks,
    subscribeOptions?: NamespaceSubscribeMode,
  ): Promise<NamespaceSubscription>;
  /**
   * Namespace を公開する（トラック発見用）
   * draft-ietf-moq-transport-17 Section 9.20
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
   * draft-ietf-moq-transport-17 Section 9.5
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
  /**
   * draft-ietf-moq-transport-17 Section 4:
   * 制御ストリームは単方向ストリームのペアに変更された。
   * クライアントとサーバーがそれぞれ 1 本ずつ単方向ストリームを開く。
   * https://github.com/moq-wg/moq-transport/pull/1510
   */
  private controlSendStream?: WritableStream<Uint8Array>;
  private controlReceiveStream?: ReadableStream<Uint8Array>;
  private controlReader?: ControlStreamReader;
  private controlWriter?: ControlStreamWriter;

  // Request ID management
  private nextRequestId = 0n;
  private nextTrackAlias = 0n;

  // GOAWAY 状態
  private receivedGoaway = false;
  private sentGoaway = false;
  private goawayTimeoutId: ReturnType<typeof setTimeout> | null = null;

  // Active publishers, subscribers and fetchers
  private publishers = new Map<bigint, PublisherImpl>();
  private subscribers = new Map<bigint, SubscriberImpl>();
  private subscribersByAlias = new Map<bigint, SubscriberImpl>();
  private fetchers = new Map<bigint, FetcherImpl>();

  // Subscriber 登録前に到着した Subgroup ストリームをバッファリング
  // QUIC ではストリーム間の順序が保証されないため、
  // SUBSCRIBE_OK より先にデータストリームが到着する可能性がある
  private pendingSubgroupStreams = new Map<
    bigint,
    Array<{ header: import("./dataStream").SubgroupHeader; data: Uint8Array }>
  >();

  // Subscriber 登録待ちの Promise を管理
  // SUBSCRIBE_OK より先にデータストリームが到着した場合、
  // ストリーム全体をバッファリングするのではなく subscriber の登録を待つ
  private subscriberReadyCallbacks = new Map<bigint, Array<() => void>>();

  // リクエストごとの双方向ストリーム管理
  // draft-ietf-moq-transport-17 Section 3.3:
  // リクエストは双方向ストリーム上で送受信される。
  // https://github.com/moq-wg/moq-transport/pull/1389
  private requestStreams = new Map<
    bigint,
    {
      stream: WebTransportBidirectionalStream;
      writer: WritableStreamDefaultWriter<Uint8Array>;
      controlReader: ControlStreamReader;
    }
  >();

  // Pending requests
  private pendingPublish = new Map<
    bigint,
    { resolve: (pub: Publisher) => void; reject: (err: Error) => void; impl: PublisherImpl }
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
   * draft-ietf-moq-transport-17 Section 6.1:
   * SUBSCRIBE_NAMESPACE は専用の双方向ストリームで送受信される。
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
  private pendingNamespacePublish = new Map<
    bigint,
    {
      resolve: (publication: NamespacePublication) => void;
      reject: (err: Error) => void;
      callbacks?: NamespacePublicationCallbacks;
      namespace: string[];
    }
  >();
  private namespacePublications = new Map<
    bigint,
    {
      callbacks?: NamespacePublicationCallbacks;
      state: "active" | "closed";
      namespace: string[];
    }
  >();

  // Publisher ごとのストリーム状態
  // draft-ietf-moq-transport-17 Section 2.2:
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

  // TODO: Closed Subgroup Tracking
  // draft-ietf-moq-transport-17:
  // delivery timeout または STOP_SENDING 後に Subgroup を再オープンしてはならない。
  // https://github.com/moq-wg/moq-transport/pull/1396
  //
  // 現在の実装では 1 Group = 1 Subgroup = 1 Stream モデルを採用しているため、
  // グループが終了すると自然と新しいストリームを作成する。
  // 完全な実装には以下が必要:
  // 1. WebTransport の STOP_SENDING シグナル検出
  // 2. 閉じた Subgroup (trackAlias, groupId, subgroupId) の追跡
  // 3. sendObject 時に閉じた Subgroup への送信を拒否

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

  constructor(transport: WebTransport, callbacks: ConnectCallbacks) {
    this.transport = transport;
    this.callbacks = callbacks;

    // WebTransport の切断を監視し、close 理由をコールバックに渡す
    this.transport.closed
      .then((closeInfo) => {
        this.callbacks.close?.(closeInfo);
      })
      .catch((error) => {
        this.callbacks.close?.({ closeCode: 0, reason: String(error) });
      });
  }

  get state(): SessionState {
    return this.sessionState;
  }

  get goawayReceived(): boolean {
    return this.receivedGoaway;
  }

  /**
   * Initialize the session (called after WebTransport connect)
   */
  async initialize(): Promise<void> {
    // draft-ietf-moq-transport-17 Section 4:
    // 制御ストリームは単方向ストリームのペアに変更された。
    // クライアントは送信用単方向ストリームを開き、サーバーの単方向ストリームを受信する。
    // https://github.com/moq-wg/moq-transport/pull/1510

    this.controlReader = new ControlStreamReader();
    this.controlWriter = new ControlStreamWriter();

    // 送信用単方向ストリームを開く
    this.controlSendStream = await this.transport.createUnidirectionalStream();

    // draft-ietf-moq-transport-17 Section 3.4:
    // All unidirectional MOQT streams start with a variable-length integer
    // indicating the type of the stream.
    // 制御ストリームのストリームタイプは 0x2F00 (Table 3)
    const streamTypeBytes = encodeVarint(MessageType.SETUP);

    // Send SETUP
    const setup = createSetup();
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

    // draft-ietf-moq-transport-17 Section 3.4:
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
    decodeSetupPayload(msg.payload);

    this.emitDebug("recv", MessageType.SETUP, msg.payload, {});

    // Start reading control messages in background
    this.startControlMessageLoop();

    // Start accepting incoming data streams
    this.startIncomingStreamLoop();

    // Start receiving datagrams
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
    // draft-ietf-moq-transport-17 Section 9.4
    if (this.receivedGoaway) {
      throw new Error("Cannot publish after receiving GOAWAY");
    }

    const requestId = this.nextRequestId;
    this.nextRequestId += 2n; // Client uses even IDs

    const trackAlias = this.nextTrackAlias++;

    const trackNamespace = createTrackNamespace(namespace);
    const trackNameBytes = encodeTrackName(trackName);

    // Create publisher implementation
    const impl = new PublisherImpl(
      namespace,
      trackName,
      requestId,
      trackAlias,
      callbacks?.error,
      callbacks?.onForwardStateChange,
    );

    // Set up send callback
    impl.onSendObject = (params: SendObjectParams) => {
      void this.sendObject(impl, params);
    };

    // Set up datagram send callback
    impl.onSendDatagram = (params: SendDatagramParams) => {
      this.sendDatagram(impl, params);
    };

    impl.onDoneInternal = async () => {
      // まずストリームを閉じる（FIN を送信）
      await this.closePublisherStream(impl.getTrackAlias());
      // その後 PUBLISH_DONE を送信
      await this.sendPublishDone(impl);
    };

    // Create promise for PUBLISH_OK
    const promise = new Promise<Publisher>((resolve, reject) => {
      this.pendingPublish.set(requestId, { resolve, reject, impl });
    });

    // Build parameters (Message Parameters - single hop scope)
    const parameters: Parameter[] = [];

    // EXPIRES (0x08) - draft-ietf-moq-transport-17 Section 9.2.2.6
    if (options?.expires !== undefined) {
      parameters.push({
        type: VersionSpecificParameterType.EXPIRES,
        value: encodeVarint(options.expires),
      });
    }

    // FORWARD (0x10) - draft-ietf-moq-transport-17 Section 9.2.2.8
    // デフォルトは 1 なので、明示的に false (0) が指定された場合のみ送信
    if (options?.forward === false) {
      parameters.push({
        type: VersionSpecificParameterType.FORWARD,
        value: encodeVarint(0n),
      });
    }

    // Build track extensions (Track Extensions - end-to-end scope)
    // draft-ietf-moq-transport-17: Track Properties を Extensions に移動
    // https://github.com/moq-wg/moq-transport/pull/1390
    const trackProperties: Property[] = [];

    // DELIVERY_TIMEOUT (0x02) - draft-ietf-moq-transport-17 Section 11.1
    // Track Property としての DELIVERY_TIMEOUT。
    // 値が 0 の場合はタイムアウトなしを意味する。
    // Subscriber が DELIVERY_TIMEOUT パラメータも指定した場合、
    // 両方の非ゼロ値の最小値が使用される。
    // https://github.com/moq-wg/moq-transport/pull/1450
    if (options?.deliveryTimeout !== undefined) {
      trackProperties.push({
        id: TrackPropertyId.DELIVERY_TIMEOUT,
        value: options.deliveryTimeout,
      });
    }

    // MAX_CACHE_DURATION (0x04) - draft-ietf-moq-transport-17 Section 11.1.1
    if (options?.maxCacheDuration !== undefined) {
      trackProperties.push({
        id: TrackPropertyId.MAX_CACHE_DURATION,
        value: options.maxCacheDuration,
      });
    }

    // PUBLISHER_PRIORITY (0x0e) - draft-ietf-moq-transport-17 Section 11.1.1.1
    if (options?.publisherPriority !== undefined) {
      trackProperties.push({
        id: TrackPropertyId.PUBLISHER_PRIORITY,
        value: BigInt(options.publisherPriority),
      });
    }

    // PUBLISHER_GROUP_ORDER_PREFERENCE (0x22) - draft-ietf-moq-transport-17 Section 9.2.2.4
    // draft-ietf-moq-transport-17: GROUP_ORDER から Publisher 向けの設定が分離
    // https://github.com/moq-wg/moq-transport/pull/1390
    if (options?.groupOrder !== undefined) {
      const groupOrderValue = options.groupOrder === "Ascending" ? 0x01n : 0x02n;
      trackProperties.push({
        id: TrackPropertyId.PUBLISHER_GROUP_ORDER_PREFERENCE,
        value: groupOrderValue,
      });
    }

    // DYNAMIC_GROUPS (0x30) - draft-ietf-moq-transport-17 Section 11.1.1.3
    if (options?.dynamicGroups === true) {
      trackProperties.push({
        id: TrackPropertyId.DYNAMIC_GROUPS,
        value: 1n,
      });
    }

    // PUBLISH メッセージを双方向ストリームで送信
    // draft-ietf-moq-transport-17 Section 9.11:
    // "The publisher sends PUBLISH as the first message on a new
    //  bidirectional stream to initiate a subscription for a Track."
    // https://github.com/moq-wg/moq-transport/pull/1389
    const publishMsg = {
      type: MessageType.PUBLISH,
      requestId,
      // Required Request ID Delta (vi64) - draft-ietf-moq-transport-17 Section 9.2
      // 0 は依存なしを意味する
      requiredRequestIdDelta: 0n,
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
      DELIVERY_TIMEOUT: options?.deliveryTimeout?.toString(),
      PUBLISHER_PRIORITY: options?.publisherPriority,
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
   * draft-ietf-moq-transport-17 Section 9.9:
   * SUBSCRIBE does not include Track Alias.
   * Track Alias is returned by the publisher in SUBSCRIBE_OK (Section 9.10).
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
    // draft-ietf-moq-transport-17 Section 9.4
    if (this.receivedGoaway) {
      throw new Error("Cannot subscribe after receiving GOAWAY");
    }

    // Joining Fetch は Filter Type が LargestObject の場合のみ許可
    // draft-ietf-moq-transport-17 Section 9.14.2:
    // "A Joining Fetch is only permitted when the associated Subscribe has
    //  the Filter Type Largest Object; any other value results in closing
    //  the session with a PROTOCOL_VIOLATION."
    // joiningFetch が有効な場合、自動的に LargestObject フィルターを設定する
    if (options?.joiningFetch) {
      // draft-ietf-moq-transport-17 Section 9.14.2:
      // "A Joining Fetch is only permitted when the associated subscription
      //  has Forward State 1; otherwise the publisher MUST close the session
      //  with a PROTOCOL_VIOLATION."
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

    // Create subscriber implementation
    // Note: trackAlias will be set when SUBSCRIBE_OK is received
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

    // Set up update callback
    impl.onUpdate = async (updateOptions: RequestUpdateOptions) => {
      await this.sendRequestUpdate(impl, updateOptions);
    };

    // Create promise for SUBSCRIBE_OK
    const promise = new Promise<Subscriber>((resolve, reject) => {
      this.pendingSubscribe.set(requestId, {
        resolve,
        reject,
        impl,
        joiningFetch: options?.joiningFetch,
        objectCallback: callbacks.object,
      });
    });

    // Build parameters
    const parameters: Parameter[] = [];

    // SUBSCRIPTION_FILTER (0x21) - draft-ietf-moq-transport-17 Section 9.2.2.5
    if (options?.filter !== undefined) {
      parameters.push(encodeSubscriptionFilterParameter(options.filter));
    }

    // DELIVERY_TIMEOUT (0x02) - draft-ietf-moq-transport-17 Section 9.3.3
    // 値が 0 の場合はタイムアウトなしを意味する。
    // https://github.com/moq-wg/moq-transport/pull/1450
    if (options?.deliveryTimeout !== undefined) {
      parameters.push({
        type: VersionSpecificParameterType.DELIVERY_TIMEOUT,
        value: encodeVarint(options.deliveryTimeout),
      });
    }

    // SUBSCRIBER_PRIORITY (0x20) - draft-ietf-moq-transport-17 Section 9.2.2.3
    if (options?.subscriberPriority !== undefined) {
      parameters.push({
        type: VersionSpecificParameterType.SUBSCRIBER_PRIORITY,
        value: encodeVarint(options.subscriberPriority),
      });
    }

    // GROUP_ORDER (0x22) - draft-ietf-moq-transport-17 Section 9.2.2.4
    if (options?.groupOrder !== undefined) {
      const groupOrderValue = options.groupOrder === "Ascending" ? 0x01 : 0x02;
      parameters.push({
        type: VersionSpecificParameterType.GROUP_ORDER,
        value: encodeVarint(groupOrderValue),
      });
    }

    if (options?.newGroupRequest !== undefined) {
      // NEW_GROUP_REQUEST (0x32) - varint parameter
      parameters.push({
        type: VersionSpecificParameterType.NEW_GROUP_REQUEST,
        value: encodeVarint(options.newGroupRequest),
      });
    }

    // RENDEZVOUS_TIMEOUT (0x04) - draft-ietf-moq-transport-17 Section 9.3.4
    // https://github.com/moq-wg/moq-transport/pull/1447
    if (options?.rendezvousTimeout !== undefined) {
      parameters.push({
        type: VersionSpecificParameterType.RENDEZVOUS_TIMEOUT,
        value: encodeVarint(options.rendezvousTimeout),
      });
    }

    // FORWARD (0x10) - draft-ietf-moq-transport-17 Section 9.2.2.8
    // デフォルトは 1 なので、明示的に false (0) が指定された場合のみ送信
    if (options?.forward === false) {
      parameters.push({
        type: VersionSpecificParameterType.FORWARD,
        value: encodeVarint(0n),
      });
    }

    // SUBSCRIBE メッセージを双方向ストリームで送信
    // draft-ietf-moq-transport-17 Section 9.8:
    // SUBSCRIBE は新しい双方向ストリームで送信される。
    // https://github.com/moq-wg/moq-transport/pull/1389
    const subscribeMsg = {
      type: MessageType.SUBSCRIBE,
      requestId,
      // Required Request ID Delta (vi64) - draft-ietf-moq-transport-17 Section 9.2
      // 0 は依存なしを意味する
      requiredRequestIdDelta: 0n,
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
        DELIVERY_TIMEOUT: options?.deliveryTimeout?.toString(),
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
   * draft-ietf-moq-transport-17 Section 9.16:
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

    // draft-ietf-moq-transport-17 Section 5.2:
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
      });
    });

    // FETCH メッセージを双方向ストリームで送信（Standalone Fetch）
    // draft-ietf-moq-transport-17 Section 9.14:
    // FETCH は新しい双方向ストリームで送信される。
    // https://github.com/moq-wg/moq-transport/pull/1389
    const fetchMsg = {
      type: MessageType.FETCH,
      requestId,
      // Required Request ID Delta (vi64) - draft-ietf-moq-transport-17 Section 9.2
      // 0 は依存なしを意味する
      requiredRequestIdDelta: 0n,
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
   * draft-ietf-moq-transport-17 Section 9.19:
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
    // draft-ietf-moq-transport-17 Section 9.16:
    // TRACK_STATUS は新しい双方向ストリームで送信される。
    // https://github.com/moq-wg/moq-transport/pull/1389
    const trackStatusMsg = {
      type: MessageType.TRACK_STATUS,
      requestId,
      // Required Request ID Delta (vi64) - draft-ietf-moq-transport-17 Section 9.2
      // 0 は依存なしを意味する
      requiredRequestIdDelta: 0n,
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
   * Namespace をサブスクライブする（トラック発見用）
   *
   * draft-ietf-moq-transport-17 Section 9.25:
   * SUBSCRIBE_NAMESPACE は新しい双方向ストリームで送信される。
   * REQUEST_OK または REQUEST_ERROR が最初のレスポンスとして返される。
   * https://www.ietf.org/archive/id/draft-ietf-moq-transport-17.html#section-9.25
   *
   * draft-ietf-moq-transport-17 Section 6.1:
   * キャンセルは FIN または RESET_STREAM で行う。
   * https://www.ietf.org/archive/id/draft-ietf-moq-transport-17.html#section-6.1
   */
  async subscribeNamespace(
    namespacePrefix: string[],
    callbacks: NamespaceSubscriptionCallbacks,
    subscribeOptions: NamespaceSubscribeMode = NamespaceSubscribeMode.BOTH,
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
      // Required Request ID Delta (vi64) - draft-ietf-moq-transport-17 Section 9.2
      // 0 は依存なしを意味する
      requiredRequestIdDelta: 0n,
      trackNamespacePrefix,
      subscribeOptions,
      parameters: [] as [],
    };

    // メッセージをエンコードして送信
    const payload = encodeSubscribeNamespacePayload(subscribeNamespaceMsg);
    const typeAndLength = new Uint8Array([
      ...encodeVarint(MessageType.SUBSCRIBE_NAMESPACE),
      ...encodeVarint(payload.length),
    ]);

    // デバッグコールバック
    this.callbacks.debug?.({
      direction: "send",
      type: MessageType.SUBSCRIBE_NAMESPACE,
      typeName: getMessageTypeName(MessageType.SUBSCRIBE_NAMESPACE),
      payload,
      decoded: {
        requestId: requestId.toString(),
        trackNamespacePrefix: namespacePrefix,
        subscribeOptions,
      },
      timestamp: Date.now(),
    });

    await writer.write(new Uint8Array([...typeAndLength, ...payload]));

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
   * SUBSCRIBE_NAMESPACE 専用ストリームの受信ループ
   *
   * draft-ietf-moq-transport-17 Section 6.1:
   * REQUEST_OK/REQUEST_ERROR、NAMESPACE、NAMESPACE_DONE を処理する。
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

          switch (messageType) {
            case MessageType.REQUEST_OK: {
              // draft-ietf-moq-transport-17 Section 9.6:
              // Request ID はストリームが特定するため不要
              // https://github.com/moq-wg/moq-transport/pull/1499
              decodeRequestOkPayload(messagePayload);
              // サブスクリプション成功
              resolved = true;
              const namespaceSubscription = this.createNamespaceSubscription(requestId);
              resolve(namespaceSubscription);
              break;
            }

            case MessageType.REQUEST_ERROR: {
              // draft-ietf-moq-transport-17 Section 9.7:
              // Request ID はストリームが特定するため不要
              // https://github.com/moq-wg/moq-transport/pull/1499
              const decodedMsg = decodeRequestErrorPayload(messagePayload);
              // サブスクリプション失敗
              const error = new RequestError(
                decodedMsg.reasonPhrase,
                Number(decodedMsg.errorCode) as RequestErrorCode,
              );
              subscription.state = "closed";
              callbacks.error?.(error);
              reject(error);
              return;
            }

            case MessageType.NAMESPACE: {
              const decodedMsg = decodeNamespacePayload(messagePayload);
              const suffixStrings = trackNamespaceToStrings(decodedMsg.trackNamespaceSuffix);
              callbacks.onNamespace?.(suffixStrings);
              break;
            }

            case MessageType.NAMESPACE_DONE: {
              const decodedMsg = decodeNamespaceDonePayload(messagePayload);
              const suffixStrings = trackNamespaceToStrings(decodedMsg.trackNamespaceSuffix);
              callbacks.onNamespaceDone?.(suffixStrings);
              break;
            }

            default:
              // draft-ietf-moq-transport-17 Section 9:
              // "An endpoint that receives an unknown message type MUST close the session."
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
        callbacks.error?.(error instanceof Error ? error : new Error(String(error)));
        if (!resolved) {
          reject(error instanceof Error ? error : new Error(String(error)));
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
   * Namespace を公開する（トラック発見用）
   *
   * draft-ietf-moq-transport-17 Section 9.20:
   * PUBLISH_NAMESPACE notifies that a Track Namespace has tracks available.
   */
  async publishNamespace(
    namespace: string[],
    callbacks?: NamespacePublicationCallbacks,
  ): Promise<NamespacePublication> {
    if (this.sessionState === "closed") {
      throw new Error("Session is closed");
    }

    // GOAWAY 受信後は新規リクエストを拒否
    if (this.receivedGoaway) {
      throw new Error("Cannot publish namespace after receiving GOAWAY");
    }

    const requestId = this.nextRequestId;
    this.nextRequestId += 2n;

    const trackNamespace = createTrackNamespace(namespace);

    // REQUEST_OK を待つ Promise
    const promise = new Promise<NamespacePublication>((resolve, reject) => {
      this.pendingNamespacePublish.set(requestId, { resolve, reject, callbacks, namespace });
    });

    // PUBLISH_NAMESPACE メッセージを送信
    const publishNamespaceMsg = {
      type: MessageType.PUBLISH_NAMESPACE,
      requestId,
      // Required Request ID Delta (vi64) - draft-ietf-moq-transport-17 Section 9.2
      // 0 は依存なしを意味する
      requiredRequestIdDelta: 0n,
      trackNamespace,
      parameters: [],
    };

    const payload = encodePublishNamespacePayload(publishNamespaceMsg);
    await this.sendControlMessage(MessageType.PUBLISH_NAMESPACE, payload, {
      requestId: requestId.toString(),
      trackNamespace: namespace,
    });

    return promise;
  }

  /**
   * GOAWAY を送信してセッション終了を通知する
   *
   * draft-ietf-moq-transport-17 Section 9.5:
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

    this.sentGoaway = true;

    const goawayTimeout = timeout ?? 0n;
    const payload = encodeGoawayPayload({
      type: MessageType.GOAWAY,
      newSessionUri: newSessionUri ?? "",
      timeout: goawayTimeout,
    });

    await this.sendControlMessage(MessageType.GOAWAY, payload, {
      newSessionUri: newSessionUri ?? "",
      timeout: goawayTimeout.toString(),
    });

    // draft-ietf-moq-transport-17 Section 3.6:
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
    // pendingSubgroupStreams のバイト数を計算
    let pendingSubgroupStreamsBytes = 0;
    for (const streams of this.pendingSubgroupStreams.values()) {
      for (const stream of streams) {
        pendingSubgroupStreamsBytes += stream.data.byteLength;
      }
    }

    return {
      objectsReceivedViaFetch: this.statsObjectsReceivedViaFetch,
      objectsReceivedViaSubscribe: this.statsObjectsReceivedViaSubscribe,
      bytesReceivedViaFetch: this.statsBytesReceivedViaFetch,
      bytesReceivedViaSubscribe: this.statsBytesReceivedViaSubscribe,
      pendingSubgroupStreamsCount: this.pendingSubgroupStreams.size,
      pendingSubgroupStreamsBytes,
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
   */
  async close(): Promise<void> {
    if (this.sessionState === "closed") {
      return;
    }

    this.sessionState = "closed";

    // GOAWAY タイムアウトタイマーをクリア
    if (this.goawayTimeoutId !== null) {
      clearTimeout(this.goawayTimeoutId);
      this.goawayTimeoutId = null;
    }

    // Close all publishers, subscribers and fetchers
    // Note: We use markClosed() instead of handleEnd() because session close
    // is session-level termination (Section 3.4), not track-level PUBLISH_DONE.
    // The end callback is only for PUBLISH_DONE.
    for (const pub of this.publishers.values()) {
      pub.markClosed();
    }
    for (const sub of this.subscribers.values()) {
      sub.markClosed();
    }
    for (const fetcher of this.fetchers.values()) {
      fetcher.markClosed();
    }

    // Close all namespace subscriptions
    for (const subscription of this.namespaceSubscriptions.values()) {
      subscription.state = "closed";
    }
    this.namespaceSubscriptions.clear();

    // Close all namespace publications
    for (const publication of this.namespacePublications.values()) {
      publication.state = "closed";
    }
    this.namespacePublications.clear();

    // リクエスト双方向ストリームをクリーンアップ
    this.requestStreams.clear();

    // close コールバックはコンストラクタの transport.closed 監視で呼ばれる
  }

  // Private methods

  /**
   * セッションエラーを通知してセッションを閉じる
   *
   * draft-ietf-moq-transport-17 Section 3.5:
   * プロトコル違反等のエラーが発生した場合、セッションを閉じる必要がある。
   */
  private closeWithError(error: SessionError): void {
    this.callbacks.error?.(error);
    void this.close();
    this.transport.close({
      closeCode: error.code,
      reason: error.message,
    });
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
   * draft-ietf-moq-transport-17 Section 3.3:
   * リクエスト (SUBSCRIBE, PUBLISH, FETCH, TRACK_STATUS 等) は
   * 双方向ストリーム上で送受信される。
   * https://github.com/moq-wg/moq-transport/pull/1389
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
    if (!this.controlWriter) {
      throw new Error("Control writer not initialized");
    }

    // 双方向ストリームを開く
    const stream = await this.transport.createBidirectionalStream();
    const writer = stream.writable.getWriter();
    const controlReader = new ControlStreamReader();

    // メッセージをフレーミングして送信
    const message = this.controlWriter.encode(type, payload);
    this.statsControlMessagesSent++;
    this.emitDebug("send", type, payload, decoded);
    await writer.write(message);

    // ストリームを登録
    const streamInfo = { stream, writer, controlReader };
    this.requestStreams.set(requestId, streamInfo);

    return streamInfo;
  }

  /**
   * 双方向ストリームからレスポンスメッセージを読み取る
   *
   * draft-ietf-moq-transport-17 Section 3.3:
   * レスポンス (SUBSCRIBE_OK, PUBLISH_OK, FETCH_OK, REQUEST_OK, REQUEST_ERROR) は
   * リクエストと同じ双方向ストリーム上で送信される。
   * https://github.com/moq-wg/moq-transport/pull/1389
   *
   * @param stream - 双方向ストリーム
   * @param controlReader - メッセージパーサー
   * @returns 最初のレスポンスメッセージ
   */
  private async readResponseFromBidiStream(
    stream: WebTransportBidirectionalStream,
    controlReader: ControlStreamReader,
  ): Promise<import("./controlStream").ControlMessage> {
    const reader = stream.readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          throw new Error("bidi stream closed before receiving response");
        }
        const messages = controlReader.feed(value);
        if (messages.length > 0) {
          return messages[0];
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Send an object on a subgroup stream
   * draft-ietf-moq-transport-17 Section 2.2:
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
    const previousPromise = this.publisherSendQueues.get(trackAlias) ?? Promise.resolve();
    // 前の Promise のエラーをキャッチしてチェーンが止まらないようにする。
    // エラーが伝播すると後続の全ての .then() がスキップされ、
    // 新しいオブジェクトが送信されなくなる。
    const currentPromise = previousPromise
      .catch(() => {})
      .then(() => this.sendObjectInternal(publisher, params));
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
        }
      }

      // 新しいストリームを開く
      const stream = await this.transport.createUnidirectionalStream();
      this.statsUnidirectionalStreamsOpened++;
      publisher.incrementDataStreamCount();
      const writer = stream.getWriter();

      // Subgroup Header を書き込む
      // draft-ietf-moq-transport-17 Section 10.4.2
      // draft-ietf-moq-transport-17 Section 2.2:
      // "Objects from the same Subgroup MUST NOT be sent on different streams"
      // FirstObjectId モードを使用して、各ストリームの最初の Object ID を
      // Subgroup ID として自動的に一意にする
      const hasProperties = params.properties !== undefined && params.properties.length > 0;
      const headerType = hasProperties
        ? SubgroupHeaderType.FIRST_OBJ_EXT
        : SubgroupHeaderType.FIRST_OBJ;
      const header = encodeSubgroupHeader({
        type: headerType,
        trackAlias,
        groupId,
        publisherPriority: params.priority ?? 128,
      });
      await writer.write(header);

      streamState = { groupId, writer, previousObjectId: -1n };
      this.publisherStreams.set(trackAlias, streamState);
    }

    // Object ID Delta を計算
    // draft-ietf-moq-transport-17 Section 10.4.2:
    // "The Object ID Delta + 1 is added to the previous Object ID ...
    //  The Object ID is the Object ID Delta if it's the first Object"
    const objectIdDelta =
      streamState.previousObjectId < 0n ? objectId : objectId - streamState.previousObjectId - 1n;

    // Object fields を構築
    // draft-ietf-moq-transport-17 Section 10.4.2 Figure 29
    const hasProperties = params.properties !== undefined && params.properties.length > 0;
    const objectIdDeltaBytes = encodeVarint(objectIdDelta);
    const payloadLenBytes = encodeVarint(params.payload.length);
    const propertiesDataLength = hasProperties ? params.properties!.length : 0;
    const propertiesLengthBytes = hasProperties ? encodeVarint(propertiesDataLength) : null;

    const totalLength =
      objectIdDeltaBytes.length +
      (propertiesLengthBytes ? propertiesLengthBytes.length + propertiesDataLength : 0) +
      payloadLenBytes.length +
      params.payload.length;
    const data = new Uint8Array(totalLength);
    let offset = 0;

    data.set(objectIdDeltaBytes, offset);
    offset += objectIdDeltaBytes.length;

    if (hasProperties && propertiesLengthBytes) {
      data.set(propertiesLengthBytes, offset);
      offset += propertiesLengthBytes.length;
      data.set(params.properties!, offset);
      offset += propertiesDataLength;
    }

    data.set(payloadLenBytes, offset);
    offset += payloadLenBytes.length;
    data.set(params.payload, offset);

    await streamState.writer.write(data);

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
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error("writer.close() timed out")), 5000),
          ),
        ]);
      } catch {
        // タイムアウトまたは既にクローズされている場合は無視
      }
    }
  }

  /**
   * Send a datagram
   * draft-ietf-moq-transport-17 Section 10.3
   */
  private sendDatagram(publisher: PublisherImpl, params: SendDatagramParams): void {
    const hasProperties = params.properties !== undefined && params.properties.length > 0;
    const hasPriority = params.priority !== undefined;
    const endOfGroup = params.endOfGroup ?? false;

    // Datagram Type を決定
    // Table 5: Type bits = EndOfGroup(bit 1) | Extensions(bit 0)
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
    void writer.write(datagram).finally(() => {
      writer.releaseLock();
    });
  }

  /**
   * draft-ietf-moq-transport-17 Section 9.13:
   * PUBLISH_DONE は双方向ストリーム上で送信される。
   * Request ID フィールドはない（bidi stream で特定可能）。
   */
  private async sendPublishDone(publisher: PublisherImpl): Promise<void> {
    const requestId = publisher.getRequestId();

    // PUBLISH_DONE ペイロードをエンコード
    // draft-ietf-moq-transport-17 Section 9.13:
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

    // draft-ietf-moq-transport-17 Section 9.13:
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
   * draft-ietf-moq-transport-17 Section 3.3.1:
   * subscription のキャンセルは双方向ストリームの close で行う。
   */
  private async cancelSubscription(subscriber: SubscriberImpl): Promise<void> {
    const requestId = subscriber.getRequestId();

    // 双方向ストリームを close してリクエストをキャンセル
    const streamInfo = this.requestStreams.get(requestId);
    if (streamInfo) {
      try {
        streamInfo.writer.releaseLock();
        await streamInfo.stream.writable.close();
      } catch {
        // ストリームが既に閉じている場合は無視
      }
      this.requestStreams.delete(requestId);
    }

    this.subscribers.delete(requestId);
    this.subscribersByAlias.delete(subscriber.getTrackAlias());
  }

  /**
   * Fetch をキャンセルする
   *
   * draft-ietf-moq-transport-17 Section 5.2:
   * "It MUST send STOP_SENDING for the bidi request stream."
   */
  private async cancelFetch(fetcher: FetcherImpl): Promise<void> {
    const requestId = fetcher.getRequestId();

    // 双方向ストリームを close してリクエストをキャンセル
    const streamInfo = this.requestStreams.get(requestId);
    if (streamInfo) {
      try {
        streamInfo.writer.releaseLock();
        await streamInfo.stream.writable.close();
      } catch {
        // ストリームが既に閉じている場合は無視
      }
      this.requestStreams.delete(requestId);
    }

    this.fetchers.delete(requestId);
  }

  /**
   * Joining FETCH を送信する
   *
   * draft-ietf-moq-transport-17 Section 9.16.2:
   * Joining Fetch は SUBSCRIBE と関連付けられた FETCH で、
   * ライブデータを受信しながら過去のデータを取得する。
   */
  private async sendJoiningFetch(
    subscribeRequestId: bigint,
    options: JoiningFetchOptions,
    defaultObjectCallback: (object: MoqtObject) => void,
    largestLocation: Location,
  ): Promise<void> {
    const requestId = this.nextRequestId;
    this.nextRequestId += 2n;

    // Fetcher 実装を作成
    const impl = new FetcherImpl(
      [],
      "",
      requestId,
      options.onObject ?? defaultObjectCallback,
      options.onEnd,
      options.onError,
    );

    // draft-ietf-moq-transport-17 Section 5.2:
    // キャンセルはストリームを閉じることで行う。
    impl.onCancel = async () => {
      await this.cancelFetch(impl);
    };

    // draft-ietf-moq-transport-17 Section 9.14.2.1:
    // Relative: Start Location = {Joining Location.Group - Joining Start, 0}
    // Absolute: Start Location = {Joining Start, 0}
    // SUBSCRIBE_OK の LARGEST_OBJECT を Joining Location として推定する
    const estimatedStartLocation: Location =
      options.type === "relative"
        ? { group: largestLocation.group - options.start, object: 0n }
        : { group: options.start, object: 0n };

    // FETCH_OK を待つ Promise（Joining Fetch の場合は背景で処理）
    this.pendingFetch.set(requestId, {
      resolve: () => {
        this.fetchers.set(requestId, impl);
      },
      reject: (err) => {
        options.onError?.(err);
      },
      impl,
      startLocation: estimatedStartLocation,
    });

    // Joining FETCH メッセージを双方向ストリームで送信
    // draft-ietf-moq-transport-17 Section 9.14.2:
    // Joining FETCH も双方向ストリームで送信される。
    // https://github.com/moq-wg/moq-transport/pull/1389
    const fetchType =
      options.type === "relative" ? FetchType.RELATIVE_JOINING : FetchType.ABSOLUTE_JOINING;

    const fetchMsg = {
      type: MessageType.FETCH,
      requestId,
      // Required Request ID Delta (vi64) - draft-ietf-moq-transport-17 Section 9.2
      // 0 は依存なしを意味する
      requiredRequestIdDelta: 0n,
      fetchType,
      joining: {
        joiningRequestId: subscribeRequestId,
        joiningStart: options.start,
      },
      parameters: [],
    };

    const payload = encodeFetchPayload(fetchMsg);
    const streamInfo = await this.sendRequestOnBidiStream(requestId, MessageType.FETCH, payload, {
      requestId: requestId.toString(),
      fetchType: options.type,
      joiningRequestId: subscribeRequestId.toString(),
      joiningStart: options.start.toString(),
    });

    // 双方向ストリームからレスポンスを読み取る
    void this.readFetchResponse(requestId, streamInfo.stream, streamInfo.controlReader);
  }

  /**
   * REQUEST_UPDATE を送信する
   *
   * draft-ietf-moq-transport-17 Section 9.10:
   * REQUEST_UPDATE はリクエストと同じ双方向ストリーム上で送信する。
   *
   * REQUEST_UPDATE Message {
   *   Type (i) = 0x2,
   *   Length (16),
   *   Request ID (i),
   *   Required Request ID Delta (i),
   *   Parameters (..) ...
   * }
   */
  private async sendRequestUpdate(
    subscriber: SubscriberImpl,
    options: RequestUpdateOptions,
  ): Promise<void> {
    const updateRequestId = this.nextRequestId;
    this.nextRequestId += 2n;

    // 更新対象のリクエスト ID（bidi stream で特定するための内部管理用）
    const targetRequestId = subscriber.getRequestId();

    // パラメータを構築
    const parameters: Parameter[] = options.parameters ? [...options.parameters] : [];

    // FORWARD (0x10) - draft-ietf-moq-transport-17 Section 9.3.10
    // forward が明示的に指定された場合のみ送信（undefined の場合は変更しない）
    if (options.forward !== undefined) {
      parameters.push({
        type: VersionSpecificParameterType.FORWARD,
        value: encodeVarint(options.forward ? 1n : 0n),
      });
    }

    const requestUpdateMsg = {
      type: MessageType.REQUEST_UPDATE,
      requestId: updateRequestId,
      // Required Request ID Delta (vi64) - draft-ietf-moq-transport-17 Section 9.2
      // 0 は依存なしを意味する
      requiredRequestIdDelta: 0n,
      parameters,
    };

    const payload = encodeRequestUpdatePayload(
      requestUpdateMsg as Parameters<typeof encodeRequestUpdatePayload>[0],
    );

    // draft-ietf-moq-transport-17 Section 9.10:
    // REQUEST_UPDATE はリクエストと同じ双方向ストリーム上で送信する
    const streamInfo = this.requestStreams.get(targetRequestId);
    if (!streamInfo) {
      throw new Error(`request stream not found for request ID ${targetRequestId}`);
    }

    const promise = new Promise<void>((resolve, reject) => {
      this.pendingRequestUpdate.set(updateRequestId, {
        resolve,
        reject,
        targetRequestId,
      });
    });

    if (!this.controlWriter) {
      throw new Error("Control writer not initialized");
    }
    const message = this.controlWriter.encode(MessageType.REQUEST_UPDATE, payload);
    this.statsControlMessagesSent++;
    this.emitDebug("send", MessageType.REQUEST_UPDATE, payload, {
      requestId: updateRequestId.toString(),
      targetRequestId: targetRequestId.toString(),
    });
    await streamInfo.writer.write(message);

    return promise;
  }

  /**
   * PUBLISH リクエストの双方向ストリームからレスポンスを読み取る
   *
   * draft-ietf-moq-transport-17 Section 9.12:
   * PUBLISH_OK は双方向ストリーム上の最初のレスポンスとして送信される。
   * その後、同じストリームで REQUEST_UPDATE の応答も受信する。
   * https://github.com/moq-wg/moq-transport/pull/1389
   */
  private async readPublishResponse(
    requestId: bigint,
    stream: WebTransportBidirectionalStream,
    controlReader: ControlStreamReader,
  ): Promise<void> {
    const pending = this.pendingPublish.get(requestId);
    if (!pending) return;

    try {
      const msg = await this.readResponseFromBidiStream(stream, controlReader);
      this.emitDebug("recv", msg.type, msg.payload);

      if (msg.type === MessageType.PUBLISH_OK) {
        const decoded = decodePublishOkPayload(msg.payload);
        this.pendingPublish.delete(requestId);
        this.publishers.set(requestId, pending.impl);

        // FORWARD パラメータを処理
        // draft-ietf-moq-transport-17 Section 9.3.10
        let forwardState = true;
        for (const param of decoded.parameters) {
          if (param.type === VersionSpecificParameterType.FORWARD) {
            const forwardValue = param.value[0];
            validateForwardValue(forwardValue);
            forwardState = forwardValue !== 0;
            break;
          }
        }
        pending.impl.setForwardState(forwardState);
        pending.resolve(pending.impl);

        // PUBLISH_OK 後の継続メッセージ (PUBLISH_DONE 等) を読み取る
        // TODO: 双方向ストリームで継続メッセージを処理する
        void this.readRequestStreamMessages(requestId, stream, controlReader);
      } else if (msg.type === MessageType.REQUEST_ERROR) {
        const decoded = decodeRequestErrorPayload(msg.payload);
        this.pendingPublish.delete(requestId);
        this.requestStreams.delete(requestId);
        const error = new RequestError(
          decoded.reasonPhrase || `Request failed with code ${decoded.errorCode}`,
          Number(decoded.errorCode) as RequestErrorCode,
        );
        pending.reject(error);
      } else {
        this.pendingPublish.delete(requestId);
        this.requestStreams.delete(requestId);
        pending.reject(new Error(`unexpected response type ${msg.type} for PUBLISH request`));
      }
    } catch (error) {
      this.pendingPublish.delete(requestId);
      this.requestStreams.delete(requestId);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * SUBSCRIBE リクエストの双方向ストリームからレスポンスを読み取る
   *
   * draft-ietf-moq-transport-17 Section 9.9:
   * SUBSCRIBE_OK は双方向ストリーム上の最初のレスポンスとして送信される。
   * https://github.com/moq-wg/moq-transport/pull/1389
   */
  private async readSubscribeResponse(
    requestId: bigint,
    stream: WebTransportBidirectionalStream,
    controlReader: ControlStreamReader,
  ): Promise<void> {
    const pending = this.pendingSubscribe.get(requestId);
    if (!pending) return;

    try {
      const msg = await this.readResponseFromBidiStream(stream, controlReader);
      this.emitDebug("recv", msg.type, msg.payload);

      if (msg.type === MessageType.SUBSCRIBE_OK) {
        const decoded = decodeSubscribeOkPayload(msg.payload);

        // LARGEST_OBJECT パラメータを探す
        let largestLocation: Location | undefined;
        for (const param of decoded.parameters) {
          if (param.type === VersionSpecificParameterType.LARGEST_OBJECT) {
            largestLocation = getParameterLocationValue(param);
            break;
          }
        }

        this.pendingSubscribe.delete(requestId);

        // draft-ietf-moq-transport-17 Section 9.9:
        // "If a subscriber receives a SUBSCRIBE_OK that uses the same Track Alias
        //  as a different track with an Established subscription, it MUST close
        //  the session with error DUPLICATE_TRACK_ALIAS."
        const existingSubscriber = this.subscribersByAlias.get(decoded.trackAlias);
        if (existingSubscriber && existingSubscriber !== pending.impl) {
          const error = new SessionError(
            `duplicate track alias: ${decoded.trackAlias}`,
            SessionErrorCode.DUPLICATE_TRACK_ALIAS,
          );
          pending.reject(error);
          this.closeWithError(error);
          return;
        }

        // Track Alias を設定
        pending.impl.setTrackAlias(decoded.trackAlias);

        // LARGEST_OBJECT を設定
        if (largestLocation) {
          pending.impl.setLargestLocation(largestLocation);
        }

        // Track Properties を設定
        if (decoded.trackProperties.length > 0) {
          pending.impl.setTrackProperties(decoded.trackProperties);
        }

        this.subscribers.set(requestId, pending.impl);
        this.subscribersByAlias.set(decoded.trackAlias, pending.impl);

        // バッファリングされた Subgroup ストリームを処理
        const pendingStreams = this.pendingSubgroupStreams.get(decoded.trackAlias);
        if (pendingStreams && pendingStreams.length > 0) {
          this.pendingSubgroupStreams.delete(decoded.trackAlias);
          for (const pendingStream of pendingStreams) {
            this.processPendingSubgroupStream(
              pending.impl,
              pendingStream.header,
              pendingStream.data,
            );
          }
        }

        // Subscriber 登録待ちのストリームに通知
        const readyCallbacks = this.subscriberReadyCallbacks.get(decoded.trackAlias);
        if (readyCallbacks) {
          this.subscriberReadyCallbacks.delete(decoded.trackAlias);
          for (const callback of readyCallbacks) {
            callback();
          }
        }

        // Joining Fetch が指定されている場合は送信
        if (pending.joiningFetch) {
          if (largestLocation) {
            void this.sendJoiningFetch(
              requestId,
              pending.joiningFetch,
              pending.objectCallback,
              largestLocation,
            );
          } else {
            // draft-ietf-moq-transport-17 Section 9.14.2:
            // まだオブジェクトが発行されていない場合、Joining Fetch は送信しない。
            // onEnd を呼んでスキップされたことを通知する。
            pending.joiningFetch.onEnd?.();
          }
        }

        pending.resolve(pending.impl);

        // SUBSCRIBE_OK 後の継続メッセージ (PUBLISH_DONE 等) を読み取る
        void this.readRequestStreamMessages(requestId, stream, controlReader);
      } else if (msg.type === MessageType.REQUEST_ERROR) {
        const decoded = decodeRequestErrorPayload(msg.payload);
        this.pendingSubscribe.delete(requestId);
        this.requestStreams.delete(requestId);
        const error = new RequestError(
          decoded.reasonPhrase || `Request failed with code ${decoded.errorCode}`,
          Number(decoded.errorCode) as RequestErrorCode,
        );
        pending.reject(error);
      } else {
        this.pendingSubscribe.delete(requestId);
        this.requestStreams.delete(requestId);
        pending.reject(new Error(`unexpected response type ${msg.type} for SUBSCRIBE request`));
      }
    } catch (error) {
      this.pendingSubscribe.delete(requestId);
      this.requestStreams.delete(requestId);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * FETCH リクエストの双方向ストリームからレスポンスを読み取る
   *
   * draft-ietf-moq-transport-17 Section 9.15:
   * FETCH_OK は双方向ストリーム上の最初のレスポンスとして送信される。
   * https://github.com/moq-wg/moq-transport/pull/1389
   */
  private async readFetchResponse(
    requestId: bigint,
    stream: WebTransportBidirectionalStream,
    controlReader: ControlStreamReader,
  ): Promise<void> {
    const pending = this.pendingFetch.get(requestId);
    if (!pending) return;

    try {
      const msg = await this.readResponseFromBidiStream(stream, controlReader);
      this.emitDebug("recv", msg.type, msg.payload);

      if (msg.type === MessageType.FETCH_OK) {
        const decoded = decodeFetchOkPayload(msg.payload);

        // draft-ietf-moq-transport-17 Section 9.15:
        // "If End Location is smaller than the Start Location in the
        //  corresponding FETCH the receiver MUST close the session with
        //  a PROTOCOL_VIOLATION."
        if (pending.startLocation) {
          const endLoc = decoded.endLocation;
          const startLoc = pending.startLocation;
          if (
            endLoc.group < startLoc.group ||
            (endLoc.group === startLoc.group && endLoc.object < startLoc.object)
          ) {
            const error = new SessionError(
              `FETCH_OK end location (${endLoc.group}:${endLoc.object}) is smaller than start location (${startLoc.group}:${startLoc.object})`,
              SessionErrorCode.PROTOCOL_VIOLATION,
            );
            this.pendingFetch.delete(requestId);
            pending.reject(error);
            this.closeWithError(error);
            return;
          }
        }

        this.pendingFetch.delete(requestId);
        pending.impl.setFetchOkInfo(
          decoded.endOfTrack,
          decoded.endLocation,
          decoded.trackProperties,
        );
        this.fetchers.set(requestId, pending.impl);
        pending.resolve(pending.impl);

        // FETCH_OK 後のストリームは不要（データは別の単方向ストリームで届く）
      } else if (msg.type === MessageType.REQUEST_ERROR) {
        const decoded = decodeRequestErrorPayload(msg.payload);
        this.pendingFetch.delete(requestId);
        this.requestStreams.delete(requestId);
        const error = new RequestError(
          decoded.reasonPhrase || `Request failed with code ${decoded.errorCode}`,
          Number(decoded.errorCode) as RequestErrorCode,
        );
        pending.reject(error);
      } else {
        this.pendingFetch.delete(requestId);
        this.requestStreams.delete(requestId);
        pending.reject(new Error(`unexpected response type ${msg.type} for FETCH request`));
      }
    } catch (error) {
      this.pendingFetch.delete(requestId);
      this.requestStreams.delete(requestId);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * TRACK_STATUS リクエストの双方向ストリームからレスポンスを読み取る
   *
   * draft-ietf-moq-transport-17 Section 9.16:
   * TRACK_STATUS へのレスポンスは REQUEST_OK で返される。
   * https://github.com/moq-wg/moq-transport/pull/1389
   */
  private async readTrackStatusResponse(
    requestId: bigint,
    stream: WebTransportBidirectionalStream,
    controlReader: ControlStreamReader,
  ): Promise<void> {
    const pending = this.pendingTrackStatus.get(requestId);
    if (!pending) return;

    try {
      const msg = await this.readResponseFromBidiStream(stream, controlReader);
      this.emitDebug("recv", msg.type, msg.payload);

      if (msg.type === MessageType.REQUEST_OK) {
        const decoded = decodeRequestOkPayload(msg.payload);
        this.pendingTrackStatus.delete(requestId);
        this.requestStreams.delete(requestId);
        pending.resolve({ parameters: decoded.parameters });
      } else if (msg.type === MessageType.REQUEST_ERROR) {
        const decoded = decodeRequestErrorPayload(msg.payload);
        this.pendingTrackStatus.delete(requestId);
        this.requestStreams.delete(requestId);
        const error = new RequestError(
          decoded.reasonPhrase || `Request failed with code ${decoded.errorCode}`,
          Number(decoded.errorCode) as RequestErrorCode,
        );
        pending.reject(error);
      } else {
        this.pendingTrackStatus.delete(requestId);
        this.requestStreams.delete(requestId);
        pending.reject(new Error(`unexpected response type ${msg.type} for TRACK_STATUS request`));
      }
    } catch (error) {
      this.pendingTrackStatus.delete(requestId);
      this.requestStreams.delete(requestId);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * リクエスト双方向ストリームの継続メッセージを読み取る
   *
   * draft-ietf-moq-transport-17 Section 5.1:
   * 確立されたサブスクリプションでは、PUBLISH_DONE、REQUEST_UPDATE 応答等の
   * 継続メッセージが同じ双方向ストリーム上で送受信される。
   * https://github.com/moq-wg/moq-transport/pull/1389
   */
  private async readRequestStreamMessages(
    requestId: bigint,
    stream: WebTransportBidirectionalStream,
    controlReader: ControlStreamReader,
  ): Promise<void> {
    const reader = stream.readable.getReader();
    try {
      while (this.sessionState === "connected") {
        const { value, done } = await reader.read();
        if (done) break;

        const messages = controlReader.feed(value);
        for (const msg of messages) {
          this.emitDebug("recv", msg.type, msg.payload);

          switch (msg.type) {
            case MessageType.PUBLISH_DONE: {
              this.handlePublishDone(msg.payload, requestId);
              break;
            }
            case MessageType.REQUEST_OK: {
              // REQUEST_UPDATE への応答
              // draft-ietf-moq-transport-17 Section 9.10.1:
              // REQUEST_OK には LARGEST_OBJECT パラメータが含まれる可能性がある。
              // Subscriber の largestLocation を更新する。
              this.handleRequestUpdateOk(msg.payload, requestId);
              break;
            }
            case MessageType.REQUEST_ERROR: {
              // REQUEST_UPDATE への応答 (エラー)
              const decoded = decodeRequestErrorPayload(msg.payload);
              const error = new RequestError(
                decoded.reasonPhrase || `Request failed with code ${decoded.errorCode}`,
                Number(decoded.errorCode) as RequestErrorCode,
              );
              // 保留中の REQUEST_UPDATE にエラーを通知
              for (const [updateId, pendingUpdate] of this.pendingRequestUpdate) {
                if (pendingUpdate.targetRequestId === requestId) {
                  this.pendingRequestUpdate.delete(updateId);
                  pendingUpdate.reject(error);
                  break;
                }
              }
              break;
            }
            default:
              // draft-ietf-moq-transport-17 Section 9:
              // "An endpoint that receives an unknown message type MUST close the session."
              this.closeWithError(
                new SessionError(
                  `unknown request stream message type: 0x${msg.type.toString(16)}`,
                  SessionErrorCode.PROTOCOL_VIOLATION,
                ),
              );
              return;
          }
        }
      }
    } catch {
      // ストリームが閉じられた場合は無視
    } finally {
      reader.releaseLock();
      this.requestStreams.delete(requestId);
    }
  }

  private startControlMessageLoop(): void {
    void (async () => {
      if (!this.controlReceiveStream || !this.controlReader) return;

      const reader = this.controlReceiveStream.getReader();

      try {
        while (this.sessionState === "connected") {
          const { value, done } = await reader.read();
          if (done) {
            // draft-ietf-moq-transport-17 Section 3.3:
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
        if (this.sessionState === "connected") {
          this.callbacks.error?.(err as Error);
        }
      } finally {
        reader.releaseLock();
      }
    })();
  }

  /**
   * 制御ストリーム上のメッセージを処理する
   *
   * draft-ietf-moq-transport-17 Section 3.3:
   * リクエスト/レスポンス (SUBSCRIBE_OK, PUBLISH_OK, FETCH_OK, REQUEST_OK,
   * REQUEST_ERROR) は双方向ストリームに移動した。
   * 制御ストリームに残るのは GOAWAY, PUBLISH_DONE, PUBLISH_NAMESPACE 等。
   * https://github.com/moq-wg/moq-transport/pull/1389
   */
  private handleControlMessage(type: number, payload: Uint8Array): void {
    this.statsControlMessagesReceived++;
    let decoded: Record<string, unknown> | undefined;

    switch (type) {
      case MessageType.PUBLISH_DONE:
        decoded = this.handlePublishDone(payload);
        break;
      case MessageType.REQUEST_OK:
        // PUBLISH_NAMESPACE への応答（制御ストリーム上で受信）
        decoded = this.handleRequestOk(payload);
        break;
      case MessageType.REQUEST_ERROR:
        // PUBLISH_NAMESPACE への応答（制御ストリーム上で受信）
        decoded = this.handleControlStreamRequestError(payload);
        break;
      case MessageType.GOAWAY:
        decoded = this.handleGoaway(payload);
        break;
      case MessageType.PUBLISH_NAMESPACE:
        decoded = this.handlePublishNamespace(payload);
        break;
      default:
        // draft-ietf-moq-transport-17 Section 9:
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
   * draft-ietf-moq-transport-17 Section 9.13:
   * PUBLISH_DONE は双方向ストリーム上で送信される。
   * Request ID はペイロードに含まれず、ストリームのコンテキストから取得する。
   */
  private handlePublishDone(payload: Uint8Array, requestId?: bigint): Record<string, unknown> {
    const msg = decodePublishDonePayload(payload);

    if (requestId !== undefined) {
      const subscriber = this.subscribers.get(requestId);
      if (subscriber) {
        subscriber.handleEnd(msg.statusCode, msg.reasonPhrase);
        this.subscribers.delete(requestId);
        this.subscribersByAlias.delete(subscriber.getTrackAlias());
      }
    }

    return {
      requestId: requestId?.toString() ?? "unknown",
      statusCode: msg.statusCode,
      streamCount: msg.streamCount.toString(),
      reasonPhrase: msg.reasonPhrase,
    };
  }

  /**
   * 制御ストリーム上の REQUEST_ERROR を処理する
   *
   * draft-ietf-moq-transport-17 Section 9.7:
   * REQUEST_ERROR は通常、双方向ストリーム上で送信される。
   * 制御ストリームで受信する場合は PUBLISH_NAMESPACE への応答のみ。
   * https://github.com/moq-wg/moq-transport/pull/1499
   */
  private handleControlStreamRequestError(payload: Uint8Array): Record<string, unknown> {
    const decoded = decodeRequestErrorPayload(payload);

    const error = new RequestError(
      decoded.reasonPhrase || `Request failed with code ${decoded.errorCode}`,
      Number(decoded.errorCode) as RequestErrorCode,
    );

    // PUBLISH_NAMESPACE の応答
    for (const [requestId, pendingNamespacePubReq] of this.pendingNamespacePublish) {
      this.pendingNamespacePublish.delete(requestId);
      pendingNamespacePubReq.reject(error);
    }

    return {
      errorCode: Number(decoded.errorCode),
      retryInterval: decoded.retryInterval.toString(),
      reason: decoded.reasonPhrase,
    };
  }

  /**
   * 双方向ストリーム上の REQUEST_UPDATE への REQUEST_OK を処理する
   *
   * draft-ietf-moq-transport-17 Section 9.10.1:
   * REQUEST_OK には LARGEST_OBJECT パラメータが含まれる可能性がある。
   * Subscriber の largestLocation を更新する。
   */
  private handleRequestUpdateOk(payload: Uint8Array, streamRequestId: bigint): void {
    const msg = decodeRequestOkPayload(payload);

    // LARGEST_OBJECT パラメータを探す
    for (const param of msg.parameters) {
      if (param.type === VersionSpecificParameterType.LARGEST_OBJECT) {
        const location = getParameterLocationValue(param);
        // 対応する Subscriber の largestLocation を更新
        const subscriber = this.subscribers.get(streamRequestId);
        if (subscriber) {
          subscriber.setLargestLocation(location);
        }
        break;
      }
    }

    // 保留中の REQUEST_UPDATE を resolve する
    for (const [updateId, pendingUpdate] of this.pendingRequestUpdate) {
      if (pendingUpdate.targetRequestId === streamRequestId) {
        this.pendingRequestUpdate.delete(updateId);
        pendingUpdate.resolve();
        break;
      }
    }
  }

  /**
   * 制御ストリーム上の REQUEST_OK を処理する
   *
   * draft-ietf-moq-transport-17 Section 9.6:
   * REQUEST_OK は通常、双方向ストリーム上で送信される。
   * 制御ストリームで受信する場合は PUBLISH_NAMESPACE への応答のみ。
   * https://github.com/moq-wg/moq-transport/pull/1499
   */
  private handleRequestOk(payload: Uint8Array): Record<string, unknown> {
    const msg = decodeRequestOkPayload(payload);

    // PUBLISH_NAMESPACE の応答
    for (const [requestId, pendingNamespacePub] of this.pendingNamespacePublish) {
      this.pendingNamespacePublish.delete(requestId);

      // アクティブな公開として登録
      this.namespacePublications.set(requestId, {
        callbacks: pendingNamespacePub.callbacks,
        state: "active",
        namespace: pendingNamespacePub.namespace,
      });

      // NamespacePublication を作成
      const publication = this.createNamespacePublication(requestId);

      pendingNamespacePub.resolve(publication);
    }

    return {
      parametersCount: msg.parameters.length,
    };
  }

  /**
   * Handle GOAWAY message
   *
   * draft-ietf-moq-transport-17 Section 9.4:
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

    // GOAWAY コールバックを呼び出す
    this.callbacks.goaway?.(msg.newSessionUri);

    return {
      newSessionUri: msg.newSessionUri,
      timeout: msg.timeout.toString(),
    };
  }

  /**
   * Handle PUBLISH_NAMESPACE message
   *
   * draft-ietf-moq-transport-17 Section 9.20:
   * PUBLISH_NAMESPACE notifies that a Track Namespace has tracks available.
   */
  private handlePublishNamespace(payload: Uint8Array): Record<string, unknown> {
    const msg = decodePublishNamespacePayload(payload);
    const namespaceStrings = trackNamespaceToStrings(msg.trackNamespace);

    // Request ID で対応する NamespaceSubscription を検索
    const subscription = this.namespaceSubscriptions.get(msg.requestId);
    if (subscription && subscription.state === "active") {
      // コールバックを呼び出す
      const announcement: NamespaceAnnouncement = {
        namespace: namespaceStrings,
        parameters: msg.parameters,
      };
      subscription.callbacks.announce?.(announcement);
    }

    return {
      requestId: msg.requestId.toString(),
      trackNamespace: namespaceStrings,
      parametersCount: msg.parameters.length,
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
   * draft-ietf-moq-transport-17 Section 6.1:
   * A SUBSCRIBE_NAMESPACE can be cancelled by closing the stream with
   * either a FIN or RESET_STREAM.
   * https://www.ietf.org/archive/id/draft-ietf-moq-transport-17.html#section-6.1
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
   * NamespacePublication オブジェクトを作成する
   */
  private createNamespacePublication(requestId: bigint): NamespacePublication {
    const getState = (): "active" | "closed" => {
      const pub = this.namespacePublications.get(requestId);
      return pub?.state ?? "closed";
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
   * draft-ietf-moq-transport-17:
   * PUBLISH_NAMESPACE_DONE メッセージは廃止された。
   * Namespace 公開の終了は内部状態のクリーンアップのみで行う。
   */
  private async closeNamespacePublication(requestId: bigint): Promise<void> {
    const publication = this.namespacePublications.get(requestId);
    if (!publication || publication.state === "closed") {
      return;
    }

    publication.state = "closed";
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
        if (this.sessionState === "connected") {
          this.callbacks.error?.(err as Error);
        }
      } finally {
        reader.releaseLock();
      }
    })();
  }

  /**
   * Start datagram receiving loop
   * draft-ietf-moq-transport-17 Section 10.3
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
        if (this.sessionState === "connected") {
          this.callbacks.error?.(err as Error);
        }
      } finally {
        reader.releaseLock();
      }
    })();
  }

  /**
   * Handle incoming datagram
   * draft-ietf-moq-transport-17 Section 10.3
   */
  private handleIncomingDatagram(data: Uint8Array): void {
    try {
      const [datagram] = decodeObjectDatagram(data);

      // Track Alias で Subscriber を検索
      const subscriber = this.subscribersByAlias.get(datagram.trackAlias);
      if (!subscriber) {
        return;
      }

      // Datagram コールバックがあれば呼び出す
      if (subscriber.hasDatagramCallback()) {
        const object: MoqtObject = {
          groupId: datagram.groupId,
          subgroupId: undefined,
          objectId: datagram.objectId,
          publisherPriority: datagram.publisherPriority,
          status: datagram.status ?? ObjectStatus.NORMAL,
          properties: datagram.properties,
          payload: datagram.payload ?? new Uint8Array(0),
        };
        subscriber.handleDatagram(object);
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
    }
  }

  /**
   * Subscriber の登録を待つ
   *
   * SUBSCRIBE_OK より先にデータストリームが到着した場合に使用。
   * subscriberReadyCallbacks とポーリングの両方で待機し、
   * レースコンディションを防ぐ。
   */
  private waitForSubscriber(trackAlias: bigint): Promise<SubscriberImpl | null> {
    return new Promise<SubscriberImpl | null>((resolve) => {
      // 既に登録されている場合は即座に返す
      const existing = this.subscribersByAlias.get(trackAlias);
      if (existing) {
        resolve(existing);
        return;
      }

      // コールバックを登録
      const callbacks = this.subscriberReadyCallbacks.get(trackAlias) ?? [];
      callbacks.push(() => {
        resolve(this.subscribersByAlias.get(trackAlias) ?? null);
      });
      this.subscriberReadyCallbacks.set(trackAlias, callbacks);

      // タイムアウト: 5 秒以内に登録されなければ null
      setTimeout(() => {
        resolve(this.subscribersByAlias.get(trackAlias) ?? null);
      }, 5000);
    });
  }

  /**
   * Handle incoming unidirectional data stream
   * draft-ietf-moq-transport-17 Section 10.4
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

    // Subgroup ストリーム用の状態
    let subgroupHeader: import("./dataStream").SubgroupHeader | null = null;
    let subscriber: SubscriberImpl | null = null;
    let previousObjectId = -1n;

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
              // Fetch Data Stream
              isFetchStream = true;
              const [header, consumed] = decodeFetchHeader(buffer);
              fetchHeader = header;
              buffer = buffer.slice(consumed);
              headerParsed = true;

              // 統計カウンターを更新
              this.statsFetchHeadersReceived++;

              // Fetcher を検索
              fetcher = this.fetchers.get(header.requestId) ?? null;
              if (!fetcher) {
                // Fetcher が見つからない場合は終了
                break;
              }
            } else if (
              (streamTypeNum >= 0x10 && streamTypeNum <= 0x1f) ||
              (streamTypeNum >= 0x30 && streamTypeNum <= 0x3f)
            ) {
              // Subgroup ストリーム
              isFetchStream = false;
              const [header, consumed] = decodeSubgroupHeader(buffer);
              subgroupHeader = header;
              buffer = buffer.slice(consumed);
              headerParsed = true;

              // 統計カウンターを更新
              this.statsSubgroupHeadersReceived++;

              // Subscriber を検索
              subscriber = this.subscribersByAlias.get(header.trackAlias) ?? null;
              if (!subscriber) {
                // Subscriber がまだ登録されていない場合、登録を待つ
                // QUIC ではストリーム間の順序が保証されないため、
                // SUBSCRIBE_OK より先にデータストリームが到着する可能性がある
                subscriber = await this.waitForSubscriber(header.trackAlias);
                if (!subscriber) {
                  break;
                }
              }
            } else {
              // draft-ietf-moq-transport-17 Section 3.2:
              // "An endpoint that receives an unknown stream type MUST close the session."
              this.closeWithError(
                new SessionError(
                  `unknown unidirectional stream type: 0x${streamTypeNum.toString(16)}`,
                  SessionErrorCode.PROTOCOL_VIOLATION,
                ),
              );
              break;
            }
          } catch {
            // ヘッダーのパースに失敗した場合、データが不足している可能性
            // 次のチャンクを待つ
            if (done) break;
            continue;
          }
        }

        // オブジェクトをパースして配信
        if (headerParsed) {
          if (isFetchStream && fetcher && fetchHeader) {
            // Fetch オブジェクトをストリーミング処理
            buffer = this.processFetchObjects(buffer, fetcher, fetchContext, isFirstFetchObject);
            // 状態を更新 (最初のオブジェクトが処理されたかどうか)
            if (buffer !== null) {
              isFirstFetchObject = false;
            }
          } else if (!isFetchStream && subscriber && subgroupHeader) {
            // Subgroup オブジェクトをストリーミング処理
            const result = this.processSubgroupObjects(
              buffer,
              subscriber,
              subgroupHeader,
              previousObjectId,
            );
            buffer = result.remainingBuffer;
            previousObjectId = result.previousObjectId;
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
  ): Uint8Array {
    let offset = 0;
    let currentContext = context;
    let currentIsFirst = isFirst;

    while (offset < buffer.length) {
      try {
        const [fields, fieldsConsumed, newContext] = decodeFetchObjectFields(
          buffer,
          currentContext,
          offset,
          currentIsFirst,
        );

        // ペイロード長を確認
        const payloadLength = Number(fields.payloadLength);
        const totalNeeded = offset + fieldsConsumed + payloadLength;

        if (totalNeeded > buffer.length) {
          // ペイロードが不完全 - 次のチャンクを待つ
          break;
        }

        offset += fieldsConsumed;

        // ペイロードを抽出
        const payload = buffer.slice(offset, offset + payloadLength);
        offset += payloadLength;

        // 状態を更新
        currentContext = newContext;
        currentIsFirst = false;

        // draft-ietf-moq-transport-17 Section 10.2.1.1:
        // Fetch Object には Object Status が存在しないため NORMAL として扱う
        const object: MoqtObject = {
          groupId: fields.groupId,
          subgroupId: fields.subgroupId,
          objectId: fields.objectId,
          publisherPriority: fields.publisherPriority,
          status: ObjectStatus.NORMAL,
          properties:
            fields.properties && fields.properties.length > 0 ? fields.properties : undefined,
          payload,
        };

        // 統計カウンターを更新
        this.statsObjectsReceivedViaFetch++;
        this.statsBytesReceivedViaFetch += payload.byteLength;

        fetcher.handleObject(object);
      } catch {
        // パースに失敗 - データが不足している可能性
        break;
      }
    }

    // 残りのバッファを返す
    return buffer.slice(offset);
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
    let offset = 0;
    let currentPreviousObjectId = previousObjectId;
    // draft-ietf-moq-transport-17 Section 10.4.2:
    // Subgroup ID = First Object ID の場合、最初のオブジェクトの Object ID を
    // Subgroup ID として使用する
    let resolvedSubgroupId = header.subgroupId;

    while (offset < buffer.length) {
      try {
        const [fields, fieldsConsumed] = decodeObjectFields(buffer, header.type, offset);

        // ペイロード長を確認
        const payloadLength = Number(fields.payloadLength);
        const totalNeeded = offset + fieldsConsumed + payloadLength;

        if (totalNeeded > buffer.length) {
          // ペイロードが不完全 - 次のチャンクを待つ
          break;
        }

        offset += fieldsConsumed;

        // Object ID を計算
        let objectId: bigint;
        if (currentPreviousObjectId < 0n) {
          objectId = fields.objectIdDelta;
        } else {
          objectId = currentPreviousObjectId + fields.objectIdDelta + 1n;
        }
        currentPreviousObjectId = objectId;

        // FirstObjectId モードの場合、最初のオブジェクトの ID を Subgroup ID に設定
        if (resolvedSubgroupId === undefined) {
          resolvedSubgroupId = objectId;
        }

        // ペイロードを抽出
        const payload = buffer.slice(offset, offset + payloadLength);
        offset += payloadLength;

        const object: MoqtObject = {
          groupId: header.groupId,
          subgroupId: resolvedSubgroupId,
          objectId,
          publisherPriority: header.publisherPriority,
          status: fields.status,
          properties: fields.properties.length > 0 ? fields.properties : undefined,
          payload,
        };

        // 統計カウンターを更新
        this.statsObjectsReceivedViaSubscribe++;
        this.statsBytesReceivedViaSubscribe += payload.byteLength;

        subscriber.handleObject(object);
      } catch {
        // パースに失敗 - データが不足している可能性
        break;
      }
    }

    return {
      remainingBuffer: buffer.slice(offset),
      previousObjectId: currentPreviousObjectId,
    };
  }

  /**
   * バッファリングされた Subgroup ストリームを処理
   * SUBSCRIBE_OK より先にデータストリームが到着した場合に使用
   */
  private processPendingSubgroupStream(
    subscriber: SubscriberImpl,
    header: import("./dataStream").SubgroupHeader,
    data: Uint8Array,
  ): void {
    let previousObjectId = -1n;
    let buffer = data;
    // draft-ietf-moq-transport-17 Section 10.4.2:
    // Subgroup ID = First Object ID の場合、最初のオブジェクトの Object ID を
    // Subgroup ID として使用する
    let resolvedSubgroupId = header.subgroupId;

    while (buffer.length > 0) {
      try {
        const [fields, fieldsConsumed] = decodeObjectFields(buffer, header.type, 0);

        const payloadLength = Number(fields.payloadLength);
        const totalNeeded = fieldsConsumed + payloadLength;

        if (totalNeeded > buffer.length) {
          // ペイロードが不完全
          break;
        }

        // Object ID を計算
        let objectId: bigint;
        if (previousObjectId < 0n) {
          objectId = fields.objectIdDelta;
        } else {
          objectId = previousObjectId + fields.objectIdDelta + 1n;
        }
        previousObjectId = objectId;

        // FirstObjectId モードの場合、最初のオブジェクトの ID を Subgroup ID に設定
        if (resolvedSubgroupId === undefined) {
          resolvedSubgroupId = objectId;
        }

        // ペイロードを抽出
        const payload = buffer.slice(fieldsConsumed, fieldsConsumed + payloadLength);
        buffer = buffer.slice(totalNeeded);

        const object: MoqtObject = {
          groupId: header.groupId,
          subgroupId: resolvedSubgroupId,
          objectId,
          publisherPriority: header.publisherPriority,
          status: fields.status,
          properties: fields.properties.length > 0 ? fields.properties : undefined,
          payload,
        };

        // 統計カウンターを更新
        this.statsObjectsReceivedViaSubscribe++;
        this.statsBytesReceivedViaSubscribe += payload.byteLength;

        subscriber.handleObject(object);
      } catch {
        // パースに失敗
        break;
      }
    }
  }
}
