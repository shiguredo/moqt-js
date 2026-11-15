/**
 * 受信 SUBSCRIBE_TRACKS の処理 (publisher ロール)
 *
 * draft-ietf-moq-transport-23 §3.6 (Subscribing to Tracks by Prefix):
 * subscriber から届いた SUBSCRIBE_TRACKS を検証・認可して REQUEST_OK を返し、
 * 一致する公開済み Track へ PUBLISH を返す。応答ストリームは FIN せず、
 * 同じストリームで REQUEST_UPDATE と PUBLISH_SKIPPED を受け付ける。
 *
 * このモジュールは SessionImpl の内部ビュー (IncomingSubscribeTracksSessionInternal)
 * を受け取る free function 群である。PUBLISH を受信する subscriber ロールの
 * incomingPublish.ts とは役割が逆であり、状態も別の Map
 * (incomingTracksSubscriptions) で持つ。
 *
 * draft-ietf-moq-transport-23 §6.4.2.2 (Graceful Request Stream Closure):
 * FIN は「その方向で以後メッセージを送らない」ことだけを意味し、要求の取消ではない。
 * そのため FIN では購読を維持し、RESET_STREAM / STOP_SENDING だけを取消として扱う。
 */

import {
  MessageParameterType,
  MessageType,
  decodeRangeFilter,
  decodeRequestUpdatePayload,
  decodeSubscribeTracksPayload,
  decodeTrackNamespace,
  encodeRequestOkPayload,
  isRejectedReceiveNamespace,
  rangeFilterTypeOf,
  trackNamespaceToStrings,
  validateRangeFilterCombination,
  type Parameter,
} from "../message";
import {
  NAMESPACE_REQUEST_UPDATE_ALLOWED_PARAMS,
  SUBSCRIBE_TRACKS_ALLOWED_PARAMS,
  validateParameterScope,
} from "../message/parameterScope";
import type { ControlMessage, ControlStreamReader, ControlStreamWriter } from "../controlStream";
import { InvalidFilterError, RequestErrorCode, SessionError, SessionErrorCode } from "../error";
import type { RangeFilterSpec } from "../message/parameter";
import type { IncomingTracksSubscriptionState } from "./types";
import { isPeerStreamError, toSessionCloseError } from "./errors";
import { incomingSendRequestErrorAndClose } from "./incoming";
import {
  incomingPublishProcessAuthorizationTokens,
  type IncomingPublishSessionInternal,
} from "./incomingPublish";
import {
  bidiSendRequestError,
  bidiSendRequestOk,
  closeRequestStreamWriter,
  recordIncomingRequestUpdate,
  restoreIncomingRequestUpdateCount,
  validateIncomingRangeFilterLimits,
  validateLocationAndFillParameters,
  type BidiSessionInternal,
  type DecodedLocationAndFill,
} from "./bidi";
import { publishedTracksHasMatch, publishedTracksOnSubscriptionAccepted } from "./publishedTracks";
import type { SubscribeTracksDecision } from "./publicTypes";

/**
 * 受信 SUBSCRIBE_TRACKS 処理が必要とする SessionImpl のビュー
 *
 * SessionImpl は `as unknown as IncomingSubscribeTracksSessionInternal` で渡す。
 * 受信 PUBLISH のビューを拡張し、publisher ロール固有の状態を加える。
 */
export interface IncomingSubscribeTracksSessionInternal extends IncomingPublishSessionInternal {
  /** 受信 SUBSCRIBE_TRACKS の受理状態 (publisher ロール) */
  readonly incomingTracksSubscriptions: Map<bigint, IncomingTracksSubscriptionState>;
  /**
   * 自 endpoint が SETUP で広告した MAX_REQUEST_UPDATES
   *
   * draft-ietf-moq-transport-23 §9.1.7 (MAX_REQUEST_UPDATES):
   * 0 は無制限。上限を超えた REQUEST_UPDATE でセッションを閉じる。
   */
  readonly localMaxRequestUpdates: number;
  /**
   * 自 endpoint が SETUP で広告した MAX_FILTER_RANGES
   *
   * draft-ietf-moq-transport-23 §9.1.6 (MAX_FILTER_RANGES):
   * 0 のとき Range Filter を受信できない。超過は REQUEST_ERROR (INVALID_FILTER)。
   */
  readonly localMaxFilterRanges: number;
  /** 制御メッセージのフレーミングに使う writer */
  readonly controlWriter?: ControlStreamWriter | undefined;
  /** コールバック例外の観測 (SessionImpl が持つ。テスト用の最小ビューでは省略可) */
  emitCallbackErrorDebug?(typeName: string, error: unknown): void;
}

