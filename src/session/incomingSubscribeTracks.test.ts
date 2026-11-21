/**
 * session/incomingSubscribeTracks.ts の受信 SUBSCRIBE_TRACKS 処理のテスト
 *
 * セッションは実 SessionImpl を使い、Request ID の検証・記録、購読状態の登録、
 * closeWithError の後始末は本番の実装が持つものをそのまま観測する。
 * 実 W3C ストリーム (`ReadableStream` + `WritableStream`) を
 * `as unknown as WebTransportBidirectionalStream` で注入する方式は
 * session/incoming.test.ts と同型である。
 */

import { test, assert } from "vite-plus/test";
import {
  MessageParameterType,
  MessageType,
  createTrackNamespace,
  encodeFillParameters,
  encodeParameters,
  encodeRangeFilter,
  encodeSubscribeTracksPayload,
  encodeRequestUpdatePayload,
  encodeTrackNamespace,
  type Parameter,
} from "../message";
import { ControlStreamReader, ControlStreamWriter } from "../controlStream";
import { InvalidFilterError, RequestErrorCode, SessionError, SessionErrorCode } from "../error";
import {
  buildOverflowingLocationFilterParameter,
  createTestBidirectionalStream,
  createTestSessionInternal,
  waitForCondition,
} from "../testSupport/bidi";
import { concatUint8Arrays } from "../testSupport/helpers";
import { decodeRequestErrorPayload, decodeRequestOkPayload } from "../message/session";
import { encodeVarint } from "../varint";
import type { SessionImpl } from "../session";
import type { ConnectCallbacks } from "./publicTypes";
import {
  incomingSubscribeTracksHandleFirstMessage,
  type IncomingSubscribeTracksSessionInternal,
} from "./incomingSubscribeTracks";
import { incomingPublishHandleBidirectionalStream } from "./incomingPublish";

/**
 * 受信 SUBSCRIBE_TRACKS のテストコンテキストを構築する
 *
 * closeWithError は ConnectCallbacks.error で観測する (SessionError 以外は
 * closeWithError 由来ではないため記録しない)。
 */
function createSubscribeTracksTestContext(callbacks: ConnectCallbacks = {}): {
  session: IncomingSubscribeTracksSessionInternal;
  impl: SessionImpl;
  stream: ReturnType<typeof createTestBidirectionalStream>;
  controlReader: ControlStreamReader;
  closed: { error?: SessionError };
  /** error コールバックへ届いた全エラー (notifyErrorIfActive の観測用) */
  errors: Error[];
  writtenMessages: () => Array<{ type: number; payload: Uint8Array }>;
} {
  const closed: { error?: SessionError } = {};
  const errors: Error[] = [];
  const { impl } = createTestSessionInternal({
    ...callbacks,
    error(error) {
      errors.push(error);
      if (error instanceof SessionError) {
        closed.error = error;
      }
      callbacks.error?.(error);
    },
  });
  const stream = createTestBidirectionalStream();
  return {
    session: impl as unknown as IncomingSubscribeTracksSessionInternal,
    impl,
    stream,
    controlReader: new ControlStreamReader(),
    closed,
    errors,
    writtenMessages() {
      return new ControlStreamReader().feed(concatUint8Arrays(stream.written));
    },
  };
}

/**
 * SUBSCRIBE_TRACKS の先頭メッセージを構築してハンドラへ渡す
 *
 * 先頭読み取りは本番では incomingPublishHandleBidirectionalStream が行う。
 * ここでは同じ境界 (メッセージ型と本文、後続読み取りに使う controlReader) を
 * 直接渡す。
 */
async function handleSubscribeTracks(
  context: ReturnType<typeof createSubscribeTracksTestContext>,
  options: {
    requestId?: bigint;
    namespace?: string[];
    parameters?: Parameter[];
  } = {},
): Promise<void> {
  const requestId = options.requestId ?? 1n;
  const namespace = options.namespace ?? ["live"];
  const parameters = options.parameters ?? [];
  const payload = encodeSubscribeTracksPayload({
    type: MessageType.SUBSCRIBE_TRACKS,
    requestId,
    trackNamespacePrefix: createTrackNamespace(namespace),
    parameters,
  });
  await incomingSubscribeTracksHandleFirstMessage(
    context.session,
    context.stream.stream,
    { type: MessageType.SUBSCRIBE_TRACKS, payload },
    context.controlReader,
    [],
  );
}

/** REQUEST_UPDATE のフレームを readable へ積む */
function enqueueRequestUpdate(
  context: ReturnType<typeof createSubscribeTracksTestContext>,
  options: { requestId: bigint; parameters: Parameter[] },
): void {
  const payload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: options.requestId,
    parameters: options.parameters,
  });
  context.stream.readableController.enqueue(
    new ControlStreamWriter().encode(MessageType.REQUEST_UPDATE, payload),
  );
}

/**
 * draft-ietf-moq-transport-23 §3.6 (Subscribing to Tracks by Prefix):
 * 認可コールバックが受理したら REQUEST_OK を返し、購読を登録する。
 * 応答方向は FIN しない (REQUEST_UPDATE を同じストリームで受けるため)。
 */
