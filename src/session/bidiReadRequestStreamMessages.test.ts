/**
 * session/bidi.ts の単体テスト: bidiReadRequestStreamMessages / publishSendPublishDone の統合
 *
 * 実 W3C ストリームを注入し、REQUEST_UPDATE の応答処理や GOAWAY の
 * 重複検出、publish ロールの FIN 処理を統合的に検証する。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import {
  encodeRequestOkPayload,
  decodeRequestErrorPayload,
  encodeGoawayPayload,
} from "../message/session";
import { encodePublishDonePayload, decodePublishDonePayload } from "../message/publish";
import { MessageType, MessageParameterType, PublishDoneStatusCode } from "../message/types";
import { encodeRequestUpdatePayload } from "../message/subscribe";
import { encodeAuthorizationToken, AuthorizationTokenAliasType } from "../message";
import { SessionErrorCode, RequestErrorCode } from "../error";
import {
  createPublishReadTestContext,
  forceSessionClosed,
  createPublishOkValidationContext,
} from "../testSupport/bidi";
import { concatUint8Arrays } from "../testSupport/helpers";
import { MAX_VARINT } from "../varint";
import { ControlStreamReader, ControlStreamWriter } from "../controlStream";
import { PublisherImpl } from "../publisher";
import {
  bidiHandlePublishDone,
  bidiReadPublishResponse,
  bidiReadRequestStreamMessages,
  FIN_WITHOUT_PUBLISH_DONE_MESSAGE,
  type BidiSessionInternal,
} from "./bidi";

// ============================================================================
// bidiReadRequestStreamMessages / publishSendPublishDone の統合テスト
// (実 W3C ストリーム注入方式)
// draft-ietf-moq-transport-21 §6.4.2.2 / §6.4.2.3 / §9.8
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §6.4.2.2:
 * PUBLISH_OK 受信前 (Established 前) にピアが FIN を送った場合、リクエストは
 * 失敗として処理される。bidiReadResponseFromBidiStream の throw が
 * bidiReadPublishResponse の内部で使う共通ディスパッチャ bidiDispatchResponse の catch で
 * 処理され、pendingPublish の reject と requestStreams からの削除が行われる
 * ことを検証する。
 */
test("bidiReadPublishResponse: PUBLISH_OK 受信前のピア FIN でリクエストが失敗として処理される", async () => {
  const requestId = 20n;
  let readableController!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      readableController = controller;
    },
  });
  const writable = new WritableStream<Uint8Array>();
  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;
  const controlReader = new ControlStreamReader();

  let rejected: Error | undefined;
  const session = {
    sessionState: "connected",
    transport: {},
    controlWriter: new ControlStreamWriter(),
    nextRequestId: 100n,
    requestStreams: new Map([[requestId, { stream, writer: writable.getWriter(), controlReader }]]),
    pendingPublish: new Map([
      [
        requestId,
        {
          resolve: () => {},
          reject: (err: Error) => {
            rejected = err;
          },
          impl: {},
        },
      ],
    ]),
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
    peerMaxRequestUpdates: 0,
    peerMaxFilterRanges: 0,
    tracksSubscriptions: new Map(),
    publisherStreams: new Map(),
    publisherSendQueues: new Map(),
    closedSubgroups: new Set(),
    statsControlMessagesSent: 0,
    emitDebug: () => {},
    closeWithError: () => {},
  } as unknown as BidiSessionInternal;

  const readPromise = bidiReadPublishResponse(session, requestId, stream, controlReader);
  readableController.close();
  await readPromise;

  // pendingPublish の reject と requestStreams からの削除が行われる
  assert.isDefined(rejected);
  assert.isFalse(session.pendingPublish.has(requestId));
  assert.isFalse(session.requestStreams.has(requestId));
});

/**
 * PUBLISH_OK 応答の FORWARD 反映を検証するためのセッションを構築する
 *
 * 応答ストリームに指定パラメータの PUBLISH_OK を 1 通だけ feed し、
 * 解決された Publisher を返す。PUBLISH_OK 受信後の挙動の検証に使う。
 */
