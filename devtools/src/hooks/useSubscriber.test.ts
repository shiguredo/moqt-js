import { test, assert } from "vite-plus/test";
import { checkAborted, closeSubscriberResources, resetSubscriberState } from "./useSubscriber";
import { createSubscriberInstance, subscriberInstances } from "../signals/subscriber";
import { settingsDisabled } from "../signals/connectionSettings";

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
  instance.largestLocation.value = { group: 1n, object: 1n };

  const chainRef = { current: Promise.resolve().then(() => {}) };
  const previousChain = chainRef.current;

  resetSubscriberState(instance, chainRef, () => false);

  assert.equal(instance.subscriber.value, null);
  assert.equal(instance.catalogSubscriber.value, null);
  assert.equal(instance.catalog.value, null);
  assert.equal(instance.decoder.value, null);
  assert.equal(instance.decoderConfigured.value, false);
  assert.equal(instance.codec.value, "");
  assert.equal(instance.dynamicGroupsSupported.value, false);
  assert.equal(instance.largestLocation.value, null);
  assert.notStrictEqual(chainRef.current, previousChain);
});

test("resetSubscriberState does not touch status / statusMessage / isStopping", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("reset-state-2");
  instance.status.value = "connected";
  instance.statusMessage.value = "Subscribed to foo/bar";
  instance.isStopping.value = true;
  const chainRef = { current: Promise.resolve() };
  resetSubscriberState(instance, chainRef, () => false);
  assert.equal(instance.status.value, "connected");
  assert.equal(instance.statusMessage.value, "Subscribed to foo/bar");
  assert.equal(instance.isStopping.value, true);
});

test("resetSubscriberState re-enables settingsDisabled when no active subscriber/publisher", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("reset-state-3");
  settingsDisabled.value = true;
  const chainRef = { current: Promise.resolve() };
  resetSubscriberState(instance, chainRef, () => false);
  assert.equal(settingsDisabled.value, false);
});

test("resetSubscriberState keeps settingsDisabled when other publisher is active", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("reset-state-4");
  settingsDisabled.value = true;
  const chainRef = { current: Promise.resolve() };
  resetSubscriberState(instance, chainRef, () => true);
  assert.equal(settingsDisabled.value, true);
});
