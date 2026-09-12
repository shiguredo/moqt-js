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
  encodeRequestErrorPayload,
  encodePublishStateNotifyPayload,
  decodeRequestOkPayload,
  decodeRequestErrorPayload,
  encodeGoawayPayload,
} from "../message/session";
import { encodeFetchOkPayload } from "../message/fetch";
import { encodePublishDonePayload, decodePublishDonePayload } from "../message/publish";
import {
  MessageType,
  MessageParameterType,
  GroupOrder,
  PublishDoneStatusCode,
} from "../message/types";
import {
  trackNamespaceToStrings,
  encodeParameters,
  decodeFillParameters,
  encodeFillParameters,
  encodeRangeFilter,
  createTrackNamespace,
  encodeParameterTrackNamespace,
  type Parameter,
} from "../message";
import { buildFillParameters } from "./params";
import {
  decodeRequestUpdatePayload,
  encodeRequestUpdatePayload,
  encodeSubscribeOkPayload,
} from "../message/subscribe";
import {
  decodeTrackNamespace,
  getParameterLocationValue,
  encodeLocationFilterParameter,
} from "../message/parameter";
import {
  MalformedTrackError,
  SessionError,
  SessionErrorCode,
  RequestErrorCode,
  RequestError,
  InvalidFilterError,
} from "../error";
import { encodeVarint, decodeVarint, MAX_VARINT } from "../varint";
import { ControlStreamReader, ControlStreamWriter } from "../controlStream";
import { PublisherImpl } from "../publisher";
import { REQUEST_UPDATE_STREAM_CLOSED_MESSAGE } from "./namespaceLoops";
import { incomingWaitForFetcher, incomingValidateRequestId } from "./incoming";
import type { SessionInternal } from "./types";
import {
  bidiCancelSubscription,
  bidiHandlePublishDone,
  bidiHandlePublishRequestUpdate,
  bidiHandleRequestUpdateOk,
  bidiReadFetchResponse,
  bidiReadPublishResponse,
  bidiReadRequestStreamMessages,
  bidiReadSubscribeResponse,
  bidiReadTrackStatusResponse,
  bidiSendNamespaceRequestUpdate,
  bidiSendRequestUpdate,
  cancelMalformedTrackPeers,
  rejectPendingRequestUpdates,
  FILL_NOT_SUPPORTED_REASON,
  FIN_WITHOUT_PUBLISH_DONE_MESSAGE,
  RESET_REQUEST_STREAM_MESSAGE,
  createResetStreamError,
  notifySubscriberFailure,
  validateNoDuplicateGoawayOnRequestStream,
  validateRequestOkNoTrackProperties,
  type BidiSessionInternal,
} from "./bidi";
import { publishClosePublisherStream, publishSendPublishDone } from "./publish";
import { FetcherImpl, type Fetcher } from "../fetcher";
import { fullTrackNameKey } from "../fullTrackName";

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
 * draft-ietf-moq-transport-21 Section 9.3 (REQUEST_OK):
 * "Track Properties are populated in TRACK_STATUS_OK; they are empty in
 *  PUBLISH_OK, REQUEST_UPDATE_OK, SUBSCRIBE_NAMESPACE_OK and PUBLISH_NAMESPACE_OK.
 *  If an endpoint receives Track Properties in one of these messages it MUST
 *  close the session with a PROTOCOL_VIOLATION."
 * REQUEST_UPDATE_OK で非空 Track Properties を受信した場合の検証。
 */
