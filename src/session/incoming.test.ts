/**
 * session/incoming.ts の受信 bidi ストリーム先頭ディスパッチのテスト
 *
 * 実 W3C ストリーム (`ReadableStream` + `WritableStream`) を
 * `as unknown as WebTransportBidirectionalStream` で注入する方式は
 * session/bidi.test.ts と同型である。
 */

import { test, assert } from "vite-plus/test";
import { MessageType, encodeTrackNamespace, createTrackNamespace } from "../message";
import { decodeRequestErrorPayload } from "../message/session";
import { MalformedTrackError, RequestErrorCode, SessionError, SessionErrorCode } from "../error";
import {
  concatUint8Arrays,
  priorGroupIdGapProperties,
  priorObjectIdGapProperties,
} from "../testSupport/helpers";
import { ControlStreamReader, type ControlMessage } from "../controlStream";
import {
  incomingHandleDatagram,
  incomingHandleFirstBidiMessage,
  incomingProcessFetchObjects,
  incomingProcessSubgroupObjects,
  incomingSendRequestErrorAndClose,
  incomingValidateRequestId,
} from "./incoming";
import type { SessionInternal } from "./types";
import { SubscriberImpl } from "../subscriber";
import { DatagramType, encodeObjectDatagram } from "../dataStream";
import {
  createFirstFetchObjectFlags,
  encodeFetchObjectFields,
  encodeObjectFields,
  SubgroupHeaderType,
  type FetchObjectFields,
  type MoqtObject,
  type SubgroupHeader,
} from "../dataStream";
import { encodeProperties } from "../properties";
import { fullTrackNameKey } from "../fullTrackName";
import { GroupOrder } from "../message/types";
import { concatChunks, type FetchObjectSink } from "./stream";

// ============================================================================
// incomingSendRequestErrorAndClose のテスト
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §6.4.2.3 / §9.15:
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
      incomingValidateRequestId(requestId, receivedRequestIds),
  } as unknown as SessionInternal;
  return { session, receivedRequestIds, closed };
}

/**
 * draft-ietf-moq-transport-21 §1.5 (Extensibility):
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
 * draft-ietf-moq-transport-21 §2.4.2 (Reserved Namespaces) / §6.5
 * (Session-Level Tracks and Namespaces):
 * "An endpoint that receives a request for an unrecognized session-level track or
 *  namespace MUST reject it with REQUEST_ERROR using error code DOES_NOT_EXIST
 *  rather than passing it to the Application."
 * 未対応リクエストでも先頭の Track Namespace を読み、"." 単体または ".session" なら
 * DOES_NOT_EXIST で拒否する (NOT_SUPPORTED ではない)。
 */
test("incomingHandleFirstBidiMessage: 未対応リクエストの .session namespace は DOES_NOT_EXIST", async () => {
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
  const readable = new ReadableStream<Uint8Array>({
    cancel() {
      events.push("cancel");
    },
  });
  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;

  const ctx = createUnsupportedRequestTestContext();
  const payload = concatUint8Arrays([
    new Uint8Array([0x01]),
    encodeTrackNamespace(createTrackNamespace([".session"])),
  ]);
  const firstMsg: ControlMessage = { type: MessageType.SUBSCRIBE, payload };

  const result = await incomingHandleFirstBidiMessage(ctx.session, stream, firstMsg);

  assert.isTrue(result);
  assert.isUndefined(ctx.closed.error);
  // REQUEST_ERROR を書いて FIN し、受信方向を cancel する (§6.4.2.3)
  assert.deepEqual(events, ["write", "close", "cancel"]);
  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  assert.equal(messages.length, 1);
  const decoded = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.DOES_NOT_EXIST));
});

/**
 * draft-ietf-moq-transport-21 §2.4.2:
 * "." 単体の namespace も同じく DOES_NOT_EXIST で拒否する。
 */
test("incomingHandleFirstBidiMessage: 未対応リクエストの単一ピリオド namespace は DOES_NOT_EXIST", async () => {
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
  const readable = new ReadableStream<Uint8Array>({
    cancel() {
      events.push("cancel");
    },
  });
  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;

  const ctx = createUnsupportedRequestTestContext();
  const payload = concatUint8Arrays([
    new Uint8Array([0x01]),
    encodeTrackNamespace(createTrackNamespace(["."])),
  ]);
  const firstMsg: ControlMessage = { type: MessageType.TRACK_STATUS, payload };

  const result = await incomingHandleFirstBidiMessage(ctx.session, stream, firstMsg);

  assert.isTrue(result);
  assert.isUndefined(ctx.closed.error);
  assert.deepEqual(events, ["write", "close", "cancel"]);
  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  assert.equal(messages.length, 1);
  const decoded = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.DOES_NOT_EXIST));
});