test("incomingSubscribeTracksHandleFirstMessage: 受理したら REQUEST_OK を返して購読を登録する", async () => {
  const context = createSubscribeTracksTestContext({
    authorizeSubscribeTracks() {
      return { accept: true };
    },
  });
  await handleSubscribeTracks(context);

  assert.equal(context.stream.written.length, 1);
  const [message] = context.writtenMessages();
  assert.equal(message?.type, MessageType.REQUEST_OK);
  assert.deepEqual(decodeRequestOkPayload(message.payload).parameters, []);
  assert.equal(context.session.incomingTracksSubscriptions.size, 1);
  const subscription = context.session.incomingTracksSubscriptions.get(1n);
  assert.equal(subscription?.state, "active");
  assert.deepEqual(subscription?.namespacePrefix, ["live"]);
  // 応答方向は FIN していない
  assert.notInclude(context.stream.events, "close");
});

/**
 * draft-ietf-moq-transport-23 §3.6:
 * 認可コールバックが拒否したら REQUEST_ERROR (UNAUTHORIZED) を返して FIN し、
 * 購読を登録しない。セッションは閉じない。
 */
test("incomingSubscribeTracksHandleFirstMessage: 認可拒否は REQUEST_ERROR (UNAUTHORIZED) で FIN する", async () => {
  const context = createSubscribeTracksTestContext({
    authorizeSubscribeTracks() {
      return { accept: false, reasonPhrase: "policy" };
    },
  });
  await handleSubscribeTracks(context);

  const [message] = context.writtenMessages();
  assert.equal(message?.type, MessageType.REQUEST_ERROR);
  const decoded = decodeRequestErrorPayload(message.payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.UNAUTHORIZED));
  assert.equal(decoded.reasonPhrase, "policy");
  assert.include(context.stream.events, "close");
  assert.isUndefined(context.closed.error);
  assert.equal(context.session.incomingTracksSubscriptions.size, 0);
});

/**
 * draft-ietf-moq-transport-23 §9.19.1 (Parameter Scope):
 * SUBSCRIBE_TRACKS に許可されない parameter (SUBSCRIBE_TRACKS_ID) を受けたら、
 * セッションを INVALID_PARAMETER で閉じる (MUST)。REQUEST_ERROR では返さない。
 */
test("incomingSubscribeTracksHandleFirstMessage: 許可外 parameter は INVALID_PARAMETER で閉じる", async () => {
  const context = createSubscribeTracksTestContext();
  await handleSubscribeTracks(context, {
    parameters: [{ type: MessageParameterType.SUBSCRIBE_TRACKS_ID, value: new Uint8Array([4]) }],
  });

  assert.equal(context.closed.error?.code, SessionErrorCode.INVALID_PARAMETER);
  assert.equal(context.session.incomingTracksSubscriptions.size, 0);
});

/**
 * draft-ietf-moq-transport-23 §3.3.2 (Range Filters) / §9.1.6 (MAX_FILTER_RANGES):
 * 自 endpoint が MAX_FILTER_RANGES を広告していない (0) 状態で Range Filter を
 * 受けたら、REQUEST_ERROR (INVALID_FILTER) で拒否する (MUST)。
 */
test("incomingSubscribeTracksHandleFirstMessage: MAX_FILTER_RANGES 未広告の Range Filter は INVALID_FILTER", async () => {
  const context = createSubscribeTracksTestContext({
    authorizeSubscribeTracks() {
      return { accept: true };
    },
  });
  await handleSubscribeTracks(context, {
    parameters: [
      {
        type: MessageParameterType.SUBGROUP_FILTER,
        value: encodeRangeFilter({
          type: "subgroup",
          setId: 0,
          ranges: [{ start: 0n, end: 0n }],
        }),
      },
    ],
  });

  const [message] = context.writtenMessages();
  assert.equal(message?.type, MessageType.REQUEST_ERROR);
  assert.equal(
    decodeRequestErrorPayload(message.payload).errorCode,
    BigInt(RequestErrorCode.INVALID_FILTER),
  );
  assert.equal(context.session.incomingTracksSubscriptions.size, 0);
});

/**
 * draft-ietf-moq-transport-23 §2.4.3 (Reserved Namespaces) / §6.5:
 * 予約 namespace の要求は DOES_NOT_EXIST で拒否し、セッションは閉じない。
 */
test("incomingSubscribeTracksHandleFirstMessage: 予約 namespace は DOES_NOT_EXIST で拒否する", async () => {
  const context = createSubscribeTracksTestContext({
    authorizeSubscribeTracks() {
      return { accept: true };
    },
  });
  await handleSubscribeTracks(context, { namespace: [".session"] });

  const [message] = context.writtenMessages();
  assert.equal(message?.type, MessageType.REQUEST_ERROR);
  assert.equal(
    decodeRequestErrorPayload(message.payload).errorCode,
    BigInt(RequestErrorCode.DOES_NOT_EXIST),
  );
  assert.isUndefined(context.closed.error);
});

/**
 * draft-ietf-moq-transport-23 §9.19.18 (PAUSED Parameter) / §9.5:
 * REQUEST_UPDATE の PAUSED は REQUEST_OK を返して受理し、今後の一致購読にだけ
 * 適用する (既存の購読は変更しない)。
 */
