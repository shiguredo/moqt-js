import { test, assert } from "vite-plus/test";
import type { MoqtObject } from "moqt-js";
import {
  checkAborted,
  closeSubscriberResources,
  resetSubscriberState,
  toSortedByGroupObject,
} from "./useSubscriber";
import { createSubscriberInstance, subscriberInstances } from "../signals/subscriber";
import { settingsDisabled } from "../signals/connectionSettings";

function makeObject(groupId: bigint, objectId: bigint): MoqtObject {
  return {
    groupId,
    objectId,
    status: 0,
    payload: new Uint8Array(),
  };
}

test("toSortedByGroupObject returns a new array (non-destructive)", () => {
  const input: MoqtObject[] = [makeObject(2n, 0n), makeObject(1n, 0n)];
  const inputCopy = [...input];
  const result = toSortedByGroupObject(input);
  assert.notStrictEqual(result, input, "result must not be the same reference as input");
  assert.deepEqual(input, inputCopy, "input array must not be mutated");
});

test("toSortedByGroupObject sorts ascending by groupId", () => {
  const objects: MoqtObject[] = [makeObject(3n, 0n), makeObject(1n, 0n), makeObject(2n, 0n)];
  const result = toSortedByGroupObject(objects);
  assert.deepEqual(
    result.map((o) => o.groupId),
    [1n, 2n, 3n],
  );
});

test("toSortedByGroupObject sorts ascending by objectId within same groupId", () => {
  const objects: MoqtObject[] = [makeObject(1n, 2n), makeObject(1n, 0n), makeObject(1n, 1n)];
  const result = toSortedByGroupObject(objects);
  assert.deepEqual(
    result.map((o) => o.objectId),
    [0n, 1n, 2n],
  );
});

test("toSortedByGroupObject sorts by groupId first then objectId", () => {
  const objects: MoqtObject[] = [
    makeObject(2n, 1n),
    makeObject(1n, 2n),
    makeObject(2n, 0n),
    makeObject(1n, 1n),
  ];
  const result = toSortedByGroupObject(objects);
  assert.deepEqual(
    result.map((o) => [o.groupId, o.objectId]),
    [
      [1n, 1n],
      [1n, 2n],
      [2n, 0n],
      [2n, 1n],
    ],
  );
});

test("toSortedByGroupObject handles empty input", () => {
  const result = toSortedByGroupObject([]);
  assert.deepEqual(result, []);
});

test("toSortedByGroupObject handles single element input", () => {
  const only = makeObject(5n, 7n);
  const result = toSortedByGroupObject([only]);
  assert.equal(result.length, 1);
  assert.equal(result[0].groupId, 5n);
  assert.equal(result[0].objectId, 7n);
});

test("toSortedByGroupObject treats equal (groupId, objectId) as stable enough to not crash", () => {
  const a = makeObject(1n, 1n);
  const b = makeObject(1n, 1n);
  const result = toSortedByGroupObject([a, b]);
  assert.equal(result.length, 2);
  // どちらが先でも正しい。比較関数が 0 を返した場合の挙動は仕様で安定ソートが保証されるが、
  // ここでは「両要素が含まれること」のみを検証する。
  assert.ok(result.includes(a));
  assert.ok(result.includes(b));
});

test("toSortedByGroupObject handles BigInt boundary values", () => {
  const large = makeObject(2n ** 62n, 0n);
  const small = makeObject(0n, 0n);
  const result = toSortedByGroupObject([large, small]);
  assert.equal(result[0].groupId, 0n);
  assert.equal(result[1].groupId, 2n ** 62n);
});

test("checkAborted returns false and does not run cleanup when not aborted", () => {
  const controller = new AbortController();
  let cleanupCalls = 0;
  const result = checkAborted(controller.signal, () => {
    cleanupCalls += 1;
  });
  assert.equal(result, false);
  assert.equal(cleanupCalls, 0);
});

test("checkAborted returns true and runs cleanup once when aborted", () => {
  const controller = new AbortController();
  controller.abort();
  let cleanupCalls = 0;
  const result = checkAborted(controller.signal, () => {
    cleanupCalls += 1;
  });
  assert.equal(result, true);
  assert.equal(cleanupCalls, 1);
});

