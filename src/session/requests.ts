/**
 * 要求送信の free function 群
 *
 * SessionImpl の publish / subscribe / fetch / trackStatus と、その送信に使う
 * sendRequest / sendObject / closePublisherStream / sendDatagram /
 * sendPublishStateNotify / sendPublishDone / cancelSubscription / cancelFetch /
 * sendRequestUpdate を free function として抽出する。
 *
 * publish / subscribe / fetch / trackStatus は同期関数である。送信より前に失敗し得る
 * 処理 (検証・認可トークンの正規化・パラメータ構築・encode・フレーミング) を済ませて
 * から応答待ちの Promise を作って pending に登録し、送信の async 部
 * (requestsSendRequest) を detached に開始して Promise を送信より先に返す。
 * これにより、送信待ち (ストリーム作成 / write の await) の間に Session が終了しても、
 * Promise は終了の理由で 1 回だけ settle する (draft-ietf-moq-transport-23 §6.6。
 * 根拠の仕様はドラフトであり将来変更される可能性がある)。
 *
 * draft-ietf-moq-transport-23 Section 6.3:
 * リクエスト (SUBSCRIBE, PUBLISH, FETCH, TRACK_STATUS) は双方向ストリーム上で
 * 送受信される。受信側の処理は bidi.ts / incoming.ts が担当する。
 *
 * 制御メッセージのフレーミング (Type / Message Length) は
 * draft-ietf-moq-transport-23 §9 に従う。
 */

import { ControlStreamReader, type ControlStreamWriter } from "../controlStream";
import {
  GroupOrder,
  MessageParameterType,
  MessageType,
  PublishDoneStatusCode,
  createTrackNamespace,
  encodeLocation,
  encodeTrackName,
  encodeFetchPayload,
  encodePublishPayload,
  encodeSubscribePayload,
  encodeTrackStatusPayload,
  validateFullTrackName,
  isNextObjectLocationFilter,
  type LocationFilter,
  type Parameter,
} from "../message";
import {
  type Publisher,
  PublisherImpl,
  type PublishStateNotifyOptions,
  type SendObjectParamsInternal,
  type SendDatagramParams,
} from "../publisher";
import { type Subscriber, type RequestUpdateOptions, SubscriberImpl } from "../subscriber";
import { type Fetcher, FetcherImpl } from "../fetcher";
import type { MoqtObject } from "../dataStream";
import { InvalidFilterError } from "../error";
import { fullTrackNameKey, type FullTrackNameKey } from "../fullTrackName";
import type { Property } from "../properties";
import * as bidi from "./bidi";
import {
  publishSendObject,
  publishClosePublisherStream,
  publishCloseSubgroup,
  publishSendDatagram,
  publishSendPublishDone,
} from "./publish";
import {
  publishedTracksFanOutDatagram,
  publishedTracksFanOutObject,
  publishedTracksOnPublishFailure,
  publishedTracksOnSubscriptionDone,
  publishedTracksOnSubscriptionEstablished,
  publishedTracksRegisterPublisher,
} from "./publishedTracks";
import {
  buildPublishParameters,
  buildPublishTrackProperties,
  buildSubscribeParameters,
  buildFetchParameters,
  buildTrackStatusParameters,
  collectSubscriptionRangeFilters,
  getDeliveryTimeoutCeiling,
  readSubscriptionDeliveryTimeouts,
  resolveFetchRequestRange,
  validateRangeFilterLimits,
  validateRangeFilterSpecs,
  validateTrackNamespaceForSend,
} from "./params";
import {
  AuthorizationTokenAliasType,
  copyAuthorizationToken,
  type AuthorizationToken,
} from "../message/authorizationToken";
import type { PublishedTrackState, PublisherStreamState, SessionInternal } from "./types";
import type { PendingAuthTokenRequests } from "./authTokenCache";
import type {
  FetchCallbacks,
  FetchOptions,
  PublishCallbacks,
  PublishOptions,
  SessionState,
  SubscribeCallbacks,
  SubscribeOptions,
  TrackStatusOptions,
  TrackStatusResult,
} from "./publicTypes";

/**
 * 要求送信が必要とする SessionImpl のビュー
 *
 * SessionImpl は `as unknown as RequestsSessionInternal` で渡す。
 */
export interface RequestsSessionInternal {
  readonly pendingAuthTokenRequests?: PendingAuthTokenRequests;
  /**
   * 後続メッセージへ付与する Authorization Token を正規化する
   * (draft-ietf-moq-transport-23 §8.9 / §9.1.4)
   */
  normalizeAuthorizationTokenForSend(token: AuthorizationToken): AuthorizationToken;
  /**
   * 送信直前の登録サイズを判定して予約する
   * (draft-ietf-moq-transport-23 §9.1.3 の登録サイズの総和)
   */
  reserveAuthorizationTokenForSend(
    token: AuthorizationToken | undefined,
    requestId: bigint,
  ): boolean;
  /**
   * 送信に至らなかった REGISTER / USE_ALIAS を応答待ちから取り消す
   * (draft-ietf-moq-transport-23 §8.9 / §9.1.3)
   */
  releaseAuthorizationTokenForSend(requestId: bigint): void;

  sessionState: SessionState;
  readonly transport: WebTransport;
  /**
   * 制御メッセージのフレーミングに使う writer (ピアの MAX_CONTROL_MESSAGE_SIZE を
   * 送信上限に持つ。draft-ietf-moq-transport-23 §9.1.8)。initialize() の前は未設定
   */
  readonly controlWriter: ControlStreamWriter | undefined;
  /**
   * 自 endpoint が SETUP で広告した MAX_CONTROL_MESSAGE_SIZE
   * (draft-ietf-moq-transport-23 §9.1.8)。リクエストストリームの受信上限に使う。
   */
  readonly localMaxControlMessageSize: number;
  /** 送信した制御メッセージの数 (SessionStatistics.controlMessagesSent) */
  statsControlMessagesSent: number;

  nextRequestId: bigint;
  nextTrackAlias: bigint;
  receivedGoaway: boolean;
  peerMaxFilterRanges: number;
  grease: boolean;

  readonly pendingPublish: Map<
    bigint,
    {
      resolve: (pub: Publisher) => void;
      reject: (err: Error) => void;
      impl: PublisherImpl;
    }
  >;
  readonly pendingSubscribe: Map<
    bigint,
    {
      resolve: (sub: Subscriber) => void;
      reject: (err: Error) => void;
      impl: SubscriberImpl;
      objectCallback: (object: MoqtObject) => void;
    }
  >;
  readonly pendingFetch: Map<
    bigint,
    {
      resolve: (fetcher: Fetcher) => void;
      reject: (err: Error) => void;
      impl: FetcherImpl;
    }
  >;
  readonly fetcherReadyCallbacks: Map<bigint, Array<() => void>>;
  readonly pendingTrackStatus: Map<bigint, bidi.PendingTrackStatus>;
  readonly publishedTracks: Map<FullTrackNameKey, PublishedTrackState>;
  readonly publisherStreams: Map<bigint, PublisherStreamState>;
  readonly fillFetchTargets: Map<bigint, bidi.FillFetchTarget>;
  /**
   * リクエストごとの双方向ストリーム
   *
   * draft-ietf-moq-transport-23 §6.3: リクエストは双方向ストリームで運ぶ。
   * requestsSendRequest が送信の完了後に登録する。
   */
  readonly requestStreams: Map<bigint, bidi.RequestStreamInfo>;

  onRequestDrained(): void;
  /** debug コールバックへ制御メッセージの送受信を通知する */
  emitDebug(
    direction: "send" | "recv",
    type: number,
    payload: Uint8Array,
    decoded?: Record<string, unknown>,
  ): void;
}

/**
 * PUBLISH を送信し、PUBLISH_OK (REQUEST_OK) で解決する Promise を返す
 *
 * draft-ietf-moq-transport-23 Section 9.8 (PUBLISH)
 *
 * 同期関数であり、送信より前に失敗し得る処理 (検証・認可トークンの正規化・
 * パラメータ構築・encode・フレーミング) は Promise の作成より前に済ませて同期で
 * throw する (このとき認可トークンの予約も pending の登録もしない)。Promise を
 * 作って pendingPublish に登録したら、送信を requestsSendRequest で detached に
 * 開始し、Promise を送信より先に返す。
 */
export function requestsPublish(
  session: RequestsSessionInternal,
  namespace: string[],
  trackName: string,
  callbacks?: PublishCallbacks,
  options?: PublishOptions,
): Promise<Publisher> {
  return requestsPublishInternal(session, namespace, trackName, callbacks, options, "app");
}

