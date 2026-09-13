/**
 * session/bidi.ts の単体テスト: 応答失敗時の削除集合の掃除と cross-cancel
 *
 * 応答失敗時の削除集合の掃除と、malformed な Track を受信したときの
 * 同一 Track 購読 / FETCH の cross-cancel を検証する。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import { encodeFetchOkPayload } from "../message/fetch";
import { MessageType, GroupOrder } from "../message/types";
import { encodeSubscribeOkPayload } from "../message/subscribe";
import { MalformedTrackError, SessionErrorCode } from "../error";
import { ControlStreamReader } from "../controlStream";
import { incomingWaitForFetcher } from "./incoming";
import type { SessionInternal } from "./types";
import { bidiReadFetchResponse, bidiReadSubscribeResponse } from "./bidi";
import { FetcherImpl } from "../fetcher";
import {
  createOkResponseReadTestContext,
  createCancelObservableResponseContext,
} from "../testSupport/bidi";

/**
 * draft-ietf-moq-transport-21 §3.1.2 / §2.4.1:
 * Track Alias の重複判定は Full Track Name の比較キーで行う。namespace ["a"] +
 * trackName "b/c" と namespace ["a","b"] + trackName "c" は "/" 連結では同じ
 * "a/b/c" になるため、区切り文字の曖昧さで別 Track を同一とみなすと
 * DUPLICATE_TRACK_ALIAS を見逃す。比較キーがフィールド境界を保つことで
 * 別 Track として検出されることを固定する。
 */
