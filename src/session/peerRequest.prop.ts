/**
 * SessionMachine peer-initiated SUBSCRIBE / PUBLISH Property-Based Tests
 * draft-ietf-moq-transport-17 Section 9.8 (SUBSCRIBE), 9.11 (PUBLISH)
 */

import * as fc from "fast-check";
import { assert, test } from "vite-plus/test";
import { SessionErrorCode } from "../error";
import {
  createSetup,
  createTrackNamespace,
  encodeTrackName,
  type Fetch,
  FetchType,
  MessageType,
  type Publish,
  type Subscribe,
  type TrackStatus,
} from "../message";
import { SessionMachine } from "./machine";

// client として established まで進める。peer は server なので
// peer が採番する Request ID は奇数 (1, 3, 5, ...) となる。
function established(): SessionMachine {
  const p = SessionMachine.createClient("webTransport", createSetup());
  p.nextEvent(); // sendControl(SETUP)
  p.handleControl(createSetup()); // peer SETUP
  p.nextEvent(); // established
  return p;
}

function buildPeerSubscribe(
  requestId: bigint,
  ns = ["a"],
  name = "x",
  requiredDelta: bigint = 0n,
): Subscribe {
  return {
    type: MessageType.SUBSCRIBE,
    requestId,
    requiredRequestIdDelta: requiredDelta,
    trackNamespace: createTrackNamespace(ns),
    trackName: encodeTrackName(name),
    parameters: [],
  };
}

function buildPeerPublish(
  requestId: bigint,
  trackAlias: bigint,
  ns = ["a"],
  name = "x",
  requiredDelta: bigint = 0n,
): Publish {
  return {
    type: MessageType.PUBLISH,
    requestId,
    requiredRequestIdDelta: requiredDelta,
    trackNamespace: createTrackNamespace(ns),
    trackName: encodeTrackName(name),
    trackAlias,
    parameters: [],
    trackProperties: [],
  };
}

// peer (server) の Request ID は奇数
const peerRequestIdArb = fc.bigInt({ min: 0n, max: 1_000_000n }).map((n) => n * 2n + 1n);

const namespaceArb = fc
  .array(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 4 })
  .map((parts) => createTrackNamespace(parts));

const nameArb = fc.string({ minLength: 1, maxLength: 16 }).map((s) => encodeTrackName(s));

test("handlePeerSubscribe が pendingSubscriber として登録し peerSubscribeReceived を出す", () => {
  fc.assert(
    fc.property(peerRequestIdArb, namespaceArb, nameArb, (requestId, ns, name) => {
      const p = established();
      const subscribe: Subscribe = {
        type: MessageType.SUBSCRIBE,
        requestId,
        requiredRequestIdDelta: 0n,
        trackNamespace: ns,
        trackName: name,
        parameters: [],
      };
      assert.equal(p.handlePeerSubscribe(subscribe), true);
      const entry = p.subscription(requestId);
      assert.ok(entry);
      // peer が subscriber として開始した購読は、自側からは publisher ロールで
      // 応答する立場のため pendingSubscriber 状態で保持する。
      assert.equal(entry.state, "pendingSubscriber");
      assert.equal(entry.initiator, "subscriber");
      assert.equal(entry.myRole, "publisher");
      assert.equal(entry.trackAlias, null);
      const event = p.nextEvent();
      assert.ok(event);
      assert.equal(event.type, "peerSubscribeReceived");
      if (event.type === "peerSubscribeReceived") {
        assert.equal(event.requestId, requestId);
        assert.strictEqual(event.message, subscribe);
      }
    }),
  );
});

