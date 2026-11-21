/**
 * Track Name / Reason 系ペイロードの Length 宣言境界テスト
 * (subscribe / publish / namespace / trackstatus 用。fetch / parameter /
 * session / properties は各 test にある)。
 *
 * draft-ietf-moq-transport-23 §9:
 * 制御ストリームは外側でフレーミング済みのため、Length 宣言が
 * 残りバイトを超える内側の不足は破損であり、短い slice を返さず
 * 宣言時点で ProtocolViolationError とする。
 */

import { test, assert } from "vite-plus/test";
import { decodeSubscribeOkPayload, decodeSubscribePayload } from "./subscribe";
import { decodePublishPayload, decodePublishDonePayload } from "./publish";
import { decodePublishSkippedPayload } from "./namespace";
import { decodeTrackStatusPayload } from "./trackstatus";
import { decodeRequestOkPayload } from "./session";
import { ProtocolViolationError, SessionErrorCode } from "../error";
import { encodeVarint, MAX_VARINT } from "../varint";
import { captureThrownError } from "../testSupport/helpers";

test("制御メッセージではパラメータの値域違反より Track Properties の上限違反を優先する", () => {
  const messages = [
    [decodeRequestOkPayload, []],
    [decodeSubscribeOkPayload, [7]],
    [decodePublishPayload, [0, 0, 1, 0x74, 7]],
  ] as const;
  const propertyErrors = [
    [[0x7d, ...encodeVarint(65536n)], SessionErrorCode.FIELD_LENGTH_EXCEEDED],
    [[...encodeVarint(MAX_VARINT), 0, 1], SessionErrorCode.DELTA_ENCODING_OVERFLOW],
  ] as const;

  for (const [decode, prefix] of messages) {
    for (const [properties, code] of propertyErrors) {
      // PAUSED の値 2 は不正だが、固定長なので直後の Track Properties まで進める。
      const wire = Uint8Array.of(0xff, ...prefix, 1, 0x11, 2, ...properties);
      const thrown = captureThrownError(() => decode(wire, 1));
      assert.instanceOf(thrown, ProtocolViolationError);
      assert.equal((thrown as ProtocolViolationError).code, code);
    }
  }
});

test("Track Properties の境界が不明か上限違反がなければ INVALID_PARAMETER を保持する", () => {
  const oversized = Uint8Array.of(0x7d, ...encodeVarint(65536n));
  for (const wire of [
    Uint8Array.of(1, 0x7f, ...oversized), // 未知のパラメータ型は Value の長さが分からない。
    Uint8Array.of(1, 0x11, 2, 0x11, 1, 0x80), // Track Properties には別の形式違反がある。
  ]) {
    const thrown = captureThrownError(() => decodeRequestOkPayload(wire));
    assert.instanceOf(thrown, ProtocolViolationError);
    assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.INVALID_PARAMETER);
  }
});

test("復号した Track Property の Value は入力バッファを再利用しても変化しない", () => {
  const wire = Uint8Array.of(0, 0x7d, 3, 0xaa, 0xbb, 0xcc);
  const { trackProperties } = decodeRequestOkPayload(wire, 0, "track");
  wire.fill(0);
  assert.deepEqual(trackProperties, [{ id: 0x7dn, data: Uint8Array.of(0xaa, 0xbb, 0xcc) }]);
});

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
