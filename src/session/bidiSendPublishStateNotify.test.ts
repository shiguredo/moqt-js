/**
 * session/bidi.ts の単体テスト: bidiSendPublishStateNotify
 *
 * publisher 側の購読状態変化を PUBLISH_STATE_NOTIFY として購読の双方向
 * ストリームへ送信する挙動を検証する。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import { MessageType, MessageParameterType } from "../message/types";
import { decodePublishStateNotifyPayload } from "../message/session";
import { decodeLocationFilterParameter, getParameterLocationValue } from "../message/parameter";
import { ControlStreamReader, type ControlMessage } from "../controlStream";
import { concatUint8Arrays } from "../testSupport/helpers";
import { createPublishReadTestContext, waitForMacrotask } from "../testSupport/bidi";
import { bidiReadRequestStreamMessages } from "./bidi";

// ============================================================================
// bidiSendPublishStateNotify のテスト
// draft-ietf-moq-transport-21 §9.10 (PUBLISH_STATE_NOTIFY)
// ============================================================================

/**
 * 双方向ストリームへ write されたバイト列を制御メッセージ列に分解する
 */
function decodeWrittenMessages(written: Uint8Array[]): ControlMessage[] {
  return new ControlStreamReader().feed(concatUint8Arrays(written));
}

/**
 * draft-ietf-moq-transport-21 §9.10 / §9.20.18:
 * 購読状態 (Forward State) の変化を通知すると、送信済み Object があるため
 * LARGEST_OBJECT を必ず伴い、変化した FORWARD が載ることを検証する。
 * 通知は購読の双方向ストリーム上に片方向で送られ、応答を待たない。
 */