test("handlePeerPublish が pendingPublisher として登録し peerPublishReceived を出す", () => {
  fc.assert(
    fc.property(
      peerRequestIdArb,
      namespaceArb,
      nameArb,
      fc.bigInt({ min: 0n, max: 1_000_000n }),
      (requestId, ns, name, trackAlias) => {
        const p = established();
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
        assert.equal(p.handlePeerPublish(publish), true);
        const entry = p.subscription(requestId);
        assert.ok(entry);
        // peer が publisher として開始した配信は、自側からは subscriber ロールで
        // 応答する立場のため pendingPublisher 状態で保持する。
        assert.equal(entry.state, "pendingPublisher");
        assert.equal(entry.initiator, "publisher");
        assert.equal(entry.myRole, "subscriber");
        assert.equal(entry.trackAlias, trackAlias);
        const event = p.nextEvent();
        assert.ok(event);
        assert.equal(event.type, "peerPublishReceived");
        if (event.type === "peerPublishReceived") {
          assert.equal(event.requestId, requestId);
          assert.strictEqual(event.message, publish);
        }
      },
    ),
  );
});

test("peer SUBSCRIBE の偶数 Request ID は INVALID_REQUEST_ID でクローズ", () => {
  const p = established();
  // client は偶数。peer (server) が偶数を採番するのは違反。
  assert.equal(p.handlePeerSubscribe(buildPeerSubscribe(2n)), false);
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "closeSession");
  if (event.type === "closeSession") {
    assert.equal(event.error.code, SessionErrorCode.INVALID_REQUEST_ID);
  }
});

test("peer SUBSCRIBE の Request ID 重複は INVALID_REQUEST_ID でクローズ", () => {
  const p = established();
  assert.equal(p.handlePeerSubscribe(buildPeerSubscribe(1n, ["a"], "x")), true);
  p.nextEvent(); // peerSubscribeReceived
  assert.equal(p.handlePeerSubscribe(buildPeerSubscribe(1n, ["b"], "y")), false);
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "closeSession");
  if (event.type === "closeSession") {
    assert.equal(event.error.code, SessionErrorCode.INVALID_REQUEST_ID);
  }
});

test("peer SUBSCRIBE の track 重複 (publisher role) は PROTOCOL_VIOLATION でクローズ", () => {
  const p = established();
  assert.equal(p.handlePeerSubscribe(buildPeerSubscribe(1n, ["a"], "x")), true);
  p.nextEvent();
  assert.equal(p.handlePeerSubscribe(buildPeerSubscribe(3n, ["a"], "x")), false);
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "closeSession");
  if (event.type === "closeSession") {
    assert.equal(event.error.code, SessionErrorCode.PROTOCOL_VIOLATION);
  }
});

test("peer PUBLISH の Track Alias 重複は DUPLICATE_TRACK_ALIAS でクローズ", () => {
  const p = established();
  assert.equal(p.handlePeerPublish(buildPeerPublish(1n, 7n, ["a"], "x")), true);
  p.nextEvent();
  assert.equal(p.handlePeerPublish(buildPeerPublish(3n, 7n, ["b"], "y")), false);
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "closeSession");
  if (event.type === "closeSession") {
    assert.equal(event.error.code, SessionErrorCode.DUPLICATE_TRACK_ALIAS);
  }
});

test("peer PUBLISH の track 重複 (subscriber role) は PROTOCOL_VIOLATION でクローズ", () => {
  const p = established();
  assert.equal(p.handlePeerPublish(buildPeerPublish(1n, 7n, ["a"], "x")), true);
  p.nextEvent();
  assert.equal(p.handlePeerPublish(buildPeerPublish(3n, 8n, ["a"], "x")), false);
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "closeSession");
  if (event.type === "closeSession") {
    assert.equal(event.error.code, SessionErrorCode.PROTOCOL_VIOLATION);
  }
});

test("peer PUBLISH の Track Alias は自側 SUBSCRIBE_OK と空間を共有する", () => {
  const p = established();
  // 先に自側の SUBSCRIBE → peer の SUBSCRIBE_OK で Track Alias 9 を確定する
  const myRequestId = p.nextLocalRequestId();
  p.sendSubscribe({
    type: MessageType.SUBSCRIBE,
    requestId: myRequestId,
    requiredRequestIdDelta: 0n,
    trackNamespace: createTrackNamespace(["ns"]),
    trackName: encodeTrackName("t"),
    parameters: [],
  });
  p.nextEvent(); // sendRequest
  p.handleStreamMessage(myRequestId, {
    type: MessageType.SUBSCRIBE_OK,
    trackAlias: 9n,
    parameters: [],
    trackProperties: [],
  });
  // peer が同じ Track Alias 9 で PUBLISH してきたら DUPLICATE_TRACK_ALIAS
  assert.equal(p.handlePeerPublish(buildPeerPublish(1n, 9n)), false);
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "closeSession");
  if (event.type === "closeSession") {
    assert.equal(event.error.code, SessionErrorCode.DUPLICATE_TRACK_ALIAS);
  }
});

