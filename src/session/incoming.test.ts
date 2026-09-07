/**
 * session/incoming.ts の受信 bidi ストリーム先頭ディスパッチのテスト
 *
 * 実 W3C ストリーム (`ReadableStream` + `WritableStream`) を
 * `as unknown as WebTransportBidirectionalStream` で注入する方式は
 * session/bidi.test.ts と同型である。
 */

import { test, assert } from "vite-plus/test";
import { MessageType } from "../message";
import { decodeRequestErrorPayload } from "../message/session";
import { RequestErrorCode, SessionError, SessionErrorCode } from "../error";
import { ControlStreamReader, type ControlMessage } from "../controlStream";
import {
  incomingClassifyFirstBidiMessage,
  incomingHandleDatagram,
  incomingHandleFirstBidiMessage,
  incomingSendRequestErrorAndClose,
  incomingValidateRequestId,
  incomingWaitForFetcher,
} from "./incoming";
import type { SessionInternal } from "./types";
import { SubscriberImpl } from "../subscriber";
import { FetcherImpl } from "../fetcher";
import { DatagramType, encodeObjectDatagram } from "../dataStream";

// ============================================================================
// incomingClassifyFirstBidiMessage のテスト
// ============================================================================

/**
 * draft-ietf-moq-transport-20 §3.3:
 * 受信 bidi ストリームの先頭が PUBLISH の場合、従来の受信 PUBLISH 処理を
 * 継続する ("publish" 分類)。
 */
test("incomingClassifyFirstBidiMessage: PUBLISH は publish に分類される", () => {
  assert.equal(incomingClassifyFirstBidiMessage(MessageType.PUBLISH), "publish");
});

/**
 * draft-ietf-moq-transport-20 §3.3:
 * 先頭 7 種のうち moqt-js が未対応の 6 種 (SUBSCRIBE / FETCH / TRACK_STATUS /
 * PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS) は
 * NOT_SUPPORTED 応答の対象 ("unsupported-request" 分類)。
 */
test("incomingClassifyFirstBidiMessage: 未対応の 6 種は unsupported-request に分類される", () => {
  assert.equal(incomingClassifyFirstBidiMessage(MessageType.TRACK_STATUS), "unsupported-request");
  assert.equal(incomingClassifyFirstBidiMessage(MessageType.SUBSCRIBE), "unsupported-request");
  assert.equal(incomingClassifyFirstBidiMessage(MessageType.FETCH), "unsupported-request");
  assert.equal(
    incomingClassifyFirstBidiMessage(MessageType.PUBLISH_NAMESPACE),
    "unsupported-request",
  );
  assert.equal(
    incomingClassifyFirstBidiMessage(MessageType.SUBSCRIBE_NAMESPACE),
    "unsupported-request",
  );
  assert.equal(
    incomingClassifyFirstBidiMessage(MessageType.SUBSCRIBE_TRACKS),
    "unsupported-request",
  );
});

/**
 * draft-ietf-moq-transport-20 §3.3:
 * 「Bidirectional streams MUST NOT begin with any other message type unless
 * negotiated. If they do, the peer MUST close the Session with a
 * PROTOCOL_VIOLATION.」
 * 7 種以外のメッセージタイプ (未知タイプ等) は PROTOCOL_VIOLATION の対象。
 */
test("incomingClassifyFirstBidiMessage: 7 種以外は protocol-violation に分類される", () => {
  assert.equal(incomingClassifyFirstBidiMessage(0x99), "protocol-violation");
  assert.equal(incomingClassifyFirstBidiMessage(MessageType.GOAWAY), "protocol-violation");
  assert.equal(incomingClassifyFirstBidiMessage(MessageType.REQUEST_OK), "protocol-violation");
});

// ============================================================================
// incomingSendRequestErrorAndClose のテスト
// ============================================================================

/**
 * draft-ietf-moq-transport-20 §3.3.3 / §10.19:
 * REQUEST_ERROR を送信し、送信方向を FIN (writer.close()) で閉じ、受信方向を
 * cancel() で閉じることを検証する。
 */
test("incomingSendRequestErrorAndClose: REQUEST_ERROR を書き込み、FIN で閉じ、受信方向をキャンセルする", async () => {
  const events: string[] = [];
  const written: Uint8Array[] = [];
  let cancelReason: string | undefined;

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      events.push("write");
      written.push(chunk);
    },
    close() {
      events.push("close");
    },
  });
  const readable = new ReadableStream<Uint8Array>({
    cancel(reason) {
      cancelReason = reason as string;
    },
  });
  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;

  await incomingSendRequestErrorAndClose(
    stream,
    RequestErrorCode.NOT_SUPPORTED,
    "request type not supported",
  );

  // REQUEST_ERROR 書き込み → FIN (close) の順序
  assert.deepEqual(events, ["write", "close"]);
  // 書き込まれたバイト列は REQUEST_ERROR メッセージ
  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  const decoded = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.NOT_SUPPORTED));
  assert.equal(decoded.reasonPhrase, "request type not supported");
  // 受信方向がキャンセルされる (STOP_SENDING 相当)
  assert.equal(cancelReason, "request rejected");
});

