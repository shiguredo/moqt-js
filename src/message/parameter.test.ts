/**
 * MOQT Parameter Unit Tests
 * draft-ietf-moq-transport-23 Section 9.19 (Control Message Parameters)
 */

import { test, assert } from "vite-plus/test";
import {
  createTrackNamespace,
  decodeFillParameters,
  decodeLocationFilter,
  decodeLocationFilterParameter,
  decodeTrackNamespace,
  encodeFillParameters,
  encodeLocationFilter,
  encodeLocationFilterParameter,
  type LocationFilter,
  encodeParameters,
  decodeParameters,
  encodeKeyValuePairs,
  assertNoDuplicateMessageParameterTypes,
  isRepeatableMessageParameterType,
  decodeKeyValuePairs,
  decodeMessageParameter,
  decodeRangeFilter,
  encodeRangeFilter,
  validateRangeFilterCombination,
  validateFullTrackNameBytes,
  encodeUint8ParameterValue,
  encodeTrackName,
  encodeTrackNamespace,
  encodeParameterTrackNamespace,
  trackNamespaceToStrings,
  validateIncludePropertiesValue,
  MAX_TRACK_NAME_SIZE,
  MAX_TRACK_NAMESPACE_FIELDS,
  MAX_TRACK_NAMESPACE_SIZE,
  MAX_FULL_TRACK_NAME_SIZE,
  isRejectedReceiveNamespace,
  isSameLocationFilter,
  isNextObjectLocationFilter,
} from "./parameter";
import {
  IncompleteDataError,
  InvalidFilterError,
  ProtocolViolationError,
  SessionErrorCode,
} from "../error";
import { MessageParameterType } from "./types";
import { encodeVarint, MAX_VARINT } from "../varint";
import { captureThrownError, concatUint8Arrays } from "../testSupport/helpers";

test("無効なパラメータタイプでエラー", () => {
  const invalidParam = { type: 0x20, value: new Uint8Array([0x01]) };
  assert.throws(() => decodeLocationFilterParameter(invalidParam), "Invalid parameter type");
});

/**
 * Location Filter Type 0x00 (None) はフィルタなしを表し、reset として
 * round-trip する (REQUEST_UPDATE でのフィルタ除去のワイヤ)。
 */
test("decodeLocationFilter: Type 0x00 (None) は reset として round-trip する", () => {
  const encoded = encodeLocationFilter({ reset: true });
  assert.deepEqual(encoded, new Uint8Array([0x00]));
  const [filter, consumed] = decodeLocationFilter(encoded);
  assert.deepEqual(filter, { reset: true });
  assert.equal(consumed, encoded.length);
});

/**
 * Location Filter Type 0x05 (Next Object) はフィールドを持たず、Type のみで
 * round-trip する。v21 の「2 フィールド 0:0」という表現は廃止された。
 */
test("decodeLocationFilter: Type 0x05 (Next Object) が round-trip する", () => {
  const filter: LocationFilter = { nextObject: true };
  const encoded = encodeLocationFilter(filter);
  assert.deepEqual(encoded, new Uint8Array([0x05]));
  const [decoded, consumed] = decodeLocationFilter(encoded);
  assert.deepEqual(decoded, filter);
  assert.equal(consumed, encoded.length);
  assert.isTrue(isNextObjectLocationFilter(decoded));
  // reset (0x00) と絶対位置 {0, 0} (0x02) は Next Object ではない
  assert.isFalse(isNextObjectLocationFilter({ reset: true }));
  assert.isFalse(isNextObjectLocationFilter({ startGroup: 0n, startObject: 0n }));
});

/**
 * Location Filter Type 0x01 (Relative Start) は StartGroup を 1 つ持つ。
 */
test("decodeLocationFilter: 1 フィールド (StartGroup) が round-trip する", () => {
  const filter: LocationFilter = { startGroup: 3n };
  const encoded = encodeLocationFilter(filter);
  // Type 0x01 + StartGroup 3
  assert.deepEqual(encoded, new Uint8Array([0x01, 0x03]));
  const [decoded, consumed] = decodeLocationFilter(encoded);
  assert.deepEqual(decoded, filter);
  assert.equal(consumed, encoded.length);
});

/**
 * Location Filter Type 0x02 (Absolute Start) は StartGroup + StartObject を持つ。
 * 0:0 も絶対位置 {0, 0} の指定であり Next Object ではない (Type 0x05 が表す)。
 * フィールド数は Type が決めるため、バイト長からフィールド数を推論しない。
 */
test("decodeLocationFilter: 2 フィールド (StartGroup + StartObject) が round-trip する", () => {
  const filter: LocationFilter = { startGroup: 5n, startObject: 7n };
  const encoded = encodeLocationFilter(filter);
  assert.deepEqual(encoded, new Uint8Array([0x02, 0x05, 0x07]));
  const [decoded, consumed] = decodeLocationFilter(encoded);
  assert.deepEqual(decoded, filter);
  assert.equal(consumed, encoded.length);
});

/**
 * Location Filter Type 0x02 の 0:0 は絶対位置 {0, 0} としてデコードされ、
 * Next Object と判定されない (v21 の特例の廃止)。
 */
test("decodeLocationFilter: 2 フィールド 0:0 は絶対位置 {0, 0} になる", () => {
  const encoded = encodeLocationFilter({ startGroup: 0n, startObject: 0n });
  assert.deepEqual(encoded, new Uint8Array([0x02, 0x00, 0x00]));
  const [decoded] = decodeLocationFilter(encoded);
  assert.deepEqual(decoded, { startGroup: 0n, startObject: 0n });
  assert.isFalse(isNextObjectLocationFilter(decoded));
});

/**
 * Location Filter Type 0x03 (Absolute Start, Group End) が round-trip する。
 */
test("decodeLocationFilter: 3 フィールド (EndGroupDelta あり) が round-trip する", () => {
  const filter: LocationFilter = { startGroup: 5n, startObject: 7n, endGroupDelta: 3n };
  const encoded = encodeLocationFilter(filter);
  assert.deepEqual(encoded, new Uint8Array([0x03, 0x05, 0x07, 0x03]));
  const [decoded, consumed] = decodeLocationFilter(encoded);
  assert.deepEqual(decoded, filter);
  assert.equal(consumed, encoded.length);
});

/**
 * Location Filter Type 0x04 (Absolute Range) が round-trip する。
 */
test("decodeLocationFilter: 4 フィールド (EndObject あり) が round-trip する", () => {
  const filter: LocationFilter = {
    startGroup: 5n,
    startObject: 7n,
    endGroupDelta: 3n,
    endObject: 9n,
  };
  const encoded = encodeLocationFilter(filter);
  assert.deepEqual(encoded, new Uint8Array([0x04, 0x05, 0x07, 0x03, 0x09]));
  const [decoded, consumed] = decodeLocationFilter(encoded);
  assert.deepEqual(decoded, filter);
  assert.equal(consumed, encoded.length);
});

/**
 * 3/4 フィールドで End Group (StartGroup + EndGroupDelta) が 2^64-1 を超える
 * 受信データは draft-ietf-moq-transport-23 §9.19.9 の MUST
 * 「If StartGroup + EndGroupDelta exceeds 2^64 - 1, the endpoint MUST close
 *  the session with DELTA_ENCODING_OVERFLOW.」に従い ProtocolViolationError で
 * 拒否される。
 */
test("decodeLocationFilter: End Group が 2^64-1 を超えると DELTA_ENCODING_OVERFLOW", () => {
  // Type 0x03 + StartGroup=MAX_VARINT + StartObject=0 + EndGroupDelta=1
  // End Group = MAX_VARINT + 1 で 2^64-1 超過
  const fields = [...encodeVarint(MAX_VARINT), ...encodeVarint(0n), ...encodeVarint(1n)];
  const data = new Uint8Array([...encodeVarint(0x03n), ...fields]);
  const thrown = captureThrownError(() => decodeLocationFilter(data));
  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.DELTA_ENCODING_OVERFLOW);
});

/**
 * End Group がちょうど 2^64-1 の 3 フィールド表現は仕様上の有効値であり受理される。
 * 「2^64-1 を超える場合」のみ拒否する境界の向きを検証する。
 */
test("decodeLocationFilter: End Group がちょうど 2^64-1 は受理される", () => {
  // StartGroup=MAX_VARINT-5 + StartObject=7 + EndGroupDelta=5
  // End Group = MAX_VARINT-5+5 = 2^64-1 ちょうど
  const filter: LocationFilter = {
    startGroup: MAX_VARINT - 5n,
    startObject: 7n,
    endGroupDelta: 5n,
  };
  const encoded = encodeLocationFilter(filter);
  const [decoded, consumed] = decodeLocationFilter(encoded);
  assert.deepEqual(decoded, filter);
  assert.equal(consumed, encoded.length);
});

/**
 * End Group Delta が単体で varint 域の最大値 (2^64-1。9 バイト表現) で
 * Start Group が 0 の場合、和はちょうど 2^64-1 であり受理される。
 * delta 側から和の境界 (ちょうど 2^64-1 は有効) を検証する。
 */
test("decodeLocationFilter: End Group Delta 単体が最大値でも Group が 0 なら受理される", () => {
  const filter: LocationFilter = {
    startGroup: 0n,
    startObject: 0n,
    endGroupDelta: MAX_VARINT,
  };
  const encoded = encodeLocationFilter(filter);
  const [decoded] = decodeLocationFilter(encoded);
  assert.deepEqual(decoded, filter);
});

/**
 * End Group Delta が単体で最大値でも Group が 1 以上の場合は和が 2^64-1 を
 * 超えるため ProtocolViolationError で拒否される。超過判定が delta 単体で
 * なく和であること (「End Group Delta だけを見る」実装誤りへのガード) を検証する。
 */
test("decodeLocationFilter: Group が 1 以上で End Group Delta が単体最大なら DELTA_ENCODING_OVERFLOW", () => {
  // Type 0x03 + StartGroup=1 + StartObject=0 + EndGroupDelta=MAX_VARINT
  // End Group = 1 + MAX_VARINT で 2^64-1 超過
  const fields = [...encodeVarint(1n), ...encodeVarint(0n), ...encodeVarint(MAX_VARINT)];
  const data = new Uint8Array([...encodeVarint(0x03n), ...fields]);
  const thrown = captureThrownError(() => decodeLocationFilter(data));
  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.DELTA_ENCODING_OVERFLOW);
});

/**
 * 送信側でも同一規則を適用する。End Group が 2^64-1 を超える 3/4 フィールド
 * 表現は受信した endpoint を DELTA_ENCODING_OVERFLOW でセッション終了させるため、
 * encodeLocationFilter が InvalidFilterError で送信前に throw する (§9.19.9)。
 */
test("encodeLocationFilter: End Group が 2^64-1 を超えると InvalidFilterError", () => {
  // End Group = MAX_VARINT + 1 で 2^64-1 超過
  const filter: LocationFilter = {
    startGroup: MAX_VARINT,
    startObject: 0n,
    endGroupDelta: 1n,
  };
  assert.throws(() => encodeLocationFilter(filter), InvalidFilterError);
});

/**
 * LOCATION_FILTER パラメータとしてのエンコード経路
 * (encodeLocationFilterParameter) でも同一の送信前検証が効くことを検証する。
 */
test("encodeLocationFilterParameter: End Group が 2^64-1 を超えると InvalidFilterError", () => {
  // End Group = MAX_VARINT + 1 で 2^64-1 超過
  const filter: LocationFilter = {
    startGroup: MAX_VARINT - 1n,
    startObject: 0n,
    endGroupDelta: 2n,
  };
  assert.throws(() => encodeLocationFilterParameter(filter), InvalidFilterError);
});

/**
 * draft-ietf-moq-transport-23 §9.19.9:
 * "If an endpoint receives any other Location Filter Type, it MUST close the
 *  session with INVALID_PARAMETER."
 * 0x00〜0x05 以外の Type は INVALID_PARAMETER で拒否される。
 * Type は vi64 のため、大きな値も同じ扱いになる。
 */
test("decodeLocationFilter: 未知の Location Filter Type は INVALID_PARAMETER", () => {
  // Type 0x06 (未定義) のみ
  const single = captureThrownError(() => decodeLocationFilter(new Uint8Array([0x06])));
  assert.instanceOf(single, ProtocolViolationError);
  assert.equal((single as ProtocolViolationError).code, SessionErrorCode.INVALID_PARAMETER);
  // Type 0x06 + 余分なフィールド (Type 判定が先に効く)
  const withFields = captureThrownError(() =>
    decodeLocationFilter(new Uint8Array([0x06, 0x00, 0x00])),
  );
  assert.instanceOf(withFields, ProtocolViolationError);
  assert.equal((withFields as ProtocolViolationError).code, SessionErrorCode.INVALID_PARAMETER);
  // 大きな Type (vi64 の 2 バイト表現 = 0x100)
  const large = captureThrownError(() =>
    decodeLocationFilter(new Uint8Array(encodeVarint(0x100n))),
  );
  assert.instanceOf(large, ProtocolViolationError);
  assert.equal((large as ProtocolViolationError).code, SessionErrorCode.INVALID_PARAMETER);
});

/**
 * Type が定めるフィールド数に足りないワイヤ (次のチャンク待ち) は
 * 不完全データとして IncompleteDataError になる。
 * 例: Type 0x02 は StartGroup + StartObject を要求するが StartGroup しか無い。
 */
test("decodeLocationFilter: フィールドが data 末尾で切れると IncompleteDataError", () => {
  // Type 0x02 + StartGroup のみ (StartObject が無い)
  const data = new Uint8Array([0x02, 0x03]);
  assert.throws(() => decodeLocationFilter(data), IncompleteDataError);
});

/**
 * フィールドの vi64 が data 末尾で切れるケースも同様に IncompleteDataError で
 * 「次のチャンクを待つ」意味論を保つ (Type の読み取りは成功している)。
 */
test("decodeLocationFilter: フィールドの vi64 が data 末尾で切れると IncompleteDataError", () => {
  // Type 0x01 + 2 バイト必要な varint (0x80) が data 末尾で切れる
  const data = new Uint8Array([0x01, 0x80]);
  assert.throws(() => decodeLocationFilter(data), IncompleteDataError);
});

/**
 * draft-ietf-moq-transport-23 §9.19.9: LOCATION_FILTER のワイヤは
 * [Type Delta=0x21][Location Filter Type][fields...] であり Length フィールドを
 * 持たない。値の長さは Type とフィールド数で決まる。外側 Length を付加して
 * いないことをパラメータ全体のバイト列で固定する。
 */
