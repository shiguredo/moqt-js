/**
 * SUBSCRIBE / REQUEST_UPDATE の異常系・境界値テスト
 *
 * draft-ietf-moq-transport-23 §9 (Control Messages):
 * "If the length does not match the length of the Message Body, the receiver
 *  MUST close the session with MALFORMED_MESSAGE."
 * Parameters は両メッセージの最後のフィールドであり、その後ろに後続データが
 * あると消費バイト数が Message Body 長と一致しないため違反となる。
 *
 * 正常系の round-trip は src/message/subscribe.prop.ts の PBT が担う。
 * Length 宣言の超過は src/message/decode-boundary.test.ts が担う。
 */

import { test, assert } from "vite-plus/test";
import { MessageType } from "./types";
import { createTrackNamespace } from "./parameter";
import {
  decodeRequestUpdatePayload,
  decodeSubscribeOkPayload,
  decodeSubscribePayload,
  encodeRequestUpdatePayload,
  encodeSubscribeOkPayload,
  encodeSubscribePayload,
} from "./subscribe";
import { MalformedTrackError, ProtocolViolationError, SessionErrorCode } from "../error";
import { encodeProperties } from "../properties";
import { captureThrownError } from "../testSupport/helpers";

test("decodeSubscribePayload: 末尾に後続データがあると MALFORMED_MESSAGE", () => {
  const encoded = encodeSubscribePayload({
    type: MessageType.SUBSCRIBE,
    requestId: 1n,
    trackNamespace: createTrackNamespace(["live"]),
    trackName: new TextEncoder().encode("video"),
    parameters: [],
  });
  // Parameters の後ろに 1 バイト余分を足す
  const withTrailing = new Uint8Array([...encoded, 0xff]);

  const thrown = captureThrownError(() => decodeSubscribePayload(withTrailing, 0));
  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.MALFORMED_MESSAGE);
});

test("decodeRequestUpdatePayload: 末尾に後続データがあると MALFORMED_MESSAGE", () => {
  const encoded = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 1n,
    parameters: [],
  });
  const withTrailing = new Uint8Array([...encoded, 0xff]);

  const thrown = captureThrownError(() => decodeRequestUpdatePayload(withTrailing, 0));
  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.MALFORMED_MESSAGE);
});

test("decodeSubscribePayload: offset 指定でも末尾判定は対象範囲全体で行う", () => {
  // 前に 1 バイトのプレフィックスを置き、offset = 1 から読む
  const encoded = encodeSubscribePayload({
    type: MessageType.SUBSCRIBE,
    requestId: 1n,
    trackNamespace: createTrackNamespace(["live"]),
    trackName: new TextEncoder().encode("video"),
    parameters: [],
  });
  const withPrefix = new Uint8Array([0x00, ...encoded]);
  const decoded = decodeSubscribePayload(withPrefix, 1);
  assert.equal(decoded.requestId, 1n);

  // 末尾に余分がある場合は offset 指定でも拒否する
  const withPrefixAndTrailing = new Uint8Array([0x00, ...encoded, 0xff]);
  assert.throws(
    () => decodeSubscribePayload(withPrefixAndTrailing, 1),
    /trailing data in SUBSCRIBE/,
  );
});

// ============================================================================
// SUBSCRIBE_OK の Track Properties (draft-ietf-moq-transport-23 §8.4 / §9.7)
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §8.4 / §12.1 条件 8:
 * 対応済み Property を定義外の scope で受信したら Track を malformed とする。
 * SUBSCRIBE_OK は Track Properties を運ぶため、Object-only の Property
 * (LOC の TIMESTAMP 0x10) を受けたら MalformedTrackError になる。
 */
test("decodeSubscribeOkPayload: Object-only Property を Track Properties に受けると MalformedTrackError", () => {
  // TIMESTAMP (0x10) は Object scope 専用
  const trackProperties = encodeProperties([{ id: 0x10n, value: 1n }]);
  const encoded = encodeSubscribeOkPayload({
    type: MessageType.SUBSCRIBE_OK,
    trackAlias: 1n,
    parameters: [],
    trackProperties: [],
  });

  // Track Properties 部分だけを差し替える (Parameters は空のまま)
  const rewritten = new Uint8Array([...encoded.slice(0), ...trackProperties]);

  assert.throws(() => decodeSubscribeOkPayload(rewritten), MalformedTrackError, /scope/);
});

/**
 * draft-ietf-moq-transport-23 §8.4 / §12.1 条件 9:
 * 対応済み Property の重複も Track を malformed とする。
 */
test("decodeSubscribeOkPayload: 対応済み Track Property の重複は MalformedTrackError", () => {
  // TIMESCALE (0x08) を 2 回載せる
  const duplicated = encodeProperties([
    { id: 0x08n, value: 1000n },
    { id: 0x08n, value: 2000n },
  ]);
  const encoded = encodeSubscribeOkPayload({
    type: MessageType.SUBSCRIBE_OK,
    trackAlias: 1n,
    parameters: [],
    trackProperties: [],
  });
  const rewritten = new Uint8Array([...encoded.slice(0), ...duplicated]);

  assert.throws(() => decodeSubscribeOkPayload(rewritten), MalformedTrackError, /duplicate/);
});