/**
 * 受信した SUBSCRIBE_TRACKS の先頭メッセージを処理する
 *
 * 検証・認可に成功した場合は REQUEST_OK を書き、購読を登録して
 * REQUEST_UPDATE の受信ループを detached で開始する。
 *
 * draft-ietf-moq-transport-23 §3.6 (Subscribing to Tracks by Prefix):
 * 「The publisher will respond with SUBSCRIBE_TRACKS_OK or SUBSCRIBE_TRACKS_ERROR
 *  on the response half of the stream.」「If it is an error, the stream will be
 *  closed via FIN after SUBSCRIBE_TRACKS_ERROR is sent.」
 */
export async function incomingSubscribeTracksHandleFirstMessage(
  session: IncomingSubscribeTracksSessionInternal,
  stream: WebTransportBidirectionalStream,
  firstMsg: ControlMessage,
  controlReader: ControlStreamReader,
  remainingMessages: ControlMessage[],
): Promise<void> {
  if (session.sessionState !== "connected") {
    return;
  }
  session.emitDebug("recv", firstMsg.type, firstMsg.payload);

  // SUBSCRIBE_TRACKS の本文 (Request ID / Track Namespace Prefix / Parameters) を
  // デコードする。切詰め・trailing data は MALFORMED_MESSAGE で閉じる
  // (draft-ietf-moq-transport-23 §9: Message Length と本文長の不一致)。
  let decoded: ReturnType<typeof decodeSubscribeTracksPayload>;
  try {
    decoded = decodeSubscribeTracksPayload(firstMsg.payload);
  } catch (err) {
    session.closeWithError(
      toSessionCloseError(err) ??
        new SessionError(
          `invalid SUBSCRIBE_TRACKS payload: ${err instanceof Error ? err.message : String(err)}`,
          SessionErrorCode.MALFORMED_MESSAGE,
        ),
    );
    return;
  }

  // draft-ietf-moq-transport-23 §6.4.2.1 (Request ID):
  // サーバーが生成した Request ID は奇数であり、セッション内で再利用できない。
  const requestIdError = session.validateIncomingRequestId(decoded.requestId);
  if (requestIdError !== null) {
    session.closeWithError(requestIdError);
    return;
  }

  // draft-ietf-moq-transport-23 §9.19.1 (Parameter Scope):
  // §9.17 の一覧に無い parameter はセッションを INVALID_PARAMETER で閉じる (MUST)。
  // REQUEST_ERROR では返さない (INVALID_PARAMETER は Session Termination Code)。
  const scopeError = validateParameterScope(
    decoded.parameters,
    SUBSCRIBE_TRACKS_ALLOWED_PARAMS,
    "SUBSCRIBE_TRACKS",
  );
  if (scopeError !== null) {
    session.closeWithError(scopeError);
    return;
  }

  // draft-ietf-moq-transport-23 §8.9 / §9.19.2:
  // 受信 AUTHORIZATION_TOKEN の REGISTER / USE_ALIAS を処理する。§8.9 の MUST は
  // 「セッションエラーにならない限り REGISTER した Alias をキャッシュへ登録する」
  // であるため、セッションエラーにならない拒否 (INVALID_FILTER による
  // REQUEST_ERROR 等) より前に処理する。既存の受信 PUBLISH
  // (incomingPublishDecodeAndValidate) と同じ順序である。
  if (!incomingPublishProcessAuthorizationTokens(session, decoded.requestId, decoded.parameters)) {
    return;
  }

  // 初期 parameter (PAUSED / LOCATION_FILTER / FILL_PARAMETERS / Range Filters) を
  // 検証して PAUSED と Range Filters を解釈する。PAUSED の値域違反はセッションを
  // INVALID_PARAMETER で閉じる (§9.19.18)。Range Filter の不正は
  // REQUEST_ERROR (INVALID_FILTER) で拒否する (§3.3.2 / §9.1.6)。
  // LOCATION_FILTER / FILL_PARAMETERS 内側の値違反は、既存の REQUEST_UPDATE 受信
  // 経路と同じく parameter 自身のコード (DELTA_ENCODING_OVERFLOW /
  // INVALID_PARAMETER / MALFORMED_MESSAGE) でセッションを閉じる
  // (§9.19.9 / §9.19.15 / §9.19.1)。
  let initialState: IncomingSubscribeTracksInitialState;
  try {
    initialState = incomingSubscribeTracksDecodeInitialState(session, decoded.parameters);
  } catch (err) {
    if (err instanceof InvalidFilterError) {
      await incomingSendRequestErrorAndClose(
        stream,
        RequestErrorCode.INVALID_FILTER,
        err.message,
        session.peerMaxControlMessageSize,
      );
      return;
    }
    return;
  }

  const trackNamespacePrefix = trackNamespaceToStrings(decoded.trackNamespacePrefix);

  // draft-ietf-moq-transport-23 §2.4.3 (Reserved Namespaces) / §6.5:
  // 予約 namespace の要求は DOES_NOT_EXIST で拒否する。0 フィールドの prefix は
  // 全 Track 購読であり、予約 namespace ではない (拒否しない)。
  if (isRejectedReceiveNamespace(decoded.trackNamespacePrefix.tuple)) {
    await incomingSendRequestErrorAndClose(
      stream,
      RequestErrorCode.DOES_NOT_EXIST,
      "request references reserved namespace",
      session.peerMaxControlMessageSize,
    );
    return;
  }

  // draft-ietf-moq-transport-23 §3.6 (Subscribing to Tracks by Prefix):
  // "The publisher MUST ensure the subscriber is authorized to perform this
  //  namespace subscription." 認可の判断はコールバックへ委ねる。
  const decision = await incomingSubscribeTracksDecideAuthorization(
    session,
    decoded.requestId,
    trackNamespacePrefix,
    decoded.parameters,
  );
  if (!decision.accept) {
    await incomingSendRequestErrorAndClose(
      stream,
      decision.errorCode ?? RequestErrorCode.UNAUTHORIZED,
      decision.reasonPhrase ?? "subscribe tracks was rejected",
      session.peerMaxControlMessageSize,
    );
    return;
  }

  // 応答方向の writer を取得する。REQUEST_OK の書き込みに失敗した購読は登録しない。
  if (session.controlWriter === undefined) {
    // 制御ストリームが無いセッションでは応答を書けないため登録しない
    return;
  }
  const controlWriter = session.controlWriter;
  const writer = stream.writable.getWriter();
  try {
    const okPayload = encodeRequestOkPayload({
      type: MessageType.REQUEST_OK,
      parameters: [],
      trackProperties: [],
    });
    await writer.write(controlWriter.encode(MessageType.REQUEST_OK, okPayload));
    session.emitDebug("send", MessageType.REQUEST_OK, okPayload);
  } catch {
    try {
      writer.releaseLock();
    } catch {
      // 既に閉じている場合は無視する
    }
    return;
  }

  const reader = stream.readable.getReader();
  const subscription: IncomingTracksSubscriptionState = {
    requestId: decoded.requestId,
    state: "active",
    namespacePrefix: trackNamespacePrefix,
    writer,
    controlReader,
    parameters: decoded.parameters,
    paused: initialState.paused,
    rangeFilters: initialState.rangeFilters,
    publishedTracks: new Set(),
    publishSkipped: new Set(),
  };
  session.incomingTracksSubscriptions.set(decoded.requestId, subscription);
  session.requestStreams.set(decoded.requestId, {
    stream,
    writer,
    controlReader,
    reader,
  });

  // 受理済みの要求に対して、一致する公開済み Track へ PUBLISH を送る。
  // 結果 PUBLISH を送れない Track は PUBLISH_SKIPPED になる
  // (draft-ietf-moq-transport-23 §3.6.3 (Skipped Tracks))。
  publishedTracksOnSubscriptionAccepted(session as unknown as BidiSessionInternal, subscription);

  // REQUEST_UPDATE の受信ループを detached で開始する。購読の受理応答は既に
  // 書いてあるため、呼び出し元 (受信ストリームハンドラ) を待たせない。
  void incomingSubscribeTracksRunLoop(session, subscription, remainingMessages);
}

