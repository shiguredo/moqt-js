/**
 * session/bidi.ts の単体テスト: PUBLISH_OK 検証と bidiHandlePublishRequestUpdate / publishSendPublishDone
 *
 * PUBLISH_OK のパラメータ検証、bidiHandlePublishRequestUpdate の受理判定、
 * publishSendPublishDone の失敗時の昇格判定を検証する。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import {
  encodeRequestOkPayload,
  decodeRequestOkPayload,
  decodeRequestErrorPayload,
} from "../message/session";
import { MessageType, MessageParameterType } from "../message/types";
import {
  encodeFillParameters,
  encodeAuthorizationToken,
  AuthorizationTokenAliasType,
} from "../message";
import { buildFillParameters } from "./params";
import { encodeRequestUpdatePayload } from "../message/subscribe";
import { encodeLocationFilterParameter } from "../message/parameter";
import { SessionError, SessionErrorCode, RequestErrorCode } from "../error";
import {
  createPublishReadTestContext,
  forceSessionClosed,
  buildOverflowingLocationFilterParameter,
  createPublishOkValidationContext,
} from "../testSupport/bidi";
import { concatUint8Arrays } from "../testSupport/helpers";
import { MAX_VARINT } from "../varint";
import { ControlStreamReader, ControlStreamWriter } from "../controlStream";
import { PublisherImpl } from "../publisher";
import {
  bidiHandlePublishRequestUpdate,
  bidiReadPublishResponse,
  bidiReadRequestStreamMessages,
  type BidiSessionInternal,
} from "./bidi";

/**
 * draft-ietf-moq-transport-21 §9.20.17 / §9.20.1:
 * Range Filters は PUBLISH_OK に出現できない。許可外パラメータを含む
 * PUBLISH_OK を受信した場合、PROTOCOL_VIOLATION でセッションが閉じることを検証する。
 */
test("bidiReadPublishResponse: 不正な Range Filter を含む PUBLISH_OK で PROTOCOL_VIOLATION", async () => {
  const requestId = 10n;
  const events: string[] = [];
  const written: Uint8Array[] = [];
  let closedWithError: SessionError | undefined;

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      // PRIORITY_FILTER (0x27) で 255 超の値 (Start=11266) を含む PUBLISH_OK を feed する
      const okPayload = encodeRequestOkPayload({
        type: MessageType.REQUEST_OK,
        parameters: [
          {
            type: 0x27,
            value: new Uint8Array([0x04, 0x01, 0xac, 0x02, 0x00]),
          },
        ],
        trackProperties: [],
      });
      const writer = new ControlStreamWriter();
      const message = writer.encode(MessageType.REQUEST_OK, okPayload);
      controller.enqueue(message);
      controller.close();
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      events.push("write");
      written.push(chunk);
    },
  });
  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;
  const controlReader = new ControlStreamReader();

  const pending = {
    impl: new PublisherImpl(["test"], "track", requestId, 1n),
    resolve: () => {},
    reject: (e: Error) => {
      rejected = e;
    },
  };
  let rejected: Error | undefined;

  const session = {
    sessionState: "connected",
    transport: {},
    controlWriter: new ControlStreamWriter(),
    nextRequestId: 100n,
    pendingPublish: new Map([[requestId, pending]]),
    requestStreams: new Map([[requestId, { stream, writer: writable.getWriter(), controlReader }]]),
    publishers: new Map(),
    subscribers: new Map(),
    subscribersByAlias: new Map(),
    fetchers: new Map(),
    pendingSubgroupBuffer: {},
    fetcherReadyCallbacks: new Map(),
    pendingRequestUpdate: new Map(),
    fillFetchTargets: new Map(),
    goawayReceivedOnRequestStreams: new Set(),
    peerMaxRequestUpdates: 0,
    peerMaxFilterRanges: 0,
    tracksSubscriptions: new Map(),
    publisherStreams: new Map(),
    publisherSendQueues: new Map(),
    closedSubgroups: new Set(),
    statsControlMessagesSent: 0,
    emitDebug: () => {},
    closeWithError: (error: SessionError) => {
      closedWithError = error;
    },
    validateIncomingRequestId: (_requestId: bigint): SessionError | null => null,
  } as unknown as BidiSessionInternal;

  await bidiReadPublishResponse(session, requestId, stream, controlReader);

  assert.isDefined(closedWithError);
  assert.equal(closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isFalse(session.pendingPublish.has(requestId));
  assert.isDefined(rejected);
});

/**
 * draft-ietf-moq-transport-21 §9.3:
 * 受信 PUBLISH_OK のペイロードが不完全 (メッセージ構造の破損) な場合、
 * PROTOCOL_VIOLATION でセッションが閉じることを検証する。IncompleteDataError
 * は toSessionCloseError で変換され、閉鎖前に当該リクエストの
 * pending にも具体エラーで reject される (Range Filter 違反の既存経路と
 * 同パターン)。
 */
