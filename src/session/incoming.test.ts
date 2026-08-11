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
  incomingHandleFirstBidiMessage,
  incomingSendRequestErrorAndClose,
} from "./incoming";
import type { SessionInternal } from "./types";

// ============================================================================
// incomingClassifyFirstBidiMessage のテスト
// ============================================================================

/**
 * draft-ietf-moq-transport-19 §3.3:
 * 受信 bidi ストリームの先頭が PUBLISH の場合、従来の受信 PUBLISH 処理を
 * 継続する ("publish" 分類)。
 */
test("incomingClassifyFirstBidiMessage: PUBLISH は publish に分類される", () => {
  assert.equal(incomingClassifyFirstBidiMessage(MessageType.PUBLISH), "publish");
});

/**
 * draft-ietf-moq-transport-19 §3.3:
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
 * draft-ietf-moq-transport-19 §3.3:
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
 * draft-ietf-moq-transport-19 §3.3.3 / §10.19:
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
 * draft-ietf-moq-transport-19 §4 (Extensibility):
 * 「Limited endpoints SHOULD respond to any unsupported messages with the
 * appropriate NOT_SUPPORTED error code, rather than ignoring them.」
 * 未対応リクエストに REQUEST_ERROR (NOT_SUPPORTED) を応答して FIN で閉じ、
 * セッションを閉じずに true を返すことを検証する。
 */
test("incomingHandleFirstBidiMessage: 未対応リクエストに NOT_SUPPORTED を応答し true を返す", async () => {
  const events: string[] = [];
  const written: Uint8Array[] = [];
  let cancelReason: string | undefined;
  let closedWithError: SessionError | undefined;

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

  const session = {
    emitDebug: () => {},
    closeWithError: (error: SessionError) => {
      closedWithError = error;
    },
  } as unknown as SessionInternal;

  const firstMsg: ControlMessage = {
    type: MessageType.SUBSCRIBE,
    payload: new Uint8Array(0),
  };

  const result = await incomingHandleFirstBidiMessage(session, stream, firstMsg);

  assert.isTrue(result);
  // NOT_SUPPORTED 応答 → FIN (close)。セッションは閉じない
  assert.deepEqual(events, ["write", "close"]);
  assert.isUndefined(closedWithError);
  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  assert.equal(messages.length, 1);
  const decoded = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.NOT_SUPPORTED));
  // 受信方向がキャンセルされる (STOP_SENDING 相当)
  assert.equal(cancelReason, "request rejected");
});

/**
 * draft-ietf-moq-transport-19 §3.3:
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
 * draft-ietf-moq-transport-19 §3.3:
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