/** SUBSCRIBE_TRACKS の初期 parameter から求めた購読状態 */
interface IncomingSubscribeTracksInitialState {
  paused: boolean;
  rangeFilters: RangeFilterSpec[];
}

/**
 * 初期 parameter から PAUSED と Range Filters を解釈し、parameter を検証する
 *
 * draft-ietf-moq-transport-23 §3.3.2 (Range Filters) / §9.19.9 (LOCATION FILTER) /
 * §9.19.15 (FILL PARAMETERS) / §9.1.6 (MAX FILTER RANGES):
 * - 同一 (Parameter Type, SetID, Property Type) の Range Filter の重複は
 *   REQUEST_ERROR (INVALID_FILTER)
 * - LOCATION_FILTER の StartGroup + EndGroupDelta の超過は DELTA_ENCODING_OVERFLOW
 * - FILL_PARAMETERS 内側の一覧外 parameter / 値違反は parameter 自身のコード
 * - 自 endpoint の MAX_FILTER_RANGES の超過は REQUEST_ERROR (INVALID_FILTER)
 * fill 内側の Range Filter も購読単位の上限合計に含める。
 *
 * 既存の REQUEST_UPDATE 受信経路 (src/session/bidi.ts の
 * bidiHandlePublishRequestUpdate / bidiReadRequestStreamMessages) と同じ検証を、
 * 受信 SUBSCRIBE_TRACKS の受理前にも通す。
 *
 * @throws InvalidFilterError Range Filter の形式・上限違反 (REQUEST_ERROR で拒否)
 * @throws SessionError セッション終了になる違反 (既に closeWithError 済み)
 */
