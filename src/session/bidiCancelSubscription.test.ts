/**
 * session/bidi.ts の単体テスト: bidiCancelSubscription
 *
 * 保留中 REQUEST_UPDATE の掃除と、読み取りループ生存中の解除で
 * STOP_SENDING が到達することを検証する。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import { ControlStreamReader, ControlStreamWriter } from "../controlStream";
import { REQUEST_UPDATE_STREAM_CLOSED_MESSAGE } from "./namespaceLoops";
import {
  bidiCancelSubscription,
  bidiReadRequestStreamMessages,
  bidiSendRequestUpdate,
  type BidiSessionInternal,
} from "./bidi";
import { createPublishReadTestContext } from "../testSupport/bidi";

// ============================================================================
// bidiCancelSubscription の保留中 REQUEST_UPDATE 掃除テスト
// draft-ietf-moq-transport-21 §9.5 / §9.5.1
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.5 / §9.5.1:
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

/**
 * draft-ietf-moq-transport-21 §9.5 / §9.5.1:
 * 保留中の更新が無い状態の unsubscribe では何も起きないことを検証する
 * (回帰ガード。掃除対象が無い場合の no-op)。
 */
test("bidiCancelSubscription: 応答待ちの更新が無い状態の unsubscribe では保留中の掃除は何もしない", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  await bidiCancelSubscription(ctx.session, subscriber);

  // 掃除対象が無くても既存の破棄処理は行われる
  assert.equal(ctx.session.pendingRequestUpdate.size, 0);
  assert.isFalse(ctx.session.subscribers.has(ctx.requestId));
  assert.isFalse(ctx.session.subscribersByAlias.has(1n));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isUndefined(ctx.closedWithError);
});

// ============================================================================
// bidiCancelSubscription の STOP_SENDING 到達テスト
// draft-ietf-moq-transport-21 §3.1:
// "The subscriber terminates a subscription ... by sending STOP_SENDING."
// 読み取りループ生存中の解除でも、ロック保持者経由で cancel が到達すること
// ============================================================================

/**
 * 読み取りループ生存中の unsubscribe() を検証するためのセッションを構築する。
 *
 * readable は開いたままチャンクを流さない (読み取りループが read で待機する)。
 * writable は abort の到達を記録する。ストリーム機構は実物であり、
 * ロック解除経路をまたぐことを検証する (failure 注入は sink のみ)。
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
  const aborted: unknown[] = [];
  const notifiedErrors: Error[] = [];
  const readable = new ReadableStream<Uint8Array>({});
  const writable = new WritableStream<Uint8Array>({
    write() {},
    abort(reason) {
      aborted.push(reason);
      if (options?.abortThrows === true) {
        throw new Error("中止に失敗しました");
      }
    },
  });
  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;
  const writer = writable.getWriter();
  const controlReader = new ControlStreamReader();
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
  const session = {
    sessionState: "connected",
    transport: {},
    controlWriter: new ControlStreamWriter(),
    nextRequestId: 100n,
    requestStreams: new Map([[requestId, { stream, writer, controlReader }]]),
    pendingPublish: new Map(),
    pendingSubscribe: new Map(),
    pendingFetch: new Map(),
    pendingTrackStatus: new Map(),
    pendingRequestUpdate: new Map(),
    fillFetchTargets: new Map(),
    publishers: new Map(),
    subscribers: new Map([[requestId, subscriber]]),
    subscribersByAlias: new Map([[1n, [subscriber]]]),
    fetchers: new Map(),
    pendingSubgroupBuffer: {},
    fetcherReadyCallbacks: new Map(),
    goawayReceivedOnRequestStreams: new Set(),
    unmatchedRequestOkAllowances: new Map(),
    peerMaxRequestUpdates: 0,
    peerMaxFilterRanges: 0,
    // draft-ietf-moq-transport-21 §9.1.7 (MAX_REQUEST_UPDATES):
    // 既定は未広告 (0 = 無制限) と未応答数なし
    localMaxRequestUpdates: 0,
    receivedRequestUpdateCounts: new Map(),
    namespaceSubscriptions: new Map(),
    tracksSubscriptions: new Map(),
    statsControlMessagesSent: 0,
    emitDebug: () => {},
    closeWithError: () => {},
  } as unknown as BidiSessionInternal;
  // 読み取りループを起動する (await しない)。read で待機するまで進む。
  // reader の登録はループ開始と同期のため、呼び出し時点で完了している。
  const loopPromise = bidiReadRequestStreamMessages(
    session,
    requestId,
    stream,
    controlReader,
    "subscribe",
  );
  return {
    session,
    subscriber,
    requestId,
    aborted,
    notifiedErrors,
    loopPromise,
  };
}

/**
 * draft-ietf-moq-transport-21 §3.1:
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
 * draft-ietf-moq-transport-21 §3.1:
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
 * draft-ietf-moq-transport-21 §9.5.1:
 * REQUEST_UPDATE 送信の write 待ちに解除競合で保留エントリが掃除されていた場合、
 * update() の結果は既に settle 済みの内側 Promise に委ね、送信エラーを上書き
 * しないことを検証する (原因のエラーを呼び出し元へ伝えるため)。
 */
test("bidiSendRequestUpdate: 解除競合で保留が無い場合の write 失敗は内側の reject を優先する", async () => {
  let rejectWrite!: (error: Error) => void;
  const writeGate = new Promise<void>((_, reject) => {
    rejectWrite = reject;
  });
  const writer = {
    write: async (): Promise<void> => {
      await writeGate;
    },
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;
  const session = {
    sessionState: "connected",
    transport: {},
    controlWriter: new ControlStreamWriter(),
    nextRequestId: 100n,
    requestStreams: new Map([
      [0n, { stream: {}, writer, controlReader: new ControlStreamReader() }],
    ]),
    pendingPublish: new Map(),
    pendingSubscribe: new Map(),
    pendingFetch: new Map(),
    pendingTrackStatus: new Map(),
    pendingRequestUpdate: new Map(),
    fillFetchTargets: new Map(),
    publishers: new Map(),
    subscribers: new Map(),
    subscribersByAlias: new Map(),
    fetchers: new Map(),
    pendingSubgroupBuffer: {},
    fetcherReadyCallbacks: new Map(),
    goawayReceivedOnRequestStreams: new Set(),
    unmatchedRequestOkAllowances: new Map(),
    peerMaxRequestUpdates: 0,
    peerMaxFilterRanges: 2,
    // draft-ietf-moq-transport-21 §9.1.7 (MAX_REQUEST_UPDATES):
    // 既定は未広告 (0 = 無制限) と未応答数なし
    localMaxRequestUpdates: 0,
    receivedRequestUpdateCounts: new Map(),
    namespaceSubscriptions: new Map(),
    tracksSubscriptions: new Map(),
    statsControlMessagesSent: 0,
    emitDebug: () => {},
    closeWithError: () => {},
  } as unknown as BidiSessionInternal;
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  // write 待ちの間に解除競合を再現する (保留の reject + 削除)
  const updatePromise = bidiSendRequestUpdate(session, subscriber, { forward: true });
  assert.equal(session.pendingRequestUpdate.size, 1);
  for (const [updateId, pending] of session.pendingRequestUpdate) {
    pending.reject(new Error(REQUEST_UPDATE_STREAM_CLOSED_MESSAGE));
    session.pendingRequestUpdate.delete(updateId);
  }
  rejectWrite(new Error("write failed"));

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
  assert.equal(session.pendingRequestUpdate.size, 0);
});