/**
 * 受信 SUBSCRIBE_TRACKS への結果 PUBLISH を送るための内部オプション
 *
 * draft-ietf-moq-transport-23 §3.6 (Subscribing to Tracks by Prefix):
 * 受信 SUBSCRIBE_TRACKS 1 件につき、一致する Track ごとに新しい PUBLISH を送る。
 * この関数はアプリの公開 API ではなく、受信側と公開 Track registry
 * (src/session/publishedTracks.ts) だけが使う。
 */
export interface SubscribeTracksPublishOptions {
  /**
   * 結果 PUBLISH の基本オプション
   *
   * PAUSED は受信 SUBSCRIBE_TRACKS の状態から設定する。AUTHORIZATION_TOKEN は
   * §9.19.2 の MUST NOT により結果 PUBLISH に載せないため、ここには指定しない。
   */
  publishOptions?: PublishOptions;
  /**
   * §9.8 の PUBLISH 許可 parameter のうち SUBSCRIBE_TRACKS から引き継ぐものと、
   * SUBSCRIBE_TRACKS_ID (§9.19.21)
   */
  extraParameters?: Parameter[];
  /**
   * 結果 PUBLISH に載せる Track Properties の上書き
   *
   * 受信 SUBSCRIBE_TRACKS の INCLUDE_PROPERTIES=0 (§9.19.22) のときは空配列を
   * 渡す。省略時は publishOptions から組み立てる。
   */
  trackProperties?: Property[];
  /**
   * PublisherImpl の組み立て直後 (送信開始前) に呼ぶフック
   *
   * 派生 subscription を公開 Track registry に紐付け、購読ごとの PAUSED /
   * LOCATION_FILTER / Range Filters を PublisherImpl へ反映するために使う。
   */
  onCreated?: (publisher: PublisherImpl) => void;
}

/**
 * 受信 SUBSCRIBE_TRACKS への結果 PUBLISH を送り、PUBLISH_OK で解決する
 * Promise を返す (内部 API)
 *
 * draft-ietf-moq-transport-23 §3.6 / §9.19.21:
 * SUBSCRIBE_TRACKS_ID に受信 SUBSCRIBE_TRACKS の Request ID を載せ、新しい
 * Request ID と Track Alias を採番した PUBLISH を新しい双方向ストリームで送る。
 * 同期で失敗し得る処理 (検証・encode・フレーミング) は Promise の作成より前に
 * 済ませて throw する点は requestsPublish と同じである。
 */
export function requestsPublishFromSubscribeTracks(
  session: RequestsSessionInternal,
  namespace: string[],
  trackName: string,
  options: SubscribeTracksPublishOptions = {},
): Promise<Publisher> {
  return requestsPublishInternal(
    session,
    namespace,
    trackName,
    undefined,
    options.publishOptions,
    "subscribe-tracks",
    options.extraParameters,
    options.trackProperties,
    options.onCreated,
  );
}

/**
 * PUBLISH 送信の共通実装
 *
 * requestsPublish (アプリの Session.publish) と
 * requestsPublishFromSubscribeTracks (受信 SUBSCRIBE_TRACKS への結果 PUBLISH) の
 * 差分だけを引数にした内部関数である。同期で失敗し得る処理 (検証・認可トークンの
 * 正規化・パラメータ構築・encode・フレーミング) は Promise の作成より前に済ませて
 * 同期で throw する。Promise を作って pendingPublish に登録したら、送信を
 * requestsSendRequest で detached に開始し、Promise を送信より先に返す。
 *
 * @param origin - アプリの公開 ("app") か、受信 SUBSCRIBE_TRACKS への結果 PUBLISH
 *   ("subscribe-tracks") か。公開 Track registry への登録と fan-out の有効化、
 *   終了時の後始末が origin で変わる。
 * @param extraParameters - PUBLISH に追加する parameter (§9.8 の範囲)
 * @param trackPropertiesOverride - Track Properties の上書き (INCLUDE_PROPERTIES=0 用)
 * @param onCreated - PublisherImpl の組み立て直後に呼ぶフック (派生 subscription 用)
 */