test("LOCATION_FILTER パラメータはワイヤ上 Length 無しで round-trip する", () => {
  const params = [encodeLocationFilterParameter({ startGroup: 3n })];
  const encoded = encodeParameters(params);
  // count=1, Type Delta=0x21, Location Filter Type=0x01 (Relative Start), StartGroup=3
  assert.deepEqual(encoded, new Uint8Array([1, 0x21, 0x01, 0x03]));
  const [decoded, consumed] = decodeParameters(encoded);
  assert.equal(consumed, encoded.length);
  assert.equal(decoded.length, 1);
  assert.deepEqual(decodeLocationFilterParameter(decoded[0]), { startGroup: 3n });
});

/**
 * Next Object も同様に [Type Delta=0x21][Location Filter Type=0x05] の 2 バイトで
 * ワイヤ化される (フィールドを持たない)。
 */
test("LOCATION_FILTER の Next Object はワイヤ上 Type 0x05 のみで round-trip する", () => {
  const params = [encodeLocationFilterParameter({ nextObject: true })];
  const encoded = encodeParameters(params);
  // count=1, Type Delta=0x21, Location Filter Type=0x05 (Next Object)
  assert.deepEqual(encoded, new Uint8Array([1, 0x21, 0x05]));
  const [decoded, consumed] = decodeParameters(encoded);
  assert.equal(consumed, encoded.length);
  assert.equal(decoded.length, 1);
  assert.deepEqual(decodeLocationFilterParameter(decoded[0]), { nextObject: true });
});

/**
 * reset (Type 0x00 = None) も同様に [Type Delta=0x21][Location Filter Type=0x00] で
 * ワイヤ化される (REQUEST_UPDATE でのフィルタ除去のワイヤ)。
 */
test("LOCATION_FILTER reset はワイヤ上 Type 0x00 で round-trip する", () => {
  const params = [encodeLocationFilterParameter({ reset: true })];
  const encoded = encodeParameters(params);
  // count=1, Type Delta=0x21, Location Filter Type=0x00 (None)
  assert.deepEqual(encoded, new Uint8Array([1, 0x21, 0x00]));
  const [decoded, consumed] = decodeParameters(encoded);
  assert.equal(consumed, encoded.length);
  assert.equal(decoded.length, 1);
  assert.deepEqual(decodeLocationFilterParameter(decoded[0]), { reset: true });
});

/**
 * draft-ietf-moq-transport-23 §9.19.9: 先頭の vi64 は Location Filter Type であり、
 * v21 の Length (フィールド総バイト数) ではない。単一バイト varint のフィルタでは
 * 両形式のバイト列が一致するため、多バイト値で形式の違いを固定する。
 * 例: { startGroup: 1000n } (vi64 は 2 バイト) は v22 では [Type 0x01][1000]、
 * v21 なら [Length 2][1000] になる。
 */
test("LOCATION_FILTER の先頭 vi64 は Length ではなく Location Filter Type である", () => {
  const encoded = encodeLocationFilter({ startGroup: 1000n });
  assert.deepEqual(encoded, new Uint8Array([0x01, 0x83, 0xe8]));
  const [decoded, consumed] = decodeLocationFilter(encoded);
  assert.deepEqual(decoded, { startGroup: 1000n });
  assert.equal(consumed, encoded.length);

  // v21 の Length 前置き形式のバイト列は v22 のデコーダでは Type 0x02 (Absolute
  // Start) として読まれ、StartObject が無いため不完全データになる
  assert.throws(
    () => decodeLocationFilter(new Uint8Array([0x02, 0x83, 0xe8])),
    IncompleteDataError,
  );
});

/**
 * value 長 (param.value.length) に対して Location Filter 構造の消費バイト数が
 * 短い (末尾残余バイトあり) 場合は構造不正として ProtocolViolationError で拒否する。
 * draft-ietf-moq-transport-23 §9.19.9 の LOCATION_FILTER は Length を持たず、
 * 残余バイトは仕様上現れない。制御メッセージの Body 長と消費バイト数の不一致検出と
 * 同方針の堅牢性検証である (decodeFillParameters の内側検証と同形)。
 */
test("decodeLocationFilterParameter: 末尾残余バイトありは MALFORMED_MESSAGE", () => {
  const param = encodeLocationFilterParameter({ startGroup: 3n, startObject: 4n });
  // 正常エンコードに残余 1 バイトを付加する
  const trailing = new Uint8Array(param.value.length + 1);
  trailing.set(param.value, 0);
  trailing[param.value.length] = 0x00;
  const thrown = captureThrownError(() =>
    decodeLocationFilterParameter({ type: 0x21, value: trailing }),
  );
  assert.instanceOf(thrown, ProtocolViolationError);
  // Value 長と消費バイト数の不一致は構造不正として MALFORMED_MESSAGE
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.MALFORMED_MESSAGE);
  assert.match((thrown as ProtocolViolationError).message, /declared length does not match filter/);
});

/**
 * reset (Type 0x00 = None) に残余バイトが付いた場合も同様に拒否する。
 */
test("decodeLocationFilterParameter: reset の末尾残余バイトありは MALFORMED_MESSAGE", () => {
  const param = encodeLocationFilterParameter({ reset: true });
  const trailing = new Uint8Array(param.value.length + 1);
  trailing.set(param.value, 0);
  trailing[param.value.length] = 0x00;
  const thrown = captureThrownError(() =>
    decodeLocationFilterParameter({ type: 0x21, value: trailing }),
  );
  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.MALFORMED_MESSAGE);
  assert.match((thrown as ProtocolViolationError).message, /declared length does not match filter/);
});

/**
 * ちょうど一致する通常ケースは従来どおり受理される (回帰ガード)。
 */
test("decodeLocationFilterParameter: value 長と一致する場合は受理される", () => {
  const param = encodeLocationFilterParameter({ startGroup: 3n, startObject: 4n });
  assert.deepEqual(decodeLocationFilterParameter(param), { startGroup: 3n, startObject: 4n });
});

/**
 * Type が定めるフィールド数に対して value が短い (truncated) 場合は、
 * IncompleteDataError のまま伝搬し、ProtocolViolationError には変換しない。
 * 受信経路では外側の変換規則で MALFORMED_MESSAGE になる。
 */
test("decodeLocationFilterParameter: 短い value は IncompleteDataError のまま", () => {
  // Location Filter Type 0x02 (Absolute Start) だが StartGroup しか無い
  assert.throws(
    () => decodeLocationFilterParameter({ type: 0x21, value: new Uint8Array([0x02, 0x00]) }),
    IncompleteDataError,
  );
});

/**
 * delta encoding のテスト
 * draft-ietf-moq-transport-23 Section 8.3 (Key-Value-Pair Structure):
 * https://www.ietf.org/archive/id/draft-ietf-moq-transport-23.html#section-8.3
 * Key-Value-Pairs encode a Type value as a delta from the previous Type value,
 * or from 0 if there is no previous Type value.
 */
test("Parameters の delta encoding が正しくエンコードされる", () => {
  // type が [0x02, 0x04, 0x08] のパラメータリスト (全て varint 型)
  // delta type は [2, 2, 4] になるはず
  const params = [
    { type: 0x02, value: encodeVarint(100n) },
    { type: 0x04, value: encodeVarint(200n) },
    { type: 0x08, value: encodeVarint(300n) },
  ];

  const encoded = encodeParameters(params);

  // count = 3 (1 byte), 続いて各パラメータ
  // 先頭バイトは count = 3
  assert.equal(encoded[0], 3);

  // 最初のパラメータ: delta = 2 (0 から 0x02)
  // delta = 2, value = 100
  assert.equal(encoded[1], 2);

  // 詳細なバイト位置は varint エンコーディングに依存するので、
  // ラウンドトリップで検証
  const [decoded, consumed] = decodeParameters(encoded);
  assert.equal(decoded.length, 3);
  assert.equal(decoded[0].type, 0x02);
  assert.equal(decoded[1].type, 0x04);
  assert.equal(decoded[2].type, 0x08);
  assert.equal(consumed, encoded.length);
});

test("Parameters の delta encoding で type が昇順でない場合もソートされる", () => {
  // encodeParameters は内部でソートするため、降順でもエラーにならない
  const params = [
    { type: 0x08, value: encodeVarint(100n) },
    { type: 0x02, value: encodeVarint(200n) },
  ];

  const encoded = encodeParameters(params);
  const [decoded, consumed] = decodeParameters(encoded);

  // ソートされて type 昇順になる
  assert.equal(decoded.length, 2);
  assert.equal(decoded[0].type, 0x02);
  assert.equal(decoded[1].type, 0x08);
  assert.equal(consumed, encoded.length);
});

/**
 * draft-ietf-moq-transport-23 §9.19 (Control Message Parameters):
 * "Senders MUST NOT repeat the same Parameter Type in a message unless the
 *  parameter definition explicitly allows multiple instances of that type to be
 *  sent in a single message."
 * 同一 Type の重複はエンコード時にローカルの Error で拒否する
 * (受信側の INVALID_PARAMETER と区別する)。
 */
test("encodeParameters: 同一 Parameter Type の重複は Error になる", () => {
  // PAUSED (0x11) は反復を許可されない型
  const params = [
    { type: 0x11, value: new Uint8Array([0x01]) },
    { type: 0x11, value: new Uint8Array([0x00]) },
  ];

  let thrown: unknown;
  try {
    encodeParameters(params);
  } catch (error) {
    thrown = error;
  }
  assert.instanceOf(thrown, Error);
  assert.isTrue((thrown as Error).message.includes("duplicate message parameter type: 0x11"));
});

/**
 * 反復が許可される型 (AUTHORIZATION_TOKEN 0x03 / Range Filter 0x25-0x29) は
 * 同一メッセージ内に複数回出現できる (§9.19 / §3.3.2)。
 */
test("encodeParameters: 反復可能な型の重複は許可される", () => {
  const subgroupFilter = encodeRangeFilter({
    type: "subgroup",
    setId: 1,
    ranges: [{ start: 0n, end: 10n }],
  });
  const objectIdFilter = encodeRangeFilter({
    type: "objectId",
    setId: 1,
    ranges: [{ start: 20n, end: 30n }],
  });
  const params = [
    { type: 0x03, value: new Uint8Array([0x01, 0x02]) },
    { type: 0x03, value: new Uint8Array([0x03, 0x04]) },
    { type: 0x25, value: subgroupFilter },
    { type: 0x25, value: objectIdFilter },
  ];

  const encoded = encodeParameters(params);
  const [decoded, consumed] = decodeParameters(encoded);
  assert.equal(decoded.length, 4);
  assert.equal(consumed, encoded.length);
});

/**
 * 反復可否の判定は送信側 (encodeParameters) と受信側 (decodeParameters) で
 * 共通の isRepeatableMessageParameterType を使う。
 */
test("isRepeatableMessageParameterType: 0x03 と 0x25-0x29 のみ反復可能", () => {
  for (const type of [0x03, 0x25, 0x26, 0x27, 0x28, 0x29]) {
    assert.isTrue(isRepeatableMessageParameterType(type));
    // 反復可能な型は重複しても throw しない
    assertNoDuplicateMessageParameterTypes([{ type }, { type }]);
  }
  for (const type of [0x11, 0x20, 0x24, 0x2a]) {
    assert.isFalse(isRepeatableMessageParameterType(type));
    let thrown: unknown;
    try {
      assertNoDuplicateMessageParameterTypes([{ type }, { type }]);
    } catch (error) {
      thrown = error;
    }
    assert.instanceOf(thrown, Error);
    assert.isTrue(
      (thrown as Error).message.includes(
        `duplicate message parameter type: 0x${type.toString(16)}`,
      ),
    );
  }
});

test("空の Parameters リストのエンコード・デコード", () => {
  const params: { type: number; value: Uint8Array }[] = [];
  const encoded = encodeParameters(params);
  const [decoded, consumed] = decodeParameters(encoded);

  assert.equal(decoded.length, 0);
  assert.equal(consumed, encoded.length);
});

test("uint8 Message Parameter Value を 1 バイトでエンコードする", () => {
  const params = [
    // PAUSED は 0x11 (draft-23 で FORWARD 0x10 を置き換えた型)
    { type: 0x11, value: encodeUint8ParameterValue(1, "PAUSED") },
    { type: 0x20, value: encodeUint8ParameterValue(255, "SUBSCRIBER_PRIORITY") },
    { type: 0x22, value: encodeUint8ParameterValue(2, "GROUP_ORDER") },
  ];

  const encoded = encodeParameters(params);

  // count 3 / PAUSED delta 0x11 + 値 1 / SUBSCRIBER_PRIORITY delta 0x0F + 255 /
  // GROUP_ORDER delta 0x02 + 2
  assert.deepEqual([...encoded], [3, 0x11, 1, 0x0f, 255, 0x02, 2]);
});

test("uint8 Message Parameter Value は範囲外を拒否する", () => {
  assert.throws(
    () => encodeUint8ParameterValue(256, "SUBSCRIBER_PRIORITY"),
    /invalid SUBSCRIBER_PRIORITY value: 256, expected 0\.\.255/,
  );
});

/**
 * draft-ietf-moq-transport-23 §9.19.18:
 * PAUSED は uint8 で 0 = unpaused / 1 = paused。固定ワイヤで往復し、
 * 送受信で値が反転しないこと (二重反転しないこと) を検証する。
 */
test("PAUSED パラメータ: 0 / 1 がワイヤ上そのままで round-trip する", () => {
  for (const value of [0, 1]) {
    const encoded = encodeParameters([
      {
        type: MessageParameterType.PAUSED,
        value: encodeUint8ParameterValue(value, "PAUSED"),
      },
    ]);

    // count 1 / Type Delta 0x11 / 値 (0 = unpaused、1 = paused)
    assert.deepEqual(encoded, new Uint8Array([0x01, 0x11, value]));

    const [decoded, consumed] = decodeParameters(encoded);
    assert.equal(consumed, encoded.length);
    assert.equal(decoded.length, 1);
    assert.equal(decoded[0].type, MessageParameterType.PAUSED);
    assert.deepEqual(decoded[0].value, new Uint8Array([value]));

    // 復号結果をそのまま再エンコードしても同じワイヤになる (値の反転を再度適用しない)
    assert.deepEqual(encodeParameters(decoded), encoded);
  }
});

