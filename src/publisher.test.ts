/**
 * Publisher Unit Tests
 * draft-ietf-moq-transport-17 Section 5.2
 */

import { assert, test } from "vite-plus/test";
import { createTrackNamespace, encodeTrackName } from "./message";
import { PublisherImpl, type PublicationViewAccessor } from "./publisher";
import type { PublicationView } from "./session/types";

interface MockView {
  state: "active" | "closed";
  forwardState: boolean;
  isEstablished: boolean;
}

function createTestPublisher(
  mock: MockView,
  onForwardStateChange?: (forward: boolean) => void,
): PublisherImpl {
  const viewAccessor: PublicationViewAccessor = (): PublicationView => ({
    requestId: 0n,
    trackNamespace: createTrackNamespace(["namespace"]),
    trackName: encodeTrackName("track"),
    trackAlias: 0n,
    state: mock.state,
    isEstablished: mock.isEstablished,
    forwardState: mock.forwardState,
  });
  return new PublisherImpl(
    ["namespace"],
    "track",
    0n,
    0n,
    viewAccessor,
    undefined,
    onForwardStateChange,
  );
}

test("view が closed を返すと state が closed になり sendObject がエラーになる", () => {
  const mock: MockView = { state: "active", forwardState: true, isEstablished: true };
  const publisher = createTestPublisher(mock);
  assert.equal(publisher.state, "active");
  mock.state = "closed";
  assert.equal(publisher.state, "closed");
  assert.throws(
    () => publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array() }),
    /closed/i,
  );
});

test("view が closed を返すと sendDatagram がエラーになる", () => {
  const mock: MockView = { state: "closed", forwardState: true, isEstablished: false };
  const publisher = createTestPublisher(mock);
  assert.throws(
    () => publisher.sendDatagram({ groupId: 0, objectId: 0, payload: new Uint8Array() }),
    /closed/i,
  );
});

test("done は onDoneInternal を呼んで view の closed 化に委ねる", async () => {
  const mock: MockView = { state: "active", forwardState: true, isEstablished: true };
  let doneCalled = false;
  const publisher = createTestPublisher(mock);
  publisher.onDoneInternal = async () => {
    doneCalled = true;
    // 実際の実装では sendPublishDone が SessionMachine の entry を terminated にする
    mock.state = "closed";
  };

  assert.equal(publisher.state, "active");
  await publisher.done();
  assert.isTrue(doneCalled);
  assert.equal(publisher.state, "closed");
});

test("done は closed 状態では onDoneInternal を呼ばない", async () => {
  const mock: MockView = { state: "active", forwardState: true, isEstablished: true };
  let doneCallCount = 0;
  const publisher = createTestPublisher(mock);
  publisher.onDoneInternal = async () => {
    doneCallCount++;
    mock.state = "closed";
  };

  await publisher.done();
  await publisher.done();

  assert.equal(doneCallCount, 1);
});

test("forwardState getter は view の値を返す", () => {
  const mock: MockView = { state: "active", forwardState: true, isEstablished: true };
  const publisher = createTestPublisher(mock);
  assert.equal(publisher.forwardState, true);
  mock.forwardState = false;
  assert.equal(publisher.forwardState, false);
});

test("view が undefined を返すと state が closed、forwardState が false になる", () => {
  const viewAccessor: PublicationViewAccessor = () => undefined;
  const publisher = new PublisherImpl(
    ["namespace"],
    "track",
    0n,
    0n,
    viewAccessor,
    undefined,
    undefined,
  );
  assert.equal(publisher.state, "closed");
  assert.equal(publisher.forwardState, false);
});

test("notifyForwardStateChanged は callback をそのまま呼ぶ", () => {
  const mock: MockView = { state: "active", forwardState: true, isEstablished: true };
  const calls: boolean[] = [];
  const publisher = createTestPublisher(mock, (forward) => {
    calls.push(forward);
  });
  publisher.notifyForwardStateChanged(false);
  publisher.notifyForwardStateChanged(true);
  assert.deepEqual(calls, [false, true]);
});
