/**
 * namespace 系リクエストの free function 群
 *
 * SessionImpl の subscribeNamespace / subscribeTracks / publishNamespace と、
 * それぞれが返す購読 / 配信オブジェクトの生成 (createNamespaceSubscription /
 * createTracksSubscription / createNamespacePublication)、解除
 * (closeNamespaceSubscription / closeTracksSubscription /
 * closeNamespacePublication)、REQUEST_UPDATE 送信
 * (sendNamespaceRequestUpdate)、受信ループ開始
 * (startNamespaceStreamLoop / startTracksStreamLoop /
 * startNamespacePublicationStreamLoop) を free function として抽出する。
 *
 * draft-ietf-moq-transport-21 §9.15 (SUBSCRIBE_NAMESPACE) /
 * §9.18 (SUBSCRIBE_TRACKS) / §9.14 (PUBLISH_NAMESPACE) は、いずれも専用の
 * 双方向ストリームを開く namespace 系の要求である。ストリーム上のメッセージ処理は
 * namespaceLoops.ts が担当する。
 */

import {
  MessageType,
  encodePublishNamespacePayload,
  encodeSubscribeNamespacePayload,
  encodeSubscribeTracksPayload,
  createTrackNamespace,
  getMessageTypeName,
  type AuthorizationToken,
} from "../message";
import { ControlStreamReader, ControlStreamWriter } from "../controlStream";
import * as bidi from "./bidi";
import {
  REQUEST_UPDATE_STREAM_CLOSED_MESSAGE,
  namespaceStartNamespaceStreamLoop,
  namespaceStartPublicationStreamLoop,
  namespaceStartTracksStreamLoop,
  rejectPendingNamespaceUpdates,
} from "./namespaceLoops";
import {
  buildSubscribeNamespaceParameters,
  buildSubscribeTracksParameters,
  encodeAuthorizationTokenParameter,
  validateRangeFilterLimits,
  validateTrackNamespaceForSend,
} from "./params";
import type {
  NamespacePublicationState,
  NamespaceSubscriptionState,
  SessionInternal,
  TracksSubscriptionState,
} from "./types";
import type {
  NamespacePublication,
  NamespacePublicationCallbacks,
  NamespaceSubscription,
  NamespaceSubscriptionCallbacks,
  PublishNamespaceOptions,
  SessionState,
  SubscribeTracksOptions,
  TracksSubscription,
  TracksSubscriptionCallbacks,
  NamespaceUpdateOptions,
  TracksUpdateOptions,
} from "./publicTypes";

/**
 * namespace 系リクエストが必要とする SessionImpl のビュー
 *
 * SessionImpl は `as unknown as NamespacesSessionInternal` で渡す。
 */
export interface NamespacesSessionInternal {
  sessionState: SessionState;
  readonly transport: WebTransport;
  readonly callbacks: {
    debug?: (message: unknown) => void;
  };

  nextRequestId: bigint;
  receivedGoaway: boolean;
  peerMaxFilterRanges: number;

