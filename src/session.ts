/**
 * MOQT セッション
 * draft-ietf-moq-transport-21 Section 6 (Sessions)
 */

import { type MoqtObject } from "./dataStream";
import { SessionError, SessionErrorCode, normalizeSessionErrorCode } from "./error";
import { type AuthorizationToken, type Location, type RangeFilterSpec } from "./message";
import {
  type Publisher,
  PublisherImpl,
  type SendObjectParams,
  type SendDatagramParams,
} from "./publisher";
import { type Fetcher, FetcherImpl } from "./fetcher";
import { type Subscriber, SubscriberImpl } from "./subscriber";
import { ControlStreamReader, ControlStreamWriter } from "./controlStream";
import type { FetchHeader } from "./dataStream";
import { PendingSubgroupBuffer, type PendingSubgroupBufferOptions } from "./pendingSubgroupBuffer";
import type { MoqtFragment } from "./moqtUri";
import * as bidi from "./session/bidi";
import {
  DEFAULT_CONTROL_MESSAGE_TIMEOUT_MS,
  DEFAULT_DATA_STREAM_TIMEOUT_MS,
  connectionInitialize,
  connectionSendControlMessage,
  type ConnectionInitializeOptions,
  type ConnectionSessionInternal,
} from "./session/connection";
import {
  namespacesCreateNamespacePublication,
  namespacesCreateNamespaceSubscription,
  namespacesCreateTracksSubscription,
  namespacesPublishNamespace,
  namespacesSubscribeNamespace,
  namespacesSubscribeTracks,
  type NamespacesSessionInternal,
} from "./session/namespaces";
import {
  requestsFetch,
  requestsPublish,
  requestsSendDatagram,
  requestsSendObject,
  requestsSubscribe,
  requestsTrackStatus,
  type RequestsSessionInternal,
} from "./session/requests";
import {
  incomingPublishHandleBidirectionalStream,
  incomingPublishStartBidiStreamLoop,
  type IncomingPublishSessionInternal,
} from "./session/incomingPublish";
import {
  dataStreamHandleIncomingStream,
  dataStreamStartDatagramLoop,
  dataStreamStartIncomingStreamLoop,
  type DataStreamSessionInternal,
} from "./session/dataStreamIncoming";
import type { PriorGapTracking } from "./session/priorGapTracking";
import type { FullTrackNameKey } from "./fullTrackName";
import type { PublisherStreamState, SessionInternal } from "./session/types";
import {
  incomingHandleDatagram,
  incomingWaitForFetcher,
  incomingValidateRequestId,
} from "./session/incoming";
import {
  sessionClose,
  sessionCloseControlStreamViolation,
  sessionCloseWithError,
  sessionEmitCallbackErrorDebug,
  sessionEmitDataStreamErrorDebug,
  sessionEmitDebug,
  sessionGoaway,
  sessionHandleControlMessage,
  sessionHandleGoaway,
  sessionMarkRequestObjectsClosed,
  sessionNotifyErrorIfActive,
  sessionOnRequestDrained,
  sessionRejectPendingRequests,
  sessionStartControlMessageLoop,
  type SessionLifecycleInternal,
} from "./session/lifecycle";
import { sessionGetStatistics, type SessionStatistics } from "./session/statistics";
import { AuthTokenCache } from "./session/authTokenCache";

export type { MoqtObject } from "./dataStream";
export type { SessionStatistics } from "./session/statistics";
import type {
  ConnectCallbacks,
  FetchCallbacks,
  FetchOptions,
  NamespacePublication,
  NamespacePublicationCallbacks,
  NamespaceSubscription,
  NamespaceSubscriptionCallbacks,
  PublishCallbacks,
  PublishNamespaceOptions,
  PublishOptions,
  SessionState,
  SubscribeCallbacks,
  SubscribeOptions,
  SubscribeTracksOptions,
  TracksSubscription,
  TracksSubscriptionCallbacks,
  TrackStatusOptions,
  TrackStatusResult,
} from "./session/publicTypes";