async function readPublishOkWithParameters(
  parameters: { type: number; value: Uint8Array }[],
): Promise<{ publisher: PublisherImpl; resolved: PublisherImpl }> {
  const requestId = 10n;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      const okPayload = encodeRequestOkPayload({
        type: MessageType.REQUEST_OK,
        parameters,
        trackProperties: [],
      });
      const writer = new ControlStreamWriter();
      controller.enqueue(writer.encode(MessageType.REQUEST_OK, okPayload));
      controller.close();
    },
  });
  const writable = new WritableStream<Uint8Array>({});
  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;
  const controlReader = new ControlStreamReader();

  const publisher = new PublisherImpl(["test"], "track", requestId, 1n);
  let resolved: PublisherImpl | undefined;
  const session = {
    sessionState: "connected",
    transport: {},
    controlWriter: new ControlStreamWriter(),
    nextRequestId: 100n,
    pendingPublish: new Map([
      [
        requestId,
        {
          impl: publisher,
          resolve: (resolvedPublisher: PublisherImpl) => {
            resolved = resolvedPublisher;
          },
          reject: () => {},
        },
      ],
    ]),
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
    closeWithError: () => {},
  } as unknown as BidiSessionInternal;

  await bidiReadPublishResponse(session, requestId, stream, controlReader);

  assert.isDefined(resolved);
  return { publisher, resolved: resolved as PublisherImpl };
}

/**
 * draft-ietf-moq-transport-21 §9.20.17:
 * PUBLISH_OK に出現できるのは EXPIRES のみであり、空の PUBLISH_OK は
 * 何も反映せず初期値のまま解決されることを検証する。
 */
test("bidiReadPublishResponse: FORWARD 省略の PUBLISH_OK で Forward State が true になる", async () => {
  const { publisher, resolved } = await readPublishOkWithParameters([]);

  // 解決された Publisher は保留中のものと同一であり、状態は true になる
  assert.equal(resolved, publisher);
  assert.isTrue(publisher.forwardState);
});

/**
 * draft-ietf-moq-transport-21 §9.20.17:
 * EXPIRES のみが PUBLISH_OK に出現できる。EXPIRES を含む PUBLISH_OK を
 * 受信した場合、正常に解決されることを検証する。
 */
test("bidiReadPublishResponse: EXPIRES の PUBLISH_OK は解決される", async () => {
  const { publisher, resolved } = await readPublishOkWithParameters([
    { type: MessageParameterType.EXPIRES, value: new Uint8Array([0x0a]) },
  ]);

  assert.equal(resolved, publisher);
  assert.isTrue(publisher.forwardState);
});

/**
 * draft-ietf-moq-transport-21 §9.20.17 / §9.20.1:
 * FORWARD は PUBLISH_OK に出現できない。FORWARD=1 を含む PUBLISH_OK を
 * 受信した場合、PROTOCOL_VIOLATION でセッションを閉じ、保留中の発行を
 * 残さないことを検証する。
 */
