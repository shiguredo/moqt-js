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
  MalformedTrackError,
  ProtocolViolationError,
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
  PublishDoneStatusCode,
  createTrackNamespace,
  encodeAuthorizationToken,
  encodeParameterTrackNamespace,
  encodeRequestUpdatePayload,
  encodeRequestErrorPayload,
  encodeRequestOkPayload,
  encodeLocation,
  encodeUint8ParameterValue,
  decodeFetchOkPayload,
  decodeFillParameters,
  decodeGoawayPayload,
  decodeLocationFilterParameter,
  decodeRangeFilter,
  rangeFilterTypeOf,
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
import { objectMatchesFilter, resolveFilter, type ResolvedFilter } from "../filter";
import { PendingSubgroupBuffer } from "../pendingSubgroupBuffer";
import { PublisherImpl, type Publisher } from "../publisher";
import type { Property } from "../properties";
import {
  NAMESPACE_REQUEST_UPDATE_ALLOWED_PARAMS,
  PUBLISH_OK_ALLOWED_PARAMS,
  PUBLISH_STATE_NOTIFY_ALLOWED_PARAMS,
  SUBSCRIBE_OK_ALLOWED_PARAMS,
  FETCH_OK_ALLOWED_PARAMS,
  REQUEST_UPDATE_OK_ALLOWED_PARAMS,
  REQUEST_UPDATE_ALLOWED_PARAMS,
  TRACK_STATUS_OK_ALLOWED_PARAMS,
  assertParametersAllowedForSend,
  validateParameterScope,
} from "../message/parameterScope";
import { SubscriberImpl, type Subscriber, type RequestUpdateOptions } from "../subscriber";
import type { TracksUpdateOptions, SessionState, TrackStatusResult } from "../session";
import {
  compareLocations,
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
  validateNonNegative,
  validateTrackNamespaceForSend,
} from "./params";
import {
  REQUEST_UPDATE_STREAM_CLOSED_MESSAGE,
  isPeerStreamError,
  toSessionCloseError,
  toTrackPropertiesViolationSessionError,
} from "./errors";
import { MAX_VARINT, encodeVarint } from "../varint";
import { publishResetPublisherStream, publishSendPublishDoneWithoutPublisher } from "./publish";
import type {
  NamespaceSubscriptionState,
  PublisherStreamState,
  TracksSubscriptionState,
} from "./types";

// ============================================================================
// 内部インターフェース
// ============================================================================

interface RequestStreamInfo {
  stream: WebTransportBidirectionalStream;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  controlReader: ControlStreamReader;
  /**
   * 読み取りループが保持中の reader。
   *
   * unsubscribe 時にロック保持者経由で cancel (STOP_SENDING 相当) するため、
   * ループ開始時に登録し、ロック解放時にクリアする。ロック中の
   * stream.cancel() は TypeError で reject するため、stream 経由では
   * 解除できない。未登録 (ループ未開始・終了済み) の場合は undefined。
   */
  reader?: ReadableStreamDefaultReader<Uint8Array>;
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
   * draft-ietf-moq-transport-21 §9.20.19:
   * "If the parameter is omitted from REQUEST_UPDATE, the value for the
   *  subscription remains unchanged."
   * 省略時 (undefined) は REQUEST_OK 受信時に Forward State を更新しない。
   */
  forward?: boolean;
  /**
   * REQUEST_UPDATE 送信時に指定された Range Filters。
   * draft-ietf-moq-transport-21 §3.3.2:
   * "If a filter parameter is omitted from REQUEST_UPDATE, the value is
   *  unchanged."
   * 省略時 (undefined) は REQUEST_OK 受信時に Range Filters を更新しない。
   */
  rangeFilters?: RangeFilterSpec[];
  /**
   * REQUEST_UPDATE 送信時に fill 内側で指定された Range Filters。
   * draft-ietf-moq-transport-21 §9.1.6:
   * 購読単位の上限検証に含めるため保持する (fill 自体は保持されないが、
   * in-flight 中の上限超過を見逃さない)。
   */
  fillRangeFilters?: RangeFilterSpec[];
  /**
   * REQUEST_UPDATE 送信時に指定された LOCATION_FILTER 値。
   * draft-ietf-moq-transport-21 §9.20.10:
   * "If omitted from REQUEST_UPDATE or PUBLISH_STATE_NOTIFY,
   *  the value is unchanged."
   * 省略時 (undefined) は REQUEST_OK 受信時に Location Filter を更新しない。
   */
  locationFilter?: LocationFilter;
}

/**
 * fill fetch ストリームと購読の関連付け
 *
 * draft-ietf-moq-transport-21 §3.4 (Fill Semantics):
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
   * draft-ietf-moq-transport-21 §3.4:
   * fill fetch ストリームの FETCH_HEADER が運ぶ Request ID で引く。
   * REQUEST_OK 受理で pending が消えても、fill ストリーム到着まで保持する
   * (応答と fill ストリームの順序は保証されない)。
   */
  readonly fillFetchTargets: Map<bigint, FillFetchTarget>;

  // draft-ietf-moq-transport-21 §9.1.7: ピアの MAX_REQUEST_UPDATES（0 = 無制限）
  readonly peerMaxRequestUpdates: number;

  // draft-ietf-moq-transport-21 §9.1.6: ピアの MAX_FILTER_RANGES（0 = Range Filter 送信禁止）
  readonly peerMaxFilterRanges: number;

  // draft-ietf-moq-transport-21 §9.1.6: 自 endpoint が SETUP で広告した
  // MAX_FILTER_RANGES（未広告時は 0 = Range Filter 受信拒否）
  readonly localMaxFilterRanges: number;

  statsControlMessagesSent: number;

  readonly namespaceSubscriptions: Map<bigint, NamespaceSubscriptionState>;
  readonly tracksSubscriptions: Map<bigint, TracksSubscriptionState>;

  /**
   * publisher が開いたデータストリーム群と送信キュー・終了済み Subgroup 集合
   *
   * REQUEST_UPDATE 失敗時に PUBLISH_DONE 送信前にデータストリームを閉じる
   * (`publishClosePublisherStream` 用) ため bidi 層でも参照する。
   */
  readonly publisherStreams: Map<bigint, PublisherStreamState>;
  readonly publisherSendQueues: Map<bigint, Promise<void>>;
  readonly closedSubgroups: Set<string>;

  emitDebug(
    direction: "send" | "recv",
    type: number,
    payload: Uint8Array,
    decoded?: Record<string, unknown>,
  ): void;
  closeWithError(error: SessionError): void;
  /**
   * 確立済みの購読・fetch が 1 つ終了したことを通知する
   *
   * draft-ietf-moq-transport-21 §6.6.1:
   * GOAWAY 受信後は Established 購読が無くなった時点で NO_ERROR で閉じる。
   * 購読・fetch の終了経路から呼び、SessionImpl 側で閉じるか判断する。
   * テスト用の部分 session では未定義のため optional とする。
   */
  onRequestDrained?: () => void;
  /**
   * 受信 Request ID のパリティ・重複検証を行う
   *
   * draft-ietf-moq-transport-21 §6.4.2.1 (Request ID):
   * 違反時は INVALID_REQUEST_ID でセッションを閉じる。
   *
   * @param requestId 検証対象の受信 Request ID
   * @returns 検証に合格した場合は true、違反でセッションを閉じた場合は false
   */
  validateIncomingRequestId(requestId: bigint): boolean;
}

// ============================================================================
// GOAWAY バリデーション
// ============================================================================

/**
 * リクエストストリーム上の重複 GOAWAY を検出する
 *
 * draft-ietf-moq-transport-21 Section 9.2 (GOAWAY):
 * "The endpoint MUST close the session with a PROTOCOL_VIOLATION (Section 12.2)
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
 * draft-ietf-moq-transport-21 §9.3 (REQUEST_OK):
 * "Track Properties are populated in TRACK_STATUS_OK; they are empty in
 *  PUBLISH_OK, REQUEST_UPDATE_OK, SUBSCRIBE_NAMESPACE_OK and PUBLISH_NAMESPACE_OK.
 *  If an endpoint receives Track Properties in one of these messages it MUST
 *  close the session with a PROTOCOL_VIOLATION."
 *
 * @param trackProperties - 検証する Track Properties 配列
 * @param contextName - コンテキスト名（エラーメッセージ用）
 * @returns バリデーション通過時は null、違反時は PROTOCOL_VIOLATION の SessionError。
 *   呼び出し元は null でない場合、対象 pending の reject と closeWithError を行うこと
 */
export function validateRequestOkNoTrackProperties(
  trackProperties: Property[],
  contextName: string,
): SessionError | null {
  if (trackProperties.length > 0) {
    return new SessionError(
      `track properties must be empty in ${contextName}`,
      SessionErrorCode.PROTOCOL_VIOLATION,
    );
  }
  return null;
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
  try {
    await writer.write(message);
  } catch (error) {
    // 送信失敗時は作成済みストリームを RESET で閉じてから throw する。
    // requestStreams への登録は成功経路でのみ行うため、Map 側の掃除は不要。
    // bidiCancelSubscription / bidiCancelFetch と同形: readable.cancel() が
    // STOP_SENDING 相当、writer.abort() が RESET 相当。FIN である
    // writer.close() は使わない。
    try {
      await stream.readable.cancel("request send failed");
      await writer.abort("request send failed");
    } catch {
      // 閉じかけのストリーム操作の失敗は無視する
    } finally {
      writer.releaseLock();
    }
    throw error;
  }

  const streamInfo: RequestStreamInfo = { stream, writer, controlReader };
  session.requestStreams.set(requestId, streamInfo);

  return streamInfo;
}

// ============================================================================
// readResponseFromBidiStream
// ============================================================================

/**
 * リクエストストリームの最初の応答チャンクを読み取る
 *
 * 同一チャンクに複数の制御メッセージが連結されている場合は、それらを
 * すべて返す。確立前 GOAWAY の直後に 2 通目 GOAWAY が連結されていても
 * 検出できるようにするため (§9.2 MUST)。
 */
async function bidiReadResponseFromBidiStream(
  session: BidiSessionInternal,
  requestId: bigint,
  stream: WebTransportBidirectionalStream,
  controlReader: ControlStreamReader,
): Promise<ControlMessage[]> {
  const reader = stream.readable.getReader();
  // 応答待ちの reader を登録し、cancel 時にロック保持者経由で
  // reader.cancel (STOP_SENDING 相当) できるようにする。
  const streamInfo = session.requestStreams.get(requestId);
  if (streamInfo !== undefined) {
    streamInfo.reader = reader;
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        throw new Error("bidi stream closed before receiving response");
      }
      const messages = controlReader.feed(value);
      if (messages.length > 0) {
        return messages;
      }
    }
  } finally {
    if (streamInfo !== undefined) {
      streamInfo.reader = undefined;
    }
    reader.releaseLock();
  }
}

/**
 * 確立前に GOAWAY を受けたリクエストストリームの読み取りを継続する
 *
 * draft-ietf-moq-transport-21 §9.2 (GOAWAY):
 * "The endpoint MUST close the session with a PROTOCOL_VIOLATION if it receives
 *  more than one GOAWAY on the control stream or on a single request stream."
 * 確立前 (最初の応答が GOAWAY) にマイグレーションした後も読み取りを継続し、
 * 同一ストリーム上の 2 通目 GOAWAY を検出して PROTOCOL_VIOLATION で閉じる。
 * それ以外のメッセージは無視する (リクエストは既に reject 済み)。
 *
 * @param initialMessages - 最初の応答チャンクで既に読み取り済みの残りメッセージ。
 *   同一チャンク内の 2 通目 GOAWAY を検出するために先頭から走査する。
 */
export async function bidiContinueReadingForDuplicateGoaway(
  session: BidiSessionInternal,
  requestId: bigint,
  stream: WebTransportBidirectionalStream,
  controlReader: ControlStreamReader,
  initialMessages: ControlMessage[] = [],
): Promise<void> {
  const hasDuplicateGoaway = (messages: ControlMessage[]): boolean => {
    for (const message of messages) {
      if (message.type !== MessageType.GOAWAY) {
        continue;
      }
      // 1 通目は呼び出し元が既に処理済みで seenSet に登録されている。
      // 2 通目は validateNoDuplicateGoawayOnRequestStream が
      // PROTOCOL_VIOLATION でセッションを閉じ false を返す。
      if (
        !validateNoDuplicateGoawayOnRequestStream(
          requestId,
          session.goawayReceivedOnRequestStreams,
          (error) => session.closeWithError(error),
        )
      ) {
        return true;
      }
    }
    return false;
  };

  if (hasDuplicateGoaway(initialMessages)) {
    return;
  }

  const reader = stream.readable.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (hasDuplicateGoaway(controlReader.feed(value))) {
        return;
      }
    }
  } catch {
    // セッション終了 / RESET_STREAM は重複検出の対象外として読み取りを終える
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 既に解放済みの場合は無視
    }
  }
}

// ============================================================================
// 応答読み取りの共通リーダ
// ============================================================================

/**
 * 応答読み取りの経路コンテキスト
 */
interface BidiResponseContext<TPending> {
  session: BidiSessionInternal;
  requestId: bigint;
  stream: WebTransportBidirectionalStream;
  controlReader: ControlStreamReader;
  pending: TPending;
  /** 最初の応答チャンクで読み取り済みの残りメッセージ (2 通目 GOAWAY の検出用) */
  remainingMessages: ControlMessage[];
}

/**
 * 応答読み取りの経路ハンドラ
 *
 * 共通リーダが担う骨格 (pending の取得・読み取り・メッセージ分岐・
 * 受信失敗のエラー種別ごとの委譲) に対し、経路固有の処理を注入する。
 * 削除集合は経路ごとに異なるため各ハンドラが維持し、reject と close の
 * 順序・同一 SessionError オブジェクト性は全経路共通の不変条件として守る。
 */
interface BidiResponseHandlers<TPending> {
  getPending: (session: BidiSessionInternal, requestId: bigint) => TPending | undefined;
  okType: MessageType;
  handleOk: (context: BidiResponseContext<TPending>, payload: Uint8Array) => void | Promise<void>;
  handleRequestError: (
    context: BidiResponseContext<TPending>,
    payload: Uint8Array,
  ) => void | Promise<void>;
  handleGoaway: (
    context: BidiResponseContext<TPending>,
    payload: Uint8Array,
  ) => void | Promise<void>;
  handleUnexpected: (context: BidiResponseContext<TPending>, type: number) => void | Promise<void>;
  handleCloseError: (
    context: BidiResponseContext<TPending>,
    error: SessionError,
  ) => void | Promise<void>;
  /**
   * MalformedTrackError の処理
   * 未指定の経路は handleError にフォールバックする
   */
  handleMalformedTrack?: (
    context: BidiResponseContext<TPending>,
    error: MalformedTrackError,
  ) => void | Promise<void>;
  handleError: (context: BidiResponseContext<TPending>, error: unknown) => void | Promise<void>;
}

