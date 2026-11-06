/**
 * Track Name の非空制約のテスト
 *
 * draft-ietf-moq-transport-23 §2.4.1 (Track Naming):
 * "Each Track Name MUST contain at least one byte.  If an endpoint receives a
 *  Track Name with a length of 0, it MUST close the session with a
 *  PROTOCOL_VIOLATION."
 *
 * 通常メッセージ (SUBSCRIBE / PUBLISH / FETCH / TRACK_STATUS / PUBLISH_SKIPPED) の
 * 受信で空 Track Name を拒否し、送信 API ではストリーム生成前に fail-fast すること、
 * Track Namespace が 0 フィールドでも Track Name が非空なら合法であることを検証する。
 * namespace-scoped Redirect の空 Track Name は別テスト (REQUEST_ERROR の scope 検証)
 * が担う。
 */

import { test, assert } from "vite-plus/test";
import { MessageType } from "./types";
import { ProtocolViolationError, SessionErrorCode } from "../error";
import {
  MAX_TRACK_NAME_SIZE,
  encodeTrackName,
  validateTrackNameNonEmpty,
} from "./parameter/trackNamespace";
import { createTrackNamespace } from "./parameter";
import { decodePublishPayload, encodePublishPayload } from "./publish";
import { decodeSubscribePayload, encodeSubscribePayload } from "./subscribe";
import { decodeFetchPayload, encodeFetchPayload } from "./fetch";
import { decodeTrackStatusPayload, encodeTrackStatusPayload } from "./trackstatus";
import { decodePublishSkippedPayload, encodePublishSkippedPayload } from "./namespace";

/**
 * ProtocolViolationError と PROTOCOL_VIOLATION を検証する
 */
function assertProtocolViolation(error: unknown): void {
  assert.instanceOf(error, ProtocolViolationError);
  assert.equal((error as ProtocolViolationError).code, SessionErrorCode.PROTOCOL_VIOLATION);
}

/**
 * 各通常メッセージの空 Track Name が受信時に PROTOCOL_VIOLATION になることを
 * メッセージ種別ごとに検証する。
 */
test("空の Track Name は通常メッセージの受信で PROTOCOL_VIOLATION になる", () => {
  const emptyName = new Uint8Array(0);
  const namespace = createTrackNamespace(["live"]);

  const publishWire = encodePublishPayload({
    type: MessageType.PUBLISH,
    requestId: 1n,
    trackNamespace: namespace,
    trackName: emptyName,
    trackAlias: 1n,
    parameters: [],
    trackProperties: [],
  });
  assertProtocolViolation(assertThrowsValue(() => decodePublishPayload(publishWire)));

  const subscribeWire = encodeSubscribePayload({
    type: MessageType.SUBSCRIBE,
    requestId: 2n,
    trackNamespace: namespace,
    trackName: emptyName,
    parameters: [],
  });
  assertProtocolViolation(assertThrowsValue(() => decodeSubscribePayload(subscribeWire)));

  const fetchWire = encodeFetchPayload({
    type: MessageType.FETCH,
    requestId: 4n,
    trackNamespace: namespace,
    trackName: emptyName,
    parameters: [],
  });
  assertProtocolViolation(assertThrowsValue(() => decodeFetchPayload(fetchWire)));

  const trackStatusWire = encodeTrackStatusPayload({
    type: MessageType.TRACK_STATUS,
    requestId: 6n,
    trackNamespace: namespace,
    trackName: emptyName,
    parameters: [],
  });
  assertProtocolViolation(assertThrowsValue(() => decodeTrackStatusPayload(trackStatusWire)));

  const publishSkippedWire = encodePublishSkippedPayload({
    type: MessageType.PUBLISH_SKIPPED,
    trackNamespaceSuffix: namespace,
    trackName: emptyName,
  });
  assertProtocolViolation(assertThrowsValue(() => decodePublishSkippedPayload(publishSkippedWire)));
});

/**
 * throw された値を取り出す
 */
function assertThrowsValue(callback: () => unknown): unknown {
  let thrown: unknown;
  let didThrow = false;
  try {
    callback();
  } catch (error) {
    thrown = error;
    didThrow = true;
  }
  assert.isTrue(didThrow, "例外が throw されなかった");
  return thrown;
}

/**
 * draft-ietf-moq-transport-23 §2.4.1:
 * "between 0 and 32 Track Namespace Fields" のとおり、Track Namespace の
 * 0 フィールドは合法である。空 namespace + 非空 Track Name を受信できる。
 */
test("空の Track Namespace + 非空 Track Name は受理する", () => {
  const wire = encodePublishPayload({
    type: MessageType.PUBLISH,
    requestId: 1n,
    trackNamespace: createTrackNamespace([]),
    trackName: new TextEncoder().encode("track"),
    trackAlias: 1n,
    parameters: [],
    trackProperties: [],
  });

  const decoded = decodePublishPayload(wire);
  assert.equal(decoded.trackNamespace.tuple.length, 0);
  assert.equal(new TextDecoder().decode(decoded.trackName), "track");
});

/**
 * draft-ietf-moq-transport-23 §2.4.1:
 * 1 バイトの Track Name は合法、マルチバイト UTF-8 は文字数ではなくバイト数で
 * 上限判定する。上限ちょうどは通過し、1 バイト超過は拒否する。
 */
test("Track Name は 1 バイト以上・バイト数で上限を判定する", () => {
  // 1 バイト
  assert.equal(encodeTrackName("a").length, 1);
  // マルチバイト UTF-8 (3 バイト)
  assert.equal(encodeTrackName("あ").length, 3);

  // 上限ちょうど (ASCII 4096 バイト) は通過
  const maxName = "a".repeat(MAX_TRACK_NAME_SIZE);
  assert.equal(encodeTrackName(maxName).length, MAX_TRACK_NAME_SIZE);
  // 1 バイト超過
  assert.throws(() => encodeTrackName("a".repeat(MAX_TRACK_NAME_SIZE + 1)));
});

/**
 * 送信 API の Track Name エンコーダは空を fail-fast し、validateTrackNameNonEmpty は
 * 受信バイト列の 0 バイトを PROTOCOL_VIOLATION にする。
 */
test("encodeTrackName は空を拒否し、validateTrackNameNonEmpty は 0 バイトを拒否する", () => {
  assert.throws(() => encodeTrackName(""), /track name must not be empty/);
  assertProtocolViolation(
    assertThrowsValue(() => validateTrackNameNonEmpty(new Uint8Array(0), "publish")),
  );
  // 1 バイト以上は通過
  validateTrackNameNonEmpty(new Uint8Array([0x61]), "publish");
});