  readonly namespaceSubscriptions: Map<bigint, NamespaceSubscriptionState>;
  readonly tracksSubscriptions: Map<bigint, TracksSubscriptionState>;
  readonly namespacePublications: Map<bigint, NamespacePublicationState>;
}
export async function namespacesSubscribeNamespace(
  session: NamespacesSessionInternal,
  namespacePrefix: string[],
  callbacks: NamespaceSubscriptionCallbacks,
  options?: { authorizationToken?: AuthorizationToken },
): Promise<NamespaceSubscription> {
  if (session.sessionState === "closed") {
    throw new Error("session is closed");
  }

  // GOAWAY 受信後は新規リクエストを拒否
  if (session.receivedGoaway) {
    throw new Error("cannot subscribe namespace after receiving GOAWAY");
  }

  const requestId = session.nextRequestId;
  session.nextRequestId += 2n;

  const trackNamespacePrefix = createTrackNamespace(namespacePrefix);

  // draft-ietf-moq-transport-21 §2.4.2 / §6.5: 予約 namespace / .session の送信拒否
  validateTrackNamespaceForSend(namespacePrefix);

  // 専用の双方向ストリームを作成
  const stream = await session.transport.createBidirectionalStream();
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
    session.callbacks.debug?.({
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
    await namespacesCleanupSendFailure(streamReader, writer);
    throw error;
  }

  // REQUEST_OK/REQUEST_ERROR を待つ Promise
  return new Promise<NamespaceSubscription>((resolve, reject) => {
    // 状態を登録
    session.namespaceSubscriptions.set(requestId, {
      callbacks,
      state: "active",
      namespacePrefix,
      stream,
      streamReader,
      controlReader,
      writer,
    });

    // 専用ストリームの受信ループを開始
    void namespacesStartNamespaceStreamLoop(session, requestId, resolve, reject);
  });
}

export async function namespacesSubscribeTracks(
  session: NamespacesSessionInternal,
  namespacePrefix: string[],
  callbacks: TracksSubscriptionCallbacks,
  options?: SubscribeTracksOptions,
): Promise<TracksSubscription> {
  if (session.sessionState === "closed") {
    throw new Error("session is closed");
  }

  // GOAWAY 受信後は新規リクエストを拒否
  if (session.receivedGoaway) {
    throw new Error("cannot subscribe tracks after receiving GOAWAY");
  }

  const requestId = session.nextRequestId;
  session.nextRequestId += 2n;

  const trackNamespacePrefix = createTrackNamespace(namespacePrefix);

  // draft-ietf-moq-transport-21 §2.4.2 / §6.5: 予約 namespace / .session の送信拒否
  validateTrackNamespaceForSend(namespacePrefix);

  // draft-ietf-moq-transport-21 §9.1.6: ピアの MAX_FILTER_RANGES が 0 のとき Range Filter 送信禁止
  // draft-ietf-moq-transport-21 §4.3: SUBSCRIBE_TRACKS で Range Filter を送信できる
  validateRangeFilterLimits(options?.rangeFilters, session.peerMaxFilterRanges, "SUBSCRIBE_TRACKS");

  // 専用の双方向ストリームを作成
  const stream = await session.transport.createBidirectionalStream();
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
    session.callbacks.debug?.({
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
    await namespacesCleanupSendFailure(streamReader, writer);
    throw error;
  }

  // REQUEST_OK/REQUEST_ERROR を待つ Promise
  return new Promise<TracksSubscription>((resolve, reject) => {
    // 状態を登録
    session.tracksSubscriptions.set(requestId, {
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
    void namespacesStartTracksStreamLoop(session, requestId, resolve, reject);
  });
}

export async function namespacesPublishNamespace(
  session: NamespacesSessionInternal,
  namespace: string[],
  callbacks?: NamespacePublicationCallbacks,
  options?: PublishNamespaceOptions,
): Promise<NamespacePublication> {
  if (session.sessionState === "closed") {
    throw new Error("session is closed");
  }

  // GOAWAY 受信後は新規リクエストを拒否
  if (session.receivedGoaway) {
    throw new Error("cannot publish namespace after receiving GOAWAY");
  }

  const requestId = session.nextRequestId;
  session.nextRequestId += 2n;

  const trackNamespace = createTrackNamespace(namespace);

  // draft-ietf-moq-transport-21 §2.4.2 / §6.5: 予約 namespace / .session の送信拒否
  validateTrackNamespaceForSend(namespace);

  // 専用の双方向ストリームを作成
  const stream = await session.transport.createBidirectionalStream();
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
    session.callbacks.debug?.({
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
    await namespacesCleanupSendFailure(streamReader, writer);
    throw error;
  }

  // REQUEST_OK / REQUEST_ERROR を待つ Promise
  return new Promise<NamespacePublication>((resolve, reject) => {
    // 状態を登録
    session.namespacePublications.set(requestId, {
      callbacks,
      state: "pending",
      namespace,
      stream,
      streamReader,
      controlReader,
      writer,
    });

    // 専用ストリームの受信ループを開始
    void namespacesStartPublicationStreamLoop(session, requestId, resolve, reject);
  });
}

export function namespacesCreateNamespaceSubscription(
  session: NamespacesSessionInternal,
  requestId: bigint,
): NamespaceSubscription {
  const getState = (): "active" | "closed" => {
    const sub = session.namespaceSubscriptions.get(requestId);
    return sub?.state ?? "closed";
  };

  const unsubscribe = async (): Promise<void> => {
    await namespacesCloseNamespaceSubscription(session, requestId);
  };

  // fire-and-forget で update() を呼び出しても、unsubscribe() / ピアの
  // FIN 等による reject が unhandled rejection にならないよう、catch を
  // 付けた promise を返す。async の wrapper 経由にすると wrapper 側の
  // 無観測 reject が unhandled になるため、ここで必ず捕まえる。
  const update = (options: NamespaceUpdateOptions): Promise<void> => {
    const promise = namespacesSendNamespaceRequestUpdate(session, requestId, "namespace", options);
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

export function namespacesCreateTracksSubscription(
  session: NamespacesSessionInternal,
  requestId: bigint,
): TracksSubscription {
  const getState = (): "active" | "closed" => {
    const sub = session.tracksSubscriptions.get(requestId);
    return sub?.state ?? "closed";
  };

  const unsubscribe = async (): Promise<void> => {
    await namespacesCloseTracksSubscription(session, requestId);
  };

  // createNamespaceSubscription の update と同様に、fire-and-forget 時の
  // 無観測 reject を抑制する (catch 付き promise を直接返す)。
  const update = (options: TracksUpdateOptions): Promise<void> => {
    const promise = namespacesSendNamespaceRequestUpdate(session, requestId, "tracks", options);
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

export function namespacesCreateNamespacePublication(
  session: NamespacesSessionInternal,
  requestId: bigint,
): NamespacePublication {
  // 内部状態の "pending" は REQUEST_OK 受信前のみで、外部に公開する前に "active" になる
  const getState = (): "active" | "closed" => {
    const pub = session.namespacePublications.get(requestId);
    if (!pub) return "closed";
    return pub.state === "active" ? "active" : "closed";
  };

  const getNamespace = (): string[] => {
    const pub = session.namespacePublications.get(requestId);
    return pub?.namespace ?? [];
  };

  const done = async (): Promise<void> => {
    await namespacesCloseNamespacePublication(session, requestId);
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

export async function namespacesCloseNamespaceSubscription(
  session: NamespacesSessionInternal,
  requestId: bigint,
): Promise<void> {
  const subscription = session.namespaceSubscriptions.get(requestId);
  if (!subscription || subscription.state === "closed") {
    return;
  }

  subscription.state = "closed";

  // 保留中の REQUEST_UPDATE (update() の Promise) を失敗させ、pendingPrefix を
  // クリアする。掃除しないと update() が未解決のまま残り、pendingRequestUpdate
  // エントリがセッション close まで残留する (MAX_REQUEST_UPDATES のカウント
  // 継続)。エラー文言は FIN 経路と共通の定数を使う。
  rejectPendingNamespaceUpdates(
    session as unknown as SessionInternal,
    requestId,
    subscription,
    new Error(REQUEST_UPDATE_STREAM_CLOSED_MESSAGE),
  );

  // draft-ietf-moq-transport-21 §4.1 / §6.4.2.3:
  // SUBSCRIBE_NAMESPACE の解除は RESET_STREAM (writer.abort()) と
  // STOP_SENDING (reader.cancel()) で行う。
  await namespacesCancelStream(
    subscription.streamReader,
    subscription.writer,
    "namespace subscription cancelled",
  );

  session.namespaceSubscriptions.delete(requestId);
}

export async function namespacesCloseTracksSubscription(
  session: NamespacesSessionInternal,
  requestId: bigint,
): Promise<void> {
  const subscription = session.tracksSubscriptions.get(requestId);
  if (!subscription || subscription.state === "closed") {
    return;
  }

  subscription.state = "closed";

  // 保留中の REQUEST_UPDATE (update() の Promise) を失敗させ、pendingPrefix を
  // クリアする (closeNamespaceSubscription と同様の理由)。
  rejectPendingNamespaceUpdates(
    session as unknown as SessionInternal,
    requestId,
    subscription,
    new Error(REQUEST_UPDATE_STREAM_CLOSED_MESSAGE),
  );

  // draft-ietf-moq-transport-21 §4.1 / §6.4.2.3:
  // SUBSCRIBE_TRACKS の解除は RESET_STREAM (writer.abort()) と
  // STOP_SENDING (reader.cancel()) で行う。
  await namespacesCancelStream(
    subscription.streamReader,
    subscription.writer,
    "tracks subscription cancelled",
  );

  session.tracksSubscriptions.delete(requestId);
}

export async function namespacesCloseNamespacePublication(
  session: NamespacesSessionInternal,
  requestId: bigint,
): Promise<void> {
  const publication = session.namespacePublications.get(requestId);
  if (!publication || publication.state === "closed") {
    return;
  }

  publication.state = "closed";

  // draft-ietf-moq-transport-21 §4.2 / §6.4.2.3:
  // PUBLISH_NAMESPACE の撤回は RESET_STREAM (writer.abort()) と
  // STOP_SENDING (reader.cancel()) で行う。
  await namespacesCancelStream(
    publication.streamReader,
    publication.writer,
    "namespace publication cancelled",
  );

  session.namespacePublications.delete(requestId);
}

export async function namespacesSendNamespaceRequestUpdate(
  session: NamespacesSessionInternal,
  requestId: bigint,
  kind: "namespace" | "tracks",
  options: TracksUpdateOptions,
): Promise<void> {
  const subscription =
    kind === "namespace"
      ? session.namespaceSubscriptions.get(requestId)
      : session.tracksSubscriptions.get(requestId);
  if (!subscription || subscription.state !== "active" || !subscription.writer) {
    throw new Error(`${kind} subscription is not active`);
  }
  return bidi.bidiSendNamespaceRequestUpdate(
    session as unknown as bidi.BidiSessionInternal,
    requestId,
    subscription.writer,
    options,
  );
}

export async function namespacesCleanupSendFailure(
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

export async function namespacesCancelStream(
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

export function namespacesStartNamespaceStreamLoop(
  session: NamespacesSessionInternal,
  requestId: bigint,
  resolve: (subscription: NamespaceSubscription) => void,
  reject: (err: Error) => void,
): Promise<void> {
  return namespaceStartNamespaceStreamLoop(
    session as unknown as SessionInternal,
    requestId,
    resolve,
    reject,
  );
}

export function namespacesStartTracksStreamLoop(
  session: NamespacesSessionInternal,
  requestId: bigint,
  resolve: (subscription: TracksSubscription) => void,
  reject: (err: Error) => void,
): Promise<void> {
  return namespaceStartTracksStreamLoop(
    session as unknown as SessionInternal,
    requestId,
    resolve,
    reject,
  );
}

export function namespacesStartPublicationStreamLoop(
  session: NamespacesSessionInternal,
  requestId: bigint,
  resolve: (publication: NamespacePublication) => void,
  reject: (err: Error) => void,
): Promise<void> {
  return namespaceStartPublicationStreamLoop(
    session as unknown as SessionInternal,
    requestId,
    resolve,
    reject,
  );
}