function incomingSubscribeTracksDecodeInitialState(
  session: IncomingSubscribeTracksSessionInternal,
  parameters: Parameter[],
): IncomingSubscribeTracksInitialState {
  const pausedParameter = parameters.find(
    (candidate) => candidate.type === MessageParameterType.PAUSED,
  );
  let paused = false;
  if (pausedParameter !== undefined) {
    // draft-ietf-moq-transport-23 §9.19.18 (PAUSED Parameter):
    // uint8 であり、0 / 1 以外を受けたらセッションを INVALID_PARAMETER で閉じる。
    if (pausedParameter.value.length !== 1) {
      session.closeWithError(
        new SessionError(
          `invalid PAUSED in SUBSCRIBE_TRACKS: expected 1 byte, got ${pausedParameter.value.length}`,
          SessionErrorCode.INVALID_PARAMETER,
        ),
      );
      throw new SessionError("invalid PAUSED", SessionErrorCode.INVALID_PARAMETER);
    }
    const value = pausedParameter.value[0];
    if (value !== 0 && value !== 1) {
      session.closeWithError(
        new SessionError(
          `invalid PAUSED in SUBSCRIBE_TRACKS: ${value}, expected 0 or 1`,
          SessionErrorCode.INVALID_PARAMETER,
        ),
      );
      throw new SessionError("invalid PAUSED", SessionErrorCode.INVALID_PARAMETER);
    }
    paused = value === 1;
  }

  // Range Filter / LOCATION_FILTER / FILL_PARAMETERS の検証。
  // LOCATION_FILTER と FILL_PARAMETERS の内側は、既存の REQUEST_UPDATE 受信経路と
  // 同じく validateLocationAndFillParameters でデコードし、fill 内側の Range Filter を
  // MAX_FILTER_RANGES の合計へ渡す (§9.1.6 / §9.19.15)。
  let decodedFill: DecodedLocationAndFill;
  try {
    validateRangeFilterCombination(parameters);
    decodedFill = validateLocationAndFillParameters(parameters);
    validateIncomingRangeFilterLimits(
      parameters,
      decodedFill.fillInnerParameters,
      session.localMaxFilterRanges,
      "SUBSCRIBE_TRACKS",
    );
  } catch (err) {
    if (err instanceof InvalidFilterError) {
      throw err;
    }
    // LOCATION_FILTER の EndGroup 超過 (DELTA_ENCODING_OVERFLOW)、
    // FILL_PARAMETERS 内側の一覧外 parameter (INVALID_PARAMETER)、
    // parameter 値の長さ不整合 (MALFORMED_MESSAGE) はセッションを閉じる。
    const sessionError =
      toSessionCloseError(err) ??
      new SessionError(
        `invalid parameter in SUBSCRIBE_TRACKS: ${err instanceof Error ? err.message : String(err)}`,
        SessionErrorCode.MALFORMED_MESSAGE,
      );
    session.closeWithError(sessionError);
    throw sessionError;
  }

  const rangeFilters: RangeFilterSpec[] = [];
  for (const parameter of parameters) {
    if (parameter.type < 0x25 || parameter.type > 0x29) {
      continue;
    }
    const [spec, consumed] = decodeRangeFilter(rangeFilterTypeOf(parameter.type), parameter.value);
    if (consumed !== parameter.value.length) {
      throw new InvalidFilterError(
        `trailing data in Range Filter 0x${parameter.type.toString(16)}`,
      );
    }
    rangeFilters.push(spec);
  }
  return { paused, rangeFilters };
}

/**
 * 受信 SUBSCRIBE_TRACKS の認可判定
 *
 * draft-ietf-moq-transport-23 §3.6:
 * "The publisher MUST ensure the subscriber is authorized to perform this
 *  namespace subscription."
 * ConnectCallbacks.authorizeSubscribeTracks があればそれを使う。無い場合は
 * prefix が active な PUBLISH_NAMESPACE または公開済み Track に一致するときだけ
 * 受理し、一致しなければ DOES_NOT_EXIST で拒否する。
 */
async function incomingSubscribeTracksDecideAuthorization(
  session: IncomingSubscribeTracksSessionInternal,
  requestId: bigint,
  trackNamespacePrefix: string[],
  parameters: Parameter[],
): Promise<SubscribeTracksDecision> {
  const handler = session.callbacks.authorizeSubscribeTracks;
  if (handler === undefined) {
    return publishedTracksHasMatch(session as unknown as BidiSessionInternal, trackNamespacePrefix)
      ? { accept: true }
      : { accept: false, errorCode: RequestErrorCode.DOES_NOT_EXIST };
  }
  try {
    return await handler({ requestId, trackNamespacePrefix, parameters });
  } catch (err) {
    session.emitCallbackErrorDebug?.("authorizeSubscribeTracks", err);
    return {
      accept: false,
      errorCode: RequestErrorCode.INTERNAL_ERROR,
      reasonPhrase: "authorizeSubscribeTracks threw an error",
    };
  }
}

/**
 * 受信ストリームの後続メッセージを読むループ
 *
 * draft-ietf-moq-transport-23 §9.5 (REQUEST_UPDATE):
 * SUBSCRIBE_TRACKS の REQUEST_UPDATE は同じ双方向ストリームで届く。
 * FIN では購読を維持し、RESET_STREAM だけを取消として扱う (§6.4.2.2 / §6.4.2.3)。
 */