/**
 * 4 種の応答読み取りの共通リーダ
 *
 * 応答読み取り (PUBLISH / SUBSCRIBE / FETCH / TRACK_STATUS) について、
 * pending の取得・レスポンスの読み取り・メッセージ型の分岐・
 * 受信失敗のエラー種別ごとの委譲を担い、経路固有の処理をハンドラへ委譲する。
 * メッセージ型ごとの経路固有の扱い (削除集合・reject と close の順序・
 * §3.6 / §12.1 の cancel) はハンドラ側に残す。
 */
async function bidiReadResponse<TPending>(
  session: BidiSessionInternal,
  requestId: bigint,
  stream: WebTransportBidirectionalStream,
  controlReader: ControlStreamReader,
  handlers: BidiResponseHandlers<TPending>,
): Promise<void> {
  const pending = handlers.getPending(session, requestId);
  if (pending === undefined) {
    // pending 登録から送信完了までの間に malformed track の cross-cancel を
    // 受けた場合、pending は削除済みだが requestStreams には登録されている。
    // 登録済みストリームを放置すると STOP_SENDING / RESET_STREAM が届かず
    // エントリも残留するため、ここで後始末する。
    const streamInfo = session.requestStreams.get(requestId);
    if (streamInfo !== undefined) {
      try {
        await streamInfo.stream.readable.cancel("request cancelled");
        // abort は送信方向のリセット (RESET_STREAM 相当)。GOAWAY 受信で
        // writer を閉じ済みの場合に reject するため catch で握り潰す。
        void streamInfo.writer.abort("request cancelled").catch(() => {});
      } catch {
        // ストリームが既に閉じている場合は無視
      }
      session.requestStreams.delete(requestId);
    }
    return;
  }

  const context: BidiResponseContext<TPending> = {
    session,
    requestId,
    stream,
    controlReader,
    pending,
    remainingMessages: [],
  };

  try {
    const messages = await bidiReadResponseFromBidiStream(
      session,
      requestId,
      stream,
      controlReader,
    );
    const msg = messages[0];
    session.emitDebug("recv", msg.type, msg.payload);
    context.remainingMessages = messages.slice(1);

    // cancel 済みの pending に遅延した応答が届いた場合は確立しない。
    // cancelMalformedTrackPeers が pending を削除した後でも、捕捉済みの
    // pending を保持した読み取りループはここに到達する。
    if (handlers.getPending(session, requestId) !== pending) {
      // 読み取り後はロックが解放されているため、stream 経由で
      // STOP_SENDING 相当の cancel を送る
      try {
        await stream.readable.cancel("response cancelled");
      } catch {
        // ストリームが既に閉じている場合は無視
      }
      session.requestStreams.delete(requestId);
      return;
    }

    if (msg.type === handlers.okType) {
      await handlers.handleOk(context, msg.payload);
    } else if (msg.type === MessageType.REQUEST_ERROR) {
      await handlers.handleRequestError(context, msg.payload);
    } else if (msg.type === MessageType.GOAWAY) {
      await handlers.handleGoaway(context, msg.payload);
    } else {
      await handlers.handleUnexpected(context, msg.type);
    }
  } catch (error) {
    // SessionError はそのコードのまま、ProtocolViolationError / IncompleteDataError は PROTOCOL_VIOLATION で閉じる
    const sessionError = toSessionCloseError(error);
    if (sessionError !== null) {
      // セッション閉鎖前に当該リクエストにも具体エラーを渡す
      // (Range Filter 違反・Track Properties 違反の既存経路と同パターン)
      await handlers.handleCloseError(context, sessionError);
      return;
    }
    if (error instanceof MalformedTrackError && handlers.handleMalformedTrack !== undefined) {
      await handlers.handleMalformedTrack(context, error);
      return;
    }
    await handlers.handleError(context, error);
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
  await bidiReadResponse(session, requestId, stream, controlReader, {
    getPending: (session, requestId) => session.pendingPublish.get(requestId),
    okType: MessageType.REQUEST_OK,
    handleOk: (context, payload) => {
      const { session, requestId, pending } = context;
      const decoded = decodeRequestOkPayload(payload);
      // draft-ietf-moq-transport-21 §9.20.1 (Parameter Scope) / §9.20.17:
      // PUBLISH_OK に出現できるのは EXPIRES のみ。許可外パラメータを
      // 受信した場合は PROTOCOL_VIOLATION でセッションを閉じる。
      // Subscription Parameters の更新は REQUEST_UPDATE 経路で扱う。
      const scopeError = validateParameterScope(
        decoded.parameters,
        PUBLISH_OK_ALLOWED_PARAMS,
        "PUBLISH_OK",
      );
      if (scopeError !== null) {
        session.pendingPublish.delete(requestId);
        session.requestStreams.delete(requestId);
        // Track Properties 違反と同じ順序 (削除・reject・close) にし、
        // 先に close すると close 側の汎用 reject で特定エラーが上書きされるのを防ぐ。
        pending.reject(scopeError);
        session.closeWithError(scopeError);
        return;
      }
      // draft-ietf-moq-transport-21 §9.3 (REQUEST_OK):
      // "Track Properties are populated in TRACK_STATUS_OK; they are empty in
      //  PUBLISH_OK, REQUEST_UPDATE_OK, SUBSCRIBE_NAMESPACE_OK and PUBLISH_NAMESPACE_OK.
      //  If an endpoint receives Track Properties in one of these messages it MUST
      //  close the session with a PROTOCOL_VIOLATION."
      const trackPropertiesError = validateRequestOkNoTrackProperties(
        decoded.trackProperties,
        "PUBLISH_OK",
      );
      if (trackPropertiesError !== null) {
        session.pendingPublish.delete(requestId);
        session.requestStreams.delete(requestId);
        pending.reject(trackPropertiesError);
        session.closeWithError(trackPropertiesError);
        return;
      }
      session.pendingPublish.delete(requestId);
      session.publishers.set(requestId, pending.impl);

      // draft-ietf-moq-transport-21 §9.20.17:
      // PUBLISH_OK に出現できるのは EXPIRES のみであり、FORWARD 等の
      // Subscription Parameters は運ばれない。Publisher の Forward State は
      // PUBLISH 送信時の指定値のままにし、更新は REQUEST_UPDATE 経路で扱う。
      pending.resolve(pending.impl);

      void bidiReadRequestStreamMessages(
        session,
        requestId,
        context.stream,
        context.controlReader,
        "publish",
      );
    },
    handleRequestError: (context, payload) => {
      const { session, requestId, pending } = context;
      const decoded = decodeRequestErrorPayload(payload);
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
    },
    handleGoaway: (context, payload) => {
      const { session, requestId, pending } = context;
      const decoded = decodeGoawayPayload(payload);
      session.goawayReceivedOnRequestStreams.add(requestId);
      session.pendingPublish.delete(requestId);
      session.requestStreams.delete(requestId);
      pending.impl.goawayCallback?.(decoded.newSessionUri);
      pending.reject(new Error("request stream goaway"));
      // draft-ietf-moq-transport-21 §9.2:
      // 確立前 GOAWAY で reject した後も読み取りを継続し、同一ストリームの
      // 2 通目 GOAWAY を PROTOCOL_VIOLATION として検出する。
      void bidiContinueReadingForDuplicateGoaway(
        session,
        requestId,
        context.stream,
        context.controlReader,
        context.remainingMessages,
      );
    },
    handleUnexpected: (context, type) => {
      const { session, requestId, pending } = context;
      // draft-ietf-moq-transport-21 §9.10:
      // PUBLISH_STATE_NOTIFY を購読以外のリクエスト文脈 (PUBLISH / FETCH /
      // TRACK_STATUS の応答待ち) で受信した場合は PROTOCOL_VIOLATION で
      // セッションを閉じる。
      if (type === MessageType.PUBLISH_STATE_NOTIFY) {
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
        pending.reject(new Error(`unexpected response type ${type} for PUBLISH request`));
      }
    },
    handleCloseError: (context, error) => {
      const { session, requestId, pending } = context;
      session.pendingPublish.delete(requestId);
      session.requestStreams.delete(requestId);
      pending.reject(error);
      session.closeWithError(error);
    },
    handleMalformedTrack: (context, error) => {
      const { session, requestId, pending } = context;
      // draft-ietf-moq-transport-21 §9.3 (REQUEST_OK):
      // PUBLISH_OK の Track Properties は空が必須であり、受信したら PROTOCOL_VIOLATION で
      // セッションを閉じる MUST。未知 Mandatory Track Property (0x4000-0x7FFF) は
      // decodeRequestOkPayload が MalformedTrackError を throw するため、既知 Type の
      // 非空を検出する validateRequestOkNoTrackProperties には到達しない。
      // 削除 → reject → close の順序と、reject と close に同一の SessionError を
      // 渡す契約は既存の違反経路に揃える。
      const sessionError = toTrackPropertiesViolationSessionError(error);
      session.pendingPublish.delete(requestId);
      session.requestStreams.delete(requestId);
      pending.reject(sessionError);
      session.closeWithError(sessionError);
    },
    handleError: (context, error) => {
      const { session, requestId, pending } = context;
      session.pendingPublish.delete(requestId);
      session.requestStreams.delete(requestId);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    },
  });
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
  await bidiReadResponse(session, requestId, stream, controlReader, {
    getPending: (session, requestId) => session.pendingSubscribe.get(requestId),
    okType: MessageType.SUBSCRIBE_OK,
    handleOk: (context, payload) => {
      const { session, requestId, pending } = context;
      const decoded = decodeSubscribeOkPayload(payload);
      // draft-ietf-moq-transport-21 §9.20.1 (Parameter Scope):
      // スコープ違反は PROTOCOL_VIOLATION でセッションを閉じる。
      // 具体エラーを呼び出し元へ reject してから閉じる
      // (PUBLISH 応答経路と同一パターン。順序固定)。
      const scopeError = validateParameterScope(
        decoded.parameters,
        SUBSCRIBE_OK_ALLOWED_PARAMS,
        "SUBSCRIBE_OK",
      );
      if (scopeError !== null) {
        session.pendingSubscribe.delete(requestId);
        session.requestStreams.delete(requestId);
        session.fillFetchTargets.delete(requestId);
        pending.reject(scopeError);
        session.closeWithError(scopeError);
        return;
      }

      const largestLocation = extractLargestLocation(decoded.parameters);

      session.pendingSubscribe.delete(requestId);

      const existingSubscribers = session.subscribersByAlias.get(decoded.trackAlias);
      if (existingSubscribers && existingSubscribers.length > 0) {
        // draft-ietf-moq-transport-21 §3.1.2: 同一 Track Alias が異なる Track に使われている場合のみ DUPLICATE_TRACK_ALIAS
        const trackKey = pending.impl.getFullTrackName();
        if (existingSubscribers[0].getFullTrackName() !== trackKey) {
          const error = new SessionError(
            `duplicate track alias: ${decoded.trackAlias}`,
            SessionErrorCode.DUPLICATE_TRACK_ALIAS,
          );
          session.requestStreams.delete(requestId);
          session.fillFetchTargets.delete(requestId);
          pending.reject(error);
          session.closeWithError(error);
          return;
        }
      }

      pending.impl.setTrackAlias(decoded.trackAlias);

      if (largestLocation) {
        pending.impl.setLargestLocation(largestLocation);
      }
      // draft-ietf-moq-transport-21 §3.3.1:
      // SUBSCRIBE 送信時は LARGEST_OBJECT 未受信のため、SUBSCRIBE_OK で
      // LARGEST_OBJECT を設定した直後に相対 Location Filter を一度だけ再解決する。
      pending.impl.resolveLocationFilter();

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

      void bidiReadRequestStreamMessages(
        session,
        requestId,
        context.stream,
        context.controlReader,
        "subscribe",
      );
    },
    handleRequestError: (context, payload) => {
      const { session, requestId, pending } = context;
      const decoded = decodeRequestErrorPayload(payload);
      session.pendingSubscribe.delete(requestId);
      session.requestStreams.delete(requestId);
      session.fillFetchTargets.delete(requestId);
      const error = new RequestError(
        decoded.reasonPhrase || `Request failed with code ${decoded.errorCode}`,
        normalizeRequestErrorCode(Number(decoded.errorCode)),
      );
      pending.reject(error);
    },
    handleGoaway: (context, payload) => {
      const { session, requestId, pending } = context;
      const decoded = decodeGoawayPayload(payload);
      session.goawayReceivedOnRequestStreams.add(requestId);
      session.pendingSubscribe.delete(requestId);
      session.requestStreams.delete(requestId);
      session.fillFetchTargets.delete(requestId);
      pending.impl.goawayCallback?.(decoded.newSessionUri);
      pending.reject(new Error("request stream goaway"));
      // draft-ietf-moq-transport-21 §9.2:
      // 確立前 GOAWAY で reject した後も読み取りを継続し、同一ストリームの
      // 2 通目 GOAWAY を PROTOCOL_VIOLATION として検出する。
      void bidiContinueReadingForDuplicateGoaway(
        session,
        requestId,
        context.stream,
        context.controlReader,
        context.remainingMessages,
      );
    },
    handleUnexpected: (context, type) => {
      const { session, requestId, pending } = context;
      // draft-ietf-moq-transport-21 §9.10:
      // PUBLISH_STATE_NOTIFY を購読以外のリクエスト文脈で受信した場合は
      // PROTOCOL_VIOLATION でセッションを閉じる。
      if (type === MessageType.PUBLISH_STATE_NOTIFY) {
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
        pending.reject(new Error(`unexpected response type ${type} for SUBSCRIBE request`));
      }
    },
    handleCloseError: (context, error) => {
      const { session, requestId, pending } = context;
      session.pendingSubscribe.delete(requestId);
      session.requestStreams.delete(requestId);
      session.fillFetchTargets.delete(requestId);
      pending.reject(error);
      session.closeWithError(error);
    },
    handleMalformedTrack: async (context, error) => {
      const { session, requestId, pending } = context;
      // draft-ietf-moq-transport-21 §3.6 (Mandatory Track Properties):
      // 未知の Mandatory Track Property を含む SUBSCRIBE_OK を受信した
      // subscriber は購読を cancel する MUST (cancel は §6.4.2.3 の
      // RESET_STREAM / STOP_SENDING で行う)。
      // requestStreams は手動削除せず bidiCancelSubscription に委譲する
      // (手動削除後では cancel が発火しない)。reject は cancel の完了を
      // 待たずに先に行い、ストリーム後始末が遅延してもアプリへ失敗を届ける。
      session.pendingSubscribe.delete(requestId);
      pending.reject(error);
      // 進行中の fill fetch ストリームの sink は subscriberState が closed の
      // ときだけ Object を破棄するため、cancel 前に closed にして
      // malformed track の Object をアプリへ配信し続けないようにする (§3.6)。
      pending.impl.markClosed();
      await bidiCancelSubscription(session, pending.impl);
      // draft-ietf-moq-transport-21 §12.1 (Malformed Tracks):
      // 同一 Track の購読 / FETCH を cancel する MUST に従い、同一 Full Track
      // Name の既存購読 / FETCH も cancel する。
      cancelMalformedTrackPeers(session, pending.impl.getFullTrackName(), error);
    },
    handleError: (context, error) => {
      const { session, requestId, pending } = context;
      session.pendingSubscribe.delete(requestId);
      session.requestStreams.delete(requestId);
      session.fillFetchTargets.delete(requestId);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    },
  });
}

// ============================================================================
// readFetchResponse
// ============================================================================

/**
 * 待機中の fetcher 取得を起こす
 *
 * FETCH_OK 成功時と失敗確定時 (REQUEST_ERROR / GOAWAY / 想定外型 2 分岐 /
 * MalformedTrackError / FIN 先行を含む catch 節の各経路) の両方で使う。
 * incomingWaitForFetcher の doResolve が自己登録解除 (splice) するため、
 * 欠落しないよう複製して反復する。
 * 失敗確定時は fetchers 不在のため待機は null で解決される
 * (成功時は fetchers 登録後に発火するため Fetcher で解決される)。
 * FETCH_OK 内の検証失敗 (スコープ違反・End Location 違反) では
 * セッション終了時のブロードキャスト (SessionImpl の close 時解放) で
 * 解決されるため起こさない。本関数復帰時点では登録が残り、
 * 後の close 処理で解放される。
 */
function fireFetcherReadyCallbacks(session: BidiSessionInternal, requestId: bigint): void {
  const fetcherCallbacks = session.fetcherReadyCallbacks.get(requestId);
  if (fetcherCallbacks) {
    for (const cb of fetcherCallbacks.slice()) {
      cb();
    }
    session.fetcherReadyCallbacks.delete(requestId);
  }
}

export async function bidiReadFetchResponse(
  session: BidiSessionInternal,
  requestId: bigint,
  stream: WebTransportBidirectionalStream,
  controlReader: ControlStreamReader,
): Promise<void> {
  await bidiReadResponse(session, requestId, stream, controlReader, {
    getPending: (session, requestId) => session.pendingFetch.get(requestId),
    okType: MessageType.FETCH_OK,
    handleOk: (context, payload) => {
      const { session, requestId, pending } = context;
      const decoded = decodeFetchOkPayload(payload);
      // draft-ietf-moq-transport-21 §9.20.1 (Parameter Scope):
      // スコープ違反は PROTOCOL_VIOLATION でセッションを閉じる。
      // 具体エラーを呼び出し元へ reject してから閉じる
      // (PUBLISH 応答経路と同一パターン。順序固定)。
      const scopeError = validateParameterScope(
        decoded.parameters,
        FETCH_OK_ALLOWED_PARAMS,
        "FETCH_OK",
      );
      if (scopeError !== null) {
        session.pendingFetch.delete(requestId);
        session.requestStreams.delete(requestId);
        pending.reject(scopeError);
        session.closeWithError(scopeError);
        return;
      }

      if (pending.startLocation) {
        const endLoc = decoded.endLocation;
        const startLoc = pending.startLocation;
        const errorMessage = validateFetchOkEndLocation(startLoc, endLoc);
        if (errorMessage !== undefined) {
          const error = new SessionError(errorMessage, SessionErrorCode.PROTOCOL_VIOLATION);
          session.pendingFetch.delete(requestId);
          session.requestStreams.delete(requestId);
          pending.reject(error);
          session.closeWithError(error);
          return;
        }
      }

      // draft-ietf-moq-transport-21 §9.20.9: GROUP_ORDER は FETCH_OK に許可されない。
      // FETCH リクエスト側から groupOrder を設定できるようフィールドは FetcherImpl に残す。
      session.pendingFetch.delete(requestId);
      pending.impl.setFetchOkInfo(decoded.endOfTrack, decoded.endLocation, decoded.trackProperties);
      session.fetchers.set(requestId, pending.impl);
      pending.resolve(pending.impl);

      fireFetcherReadyCallbacks(session, requestId);
    },
    handleRequestError: (context, payload) => {
      const { session, requestId, pending } = context;
      const decoded = decodeRequestErrorPayload(payload);
      session.pendingFetch.delete(requestId);
      session.requestStreams.delete(requestId);
      fireFetcherReadyCallbacks(session, requestId);
      const error = new RequestError(
        decoded.reasonPhrase || `Request failed with code ${decoded.errorCode}`,
        normalizeRequestErrorCode(Number(decoded.errorCode)),
      );
      pending.reject(error);
    },
    handleGoaway: (context, payload) => {
      const { session, requestId, pending } = context;
      const decoded = decodeGoawayPayload(payload);
      session.goawayReceivedOnRequestStreams.add(requestId);
      session.pendingFetch.delete(requestId);
      session.requestStreams.delete(requestId);
      fireFetcherReadyCallbacks(session, requestId);
      pending.impl.goawayCallback?.(decoded.newSessionUri);
      pending.reject(new Error("request stream goaway"));
      // draft-ietf-moq-transport-21 §9.2:
      // 確立前 GOAWAY で reject した後も読み取りを継続し、同一ストリームの
      // 2 通目 GOAWAY を PROTOCOL_VIOLATION として検出する。
      void bidiContinueReadingForDuplicateGoaway(
        session,
        requestId,
        context.stream,
        context.controlReader,
        context.remainingMessages,
      );
    },
    handleUnexpected: (context, type) => {
      const { session, requestId, pending } = context;
      // draft-ietf-moq-transport-21 §9.10:
      // PUBLISH_STATE_NOTIFY を購読以外のリクエスト文脈で受信した場合は
      // PROTOCOL_VIOLATION でセッションを閉じる。
      if (type === MessageType.PUBLISH_STATE_NOTIFY) {
        const sessionError = new SessionError(
          "unexpected PUBLISH_STATE_NOTIFY for FETCH request",
          SessionErrorCode.PROTOCOL_VIOLATION,
        );
        session.pendingFetch.delete(requestId);
        session.requestStreams.delete(requestId);
        fireFetcherReadyCallbacks(session, requestId);
        pending.reject(sessionError);
        session.closeWithError(sessionError);
      } else {
        session.pendingFetch.delete(requestId);
        session.requestStreams.delete(requestId);
        fireFetcherReadyCallbacks(session, requestId);
        pending.reject(new Error(`unexpected response type ${type} for FETCH request`));
      }
    },
    handleCloseError: (context, error) => {
      const { session, requestId, pending } = context;
      session.pendingFetch.delete(requestId);
      session.requestStreams.delete(requestId);
      fireFetcherReadyCallbacks(session, requestId);
      pending.reject(error);
      session.closeWithError(error);
    },
    handleMalformedTrack: async (context, error) => {
      const { session, requestId, pending } = context;
      // draft-ietf-moq-transport-21 §3.6 (Mandatory Track Properties):
      // 未知の Mandatory Track Property を含む FETCH_OK を受信した subscriber は
      // fetch を cancel する MUST (cancel は §6.4.2.3 の RESET_STREAM /
      // STOP_SENDING で行う)。requestStreams は手動削除せず bidiCancelFetch に
      // 委譲する。開いている FETCH データストリームは fireFetcherReadyCallbacks で
      // 待機を起こし、fetcher 不在の待機が reader.cancel (STOP_SENDING 相当) に
      // 至る既存経路で打ち切られる。reject は cancel の完了を待たずに先に行う。
      session.pendingFetch.delete(requestId);
      pending.reject(error);
      await bidiCancelFetch(session, pending.impl);
      fireFetcherReadyCallbacks(session, requestId);
      // draft-ietf-moq-transport-21 §12.1 (Malformed Tracks):
      // 同一 Track の購読 / FETCH を cancel する MUST に従い、同一 Full Track
      // Name の既存購読 / FETCH も cancel する。
      cancelMalformedTrackPeers(session, pending.impl.getFullTrackName(), error);
    },
    handleError: (context, error) => {
      const { session, requestId, pending } = context;
      session.pendingFetch.delete(requestId);
      session.requestStreams.delete(requestId);
      fireFetcherReadyCallbacks(session, requestId);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    },
  });
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
  await bidiReadResponse(session, requestId, stream, controlReader, {
    getPending: (session, requestId) => session.pendingTrackStatus.get(requestId),
    okType: MessageType.REQUEST_OK,
    handleOk: async (context, payload) => {
      const { session, requestId, pending } = context;
      const decoded = decodeRequestOkPayload(payload);

      // draft-ietf-moq-transport-21 §9.20.1 (Parameter Scope):
      // スコープ違反は PROTOCOL_VIOLATION でセッションを閉じる。
      // 具体エラーを呼び出し元へ reject してから閉じる
      // (PUBLISH 応答経路と同一パターン。順序固定)。
      const scopeError = validateParameterScope(
        decoded.parameters,
        TRACK_STATUS_OK_ALLOWED_PARAMS,
        "TRACK_STATUS_OK",
      );
      if (scopeError !== null) {
        session.pendingTrackStatus.delete(requestId);
        session.requestStreams.delete(requestId);
        pending.reject(scopeError);
        session.closeWithError(scopeError);
        return;
      }

      session.pendingTrackStatus.delete(requestId);
      pending.resolve({ parameters: decoded.parameters });
      // draft-ietf-moq-transport-21 §9.13 / §6.4.2.2:
      // "The bidi stream is closed with a FIN after TRACK_STATUS_OK or
      //  REQUEST_ERROR are sent." レスポンスを受けた requester も自方向を
      // FIN で閉じ、ストリームを graceful に完了させる。requestStreams の
      // エントリから writer を引くため削除より先に実行する。
      await closeRequestStreamWriter(session, requestId);
      session.requestStreams.delete(requestId);
    },
    handleRequestError: async (context, payload) => {
      const { session, requestId, pending } = context;
      const decoded = decodeRequestErrorPayload(payload);
      session.pendingTrackStatus.delete(requestId);
      const error = new RequestError(
        decoded.reasonPhrase || `Request failed with code ${decoded.errorCode}`,
        normalizeRequestErrorCode(Number(decoded.errorCode)),
      );
      pending.reject(error);
      // REQUEST_OK 経路と同じく自方向を FIN で閉じる (§9.13 / §6.4.2.2)。
      await closeRequestStreamWriter(session, requestId);
      session.requestStreams.delete(requestId);
    },
    handleGoaway: (context, payload) => {
      const { session, requestId, pending } = context;
      // TRACK_STATUS は単発リクエストであり ongoing loop を持たないため
      // goawayCallback は不要。newSessionUri は Error.message 経由で通知する。
      const decoded = decodeGoawayPayload(payload);
      session.goawayReceivedOnRequestStreams.add(requestId);
      session.pendingTrackStatus.delete(requestId);
      session.requestStreams.delete(requestId);
      pending.reject(
        new Error(`request stream goaway: ${decoded.newSessionUri || "no redirect URI"}`),
      );
      // draft-ietf-moq-transport-21 §9.2:
      // 確立前 GOAWAY で reject した後も読み取りを継続し、同一ストリームの
      // 2 通目 GOAWAY を PROTOCOL_VIOLATION として検出する。
      void bidiContinueReadingForDuplicateGoaway(
        session,
        requestId,
        context.stream,
        context.controlReader,
        context.remainingMessages,
      );
    },
    handleUnexpected: (context, type) => {
      const { session, requestId, pending } = context;
      // draft-ietf-moq-transport-21 §9.10:
      // PUBLISH_STATE_NOTIFY を購読以外のリクエスト文脈で受信した場合は
      // PROTOCOL_VIOLATION でセッションを閉じる。
      if (type === MessageType.PUBLISH_STATE_NOTIFY) {
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
        pending.reject(new Error(`unexpected response type ${type} for TRACK_STATUS request`));
      }
    },
    handleCloseError: (context, error) => {
      const { session, requestId, pending } = context;
      session.pendingTrackStatus.delete(requestId);
      session.requestStreams.delete(requestId);
      pending.reject(error);
      session.closeWithError(error);
    },
    handleError: (context, error) => {
      const { session, requestId, pending } = context;
      session.pendingTrackStatus.delete(requestId);
      session.requestStreams.delete(requestId);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    },
  });
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

// publisher が fill fetch ストリームを開けないことを示す REQUEST_ERROR の reasonPhrase
export const FILL_NOT_SUPPORTED_REASON = "publisher does not support fill fetch streams";

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
 * publish ロールの REQUEST_UPDATE 拒否後に購読を終了する
 *
 * draft-ietf-moq-transport-21 §9.5.1:
 * REQUEST_UPDATE 失敗時に publisher は PUBLISH_DONE (UPDATE_FAILED) で
 * 購読を終了する MUST。REQUEST_ERROR 応答後に送信するため順序固定
 * (§9.9 で PUBLISH_DONE が最終メッセージ)。
 * 送信前に当該 subscription のデータストリームを閉じる
 * (done() 経路の closePublisherStream と同形。開設なしの場合は不要)。
 * publisher がない場合は開設数を確定できないため Stream Count に
 * 2^64 - 1 を入れる (§9.9 MUST 後段)。
 */
async function bidiTerminatePublishSubscriptionWithUpdateFailed(
  session: BidiSessionInternal,
  requestId: bigint,
): Promise<void> {
  const publisher = session.publishers.get(requestId);
  if (publisher !== undefined) {
    // PUBLISH_DONE は done() と同じ排他経路 (donePromise) で送る。並行する
    // done() があっても 1 回だけ送られ、二重送信による close 失敗の
    // PROTOCOL_VIOLATION 昇格を防ぐ。排他を先に取得した側 (done() の
    // TRACK_ENDED か本経路の UPDATE_FAILED) が送信する (§9.9 / §9.5.1)。
    await publisher.terminate(PublishDoneStatusCode.UPDATE_FAILED);
  } else {
    await publishSendPublishDoneWithoutPublisher(
      session,
      requestId,
      MAX_VARINT,
      PublishDoneStatusCode.UPDATE_FAILED,
    );
  }
  // 購読を終了したため、GOAWAY 受信後に残りの購読が無くなれば閉じる (§6.6.1)。
  session.onRequestDrained?.();
}

/**
 * publish ロールで peer のキャンセル (STOP_SENDING / RESET_STREAM) を検出した
 * ときの後始末
 *
 * draft-ietf-moq-transport-21 §3.1.1:
 * 「The Publisher can remove subscription state as soon as it has received
 *  STOP_SENDING.  It MUST reset any open streams associated with the
 *  SUBSCRIBE.」
 * 開いている Subgroup データストリームを reset (abort) し、購読状態を削除して
 * PublisherImpl を closed にする。peer が購読をキャンセル済みで送信方向も
 * reset されているため PUBLISH_DONE は送らない。二重呼び出しは publisher も
 * requestStreams も不在の場合に no-op になる。
 */
function handlePublishPeerCancel(session: BidiSessionInternal, requestId: bigint): void {
  const publisher = session.publishers.get(requestId);
  const streamInfo = session.requestStreams.get(requestId);
  // publisher も requestStreams も無ければ後始末済み (writer.closed 監視と
  // RESET_STREAM 経路の二重発火) であり、何もしない。
  if (publisher === undefined && streamInfo === undefined) {
    return;
  }
  if (publisher !== undefined) {
    publishResetPublisherStream(session, publisher.getTrackAlias());
    publisher.markClosed();
    session.publishers.delete(requestId);
  }
  // RESET_STREAM 経路では当方の送信方向がまだ開いているため、request stream も
  // reset して完全に cancel する (§6.4.2.3)。STOP_SENDING 経路では既に reset
  // 済みであり、abort は黙殺される。
  if (streamInfo !== undefined) {
    try {
      void streamInfo.writer.abort("peer cancelled subscription").catch(() => {});
    } catch {
      // 既に閉じている場合は無視
    }
  }
  session.requestStreams.delete(requestId);
  // GOAWAY 受信後に残りの購読が無くなれば閉じる (§6.6.1)。
  session.onRequestDrained?.();
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
 * draft-ietf-moq-transport-21 §9.5 (REQUEST_UPDATE):
 * 「The sender of a request (SUBSCRIBE, PUBLISH, FETCH, PUBLISH_NAMESPACE,
 * SUBSCRIBE_NAMESPACE, SUBSCRIBE_TRACKS) can later send a REQUEST_UPDATE on
 * the same bidi stream as the request to modify it.」
 * 受信 PUBLISH の publisher (ピア) が同じ bidi ストリーム上で送る
 * REQUEST_UPDATE を処理し、§9.5 の MUST に従い REQUEST_OK または
 * REQUEST_ERROR を 1 通応答する (coalescing はスコープ外)。
 *
 * 判定順序:
 * (1) デコード結果の Request ID のパリティ・重複検証。違反は §6.4.2.1 の MUST
 *     により INVALID_REQUEST_ID でセッションを閉じる。更新は新規 ID を
 *     消費するため、ストリーム紐付け ID との一致照合は行わない。
 *     §6.4.2.1 MUST を §9.4 MAY 適用 (GOAWAY 拒否) より先に行う。
 * (2) GOAWAY 受信済みなら GOING_AWAY で応答して終了。正常 ID と
 *     GOAWAY 受信済みの組み合わせがここに到達する (不正 ID の場合は
 *     (1) で return するため到達しない)。
 * (3) パラメータスコープ検証。違反は §9.20.1 の MUST により
 *     PROTOCOL_VIOLATION でセッションを閉じる。REQUEST_UPDATE_ALLOWED_PARAMS
 *     は TRACK_NAMESPACE_PREFIX (§9.20.21、namespace 系 REQUEST_UPDATE 専用)
 *     と TRACK_PROPERTY_FILTER (§3.3.2、SUBSCRIBE_TRACKS 専用) を含まないため、
 *     通常の PUBLISH / SUBSCRIBE 系 REQUEST_UPDATE で受信したこれらは
 *     NOT_SUPPORTED ではなく PROTOCOL_VIOLATION で閉じる。
 * (4) Range Filter / LOCATION_FILTER / FILL_PARAMETERS の値検証。不正は
 *     REQUEST_ERROR (INVALID_FILTER) で応答する (§3.3.2 / §9.20.13-15)。
 *     自 endpoint が広告した MAX_FILTER_RANGES (未広告時 0) を超える
 *     Range Filter も同じく INVALID_FILTER で拒否する (§9.1.6)。
 *     許可パラメータ (SUBSCRIBER_PRIORITY / LOCATION_FILTER /
 *     NEW_GROUP_REQUEST / FILL_PARAMETERS / Range Filters 等) は受理する。
 * (5) 受理した FORWARD を受信 PUBLISH から生成された SubscriberImpl の
 *     Forward State に反映し (FORWARD 省略時は不変)、REQUEST_OK を応答する
 *     (ペイロードは空 parameters / 空 trackProperties)。
 *
 * 応答の書き込み失敗 (writer が閉じている等) は黙殺する。
 * デコード失敗は PROTOCOL_VIOLATION でセッションを閉じる (詳細は
 * インラインコメントを参照)。Request ID は読み取るだけで応答には含めない
 * (応答は同一 bidi ストリーム上に書き込まれることでリクエストが特定される。
 * 既存 role=publish ハンドラと同様)。
 *
 * 受理した FORWARD 以外のパラメータは状態として保持しない
 * (accept-then-ignore。更新の反映を前提とするピアと意味論が乖離する点は
 * 残余リスクとして残る)。
 */
export async function bidiHandlePublishRequestUpdate(
  session: BidiSessionInternal,
  requestId: bigint,
  payload: Uint8Array,
): Promise<void> {
  // REQUEST_UPDATE ペイロードをデコードする
  // デコード失敗は PROTOCOL_VIOLATION でセッションを閉じる。ControlStreamReader
  // は Length 分の完全なメッセージのみ渡すため、IncompleteDataError は
  // メッセージ構造の破損を意味する。呼び出し元ループの catch
  // (toSessionCloseError) でも IncompleteDataError は
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

  // 判定順序 (1): デコード結果の Request ID のパリティ・重複検証
  // draft-ietf-moq-transport-21 §6.4.2.1 (Request ID):
  // 更新は新規 ID を消費するため、ストリーム紐付け ID との一致照合は行わない。
  // §6.4.2.1 MUST を §9.4 MAY 適用 (GOAWAY 拒否) より先に行う。
  if (!session.validateIncomingRequestId(decoded.requestId)) {
    return;
  }

  // 判定順序 (2): GOAWAY 受信済みの旧リクエストへの REQUEST_UPDATE は
  // REQUEST_ERROR (GOING_AWAY) で拒否する (draft-ietf-moq-transport-21
  // §9.4「GOING_AWAY: The endpoint has received a GOAWAY and MAY reject
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

  // 判定順序 (3): パラメータスコープ検証
  // draft-ietf-moq-transport-21 §9.20.1 (Parameter Scope):
  // "If it appears in some other type of message, the receiving endpoint
  //  MUST close the connection with a PROTOCOL_VIOLATION."
  // REQUEST_UPDATE_ALLOWED_PARAMS は subscription 系 REQUEST_UPDATE に
  // 出現し得る型の集合であり、TRACK_NAMESPACE_PREFIX (§9.20.21、
  // namespace 系 REQUEST_UPDATE 専用) と TRACK_PROPERTY_FILTER (§3.3.2、
  // SUBSCRIBE_TRACKS 専用) を含まない。これらを受信した場合は
  // NOT_SUPPORTED ではなく §9.20.1 の MUST に従い PROTOCOL_VIOLATION で閉じる。
  const scopeError = validateParameterScope(
    decoded.parameters,
    REQUEST_UPDATE_ALLOWED_PARAMS,
    "REQUEST_UPDATE",
  );
  if (scopeError !== null) {
    session.closeWithError(scopeError);
    return;
  }

  // 判定順序 (4): Range Filter / LOCATION_FILTER / FILL_PARAMETERS の値検証と
  // 自 endpoint の MAX_FILTER_RANGES (未広告時 0) の上限検証。
  // draft-ietf-moq-transport-21 §3.3.2 / §9.20.13-15 / §9.1.6:
  // 不正なフィルタ・上限超過は REQUEST_ERROR (INVALID_FILTER) で応答する。
  // LOCATION_FILTER / FILL_PARAMETERS 内側の一覧外・値違反
  // (ProtocolViolationError) は §9.20.1 / §9.20.16 の MUST に従い
  // PROTOCOL_VIOLATION でセッションを閉じる。検証は状態変更
  // (setForwardState) より前に配置し、拒否時に Forward State が反映される
  // 不整合を防ぐ。
  try {
    validateRangeFilterCombination(decoded.parameters);
    const decodedFill = validateLocationAndFillParameters(decoded.parameters);
    validateIncomingRangeFilterLimits(
      decoded.parameters,
      decodedFill.fillInnerParameters,
      session.localMaxFilterRanges ?? 0,
      "REQUEST_UPDATE",
    );
  } catch (error) {
    if (error instanceof InvalidFilterError) {
      await bidiSendRequestError(
        session,
        requestId,
        RequestErrorCode.INVALID_FILTER,
        error.message,
      );
      return;
    }
    if (error instanceof ProtocolViolationError) {
      session.closeWithError(new SessionError(error.message, SessionErrorCode.PROTOCOL_VIOLATION));
      return;
    }
    throw error;
  }

  // draft-ietf-moq-transport-21 §9.5 / §9.20.19:
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

  // draft-ietf-moq-transport-21 §3.4.1 (Opening and Closing Fill Fetch Streams):
  // 「A publisher opens a fill fetch stream when it processes a SUBSCRIBE or
  //  REQUEST_UPDATE that carries FILL_PARAMETERS while Forward State is 1.」
  // 受信 PUBLISH 経路で REQUEST_UPDATE を処理するのは moqt-js (subscriber) で
  // あり、fill fetch ストリームを開く主体 (publisher) ではない。この方向では
  // fill ストリームは開かれないため、FILL_PARAMETERS は検証後に受理して
  // REQUEST_OK を返し、fillFetchTargets へは登録しない。
  // 送信 PUBLISH 側 (moqt-js が publisher) は applyPublishRequestUpdate が
  // fill を開けないため REQUEST_ERROR (NOT_SUPPORTED) で拒否する。役割差による
  // 正当な非対称である。

  // 判定順序 (5): REQUEST_OK を応答する
  // draft-ietf-moq-transport-21 §9.5:
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
    // draft-ietf-moq-transport-21 §6.6.1:
    // GOAWAY 受信後に Established 購読が無くなった時点で NO_ERROR で閉じる。
    session.onRequestDrained?.();
  }
}

/**
 * 自方向の送信ストリームを FIN で閉じる
 *
 * draft-ietf-moq-transport-21 §6.4.2.2:
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
 * draft-ietf-moq-transport-21 §9.2:
 * 「Upon receiving a GOAWAY on a request stream, the endpoint SHOULD re-issue
 *  that specific request ... and close the old request stream」
 * - publisher: 即時クローズせずアプリの done() に委ねる (§6.4.2.2 MUST「the
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

/**
 * リクエストストリームの読み取りループで発生したエラーの処理
 *
 * - SessionError (KEY_VALUE_FORMATTING_ERROR 等) はそのコードのまま、
 *   ProtocolViolationError / IncompleteDataError は PROTOCOL_VIOLATION で
 *   セッションを閉じる
 * - ピアの RESET_STREAM (isPeerStreamError) は role ごとに後始末する
 * - それ以外 (セッション終了・内部エラー等) と GOAWAY 受信済みの旧ストリームは
 *   何もしない
 */
function handleRequestStreamReadError(
  session: BidiSessionInternal,
  requestId: bigint,
  error: unknown,
  role: "publish" | "subscribe",
): void {
  const sessionError = toSessionCloseError(error);
  if (sessionError !== null) {
    session.closeWithError(sessionError);
    return;
  }
  if (!isPeerStreamError(error) || session.goawayReceivedOnRequestStreams.has(requestId)) {
    return;
  }
  if (role === "publish") {
    // draft-ietf-moq-transport-21 §3.1.1:
    // ピアの RESET_STREAM で readable がエラー終了した場合、開いている
    // Subgroup データストリームを reset し、購読状態を削除する。
    handlePublishPeerCancel(session, requestId);
    return;
  }
  // draft-ietf-moq-transport-21 §6.4.2.3:
  // ピアの RESET_STREAM により readable がエラー終了した場合、subscriber の
  // error コールバックを呼び state を closed にする (アプリが終了を検知
  // できるようにする実用上の対応。FIN 経路の notifySubscriberFailure と同じ)。
  // セッションは閉じない (プロトコル違反ではない)。
  // draft-ietf-moq-transport-21 §6.4.2.2 / §9.5.1:
  // RESET_STREAM は FIN よりも強い終了であり、応答未達の REQUEST_UPDATE は
  // FIN 経路と同様に失敗として reject する。応答 (REQUEST_OK / REQUEST_ERROR)
  // は届かないため、残すとアプリは update() の結果を待ち続ける。
  // 通知より先に実行することで、アプリの error コールバックが throw しても
  // reject が実行される (順序の根拠。FIN 経路と同パターン)。
  rejectPendingRequestUpdates(session, requestId, new Error(REQUEST_UPDATE_STREAM_CLOSED_MESSAGE));
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

/**
 * 確立後の REQUEST_OK (REQUEST_UPDATE_OK) を処理する
 *
 * draft-ietf-moq-transport-21 §9.3 (REQUEST_OK):
 * REQUEST_UPDATE_OK の Track Properties は空必須であり、受信したら PROTOCOL_VIOLATION で
 * セッションを閉じる MUST。未知 Mandatory Track Property (0x4000-0x7FFF) は decode が
 * MalformedTrackError を throw するため、保留中の更新を reject してから閉じる
 * (既知 Type の非空を検出する bidiHandleRequestUpdateOk と同じ順序)。
 *
 * @returns 読み取りを継続するなら true、違反で閉じたなら false (呼び出し側は return する)
 */
function handleRequestUpdateOkMessage(
  session: BidiSessionInternal,
  payload: Uint8Array,
  requestId: bigint,
): boolean {
  try {
    bidiHandleRequestUpdateOk(session, payload, requestId);
    return true;
  } catch (err) {
    if (!(err instanceof MalformedTrackError)) {
      throw err;
    }
    const sessionError = toTrackPropertiesViolationSessionError(err);
    deleteFillTargetsForPendingUpdates(session, requestId);
    rejectPendingRequestUpdates(session, requestId, sessionError);
    session.closeWithError(sessionError);
    return false;
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
  // 読み取りループがロックを保持するため、解除 (unsubscribe) 時に保持者経由で
  // cancel できるよう登録する。エントリ削除済み (解除競合) の場合は登録しない。
  const registeredEntry = session.requestStreams.get(requestId);
  if (registeredEntry !== undefined) {
    registeredEntry.reader = reader;
  }
  // draft-ietf-moq-transport-21 §3.1.1:
  // publish ロールでピアが STOP_SENDING を送ると当方の送信方向が reset され、
  // writer.closed が reject する。reader.read() では検出できないため、送信方向
  // の終了を監視して開いている Subgroup データストリームを reset する。
  if (role === "publish" && registeredEntry !== undefined) {
    void registeredEntry.writer.closed.catch((error: unknown) => {
      // セッション終了やローカル abort ではなく、ピアの STOP_SENDING /
      // RESET_STREAM による送信方向の終了だけを対象にする。
      if (isPeerStreamError(error)) {
        handlePublishPeerCancel(session, requestId);
      }
    });
  }
  // ピアの graceful FIN (reader.read() の { done: true }) を記録し、
  // publish ロールのみ削除を done() 完了後まで遅延する判定に使う。
  let receivedFin = false;
  try {
    while (session.sessionState === "connected") {
      const { value, done } = await reader.read();
      if (done) {
        receivedFin = true;
        // draft-ietf-moq-transport-21 §6.4.2.2:
        // 受信側 (subscribe ロール) でピア (publisher) が PUBLISH_DONE を
        // 送らずに FIN した場合は失敗扱いであり、subscriber に通知する。
        // publish ロールでは requester の FIN は正常完了シグナルであり
        // 通知しない。
        if (role === "subscribe") {
          try {
            // draft-ietf-moq-transport-21 §9.5.1 / §6.4.2.2:
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
            // draft-ietf-moq-transport-21 §6.4.2.2:
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
            // draft-ietf-moq-transport-21 §9.10: 受信と違反処理はハンドラ内。
            if (!bidiHandlePublishStateNotify(session, msg.payload, requestId, role)) {
              return;
            }
            break;
          }
          case MessageType.REQUEST_OK: {
            // draft-ietf-moq-transport-21 §9.3 (REQUEST_OK):
            // 確立後の REQUEST_OK は REQUEST_UPDATE_OK であり、Track Properties は
            // 空が必須 (違反処理はヘルパー内で行う)。
            if (!handleRequestUpdateOkMessage(session, msg.payload, requestId)) {
              return;
            }
            break;
          }
          case MessageType.REQUEST_ERROR: {
            const decoded = decodeRequestErrorPayload(msg.payload);
            const error = new RequestError(
              decoded.reasonPhrase || `Request failed with code ${decoded.errorCode}`,
              normalizeRequestErrorCode(Number(decoded.errorCode)),
            );
            // draft-ietf-moq-transport-21 §9.5: coalescing により単一 REQUEST_ERROR で
            // 複数の REQUEST_UPDATE が失敗し得る。該当 pending をすべて reject する。
            // 失敗が確定した更新の fill 関連付けも消す (確定済みの fill は残す)。
            deleteFillTargetsForPendingUpdates(session, requestId);
            rejectPendingRequestUpdates(session, requestId, error);
            break;
          }
          case MessageType.REQUEST_UPDATE: {
            // draft-ietf-moq-transport-21 §9.5:
            // 「A subscriber can also send REQUEST_UPDATE to modify parameters of a
            //  subscription established with PUBLISH.」
            // クライアントが Publisher の場合、サーバー (Subscriber 役) が
            // PUBLISH bidi ストリーム上で REQUEST_UPDATE を送信してくる。
            //
            // draft-ietf-moq-transport-21 §9.5:
            // 「The receiver of a REQUEST_UPDATE MUST respond with exactly one
            //  REQUEST_OK or REQUEST_ERROR message indicating if the update was
            //  successful, unless it is coalescing failed updates.」
            // デコード失敗は PROTOCOL_VIOLATION でセッションを閉じる。閉じる結果は
            // ループ catch (toSessionCloseError) と同じだが、ここでは
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

            // デコード結果の Request ID のパリティ・重複検証
            // draft-ietf-moq-transport-21 §6.4.2.1 (Request ID):
            // 更新は新規 ID を消費するため、ストリーム紐付け ID との一致照合は行わない。
            // §6.4.2.1 MUST を GOAWAY 拒否 (§9.4 MAY) と想定外更新 (§9.5) の
            // PROTOCOL_VIOLATION より先に行う。
            if (!session.validateIncomingRequestId(decoded.requestId)) {
              return;
            }

            // draft-ietf-moq-transport-21 §9.2 / §12.5 / §9.5:
            // GOAWAY 受信後の旧リクエストに対する REQUEST_UPDATE の扱い。
            // - publish ロール: GOAWAY 処理で送信方向を閉じないため応答可能。
            //   §9.5 の MUST「The receiver of a REQUEST_UPDATE MUST respond
            //   with exactly one REQUEST_OK or REQUEST_ERROR message」を満たす
            //   ため、REQUEST_ERROR (GOING_AWAY) で応答する。
            // - subscribe ロール: GOAWAY 処理で送信方向を FIN (writer.close())
            //   で閉じているため GOING_AWAY 応答を書き込むことができない。
            //   §9.5 の MUST からは逸脱するが、§6.4.2.2 によりピアは FIN 後に
            //   REQUEST_UPDATE を送るべきではない (「will not need to respond
            //   to a future REQUEST_UPDATE」) ため、無視する。
            if (session.goawayReceivedOnRequestStreams.has(requestId)) {
              // publish ロールは送信方向が開いているため GOING_AWAY で応答する
              // (§9.5 MUST)。subscribe ロールは送信方向が FIN 済みのため応答
              // 不能であり、無視する。
              if (role === "publish") {
                await bidiSendRequestError(
                  session,
                  requestId,
                  RequestErrorCode.GOING_AWAY,
                  REQUEST_GOING_AWAY_REASON,
                );
                // draft-ietf-moq-transport-21 §9.5.1: 拒否した更新の購読を終了する。
                await bidiTerminatePublishSubscriptionWithUpdateFailed(session, requestId);
              }
              break;
            }
            // draft-ietf-moq-transport-21 §9.5:
            // 予期しない REQUEST_UPDATE は PROTOCOL_VIOLATION でセッションを閉じる。
            // SUBSCRIBE ストリーム上で peer から REQUEST_UPDATE が来ることは
            // Section 9.5 の 2 ケースに該当しない。
            if (role === "subscribe") {
              session.closeWithError(
                new SessionError(
                  "unexpected REQUEST_UPDATE on subscribe stream",
                  SessionErrorCode.PROTOCOL_VIOLATION,
                ),
              );
              return;
            }

            // パラメータスコープ検証
            // draft-ietf-moq-transport-21 §9.20.1 (Parameter Scope)
            const scopeError = validateParameterScope(
              decoded.parameters,
              REQUEST_UPDATE_ALLOWED_PARAMS,
              "REQUEST_UPDATE",
            );
            if (scopeError !== null) {
              session.closeWithError(scopeError);
              return;
            }

            // Range Filter の値域・構造・組み合わせ重複検証
            // draft-ietf-moq-transport-21 §3.3.2 / §9.20.13-15:
            // 不正な Range Filter は REQUEST_ERROR (INVALID_FILTER) で応答する。
            // 検証は状態変更 (setForwardState) より前に配置し、違反で
            // REQUEST_ERROR を応答したにも関わらず forward state が反映される
            // 不整合を防ぐ。
            // LOCATION_FILTER / FILL_PARAMETERS 内側の値違反
            // (InvalidFilterError) も同一経路で REQUEST_ERROR にする。
            // validateLocationAndFillParameters のデコード結果を上限合算と
            // fill 範囲評価で再利用する (catch で break / throw するため、
            // 検証通過時は必ず値が入る)。
            let decodedFill: DecodedLocationAndFill = {
              locationFilter: undefined,
              fillInnerParameters: undefined,
              fillInnerLocationFilter: undefined,
            };
            try {
              validateRangeFilterCombination(decoded.parameters);
              decodedFill = validateLocationAndFillParameters(decoded.parameters);
              // draft-ietf-moq-transport-21 §9.1.6 (MAX FILTER RANGES):
              // 自 endpoint が広告した上限 (未広告時 0) を超える Range Filter は
              // REQUEST_ERROR (INVALID_FILTER) で拒否する。
              validateIncomingRangeFilterLimits(
                decoded.parameters,
                decodedFill.fillInnerParameters,
                session.localMaxFilterRanges ?? 0,
                "REQUEST_UPDATE",
              );
            } catch (error) {
              if (error instanceof InvalidFilterError) {
                await bidiSendRequestError(
                  session,
                  requestId,
                  RequestErrorCode.INVALID_FILTER,
                  error.message,
                );
                // draft-ietf-moq-transport-21 §9.5.1: 拒否した更新の購読を終了する。
                await bidiTerminatePublishSubscriptionWithUpdateFailed(session, requestId);
                break;
              }
              throw error;
            }

            // LOCATION_FILTER / FILL_PARAMETERS の違反のうち
            // ProtocolViolationError / IncompleteDataError 級のものは関数外側の catch の
            // toSessionCloseError で PROTOCOL_VIOLATION にして
            // セッションを閉じる。内側パラメータの検証は上の検証ブロックで先に
            // 完了しており、検証通過後は fill fetch ストリームを必要とする更新を
            // 除いて REQUEST_OK を応答する。

            const publisher = session.publishers.get(requestId);
            if (publisher) {
              // draft-ietf-moq-transport-21 §3.4 / §3.4.1 / §9.5 / §9.20.19:
              // LOCATION_FILTER / FORWARD を購読状態へ反映し、FILL_PARAMETERS が
              // fill fetch ストリームを必要とするかを判定する。moqt-js は
              // fill fetch ストリームを開けないため、必要な場合は
              // REQUEST_ERROR (NOT_SUPPORTED) で拒否する。詳細は
              // applyPublishRequestUpdate を参照。
              if (applyPublishRequestUpdate(publisher, decoded.parameters, decodedFill)) {
                await bidiSendRequestError(
                  session,
                  requestId,
                  RequestErrorCode.NOT_SUPPORTED,
                  FILL_NOT_SUPPORTED_REASON,
                );
                // draft-ietf-moq-transport-21 §9.5.1: 拒否した更新の購読を終了する。
                await bidiTerminatePublishSubscriptionWithUpdateFailed(session, requestId);
                break;
              }

              // REQUEST_OK を送信 (draft-ietf-moq-transport-21 §9.5 MUST)
              // draft-ietf-moq-transport-21 §9.20.18 (LARGEST OBJECT Parameter):
              // "If Objects have been published on this Track the Publisher MUST
              //  include this parameter." 自 endpoint が Publisher として
              // 受理する REQUEST_UPDATE の REQUEST_OK には、publish 済みの
              // 最大 Location を LARGEST_OBJECT として必ず含める (§9.5.1 が
              // 増加した End Location との隙間を FETCH で補う前提を定める)。
              const okParameters: Parameter[] = [];
              const largestLocation = publisher.getLargestLocation();
              if (largestLocation !== null) {
                okParameters.push({
                  type: MessageParameterType.LARGEST_OBJECT,
                  value: encodeLocation(largestLocation),
                });
              }
              const okPayload = encodeRequestOkPayload({
                type: MessageType.REQUEST_OK,
                parameters: okParameters,
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
              // draft-ietf-moq-transport-21 §9.5: 更新失敗時は REQUEST_ERROR
              // 書き込み失敗は黙殺し、後続の PUBLISH_DONE 送信に進む
              // (GOING_AWAY / INVALID_FILTER 経路と同一の回復力にする)。
              await bidiSendRequestError(
                session,
                requestId,
                RequestErrorCode.INTERNAL_ERROR,
                "publisher not found for request update",
              );
              // draft-ietf-moq-transport-21 §9.5.1: 拒否した更新の購読を終了する。
              // publisher がないため開設数は確定できず Stream Count は 2^64 - 1 とする。
              await bidiTerminatePublishSubscriptionWithUpdateFailed(session, requestId);
            }
            break;
          }
          case MessageType.GOAWAY: {
            // draft-ietf-moq-transport-21 §9.2:
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
            // draft-ietf-moq-transport-21 §9.2:
            // 「Upon receiving a GOAWAY on a request stream, the endpoint SHOULD
            //  re-issue that specific request ... and close the old request stream
            //  using the appropriate mechanism (e.g. FIN, stream reset, or
            //  PUBLISH_DONE).」
            // GOAWAY 受信後も読み取りを継続して 2 通目以降の GOAWAY を検出する
            // (§9.2 MUST)。
            // subscription state は変更しない (§9.2「The GOAWAY message does
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
    handleRequestStreamReadError(session, requestId, error, role);
  } finally {
    // 解除側が古い reader で cancel しないよう、解放前に登録を外す
    // (エントリ削除済みの場合は何もしない)。
    const registeredEntry = session.requestStreams.get(requestId);
    if (registeredEntry !== undefined && registeredEntry.reader === reader) {
      registeredEntry.reader = undefined;
    }
    reader.releaseLock();
    deleteSubscriber(session, requestId);
    // draft-ietf-moq-transport-21 §6.4.2.2 の MUST「the publisher of an
    // Established subscription MUST send PUBLISH_DONE, before sending a FIN」:
    // ピアが送信方向を FIN で閉じた場合でも、publisher はアプリの done() が
    // 呼ばれたときに PUBLISH_DONE を送信してから自方向を FIN で閉じる必要が
    // ある。ここで requestStreams のエントリを削除してしまうと
    // publishSendPublishDone が streamInfo を引けず、PUBLISH_DONE 送信と FIN の
    // 両方をスキップする (§9.8 の MUST「A sender MUST NOT destroy subscription
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
 * 受信した LOCATION_FILTER / FILL_PARAMETERS のデコード結果
 *
 * 検証と利用で重複デコードしないよう、デコード済みの値を上限合算と fill 範囲
 * 評価へ受け渡す。
 */
interface DecodedLocationAndFill {
  /** top-level の LOCATION_FILTER (未受信時 undefined) */
  locationFilter: LocationFilter | undefined;
  /** FILL_PARAMETERS 内側の Parameter[] (未受信時 undefined) */
  fillInnerParameters: Parameter[] | undefined;
  /** FILL_PARAMETERS 内側の LOCATION_FILTER (未指定時 undefined) */
  fillInnerLocationFilter: LocationFilter | undefined;
}

/**
 * 受信パラメータ群に含まれる LOCATION_FILTER / FILL_PARAMETERS の値を検証する
 *
 * draft-ietf-moq-transport-21 §9.20.10 (LOCATION FILTER Parameter):
 * "If StartGroup + EndGroupDelta exceeds 2^64 - 1, the endpoint MUST
 *  close the session with a PROTOCOL_VIOLATION."
 * draft-ietf-moq-transport-21 §9.20.16 (FILL PARAMETERS Parameter):
 * 内側の一覧に無いパラメータを受信した endpoint は PROTOCOL_VIOLATION で
 * セッションを閉じる。
 * decode の失敗 (ProtocolViolationError / IncompleteDataError) は呼び出し元の
 * 受信ループの catch で PROTOCOL_VIOLATION に変換される。
 * REQUEST_UPDATE を受信する両経路 (bidiHandlePublishRequestUpdate /
 * bidiReadRequestStreamMessages) で使う。PUBLISH_OK は EXPIRES のみを
 * 許可するため本検証は通さない (許可外はスコープ検証で拒否する)。
 *
 * @returns 検証済みのデコード結果。上限合算と fill 範囲評価で再利用する
 */
function validateLocationAndFillParameters(parameters: Parameter[]): DecodedLocationAndFill {
  let locationFilter: LocationFilter | undefined;
  let fillInnerParameters: Parameter[] | undefined;
  let fillInnerLocationFilter: LocationFilter | undefined;
  for (const param of parameters) {
    if (param.type === MessageParameterType.LOCATION_FILTER) {
      locationFilter = decodeLocationFilterParameter(param);
    } else if (param.type === MessageParameterType.FILL_PARAMETERS) {
      fillInnerParameters = decodeFillParameters(param);
      const innerLocationFilter = fillInnerParameters.find(
        (inner) => inner.type === MessageParameterType.LOCATION_FILTER,
      );
      if (innerLocationFilter !== undefined) {
        fillInnerLocationFilter = decodeLocationFilterParameter(innerLocationFilter);
      }
    }
  }
  return { locationFilter, fillInnerParameters, fillInnerLocationFilter };
}

/**
 * publish ロールの REQUEST_UPDATE を購読状態へ反映する
 *
 * draft-ietf-moq-transport-21 §9.5:
 * 「If a parameter previously set on the request is not present in
 *  REQUEST_UPDATE, its value remains unchanged.」
 * - LOCATION_FILTER が存在する場合のみ購読の Location Filter を更新する。
 * - FORWARD が存在する場合のみ Forward State を更新する (省略時に
 *   extractForwardState がデフォルト true を返すため無条件反映はしない)。
 * - FILL_PARAMETERS を含み Forward State が 1 で fill 範囲が空でない場合、
 *   publisher は fill fetch ストリームを開く必要がある。moqt-js は開けない
 *   ため拒否対象として true を返す。
 *
 * @returns FILL_PARAMETERS を理由に REQUEST_ERROR で拒否すべきなら true
 */
function applyPublishRequestUpdate(
  publisher: PublisherImpl,
  parameters: Parameter[],
  decodedFill: DecodedLocationAndFill,
): boolean {
  const forwardParam = parameters.find((param) => param.type === MessageParameterType.FORWARD);
  const fillParam = parameters.find((param) => param.type === MessageParameterType.FILL_PARAMETERS);

  // 更新適用後の有効値 (省略時は現在値) で fill 範囲を判定する。拒否する更新を
  // 先に状態へ反映すると、アプリの onForwardStateChange が誤って呼ばれ、
  // 終了処理中の publisher へ送信を再開させてしまう。反映は受理が確定してから
  // 行う (検証を状態変更より先に行う既存方針と同じ)。
  const largestLocation = publisher.getLargestLocation();
  const decodedLocationFilter = decodedFill.locationFilter;
  // 同一更新の LOCATION_FILTER は受信時点の Largest Object で解決する (§3.3.1)。
  // 省略時は受理済みの解決済みフィルタをそのまま使う (再解決しない)。
  const effectiveSubscriptionFilter =
    decodedLocationFilter !== undefined
      ? resolveFilter(decodedLocationFilter, largestLocation)
      : publisher.getResolvedLocationFilter();
  const effectiveForwardState =
    forwardParam !== undefined ? extractForwardState(parameters) : publisher.forwardState;

  let rejectForFill = false;
  if (fillParam !== undefined && effectiveForwardState) {
    const fillFilter = resolveFillRangeFilter(
      decodedFill.fillInnerLocationFilter,
      effectiveSubscriptionFilter,
      largestLocation,
    );
    rejectForFill = !isFillRangeEmpty(fillFilter, largestLocation);
  }

  if (rejectForFill) {
    return true;
  }

  // 受理した更新のみ購読状態へ反映する
  if (decodedLocationFilter !== undefined) {
    publisher.setLocationFilter(decodedLocationFilter);
  }
  if (forwardParam !== undefined) {
    publisher.setForwardState(effectiveForwardState);
  }
  return false;
}

/**
 * FILL_PARAMETERS の fill 範囲を解決する
 *
 * draft-ietf-moq-transport-21 §3.4 (Fill Semantics):
 * 「The fill range is the range of Locations selected by the Location filter
 *  inside FILL_PARAMETERS, or the subscription's Location filter if it is
 *  omitted.」
 * 内側の LOCATION_FILTER は fill 要求時点の Largest Object で解決し、省略時は
 * 購読の解決済み Location Filter をそのまま使う。内側の LOCATION_FILTER は
 * validateLocationAndFillParameters のデコード結果を再利用する。
 *
 * @param innerLocationFilter - FILL_PARAMETERS 内側の LOCATION_FILTER (未指定時 undefined)
 * @param subscriptionResolvedFilter - 購読の解決済み Location Filter
 * @param largestLocation - publisher が送信済みの最大 Location (未送信時 null)
 */
function resolveFillRangeFilter(
  innerLocationFilter: LocationFilter | undefined,
  subscriptionResolvedFilter: ResolvedFilter | undefined,
  largestLocation: Location | null,
): ResolvedFilter | undefined {
  if (innerLocationFilter !== undefined) {
    return resolveFilter(innerLocationFilter, largestLocation);
  }
  return subscriptionResolvedFilter;
}

/**
 * fill 範囲が空かどうかを判定する
 *
 * draft-ietf-moq-transport-21 §3.4 (Fill Semantics):
 * 「If the fill range is empty, or starts after Largest Object, the publisher
 *  does not open a fill fetch stream.」
 * fill 範囲は Largest Object を超えられないため、Largest Object 未受信
 * (largestLocation === null) の場合は常に空とする。フィルタなし (undefined)
 * はトラック全体が範囲であり空でない。フィルタの最小 Location (start) が
 * 自身の End 系上限を超える場合、または Largest Object より後を指す場合は、
 * 配信できる Object が無いため空とする。
 *
 * @param filter - resolveFilter で解決済みの fill 範囲
 * @param largestLocation - publisher が送信済みの最大 Location (未送信時 null)
 */
function isFillRangeEmpty(
  filter: ResolvedFilter | undefined,
  largestLocation: Location | null,
): boolean {
  // Largest Object 未受信 (まだ Object を送信していない) 場合は、fill 範囲が
  // Largest Object を超えられないため常に空 (§3.4)
  if (largestLocation === null) {
    return true;
  }
  if (filter === undefined) {
    return false;
  }
  // フィルタの最小 Location が End Group / End Object の上限を超える場合は空
  if (!objectMatchesFilter(filter.start, filter)) {
    return true;
  }
  // Largest Object より後の開始は fill できる Object が無い
  if (compareLocations(filter.start, largestLocation) > 0) {
    return true;
  }
  return false;
}

/**
 * 受信パラメータに含まれる Range Filter の合計 Ranges 数を数える
 *
 * draft-ietf-moq-transport-21 §9.1.6 (MAX FILTER RANGES):
 * 「limits the peer's total number of Ranges (Start/End pairs) allowed
 *  concurrently in all Range filter Section 3.3.2 parameters for a given
 *  subscription or fetch」
 * トップレベルの Range Filter (0x25-0x29) に加え、FILL_PARAMETERS (0x23)
 * 内側の Range Filter (0x25-0x28) も購読単位の合計に含める (§9.20.16 は
 * 内側を独立した parameter scope とするが、購読単位の上限は fill を含む)。
 * 除去 (Length=0) は Ranges を消費しないため数えない。
 * FILL_PARAMETERS 内側の Parameter[] は validateLocationAndFillParameters の
 * デコード結果を再利用する。
 */
function countIncomingRangeFilterRanges(
  parameters: Parameter[],
  fillInnerParameters: Parameter[] | undefined,
): {
  hasRangeFilter: boolean;
  totalRanges: number;
} {
  let hasRangeFilter = false;
  let totalRanges = 0;
  const addRanges = (rangeParameters: Parameter[]): void => {
    for (const param of rangeParameters) {
      if (param.type < 0x25 || param.type > 0x29) {
        continue;
      }
      hasRangeFilter = true;
      const [decoded] = decodeRangeFilter(rangeFilterTypeOf(param.type), param.value);
      if (!("remove" in decoded)) {
        totalRanges += decoded.ranges.length;
      }
    }
  };
  addRanges(parameters);
  if (fillInnerParameters !== undefined) {
    addRanges(fillInnerParameters);
  }
  return { hasRangeFilter, totalRanges };
}

/**
 * 自 endpoint が広告した MAX_FILTER_RANGES に対する受信 Range Filter を検証する
 *
 * draft-ietf-moq-transport-21 §9.1.6 (MAX FILTER RANGES):
 * "The default value is 0, so if not specified, the peer MUST NOT send any
 *  such filter parameters. If this limit is exceeded, an endpoint MUST
 *  reject this with REQUEST_ERROR with error code INVALID_FILTER."
 * 自 endpoint の上限 (未広告時は 0) を超える Range Filter を InvalidFilterError
 * として通知し、呼び出し元が REQUEST_ERROR (INVALID_FILTER) に変換する。
 *
 * @param localMaxFilterRanges - 自 endpoint が SETUP で広告した MAX_FILTER_RANGES
 *                               (未広告時は 0)
 * @throws InvalidFilterError 上限が 0 で Range Filter が含まれる、または合計が超過した場合
 */
function validateIncomingRangeFilterLimits(
  parameters: Parameter[],
  fillInnerParameters: Parameter[] | undefined,
  localMaxFilterRanges: number,
  contextName: string,
): void {
  const { hasRangeFilter, totalRanges } = countIncomingRangeFilterRanges(
    parameters,
    fillInnerParameters,
  );
  if (!hasRangeFilter) {
    return;
  }
  if (localMaxFilterRanges === 0) {
    throw new InvalidFilterError(
      `cannot receive range filters in ${contextName}: local MAX_FILTER_RANGES is 0 (not advertised)`,
    );
  }
  if (totalRanges > localMaxFilterRanges) {
    throw new InvalidFilterError(
      `range filters in ${contextName} exceed local MAX_FILTER_RANGES: total ranges ${totalRanges} > ${localMaxFilterRanges}`,
    );
  }
}

// ============================================================================
// sendRequestUpdate
// ============================================================================

/**
 * 送信時点のフィルタ状態に、in-flight の REQUEST_UPDATE (送信順) と今回の
 * update をマージした状態を返す
 *
 * draft-ietf-moq-transport-21 §9.5.1:
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
 * draft-ietf-moq-transport-21 §9.1.6:
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

/**
 * 単一の raw FILL_PARAMETERS の fill 要求を購読に関連付ける
 *
 * draft-ietf-moq-transport-21 §3.4 (Fill Semantics) / §9.20.16:
 * キーは新規採番の updateRequestId とし、型付き経路と同形にする。
 * 内側の GROUP_ORDER (uint8 値) がなければ購読の指定を継承する
 * (resolveFillGroupOrder と同規則。§9.20.16 の省略時継承)。
 * 到達値は検証ループで 0x01 / 0x02 に限定される
 * (validateGroupOrderValue による値域拒否と decodeParameters の
 * 重複検査)。0x02 は Descending、0x01 は Ascending とする。
 * 検証済みの内側配列を受け取り、throw しない。
 */
function registerRawFillFetchTarget(
  session: BidiSessionInternal,
  subscriber: SubscriberImpl,
  updateRequestId: bigint,
  inner: Parameter[],
): void {
  const innerGroupOrder = inner.find((param) => param.type === MessageParameterType.GROUP_ORDER);
  session.fillFetchTargets.set(updateRequestId, {
    subscriber,
    groupOrder: resolveFillGroupOrder(
      innerGroupOrder === undefined
        ? undefined
        : innerGroupOrder.value[0] === 0x02
          ? "Descending"
          : "Ascending",
      subscriber.getGroupOrder(),
    ),
  });
}

/**
 * raw FILL_PARAMETERS の送信前検証と合算用データの準備
 *
 * - 重複検査: draft-ietf-moq-transport-21 §9.20 / §9.20.16
 * - 内側デコード検証: §9.20.10 / §9.20.16
 * - 上限合算用の内側 Range 取り出し: §9.1.6 / §8.6
 * いずれも pendingRequestUpdate.set / fillFetchTargets.set より前で失敗させる
 * (登録後の throw はエントリ残留を生むため)。重複検査を内側検証より前に置き、
 * 二重不正入力では重複エラーを優先する。
 * デコード結果は関連付け登録で再利用する。合算用の内側 Range 取り出しは
 * decodeFillParameters がデコード済み Range を返さないため再デコードする
 * (検証済みのため throw しない前提)。
 *
 * @throws InvalidFilterError 重複時・内側不正時
 */
function prepareRawFillForUpdate(options: RequestUpdateOptions): {
  decodedRawFillInners: Parameter[][];
  rawFillInnerRanges: RangeFilterSpec[];
  mergedFillRanges: RangeFilterSpec[];
} {
  const rawFillParameters = (options.parameters ?? []).filter(
    (param) => param.type === MessageParameterType.FILL_PARAMETERS,
  );
  const mergedFillCount = rawFillParameters.length + (options.fill !== undefined ? 1 : 0);
  if (mergedFillCount >= 2) {
    throw new InvalidFilterError(
      `duplicate FILL_PARAMETERS in REQUEST_UPDATE: got ${mergedFillCount}, expected at most 1`,
    );
  }

  const decodedRawFillInners: Parameter[][] = [];
  for (const [index, rawFillParameter] of rawFillParameters.entries()) {
    try {
      decodedRawFillInners.push(decodeFillParameters(rawFillParameter));
    } catch (error) {
      throw new InvalidFilterError(
        `invalid raw FILL_PARAMETERS[${index}] in REQUEST_UPDATE: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // draft-ietf-moq-transport-21 §9.1.6:
  // raw FILL 内側の Range Filters (0x25-0x28) を上限合算用に取り出す。
  // 範囲は decodeFillParameters 側と一致させること
  // (§9.20.16 の Table 6 に Range 系の型が追加された場合は両方を更新する)。
  // 内側の除去は decodeFillParameters が拒否済みのため、ここでは数え上げのみ行う
  const rawFillInnerRanges: RangeFilterSpec[] = [];
  for (const inner of decodedRawFillInners) {
    for (const param of inner) {
      if (param.type >= 0x25 && param.type <= 0x28) {
        rawFillInnerRanges.push(decodeRangeFilter(rangeFilterTypeOf(param.type), param.value)[0]);
      }
    }
  }

  // 型付き fill 内側と raw FILL 内側の合算 (購読単位の上限・in-flight 用)
  const mergedFillRanges: RangeFilterSpec[] = [
    ...(options.fill?.rangeFilters ?? []),
    ...rawFillInnerRanges,
  ];
  return { decodedRawFillInners, rawFillInnerRanges, mergedFillRanges };
}

export async function bidiSendRequestUpdate(
  session: BidiSessionInternal,
  subscriber: SubscriberImpl,
  options: RequestUpdateOptions,
): Promise<void> {
  const targetRequestId = subscriber.getRequestId();

  // draft-ietf-moq-transport-21 §9.2:
  // GOAWAY 受信後の旧リクエストへの REQUEST_UPDATE は送信しない。
  // ガードは「弾けるケースの早期失敗」であり、ガード通過後に GOAWAY が
  // 割り込んだ競合時の掃除 (write 失敗時のエントリ削除) は後段の
  // write 失敗 catch が担う。
  if (session.goawayReceivedOnRequestStreams.has(targetRequestId)) {
    throw new Error(`cannot send REQUEST_UPDATE: request stream is being migrated`);
  }

  // draft-ietf-moq-transport-21 §9.1.7:
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

  // draft-ietf-moq-transport-21 §9.20 (Control Message Parameters):
  // 各パラメータ定義が示す出現可能メッセージに反する型を raw parameters に
  // 混入させたまま送信すると、受信側は §9.20.1 の MUST により
  // PROTOCOL_VIOLATION でセッションを閉じる。ローカル API 誤用として
  // 送信前に拒否する (例: GROUP_ORDER / EXPIRES は REQUEST_UPDATE に出現
  // できず、TRACK_NAMESPACE_PREFIX は namespace 系 REQUEST_UPDATE 専用)。
  assertParametersAllowedForSend(
    options.parameters ?? [],
    REQUEST_UPDATE_ALLOWED_PARAMS,
    "REQUEST_UPDATE",
  );

  const updateRequestId = session.nextRequestId;
  session.nextRequestId += 2n;

  // raw FILL の重複検査・内側検証・合算準備は登録より前に行う。
  const { decodedRawFillInners, rawFillInnerRanges, mergedFillRanges } =
    prepareRawFillForUpdate(options);

  // draft-ietf-moq-transport-21 §9.1.6 (MAX FILTER RANGES):
  // 「limits the peer's total number of Ranges (Start/End pairs) allowed
  //  concurrently in all Range filter Section 3.3.2 parameters for a given
  //  subscription or fetch」であり、マージ後のフィルタ状態 (§3.3.2 の
  // 削除・置換・不変規則で適用した結果) に対して検証する。§3.3.2 にも
  // 「limits the total number of Ranges allowed in all Range Filter parameters
  //  for a given subscription or fetch」とある。
  // REQUEST_UPDATE は削除 (Length=0) を含むため、削除以外の Ranges 数のみ
  // チェックする (マージ結果には remove エントリが含まれない)。
  // fill 内側の Range Filters も購読単位の上限に含める
  // (型付き fill 内側と raw FILL 内側の合算。仕様のみからは確定しないため、
  // 型付き現行実装との一貫性で合算する保守的な加算である)。
  const newOuterRanges = options.rangeFilters ?? [];
  const newFillRanges = mergedFillRanges;
  if (newOuterRanges.length > 0 || newFillRanges.length > 0) {
    // ピアの MAX_FILTER_RANGES = 0 (未広告) の場合は §9.1.6 により送信禁止。
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

  // draft-ietf-moq-transport-21 §3.3.2:
  // REQUEST_UPDATE では削除 (Length=0) が許可されるが、TRACK_PROPERTY_FILTER (0x29) は
  // SUBSCRIBE_TRACKS リクエスト自身のストリーム上のみ許可される。moqt-js が送信する
  // REQUEST_UPDATE はすべて per-subscription の更新 (§9.5) のため、0x29 は一律 throw する。
  // 組み合わせ重複も送信前に検証する (§3.3.2 の MUST)
  validateRangeFilterSpecs(options.rangeFilters, "REQUEST_UPDATE", {
    allowRemove: true,
    allowTrackProperty: false,
  });

  // draft-ietf-moq-transport-21 §9.20.10:
  // raw パラメータ経路の LOCATION_FILTER も型付き経路と同じデコード検証
  // (End Group 超過を含む) の対象にする。対象はトップレベルの
  // LOCATION_FILTER 全件とする
  // (重複自体は別途仕様違反だが、2 件目以降の検証素通りを残さない)。
  // 保持するのは options.parameters 配列順の先頭 1 件のデコード値とする
  // (受信側の find による抽出と同形)。
  // デコード失敗はローカル API 誤用として InvalidFilterError に
  // 変換する (受信側の ProtocolViolationError とは区別する)。
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

  // draft-ietf-moq-transport-21 §9.20 / §9.20.16 の重複検査と
  // §9.20.10 / §9.20.16 の内側デコード検証は、上限検証より前の配置で
  // 実行済みである (戻り値の decodedRawFillInners 等を再利用する)。

  const parameters: Parameter[] = options.parameters ? [...options.parameters] : [];

  // Range Filters (0x25–0x29) - draft-ietf-moq-transport-21 Section 3.3.2:
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

  // FILL_PARAMETERS (0x23) - draft-ietf-moq-transport-21 Section 9.20.16:
  // fill fetch ストリームを要求する。FILL_PARAMETERS は保持されないため、
  // 載せた更新にのみ適用される。
  if (options.fill !== undefined) {
    parameters.push(encodeFillParameters(buildFillParameters(options.fill, "REQUEST_UPDATE")));
  }

  // NEW_GROUP_REQUEST (0x32) - draft-ietf-moq-transport-21 Section 9.20.20 (varint)
  // draft-ietf-moq-transport-21 §9.20:
  // Senders MUST NOT repeat the same Parameter Type のため、raw と型付きの
  // 合算で 2 件以上になる重複は送信前に拒否する。重複組み合わせの先例
  // (validateRangeFilterSpecs) と同様に汎用 Error を使う。
  const rawNewGroupRequestCount = (options.parameters ?? []).filter(
    (param) => param.type === MessageParameterType.NEW_GROUP_REQUEST,
  ).length;
  const typedNewGroupRequestCount = options.newGroupRequest !== undefined ? 1 : 0;
  if (rawNewGroupRequestCount + typedNewGroupRequestCount >= 2) {
    throw new Error(
      "duplicate NEW_GROUP_REQUEST in REQUEST_UPDATE: use either newGroupRequest or raw parameters",
    );
  }
  if (options.newGroupRequest !== undefined) {
    validateNonNegative(options.newGroupRequest, "NEW_GROUP_REQUEST");
    parameters.push({
      type: MessageParameterType.NEW_GROUP_REQUEST,
      value: encodeVarint(options.newGroupRequest),
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
      // draft-ietf-moq-transport-21 §9.20.19:
      // REQUEST_OK 受信時に Forward State へ反映するため、送信時の FORWARD
      // 値を保持する (省略時は undefined = 不変)。
      forward: options.forward,
      // draft-ietf-moq-transport-21 §3.3.2:
      // REQUEST_OK 受信時に Range Filters へ反映するため、送信時の値を保持する
      // (省略時は undefined = 不変)。
      rangeFilters: options.rangeFilters,
      // draft-ietf-moq-transport-21 §9.20.10:
      // REQUEST_OK 受信時に Location Filter へ反映するため、送信時の値を保持する
      // (省略時は undefined = 不変)。
      locationFilter: sendLocationFilter,
      // draft-ietf-moq-transport-21 §9.1.6:
      // 購読単位の上限検証に fill 内側も含めるため保持する
      // (型付き fill 内側と raw FILL 内側の合算。raw なしでは従来どおり)。
      fillRangeFilters:
        rawFillInnerRanges.length === 0 ? options.fill?.rangeFilters : mergedFillRanges,
    });
  });
  // write in-flight 中に GOAWAY / REQUEST_ERROR / セッション close が
  // rejectPendingRequestUpdates を実行すると、return 前のこの promise が
  // 無観測のまま reject され unhandled rejection になる。reject は
  // return promise の adoption 経由で呼び出し元へ伝播するため、
  // ここでの catch は無観測 reject の抑制のみを担う。
  promise.catch(() => {});

  // draft-ietf-moq-transport-21 §3.4 (Fill Semantics):
  // fill を要求した更新の Request ID を購読に関連付ける。REQUEST_OK 受理で
  // pending エントリが消えても、fill ストリーム到着まで保持する (応答と fill
  // ストリームの順序は保証されない)。write 失敗時は pending と同様に削除する。
  if (options.fill !== undefined) {
    session.fillFetchTargets.set(updateRequestId, {
      subscriber,
      groupOrder: resolveFillGroupOrder(options.fill.groupOrder, subscriber.getGroupOrder()),
    });
  } else {
    // draft-ietf-moq-transport-21 §3.4 (Fill Semantics):
    // 単一の raw FILL_PARAMETERS の fill 要求も同一キーで関連付ける。
    // 複数件・型付き併用時は重複検査が先に拒否するため、
    // ここには単一のみ到達する。内側は検証済みのため再デコードしない。
    const decodedSingle = decodedRawFillInners[0];
    if (decodedSingle !== undefined) {
      registerRawFillFetchTarget(session, subscriber, updateRequestId, decodedSingle);
    }
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
    const hadPendingRequestUpdate = session.pendingRequestUpdate.delete(updateRequestId);
    session.fillFetchTargets.delete(updateRequestId);
    if (!hadPendingRequestUpdate) {
      // 解除・GOAWAY・FIN 等の競合で保留エントリが既に掃除されていた場合、
      // update() の結果は既に settle 済みの内側 Promise に委ね、送信エラーを
      // 上書きしない (原因のエラーを呼び出し元へ伝えるため)。
      return promise;
    }
    throw err;
  }

  return promise;
}

/**
 * SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS の Track Namespace Prefix 更新
 * REQUEST_UPDATE を送信する
 *
 * draft-ietf-moq-transport-21 §9.5.2 (Updating Namespace Subscriptions):
 * "A subscriber can update the Track Namespace Prefix of an established
 *  SUBSCRIBE_NAMESPACE or SUBSCRIBE_TRACKS by including the
 *  TRACK_NAMESPACE_PREFIX parameter (Section 9.20.21) in a REQUEST_UPDATE."
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
 * - 予約 namespace の送信拒否 (§2.4.2 / §6.5)
 * - §9.5.2 の per-type 独立 overlap 制約 (更新対象自身を除く)
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
  // draft-ietf-moq-transport-21 §9.2:
  // GOAWAY を受信したリクエストストリームはマイグレーション対象のため、
  // 旧リクエストへの REQUEST_UPDATE は送信しない。
  // §9.2 の SHOULD NOT 列挙は SUBSCRIBE / PUBLISH 等の新規リクエストのみだが、
  // GOAWAY 処理で送信方向が FIN (writer.close()) 済みの場合に write が失敗し
  // pendingRequestUpdate エントリがリークするため、防御的に REQUEST_UPDATE も
  // 送信しない (bidiSendRequestUpdate と同様のガード)。
  if (session.goawayReceivedOnRequestStreams.has(requestId)) {
    throw new Error(`cannot send REQUEST_UPDATE: request stream is being migrated`);
  }

  // draft-ietf-moq-transport-21 §9.1.7:
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

  // draft-ietf-moq-transport-21 §2.4.2 / §6.5: 予約 namespace / .session の送信拒否
  validateTrackNamespaceForSend(options.trackNamespacePrefix);

  // draft-ietf-moq-transport-21 §9.5.2:
  // overlap 制約は型ごとに独立して適用される。更新対象自身は比較対象から除外する
  // (prefix 拡大更新を許可するため)。
  // 受信側の MUST は PREFIX_OVERLAP 応答 (§9.20.21) であり、この検証は
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
  // draft-ietf-moq-transport-21 §9.5.2 の設計判断:
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
    // TRACK_NAMESPACE_PREFIX (0x34) - draft-ietf-moq-transport-21 Section 9.20.21
    encodeParameterTrackNamespace(createTrackNamespace(options.trackNamespacePrefix)),
  ];

  // FORWARD (0x10) - draft-ietf-moq-transport-21 Section 9.20.19:
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

  // draft-ietf-moq-transport-21 §9.20.21 / §9.20.1:
  // namespace 系 REQUEST_UPDATE に出現できる型だけであることを送信前に検証する
  // (TRACK_NAMESPACE_PREFIX は namespace 系 REQUEST_UPDATE 専用)。
  assertParametersAllowedForSend(
    parameters,
    NAMESPACE_REQUEST_UPDATE_ALLOWED_PARAMS,
    "SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS REQUEST_UPDATE",
  );

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

  // draft-ietf-moq-transport-21 §9.5 / §9.5.1:
  // unsubscribe により応答 (REQUEST_OK / REQUEST_ERROR) が届かなくなるため、
  // 保留中の REQUEST_UPDATE は失敗として reject してエントリを削除する。
  // 残すとアプリは update() の結果を待ち続ける。ストリーム破棄より前に置き、
  // subscribers / requestStreams の Map 削除より先に実行する (後続の cancel /
  // abort の成否に関わらず reject を保証する。FIN / RESET 経路と同パターン)。
  rejectPendingRequestUpdates(session, requestId, new Error(REQUEST_UPDATE_STREAM_CLOSED_MESSAGE));

  // 購読の終了に伴い fill 関連付けも不要になるため掃除する
  // (draft-ietf-moq-transport-21 §3.4.1: 購読キャンセル時は fill も終わる)。
  deleteFillTargetsForSubscriber(session, subscriber);

  const streamInfo = session.requestStreams.get(requestId);
  // 先に Map から外す。後続の cancel で読み取りループが FIN 分岐に入っても
  // notifySubscriberFailure が対象を引けず no-op になる (自前解除のため
  // error / end 通知は送らない。SubscriberImpl.unsubscribe の docstring と同じ解釈)。
  // Map 削除と cancel の間は同期的であり割り込みの余地はない。
  session.requestStreams.delete(requestId);
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

  if (streamInfo) {
    try {
      // 送信方向のリセットを先に開始する。プロトコル上の送受信の順序に
      // 意味はなく、後続の cancel で起きるループ終了処理との実装上の競合を
      // 避けるために先にする。
      // GOAWAY 受信で送信方向を FIN (writer.close()) 済みの場合、abort は
      // reject する (閉じた writer への操作)。unhandled rejection を避けるため
      // catch で握り潰す。
      void streamInfo.writer.abort("subscription cancelled").catch(() => {});
      // draft-ietf-moq-transport-21 §3.1:
      // 「The subscriber terminates a subscription ... by sending STOP_SENDING.」
      // WebTransport では readable.cancel() が STOP_SENDING 相当。
      // 読み取りループがロックを保持しているため、保持中の reader 経由で
      // cancel する (ロック中の stream.cancel() は TypeError で reject する)。
      // reader 未登録の場合は stream 経由を試みる。通常は到達しない防御的
      // フォールバックであり、失敗時は握り潰される。
      // reader.cancel() で起きた読み取りは done 解決し、ループは FIN 分岐に
      // 入るが、上記 Map 削除済みのため通知は no-op になる。
      // 両方向をリセットして subscription 解除を通知する。
      if (streamInfo.reader !== undefined) {
        await streamInfo.reader.cancel("subscription cancelled");
      } else {
        await streamInfo.stream.readable.cancel("subscription cancelled");
      }
    } catch {
      // ストリームが既に閉じている場合・ロック競合の場合は無視
    }
  }

  // draft-ietf-moq-transport-21 §6.6.1:
  // GOAWAY 受信後に Established 購読が無くなった時点で NO_ERROR で閉じる。
  session.onRequestDrained?.();
}

/**
 * malformed track の検出などで購読を error 通知付きで cancel する
 *
 * draft-ietf-moq-transport-21 §12.1:
 * "it MUST cancel any corresponding subscription or fetches for that Track
 *  from that publisher and SHOULD deliver an error to the application."
 * アプリの error コールバックへ通知してから購読を closed にし、bidi ストリームを
 * cancel する。通知は state が active のときだけ行い、二重通知を防ぐ。
 */
export async function bidiCancelSubscriptionWithError(
  session: BidiSessionInternal,
  subscriber: SubscriberImpl,
  error: Error,
): Promise<void> {
  if (subscriber.state === "active") {
    try {
      subscriber.handleError(error);
    } catch {
      // アプリの error コールバックの throw は握り潰す (キャンセルは継続する)
    }
    subscriber.markClosed();
  }
  await bidiCancelSubscription(session, subscriber);
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
      // draft-ietf-moq-transport-21 §3.2.1:
      // 「It MUST send STOP_SENDING for the bidi request stream.」
      // WebTransport では readable.cancel() が STOP_SENDING 相当。
      // 読み取りループがロックを保持している場合は保持中の reader 経由で
      // cancel する (ロック中の stream.cancel() は TypeError で reject する)。
      // 両方向をリセットして fetch 解除を通知する。
      if (streamInfo.reader !== undefined) {
        await streamInfo.reader.cancel("fetch cancelled");
      } else {
        await streamInfo.stream.readable.cancel("fetch cancelled");
      }
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
  // draft-ietf-moq-transport-21 §6.6.1:
  // GOAWAY 受信後に Established fetch が無くなった時点で NO_ERROR で閉じる。
  session.onRequestDrained?.();
}

// ============================================================================
// cancelMalformedTrackPeers
// ============================================================================

/**
 * 同一 Track の全購読と全 FETCH を malformed track として cancel する
 *
 * draft-ietf-moq-transport-21 §12.1 (Malformed Tracks):
 * 「it MUST cancel any corresponding subscription or fetches for that Track
 *  from that publisher」
 * 同一 Track の判定は Full Track Name (trackNamespace + trackName) で行う。
 * fetcher は trackAlias を持たないため Full Track Name で引く。
 * trackKey は getFullTrackName() が返す比較キー (fullTrackNameKey が生成する
 * 長さ付きキー) を渡す。区切り文字の曖昧さで別 Track を巻き込まないよう、
 * 生の Full Track Name を組み立てて渡さない。
 * セッションは閉じない。アプリの error コールバックの throw は握り潰す。
 */
export function cancelMalformedTrackPeers(
  session: BidiSessionInternal,
  trackKey: string,
  error: Error,
): void {
  // 購読は alias 索引 (subscribersByAlias) を走査する。bidiCancelSubscription
  // は同期区間で当該配列から購読を splice するため、走査前に複製して取りこぼし
  // を防ぐ。同一 alias に複数の同一 Track 購読がぶら下がり得る。
  const seen = new Set<SubscriberImpl>();
  for (const subscribers of session.subscribersByAlias.values()) {
    for (const subscriber of subscribers.slice()) {
      if (seen.has(subscriber) || subscriber.getFullTrackName() !== trackKey) {
        continue;
      }
      seen.add(subscriber);
      void bidiCancelSubscriptionWithError(session, subscriber, error);
    }
  }
  for (const fetcher of session.fetchers.values()) {
    if (fetcher.getFullTrackName() !== trackKey) {
      continue;
    }
    // 既にキャンセル開始済み (closed) なら、error 通知もストリーム後始末も
    // 1 回目で行っている。FetcherImpl.cancel は await の前に state を closed に
    // するため、bidiCancelFetch の await 中に重複した malformed 検出が届いても
    // error コールバックを二重に呼ばない (§12.1 の SHOULD は 1 回で満たす)。
    if (fetcher.state === "closed") {
      continue;
    }
    try {
      fetcher.handleError(error);
    } catch {
      // アプリの error コールバックの throw は握り潰す (キャンセルは継続する)
    }
    // キャンセルは onCancel (実運用は bidiCancelFetch) に委譲する。§3.2.1 の
    // MUST「It MUST send STOP_SENDING for the bidi request stream.」は
    // bidiCancelFetch の readable.cancel で満たされる。
    void fetcher.cancel().catch(() => {});
  }
  // 応答待ちの pending も §12.1 の対象に含める。pending には
  // bidiCancelSubscriptionWithError を使わない (SubscriberImpl.state は
  // pending 中も active のため、state ガードでは reject と error コールバックの
  // 二重通知を防げない)。Map から外してから reject し、ストリームを cancel する。
  for (const [requestId, pending] of session.pendingSubscribe) {
    if (pending.impl.getFullTrackName() !== trackKey) {
      continue;
    }
    session.pendingSubscribe.delete(requestId);
    pending.reject(error);
    pending.impl.markClosed();
    void bidiCancelSubscription(session, pending.impl).catch(() => {});
  }
  for (const [requestId, pending] of session.pendingFetch) {
    if (pending.impl.getFullTrackName() !== trackKey) {
      continue;
    }
    session.pendingFetch.delete(requestId);
    pending.reject(error);
    void bidiCancelFetch(session, pending.impl).catch(() => {});
    // FETCH_OK 先行でデータストリーム受信が待機中の場合は即座に解決する
    fireFetcherReadyCallbacks(session, requestId);
  }
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
      // draft-ietf-moq-transport-21 §13 (Grease):
      // 未知の PUBLISH_DONE コードは INTERNAL_ERROR として扱う
      const normalizedCode = normalizePublishDoneCode(Number(msg.statusCode));
      subscriber.handleEnd(BigInt(normalizedCode), msg.reasonPhrase);
      // subscriber/subscribersByAlias の削除はストリーム close 時
      // (bidiReadRequestStreamMessages の finally) に委譲する
      // draft-ietf-moq-transport-21 §3.1
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
 * draft-ietf-moq-transport-21 §9.10 (PUBLISH_STATE_NOTIFY):
 * publisher が subscription の bidi ストリーム上で送る片方向の状態通知。
 * 応答は送信しない。presence のパラメータのみ変更として subscriber 状態に
 * 反映する (省略時は不変)。
 *
 * subscribe ロール (自 subscriber の購読) のみ受理する。publish ロール
 * (対向 subscriber 発) では §9.10 の MUST に従い PROTOCOL_VIOLATION で
 * セッションを閉じる。
 *
 * 許可外パラメータは §9.20.1 の MUST に従い PROTOCOL_VIOLATION で
 * セッションを閉じる。decode の失敗は呼び出し元の受信ループの catch で
 * 変換される。
 */
export function bidiHandlePublishStateNotify(
  session: BidiSessionInternal,
  payload: Uint8Array,
  requestId: bigint,
  role: "publish" | "subscribe",
): boolean {
  // draft-ietf-moq-transport-21 §9.10:
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

  // draft-ietf-moq-transport-21 §9.20.1 (Parameter Scope)
  // 違反時はセッションを閉じ、呼び出し元は後続メッセージの処理を打ち切る。
  const scopeError = validateParameterScope(
    msg.parameters,
    PUBLISH_STATE_NOTIFY_ALLOWED_PARAMS,
    "PUBLISH_STATE_NOTIFY",
  );
  if (scopeError !== null) {
    session.closeWithError(scopeError);
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
  // §9.20.10 の値検証 (End Group 超過は PROTOCOL_VIOLATION) も兼ねる。
  // 失敗は呼び出し元の catch でセッションを閉じる。
  const locationFilter =
    locationParam !== undefined ? decodeLocationFilterParameter(locationParam) : undefined;
  const forwardParam = msg.parameters.find((param) => param.type === MessageParameterType.FORWARD);
  // draft-ietf-moq-transport-21 §9.20.19:
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

// ピアが RESET_STREAM で FETCH データストリームをエラー終了させた際のエラーメッセージ
export const RESET_FETCH_DATA_STREAM_MESSAGE = "publisher reset fetch data stream";

/**
 * ストリームリセットのエラーコード値からコード名を求める
 *
 * draft-ietf-moq-transport-21 §12.5 の名前付き列挙をメッセージ組み立てに使う。
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
 * draft-ietf-moq-transport-21 §12.5:
 * "The application SHOULD use a relevant error code when resetting or
 *  sending STOP_SENDING on any stream."
 * ピアが用いたエラーコードは読み取り失敗値の streamErrorCode
 * (W3C WebTransport の WebTransportError が source === "stream" のときのみ
 * 非 null で持つ) から取得できる。取得できた場合は正規化した値を
 * streamErrorCode プロパティに載せ、メッセージにもコード名を付加して
 * アプリが終了理由を区別できるようにする。未知値は draft-ietf-moq-transport-21
 * §13 に従い内部エラーに正規化する。
 * 取得できない場合 (未提供や型不一致) は従来の固定文言のみで通知し、
 * プロパティも付けない。 FIN 由来のエラーはコードを持たない別イベントの
 * ため本関数の対象外とする。
 */
export function createResetStreamError(rawError: unknown): Error {
  return createResetStreamErrorWithMessage(rawError, RESET_REQUEST_STREAM_MESSAGE);
}

/**
 * ピアの RESET_STREAM 由来のエラーを FETCH データストリーム用の Error に変換する
 *
 * bidi リクエストストリーム用の `createResetStreamError` と正規化・
 * メッセージ組み立てを共有し、対象が FETCH データストリームであることが
 * 分かる文言にする (§3.2.1)。
 */
export function createFetchDataStreamResetError(rawError: unknown): Error {
  return createResetStreamErrorWithMessage(rawError, RESET_FETCH_DATA_STREAM_MESSAGE);
}

/**
 * ピアの RESET_STREAM 由来のエラーを指定メッセージの Error に変換する共通実装
 */
function createResetStreamErrorWithMessage(rawError: unknown, message: string): Error {
  if (typeof rawError !== "object" || rawError === null) {
    return new Error(message);
  }
  const streamErrorCode = (rawError as { streamErrorCode?: unknown }).streamErrorCode;
  if (typeof streamErrorCode !== "number") {
    return new Error(message);
  }
  const normalized = normalizeDataStreamErrorCode(streamErrorCode);
  const name = getDataStreamErrorCodeName(normalized);
  const error = new Error(`${message}: ${name}(0x${normalized.toString(16)})`);
  (error as Error & { streamErrorCode: DataStreamErrorCode }).streamErrorCode = normalized;
  return error;
}

/**
 * ピアによる FIN (PUBLISH_DONE なし) または RESET_STREAM によるストリーム
 * エラー終了を subscriber へ通知する
 *
 * draft-ietf-moq-transport-21 §6.4.2.2 (Graceful Request Stream Closure):
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
 *   であり失敗ではない。draft-ietf-moq-transport-21 §9.2「The GOAWAY
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

  // draft-ietf-moq-transport-21 §9.20.1 (Parameter Scope):
  // 違反時は当該購読の保留分全件を違反 SessionError 自体で reject してから閉じる
  // (初期応答 4 経路 = PUBLISH / SUBSCRIBE / FETCH / TRACK_STATUS と同一パターン)。
  // 先に閉じると close 側の汎用 reject で特定エラーが上書きされるため、
  // reject と close の順序を固定する。
  const scopeError = validateParameterScope(
    msg.parameters,
    REQUEST_UPDATE_OK_ALLOWED_PARAMS,
    "REQUEST_UPDATE_OK",
  );
  if (scopeError !== null) {
    deleteFillTargetsForPendingUpdates(session, streamRequestId);
    rejectPendingRequestUpdates(session, streamRequestId, scopeError);
    session.closeWithError(scopeError);
    return;
  }

  // draft-ietf-moq-transport-21 §9.3 (REQUEST_OK):
  // Track Properties 空検証の違反も同形に扱う。削除・reject・close の順序は
  // 前ブロックと同一であり、先に閉じると汎用 reject で上書きされるため固定する。
  const trackPropertiesError = validateRequestOkNoTrackProperties(
    msg.trackProperties,
    "REQUEST_UPDATE_OK",
  );
  if (trackPropertiesError !== null) {
    deleteFillTargetsForPendingUpdates(session, streamRequestId);
    rejectPendingRequestUpdates(session, streamRequestId, trackPropertiesError);
    session.closeWithError(trackPropertiesError);
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

  // draft-ietf-moq-transport-21 §9.20.19:
  // "If the parameter is omitted from REQUEST_UPDATE, the value for the
  //  subscription remains unchanged."
  // (§9.20.10 / §3.3.2 も同趣旨の規定を持つ。文言は各反映箇所のコメントを参照。)
  // 自 update() の REQUEST_OK 受信時に、送信時の FORWARD / LOCATION_FILTER /
  // Range Filters 値 (pendingRequestUpdate エントリに保持) を反映する。
  // 省略時 (undefined) は反映しない。
  const resolved = resolvePendingRequestUpdate(session, streamRequestId);
  if (resolved !== undefined) {
    const subscriber = session.subscribers.get(streamRequestId);
    if (subscriber) {
      // draft-ietf-moq-transport-21 §9.20.10:
      // 自 update() の REQUEST_OK 受信時に、送信時の LOCATION_FILTER 値を反映する
      // (省略時は不変)。LARGEST_OBJECT 反映の後に行い、相対指定フィルタが
      // Largest 依存で解決されるようにする。
      if (resolved.locationFilter !== undefined) {
        subscriber.setLocationFilter(resolved.locationFilter);
      }
      if (resolved.forward !== undefined) {
        subscriber.setForwardState(resolved.forward);
      }
      // draft-ietf-moq-transport-21 §3.3.2:
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
 * draft-ietf-moq-transport-21 §9.5.1:
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
 * draft-ietf-moq-transport-21 §9.5.1:
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
 * draft-ietf-moq-transport-21 §3.4.1:
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
