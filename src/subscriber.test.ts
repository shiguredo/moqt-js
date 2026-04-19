/**
 * Subscriber Unit Tests
 * draft-ietf-moq-transport-17 Section 5.1 (Subscriptions)
 */

import { assert, test } from "vite-plus/test";
import type { MoqtObject } from "./dataStream";
import { createTrackNamespace, encodeTrackName } from "./message";
import { type Location, ObjectStatus } from "./message/types";
import type { Property } from "./properties";
import { SubscriberImpl, type SubscriptionViewAccessor } from "./subscriber";
import type { SubscriptionView } from "./session/types";

interface MockView {
  state: "active" | "closed";
  isEstablished: boolean;
  trackAlias: bigint | null;
  largestLocation: Location | null;
  trackProperties: Property[];
}

function makeView(mock: MockView): SubscriptionView {
  return {
    requestId: 0n,
    trackNamespace: createTrackNamespace(["namespace"]),
    trackName: encodeTrackName("track"),
    trackAlias: mock.trackAlias,
    state: mock.state,
    isEstablished: mock.isEstablished,
    largestLocation: mock.largestLocation,
    trackProperties: mock.trackProperties,
  };
}

function createSubscriber(
  mock: MockView,
  options: {
    onObject?: (object: MoqtObject) => void;
    onDatagram?: (object: MoqtObject) => void;
    onEnd?: () => void;
    onError?: (error: Error) => void;
  } = {},
): SubscriberImpl {
  const viewAccessor: SubscriptionViewAccessor = () => makeView(mock);
  return new SubscriberImpl(
    ["namespace"],
    "track",
    0n,
    viewAccessor,
    options.onObject ?? (() => {}),
    options.onDatagram,
    options.onEnd,
    options.onError,
  );
}

function createObject(groupId: bigint, objectId: bigint): MoqtObject {
  return {
    groupId,
    objectId,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array([1, 2, 3]),
  };
}

test("view が closed を返すと handleObject は配信しない", () => {
  const mock: MockView = {
    state: "closed",
    isEstablished: false,
    trackAlias: 0n,
    largestLocation: null,
    trackProperties: [],
  };
  const delivered: MoqtObject[] = [];
  const subscriber = createSubscriber(mock, { onObject: (obj) => delivered.push(obj) });

  subscriber.handleObject(createObject(0n, 0n));
  subscriber.handleObject(createObject(0n, 1n));

  assert.equal(delivered.length, 0);
});

test("view が closed を返すと handleDatagram は配信しない", () => {
  const mock: MockView = {
    state: "closed",
    isEstablished: false,
    trackAlias: 0n,
    largestLocation: null,
    trackProperties: [],
  };
  const delivered: MoqtObject[] = [];
  const subscriber = createSubscriber(mock, { onDatagram: (obj) => delivered.push(obj) });

  subscriber.handleDatagram(createObject(0n, 0n));

  assert.equal(delivered.length, 0);
});

test("notifyEnded は endCallback を呼ぶ", () => {
  const mock: MockView = {
    state: "active",
    isEstablished: true,
    trackAlias: 0n,
    largestLocation: null,
    trackProperties: [],
  };
  let endCalled = false;
  const subscriber = createSubscriber(mock, {
    onEnd: () => {
      endCalled = true;
    },
  });

  assert.equal(subscriber.state, "active");
  subscriber.notifyEnded();
  assert.isTrue(endCalled);
});

test("notifyEnded は冪等 (2 回呼んでも callback は 1 回)", () => {
  const mock: MockView = {
    state: "active",
    isEstablished: true,
    trackAlias: 0n,
    largestLocation: null,
    trackProperties: [],
  };
  let endCallCount = 0;
  const subscriber = createSubscriber(mock, {
    onEnd: () => {
      endCallCount++;
    },
  });

  subscriber.notifyEnded();
  subscriber.notifyEnded();

  assert.equal(endCallCount, 1);
});

test("update は view が closed のときエラーになる", async () => {
  const mock: MockView = {
    state: "closed",
    isEstablished: false,
    trackAlias: 0n,
    largestLocation: null,
    trackProperties: [],
  };
  const subscriber = createSubscriber(mock);

  try {
    await subscriber.update();
    assert.fail("closed 状態での update はエラーになるべき");
  } catch (e) {
    assert.match((e as Error).message, /closed/i);
  }
});

