/**
 * SessionMachine Subscription Property-Based Tests
 * draft-ietf-moq-transport-17 Section 5.1, 9.8-9.11
 */

import * as fc from "fast-check";
import { assert, test } from "vite-plus/test";
import { SessionErrorCode } from "../error";
import {
  createSetup,
  createTrackNamespace,
  encodeTrackName,
  MessageType,
  type Publish,
  type PublishDone,
  type PublishOk,
  type RequestError,
  type RequestUpdate,
  type Subscribe,
  type SubscribeOk,
  VersionSpecificParameterType,
} from "../message";
import { encodeVarint } from "../varint";
import { SessionMachine } from "./machine";

function established(): SessionMachine {
  const p = SessionMachine.createClient("webTransport", createSetup());
  p.nextEvent(); // sendControl(SETUP)
  p.handleControl(createSetup()); // peer SETUP
  p.nextEvent(); // established
  return p;
}

const namespaceArb = fc
  .array(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 4 })
  .map((parts) => createTrackNamespace(parts));

const nameArb = fc.string({ minLength: 1, maxLength: 16 }).map((s) => encodeTrackName(s));

function buildSubscribe(requestId: bigint, ns = ["a"], name = "x"): Subscribe {
  return {
    type: MessageType.SUBSCRIBE,
    requestId,
    requiredRequestIdDelta: 0n,
    trackNamespace: createTrackNamespace(ns),
    trackName: encodeTrackName(name),
    parameters: [],
  };
}

function buildPublish(requestId: bigint, trackAlias: bigint, ns = ["a"], name = "x"): Publish {
  return {
    type: MessageType.PUBLISH,
    requestId,
    requiredRequestIdDelta: 0n,
    trackNamespace: createTrackNamespace(ns),
    trackName: encodeTrackName(name),
    trackAlias,
    parameters: [],
    trackProperties: [],
  };
}

test("sendSubscribe が pendingSubscriber として登録する", () => {
  fc.assert(
    fc.property(namespaceArb, nameArb, (ns, name) => {
      const p = established();
      const requestId = p.nextLocalRequestId();
      const subscribe: Subscribe = {
        type: MessageType.SUBSCRIBE,
        requestId,
        requiredRequestIdDelta: 0n,
        trackNamespace: ns,
        trackName: name,
        parameters: [],
      };
      p.sendSubscribe(subscribe);
      const entry = p.subscription(requestId);
      assert.ok(entry);
      assert.equal(entry.state, "pendingSubscriber");
      assert.equal(entry.myRole, "subscriber");
      assert.equal(entry.initiator, "subscriber");
      assert.equal(entry.trackAlias, null);
      const event = p.nextEvent();
      assert.ok(event);
      assert.equal(event.type, "sendRequest");
      if (event.type === "sendRequest") {
        assert.equal(event.requestId, requestId);
        assert.strictEqual(event.message, subscribe);
      }
    }),
  );
});

test("sendPublish が pendingPublisher として登録し Track Alias を記録する", () => {
  fc.assert(
    fc.property(
      namespaceArb,
      nameArb,
      fc.bigInt({ min: 0n, max: 1_000_000n }),
      (ns, name, trackAlias) => {
        const p = established();
        const requestId = p.nextLocalRequestId();
        const publish: Publish = {
          type: MessageType.PUBLISH,
          requestId,
          requiredRequestIdDelta: 0n,
          trackNamespace: ns,
          trackName: name,
          trackAlias,
          parameters: [],
          trackProperties: [],
        };
        p.sendPublish(publish);
        const entry = p.subscription(requestId);
        assert.ok(entry);
        assert.equal(entry.state, "pendingPublisher");
        assert.equal(entry.myRole, "publisher");
        assert.equal(entry.initiator, "publisher");
        assert.equal(entry.trackAlias, trackAlias);
      },
    ),
  );
});

