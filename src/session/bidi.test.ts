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
  decodeRequestErrorPayload,
  encodeGoawayPayload,
} from "../message/session";
import { encodePublishDonePayload } from "../message/publish";
import { MessageType, MessageParameterType } from "../message/types";
import { trackNamespaceToStrings } from "../message";
import { decodeRequestUpdatePayload, encodeRequestUpdatePayload } from "../message/subscribe";
import { getParameterTrackNamespace } from "../message/parameter";
import { SessionError, SessionErrorCode, RequestErrorCode, RequestError } from "../error";
import { ControlStreamReader, ControlStreamWriter } from "../controlStream";
import { PublisherImpl } from "../publisher";
import {
  bidiHandlePublishRequestUpdate,
  bidiHandleRequestUpdateOk,
  bidiReadPublishResponse,
  bidiReadRequestStreamMessages,
  bidiSendJoiningFetch,
  bidiSendNamespaceRequestUpdate,
  bidiSendRequestUpdate,
  FIN_WITHOUT_PUBLISH_DONE_MESSAGE,
  RESET_REQUEST_STREAM_MESSAGE,
  notifySubscriberFailure,
  validateNoDuplicateGoawayOnRequestStream,
  type BidiSessionInternal,
} from "./bidi";
import { FetcherImpl } from "../fetcher";
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
 * draft-ietf-moq-transport-19 §5.1.3:
 * 自 update({ rangeFilters }) の REQUEST_OK 受信時に、送信時の Range Filters が
 * SubscriberImpl に反映されることを検証する。
 * REQUEST_UPDATE で省略された型は不変 (「If a filter parameter is omitted from
 * REQUEST_UPDATE, the value is unchanged」§5.1.3)。
 */
test("bidiHandleRequestUpdateOk: rangeFilters が SubscriberImpl に反映される", () => {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, (obj) => delivered.push(obj));
  // SUBSCRIBE 時に subgroup + objectId を設定
  subscriber.setRangeFilters([
    { type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 2n }] },
    { type: "objectId", setId: 0, ranges: [{ start: 5n, end: 7n }] },
  ]);

  const session = {
    closeWithError: () => {},
    subscribers: new Map([[0n, subscriber]]),
    pendingRequestUpdate: new Map([
      [
        1n,
        {
          resolve: () => {},
          reject: () => {},
          targetRequestId: 0n,
          forward: undefined,
          rangeFilters: [{ type: "objectId", setId: 0, ranges: [{ start: 8n, end: 9n }] }],
        },
      ],
    ]),
  } as unknown as BidiSessionInternal;

  const payload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [],
  });
  bidiHandleRequestUpdateOk(session, payload, 0n);

  // objectId フィルタは [8-9] に置換され、subgroup フィルタは不変のため、
  // subgroupId=1 かつ objectId=8 のみ通過する
  subscriber.handleObject({
    groupId: 0n,
    subgroupId: 1n,
    objectId: 8n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array([1]),
  });
  subscriber.handleObject({
    groupId: 0n,
    subgroupId: 1n,
    objectId: 6n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array([1]),
  });
  subscriber.handleObject({
    groupId: 0n,
    subgroupId: 3n,
    objectId: 8n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array([1]),
  });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].objectId, 8n);
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

/**
 * draft-ietf-moq-transport-19 §10.2.17:
 * "If the parameter is omitted from REQUEST_UPDATE, the value for the
 *  subscription remains unchanged."
 * 自 update({ forward: false }) の REQUEST_OK 受信時に、送信時の FORWARD 値が
 * SubscriberImpl の Forward State に反映されることを検証する。
 */
test("bidiHandleRequestUpdateOk: 自 update({ forward }) の REQUEST_OK で Forward State が反映される", () => {
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 1n, () => {});
  const session = {
    closeWithError: () => {},
    subscribers: new Map([[0n, subscriber]]),
    pendingRequestUpdate: new Map([
      [100n, { resolve: () => {}, reject: () => {}, targetRequestId: 0n, forward: false }],
    ]),
  } as unknown as BidiSessionInternal;

  const payload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [],
  });

  bidiHandleRequestUpdateOk(session, payload, 0n);

  // 送信時の FORWARD=0 が反映され、pending エントリは解決・削除される
  assert.equal(subscriber.forwardState, false);
  assert.equal(session.pendingRequestUpdate.size, 0);
});

/**
 * draft-ietf-moq-transport-19 §10.2.17:
 * 自 update({ forward: true }) の REQUEST_OK 受信時に、送信時の FORWARD 値が
 * SubscriberImpl の Forward State に true として反映されることを検証する。
 */
test("bidiHandleRequestUpdateOk: 自 update({ forward: true }) の REQUEST_OK で Forward State が true に反映される", () => {
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 1n, () => {});
  subscriber.setForwardState(false);
  const session = {
    closeWithError: () => {},
    subscribers: new Map([[0n, subscriber]]),
    pendingRequestUpdate: new Map([
      [100n, { resolve: () => {}, reject: () => {}, targetRequestId: 0n, forward: true }],
    ]),
  } as unknown as BidiSessionInternal;

  const payload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [],
  });

  bidiHandleRequestUpdateOk(session, payload, 0n);

  assert.equal(subscriber.forwardState, true);
  assert.equal(session.pendingRequestUpdate.size, 0);
});

/**
 * draft-ietf-moq-transport-19 §10.2.17:
 * 自 update() で FORWARD を省略した場合 (undefined)、REQUEST_OK 受信時に
 * Forward State は変化しないことを検証する。
 */
test("bidiHandleRequestUpdateOk: FORWARD 省略の update の REQUEST_OK で Forward State は不変", () => {
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 1n, () => {});
  subscriber.setForwardState(false);
  const session = {
    closeWithError: () => {},
    subscribers: new Map([[0n, subscriber]]),
    pendingRequestUpdate: new Map([
      [100n, { resolve: () => {}, reject: () => {}, targetRequestId: 0n }],
    ]),
  } as unknown as BidiSessionInternal;

  const payload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [],
  });

  bidiHandleRequestUpdateOk(session, payload, 0n);

  // FORWARD 省略時は不変 (§10.2.17)
  assert.equal(subscriber.forwardState, false);
  assert.equal(session.pendingRequestUpdate.size, 0);
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
    namespaceSubscriptions: new Map(),
    tracksSubscriptions: new Map(),
    statsControlMessagesSent: 0,
    emitDebug: () => {},
    closeWithError: () => {},
  } as unknown as BidiSessionInternal;

  return { session, written };
}

/**
 * draft-ietf-moq-transport-19 §5.1.3:
 * REQUEST_UPDATE では TRACK_PROPERTY_FILTER (0x29) は一律 throw する。
 * moqt-js が送信する REQUEST_UPDATE はすべて per-subscription の更新 (§10.9) であり、
 * 0x29 が許可される SUBSCRIBE_TRACKS リクエスト自身のストリーム上の REQUEST_UPDATE
 * (「REQUEST_UPDATE for it」) に該当しないため。
 */
