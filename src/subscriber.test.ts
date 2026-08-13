/**
 * Subscriber Unit Tests
 * draft-ietf-moq-transport-19 Section 5.1 (Subscriptions)
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

// draft-ietf-moq-transport-19 Section 10.11 (PUBLISH_DONE):
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

// draft-ietf-moq-transport-19 Section 10.11 (PUBLISH_DONE):
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

// draft-ietf-moq-transport-19 Section 10.11 (PUBLISH_DONE):
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

// draft-ietf-moq-transport-19 Section 10.8 (SUBSCRIBE_OK):
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

// draft-ietf-moq-transport-19 Section 10.2.16 (LARGEST OBJECT Parameter):
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

// draft-ietf-moq-transport-19 §10.4 (GOAWAY):
// "A GOAWAY MAY also be sent on a request stream to initiate migration
//  of that individual request."
// goawayCallback が設定され、GOAWAY 受信時に呼び出されることを検証する。
test("goawayCallback が設定できる", () => {
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, () => {});

  let calledUri = "";
  subscriber.goawayCallback = (uri: string) => {
    calledUri = uri;
  };

  assert.isDefined(subscriber.goawayCallback);
  subscriber.goawayCallback!("moqt://new.example.com");
  assert.equal(calledUri, "moqt://new.example.com");
});

// draft-ietf-moq-transport-19 §10.2.17 (FORWARD Parameter):
// setForwardState で Forward State が更新され、forwardState で取得できることを検証する。
test("setForwardState で Forward State が更新される", () => {
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, () => {});

  // 初期値はデフォルト 1 (§10.2.17)
  assert.equal(subscriber.forwardState, true);

  subscriber.setForwardState(false);
  assert.equal(subscriber.forwardState, false);

  subscriber.setForwardState(true);
  assert.equal(subscriber.forwardState, true);
});

// draft-ietf-moq-transport-19 §5.1.3 (Range Filters):
// setRangeFilters で設定した Range Filter が handleObject / handleDatagram で
// 再適用され、不通過のオブジェクトがアプリに渡されないことを検証する。
test("setRangeFilters で設定した Range Filter が handleObject で再適用される", () => {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, (obj) =>
    delivered.push(obj),
  );
  subscriber.setRangeFilters([{ type: "objectId", setId: 0, ranges: [{ start: 3n, end: 5n }] }]);

  subscriber.handleObject(createObject(0n, 4n));
  subscriber.handleObject(createObject(0n, 7n));

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].objectId, 4n);
});

test("Range Filter が handleDatagram でも再適用される", () => {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(
    ["namespace"],
    "track",
    0n,
    0n,
    () => {},
    (obj) => delivered.push(obj),
  );
  subscriber.setRangeFilters([{ type: "objectId", setId: 0, ranges: [{ start: 3n, end: 5n }] }]);

  subscriber.handleDatagram(createObject(0n, 4n));
  subscriber.handleDatagram(createObject(0n, 7n));

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].objectId, 4n);
});

// draft-ietf-moq-transport-19 §5.1.3:
// フィルタなし (undefined) は全通過。
test("Range Filter 未設定の場合は全通過する", () => {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, (obj) =>
    delivered.push(obj),
  );

  subscriber.handleObject(createObject(0n, 4n));
  subscriber.handleObject(createObject(0n, 7n));

  assert.equal(delivered.length, 2);
});

// draft-ietf-moq-transport-19 §5.1.3:
// SUBGROUP_FILTER は subgroupId が明示されていない (datagram 経路) オブジェクトを
// 不通過にする。
test("SUBGROUP_FILTER は subgroupId のないオブジェクトを不通過にする", () => {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(
    ["namespace"],
    "track",
    0n,
    0n,
    (obj) => delivered.push(obj),
    (obj) => delivered.push(obj),
  );
  subscriber.setRangeFilters([{ type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 5n }] }]);

  // subgroup 経路: subgroupId あり → 通過
  subscriber.handleObject({ ...createObject(0n, 0n), subgroupId: 3n });
  // datagram 経路: subgroupId なし → 不通過
  subscriber.handleDatagram(createObject(0n, 0n));

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].subgroupId, 3n);
});
