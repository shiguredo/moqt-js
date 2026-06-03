/**
 * MOQT Session - 双方向ストリーム処理
 *
 * SessionImpl から抽出した双方向ストリーム上の request/response 処理。
 * すべての関数は `BidiSessionInternal` インターフェースを通じて
 * SessionImpl の状態にアクセスする。
 */

import { ControlStreamReader, ControlStreamWriter, type ControlMessage } from "../controlStream";
import type { MoqtObject } from "../dataStream";
import {
  RequestError,
  SessionError,
  SessionErrorCode,
  normalizeRequestErrorCode,
  normalizePublishDoneCode,
} from "../error";
import { FetcherImpl, type Fetcher } from "../fetcher";
import {
  MessageType,
  FetchType,
  MessageParameterType,
  encodeFetchPayload,
  encodeRequestUpdatePayload,
  encodeUint8ParameterValue,
  decodeFetchOkPayload,
  decodeGoawayPayload,
  decodePublishDonePayload,
  decodeRequestErrorPayload,
  decodeRequestOkPayload,
  decodeRequestUpdatePayload,
  decodeSubscribeOkPayload,
  getParameterLocationValue,
  type Location,
  type Parameter,
  type GroupOrder,
} from "../message";
import { PendingSubgroupBuffer } from "../pendingSubgroupBuffer";
import { PublisherImpl, type Publisher } from "../publisher";
import type { Property } from "../properties";
import {
  PUBLISH_OK_ALLOWED_PARAMS,
  SUBSCRIBE_OK_ALLOWED_PARAMS,
  FETCH_OK_ALLOWED_PARAMS,
  REQUEST_UPDATE_OK_ALLOWED_PARAMS,
  validateParameterScope,
} from "../message/parameterScope";
import { SubscriberImpl, type Subscriber, type RequestUpdateOptions } from "../subscriber";
import { encodeVarint } from "../varint";
import type { JoiningFetchOptions, SessionState, TrackStatusResult } from "../session";
import { extractForwardState, extractLargestLocation, validateFetchOkEndLocation } from "./params";

// ============================================================================
// 内部インターフェース
// ============================================================================

export interface RequestStreamInfo {
  stream: WebTransportBidirectionalStream;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  controlReader: ControlStreamReader;
}

interface PendingPublish {
  resolve: (pub: Publisher) => void;
  reject: (err: Error) => void;
  impl: PublisherImpl;
  goawayCallback?: (newSessionUri: string) => void;
}

interface PendingSubscribe {
  resolve: (sub: Subscriber) => void;
  reject: (err: Error) => void;
  impl: SubscriberImpl;
  joiningFetch?: JoiningFetchOptions;
  objectCallback: (object: MoqtObject) => void;
  goawayCallback?: (newSessionUri: string) => void;
}

interface PendingFetch {
  resolve: (fetcher: Fetcher) => void;
  reject: (err: Error) => void;
  impl: FetcherImpl;
  startLocation?: Location;
  goawayCallback?: (newSessionUri: string) => void;
}

interface PendingTrackStatus {
  resolve: (result: TrackStatusResult) => void;
  reject: (err: Error) => void;
}

interface PendingRequestUpdate {
  resolve: () => void;
  reject: (err: Error) => void;
  targetRequestId: bigint;
}

export interface BidiSessionInternal {
  readonly sessionState: SessionState;
  readonly transport: WebTransport;
  controlWriter: ControlStreamWriter | undefined;
  nextRequestId: bigint;

  readonly requestStreams: Map<bigint, RequestStreamInfo>;
  readonly pendingPublish: Map<bigint, PendingPublish>;
  readonly pendingSubscribe: Map<bigint, PendingSubscribe>;
  readonly pendingFetch: Map<bigint, PendingFetch>;
  readonly pendingTrackStatus: Map<bigint, PendingTrackStatus>;
  readonly pendingRequestUpdate: Map<bigint, PendingRequestUpdate>;

  readonly publishers: Map<bigint, PublisherImpl>;
  readonly subscribers: Map<bigint, SubscriberImpl>;
  readonly subscribersByAlias: Map<bigint, SubscriberImpl>;
  readonly fetchers: Map<bigint, FetcherImpl>;