/**
 * write が失敗した場合でも受信方向がキャンセルされ、例外が外に漏れない
 * (Promise が resolve する) ことを検証する。
 * write 失敗は writable がエラー状態 (ピアの RESET_STREAM / セッション終了等)
 * の場合のみ発生し、その場合はストリームが QUIC レベルで既にクローズされて
 * いるため FIN は送信しない。
 */
test("incomingSendRequestErrorAndClose: write 失敗時も受信方向をキャンセルし例外を漏らさない", async () => {
  let cancelled = false;
  const writable = new WritableStream<Uint8Array>({
    write() {
      throw new Error("write failed");
    },
  });
  const readable = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;

  await incomingSendRequestErrorAndClose(
    stream,
    RequestErrorCode.NOT_SUPPORTED,
    "request type not supported",
  );

  assert.isTrue(cancelled);
});

/**
 * close (FIN) が失敗した場合でも受信方向がキャンセルされ、例外が外に漏れない
 * ことを検証する。
 */
test("incomingSendRequestErrorAndClose: close 失敗時も受信方向をキャンセルし例外を漏らさない", async () => {
  let cancelled = false;
  const writable = new WritableStream<Uint8Array>({
    write() {},
    close() {
      throw new Error("close failed");
    },
  });
  const readable = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;

  await incomingSendRequestErrorAndClose(
    stream,
    RequestErrorCode.NOT_SUPPORTED,
    "request type not supported",
  );

  assert.isTrue(cancelled);
});

// ============================================================================
// incomingHandleFirstBidiMessage のテスト
// ============================================================================

/**
 * 未対応リクエスト受信用のテストコンテキストを構築する。
 *
 * 実 incomingValidateRequestId に局所 Set を配線し、PUBLISH 経路と
 * 同一の検証で ID 消費・記録を行う (モックなし)。
 */
function createUnsupportedRequestTestContext(receivedRequestIds = new Set<bigint>()): {
  session: SessionInternal;
  receivedRequestIds: Set<bigint>;
  closed: { error?: SessionError };
} {
  const closed: { error?: SessionError } = {};
  const session = {
    emitDebug: () => {},
    closeWithError: (error: SessionError) => {
      closed.error = error;
    },
    validateIncomingRequestId: (requestId: bigint) =>
      incomingValidateRequestId(requestId, receivedRequestIds, (error) => {
        closed.error = error;
      }),
  } as unknown as SessionInternal;
  return { session, receivedRequestIds, closed };
}

/**
 * draft-ietf-moq-transport-20 §4 (Extensibility):
 * 「Limited endpoints SHOULD respond to any unsupported messages with the
 * appropriate NOT_SUPPORTED error code, rather than ignoring them.」
 * 未対応リクエストに REQUEST_ERROR (NOT_SUPPORTED) を応答して FIN で閉じ、
 * セッションを閉じずに true を返すことを検証する。
 */
test("incomingHandleFirstBidiMessage: 未対応リクエストに NOT_SUPPORTED を応答し true を返す", async () => {
  const events: string[] = [];
  const written: Uint8Array[] = [];
  let cancelReason: string | undefined;

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      events.push("write");
      written.push(chunk);
    },
    close() {
      events.push("close");
    },
  });
  const readable = new ReadableStream<Uint8Array>({
    cancel(reason) {
      cancelReason = reason as string;
    },
  });
  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;

  const ctx = createUnsupportedRequestTestContext();
  const session = ctx.session;

  const firstMsg: ControlMessage = {
    type: MessageType.SUBSCRIBE,
    payload: new Uint8Array([0x01]),
  };

  const result = await incomingHandleFirstBidiMessage(session, stream, firstMsg);

  assert.isTrue(result);
  // NOT_SUPPORTED 応答 → FIN (close)。セッションは閉じない
  assert.deepEqual(events, ["write", "close"]);
  assert.isUndefined(ctx.closed.error);
  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  assert.equal(messages.length, 1);
  const decoded = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.NOT_SUPPORTED));
  // 受信方向がキャンセルされる (STOP_SENDING 相当)
  assert.equal(cancelReason, "request rejected");
});

/**
 * draft-ietf-moq-transport-20 §10.1 (Request ID):
 * 未対応リクエストの先頭メッセージでもパリティを検証し、偶数 Request ID は
 * INVALID_REQUEST_ID でセッションを閉じることを検証する。
 * NOT_SUPPORTED 応答は行わない。
 */