test("bidiReadPublishResponse: FORWARD=1 の PUBLISH_OK で PROTOCOL_VIOLATION", async () => {
  const ctx = createPublishOkValidationContext([
    { type: MessageParameterType.FORWARD, value: new Uint8Array([1]) },
  ]);
  const stream = ctx.session.requestStreams.get(ctx.requestId) as unknown as {
    stream: WebTransportBidirectionalStream;
    controlReader: ControlStreamReader;
  };

  await bidiReadPublishResponse(ctx.session, ctx.requestId, stream.stream, stream.controlReader);

  assert.isDefined(ctx.closedWithError());
  assert.equal(ctx.closedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isFalse(ctx.session.pendingPublish.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isDefined(ctx.rejected());
  assert.isUndefined(ctx.resolved());
});

/**
 * draft-ietf-moq-transport-21 §9.20.17 / §9.20.1:
 * FORWARD=0 を含む PUBLISH_OK を受信した場合も、スコープ違反として
 * PROTOCOL_VIOLATION でセッションを閉じることを検証する。
 */
test("bidiReadPublishResponse: FORWARD=0 の PUBLISH_OK で PROTOCOL_VIOLATION", async () => {
  const ctx = createPublishOkValidationContext([
    { type: MessageParameterType.FORWARD, value: new Uint8Array([0]) },
  ]);
  const stream = ctx.session.requestStreams.get(ctx.requestId) as unknown as {
    stream: WebTransportBidirectionalStream;
    controlReader: ControlStreamReader;
  };

  await bidiReadPublishResponse(ctx.session, ctx.requestId, stream.stream, stream.controlReader);

  assert.isDefined(ctx.closedWithError());
  assert.equal(ctx.closedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isFalse(ctx.session.pendingPublish.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isDefined(ctx.rejected());
  assert.isUndefined(ctx.resolved());
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.2:
 * ピアが送信方向を FIN で閉じた (graceful closure) 場合でも、publisher は
 * done() で PUBLISH_DONE を送信してから自方向を FIN で閉じる必要がある (MUST)。
 * requestStreams のエントリが FIN 後も保持され、PUBLISH_DONE → FIN の
 * 送信順序が維持されることを検証する。
 */
test("bidiReadRequestStreamMessages: ピア FIN 後の done() で PUBLISH_DONE → FIN の順序で送信される", async () => {
  const ctx = createPublishReadTestContext({});

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // ピアの FIN を再現する (controller.close() で reader.read() が { done: true } を返す)
  ctx.readableController.close();
  await readPromise;

  // ピアの graceful FIN では requestStreams のエントリが保持され、
  // done() で PUBLISH_DONE を送信できる
  assert.isTrue(ctx.session.requestStreams.has(ctx.requestId));

  await ctx.publisher.done();

  // PUBLISH_DONE 書き込み → FIN (close) の送信順序
  assert.deepEqual(ctx.events, ["write", "close"]);
  // done() 完了後に requestStreams / publishers から削除される
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isFalse(ctx.session.publishers.has(ctx.requestId));

  // 書き込まれたバイト列は PUBLISH_DONE メッセージ
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.PUBLISH_DONE);

  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.3:
 * ピアが RESET_STREAM で自方向をリセットした場合、reader.read() は reject する。
 * RESET は FIN (graceful) ではないため requestStreams のエントリは保持されず、
 * その後の done() は PUBLISH_DONE を送信せずセッションも閉じないことを検証する。
 */
test("bidiReadRequestStreamMessages: RESET_STREAM 後の done() で PUBLISH_DONE を送らずセッションも閉じない", async () => {
  const ctx = createPublishReadTestContext({});

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // ピアの RESET_STREAM を再現する (WebTransportError 相当の reason で reject)
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), { source: "stream" }),
  );
  await readPromise;

  // RESET は graceful FIN ではないため、従来どおり requestStreams から削除される
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));

  await ctx.publisher.done();

  // streamInfo が無いため PUBLISH_DONE を送信せず、セッションも閉じない
  assert.equal(ctx.written.length, 0);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.2:
 * ピア起因のセッション終了後 (sessionState: "closed") に done() を呼んだ場合、
 * publishSendPublishDone は write / close を試行しない。試行するとセッション
 * 終了起因のエラーで reject し、誤って PROTOCOL_VIOLATION に昇格して
 * callbacks.error に通知されるため、ガードの存在を検証する。
 */
test("publishSendPublishDone: ピア FIN 後のセッション終了 (sessionState closed) で done() が何もしない", async () => {
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

  // ピアのセッション終了相当 (transport.closed のハンドラは sessionState のみ遷移させる)
  forceSessionClosed(ctx.session);

  await ctx.publisher.done();

  // write / close を試行せず、セッションも閉じない (誤昇格しない)
  assert.equal(ctx.written.length, 0);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.2:
 * subscribe ロールではピアの FIN は保持対象外であり、従来どおり
 * requestStreams / subscribers / subscribersByAlias から削除されることを
 * 検証する (publish ロールのみが done() 完了後まで保持される)。
 */
test("bidiReadRequestStreamMessages: subscribe ロールのピア FIN では従来どおり requestStreams から削除される", async () => {
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
  ctx.readableController.close();
  await readPromise;

  // subscribe ロールでは FIN でも従来どおり削除される
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isFalse(ctx.session.subscribers.has(ctx.requestId));
  assert.isFalse(ctx.session.subscribersByAlias.has(1n));
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.2:
 * subscribe ロールでピア (publisher) の FIN を検出した場合、自方向の FIN
 * (writer.close()) を送信して graceful closure を完了することを検証する。
 * 0374 で追加された notifySubscriberFailure (error 通知) に加えて、自方向 FIN が
 * 送信される。
 */
test("bidiReadRequestStreamMessages: subscribe ロールのピア FIN で自方向 FIN (writer.close()) が送信される", async () => {
  const ctx = createPublishReadTestContext({});
  let errorCalled: Error | undefined;
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    ctx.requestId,
    1n,
    () => {},
    undefined,
    undefined,
    (e) => {
      errorCalled = e;
    },
  );
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  ctx.readableController.close();
  await readPromise;

  // 失敗扱いの FIN として error 通知される (0374 の挙動)
  assert.isDefined(errorCalled);
  assert.equal(errorCalled!.message, FIN_WITHOUT_PUBLISH_DONE_MESSAGE);
  // 自方向の FIN (writer.close()) が送信される
  assert.deepEqual(ctx.events, ["close"]);
  // クリーンアップは従来どおり実行される
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isFalse(ctx.session.subscribers.has(ctx.requestId));
  assert.isFalse(ctx.session.subscribersByAlias.has(1n));
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.2:
 * publish ロールでは requester の FIN は正常完了シグナルであり、自方向の
 * FIN は送信しない (アプリの done() に委ねる)。0370 の保持経路が維持される
 * ことを検証する。
 */
test("bidiReadRequestStreamMessages: publish ロールのピア FIN では自方向 FIN を送信しない", async () => {
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

  // 自方向の FIN は送信しない (done() に委ねる)
  assert.deepEqual(ctx.events, []);
  // publish ロールの FIN は requestStreams を保持する (0370)
  assert.isTrue(ctx.session.requestStreams.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.2:
 * 正常な PUBLISH_DONE → FIN 経路でも自方向の FIN (writer.close()) が送信され、
 * 通知挙動 (end コールバックのみ呼ばれ error コールバックは呼ばれず state が
 * closed) が変わらないことを検証する。
 */
test("bidiReadRequestStreamMessages: 正常な PUBLISH_DONE → FIN で自方向 FIN が送信され通知挙動が変わらない", async () => {
  const ctx = createPublishReadTestContext({});
  let endCalled = false;
  let errorCalled = false;
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    ctx.requestId,
    1n,
    () => {},
    undefined,
    () => {
      endCalled = true;
    },
    () => {
      errorCalled = true;
    },
  );
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  // PUBLISH_DONE (TRACK_ENDED) を feed してから FIN
  const publishDonePayload = encodePublishDonePayload({
    type: MessageType.PUBLISH_DONE,
    statusCode: 0x2n,
    streamCount: 0n,
    reasonPhrase: "",
  });
  const message = ctx.session.controlWriter!.encode(MessageType.PUBLISH_DONE, publishDonePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // end のみが呼ばれ、error は呼ばれない
  assert.isTrue(endCalled);
  assert.isFalse(errorCalled);
  assert.equal(subscriber.state, "closed");
  // 自方向の FIN (writer.close()) が送信される
  assert.deepEqual(ctx.events, ["close"]);
  // クリーンアップは従来どおり実行される
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isFalse(ctx.session.subscribers.has(ctx.requestId));
  assert.isFalse(ctx.session.subscribersByAlias.has(1n));
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.2:
 * subscribe ロールのピア FIN で、同一 Track Alias に他 subscription が残っている
 * 場合は subscribersByAlias のエントリが保持される (該当 subscriber のみ除去)
 * ことを検証する。
 */
test("bidiReadRequestStreamMessages: subscribe ロールのピア FIN で alias に他 subscription が残る場合はエントリが保持される", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber1 = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  const subscriber2 = new SubscriberImpl(["test"], "track", 30n, 1n, () => {});
  ctx.session.subscribers.set(ctx.requestId, subscriber1);
  ctx.session.subscribers.set(30n, subscriber2);
  ctx.session.subscribersByAlias.set(1n, [subscriber1, subscriber2]);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  ctx.readableController.close();
  await readPromise;

  // 該当 subscriber のみ除去され、alias エントリは保持される
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isFalse(ctx.session.subscribers.has(ctx.requestId));
  assert.isTrue(ctx.session.subscribersByAlias.has(1n));
  assert.equal(ctx.session.subscribersByAlias.get(1n)!.length, 1);
  assert.equal(ctx.session.subscribersByAlias.get(1n)![0], subscriber2);
});

/**
 * draft-ietf-moq-transport-21 §9.2 (GOAWAY) / §6.4.2.2:
 * GOAWAY 受信 (publish ロール) 後は読み取りを継続し、requestStreams が保持
 * される。その後ピアが FIN した場合、readRequestStreamMessages の finally の
 * 「publish ロール && receivedFin」経路に合流してエントリが保持され、アプリの
 * done() による PUBLISH_DONE → FIN の経路が維持されることを検証する。
 */
test("bidiReadRequestStreamMessages: GOAWAY 受信 (publish ロール) 後も読み取り継続し done() で PUBLISH_DONE が送信される", async () => {
  const ctx = createPublishReadTestContext({});

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // GOAWAY メッセージを feed し、読み取りを継続させる
  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "moqt://new.example.com",
    timeout: 0n,
  });
  const message = ctx.session.controlWriter!.encode(MessageType.GOAWAY, goawayPayload);
  ctx.readableController.enqueue(message);
  // ピアの FIN (読み取り継続の自然終了)
  ctx.readableController.close();
  await readPromise;

  // 重複 GOAWAY 検出 (PROTOCOL_VIOLATION) の seed として登録される
  assert.isTrue(ctx.session.goawayReceivedOnRequestStreams.has(ctx.requestId));
  // GOAWAY 受信時は publisher に FIN を送らない (§6.4.2.2 MUST: done() に委ねる)
  assert.deepEqual(ctx.events, []);
  // GOAWAY 後のピア FIN は receivedFin 経路で保持される
  assert.isTrue(ctx.session.requestStreams.has(ctx.requestId));

  await ctx.publisher.done();

  // done() で PUBLISH_DONE → FIN が送信される
  assert.deepEqual(ctx.events, ["write", "close"]);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.2 (GOAWAY):
 * 「The endpoint MUST close the session with a PROTOCOL_VIOLATION (Section 12.2)
 * if it receives more than one GOAWAY on the control stream or on a single
 * request stream.」
 * GOAWAY 受信後も読み取りを継続し、2 通目の GOAWAY (同一チャンク) で
 * PROTOCOL_VIOLATION でセッションが閉じることを検証する。
 */
test("bidiReadRequestStreamMessages: 重複 GOAWAY (同一チャンク) で PROTOCOL_VIOLATION でセッションが閉じる", async () => {
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
  // GOAWAY 2 通を同一チャンクで feed する
  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "moqt://new.example.com",
    timeout: 0n,
  });
  const message = ctx.session.controlWriter!.encode(MessageType.GOAWAY, goawayPayload);
  ctx.readableController.enqueue(concatUint8Arrays([message, message]));
  ctx.readableController.close();
  await readPromise;

  // 2 通目 GOAWAY で PROTOCOL_VIOLATION
  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(
    ctx.closedWithError!.message.includes("received duplicate goaway on request stream"),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.2 (GOAWAY):
 * チャンク境界をまたぐ 2 通目の GOAWAY でも PROTOCOL_VIOLATION でセッションが
 * 閉じることを検証する。
 */
test("bidiReadRequestStreamMessages: 重複 GOAWAY (チャンク境界) で PROTOCOL_VIOLATION でセッションが閉じる", async () => {
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
  // GOAWAY 2 通を別チャンクで feed する
  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "moqt://new.example.com",
    timeout: 0n,
  });
  const message = ctx.session.controlWriter!.encode(MessageType.GOAWAY, goawayPayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(
    ctx.closedWithError!.message.includes("received duplicate goaway on request stream"),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.2 (GOAWAY):
 * GOAWAY 受信 (subscribe ロール) で送信方向が FIN (writer.close()) で閉じられ、
 * 受信方向は読み取りが継続されることを検証する。1 通目 GOAWAY ではセッション
 * が閉じない。
 */
test("bidiReadRequestStreamMessages: GOAWAY 受信 (subscribe ロール) で送信方向が FIN で閉じられる", async () => {
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
  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "moqt://new.example.com",
    timeout: 0n,
  });
  const message = ctx.session.controlWriter!.encode(MessageType.GOAWAY, goawayPayload);
  ctx.readableController.enqueue(message);
  // 読み取り継続の自然終了 (ピアの FIN)
  ctx.readableController.close();
  await readPromise;

  // 1 通目 GOAWAY ではセッションが閉じない
  assert.isUndefined(ctx.closedWithError);
  // 送信方向の FIN (writer.close()) が呼ばれる (GOAWAY は受信のみなので write はない)
  assert.deepEqual(ctx.events, ["close"]);
  // subscribe ロールでは FIN 後に従来どおり削除される
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §9.2 / §12.5 / §9.5:
 * GOAWAY 受信後の旧リクエストに対する REQUEST_UPDATE は、publish ロールでは
 * REQUEST_ERROR (GOING_AWAY) で応答される (§9.5 MUST) ことを検証する。
 */
test("bidiReadRequestStreamMessages: GOAWAY 後の REQUEST_UPDATE に REQUEST_ERROR (GOING_AWAY) が応答される (publish ロール)", async () => {
  const ctx = createPublishReadTestContext({});
  // GOAWAY を受信済みの状態を作る
  ctx.session.goawayReceivedOnRequestStreams.add(ctx.requestId);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // REQUEST_UPDATE を feed する
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // REQUEST_ERROR (GOING_AWAY) が書き込まれ、セッションは閉じない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  const decoded = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.GOING_AWAY));
  assert.equal(messages[1].type, MessageType.PUBLISH_DONE);
  const publishDone = decodePublishDonePayload(messages[1].payload);
  assert.equal(publishDone.statusCode, BigInt(PublishDoneStatusCode.UPDATE_FAILED));
  assert.equal(publishDone.streamCount, 0n);
  assert.equal(publishDone.reasonPhrase, "");
  // 購読状態は掃除され、PublisherImpl も closed になり、セッションは閉じない
  assert.equal(ctx.publisher.state, "closed");
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isFalse(ctx.session.publishers.has(ctx.requestId));
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.5.1:
 * publish ロールの REQUEST_UPDATE 拒否 (INVALID_FILTER) では、REQUEST_ERROR の
 * 後に PUBLISH_DONE (UPDATE_FAILED) が送出される。
 */
test("bidiReadRequestStreamMessages: 不正 Range Filter の REQUEST_UPDATE 拒否で PUBLISH_DONE (UPDATE_FAILED) が送信される (publish ロール)", async () => {
  // INVALID_FILTER 拒否の後続として PUBLISH_DONE が送出される
  const ctx = createPublishReadTestContext({});

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // PRIORITY_FILTER (0x27) で 255 超の値を含む REQUEST_UPDATE を feed する
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      {
        type: 0x27,
        value: new Uint8Array([0x04, 0x01, 0xac, 0x02, 0x00]),
      },
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // REQUEST_ERROR (INVALID_FILTER) の後に PUBLISH_DONE (UPDATE_FAILED) が送出される
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  assert.equal(
    decodeRequestErrorPayload(messages[0].payload).errorCode,
    BigInt(RequestErrorCode.INVALID_FILTER),
  );
  assert.equal(messages[1].type, MessageType.PUBLISH_DONE);
  const publishDone = decodePublishDonePayload(messages[1].payload);
  assert.equal(publishDone.statusCode, BigInt(PublishDoneStatusCode.UPDATE_FAILED));
  assert.equal(publishDone.streamCount, 0n);
  assert.equal(publishDone.reasonPhrase, "");
  // PublisherImpl も closed になる
  assert.equal(ctx.publisher.state, "closed");
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isFalse(ctx.session.publishers.has(ctx.requestId));
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.5.1 / §9.9:
 * publisher がない REQUEST_UPDATE 拒否では、REQUEST_ERROR (INTERNAL_ERROR) の
 * 後に PUBLISH_DONE (UPDATE_FAILED) が送出される。開設数を確定できないため
 * Stream Count は 2^64 - 1 になる。
 */
test("bidiReadRequestStreamMessages: publisher がない REQUEST_UPDATE 拒否で Stream Count 2^64-1 の PUBLISH_DONE が送信される (publish ロール)", async () => {
  // publisher なし経路で終了する
  const ctx = createPublishReadTestContext({});
  ctx.session.publishers.delete(ctx.requestId);

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

  // REQUEST_ERROR (INTERNAL_ERROR) の後に PUBLISH_DONE (UPDATE_FAILED) が送出される
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  assert.equal(
    decodeRequestErrorPayload(messages[0].payload).errorCode,
    BigInt(RequestErrorCode.INTERNAL_ERROR),
  );
  assert.equal(messages[1].type, MessageType.PUBLISH_DONE);
  const publishDone = decodePublishDonePayload(messages[1].payload);
  assert.equal(publishDone.statusCode, BigInt(PublishDoneStatusCode.UPDATE_FAILED));
  assert.equal(publishDone.streamCount, MAX_VARINT);
  assert.equal(publishDone.reasonPhrase, "");
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.5.1:
 * REQUEST_ERROR の書き込みに失敗しても PUBLISH_DONE 送信に進み、
 * 購読状態を掃除してセッションを閉じない
 * (INVALID_FILTER 経路の回復力。他 2 経路と同一ヘルパー共有)。
 */
test("bidiReadRequestStreamMessages: 書き込み失敗でも購読を掃除してセッションを閉じない (publish ロール)", async () => {
  // ピアのリセット相当 (source: stream) の書き込み失敗を注入しても終了処理が完走する
  const peerResetError = () => Object.assign(new Error("reset by peer"), { source: "stream" });
  const ctx = createPublishReadTestContext({
    write: () => {
      throw peerResetError();
    },
  });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // PRIORITY_FILTER (0x27) で 255 超の値を含む REQUEST_UPDATE を feed する
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      {
        type: 0x27,
        value: new Uint8Array([0x04, 0x01, 0xac, 0x02, 0x00]),
      },
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // 書き込み失敗は黙殺され、購読状態は掃除され、セッションは閉じない
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isFalse(ctx.session.publishers.has(ctx.requestId));
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.9:
 * PUBLISH_DONE 送信前にデータストリームを閉じる (done() 経路と同形)。
 * 書き込み順序でデータストリーム close 先行を検証する。
 */
test("bidiReadRequestStreamMessages: REQUEST_UPDATE 拒否でデータストリームを閉じてから PUBLISH_DONE が送信される (publish ロール)", async () => {
  // データストリーム close が PUBLISH_DONE 送信より先に試行される
  const ctx = createPublishReadTestContext({});
  const dataWritable = new WritableStream<Uint8Array>({
    close() {
      ctx.events.push("data-close");
    },
  });
  // テスト publisher (trackAlias 1n) の開設済みデータストリームを登録する
  ctx.session.publisherStreams.set(1n, {
    groupId: 0n,
    writer: dataWritable.getWriter(),
    previousObjectId: 0n,
  });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // PRIORITY_FILTER (0x27) で 255 超の値を含む REQUEST_UPDATE を feed する
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      {
        type: 0x27,
        value: new Uint8Array([0x04, 0x01, 0xac, 0x02, 0x00]),
      },
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // REQUEST_ERROR 書き込み → データストリーム close → PUBLISH_DONE 書き込み → FIN の順序である
  assert.deepEqual(ctx.events, ["write", "data-close", "write", "close"]);
  // データストリームの登録は掃除される
  assert.isFalse(ctx.session.publisherStreams.has(1n));
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.5.1 / §9.9:
 * 拒否で送出した PUBLISH_DONE (UPDATE_FAILED) のワイヤペイロードを
 * 受信デコーダに流すと、購読側の errorCallback が呼ばれる
 * (ワイヤペイロード単位の round-trip)。
 */
test("bidiReadRequestStreamMessages: 送出した PUBLISH_DONE (UPDATE_FAILED) のペイロード受信で errorCallback が呼ばれる", async () => {
  // 送信側: INVALID_FILTER 拒否で PUBLISH_DONE を送出させる
  const sender = createPublishReadTestContext({});

  const senderPromise = bidiReadRequestStreamMessages(
    sender.session,
    sender.requestId,
    sender.stream,
    sender.controlReader,
    "publish",
  );
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: sender.requestId,
    parameters: [
      {
        type: 0x27,
        value: new Uint8Array([0x04, 0x01, 0xac, 0x02, 0x00]),
      },
    ],
  });
  const updateMessage = sender.session.controlWriter!.encode(
    MessageType.REQUEST_UPDATE,
    updatePayload,
  );
  sender.readableController.enqueue(updateMessage);
  sender.readableController.close();
  await senderPromise;

  const sent = new ControlStreamReader().feed(concatUint8Arrays(sender.written));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].type, MessageType.PUBLISH_DONE);

  // 受信側: 送出されたワイヤを実 SubscriberImpl に流す
  let errorCalled: Error | undefined;
  let endCalled = false;
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    0n,
    1n,
    () => {},
    undefined,
    () => {
      endCalled = true;
    },
    (error) => {
      errorCalled = error;
    },
  );
  const receiver = createPublishReadTestContext({});
  receiver.session.subscribers.set(0n, subscriber);
  bidiHandlePublishDone(receiver.session, sent[1].payload, 0n);

  // UPDATE_FAILED (0x8) がエラー通知され、終了も通知される
  assert.isDefined(errorCalled);
  assert.isTrue(errorCalled!.message.includes("0x8"));
  assert.isTrue(endCalled);
  assert.equal(subscriber.state, "closed");
});

/**
 * draft-ietf-moq-transport-21 §9.2 / §12.5 / §9.5:
 * GOAWAY 受信後の REQUEST_UPDATE は subscribe ロールでは無視されることを
 * 検証する。subscribe ロールは GOAWAY 処理で送信方向を FIN (writer.close())
 * で閉じており、GOING_AWAY 応答を書き込むことができないためである。
 */
test("bidiReadRequestStreamMessages: GOAWAY 後の REQUEST_UPDATE は無視される (subscribe ロール)", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);
  // GOAWAY を受信済みの状態を作る
  ctx.session.goawayReceivedOnRequestStreams.add(ctx.requestId);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  // REQUEST_UPDATE を feed する
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // REQUEST_UPDATE は無視され、応答も送信されずセッションも閉じない
  assert.equal(ctx.written.length, 0);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §8.9 / §6.6 / §12.2 / §9.5.1:
 * subscribe ロールの受信 REQUEST_UPDATE が未登録 Alias を参照する場合、
 * Session Termination の UNKNOWN_AUTH_TOKEN_ALIAS (0x17) でセッションを閉じることを
 * 検証する。セッションが閉じるため §9.5 の REQUEST_OK / REQUEST_ERROR は送らず、
 * §9.5.1 の PUBLISH_DONE (UPDATE_FAILED) も subscriber 側なので対象外である。
 */
test("bidiReadRequestStreamMessages: 未登録 Alias の REQUEST_UPDATE (subscribe ロール) は UNKNOWN_AUTH_TOKEN_ALIAS でセッションを閉じる", async () => {
  const ctx = createPublishReadTestContext({}, 1024);
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  // subscribe ロールの REQUEST_UPDATE は GOAWAY 受信済みの旧リクエストでのみ
  // AUTHORIZATION TOKEN の判定に到達するため、その状態にする。
  ctx.session.goawayReceivedOnRequestStreams.add(ctx.requestId);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      {
        type: MessageParameterType.AUTHORIZATION_TOKEN,
        value: encodeAuthorizationToken({
          aliasType: AuthorizationTokenAliasType.USE_ALIAS,
          tokenAlias: 88n,
        }),
      },
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // セッションを閉じるため REQUEST_OK / REQUEST_ERROR も PUBLISH_DONE も送らない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 0);
  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError.code, SessionErrorCode.UNKNOWN_AUTH_TOKEN_ALIAS);
});