test("bidiReadSubscribeResponse: 区切り文字が衝突する別 Track の同一 alias で DUPLICATE_TRACK_ALIAS になる", async () => {
  const ctx = createOkResponseReadTestContext();
  // 同一 alias 1n を持つ既存購読 (namespace ["a"] + trackName "b/c")
  const colliding = new SubscriberImpl(["a"], "b/c", 5n, 1n, () => {});
  ctx.session.subscribersByAlias.set(1n, [colliding]);
  // 受信する SUBSCRIBE_OK の対象は namespace ["a","b"] + trackName "c"
  const subscriber = new SubscriberImpl(["a", "b"], "c", ctx.requestId, 0n, () => {});
  let rejected: Error | undefined;
  ctx.session.pendingSubscribe.set(ctx.requestId, {
    resolve: () => {},
    reject: (error: Error) => {
      rejected = error;
    },
    impl: subscriber,
    objectCallback: () => {},
  });

  const readPromise = bidiReadSubscribeResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  const okPayload = encodeSubscribeOkPayload({
    type: MessageType.SUBSCRIBE_OK,
    trackAlias: 1n,
    parameters: [],
    trackProperties: [],
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.SUBSCRIBE_OK, okPayload));
  ctx.readableController.close();
  await readPromise;

  // 別 Track への同一 alias は DUPLICATE_TRACK_ALIAS で拒否される
  assert.isDefined(rejected);
  assert.isDefined(ctx.getClosedWithError());
  assert.strictEqual(rejected, ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.DUPLICATE_TRACK_ALIAS);
  assert.isFalse(ctx.session.pendingSubscribe.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §3.1.2:
 * DUPLICATE_TRACK_ALIAS 経路で pendingSubscribe + requestStreams +
 * fillFetchTargets が掃除されることを検証する。
 */
test("bidiReadSubscribeResponse: DUPLICATE_TRACK_ALIAS で削除集合が掃除される", async () => {
  const ctx = createOkResponseReadTestContext();
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  let rejected: Error | undefined;
  ctx.session.pendingSubscribe.set(ctx.requestId, {
    resolve: () => {},
    reject: (error: Error) => {
      ctx.order.push("reject");
      rejected = error;
    },
    impl: subscriber,
    objectCallback: () => {},
  });
  ctx.session.fillFetchTargets.set(ctx.requestId, {
    subscriber,
    groupOrder: GroupOrder.ASCENDING,
  });
  // 同一 alias の別トラック購読者を登録する
  const other = new SubscriberImpl(["other"], "track", 5n, 1n, () => {});
  ctx.session.subscribersByAlias.set(1n, [other]);

  const readPromise = bidiReadSubscribeResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  const okPayload = encodeSubscribeOkPayload({
    type: MessageType.SUBSCRIBE_OK,
    trackAlias: 1n,
    parameters: [],
    trackProperties: [],
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.SUBSCRIBE_OK, okPayload));
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(rejected);
  assert.isDefined(ctx.getClosedWithError());
  assert.strictEqual(rejected, ctx.getClosedWithError());
  // reject してから閉じる順序である
  assert.deepEqual(ctx.order, ["reject", "close"]);
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.DUPLICATE_TRACK_ALIAS);
  assert.isFalse(ctx.session.pendingSubscribe.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isFalse(ctx.session.fillFetchTargets.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §9.12:
 * End Location 検証経路で pendingFetch + requestStreams が掃除されることを検証する。
 */
test("bidiReadFetchResponse: End Location 検証失敗で削除集合が掃除される", async () => {
  const ctx = createOkResponseReadTestContext();
  const fetcher = new FetcherImpl(["test"], "track", ctx.requestId, () => {});
  let rejected: Error | undefined;
  ctx.session.pendingFetch.set(ctx.requestId, {
    resolve: () => {},
    reject: (error: Error) => {
      ctx.order.push("reject");
      rejected = error;
    },
    impl: fetcher,
    startLocation: { group: 5n, object: 0n },
  });

  const readPromise = bidiReadFetchResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  const okPayload = encodeFetchOkPayload({
    type: MessageType.FETCH_OK,
    endOfTrack: false,
    endLocation: { group: 0n, object: 0n },
    parameters: [],
    trackProperties: [],
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.FETCH_OK, okPayload));
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(rejected);
  assert.isDefined(ctx.getClosedWithError());
  assert.strictEqual(rejected, ctx.getClosedWithError());
  // reject してから閉じる順序である
  assert.deepEqual(ctx.order, ["reject", "close"]);
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isFalse(ctx.session.pendingFetch.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
});

/**
 * 3 応答読み取りの汎用 catch の else 分岐 (非プロトコル違反時) で
 * 同一関数の既存失敗経路と同じ削除集合になることを検証する。
 */
test("bidiReadSubscribeResponse: 非違反失敗で削除集合が掃除される", async () => {
  const ctx = createOkResponseReadTestContext();
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  let rejected: Error | undefined;
  ctx.session.pendingSubscribe.set(ctx.requestId, {
    resolve: () => {},
    reject: (error: Error) => {
      rejected = error;
    },
    impl: subscriber,
    objectCallback: () => {},
  });
  ctx.session.fillFetchTargets.set(ctx.requestId, {
    subscriber,
    groupOrder: GroupOrder.ASCENDING,
  });

  const readPromise = bidiReadSubscribeResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  ctx.readableController.error(new Error("stream broken"));
  await readPromise;

  assert.isDefined(rejected);
  assert.strictEqual(rejected!.message, "stream broken");
  assert.isUndefined(ctx.getClosedWithError());
  assert.isFalse(ctx.session.pendingSubscribe.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isFalse(ctx.session.fillFetchTargets.has(ctx.requestId));
});

test("bidiReadFetchResponse: 非違反失敗で削除集合が掃除される", async () => {
  const ctx = createOkResponseReadTestContext();
  const fetcher = new FetcherImpl(["test"], "track", ctx.requestId, () => {});
  let rejected: Error | undefined;
  ctx.session.pendingFetch.set(ctx.requestId, {
    resolve: () => {},
    reject: (error: Error) => {
      rejected = error;
    },
    impl: fetcher,
  });

  const readPromise = bidiReadFetchResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  ctx.readableController.error(new Error("stream broken"));
  await readPromise;

  assert.isDefined(rejected);
  assert.strictEqual(rejected!.message, "stream broken");
  assert.isUndefined(ctx.getClosedWithError());
  assert.isFalse(ctx.session.pendingFetch.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §3.6 (Mandatory Track Properties) / §6.4.2.3:
 * 未知の Mandatory Track Property を含む SUBSCRIBE_OK を受信した subscriber は
 * 購読を cancel する MUST。bidi リクエストストリームが RESET_STREAM (abort) /
 * STOP_SENDING (cancel) で終了し、state が残留しないことを検証する。
 */
test("bidiReadSubscribeResponse: 未知 Mandatory Track Property で購読が cancel される", async () => {
  const ctx = createCancelObservableResponseContext();
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  let rejected: Error | undefined;
  ctx.session.pendingSubscribe.set(ctx.requestId, {
    resolve: () => {},
    reject: (error: Error) => {
      rejected = error;
    },
    impl: subscriber,
    objectCallback: () => {},
  });
  ctx.session.fillFetchTargets.set(ctx.requestId, {
    subscriber,
    groupOrder: GroupOrder.ASCENDING,
  });

  const readPromise = bidiReadSubscribeResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  // 未知 Mandatory Track Property (0x4000-0x7FFF) を 1 つ含む SUBSCRIBE_OK
  const okPayload = encodeSubscribeOkPayload({
    type: MessageType.SUBSCRIBE_OK,
    trackAlias: 1n,
    parameters: [],
    trackProperties: [{ id: 0x4000n, value: 1n }],
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.SUBSCRIBE_OK, okPayload));
  // readable を close すると cancel が発火しないため、開いたまま cancel の到達を観測する
  await readPromise;
  // writer.abort は fire-and-forget のため到達を待つ
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  assert.instanceOf(rejected, MalformedTrackError);
  // 進行中の fill 配信を止めるため購読が closed になる
  assert.equal(subscriber.state, "closed");
  // 送信方向 RESET_STREAM / 受信方向 STOP_SENDING の両方が到達する
  assert.deepEqual(ctx.aborted, ["subscription cancelled"]);
  assert.deepEqual(ctx.cancelled, ["subscription cancelled"]);
  assert.isFalse(ctx.session.pendingSubscribe.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isFalse(ctx.session.fillFetchTargets.has(ctx.requestId));
  assert.isUndefined(ctx.getClosedWithError());
});

/**
 * draft-ietf-moq-transport-21 §12.1 (Malformed Tracks):
 * 未知の Mandatory Track Property を含む SUBSCRIBE_OK で malformed Track を
 * 検出したとき、pending の購読だけでなく同一 Full Track Name の既存購読 /
 * FETCH も cancel する。別 Track の購読 / FETCH は触らない。
 */
test("bidiReadSubscribeResponse: malformed 検出で同一 Track の既存購読 / FETCH も cancel する", async () => {
  const ctx = createCancelObservableResponseContext();
  // pending 自身への error コールバックは呼ばれない (reject との二重通知なし)
  const pendingErrors: Error[] = [];
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    ctx.requestId,
    1n,
    () => {},
    undefined,
    undefined,
    (error) => {
      pendingErrors.push(error);
    },
  );
  let rejected: Error | undefined;
  ctx.session.pendingSubscribe.set(ctx.requestId, {
    resolve: () => {},
    reject: (error: Error) => {
      rejected = error;
    },
    impl: subscriber,
    objectCallback: () => {},
  });

  // 同一 Full Track Name の既存購読と FETCH を登録し、cross-cancel の対象にする
  const existingSubErrors: Error[] = [];
  const existingSubscriber = new SubscriberImpl(
    ["test"],
    "track",
    90n,
    50n,
    () => {},
    undefined,
    undefined,
    (error) => {
      existingSubErrors.push(error);
    },
  );
  // 既存購読の cancel 実体 (writer.abort / readable.cancel) を観測する
  const existingSubCancelled: unknown[] = [];
  const existingSubAborted: unknown[] = [];
  const existingSubReadable = new ReadableStream<Uint8Array>({
    cancel(reason) {
      existingSubCancelled.push(reason);
    },
  });
  const existingSubWritable = new WritableStream<Uint8Array>({
    abort(reason) {
      existingSubAborted.push(reason);
    },
  });
  const existingSubWriter = existingSubWritable.getWriter();
  ctx.session.requestStreams.set(90n, {
    stream: {
      readable: existingSubReadable,
      writable: existingSubWritable,
    } as unknown as WebTransportBidirectionalStream,
    writer: existingSubWriter,
    controlReader: new ControlStreamReader(),
  });
  // 進行中の fill の関連付けが cross-cancel で掃除されることを検証する
  ctx.session.fillFetchTargets.set(90n, {
    subscriber: existingSubscriber,
    groupOrder: GroupOrder.ASCENDING,
  });
  const fetchErrors: Error[] = [];
  const existingFetcher = new FetcherImpl(
    ["test"],
    "track",
    91n,
    () => {},
    undefined,
    (error) => {
      fetchErrors.push(error);
    },
  );
  // 既存 FETCH の cancel 実体 (bidiCancelFetch への配線) を観測する
  const existingFetchCancelled: string[] = [];
  existingFetcher.onCancel = async () => {
    existingFetchCancelled.push("fetch cancelled");
  };
  // 別 Track の購読と FETCH を登録し、cross-cancel が波及しないことを検証する
  const otherSubscriber = new SubscriberImpl(["test"], "other", 92n, 51n, () => {});
  const otherFetcher = new FetcherImpl(["test"], "other", 93n, () => {});
  ctx.session.subscribersByAlias.set(50n, [existingSubscriber]);
  ctx.session.subscribersByAlias.set(51n, [otherSubscriber]);
  ctx.session.fetchers.set(91n, existingFetcher);
  ctx.session.fetchers.set(93n, otherFetcher);

  const readPromise = bidiReadSubscribeResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  // 未知 Mandatory Track Property (0x4000-0x7FFF) を 1 つ含む SUBSCRIBE_OK
  const okPayload = encodeSubscribeOkPayload({
    type: MessageType.SUBSCRIBE_OK,
    trackAlias: 1n,
    parameters: [],
    trackProperties: [{ id: 0x4000n, value: 1n }],
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.SUBSCRIBE_OK, okPayload));
  await readPromise;
  // 既存購読 / FETCH の cancel は fire-and-forget のため到達を待つ
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  assert.instanceOf(rejected, MalformedTrackError);
  // pending の購読は closed になり RESET_STREAM / STOP_SENDING が到達する
  assert.equal(subscriber.state, "closed");
  assert.deepEqual(ctx.aborted, ["subscription cancelled"]);
  assert.deepEqual(ctx.cancelled, ["subscription cancelled"]);
  // 同一 Track の既存購読 / FETCH は closed になり同じ error が通知される
  assert.equal(existingSubscriber.state, "closed");
  assert.equal(existingFetcher.state, "closed");
  assert.equal(existingSubErrors.length, 1);
  assert.equal(fetchErrors.length, 1);
  assert.instanceOf(existingSubErrors[0], MalformedTrackError);
  assert.strictEqual(existingSubErrors[0], rejected);
  assert.strictEqual(fetchErrors[0], rejected);
  // 既存購読 / FETCH の cancel 実体が到達し、関連付けが掃除される
  assert.deepEqual(existingSubCancelled, ["subscription cancelled"]);
  assert.deepEqual(existingSubAborted, ["subscription cancelled"]);
  assert.equal(existingFetchCancelled.length, 1);
  assert.isFalse(ctx.session.requestStreams.has(90n));
  assert.isFalse(ctx.session.fillFetchTargets.has(90n));
  assert.isFalse(ctx.session.subscribersByAlias.has(50n));
  // pending 自身への error コールバックは呼ばれない (reject との二重通知なし)
  assert.equal(pendingErrors.length, 0);
  // 別 Track の購読 / FETCH は活性のまま
  assert.equal(otherSubscriber.state, "active");
  assert.equal(otherFetcher.state, "active");
  // セッションは閉じない
  assert.isUndefined(ctx.getClosedWithError());
});

/**
 * draft-ietf-moq-transport-21 §3.6 (Mandatory Track Properties) / §6.4.2.3:
 * 未知の Mandatory Track Property を含む FETCH_OK を受信した subscriber は
 * fetch を cancel する MUST。bidi リクエストストリームが RESET_STREAM (abort) /
 * STOP_SENDING (cancel) で終了し、state が残留しないことを検証する。
 */
test("bidiReadFetchResponse: 未知 Mandatory Track Property で fetch が cancel される", async () => {
  const ctx = createCancelObservableResponseContext();
  const fetcher = new FetcherImpl(["test"], "track", ctx.requestId, () => {});
  let rejected: Error | undefined;
  ctx.session.pendingFetch.set(ctx.requestId, {
    resolve: () => {},
    reject: (error: Error) => {
      rejected = error;
    },
    impl: fetcher,
  });

  // 開いている FETCH データストリーム相当の待機者を登録し、cancel 時に
  // fetcher 不在で即時解決 (STOP_SENDING 相当の reader.cancel に至る経路) する
  // ことを検証する。待機タイムアウトは 1000ms とし、即時性で判別する。
  const internal = ctx.session as unknown as SessionInternal;
  const waiter = incomingWaitForFetcher(internal, ctx.requestId, 1000);
  const started = Date.now();

  const readPromise = bidiReadFetchResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  // 未知 Mandatory Track Property (0x4000-0x7FFF) を 1 つ含む FETCH_OK
  const okPayload = encodeFetchOkPayload({
    type: MessageType.FETCH_OK,
    endOfTrack: false,
    endLocation: { group: 0n, object: 0n },
    parameters: [],
    trackProperties: [{ id: 0x4000n, value: 1n }],
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.FETCH_OK, okPayload));
  // readable を close すると cancel が発火しないため、開いたまま cancel の到達を観測する
  await readPromise;
  // writer.abort は fire-and-forget のため到達を待つ
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  const waiterResult = await waiter;

  assert.instanceOf(rejected, MalformedTrackError);
  assert.deepEqual(ctx.cancelled, ["fetch cancelled"]);
  assert.deepEqual(ctx.aborted, ["fetch cancelled"]);
  // 待機者は fetcher 不在のため null で即時解決する (タイムアウト待ちでない)
  assert.isNull(waiterResult);
  assert.isBelow(Date.now() - started, 500);
  assert.isFalse(ctx.session.fetcherReadyCallbacks.has(ctx.requestId));
  assert.isFalse(ctx.session.pendingFetch.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isUndefined(ctx.getClosedWithError());
});

/**
 * draft-ietf-moq-transport-21 §12.1 / §2.4.1:
 * FETCH_OK の malformed 検出による cross-cancel は Full Track Name の比較キーで
 * 対象を決める。namespace ["a"] + trackName "b/c" と namespace ["a","b"] +
 * trackName "c" は "/" 連結では同じ "a/b/c" になるため、区切り文字の曖昧さで
 * 無関係な Track を巻き込む退行が起き得る。対象 Track だけが cancel され、
 * 衝突する別 Track は活性のまま残ることを固定する。
 */
test("bidiReadFetchResponse: 区切り文字が衝突する別 Track を cross-cancel しない", async () => {
  const ctx = createCancelObservableResponseContext();
  const fetcher = new FetcherImpl(["a", "b"], "c", ctx.requestId, () => {});
  ctx.session.pendingFetch.set(ctx.requestId, {
    resolve: () => {},
    reject: () => {},
    impl: fetcher,
  });
  // 対象 Track (namespace ["a","b"] + trackName "c") の既存購読 / FETCH
  const targetSubscriber = new SubscriberImpl(["a", "b"], "c", 90n, 50n, () => {});
  const targetFetcher = new FetcherImpl(["a", "b"], "c", 91n, () => {});
  // 旧実装で同じキー ("a/b/c") になっていた別 Track (namespace ["a"] + trackName "b/c")
  const collidingSubscriber = new SubscriberImpl(["a"], "b/c", 92n, 51n, () => {});
  const collidingFetcher = new FetcherImpl(["a"], "b/c", 93n, () => {});
  const collidingFetchErrors: Error[] = [];
  collidingFetcher.onCancel = async () => {};
  ctx.session.subscribersByAlias.set(50n, [targetSubscriber]);
  ctx.session.subscribersByAlias.set(51n, [collidingSubscriber]);
  ctx.session.fetchers.set(91n, targetFetcher);
  ctx.session.fetchers.set(93n, collidingFetcher);

  const readPromise = bidiReadFetchResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  // 未知 Mandatory Track Property (0x4000-0x7FFF) を 1 つ含む FETCH_OK
  const okPayload = encodeFetchOkPayload({
    type: MessageType.FETCH_OK,
    endOfTrack: false,
    endLocation: { group: 0n, object: 0n },
    parameters: [],
    trackProperties: [{ id: 0x4000n, value: 1n }],
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.FETCH_OK, okPayload));
  await readPromise;
  // cross-cancel は fire-and-forget のため到達を待つ
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  // 対象 Track の既存購読 / FETCH だけが cancel される
  assert.equal(targetSubscriber.state, "closed");
  assert.equal(targetFetcher.state, "closed");
  // 区切り文字が衝突する別 Track は活性のまま
  assert.equal(collidingSubscriber.state, "active");
  assert.equal(collidingFetcher.state, "active");
  assert.equal(collidingFetchErrors.length, 0);
  assert.equal(ctx.session.subscribersByAlias.get(51n)?.length, 1);
  // セッションは閉じない
  assert.isUndefined(ctx.getClosedWithError());
});

/**
 * draft-ietf-moq-transport-21 §12.1 (Malformed Tracks):
 * 未知の Mandatory Track Property を含む FETCH_OK で malformed Track を
 * 検出したとき、pending の FETCH だけでなく同一 Full Track Name の既存購読 /
 * FETCH も cancel する。別 Track の購読 / FETCH は触らない。
 */
test("bidiReadFetchResponse: malformed 検出で同一 Track の既存購読 / FETCH も cancel する", async () => {
  const ctx = createCancelObservableResponseContext();
  // pending 自身への error コールバックは呼ばれない (reject との二重通知なし)
  const pendingErrors: Error[] = [];
  const fetcher = new FetcherImpl(
    ["test"],
    "track",
    ctx.requestId,
    () => {},
    undefined,
    (error) => {
      pendingErrors.push(error);
    },
  );
  let rejected: Error | undefined;
  ctx.session.pendingFetch.set(ctx.requestId, {
    resolve: () => {},
    reject: (error: Error) => {
      rejected = error;
    },
    impl: fetcher,
  });

  // 同一 Full Track Name の既存購読と FETCH を登録し、cross-cancel の対象にする
  const existingSubErrors: Error[] = [];
  const existingSubscriber = new SubscriberImpl(
    ["test"],
    "track",
    90n,
    50n,
    () => {},
    undefined,
    undefined,
    (error) => {
      existingSubErrors.push(error);
    },
  );
  // 既存購読の cancel 実体 (writer.abort / readable.cancel) を観測する
  const existingSubCancelled: unknown[] = [];
  const existingSubAborted: unknown[] = [];
  const existingSubReadable = new ReadableStream<Uint8Array>({
    cancel(reason) {
      existingSubCancelled.push(reason);
    },
  });
  const existingSubWritable = new WritableStream<Uint8Array>({
    abort(reason) {
      existingSubAborted.push(reason);
    },
  });
  const existingSubWriter = existingSubWritable.getWriter();
  ctx.session.requestStreams.set(90n, {
    stream: {
      readable: existingSubReadable,
      writable: existingSubWritable,
    } as unknown as WebTransportBidirectionalStream,
    writer: existingSubWriter,
    controlReader: new ControlStreamReader(),
  });
  const fetchErrors: Error[] = [];
  const existingFetcher = new FetcherImpl(
    ["test"],
    "track",
    91n,
    () => {},
    undefined,
    (error) => {
      fetchErrors.push(error);
    },
  );
  // 既存 FETCH の cancel 実体 (bidiCancelFetch への配線) を観測する
  const existingFetchCancelled: string[] = [];
  existingFetcher.onCancel = async () => {
    existingFetchCancelled.push("fetch cancelled");
  };
  // 別 Track の購読と FETCH を登録し、cross-cancel が波及しないことを検証する
  const otherSubscriber = new SubscriberImpl(["test"], "other", 92n, 51n, () => {});
  const otherFetcher = new FetcherImpl(["test"], "other", 93n, () => {});
  ctx.session.subscribersByAlias.set(50n, [existingSubscriber]);
  ctx.session.subscribersByAlias.set(51n, [otherSubscriber]);
  ctx.session.fetchers.set(91n, existingFetcher);
  ctx.session.fetchers.set(93n, otherFetcher);

  const readPromise = bidiReadFetchResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  // 未知 Mandatory Track Property (0x4000-0x7FFF) を 1 つ含む FETCH_OK
  const okPayload = encodeFetchOkPayload({
    type: MessageType.FETCH_OK,
    endOfTrack: false,
    endLocation: { group: 0n, object: 0n },
    parameters: [],
    trackProperties: [{ id: 0x4000n, value: 1n }],
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.FETCH_OK, okPayload));
  await readPromise;
  // 既存購読 / FETCH の cancel は fire-and-forget のため到達を待つ
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  assert.instanceOf(rejected, MalformedTrackError);
  // pending の FETCH は RESET_STREAM / STOP_SENDING が到達する
  assert.deepEqual(ctx.cancelled, ["fetch cancelled"]);
  assert.deepEqual(ctx.aborted, ["fetch cancelled"]);
  // 同一 Track の既存購読 / FETCH は closed になり同じ error が通知される
  assert.equal(existingSubscriber.state, "closed");
  assert.equal(existingFetcher.state, "closed");
  assert.equal(existingSubErrors.length, 1);
  assert.equal(fetchErrors.length, 1);
  assert.instanceOf(existingSubErrors[0], MalformedTrackError);
  assert.strictEqual(existingSubErrors[0], rejected);
  assert.strictEqual(fetchErrors[0], rejected);
  // 既存購読 / FETCH の cancel 実体が到達し、関連付けが掃除される
  assert.deepEqual(existingSubCancelled, ["subscription cancelled"]);
  assert.deepEqual(existingSubAborted, ["subscription cancelled"]);
  assert.equal(existingFetchCancelled.length, 1);
  assert.isFalse(ctx.session.requestStreams.has(90n));
  assert.isFalse(ctx.session.subscribersByAlias.has(50n));
  // pending 自身への error コールバックは呼ばれない (reject との二重通知なし)
  assert.equal(pendingErrors.length, 0);
  // 別 Track の購読 / FETCH は活性のまま
  assert.equal(otherSubscriber.state, "active");
  assert.equal(otherFetcher.state, "active");
  // セッションは閉じない
  assert.isUndefined(ctx.getClosedWithError());
});