test("incomingHandleFirstBidiMessage: 未対応リクエストの偶数 Request ID で INVALID_REQUEST_ID で閉じる", async () => {
  // 先頭 varint に偶数 Request ID を持つ SUBSCRIBE を注入する
  const events: string[] = [];
  const written: Uint8Array[] = [];

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      events.push("write");
      written.push(chunk);
    },
    close() {
      events.push("close");
    },
  });
  const readable = new ReadableStream<Uint8Array>({});
  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;
  const ctx = createUnsupportedRequestTestContext();
  const session = ctx.session;

  const result = await incomingHandleFirstBidiMessage(session, stream, {
    type: MessageType.SUBSCRIBE,
    payload: new Uint8Array([0x02]),
  });

  assert.isTrue(result);
  // INVALID_REQUEST_ID で閉じ、NOT_SUPPORTED 応答は行わない
  assert.isDefined(ctx.closed.error);
  assert.equal(ctx.closed.error.code, SessionErrorCode.INVALID_REQUEST_ID);
  assert.deepEqual(events, []);
  assert.equal(written.length, 0);
});

/**
 * draft-ietf-moq-transport-20 §10.1 (Request ID):
 * 未対応経路で消費済みの Request ID を持つ未対応リクエストで重複検出して
 * INVALID_REQUEST_ID で閉じることを検証する (未対応→未対応)。
 */
test("incomingHandleFirstBidiMessage: 消費済み Request ID の未対応リクエストで重複検出して閉じる", async () => {
  // 1 件目で Request ID を消費し、2 件目の同一 ID で重複検出する
  const makeStream = () =>
    ({
      readable: new ReadableStream<Uint8Array>({}),
      writable: new WritableStream<Uint8Array>(),
    }) as unknown as WebTransportBidirectionalStream;

  const firstCtx = createUnsupportedRequestTestContext();
  const firstResult = await incomingHandleFirstBidiMessage(firstCtx.session, makeStream(), {
    type: MessageType.SUBSCRIBE,
    payload: new Uint8Array([0x01]),
  });

  // 1 件目は NOT_SUPPORTED 応答でセッション継続し、ID が記録される
  assert.isTrue(firstResult);
  // プロパティの型絞り込みを残さないよう局所変数で未定義を確認する
  const errorAfterFirst: unknown = firstCtx.closed.error;
  assert.isUndefined(errorAfterFirst);
  assert.isTrue(firstCtx.receivedRequestIds.has(1n));

  // 2 件目は同一セッションの別ストリーム受信で重複検出する
  const secondResult = await incomingHandleFirstBidiMessage(firstCtx.session, makeStream(), {
    type: MessageType.SUBSCRIBE,
    payload: new Uint8Array([0x01]),
  });

  // 2 件目は重複で INVALID_REQUEST_ID で閉じる
  assert.isTrue(secondResult);
  assert.isDefined(firstCtx.closed.error);
  assert.equal(firstCtx.closed.error.code, SessionErrorCode.INVALID_REQUEST_ID);
});

/**
 * draft-ietf-moq-transport-20 §10.1 (Request ID):
 * PUBLISH 経路相当として同一検証関数で消費した ID を未対応受信に当てると
 * 重複検出することを検証する (同一関数・同一 Set の単位確認。
 * 生産の Set 共有は session.test.ts の cross-path テストで検証する)。
 */
test("incomingHandleFirstBidiMessage: 同一検証関数・同一 Set では重複検出して閉じる", async () => {
  // PUBLISH 経路相当として同一検証関数で Request ID を消費する
  const receivedRequestIds = new Set<bigint>();
  assert.isTrue(
    incomingValidateRequestId(1n, receivedRequestIds, () => {
      assert.fail("1 件目の消費で閉じてはならない");
    }),
  );
  const ctx = createUnsupportedRequestTestContext(receivedRequestIds);
  const stream = {
    readable: new ReadableStream<Uint8Array>(),
    writable: new WritableStream<Uint8Array>(),
  } as unknown as WebTransportBidirectionalStream;

  const result = await incomingHandleFirstBidiMessage(ctx.session, stream, {
    type: MessageType.SUBSCRIBE,
    payload: new Uint8Array([0x01]),
  });

  assert.isTrue(result);
  assert.isDefined(ctx.closed.error);
  assert.equal(ctx.closed.error.code, SessionErrorCode.INVALID_REQUEST_ID);
});

/**
 * 未対応リクエストのペイロードが空で先頭 varint が取れない場合は、
 * ペイロード破損として PROTOCOL_VIOLATION で閉じることを検証する。
 */
test("incomingHandleFirstBidiMessage: 空ペイロードの未対応リクエストで PROTOCOL_VIOLATION で閉じる", async () => {
  // 未対応 6 種の先頭は Request ID のため、空は破損である
  const ctx = createUnsupportedRequestTestContext();
  const stream = {
    readable: new ReadableStream<Uint8Array>(),
    writable: new WritableStream<Uint8Array>(),
  } as unknown as WebTransportBidirectionalStream;

  const result = await incomingHandleFirstBidiMessage(ctx.session, stream, {
    type: MessageType.SUBSCRIBE,
    payload: new Uint8Array(0),
  });

  assert.isTrue(result);
  assert.isDefined(ctx.closed.error);
  assert.equal(ctx.closed.error.code, SessionErrorCode.PROTOCOL_VIOLATION);
});

