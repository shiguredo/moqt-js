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
  DataStreamErrorCode,
  InvalidFilterError,
  RequestError,
  RequestErrorCode,
  SessionError,
  SessionErrorCode,
  normalizeDataStreamErrorCode,
  normalizeRequestErrorCode,
  normalizePublishDoneCode,
} from "../error";
import { FetcherImpl, type Fetcher } from "../fetcher";
import {
  MessageType,
  MessageParameterType,
  createTrackNamespace,
  encodeAuthorizationToken,
  encodeParameterTrackNamespace,
  encodeRequestUpdatePayload,
  encodeRequestErrorPayload,
  encodeRequestOkPayload,
  encodeUint8ParameterValue,
  decodeFetchOkPayload,
  decodeFillParameters,
  decodeGoawayPayload,
  decodeLocationFilterParameter,
  decodePublishDonePayload,
  decodePublishStateNotifyPayload,
  decodeRequestErrorPayload,
  decodeRequestOkPayload,
  decodeRequestUpdatePayload,
  decodeSubscribeOkPayload,
  encodeFillParameters,
  getParameterLocationValue,
  validateRangeFilterCombination,
  type GroupOrder,
  type Location,
  type LocationFilter,
  type Parameter,
  type RangeFilterSpec,
} from "../message";
import { PendingSubgroupBuffer } from "../pendingSubgroupBuffer";
import { PublisherImpl, type Publisher } from "../publisher";
import type { Property } from "../properties";
import {
  PUBLISH_OK_ALLOWED_PARAMS,
  PUBLISH_REQUEST_UPDATE_OK_PARAMS,
  PUBLISH_STATE_NOTIFY_ALLOWED_PARAMS,
  SUBSCRIBE_OK_ALLOWED_PARAMS,
  FETCH_OK_ALLOWED_PARAMS,
  REQUEST_UPDATE_OK_ALLOWED_PARAMS,
  REQUEST_UPDATE_ALLOWED_PARAMS,
  TRACK_STATUS_OK_ALLOWED_PARAMS,
  validateParameterScope,
} from "../message/parameterScope";
import { SubscriberImpl, type Subscriber, type RequestUpdateOptions } from "../subscriber";
import type { TracksUpdateOptions, SessionState, TrackStatusResult } from "../session";
import {
  extractForwardState,
  extractLargestLocation,
  validateFetchOkEndLocation,
  buildFillParameters,
  buildRangeFilterParameters,
  mergeRangeFilters,
  resolveFillGroupOrder,
  validateRangeFilterLimits,
  validateRangeFilterSpecs,
  validateNamespacePrefixUpdate,
  validateTrackNamespaceForSend,
} from "./params";
import {
  REQUEST_UPDATE_STREAM_CLOSED_MESSAGE,
  isPeerStreamError,
  toProtocolViolationSessionError,
} from "./errors";
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
   * draft-ietf-moq-transport-20 §10.2.18:
   * "If the parameter is omitted from REQUEST_UPDATE, the value for the
   *  subscription remains unchanged."
   * 省略時 (undefined) は REQUEST_OK 受信時に Forward State を更新しない。
   */
  forward?: boolean;
  /**
   * REQUEST_UPDATE 送信時に指定された Range Filters。
   * draft-ietf-moq-transport-20 §5.1.4:
   * "If a filter parameter is omitted from REQUEST_UPDATE, the value is
   *  unchanged."
   * 省略時 (undefined) は REQUEST_OK 受信時に Range Filters を更新しない。
   */
  rangeFilters?: RangeFilterSpec[];
  /**
   * REQUEST_UPDATE 送信時に fill 内側で指定された Range Filters。
   * draft-ietf-moq-transport-20 §10.3.1.6:
   * 購読単位の上限検証に含めるため保持する (fill 自体は保持されないが、
   * in-flight 中の上限超過を見逃さない)。
   */
  fillRangeFilters?: RangeFilterSpec[];
  /**
   * REQUEST_UPDATE 送信時に指定された LOCATION_FILTER 値。
   * draft-ietf-moq-transport-20 §10.2.9:
   * "If omitted from REQUEST_UPDATE or PUBLISH_STATE_NOTIFY,
   *  the value is unchanged."
   * 省略時 (undefined) は REQUEST_OK 受信時に Location Filter を更新しない。
   */
  locationFilter?: LocationFilter;
}

/**
 * fill fetch ストリームと購読の関連付け
 *
 * draft-ietf-moq-transport-20 §5.1.3 (Fill Semantics):
 * fill fetch ストリームの FETCH_HEADER が運ぶ Request ID (初期 fill は
 * SUBSCRIBE、後続 fill は REQUEST_UPDATE のもの) から購読を引くための記録。
 */
export interface FillFetchTarget {
  subscriber: SubscriberImpl;
  /**
   * fill の Group Order。FILL_PARAMETERS 内の GROUP_ORDER が無ければ
   * subscription の指定、どちらも無ければ Ascending。
   */
  groupOrder: GroupOrder;
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
  /**
   * fill 要求元の Request ID から購読への関連付け
   *
   * draft-ietf-moq-transport-20 §5.1.3:
   * fill fetch ストリームの FETCH_HEADER が運ぶ Request ID で引く。
   * REQUEST_OK 受理で pending が消えても、fill ストリーム到着まで保持する
   * (応答と fill ストリームの順序は保証されない)。
   */
  readonly fillFetchTargets: Map<bigint, FillFetchTarget>;

  // draft-ietf-moq-transport-20 §10.3.1.7: ピアの MAX_REQUEST_UPDATES（0 = 無制限）
  readonly peerMaxRequestUpdates: number;