test("SETUP 前の handlePeerSubscribe は PROTOCOL_VIOLATION でクローズ", () => {
  const p = SessionMachine.createClient("webTransport", createSetup());
  p.nextEvent(); // sendControl(SETUP)
  // peer SETUP 未受信、state は "setup"
  assert.equal(p.handlePeerSubscribe(buildPeerSubscribe(1n)), false);
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "closeSession");
  if (event.type === "closeSession") {
    assert.equal(event.error.code, SessionErrorCode.PROTOCOL_VIOLATION);
  }
});

test("SETUP 前の handlePeerPublish は PROTOCOL_VIOLATION でクローズ", () => {
  const p = SessionMachine.createClient("webTransport", createSetup());
  p.nextEvent();
  assert.equal(p.handlePeerPublish(buildPeerPublish(1n, 1n)), false);
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "closeSession");
  if (event.type === "closeSession") {
    assert.equal(event.error.code, SessionErrorCode.PROTOCOL_VIOLATION);
  }
});

function buildPeerStandaloneFetch(
  requestId: bigint,
  ns = ["a"],
  name = "x",
  requiredDelta: bigint = 0n,
): Fetch {
  return {
    type: MessageType.FETCH,
    requestId,
    requiredRequestIdDelta: requiredDelta,
    fetchType: FetchType.STANDALONE,
    standalone: {
      trackNamespace: createTrackNamespace(ns),
      trackName: encodeTrackName(name),
      startLocation: { group: 0n, object: 0n },
      endLocation: { group: 10n, object: 0n },
    },
    parameters: [],
  };
}

function buildPeerJoiningFetch(
  requestId: bigint,
  joiningRequestId: bigint,
  requiredDelta: bigint = 0n,
): Fetch {
  return {
    type: MessageType.FETCH,
    requestId,
    requiredRequestIdDelta: requiredDelta,
    fetchType: FetchType.RELATIVE_JOINING,
    joining: {
      joiningRequestId,
      joiningStart: 0n,
    },
    parameters: [],
  };
}

function buildPeerTrackStatus(
  requestId: bigint,
  ns = ["a"],
  name = "x",
  requiredDelta: bigint = 0n,
): TrackStatus {
  return {
    type: MessageType.TRACK_STATUS,
    requestId,
    requiredRequestIdDelta: requiredDelta,
    trackNamespace: createTrackNamespace(ns),
    trackName: encodeTrackName(name),
    parameters: [],
  };
}

test("handlePeerFetch (standalone) が FetchEntry を publisher role で登録し peerFetchReceived を出す", () => {
  fc.assert(
    fc.property(peerRequestIdArb, namespaceArb, nameArb, (requestId, ns, name) => {
      const p = established();
      const fetch: Fetch = {
        type: MessageType.FETCH,
        requestId,
        requiredRequestIdDelta: 0n,
        fetchType: FetchType.STANDALONE,
        standalone: {
          trackNamespace: ns,
          trackName: name,
          startLocation: { group: 0n, object: 0n },
          endLocation: { group: 5n, object: 0n },
        },
        parameters: [],
      };
      assert.equal(p.handlePeerFetch(fetch), true);
      const entry = p.fetch(requestId);
      assert.ok(entry);
      assert.equal(entry.state, "pending");
      assert.equal(entry.myRole, "publisher");
      assert.equal(entry.kind, "standalone");
      const event = p.nextEvent();
      assert.ok(event);
      assert.equal(event.type, "peerFetchReceived");
      if (event.type === "peerFetchReceived") {
        assert.equal(event.requestId, requestId);
        assert.strictEqual(event.message, fetch);
      }
    }),
  );
});