/**
 * draft-ietf-moq-transport-20 §10.1 (Request ID):
 * 未対応リクエストの先頭 varint が多バイト宣言の途中終端で取れない場合は、
 * ペイロード破損として PROTOCOL_VIOLATION で閉じることを検証する。
 * 空ペイロード版と対称な独立ケースである。
 */
test("incomingHandleFirstBidiMessage: 切詰め varint の未対応リクエストで PROTOCOL_VIOLATION で閉じる", async () => {
  // 多バイト varint の途中終端もペイロード破損として閉じる
  const ctx = createUnsupportedRequestTestContext();
  const stream = {
    readable: new ReadableStream<Uint8Array>(),
    writable: new WritableStream<Uint8Array>(),
  } as unknown as WebTransportBidirectionalStream;

  const result = await incomingHandleFirstBidiMessage(ctx.session, stream, {
    type: MessageType.SUBSCRIBE,
    payload: new Uint8Array([0x80]),
  });

  assert.isTrue(result);
  assert.isDefined(ctx.closed.error);
  assert.equal(ctx.closed.error.code, SessionErrorCode.PROTOCOL_VIOLATION);
});

/**
 * draft-ietf-moq-transport-20 §3.3:
 * 7 種以外のメッセージタイプで始まる双方向ストリームは PROTOCOL_VIOLATION
 * でセッションを閉じ、true を返すことを検証する。
 */