/**
 * draft-ietf-moq-transport-21 §2.4.2 (Reserved Namespaces) / §6.5
 * (Session-Level Tracks and Namespaces):
 * 未対応 6 種はいずれも Request ID の直後に Track Namespace (SUBSCRIBE_NAMESPACE /
 * SUBSCRIBE_TRACKS は Track Namespace Prefix) を置く。種類によらず先頭の
 * Namespace を読んで判定できることを、6 種すべてで検証する。
 */
test("incomingHandleFirstBidiMessage: 未対応 6 種すべてで予約名前空間は DOES_NOT_EXIST", async () => {
  const types = [
    MessageType.SUBSCRIBE,
    MessageType.FETCH,
    MessageType.TRACK_STATUS,
    MessageType.PUBLISH_NAMESPACE,
    MessageType.SUBSCRIBE_NAMESPACE,
    MessageType.SUBSCRIBE_TRACKS,
  ];
  for (const type of types) {
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
        events.push("cancel");
        cancelReason = reason as string;
      },
    });
    const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;

    // ctx は種類ごとに作るため、Request ID は同じ値を使い回せる
    const ctx = createUnsupportedRequestTestContext();
    const payload = concatUint8Arrays([
      new Uint8Array([0x01]),
      encodeTrackNamespace(createTrackNamespace([".session"])),
    ]);

    const result = await incomingHandleFirstBidiMessage(ctx.session, stream, { type, payload });

    assert.isTrue(result, `type=0x${type.toString(16)}`);
    assert.isUndefined(ctx.closed.error, `type=0x${type.toString(16)}`);
    assert.deepEqual(events, ["write", "close", "cancel"], `type=0x${type.toString(16)}`);
    assert.equal(cancelReason, "request rejected");
    const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
    assert.equal(messages.length, 1);
    assert.equal(
      decodeRequestErrorPayload(messages[0].payload).errorCode,
      BigInt(RequestErrorCode.DOES_NOT_EXIST),
      `type=0x${type.toString(16)}`,
    );
  }
});

/**
 * 予約名前空間でない未対応リクエストは従来どおり NOT_SUPPORTED を返す
 * (Namespace が読めても予約でなければ SHOULD の応答を変えない)。
 */
test("incomingHandleFirstBidiMessage: 未対応リクエストの通常 namespace は NOT_SUPPORTED", async () => {
  const written: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      written.push(chunk);
    },
  });
  const readable = new ReadableStream<Uint8Array>({});
  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;

  const ctx = createUnsupportedRequestTestContext();
  const payload = concatUint8Arrays([
    new Uint8Array([0x01]),
    encodeTrackNamespace(createTrackNamespace(["live"])),
  ]);
  const firstMsg: ControlMessage = { type: MessageType.SUBSCRIBE, payload };

  await incomingHandleFirstBidiMessage(ctx.session, stream, firstMsg);

  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  assert.equal(messages.length, 1);
  const decoded = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.NOT_SUPPORTED));
});

/**
 * Track Namespace をデコードできない未対応リクエスト (Request ID のみ) は、
 * 予約名前空間の判定を行わず NOT_SUPPORTED を返す。
 * 未対応メッセージの本体が本実装の想定と異なっていても、判定の例外で
 * セッションを閉じたり応答を変えたりしない。
 */