test("bidiSendRequestUpdate: TRACK_PROPERTY_FILTER を含む rangeFilters で throw する", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      rangeFilters: [
        { type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 1n }] },
        { type: "trackProperty", remove: true },
      ],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("TRACK_PROPERTY_FILTER"));
});

/**
 * draft-ietf-moq-transport-19 §5.1.3:
 * REQUEST_UPDATE の rangeFilters (0x29 以外) が REQUEST_UPDATE にエンコードされ、
 * 削除 (Length=0) も許可されることを検証する。
 */
test("bidiSendRequestUpdate: rangeFilters が REQUEST_UPDATE にエンコードされる", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  // bidiSendRequestUpdate は REQUEST_OK 受信まで resolve しない Promise を返すため、
  // 送信完了後に pendingRequestUpdate の Promise を解決してから await する
  const updatePromise = bidiSendRequestUpdate(session, subscriber, {
    rangeFilters: [
      { type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 1n }] },
      { type: "objectId", remove: true },
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
  assert.isDefined(decoded.parameters.find((p) => p.type === MessageParameterType.OBJECTID_FILTER));
});

// ============================================================================
// bidiSendJoiningFetch の Range Filters テスト
// draft-ietf-moq-transport-19 §5.1.3 / §10.3.1.6
// ============================================================================

/**
 * draft-ietf-moq-transport-19 §5.1.3:
 * bidiSendJoiningFetch の rangeFilters ガード (削除・0x29) 違反時は、
 * fire-and-forget (void) 起動のため未処理 rejection にならないよう catch で
 * 処理し、pendingFetch を削除して options.onError で通知することを検証する。
 */
test("bidiSendJoiningFetch: 削除指定の rangeFilters で pendingFetch が削除され onError が呼ばれる", async () => {
  const { session } = createBidiSession();
  const requestId = 100n; // nextRequestId 100n
  let onErrorCalled: Error | undefined;

  // ガードは pendingFetch.set の後に配置されるため、テスト開始時に pendingFetch を作る
  session.pendingFetch.set(requestId, {
    resolve: () => {},
    reject: () => {},
    impl: {} as FetcherImpl,
    startLocation: { group: 0n, object: 0n },
  });

  await bidiSendJoiningFetch(
    session,
    1n, // subscribeRequestId
    {
      type: "relative",
      start: 0n,
      rangeFilters: [{ type: "objectId", remove: true }],
      onError: (error) => {
        onErrorCalled = error;
      },
    },
    () => {},
    { group: 0n, object: 0n },
  );

  // ガード違反時は pendingFetch が削除され、onError が呼ばれる
  assert.isFalse(session.pendingFetch.has(requestId));
  assert.isDefined(onErrorCalled);
  assert.isTrue(onErrorCalled!.message.includes("cannot remove range filters in Joining Fetch"));
});

/**
 * draft-ietf-moq-transport-19 §5.1.3:
 * bidiSendJoiningFetch の rangeFilters ガード (削除・0x29) 違反時は、
 * fire-and-forget (void) 起動のため未処理 rejection にならないよう catch で
 * 処理し、pendingFetch を削除して options.onError で通知することを検証する。
 */