  readonly pendingSubgroupBuffer: PendingSubgroupBuffer;
  readonly fetcherReadyCallbacks: Map<bigint, Array<() => void>>;
  readonly goawayReceivedOnRequestStreams: Set<bigint>;

  statsControlMessagesSent: number;

  emitDebug(
    direction: "send" | "recv",
    type: number,
    payload: Uint8Array,
    decoded?: Record<string, unknown>,
  ): void;
  closeWithError(error: SessionError): void;
}

// ============================================================================
// GOAWAY バリデーション
// ============================================================================

/**
 * リクエストストリーム上の GOAWAY の Request ID 存在チェック
 *
 * draft-ietf-moq-transport-18 §10.4 (GOAWAY):
 * "Request ID: Present only when sent on the control stream."
 * リクエストストリーム上の GOAWAY に Request ID が含まれている場合、
 * PROTOCOL_VIOLATION でセッションを閉じる。
 *
 * @returns バリデーション通過時は true、違反時は false
 */
export function validateGoawayOnRequestStream(
  requestId: bigint | null,
  closeSession: (error: SessionError) => void,
): boolean {
  if (requestId !== null) {
    closeSession(
      new SessionError(
        "goaway on request stream must not include request id",
        SessionErrorCode.PROTOCOL_VIOLATION,
      ),
    );
    return false;
  }
  return true;
}

/**
 * REQUEST_OK Track Properties 非空検証
 *
 * draft-ietf-moq-transport-18 §10.5 (REQUEST_OK):
 * "Track Properties are populated in TRACK_STATUS_OK; they are empty in
 *  PUBLISH_OK, REQUEST_UPDATE_OK, SUBSCRIBE_NAMESPACE_OK and PUBLISH_NAMESPACE_OK.
 *  If an endpoint receives Track Properties in one of these messages it MUST
 *  close the session with a PROTOCOL_VIOLATION."
 *
 * @returns バリデーション通過時は true、違反時は false
 */
export function validateRequestOkNoTrackProperties(
  trackProperties: Property[],
  contextName: string,
  closeSession: (error: SessionError) => void,
): boolean {
  if (trackProperties.length > 0) {
    closeSession(
      new SessionError(
        `track properties must be empty in ${contextName}`,
        SessionErrorCode.PROTOCOL_VIOLATION,
      ),
    );
    return false;
  }
  return true;
}

// ============================================================================
// sendRequestOnBidiStream
// ============================================================================

export async function bidiSendRequestOnBidiStream(
  session: BidiSessionInternal,
  requestId: bigint,
  type: number,
  payload: Uint8Array,
  decoded?: Record<string, unknown>,
): Promise<RequestStreamInfo> {
  if (!session.controlWriter) {
    throw new Error("Control writer not initialized");
  }

  const stream = await session.transport.createBidirectionalStream();
  const writer = stream.writable.getWriter();
  const controlReader = new ControlStreamReader();

  const message = session.controlWriter.encode(type, payload);
  session.statsControlMessagesSent++;
  session.emitDebug("send", type, payload, decoded);
  await writer.write(message);

  const streamInfo: RequestStreamInfo = { stream, writer, controlReader };
  session.requestStreams.set(requestId, streamInfo);

  return streamInfo;
}

// ============================================================================
// readResponseFromBidiStream
// ============================================================================