test("bidiReadPublishResponse: 破損 PUBLISH_OK で PROTOCOL_VIOLATION でセッションが閉じる", async () => {
  const requestId = 10n;
  let closedWithError: SessionError | undefined;
  let rejected: Error | undefined;

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      // 不完全なペイロード (Number of Parameters=1 を宣言するが本体が無い) を feed する
      const writer = new ControlStreamWriter();
      const message = writer.encode(MessageType.REQUEST_OK, new Uint8Array([0x01]));
      controller.enqueue(message);
      controller.close();
    },
  });
  const writable = new WritableStream<Uint8Array>();
  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;
  const controlReader = new ControlStreamReader();

  const pending = {
    impl: new PublisherImpl(["test"], "track", requestId, 1n),
    resolve: () => {},
    reject: (e: Error) => {
      rejected = e;
    },
  };

  const session = {
    sessionState: "connected",
    transport: {},
    controlWriter: new ControlStreamWriter(),
    nextRequestId: 100n,
    pendingPublish: new Map([[requestId, pending]]),
    requestStreams: new Map([[requestId, { stream, writer: writable.getWriter(), controlReader }]]),
    publishers: new Map(),
    subscribers: new Map(),
    subscribersByAlias: new Map(),
    fetchers: new Map(),
    pendingSubgroupBuffer: {},
    fetcherReadyCallbacks: new Map(),
    pendingRequestUpdate: new Map(),
    fillFetchTargets: new Map(),
    goawayReceivedOnRequestStreams: new Set(),
    peerMaxRequestUpdates: 0,
    peerMaxFilterRanges: 0,
    tracksSubscriptions: new Map(),
    publisherStreams: new Map(),
    publisherSendQueues: new Map(),
    closedSubgroups: new Set(),
    statsControlMessagesSent: 0,
    emitDebug: () => {},
    closeWithError: (error: SessionError) => {
      closedWithError = error;
    },
    validateIncomingRequestId: (_requestId: bigint): SessionError | null => null,
  } as unknown as BidiSessionInternal;

  await bidiReadPublishResponse(session, requestId, stream, controlReader);

  assert.isDefined(closedWithError);
  assert.equal(closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isFalse(session.pendingPublish.has(requestId));
  assert.isDefined(rejected);
  assert.equal(rejected!.message, closedWithError!.message);
});

/**
 * draft-ietf-moq-transport-21 §9.20.17 / §9.20.1:
 * LOCATION_FILTER は PUBLISH_OK に出現できない。値の正否に関わらず
 * スコープ違反として PROTOCOL_VIOLATION でセッションを閉じることを検証する。
 * pendingPublish と requestStreams の該当エントリは残らない。
 */
