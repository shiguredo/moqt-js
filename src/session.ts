/**
 * MOQT Session
 * draft-ietf-moq-transport-16 Section 3
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
  createTrackNamespace,
  encodeTrackName,
  trackNamespaceToStrings,
  decodeFetchOkPayload,
  decodeGoawayPayload,
  decodeMaxRequestIdPayload,
  decodePublishDonePayload,
  decodePublishNamespaceCancelPayload,
  decodePublishNamespacePayload,
  decodePublishOkPayload,
  decodeRequestOkPayload,
  decodeRequestsBlockedPayload,
  decodeServerSetupPayload,
  decodeSubscribeOkPayload,
  encodeClientSetupPayload,
  encodeFetchCancelPayload,
  encodeFetchPayload,
  encodeGoawayPayload,
  encodePublishNamespaceDonePayload,
  encodePublishNamespacePayload,
  encodePublishPayload,
  encodeSubscribeNamespacePayload,
  encodeSubscribePayload,
  encodeRequestUpdatePayload,
  encodeTrackStatusPayload,
  encodeUnsubscribeNamespacePayload,
  encodeUnsubscribePayload,
  createClientSetup,
  getMessageTypeName,
  getSetupMaxRequestId,
  getParameterLocationValue,
  encodeSubscriptionFilterParameter,
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
import { TrackExtensionHeaderId, type ExtensionHeader } from "./extensions";

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
  /** Message type name (e.g., "CLIENT_SETUP", "SUBSCRIBE") */
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
  close?: () => void;
  error?: (error: Error) => void;
  /** Debug callback for logging MOQT protocol messages */
  debug?: (message: DebugMessage) => void;
  /**
   * GOAWAY 受信時のコールバック
   * draft-ietf-moq-transport-16 Section 9.4
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
   * draft-ietf-moq-transport-16 Section 9.2.2.8
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
   * draft-ietf-moq-transport-16 Section 11.1.1
   *
   * Relay がオブジェクトをキャッシュして良い最大時間を指定する。
   * 0 を指定するとキャッシュを無効にする。
   */
  maxCacheDuration?: bigint;

  /**
   * Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-16 Section 9.2.2.2
   *
   * オブジェクトを受信してから配信を試みる最大時間。
   * Publisher と Subscriber の両方が指定した場合、小さい方の値が使用される。
   * タイムアウトを超過したオブジェクトは配信されない。
   */
  deliveryTimeout?: bigint;

  /**
   * Publisher Priority（0-255）
   * draft-ietf-moq-transport-16 Section 11.1.1.1
   *
   * パブリッシュの優先度。小さい値ほど高優先度。
   * 指定しない場合は 128（デフォルト）
   */
  publisherPriority?: number;

  /**
   * Group Order
   * draft-ietf-moq-transport-16 Section 9.2.2.4
   *
   * グループの配信順序。
   * - "Ascending": 古いグループから順に配信
   * - "Descending": 新しいグループから順に配信
   */
  groupOrder?: "Ascending" | "Descending";

  /**
   * Dynamic Groups サポートの通知
   * draft-ietf-moq-transport-16 Section 11.1.1.3
   *
   * true を設定すると、Subscriber が NEW_GROUP_REQUEST パラメータで
   * 新しいグループの生成を要求できることを通知する。
   */
  dynamicGroups?: boolean;

  /**
   * Expires（ミリ秒）
   * draft-ietf-moq-transport-16 Section 9.2.2.6
   *
   * パブリッシュが自動終了するまでの時間（ミリ秒）。
   * 0 または未指定の場合は期限なし。
   */
  expires?: bigint;

  /**
   * Forward State
   * draft-ietf-moq-transport-16 Section 9.2.2.8
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
   * draft-ietf-moq-transport-16 Section 10.3
   *
   * 注意: Datagram は信頼性がなく、順序も保証されない
   */
  datagram?: (object: MoqtObject) => void;
  end?: () => void;
  error?: (error: Error) => void;
}

/**
 * Joining Fetch オプション
 * draft-ietf-moq-transport-16 Section 9.16.2
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
   * draft-ietf-moq-transport-16 Section 5.1.2, Section 9.2.2.5
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
   * draft-ietf-moq-transport-16 Section 9.2.2.2
   *
   * オブジェクトを受信してから配信を試みる最大時間。
   * Publisher と Subscriber の両方が指定した場合、小さい方の値が使用される。
   * タイムアウトを超過したオブジェクトは配信されない。
   */
  deliveryTimeout?: bigint;

  /**
   * Subscriber Priority（0-255）
   * draft-ietf-moq-transport-16 Section 9.2.2.3
   *
   * サブスクリプションの優先度。小さい値ほど高優先度。
   * 指定しない場合は 128（デフォルト）
   */
  subscriberPriority?: number;

  /**
   * Group Order
   * draft-ietf-moq-transport-16 Section 9.2.2.4
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
   * draft-ietf-moq-transport-16 Section 9.2.2.9
   *
   * 0 を指定すると、Publisher は新しい Group を開始する
   * Publisher が DYNAMIC_GROUPS をサポートしていない場合は無視される
   */
  newGroupRequest?: bigint;

  /**
   * Joining Fetch オプション
   * draft-ietf-moq-transport-16 Section 9.16.2
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
   * draft-ietf-moq-transport-16 Section 9.2.2.8
   *
   * オブジェクトの転送状態を指定する。
   * - true (1): オブジェクトを転送する（デフォルト）
   * - false (0): オブジェクトを転送しない
   *
   * 省略した場合は 1（転送する）がデフォルト。
   */
  forward?: boolean;
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
 * draft-ietf-moq-transport-16 Section 9.19
 */
export interface TrackStatusResult {
  /**
   * 応答パラメータ（SUBSCRIBE_OK と同様）
   */
  parameters: Parameter[];
}

/**
 * Namespace 公開通知
 * draft-ietf-moq-transport-16 Section 9.20
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
 */
