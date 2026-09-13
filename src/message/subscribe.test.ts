/**
 * SUBSCRIBE / REQUEST_UPDATE の異常系・境界値テスト
 *
 * draft-ietf-moq-transport-21 §9 (Control Messages):
 * "If the length does not match the length of the Message Body, the receiver
 *  MUST close the session with a PROTOCOL_VIOLATION."
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
  decodeSubscribePayload,
  encodeRequestUpdatePayload,
  encodeSubscribePayload,
} from "./subscribe";

test("decodeSubscribePayload: 末尾に後続データがあると PROTOCOL_VIOLATION", () => {
  const encoded = encodeSubscribePayload({
    type: MessageType.SUBSCRIBE,
    requestId: 1n,
    trackNamespace: createTrackNamespace(["live"]),
    trackName: new TextEncoder().encode("video"),
    parameters: [],
  });
  // Parameters の後ろに 1 バイト余分を足す
  const withTrailing = new Uint8Array([...encoded, 0xff]);

  assert.throws(
    () => decodeSubscribePayload(withTrailing, 0),
    /trailing data in SUBSCRIBE: expected \d+ bytes, consumed \d+/,
  );
});

test("decodeRequestUpdatePayload: 末尾に後続データがあると PROTOCOL_VIOLATION", () => {
  const encoded = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 1n,
    parameters: [],
  });
  const withTrailing = new Uint8Array([...encoded, 0xff]);

  assert.throws(
    () => decodeRequestUpdatePayload(withTrailing, 0),
    /trailing data in REQUEST_UPDATE: expected \d+ bytes, consumed \d+/,
  );
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