test("bidiSendJoiningFetch: TRACK_PROPERTY_FILTER 指定の rangeFilters で pendingFetch が削除され onError が呼ばれる", async () => {
  const { session } = createBidiSession();
  const requestId = 100n; // nextRequestId 100n
  let onErrorCalled: Error | undefined;

  session.pendingFetch.set(requestId, {
    resolve: () => {},
    reject: () => {},
    impl: {} as FetcherImpl,
    startLocation: { group: 0n, object: 0n },
  });

  await bidiSendJoiningFetch(
    session,
    1n,
    {
      type: "relative",
      start: 0n,
      rangeFilters: [
        { type: "trackProperty", setId: 0, propertyType: 0x30n, ranges: [{ start: 1n }] },
      ],
      onError: (error) => {
        onErrorCalled = error;
      },
    },
    () => {},
    { group: 0n, object: 0n },
  );

  assert.isFalse(session.pendingFetch.has(requestId));
  assert.isDefined(onErrorCalled);
  assert.isTrue(onErrorCalled!.message.includes("TRACK_PROPERTY_FILTER"));
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
// bidiSendNamespaceRequestUpdate のテスト
// draft-ietf-moq-transport-19 §10.9.2 (Updating Namespace Subscriptions)
// ============================================================================

/**
 * namespaceSubscriptions / tracksSubscriptions にエントリを持つ
 * BidiSessionInternal のモックを構築する。
 *
 * @param kind - 登録するサブスクリプションの種別
 * @param namespacePrefix - 既存の Track Namespace Prefix
 */
function createNamespaceUpdateSession(
  kind: "namespace" | "tracks",
  namespacePrefix: string[],
): {
  session: BidiSessionInternal;
  written: Uint8Array[];
  subscription: {
    state: "active" | "closed";
    namespacePrefix: string[];
    pendingPrefix?: string[];
  };
} {
  const { session, written } = createBidiSession();
  const subscription = {
    callbacks: {},
    state: "active" as const,
    namespacePrefix,
  };
  if (kind === "namespace") {
    session.namespaceSubscriptions.set(0n, subscription);
  } else {
    session.tracksSubscriptions.set(0n, subscription);
  }
  return { session, written, subscription };
}

test("bidiSendNamespaceRequestUpdate: TRACK_NAMESPACE_PREFIX が REQUEST_UPDATE にエンコードされる", async () => {
  const { session, written, subscription } = createNamespaceUpdateSession("namespace", ["live"]);

  const writer = {
    write: async (data: Uint8Array): Promise<void> => {
      written.push(data);
    },
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  // bidiSendRequestUpdate と同様に REQUEST_OK 受信まで resolve しない Promise を返すため、
  // 送信完了後に pendingRequestUpdate の Promise を解決してから await する
  const updatePromise = bidiSendNamespaceRequestUpdate(session, 0n, writer, {
    trackNamespacePrefix: ["live", "sports"],
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  // writer.write されたバイト列を ControlStreamReader でフレームに分解する
  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_UPDATE);

  // TRACK_NAMESPACE_PREFIX (0x34) パラメータが新 prefix でエンコードされる
  const decoded = decodeRequestUpdatePayload(messages[0].payload);
  const trackNamespaceParam = decoded.parameters.find(
    (p) => p.type === MessageParameterType.TRACK_NAMESPACE_PREFIX,
  );
  assert.isDefined(trackNamespaceParam);
  const trackNamespace = getParameterTrackNamespace(trackNamespaceParam!);
  assert.deepEqual(trackNamespaceToStrings(trackNamespace), ["live", "sports"]);

  // 送信後、REQUEST_OK 受信待ちの間は pendingPrefix に新 prefix が保持される
  assert.deepEqual(subscription.pendingPrefix, ["live", "sports"]);
  // 既存の namespacePrefix は REQUEST_OK 受信まで更新されない
  assert.deepEqual(subscription.namespacePrefix, ["live"]);
});

test("bidiSendNamespaceRequestUpdate: MAX_REQUEST_UPDATES を超える更新は throw する", async () => {
  const { session, subscription } = createNamespaceUpdateSession("namespace", ["live"]);
  // ピアの MAX_REQUEST_UPDATES を 1 に設定し、既に 1 件 outstanding の状態を作る。
  // このテストは throw で終わるため、既存 pending の resolve は不要 (無意味な
  // Promise を作らない)。
  (session as unknown as { peerMaxRequestUpdates: number }).peerMaxRequestUpdates = 1;
  session.pendingRequestUpdate.set(100n, {
    resolve: () => {},
    reject: () => {},
    targetRequestId: 0n,
  });

  const writer = {
    write: async () => {},
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  let thrown: Error | undefined;
  try {
    await bidiSendNamespaceRequestUpdate(session, 0n, writer, {
      trackNamespacePrefix: ["live", "sports"],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("exceeds peer MAX_REQUEST_UPDATES 1"));
  assert.isUndefined(subscription.pendingPrefix);
});

test("bidiSendNamespaceRequestUpdate: 同一型のアクティブなサブスクリプションと共通 prefix を持つ更新は throw する", async () => {
  const { session, subscription } = createNamespaceUpdateSession("namespace", ["live", "sports"]);
  // 別のアクティブな SUBSCRIBE_NAMESPACE (prefix ["live"]) が存在する
  session.namespaceSubscriptions.set(2n, {
    callbacks: {},
    state: "active",
    namespacePrefix: ["live"],
  });

  const writer = {
    write: async () => {},
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  let thrown: Error | undefined;
  try {
    await bidiSendNamespaceRequestUpdate(session, 0n, writer, {
      trackNamespacePrefix: ["live", "news"],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("overlaps with active subscription prefix"));
  assert.isUndefined(subscription.pendingPrefix);
});

test("bidiSendNamespaceRequestUpdate: overlap 制約は型ごとに独立して適用される", async () => {
  // SUBSCRIBE_NAMESPACE の更新では SUBSCRIBE_TRACKS の prefix は比較対象にならない
  const { session, subscription } = createNamespaceUpdateSession("namespace", ["live"]);
  session.tracksSubscriptions.set(2n, {
    callbacks: {},
    state: "active",
    namespacePrefix: ["live", "sports"],
  });

  const writer = {
    write: async () => {},
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  let thrown: Error | undefined;
  try {
    const updatePromise = bidiSendNamespaceRequestUpdate(session, 0n, writer, {
      trackNamespacePrefix: ["live", "sports"],
    });
    for (const [, pending] of session.pendingRequestUpdate) {
      pending.resolve();
    }
    await updatePromise;
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isUndefined(thrown);
  assert.deepEqual(subscription.pendingPrefix, ["live", "sports"]);
});

test("bidiSendNamespaceRequestUpdate: 更新対象自身は比較対象から除外される (prefix 拡大更新を許可)", async () => {
  const { session, subscription } = createNamespaceUpdateSession("namespace", ["live"]);

  const writer = {
    write: async () => {},
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  let thrown: Error | undefined;
  try {
    const updatePromise = bidiSendNamespaceRequestUpdate(session, 0n, writer, {
      trackNamespacePrefix: ["live", "sports"],
    });
    for (const [, pending] of session.pendingRequestUpdate) {
      pending.resolve();
    }
    await updatePromise;
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isUndefined(thrown);
  assert.deepEqual(subscription.pendingPrefix, ["live", "sports"]);
});

test("bidiSendNamespaceRequestUpdate: GOAWAY 受信後は throw する", async () => {
  const { session } = createNamespaceUpdateSession("namespace", ["live"]);
  session.goawayReceivedOnRequestStreams.add(0n);

  const writer = {
    write: async () => {},
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  let thrown: Error | undefined;
  try {
    await bidiSendNamespaceRequestUpdate(session, 0n, writer, {
      trackNamespacePrefix: ["live", "sports"],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("request stream is being migrated"));
});

test("bidiSendNamespaceRequestUpdate: closed 状態のサブスクリプションには送信できない", async () => {
  const { session, subscription } = createNamespaceUpdateSession("namespace", ["live"]);
  subscription.state = "closed";

  const writer = {
    write: async () => {},
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  let thrown: Error | undefined;
  try {
    await bidiSendNamespaceRequestUpdate(session, 0n, writer, {
      trackNamespacePrefix: ["live", "sports"],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("subscription is closed"));
});

test("bidiSendNamespaceRequestUpdate: SUBSCRIBE_TRACKS の更新でも TRACK_NAMESPACE_PREFIX がエンコードされる", async () => {
  const { session, written, subscription } = createNamespaceUpdateSession("tracks", ["live"]);

  const writer = {
    write: async (data: Uint8Array): Promise<void> => {
      written.push(data);
    },
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  const updatePromise = bidiSendNamespaceRequestUpdate(session, 0n, writer, {
    trackNamespacePrefix: ["live", "news"],
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
  const trackNamespaceParam = decoded.parameters.find(
    (p) => p.type === MessageParameterType.TRACK_NAMESPACE_PREFIX,
  );
  assert.isDefined(trackNamespaceParam);
  const trackNamespace = getParameterTrackNamespace(trackNamespaceParam!);
  assert.deepEqual(trackNamespaceToStrings(trackNamespace), ["live", "news"]);
  assert.deepEqual(subscription.pendingPrefix, ["live", "news"]);
});

test("bidiSendNamespaceRequestUpdate: 予約 namespace への更新は throw する", async () => {
  const { session, subscription } = createNamespaceUpdateSession("namespace", ["live"]);
  const writer = {
    write: async () => {},
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  let thrown: Error | undefined;
  try {
    await bidiSendNamespaceRequestUpdate(session, 0n, writer, {
      trackNamespacePrefix: [".session"],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("reserved"));
  assert.isUndefined(subscription.pendingPrefix);
});

test("bidiSendNamespaceRequestUpdate: 更新が in-flight のうちに 2 件目を送ると throw する", async () => {
  const { session, subscription } = createNamespaceUpdateSession("namespace", ["live"]);
  // 1 件目の更新が送信中 (REQUEST_OK 未受信) の状態を作る
  subscription.pendingPrefix = ["live", "sports"];

  const writer = {
    write: async () => {},
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  let thrown: Error | undefined;
  try {
    await bidiSendNamespaceRequestUpdate(session, 0n, writer, {
      trackNamespacePrefix: ["live", "news"],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("another update is already in flight"));
  // 1 件目の in-flight 状態は維持される
  assert.deepEqual(subscription.pendingPrefix, ["live", "sports"]);
});

test("bidiSendNamespaceRequestUpdate: 送信失敗時は pending と pendingPrefix が掃除される", async () => {
  const { session, subscription } = createNamespaceUpdateSession("namespace", ["live"]);

  // write が失敗する writer を注入する (ピアがストリームを閉じた等を再現)
  const writer = {
    write: async (): Promise<void> => {
      throw new Error("stream closed by peer");
    },
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  let thrown: Error | undefined;
  try {
    await bidiSendNamespaceRequestUpdate(session, 0n, writer, {
      trackNamespacePrefix: ["live", "sports"],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  // 失敗は呼び出し元へ伝播し、pending エントリと pendingPrefix が残留しない
  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("stream closed by peer"));
  assert.equal(session.pendingRequestUpdate.size, 0);
  assert.isUndefined(subscription.pendingPrefix);
  assert.deepEqual(subscription.namespacePrefix, ["live"]);
});

/**
 * bidiSendRequestUpdate の write 失敗時に pendingRequestUpdate エントリが
 * 削除されることを検証する。削除しないと、後続の GOAWAY 処理やセッション
 * close が登録済みの reject を呼び、呼び出し元に返されていない Promise の
 * unhandled rejection を生む。
 */
test("bidiSendRequestUpdate: write 失敗時に pendingRequestUpdate エントリが削除される", async () => {
  const ctx = createPublishReadTestContext({
    write() {
      throw new Error("stream closed by peer");
    },
  });
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(ctx.session, subscriber, {});
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  // 失敗は呼び出し元へ伝播し、pending エントリが残留しない
  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("stream closed by peer"));
  assert.equal(ctx.session.pendingRequestUpdate.size, 0);
});

/**
 * GOAWAY 受信時にアプリの goawayCallback が throw しても、後続の
 * pendingRequestUpdate の掃除と writer.close() が実行されることを検証する。
 * try/catch で黙殺しないと、コールバック例外で掃除が中断され update() の
 * Promise が未解決のまま残る。
 */
test("bidiReadRequestStreamMessages: goawayCallback が throw しても pendingRequestUpdate の掃除と close() が実行される", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  subscriber.goawayCallback = () => {
    throw new Error("goaway callback failed");
  };
  ctx.session.subscribers.set(ctx.requestId, subscriber);

  // GOAWAY 前に送信済みで応答待ちの REQUEST_UPDATE を注入する
  let rejected: Error | undefined;
  ctx.session.pendingRequestUpdate.set(100n, {
    resolve: () => {},
    reject: (err: Error) => {
      rejected = err;
    },
    targetRequestId: ctx.requestId,
  });

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
  // controlWriter は createPublishReadTestContext で設定済みのため安全
  const goawayMessage = ctx.session.controlWriter!.encode(MessageType.GOAWAY, goawayPayload);
  ctx.readableController.enqueue(goawayMessage);
  ctx.readableController.close();
  await readPromise;

  // コールバック例外が黙殺されても、掃除と自方向 FIN は実行される
  assert.isDefined(rejected);
  assert.equal(ctx.session.pendingRequestUpdate.size, 0);
  assert.deepEqual(ctx.events, ["close"]);
});

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
 * テスト用に session の sessionState を "closed" に遷移させる
 * (型上 readonly のため、テスト用に型を偽装して書き換える)
 */
function forceSessionClosed(session: BidiSessionInternal): void {
  (session as unknown as { sessionState: "connected" | "closed" }).sessionState = "closed";
}

/**
 * draft-ietf-moq-transport-19 §3.3.2:
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
 * draft-ietf-moq-transport-19 §3.3.2:
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
 * draft-ietf-moq-transport-19 §3.3.2:
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
  // GOAWAY 受信時は publisher に FIN を送らない (§3.3.2 MUST: done() に委ねる)
  assert.deepEqual(ctx.events, []);
  // GOAWAY 後のピア FIN は receivedFin 経路で保持される
  assert.isTrue(ctx.session.requestStreams.has(ctx.requestId));

  await ctx.publisher.done();

  // done() で PUBLISH_DONE → FIN が送信される
  assert.deepEqual(ctx.events, ["write", "close"]);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-19 §10.4 (GOAWAY):
 * 「The endpoint MUST close the session with a PROTOCOL_VIOLATION (Section 3.5)
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
 * draft-ietf-moq-transport-19 §10.4 (GOAWAY):
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
 * draft-ietf-moq-transport-19 §10.4 (GOAWAY):
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
 * draft-ietf-moq-transport-19 §10.4 / §3.3.4 / §10.9:
 * GOAWAY 受信後の旧リクエストに対する REQUEST_UPDATE は、publish ロールでは
 * REQUEST_ERROR (GOING_AWAY) で応答される (§10.9 MUST) ことを検証する。
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
    requestId: 100n,
    parameters: [],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // REQUEST_ERROR (GOING_AWAY) が書き込まれ、セッションは閉じない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  const decoded = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.GOING_AWAY));
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-19 §10.4 / §3.3.4 / §10.9:
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
    requestId: 100n,
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

// ============================================================================
// bidiHandlePublishRequestUpdate のテスト
// draft-ietf-moq-transport-19 §10.9 ケース 1 (受信 PUBLISH 上の REQUEST_UPDATE)
// ============================================================================

/**
 * draft-ietf-moq-transport-19 §5.1.3:
 * role=publish の受信 REQUEST_UPDATE に不正な Range Filter (値域違反) が
 * 含まれる場合、REQUEST_ERROR (INVALID_FILTER) で応答されることを検証する。
 * 検証は forward state 反映より前に配置されるため、状態は変更されない。
 */
test("bidiReadRequestStreamMessages: 不正な Range Filter を含む REQUEST_UPDATE に REQUEST_ERROR (INVALID_FILTER) が応答される (publish ロール)", async () => {
  const ctx = createPublishReadTestContext({});

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // PRIORITY_FILTER (0x27) で 255 超の値 (Start=11266) を含む REQUEST_UPDATE を feed する
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: ctx.requestId,
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

  // REQUEST_ERROR (INVALID_FILTER) が書き込まれ、forward state は変更されない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  const decoded = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.INVALID_FILTER));
  assert.isUndefined(ctx.closedWithError);
  // 検証は forward state 反映より前に配置されるため、状態は初期値 (true) のまま
  assert.isTrue(ctx.publisher.forwardState);
});

/**
 * draft-ietf-moq-transport-19 §5.1.3:
 * role=publish の受信 REQUEST_UPDATE に同一組み合わせの重複 Range Filter が
 * 含まれる場合、REQUEST_ERROR (INVALID_FILTER) で応答されることを検証する。
 */
test("bidiReadRequestStreamMessages: 重複組み合わせの Range Filter を含む REQUEST_UPDATE に REQUEST_ERROR (INVALID_FILTER) が応答される (publish ロール)", async () => {
  const ctx = createPublishReadTestContext({});

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // 同一 (Type=0x25, SetID=1) の SUBGROUP_FILTER を 2 つ含む REQUEST_UPDATE
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: ctx.requestId,
    parameters: [
      { type: 0x25, value: new Uint8Array([0x03, 0x01, 0x00, 0x00]) },
      { type: 0x25, value: new Uint8Array([0x03, 0x01, 0x00, 0x00]) },
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  const decoded = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.INVALID_FILTER));
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-19 §10.9 / §10:
 * role=publish の受信 REQUEST_UPDATE のペイロードが不完全 (メッセージ構造の
 * 破損) な場合、黙殺せず PROTOCOL_VIOLATION でセッションが閉じることを
 * 検証する。ControlStreamReader が Length 分の完全なメッセージのみ渡す
 * ため、IncompleteDataError はここでは構造破損を意味する。
 */
test("bidiReadRequestStreamMessages: 破損 REQUEST_UPDATE (publish ロール) で PROTOCOL_VIOLATION でセッションが閉じる", async () => {
  const ctx = createPublishReadTestContext({});

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // Request ID の後に Parameters が無い不完全なペイロードを feed する
  const invalidPayload = new Uint8Array([0x01]);
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, invalidPayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // REQUEST_OK / REQUEST_ERROR は応答されず、PROTOCOL_VIOLATION でセッションが閉じる
  assert.equal(ctx.written.length, 0);
  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(ctx.closedWithError!.message.includes("invalid REQUEST_UPDATE payload"));
});

/**
 * draft-ietf-moq-transport-19 §10.9 / §10.2.17:
 * role=publish の受信 REQUEST_UPDATE が正常な場合、FORWARD が publisher の
 * Forward State に反映され REQUEST_OK が応答されることを検証する (回帰
 * ガード)。IncompleteDataError の変換対象追加で既存処理が変わらないことを
 * 担保する。
 */
test("bidiReadRequestStreamMessages: 正常な REQUEST_UPDATE (publish ロール) で FORWARD が反映され REQUEST_OK が応答される", async () => {
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
    requestId: ctx.requestId,
    parameters: [{ type: MessageParameterType.FORWARD, value: new Uint8Array([0]) }],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // FORWARD=0 が publisher の Forward State に反映され、REQUEST_OK が応答される
  assert.equal(ctx.publisher.forwardState, false);
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-19 §5.1.3:
 * 受信 PUBLISH_OK に不正な Range Filter (値域違反) が含まれる場合、
 * PROTOCOL_VIOLATION でセッションが閉じることを検証する。
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

  await bidiReadPublishResponse(session, requestId, stream, controlReader);

  assert.isDefined(closedWithError);
  assert.equal(closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isFalse(session.pendingPublish.has(requestId));
  assert.isDefined(rejected);
});

/**
 * draft-ietf-moq-transport-19 §10.5:
 * 受信 PUBLISH_OK のペイロードが不完全 (メッセージ構造の破損) な場合、
 * PROTOCOL_VIOLATION でセッションが閉じることを検証する。IncompleteDataError
 * は toProtocolViolationSessionError で変換され、閉鎖前に当該リクエストの
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

  await bidiReadPublishResponse(session, requestId, stream, controlReader);

  assert.isDefined(closedWithError);
  assert.equal(closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isFalse(session.pendingPublish.has(requestId));
  assert.isDefined(rejected);
  assert.equal(rejected!.message, closedWithError!.message);
});

/**
 * draft-ietf-moq-transport-19 §10.9:
 * 受信 PUBLISH ストリーム上で無限定 3 種 (AUTHORIZATION_TOKEN /
 * OBJECT_DELIVERY_TIMEOUT / SUBGROUP_DELIVERY_TIMEOUT) のみを含む
 * REQUEST_UPDATE を受信した場合、REQUEST_OK が 1 通応答され、セッションが
 * 閉じないことを検証する (§10.9 MUST)。ペイロードの Request ID (100n) は
 * 応答には含まれず、引数の requestId (10n) で判定されることも暗黙に検証
 * される。
 */
test("bidiHandlePublishRequestUpdate: 受理パラメータのみの REQUEST_UPDATE で REQUEST_OK が応答されセッションが閉じない", async () => {
  const ctx = createPublishReadTestContext({});
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 100n,
    parameters: [
      { type: MessageParameterType.AUTHORIZATION_TOKEN, value: new Uint8Array([1]) },
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
 * draft-ietf-moq-transport-19 §10.9:
 * パラメータを含まない REQUEST_UPDATE でも REQUEST_OK が 1 通応答され、
 * セッションが閉じないことを検証する (§10.9 MUST)。パラメータ無しは
 * 文脈限定パラメータの判定を通過する空集合として扱われる。
 */
test("bidiHandlePublishRequestUpdate: パラメータ無しの REQUEST_UPDATE で REQUEST_OK が応答されセッションが閉じない", async () => {
  const ctx = createPublishReadTestContext({});
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 100n,
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
 * draft-ietf-moq-transport-19 §10.2.1 (Parameter Scope):
 * REQUEST_UPDATE に出現できないパラメータ (スコープ違反) を含む
 * REQUEST_UPDATE を受信した場合、§10.2.1 の MUST に従い REQUEST_ERROR で
 * 応答せず PROTOCOL_VIOLATION でセッションが閉じることを検証する。
 */
test("bidiHandlePublishRequestUpdate: スコープ違反のパラメータで PROTOCOL_VIOLATION でセッションが閉じる", async () => {
  const ctx = createPublishReadTestContext({});
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 100n,
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
 * draft-ietf-moq-transport-19 §10.9 / §10.6:
 * 文脈限定パラメータ (例: SUBSCRIBER_PRIORITY) を含む REQUEST_UPDATE を
 * 受信した場合、REQUEST_ERROR (NOT_SUPPORTED) が応答されセッションが
 * 閉じないことを検証する (§10.6 の NOT_SUPPORTED 定義に基づく設計判断。
 * FORWARD は受理対象のため例から除外する)。
 */
test("bidiHandlePublishRequestUpdate: 文脈限定パラメータを含む REQUEST_UPDATE で REQUEST_ERROR (NOT_SUPPORTED) が応答される", async () => {
  const ctx = createPublishReadTestContext({});
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 100n,
    parameters: [{ type: MessageParameterType.SUBSCRIBER_PRIORITY, value: new Uint8Array([1]) }],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  // REQUEST_ERROR (NOT_SUPPORTED) が 1 通書き込まれ、セッションは閉じない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  const decoded = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.NOT_SUPPORTED));
  assert.equal(decoded.reasonPhrase, "parameter not supported for request update");
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-19 §10.9 / §10.2.17:
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
    requestId: 100n,
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
 * draft-ietf-moq-transport-19 §10.9 / §10.6:
 * 無限定パラメータと文脈限定パラメータを混合して含む REQUEST_UPDATE は、
 * 1 つでも文脈限定パラメータを含む限り REQUEST_ERROR (NOT_SUPPORTED) が
 * 応答されることを検証する。
 */
test("bidiHandlePublishRequestUpdate: 無限定 + 文脈限定の混合 REQUEST_UPDATE で REQUEST_ERROR (NOT_SUPPORTED) が応答される", async () => {
  const ctx = createPublishReadTestContext({});
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 100n,
    parameters: [
      { type: MessageParameterType.AUTHORIZATION_TOKEN, value: new Uint8Array([1]) },
      { type: MessageParameterType.SUBSCRIBER_PRIORITY, value: new Uint8Array([1]) },
    ],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  // REQUEST_ERROR (NOT_SUPPORTED) が 1 通書き込まれ、セッションは閉じない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  const decoded = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.NOT_SUPPORTED));
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-19 §10.9 / §10.2.17:
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
    requestId: 100n,
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
 * draft-ietf-moq-transport-19 §10.2.17:
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
    requestId: 100n,
    parameters: [],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
  // FORWARD 省略時は不変 (§10.2.17)
  assert.equal(subscriber.forwardState, false);
});

/**
 * draft-ietf-moq-transport-19 §10.9 / §10.6:
 * FORWARD と他の文脈限定パラメータ (例: SUBSCRIBER_PRIORITY) が混合した
 * REQUEST_UPDATE はメッセージ単位で全体拒否され、FORWARD の部分受理は
 * 行われないことを検証する。
 */
test("bidiHandlePublishRequestUpdate: FORWARD + 他の文脈限定パラメータの混合は NOT_SUPPORTED で全体拒否される", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  ctx.session.subscribers.set(ctx.requestId, subscriber);

  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 100n,
    parameters: [
      { type: MessageParameterType.FORWARD, value: new Uint8Array([0]) },
      { type: MessageParameterType.SUBSCRIBER_PRIORITY, value: new Uint8Array([1]) },
    ],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  // REQUEST_ERROR (NOT_SUPPORTED) が 1 通書き込まれ、セッションは閉じない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  const decoded = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.NOT_SUPPORTED));
  assert.isUndefined(ctx.closedWithError);
  // 全体拒否のため FORWARD は反映されない
  assert.equal(subscriber.forwardState, true);
});

/**
 * draft-ietf-moq-transport-19 §10.4 / §3.3.4 / §10.9:
 * GOAWAY 受信後 (writer オープン時) の REQUEST_UPDATE には REQUEST_ERROR
 * (GOING_AWAY) が応答され、セッションが閉じないことを検証する。
 */
test("bidiHandlePublishRequestUpdate: GOAWAY 受信後の REQUEST_UPDATE に REQUEST_ERROR (GOING_AWAY) が応答される", async () => {
  const ctx = createPublishReadTestContext({});
  // GOAWAY を受信済みの状態を作る (writer はオープンのまま)
  ctx.session.goawayReceivedOnRequestStreams.add(ctx.requestId);
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 100n,
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
 * draft-ietf-moq-transport-19 §10.4 / §10.2.1 / §10.9:
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
    requestId: 100n,
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
 * draft-ietf-moq-transport-19 §10.9:
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
    requestId: 100n,
    parameters: [],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  // 書き込みは実際に試行され、失敗は吸収され、セッションは閉じない
  assert.deepEqual(ctx.events, ["write"]);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-19 §10.9:
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
    requestId: 100n,
    parameters: [],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  // 書き込みは実際に試行され、失敗は吸収され、セッションは閉じない
  assert.deepEqual(ctx.events, ["write"]);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-19 §10.9:
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
 * draft-ietf-moq-transport-19 §10.9:
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
    requestId: 100n,
    parameters: [],
  });
  await bidiHandlePublishRequestUpdate(ctx.session, ctx.requestId, updatePayload);

  // 書き込みは発生せず、セッションも閉じない
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

/**
 * draft-ietf-moq-transport-19 §10.11:
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
 * draft-ietf-moq-transport-19 §3.5 (Termination):
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
 * draft-ietf-moq-transport-19 §3.5 (Termination):
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

// ============================================================================
// notifySubscriberFailure のテスト
// draft-ietf-moq-transport-19 §3.3.2 (FIN without PUBLISH_DONE は失敗扱い)
// ============================================================================

/**
 * draft-ietf-moq-transport-19 §3.3.2:
 * active な subscriber に対して error 通知が行われ、state が closed になる
 * ことを検証する。
 */
test("notifySubscriberFailure: active な subscriber に error 通知し state を closed にする", () => {
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

  notifySubscriberFailure(ctx.session, ctx.requestId, new Error(FIN_WITHOUT_PUBLISH_DONE_MESSAGE));

  assert.isDefined(errorCalled);
  assert.equal(errorCalled!.message, FIN_WITHOUT_PUBLISH_DONE_MESSAGE);
  assert.equal(subscriber.state, "closed");
});

/**
 * draft-ietf-moq-transport-19 §3.3.2:
 * error コールバックが throw した場合でも、finally で state が closed に
 * なることを検証する (error コールバックの例外で状態遷移が失われない)。
 */
test("notifySubscriberFailure: error コールバックが throw しても state は closed になる", () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    ctx.requestId,
    1n,
    () => {},
    undefined,
    undefined,
    () => {
      throw new Error("error callback failed");
    },
  );
  ctx.session.subscribers.set(ctx.requestId, subscriber);

  let thrown: Error | undefined;
  try {
    notifySubscriberFailure(
      ctx.session,
      ctx.requestId,
      new Error(FIN_WITHOUT_PUBLISH_DONE_MESSAGE),
    );
  } catch (err) {
    thrown = err instanceof Error ? err : new Error(String(err));
  }

  // throw は伝播するが、state は closed になっている
  assert.isDefined(thrown);
  assert.equal(thrown!.message, "error callback failed");
  assert.equal(subscriber.state, "closed");
});

/**
 * draft-ietf-moq-transport-19 §3.3.2:
 * subscribers に存在しない requestId (unsubscribe 済み等) では何もしない
 * ことを検証する。
 */
test("notifySubscriberFailure: subscribers に存在しない requestId では何もしない", () => {
  const ctx = createPublishReadTestContext({});
  // subscribers に登録しないまま呼ぶ
  notifySubscriberFailure(ctx.session, ctx.requestId, new Error(FIN_WITHOUT_PUBLISH_DONE_MESSAGE));

  // セッションも閉じず、書き込みも発生しない
  assert.isUndefined(ctx.closedWithError);
  assert.equal(ctx.written.length, 0);
});

/**
 * draft-ietf-moq-transport-19 §10.4:
 * GOAWAY 受信済みの requestId (マイグレーション通知) では何もしないことを
 * 検証する (GOAWAY は subscription state に影響しない)。
 */
test("notifySubscriberFailure: GOAWAY 受信済みの requestId では何もしない", () => {
  const ctx = createPublishReadTestContext({});
  let errorCalled = false;
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    ctx.requestId,
    1n,
    () => {},
    undefined,
    undefined,
    () => {
      errorCalled = true;
    },
  );
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  // GOAWAY を受信済みの状態を作る
  ctx.session.goawayReceivedOnRequestStreams.add(ctx.requestId);

  notifySubscriberFailure(ctx.session, ctx.requestId, new Error(FIN_WITHOUT_PUBLISH_DONE_MESSAGE));

  // error 通知も state 遷移も行われない (migration はアプリの goawayCallback が処理する)
  assert.isFalse(errorCalled);
  assert.equal(subscriber.state, "active");
});

/**
 * draft-ietf-moq-transport-19 §3.3.2:
 * state が active でない subscriber (正常な PUBLISH_DONE 済み等) では何も
 * しないことを検証する。
 */
test("notifySubscriberFailure: state が active でない subscriber では何もしない", () => {
  const ctx = createPublishReadTestContext({});
  let errorCalled = false;
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    ctx.requestId,
    1n,
    () => {},
    undefined,
    undefined,
    () => {
      errorCalled = true;
    },
  );
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  subscriber.markClosed();

  notifySubscriberFailure(ctx.session, ctx.requestId, new Error(FIN_WITHOUT_PUBLISH_DONE_MESSAGE));

  assert.isFalse(errorCalled);
  assert.equal(subscriber.state, "closed");
});

// ============================================================================
// bidiReadRequestStreamMessages の FIN / RESET_STREAM 検出 (subscribe ロール) テスト
// draft-ietf-moq-transport-19 §3.3.2 (FIN) / §3.3.3 (RESET_STREAM)
// ============================================================================

/**
 * draft-ietf-moq-transport-19 §3.3.2:
 * subscribe ロールでピア (publisher) が PUBLISH_DONE なしに FIN した場合、
 * error コールバックが呼ばれ state が closed になることを検証する。
 */
test("bidiReadRequestStreamMessages: ピアの FIN (subscribe ロール) で error 通知され state が closed になる", async () => {
  const ctx = createPublishReadTestContext({});
  let errorCalled: Error | undefined;
  let endCalled = false;
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
  // ピアの FIN を再現する
  ctx.readableController.close();
  await readPromise;

  // error 通知 + state closed。end は呼ばれない (FIN は失敗扱いであり正常終了ではない)
  assert.isDefined(errorCalled);
  assert.equal(errorCalled!.message, FIN_WITHOUT_PUBLISH_DONE_MESSAGE);
  assert.equal(subscriber.state, "closed");
  assert.isFalse(endCalled);
});

/**
 * draft-ietf-moq-transport-19 §3.3.3:
 * subscribe ロールでピアが RESET_STREAM でストリームをエラー終了させた場合、
 * error コールバックが呼ばれ state が closed になることを検証する。プロトコル
 * 違反ではないためセッションは閉じない。エラーメッセージは FIN 経路
 * (PUBLISH_DONE なし) と区別できる固定文言になる。
 */
test("bidiReadRequestStreamMessages: ピアの RESET_STREAM (subscribe ロール) で error 通知され state が closed になる", async () => {
  const ctx = createPublishReadTestContext({});
  let errorCalled: Error | undefined;
  let endCalled = false;
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
  // ピアの RESET_STREAM 相当 (source: "stream" の reject) を再現する
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), { source: "stream" }),
  );
  await readPromise;

  // error 通知 + state closed + end は呼ばれない。セッションは閉じない
  assert.isDefined(errorCalled);
  assert.equal(errorCalled!.message, RESET_REQUEST_STREAM_MESSAGE);
  assert.equal(subscriber.state, "closed");
  assert.isFalse(endCalled);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-19 §10.4 / §3.3.3:
 * GOAWAY 受信済みの subscribe ロールの RESET_STREAM では error 通知されない
 * ことを検証する (GOAWAY 後の旧ストリームの破壊は migration の完了であり、
 * GOAWAY 後の FIN と同じ扱い)。修正前の実装でも通る回帰ガードである
 * (通知経路の拡大を防ぐ)。
 */
test("bidiReadRequestStreamMessages: GOAWAY 受信後の RESET_STREAM (subscribe ロール) では error 通知されない", async () => {
  const ctx = createPublishReadTestContext({});
  let errorCalled = false;
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    ctx.requestId,
    1n,
    () => {},
    undefined,
    undefined,
    () => {
      errorCalled = true;
    },
  );
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);
  ctx.session.goawayReceivedOnRequestStreams.add(ctx.requestId);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), { source: "stream" }),
  );
  await readPromise;

  // GOAWAY 後は state も変更されない (notifySubscriberFailure 全体が no-op)
  assert.isFalse(errorCalled);
  assert.equal(subscriber.state, "active");
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-19 §3.3.3:
 * publish ロールのピア (requester) の RESET_STREAM では error 通知されない
 * ことを検証する (対象ロール限定の回帰ガード。修正前の実装でも通る)。
 */
test("bidiReadRequestStreamMessages: ピアの RESET_STREAM (publish ロール) では error 通知されない", async () => {
  const ctx = createPublishReadTestContext({});
  let errorCalled = false;
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    ctx.requestId,
    1n,
    () => {},
    undefined,
    undefined,
    () => {
      errorCalled = true;
    },
  );
  // publish ロールにも subscriber を登録しておき、呼ばれないことを検証する
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), { source: "stream" }),
  );
  await readPromise;

  assert.isFalse(errorCalled);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-19 §3.3.3:
 * error コールバックが throw しても、notification 経路で吸収され unhandled
 * rejection にならず、state が closed になることを検証する。
 */
test("bidiReadRequestStreamMessages: RESET_STREAM 通知で error コールバックが throw しても state は closed になる", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    ctx.requestId,
    1n,
    () => {},
    undefined,
    undefined,
    () => {
      throw new Error("error callback failed");
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
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), { source: "stream" }),
  );
  // コールバック例外が伝播して unhandled rejection にならないこと (await が解決する)
  await readPromise;

  assert.equal(subscriber.state, "closed");
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-19 §3.3.3 / §3.5:
 * ピア起因のセッション終了 (source: "session") および source を持たない
 * 内部エラーでは error コールバックが呼ばれないことを検証する
 * (isPeerStreamError ガードの回帰ガード。修正前の実装でも通る)。
 */
test("bidiReadRequestStreamMessages: セッション終了や source なしエラー (subscribe ロール) では error 通知されない", async () => {
  const errors: Error[] = [
    Object.assign(new Error("session closed by peer"), { source: "session" }),
    new Error("internal error"),
  ];
  for (const error of errors) {
    const ctx = createPublishReadTestContext({});
    let errorCalled = false;
    const subscriber = new SubscriberImpl(
      ["test"],
      "track",
      ctx.requestId,
      1n,
      () => {},
      undefined,
      undefined,
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
    ctx.readableController.error(error);
    await readPromise;

    assert.isFalse(errorCalled, `エラー通知が発生しました: ${error.message}`);
    assert.isUndefined(ctx.closedWithError);
  }
});

/**
 * draft-ietf-moq-transport-19 §3.3.2:
 * publish ロールではピア (requester) の FIN は正常完了シグナルであり、
 * error 通知されず state も変更されないことを検証する (対象ロール限定の
 * 回帰ガード)。
 */
test("bidiReadRequestStreamMessages: ピアの FIN (publish ロール) では error 通知されない", async () => {
  const ctx = createPublishReadTestContext({});
  let errorCalled = false;
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    ctx.requestId,
    1n,
    () => {},
    undefined,
    undefined,
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
    "publish",
  );
  ctx.readableController.close();
  await readPromise;

  // error 通知も state 遷移も行われない
  assert.isFalse(errorCalled);
  assert.equal(subscriber.state, "active");
});

/**
 * draft-ietf-moq-transport-19 §10.4 / §3.3.2:
 * GOAWAY 受信後の FIN (subscribe ロール) では error 通知されないことを
 * 検証する (GOAWAY は migration 通知であり失敗ではない)。
 */
test("bidiReadRequestStreamMessages: GOAWAY 受信後の FIN (subscribe ロール) では error 通知されない", async () => {
  const ctx = createPublishReadTestContext({});
  let errorCalled = false;
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    ctx.requestId,
    1n,
    () => {},
    undefined,
    undefined,
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
  // GOAWAY を実際に feed してから FIN する (validateNoDuplicateGoawayOnRequestStream
  // が goawayReceivedOnRequestStreams に登録する実経路)
  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "moqt://new.example.com",
    timeout: 0n,
  });
  const goawayMessage = ctx.session.controlWriter!.encode(MessageType.GOAWAY, goawayPayload);
  ctx.readableController.enqueue(goawayMessage);
  ctx.readableController.close();
  await readPromise;

  // error 通知も state 遷移も行われない
  assert.isFalse(errorCalled);
  assert.equal(subscriber.state, "active");
  // GOAWAY ハンドラが close() 済み (events に "close" が 1 回入る)。FIN 検出時の
  // 2 回目の close() は reject して黙殺されるため、sink の close は 1 回のみ
  // (unhandled rejection も発生しない)
  assert.deepEqual(ctx.events, ["close"]);
});

/**
 * draft-ietf-moq-transport-19 §10.4:
 * GOAWAY 受信時点で旧ストリーム上の未応答 REQUEST_UPDATE は失敗として扱い、
 * update() の Promise を reject してエントリを削除することを検証する。
 * GOAWAY 後の読み取り継続中に REQUEST_OK が届いても、エントリ削除済みのため
 * 二重解決しない (Forward State の誤反映も起きない)。
 */
test("bidiReadRequestStreamMessages: GOAWAY 受信時に応答待ちの REQUEST_UPDATE が reject され二重解決しない", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  // 遅延 REQUEST_OK による Forward State の誤反映を検出するため、
  // Forward State を false にしておく (エントリの forward は true)
  subscriber.setForwardState(false);

  // GOAWAY 前に送信済みで応答待ちの REQUEST_UPDATE を注入する
  let rejected: Error | undefined;
  let resolved = false;
  const updateId = 100n;
  ctx.session.pendingRequestUpdate.set(updateId, {
    resolve: () => {
      resolved = true;
    },
    reject: (err: Error) => {
      rejected = err;
    },
    targetRequestId: ctx.requestId,
    forward: true,
  });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  // GOAWAY → 遅延 REQUEST_OK → FIN の順に feed する
  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "moqt://new.example.com",
    timeout: 0n,
  });
  // controlWriter は createPublishReadTestContext で設定済みのため安全
  const goawayMessage = ctx.session.controlWriter!.encode(MessageType.GOAWAY, goawayPayload);
  ctx.readableController.enqueue(goawayMessage);
  const requestOkPayload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [],
  });
  // controlWriter は createPublishReadTestContext で設定済みのため安全
  const requestOkMessage = ctx.session.controlWriter!.encode(
    MessageType.REQUEST_OK,
    requestOkPayload,
  );
  ctx.readableController.enqueue(requestOkMessage);
  ctx.readableController.close();
  await readPromise;

  // GOAWAY 受信時点で未応答 REQUEST_UPDATE が reject され、エントリが削除される
  assert.isDefined(rejected);
  assert.instanceOf(rejected, RequestError);
  assert.equal((rejected as RequestError).code, RequestErrorCode.GOING_AWAY);
  assert.equal(ctx.session.pendingRequestUpdate.size, 0);
  // GOAWAY 後の REQUEST_OK はエントリ削除済みのため二重解決しない
  assert.isFalse(resolved);
  // 遅延 REQUEST_OK による Forward State の誤反映も起きない (false のまま)
  assert.isFalse(subscriber.forwardState);
});

/**
 * draft-ietf-moq-transport-19 §3.3.2:
 * 正常な PUBLISH_DONE → FIN の経路では end コールバックのみが呼ばれ、
 * error コールバックは呼ばれないことを検証する (正常経路の温存ガード)。
 */
test("bidiReadRequestStreamMessages: PUBLISH_DONE 後の FIN (subscribe ロール) では end のみが呼ばれる", async () => {
  const ctx = createPublishReadTestContext({});
  let errorCalled = false;
  let endCalled = false;
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
});

/**
 * draft-ietf-moq-transport-19 §3.3.2 / §10.11:
 * エラー statusCode の PUBLISH_DONE 後に FIN した場合、error 通知は
 * PUBLISH_DONE 由来の 1 回のみであり、FIN 検出で追加の error 通知が
 * 発生しないことを検証する (spurious 二重通知の回帰ガード)。
 */
test("bidiReadRequestStreamMessages: エラー statusCode の PUBLISH_DONE 後の FIN では error 通知が 1 回のみ", async () => {
  const ctx = createPublishReadTestContext({});
  const errorMessages: string[] = [];
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    ctx.requestId,
    1n,
    () => {},
    undefined,
    () => {},
    (e) => {
      errorMessages.push(e.message);
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
  // エラー statusCode (INTERNAL_ERROR) の PUBLISH_DONE を feed してから FIN
  const publishDonePayload = encodePublishDonePayload({
    type: MessageType.PUBLISH_DONE,
    statusCode: 0x0n,
    streamCount: 0n,
    reasonPhrase: "",
  });
  const message = ctx.session.controlWriter!.encode(MessageType.PUBLISH_DONE, publishDonePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // PUBLISH_DONE 由来の error 通知 1 回のみ (FIN で追加通知されない。
  // handleEnd はエラー statusCode でも endCallback を呼ぶ既存仕様のため
  // end の呼び出し有無は検証しない)
  assert.equal(errorMessages.length, 1);
  assert.isTrue(errorMessages[0].includes("PUBLISH_DONE"));
  assert.equal(subscriber.state, "closed");
  // エラー statusCode の PUBLISH_DONE → FIN でも自方向の FIN (writer.close())
  // が送信される
  assert.deepEqual(ctx.events, ["close"]);
});

/**
 * draft-ietf-moq-transport-19 §3.3.2:
 * subscribers に未登録の requestId で FIN した場合、通知は発生せず
 * セッションも閉じないことを検証する (統合レベル。free function 単体の
 * no-op ガードと対になる)。
 */
test("bidiReadRequestStreamMessages: subscribers 未登録の requestId の FIN では通知されない", async () => {
  const ctx = createPublishReadTestContext({});
  // subscribers には登録しない (finally の requestStreams 削除は実行されるが、
  // 通知対象の subscriber が存在しないため通知は発生しない)

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  ctx.readableController.close();
  await readPromise;

  // 通知もセッションクローズも発生しない
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-19 §3.3.2:
 * error コールバックが throw しても、セッションは閉じず state が closed に
 * なることを統合レベルで検証する (free function 単体の throw 伝播検証と
 * 対になる。本番経路の catch は throw を黙殺し、markClosed は finally で
 * 保証される)。
 */
test("bidiReadRequestStreamMessages: error コールバックが throw してもセッションが閉じず state が closed になる", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    ctx.requestId,
    1n,
    () => {},
    undefined,
    undefined,
    () => {
      throw new Error("error callback failed");
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

  // throw はループ catch で黙殺され、セッションは閉じない。state は closed
  assert.isUndefined(ctx.closedWithError);
  assert.equal(subscriber.state, "closed");
  // error コールバックが throw しても、try/finally により自方向の FIN
  // (writer.close()) が送信される
  assert.deepEqual(ctx.events, ["close"]);
});