/**
 * draft-ietf-moq-transport-23 §9.19.18:
 * 値域は 0 / 1 のみで、範囲外を受信すると ProtocolViolationError になる
 * (現行の受信経路はセッション終了コードへ変換する)。
 */
test("PAUSED パラメータ: 値域外 (2-255) は INVALID_PARAMETER", () => {
  for (const value of [2, 128, 255]) {
    const wire = new Uint8Array([0x01, 0x11, value]);
    const thrown = captureThrownError(() => decodeParameters(wire));
    assert.instanceOf(thrown, ProtocolViolationError);
    // §9.19.18 の MUST により INVALID_PARAMETER で閉じる
    assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.INVALID_PARAMETER);
    assert.match((thrown as ProtocolViolationError).message, /invalid PAUSED value/);
  }
});

/**
 * Track Namespace / Full Track Name のサイズ制限テスト
 * draft-ietf-moq-transport-23:
 * Track Namespace と Full Track Name は最大 4,096 バイト。
 * draft-ietf-moq-transport-23 Section 8.7 (Track Namespace Structure)
 */
test("Track Namespace のサイズ制限定数が 4,096", () => {
  assert.equal(MAX_TRACK_NAMESPACE_SIZE, 4096);
});

test("Track Name のサイズ制限定数が 4,096", () => {
  assert.equal(MAX_TRACK_NAME_SIZE, 4096);
});

test("createTrackNamespace で制限を超えるとエラー", () => {
  // 各要素が 2,000 バイトで、3 要素 = 6,000 バイト > 4,096
  const largePart = "a".repeat(2000);
  assert.throws(
    () => createTrackNamespace([largePart, largePart, largePart]),
    /track namespace exceeds maximum size/,
  );
});

test("createTrackNamespace で制限内なら成功", () => {
  // 各要素が 1,000 バイトで、4 要素 = 4,000 バイト < 4,096
  const mediumPart = "a".repeat(1000);
  const ns = createTrackNamespace([mediumPart, mediumPart, mediumPart, mediumPart]);
  assert.equal(ns.tuple.length, 4);
});

/**
 * draft-ietf-moq-transport-23 §8.7 / §2.4.1:
 * Track Namespace は 0〜32 フィールド。33 フィールド以上は送信側で拒否する。
 */
test("createTrackNamespace: 32 フィールドは成功し 33 フィールドはエラー", () => {
  const fields32 = Array.from({ length: MAX_TRACK_NAMESPACE_FIELDS }, (_, i) => `f${i}`);
  const fields33 = Array.from({ length: MAX_TRACK_NAMESPACE_FIELDS + 1 }, (_, i) => `f${i}`);
  const ns = createTrackNamespace(fields32);
  assert.equal(ns.tuple.length, MAX_TRACK_NAMESPACE_FIELDS);
  assert.throws(
    () => createTrackNamespace(fields33),
    /track namespace fields exceeds maximum: 33 > 32/,
  );
});

/**
 * draft-ietf-moq-transport-23 §8.7 (Track Namespace Structure):
 * 送信側も受信側と同じ制約 (フィールド数 32 以下 / 各フィールド 1 バイト以上 /
 * 合計 4,096 バイト以下) を守る。`createTrackNamespace` と `encodeTrackNamespace` は
 * 共通の `assertTrackNamespaceTuple` を使う。
 */
test("encodeTrackNamespace: フィールド長 0 のフィールドはエラー", () => {
  assert.throws(
    () => encodeTrackNamespace({ tuple: [new Uint8Array(0)] }),
    /track namespace field length is zero/,
  );
  assert.throws(
    () => encodeTrackNamespace({ tuple: [new Uint8Array([1]), new Uint8Array(0)] }),
    /track namespace field length is zero/,
  );
});

test("encodeTrackNamespace: 33 フィールドはエラー", () => {
  const tuple = Array.from({ length: 33 }, () => new Uint8Array([1]));
  assert.throws(
    () => encodeTrackNamespace({ tuple }),
    /track namespace fields exceeds maximum: 33 > 32/,
  );
});

test("createTrackNamespace: 空フィールドはエラー", () => {
  assert.throws(() => createTrackNamespace([""]), /track namespace field length is zero/);
});

test("encodeTrackNamespace: 0 フィールドと 32 フィールドはエンコードできる", () => {
  // 0 フィールドは §2.4.1 の "between 0 and 32 Track Namespace Fields" により正当
  const empty = encodeTrackNamespace({ tuple: [] });
  const [decodedEmpty] = decodeTrackNamespace(empty);
  assert.equal(decodedEmpty.tuple.length, 0);

  // 32 フィールドは上限内
  const tuple = Array.from({ length: 32 }, () => new Uint8Array([1]));
  const encoded = encodeTrackNamespace({ tuple });
  const [decoded] = decodeTrackNamespace(encoded);
  assert.equal(decoded.tuple.length, 32);
});

test("encodeTrackNamespace で制限を超えるとエラー", () => {
  // 直接 Uint8Array で 5,000 バイトの要素を作成
  const largeElement = new Uint8Array(5000);
  assert.throws(
    () => encodeTrackNamespace({ tuple: [largeElement] }),
    /track namespace exceeds maximum size/,
  );
});

test("decodeTrackNamespace で制限を超えるとエラー", () => {
  // 要素数 1、長さ 5,000 のデータを作成
  const countBytes = encodeVarint(1n);
  const lengthBytes = encodeVarint(5000n);
  const dataBytes = new Uint8Array(5000);

  const encoded = new Uint8Array(countBytes.length + lengthBytes.length + dataBytes.length);
  encoded.set(countBytes, 0);
  encoded.set(lengthBytes, countBytes.length);
  encoded.set(dataBytes, countBytes.length + lengthBytes.length);

  assert.throws(() => decodeTrackNamespace(encoded), /track namespace exceeds maximum size/);
});

test("decodeTrackNamespace で Field Length=0 のフィールドはエラー", () => {
  // draft-ietf-moq-transport-23 §2.3:
  // "Each Track Namespace Field Value MUST contain at least one byte."
  // 要素数 1、長さ 0 のデータを作成
  const countBytes = encodeVarint(1n);
  const lengthBytes = encodeVarint(0n);

  const encoded = new Uint8Array(countBytes.length + lengthBytes.length);
  encoded.set(countBytes, 0);
  encoded.set(lengthBytes, countBytes.length);

  assert.throws(() => decodeTrackNamespace(encoded), /track namespace field length is zero/);
});

test("decodeTrackNamespace で複数フィールドの 1 つでも長さ 0 ならエラー", () => {
  // 要素数 2、最初のフィールドは "a"、2 つ目が長さ 0
  const countBytes = encodeVarint(2n);
  const firstLenBytes = encodeVarint(1n);
  const firstDataBytes = new Uint8Array([0x61]); // "a"
  const secondLenBytes = encodeVarint(0n);

  const totalLength =
    countBytes.length + firstLenBytes.length + firstDataBytes.length + secondLenBytes.length;
  const encoded = new Uint8Array(totalLength);
  let pos = 0;
  encoded.set(countBytes, pos);
  pos += countBytes.length;
  encoded.set(firstLenBytes, pos);
  pos += firstLenBytes.length;
  encoded.set(firstDataBytes, pos);
  pos += firstDataBytes.length;
  encoded.set(secondLenBytes, pos);

  assert.throws(() => decodeTrackNamespace(encoded), /track namespace field length is zero/);
});

test("encodeTrackName で制限を超えるとエラー", () => {
  const largeName = "a".repeat(5000);
  assert.throws(() => encodeTrackName(largeName), /track name exceeds maximum size/);
});

test("encodeTrackName で制限内なら成功", () => {
  const normalName = "a".repeat(4000);
  const bytes = encodeTrackName(normalName);
  assert.equal(bytes.length, 4000);
});

/**
 * draft-ietf-moq-transport-23 §8.7:
 * 「The length of a Full Track Name is computed as the sum of the Track
 *  Namespace Field Length fields and the Track Name Length field.」
 * Full Track Name の合計が 4,096 バイトを超えると ProtocolViolationError に
 * なることを検証する。
 * namespace 単体は 4,096 未満に収め、Track Name を足して合計 4,097 にする
 * (namespace 単体が 4,096 超のケースは decodeTrackNamespace の既存検証が先に
 * throw するため)。
 */
test("validateFullTrackNameBytes: 合計 4,097 バイトで FIELD_LENGTH_EXCEEDED", () => {
  const namespace = createTrackNamespace(["a".repeat(4000)]);
  const trackName = new TextEncoder().encode("a".repeat(97));

  const thrown = captureThrownError(() => validateFullTrackNameBytes(namespace, trackName));
  assert.instanceOf(thrown, ProtocolViolationError);
  // §8.7 の Full Track Name 上限超過は FIELD_LENGTH_EXCEEDED
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.FIELD_LENGTH_EXCEEDED);
  assert.match(
    (thrown as ProtocolViolationError).message,
    /full track name exceeds maximum size: 4097 > 4096/,
  );
});

/**
 * draft-ietf-moq-transport-23 §8.7:
 * Full Track Name の合計が 4,096 バイトちょうどは違反にならないことを検証する。
 */
test("validateFullTrackNameBytes: 合計 4,096 バイトちょうどは違反にならない", () => {
  const namespace = createTrackNamespace(["a".repeat(4000)]);
  const trackName = new TextEncoder().encode("a".repeat(96));

  validateFullTrackNameBytes(namespace, trackName);
});

/**
 * draft-ietf-moq-transport-23 §8.7:
 * 不正な UTF-8 バイト列を含む Track Name は、TextDecoder の置換 (U+FFFD) による
 * 水増しではなくワイヤバイト長で正確に計測されることを検証する。
 * 0xFF は単独では不正な UTF-8 であり、TextDecoder は U+FFFD (3 バイト) に置換する。
 *
 * 差別化点は後半の 4,096 バイト配列: string 版 (validateFullTrackName) では
 * 0xFF が U+FFFD (3 バイト) に置換され 4,098 バイトと誤計測されて throw するが、
 * バイト版は 4,096 バイトのまま計測して通過する。
 */
test("validateFullTrackNameBytes: 不正 UTF-8 バイト列がバイト長で計測される", () => {
  const namespace = createTrackNamespace([]);
  // 0xFF 1 バイト + 0x80 1 バイト = 2 バイトの不正 UTF-8
  const trackName = new Uint8Array([0xff, 0x80]);

  // 2 バイトとして計測されるため違反にならない
  validateFullTrackNameBytes(namespace, trackName);

  // 4,096 バイトのうち先頭 1 バイトを不正 UTF-8 (0xFF) にしても、
  // バイト長 4,096 のまま計測されるため違反にならない
  // (string 版なら U+FFFD 置換で 4,098 バイトと誤計測され throw する)
  const largeTrackName = new Uint8Array(MAX_FULL_TRACK_NAME_SIZE);
  largeTrackName[0] = 0xff;
  validateFullTrackNameBytes(namespace, largeTrackName);
});

/**
 * 未知 Message Parameter 受信時の INVALID_PARAMETER テスト
 * draft-ietf-moq-transport-23 §9.19:
 * "An endpoint that receives an unknown Message Parameter MUST close
 *  the session with INVALID_PARAMETER."
 */
test("未知のパラメータタイプで INVALID_PARAMETER", () => {
  // type = 0xFE (未知), value = 0x01 (varint)
  const countBytes = encodeVarint(1n);
  const deltaTypeBytes = encodeVarint(0xfen);
  const valueBytes = encodeVarint(1n);
  const data = new Uint8Array(countBytes.length + deltaTypeBytes.length + valueBytes.length);
  data.set(countBytes, 0);
  data.set(deltaTypeBytes, countBytes.length);
  data.set(valueBytes, countBytes.length + deltaTypeBytes.length);

  const thrown = captureThrownError(() => decodeParameters(data));
  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.INVALID_PARAMETER);
  assert.match((thrown as ProtocolViolationError).message, /unknown message parameter type/);
});

/**
 * 重複 Message Parameter 検出の SHOULD テスト
 * draft-ietf-moq-transport-23 §9.19:
 * "Receivers SHOULD check that there are no unexpected duplicate parameters
 *  and close the session with INVALID_PARAMETER if found."
 */
test("重複パラメータで INVALID_PARAMETER", () => {
  // type = 0x02 を 2 回含むデータ
  const countBytes = encodeVarint(2n);
  const firstDeltaBytes = encodeVarint(0x02n);
  const firstValueBytes = encodeVarint(100n);
  const secondDeltaBytes = encodeVarint(0x00n); // delta = 0 (前回と同じ type)
  const secondValueBytes = encodeVarint(200n);

  const data = new Uint8Array(
    countBytes.length +
      firstDeltaBytes.length +
      firstValueBytes.length +
      secondDeltaBytes.length +
      secondValueBytes.length,
  );
  let pos = 0;
  data.set(countBytes, pos);
  pos += countBytes.length;
  data.set(firstDeltaBytes, pos);
  pos += firstDeltaBytes.length;
  data.set(firstValueBytes, pos);
  pos += firstValueBytes.length;
  data.set(secondDeltaBytes, pos);
  pos += secondDeltaBytes.length;
  data.set(secondValueBytes, pos);

  const thrown = captureThrownError(() => decodeParameters(data));
  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.INVALID_PARAMETER);
  assert.match((thrown as ProtocolViolationError).message, /duplicate message parameter type/);
});

/**
 * draft-ietf-moq-transport-23 §8.3:
 * "The previous Type value plus the Delta Type MUST NOT be greater than
 *  2^64 - 1. If a Delta Type is received that would be too large, the
 *  Session MUST be closed with DELTA_ENCODING_OVERFLOW."
 * 加算結果が 2^64-1 ちょうど (deltaType 単体が 2^64-1、previousType=0) は
 * 違反にならないことを検証する。
 * 2^64-1 は奇数型のため length-prefixed 形式で、length (0) + 空バイト列を付加する。
 */
test("decodeKeyValuePairs: deltaType 単体が 2^64-1 は違反にならない", () => {
  const data = new Uint8Array([...encodeVarint(MAX_VARINT), ...encodeVarint(0n)]);
  const [parameters] = decodeKeyValuePairs(data);

  assert.equal(parameters.length, 1);
  assert.equal(parameters[0].type, Number(MAX_VARINT));
  assert.deepEqual(parameters[0].value, new Uint8Array());
});

