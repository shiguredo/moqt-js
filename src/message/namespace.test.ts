/**
 * namespace 系 6 メッセージの異常系・境界値テスト
 *
 * draft-ietf-moq-transport-23 §9 (Control Messages):
 * "If the length does not match the length of the Message Body, the receiver
 *  MUST close the session with a MALFORMED_MESSAGE."
 * 各メッセージの最後のフィールドの後ろに後続データがあると、消費バイト数が
 * Message Body 長と一致しないため違反となる。
 *
 * NAMESPACE は draft-ietf-moq-transport-23 §9.15 で Track Namespace Suffix の
 * 後ろに Number of Parameters と Parameters を持つ。空 Parameters の count を
 * 含む新ワイヤ、複数メッセージの連結、切り詰め、未知・重複の Message Parameter、
 * 余剰バイトを検証する。
 *
 * 正常系の round-trip は src/message/namespace.prop.ts の PBT が担う。
 * Length 宣言の超過は src/message/decode-boundary.test.ts が担う。
 */

import { test, assert } from "vite-plus/test";
import { MessageParameterType, MessageType } from "./types";
import {
  createTrackNamespace,
  encodeParameters,
  encodeTrackNamespace,
  trackNamespaceToStrings,
} from "./parameter";
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
import { concatUint8Arrays } from "../bytes";
import { encodeVarint } from "../varint";
import { ControlStreamReader, ControlStreamWriter } from "../controlStream";
import { IncompleteDataError, ProtocolViolationError, SessionErrorCode } from "../error";

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
    parameters: [],
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
 * draft-ietf-moq-transport-23 §9.15 (NAMESPACE):
 * Track Namespace Suffix は空 (フィールド数 0) を許す。空 Suffix は
 * プレフィックス全体を指すため、境界値として固定する。Parameters が空でも
 * Number of Parameters の 0 が続く。
 */
test("decodeNamespacePayload: 空の Track Namespace Suffix と空 Parameters は通過する", () => {
  const encoded = encodeNamespacePayload({
    type: MessageType.NAMESPACE,
    trackNamespaceSuffix: createTrackNamespace([]),
    parameters: [],
  });

  const decoded = decodeNamespacePayload(encoded, 0);
  assert.equal(decoded.trackNamespaceSuffix.tuple.length, 0);
  assert.deepEqual(decoded.parameters, []);
});

/**
 * draft-ietf-moq-transport-23 §9.15:
 * Parameters が空でも Number of Parameters (= 0) をワイヤに含める。
 * 空 suffix (フィールド数 0) と合わせて 2 バイトだけになることで、count の
 * 省略 (旧ワイヤ) と区別できる。
 */
test("encodeNamespacePayload: 空 Parameters でも Number of Parameters を含む", () => {
  const encoded = encodeNamespacePayload({
    type: MessageType.NAMESPACE,
    trackNamespaceSuffix: createTrackNamespace([]),
    parameters: [],
  });

  assert.deepEqual(Array.from(encoded), [0x00, 0x00]);
});

/**
 * draft-ietf-moq-transport-23 §9 / §9.15:
 * 制御ストリームのフレーミングは Type (vi64) + Message Length (vi64) + Payload。
 * Parameters 付きの NAMESPACE を 2 件連結しても、Message Length により境界が
 * 保たれ、それぞれ独立にデコードできることを検証する。
 */
test("decodeNamespacePayload: 複数メッセージを連結しても Parameters を含めて境界が保たれる", () => {
  const firstPayload = encodeNamespacePayload({
    type: MessageType.NAMESPACE,
    trackNamespaceSuffix: createTrackNamespace(["live"]),
    parameters: [],
  });
  const secondPayload = encodeNamespacePayload({
    type: MessageType.NAMESPACE,
    trackNamespaceSuffix: createTrackNamespace(["live", "sports"]),
    parameters: [{ type: MessageParameterType.EXPIRES, value: encodeVarint(1000n) }],
  });

  const writer = new ControlStreamWriter();
  const framed = concatUint8Arrays([
    writer.encode(MessageType.NAMESPACE, firstPayload),
    writer.encode(MessageType.NAMESPACE, secondPayload),
  ]);

  const reader = new ControlStreamReader();
  const messages = reader.feed(framed);
  assert.equal(messages.length, 2);

  const first = messages[0];
  const second = messages[1];
  assert.isDefined(first);
  assert.isDefined(second);

  const firstDecoded = decodeNamespacePayload(first.payload, 0);
  assert.deepEqual(trackNamespaceToStrings(firstDecoded.trackNamespaceSuffix), ["live"]);
  assert.deepEqual(firstDecoded.parameters, []);

  const secondDecoded = decodeNamespacePayload(second.payload, 0);
  assert.deepEqual(trackNamespaceToStrings(secondDecoded.trackNamespaceSuffix), ["live", "sports"]);
  assert.equal(secondDecoded.parameters.length, 1);
  assert.equal(secondDecoded.parameters[0]?.type, MessageParameterType.EXPIRES);
});

/**
 * draft-ietf-moq-transport-23 §9.15:
 * Number of Parameters が無い旧ワイヤ (suffix のみ) は、新しいワイヤでは
 * count の読み取りがデータ末尾を超えるため切り詰めとして拒否する。
 * これにより count を省略したフレームを黙って受理しない。
 */
test("decodeNamespacePayload: Number of Parameters の無い旧ワイヤは IncompleteDataError", () => {
  const suffixOnly = encodeTrackNamespace(createTrackNamespace(["live"]));

  assert.throws(() => decodeNamespacePayload(suffixOnly, 0), IncompleteDataError);
});