export async function bidiReadResponseFromBidiStream(
  stream: WebTransportBidirectionalStream,
  controlReader: ControlStreamReader,
): Promise<ControlMessage> {
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

// ============================================================================
// readPublishResponse
// ============================================================================

export async function bidiReadPublishResponse(
  session: BidiSessionInternal,
  requestId: bigint,
  stream: WebTransportBidirectionalStream,
  controlReader: ControlStreamReader,
): Promise<void> {
  const pending = session.pendingPublish.get(requestId);
  if (!pending) return;

  try {
    const msg = await bidiReadResponseFromBidiStream(stream, controlReader);
    session.emitDebug("recv", msg.type, msg.payload);

    if (msg.type === MessageType.REQUEST_OK) {
      const decoded = decodeRequestOkPayload(msg.payload);
      // draft-ietf-moq-transport-18 §10.2.1 (Parameter Scope):
      // 許可されていないパラメータを受信した場合は PROTOCOL_VIOLATION
      if (
        !validateParameterScope(
          decoded.parameters,
          PUBLISH_OK_ALLOWED_PARAMS,
          "PUBLISH_OK",
          (error) => session.closeWithError(error),
        )
      ) {
        return;
      }
      // draft-ietf-moq-transport-18 §10.5 (REQUEST_OK):
      // "Track Properties are populated in TRACK_STATUS_OK; they are empty in
      //  PUBLISH_OK, REQUEST_UPDATE_OK, SUBSCRIBE_NAMESPACE_OK and PUBLISH_NAMESPACE_OK.
      //  If an endpoint receives Track Properties in one of these messages it MUST
      //  close the session with a PROTOCOL_VIOLATION."
      if (decoded.trackProperties.length > 0) {
        const error = new SessionError(
          "track properties must be empty in PUBLISH_OK",
          SessionErrorCode.PROTOCOL_VIOLATION,
        );
        session.pendingPublish.delete(requestId);
        session.requestStreams.delete(requestId);
        pending.reject(error);
        session.closeWithError(error);
        return;
      }
      pending.impl.goawayCallback = pending.goawayCallback;
      session.pendingPublish.delete(requestId);
      session.publishers.set(requestId, pending.impl);

      const forwardState = extractForwardState(decoded.parameters);
      pending.impl.setForwardState(forwardState);
      pending.resolve(pending.impl);

      void bidiReadRequestStreamMessages(session, requestId, stream, controlReader);
    } else if (msg.type === MessageType.REQUEST_ERROR) {
      const decoded = decodeRequestErrorPayload(msg.payload);
      session.pendingPublish.delete(requestId);
      session.requestStreams.delete(requestId);
      const error = new RequestError(
        decoded.reasonPhrase || `Request failed with code ${decoded.errorCode}`,
        normalizeRequestErrorCode(Number(decoded.errorCode)),
        decoded.retryInterval,
        decoded.redirect
          ? {
              connectUri: decoded.redirect.connectUri,
              trackNamespace: decoded.redirect.trackNamespace.tuple,
              trackName: decoded.redirect.trackName,
            }
          : undefined,
      );
      pending.reject(error);
    } else if (msg.type === MessageType.GOAWAY) {
      const decoded = decodeGoawayPayload(msg.payload);
      if (
        !validateGoawayOnRequestStream(decoded.requestId, (error) => session.closeWithError(error))
      ) {
        return;
      }
      session.goawayReceivedOnRequestStreams.add(requestId);
      session.pendingPublish.delete(requestId);
      session.requestStreams.delete(requestId);
      pending.goawayCallback?.(decoded.newSessionUri);
      pending.reject(new Error("request stream goaway"));
    } else {
      session.pendingPublish.delete(requestId);
      session.requestStreams.delete(requestId);
      pending.reject(new Error(`unexpected response type ${msg.type} for PUBLISH request`));
    }
  } catch (error) {
    session.pendingPublish.delete(requestId);
    session.requestStreams.delete(requestId);
    pending.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

// ============================================================================
// readSubscribeResponse
// ============================================================================

export async function bidiReadSubscribeResponse(
  session: BidiSessionInternal,
  requestId: bigint,
  stream: WebTransportBidirectionalStream,
  controlReader: ControlStreamReader,
): Promise<void> {
  const pending = session.pendingSubscribe.get(requestId);
  if (!pending) return;

  try {
    const msg = await bidiReadResponseFromBidiStream(stream, controlReader);
    session.emitDebug("recv", msg.type, msg.payload);

    if (msg.type === MessageType.SUBSCRIBE_OK) {
      const decoded = decodeSubscribeOkPayload(msg.payload);
      if (
        !validateParameterScope(
          decoded.parameters,
          SUBSCRIBE_OK_ALLOWED_PARAMS,
          "SUBSCRIBE_OK",
          (error) => session.closeWithError(error),
        )
      ) {
        return;
      }

      const largestLocation = extractLargestLocation(decoded.parameters);

      pending.impl.goawayCallback = pending.goawayCallback;
      session.pendingSubscribe.delete(requestId);

      const existingSubscriber = session.subscribersByAlias.get(decoded.trackAlias);
      if (existingSubscriber && existingSubscriber !== pending.impl) {
        const error = new SessionError(
          `duplicate track alias: ${decoded.trackAlias}`,
          SessionErrorCode.DUPLICATE_TRACK_ALIAS,
        );
        pending.reject(error);
        session.closeWithError(error);
        return;
      }

      pending.impl.setTrackAlias(decoded.trackAlias);

      if (largestLocation) {
        pending.impl.setLargestLocation(largestLocation);
      }

      if (decoded.trackProperties.length > 0) {
        pending.impl.setTrackProperties(decoded.trackProperties);
      }

      session.subscribers.set(requestId, pending.impl);
      session.subscribersByAlias.set(decoded.trackAlias, pending.impl);

      session.pendingSubgroupBuffer.notifyAlias(decoded.trackAlias, "subscriber");

      if (pending.joiningFetch) {
        if (largestLocation) {
          void bidiSendJoiningFetch(
            session,
            requestId,
            pending.joiningFetch,
            pending.objectCallback,
            largestLocation,
          );
        } else {
          pending.joiningFetch.onEnd?.();
        }
      }

      pending.resolve(pending.impl);

      void bidiReadRequestStreamMessages(session, requestId, stream, controlReader);
    } else if (msg.type === MessageType.REQUEST_ERROR) {
      const decoded = decodeRequestErrorPayload(msg.payload);
      session.pendingSubscribe.delete(requestId);
      session.requestStreams.delete(requestId);
      const error = new RequestError(
        decoded.reasonPhrase || `Request failed with code ${decoded.errorCode}`,
        normalizeRequestErrorCode(Number(decoded.errorCode)),
      );
      pending.reject(error);
    } else if (msg.type === MessageType.GOAWAY) {
      const decoded = decodeGoawayPayload(msg.payload);
      if (
        !validateGoawayOnRequestStream(decoded.requestId, (error) => session.closeWithError(error))
      ) {
        return;
      }
      session.goawayReceivedOnRequestStreams.add(requestId);
      session.pendingSubscribe.delete(requestId);
      session.requestStreams.delete(requestId);
      pending.goawayCallback?.(decoded.newSessionUri);
      pending.reject(new Error("request stream goaway"));
    } else {
      session.pendingSubscribe.delete(requestId);
      session.requestStreams.delete(requestId);
      pending.reject(new Error(`unexpected response type ${msg.type} for SUBSCRIBE request`));
    }
  } catch (error) {
    session.pendingSubscribe.delete(requestId);
    session.requestStreams.delete(requestId);
    pending.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

// ============================================================================
// readFetchResponse
// ============================================================================

export async function bidiReadFetchResponse(
  session: BidiSessionInternal,
  requestId: bigint,
  stream: WebTransportBidirectionalStream,
  controlReader: ControlStreamReader,
): Promise<void> {
  const pending = session.pendingFetch.get(requestId);
  if (!pending) return;

  try {
    const msg = await bidiReadResponseFromBidiStream(stream, controlReader);
    session.emitDebug("recv", msg.type, msg.payload);

    if (msg.type === MessageType.FETCH_OK) {
      const decoded = decodeFetchOkPayload(msg.payload);
      if (
        !validateParameterScope(decoded.parameters, FETCH_OK_ALLOWED_PARAMS, "FETCH_OK", (error) =>
          session.closeWithError(error),
        )
      ) {
        return;
      }

      if (pending.startLocation) {
        const endLoc = decoded.endLocation;
        const startLoc = pending.startLocation;
        const errorMessage = validateFetchOkEndLocation(startLoc, endLoc);
        if (errorMessage !== undefined) {
          const error = new SessionError(errorMessage, SessionErrorCode.PROTOCOL_VIOLATION);
          session.pendingFetch.delete(requestId);
          pending.reject(error);
          session.closeWithError(error);
          return;
        }
      }

      // draft-ietf-moq-transport-18 Section 10.2.8 (GROUP ORDER Parameter):
      // 省略時は Ascending (0x1) がデフォルト
      const groupOrderParam = decoded.parameters.find(
        (p) => p.type === MessageParameterType.GROUP_ORDER,
      );
      const groupOrder =
        groupOrderParam && groupOrderParam.value.length > 0
          ? (groupOrderParam.value[0] as GroupOrder)
          : undefined;

      pending.impl.goawayCallback = pending.goawayCallback;
      session.pendingFetch.delete(requestId);
      pending.impl.setFetchOkInfo(
        decoded.endOfTrack,
        decoded.endLocation,
        decoded.trackProperties,
        groupOrder,
      );
      session.fetchers.set(requestId, pending.impl);
      pending.resolve(pending.impl);

      const fetcherCallbacks = session.fetcherReadyCallbacks.get(requestId);
      if (fetcherCallbacks) {
        for (const cb of fetcherCallbacks) {
          cb();
        }
        session.fetcherReadyCallbacks.delete(requestId);
      }
    } else if (msg.type === MessageType.REQUEST_ERROR) {
      const decoded = decodeRequestErrorPayload(msg.payload);
      session.pendingFetch.delete(requestId);
      session.requestStreams.delete(requestId);
      const error = new RequestError(
        decoded.reasonPhrase || `Request failed with code ${decoded.errorCode}`,
        normalizeRequestErrorCode(Number(decoded.errorCode)),
      );
      pending.reject(error);
    } else if (msg.type === MessageType.GOAWAY) {
      const decoded = decodeGoawayPayload(msg.payload);
      if (
        !validateGoawayOnRequestStream(decoded.requestId, (error) => session.closeWithError(error))
      ) {
        return;
      }
      session.goawayReceivedOnRequestStreams.add(requestId);
      session.pendingFetch.delete(requestId);
      session.requestStreams.delete(requestId);
      pending.goawayCallback?.(decoded.newSessionUri);
      pending.reject(new Error("request stream goaway"));
    } else {
      session.pendingFetch.delete(requestId);
      session.requestStreams.delete(requestId);
      pending.reject(new Error(`unexpected response type ${msg.type} for FETCH request`));
    }
  } catch (error) {
    session.pendingFetch.delete(requestId);
    session.requestStreams.delete(requestId);
    pending.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

// ============================================================================
// readTrackStatusResponse
// ============================================================================

export async function bidiReadTrackStatusResponse(
  session: BidiSessionInternal,
  requestId: bigint,
  stream: WebTransportBidirectionalStream,
  controlReader: ControlStreamReader,
): Promise<void> {
  const pending = session.pendingTrackStatus.get(requestId);
  if (!pending) return;

  try {
    const msg = await bidiReadResponseFromBidiStream(stream, controlReader);
    session.emitDebug("recv", msg.type, msg.payload);

    if (msg.type === MessageType.REQUEST_OK) {
      const decoded = decodeRequestOkPayload(msg.payload);
      session.pendingTrackStatus.delete(requestId);
      session.requestStreams.delete(requestId);
      pending.resolve({ parameters: decoded.parameters });
    } else if (msg.type === MessageType.REQUEST_ERROR) {
      const decoded = decodeRequestErrorPayload(msg.payload);
      session.pendingTrackStatus.delete(requestId);
      session.requestStreams.delete(requestId);
      const error = new RequestError(
        decoded.reasonPhrase || `Request failed with code ${decoded.errorCode}`,
        normalizeRequestErrorCode(Number(decoded.errorCode)),
      );
      pending.reject(error);
    } else if (msg.type === MessageType.GOAWAY) {
      // TRACK_STATUS は単発リクエストであり ongoing loop を持たないため
      // goawayCallback は不要。newSessionUri は Error.message 経由で通知する。
      const decoded = decodeGoawayPayload(msg.payload);
      if (
        !validateGoawayOnRequestStream(decoded.requestId, (error) => session.closeWithError(error))
      ) {
        return;
      }
      session.goawayReceivedOnRequestStreams.add(requestId);
      session.pendingTrackStatus.delete(requestId);
      session.requestStreams.delete(requestId);
      pending.reject(
        new Error(`request stream goaway: ${decoded.newSessionUri || "no redirect URI"}`),
      );
    } else {
      session.pendingTrackStatus.delete(requestId);
      session.requestStreams.delete(requestId);
      pending.reject(new Error(`unexpected response type ${msg.type} for TRACK_STATUS request`));
    }
  } catch (error) {
    session.pendingTrackStatus.delete(requestId);
    session.requestStreams.delete(requestId);
    pending.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

// ============================================================================
// readRequestStreamMessages
// ============================================================================

export async function bidiReadRequestStreamMessages(
  session: BidiSessionInternal,
  requestId: bigint,
  stream: WebTransportBidirectionalStream,
  controlReader: ControlStreamReader,
): Promise<void> {
  const reader = stream.readable.getReader();
  try {
    while (session.sessionState === "connected") {
      const { value, done } = await reader.read();
      if (done) break;

      const messages = controlReader.feed(value);
      for (const msg of messages) {
        session.emitDebug("recv", msg.type, msg.payload);

        switch (msg.type) {
          case MessageType.PUBLISH_DONE: {
            bidiHandlePublishDone(session, msg.payload, requestId);
            break;
          }
          case MessageType.REQUEST_OK: {
            bidiHandleRequestUpdateOk(session, msg.payload, requestId);
            break;
          }
          case MessageType.REQUEST_ERROR: {
            const decoded = decodeRequestErrorPayload(msg.payload);
            const error = new RequestError(
              decoded.reasonPhrase || `Request failed with code ${decoded.errorCode}`,
              normalizeRequestErrorCode(Number(decoded.errorCode)),
            );
            for (const [updateId, pendingUpdate] of session.pendingRequestUpdate) {
              if (pendingUpdate.targetRequestId === requestId) {
                session.pendingRequestUpdate.delete(updateId);
                pendingUpdate.reject(error);
                break;
              }
            }
            break;
          }
          case MessageType.REQUEST_UPDATE: {
            // draft-ietf-moq-transport-18 §10.9:
            // 「A subscriber can also send REQUEST_UPDATE to modify parameters of a
            //  subscription established with PUBLISH.」
            // クライアントが Publisher の場合、サーバー (Subscriber 役) が
            // PUBLISH bidi ストリーム上で REQUEST_UPDATE を送信してくる。
            const decoded = decodeRequestUpdatePayload(msg.payload);
            const publisher = session.publishers.get(requestId);
            if (publisher) {
              const forwardState = extractForwardState(decoded.parameters);
              publisher.setForwardState(forwardState);
            }
            break;
          }
          case MessageType.GOAWAY: {
            // draft-ietf-moq-transport-18 §10.4:
            // リクエストストリーム上の GOAWAY は当該リクエストの
            // マイグレーションのみを目的とし、セッション全体は閉じない。
            // "A GOAWAY MAY also be sent on a request stream to initiate
            //  migration of that individual request."
            // 同一リクエストストリーム上の重複 GOAWAY は PROTOCOL_VIOLATION。
            if (session.goawayReceivedOnRequestStreams.has(requestId)) {
              session.closeWithError(
                new SessionError(
                  "received duplicate goaway on request stream",
                  SessionErrorCode.PROTOCOL_VIOLATION,
                ),
              );
              return;
            }
            session.goawayReceivedOnRequestStreams.add(requestId);
            const decoded = decodeGoawayPayload(msg.payload);
            if (
              !validateGoawayOnRequestStream(decoded.requestId, (error) =>
                session.closeWithError(error),
              )
            ) {
              return;
            }
            const publisher = session.publishers.get(requestId);
            if (publisher?.goawayCallback) {
              publisher.goawayCallback(decoded.newSessionUri);
            }
            const subscriber = session.subscribers.get(requestId);
            if (subscriber?.goawayCallback) {
              subscriber.goawayCallback(decoded.newSessionUri);
            }
            const fetcher = session.fetchers.get(requestId);
            if (fetcher?.goawayCallback) {
              fetcher.goawayCallback(decoded.newSessionUri);
            }
            return;
          }
          default:
            session.closeWithError(
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
    session.requestStreams.delete(requestId);
  }
}

// ============================================================================
// sendRequestUpdate
// ============================================================================

export async function bidiSendRequestUpdate(
  session: BidiSessionInternal,
  subscriber: SubscriberImpl,
  options: RequestUpdateOptions,
): Promise<void> {
  const updateRequestId = session.nextRequestId;
  session.nextRequestId += 2n;

  const targetRequestId = subscriber.getRequestId();

  const parameters: Parameter[] = options.parameters ? [...options.parameters] : [];

  if (options.forward !== undefined) {
    parameters.push({
      type: MessageParameterType.FORWARD,
      value: encodeUint8ParameterValue(options.forward ? 1 : 0, "FORWARD"),
    });
  }

  const requestUpdateMsg = {
    type: MessageType.REQUEST_UPDATE,
    requestId: updateRequestId,
    parameters,
  };

  const payload = encodeRequestUpdatePayload(
    requestUpdateMsg as Parameters<typeof encodeRequestUpdatePayload>[0],
  );

  const streamInfo = session.requestStreams.get(targetRequestId);
  if (!streamInfo) {
    throw new Error(`request stream not found for request ID ${targetRequestId}`);
  }

  const promise = new Promise<void>((resolve, reject) => {
    session.pendingRequestUpdate.set(updateRequestId, {
      resolve,
      reject,
      targetRequestId,
    });
  });

  if (!session.controlWriter) {
    throw new Error("Control writer not initialized");
  }
  const message = session.controlWriter.encode(MessageType.REQUEST_UPDATE, payload);
  session.statsControlMessagesSent++;
  session.emitDebug("send", MessageType.REQUEST_UPDATE, payload, {
    requestId: updateRequestId.toString(),
    targetRequestId: targetRequestId.toString(),
  });
  await streamInfo.writer.write(message);

  return promise;
}

// ============================================================================
// sendJoiningFetch
// ============================================================================

export async function bidiSendJoiningFetch(
  session: BidiSessionInternal,
  subscribeRequestId: bigint,
  options: JoiningFetchOptions,
  defaultObjectCallback: (object: MoqtObject) => void,
  largestLocation: Location,
): Promise<void> {
  const requestId = session.nextRequestId;
  session.nextRequestId += 2n;

  const impl = new FetcherImpl(
    [],
    "",
    requestId,
    options.onObject ?? defaultObjectCallback,
    options.onEnd,
    options.onError,
  );

  impl.onCancel = async () => {
    await bidiCancelFetch(session, impl);
  };

  const estimatedStartLocation: Location =
    options.type === "relative"
      ? { group: largestLocation.group - options.start, object: 0n }
      : { group: options.start, object: 0n };

  session.pendingFetch.set(requestId, {
    resolve: () => {
      session.fetchers.set(requestId, impl);
    },
    reject: (err) => {
      options.onError?.(err);
    },
    impl,
    startLocation: estimatedStartLocation,
  });

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
    parameters: [] as Parameter[],
  };

  // FILL_TIMEOUT (0x0a) - draft-ietf-moq-transport-18 Section 10.2.5
  if (options.fillTimeout !== undefined) {
    fetchMsg.parameters.push({
      type: MessageParameterType.FILL_TIMEOUT,
      value: encodeVarint(options.fillTimeout),
    });
  }

  try {
    const payload = encodeFetchPayload(fetchMsg);
    const streamInfo = await bidiSendRequestOnBidiStream(
      session,
      requestId,
      MessageType.FETCH,
      payload,
      {
        requestId: requestId.toString(),
        fetchType: options.type,
        joiningRequestId: subscribeRequestId.toString(),
        joiningStart: options.start.toString(),
      },
    );

    void bidiReadFetchResponse(session, requestId, streamInfo.stream, streamInfo.controlReader);
  } catch (err) {
    session.pendingFetch.delete(requestId);
    const error = err instanceof Error ? err : new Error(String(err));
    options.onError?.(error);
  }
}

// ============================================================================
// cancelSubscription
// ============================================================================

export async function bidiCancelSubscription(
  session: BidiSessionInternal,
  subscriber: SubscriberImpl,
): Promise<void> {
  const requestId = subscriber.getRequestId();

  const streamInfo = session.requestStreams.get(requestId);
  if (streamInfo) {
    try {
      // draft-ietf-moq-transport-18 §5.1:
      // 「The subscriber terminates a subscription ... by sending STOP_SENDING.」
      // WebTransport では readable.cancel() が STOP_SENDING 相当。
      // 両方向をリセットして subscription 解除を通知する。
      await streamInfo.stream.readable.cancel("subscription cancelled");
      void streamInfo.writer.abort("subscription cancelled");
    } catch {
      // ストリームが既に閉じている場合は無視
    }
    session.requestStreams.delete(requestId);
  }

  session.subscribers.delete(requestId);
  session.subscribersByAlias.delete(subscriber.getTrackAlias());
}

// ============================================================================
// cancelFetch
// ============================================================================

export async function bidiCancelFetch(
  session: BidiSessionInternal,
  fetcher: FetcherImpl,
): Promise<void> {
  const requestId = fetcher.getRequestId();

  const streamInfo = session.requestStreams.get(requestId);
  if (streamInfo) {
    try {
      // draft-ietf-moq-transport-18 §5.2:
      // 「It MUST send STOP_SENDING for the bidi request stream.」
      // WebTransport では readable.cancel() が STOP_SENDING 相当。
      // 両方向をリセットして fetch 解除を通知する。
      await streamInfo.stream.readable.cancel("fetch cancelled");
      void streamInfo.writer.abort("fetch cancelled");
    } catch {
      // ストリームが既に閉じている場合は無視
    }
    session.requestStreams.delete(requestId);
  }

  session.fetchers.delete(requestId);
}

// ============================================================================
// handlePublishDone
// ============================================================================

export function bidiHandlePublishDone(
  session: BidiSessionInternal,
  payload: Uint8Array,
  requestId?: bigint,
): Record<string, unknown> {
  const msg = decodePublishDonePayload(payload);

  if (requestId !== undefined) {
    const subscriber = session.subscribers.get(requestId);
    if (subscriber) {
      // draft-ietf-moq-transport-18 §14 (Grease):
      // 未知の PUBLISH_DONE コードは INTERNAL_ERROR として扱う
      const normalizedCode = normalizePublishDoneCode(Number(msg.statusCode));
      subscriber.handleEnd(BigInt(normalizedCode), msg.reasonPhrase);
      session.subscribers.delete(requestId);
      session.subscribersByAlias.delete(subscriber.getTrackAlias());
    }
  }

  return {
    requestId: requestId?.toString() ?? "unknown",
    statusCode: msg.statusCode,
    streamCount: msg.streamCount.toString(),
    reasonPhrase: msg.reasonPhrase,
  };
}

// ============================================================================
// handleRequestUpdateOk
// ============================================================================

export function bidiHandleRequestUpdateOk(
  session: BidiSessionInternal,
  payload: Uint8Array,
  streamRequestId: bigint,
): void {
  const msg = decodeRequestOkPayload(payload);

  // draft-ietf-moq-transport-18 §10.2.1 (Parameter Scope):
  if (
    !validateParameterScope(
      msg.parameters,
      REQUEST_UPDATE_OK_ALLOWED_PARAMS,
      "REQUEST_UPDATE_OK",
      (error) => session.closeWithError(error),
    )
  ) {
    return;
  }

  // draft-ietf-moq-transport-18 §10.5 (REQUEST_OK):
  if (
    !validateRequestOkNoTrackProperties(msg.trackProperties, "REQUEST_UPDATE_OK", (error) =>
      session.closeWithError(error),
    )
  ) {
    return;
  }

  for (const param of msg.parameters) {
    if (param.type === MessageParameterType.LARGEST_OBJECT) {
      const location = getParameterLocationValue(param);
      const subscriber = session.subscribers.get(streamRequestId);
      if (subscriber) {
        subscriber.setLargestLocation(location);
      }
      break;
    }
  }

  for (const [updateId, pendingUpdate] of session.pendingRequestUpdate) {
    if (pendingUpdate.targetRequestId === streamRequestId) {
      session.pendingRequestUpdate.delete(updateId);
      pendingUpdate.resolve();
      break;
    }
  }
}