function requestsPublishInternal(
  session: RequestsSessionInternal,
  namespace: string[],
  trackName: string,
  callbacks: PublishCallbacks | undefined,
  options: PublishOptions | undefined,
  origin: "app" | "subscribe-tracks",
  extraParameters?: Parameter[],
  trackPropertiesOverride?: Property[],
  onCreated?: (publisher: PublisherImpl) => void,
): Promise<Publisher> {
  if (session.sessionState === "closed") {
    throw new Error("Session is closed");
  }

  // GOAWAY 受信後は新規リクエストを拒否
  // draft-ietf-moq-transport-23 Section 9.2 (GOAWAY)
  if (session.receivedGoaway) {
    throw new Error("Cannot publish after receiving GOAWAY");
  }

  // fail-fast: 空 Track Name はストリーム生成・認証トークン予約・Request ID
  // 消費より前に拒否する (draft-ietf-moq-transport-23 §2.4.1)。
  const trackNamespace = createTrackNamespace(namespace);
  const trackNameBytes = encodeTrackName(trackName);

  const requestId = session.nextRequestId;
  // draft-ietf-moq-transport-23 Section 6.4.2.1: クライアントは偶数の Request ID を使うため 2 ずつ加算する
  session.nextRequestId += 2n;

  const trackAlias = session.nextTrackAlias++;
  // draft-ietf-moq-transport-23 §8.7: Full Track Name 合計長検証
  validateFullTrackName(trackNamespace, trackName);
  // draft-ietf-moq-transport-23 §2.4.3 / §6.5: 予約 namespace / .session の送信拒否
  validateTrackNamespaceForSend(namespace, trackName);

  // パブリッシャー実装を作成
  const impl = new PublisherImpl(
    namespace,
    trackName,
    requestId,
    trackAlias,
    callbacks?.error,
    callbacks?.onPausedChange,
  );

  // GOAWAY コールバックを設定（セッション内部コールバック）
  impl.goawayCallback = callbacks?.goaway;
  // draft-ietf-moq-transport-23 §9.19.19 / §10.6: DYNAMIC_GROUPS を広告した PUBLISH だけが
  // 受信した NEW_GROUP_REQUEST をアプリへ知らせる
  impl.dynamicGroups = options?.dynamicGroups === true;
  impl.newGroupRequestCallback = callbacks?.onNewGroupRequest;

  // draft-ietf-moq-transport-23 §3.1.1 (Pausing Subscriptions):
  // "The initiator of the subscription sets the initial state by including
  //  the PAUSED parameter (Section 9.19.18) in PUBLISH or SUBSCRIBE."
  // PUBLISH 送信時の options.paused (省略時は §9.19.18 のデフォルト 0 = unpaused)
  // を paused 状態として保持する。subscribe() と同パターン。
  impl.setPaused(options?.paused ?? false);

  // 送信コールバックを設定
  impl.onSendObject = (params: SendObjectParamsInternal) =>
    requestsSendObject(session, impl, params);
  // draft-ietf-moq-transport-23 §11.3.2 (Closing Subgroup Streams):
  // Object を送らずに、その track で開いている Subgroup を閉じる。FIN / RESET の選択は
  // publishCloseSubgroup が既存の省略の記録から決める
  impl.onCloseSubgroup = () => requestsCloseSubgroup(session, impl.getTrackAlias());

  // データグラム送信コールバックを設定
  impl.onSendDatagram = (params, providedAtMs) => {
    return requestsSendDatagram(session, impl, params, providedAtMs);
  };

  // draft-ietf-moq-transport-23 §3.1 (Subscriptions):
  // 同じ Track に複数の PUBLISH subscription がある場合、アプリの Publisher からの
  // Object / Datagram を全 subscription へ配信する。fan-out は呼び出した Publisher の
  // 送信を終えた後にセッション側 (publishedTracks) が行う。派生 subscription
  // (受信 SUBSCRIBE_TRACKS 由来) は自分だけに送るため設定しない。
  if (origin === "app") {
    impl.onSendObjectFanOut = (params, providedAtMs) => {
      publishedTracksFanOutObject(
        session as unknown as bidi.BidiSessionInternal,
        impl,
        params,
        providedAtMs,
      );
    };
    impl.onSendDatagramFanOut = (params, providedAtMs) => {
      publishedTracksFanOutDatagram(
        session as unknown as bidi.BidiSessionInternal,
        impl,
        params,
        providedAtMs,
      );
    };
  }

  // PUBLISH_STATE_NOTIFY 送信コールバックを設定
  impl.onNotifyStateChange = (options) => requestsSendPublishStateNotify(session, impl, options);

  impl.onDoneInternal = async (status) => {
    // まずデータストリーム（subgroup 単方向ストリーム）を閉じる（FIN 送信）
    await requestsClosePublisherStream(session, impl.getTrackAlias());
    // その後 PUBLISH_DONE を送信（リクエストストリーム（PUBLISH の bidi ストリーム）の FIN は sendPublishDone 内で送信、draft-ietf-moq-transport-23 §9.9）
    await requestsSendPublishDone(session, impl, status);
    // draft-ietf-moq-transport-23 §3.6 / §9.5.2:
    // この subscription を公開 Track registry から外す。アプリ Publisher の終了で
    // その Full Track Name の Publisher が 1 つも残らなくなった場合は、
    // SUBSCRIBE_TRACKS 由来の subscription にも PUBLISH_DONE (TRACK_ENDED) を送る。
    await publishedTracksOnSubscriptionDone(session as unknown as bidi.BidiSessionInternal, impl);
    // draft-ietf-moq-transport-23 §6.6.1:
    // GOAWAY 受信後に Established 購読が無くなった時点で NO_ERROR で閉じる。
    session.onRequestDrained();
  };

  // PUBLISH メッセージを構築する。
  // buildPublishParameters / buildPublishTrackProperties / encodePublishPayload
  // が throw する場合、pendingPublish.set より前で失敗させるため、
  // 構築・encode は Promise 作成より前に行う (subscribe() の
  // buildSubscribeParameters / fetch() の buildFetchParameters と同じ手順)。
  // draft-ietf-moq-transport-23 §8.9 / §9.1.4: SETUP の REGISTER の登録成否に応じて
  // 後続メッセージへ付与するトークンを正規化する (登録成功 → USE_ALIAS、
  // 登録失敗 → USE_VALUE)。詳細は normalizeAuthorizationTokenForSend の JSDoc。
  const normalizedOptions = requestsNormalizeAuthorizationToken(session, options);
  const parameters = buildPublishParameters(normalizedOptions, extraParameters);
  // §9.19.17: 既に Object を公開した Track の PUBLISH には最大位置を載せる。
  const largest = session.publishedTracks.get(fullTrackNameKey(namespace, trackName))
    ?.sharedLargestLocation.largest;
  if (largest !== undefined && largest !== null) {
    parameters.push({ type: MessageParameterType.LARGEST_OBJECT, value: encodeLocation(largest) });
  }
  const trackProperties =
    trackPropertiesOverride ?? buildPublishTrackProperties(options, session.grease);

  // PUBLISH メッセージを双方向ストリームで送信
  // draft-ietf-moq-transport-23 Section 9.8 (PUBLISH):
  // "The publisher sends PUBLISH as the first message on a new
  //  bidirectional stream to initiate a subscription for a Track."
  // draft-ietf-moq-transport-23 Section 6.3
  const publishMsg = {
    type: MessageType.PUBLISH,
    requestId,
    trackNamespace,
    trackName: trackNameBytes,
    trackAlias,
    parameters,
    trackProperties,
  };

  // encode とフレーミング (controlWriter の確認と、ピアの MAX_CONTROL_MESSAGE_SIZE の
  // 判定。draft-ietf-moq-transport-23 §9 / §9.1.8) は Promise の作成より前に行い、
  // 予約と pending の登録より前の同期の throw にする
  const payload = encodePublishPayload(publishMsg);
  const framed = bidi.bidiFrameRequestMessage(session, MessageType.PUBLISH, payload);
  impl.updateSubscriptionDeliveryTimeouts(...readSubscriptionDeliveryTimeouts(parameters));

  const bidiSession = session as unknown as bidi.BidiSessionInternal;
  // draft-ietf-moq-transport-23 §3.6 / §9.19.21:
  // 公開済み Track registry への登録は、PUBLISH のフレーミングが通った後
  // (送信を開始する時点) に行う。アプリの公開では、既に受理済みの
  // SUBSCRIBE_TRACKS のうち一致する要求へ結果 PUBLISH を送る。
  if (origin === "app") {
    publishedTracksRegisterPublisher(bidiSession, impl, namespace, trackName, trackProperties);
  }
  // 派生 subscription の PublisherImpl へ registry のキーと購読フィルタを設定する。
  // 送信開始前に設定することで、PUBLISH_OK の直後から fan-out の対象にできる。
  onCreated?.(impl);

  // 送信の入力は、呼び出し元の Promise の reject を除いて Promise の作成より前に組み立てる
  const request: Omit<RequestSendRequest, "reject"> = {
    requestId,
    type: MessageType.PUBLISH,
    payload,
    framed,
    decoded: {
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
    },
    normalizedOptions,
    pending: session.pendingPublish,
    deletesFillFetchTarget: false,
    priorGapTrackingKey: undefined,
    readResponse: bidi.bidiReadPublishResponse,
  };

  // PUBLISH_OK の Promise を送信より先に作り、pendingPublish に登録する。
  // 送信は detached に行い、呼び出し元へは Promise をすぐ返す。送信待ちの間に
  // Session が終了しても、sessionRejectPendingRequests が終了の理由で reject する
  const promise = new Promise<Publisher>((resolve, reject) => {
    session.pendingPublish.set(requestId, { resolve, reject, impl });
    void requestsSendRequest(session, { ...request, reject });
  });

  // draft-ietf-moq-transport-23 §3.6 / §5.2:
  // PUBLISH_OK を受けて購読が確立したら registry に追加する。REQUEST_ERROR や
  // 送信失敗で確立できなかった場合は registry から外す (最後のアプリ Publisher
  // だった場合は、その Track の派生 subscription を PUBLISH_DONE で閉じる)。
  // どちらのハンドラも例外を外へ出さない (戻り値を使わない .then のため、
  // throw すると unhandled rejection になる)。
  promise.then(
    () => {
      publishedTracksOnSubscriptionEstablished(bidiSession, impl);
    },
    () => {
      try {
        publishedTracksOnPublishFailure(bidiSession, impl);
      } catch {
        // 後始末の失敗は PUBLISH の reject 理由を上書きしない
      }
    },
  );
  return promise;
}
/**
 * SUBSCRIBE を送信し、SUBSCRIBE_OK で解決する Promise を返す
 *
 * draft-ietf-moq-transport-23 Section 9.6 (SUBSCRIBE)
 *
 * 同期関数であり、送信より前に失敗し得る処理 (検証・認可トークンの正規化・
 * パラメータ構築・encode・フレーミング) は Promise の作成より前に済ませて同期で
 * throw する (このとき認可トークンの予約も pending と fill の関連付けの登録も
 * しない)。Promise を作って pendingSubscribe と fill の関連付けを登録したら、
 * 送信を requestsSendRequest で detached に開始し、Promise を送信より先に返す。
 */