test("incomingHandleFirstBidiMessage: 7 種以外の先頭メッセージで PROTOCOL_VIOLATION でセッションを閉じ true を返す", async () => {
  let closedWithError: SessionError | undefined;
  const session = {
    closeWithError: (error: SessionError) => {
      closedWithError = error;
    },
  } as unknown as SessionInternal;
  const stream = {
    readable: new ReadableStream<Uint8Array>(),
    writable: new WritableStream<Uint8Array>(),
  } as unknown as WebTransportBidirectionalStream;

  const result = await incomingHandleFirstBidiMessage(session, stream, {
    type: 0x99,
    payload: new Uint8Array(0),
  });

  assert.isTrue(result);
  assert.isDefined(closedWithError);
  assert.equal(closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(
    closedWithError!.message.includes(
      "expected a request message as first message on incoming bidirectional stream",
    ),
  );
});

/**
 * draft-ietf-moq-transport-20 §3.3:
 * 先頭が PUBLISH の場合、false を返して呼び出し側 (SessionImpl) の従来の
 * 受信 PUBLISH 処理を継続させることを検証する。
 */
test("incomingHandleFirstBidiMessage: PUBLISH は false を返し従来処理を継続させる", async () => {
  let closedWithError: SessionError | undefined;
  const session = {
    closeWithError: (error: SessionError) => {
      closedWithError = error;
    },
  } as unknown as SessionInternal;
  const stream = {
    readable: new ReadableStream<Uint8Array>(),
    writable: new WritableStream<Uint8Array>(),
  } as unknown as WebTransportBidirectionalStream;

  const result = await incomingHandleFirstBidiMessage(session, stream, {
    type: MessageType.PUBLISH,
    payload: new Uint8Array(0),
  });

  assert.isFalse(result);
  assert.isUndefined(closedWithError);
});

/** Uint8Array 配列を連結するヘルパー */
function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// ============================================================================
// incomingValidateRequestId のテスト
// draft-ietf-moq-transport-20 §10.1 (Request ID)
// ============================================================================

/**
 * draft-ietf-moq-transport-20 §10.1:
 * 「If an endpoint receives a Request ID where the least significant bit is
 *  incorrect for the sender, or a duplicate Request ID, it MUST close the
 *  session with INVALID_REQUEST_ID.」
 * moqt-js はクライアントロールのため、受信 Request ID はサーバー発の奇数が
 * 期待値。偶数の Request ID は INVALID_REQUEST_ID でセッションを閉じる。
 */
test("incomingValidateRequestId: 偶数 Request ID で INVALID_REQUEST_ID", () => {
  const received = new Set<bigint>();
  let closedWithError: SessionError | undefined;

  const result = incomingValidateRequestId(2n, received, (error) => {
    closedWithError = error;
  });

  assert.isFalse(result);
  assert.isDefined(closedWithError);
  assert.equal(closedWithError!.code, SessionErrorCode.INVALID_REQUEST_ID);
  assert.isTrue(closedWithError!.message.includes("parity"));
  // 違反時は Set に add しない
  assert.equal(received.size, 0);
});

/**
 * draft-ietf-moq-transport-20 §10.1:
 * 正常な奇数 Request ID は検証を通過し、Set に記録される。
 */
test("incomingValidateRequestId: 奇数 Request ID は通過して Set に記録される", () => {
  const received = new Set<bigint>();
  let closedWithError: SessionError | undefined;

  const result = incomingValidateRequestId(1n, received, (error) => {
    closedWithError = error;
  });

  assert.isTrue(result);
  assert.isUndefined(closedWithError);
  assert.isTrue(received.has(1n));
});

/**
 * draft-ietf-moq-transport-20 §10.1:
 * 同一 Request ID の再出現は INVALID_REQUEST_ID でセッションを閉じる。
 */
test("incomingValidateRequestId: 重複 Request ID で INVALID_REQUEST_ID", () => {
  const received = new Set<bigint>([1n]);
  let closedWithError: SessionError | undefined;

  const result = incomingValidateRequestId(1n, received, (error) => {
    closedWithError = error;
  });

  assert.isFalse(result);
  assert.isDefined(closedWithError);
  assert.equal(closedWithError!.code, SessionErrorCode.INVALID_REQUEST_ID);
  assert.isTrue(closedWithError!.message.includes("duplicate"));
});

/**
 * draft-ietf-moq-transport-20 §10.1:
 * パリティ検証を通過した Request ID は、その後の拒否経路 (予約 namespace 拒否 /
 * UNINTERESTED 等) で return されても Set に記録され、同一 ID の再送が検出
 * されることを検証する。
 */
test("incomingValidateRequestId: 検証通過後に Set へ add され再送が検出される", () => {
  const received = new Set<bigint>();
  let closedWithError: SessionError | undefined;

  // 1 回目: 検証通過 + add
  const first = incomingValidateRequestId(1n, received, (error) => {
    closedWithError = error;
  });
  assert.isTrue(first);

  // 2 回目: 同一 ID は重複として検出される
  const second = incomingValidateRequestId(1n, received, (error) => {
    closedWithError = error;
  });
  assert.isFalse(second);
  assert.isDefined(closedWithError);
  assert.equal(closedWithError!.code, SessionErrorCode.INVALID_REQUEST_ID);
});

/**
 * draft-ietf-moq-transport-20 §10.1:
 * 異なる奇数 Request ID はそれぞれ独立に検証を通過する。
 */
test("incomingValidateRequestId: 異なる奇数 Request ID は通過する", () => {
  const received = new Set<bigint>();
  let closedWithError: SessionError | undefined;

  const first = incomingValidateRequestId(1n, received, (error) => {
    closedWithError = error;
  });
  const second = incomingValidateRequestId(3n, received, (error) => {
    closedWithError = error;
  });

  assert.isTrue(first);
  assert.isTrue(second);
  assert.isUndefined(closedWithError);
  assert.deepEqual(
    [...received].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    [1n, 3n],
  );
});

// ============================================================================
// incomingHandleDatagram のテスト
// draft-ietf-moq-transport-20 §11.3.1 (Object Datagram)
// ============================================================================

/**
 * draft-ietf-moq-transport-20 §11.3.1:
 * 不完全な Object Datagram (varint が途中終端する構造破損) は、黙殺せず
 * PROTOCOL_VIOLATION でセッションが閉じることを検証する。datagram は
 * Length フレーミングを持たないが、原子配信のため不完全なフィールド構造は
 * 構造破損の意味しか持たない (toProtocolViolationSessionError の変換対象)。
 */
test("incomingHandleDatagram: 破損 datagram で PROTOCOL_VIOLATION でセッションが閉じる", () => {
  const ctx = createDatagramDeliveryTestContext();

  // 先頭バイト 0x80 は 2 バイト varint のプレフィックスだが、後続バイトが無い
  incomingHandleDatagram(ctx.session, new Uint8Array([0x80]));

  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
});

/**
 * datagram 配送用のテストコンテキストを構築する。
 *
 * session は受信に必要な最小面 (コールバック・購読 Map・close 記録) の
 * オブジェクトリテラルであり、Subscriber は実物を使う。
 */
function createDatagramDeliveryTestContext(): {
  session: SessionInternal;
  getClosedWithError: () => SessionError | undefined;
} {
  let closedWithError: SessionError | undefined;
  const session = {
    callbacks: {
      debug: () => {},
    },
    subscribersByAlias: new Map(),
    closeWithError: (error: SessionError) => {
      closedWithError = error;
    },
  } as unknown as SessionInternal;

  return {
    session,
    // 値コピーではなく getter で返す (closeWithError 呼び出し後の代入を反映する)
    getClosedWithError: () => closedWithError,
  };
}

/** 配送観測用の datagram ワイヤを組み立てる */
function objectDatagramWire(): Uint8Array {
  return encodeObjectDatagram({
    type: DatagramType.PAYLOAD_OBJ,
    trackAlias: 7n,
    groupId: 0n,
    objectId: 0n,
    publisherPriority: 128,
    payload: new Uint8Array([0xaa]),
  });
}

test("incomingHandleDatagram: datagram コールバックの例外は error 通知し残りの配送を継続する", () => {
  // 1 件目の購読で例外が起きても 2 件目に配送し、セッションは閉じない
  const ctx = createDatagramDeliveryTestContext();
  const appError = new Error("アプリの配送失敗");
  let notified: Error | undefined;
  let secondDelivered = 0;
  const throwing = new SubscriberImpl(
    ["test"],
    "track",
    0n,
    7n,
    () => {},
    () => {
      throw appError;
    },
    undefined,
    (error) => {
      notified = error;
    },
  );
  const second = new SubscriberImpl(["test"], "track", 1n, 7n, () => {
    secondDelivered++;
  });
  ctx.session.subscribersByAlias.set(7n, [throwing, second]);

  incomingHandleDatagram(ctx.session, objectDatagramWire());

  // 当該購読の error コールバックに届き、残りの配送が継続される
  assert.strictEqual(notified, appError);
  assert.equal(secondDelivered, 1);
  assert.isUndefined(ctx.getClosedWithError());
  // 例外を出した購読も active のままである
  assert.equal(throwing.state, "active");
});

test("incomingHandleDatagram: object コールバックの例外は error 通知し残りの配送を継続する", () => {
  // datagram コールバックなし (handleObject 経路) でも同様に通知する
  const ctx = createDatagramDeliveryTestContext();
  const appError = new Error("アプリの配送失敗");
  let notified: Error | undefined;
  let secondDelivered = 0;
  const throwing = new SubscriberImpl(
    ["test"],
    "track",
    0n,
    7n,
    () => {
      throw appError;
    },
    undefined,
    undefined,
    (error) => {
      notified = error;
    },
  );
  const second = new SubscriberImpl(["test"], "track", 1n, 7n, () => {
    secondDelivered++;
  });
  ctx.session.subscribersByAlias.set(7n, [throwing, second]);

  incomingHandleDatagram(ctx.session, objectDatagramWire());

  assert.strictEqual(notified, appError);
  assert.equal(secondDelivered, 1);
  assert.isUndefined(ctx.getClosedWithError());
  // 例外を出した購読も active のままである
  assert.equal(throwing.state, "active");
});

test("incomingHandleDatagram: デコード失敗では error コールバックに届かない", () => {
  // デコード失敗の扱いは変えない (close のみで error 通知なし)
  const ctx = createDatagramDeliveryTestContext();
  let notified: Error | undefined;
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    0n,
    7n,
    () => {},
    undefined,
    undefined,
    (error) => {
      notified = error;
    },
  );
  ctx.session.subscribersByAlias.set(7n, [subscriber]);

  // 先頭バイト 0x80 は 2 バイト varint のプレフィックスだが、後続バイトが無い
  incomingHandleDatagram(ctx.session, new Uint8Array([0x80]));

  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isUndefined(notified);
});