test("SUBSCRIBE_OK を受信すると established に遷移し Track Alias が確定する", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: 1_000_000n }), (trackAlias) => {
      const p = established();
      const requestId = p.nextLocalRequestId();
      p.sendSubscribe(buildSubscribe(requestId));
      p.nextEvent();
      const ok: SubscribeOk = {
        type: MessageType.SUBSCRIBE_OK,
        trackAlias,
        parameters: [],
        trackProperties: [],
      };
      p.handleStreamMessage(requestId, ok);
      const entry = p.subscription(requestId);
      assert.ok(entry);
      assert.equal(entry.state, "established");
      assert.equal(entry.trackAlias, trackAlias);
    }),
  );
});

test("PUBLISH_OK を受信すると established に遷移する", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: 1_000_000n }), (trackAlias) => {
      const p = established();
      const requestId = p.nextLocalRequestId();
      p.sendPublish(buildPublish(requestId, trackAlias));
      p.nextEvent();
      const ok: PublishOk = {
        type: MessageType.PUBLISH_OK,
        parameters: [],
      };
      p.handleStreamMessage(requestId, ok);
      const entry = p.subscription(requestId);
      assert.ok(entry);
      assert.equal(entry.state, "established");
    }),
  );
});

test("REQUEST_ERROR を受信すると terminated に遷移する", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendSubscribe(buildSubscribe(requestId));
  p.nextEvent();
  const err: RequestError = {
    type: MessageType.REQUEST_ERROR,
    errorCode: 0n,
    retryInterval: 0n,
    reasonPhrase: "err",
  };
  p.handleStreamMessage(requestId, err);
  const entry = p.subscription(requestId);
  assert.ok(entry);
  assert.equal(entry.state, "terminated");
});

test("forgetSubscription は terminated 以外を除去しない", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendSubscribe(buildSubscribe(requestId));
  p.nextEvent();
  assert.equal(p.forgetSubscription(requestId), undefined);
  assert.ok(p.subscription(requestId));

  p.handleStreamMessage(requestId, {
    type: MessageType.REQUEST_ERROR,
    errorCode: 0n,
    retryInterval: 0n,
    reasonPhrase: "",
  });
  const forgotten = p.forgetSubscription(requestId);
  assert.ok(forgotten);
  assert.equal(forgotten.state, "terminated");
  assert.equal(p.subscription(requestId), undefined);
});

test("重複する subscribe は PROTOCOL_VIOLATION で throw する", () => {
  const p = established();
  const r1 = p.nextLocalRequestId();
  p.sendSubscribe(buildSubscribe(r1, ["a"], "x"));
  p.nextEvent();
  const r2 = p.nextLocalRequestId();
  assert.throws(() => {
    p.sendSubscribe(buildSubscribe(r2, ["a"], "x"));
  });
});

test("Track Alias の二重採番は DUPLICATE_TRACK_ALIAS で throw する", () => {
  const p = established();
  const r1 = p.nextLocalRequestId();
  p.sendPublish(buildPublish(r1, 7n, ["a"], "x"));
  p.nextEvent();
  const r2 = p.nextLocalRequestId();
  let caught: unknown;
  try {
    p.sendPublish(buildPublish(r2, 7n, ["b"], "y"));
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof Error);
  assert.equal((caught as { code?: number }).code, SessionErrorCode.DUPLICATE_TRACK_ALIAS);
});

test("established 前の sendSubscribe は PROTOCOL_VIOLATION", () => {
  const p = SessionMachine.createClient("webTransport", createSetup());
  p.nextEvent(); // sendControl(SETUP)
  // peer SETUP 未受信のため state は "setup"
  assert.throws(() => {
    p.sendSubscribe(buildSubscribe(0n));
  });
});

test("sendRequestUpdate が sendOnStream イベントを積む", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendSubscribe(buildSubscribe(requestId));
  p.nextEvent();
  const updateId = p.nextLocalRequestId();
  const update: RequestUpdate = {
    type: MessageType.REQUEST_UPDATE,
    requestId: updateId,
    requiredRequestIdDelta: 0n,
    parameters: [],
  };
  p.sendRequestUpdate(requestId, update);
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "sendOnStream");
  if (event.type === "sendOnStream") {
    assert.equal(event.requestId, requestId);
    assert.strictEqual(event.message, update);
  }
});