async function incomingSubscribeTracksRunLoop(
  session: IncomingSubscribeTracksSessionInternal,
  subscription: IncomingTracksSubscriptionState,
  initialMessages: ControlMessage[],
): Promise<void> {
  const streamInfo = session.requestStreams.get(subscription.requestId);
  if (streamInfo === undefined || streamInfo.reader === undefined) {
    return;
  }
  const reader = streamInfo.reader;

  // draft-ietf-moq-transport-23 §6.4.2.3 (Request Cancellation and Rejection):
  // ピアは取消を受信方向への STOP_SENDING で行う。STOP_SENDING を受けると当方の
  // 送信方向 (writer) が reset され、writer.closed が reject する。reader.read()
  // では検出できないため、送信方向の終了を監視して購読を削除する。
  // セッション終了やローカル abort ではなく、ピア起因 (source: "stream") の終了だけを
  // 取消として扱う。既存の publish ロール (bidi.ts の handlePublishPeerCancel) と
  // 同じ作りである。
  void subscription.writer.closed.catch((error: unknown) => {
    if (isPeerStreamError(error)) {
      incomingSubscribeTracksCancel(session, subscription.requestId);
    }
  });

  // 先頭チャンクに連結されていた後続メッセージを、最初の read より前に処理する
  if (initialMessages.length > 0) {
    if (!(await incomingSubscribeTracksProcessMessages(session, subscription, initialMessages))) {
      return;
    }
  }

  try {
    while (session.sessionState === "connected" && subscription.state === "active") {
      const { value, done } = await reader.read();
      if (done) {
        // draft-ietf-moq-transport-23 §6.4.2.2: FIN は取消ではない。
        // REQUEST_UPDATE を待たない意思表示として読み取りループだけを終える。
        return;
      }
      const messages = subscription.controlReader.feed(value);
      if (messages.length === 0) {
        continue;
      }
      if (!(await incomingSubscribeTracksProcessMessages(session, subscription, messages))) {
        return;
      }
    }
  } catch (err) {
    // draft-ietf-moq-transport-23 §6.4.2.3:
    // ピアの RESET_STREAM (readable の source: "stream" の失敗) は取消であり、
    // 通常の購読終了操作である。購読を削除するだけで、セッションエラーとして
    // notifyErrorIfActive を呼ばない (セッションは閉じない)。
    if (session.sessionState !== "connected") {
      // セッション終了は lifecycle が後始末する
      return;
    }
    if (isPeerStreamError(err)) {
      incomingSubscribeTracksCancel(session, subscription.requestId);
      return;
    }
    // 制御メッセージの長さ超過などの解析失敗は、既存の受信ループと同じく
    // parameter 自身のコードでセッションを閉じる (draft-ietf-moq-transport-23 §9 / §12.2)。
    const sessionError = toSessionCloseError(err);
    if (sessionError !== null) {
      session.closeWithError(sessionError);
      return;
    }
    // 想定外の内部エラーは購読を残さず、アプリへ通知する
    incomingSubscribeTracksCancel(session, subscription.requestId);
    session.notifyErrorIfActive(err instanceof Error ? err : new Error(String(err)));
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 既に解放済みの場合は無視する
    }
  }
}

/**
 * 1 チャンク分のメッセージ列を処理する
 *
 * @returns 購読を維持して読み取りを続ける場合は true、終了する場合は false
 */
async function incomingSubscribeTracksProcessMessages(
  session: IncomingSubscribeTracksSessionInternal,
  subscription: IncomingTracksSubscriptionState,
  messages: ControlMessage[],
): Promise<boolean> {
  // draft-ietf-moq-transport-23 §9.1.7 (MAX_REQUEST_UPDATES):
  // 未応答数は 1 回の read で得たメッセージ列の処理を終えた時点で戻す。
  const before = session.receivedRequestUpdateCounts.get(subscription.requestId) ?? 0;
  try {
    for (const message of messages) {
      if (message.type === MessageType.GOAWAY) {
        // draft-ietf-moq-transport-23 §9.2 (GOAWAY):
        // 「Only the receiver of a request can send GOAWAY on its request stream.
        //  If the receiver of a request receives a GOAWAY on that request stream,
        //  it MUST close the session with a PROTOCOL_VIOLATION.」
        // 受信 SUBSCRIBE_TRACKS では自側が要求の受信者であるため、このストリームの
        // GOAWAY は移行要求として受理せずセッションを閉じる。
        session.closeWithError(
          new SessionError(
            "received goaway on a request stream where this endpoint is the request receiver",
            SessionErrorCode.PROTOCOL_VIOLATION,
          ),
        );
        return false;
      }
      if (message.type !== MessageType.REQUEST_UPDATE) {
        // 応答方向で受け付けるのは REQUEST_UPDATE だけである
        // (draft-ietf-moq-transport-23 §9.5)。それ以外は UNEXPECTED_MESSAGE。
        session.closeWithError(
          new SessionError(
            `expected REQUEST_UPDATE on SUBSCRIBE_TRACKS request stream, got 0x${message.type.toString(16)}`,
            SessionErrorCode.UNEXPECTED_MESSAGE,
          ),
        );
        return false;
      }
      if (!(await incomingSubscribeTracksHandleRequestUpdate(session, subscription, message))) {
        return false;
      }
    }
    return subscription.state === "active";
  } finally {
    restoreIncomingRequestUpdateCount(
      session as unknown as BidiSessionInternal,
      subscription.requestId,
      before,
    );
  }
}

