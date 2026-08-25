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
  InvalidFilterError,
  RequestError,
  RequestErrorCode,
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
  createTrackNamespace,
  encodeAuthorizationToken,
  encodeFetchPayload,
  encodeParameterTrackNamespace,
  encodeRequestUpdatePayload,
  encodeRequestErrorPayload,
  encodeRequestOkPayload,
  encodeUint8ParameterValue,
  decodeFetchOkPayload,
  decodeGoawayPayload,
  decodePublishDonePayload,
  decodeRequestErrorPayload,
  decodeRequestOkPayload,
  decodeRequestUpdatePayload,
  decodeSubscribeOkPayload,
  getParameterLocationValue,
  validateRangeFilterCombination,
  type AuthorizationToken,
  type Location,
  type Parameter,
  type RangeFilterSpec,
} from "../message";
import { PendingSubgroupBuffer } from "../pendingSubgroupBuffer";
import { PublisherImpl, type Publisher } from "../publisher";
import type { Property } from "../properties";
import {
  PUBLISH_OK_ALLOWED_PARAMS,
  PUBLISH_REQUEST_UPDATE_OK_PARAMS,
  SUBSCRIBE_OK_ALLOWED_PARAMS,
  FETCH_OK_ALLOWED_PARAMS,
  REQUEST_UPDATE_OK_ALLOWED_PARAMS,
  REQUEST_UPDATE_ALLOWED_PARAMS,
  TRACK_STATUS_OK_ALLOWED_PARAMS,
  validateParameterScope,
} from "../message/parameterScope";
import { SubscriberImpl, type Subscriber, type RequestUpdateOptions } from "../subscriber";
import { encodeVarint } from "../varint";
import type {
  JoiningFetchOptions,
  NamespaceUpdateOptions,
  SessionState,
  TrackStatusResult,
} from "../session";
import {
  extractForwardState,
  extractLargestLocation,
  validateFetchOkEndLocation,
  buildRangeFilterParameters,
  validateRangeFilterLimits,
  validateRangeFilterSpecs,
  validateNamespacePrefixUpdate,
  validateTrackNamespaceForSend,
} from "./params";
import { isPeerStreamError, toProtocolViolationSessionError } from "./errors";
import type { NamespaceSubscriptionState, TracksSubscriptionState } from "./types";

// ============================================================================
// 内部インターフェース
// ============================================================================

interface RequestStreamInfo {
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
  /**
   * REQUEST_UPDATE 送信時に指定された FORWARD 値。
   * draft-ietf-moq-transport-19 §10.2.17:
   * "If the parameter is omitted from REQUEST_UPDATE, the value for the
   *  subscription remains unchanged."
   * 省略時 (undefined) は REQUEST_OK 受信時に Forward State を更新しない。
   */
  forward?: boolean;
  /**
   * REQUEST_UPDATE 送信時に指定された Range Filters。
   * draft-ietf-moq-transport-19 §5.1.3:
   * "If a filter parameter is omitted from REQUEST_UPDATE, the value is
   *  unchanged."
   * 省略時 (undefined) は REQUEST_OK 受信時に Range Filters を更新しない。
   */
  rangeFilters?: RangeFilterSpec[];
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
  readonly subscribersByAlias: Map<bigint, SubscriberImpl[]>;
  readonly fetchers: Map<bigint, FetcherImpl>;

  readonly pendingSubgroupBuffer: PendingSubgroupBuffer;
  readonly fetcherReadyCallbacks: Map<bigint, Array<() => void>>;
  readonly goawayReceivedOnRequestStreams: Set<bigint>;

  // draft-ietf-moq-transport-19 §10.3.1.7: ピアの MAX_REQUEST_UPDATES（0 = 無制限）
  readonly peerMaxRequestUpdates: number;

  // draft-ietf-moq-transport-19 §10.3.1.6: ピアの MAX_FILTER_RANGES（0 = Range Filter 送信禁止）
  readonly peerMaxFilterRanges: number;

  statsControlMessagesSent: number;