test("存在しない subscription への sendRequestUpdate は PROTOCOL_VIOLATION", () => {
  const p = established();
  const update: RequestUpdate = {
    type: MessageType.REQUEST_UPDATE,
    requestId: 10n,
    requiredRequestIdDelta: 0n,
    parameters: [],
  };
  assert.throws(() => {
    p.sendRequestUpdate(9999n, update);
  });
});

test("peer からの REQUEST_UPDATE は requestUpdateReceived イベントを出す", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendSubscribe(buildSubscribe(requestId));
  p.nextEvent();
  const updateId = p.nextLocalRequestId();
  const update: RequestUpdate = {
    type: MessageType.REQUEST_UPDATE,
    requestId: updateId,
    requiredRequestIdDelta: 0n,
    parameters: [],
  };
  p.handleStreamMessage(requestId, update);
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "requestUpdateReceived");
  if (event.type === "requestUpdateReceived") {
    assert.equal(event.requestId, updateId);
    assert.equal(event.targetRequestId, requestId);
  }
});

test("sendPublishDone が subscription を terminated にする", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendPublish(buildPublish(requestId, 1n));
  p.nextEvent();
  const done: PublishDone = {
    type: MessageType.PUBLISH_DONE,
    statusCode: 0n,
    streamCount: 0n,
    reasonPhrase: "",
  };
  p.sendPublishDone(requestId, done);
  const entry = p.subscription(requestId);
  assert.ok(entry);
  assert.equal(entry.state, "terminated");
  const event = p.nextEvent();
  assert.equal(event?.type, "sendOnStream");
});

test("subscriber 側からの sendPublishDone は PROTOCOL_VIOLATION", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendSubscribe(buildSubscribe(requestId));
  p.nextEvent();
  const done: PublishDone = {
    type: MessageType.PUBLISH_DONE,
    statusCode: 0n,
    streamCount: 0n,
    reasonPhrase: "",
  };
  assert.throws(() => {
    p.sendPublishDone(requestId, done);
  });
});

test("PUBLISH_DONE を受信すると terminated に遷移し publishDoneReceived を出す", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendSubscribe(buildSubscribe(requestId));
  p.nextEvent();
  p.handleStreamMessage(requestId, {
    type: MessageType.SUBSCRIBE_OK,
    trackAlias: 42n,
    parameters: [],
    trackProperties: [],
  });
  p.handleStreamMessage(requestId, {
    type: MessageType.PUBLISH_DONE,
    statusCode: 3n,
    streamCount: 7n,
    reasonPhrase: "bye",
  });
  const entry = p.subscription(requestId);
  assert.ok(entry);
  assert.equal(entry.state, "terminated");
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "publishDoneReceived");
  if (event.type === "publishDoneReceived") {
    assert.equal(event.statusCode, 3n);
    assert.equal(event.streamCount, 7n);
    assert.equal(event.reasonPhrase, "bye");
  }
});

// ─── PublicationView ─────────────────────────────────────────
// #0081 Phase 1: Publisher facade が自側状態を SessionMachine から射影するための
// read-only view。publisher role の SubscriptionEntry のみを expose する。

test("publicationView は sendPublish 直後の publisher role subscription を返す", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: 1_000_000n }), (trackAlias) => {
      const p = established();
      const requestId = p.nextLocalRequestId();
      p.sendPublish(buildPublish(requestId, trackAlias));
      const view = p.publicationView(requestId);
      assert.ok(view);
      assert.equal(view.requestId, requestId);
      assert.equal(view.trackAlias, trackAlias);
      assert.equal(view.state, "active");
      assert.equal(view.isEstablished, false);
      assert.equal(view.forwardState, true);
    }),
  );
});

