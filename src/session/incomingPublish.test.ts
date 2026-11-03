/**
 * session/incomingPublish.ts の単体テスト: 受信 PUBLISH ストリームの受信上限
 *
 * draft-ietf-moq-transport-23 §9.1.8 / §9:
 * 受信 PUBLISH ストリームで扱う制御メッセージも MAX_CONTROL_MESSAGE_SIZE の上限に
 * 従う。incomingPublishHandleBidirectionalStream が生成する ControlStreamReader に
 * セッションの受信上限が配線されていることと、上限超過時に FIELD_LENGTH_EXCEEDED で
 * セッションを閉じることを検証する。
 *
 * テスト用の最小のセッション代役と実 W3C ストリームで検証する
 * (モックライブラリは使わない)。代役は上限超過の経路が参照する状態と副作用だけを持つ。
 */

import { test, assert } from "vite-plus/test";
import { SessionError, SessionErrorCode } from "../error";
import { SubscriberImpl } from "../subscriber";
import { ControlStreamReader } from "../controlStream";
import { REQUEST_UPDATE_STREAM_CLOSED_MESSAGE } from "./namespaceLoops";
import {
  incomingPublishHandleBidirectionalStream,
  incomingPublishRunStreamSubLoop,
  type IncomingPublishSessionInternal,
} from "./incomingPublish";

/**
 * 先頭メッセージの受信上限を検証するための最小のセッション代役
 *
 * 先頭メッセージの上限超過では読み取りが失敗して即座に戻るため、
 * この経路が参照する sessionState / closeWithError / notifyErrorIfActive だけを持つ。
 * 本番の sessionClose は同期的に sessionState を closed にするため、closeWithError も
 * 同じ副作用を持つようにする。
 */
function createOverLimitSession(localMaxControlMessageSize: number): {
  session: IncomingPublishSessionInternal;
  closed: SessionError[];
  notified: Error[];
} {
  const closed: SessionError[] = [];
  const notified: Error[] = [];
  const session = {
    sessionState: "connected",
    // 仕様の最小値 65535 未満のテスト専用値。既定値と異なる上限にして、
    // 生成された reader への配線を区別できるようにする。
    localMaxControlMessageSize,
    peerMaxControlMessageSize: 65535,
    closeWithError: (error: SessionError): void => {
      closed.push(error);
      session.sessionState = "closed";
    },
    notifyErrorIfActive: (error: Error): void => {
      // 本番と同じく、閉じたセッションでは通知しない
      if (session.sessionState !== "connected") {
        return;
      }
      notified.push(error);
    },
  } as unknown as IncomingPublishSessionInternal;
  return { session, closed, notified };
}

test("incomingPublishHandleBidirectionalStream: 先頭メッセージの reader をセッションの受信上限で作る", async () => {
  const { session, closed, notified } = createOverLimitSession(4);
  const stream = {
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        // Type 0x10 + Message Length 5 (vi64 の [0x05])。上限 4 を超える宣言
        controller.enqueue(new Uint8Array([0x10, 0x05]));
      },
    }),
  } as unknown as WebTransportBidirectionalStream;

  await incomingPublishHandleBidirectionalStream(session, stream);

  // 生成された reader はセッションの受信上限 4 で作られているため、本文長 5 の
  // 宣言だけで FIELD_LENGTH_EXCEEDED になる
  assert.equal(closed.length, 1);
  assert.equal(closed[0]?.code, SessionErrorCode.FIELD_LENGTH_EXCEEDED);
  // closeWithError が sessionState を closed にするため、追加の error 通知は起きない
  assert.equal(notified.length, 0);
});

/**
 * draft-ietf-moq-transport-23 §9:
 * 受信 PUBLISH のサブループで制御メッセージの Message Length がローカル上限を
 * 超えた場合、購読者への error 通知と保留中 REQUEST_UPDATE の reject を行って
 * から、FIELD_LENGTH_EXCEEDED でセッションを 1 回だけ閉じる。
 *
 * セッション終了を通知より先に実行すると、sessionClose が購読を closed にするため
 * 購読者への error 通知が消える。ここではテスト用の代役でも closeWithError が
 * 購読を closed にする副作用を持ち、close を通知より前へ動かす退行を検出できる
 * ようにする。
 */
test("incomingPublishRunStreamSubLoop: 上限超過で購読者通知と reject を行ってから 1 回だけ閉じる", async () => {
  const publishRequestId = 10n;
  const events: string[] = [];
  const closedWithError: SessionError[] = [];
  const rejectedUpdateErrors: Error[] = [];
  const impl = new SubscriberImpl(
    ["live"],
    "video",
    publishRequestId,
    7n,
    () => {},
    undefined,
    undefined,
    (error: Error) => {
      events.push("subscriberError");
      assert.instanceOf(error, SessionError);
      assert.equal((error as SessionError).code, SessionErrorCode.FIELD_LENGTH_EXCEEDED);
    },
  );

  // 応答待ちの REQUEST_UPDATE を 1 件注入し、reject の文言を検証できるようにする
  const session = {
    sessionState: "connected",
    pendingRequestUpdate: new Map([
      [
        100n,
        {
          resolve: (): void => {},
          reject: (error: Error): void => {
            rejectedUpdateErrors.push(error);
          },
          targetRequestId: publishRequestId,
        },
      ],
    ]),
    subscribers: new Map([[publishRequestId, impl]]),
    goawayReceivedOnRequestStreams: new Set<bigint>(),
    emitDebug: (): void => {},
    closeWithError: (error: SessionError): void => {
      // 本番の sessionClose と同じく、close の副作用として購読を closed にする
      events.push("close");
      impl.markClosed();
      session.sessionState = "closed";
      closedWithError.push(error);
    },
  } as unknown as IncomingPublishSessionInternal;

  // 仕様の最小値 65535 未満のテスト専用値。本文長 5 の宣言だけで
  // FIELD_LENGTH_EXCEEDED を起こせる上限にする。
  const subControlReader = new ControlStreamReader(4);
  const subReader = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0x10, 0x05]));
    },
  }).getReader();

  try {
    await incomingPublishRunStreamSubLoop(
      session,
      impl,
      publishRequestId,
      subReader,
      subControlReader,
    );
  } finally {
    subReader.releaseLock();
  }

  // 購読者への error 通知 → セッション終了の順序で、セッション終了は 1 回だけ
  assert.deepEqual(events, ["subscriberError", "close"]);
  assert.equal(closedWithError.length, 1);
  assert.equal(closedWithError[0]?.code, SessionErrorCode.FIELD_LENGTH_EXCEEDED);
  // 保留中の REQUEST_UPDATE はストリーム終了の文言で reject される
  assert.equal(rejectedUpdateErrors.length, 1);
  assert.equal(rejectedUpdateErrors[0]?.message, REQUEST_UPDATE_STREAM_CLOSED_MESSAGE);
  // 購読は closed になる
  assert.equal(impl.state, "closed");
});
