/**
 * MOQT Parameter Unit Tests
 * draft-ietf-moq-transport-19 Section 10.2 (Message Parameter)
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
  decodeKeyValuePairs,
  decodeMessageParameter,
  decodeRangeFilter,
  encodeRangeFilter,
  validateRangeFilterCombination,
  validateFullTrackNameBytes,
  encodeUint8ParameterValue,
  encodeTrackName,
  encodeTrackNamespace,
  validateTrackNameSize,
  MAX_TRACK_NAME_SIZE,
  MAX_TRACK_NAMESPACE_SIZE,
  MAX_FULL_TRACK_NAME_SIZE,
  isRejectedReceiveNamespace,
} from "./parameter";
import { InvalidFilterError, ProtocolViolationError } from "../error";
import { encodeVarint, MAX_VARINT } from "../varint";

test("無効なパラメータタイプでエラー", () => {
  const invalidParam = { type: 0x20, value: new Uint8Array([0x01]) };
  assert.throws(() => decodeLocationFilterParameter(invalidParam), "Invalid parameter type");
});

/**
 * フィールド数 0 を表す Length 0 (バイト列 [0x00]) は reset としてデコードされ、
 * エンコードも Length 0 に戻る (REQUEST_UPDATE でのフィルタ除去のワイヤ)。
 */
test("decodeLocationFilter: Length 0 は reset として round-trip する", () => {
  const encoded = encodeLocationFilter({ reset: true });
  assert.deepEqual(encoded, new Uint8Array([0x00]));
  const [filter, consumed] = decodeLocationFilter(encoded);
  assert.deepEqual(filter, { reset: true });
  assert.equal(consumed, encoded.length);
});

/**
 * 1 フィールド (StartGroup のみ) は相対指定。Length は StartGroup のバイト長。
 */
test("decodeLocationFilter: 1 フィールド (StartGroup) が round-trip する", () => {
  const filter: LocationFilter = { startGroup: 3n };
  const encoded = encodeLocationFilter(filter);
  // 先頭バイトが Length = 1 (StartGroup は 1 バイトで表現可能)
  assert.equal(encoded[0], 1);
  const [decoded, consumed] = decodeLocationFilter(encoded);
  assert.deepEqual(decoded, filter);
  assert.equal(consumed, encoded.length);
});

/**
 * 2 フィールド (StartGroup + StartObject) は絶対開始または Next Object。
 * Length は 2 つの vi64 の合計バイト長であり、フィールド数そのものではない
 * (Length=2 を「2 フィールド」と解釈しない)。
 */
test("decodeLocationFilter: 2 フィールド (StartGroup + StartObject) が round-trip する", () => {
  const filter: LocationFilter = { startGroup: 5n, startObject: 7n };
  const encoded = encodeLocationFilter(filter);
  const [decoded, consumed] = decodeLocationFilter(encoded);
  assert.deepEqual(decoded, filter);
  assert.equal(consumed, encoded.length);
});

/**
 * 3 フィールド (StartGroup + StartObject + EndGroupDelta) が round-trip する。
 */
test("decodeLocationFilter: 3 フィールド (EndGroupDelta あり) が round-trip する", () => {
  const filter: LocationFilter = { startGroup: 5n, startObject: 7n, endGroupDelta: 3n };
  const encoded = encodeLocationFilter(filter);
  const [decoded, consumed] = decodeLocationFilter(encoded);
  assert.deepEqual(decoded, filter);
  assert.equal(consumed, encoded.length);
});

/**
 * 4 フィールド (StartGroup + StartObject + EndGroupDelta + EndObject) が
 * round-trip する。
 */
test("decodeLocationFilter: 4 フィールド (EndObject あり) が round-trip する", () => {
  const filter: LocationFilter = {
    startGroup: 5n,
    startObject: 7n,
    endGroupDelta: 3n,
    endObject: 9n,
  };
  const encoded = encodeLocationFilter(filter);
  const [decoded, consumed] = decodeLocationFilter(encoded);
  assert.deepEqual(decoded, filter);
  assert.equal(consumed, encoded.length);
});