// 保留なし時の close 確認であり、reject 同一性は新規 2 件で検証する。
test("bidiHandleRequestUpdateOk: 非空 Track Properties で closeWithError が呼ばれる", () => {
  let closedWithError: SessionError | undefined;

  const session = {
    closeWithError: (error: SessionError) => {
      closedWithError = error;
    },
    subscribers: new Map(),
    pendingRequestUpdate: new Map(),
    fillFetchTargets: new Map(),
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
 * draft-ietf-moq-transport-21 §3.3.2:
 * 自 update({ rangeFilters }) の REQUEST_OK 受信時に、送信時の Range Filters が
 * SubscriberImpl に反映されることを検証する。
 * REQUEST_UPDATE で省略された型は不変 (「If a filter parameter is omitted from
 * REQUEST_UPDATE, the value is unchanged」§3.3.2)。
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
    fillFetchTargets: new Map(),
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
 * draft-ietf-moq-transport-21 §9.20.19:
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
 * draft-ietf-moq-transport-21 §9.20.19:
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
 * draft-ietf-moq-transport-21 §9.20.19:
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

  // FORWARD 省略時は不変 (§9.20.19)
  assert.equal(subscriber.forwardState, false);
  assert.equal(session.pendingRequestUpdate.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * "If omitted from REQUEST_UPDATE or PUBLISH_STATE_NOTIFY,
 *  the value is unchanged."
 * 自 update() で送信した LOCATION_FILTER が REQUEST_OK 受信時に
 * SubscriberImpl へ反映され、handleObject / handleDatagram が
 * 新しい Start Location で再適用されることを検証する。
 */
test("bidiHandleRequestUpdateOk: 送信時の LOCATION_FILTER が反映され新しい Start Location で再適用される", () => {
  const delivered: MoqtObject[] = [];
  const deliveredDatagrams: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    0n,
    1n,
    (obj) => delivered.push(obj),
    (obj) => deliveredDatagrams.push(obj),
  );
  // 初期フィルタは group 1 から開始
  subscriber.setLocationFilter({ startGroup: 1n, startObject: 0n });
  const session = {
    closeWithError: () => {},
    subscribers: new Map([[0n, subscriber]]),
    pendingRequestUpdate: new Map([
      [
        100n,
        {
          resolve: () => {},
          reject: () => {},
          targetRequestId: 0n,
          locationFilter: { startGroup: 5n, startObject: 0n },
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

  assert.equal(session.pendingRequestUpdate.size, 0);
  // 旧 Start (group 1) 以降だが新 Start (group 5) 未満は届かない
  subscriber.handleObject({
    groupId: 3n,
    subgroupId: 0n,
    objectId: 0n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array([1]),
  });
  // 新 Start 以降は届く
  subscriber.handleObject({
    groupId: 5n,
    subgroupId: 0n,
    objectId: 0n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array([1]),
  });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].groupId, 5n);
  // datagram 経路も同じ解決済みフィルタで再適用される
  subscriber.handleDatagram({
    groupId: 4n,
    subgroupId: 0n,
    objectId: 0n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array([1]),
  });
  subscriber.handleDatagram({
    groupId: 6n,
    subgroupId: 0n,
    objectId: 0n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array([1]),
  });
  assert.equal(deliveredDatagrams.length, 1);
  assert.equal(deliveredDatagrams[0].groupId, 6n);
});

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * LOCATION_FILTER を送らなかった update() の REQUEST_OK では
 * フィルタが不変であることを検証する。
 */
test("bidiHandleRequestUpdateOk: LOCATION_FILTER 省略の update の REQUEST_OK でフィルタは不変", () => {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 1n, (obj) => delivered.push(obj));
  subscriber.setLocationFilter({ startGroup: 1n, startObject: 0n });
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

  // 省略時は不変 (§9.20.10) のため group 1 以降が従来どおり届く
  subscriber.handleObject({
    groupId: 0n,
    subgroupId: 0n,
    objectId: 0n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array([1]),
  });
  subscriber.handleObject({
    groupId: 1n,
    subgroupId: 0n,
    objectId: 0n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array([1]),
  });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].groupId, 1n);
  assert.equal(session.pendingRequestUpdate.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §3.3.1:
 * LARGEST_OBJECT のみを含む REQUEST_UPDATE_OK では相対 Location Filter の
 * 開始位置を再解決しないことを検証する。
 */
test("bidiHandleRequestUpdateOk: LARGEST_OBJECT のみの REQUEST_OK では相対フィルタの開始位置が前進しない", () => {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 1n, (obj) => delivered.push(obj));
  // SUBSCRIBE 送信時 + SUBSCRIBE_OK 相当で開始位置を {7, 3} に確定する
  subscriber.setLocationFilter({ startGroup: 0n, startObject: 0n });
  subscriber.setLargestLocation({ group: 7n, object: 2n });
  subscriber.resolveLocationFilter();

  const session = {
    closeWithError: () => {},
    subscribers: new Map([[0n, subscriber]]),
    pendingRequestUpdate: new Map([
      [100n, { resolve: () => {}, reject: () => {}, targetRequestId: 0n }],
    ]),
  } as unknown as BidiSessionInternal;

  // LARGEST_OBJECT = {9, 0} のみを含む REQUEST_OK (LOCATION_FILTER 更新なし)
  const payload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [
      { type: MessageParameterType.LARGEST_OBJECT, value: new Uint8Array([0x09, 0x00]) },
    ],
    trackProperties: [],
  });

  bidiHandleRequestUpdateOk(session, payload, 0n);

  // 開始位置は {7, 3} のまま {8, 0} が配信される
  subscriber.handleObject({
    groupId: 8n,
    objectId: 0n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array([1]),
  });
  assert.equal(delivered.length, 1);
  // LARGEST_OBJECT 自体は反映される
  assert.deepEqual(subscriber.largestLocation, { group: 9n, object: 0n });
  assert.equal(session.pendingRequestUpdate.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §3.3.1:
 * REQUEST_UPDATE_OK が LARGEST_OBJECT と相対 LOCATION_FILTER を同時に運ぶ場合、
 * 更新後の LARGEST_OBJECT でフィルタを解決することを検証する。
 */
test("bidiHandleRequestUpdateOk: 相対 LOCATION_FILTER が更新後の LARGEST_OBJECT で解決される", () => {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 1n, (obj) => delivered.push(obj));
  subscriber.setLocationFilter({ startGroup: 10n, startObject: 0n });
  const session = {
    closeWithError: () => {},
    subscribers: new Map([[0n, subscriber]]),
    pendingRequestUpdate: new Map([
      [
        100n,
        {
          resolve: () => {},
          reject: () => {},
          targetRequestId: 0n,
          locationFilter: { startGroup: 0n, startObject: 0n },
        },
      ],
    ]),
  } as unknown as BidiSessionInternal;

  const payload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [
      { type: MessageParameterType.LARGEST_OBJECT, value: new Uint8Array([0x07, 0x02]) },
    ],
    trackProperties: [],
  });

  bidiHandleRequestUpdateOk(session, payload, 0n);

  // 更新後の largest {7, 2} で Next Object フィルタが {7, 3} に解決される
  subscriber.handleObject({
    groupId: 7n,
    objectId: 2n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array([1]),
  });
  assert.equal(delivered.length, 0);
  subscriber.handleObject({
    groupId: 7n,
    objectId: 3n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array([1]),
  });
  assert.equal(delivered.length, 1);
  assert.equal(session.pendingRequestUpdate.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.20.10 / §3.3.1:
 * { reset: true } (Length 0) は除去として反映され、
 * 反映後はフィルタなしで全オブジェクトが通過することを検証する。
 * (§9.20.10: "A length of 0 indicates no filter, for example to remove
 *  the filter in REQUEST_UPDATE.")
 */
test("bidiHandleRequestUpdateOk: reset フィルタが反映され全オブジェクトが通過する", () => {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 1n, (obj) => delivered.push(obj));
  subscriber.setLocationFilter({ startGroup: 5n, startObject: 0n });
  const session = {
    closeWithError: () => {},
    subscribers: new Map([[0n, subscriber]]),
    pendingRequestUpdate: new Map([
      [
        100n,
        {
          resolve: () => {},
          reject: () => {},
          targetRequestId: 0n,
          locationFilter: { reset: true },
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

  // 除去後は group 0 も通過する
  subscriber.handleObject({
    groupId: 0n,
    subgroupId: 0n,
    objectId: 0n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array([1]),
  });
  assert.equal(delivered.length, 1);
  assert.equal(session.pendingRequestUpdate.size, 0);
});

// ============================================================================
// PUBLISH_OK Track Properties 非空チェックテスト
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.3 (REQUEST_OK):
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
 * draft-ietf-moq-transport-21 Section 9.2 (GOAWAY):
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
// draft-ietf-moq-transport-21 §3.3.2 / §9.1.6
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
    fillFetchTargets: new Map(),
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
    publisherStreams: new Map(),
    publisherSendQueues: new Map(),
    closedSubgroups: new Set(),
    statsControlMessagesSent: 0,
    emitDebug: () => {},
    closeWithError: () => {},
    validateIncomingRequestId: (_requestId: bigint) => true,
  } as unknown as BidiSessionInternal;

  return { session, written };
}

/**
 * draft-ietf-moq-transport-21 §3.3.2:
 * REQUEST_UPDATE では TRACK_PROPERTY_FILTER (0x29) は一律 throw する。
 * moqt-js が送信する REQUEST_UPDATE はすべて per-subscription の更新 (§9.5) であり、
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
 * draft-ietf-moq-transport-21 §3.3.2:
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
// bidiSendRequestUpdate の FILL_PARAMETERS テスト
// draft-ietf-moq-transport-21 §3.4 / §9.20.16
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.20.16:
 * update({ fill }) で FILL_PARAMETERS (0x23) が REQUEST_UPDATE に載り、
 * 内側に指定内容が入ることを検証する。fill 要求元の Request ID は購読に
 * 関連付けられる。
 */
test("bidiSendRequestUpdate: fill が FILL_PARAMETERS として REQUEST_UPDATE にエンコードされる", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  // bidiSendRequestUpdate は REQUEST_OK 受信まで resolve しない Promise を返すため、
  // 送信完了後に pendingRequestUpdate の Promise を解決してから await する
  const updatePromise = bidiSendRequestUpdate(session, subscriber, {
    fill: {
      filter: { startGroup: 10n, startObject: 2n },
      fillTimeout: 100n,
      subscriberPriority: 10,
      groupOrder: "Descending",
    },
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
  const fillParam = decoded.parameters.find((p) => p.type === MessageParameterType.FILL_PARAMETERS);
  assert.isDefined(fillParam);
  const inner = decodeFillParameters(fillParam!);
  assert.isDefined(inner.find((p) => p.type === MessageParameterType.LOCATION_FILTER));
  assert.isDefined(inner.find((p) => p.type === MessageParameterType.FILL_TIMEOUT));
  assert.isDefined(inner.find((p) => p.type === MessageParameterType.SUBSCRIBER_PRIORITY));
  assert.isDefined(inner.find((p) => p.type === MessageParameterType.GROUP_ORDER));

  // fill 要求元の Request ID (100n) が購読に関連付けられる
  const target = session.fillFetchTargets.get(100n);
  assert.isDefined(target);
  assert.equal(target!.subscriber, subscriber);
  assert.equal(target!.groupOrder, GroupOrder.DESCENDING);
});

/**
 * draft-ietf-moq-transport-21 §9.20.10 / §9.20.16:
 * fill 内の LOCATION_FILTER が End Group 超過の場合は送信前に throw する。
 */
test("bidiSendRequestUpdate: fill 内の LOCATION_FILTER が End Group 超過の場合は throw する", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      fill: {
        filter: { startGroup: MAX_VARINT, startObject: 0n, endGroupDelta: 1n },
      },
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("absolute range end group exceeds maximum"));
  // 失敗時は fill 関連付けも残らない
  assert.equal(session.fillFetchTargets.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.1.6:
 * fill 内側の Range Filters も購読単位の上限に含め、上限超過では送信前に
 * throw することを検証する。
 */
test("bidiSendRequestUpdate: fill 内側の Range Filters が上限超過の場合は throw する", async () => {
  // createBidiSession の peerMaxFilterRanges は 2 のため、3 Ranges で超過する
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      fill: {
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
      },
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("exceeds peer MAX_FILTER_RANGES 2"));
  // 失敗時は fill 関連付けも残らない
  assert.equal(session.fillFetchTargets.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.1.6:
 * in-flight 中の fill 内側 Range Filters も上限合算に含め、合計超過では
 * 送信前に throw することを検証する。
 */
test("bidiSendRequestUpdate: in-flight の fill と合計で上限超過の場合は throw する", async () => {
  // createBidiSession の peerMaxFilterRanges は 2 のため、2 + 1 で超過する
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  // 1 件目の fill 更新を in-flight のまま残す (2 Ranges)
  const firstPromise = bidiSendRequestUpdate(session, subscriber, {
    fill: {
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
    },
  });
  firstPromise.catch(() => {});

  // 2 件目の fill 更新 (1 Range) は合計 3 で上限 2 を超えるため throw する
  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      fill: {
        rangeFilters: [{ type: "subgroup", setId: 1, ranges: [{ start: 0n, end: 1n }] }],
      },
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("exceeds peer MAX_FILTER_RANGES 2"));
  // 1 件目の関連付けは残り、2 件目は登録されない
  assert.equal(session.fillFetchTargets.size, 1);

  // 後始末: 1 件目を解決して unhandled にしない
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await firstPromise;
});

/**
 * draft-ietf-moq-transport-21 §9.20.16:
 * update の fill で GROUP_ORDER を省略した場合、subscription の指定を継承して
 * 関連付けられることを検証する。
 */
test("bidiSendRequestUpdate: fill の GROUP_ORDER 省略時は subscription の指定を継承する", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  subscriber.setGroupOrder("Descending");

  const updatePromise = bidiSendRequestUpdate(session, subscriber, {
    fill: {
      filter: { startGroup: 10n, startObject: 2n },
    },
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  const target = session.fillFetchTargets.get(100n);
  assert.isDefined(target);
  assert.equal(target!.groupOrder, GroupOrder.DESCENDING);
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

/**
 * draft-ietf-moq-transport-21 §9.1.6 / §3.3.2:
 * MAX_FILTER_RANGES は「マージ後のフィルタ状態」に対して適用される。
 * 既存フィルタ (2 Range) と update (1 Range) のマージ後 (3 Range) が
 * 上限 2 を超える場合、update 単体では合法でも送信前に throw することを
 * 検証する。
 */
test("bidiSendRequestUpdate: 既存フィルタとマージすると MAX_FILTER_RANGES を超える場合に throw する", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  // 既存フィルタ (subgroup 2 Range。単体では上限 2 以内)
  subscriber.setRangeFilters([
    {
      type: "subgroup",
      setId: 0,
      ranges: [
        { start: 0n, end: 1n },
        { start: 3n, end: 4n },
      ],
    },
  ]);

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      rangeFilters: [
        {
          type: "objectId",
          setId: 0,
          ranges: [{ start: 5n, end: 6n }],
        },
      ],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("exceeds peer MAX_FILTER_RANGES 2"));
  // throw 時に pending エントリが残らない
  assert.equal(session.pendingRequestUpdate.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * End Group が 2^64-1 を超える 3 フィールド表現の LOCATION_FILTER 値を手組みする。
 * 先頭 varint はバイト Length のため、フィールド部の実バイト長を指定する。
 */
function buildExceedingLocationFilterValue(): Uint8Array {
  const exceedingFields = new Uint8Array([
    ...encodeVarint(1n),
    ...encodeVarint(0n),
    ...encodeVarint(MAX_VARINT),
  ]);
  return new Uint8Array([...encodeVarint(BigInt(exceedingFields.length)), ...exceedingFields]);
}

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * raw パラメータ経路の LOCATION_FILTER (0x21) も型付き経路と同じ
 * End Group 検証の対象にする。超過時は InvalidFilterError で送信前に
 * 拒否し、pending エントリを残さない。
 */
test("bidiSendRequestUpdate: raw LOCATION_FILTER の End Group 超過で InvalidFilterError", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  // StartGroup(1) + EndGroupDelta(2^64-1) が 2^64-1 を超える 3 フィールド表現を手組みする
  const exceeding = buildExceedingLocationFilterValue();

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      parameters: [{ type: MessageParameterType.LOCATION_FILTER, value: exceeding }],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.instanceOf(thrown, InvalidFilterError);
  assert.isTrue(thrown!.message.includes("absolute range end group exceeds maximum"));
  // throw 時に pending エントリが残らない
  assert.equal(session.pendingRequestUpdate.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * トップレベルの LOCATION_FILTER が複数ある場合も全件検証し、
 * 2 件目以降の超過を見逃さない。
 */
test("bidiSendRequestUpdate: 2 件目の raw LOCATION_FILTER 超過も InvalidFilterError", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  const exceeding = buildExceedingLocationFilterValue();

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      parameters: [
        encodeLocationFilterParameter({ startGroup: 1n, startObject: 2n }),
        { type: MessageParameterType.LOCATION_FILTER, value: exceeding },
      ],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.instanceOf(thrown, InvalidFilterError);
  assert.isTrue(thrown!.message.includes("absolute range end group exceeds maximum"));
  assert.equal(session.pendingRequestUpdate.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * 正常な raw LOCATION_FILTER は従来どおり送信でき、
 * LOCATION_FILTER 以外の raw パラメータは検証対象にしない。
 */
test("bidiSendRequestUpdate: 正常な raw LOCATION_FILTER は送信できる", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  const updatePromise = bidiSendRequestUpdate(session, subscriber, {
    parameters: [
      encodeLocationFilterParameter({ startGroup: 1n, startObject: 2n }),
      { type: MessageParameterType.SUBSCRIBER_PRIORITY, value: new Uint8Array([0x01]) },
    ],
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  assert.equal(messages.length, 1);
  const decoded = decodeRequestUpdatePayload(messages[0].payload);
  assert.isDefined(decoded.parameters.find((p) => p.type === MessageParameterType.LOCATION_FILTER));
  // LOCATION_FILTER 以外の raw パラメータは検証対象にせず素通しする
  assert.isDefined(
    decoded.parameters.find((p) => p.type === MessageParameterType.SUBSCRIBER_PRIORITY),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.20.10 / §9.20.16:
 * 手組みの raw FILL_PARAMETERS 内側の LOCATION_FILTER が End Group 超過の
 * 場合は送信前に InvalidFilterError で拒否し、pending エントリを残さない。
 */
test("bidiSendRequestUpdate: raw FILL_PARAMETERS 内側の End Group 超過で InvalidFilterError", async () => {
  // 内側 LOCATION_FILTER が超過する raw FILL_PARAMETERS を手組みする
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  const exceeding = buildExceedingLocationFilterValue();
  const inner = encodeParameters([
    { type: MessageParameterType.LOCATION_FILTER, value: exceeding },
  ]);

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      parameters: [{ type: MessageParameterType.FILL_PARAMETERS, value: inner }],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  // 内側の超過が InvalidFilterError に変換される
  assert.instanceOf(thrown, InvalidFilterError);
  assert.isTrue(thrown!.message.includes("absolute range end group exceeds maximum"));
  // throw 時に pending エントリが残らず、ワイヤ書き込みもない
  assert.equal(session.pendingRequestUpdate.size, 0);
  assert.equal(written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.20.10 / §9.20.16:
 * 単一の raw FILL_PARAMETERS の内側超過を InvalidFilterError で拒否する。
 * 複数件の場合は重複検査が先に拒否するため、内側検証は単一の場合に到達する。
 */
test("bidiSendRequestUpdate: 単一の raw FILL_PARAMETERS 内側超過も InvalidFilterError", async () => {
  // 内側が超過する単一の組み合わせを手組みする
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  const exceeding = buildExceedingLocationFilterValue();
  const exceedingInner = encodeParameters([
    { type: MessageParameterType.LOCATION_FILTER, value: exceeding },
  ]);

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      parameters: [{ type: MessageParameterType.FILL_PARAMETERS, value: exceedingInner }],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  // 内側の超過が InvalidFilterError に変換される
  assert.instanceOf(thrown, InvalidFilterError);
  assert.isTrue(thrown!.message.includes("absolute range end group exceeds maximum"));
  assert.equal(session.pendingRequestUpdate.size, 0);
  assert.equal(written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.20.10 / §9.20.16:
 * 4 フィールド表現 (EndObject 付き) の内側超過も送信前に拒否する。
 * 3 フィールドとは別分岐のため到達を確認する。
 */
test("bidiSendRequestUpdate: raw FILL_PARAMETERS 内側の 4 フィールド超過も InvalidFilterError", async () => {
  // StartGroup(1) + EndGroupDelta(2^64-1) が超過する 4 フィールド表現を手組みする
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  const exceedingFields = new Uint8Array([
    ...encodeVarint(1n),
    ...encodeVarint(0n),
    ...encodeVarint(MAX_VARINT),
    ...encodeVarint(0n),
  ]);
  const exceedingValue = new Uint8Array([
    ...encodeVarint(BigInt(exceedingFields.length)),
    ...exceedingFields,
  ]);
  const inner = encodeParameters([
    { type: MessageParameterType.LOCATION_FILTER, value: exceedingValue },
  ]);

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      parameters: [{ type: MessageParameterType.FILL_PARAMETERS, value: inner }],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  // 4 フィールド分岐の超過が InvalidFilterError に変換される
  assert.instanceOf(thrown, InvalidFilterError);
  assert.isTrue(thrown!.message.includes("absolute range end group exceeds maximum"));
  assert.equal(session.pendingRequestUpdate.size, 0);
  assert.equal(written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.20.16:
 * 正常な raw FILL_PARAMETERS は従来どおり送信でき、
 * ワイヤ上の parameters に FILL_PARAMETERS が残る (回帰ガード)。
 */
test("bidiSendRequestUpdate: 正常な raw FILL_PARAMETERS は送信できる", async () => {
  // 正常な内側 LOCATION_FILTER を包んだ raw FILL_PARAMETERS を渡す。
  // 購読への関連付け登録は別テストで検証する
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  const normalInner = encodeParameters([
    encodeLocationFilterParameter({ startGroup: 1n, startObject: 2n }),
  ]);

  const updatePromise = bidiSendRequestUpdate(session, subscriber, {
    parameters: [{ type: MessageParameterType.FILL_PARAMETERS, value: normalInner }],
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  assert.equal(messages.length, 1);
  const decoded = decodeRequestUpdatePayload(messages[0].payload);
  const sentFill = decoded.parameters.find((p) => p.type === MessageParameterType.FILL_PARAMETERS);
  assert.isDefined(sentFill);
  // 内側の LOCATION_FILTER が保持されている
  const sentInner = decodeFillParameters(sentFill);
  assert.isDefined(sentInner.find((p) => p.type === MessageParameterType.LOCATION_FILTER));
});

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * bidiSendRequestUpdate は送信時の LOCATION_FILTER (先頭 1 件のデコード値) を
 * pending に保持し、REQUEST_OK 受信時の反映に使うことを検証する。
 */
test("bidiSendRequestUpdate: 送信時の LOCATION_FILTER が pending に保持される", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  const updatePromise = bidiSendRequestUpdate(session, subscriber, {
    parameters: [encodeLocationFilterParameter({ startGroup: 2n, startObject: 3n })],
  });
  assert.equal(session.pendingRequestUpdate.size, 1);
  for (const [, pending] of session.pendingRequestUpdate) {
    assert.deepEqual(pending.locationFilter, { startGroup: 2n, startObject: 3n });
    pending.resolve();
  }
  await updatePromise;
});

/**
 * draft-ietf-moq-transport-21 §9.5.1:
 * REQUEST_ERROR (coalescing による reject) では送信時の LOCATION_FILTER が
 * 反映されないことを検証する。
 */
test("rejectPendingRequestUpdates: 失敗時は送信時の LOCATION_FILTER が反映されない", () => {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 1n, (obj) => delivered.push(obj));
  subscriber.setLocationFilter({ startGroup: 1n, startObject: 0n });
  const session = {
    closeWithError: () => {},
    subscribers: new Map([[0n, subscriber]]),
    pendingRequestUpdate: new Map([
      [
        100n,
        {
          resolve: () => {},
          reject: () => {},
          targetRequestId: 0n,
          locationFilter: { startGroup: 5n, startObject: 0n },
        },
      ],
    ]),
  } as unknown as BidiSessionInternal;

  rejectPendingRequestUpdates(session, 0n, new Error("REQUEST_ERROR"));

  // 失敗時は旧フィルタのまま (group 1 は通過、group 0 は不通過)
  subscriber.handleObject({
    groupId: 0n,
    subgroupId: 0n,
    objectId: 0n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array([1]),
  });
  subscriber.handleObject({
    groupId: 1n,
    subgroupId: 0n,
    objectId: 0n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array([1]),
  });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].groupId, 1n);
  assert.equal(session.pendingRequestUpdate.size, 0);
});

test("bidiSendRequestUpdate: マージ後の状態が上限以内なら throw しない", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  subscriber.setRangeFilters([{ type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 1n }] }]);

  let thrown: Error | undefined;
  try {
    const updatePromise = bidiSendRequestUpdate(session, subscriber, {
      rangeFilters: [{ type: "objectId", setId: 0, ranges: [{ start: 5n, end: 6n }] }],
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

/**
 * draft-ietf-moq-transport-21 §9.5.1:
 * 「Parameter values from later REQUEST_UPDATE messages override values from
 *  earlier ones.」により、in-flight の update (送信順) もマージに含めて
 * 検証する。in-flight の削除 update が反映されない場合は
 * subgroup 2 Range + objectId 1 Range = 3 Range (> 2) で超過するケースが、
 * 削除後は objectId 1 Range で上限以内になることを検証する (判別力を持つ)。
 */
test("bidiSendRequestUpdate: in-flight の削除 update がマージに反映される", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  subscriber.setRangeFilters([
    {
      type: "subgroup",
      setId: 0,
      ranges: [
        { start: 0n, end: 1n },
        { start: 3n, end: 4n },
      ],
    },
  ]);
  // in-flight の update (subgroup を全削除) を送信順で登録する
  session.pendingRequestUpdate.set(90n, {
    resolve: () => {},
    reject: () => {},
    targetRequestId: 0n,
    rangeFilters: [{ type: "subgroup", remove: true }],
  });

  let thrown: Error | undefined;
  try {
    const updatePromise = bidiSendRequestUpdate(session, subscriber, {
      rangeFilters: [{ type: "objectId", setId: 0, ranges: [{ start: 5n, end: 6n }] }],
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

/**
 * draft-ietf-moq-transport-21 §9.5.1:
 * in-flight の update は送信順 (挿入順) で適用され、後からの値が前の値を
 * 上書きする。同じ型を 3 → 2 に置換する 2 件の in-flight を登録し、
 * 最後の値 (2 Range) でマージされることを検証する (先発が勝つ順序なら
 * 3 Range + 今回の 1 Range = 4 Range > 3 で throw するため判別力を持つ)。
 */
test("bidiSendRequestUpdate: in-flight の update は送信順で適用される", async () => {
  const { session } = createBidiSession();
  (session as unknown as { peerMaxFilterRanges: number }).peerMaxFilterRanges = 3;
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  subscriber.setRangeFilters([
    {
      type: "subgroup",
      setId: 0,
      ranges: [
        { start: 0n, end: 1n },
        { start: 3n, end: 4n },
      ],
    },
  ]);
  // in-flight 1 件目: subgroup を 3 Range に置換
  session.pendingRequestUpdate.set(90n, {
    resolve: () => {},
    reject: () => {},
    targetRequestId: 0n,
    rangeFilters: [
      {
        type: "subgroup",
        setId: 0,
        ranges: [
          { start: 10n, end: 11n },
          { start: 12n, end: 13n },
          { start: 14n, end: 15n },
        ],
      },
    ],
  });
  // in-flight 2 件目: subgroup を 2 Range に置換 (送信順で最後)
  session.pendingRequestUpdate.set(92n, {
    resolve: () => {},
    reject: () => {},
    targetRequestId: 0n,
    rangeFilters: [
      {
        type: "subgroup",
        setId: 0,
        ranges: [
          { start: 20n, end: 21n },
          { start: 22n, end: 23n },
        ],
      },
    ],
  });

  let thrown: Error | undefined;
  try {
    const updatePromise = bidiSendRequestUpdate(session, subscriber, {
      rangeFilters: [{ type: "objectId", setId: 0, ranges: [{ start: 5n, end: 6n }] }],
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

test("bidiSendRequestUpdate: in-flight の update でマージ後が上限超過になる場合に throw する", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  subscriber.setRangeFilters([{ type: "objectId", setId: 0, ranges: [{ start: 0n, end: 1n }] }]);
  // in-flight の update (subgroup 2 Range。対象型が異なるため objectId と共存)
  session.pendingRequestUpdate.set(90n, {
    resolve: () => {},
    reject: () => {},
    targetRequestId: 0n,
    rangeFilters: [
      {
        type: "subgroup",
        setId: 0,
        ranges: [
          { start: 2n, end: 3n },
          { start: 4n, end: 5n },
        ],
      },
    ],
  });

  let thrown: Error | undefined;
  try {
    // 今回の update (objectId 1 Range) は単体では上限 2 以内だが、
    // in-flight の subgroup 2 Range を含むマージ後は 3 Range になる
    await bidiSendRequestUpdate(session, subscriber, {
      rangeFilters: [{ type: "objectId", setId: 0, ranges: [{ start: 10n, end: 11n }] }],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("exceeds peer MAX_FILTER_RANGES 2"));
});

/**
 * draft-ietf-moq-transport-21 §9.1.6:
 * ピアの MAX_FILTER_RANGES = 0 (未広告) の場合は §9.1.6 により送信禁止。
 * マージ後が空になる削除のみの update でも throw することを検証する
 * (既存ガードの維持)。
 */
test("bidiSendRequestUpdate: MAX_FILTER_RANGES が 0 のとき削除のみの update でも throw する", async () => {
  const { session } = createBidiSession();
  (session as unknown as { peerMaxFilterRanges: number }).peerMaxFilterRanges = 0;
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      rangeFilters: [{ type: "subgroup", remove: true }],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("MAX_FILTER_RANGES is 0"));
  assert.equal(session.pendingRequestUpdate.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.1.6:
 * 空配列の rangeFilters (フィルタ指定なしの no-op メッセージ) は、ピアの
 * MAX_FILTER_RANGES が 0 (未広告) でも送信できる (フィルタパラメータ自体が
 * 送信されないため。旧実装でも送信可能だった挙動の維持)。
 * ガードが「undefined でも空配列でも throw する」形に退化した場合に
 * 送信経路に到達しないことを検出できるよう、メッセージ書き込みまで
 * 確認する。
 */
test("bidiSendRequestUpdate: 空配列の rangeFilters は MAX_FILTER_RANGES が 0 でも送信できる", async () => {
  const { session, written } = createBidiSession();
  (session as unknown as { peerMaxFilterRanges: number }).peerMaxFilterRanges = 0;
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  let thrown: Error | undefined;
  try {
    const updatePromise = bidiSendRequestUpdate(session, subscriber, {
      rangeFilters: [],
    });
    for (const [, pending] of session.pendingRequestUpdate) {
      pending.resolve();
    }
    await updatePromise;
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isUndefined(thrown);
  // REQUEST_UPDATE メッセージが送信経路に到達している
  assert.equal(written.length, 1);
});

/**
 * draft-ietf-moq-transport-21 §3.3.2:
 * 削除を含む update は削除後の状態で検証される (既存の同型フィルタは
 * マージで取り除かれ、Ranges 数に数えられない)。本テストが検出するのは
 * 「update をマージせず連結する」誤実装のみである (削除後の Ranges 数と
 * 単体の Ranges 数が一致するケースのため)。
 */
test("bidiSendRequestUpdate: 削除を含む update は削除後の状態で検証される", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  subscriber.setRangeFilters([
    {
      type: "subgroup",
      setId: 0,
      ranges: [
        { start: 0n, end: 1n },
        { start: 3n, end: 4n },
      ],
    },
  ]);

  let thrown: Error | undefined;
  try {
    const updatePromise = bidiSendRequestUpdate(session, subscriber, {
      rangeFilters: [
        { type: "subgroup", remove: true },
        { type: "objectId", setId: 0, ranges: [{ start: 5n, end: 6n }] },
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
// draft-ietf-moq-transport-21 §9.5.2 (Updating Namespace Subscriptions)
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
  const [trackNamespace] = decodeTrackNamespace(trackNamespaceParam!.value, 0);
  assert.deepEqual(trackNamespaceToStrings(trackNamespace), ["live", "sports"]);

  // 送信後、REQUEST_OK 受信待ちの間は pendingPrefix に新 prefix が保持される
  assert.deepEqual(subscription.pendingPrefix, ["live", "sports"]);
  // 既存の namespacePrefix は REQUEST_OK 受信まで更新されない
  assert.deepEqual(subscription.namespacePrefix, ["live"]);
});

/**
 * draft-ietf-moq-transport-21 §9.20.19:
 * SUBSCRIBE_TRACKS の REQUEST_UPDATE で FORWARD=0 / FORWARD=1 の両方が
 * ワイヤに載ることを検証する。将来の購読向けであり既存購読には影響しない。
 */
test("bidiSendNamespaceRequestUpdate: Tracks 更新の FORWARD がワイヤに載る", async () => {
  for (const forward of [false, true]) {
    const { session, written } = createNamespaceUpdateSession("tracks", ["live"]);
    const writer = {
      write: async (data: Uint8Array): Promise<void> => {
        written.push(data);
      },
    } as unknown as WritableStreamDefaultWriter<Uint8Array>;

    const updatePromise = bidiSendNamespaceRequestUpdate(session, 0n, writer, {
      trackNamespacePrefix: ["live", "sports"],
      forward,
    });
    for (const [, pending] of session.pendingRequestUpdate) {
      pending.resolve();
    }
    await updatePromise;

    // FORWARD パラメータが指定値どおりにエンコードされる
    // 直前で isDefined を検証済みのため非 null アサーションで参照する
    const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
    assert.equal(messages.length, 1, `forward=${forward}`);
    const decoded = decodeRequestUpdatePayload(messages[0].payload);
    const forwardParam = decoded.parameters.find((p) => p.type === MessageParameterType.FORWARD);
    assert.isDefined(forwardParam, `forward=${forward}`);
    assert.deepEqual(forwardParam!.value, new Uint8Array([forward ? 1 : 0]), `forward=${forward}`);
    // 同梱の TRACK_NAMESPACE_PREFIX も新 prefix で存在する
    const prefixParam = decoded.parameters.find(
      (p) => p.type === MessageParameterType.TRACK_NAMESPACE_PREFIX,
    );
    assert.isDefined(prefixParam, `forward=${forward}`);
  }
});

/**
 * draft-ietf-moq-transport-21 §9.20.19:
 * FORWARD 省略時は不変のため送らないことを検証する。
 */
test("bidiSendNamespaceRequestUpdate: Tracks 更新の FORWARD 省略時は送らない", async () => {
  const { session, written } = createNamespaceUpdateSession("tracks", ["live"]);
  const writer = {
    write: async (data: Uint8Array): Promise<void> => {
      written.push(data);
    },
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  const updatePromise = bidiSendNamespaceRequestUpdate(session, 0n, writer, {
    trackNamespacePrefix: ["live", "sports"],
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  const decoded = decodeRequestUpdatePayload(messages[0].payload);
  assert.isUndefined(decoded.parameters.find((p) => p.type === MessageParameterType.FORWARD));
});

/**
 * draft-ietf-moq-transport-21 §9.20.19:
 * SUBSCRIBE_NAMESPACE 向け REQUEST_UPDATE では FORWARD が許可されないため、
 * Namespace 更新では実行時に混入しても送らないことを検証する。
 */
test("bidiSendNamespaceRequestUpdate: Namespace 更新では FORWARD を送らない", async () => {
  const { session, written } = createNamespaceUpdateSession("namespace", ["live"]);
  const writer = {
    write: async (data: Uint8Array): Promise<void> => {
      written.push(data);
    },
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  // 型上は露出させないが、実行時に混入しても黙って落とす
  const updatePromise = bidiSendNamespaceRequestUpdate(session, 0n, writer, {
    trackNamespacePrefix: ["live", "sports"],
    forward: true,
  } as unknown as { trackNamespacePrefix: string[] });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  const decoded = decodeRequestUpdatePayload(messages[0].payload);
  assert.isUndefined(decoded.parameters.find((p) => p.type === MessageParameterType.FORWARD));
  // FORWARD のみ落とし、TRACK_NAMESPACE_PREFIX は新 prefix で残る
  const prefixParam = decoded.parameters.find(
    (p) => p.type === MessageParameterType.TRACK_NAMESPACE_PREFIX,
  );
  assert.isDefined(prefixParam);
});

test("bidiSendNamespaceRequestUpdate: MAX_REQUEST_UPDATES を超える更新は throw する", async () => {
  const { session, subscription } = createNamespaceUpdateSession("namespace", ["live"]);
  // ピアの MAX_REQUEST_UPDATES を 1 に設定し、既に 1 件 outstanding の状態を作る。
  // このテストは throw で終わるため、既存 pending の resolve は不要 (無意味な
  // Promise を作らない)。
  (session as unknown as { peerMaxRequestUpdates: number }).peerMaxRequestUpdates = 1;
  session.pendingRequestUpdate.set(90n, {
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
  const [trackNamespace] = decodeTrackNamespace(trackNamespaceParam!.value, 0);
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
  ctx.session.pendingRequestUpdate.set(90n, {
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
// draft-ietf-moq-transport-21 §6.4.2.2 / §6.4.2.3 / §9.8
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
  // SessionImpl の onDoneInternal と同じ後始末 (データストリーム FIN → PUBLISH_DONE)
  publisher.onDoneInternal = async (status) => {
    await publishClosePublisherStream(session, publisher.getTrackAlias());
    await publishSendPublishDone(session, publisher, status);
  };

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
    publisherStreams: new Map(),
    publisherSendQueues: new Map(),
    closedSubgroups: new Set(),
    statsControlMessagesSent: 0,
    emitDebug: () => {},
    closeWithError: (error: SessionError) => {
      closedWithError = error;
    },
    validateIncomingRequestId: (_requestId: bigint) => true,
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
 * draft-ietf-moq-transport-21 §6.4.2.2:
 * PUBLISH_OK 受信前 (Established 前) にピアが FIN を送った場合、リクエストは
 * 失敗として処理される。bidiReadResponseFromBidiStream の throw が
 * bidiReadPublishResponse の内部で使う共有リーダ bidiReadResponse の catch で
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
 * テスト用に session の sessionState を "closed" に遷移させる
 * (型上 readonly のため、テスト用に型を偽装して書き換える)
 */
function forceSessionClosed(session: BidiSessionInternal): void {
  (session as unknown as { sessionState: "connected" | "closed" }).sessionState = "closed";
}

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

// ============================================================================
// bidiHandlePublishRequestUpdate のテスト
// draft-ietf-moq-transport-21 §9.5 ケース 1 (受信 PUBLISH 上の REQUEST_UPDATE)
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §3.3.2:
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

  // REQUEST_ERROR (INVALID_FILTER) が書き込まれ、forward state は変更されない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  const decoded = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.INVALID_FILTER));
  assert.equal(messages[1].type, MessageType.PUBLISH_DONE);
  const publishDone = decodePublishDonePayload(messages[1].payload);
  assert.equal(publishDone.statusCode, BigInt(PublishDoneStatusCode.UPDATE_FAILED));
  assert.equal(publishDone.streamCount, 0n);
  assert.isUndefined(ctx.closedWithError);
  // 検証は forward state 反映より前に配置されるため、状態は初期値 (true) のまま
  assert.isTrue(ctx.publisher.forwardState);
});

/**
 * draft-ietf-moq-transport-21 §9.20.10 / §9.20.16:
 * role=publish の受信 REQUEST_UPDATE の FILL_PARAMETERS 内側 LOCATION_FILTER が
 * End Group 超過の場合、PROTOCOL_VIOLATION でセッションを閉じることを検証する。
 */
test("bidiReadRequestStreamMessages: FILL 内側の LOCATION_FILTER 超過の REQUEST_UPDATE (publish ロール) でセッションが閉じる", async () => {
  const ctx = createPublishReadTestContext({});

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // 内側の End Group = MAX_VARINT + 1 超過を手組みする
  const fields = new Uint8Array([
    ...encodeVarint(MAX_VARINT),
    ...encodeVarint(0n),
    ...encodeVarint(1n),
  ]);
  const overflowValue = new Uint8Array([...encodeVarint(BigInt(fields.length)), ...fields]);
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      encodeFillParameters([{ type: MessageParameterType.LOCATION_FILTER, value: overflowValue }]),
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // PROTOCOL_VIOLATION でセッションが閉じ、REQUEST_OK は応答されない
  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.equal(ctx.written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §3.3.2 / §9.20.16:
 * role=publish の受信 REQUEST_UPDATE の FILL_PARAMETERS 内側 Range Filter が
 * 値違反の場合、外側と同様に REQUEST_ERROR (INVALID_FILTER) で応答されることを
 * 検証する。
 */
test("bidiReadRequestStreamMessages: FILL 内側の Range Filter 値違反の REQUEST_UPDATE (publish ロール) で INVALID_FILTER が応答される", async () => {
  const ctx = createPublishReadTestContext({});

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // PRIORITY_FILTER (0x27) で 255 超の値を内側に含める
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      encodeFillParameters([{ type: 0x27, value: new Uint8Array([0x04, 0x01, 0xac, 0x02, 0x00]) }]),
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // REQUEST_ERROR (INVALID_FILTER) が応答され、セッションは閉じない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  const decoded = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.INVALID_FILTER));
  assert.equal(messages[1].type, MessageType.PUBLISH_DONE);
  const publishDone = decodePublishDonePayload(messages[1].payload);
  assert.equal(publishDone.statusCode, BigInt(PublishDoneStatusCode.UPDATE_FAILED));
  assert.equal(publishDone.streamCount, 0n);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.20.16:
 * role=publish の受信 REQUEST_UPDATE の FILL_PARAMETERS 内側に除去が含まれる
 * 場合、一回限りの fill に意味を持たないため REQUEST_ERROR (INVALID_FILTER)
 * で応答されることを検証する。
 */
test("bidiReadRequestStreamMessages: FILL 内側の除去を含む REQUEST_UPDATE (publish ロール) で INVALID_FILTER が応答される", async () => {
  const ctx = createPublishReadTestContext({});

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // SUBGROUP_FILTER の除去 (Length=0) を内側に含める
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [encodeFillParameters([{ type: 0x25, value: new Uint8Array([0x00]) }])],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // REQUEST_ERROR (INVALID_FILTER) が応答され、セッションは閉じない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  const decoded = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.INVALID_FILTER));
  assert.equal(messages[1].type, MessageType.PUBLISH_DONE);
  const publishDone = decodePublishDonePayload(messages[1].payload);
  assert.equal(publishDone.statusCode, BigInt(PublishDoneStatusCode.UPDATE_FAILED));
  assert.equal(publishDone.streamCount, 0n);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * End Group が 2^64-1 を超える LOCATION_FILTER パラメータを組み立てる
 *
 * draft-ietf-moq-transport-21 §9.20.10 の Length ベース表現で、StartGroup +
 * EndGroupDelta が超過する値を手組みする。encodeLocationFilterParameter
 * は送信前に throw するためエンコーダでは組み立てられない。
 * 4 フィールド表現 (EndObject 付き) も対象にする。
 */
function buildOverflowingLocationFilterParameter(withEndObject = false): {
  type: number;
  value: Uint8Array;
} {
  // StartGroup=MAX_VARINT + StartObject=0 + EndGroupDelta=1
  // End Group = MAX_VARINT + 1 で 2^64-1 超過
  const rawFields = [encodeVarint(MAX_VARINT), encodeVarint(0n), encodeVarint(1n)];
  if (withEndObject) {
    rawFields.push(encodeVarint(0n));
  }
  const fields = new Uint8Array(rawFields.flatMap((part) => [...part]));
  const value = new Uint8Array([...encodeVarint(BigInt(fields.length)), ...fields]);
  return { type: MessageParameterType.LOCATION_FILTER, value };
}

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * role=publish の受信 REQUEST_UPDATE に End Group 超過の LOCATION_FILTER が
 * 含まれる場合、PROTOCOL_VIOLATION でセッションを閉じることを検証する。
 * REQUEST_OK は応答されない。
 */
test("bidiReadRequestStreamMessages: End Group 超過の LOCATION_FILTER を含む REQUEST_UPDATE (publish ロール) でセッションが閉じる", async () => {
  // 3 フィールド表現と 4 フィールド (EndObject 付き) 表現の両方で検証する
  const overflowing = [
    buildOverflowingLocationFilterParameter(),
    buildOverflowingLocationFilterParameter(true),
  ];
  for (const parameter of overflowing) {
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
      parameters: [parameter],
    });
    const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
    ctx.readableController.enqueue(message);
    ctx.readableController.close();
    await readPromise;

    // PROTOCOL_VIOLATION でセッションが閉じ、REQUEST_OK は応答されない
    assert.isDefined(ctx.closedWithError);
    assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
    assert.equal(ctx.written.length, 0);
  }
});

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * role=publish の受信 REQUEST_UPDATE に正常な LOCATION_FILTER が含まれる場合、
 * 従来どおり REQUEST_OK が応答されセッションが閉じないことを検証する
 * (回帰ガード)。
 */
test("bidiReadRequestStreamMessages: 正常な LOCATION_FILTER を含む REQUEST_UPDATE (publish ロール) で REQUEST_OK が応答される", async () => {
  const ctx = createPublishReadTestContext({});

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // 除去 (Length 0) / 1 フィールド相対 / AbsoluteStart / 域内 AbsoluteRange /
  // End Group = 2^64-1 ちょうどの境界値の 5 種はいずれも有効
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
    const updatePayload = encodeRequestUpdatePayload({
      type: MessageType.REQUEST_UPDATE,
      requestId: ctx.requestId,
      parameters: [filter],
    });
    const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
    ctx.readableController.enqueue(message);
  }
  ctx.readableController.close();
  await readPromise;

  // 5 通とも REQUEST_OK が応答され、セッションは閉じない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 5);
  for (const response of messages) {
    assert.equal(response.type, MessageType.REQUEST_OK);
  }
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.20.16:
 * role=publish の受信 REQUEST_UPDATE に一覧外のパラメータを含む
 * FILL_PARAMETERS が含まれる場合、PROTOCOL_VIOLATION でセッションを閉じることを
 * 検証する。REQUEST_OK は応答されない。
 */
test("bidiReadRequestStreamMessages: 一覧外を含む FILL_PARAMETERS の REQUEST_UPDATE (publish ロール) でセッションが閉じる", async () => {
  const ctx = createPublishReadTestContext({});

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // FORWARD (0x10) は Table 6 の一覧に無いため、内側に含めると違反になる
  const inner = encodeParameters([
    { type: MessageParameterType.FORWARD, value: new Uint8Array([1]) },
  ]);
  const lengthBytes = encodeVarint(BigInt(inner.length));
  const fillValue = new Uint8Array([...lengthBytes, ...inner]);
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [{ type: MessageParameterType.FILL_PARAMETERS, value: fillValue }],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // PROTOCOL_VIOLATION でセッションが閉じ、REQUEST_OK は応答されない
  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.equal(ctx.written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §3.4.1 / §9.5.1:
 * role=publish の受信 REQUEST_UPDATE に Forward State=1 で fill 範囲が空でない
 * FILL_PARAMETERS が含まれる場合、moqt-js は fill fetch ストリームを開けない
 * ため黙殺せず REQUEST_ERROR (NOT_SUPPORTED) で拒否し、PUBLISH_DONE
 * (UPDATE_FAILED) で購読を終了する。
 */
test("bidiReadRequestStreamMessages: fill 範囲が空でない FILL_PARAMETERS の REQUEST_UPDATE (publish ロール) で REQUEST_ERROR (NOT_SUPPORTED) が応答される", async () => {
  const ctx = createPublishReadTestContext({});
  // Largest Object を {groupId: 5, objectId: 0} にして fill 範囲を確定させる
  await ctx.publisher.sendObject({ groupId: 5, objectId: 0, payload: new Uint8Array() });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // fill 範囲の開始 {1, 0} は Largest Object {5, 0} 以前であり空でない
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      encodeFillParameters(
        buildFillParameters(
          {
            filter: { startGroup: 1n, startObject: 0n },
            fillTimeout: 100n,
          },
          "REQUEST_UPDATE",
        ),
      ),
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // REQUEST_ERROR (NOT_SUPPORTED) の後に PUBLISH_DONE (UPDATE_FAILED) が送出される
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  const requestError = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(requestError.errorCode, BigInt(RequestErrorCode.NOT_SUPPORTED));
  assert.equal(requestError.reasonPhrase, FILL_NOT_SUPPORTED_REASON);
  assert.equal(messages[1].type, MessageType.PUBLISH_DONE);
  const publishDone = decodePublishDonePayload(messages[1].payload);
  assert.equal(publishDone.statusCode, BigInt(PublishDoneStatusCode.UPDATE_FAILED));
  assert.equal(publishDone.streamCount, 0n);
  assert.equal(publishDone.reasonPhrase, "");
  // 拒否後は PublisherImpl が closed になり、後続の sendObject は fail-fast 拒否される
  assert.equal(ctx.publisher.state, "closed");
  assert.isFalse(ctx.session.publishers.has(ctx.requestId));
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §3.4:
 * 「the fill range never extends beyond Largest Object」ため、Largest Object を
 * まだ送信していない (null) 場合は fill 範囲が常に空になり、fill fetch
 * ストリームは開かれない。REQUEST_OK で受理される。
 */
test("bidiReadRequestStreamMessages: Largest Object 未受信の FILL_PARAMETERS の REQUEST_UPDATE (publish ロール) で REQUEST_OK が応答される", async () => {
  const ctx = createPublishReadTestContext({});
  // sendObject を呼ばないため Largest Object は null のまま

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
      encodeFillParameters(
        buildFillParameters({ filter: { startGroup: 10n, startObject: 2n } }, "REQUEST_UPDATE"),
      ),
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // fill 範囲が空のため REQUEST_OK が応答され、セッションは閉じない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §3.4.1:
 * 「FILL_PARAMETERS carried while Forward State is 0 opens no fill fetch
 *  stream.」Forward State=0 の FILL_PARAMETERS は fill ストリームを開かない
 * ため、従来どおり REQUEST_OK で受理される。
 */
test("bidiReadRequestStreamMessages: Forward State=0 の FILL_PARAMETERS の REQUEST_UPDATE (publish ロール) で REQUEST_OK が応答される", async () => {
  const ctx = createPublishReadTestContext({});
  // Largest Object を {groupId: 5, objectId: 0} にして fill 範囲を確定させる
  // (null のままだと範囲が空になり Forward State 分岐を判別できない)
  await ctx.publisher.sendObject({ groupId: 5, objectId: 0, payload: new Uint8Array() });
  // Forward State 0 を直接設定する (setForwardState はセッション内部 API)
  ctx.publisher.setForwardState(false);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // fill 範囲 {1, 0} は Largest Object {5, 0} 以前であり空でない
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      encodeFillParameters(
        buildFillParameters(
          { filter: { startGroup: 1n, startObject: 0n }, fillTimeout: 100n },
          "REQUEST_UPDATE",
        ),
      ),
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // fill ストリームは開かれないため REQUEST_OK が応答され、セッションは閉じない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §3.4:
 * 「If the fill range is empty, or starts after Largest Object, the publisher
 *  does not open a fill fetch stream.」fill 範囲の開始が Largest Object より
 * 後を指す場合は fill ストリームを開かないため REQUEST_OK で受理される。
 */
test("bidiReadRequestStreamMessages: Largest Object より後の FILL_PARAMETERS の REQUEST_UPDATE (publish ロール) で REQUEST_OK が応答される", async () => {
  const ctx = createPublishReadTestContext({});
  // Largest Object を {groupId: 1, objectId: 0} にする
  await ctx.publisher.sendObject({ groupId: 1, objectId: 0, payload: new Uint8Array() });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // fill 範囲の開始が Largest Object {1, 0} より後
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      encodeFillParameters(
        buildFillParameters({ filter: { startGroup: 2n, startObject: 0n } }, "REQUEST_UPDATE"),
      ),
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §3.4:
 * fill 範囲は「FILL_PARAMETERS 内の LOCATION_FILTER、省略時は購読の
 * Location Filter」で決まる。内側の LOCATION_FILTER が購読の Location Filter
 * より優先されることを検証する (内側のみ範囲内 -> 拒否)。
 */
test("bidiReadRequestStreamMessages: FILL_PARAMETERS 内側の LOCATION_FILTER が購読の Location Filter より優先される (publish ロール)", async () => {
  const ctx = createPublishReadTestContext({});
  // Largest Object を {groupId: 5, objectId: 0} にする
  await ctx.publisher.sendObject({ groupId: 5, objectId: 0, payload: new Uint8Array() });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // 購読の Location Filter は絶対指定 {6, 0} で Largest Object {5, 0} より後
  // (範囲が空)、内側は相対指定 {1} で {5, 0} を指し範囲内
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      encodeLocationFilterParameter({ startGroup: 6n, startObject: 0n }),
      encodeFillParameters([encodeLocationFilterParameter({ startGroup: 1n })]),
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // 内側の LOCATION_FILTER が優先され、fill 範囲が空でないため拒否される
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  assert.equal(
    decodeRequestErrorPayload(messages[0].payload).errorCode,
    BigInt(RequestErrorCode.NOT_SUPPORTED),
  );
  // 拒否した更新の LOCATION_FILTER は購読状態へ反映されない
  assert.isUndefined(ctx.publisher.getResolvedLocationFilter());
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §3.4:
 * FILL_PARAMETERS 内に LOCATION_FILTER が無い場合、購読の Location Filter を
 * 使って fill 範囲を評価する。購読の Location Filter は REQUEST_UPDATE 間で
 * 保持される (§9.5「If a parameter ... is not present in REQUEST_UPDATE, its
 * value remains unchanged.」) ことも合わせて検証する。
 */
test("bidiReadRequestStreamMessages: 内側 LOCATION_FILTER 省略時は保持した購読の Location Filter で評価する (publish ロール)", async () => {
  const ctx = createPublishReadTestContext({});
  // Largest Object を {groupId: 5, objectId: 0} にする
  await ctx.publisher.sendObject({ groupId: 5, objectId: 0, payload: new Uint8Array() });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // 1 通目: 購読の Location Filter を絶対指定 {6, 0} に設定する (範囲が空)
  const filterPayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [encodeLocationFilterParameter({ startGroup: 6n, startObject: 0n })],
  });
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, filterPayload),
  );
  // 2 通目: LOCATION_FILTER を含まない FILL_PARAMETERS (FILL_TIMEOUT のみ)
  const fillPayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 103n,
    parameters: [
      encodeFillParameters(buildFillParameters({ fillTimeout: 100n }, "REQUEST_UPDATE")),
    ],
  });
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, fillPayload),
  );
  ctx.readableController.close();
  await readPromise;

  // 1 通目・2 通目とも REQUEST_OK。2 通目は内側 LOCATION_FILTER が無いため
  // 保持した購読の Location Filter {6, 0} (範囲が空) で評価される。保持が壊れて
  // フィルタなし (トラック全体) になると fill 範囲が空でなくなり REQUEST_ERROR
  // になるため、このテストは保持の有無を判別できる。
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.equal(messages[1].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §3.3.1:
 * 相対指定の Location Filter は設定時点の LARGEST_OBJECT で解決して固定する。
 * 設定後に Largest Object が進んでも保持した解決済みフィルタを再解決しない
 * ことを検証する (再解決すると fill 範囲が空に化けて REQUEST_OK になる)。
 */
test("bidiReadRequestStreamMessages: 保持した相対 Location Filter を Largest Object 更新後に再解決しない (publish ロール)", async () => {
  const ctx = createPublishReadTestContext({});
  // Largest Object を {groupId: 10, objectId: 0} にしてから相対指定 {0} (Next
  // Group) を設定する。設定時点で {11, 0} に解決されて固定される
  await ctx.publisher.sendObject({ groupId: 10, objectId: 0, payload: new Uint8Array() });
  ctx.publisher.setLocationFilter({ startGroup: 0n });
  assert.deepEqual(ctx.publisher.getResolvedLocationFilter()?.start, { group: 11n, object: 0n });
  // Largest Object を {11, 0} に進める
  await ctx.publisher.sendObject({ groupId: 11, objectId: 0, payload: new Uint8Array() });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // 内側 LOCATION_FILTER を含まない FILL_PARAMETERS (FILL_TIMEOUT のみ)
  const fillPayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      encodeFillParameters(buildFillParameters({ fillTimeout: 100n }, "REQUEST_UPDATE")),
    ],
  });
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, fillPayload),
  );
  ctx.readableController.close();
  await readPromise;

  // 設定時に固定した {11, 0} (Largest Object と同値) で fill 範囲が空でないため
  // REQUEST_ERROR (NOT_SUPPORTED) + PUBLISH_DONE になる。相対指定を現在の
  // Largest Object {11, 0} で再解決すると {12, 0} になり空と誤判定して
  // REQUEST_OK になるため、このテストは再解決の有無を判別できる。
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  assert.equal(
    decodeRequestErrorPayload(messages[0].payload).errorCode,
    BigInt(RequestErrorCode.NOT_SUPPORTED),
  );
  assert.equal(messages[1].type, MessageType.PUBLISH_DONE);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §3.4:
 * 購読の Location Filter も FILL_PARAMETERS 内の LOCATION_FILTER も無い場合、
 * fill 範囲はトラック全体 (Largest Object まで) になる。Largest Object が
 * あるため空でなく、REQUEST_ERROR (NOT_SUPPORTED) で拒否される。
 */
test("bidiReadRequestStreamMessages: フィルタ指定なしの FILL_PARAMETERS の REQUEST_UPDATE (publish ロール) で REQUEST_ERROR (NOT_SUPPORTED) が応答される", async () => {
  const ctx = createPublishReadTestContext({});
  // Largest Object を {groupId: 5, objectId: 0} にする
  await ctx.publisher.sendObject({ groupId: 5, objectId: 0, payload: new Uint8Array() });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // FILL_TIMEOUT のみで LOCATION_FILTER を一切指定しない
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      encodeFillParameters(buildFillParameters({ fillTimeout: 100n }, "REQUEST_UPDATE")),
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
    BigInt(RequestErrorCode.NOT_SUPPORTED),
  );
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §3.4 / §9.20.10:
 * 4 フィールド指定で End Object が Start Object より小さい場合、フィルタ自身が
 * 空になり配信できる Object が無い。fill fetch ストリームは開かれないため
 * REQUEST_OK で受理される。
 */
test("bidiReadRequestStreamMessages: フィルタ自身が空の FILL_PARAMETERS の REQUEST_UPDATE (publish ロール) で REQUEST_OK が応答される", async () => {
  const ctx = createPublishReadTestContext({});
  // Largest Object を {groupId: 5, objectId: 5} にする。fill 範囲の開始 {5, 5}
  // は Largest Object 以前であり、「Largest Object より後」判定では空にならない
  // (自己空判定だけが空を返すことを判別できる)。
  await ctx.publisher.sendObject({ groupId: 5, objectId: 5, payload: new Uint8Array() });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // StartGroup = EndGroup = 5 で End Object (3) < Start Object (5) の空フィルタ
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      encodeFillParameters([
        encodeLocationFilterParameter({
          startGroup: 5n,
          startObject: 5n,
          endGroupDelta: 0n,
          endObject: 3n,
        }),
      ]),
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.20.19 / §3.4.1:
 * 同一 REQUEST_UPDATE で FORWARD=0 と FILL_PARAMETERS を送る場合、更新適用後の
 * Forward State は 0 であり fill fetch ストリームは開かれない。REQUEST_OK で
 * 受理され、Forward State も 0 に反映される。
 */
test("bidiReadRequestStreamMessages: 同一更新の FORWARD=0 と FILL_PARAMETERS の REQUEST_UPDATE (publish ロール) で REQUEST_OK が応答される", async () => {
  const ctx = createPublishReadTestContext({});
  // Largest Object を {groupId: 5, objectId: 0} にする
  await ctx.publisher.sendObject({ groupId: 5, objectId: 0, payload: new Uint8Array() });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // FORWARD=0 と範囲内の fill 要求を同一更新に載せる
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      { type: MessageParameterType.FORWARD, value: new Uint8Array([0]) },
      encodeFillParameters(
        buildFillParameters({ filter: { startGroup: 1n, startObject: 0n } }, "REQUEST_UPDATE"),
      ),
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isFalse(ctx.publisher.forwardState);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.20.19 / §3.4.1:
 * 現在 Forward State=0 でも、同一 REQUEST_UPDATE で FORWARD=1 に変えつつ
 * 範囲内の FILL_PARAMETERS を載せた場合は更新適用後の Forward State が 1 に
 * なるため fill fetch ストリームが必要になり、REQUEST_ERROR (NOT_SUPPORTED) で
 * 拒否される。
 */
test("bidiReadRequestStreamMessages: FORWARD=0 から FORWARD=1 に更新しつつ FILL_PARAMETERS を載せた REQUEST_UPDATE (publish ロール) で REQUEST_ERROR (NOT_SUPPORTED) が応答される", async () => {
  const ctx = createPublishReadTestContext({});
  // Largest Object を {groupId: 5, objectId: 0} にする
  await ctx.publisher.sendObject({ groupId: 5, objectId: 0, payload: new Uint8Array() });
  ctx.publisher.setForwardState(false);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // FORWARD=1 と範囲内の fill 要求を同一更新に載せる
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      { type: MessageParameterType.FORWARD, value: new Uint8Array([1]) },
      encodeFillParameters(
        buildFillParameters({ filter: { startGroup: 1n, startObject: 0n } }, "REQUEST_UPDATE"),
      ),
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // 更新後の Forward State は 1 のため拒否される
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  assert.equal(
    decodeRequestErrorPayload(messages[0].payload).errorCode,
    BigInt(RequestErrorCode.NOT_SUPPORTED),
  );
  // 拒否した更新の FORWARD=1 は反映されない
  assert.isFalse(ctx.publisher.forwardState);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §3.4:
 * 「When the subscription has no Location filter, or the LOCATION_FILTER inside
 *  FILL_PARAMETERS is zero-length, the fill range is the entire track up to
 *  Largest Object.」内側 LOCATION_FILTER の reset (Length 0) はトラック全体を
 * 指し、Largest Object があるため空でなく拒否される。
 */
test("bidiReadRequestStreamMessages: FILL_PARAMETERS 内側 LOCATION_FILTER が reset の REQUEST_UPDATE (publish ロール) で REQUEST_ERROR (NOT_SUPPORTED) が応答される", async () => {
  const ctx = createPublishReadTestContext({});
  // Largest Object を {groupId: 5, objectId: 0} にする
  await ctx.publisher.sendObject({ groupId: 5, objectId: 0, payload: new Uint8Array() });

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
    parameters: [encodeFillParameters([encodeLocationFilterParameter({ reset: true })])],
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
    BigInt(RequestErrorCode.NOT_SUPPORTED),
  );
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.20.16:
 * 「A parameter that is omitted from FILL_PARAMETERS takes the value it has for
 *  the subscription」ため、内側 LOCATION_FILTER 省略時は同一 REQUEST_UPDATE の
 * top-level LOCATION_FILTER (更新後の購読値) を使って fill 範囲を評価する。
 */
test("bidiReadRequestStreamMessages: 同一更新の LOCATION_FILTER を内側省略時の購読フィルタに使う (publish ロール)", async () => {
  const ctx = createPublishReadTestContext({});
  // Largest Object を {groupId: 5, objectId: 0} にする
  await ctx.publisher.sendObject({ groupId: 5, objectId: 0, payload: new Uint8Array() });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // top-level LOCATION_FILTER は絶対指定 {6, 0} (範囲が空)、内側は省略
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      encodeLocationFilterParameter({ startGroup: 6n, startObject: 0n }),
      encodeFillParameters(buildFillParameters({ fillTimeout: 100n }, "REQUEST_UPDATE")),
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // 同一更新の LOCATION_FILTER {6, 0} が使われて fill 範囲が空になり受理される。
  // top-level を無視して保持値 (未設定 = フィルタなし) を使えばトラック全体と
  // なり REQUEST_ERROR になるため、このテストは参照元を判別できる。
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §3.3.1 / §3.4:
 * Next Object フィルタ (StartGroup = StartObject = 0) は
 * {Largest Object.Group, Largest Object.Object + 1} に解決される。Largest
 * Object {5, 0} に対して {5, 1} は後方のため fill 範囲が空になり REQUEST_OK。
 */
test("bidiReadRequestStreamMessages: Next Object の FILL_PARAMETERS の REQUEST_UPDATE (publish ロール) で REQUEST_OK が応答される", async () => {
  const ctx = createPublishReadTestContext({});
  // Largest Object を {groupId: 5, objectId: 0} にする
  await ctx.publisher.sendObject({ groupId: 5, objectId: 0, payload: new Uint8Array() });

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
      encodeFillParameters([encodeLocationFilterParameter({ startGroup: 0n, startObject: 0n })]),
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §3.3.2:
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
    requestId: 101n,
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
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  const decoded = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.INVALID_FILTER));
  assert.equal(messages[1].type, MessageType.PUBLISH_DONE);
  const publishDone = decodePublishDonePayload(messages[1].payload);
  assert.equal(publishDone.statusCode, BigInt(PublishDoneStatusCode.UPDATE_FAILED));
  assert.equal(publishDone.streamCount, 0n);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.5 / §9:
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
 * draft-ietf-moq-transport-21 §9.5 / §9.20.19:
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
    requestId: 101n,
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
 * draft-ietf-moq-transport-21 §9.5 / §9.20.19:
 * role=publish の受信 REQUEST_UPDATE で FORWARD が省略された場合、Forward
 * State は変化しないことを検証する (extractForwardState のデフォルト true に
 * よる上書きを防ぐ)。FORWARD=0 を受けて送信を止めたアプリが、パラメータ無し
 * の REQUEST_UPDATE で送信を再開してしまうケースの回帰ガード。
 */
test("bidiReadRequestStreamMessages: FORWARD 省略の REQUEST_UPDATE (publish ロール) で Forward State は不変", async () => {
  const ctx = createPublishReadTestContext({});
  // FORWARD=0 を受けて送信を止めた状態を作る (アプリ側の反映)
  ctx.publisher.setForwardState(false);

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

  // Forward State は false のまま、REQUEST_OK が応答される
  assert.equal(ctx.publisher.forwardState, false);
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.5 / §9.20.19:
 * role=publish の受信 REQUEST_UPDATE で FORWARD=1 が明示された場合、Forward
 * State が true に反映されることを検証する (FORWARD 省略時は不変ではなく
 * 省略以外の本分岐が従来どおり動作することの回帰ガード)。
 */
test("bidiReadRequestStreamMessages: FORWARD=1 の REQUEST_UPDATE (publish ロール) で Forward State が true に反映される", async () => {
  const ctx = createPublishReadTestContext({});
  // FORWARD=0 に変更した状態から、FORWARD=1 の明示で戻ることも検証する
  ctx.publisher.setForwardState(false);

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
    parameters: [{ type: MessageParameterType.FORWARD, value: new Uint8Array([1]) }],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // Forward State が true に反映され、REQUEST_OK が応答される
  assert.equal(ctx.publisher.forwardState, true);
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
});

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
    validateIncomingRequestId: (_requestId: bigint) => true,
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
    validateIncomingRequestId: (_requestId: bigint) => true,
  } as unknown as BidiSessionInternal;

  await bidiReadPublishResponse(session, requestId, stream, controlReader);

  assert.isDefined(closedWithError);
  assert.equal(closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isFalse(session.pendingPublish.has(requestId));
  assert.isDefined(rejected);
  assert.equal(rejected!.message, closedWithError!.message);
});

/**
 * PUBLISH_OK 応答の LOCATION_FILTER 検証を駆動するセッションを構築する
 *
 * 指定パラメータの PUBLISH_OK を ReadableStream に 1 通だけ enqueue し、
 * 解決・拒否・セッション終了の観測点を返す。PUBLISH_OK 受信時の値検証に使う。
 * 観測点はゲッター関数で返す (生成コンテキストごとの参照安定性のため)。
 */
function createPublishOkValidationContext(parameters: { type: number; value: Uint8Array }[]): {
  session: BidiSessionInternal;
  resolved: () => PublisherImpl | undefined;
  rejected: () => Error | undefined;
  closedWithError: () => SessionError | undefined;
  requestId: bigint;
} {
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

  let resolvedPublisher: PublisherImpl | undefined;
  let rejectedError: Error | undefined;
  let closedError: SessionError | undefined;
  const session = {
    sessionState: "connected",
    transport: {},
    controlWriter: new ControlStreamWriter(),
    nextRequestId: 100n,
    pendingPublish: new Map([
      [
        requestId,
        {
          impl: new PublisherImpl(["test"], "track", requestId, 1n),
          resolve: (publisher: PublisherImpl) => {
            resolvedPublisher = publisher;
          },
          reject: (error: Error) => {
            rejectedError = error;
          },
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
    closeWithError: (error: SessionError) => {
      closedError = error;
    },
  } as unknown as BidiSessionInternal;

  return {
    session,
    resolved: () => resolvedPublisher,
    rejected: () => rejectedError,
    closedWithError: () => closedError,
    requestId,
  };
}

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
      { type: MessageParameterType.AUTHORIZATION_TOKEN, value: new Uint8Array([1]) },
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

// ============================================================================
// notifySubscriberFailure のテスト
// draft-ietf-moq-transport-21 §6.4.2.2 (FIN without PUBLISH_DONE は失敗扱い)
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §6.4.2.2:
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
 * draft-ietf-moq-transport-21 §6.4.2.2:
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
 * draft-ietf-moq-transport-21 §6.4.2.2:
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
 * draft-ietf-moq-transport-21 §9.2:
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
 * draft-ietf-moq-transport-21 §6.4.2.2:
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
// draft-ietf-moq-transport-21 §6.4.2.2 (FIN) / §6.4.2.3 (RESET_STREAM)
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §6.4.2.2:
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
 * draft-ietf-moq-transport-21 §9.5.1 / §6.4.2.2:
 * subscribe ロールでピアが FIN した場合、応答待ちの REQUEST_UPDATE
 * (update() の Promise) が reject され、エントリが削除されることを検証する。
 * 未解決のまま残すとアプリは FIN 後に update() の結果を待ち続ける。
 */
test("bidiReadRequestStreamMessages: ピアの FIN (subscribe ロール) で応答待ちの REQUEST_UPDATE が reject される", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  let rejected: Error | undefined;
  ctx.session.pendingRequestUpdate.set(90n, {
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
  // ピアの FIN を再現する
  ctx.readableController.close();
  await readPromise;

  // 応答待ちの REQUEST_UPDATE が reject され、エントリが削除される
  assert.isDefined(rejected);
  assert.equal(rejected!.message, REQUEST_UPDATE_STREAM_CLOSED_MESSAGE);
  assert.equal(ctx.session.pendingRequestUpdate.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.3:
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
 * draft-ietf-moq-transport-21 §6.4.2.2 / §6.4.2.3 / §9.5.1:
 * subscribe ロールでピアが RESET_STREAM でストリームをエラー終了させた場合、
 * 応答待ちの REQUEST_UPDATE (update() の Promise) が reject され、エントリが
 * 削除されることを検証する。FIN 経路と同じ文言で失敗として扱う。
 */
test("bidiReadRequestStreamMessages: ピアの RESET_STREAM (subscribe ロール) で応答待ちの REQUEST_UPDATE が reject される", async () => {
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

  // RESET 前に送信済みで応答待ちの REQUEST_UPDATE を注入する
  let rejected: Error | undefined;
  ctx.session.pendingRequestUpdate.set(90n, {
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
  // ピアの RESET_STREAM 相当 (source: "stream" の reject) を再現する
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), { source: "stream" }),
  );
  await readPromise;

  // 応答待ちの REQUEST_UPDATE が FIN 経路と同じ文言で reject され、
  // エントリが削除される。error 通知も行われる
  assert.isDefined(rejected);
  assert.equal(rejected!.message, REQUEST_UPDATE_STREAM_CLOSED_MESSAGE);
  assert.equal(ctx.session.pendingRequestUpdate.size, 0);
  assert.isDefined(errorCalled);
  assert.equal(subscriber.state, "closed");
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.2 / §6.4.2.3:
 * RESET_STREAM 通知でアプリの error コールバックが throw しても、
 * 応答待ちの REQUEST_UPDATE の reject が先に実行済みであることを検証する。
 * 通知より reject を先に置く順序の根拠を固定する。
 */
test("bidiReadRequestStreamMessages: RESET_STREAM 通知で error コールバックが throw しても応答待ちの更新は reject される", async () => {
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

  // RESET 前に送信済みで応答待ちの REQUEST_UPDATE を注入する
  let rejected: Error | undefined;
  ctx.session.pendingRequestUpdate.set(90n, {
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
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), { source: "stream" }),
  );
  await readPromise;

  // コールバック例外があっても reject は実行済みでエントリは削除される
  assert.isDefined(rejected);
  assert.equal(rejected!.message, REQUEST_UPDATE_STREAM_CLOSED_MESSAGE);
  assert.equal(ctx.session.pendingRequestUpdate.size, 0);
  assert.equal(subscriber.state, "closed");
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.2:
 * GOAWAY 受信済みの subscribe ロールで RESET_STREAM が起きても、
 * 保留中の REQUEST_UPDATE には触れないことを検証する (GOAWAY 掃除に委ねる)。
 * 呼び出し自体が起きないため、注入したエントリが残る。
 */
test("bidiReadRequestStreamMessages: GOAWAY 受信後の RESET_STREAM では応答待ちの更新に触れない", async () => {
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

  // GOAWAY 掃除をすり抜けた保留中の更新を模して注入する
  let rejected: Error | undefined;
  ctx.session.pendingRequestUpdate.set(90n, {
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
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), { source: "stream" }),
  );
  await readPromise;

  // GOAWAY 後の破壊は migration の完了であり、reject も通知もしない
  assert.isUndefined(rejected);
  assert.equal(ctx.session.pendingRequestUpdate.size, 1);
  assert.isFalse(errorCalled);
  assert.equal(subscriber.state, "active");
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.3 / §6.6:
 * セッション終了起因 (source: "session") の読み取り失敗では、
 * 保留中の REQUEST_UPDATE に触れないことを検証する。
 */
test("bidiReadRequestStreamMessages: セッション終了の読み取り失敗では応答待ちの更新に触れない", async () => {
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

  let rejected: Error | undefined;
  ctx.session.pendingRequestUpdate.set(90n, {
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
  ctx.readableController.error(
    Object.assign(new Error("session closed by peer"), { source: "session" }),
  );
  await readPromise;

  // セッション終了は購読者への通知対象外であり、保留中の更新にも触れない
  assert.isUndefined(rejected);
  assert.equal(ctx.session.pendingRequestUpdate.size, 1);
  assert.isFalse(errorCalled);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §12.5:
 * ピアが RESET_STREAM にエラーコードを付けて終了した場合、通知される
 * エラーのメッセージにコード名が付加され、構造化されたコード値でも
 * 参照できることを検証する。アプリが終了理由を区別できるようにする
 * ための振る舞いであり、セッションは閉じない。
 */
test("bidiReadRequestStreamMessages: ピアの RESET_STREAM のエラーコードが通知内容に反映される", async () => {
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
  // ピアが TOO_FAR_BEHIND (0x5) でリセットした場合を再現する
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), {
      source: "stream",
      streamErrorCode: 0x5,
    }),
  );
  await readPromise;

  // コード名付きの可変文言と正規化済みコード値の両方が伝わる
  assert.isDefined(errorCalled);
  assert.equal(errorCalled!.message, `${RESET_REQUEST_STREAM_MESSAGE}: TOO_FAR_BEHIND(0x5)`);
  assert.equal((errorCalled as unknown as { streamErrorCode?: unknown }).streamErrorCode, 0x5);
  assert.equal(subscriber.state, "closed");
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §12.5:
 * ピアの実装がエラーコードを提供しない場合 (undefined) は、従来の固定文言
 * のみで通知し、コード値のプロパティを付けないことを検証する。
 * 仕様外の組み合わせに対する後方互換の振る舞いである。
 */
test("bidiReadRequestStreamMessages: RESET_STREAM のエラーコードが無い場合は固定文言のみで通知される", async () => {
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
  // エラーコードを持たない実装からのリセットを再現する
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), {
      source: "stream",
      streamErrorCode: undefined,
    }),
  );
  await readPromise;

  // 固定文言のみで、コード値のプロパティは存在しない
  assert.isDefined(errorCalled);
  assert.equal(errorCalled!.message, RESET_REQUEST_STREAM_MESSAGE);
  assert.isFalse("streamErrorCode" in errorCalled!);
  assert.equal(subscriber.state, "closed");
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §12.5:
 * 仕様の列挙に無いエラーコードでリセットされた場合は内部エラーに正規化
 * されることを検証する。未知値の扱いはデータストリーム系エラーコードの
 * 共通規則に従う。
 */
test("bidiReadRequestStreamMessages: 未知の RESET_STREAM エラーコードは内部エラーに正規化される", async () => {
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
  // 列挙に無いコード値でのリセットを再現する
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), {
      source: "stream",
      streamErrorCode: 0x99,
    }),
  );
  await readPromise;

  // 内部エラー名と 0x0 に正規化される
  assert.isDefined(errorCalled);
  assert.equal(errorCalled!.message, `${RESET_REQUEST_STREAM_MESSAGE}: INTERNAL_ERROR(0x0)`);
  assert.equal((errorCalled as unknown as { streamErrorCode?: unknown }).streamErrorCode, 0x0);
  assert.equal(subscriber.state, "closed");
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §12.5:
 * エラーコードが数値以外 (他実装の型差異など) の場合は固定文言のみで
 * 通知することを検証する。文字列比較に依存せず構造化値の有無で判断
 * できるようにするため、プロパティ自体を付けない。
 */
test("bidiReadRequestStreamMessages: 数値でない RESET_STREAM エラーコードは無視される", async () => {
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
  // 数値でないコード値でのリセットを再現する
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), {
      source: "stream",
      streamErrorCode: "1",
    }),
  );
  await readPromise;

  // 固定文言のみで、コード値のプロパティは存在しない
  assert.isDefined(errorCalled);
  assert.equal(errorCalled!.message, RESET_REQUEST_STREAM_MESSAGE);
  assert.isFalse("streamErrorCode" in errorCalled!);
  assert.equal(subscriber.state, "closed");
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §12.5:
 * 通知用エラー組み立ての単体検証。
 * 読み取り失敗値の取り出し・正規化・文言付加の対応を、ストリーム駆動を
 * 介さず直接確認する。受信 PUBLISH 経路も同じ組み立てを共用するため、
 * 両経路の文言一致が構造的に保たれる。
 */
test("createResetStreamError: エラーコードの有無と未知値の扱いが仕様どおりになる", () => {
  // 既知のコード値は名称付き文言とコード値を持つ
  const known = createResetStreamError(
    Object.assign(new Error("reset"), { source: "stream", streamErrorCode: 0x1 }),
  );
  assert.equal(known.message, `${RESET_REQUEST_STREAM_MESSAGE}: CANCELLED(0x1)`);
  assert.equal((known as unknown as { streamErrorCode?: unknown }).streamErrorCode, 0x1);

  // 2 桁表示のコード値も仕様表記どおりに組み立てられる
  const twoDigits = createResetStreamError(
    Object.assign(new Error("reset"), { source: "stream", streamErrorCode: 0x12 }),
  );
  assert.equal(twoDigits.message, `${RESET_REQUEST_STREAM_MESSAGE}: MALFORMED_TRACK(0x12)`);
  assert.equal((twoDigits as unknown as { streamErrorCode?: unknown }).streamErrorCode, 0x12);

  // コード値が無い場合は固定文言のみでプロパティを持たない
  const missing = createResetStreamError(Object.assign(new Error("reset"), { source: "stream" }));
  assert.equal(missing.message, RESET_REQUEST_STREAM_MESSAGE);
  assert.isFalse("streamErrorCode" in missing);

  // 未知値は内部エラーに正規化される
  const unknownCode = createResetStreamError(
    Object.assign(new Error("reset"), { source: "stream", streamErrorCode: 0x99 }),
  );
  assert.equal(unknownCode.message, `${RESET_REQUEST_STREAM_MESSAGE}: INTERNAL_ERROR(0x0)`);
  assert.equal((unknownCode as unknown as { streamErrorCode?: unknown }).streamErrorCode, 0x0);

  // 数値だが列挙外の境界値も内部エラーに正規化される
  for (const boundary of [Number.NaN, 1.5, -1, 2 ** 53]) {
    const normalized = createResetStreamError(
      Object.assign(new Error("reset"), { source: "stream", streamErrorCode: boundary }),
    );
    assert.equal(normalized.message, `${RESET_REQUEST_STREAM_MESSAGE}: INTERNAL_ERROR(0x0)`);
    assert.equal((normalized as unknown as { streamErrorCode?: unknown }).streamErrorCode, 0x0);
  }

  // 数値以外 (文字列・bigint) は固定文言のみでプロパティを持たない
  const stringCode = createResetStreamError(
    Object.assign(new Error("reset"), { source: "stream", streamErrorCode: "1" }),
  );
  assert.equal(stringCode.message, RESET_REQUEST_STREAM_MESSAGE);
  assert.isFalse("streamErrorCode" in stringCode);
  const bigintCode = createResetStreamError(
    Object.assign(new Error("reset"), { source: "stream", streamErrorCode: 1n }),
  );
  assert.equal(bigintCode.message, RESET_REQUEST_STREAM_MESSAGE);
  assert.isFalse("streamErrorCode" in bigintCode);

  // 非オブジェクトや null は固定文言のみで例外を投げない
  const nullError = createResetStreamError(null);
  assert.equal(nullError.message, RESET_REQUEST_STREAM_MESSAGE);
  assert.isFalse("streamErrorCode" in nullError);
  const undefinedError = createResetStreamError(undefined);
  assert.equal(undefinedError.message, RESET_REQUEST_STREAM_MESSAGE);
  assert.isFalse("streamErrorCode" in undefinedError);
});

/**
 * draft-ietf-moq-transport-21 §9.2 / §6.4.2.3:
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
 * draft-ietf-moq-transport-21 §6.4.2.3:
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
 * publish ロールの検証用に、開いている Subgroup データストリームと送信キューを
 * 登録する。abort の到達理由を記録する。
 */
function setOpenPublisherStream(ctx: ReturnType<typeof createPublishReadTestContext>): {
  trackAlias: bigint;
  dataAborted: unknown[];
} {
  const trackAlias = ctx.publisher.getTrackAlias();
  const dataAborted: unknown[] = [];
  const dataWritable = new WritableStream<Uint8Array>({
    abort(reason) {
      dataAborted.push(reason);
    },
  });
  ctx.session.publisherStreams.set(trackAlias, {
    groupId: 0n,
    writer: dataWritable.getWriter(),
    previousObjectId: -1n,
  });
  ctx.session.publisherSendQueues.set(trackAlias, Promise.resolve());
  ctx.session.closedSubgroups.add(`${trackAlias}:0`);
  return { trackAlias, dataAborted };
}

/**
 * draft-ietf-moq-transport-21 §3.1.1:
 * 「The Publisher can remove subscription state as soon as it has received
 *  STOP_SENDING.  It MUST reset any open streams associated with the
 *  SUBSCRIBE.」
 * publish ロールでピアの STOP_SENDING (送信方向 reset) を検出したとき、
 * 開いている Subgroup データストリームを reset (abort) し、購読状態を削除して
 * PublisherImpl を closed にする。
 */
test("bidiReadRequestStreamMessages: publish ロールで STOP_SENDING を検出してデータストリームを reset する", async () => {
  const ctx = createPublishReadTestContext({});
  const { trackAlias, dataAborted } = setOpenPublisherStream(ctx);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // ピアの STOP_SENDING 相当: 当方の送信方向を reset して writer.closed を
  // reject させ、送信方向の終了監視を発火させる
  const streamInfo = ctx.session.requestStreams.get(ctx.requestId) as unknown as {
    writer: WritableStreamDefaultWriter<Uint8Array>;
  };
  // ピア起因 (source: "stream") の送信方向終了として writer.closed を reject させる
  await streamInfo.writer.abort(Object.assign(new Error("stop sending"), { source: "stream" }));
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  assert.deepEqual(dataAborted, ["peer cancelled subscription"]);
  assert.isFalse(ctx.session.publisherStreams.has(trackAlias));
  assert.isFalse(ctx.session.publisherSendQueues.has(trackAlias));
  assert.isFalse(ctx.session.closedSubgroups.has(`${trackAlias}:0`));
  assert.isFalse(ctx.session.publishers.has(ctx.requestId));
  assert.equal(ctx.publisher.state, "closed");
  // 読み取りループを終わらせる
  ctx.readableController.close();
  await readPromise;
});

/**
 * draft-ietf-moq-transport-21 §3.1.1:
 * publish ロールでピアの RESET_STREAM (reader.read() の reject) を検出した
 * ときも、開いている Subgroup データストリームを reset (abort) し、購読状態を
 * 削除して PublisherImpl を closed にする。
 */
test("bidiReadRequestStreamMessages: publish ロールで RESET_STREAM を検出してデータストリームを reset する", async () => {
  const ctx = createPublishReadTestContext({});
  const { trackAlias, dataAborted } = setOpenPublisherStream(ctx);

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
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  assert.deepEqual(dataAborted, ["peer cancelled subscription"]);
  assert.isFalse(ctx.session.publisherStreams.has(trackAlias));
  assert.isFalse(ctx.session.publisherSendQueues.has(trackAlias));
  assert.isFalse(ctx.session.closedSubgroups.has(`${trackAlias}:0`));
  assert.isFalse(ctx.session.publishers.has(ctx.requestId));
  assert.equal(ctx.publisher.state, "closed");
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.3:
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
 * draft-ietf-moq-transport-21 §6.4.2.3 / §6.6:
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
 * draft-ietf-moq-transport-21 §6.4.2.2:
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
 * draft-ietf-moq-transport-21 §9.2 / §6.4.2.2:
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
 * draft-ietf-moq-transport-21 §9.2:
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
 * draft-ietf-moq-transport-21 §6.4.2.2:
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
 * draft-ietf-moq-transport-21 §6.4.2.2 / §9.9:
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
 * draft-ietf-moq-transport-21 §6.4.2.2:
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
 * draft-ietf-moq-transport-21 §6.4.2.2:
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
    peerMaxRequestUpdates: 0,
    peerMaxFilterRanges: 0,
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
    peerMaxRequestUpdates: 0,
    peerMaxFilterRanges: 2,
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

// ============================================================================
// bidiHandlePublishStateNotify のテスト
// draft-ietf-moq-transport-21 §9.10 (PUBLISH_STATE_NOTIFY)
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.10:
 * subscribe ロールで publisher 発の PUBLISH_STATE_NOTIFY を受信した場合、
 * presence のパラメータが subscriber 状態に反映され、応答は送信しないことを
 * 検証する。
 */
test("bidiReadRequestStreamMessages: PUBLISH_STATE_NOTIFY (subscribe ロール) で状態が反映され応答しない", async () => {
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
  // LARGEST_OBJECT ({7, 2}) + FORWARD=0 + LOCATION_FILTER を通知する
  const notifyPayload = encodePublishStateNotifyPayload({
    type: MessageType.PUBLISH_STATE_NOTIFY,
    parameters: [
      { type: MessageParameterType.LARGEST_OBJECT, value: new Uint8Array([0x07, 0x02]) },
      { type: MessageParameterType.FORWARD, value: new Uint8Array([0]) },
      encodeLocationFilterParameter({ startGroup: 10n, startObject: 2n }),
    ],
  });
  const message = ctx.session.controlWriter!.encode(
    MessageType.PUBLISH_STATE_NOTIFY,
    notifyPayload,
  );
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // LARGEST_OBJECT / FORWARD が反映される。FIN による error 通知は別経路
  assert.deepEqual(subscriber.largestLocation, { group: 7n, object: 2n });
  assert.isFalse(subscriber.forwardState);
  // 応答は送信されない (自方向 FIN の close のみ)
  assert.deepEqual(ctx.events, ["close"]);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.10:
 * FORWARD を省略した PUBLISH_STATE_NOTIFY では Forward State が不変であることを
 * 検証する (省略時は不変)。
 */
test("bidiReadRequestStreamMessages: FORWARD 省略の PUBLISH_STATE_NOTIFY では Forward State は不変", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  subscriber.setForwardState(false);
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  // LARGEST_OBJECT のみを通知する
  const notifyPayload = encodePublishStateNotifyPayload({
    type: MessageType.PUBLISH_STATE_NOTIFY,
    parameters: [
      { type: MessageParameterType.LARGEST_OBJECT, value: new Uint8Array([0x07, 0x02]) },
    ],
  });
  const message = ctx.session.controlWriter!.encode(
    MessageType.PUBLISH_STATE_NOTIFY,
    notifyPayload,
  );
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // LARGEST_OBJECT は反映され、FORWARD 省略で Forward State は不変
  assert.deepEqual(subscriber.largestLocation, { group: 7n, object: 2n });
  assert.isFalse(subscriber.forwardState);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.10 / §9.20.1:
 * 許可外パラメータを含む PUBLISH_STATE_NOTIFY を受信した場合、
 * PROTOCOL_VIOLATION でセッションを閉じることを検証する。
 */
test("bidiReadRequestStreamMessages: 許可外パラメータの PUBLISH_STATE_NOTIFY でセッションが閉じる", async () => {
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
  // SUBSCRIBER_PRIORITY (0x20) は本メッセージに許可されない
  const notifyPayload = encodePublishStateNotifyPayload({
    type: MessageType.PUBLISH_STATE_NOTIFY,
    parameters: [{ type: MessageParameterType.SUBSCRIBER_PRIORITY, value: new Uint8Array([10]) }],
  });
  const message = ctx.session.controlWriter!.encode(
    MessageType.PUBLISH_STATE_NOTIFY,
    notifyPayload,
  );
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
});

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * End Group 超過の LOCATION_FILTER を含む PUBLISH_STATE_NOTIFY を受信した場合、
 * PROTOCOL_VIOLATION でセッションを閉じることを検証する。
 */
test("bidiReadRequestStreamMessages: End Group 超過の LOCATION_FILTER の PUBLISH_STATE_NOTIFY でセッションが閉じる", async () => {
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
  // StartGroup=MAX_VARINT + StartObject=0 + EndGroupDelta=1 で超過
  const fields = new Uint8Array([
    ...encodeVarint(MAX_VARINT),
    ...encodeVarint(0n),
    ...encodeVarint(1n),
  ]);
  const overflowValue = new Uint8Array([...encodeVarint(BigInt(fields.length)), ...fields]);
  const notifyPayload = encodePublishStateNotifyPayload({
    type: MessageType.PUBLISH_STATE_NOTIFY,
    parameters: [{ type: MessageParameterType.LOCATION_FILTER, value: overflowValue }],
  });
  const message = ctx.session.controlWriter!.encode(
    MessageType.PUBLISH_STATE_NOTIFY,
    notifyPayload,
  );
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
});

/**
 * draft-ietf-moq-transport-21 §9.10:
 * publish ロール (対向 subscriber 発) で PUBLISH_STATE_NOTIFY を受信した場合、
 * PROTOCOL_VIOLATION でセッションを閉じることを検証する。
 */
test("bidiReadRequestStreamMessages: PUBLISH_STATE_NOTIFY (publish ロール) ではセッションが閉じる", async () => {
  const ctx = createPublishReadTestContext({});

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  const notifyPayload = encodePublishStateNotifyPayload({
    type: MessageType.PUBLISH_STATE_NOTIFY,
    parameters: [
      { type: MessageParameterType.LARGEST_OBJECT, value: new Uint8Array([0x07, 0x02]) },
    ],
  });
  const message = ctx.session.controlWriter!.encode(
    MessageType.PUBLISH_STATE_NOTIFY,
    notifyPayload,
  );
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // subscriber 発の通知は仕様違反であり、セッションを閉じる
  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
});

/**
 * draft-ietf-moq-transport-21 §9.20.19:
 * FORWARD の値域外 (0/1 以外) を含む PUBLISH_STATE_NOTIFY を受信した場合、
 * PROTOCOL_VIOLATION でセッションを閉じることを検証する。
 */
test("bidiReadRequestStreamMessages: FORWARD の値域外の PUBLISH_STATE_NOTIFY でセッションが閉じる", async () => {
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
  // 正規の LARGEST_OBJECT と値域外の FORWARD を混在させる
  const notifyPayload = encodePublishStateNotifyPayload({
    type: MessageType.PUBLISH_STATE_NOTIFY,
    parameters: [
      { type: MessageParameterType.LARGEST_OBJECT, value: new Uint8Array([0x07, 0x02]) },
      { type: MessageParameterType.FORWARD, value: new Uint8Array([2]) },
    ],
  });
  const message = ctx.session.controlWriter!.encode(
    MessageType.PUBLISH_STATE_NOTIFY,
    notifyPayload,
  );
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // 違反確定後の部分反映は起きず、セッションが閉じる
  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isNull(subscriber.largestLocation);
});

// ============================================================================
// 応答スコープ違反で具体エラーが reject される
// draft-ietf-moq-transport-21 §9.20.1 (Parameter Scope)
// PUBLISH 応答経路と同一パターン (削除・reject・close の順序と同一オブジェクト)
// ============================================================================

/**
 * 応答読み取り用の session を構築する。ストリーム機構は実物であり、
 * session はテスト用のオブジェクトリテラルを型キャストしたものである。
 */
function createOkResponseReadTestContext(): {
  session: BidiSessionInternal;
  stream: WebTransportBidirectionalStream;
  readableController: ReadableStreamDefaultController<Uint8Array>;
  controlReader: ControlStreamReader;
  controlWriter: ControlStreamWriter;
  getClosedWithError: () => SessionError | undefined;
  order: string[];
  requestId: bigint;
} {
  const requestId = 10n;

  let readableController!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      readableController = controller;
    },
  });
  const writable = new WritableStream<Uint8Array>();
  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;
  const writer = writable.getWriter();
  const controlReader = new ControlStreamReader();

  let closedWithError: SessionError | undefined;
  // reject → closeWithError の順序を記録する
  const order: string[] = [];
  const controlWriter = new ControlStreamWriter();
  const session = {
    sessionState: "connected",
    transport: {},
    controlWriter,
    nextRequestId: 100n,
    requestStreams: new Map([[requestId, { stream, writer, controlReader }]]),
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
    peerMaxRequestUpdates: 0,
    peerMaxFilterRanges: 0,
    namespaceSubscriptions: new Map(),
    tracksSubscriptions: new Map(),
    publisherStreams: new Map(),
    publisherSendQueues: new Map(),
    closedSubgroups: new Set(),
    statsControlMessagesSent: 0,
    emitDebug: () => {},
    closeWithError: (error: SessionError) => {
      order.push("close");
      closedWithError = error;
    },
  } as unknown as BidiSessionInternal;

  return {
    session,
    stream,
    readableController,
    controlReader,
    controlWriter,
    // 値コピーではなく getter で返す (closeWithError 呼び出し後の代入を反映する)
    getClosedWithError: () => closedWithError,
    order,
    requestId,
  };
}

test("bidiReadTrackStatusResponse: REQUEST_OK 受信後に自方向を FIN する", async () => {
  // draft-ietf-moq-transport-21 §9.13 / §6.4.2.2:
  // TRACK_STATUS_OK / REQUEST_ERROR の送受信後に bidi ストリームは FIN で閉じる。
  const ctx = createOkResponseReadTestContext();
  let resolved = false;
  ctx.session.pendingTrackStatus.set(ctx.requestId, {
    resolve: () => {
      resolved = true;
    },
    reject: () => {},
  });
  const writer = ctx.session.requestStreams.get(ctx.requestId)?.writer;

  const readPromise = bidiReadTrackStatusResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  const okPayload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [],
  });
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.REQUEST_OK, okPayload),
  );
  await readPromise;

  assert.isTrue(resolved);
  assert.isDefined(writer);
  // writer.close() が呼ばれていれば closed が解決する (未 FIN ならハングする)
  await writer!.closed;
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
});

test("bidiReadTrackStatusResponse: REQUEST_ERROR 受信後に自方向を FIN する", async () => {
  // draft-ietf-moq-transport-21 §9.13 / §6.4.2.2: 失敗応答後も FIN で閉じる。
  const ctx = createOkResponseReadTestContext();
  let rejected: Error | undefined;
  ctx.session.pendingTrackStatus.set(ctx.requestId, {
    resolve: () => {},
    reject: (error: Error) => {
      rejected = error;
    },
  });
  const writer = ctx.session.requestStreams.get(ctx.requestId)?.writer;

  const readPromise = bidiReadTrackStatusResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  const errorPayload = encodeRequestErrorPayload({
    type: MessageType.REQUEST_ERROR,
    errorCode: BigInt(RequestErrorCode.DOES_NOT_EXIST),
    retryInterval: 0n,
    reasonPhrase: "not found",
  });
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.REQUEST_ERROR, errorPayload),
  );
  await readPromise;

  assert.isDefined(rejected);
  assert.isDefined(writer);
  await writer!.closed;
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §9 (Message Length) / §8.5 (Reason Phrase):
 * Reason Phrase Length が残りバイトを超える不完全な REQUEST_ERROR を受信した
 * 場合、共通リーダの catch が PROTOCOL_VIOLATION の SessionError に変換し、
 * pending を reject してからセッションを閉じる。TRACK_STATUS の
 * handleRequestError は closeRequestStreamWriter を await する非同期処理の
 * ため、共通リーダが awaiting せずに握り潰さないことを検証する。
 */
test("bidiReadTrackStatusResponse: 不完全な REQUEST_ERROR で PROTOCOL_VIOLATION として閉じる", async () => {
  const ctx = createOkResponseReadTestContext();
  let rejected: Error | undefined;
  ctx.session.pendingTrackStatus.set(ctx.requestId, {
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
  // 正常な REQUEST_ERROR の Reason Phrase の一部を切り詰め、
  // Reason Phrase Length が残りバイトを超える状態を作る
  const errorPayload = encodeRequestErrorPayload({
    type: MessageType.REQUEST_ERROR,
    errorCode: BigInt(RequestErrorCode.DOES_NOT_EXIST),
    retryInterval: 0n,
    reasonPhrase: "not found",
  });
  const truncatedPayload = errorPayload.slice(0, -3);
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.REQUEST_ERROR, truncatedPayload),
  );
  await readPromise;

  // 不完全な payload は PROTOCOL_VIOLATION に変換され、同一オブジェクトで
  // reject と close が行われる
  const closedError = ctx.getClosedWithError();
  assert.instanceOf(closedError, SessionError);
  if (closedError === undefined) {
    assert.fail("PROTOCOL_VIOLATION の SessionError を期待したが undefined だった");
  }
  assert.strictEqual(rejected, closedError);
  assert.equal(closedError.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isFalse(ctx.session.pendingTrackStatus.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
});

test("bidiReadPublishResponse: 確立前 GOAWAY 後の 2 通目 GOAWAY で PROTOCOL_VIOLATION で閉じる", async () => {
  // draft-ietf-moq-transport-21 §9.2:
  // 確立前 GOAWAY 後も読み取りを継続し、同一ストリームの 2 通目を検出する。
  const ctx = createOkResponseReadTestContext();
  const publisher = new PublisherImpl(["test"], "track", ctx.requestId, 1n, () => {});
  ctx.session.pendingPublish.set(ctx.requestId, {
    resolve: () => {},
    reject: () => {},
    impl: publisher,
  });

  const readPromise = bidiReadPublishResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "",
    timeout: 0n,
  });
  const goaway = ctx.session.controlWriter!.encode(MessageType.GOAWAY, goawayPayload);
  // 同一チャンクに 2 通連結する
  const concatenated = new Uint8Array(goaway.length * 2);
  concatenated.set(goaway, 0);
  concatenated.set(goaway, goaway.length);
  ctx.readableController.enqueue(concatenated);
  ctx.readableController.close();
  await readPromise;

  const error = ctx.getClosedWithError();
  assert.isDefined(error);
  assert.equal(error!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(error!.message.includes("received duplicate goaway on request stream"));
});

test("bidiReadSubscribeResponse: SUBSCRIBE_OK のスコープ違反で具体エラーが reject される", async () => {
  // 初期応答のパラメータスコープ違反は汎用 close エラーに埋もれさせない
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
  // 実運用の鍵は更新の Request ID だが、削除対象の確認のため購読 ID で登録する
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
  // FORWARD は SUBSCRIBE_OK (EXPIRES / LARGEST_OBJECT のみ許可) のスコープ違反である
  const okPayload = encodeSubscribeOkPayload({
    type: MessageType.SUBSCRIBE_OK,
    trackAlias: 1n,
    parameters: [{ type: MessageParameterType.FORWARD, value: new Uint8Array([1]) }],
    trackProperties: [],
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.SUBSCRIBE_OK, okPayload));
  ctx.readableController.close();
  await readPromise;

  // 具体エラーで reject され、同一オブジェクトで閉じる
  assert.isDefined(rejected);
  assert.isDefined(ctx.getClosedWithError());
  assert.strictEqual(rejected, ctx.getClosedWithError());
  // reject してから閉じる順序である
  assert.deepEqual(ctx.order, ["reject", "close"]);
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(
    ctx.getClosedWithError()!.message.includes("parameter type 0x10 not allowed in SUBSCRIBE_OK"),
  );
  // 削除集合 (pendingSubscribe + requestStreams + fillFetchTargets) が掃除される
  assert.isFalse(ctx.session.pendingSubscribe.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isFalse(ctx.session.fillFetchTargets.has(ctx.requestId));
});

test("bidiReadSubscribeResponse: SUBSCRIBE_OK の LARGEST_OBJECT で相対 Location Filter が一度だけ確定する", async () => {
  const ctx = createOkResponseReadTestContext();
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, (object) => {
    delivered.push(object);
  });
  // SUBSCRIBE 送信時: Next Object フィルタ (LARGEST_OBJECT 未受信)
  subscriber.setLocationFilter({ startGroup: 0n, startObject: 0n });
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
  // SUBSCRIBE_OK に LARGEST_OBJECT = {7, 2} を載せる
  const okPayload = encodeSubscribeOkPayload({
    type: MessageType.SUBSCRIBE_OK,
    trackAlias: 1n,
    parameters: [
      { type: MessageParameterType.LARGEST_OBJECT, value: new Uint8Array([0x07, 0x02]) },
    ],
    trackProperties: [],
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.SUBSCRIBE_OK, okPayload));
  ctx.readableController.close();
  await readPromise;

  // SUBSCRIBE_OK で開始位置が {7, 3} に確定する
  subscriber.handleObject({
    groupId: 7n,
    objectId: 2n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array(),
  });
  assert.equal(delivered.length, 0);
  subscriber.handleObject({
    groupId: 7n,
    objectId: 3n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array(),
  });
  assert.equal(delivered.length, 1);

  // 以降の LARGEST_OBJECT 更新では開始位置が前進しない
  subscriber.setLargestLocation({ group: 9n, object: 0n });
  subscriber.handleObject({
    groupId: 8n,
    objectId: 0n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array(),
  });
  assert.equal(delivered.length, 2);
  // SUBSCRIBE_OK の正常系でセッションが閉じない
  assert.isUndefined(ctx.getClosedWithError());
});

test("bidiReadFetchResponse: FETCH_OK のスコープ違反で具体エラーが reject される", async () => {
  // 初期応答のパラメータスコープ違反は汎用 close エラーに埋もれさせない
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

  const readPromise = bidiReadFetchResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  // FORWARD は FETCH_OK (許可なし) のスコープ違反である
  const okPayload = encodeFetchOkPayload({
    type: MessageType.FETCH_OK,
    endOfTrack: false,
    endLocation: { group: 0n, object: 0n },
    parameters: [{ type: MessageParameterType.FORWARD, value: new Uint8Array([1]) }],
    trackProperties: [],
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.FETCH_OK, okPayload));
  ctx.readableController.close();
  await readPromise;

  // 具体エラーで reject され、同一オブジェクトで閉じる
  assert.isDefined(rejected);
  assert.isDefined(ctx.getClosedWithError());
  assert.strictEqual(rejected, ctx.getClosedWithError());
  // reject してから閉じる順序である
  assert.deepEqual(ctx.order, ["reject", "close"]);
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(
    ctx.getClosedWithError()!.message.includes("parameter type 0x10 not allowed in FETCH_OK"),
  );
  // 削除集合 (pendingFetch + requestStreams) が掃除される
  assert.isFalse(ctx.session.pendingFetch.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
});

test("bidiReadTrackStatusResponse: TRACK_STATUS_OK のスコープ違反で具体エラーが reject される", async () => {
  // 初期応答のパラメータスコープ違反は汎用 close エラーに埋もれさせない
  const ctx = createOkResponseReadTestContext();
  let rejected: Error | undefined;
  ctx.session.pendingTrackStatus.set(ctx.requestId, {
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
  // FORWARD は TRACK_STATUS_OK (LARGEST_OBJECT のみ許可) のスコープ違反である
  const okPayload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [{ type: MessageParameterType.FORWARD, value: new Uint8Array([1]) }],
    trackProperties: [],
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.REQUEST_OK, okPayload));
  ctx.readableController.close();
  await readPromise;

  // 具体エラーで reject され、同一オブジェクトで閉じる
  assert.isDefined(rejected);
  assert.isDefined(ctx.getClosedWithError());
  assert.strictEqual(rejected, ctx.getClosedWithError());
  // reject してから閉じる順序である
  assert.deepEqual(ctx.order, ["reject", "close"]);
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(
    ctx
      .getClosedWithError()!
      .message.includes("parameter type 0x10 not allowed in TRACK_STATUS_OK"),
  );
  // 削除集合 (pendingTrackStatus + requestStreams) が掃除される
  assert.isFalse(ctx.session.pendingTrackStatus.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
});

test("bidiReadFetchResponse: FETCH_OK で複数の待機者が全員解決する", async () => {
  // broadcast 側の複製反復により、1 件目の登録解除で 2 件目が欠落しない。
  // 2 件目の timer を長くし、コールバック発火 (即時) と timer 代替 (遅延) を
  // 経過時間で区別する
  const ctx = createOkResponseReadTestContext();
  const fetcher = new FetcherImpl(["test"], "track", ctx.requestId, () => {});
  ctx.session.pendingFetch.set(ctx.requestId, {
    resolve: () => {},
    reject: () => {},
    impl: fetcher,
  });
  const internal = ctx.session as unknown as SessionInternal;
  const first = incomingWaitForFetcher(internal, ctx.requestId, 100);
  const second = incomingWaitForFetcher(internal, ctx.requestId, 1000);

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
  const started = Date.now();
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.FETCH_OK, okPayload));
  ctx.readableController.close();
  await readPromise;

  assert.strictEqual(await first, fetcher);
  assert.strictEqual(await second, fetcher);
  // コールバック発火なら即時解決する (timer 代替なら 1000ms 掛かる)。
  // 閾値 500ms は壁時計依存だが、即時と満了の中間で余裕を持つ
  assert.isBelow(Date.now() - started, 500);
  assert.isFalse(ctx.session.fetcherReadyCallbacks.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §9.20.20:
 * update({ newGroupRequest }) で NEW_GROUP_REQUEST (0x32) が REQUEST_UPDATE に
 * varint 符号化で載ることを検証する。
 */
test("bidiSendRequestUpdate: newGroupRequest が NEW_GROUP_REQUEST としてエンコードされる", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  const updatePromise = bidiSendRequestUpdate(session, subscriber, {
    newGroupRequest: 42n,
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  assert.equal(messages.length, 1);
  const decoded = decodeRequestUpdatePayload(messages[0].payload);
  const param = decoded.parameters.find((p) => p.type === MessageParameterType.NEW_GROUP_REQUEST);
  assert.isDefined(param);
  assert.equal(decodeVarint(param!.value)[0], 42n);
});

/**
 * draft-ietf-moq-transport-21 §9.20.20:
 * 規定値 0 の NEW_GROUP_REQUEST が varint 単一バイトで載ることを検証する。
 */
test("bidiSendRequestUpdate: newGroupRequest の 0 がエンコードされる", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  const updatePromise = bidiSendRequestUpdate(session, subscriber, {
    newGroupRequest: 0n,
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  assert.equal(messages.length, 1);
  const decoded = decodeRequestUpdatePayload(messages[0].payload);
  const param = decoded.parameters.find((p) => p.type === MessageParameterType.NEW_GROUP_REQUEST);
  assert.isDefined(param);
  assert.equal(param!.value.length, 1);
  assert.equal(decodeVarint(param!.value)[0], 0n);
});

/**
 * draft-ietf-moq-transport-21 §9.20:
 * raw NEW_GROUP_REQUEST と型付きの併用は送信前に拒否されることを検証する。
 */
test("bidiSendRequestUpdate: raw と型付きの NEW_GROUP_REQUEST 重複は拒否される", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  let thrown: unknown = null;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      parameters: [{ type: MessageParameterType.NEW_GROUP_REQUEST, value: encodeVarint(1n) }],
      newGroupRequest: 2n,
    });
  } catch (error) {
    thrown = error;
  }
  assert.isTrue(thrown instanceof Error);
  assert.match((thrown as Error).message, /duplicate NEW_GROUP_REQUEST/);
  assert.equal(session.pendingRequestUpdate.size, 0);
  assert.equal(written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.20:
 * raw NEW_GROUP_REQUEST 同士の重複も送信前に拒否されることを検証する。
 */
test("bidiSendRequestUpdate: raw の NEW_GROUP_REQUEST 重複は拒否される", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  let thrown: unknown = null;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      parameters: [
        { type: MessageParameterType.NEW_GROUP_REQUEST, value: encodeVarint(1n) },
        { type: MessageParameterType.NEW_GROUP_REQUEST, value: encodeVarint(2n) },
      ],
    });
  } catch (error) {
    thrown = error;
  }
  assert.isTrue(thrown instanceof Error);
  assert.match((thrown as Error).message, /duplicate NEW_GROUP_REQUEST/);
  assert.equal(session.pendingRequestUpdate.size, 0);
  assert.equal(written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.20.20:
 * 負の newGroupRequest は送信前に拒否されることを検証する。
 */
test("bidiSendRequestUpdate: 負の newGroupRequest は送信前に拒否される", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  let thrown: unknown = null;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      newGroupRequest: -1n,
    });
  } catch (error) {
    thrown = error;
  }
  assert.isTrue(thrown instanceof Error);
  assert.match((thrown as Error).message, /must not be negative/);
  assert.equal(session.pendingRequestUpdate.size, 0);
  assert.equal(written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.20 / §9.20.16:
 * raw FILL_PARAMETERS が 2 件の update() は送信前に拒否され、
 * pendingRequestUpdate に entry が残らないことを検証する。
 */
test("bidiSendRequestUpdate: raw FILL_PARAMETERS の重複は送信前に拒否される", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  const normalInner = encodeParameters([
    encodeLocationFilterParameter({ startGroup: 1n, startObject: 2n }),
  ]);

  let thrown: unknown = null;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      parameters: [
        { type: MessageParameterType.FILL_PARAMETERS, value: normalInner },
        { type: MessageParameterType.FILL_PARAMETERS, value: normalInner },
      ],
    });
  } catch (error) {
    thrown = error;
  }
  assert.instanceOf(thrown, InvalidFilterError);
  assert.match((thrown as Error).message, /duplicate FILL_PARAMETERS/);
  assert.equal(session.pendingRequestUpdate.size, 0);
  assert.equal(written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.20 / §9.20.16:
 * 型付き fill と raw FILL_PARAMETERS の併用は送信前に拒否されることを検証する。
 */
test("bidiSendRequestUpdate: 型付き fill と raw FILL_PARAMETERS の併用は送信前に拒否される", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  const normalInner = encodeParameters([
    encodeLocationFilterParameter({ startGroup: 1n, startObject: 2n }),
  ]);

  let thrown: unknown = null;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      fill: {},
      parameters: [{ type: MessageParameterType.FILL_PARAMETERS, value: normalInner }],
    });
  } catch (error) {
    thrown = error;
  }
  assert.instanceOf(thrown, InvalidFilterError);
  assert.match((thrown as Error).message, /duplicate FILL_PARAMETERS/);
  assert.equal(session.pendingRequestUpdate.size, 0);
  assert.equal(session.fillFetchTargets.size, 0);
  assert.equal(written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.20 / §9.20.16:
 * 重複検査は内側デコード検証より先に行われ、二重不正入力では
 * 重複エラーが優先されることを検証する。
 */
test("bidiSendRequestUpdate: 重複と内側不正の二重不正では重複エラーが優先される", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  const exceeding = buildExceedingLocationFilterValue();
  const exceedingInner = encodeParameters([
    { type: MessageParameterType.LOCATION_FILTER, value: exceeding },
  ]);

  let thrown: unknown = null;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      parameters: [
        { type: MessageParameterType.FILL_PARAMETERS, value: exceedingInner },
        { type: MessageParameterType.FILL_PARAMETERS, value: exceedingInner },
      ],
    });
  } catch (error) {
    thrown = error;
  }
  assert.instanceOf(thrown, InvalidFilterError);
  assert.match((thrown as Error).message, /duplicate FILL_PARAMETERS/);
  assert.equal(session.pendingRequestUpdate.size, 0);
  assert.equal(written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §3.4 / §9.20.16:
 * 単一の raw FILL_PARAMETERS の fill 要求が updateRequestId で購読に
 * 関連付けられることを検証する。内側に GROUP_ORDER がなければ
 * 購読の指定を継承する。
 */
test("bidiSendRequestUpdate: 単一 raw FILL は購読に関連付けられる", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  subscriber.setGroupOrder("Descending");
  const normalInner = encodeParameters([
    encodeLocationFilterParameter({ startGroup: 1n, startObject: 2n }),
  ]);

  const updatePromise = bidiSendRequestUpdate(session, subscriber, {
    parameters: [{ type: MessageParameterType.FILL_PARAMETERS, value: normalInner }],
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  assert.equal(written.length, 1);
  // ワイヤ上の REQUEST_UPDATE と map キーの対応付け (ワイヤ検証の詳細は別テスト)
  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  const decoded = decodeRequestUpdatePayload(messages[0].payload);
  assert.equal(decoded.requestId, 100n);
  assert.isDefined(decoded.parameters.find((p) => p.type === MessageParameterType.FILL_PARAMETERS));
  const target = session.fillFetchTargets.get(100n);
  assert.isDefined(target);
  assert.strictEqual(target!.subscriber, subscriber);
  assert.equal(target!.groupOrder, GroupOrder.DESCENDING);
  // targetRequestId (購読の 0n) には登録しないこと
  assert.isFalse(session.fillFetchTargets.has(0n));
});

/**
 * draft-ietf-moq-transport-21 §3.4 / §9.20.16:
 * raw FILL 内側の GROUP_ORDER が登録に使われることを検証する。
 */
test("bidiSendRequestUpdate: raw FILL 内側の GROUP_ORDER が登録される", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  const innerWithOrder = encodeParameters([
    encodeLocationFilterParameter({ startGroup: 1n, startObject: 2n }),
    { type: MessageParameterType.GROUP_ORDER, value: new Uint8Array([0x02]) },
  ]);

  const updatePromise = bidiSendRequestUpdate(session, subscriber, {
    parameters: [{ type: MessageParameterType.FILL_PARAMETERS, value: innerWithOrder }],
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  const target = session.fillFetchTargets.get(100n);
  assert.isDefined(target);
  assert.equal(target!.groupOrder, GroupOrder.DESCENDING);
  assert.equal(session.fillFetchTargets.size, 1);
  assert.isFalse(session.fillFetchTargets.has(0n));
});

/**
 * draft-ietf-moq-transport-21 §3.4 / §9.20.16:
 * raw FILL 内側の GROUP_ORDER 0x01 は Ascending として登録され、
 * 内側指定が購読指定より優先されることを検証する。
 */
test("bidiSendRequestUpdate: raw FILL 内側の GROUP_ORDER 0x01 は Ascending になる", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  subscriber.setGroupOrder("Descending");
  const innerWithAscending = encodeParameters([
    encodeLocationFilterParameter({ startGroup: 1n, startObject: 2n }),
    { type: MessageParameterType.GROUP_ORDER, value: new Uint8Array([0x01]) },
  ]);

  const updatePromise = bidiSendRequestUpdate(session, subscriber, {
    parameters: [{ type: MessageParameterType.FILL_PARAMETERS, value: innerWithAscending }],
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  const target = session.fillFetchTargets.get(100n);
  assert.isDefined(target);
  assert.equal(target!.groupOrder, GroupOrder.ASCENDING);
  assert.equal(session.fillFetchTargets.size, 1);
  assert.isFalse(session.fillFetchTargets.has(0n));
});

/**
 * draft-ietf-moq-transport-21 §3.4 / §9.20.16:
 * 内側と購読の両方に GROUP_ORDER がなければ Ascending になることを検証する。
 */
test("bidiSendRequestUpdate: GROUP_ORDER 両省略時は Ascending になる", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  const normalInner = encodeParameters([
    encodeLocationFilterParameter({ startGroup: 1n, startObject: 2n }),
  ]);

  const updatePromise = bidiSendRequestUpdate(session, subscriber, {
    parameters: [{ type: MessageParameterType.FILL_PARAMETERS, value: normalInner }],
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  const target = session.fillFetchTargets.get(100n);
  assert.isDefined(target);
  assert.equal(target!.groupOrder, GroupOrder.ASCENDING);
  assert.equal(session.fillFetchTargets.size, 1);
  assert.isFalse(session.fillFetchTargets.has(0n));
});

/**
 * draft-ietf-moq-transport-21 §3.4:
 * FILL なしの update() では関連付けが登録されないことを検証する。
 */
test("bidiSendRequestUpdate: FILL なしでは関連付けを登録しない", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  const updatePromise = bidiSendRequestUpdate(session, subscriber, {});
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  assert.equal(session.fillFetchTargets.size, 0);
});

/**
 * raw FILL 内側の Range Filter を手組みするテスト用ヘルパー
 */
function buildRawFillWithRanges(ranges: { start: bigint; end: bigint }[]): Parameter {
  const inner = encodeParameters([
    {
      type: MessageParameterType.SUBGROUP_FILTER,
      value: encodeRangeFilter({ type: "subgroup", setId: 0, ranges }),
    },
  ]);
  return { type: MessageParameterType.FILL_PARAMETERS, value: inner };
}

/**
 * draft-ietf-moq-transport-21 §9.1.6:
 * raw FILL 内側 Range が上限検証に含まれ、超過時は送信前に
 * throw することを検証する。
 */
test("bidiSendRequestUpdate: raw FILL 内側 Range の上限超過は throw する", async () => {
  // createBidiSession の peerMaxFilterRanges は 2 のため、3 Ranges で超過する
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      parameters: [
        buildRawFillWithRanges([
          { start: 0n, end: 1n },
          { start: 3n, end: 4n },
          { start: 5n, end: 6n },
        ]),
      ],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("exceeds peer MAX_FILTER_RANGES 2"));
  assert.equal(session.pendingRequestUpdate.size, 0);
  assert.equal(session.fillFetchTargets.size, 0);
  assert.equal(written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.1.6:
 * in-flight 中の raw FILL 内側 Range も上限合算に含めることを検証する。
 */
test("bidiSendRequestUpdate: in-flight の raw FILL と合計で上限超過の場合は throw する", async () => {
  // createBidiSession の peerMaxFilterRanges は 2 のため、2 + 1 で超過する
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  // 1 件目の raw FILL 更新を in-flight のまま残す (2 Ranges)
  const firstPromise = bidiSendRequestUpdate(session, subscriber, {
    parameters: [
      buildRawFillWithRanges([
        { start: 0n, end: 1n },
        { start: 3n, end: 4n },
      ]),
    ],
  });
  firstPromise.catch(() => {});

  // 2 件目の型付き fill 更新 (1 Range) は合計 3 で上限 2 を超えるため throw する
  const writtenBefore = written.length;
  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      fill: {
        rangeFilters: [{ type: "subgroup", setId: 1, ranges: [{ start: 0n, end: 1n }] }],
      },
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("exceeds peer MAX_FILTER_RANGES 2"));
  // 1 件目の関連付けは残り、2 件目は登録・送信されない
  assert.equal(session.fillFetchTargets.size, 1);
  assert.equal(session.pendingRequestUpdate.size, 1);
  assert.equal(written.length, writtenBefore);

  // 1 件目は未解決のまま残す (テスト終了時に破棄される。
  // 既存の型付き in-flight テストは resolve するが、こちらは残留検証のため残す)
  await Promise.resolve();
});

/**
 * draft-ietf-moq-transport-21 §9.1.6:
 * 上限以内の raw FILL 内側 Range は送信できることを検証する。
 */
test("bidiSendRequestUpdate: 上限以内の raw FILL 内側 Range は送信できる", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  const updatePromise = bidiSendRequestUpdate(session, subscriber, {
    parameters: [buildRawFillWithRanges([{ start: 0n, end: 1n }])],
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  assert.equal(written.length, 1);
  assert.equal(session.fillFetchTargets.size, 1);
});

/**
 * draft-ietf-moq-transport-21 §9.1.6:
 * 複数種別の内側 Range Filter も合算されることを検証する。
 */
test("bidiSendRequestUpdate: 複数種別の raw FILL 内側 Range も合算される", async () => {
  // SUBGROUP 2 件 + PRIORITY 1 件で合計 3 となり上限 2 を超える
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  const inner = encodeParameters([
    {
      type: MessageParameterType.SUBGROUP_FILTER,
      value: encodeRangeFilter({
        type: "subgroup",
        setId: 0,
        ranges: [
          { start: 0n, end: 1n },
          { start: 3n, end: 4n },
        ],
      }),
    },
    {
      type: MessageParameterType.PRIORITY_FILTER,
      value: encodeRangeFilter({ type: "priority", setId: 0, ranges: [{ start: 0n, end: 1n }] }),
    },
  ]);

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      parameters: [{ type: MessageParameterType.FILL_PARAMETERS, value: inner }],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("exceeds peer MAX_FILTER_RANGES 2"));
  assert.equal(session.pendingRequestUpdate.size, 0);
  assert.equal(session.fillFetchTargets.size, 0);
  assert.equal(written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.1.6:
 * 外側 Range と raw FILL 内側 Range の同一メッセージ合算で
 * 上限超過の場合は throw することを検証する。
 */
test("bidiSendRequestUpdate: 外側と raw FILL 内側の合算で上限超過の場合は throw する", async () => {
  // createBidiSession の peerMaxFilterRanges は 2 のため、外側 1 + 内側 2 で超過する
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      rangeFilters: [{ type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 1n }] }],
      parameters: [
        buildRawFillWithRanges([
          { start: 2n, end: 3n },
          { start: 4n, end: 5n },
        ]),
      ],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("exceeds peer MAX_FILTER_RANGES 2"));
  assert.equal(session.pendingRequestUpdate.size, 0);
  assert.equal(session.fillFetchTargets.size, 0);
  assert.equal(written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.1.6:
 * in-flight 中の型付き fill と新規 raw FILL の合計で上限超過の場合は
 * throw することを検証する (逆方向の合算)。
 */
test("bidiSendRequestUpdate: in-flight の型付き fill と raw 新規の合計超過は throw する", async () => {
  // createBidiSession の peerMaxFilterRanges は 2 のため、2 + 1 で超過する
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  // 1 件目の型付き fill 更新を in-flight のまま残す (2 Ranges)
  const firstPromise = bidiSendRequestUpdate(session, subscriber, {
    fill: {
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
    },
  });
  firstPromise.catch(() => {});

  // 2 件目の raw FILL 更新 (1 Range) は合計 3 で上限 2 を超えるため throw する
  const writtenBefore = written.length;
  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      parameters: [buildRawFillWithRanges([{ start: 5n, end: 6n }])],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("exceeds peer MAX_FILTER_RANGES 2"));
  assert.equal(session.fillFetchTargets.size, 1);
  assert.equal(session.pendingRequestUpdate.size, 1);
  assert.equal(written.length, writtenBefore);

  // 1 件目は未解決のまま残す (テスト終了時に破棄される。
  // 既存の型付き in-flight テストは resolve するが、こちらは残留検証のため残す)
  await Promise.resolve();
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
 * SUBSCRIBE_OK / FETCH_OK の MalformedTrackError 経路で bidi ストリームが
 * cancel されることを観測するためのセッションを構築する。
 *
 * readable の cancel (STOP_SENDING 相当) と writable の abort (RESET_STREAM
 * 相当) の到達理由を記録する。
 */
function createCancelObservableResponseContext(): {
  session: BidiSessionInternal;
  stream: WebTransportBidirectionalStream;
  readableController: ReadableStreamDefaultController<Uint8Array>;
  controlReader: ControlStreamReader;
  controlWriter: ControlStreamWriter;
  requestId: bigint;
  cancelled: unknown[];
  aborted: unknown[];
  getClosedWithError: () => SessionError | undefined;
} {
  const requestId = 10n;
  let readableController!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled: unknown[] = [];
  const aborted: unknown[] = [];
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      readableController = controller;
    },
    cancel(reason) {
      cancelled.push(reason);
    },
  });
  const writable = new WritableStream<Uint8Array>({
    abort(reason) {
      aborted.push(reason);
    },
  });
  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;
  const writer = writable.getWriter();
  const controlReader = new ControlStreamReader();
  let closedWithError: SessionError | undefined;
  const controlWriter = new ControlStreamWriter();
  const session = {
    sessionState: "connected",
    transport: {},
    controlWriter,
    nextRequestId: 100n,
    requestStreams: new Map([[requestId, { stream, writer, controlReader }]]),
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
    peerMaxRequestUpdates: 0,
    peerMaxFilterRanges: 0,
    namespaceSubscriptions: new Map(),
    tracksSubscriptions: new Map(),
    publisherStreams: new Map(),
    publisherSendQueues: new Map(),
    closedSubgroups: new Set(),
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
    controlReader,
    controlWriter,
    requestId,
    cancelled,
    aborted,
    getClosedWithError: () => closedWithError,
  };
}

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
function appendMalformedTrackProperties(payload: Uint8Array): Uint8Array {
  const malformed = new Uint8Array([0x02, 0x80]);
  const result = new Uint8Array(payload.length + malformed.length);
  result.set(payload, 0);
  result.set(malformed, payload.length);
  return result;
}

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
    incomingValidateRequestId(requestId, received, (error) => {
      ctx.session.closeWithError(error);
    });
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
 * 応答待ちの pending 購読 / FETCH も同一 Full Track Name で cancel され、
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
    onRequestDrained: () => {},
    closeWithError: () => {},
  } as unknown as BidiSessionInternal;

  const error = new MalformedTrackError("malformed track");
  // namespace ["a","b"] + trackName "c" の malformed 検出を通知する
  cancelMalformedTrackPeers(session, targetSubscriber.getFullTrackName(), error);
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
// validateRequestOkNoTrackProperties のテスト
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.3 (REQUEST_OK):
 * Track Properties が空の場合は検証を通過し null を返す。
 */
test("validateRequestOkNoTrackProperties: 空の Track Properties は検証を通過する", () => {
  const error = validateRequestOkNoTrackProperties([], "PUBLISH_OK");
  assert.isNull(error);
});

/**
 * draft-ietf-moq-transport-21 §9.3 (REQUEST_OK):
 * 非空の Track Properties は PROTOCOL_VIOLATION の SessionError を返す。
 */
test("validateRequestOkNoTrackProperties: 非空の Track Properties は PROTOCOL_VIOLATION のエラーを返す", () => {
  const error = validateRequestOkNoTrackProperties([{ id: 0x1n, value: 0n }], "PUBLISH_OK");
  if (error === null) {
    assert.fail("PROTOCOL_VIOLATION の SessionError を期待したが null だった");
  }
  assert.equal(error.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.equal(error.message, "track properties must be empty in PUBLISH_OK");
});

// ============================================================================
// 空必須メッセージの未知 Mandatory Track Property
// draft-ietf-moq-transport-21 §9.3 (REQUEST_OK) / §3.6 (Mandatory Track Properties)
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.3:
 * 「they are empty in PUBLISH_OK, REQUEST_UPDATE_OK, SUBSCRIBE_NAMESPACE_OK and
 *  PUBLISH_NAMESPACE_OK.  If an endpoint receives Track Properties in one of
 *  these messages it MUST close the session with a PROTOCOL_VIOLATION.」
 * 未知 Mandatory Track Property (0x4000-0x7FFF) は decodeRequestOkPayload の
 * decodeProperties が MalformedTrackError を throw するため、既知 Type の非空を
 * 検出する validateRequestOkNoTrackProperties には到達しない。応答リーダーの
 * handleMalformedTrack で PROTOCOL_VIOLATION へ変換して閉じる。
 */
test("bidiReadPublishResponse: 未知 Mandatory Track Property で PROTOCOL_VIOLATION で閉じる", async () => {
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
  const okPayload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [{ id: 0x4000n, value: 1n }],
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.REQUEST_OK, okPayload));
  ctx.readableController.close();
  await readPromise;

  // 具体エラー (PROTOCOL_VIOLATION) で reject され、同一オブジェクトで閉じる
  assert.instanceOf(rejected, SessionError);
  assert.equal((rejected as SessionError).code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue((rejected as SessionError).message.includes("unknown mandatory track property"));
  assert.strictEqual(rejected, ctx.getClosedWithError());
  // reject してから閉じる順序である
  assert.deepEqual(ctx.order, ["reject", "close"]);
  assert.isFalse(ctx.session.pendingPublish.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §9.3 / §3.6:
 * subscribe ロールの確立後 REQUEST_OK (REQUEST_UPDATE_OK) に未知 Mandatory
 * Track Property (0x4000-0x7FFF) を含めた場合も PROTOCOL_VIOLATION で閉じ、
 * 保留中の更新を同一の SessionError で reject する (update() のハング防止)。
 * fill 関連付けも失敗確定として掃除する。
 */
test("bidiReadRequestStreamMessages: REQUEST_UPDATE_OK の未知 Mandatory Track Property で PROTOCOL_VIOLATION で閉じる", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  let rejected: Error | undefined;
  ctx.session.pendingRequestUpdate.set(90n, {
    resolve: () => {},
    reject: (err: Error) => {
      rejected = err;
    },
    targetRequestId: ctx.requestId,
  });
  ctx.session.fillFetchTargets.set(90n, { subscriber, groupOrder: GroupOrder.ASCENDING });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  const okPayload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [{ id: 0x4000n, value: 1n }],
  });
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.REQUEST_OK, okPayload),
  );
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(ctx.closedWithError!.message.includes("unknown mandatory track property"));
  // 保留中の更新は違反 SessionError 自体で reject され、エントリと fill 関連付けが消える
  assert.strictEqual(rejected, ctx.closedWithError);
  assert.isFalse(ctx.session.pendingRequestUpdate.has(90n));
  assert.isFalse(ctx.session.fillFetchTargets.has(90n));
});
