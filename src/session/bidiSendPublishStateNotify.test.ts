/**
 * session/bidi.ts の単体テスト: bidiSendPublishStateNotify
 *
 * publisher 側の購読状態変化を PUBLISH_STATE_NOTIFY として購読の双方向
 * ストリームへ送信する挙動を検証する。
 * 実 SessionImpl・実 W3C ストリーム・実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert, expect } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import { MessageType, MessageParameterType } from "../message/types";
import { decodePublishStateNotifyPayload } from "../message/session";
import { encodeRequestUpdatePayload } from "../message/subscribe";
import { decodeLocationFilterParameter, getParameterLocationValue } from "../message/parameter";
import { ControlStreamReader, ControlStreamWriter, type ControlMessage } from "../controlStream";
import { concatUint8Arrays } from "../testSupport/helpers";
import {
  createPublishReadTestContext,
  waitForCondition,
  waitForMacrotask,
} from "../testSupport/bidi";
import { bidiReadRequestStreamMessages } from "./bidi";

// ============================================================================
// bidiSendPublishStateNotify のテスト
// draft-ietf-moq-transport-23 §9.10 (PUBLISH_STATE_NOTIFY) / §9.19.18 (PAUSED)
// ============================================================================

/**
 * 双方向ストリームへ write されたバイト列を制御メッセージ列に分解する
 */
function decodeWrittenMessages(written: Uint8Array[]): ControlMessage[] {
  return new ControlStreamReader().feed(concatUint8Arrays(written));
}

/** 要求ストリームの最初の書き込みだけを止める。 */
function blockFirstNotification() {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const context = createPublishReadTestContext({
    async write() {
      if (!first) return;
      first = false;
      await blocked;
    },
  });
  return { context, release };
}

test.each([false, true])(
  "PUBLISH_STATE_NOTIFY: 並行通知を送信順に比較する (2 通目の PAUSED: %s)",
  async (secondPaused) => {
    const { context, release } = blockFirstNotification();
    const { publisher, written } = context;
    const first = publisher.notifyStateChange({ paused: true });
    await waitForCondition(() => written.length === 1, "最初の通知の書き込み開始");
    const second = publisher.notifyStateChange({ paused: secondPaused });
    release();
    await Promise.all([first, second]);

    // 先行の PAUSED=1 を基準に、同値なら省略し、解除なら PAUSED=0 を送る。
    const pausedValues = decodeWrittenMessages(written).map(
      (message) =>
        decodePublishStateNotifyPayload(message.payload).parameters.find(
          (param) => param.type === MessageParameterType.PAUSED,
        )?.value[0],
    );
    assert.deepEqual(pausedValues, secondPaused ? [1] : [1, 0]);
    assert.equal(publisher.paused, secondPaused);
    await publisher.done();
  },
);

test("REQUEST_UPDATE: 送信中の通知より後に届いた PAUSED を通知完了後に適用する", async () => {
  const { context, release } = blockFirstNotification();
  const { publisher, requestId, session, stream, controlReader, readableController, written } =
    context;
  const read = bidiReadRequestStreamMessages(session, requestId, stream, controlReader, "publish");
  const notification = publisher.notifyStateChange({ paused: true });
  try {
    await waitForCondition(() => written.length === 1, "通知の書き込み開始");
    const payload = encodeRequestUpdatePayload({
      type: MessageType.REQUEST_UPDATE,
      requestId: 101n,
      parameters: [{ type: MessageParameterType.PAUSED, value: Uint8Array.of(0) }],
    });
    readableController.enqueue(
      new ControlStreamWriter().encode(MessageType.REQUEST_UPDATE, payload),
    );
    await waitForCondition(
      () => session.receivedRequestUpdateCounts.get(requestId) === 1,
      "REQUEST_UPDATE が処理を開始する",
    );
    await waitForMacrotask();
  } finally {
    release();
  }
  await notification;
  await waitForCondition(() => written.length === 2, "REQUEST_OK の書き込み");
  assert.deepEqual(
    decodeWrittenMessages(written).map(({ type }) => type),
    [MessageType.PUBLISH_STATE_NOTIFY, MessageType.REQUEST_OK],
  );
  // 購読者は PAUSED=1 の通知を受けてから、自分の解除要求の成功を受け取る。
  assert.isFalse(publisher.paused);
  readableController.close();
  await read;
});

test("done(): 受理済みの通知を送ってから PUBLISH_DONE で終了する", async () => {
  const { context, release } = blockFirstNotification();
  const { publisher, written } = context;
  const first = publisher.notifyStateChange({ paused: true });
  await waitForCondition(() => written.length === 1, "最初の通知の書き込み開始");
  const second = publisher.notifyStateChange({ paused: false });
  const done = publisher.done();
  const late = publisher.notifyStateChange({ paused: true });
  release();
  await Promise.all([first, second, done, late]);
  assert.deepEqual(
    decodeWrittenMessages(written).map(({ type }) => type),
    [MessageType.PUBLISH_STATE_NOTIFY, MessageType.PUBLISH_STATE_NOTIFY, MessageType.PUBLISH_DONE],
  );
});