  readonly namespaceSubscriptions: Map<bigint, NamespaceSubscriptionState>;
  readonly tracksSubscriptions: Map<bigint, TracksSubscriptionState>;

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
 * リクエストストリーム上の重複 GOAWAY を検出する
 *
 * draft-ietf-moq-transport-19 Section 10.4 (GOAWAY):
 * "The endpoint MUST close the session with a PROTOCOL_VIOLATION (Section 3.5)
 *  if it receives more than one GOAWAY on the control stream or on a single
 *  request stream."
 *
 * 重複なし（初回）の場合は seenSet に requestId を追加して true を返す。
 * 重複の場合は closeSession を PROTOCOL_VIOLATION で呼び false を返す。
 *
 * @returns 重複なしなら true、重複なら false
 */
export function validateNoDuplicateGoawayOnRequestStream(
  requestId: bigint,
  seenSet: Set<bigint>,
  closeSession: (error: SessionError) => void,
): boolean {
  if (seenSet.has(requestId)) {
    closeSession(
      new SessionError(
        "received duplicate goaway on request stream",
        SessionErrorCode.PROTOCOL_VIOLATION,
      ),
    );
    return false;
  }
  seenSet.add(requestId);
  return true;
}

/**
 * REQUEST_OK Track Properties 非空検証
 *
 * draft-ietf-moq-transport-19 §10.5 (REQUEST_OK):
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

async function bidiReadResponseFromBidiStream(
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
      // draft-ietf-moq-transport-19 §10.2.1 (Parameter Scope):
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
      // Range Filter の値域・構造・組み合わせ重複検証
      // draft-ietf-moq-transport-19 §5.1.3:
      // PUBLISH_OK では REQUEST_ERROR を送信できないため、違反は
      // PROTOCOL_VIOLATION でセッションを閉じる。
      try {
        validateRangeFilterCombination(decoded.parameters);
      } catch (error) {
        if (error instanceof InvalidFilterError) {
          const sessionError = new SessionError(error.message, SessionErrorCode.PROTOCOL_VIOLATION);
          session.pendingPublish.delete(requestId);
          session.requestStreams.delete(requestId);
          pending.reject(sessionError);
          session.closeWithError(sessionError);
          return;
        }
        throw error;
      }
      // draft-ietf-moq-transport-19 §10.5 (REQUEST_OK):
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
      session.pendingPublish.delete(requestId);
      session.publishers.set(requestId, pending.impl);

      const forwardState = extractForwardState(decoded.parameters);
      pending.impl.setForwardState(forwardState);
      pending.resolve(pending.impl);

      void bidiReadRequestStreamMessages(session, requestId, stream, controlReader, "publish");
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
      session.goawayReceivedOnRequestStreams.add(requestId);
      session.pendingPublish.delete(requestId);
      session.requestStreams.delete(requestId);
      pending.impl.goawayCallback?.(decoded.newSessionUri);
      pending.reject(new Error("request stream goaway"));
    } else {
      session.pendingPublish.delete(requestId);
      session.requestStreams.delete(requestId);
      pending.reject(new Error(`unexpected response type ${msg.type} for PUBLISH request`));
    }
  } catch (error) {
    // ProtocolViolationError / IncompleteDataError は仕様違反として PROTOCOL_VIOLATION でセッションを閉じる
    const sessionError = toProtocolViolationSessionError(error);
    if (sessionError) {
      // セッション閉鎖前に当該リクエストにも具体エラーを渡す
      // (Range Filter 違反・Track Properties 違反の既存経路と同パターン)
      session.pendingPublish.delete(requestId);
      session.requestStreams.delete(requestId);
      pending.reject(sessionError);
      session.closeWithError(sessionError);
      return;
    }
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

      session.pendingSubscribe.delete(requestId);

      const existingSubscribers = session.subscribersByAlias.get(decoded.trackAlias);
      if (existingSubscribers && existingSubscribers.length > 0) {
        // draft-ietf-moq-transport-19 §11.1: 同一 Track Alias が異なる Track に使われている場合のみ DUPLICATE_TRACK_ALIAS
        const fullTrackName = pending.impl.getFullTrackName();
        if (existingSubscribers[0].getFullTrackName() !== fullTrackName) {
          const error = new SessionError(
            `duplicate track alias: ${decoded.trackAlias}`,
            SessionErrorCode.DUPLICATE_TRACK_ALIAS,
          );
          pending.reject(error);
          session.closeWithError(error);
          return;
        }
      }

      pending.impl.setTrackAlias(decoded.trackAlias);

      if (largestLocation) {
        pending.impl.setLargestLocation(largestLocation);
      }

      if (decoded.trackProperties.length > 0) {
        pending.impl.setTrackProperties(decoded.trackProperties);
      }

      session.subscribers.set(requestId, pending.impl);
      const aliasList = session.subscribersByAlias.get(decoded.trackAlias);
      if (aliasList !== undefined) {
        aliasList.push(pending.impl);
      } else {
        session.subscribersByAlias.set(decoded.trackAlias, [pending.impl]);
      }

      session.pendingSubgroupBuffer.notifyAlias(decoded.trackAlias, "subscriber");

      if (pending.joiningFetch) {
        if (largestLocation) {
          void bidiSendJoiningFetch(
            session,
            requestId,
            pending.joiningFetch,
            pending.objectCallback,
            largestLocation,
            pending.impl.getAuthorizationToken(),
          );
        } else {
          pending.joiningFetch.onEnd?.();
        }
      }

      pending.resolve(pending.impl);

      void bidiReadRequestStreamMessages(session, requestId, stream, controlReader, "subscribe");
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
      session.goawayReceivedOnRequestStreams.add(requestId);
      session.pendingSubscribe.delete(requestId);
      session.requestStreams.delete(requestId);
      pending.impl.goawayCallback?.(decoded.newSessionUri);
      pending.reject(new Error("request stream goaway"));
    } else {
      session.pendingSubscribe.delete(requestId);
      session.requestStreams.delete(requestId);
      pending.reject(new Error(`unexpected response type ${msg.type} for SUBSCRIBE request`));
    }
  } catch (error) {
    // ProtocolViolationError / IncompleteDataError は仕様違反として PROTOCOL_VIOLATION でセッションを閉じる
    const sessionError = toProtocolViolationSessionError(error);
    if (sessionError) {
      // セッション閉鎖前に当該リクエストにも具体エラーを渡す
      // (Range Filter 違反・Track Properties 違反の既存経路と同パターン)
      session.pendingSubscribe.delete(requestId);
      session.requestStreams.delete(requestId);
      pending.reject(sessionError);
      session.closeWithError(sessionError);
      return;
    }
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

      // draft-ietf-moq-transport-19 §10.2.8: GROUP_ORDER は FETCH_OK に許可されない。
      // FETCH リクエスト側から groupOrder を設定できるようフィールドは FetcherImpl に残す。
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
        normalizeRequestErrorCode(Number(decoded.errorCode)),
      );
      pending.reject(error);
    } else if (msg.type === MessageType.GOAWAY) {
      const decoded = decodeGoawayPayload(msg.payload);
      session.goawayReceivedOnRequestStreams.add(requestId);
      session.pendingFetch.delete(requestId);
      session.requestStreams.delete(requestId);
      pending.impl.goawayCallback?.(decoded.newSessionUri);
      pending.reject(new Error("request stream goaway"));
    } else {
      session.pendingFetch.delete(requestId);
      session.requestStreams.delete(requestId);
      pending.reject(new Error(`unexpected response type ${msg.type} for FETCH request`));
    }
  } catch (error) {
    // ProtocolViolationError / IncompleteDataError は仕様違反として PROTOCOL_VIOLATION でセッションを閉じる
    const sessionError = toProtocolViolationSessionError(error);
    if (sessionError) {
      // セッション閉鎖前に当該リクエストにも具体エラーを渡す
      // (Range Filter 違反・Track Properties 違反の既存経路と同パターン)
      session.pendingFetch.delete(requestId);
      session.requestStreams.delete(requestId);
      pending.reject(sessionError);
      session.closeWithError(sessionError);
      return;
    }
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

      // draft-ietf-moq-transport-19 §10.2.1 (Parameter Scope)
      if (
        !validateParameterScope(
          decoded.parameters,
          TRACK_STATUS_OK_ALLOWED_PARAMS,
          "TRACK_STATUS_OK",
          (error) => session.closeWithError(error),
        )
      ) {
        return;
      }

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
    // ProtocolViolationError / IncompleteDataError は仕様違反として PROTOCOL_VIOLATION でセッションを閉じる
    const sessionError = toProtocolViolationSessionError(error);
    if (sessionError) {
      // セッション閉鎖前に当該リクエストにも具体エラーを渡す
      // (Range Filter 違反・Track Properties 違反の既存経路と同パターン)
      session.pendingTrackStatus.delete(requestId);
      session.requestStreams.delete(requestId);
      pending.reject(sessionError);
      session.closeWithError(sessionError);
      return;
    }
    pending.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

// ============================================================================
// handlePublishRequestUpdate
// ============================================================================
// 本セクションの応答送信ヘルパー (bidiSendRequestMessage / bidiSendRequestError
// / bidiSendRequestOk) と REQUEST_GOING_AWAY_REASON は、後続の
// bidiReadRequestStreamMessages (role=publish / subscribe 両ロールのハンドラ)
// と SessionImpl.runPublishStreamSubLoop (src/session.ts) からも使用される。
// REQUEST_GOING_AWAY_REASON は export し、GOAWAY 受信時の保留中
// REQUEST_UPDATE 掃除で共用する。

// GOAWAY 受信後の旧リクエストへの REQUEST_UPDATE を拒否する際の reasonPhrase
export const REQUEST_GOING_AWAY_REASON = "request stream is being migrated";

/**
 * リクエストストリーム上にメッセージを送信する
 *
 * 以下の場合は黙殺する (送信されていないため emitDebug は呼ばない):
 * - controlWriter が未設定
 * - requestStreams に requestId のエントリが無い
 * - write に失敗した (送信方向が FIN 済みなど)
 * 応答送信はベストエフォートであり、失敗しても受信方向の読み取りを継続する
 * (リクエスト送信側の bidiSendRequestOnBidiStream が controlWriter 不在で
 * throw するのとは意図が異なる)。
 */
async function bidiSendRequestMessage(
  session: BidiSessionInternal,
  requestId: bigint,
  type: number,
  payload: Uint8Array,
  decoded?: Record<string, unknown>,
): Promise<void> {
  if (session.controlWriter) {
    const message = session.controlWriter.encode(type, payload);
    const streamInfo = session.requestStreams.get(requestId);
    if (streamInfo) {
      try {
        await streamInfo.writer.write(message);
        session.emitDebug("send", type, payload, decoded);
      } catch {
        // ストリームが既に閉じている場合は無視 (実際には送信されていないため
        // emitDebug は呼ばない)
      }
    }
  }
}

/**
 * リクエストストリーム上に REQUEST_ERROR を送信する
 */
async function bidiSendRequestError(
  session: BidiSessionInternal,
  requestId: bigint,
  errorCode: RequestErrorCode,
  reasonPhrase: string,
): Promise<void> {
  const errorPayload = encodeRequestErrorPayload({
    type: MessageType.REQUEST_ERROR,
    errorCode: BigInt(errorCode),
    retryInterval: 0n,
    reasonPhrase,
  });
  await bidiSendRequestMessage(session, requestId, MessageType.REQUEST_ERROR, errorPayload, {
    errorCode,
  });
}

/**
 * リクエストストリーム上に REQUEST_OK (空 parameters / 空 trackProperties) を送信する
 */
async function bidiSendRequestOk(session: BidiSessionInternal, requestId: bigint): Promise<void> {
  const okPayload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [],
  });
  await bidiSendRequestMessage(session, requestId, MessageType.REQUEST_OK, okPayload);
}

