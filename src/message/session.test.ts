/**
 * MOQT PUBLISH_STATE_NOTIFY Unit Tests
 * draft-ietf-moq-transport-23 Section 9.10 (PUBLISH_STATE_NOTIFY)
 */

import { test, assert } from "vite-plus/test";
import {
  encodePublishStateNotifyPayload,
  decodePublishStateNotifyPayload,
  decodeRedirect,
  decodeGoawayPayload,
  encodeRedirect,
  encodeRequestErrorPayload,
  decodeRequestErrorPayload,
  decodeRequestOkPayload,
  encodeRequestOkPayload,
} from "./session";
import { encodeProperties } from "../properties";
import { MalformedTrackError } from "../error";
import { MessageType, MessageParameterType } from "./types";
import { createTrackNamespace } from "./parameter";
import { getMessageTypeName } from "./debug";
import { ProtocolViolationError, SessionErrorCode } from "../error";
import { concatUint8Arrays } from "../bytes";
import { encodeVarint } from "../varint";

/**
 * 例外を捕捉して返す
 *
 * vite-plus/test の assert.throws は述語関数を受け付けないため、
 * Error Code など例外のプロパティを検証するテストでは自前で捕捉する。
 */
function catchThrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/**
 * draft-ietf-moq-transport-23 §9.10:
 * PUBLISH_STATE_NOTIFY の encode / decode ラウンドトリップを検証する。
 * ペイロードは Number of Parameters + Parameters のみ (Request ID なし)。
 */
test("encodePublishStateNotifyPayload / decodePublishStateNotifyPayload: ラウンドトリップする", () => {
  const payload = encodePublishStateNotifyPayload({
    type: MessageType.PUBLISH_STATE_NOTIFY,
    parameters: [
      { type: MessageParameterType.LARGEST_OBJECT, value: new Uint8Array([0x01, 0x02]) },
      // PAUSED = 0 (unpaused) / 1 (paused)。0 も正当な値である
      { type: MessageParameterType.PAUSED, value: new Uint8Array([0]) },
    ],
  });

  const decoded = decodePublishStateNotifyPayload(payload);
  assert.equal(decoded.type, MessageType.PUBLISH_STATE_NOTIFY);
  assert.equal(decoded.parameters.length, 2);
  assert.equal(decoded.parameters[0].type, MessageParameterType.LARGEST_OBJECT);
  assert.deepEqual(decoded.parameters[0].value, new Uint8Array([0x01, 0x02]));
  assert.equal(decoded.parameters[1].type, 0x11);
});

/**
 * draft-ietf-moq-transport-23 §9.10:
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
 * draft-ietf-moq-transport-23 §9:
 * Message Body 長と消費バイト数が一致しない場合は MALFORMED_MESSAGE。
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
 * draft-ietf-moq-transport-23 §9.10:
 * Type 0x22 が PUBLISH_STATE_NOTIFY として名前解決される。
 */
test("getMessageTypeName: 0x22 は PUBLISH_STATE_NOTIFY", () => {
  assert.equal(MessageType.PUBLISH_STATE_NOTIFY, 0x22);
  assert.equal(getMessageTypeName(0x22), "PUBLISH_STATE_NOTIFY");
});

/**
 * draft-ietf-moq-transport-23 §9 Table 5 / Appendix A.1:
 * 旧 FETCH_OK の Type 0x18 は RESERVED (FETCH_OK in <= 22) であり、
 * FETCH の成功応答は REQUEST_OK (0x07) に統合された。0x18 は MessageType に
 * 定義を持たず、名前解決でも UNKNOWN として扱う (旧型として解釈しない)。
 */
test("getMessageTypeName: 旧 FETCH_OK (0x18) は予約値として UNKNOWN になる", () => {
  assert.equal(getMessageTypeName(0x18), "UNKNOWN(0x18)");
  assert.isFalse(Object.values(MessageType).includes(0x18 as never));
});