test("PUBLISH_STATE_NOTIFY: 送信前に拒否した通知の後もキューを処理する", async () => {
  const { publisher, written } = createPublishReadTestContext({});
  const invalid = publisher.notifyStateChange({
    filter: { startGroup: -1n, startObject: 0n },
  });
  const valid = publisher.notifyStateChange({ paused: true });
  await expect(invalid).rejects.toThrow(/negative value not allowed/);
  await valid;
  // 不正なフィルタを拒否しても、後続の停止通知は 1 回届く。
  assert.lengthOf(written, 1);
  assert.isTrue(publisher.paused);
  await publisher.done();
});

test("PUBLISH_STATE_NOTIFY: ピアが購読を終了したら未送信の通知と done() の待機を解除する", async () => {
  const { context, release } = blockFirstNotification();
  const { publisher, written } = context;
  const first = publisher.notifyStateChange({ paused: true });
  await waitForCondition(() => written.length === 1, "最初の通知の書き込み開始");
  const second = publisher.notifyStateChange({ paused: false });
  let finished = false;
  const done = publisher.done().then(() => {
    finished = true;
  });
  try {
    await waitForMacrotask();
    publisher.markClosed();
    await waitForCondition(() => finished, "ピアが閉じた購読の終了待ちが解ける");
  } finally {
    release();
    await Promise.all([first, second, done]);
  }
  assert.lengthOf(written, 1);
  assert.isFalse(publisher.paused);
});

/**
 * draft-ietf-moq-transport-23 §9.10 / §9.19.17:
 * 購読状態 (paused) の変化を通知すると、送信済み Object があるため
 * LARGEST_OBJECT を必ず伴い、変化した PAUSED が載ることを検証する。
 * 通知は購読の双方向ストリーム上に片方向で送られ、応答を待たない。
 */
test("bidiSendPublishStateNotify: PAUSED の変化を LARGEST_OBJECT 付きで通知する", async () => {
  const ctx = createPublishReadTestContext({});
  // 送信済み Object があると LARGEST_OBJECT が既知になる
  await ctx.publisher.sendObject({ groupId: 5, objectId: 2, payload: new Uint8Array() });
  assert.deepEqual(ctx.publisher.getLargestLocation(), { group: 5n, object: 2n });

  await ctx.publisher.notifyStateChange({ paused: true });

  const messages = decodeWrittenMessages(ctx.written);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.PUBLISH_STATE_NOTIFY);
  const decoded = decodePublishStateNotifyPayload(messages[0].payload);

  // §9.19.17: 既知なら LARGEST_OBJECT を必ず含める
  const largestParam = decoded.parameters.find(
    (param) => param.type === MessageParameterType.LARGEST_OBJECT,
  );
  assert.isDefined(largestParam);
  assert.deepEqual(getParameterLocationValue(largestParam!), { group: 5n, object: 2n });

  // §9.19.18: PAUSED は変化後の値を報告する (0 は unpaused、1 は paused)
  const pausedParam = decoded.parameters.find(
    (param) => param.type === MessageParameterType.PAUSED,
  );
  assert.isDefined(pausedParam);
  assert.deepEqual([...pausedParam!.value], [1]);

  // 送信できた変更は publisher の paused へ反映される
  assert.isTrue(ctx.publisher.paused);
  // 購読者は応答しないため、応答待ちの登録は行わない
  assert.equal(ctx.session.pendingRequestUpdate.size, 0);
  assert.equal(ctx.session.pendingSubscribe.size, 0);
});

test("PUBLISH_STATE_NOTIFY: 書き込み中に最大位置が進んでも通知に載せた位置でフィルタを解決する", async () => {
  let releaseWrite!: () => void;
  const writing = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const context = createPublishReadTestContext({ write: () => writing });
  const { publisher, written } = context;
  await publisher.sendDatagram({ groupId: 5, objectId: 2, payload: Uint8Array.of(1) });
  const notify = publisher.notifyStateChange({ filter: { nextObject: true } });
  try {
    await waitForCondition(() => written.length === 1, "通知の書き込み開始");
    // 通知の wire の基準点は確定済み。別の writer から送信を進める。
    await publisher.sendDatagram({ groupId: 7, objectId: 8, payload: Uint8Array.of(2) });
  } finally {
    releaseWrite();
    await notify;
  }
  const [message] = decodeWrittenMessages(written);
  const largest = decodePublishStateNotifyPayload(message.payload).parameters.find(
    (param) => param.type === MessageParameterType.LARGEST_OBJECT,
  );
  assert.deepEqual(largest && getParameterLocationValue(largest), { group: 5n, object: 2n });
  assert.deepEqual(publisher.getResolvedLocationFilter()?.start, { group: 5n, object: 3n });
  await publisher.done();
});

