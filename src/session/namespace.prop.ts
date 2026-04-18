/**
 * SessionProtocol Namespace / TrackStatus Property-Based Tests
 * draft-ietf-moq-transport-17 Section 6, 9.16-9.21
 */

import { assert, test } from "vite-plus/test";
import { SessionErrorCode } from "../error";
import {
  createSetup,
  createTrackNamespace,
  encodeTrackName,
  MessageType,
  type Namespace,
  type NamespaceDone,
  NamespaceSubscribeMode,
  type PublishBlocked,
  type PublishNamespace,
  type RequestError,
  type RequestOk,
  type SubscribeNamespace,
  type TrackStatus,
} from "../message";
import { SessionProtocol } from "./protocol";

function established(): SessionProtocol {
  const p = SessionProtocol.createClient("webTransport", createSetup());
  p.nextEvent();
  p.handleControl(createSetup());
  p.nextEvent();
  return p;
}

function buildPublishNamespace(requestId: bigint, ns = ["a"]): PublishNamespace {
  return {
    type: MessageType.PUBLISH_NAMESPACE,
    requestId,
    requiredRequestIdDelta: 0n,
    trackNamespace: createTrackNamespace(ns),
    parameters: [],
  };
}

function buildSubscribeNamespace(
  requestId: bigint,
  mode: NamespaceSubscribeMode = NamespaceSubscribeMode.BOTH,
  ns = ["a"],
): SubscribeNamespace {
  return {
    type: MessageType.SUBSCRIBE_NAMESPACE,
    requestId,
    requiredRequestIdDelta: 0n,
    trackNamespacePrefix: createTrackNamespace(ns),
    subscribeOptions: mode,
    parameters: [],
  };
}

function buildTrackStatus(requestId: bigint, ns = ["a"], name = "x"): TrackStatus {
  return {
    type: MessageType.TRACK_STATUS,
    requestId,
    requiredRequestIdDelta: 0n,
    trackNamespace: createTrackNamespace(ns),
    trackName: encodeTrackName(name),
    parameters: [],
  };
}

const okMsg: RequestOk = { type: MessageType.REQUEST_OK, parameters: [] };
const errMsg: RequestError = {
  type: MessageType.REQUEST_ERROR,
  errorCode: 0n,
  retryInterval: 0n,
  reasonPhrase: "",
};

test("sendPublishNamespace が pending として登録し sendRequest を積む", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendPublishNamespace(buildPublishNamespace(requestId));
  const entry = p.namespacePublication(requestId);
  assert.ok(entry);
  assert.equal(entry.state, "pending");
  assert.equal(entry.myRole, "publisher");
  const event = p.nextEvent();
  assert.equal(event?.type, "sendRequest");
});

test("PUBLISH_NAMESPACE への REQUEST_OK で established に遷移する", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendPublishNamespace(buildPublishNamespace(requestId));
  p.nextEvent();
  p.handleStreamMessage(requestId, okMsg);
  const entry = p.namespacePublication(requestId);
  assert.equal(entry?.state, "established");
});

test("PUBLISH_NAMESPACE への REQUEST_ERROR で terminated に遷移する", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendPublishNamespace(buildPublishNamespace(requestId));
  p.nextEvent();
  p.handleStreamMessage(requestId, errMsg);
  const entry = p.namespacePublication(requestId);
  assert.equal(entry?.state, "terminated");
});

test("sendSubscribeNamespace が mode を options に変換して登録する", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendSubscribeNamespace(buildSubscribeNamespace(requestId, NamespaceSubscribeMode.NAMESPACE));
  const entry = p.namespaceSubscription(requestId);
  assert.ok(entry);
  assert.equal(entry.state, "pending");
  assert.equal(entry.options, "namespaceOnly");
});

test("NAMESPACE 受信で namespaceReceived イベントを積む", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendSubscribeNamespace(buildSubscribeNamespace(requestId));
  p.nextEvent();
  p.handleStreamMessage(requestId, okMsg);
  const nsMsg: Namespace = {
    type: MessageType.NAMESPACE,
    trackNamespaceSuffix: createTrackNamespace(["x"]),
  };
  p.handleStreamMessage(requestId, nsMsg);
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "namespaceReceived");
  if (event.type === "namespaceReceived") {
    assert.equal(event.requestId, requestId);
  }
});

test("NAMESPACE_DONE 受信で namespaceDoneReceived イベントを積む", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendSubscribeNamespace(buildSubscribeNamespace(requestId));
  p.nextEvent();
  p.handleStreamMessage(requestId, okMsg);
  const doneMsg: NamespaceDone = {
    type: MessageType.NAMESPACE_DONE,
    trackNamespaceSuffix: createTrackNamespace(["x"]),
  };
  p.handleStreamMessage(requestId, doneMsg);
  const event = p.nextEvent();
  assert.equal(event?.type, "namespaceDoneReceived");
});

test("PUBLISH_BLOCKED 受信で publishBlockedReceived イベントを積む", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendSubscribeNamespace(buildSubscribeNamespace(requestId));
  p.nextEvent();
  p.handleStreamMessage(requestId, okMsg);
  const blocked: PublishBlocked = {
    type: MessageType.PUBLISH_BLOCKED,
    trackNamespaceSuffix: createTrackNamespace(["y"]),
    trackName: encodeTrackName("t"),
  };
  p.handleStreamMessage(requestId, blocked);
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "publishBlockedReceived");
});

test("sendTrackStatus が pending として登録し sendRequest を積む", () => {
  const p = established();
  const requestId = p.nextLocalRequestId();
  p.sendTrackStatus(buildTrackStatus(requestId));
  const entry = p.trackStatusRequest(requestId);
  assert.equal(entry?.state, "pending");
  const event = p.nextEvent();
  assert.equal(event?.type, "sendRequest");
});

test("TRACK_STATUS への REQUEST_OK で completed、REQUEST_ERROR で failed に遷移する", () => {
  const p1 = established();
  const r1 = p1.nextLocalRequestId();
  p1.sendTrackStatus(buildTrackStatus(r1));
  p1.nextEvent();
  p1.handleStreamMessage(r1, okMsg);
  assert.equal(p1.trackStatusRequest(r1)?.state, "completed");

  const p2 = established();
  const r2 = p2.nextLocalRequestId();
  p2.sendTrackStatus(buildTrackStatus(r2));
  p2.nextEvent();
  p2.handleStreamMessage(r2, errMsg);
  assert.equal(p2.trackStatusRequest(r2)?.state, "failed");
});

test("未登録 request_id への NAMESPACE は closeSession を積む", () => {
  const p = established();
  const nsMsg: Namespace = {
    type: MessageType.NAMESPACE,
    trackNamespaceSuffix: createTrackNamespace(["x"]),
  };
  p.handleStreamMessage(999n, nsMsg);
  const event = p.nextEvent();
  assert.ok(event);
  assert.equal(event.type, "closeSession");
  if (event.type === "closeSession") {
    assert.equal(event.error.code, SessionErrorCode.PROTOCOL_VIOLATION);
  }
});