export interface NamespaceSubscriptionCallbacks {
  /**
   * PUBLISH_NAMESPACE を受信したときに呼ばれる
   */
  announce: (announcement: NamespaceAnnouncement) => void;
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
 * draft-ietf-moq-transport-16 Section 9.20-9.22
 */
export interface NamespacePublicationCallbacks {
  /**
   * PUBLISH_NAMESPACE_CANCEL を受信したときに呼ばれる
   * draft-ietf-moq-transport-16 Section 9.22
   */
  cancelled?: (errorCode: bigint, reasonPhrase: string) => void;
  /**
   * エラー時のコールバック
   */
  error?: (error: Error) => void;
}

/**
 * Namespace 公開
 * draft-ietf-moq-transport-16 Section 9.20-9.21
 */
export interface NamespacePublication {
  readonly state: "active" | "cancelled" | "closed";
  /**
   * 公開している Namespace
   */
  readonly namespace: string[];
  /**
   * 公開を終了する（PUBLISH_NAMESPACE_DONE を送信）
   * draft-ietf-moq-transport-16 Section 9.21
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
   * draft-ietf-moq-transport-16 Section 9.4
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
   * draft-ietf-moq-transport-16 Section 9.16
   */
  fetch(
    namespace: string[],
    trackName: string,
    options: FetchOptions,
    callbacks: FetchCallbacks,
  ): Promise<Fetcher>;
  /**
   * トラックの状態を問い合わせる
   * draft-ietf-moq-transport-16 Section 9.19
   */
  trackStatus(namespace: string[], trackName: string): Promise<TrackStatusResult>;
  /**
   * Namespace をサブスクライブする（トラック発見用）
   * draft-ietf-moq-transport-16 Section 9.23
   */
  subscribeNamespace(
    namespacePrefix: string[],
    callbacks: NamespaceSubscriptionCallbacks,
  ): Promise<NamespaceSubscription>;
  /**
   * Namespace を公開する（トラック発見用）
   * draft-ietf-moq-transport-16 Section 9.20
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
   * draft-ietf-moq-transport-16 Section 9.4
   * @param newSessionUri - 新しいセッション URI（オプション）
   */
  goaway(newSessionUri?: string): Promise<void>;
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
  private controlStream?: WebTransportBidirectionalStream;
  private controlReader?: ControlStreamReader;
  private controlWriter?: ControlStreamWriter;

  // Request ID management
  private nextRequestId = 0n;
  private nextTrackAlias = 0n;

  // GOAWAY 状態
  private receivedGoaway = false;
  private sentGoaway = false;

  // MAX_REQUEST_ID 管理
  private peerMaxRequestId = 0n;

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
    { resolve: () => void; reject: (err: Error) => void; existingRequestId: bigint }
  >();
  private pendingFetch = new Map<
    bigint,
    { resolve: (fetcher: Fetcher) => void; reject: (err: Error) => void; impl: FetcherImpl }
  >();
  private pendingTrackStatus = new Map<
    bigint,
    { resolve: (result: TrackStatusResult) => void; reject: (err: Error) => void }
  >();
  private pendingNamespaceSubscribe = new Map<
    bigint,
    {
      resolve: (subscription: NamespaceSubscription) => void;
      reject: (err: Error) => void;
      callbacks: NamespaceSubscriptionCallbacks;
    }
  >();
  private namespaceSubscriptions = new Map<
    bigint,
    {
      callbacks: NamespaceSubscriptionCallbacks;
      state: "active" | "closed";
      namespacePrefix: string[];
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
      state: "active" | "cancelled" | "closed";
      namespace: string[];
    }
  >();

  // Publisher ごとのストリーム状態
  // draft-ietf-moq-transport-16 Section 2.2:
  // "Objects in a subgroup ... are sent on a single stream whenever possible."
  private publisherStreams = new Map<
    bigint,
    {
      groupId: bigint;
      writer: WritableStreamDefaultWriter<Uint8Array>;
      previousObjectId: bigint;
    }
  >();

  // TODO: Closed Subgroup Tracking
  // draft-ietf-moq-transport-16:
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
    // Open bidirectional control stream
    this.controlStream = await this.transport.createBidirectionalStream();
    this.controlReader = new ControlStreamReader();
    this.controlWriter = new ControlStreamWriter();

    // Send CLIENT_SETUP
    const clientSetup = createClientSetup({
      maxRequestId: 1000n,
    });
    const setupPayload = encodeClientSetupPayload(clientSetup);
    const setupMessage = this.controlWriter.encode(MessageType.CLIENT_SETUP, setupPayload);

    this.emitDebug("send", MessageType.CLIENT_SETUP, setupPayload, {
      maxRequestId: getSetupMaxRequestId(clientSetup)?.toString(),
    });

    const writer = this.controlStream.writable.getWriter();
    await writer.write(setupMessage);
    writer.releaseLock();

    // Read SERVER_SETUP
    const reader = this.controlStream.readable.getReader();
    const { value, done } = await reader.read();
    reader.releaseLock();

    if (done || !value) {
      throw new SessionError("Connection closed before SERVER_SETUP", SessionErrorCode.NO_ERROR);
    }

    const messages = this.controlReader.feed(value);
    if (messages.length === 0) {
      throw new SessionError("No SERVER_SETUP received", SessionErrorCode.PROTOCOL_VIOLATION);
    }

