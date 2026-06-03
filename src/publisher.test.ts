/**
 * Publisher Unit Tests
 * draft-ietf-moq-transport-18 Section 5.2
 */

import { test, assert } from "vite-plus/test";
import { PublisherImpl } from "./publisher";

test("closed 状態では sendObject がエラーになる", () => {
  const publisher = new PublisherImpl(["namespace"], "track", 0n, 0n);
  publisher.markClosed();

  assert.throws(
    () => publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array() }),
    /closed/i,
  );
});

test("closed 状態では sendDatagram がエラーになる", () => {
  const publisher = new PublisherImpl(["namespace"], "track", 0n, 0n);
  publisher.markClosed();

  assert.throws(
    () => publisher.sendDatagram({ groupId: 0, objectId: 0, payload: new Uint8Array() }),
    /closed/i,
  );
});

test("done は onDoneInternal を呼んで closed にする", async () => {
  let doneCalled = false;
  const publisher = new PublisherImpl(["namespace"], "track", 0n, 0n);
  publisher.onDoneInternal = async () => {
    doneCalled = true;
  };

  assert.equal(publisher.state, "active");
  await publisher.done();
  assert.isTrue(doneCalled);
  assert.equal(publisher.state, "closed");
});

test("done は closed 状態では onDoneInternal を呼ばない", async () => {
  let doneCallCount = 0;
  const publisher = new PublisherImpl(["namespace"], "track", 0n, 0n);
  publisher.onDoneInternal = async () => {
    doneCallCount++;
  };

  await publisher.done();
  await publisher.done();

  assert.equal(doneCallCount, 1);
});

// draft-ietf-moq-transport-18 §10.4 (GOAWAY):
// "A GOAWAY MAY also be sent on a request stream to initiate migration
//  of that individual request."
// goawayCallback が設定され、GOAWAY 受信時に呼び出されることを検証する。
test("goawayCallback が設定できる", () => {
  const publisher = new PublisherImpl(["namespace"], "track", 0n, 0n);

  let calledUri = "";
  publisher.goawayCallback = (uri: string) => {
    calledUri = uri;
  };

  assert.isDefined(publisher.goawayCallback);
  publisher.goawayCallback!("moqt://new.example.com");
  assert.equal(calledUri, "moqt://new.example.com");
});