  // draft-ietf-moq-transport-20 §10.3.1.6: ピアの MAX_FILTER_RANGES（0 = Range Filter 送信禁止）
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
 * draft-ietf-moq-transport-20 Section 10.4 (GOAWAY):
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
 * draft-ietf-moq-transport-20 §10.5 (REQUEST_OK):
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
      // draft-ietf-moq-transport-20 §10.2.1 (Parameter Scope) / §10.2.16:
      // PUBLISH_OK に出現できるのは EXPIRES のみ。許可外パラメータを
      // 受信した場合は PROTOCOL_VIOLATION でセッションを閉じる。
      // Subscription Parameters の更新は REQUEST_UPDATE 経路で扱う。
      // スコープ違反でも保留中の発行を残さないよう、Track Properties 違反と
      // 同じ後始末 (削除・reject・close) を行う。
      let scopeError: SessionError | undefined;
      if (
        !validateParameterScope(
          decoded.parameters,
          PUBLISH_OK_ALLOWED_PARAMS,
          "PUBLISH_OK",
          (error) => {
            scopeError = error;
          },
        )
      ) {
        session.pendingPublish.delete(requestId);
        session.requestStreams.delete(requestId);
        // validateParameterScope は違反時に必ずコールバックを呼ぶため、
        // scopeError は通常必ず設定される。念のため未設定時は汎用文言で reject する。
        // Track Properties 違反と同じ順序 (削除・reject・close) にし、
        // 先に close すると close 側の汎用 reject で特定エラーが上書きされるのを防ぐ。
        const violation =
          scopeError ??
          new SessionError(
            "parameter not allowed in PUBLISH_OK",
            SessionErrorCode.PROTOCOL_VIOLATION,
          );
        pending.reject(violation);
        session.closeWithError(violation);
        return;
      }
      // draft-ietf-moq-transport-20 §10.5 (REQUEST_OK):
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

      // draft-ietf-moq-transport-20 §10.2.16:
      // PUBLISH_OK に出現できるのは EXPIRES のみであり、FORWARD 等の
      // Subscription Parameters は運ばれない。Publisher の Forward State は
      // PUBLISH 送信時の指定値のままにし、更新は REQUEST_UPDATE 経路で扱う。
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
      // draft-ietf-moq-transport-20 §10.10:
      // PUBLISH_STATE_NOTIFY を購読以外のリクエスト文脈 (PUBLISH / FETCH /
      // TRACK_STATUS の応答待ち) で受信した場合は PROTOCOL_VIOLATION で
      // セッションを閉じる。
      if (msg.type === MessageType.PUBLISH_STATE_NOTIFY) {
        const sessionError = new SessionError(
          "unexpected PUBLISH_STATE_NOTIFY for PUBLISH request",
          SessionErrorCode.PROTOCOL_VIOLATION,
        );
        session.pendingPublish.delete(requestId);
        session.requestStreams.delete(requestId);
        pending.reject(sessionError);
        session.closeWithError(sessionError);
      } else {
        session.pendingPublish.delete(requestId);
        session.requestStreams.delete(requestId);
        pending.reject(new Error(`unexpected response type ${msg.type} for PUBLISH request`));
      }
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
        // draft-ietf-moq-transport-20 §11.1: 同一 Track Alias が異なる Track に使われている場合のみ DUPLICATE_TRACK_ALIAS
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

      pending.resolve(pending.impl);