/**
 * REQUEST_UPDATE を 1 通処理する
 *
 * draft-ietf-moq-transport-23 §9.5 (REQUEST_UPDATE):
 * 許可 parameter は AUTHORIZATION_TOKEN / PAUSED / TRACK_PROPERTY_FILTER /
 * TRACK_NAMESPACE_PREFIX。失敗したら REQUEST_UPDATE_ERROR を返した後に
 * bidi ストリームを閉じる (MUST)。
 *
 * @returns 購読を維持する場合は true、閉じる場合は false
 */
async function incomingSubscribeTracksHandleRequestUpdate(
  session: IncomingSubscribeTracksSessionInternal,
  subscription: IncomingTracksSubscriptionState,
  message: ControlMessage,
): Promise<boolean> {
  session.emitDebug("recv", message.type, message.payload);

  // draft-ietf-moq-transport-23 §9.1.7 (MAX_REQUEST_UPDATES):
  // 上限に達した状態でさらに受信したら TOO_MANY_REQUEST_UPDATES で閉じる (MUST)。
  const limitError = recordIncomingRequestUpdate(
    session as unknown as BidiSessionInternal,
    subscription.requestId,
  );
  if (limitError !== null) {
    session.closeWithError(limitError);
    return false;
  }

  let decoded: ReturnType<typeof decodeRequestUpdatePayload>;
  try {
    decoded = decodeRequestUpdatePayload(message.payload);
  } catch (err) {
    session.closeWithError(
      toSessionCloseError(err) ??
        new SessionError(
          `invalid REQUEST_UPDATE payload: ${err instanceof Error ? err.message : String(err)}`,
          SessionErrorCode.MALFORMED_MESSAGE,
        ),
    );
    return false;
  }

  // draft-ietf-moq-transport-23 §6.4.2.1 (Request ID):
  // REQUEST_UPDATE も Request ID を消費する。
  const requestIdError = session.validateIncomingRequestId(decoded.requestId);
  if (requestIdError !== null) {
    session.closeWithError(requestIdError);
    return false;
  }

  // draft-ietf-moq-transport-23 §9.19.1 (Parameter Scope):
  // SUBSCRIBE_TRACKS 向けの REQUEST_UPDATE 許可一覧に無い parameter は
  // セッションを INVALID_PARAMETER で閉じる (MUST)。
  const scopeError = validateParameterScope(
    decoded.parameters,
    NAMESPACE_REQUEST_UPDATE_ALLOWED_PARAMS,
    "SUBSCRIBE_TRACKS REQUEST_UPDATE",
  );
  if (scopeError !== null) {
    session.closeWithError(scopeError);
    return false;
  }

  // draft-ietf-moq-transport-23 §3.3.2 (Range Filters) / §9.1.6 (MAX FILTER RANGES):
  // 更新 parameter 集合に含まれる Range Filter の組み合わせ重複と、自 endpoint が
  // 広告した MAX_FILTER_RANGES の上限を検証する。違反は REQUEST_ERROR
  // (INVALID_FILTER) を返して bidi ストリームを閉じる (§9.5)。
  // 検証は状態変更より前に行い、拒否した更新を購読状態へ反映しない。
  try {
    validateRangeFilterCombination(decoded.parameters);
    validateIncomingRangeFilterLimits(
      decoded.parameters,
      undefined,
      session.localMaxFilterRanges,
      "SUBSCRIBE_TRACKS REQUEST_UPDATE",
    );
  } catch (err) {
    if (err instanceof InvalidFilterError) {
      await bidiSendRequestError(
        session as unknown as BidiSessionInternal,
        subscription.requestId,
        RequestErrorCode.INVALID_FILTER,
        err.message,
      );
      await incomingSubscribeTracksClose(session, subscription);
      return false;
    }
    const sessionError =
      toSessionCloseError(err) ??
      new SessionError(
        `invalid Range Filter in SUBSCRIBE_TRACKS REQUEST_UPDATE: ${err instanceof Error ? err.message : String(err)}`,
        SessionErrorCode.MALFORMED_MESSAGE,
      );
    session.closeWithError(sessionError);
    return false;
  }

  // 更新の適用。失敗したら REQUEST_UPDATE_ERROR を返して bidi ストリームを閉じる。
  const applyResult = await incomingSubscribeTracksApplyRequestUpdate(
    session,
    subscription,
    decoded.parameters,
  );
  if (applyResult.kind === "closed") {
    return false;
  }
  if (applyResult.kind === "error") {
    await bidiSendRequestError(
      session as unknown as BidiSessionInternal,
      subscription.requestId,
      applyResult.errorCode,
      applyResult.reasonPhrase,
    );
    await incomingSubscribeTracksClose(session, subscription);
    return false;
  }

  await bidiSendRequestOk(session as unknown as BidiSessionInternal, subscription.requestId);
  return true;
}