test("incomingSubscribeTracksHandleFirstMessage: REQUEST_UPDATE の PAUSED を受理する", async () => {
  const context = createSubscribeTracksTestContext({
    authorizeSubscribeTracks() {
      return { accept: true };
    },
  });
  await handleSubscribeTracks(context);

  enqueueRequestUpdate(context, {
    requestId: 3n,
    parameters: [{ type: MessageParameterType.PAUSED, value: new Uint8Array([1]) }],
  });

  await waitForCondition(
    () => context.stream.written.length >= 2,
    "REQUEST_UPDATE_OK が書かれること",
  );
  const messages = context.writtenMessages();
  assert.equal(messages[1]?.type, MessageType.REQUEST_OK);
  assert.isTrue(context.session.incomingTracksSubscriptions.get(1n)?.paused);
  // 応答方向は FIN していない
  assert.notInclude(context.stream.events, "close");
});

/**
 * draft-ietf-moq-transport-23 §9.19.1 (Parameter Scope) / §9.5:
 * SUBSCRIBE_TRACKS の REQUEST_UPDATE に許可されない parameter を受けたら、
 * セッションを INVALID_PARAMETER で閉じる (MUST)。
 */
test("incomingSubscribeTracksHandleFirstMessage: REQUEST_UPDATE の許可外 parameter は INVALID_PARAMETER", async () => {
  const context = createSubscribeTracksTestContext({
    authorizeSubscribeTracks() {
      return { accept: true };
    },
  });
  await handleSubscribeTracks(context);

  enqueueRequestUpdate(context, {
    requestId: 3n,
    parameters: [{ type: MessageParameterType.SUBSCRIBE_TRACKS_ID, value: new Uint8Array([4]) }],
  });

  await waitForCondition(
    () => context.closed.error !== undefined,
    "セッションが INVALID_PARAMETER で閉じられること",
  );
  assert.equal(context.closed.error?.code, SessionErrorCode.INVALID_PARAMETER);
});

/**
 * draft-ietf-moq-transport-23 §9.19.18:
 * PAUSED の値域外 (2) はセッションを INVALID_PARAMETER で閉じる (MUST)。
 */
test("incomingSubscribeTracksHandleFirstMessage: PAUSED の値域外は INVALID_PARAMETER", async () => {
  const context = createSubscribeTracksTestContext({
    authorizeSubscribeTracks() {
      return { accept: true };
    },
  });
  await handleSubscribeTracks(context);

  enqueueRequestUpdate(context, {
    requestId: 3n,
    parameters: [{ type: MessageParameterType.PAUSED, value: new Uint8Array([2]) }],
  });

  await waitForCondition(
    () => context.closed.error !== undefined,
    "セッションが INVALID_PARAMETER で閉じられること",
  );
  assert.equal(context.closed.error?.code, SessionErrorCode.INVALID_PARAMETER);
});

/**
 * draft-ietf-moq-transport-23 §6.4.2.2 (Graceful Request Stream Closure):
 * FIN は要求の取消ではない。購読を維持し、以後に公開される一致 Track へ
 * PUBLISH を送れる状態にしておく。
 */
test("incomingSubscribeTracksHandleFirstMessage: FIN では購読を維持する", async () => {
  const context = createSubscribeTracksTestContext({
    authorizeSubscribeTracks() {
      return { accept: true };
    },
  });
  await handleSubscribeTracks(context);
  context.stream.readableController.close();

  // 読み取りループが終了しても購読は active のまま残る
  await waitForCondition(
    () => context.stream.events.includes("write"),
    "受理応答が書かれていること",
  );
  assert.equal(context.session.incomingTracksSubscriptions.get(1n)?.state, "active");
});

test("SUBSCRIBE_TRACKS: REQUEST_UPDATE の本文途中で FIN を受けたらセッションを閉じる", async () => {
  const context = createSubscribeTracksTestContext({
    authorizeSubscribeTracks() {
      return { accept: true };
    },
  });
  await handleSubscribeTracks(context);
  context.stream.readableController.enqueue(Uint8Array.of(MessageType.REQUEST_UPDATE, 2, 0));
  context.stream.readableController.close();
  await waitForCondition(() => !context.stream.readable.locked, "要求ストリームの読み取り終了");
  assert.equal(context.closed.error?.code, SessionErrorCode.MALFORMED_MESSAGE);
});

test("受信リクエスト: 最初のメッセージの本文途中で FIN を受けたらセッションを閉じる", async () => {
  const context = createSubscribeTracksTestContext();
  context.stream.readableController.enqueue(Uint8Array.of(MessageType.SUBSCRIBE_TRACKS, 2, 0));
  context.stream.readableController.close();
  await incomingPublishHandleBidirectionalStream(context.session, context.stream.stream);
  assert.equal(context.closed.error?.code, SessionErrorCode.MALFORMED_MESSAGE);
});

/**
 * draft-ietf-moq-transport-23 §6.4.2.3 (Request Cancellation and Rejection):
 * RESET_STREAM は取消として扱い、購読を削除する。既存の PUBLISH 購読は止めない
 * (このテストは受信購読の削除だけを固定する)。
 */
