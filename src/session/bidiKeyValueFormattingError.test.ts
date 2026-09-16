/**
 * session/bidi.ts の単体テスト: 既知 Type の serialization 不一致 (KEY_VALUE_FORMATTING_ERROR)
 *
 * malformed な Track Properties を含む応答で KEY_VALUE_FORMATTING_ERROR として
 * セッションが閉じることを検証する。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import {
  encodeRequestOkPayload,
  encodeRequestErrorPayload,
  encodePublishStateNotifyPayload,
  encodeGoawayPayload,
} from "../message/session";
import { encodeFetchOkPayload } from "../message/fetch";
import { MessageType, MessageParameterType, GroupOrder } from "../message/types";
import { encodeRequestUpdatePayload, encodeSubscribeOkPayload } from "../message/subscribe";
import { SessionError, SessionErrorCode, RequestErrorCode } from "../error";
import { PublisherImpl } from "../publisher";
import { incomingWaitForFetcher, incomingValidateRequestId } from "./incoming";
import type { SessionInternal } from "./types";
import {
  bidiHandlePublishRequestUpdate,
  bidiHandleRequestUpdateOk,
  bidiReadFetchResponse,
  bidiReadPublishResponse,
  bidiReadRequestStreamMessages,
  bidiReadSubscribeResponse,
  bidiReadTrackStatusResponse,
  type BidiSessionInternal,
} from "./bidi";
import { FetcherImpl, type Fetcher } from "../fetcher";
import { fullTrackNameKey } from "../fullTrackName";
import { createPublishReadTestContext, createOkResponseReadTestContext } from "../testSupport/bidi";
import { appendMalformedTrackProperties } from "../testSupport/helpers";

// ============================================================================
// 既知 Type の serialization 不一致 (KEY_VALUE_FORMATTING_ERROR) で閉じる
// draft-ietf-moq-transport-21 §8.3 (Key-Value-Pair Structure)
// ============================================================================

/**
 * payload 末尾に malformed な Track Properties を連結する
 *
 * draft-ietf-moq-transport-21 §8.3:
 * "If a receiver understands a Type, and the following Value or Length/Value
 *  does not match the serialization defined by that Type, the receiver MUST
 *  close the session with error code KEY_VALUE_FORMATTING_ERROR."
 * 既知偶数 Type (OBJECT_DELIVERY_TIMEOUT 0x02) の Value を 2 バイト varint の
 * 先頭 1 バイト (0x80) だけで終端し、varint がバッファ内で完結しない状態を作る。
 * Track Properties はメッセージ payload の末尾を占めるため、正常な
 * エンコード結果への連結で malformed な受信メッセージを再現できる。
 */
/**
 * draft-ietf-moq-transport-21 §8.3 / §9.3:
 * malformed な Track Properties を含む PUBLISH_OK を受信したら
 * KEY_VALUE_FORMATTING_ERROR でセッションを閉じる。pending には close と同一の
 * SessionError オブジェクトが reject され、削除集合 (pendingPublish +
 * requestStreams) が掃除される。
 */