test("publicationView は PUBLISH_OK 受信後に isEstablished=true になる", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: 1_000_000n }), (trackAlias) => {
      const p = established();
      const requestId = p.nextLocalRequestId();
      p.sendPublish(buildPublish(requestId, trackAlias));
      p.nextEvent();
      const ok: PublishOk = {
        type: MessageType.PUBLISH_OK,
        parameters: [],
      };
      p.handleStreamMessage(requestId, ok);
      const view = p.publicationView(requestId);
      assert.ok(view);
      assert.equal(view.state, "active");
      assert.equal(view.isEstablished, true);
    }),
  );
});

test("publicationView は subscriber role の subscription には undefined を返す", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendSubscribe(buildSubscribe(requestId));
  assert.equal(p.publicationView(requestId), undefined);
  // generic な subscription() では取得できる
  assert.ok(p.subscription(requestId));
});

test("publicationView は存在しない requestId に undefined を返す", () => {
  const p = established();
  assert.equal(p.publicationView(999n), undefined);
});

test("PUBLISH_OK の FORWARD=0 が publicationView.forwardState に反映される", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendPublish(buildPublish(requestId, 1n));
  p.nextEvent();
  const ok: PublishOk = {
    type: MessageType.PUBLISH_OK,
    parameters: [
      {
        type: VersionSpecificParameterType.FORWARD,
        value: encodeVarint(0n),
      },
    ],
  };
  p.handleStreamMessage(requestId, ok);
  const view = p.publicationView(requestId);
  assert.ok(view);
  assert.equal(view.forwardState, false);
});

test("PUBLISH_OK の FORWARD 変化で publicationForwardStateChanged が積まれる", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendPublish(buildPublish(requestId, 1n));
  p.nextEvent();
  p.handleStreamMessage(requestId, {
    type: MessageType.PUBLISH_OK,
    parameters: [
      {
        type: VersionSpecificParameterType.FORWARD,
        value: encodeVarint(0n),
      },
    ],
  });
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "publicationForwardStateChanged");
  if (event.type === "publicationForwardStateChanged") {
    assert.equal(event.requestId, requestId);
    assert.equal(event.forwardState, false);
  }
});

test("PUBLISH_OK で FORWARD が変化しない場合は publicationForwardStateChanged が積まれない", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendPublish(buildPublish(requestId, 1n));
  p.nextEvent();
  // PUBLISH で FORWARD 省略 (デフォルト 1) → PUBLISH_OK で FORWARD=1 (同値)
  p.handleStreamMessage(requestId, {
    type: MessageType.PUBLISH_OK,
    parameters: [
      {
        type: VersionSpecificParameterType.FORWARD,
        value: encodeVarint(1n),
      },
    ],
  });
  assert.equal(p.nextEvent(), undefined);
});

test("peer REQUEST_UPDATE の FORWARD 変化で publicationForwardStateChanged が積まれる", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendPublish(buildPublish(requestId, 1n));
  p.nextEvent();
  p.handleStreamMessage(requestId, {
    type: MessageType.PUBLISH_OK,
    parameters: [],
  });
  const updateId = p.nextLocalRequestId();
  p.handleStreamMessage(requestId, {
    type: MessageType.REQUEST_UPDATE,
    requestId: updateId,
    requiredRequestIdDelta: 0n,
    parameters: [
      {
        type: VersionSpecificParameterType.FORWARD,
        value: encodeVarint(0n),
      },
    ],
  });
  // forwardStateChanged と requestUpdateReceived の順に積まれる
  const e1 = p.nextEvent();
  assert.ok(e1);
  assert.equal(e1.type, "publicationForwardStateChanged");
  if (e1.type === "publicationForwardStateChanged") {
    assert.equal(e1.requestId, requestId);
    assert.equal(e1.forwardState, false);
  }
  const e2 = p.nextEvent();
  assert.ok(e2);
  assert.equal(e2.type, "requestUpdateReceived");
});

// ─── SubscriptionView ────────────────────────────────────────
// #0082: Subscriber facade が自側状態を SessionMachine から射影するための
// read-only view。subscriber role の SubscriptionEntry のみを expose する。