/**
 * 受信 PUBLISH ストリーム上の REQUEST_UPDATE (ケース 1) を処理する
 *
 * draft-ietf-moq-transport-19 §10.9 (REQUEST_UPDATE):
 * 「The sender of a request (SUBSCRIBE, PUBLISH, FETCH, PUBLISH_NAMESPACE,
 * SUBSCRIBE_NAMESPACE, SUBSCRIBE_TRACKS) can later send a REQUEST_UPDATE on
 * the same bidi stream as the request to modify it.」
 * 受信 PUBLISH の publisher (ピア) が同じ bidi ストリーム上で送る
 * REQUEST_UPDATE を処理し、§10.9 の MUST に従い REQUEST_OK または
 * REQUEST_ERROR を 1 通応答する (coalescing はスコープ外)。
 *
 * 判定順序:
 * (1) GOAWAY 受信済みなら GOING_AWAY で応答して終了 (GOAWAY 後 + スコープ
 *     違反の同時発生時は GOING_AWAY を優先)。
 * (2) パラメータスコープ検証。違反は §10.2.1 の MUST により
 *     PROTOCOL_VIOLATION でセッションを閉じる。
 * (3) PUBLISH_REQUEST_UPDATE_OK_PARAMS (無限定 3 種 + FORWARD) 以外の
 *     文脈限定パラメータを含む場合は NOT_SUPPORTED で応答する。
 *     受理した FORWARD は受信 PUBLISH から生成された SubscriberImpl の
 *     Forward State に反映する (FORWARD 省略時は不変)。
 * (4) REQUEST_OK を応答する (ペイロードは空 parameters / 空 trackProperties)。
 *
 * 応答の書き込み失敗 (writer が閉じている等) は黙殺する。
 * デコード失敗は PROTOCOL_VIOLATION でセッションを閉じる (詳細は
 * インラインコメントを参照)。Request ID は読み取るだけで応答には含めない
 * (応答は同一 bidi ストリーム上に書き込まれることでリクエストが特定される。
 * 既存 role=publish ハンドラと同様)。
 *
 * 受理した FORWARD 以外のパラメータ (無限定 3 種) は状態として保持しない
 * (accept-then-ignore。更新の反映を前提とするピアと意味論が乖離する点は
 * 残余リスクとして残る)。
 */
export async function bidiHandlePublishRequestUpdate(
  session: BidiSessionInternal,
  requestId: bigint,
  payload: Uint8Array,
): Promise<void> {
  // 判定順序 (1): GOAWAY 受信済みの旧リクエストへの REQUEST_UPDATE は
  // REQUEST_ERROR (GOING_AWAY) で拒否する (draft-ietf-moq-transport-19
  // §10.6「GOING_AWAY: The endpoint has received a GOAWAY and MAY reject
  // new requests.」の趣旨に基づく拡張適用)。受信 PUBLISH の subscriber は
  // GOAWAY 処理で送信方向を FIN (writer.close()) で閉じているため、実際の
  // production では書き込み失敗となり黙殺される (無応答は GOAWAY 後の
  // マイグレーション対象リクエストに対する先行対応の「無視」と等価)。
  if (session.goawayReceivedOnRequestStreams.has(requestId)) {
    await bidiSendRequestError(
      session,
      requestId,
      RequestErrorCode.GOING_AWAY,
      REQUEST_GOING_AWAY_REASON,
    );
    return;
  }

  // 判定順序 (2) の前に REQUEST_UPDATE ペイロードをデコードする
  // デコード失敗は PROTOCOL_VIOLATION でセッションを閉じる。ControlStreamReader
  // は Length 分の完全なメッセージのみ渡すため、IncompleteDataError は
  // メッセージ構造の破損を意味する。呼び出し元ループの catch
  // (toProtocolViolationSessionError) でも IncompleteDataError は
  // PROTOCOL_VIOLATION に変換されるが、ここでは「invalid REQUEST_UPDATE
  // payload」の文脈を付与したメッセージで閉じ、後続のパラメータ検証を
  // 実行しないよう早期 return する。
  let decoded: ReturnType<typeof decodeRequestUpdatePayload>;
  try {
    decoded = decodeRequestUpdatePayload(payload);
  } catch (err) {
    session.closeWithError(
      new SessionError(
        `invalid REQUEST_UPDATE payload: ${err instanceof Error ? err.message : String(err)}`,
        SessionErrorCode.PROTOCOL_VIOLATION,
      ),
    );
    return;
  }

  // 判定順序 (2): パラメータスコープ検証
  // draft-ietf-moq-transport-19 §10.2.1 (Parameter Scope):
  // "If it appears in some other type of message, the receiving endpoint
  //  MUST close the connection with a PROTOCOL_VIOLATION."
  // 検証はメッセージ型単位であり、「for a subscription」等の文脈 (ケース 1
  // では publisher 送信) に違反するパラメータは判定順序 (3) で処理する。
  // REQUEST_UPDATE_ALLOWED_PARAMS (無限定 3 種 + 文脈限定 10 種) が
  // REQUEST_UPDATE に出現し得る全パラメータと完全一致する。
  if (
    !validateParameterScope(
      decoded.parameters,
      REQUEST_UPDATE_ALLOWED_PARAMS,
      "REQUEST_UPDATE",
      (error) => session.closeWithError(error),
    )
  ) {
    return;
  }

  // 判定順序 (3): 文脈限定パラメータの含有確認
  // REQUEST_OK で受理するのは PUBLISH_REQUEST_UPDATE_OK_PARAMS
  // (無限定 3 種 + FORWARD) のみ。それ以外の文脈限定パラメータ
  // (SUBSCRIBER_PRIORITY / LOCATION_FILTER / NEW_GROUP_REQUEST /
  // TRACK_NAMESPACE_PREFIX / Range Filters。列挙は
  // PUBLISH_REQUEST_UPDATE_OK_PARAMS の JSDoc を参照) を含む REQUEST_UPDATE
  // は REQUEST_ERROR (NOT_SUPPORTED) で応答する (draft-ietf-moq-transport-19
  // §10.6「NOT_SUPPORTED: The endpoint does not support the type of
  // request.」に基づく設計判断)。FORWARD と他の文脈限定パラメータが混合した
  // REQUEST_UPDATE もメッセージ単位で全体拒否する (FORWARD の部分受理は
  // しない)。
  if (decoded.parameters.some((param) => !PUBLISH_REQUEST_UPDATE_OK_PARAMS.has(param.type))) {
    await bidiSendRequestError(
      session,
      requestId,
      RequestErrorCode.NOT_SUPPORTED,
      "parameter not supported for request update",
    );
    return;
  }

  // draft-ietf-moq-transport-19 §10.9 / §10.2.17:
  // "If the parameter is omitted from REQUEST_UPDATE, the value for the
  //  subscription remains unchanged."
  // FORWARD パラメータが存在する場合のみ、受信 PUBLISH から生成された
  // SubscriberImpl の Forward State に反映する (省略時は不変)。
  const forwardParam = decoded.parameters.find(
    (param) => param.type === MessageParameterType.FORWARD,
  );
  if (forwardParam !== undefined) {
    const subscriber = session.subscribers.get(requestId);
    if (subscriber) {
      subscriber.setForwardState(extractForwardState(decoded.parameters));
    }
  }

  // 判定順序 (4): REQUEST_OK を応答する
  // draft-ietf-moq-transport-19 §10.9:
  // 「The receiver of a REQUEST_UPDATE MUST respond with exactly one REQUEST_OK
  //  or REQUEST_ERROR message indicating if the update was successful, ...」
  // (末尾の coalescing 例外は本関数のスコープ外)
  await bidiSendRequestOk(session, requestId);
}

// ============================================================================
// readRequestStreamMessages
// ============================================================================

/**
 * GOAWAY 受信時の旧リクエストストリームの終了処理
 *
 * draft-ietf-moq-transport-19 §10.4:
 * 「Upon receiving a GOAWAY on a request stream, the endpoint SHOULD re-issue
 *  that specific request ... and close the old request stream」
 * - publisher: 即時クローズせずアプリの done() に委ねる (§3.3.2 MUST「the
 *   publisher of an Established subscription MUST send PUBLISH_DONE, before
 *   sending a FIN」)。goawayCallback のみ呼ぶ。
 * - subscriber: goawayCallback を呼び、送信方向を FIN (writer.close()) で閉じる。
 * - fetcher: established FETCH に読み取りループは存在しないため対象外。
 *
 * GOAWAY 受信時点で旧ストリーム上の未応答 REQUEST_UPDATE は失敗として扱う。
 * GOAWAY 前に送信済みで応答待ちの update() の Promise を reject し、エントリを
 * 削除する。GOAWAY 後の読み取り継続中に REQUEST_OK / REQUEST_ERROR が届いても、
 * エントリ削除済みのため二重解決しない (REQUEST_ERROR ケースの coalescing
 * 処理と同様)。
 *
 * アプリの goawayCallback が throw しても、後続の掃除と close() が実行される
 * よう try/catch で黙殺する (アプリのコールバック例外はプロトコル違反ではない)。
 */
