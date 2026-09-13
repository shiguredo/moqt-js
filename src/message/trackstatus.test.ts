/**
 * TRACK_STATUS の異常系・境界値テスト
 *
 * draft-ietf-moq-transport-21 §9 (Control Messages):
 * "If the length does not match the length of the Message Body, the receiver
 *  MUST close the session with a PROTOCOL_VIOLATION."
 * Parameters は TRACK_STATUS の最後のフィールドであり、その後ろに後続データが
 * あると消費バイト数が Message Body 長と一致しないため違反となる。
 *
 * 正常系の round-trip は src/message/trackstatus.prop.ts の PBT が担う。
 * Length 宣言の超過は src/message/decode-boundary.test.ts が担う。
 */

import { test, assert } from "vite-plus/test";
import { MessageType } from "./types";
import { createTrackNamespace } from "./parameter";
import { decodeTrackStatusPayload, encodeTrackStatusPayload } from "./trackstatus";

test("decodeTrackStatusPayload: 末尾に後続データがあると PROTOCOL_VIOLATION", () => {
  const encoded = encodeTrackStatusPayload({
    type: MessageType.TRACK_STATUS,
    requestId: 1n,
    trackNamespace: createTrackNamespace(["live"]),
    trackName: new TextEncoder().encode("video"),
    parameters: [],
  });
  const withTrailing = new Uint8Array([...encoded, 0xff]);

  assert.throws(
    () => decodeTrackStatusPayload(withTrailing, 0),
    /trailing data in TRACK_STATUS: expected \d+ bytes, consumed \d+/,
  );
});

/**
 * draft-ietf-moq-transport-21 §9.13:
 * TRACK_STATUS のメッセージ形式は SUBSCRIBE と同一である。Track Name の直後に
 * Parameters が続き、後続データは無い。
 */
test("decodeTrackStatusPayload: offset 指定でも末尾判定は対象範囲全体で行う", () => {
  const encoded = encodeTrackStatusPayload({
    type: MessageType.TRACK_STATUS,
    requestId: 3n,
    trackNamespace: createTrackNamespace(["live"]),
    trackName: new TextEncoder().encode("video"),
    parameters: [],
  });
  const withPrefix = new Uint8Array([0x00, ...encoded]);
  const decoded = decodeTrackStatusPayload(withPrefix, 1);
  assert.equal(decoded.requestId, 3n);

  const withPrefixAndTrailing = new Uint8Array([0x00, ...encoded, 0xff]);
  assert.throws(
    () => decodeTrackStatusPayload(withPrefixAndTrailing, 1),
    /trailing data in TRACK_STATUS/,
  );
});