test("subscriptionView は sendSubscribe 直後の subscriber role subscription を返す", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendSubscribe(buildSubscribe(requestId));
  const view = p.subscriptionView(requestId);
  assert.ok(view);
  assert.equal(view.requestId, requestId);
  assert.equal(view.trackAlias, null);
  assert.equal(view.state, "active");
  assert.equal(view.isEstablished, false);
  assert.equal(view.largestLocation, null);
  assert.deepEqual(view.trackProperties, []);
});

test("subscriptionView は SUBSCRIBE_OK 受信後に isEstablished / trackAlias / trackProperties を埋める", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendSubscribe(buildSubscribe(requestId));
  p.nextEvent();
  const trackProperties = [{ id: 0x02n, value: 1500n }];
  p.handleStreamMessage(requestId, {
    type: MessageType.SUBSCRIBE_OK,
    trackAlias: 42n,
    parameters: [],
    trackProperties,
  });
  const view = p.subscriptionView(requestId);
  assert.ok(view);
  assert.equal(view.isEstablished, true);
  assert.equal(view.trackAlias, 42n);
  assert.deepEqual(view.trackProperties, trackProperties);
});

test("subscriptionView は SUBSCRIBE_OK の LARGEST_OBJECT を反映する", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendSubscribe(buildSubscribe(requestId));
  p.nextEvent();
  const location = { group: 7n, object: 3n };
  const encoded = new Uint8Array([
    ...encodeVarint(location.group),
    ...encodeVarint(location.object),
  ]);
  p.handleStreamMessage(requestId, {
    type: MessageType.SUBSCRIBE_OK,
    trackAlias: 1n,
    parameters: [
      {
        type: VersionSpecificParameterType.LARGEST_OBJECT,
        value: encoded,
      },
    ],
    trackProperties: [],
  });
  const view = p.subscriptionView(requestId);
  assert.ok(view);
  assert.ok(view.largestLocation);
  assert.equal(view.largestLocation.group, 7n);
  assert.equal(view.largestLocation.object, 3n);
});

test("subscriptionView は publisher role には undefined を返す", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendPublish(buildPublish(requestId, 1n));
  assert.equal(p.subscriptionView(requestId), undefined);
  // publicationView では取得可能
  assert.ok(p.publicationView(requestId));
});

test("subscriptionView は PUBLISH_DONE 受信後に state=closed を返す", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendSubscribe(buildSubscribe(requestId));
  p.nextEvent();
  p.handleStreamMessage(requestId, {
    type: MessageType.SUBSCRIBE_OK,
    trackAlias: 1n,
    parameters: [],
    trackProperties: [],
  });
  p.handleStreamMessage(requestId, {
    type: MessageType.PUBLISH_DONE,
    statusCode: 0n,
    streamCount: 0n,
    reasonPhrase: "",
  });
  const view = p.subscriptionView(requestId);
  assert.ok(view);
  assert.equal(view.state, "closed");
});

test("subscriptionView は session が closing に遷移すると state=closed を返す", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendSubscribe(buildSubscribe(requestId));
  p.nextEvent();
  p.close(SessionErrorCode.NO_ERROR, "bye");
  const view = p.subscriptionView(requestId);
  assert.ok(view);
  assert.equal(view.state, "closed");
});

test("applyRequestUpdateOk が subscription.largestLocation を更新する", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendSubscribe(buildSubscribe(requestId));
  p.nextEvent();
  p.handleStreamMessage(requestId, {
    type: MessageType.SUBSCRIBE_OK,
    trackAlias: 1n,
    parameters: [],
    trackProperties: [],
  });
  const location = { group: 10n, object: 20n };
  const encoded = new Uint8Array([
    ...encodeVarint(location.group),
    ...encodeVarint(location.object),
  ]);
  p.applyRequestUpdateOk(requestId, {
    type: MessageType.REQUEST_OK,
    parameters: [
      {
        type: VersionSpecificParameterType.LARGEST_OBJECT,
        value: encoded,
      },
    ],
  });
  const view = p.subscriptionView(requestId);
  assert.ok(view);
  assert.ok(view.largestLocation);
  assert.equal(view.largestLocation.group, 10n);
  assert.equal(view.largestLocation.object, 20n);
});