/**
 * draft-ietf-moq-transport-23 §9.19.17:
 * Object を 1 つも送信していない場合、LARGEST_OBJECT は未知であるため
 * 通知に含めない ("If omitted from a message where it is otherwise required,
 * the sending endpoint has not published or received any Objects in the Track.")
 * ことを検証する。
 */
test("bidiSendPublishStateNotify: LARGEST_OBJECT が未知なら PAUSED のみを載せる", async () => {
  const ctx = createPublishReadTestContext({});
  assert.isNull(ctx.publisher.getLargestLocation());

  await ctx.publisher.notifyStateChange({ paused: true });

  const messages = decodeWrittenMessages(ctx.written);
  assert.equal(messages.length, 1);
  const decoded = decodePublishStateNotifyPayload(messages[0].payload);
  assert.equal(decoded.parameters.length, 1);
  assert.equal(decoded.parameters[0].type, MessageParameterType.PAUSED);
});

/**
 * draft-ietf-moq-transport-23 §9.10:
 * 通知は「値の変化したパラメータ」のみを運ぶため、現在値と同じ値の通知と
 * 変化を指定しない通知は送信しない (重複送信の抑止) ことを検証する。
 * 変化した値を指定すれば送信する。
 */
test("bidiSendPublishStateNotify: 値の変化が無い通知は送信しない", async () => {
  const ctx = createPublishReadTestContext({});
  await ctx.publisher.sendObject({ groupId: 5, objectId: 2, payload: new Uint8Array() });

  await ctx.publisher.notifyStateChange({ paused: true });
  assert.equal(ctx.written.length, 1);

  // 現在値 (true) と同じ値の再通知は変化が無いため送信しない
  await ctx.publisher.notifyStateChange({ paused: true });
  assert.equal(ctx.written.length, 1);

  // 変化を指定しない通知も送信しない (LARGEST_OBJECT は変化していない)
  await ctx.publisher.notifyStateChange();
  assert.equal(ctx.written.length, 1);

  // 変化した値は送信する
  await ctx.publisher.notifyStateChange({ paused: false });
  assert.equal(ctx.written.length, 2);
  assert.isFalse(ctx.publisher.paused);
});

/**
 * draft-ietf-moq-transport-23 §9.10 / §9.19.9:
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
 * draft-ietf-moq-transport-23 §9.10:
 * 送信できなかった変更を購読状態へ反映しないことを検証する。反映してしまうと、
 * 購読者が受け取っていない値で publisher が Object の送信を止める等、両者の
 * 状態が食い違う。write 失敗は返値の reject として呼び出し元へ伝える。
 */
test("bidiSendPublishStateNotify: 送信に失敗したら購読状態を反映しない", async () => {
  // 実 WritableStream の sink で write を失敗させる (ストリーム機構は実物)
  const ctx = createPublishReadTestContext({
    write() {
      throw new Error("write に失敗した");
    },
  });

  let rejected: Error | undefined;
  try {
    await ctx.publisher.notifyStateChange({ paused: true });
  } catch (error) {
    rejected = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(rejected);
  assert.isTrue(rejected!.message.includes("write に失敗した"));
  // 購読者へ届いていない変更は反映しない (paused は初期値 false のまま)
  assert.isFalse(ctx.publisher.paused);
});

/**
 * draft-ietf-moq-transport-23 §6.4.2.2 / §9.9:
 * 購読が既に終了している場合 (PUBLISH_DONE 送信後・ピアのキャンセル後) は
 * 通知先の双方向ストリームが無いため、送信も状態変更も行わないことを検証する。
 */
test("bidiSendPublishStateNotify: 購読終了後の通知は送信しない", async () => {
  const ctx = createPublishReadTestContext({});
  ctx.publisher.markClosed();

  await ctx.publisher.notifyStateChange({ paused: true });

  assert.equal(ctx.written.length, 0);
  assert.isFalse(ctx.publisher.paused);
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
    await ctx.publisher.notifyStateChange({ paused: true });
  } catch (error) {
    rejected = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(rejected);
  assert.isTrue(rejected!.message.includes("request stream not found"));
  assert.isFalse(ctx.publisher.paused);
});

/**
 * draft-ietf-moq-transport-23 §9.10:
 * 送信側が組み立てた PUBLISH_STATE_NOTIFY が、購読側 (subscribe ロール) の
 * 読み取りループに受理され購読状態へ反映されることを、送信バイト列を実際に
 * 受信側セッションへ流して検証する (エンコードとデコードの突き合わせ)。
 */
test("bidiSendPublishStateNotify: 送信した通知を購読側の読み取りループが状態へ反映する", async () => {
  const sender = createPublishReadTestContext({});
  await sender.publisher.sendObject({ groupId: 5, objectId: 2, payload: new Uint8Array() });
  await sender.publisher.notifyStateChange({ paused: true });
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
  assert.isTrue(subscriber.paused);
  assert.isUndefined(receiver.closedWithError);

  // FIN は PUBLISH_DONE 無しの失敗扱いで購読を閉じるため、検証後に送る
  receiver.readableController.close();
  await readPromise;
});
