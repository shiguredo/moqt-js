/**
 * session/bidi.ts の単体テスト: bidiHandlePublishStateNotify
 *
 * PUBLISH_STATE_NOTIFY のパラメータ反映と違反検出を検証する。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import { type MoqtObject } from "../dataStream";
import { ObjectStatus } from "../message";
import { encodePublishStateNotifyPayload } from "../message/session";
import { MessageType, MessageParameterType } from "../message/types";
import { encodeLocationFilterParameter } from "../message/parameter";
import { SessionErrorCode } from "../error";
import { encodeVarint, MAX_VARINT } from "../varint";
import { bidiReadRequestStreamMessages } from "./bidi";
import { waitForMacrotask, createPublishReadTestContext } from "../testSupport/bidi";

// ============================================================================
// bidiHandlePublishStateNotify のテスト
// draft-ietf-moq-transport-21 §9.10 (PUBLISH_STATE_NOTIFY)
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.10:
 * subscribe ロールで publisher 発の PUBLISH_STATE_NOTIFY を受信した場合、
 * presence のパラメータが subscriber 状態に反映され、応答は送信しないことを
 * 検証する。
 */
test("bidiReadRequestStreamMessages: PUBLISH_STATE_NOTIFY (subscribe ロール) で状態が反映され応答しない", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  // LARGEST_OBJECT ({7, 2}) + FORWARD=0 + LOCATION_FILTER を通知する
  const notifyPayload = encodePublishStateNotifyPayload({
    type: MessageType.PUBLISH_STATE_NOTIFY,
    parameters: [
      { type: MessageParameterType.LARGEST_OBJECT, value: new Uint8Array([0x07, 0x02]) },
      { type: MessageParameterType.FORWARD, value: new Uint8Array([0]) },
      encodeLocationFilterParameter({ startGroup: 10n, startObject: 2n }),
    ],
  });
  const message = ctx.session.controlWriter!.encode(
    MessageType.PUBLISH_STATE_NOTIFY,
    notifyPayload,
  );
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // LARGEST_OBJECT / FORWARD が反映される。FIN による error 通知は別経路
  assert.deepEqual(subscriber.largestLocation, { group: 7n, object: 2n });
  assert.isFalse(subscriber.forwardState);
  // 応答は送信されない (自方向 FIN の close のみ)
  assert.deepEqual(ctx.events, ["close"]);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.10:
 * 同じ内容の LOCATION_FILTER を含む PUBLISH_STATE_NOTIFY が届いても、
 * 直前で反映した LARGEST_OBJECT による再解決で開始位置が前進しないことを
 * 検証する。仕様は値の変化したパラメータのみを運ぶと定めるため、再報告は
 * 適合 peer では起きないが、起きた場合に受信済み範囲の Object を破棄しない。
 *
 * 相対指定 { startGroup: 1n } は LARGEST_OBJECT {10, 0} の時点で開始 Group 10 に
 * 解決される。LARGEST_OBJECT {20, 0} を反映した後も開始 Group 10 のままで
 * あることを、Group 10 の Object が配信されることで確認する。
 */
test("bidiReadRequestStreamMessages: 同じ LOCATION_FILTER の PUBLISH_STATE_NOTIFY で開始位置が前進しない", async () => {
  const ctx = createPublishReadTestContext({});
  const received: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, (object) => {
    received.push(object);
  });
  // SUBSCRIBE_OK 相当: LARGEST_OBJECT {10, 0} で相対フィルタを解決する
  subscriber.setLargestLocation({ group: 10n, object: 0n });
  subscriber.setLocationFilter({ startGroup: 1n });
  subscriber.resolveLocationFilter();
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  // LARGEST_OBJECT を {20, 0} へ進め、同じ相対 LOCATION_FILTER を再報告する
  const notifyPayload = encodePublishStateNotifyPayload({
    type: MessageType.PUBLISH_STATE_NOTIFY,
    parameters: [
      { type: MessageParameterType.LARGEST_OBJECT, value: new Uint8Array([0x14, 0x00]) },
      encodeLocationFilterParameter({ startGroup: 1n }),
    ],
  });
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.PUBLISH_STATE_NOTIFY, notifyPayload),
  );
  // 読み取りループが PUBLISH_STATE_NOTIFY を処理するまで待つ。FIN を送ると
  // PUBLISH_DONE 無しの失敗扱いで購読が closed になり handleObject が
  // 何も配信しなくなるため、検証は FIN の前に行う。
  await waitForMacrotask();

  // LARGEST_OBJECT は反映される
  assert.deepEqual(subscriber.largestLocation, { group: 20n, object: 0n });
  // 開始位置は購読確立時の Group 10 のまま (再解決による前進をしない)
  subscriber.handleObject({
    groupId: 10n,
    objectId: 0n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array(),
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].groupId, 10n);
  assert.isUndefined(ctx.closedWithError);

  ctx.readableController.close();
  await readPromise;
});