export function requestsSubscribe(
  session: RequestsSessionInternal,
  namespace: string[],
  trackName: string,
  callbacks: SubscribeCallbacks,
  options?: SubscribeOptions,
): Promise<Subscriber> {
  if (session.sessionState === "closed") {
    throw new Error("Session is closed");
  }

  // GOAWAY 受信後は新規リクエストを拒否
  // draft-ietf-moq-transport-23 Section 9.2 (GOAWAY)
  if (session.receivedGoaway) {
    throw new Error("Cannot subscribe after receiving GOAWAY");
  }

  // draft-ietf-moq-transport-23 §9.19.8 / §9.19.22:
  // SUBSCRIBE で GROUP_ORDER を省略した場合、publisher の Track の設定
  // (DEFAULT_PUBLISHER_GROUP_ORDER) を使う。INCLUDE_PROPERTIES=0 は SUBSCRIBE_OK の
  // Track Properties を空にする (SHOULD) ため、送信前に publisher の既定を知る手段が
  // 無い。fill fetch ストリームは SUBSCRIBE_OK より先に届き得るため、既定を推測して
  // Object をデコードすると Group ID を誤る (§11.4.1.1)。よって送信前に拒否する。
  if (
    options?.fill !== undefined &&
    options.fill.groupOrder === undefined &&
    options.groupOrder === undefined &&
    options.includeProperties === false
  ) {
    throw new InvalidFilterError(
      "fill without GROUP_ORDER cannot be decoded when includeProperties=false: set fill.groupOrder or groupOrder",
    );
  }

  // draft-ietf-moq-transport-23 §8.9 / §9.1.4: SETUP の REGISTER の登録成否に応じて
  // 後続メッセージへ付与するトークンを正規化する (登録成功 → USE_ALIAS、
  // 登録失敗 → USE_VALUE)。詳細は normalizeAuthorizationTokenForSend の JSDoc。
  const normalizedOptions = requestsNormalizeAuthorizationToken(session, options);

  // fail-fast: 空 Track Name はストリーム生成・認証トークン予約・Request ID
  // 消費より前に拒否する (draft-ietf-moq-transport-23 §2.4.1)。
  const trackNamespace = createTrackNamespace(namespace);
  const trackNameBytes = encodeTrackName(trackName);

  const requestId = session.nextRequestId;
  // draft-ietf-moq-transport-23 Section 6.4.2.1: クライアントは偶数の Request ID を使うため 2 ずつ加算する
  session.nextRequestId += 2n;
  // draft-ietf-moq-transport-23 §8.7: Full Track Name 合計長検証
  validateFullTrackName(trackNamespace, trackName);
  // draft-ietf-moq-transport-23 §2.4.3 / §6.5: 予約 namespace / .session の送信拒否
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

  // GOAWAY / fill 失敗 / Subgroup の stream の終わりのコールバックを設定
  // （セッション内部コールバック）
  impl.setSessionCallbacks(callbacks);

  // draft-ietf-moq-transport-23 §3.1.1 (Pausing Subscriptions):
  // "The initiator of the subscription sets the initial state by including
  //  the PAUSED parameter (Section 9.19.18) in PUBLISH or SUBSCRIBE."
  // SUBSCRIBE 送信時の options.paused (省略時は §9.19.18 のデフォルト 0 = unpaused)
  // を paused 状態として保持する。
  impl.setPaused(options?.paused ?? false);

  // draft-ietf-moq-transport-23 §9.19.8 / §9.19.15:
  // SUBSCRIBE 送信時の options.groupOrder を保持する。fill 要求時の
  // Group Order 解決 (FILL 内の指定が無ければ subscription の値) に使う。
  impl.setGroupOrder(options?.groupOrder);

  // draft-ietf-moq-transport-23 Section 3.3.1: Location Filter を設定
  impl.setLocationFilter(options?.filter);

  // draft-ietf-moq-transport-23 Section 3.3.2: Range Filters を設定
  impl.setRangeFilters(options?.rangeFilters);

  // draft-ietf-moq-msf-02 §11.5.3: 後続の REQUEST_UPDATE に同じトークンを付与するため保持
  // draft-ietf-moq-transport-23 §8.9: SUBSCRIBE で登録した Alias を REQUEST_UPDATE で
  // 再 REGISTER すると、ピアは DUPLICATE_AUTH_TOKEN_ALIAS でセッションを閉じる。
  // 保持する値は REQUEST_UPDATE 用に正規化する (登録済み Alias は USE_ALIAS で参照する)
  impl.setAuthorizationToken(requestsTokenForRequestUpdate(normalizedOptions?.authorizationToken));

  // サブスクリプションキャンセルのコールバック
  impl.onUnsubscribe = async () => {
    await requestsCancelSubscription(session, impl);
  };

  // 更新コールバックを設定
  impl.onUpdate = async (updateOptions: RequestUpdateOptions) => {
    await requestsSendRequestUpdate(session, impl, updateOptions);
  };

  // draft-ietf-moq-transport-23 §9.1.6: ピアの MAX_FILTER_RANGES が 0 のとき、および
  // 購読単位の Ranges 合計が上限を超えるときは Range Filter を送信できない。
  // pendingSubscribe.set より前に配置し、throw 時に pending エントリが残らないようにする
  // fill 内側の Range Filters も購読単位の上限に含める (§9.1.6)。
  validateRangeFilterLimits(
    collectSubscriptionRangeFilters(options?.rangeFilters, options?.fill),
    session.peerMaxFilterRanges,
    "SUBSCRIBE",
  );

  // draft-ietf-moq-transport-23 §3.3.2:
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
  const parameters = buildSubscribeParameters(normalizedOptions);
  impl.noteDeliveryTimeout(getDeliveryTimeoutCeiling(parameters));

  // SUBSCRIBE メッセージを双方向ストリームで送信
  // draft-ietf-moq-transport-23 Section 9.6 (SUBSCRIBE):
  // SUBSCRIBE は新しい双方向ストリームで送信される。
  // draft-ietf-moq-transport-23 Section 6.3
  const subscribeMsg = {
    type: MessageType.SUBSCRIBE,
    requestId,
    trackNamespace,
    trackName: trackNameBytes,
    parameters,
  };

  // encode とフレーミング (controlWriter の確認と、ピアの MAX_CONTROL_MESSAGE_SIZE の
  // 判定。draft-ietf-moq-transport-23 §9 / §9.1.8) は Promise の作成より前に行い、
  // 予約と pending の登録より前の同期の throw にする (fill の関連付けも
  // 登録しない)
  const payload = encodeSubscribePayload(subscribeMsg);
  const framed = bidi.bidiFrameRequestMessage(session, MessageType.SUBSCRIBE, payload);

  // draft-ietf-moq-transport-23 §3.4 (Fill Semantics):
  // fill を要求した SUBSCRIBE の Request ID を購読に関連付ける。
  // SUBSCRIBE_OK 受理で pending は消えるが、fill ストリーム到着まで保持する。
  // §9.19.8 / §10.5: FILL_PARAMETERS 内にも SUBSCRIBE にも GROUP_ORDER が無い
  // 場合、Group Order は SUBSCRIBE_OK の Track Properties で決まるため、
  // 確定待ちの target を作る。fill ストリームは確定までデコードしない。
  // 登録は pending と同時に Promise の executor で行い、受信ループを開始しない場合
  // (送信を終えられなかった、または送信後に Session が閉じていた場合) は
  // requestsSendRequest が両方を削除する
  const fillFetchTarget =
    options?.fill !== undefined
      ? bidi.createInitialFillFetchTarget(impl, options.fill.groupOrder, options.groupOrder)
      : undefined;

  // 送信の入力は、呼び出し元の Promise の reject を除いて Promise の作成より前に組み立てる
  const request: Omit<RequestSendRequest, "reject"> = {
    requestId,
    type: MessageType.SUBSCRIBE,
    payload,
    framed,
    decoded: {
      requestId: requestId.toString(),
      trackNamespace: namespace,
      trackName,
      filter: requestsDescribeLocationFilter(options?.filter),
      OBJECT_DELIVERY_TIMEOUT: options?.deliveryTimeout?.toString(),
      SUBSCRIBER_PRIORITY: options?.subscriberPriority,
      GROUP_ORDER: options?.groupOrder,
      NEW_GROUP_REQUEST: options?.newGroupRequest?.toString(),
    },
    normalizedOptions,
    pending: session.pendingSubscribe,
    deletesFillFetchTarget: true,
    priorGapTrackingKey: impl.getFullTrackNameKey(),
    readResponse: bidi.bidiReadSubscribeResponse,
  };

  // SUBSCRIBE_OK の Promise を送信より先に作り、pendingSubscribe に登録する。
  // 送信は detached に行い、呼び出し元へは Promise をすぐ返す。送信待ちの間に
  // Session が終了しても、sessionRejectPendingRequests が終了の理由で reject する
  return new Promise<Subscriber>((resolve, reject) => {
    session.pendingSubscribe.set(requestId, {
      resolve,
      reject,
      impl,
      objectCallback: callbacks.object,
    });
    if (fillFetchTarget !== undefined) {
      session.fillFetchTargets.set(requestId, fillFetchTarget);
    }
    void requestsSendRequest(session, { ...request, reject });
  });
}

/**
 * FETCH を送信し、成功応答 (REQUEST_OK / FETCH_OK) で解決する Promise を返す
 *
 * draft-ietf-moq-transport-23 Section 9.11 (FETCH)
 *
 * 同期関数であり、送信より前に失敗し得る処理 (検証・認可トークンの正規化・
 * パラメータ構築・encode・フレーミング) は Promise の作成より前に済ませて同期で
 * throw する (このとき認可トークンの予約も pending の登録もしない)。Promise を
 * 作って pendingFetch に登録したら、送信を requestsSendRequest で detached に
 * 開始し、Promise を送信より先に返す。
 */