/** REQUEST_UPDATE の適用結果 */
type IncomingSubscribeTracksApplyResult =
  | { kind: "ok" }
  | { kind: "error"; errorCode: RequestErrorCode; reasonPhrase: string }
  | { kind: "closed" };

/**
 * REQUEST_UPDATE の内容を状態へ適用する
 *
 * 値域違反などセッション終了になるものは closeWithError して kind: "closed" を
 * 返す。REQUEST_ERROR で返せるものは kind: "error" を返す。
 */
async function incomingSubscribeTracksApplyRequestUpdate(
  session: IncomingSubscribeTracksSessionInternal,
  subscription: IncomingTracksSubscriptionState,
  parameters: Parameter[],
): Promise<IncomingSubscribeTracksApplyResult> {
  // PAUSED (0x11) は uint8。0 / 1 以外はセッションを INVALID_PARAMETER で閉じる
  // (draft-ietf-moq-transport-23 §9.19.18)。
  const pausedParameter = parameters.find(
    (candidate) => candidate.type === MessageParameterType.PAUSED,
  );
  if (pausedParameter !== undefined) {
    if (pausedParameter.value.length !== 1) {
      session.closeWithError(
        new SessionError(
          `invalid PAUSED in SUBSCRIBE_TRACKS REQUEST_UPDATE: expected 1 byte, got ${pausedParameter.value.length}`,
          SessionErrorCode.INVALID_PARAMETER,
        ),
      );
      return { kind: "closed" };
    }
    const value = pausedParameter.value[0];
    if (value !== 0 && value !== 1) {
      session.closeWithError(
        new SessionError(
          `invalid PAUSED in SUBSCRIBE_TRACKS REQUEST_UPDATE: ${value}, expected 0 or 1`,
          SessionErrorCode.INVALID_PARAMETER,
        ),
      );
      return { kind: "closed" };
    }
    // draft-ietf-moq-transport-23 §9.19.18: SUBSCRIBE_TRACKS の REQUEST_UPDATE の
    // PAUSED は今後の一致購読にだけ適用し、既存の購読は変更しない。
    subscription.paused = value === 1;
    // 今後の結果 PUBLISH に載せる PAUSED を更新する
    subscription.parameters = [
      ...subscription.parameters.filter(
        (candidate) => candidate.type !== MessageParameterType.PAUSED,
      ),
      { type: MessageParameterType.PAUSED, value: new Uint8Array([value]) },
    ];
  }

  // TRACK_NAMESPACE_PREFIX (0x34): prefix を差し替える。既存の PUBLISH 購読には
  // 影響せず、今後の一致判定だけに使う (draft-ietf-moq-transport-23 §9.5.2)。
  const prefixParameter = parameters.find(
    (candidate) => candidate.type === MessageParameterType.TRACK_NAMESPACE_PREFIX,
  );
  if (prefixParameter !== undefined) {
    try {
      const [namespace, consumed] = decodeTrackNamespace(prefixParameter.value, 0);
      if (consumed !== prefixParameter.value.length) {
        throw new SessionError(
          "trailing data in TRACK_NAMESPACE_PREFIX parameter",
          SessionErrorCode.INVALID_PARAMETER,
        );
      }
      // draft-ietf-moq-transport-23 §2.4.3 (Reserved Namespaces) / §6.5:
      // 更新後の prefix が予約 namespace (.session 等) なら、初期要求と同じく
      // REQUEST_UPDATE_ERROR (DOES_NOT_EXIST) で拒否し、応答ストリームを閉じる。
      if (isRejectedReceiveNamespace(namespace.tuple)) {
        return {
          kind: "error",
          errorCode: RequestErrorCode.DOES_NOT_EXIST,
          reasonPhrase: "request updates to a reserved namespace",
        };
      }
      subscription.namespacePrefix = trackNamespaceToStrings(namespace);
    } catch (err) {
      // デコード不能な prefix は parameter の形式違反であり、セッションを閉じる
      // (§9.19.1 の INVALID_PARAMETER)。
      session.closeWithError(
        toSessionCloseError(err) ??
          new SessionError(
            `invalid TRACK_NAMESPACE_PREFIX in SUBSCRIBE_TRACKS REQUEST_UPDATE: ${err instanceof Error ? err.message : String(err)}`,
            SessionErrorCode.INVALID_PARAMETER,
          ),
      );
      return { kind: "closed" };
    }
  }

  // draft-ietf-moq-transport-23 §3.3.2 (Range Filters):
  // TRACK_PROPERTY_FILTER (0x29) は同一メッセージに複数回現れる (SetID / Property
  // Type ごとに 1 件)。REQUEST_UPDATE では Length 0 が削除、非 0 が全置換である。
  // 先頭 1 件だけを処理すると、複数 SetID / Property Type の更新で古い条件が残る
  // ため、更新に含まれる 0x29 を全件収集し、TRACK_PROPERTY_FILTER の集合を
  // まとめて置き換える。今後の一致判定にだけ使う。
  const trackPropertyFilterParameters = parameters.filter(
    (candidate) => candidate.type === MessageParameterType.TRACK_PROPERTY_FILTER,
  );
  if (trackPropertyFilterParameters.length > 0) {
    const replacementFilters: RangeFilterSpec[] = [];
    for (const trackPropertyFilter of trackPropertyFilterParameters) {
      // 更新 parameter 集合の検証 (incomingSubscribeTracksHandleRequestUpdate) で
      // 形式・重複・上限を検証済みのため、ここでのデコードは失敗しない。
      const [spec, consumed] = decodeRangeFilter("trackProperty", trackPropertyFilter.value);
      if (consumed !== trackPropertyFilter.value.length) {
        return {
          kind: "error",
          errorCode: RequestErrorCode.INVALID_FILTER,
          reasonPhrase: "trailing data in TRACK_PROPERTY_FILTER parameter",
        };
      }
      if (!("remove" in spec)) {
        replacementFilters.push(spec);
      }
    }
    const others = subscription.rangeFilters.filter(
      (candidate) => candidate.type !== "trackProperty",
    );
    // 非 0 の 0x29 が 1 件以上あれば全置換、すべて Length 0 なら削除する。
    subscription.rangeFilters = [...others, ...replacementFilters];
  }

  // AUTHORIZATION_TOKEN (0x03): 再認可にだけ使い、結果 PUBLISH には載せない
  // (draft-ietf-moq-transport-23 §9.19.2 MUST NOT)。
  if (parameters.some((candidate) => candidate.type === MessageParameterType.AUTHORIZATION_TOKEN)) {
    if (!incomingPublishProcessAuthorizationTokens(session, subscription.requestId, parameters)) {
      return { kind: "closed" };
    }
    const decision = await incomingSubscribeTracksDecideAuthorization(
      session,
      subscription.requestId,
      subscription.namespacePrefix,
      parameters,
    );
    if (!decision.accept) {
      return {
        kind: "error",
        errorCode: decision.errorCode ?? RequestErrorCode.UNAUTHORIZED,
        reasonPhrase: decision.reasonPhrase ?? "authorization token was rejected",
      };
    }
  }

  return { kind: "ok" };
}

