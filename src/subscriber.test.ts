/**
 * Subscriber Unit Tests
 * draft-ietf-moq-transport-15 Section 5.1
 */

import { test, assert } from "vitest";
import { SubscriberImpl } from "./subscriber";
import type { MoqtObject } from "./dataStream";
import { ObjectStatus } from "./message/types";

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