test("incomingSubscribeTracksHandleFirstMessage: RESET_STREAM で購読を削除する", async () => {
  const context = createSubscribeTracksTestContext({
    authorizeSubscribeTracks() {
      return { accept: true };
    },
  });
  await handleSubscribeTracks(context);
  // ピアの RESET_STREAM 相当 (source: "stream" の reject) を readable に起こす
  context.stream.readableController.error(
    Object.assign(new Error("peer reset"), { source: "stream" }),
  );

  await waitForCondition(
    () => context.session.incomingTracksSubscriptions.size === 0,
    "購読が削除されること",
  );
  assert.equal(context.session.incomingTracksSubscriptions.size, 0);
  assert.isFalse(context.session.requestStreams.has(1n));
  assert.isUndefined(context.closed.error, "通常の取消をセッションエラーにしない");
  assert.equal(context.errors.length, 0, "error コールバックも呼ばない");
});

/**
 * draft-ietf-moq-transport-23 §6.4.2.1 (Request ID):
 * 同一 Request ID の再出現は INVALID_REQUEST_ID。
 */
test("incomingSubscribeTracksHandleFirstMessage: Request ID の重複は INVALID_REQUEST_ID", async () => {
  const first = createSubscribeTracksTestContext({
    authorizeSubscribeTracks() {
      return { accept: true };
    },
  });
  await handleSubscribeTracks(first);

  const second = createSubscribeTracksTestContext({
    authorizeSubscribeTracks() {
      return { accept: true };
    },
  });
  // 同じセッションへ同じ Request ID を 2 回渡す
  const payload = encodeSubscribeTracksPayload({
    type: MessageType.SUBSCRIBE_TRACKS,
    requestId: 1n,
    trackNamespacePrefix: createTrackNamespace(["live"]),
    parameters: [],
  });
  await incomingSubscribeTracksHandleFirstMessage(
    first.session,
    second.stream.stream,
    { type: MessageType.SUBSCRIBE_TRACKS, payload },
    new ControlStreamReader(),
    [],
  );

  assert.equal(first.closed.error?.code, SessionErrorCode.INVALID_REQUEST_ID);
});

/**
 * 認可コールバックが不在のときの既定は、prefix に一致する公開 Track も
 * active な PUBLISH_NAMESPACE も無ければ DOES_NOT_EXIST で拒否する。
 */
test("incomingSubscribeTracksHandleFirstMessage: 既定は一致する公開 Track が無ければ DOES_NOT_EXIST", async () => {
  const context = createSubscribeTracksTestContext();
  await handleSubscribeTracks(context);

  const [message] = context.writtenMessages();
  assert.equal(message?.type, MessageType.REQUEST_ERROR);
  assert.equal(
    decodeRequestErrorPayload(message.payload).errorCode,
    BigInt(RequestErrorCode.DOES_NOT_EXIST),
  );
});

/**
 * 認可コールバックの例外は INTERNAL_ERROR として拒否し、セッションは閉じない。
 */
test("incomingSubscribeTracksHandleFirstMessage: 認可コールバックの例外は INTERNAL_ERROR", async () => {
  const context = createSubscribeTracksTestContext({
    authorizeSubscribeTracks() {
      throw new InvalidFilterError("callback failure");
    },
  });
  await handleSubscribeTracks(context);

  const [message] = context.writtenMessages();
  assert.equal(message?.type, MessageType.REQUEST_ERROR);
  assert.equal(
    decodeRequestErrorPayload(message.payload).errorCode,
    BigInt(RequestErrorCode.INTERNAL_ERROR),
  );
  assert.isUndefined(context.closed.error);
});

/**
 * incomingPublishHandleBidirectionalStream は production の受信入口である。
 * 先頭メッセージが SUBSCRIBE_TRACKS の場合は専用ハンドラへディスパッチし、
 * 先頭チャンクに連結されていた REQUEST_UPDATE を同じ読み取りループで処理する。
 * 連結分を捨てずに処理できることを、REQUEST_OK が 2 通書かれることで確かめる。
 */
test("incomingPublishHandleBidirectionalStream: SUBSCRIBE_TRACKS を dispatch し、先頭チャンクの REQUEST_UPDATE を処理する", async () => {
  const context = createSubscribeTracksTestContext({
    authorizeSubscribeTracks() {
      return { accept: true };
    },
  });
  const stream = createTestBidirectionalStream();
  const writer = new ControlStreamWriter();
  const subscribeTracksPayload = encodeSubscribeTracksPayload({
    type: MessageType.SUBSCRIBE_TRACKS,
    requestId: 1n,
    trackNamespacePrefix: createTrackNamespace(["live"]),
    parameters: [],
  });
  const requestUpdatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 3n,
    parameters: [{ type: MessageParameterType.PAUSED, value: new Uint8Array([1]) }],
  });
  // 先頭メッセージと REQUEST_UPDATE を 1 つの chunk に連結する。
  // 先頭読み取りの残りメッセージを引き継がないと REQUEST_UPDATE は失われる。
  stream.readableController.enqueue(
    concatUint8Arrays([
      writer.encode(MessageType.SUBSCRIBE_TRACKS, subscribeTracksPayload),
      writer.encode(MessageType.REQUEST_UPDATE, requestUpdatePayload),
    ]),
  );

  await incomingPublishHandleBidirectionalStream(context.session, stream.stream);
  await waitForCondition(
    () => stream.written.length >= 2,
    "受理応答と連結 REQUEST_UPDATE の応答が書かれること",
  );

  const messages = new ControlStreamReader().feed(concatUint8Arrays(stream.written));
  assert.equal(messages[0]?.type, MessageType.REQUEST_OK, "SUBSCRIBE_TRACKS の受理応答を返す");
  assert.equal(messages[1]?.type, MessageType.REQUEST_OK, "連結 REQUEST_UPDATE の受理応答を返す");
  assert.isTrue(
    context.session.incomingTracksSubscriptions.get(1n)?.paused,
    "連結 REQUEST_UPDATE の PAUSED を購読状態へ反映する",
  );
  assert.isTrue(
    context.session.requestStreams.has(1n),
    "応答ストリームを requestStreams に登録する",
  );
});