export function requestsFetch(
  session: RequestsSessionInternal,
  namespace: string[],
  trackName: string,
  options: FetchOptions,
  callbacks: FetchCallbacks,
): Promise<Fetcher> {
  if (session.sessionState === "closed") {
    throw new Error("Session is closed");
  }

  // GOAWAY 受信後は新規リクエストを拒否
  if (session.receivedGoaway) {
    throw new Error("Cannot fetch after receiving GOAWAY");
  }

  // draft-ietf-moq-transport-23 §3.2 (Fetch):
  // "If the Location filter is relative (see Section 9.19.9), the publisher MUST
  //  return REQUEST_ERROR with error code INVALID_RANGE."
  // 応答を待たずに送信前で拒否する。要求範囲の確定は Request ID の消費などの
  // 副作用より前に置き、相対指定 (0x01) / Next Object (0x05) / End Group 超過を
  // ここで throw させる。この制約は FETCH の要求だけに適用し、共通 codec や
  // FILL_PARAMETERS の内側の相対指定には適用しない。
  const fetchRequestRange = resolveFetchRequestRange(options?.filter);

  // fail-fast: 空 Track Name はストリーム生成・認証トークン予約・Request ID
  // 消費より前に拒否する (draft-ietf-moq-transport-23 §2.4.1)。
  const trackNamespace = createTrackNamespace(namespace);
  const trackNameBytes = encodeTrackName(trackName);

  const requestId = session.nextRequestId;
  session.nextRequestId += 2n;
  // draft-ietf-moq-transport-23 §8.7: Full Track Name 合計長検証
  validateFullTrackName(trackNamespace, trackName);
  // draft-ietf-moq-transport-23 §2.4.3 / §6.5: 予約 namespace / .session の送信拒否
  validateTrackNamespaceForSend(namespace, trackName);

  // draft-ietf-moq-transport-23 §9.1.6: ピアの MAX_FILTER_RANGES を超える Range Filter 送信をガード
  // pendingFetch.set より前に配置し、throw 時に pending エントリが残らないようにする
  validateRangeFilterLimits(options?.rangeFilters, session.peerMaxFilterRanges, "FETCH");

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

  // draft-ietf-moq-transport-23 §9.19.8 / §11.4.1.1:
  // FETCH 送信時の options.groupOrder を保持し、FETCH 応答の Group ID 復号に
  // 使う。GROUP_ORDER は FETCH の OK 応答 (REQUEST_OK) に出現できないため、
  // 復号の根拠は要求時の値だけにする。省略時は Ascending (§9.19.8 の既定値であり、
  // fill fetch の resolveFillGroupOrder と同じ扱い)。
  impl.setGroupOrder(
    options.groupOrder === "Descending" ? GroupOrder.DESCENDING : GroupOrder.ASCENDING,
  );

  // draft-ietf-moq-transport-23 §3.2: 成功応答の終端は要求範囲と LARGEST_OBJECT から
  // 確定するため、要求範囲を Fetcher に保持する
  impl.setFetchRequestRange(fetchRequestRange);

  // draft-ietf-moq-transport-23 §3.2.2 (Gaps in a Fetch Stream):
  // Range Filter を含む要求では、応答のマークされていない gap は Unknown 状態の
  // Object を示す。非存在と誤認しないよう、要求時の有無を Fetcher に保持する。
  impl.setFetchRequestRangeFiltersPresent((options?.rangeFilters?.length ?? 0) > 0);

  // draft-ietf-moq-transport-23 Section 3.2.4:
  // キャンセルは bidi リクエストストリームへ STOP_SENDING を送ることで行う (MUST)。
  impl.onCancel = async () => {
    await requestsCancelFetch(session, impl);
  };

  // FETCH メッセージを構築する
  // draft-ietf-moq-transport-23 Section 9.11 (FETCH):
  // FETCH は新しい双方向ストリームで送信される。
  // draft-ietf-moq-transport-23 Section 6.3
  // buildFetchParameters (buildRangeFilterParameters / encodeLocationFilter を含む)
  // が throw する場合、pendingFetch.set より前で失敗させるため、
  // 構築は Promise 作成より前に行う。
  const normalizedOptions = requestsNormalizeAuthorizationToken(session, options);
  const fetchMsg = {
    type: MessageType.FETCH,
    requestId,
    trackNamespace,
    trackName: trackNameBytes,
    parameters: buildFetchParameters(normalizedOptions),
  };

  // encode とフレーミング (controlWriter の確認と、ピアの MAX_CONTROL_MESSAGE_SIZE の
  // 判定。draft-ietf-moq-transport-23 §9 / §9.1.8) は Promise の作成より前に行い、
  // 予約と pending の登録より前の同期の throw にする
  const payload = encodeFetchPayload(fetchMsg);
  const framed = bidi.bidiFrameRequestMessage(session, MessageType.FETCH, payload);

  // 送信の入力は、呼び出し元の Promise の reject を除いて Promise の作成より前に組み立てる
  const request: Omit<RequestSendRequest, "reject"> = {
    requestId,
    type: MessageType.FETCH,
    payload,
    framed,
    decoded: {
      requestId: requestId.toString(),
      trackNamespace: namespace,
      trackName,
      filter: requestsDescribeLocationFilter(options.filter),
    },
    normalizedOptions,
    pending: session.pendingFetch,
    deletesFillFetchTarget: false,
    priorGapTrackingKey: impl.getFullTrackNameKey(),
    readResponse: bidi.bidiReadFetchResponse,
  };

  // 成功応答 (REQUEST_OK / FETCH_OK) を待つ Promise を送信より先に作り、
  // pendingFetch に登録する。送信は detached に行い、呼び出し元へは Promise を
  // すぐ返す。送信待ちの間に Session が終了しても、sessionRejectPendingRequests が
  // 終了の理由で reject する
  return new Promise<Fetcher>((resolve, reject) => {
    session.pendingFetch.set(requestId, { resolve, reject, impl });
    void requestsSendRequest(session, { ...request, reject });
  });
}

/**
 * TRACK_STATUS を送信し、REQUEST_OK (TRACK_STATUS_OK) で解決する Promise を返す
 *
 * draft-ietf-moq-transport-23 Section 9.12 (TRACK_STATUS)
 *
 * 同期関数であり、送信より前に失敗し得る処理 (検証・認可トークンの正規化・
 * パラメータ構築・encode・フレーミング) は Promise の作成より前に済ませて同期で
 * throw する (このとき認可トークンの予約も pending の登録もしない)。Promise を
 * 作って pendingTrackStatus に登録したら、送信を requestsSendRequest で detached に
 * 開始し、Promise を送信より先に返す。
 */
export function requestsTrackStatus(
  session: RequestsSessionInternal,
  namespace: string[],
  trackName: string,
  options?: TrackStatusOptions,
): Promise<TrackStatusResult> {
  if (session.sessionState === "closed") {
    throw new Error("Session is closed");
  }

  // GOAWAY 受信後は新規リクエストを拒否
  if (session.receivedGoaway) {
    throw new Error("Cannot query track status after receiving GOAWAY");
  }

  // fail-fast: 空 Track Name はストリーム生成・認証トークン予約・Request ID
  // 消費より前に拒否する (draft-ietf-moq-transport-23 §2.4.1)。
  const trackNamespace = createTrackNamespace(namespace);
  const trackNameBytes = encodeTrackName(trackName);

  const requestId = session.nextRequestId;
  session.nextRequestId += 2n;
  // draft-ietf-moq-transport-23 §8.7: Full Track Name 合計長検証
  validateFullTrackName(trackNamespace, trackName);
  // draft-ietf-moq-transport-23 §2.4.3 / §6.5: 予約 namespace / .session の送信拒否
  validateTrackNamespaceForSend(namespace, trackName);

  // TRACK_STATUS メッセージを双方向ストリームで送信
  // draft-ietf-moq-transport-23 Section 9.12 (TRACK_STATUS):
  // TRACK_STATUS は新しい双方向ストリームで送信される。
  // draft-ietf-moq-transport-23 Section 6.3
  // draft-ietf-moq-transport-23 Section 9.19.22:
  // INCLUDE_PROPERTIES は buildTrackStatusParameters で載せる (省略時は送らない)。
  const normalizedOptions = requestsNormalizeAuthorizationToken(session, options);
  const trackStatusMsg = {
    type: MessageType.TRACK_STATUS,
    requestId,
    trackNamespace,
    trackName: trackNameBytes,
    parameters: buildTrackStatusParameters(normalizedOptions),
  };

  // encode とフレーミング (controlWriter の確認と、ピアの MAX_CONTROL_MESSAGE_SIZE の
  // 判定。draft-ietf-moq-transport-23 §9 / §9.1.8) は Promise の作成より前に行い、
  // 予約と pending の登録より前の同期の throw にする
  const payload = encodeTrackStatusPayload(trackStatusMsg);
  const framed = bidi.bidiFrameRequestMessage(session, MessageType.TRACK_STATUS, payload);

  // draft-ietf-moq-transport-23 §12.1: malformed Track の検出時に同一 Track の
  // 購読 / FETCH を cross-cancel するため、比較キーを pending に保持する。
  const trackKey = fullTrackNameKey(namespace, trackName);

  // 送信の入力は、呼び出し元の Promise の reject を除いて Promise の作成より前に組み立てる
  const request: Omit<RequestSendRequest, "reject"> = {
    requestId,
    type: MessageType.TRACK_STATUS,
    payload,
    framed,
    decoded: {
      requestId: requestId.toString(),
      trackNamespace: namespace,
      trackName,
    },
    normalizedOptions,
    pending: session.pendingTrackStatus,
    deletesFillFetchTarget: false,
    priorGapTrackingKey: undefined,
    readResponse: bidi.bidiReadTrackStatusResponse,
  };

  // REQUEST_OK を待つ Promise を送信より先に作り、pendingTrackStatus に登録する。
  // 送信は detached に行い、呼び出し元へは Promise をすぐ返す。送信待ちの間に
  // Session が終了しても、sessionRejectPendingRequests が終了の理由で reject する
  return new Promise<TrackStatusResult>((resolve, reject) => {
    session.pendingTrackStatus.set(requestId, { resolve, reject, trackKey });
    void requestsSendRequest(session, { ...request, reject });
  });
}

