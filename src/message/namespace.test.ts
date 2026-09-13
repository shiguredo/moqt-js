/**
 * namespace 系 6 メッセージの異常系・境界値テスト
 *
 * draft-ietf-moq-transport-21 §9 (Control Messages):
 * "If the length does not match the length of the Message Body, the receiver
 *  MUST close the session with a PROTOCOL_VIOLATION."
 * 各メッセージの最後のフィールドの後ろに後続データがあると、消費バイト数が
 * Message Body 長と一致しないため違反となる。
 *
 * 正常系の round-trip は src/message/namespace.prop.ts の PBT が担う。
 * Length 宣言の超過は src/message/decode-boundary.test.ts が担う。
 */

import { test, assert } from "vite-plus/test";
import { MessageType } from "./types";
import { createTrackNamespace } from "./parameter";
import {
  decodeNamespaceDonePayload,
  decodeNamespacePayload,
  decodePublishNamespacePayload,
  decodePublishSkippedPayload,
  decodeSubscribeNamespacePayload,
  decodeSubscribeTracksPayload,
  encodeNamespaceDonePayload,
  encodeNamespacePayload,
  encodePublishNamespacePayload,
  encodePublishSkippedPayload,
  encodeSubscribeNamespacePayload,
  encodeSubscribeTracksPayload,
} from "./namespace";

/**
 * 末尾に 1 バイト足した payload を返す
 *
 * @param encoded - 正常にエンコードした payload
 */
function appendTrailingByte(encoded: Uint8Array): Uint8Array {
  return new Uint8Array([...encoded, 0xff]);
}

test("decodePublishNamespacePayload: 末尾に後続データがあると PROTOCOL_VIOLATION", () => {
  const encoded = encodePublishNamespacePayload({
    type: MessageType.PUBLISH_NAMESPACE,
    requestId: 1n,
    trackNamespace: createTrackNamespace(["live"]),
    parameters: [],
  });

  assert.throws(
    () => decodePublishNamespacePayload(appendTrailingByte(encoded), 0),
    /trailing data in PUBLISH_NAMESPACE: expected \d+ bytes, consumed \d+/,
  );
});

test("decodeNamespacePayload: 末尾に後続データがあると PROTOCOL_VIOLATION", () => {
  const encoded = encodeNamespacePayload({
    type: MessageType.NAMESPACE,
    trackNamespaceSuffix: createTrackNamespace(["sports"]),
  });

  assert.throws(
    () => decodeNamespacePayload(appendTrailingByte(encoded), 0),
    /trailing data in NAMESPACE: expected \d+ bytes, consumed \d+/,
  );
});

test("decodeNamespaceDonePayload: 末尾に後続データがあると PROTOCOL_VIOLATION", () => {
  const encoded = encodeNamespaceDonePayload({
    type: MessageType.NAMESPACE_DONE,
    trackNamespaceSuffix: createTrackNamespace(["sports"]),
  });

  assert.throws(
    () => decodeNamespaceDonePayload(appendTrailingByte(encoded), 0),
    /trailing data in NAMESPACE_DONE: expected \d+ bytes, consumed \d+/,
  );
});

test("decodeSubscribeNamespacePayload: 末尾に後続データがあると PROTOCOL_VIOLATION", () => {
  const encoded = encodeSubscribeNamespacePayload({
    type: MessageType.SUBSCRIBE_NAMESPACE,
    requestId: 1n,
    trackNamespacePrefix: createTrackNamespace(["live"]),
    parameters: [],
  });

  assert.throws(
    () => decodeSubscribeNamespacePayload(appendTrailingByte(encoded), 0),
    /trailing data in SUBSCRIBE_NAMESPACE: expected \d+ bytes, consumed \d+/,
  );
});

test("decodeSubscribeTracksPayload: 末尾に後続データがあると PROTOCOL_VIOLATION", () => {
  const encoded = encodeSubscribeTracksPayload({
    type: MessageType.SUBSCRIBE_TRACKS,
    requestId: 1n,
    trackNamespacePrefix: createTrackNamespace(["live"]),
    parameters: [],
  });

  assert.throws(
    () => decodeSubscribeTracksPayload(appendTrailingByte(encoded), 0),
    /trailing data in SUBSCRIBE_TRACKS: expected \d+ bytes, consumed \d+/,
  );
});

test("decodePublishSkippedPayload: 末尾に後続データがあると PROTOCOL_VIOLATION", () => {
  const encoded = encodePublishSkippedPayload({
    type: MessageType.PUBLISH_SKIPPED,
    trackNamespaceSuffix: createTrackNamespace(["sports"]),
    trackName: new TextEncoder().encode("video"),
  });

  assert.throws(
    () => decodePublishSkippedPayload(appendTrailingByte(encoded), 0),
    /trailing data in PUBLISH_SKIPPED: expected \d+ bytes, consumed \d+/,
  );
});

/**
 * draft-ietf-moq-transport-21 §9.16 (NAMESPACE):
 * Track Namespace Suffix は空 (フィールド数 0) を許す。空 Suffix は
 * プレフィックス全体を指すため、境界値として固定する。
 */
test("decodeNamespacePayload: 空の Track Namespace Suffix は通過する", () => {
  const encoded = encodeNamespacePayload({
    type: MessageType.NAMESPACE,
    trackNamespaceSuffix: createTrackNamespace([]),
  });

  const decoded = decodeNamespacePayload(encoded, 0);
  assert.equal(decoded.trackNamespaceSuffix.tuple.length, 0);
});
