/**
 * MOQT PUBLISH_STATE_NOTIFY Unit Tests
 * draft-ietf-moq-transport-20 Section 10.10 (PUBLISH_STATE_NOTIFY)
 */

import { test, assert } from "vite-plus/test";
import { encodePublishStateNotifyPayload, decodePublishStateNotifyPayload } from "./session";
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