/**
 * Length 宣言 slice の境界検証 (切り詰め入力の宣言時点拒否)。
 *
 * draft-ietf-moq-transport-23 §9.4.1 / §9.2 / §9.4.2:
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

/**
 * draft-ietf-moq-transport-23 §9.4.1 / §9.4.2.1:
 * REQUEST_ERROR の末尾は Error Details の KVP 列であり、REDIRECT Error Detail は
 * Type 0x01 (奇数) の Length 付き Value として Redirect 情報を包む。
 * Error Code + Retry Interval + Error Reason + [Type/Detail] の固定ワイヤを検証する。
 */
test("encodeRequestErrorPayload: REDIRECT の固定ワイヤ", () => {
  const redirect = {
    connectUri: "moqt://example.com",
    trackNamespace: createTrackNamespace(["live"]),
    trackName: new TextEncoder().encode("video"),
  };

  const payload = encodeRequestErrorPayload({
    type: MessageType.REQUEST_ERROR,
    errorCode: 0x34n,
    retryInterval: 0n,
    reasonPhrase: "",
    redirect,
  });

  // Error Code 0x34 + Retry Interval 0 + Error Reason 長 0
  // + Error Detail Type delta 1 (REDIRECT) + Length 31 + Redirect 構造
  const expected = new Uint8Array([
    0x34,
    0x00,
    0x00,
    0x01,
    0x1f,
    // Connect URI Length 18 + "moqt://example.com"
    0x12,
    ...new TextEncoder().encode("moqt://example.com"),
    // Track Namespace: 1 field + Length 4 + "live"
    0x01,
    0x04,
    ...new TextEncoder().encode("live"),
    // Track Name Length 5 + "video"
    0x05,
    ...new TextEncoder().encode("video"),
  ]);

  assert.deepEqual(payload, expected);
});

/**
 * draft-ietf-moq-transport-23 §9.4.2.1:
 * "It accompanies Error Code REDIRECT and MUST be present when the Error Code is
 *  REDIRECT. An endpoint that receives a REQUEST_ERROR with Error Code REDIRECT and
 *  no REDIRECT Error Detail MUST close the session with MALFORMED_MESSAGE."
 */
test("decodeRequestErrorPayload: REDIRECT コードで REDIRECT Detail 欠落は MALFORMED_MESSAGE", () => {
  // Error Code 0x34 + Retry Interval 0 + Reason Length 0 (Error Details なし)
  const payload = new Uint8Array([0x34, 0x00, 0x00]);
  const thrown = catchThrown(() => decodeRequestErrorPayload(payload, 0));
  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.MALFORMED_MESSAGE);
  assert.isTrue(
    (thrown as ProtocolViolationError).message.includes("missing REDIRECT Error Detail"),
  );
});

/**
 * draft-ietf-moq-transport-23 §9.4.2.1:
 * Error Code が REDIRECT で REDIRECT Error Detail が続く場合は正常にデコードされ、
 * その後に未知の Error Detail が続いても無視される (§9.4.2)。
 */
test("decodeRequestErrorPayload: REDIRECT の後に未知の Error Detail が続いても無視する", () => {
  const redirect = {
    connectUri: "moqt://new.example.com/session",
    trackNamespace: createTrackNamespace(["live", "room"]),
    trackName: new TextEncoder().encode("video"),
  };
  const redirectBytes = encodeRedirect(redirect);
  const payload = concatUint8Arrays([
    new Uint8Array([0x34, 0x00, 0x00]),
    // REDIRECT (Type 0x01) の Length + Value
    encodeVarint(0x01n),
    encodeVarint(BigInt(redirectBytes.length)),
    redirectBytes,
    // 未知の偶数 Type 0x10 (GREASE ではない未登録型) の Value
    encodeVarint(0x0fn),
    encodeVarint(0x07n),
  ]);

  const decoded = decodeRequestErrorPayload(payload);
  assert.equal(decoded.errorCode, 0x34n);
  assert.isDefined(decoded.redirect);
  assert.equal(decoded.redirect!.connectUri, "moqt://new.example.com/session");
});