test("bidiSendPublishStateNotify: FORWARD の変化を LARGEST_OBJECT 付きで通知する", async () => {
  const ctx = createPublishReadTestContext({});
  // 送信済み Object があると LARGEST_OBJECT が既知になる
  // (テスト用 publisher は onSendObject 未設定のため送信は行わず記録だけされる)
  await ctx.publisher.sendObject({ groupId: 5, objectId: 2, payload: new Uint8Array() });
  assert.deepEqual(ctx.publisher.getLargestLocation(), { group: 5n, object: 2n });

  await ctx.publisher.notifyStateChange({ forward: false });

  const messages = decodeWrittenMessages(ctx.written);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.PUBLISH_STATE_NOTIFY);
  const decoded = decodePublishStateNotifyPayload(messages[0].payload);

  // §9.20.18: 既知なら LARGEST_OBJECT を必ず含める
  const largestParam = decoded.parameters.find(
    (param) => param.type === MessageParameterType.LARGEST_OBJECT,
  );
  assert.isDefined(largestParam);
  assert.deepEqual(getParameterLocationValue(largestParam!), { group: 5n, object: 2n });

  // §9.20.19: FORWARD は変化後の値 (0 = 転送しない) を報告する
  const forwardParam = decoded.parameters.find(
    (param) => param.type === MessageParameterType.FORWARD,
  );
  assert.isDefined(forwardParam);
  assert.deepEqual([...forwardParam!.value], [0]);

  // 送信できた変更は publisher の Forward State へ反映される
  assert.isFalse(ctx.publisher.forwardState);
  // 購読者は応答しないため、応答待ちの登録は行わない
  assert.equal(ctx.session.pendingRequestUpdate.size, 0);
  assert.equal(ctx.session.pendingSubscribe.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.20.18:
 * Object を 1 つも送信していない場合、LARGEST_OBJECT は未知であるため
 * 通知に含めない ("If omitted from a message, the sending endpoint has not
 * published or received any Objects in the Track.") ことを検証する。
 */
test("bidiSendPublishStateNotify: LARGEST_OBJECT が未知なら FORWARD のみを載せる", async () => {
  const ctx = createPublishReadTestContext({});
  assert.isNull(ctx.publisher.getLargestLocation());

  await ctx.publisher.notifyStateChange({ forward: false });

  const messages = decodeWrittenMessages(ctx.written);
  assert.equal(messages.length, 1);
  const decoded = decodePublishStateNotifyPayload(messages[0].payload);
  assert.equal(decoded.parameters.length, 1);
  assert.equal(decoded.parameters[0].type, MessageParameterType.FORWARD);
});

/**
 * draft-ietf-moq-transport-21 §9.10:
 * 通知は「値の変化したパラメータ」のみを運ぶため、現在値と同じ値の通知と
 * 変化を指定しない通知は送信しない (重複送信の抑止) ことを検証する。
 * 変化した値を指定すれば送信する。
 */
test("bidiSendPublishStateNotify: 値の変化が無い通知は送信しない", async () => {
  const ctx = createPublishReadTestContext({});
  await ctx.publisher.sendObject({ groupId: 5, objectId: 2, payload: new Uint8Array() });

  await ctx.publisher.notifyStateChange({ forward: false });
  assert.equal(ctx.written.length, 1);

  // 現在値 (false) と同じ値の再通知は変化が無いため送信しない
  await ctx.publisher.notifyStateChange({ forward: false });
  assert.equal(ctx.written.length, 1);

  // 変化を指定しない通知も送信しない (LARGEST_OBJECT は変化していない)
  await ctx.publisher.notifyStateChange();
  assert.equal(ctx.written.length, 1);

  // 変化した値は送信する
  await ctx.publisher.notifyStateChange({ forward: true });
  assert.equal(ctx.written.length, 2);
  assert.isTrue(ctx.publisher.forwardState);
});

/**
 * draft-ietf-moq-transport-21 §9.10 / §9.20.10:
 * LOCATION_FILTER の変化を通知し (「When sent in PUBLISH_STATE_NOTIFY, it
 * reports the Location Filter now in effect at the publisher.」)、等価な値の
 * 再通知は送信しないことを検証する。送信できたフィルタは publisher の
 * Location Filter として反映される。
 */
test("bidiSendPublishStateNotify: LOCATION_FILTER の変化を通知し、等価な値では送信しない", async () => {
  const ctx = createPublishReadTestContext({});
  // REQUEST_UPDATE で受理した購読の Location Filter を模して初期値を設定する
  ctx.publisher.setLocationFilter({ startGroup: 1n });

  // 保持値と等価なフィルタは変化が無いため送信しない
  await ctx.publisher.notifyStateChange({ filter: { startGroup: 1n } });
  assert.equal(ctx.written.length, 0);

  await ctx.publisher.notifyStateChange({ filter: { startGroup: 2n } });

  const messages = decodeWrittenMessages(ctx.written);
  assert.equal(messages.length, 1);
  const decoded = decodePublishStateNotifyPayload(messages[0].payload);
  const filterParam = decoded.parameters.find(
    (param) => param.type === MessageParameterType.LOCATION_FILTER,
  );
  assert.isDefined(filterParam);
  assert.deepEqual(decodeLocationFilterParameter(filterParam!), { startGroup: 2n });
  // 送信できたフィルタが保持値になる
  assert.deepEqual(ctx.publisher.getLocationFilter(), { startGroup: 2n });
});

/**
 * draft-ietf-moq-transport-21 §9.10:
 * 送信できなかった変更を購読状態へ反映しないことを検証する。反映してしまうと、
 * 購読者が受け取っていない値で publisher が Object の送信を止める等、両者の
 * 状態が食い違う。write 失敗は返値の reject として呼び出し元へ伝える。
 */
test("bidiSendPublishStateNotify: 送信に失敗したら購読状態を反映しない", async () => {
  // 実 WritableStream の sink で write を失敗させる (ストリーム機構は実物)
  const ctx = createPublishReadTestContext({
    write() {
      throw new Error("write failed");
    },
  });

  let rejected: Error | undefined;
  try {
    await ctx.publisher.notifyStateChange({ forward: false });
  } catch (error) {
    rejected = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(rejected);
  assert.isTrue(rejected!.message.includes("write failed"));
  // 購読者へ届いていない変更は反映しない (Forward State は初期値のまま)
  assert.isTrue(ctx.publisher.forwardState);
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.2 / §9.9:
 * 購読が既に終了している場合 (PUBLISH_DONE 送信後・ピアのキャンセル後) は
 * 通知先の双方向ストリームが無いため、送信も状態変更も行わないことを検証する。
 */
test("bidiSendPublishStateNotify: 購読終了後の通知は送信しない", async () => {
  const ctx = createPublishReadTestContext({});
  ctx.publisher.markClosed();

  await ctx.publisher.notifyStateChange({ forward: false });

  assert.equal(ctx.written.length, 0);
  assert.isTrue(ctx.publisher.forwardState);
});

/**
 * 双方向ストリームが既に無い場合 (セッション終了との競合) は送信できないため、
 * 返値の reject で呼び出し元へ伝えることを検証する。
 */
test("bidiSendPublishStateNotify: request stream が無い場合は reject する", async () => {
  const ctx = createPublishReadTestContext({});
  ctx.session.requestStreams.delete(ctx.requestId);

  let rejected: Error | undefined;
  try {
    await ctx.publisher.notifyStateChange({ forward: false });
  } catch (error) {
    rejected = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(rejected);
  assert.isTrue(rejected!.message.includes("request stream not found"));
  assert.isTrue(ctx.publisher.forwardState);
});

/**
 * draft-ietf-moq-transport-21 §9.10:
 * 送信側が組み立てた PUBLISH_STATE_NOTIFY が、購読側 (subscribe ロール) の
 * 読み取りループに受理され購読状態へ反映されることを、送信バイト列を実際に
 * 受信側セッションへ流して検証する (エンコードとデコードの突き合わせ)。
 */
test("bidiSendPublishStateNotify: 送信した通知を購読側の読み取りループが状態へ反映する", async () => {
  const sender = createPublishReadTestContext({});
  await sender.publisher.sendObject({ groupId: 5, objectId: 2, payload: new Uint8Array() });
  await sender.publisher.notifyStateChange({ forward: false });
  assert.equal(sender.written.length, 1);

  // 受信側は subscribe ロール (自 endpoint が購読者) のセッションを用意する
  const receiver = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", receiver.requestId, 1n, () => {});
  receiver.session.subscribers.set(receiver.requestId, subscriber);
  receiver.session.subscribersByAlias.set(1n, [subscriber]);
  const readPromise = bidiReadRequestStreamMessages(
    receiver.session,
    receiver.requestId,
    receiver.stream,
    receiver.controlReader,
    "subscribe",
  );

  // 送信側が write したバイト列をそのまま受信側の読み取りループへ流す
  receiver.readableController.enqueue(concatUint8Arrays(sender.written));
  await waitForMacrotask();

  assert.deepEqual(subscriber.largestLocation, { group: 5n, object: 2n });
  assert.isFalse(subscriber.forwardState);
  assert.isUndefined(receiver.closedWithError);

  // FIN は PUBLISH_DONE 無しの失敗扱いで購読を閉じるため、検証後に送る
  receiver.readableController.close();
  await readPromise;
});