    const msg = messages[0];
    if (msg.type !== MessageType.SERVER_SETUP) {
      throw new SessionError(
        `Expected SERVER_SETUP, got ${msg.type}`,
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }

    // Decode SERVER_SETUP
    const serverSetup = decodeServerSetupPayload(msg.payload);

    this.emitDebug("recv", MessageType.SERVER_SETUP, msg.payload, {
      maxRequestId: getSetupMaxRequestId(serverSetup)?.toString(),
    });

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
    // draft-ietf-moq-transport-16 Section 9.4
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

    // EXPIRES (0x08) - draft-ietf-moq-transport-16 Section 9.2.2.6
    if (options?.expires !== undefined) {
      parameters.push({
        type: VersionSpecificParameterType.EXPIRES,
        value: encodeVarint(options.expires),
      });
    }

    // FORWARD (0x10) - draft-ietf-moq-transport-16 Section 9.2.2.8
    // デフォルトは 1 なので、明示的に false (0) が指定された場合のみ送信
    if (options?.forward === false) {
      parameters.push({
        type: VersionSpecificParameterType.FORWARD,
        value: encodeVarint(0n),
      });
    }

    // Build track extensions (Track Extensions - end-to-end scope)
    // draft-ietf-moq-transport-16: Track Properties を Extensions に移動
    // https://github.com/moq-wg/moq-transport/pull/1390
    const trackExtensions: ExtensionHeader[] = [];

    // DELIVERY_TIMEOUT (0x02) - draft-ietf-moq-transport-16 Section 9.2.2.2
    // draft-ietf-moq-transport-16: DELIVERY_TIMEOUT=0 is not allowed
    // https://github.com/moq-wg/moq-transport/pull/1330
    if (options?.deliveryTimeout !== undefined) {
      if (options.deliveryTimeout === 0n) {
        throw new Error("DELIVERY_TIMEOUT=0 is not allowed");
      }
      trackExtensions.push({
        id: TrackExtensionHeaderId.DELIVERY_TIMEOUT,
        value: options.deliveryTimeout,
      });
    }

    // MAX_CACHE_DURATION (0x04) - draft-ietf-moq-transport-16 Section 11.1.1
    if (options?.maxCacheDuration !== undefined) {
      trackExtensions.push({
        id: TrackExtensionHeaderId.MAX_CACHE_DURATION,
        value: options.maxCacheDuration,
      });
    }

    // PUBLISHER_PRIORITY (0x0e) - draft-ietf-moq-transport-16 Section 11.1.1.1
    if (options?.publisherPriority !== undefined) {
      trackExtensions.push({
        id: TrackExtensionHeaderId.PUBLISHER_PRIORITY,
        value: BigInt(options.publisherPriority),
      });
    }

    // PUBLISHER_GROUP_ORDER_PREFERENCE (0x22) - draft-ietf-moq-transport-16 Section 9.2.2.4
    // draft-ietf-moq-transport-16: GROUP_ORDER から Publisher 向けの設定が分離
    // https://github.com/moq-wg/moq-transport/pull/1390
    if (options?.groupOrder !== undefined) {
      const groupOrderValue = options.groupOrder === "Ascending" ? 0x01n : 0x02n;
      trackExtensions.push({
        id: TrackExtensionHeaderId.PUBLISHER_GROUP_ORDER_PREFERENCE,
        value: groupOrderValue,
      });
    }

    // DYNAMIC_GROUPS (0x30) - draft-ietf-moq-transport-16 Section 11.1.1.3
    if (options?.dynamicGroups === true) {
      trackExtensions.push({
        id: TrackExtensionHeaderId.DYNAMIC_GROUPS,
        value: 1n,
      });
    }

    // Send PUBLISH message
    const publishMsg = {
      type: MessageType.PUBLISH,
      requestId,
      trackNamespace,
      trackName: trackNameBytes,
      trackAlias,
      parameters,
      trackExtensions,
    };

    const payload = encodePublishPayload(publishMsg as Parameters<typeof encodePublishPayload>[0]);
    await this.sendControlMessage(MessageType.PUBLISH, payload, {
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

    return promise;
  }

  /**
   * Subscribe to a track
   *
   * draft-ietf-moq-transport-16 Section 9.9:
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
    // draft-ietf-moq-transport-16 Section 9.4
    if (this.receivedGoaway) {
      throw new Error("Cannot subscribe after receiving GOAWAY");
    }

    // Joining Fetch は Filter Type が LargestObject の場合のみ許可
    // draft-ietf-moq-transport-16 Section 9.16.2:
    // "A Joining Fetch is only permitted when the associated Subscribe has
    //  the Filter Type Largest Object; any other value results in closing
    //  the session with a PROTOCOL_VIOLATION."
    // joiningFetch が有効な場合、自動的に LargestObject フィルターを設定する
    if (options?.joiningFetch) {
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

    // Set up unsubscribe callback
    impl.onUnsubscribe = async () => {
      await this.sendUnsubscribe(impl);
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

    // SUBSCRIPTION_FILTER (0x21) - draft-ietf-moq-transport-16 Section 9.2.2.5
    if (options?.filter !== undefined) {
      parameters.push(encodeSubscriptionFilterParameter(options.filter));
    }

    // DELIVERY_TIMEOUT (0x02) - draft-ietf-moq-transport-16 Section 9.2.2.2
    // draft-ietf-moq-transport-16: DELIVERY_TIMEOUT=0 is not allowed
    // https://github.com/moq-wg/moq-transport/pull/1330
    if (options?.deliveryTimeout !== undefined) {
      if (options.deliveryTimeout === 0n) {
        throw new Error("DELIVERY_TIMEOUT=0 is not allowed");
      }
      parameters.push({
        type: VersionSpecificParameterType.DELIVERY_TIMEOUT,
        value: encodeVarint(options.deliveryTimeout),
      });
    }

    // SUBSCRIBER_PRIORITY (0x20) - draft-ietf-moq-transport-16 Section 9.2.2.3
    if (options?.subscriberPriority !== undefined) {
      parameters.push({
        type: VersionSpecificParameterType.SUBSCRIBER_PRIORITY,
        value: encodeVarint(options.subscriberPriority),
      });
    }

    // GROUP_ORDER (0x22) - draft-ietf-moq-transport-16 Section 9.2.2.4
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

    // FORWARD (0x10) - draft-ietf-moq-transport-16 Section 9.2.2.8
    // デフォルトは 1 なので、明示的に false (0) が指定された場合のみ送信
    if (options?.forward === false) {
      parameters.push({
        type: VersionSpecificParameterType.FORWARD,
        value: encodeVarint(0n),
      });
    }

    // Send SUBSCRIBE message (without trackAlias - it comes from SUBSCRIBE_OK)
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
    await this.sendControlMessage(MessageType.SUBSCRIBE, payload, {
      requestId: requestId.toString(),
      trackNamespace: namespace,
      trackName,
      filterType: options?.filter?.type,
      DELIVERY_TIMEOUT: options?.deliveryTimeout?.toString(),
      SUBSCRIBER_PRIORITY: options?.subscriberPriority,
      GROUP_ORDER: options?.groupOrder,
      NEW_GROUP_REQUEST: options?.newGroupRequest?.toString(),
    });

    return promise;
  }

  /**
   * 過去のデータを取得する（Standalone Fetch）
   *
   * draft-ietf-moq-transport-16 Section 9.16:
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

    // キャンセルコールバックを設定
    impl.onCancel = async () => {
      await this.sendFetchCancel(impl);
    };

    // FETCH_OK を待つ Promise
    const promise = new Promise<Fetcher>((resolve, reject) => {
      this.pendingFetch.set(requestId, { resolve, reject, impl });
    });

    // FETCH メッセージを送信（Standalone Fetch）
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
    await this.sendControlMessage(MessageType.FETCH, payload, {
      requestId: requestId.toString(),
      trackNamespace: namespace,
      trackName,
      startLocation: `${options.startLocation.group}:${options.startLocation.object}`,
      endLocation: `${options.endLocation.group}:${options.endLocation.object}`,
    });

    return promise;
  }

  /**
   * トラックの状態を問い合わせる
   *
   * draft-ietf-moq-transport-16 Section 9.19:
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

    // TRACK_STATUS メッセージを送信
    const trackStatusMsg = {
      type: MessageType.TRACK_STATUS,
      requestId,
      trackNamespace,
      trackName: trackNameBytes,
      parameters: [],
    };

    const payload = encodeTrackStatusPayload(trackStatusMsg);
    await this.sendControlMessage(MessageType.TRACK_STATUS, payload, {
      requestId: requestId.toString(),
      trackNamespace: namespace,
      trackName,
    });

    return promise;
  }

  /**
   * Namespace をサブスクライブする（トラック発見用）
   *
   * draft-ietf-moq-transport-16 Section 9.23:
   * SUBSCRIBE_NAMESPACE requests matching published namespaces.
   *
   * draft-ietf-moq-transport-16:
   * SUBSCRIBE_NAMESPACE は専用の双方向ストリームに配置される。
   * Control Stream ではなく、独自のストリームで送信する。
   * https://github.com/moq-wg/moq-transport/pull/1344
   *
   * TODO: 専用の双方向ストリームで SUBSCRIBE_NAMESPACE を送信するように実装を更新する。
   * 現在は Control Stream で送信している（draft-15 互換）。
   */
  async subscribeNamespace(
    namespacePrefix: string[],
    callbacks: NamespaceSubscriptionCallbacks,
  ): Promise<NamespaceSubscription> {
    if (this.sessionState === "closed") {
      throw new Error("Session is closed");
    }

    // GOAWAY 受信後は新規リクエストを拒否
    if (this.receivedGoaway) {
      throw new Error("Cannot subscribe namespace after receiving GOAWAY");
    }

    const requestId = this.nextRequestId;
    this.nextRequestId += 2n;

    const trackNamespacePrefix = createTrackNamespace(namespacePrefix);

    // REQUEST_OK を待つ Promise
    const promise = new Promise<NamespaceSubscription>((resolve, reject) => {
      this.pendingNamespaceSubscribe.set(requestId, { resolve, reject, callbacks });
    });

    // SUBSCRIBE_NAMESPACE メッセージを送信
    const subscribeNamespaceMsg = {
      type: MessageType.SUBSCRIBE_NAMESPACE,
      requestId,
      trackNamespacePrefix,
      parameters: [],
    };

    const payload = encodeSubscribeNamespacePayload(subscribeNamespaceMsg);
    await this.sendControlMessage(MessageType.SUBSCRIBE_NAMESPACE, payload, {
      requestId: requestId.toString(),
      trackNamespacePrefix: namespacePrefix,
    });

    return promise;
  }

  /**
   * Namespace を公開する（トラック発見用）
   *
   * draft-ietf-moq-transport-16 Section 9.20:
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
   * draft-ietf-moq-transport-16 Section 9.4:
   * An endpoint sends a GOAWAY message to inform the peer it intends to
   * close the session soon.
   */
  async goaway(newSessionUri?: string): Promise<void> {
    if (this.sessionState === "closed") {
      throw new Error("Session is closed");
    }

    // 複数回の GOAWAY 送信は許可しない
    if (this.sentGoaway) {
      throw new Error("GOAWAY already sent");
    }

    this.sentGoaway = true;

    const payload = encodeGoawayPayload({
      type: MessageType.GOAWAY,
      newSessionUri: newSessionUri ?? "",
    });

    await this.sendControlMessage(MessageType.GOAWAY, payload, {
      newSessionUri: newSessionUri ?? "",
    });
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

    // Close WebTransport
    // closed Promise のエラーを無視（サーバー側からクローズされた場合など）
    this.transport.closed.catch(() => {});

    this.callbacks.close?.();
  }

  // Private methods

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
    if (!this.controlStream || !this.controlWriter) {
      throw new Error("Control stream not initialized");
    }

    this.statsControlMessagesSent++;
    this.emitDebug("send", type, payload, decoded);

    const message = this.controlWriter.encode(type, payload);
    const writer = this.controlStream.writable.getWriter();
    await writer.write(message);
    writer.releaseLock();
  }

  /**
   * Send an object on a subgroup stream
   * draft-ietf-moq-transport-16 Section 2.2:
   * "Objects in a subgroup ... are sent on a single stream whenever possible."
   *
   * 同じ Group 内のオブジェクトは同じストリームで送信する
   * 新しい Group が来たら前のストリームを閉じて新規作成する
   */
  private async sendObject(publisher: PublisherImpl, params: SendObjectParams): Promise<void> {
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
      const writer = stream.getWriter();

      // Subgroup Header を書き込む
      // draft-ietf-moq-transport-16 Section 10.4.2
      const hasExtensions = params.extensions !== undefined && params.extensions.length > 0;
      const headerType = hasExtensions ? SubgroupHeaderType.BASE_EXT : SubgroupHeaderType.BASE;
      const header = encodeSubgroupHeader({
        type: headerType,
        trackAlias,
        groupId,
        subgroupId: 0n,
        publisherPriority: params.priority ?? 128,
      });
      await writer.write(header);

      streamState = { groupId, writer, previousObjectId: -1n };
      this.publisherStreams.set(trackAlias, streamState);
    }

    // Object ID Delta を計算
    // draft-ietf-moq-transport-16 Section 10.4.2:
    // "The Object ID Delta + 1 is added to the previous Object ID ...
    //  The Object ID is the Object ID Delta if it's the first Object"
    const objectIdDelta =
      streamState.previousObjectId < 0n ? objectId : objectId - streamState.previousObjectId - 1n;

    // Object fields を構築
    // draft-ietf-moq-transport-16 Section 10.4.2 Figure 29
    const hasExtensions = params.extensions !== undefined && params.extensions.length > 0;
    const objectIdDeltaBytes = encodeVarint(objectIdDelta);
    const payloadLenBytes = encodeVarint(params.payload.length);
    const extensionsDataLength = hasExtensions ? params.extensions!.length : 0;
    const extensionsLengthBytes = hasExtensions ? encodeVarint(extensionsDataLength) : null;

    const totalLength =
      objectIdDeltaBytes.length +
      (extensionsLengthBytes ? extensionsLengthBytes.length + extensionsDataLength : 0) +
      payloadLenBytes.length +
      params.payload.length;
    const data = new Uint8Array(totalLength);
    let offset = 0;

    data.set(objectIdDeltaBytes, offset);
    offset += objectIdDeltaBytes.length;

    if (hasExtensions && extensionsLengthBytes) {
      data.set(extensionsLengthBytes, offset);
      offset += extensionsLengthBytes.length;
      data.set(params.extensions!, offset);
      offset += extensionsDataLength;
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
   */
  private async closePublisherStream(trackAlias: bigint): Promise<void> {
    const streamState = this.publisherStreams.get(trackAlias);
    if (streamState) {
      // 先に Map から削除して二重クローズを防止
      this.publisherStreams.delete(trackAlias);
      try {
        await streamState.writer.close();
      } catch {
        // 既にクローズされている場合は無視
      }
    }
  }

  /**
   * Send a datagram
   * draft-ietf-moq-transport-16 Section 10.3
   */
  private sendDatagram(publisher: PublisherImpl, params: SendDatagramParams): void {
    const hasExtensions = params.extensions !== undefined && params.extensions.length > 0;
    const hasPriority = params.priority !== undefined;
    const endOfGroup = params.endOfGroup ?? false;

    // Datagram Type を決定
    // Table 5: Type bits = EndOfGroup(bit 1) | Extensions(bit 0)
    let type: number;
    if (hasPriority) {
      if (endOfGroup) {
        type = hasExtensions
          ? DatagramType.PAYLOAD_OBJ_EXT_END_GROUP
          : DatagramType.PAYLOAD_OBJ_END_GROUP;
      } else {
        type = hasExtensions ? DatagramType.PAYLOAD_OBJ_EXT : DatagramType.PAYLOAD_OBJ;
      }
    } else {
      if (endOfGroup) {
        type = hasExtensions
          ? DatagramType.PAYLOAD_OBJ_EXT_END_GROUP_NO_PRI
          : DatagramType.PAYLOAD_OBJ_END_GROUP_NO_PRI;
      } else {
        type = hasExtensions
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
      extensions: params.extensions,
      payload: params.payload,
    });

    // WebTransport datagram として送信
    const writer = this.transport.datagrams.writable.getWriter();
    void writer.write(datagram).finally(() => {
      writer.releaseLock();
    });
  }

  private async sendPublishDone(publisher: PublisherImpl): Promise<void> {
    const requestId = publisher.getRequestId();

    // Encode PUBLISH_DONE payload
    // draft-ietf-moq-transport-16 Section 9.15
    const parts: Uint8Array[] = [];
    parts.push(encodeVarint(requestId));
    parts.push(encodeVarint(PublishDoneStatusCode.TRACK_ENDED));
    parts.push(encodeVarint(0)); // Stream count
    parts.push(encodeVarint(0)); // Reason phrase length

    const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
    const payload = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      payload.set(part, offset);
      offset += part.length;
    }

    await this.sendControlMessage(MessageType.PUBLISH_DONE, payload, {
      requestId: requestId.toString(),
      statusCode: PublishDoneStatusCode.TRACK_ENDED,
      streamCount: "0",
    });

    this.publishers.delete(requestId);
  }

  private async sendUnsubscribe(subscriber: SubscriberImpl): Promise<void> {
    const requestId = subscriber.getRequestId();

    const unsubscribeMsg = {
      type: MessageType.UNSUBSCRIBE,
      requestId,
    };

    const payload = encodeUnsubscribePayload(
      unsubscribeMsg as Parameters<typeof encodeUnsubscribePayload>[0],
    );
    await this.sendControlMessage(MessageType.UNSUBSCRIBE, payload, {
      requestId: requestId.toString(),
    });

    this.subscribers.delete(requestId);
    this.subscribersByAlias.delete(subscriber.getTrackAlias());
  }

  /**
   * FETCH_CANCEL を送信する
   *
   * draft-ietf-moq-transport-16 Section 9.18
   */
  private async sendFetchCancel(fetcher: FetcherImpl): Promise<void> {
    const requestId = fetcher.getRequestId();

    const fetchCancelMsg = {
      type: MessageType.FETCH_CANCEL,
      requestId,
    };

    const payload = encodeFetchCancelPayload(
      fetchCancelMsg as Parameters<typeof encodeFetchCancelPayload>[0],
    );
    await this.sendControlMessage(MessageType.FETCH_CANCEL, payload, {
      requestId: requestId.toString(),
    });

    this.fetchers.delete(requestId);
  }

  /**
   * Joining FETCH を送信する
   *
   * draft-ietf-moq-transport-16 Section 9.16.2:
   * Joining Fetch は SUBSCRIBE と関連付けられた FETCH で、
   * ライブデータを受信しながら過去のデータを取得する。
   */
  private async sendJoiningFetch(
    subscribeRequestId: bigint,
    options: JoiningFetchOptions,
    defaultObjectCallback: (object: MoqtObject) => void,
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

    // キャンセルコールバックを設定
    impl.onCancel = async () => {
      await this.sendFetchCancel(impl);
    };

    // FETCH_OK を待つ Promise（Joining Fetch の場合は背景で処理）
    this.pendingFetch.set(requestId, {
      resolve: () => {
        this.fetchers.set(requestId, impl);
      },
      reject: (err) => {
        options.onError?.(err);
      },
      impl,
    });

    // Joining FETCH メッセージを送信
    const fetchType =
      options.type === "relative" ? FetchType.RELATIVE_JOINING : FetchType.ABSOLUTE_JOINING;

    const fetchMsg = {
      type: MessageType.FETCH,
      requestId,
      fetchType,
      joining: {
        joiningRequestId: subscribeRequestId,
        joiningStart: options.start,
      },
      parameters: [],
    };

    const payload = encodeFetchPayload(fetchMsg);
    await this.sendControlMessage(MessageType.FETCH, payload, {
      requestId: requestId.toString(),
      fetchType: options.type,
      joiningRequestId: subscribeRequestId.toString(),
      joiningStart: options.start.toString(),
    });
  }

  /**
   * REQUEST_UPDATE を送信する
   *
   * draft-ietf-moq-transport-16 Section 9.11:
   * REQUEST_UPDATE Message {
   *   Type (i) = 0x2,
   *   Length (16),
   *   Request ID (i),
   *   Existing Request ID (i),
   *   Number of Parameters (i),
   *   Parameters (..) ...
   * }
   */
  private async sendRequestUpdate(
    subscriber: SubscriberImpl,
    options: RequestUpdateOptions,
  ): Promise<void> {
    const updateRequestId = this.nextRequestId;
    this.nextRequestId += 2n;

    const existingRequestId = subscriber.getRequestId();

    // パラメータを構築
    const parameters: Parameter[] = options.parameters ? [...options.parameters] : [];

    // FORWARD (0x10) - draft-ietf-moq-transport-16 Section 9.2.2.8
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
      existingRequestId,
      parameters,
    };

    const payload = encodeRequestUpdatePayload(
      requestUpdateMsg as Parameters<typeof encodeRequestUpdatePayload>[0],
    );

    const promise = new Promise<void>((resolve, reject) => {
      this.pendingRequestUpdate.set(updateRequestId, {
        resolve,
        reject,
        existingRequestId,
      });
    });

    await this.sendControlMessage(MessageType.REQUEST_UPDATE, payload, {
      requestId: updateRequestId.toString(),
      existingRequestId: existingRequestId.toString(),
    });

    return promise;
  }