test("incomingHandleFirstBidiMessage: Namespace が読めない未対応リクエストは NOT_SUPPORTED", async () => {
  const written: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      written.push(chunk);
    },
  });
  const readable = new ReadableStream<Uint8Array>({});
  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;

  const ctx = createUnsupportedRequestTestContext();
  // Request ID のみで Track Namespace が無い (切詰め)
  const firstMsg: ControlMessage = { type: MessageType.SUBSCRIBE, payload: new Uint8Array([0x01]) };

  await incomingHandleFirstBidiMessage(ctx.session, stream, firstMsg);

  assert.isUndefined(ctx.closed.error);
  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  assert.equal(messages.length, 1);
  const decoded = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.NOT_SUPPORTED));
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.1 (Request ID):
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
 * draft-ietf-moq-transport-21 §6.4.2.1 (Request ID):
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
 * draft-ietf-moq-transport-21 §6.4.2.1 (Request ID):
 * PUBLISH 経路相当として同一検証関数で消費した ID を未対応受信に当てると
 * 重複検出することを検証する (同一関数・同一 Set の単位確認。
 * 生産の Set 共有は session.test.ts の cross-path テストで検証する)。
 */
test("incomingHandleFirstBidiMessage: 同一検証関数・同一 Set では重複検出して閉じる", async () => {
  // PUBLISH 経路相当として同一検証関数で Request ID を消費する
  const receivedRequestIds = new Set<bigint>();
  assert.isNull(incomingValidateRequestId(1n, receivedRequestIds));
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
 * draft-ietf-moq-transport-21 §6.4.2.1 (Request ID):
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
 * draft-ietf-moq-transport-21 §6.3:
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
 * draft-ietf-moq-transport-21 §6.3:
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

// ============================================================================
// incomingHandleDatagram のテスト
// draft-ietf-moq-transport-21 §11.2.1 (Object Datagram)
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §11.2.1:
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
 * draft-ietf-moq-transport-21 §3.6 / §12.1:
 * Object Property に Mandatory Track Property (0x4000-0x7FFF) を含む datagram は
 * malformed であり、当該購読を cancel してセッションは閉じないことを検証する。
 */
test("incomingHandleDatagram: Mandatory Track Property で購読を cancel しセッションを閉じない", () => {
  const ctx = createDatagramDeliveryTestContext();
  let delivered = 0;
  let notified: Error | undefined;
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    0n,
    7n,
    () => {
      delivered++;
    },
    undefined,
    undefined,
    (error) => {
      notified = error;
    },
  );
  ctx.session.subscribersByAlias.set(7n, [subscriber]);
  ctx.session.subscribers.set(0n, subscriber);

  const wire = encodeObjectDatagram({
    type: DatagramType.PAYLOAD_OBJ_EXT,
    trackAlias: 7n,
    groupId: 0n,
    objectId: 0n,
    publisherPriority: 128,
    properties: encodeProperties([{ id: 0x4000n, value: 0n }]),
    payload: new Uint8Array([0xaa]),
  });

  incomingHandleDatagram(ctx.session, wire);

  // 配送されず、error が通知され、セッションは閉じない
  assert.equal(delivered, 0);
  assert.isDefined(notified);
  assert.isUndefined(ctx.getClosedWithError());
  // alias から購読が外れる
  assert.equal((ctx.session.subscribersByAlias.get(7n) ?? []).length, 0);
  // 購読は closed になる
  assert.equal(subscriber.state, "closed");
});

/**
 * draft-ietf-moq-transport-21 §3.6 / §12.1 / §2.4.1:
 * datagram の malformed 検出は trackAlias から得た購読の比較キーで対象 Track を
 * 決める。namespace ["a"] + trackName "b/c" と namespace ["a","b"] + trackName "c"
 * は "/" 連結では同じ "a/b/c" になるため、区切り文字の曖昧さで同一 alias に
 * ぶら下がる別 Track を巻き込む退行が起き得る。対象 Track だけが cancel される
 * ことを固定する。
 */
test("incomingHandleDatagram: 同一 alias の区切り文字が衝突する別 Track を cancel しない", () => {
  const ctx = createDatagramDeliveryTestContext();
  let targetNotified: Error | undefined;
  let collidingNotified: Error | undefined;
  // 対象 Track (namespace ["a","b"] + trackName "c")。実装は先頭の購読の
  // 比較キーで対象 Track を決めるため、先頭に置く。
  const target = new SubscriberImpl(
    ["a", "b"],
    "c",
    0n,
    7n,
    () => {},
    undefined,
    undefined,
    (error) => {
      targetNotified = error;
    },
  );
  // 旧実装で同じキー ("a/b/c") になっていた別 Track (namespace ["a"] + trackName "b/c")
  const colliding = new SubscriberImpl(
    ["a"],
    "b/c",
    1n,
    7n,
    () => {},
    undefined,
    undefined,
    (error) => {
      collidingNotified = error;
    },
  );
  // 同一 alias に別 Track の購読がぶら下がる状態を作る
  ctx.session.subscribersByAlias.set(7n, [target, colliding]);
  ctx.session.subscribers.set(0n, target);
  ctx.session.subscribers.set(1n, colliding);

  const wire = encodeObjectDatagram({
    type: DatagramType.PAYLOAD_OBJ_EXT,
    trackAlias: 7n,
    groupId: 0n,
    objectId: 0n,
    publisherPriority: 128,
    properties: encodeProperties([{ id: 0x4000n, value: 0n }]),
    payload: new Uint8Array([0xaa]),
  });

  incomingHandleDatagram(ctx.session, wire);

  // 対象 Track だけが cancel され、衝突する別 Track は活性のまま
  assert.isDefined(targetNotified);
  assert.equal(target.state, "closed");
  assert.isUndefined(collidingNotified);
  assert.equal(colliding.state, "active");
  // セッションは閉じない
  assert.isUndefined(ctx.getClosedWithError());
});

/**
 * draft-ietf-moq-transport-21 §8.3:
 * "If a receiver understands a Type, and the following Value or Length/Value
 *  does not match the serialization defined by that Type, the receiver MUST
 *  close the session with error code KEY_VALUE_FORMATTING_ERROR."
 * datagram の Object Properties でも既知 Type の Length 宣言超過はエラーコードを
 * 保持してセッションを閉じる。
 */
test("incomingHandleDatagram: 既知 Type の Length 宣言超過で KEY_VALUE_FORMATTING_ERROR", () => {
  const ctx = createDatagramDeliveryTestContext();

  // deltaId=0x0B (IMMUTABLE_PROPERTIES), length=5 宣言 + 2 バイトの切り詰め
  const wire = encodeObjectDatagram({
    type: DatagramType.PAYLOAD_OBJ_EXT,
    trackAlias: 7n,
    groupId: 0n,
    objectId: 0n,
    publisherPriority: 128,
    properties: new Uint8Array([0x0b, 0x05, 0xaa, 0xbb]),
    payload: new Uint8Array([0xaa]),
  });

  incomingHandleDatagram(ctx.session, wire);

  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
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
    subscribers: new Map(),
    fetchers: new Map(),
    requestStreams: new Map(),
    pendingSubscribe: new Map(),
    pendingFetch: new Map(),
    pendingRequestUpdate: new Map(),
    fillFetchTargets: new Map(),
    // draft-ietf-moq-transport-21 §10.8 / §10.9: Track 単位の Prior ID Gap 追跡
    priorGapTrackingByTrack: new Map(),
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

/** 追跡検証用の datagram ワイヤを組み立てる (Properties 省略は gap を持たない Object) */
function trackingDatagramWire(
  groupId: bigint,
  objectId: bigint,
  properties?: Uint8Array,
): Uint8Array {
  return encodeObjectDatagram({
    type: properties === undefined ? DatagramType.PAYLOAD_OBJ : DatagramType.PAYLOAD_OBJ_EXT,
    trackAlias: 7n,
    groupId,
    objectId,
    publisherPriority: 128,
    ...(properties === undefined ? {} : { properties }),
    payload: new Uint8Array([0xaa]),
  });
}

/**
 * draft-ietf-moq-transport-21 §10.8 / §10.9 / §12.1:
 * datagram 経路でも Track 横断の Prior ID Gap 条件を検出する。検出した Object は
 * 配送せず、同一 Track の購読を cancel し、セッションは閉じない。
 */
test("incomingHandleDatagram: 通知済み Prior Group ID Gap 内の Group ID で購読を cancel しセッションを閉じない", () => {
  const ctx = createDatagramDeliveryTestContext();
  let delivered = 0;
  let notified: Error | undefined;
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    0n,
    7n,
    () => {
      delivered++;
    },
    undefined,
    undefined,
    (error) => {
      notified = error;
    },
  );
  ctx.session.subscribersByAlias.set(7n, [subscriber]);
  ctx.session.subscribers.set(0n, subscriber);

  // 1 通目: Group 10 の Object 0 が Group 8 と 9 の不在を通知する
  incomingHandleDatagram(ctx.session, trackingDatagramWire(10n, 0n, priorGroupIdGapProperties(2n)));
  assert.equal(delivered, 1);

  // 2 通目: 通知済みの不在 Group 9 の Object を受信した
  incomingHandleDatagram(ctx.session, trackingDatagramWire(9n, 0n));

  // malformed の Object は配送されず、error が通知され、セッションは閉じない
  assert.equal(delivered, 1);
  assert.instanceOf(notified, MalformedTrackError);
  assert.isUndefined(ctx.getClosedWithError());
  // 購読は cancel され alias から外れる
  assert.equal(subscriber.state, "closed");
  assert.equal((ctx.session.subscribersByAlias.get(7n) ?? []).length, 0);
});

/**
 * draft-ietf-moq-transport-21 §10.8 / §10.9:
 * datagram は Track Alias から購読を特定できた場合だけ追跡検証の対象になる。
 * 購読の無い alias の datagram は検証も追跡状態の作成もしない。
 */
test("incomingHandleDatagram: 購読の無い alias の datagram は追跡検証しない", () => {
  const ctx = createDatagramDeliveryTestContext();

  // alias 7 に購読が無い状態で、不在を通知する datagram と通知済み範囲の
  // Group ID を持つ datagram を続けて受信する
  incomingHandleDatagram(ctx.session, trackingDatagramWire(10n, 0n, priorGroupIdGapProperties(2n)));
  incomingHandleDatagram(ctx.session, trackingDatagramWire(9n, 0n));

  // 検証対象外であり、セッションも閉じず追跡状態も作られない
  assert.isUndefined(ctx.getClosedWithError());
  assert.equal(ctx.session.priorGapTrackingByTrack.size, 0);
});

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

/**
 * subgroup fan-out 配送用のテストコンテキストを構築する。
 *
 * session は受信に必要な最小面 (debug コールバック・統計カウンタ) の
 * オブジェクトリテラルであり、Subscriber は実物を使う。
 */
function createSubgroupDeliveryTestContext(hooks: { debugError?: Error } = {}): {
  session: SessionInternal;
  debugRecords: unknown[];
} {
  const debugRecords: unknown[] = [];
  const session = {
    callbacks: {
      debug: (message: unknown) => {
        if (hooks.debugError) {
          throw hooks.debugError;
        }
        debugRecords.push(message);
      },
    },
    statsObjectsReceivedViaSubscribe: 0,
    statsBytesReceivedViaSubscribe: 0,
    // draft-ietf-moq-transport-21 §12.1 条件 4: Group 単位の最終 Object 追跡
    receivedEndOfGroupFinalObjectIds: new Map<string, bigint>(),
    // draft-ietf-moq-transport-21 §10.8 / §10.9: Track 単位の Prior ID Gap 追跡
    priorGapTrackingByTrack: new Map(),
  } as unknown as SessionInternal;
  return { session, debugRecords };
}

/** subgroup 単一オブジェクト 1 件分のワイヤを組み立てる */
function subgroupObjectWire(objectIdDelta: bigint, payload: number): Uint8Array {
  const fields = encodeObjectFields(objectIdDelta, 1n, SubgroupHeaderType.FIRST_OBJ);
  return concatChunks([fields, new Uint8Array([payload])]);
}

function subgroupTestHeader(): SubgroupHeader {
  return { type: SubgroupHeaderType.FIRST_OBJ, trackAlias: 7n, groupId: 0n, firstObject: false };
}

test("incomingProcessSubgroupObjects: 非 Error の throw を正規化して通知し継続する", () => {
  // 本番フックの Error 正規化を直接検証する。
  // 非 Error 値は変数経由で送出する (リテラル throw は lint 対象のため)
  const nonError: unknown = "boom";
  const { session, debugRecords } = createSubgroupDeliveryTestContext();
  const notified: Error[] = [];
  const delivered: number[] = [];
  const throwing = new SubscriberImpl(
    ["test"],
    "track",
    0n,
    7n,
    () => {
      throw nonError;
    },
    undefined,
    undefined,
    (error) => {
      notified.push(error);
    },
  );
  const second = new SubscriberImpl(["test"], "track", 1n, 7n, () => {
    delivered.push(1);
  });

  incomingProcessSubgroupObjects(
    session,
    subgroupObjectWire(0n, 0xaa),
    [throwing, second],
    subgroupTestHeader(),
    -1n,
  );

  assert.equal(notified.length, 1);
  assert.isTrue(notified[0] instanceof Error);
  assert.strictEqual(notified[0].message, "boom");
  assert.equal(delivered.length, 1);
  assert.equal(debugRecords.length, 0);
});

test("incomingProcessSubgroupObjects: error コールバックの throw を debug 記録し継続する", () => {
  // 本番フックの debug 記録内容を直接検証する
  const { session, debugRecords } = createSubgroupDeliveryTestContext();
  const delivered: number[] = [];
  const throwing = new SubscriberImpl(
    ["test"],
    "track",
    0n,
    7n,
    () => {
      throw new Error("app failed");
    },
    undefined,
    undefined,
    () => {
      throw new Error("error callback failed");
    },
  );
  const second = new SubscriberImpl(["test"], "track", 1n, 7n, () => {
    delivered.push(1);
  });

  incomingProcessSubgroupObjects(
    session,
    subgroupObjectWire(0n, 0xaa),
    [throwing, second],
    subgroupTestHeader(),
    -1n,
  );

  assert.equal(delivered.length, 1);
  assert.equal(debugRecords.length, 1);
  const record = debugRecords[0] as {
    typeName: string;
    decoded: { error: string };
    payload: Uint8Array;
  };
  assert.strictEqual(record.typeName, "SUBGROUP_CALLBACK_ERROR");
  assert.strictEqual(record.decoded.error, "error callback failed");
  assert.deepEqual([...record.payload], [0xaa]);
});

test("incomingProcessSubgroupObjects: debug 自体の throw でも継続する", () => {
  // デバッグ記録の失敗を握り潰すことの検証
  const { session, debugRecords } = createSubgroupDeliveryTestContext({
    debugError: new Error("debug failed"),
  });
  const delivered: number[] = [];
  const throwing = new SubscriberImpl(
    ["test"],
    "track",
    0n,
    7n,
    () => {
      throw new Error("app failed");
    },
    undefined,
    undefined,
    () => {
      throw new Error("error callback failed");
    },
  );
  const second = new SubscriberImpl(["test"], "track", 1n, 7n, () => {
    delivered.push(1);
  });

  incomingProcessSubgroupObjects(
    session,
    subgroupObjectWire(0n, 0xaa),
    [throwing, second],
    subgroupTestHeader(),
    -1n,
  );

  assert.equal(delivered.length, 1);
  assert.equal(debugRecords.length, 0);
});

// ============================================================================
// Track 横断の Prior ID Gap 追跡
// draft-ietf-moq-transport-21 §10.8 (Prior Group ID Gap) / §10.9 (Prior Object ID Gap)
// ============================================================================

/** 追跡検証用の subgroup 単一オブジェクト 1 件分のワイヤを組み立てる */
function subgroupTrackingWire(objectIdDelta: bigint, properties: Uint8Array): Uint8Array {
  const fields = encodeObjectFields(
    objectIdDelta,
    1n,
    SubgroupHeaderType.FIRST_OBJ_EXT,
    undefined,
    properties,
  );
  return concatChunks([fields, new Uint8Array([0xaa])]);
}

/** 追跡検証用の subgroup ヘッダを組み立てる */
function subgroupTrackingHeader(groupId: bigint, propertiesPresent: boolean): SubgroupHeader {
  return {
    type: propertiesPresent ? SubgroupHeaderType.FIRST_OBJ_EXT : SubgroupHeaderType.FIRST_OBJ,
    trackAlias: 7n,
    groupId,
    // FIRST_OBJ / FIRST_OBJ_EXT は先頭 Object の Object ID を明示する型である
    firstObject: true,
  };
}

/**
 * draft-ietf-moq-transport-21 §10.8 / §10.9:
 * Subgroup は Full Track Name を直接持たないため、Track Alias から引いた購読の
 * 比較キーで追跡状態を更新する。Subgroup ストリームをまたいだ 2 件目で、1 件目が
 * 通知した不在 Group の受信を検出する。
 */
test("incomingProcessSubgroupObjects: 購読の比較キーで追跡状態を更新し Subgroup ストリームをまたいで検出する", () => {
  const { session } = createSubgroupDeliveryTestContext();
  const delivered: number[] = [];
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 7n, () => {
    delivered.push(1);
  });

  // 1 本目: Group 10 の Object 0 が Group 8 と 9 の不在を通知する
  incomingProcessSubgroupObjects(
    session,
    subgroupTrackingWire(0n, priorGroupIdGapProperties(2n)),
    [subscriber],
    subgroupTrackingHeader(10n, true),
    -1n,
  );
  assert.equal(delivered.length, 1);
  // 追跡状態は購読が持つ比較キー (Full Track Name の比較キー) で引かれる
  assert.isTrue(session.priorGapTrackingByTrack.has(subscriber.getFullTrackNameKey()));

  // 2 本目 (別 Subgroup ストリーム): 通知済みの不在 Group 9 の Object を受信した
  assert.throws(
    () =>
      incomingProcessSubgroupObjects(
        session,
        subgroupObjectWire(0n, 0xaa),
        [subscriber],
        subgroupTrackingHeader(9n, false),
        -1n,
      ),
    MalformedTrackError,
  );
  // malformed の Object は配送しない
  assert.equal(delivered.length, 1);
});

/**
 * Fetch 経路の追跡検証用テストコンテキストを構築する。
 *
 * session は統計と追跡マップだけを持つオブジェクトリテラルであり、配送先は
 * FetchObjectSink 契約を実装した実オブジェクトを使う。
 */
function createFetchTrackingTestContext(): {
  session: SessionInternal;
  delivered: MoqtObject[];
  sink: FetchObjectSink;
} {
  const session = {
    statsObjectsReceivedViaFetch: 0,
    statsObjectsReceivedViaFill: 0,
    statsBytesReceivedViaFetch: 0,
    statsBytesReceivedViaFill: 0,
    priorGapTrackingByTrack: new Map(),
  } as unknown as SessionInternal;
  const delivered: MoqtObject[] = [];
  const sink: FetchObjectSink = {
    handleObject: (object) => {
      delivered.push(object);
    },
  };
  return { session, delivered, sink };
}

/** Fetch の先頭 Object 1 件分のワイヤを組み立てる (Properties 省略は gap 無し) */
function fetchTrackingWire(
  groupId: bigint,
  objectId: bigint,
  payload: number,
  properties?: Uint8Array,
): Uint8Array {
  const fields: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(properties !== undefined),
    groupId,
    subgroupId: 1n,
    objectId,
    publisherPriority: 100,
    ...(properties === undefined ? {} : { properties }),
    payloadLength: 1n,
  };
  return concatChunks([encodeFetchObjectFields(fields), new Uint8Array([payload])]);
}