test("publicationView は session が closing に遷移すると state=closed を返す", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendPublish(buildPublish(requestId, 1n));
  p.nextEvent();
  assert.equal(p.publicationView(requestId)?.state, "active");
  p.close(SessionErrorCode.NO_ERROR, "bye");
  const view = p.publicationView(requestId);
  assert.ok(view);
  assert.equal(view.state, "closed");
  assert.equal(view.isEstablished, false);
});

test("PUBLISH_OK で FORWARD 省略時は publicationView.forwardState を維持する", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  // sendPublish 時に FORWARD=0 を明示
  const publish: Publish = {
    type: MessageType.PUBLISH,
    requestId,
    requiredRequestIdDelta: 0n,
    trackNamespace: createTrackNamespace(["a"]),
    trackName: encodeTrackName("x"),
    trackAlias: 1n,
    parameters: [
      {
        type: VersionSpecificParameterType.FORWARD,
        value: encodeVarint(0n),
      },
    ],
    trackProperties: [],
  };
  p.sendPublish(publish);
  p.nextEvent();
  p.handleStreamMessage(requestId, {
    type: MessageType.PUBLISH_OK,
    parameters: [],
  });
  const view = p.publicationView(requestId);
  assert.ok(view);
  assert.equal(view.forwardState, false);
});

test("peer REQUEST_UPDATE の FORWARD=0 が publicationView.forwardState に反映される", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendPublish(buildPublish(requestId, 1n));
  p.nextEvent();
  p.handleStreamMessage(requestId, {
    type: MessageType.PUBLISH_OK,
    parameters: [],
  });
  // 初期 forwardState は true (FORWARD 省略なのでデフォルト)
  assert.equal(p.publicationView(requestId)?.forwardState, true);
  const updateId = p.nextLocalRequestId();
  const update: RequestUpdate = {
    type: MessageType.REQUEST_UPDATE,
    requestId: updateId,
    requiredRequestIdDelta: 0n,
    parameters: [
      {
        type: VersionSpecificParameterType.FORWARD,
        value: encodeVarint(0n),
      },
    ],
  };
  p.handleStreamMessage(requestId, update);
  const view = p.publicationView(requestId);
  assert.ok(view);
  assert.equal(view.forwardState, false);
});

test("peer REQUEST_UPDATE で FORWARD 省略時は forwardState を維持する", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  // FORWARD=0 で PUBLISH 送信
  const publish: Publish = {
    type: MessageType.PUBLISH,
    requestId,
    requiredRequestIdDelta: 0n,
    trackNamespace: createTrackNamespace(["a"]),
    trackName: encodeTrackName("x"),
    trackAlias: 1n,
    parameters: [
      {
        type: VersionSpecificParameterType.FORWARD,
        value: encodeVarint(0n),
      },
    ],
    trackProperties: [],
  };
  p.sendPublish(publish);
  p.nextEvent();
  p.handleStreamMessage(requestId, {
    type: MessageType.PUBLISH_OK,
    parameters: [],
  });
  assert.equal(p.publicationView(requestId)?.forwardState, false);
  // FORWARD なしの REQUEST_UPDATE
  const updateId = p.nextLocalRequestId();
  p.handleStreamMessage(requestId, {
    type: MessageType.REQUEST_UPDATE,
    requestId: updateId,
    requiredRequestIdDelta: 0n,
    parameters: [],
  });
  const view = p.publicationView(requestId);
  assert.ok(view);
  assert.equal(view.forwardState, false);
});

test("publicationView は sendPublishDone 後に state=closed を返す", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendPublish(buildPublish(requestId, 1n));
  p.nextEvent();
  p.handleStreamMessage(requestId, {
    type: MessageType.PUBLISH_OK,
    parameters: [],
  });
  p.sendPublishDone(requestId, {
    type: MessageType.PUBLISH_DONE,
    statusCode: 0n,
    streamCount: 0n,
    reasonPhrase: "",
  });
  const view = p.publicationView(requestId);
  assert.ok(view);
  assert.equal(view.state, "closed");
  assert.equal(view.isEstablished, false);
});