/**
 * draft-ietf-moq-transport-23 §8.3:
 * 加算結果が 2^64-1 を超える (previousType=2^64-1 + deltaType=1) 場合は
 * DELTA_ENCODING_OVERFLOW の ProtocolViolationError になることを検証する。
 */
test("decodeKeyValuePairs: 加算結果が 2^64-1 を超えると DELTA_ENCODING_OVERFLOW", () => {
  // 1 個目: deltaType = 2^64-1 (奇数型)、length (0) + 空バイト列
  // 2 個目: deltaType = 1 → previousType + 1 = 2^64 > 2^64-1
  const data = new Uint8Array([
    ...encodeVarint(MAX_VARINT),
    ...encodeVarint(0n),
    ...encodeVarint(1n),
  ]);

  const thrown = captureThrownError(() => decodeKeyValuePairs(data));
  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.DELTA_ENCODING_OVERFLOW);
});

/**
 * draft-ietf-moq-transport-23 Section 8.3:
 * Message Parameter の deltaType 加算でも 2^64-1 超過は DELTA_ENCODING_OVERFLOW
 * の ProtocolViolationError になることを検証する。
 * decodeParameters は Number of Parameters プレフィックス付きのため、
 * 先頭にパラメータ数を付加する。
 * 2 個目の deltaType を 2^64-1 とし、1 個目の type (0x02) との加算結果を
 * 2^64 にすることで超過を直接検証する。
 */
test("decodeParameters: deltaType 加算結果が 2^64-1 を超えると DELTA_ENCODING_OVERFLOW", () => {
  // 1 個目: deltaType = 0x02 (OBJECT_DELIVERY_TIMEOUT、varint 型) + value
  // 2 個目: deltaType = 2^64-1 → 0x02 + 2^64-1 = 2^64+1 > 2^64-1
  const data = new Uint8Array([
    ...encodeVarint(2n),
    ...encodeVarint(0x02n),
    ...encodeVarint(100n),
    ...encodeVarint(MAX_VARINT),
  ]);

  // 加算検証のエラーパスを特定して検証する。
  // 仮に加算検証を除去しても 2^64+1 は未知型として同じクラスの
  // ProtocolViolationError が投げられるため、メッセージで加算パスを特定する
  const thrown = captureThrownError(() => decodeParameters(data));
  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.DELTA_ENCODING_OVERFLOW);
  assert.match((thrown as ProtocolViolationError).message, /delta type addition exceeds maximum/);
});

/**
 * draft-ietf-moq-transport-23 Section 8.6 (Range Filter Structure):
 * Range Filter パラメータは「Type Delta + Length + SetID + [Property Type] + Range 列」の
 * 1 Length 構造である。encodeMessageParameter が外側に Length を二重に付加しないことを
 * 固定バイト列で検証する。
 * 例: 0x25 0x03 0x01 0x03 0x02 = Type Delta 0x25 / Length 3 / SetID 1 /
 *     Start delta 3 / End delta 2 (Range {3, 5})
 */
test("encodeParameters: Range Filter は 1 Length 構造でエンコードされる", () => {
  // SUBGROUP_FILTER (0x25) + Length 3 + SetID 1 + Start delta 3 + End delta 2
  const param = { type: 0x25, value: new Uint8Array([0x03, 0x01, 0x03, 0x02]) };
  const encoded = encodeParameters([param]);

  // Number of Parameters (1) + Type Delta (0x25) + 上記バイト列
  assert.deepEqual(encoded, new Uint8Array([0x01, 0x25, 0x03, 0x01, 0x03, 0x02]));
});

/**
 * draft-ietf-moq-transport-23 Section 8.6 (Range Filter Structure):
 * 仕様準拠のワイヤバイト列 (1 Length 構造) をデコードできることを検証する。
 * decodeMessageParameter は count プレフィックスなしのパラメータ単体をデコードする。
 */
test("decodeMessageParameter: 1 Length 構造の Range Filter をデコードする", () => {
  const data = new Uint8Array([0x25, 0x03, 0x01, 0x03, 0x02]);
  const [param, consumed, paramType] = decodeMessageParameter(data, 0, 0n);

  assert.equal(param.type, 0x25);
  // Length 込みのバイト列が value として保持される
  assert.deepEqual(param.value, new Uint8Array([0x03, 0x01, 0x03, 0x02]));
  assert.equal(consumed, 5);
  assert.equal(paramType, 0x25n);
});

/**
 * draft-ietf-moq-transport-23 Section 8.6 (Range Filter Structure):
 * REQUEST_UPDATE での Range Filter 削除は「Type Delta + 0x00」の 1 Length 構造になる。
 */
test("encodeParameters: Range Filter の削除は Length=0 の 1 Length 構造になる", () => {
  // 削除は Length = 0 のみ (encodeRangeFilter の remove 指定で生成される value)
  const param = { type: 0x25, value: new Uint8Array([0x00]) };
  const encoded = encodeParameters([param]);

  assert.deepEqual(encoded, new Uint8Array([0x01, 0x25, 0x00]));
});

/**
 * draft-ietf-moq-transport-23 Section 8.6 (Range Filter Structure):
 * Range Filter の削除 (Length=0) をデコードできることを検証する。
 */
test("decodeMessageParameter: Range Filter の削除 (Length=0) をデコードする", () => {
  const data = new Uint8Array([0x25, 0x00]);
  const [param, consumed] = decodeMessageParameter(data, 0, 0n);

  assert.equal(param.type, 0x25);
  assert.deepEqual(param.value, new Uint8Array([0x00]));
  assert.equal(consumed, 2);
});

/**
 * draft-ietf-moq-transport-23 Section 8.6 (Range Filter Structure):
 * Range Filter の内側 Length が残りバイト数を超える不正ワイヤをデコードすると
 * ProtocolViolationError になることを検証する。
 */
test("decodeMessageParameter: Range Filter の内側 Length 超過で MALFORMED_MESSAGE", () => {
  // Length = 5 と宣言されているが残りバイトは 2 (SetID 1 + Start delta 3)
  const data = new Uint8Array([0x25, 0x05, 0x01, 0x03]);
  const thrown = captureThrownError(() => decodeMessageParameter(data, 0, 0n));
  assert.instanceOf(thrown, ProtocolViolationError);
  // 内側 Length が残りバイトを超えるフレーミング破損は MALFORMED_MESSAGE
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.MALFORMED_MESSAGE);
  assert.match(
    (thrown as ProtocolViolationError).message,
    /filter value length exceeds remaining data/,
  );
});

/**
 * draft-ietf-moq-transport-23 §2.4.1 / §8.7:
 * Track Namespace は最大 32 フィールドである。上限ちょうどの 32 フィールドが
 * encode / decode をラウンドトリップすることを固定する (境界の内側)。
 */
test("encodeTrackNamespace / decodeTrackNamespace: 32 フィールドはラウンドトリップする", () => {
  // 各フィールドは 1 バイト以上でなければならないため "f0" 〜 "f31" を使う
  const parts = Array.from({ length: MAX_TRACK_NAMESPACE_FIELDS }, (_, i) => `f${i}`);
  const namespace = createTrackNamespace(parts);

  const encoded = encodeTrackNamespace(namespace);
  const [decoded, consumed] = decodeTrackNamespace(encoded, 0);

  assert.equal(consumed, encoded.length);
  assert.equal(decoded.tuple.length, MAX_TRACK_NAMESPACE_FIELDS);
  assert.deepEqual(trackNamespaceToStrings(decoded), parts);
  // 先頭のフィールド数 varint が上限値そのものである
  assert.deepEqual(encoded.slice(0, 1), new Uint8Array([MAX_TRACK_NAMESPACE_FIELDS]));
});

/**
 * draft-ietf-moq-transport-23 §8.7:
 * "If an endpoint receives a Track Namespace consisting of greater than
 *  32 Track Namespace Fields, it MUST close the session with
 *  INVALID_TRACK_NAMESPACE."
 * 上限を 1 つ超える 33 フィールドは decode 時に拒否する (境界の外側)。
 */
test("decodeTrackNamespace: 33 フィールドは INVALID_TRACK_NAMESPACE で拒否する", () => {
  // createTrackNamespace も 33 フィールドを組み立てられないため、ワイヤを直接作る
  const wire = buildTrackNamespaceWire(MAX_TRACK_NAMESPACE_FIELDS + 1);

  const thrown = captureThrownError(() => decodeTrackNamespace(wire, 0));
  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.INVALID_TRACK_NAMESPACE);
  assert.match(
    (thrown as ProtocolViolationError).message,
    /track namespace fields exceeds maximum: 33 > 32/,
  );
});

/**
 * draft-ietf-moq-transport-23 §9.19.20:
 * TRACK_NAMESPACE_PREFIX (0x34) としての 32 / 33 フィールドも同じ境界で判定する
 * (decodeTrackNamespace へ委譲されるため、パラメータ経路でも境界が保たれる)。
 */
test("decodeMessageParameter: TRACK_NAMESPACE_PREFIX の 32 / 33 フィールド境界", () => {
  // 32 フィールドは通過し、消費バイト数がワイヤ長と一致する
  const maxWire = concatUint8Arrays([
    new Uint8Array([0x34]),
    buildTrackNamespaceWire(MAX_TRACK_NAMESPACE_FIELDS),
  ]);
  const [param, consumed] = decodeMessageParameter(maxWire, 0, 0n);
  assert.equal(param.type, 0x34);
  assert.equal(consumed, maxWire.length);

  // 33 フィールドは INVALID_TRACK_NAMESPACE
  const overWire = concatUint8Arrays([
    new Uint8Array([0x34]),
    buildTrackNamespaceWire(MAX_TRACK_NAMESPACE_FIELDS + 1),
  ]);
  const thrown = captureThrownError(() => decodeMessageParameter(overWire, 0, 0n));
  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.INVALID_TRACK_NAMESPACE);
  assert.match(
    (thrown as ProtocolViolationError).message,
    /track namespace fields exceeds maximum: 33 > 32/,
  );
});

/**
 * Track Namespace のワイヤ (Number of Track Namespace Fields + 各フィールド) を
 * 組み立てる。createTrackNamespace は 32 フィールド超を拒否するため、
 * 上限外の入力を作るテストはこのヘルパーで直接ワイヤを作る。
 *
 * @param fieldCount - フィールド数 (各フィールドは 1 バイト)
 */
function buildTrackNamespaceWire(fieldCount: number): Uint8Array {
  const parts: number[] = [...encodeVarint(BigInt(fieldCount))];
  for (let i = 0; i < fieldCount; i++) {
    // Track Namespace Field Length (1) + Value (i を 1 バイトで表す)
    parts.push(0x01, i & 0xff);
  }
  return new Uint8Array(parts);
}

/**
 * draft-ietf-moq-transport-23 §9.19.20 / §8.7:
 * TRACK_NAMESPACE_PREFIX (0x34) の Value は Track Namespace エンコーディング
 * (Number of Track Namespace Fields + 各フィールドの Length + Value) そのものであり、
 * 外側 Length を付加しない。固定バイト列で確認する。
 * 例: namespace = ["live", "sports"] のとき Value は
 *   0x02 (フィールド数 2) + 0x04 "live" + 0x06 "sports"
 * となり、ワイヤは Number of Parameters (0x01) + Type Delta (0x34) + Value。
 */
test("encodeParameters: TRACK_NAMESPACE_PREFIX は外側 Length なしでエンコードされる", () => {
  const param = encodeParameterTrackNamespace(createTrackNamespace(["live", "sports"]));
  const encoded = encodeParameters([param]);

  assert.deepEqual(
    encoded,
    new Uint8Array([
      0x01, // Number of Parameters
      0x34, // Type Delta (TRACK_NAMESPACE_PREFIX)
      0x02, // Number of Track Namespace Fields
      0x04, // Track Namespace Field Length ("live")
      0x6c,
      0x69,
      0x76,
      0x65,
      0x06, // Track Namespace Field Length ("sports")
      0x73,
      0x70,
      0x6f,
      0x72,
      0x74,
      0x73,
    ]),
  );
});

/**
 * draft-ietf-moq-transport-23 §9.19.21 (SUBSCRIBE_TRACKS_ID):
 * SUBSCRIBE_TRACKS_ID (0x36) は varint であり、Value は元の SUBSCRIBE_TRACKS の
 * Request ID をそのまま varint で符号化する (外側 Length なし)。
 * 固定ワイヤで確認する。例: Request ID = 0x11 のとき
 * Number of Parameters (0x01) + Type Delta (0x36) + Value (0x11)。
 */
test("encodeParameters: SUBSCRIBE_TRACKS_ID は varint で外側 Length なし", () => {
  const encoded = encodeParameters([
    {
      type: MessageParameterType.SUBSCRIBE_TRACKS_ID,
      value: encodeVarint(0x11n),
    },
  ]);

  assert.deepEqual(encoded, new Uint8Array([0x01, 0x36, 0x11]));

  // ラウンドトリップして Request ID が復元される
  const [parameters, consumed] = decodeParameters(encoded);
  assert.equal(consumed, encoded.length);
  assert.equal(parameters.length, 1);
  assert.equal(parameters[0]?.type, MessageParameterType.SUBSCRIBE_TRACKS_ID);
  assert.deepEqual(parameters[0]?.value, encodeVarint(0x11n));
});

/**
 * draft-ietf-moq-transport-23 §9.19.20 / §8.7:
 * 外側 Length を持たない TRACK_NAMESPACE_PREFIX のワイヤをデコードし、
 * 消費バイト数がワイヤ長と一致することを検証する (外側 Length を要求しない)。
 */
test("decodeMessageParameter: TRACK_NAMESPACE_PREFIX を外側 Length なしでデコードする", () => {
  const data = new Uint8Array([
    0x34, // Type Delta (TRACK_NAMESPACE_PREFIX)
    0x02, // Number of Track Namespace Fields
    0x04,
    0x6c,
    0x69,
    0x76,
    0x65,
    0x06,
    0x73,
    0x70,
    0x6f,
    0x72,
    0x74,
    0x73,
  ]);
  const [param, consumed, paramType] = decodeMessageParameter(data, 0, 0n);

  assert.equal(param.type, 0x34);
  assert.equal(paramType, 0x34n);
  assert.equal(consumed, data.length);
  const [trackNamespace] = decodeTrackNamespace(param.value, 0);
  assert.deepEqual(trackNamespaceToStrings(trackNamespace), ["live", "sports"]);
});