/**
 * draft-ietf-moq-transport-23 §9.1.7 (MAX_REQUEST_UPDATES):
 * 自 endpoint が広告した上限に達した状態でさらに REQUEST_UPDATE を受けたら、
 * セッションを TOO_MANY_REQUEST_UPDATES で閉じる (MUST)。0 は無制限である。
 * 未応答数は 1 チャンク分の処理が終わるまで減らないため、同じチャンクに
 * 上限を超える REQUEST_UPDATE を連結して検出させる。
 */
test("incomingSubscribeTracksHandleFirstMessage: MAX_REQUEST_UPDATES 超過で TOO_MANY_REQUEST_UPDATES", async () => {
  const context = createSubscribeTracksTestContext({
    authorizeSubscribeTracks() {
      return { accept: true };
    },
  });
  context.impl.localMaxRequestUpdates = 1;
  await handleSubscribeTracks(context);

  const writer = new ControlStreamWriter();
  const firstUpdate = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 3n,
    parameters: [],
  });
  const secondUpdate = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 5n,
    parameters: [],
  });
  context.stream.readableController.enqueue(
    concatUint8Arrays([
      writer.encode(MessageType.REQUEST_UPDATE, firstUpdate),
      writer.encode(MessageType.REQUEST_UPDATE, secondUpdate),
    ]),
  );

  await waitForCondition(
    () => context.closed.error !== undefined,
    "セッションが TOO_MANY_REQUEST_UPDATES で閉じられること",
  );
  assert.equal(context.closed.error?.code, SessionErrorCode.TOO_MANY_REQUEST_UPDATES);
});

/**
 * draft-ietf-moq-transport-23 §9.5 (REQUEST_UPDATE):
 * SUBSCRIBE_TRACKS の REQUEST_UPDATE が失敗した場合、responder は
 * REQUEST_UPDATE_ERROR (REQUEST_ERROR の別名) を返した後に bidi ストリームを
 * 閉じる (MUST)。購読状態と requestStreams のエントリも削除する。
 */
test("incomingSubscribeTracksHandleFirstMessage: REQUEST_UPDATE_ERROR を返したら応答ストリームを閉じて購読を削除する", async () => {
  const context = createSubscribeTracksTestContext({
    authorizeSubscribeTracks() {
      return { accept: true };
    },
  });
  await handleSubscribeTracks(context);

  // 0x29 の Value を Length=1 + SetID のみにして、Property Type 欠落の
  // InvalidFilterError を起こす。
  enqueueRequestUpdate(context, {
    requestId: 3n,
    parameters: [
      {
        type: MessageParameterType.TRACK_PROPERTY_FILTER,
        value: new Uint8Array([0x01, 0x00]),
      },
    ],
  });

  await waitForCondition(
    () => context.stream.events.includes("close"),
    "REQUEST_UPDATE_ERROR の後に応答ストリームが FIN で閉じられること",
  );
  await waitForCondition(
    () => context.session.incomingTracksSubscriptions.size === 0,
    "購読が削除されること",
  );

  const messages = context.writtenMessages();
  assert.equal(messages[1]?.type, MessageType.REQUEST_ERROR, "REQUEST_UPDATE_ERROR を返す");
  const error = decodeRequestErrorPayload(messages[1]?.payload as Uint8Array);
  assert.equal(error.errorCode, BigInt(RequestErrorCode.INVALID_FILTER));
  assert.isFalse(context.session.requestStreams.has(1n), "requestStreams のエントリも削除する");
  assert.isUndefined(context.closed.error, "プロトコル違反ではないためセッションは閉じない");
});

/**
 * draft-ietf-moq-transport-23 §3.3.2 (Range Filters):
 * 同一 (Parameter Type, SetID, Property Type) の組み合わせが繰り返されたら
 * REQUEST_ERROR (INVALID_FILTER) で拒否する (MUST)。初期 SUBSCRIBE_TRACKS の
 * 受理前に検証する。MAX_FILTER_RANGES を広告した状態にして、上限違反ではなく
 * 組み合わせ重複が理由であることを確かめる。
 */
