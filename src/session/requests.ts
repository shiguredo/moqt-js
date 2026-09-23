/**
 * 要求送信の free function 群
 *
 * SessionImpl の publish / subscribe / fetch / trackStatus と、その送信に使う
 * sendRequestOnBidiStream / sendObject / closePublisherStream / sendDatagram /
 * sendPublishStateNotify / sendPublishDone / cancelSubscription / cancelFetch /
 * sendRequestUpdate / readPublishResponse / readSubscribeResponse /
 * readFetchResponse / readTrackStatusResponse を free function として抽出する。
 *
 * draft-ietf-moq-transport-21 Section 6.3:
 * リクエスト (SUBSCRIBE, PUBLISH, FETCH, TRACK_STATUS) は双方向ストリーム上で
 * 送受信される。受信側の処理は bidi.ts / incoming.ts が担当する。
 */

import { ControlStreamReader } from "../controlStream";
import {
  GroupOrder,
  MessageType,
  PublishDoneStatusCode,
  createTrackNamespace,
  encodeTrackName,
  encodeFetchPayload,
  encodePublishPayload,
  encodeSubscribePayload,
  encodeTrackStatusPayload,
  validateFullTrackName,
  type Location,
  type LocationFilter,
} from "../message";
import {
  type Publisher,
  PublisherImpl,
  type PublishStateNotifyOptions,
  type SendObjectParams,
  type SendDatagramParams,
} from "../publisher";
import { type Subscriber, type RequestUpdateOptions, SubscriberImpl } from "../subscriber";
import { type Fetcher, FetcherImpl } from "../fetcher";
import type { MoqtObject } from "../dataStream";
import { fullTrackNameKey } from "../fullTrackName";
import * as bidi from "./bidi";
import {
  publishSendObject,
  publishClosePublisherStream,
  publishSendDatagram,
  publishSendPublishDone,
  publishMarkStreamOmitted,
} from "./publish";
import {
  buildPublishParameters,
  buildPublishTrackProperties,
  buildSubscribeParameters,
  buildFetchParameters,
  buildTrackStatusParameters,
  resolveFetchStartLocation,
  resolveFillGroupOrder,
  validateRangeFilterLimits,
  validateRangeFilterSpecs,
  validateTrackNamespaceForSend,
} from "./params";
import type { PublisherStreamState, SessionInternal } from "./types";
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
  sessionState: SessionState;
  readonly transport: WebTransport;

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
      startLocation?: Location;
    }
  >;
  readonly pendingTrackStatus: Map<bigint, bidi.PendingTrackStatus>;
  readonly publisherStreams: Map<bigint, PublisherStreamState>;
  readonly fillFetchTargets: Map<bigint, bidi.FillFetchTarget>;

  onRequestDrained(): void;
}
export async function requestsPublish(
  session: RequestsSessionInternal,
  namespace: string[],
  trackName: string,
  callbacks?: PublishCallbacks,
  options?: PublishOptions,
): Promise<Publisher> {
  if (session.sessionState === "closed") {
    throw new Error("Session is closed");
  }

  // GOAWAY 受信後は新規リクエストを拒否
  // draft-ietf-moq-transport-21 Section 9.2 (GOAWAY)
  if (session.receivedGoaway) {
    throw new Error("Cannot publish after receiving GOAWAY");
  }

  const requestId = session.nextRequestId;
  // draft-ietf-moq-transport-21 Section 6.4.2.1: クライアントは偶数の Request ID を使うため 2 ずつ加算する
  session.nextRequestId += 2n;

  const trackAlias = session.nextTrackAlias++;

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
  impl.onSendObject = (params: SendObjectParams) => requestsSendObject(session, impl, params);
  // draft-ietf-moq-transport-21 §11.3.2 (Closing Subgroup Streams):
  // Forward State 0 または Location Filter の範囲外で見送った Object がある Subgroup は、
  // 閉じる時に reset を MUST とする。見送りの事実を見送りの時点で記録する (閉じる時点では
  // 最後に送信した Object より後の見送りを検出できない)。記録の規則は
  // publishMarkStreamOmitted を参照。
  impl.onSendObjectSkipped = (groupId) => {
    publishMarkStreamOmitted(session, impl.getTrackAlias(), groupId);
  };

  // データグラム送信コールバックを設定
  impl.onSendDatagram = (params: SendDatagramParams) => {
    requestsSendDatagram(session, impl, params);
  };

  // PUBLISH_STATE_NOTIFY 送信コールバックを設定
  impl.onNotifyStateChange = (options) => requestsSendPublishStateNotify(session, impl, options);

  impl.onDoneInternal = async (status) => {
    // まずデータストリーム（subgroup 単方向ストリーム）を閉じる（FIN 送信）
    await requestsClosePublisherStream(session, impl.getTrackAlias());
    // その後 PUBLISH_DONE を送信（リクエストストリーム（PUBLISH の bidi ストリーム）の FIN は sendPublishDone 内で送信、draft-ietf-moq-transport-21 §9.9）
    await requestsSendPublishDone(session, impl, status);
    // draft-ietf-moq-transport-21 §6.6.1:
    // GOAWAY 受信後に Established 購読が無くなった時点で NO_ERROR で閉じる。
    session.onRequestDrained();
  };

  // PUBLISH メッセージを構築する。
  // buildPublishParameters / buildPublishTrackProperties / encodePublishPayload
  // が throw する場合、pendingPublish.set より前で失敗させるため、
  // 構築・encode は Promise 作成より前に行う (subscribe() の
  // buildSubscribeParameters / fetch() の buildFetchParameters と同じ手順)。
  const parameters = buildPublishParameters(options);
  const trackProperties = buildPublishTrackProperties(options, session.grease);

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
    session.pendingPublish.set(requestId, {
      resolve,
      reject,
      impl,
    });
  });

  let streamInfo: Awaited<ReturnType<typeof requestsSendRequestOnBidiStream>>;
  try {
    streamInfo = await requestsSendRequestOnBidiStream(
      session,
      requestId,
      MessageType.PUBLISH,
      payload,
      {
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
    );
  } catch (error) {
    // 送信失敗時は保留中の PUBLISH を削除して残留を防ぐ
    // (subscribe() の sendRequestOnBidiStream 失敗時と同パターン)。
    session.pendingPublish.delete(requestId);
    throw error;
  }

  // 双方向ストリームからレスポンスを読み取る
  void bidi.bidiReadPublishResponse(
    session as unknown as bidi.BidiSessionInternal,
    requestId,
    streamInfo.stream,
    streamInfo.controlReader,
  );

  return promise;
}

