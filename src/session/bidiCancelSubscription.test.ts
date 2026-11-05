/**
 * session/bidi.ts の単体テスト: bidiCancelSubscription
 *
 * 保留中 REQUEST_UPDATE の掃除と、読み取りループ生存中の解除で
 * STOP_SENDING が到達することを検証する。
 * 実 SessionImpl・実 W3C ストリーム・実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import { ControlStreamWriter } from "../controlStream";
import { REQUEST_UPDATE_STREAM_CLOSED_MESSAGE } from "./namespaceLoops";
import {
  bidiCancelSubscription,
  bidiReadRequestStreamMessages,
  bidiSendRequestUpdate,
  type BidiSessionInternal,
} from "./bidi";
import {
  asBidiSessionInternal,
  attachTestRequestStream,
  createPublishReadTestContext,
  createTestWebTransport,
} from "../testSupport/bidi";
import { SessionImpl } from "../session";

// ============================================================================
// bidiCancelSubscription の保留中 REQUEST_UPDATE 掃除テスト
// draft-ietf-moq-transport-23 §9.5 / §9.5.1
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §9.5 / §9.5.1:
 * in-flight の REQUEST_UPDATE がある状態で unsubscribe() すると、update() の
 * Promise が共通文言で reject され、エントリが削除されることを検証する。
 * 既存のストリーム破棄 (readable.cancel / writer.abort) と Map 削除も維持される。
 */
test("bidiCancelSubscription: 応答待ちの REQUEST_UPDATE がある状態で unsubscribe すると reject されてエントリが削除される", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  // unsubscribe 前に送信済みで応答待ちの REQUEST_UPDATE を注入する
  // (同一対象の複数件と別対象の 1 件を混ぜ、requestId スコープを検証する)
  const rejected: Error[] = [];
  ctx.session.pendingRequestUpdate.set(90n, {
    resolve: () => {},
    reject: (err: Error) => {
      rejected.push(err);
    },
    targetRequestId: ctx.requestId,
  });
  ctx.session.pendingRequestUpdate.set(91n, {
    resolve: () => {},
    reject: (err: Error) => {
      rejected.push(err);
    },
    targetRequestId: ctx.requestId,
  });
  ctx.session.pendingRequestUpdate.set(92n, {
    resolve: () => {},
    reject: (err: Error) => {
      rejected.push(err);
    },
    targetRequestId: 999n,
  });

  await bidiCancelSubscription(ctx.session, subscriber);

  // 同一対象の 2 件が共通文言で reject され、別対象は削除されずに残る
  assert.equal(rejected.length, 2);
  assert.equal(rejected[0].message, REQUEST_UPDATE_STREAM_CLOSED_MESSAGE);
  assert.equal(rejected[1].message, REQUEST_UPDATE_STREAM_CLOSED_MESSAGE);
  assert.equal(ctx.session.pendingRequestUpdate.size, 1);
  assert.isTrue(ctx.session.pendingRequestUpdate.has(92n));
  // 既存の破棄処理も維持される
  assert.isFalse(ctx.session.subscribers.has(ctx.requestId));
  assert.isFalse(ctx.session.subscribersByAlias.has(1n));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isUndefined(ctx.closedWithError);
});

// 応答待ちの更新が無い状態での unsubscribe は、pendingRequestUpdate が元から空である
// ことを確認するだけの恒真なテストになるため置かない。破棄処理 (subscribers /
// subscribersByAlias / requestStreams の削除) は上のテストで検証済みである。

// ============================================================================
// bidiCancelSubscription の STOP_SENDING 到達テスト
// draft-ietf-moq-transport-23 §3.1:
// "The subscriber terminates a subscription ... by sending STOP_SENDING."
// 読み取りループ生存中の解除でも、ロック保持者経由で cancel が到達すること
// ============================================================================

/**
 * 読み取りループ生存中の unsubscribe() を検証するためのセッションを構築する。
 *
 * readable は開いたままチャンクを流さない (読み取りループが read で待機する)。
 * writable は abort の到達を記録する。セッションは実 SessionImpl、ストリームは
 * 実 W3C Streams であり、failure 注入は sink のみで行う。
 */
function createLiveReadCancelContext(options?: { abortThrows?: boolean }): {
  session: BidiSessionInternal;
  subscriber: SubscriberImpl;
  requestId: bigint;
  aborted: unknown[];
  notifiedErrors: Error[];
  loopPromise: Promise<void>;
} {
  const requestId = 0n;
  const notifiedErrors: Error[] = [];
  const testTransport = createTestWebTransport({
    bidiSink: () => ({
      write() {},
      abort() {
        if (options?.abortThrows === true) {
          throw new Error("中止に失敗しました");
        }
      },
    }),
  });
  const session = new SessionImpl(testTransport.transport, {});
  session.controlWriter = new ControlStreamWriter();
  const requestStream = testTransport.createBidirectionalStream();
  const requestStreamInfo = attachTestRequestStream(session, requestId, requestStream);
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    requestId,
    1n,
    () => {},
    undefined,
    undefined,
    (error) => {
      notifiedErrors.push(error);
    },
  );
  session.subscribers.set(requestId, subscriber);
  session.subscribersByAlias.set(1n, [subscriber]);
  // 読み取りループを起動する (await しない)。read で待機するまで進む。
  // reader の登録はループ開始と同期のため、呼び出し時点で完了している。
  const loopPromise = bidiReadRequestStreamMessages(
    asBidiSessionInternal(session),
    requestId,
    requestStreamInfo.stream,
    requestStreamInfo.controlReader,
    "subscribe",
  );
  return {
    session: asBidiSessionInternal(session),
    subscriber,
    requestId,
    // 実 WritableStream の abort ハンドラが記録した理由
    aborted: requestStream.aborted,
    notifiedErrors,
    loopPromise,
  };
}