/**
 * draft-ietf-moq-transport-21 §9.10:
 * 値の変化した LOCATION_FILTER は従来どおり反映されることを検証する。
 * 等価判定で再解決を避ける対象は「同じ内容の再報告」だけであり、
 * 変化したフィルタの適用を止めてはならない。
 *
 * 相対指定 { startGroup: 0n } は LARGEST_OBJECT {20, 0} の時点で開始 Group 21 に
 * 解決される。Group 10 の Object は破棄され、Group 21 の Object が配信される。
 */
test("bidiReadRequestStreamMessages: 変化した LOCATION_FILTER の PUBLISH_STATE_NOTIFY は反映される", async () => {
  const ctx = createPublishReadTestContext({});
  const received: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, (object) => {
    received.push(object);
  });
  subscriber.setLargestLocation({ group: 10n, object: 0n });
  subscriber.setLocationFilter({ startGroup: 1n });
  subscriber.resolveLocationFilter();
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  const notifyPayload = encodePublishStateNotifyPayload({
    type: MessageType.PUBLISH_STATE_NOTIFY,
    parameters: [
      { type: MessageParameterType.LARGEST_OBJECT, value: new Uint8Array([0x14, 0x00]) },
      encodeLocationFilterParameter({ startGroup: 0n }),
    ],
  });
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.PUBLISH_STATE_NOTIFY, notifyPayload),
  );
  // 検証は FIN の前に行う (FIN は PUBLISH_DONE 無しの失敗扱いで購読を closed にする)
  await waitForMacrotask();

  // 変化したフィルタが LARGEST_OBJECT {20, 0} で再解決される (開始 Group 21)
  subscriber.handleObject({
    groupId: 10n,
    objectId: 0n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array(),
  });
  assert.equal(received.length, 0);
  subscriber.handleObject({
    groupId: 21n,
    objectId: 0n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array(),
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].groupId, 21n);
  assert.isUndefined(ctx.closedWithError);

  ctx.readableController.close();
  await readPromise;
});

/**
 * draft-ietf-moq-transport-21 §9.10:
 * FORWARD を省略した PUBLISH_STATE_NOTIFY では Forward State が不変であることを
 * 検証する (省略時は不変)。
 */
