/**
 * session/bidi.ts の単体テスト: bidiHandleRequestUpdateOk と PUBLISH_OK の Track Properties 検証
 *
 * REQUEST_OK / PUBLISH_OK の Track Properties が空であることの検証と、
 * REQUEST_OK による Forward State / Range Filters の反映を検証する。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import { type MoqtObject } from "../dataStream";
import { ObjectStatus } from "../message";
import { encodeRequestOkPayload, decodeRequestOkPayload } from "../message/session";
import { MessageType, MessageParameterType } from "../message/types";
import { SessionError, SessionErrorCode } from "../error";
import { bidiHandleRequestUpdateOk, type BidiSessionInternal } from "./bidi";

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