/**
 * draft-ietf-moq-transport-23 §9.4.2:
 * "Receivers MUST ignore unknown Error Detail types, and MUST ignore a known Error
 *  Detail type that accompanies an Error Code it is not defined for."
 * GREASE 用の予約値 (0x7f * N + 0x9D) も未登録型として無視する (§13 / §16.12)。
 */
test("decodeRequestErrorPayload: 未知の Error Detail (GREASE 含む) を無視する", () => {
  // Error Code INTERNAL_ERROR + Error Details に GREASE 値 0x9D の詳細だけを載せる
  const payload = concatUint8Arrays([
    new Uint8Array([0x00, 0x00, 0x00]),
    // Type 0x9D (GREASE) は奇数 Type のため Length + Value
    encodeVarint(0x9dn),
    encodeVarint(0x00n),
  ]);

  const decoded = decodeRequestErrorPayload(payload);
  assert.equal(decoded.errorCode, 0x00n);
  assert.isUndefined(decoded.redirect);
  assert.isUndefined(decoded.unsupportedPropertyTypes);
});

/**
 * draft-ietf-moq-transport-23 §9.4.2:
 * "Receivers MUST allow duplicates of unknown Error Detail types."
 * delta 0 で同じ未知 Type を繰り返しても拒否しない。
 */
test("decodeRequestErrorPayload: 未知の Error Detail の重複を拒否しない", () => {
  const payload = concatUint8Arrays([
    new Uint8Array([0x01, 0x00, 0x00]),
    // 未知の偶数 Type 0x10 の Value 5
    encodeVarint(0x10n),
    encodeVarint(0x05n),
    // 同じ Type 0x10 の Value 6 (delta 0)
    encodeVarint(0x00n),
    encodeVarint(0x06n),
  ]);

  const decoded = decodeRequestErrorPayload(payload);
  assert.equal(decoded.errorCode, 0x01n);
  assert.isUndefined(decoded.unsupportedPropertyTypes);
});

/**
 * draft-ietf-moq-transport-23 §9.4.2:
 * "Receivers MUST ignore ... a known Error Detail type that accompanies an Error
 *  Code it is not defined for."
 * UNSUPPORTED_PROPERTY (0x02) は UNSUPPORTED_EXTENSION のときだけ適用されるため、
 * 他の Error Code では無視する。
 */
test("decodeRequestErrorPayload: UNSUPPORTED_EXTENSION 以外の UNSUPPORTED_PROPERTY Detail を無視する", () => {
  const payload = concatUint8Arrays([
    // INTERNAL_ERROR
    new Uint8Array([0x00, 0x00, 0x00]),
    // Type 0x02 (UNSUPPORTED_PROPERTY) の Value 0x4000 (Mandatory Track Property)
    encodeVarint(0x02n),
    encodeVarint(0x4000n),
  ]);

  const decoded = decodeRequestErrorPayload(payload);
  assert.equal(decoded.errorCode, 0x00n);
  assert.isUndefined(decoded.unsupportedPropertyTypes);
});

/**
 * draft-ietf-moq-transport-23 §9.4.2:
 * REDIRECT (0x01) は Error Code が REDIRECT のときだけ適用されるため、
 * 他の Error Code で REDIRECT Detail を受信しても無視する。
 */
test("decodeRequestErrorPayload: REDIRECT 以外の Error Code の REDIRECT Detail を無視する", () => {
  const redirect = {
    connectUri: "moqt://example.com",
    trackNamespace: createTrackNamespace(["live"]),
    trackName: new TextEncoder().encode("video"),
  };
  const redirectBytes = encodeRedirect(redirect);
  const payload = concatUint8Arrays([
    // INTERNAL_ERROR
    new Uint8Array([0x00, 0x00, 0x00]),
    encodeVarint(0x01n),
    encodeVarint(BigInt(redirectBytes.length)),
    redirectBytes,
  ]);

  const decoded = decodeRequestErrorPayload(payload);
  assert.equal(decoded.errorCode, 0x00n);
  assert.isUndefined(decoded.redirect);
});