/**
 * リクエストの送信 (requestsSendRequest) に必要な入力
 *
 * 引数が多くなり取り違えやすいため 1 つのオブジェクトにまとめる
 * (namespaces.ts の NamespacePublishSendRequest と同じ)。4 API (PUBLISH /
 * SUBSCRIBE / FETCH / TRACK_STATUS) で異なる後始末 (応答待ちの登録先・fill の
 * 関連付け・Track 単位の追跡) と、送信の完了後に開始する受信ループもここで渡す。
 */
interface RequestSendRequest {
  requestId: bigint;
  /** メッセージタイプ (debug の send イベントに使う) */
  type: number;
  /** エンコード済みペイロード (debug の send イベントに使う) */
  payload: Uint8Array;
  /** bidi.bidiFrameRequestMessage が同期部でフレーミングしたメッセージ */
  framed: Uint8Array;
  /** debug の send イベントに載せるデコード済みメッセージ */
  decoded: Record<string, unknown>;
  /**
   * 認可トークンを正規化した options
   *
   * draft-ietf-moq-transport-23 §9.1.3: REGISTER のトークンは write の直前に予約し、
   * 送信に至らなかった場合は取り消す。
   */
  normalizedOptions: { authorizationToken?: AuthorizationToken } | undefined;
  /** 呼び出し元の Promise の reject */
  reject: (error: Error) => void;
  /**
   * 応答待ちの登録先 (pendingPublish / pendingSubscribe / pendingFetch /
   * pendingTrackStatus)
   *
   * 受信ループを開始しない場合 (送信を終えられなかった、または送信後に Session が
   * 閉じていた場合) は、ここから requestId のエントリを削除する。
   */
  pending: { delete(requestId: bigint): boolean };
  /**
   * 受信ループを開始しない場合に fill の関連付けを削除するか
   *
   * draft-ietf-moq-transport-23 §9.19.15: FILL_PARAMETERS は SUBSCRIBE /
   * SUBSCRIBE_TRACKS / PUBLISH / REQUEST_UPDATE に載る。このうち 4 API で fill を
   * 指定できるのは subscribe() だけ (PublishOptions は fill を持たず、FETCH /
   * TRACK_STATUS は FILL_PARAMETERS を運べない) のため、SUBSCRIBE だけが true にする。
   */
  deletesFillFetchTarget: boolean;
  /**
   * Track 単位の追跡の解放を判定する Track の比較キー (SUBSCRIBE / FETCH だけ。
   * 他は undefined)
   *
   * draft-ietf-moq-transport-23 §12.1 条件 10 の検出に使う Track 単位の状態は、
   * その Track の購読と FETCH が尽きた時点で解放する (解放時期は §12.1 の規定
   * ではなく実装判断)。pending の Map から要求の実装を引き直すと、Session の終了で
   * pending が clear された後は引けないため、同期部で求めたこのキーを使う。
   */
  priorGapTrackingKey: FullTrackNameKey | undefined;
  /**
   * 送信の完了後に開始する受信ループ (bidi.bidiReadPublishResponse /
   * bidiReadSubscribeResponse / bidiReadFetchResponse / bidiReadTrackStatusResponse)
   */
  readResponse: typeof bidi.bidiReadPublishResponse;
}

/**
 * Session の状態を読む
 *
 * await や関数呼び出し (debug コールバック等) を挟んでも TypeScript はプロパティの
 * narrowing を保持するため、送信の各段階での状態確認は関数経由で行い、narrowing の
 * 影響を受けないようにする。
 * request 系の送信 (requestsSendRequest) と、PUBLISH_NAMESPACE の送信
 * (namespaces.ts の namespacesSendPublishNamespace) と、SUBSCRIBE_NAMESPACE /
 * SUBSCRIBE_TRACKS の送信 (namespaces.ts の namespacesSendSubscription) で共用する。
 */
export function requestsReadSessionState(session: {
  readonly sessionState: SessionState;
}): SessionState {
  return session.sessionState;
}

/**
 * 受信ループを開始しないリクエストの登録を解除し、呼び出し元の Promise を reject する
 *
 * 送信を終えられなかった場合と、送信後に Session が閉じていた場合に呼ぶ。
 * 応答待ちの登録を削除してから、SUBSCRIBE の fill の関連付けと Track 単位の追跡を
 * 解放し、最後に reject する。clearPriorGapTrackingIfUnused は応答待ちの pending を
 * 「利用中」と数えるため、pending の削除を先に行う。
 *
 * 登録の解除 (Map.delete / deleteFillFetchTarget / clearPriorGapTrackingIfUnused) は
 * throw しない前提である。requestsSendRequest が reject しないことは、この前提と
 * ストリームの解放の補助関数が reject しないことに拠る。
 *
 * 呼び出し元はこの関数をストリームの解放 (await を伴う) より先に呼ぶ。解放の
 * await 中に Session が終了しても、sessionRejectPendingRequests が汎用の終了の
 * 理由で先に reject しないようにするためである。sessionRejectPendingRequests が
 * 既に reject している場合でも、Promise の settle は 1 回だけなので reject は
 * no-op になる。
 *
 * @param error - reject の理由 (Error 以外の throw 値は Error に変換する)
 */
function requestsAbandonRequest(
  session: RequestsSessionInternal,
  request: RequestSendRequest,
  error: unknown,
): void {
  request.pending.delete(request.requestId);
  if (request.type === MessageType.FETCH) {
    bidi.fireFetcherReadyCallbacks(session, request.requestId);
  }
  if (request.deletesFillFetchTarget) {
    // draft-ietf-moq-transport-23 §3.4.1: 受信ループを開始しない SUBSCRIBE の
    // fill fetch ストリームは受け取らないため、関連付けは不要になる
    bidi.deleteFillFetchTarget(session, request.requestId);
  }
  if (request.priorGapTrackingKey !== undefined) {
    // draft-ietf-moq-transport-23 §12.1 条件 10 の検出に使う Track 単位の状態は、
    // その Track の利用者がいなくなった時点で解放する (解放時期は §12.1 の規定
    // ではなく実装判断)。受信ループを開始せずに応答待ちが消える経路でも解放する。
    bidi.clearPriorGapTrackingIfUnused(
      session as unknown as bidi.BidiSessionInternal,
      request.priorGapTrackingKey,
    );
  }
  request.reject(error instanceof Error ? error : new Error(String(error)));
}

/**
 * reader / writer のロックを取得する前の双方向ストリームを解放する
 *
 * ストリームの作成の後に送信を進められない場合 (作成の await 中に Session が
 * 終了した、または reader / writer の取得に失敗した場合) に、ロックを取らずに
 * readable を cancel (STOP_SENDING 相当) し、writable を abort (RESET_STREAM 相当)
 * する。readable / writable が他でロックされていれば cancel / abort は失敗するため
 * 無視する。片方の失敗で他方を飛ばさないよう、cancel と abort は別々に試みる。
 * writer のロックを取得した後の解放は requestsReleaseLockedStream が担う。
 * この関数は reject しない。request 系の送信 (requestsSendRequest) と、
 * PUBLISH_NAMESPACE の送信 (namespaces.ts の namespacesSendPublishNamespace) と、
 * SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS の送信 (namespaces.ts の
 * namespacesSendSubscription) で共用する。
 */
export async function requestsReleaseUnlockedStream(
  stream: WebTransportBidirectionalStream,
  reason: string,
): Promise<void> {
  try {
    await stream.readable.cancel(reason);
  } catch {
    // 閉じかけ・他でロック済みのストリーム操作の失敗は無視する
  }
  try {
    await stream.writable.abort(reason);
  } catch {
    // 閉じかけ・他でロック済みのストリーム操作の失敗は無視する
  }
}