/**
 * draft-ietf-moq-transport-23 §9.15 / §9.19:
 * Parameter の Value が切り詰められた payload は IncompleteDataError になる。
 * 宣言された Value 長や varint 長が残りバイト数を超えるため、短い slice を
 * 受け入れずに切り詰めとして拒否する。
 */
test("decodeNamespacePayload: Parameters の Value の切り詰めは IncompleteDataError", () => {
  const encoded = encodeNamespacePayload({
    type: MessageType.NAMESPACE,
    trackNamespaceSuffix: createTrackNamespace(["live"]),
    parameters: [{ type: MessageParameterType.EXPIRES, value: encodeVarint(5000n) }],
  });

  // EXPIRES の 2 バイト varint の末尾 1 バイトを削る
  const truncated = encoded.subarray(0, -1);
  assert.throws(() => decodeNamespacePayload(truncated, 0), IncompleteDataError);
});

/**
 * draft-ietf-moq-transport-23 §9.19:
 * Number of Parameters が実際の Parameter 数より大きい payload は、
 * 不足した Parameter の読み取りでデータ末尾を超えるため IncompleteDataError になる。
 */
test("decodeNamespacePayload: count より Parameters が不足する切り詰めは IncompleteDataError", () => {
  const suffix = createTrackNamespace(["live"]);
  const encoded = encodeNamespacePayload({
    type: MessageType.NAMESPACE,
    trackNamespaceSuffix: suffix,
    parameters: [{ type: MessageParameterType.EXPIRES, value: encodeVarint(5000n) }],
  });
  const suffixLength = encodeTrackNamespace(suffix).length;
  // count 1 (varint 1 バイト) を count 2 に差し替え、Parameter は 1 件だけ残す
  const truncated = concatUint8Arrays([
    encoded.subarray(0, suffixLength),
    new Uint8Array([0x02]),
    encoded.subarray(suffixLength + 1),
  ]);

  assert.throws(() => decodeNamespacePayload(truncated, 0), IncompleteDataError);
});

/**
 * draft-ietf-moq-transport-23 §9.19:
 * "An endpoint that receives an unknown Message Parameter MUST close the session
 *  with INVALID_PARAMETER."
 * NAMESPACE でも未知の Parameter Type は読み飛ばさず INVALID_PARAMETER で拒否する。
 */
test("decodeNamespacePayload: 未知の Message Parameter 型は INVALID_PARAMETER", () => {
  const payload = concatUint8Arrays([
    encodeTrackNamespace(createTrackNamespace(["live"])),
    // Number of Parameters = 1
    new Uint8Array([0x01]),
    // Type Delta = 0x1f (どの Message Parameter 定義にも無い型)
    encodeVarint(0x1f),
  ]);

  const error = assert.throws(() => decodeNamespacePayload(payload, 0));
  assert.instanceOf(error, ProtocolViolationError);
  assert.equal((error as ProtocolViolationError).code, SessionErrorCode.INVALID_PARAMETER);
  assert.match((error as ProtocolViolationError).message, /unknown message parameter type: 0x1f/);
});

/**
 * draft-ietf-moq-transport-23 §9.19:
 * "Senders MUST NOT repeat the same Parameter Type in a message unless the parameter
 *  definition explicitly allows multiple instances of that type to be sent in a
 *  single message." / "Receivers SHOULD check that there are no unexpected duplicate
 *  parameters and close the session with INVALID_PARAMETER if found."
 * NAMESPACE でも反復できない型の重複は INVALID_PARAMETER で拒否する。
 */
test("decodeNamespacePayload: 同じ Message Parameter 型の重複は INVALID_PARAMETER", () => {
  const payload = concatUint8Arrays([
    encodeTrackNamespace(createTrackNamespace(["live"])),
    // Number of Parameters = 2
    new Uint8Array([0x02]),
    // PAUSED (0x11) = 1
    new Uint8Array([0x11, 0x01]),
    // Type Delta = 0 で PAUSED を再度載せる
    new Uint8Array([0x00, 0x01]),
  ]);

  const error = assert.throws(() => decodeNamespacePayload(payload, 0));
  assert.instanceOf(error, ProtocolViolationError);
  assert.equal((error as ProtocolViolationError).code, SessionErrorCode.INVALID_PARAMETER);
  assert.match((error as ProtocolViolationError).message, /duplicate message parameter type: 0x11/);
});

/**
 * draft-ietf-moq-transport-23 §9.15:
 * Number of Parameters が 0 のとき、その後ろに Parameter のバイト列が続いても
 * それは Message Body の余剰バイトである。count を無視して読み進めず、
 * MALFORMED_MESSAGE として拒否する。
 */
test("decodeNamespacePayload: count 0 の後ろの余剰 Parameter バイトは MALFORMED_MESSAGE", () => {
  const encoded = encodeNamespacePayload({
    type: MessageType.NAMESPACE,
    trackNamespaceSuffix: createTrackNamespace(["live"]),
    parameters: [],
  });
  // count 0 の後ろに、完全な Parameter 列 (count 1 + EXPIRES) を余剰として付ける
  const trailingParameters = encodeParameters([
    { type: MessageParameterType.EXPIRES, value: encodeVarint(1000n) },
  ]);
  const payload = concatUint8Arrays([encoded, trailingParameters]);

  assert.throws(
    () => decodeNamespacePayload(payload, 0),
    /trailing data in NAMESPACE: expected \d+ bytes, consumed \d+/,
  );
});