/**
 * draft-ietf-moq-transport-23 §9.19.12 (PRIORITY FILTER Parameter):
 * "If a decoded value exceeds 255, the endpoint MUST reject this with
 *  REQUEST_ERROR with error code INVALID_FILTER since Publisher Priority
 *  is an 8-bit field."
 * PRIORITY_FILTER の Range 値が 255 を超える場合に InvalidFilterError が
 * 送出されることを検証する。
 */
test("decodeRangeFilter: PRIORITY_FILTER の 255 超の値で InvalidFilterError", () => {
  // Length 3 / SetID 1 / Start delta 258 (Start=258 > 255)
  const data = new Uint8Array([0x03, 0x01, 0x81, 0x02]);
  assert.throws(() => decodeRangeFilter("priority", data), InvalidFilterError);
});

/**
 * draft-ietf-moq-transport-23 §9.19.12:
 * PRIORITY_FILTER の境界値 255 ちょうどは違反にならないことを検証する。
 */
test("decodeRangeFilter: PRIORITY_FILTER の 255 ちょうどは違反にならない", () => {
  // Length 3 / SetID 1 / Start delta 255 (2 バイト varint: 0x80 0xff) / End 省略
  const data = new Uint8Array([0x03, 0x01, 0x80, 0xff]);
  const [decoded] = decodeRangeFilter("priority", data);
  assert.isFalse("remove" in decoded);
  if (!("remove" in decoded)) {
    assert.equal(decoded.ranges[0].start, 255n);
  }
});

/**
 * draft-ietf-moq-transport-23 §9.19.13 (OBJECT PROPERTY FILTER Parameter):
 * Property Type は偶数でなければならず、奇数の場合は InvalidFilterError。
 */
test("decodeRangeFilter: OBJECT_PROPERTY_FILTER の奇数 Property Type で InvalidFilterError", () => {
  // Length 4 / SetID 1 / Property Type 3 (奇数) / Start delta 0 / End delta 0
  const data = new Uint8Array([0x04, 0x01, 0x03, 0x00, 0x00]);
  assert.throws(() => decodeRangeFilter("objectProperty", data), InvalidFilterError);
});

/**
 * draft-ietf-moq-transport-23 §8.6:
 * "Any delta encoding that results in a value that exceeds 2^64-1 MUST be
 *  rejected with REQUEST_ERROR with error code INVALID_FILTER."
 * Range delta の累積値 (Start) が 2^64-1 を超える場合に InvalidFilterError が
 * 送出されることを検証する。
 */
test("decodeRangeFilter: Range 累積値が 2^64-1 を超えると InvalidFilterError", () => {
  // body = SetID(1) + Start delta 2^64-1 (9 バイト) + End delta 0 (1 バイト)
  //        + Start delta 1 (1 バイト) = 12 バイト
  // 1 個目: Start = 2^64-1 は合法、End = 2^64-1 も合法
  // 2 個目: Start = 2^64-1 + 1 = 2^64 > 2^64-1 で超過
  const data = new Uint8Array([
    ...encodeVarint(12n),
    ...encodeVarint(1n),
    ...encodeVarint(MAX_VARINT),
    ...encodeVarint(0n), // End delta 0 → End = 2^64-1
    ...encodeVarint(1n), // Start delta 1 → Start = 2^64 (超過)
  ]);
  assert.throws(() => decodeRangeFilter("objectId", data), InvalidFilterError);
});

/**
 * draft-ietf-moq-transport-23 §8.6:
 * Range 列の varint が宣言 Length 内で途中終端する構造不正は、
 * IncompleteDataError ではなく InvalidFilterError になることを検証する。
 * (IncompleteDataError のまま流すと受信ループの
 * toProtocolViolationSessionError でセッションが閉じるため、値違反として
 * REQUEST_ERROR で応答できる InvalidFilterError に明示的に変換する)
 */
test("decodeRangeFilter: Range 列の varint 途中終端で InvalidFilterError", () => {
  // Length 4 / SetID 1 / Start delta 0 / End delta 0 / 最後の 0x81 は 2 バイト
  // varint の先頭であり、body 終端で途切れる (構造不正)
  const data = new Uint8Array([0x04, 0x01, 0x00, 0x00, 0x81]);
  assert.throws(() => decodeRangeFilter("objectId", data), InvalidFilterError);
});

/**
 * draft-ietf-moq-transport-23 §8.6:
 * 構造不正 (Length > 0 なのに SetID / Property Type / Range 列の欠落) は
 * InvalidFilterError になることを検証する。
 */
test("decodeRangeFilter: SetID が欠落していると InvalidFilterError", () => {
  // Length 1 を宣言しているが body (SetID) が存在しない
  const data = new Uint8Array([0x01]);
  assert.throws(() => decodeRangeFilter("objectId", data), InvalidFilterError);
});

/**
 * draft-ietf-moq-transport-23 §8.6:
 * 構造不正 (Length > 0 なのに Range 列が欠落) は InvalidFilterError になる
 * ことを検証する。SetID のみで Range が 1 つもない構成。
 */
test("decodeRangeFilter: Range 列が欠落していると InvalidFilterError", () => {
  // Length 1 / SetID 1 のみで Range 列がない
  const data = new Uint8Array([0x01, 0x01]);
  assert.throws(() => decodeRangeFilter("objectId", data), InvalidFilterError);
});

/**
 * draft-ietf-moq-transport-23 §8.6:
 * 構造不正 (Property Type の欠落) は InvalidFilterError になることを検証する。
 */
test("decodeRangeFilter: Property Type が欠落していると InvalidFilterError", () => {
  // Length 1 / SetID 1 のみで Property Type がない (objectProperty は PT 必須)
  const data = new Uint8Array([0x01, 0x01]);
  assert.throws(() => decodeRangeFilter("objectProperty", data), InvalidFilterError);
});

/**
 * draft-ietf-moq-transport-23 §3.3.2:
 * "If the same combination of Parameter Type, SetID, and Property Type
 *  (only in the Track and Object Property Filters) repeat in any message,
 *  an endpoint MUST reject this with REQUEST_ERROR with error code
 *  INVALID_FILTER."
 * 同一組み合わせの Range Filter パラメータの重複を検出することを検証する。
 */
test("validateRangeFilterCombination: 同一組み合わせの重複で InvalidFilterError", () => {
  // 同じ (Type=0x25, SetID=1) の SUBGROUP_FILTER を 2 つ
  const param = {
    type: 0x25,
    value: new Uint8Array([0x03, 0x01, 0x00, 0x00]),
  };
  assert.throws(() => validateRangeFilterCombination([param, param]), InvalidFilterError);
});

/**
 * draft-ietf-moq-transport-23 §3.3.2:
 * SetID が異なる同型 Range Filter は重複にならないことを検証する。
 */
test("validateRangeFilterCombination: SetID 違いは重複にならない", () => {
  const param1 = {
    type: 0x25,
    value: new Uint8Array([0x03, 0x01, 0x00, 0x00]),
  };
  const param2 = {
    type: 0x25,
    value: new Uint8Array([0x03, 0x02, 0x00, 0x00]),
  };
  assert.doesNotThrow(() => validateRangeFilterCombination([param1, param2]));
});

/**
 * draft-ietf-moq-transport-23 §3.3.2:
 * Length=0 の削除エントリは SetID を持たないため重複判定の対象外であることを
 * 検証する。
 */
test("validateRangeFilterCombination: 削除エントリは重複判定の対象外", () => {
  const removeParam = {
    type: 0x25,
    value: new Uint8Array([0x00]),
  };
  const param = {
    type: 0x25,
    value: new Uint8Array([0x03, 0x01, 0x00, 0x00]),
  };
  assert.doesNotThrow(() => validateRangeFilterCombination([removeParam, param]));
});

/**
 * draft-ietf-moq-transport-23 §9.19.13 / §9.19.14:
 * encodeRangeFilter は奇数 Property Type を送信前に拒否することを検証する。
 */
test("encodeRangeFilter: 奇数 Property Type で InvalidFilterError", () => {
  assert.throws(
    () =>
      encodeRangeFilter({
        type: "objectProperty",
        setId: 1,
        propertyType: 3n,
        ranges: [{ start: 0n, end: 10n }],
      }),
    InvalidFilterError,
  );
});

/**
 * draft-ietf-moq-transport-23 §9.19.12:
 * encodeRangeFilter は PRIORITY_FILTER の 255 超の値を送信前に拒否することを
 * 検証する。
 */
test("encodeRangeFilter: PRIORITY_FILTER の 255 超の値で InvalidFilterError", () => {
  assert.throws(
    () =>
      encodeRangeFilter({
        type: "priority",
        setId: 1,
        ranges: [{ start: 0n, end: 256n }],
      }),
    InvalidFilterError,
  );
});

/**
 * draft-ietf-moq-transport-23 §9.19.10–§9.19.14:
 * encodeRangeFilter は SetID 255 超を送信前に拒否することを検証する。
 */
test("encodeRangeFilter: SetID 255 超で InvalidFilterError", () => {
  assert.throws(
    () =>
      encodeRangeFilter({
        type: "subgroup",
        setId: 256,
        ranges: [{ start: 0n, end: 10n }],
      }),
    InvalidFilterError,
  );
});

/**
 * draft-ietf-moq-transport-23 §3.3.2:
 * encodeRangeFilter は Range の絶対値 (Start / End) が 2^64-1 を超える場合に
 * 送信前に拒否することを検証する。
 */
test("encodeRangeFilter: Range 絶対値が 2^64-1 を超えると InvalidFilterError", () => {
  assert.throws(
    () =>
      encodeRangeFilter({
        type: "objectId",
        setId: 1,
        ranges: [{ start: MAX_VARINT + 1n, end: MAX_VARINT + 2n }],
      }),
    InvalidFilterError,
  );
});

/**
 * draft-ietf-moq-transport-23 §3.3.2:
 * encodeRangeFilter は空の ranges を送信前に拒否することを検証する。
 * (デコード側が「no ranges」を InvalidFilterError で拒否するため、
 *  送受信不整合を防ぐ)
 */
test("encodeRangeFilter: 空の ranges で InvalidFilterError", () => {
  assert.throws(
    () =>
      encodeRangeFilter({
        type: "subgroup",
        setId: 1,
        ranges: [],
      }),
    InvalidFilterError,
  );
});

/**
 * isRejectedReceiveNamespace のテスト
 * draft-ietf-moq-transport-23 Section 2.4.3 (Reserved Namespaces):
 * "A Track Namespace whose first field is exactly . (a single period,
 *  0x2e) is reserved and MUST NOT be used for any purpose; endpoints
 *  MUST NOT publish tracks or namespaces under it and MUST reject
 *  requests referencing it with DOES_NOT_EXIST."
 * draft-ietf-moq-transport-23 Section 6.5 (Session-Level Tracks and Namespaces):
 * "An endpoint that receives a request for an unrecognized session-level
 *  track or namespace MUST reject it with REQUEST_ERROR using error code
 *  DOES_NOT_EXIST rather than passing it to the Application."
 */
test("isRejectedReceiveNamespace: 先頭フィールドが .session なら拒否対象", () => {
  // §6.5: セッションレベルの名前空間は DOES_NOT_EXIST で拒否する
  assert.equal(isRejectedReceiveNamespace(createTrackNamespace([".session"]).tuple), true);
});

test("isRejectedReceiveNamespace: 先頭フィールドが .session で複数フィールドでも拒否対象", () => {
  // §6.5: セッションレベル名前空間の下の track も拒否対象
  assert.equal(isRejectedReceiveNamespace(createTrackNamespace([".session", "sub"]).tuple), true);
});

test("isRejectedReceiveNamespace: 先頭フィールドが . 単体なら拒否対象", () => {
  // §2.4.3: 先頭フィールドが "." (0x2e) 単体の名前空間は DOES_NOT_EXIST で拒否する
  assert.equal(isRejectedReceiveNamespace(createTrackNamespace(["."]).tuple), true);
  assert.equal(isRejectedReceiveNamespace(createTrackNamespace([".", "sub"]).tuple), true);
});

test("isRejectedReceiveNamespace: その他の予約名前空間 (.foo) は拒否しない", () => {
  // §2.4.3: 認識されない予約名前空間はアプリへ渡す (将来の拡張を壊さないため)
  assert.equal(isRejectedReceiveNamespace(createTrackNamespace([".foo"]).tuple), false);
  assert.equal(isRejectedReceiveNamespace(createTrackNamespace([".session2"]).tuple), false);
});

test("isRejectedReceiveNamespace: 通常の名前空間は拒否しない", () => {
  assert.equal(isRejectedReceiveNamespace(createTrackNamespace(["example"]).tuple), false);
  assert.equal(isRejectedReceiveNamespace(createTrackNamespace(["example", "sub"]).tuple), false);
});

test("isRejectedReceiveNamespace: 空の名前空間は拒否しない", () => {
  // 先頭フィールドが存在しないため §2.4.3 / §6.5 の対象外
  assert.equal(isRejectedReceiveNamespace([]), false);
});

test("isRejectedReceiveNamespace: 先頭フィールドが空バイト列なら拒否しない", () => {
  // 先頭フィールドが空 (. でも .session でもない) ため拒否対象外
  assert.equal(isRejectedReceiveNamespace([new Uint8Array(0)]), false);
});

test("isRejectedReceiveNamespace: . 単体をバイト列リテラルで判定する", () => {
  // §2.4.3 は 0x2e をバイト値で定義しているため、エンコーダに依存しない
  // バイト列直接の検証。0x2e を含む他のバイト列 (. 単体以外) は拒否しない
  assert.equal(isRejectedReceiveNamespace([new Uint8Array([0x2e])]), true);
  assert.equal(isRejectedReceiveNamespace([new Uint8Array([0x2e, 0x2e])]), false);
  assert.equal(isRejectedReceiveNamespace([new Uint8Array([0x2e, 0xff])]), false);
});

test("isRejectedReceiveNamespace: .session をバイト列リテラルで判定する", () => {
  // §6.5 は .session を 8 バイト (0x2e 0x73 0x65 0x73 0x73 0x69 0x6f
  // 0x6e) で定義しているため、エンコーダに依存しないバイト列直接の検証
  assert.equal(
    isRejectedReceiveNamespace([new Uint8Array([0x2e, 0x73, 0x65, 0x73, 0x73, 0x69, 0x6f, 0x6e])]),
    true,
  );
  assert.equal(
    isRejectedReceiveNamespace([
      new Uint8Array([0x2e, 0x73, 0x65, 0x73, 0x73, 0x69, 0x6f, 0x6e]),
      new Uint8Array([0x74]),
    ]),
    true,
  );
});

