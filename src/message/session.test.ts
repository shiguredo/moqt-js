/**
 * MOQT PUBLISH_STATE_NOTIFY Unit Tests
 * draft-ietf-moq-transport-20 Section 10.10 (PUBLISH_STATE_NOTIFY)
 */

import { test, assert } from "vite-plus/test";
import {
  encodePublishStateNotifyPayload,
  decodePublishStateNotifyPayload,
  decodeRedirect,
  decodeGoawayPayload,
  decodeRequestErrorPayload,
} from "./session";
import { MessageType, MessageParameterType } from "./types";
import { getMessageTypeName } from "./debug";
import { ProtocolViolationError } from "../error";

/**
 * draft-ietf-moq-transport-20 §10.10:
 * PUBLISH_STATE_NOTIFY の encode / decode ラウンドトリップを検証する。
 * ペイロードは Number of Parameters + Parameters のみ (Request ID なし)。
 */
test("encodePublishStateNotifyPayload / decodePublishStateNotifyPayload: ラウンドトリップする", () => {
  const payload = encodePublishStateNotifyPayload({
    type: MessageType.PUBLISH_STATE_NOTIFY,
    parameters: [
      { type: MessageParameterType.LARGEST_OBJECT, value: new Uint8Array([0x01, 0x02]) },
      { type: MessageParameterType.FORWARD, value: new Uint8Array([0]) },
    ],
  });

  const decoded = decodePublishStateNotifyPayload(payload);
  assert.equal(decoded.type, MessageType.PUBLISH_STATE_NOTIFY);
  assert.equal(decoded.parameters.length, 2);
  assert.equal(decoded.parameters[0].type, MessageParameterType.LARGEST_OBJECT);
  assert.deepEqual(decoded.parameters[0].value, new Uint8Array([0x01, 0x02]));
  assert.equal(decoded.parameters[1].type, 0x10);
});

/**
 * draft-ietf-moq-transport-20 §10.10:
 * 空パラメータの PUBLISH_STATE_NOTIFY も正当な通知として扱う。
 */
test("decodePublishStateNotifyPayload: 空パラメータをデコードできる", () => {
  const payload = encodePublishStateNotifyPayload({
    type: MessageType.PUBLISH_STATE_NOTIFY,
    parameters: [],
  });

  const decoded = decodePublishStateNotifyPayload(payload);
  assert.equal(decoded.parameters.length, 0);
});

/**
 * draft-ietf-moq-transport-20 §10:
 * Message Body 長と消費バイト数が一致しない場合は PROTOCOL_VIOLATION。
 */
test("decodePublishStateNotifyPayload: 余剰バイトがあると ProtocolViolationError", () => {
  const payload = encodePublishStateNotifyPayload({
    type: MessageType.PUBLISH_STATE_NOTIFY,
    parameters: [],
  });
  const trailing = new Uint8Array([...payload, 0x00]);

  assert.throws(() => decodePublishStateNotifyPayload(trailing), ProtocolViolationError);
});

/**
 * draft-ietf-moq-transport-20 §10.10:
 * Type 0x22 が PUBLISH_STATE_NOTIFY として名前解決される。
 */
test("getMessageTypeName: 0x22 は PUBLISH_STATE_NOTIFY", () => {
  assert.equal(MessageType.PUBLISH_STATE_NOTIFY, 0x22);
  assert.equal(getMessageTypeName(0x22), "PUBLISH_STATE_NOTIFY");
});

/**
 * Length 宣言 slice の境界検証 (切り詰め入力の宣言時点拒否)。
 *
 * draft-ietf-moq-transport-20 §10.6.1 / §10.4 / §10.6.2:
 * 制御ストリームは外側でフレーミング済みのため、Length 宣言が
 * 残りバイトを超える内側の不足は破損であり、短い slice を返さず
 * 宣言時点で ProtocolViolationError とする。
 */
test("decodeRedirect: URI Length 宣言超過で ProtocolViolationError", () => {
  // URI Length 5 宣言 + 2 バイトの切り詰め
  const truncated = new Uint8Array([0x05, 0xaa, 0xbb]);
  assert.throws(() => decodeRedirect(truncated, 0), /redirect URI length exceeds remaining data/);
});

test("decodeRedirect: Track Name Length 宣言超過で ProtocolViolationError", () => {
  // URI 長 1 + 1 バイト + 空 namespace + Track Name Length 5 宣言 + 2 バイトの切り詰め
  const truncated = new Uint8Array([0x01, 0xaa, 0x00, 0x05, 0xbb, 0xcc]);
  assert.throws(
    () => decodeRedirect(truncated, 0),
    /redirect track name length exceeds remaining data/,
  );
});

test("decodeGoawayPayload: URI Length 宣言超過で ProtocolViolationError", () => {
  // URI Length 5 宣言 + 2 バイトの切り詰め
  const truncated = new Uint8Array([0x05, 0xaa, 0xbb]);
  assert.throws(
    () => decodeGoawayPayload(truncated, 0),
    /GOAWAY URI length exceeds remaining data/,
  );
});

test("decodeRequestErrorPayload: Reason Length 宣言超過で ProtocolViolationError", () => {
  // Error Code + Retry Interval + Reason Length 5 宣言 + 2 バイトの切り詰め
  const truncated = new Uint8Array([0x00, 0x00, 0x05, 0xaa, 0xbb]);
  assert.throws(
    () => decodeRequestErrorPayload(truncated, 0),
    /reason phrase length exceeds remaining data/,
  );
});

test("decodeRedirect: offset 付きでも Track Name Length 宣言超過で ProtocolViolationError", () => {
  // 先頭 1 バイトのダミーを付けて offset=1 で読む (offset 項の回帰ガード)。
  // Length 3 + 2 バイトの境界ちょうどのため、offset 脱落式では検出できない
  const truncated = new Uint8Array([0x00, 0x01, 0xaa, 0x00, 0x03, 0xbb, 0xcc]);
  assert.throws(
    () => decodeRedirect(truncated, 1),
    /redirect track name length exceeds remaining data/,
  );
});
