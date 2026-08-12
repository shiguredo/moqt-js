/**
 * MOQT Parameter Unit Tests
 * draft-ietf-moq-transport-19 Section 10.2 (Message Parameter)
 */

import { test, assert } from "vite-plus/test";
import {
  createTrackNamespace,
  decodeLocationFilter,
  decodeLocationFilterParameter,
  decodeTrackNamespace,
  encodeParameters,
  decodeParameters,
  decodeKeyValuePairs,
  decodeMessageParameter,
  encodeUint8ParameterValue,
  encodeTrackName,
  encodeTrackNamespace,
  validateTrackNameSize,
  MAX_TRACK_NAME_SIZE,
  MAX_TRACK_NAMESPACE_SIZE,
  isRejectedReceiveNamespace,
} from "./parameter";
import { ProtocolViolationError } from "../error";
import { encodeVarint, MAX_VARINT } from "../varint";

test("無効なパラメータタイプでエラー", () => {
  const invalidParam = { type: 0x20, value: new Uint8Array([0x01]) };
  assert.throws(() => decodeLocationFilterParameter(invalidParam), "Invalid parameter type");
});

test("無効なフィルタタイプで ProtocolViolationError", () => {
  const invalidData = new Uint8Array([0x10]);
  assert.throws(() => decodeLocationFilter(invalidData), ProtocolViolationError);
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