      void bidiReadRequestStreamMessages(session, requestId, stream, controlReader, "subscribe");
    } else if (msg.type === MessageType.REQUEST_ERROR) {
      const decoded = decodeRequestErrorPayload(msg.payload);
      session.pendingSubscribe.delete(requestId);
      session.requestStreams.delete(requestId);
      session.fillFetchTargets.delete(requestId);
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
      session.fillFetchTargets.delete(requestId);
      pending.impl.goawayCallback?.(decoded.newSessionUri);
      pending.reject(new Error("request stream goaway"));
    } else {
      // draft-ietf-moq-transport-20 §10.10:
      // PUBLISH_STATE_NOTIFY を購読以外のリクエスト文脈で受信した場合は
      // PROTOCOL_VIOLATION でセッションを閉じる。
      if (msg.type === MessageType.PUBLISH_STATE_NOTIFY) {
        const sessionError = new SessionError(
          "unexpected PUBLISH_STATE_NOTIFY for SUBSCRIBE request",
          SessionErrorCode.PROTOCOL_VIOLATION,
        );
        session.pendingSubscribe.delete(requestId);
        session.requestStreams.delete(requestId);
        session.fillFetchTargets.delete(requestId);
        pending.reject(sessionError);
        session.closeWithError(sessionError);
      } else {
        session.pendingSubscribe.delete(requestId);
        session.requestStreams.delete(requestId);
        session.fillFetchTargets.delete(requestId);
        pending.reject(new Error(`unexpected response type ${msg.type} for SUBSCRIBE request`));
      }
    }
  } catch (error) {
    // ProtocolViolationError / IncompleteDataError は仕様違反として PROTOCOL_VIOLATION でセッションを閉じる
    const sessionError = toProtocolViolationSessionError(error);
    if (sessionError) {
      // セッション閉鎖前に当該リクエストにも具体エラーを渡す
      // (Range Filter 違反・Track Properties 違反の既存経路と同パターン)
      session.pendingSubscribe.delete(requestId);
      session.requestStreams.delete(requestId);
      session.fillFetchTargets.delete(requestId);
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

      // draft-ietf-moq-transport-20 §10.2.8: GROUP_ORDER は FETCH_OK に許可されない。
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
      // draft-ietf-moq-transport-20 §10.10:
      // PUBLISH_STATE_NOTIFY を購読以外のリクエスト文脈で受信した場合は
      // PROTOCOL_VIOLATION でセッションを閉じる。
      if (msg.type === MessageType.PUBLISH_STATE_NOTIFY) {
        const sessionError = new SessionError(
          "unexpected PUBLISH_STATE_NOTIFY for FETCH request",
          SessionErrorCode.PROTOCOL_VIOLATION,
        );
        session.pendingFetch.delete(requestId);
        session.requestStreams.delete(requestId);
        pending.reject(sessionError);
        session.closeWithError(sessionError);
      } else {
        session.pendingFetch.delete(requestId);
        session.requestStreams.delete(requestId);
        pending.reject(new Error(`unexpected response type ${msg.type} for FETCH request`));
      }
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

      // draft-ietf-moq-transport-20 §10.2.1 (Parameter Scope)
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
      // draft-ietf-moq-transport-20 §10.10:
      // PUBLISH_STATE_NOTIFY を購読以外のリクエスト文脈で受信した場合は
      // PROTOCOL_VIOLATION でセッションを閉じる。
      if (msg.type === MessageType.PUBLISH_STATE_NOTIFY) {
        const sessionError = new SessionError(
          "unexpected PUBLISH_STATE_NOTIFY for TRACK_STATUS request",
          SessionErrorCode.PROTOCOL_VIOLATION,
        );
        session.pendingTrackStatus.delete(requestId);
        session.requestStreams.delete(requestId);
        pending.reject(sessionError);
        session.closeWithError(sessionError);
      } else {
        session.pendingTrackStatus.delete(requestId);
        session.requestStreams.delete(requestId);
        pending.reject(new Error(`unexpected response type ${msg.type} for TRACK_STATUS request`));
      }
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
 * draft-ietf-moq-transport-20 §10.9 (REQUEST_UPDATE):
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
  // REQUEST_ERROR (GOING_AWAY) で拒否する (draft-ietf-moq-transport-20
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
  // draft-ietf-moq-transport-20 §10.2.1 (Parameter Scope):
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
  // は REQUEST_ERROR (NOT_SUPPORTED) で応答する (draft-ietf-moq-transport-20
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

  // draft-ietf-moq-transport-20 §10.9 / §10.2.18:
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
  // draft-ietf-moq-transport-20 §10.9:
  // 「The receiver of a REQUEST_UPDATE MUST respond with exactly one REQUEST_OK
  //  or REQUEST_ERROR message indicating if the update was successful, ...」
  // (末尾の coalescing 例外は本関数のスコープ外)
  await bidiSendRequestOk(session, requestId);
}

// ============================================================================
// readRequestStreamMessages
// ============================================================================

/**
 * 購読の登録を解除する (ストリーム終了時の後始末)
 *
 * requestId 単位で subscribers から削除し、alias に他 subscription が
 * 無ければエントリ削除する。購読の終了に伴い fill 関連付けも不要になるため
 * 掃除する (FIN / RESET / セッション終了のいずれの exit 経路でも共通)。
 */
function deleteSubscriber(session: BidiSessionInternal, requestId: bigint): void {
  const subscriber = session.subscribers.get(requestId);
  if (subscriber) {
    session.subscribers.delete(requestId);
    deleteFillTargetsForSubscriber(session, subscriber);
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
}

/**
 * 自方向の送信ストリームを FIN で閉じる
 *
 * draft-ietf-moq-transport-20 §3.3.2:
 * ピアの FIN を受けた requester は自方向も FIN で閉じる (SHOULD)。
 * GOAWAY 受信後の旧ストリームの送信方向の終了にも使う。
 * 既に閉じている場合の reject は黙殺する。
 */
export async function closeRequestStreamWriter(
  session: BidiSessionInternal,
  requestId: bigint,
): Promise<void> {
  const streamInfo = session.requestStreams.get(requestId);
  if (streamInfo) {
    try {
      await streamInfo.writer.close();
    } catch {
      // ストリームが既に閉じている場合は無視
    }
  }
}

/**
 * GOAWAY 受信時の旧リクエストストリームの終了処理
 *
 * draft-ietf-moq-transport-20 §10.4:
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
  // 失敗が確定した更新の fill 関連付けを消す。確定済み (REQUEST_OK 受理) の
  // 更新の fill はまだ到着し得るため残す。pending 削除より先に実行する。
  deleteFillTargetsForPendingUpdates(session, requestId);
  rejectPendingRequestUpdates(
    session,
    requestId,
    new RequestError(REQUEST_GOING_AWAY_REASON, RequestErrorCode.GOING_AWAY),
  );
  if (subscriber) {
    await closeRequestStreamWriter(session, requestId);
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
        // draft-ietf-moq-transport-20 §3.3.2:
        // 受信側 (subscribe ロール) でピア (publisher) が PUBLISH_DONE を
        // 送らずに FIN した場合は失敗扱いであり、subscriber に通知する。
        // publish ロールでは requester の FIN は正常完了シグナルであり
        // 通知しない。
        if (role === "subscribe") {
          try {
            // draft-ietf-moq-transport-20 §10.9.1 / §3.3.2:
            // 応答を待たずにストリームが閉じた場合は保留中の更新の失敗であり、
            // アプリの update() の Promise を reject する (namespace ループの
            // handleNamespaceRequestUpdateStreamClosed と同じ)。未解決のまま
            // 残すと、アプリは FIN 後に update() の結果を待ち続ける。
            // 保留中の更新が無い場合は no-op。GOAWAY 受信済みの場合は GOAWAY
            // 掃除でエントリ削除済みのため no-op になる (エラー文言は errors の
            // REQUEST_UPDATE_STREAM_CLOSED_MESSAGE と同じ)。reject の
            // 形式はトリガーごとに異なる (GOAWAY 掃除は RequestError
            // (GOING_AWAY)、本処理は Error) が、失敗の種類が異なるため許容する。
            // notifySubscriberFailure より先に実行することで、アプリの error
            // コールバックが throw しても reject が実行される (順序の根拠)。
            rejectPendingRequestUpdates(
              session,
              requestId,
              new Error(REQUEST_UPDATE_STREAM_CLOSED_MESSAGE),
            );
            notifySubscriberFailure(
              session,
              requestId,
              new Error(FIN_WITHOUT_PUBLISH_DONE_MESSAGE),
            );
          } finally {
            // draft-ietf-moq-transport-20 §3.3.2:
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
            await closeRequestStreamWriter(session, requestId);
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
          case MessageType.PUBLISH_STATE_NOTIFY: {
            // draft-ietf-moq-transport-20 §10.10: 受信と違反処理はハンドラ内。
            if (!bidiHandlePublishStateNotify(session, msg.payload, requestId, role)) {
              return;
            }
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
            // draft-ietf-moq-transport-20 §10.9: coalescing により単一 REQUEST_ERROR で
            // 複数の REQUEST_UPDATE が失敗し得る。該当 pending をすべて reject する。
            // 失敗が確定した更新の fill 関連付けも消す (確定済みの fill は残す)。
            deleteFillTargetsForPendingUpdates(session, requestId);
            rejectPendingRequestUpdates(session, requestId, error);
            break;
          }
          case MessageType.REQUEST_UPDATE: {
            // draft-ietf-moq-transport-20 §10.4 / §3.3.4 / §10.9:
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
            // draft-ietf-moq-transport-20 §10.9:
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

            // draft-ietf-moq-transport-20 §10.9:
            // 「A subscriber can also send REQUEST_UPDATE to modify parameters of a
            //  subscription established with PUBLISH.」
            // クライアントが Publisher の場合、サーバー (Subscriber 役) が
            // PUBLISH bidi ストリーム上で REQUEST_UPDATE を送信してくる。
            //
            // draft-ietf-moq-transport-20 §10.9:
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
            // draft-ietf-moq-transport-20 §10.2.1 (Parameter Scope)
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
            // draft-ietf-moq-transport-20 §5.1.4 / §10.2.12-14:
            // 不正な Range Filter は REQUEST_ERROR (INVALID_FILTER) で応答する。
            // 検証は状態変更 (setForwardState) より前に配置し、違反で
            // REQUEST_ERROR を応答したにも関わらず forward state が反映される
            // 不整合を防ぐ。
            // LOCATION_FILTER / FILL_PARAMETERS 内側の値違反
            // (InvalidFilterError) も同一経路で REQUEST_ERROR にする。
            try {
              validateRangeFilterCombination(decoded.parameters);
              validateLocationAndFillParameters(decoded.parameters);
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

            // LOCATION_FILTER / FILL_PARAMETERS の違反のうち
            // ProtocolViolationError / IncompleteDataError 級のものは関数外側の catch の
            // toProtocolViolationSessionError で PROTOCOL_VIOLATION にして
            // セッションを閉じる。検証通過後に限り REQUEST_OK を応答する。

            // moqt-js は publisher として fill ストリームを開かないため、検証通過
            // 後の FILL_PARAMETERS は他の更新パラメータと同様に受けて REQUEST_OK を
            // 応答する (accept-then-ignore)。

            const publisher = session.publishers.get(requestId);
            if (publisher) {
              // draft-ietf-moq-transport-20 §10.2.18 (FORWARD Parameter):
              // "If the parameter is omitted from REQUEST_UPDATE, the value for
              //  the subscription remains unchanged."
              // FORWARD パラメータが存在する場合のみ反映する (省略時は不変。
              // bidiHandlePublishRequestUpdate と同パターン)。extractForwardState
              // は省略時にデフォルト true を返すため、無条件に反映すると
              // false で送信を止めたアプリの送信が「true 上書き」で再開されて
              // しまう。
              const forwardParam = decoded.parameters.find(
                (param) => param.type === MessageParameterType.FORWARD,
              );
              if (forwardParam !== undefined) {
                publisher.setForwardState(extractForwardState(decoded.parameters));
              }

              // REQUEST_OK を送信 (draft-ietf-moq-transport-20 §10.9 MUST)
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
              // draft-ietf-moq-transport-20 §10.9: 更新失敗時は REQUEST_ERROR
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
            // draft-ietf-moq-transport-20 §10.4:
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
            // draft-ietf-moq-transport-20 §10.4:
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
    } else if (
      role === "subscribe" &&
      isPeerStreamError(error) &&
      !session.goawayReceivedOnRequestStreams.has(requestId)
    ) {
      // draft-ietf-moq-transport-20 §3.3.3:
      // ピアの RESET_STREAM により readable がエラー終了した場合、subscriber の
      // error コールバックを呼び state を closed にする (アプリが終了を検知
      // できるようにする実用上の対応。FIN 経路の notifySubscriberFailure と同じ)。
      // セッションは閉じない (プロトコル違反ではない)。source: "stream" 以外
      // (セッション終了・内部エラー等) では通知しない。
      // GOAWAY 受信済みの旧ストリームは分岐条件で抑止し GOAWAY 掃除に委ねる
      // (GOAWAY は migration 通知であり失敗ではない)。
      // draft-ietf-moq-transport-20 §3.3.2 / §10.9.1:
      // RESET_STREAM は FIN よりも強い終了であり、応答未達の REQUEST_UPDATE は
      // FIN 経路と同様に失敗として reject する。応答 (REQUEST_OK / REQUEST_ERROR)
      // は届かないため、残すとアプリは update() の結果を待ち続ける。
      // 通知より先に実行することで、アプリの error コールバックが throw しても
      // reject が実行される (順序の根拠。FIN 経路と同パターン)。
      // FIN 経路は無条件 reject 後の no-op に委ねる形と抑止の段が異なるが、
      // 実運用では GOAWAY 掃除でエントリ削除済みのため振る舞いは同じ。
      rejectPendingRequestUpdates(
        session,
        requestId,
        new Error(REQUEST_UPDATE_STREAM_CLOSED_MESSAGE),
      );
      // 内側に try/catch が必要なのは、FIN 経路は外側の try 内で呼ばれ throw が
      // この catch に落ちて吸収されるのに対し、ここは catch ブロックの内側で
      // throw すると戻り値の Promise が reject し、fire-and-forget の void 呼び出し
      // で unhandled rejection になるためである。
      try {
        notifySubscriberFailure(session, requestId, createResetStreamError(error));
      } catch {
        // アプリの error コールバック例外は吸収する (markClosed は
        // notifySubscriberFailure 内の finally で実行済み)。
      }
    }
    // それ以外（セッション終了・内部エラー等）は既存通り無視する
  } finally {
    reader.releaseLock();
    deleteSubscriber(session, requestId);
    // draft-ietf-moq-transport-20 §3.3.2 の MUST「the publisher of an
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

/**
 * 受信パラメータ群に含まれる LOCATION_FILTER / FILL_PARAMETERS の値を検証する
 *
 * draft-ietf-moq-transport-20 §5.1.2 (Location Filters):
 * "If StartGroup + EndGroupDelta exceeds 2^64 - 1, the endpoint MUST
 *  close the session with a PROTOCOL_VIOLATION."
 * draft-ietf-moq-transport-20 §10.2.15 (FILL PARAMETERS Parameter):
 * 内側の一覧に無いパラメータを受信した endpoint は PROTOCOL_VIOLATION で
 * セッションを閉じる。
 * decode の失敗 (ProtocolViolationError / IncompleteDataError) は呼び出し元の
 * 受信ループの catch で PROTOCOL_VIOLATION に変換される。
 * publish ロールの REQUEST_UPDATE 経路で使う。PUBLISH_OK は EXPIRES のみを
 * 許可するため本検証は通さない (許可外はスコープ検証で拒否する)。
 */
function validateLocationAndFillParameters(parameters: Parameter[]): void {
  for (const param of parameters) {
    if (param.type === MessageParameterType.LOCATION_FILTER) {
      decodeLocationFilterParameter(param);
    } else if (param.type === MessageParameterType.FILL_PARAMETERS) {
      decodeFillParameters(param);
    }
  }
}

// ============================================================================
// sendRequestUpdate
// ============================================================================

/**
 * 送信時点のフィルタ状態に、in-flight の REQUEST_UPDATE (送信順) と今回の
 * update をマージした状態を返す
 *
 * draft-ietf-moq-transport-20 §10.9.1:
 * 「Parameter values from later REQUEST_UPDATE messages override values from
 *  earlier ones.」により、pendingRequestUpdate の挿入順 (送信順) で適用する。
 * in-flight の update は以後の REQUEST_ERROR で失敗し得る。成功する前提で
 * 含めるため、in-flight の追加 update は過剰検証 (安全側)、削除 update は
 * 過少検証 (実際は上限超過でも送信し得る) になる。結果を確定できない以上
 * 許容するが、失敗確定時はエントリが削除され、以後の検証は正しい状態に
 * 戻る。
 */
function computeMergedRangeFilters(
  session: BidiSessionInternal,
  subscriber: SubscriberImpl,
  update: RangeFilterSpec[],
): RangeFilterSpec[] {
  let merged = subscriber.getRangeFilters();
  for (const [, pending] of session.pendingRequestUpdate) {
    if (pending.targetRequestId !== subscriber.getRequestId()) {
      continue;
    }
    if (pending.rangeFilters === undefined) {
      continue;
    }
    merged = mergeRangeFilters(merged, pending.rangeFilters);
  }
  return mergeRangeFilters(merged, update);
}

/**
 * 対象購読の in-flight 中の fill 内側 Range Filters を集める
 *
 * draft-ietf-moq-transport-20 §10.3.1.6:
 * 購読単位の上限検証に fill 内側も含めるため、未応答の更新が運ぶ
 * fill 内側分を列挙する。
 */
function inFlightFillRangeFilters(
  session: BidiSessionInternal,
  targetRequestId: bigint,
): RangeFilterSpec[] {
  const collected: RangeFilterSpec[] = [];
  for (const [, pending] of session.pendingRequestUpdate) {
    if (pending.targetRequestId !== targetRequestId) {
      continue;
    }
    if (pending.fillRangeFilters !== undefined) {
      collected.push(...pending.fillRangeFilters);
    }
  }
  return collected;
}

export async function bidiSendRequestUpdate(
  session: BidiSessionInternal,
  subscriber: SubscriberImpl,
  options: RequestUpdateOptions,
): Promise<void> {
  const targetRequestId = subscriber.getRequestId();

  // draft-ietf-moq-transport-20 §10.4:
  // GOAWAY 受信後の旧リクエストへの REQUEST_UPDATE は送信しない。
  // ガードは「弾けるケースの早期失敗」であり、ガード通過後に GOAWAY が
  // 割り込んだ競合時の掃除 (write 失敗時のエントリ削除) は後段の
  // write 失敗 catch が担う。
  if (session.goawayReceivedOnRequestStreams.has(targetRequestId)) {
    throw new Error(`cannot send REQUEST_UPDATE: request stream is being migrated`);
  }

  // draft-ietf-moq-transport-20 §10.3.1.7:
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

  // draft-ietf-moq-transport-20 §10.3.1.6 (MAX FILTER RANGES):
  // 「limits the peer's total number of Ranges (Start/End pairs) allowed
  //  concurrently in all Range filter Section 5.1.4 parameters for a given
  //  subscription or fetch」であり、マージ後のフィルタ状態 (§5.1.4 の
  // 削除・置換・不変規則で適用した結果) に対して検証する。§5.1.4 にも
  // 「limits the total number of Ranges allowed in all Range Filter parameters
  //  for a given subscription or fetch」とある。
  // REQUEST_UPDATE は削除 (Length=0) を含むため、削除以外の Ranges 数のみ
  // チェックする (マージ結果には remove エントリが含まれない)。
  // fill 内側の Range Filters も購読単位の上限に含める。
  const newOuterRanges = options.rangeFilters ?? [];
  const newFillRanges = options.fill?.rangeFilters ?? [];
  if (newOuterRanges.length > 0 || newFillRanges.length > 0) {
    // ピアの MAX_FILTER_RANGES = 0 (未広告) の場合は §10.3.1.6 により送信禁止。
    // 削除のみの update (マージ後が空) でも送信してはならないため、
    // マージ後検証 (空配列は no-op) とは別に options 単体でガードする。
    // 空配列 (フィルタ指定なしの no-op) はここに到達しない。
    if (session.peerMaxFilterRanges === 0) {
      throw new Error(
        "cannot send range filters in REQUEST_UPDATE: peer MAX_FILTER_RANGES is 0 (not advertised)",
      );
    }
    const merged = computeMergedRangeFilters(session, subscriber, newOuterRanges);
    validateRangeFilterLimits(
      [...merged, ...inFlightFillRangeFilters(session, targetRequestId), ...newFillRanges],
      session.peerMaxFilterRanges,
      "REQUEST_UPDATE after merging current filters",
    );
  }

  // draft-ietf-moq-transport-20 §5.1.4:
  // REQUEST_UPDATE では削除 (Length=0) が許可されるが、TRACK_PROPERTY_FILTER (0x29) は
  // SUBSCRIBE_TRACKS リクエスト自身のストリーム上のみ許可される。moqt-js が送信する
  // REQUEST_UPDATE はすべて per-subscription の更新 (§10.9) のため、0x29 は一律 throw する。
  // 組み合わせ重複も送信前に検証する (§5.1.4 の MUST)
  validateRangeFilterSpecs(options.rangeFilters, "REQUEST_UPDATE", {
    allowRemove: true,
    allowTrackProperty: false,
  });

  // draft-ietf-moq-transport-20 §5.1.2:
  // raw パラメータ経路の LOCATION_FILTER も型付き経路と同じデコード検証
  // (End Group 超過を含む) の対象にする。対象はトップレベルの
  // LOCATION_FILTER 全件とする
  // (重複自体は別途仕様違反だが、2 件目以降の検証素通りを残さない)。
  // 保持するのは options.parameters 配列順の先頭 1 件のデコード値とする
  // (受信側の find による抽出と同形)。
  // デコード失敗はローカル API 誤用として InvalidFilterError に
  // 変換する (受信側の ProtocolViolationError とは区別する)。
  // FILL_PARAMETERS 内側は対象外とする。型付き fill 経路は構築時に検証済みで
  // あり、手組みの raw FILL_PARAMETERS 内側は別対応とする。
  // pendingRequestUpdate.set より前で失敗させる
  // (登録後の throw はエントリ残留を生むため)。
  const rawLocationFilters = (options.parameters ?? []).filter(
    (param) => param.type === MessageParameterType.LOCATION_FILTER,
  );
  let sendLocationFilter: LocationFilter | undefined;
  for (const rawLocationFilter of rawLocationFilters) {
    try {
      const decoded = decodeLocationFilterParameter(rawLocationFilter);
      sendLocationFilter ??= decoded;
    } catch (error) {
      throw new InvalidFilterError(
        `invalid raw LOCATION_FILTER in REQUEST_UPDATE: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const parameters: Parameter[] = options.parameters ? [...options.parameters] : [];

  // Range Filters (0x25–0x29) - draft-ietf-moq-transport-20 Section 5.1.4:
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

  // FILL_PARAMETERS (0x23) - draft-ietf-moq-transport-20 Section 10.2.15:
  // fill fetch ストリームを要求する。FILL_PARAMETERS は保持されないため、
  // 載せた更新にのみ適用される。
  if (options.fill !== undefined) {
    parameters.push(encodeFillParameters(buildFillParameters(options.fill, "REQUEST_UPDATE")));
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
      // draft-ietf-moq-transport-20 §10.2.18:
      // REQUEST_OK 受信時に Forward State へ反映するため、送信時の FORWARD
      // 値を保持する (省略時は undefined = 不変)。
      forward: options.forward,
      // draft-ietf-moq-transport-20 §5.1.4:
      // REQUEST_OK 受信時に Range Filters へ反映するため、送信時の値を保持する
      // (省略時は undefined = 不変)。
      rangeFilters: options.rangeFilters,
      // draft-ietf-moq-transport-20 §10.2.9:
      // REQUEST_OK 受信時に Location Filter へ反映するため、送信時の値を保持する
      // (省略時は undefined = 不変)。
      locationFilter: sendLocationFilter,
      // draft-ietf-moq-transport-20 §10.3.1.6:
      // 購読単位の上限検証に fill 内側も含めるため保持する。
      fillRangeFilters: options.fill?.rangeFilters,
    });
  });
  // write in-flight 中に GOAWAY / REQUEST_ERROR / セッション close が
  // rejectPendingRequestUpdates を実行すると、return 前のこの promise が
  // 無観測のまま reject され unhandled rejection になる。reject は
  // return promise の adoption 経由で呼び出し元へ伝播するため、
  // ここでの catch は無観測 reject の抑制のみを担う。
  promise.catch(() => {});

  // draft-ietf-moq-transport-20 §5.1.3 (Fill Semantics):
  // fill を要求した更新の Request ID を購読に関連付ける。REQUEST_OK 受理で
  // pending エントリが消えても、fill ストリーム到着まで保持する (応答と fill
  // ストリームの順序は保証されない)。write 失敗時は pending と同様に削除する。
  if (options.fill !== undefined) {
    session.fillFetchTargets.set(updateRequestId, {
      subscriber,
      groupOrder: resolveFillGroupOrder(options.fill.groupOrder, subscriber.getGroupOrder()),
    });
  }

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
    session.fillFetchTargets.delete(updateRequestId);
    throw err;
  }

  return promise;
}

/**
 * SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS の Track Namespace Prefix 更新
 * REQUEST_UPDATE を送信する
 *
 * draft-ietf-moq-transport-20 §10.9.2 (Updating Namespace Subscriptions):
 * "A subscriber can update the Track Namespace Prefix of an established
 *  SUBSCRIBE_NAMESPACE or SUBSCRIBE_TRACKS by including the
 *  TRACK_NAMESPACE_PREFIX parameter (Section 10.2.20) in a REQUEST_UPDATE."
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
 * @param options - 更新内容 (TRACK_NAMESPACE_PREFIX + Tracks のみ FORWARD)
 * @returns REQUEST_OK 受信で resolve、REQUEST_ERROR / ストリームクローズで reject する Promise
 */
export async function bidiSendNamespaceRequestUpdate(
  session: BidiSessionInternal,
  requestId: bigint,
  streamWriter: WritableStreamDefaultWriter<Uint8Array>,
  options: TracksUpdateOptions,
): Promise<void> {
  // draft-ietf-moq-transport-20 §10.4:
  // GOAWAY を受信したリクエストストリームはマイグレーション対象のため、
  // 旧リクエストへの REQUEST_UPDATE は送信しない。
  // §10.4 の SHOULD NOT 列挙は SUBSCRIBE / PUBLISH 等の新規リクエストのみだが、
  // GOAWAY 処理で送信方向が FIN (writer.close()) 済みの場合に write が失敗し
  // pendingRequestUpdate エントリがリークするため、防御的に REQUEST_UPDATE も
  // 送信しない (bidiSendRequestUpdate と同様のガード)。
  if (session.goawayReceivedOnRequestStreams.has(requestId)) {
    throw new Error(`cannot send REQUEST_UPDATE: request stream is being migrated`);
  }

  // draft-ietf-moq-transport-20 §10.3.1.7:
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

  // draft-ietf-moq-transport-20 §3.2.1 / §3.2.2: 予約 namespace / .session の送信拒否
  validateTrackNamespaceForSend(options.trackNamespacePrefix);

  // draft-ietf-moq-transport-20 §10.9.2:
  // overlap 制約は型ごとに独立して適用される。更新対象自身は比較対象から除外する
  // (prefix 拡大更新を許可するため)。
  // 受信側の MUST は PREFIX_OVERLAP 応答 (§10.2.20) であり、この検証は
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
  // draft-ietf-moq-transport-20 §10.9.2 の設計判断:
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
    // TRACK_NAMESPACE_PREFIX (0x34) - draft-ietf-moq-transport-20 Section 10.2.20
    encodeParameterTrackNamespace(createTrackNamespace(options.trackNamespacePrefix)),
  ];

  // FORWARD (0x10) - draft-ietf-moq-transport-20 Section 10.2.18:
  // SUBSCRIBE_TRACKS の REQUEST_UPDATE にのみ許可され、 prefix に一致する
  // 将来の購読の Forwarding State を指定する (既存購読には影響しない)。
  // SUBSCRIBE_NAMESPACE 向け REQUEST_UPDATE では許可されないため送らない。
  // 型上は TracksUpdateOptions のみが forward を持つが、実行時に
  // namespace 系へ混入しても黙って落とす (誤送信による仕様違反を防ぐ)。
  // 省略時は不変のため、指定時のみ 0/1 を明示送信する
  // (bidiSendRequestUpdate の forward !== undefined → 0/1 表現に揃える)。
  if (!isNamespaceSubscription && options.forward !== undefined) {
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
// cancelSubscription
// ============================================================================

export async function bidiCancelSubscription(
  session: BidiSessionInternal,
  subscriber: SubscriberImpl,
): Promise<void> {
  const requestId = subscriber.getRequestId();

  // draft-ietf-moq-transport-20 §10.9 / §10.9.1:
  // unsubscribe により応答 (REQUEST_OK / REQUEST_ERROR) が届かなくなるため、
  // 保留中の REQUEST_UPDATE は失敗として reject してエントリを削除する。
  // 残すとアプリは update() の結果を待ち続ける。ストリーム破棄より前に置き、
  // subscribers / requestStreams の Map 削除より先に実行する (後続の cancel /
  // abort の成否に関わらず reject を保証する。FIN / RESET 経路と同パターン)。
  rejectPendingRequestUpdates(session, requestId, new Error(REQUEST_UPDATE_STREAM_CLOSED_MESSAGE));

  // 購読の終了に伴い fill 関連付けも不要になるため掃除する
  // (draft-ietf-moq-transport-20 §5.1.3.1: 購読キャンセル時は fill も終わる)。
  deleteFillTargetsForSubscriber(session, subscriber);

  const streamInfo = session.requestStreams.get(requestId);
  if (streamInfo) {
    try {
      // draft-ietf-moq-transport-20 §5.1:
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

  // FETCH を対象とする REQUEST_UPDATE 送信経路は本実装に存在しない
  // (bidiSendRequestUpdate は SubscriberImpl のみ受け付ける) ため、当該
  // requestId を対象とする保留中の更新は登録され得ず、ここでの掃除は不要
  // (bidiCancelSubscription との意図的な非対称)。

  const streamInfo = session.requestStreams.get(requestId);
  if (streamInfo) {
    try {
      // draft-ietf-moq-transport-20 §5.2:
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
      // draft-ietf-moq-transport-20 §14 (Grease):
      // 未知の PUBLISH_DONE コードは INTERNAL_ERROR として扱う
      const normalizedCode = normalizePublishDoneCode(Number(msg.statusCode));
      subscriber.handleEnd(BigInt(normalizedCode), msg.reasonPhrase);
      // subscriber/subscribersByAlias の削除はストリーム close 時
      // (bidiReadRequestStreamMessages の finally) に委譲する
      // draft-ietf-moq-transport-20 §5.1
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
// handlePublishStateNotify
// ============================================================================

/**
 * 受信 PUBLISH_STATE_NOTIFY を処理する
 *
 * draft-ietf-moq-transport-20 §10.10 (PUBLISH_STATE_NOTIFY):
 * publisher が subscription の bidi ストリーム上で送る片方向の状態通知。
 * 応答は送信しない。presence のパラメータのみ変更として subscriber 状態に
 * 反映する (省略時は不変)。
 *
 * subscribe ロール (自 subscriber の購読) のみ受理する。publish ロール
 * (対向 subscriber 発) では §10.10 の MUST に従い PROTOCOL_VIOLATION で
 * セッションを閉じる。
 *
 * 許可外パラメータは §10.2.1 の MUST に従い PROTOCOL_VIOLATION で
 * セッションを閉じる。decode の失敗は呼び出し元の受信ループの catch で
 * 変換される。
 */
export function bidiHandlePublishStateNotify(
  session: BidiSessionInternal,
  payload: Uint8Array,
  requestId: bigint,
  role: "publish" | "subscribe",
): boolean {
  // draft-ietf-moq-transport-20 §10.10:
  // "PUBLISH_STATE_NOTIFY applies only to subscriptions, and is sent only
  //  by the publisher."
  if (role !== "subscribe") {
    session.closeWithError(
      new SessionError(
        "unexpected PUBLISH_STATE_NOTIFY on publish stream",
        SessionErrorCode.PROTOCOL_VIOLATION,
      ),
    );
    return false;
  }

  const msg = decodePublishStateNotifyPayload(payload);

  // draft-ietf-moq-transport-20 §10.2.1 (Parameter Scope)
  // 違反時はセッションを閉じ、呼び出し元は後続メッセージの処理を打ち切る。
  if (
    !validateParameterScope(
      msg.parameters,
      PUBLISH_STATE_NOTIFY_ALLOWED_PARAMS,
      "PUBLISH_STATE_NOTIFY",
      (error) => session.closeWithError(error),
    )
  ) {
    return false;
  }

  const subscriber = session.subscribers.get(requestId);

  // 反映前にすべての値をデコード・検証する。違反確定後の部分反映を防ぐため、
  // subscriber への書き込みは検証通過後にまとめて行う。購読不在でも検証は
  // 行い、不正ワイヤを見逃さない。
  const largestParam = msg.parameters.find(
    (param) => param.type === MessageParameterType.LARGEST_OBJECT,
  );
  const largestLocation =
    largestParam !== undefined ? getParameterLocationValue(largestParam) : undefined;
  const locationParam = msg.parameters.find(
    (param) => param.type === MessageParameterType.LOCATION_FILTER,
  );
  // §5.1.2 の値検証 (End Group 超過は PROTOCOL_VIOLATION) も兼ねる。
  // 失敗は呼び出し元の catch でセッションを閉じる。
  const locationFilter =
    locationParam !== undefined ? decodeLocationFilterParameter(locationParam) : undefined;
  const forwardParam = msg.parameters.find((param) => param.type === MessageParameterType.FORWARD);
  // draft-ietf-moq-transport-20 §10.2.18:
  // PUBLISH_STATE_NOTIFY では報告値をそのまま反映する (省略時は不変)。
  // extractForwardState は省略時にデフォルト true を返すため、存在時のみ呼ぶ。
  // 値域検証は内部で行い、範囲外は ProtocolViolationError になる。
  const forwardState = forwardParam !== undefined ? extractForwardState(msg.parameters) : undefined;

  if (!subscriber) {
    return true;
  }

  if (largestLocation !== undefined) {
    subscriber.setLargestLocation(largestLocation);
  }
  if (locationFilter !== undefined) {
    subscriber.setLocationFilter(locationFilter);
  }
  if (forwardState !== undefined) {
    subscriber.setForwardState(forwardState);
  }
  return true;
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
 * ストリームリセットのエラーコード値からコード名を求める
 *
 * draft-ietf-moq-transport-20 §3.3.4 の名前付き列挙をメッセージ組み立てに使う。
 * 正規化済みの値を前提とするため、一致なしは起きないはずだが、
 * 念のため内部エラー名に倒す。
 */
function getDataStreamErrorCodeName(code: DataStreamErrorCode): string {
  for (const [name, value] of Object.entries(DataStreamErrorCode)) {
    if (value === code) {
      return name;
    }
  }
  return "INTERNAL_ERROR";
}

/**
 * ピアの RESET_STREAM 由来のエラーを通知用の Error に変換する
 *
 * draft-ietf-moq-transport-20 §3.3.4:
 * "The application SHOULD use a relevant error code when resetting or
 *  sending STOP_SENDING on any stream."
 * ピアが用いたエラーコードは読み取り失敗値の streamErrorCode
 * (W3C WebTransport の WebTransportError が source === "stream" のときのみ
 * 非 null で持つ) から取得できる。取得できた場合は正規化した値を
 * streamErrorCode プロパティに載せ、メッセージにもコード名を付加して
 * アプリが終了理由を区別できるようにする。未知値は draft-ietf-moq-transport-20
 * §14 に従い内部エラーに正規化する。
 * 取得できない場合 (未提供や型不一致) は従来の固定文言のみで通知し、
 * プロパティも付けない。 FIN 由来のエラーはコードを持たない別イベントの
 * ため本関数の対象外とする。
 */
export function createResetStreamError(rawError: unknown): Error {
  if (typeof rawError !== "object" || rawError === null) {
    return new Error(RESET_REQUEST_STREAM_MESSAGE);
  }
  const streamErrorCode = (rawError as { streamErrorCode?: unknown }).streamErrorCode;
  if (typeof streamErrorCode !== "number") {
    return new Error(RESET_REQUEST_STREAM_MESSAGE);
  }
  const normalized = normalizeDataStreamErrorCode(streamErrorCode);
  const name = getDataStreamErrorCodeName(normalized);
  const error = new Error(`${RESET_REQUEST_STREAM_MESSAGE}: ${name}(0x${normalized.toString(16)})`);
  (error as Error & { streamErrorCode: DataStreamErrorCode }).streamErrorCode = normalized;
  return error;
}

/**
 * ピアによる FIN (PUBLISH_DONE なし) または RESET_STREAM によるストリーム
 * エラー終了を subscriber へ通知する
 *
 * draft-ietf-moq-transport-20 §3.3.2 (Graceful Request Stream Closure):
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
 *   であり失敗ではない。draft-ietf-moq-transport-20 §10.4「The GOAWAY
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

  // draft-ietf-moq-transport-20 §10.2.1 (Parameter Scope):
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

  // draft-ietf-moq-transport-20 §10.5 (REQUEST_OK):
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

  // draft-ietf-moq-transport-20 §10.2.18:
  // "If the parameter is omitted from REQUEST_UPDATE, the value for the
  //  subscription remains unchanged."
  // (§10.2.9 / §5.1.4 も同趣旨の規定を持つ。文言は各反映箇所のコメントを参照。)
  // 自 update() の REQUEST_OK 受信時に、送信時の FORWARD / LOCATION_FILTER /
  // Range Filters 値 (pendingRequestUpdate エントリに保持) を反映する。
  // 省略時 (undefined) は反映しない。
  const resolved = resolvePendingRequestUpdate(session, streamRequestId);
  if (resolved !== undefined) {
    const subscriber = session.subscribers.get(streamRequestId);
    if (subscriber) {
      // draft-ietf-moq-transport-20 §10.2.9:
      // 自 update() の REQUEST_OK 受信時に、送信時の LOCATION_FILTER 値を反映する
      // (省略時は不変)。LARGEST_OBJECT 反映の後に行い、相対指定フィルタが
      // Largest 依存で解決されるようにする。
      if (resolved.locationFilter !== undefined) {
        subscriber.setLocationFilter(resolved.locationFilter);
      }
      if (resolved.forward !== undefined) {
        subscriber.setForwardState(resolved.forward);
      }
      // draft-ietf-moq-transport-20 §5.1.4:
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
 * draft-ietf-moq-transport-20 §10.9.1:
 * "The receiver MUST still send a REQUEST_OK for each successful update"
 * REQUEST_OK は各更新につき 1 通送られるため、1 件のみ解決する。
 *
 * @returns 解決した更新の FORWARD / Range Filters / LOCATION_FILTER 送信値 (省略時は undefined = 反映しない)
 */
export function resolvePendingRequestUpdate(
  session: BidiSessionInternal,
  targetRequestId: bigint,
):
  | { forward?: boolean; rangeFilters?: RangeFilterSpec[]; locationFilter?: LocationFilter }
  | undefined {
  for (const [updateId, pending] of session.pendingRequestUpdate) {
    if (pending.targetRequestId === targetRequestId) {
      session.pendingRequestUpdate.delete(updateId);
      pending.resolve();
      return {
        forward: pending.forward,
        rangeFilters: pending.rangeFilters,
        locationFilter: pending.locationFilter,
      };
    }
  }
  return undefined;
}

/**
 * 指定の targetRequestId を対象とする保留中の REQUEST_UPDATE をすべて reject する
 *
 * draft-ietf-moq-transport-20 §10.9.1:
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

// ============================================================================
// fill 関連付けヘルパー
// ============================================================================

/**
 * 購読の fill 関連付けをすべて削除する
 *
 * draft-ietf-moq-transport-20 §5.1.3.1:
 * 購読自体が終わる (unsubscribe / FIN / RESET / セッション終了) と fill fetch
 * ストリームも終わるため、関連付けは不要になる。購読が生きている間の
 * REQUEST_ERROR / GOAWAY では、まだ応答待ちの更新分のみを
 * deleteFillTargetsForPendingUpdates で消し、確定済みの fill は残す。
 */
export function deleteFillTargetsForSubscriber(
  session: BidiSessionInternal,
  subscriber: SubscriberImpl,
): void {
  for (const [requestId, target] of session.fillFetchTargets) {
    if (target.subscriber === subscriber) {
      session.fillFetchTargets.delete(requestId);
    }
  }
}

/**
 * まだ応答待ちの更新に紐づく fill 関連付けを削除する
 *
 * REQUEST_ERROR / GOAWAY で失敗が確定した更新の fill は開かれないため、
 * 関連付けを消す。REQUEST_OK 受理済み (pending なし) の更新の fill は
 * まだ到着し得るため残す (応答と fill ストリームの順序は保証されない)。
 */
export function deleteFillTargetsForPendingUpdates(
  session: BidiSessionInternal,
  targetRequestId: bigint,
): void {
  for (const [updateId, pending] of session.pendingRequestUpdate) {
    if (pending.targetRequestId === targetRequestId) {
      session.fillFetchTargets.delete(updateId);
    }
  }
}