export type {
  FillRequestOptions,
  SessionState,
  DebugMessage,
  ConnectCallbacks,
  CertificateHash,
  ConnectOptions,
  PublishCallbacks,
  PublishOptions,
  SubscribeCallbacks,
  SubscribeOptions,
  SubscribeTracksOptions,
  FetchCallbacks,
  FetchOptions,
  TrackStatusOptions,
  TrackStatusResult,
  NamespaceSubscriptionCallbacks,
  NamespaceUpdateOptions,
  TracksUpdateOptions,
  NamespaceSubscription,
  TracksSubscriptionCallbacks,
  TracksSubscription,
  NamespacePublicationCallbacks,
  PublishNamespaceOptions,
  NamespacePublication,
} from "./session/publicTypes";

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
  controlSendStream?: WritableStream<Uint8Array>;
  controlReceiveStream?: ReadableStream<Uint8Array>;
  controlReader?: ControlStreamReader;
  controlWriter?: ControlStreamWriter;

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
  nextRequestId = 0n;
  nextTrackAlias = 0n;

  // GOAWAY 状態
  private receivedGoaway = false;
  // リクエストストリームごとの GOAWAY 受信済みフラグ
  // draft-ietf-moq-transport-21 §9.2 (GOAWAY):
  // 単一リクエストストリーム上の重複 GOAWAY は PROTOCOL_VIOLATION
  goawayReceivedOnRequestStreams = new Set<bigint>();
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
  subscribers = new Map<bigint, SubscriberImpl>();
  subscribersByAlias = new Map<bigint, SubscriberImpl[]>();
  fetchers = new Map<bigint, FetcherImpl>();

  // Subscriber 登録前に到着した Subgroup ストリームをバッファリング
  // draft-ietf-moq-transport-21 §11.3.1:
  // "MAY ... choose to buffer it for a brief period to handle reordering with the
  //  control message that establishes the Track Alias."
  // QUIC ではストリーム間の順序が保証されないため、SUBSCRIBE_OK より先にデータストリームが
  // 到着する可能性があり、それを buffer して reordering を吸収する
  // 上限・タイムアウトは ConnectOptions.pendingSubgroup でユーザーから指定可能
  readonly pendingSubgroupBuffer: PendingSubgroupBuffer;

  // Fetcher 登録待ちの Promise を管理
  // draft-ietf-moq-transport-21 Section 9.12 (FETCH_OK):
  // "A publisher MAY send Objects in response to a FETCH before the
  //  FETCH_OK message is sent."
  // FETCH_OK より先にデータストリームが到着する可能性がある
  fetcherReadyCallbacks = new Map<bigint, Array<() => void>>();

  // fill 要求元の Request ID から購読への関連付け
  // draft-ietf-moq-transport-21 §3.4 (Fill Semantics):
  // fill fetch ストリームの FETCH_HEADER が運ぶ Request ID で引く。
  fillFetchTargets = new Map<bigint, bidi.FillFetchTarget>();

  // リクエストごとの双方向ストリーム管理
  // draft-ietf-moq-transport-21 Section 6.3:
  // リクエストは双方向ストリーム上で送受信される。
  // draft-ietf-moq-transport-21 Section 6.3
  requestStreams = new Map<
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
  pendingPublish = new Map<
    bigint,
    {
      resolve: (pub: Publisher) => void;
      reject: (err: Error) => void;
      impl: PublisherImpl;
    }
  >();
  pendingSubscribe = new Map<
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
  pendingFetch = new Map<
    bigint,
    {
      resolve: (fetcher: Fetcher) => void;
      reject: (err: Error) => void;
      impl: FetcherImpl;
      startLocation?: Location;
    }
  >();
  // 型は bidi.PendingTrackStatus に集約する (trackKey の追加が片側だけにならないようにする)
  pendingTrackStatus = new Map<bigint, bidi.PendingTrackStatus>();
  /**
   * SUBSCRIBE_NAMESPACE の状態管理
   *
   * draft-ietf-moq-transport-21 §9.15 (SUBSCRIBE_NAMESPACE):
   * SUBSCRIBE_NAMESPACE は専用の双方向ストリームで送受信される。
   * 応答として NAMESPACE / NAMESPACE_DONE のみが送られる。
   */
  namespaceSubscriptions = new Map<
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
  tracksSubscriptions = new Map<
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
  namespacePublications = new Map<
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
  publisherStreams = new Map<bigint, PublisherStreamState>();

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
  receivedEndOfGroupFinalObjectIds = new Map<string, bigint>();

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
  dataStreamTimeoutMs = DEFAULT_DATA_STREAM_TIMEOUT_MS;

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
  async initialize(options?: ConnectionInitializeOptions): Promise<void> {
    return connectionInitialize(this as unknown as ConnectionSessionInternal, options);
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
    return requestsPublish(
      this as unknown as RequestsSessionInternal,
      namespace,
      trackName,
      callbacks,
      options,
    );
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
    return requestsSubscribe(
      this as unknown as RequestsSessionInternal,
      namespace,
      trackName,
      callbacks,
      options,
    );
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
    return requestsFetch(
      this as unknown as RequestsSessionInternal,
      namespace,
      trackName,
      options,
      callbacks,
    );
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
    return requestsTrackStatus(
      this as unknown as RequestsSessionInternal,
      namespace,
      trackName,
      options,
    );
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
    return namespacesSubscribeNamespace(
      this as unknown as NamespacesSessionInternal,
      namespacePrefix,
      callbacks,
      options,
    );
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
    return namespacesSubscribeTracks(
      this as unknown as NamespacesSessionInternal,
      namespacePrefix,
      callbacks,
      options,
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
    return namespacesPublishNamespace(
      this as unknown as NamespacesSessionInternal,
      namespace,
      callbacks,
      options,
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
    return sessionGetStatistics(this);
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
  closeWithError(error: SessionError): void {
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
  notifyErrorIfActive(error: Error): void {
    sessionNotifyErrorIfActive(this as unknown as SessionLifecycleInternal, error);
  }

  emitDebug(
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
    return connectionSendControlMessage(
      this as unknown as ConnectionSessionInternal,
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
  sendObject(publisher: PublisherImpl, params: SendObjectParams): Promise<void> {
    return requestsSendObject(this as unknown as RequestsSessionInternal, publisher, params);
  }

  /**
   * datagram を送信する
   * draft-ietf-moq-transport-21 Section 11.2 (Datagrams)
   */
  sendDatagram(publisher: PublisherImpl, params: SendDatagramParams): void {
    return requestsSendDatagram(this as unknown as RequestsSessionInternal, publisher, params);
  }

  startControlMessageLoop(): void {
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
  handleControlMessage(type: number, payload: Uint8Array): void {
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
    return namespacesCreateNamespaceSubscription(
      this as unknown as NamespacesSessionInternal,
      requestId,
    );
  }

  /**
   * TracksSubscription オブジェクトを作成する
   *
   * draft-ietf-moq-transport-21 §9.18 (SUBSCRIBE_TRACKS)
   */
  createTracksSubscription(requestId: bigint): TracksSubscription {
    return namespacesCreateTracksSubscription(
      this as unknown as NamespacesSessionInternal,
      requestId,
    );
  }

  /**
   * NamespacePublication オブジェクトを作成する
   */
  createNamespacePublication(requestId: bigint): NamespacePublication {
    return namespacesCreateNamespacePublication(
      this as unknown as NamespacesSessionInternal,
      requestId,
    );
  }

  startIncomingStreamLoop(): void {
    return dataStreamStartIncomingStreamLoop(this as unknown as DataStreamSessionInternal);
  }

  /**
   * datagram 受信ループを開始する
   * draft-ietf-moq-transport-21 Section 11.2 (Datagrams)
   */
  startDatagramLoop(): void {
    return dataStreamStartDatagramLoop(this as unknown as DataStreamSessionInternal);
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
  startIncomingBidirectionalStreamLoop(): void {
    return incomingPublishStartBidiStreamLoop(this as unknown as IncomingPublishSessionInternal);
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
   * 受信 bidi ストリームを処理する
   *
   * @param stream - 受信した双方向ストリーム
   */
  async handleIncomingBidirectionalStream(stream: WebTransportBidirectionalStream): Promise<void> {
    return incomingPublishHandleBidirectionalStream(
      this as unknown as IncomingPublishSessionInternal,
      stream,
    );
  }

  /**
   * 受信した datagram を処理する
   * draft-ietf-moq-transport-21 Section 11.2 (Datagrams)
   */
  handleIncomingDatagram(data: Uint8Array): void {
    incomingHandleDatagram(this as unknown as SessionInternal, data);
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
  waitForFetcher(requestId: bigint): Promise<FetcherImpl | null> {
    return incomingWaitForFetcher(this as unknown as SessionInternal, requestId);
  }

  /**
   * 受信した単方向データストリームを処理する
   * draft-ietf-moq-transport-21 Section 11.3 / Section 11.4 (Subgroup Streams / Fetch Streams)
   *
   * ストリーミング処理: データが到着するたびにオブジェクトをパースして即座に配信する
   */
  async handleIncomingStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    return dataStreamHandleIncomingStream(this as unknown as DataStreamSessionInternal, stream);
  }

  /**
   * アプリのコールバック例外をデバッグ記録に残す
   *
   * 握り潰した例外を無音にしないための記録である。受信メッセージに対応しない
   * 記録のため payload は空にし、typeName でどのコールバックかを示す。
   * 記録自体の throw (debug コールバックの throw) は呼び出し元へ伝播させない。
   */
  emitCallbackErrorDebug(typeName: string, error: unknown): void {
    sessionEmitCallbackErrorDebug(this as unknown as SessionLifecycleInternal, typeName, error);
  }

  /**
   * DATA_STREAM_ERROR のデバッグログを出力する
   *
   * FETCH データストリームの場合は対象の requestId を含めて追跡できるようにする。
   * fetchHeader は Fetch ヘッダーパース時にのみ設定されるため、非 null なら
   * FETCH データストリームと判定できる。
   */
  emitDataStreamErrorDebug(err: unknown, fetchHeader: FetchHeader | null): void {
    sessionEmitDataStreamErrorDebug(this as unknown as SessionLifecycleInternal, err, fetchHeader);
  }
}
