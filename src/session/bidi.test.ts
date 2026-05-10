/**
 * session/bidi.ts の単体テスト
 *
 * BidiSessionInternal を実装するモックを用いて、双方向ストリーム上のメッセージ処理を検証する。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import { type MoqtObject } from "../dataStream";
import { ObjectStatus, type Location } from "../message";

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