test("incomingHandleDatagram: デコード失敗で debug が throw しても閉じる処理を継続する", () => {
  // デバッグ記録自体の失敗は無視し、違反時の close を行う
  const ctx = createDatagramDeliveryTestContext();
  ctx.session.callbacks.debug = () => {
    throw new Error("debug の失敗");
  };

  // 先頭バイト 0x80 は 2 バイト varint のプレフィックスだが、後続バイトが無い
  incomingHandleDatagram(ctx.session, new Uint8Array([0x80]));

  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
});

test("incomingHandleDatagram: error コールバックの throw でも残りの配送を継続する", () => {
  // error コールバック自体の throw はデバッグ記録に残し、配送と受信を継続する
  const ctx = createDatagramDeliveryTestContext();
  const appError = new Error("アプリの配送失敗");
  let secondDelivered = 0;
  const throwing = new SubscriberImpl(
    ["test"],
    "track",
    0n,
    7n,
    () => {
      throw appError;
    },
    undefined,
    undefined,
    () => {
      throw new Error("error 通知の失敗");
    },
  );
  const second = new SubscriberImpl(["test"], "track", 1n, 7n, () => {
    secondDelivered++;
  });
  ctx.session.subscribersByAlias.set(7n, [throwing, second]);

  incomingHandleDatagram(ctx.session, objectDatagramWire());

  // 例外なく完走し、残りの配送が継続され、セッションは閉じない
  // (同一購読への再配送でも購読状態を壊さない)
  assert.equal(secondDelivered, 1);
  assert.isUndefined(ctx.getClosedWithError());
  // 同一購読への再配送でも throw せず完走する
  incomingHandleDatagram(ctx.session, objectDatagramWire());
  assert.equal(secondDelivered, 2);
});

test("incomingHandleDatagram: error コールバックなしの例外は黙殺し残りの配送を継続する", () => {
  // 通知先がない場合は例外が消え、残りの配送が継続される
  const ctx = createDatagramDeliveryTestContext();
  let secondDelivered = 0;
  const throwing = new SubscriberImpl(["test"], "track", 0n, 7n, () => {
    throw new Error("アプリの配送失敗");
  });
  const second = new SubscriberImpl(["test"], "track", 1n, 7n, () => {
    secondDelivered++;
  });
  ctx.session.subscribersByAlias.set(7n, [throwing, second]);

  incomingHandleDatagram(ctx.session, objectDatagramWire());

  assert.equal(secondDelivered, 1);
  assert.isUndefined(ctx.getClosedWithError());
});