test("handlePeerFetch (joining) が joining 情報付きで登録される", () => {
  const p = established();
  const fetch = buildPeerJoiningFetch(1n, 3n);
  assert.equal(p.handlePeerFetch(fetch), true);
  const entry = p.fetch(1n);
  assert.ok(entry);
  assert.equal(entry.kind, "relativeJoining");
  assert.ok(entry.joining);
  assert.equal(entry.joining.joiningRequestId, 3n);
  assert.equal(entry.joining.joiningStart, 0n);
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "peerFetchReceived");
});

test("peer FETCH の偶数 Request ID は INVALID_REQUEST_ID でクローズ", () => {
  const p = established();
  assert.equal(p.handlePeerFetch(buildPeerStandaloneFetch(2n)), false);
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "closeSession");
  if (event.type === "closeSession") {
    assert.equal(event.error.code, SessionErrorCode.INVALID_REQUEST_ID);
  }
});

test("peer FETCH の Request ID 重複は INVALID_REQUEST_ID でクローズ", () => {
  const p = established();
  assert.equal(p.handlePeerFetch(buildPeerStandaloneFetch(1n)), true);
  p.nextEvent();
  assert.equal(p.handlePeerFetch(buildPeerStandaloneFetch(1n)), false);
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "closeSession");
  if (event.type === "closeSession") {
    assert.equal(event.error.code, SessionErrorCode.INVALID_REQUEST_ID);
  }
});

test("SETUP 前の handlePeerFetch は PROTOCOL_VIOLATION でクローズ", () => {
  const p = SessionMachine.createClient("webTransport", createSetup());
  p.nextEvent();
  assert.equal(p.handlePeerFetch(buildPeerStandaloneFetch(1n)), false);
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "closeSession");
  if (event.type === "closeSession") {
    assert.equal(event.error.code, SessionErrorCode.PROTOCOL_VIOLATION);
  }
});

test("handlePeerTrackStatus が TrackStatusEntry を publisher role で登録し peerTrackStatusReceived を出す", () => {
  fc.assert(
    fc.property(peerRequestIdArb, namespaceArb, nameArb, (requestId, ns, name) => {
      const p = established();
      const trackStatus: TrackStatus = {
        type: MessageType.TRACK_STATUS,
        requestId,
        requiredRequestIdDelta: 0n,
        trackNamespace: ns,
        trackName: name,
        parameters: [],
      };
      assert.equal(p.handlePeerTrackStatus(trackStatus), true);
      const entry = p.trackStatusRequest(requestId);
      assert.ok(entry);
      assert.equal(entry.state, "pending");
      assert.equal(entry.myRole, "publisher");
      const event = p.nextEvent();
      assert.ok(event);
      assert.equal(event.type, "peerTrackStatusReceived");
      if (event.type === "peerTrackStatusReceived") {
        assert.equal(event.requestId, requestId);
        assert.strictEqual(event.message, trackStatus);
      }
    }),
  );
});

test("peer TRACK_STATUS の偶数 Request ID は INVALID_REQUEST_ID でクローズ", () => {
  const p = established();
  assert.equal(p.handlePeerTrackStatus(buildPeerTrackStatus(2n)), false);
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "closeSession");
  if (event.type === "closeSession") {
    assert.equal(event.error.code, SessionErrorCode.INVALID_REQUEST_ID);
  }
});

test("SETUP 前の handlePeerTrackStatus は PROTOCOL_VIOLATION でクローズ", () => {
  const p = SessionMachine.createClient("webTransport", createSetup());
  p.nextEvent();
  assert.equal(p.handlePeerTrackStatus(buildPeerTrackStatus(1n)), false);
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "closeSession");
  if (event.type === "closeSession") {
    assert.equal(event.error.code, SessionErrorCode.PROTOCOL_VIOLATION);
  }
});