async function closeOldRequestStreamOnGoaway(
  session: BidiSessionInternal,
  requestId: bigint,
  newSessionUri: string,
): Promise<void> {
  const publisher = session.publishers.get(requestId);
  try {
    publisher?.goawayCallback?.(newSessionUri);
  } catch {
    // アプリのコールバック例外は黙殺する
  }
  const subscriber = session.subscribers.get(requestId);
  try {
    subscriber?.goawayCallback?.(newSessionUri);
  } catch {
    // アプリのコールバック例外は黙殺する
  }
  rejectPendingRequestUpdates(
    session,
    requestId,
    new RequestError(REQUEST_GOING_AWAY_REASON, RequestErrorCode.GOING_AWAY),
  );
  if (subscriber) {
    const streamInfo = session.requestStreams.get(requestId);
    if (streamInfo) {
      try {
        await streamInfo.writer.close();
      } catch {
        // ストリームが既に閉じている場合は無視
      }
    }
  }
}

export async function bidiReadRequestStreamMessages(
  session: BidiSessionInternal,
  requestId: bigint,
  stream: WebTransportBidirectionalStream,
  controlReader: ControlStreamReader,
  role: "publish" | "subscribe",
): Promise<void> {
  const reader = stream.readable.getReader();
  // ピアの graceful FIN (reader.read() の { done: true }) を記録し、
  // publish ロールのみ削除を done() 完了後まで遅延する判定に使う。
  let receivedFin = false;
  try {
    while (session.sessionState === "connected") {
      const { value, done } = await reader.read();
      if (done) {
        receivedFin = true;
        // draft-ietf-moq-transport-19 §3.3.2:
        // 受信側 (subscribe ロール) でピア (publisher) が PUBLISH_DONE を
        // 送らずに FIN した場合は失敗扱いであり、subscriber に通知する。
        // publish ロールでは requester の FIN は正常完了シグナルであり
        // 通知しない。
        if (role === "subscribe") {
          try {
            notifySubscriberFailure(
              session,
              requestId,
              new Error(FIN_WITHOUT_PUBLISH_DONE_MESSAGE),
            );
          } finally {
            // draft-ietf-moq-transport-19 §3.3.2:
            // 「A FIN sent by the responder after its response and any
            //  subsequent messages for the request signals that the request is
            //  complete; if it has not already done so, the requester SHOULD
            //  then send a FIN on its direction, gracefully closing the stream.」
            // ピア (publisher) の FIN を受けた requester は自方向も FIN で閉じて
            // graceful closure を完了する。正常経路 (PUBLISH_DONE → FIN) も
            // 失敗ケース (PUBLISH_DONE なしの FIN) も、この SHOULD に基づき
            // 無条件に close() する。
            // notifySubscriberFailure の error コールバックが throw しても close()
            // が実行されるよう finally で包む。
            // GOAWAY 受信済みの subscribe ロール (subscriber が存在する場合) では
            // GOAWAY ハンドラが既に writer.close() 済みのため、再度 close() する
            // と reject するが黙殺する。
            const streamInfo = session.requestStreams.get(requestId);
            if (streamInfo) {
              try {
                await streamInfo.writer.close();
              } catch {
                // ストリームが既に閉じている場合は無視
              }
            }
          }
        }
        break;
      }

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
            // draft-ietf-moq-transport-19 §10.9: coalescing により単一 REQUEST_ERROR で
            // 複数の REQUEST_UPDATE が失敗し得る。該当 pending をすべて reject する
            rejectPendingRequestUpdates(session, requestId, error);
            break;
          }
          case MessageType.REQUEST_UPDATE: {
            // draft-ietf-moq-transport-19 §10.4 / §3.3.4 / §10.9:
            // GOAWAY 受信後の旧リクエストに対する REQUEST_UPDATE の扱い。
            // - publish ロール: GOAWAY 処理で送信方向を閉じないため応答可能。
            //   §10.9 の MUST「The receiver of a REQUEST_UPDATE MUST respond
            //   with exactly one REQUEST_OK or REQUEST_ERROR message」を満たす
            //   ため、REQUEST_ERROR (GOING_AWAY) で応答する。
            // - subscribe ロール: GOAWAY 処理で送信方向を FIN (writer.close())
            //   で閉じているため GOING_AWAY 応答を書き込むことができない。
            //   §10.9 の MUST からは逸脱するが、§3.3.2 によりピアは FIN 後に
            //   REQUEST_UPDATE を送るべきではない (「will not need to respond
            //   to a future REQUEST_UPDATE」) ため、無視する。
            if (session.goawayReceivedOnRequestStreams.has(requestId)) {
              // publish ロールは送信方向が開いているため GOING_AWAY で応答する
              // (§10.9 MUST)。subscribe ロールは送信方向が FIN 済みのため応答
              // 不能であり、無視する。
              if (role === "publish") {
                await bidiSendRequestError(
                  session,
                  requestId,
                  RequestErrorCode.GOING_AWAY,
                  REQUEST_GOING_AWAY_REASON,
                );
              }
              break;
            }
            // draft-ietf-moq-transport-19 §10.9:
            // 予期しない REQUEST_UPDATE は PROTOCOL_VIOLATION でセッションを閉じる。
            // SUBSCRIBE ストリーム上で peer から REQUEST_UPDATE が来ることは
            // Section 10.9 の 2 ケースに該当しない。
            if (role === "subscribe") {
              session.closeWithError(
                new SessionError(
                  "unexpected REQUEST_UPDATE on subscribe stream",
                  SessionErrorCode.PROTOCOL_VIOLATION,
                ),
              );
              return;
            }

            // draft-ietf-moq-transport-19 §10.9:
            // 「A subscriber can also send REQUEST_UPDATE to modify parameters of a
            //  subscription established with PUBLISH.」
            // クライアントが Publisher の場合、サーバー (Subscriber 役) が
            // PUBLISH bidi ストリーム上で REQUEST_UPDATE を送信してくる。
            //
            // draft-ietf-moq-transport-19 §10.9:
            // 「The receiver of a REQUEST_UPDATE MUST respond with exactly one
            //  REQUEST_OK or REQUEST_ERROR message indicating if the update was
            //  successful, unless it is coalescing failed updates.」
            // デコード失敗は PROTOCOL_VIOLATION でセッションを閉じる。閉じる結果は
            // ループ catch (toProtocolViolationSessionError) と同じだが、ここでは
            // 「invalid REQUEST_UPDATE payload」の文脈を付与したメッセージで閉じ、
            // 後続のパラメータ検証を実行しないよう早期 return する
            // (bidiHandlePublishRequestUpdate と同パターン)。
            let decoded: ReturnType<typeof decodeRequestUpdatePayload>;
            try {
              decoded = decodeRequestUpdatePayload(msg.payload);
            } catch (err) {
              session.closeWithError(
                new SessionError(
                  `invalid REQUEST_UPDATE payload: ${err instanceof Error ? err.message : String(err)}`,
                  SessionErrorCode.PROTOCOL_VIOLATION,
                ),
              );
              return;
            }

            // パラメータスコープ検証
            // draft-ietf-moq-transport-19 §10.2.1 (Parameter Scope)
            if (
              !validateParameterScope(
                decoded.parameters,
                REQUEST_UPDATE_ALLOWED_PARAMS,
                "REQUEST_UPDATE",
                (error) => session.closeWithError(error),
              )
            ) {
              return;
            }

            // Range Filter の値域・構造・組み合わせ重複検証
            // draft-ietf-moq-transport-19 §5.1.3 / §10.2.12-14:
            // 不正な Range Filter は REQUEST_ERROR (INVALID_FILTER) で応答する。
            // 検証は状態変更 (setForwardState) より前に配置し、違反で
            // REQUEST_ERROR を応答したにも関わらず forward state が反映される
            // 不整合を防ぐ。
            try {
              validateRangeFilterCombination(decoded.parameters);
            } catch (error) {
              if (error instanceof InvalidFilterError) {
                await bidiSendRequestError(
                  session,
                  requestId,
                  RequestErrorCode.INVALID_FILTER,
                  error.message,
                );
                break;
              }
              throw error;
            }

            const publisher = session.publishers.get(requestId);
            if (publisher) {
              const forwardState = extractForwardState(decoded.parameters);
              publisher.setForwardState(forwardState);

              // REQUEST_OK を送信 (draft-ietf-moq-transport-19 §10.9 MUST)
              const okPayload = encodeRequestOkPayload({
                type: MessageType.REQUEST_OK,
                parameters: [],
                trackProperties: [],
              });
              if (session.controlWriter) {
                const message = session.controlWriter.encode(MessageType.REQUEST_OK, okPayload);
                const streamInfo = session.requestStreams.get(requestId);
                if (streamInfo) {
                  await streamInfo.writer.write(message);
                }
              }
              session.emitDebug("send", MessageType.REQUEST_OK, okPayload);
            } else {
              // publisher が存在しない場合は REQUEST_ERROR を送信
              // draft-ietf-moq-transport-19 §10.9: 更新失敗時は REQUEST_ERROR
              const errorPayload = encodeRequestErrorPayload({
                type: MessageType.REQUEST_ERROR,
                errorCode: BigInt(RequestErrorCode.INTERNAL_ERROR),
                retryInterval: 0n,
                reasonPhrase: "publisher not found for request update",
              });
              if (session.controlWriter) {
                const message = session.controlWriter.encode(
                  MessageType.REQUEST_ERROR,
                  errorPayload,
                );
                const streamInfo = session.requestStreams.get(requestId);
                if (streamInfo) {
                  await streamInfo.writer.write(message);
                }
              }
              session.emitDebug("send", MessageType.REQUEST_ERROR, errorPayload, {
                errorCode: RequestErrorCode.INTERNAL_ERROR,
              });
            }
            break;
          }
          case MessageType.GOAWAY: {
            // draft-ietf-moq-transport-19 §10.4:
            // リクエストストリーム上の GOAWAY は当該リクエストの
            // マイグレーションのみを目的とし、セッション全体は閉じない。
            // "A GOAWAY MAY also be sent on a request stream to initiate
            //  migration of that individual request."
            // 同一リクエストストリーム上の重複 GOAWAY は PROTOCOL_VIOLATION。
            if (
              !validateNoDuplicateGoawayOnRequestStream(
                requestId,
                session.goawayReceivedOnRequestStreams,
                (error) => session.closeWithError(error),
              )
            ) {
              return;
            }
            const decoded = decodeGoawayPayload(msg.payload);
            // draft-ietf-moq-transport-19 §10.4:
            // 「Upon receiving a GOAWAY on a request stream, the endpoint SHOULD
            //  re-issue that specific request ... and close the old request stream
            //  using the appropriate mechanism (e.g. FIN, stream reset, or
            //  PUBLISH_DONE).」
            // GOAWAY 受信後も読み取りを継続して 2 通目以降の GOAWAY を検出する
            // (§10.4 MUST)。
            // subscription state は変更しない (§10.4「The GOAWAY message does
            // not impact subscription state.」)。
            await closeOldRequestStreamOnGoaway(session, requestId, decoded.newSessionUri);
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
  } catch (error) {
    // ProtocolViolationError / IncompleteDataError は仕様違反として PROTOCOL_VIOLATION でセッションを閉じる
    const sessionError = toProtocolViolationSessionError(error);
    if (sessionError !== null) {
      session.closeWithError(sessionError);
    } else if (role === "subscribe" && isPeerStreamError(error)) {
      // draft-ietf-moq-transport-19 §3.3.3:
      // ピアの RESET_STREAM により readable がエラー終了した場合、subscriber の
      // error コールバックを呼び state を closed にする (アプリが終了を検知
      // できるようにする実用上の対応。FIN 経路の notifySubscriberFailure と同じ)。
      // セッションは閉じない (プロトコル違反ではない)。source: "stream" 以外
      // (セッション終了・内部エラー等) では通知しない。
      // 内側に try/catch が必要なのは、FIN 経路は外側の try 内で呼ばれ throw が
      // この catch に落ちて吸収されるのに対し、ここは catch ブロックの内側で
      // throw すると戻り値の Promise が reject し、fire-and-forget の void 呼び出し
      // で unhandled rejection になるためである。
      try {
        notifySubscriberFailure(session, requestId, new Error(RESET_REQUEST_STREAM_MESSAGE));
      } catch {
        // アプリの error コールバック例外は吸収する (markClosed は
        // notifySubscriberFailure 内の finally で実行済み)。
      }
    }
    // それ以外（セッション終了・内部エラー等）は既存通り無視する
  } finally {
    reader.releaseLock();
    const subscriber = session.subscribers.get(requestId);
    if (subscriber) {
      session.subscribers.delete(requestId);
      // requestId 単位で削除し、alias に他 subscription が無ければエントリ削除
      const aliasSubscribers = session.subscribersByAlias.get(subscriber.getTrackAlias());
      if (aliasSubscribers !== undefined) {
        const idx = aliasSubscribers.indexOf(subscriber);
        if (idx !== -1) {
          aliasSubscribers.splice(idx, 1);
        }
        if (aliasSubscribers.length === 0) {
          session.subscribersByAlias.delete(subscriber.getTrackAlias());
        }
      }
    }
    // draft-ietf-moq-transport-19 §3.3.2 の MUST「the publisher of an
    // Established subscription MUST send PUBLISH_DONE, before sending a FIN」:
    // ピアが送信方向を FIN で閉じた場合でも、publisher はアプリの done() が
    // 呼ばれたときに PUBLISH_DONE を送信してから自方向を FIN で閉じる必要が
    // ある。ここで requestStreams のエントリを削除してしまうと
    // publishSendPublishDone が streamInfo を引けず、PUBLISH_DONE 送信と FIN の
    // 両方をスキップする (§10.11 の MUST「A sender MUST NOT destroy subscription
    // state until it sends PUBLISH_DONE」にも抵触する)。
    // ピアの graceful FIN を受けた publisher ロールのみ削除を done() 完了後まで
    // 遅延する。それ以外の exit 経路 (GOAWAY / PROTOCOL_VIOLATION /
    // RESET_STREAM / セッション終了等) と subscribe ロールは従来どおり削除する。
    if (!(role === "publish" && receivedFin)) {
      session.requestStreams.delete(requestId);
    }
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
  const targetRequestId = subscriber.getRequestId();

  // draft-ietf-moq-transport-19 §10.4:
  // GOAWAY 受信後の旧リクエストへの REQUEST_UPDATE は送信しない。
  // ガードは「弾けるケースの早期失敗」であり、ガード通過後に GOAWAY が
  // 割り込んだ競合時の掃除 (write 失敗時のエントリ削除) は後段の
  // write 失敗 catch が担う。
  if (session.goawayReceivedOnRequestStreams.has(targetRequestId)) {
    throw new Error(`cannot send REQUEST_UPDATE: request stream is being migrated`);
  }

  // draft-ietf-moq-transport-19 §10.3.1.7:
  // ピアの MAX_REQUEST_UPDATES を超える outstanding REQUEST_UPDATE を送信してはならない
  const peerMax = session.peerMaxRequestUpdates;
  if (peerMax > 0) {
    let outstanding = 0;
    for (const [, pending] of session.pendingRequestUpdate) {
      if (pending.targetRequestId === targetRequestId) {
        outstanding++;
      }
    }
    if (outstanding >= peerMax) {
      throw new Error(
        `cannot send REQUEST_UPDATE: outstanding count ${outstanding} exceeds peer MAX_REQUEST_UPDATES ${peerMax}`,
      );
    }
  }

  const updateRequestId = session.nextRequestId;
  session.nextRequestId += 2n;

  // draft-ietf-moq-transport-19 §10.3.1.6: ピアの MAX_FILTER_RANGES を超える Range Filter 送信をガード
  // REQUEST_UPDATE は削除 (Length=0) を含むため、削除以外の Ranges 数のみチェックする
  validateRangeFilterLimits(options.rangeFilters, session.peerMaxFilterRanges, "REQUEST_UPDATE");

  // draft-ietf-moq-transport-19 §5.1.3:
  // REQUEST_UPDATE では削除 (Length=0) が許可されるが、TRACK_PROPERTY_FILTER (0x29) は
  // SUBSCRIBE_TRACKS リクエスト自身のストリーム上のみ許可される。moqt-js が送信する
  // REQUEST_UPDATE はすべて per-subscription の更新 (§10.9) のため、0x29 は一律 throw する。
  // 組み合わせ重複も送信前に検証する (§5.1.3 の MUST)
  validateRangeFilterSpecs(options.rangeFilters, "REQUEST_UPDATE", {
    allowRemove: true,
    allowTrackProperty: false,
  });

  const parameters: Parameter[] = options.parameters ? [...options.parameters] : [];

  // Range Filters (0x25–0x29) - draft-ietf-moq-transport-19 Section 5.1.3:
  // "In REQUEST_UPDATE, Length can be 0 to remove a filter parameter or
  //  non-zero to replace that entire filter parameter including all sets
  //  and Property Types. If a filter parameter is omitted from
  //  REQUEST_UPDATE, the value is unchanged."
  if (options.rangeFilters !== undefined) {
    parameters.push(...buildRangeFilterParameters(options.rangeFilters));
  }

  if (options.forward !== undefined) {
    parameters.push({
      type: MessageParameterType.FORWARD,
      value: encodeUint8ParameterValue(options.forward ? 1 : 0, "FORWARD"),
    });
  }

  // AUTHORIZATION_TOKEN (0x03) - draft-ietf-moq-msf-01 §11.4.3:
  // track に関連するトークンは REQUEST_UPDATE に MUST 付与。SUBSCRIBE 送信時のトークンを再利用する。
  const authorizationToken = subscriber.getAuthorizationToken();
  if (authorizationToken !== undefined) {
    parameters.push({
      type: MessageParameterType.AUTHORIZATION_TOKEN,
      value: encodeAuthorizationToken(authorizationToken),
    });
  }

  const requestUpdateMsg = {
    type: MessageType.REQUEST_UPDATE,
    requestId: updateRequestId,
    parameters,
  };

  const payload = encodeRequestUpdatePayload(requestUpdateMsg);

  const streamInfo = session.requestStreams.get(targetRequestId);
  if (!streamInfo) {
    throw new Error(`request stream not found for request ID ${targetRequestId}`);
  }
  // controlWriter 未初期化で throw する場合はエントリ登録前に失敗させる
  // (登録後の throw はエントリ残留を生むため)
  if (!session.controlWriter) {
    throw new Error("Control writer not initialized");
  }

  const promise = new Promise<void>((resolve, reject) => {
    session.pendingRequestUpdate.set(updateRequestId, {
      resolve,
      reject,
      targetRequestId,
      // draft-ietf-moq-transport-19 §10.2.17:
      // REQUEST_OK 受信時に Forward State へ反映するため、送信時の FORWARD
      // 値を保持する (省略時は undefined = 不変)。
      forward: options.forward,
      // draft-ietf-moq-transport-19 §5.1.3:
      // REQUEST_OK 受信時に Range Filters へ反映するため、送信時の値を保持する
      // (省略時は undefined = 不変)。
      rangeFilters: options.rangeFilters,
    });
  });
  // write in-flight 中に GOAWAY / REQUEST_ERROR / セッション close が
  // rejectPendingRequestUpdates を実行すると、return 前のこの promise が
  // 無観測のまま reject され unhandled rejection になる。reject は
  // return promise の adoption 経由で呼び出し元へ伝播するため、
  // ここでの catch は無観測 reject の抑制のみを担う。
  promise.catch(() => {});

  const message = session.controlWriter.encode(MessageType.REQUEST_UPDATE, payload);
  session.statsControlMessagesSent++;
  session.emitDebug("send", MessageType.REQUEST_UPDATE, payload, {
    requestId: updateRequestId.toString(),
    targetRequestId: targetRequestId.toString(),
  });
  try {
    await streamInfo.writer.write(message);
  } catch (err) {
    // write 失敗時はエントリを削除して残留を防ぐ。削除しないと、後続の
    // GOAWAY 処理やセッション close が登録済みの reject を呼び、呼び出し元に
    // 返されていない Promise の unhandled rejection を生む。
    session.pendingRequestUpdate.delete(updateRequestId);
    throw err;
  }

  return promise;
}

/**
 * SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS の Track Namespace Prefix 更新
 * REQUEST_UPDATE を送信する
 *
 * draft-ietf-moq-transport-19 §10.9.2 (Updating Namespace Subscriptions):
 * "A subscriber can update the Track Namespace Prefix of an established
 *  SUBSCRIBE_NAMESPACE or SUBSCRIBE_TRACKS by including the
 *  TRACK_NAMESPACE_PREFIX parameter (Section 10.2.19) in a REQUEST_UPDATE."
 *
 * SubscriberImpl 非依存の free function であり、namespaceSubscriptions /
 * tracksSubscriptions が保持する writer を経由して送信する。
 * 新 prefix は REQUEST_OK 受信時に namespacePrefix へ反映するため、
 * サブスクリプション状態の pendingPrefix に保持する。
 *
 * 送信前に以下を検証する:
 * - GOAWAY 受信後は送信しない (bidiSendRequestUpdate と同様)
 * - ピアの MAX_REQUEST_UPDATES を超える outstanding REQUEST_UPDATE を送信しない
 * - 更新が in-flight (REQUEST_OK 未受信) のうちの 2 件目は送信しない
 *   (単一スロット pendingPrefix による prefix 反映の競合を防ぐ)
 * - 予約 namespace の送信拒否 (§3.2.1 / §3.2.2)
 * - §10.9.2 の per-type 独立 overlap 制約 (更新対象自身を除く)
 *
 * @param session - セッション内部状態
 * @param requestId - 更新対象の SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS の Request ID
 * @param streamWriter - サブスクリプションの双方向ストリーム writer
 * @param options - 更新内容 (TRACK_NAMESPACE_PREFIX)
 * @returns REQUEST_OK 受信で resolve、REQUEST_ERROR / ストリームクローズで reject する Promise
 */
export async function bidiSendNamespaceRequestUpdate(
  session: BidiSessionInternal,
  requestId: bigint,
  streamWriter: WritableStreamDefaultWriter<Uint8Array>,
  options: NamespaceUpdateOptions,
): Promise<void> {
  // draft-ietf-moq-transport-19 §10.4:
  // GOAWAY を受信したリクエストストリームはマイグレーション対象のため、
  // 旧リクエストへの REQUEST_UPDATE は送信しない。
  // §10.4 の SHOULD NOT 列挙は SUBSCRIBE / PUBLISH 等の新規リクエストのみだが、
  // GOAWAY 処理で送信方向が FIN (writer.close()) 済みの場合に write が失敗し
  // pendingRequestUpdate エントリがリークするため、防御的に REQUEST_UPDATE も
  // 送信しない (bidiSendRequestUpdate と同様のガード)。
  if (session.goawayReceivedOnRequestStreams.has(requestId)) {
    throw new Error(`cannot send REQUEST_UPDATE: request stream is being migrated`);
  }

  // draft-ietf-moq-transport-19 §10.3.1.7:
  // ピアの MAX_REQUEST_UPDATES を超える outstanding REQUEST_UPDATE を送信してはならない
  const peerMax = session.peerMaxRequestUpdates;
  if (peerMax > 0) {
    let outstanding = 0;
    for (const [, pending] of session.pendingRequestUpdate) {
      if (pending.targetRequestId === requestId) {
        outstanding++;
      }
    }
    if (outstanding >= peerMax) {
      throw new Error(
        `cannot send REQUEST_UPDATE: outstanding count ${outstanding} exceeds peer MAX_REQUEST_UPDATES ${peerMax}`,
      );
    }
  }

  // draft-ietf-moq-transport-19 §3.2.1 / §3.2.2: 予約 namespace / .session の送信拒否
  validateTrackNamespaceForSend(options.trackNamespacePrefix);

  // draft-ietf-moq-transport-19 §10.9.2:
  // overlap 制約は型ごとに独立して適用される。更新対象自身は比較対象から除外する
  // (prefix 拡大更新を許可するため)。
  // 受信側の MUST は PREFIX_OVERLAP 応答 (§10.2.19) であり、この検証は
  // クライアント側の送信前先行担保である。
  const namespaceSubscription = session.namespaceSubscriptions.get(requestId);
  const tracksSubscription = session.tracksSubscriptions.get(requestId);
  const subscription = namespaceSubscription ?? tracksSubscription;
  if (!subscription) {
    throw new Error(`namespace subscription not found for request ID ${requestId}`);
  }
  if (subscription.state !== "active") {
    throw new Error("cannot send REQUEST_UPDATE: subscription is closed");
  }
  // draft-ietf-moq-transport-19 §10.9.2 の設計判断:
  // 更新の反映は subscription 状態の単一スロット pendingPrefix で行うため、
  // 複数の更新を並行送信すると先の REQUEST_OK 到着時に後の更新の prefix が
  // 誤って反映される。pendingPrefix が残っている (更新 in-flight) うちの
  // 2 件目は throw してこの競合を構造的に防ぐ。
  // ユーザーは前の update() の settle (resolve / reject) を待ってから呼ぶこと。
  if (subscription.pendingPrefix !== undefined) {
    throw new Error("cannot send REQUEST_UPDATE: another update is already in flight");
  }
  // 同一型のアクティブなサブスクリプション (更新対象自身を除く) の prefix を収集する
  const isNamespaceSubscription = namespaceSubscription !== undefined;
  const activeSubscriptions = isNamespaceSubscription
    ? session.namespaceSubscriptions
    : session.tracksSubscriptions;
  const activePrefixes: string[][] = [];
  for (const [id, sub] of activeSubscriptions) {
    if (id !== requestId && sub.state === "active") {
      activePrefixes.push(sub.namespacePrefix);
    }
  }
  validateNamespacePrefixUpdate(
    options.trackNamespacePrefix,
    activePrefixes,
    isNamespaceSubscription ? "SUBSCRIBE_NAMESPACE" : "SUBSCRIBE_TRACKS",
  );

  const updateRequestId = session.nextRequestId;
  session.nextRequestId += 2n;

  // 新 prefix を pendingPrefix に保持する。
  // REQUEST_OK 受信時に namespacePrefix へ反映し、REQUEST_ERROR 時は反映せずクリアする
  // (反映処理は namespaceLoops.ts の受信ループが行う)。
  subscription.pendingPrefix = options.trackNamespacePrefix;

  const parameters: Parameter[] = [
    // TRACK_NAMESPACE_PREFIX (0x34) - draft-ietf-moq-transport-19 Section 10.2.19
    encodeParameterTrackNamespace(createTrackNamespace(options.trackNamespacePrefix)),
  ];

  const requestUpdateMsg = {
    type: MessageType.REQUEST_UPDATE,
    requestId: updateRequestId,
    parameters,
  };

  const payload = encodeRequestUpdatePayload(requestUpdateMsg);

  const promise = new Promise<void>((resolve, reject) => {
    session.pendingRequestUpdate.set(updateRequestId, {
      resolve,
      reject,
      targetRequestId: requestId,
    });
  });
  // unsubscribe() / GOAWAY / REQUEST_ERROR / FIN 等の経路がこの pending を
  // reject した場合、アプリが観測しないままの reject は unhandled rejection
  // になり得る。呼び出し元の update() 側でも catch は付与されるが、本関数を
  // 直接呼ぶ経路に備えた防御的措置としてここでも catch する
  // (bidiSendRequestUpdate と同じ)。
  promise.catch(() => {});

  if (!session.controlWriter) {
    // 登録済みの pending と pendingPrefix を掃除してから throw する
    // (残留すると後続の REQUEST_OK で未送信の prefix が誤って反映される)
    session.pendingRequestUpdate.delete(updateRequestId);
    subscription.pendingPrefix = undefined;
    throw new Error("Control writer not initialized");
  }
  try {
    const message = session.controlWriter.encode(MessageType.REQUEST_UPDATE, payload);
    session.statsControlMessagesSent++;
    session.emitDebug("send", MessageType.REQUEST_UPDATE, payload, {
      requestId: updateRequestId.toString(),
      targetRequestId: requestId.toString(),
    });
    await streamWriter.write(message);
  } catch (error) {
    // 送信失敗時は保留中の更新と pendingPrefix を掃除してから throw する
    // (失敗した更新の REQUEST_OK は届かないため、残留すると後続の REQUEST_OK
    //  で未送信の prefix が誤って反映される)。
    // なお write 失敗はストリーム破壊 (RESET 等) を意味し、受信ループ側も
    // 同時に終了する想定である。理論上は掃除後に遅延 REQUEST_OK が届き得るが、
    // その場合は保留中更新なしとして PROTOCOL_VIOLATION で閉じられる
    // (handleNamespaceRequestUpdateOk の hasPendingRequestUpdate 検証)。
    session.pendingRequestUpdate.delete(updateRequestId);
    subscription.pendingPrefix = undefined;
    throw error;
  }

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
  authorizationToken?: AuthorizationToken,
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

  // FILL_TIMEOUT (0x0a) - draft-ietf-moq-transport-19 Section 10.2.5
  if (options.fillTimeout !== undefined) {
    fetchMsg.parameters.push({
      type: MessageParameterType.FILL_TIMEOUT,
      value: encodeVarint(options.fillTimeout),
    });
  }

  // Range Filters (0x25–0x28) - draft-ietf-moq-transport-19 Section 5.1.3
  // 削除は REQUEST_UPDATE のみ・TRACK_PROPERTY_FILTER は SUBSCRIBE_TRACKS のみ。
  // この関数は fire-and-forget (void) で起動されるため、ガード・エンコードの throw は
  // 未処理 rejection にならないよう catch で処理し、pendingFetch を削除して
  // options.onError で通知する。
  if (options.rangeFilters !== undefined) {
    try {
      validateRangeFilterLimits(options.rangeFilters, session.peerMaxFilterRanges, "Joining Fetch");
      validateRangeFilterSpecs(options.rangeFilters, "Joining Fetch", {
        allowRemove: false,
        allowTrackProperty: false,
      });
      fetchMsg.parameters.push(...buildRangeFilterParameters(options.rangeFilters));
    } catch (err) {
      session.pendingFetch.delete(requestId);
      const error = err instanceof Error ? err : new Error(String(err));
      options.onError?.(error);
      return;
    }
  }

  // AUTHORIZATION_TOKEN (0x03) - draft-ietf-moq-msf-01 §11.4.3:
  // Joining Fetch は SUBSCRIBE に紐づく FETCH のため、SUBSCRIBE と同じトークンを MUST 付与。
  if (authorizationToken !== undefined) {
    fetchMsg.parameters.push({
      type: MessageParameterType.AUTHORIZATION_TOKEN,
      value: encodeAuthorizationToken(authorizationToken),
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
      // draft-ietf-moq-transport-19 §5.1:
      // 「The subscriber terminates a subscription ... by sending STOP_SENDING.」
      // WebTransport では readable.cancel() が STOP_SENDING 相当。
      // 両方向をリセットして subscription 解除を通知する。
      await streamInfo.stream.readable.cancel("subscription cancelled");
      // GOAWAY 受信で送信方向を FIN (writer.close()) 済みの場合、abort は
      // reject する (閉じた writer への操作)。unhandled rejection を避けるため
      // catch で握り潰す。
      void streamInfo.writer.abort("subscription cancelled").catch(() => {});
    } catch {
      // ストリームが既に閉じている場合は無視
    }
    session.requestStreams.delete(requestId);
  }

  session.subscribers.delete(requestId);
  // requestId 単位で削除し、alias に他 subscription が無ければエントリ削除
  const aliasSubscribers = session.subscribersByAlias.get(subscriber.getTrackAlias());
  if (aliasSubscribers !== undefined) {
    const idx = aliasSubscribers.indexOf(subscriber);
    if (idx !== -1) {
      aliasSubscribers.splice(idx, 1);
    }
    if (aliasSubscribers.length === 0) {
      session.subscribersByAlias.delete(subscriber.getTrackAlias());
    }
  }
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
      // draft-ietf-moq-transport-19 §5.2:
      // 「It MUST send STOP_SENDING for the bidi request stream.」
      // WebTransport では readable.cancel() が STOP_SENDING 相当。
      // 両方向をリセットして fetch 解除を通知する。
      await streamInfo.stream.readable.cancel("fetch cancelled");
      // GOAWAY 受信で送信方向を FIN (writer.close()) 済みの場合、abort は
      // reject する (閉じた writer への操作)。unhandled rejection を避けるため
      // catch で握り潰す。
      void streamInfo.writer.abort("fetch cancelled").catch(() => {});
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
      // draft-ietf-moq-transport-19 §14 (Grease):
      // 未知の PUBLISH_DONE コードは INTERNAL_ERROR として扱う
      const normalizedCode = normalizePublishDoneCode(Number(msg.statusCode));
      subscriber.handleEnd(BigInt(normalizedCode), msg.reasonPhrase);
      // subscriber/subscribersByAlias の削除はストリーム close 時
      // (bidiReadRequestStreamMessages の finally) に委譲する
      // draft-ietf-moq-transport-19 §5.1
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
// notifySubscriberFailure
// ============================================================================

// ピアが PUBLISH_DONE を送らずに FIN した (失敗扱い) 際のエラーメッセージ
export const FIN_WITHOUT_PUBLISH_DONE_MESSAGE =
  "publisher closed request stream without PUBLISH_DONE";

// ピアが RESET_STREAM でストリームをエラー終了させた際のエラーメッセージ
export const RESET_REQUEST_STREAM_MESSAGE = "publisher reset request stream";

/**
 * ピアによる FIN (PUBLISH_DONE なし) または RESET_STREAM によるストリーム
 * エラー終了を subscriber へ通知する
 *
 * draft-ietf-moq-transport-19 §3.3.2 (Graceful Request Stream Closure):
 * 「An endpoint that receives a FIN before all required messages have
 * arrived treats the request as failed.」
 * 受信側 (subscribe ロール) で、ピア (publisher) が Established subscription
 * の必須メッセージ (PUBLISH_DONE) を送る前に FIN した場合、subscriber の
 * error コールバックを呼び state を closed にする。
 * ピアの RESET_STREAM によるエラー終了の通知 (RESET_REQUEST_STREAM_MESSAGE
 * を渡す) にも共用する。メッセージの区別は呼び出し側が行う。
 *
 * 本関数は subscribe ロール専用である。publish ロールのピア (requester) の
 * FIN / RESET は正常完了またはエラーシグナルであり、本関数を呼んでは
 * ならない (ロール分岐は呼び出し側が行う)。
 *
 * ガード:
 * - subscribers に requestId のエントリが無い場合は何もしない
 *   (unsubscribe 済み・未登録等)
 * - GOAWAY 受信済みの requestId では何もしない (GOAWAY は migration 通知
 *   であり失敗ではない。draft-ietf-moq-transport-19 §10.4「The GOAWAY
 *   message does not impact subscription state.」。migration の処理は
 *   アプリが goawayCallback で行う)
 * - state が "active" でない場合は何もしない (正常な PUBLISH_DONE → FIN は
 *   bidiHandlePublishDone → handleEnd で既に closed になっている)
 *
 * error コールバックを呼んだ後、finally で必ず markClosed する (error
 * コールバックが throw しても state が closed になることを保証する)。
 * throw 自体はここでは吸収しない (FIN 経路は呼び出し元の外側 catch が、
 * RESET 経路は呼び出し元の内側 try/catch が担う)。
 * handleEnd は使用しない (endCallback は PUBLISH_DONE 専用であり、失敗
 * 扱いの FIN で end を呼ぶと「正常終了」として誤認されるため)。
 */
export function notifySubscriberFailure(
  session: BidiSessionInternal,
  requestId: bigint,
  error: Error,
): void {
  const subscriber = session.subscribers.get(requestId);
  if (!subscriber) {
    return;
  }
  if (session.goawayReceivedOnRequestStreams.has(requestId)) {
    return;
  }
  if (subscriber.state !== "active") {
    return;
  }
  try {
    subscriber.handleError(error);
  } finally {
    subscriber.markClosed();
  }
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

  // draft-ietf-moq-transport-19 §10.2.1 (Parameter Scope):
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

  // draft-ietf-moq-transport-19 §10.5 (REQUEST_OK):
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

  // draft-ietf-moq-transport-19 §10.2.17:
  // "If the parameter is omitted from REQUEST_UPDATE, the value for the
  //  subscription remains unchanged."
  // 自 update({ forward }) の REQUEST_OK 受信時に、送信時の FORWARD 値
  // (pendingRequestUpdate エントリに保持) を Forward State へ反映する。
  // 省略時 (undefined) は反映しない。
  const resolved = resolvePendingRequestUpdate(session, streamRequestId);
  if (resolved !== undefined) {
    const subscriber = session.subscribers.get(streamRequestId);
    if (subscriber) {
      if (resolved.forward !== undefined) {
        subscriber.setForwardState(resolved.forward);
      }
      // draft-ietf-moq-transport-19 §5.1.3:
      // 自 update({ rangeFilters }) の REQUEST_OK 受信時に、送信時の Range Filters
      // を反映する (省略時は不変)
      if (resolved.rangeFilters !== undefined) {
        subscriber.setRangeFilters(resolved.rangeFilters);
      }
    }
  }
}

// ============================================================================
// pendingRequestUpdate ヘルパー
// ============================================================================

/**
 * 指定の targetRequestId を対象とする保留中の REQUEST_UPDATE が存在するか
 * 判定する
 *
 * 確立済みストリーム上の REQUEST_OK / REQUEST_ERROR が REQUEST_UPDATE への
 * 応答なのか、それとも不正な 2 通目の応答なのかを区別するために使う。
 */
export function hasPendingRequestUpdate(
  session: BidiSessionInternal,
  targetRequestId: bigint,
): boolean {
  for (const [, pending] of session.pendingRequestUpdate) {
    if (pending.targetRequestId === targetRequestId) {
      return true;
    }
  }
  return false;
}

/**
 * 指定の targetRequestId を対象とする保留中の REQUEST_UPDATE を 1 件解決する
 *
 * draft-ietf-moq-transport-19 §10.9.1:
 * "The receiver MUST still send a REQUEST_OK for each successful update"
 * REQUEST_OK は各更新につき 1 通送られるため、1 件のみ解決する。
 *
 * @returns 解決した更新の FORWARD 送信値 (省略時は undefined = 反映しない)
 */
export function resolvePendingRequestUpdate(
  session: BidiSessionInternal,
  targetRequestId: bigint,
): { forward?: boolean; rangeFilters?: RangeFilterSpec[] } | undefined {
  for (const [updateId, pending] of session.pendingRequestUpdate) {
    if (pending.targetRequestId === targetRequestId) {
      session.pendingRequestUpdate.delete(updateId);
      pending.resolve();
      return { forward: pending.forward, rangeFilters: pending.rangeFilters };
    }
  }
  return undefined;
}

/**
 * 指定の targetRequestId を対象とする保留中の REQUEST_UPDATE をすべて reject する
 *
 * draft-ietf-moq-transport-19 §10.9.1:
 * "If the coalesced REQUEST_UPDATE results in REQUEST_ERROR, only a single
 *  REQUEST_ERROR will be sent and the sender of the REQUEST_UPDATEs will not
 *  always be able to determine which caused an error."
 * coalescing により単一 REQUEST_ERROR が複数の REQUEST_UPDATE を失敗させる
 * 可能性があるため、すべて reject する。
 */
export function rejectPendingRequestUpdates(
  session: BidiSessionInternal,
  targetRequestId: bigint,
  error: Error,
): void {
  for (const [updateId, pending] of session.pendingRequestUpdate) {
    if (pending.targetRequestId === targetRequestId) {
      session.pendingRequestUpdate.delete(updateId);
      pending.reject(error);
    }
  }
}
