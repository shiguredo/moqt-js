/**
 * Track Name / Reason 系ペイロードの Length 宣言境界テスト
 * (subscribe / publish / namespace / trackstatus 用。fetch / parameter /
 * session / properties は各 test にある)。
 *
 * draft-ietf-moq-transport-20 §10:
 * 制御ストリームは外側でフレーミング済みのため、Length 宣言が
 * 残りバイトを超える内側の不足は破損であり、短い slice を返さず
 * 宣言時点で ProtocolViolationError とする。
 */

import { test, assert } from "vite-plus/test";
import { decodeSubscribePayload } from "./subscribe";
import { decodePublishPayload, decodePublishDonePayload } from "./publish";
import { decodePublishSkippedPayload } from "./namespace";
import { decodeTrackStatusPayload } from "./trackstatus";

test("decodeSubscribePayload: Track Name Length 宣言超過で ProtocolViolationError", () => {
  // requestId + 空 namespace + Track Name Length 5 宣言 + 2 バイトの切り詰め
  const truncated = new Uint8Array([0x01, 0x00, 0x05, 0xaa, 0xbb]);
  assert.throws(
    () => decodeSubscribePayload(truncated, 0),
    /subscribe track name length exceeds remaining data/,
  );
});

test("decodePublishPayload: Track Name Length 宣言超過で ProtocolViolationError", () => {
  // requestId + 空 namespace + Track Name Length 5 宣言 + 2 バイトの切り詰め
  const truncated = new Uint8Array([0x01, 0x00, 0x05, 0xaa, 0xbb]);
  assert.throws(
    () => decodePublishPayload(truncated, 0),
    /publish track name length exceeds remaining data/,
  );
});

test("decodePublishDonePayload: Reason Length 宣言超過で ProtocolViolationError", () => {
  // Status Code + Stream Count + Reason Length 5 宣言 + 2 バイトの切り詰め。
  // 末尾検査ではなく宣言時点で拒否するため、文言で固定する
  const truncated = new Uint8Array([0x02, 0x00, 0x05, 0xaa, 0xbb]);
  assert.throws(
    () => decodePublishDonePayload(truncated, 0),
    /reason phrase length exceeds remaining data/,
  );
});

test("decodePublishSkippedPayload: Track Name Length 宣言超過で ProtocolViolationError", () => {
  // 空 namespace suffix + Track Name Length 5 宣言 + 2 バイトの切り詰め。
  // 末尾検査ではなく宣言時点で拒否するため、文言で固定する
  const truncated = new Uint8Array([0x00, 0x05, 0xaa, 0xbb]);
  assert.throws(
    () => decodePublishSkippedPayload(truncated, 0),
    /publish skipped track name length exceeds remaining data/,
  );
});

test("decodeTrackStatusPayload: Track Name Length 宣言超過で ProtocolViolationError", () => {
  // requestId + 空 namespace + Track Name Length 5 宣言 + 2 バイトの切り詰め
  const truncated = new Uint8Array([0x01, 0x00, 0x05, 0xaa, 0xbb]);
  assert.throws(
    () => decodeTrackStatusPayload(truncated, 0),
    /track status track name length exceeds remaining data/,
  );
});