test("incomingHandleDatagram: 複数購読の例外はそれぞれ通知する", () => {
  // 複数が同時に throw しても両方に届き、セッションは閉じない
  const ctx = createDatagramDeliveryTestContext();
  const firstError = new Error("1 件目の失敗");
  const secondError = new Error("2 件目の失敗");
  let firstNotified: Error | undefined;
  let secondNotified: Error | undefined;
  const first = new SubscriberImpl(
    ["test"],
    "track",
    0n,
    7n,
    () => {
      throw firstError;
    },
    undefined,
    undefined,
    (error) => {
      firstNotified = error;
    },
  );
  const second = new SubscriberImpl(
    ["test"],
    "track",
    1n,
    7n,
    () => {
      throw secondError;
    },
    undefined,
    undefined,
    (error) => {
      secondNotified = error;
    },
  );
  ctx.session.subscribersByAlias.set(7n, [first, second]);

  incomingHandleDatagram(ctx.session, objectDatagramWire());

  assert.strictEqual(firstNotified, firstError);
  assert.strictEqual(secondNotified, secondError);
  assert.isUndefined(ctx.getClosedWithError());
});

test("incomingHandleDatagram: error 通知中の unsubscribe でも残りの配送が欠落しない", () => {
  // error コールバック内で自購読を外しても (配列の破壊的変更)、
  // 反復前のスナップショットにより後続へ配送される
  const ctx = createDatagramDeliveryTestContext();
  const appError = new Error("アプリの配送失敗");
  let bDelivered = 0;
  let cDelivered = 0;
  const throwing = new SubscriberImpl(
    ["test"],
    "track",
    0n,
    7n,
    () => {
      throw appError;
    },
    undefined,
    undefined,
    () => {
      // bidiCancelSubscription と同形の同期的 splice で自購読を外す
      void throwing.unsubscribe();
    },
  );
  // unsubscribe 時の購読解除を同期的 splice で再現する
  throwing.onUnsubscribe = async () => {
    const list = ctx.session.subscribersByAlias.get(7n);
    if (list !== undefined) {
      const index = list.indexOf(throwing);
      if (index !== -1) {
        list.splice(index, 1);
      }
    }
  };
  const second = new SubscriberImpl(["test"], "track", 1n, 7n, () => {
    bDelivered++;
  });
  const third = new SubscriberImpl(["test"], "track", 2n, 7n, () => {
    cDelivered++;
  });
  ctx.session.subscribersByAlias.set(7n, [throwing, second, third]);

  incomingHandleDatagram(ctx.session, objectDatagramWire());

  // 外された購読より後の両方に配送され、セッションは閉じない
  assert.equal(bDelivered, 1);
  assert.equal(cDelivered, 1);
  assert.isUndefined(ctx.getClosedWithError());
});

test("incomingHandleDatagram: error コールバックの throw はデバッグ記録に残る", () => {
  // 通知失敗の内容を記録し、配送と受信を継続する
  const ctx = createDatagramDeliveryTestContext();
  const records: { typeName: string; decoded?: { error?: string } }[] = [];
  ctx.session.callbacks.debug = (message) => {
    records.push({
      typeName: message.typeName,
      decoded: message.decoded as { error?: string } | undefined,
    });
  };
  const appError = new Error("アプリの配送失敗");
  const callbackError = new Error("error 通知の失敗");
  let secondDelivered = 0;
  const throwing = new SubscriberImpl(
    ["test"],
    "track",
    0n,
    7n,
    () => {
      throw appError;
    },
    undefined,
    undefined,
    () => {
      throw callbackError;
    },
  );
  const second = new SubscriberImpl(["test"], "track", 1n, 7n, () => {
    secondDelivered++;
  });
  ctx.session.subscribersByAlias.set(7n, [throwing, second]);

  incomingHandleDatagram(ctx.session, objectDatagramWire());

  assert.equal(secondDelivered, 1);
  assert.isUndefined(ctx.getClosedWithError());
  assert.equal(records.length, 1);
  assert.equal(records[0].typeName, "DATAGRAM_CALLBACK_ERROR");
  assert.isTrue(records[0].decoded?.error?.includes("error 通知の失敗") ?? false);
});

test("incomingHandleDatagram: debug コールバックの throw でも配送を継続する", () => {
  // デバッグ記録自体の失敗は無視し、配送と受信を継続する
  const ctx = createDatagramDeliveryTestContext();
  ctx.session.callbacks.debug = () => {
    throw new Error("debug の失敗");
  };
  const appError = new Error("アプリの配送失敗");
  let secondDelivered = 0;
  const throwing = new SubscriberImpl(
    ["test"],
    "track",
    0n,
    7n,
    () => {
      throw appError;
    },
    undefined,
    undefined,
    () => {
      throw new Error("error 通知の失敗");
    },
  );
  const second = new SubscriberImpl(["test"], "track", 1n, 7n, () => {
    secondDelivered++;
  });
  ctx.session.subscribersByAlias.set(7n, [throwing, second]);

  incomingHandleDatagram(ctx.session, objectDatagramWire());

  assert.equal(secondDelivered, 1);
  assert.isUndefined(ctx.getClosedWithError());
});