test("isRejectedReceiveNamespace: .session の類似バイト列は拒否しない", () => {
  // .session は完全一致のみ拒否対象 (プレフィックス・大文字小文字の
  // 違いは対象外)
  assert.equal(isRejectedReceiveNamespace([new Uint8Array([0x2e, 0x73, 0x65, 0x73, 0x73])]), false);
  assert.equal(
    isRejectedReceiveNamespace([new Uint8Array([0x2e, 0x53, 0x65, 0x73, 0x73, 0x69, 0x6f, 0x6e])]),
    false,
  );
});

/**
 * draft-ietf-moq-transport-23 §9.19.15:
 * "Its value is a Number of Parameters (vi64) followed by that many Parameters".
 * 空の fill は Number of Parameters 0 のみで表現され、draft-22 の外側 Length を
 * 含まない。外側 Length が残ると後続フィールドを誤読するため、固定ワイヤで形式を
 * 固定する。
 */
test("encodeFillParameters: 空の fill は count 0 のみで外側 Length を含まない", () => {
  const encoded = encodeParameters([encodeFillParameters([])]);
  // Number of Parameters (外側) = 1 / Type Delta = 0x23 / 内側 count = 0
  assert.deepEqual(encoded, new Uint8Array([0x01, 0x23, 0x00]));

  const [decoded, consumed] = decodeParameters(encoded);
  assert.equal(consumed, encoded.length);
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].type, 0x23);
  // Value は内側 count 0 の 1 バイトのみ (外側 Length のバイトは存在しない)
  assert.deepEqual(decoded[0].value, new Uint8Array([0x00]));
  assert.deepEqual(decodeFillParameters(decoded[0]), []);
});

/**
 * draft-ietf-moq-transport-23 §9.19.15:
 * 内側に複数型を載せた場合も Value は Number of Parameters + Parameters のみであり、
 * draft-22 の外側 Length を付加しないことを固定ワイヤで検証する。
 * 内側の Type Delta は内側の先頭を 0 基準とし、昇順に並ぶ。
 */
test("encodeFillParameters: 複数型の内側を外側 Length なしでエンコードする", () => {
  const encoded = encodeParameters([
    encodeFillParameters([
      // FILL_TIMEOUT (0x0A)
      { type: 0x0a, value: encodeVarint(100n) },
      // SUBSCRIBER_PRIORITY (0x20)
      { type: 0x20, value: new Uint8Array([10]) },
      // LOCATION_FILTER (0x21) Type 0x01 (Relative Start) StartGroup 3
      encodeLocationFilterParameter({ startGroup: 3n }),
      // GROUP_ORDER (0x22) Descending
      { type: 0x22, value: new Uint8Array([0x02]) },
    ]),
  ]);

  // ワイヤの並び:
  // [0x01] 外側 Number of Parameters = 1
  // [0x23] Type Delta = FILL_PARAMETERS
  // [0x04] 内側 Number of Parameters = 4
  // [0x0a 0x64] FILL_TIMEOUT (delta 0x0A) / 100
  // [0x16 0x0a] SUBSCRIBER_PRIORITY (delta 0x16) / 10
  // [0x01 0x01 0x03] LOCATION_FILTER (delta 0x01) / Type 0x01 / StartGroup 3
  // [0x01 0x02] GROUP_ORDER (delta 0x01) / Descending
  assert.deepEqual(
    encoded,
    new Uint8Array([0x01, 0x23, 0x04, 0x0a, 0x64, 0x16, 0x0a, 0x01, 0x01, 0x03, 0x01, 0x02]),
  );

  const [decoded, consumed] = decodeParameters(encoded);
  assert.equal(consumed, encoded.length);
  assert.equal(decoded.length, 1);
  assert.equal(decodeFillParameters(decoded[0]).length, 4);
});

/**
 * draft-ietf-moq-transport-23 §9.19.15:
 * 内側の Type Delta は外側の直前 Type ではなく内側の先頭を 0 基準とする。
 * 外側の直前 Type (0x20) を基準にすると内側先頭の delta 0x0A は 0x2A に
 * なってしまうため、この固定ワイヤで基準の独立性を検証する。
 */
test("decodeParameters: 内側の Type Delta は 0 基準である", () => {
  // ワイヤの並び:
  // [0x02] 外側 Number of Parameters = 2
  // [0x20 0x0a] SUBSCRIBER_PRIORITY (delta 0x20) / 10
  // [0x03] FILL_PARAMETERS の Type Delta (0x23 - 0x20)
  // [0x01] 内側 Number of Parameters = 1
  // [0x0a 0x64] FILL_TIMEOUT (内側先頭 = delta 0x0A そのもの) / 100
  const encoded = new Uint8Array([0x02, 0x20, 0x0a, 0x03, 0x01, 0x0a, 0x64]);

  const [decoded, consumed] = decodeParameters(encoded);
  assert.equal(consumed, encoded.length);
  assert.equal(decoded.length, 2);
  const inner = decodeFillParameters(decoded[1]);
  assert.equal(inner.length, 1);
  assert.equal(inner[0].type, 0x0a);
  assert.deepEqual(inner[0].value, encodeVarint(100n));

  // エンコード結果も同じ固定ワイヤになる (送信側も 0 基準で delta を付ける)
  assert.deepEqual(
    encodeParameters([
      { type: 0x20, value: new Uint8Array([0x0a]) },
      encodeFillParameters([{ type: 0x0a, value: encodeVarint(100n) }]),
    ]),
    encoded,
  );
});

/**
 * draft-ietf-moq-transport-23 §9.19.15 Table 7:
 * FILL_PARAMETERS の入れ子は内側の一覧に無いため拒否する。
 * 受信側は ProtocolViolationError、送信側はローカル API 誤用の Error とする。
 */
test("FILL_PARAMETERS: 入れ子の FILL_PARAMETERS は拒否される", () => {
  // 外側 count 1 / 0x23 / 内側 count 1 / 内側の型 delta 0x23 (入れ子)
  const nested = new Uint8Array([0x01, 0x23, 0x01, 0x23]);
  const thrown = captureThrownError(() => decodeParameters(nested));
  assert.instanceOf(thrown, ProtocolViolationError);
  // Table 7 に無い型として INVALID_PARAMETER で閉じる
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.INVALID_PARAMETER);
  assert.match(
    (thrown as ProtocolViolationError).message,
    /FILL_PARAMETERS must not be nested inside FILL_PARAMETERS/,
  );
  // 送信側はローカル API 誤用の generic Error (プロトコル違反ではない)
  let encodeThrown: Error | undefined;
  try {
    encodeFillParameters([{ type: 0x23, value: new Uint8Array([0x00]) }]);
  } catch (error) {
    encodeThrown = error instanceof Error ? error : new Error(String(error));
  }
  assert.isDefined(encodeThrown);
  assert.match(
    encodeThrown?.message ?? "",
    /FILL_PARAMETERS must not be nested inside FILL_PARAMETERS/,
  );
  assert.notInstanceOf(encodeThrown, ProtocolViolationError);
});

/**
 * draft-ietf-moq-transport-23 §9.19.15:
 * "An endpoint that receives a parameter inside FILL_PARAMETERS that is not
 *  listed above MUST close the session with INVALID_PARAMETER."
 * 一覧外の型は受信時に拒否する。未知型も Value 長を解釈せず、一覧外として
 * Type Delta の時点で拒否する。
 */
test("FILL_PARAMETERS: 一覧外の型を含む内側は受信時に INVALID_PARAMETER", () => {
  // PAUSED (0x11) は Table 7 に無い (FILL_PARAMETERS の内側には置けない)
  const pausedThrown = captureThrownError(() =>
    decodeParameters(new Uint8Array([0x01, 0x23, 0x01, 0x11, 0x01])),
  );
  assert.instanceOf(pausedThrown, ProtocolViolationError);
  assert.equal((pausedThrown as ProtocolViolationError).code, SessionErrorCode.INVALID_PARAMETER);
  assert.match(
    (pausedThrown as ProtocolViolationError).message,
    /unsupported parameter inside FILL_PARAMETERS: 0x11/,
  );
  // 未知型 (0x24) も一覧外として拒否する (Value のエンコーディングは解釈しない)
  const unknownThrown = captureThrownError(() =>
    decodeParameters(new Uint8Array([0x01, 0x23, 0x01, 0x24])),
  );
  assert.instanceOf(unknownThrown, ProtocolViolationError);
  assert.equal((unknownThrown as ProtocolViolationError).code, SessionErrorCode.INVALID_PARAMETER);
  assert.match(
    (unknownThrown as ProtocolViolationError).message,
    /unsupported parameter inside FILL_PARAMETERS: 0x24/,
  );
});

/**
 * draft-ietf-moq-transport-23 §9.19.15:
 * 一覧外の型を内側に載せたワイヤはピアのセッションを閉じさせるため、送信側でも
 * ローカル API 誤用として拒否する。
 */
test("encodeFillParameters: 一覧外の型は送信前に拒否する", () => {
  // PAUSED (0x11) は Table 7 の一覧に無い既知の型
  assert.throws(
    () => encodeFillParameters([{ type: 0x11, value: new Uint8Array([1]) }]),
    /parameter type 0x11 is not allowed inside FILL_PARAMETERS/,
  );
});

/**
 * draft-ietf-moq-transport-23 §9.19.15 Table 7:
 * TRACK_PROPERTY_FILTER (0x29) は SUBSCRIBE_TRACKS 専用のため、fill の内側には
 * 載せられない。
 */
test("FILL_PARAMETERS: TRACK_PROPERTY_FILTER は内側に載せられない", () => {
  const thrown = captureThrownError(() =>
    decodeParameters(new Uint8Array([0x01, 0x23, 0x01, 0x29])),
  );
  assert.instanceOf(thrown, ProtocolViolationError);
  // Table 7 に無い型は INVALID_PARAMETER で閉じる
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.INVALID_PARAMETER);
  assert.match(
    (thrown as ProtocolViolationError).message,
    /unsupported parameter inside FILL_PARAMETERS: 0x29/,
  );
  assert.throws(
    () => encodeFillParameters([{ type: 0x29, value: new Uint8Array([0x01, 0x00, 0x00]) }]),
    /parameter type 0x29 is not allowed inside FILL_PARAMETERS/,
  );
});

/**
 * draft-ietf-moq-transport-23 §9.19:
 * "Senders MUST NOT repeat the same Parameter Type in a message unless the
 *  parameter definition explicitly allows multiple instances of that type to be
 *  sent in a single message."
 * 内側は独立した parameter scope のため、内側の列で同じ型が 2 回現れると
 * 受信時に ProtocolViolationError になる (外側の型の出現状況とは無関係)。
 */
test("FILL_PARAMETERS: 内側の重複パラメータは INVALID_PARAMETER", () => {
  // 内側 count 2 / SUBSCRIBER_PRIORITY 5 / delta 0 (同じ型) 6
  const encoded = new Uint8Array([0x01, 0x23, 0x02, 0x20, 0x05, 0x00, 0x06]);
  const thrown = captureThrownError(() => decodeParameters(encoded));
  assert.instanceOf(thrown, ProtocolViolationError);
  // 内側スコープの型重複は INVALID_PARAMETER
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.INVALID_PARAMETER);
  assert.match(
    (thrown as ProtocolViolationError).message,
    /duplicate message parameter type inside FILL_PARAMETERS: 0x20/,
  );
});

/**
 * draft-ietf-moq-transport-23 §9.19.15:
 * 内側の Type Delta 加算も外側と同じく 2^64-1 を超えると拒否する。
 */
test("FILL_PARAMETERS: 内側の Type Delta 加算超過は DELTA_ENCODING_OVERFLOW", () => {
  // 内側 count 2 / SUBSCRIBER_PRIORITY 5 / 2 件目の delta = 2^64-1
  const encoded = concatUint8Arrays([
    new Uint8Array([0x01, 0x23, 0x02, 0x20, 0x05]),
    encodeVarint(MAX_VARINT),
  ]);
  const thrown = captureThrownError(() => decodeParameters(encoded));
  assert.instanceOf(thrown, ProtocolViolationError);
  // Type Delta の累積超過は §8.3 の MUST により DELTA_ENCODING_OVERFLOW
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.DELTA_ENCODING_OVERFLOW);
  assert.match((thrown as ProtocolViolationError).message, /delta type addition exceeds maximum/);
});

/**
 * draft-ietf-moq-transport-23 §9.19.15:
 * Number of Parameters より内側が不足する切り詰めは、データ末尾に達した時点で
 * IncompleteDataError になる。制御メッセージ受信経路ではフレーム長で
 * バッファが揃っているため、この IncompleteDataError は MALFORMED_MESSAGE に
 * 変換されてセッションが閉じる。
 */
test("FILL_PARAMETERS: count より内側が不足する切り詰めは IncompleteDataError", () => {
  // 内側 count 2 だが内側パラメータは 1 件しかない (データ末尾)
  const truncated = new Uint8Array([0x01, 0x23, 0x02, 0x20, 0x05]);
  assert.throws(() => decodeParameters(truncated), IncompleteDataError);
});

/**
 * draft-ietf-moq-transport-23 §9.19.15:
 * 異常に大きな Number of Parameters でも、内側パラメータの読み取りがデータ末尾に
 * 達した時点で IncompleteDataError となり、無限ループや過剰な走査にならない。
 */
test("FILL_PARAMETERS: 2^64-1 の Number of Parameters は IncompleteDataError", () => {
  // 外側 count 1 / 0x23 / 内側 count = 2^64-1 (内側パラメータは存在しない)
  const encoded = concatUint8Arrays([new Uint8Array([0x01, 0x23]), encodeVarint(MAX_VARINT)]);
  assert.throws(() => decodeParameters(encoded), IncompleteDataError);
});

/**
 * draft-ietf-moq-transport-23 §9.19.15:
 * fill の内側 count が実際より大きい場合、外側の次の Type Delta を内側として
 * 読み進める。この例では内側の許可型に一致しない型に着地するため、一覧外検証が
 * 拒否して外側パラメータを黙って取り込まない。fill は独立した Length を持たず
 * count 自体が境界を定義するため、後続バイトが偶然すべて許可型として解釈できる
 * 切り詰めは原理的に判別できない (仕様上 Length が無いことの帰結)。
 */