/**
 * draft-ietf-moq-transport-23 §9.4.2:
 * "Senders MUST NOT repeat the same Error Detail type in a message unless the type's
 *  definition explicitly allows multiple instances."
 * REDIRECT の定義は複数出現を許さないため、重複した REDIRECT Detail は
 * MALFORMED_MESSAGE として拒否する。
 */
test("decodeRequestErrorPayload: REDIRECT Detail の重複は MALFORMED_MESSAGE", () => {
  const redirect = {
    connectUri: "moqt://example.com",
    trackNamespace: createTrackNamespace(["live"]),
    trackName: new TextEncoder().encode("video"),
  };
  const redirectBytes = encodeRedirect(redirect);
  const payload = concatUint8Arrays([
    new Uint8Array([0x34, 0x00, 0x00]),
    encodeVarint(0x01n),
    encodeVarint(BigInt(redirectBytes.length)),
    redirectBytes,
    // delta 0 で同じ Type 0x01 を繰り返す
    encodeVarint(0x00n),
    encodeVarint(BigInt(redirectBytes.length)),
    redirectBytes,
  ]);

  const thrown = catchThrown(() => decodeRequestErrorPayload(payload));
  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.MALFORMED_MESSAGE);
  assert.isTrue(
    (thrown as ProtocolViolationError).message.includes("duplicate REDIRECT Error Detail"),
  );
});

/**
 * draft-ietf-moq-transport-23 §9.4.2.2:
 * UNSUPPORTED_PROPERTY は複数出現でき、各 Detail の Value は Mandatory Track
 * Property の Type (vi64) である。固定ワイヤと複数 Detail の復元を検証する。
 */
test("encodeRequestErrorPayload / decodeRequestErrorPayload: UNSUPPORTED_PROPERTY の固定ワイヤ", () => {
  const payload = encodeRequestErrorPayload({
    type: MessageType.REQUEST_ERROR,
    errorCode: 0x33n,
    retryInterval: 0n,
    reasonPhrase: "",
    unsupportedPropertyTypes: [0x4000n, 0x4001n],
  });

  // Error Code 0x33 + Retry Interval 0 + Error Reason 長 0
  // + Type delta 2 (UNSUPPORTED_PROPERTY) + Value 0x4000
  // + Type delta 0 (同じ Type の 2 件目) + Value 0x4001
  const expected = new Uint8Array([
    0x33, 0x00, 0x00, 0x02, 0xc0, 0x40, 0x00, 0x00, 0xc0, 0x40, 0x01,
  ]);
  assert.deepEqual(payload, expected);

  const decoded = decodeRequestErrorPayload(expected);
  assert.equal(decoded.errorCode, 0x33n);
  assert.deepEqual(decoded.unsupportedPropertyTypes, [0x4000n, 0x4001n]);
});

/**
 * draft-ietf-moq-transport-23 §8.3:
 * "If a receiver understands a Type, and the following Value or Length/Value does
 *  not match the serialization defined by that Type, the receiver MUST close the
 *  session with MALFORMED_KEY_VALUE."
 * REDIRECT Detail の Length が Redirect 構造より短い場合は MALFORMED_KEY_VALUE。
 */
test("decodeRequestErrorPayload: REDIRECT Detail の Length が構造と一致しないと MALFORMED_KEY_VALUE", () => {
  const payload = concatUint8Arrays([
    new Uint8Array([0x34, 0x00, 0x00]),
    // Type delta 1 (REDIRECT) + Length 5 (Redirect 構造として不足)
    encodeVarint(0x01n),
    encodeVarint(0x05n),
    new Uint8Array([0x12, 0x61, 0x62, 0x63, 0x64]),
  ]);

  const thrown = catchThrown(() => decodeRequestErrorPayload(payload));
  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.MALFORMED_KEY_VALUE);
});