export async function requestsSubscribe(
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
  // draft-ietf-moq-transport-21 Section 9.2 (GOAWAY)
  if (session.receivedGoaway) {
    throw new Error("Cannot subscribe after receiving GOAWAY");
  }

  const requestId = session.nextRequestId;
  // draft-ietf-moq-transport-21 Section 6.4.2.1: クライアントは偶数の Request ID を使うため 2 ずつ加算する
  session.nextRequestId += 2n;

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
    await requestsCancelSubscription(session, impl);
  };

  // 更新コールバックを設定
  impl.onUpdate = async (updateOptions: RequestUpdateOptions) => {
    await requestsSendRequestUpdate(session, impl, updateOptions);
  };

  // draft-ietf-moq-transport-21 §9.1.6: ピアの MAX_FILTER_RANGES が 0 のとき Range Filter 送信禁止
  // pendingSubscribe.set より前に配置し、throw 時に pending エントリが残らないようにする
  // fill 内側の Range Filters も購読単位の上限に含める (§9.1.6)。
  validateRangeFilterLimits(
    [...(options?.rangeFilters ?? []), ...(options?.fill?.rangeFilters ?? [])],
    session.peerMaxFilterRanges,
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
    session.pendingSubscribe.set(requestId, {
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
    session.fillFetchTargets.set(requestId, {
      subscriber: impl,
      groupOrder: resolveFillGroupOrder(options.fill.groupOrder, options.groupOrder),
    });
  }

  const payload = encodeSubscribePayload(subscribeMsg);
  let streamInfo: Awaited<ReturnType<typeof requestsSendRequestOnBidiStream>>;
  try {
    streamInfo = await requestsSendRequestOnBidiStream(
      session,
      requestId,
      MessageType.SUBSCRIBE,
      payload,
      {
        requestId: requestId.toString(),
        trackNamespace: namespace,
        trackName,
        filter: requestsDescribeLocationFilter(options?.filter),
        OBJECT_DELIVERY_TIMEOUT: options?.deliveryTimeout?.toString(),
        SUBSCRIBER_PRIORITY: options?.subscriberPriority,
        GROUP_ORDER: options?.groupOrder,
        NEW_GROUP_REQUEST: options?.newGroupRequest?.toString(),
      },
    );
  } catch (error) {
    // 送信失敗時は fill 関連付けと保留中の SUBSCRIBE を削除して残留を防ぐ
    // (bidiSendRequestUpdate の write 失敗時と同パターン)。
    session.fillFetchTargets.delete(requestId);
    session.pendingSubscribe.delete(requestId);
    throw error;
  }

  // 双方向ストリームからレスポンスを読み取る
  void bidi.bidiReadSubscribeResponse(
    session as unknown as bidi.BidiSessionInternal,
    requestId,
    streamInfo.stream,
    streamInfo.controlReader,
  );

  return promise;
}

export async function requestsFetch(
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

  const requestId = session.nextRequestId;
  session.nextRequestId += 2n;

  const trackNamespace = createTrackNamespace(namespace);
  const trackNameBytes = encodeTrackName(trackName);
  // draft-ietf-moq-transport-21 §8.7: Full Track Name 合計長検証
  validateFullTrackName(trackNamespace, trackName);
  // draft-ietf-moq-transport-21 §2.4.2 / §6.5: 予約 namespace / .session の送信拒否
  validateTrackNamespaceForSend(namespace, trackName);

  // draft-ietf-moq-transport-21 §9.1.6: ピアの MAX_FILTER_RANGES を超える Range Filter 送信をガード
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
    await requestsCancelFetch(session, impl);
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
    session.pendingFetch.set(requestId, {
      resolve,
      reject,
      impl,
      ...(startLocation !== undefined ? { startLocation } : {}),
    });
  });

  let streamInfo: Awaited<ReturnType<typeof requestsSendRequestOnBidiStream>>;
  try {
    streamInfo = await requestsSendRequestOnBidiStream(
      session,
      requestId,
      MessageType.FETCH,
      payload,
      {
        requestId: requestId.toString(),
        trackNamespace: namespace,
        trackName,
        filter: requestsDescribeLocationFilter(options.filter),
      },
    );
  } catch (error) {
    // 送信失敗時は保留中の FETCH を削除して残留を防ぐ
    // (subscribe() の sendRequestOnBidiStream 失敗時と同パターン)。
    session.pendingFetch.delete(requestId);
    throw error;
  }

  // 双方向ストリームからレスポンスを読み取る
  void bidi.bidiReadFetchResponse(
    session as unknown as bidi.BidiSessionInternal,
    requestId,
    streamInfo.stream,
    streamInfo.controlReader,
  );

  return promise;
}