test("FILL_PARAMETERS: 不許可型に着地する切り詰めは拒否する", () => {
  // 外側 count 2: FILL_PARAMETERS (内側 count 2 だが 1 件のみ) + INCLUDE_PROPERTIES
  // (0x35)。fill の 2 件目として外側の Type Delta 0x12 を読むが、内側の
  // 直前 Type 0x20 との加算で 0x32 になり、Table 7 に無いため
  // ProtocolViolationError になる。
  const encoded = new Uint8Array([0x02, 0x23, 0x02, 0x20, 0x05, 0x12, 0x01]);
  assert.throws(
    () => decodeParameters(encoded),
    /unsupported parameter inside FILL_PARAMETERS: 0x32/,
  );
});

/**
 * draft-ietf-moq-transport-23 §9.19.15:
 * FILL_PARAMETERS の内側 count が破損して大きくなった場合、後続の外側
 * パラメータのバイトが内側の許可型として解釈され得る。fill は独立した Length を
 * 持たず count 自体が境界を定義するため、count の下で妥当な wire として
 * 受理されるこのケースは受信側だけでは切り詰めと判別できない (仕様上 Length が
 * 無いことの帰結)。ここでは「拒否できない既知の制限」として再解釈の構造まで固定する。
 */
test("FILL_PARAMETERS: count 過大で許可型に着地する wire は切り詰めと判別できない", () => {
  // 意図: 外側 2 件 = fill (内側 count 1、SUBSCRIBER_PRIORITY=5) +
  //       SUBGROUP_FILTER (外側 delta 0x02、Length 2、body 0x02 0x00)
  // 破損: 内側 count 2。内側 2 件目は本来の外側 Type Delta (0x02) と外側 Length
  //       (0x02) を GROUP_ORDER=2 として消費し、残った body の 0x02 0x00 が
  //       次の外側 Type Delta (0x02 -> 0x25) と self-length-prefixed の Length 0
  //       になる。内側は許可型として整合するため受信側ではエラーにならない。
  const wire = new Uint8Array([0x02, 0x23, 0x02, 0x20, 0x05, 0x02, 0x02, 0x02, 0x00]);
  const [decoded] = decodeParameters(wire);

  assert.equal(decoded.length, 2);
  assert.equal(decoded[0].type, 0x23);
  // 内側は SUBSCRIBER_PRIORITY と GROUP_ORDER として読まれる
  const inner = decodeFillParameters(decoded[0]);
  assert.equal(inner.length, 2);
  assert.equal(inner[0].type, 0x20);
  assert.equal(inner[1].type, 0x22);
  // 外側 2 件目は SUBGROUP_FILTER (0x25) の Length 0 (remove) として再解釈される
  assert.equal(decoded[1]?.type, 0x25);
  assert.deepEqual(decoded[1]?.value, new Uint8Array([0x00]));
});

/**
 * draft-ietf-moq-transport-23 §9.19.15:
 * Value の終端は Number of Parameters と内側 Parameters で決まるため、残余バイトを
 * 持つ Value は構築不正として ProtocolViolationError で拒否する。受信した
 * param.value は外側のデコーダが消費バイト数で正確に切り出すため通常は到達しないが、
 * 不変条件が崩れた場合にセッション終了へ倒せるようプロトコル違反として扱う
 * (decodeLocationFilterParameter の残余バイトと同方針)。
 */
test("decodeFillParameters: Value の末尾残余バイトは MALFORMED_MESSAGE", () => {
  // 空の fill ([count 0]) に残余バイトを付加する
  const trailing = new Uint8Array([0x00, 0x00]);
  const thrown = captureThrownError(() => decodeFillParameters({ type: 0x23, value: trailing }));
  assert.instanceOf(thrown, ProtocolViolationError);
  // Value 長と消費バイト数の不一致は MALFORMED_MESSAGE
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.MALFORMED_MESSAGE);
  assert.match((thrown as ProtocolViolationError).message, /malformed fill parameters/);
});

/**
 * encodeFillParameters は内側の重複を encodeParameters の重複検査で拒否する。
 */
test("encodeFillParameters: 内側の重複は Error", () => {
  let thrown: Error | undefined;
  try {
    encodeFillParameters([
      { type: 0x20, value: new Uint8Array([1]) },
      { type: 0x20, value: new Uint8Array([2]) },
    ]);
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }
  assert.isDefined(thrown);
  assert.match(thrown?.message ?? "", /duplicate message parameter type/);
  // 送信側のローカル API 誤用であり、プロトコル違反ではない
  assert.notInstanceOf(thrown, ProtocolViolationError);
});

/**
 * draft-ietf-moq-transport-23 §3.3.2 / §9.19.15:
 * Range Filter は同一 Parameter Type の複数出現を許す (§3.3.2)。fill の内側でも
 * 同型で SetID が異なる 2 件は受理し、同一 (Parameter Type, SetID) の重複は
 * InvalidFilterError で拒否する。
 */
test("decodeFillParameters: 内側の同型 Range Filter は SetID 違いなら受理する", () => {
  const setIdOne = encodeRangeFilter({
    type: "subgroup",
    setId: 1,
    ranges: [{ start: 0n, end: 10n }],
  });
  const setIdTwo = encodeRangeFilter({
    type: "subgroup",
    setId: 2,
    ranges: [{ start: 20n, end: 30n }],
  });
  const param = encodeFillParameters([
    { type: 0x25, value: setIdOne },
    { type: 0x25, value: setIdTwo },
  ]);

  const decoded = decodeFillParameters(param);
  assert.equal(decoded.length, 2);
  assert.equal(decoded[0]?.type, 0x25);
  assert.equal(decoded[1]?.type, 0x25);
});

test("decodeFillParameters: 内側の同型 Range Filter が同一 SetID なら InvalidFilterError", () => {
  const first = encodeRangeFilter({
    type: "subgroup",
    setId: 1,
    ranges: [{ start: 0n, end: 10n }],
  });
  const second = encodeRangeFilter({
    type: "subgroup",
    setId: 1,
    ranges: [{ start: 20n, end: 30n }],
  });
  const param = encodeFillParameters([
    { type: 0x25, value: first },
    { type: 0x25, value: second },
  ]);

  assert.throws(() => decodeFillParameters(param), InvalidFilterError);
});

/**
 * FILL_PARAMETERS 以外の型のデコードは誤用であり Error で拒否される。
 */
test("decodeFillParameters: 型不一致は Error", () => {
  assert.throws(
    () => decodeFillParameters({ type: 0x21, value: new Uint8Array([0x00]) }),
    "Invalid parameter type",
  );
});

/**
 * draft-ietf-moq-transport-23 §9.19.15:
 * 内側の除去 (Length=0) は一回限りの fill に意味を持たないため
 * InvalidFilterError で拒否される。
 */
test("decodeFillParameters: 内側の除去を含むと InvalidFilterError", () => {
  // SUBGROUP_FILTER の Length=0 (除去) を内側に含める
  const param = encodeFillParameters([{ type: 0x25, value: new Uint8Array([0x00]) }]);
  assert.throws(() => decodeFillParameters(param), InvalidFilterError);
});

/**
 * draft-ietf-moq-transport-23 §9.19.22:
 * INCLUDE_PROPERTIES (0x35) は uint8 で 0/1 のみ有効であり、
 * encode / decode のラウンドトリップができることを検証する。
 */
test("INCLUDE_PROPERTIES: 0/1 の encode / decode がラウンドトリップする", () => {
  for (const value of [0, 1]) {
    const encoded = encodeParameters([
      { type: MessageParameterType.INCLUDE_PROPERTIES, value: new Uint8Array([value]) },
    ]);
    const [decoded] = decodeParameters(encoded, 0);
    assert.equal(decoded.length, 1);
    assert.equal(decoded[0].type, MessageParameterType.INCLUDE_PROPERTIES);
    assert.deepEqual(decoded[0].value, new Uint8Array([value]));
  }
});

/**
 * draft-ietf-moq-transport-23 §9.19.22:
 * "If an endpoint receives a value outside this range, it MUST close
 *  the session with INVALID_PARAMETER."
 * 値 0/1 以外の INCLUDE_PROPERTIES を受信した場合、
 * INVALID_PARAMETER の ProtocolViolationError になることを検証する。
 */
test("INCLUDE_PROPERTIES: 2 の decode で INVALID_PARAMETER", () => {
  const encoded = encodeParameters([
    { type: MessageParameterType.INCLUDE_PROPERTIES, value: new Uint8Array([2]) },
  ]);
  const thrown = captureThrownError(() => decodeParameters(encoded, 0));
  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.INVALID_PARAMETER);
});

/**
 * draft-ietf-moq-transport-23 §9.19.22:
 * validateIncludePropertiesValue が 0/1 を受理し、範囲外を拒否することを検証する。
 */
test("validateIncludePropertiesValue: 0/1 は通過し 2/255 は INVALID_PARAMETER", () => {
  validateIncludePropertiesValue(0);
  validateIncludePropertiesValue(1);
  for (const value of [2, 255]) {
    const thrown = captureThrownError(() => validateIncludePropertiesValue(value));
    assert.instanceOf(thrown, ProtocolViolationError);
    // §9.19.22 の MUST により INVALID_PARAMETER で閉じる
    assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.INVALID_PARAMETER);
  }
});

/**
 * Length 宣言 slice の境界検証 (切り詰め入力の宣言時点拒否)。
 *
 * draft-ietf-moq-transport-23 §9.19:
 * 制御ストリームは外側でフレーミング済みのため、Length 宣言が
 * 残りバイトを超える内側の不足は破損であり、短い slice を返さず
 * 宣言時点で ProtocolViolationError とする。
 */
test("decodeTrackNamespace: 要素 Length 宣言超過で MALFORMED_MESSAGE", () => {
  // 要素数 1 + 要素 Length 5 宣言 + 2 バイトの切り詰め
  const truncated = new Uint8Array([0x01, 0x05, 0xaa, 0xbb]);
  const thrown = captureThrownError(() => decodeTrackNamespace(truncated, 0));
  assert.instanceOf(thrown, ProtocolViolationError);
  // 宣言長が残りバイトを超えるフレーミング破損は MALFORMED_MESSAGE
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.MALFORMED_MESSAGE);
  assert.match(
    (thrown as ProtocolViolationError).message,
    /track namespace field length exceeds remaining data/,
  );
});

test("decodeKeyValuePairs: 奇数型の Length 宣言超過で MALFORMED_MESSAGE", () => {
  // delta 0x21 (奇数) + Length 5 宣言 + Value 2 バイトの切り詰め
  const truncated = new Uint8Array([0x21, 0x05, 0xaa, 0xbb]);
  const thrown = captureThrownError(() => decodeKeyValuePairs(truncated, 0));
  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.MALFORMED_MESSAGE);
  assert.match(
    (thrown as ProtocolViolationError).message,
    /parameter value length exceeds remaining data/,
  );
});

test("decodeMessageParameter: uint8 分岐の残量不足で MALFORMED_MESSAGE", () => {
  // PAUSED (0x11) の delta のみで Value 1 バイトが存在しない切り詰め。
  // 宣言時点で拒否するため、値域検証由来ではない文言で固定する
  const truncated = new Uint8Array([0x11]);
  const thrown = captureThrownError(() => decodeMessageParameter(truncated, 0, 0n));
  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.MALFORMED_MESSAGE);
  assert.match(
    (thrown as ProtocolViolationError).message,
    /uint8 parameter value length exceeds remaining data/,
  );
});

test("decodeMessageParameter: length-prefixed 分岐の Length 宣言超過で MALFORMED_MESSAGE", () => {
  // AUTHORIZATION_TOKEN (0x03) + Length 5 宣言 + Value 2 バイトの切り詰め
  // (FILL_PARAMETERS は draft-23 で外側 Length を持たないため length-prefixed
  //  分岐の境界検証は Length を持つ AUTHORIZATION_TOKEN で固定する)
  const truncated = new Uint8Array([0x03, 0x05, 0xaa, 0xbb]);
  const thrown = captureThrownError(() => decodeMessageParameter(truncated, 0, 0n));
  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.MALFORMED_MESSAGE);
  assert.match(
    (thrown as ProtocolViolationError).message,
    /message parameter value length exceeds remaining data/,
  );
});

test("decodeMessageParameter: FILL_PARAMETERS を外側 Length なしでデコードする", () => {
  // Type Delta 0x23 / 内側 Number of Parameters 1 / SUBSCRIBER_PRIORITY 5
  const wire = new Uint8Array([0x23, 0x01, 0x20, 0x05]);
  const [param, consumed, paramType] = decodeMessageParameter(wire, 0, 0n);

  assert.equal(param.type, 0x23);
  assert.equal(paramType, 0x23n);
  // 内側 count と内側パラメータの bytes がそのまま Value になる
  assert.deepEqual(param.value, new Uint8Array([0x01, 0x20, 0x05]));
  // 外側 Length を読んでいないため、消費バイト数はワイヤ長と一致する
  assert.equal(consumed, wire.length);
});

test("decodeMessageParameter: FILL_PARAMETERS の内側 count 切り詰めは IncompleteDataError", () => {
  // Type Delta 0x23 のみで内側 Number of Parameters が存在しない
  const truncated = new Uint8Array([0x23]);
  assert.throws(() => decodeMessageParameter(truncated, 0, 0n), IncompleteDataError);
});

test("decodeMessageParameter: self-length-prefixed 分岐の Length 宣言超過で MALFORMED_MESSAGE", () => {
  // SUBGROUP_FILTER (0x25) + Length 5 宣言 + 2 バイトの切り詰め
  // (LOCATION_FILTER は v22 で Length を持たないため、Length を持つ Range Filter で
  //  self-length-prefixed 分岐の残量検証を固定する)
  const truncated = new Uint8Array([0x25, 0x05, 0xaa, 0xbb]);
  const thrown = captureThrownError(() => decodeMessageParameter(truncated, 0, 0n));
  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.MALFORMED_MESSAGE);
  assert.match(
    (thrown as ProtocolViolationError).message,
    /filter value length exceeds remaining data/,
  );
});

