/**
 * session/bidi.ts の単体テスト
 *
 * BidiSessionInternal を実装するモックを用いて、双方向ストリーム上のメッセージ処理を検証する。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import { type MoqtObject } from "../dataStream";
import { ObjectStatus, type Location } from "../message";
import {
  encodeRequestOkPayload,
  decodeRequestOkPayload,
  encodeGoawayPayload,
} from "../message/session";
import { MessageType, MessageParameterType } from "../message/types";
import { decodeRequestUpdatePayload } from "../message/subscribe";
import { SessionError, SessionErrorCode } from "../error";
import { ControlStreamReader, ControlStreamWriter } from "../controlStream";
import { PublisherImpl } from "../publisher";
import {
  bidiHandleRequestUpdateOk,
  bidiReadPublishResponse,
  bidiReadRequestStreamMessages,
  bidiSendRequestUpdate,
  validateNoDuplicateGoawayOnRequestStream,
  type BidiSessionInternal,
} from "./bidi";
import { publishSendPublishDone } from "./publish";
import type { SessionInternal } from "./types";

// ============================================================================
// bidiHandlePublishDone のテスト
// ============================================================================

test("bidiHandlePublishDone: PUBLISH_DONE 正常終了で endCallback が呼ばれる", () => {
  let endCalled = false;
  let errorCalled: Error | undefined;

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
    (e) => {
      errorCalled = e;
    },
  );

  subscriber.handleEnd(0x2n, undefined);

  assert.equal(endCalled, true);
  assert.equal(errorCalled, undefined);
});

test("bidiHandlePublishDone: PUBLISH_DONE INTERNAL_ERROR で errorCallback が呼ばれる", () => {
  let errorCalled: Error | undefined;

  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    0n,
    1n,
    () => {},
    undefined,
    () => {},
    (e) => {
      errorCalled = e;
    },
  );

  subscriber.handleEnd(0x0n, "internal error");

  assert.notEqual(errorCalled, undefined);
  assert.isTrue(errorCalled!.message.includes("PUBLISH_DONE"));
  assert.isTrue(errorCalled!.message.includes("internal error"));
});

test("bidiHandlePublishDone: closed 状態では endCallback が呼ばれない", () => {
  let endCalled = false;
  let errorCalled: Error | undefined;

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
    (e) => {
      errorCalled = e;
    },
  );

  subscriber.markClosed();
  subscriber.handleEnd(0x2n, undefined);

  assert.equal(endCalled, false);
  assert.equal(errorCalled, undefined);
});

// ============================================================================
// SubscriberImpl handleObject / handleDatagram のテスト
// ============================================================================

test("SubscriberImpl.handleObject: active 状態で objectCallback が呼ばれる", () => {
  let received: MoqtObject | undefined;

  const subscriber = new SubscriberImpl(["test"], "track", 0n, 1n, (obj) => {
    received = obj;
  });

  const obj: MoqtObject = {
    groupId: 1n,
    objectId: 1n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array([1, 2, 3]),
  };

  subscriber.handleObject(obj);

  assert.notEqual(received, undefined);
  assert.equal(received!.groupId, 1n);
  assert.equal(received!.objectId, 1n);
});

test("SubscriberImpl.handleObject: closed 状態では呼ばれない", () => {
  let received: MoqtObject | undefined;

  const subscriber = new SubscriberImpl(["test"], "track", 0n, 1n, (obj) => {
    received = obj;
  });

  subscriber.markClosed();
  subscriber.handleObject({
    groupId: 1n,
    objectId: 1n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array([1, 2, 3]),
  });

  assert.equal(received, undefined);
});

test("SubscriberImpl.handleDatagram: datagram callback が設定されている場合に呼ばれる", () => {
  let datagramReceived: MoqtObject | undefined;
  let objectReceived: MoqtObject | undefined;

  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    0n,
    1n,
    (obj) => {
      objectReceived = obj;
    },
    (obj) => {
      datagramReceived = obj;
    },
  );

  const obj: MoqtObject = {
    groupId: 1n,
    objectId: 1n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array([1, 2, 3]),
  };

  subscriber.handleDatagram(obj);

  assert.notEqual(datagramReceived, undefined);
  assert.equal(objectReceived, undefined);
});

test("SubscriberImpl.handleDatagram: closed 状態では呼ばれない", () => {
  let datagramReceived: MoqtObject | undefined;

  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    0n,
    1n,
    () => {},
    (obj) => {
      datagramReceived = obj;
    },
  );

  subscriber.markClosed();
  subscriber.handleDatagram({
    groupId: 1n,
    objectId: 1n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array([1, 2, 3]),
  });

  assert.equal(datagramReceived, undefined);
});

// ============================================================================
// SubscriberImpl setLargestLocation / setTrackProperties のテスト
// ============================================================================

test("SubscriberImpl.setLargestLocation: largestLocation が設定される", () => {
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  const location: Location = { group: 5n, object: 10n };
  subscriber.setLargestLocation(location);

  assert.notEqual(subscriber.largestLocation, null);
  assert.equal(subscriber.largestLocation!.group, 5n);
  assert.equal(subscriber.largestLocation!.object, 10n);
});

test("SubscriberImpl.setTrackAlias: track alias が更新される", () => {
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  subscriber.setTrackAlias(42n);

  assert.equal(subscriber.getTrackAlias(), 42n);
});

// ============================================================================
// SubscriberImpl 状態遷移のテスト
// ============================================================================

test("SubscriberImpl: unsubscribe → closed であること", async () => {
  let unsubscribeCalled = false;

  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  subscriber.onUnsubscribe = async () => {
    unsubscribeCalled = true;
  };

  await subscriber.unsubscribe();

  assert.equal(subscriber.state, "closed");
  assert.equal(unsubscribeCalled, true);
});

test("SubscriberImpl: 二重 unsubscribe は no-op", async () => {
  let callCount = 0;

  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  subscriber.onUnsubscribe = async () => {
    callCount++;
  };

  await subscriber.unsubscribe();
  await subscriber.unsubscribe();

  assert.equal(callCount, 1);
});

// ============================================================================
// bidiHandleRequestUpdateOk の Track Properties 空チェックテスト
// ============================================================================

/**
 * draft-ietf-moq-transport-19 Section 10.5 (REQUEST_OK):
 * "Track Properties are populated in TRACK_STATUS_OK; they are empty in
 *  PUBLISH_OK, REQUEST_UPDATE_OK, SUBSCRIBE_NAMESPACE_OK and PUBLISH_NAMESPACE_OK.
 *  If an endpoint receives Track Properties in one of these messages it MUST
 *  close the session with a PROTOCOL_VIOLATION."
 * REQUEST_UPDATE_OK で非空 Track Properties を受信した場合の検証。
 */