/**
 * draft-ietf-moq-transport-23 §8.3:
 * REDIRECT Error Detail の Length が 0 で Redirect 構造が全く無い場合も、
 * 既知 Type の serialization 不一致として MALFORMED_KEY_VALUE。
 */
test("decodeRequestErrorPayload: 空の REDIRECT Detail は MALFORMED_KEY_VALUE", () => {
  const payload = concatUint8Arrays([
    new Uint8Array([0x34, 0x00, 0x00]),
    // Type delta 1 (REDIRECT) + Length 0
    encodeVarint(0x01n),
    encodeVarint(0x00n),
  ]);

  const thrown = catchThrown(() => decodeRequestErrorPayload(payload));
  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.MALFORMED_KEY_VALUE);
});

/**
 * draft-ietf-moq-transport-23 §8.3:
 * 奇数 Type の Length の最大値は 2^16-1 バイトであり、超過は FIELD_LENGTH_EXCEEDED。
 */
test("decodeRequestErrorPayload: Error Detail の Length が上限超過だと FIELD_LENGTH_EXCEEDED", () => {
  const payload = concatUint8Arrays([
    new Uint8Array([0x00, 0x00, 0x00]),
    // Type delta 1 (奇数 Type) + Length 65536 (上限超過)
    encodeVarint(0x01n),
    encodeVarint(65536n),
  ]);

  const thrown = catchThrown(() => decodeRequestErrorPayload(payload));
  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.FIELD_LENGTH_EXCEEDED);
});

/**
 * draft-ietf-moq-transport-23 §9.3 / §9.4:
 * REDIRECT コードと REDIRECT Error Detail の roundtrip (回帰ガード)。
 */
test("decodeRequestErrorPayload: REDIRECT コードと REDIRECT Detail の roundtrip", () => {
  const redirect = {
    connectUri: "moqt://new.example.com/session",
    trackNamespace: createTrackNamespace(["live", "room"]),
    trackName: new TextEncoder().encode("video"),
  };

  const payload = encodeRequestErrorPayload({
    type: MessageType.REQUEST_ERROR,
    errorCode: 0x34n,
    retryInterval: 0n,
    reasonPhrase: "",
    redirect,
  });

  const decoded = decodeRequestErrorPayload(payload);
  assert.equal(decoded.errorCode, 0x34n);
  assert.isDefined(decoded.redirect);
  assert.equal(decoded.redirect!.connectUri, "moqt://new.example.com/session");
});

// ============================================================================
// REQUEST_OK の Track Properties (draft-ietf-moq-transport-23 §8.4 / §9.3)
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §8.4 / §12.1 条件 8:
 * FETCH_OK / TRACK_STATUS_OK は Track Properties を運ぶため、propertyScope を
 * 渡した decode では Object-only の Property を malformed track とする。
 * TIMESTAMP (0x10) は Object scope 専用である。
 */
test("decodeRequestOkPayload: propertyScope 指定時に Object-only Property は MalformedTrackError", () => {
  const objectOnly = encodeProperties([{ id: 0x10n, value: 1n }]);
  const encoded = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [],
  });
  const withProperty = concatUint8Arrays([encoded, objectOnly]);

  // scope を渡さない (空必須 OK の文脈) では従来どおり検証しない
  assert.doesNotThrow(() => decodeRequestOkPayload(withProperty));
  // scope を渡す (FETCH_OK / TRACK_STATUS_OK の文脈) と malformed track
  assert.throws(
    () => decodeRequestOkPayload(withProperty, 0, "track"),
    MalformedTrackError,
    /scope/,
  );
});