test("bidiReadRequestStreamMessages: FORWARD 省略の PUBLISH_STATE_NOTIFY では Forward State は不変", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  subscriber.setForwardState(false);
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  // LARGEST_OBJECT のみを通知する
  const notifyPayload = encodePublishStateNotifyPayload({
    type: MessageType.PUBLISH_STATE_NOTIFY,
    parameters: [
      { type: MessageParameterType.LARGEST_OBJECT, value: new Uint8Array([0x07, 0x02]) },
    ],
  });
  const message = ctx.session.controlWriter!.encode(
    MessageType.PUBLISH_STATE_NOTIFY,
    notifyPayload,
  );
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // LARGEST_OBJECT は反映され、FORWARD 省略で Forward State は不変
  assert.deepEqual(subscriber.largestLocation, { group: 7n, object: 2n });
  assert.isFalse(subscriber.forwardState);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.10 / §9.20.1:
 * 許可外パラメータを含む PUBLISH_STATE_NOTIFY を受信した場合、
 * PROTOCOL_VIOLATION でセッションを閉じることを検証する。
 */
test("bidiReadRequestStreamMessages: 許可外パラメータの PUBLISH_STATE_NOTIFY でセッションが閉じる", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  // SUBSCRIBER_PRIORITY (0x20) は本メッセージに許可されない
  const notifyPayload = encodePublishStateNotifyPayload({
    type: MessageType.PUBLISH_STATE_NOTIFY,
    parameters: [{ type: MessageParameterType.SUBSCRIBER_PRIORITY, value: new Uint8Array([10]) }],
  });
  const message = ctx.session.controlWriter!.encode(
    MessageType.PUBLISH_STATE_NOTIFY,
    notifyPayload,
  );
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  // スコープ違反の具体エラーであることがメッセージから分かる
  assert.isTrue(
    ctx.closedWithError!.message.includes(
      "parameter type 0x20 not allowed in PUBLISH_STATE_NOTIFY",
    ),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * End Group 超過の LOCATION_FILTER を含む PUBLISH_STATE_NOTIFY を受信した場合、
 * PROTOCOL_VIOLATION でセッションを閉じることを検証する。
 */
test("bidiReadRequestStreamMessages: End Group 超過の LOCATION_FILTER の PUBLISH_STATE_NOTIFY でセッションが閉じる", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  // StartGroup=MAX_VARINT + StartObject=0 + EndGroupDelta=1 で超過
  const fields = new Uint8Array([
    ...encodeVarint(MAX_VARINT),
    ...encodeVarint(0n),
    ...encodeVarint(1n),
  ]);
  const overflowValue = new Uint8Array([...encodeVarint(BigInt(fields.length)), ...fields]);
  const notifyPayload = encodePublishStateNotifyPayload({
    type: MessageType.PUBLISH_STATE_NOTIFY,
    parameters: [{ type: MessageParameterType.LOCATION_FILTER, value: overflowValue }],
  });
  const message = ctx.session.controlWriter!.encode(
    MessageType.PUBLISH_STATE_NOTIFY,
    notifyPayload,
  );
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
});

/**
 * draft-ietf-moq-transport-21 §9.10:
 * publish ロール (対向 subscriber 発) で PUBLISH_STATE_NOTIFY を受信した場合、
 * PROTOCOL_VIOLATION でセッションを閉じることを検証する。
 */
test("bidiReadRequestStreamMessages: PUBLISH_STATE_NOTIFY (publish ロール) ではセッションが閉じる", async () => {
  const ctx = createPublishReadTestContext({});

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  const notifyPayload = encodePublishStateNotifyPayload({
    type: MessageType.PUBLISH_STATE_NOTIFY,
    parameters: [
      { type: MessageParameterType.LARGEST_OBJECT, value: new Uint8Array([0x07, 0x02]) },
    ],
  });
  const message = ctx.session.controlWriter!.encode(
    MessageType.PUBLISH_STATE_NOTIFY,
    notifyPayload,
  );
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // subscriber 発の通知は仕様違反であり、セッションを閉じる
  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
});

/**
 * draft-ietf-moq-transport-21 §9.20.19:
 * FORWARD の値域外 (0/1 以外) を含む PUBLISH_STATE_NOTIFY を受信した場合、
 * PROTOCOL_VIOLATION でセッションを閉じることを検証する。
 */
test("bidiReadRequestStreamMessages: FORWARD の値域外の PUBLISH_STATE_NOTIFY でセッションが閉じる", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  // 正規の LARGEST_OBJECT と値域外の FORWARD を混在させる
  const notifyPayload = encodePublishStateNotifyPayload({
    type: MessageType.PUBLISH_STATE_NOTIFY,
    parameters: [
      { type: MessageParameterType.LARGEST_OBJECT, value: new Uint8Array([0x07, 0x02]) },
      { type: MessageParameterType.FORWARD, value: new Uint8Array([2]) },
    ],
  });
  const message = ctx.session.controlWriter!.encode(
    MessageType.PUBLISH_STATE_NOTIFY,
    notifyPayload,
  );
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // 違反確定後の部分反映は起きず、セッションが閉じる
  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isNull(subscriber.largestLocation);
});
