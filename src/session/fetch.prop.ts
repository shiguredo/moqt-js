/**
 * SessionMachine Fetch Property-Based Tests
 * draft-ietf-moq-transport-17 Section 5.2, 9.14, 9.15
 */

import * as fc from "fast-check";
import { assert, test } from "vite-plus/test";
import { SessionErrorCode } from "../error";
import {
  createSetup,
  createTrackNamespace,
  encodeTrackName,
  type Fetch,
  type FetchOk,
  FetchType,
  type Location,
  MessageType,
  type RequestError,
} from "../message";
import { SessionMachine } from "./machine";

function established(): SessionMachine {
  const p = SessionMachine.createClient("webTransport", createSetup());
  p.nextEvent();
  p.handleControl(createSetup());
  p.nextEvent();
  return p;
}

const locationArb: fc.Arbitrary<Location> = fc.record({
  group: fc.bigInt({ min: 0n, max: 1_000_000n }),
  object: fc.bigInt({ min: 0n, max: 1_000_000n }),
});

function buildStandaloneFetch(requestId: bigint, start: Location, end: Location): Fetch {
  return {
    type: MessageType.FETCH,
    requestId,
    requiredRequestIdDelta: 0n,
    fetchType: FetchType.STANDALONE,
    standalone: {
      trackNamespace: createTrackNamespace(["a", "b"]),
      trackName: encodeTrackName("x"),
      startLocation: start,
      endLocation: end,
    },
    parameters: [],
  };
}

function buildJoiningFetch(requestId: bigint, joiningRequestId: bigint): Fetch {
  return {
    type: MessageType.FETCH,
    requestId,
    requiredRequestIdDelta: 0n,
    fetchType: FetchType.RELATIVE_JOINING,
    joining: {
      joiningRequestId,
      joiningStart: 0n,
    },
    parameters: [],
  };
}

test("sendFetch(standalone) が pending として登録する", () => {
  fc.assert(
    fc.property(locationArb, locationArb, (start, end) => {
      const p = established();
      const requestId = p.nextLocalRequestId();
      const fetch = buildStandaloneFetch(requestId, start, end);
      p.sendFetch(fetch);
      const entry = p.fetch(requestId);
      assert.ok(entry);
      assert.equal(entry.state, "pending");
      assert.equal(entry.kind, "standalone");
      assert.equal(entry.myRole, "subscriber");
      assert.ok(entry.standaloneRange);
      assert.deepEqual(entry.standaloneRange.start, start);
      assert.deepEqual(entry.standaloneRange.end, end);
      assert.equal(entry.joining, null);
      const event = p.nextEvent();
      assert.equal(event?.type, "sendRequest");
    }),
  );
});

test("sendFetch(relative joining) が relativeJoining kind として登録する", () => {
  const p = established();
  const parentId = p.nextLocalRequestId();
  const fetchId = p.nextLocalRequestId();
  p.sendFetch(buildJoiningFetch(fetchId, parentId));
  const entry = p.fetch(fetchId);
  assert.ok(entry);
  assert.equal(entry.kind, "relativeJoining");
  assert.ok(entry.joining);
  assert.equal(entry.joining.joiningRequestId, parentId);
});

test("FETCH_OK を受信すると established に遷移し endLocation が確定する", () => {
  fc.assert(
    fc.property(
      locationArb,
      locationArb,
      locationArb,
      fc.boolean(),
      (start, end, fetchEnd, eot) => {
        const p = established();
        const requestId = p.nextLocalRequestId();
        p.sendFetch(buildStandaloneFetch(requestId, start, end));
        p.nextEvent();
        const ok: FetchOk = {
          type: MessageType.FETCH_OK,
          endOfTrack: eot,
          endLocation: fetchEnd,
          parameters: [],
          trackProperties: [],
        };
        p.handleStreamMessage(requestId, ok);
        const entry = p.fetch(requestId);
        assert.ok(entry);
        assert.equal(entry.state, "established");
        assert.deepEqual(entry.endLocation, fetchEnd);
        assert.equal(entry.endOfTrack, eot);
      },
    ),
  );
});

test("REQUEST_ERROR を受信すると fetch が terminated に遷移する", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendFetch(
    buildStandaloneFetch(requestId, { group: 0n, object: 0n }, { group: 1n, object: 0n }),
  );
  p.nextEvent();
  const err: RequestError = {
    type: MessageType.REQUEST_ERROR,
    errorCode: 0n,
    retryInterval: 0n,
    reasonPhrase: "err",
  };
  p.handleStreamMessage(requestId, err);
  const entry = p.fetch(requestId);
  assert.ok(entry);
  assert.equal(entry.state, "terminated");
});

test("forgetFetch は terminated のみ除去する", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendFetch(
    buildStandaloneFetch(requestId, { group: 0n, object: 0n }, { group: 1n, object: 0n }),
  );
  p.nextEvent();
  assert.equal(p.forgetFetch(requestId), undefined);
  assert.ok(p.fetch(requestId));
  p.handleStreamMessage(requestId, {
    type: MessageType.REQUEST_ERROR,
    errorCode: 0n,
    retryInterval: 0n,
    reasonPhrase: "",
  });
  const forgotten = p.forgetFetch(requestId);
  assert.ok(forgotten);
  assert.equal(p.fetch(requestId), undefined);
});

test("established 前の sendFetch は PROTOCOL_VIOLATION", () => {
  const p = SessionMachine.createClient("webTransport", createSetup());
  p.nextEvent();
  assert.throws(() => {
    p.sendFetch(buildStandaloneFetch(0n, { group: 0n, object: 0n }, { group: 1n, object: 0n }));
  });
});

test("重複 requestId の sendFetch は PROTOCOL_VIOLATION で throw", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendFetch(
    buildStandaloneFetch(requestId, { group: 0n, object: 0n }, { group: 1n, object: 0n }),
  );
  p.nextEvent();
  assert.throws(() => {
    p.sendFetch(
      buildStandaloneFetch(requestId, { group: 0n, object: 0n }, { group: 2n, object: 0n }),
    );
  });
});

test("未登録 request_id への FETCH_OK は closeSession イベントを積む", () => {
  const p = established();
  const fakeId = 999n;
  const ok: FetchOk = {
    type: MessageType.FETCH_OK,
    endOfTrack: false,
    endLocation: { group: 0n, object: 0n },
    parameters: [],
    trackProperties: [],
  };
  p.handleStreamMessage(fakeId, ok);
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "closeSession");
  if (event.type === "closeSession") {
    assert.equal(event.error.code, SessionErrorCode.PROTOCOL_VIOLATION);
  }
});