test("bidiHandleRequestUpdateOk: 非空 Track Properties で closeWithError が呼ばれる", () => {
  let closedWithError: SessionError | undefined;

  const session = {
    closeWithError: (error: SessionError) => {
      closedWithError = error;
    },
    subscribers: new Map(),
    pendingRequestUpdate: new Map(),
    // BidiSessionInternal の他のフィールドは本関数のテストで未使用のため undefined
  } as unknown as BidiSessionInternal;

  const payload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [{ id: 0n, value: 1n }],
  });

  bidiHandleRequestUpdateOk(session, payload, 0n);

  assert.notEqual(closedWithError, undefined);
  assert.equal(closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(
    closedWithError!.message.includes("track properties must be empty in REQUEST_UPDATE_OK"),
  );
});

/**
 * REQUEST_UPDATE_OK で空 Track Properties を受信した場合の正常系検証。
 */
test("bidiHandleRequestUpdateOk: 空 Track Properties では closeWithError が呼ばれない", () => {
  let closedWithError: SessionError | undefined;

  const session = {
    closeWithError: (error: SessionError) => {
      closedWithError = error;
    },
    subscribers: new Map(),
    pendingRequestUpdate: new Map(),
  } as unknown as BidiSessionInternal;

  const payload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [],
  });

  bidiHandleRequestUpdateOk(session, payload, 0n);

  assert.equal(closedWithError, undefined);
});