test("decodeMessageParameter: location-filter 分岐の不正 Type で INVALID_PARAMETER", () => {
  // LOCATION_FILTER (0x21) + Location Filter Type 0x06 (未定義)
  const invalid = new Uint8Array([0x21, 0x06]);
  const thrown = captureThrownError(() => decodeMessageParameter(invalid, 0, 0n));
  assert.instanceOf(thrown, ProtocolViolationError);
  // §9.19.9 の MUST により INVALID_PARAMETER で閉じる
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.INVALID_PARAMETER);
  assert.match((thrown as ProtocolViolationError).message, /unknown location filter type: 0x6/);
});

test("decodeMessageParameter: location-filter 分岐の値は Type とフィールドで確定する", () => {
  // LOCATION_FILTER (0x21) + Type 0x03 (Absolute Start, Group End) +
  // StartGroup 1 + StartObject 2 + EndGroupDelta 3 + 続く GROUP_ORDER (delta 1 /
  // 値 0x01)。続くパラメータを置くことで、次の Type Delta の位置が Type と
  // フィールド数だけで決まること (Length フィールドを読んでいないこと) を固定する
  const data = new Uint8Array([0x21, 0x03, 0x01, 0x02, 0x03, 0x01, 0x01]);
  const [param, consumed] = decodeMessageParameter(data, 0, 0n);
  assert.equal(param.type, 0x21);
  // LOCATION_FILTER 分 (5 バイト) だけを消費し、GROUP_ORDER の分は残す
  assert.equal(consumed, 5);
  assert.deepEqual(param.value, new Uint8Array([0x03, 0x01, 0x02, 0x03]));
  assert.deepEqual(decodeLocationFilterParameter(param), {
    startGroup: 1n,
    startObject: 2n,
    endGroupDelta: 3n,
  });
  const [next, nextConsumed] = decodeMessageParameter(data, consumed, 0x21n);
  assert.equal(next.type, 0x22);
  assert.equal(nextConsumed, 2);
});

test("decodeMessageParameter: location-filter 分岐のフィールド切り詰めは IncompleteDataError", () => {
  // LOCATION_FILTER (0x21) + Type 0x02 (Absolute Start) + StartGroup のみ
  const truncated = new Uint8Array([0x21, 0x02, 0x01]);
  assert.throws(() => decodeMessageParameter(truncated, 0, 0n), IncompleteDataError);
});

test("decodeMessageParameter: track-namespace 分岐の Field Length 宣言超過で MALFORMED_MESSAGE", () => {
  // TRACK_NAMESPACE_PREFIX (0x34) + フィールド数 2 宣言 + Field Length 4 宣言 +
  // Value 1 バイトの切り詰め。残量検証は decodeTrackNamespace に委譲する
  const truncated = new Uint8Array([0x34, 0x02, 0x04, 0xaa]);
  const thrown = captureThrownError(() => decodeMessageParameter(truncated, 0, 0n));
  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.MALFORMED_MESSAGE);
  assert.match(
    (thrown as ProtocolViolationError).message,
    /track namespace field length exceeds remaining data/,
  );
});

/**
 * draft-ietf-moq-transport-23 §9.10 (PUBLISH_STATE_NOTIFY):
 * 同じ内容の LOCATION_FILTER が再報告された場合に再解決を避けるための
 * 等価判定を検証する。公開型はフィールドの有無で表現が変わるため、
 * フィールドの有無と値を突き合わせる。
 */
test("isSameLocationFilter: 同じフィールド構成と値なら等価", () => {
  assert.isTrue(isSameLocationFilter(undefined, undefined));
  assert.isTrue(isSameLocationFilter({ reset: true }, { reset: true }));
  assert.isTrue(isSameLocationFilter({ startGroup: 1n }, { startGroup: 1n }));
  assert.isTrue(
    isSameLocationFilter({ startGroup: 1n, startObject: 2n }, { startGroup: 1n, startObject: 2n }),
  );
  assert.isTrue(
    isSameLocationFilter(
      { startGroup: 1n, startObject: 2n, endGroupDelta: 3n },
      { startGroup: 1n, startObject: 2n, endGroupDelta: 3n },
    ),
  );
  assert.isTrue(
    isSameLocationFilter(
      { startGroup: 1n, startObject: 2n, endGroupDelta: 3n, endObject: 4n },
      { startGroup: 1n, startObject: 2n, endGroupDelta: 3n, endObject: 4n },
    ),
  );
  assert.isTrue(isSameLocationFilter({ nextObject: true }, { nextObject: true }));
});

test("isSameLocationFilter: フィールドの有無または値が違えば非等価", () => {
  // 未設定と設定済みは非等価
  assert.isFalse(isSameLocationFilter(undefined, { startGroup: 1n }));
  assert.isFalse(isSameLocationFilter({ startGroup: 1n }, undefined));
  // reset (Type 0x00) とフィールドありは非等価
  assert.isFalse(isSameLocationFilter({ reset: true }, { startGroup: 0n }));
  assert.isFalse(isSameLocationFilter({ startGroup: 0n }, { reset: true }));
  // Next Object は絶対位置 {0, 0} (Type 0x02) と非等価
  assert.isFalse(isSameLocationFilter({ nextObject: true }, { startGroup: 0n, startObject: 0n }));
  assert.isFalse(isSameLocationFilter({ startGroup: 0n, startObject: 0n }, { nextObject: true }));
  assert.isFalse(isSameLocationFilter({ nextObject: true }, { reset: true }));
  // 値の差
  assert.isFalse(isSameLocationFilter({ startGroup: 1n }, { startGroup: 2n }));
  // フィールド数の差 (2 フィールドと 3 フィールド)
  assert.isFalse(
    isSameLocationFilter(
      { startGroup: 1n, startObject: 0n },
      { startGroup: 1n, startObject: 0n, endGroupDelta: 0n },
    ),
  );
  // 3 フィールドと 4 フィールド
  assert.isFalse(
    isSameLocationFilter(
      { startGroup: 1n, startObject: 0n, endGroupDelta: 0n },
      { startGroup: 1n, startObject: 0n, endGroupDelta: 0n, endObject: 0n },
    ),
  );
  // endObject の値の差
  assert.isFalse(
    isSameLocationFilter(
      { startGroup: 1n, startObject: 0n, endGroupDelta: 0n, endObject: 5n },
      { startGroup: 1n, startObject: 0n, endGroupDelta: 0n, endObject: 6n },
    ),
  );
});

/**
 * draft-ietf-moq-transport-23 §9.19 / §15.5:
 * Message Parameter の個々の Value 長に上限はなく、制御メッセージ全体の長さ
 * (MAX_CONTROL_MESSAGE_SIZE) だけが上限である。§8.3 の 2^16-1 上限は
 * Key-Value-Pair の規則であり、Message Parameter には適用しない。
 */
test("Message Parameter: 65535 バイトを超える length-prefixed 値を往復できる", () => {
  // AUTHORIZATION TOKEN (0x03) は length-prefixed。70000 バイトの Value を往復する
  const value = new Uint8Array(70000).fill(0x5a);
  const encoded = encodeParameters([{ type: 0x03, value }]);
  const [decoded, consumed] = decodeParameters(encoded);

  assert.equal(decoded.length, 1);
  assert.equal(decoded[0]?.type, 0x03);
  assert.deepEqual(decoded[0]?.value, value);
  assert.equal(consumed, encoded.length);
});

/**
 * draft-ietf-moq-transport-23 §9.19 / §15.5:
 * self-length-prefixed な Value (内側に Length を持つ) も同じく、メッセージ全体長
 * だけが上限である。
 */
test("Message Parameter: 65535 バイトを超える self-length-prefixed 値を往復できる", () => {
  // SUBGROUP_FILTER (0x25) は self-length-prefixed。内側 Length 70000 の Value を往復する
  const inner = new Uint8Array(70000).fill(0x33);
  const value = new Uint8Array(encodeVarint(70000).length + inner.length);
  value.set(encodeVarint(70000), 0);
  value.set(inner, encodeVarint(70000).length);
  const encoded = encodeParameters([{ type: 0x25, value }]);
  const [decoded, consumed] = decodeParameters(encoded);

  assert.equal(decoded.length, 1);
  assert.equal(decoded[0]?.type, 0x25);
  assert.deepEqual(decoded[0]?.value, value);
  assert.equal(consumed, encoded.length);
});

/**
 * draft-ietf-moq-transport-23 §8.3:
 * Key-Value-Pair (Setup Option / Property) の Value 上限 2^16-1 は維持する。
 * 超過する値を送信しようとした場合は、受信側が FIELD_LENGTH_EXCEEDED で
 * セッションを閉じるため、送信前に拒否する。
 */
test("Key-Value-Pair: 65535 バイトを超える奇数型の Value は送信できない", () => {
  let thrown: Error | undefined;
  try {
    encodeKeyValuePairs([{ type: 0x0f, value: new Uint8Array(65536) }]);
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.match(thrown?.message ?? "", /exceeds maximum 65535/);
});

/**
 * draft-ietf-moq-transport-23 §8.3:
 * 受信側でも Key-Value-Pair の Value 上限 2^16-1 を検査する。
 * 65536 バイトを宣言する Setup Option は FIELD_LENGTH_EXCEEDED で受信時に拒否する。
 */
test("Key-Value-Pair: 65535 バイトを超える Value は FIELD_LENGTH_EXCEEDED で受信できない", () => {
  // 奇数型 (0x0f) の Length 65536 を宣言する KVP を手組みする
  // (Setup Options はカウントプレフィックスを持たない)
  const encoded = concatUint8Arrays([
    encodeVarint(0x0f),
    encodeVarint(65536),
    new Uint8Array(65536),
  ]);

  let thrown: Error | undefined;
  try {
    decodeKeyValuePairs(encoded);
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.FIELD_LENGTH_EXCEEDED);
});

// ============================================================================
// draft-ietf-moq-transport-23 §8.3 / §8.7 / §9.19 / §12.2:
// 受信データから到達するエラーコードの分類
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §8.7 / §12.2:
 * Track Namespace の Field Length 0 と 32 フィールド超は
 * INVALID_TRACK_NAMESPACE、4,096 バイト超は FIELD_LENGTH_EXCEEDED になる。
 * 実際のワイヤから到達することを検証する。
 */
test("decodeTrackNamespace: Field Length 0 と 33 フィールドは INVALID_TRACK_NAMESPACE になる", () => {
  const zeroLengthField = concatUint8Arrays([encodeVarint(1n), encodeVarint(0n)]);
  const zeroThrown = captureThrownError(() => decodeTrackNamespace(zeroLengthField, 0));
  assert.instanceOf(zeroThrown, ProtocolViolationError);
  assert.equal(
    (zeroThrown as ProtocolViolationError).code,
    SessionErrorCode.INVALID_TRACK_NAMESPACE,
  );

  const tooManyFields = buildTrackNamespaceWire(MAX_TRACK_NAMESPACE_FIELDS + 1);
  const countThrown = captureThrownError(() => decodeTrackNamespace(tooManyFields, 0));
  assert.instanceOf(countThrown, ProtocolViolationError);
  assert.equal(
    (countThrown as ProtocolViolationError).code,
    SessionErrorCode.INVALID_TRACK_NAMESPACE,
  );
});

test("decodeTrackNamespace: 4,096 バイト超の Track Namespace は FIELD_LENGTH_EXCEEDED になる", () => {
  const countBytes = encodeVarint(1n);
  const lengthBytes = encodeVarint(BigInt(MAX_TRACK_NAMESPACE_SIZE + 1));
  const wire = concatUint8Arrays([
    countBytes,
    lengthBytes,
    new Uint8Array(MAX_TRACK_NAMESPACE_SIZE + 1),
  ]);
  const thrown = captureThrownError(() => decodeTrackNamespace(wire, 0));
  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.FIELD_LENGTH_EXCEEDED);
});

test("validateFullTrackNameBytes: 4,096 バイト超の Full Track Name は FIELD_LENGTH_EXCEEDED になる", () => {
  const namespace = createTrackNamespace(["a".repeat(MAX_TRACK_NAMESPACE_SIZE)]);
  const thrown = captureThrownError(() =>
    validateFullTrackNameBytes(namespace, new Uint8Array([0x61])),
  );
  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.FIELD_LENGTH_EXCEEDED);
});

/**
 * draft-ietf-moq-transport-23 §8.3 / §12.2:
 * Setup Option の Key-Value-Pair でも、奇数 Type の Length が 2^16-1 を超えると
 * FIELD_LENGTH_EXCEEDED、delta type の累積が 2^64-1 を超えると
 * DELTA_ENCODING_OVERFLOW になる。§12.2 の優先順位により他のコードより優先する。
 */
test("decodeKeyValuePairs: Length 上限超過は FIELD_LENGTH_EXCEEDED、delta 累積超過は DELTA_ENCODING_OVERFLOW になる", () => {
  // 最初の KVP: delta type 0x0D (奇数)、Length 65536
  const lengthOverflow = concatUint8Arrays([encodeVarint(0x0dn), encodeVarint(65536n)]);
  const lengthThrown = captureThrownError(() => decodeKeyValuePairs(lengthOverflow, 0));
  assert.instanceOf(lengthThrown, ProtocolViolationError);
  assert.equal(
    (lengthThrown as ProtocolViolationError).code,
    SessionErrorCode.FIELD_LENGTH_EXCEEDED,
  );

  // 最初の KVP: Type MAX_VARINT (奇数)、Length 0。次の delta 1 で累積が 2^64 になる
  const deltaOverflow = concatUint8Arrays([
    encodeVarint(MAX_VARINT),
    encodeVarint(0n),
    encodeVarint(1n),
  ]);
  const deltaThrown = captureThrownError(() => decodeKeyValuePairs(deltaOverflow, 0));
  assert.instanceOf(deltaThrown, ProtocolViolationError);
  assert.equal(
    (deltaThrown as ProtocolViolationError).code,
    SessionErrorCode.DELTA_ENCODING_OVERFLOW,
  );
});

test("decodeMessageParameter: delta type の累積超過は DELTA_ENCODING_OVERFLOW になる", () => {
  // 直前の Type が MAX_VARINT の状態で delta 1 を読むと累積が 2^64 になる。
  // Type Delta の累積超過は値の解釈より前に判定するため、値は不要である。
  const wire = encodeVarint(1n);
  const thrown = captureThrownError(() => decodeMessageParameter(wire, 0, MAX_VARINT));
  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, SessionErrorCode.DELTA_ENCODING_OVERFLOW);
});