test("incomingSubscribeTracksHandleFirstMessage: Range Filter の組み合わせ重複は INVALID_FILTER", async () => {
  const context = createSubscribeTracksTestContext();
  context.impl.localMaxFilterRanges = 10;
  const duplicatedFilter = encodeRangeFilter({
    type: "subgroup",
    setId: 0,
    ranges: [{ start: 0n, end: 0n }],
  });
  await handleSubscribeTracks(context, {
    parameters: [
      { type: MessageParameterType.SUBGROUP_FILTER, value: duplicatedFilter },
      { type: MessageParameterType.SUBGROUP_FILTER, value: duplicatedFilter },
    ],
  });

  const [message] = context.writtenMessages();
  assert.equal(message?.type, MessageType.REQUEST_ERROR);
  const error = decodeRequestErrorPayload(message?.payload as Uint8Array);
  assert.equal(error.errorCode, BigInt(RequestErrorCode.INVALID_FILTER));
  assert.include(error.reasonPhrase, "duplicate");
  assert.equal(context.session.incomingTracksSubscriptions.size, 0);
});

/**
 * draft-ietf-moq-transport-23 §9.19.9 (LOCATION FILTER Parameter):
 * StartGroup + EndGroupDelta が 2^64-1 を超えたら DELTA_ENCODING_OVERFLOW で
 * セッションを閉じる (MUST)。初期 SUBSCRIBE_TRACKS の受信でも同じ検証を行う。
 */
test("incomingSubscribeTracksHandleFirstMessage: LOCATION_FILTER の EndGroup 超過は DELTA_ENCODING_OVERFLOW", async () => {
  const context = createSubscribeTracksTestContext();
  await handleSubscribeTracks(context, {
    parameters: [buildOverflowingLocationFilterParameter()],
  });

  assert.equal(context.closed.error?.code, SessionErrorCode.DELTA_ENCODING_OVERFLOW);
  assert.equal(context.session.incomingTracksSubscriptions.size, 0);
});

/**
 * draft-ietf-moq-transport-23 §9.19.15 (FILL PARAMETERS Parameter) / §9.19.1:
 * FILL_PARAMETERS の内側に Table 7 の一覧に無い parameter を受けたら、
 * セッションを INVALID_PARAMETER で閉じる (MUST)。
 */
test("incomingSubscribeTracksHandleFirstMessage: FILL_PARAMETERS 内側の許可外 parameter は INVALID_PARAMETER", async () => {
  const context = createSubscribeTracksTestContext();
  // FILL_PARAMETERS の Value は Number of Parameters + 別メッセージとして
  // エンコードした Parameters 列である。PAUSED は Table 7 に無い。
  const invalidFillParameters: Parameter = {
    type: MessageParameterType.FILL_PARAMETERS,
    value: concatUint8Arrays([
      encodeVarint(1n),
      encodeParameters([{ type: MessageParameterType.PAUSED, value: new Uint8Array([0]) }]),
    ]),
  };
  await handleSubscribeTracks(context, { parameters: [invalidFillParameters] });

  assert.equal(context.closed.error?.code, SessionErrorCode.INVALID_PARAMETER);
  assert.equal(context.session.incomingTracksSubscriptions.size, 0);
});

/**
 * draft-ietf-moq-transport-23 §9.1.6 (MAX FILTER RANGES) / §9.19.15:
 * FILL_PARAMETERS 内側の Range Filter も購読単位の合計に含める。
 * MAX_FILTER_RANGES を広告していない (0) 状態では REQUEST_ERROR (INVALID_FILTER)。
 */
test("incomingSubscribeTracksHandleFirstMessage: FILL_PARAMETERS 内側の Range Filter も MAX_FILTER_RANGES に数える", async () => {
  const context = createSubscribeTracksTestContext();
  const fillParameters = encodeFillParameters([
    {
      type: MessageParameterType.SUBGROUP_FILTER,
      value: encodeRangeFilter({
        type: "subgroup",
        setId: 0,
        ranges: [{ start: 0n, end: 0n }],
      }),
    },
  ]);
  await handleSubscribeTracks(context, { parameters: [fillParameters] });

  const [message] = context.writtenMessages();
  assert.equal(message?.type, MessageType.REQUEST_ERROR);
  assert.equal(
    decodeRequestErrorPayload(message?.payload as Uint8Array).errorCode,
    BigInt(RequestErrorCode.INVALID_FILTER),
  );
});

/**
 * draft-ietf-moq-transport-23 §9.5 (REQUEST_UPDATE):
 * TRACK_PROPERTY_FILTER (0x29) は同一メッセージに複数回現れ、Length 0 で削除、
 * 非 0 で全置換である。更新に複数の 0x29 が含まれる場合は全件を反映し、
 * 先頭 1 件だけを処理しない。
 */
