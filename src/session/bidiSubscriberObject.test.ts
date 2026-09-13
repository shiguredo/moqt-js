/**
 * session/bidi.ts の単体テスト: SubscriberImpl の object / datagram 配信と状態遷移
 *
 * SubscriberImpl の handleObject / handleDatagram / setLargestLocation /
 * setTrackAlias / unsubscribe の挙動を検証する。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import { type MoqtObject } from "../dataStream";
import { ObjectStatus, type Location } from "../message";

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