// draft-ietf-moq-transport-17 Section 9.13 (PUBLISH_DONE):
// UPDATE_FAILED (0x8) 等のエラー・ステータスでは errorCallback を呼ぶ
test("notifyEnded は statusCode がエラーの場合 errorCallback を呼ぶ", () => {
  const mock: MockView = {
    state: "active",
    isEstablished: true,
    trackAlias: 0n,
    largestLocation: null,
    trackProperties: [],
  };
  let endCalled = false;
  let errorMessage = "";
  const subscriber = createSubscriber(mock, {
    onEnd: () => {
      endCalled = true;
    },
    onError: (error) => {
      errorMessage = error.message;
    },
  });

  subscriber.notifyEnded(0x8n, "update failed");
  assert.isTrue(endCalled);
  assert.include(errorMessage, "0x8");
  assert.include(errorMessage, "update failed");
});

// draft-ietf-moq-transport-17 Section 9.13 (PUBLISH_DONE):
// TRACK_ENDED (0x2) は正常終了。errorCallback は呼ばない
test("notifyEnded は statusCode が TRACK_ENDED の場合 errorCallback を呼ばない", () => {
  const mock: MockView = {
    state: "active",
    isEstablished: true,
    trackAlias: 0n,
    largestLocation: null,
    trackProperties: [],
  };
  let endCalled = false;
  let errorCalled = false;
  const subscriber = createSubscriber(mock, {
    onEnd: () => {
      endCalled = true;
    },
    onError: () => {
      errorCalled = true;
    },
  });

  subscriber.notifyEnded(0x2n, "");
  assert.isTrue(endCalled);
  assert.isFalse(errorCalled);
});

// draft-ietf-moq-transport-17 Section 9.13 (PUBLISH_DONE):
// INTERNAL_ERROR (0x0) はエラー。errorCallback を呼ぶ
test("notifyEnded は statusCode が INTERNAL_ERROR の場合 errorCallback を呼ぶ", () => {
  const mock: MockView = {
    state: "active",
    isEstablished: true,
    trackAlias: 0n,
    largestLocation: null,
    trackProperties: [],
  };
  let endCalled = false;
  let errorCalled = false;
  const subscriber = createSubscriber(mock, {
    onEnd: () => {
      endCalled = true;
    },
    onError: () => {
      errorCalled = true;
    },
  });

  subscriber.notifyEnded(0x0n, "internal");
  assert.isTrue(endCalled);
  assert.isTrue(errorCalled);
});

// draft-ietf-moq-transport-17 Section 9.9 (SUBSCRIBE_OK):
// view.trackProperties が Subscriber に反映される
test("view の trackProperties が Subscriber から取得できる", () => {
  const properties: Property[] = [
    { id: 0x02n, value: 5000n },
    { id: 0x04n, value: 10000n },
  ];
  const mock: MockView = {
    state: "active",
    isEstablished: true,
    trackAlias: 0n,
    largestLocation: null,
    trackProperties: properties,
  };
  const subscriber = createSubscriber(mock);

  assert.equal(subscriber.trackProperties.length, 2);
  assert.equal(subscriber.trackProperties[0].id, 0x02n);
  assert.equal(subscriber.trackProperties[1].id, 0x04n);
});

// draft-ietf-moq-transport-17 Section 9.3.9 (LARGEST OBJECT Parameter):
// view.largestLocation が Subscriber から取得できる
test("view の largestLocation が Subscriber から取得できる", () => {
  const mock: MockView = {
    state: "active",
    isEstablished: true,
    trackAlias: 0n,
    largestLocation: { group: 5n, object: 3n },
    trackProperties: [],
  };
  const subscriber = createSubscriber(mock);

  assert.deepEqual(subscriber.largestLocation, { group: 5n, object: 3n });
  // view の更新が即座に反映される
  mock.largestLocation = { group: 10n, object: 7n };
  assert.deepEqual(subscriber.largestLocation, { group: 10n, object: 7n });
});

test("view が undefined を返すと state=closed, trackProperties=[], largestLocation=null", () => {
  const viewAccessor: SubscriptionViewAccessor = () => undefined;
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, viewAccessor, () => {});
  assert.equal(subscriber.state, "closed");
  assert.equal(subscriber.largestLocation, null);
  assert.equal(subscriber.trackProperties.length, 0);
});

test("hasTrackAlias は view.trackAlias の有無を返す", () => {
  const mock: MockView = {
    state: "active",
    isEstablished: false,
    trackAlias: null,
    largestLocation: null,
    trackProperties: [],
  };
  const subscriber = createSubscriber(mock);
  assert.isFalse(subscriber.hasTrackAlias());
  mock.trackAlias = 7n;
  assert.isTrue(subscriber.hasTrackAlias());
  assert.equal(subscriber.getTrackAlias(), 7n);
});
