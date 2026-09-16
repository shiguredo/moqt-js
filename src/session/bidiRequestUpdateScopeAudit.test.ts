/**
 * session/bidi.ts の単体テスト: REQUEST_UPDATE のパラメータスコープと MAX_FILTER_RANGES の適合監査
 *
 * draft-21 のパラメータスコープと MAX_FILTER_RANGES に関する
 * REQUEST_UPDATE の受理 / 拒否の境界を検証する。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import { decodeRequestOkPayload, decodeRequestErrorPayload } from "../message/session";
import { MessageType, MessageParameterType } from "../message/types";
import { encodeRangeFilter, createTrackNamespace, encodeParameterTrackNamespace } from "../message";
import {
  decodeRequestUpdatePayload,
  encodeRequestUpdatePayload,
  encodeSubscribeOkPayload,
} from "../message/subscribe";
import { getParameterLocationValue } from "../message/parameter";
import { MalformedTrackError, SessionErrorCode, RequestErrorCode } from "../error";
import {
  createBidiSession,
  createPublishReadTestContext,
  createCancelObservableResponseContext,
} from "../testSupport/bidi";
import { concatUint8Arrays } from "../testSupport/helpers";
import { encodeVarint } from "../varint";
import { ControlStreamReader, ControlStreamWriter } from "../controlStream";
import {
  bidiHandlePublishRequestUpdate,
  bidiReadRequestStreamMessages,
  bidiReadSubscribeResponse,
  bidiSendRequestUpdate,
  cancelMalformedTrackPeers,
  type BidiSessionInternal,
} from "./bidi";
import { FetcherImpl } from "../fetcher";
import { fullTrackNameKey } from "../fullTrackName";

// ============================================================================
// draft-21 適合監査: REQUEST_UPDATE のパラメータスコープと MAX_FILTER_RANGES
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.20.21 / §9.20.1:
 * TRACK_NAMESPACE_PREFIX は namespace 系 (SUBSCRIBE_NAMESPACE /
 * SUBSCRIBE_TRACKS) の REQUEST_UPDATE にのみ出現できる。受信 PUBLISH
 * ストリーム上の通常 REQUEST_UPDATE で受信した場合は NOT_SUPPORTED ではなく
 * PROTOCOL_VIOLATION でセッションを閉じることを検証する。
 */
test("bidiHandlePublishRequestUpdate: TRACK_NAMESPACE_PREFIX で PROTOCOL_VIOLATION でセッションが閉じる", async () => {
  const ctx = createPublishReadTestContext({});
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [encodeParameterTrackNamespace(createTrackNamespace(["namespace"]))],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  // REQUEST_ERROR は応答されず、PROTOCOL_VIOLATION でセッションが閉じる
  assert.equal(ctx.written.length, 0);
  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(ctx.closedWithError!.message.includes("not allowed in REQUEST_UPDATE"));
});

/**
 * draft-ietf-moq-transport-21 §9.20.1 / §9.20.9:
 * GROUP_ORDER は REQUEST_UPDATE に出現できない (FILL_PARAMETERS 内側を除く)。
 * 受信 PUBLISH ストリーム上の REQUEST_UPDATE で受信した場合は
 * PROTOCOL_VIOLATION でセッションを閉じることを検証する。
 */
test("bidiHandlePublishRequestUpdate: GROUP_ORDER で PROTOCOL_VIOLATION でセッションが閉じる", async () => {
  const ctx = createPublishReadTestContext({});
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [{ type: MessageParameterType.GROUP_ORDER, value: new Uint8Array([0x01]) }],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  assert.equal(ctx.written.length, 0);
  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
});

/**
 * draft-ietf-moq-transport-21 §9.20.1 / §9.20.20:
 * NEW_GROUP_REQUEST は REQUEST_UPDATE (for a subscription) に出現できる。
 * 受信 PUBLISH ストリーム上の REQUEST_UPDATE で受理され REQUEST_OK が
 * 応答されることを検証する。
 */