/**
 * writer のロックを取得した後の双方向ストリームを解放する
 *
 * readable を cancel (STOP_SENDING 相当) し、writer を abort (RESET_STREAM 相当) して
 * ロックを外す。bidiCancelSubscription / bidiCancelFetch と同形であり、FIN である
 * writer.close() は使わない。受信ループを開始する前のため readable のロックは
 * 取っておらず、ストリームから直接 cancel する。片方の失敗で他方を飛ばさないよう、
 * cancel と abort は別々に試みる。ロックを取得する前の解放は
 * requestsReleaseUnlockedStream が担う。この関数は reject しない。
 */
async function requestsReleaseLockedStream(
  stream: WebTransportBidirectionalStream,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  reason: string,
): Promise<void> {
  try {
    await stream.readable.cancel(reason);
  } catch {
    // 閉じかけのストリーム操作の失敗は無視する
  }
  try {
    await writer.abort(reason);
  } catch {
    // 閉じかけのストリーム操作の失敗は無視する
  } finally {
    writer.releaseLock();
  }
}

/**
 * リクエストを双方向ストリームで送信し、受信ループを開始しない場合は呼び出し元の
 * Promise を reject する (送信の async 部)
 *
 * draft-ietf-moq-transport-23 §6.3 / §9 (Table 5) / §9.8 / §9.11 / §9.12:
 * リクエスト (SUBSCRIBE, PUBLISH, FETCH, TRACK_STATUS) は新しい双方向ストリームの
 * 先頭メッセージとして送る。§9 の Table 5 はこの 4 つを "First" とし、
 * "Messages marked "First" MUST be the first message on a new request stream."
 * と定める (§9.6 の SUBSCRIBE には該当文が無いため、SUBSCRIBE の根拠は Table 5)。
 *
 * 呼び出し元 (requestsPublish / requestsSubscribe / requestsFetch /
 * requestsTrackStatus) は、フレーミングまでの同期部を終えて応答待ちの Promise を
 * pending に登録してから、この関数を await せずに開始する。この関数は reject しない。
 * 次の順で進める。
 *
 * 1. 双方向ストリームを作成する
 * 2. Session の状態を確認する (作成の await 中の終了)
 * 3. 受信用の ControlStreamReader と writer を作る
 * 4. 1 つの try の中で、次を順に行う (予約を取り消す catch を 1 つにするため)
 *    1. 認可トークンを予約する
 *    2. 統計を加算して debug の send イベントを出す
 *    3. Session の状態を確認する (debug コールバックによる同期的な終了)。閉じていれば
 *       write せずに try を抜け、try の後で後始末する
 *    4. write する
 * 5. Session の状態を確認する (write の await 中の終了)。開いていれば requestStreams
 *    に登録して受信ループを開始する
 *
 * 受信ループを開始しない経路 (送信を終えられなかった、または送信後に Session が
 * 閉じていた) では、登録の解除と reject (requestsAbandonRequest) を先に行い、
 * ストリームの解放 (await を伴う) を最後に行う。reject の理由は、失敗した経路では
 * 元のエラー、Session が閉じていた経路では "session closed" である。
 *
 * create / write の await が解決しないまま Session が終了した場合、close()、
 * ピア起点の終了 (transport.closed の解決または reject)、受信ループがセッション終了を
 * 先に検出した場合のいずれでも、呼び出し元の Promise は sessionRejectPendingRequests
 * (sessionFinishTermination 経由) が終了の理由で settle させる。この関数は await が
 * 後から解決した時点でストリームを解放する。
 */
export async function requestsSendRequest(
  session: RequestsSessionInternal,
  request: RequestSendRequest,
): Promise<void> {
  const { requestId, type, payload, framed, decoded, normalizedOptions, readResponse } = request;

  // 1. 双方向ストリームを作成する
  let stream: WebTransportBidirectionalStream;
  const endOpeningRegistration = requestsTrackOpeningAuthTokenRegistration(
    session,
    normalizedOptions,
  );
  try {
    stream = await session.transport.createBidirectionalStream();
  } catch (error) {
    // ストリームは作成されていないため、解放するものは無い
    requestsAbandonRequest(session, request, error);
    return;
  } finally {
    endOpeningRegistration?.();
  }

  // 2. ストリーム作成の await 中に Session が終了した場合は、閉じた Session へ
  // 書き込まない。登録を解除して reject してから、ロックを取らずにストリームを解放する
  if (requestsReadSessionState(session) === "closed") {
    requestsAbandonRequest(session, request, new Error("session closed"));
    await requestsReleaseUnlockedStream(stream, "session closed");
    return;
  }

  // 3. 受信用の ControlStreamReader と writer を作る。ロックの取得 (getWriter) を
  // 最後にして、ロックを取った後に throw し得る処理を残さない。ロック済みの
  // ストリームを返す transport では getWriter が throw するため、detached な async
  // 処理で未処理の rejection を残さないよう try に含める
  let controlReader: ControlStreamReader;
  let writer: WritableStreamDefaultWriter<Uint8Array>;
  try {
    // draft-ietf-moq-transport-23 §9.1.8: リクエストストリームの受信上限は、
    // 自 endpoint が SETUP で広告した MAX_CONTROL_MESSAGE_SIZE である
    controlReader = new ControlStreamReader(session.localMaxControlMessageSize);
    writer = stream.writable.getWriter();
  } catch (error) {
    requestsAbandonRequest(session, request, error);
    await requestsReleaseUnlockedStream(stream, "request send failed");
    return;
  }

  // 4. 予約から write までを 1 つの try に入れ、予約を取り消す catch を 1 つにする
  let reservedAuthToken = false;
  let closedBeforeWrite = false;
  try {
    // 4-1. draft-ietf-moq-transport-23 §9.1.3: 登録サイズの総和の判定と予約は
    // 送信の直前に行う。予約のローカルな失敗 (再 REGISTER / 上限超過) でも、
    // 作成済みのストリームは catch で解放する
    reservedAuthToken = requestsReserveAuthorizationToken(session, normalizedOptions, requestId);
    // 4-2. 予約の失敗では send イベントも統計の加算も起こさないよう、予約の後に置く。
    // ストリームの作成と writer の取得の後に出すため、それらに失敗したメッセージは
    // send イベントに出ない (write の前に出すため、4-3 / 4-4 で送らなかった
    // メッセージには send イベントが出る)
    session.statsControlMessagesSent++;
    session.emitDebug("send", type, payload, decoded);
    // 4-3. debug コールバックが同期的に Session を閉じた場合は、閉じた Session へ
    // write しない。reject と cancel / abort の理由が catch 側と異なるため、throw で
    // catch に流さず、印を立てて try を抜ける。後始末は try の後で行うため、catch の
    // 後始末と重なることは無い
    if (requestsReadSessionState(session) === "closed") {
      closedBeforeWrite = true;
    } else {
      // 4-4. メッセージを書き込む
      const writing = writer.write(framed);
      if (reservedAuthToken) session.pendingAuthTokenRequests?.markSubmitted(requestId);
      await writing;
    }
  } catch (error) {
    // 予約 / debug コールバック / write の失敗。送信に至らなかったため予約を
    // 取り消し、登録を解除して元のエラーで reject してからストリームを RESET で閉じる
    if (reservedAuthToken) {
      session.releaseAuthorizationTokenForSend(requestId);
    }
    requestsAbandonRequest(session, request, error);
    await requestsReleaseLockedStream(stream, writer, "request send failed");
    return;
  }

  // 4-3 の後始末。まだ送っていないため予約を取り消し、登録を解除して reject してから
  // ストリームを解放する
  if (closedBeforeWrite) {
    if (reservedAuthToken) {
      session.releaseAuthorizationTokenForSend(requestId);
    }
    requestsAbandonRequest(session, request, new Error("session closed"));
    await requestsReleaseLockedStream(stream, writer, "session closed");
    return;
  }

  // 5. write の await 中に Session が終了した場合は、requestStreams に登録せず、
  // 受信ループも開始しない。Session の終了時は sessionFinishTermination が pending を
  // 終了の理由で reject 済みのため reject は no-op の防御になるが、登録の解除
  // (SUBSCRIBE の fill の関連付けと Track 単位の追跡の解放) とストリームの解放のため、
  // ここで明示的に後始末する。Alias の予約はセッションの終了処理で破棄される
  if (requestsReadSessionState(session) === "closed") {
    requestsAbandonRequest(session, request, new Error("session closed"));
    await requestsReleaseLockedStream(stream, writer, "session closed");
    return;
  }

  // 送信が完了した。requestStreams に登録して、双方向ストリームからレスポンスを
  // 読み取る受信ループを開始する
  session.requestStreams.set(requestId, { stream, writer, controlReader });
  void readResponse(
    session as unknown as bidi.BidiSessionInternal,
    requestId,
    stream,
    controlReader,
  );
}