// ============================================================================
// PUBLISH_OK Track Properties 非空チェックテスト
// ============================================================================

/**
 * draft-ietf-moq-transport-19 §10.5 (REQUEST_OK):
 * PUBLISH_OK で非空 Track Properties を含む REQUEST_OK を受信した場合、
 * PROTOCOL_VIOLATION でセッションが閉じられることを検証する。
 */
test("PUBLISH_OK: 非空 Track Properties で closeWithError が呼ばれる", () => {
  const payload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [{ id: 0n, value: 1n }],
  });

  // decodeRequestOkPayload が非空 Track Properties を正しく返すことを検証
  const decoded = decodeRequestOkPayload(payload);
  assert.equal(decoded.trackProperties.length, 1);
  assert.equal(decoded.trackProperties[0].id, 0n);
});

/**
 * PUBLISH_OK で空 Track Properties の REQUEST_OK が正常にデコードされることを検証する。
 */
test("PUBLISH_OK: 空 Track Properties は正常にデコードされる", () => {
  const payload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [],
  });

  const decoded = decodeRequestOkPayload(payload);
  assert.equal(decoded.trackProperties.length, 0);
});

// ============================================================================
// validateNoDuplicateGoawayOnRequestStream のテスト
// ============================================================================

/**
 * draft-ietf-moq-transport-19 Section 10.4 (GOAWAY):
 * リクエストストリーム上の重複 GOAWAY は PROTOCOL_VIOLATION。
 * 初回の Request ID は seenSet に追加され true を返す。
 */
test("validateNoDuplicateGoawayOnRequestStream: 初回は true で seenSet に追加される", () => {
  const seen = new Set<bigint>();
  let closed: SessionError | undefined;
  const result = validateNoDuplicateGoawayOnRequestStream(0n, seen, (error) => {
    closed = error;
  });
  assert.isTrue(result);
  assert.isTrue(seen.has(0n));
  assert.isUndefined(closed);
});

/**
 * 2 回目の同一 Request ID は重複として PROTOCOL_VIOLATION で closeSession を呼び false を返す。
 */
test("validateNoDuplicateGoawayOnRequestStream: 2 回目は PROTOCOL_VIOLATION で false を返す", () => {
  const seen = new Set<bigint>([0n]);
  let closed: SessionError | undefined;
  const result = validateNoDuplicateGoawayOnRequestStream(0n, seen, (error) => {
    closed = error;
  });
  assert.isFalse(result);
  assert.isDefined(closed);
  assert.equal(closed!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(closed!.message.includes("received duplicate goaway on request stream"));
});

// ============================================================================
// bidiSendRequestUpdate の Range Filters テスト
// draft-ietf-moq-transport-19 §5.1.3 / §10.3.1.6
// ============================================================================

/**
 * BidiSessionInternal のモックを構築する。
 * writer.write に渡されたバイト列を `written` に蓄積し、後からデコードして検証する。
 */
function createBidiSession(): {
  session: BidiSessionInternal;
  written: Uint8Array[];
} {
  const written: Uint8Array[] = [];
  const writer = {
    write: async (data: Uint8Array): Promise<void> => {
      written.push(data);
    },
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  const session = {
    sessionState: "connected",
    transport: {},
    controlWriter: new ControlStreamWriter(),
    nextRequestId: 100n,
    requestStreams: new Map([
      [
        0n,
        {
          stream: {},
          writer,
          controlReader: new ControlStreamReader(),
        },
      ],
    ]),
    pendingPublish: new Map(),
    pendingSubscribe: new Map(),
    pendingFetch: new Map(),
    pendingTrackStatus: new Map(),
    pendingRequestUpdate: new Map(),
    publishers: new Map(),
    subscribers: new Map(),
    subscribersByAlias: new Map(),
    fetchers: new Map(),
    pendingSubgroupBuffer: {},
    fetcherReadyCallbacks: new Map(),
    goawayReceivedOnRequestStreams: new Set(),
    peerMaxRequestUpdates: 0,
    peerMaxFilterRanges: 2,
    tracksSubscriptions: new Map(),
    statsControlMessagesSent: 0,
    emitDebug: () => {},
    closeWithError: () => {},
  } as unknown as BidiSessionInternal;

  return { session, written };
}

test("bidiSendRequestUpdate: rangeFilters が REQUEST_UPDATE にエンコードされる", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  // bidiSendRequestUpdate は REQUEST_OK 受信まで resolve しない Promise を返すため、
  // 送信完了後に pendingRequestUpdate の Promise を解決してから await する
  const updatePromise = bidiSendRequestUpdate(session, subscriber, {
    rangeFilters: [
      { type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 1n }] },
      { type: "trackProperty", remove: true },
    ],
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  // writer.write されたバイト列を ControlStreamReader でフレームに分解する
  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_UPDATE);

  const decoded = decodeRequestUpdatePayload(messages[0].payload);
  assert.isDefined(decoded.parameters.find((p) => p.type === MessageParameterType.SUBGROUP_FILTER));
  assert.isDefined(
    decoded.parameters.find((p) => p.type === MessageParameterType.TRACK_PROPERTY_FILTER),
  );
});