  private startControlMessageLoop(): void {
    void (async () => {
      if (!this.controlStream || !this.controlReader) return;

      const reader = this.controlStream.readable.getReader();

      try {
        while (this.sessionState === "connected") {
          const { value, done } = await reader.read();
          if (done) break;

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

  private handleControlMessage(type: number, payload: Uint8Array): void {
    this.statsControlMessagesReceived++;
    let decoded: Record<string, unknown> | undefined;

    switch (type) {
      case MessageType.SUBSCRIBE_OK:
        decoded = this.handleSubscribeOk(payload);
        break;
      case MessageType.PUBLISH_OK:
        decoded = this.handlePublishOk(payload);
        break;
      case MessageType.PUBLISH_DONE:
        decoded = this.handlePublishDone(payload);
        break;
      case MessageType.REQUEST_ERROR:
        decoded = this.handleRequestError(payload);
        break;
      case MessageType.REQUEST_OK:
        decoded = this.handleRequestOk(payload);
        break;
      case MessageType.GOAWAY:
        decoded = this.handleGoaway(payload);
        break;
      case MessageType.MAX_REQUEST_ID:
        decoded = this.handleMaxRequestId(payload);
        break;
      case MessageType.REQUESTS_BLOCKED:
        decoded = this.handleRequestsBlocked(payload);
        break;
      case MessageType.FETCH_OK:
        decoded = this.handleFetchOk(payload);
        break;
      case MessageType.PUBLISH_NAMESPACE:
        decoded = this.handlePublishNamespace(payload);
        break;
      case MessageType.PUBLISH_NAMESPACE_CANCEL:
        decoded = this.handlePublishNamespaceCancel(payload);
        break;
    }

    this.emitDebug("recv", type, payload, decoded);
  }

  /**
   * Handle SUBSCRIBE_OK message
   *
   * draft-ietf-moq-transport-16 Section 9.10:
   * Track Alias is provided by the publisher in SUBSCRIBE_OK.
   */
  private handleSubscribeOk(payload: Uint8Array): Record<string, unknown> {
    const msg = decodeSubscribeOkPayload(payload);
    const pending = this.pendingSubscribe.get(msg.requestId);

    // LARGEST_OBJECT パラメータを探す
    let largestLocation: Location | undefined;
    for (const param of msg.parameters) {
      if (param.type === VersionSpecificParameterType.LARGEST_OBJECT) {
        largestLocation = getParameterLocationValue(param);
        break;
      }
    }

    if (pending) {
      this.pendingSubscribe.delete(msg.requestId);
      // Set the track alias from SUBSCRIBE_OK
      pending.impl.setTrackAlias(msg.trackAlias);

      // Set LARGEST_OBJECT if present
      if (largestLocation) {
        pending.impl.setLargestLocation(largestLocation);
      }

      this.subscribers.set(msg.requestId, pending.impl);
      this.subscribersByAlias.set(msg.trackAlias, pending.impl);

      // バッファリングされた Subgroup ストリームを処理
      // SUBSCRIBE_OK より先にデータストリームが到着した場合
      const pendingStreams = this.pendingSubgroupStreams.get(msg.trackAlias);
      if (pendingStreams && pendingStreams.length > 0) {
        this.pendingSubgroupStreams.delete(msg.trackAlias);
        for (const pendingStream of pendingStreams) {
          this.processPendingSubgroupStream(pending.impl, pendingStream.header, pendingStream.data);
        }
      }

      // Joining Fetch が指定されている場合は送信
      // draft-ietf-moq-transport-16 Section 9.16.2:
      // "If no Objects have been published for the track, and the SUBSCRIBE_OK
      //  did not include a LARGEST_OBJECT parameter, the publisher MUST respond
      //  with a REQUEST_ERROR with error code INVALID_RANGE."
      if (pending.joiningFetch && largestLocation) {
        void this.sendJoiningFetch(msg.requestId, pending.joiningFetch, pending.objectCallback);
      }
      // LARGEST_OBJECT がない場合は Joining Fetch を送信せず、リアルタイム配信を待つ

      pending.resolve(pending.impl);
    }

    return {
      requestId: msg.requestId.toString(),
      trackAlias: msg.trackAlias.toString(),
      LARGEST_OBJECT: largestLocation
        ? `${largestLocation.group}:${largestLocation.object}`
        : undefined,
    };
  }

  private handlePublishOk(payload: Uint8Array): Record<string, unknown> {
    const msg = decodePublishOkPayload(payload);
    const pending = this.pendingPublish.get(msg.requestId);

    if (pending) {
      this.pendingPublish.delete(msg.requestId);
      this.publishers.set(msg.requestId, pending.impl);

      // FORWARD パラメータを処理
      // draft-ietf-moq-transport-16 Section 9.2.2.8
      // デフォルトは 1 (forward) だが、0 が指定された場合は forwardState を false にする
      let forwardState = true;
      for (const param of msg.parameters) {
        if (param.type === VersionSpecificParameterType.FORWARD) {
          const [value] = decodeVarint(param.value, 0);
          forwardState = value !== 0n;
          break;
        }
      }
      pending.impl.setForwardState(forwardState);

      pending.resolve(pending.impl);
    }

    return {
      requestId: msg.requestId.toString(),
    };
  }

  private handlePublishDone(payload: Uint8Array): Record<string, unknown> {
    const msg = decodePublishDonePayload(payload);
    const subscriber = this.subscribers.get(msg.requestId);

    if (subscriber) {
      subscriber.handleEnd();
      this.subscribers.delete(msg.requestId);
      this.subscribersByAlias.delete(subscriber.getTrackAlias());
    }

    return {
      requestId: msg.requestId.toString(),
      statusCode: msg.statusCode,
      streamCount: msg.streamCount.toString(),
      reasonPhrase: msg.reasonPhrase,
    };
  }

  /**
   * Handle REQUEST_ERROR message
   *
   * draft-ietf-moq-transport-16 Section 9.8:
   * REQUEST_ERROR is sent in response to any request
   * (SUBSCRIBE, FETCH, PUBLISH, SUBSCRIBE_NAMESPACE, PUBLISH_NAMESPACE, TRACK_STATUS)
   */
  private handleRequestError(payload: Uint8Array): Record<string, unknown> {
    const { requestId, errorCode, retryInterval, reason } = this.decodeRequestError(payload);

    const error = new RequestError(
      reason || `Request failed with code ${errorCode}`,
      errorCode as RequestErrorCode,
    );

    const pendingPub = this.pendingPublish.get(requestId);
    if (pendingPub) {
      this.pendingPublish.delete(requestId);
      pendingPub.reject(error);
    }

    const pendingSub = this.pendingSubscribe.get(requestId);
    if (pendingSub) {
      this.pendingSubscribe.delete(requestId);
      pendingSub.reject(error);
    }

    const pendingUpdate = this.pendingRequestUpdate.get(requestId);
    if (pendingUpdate) {
      this.pendingRequestUpdate.delete(requestId);
      pendingUpdate.reject(error);
    }

    const pendingFetchReq = this.pendingFetch.get(requestId);
    if (pendingFetchReq) {
      this.pendingFetch.delete(requestId);
      pendingFetchReq.reject(error);
    }

    const pendingStatusReq = this.pendingTrackStatus.get(requestId);
    if (pendingStatusReq) {
      this.pendingTrackStatus.delete(requestId);
      pendingStatusReq.reject(error);
    }

    const pendingNamespaceReq = this.pendingNamespaceSubscribe.get(requestId);
    if (pendingNamespaceReq) {
      this.pendingNamespaceSubscribe.delete(requestId);
      pendingNamespaceReq.reject(error);
    }

    const pendingNamespacePubReq = this.pendingNamespacePublish.get(requestId);
    if (pendingNamespacePubReq) {
      this.pendingNamespacePublish.delete(requestId);
      pendingNamespacePubReq.reject(error);
    }

    return {
      requestId: requestId.toString(),
      errorCode,
      retryInterval: retryInterval.toString(),
      reason,
    };
  }

  /**
   * Handle REQUEST_OK message
   *
   * draft-ietf-moq-transport-16 Section 9.7:
   * REQUEST_OK is sent in response to REQUEST_UPDATE,
   * TRACK_STATUS, SUBSCRIBE_NAMESPACE and PUBLISH_NAMESPACE requests.
   */
  private handleRequestOk(payload: Uint8Array): Record<string, unknown> {
    const msg = decodeRequestOkPayload(payload);

    // REQUEST_UPDATE の応答
    const pendingUpdate = this.pendingRequestUpdate.get(msg.requestId);
    if (pendingUpdate) {
      this.pendingRequestUpdate.delete(msg.requestId);
      pendingUpdate.resolve();
    }

    // TRACK_STATUS の応答
    const pendingStatus = this.pendingTrackStatus.get(msg.requestId);
    if (pendingStatus) {
      this.pendingTrackStatus.delete(msg.requestId);
      pendingStatus.resolve({ parameters: msg.parameters });
    }

    // SUBSCRIBE_NAMESPACE の応答
    const pendingNamespace = this.pendingNamespaceSubscribe.get(msg.requestId);
    if (pendingNamespace) {
      this.pendingNamespaceSubscribe.delete(msg.requestId);

      // アクティブなサブスクリプションとして登録
      this.namespaceSubscriptions.set(msg.requestId, {
        callbacks: pendingNamespace.callbacks,
        state: "active",
        namespacePrefix: [],
      });

      // NamespaceSubscription を作成
      const subscription = this.createNamespaceSubscription(msg.requestId);

      pendingNamespace.resolve(subscription);
    }

    // PUBLISH_NAMESPACE の応答
    const pendingNamespacePub = this.pendingNamespacePublish.get(msg.requestId);
    if (pendingNamespacePub) {
      this.pendingNamespacePublish.delete(msg.requestId);

      // アクティブな公開として登録
      this.namespacePublications.set(msg.requestId, {
        callbacks: pendingNamespacePub.callbacks,
        state: "active",
        namespace: pendingNamespacePub.namespace,
      });

      // NamespacePublication を作成
      const publication = this.createNamespacePublication(msg.requestId);

      pendingNamespacePub.resolve(publication);
    }

    return {
      requestId: msg.requestId.toString(),
      parametersCount: msg.parameters.length,
    };
  }

  /**
   * Handle GOAWAY message
   *
   * draft-ietf-moq-transport-16 Section 9.4:
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
      this.callbacks.error?.(
        new SessionError("Received multiple GOAWAY messages", SessionErrorCode.PROTOCOL_VIOLATION),
      );
      return { error: "Multiple GOAWAY messages received" };
    }

    this.receivedGoaway = true;

    const msg = decodeGoawayPayload(payload);

    // GOAWAY コールバックを呼び出す
    this.callbacks.goaway?.(msg.newSessionUri);

    return {
      newSessionUri: msg.newSessionUri,
    };
  }

  /**
   * Handle MAX_REQUEST_ID message
   *
   * draft-ietf-moq-transport-16 Section 9.5:
   * The Maximum Request ID MUST only increase within a session, and
   * receipt of a MAX_REQUEST_ID message with an equal or smaller Request
   * ID value is a PROTOCOL_VIOLATION.
   */
  private handleMaxRequestId(payload: Uint8Array): Record<string, unknown> {
    const msg = decodeMaxRequestIdPayload(payload);

    // Request ID は増加のみ許可
    if (msg.maxRequestId <= this.peerMaxRequestId) {
      this.callbacks.error?.(
        new SessionError("MAX_REQUEST_ID must only increase", SessionErrorCode.PROTOCOL_VIOLATION),
      );
      return {
        error: "MAX_REQUEST_ID did not increase",
        received: msg.maxRequestId.toString(),
        current: this.peerMaxRequestId.toString(),
      };
    }

    this.peerMaxRequestId = msg.maxRequestId;

    return {
      maxRequestId: msg.maxRequestId.toString(),
    };
  }

  /**
   * Handle REQUESTS_BLOCKED message
   *
   * draft-ietf-moq-transport-16 Section 9.6:
   * The REQUESTS_BLOCKED message is sent when an endpoint would like to
   * send a new request, but cannot because the Request ID would exceed
   * the Maximum Request ID value sent by the peer.
   */
  private handleRequestsBlocked(payload: Uint8Array): Record<string, unknown> {
    const msg = decodeRequestsBlockedPayload(payload);

    // 現時点では情報をログに記録するのみ
    // 将来的には MAX_REQUEST_ID を送信するロジックを追加可能

    return {
      maximumRequestId: msg.maximumRequestId.toString(),
    };
  }

  /**
   * Handle FETCH_OK message
   *
   * draft-ietf-moq-transport-16 Section 9.17:
   * FETCH_OK is sent in response to a successful FETCH.
   */
  private handleFetchOk(payload: Uint8Array): Record<string, unknown> {
    const msg = decodeFetchOkPayload(payload);
    const pending = this.pendingFetch.get(msg.requestId);

    if (pending) {
      this.pendingFetch.delete(msg.requestId);
      // FETCH_OK の情報を設定
      pending.impl.setFetchOkInfo(msg.endOfTrack, msg.endLocation);
      this.fetchers.set(msg.requestId, pending.impl);
      pending.resolve(pending.impl);
    }

    return {
      requestId: msg.requestId.toString(),
      endOfTrack: msg.endOfTrack,
      endLocation: `${msg.endLocation.group}:${msg.endLocation.object}`,
    };
  }

  /**
   * Handle PUBLISH_NAMESPACE message
   *
   * draft-ietf-moq-transport-16 Section 9.20:
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
      subscription.callbacks.announce(announcement);
    }

    return {
      requestId: msg.requestId.toString(),
      trackNamespace: namespaceStrings,
      parametersCount: msg.parameters.length,
    };
  }

  /**
   * Handle PUBLISH_NAMESPACE_CANCEL message
   *
   * draft-ietf-moq-transport-16 Section 9.22:
   * A subscriber sends PUBLISH_NAMESPACE_CANCEL to revoke acceptance
   * of a PUBLISH_NAMESPACE.
   */
  private handlePublishNamespaceCancel(payload: Uint8Array): Record<string, unknown> {
    const msg = decodePublishNamespaceCancelPayload(payload);
    const namespaceStrings = trackNamespaceToStrings(msg.trackNamespace);

    // Track Namespace で対応する NamespacePublication を検索
    for (const publication of this.namespacePublications.values()) {
      if (
        publication.state === "active" &&
        this.namespaceMatches(publication.namespace, namespaceStrings)
      ) {
        publication.state = "cancelled";
        publication.callbacks?.cancelled?.(msg.errorCode, msg.reasonPhrase);
        break;
      }
    }

    return {
      trackNamespace: namespaceStrings,
      errorCode: msg.errorCode.toString(),
      reasonPhrase: msg.reasonPhrase,
    };
  }

  /**
   * 名前空間が一致するかどうかを確認する
   */
  private namespaceMatches(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
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
      await this.sendUnsubscribeNamespace(requestId);
    };

    return {
      get state() {
        return getState();
      },
      unsubscribe,
    };
  }

  /**
   * UNSUBSCRIBE_NAMESPACE を送信する
   *
   * draft-ietf-moq-transport-16 Section 9.24
   */
  private async sendUnsubscribeNamespace(requestId: bigint): Promise<void> {
    const subscription = this.namespaceSubscriptions.get(requestId);
    if (!subscription || subscription.state === "closed") {
      return;
    }

    subscription.state = "closed";

    const unsubscribeMsg = {
      type: MessageType.UNSUBSCRIBE_NAMESPACE,
      requestId,
    };

    const payload = encodeUnsubscribeNamespacePayload(
      unsubscribeMsg as Parameters<typeof encodeUnsubscribeNamespacePayload>[0],
    );
    await this.sendControlMessage(MessageType.UNSUBSCRIBE_NAMESPACE, payload, {
      requestId: requestId.toString(),
    });

    this.namespaceSubscriptions.delete(requestId);
  }

  /**
   * NamespacePublication オブジェクトを作成する
   */
  private createNamespacePublication(requestId: bigint): NamespacePublication {
    const getState = (): "active" | "cancelled" | "closed" => {
      const pub = this.namespacePublications.get(requestId);
      return pub?.state ?? "closed";
    };

    const getNamespace = (): string[] => {
      const pub = this.namespacePublications.get(requestId);
      return pub?.namespace ?? [];
    };

    const done = async (): Promise<void> => {
      await this.sendPublishNamespaceDone(requestId);
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
   * PUBLISH_NAMESPACE_DONE を送信する
   *
   * draft-ietf-moq-transport-16 Section 9.21:
   * PUBLISH_NAMESPACE_DONE withdraws a previous PUBLISH_NAMESPACE.
   */
  private async sendPublishNamespaceDone(requestId: bigint): Promise<void> {
    const publication = this.namespacePublications.get(requestId);
    if (!publication || publication.state === "closed") {
      return;
    }

    // PUBLISH_NAMESPACE_CANCEL を受信していたら PUBLISH_NAMESPACE_DONE を送信しない
    // draft-ietf-moq-transport-16 Section 6.2:
    // "After receiving a PUBLISH_NAMESPACE_CANCEL, the publisher does not
    //  send PUBLISH_NAMESPACE_DONE."
    if (publication.state === "cancelled") {
      this.namespacePublications.delete(requestId);
      return;
    }

    publication.state = "closed";

    const trackNamespace = createTrackNamespace(publication.namespace);

    const publishNamespaceDoneMsg = {
      type: MessageType.PUBLISH_NAMESPACE_DONE,
      requestId,
      trackNamespace,
    };

    const payload = encodePublishNamespaceDonePayload(publishNamespaceDoneMsg);
    await this.sendControlMessage(MessageType.PUBLISH_NAMESPACE_DONE, payload, {
      trackNamespace: publication.namespace,
    });

    this.namespacePublications.delete(requestId);
  }

  /**
   * Decode REQUEST_ERROR payload
   *
   * draft-ietf-moq-transport-16 Section 9.8:
   * REQUEST_ERROR Message {
   *   Type (i) = 0x5,
   *   Length (16),
   *   Request ID (i),
   *   Error Code (i),
   *   Retry Interval (i),
   *   Error Reason (Reason Phrase),
   * }
   *
   * Retry Interval: 再試行までに待つべきミリ秒 + 1
   * - 0: 再試行すべきではない
   * - 1 以上: 再試行可能（1 は即座の再試行を許可）
   */
  private decodeRequestError(payload: Uint8Array): {
    requestId: bigint;
    errorCode: number;
    retryInterval: bigint;
    reason: string;
  } {
    let offset = 0;

    // Request ID (varint)
    const [requestId, requestIdLen] = decodeVarint(payload, offset);
    offset += requestIdLen;

    // Error Code (varint)
    const [errorCode, errorCodeLen] = decodeVarint(payload, offset);
    offset += errorCodeLen;

    // Retry Interval (varint)
    const [retryInterval, retryIntervalLen] = decodeVarint(payload, offset);
    offset += retryIntervalLen;

    // Reason Phrase Length (varint)
    const [reasonLen, reasonLenLen] = decodeVarint(payload, offset);
    offset += reasonLenLen;

    // Reason Phrase Value
    const decoder = new TextDecoder();
    const reason = decoder.decode(payload.slice(offset, offset + Number(reasonLen)));

    return { requestId, errorCode: Number(errorCode), retryInterval, reason };
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
   * draft-ietf-moq-transport-16 Section 10.3
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
   * draft-ietf-moq-transport-16 Section 10.3
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
          extensions: datagram.extensions,
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
   * Handle incoming unidirectional data stream
   * draft-ietf-moq-transport-16 Section 10.4
   *
   * ストリーミング処理: データが到着するたびにオブジェクトをパースして即座に配信する
   */
  private async handleIncomingStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    // 統計カウンターを更新
    this.statsUnidirectionalStreamsReceived++;
    this.statsSubscriberStreamsActive++;

    const reader = stream.getReader();

    // ストリーミングパーサー状態
    let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
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

            if (Number(streamType) === FetchHeaderType) {
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
            } else {
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
                // Subscriber がまだ登録されていない場合、ストリームをバッファリング
                // QUIC ではストリーム間の順序が保証されないため、
                // SUBSCRIBE_OK より先にデータストリームが到着する可能性がある
                const chunks: Uint8Array[] = [buffer];
                let streamDone = done;
                while (!streamDone) {
                  const result = await reader.read();
                  streamDone = result.done;
                  if (result.value) {
                    chunks.push(result.value);
                  }
                }
                // 全データを結合
                const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
                const fullData = new Uint8Array(totalLength);
                let dataOffset = 0;
                for (const chunk of chunks) {
                  fullData.set(chunk, dataOffset);
                  dataOffset += chunk.length;
                }
                // バッファに保存
                const pending = this.pendingSubgroupStreams.get(header.trackAlias) ?? [];
                pending.push({ header, data: fullData });
                this.pendingSubgroupStreams.set(header.trackAlias, pending);
                break;
              }
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
    buffer: Uint8Array<ArrayBufferLike>,
    fetcher: FetcherImpl,
    context: import("./dataStream").FetchObjectContext | null,
    isFirst: boolean,
  ): Uint8Array<ArrayBufferLike> {
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

        const object: MoqtObject = {
          groupId: fields.groupId,
          subgroupId: fields.subgroupId,
          objectId: fields.objectId,
          publisherPriority: fields.publisherPriority,
          status: fields.status,
          extensions:
            fields.extensions && fields.extensions.length > 0 ? fields.extensions : undefined,
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
    buffer: Uint8Array<ArrayBufferLike>,
    subscriber: SubscriberImpl,
    header: import("./dataStream").SubgroupHeader,
    previousObjectId: bigint,
  ): { remainingBuffer: Uint8Array<ArrayBufferLike>; previousObjectId: bigint } {
    let offset = 0;
    let currentPreviousObjectId = previousObjectId;

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

        // ペイロードを抽出
        const payload = buffer.slice(offset, offset + payloadLength);
        offset += payloadLength;

        const object: MoqtObject = {
          groupId: header.groupId,
          subgroupId: header.subgroupId,
          objectId,
          publisherPriority: header.publisherPriority,
          status: fields.status,
          extensions: fields.extensions.length > 0 ? fields.extensions : undefined,
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

        // ペイロードを抽出
        const payload = buffer.slice(fieldsConsumed, fieldsConsumed + payloadLength);
        buffer = buffer.slice(totalNeeded);

        const object: MoqtObject = {
          groupId: header.groupId,
          subgroupId: header.subgroupId,
          objectId,
          publisherPriority: header.publisherPriority,
          status: fields.status,
          extensions: fields.extensions.length > 0 ? fields.extensions : undefined,
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
