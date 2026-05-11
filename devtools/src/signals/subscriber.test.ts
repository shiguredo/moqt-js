import { test, assert } from "vite-plus/test";
import { effect } from "@preact/signals";
import {
  addSubscriber,
  removeSubscriber,
  getSubscriber,
  createSubscriberInstance,
  subscriberInstances,
  subscriberIds,
  hasActiveSubscriber,
} from "./subscriber";

// テスト間の独立性を保つためのリセットヘルパー。
function resetSubscribers(): void {
  subscriberInstances.value = new Map();
}

test("createSubscriberInstance returns an instance with the given id", () => {
  const instance = createSubscriberInstance("test-id-1");
  assert.equal(instance.id, "test-id-1");
});

test("createSubscriberInstance initializes signals with expected defaults", () => {
  const instance = createSubscriberInstance("test-id-2");
  assert.equal(instance.session.value, null);
  assert.equal(instance.subscriber.value, null);
  assert.equal(instance.catalog.value, null);
  assert.equal(instance.decoder.value, null);
  assert.equal(instance.decoderConfigured.value, false);
  assert.equal(instance.status.value, "disconnected");
  assert.equal(instance.statusMessage.value, "Ready to subscribe");
  assert.equal(instance.codec.value, "");
  assert.equal(instance.isStopping.value, false);
  assert.equal(instance.joiningFetchEnabled.value, true);
  assert.equal(instance.newGroupRequestEnabled.value, false);
  assert.equal(instance.framesDecoded.value, 0);
  assert.equal(instance.objectsReceived.value, 0);
  assert.equal(instance.joiningFetchInProgress.value, false);
  assert.deepEqual(instance.liveObjectBuffer.value, []);
  assert.equal(instance.joiningFetchLastLocation.value, null);
});

test("addSubscriber inserts a new instance with a fresh Map reference", () => {
  resetSubscribers();
  const previousMap = subscriberInstances.value;
  const id = addSubscriber();
  assert.notStrictEqual(subscriberInstances.value, previousMap, "Map reference must change");
  assert.ok(subscriberInstances.value.has(id));
  assert.equal(getSubscriber(id)?.id, id);
});

test("addSubscriber generates unique ids", () => {
  resetSubscribers();
  const id1 = addSubscriber();
  const id2 = addSubscriber();
  const id3 = addSubscriber();
  assert.notEqual(id1, id2);
  assert.notEqual(id2, id3);
  assert.notEqual(id1, id3);
  assert.equal(subscriberInstances.value.size, 3);
});

test("removeSubscriber drops the entry and changes the Map reference", () => {
  resetSubscribers();
  const id = addSubscriber();
  const mapAfterAdd = subscriberInstances.value;
  removeSubscriber(id);
  assert.notStrictEqual(subscriberInstances.value, mapAfterAdd);
  assert.equal(subscriberInstances.value.has(id), false);
  assert.equal(getSubscriber(id), undefined);
});

test("removeSubscriber on missing id is a safe no-op", () => {
  resetSubscribers();
  // 存在しない id を削除しても例外にならず、空 Map のまま。
  removeSubscriber("nonexistent");
  assert.equal(subscriberInstances.value.size, 0);
});

test("removeSubscriber does not throw when decoder / session are null", () => {
  resetSubscribers();
  const id = addSubscriber();
  const instance = getSubscriber(id);
  assert.ok(instance);
  // decoder / session が null のまま remove しても例外を投げず Map から消える。
  assert.equal(instance.decoder.value, null);
  assert.equal(instance.session.value, null);
  removeSubscriber(id);
  assert.equal(subscriberInstances.value.has(id), false);
});

test("removeSubscriber preserves Map size when id does not exist", () => {
  resetSubscribers();
  const id = addSubscriber();
  removeSubscriber("nonexistent");
  assert.equal(subscriberInstances.value.size, 1);
  assert.equal(subscriberInstances.value.has(id), true);
});

test("subscriberIds reflects added and removed subscribers", () => {
  resetSubscribers();
  assert.deepEqual(subscriberIds.value, []);
  const id1 = addSubscriber();
  const id2 = addSubscriber();
  assert.deepEqual(subscriberIds.value, [id1, id2]);
  removeSubscriber(id1);
  assert.deepEqual(subscriberIds.value, [id2]);
});

test("hasActiveSubscriber tracks instance.subscriber.value updates", () => {
  resetSubscribers();
  assert.equal(hasActiveSubscriber.value, false);
  const id = addSubscriber();
  const instance = getSubscriber(id);
  assert.ok(instance);
  // subscriber.value が null のままなら false。
  assert.equal(hasActiveSubscriber.value, false);
  // subscriber.value を non-null に切り替えると true。
  // 実 Subscriber オブジェクトの代わりに最小限のオブジェクトで型を回避する。
  instance.subscriber.value = {} as never;
  assert.equal(hasActiveSubscriber.value, true);
  // null に戻すと false。
  instance.subscriber.value = null;
  assert.equal(hasActiveSubscriber.value, false);
});

test("hasActiveSubscriber notifies effect subscribers on change", () => {
  resetSubscribers();
  const observed: boolean[] = [];
  const dispose = effect(() => {
    observed.push(hasActiveSubscriber.value);
  });
  try {
    const id = addSubscriber();
    const instance = getSubscriber(id);
    assert.ok(instance);
    instance.subscriber.value = {} as never;
    instance.subscriber.value = null;
  } finally {
    dispose();
  }
  // 最初の購読で false → 何らかの更新で true → null 化で false。
  assert.ok(observed.includes(false));
  assert.ok(observed.includes(true));
});