/**
 * draft-ietf-moq-transport-23 §3.1:
 * 読み取りループ生存中に unsubscribe() すると、ロック保持者経由で cancel
 * (STOP_SENDING 相当) が到達し、後続の writer.abort() も実行されることを検証する。
 * 従来は stream.cancel() が TypeError で失敗し abort に到達しなかった。
 * 自前解除のため error 通知はなく、Map も掃除され、読み取りループは終了する。
 */
test("bidiCancelSubscription: 読み取りループ生存中の解除で STOP_SENDING が到達し abort も実行される", async () => {
  const ctx = createLiveReadCancelContext();

  // 読み取りループが reader を登録する (保持者経由 cancel の前提)
  const entry = ctx.session.requestStreams.get(ctx.requestId) as unknown as {
    reader?: unknown;
  };
  assert.isDefined(entry.reader);

  await bidiCancelSubscription(ctx.session, ctx.subscriber);

  // abort まで到達する (従来は cancel 失敗でスキップされた)
  assert.equal(ctx.aborted.length, 1);
  assert.equal(ctx.aborted[0], "subscription cancelled");
  // 自前解除のため error 通知はなく、Map も掃除される
  assert.equal(ctx.notifiedErrors.length, 0);
  assert.equal(ctx.session.subscribers.size, 0);
  assert.equal(ctx.session.subscribersByAlias.size, 0);
  assert.equal(ctx.session.requestStreams.size, 0);
  // 読み取りループが終了する (cancel で起きた読み取りが FIN 分岐で処理される)
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error("読み取りループがタイムアウトしました"));
    }, 5000);
  });
  try {
    await Promise.race([ctx.loopPromise, timeout]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
});

/**
 * draft-ietf-moq-transport-23 §3.1:
 * writer.abort() が失敗しても解除は完遂し Map が掃除されることを検証する
 * (GOAWAY 済みで abort が reject するケースの握り潰し維持の回帰ガード)。
 */
test("bidiCancelSubscription: abort 失敗時も解除は完遂し Map が掃除される", async () => {
  const ctx = createLiveReadCancelContext({ abortThrows: true });

  await bidiCancelSubscription(ctx.session, ctx.subscriber);

  assert.equal(ctx.notifiedErrors.length, 0);
  assert.equal(ctx.session.subscribers.size, 0);
  assert.equal(ctx.session.subscribersByAlias.size, 0);
  assert.equal(ctx.session.requestStreams.size, 0);
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error("読み取りループがタイムアウトしました"));
    }, 5000);
  });
  try {
    await Promise.race([ctx.loopPromise, timeout]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
});

/**
 * draft-ietf-moq-transport-23 §9.5.1:
 * REQUEST_UPDATE 送信の write 待ちに解除競合で保留エントリが掃除されていた場合、
 * update() の結果は既に settle 済みの内側 Promise に委ね、送信エラーを上書き
 * しないことを検証する (原因のエラーを呼び出し元へ伝えるため)。
 */
test("bidiSendRequestUpdate: 解除競合で保留が無い場合の write 失敗は内側の reject を優先する", async () => {
  let rejectWrite!: (error: Error) => void;
  const writeGate = new Promise<void>((_, reject) => {
    rejectWrite = reject;
  });
  // 実 WritableStream の sink で write を保留し、解除競合の write 失敗を作る。
  // WritableStreamDefaultWriter は実物を使う (偽装しない)。
  const testTransport = createTestWebTransport({
    bidiSink: () => ({
      async write() {
        await writeGate;
      },
    }),
  });
  const session = new SessionImpl(testTransport.transport, {});
  session.nextRequestId = 100n;
  session.peerMaxFilterRanges = 2;
  session.controlWriter = new ControlStreamWriter();
  const requestStream = testTransport.createBidirectionalStream();
  attachTestRequestStream(session, 0n, requestStream);
  const bidiSession = asBidiSessionInternal(session);
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  // write 待ちの間に解除競合を再現する (保留の reject + 削除)
  const updatePromise = bidiSendRequestUpdate(bidiSession, subscriber, { paused: false });
  assert.equal(bidiSession.pendingRequestUpdate.size, 1);
  for (const [updateId, pending] of bidiSession.pendingRequestUpdate) {
    pending.reject(new Error(REQUEST_UPDATE_STREAM_CLOSED_MESSAGE));
    bidiSession.pendingRequestUpdate.delete(updateId);
  }
  rejectWrite(new Error("write に失敗した"));

  // 内側の reject (解除原因) が伝播し、送信エラーで上書きされない
  let rejected: Error | undefined;
  try {
    await updatePromise;
    assert.fail("update は reject されるべき");
  } catch (error) {
    rejected = error instanceof Error ? error : new Error(String(error));
  }
  assert.isDefined(rejected);
  assert.equal(rejected!.message, REQUEST_UPDATE_STREAM_CLOSED_MESSAGE);
  assert.equal(bidiSession.pendingRequestUpdate.size, 0);
});
