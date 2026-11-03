/**
 * session/bidi.ts の単体テスト: リクエストストリームの受信上限の配線
 *
 * draft-ietf-moq-transport-23 §9.1.8:
 * リクエストストリーム上の制御メッセージも MAX_CONTROL_MESSAGE_SIZE の上限に従う。
 * bidiSendRequestOnBidiStream が生成する ControlStreamReader にセッションの
 * 受信上限が配線されていることを検証する。既定値 (65535) と異なる上限で
 * 生成された reader が超過を検出できることを確認する。
 * テスト用の最小のセッション代役と実 W3C ストリームで検証する
 * (モックライブラリは使わない)。
 */

import { test, assert } from "vite-plus/test";
import { ControlStreamWriter } from "../controlStream";
import { SessionError, SessionErrorCode } from "../error";
import { MessageType } from "../message/types";
import { bidiSendRequestOnBidiStream, type BidiSessionInternal } from "./bidi";

test("bidiSendRequestOnBidiStream: リクエストストリームの reader をセッションの受信上限で作る", async () => {
  const written: Uint8Array[] = [];
  const writer = {
    write: async (data: Uint8Array): Promise<void> => {
      written.push(data);
    },
    abort: async (): Promise<void> => {},
    releaseLock: (): void => {},
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;
  const stream = {
    readable: new ReadableStream<Uint8Array>({ start() {} }),
    writable: { getWriter: (): unknown => writer },
  } as unknown as WebTransportBidirectionalStream;
  const session = {
    sessionState: "connected",
    transport: {
      createBidirectionalStream: async (): Promise<WebTransportBidirectionalStream> => stream,
    },
    controlWriter: new ControlStreamWriter(),
    // 既定値 (65535) と異なる上限にして、生成された reader への配線を区別できるようにする
    localMaxControlMessageSize: 4,
    peerMaxControlMessageSize: 65535,
    nextRequestId: 0n,
    requestStreams: new Map(),
    statsControlMessagesSent: 0,
    emitDebug: (): void => {},
  } as unknown as BidiSessionInternal;

  const streamInfo = await bidiSendRequestOnBidiStream(
    session,
    0n,
    MessageType.SUBSCRIBE,
    new Uint8Array([0x01]),
  );

  // 送信したメッセージは制御メッセージとしてフレーミングされている
  assert.equal(written.length, 1);

  // 生成された reader はセッションの受信上限 4 で作られているため、本文長 5 の
  // 宣言だけで FIELD_LENGTH_EXCEEDED になる (既定値 65535 の reader では失敗しない)
  let error: unknown;
  try {
    streamInfo.controlReader.feed(new Uint8Array([0x10, 0x05]));
  } catch (caught) {
    error = caught;
  }
  assert.instanceOf(error, SessionError);
  assert.equal((error as SessionError).code, SessionErrorCode.FIELD_LENGTH_EXCEEDED);
});