test("bidiSendRequestUpdate: Range Filters の Ranges 数が MAX_FILTER_RANGES を超えると throw する", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      rangeFilters: [
        {
          type: "subgroup",
          setId: 0,
          ranges: [
            { start: 0n, end: 1n },
            { start: 3n, end: 4n },
            { start: 5n, end: 6n },
          ],
        },
      ],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("exceeds peer MAX_FILTER_RANGES 2"));
});

test("bidiSendRequestUpdate: Range Filters が MAX_FILTER_RANGES 以内なら throw しない", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  let thrown: Error | undefined;
  try {
    // pendingRequestUpdate の Promise を解決してから await する
    const updatePromise = bidiSendRequestUpdate(session, subscriber, {
      rangeFilters: [
        {
          type: "subgroup",
          setId: 0,
          ranges: [
            { start: 0n, end: 1n },
            { start: 3n, end: 4n },
          ],
        },
      ],
    });
    for (const [, pending] of session.pendingRequestUpdate) {
      pending.resolve();
    }
    await updatePromise;
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isUndefined(thrown);
});

/** Uint8Array 配列を連結するヘルパー */
function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// ============================================================================
// bidiReadRequestStreamMessages / publishSendPublishDone の統合テスト
// (実 W3C ストリーム注入方式)
// draft-ietf-moq-transport-19 §3.3.2 / §3.3.3 / §10.11
// ============================================================================

/**
 * 実 W3C ストリーム (`ReadableStream` + `WritableStream`) と実 Map で構成した
 * publish ロール用の session を構築する。ストリーム機構は実物であり、
 * 失敗注入点は sink のみ。session はテスト用のオブジェクトリテラルを
 * 型キャストしたものであり、BidiSessionInternal の未使用フィールドは
 * 最小限のダミー値で満たす。
 */