/**
 * 3/4 フィールドで End Group (StartGroup + EndGroupDelta) が 2^64-1 を超える
 * 受信データは draft-ietf-moq-transport-20 §5.1.2 の MUST
 * 「If StartGroup + EndGroupDelta exceeds 2^64 - 1, the endpoint MUST close
 *  the session with a PROTOCOL_VIOLATION.」に従い ProtocolViolationError で
 * 拒否される。
 */
test("decodeLocationFilter: End Group が 2^64-1 を超えると ProtocolViolationError", () => {
  // StartGroup=MAX_VARINT + StartObject=0 + EndGroupDelta=1
  // End Group = MAX_VARINT + 1 で 2^64-1 超過
  const fields = [...encodeVarint(MAX_VARINT), ...encodeVarint(0n), ...encodeVarint(1n)];
  const data = new Uint8Array([...encodeVarint(BigInt(fields.length)), ...fields]);
  assert.throws(() => decodeLocationFilter(data), ProtocolViolationError);
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
test("decodeLocationFilter: Group が 1 以上で End Group Delta が単体最大なら ProtocolViolationError", () => {
  // StartGroup=1 + StartObject=0 + EndGroupDelta=MAX_VARINT
  // End Group = 1 + MAX_VARINT で 2^64-1 超過
  const fields = [...encodeVarint(1n), ...encodeVarint(0n), ...encodeVarint(MAX_VARINT)];
  const data = new Uint8Array([...encodeVarint(BigInt(fields.length)), ...fields]);
  assert.throws(() => decodeLocationFilter(data), ProtocolViolationError);
});

/**
 * 送信側でも同一規則を適用する。End Group が 2^64-1 を超える 3/4 フィールド
 * 表現は受信した endpoint を PROTOCOL_VIOLATION でセッション終了させるため、
 * encodeLocationFilter が InvalidFilterError で送信前に throw する (§5.1.2)。
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
 * Length が示す範囲に 4 つより多くの vi64 フィールドが含まれる場合
 * (Length が 4 フィールドの消費バイト数を超えて余りが残る) は
 * PROTOCOL_VIOLATION で拒否される。
 * 例: Length=5 に 1 バイト varint を 5 個詰めたワイヤ (フィールド数 5)。
 */
test("decodeLocationFilter: フィールド数 4 超の Length は ProtocolViolationError", () => {
  // Length=5 + 1 バイト varint × 5 = フィールド 5 個
  const data = new Uint8Array([5, 0, 0, 0, 0, 0]);
  assert.throws(() => decodeLocationFilter(data), ProtocolViolationError);
});

/**
 * vi64 フィールドが Length 境界を跨ぐ場合 (Length が示すバイト数と実際の
 * フィールド消費バイト数が不一致) は PROTOCOL_VIOLATION で拒否される。
 * 例: Length=1 に対して 2 バイト必要な varint (0x80 0x00) を 1 個置いたワイヤ。
 */
test("decodeLocationFilter: Length と消費バイト数の不一致は ProtocolViolationError", () => {
  // Length=1 + 2 バイト varint (0x80 0x00)。Length 境界を跨ぐ
  const data = new Uint8Array([1, 0x80, 0x00]);
  assert.throws(() => decodeLocationFilter(data), ProtocolViolationError);
});

/**
 * Length が data の末尾を超える場合は不完全データとして扱う。
 * (IncompleteDataError。decodeVarint と同じ「次のチャンクを待つ」意味論)
 */
test("decodeLocationFilter: Length が data の末尾を超えると IncompleteDataError", () => {
  // Length=2 に対して StartGroup のみ (1 バイト) しか無い
  const data = new Uint8Array([2, 0]);
  assert.throws(() => decodeLocationFilter(data), "incomplete location filter");
});

/**
 * Length 境界内の vi64 が data 末尾で切れるケース (Length は data 末尾まで
 * 一致するが、varint が 2 バイト目を要求して足りない) は「次のチャンク待ち」
 * ではなく Length との不一致による構造不正であり、ProtocolViolationError で
 * 拒否される (IncompleteDataError をそのまま漏らさない)。
 */
test("decodeLocationFilter: Length 境界内の varint が data 末尾で切れると ProtocolViolationError", () => {
  // Length=1 + 2 バイト必要な varint (0x80) が data 末尾で切れる
  const data = new Uint8Array([1, 0x80]);
  assert.throws(() => decodeLocationFilter(data), ProtocolViolationError);
});

/**
 * draft-ietf-moq-transport-20 §5.1.2: LOCATION_FILTER のワイヤは
 * [Type Delta=0x21][Length][fields...] の単一 Length 構造。
 * Appendix A.1 (#1809) で「match the other filter parameters」と再構成されて
 * おり、Range Filter (0x25-0x29) と同じ 1 Length 形式である。外側に Length を
 * 付加して二重 Length にならないことをパラメータ全体のバイト列で固定する。
 */
test("LOCATION_FILTER パラメータはワイヤ上 1 Length 構造で round-trip する", () => {
  const params = [encodeLocationFilterParameter({ startGroup: 3n })];
  const encoded = encodeParameters(params);
  // count=1, Type Delta=0x21, Length=1, StartGroup=3
  assert.deepEqual(encoded, new Uint8Array([1, 0x21, 0x01, 0x03]));
  const [decoded, consumed] = decodeParameters(encoded);
  assert.equal(consumed, encoded.length);
  assert.equal(decoded.length, 1);
  assert.deepEqual(decodeLocationFilterParameter(decoded[0]), { startGroup: 3n });
});

/**
 * reset (Length 0) も同様に単一 Length 構造でワイヤ化される。
 * [Type Delta=0x21][Length=0] (REQUEST_UPDATE でのフィルタ除去のワイヤ)。
 */
test("LOCATION_FILTER reset はワイヤ上 Length=0 で round-trip する", () => {
  const params = [encodeLocationFilterParameter({ reset: true })];
  const encoded = encodeParameters(params);
  // count=1, Type Delta=0x21, Length=0
  assert.deepEqual(encoded, new Uint8Array([1, 0x21, 0x00]));
  const [decoded, consumed] = decodeParameters(encoded);
  assert.equal(consumed, encoded.length);
  assert.equal(decoded.length, 1);
  assert.deepEqual(decodeLocationFilterParameter(decoded[0]), { reset: true });
});

/**
 * delta encoding のテスト
 * draft-ietf-moq-transport-19 Section 1.4.3 (Key-Value-Pair Structure):
 * https://www.ietf.org/archive/id/draft-ietf-moq-transport-19.html#section-1.4.3
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

test("空の Parameters リストのエンコード・デコード", () => {
  const params: { type: number; value: Uint8Array }[] = [];
  const encoded = encodeParameters(params);
  const [decoded, consumed] = decodeParameters(encoded);

  assert.equal(decoded.length, 0);
  assert.equal(consumed, encoded.length);
});

test("uint8 Message Parameter Value を 1 バイトでエンコードする", () => {
  const params = [
    { type: 0x10, value: encodeUint8ParameterValue(1, "FORWARD") },
    { type: 0x20, value: encodeUint8ParameterValue(255, "SUBSCRIBER_PRIORITY") },
    { type: 0x22, value: encodeUint8ParameterValue(2, "GROUP_ORDER") },
  ];

  const encoded = encodeParameters(params);

  assert.deepEqual([...encoded], [3, 0x10, 1, 0x10, 255, 0x02, 2]);
});

test("uint8 Message Parameter Value は範囲外を拒否する", () => {
  assert.throws(
    () => encodeUint8ParameterValue(256, "SUBSCRIBER_PRIORITY"),
    /invalid SUBSCRIBER_PRIORITY value: 256, expected 0\.\.255/,
  );
});

/**
 * Track Namespace / Full Track Name のサイズ制限テスト
 * draft-ietf-moq-transport-19:
 * Track Namespace と Full Track Name は最大 4,096 バイト。
 * draft-ietf-moq-transport-19 Section 10.2
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
  // draft-ietf-moq-transport-19 §2.3:
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

test("validateTrackNameSize で制限を超えるとエラー", () => {
  const largeBytes = new Uint8Array(5000);
  assert.throws(() => validateTrackNameSize(largeBytes), /track name exceeds maximum size/);
});

test("validateTrackNameSize で制限内なら成功", () => {
  const normalBytes = new Uint8Array(4000);
  // エラーが投げられなければ成功
  validateTrackNameSize(normalBytes);
});

/**
 * draft-ietf-moq-transport-19 §2.4.1:
 * 「The length of a Full Track Name is computed as the sum of the Track
 *  Namespace Field Length fields and the Track Name Length field.」
 * Full Track Name の合計が 4,096 バイトを超えると ProtocolViolationError に
 * なることを検証する。
 * namespace 単体は 4,096 未満に収め、Track Name を足して合計 4,097 にする
 * (namespace 単体が 4,096 超のケースは decodeTrackNamespace の既存検証が先に
 * throw するため)。
 */
test("validateFullTrackNameBytes: 合計 4,097 バイトで ProtocolViolationError", () => {
  const namespace = createTrackNamespace(["a".repeat(4000)]);
  const trackName = new TextEncoder().encode("a".repeat(97));

  assert.throws(() => validateFullTrackNameBytes(namespace, trackName), ProtocolViolationError);
});

/**
 * draft-ietf-moq-transport-19 §2.4.1:
 * Full Track Name の合計が 4,096 バイトちょうどは違反にならないことを検証する。
 */
test("validateFullTrackNameBytes: 合計 4,096 バイトちょうどは違反にならない", () => {
  const namespace = createTrackNamespace(["a".repeat(4000)]);
  const trackName = new TextEncoder().encode("a".repeat(96));

  validateFullTrackNameBytes(namespace, trackName);
});

/**
 * draft-ietf-moq-transport-19 §2.4.1:
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
 * 未知 Message Parameter 受信時の PROTOCOL_VIOLATION テスト
 * draft-ietf-moq-transport-19 Section 10.2:
 * "An endpoint that receives an unknown Message Parameter MUST close
 *  the session with PROTOCOL_VIOLATION."
 */
test("未知のパラメータタイプで ProtocolViolationError", () => {
  // type = 0xFE (未知), value = 0x01 (varint)
  const countBytes = encodeVarint(1n);
  const deltaTypeBytes = encodeVarint(0xfen);
  const valueBytes = encodeVarint(1n);
  const data = new Uint8Array(countBytes.length + deltaTypeBytes.length + valueBytes.length);
  data.set(countBytes, 0);
  data.set(deltaTypeBytes, countBytes.length);
  data.set(valueBytes, countBytes.length + deltaTypeBytes.length);

  assert.throws(() => decodeParameters(data), /unknown message parameter type/);
});

/**
 * 重複 Message Parameter 検出の SHOULD テスト
 * draft-ietf-moq-transport-19 Section 10.2:
 * "Receivers SHOULD check that there are no unexpected duplicate parameters
 *  and close the session with PROTOCOL_VIOLATION if found."
 */
test("重複パラメータで ProtocolViolationError", () => {
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

  assert.throws(() => decodeParameters(data), /duplicate message parameter type/);
});

/**
 * draft-ietf-moq-transport-19 Section 1.4.3:
 * "The previous Type value plus the Delta Type MUST NOT be greater than
 *  2^64 - 1. If a Delta Type is received that would be too large, the
 *  Session MUST be closed with a PROTOCOL_VIOLATION."
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
 * draft-ietf-moq-transport-19 Section 1.4.3:
 * 加算結果が 2^64-1 を超える (previousType=2^64-1 + deltaType=1) 場合は
 * ProtocolViolationError になることを検証する。
 */
test("decodeKeyValuePairs: 加算結果が 2^64-1 を超えると ProtocolViolationError", () => {
  // 1 個目: deltaType = 2^64-1 (奇数型)、length (0) + 空バイト列
  // 2 個目: deltaType = 1 → previousType + 1 = 2^64 > 2^64-1
  const data = new Uint8Array([
    ...encodeVarint(MAX_VARINT),
    ...encodeVarint(0n),
    ...encodeVarint(1n),
  ]);

  assert.throws(() => decodeKeyValuePairs(data), ProtocolViolationError);
});

/**
 * draft-ietf-moq-transport-19 Section 1.4.3:
 * Message Parameter の deltaType 加算でも 2^64-1 超過は ProtocolViolationError
 * になることを検証する。
 * decodeParameters は Number of Parameters プレフィックス付きのため、
 * 先頭にパラメータ数を付加する。
 * 2 個目の deltaType を 2^64-1 とし、1 個目の type (0x02) との加算結果を
 * 2^64 にすることで超過を直接検証する。
 */
test("decodeParameters: deltaType 加算結果が 2^64-1 を超えると ProtocolViolationError", () => {
  // 1 個目: deltaType = 0x02 (OBJECT_DELIVERY_TIMEOUT、varint 型) + value
  // 2 個目: deltaType = 2^64-1 → 0x02 + 2^64-1 = 2^64+1 > 2^64-1
  const data = new Uint8Array([
    ...encodeVarint(2n),
    ...encodeVarint(0x02n),
    ...encodeVarint(100n),
    ...encodeVarint(MAX_VARINT),
  ]);

  // 加算検証のエラーメッセージを特定して検証する。
  // 仮に加算検証を除去しても 2^64+1 は未知型として同じクラスの
  // ProtocolViolationError が投げられるため、メッセージで加算パスを特定する
  assert.throws(() => decodeParameters(data), /delta type addition exceeds maximum/);
});

/**
 * draft-ietf-moq-transport-19 Section 5.1.3 (Range Filters):
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
 * draft-ietf-moq-transport-19 Section 5.1.3 (Range Filters):
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
 * draft-ietf-moq-transport-19 Section 5.1.3 (Range Filters):
 * REQUEST_UPDATE での Range Filter 削除は「Type Delta + 0x00」の 1 Length 構造になる。
 */
test("encodeParameters: Range Filter の削除は Length=0 の 1 Length 構造になる", () => {
  // 削除は Length = 0 のみ (encodeRangeFilter の remove 指定で生成される value)
  const param = { type: 0x25, value: new Uint8Array([0x00]) };
  const encoded = encodeParameters([param]);

  assert.deepEqual(encoded, new Uint8Array([0x01, 0x25, 0x00]));
});

/**
 * draft-ietf-moq-transport-19 Section 5.1.3 (Range Filters):
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
 * draft-ietf-moq-transport-19 Section 5.1.3 (Range Filters):
 * Range Filter の内側 Length が残りバイト数を超える不正ワイヤをデコードすると
 * ProtocolViolationError になることを検証する。
 */
test("decodeMessageParameter: Range Filter の内側 Length 超過で ProtocolViolationError", () => {
  // Length = 5 と宣言されているが残りバイトは 2 (SetID 1 + Start delta 3)
  const data = new Uint8Array([0x25, 0x05, 0x01, 0x03]);
  assert.throws(() => decodeMessageParameter(data, 0, 0n), ProtocolViolationError);
});

/**
 * draft-ietf-moq-transport-19 §10.2.12 (PRIORITY FILTER Parameter):
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
 * draft-ietf-moq-transport-19 §10.2.12:
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
 * draft-ietf-moq-transport-19 §10.2.13 (OBJECT PROPERTY FILTER Parameter):
 * Property Type は偶数でなければならず、奇数の場合は InvalidFilterError。
 */
test("decodeRangeFilter: OBJECT_PROPERTY_FILTER の奇数 Property Type で InvalidFilterError", () => {
  // Length 4 / SetID 1 / Property Type 3 (奇数) / Start delta 0 / End delta 0
  const data = new Uint8Array([0x04, 0x01, 0x03, 0x00, 0x00]);
  assert.throws(() => decodeRangeFilter("objectProperty", data), InvalidFilterError);
});

/**
 * draft-ietf-moq-transport-19 §5.1.3:
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
 * draft-ietf-moq-transport-19 §5.1.3:
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
 * draft-ietf-moq-transport-19 §5.1.3:
 * 構造不正 (Length > 0 なのに SetID / Property Type / Range 列の欠落) は
 * InvalidFilterError になることを検証する。
 */
test("decodeRangeFilter: SetID が欠落していると InvalidFilterError", () => {
  // Length 1 を宣言しているが body (SetID) が存在しない
  const data = new Uint8Array([0x01]);
  assert.throws(() => decodeRangeFilter("objectId", data), InvalidFilterError);
});

/**
 * draft-ietf-moq-transport-19 §5.1.3:
 * 構造不正 (Length > 0 なのに Range 列が欠落) は InvalidFilterError になる
 * ことを検証する。SetID のみで Range が 1 つもない構成。
 */
test("decodeRangeFilter: Range 列が欠落していると InvalidFilterError", () => {
  // Length 1 / SetID 1 のみで Range 列がない
  const data = new Uint8Array([0x01, 0x01]);
  assert.throws(() => decodeRangeFilter("objectId", data), InvalidFilterError);
});

/**
 * draft-ietf-moq-transport-19 §5.1.3:
 * 構造不正 (Property Type の欠落) は InvalidFilterError になることを検証する。
 */
test("decodeRangeFilter: Property Type が欠落していると InvalidFilterError", () => {
  // Length 1 / SetID 1 のみで Property Type がない (objectProperty は PT 必須)
  const data = new Uint8Array([0x01, 0x01]);
  assert.throws(() => decodeRangeFilter("objectProperty", data), InvalidFilterError);
});

/**
 * draft-ietf-moq-transport-19 §5.1.3:
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
 * draft-ietf-moq-transport-19 §5.1.3:
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
 * draft-ietf-moq-transport-19 §5.1.3:
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
 * draft-ietf-moq-transport-19 §10.2.13 / §10.2.14:
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
 * draft-ietf-moq-transport-19 §10.2.12:
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
 * draft-ietf-moq-transport-19 §5.1.3:
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
 * draft-ietf-moq-transport-19 §5.1.3:
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
 * draft-ietf-moq-transport-19 §5.1.3:
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
 * draft-ietf-moq-transport-19 Section 3.2.1 (Reserved Namespaces):
 * "A Track Namespace whose first field is exactly . (a single period,
 *  0x2e) is reserved and MUST NOT be used for any purpose; endpoints
 *  MUST NOT publish tracks or namespaces under it and MUST reject
 *  requests referencing it with DOES_NOT_EXIST."
 * draft-ietf-moq-transport-19 Section 3.2.2 (Session-Level Tracks and Namespaces):
 * "An endpoint that receives a request for an unrecognized session-level
 *  track or namespace MUST reject it with REQUEST_ERROR using error code
 *  DOES_NOT_EXIST rather than passing it to the Application."
 */
test("isRejectedReceiveNamespace: 先頭フィールドが .session なら拒否対象", () => {
  // §3.2.2: セッションレベルの名前空間は DOES_NOT_EXIST で拒否する
  assert.equal(isRejectedReceiveNamespace(createTrackNamespace([".session"]).tuple), true);
});

test("isRejectedReceiveNamespace: 先頭フィールドが .session で複数フィールドでも拒否対象", () => {
  // §3.2.2: セッションレベル名前空間の下の track も拒否対象
  assert.equal(isRejectedReceiveNamespace(createTrackNamespace([".session", "sub"]).tuple), true);
});

test("isRejectedReceiveNamespace: 先頭フィールドが . 単体なら拒否対象", () => {
  // §3.2.1: 先頭フィールドが "." (0x2e) 単体の名前空間は DOES_NOT_EXIST で拒否する
  assert.equal(isRejectedReceiveNamespace(createTrackNamespace(["."]).tuple), true);
  assert.equal(isRejectedReceiveNamespace(createTrackNamespace([".", "sub"]).tuple), true);
});

test("isRejectedReceiveNamespace: その他の予約名前空間 (.foo) は拒否しない", () => {
  // §3.2.1: 認識されない予約名前空間はアプリへ渡す (将来の拡張を壊さないため)
  assert.equal(isRejectedReceiveNamespace(createTrackNamespace([".foo"]).tuple), false);
  assert.equal(isRejectedReceiveNamespace(createTrackNamespace([".session2"]).tuple), false);
});

test("isRejectedReceiveNamespace: 通常の名前空間は拒否しない", () => {
  assert.equal(isRejectedReceiveNamespace(createTrackNamespace(["example"]).tuple), false);
  assert.equal(isRejectedReceiveNamespace(createTrackNamespace(["example", "sub"]).tuple), false);
});

test("isRejectedReceiveNamespace: 空の名前空間は拒否しない", () => {
  // 先頭フィールドが存在しないため §3.2.1 / §3.2.2 の対象外
  assert.equal(isRejectedReceiveNamespace([]), false);
});

test("isRejectedReceiveNamespace: 先頭フィールドが空バイト列なら拒否しない", () => {
  // 先頭フィールドが空 (. でも .session でもない) ため拒否対象外
  assert.equal(isRejectedReceiveNamespace([new Uint8Array(0)]), false);
});

test("isRejectedReceiveNamespace: . 単体をバイト列リテラルで判定する", () => {
  // §3.2.1 は 0x2e をバイト値で定義しているため、エンコーダに依存しない
  // バイト列直接の検証。0x2e を含む他のバイト列 (. 単体以外) は拒否しない
  assert.equal(isRejectedReceiveNamespace([new Uint8Array([0x2e])]), true);
  assert.equal(isRejectedReceiveNamespace([new Uint8Array([0x2e, 0x2e])]), false);
  assert.equal(isRejectedReceiveNamespace([new Uint8Array([0x2e, 0xff])]), false);
});

test("isRejectedReceiveNamespace: .session をバイト列リテラルで判定する", () => {
  // §3.2.2 は .session を 8 バイト (0x2e 0x73 0x65 0x73 0x73 0x69 0x6f
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
 * draft-ietf-moq-transport-20 §10.2.15:
 * FILL_PARAMETERS の encode / decode ラウンドトリップを検証する。
 * 内側は別メッセージの Parameters 列 (count-prefixed) として扱う。
 */
test("encodeFillParameters / decodeFillParameters: ラウンドトリップする", () => {
  const inner = [
    { type: 0x0a, value: encodeVarint(100n) },
    { type: 0x20, value: new Uint8Array([10]) },
    encodeLocationFilterParameter({ startGroup: 10n, startObject: 2n }),
    { type: 0x22, value: new Uint8Array([0x01]) },
  ];

  const param = encodeFillParameters(inner);
  assert.equal(param.type, 0x23);
  // Value は count-prefixed の Parameters 列そのもの
  // (外側 Length はワイヤエンコード時に付加される)
  assert.deepEqual(param.value, encodeParameters(inner));

  const decoded = decodeFillParameters(param);
  assert.equal(decoded.length, 4);
  assert.equal(decoded[0].type, 0x0a);
  assert.equal(decoded[1].type, 0x20);
  assert.equal(decoded[2].type, 0x21);
  assert.equal(decoded[3].type, 0x22);
});

/**
 * draft-ietf-moq-transport-20 §10.2.15:
 * Table 6 の一覧に無いパラメータを内側に含む FILL_PARAMETERS は
 * PROTOCOL_VIOLATION で拒否される。
 */
test("decodeFillParameters: 一覧外のパラメータを含むと ProtocolViolationError", () => {
  // FORWARD (0x10) は内側の一覧に無い
  const param = encodeFillParameters([{ type: 0x10, value: new Uint8Array([1]) }]);
  assert.throws(() => decodeFillParameters(param), ProtocolViolationError);
});

/**
 * draft-ietf-moq-transport-20 §10.2.15:
 * TRACK_PROPERTY_FILTER (0x29) は SUBSCRIBE_TRACKS 専用のため、fill の内側には
 * 載せられず PROTOCOL_VIOLATION で拒否される。
 */
test("decodeFillParameters: TRACK_PROPERTY_FILTER を含むと ProtocolViolationError", () => {
  const param = encodeFillParameters([{ type: 0x29, value: new Uint8Array([0x01, 0x00, 0x00]) }]);
  assert.throws(() => decodeFillParameters(param), ProtocolViolationError);
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
 * draft-ietf-moq-transport-20 §10.2.15:
 * 内側の除去 (Length=0) は一回限りの fill に意味を持たないため
 * InvalidFilterError で拒否される。
 */
test("decodeFillParameters: 内側の除去を含むと InvalidFilterError", () => {
  // SUBGROUP_FILTER の Length=0 (除去) を内側に含める
  const param = encodeFillParameters([{ type: 0x25, value: new Uint8Array([0x00]) }]);
  assert.throws(() => decodeFillParameters(param), InvalidFilterError);
});