test("bidiHandlePublishRequestUpdate: NEW_GROUP_REQUEST を含む REQUEST_UPDATE で REQUEST_OK が応答される", async () => {
  const ctx = createPublishReadTestContext({});
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [{ type: MessageParameterType.NEW_GROUP_REQUEST, value: encodeVarint(1n) }],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.1.6 (MAX FILTER RANGES):
 * 自 endpoint が MAX_FILTER_RANGES を広告していない (既定値 0) 場合、
 * ピアから REQUEST_UPDATE で Range Filter を受信したら
 * REQUEST_ERROR (INVALID_FILTER) で拒否することを検証する。
 */
test("bidiHandlePublishRequestUpdate: localMaxFilterRanges 0 の Range Filter で REQUEST_ERROR (INVALID_FILTER)", async () => {
  const ctx = createPublishReadTestContext({});
  // 既定 (未広告) は 0 のため、明示せずに既定値の挙動を検証する
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      {
        type: MessageParameterType.SUBGROUP_FILTER,
        value: encodeRangeFilter({
          type: "subgroup",
          setId: 0,
          ranges: [{ start: 0n, end: 1n }],
        }),
      },
    ],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  const decoded = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.INVALID_FILTER));
  assert.isTrue(decoded.reasonPhrase.includes("local MAX_FILTER_RANGES is 0"));
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.1.6 (MAX FILTER RANGES):
 * 自 endpoint の上限以内の Range Filter は受理し、超過は
 * REQUEST_ERROR (INVALID_FILTER) で拒否することを検証する。
 */
test("bidiHandlePublishRequestUpdate: localMaxFilterRanges 以内の Range Filter は受理し超過は拒否する", async () => {
  // 上限 2 で 2 Ranges は受理
  const accepted = createPublishReadTestContext({});
  (accepted.session as unknown as { localMaxFilterRanges: number }).localMaxFilterRanges = 2;
  const acceptedPayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      {
        type: MessageParameterType.SUBGROUP_FILTER,
        value: encodeRangeFilter({
          type: "subgroup",
          setId: 0,
          ranges: [
            { start: 0n, end: 1n },
            { start: 10n, end: 11n },
          ],
        }),
      },
    ],
  });
  await bidiHandlePublishRequestUpdate(accepted.session, accepted.requestId, acceptedPayload);
  const acceptedMessages = new ControlStreamReader().feed(concatUint8Arrays(accepted.written));
  assert.equal(acceptedMessages.length, 1);
  assert.equal(acceptedMessages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(accepted.closedWithError);

  // 上限 2 で 3 Ranges は超過として拒否
  const rejected = createPublishReadTestContext({});
  (rejected.session as unknown as { localMaxFilterRanges: number }).localMaxFilterRanges = 2;
  const rejectedPayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      {
        type: MessageParameterType.SUBGROUP_FILTER,
        value: encodeRangeFilter({
          type: "subgroup",
          setId: 0,
          ranges: [
            { start: 0n, end: 1n },
            { start: 10n, end: 11n },
            { start: 20n, end: 21n },
          ],
        }),
      },
    ],
  });
  await bidiHandlePublishRequestUpdate(rejected.session, rejected.requestId, rejectedPayload);
  const rejectedMessages = new ControlStreamReader().feed(concatUint8Arrays(rejected.written));
  assert.equal(rejectedMessages.length, 1);
  assert.equal(rejectedMessages[0].type, MessageType.REQUEST_ERROR);
  assert.equal(
    decodeRequestErrorPayload(rejectedMessages[0].payload).errorCode,
    BigInt(RequestErrorCode.INVALID_FILTER),
  );
  assert.isUndefined(rejected.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.20 (Control Message Parameters) / §9.20.1:
 * 送信 REQUEST_UPDATE の raw parameters に、その文脈で許可されない型
 * (GROUP_ORDER / EXPIRES) が混ざった場合は送信前に拒否することを検証する。
 */
test("bidiSendRequestUpdate: raw の GROUP_ORDER / EXPIRES は送信前に拒否される", async () => {
  for (const parameter of [
    { type: MessageParameterType.GROUP_ORDER, value: new Uint8Array([0x01]) },
    { type: MessageParameterType.EXPIRES, value: new Uint8Array([0x01]) },
  ]) {
    const { session, written } = createBidiSession();
    const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

    let thrown: Error | undefined;
    try {
      await bidiSendRequestUpdate(session, subscriber, { parameters: [parameter] });
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    }

    assert.isDefined(thrown);
    assert.isTrue(thrown!.message.includes("not allowed in REQUEST_UPDATE"));
    // 送信前に拒否するためワイヤには何も書かれない
    assert.equal(written.length, 0);
  }
});

/**
 * draft-ietf-moq-transport-21 §9.20.21 / §9.20.1:
 * TRACK_NAMESPACE_PREFIX は namespace 系 REQUEST_UPDATE 専用のため、
 * subscription 系 REQUEST_UPDATE の raw parameters では送信前に拒否する
 * ことを検証する。
 */
test("bidiSendRequestUpdate: raw の TRACK_NAMESPACE_PREFIX は送信前に拒否される", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      parameters: [encodeParameterTrackNamespace(createTrackNamespace(["namespace"]))],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("not allowed in REQUEST_UPDATE"));
  assert.equal(written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.20.8:
 * SUBSCRIBER_PRIORITY は REQUEST_UPDATE に出現できるため、raw parameters でも
 * 送信できることを検証する。
 */
test("bidiSendRequestUpdate: raw の SUBSCRIBER_PRIORITY は送信できる", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  const updatePromise = bidiSendRequestUpdate(session, subscriber, {
    parameters: [{ type: MessageParameterType.SUBSCRIBER_PRIORITY, value: new Uint8Array([0x01]) }],
  });
  // bidiSendRequestUpdate は REQUEST_OK 受信まで resolve しないため、
  // 送信完了後に pending を解決してから await する (既存テストと同形)。
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  assert.equal(messages.length, 1);
  const decoded = decodeRequestUpdatePayload(messages[0].payload);
  assert.isDefined(
    decoded.parameters.find((p) => p.type === MessageParameterType.SUBSCRIBER_PRIORITY),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.20.18 (LARGEST OBJECT Parameter) / §9.5.1:
 * 自 endpoint が Publisher として REQUEST_UPDATE を受理し REQUEST_OK を返す
 * 場合、Object を publish 済みなら LARGEST_OBJECT を必ず含めることを検証する。
 */
test("bidiReadRequestStreamMessages: publish 済み Object がある REQUEST_OK に LARGEST_OBJECT が含まれる (publish ロール)", async () => {
  const ctx = createPublishReadTestContext({});
  // 最大 Location {groupId: 5, objectId: 3} を publish 済みにする
  await ctx.publisher.sendObject({ groupId: 1, objectId: 0, payload: new Uint8Array() });
  await ctx.publisher.sendObject({ groupId: 5, objectId: 3, payload: new Uint8Array([1]) });

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

  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  const decoded = decodeRequestOkPayload(messages[0].payload);
  const largest = decoded.parameters.find((p) => p.type === MessageParameterType.LARGEST_OBJECT);
  assert.isDefined(largest);
  const location = getParameterLocationValue(largest!);
  assert.equal(location.group, 5n);
  assert.equal(location.object, 3n);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.20.18:
 * "If omitted from a message, the sending endpoint has not published or
 *  received any Objects in the Track."
 * Object 未 publish の Publisher が返す REQUEST_OK には LARGEST_OBJECT を
 * 含めないことを検証する。
 */
test("bidiReadRequestStreamMessages: 未 publish の REQUEST_OK に LARGEST_OBJECT は含まれない (publish ロール)", async () => {
  const ctx = createPublishReadTestContext({});

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

  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  const decoded = decodeRequestOkPayload(messages[0].payload);
  assert.isUndefined(
    decoded.parameters.find((p) => p.type === MessageParameterType.LARGEST_OBJECT),
  );
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.20.21 / §9.20.1:
 * role=publish の受信 REQUEST_UPDATE に TRACK_NAMESPACE_PREFIX が含まれる場合、
 * namespace 系 REQUEST_UPDATE 専用のため PROTOCOL_VIOLATION でセッションを
 * 閉じることを検証する。
 */
test("bidiReadRequestStreamMessages: TRACK_NAMESPACE_PREFIX の REQUEST_UPDATE で PROTOCOL_VIOLATION (publish ロール)", async () => {
  const ctx = createPublishReadTestContext({});

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
    parameters: [encodeParameterTrackNamespace(createTrackNamespace(["namespace"]))],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.equal(ctx.written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.1.6 (MAX FILTER RANGES):
 * role=publish の受信 REQUEST_UPDATE で、自 endpoint が MAX_FILTER_RANGES を
 * 広告していない (既定値 0) 場合に Range Filter を受信したら
 * REQUEST_ERROR (INVALID_FILTER) と PUBLISH_DONE (UPDATE_FAILED) で拒否する
 * ことを検証する。
 */
test("bidiReadRequestStreamMessages: localMaxFilterRanges 0 の Range Filter で INVALID_FILTER (publish ロール)", async () => {
  const ctx = createPublishReadTestContext({});

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
    parameters: [
      {
        type: MessageParameterType.SUBGROUP_FILTER,
        value: encodeRangeFilter({
          type: "subgroup",
          setId: 0,
          ranges: [{ start: 0n, end: 1n }],
        }),
      },
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  assert.equal(
    decodeRequestErrorPayload(messages[0].payload).errorCode,
    BigInt(RequestErrorCode.INVALID_FILTER),
  );
  assert.equal(messages[1].type, MessageType.PUBLISH_DONE);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §12.1:
 * 「it MUST cancel any corresponding subscription or fetches for that Track」
 * 同一 Full Track Name の全購読と全 FETCH を cancel し、別 Track は触らない。
 */
test("cancelMalformedTrackPeers: 同一 Full Track Name の購読と FETCH を cancel する", async () => {
  const subErrors: Error[] = [];
  const fetchErrors: Error[] = [];
  const subscriber = new SubscriberImpl(
    ["live"],
    "video",
    1n,
    7n,
    () => {},
    undefined,
    undefined,
    (error) => {
      subErrors.push(error);
    },
  );
  // 同一 alias に同一 Full Track Name の購読を 2 件ぶら下げ、cancel 中の
  // splice で 2 件目が取りこぼされないことを検証する
  const secondSubscriber = new SubscriberImpl(["live"], "video", 5n, 7n, () => {});
  const otherSubscriber = new SubscriberImpl(["live"], "other", 2n, 8n, () => {});
  const fetcher = new FetcherImpl(
    ["live"],
    "video",
    3n,
    () => {},
    undefined,
    (error) => {
      fetchErrors.push(error);
    },
  );
  const otherFetcher = new FetcherImpl(["live"], "other", 4n, () => {});
  const session = {
    sessionState: "connected",
    subscribersByAlias: new Map([
      [7n, [subscriber, secondSubscriber]],
      [8n, [otherSubscriber]],
    ]),
    subscribers: new Map(),
    fetchers: new Map([
      [3n, fetcher],
      [4n, otherFetcher],
    ]),
    requestStreams: new Map(),
    pendingSubscribe: new Map(),
    pendingFetch: new Map(),
    pendingRequestUpdate: new Map(),
    fillFetchTargets: new Map(),
    goawayReceivedOnRequestStreams: new Set(),
    unmatchedRequestOkAllowances: new Map(),
    onRequestDrained: () => {},
    closeWithError: () => {},
  } as unknown as BidiSessionInternal;

  const error = new MalformedTrackError("malformed track");
  cancelMalformedTrackPeers(session, fullTrackNameKey(["live"], "video"), error);
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  // 同一 Track の購読 (同一 alias の 2 件目を含む) と FETCH が closed になり、
  // error が通知される
  assert.equal(subscriber.state, "closed");
  assert.equal(secondSubscriber.state, "closed");
  assert.equal(fetcher.state, "closed");
  assert.equal(subErrors.length, 1);
  assert.equal(fetchErrors.length, 1);
  // 別 Track の購読 / FETCH は触らない
  assert.equal(otherSubscriber.state, "active");
  assert.equal(otherFetcher.state, "active");
});

/**
 * draft-ietf-moq-transport-21 §12.1 / §3.1:
 * 応答待ちの pending 購読 / FETCH も同一 Track の比較キーで cancel され、
 * reject される。pending 中の SubscriberImpl.state は active のため、
 * error コールバックは呼ばれない (reject との二重通知なし)。
 */
test("cancelMalformedTrackPeers: 同一 Track の pending 購読と FETCH も cancel する", async () => {
  const pendingSubErrors: Error[] = [];
  const pendingSubscriber = new SubscriberImpl(
    ["live"],
    "video",
    10n,
    7n,
    () => {},
    undefined,
    undefined,
    (error) => {
      pendingSubErrors.push(error);
    },
  );
  let subRejected: Error | undefined;
  const otherPendingSubscriber = new SubscriberImpl(["live"], "other", 11n, 8n, () => {});
  let otherSubRejected: Error | undefined;
  const pendingFetcher = new FetcherImpl(["live"], "video", 12n, () => {});
  let fetchRejected: Error | undefined;
  const otherPendingFetcher = new FetcherImpl(["live"], "other", 13n, () => {});
  let otherFetchRejected: Error | undefined;
  const session = {
    sessionState: "connected",
    subscribersByAlias: new Map(),
    subscribers: new Map(),
    fetchers: new Map(),
    pendingSubscribe: new Map([
      [
        10n,
        {
          resolve: () => {},
          reject: (error: Error) => {
            subRejected = error;
          },
          impl: pendingSubscriber,
          objectCallback: () => {},
        },
      ],
      [
        11n,
        {
          resolve: () => {},
          reject: (error: Error) => {
            otherSubRejected = error;
          },
          impl: otherPendingSubscriber,
          objectCallback: () => {},
        },
      ],
    ]),
    pendingFetch: new Map([
      [
        12n,
        {
          resolve: () => {},
          reject: (error: Error) => {
            fetchRejected = error;
          },
          impl: pendingFetcher,
        },
      ],
      [
        13n,
        {
          resolve: () => {},
          reject: (error: Error) => {
            otherFetchRejected = error;
          },
          impl: otherPendingFetcher,
        },
      ],
    ]),
    requestStreams: new Map(),
    pendingRequestUpdate: new Map(),
    fillFetchTargets: new Map(),
    fetcherReadyCallbacks: new Map(),
    goawayReceivedOnRequestStreams: new Set(),
    unmatchedRequestOkAllowances: new Map(),
    onRequestDrained: () => {},
    closeWithError: () => {},
  } as unknown as BidiSessionInternal;

  const error = new MalformedTrackError("malformed track");
  cancelMalformedTrackPeers(session, fullTrackNameKey(["live"], "video"), error);
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  // 同一 Track の pending が Map から削除され、同一 error で reject される
  assert.isFalse(session.pendingSubscribe.has(10n));
  assert.isFalse(session.pendingFetch.has(12n));
  assert.strictEqual(subRejected, error);
  assert.strictEqual(fetchRejected, error);
  // pending の購読は closed になる
  assert.equal(pendingSubscriber.state, "closed");
  // pending 自身への error コールバックは呼ばれない (reject との二重通知なし)
  assert.equal(pendingSubErrors.length, 0);
  // 別 Track の pending は触らない
  assert.isTrue(session.pendingSubscribe.has(11n));
  assert.isTrue(session.pendingFetch.has(13n));
  assert.isUndefined(otherSubRejected);
  assert.isUndefined(otherFetchRejected);
  assert.equal(otherPendingSubscriber.state, "active");
});

/**
 * draft-ietf-moq-transport-21 §2.4.1 / §12.1:
 * Full Track Name の比較キーはフィールド境界が一意なため、区切り文字の曖昧さで
 * 無関係な Track が cross-cancel されない。namespace ["a"] + trackName "b/c" と
 * namespace ["a","b"] + trackName "c" は "/" 連結では同じ "a/b/c" になっていた。
 */
test("cancelMalformedTrackPeers: 区切り文字が衝突する別 Track を cancel しない", async () => {
  const collidingSubscriber = new SubscriberImpl(["a"], "b/c", 1n, 7n, () => {});
  const targetSubscriber = new SubscriberImpl(["a", "b"], "c", 2n, 8n, () => {});
  const targetFetchErrors: Error[] = [];
  const targetFetcher = new FetcherImpl(
    ["a", "b"],
    "c",
    3n,
    () => {},
    undefined,
    (error) => {
      targetFetchErrors.push(error);
    },
  );
  const collidingFetcher = new FetcherImpl(["a"], "b/c", 4n, () => {});
  const session = {
    sessionState: "connected",
    subscribersByAlias: new Map([
      [7n, [collidingSubscriber]],
      [8n, [targetSubscriber]],
    ]),
    subscribers: new Map(),
    fetchers: new Map([
      [3n, targetFetcher],
      [4n, collidingFetcher],
    ]),
    requestStreams: new Map(),
    pendingSubscribe: new Map(),
    pendingFetch: new Map(),
    pendingRequestUpdate: new Map(),
    fillFetchTargets: new Map(),
    goawayReceivedOnRequestStreams: new Set(),
    unmatchedRequestOkAllowances: new Map(),
    onRequestDrained: () => {},
    closeWithError: () => {},
  } as unknown as BidiSessionInternal;

  const error = new MalformedTrackError("malformed track");
  // namespace ["a","b"] + trackName "c" の malformed 検出を通知する
  cancelMalformedTrackPeers(session, targetSubscriber.getFullTrackNameKey(), error);
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  // 対象 Track の購読と FETCH だけが cancel される
  assert.equal(targetSubscriber.state, "closed");
  assert.equal(targetFetcher.state, "closed");
  assert.equal(targetFetchErrors.length, 1);
  // 旧実装で同じキー ("a/b/c") になっていた別 Track は cancel されない
  assert.equal(collidingSubscriber.state, "active");
  assert.equal(collidingFetcher.state, "active");
});

/**
 * draft-ietf-moq-transport-21 §12.1 / §3.1:
 * 応答待ちの読み取りループが保持する reader は RequestStreamInfo に登録され、
 * malformed track の cross-cancel はロック保持者経由の STOP_SENDING
 * (reader.cancel) として届く。
 */
test("bidiReadSubscribeResponse: 応答待ちの cross-cancel がロック保持中の reader に届く", async () => {
  const ctx = createCancelObservableResponseContext();
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  ctx.session.pendingSubscribe.set(ctx.requestId, {
    resolve: () => {},
    reject: () => {},
    impl: subscriber,
    objectCallback: () => {},
  });

  const readPromise = bidiReadSubscribeResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  // 読み取りループが reader を RequestStreamInfo に登録するまで待つ
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  assert.isDefined(ctx.session.requestStreams.get(ctx.requestId)?.reader);

  cancelMalformedTrackPeers(
    ctx.session,
    fullTrackNameKey(["test"], "track"),
    new MalformedTrackError("malformed track"),
  );
  await readPromise;
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  // ロック保持中の reader 経由の cancel でも STOP_SENDING / RESET_STREAM が届く
  assert.deepEqual(ctx.cancelled, ["subscription cancelled"]);
  assert.deepEqual(ctx.aborted, ["subscription cancelled"]);
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isUndefined(ctx.getClosedWithError());
});

/**
 * draft-ietf-moq-transport-21 §12.1:
 * cancel 済みの pending に遅延して well-formed な応答が届いても購読を
 * 確立しない。送信準備中に cross-cancel され requestStreams が未登録の
 * まま読み取りループが動き続ける状況でも、応答受信時に pending の在否を
 * 再確認して破棄する。
 */
test("bidiReadSubscribeResponse: cancel 済み pending への遅延応答で購読が確立しない", async () => {
  const ctx = createCancelObservableResponseContext();
  // 送信準備中の cross-cancel で requestStreams 未登録のまま読み取りが始まった状況
  ctx.session.requestStreams.clear();
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

  const readPromise = bidiReadSubscribeResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  const error = new MalformedTrackError("malformed track");
  cancelMalformedTrackPeers(ctx.session, fullTrackNameKey(["test"], "track"), error);

  // cancel 済み pending に遅延して well-formed な SUBSCRIBE_OK が届く
  const okPayload = encodeSubscribeOkPayload({
    type: MessageType.SUBSCRIBE_OK,
    trackAlias: 1n,
    parameters: [],
    trackProperties: [],
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.SUBSCRIBE_OK, okPayload));
  await readPromise;
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  assert.strictEqual(rejected, error);
  // 購読は確立せず、購読 Map にも残らない
  assert.isFalse(ctx.session.subscribers.has(ctx.requestId));
  assert.isFalse(ctx.session.subscribersByAlias.has(1n));
  assert.equal(subscriber.state, "closed");
  // 遅延応答の破棄で STOP_SENDING を送る
  assert.deepEqual(ctx.cancelled, ["response cancelled"]);
  assert.isUndefined(ctx.getClosedWithError());
});

/**
 * draft-ietf-moq-transport-21 §12.1:
 * pending 登録から送信完了までの間に cross-cancel された場合でも、
 * 登録済みストリームを STOP_SENDING / RESET_STREAM で後始末し、
 * requestStreams にエントリを残さない。
 */
test("bidiReadSubscribeResponse: 送信準備中の cross-cancel でストリームを後始末する", async () => {
  const ctx = createCancelObservableResponseContext();
  // pending が cross-cancel で削除済み、requestStreams の登録だけが残った状況
  await bidiReadSubscribeResponse(ctx.session, ctx.requestId, ctx.stream, ctx.controlReader);
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  assert.deepEqual(ctx.cancelled, ["request cancelled"]);
  assert.deepEqual(ctx.aborted, ["request cancelled"]);
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isUndefined(ctx.getClosedWithError());
});

// ============================================================================
// draft-21 適合監査: MAX_REQUEST_UPDATES の受信側強制 (§9.1.7)
// ============================================================================

/**
 * REQUEST_UPDATE を通し番号付きで連結し、1 回の read に含まれる 1 チャンクを作る
 *
 * draft-ietf-moq-transport-21 §9.1.7 の上限超過は「1 回の read に上限 + 1 通が
 * 含まれる」場合にだけ検出できる (応答 1 通ごとに減算する実装では未応答数が
 * 常に 0 か 1 になり検出できない)。そのためテストでは複数通を 1 チャンクに
 * 連結して届ける。
 */
function encodeRequestUpdateChunk(requestIds: bigint[]): Uint8Array {
  const writer = new ControlStreamWriter();
  return concatUint8Arrays(
    requestIds.map((requestId) =>
      writer.encode(
        MessageType.REQUEST_UPDATE,
        encodeRequestUpdatePayload({ type: MessageType.REQUEST_UPDATE, requestId, parameters: [] }),
      ),
    ),
  );
}

/**
 * draft-ietf-moq-transport-21 §9.1.7 (MAX_REQUEST_UPDATES):
 * 自 endpoint が上限 N を広告した状態で、1 回の read に N+1 通の
 * REQUEST_UPDATE を含むチャンクを届けた場合、N 通目までは REQUEST_OK を応答し
 * N+1 通目の処理で TOO_MANY_REQUEST_UPDATES によりセッションを閉じる MUST を
 * 検証する (N=2)。チャンク単位の減算により、N 通目の応答後も未応答数が
 * 残った状態で N+1 通目を判定できる。
 */
test("bidiReadRequestStreamMessages: 上限 + 1 通の 1 チャンクで TOO_MANY_REQUEST_UPDATES により閉じる (publish ロール)", async () => {
  const ctx = createPublishReadTestContext({});
  // 上限 2 を広告した状態にする
  // (BidiSessionInternal では readonly のため既存の localMaxFilterRanges と同じくキャストする)
  (ctx.session as unknown as { localMaxRequestUpdates: number }).localMaxRequestUpdates = 2;

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // 1 回の read に 3 通 (上限 2 + 1) を連結して届ける
  ctx.readableController.enqueue(encodeRequestUpdateChunk([101n, 103n, 105n]));
  ctx.readableController.close();
  await readPromise;

  // 1 通目と 2 通目は応答し、3 通目は応答せずにセッションが閉じる
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.equal(messages[1].type, MessageType.REQUEST_OK);
  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.TOO_MANY_REQUEST_UPDATES);
  // セッションを閉じる分岐でも、チャンク単位の減算は同じ finally が担うため残留しない
  assert.equal(ctx.session.receivedRequestUpdateCounts.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.1.7 (MAX_REQUEST_UPDATES):
 * 上限以内のチャンクを応答ごとに繰り返し届ける限り閉じないことを検証する。
 * 1 回の read のメッセージ列を処理し終えると、その read で加算した件数分が
 * 未応答数から戻るため、チャンクをまたいで未応答数が積み上がらない。
 */
test("bidiReadRequestStreamMessages: 上限以内のチャンクを繰り返し届けても閉じない (publish ロール)", async () => {
  const ctx = createPublishReadTestContext({});
  (ctx.session as unknown as { localMaxRequestUpdates: number }).localMaxRequestUpdates = 2;

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // 上限と同数の 2 通のチャンクを続けて 2 つ届ける (合計 4 通)
  ctx.readableController.enqueue(encodeRequestUpdateChunk([101n, 103n]));
  ctx.readableController.enqueue(encodeRequestUpdateChunk([105n, 107n]));
  ctx.readableController.close();
  await readPromise;

  // どのチャンクも上限以内のため、4 通すべてに REQUEST_OK が応答される
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 4);
  for (const message of messages) {
    assert.equal(message.type, MessageType.REQUEST_OK);
  }
  assert.isUndefined(ctx.closedWithError);
  // 各チャンクの処理後に未応答数が戻るため、エントリは残らない
  assert.equal(ctx.session.receivedRequestUpdateCounts.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.1.7 (MAX_REQUEST_UPDATES):
 * 「A value of 0 means the endpoint does not limit REQUEST_UPDATE concurrency.」
 * 未広告 (既定値 0) では上限 + 1 通のチャンクを届けても閉じず、すべての
 * REQUEST_UPDATE に応答することを検証する。§9.1.6 の MAX_FILTER_RANGES の 0 が
 * 「受信拒否」なのとは意味が逆であるため、0 を拒否として扱わない。
 */
test("bidiReadRequestStreamMessages: 未広告 (0 = 無制限) では上限 + 1 通のチャンクでも閉じずすべて応答する (publish ロール)", async () => {
  // 既定は未広告 (0 = 無制限) のため、明示せずに既定値の挙動を検証する
  const ctx = createPublishReadTestContext({});

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  ctx.readableController.enqueue(encodeRequestUpdateChunk([101n, 103n, 105n, 107n]));
  ctx.readableController.close();
  await readPromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 4);
  for (const message of messages) {
    assert.equal(message.type, MessageType.REQUEST_OK);
  }
  assert.isUndefined(ctx.closedWithError);
  assert.equal(ctx.session.receivedRequestUpdateCounts.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.1.7 / §9.2 / §6.4.2.2:
 * 応答を送らずに無視する分岐 (subscribe ロールで GOAWAY 受信済み) でも
 * 未応答数が残留しないことを検証する。減算は応答の有無に依存せず、1 回の read の
 * メッセージ列の処理を終えた時点の finally が担う。
 */
test("bidiReadRequestStreamMessages: GOAWAY 受信後に無視する REQUEST_UPDATE でも未応答数が残留しない (subscribe ロール)", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);
  // GOAWAY を受信済みの subscribe ロールを作る (送信方向が FIN 済みで応答できない)
  ctx.session.goawayReceivedOnRequestStreams.add(ctx.requestId);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  ctx.readableController.enqueue(encodeRequestUpdateChunk([101n, 103n]));
  ctx.readableController.close();
  await readPromise;

  // 応答を送らず (§6.4.2.2 により FIN 後にピアは REQUEST_UPDATE を送るべきではない)、
  // セッションも閉じない
  assert.equal(ctx.written.length, 0);
  assert.isUndefined(ctx.closedWithError);
  // 応答を送らない分岐でもチャンク単位の減算が働き、エントリは残らない
  assert.equal(ctx.session.receivedRequestUpdateCounts.size, 0);
});