test("bidiReadPublishResponse: malformed Track Properties で KEY_VALUE_FORMATTING_ERROR で閉じる", async () => {
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
  const okPayload = appendMalformedTrackProperties(
    encodeRequestOkPayload({
      type: MessageType.REQUEST_OK,
      parameters: [],
      trackProperties: [],
    }),
  );
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.REQUEST_OK, okPayload));
  ctx.readableController.close();
  await readPromise;

  // 具体エラー (KEY_VALUE_FORMATTING_ERROR) で reject され、同一オブジェクトで閉じる
  assert.instanceOf(rejected, SessionError);
  assert.equal((rejected as SessionError).code, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
  assert.strictEqual(rejected, ctx.getClosedWithError());
  // reject してから閉じる順序である
  assert.deepEqual(ctx.order, ["reject", "close"]);
  assert.isFalse(ctx.session.pendingPublish.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §8.3 / §9.7:
 * malformed な Track Properties を含む SUBSCRIBE_OK を受信したら
 * KEY_VALUE_FORMATTING_ERROR でセッションを閉じる。削除集合 (pendingSubscribe +
 * requestStreams + fillFetchTargets) が掃除される。
 */
test("bidiReadSubscribeResponse: malformed Track Properties で KEY_VALUE_FORMATTING_ERROR で閉じる", async () => {
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

  const readPromise = bidiReadSubscribeResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  const okPayload = appendMalformedTrackProperties(
    encodeSubscribeOkPayload({
      type: MessageType.SUBSCRIBE_OK,
      trackAlias: 1n,
      parameters: [],
      trackProperties: [],
    }),
  );
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.SUBSCRIBE_OK, okPayload));
  ctx.readableController.close();
  await readPromise;

  assert.instanceOf(rejected, SessionError);
  assert.equal((rejected as SessionError).code, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
  assert.strictEqual(rejected, ctx.getClosedWithError());
  assert.deepEqual(ctx.order, ["reject", "close"]);
  assert.isFalse(ctx.session.pendingSubscribe.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isFalse(ctx.session.fillFetchTargets.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §8.3 / §9.12:
 * malformed な Track Properties を含む FETCH_OK を受信したら
 * KEY_VALUE_FORMATTING_ERROR でセッションを閉じる。待機中の fetcher 取得も
 * 起こし、削除集合 (pendingFetch + requestStreams) が掃除される。
 */
test("bidiReadFetchResponse: malformed Track Properties で KEY_VALUE_FORMATTING_ERROR で閉じる", async () => {
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
  });
  // 待機中の fetcher 取得が起こされることを検証する
  let fetcherReadyFired = false;
  ctx.session.fetcherReadyCallbacks.set(ctx.requestId, [
    () => {
      fetcherReadyFired = true;
    },
  ]);

  const readPromise = bidiReadFetchResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  const okPayload = appendMalformedTrackProperties(
    encodeFetchOkPayload({
      type: MessageType.FETCH_OK,
      endOfTrack: false,
      endLocation: { group: 0n, object: 0n },
      parameters: [],
      trackProperties: [],
    }),
  );
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.FETCH_OK, okPayload));
  ctx.readableController.close();
  await readPromise;

  assert.instanceOf(rejected, SessionError);
  assert.equal((rejected as SessionError).code, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
  assert.strictEqual(rejected, ctx.getClosedWithError());
  assert.deepEqual(ctx.order, ["reject", "close"]);
  assert.isTrue(fetcherReadyFired);
  assert.isFalse(ctx.session.fetcherReadyCallbacks.has(ctx.requestId));
  assert.isFalse(ctx.session.pendingFetch.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §8.3 / §9.13:
 * malformed な Track Properties を含む TRACK_STATUS_OK を受信したら
 * KEY_VALUE_FORMATTING_ERROR でセッションを閉じる。削除集合
 * (pendingTrackStatus + requestStreams) が掃除される。
 */
test("bidiReadTrackStatusResponse: malformed Track Properties で KEY_VALUE_FORMATTING_ERROR で閉じる", async () => {
  const ctx = createOkResponseReadTestContext();
  let rejected: Error | undefined;
  ctx.session.pendingTrackStatus.set(ctx.requestId, {
    // malformed 検出時の cross-cancel 用の比較キー (本テストでは未使用)
    trackKey: fullTrackNameKey(["test"], "track"),
    resolve: () => {},
    reject: (error: Error) => {
      ctx.order.push("reject");
      rejected = error;
    },
  });

  const readPromise = bidiReadTrackStatusResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  const okPayload = appendMalformedTrackProperties(
    encodeRequestOkPayload({
      type: MessageType.REQUEST_OK,
      parameters: [],
      trackProperties: [],
    }),
  );
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.REQUEST_OK, okPayload));
  ctx.readableController.close();
  await readPromise;

  assert.instanceOf(rejected, SessionError);
  assert.equal((rejected as SessionError).code, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
  assert.strictEqual(rejected, ctx.getClosedWithError());
  assert.deepEqual(ctx.order, ["reject", "close"]);
  assert.isFalse(ctx.session.pendingTrackStatus.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §8.3 / §9.3:
 * subscribe ロールのリクエストストリームで malformed な Track Properties を
 * 含む REQUEST_UPDATE_OK を受信したら KEY_VALUE_FORMATTING_ERROR でセッションを
 * 閉じる (bidiReadRequestStreamMessages の catch 経由。handleRequestStreamReadError
 * の SessionError 分岐は既存どおり close のみとし、pending の後始末は close に
 * 委ねる)。
 */
test("bidiReadRequestStreamMessages: malformed な REQUEST_UPDATE_OK で KEY_VALUE_FORMATTING_ERROR で閉じる", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  ctx.session.subscribers.set(ctx.requestId, subscriber);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  const okPayload = appendMalformedTrackProperties(
    encodeRequestOkPayload({
      type: MessageType.REQUEST_OK,
      parameters: [],
      trackProperties: [],
    }),
  );
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.REQUEST_OK, okPayload),
  );
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
  assert.isTrue(
    ctx.closedWithError!.message.includes("key-value-pair value does not match serialization"),
  );
});

test("bidiReadTrackStatusResponse: 非違反失敗で削除集合が掃除される", async () => {
  const ctx = createOkResponseReadTestContext();
  let rejected: Error | undefined;
  ctx.session.pendingTrackStatus.set(ctx.requestId, {
    // malformed 検出時の cross-cancel 用の比較キー (本テストでは未使用)
    trackKey: fullTrackNameKey(["test"], "track"),
    resolve: () => {},
    reject: (error: Error) => {
      rejected = error;
    },
  });

  const readPromise = bidiReadTrackStatusResponse(
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
  assert.isFalse(ctx.session.pendingTrackStatus.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §9.20.1 / §9.5.1:
 * REQUEST_UPDATE_OK のパラメータスコープ違反で、当該購読の保留分全件が
 * 違反 SessionError 自体で reject され、fill 関連付けも掃除されることを検証する。
 */
test("bidiHandleRequestUpdateOk: スコープ違反で保留中の更新が違反 SessionError 自体で reject される", () => {
  const order: string[] = [];
  let closedWithError: SessionError | undefined;
  const session = {
    closeWithError: (error: SessionError) => {
      order.push("close");
      closedWithError = error;
    },
    subscribers: new Map(),
    pendingRequestUpdate: new Map(),
    fillFetchTargets: new Map(),
    goawayReceivedOnRequestStreams: new Set(),
    unmatchedRequestOkAllowances: new Map(),
  } as unknown as BidiSessionInternal;
  const subscriber = new SubscriberImpl(["test"], "track", 7n, 1n, () => {});
  const rejected: Error[] = [];
  session.pendingRequestUpdate.set(101n, {
    resolve: () => {},
    reject: (error: Error) => {
      order.push("reject");
      rejected.push(error);
    },
    targetRequestId: 7n,
  });
  session.pendingRequestUpdate.set(102n, {
    resolve: () => {},
    reject: (error: Error) => {
      order.push("reject");
      rejected.push(error);
    },
    targetRequestId: 7n,
  });
  session.pendingRequestUpdate.set(103n, {
    resolve: () => {},
    reject: () => {
      order.push("other-reject");
    },
    targetRequestId: 8n,
  });
  session.fillFetchTargets.set(101n, { subscriber, groupOrder: GroupOrder.ASCENDING });
  session.fillFetchTargets.set(102n, { subscriber, groupOrder: GroupOrder.ASCENDING });

  // FORWARD は REQUEST_UPDATE_OK (LARGEST_OBJECT / EXPIRES のみ許可) のスコープ違反である
  const payload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [{ type: MessageParameterType.FORWARD, value: new Uint8Array([1]) }],
    trackProperties: [],
  });
  bidiHandleRequestUpdateOk(session, payload, 7n);

  // 違反 SessionError 自体で reject され、fill 関連付けも掃除される
  assert.equal(rejected.length, 2);
  assert.isDefined(closedWithError);
  assert.strictEqual(rejected[0], closedWithError);
  assert.strictEqual(rejected[1], closedWithError);
  assert.equal(closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(
    closedWithError!.message.includes("parameter type 0x10 not allowed in REQUEST_UPDATE_OK"),
  );
  assert.deepEqual(order, ["reject", "reject", "close"]);
  assert.isFalse(session.pendingRequestUpdate.has(101n));
  assert.isFalse(session.pendingRequestUpdate.has(102n));
  assert.isTrue(session.pendingRequestUpdate.has(103n));
  assert.isFalse(session.fillFetchTargets.has(101n));
  assert.isFalse(session.fillFetchTargets.has(102n));
});

/**
 * draft-ietf-moq-transport-21 §9.3 / §9.5.1:
 * REQUEST_UPDATE_OK の Track Properties 空検証違反でも同様に
 * 違反 SessionError 自体で reject されることを検証する。
 */
test("bidiHandleRequestUpdateOk: Track Properties 違反で保留中の更新が違反 SessionError 自体で reject される", () => {
  const order: string[] = [];
  let closedWithError: SessionError | undefined;
  const session = {
    closeWithError: (error: SessionError) => {
      order.push("close");
      closedWithError = error;
    },
    subscribers: new Map(),
    pendingRequestUpdate: new Map(),
    fillFetchTargets: new Map(),
    goawayReceivedOnRequestStreams: new Set(),
    unmatchedRequestOkAllowances: new Map(),
  } as unknown as BidiSessionInternal;
  const subscriber = new SubscriberImpl(["test"], "track", 7n, 1n, () => {});
  const rejected: Error[] = [];
  session.pendingRequestUpdate.set(101n, {
    resolve: () => {},
    reject: (error: Error) => {
      order.push("reject");
      rejected.push(error);
    },
    targetRequestId: 7n,
  });
  session.pendingRequestUpdate.set(103n, {
    resolve: () => {},
    reject: () => {
      order.push("other-reject");
    },
    targetRequestId: 8n,
  });
  session.fillFetchTargets.set(101n, { subscriber, groupOrder: GroupOrder.ASCENDING });

  const payload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [{ id: 0n, value: 1n }],
  });
  bidiHandleRequestUpdateOk(session, payload, 7n);

  assert.equal(rejected.length, 1);
  assert.isDefined(closedWithError);
  assert.strictEqual(rejected[0], closedWithError);
  assert.equal(closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(
    closedWithError!.message.includes("track properties must be empty in REQUEST_UPDATE_OK"),
  );
  assert.deepEqual(order, ["reject", "close"]);
  assert.isFalse(session.pendingRequestUpdate.has(101n));
  assert.isTrue(session.pendingRequestUpdate.has(103n));
  assert.isFalse(session.fillFetchTargets.has(101n));
});

/**
 * draft-ietf-moq-transport-21 §3.2.1 / §9.11:
 * 失敗確定時に待機中の fetcher 取得が即時解決することを検証する。
 * 待機の解決値は fetchers 不在のため null になる。
 */

// 待機タイムアウトと即時性の判定閾値。
// 閾値はタイムアウトの半分とし、自前タイマー満了との区別に余裕を持たせる
const FETCH_WAITER_TIMEOUT_MS = 1000;
const FETCH_WAITER_IMMEDIATE_THRESHOLD_MS = FETCH_WAITER_TIMEOUT_MS / 2;
async function readFetchWithWaiter(
  setup: () => ReturnType<typeof createOkResponseReadTestContext>,
  feed: (ctx: ReturnType<typeof createOkResponseReadTestContext>) => void,
): Promise<{
  waiter: Fetcher | null;
  elapsed: number;
  session: BidiSessionInternal;
  requestId: bigint;
}> {
  const ctx = setup();
  const internal = ctx.session as unknown as SessionInternal;
  const waiter = incomingWaitForFetcher(internal, ctx.requestId, FETCH_WAITER_TIMEOUT_MS);
  const started = Date.now();
  const readPromise = bidiReadFetchResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  feed(ctx);
  await readPromise;
  const result = await waiter;
  return {
    waiter: result,
    elapsed: Date.now() - started,
    session: ctx.session,
    requestId: ctx.requestId,
  };
}

function createFetchWaiterContext(): ReturnType<typeof createOkResponseReadTestContext> {
  const ctx = createOkResponseReadTestContext();
  const fetcher = new FetcherImpl(["test"], "track", ctx.requestId, () => {});
  // pendingFetch 不在では待機経路自体に入らず即時 null 解決するため、
  // 登録は検証の前提であり削除してはならない
  ctx.session.pendingFetch.set(ctx.requestId, {
    resolve: () => {},
    reject: () => {},
    impl: fetcher,
  });
  return ctx;
}

test("bidiReadFetchResponse: REQUEST_ERROR で待機者が即時解決する", async () => {
  const { waiter, elapsed, session, requestId } = await readFetchWithWaiter(
    createFetchWaiterContext,
    (ctx) => {
      const errorPayload = encodeRequestErrorPayload({
        type: MessageType.REQUEST_ERROR,
        errorCode: BigInt(RequestErrorCode.INTERNAL_ERROR),
        retryInterval: 0n,
        reasonPhrase: "request failed",
      });
      ctx.readableController.enqueue(
        ctx.session.controlWriter!.encode(MessageType.REQUEST_ERROR, errorPayload),
      );
      ctx.readableController.close();
    },
  );

  assert.isNull(waiter);
  assert.isBelow(elapsed, FETCH_WAITER_IMMEDIATE_THRESHOLD_MS);
  assert.isFalse(session.fetcherReadyCallbacks.has(requestId));
});

test("bidiReadFetchResponse: GOAWAY で待機者が即時解決する", async () => {
  const { waiter, elapsed, session, requestId } = await readFetchWithWaiter(
    createFetchWaiterContext,
    (ctx) => {
      const goawayPayload = encodeGoawayPayload({
        type: MessageType.GOAWAY,
        newSessionUri: "moqt://new.example.com",
        timeout: 0n,
      });
      ctx.readableController.enqueue(
        ctx.session.controlWriter!.encode(MessageType.GOAWAY, goawayPayload),
      );
      ctx.readableController.close();
    },
  );

  assert.isNull(waiter);
  assert.isBelow(elapsed, FETCH_WAITER_IMMEDIATE_THRESHOLD_MS);
  assert.isFalse(session.fetcherReadyCallbacks.has(requestId));
});

test("bidiReadFetchResponse: 想定外型 (SUBSCRIBE_OK) で待機者が即時解決する", async () => {
  const { waiter, elapsed, session, requestId } = await readFetchWithWaiter(
    createFetchWaiterContext,
    (ctx) => {
      const okPayload = encodeSubscribeOkPayload({
        type: MessageType.SUBSCRIBE_OK,
        trackAlias: 1n,
        parameters: [],
        trackProperties: [],
      });
      ctx.readableController.enqueue(
        ctx.session.controlWriter!.encode(MessageType.SUBSCRIBE_OK, okPayload),
      );
      ctx.readableController.close();
    },
  );

  assert.isNull(waiter);
  assert.isBelow(elapsed, FETCH_WAITER_IMMEDIATE_THRESHOLD_MS);
  assert.isFalse(session.fetcherReadyCallbacks.has(requestId));
});

test("bidiReadFetchResponse: 読み取り失敗で待機者が即時解決する", async () => {
  const { waiter, elapsed, session, requestId } = await readFetchWithWaiter(
    createFetchWaiterContext,
    (ctx) => {
      ctx.readableController.error(new Error("stream broken"));
    },
  );

  assert.isNull(waiter);
  assert.isBelow(elapsed, FETCH_WAITER_IMMEDIATE_THRESHOLD_MS);
  assert.isFalse(session.fetcherReadyCallbacks.has(requestId));
});

test("bidiReadFetchResponse: PUBLISH_STATE_NOTIFY で待機者が即時解決する", async () => {
  const { waiter, elapsed, session, requestId } = await readFetchWithWaiter(
    createFetchWaiterContext,
    (ctx) => {
      const notifyPayload = encodePublishStateNotifyPayload({
        type: MessageType.PUBLISH_STATE_NOTIFY,
        parameters: [],
      });
      ctx.readableController.enqueue(
        ctx.session.controlWriter!.encode(MessageType.PUBLISH_STATE_NOTIFY, notifyPayload),
      );
      ctx.readableController.close();
    },
  );

  assert.isNull(waiter);
  assert.isBelow(elapsed, FETCH_WAITER_IMMEDIATE_THRESHOLD_MS);
  assert.isFalse(session.fetcherReadyCallbacks.has(requestId));
});

test("bidiReadFetchResponse: 不正ペイロードで待機者が即時解決する", async () => {
  const { waiter, elapsed, session, requestId } = await readFetchWithWaiter(
    createFetchWaiterContext,
    (ctx) => {
      ctx.readableController.enqueue(
        ctx.session.controlWriter!.encode(MessageType.FETCH_OK, new Uint8Array([0x00])),
      );
      ctx.readableController.close();
    },
  );

  assert.isNull(waiter);
  assert.isBelow(elapsed, FETCH_WAITER_IMMEDIATE_THRESHOLD_MS);
  assert.isFalse(session.fetcherReadyCallbacks.has(requestId));
});

test("bidiReadFetchResponse: FIN 先行で待機者が即時解決する", async () => {
  // FIN 先行は enqueue なしの close のみで再現する。
  // 読み取り失敗とは別経路だが同一 catch 節に合流することを直接検証する
  const { waiter, elapsed, session, requestId } = await readFetchWithWaiter(
    createFetchWaiterContext,
    (ctx) => {
      ctx.readableController.close();
    },
  );

  assert.isNull(waiter);
  assert.isBelow(elapsed, FETCH_WAITER_IMMEDIATE_THRESHOLD_MS);
  assert.isFalse(session.fetcherReadyCallbacks.has(requestId));
});

/**
 * 受信 REQUEST_UPDATE の ID 検証に実関数を配線する。
 *
 * 既存モックの無条件通過 (常に true) を実関数に差し替え、
 * パリティ・重複を実際に検証する。received 集合
 * (検証済み ID の記録) を返す。
 * ストリーム紐付け ID (10n) と更新 ID (100n / 101n) を分離し、
 * 一致照合なし仕様の裏付けにする。
 */
function useRealRequestIdValidation(ctx: { session: BidiSessionInternal }): Set<bigint> {
  const received = new Set<bigint>();
  ctx.session.validateIncomingRequestId = (requestId: bigint) =>
    incomingValidateRequestId(requestId, received);
  return received;
}

/**
 * draft-ietf-moq-transport-21 §6.4.2.1:
 * 受信 PUBLISH 上の REQUEST_UPDATE で偶数 Request ID を受けると
 * INVALID_REQUEST_ID で閉じることを検証する。
 */
test("bidiHandlePublishRequestUpdate: 偶数 Request ID で INVALID_REQUEST_ID で閉じる", async () => {
  const ctx = createPublishReadTestContext({});
  useRealRequestIdValidation(ctx);
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 100n,
    parameters: [],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.INVALID_REQUEST_ID);
  assert.isTrue(ctx.closedWithError!.message.includes("parity"));
  assert.equal(ctx.written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.1:
 * 受信 PUBLISH 上の REQUEST_UPDATE で重複 Request ID を受けると
 * INVALID_REQUEST_ID で閉じることを検証する。
 */
test("bidiHandlePublishRequestUpdate: 重複 Request ID で INVALID_REQUEST_ID で閉じる", async () => {
  const ctx = createPublishReadTestContext({});
  const received = useRealRequestIdValidation(ctx);
  received.add(101n);
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.INVALID_REQUEST_ID);
  assert.isTrue(ctx.closedWithError!.message.includes("duplicate"));
  assert.equal(ctx.written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.1:
 * 新規の奇数 Request ID は検証を通過して REQUEST_OK が応答され、
 * 同一 ID の 2 回目は重複として閉じることを検証する。
 * 検証通過時の ID 消費 (received への記録) の裏付けになる。
 */
test("bidiHandlePublishRequestUpdate: 新規奇数 Request ID は受理し再送で重複として閉じる", async () => {
  const ctx = createPublishReadTestContext({});
  const received = useRealRequestIdValidation(ctx);
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  // 1 回目は REQUEST_OK が 1 通応答され、セッションは閉じない
  // (assert.isUndefined は戻り値型のナローイングが以降の読み直しに残るため
  // equal で比較する。vite-plus/test の isUndefined は asserts 付きである)
  assert.equal(ctx.closedWithError, undefined);
  assert.equal(ctx.written.length, 1);
  assert.isTrue(received.has(101n));

  // 同一 ID の 2 回目は重複として閉じ、余分な応答は送らない
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);
  const secondError = ctx.closedWithError;
  assert.isDefined(secondError);
  assert.equal(secondError.code, SessionErrorCode.INVALID_REQUEST_ID);
  assert.isTrue(secondError.message.includes("duplicate"));
  assert.equal(ctx.written.length, 1);
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.1:
 * 送信 PUBLISH ストリーム上のピア更新受信で偶数 Request ID を受けると
 * INVALID_REQUEST_ID で閉じることを検証する。
 */
test("bidiReadRequestStreamMessages: ピア更新の偶数 Request ID で INVALID_REQUEST_ID で閉じる", async () => {
  const ctx = createPublishReadTestContext({});
  useRealRequestIdValidation(ctx);
  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 100n,
    parameters: [],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.INVALID_REQUEST_ID);
  assert.isTrue(ctx.closedWithError!.message.includes("parity"));
  assert.equal(ctx.written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.1:
 * 送信 PUBLISH ストリーム上のピア更新受信で重複 Request ID を受けると
 * INVALID_REQUEST_ID で閉じることを検証する。
 */
test("bidiReadRequestStreamMessages: ピア更新の重複 Request ID で INVALID_REQUEST_ID で閉じる", async () => {
  const ctx = createPublishReadTestContext({});
  const received = useRealRequestIdValidation(ctx);
  received.add(101n);
  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.INVALID_REQUEST_ID);
  assert.isTrue(ctx.closedWithError!.message.includes("duplicate"));
  assert.equal(ctx.written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.1 / §9.4:
 * GOAWAY 受信済みでも不正 ID は INVALID_REQUEST_ID で閉じることを検証する。
 * §6.4.2.1 MUST が §9.4 MAY 適用より優先する。
 */
test("bidiHandlePublishRequestUpdate: GOAWAY 下の偶数 ID は INVALID_REQUEST_ID で閉じる", async () => {
  const ctx = createPublishReadTestContext({});
  useRealRequestIdValidation(ctx);
  ctx.session.goawayReceivedOnRequestStreams.add(ctx.requestId);
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 100n,
    parameters: [],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.INVALID_REQUEST_ID);
  assert.isTrue(ctx.closedWithError!.message.includes("parity"));
  assert.equal(ctx.written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.1 / §9.5:
 * subscribe ロールでも不正 ID は INVALID_REQUEST_ID で閉じることを検証する。
 * §6.4.2.1 MUST が想定外更新の PROTOCOL_VIOLATION より優先する。
 */
test("bidiReadRequestStreamMessages: subscribe 側の偶数 ID は INVALID_REQUEST_ID で閉じる", async () => {
  const ctx = createPublishReadTestContext({});
  useRealRequestIdValidation(ctx);
  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 100n,
    parameters: [],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.INVALID_REQUEST_ID);
  assert.isTrue(ctx.closedWithError!.message.includes("parity"));
  assert.equal(ctx.written.length, 0);
});