/**
 * draft-ietf-moq-transport-21 §10.8 / §10.9:
 * FETCH 経路は呼び出し側が渡す Track の比較キーで追跡状態を更新する。
 * 同じ Track の 2 件目で、1 件目が通知した不在 Object の受信を検出し、
 * 別 Track のキーでは追跡状態を共有しない。
 */
test("incomingProcessFetchObjects: trackKey の追跡状態で Prior Object ID Gap を検出する", () => {
  const { session, delivered, sink } = createFetchTrackingTestContext();
  const trackKey = fullTrackNameKey(["test"], "track");

  // 1 件目: Group 3 の Object 8 を配送する
  incomingProcessFetchObjects(
    session,
    fetchTrackingWire(3n, 8n, 0xaa),
    sink,
    null,
    true,
    GroupOrder.ASCENDING,
    false,
    trackKey,
  );
  assert.equal(delivered.length, 1);

  // 2 件目: 同じ Group の Object 10 が Object 8 と 9 の不在を通知し、
  // 受信済みの Object 8 を覆うため MalformedTrackError になる
  assert.throws(
    () =>
      incomingProcessFetchObjects(
        session,
        fetchTrackingWire(3n, 10n, 0xbb, priorObjectIdGapProperties(2n)),
        sink,
        null,
        true,
        GroupOrder.ASCENDING,
        false,
        trackKey,
      ),
    MalformedTrackError,
  );
  assert.equal(delivered.length, 1);

  // 別 Track のキーでは追跡状態を共有しないため、同じ Object も配送される
  incomingProcessFetchObjects(
    session,
    fetchTrackingWire(3n, 10n, 0xcc, priorObjectIdGapProperties(2n)),
    sink,
    null,
    true,
    GroupOrder.ASCENDING,
    false,
    fullTrackNameKey(["test"], "other"),
  );
  assert.equal(delivered.length, 2);
});
