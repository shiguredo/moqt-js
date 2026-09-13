/**
 * session/bidi.ts の単体テスト: SubscriberImpl.update() の fire-and-forget 抑制
 *
 * SubscriberImpl.update の reject 経路で unhandled rejection に
 * ならないことを検証する。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import { encodeRequestErrorPayload, encodeGoawayPayload } from "../message/session";
import { MessageType } from "../message/types";
import { RequestErrorCode, RequestError } from "../error";
import { ControlStreamReader } from "../controlStream";
import { REQUEST_UPDATE_STREAM_CLOSED_MESSAGE } from "./namespaceLoops";
import {
  bidiCancelSubscription,
  bidiReadRequestStreamMessages,
  bidiSendRequestUpdate,
  type BidiSessionInternal,
} from "./bidi";
import { createPublishReadTestContext } from "../testSupport/bidi";

// ============================================================================
// SubscriberImpl.update() の fire-and-forget 抑制テスト
// draft-ietf-moq-transport-21 §9.5 / §9.5.1:
// SubscriberImpl.update を非 async 化し catch 付き Promise を直接返すことで、
// 各 reject 経路でも unhandled rejection にならないことを検証する。
// ============================================================================

/**
 * fire-and-forget の update() 駆動コンテキストを構築する
 *
 * 実 SubscriberImpl の onUpdate に実 bidiSendRequestUpdate を配線し、
 * 返り値を観測しない呼び出しでも各経路の reject が抑制されることを検証する。
 */
function createFireForgetUpdateContext(): {
  session: BidiSessionInternal;
  stream: WebTransportBidirectionalStream;
  readableController: ReadableStreamDefaultController<Uint8Array>;
  subscriber: SubscriberImpl;
  requestId: bigint;
  controlReader: ControlStreamReader;
} {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  subscriber.onUpdate = (options) => bidiSendRequestUpdate(ctx.session, subscriber, options);
  return {
    session: ctx.session,
    stream: ctx.stream,
    readableController: ctx.readableController,
    subscriber,
    requestId: ctx.requestId,
    controlReader: ctx.controlReader,
  };
}

/**
 * unhandled rejection の有無を 50ms の壁時計待ちで検出する
 *
 * reject 後のマイクロタスクで発火するため、CI 負荷を考慮した余裕を持つ。
 */
async function assertNoUnhandledRejection(callback: () => Promise<void>): Promise<void> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  // vp check は node の型を解決しないため globalThis 経由で参照する
  const nodeProcess = (
    globalThis as unknown as {
      process: {
        on(event: string, listener: (reason: unknown) => void): void;
        off(event: string, listener: (reason: unknown) => void): void;
      };
    }
  ).process;
  nodeProcess.on("unhandledRejection", onUnhandled);
  try {
    await callback();
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    assert.equal(unhandled.length, 0);
  } finally {
    nodeProcess.off("unhandledRejection", onUnhandled);
  }
}

/**
 * draft-ietf-moq-transport-21 §9.5:
 * fire-and-forget の update() 後に REQUEST_ERROR が届いても unhandled
 * rejection にならず、保留中の更新が掃除されることを検証する。
 */
test("SubscriberImpl.update: fire-and-forget 後の REQUEST_ERROR で unhandled rejection にならない", async () => {
  const { session, stream, readableController, subscriber, requestId, controlReader } =
    createFireForgetUpdateContext();

  await assertNoUnhandledRejection(async () => {
    const readPromise = bidiReadRequestStreamMessages(
      session,
      requestId,
      stream,
      controlReader,
      "subscribe",
    );
    // fire-and-forget: 返り値の Promise を観測しない
    void subscriber.update({ forward: true });
    // REQUEST_ERROR を応答する
    const errorPayload = encodeRequestErrorPayload({
      type: MessageType.REQUEST_ERROR,
      errorCode: BigInt(RequestErrorCode.INTERNAL_ERROR),
      retryInterval: 0n,
      reasonPhrase: "request failed",
    });
    readableController.enqueue(
      session.controlWriter!.encode(MessageType.REQUEST_ERROR, errorPayload),
    );
    readableController.close();
    await readPromise;
    assert.equal(session.pendingRequestUpdate.size, 0);
  });
});