export async function requestsTrackStatus(
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

  const requestId = session.nextRequestId;
  session.nextRequestId += 2n;

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
    session.pendingTrackStatus.set(requestId, {
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

  let streamInfo: Awaited<ReturnType<typeof requestsSendRequestOnBidiStream>>;
  try {
    // buildTrackStatusParameters は throw しないが、encode 以降は共通化のため
    // 同一 try 範囲に含める (publish() / fetch() と同じ手順)。
    const payload = encodeTrackStatusPayload(trackStatusMsg);
    streamInfo = await requestsSendRequestOnBidiStream(
      session,
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
    session.pendingTrackStatus.delete(requestId);
    throw error;
  }

  // 双方向ストリームからレスポンスを読み取る
  void bidi.bidiReadTrackStatusResponse(
    session as unknown as bidi.BidiSessionInternal,
    requestId,
    streamInfo.stream,
    streamInfo.controlReader,
  );

  return promise;
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
export function requestsSendRequestOnBidiStream(
  session: RequestsSessionInternal,
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
    session as unknown as bidi.BidiSessionInternal,
    requestId,
    type,
    payload,
    decoded,
  );
}

export function requestsSendObject(
  session: RequestsSessionInternal,
  publisher: PublisherImpl,
  params: SendObjectParams,
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

export function requestsSendDatagram(
  session: RequestsSessionInternal,
  publisher: PublisherImpl,
  params: SendDatagramParams,
): void {
  publishSendDatagram(session as unknown as SessionInternal, publisher, params);
}

/**
 * PUBLISH_STATE_NOTIFY を送信する
 *
 * draft-ietf-moq-transport-21 §9.10 (PUBLISH_STATE_NOTIFY):
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
 * draft-ietf-moq-transport-21 Section 9.9 (PUBLISH_DONE):
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
 * draft-ietf-moq-transport-21 Section 6.4.2.3:
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
 * draft-ietf-moq-transport-21 Section 3.2.1:
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
 * PUBLISH リクエストの双方向ストリームからレスポンスを読み取る
 *
 * draft-ietf-moq-transport-21 Section 9.3 (REQUEST_OK):
 * PUBLISH_OK は双方向ストリーム上の最初のレスポンスとして送信される。
 * その後、同じストリームで REQUEST_UPDATE の応答も受信する。
 * draft-ietf-moq-transport-21 Section 6.3
 */
export function requestsReadPublishResponse(
  session: RequestsSessionInternal,
  requestId: bigint,
  stream: WebTransportBidirectionalStream,
  controlReader: ControlStreamReader,
): Promise<void> {
  return bidi.bidiReadPublishResponse(
    session as unknown as bidi.BidiSessionInternal,
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
export function requestsReadSubscribeResponse(
  session: RequestsSessionInternal,
  requestId: bigint,
  stream: WebTransportBidirectionalStream,
  controlReader: ControlStreamReader,
): Promise<void> {
  return bidi.bidiReadSubscribeResponse(
    session as unknown as bidi.BidiSessionInternal,
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
export function requestsReadFetchResponse(
  session: RequestsSessionInternal,
  requestId: bigint,
  stream: WebTransportBidirectionalStream,
  controlReader: ControlStreamReader,
): Promise<void> {
  return bidi.bidiReadFetchResponse(
    session as unknown as bidi.BidiSessionInternal,
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
export function requestsReadTrackStatusResponse(
  session: RequestsSessionInternal,
  requestId: bigint,
  stream: WebTransportBidirectionalStream,
  controlReader: ControlStreamReader,
): Promise<void> {
  return bidi.bidiReadTrackStatusResponse(
    session as unknown as bidi.BidiSessionInternal,
    requestId,
    stream,
    controlReader,
  );
}

/**
 * Location Filter をデバッグログ用の文字列に要約する
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
