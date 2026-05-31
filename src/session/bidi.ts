/**
 * MOQT Session - 双方向ストリーム処理
 *
 * SessionImpl から抽出した双方向ストリーム上の request/response 処理。
 * すべての関数は `BidiSessionInternal` インターフェースを通じて
 * SessionImpl の状態にアクセスする。
 */

import { ControlStreamReader, ControlStreamWriter, type ControlMessage } from "../controlStream";
import type { MoqtObject } from "../dataStream";
import { RequestError, type RequestErrorCode, SessionError, SessionErrorCode } from "../error";
import { FetcherImpl, type Fetcher } from "../fetcher";
import {
  MessageType,
  FetchType,
  MessageParameterType,
  encodeFetchPayload,
  encodeRequestUpdatePayload,
  encodeUint8ParameterValue,
  decodeFetchOkPayload,
  decodePublishDonePayload,
  decodePublishOkPayload,
  decodeRequestErrorPayload,
  decodeRequestOkPayload,
  decodeRequestUpdatePayload,
  decodeSubscribeOkPayload,
  getParameterLocationValue,
  type Location,
  type Parameter,
} from "../message";
import { PendingSubgroupBuffer } from "../pendingSubgroupBuffer";
import { PublisherImpl, type Publisher } from "../publisher";
import { SubscriberImpl, type Subscriber, type RequestUpdateOptions } from "../subscriber";
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
}

interface PendingSubscribe {
  resolve: (sub: Subscriber) => void;
  reject: (err: Error) => void;
  impl: SubscriberImpl;
  joiningFetch?: JoiningFetchOptions;
  objectCallback: (object: MoqtObject) => void;
}

interface PendingFetch {
  resolve: (fetcher: Fetcher) => void;
  reject: (err: Error) => void;
  impl: FetcherImpl;
  startLocation?: Location;
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

    if (msg.type === MessageType.PUBLISH_OK) {
      const decoded = decodePublishOkPayload(msg.payload);
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
        Number(decoded.errorCode) as RequestErrorCode,
      );
      pending.reject(error);
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

      const largestLocation = extractLargestLocation(decoded.parameters);

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
        Number(decoded.errorCode) as RequestErrorCode,
      );
      pending.reject(error);
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

      session.pendingFetch.delete(requestId);
      pending.impl.setFetchOkInfo(decoded.endOfTrack, decoded.endLocation, decoded.trackProperties);
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
        Number(decoded.errorCode) as RequestErrorCode,
      );
      pending.reject(error);
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
        Number(decoded.errorCode) as RequestErrorCode,
      );
      pending.reject(error);
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
              Number(decoded.errorCode) as RequestErrorCode,
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
    requiredRequestIdDelta: 0n,
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
    requiredRequestIdDelta: 0n,
    fetchType,
    joining: {
      joiningRequestId: subscribeRequestId,
      joiningStart: options.start,
    },
    parameters: [],
  };

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
      subscriber.handleEnd(msg.statusCode, msg.reasonPhrase);
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
