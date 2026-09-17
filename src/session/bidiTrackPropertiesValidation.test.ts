/**
 * session/bidi.ts の単体テスト: validateRequestOkNoTrackProperties と未知 Mandatory Track Property
 *
 * 空必須メッセージの Track Properties 検証と、未知 Mandatory Track
 * Property の受信時の挙動を検証する。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import { encodeRequestOkPayload } from "../message/session";
import { MessageType, GroupOrder } from "../message/types";
import { SessionError, SessionErrorCode } from "../error";
import { PublisherImpl } from "../publisher";
import {
  bidiReadPublishResponse,
  bidiReadRequestStreamMessages,
  validateRequestOkNoTrackProperties,
} from "./bidi";
import { createPublishReadTestContext, createOkResponseReadTestContext } from "../testSupport/bidi";

// ============================================================================
// validateRequestOkNoTrackProperties のテスト
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.3 (REQUEST_OK):
 * 非空の Track Properties は PROTOCOL_VIOLATION の SessionError を返す。
 * 空配列で検証を通過する受理側の性質は、任意のコンテキスト名と任意の
 * Track Properties に対して src/session/bidi.prop.ts の PBT で検証する。
 */
test("validateRequestOkNoTrackProperties: 非空の Track Properties は PROTOCOL_VIOLATION のエラーを返す", () => {
  const error = validateRequestOkNoTrackProperties([{ id: 0x1n, value: 0n }], "PUBLISH_OK");
  if (error === null) {
    assert.fail("PROTOCOL_VIOLATION の SessionError を期待したが null だった");
  }
  assert.equal(error.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.equal(error.message, "track properties must be empty in PUBLISH_OK");
});

// ============================================================================
// 空必須メッセージの未知 Mandatory Track Property
// draft-ietf-moq-transport-21 §9.3 (REQUEST_OK) / §3.6 (Mandatory Track Properties)
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.3:
 * 「they are empty in PUBLISH_OK, REQUEST_UPDATE_OK, SUBSCRIBE_NAMESPACE_OK and
 *  PUBLISH_NAMESPACE_OK.  If an endpoint receives Track Properties in one of
 *  these messages it MUST close the session with a PROTOCOL_VIOLATION.」
 * 未知 Mandatory Track Property (0x4000-0x7FFF) は decodeRequestOkPayload の
 * decodeProperties が MalformedTrackError を throw するため、既知 Type の非空を
 * 検出する validateRequestOkNoTrackProperties には到達しない。応答リーダーの
 * handleMalformedTrack で PROTOCOL_VIOLATION へ変換して閉じる。
 */
test("bidiReadPublishResponse: 未知 Mandatory Track Property で PROTOCOL_VIOLATION で閉じる", async () => {
  const ctx = createOkResponseReadTestContext();
  const publisher = new PublisherImpl(["test"], "track", ctx.requestId, 1n, () => {});
  let rejected: Error | undefined;
  ctx.session.pendingPublish.set(ctx.requestId, {
    resolve: () => {},
    reject: (error: Error) => {
      ctx.order.push("reject");
      rejected = error;
    },
    impl: publisher,
  });

  const readPromise = bidiReadPublishResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  const okPayload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [{ id: 0x4000n, value: 1n }],
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.REQUEST_OK, okPayload));
  ctx.readableController.close();
  await readPromise;

  // 具体エラー (PROTOCOL_VIOLATION) で reject され、同一オブジェクトで閉じる
  assert.instanceOf(rejected, SessionError);
  assert.equal((rejected as SessionError).code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue((rejected as SessionError).message.includes("unknown mandatory track property"));
  assert.strictEqual(rejected, ctx.getClosedWithError());
  // reject してから閉じる順序である
  assert.deepEqual(ctx.order, ["reject", "close"]);
  assert.isFalse(ctx.session.pendingPublish.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §9.3 / §3.6:
 * subscribe ロールの確立後 REQUEST_OK (REQUEST_UPDATE_OK) に未知 Mandatory
 * Track Property (0x4000-0x7FFF) を含めた場合も PROTOCOL_VIOLATION で閉じ、
 * 保留中の更新を同一の SessionError で reject する (update() のハング防止)。
 * fill 関連付けも失敗確定として掃除する。
 */
test("bidiReadRequestStreamMessages: REQUEST_UPDATE_OK の未知 Mandatory Track Property で PROTOCOL_VIOLATION で閉じる", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  let rejected: Error | undefined;
  ctx.session.pendingRequestUpdate.set(90n, {
    resolve: () => {},
    reject: (err: Error) => {
      rejected = err;
    },
    targetRequestId: ctx.requestId,
  });
  ctx.session.fillFetchTargets.set(90n, { subscriber, groupOrder: GroupOrder.ASCENDING });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  const okPayload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [{ id: 0x4000n, value: 1n }],
  });
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.REQUEST_OK, okPayload),
  );
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(ctx.closedWithError!.message.includes("unknown mandatory track property"));
  // 保留中の更新は違反 SessionError 自体で reject され、エントリと fill 関連付けが消える
  assert.strictEqual(rejected, ctx.closedWithError);
  assert.isFalse(ctx.session.pendingRequestUpdate.has(90n));
  assert.isFalse(ctx.session.fillFetchTargets.has(90n));
});