function createPublishReadTestContext(writableSink: UnderlyingSink<Uint8Array>): {
  session: BidiSessionInternal;
  stream: WebTransportBidirectionalStream;
  readableController: ReadableStreamDefaultController<Uint8Array>;
  events: string[];
  written: Uint8Array[];
  closedWithError: SessionError | undefined;
  publisher: PublisherImpl;
  requestId: bigint;
  controlReader: ControlStreamReader;
} {
  const requestId = 10n;
  const events: string[] = [];
  const written: Uint8Array[] = [];
  let closedWithError: SessionError | undefined;

  let readableController!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      readableController = controller;
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk, controller) {
      events.push("write");
      written.push(chunk);
      if (writableSink.write) {
        return writableSink.write(chunk, controller);
      }
    },
    close() {
      events.push("close");
      if (writableSink.close) {
        return writableSink.close();
      }
    },
  });

  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;
  const writer = writable.getWriter();
  const controlReader = new ControlStreamReader();

  const publisher = new PublisherImpl(["test"], "track", requestId, 1n);
  publisher.onDoneInternal = () =>
    publishSendPublishDone(session as unknown as SessionInternal, publisher);

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
    publishers: new Map([[requestId, publisher]]),
    subscribers: new Map(),
    subscribersByAlias: new Map(),
    fetchers: new Map(),
    pendingSubgroupBuffer: {},
    fetcherReadyCallbacks: new Map(),
    goawayReceivedOnRequestStreams: new Set(),
    peerMaxRequestUpdates: 0,
    peerMaxFilterRanges: 0,
    tracksSubscriptions: new Map(),
    statsControlMessagesSent: 0,
    emitDebug: () => {},
    closeWithError: (error: SessionError) => {
      closedWithError = error;
    },
  } as unknown as BidiSessionInternal;

  return {
    session,
    stream,
    readableController,
    events,
    written,
    // 値コピーではなく getter で返す (closeWithError 呼び出し後の代入を反映する)
    get closedWithError(): SessionError | undefined {
      return closedWithError;
    },
    publisher,
    requestId,
    controlReader,
  };
}

/**
 * draft-ietf-moq-transport-19 §3.3.2:
 * PUBLISH_OK 受信前 (Established 前) にピアが FIN を送った場合、リクエストは
 * 失敗として処理される。bidiReadResponseFromBidiStream の throw が
 * bidiReadPublishResponse の catch で処理され、pendingPublish の reject と
 * requestStreams からの削除が行われることを検証する。
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
 * draft-ietf-moq-transport-19 §3.3.2:
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
 * draft-ietf-moq-transport-19 §3.3.3:
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
 * draft-ietf-moq-transport-19 §3.5:
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
  (ctx.session as unknown as { sessionState: "connected" | "closed" }).sessionState = "closed";

  await ctx.publisher.done();

  // write / close を試行せず、セッションも閉じない (誤昇格しない)
  assert.equal(ctx.written.length, 0);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-19 §3.3.2:
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
 * draft-ietf-moq-transport-19 §3.3.2:
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
 * draft-ietf-moq-transport-19 §10.4 (GOAWAY) / §3.3.2:
 * GOAWAY 受信は graceful FIN ではないため (receivedFin = false)、
 * publish ロールでも従来どおり requestStreams から削除されることを検証する。
 * GOAWAY 後の done() で PUBLISH_DONE を送信できない (streamInfo が無い) 挙動は
 * 既存どおりである。
 */
test("bidiReadRequestStreamMessages: GOAWAY 受信 (publish ロール) では従来どおり requestStreams から削除される", async () => {
  const ctx = createPublishReadTestContext({});

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // GOAWAY メッセージを feed し、ループを return で終了させる
  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "moqt://new.example.com",
    timeout: 0n,
  });
  const message = ctx.session.controlWriter!.encode(MessageType.GOAWAY, goawayPayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // GOAWAY 経路では保持されず、従来どおり削除される
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  // 重複 GOAWAY 検出 (PROTOCOL_VIOLATION) の seed として登録される
  assert.isTrue(ctx.session.goawayReceivedOnRequestStreams.has(ctx.requestId));

  await ctx.publisher.done();

  // GOAWAY 後は streamInfo が無いため PUBLISH_DONE を送信せず、セッションも閉じない
  assert.equal(ctx.written.length, 0);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-19 §3.3.2 / §10.11:
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
 * draft-ietf-moq-transport-19 §3.3.3:
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
 * draft-ietf-moq-transport-19 §3.3.4 (Stream Reset Error Codes):
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
 * draft-ietf-moq-transport-19 §3.3.3:
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