test("incomingSubscribeTracksHandleFirstMessage: REQUEST_UPDATE の複数 TRACK_PROPERTY_FILTER を全置換する", async () => {
  const context = createSubscribeTracksTestContext({
    authorizeSubscribeTracks() {
      return { accept: true };
    },
  });
  context.impl.localMaxFilterRanges = 10;
  await handleSubscribeTracks(context);

  const propertyValueFilter = encodeRangeFilter({
    type: "trackProperty",
    setId: 0,
    propertyType: 0x02n,
    ranges: [{ start: 100n, end: 200n }],
  });
  const propertyPriorityFilter = encodeRangeFilter({
    type: "trackProperty",
    setId: 0,
    propertyType: 0x04n,
    ranges: [{ start: 1n, end: 2n }],
  });
  enqueueRequestUpdate(context, {
    requestId: 3n,
    parameters: [
      { type: MessageParameterType.TRACK_PROPERTY_FILTER, value: propertyValueFilter },
      { type: MessageParameterType.TRACK_PROPERTY_FILTER, value: propertyPriorityFilter },
    ],
  });
  await waitForCondition(
    () => context.stream.written.length >= 2,
    "複数 0x29 の REQUEST_UPDATE が受理されること",
  );
  const replacedFilters = context.session.incomingTracksSubscriptions
    .get(1n)
    ?.rangeFilters.filter((filter) => filter.type === "trackProperty");
  assert.equal(replacedFilters?.length, 2, "更新の 0x29 を全件反映する");
  assert.deepEqual(
    replacedFilters?.map((filter) => ("remove" in filter ? undefined : filter.propertyType)),
    [2n, 4n],
    "SetID / Property Type が異なる 2 件を保持する",
  );

  // Length 0 の 0x29 は TRACK_PROPERTY_FILTER の集合を削除する。
  enqueueRequestUpdate(context, {
    requestId: 5n,
    parameters: [
      {
        type: MessageParameterType.TRACK_PROPERTY_FILTER,
        value: encodeRangeFilter({ type: "trackProperty", remove: true }),
      },
    ],
  });
  await waitForCondition(
    () => context.stream.written.length >= 3,
    "0x29 の削除更新が受理されること",
  );
  assert.deepEqual(
    context.session.incomingTracksSubscriptions
      .get(1n)
      ?.rangeFilters.filter((filter) => filter.type === "trackProperty"),
    [],
    "Length 0 の 0x29 で全削除する",
  );
});

/** §9.1.6: 省略された Object Filter も購読に残るため、新しい Track Filter と合算する。 */
test("SUBSCRIBE_TRACKS: 既存の Object Filter と合算して上限を超える更新を拒否する", async () => {
  const context = createSubscribeTracksTestContext({
    authorizeSubscribeTracks() {
      return { accept: true };
    },
  });
  context.impl.localMaxFilterRanges = 1;
  const objectFilter = {
    type: "objectId" as const,
    setId: 0,
    ranges: [{ start: 1n, end: 5n }],
  };
  await handleSubscribeTracks(context, {
    parameters: [
      {
        type: MessageParameterType.OBJECTID_FILTER,
        value: encodeRangeFilter(objectFilter),
      },
    ],
  });
  const subscription = context.session.incomingTracksSubscriptions.get(1n);
  assert.isDefined(subscription);
  enqueueRequestUpdate(context, {
    requestId: 3n,
    parameters: [
      { type: MessageParameterType.PAUSED, value: Uint8Array.of(1) },
      {
        type: MessageParameterType.TRACK_PROPERTY_FILTER,
        value: encodeRangeFilter({
          type: "trackProperty",
          setId: 0,
          propertyType: 0x02n,
          ranges: [{ start: 10n, end: 20n }],
        }),
      },
    ],
  });
  await waitForCondition(
    () => context.writtenMessages().length >= 2,
    "上限超過を知らせる REQUEST_ERROR が届くこと",
  );
  const response = context.writtenMessages()[1];
  assert.equal(response?.type, MessageType.REQUEST_ERROR);
  assert.equal(
    decodeRequestErrorPayload(response?.payload as Uint8Array).errorCode,
    BigInt(RequestErrorCode.INVALID_FILTER),
  );
  await waitForCondition(
    () => !context.session.incomingTracksSubscriptions.has(1n),
    "拒否後に SUBSCRIBE_TRACKS が閉じられること",
  );
  // 拒否した更新に含めた PAUSED と Track Property Filter は反映しない。
  assert.isFalse(subscription?.paused);
  assert.deepEqual(subscription?.rangeFilters, [objectFilter]);
  assert.isUndefined(context.closed.error);
});

/**
 * draft-ietf-moq-transport-23 §3.3.2 (Range Filters) / §9.5 (REQUEST_UPDATE):
 * REQUEST_UPDATE に同一組み合わせの 0x29 が繰り返されたら
 * REQUEST_ERROR (INVALID_FILTER) を返して bidi ストリームを閉じる。
 */
test("incomingSubscribeTracksHandleFirstMessage: REQUEST_UPDATE の Range Filter 組み合わせ重複は INVALID_FILTER", async () => {
  const context = createSubscribeTracksTestContext({
    authorizeSubscribeTracks() {
      return { accept: true };
    },
  });
  context.impl.localMaxFilterRanges = 10;
  await handleSubscribeTracks(context);

  const duplicatedFilter = encodeRangeFilter({
    type: "trackProperty",
    setId: 0,
    propertyType: 0x02n,
    ranges: [{ start: 1n, end: 1n }],
  });
  enqueueRequestUpdate(context, {
    requestId: 3n,
    parameters: [
      { type: MessageParameterType.TRACK_PROPERTY_FILTER, value: duplicatedFilter },
      { type: MessageParameterType.TRACK_PROPERTY_FILTER, value: duplicatedFilter },
    ],
  });

  await waitForCondition(
    () => context.stream.events.includes("close"),
    "REQUEST_UPDATE_ERROR の後に応答ストリームが閉じられること",
  );
  const messages = context.writtenMessages();
  assert.equal(messages[1]?.type, MessageType.REQUEST_ERROR);
  assert.equal(
    decodeRequestErrorPayload(messages[1]?.payload as Uint8Array).errorCode,
    BigInt(RequestErrorCode.INVALID_FILTER),
  );
  assert.equal(context.session.incomingTracksSubscriptions.size, 0);
});

