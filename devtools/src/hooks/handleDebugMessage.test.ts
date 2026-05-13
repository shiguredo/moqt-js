import { test, assert, beforeEach } from "vite-plus/test";
import type { DebugMessage } from "moqt-js";
import { handleDebugMessage as handleSubscriberDebugMessage } from "./useSubscriber";
import { handleDebugMessage as handlePublisherDebugMessage } from "./usePublisher";
import { __resetLogStateForTest, getLogBuffer } from "../components/DebugPanel";

beforeEach(() => {
  __resetLogStateForTest();
});

function makeMessage(payload: Uint8Array): DebugMessage {
  return {
    direction: "recv",
    type: 0x10,
    typeName: "SUBSCRIBE_OK",
    payload,
    timestamp: 0,
  };
}

test("subscriber handleDebugMessage copies payload to independent ArrayBuffer", () => {
  const source = new Uint8Array([1, 2, 3, 4]);
  handleSubscriberDebugMessage("subscriber-1", makeMessage(source));
  const entries = getLogBuffer();
  assert.equal(entries.length, 1);
  const stored = entries[entries.length - 1].payload;
  assert.ok(stored !== undefined);
  assert.notStrictEqual(stored.buffer, source.buffer);
  assert.deepEqual(Array.from(stored), [1, 2, 3, 4]);
});

test("subscriber handleDebugMessage stores undefined payload when source length is 0", () => {
  handleSubscriberDebugMessage("subscriber-1", makeMessage(new Uint8Array()));
  const entries = getLogBuffer();
  assert.equal(entries.length, 1);
  assert.equal(entries[entries.length - 1].payload, undefined);
});

test("publisher handleDebugMessage copies payload to independent ArrayBuffer", () => {
  const source = new Uint8Array([0xaa, 0xbb]);
  handlePublisherDebugMessage(makeMessage(source));
  const entries = getLogBuffer();
  assert.equal(entries.length, 1);
  const stored = entries[entries.length - 1].payload;
  assert.ok(stored !== undefined);
  assert.notStrictEqual(stored.buffer, source.buffer);
  assert.deepEqual(Array.from(stored), [0xaa, 0xbb]);
});