test("checkAborted swallows exceptions from cleanup but still returns true", () => {
  const controller = new AbortController();
  controller.abort();
  const result = checkAborted(controller.signal, () => {
    throw new Error("cleanup error");
  });
  assert.equal(result, true);
});

function resetTestEnvironment(): void {
  subscriberInstances.value = new Map();
  settingsDisabled.value = false;
}

test("closeSubscriberResources does not throw when decoder/session are null", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("close-resources-1");
  assert.equal(instance.decoder.value, null);
  assert.equal(instance.session.value, null);
  closeSubscriberResources(instance, null);
  assert.equal(instance.session.value, null);
});

test("closeSubscriberResources resets session.value to null", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("close-resources-2");
  // 実 Session の代わりに最小限の close を返すスタブを代入する (型回避)。
  // close.catch のために .catch を持つ Promise を返す必要がある。
  let closeCalled = false;
  instance.session.value = {
    close: () => {
      closeCalled = true;
      return Promise.resolve();
    },
  } as never;
  closeSubscriberResources(instance, null);
  assert.equal(instance.session.value, null);
  assert.equal(closeCalled, true);
});

test("resetSubscriberState resets every state signal to initial value", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("reset-state-1");
  // 値を書き換えて初期値からずらしておく。
  instance.subscriber.value = {} as never;
  instance.catalogSubscriber.value = {} as never;
  instance.catalog.value = {} as never;
  instance.decoder.value = {} as never;
  instance.decoderConfigured.value = true;
  instance.codec.value = "h264";
  instance.dynamicGroupsSupported.value = true;
  instance.joiningFetchStats.value = {
    objectsReceived: 1,
    bytesReceived: 1,
    completed: false,
    bufferedLiveObjects: 0,
  };
  instance.largestLocation.value = { group: 1n, object: 1n };
  instance.joiningFetchInProgress.value = true;
  instance.joiningFetchLastLocation.value = { group: 1n, object: 1n };

  const chainRef = { current: Promise.resolve().then(() => {}) };
  const previousChain = chainRef.current;
  const liveBufferRef = { current: [{} as MoqtObject] };

  resetSubscriberState(instance, chainRef, liveBufferRef, null, null, () => false);

  assert.equal(instance.subscriber.value, null);
  assert.equal(instance.catalogSubscriber.value, null);
  assert.equal(instance.catalog.value, null);
  assert.equal(instance.decoder.value, null);
  assert.equal(instance.decoderConfigured.value, false);
  assert.equal(instance.codec.value, "");
  assert.equal(instance.dynamicGroupsSupported.value, false);
  assert.equal(instance.joiningFetchStats.value, null);
  assert.equal(instance.largestLocation.value, null);
  assert.equal(instance.joiningFetchInProgress.value, false);
  assert.equal(instance.joiningFetchLastLocation.value, null);
  assert.deepEqual(liveBufferRef.current, []);
  assert.notStrictEqual(chainRef.current, previousChain);
});

test("resetSubscriberState does not touch status / statusMessage / isStopping", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("reset-state-2");
  instance.status.value = "connected";
  instance.statusMessage.value = "Subscribed to foo/bar";
  instance.isStopping.value = true;
  const chainRef = { current: Promise.resolve() };
  resetSubscriberState(instance, chainRef, null, null, null, () => false);
  assert.equal(instance.status.value, "connected");
  assert.equal(instance.statusMessage.value, "Subscribed to foo/bar");
  assert.equal(instance.isStopping.value, true);
});

test("resetSubscriberState re-enables settingsDisabled when no active subscriber/publisher", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("reset-state-3");
  settingsDisabled.value = true;
  const chainRef = { current: Promise.resolve() };
  resetSubscriberState(instance, chainRef, null, null, null, () => false);
  assert.equal(settingsDisabled.value, false);
});

test("resetSubscriberState keeps settingsDisabled when other publisher is active", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("reset-state-4");
  settingsDisabled.value = true;
  const chainRef = { current: Promise.resolve() };
  resetSubscriberState(instance, chainRef, null, null, null, () => true);
  assert.equal(settingsDisabled.value, true);
});