test("bidiReadPublishResponse: End Group 超過の LOCATION_FILTER を含む PUBLISH_OK でセッションが閉じる", async () => {
  // 3 フィールド表現と 4 フィールド (EndObject 付き) 表現の両方で検証する
  const overflowing = [
    buildOverflowingLocationFilterParameter(),
    buildOverflowingLocationFilterParameter(true),
  ];
  for (const parameter of overflowing) {
    const ctx = createPublishOkValidationContext([parameter]);
    const stream = ctx.session.requestStreams.get(ctx.requestId) as unknown as {
      stream: WebTransportBidirectionalStream;
      controlReader: ControlStreamReader;
    };

    await bidiReadPublishResponse(ctx.session, ctx.requestId, stream.stream, stream.controlReader);

    // PROTOCOL_VIOLATION でセッションが閉じ、該当エントリが残らない
    assert.isDefined(ctx.closedWithError());
    assert.equal(ctx.closedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
    assert.isFalse(ctx.session.pendingPublish.has(ctx.requestId));
    assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
    assert.isDefined(ctx.rejected());
    assert.isUndefined(ctx.resolved());
    // reject と close は同一オブジェクトで、reject してから閉じる順序である
    assert.strictEqual(ctx.rejected(), ctx.closedWithError());
    assert.deepEqual(ctx.order, ["reject", "close"]);
    // スコープ違反の具体エラーであることがメッセージから分かる
    assert.isTrue(
      ctx.closedWithError()!.message.includes("parameter type 0x21 not allowed in PUBLISH_OK"),
    );
  }
});

/**
 * draft-ietf-moq-transport-21 §9.20.17 / §9.20.1:
 * 正常な値の LOCATION_FILTER であっても PUBLISH_OK ではスコープ違反になる。
 * Subscription Parameters の更新は REQUEST_UPDATE 経路で扱う。
 */
test("bidiReadPublishResponse: 正常な LOCATION_FILTER を含む PUBLISH_OK でセッションが閉じる", async () => {
  const validFilters = [
    encodeLocationFilterParameter({ reset: true }),
    encodeLocationFilterParameter({ startGroup: 3n }),
    encodeLocationFilterParameter({ startGroup: 10n, startObject: 2n }),
    encodeLocationFilterParameter({ startGroup: 10n, startObject: 2n, endGroupDelta: 5n }),
    encodeLocationFilterParameter({
      startGroup: MAX_VARINT - 5n,
      startObject: 7n,
      endGroupDelta: 5n,
    }),
  ];
  for (const filter of validFilters) {
    const ctx = createPublishOkValidationContext([filter]);
    const stream = ctx.session.requestStreams.get(ctx.requestId) as unknown as {
      stream: WebTransportBidirectionalStream;
      controlReader: ControlStreamReader;
    };

    await bidiReadPublishResponse(ctx.session, ctx.requestId, stream.stream, stream.controlReader);

    // スコープ違反としてセッションが閉じ、解決されない
    assert.isDefined(ctx.closedWithError());
    assert.equal(ctx.closedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
    assert.isFalse(ctx.session.pendingPublish.has(ctx.requestId));
    assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
    assert.isDefined(ctx.rejected());
    assert.isUndefined(ctx.resolved());
    // reject と close は同一オブジェクトで、reject してから閉じる順序である
    assert.strictEqual(ctx.rejected(), ctx.closedWithError());
    assert.deepEqual(ctx.order, ["reject", "close"]);
    assert.isTrue(
      ctx.closedWithError()!.message.includes("parameter type 0x21 not allowed in PUBLISH_OK"),
    );
  }
});

/**
 * draft-ietf-moq-transport-21 §9.5:
 * 受信 PUBLISH ストリーム上で無限定 3 種 (AUTHORIZATION_TOKEN /
 * OBJECT_DELIVERY_TIMEOUT / SUBGROUP_DELIVERY_TIMEOUT) のみを含む
 * REQUEST_UPDATE を受信した場合、REQUEST_OK が 1 通応答され、セッションが
 * 閉じないことを検証する (§9.5 MUST)。ペイロードの Request ID (100n) は
 * 応答には含まれず、引数の requestId (10n) で判定されることも暗黙に検証
 * される。
 */
test("bidiHandlePublishRequestUpdate: 受理パラメータのみの REQUEST_UPDATE で REQUEST_OK が応答されセッションが閉じない", async () => {
  const ctx = createPublishReadTestContext({});
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      {
        type: MessageParameterType.AUTHORIZATION_TOKEN,
        // Alias を使わない USE_VALUE 形式にする。REGISTER 形式にすると
        // テスト用セッションの MAX_AUTH_TOKEN_CACHE_SIZE (未広告 = 0) を
        // 超えて AUTH_TOKEN_CACHE_OVERFLOW でセッションが閉じてしまう。
        value: encodeAuthorizationToken({
          aliasType: AuthorizationTokenAliasType.USE_VALUE,
          tokenType: 1n,
          tokenValue: new Uint8Array([1]),
        }),
      },
      { type: MessageParameterType.OBJECT_DELIVERY_TIMEOUT, value: new Uint8Array([2]) },
      { type: MessageParameterType.SUBGROUP_DELIVERY_TIMEOUT, value: new Uint8Array([3]) },
    ],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  // REQUEST_OK が 1 通書き込まれ、セッションは閉じない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  const decoded = decodeRequestOkPayload(messages[0].payload);
  assert.equal(decoded.parameters.length, 0);
  assert.equal(decoded.trackProperties.length, 0);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §3.4.1:
 * 受信 PUBLISH 経路で FILL_PARAMETERS を処理するのは moqt-js (subscriber) で
 * あり、fill fetch ストリームを開く主体 (publisher) ではない。FILL_PARAMETERS は
 * 検証後に受理して REQUEST_OK を返し、fillFetchTargets へは登録しない。
 */
test("bidiHandlePublishRequestUpdate: FILL_PARAMETERS は受理して REQUEST_OK を返し fillFetchTargets に登録しない", async () => {
  const ctx = createPublishReadTestContext({});
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      encodeFillParameters(
        buildFillParameters({ filter: { startGroup: 10n, startObject: 2n } }, "REQUEST_UPDATE"),
      ),
    ],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  // REQUEST_OK が 1 通応答され、fillFetchTargets には登録されない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isFalse(ctx.session.fillFetchTargets.has(ctx.requestId));
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.5:
 * パラメータを含まない REQUEST_UPDATE でも REQUEST_OK が 1 通応答され、
 * セッションが閉じないことを検証する (§9.5 MUST)。パラメータ無しは
 * 文脈限定パラメータの判定を通過する空集合として扱われる。
 */
test("bidiHandlePublishRequestUpdate: パラメータ無しの REQUEST_UPDATE で REQUEST_OK が応答されセッションが閉じない", async () => {
  const ctx = createPublishReadTestContext({});
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  // REQUEST_OK が 1 通書き込まれ、セッションは閉じない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.1.7 (MAX_REQUEST_UPDATES):
 * 自 endpoint が広告した上限 (2) と同数の未応答 REQUEST_UPDATE が残っている状態で
 * さらに 1 通受信した場合、加算後の件数 (3) が上限を超えるため
 * TOO_MANY_REQUEST_UPDATES でセッションを閉じる MUST を検証する。
 * 未応答数は実 Map で組み立て、上限は BidiSessionInternal では readonly のため
 * 既存の localMaxFilterRanges と同じくテスト側でキャストして代入する。
 */
test("bidiHandlePublishRequestUpdate: 未応答数が上限に達した状態の受信で TOO_MANY_REQUEST_UPDATES により閉じる", async () => {
  const ctx = createPublishReadTestContext({});
  (ctx.session as unknown as { localMaxRequestUpdates: number }).localMaxRequestUpdates = 2;
  // 上限と同数の 2 通が未応答のまま残っている状態を作る
  ctx.session.receivedRequestUpdateCounts.set(ctx.requestId, 2);

  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  // 3 通目は受理せず、REQUEST_OK も応答しない
  assert.equal(ctx.written.length, 0);
  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.TOO_MANY_REQUEST_UPDATES);
  assert.isTrue(ctx.closedWithError!.message.includes("local MAX_REQUEST_UPDATES=2"));
  // 受信した時点で数えるため、加算後の 3 が残る
  // (減算は受信ループが 1 回の read 単位で行う)
  assert.equal(ctx.session.receivedRequestUpdateCounts.get(ctx.requestId), 3);
});

/**
 * draft-ietf-moq-transport-21 §9.1.7 (MAX_REQUEST_UPDATES):
 * 加算後の件数が上限と等しいだけでは閉じない (N 件目までは受理する) ことを
 * 検証する。上限 2 に対して未応答数 1 の状態で受信すると加算後は 2 になり、
 * REQUEST_OK が応答されてセッションは閉じない。
 */
test("bidiHandlePublishRequestUpdate: 加算後が上限と等しい受信は REQUEST_OK を応答し閉じない", async () => {
  const ctx = createPublishReadTestContext({});
  (ctx.session as unknown as { localMaxRequestUpdates: number }).localMaxRequestUpdates = 2;
  ctx.session.receivedRequestUpdateCounts.set(ctx.requestId, 1);

  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
  // 上限と等しい 2 まで加算される
  assert.equal(ctx.session.receivedRequestUpdateCounts.get(ctx.requestId), 2);
});

/**
 * draft-ietf-moq-transport-21 §9.1.7 (MAX_REQUEST_UPDATES):
 * 「A value of 0 means the endpoint does not limit REQUEST_UPDATE concurrency.」
 * 未広告 (既定値 0) では未応答数がいくつ残っていても上限判定を行わないことを
 * 検証する。§9.1.6 の MAX_FILTER_RANGES の 0 が「受信拒否」なのとは意味が逆で
 * あるため、0 を拒否として扱わない。
 */
test("bidiHandlePublishRequestUpdate: 未広告 (0 = 無制限) では未応答数が残っていても閉じない", async () => {
  const ctx = createPublishReadTestContext({});
  // 既定は未広告 (0 = 無制限) のため、明示せずに既定値の挙動を検証する
  ctx.session.receivedRequestUpdateCounts.set(ctx.requestId, 5);

  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
  assert.equal(ctx.session.receivedRequestUpdateCounts.get(ctx.requestId), 6);
});

/**
 * draft-ietf-moq-transport-21 §9.20.1 (Parameter Scope):
 * REQUEST_UPDATE に出現できないパラメータ (スコープ違反) を含む
 * REQUEST_UPDATE を受信した場合、§9.20.1 の MUST に従い REQUEST_ERROR で
 * 応答せず PROTOCOL_VIOLATION でセッションが閉じることを検証する。
 */
test("bidiHandlePublishRequestUpdate: スコープ違反のパラメータで PROTOCOL_VIOLATION でセッションが閉じる", async () => {
  const ctx = createPublishReadTestContext({});
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    // EXPIRES は REQUEST_UPDATE に出現できない (REQUEST_UPDATE_ALLOWED_PARAMS 外)
    parameters: [{ type: MessageParameterType.EXPIRES, value: new Uint8Array([1]) }],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  // REQUEST_ERROR は応答されず、PROTOCOL_VIOLATION でセッションが閉じる
  assert.equal(ctx.written.length, 0);
  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(ctx.closedWithError!.message.includes("not allowed in REQUEST_UPDATE"));
});

/**
 * draft-ietf-moq-transport-21 §9.20.1 / §9.20.8:
 * SUBSCRIBER_PRIORITY は REQUEST_UPDATE (for a subscription) に出現できるため、
 * 受信 PUBLISH ストリーム上の REQUEST_UPDATE で受理され REQUEST_OK が応答される
 * ことを検証する (accept-then-ignore。NOT_SUPPORTED で拒否しない)。
 */
test("bidiHandlePublishRequestUpdate: SUBSCRIBER_PRIORITY を含む REQUEST_UPDATE で REQUEST_OK が応答される", async () => {
  const ctx = createPublishReadTestContext({});
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [{ type: MessageParameterType.SUBSCRIBER_PRIORITY, value: new Uint8Array([1]) }],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  // REQUEST_OK が 1 通書き込まれ、セッションは閉じない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.5 / §9.20.19:
 * ケース 1 の REQUEST_UPDATE で FORWARD=1 が含まれる場合も REQUEST_OK で
 * 受理され、Forward State に true が反映されることを検証する。
 */
test("bidiHandlePublishRequestUpdate: FORWARD=1 を含む REQUEST_UPDATE で Forward State が true に反映される", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  subscriber.setForwardState(false);
  ctx.session.subscribers.set(ctx.requestId, subscriber);

  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [{ type: MessageParameterType.FORWARD, value: new Uint8Array([1]) }],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
  assert.equal(subscriber.forwardState, true);
});

/**
 * draft-ietf-moq-transport-21 §9.20.1 / §9.20.3 / §9.20.8:
 * REQUEST_UPDATE に出現可能な複数パラメータ (AUTHORIZATION_TOKEN +
 * SUBSCRIBER_PRIORITY) の混合はメッセージ単位で受理され、REQUEST_OK が
 * 応答されることを検証する。
 */
test("bidiHandlePublishRequestUpdate: 許可パラメータの混合 REQUEST_UPDATE で REQUEST_OK が応答される", async () => {
  const ctx = createPublishReadTestContext({});
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      {
        type: MessageParameterType.AUTHORIZATION_TOKEN,
        // Alias を使わない USE_VALUE 形式にする。REGISTER 形式にすると
        // テスト用セッションの MAX_AUTH_TOKEN_CACHE_SIZE (未広告 = 0) を
        // 超えて AUTH_TOKEN_CACHE_OVERFLOW でセッションが閉じてしまう。
        value: encodeAuthorizationToken({
          aliasType: AuthorizationTokenAliasType.USE_VALUE,
          tokenType: 1n,
          tokenValue: new Uint8Array([1]),
        }),
      },
      { type: MessageParameterType.SUBSCRIBER_PRIORITY, value: new Uint8Array([1]) },
    ],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  // REQUEST_OK が 1 通書き込まれ、セッションは閉じない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.20.3 / §8.9:
 * 受信 REQUEST_UPDATE の AUTHORIZATION TOKEN の REGISTER がトークンキャッシュへ
 * 登録され、REQUEST_OK が応答されることを検証する。
 */
test("bidiHandlePublishRequestUpdate: AUTHORIZATION TOKEN の REGISTER がキャッシュへ登録される", async () => {
  const ctx = createPublishReadTestContext({}, 1024);
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      {
        type: MessageParameterType.AUTHORIZATION_TOKEN,
        value: encodeAuthorizationToken({
          aliasType: AuthorizationTokenAliasType.REGISTER,
          tokenAlias: 8n,
          tokenType: 3n,
          tokenValue: new Uint8Array([0x77]),
        }),
      },
    ],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  // §9.1.3: エントリサイズは 16 バイト + Token Value 長
  assert.deepEqual(ctx.session.receivedAuthTokens.resolve(8n), {
    status: "resolved",
    tokenType: 3n,
    tokenValue: new Uint8Array([0x77]),
  });
  assert.equal(ctx.session.receivedAuthTokens.size, 17);
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §8.9 / §6.6 / §12.2:
 * 未登録 Alias を参照する USE_ALIAS を含む REQUEST_UPDATE は Session Termination の
 * UNKNOWN_AUTH_TOKEN_ALIAS (0x17) でセッションを閉じることを検証する。0x17 は
 * §16.11.2 (REQUEST_ERROR Codes) に収載されていないため REQUEST_ERROR では送らない。
 * 本経路は元から PUBLISH_DONE を送らないため、REQUEST_ERROR も PUBLISH_DONE も
 * 書かれない。
 */
test("bidiHandlePublishRequestUpdate: 未登録 Alias の USE_ALIAS は UNKNOWN_AUTH_TOKEN_ALIAS でセッションを閉じる", async () => {
  const ctx = createPublishReadTestContext({}, 1024);
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      {
        type: MessageParameterType.AUTHORIZATION_TOKEN,
        value: encodeAuthorizationToken({
          aliasType: AuthorizationTokenAliasType.USE_ALIAS,
          tokenAlias: 55n,
        }),
      },
    ],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  // セッションを閉じるため REQUEST_ERROR も PUBLISH_DONE も送らない
  assert.equal(messages.length, 0);
  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError.code, SessionErrorCode.UNKNOWN_AUTH_TOKEN_ALIAS);
});

/**
 * draft-ietf-moq-transport-21 §8.9 / §9.1.3:
 * Message Parameter の REGISTER が MAX_AUTH_TOKEN_CACHE_SIZE を超える場合は
 * AUTH_TOKEN_CACHE_OVERFLOW でセッションを閉じる MUST を検証する。
 * SETUP 経路 (§9.1.4) と異なり USE_VALUE へ降格しない。
 */
test("bidiHandlePublishRequestUpdate: 上限超過 REGISTER は AUTH_TOKEN_CACHE_OVERFLOW で閉じる", async () => {
  // 上限 0 (未広告) では Alias を 1 つも登録できない
  const ctx = createPublishReadTestContext({}, 0);
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      {
        type: MessageParameterType.AUTHORIZATION_TOKEN,
        value: encodeAuthorizationToken({
          aliasType: AuthorizationTokenAliasType.REGISTER,
          tokenAlias: 1n,
          tokenType: 1n,
          tokenValue: new Uint8Array([0x88]),
        }),
      },
    ],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError?.code, SessionErrorCode.AUTH_TOKEN_CACHE_OVERFLOW);
});

/**
 * draft-ietf-moq-transport-21 §9.5 / §9.20.19:
 * ケース 1 (受信 PUBLISH の publisher による REQUEST_UPDATE) で FORWARD
 * パラメータが含まれる場合、REQUEST_OK で受理され、受信 PUBLISH から生成
 * された SubscriberImpl の Forward State に反映されることを検証する。
 */
test("bidiHandlePublishRequestUpdate: FORWARD を含む REQUEST_UPDATE で REQUEST_OK が応答され Forward State に反映される", async () => {
  const ctx = createPublishReadTestContext({});
  // 受信 PUBLISH から生成された SubscriberImpl を登録する (初期 Forward State 1)
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  ctx.session.subscribers.set(ctx.requestId, subscriber);

  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    // FORWARD=0: オブジェクトを送信しない宣言
    parameters: [{ type: MessageParameterType.FORWARD, value: new Uint8Array([0]) }],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  // REQUEST_OK が 1 通書き込まれ、セッションは閉じない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
  // FORWARD=0 が SubscriberImpl の Forward State に反映される
  assert.equal(subscriber.forwardState, false);
});

/**
 * draft-ietf-moq-transport-21 §9.20.19:
 * "If the parameter is omitted from REQUEST_UPDATE, the value for the
 *  subscription remains unchanged."
 * FORWARD を含まないケース 1 の REQUEST_UPDATE は REQUEST_OK で受理されるが、
 * Forward State は変化しないことを検証する。
 */
test("bidiHandlePublishRequestUpdate: FORWARD 省略の REQUEST_UPDATE で Forward State は不変", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  subscriber.setForwardState(false);
  ctx.session.subscribers.set(ctx.requestId, subscriber);

  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
  // FORWARD 省略時は不変 (§9.20.19)
  assert.equal(subscriber.forwardState, false);
});

/**
 * draft-ietf-moq-transport-21 §9.20.1 / §9.20.19:
 * FORWARD と他の許可パラメータ (例: SUBSCRIBER_PRIORITY) の混合
 * REQUEST_UPDATE もメッセージ単位で受理され、FORWARD が Forward State に
 * 反映されることを検証する。
 */
test("bidiHandlePublishRequestUpdate: FORWARD + 他の許可パラメータの混合で REQUEST_OK が応答され FORWARD が反映される", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  ctx.session.subscribers.set(ctx.requestId, subscriber);

  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      { type: MessageParameterType.FORWARD, value: new Uint8Array([0]) },
      { type: MessageParameterType.SUBSCRIBER_PRIORITY, value: new Uint8Array([1]) },
    ],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  // REQUEST_OK が 1 通書き込まれ、セッションは閉じない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
  // FORWARD=0 が反映される
  assert.equal(subscriber.forwardState, false);
});

/**
 * draft-ietf-moq-transport-21 §9.2 / §12.5 / §9.5:
 * GOAWAY 受信後 (writer オープン時) の REQUEST_UPDATE には REQUEST_ERROR
 * (GOING_AWAY) が応答され、セッションが閉じないことを検証する。
 */
test("bidiHandlePublishRequestUpdate: GOAWAY 受信後の REQUEST_UPDATE に REQUEST_ERROR (GOING_AWAY) が応答される", async () => {
  const ctx = createPublishReadTestContext({});
  // GOAWAY を受信済みの状態を作る (writer はオープンのまま)
  ctx.session.goawayReceivedOnRequestStreams.add(ctx.requestId);
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  // REQUEST_ERROR (GOING_AWAY) が書き込まれ、セッションは閉じない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  const decoded = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.GOING_AWAY));
  assert.equal(decoded.reasonPhrase, "request stream is being migrated");
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.2 / §9.20.1 / §9.5:
 * GOAWAY 受信後 + パラメータスコープ違反が同時に発生した REQUEST_UPDATE は、
 * GOING_AWAY 応答が優先され (PROTOCOL_VIOLATION で閉じずに)、セッションが
 * 閉じないことを検証する。
 */
test("bidiHandlePublishRequestUpdate: GOAWAY 受信後 + スコープ違反の同時発生時は GOING_AWAY が優先される", async () => {
  const ctx = createPublishReadTestContext({});
  // GOAWAY を受信済みの状態を作る (writer はオープンのまま)
  ctx.session.goawayReceivedOnRequestStreams.add(ctx.requestId);
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    // EXPIRES はスコープ違反パラメータだが、判定順序 (1) の GOING_AWAY が優先される
    parameters: [{ type: MessageParameterType.EXPIRES, value: new Uint8Array([1]) }],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  // REQUEST_ERROR (GOING_AWAY) が書き込まれ、セッションは閉じない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  const decoded = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.GOING_AWAY));
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.5:
 * 応答の書き込みに失敗した場合 (writer が閉じている等) は黙殺され、
 * PROTOCOL_VIOLATION への昇格も callbacks.error の発火も行われず、
 * セッションが閉じないことを検証する。
 */
test("bidiHandlePublishRequestUpdate: 応答の書き込み失敗は黙殺されセッションが閉じない", async () => {
  const ctx = createPublishReadTestContext({
    write() {
      throw new Error("write failed");
    },
  });
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  // 書き込みは実際に試行され、失敗は吸収され、セッションは閉じない
  assert.deepEqual(ctx.events, ["write"]);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.5:
 * 判定順序 (1) の GOING_AWAY 応答の書き込みに失敗した場合も黙殺され、
 * セッションが閉じないことを検証する (production では GOAWAY 処理の
 * writer.close() により常にこの経路になる。テスト 8 は判定順序 (4) の
 * REQUEST_OK 経路で同じ黙殺パスを検証する)。
 */
test("bidiHandlePublishRequestUpdate: GOAWAY 後の GOING_AWAY 応答の書き込み失敗は黙殺されセッションが閉じない", async () => {
  const ctx = createPublishReadTestContext({
    write() {
      throw new Error("write failed");
    },
  });
  // GOAWAY を受信済みの状態を作る
  ctx.session.goawayReceivedOnRequestStreams.add(ctx.requestId);
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  // 書き込みは実際に試行され、失敗は吸収され、セッションは閉じない
  assert.deepEqual(ctx.events, ["write"]);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.5:
 * REQUEST_UPDATE のペイロードのデコードに失敗した場合 (メッセージ構造の
 * 破損)、本関数内で PROTOCOL_VIOLATION としてセッションが閉じることを
 * 検証する。ここで閉じることで、「invalid REQUEST_UPDATE payload」の文脈を
 * 付与した SessionError が callbacks.error に渡り、後続のパラメータ検証を
 * 実行しない。
 */
test("bidiHandlePublishRequestUpdate: デコード失敗は PROTOCOL_VIOLATION でセッションが閉じる", async () => {
  const ctx = createPublishReadTestContext({});
  // 不完全なペイロード (Request ID の後に Parameters が無い)
  const invalidPayload = new Uint8Array([0x01]);
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, invalidPayload);

  // REQUEST_ERROR は応答されず、PROTOCOL_VIOLATION でセッションが閉じる
  assert.equal(ctx.written.length, 0);
  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(ctx.closedWithError!.message.includes("invalid REQUEST_UPDATE payload"));
});

/**
 * draft-ietf-moq-transport-21 §9.5:
 * requestStreams に存在しない requestId (エントリ削除後など) への REQUEST_UPDATE
 * は、応答の書き込み先が無いため黙殺され、セッションが閉じないことを
 * 検証する。
 */
test("bidiHandlePublishRequestUpdate: requestStreams に存在しない requestId では応答が黙殺されセッションが閉じない", async () => {
  const ctx = createPublishReadTestContext({});
  // requestStreams からエントリを削除して writer が引けない状態を作る
  ctx.session.requestStreams.delete(ctx.requestId);
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  // 書き込みは発生せず、セッションも閉じない
  assert.equal(ctx.written.length, 0);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.2 / §9.9:
 * ピアの FIN により requestStreams のエントリが保持された状態から、セッション
 * close 相当 (requestStreams.clear) で破棄された場合、その後の done() は
 * PUBLISH_DONE を送信せずセッションも閉じないことを検証する
 * (セッション close 時のクリーンアップで保持エントリが回収される)。
 */
test("bidiReadRequestStreamMessages: FIN 保持後のセッション close 相当で done() が何もしない", async () => {
  const ctx = createPublishReadTestContext({});

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  ctx.readableController.close();
  await readPromise;

  // ピア FIN 後はエントリが保持される
  assert.isTrue(ctx.session.requestStreams.has(ctx.requestId));

  // セッション close 相当: 保持中のリクエストストリームを破棄する
  ctx.session.requestStreams.clear();

  await ctx.publisher.done();

  // streamInfo が無いため PUBLISH_DONE を送信せず、セッションも閉じない
  assert.equal(ctx.written.length, 0);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.3:
 * ピアが STOP_SENDING で当方の送信方向をキャンセルした場合、write / close は
 * WebTransportError (source: "stream") で reject する (W3C WebTransport の
 * 実装挙動)。ピア起因のキャンセルは PROTOCOL_VIOLATION に昇格させないことを
 * 検証する。エラーコード非依存の検証は DELIVERY_TIMEOUT 0x2 のテストで行う。
 */
test("publishSendPublishDone: STOP_SENDING (write 失敗 source: 'stream') でセッションが閉じない", async () => {
  const ctx = createPublishReadTestContext({
    write() {
      throw Object.assign(new Error("peer cancel"), { source: "stream", streamErrorCode: 0x1 });
    },
  });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  ctx.readableController.close();
  await readPromise;

  await ctx.publisher.done();

  // write 失敗 (source: "stream") は黙殺され、Node 実装固有の source なし TypeError で
  // reject する close 失敗も write 失敗 (ピア起因) の結果として非昇格になる
  assert.isUndefined(ctx.closedWithError);
  // publishers の削除は done() で実行される
  assert.isFalse(ctx.session.publishers.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §12.5 (Stream Reset Error Codes):
 * エラーコードは SHOULD 推奨であり、ピアが STOP_SENDING にどのコード
 * (CANCELLED 0x1 / DELIVERY_TIMEOUT 0x2 / その他) を載せるかは任意のため、
 * コード集合で判定すると合法的なキャンセルを再昇格し得る。
 * 非昇格判定がエラーコード非依存 (source === "stream" のみ) であることを
 * CANCELLED (0x1) 以外のコードで検証する。
 */
test("publishSendPublishDone: STOP_SENDING (DELIVERY_TIMEOUT 0x2) でも非昇格になる", async () => {
  const ctx = createPublishReadTestContext({
    write() {
      throw Object.assign(new Error("peer cancel"), { source: "stream", streamErrorCode: 0x2 });
    },
  });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  ctx.readableController.close();
  await readPromise;

  await ctx.publisher.done();

  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.3:
 * STOP_SENDING の到着は非同期のため、write() が成功した後に close() が失敗する
 * レースが実 WebTransport で起こり得る。close 失敗エラー自体の source が
 * "stream" の場合も PROTOCOL_VIOLATION に昇格させないことを検証する。
 */
test("publishSendPublishDone: write 成功後の close 失敗 (source: 'stream') でセッションが閉じない", async () => {
  const ctx = createPublishReadTestContext({
    close() {
      throw Object.assign(new Error("peer cancel"), { source: "stream", streamErrorCode: 0x1 });
    },
  });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  ctx.readableController.close();
  await readPromise;

  await ctx.publisher.done();

  assert.isUndefined(ctx.closedWithError);
});

/**
 * 昇格ブランチの検証:
 * sink の close() が source を持たない Error で失敗した場合は、従来どおり
 * PROTOCOL_VIOLATION でセッションが閉じることを検証する。
 */
test("publishSendPublishDone: close 失敗 (source なし) で closeWithError(PROTOCOL_VIOLATION) が呼ばれる", async () => {
  const ctx = createPublishReadTestContext({
    close() {
      throw new Error("internal close failure");
    },
  });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  ctx.readableController.close();
  await readPromise;

  await ctx.publisher.done();

  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(ctx.closedWithError!.message.includes("failed to close stream after PUBLISH_DONE"));
});

/**
 * write 失敗 (source なし) は従来どおり黙殺されることを検証する。
 * write 失敗の reject は昇格に使われず、その後の close 失敗 (source なし) のみが
 * 従来どおり PROTOCOL_VIOLATION で検出される。
 */
test("publishSendPublishDone: write 失敗 (source なし) は黙殺され、close 失敗で従来どおり昇格する", async () => {
  const ctx = createPublishReadTestContext({
    write() {
      throw new Error("internal write failure");
    },
  });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  ctx.readableController.close();
  await readPromise;

  await ctx.publisher.done();

  // write 失敗 (source なし) は昇格に使われず黙殺される。
  // close 失敗 (source なし) は従来どおり PROTOCOL_VIOLATION で検出される。
  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(ctx.closedWithError!.message.includes("failed to close stream after PUBLISH_DONE"));
  // write 失敗のエラーが昇格に使われていない (メッセージが close 失敗のものである)
  assert.isFalse(ctx.closedWithError!.message.includes("internal write failure"));
});

/**
 * draft-ietf-moq-transport-21 §9.9:
 * 並行 done() 呼び出しで二重 PUBLISH_DONE 送信と close 失敗の
 * PROTOCOL_VIOLATION 昇格が起きないことを検証する。
 *
 * PublisherImpl.done() の in-flight ガードにより、2 回目の done() は 1 回目の
 * 完了を待つため、publishSendPublishDone は 1 回だけ実行される。ガードがない
 * 場合の失敗モードはタイミングにより 2 通りある (2 回目の write が既に閉じた
 * writer に対して失敗する、または 1 回目の close 完了前に write がキューされ
 * PUBLISH_DONE が 2 回送信される)。いずれもこのテストのアサーション
 * (written / events / closedWithError) で検出できる。
 */
test("publishSendPublishDone: 並行 done で PUBLISH_DONE が 1 回だけ送信されセッションが閉じない", async () => {
  const ctx = createPublishReadTestContext({});

  // 並行 done() 呼び出し: 2 回目の done() は 1 回目の完了を待つ
  await Promise.all([ctx.publisher.done(), ctx.publisher.done()]);

  // PUBLISH_DONE フレームが 1 回だけ送信される (write 1 回 + close 1 回)
  assert.equal(ctx.written.length, 1);
  assert.equal(ctx.events.filter((event) => event === "close").length, 1);
  // close 失敗の PROTOCOL_VIOLATION 昇格でセッションが閉じない
  assert.isUndefined(ctx.closedWithError);
  // requestStreams / publishers から削除される
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isFalse(ctx.session.publishers.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §6.6 (Termination):
 * session.close() と publisher.done() の並行実行で、セッションクローズに伴う
 * close 失敗 (source なし) が PROTOCOL_VIOLATION に誤昇格して
 * callbacks.error に誤報が流れるのを防ぐことを検証する。
 *
 * session.close() は sessionState を同期で "closed" にしてから writer を
 * abort するため、close 失敗の reject 処理時には sessionState が既に "closed"
 * になっている。入り口ガード (関数先頭の sessionState チェック) は「チェック
 * 時点で既に closed」の場合のみ有効であり、ガード通過後に走るこのレースは
 * close 失敗時の再確認で塞ぐ。
 */
test("publishSendPublishDone: close() と並行実行 (close 失敗時に sessionState closed) で PROTOCOL_VIOLATION に昇格しない", async () => {
  let ctx: ReturnType<typeof createPublishReadTestContext>;
  ctx = createPublishReadTestContext({
    close() {
      // session.close() との並行実行を再現する
      forceSessionClosed(ctx.session);
      throw new Error("close aborted by session close");
    },
  });

  // レース再現には read loop は無関係なため、直接 done() を呼ぶ
  await ctx.publisher.done();

  // PROTOCOL_VIOLATION に誤昇格しない (callbacks.error に誤報が流れない)
  assert.isUndefined(ctx.closedWithError);
  // クリーンアップは従来どおり実行される
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isFalse(ctx.session.publishers.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §6.6 (Termination):
 * ピア起因のセッション終了 (transport.closed) と done() の並行実行でも、
 * close 失敗が PROTOCOL_VIOLATION に誤昇格しないことを検証する。
 *
 * ピア起因の sessionState 遷移は非同期 (transport.closed のハンドラ) のため、
 * ストリームの reject 処理時には遷移が完了している状態を前提とする。
 * 本テストはその遷移完了済み状態での非昇格を検証する (reject 処理が遷移より
 * 先に走った場合の残余リスクは publish.ts のコメントで明記)。
 * ピア起因では write が失敗し、write 失敗後の close はストリームが error
 * 状態のため reject する (sink の close は呼ばれない)。エラーは source なしの
 * Error で throw する (source 判定に依存しない実装であることの検証も兼ねる)。
 */
test("publishSendPublishDone: ピア起因のセッション終了 (遷移完了済み状態) で PROTOCOL_VIOLATION に昇格しない", async () => {
  let ctx: ReturnType<typeof createPublishReadTestContext>;
  ctx = createPublishReadTestContext({
    write() {
      // ピア起因のセッション終了 (transport.closed) のハンドラが sessionState を
      // 非同期で "closed" に遷移させた状態を再現する
      forceSessionClosed(ctx.session);
      throw new Error("write reset by peer session close");
    },
  });

  // レース再現には read loop は無関係なため、直接 done() を呼ぶ
  await ctx.publisher.done();

  // write が失敗し、ストリームが error 状態になった経路を通っていること
  // (write フック不発の退化を検出する)
  assert.isTrue(ctx.events.includes("write"));
  // error 状態のストリームへの close は sink の close を呼ばず reject する
  assert.isFalse(ctx.events.includes("close"));
  // PROTOCOL_VIOLATION に誤昇格しない
  assert.isUndefined(ctx.closedWithError);
  // クリーンアップは従来どおり実行される
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isFalse(ctx.session.publishers.has(ctx.requestId));
});
