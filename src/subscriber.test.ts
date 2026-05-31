/**
 * Subscriber Unit Tests
 * draft-ietf-moq-transport-18 Section 5.1 (Subscriptions)
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "./subscriber";
import type { MoqtObject } from "./dataStream";
import { ObjectStatus } from "./message/types";
import type { Property } from "./properties";

function createObject(groupId: bigint, objectId: bigint): MoqtObject {
  return {
    groupId,
    objectId,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array([1, 2, 3]),
  };
}

test("closed 状態では handleObject は配信しない", () => {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, (obj) =>
    delivered.push(obj),
  );

  subscriber.markClosed();
  subscriber.handleObject(createObject(0n, 0n));
  subscriber.handleObject(createObject(0n, 1n));

  assert.equal(delivered.length, 0);
});

test("closed 状態では handleDatagram は配信しない", () => {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(
    ["namespace"],
    "track",
    0n,
    0n,
    () => {},
    (obj) => delivered.push(obj),
  );

  subscriber.markClosed();
  subscriber.handleDatagram(createObject(0n, 0n));

  assert.equal(delivered.length, 0);
});

test("handleEnd は endCallback を呼んで closed にする", () => {
  let endCalled = false;
  const subscriber = new SubscriberImpl(
    ["namespace"],
    "track",
    0n,
    0n,
    () => {},
    undefined,
    () => {
      endCalled = true;
    },
  );

  assert.equal(subscriber.state, "active");
  subscriber.handleEnd();
  assert.isTrue(endCalled);
  assert.equal(subscriber.state, "closed");
});

test("handleEnd は closed 状態では endCallback を呼ばない", () => {
  let endCallCount = 0;
  const subscriber = new SubscriberImpl(
    ["namespace"],
    "track",
    0n,
    0n,
    () => {},
    undefined,
    () => {
      endCallCount++;
    },
  );

  subscriber.handleEnd();
  subscriber.handleEnd();

  assert.equal(endCallCount, 1);
});

test("update は closed 状態ではエラーになる", async () => {
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, () => {});

  subscriber.markClosed();

  try {
    await subscriber.update();
    assert.fail("closed 状態での update はエラーになるべき");
  } catch (e) {
    assert.match((e as Error).message, /closed/i);
  }
});

// draft-ietf-moq-transport-18 Section 10.11 (PUBLISH_DONE):
// UPDATE_FAILED (0x8) 等のエラー・ステータスでは errorCallback を呼ぶ
test("handleEnd は statusCode がエラーの場合 errorCallback を呼ぶ", () => {
  let endCalled = false;
  let errorMessage = "";
  const subscriber = new SubscriberImpl(
    ["namespace"],
    "track",
    0n,
    0n,
    () => {},
    undefined,
    () => {
      endCalled = true;
    },
    (error: Error) => {
      errorMessage = error.message;
    },
  );

  // UPDATE_FAILED (0x8) でエラー通知
  subscriber.handleEnd(0x8n, "update failed");
  assert.isTrue(endCalled);
  assert.include(errorMessage, "0x8");
  assert.include(errorMessage, "update failed");
  assert.equal(subscriber.state, "closed");
});

// draft-ietf-moq-transport-18 Section 10.11 (PUBLISH_DONE):
// TRACK_ENDED (0x2) は正常終了。errorCallback は呼ばない
test("handleEnd は statusCode が TRACK_ENDED の場合 errorCallback を呼ばない", () => {
  let endCalled = false;
  let errorCalled = false;
  const subscriber = new SubscriberImpl(
    ["namespace"],
    "track",
    0n,
    0n,
    () => {},
    undefined,
    () => {
      endCalled = true;
    },
    () => {
      errorCalled = true;
    },
  );

  subscriber.handleEnd(0x2n, "");
  assert.isTrue(endCalled);
  assert.isFalse(errorCalled);
});

// draft-ietf-moq-transport-18 Section 10.11 (PUBLISH_DONE):
// INTERNAL_ERROR (0x0) はエラー。errorCallback を呼ぶ
test("handleEnd は statusCode が INTERNAL_ERROR の場合 errorCallback を呼ぶ", () => {
  let endCalled = false;
  let errorCalled = false;
  const subscriber = new SubscriberImpl(
    ["namespace"],
    "track",
    0n,
    0n,
    () => {},
    undefined,
    () => {
      endCalled = true;
    },
    () => {
      errorCalled = true;
    },
  );

  subscriber.handleEnd(0x0n, "internal");
  assert.isTrue(endCalled);
  assert.isTrue(errorCalled);
  assert.equal(subscriber.state, "closed");
});

// draft-ietf-moq-transport-18 Section 10.8 (SUBSCRIBE_OK):
// SUBSCRIBE_OK の Track Properties が Subscriber に設定される
test("setTrackProperties で Track Properties が設定される", () => {
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, () => {});

  assert.equal(subscriber.trackProperties.length, 0);

  const properties: Property[] = [
    { id: 0x02n, value: 5000n },
    { id: 0x04n, value: 10000n },
  ];
  subscriber.setTrackProperties(properties);

  assert.equal(subscriber.trackProperties.length, 2);
  assert.equal(subscriber.trackProperties[0].id, 0x02n);
  assert.equal(subscriber.trackProperties[1].id, 0x04n);
});

// draft-ietf-moq-transport-18 Section 10.2.11 (LARGEST OBJECT Parameter):
// setLargestLocation で largestLocation が更新される
test("setLargestLocation で largestLocation が更新される", () => {
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, () => {});

  assert.isNull(subscriber.largestLocation);

  subscriber.setLargestLocation({ group: 5n, object: 3n });
  assert.deepEqual(subscriber.largestLocation, { group: 5n, object: 3n });

  // REQUEST_OK からの更新
  subscriber.setLargestLocation({ group: 10n, object: 7n });
  assert.deepEqual(subscriber.largestLocation, { group: 10n, object: 7n });
});