export function requestsSendObject(
  session: RequestsSessionInternal,
  publisher: PublisherImpl,
  params: SendObjectParamsInternal,
): Promise<void> {
  return publishSendObject(session as unknown as SessionInternal, publisher, params);
}

/**
 * Publisher のストリームを閉じる
 * 送信キューに入れて、進行中の sendObject が完了してから閉じる
 */
export function requestsClosePublisherStream(
  session: RequestsSessionInternal,
  trackAlias: bigint,
): Promise<void> {
  return publishClosePublisherStream(session as unknown as SessionInternal, trackAlias);
}

/**
 * 開いている Subgroup を、Object を送らずに閉じる
 * 送信キューに入れて、進行中の sendObject が完了してから閉じる
 */
export function requestsCloseSubgroup(
  session: RequestsSessionInternal,
  trackAlias: bigint,
): Promise<void> {
  return publishCloseSubgroup(session as unknown as SessionInternal, trackAlias);
}

export function requestsSendDatagram(
  session: RequestsSessionInternal,
  publisher: PublisherImpl,
  params: SendDatagramParams,
  providedAtMs?: number,
): Promise<void> {
  return publishSendDatagram(
    session as unknown as SessionInternal,
    publisher,
    params,
    providedAtMs,
  );
}

/**
 * PUBLISH_STATE_NOTIFY を送信する
 *
 * draft-ietf-moq-transport-23 §9.10 (PUBLISH_STATE_NOTIFY):
 * 購読の双方向ストリーム上で送信し、応答は受け取らない。
 */
export function requestsSendPublishStateNotify(
  session: RequestsSessionInternal,
  publisher: PublisherImpl,
  options: PublishStateNotifyOptions,
): Promise<void> {
  return bidi.bidiSendPublishStateNotify(
    session as unknown as bidi.BidiSessionInternal,
    publisher,
    options,
  );
}

/**
 * draft-ietf-moq-transport-23 Section 9.9 (PUBLISH_DONE):
 * PUBLISH_DONE は双方向ストリーム上で送信される。
 * Request ID フィールドはない（bidi stream で特定可能）。
 */
export function requestsSendPublishDone(
  session: RequestsSessionInternal,
  publisher: PublisherImpl,
  status: PublishDoneStatusCode,
): Promise<void> {
  return publishSendPublishDone(session as unknown as SessionInternal, publisher, status);
}

/**
 * サブスクリプションをキャンセルする
 *
 * draft-ietf-moq-transport-23 Section 6.4.2.3:
 * subscription のキャンセルは双方向ストリームの close で行う。
 */
export function requestsCancelSubscription(
  session: RequestsSessionInternal,
  subscriber: SubscriberImpl,
): Promise<void> {
  return bidi.bidiCancelSubscription(session as unknown as bidi.BidiSessionInternal, subscriber);
}

/**
 * Fetch をキャンセルする
 *
 * draft-ietf-moq-transport-23 Section 3.2.4:
 * "It MUST send STOP_SENDING for the bidi request stream."
 */
export function requestsCancelFetch(
  session: RequestsSessionInternal,
  fetcher: FetcherImpl,
): Promise<void> {
  return bidi.bidiCancelFetch(session as unknown as bidi.BidiSessionInternal, fetcher);
}

/**
 * REQUEST_UPDATE を送信する
 *
 * draft-ietf-moq-transport-23 Section 9.5 (REQUEST_UPDATE):
 * REQUEST_UPDATE はリクエストと同じ双方向ストリーム上で送信する。
 *
 * REQUEST_UPDATE Message {
 *   Type (vi64) = 0x2,
 *   Length (vi64),
 *   Request ID (vi64),
 *   Parameters (..) ...
 * }
 */
export function requestsSendRequestUpdate(
  session: RequestsSessionInternal,
  subscriber: SubscriberImpl,
  options: RequestUpdateOptions,
): Promise<void> {
  return bidi.bidiSendRequestUpdate(
    session as unknown as bidi.BidiSessionInternal,
    subscriber,
    options,
  );
}

/**
 * Location Filter をデバッグログ用の文字列に要約する
 *
 * Location Filter Type ごとの表現 (draft-ietf-moq-transport-23 §9.19.9 Table 6) を
 * そのまま書き出す。Next Object (0x05) はフィールドを持たないため種別名だけを返す。
 */
export function requestsDescribeLocationFilter(
  filter: LocationFilter | undefined,
): string | undefined {
  if (filter === undefined) {
    return undefined;
  }
  if ("reset" in filter) {
    return "reset";
  }
  if (isNextObjectLocationFilter(filter)) {
    return "nextObject";
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
 * options の Authorization Token を送信用に正規化する
 *
 * draft-ietf-moq-transport-23 §8.9 / §9.1.4: SETUP の REGISTER の登録成否に応じて、
 * 後続メッセージへ付与するトークンを USE_ALIAS (登録成功) / USE_VALUE (登録失敗) に
 * 正規化する。Authorization Token を運ばない options はそのまま返す。
 */
export function requestsNormalizeAuthorizationToken<
  T extends { authorizationToken?: AuthorizationToken },
>(
  session: { normalizeAuthorizationTokenForSend(token: AuthorizationToken): AuthorizationToken },
  options: T | undefined,
): T | undefined {
  if (options?.authorizationToken === undefined) {
    return options;
  }
  return {
    ...options,
    authorizationToken: copyAuthorizationToken(
      session.normalizeAuthorizationTokenForSend(options.authorizationToken),
    ),
  };
}

/**
 * REGISTER のストリームを開く前から追跡する。通常の登録サイズの予約は write の直前に行う。
 */
export function requestsTrackOpeningAuthTokenRegistration(
  session: { readonly pendingAuthTokenRequests?: PendingAuthTokenRequests },
  options: { authorizationToken?: AuthorizationToken } | undefined,
): (() => void) | undefined {
  const token = options?.authorizationToken;
  return token?.aliasType === AuthorizationTokenAliasType.REGISTER
    ? session.pendingAuthTokenRequests?.openingRegistration(token.tokenAlias)
    : undefined;
}

/**
 * DELETE (Alias Type 0x00) の Authorization Token を落とす
 *
 * draft-ietf-moq-transport-23 §8.9:
 * DELETE は Alias の退役を指示するものであり、後続の制御メッセージで繰り返すと
 * UNKNOWN_AUTH_TOKEN_ALIAS と解され得る。購読状態に保持して REQUEST_UPDATE へ
 * 引き継ぐ対象からは外す。
 */
export function requestsTokenUnlessDelete(
  token: AuthorizationToken | undefined,
): AuthorizationToken | undefined {
  if (token === undefined || token.aliasType !== AuthorizationTokenAliasType.DELETE) {
    return token;
  }
  return undefined;
}

/**
 * REQUEST_UPDATE に付与する Authorization Token を求める
 *
 * draft-ietf-moq-transport-23 §8.9: 既に登録した Alias を同じセッションで
 * 再 REGISTER すると、ピアは DUPLICATE_AUTH_TOKEN_ALIAS でセッションを閉じる。
 * SUBSCRIBE などの要求で REGISTER を送った Alias は、同じストリームの
 * REQUEST_UPDATE では USE_ALIAS で参照する (§9.1.4 も Alias の再利用を前提とする)。
 */
export function requestsTokenForRequestUpdate(
  token: AuthorizationToken | undefined,
): AuthorizationToken | undefined {
  if (token === undefined || token.aliasType !== AuthorizationTokenAliasType.REGISTER) {
    return token;
  }
  return { aliasType: AuthorizationTokenAliasType.USE_ALIAS, tokenAlias: token.tokenAlias };
}

/**
 * 送信直前の Authorization Token の登録サイズを判定して予約する
 *
 * draft-ietf-moq-transport-23 §9.1.3: 登録サイズの総和がピアの上限を超える場合は
 * 送信前にローカルエラーにする。判定と予約は送信の直前 (await の手前) で行い、
 * 並行する REGISTER が互いの加算を見落とさないようにする。
 */
export function requestsReserveAuthorizationToken(
  session: {
    reserveAuthorizationTokenForSend(
      token: AuthorizationToken | undefined,
      requestId: bigint,
    ): boolean;
  },
  options: { authorizationToken?: AuthorizationToken } | undefined,
  requestId: bigint,
): boolean {
  return session.reserveAuthorizationTokenForSend(options?.authorizationToken, requestId);
}