/**
 * draft-ietf-moq-transport-23 §2.4.3 (Reserved Namespaces) / §6.5:
 * REQUEST_UPDATE で TRACK_NAMESPACE_PREFIX を予約 namespace (.session 等) へ
 * 変更しようとしたら、REQUEST_UPDATE_ERROR (DOES_NOT_EXIST) を返して
 * bidi ストリームを閉じる。
 */
test("incomingSubscribeTracksHandleFirstMessage: prefix 更新の予約 namespace は DOES_NOT_EXIST", async () => {
  const context = createSubscribeTracksTestContext({
    authorizeSubscribeTracks() {
      return { accept: true };
    },
  });
  await handleSubscribeTracks(context);

  enqueueRequestUpdate(context, {
    requestId: 3n,
    parameters: [
      {
        type: MessageParameterType.TRACK_NAMESPACE_PREFIX,
        value: encodeTrackNamespace(createTrackNamespace([".session"])),
      },
    ],
  });

  await waitForCondition(
    () => context.stream.events.includes("close"),
    "REQUEST_UPDATE_ERROR の後に応答ストリームが閉じられること",
  );
  const messages = context.writtenMessages();
  assert.equal(messages[1]?.type, MessageType.REQUEST_ERROR);
  assert.equal(
    decodeRequestErrorPayload(messages[1]?.payload as Uint8Array).errorCode,
    BigInt(RequestErrorCode.DOES_NOT_EXIST),
  );
  assert.equal(context.session.incomingTracksSubscriptions.size, 0);
  assert.isUndefined(context.closed.error);
});

/**
 * draft-ietf-moq-transport-23 §9:
 * SUBSCRIBE_TRACKS の本文が切詰められている場合は MALFORMED_MESSAGE で閉じる。
 */
test("incomingSubscribeTracksHandleFirstMessage: 切詰めた payload は MALFORMED_MESSAGE", async () => {
  const context = createSubscribeTracksTestContext();
  const payload = encodeSubscribeTracksPayload({
    type: MessageType.SUBSCRIBE_TRACKS,
    requestId: 1n,
    trackNamespacePrefix: createTrackNamespace(["live"]),
    parameters: [],
  });
  // Parameters の個数を表す最後の 1 バイトを落として切詰めにする
  const truncated = payload.slice(0, -1);
  await incomingSubscribeTracksHandleFirstMessage(
    context.session,
    context.stream.stream,
    { type: MessageType.SUBSCRIBE_TRACKS, payload: truncated },
    context.controlReader,
    [],
  );

  assert.equal(context.closed.error?.code, SessionErrorCode.MALFORMED_MESSAGE);
  assert.equal(context.session.incomingTracksSubscriptions.size, 0);
});

/**
 * draft-ietf-moq-transport-23 §6.4.2.1 (Request ID):
 * サーバー発の Request ID は奇数である。偶数では INVALID_REQUEST_ID で閉じる。
 */
test("incomingSubscribeTracksHandleFirstMessage: Request ID のパリティ違反は INVALID_REQUEST_ID", async () => {
  const context = createSubscribeTracksTestContext();
  await handleSubscribeTracks(context, { requestId: 2n });

  assert.equal(context.closed.error?.code, SessionErrorCode.INVALID_REQUEST_ID);
  assert.equal(context.session.incomingTracksSubscriptions.size, 0);
});

/**
 * draft-ietf-moq-transport-23 §6.4.2.3 (Request Cancellation and Rejection):
 * ピアは取消を STOP_SENDING で行う。当方の送信方向 (writer) が reset されたら
 * 応答 writer を abort し、購読を削除する。通常の取消であり、セッションエラー
 * として通知しない。
 */
test("incomingSubscribeTracksHandleFirstMessage: STOP_SENDING で購読を削除しセッションエラーにしない", async () => {
  const context = createSubscribeTracksTestContext({
    authorizeSubscribeTracks() {
      return { accept: true };
    },
  });
  await handleSubscribeTracks(context);

  const writer = context.session.requestStreams.get(1n)?.writer;
  if (writer === undefined) {
    throw new Error("応答 writer が登録されていない");
  }
  // ピアの STOP_SENDING 相当: 当方の送信方向を reset して writer.closed を
  // reject させ、送信方向の終了監視を発火させる。
  await writer.abort(Object.assign(new Error("stop sending"), { source: "stream" }));

  await waitForCondition(
    () => context.session.incomingTracksSubscriptions.size === 0,
    "STOP_SENDING で購読が削除されること",
  );
  assert.isFalse(context.session.requestStreams.has(1n));
  assert.isUndefined(context.closed.error, "通常の取消をセッションエラーにしない");
  assert.equal(context.errors.length, 0, "error コールバックも呼ばない");

  // 読み取りループを終わらせる
  context.stream.readableController.close();
});