/**
 * draft-ietf-moq-transport-21 §9.2:
 * fire-and-forget の update() 後に GOAWAY が届いても unhandled rejection に
 * ならず、保留中の更新が掃除されることを検証する。
 */
test("SubscriberImpl.update: fire-and-forget 後の GOAWAY で unhandled rejection にならない", async () => {
  const { session, stream, readableController, subscriber, requestId, controlReader } =
    createFireForgetUpdateContext();

  await assertNoUnhandledRejection(async () => {
    const readPromise = bidiReadRequestStreamMessages(
      session,
      requestId,
      stream,
      controlReader,
      "subscribe",
    );
    // fire-and-forget: 返り値の Promise を観測しない
    void subscriber.update({ forward: true });
    const goawayPayload = encodeGoawayPayload({
      type: MessageType.GOAWAY,
      newSessionUri: "moqt://new.example.com",
      timeout: 0n,
    });
    readableController.enqueue(session.controlWriter!.encode(MessageType.GOAWAY, goawayPayload));
    readableController.close();
    await readPromise;
    assert.equal(session.pendingRequestUpdate.size, 0);
  });
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.2:
 * fire-and-forget の update() 後に FIN が届いても unhandled rejection に
 * ならず、保留中の更新が掃除されることを検証する。
 */
test("SubscriberImpl.update: fire-and-forget 後の FIN で unhandled rejection にならない", async () => {
  const { session, stream, readableController, subscriber, requestId, controlReader } =
    createFireForgetUpdateContext();

  await assertNoUnhandledRejection(async () => {
    const readPromise = bidiReadRequestStreamMessages(
      session,
      requestId,
      stream,
      controlReader,
      "subscribe",
    );
    // fire-and-forget: 返り値の Promise を観測しない
    void subscriber.update({ forward: true });
    // ピアの FIN を再現する
    readableController.close();
    await readPromise;
    assert.equal(session.pendingRequestUpdate.size, 0);
  });
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.3:
 * fire-and-forget の update() 後に RESET_STREAM が起きても unhandled
 * rejection にならず、保留中の更新が掃除されることを検証する。
 */
test("SubscriberImpl.update: fire-and-forget 後の RESET_STREAM で unhandled rejection にならない", async () => {
  const { session, stream, readableController, subscriber, requestId, controlReader } =
    createFireForgetUpdateContext();

  await assertNoUnhandledRejection(async () => {
    const readPromise = bidiReadRequestStreamMessages(
      session,
      requestId,
      stream,
      controlReader,
      "subscribe",
    );
    // fire-and-forget: 返り値の Promise を観測しない
    void subscriber.update({ forward: true });
    // ピアの RESET_STREAM 相当 (source: "stream" の reject) を再現する
    readableController.error(
      Object.assign(new Error("stream reset by peer"), { source: "stream" }),
    );
    await readPromise;
    assert.equal(session.pendingRequestUpdate.size, 0);
  });
});

/**
 * draft-ietf-moq-transport-21 §3.1:
 * fire-and-forget の update() 後に unsubscribe() しても unhandled rejection に
 * ならず、保留中の更新が掃除されることを検証する。
 */
test("SubscriberImpl.update: fire-and-forget 後の unsubscribe() で unhandled rejection にならない", async () => {
  const { session, subscriber } = createFireForgetUpdateContext();

  await assertNoUnhandledRejection(async () => {
    // fire-and-forget: 返り値の Promise を観測しない
    void subscriber.update({ forward: true });
    // 応答が届かないまま unsubscribe() して update() の reject を発生させる
    await bidiCancelSubscription(session, subscriber);
    assert.equal(session.pendingRequestUpdate.size, 0);
  });
});

/**
 * await で観測するアプリの動作が変わらないことを検証する。
 * reject は Promise で伝播し、同期 throw にならない。
 */
test("SubscriberImpl.update: await した場合は reject が Promise で伝播する", async () => {
  const { session, stream, readableController, subscriber, requestId, controlReader } =
    createFireForgetUpdateContext();

  const readPromise = bidiReadRequestStreamMessages(
    session,
    requestId,
    stream,
    controlReader,
    "subscribe",
  );
  const updatePromise = subscriber.update({ forward: true });
  assert.instanceOf(updatePromise, Promise);
  // REQUEST_ERROR を応答する
  const errorPayload = encodeRequestErrorPayload({
    type: MessageType.REQUEST_ERROR,
    errorCode: BigInt(RequestErrorCode.INTERNAL_ERROR),
    retryInterval: 0n,
    reasonPhrase: "request failed",
  });
  readableController.enqueue(
    session.controlWriter!.encode(MessageType.REQUEST_ERROR, errorPayload),
  );
  readableController.close();
  await readPromise;

  // 同期 throw ではなく Promise の reject として伝播する
  let rejected: Error | undefined;
  try {
    await updatePromise;
    assert.fail("update は reject されるべき");
  } catch (error) {
    rejected = error instanceof Error ? error : new Error(String(error));
  }
  assert.isDefined(rejected);
  assert.instanceOf(rejected, RequestError);
  assert.equal(session.pendingRequestUpdate.size, 0);
});

/**
 * await で観測するアプリには GOAWAY による reject が伝播することを検証する。
 * 抑制機構は全経路共通のため、代表として GOAWAY 経路の伝播値を固定する。
 */
test("SubscriberImpl.update: await した場合は GOAWAY の reject が Promise で伝播する", async () => {
  const { session, stream, readableController, subscriber, requestId, controlReader } =
    createFireForgetUpdateContext();

  const readPromise = bidiReadRequestStreamMessages(
    session,
    requestId,
    stream,
    controlReader,
    "subscribe",
  );
  const updatePromise = subscriber.update({ forward: true });
  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "moqt://new.example.com",
    timeout: 0n,
  });
  readableController.enqueue(session.controlWriter!.encode(MessageType.GOAWAY, goawayPayload));
  readableController.close();
  await readPromise;

  // GOAWAY 掃除の RequestError (GOING_AWAY) が伝播する
  let rejected: Error | undefined;
  try {
    await updatePromise;
    assert.fail("update は reject されるべき");
  } catch (error) {
    rejected = error instanceof Error ? error : new Error(String(error));
  }
  assert.isDefined(rejected);
  assert.instanceOf(rejected, RequestError);
  assert.equal((rejected as RequestError).code, RequestErrorCode.GOING_AWAY);
  assert.equal(session.pendingRequestUpdate.size, 0);
});

/**
 * await で観測するアプリには unsubscribe による reject が伝播することを検証する。
 * 抑制機構は全経路共通のため、代表として unsubscribe 経路の伝播値を固定する。
 */
test("SubscriberImpl.update: await した場合は unsubscribe の reject が Promise で伝播する", async () => {
  const { session, subscriber } = createFireForgetUpdateContext();

  const updatePromise = subscriber.update({ forward: true });
  await bidiCancelSubscription(session, subscriber);

  // 共通文言の Error が伝播し、誤って resolve として解決されるのではない
  let rejected: Error | undefined;
  try {
    await updatePromise;
    assert.fail("update は reject されるべき");
  } catch (error) {
    rejected = error instanceof Error ? error : new Error(String(error));
  }
  assert.isDefined(rejected);
  assert.equal(rejected!.message, REQUEST_UPDATE_STREAM_CLOSED_MESSAGE);
  assert.equal(session.pendingRequestUpdate.size, 0);
});