// ============================================================================
// incomingWaitForFetcher のタイマー解放
// フォールバックタイマーは確定時に解放し、登録も解除する
// ============================================================================

/**
 * 登録済みの待機コールバックをすべて発火させる。
 *
 * 本番の broadcast (FETCH_OK 到着・セッション close) と同形に、
 * 登録解除しながら発火しても欠落しないよう複製して反復する。
 */
function fireAllFetcherCallbacks(session: SessionInternal): void {
  for (const callbacks of session.fetcherReadyCallbacks.values()) {
    for (const callback of callbacks.slice()) {
      callback();
    }
  }
}

/**
 * fetcher 待機用の最小 session を構築する。
 *
 * 実時間の短い timeout (30ms) を使い、モック / スタブなしで検証する。
 */
function createFetcherWaitTestContext(): {
  session: SessionInternal;
  requestId: bigint;
} {
  const requestId = 10n;
  const session = {
    fetchers: new Map(),
    pendingFetch: new Map([[requestId, {}]]),
    fetcherReadyCallbacks: new Map(),
  } as unknown as SessionInternal;
  return { session, requestId };
}

test("incomingWaitForFetcher: タイムアウト発火で登録を解除して null を返す", async () => {
  // FETCH_OK が来ない場合は短い timeout で null になる。
  // タイマー解放自体は直接観測できないため、登録解除を代理指標とする
  const { session, requestId } = createFetcherWaitTestContext();

  const result = await incomingWaitForFetcher(session, requestId, 30);

  assert.isNull(result);
  // タイムアウト先行発火時は登録を解除し、後続 FETCH_OK まで stale にしない
  assert.isFalse(session.fetcherReadyCallbacks.has(requestId));
});

test("incomingWaitForFetcher: 早期解決で登録を解除する", async () => {
  // FETCH_OK 到着相当でコールバック発火させると、タイマー確定前に解決する。
  // タイマー解放自体は直接観測できないため、登録解除と解決値を代理指標とする
  const { session, requestId } = createFetcherWaitTestContext();
  const fetcher = new FetcherImpl(["test"], "track", requestId, () => {});

  const waiting = incomingWaitForFetcher(session, requestId, 100);
  session.fetchers.set(requestId, fetcher);
  fireAllFetcherCallbacks(session);
  const result = await waiting;

  assert.strictEqual(result, fetcher);
  assert.isFalse(session.fetcherReadyCallbacks.has(requestId));
  // 発火予定時刻を過ぎても結果が変わらない (二重解決しない)
  await new Promise<void>((resolve) => {
    setTimeout(() => resolve(), 120);
  });
  assert.strictEqual(await waiting, fetcher);
  assert.isFalse(session.fetcherReadyCallbacks.has(requestId));
});

test("incomingWaitForFetcher: 複数待機者は全員解決し登録が残らない", async () => {
  // 1 件目の解決による登録解除で 2 件目が欠落しない。
  // 2 件目の timer を長くし、コールバック発火 (即時) と timer 代替 (遅延) を
  // 経過時間で区別する
  const { session, requestId } = createFetcherWaitTestContext();
  const fetcher = new FetcherImpl(["test"], "track", requestId, () => {});

  const first = incomingWaitForFetcher(session, requestId, 100);
  const second = incomingWaitForFetcher(session, requestId, 1000);
  session.fetchers.set(requestId, fetcher);
  const started = Date.now();
  fireAllFetcherCallbacks(session);

  assert.strictEqual(await first, fetcher);
  assert.strictEqual(await second, fetcher);
  // コールバック発火なら即時解決する (timer 代替なら 1000ms 掛かる)
  assert.isBelow(Date.now() - started, 500);
  assert.isFalse(session.fetcherReadyCallbacks.has(requestId));
});

test("incomingWaitForFetcher: セッション close 相当の発火で全員解決し登録が残らない", async () => {
  // close 処理と同形に全コールバックを発火させる。自前の clear() は行わず、
  // 各待機の自己登録解除だけで空になることを断定する
  const { session, requestId } = createFetcherWaitTestContext();

  const first = incomingWaitForFetcher(session, requestId, 100);
  const second = incomingWaitForFetcher(session, requestId, 100);
  fireAllFetcherCallbacks(session);

  assert.isNull(await first);
  assert.isNull(await second);
  assert.isFalse(session.fetcherReadyCallbacks.has(requestId));
});

test("incomingWaitForFetcher: 不明なリクエストは即座に null を返す", async () => {
  // pendingFetch にない場合は待機もタイマーも作らない
  const { session } = createFetcherWaitTestContext();
  session.pendingFetch.clear();

  const result = await incomingWaitForFetcher(session, 99n, 30);

  assert.isNull(result);
  assert.isFalse(session.fetcherReadyCallbacks.has(99n));
});