/**
 * 購読を閉じる (REQUEST_UPDATE 失敗時)
 *
 * draft-ietf-moq-transport-23 §9.5 (REQUEST_UPDATE):
 * SUBSCRIBE_TRACKS の REQUEST_UPDATE が失敗した場合、responder は bidi ストリームを
 * 閉じる (MUST)。既に PUBLISH した購読は終了しない。
 */
async function incomingSubscribeTracksClose(
  session: IncomingSubscribeTracksSessionInternal,
  subscription: IncomingTracksSubscriptionState,
): Promise<void> {
  subscription.state = "closed";
  await closeRequestStreamWriter(session as unknown as BidiSessionInternal, subscription.requestId);
  session.incomingTracksSubscriptions.delete(subscription.requestId);
  session.requestStreams.delete(subscription.requestId);
}

/**
 * 購読を取り消す (RESET_STREAM / STOP_SENDING)
 *
 * draft-ietf-moq-transport-23 §3.6 / §6.4.2.3:
 * 取消は既存の PUBLISH 購読に影響しない。以後の新しい PUBLISH だけを止める。
 * 応答方向の writer を abort し (RESET_STREAM 相当)、購読状態と requestStreams の
 * エントリを削除する。既存の publish ロール (bidi.ts の handlePublishPeerCancel) と
 * 同じく、ピア起因の取消では PUBLISH_DONE 等の終了通知を送らない。
 */
function incomingSubscribeTracksCancel(
  session: IncomingSubscribeTracksSessionInternal,
  requestId: bigint,
): void {
  const subscription = session.incomingTracksSubscriptions.get(requestId);
  const streamInfo = session.requestStreams.get(requestId);
  const writer = subscription?.writer ?? streamInfo?.writer;
  if (subscription !== undefined) {
    subscription.state = "closed";
    session.incomingTracksSubscriptions.delete(requestId);
  }
  session.requestStreams.delete(requestId);
  if (writer !== undefined) {
    try {
      void writer.abort("peer cancelled subscribe tracks").catch(() => {});
    } catch {
      // 既に閉じている場合は無視する
    }
  }
}
