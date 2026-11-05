/**
 * MOQT データストリーム Fetch テスト
 * draft-ietf-moq-transport-23 Section 11.4.1 (Fetch Header)
 */

import { test, assert } from "vite-plus/test";
import {
  FetchHeaderType,
  type FetchHeader,
  encodeFetchHeader,
  decodeFetchHeader,
  FetchSerializationFlags,
  type FetchObjectFields,
  type FetchObjectContext,
  encodeFetchObjectFields,
  decodeFetchObjectFields,
  createFirstFetchObjectFlags,
  createFetchObjectFlags,
} from "./dataStream";
import { GroupOrder } from "./message/types";
import { encodeVarint, MAX_VARINT } from "./varint";
import {
  IncompleteDataError,
  MalformedTrackError,
  ProtocolViolationError,
  SessionError,
  SessionErrorCode,
} from "./error";
import { encodeProperties, MOQTPropertyId } from "./properties";
import { captureThrownError } from "./testSupport/helpers";

/**
 * FETCH データストリーム経路の ProtocolViolationError をコードとメッセージまで検証する
 *
 * @param fn - 例外を送出する処理
 * @param code - 期待する SessionErrorCode
 * @param messagePattern - 期待するメッセージ
 */
function assertFetchViolation(
  fn: () => unknown,
  code: SessionErrorCode,
  messagePattern: RegExp,
): void {
  const thrown = captureThrownError(fn);
  assert.instanceOf(thrown, ProtocolViolationError);
  assert.equal((thrown as ProtocolViolationError).code, code);
  assert.match((thrown as ProtocolViolationError).message, messagePattern);
}

test("FetchHeader: 基本的な FetchHeader をエンコード", () => {
  const header: FetchHeader = {
    type: FetchHeaderType,
    requestId: 42n,
  };

  const encoded = encodeFetchHeader(header);

  assert.equal(encoded[0], 0x05);
  assert.equal(encoded[1], 42);
  assert.equal(encoded.length, 2);
});

test("FetchHeader: 大きな requestId をエンコード", () => {
  const header: FetchHeader = {
    type: FetchHeaderType,
    requestId: 10000n,
  };

  const encoded = encodeFetchHeader(header);

  assert.equal(encoded[0], 0x05);
  assert.isAbove(encoded.length, 2);
});

test("FetchHeader: 基本的な FetchHeader をデコード", () => {
  const data = new Uint8Array([0x05, 0x2a]);
  const [header, consumed] = decodeFetchHeader(data);

  assert.equal(header.type, FetchHeaderType);
  assert.equal(header.requestId, 42n);
  assert.equal(consumed, 2);
});

test("FetchHeader: 無効な type でエラー", () => {
  const data = new Uint8Array([0x10, 0x01]);

  assert.throws(() => decodeFetchHeader(data), "invalid fetch header type");
});

const requestIds = [0n, 1n, 100n, 1000n, 10000n];

for (const requestId of requestIds) {
  test(`FetchHeader roundtrip: requestId=${requestId}`, () => {
    const header: FetchHeader = {
      type: FetchHeaderType,
      requestId,
    };

    const encoded = encodeFetchHeader(header);
    const [decoded, consumed] = decodeFetchHeader(encoded);

    assert.equal(decoded.type, FetchHeaderType);
    assert.equal(decoded.requestId, requestId);
    assert.equal(consumed, encoded.length);
  });
}

test("FetchObjectFields: createFirstFetchObjectFlags で Properties なしフラグを作成", () => {
  const flags = createFirstFetchObjectFlags(false);

  assert.isOk(flags & FetchSerializationFlags.GROUP_ID_PRESENT);
  assert.equal(
    flags & FetchSerializationFlags.SUBGROUP_MASK,
    FetchSerializationFlags.SUBGROUP_PRESENT,
  );
  assert.isOk(flags & FetchSerializationFlags.OBJECT_ID_PRESENT);
  assert.isOk(flags & FetchSerializationFlags.PRIORITY_PRESENT);
  assert.isNotOk(flags & FetchSerializationFlags.PROPERTIES_PRESENT);
});

test("FetchObjectFields: createFirstFetchObjectFlags で Properties ありフラグを作成", () => {
  const flags = createFirstFetchObjectFlags(true);

  assert.isOk(flags & FetchSerializationFlags.PROPERTIES_PRESENT);
});

test("FetchObjectFields: 最初のオブジェクトをエンコード", () => {
  const flags = createFirstFetchObjectFlags(false);
  const fields: FetchObjectFields = {
    serializationFlags: flags,
    groupId: 5n,
    subgroupId: 2n,
    objectId: 10n,
    publisherPriority: 64,
    payloadLength: 50n,
  };

  const encoded = encodeFetchObjectFields(fields);

  assert.equal(encoded[0], flags);
  assert.equal(encoded[1], 5);
  assert.equal(encoded[2], 2);
  assert.equal(encoded[3], 10);
  assert.equal(encoded[4], 64);
  assert.equal(encoded[5], 50);
});

// draft-ietf-moq-transport-23 Section 11.1.1:
// "The Object Status is a field that is only present in objects that are
// delivered via a SUBSCRIPTION, and is absent in Objects delivered via a FETCH."
test("FetchObjectFields: payload length = 0 でも Object Status を含めない", () => {
  const flags = createFirstFetchObjectFlags(false);
  const fields: FetchObjectFields = {
    serializationFlags: flags,
    groupId: 1n,
    subgroupId: 0n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 0n,
  };

  const encoded = encodeFetchObjectFields(fields);
  // Payload Length (0) の後に Object Status は含まれない
  const lastByte = encoded[encoded.length - 1];
  assert.equal(lastByte, 0);

  const [decoded] = decodeFetchObjectFields(encoded, null, 0, true);
  assert.equal(decoded.payloadLength, 0n);
  // DecodedFetchObject には status フィールドが存在しないことを確認
  assert.equal("status" in decoded, false);
});

test("FetchObjectFields: 最初のオブジェクトをデコード", () => {
  const flags = createFirstFetchObjectFlags(false);
  const data = new Uint8Array([flags, 5, 2, 10, 64, 50]);

  const [decoded, consumed, context] = decodeFetchObjectFields(data, null, 0, true);

  assert.equal(decoded.groupId, 5n);
  assert.equal(decoded.subgroupId, 2n);
  assert.equal(decoded.objectId, 10n);
  assert.equal(decoded.publisherPriority, 64);
  assert.equal(decoded.payloadLength, 50n);
  assert.equal(consumed, 6);
  assert.equal(context.groupId, 5n);
});

test("FetchObjectFields: 2番目のオブジェクトをデコード (差分エンコーディング)", () => {
  const context: FetchObjectContext = {
    groupId: 5n,
    subgroupId: 2n,
    objectId: 10n,
    publisherPriority: 128,
  };

  const flags = FetchSerializationFlags.SUBGROUP_SAME;
  const data = new Uint8Array([flags, 50]);

  const [decoded, consumed, newContext] = decodeFetchObjectFields(data, context, 0, false);

  assert.equal(decoded.groupId, 5n);
  assert.equal(decoded.subgroupId, 2n);
  assert.equal(decoded.objectId, 11n);
  assert.equal(decoded.publisherPriority, 128);
  assert.equal(decoded.payloadLength, 50n);
  assert.equal(consumed, 2);
  assert.equal(newContext.objectId, 11n);
});

/**
 * draft-ietf-moq-transport-23 Section 11.4.1:
 * 0x40 は Datagram フラグとして定義された。
 * 不正な Serialization Flags 値はプロトコル違反。
 */
test("FetchObjectFields: 最初のオブジェクトで prior 参照使用はエラー", () => {
  // 0x40 (Datagram) は有効だが、GROUP_ID_PRESENT が未設定なのでエラー
  const flags = FetchSerializationFlags.DATAGRAM;
  const data = new Uint8Array([flags, 0, 0, 0, 0, 10]);

  assert.throws(
    () => decodeFetchObjectFields(data, null, 0, true),
    "first object must have GROUP_ID_PRESENT flag set",
  );
});

test("FetchObjectFields: 最初のオブジェクトで GROUP_ID_PRESENT なしはエラー", () => {
  const flags =
    FetchSerializationFlags.SUBGROUP_PRESENT |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;
  const data = new Uint8Array([flags, 0, 0, 0, 10]);

  assert.throws(
    () => decodeFetchObjectFields(data, null, 0, true),
    "first object must have GROUP_ID_PRESENT flag set",
  );
});

/**
 * draft-ietf-moq-transport-23 §11.4.1.1:
 * Publisher Priority は 8 bit (0〜255) であり、範囲外・非整数は
 * Uint8Array 化で黙って丸められるため、変換前に throw することを検証する。
 */
test("FetchObjectFields: 範囲外・非整数の publisherPriority は throw する", () => {
  // 256 以上・負値・300 (丸めで 44 になる値) はいずれも拒否する
  for (const priority of [256, -1, 300]) {
    const fields: FetchObjectFields = {
      serializationFlags:
        FetchSerializationFlags.GROUP_ID_PRESENT |
        FetchSerializationFlags.SUBGROUP_PRESENT |
        FetchSerializationFlags.OBJECT_ID_PRESENT |
        FetchSerializationFlags.PRIORITY_PRESENT,
      groupId: 10n,
      subgroupId: 1n,
      objectId: 0n,
      publisherPriority: priority,
      payloadLength: 5n,
    };
    assert.throws(
      () => encodeFetchObjectFields(fields),
      /invalid publisher priority: .* expected integer 0 to 255/,
    );
  }
  // 非整数も拒否する
  for (const priority of [1.5, Number.NaN]) {
    const fields: FetchObjectFields = {
      serializationFlags:
        FetchSerializationFlags.GROUP_ID_PRESENT |
        FetchSerializationFlags.SUBGROUP_PRESENT |
        FetchSerializationFlags.OBJECT_ID_PRESENT |
        FetchSerializationFlags.PRIORITY_PRESENT,
      groupId: 10n,
      subgroupId: 1n,
      objectId: 0n,
      publisherPriority: priority,
      payloadLength: 5n,
    };
    assert.throws(() => encodeFetchObjectFields(fields), /invalid publisher priority/);
  }
  // 境界値 0 / 255 は従来どおり通る
  for (const priority of [0, 255]) {
    const fields: FetchObjectFields = {
      serializationFlags:
        FetchSerializationFlags.GROUP_ID_PRESENT |
        FetchSerializationFlags.SUBGROUP_PRESENT |
        FetchSerializationFlags.OBJECT_ID_PRESENT |
        FetchSerializationFlags.PRIORITY_PRESENT,
      groupId: 10n,
      subgroupId: 1n,
      objectId: 0n,
      publisherPriority: priority,
      payloadLength: 5n,
    };
    const encoded = encodeFetchObjectFields(fields);
    assert.isDefined(encoded);
  }
});

/**
 * draft-ietf-moq-transport-23 §11.4.1.1:
 * PRIORITY_PRESENT なしの encode では priority を検証しないことを確認する。
 */
test("FetchObjectFields: PRIORITY_PRESENT なしの encode は priority を検証しない", () => {
  const fields: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.GROUP_ID_PRESENT |
      FetchSerializationFlags.SUBGROUP_PRESENT |
      FetchSerializationFlags.OBJECT_ID_PRESENT,
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 300,
    payloadLength: 5n,
  };
  const encoded = encodeFetchObjectFields(fields);
  assert.isDefined(encoded);
});

/**
 * draft-ietf-moq-transport-23 §11.4.1.1 Table 10:
 * 0x10 未設定は prior Object の Priority を参照することを意味する。先頭 Object
 * には prior Object が無いため、仕様の MUST により MALFORMED_OBJECT となる。
 */
test("FetchObjectFields: 先頭 Object で PRIORITY_PRESENT 未設定は MALFORMED_OBJECT", () => {
  const fields: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.GROUP_ID_PRESENT |
      FetchSerializationFlags.SUBGROUP_PRESENT |
      FetchSerializationFlags.OBJECT_ID_PRESENT,
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 128,
    payloadLength: 5n,
  };
  const encoded = encodeFetchObjectFields(fields);
  assertFetchViolation(
    () => decodeFetchObjectFields(encoded, null, 0, true),
    SessionErrorCode.MALFORMED_OBJECT,
    /first object must have PRIORITY_PRESENT flag set/,
  );
});

test("FetchObjectFields: 最初のオブジェクトの roundtrip", () => {
  const flags = createFirstFetchObjectFlags(false);
  const original: FetchObjectFields = {
    serializationFlags: flags,
    groupId: 100n,
    subgroupId: 5n,
    objectId: 50n,
    publisherPriority: 200,
    payloadLength: 1000n,
  };

  const encoded = encodeFetchObjectFields(original);
  const [decoded, , context] = decodeFetchObjectFields(encoded, null, 0, true);

  assert.equal(decoded.groupId, 100n);
  assert.equal(decoded.subgroupId, 5n);
  assert.equal(decoded.objectId, 50n);
  assert.equal(decoded.publisherPriority, 200);
  assert.equal(decoded.payloadLength, 1000n);
  assert.equal(context.groupId, 100n);
});

/**
 * draft-ietf-moq-transport-23 Section 11.4.1.1:
 * Properties Length が宣言するバイト数にバッファが満たない場合、
 * 切り詰めた Properties を返して後続フィールドを誤読せず、
 * IncompleteDataError を throw して次のチャンクを待つ。
 */
test("FetchObjectFields: Properties バイト列途中でバッファが切れていると IncompleteDataError", () => {
  const flags = createFirstFetchObjectFlags(true);
  const original: FetchObjectFields = {
    serializationFlags: flags,
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 128,
    properties: new Uint8Array([0xaa, 0xbb, 0xcc]),
    payloadLength: 5n,
  };
  const encoded = encodeFetchObjectFields(original);
  // Properties 末尾 1 バイトと Object Payload Length を落とし
  // Properties 途中で切れた形にする
  const truncated = encoded.slice(0, -2);
  assert.throws(
    () => decodeFetchObjectFields(truncated, null, 0, true),
    IncompleteDataError,
    "properties",
  );
});

test("FetchObjectFields: 複数オブジェクトの連続デコード", () => {
  const firstFlags = createFirstFetchObjectFlags(false);
  const first: FetchObjectFields = {
    serializationFlags: firstFlags,
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 128,
    payloadLength: 100n,
  };

  const firstEncoded = encodeFetchObjectFields(first);
  const [firstDecoded, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);

  assert.equal(firstDecoded.groupId, 10n);
  assert.equal(firstDecoded.objectId, 0n);

  const secondFlags = FetchSerializationFlags.SUBGROUP_SAME;
  const second: FetchObjectFields = {
    serializationFlags: secondFlags,
    payloadLength: 50n,
  };

  const secondEncoded = encodeFetchObjectFields(second);
  const [secondDecoded, , secondContext] = decodeFetchObjectFields(
    secondEncoded,
    firstContext,
    0,
    false,
  );

  assert.equal(secondDecoded.groupId, 10n);
  assert.equal(secondDecoded.subgroupId, 1n);
  assert.equal(secondDecoded.objectId, 1n);
  assert.equal(secondDecoded.publisherPriority, 128);
  assert.equal(secondDecoded.payloadLength, 50n);
  assert.equal(secondContext.objectId, 1n);
});

test("FetchObjectFields: 同じ groupId で SUBGROUP_PLUS_ONE を生成", () => {
  const prior: FetchObjectContext = {
    groupId: 5n,
    subgroupId: 2n,
    objectId: 10n,
    publisherPriority: 128,
  };
  const current = {
    groupId: 5n,
    subgroupId: 3n,
    objectId: 11n,
    publisherPriority: 128,
  };

  const flags = createFetchObjectFlags(current, prior);

  assert.isNotOk(flags & FetchSerializationFlags.GROUP_ID_PRESENT);
  assert.equal(
    flags & FetchSerializationFlags.SUBGROUP_MASK,
    FetchSerializationFlags.SUBGROUP_PLUS_ONE,
  );
  assert.isNotOk(flags & FetchSerializationFlags.OBJECT_ID_PRESENT);
  assert.isNotOk(flags & FetchSerializationFlags.PRIORITY_PRESENT);
});

test("FetchObjectFields: groupId が異なる場合 GROUP_ID_PRESENT を設定", () => {
  const prior: FetchObjectContext = {
    groupId: 5n,
    subgroupId: 2n,
    objectId: 10n,
    publisherPriority: 128,
  };
  const current = {
    groupId: 6n,
    subgroupId: 0n,
    objectId: 0n,
    publisherPriority: 128,
  };

  const flags = createFetchObjectFlags(current, prior);

  assert.isOk(flags & FetchSerializationFlags.GROUP_ID_PRESENT);
  assert.isOk(flags & FetchSerializationFlags.OBJECT_ID_PRESENT);
});

/**
 * 同一 Group・同一 Subgroup の Priority 一貫性検証テスト
 * draft-ietf-moq-transport-23 §12.1 (Malformed Tracks):
 * "An Object with a particular Subgroup ID is received, but its Publisher
 *  Priority is different from that of the previous Object with the same
 *  Subgroup ID." を malformed track と定義している。
 * デコードは MalformedTrackError を throw し、上位ハンドラが FETCH キャンセル
 * (セッション終了ではない) に変換する。
 */
test("FetchObjectFields: 同一 Subgroup で異なる Priority はエラー", () => {
  // 最初のオブジェクト
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(),
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 50n,
  };
  const firstEncoded = encodeFetchObjectFields(first);
  const [, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);

  // 同じ Subgroup で異なる Priority を持つオブジェクト
  // SUBGROUP_SAME + OBJECT_ID_PRESENT + PRIORITY_PRESENT を設定
  // Object ID は本テストの対象外 (Delta=0 は prior + 2 = 2 を表す)
  const secondFlags =
    FetchSerializationFlags.SUBGROUP_SAME |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;
  const objectIdBytes = encodeVarint(0n);
  const payloadLengthBytes = encodeVarint(50n);

  const secondEncoded = new Uint8Array(1 + objectIdBytes.length + 1 + payloadLengthBytes.length);
  secondEncoded[0] = secondFlags;
  let offset = 1;
  secondEncoded.set(objectIdBytes, offset);
  offset += objectIdBytes.length;
  secondEncoded[offset] = 200; // 異なる Priority
  offset += 1;
  secondEncoded.set(payloadLengthBytes, offset);

  // MalformedTrackError (セッション終了を引き起こさないエラー種別) で throw される
  assert.throws(
    () => decodeFetchObjectFields(secondEncoded, firstContext, 0, false),
    MalformedTrackError,
    /malformed track: different priorities in same subgroup/,
  );
});

/**
 * 異なる Group の同一 Subgroup ID は比較対象にならないテスト
 * draft-ietf-moq-transport-23 §2.2:
 * "The scope of a Subgroup ID is a Group, so Subgroups from different Groups
 *  MAY share a Subgroup ID without implying any relationship between them."
 * Group 跨ぎでは Subgroup ID が同じでも Priority が異なってよい。
 */
test("FetchObjectFields: 異なる Group の同一 Subgroup ID で異なる Priority は許可", () => {
  // 最初のオブジェクト (Group 10, Subgroup 1, Priority 100)
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(),
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 50n,
  };
  const firstEncoded = encodeFetchObjectFields(first);
  const [, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);

  // 異なる Group (11) の同一 Subgroup ID (1) で異なる Priority (200)
  // wire 上の Group ID delta = fields.groupId - context.groupId - 1n = 11 - 10 - 1 = 0n
  const second: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.GROUP_ID_PRESENT |
      FetchSerializationFlags.SUBGROUP_SAME |
      FetchSerializationFlags.OBJECT_ID_PRESENT |
      FetchSerializationFlags.PRIORITY_PRESENT,
    groupId: 11n,
    subgroupId: 1n,
    objectId: 1n,
    publisherPriority: 200,
    payloadLength: 50n,
  };
  const secondEncoded = encodeFetchObjectFields(second, false, firstContext);

  // 誤検出されず、正常にデコードされる
  const [decoded] = decodeFetchObjectFields(secondEncoded, firstContext, 0, false);
  assert.equal(decoded.groupId, 11n);
  assert.equal(decoded.subgroupId, 1n);
  assert.equal(decoded.publisherPriority, 200);
});

/**
 * Descending Group Order での Group スコープ比較テスト
 *
 * draft-ietf-moq-transport-23 §2.2:
 * Subgroup ID のスコープは Group 内のため、Group 跨ぎでは同一 Subgroup ID でも
 * Priority が異なってよい。Descending で Group ID が減少する場合も
 * Group スコープ比較により誤検出しないことを検証する。
 */
test("FetchObjectFields: Descending で Group が変わる場合の同一 Subgroup ID の異なる Priority は許可", () => {
  // 最初のオブジェクト (Group 10, Subgroup 1, Priority 100)
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(),
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 50n,
  };
  const firstEncoded = encodeFetchObjectFields(first);
  const [, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);

  // Descending で Group 9 に遷移する同一 Subgroup ID (1) の異なる Priority (200)
  // delta = context.groupId - fields.groupId - 1n = 10 - 9 - 1 = 0n
  const second: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.GROUP_ID_PRESENT |
      FetchSerializationFlags.SUBGROUP_SAME |
      FetchSerializationFlags.OBJECT_ID_PRESENT |
      FetchSerializationFlags.PRIORITY_PRESENT,
    groupId: 9n,
    subgroupId: 1n,
    objectId: 1n,
    publisherPriority: 200,
    payloadLength: 50n,
  };
  const secondEncoded = encodeFetchObjectFields(second, false, firstContext, GroupOrder.DESCENDING);

  // 誤検出されず、正常にデコードされる
  const [decoded] = decodeFetchObjectFields(
    secondEncoded,
    firstContext,
    0,
    false,
    GroupOrder.DESCENDING,
  );
  assert.equal(decoded.groupId, 9n);
  assert.equal(decoded.subgroupId, 1n);
  assert.equal(decoded.publisherPriority, 200);
});

/**
 * Priority バイトでバッファが切れている場合のテスト
 *
 * draft-ietf-moq-transport-23 §11.4.1.1:
 * Publisher Priority は 8 bit 固定。チャンク境界が Priority バイトの直前と
 * 一致した場合、範囲外アクセス (undefined 取得) で Priority 不一致を誤検出せず、
 * IncompleteDataError を throw して次のチャンクを待つことを検証する。
 */
test("FetchObjectFields: Priority バイトでバッファが切れていると IncompleteDataError", () => {
  const prior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 0n,
    objectId: 0n,
    publisherPriority: 100,
  };

  // flags(1) + groupDelta(1) + objectId(1) で Priority バイトが欠落している
  const flags =
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.SUBGROUP_ZERO |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;
  const data = new Uint8Array([flags, 0x01, 0x01]);

  assert.throws(() => decodeFetchObjectFields(data, prior, 0, false), IncompleteDataError);
});

/**
 * Datagram 混在ケースの挙動テスト
 *
 * 前オブジェクトが Datagram の場合、Datagram は Subgroup に属さないため
 * 比較対象にしない (draft-ietf-moq-transport-23 §12.1 の比較対象は
 * "the previous Object with the same Subgroup ID" である)。コンテキストの
 * publisherPriority は Datagram では更新されず、直近の Subgroup オブジェクト
 * の値が保持される。
 */
test("FetchObjectFields: Datagram 直後の同一 Group・同一 Subgroup は直近の Subgroup の Priority と比較され誤検出されない", () => {
  // 最初のオブジェクト (Group 10, Subgroup 1, Priority 100)
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(),
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 50n,
  };
  const firstEncoded = encodeFetchObjectFields(first);
  const [, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);

  // Datagram オブジェクト (Group 10, Priority 200)
  // Group はコンテキストと同じため GROUP_ID_PRESENT は立てない。
  // Datagram は Subgroup を持たないため、コンテキストの Subgroup ID は引き継がれる
  const datagram: FetchObjectFields = {
    serializationFlags: FetchSerializationFlags.DATAGRAM | FetchSerializationFlags.PRIORITY_PRESENT,
    groupId: 10n,
    subgroupId: 0n,
    objectId: 1n,
    publisherPriority: 200,
    payloadLength: 50n,
  };
  const datagramEncoded = encodeFetchObjectFields(datagram, false, firstContext);
  const [, , datagramContext] = decodeFetchObjectFields(datagramEncoded, firstContext, 0, false);

  // Datagram 直後の同一 Group・同一 Subgroup オブジェクト (Priority 100)
  const third: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_SAME | FetchSerializationFlags.PRIORITY_PRESENT,
    objectId: 2n,
    publisherPriority: 100,
    payloadLength: 50n,
  };
  const thirdEncoded = encodeFetchObjectFields(third, false, datagramContext);

  // Datagram (200) とは比較されず、直近の Subgroup オブジェクト (100) と
  // 比較されて一致するため、誤検出されずにデコードされる
  const [decoded] = decodeFetchObjectFields(thirdEncoded, datagramContext, 0, false);
  assert.equal(decoded.publisherPriority, 100);
  assert.equal(decoded.groupId, 10n);
  assert.equal(decoded.subgroupId, 1n);
});

/**
 * draft-ietf-moq-transport-23 §12.1:
 * Datagram を挟んだ場合でも、真の Priority 不一致 (直近の Subgroup オブジェクト
 * との比較) は従来どおり検出されることを検証する。
 */
test("FetchObjectFields: Datagram を挟んだ同一 Subgroup の真の Priority 不一致は検出される", () => {
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(),
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 50n,
  };
  const firstEncoded = encodeFetchObjectFields(first);
  const [, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);

  const datagram: FetchObjectFields = {
    serializationFlags: FetchSerializationFlags.DATAGRAM | FetchSerializationFlags.PRIORITY_PRESENT,
    groupId: 10n,
    subgroupId: 0n,
    objectId: 1n,
    publisherPriority: 200,
    payloadLength: 50n,
  };
  const datagramEncoded = encodeFetchObjectFields(datagram, false, firstContext);
  const [, , datagramContext] = decodeFetchObjectFields(datagramEncoded, firstContext, 0, false);

  // Datagram 直後の同一 Subgroup オブジェクト (Priority 150: 直近 Subgroup の 100 と不一致)
  const third: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_SAME | FetchSerializationFlags.PRIORITY_PRESENT,
    objectId: 2n,
    publisherPriority: 150,
    payloadLength: 50n,
  };
  const thirdEncoded = encodeFetchObjectFields(third, false, datagramContext);

  assert.throws(
    () => decodeFetchObjectFields(thirdEncoded, datagramContext, 0, false),
    MalformedTrackError,
    /malformed track: different priorities in same subgroup/,
  );
});

/**
 * draft-ietf-moq-transport-23 §12.1 / §11.4.2:
 * End of Range で Group が変わった後の同一 Subgroup ID のオブジェクトは、
 * 旧 Group の Priority (前オブジェクトの値) と比較されないことを検証する
 * (Subgroup ID のスコープは Group 内であり、Group 跨ぎは無関係)。
 */
test("FetchObjectFields: End of Range で Group が変わった後の同一 Subgroup ID は旧 Group の Priority と比較されない", () => {
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(),
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 50n,
  };
  const firstEncoded = encodeFetchObjectFields(first);
  const [, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);

  // End of Range (Group 11 へ変更)。先頭 Object の後なので delta 形式で送る。
  const eor: FetchObjectFields = {
    serializationFlags: FetchSerializationFlags.END_OF_UNKNOWN_RANGE,
    groupId: 11n,
    objectId: 0n,
    payloadLength: 0n,
  };
  const eorEncoded = encodeFetchObjectFields(eor, false, firstContext);
  const [, , eorContext] = decodeFetchObjectFields(eorEncoded, firstContext, 0, false);

  // 新 Group 内の同一 Subgroup ID (Priority 50。旧 Group の Subgroup と無関係)
  const third: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_PRESENT | FetchSerializationFlags.PRIORITY_PRESENT,
    groupId: 11n,
    subgroupId: 1n,
    objectId: 1n,
    publisherPriority: 50,
    payloadLength: 50n,
  };
  const thirdEncoded = encodeFetchObjectFields(third, false, eorContext);

  // 旧 Group の Priority (100) とは比較されず、デコードされる
  const [decoded] = decodeFetchObjectFields(thirdEncoded, eorContext, 0, false);
  assert.equal(decoded.publisherPriority, 50);
  assert.equal(decoded.groupId, 11n);
  assert.equal(decoded.subgroupId, 1n);
});

/**
 * draft-ietf-moq-transport-23 §12.1 / §11.4.2:
 * 同一 Group 内の End of Range を挟んだ後は、先行する Subgroup オブジェクトの
 * 存在が引き継がれるため、真の Priority 不一致が検出されることを検証する。
 */
test("FetchObjectFields: 同一 Group 内の End of Range 後の真の Priority 不一致は検出される", () => {
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(),
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 50n,
  };
  const firstEncoded = encodeFetchObjectFields(first);
  const [, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);

  // 同一 Group の End of Range (Group は変更されない)。先頭 Object の後なので
  // delta 形式 (Group ID Delta = 0、Object ID Delta = 9 - 0 - 1 = 8) で送る。
  const eor: FetchObjectFields = {
    serializationFlags: FetchSerializationFlags.END_OF_UNKNOWN_RANGE,
    groupId: 10n,
    objectId: 9n,
    payloadLength: 0n,
  };
  const eorEncoded = encodeFetchObjectFields(eor, false, firstContext);
  const [, , eorContext] = decodeFetchObjectFields(eorEncoded, firstContext, 0, false);

  // End of Range 後の同一 Subgroup オブジェクト (Priority 150: 直前の 100 と不一致)
  const third: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_SAME | FetchSerializationFlags.PRIORITY_PRESENT,
    objectId: 10n,
    publisherPriority: 150,
    payloadLength: 50n,
  };
  const thirdEncoded = encodeFetchObjectFields(third, false, eorContext);

  assert.throws(
    () => decodeFetchObjectFields(thirdEncoded, eorContext, 0, false),
    MalformedTrackError,
    /malformed track: different priorities in same subgroup/,
  );
});

/**
 * draft-ietf-moq-transport-23 §11.4.1.1 Table 10:
 * Priority 省略 (0x10 未設定) のオブジェクトは直近の実オブジェクト (Datagram
 * を含む) の Priority を継承することを検証する (§2.4.2 比較用の値とは別に
 * 継承値は全オブジェクトで更新される)。
 */
test("FetchObjectFields: Priority 省略は直近の実オブジェクト (Datagram 含む) の値を継承する", () => {
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(),
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 50n,
  };
  const firstEncoded = encodeFetchObjectFields(first);
  const [, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);

  const datagram: FetchObjectFields = {
    serializationFlags: FetchSerializationFlags.DATAGRAM | FetchSerializationFlags.PRIORITY_PRESENT,
    groupId: 10n,
    subgroupId: 0n,
    objectId: 1n,
    publisherPriority: 200,
    payloadLength: 50n,
  };
  const datagramEncoded = encodeFetchObjectFields(datagram, false, firstContext);
  const [, , datagramContext] = decodeFetchObjectFields(datagramEncoded, firstContext, 0, false);

  // Priority を省略した Subgroup オブジェクト (0x10 未設定)
  const third: FetchObjectFields = {
    serializationFlags: FetchSerializationFlags.SUBGROUP_SAME,
    objectId: 2n,
    payloadLength: 50n,
  };
  const thirdEncoded = encodeFetchObjectFields(third, false, datagramContext);

  const [decoded] = decodeFetchObjectFields(thirdEncoded, datagramContext, 0, false);
  // 直近の実オブジェクト (Datagram 200) の値を継承する
  assert.equal(decoded.publisherPriority, 200);
});

/**
 * draft-ietf-moq-transport-23 §12.1:
 * hasPriorSubgroup 未指定 (undefined = 直近の Subgroup オブジェクトあり) の
 * ハードコードされたコンテキストでも、Datagram を挟んだ後の真の Priority
 * 不一致が検出されることを検証する (undefined の解釈の一貫性)。
 */
test("FetchObjectFields: hasPriorSubgroup 未指定のコンテキストでも Datagram 後の真の不一致は検出される", () => {
  // ハードコードされたコンテキスト (hasPriorSubgroup を指定しない)
  const hardcodedContext: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
  };

  const datagram: FetchObjectFields = {
    serializationFlags: FetchSerializationFlags.DATAGRAM | FetchSerializationFlags.PRIORITY_PRESENT,
    groupId: 10n,
    subgroupId: 0n,
    objectId: 1n,
    publisherPriority: 200,
    payloadLength: 50n,
  };
  const datagramEncoded = encodeFetchObjectFields(datagram, false, hardcodedContext);
  const [, , datagramContext] = decodeFetchObjectFields(
    datagramEncoded,
    hardcodedContext,
    0,
    false,
  );

  const third: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_SAME | FetchSerializationFlags.PRIORITY_PRESENT,
    objectId: 2n,
    publisherPriority: 150,
    payloadLength: 50n,
  };
  const thirdEncoded = encodeFetchObjectFields(third, false, datagramContext);

  assert.throws(
    () => decodeFetchObjectFields(thirdEncoded, datagramContext, 0, false),
    MalformedTrackError,
    /malformed track: different priorities in same subgroup/,
  );
});

/**
 * draft-ietf-moq-transport-23 §12.1:
 * Datagram が自前の Group ID で Group を変更した後の同一 Subgroup ID の
 * オブジェクトは、旧 Group の Priority と比較されないことを検証する
 * (Group 変更で比較対象の存在がリセットされる)。
 */
test("FetchObjectFields: Datagram の Group 変更後の同一 Subgroup ID は旧 Group の Priority と比較されない", () => {
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(),
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 50n,
  };
  const firstEncoded = encodeFetchObjectFields(first);
  const [, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);

  // Datagram オブジェクト (GROUP_ID_PRESENT で Group 11 へ変更)
  const datagram: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.DATAGRAM |
      FetchSerializationFlags.GROUP_ID_PRESENT |
      FetchSerializationFlags.OBJECT_ID_PRESENT |
      FetchSerializationFlags.PRIORITY_PRESENT,
    groupId: 11n,
    subgroupId: 0n,
    objectId: 1n,
    publisherPriority: 200,
    payloadLength: 50n,
  };
  const datagramEncoded = encodeFetchObjectFields(datagram, false, firstContext);
  const [, , datagramContext] = decodeFetchObjectFields(datagramEncoded, firstContext, 0, false);

  // 新 Group 内の Subgroup オブジェクト (Priority 50。旧 Group の Subgroup と無関係)
  const third: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_SAME | FetchSerializationFlags.PRIORITY_PRESENT,
    objectId: 2n,
    publisherPriority: 50,
    payloadLength: 50n,
  };
  const thirdEncoded = encodeFetchObjectFields(third, false, datagramContext);

  // 旧 Group の Priority (100) とは比較されず、デコードされる
  const [decoded] = decodeFetchObjectFields(thirdEncoded, datagramContext, 0, false);
  assert.equal(decoded.publisherPriority, 50);
  assert.equal(decoded.groupId, 11n);
});

test("FetchObjectFields: 異なる Subgroup で異なる Priority は許可", () => {
  // 最初のオブジェクト
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(),
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 50n,
  };
  const firstEncoded = encodeFetchObjectFields(first);
  const [, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);

  // 異なる Subgroup で異なる Priority
  // GROUP_ID省略 + SUBGROUP_PLUS_ONE + OBJECT_ID_PRESENT + PRIORITY_PRESENT
  // Object ID は本テストの対象外 (Delta=0 は prior + 2 = 2 を表す)
  const secondFlags =
    FetchSerializationFlags.SUBGROUP_PLUS_ONE |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;
  const objectIdBytes = encodeVarint(0n);
  const payloadLengthBytes = encodeVarint(50n);

  const secondEncoded = new Uint8Array(1 + objectIdBytes.length + 1 + payloadLengthBytes.length);
  secondEncoded[0] = secondFlags;
  let offset = 1;
  secondEncoded.set(objectIdBytes, offset);
  offset += objectIdBytes.length;
  secondEncoded[offset] = 200; // 異なる Priority
  offset += 1;
  secondEncoded.set(payloadLengthBytes, offset);

  const [decoded] = decodeFetchObjectFields(secondEncoded, firstContext, 0, false);

  // subgroupId = context.subgroupId + 1 = 1 + 1 = 2
  assert.equal(decoded.subgroupId, 2n);
  assert.equal(decoded.publisherPriority, 200);
});

/**
 * Subgroup が交互に出現する場合の Priority 不一致検出テスト
 * draft-ietf-moq-transport-23 §12.1:
 * "An Object with a particular Subgroup ID is received, but its Publisher
 *  Priority is different from that of the previous Object with the same
 *  Subgroup ID."
 * S1 → S2 → S1 のように Subgroup が交互しても、同一 Subgroup ID の直近
 * オブジェクトとの比較で不一致を検出する。
 */
test("FetchObjectFields: 交互に出現する Subgroup の Priority 不一致は検出される", () => {
  // 最初のオブジェクト (Group 10, Subgroup 1, Priority 100)
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(),
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 50n,
  };
  const firstEncoded = encodeFetchObjectFields(first);
  const [, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);

  // 2 番目のオブジェクト (Group 10, Subgroup 2, Priority 200)
  // S1 の Priority (100) とは比較されず、正常にデコードされる
  const second: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_PRESENT | FetchSerializationFlags.PRIORITY_PRESENT,
    subgroupId: 2n,
    objectId: 1n,
    publisherPriority: 200,
    payloadLength: 50n,
  };
  const secondEncoded = encodeFetchObjectFields(second, false, firstContext);
  const [secondDecoded, , secondContext] = decodeFetchObjectFields(
    secondEncoded,
    firstContext,
    0,
    false,
  );
  assert.equal(secondDecoded.subgroupId, 2n);
  assert.equal(secondDecoded.publisherPriority, 200);

  // 3 番目のオブジェクト (Group 10, Subgroup 1, Priority 150)
  // 直前の S2 ではなく同一 Subgroup ID の直近オブジェクト (S1 の 100) と
  // 比較され、不一致として検出される
  const third: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_PRESENT | FetchSerializationFlags.PRIORITY_PRESENT,
    subgroupId: 1n,
    objectId: 2n,
    publisherPriority: 150,
    payloadLength: 50n,
  };
  const thirdEncoded = encodeFetchObjectFields(third, false, secondContext);

  assert.throws(
    () => decodeFetchObjectFields(thirdEncoded, secondContext, 0, false),
    MalformedTrackError,
    /malformed track: different priorities in same subgroup/,
  );
});

/**
 * Subgroup が交互に出現しても Priority が一致すれば検出されないテスト
 * draft-ietf-moq-transport-23 §12.1:
 * 同一 Subgroup ID の直近オブジェクトと Priority が一致する場合は合法であり、
 * 直前オブジェクトと Subgroup ID が異なっても誤検出しない。
 */
test("FetchObjectFields: 交互に出現しても同一 Subgroup の Priority 一致は誤検出されない", () => {
  // 最初のオブジェクト (Group 10, Subgroup 1, Priority 100)
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(),
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 50n,
  };
  const firstEncoded = encodeFetchObjectFields(first);
  const [, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);

  // 2 番目のオブジェクト (Group 10, Subgroup 2, Priority 200)
  const second: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_PRESENT | FetchSerializationFlags.PRIORITY_PRESENT,
    subgroupId: 2n,
    objectId: 1n,
    publisherPriority: 200,
    payloadLength: 50n,
  };
  const secondEncoded = encodeFetchObjectFields(second, false, firstContext);
  const [, , secondContext] = decodeFetchObjectFields(secondEncoded, firstContext, 0, false);

  // 3 番目のオブジェクト (Group 10, Subgroup 1, Priority 100)
  // 同一 Subgroup ID の直近オブジェクト (S1 の 100) と一致するため、
  // 正常にデコードされる
  const third: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_PRESENT | FetchSerializationFlags.PRIORITY_PRESENT,
    subgroupId: 1n,
    objectId: 2n,
    publisherPriority: 100,
    payloadLength: 50n,
  };
  const thirdEncoded = encodeFetchObjectFields(third, false, secondContext);

  const [decoded] = decodeFetchObjectFields(thirdEncoded, secondContext, 0, false);
  assert.equal(decoded.groupId, 10n);
  assert.equal(decoded.subgroupId, 1n);
  assert.equal(decoded.publisherPriority, 100);
});

/**
 * 同一 Group 内の End of Range を挟んだ交互出現のテスト
 * draft-ietf-moq-transport-23 §12.1 / §11.4.2:
 * 同一 Group 内の End of Range では Subgroup ごとの追跡が維持されるため、
 * 交互出現後の同一 Subgroup の不一致も検出される。
 */
test("FetchObjectFields: 同一 Group の End of Range を挟んだ交互出現の不一致は検出される", () => {
  // 最初のオブジェクト (Group 10, Subgroup 1, Priority 100)
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(),
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 50n,
  };
  const firstEncoded = encodeFetchObjectFields(first);
  const [, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);

  // 2 番目のオブジェクト (Group 10, Subgroup 2, Priority 200)
  const second: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_PRESENT | FetchSerializationFlags.PRIORITY_PRESENT,
    subgroupId: 2n,
    objectId: 1n,
    publisherPriority: 200,
    payloadLength: 50n,
  };
  const secondEncoded = encodeFetchObjectFields(second, false, firstContext);
  const [, , secondContext] = decodeFetchObjectFields(secondEncoded, firstContext, 0, false);

  // 同一 Group の End of Range (Group は変更されない)。直前の Object の後なので
  // delta 形式 (Group ID Delta = 0、Object ID Delta = 9 - 1 - 1 = 7) で送る。
  const eor: FetchObjectFields = {
    serializationFlags: FetchSerializationFlags.END_OF_UNKNOWN_RANGE,
    groupId: 10n,
    objectId: 9n,
    payloadLength: 0n,
  };
  const eorEncoded = encodeFetchObjectFields(eor, false, secondContext);
  const [, , eorContext] = decodeFetchObjectFields(eorEncoded, secondContext, 0, false);

  // End of Range 後の Subgroup 1 (Priority 150: 直近の S1 の 100 と不一致)
  // End of Range 後のコンテキストは直前の S2 を指すため、明示指定で S1 に戻る
  const third: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_PRESENT | FetchSerializationFlags.PRIORITY_PRESENT,
    subgroupId: 1n,
    objectId: 10n,
    publisherPriority: 150,
    payloadLength: 50n,
  };
  const thirdEncoded = encodeFetchObjectFields(third, false, eorContext);

  assert.throws(
    () => decodeFetchObjectFields(thirdEncoded, eorContext, 0, false),
    MalformedTrackError,
    /malformed track: different priorities in same subgroup/,
  );
});

/**
 * Datagram を挟んだ交互出現のテスト
 * draft-ietf-moq-transport-23 §12.1:
 * Datagram は Subgroup に属さないため追跡を更新しない。Datagram を挟んだ
 * 交互出現後の同一 Subgroup の不一致も、同一 Subgroup ID の直近オブジェクト
 * との比較で検出される。
 */
test("FetchObjectFields: Datagram を挟んだ交互出現の不一致は検出される", () => {
  // 最初のオブジェクト (Group 10, Subgroup 1, Priority 100)
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(),
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 50n,
  };
  const firstEncoded = encodeFetchObjectFields(first);
  const [, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);

  // 2 番目のオブジェクト (Group 10, Subgroup 2, Priority 200)
  const second: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_PRESENT | FetchSerializationFlags.PRIORITY_PRESENT,
    subgroupId: 2n,
    objectId: 1n,
    publisherPriority: 200,
    payloadLength: 50n,
  };
  const secondEncoded = encodeFetchObjectFields(second, false, firstContext);
  const [, , secondContext] = decodeFetchObjectFields(secondEncoded, firstContext, 0, false);

  // Datagram オブジェクト (Group 10, Priority 250)
  // Subgroup に属さないため、Subgroup ごとの追跡は更新されない
  const datagram: FetchObjectFields = {
    serializationFlags: FetchSerializationFlags.DATAGRAM | FetchSerializationFlags.PRIORITY_PRESENT,
    groupId: 10n,
    subgroupId: 0n,
    objectId: 2n,
    publisherPriority: 250,
    payloadLength: 50n,
  };
  const datagramEncoded = encodeFetchObjectFields(datagram, false, secondContext);
  const [, , datagramContext] = decodeFetchObjectFields(datagramEncoded, secondContext, 0, false);

  // Datagram 後の Subgroup 1 (Priority 150: 直近の S1 の 100 と不一致)
  // Datagram の 250 とは比較されない
  const third: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_PRESENT | FetchSerializationFlags.PRIORITY_PRESENT,
    subgroupId: 1n,
    objectId: 3n,
    publisherPriority: 150,
    payloadLength: 50n,
  };
  const thirdEncoded = encodeFetchObjectFields(third, false, datagramContext);

  assert.throws(
    () => decodeFetchObjectFields(thirdEncoded, datagramContext, 0, false),
    MalformedTrackError,
    /malformed track: different priorities in same subgroup/,
  );
});

/**
 * Descending Group Order での交互出現テスト
 * draft-ietf-moq-transport-23 §12.1:
 * 追跡更新は Group Order に依存しないため、Descending でも同一 Subgroup ID の
 * 直近オブジェクトとの比較で不一致を検出する。
 */
test("FetchObjectFields: Descending でも交互に出現する Subgroup の不一致は検出される", () => {
  // 最初のオブジェクト (Group 10, Subgroup 1, Priority 100)
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(),
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 50n,
  };
  const firstEncoded = encodeFetchObjectFields(first);
  const [, , firstContext] = decodeFetchObjectFields(
    firstEncoded,
    null,
    0,
    true,
    GroupOrder.DESCENDING,
  );

  // 2 番目のオブジェクト (Group 10, Subgroup 2, Priority 200)
  const second: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_PRESENT | FetchSerializationFlags.PRIORITY_PRESENT,
    subgroupId: 2n,
    objectId: 1n,
    publisherPriority: 200,
    payloadLength: 50n,
  };
  const secondEncoded = encodeFetchObjectFields(second, false, firstContext);
  const [, , secondContext] = decodeFetchObjectFields(
    secondEncoded,
    firstContext,
    0,
    false,
    GroupOrder.DESCENDING,
  );

  // 3 番目のオブジェクト (Group 10, Subgroup 1, Priority 150)
  // 同一 Subgroup ID の直近オブジェクト (S1 の 100) と不一致のため検出される
  const third: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_PRESENT | FetchSerializationFlags.PRIORITY_PRESENT,
    subgroupId: 1n,
    objectId: 2n,
    publisherPriority: 150,
    payloadLength: 50n,
  };
  const thirdEncoded = encodeFetchObjectFields(third, false, secondContext);

  assert.throws(
    () => decodeFetchObjectFields(thirdEncoded, secondContext, 0, false, GroupOrder.DESCENDING),
    MalformedTrackError,
    /malformed track: different priorities in same subgroup/,
  );
});

/**
 * Subgroup ID 0 の交互出現テスト
 * draft-ietf-moq-transport-23 §12.1:
 * Subgroup ID 0 も Map のキーとして区別され、未登録 (undefined) と混同されずに
 * 追跡される。S0 → S1 → S0 の交互でも同一 Subgroup ID の直近値と比較する。
 */
test("FetchObjectFields: Subgroup ID 0 の交互出現の不一致は検出される", () => {
  // 最初のオブジェクト (Group 10, Subgroup 0, Priority 100)
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(),
    groupId: 10n,
    subgroupId: 0n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 50n,
  };
  const firstEncoded = encodeFetchObjectFields(first);
  const [, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);

  // 2 番目のオブジェクト (Group 10, Subgroup 1, Priority 200)
  const second: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_PRESENT | FetchSerializationFlags.PRIORITY_PRESENT,
    subgroupId: 1n,
    objectId: 1n,
    publisherPriority: 200,
    payloadLength: 50n,
  };
  const secondEncoded = encodeFetchObjectFields(second, false, firstContext);
  const [, , secondContext] = decodeFetchObjectFields(secondEncoded, firstContext, 0, false);

  // 3 番目のオブジェクト (Group 10, Subgroup 0, Priority 150)
  // 同一 Subgroup ID の直近オブジェクト (S0 の 100) と不一致のため検出される
  const third: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_PRESENT | FetchSerializationFlags.PRIORITY_PRESENT,
    subgroupId: 0n,
    objectId: 2n,
    publisherPriority: 150,
    payloadLength: 50n,
  };
  const thirdEncoded = encodeFetchObjectFields(third, false, secondContext);

  assert.throws(
    () => decodeFetchObjectFields(thirdEncoded, secondContext, 0, false),
    MalformedTrackError,
    /malformed track: different priorities in same subgroup/,
  );
});

/**
 * Priority 省略を挟んだ同一 Subgroup の不一致検出テスト
 * draft-ietf-moq-transport-23 §11.4.1.1 Table 10 / §12.1:
 * Priority 省略のオブジェクト自体は比較対象外 (寛容解釈) とするが、
 * 追跡は解決後の継承値で更新される。後続の明示値は更新後の基準と比較される。
 */
test("FetchObjectFields: Priority 省略を挟んだ同一 Subgroup の不一致は検出される", () => {
  // 最初のオブジェクト (Group 10, Subgroup 1, Priority 100)
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(),
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 50n,
  };
  const firstEncoded = encodeFetchObjectFields(first);
  const [, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);

  // 2 番目のオブジェクト (Group 10, Subgroup 1, Priority 省略)
  // 直近の実オブジェクト (100) を継承し、比較されずにデコードされる
  const second: FetchObjectFields = {
    serializationFlags: FetchSerializationFlags.SUBGROUP_SAME,
    objectId: 1n,
    payloadLength: 50n,
  };
  const secondEncoded = encodeFetchObjectFields(second, false, firstContext);
  const [secondDecoded, , secondContext] = decodeFetchObjectFields(
    secondEncoded,
    firstContext,
    0,
    false,
  );
  assert.equal(secondDecoded.publisherPriority, 100);

  // 3 番目のオブジェクト (Group 10, Subgroup 1, Priority 150)
  // 追跡基準 (100) と不一致のため検出される
  const third: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_SAME | FetchSerializationFlags.PRIORITY_PRESENT,
    objectId: 2n,
    publisherPriority: 150,
    payloadLength: 50n,
  };
  const thirdEncoded = encodeFetchObjectFields(third, false, secondContext);

  assert.throws(
    () => decodeFetchObjectFields(thirdEncoded, secondContext, 0, false),
    MalformedTrackError,
    /malformed track: different priorities in same subgroup/,
  );
});

/**
 * draft-ietf-moq-transport-23 §11.4.1.1 Table 10:
 * "If the Group Order is Ascending, the Group ID is the prior Object's
 *  Group ID plus the Group ID Delta + 1."
 *
 * 非先頭オブジェクトで GROUP_ID_PRESENT がセットされている場合、
 * delta から正しい Group ID (prior + delta + 1) を計算することを検証する。
 */
test("FetchObjectFields: 非先頭オブジェクトの Group ID Delta を正しくデコードする", () => {
  const prior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 1n,
    objectId: 5n,
    publisherPriority: 128,
  };

  // GROUP_ID_PRESENT | SUBGROUP_ZERO | OBJECT_ID_PRESENT | PRIORITY_PRESENT
  const flags =
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.SUBGROUP_ZERO |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;

  // delta_group=3, objectId=0(絶対値), priority=200, payloadLength=50
  const groupDeltaBytes = encodeVarint(3n);
  const objectIdBytes = encodeVarint(0n);
  const payloadLengthBytes = encodeVarint(50n);

  const data = new Uint8Array(
    1 + groupDeltaBytes.length + objectIdBytes.length + 1 + payloadLengthBytes.length,
  );
  data[0] = flags;
  let offset = 1;
  data.set(groupDeltaBytes, offset);
  offset += groupDeltaBytes.length;
  data.set(objectIdBytes, offset);
  offset += objectIdBytes.length;
  data[offset] = 200;
  offset += 1;
  data.set(payloadLengthBytes, offset);

  const [decoded, , newContext] = decodeFetchObjectFields(data, prior, 0, false);

  // groupId = prior.groupId + delta + 1 = 10 + 3 + 1 = 14
  assert.equal(decoded.groupId, 14n);
  // subgroupId = 0 (SUBGROUP_ZERO)
  assert.equal(decoded.subgroupId, 0n);
  // objectId = 0 (Group 変化時は絶対値)
  assert.equal(decoded.objectId, 0n);
  assert.equal(decoded.publisherPriority, 200);
  assert.equal(decoded.payloadLength, 50n);
  assert.equal(newContext.groupId, 14n);
});

/**
 * draft-ietf-moq-transport-23 §11.4.1.1:
 * "When the Group ID Delta field is not present, the Object ID is the prior
 *  Object's ID plus the Object ID Delta + 2 if present."
 *
 * 非先頭オブジェクトで GROUP_ID_PRESENT なし、OBJECT_ID_PRESENT ありの場合、
 * delta から正しい Object ID (prior + delta + 2) を計算することを検証する。
 */
test("FetchObjectFields: 非先頭オブジェクトの Object ID Delta (Group 不変) を正しくデコードする", () => {
  const prior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 1n,
    objectId: 5n,
    publisherPriority: 128,
  };

  // SUBGROUP_SAME | OBJECT_ID_PRESENT
  const flags = FetchSerializationFlags.SUBGROUP_SAME | FetchSerializationFlags.OBJECT_ID_PRESENT;

  // delta_object=3 (Group 不変時は prior + delta + 2)
  const objectDeltaBytes = encodeVarint(3n);
  const payloadLengthBytes = encodeVarint(50n);

  const data = new Uint8Array(1 + objectDeltaBytes.length + payloadLengthBytes.length);
  data[0] = flags;
  data.set(objectDeltaBytes, 1);
  data.set(payloadLengthBytes, 1 + objectDeltaBytes.length);

  const [decoded, , newContext] = decodeFetchObjectFields(data, prior, 0, false);

  // groupId = 10 (変化なし)
  assert.equal(decoded.groupId, 10n);
  // subgroupId = 1 (SUBGROUP_SAME)
  assert.equal(decoded.subgroupId, 1n);
  // objectId = prior.objectId + delta + 2 = 5 + 3 + 2 = 10
  assert.equal(decoded.objectId, 10n);
  assert.equal(decoded.publisherPriority, 128);
  assert.equal(decoded.payloadLength, 50n);
  assert.equal(newContext.objectId, 10n);
});

/**
 * draft-ietf-moq-transport-23 §11.4.1.1:
 * encode → decode で複数オブジェクトの delta encoding が正しく roundtrip することを検証する。
 * オブジェクト 1: group=10, object=0  (先頭)
 * オブジェクト 2: group=10, object=3  (Group 不変, OBJECT_ID_PRESENT, delta=3-0-2=1)
 * オブジェクト 3: group=14, object=0  (Group 変更, GROUP_ID_PRESENT, 絶対値)
 */
test("FetchObjectFields: encode→decode roundtrip で delta encoding が正しく復元される", () => {
  // オブジェクト 1 (先頭): group=10, object=0
  const firstFlags = createFirstFetchObjectFlags(false);
  const first: FetchObjectFields = {
    serializationFlags: firstFlags,
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 50n,
  };
  const firstEncoded = encodeFetchObjectFields(first);
  const [firstDecoded, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);
  assert.equal(firstDecoded.groupId, 10n);
  assert.equal(firstDecoded.objectId, 0n);

  // オブジェクト 2: Group 不変, object=3 (増分 3 → delta=1), SUBGROUP_SAME
  const second: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_SAME | FetchSerializationFlags.OBJECT_ID_PRESENT,
    objectId: 3n,
    payloadLength: 80n,
  };
  const secondEncoded = encodeFetchObjectFields(second, false, firstContext);
  const [secondDecoded, , secondContext] = decodeFetchObjectFields(
    secondEncoded,
    firstContext,
    0,
    false,
  );
  assert.equal(secondDecoded.groupId, 10n);
  assert.equal(secondDecoded.objectId, 3n);
  assert.equal(secondDecoded.payloadLength, 80n);

  // オブジェクト 3: Group 変更 (10 → 14, delta=14-10-1=3), object=0
  const third: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.GROUP_ID_PRESENT |
      FetchSerializationFlags.SUBGROUP_ZERO |
      FetchSerializationFlags.OBJECT_ID_PRESENT |
      FetchSerializationFlags.PRIORITY_PRESENT,
    groupId: 14n,
    subgroupId: 0n,
    objectId: 0n,
    publisherPriority: 200,
    payloadLength: 30n,
  };
  const thirdEncoded = encodeFetchObjectFields(third, false, secondContext);
  const [thirdDecoded] = decodeFetchObjectFields(thirdEncoded, secondContext, 0, false);
  assert.equal(thirdDecoded.groupId, 14n);
  assert.equal(thirdDecoded.subgroupId, 0n);
  assert.equal(thirdDecoded.objectId, 0n);
  assert.equal(thirdDecoded.publisherPriority, 200);
  assert.equal(thirdDecoded.payloadLength, 30n);
});

// ============================================================================
// Fetch Object Fields - 同一 Group の Object ID Delta +2 (draft-23 §11.4.1.1)
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §11.4.1.1:
 * "When the Group ID Delta field is not present, the Object ID is the prior
 *  Object's ID plus the Object ID Delta + 2 if present."
 *
 * prior=10、Delta=0 の固定ワイヤが Object 12 になることを検証する。
 * 送受信双方が同じ誤り (+2 なし) を持つラウンドトリップでは検出できないため、
 * ワイヤのバイト列を直接組み立てて検証する。
 */
test("FetchObjectFields: 同一 Group で prior=10 / Delta=0 の固定ワイヤが Object 12 になる", () => {
  const prior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 1n,
    objectId: 10n,
    publisherPriority: 128,
  };

  // Serialization Flags = SUBGROUP_SAME (0x01) | OBJECT_ID_PRESENT (0x04) = 0x05
  // Object ID Delta = 0、Object Payload Length = 50
  const data = new Uint8Array([0x05, 0x00, 0x32]);

  const [decoded, consumed, context] = decodeFetchObjectFields(data, prior, 0, false);

  // prior 10 + Delta 0 + 2 = 12
  assert.equal(decoded.objectId, 12n);
  assert.equal(decoded.groupId, 10n);
  assert.equal(decoded.subgroupId, 1n);
  assert.equal(decoded.payloadLength, 50n);
  assert.equal(consumed, data.length);
  assert.equal(context.objectId, 12n);
});

/**
 * draft-ietf-moq-transport-23 §11.4.1.1:
 * "If Object ID Delta is not present, the Object ID is the prior Object's ID
 *  plus one, regardless of which group it belongs to."
 *
 * prior=10 で Delta を省略した固定ワイヤが Object 11 になることを検証する。
 */
test("FetchObjectFields: 同一 Group で prior=10 / Delta 省略の固定ワイヤが Object 11 になる", () => {
  const prior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 1n,
    objectId: 10n,
    publisherPriority: 128,
  };

  // Serialization Flags = SUBGROUP_SAME (0x01) のみ、Object Payload Length = 50
  const data = new Uint8Array([0x01, 0x32]);

  const [decoded, consumed, context] = decodeFetchObjectFields(data, prior, 0, false);

  // prior 10 + 1 = 11
  assert.equal(decoded.objectId, 11n);
  assert.equal(decoded.groupId, 10n);
  assert.equal(decoded.subgroupId, 1n);
  assert.equal(decoded.payloadLength, 50n);
  assert.equal(consumed, data.length);
  assert.equal(context.objectId, 11n);
});

/**
 * encode が同一 Group の Object ID Delta を current - prior - 2 で書くことを
 * 固定ワイヤで検証する。増分 2 / 3 / 10 が Delta 0 / 1 / 8 になる。
 */
test("FetchObjectFields: 同一 Group の Object ID Delta を current - prior - 2 でエンコードする", () => {
  const prior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 1n,
    objectId: 10n,
    publisherPriority: 128,
  };

  const cases = [
    { objectId: 12n, delta: 0n },
    { objectId: 13n, delta: 1n },
    { objectId: 20n, delta: 8n },
  ];

  for (const { objectId, delta } of cases) {
    const fields: FetchObjectFields = {
      serializationFlags:
        FetchSerializationFlags.SUBGROUP_SAME | FetchSerializationFlags.OBJECT_ID_PRESENT,
      objectId,
      payloadLength: 50n,
    };
    const encoded = encodeFetchObjectFields(fields, false, prior);
    // Flags (0x05) + Object ID Delta + Object Payload Length (50)
    const expected = new Uint8Array([0x05, ...encodeVarint(delta), 0x32]);
    assert.deepEqual(encoded, expected);
  }
});

/**
 * Delta 省略時は Object ID フィールドを書かないことを固定ワイヤで検証する。
 * prior=10、増分 1 の Object 11 は Flags と Object Payload Length だけで表現される。
 */
test("FetchObjectFields: Delta 省略時は Object ID フィールドを書かない", () => {
  const prior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 1n,
    objectId: 10n,
    publisherPriority: 128,
  };

  const fields: FetchObjectFields = {
    serializationFlags: FetchSerializationFlags.SUBGROUP_SAME,
    objectId: 11n,
    payloadLength: 50n,
  };
  // Flags (0x01) + Object Payload Length (50)
  assert.deepEqual(encodeFetchObjectFields(fields, false, prior), new Uint8Array([0x01, 0x32]));
});

/**
 * Delta 省略時は Group ID Delta の有無に関わらず prior Object ID + 1 で復号
 * される (§11.4.1.1)。指定された Object ID が prior + 1 でない場合は、
 * 要求した ID と異なる ID を送ることになるため送信前に拒否する。
 */
test("FetchObjectFields: Delta 省略で prior + 1 以外の Object ID を指定すると拒否される", () => {
  const prior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 1n,
    objectId: 10n,
    publisherPriority: 128,
  };

  for (const objectId of [10n, 12n]) {
    const fields: FetchObjectFields = {
      serializationFlags: FetchSerializationFlags.SUBGROUP_SAME,
      objectId,
      payloadLength: 0n,
    };
    assert.throws(
      () => encodeFetchObjectFields(fields, false, prior),
      /object id mismatch when OBJECT_ID_PRESENT is not set/,
    );
  }
});

/**
 * Delta 省略時は prior Object ID + 1 で復号されるため、暗黙の +1 が
 * 2^64-1 を超える場合は送信前に拒否する (§11.4.1.1)。
 */
test("FetchObjectFields: Delta 省略の暗黙 +1 が 2^64-1 を超える場合は拒否される", () => {
  const prior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 1n,
    objectId: MAX_VARINT,
    publisherPriority: 128,
  };
  const fields: FetchObjectFields = {
    serializationFlags: FetchSerializationFlags.SUBGROUP_SAME,
    payloadLength: 0n,
  };
  assert.throws(
    () => encodeFetchObjectFields(fields, false, prior),
    /object id overflow when OBJECT_ID_PRESENT is not set/,
  );
});

/**
 * 増分 2 で Object ID がちょうど 2^64-1 になる場合は送信できる。
 */
test("FetchObjectFields: 増分 2 で Object ID が 2^64-1 になる場合は送信できる", () => {
  const prior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 1n,
    objectId: MAX_VARINT - 2n,
    publisherPriority: 128,
  };
  const fields: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_SAME | FetchSerializationFlags.OBJECT_ID_PRESENT,
    objectId: MAX_VARINT,
    payloadLength: 0n,
  };
  // Flags + Object ID Delta (0) + Object Payload Length (0)
  assert.deepEqual(
    encodeFetchObjectFields(fields, false, prior),
    new Uint8Array([0x05, 0x00, 0x00]),
  );
});

/**
 * Object ID の範囲検証は OBJECT_ID_PRESENT の有無に関わらず行う。
 * Delta 省略時は prior + 1 との一致検証より前に範囲外を拒否する。
 */
test("FetchObjectFields: OBJECT_ID_PRESENT なしでも範囲外の Object ID は拒否される", () => {
  const prior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 1n,
    objectId: 10n,
    publisherPriority: 128,
  };

  for (const objectId of [MAX_VARINT + 1n, -1n]) {
    const fields: FetchObjectFields = {
      serializationFlags: FetchSerializationFlags.SUBGROUP_SAME,
      objectId,
      payloadLength: 0n,
    };
    assert.throws(() => encodeFetchObjectFields(fields, false, prior), /object id out of range/);
  }
});

/**
 * Delta 省略の暗黙 +1 で Object ID がちょうど 2^64-1 になる場合は送信できる。
 */
test("FetchObjectFields: Delta 省略の暗黙 +1 で Object ID が 2^64-1 になる場合は送信できる", () => {
  const prior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 1n,
    objectId: MAX_VARINT - 1n,
    publisherPriority: 128,
  };
  const fields: FetchObjectFields = {
    serializationFlags: FetchSerializationFlags.SUBGROUP_SAME,
    objectId: MAX_VARINT,
    payloadLength: 0n,
  };
  // Flags (0x01) + Object Payload Length (0)
  const encoded = encodeFetchObjectFields(fields, false, prior);
  assert.deepEqual(encoded, new Uint8Array([0x01, 0x00]));
  const [decoded] = decodeFetchObjectFields(encoded, prior, 0, false);
  assert.equal(decoded.objectId, MAX_VARINT);
});

/**
 * Object ID は varint の範囲 (0 以上 2^64-1 以下) でなければならない。
 * 範囲外は encodeVarint の汎用エラーに委ねず、送信前に明示的に拒否する。
 */
test("FetchObjectFields: 範囲外の Object ID は送信前に拒否される", () => {
  const prior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 1n,
    objectId: 10n,
    publisherPriority: 128,
  };

  for (const objectId of [MAX_VARINT + 1n, -1n]) {
    const fields: FetchObjectFields = {
      serializationFlags:
        FetchSerializationFlags.SUBGROUP_SAME | FetchSerializationFlags.OBJECT_ID_PRESENT,
      objectId,
      payloadLength: 0n,
    };
    assert.throws(() => encodeFetchObjectFields(fields, false, prior), /object id out of range/);
  }
});

/**
 * createFetchObjectFlags が新しい式に合わせて Delta の有無を決めることを検証する。
 * 同一 Group では増分 1 だけ Delta を省略し、増分 2 以上は明示 Delta にする。
 * Group 変更時は Delta 省略でも prior + 1 で復元できる (§11.4.1.1)。
 */
test("FetchObjectFields: createFetchObjectFlags は増分 1 で Delta を省略し増分 2 以上で明示する", () => {
  const prior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 1n,
    objectId: 10n,
    publisherPriority: 128,
  };
  const currentBase = {
    groupId: 10n,
    subgroupId: 1n,
    publisherPriority: 128,
  };

  // 同一 Group: 増分 1 は Delta 省略
  const incrementOne = createFetchObjectFlags({ ...currentBase, objectId: 11n }, prior);
  assert.isNotOk(incrementOne & FetchSerializationFlags.GROUP_ID_PRESENT);
  assert.isNotOk(incrementOne & FetchSerializationFlags.OBJECT_ID_PRESENT);

  // 同一 Group: 増分 2 / 3 は明示 Delta
  for (const objectId of [12n, 13n]) {
    const flags = createFetchObjectFlags({ ...currentBase, objectId }, prior);
    assert.isNotOk(flags & FetchSerializationFlags.GROUP_ID_PRESENT);
    assert.isOk(flags & FetchSerializationFlags.OBJECT_ID_PRESENT);
  }

  // Group 変更: 増分 1 は Delta 省略で prior + 1 として復元できる
  const groupChangedIncrementOne = createFetchObjectFlags(
    { groupId: 11n, subgroupId: 1n, objectId: 11n, publisherPriority: 128 },
    prior,
  );
  assert.isOk(groupChangedIncrementOne & FetchSerializationFlags.GROUP_ID_PRESENT);
  assert.isNotOk(groupChangedIncrementOne & FetchSerializationFlags.OBJECT_ID_PRESENT);

  // Group 変更: 絶対値が必要な場合は Delta を明示する
  const groupChangedAbsolute = createFetchObjectFlags(
    { groupId: 11n, subgroupId: 1n, objectId: 0n, publisherPriority: 128 },
    prior,
  );
  assert.isOk(groupChangedAbsolute & FetchSerializationFlags.GROUP_ID_PRESENT);
  assert.isOk(groupChangedAbsolute & FetchSerializationFlags.OBJECT_ID_PRESENT);

  // 増分 0 は Delta では表現できないため OBJECT_ID_PRESENT を立て、
  // encode の送信前検証で拒否される
  const incrementZeroFlags = createFetchObjectFlags({ ...currentBase, objectId: 10n }, prior);
  assert.isOk(incrementZeroFlags & FetchSerializationFlags.OBJECT_ID_PRESENT);
  assert.throws(
    () =>
      encodeFetchObjectFields(
        {
          serializationFlags: incrementZeroFlags,
          objectId: 10n,
          payloadLength: 0n,
        },
        false,
        prior,
      ),
    /object id delta cannot represent increment/,
  );
});

/**
 * draft-ietf-moq-transport-23 §11.4.1.1:
 * 明示 Delta は prior + 2 以上の増分だけを表せる (Delta 0 は prior + 2、
 * Delta 省略は prior + 1)。増分 0 / 1 を明示 Delta で送ろうとした場合は、
 * 誤った Object ID を送らないよう encode が送信前に拒否する。
 */
test("FetchObjectFields: 同一 Group で増分 0 / 1 を明示 Delta で送ろうとすると拒否される", () => {
  const prior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 1n,
    objectId: 10n,
    publisherPriority: 128,
  };

  for (const objectId of [10n, 11n]) {
    const fields: FetchObjectFields = {
      serializationFlags:
        FetchSerializationFlags.SUBGROUP_SAME | FetchSerializationFlags.OBJECT_ID_PRESENT,
      objectId,
      payloadLength: 0n,
    };
    assert.throws(
      () => encodeFetchObjectFields(fields, false, prior),
      /object id delta cannot represent increment/,
    );
  }
});

/**
 * draft-ietf-moq-transport-23 §11.4.1.1:
 * "When the Group ID Delta field is present, the Object ID is the value of
 *  Object ID Delta if present."
 *
 * Group 切替時は Object ID Delta が絶対値であり、+2 を加算しないことを
 * 固定ワイヤで検証する。Group ID Delta=0 (Ascending で prior + 1) でも
 * Object ID は 3 のまま復元される。
 */
test("FetchObjectFields: Group 切替時の Object ID Delta は絶対値のまま", () => {
  const prior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 1n,
    objectId: 10n,
    publisherPriority: 128,
  };

  const fields: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.GROUP_ID_PRESENT |
      FetchSerializationFlags.SUBGROUP_SAME |
      FetchSerializationFlags.OBJECT_ID_PRESENT,
    groupId: 11n,
    objectId: 3n,
    payloadLength: 0n,
  };
  const encoded = encodeFetchObjectFields(fields, false, prior);

  // Flags (0x0D) + Group ID Delta (0 = 11 - 10 - 1) + Object ID (3、絶対値) +
  // Object Payload Length (0)
  assert.deepEqual(encoded, new Uint8Array([0x0d, 0x00, 0x03, 0x00]));

  const [decoded] = decodeFetchObjectFields(encoded, prior, 0, false);
  assert.equal(decoded.groupId, 11n);
  assert.equal(decoded.objectId, 3n);
});

/**
 * draft-ietf-moq-transport-23 §11.4.1.1:
 * "If Object ID Delta is not present, the Object ID is the prior Object's ID plus
 *  one, regardless of which group it belongs to."
 * Group 変更 + Delta 省略でも prior + 1 で復元される。
 */
test("FetchObjectFields: Group 変更 + Delta 省略は prior + 1 で復元される", () => {
  const prior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 1n,
    objectId: 10n,
    publisherPriority: 128,
  };
  // Serialization Flags = GROUP_ID_PRESENT | SUBGROUP_SAME (0x09)、
  // Group ID Delta 0、Object Payload Length 0
  const data = new Uint8Array([0x09, 0x00, 0x00]);
  const [decoded] = decodeFetchObjectFields(data, prior, 0, false);
  assert.equal(decoded.groupId, 11n);
  assert.equal(decoded.objectId, 11n);

  // encode も同じワイヤになる (Group ID Delta 0 / Object ID 省略)
  const encoded = encodeFetchObjectFields(
    {
      serializationFlags:
        FetchSerializationFlags.GROUP_ID_PRESENT | FetchSerializationFlags.SUBGROUP_SAME,
      groupId: 11n,
      objectId: 11n,
      payloadLength: 0n,
    },
    false,
    prior,
  );
  assert.deepEqual(encoded, data);
});

/**
 * draft-ietf-moq-transport-23 §11.4.1.1 の Object ID の式は Group Order を
 * 含まない。Ascending / Descending のどちらでも同じワイヤが同じ Object ID に
 * 復元されることを検証する。
 */
test("FetchObjectFields: Ascending / Descending のどちらでも Object ID は prior + Delta + 2", () => {
  const prior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 1n,
    objectId: 10n,
    publisherPriority: 128,
  };

  // Serialization Flags = SUBGROUP_SAME | OBJECT_ID_PRESENT、Delta=0、
  // Object Payload Length=50
  const data = new Uint8Array([0x05, 0x00, 0x32]);

  for (const groupOrder of [GroupOrder.ASCENDING, GroupOrder.DESCENDING]) {
    const [decoded] = decodeFetchObjectFields(data, prior, 0, false, groupOrder);
    assert.equal(decoded.groupId, 10n);
    assert.equal(decoded.objectId, 12n);
  }
});

/**
 * draft-ietf-moq-transport-23 §11.4.2.1 / §11.4.2.2:
 * End of Range indicator の後の通常 Object は、indicator が復号した Location を
 * prior Object として扱う。同一 Group なら通常 Object の式
 * (prior + Object ID Delta + 2 / prior + 1) で復元される。
 *
 * End of Range indicator 自体も delta 形式で復号するため、ここでは実 Object →
 * indicator → 通常 Object の 3 レコードを実際に連結して検証する。
 */
test("FetchObjectFields: End of Range 復号後の Object ID が +2 / +1 で復元される", () => {
  // 実 Object を先に 1 件受信する (Group 10 / Subgroup 1 / Object 5 / Priority 100)
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(),
    groupId: 10n,
    subgroupId: 1n,
    objectId: 5n,
    publisherPriority: 100,
    payloadLength: 0n,
  };
  const firstEncoded = encodeFetchObjectFields(first);
  const [, firstConsumed, firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);

  // End of Range indicator は直前の実 Object を基準にした delta 形式である。
  // Group は変えず Object 9 までを Unknown にする
  // (Group ID Delta = 0、Object ID Delta = 9 - 5 - 1 = 3)。
  const eor: FetchObjectFields = {
    serializationFlags: FetchSerializationFlags.END_OF_UNKNOWN_RANGE,
    groupId: 10n,
    objectId: 9n,
    payloadLength: 0n,
  };
  const eorEncoded = encodeFetchObjectFields(eor, false, firstContext);
  // 固定ワイヤ: Flags (0x10C の 2 バイト varint) + Group ID Delta 0 + Object ID Delta 3
  assert.deepEqual(eorEncoded, new Uint8Array([0x81, 0x0c, 0x00, 0x03]));

  // 実 Object と indicator を連結したバッファから順にデコードする
  const combined = new Uint8Array(firstEncoded.length + eorEncoded.length);
  combined.set(firstEncoded, 0);
  combined.set(eorEncoded, firstEncoded.length);

  const [decodedFirst, decodedFirstConsumed] = decodeFetchObjectFields(combined, null, 0, true);
  assert.equal(decodedFirst.objectId, 5n);
  assert.equal(decodedFirstConsumed, firstConsumed);

  const [decodedEor, eorConsumed, eorContext] = decodeFetchObjectFields(
    combined,
    firstContext,
    decodedFirstConsumed,
    false,
  );
  assert.equal(eorConsumed, eorEncoded.length);
  assert.equal(decodedEor.endOfRange, "unknown");
  assert.equal(decodedEor.groupId, 10n);
  assert.equal(decodedEor.objectId, 9n);
  assert.equal(decodedEor.payloadLength, 0n);

  // EOR 直後の通常 Object は indicator が復号した Object 9 を prior にする。
  // Delta=0 → 9 + 0 + 2 = 11
  const [withDelta] = decodeFetchObjectFields(
    new Uint8Array([0x05, 0x00, 0x32]),
    eorContext,
    0,
    false,
  );
  assert.equal(withDelta.objectId, 11n);
  assert.equal(withDelta.groupId, 10n);
  // Subgroup ID / Priority は indicator より前の最後の実 Object から継承する
  assert.equal(withDelta.subgroupId, 1n);
  assert.equal(withDelta.publisherPriority, 100);

  // Delta 省略 → 9 + 1 = 10
  const [withoutDelta] = decodeFetchObjectFields(
    new Uint8Array([0x01, 0x32]),
    eorContext,
    0,
    false,
  );
  assert.equal(withoutDelta.objectId, 10n);
  assert.equal(withoutDelta.groupId, 10n);
  assert.equal(withoutDelta.subgroupId, 1n);
  assert.equal(withoutDelta.publisherPriority, 100);
});

/**
 * 2^64-1 境界: prior + Object ID Delta + 2 がちょうど 2^64-1 になる場合を
 * 検証する。
 */
test("FetchObjectFields: Object ID が 2^64-1 に達する境界を復元できる", () => {
  // Delta=0 で prior + 2 = 2^64-1 → prior = 2^64-3
  const priorWithDelta: FetchObjectContext = {
    groupId: 1n,
    subgroupId: 0n,
    objectId: MAX_VARINT - 2n,
    publisherPriority: 0,
  };
  // Serialization Flags = SUBGROUP_SAME | OBJECT_ID_PRESENT、Delta=0、Payload Length=0
  const [decodedWithDelta] = decodeFetchObjectFields(
    new Uint8Array([0x05, 0x00, 0x00]),
    priorWithDelta,
    0,
    false,
  );
  assert.equal(decodedWithDelta.objectId, MAX_VARINT);

  // Delta 省略で prior + 1 = 2^64-1 → prior = 2^64-2
  const priorWithoutDelta: FetchObjectContext = {
    groupId: 1n,
    subgroupId: 0n,
    objectId: MAX_VARINT - 1n,
    publisherPriority: 0,
  };
  const [decodedWithoutDelta] = decodeFetchObjectFields(
    new Uint8Array([0x01, 0x00]),
    priorWithoutDelta,
    0,
    false,
  );
  assert.equal(decodedWithoutDelta.objectId, MAX_VARINT);
});

/**
 * Delta=0 で prior + 2 が 2^64-1 を超える場合の検証。
 * draft-ietf-moq-transport-23 §11.4.1.1 の DELTA_ENCODING_OVERFLOW として拒否する。
 */
test("FetchObjectFields: Delta=0 で Object ID が 2^64-1 を超える場合は DELTA_ENCODING_OVERFLOW", () => {
  const prior: FetchObjectContext = {
    groupId: 1n,
    subgroupId: 0n,
    objectId: MAX_VARINT - 1n,
    publisherPriority: 0,
  };

  // prior 2^64-2 + Delta 0 + 2 = 2^64 (超過)
  assertFetchViolation(
    () => decodeFetchObjectFields(new Uint8Array([0x05, 0x00, 0x00]), prior, 0, false),
    SessionErrorCode.DELTA_ENCODING_OVERFLOW,
    /computed object id out of range/,
  );
});

// ============================================================================
// Fetch Object Fields - Descending Group Order のテスト
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §11.4.1.1 Table 10:
 * "If the Group Order is Descending, the Group ID is the prior Object's
 *  Group ID minus the (Group ID Delta + 1)."
 *
 * Descending 時に正しい Group ID を計算することを検証する。
 */
test("FetchObjectFields: Descending Group Order で Group ID を正しくデコードする", () => {
  const prior: FetchObjectContext = {
    groupId: 100n,
    subgroupId: 1n,
    objectId: 5n,
    publisherPriority: 128,
  };

  // GROUP_ID_PRESENT | SUBGROUP_ZERO | OBJECT_ID_PRESENT | PRIORITY_PRESENT
  const flags =
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.SUBGROUP_ZERO |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;

  // delta_group=3, objectId=0(絶対値), priority=200, payloadLength=50
  const groupDeltaBytes = encodeVarint(3n);
  const objectIdBytes = encodeVarint(0n);
  const payloadLengthBytes = encodeVarint(50n);

  const data = new Uint8Array(
    1 + groupDeltaBytes.length + objectIdBytes.length + 1 + payloadLengthBytes.length,
  );
  data[0] = flags;
  let offset = 1;
  data.set(groupDeltaBytes, offset);
  offset += groupDeltaBytes.length;
  data.set(objectIdBytes, offset);
  offset += objectIdBytes.length;
  data[offset] = 200;
  offset += 1;
  data.set(payloadLengthBytes, offset);

  const [decoded, , newContext] = decodeFetchObjectFields(
    data,
    prior,
    0,
    false,
    GroupOrder.DESCENDING,
  );

  // groupId = prior.groupId - delta - 1 = 100 - 3 - 1 = 96
  assert.equal(decoded.groupId, 96n);
  assert.equal(decoded.subgroupId, 0n);
  assert.equal(decoded.objectId, 0n);
  assert.equal(decoded.publisherPriority, 200); // サブグループが異なるので異なる Priority で問題なし
  assert.equal(decoded.payloadLength, 50n);
  assert.equal(newContext.groupId, 96n);
});

/**
 * draft-ietf-moq-transport-23 §11.4.1.1 Table 10:
 * "If the Group Order is Descending, the Group ID is the prior Object's
 *  Group ID minus the (Group ID Delta + 1)."
 *
 * "If the computed Group ID would be less than 0 or greater than 2^64-1,
 *  the Subscriber MUST close the Session with DELTA_ENCODING_OVERFLOW."
 *
 * Descending 時に Group ID が 0 未満になる場合、DELTA_ENCODING_OVERFLOW の
 * ProtocolViolationError が throw されることを検証する。
 */
test("FetchObjectFields: Descending で Group ID が 0 未満になる場合は DELTA_ENCODING_OVERFLOW", () => {
  const prior: FetchObjectContext = {
    groupId: 2n,
    subgroupId: 1n,
    objectId: 5n,
    publisherPriority: 128,
  };

  // GROUP_ID_PRESENT | SUBGROUP_ZERO | OBJECT_ID_PRESENT | PRIORITY_PRESENT
  const flags =
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.SUBGROUP_ZERO |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;

  // delta_group=5 → groupId = prior.groupId - delta - 1 = 2 - 5 - 1 = -4 (< 0)
  const groupDeltaBytes = encodeVarint(5n);
  const objectIdBytes = encodeVarint(0n);
  const payloadLengthBytes = encodeVarint(50n);

  const data = new Uint8Array(
    1 + groupDeltaBytes.length + objectIdBytes.length + 1 + payloadLengthBytes.length,
  );
  data[0] = flags;
  let offset = 1;
  data.set(groupDeltaBytes, offset);
  offset += groupDeltaBytes.length;
  data.set(objectIdBytes, offset);
  offset += objectIdBytes.length;
  data[offset] = 200;
  offset += 1;
  data.set(payloadLengthBytes, offset);

  assertFetchViolation(
    () => decodeFetchObjectFields(data, prior, 0, false, GroupOrder.DESCENDING),
    SessionErrorCode.DELTA_ENCODING_OVERFLOW,
    /computed group id out of range/,
  );
});

/**
 * Descending Group Order で encode→decode roundtrip が正しく動作することを検証する。
 */
test("FetchObjectFields: Descending Group Order で encode→decode roundtrip が成功する", () => {
  // オブジェクト 1 (先頭): group=100, object=0
  const firstFlags = createFirstFetchObjectFlags(false);
  const first: FetchObjectFields = {
    serializationFlags: firstFlags,
    groupId: 100n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 50n,
  };
  const firstEncoded = encodeFetchObjectFields(first, false, null, GroupOrder.DESCENDING);
  const [firstDecoded, , firstContext] = decodeFetchObjectFields(
    firstEncoded,
    null,
    0,
    true,
    GroupOrder.DESCENDING,
  );
  assert.equal(firstDecoded.groupId, 100n);
  assert.equal(firstDecoded.objectId, 0n);

  // オブジェクト 2: Group 減少 (100 → 95, delta=100-95-1=4)
  // 同一 Subgroup の Priority 一貫性を保つため、同じ Priority を使用する
  const second: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.GROUP_ID_PRESENT |
      FetchSerializationFlags.SUBGROUP_SAME |
      FetchSerializationFlags.OBJECT_ID_PRESENT |
      FetchSerializationFlags.PRIORITY_PRESENT,
    groupId: 95n,
    objectId: 2n,
    publisherPriority: 100, // 先頭と同じ Priority
    payloadLength: 80n,
  };
  const secondEncoded = encodeFetchObjectFields(second, false, firstContext, GroupOrder.DESCENDING);
  const [secondDecoded, , secondContext] = decodeFetchObjectFields(
    secondEncoded,
    firstContext,
    0,
    false,
    GroupOrder.DESCENDING,
  );
  assert.equal(secondDecoded.groupId, 95n);
  assert.equal(secondDecoded.objectId, 2n);
  assert.equal(secondDecoded.payloadLength, 80n);

  // オブジェクト 3: Group さらに減少 (95 → 80, delta=95-80-1=14)
  const third: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.GROUP_ID_PRESENT |
      FetchSerializationFlags.SUBGROUP_SAME |
      FetchSerializationFlags.OBJECT_ID_PRESENT |
      FetchSerializationFlags.PRIORITY_PRESENT,
    groupId: 80n,
    objectId: 5n,
    publisherPriority: 100, // 先頭と同じ Priority
    payloadLength: 30n,
  };
  const thirdEncoded = encodeFetchObjectFields(third, false, secondContext, GroupOrder.DESCENDING);
  const [thirdDecoded] = decodeFetchObjectFields(
    thirdEncoded,
    secondContext,
    0,
    false,
    GroupOrder.DESCENDING,
  );
  assert.equal(thirdDecoded.groupId, 80n);
  assert.equal(thirdDecoded.objectId, 5n);
});

/**
 * Ascending Group Order で Group ID が 2^64-1 を超過する場合の検証。
 */
test("FetchObjectFields: Ascending で Group ID が 2^64-1 を超過する場合は ProtocolViolationError", () => {
  const prior: FetchObjectContext = {
    groupId: (1n << 64n) - 1n,
    subgroupId: 1n,
    objectId: 5n,
    publisherPriority: 128,
  };

  const flags =
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.SUBGROUP_ZERO |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;

  // delta_group=0 → groupId = prior.groupId + delta + 1 = (2^64-1) + 0 + 1 = 2^64 (overflow)
  const groupDeltaBytes = encodeVarint(0n);
  const objectIdBytes = encodeVarint(0n);
  const payloadLengthBytes = encodeVarint(50n);

  const data = new Uint8Array(
    1 + groupDeltaBytes.length + objectIdBytes.length + 1 + payloadLengthBytes.length,
  );
  data[0] = flags;
  let offset = 1;
  data.set(groupDeltaBytes, offset);
  offset += groupDeltaBytes.length;
  data.set(objectIdBytes, offset);
  offset += objectIdBytes.length;
  data[offset] = 200;
  offset += 1;
  data.set(payloadLengthBytes, offset);

  assert.throws(
    () => decodeFetchObjectFields(data, prior, 0, false, GroupOrder.ASCENDING),
    /computed group id out of range/,
  );
});

/**
 * Descending Group Order で Group ID が 2^64-1 を超過する場合の検証。
 * prior = 0, delta = 0 → groupId = 0 - 0 - 1 = -1 (< 0)、0 未満のため out of range。
 */
test("FetchObjectFields: Descending で prior=0,delta=0 の場合は Group ID が 0 未満で ProtocolViolationError", () => {
  const prior: FetchObjectContext = {
    groupId: 0n,
    subgroupId: 1n,
    objectId: 5n,
    publisherPriority: 128,
  };

  const flags =
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.SUBGROUP_ZERO |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;

  const groupDeltaBytes = encodeVarint(0n);
  const objectIdBytes = encodeVarint(0n);
  const payloadLengthBytes = encodeVarint(50n);

  const data = new Uint8Array(
    1 + groupDeltaBytes.length + objectIdBytes.length + 1 + payloadLengthBytes.length,
  );
  data[0] = flags;
  let offset = 1;
  data.set(groupDeltaBytes, offset);
  offset += groupDeltaBytes.length;
  data.set(objectIdBytes, offset);
  offset += objectIdBytes.length;
  data[offset] = 200;
  offset += 1;
  data.set(payloadLengthBytes, offset);

  assert.throws(
    () => decodeFetchObjectFields(data, prior, 0, false, GroupOrder.DESCENDING),
    /computed group id out of range/,
  );
});

// ============================================================================
// Fetch Object Fields - DATAGRAM フラグ (0x40) のテスト
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §11.4.1.1:
 * "the object has no Subgroup ID. The publisher MUST SET bit 0x40 to '1'."
 * "the subscriber MUST ignore the bits."
 *
 * DATAGRAM (0x40) 単独の先頭オブジェクトを正しくデコードすることを検証する。
 */
test("FetchObjectFields: DATAGRAM (0x40) の先頭オブジェクトを正しくデコードする", () => {
  const flags =
    FetchSerializationFlags.DATAGRAM |
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;

  const data = new Uint8Array([flags, 5, 10, 64, 50]);

  const [decoded, , context] = decodeFetchObjectFields(data, null, 0, true);

  assert.equal(decoded.groupId, 5n);
  assert.equal(decoded.subgroupId, 0n);
  assert.equal(decoded.objectId, 10n);
  assert.equal(decoded.publisherPriority, 64);
  assert.equal(decoded.payloadLength, 50n);
  assert.equal(context.subgroupId, 0n);
});

/**
 * DATAGRAM + SUBGROUP_PRESENT (0x5F): DATAGRAM ビットが立つ Object は Subgroup ID を
 * 持たないため、下位 2 ビットが SUBGROUP_PRESENT でも Subgroup ID vi64 を消費せず、
 * 後続の Object ID / Priority / payload length が正しくデコードされることを検証する。
 *
 * ワイヤフォーマット: flags, group_id, object_id, priority, payload_length
 */
test("FetchObjectFields: DATAGRAM+SUBGROUP_PRESENT で Subgroup ID を消費せず後続フィールドを読む", () => {
  const flags =
    FetchSerializationFlags.DATAGRAM |
    FetchSerializationFlags.SUBGROUP_PRESENT |
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;

  // wire: [flags][groupId=5][objectId=10][priority=64][payloadLength=50]
  // DATAGRAM ビットが立つため Subgroup ID フィールドは存在しない
  const data = new Uint8Array([flags, 5, 10, 64, 50]);

  const [decoded, consumed] = decodeFetchObjectFields(data, null, 0, true);

  assert.equal(decoded.groupId, 5n);
  assert.equal(decoded.subgroupId, 0n);
  assert.equal(decoded.objectId, 10n);
  assert.equal(decoded.publisherPriority, 64);
  assert.equal(decoded.payloadLength, 50n);
  // Subgroup ID フィールドを消費しないため、消費バイト数はワイヤ長と一致する
  assert.equal(consumed, data.length);
});

/**
 * draft-ietf-moq-transport-23 §11.4.1.1:
 * "the object has no Subgroup ID" は先頭・非先頭を問わない。DATAGRAM ビットが立つ
 * 非先頭オブジェクトでも Subgroup ID vi64 を消費せず、後続の Object ID /
 * Publisher Priority / payload length が正しく復元されることを検証する。
 *
 * ワイヤフォーマット: flags, group_id_delta, object_id, priority, payload_length
 */
test("FetchObjectFields: 非先頭 DATAGRAM+SUBGROUP_PRESENT でも Subgroup ID を消費しない", () => {
  // 1 件目: DATAGRAM の先頭オブジェクト (context を得る)
  const firstFlags =
    FetchSerializationFlags.DATAGRAM |
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;
  const [first, , firstContext] = decodeFetchObjectFields(
    new Uint8Array([firstFlags, 5, 10, 64, 50]),
    null,
    0,
    true,
  );
  assert.equal(first.groupId, 5n);
  assert.equal(firstContext.groupId, 5n);
  assert.equal(firstContext.subgroupId, 0n);

  // 2 件目: 非先頭 DATAGRAM + SUBGROUP_PRESENT。
  // DATAGRAM ビットが立つため Subgroup ID フィールドは存在しない。
  const flags =
    FetchSerializationFlags.DATAGRAM |
    FetchSerializationFlags.SUBGROUP_PRESENT |
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;
  const data = new Uint8Array([flags, 0, 20, 80, 60]);

  const [decoded, consumed, context] = decodeFetchObjectFields(data, firstContext, 0, false);

  // Group ID は prior + delta + 1、Object ID は絶対値として復元される
  assert.equal(decoded.groupId, 6n);
  assert.equal(decoded.objectId, 20n);
  assert.equal(decoded.publisherPriority, 80);
  assert.equal(decoded.payloadLength, 60n);
  assert.equal(decoded.subgroupId, 0n);
  // Subgroup ID フィールドを消費しないため、消費バイト数はワイヤ長と一致する
  assert.equal(consumed, data.length);
  assert.equal(context.subgroupId, 0n);
});

/**
 * draft-ietf-moq-transport-23 §11.4.1.1:
 * DATAGRAM ビットが立つオブジェクトは Subgroup ID を運ばないため、
 * decodeFetchObjectFields は newContext.subgroupId に直前の実 Object の
 * Subgroup ID を保持する。非先頭ケースでこれが保たれることを検証する
 * (ここが 0 に落ちると、後続の SUBGROUP_SAME が別 Subgroup を参照する)。
 */
test("FetchObjectFields: 非先頭 DATAGRAM は直前の実 Subgroup ID を context に保持する", () => {
  // 1 件目: Subgroup ID 7 を持つ通常 (非 DATAGRAM) の先頭オブジェクト
  const firstFlags =
    FetchSerializationFlags.SUBGROUP_PRESENT |
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;
  const [first, , firstContext] = decodeFetchObjectFields(
    new Uint8Array([firstFlags, 5, 7, 10, 64, 50]),
    null,
    0,
    true,
  );
  assert.equal(first.subgroupId, 7n);
  assert.equal(firstContext.subgroupId, 7n);

  // 2 件目: 非先頭 DATAGRAM + SUBGROUP_PRESENT
  const flags =
    FetchSerializationFlags.DATAGRAM |
    FetchSerializationFlags.SUBGROUP_PRESENT |
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;
  const data = new Uint8Array([flags, 0, 20, 80, 60]);

  const [decoded, consumed, context] = decodeFetchObjectFields(data, firstContext, 0, false);

  assert.equal(decoded.groupId, 6n);
  assert.equal(decoded.objectId, 20n);
  assert.equal(decoded.publisherPriority, 80);
  assert.equal(decoded.payloadLength, 60n);
  // DATAGRAM 自身は Subgroup 0 として扱い、context は直前の実 Subgroup ID を保つ
  assert.equal(decoded.subgroupId, 0n);
  assert.equal(consumed, data.length);
  assert.equal(context.subgroupId, 7n);
});

/**
 * draft-ietf-moq-transport-23 §3.7:
 * Object Property に Mandatory Track Property (0x4000-0x7FFF) を含む FETCH Object は
 * malformed であり、decodeFetchObjectFields が MalformedTrackError を throw する。
 */
test("FetchObjectFields: Mandatory Track Property を含む Object Property で MalformedTrackError", () => {
  const fields: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.GROUP_ID_PRESENT |
      FetchSerializationFlags.OBJECT_ID_PRESENT |
      FetchSerializationFlags.PRIORITY_PRESENT |
      FetchSerializationFlags.PROPERTIES_PRESENT,
    groupId: 10n,
    objectId: 0n,
    publisherPriority: 128,
    properties: encodeProperties([{ id: 0x4000n, value: 0n }]),
    payloadLength: 5n,
  };
  const encoded = encodeFetchObjectFields(fields);
  assert.throws(() => decodeFetchObjectFields(encoded, null, 0, true), MalformedTrackError);
});

/**
 * DATAGRAM + SUBGROUP_SAME (0x41) の先頭オブジェクト:
 * 下位ビットが SUBGROUP_SAME (0x01) でも、DATAGRAM ビットにより無視されるため
 * "first object cannot use SUBGROUP_SAME" が throw されないことを検証する。
 */
test("FetchObjectFields: DATAGRAM+SUBGROUP_SAME (0x41) の先頭オブジェクトがエラーにならない", () => {
  const flags =
    FetchSerializationFlags.DATAGRAM |
    FetchSerializationFlags.SUBGROUP_SAME |
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;

  const data = new Uint8Array([flags, 1, 0, 128, 50]);

  const [decoded] = decodeFetchObjectFields(data, null, 0, true);

  assert.equal(decoded.subgroupId, 0n);
  assert.equal(decoded.groupId, 1n);
});

/**
 * DATAGRAM + SUBGROUP_PLUS_ONE (0x42) の先頭オブジェクト:
 * 下位ビットが SUBGROUP_PLUS_ONE でも DATAGRAM により無視されるためエラーにならない。
 */
test("FetchObjectFields: DATAGRAM+SUBGROUP_PLUS_ONE (0x42) の先頭オブジェクトがエラーにならない", () => {
  const flags =
    FetchSerializationFlags.DATAGRAM |
    FetchSerializationFlags.SUBGROUP_PLUS_ONE |
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;

  const data = new Uint8Array([flags, 1, 0, 128, 50]);

  const [decoded] = decodeFetchObjectFields(data, null, 0, true);

  assert.equal(decoded.subgroupId, 0n);
  assert.equal(decoded.groupId, 1n);
});

/**
 * 非 Datagram → Datagram → 非 Datagram の混在シーケンスで
 * Subgroup ID が正しく伝搬することを検証する。
 */
test("FetchObjectFields: 非 Datagram → Datagram → 非 Datagram の混在で Subgroup ID が正しく伝搬する", () => {
  // オブジェクト 1: 非 Datagram (SUBGROUP_PRESENT)
  const firstFlags = createFirstFetchObjectFlags(false, false);
  const first: FetchObjectFields = {
    serializationFlags: firstFlags,
    groupId: 10n,
    subgroupId: 5n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 50n,
  };
  const firstEncoded = encodeFetchObjectFields(first);
  const [, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);
  assert.equal(firstContext.subgroupId, 5n);

  // オブジェクト 2: Datagram (0x40) + GROUP_ID_PRESENT + ...
  const secondFlags =
    FetchSerializationFlags.DATAGRAM |
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;
  const groupDeltaBytes = encodeVarint(0n); // delta=0 → groupId=10+0+1=11
  const secondEncoded = new Uint8Array(1 + groupDeltaBytes.length + 3);
  secondEncoded[0] = secondFlags;
  secondEncoded.set(groupDeltaBytes, 1);
  secondEncoded[1 + groupDeltaBytes.length] = 0; // objectId
  secondEncoded[1 + groupDeltaBytes.length + 1] = 200; // priority
  secondEncoded[1 + groupDeltaBytes.length + 2] = 100; // payloadLength

  const [secondDecoded, , secondContext] = decodeFetchObjectFields(
    secondEncoded,
    firstContext,
    0,
    false,
  );
  assert.equal(secondDecoded.subgroupId, 0n); // Datagram なので 0n
  // Datagram 後も context の subgroupId は非 Datagram の値 5n を保持する
  assert.equal(secondContext.subgroupId, 5n);

  // オブジェクト 3: 非 Datagram (SUBGROUP_SAME)
  // Object ID は本テストの対象外 (Delta=2 は prior + 4 = 4 を表す)
  const thirdFlags =
    FetchSerializationFlags.SUBGROUP_SAME | FetchSerializationFlags.OBJECT_ID_PRESENT;
  const objectDeltaBytes = encodeVarint(2n);
  const payloadLengthBytes = encodeVarint(50n);
  const thirdEncoded = new Uint8Array(1 + objectDeltaBytes.length + payloadLengthBytes.length);
  thirdEncoded[0] = thirdFlags;
  thirdEncoded.set(objectDeltaBytes, 1);
  thirdEncoded.set(payloadLengthBytes, 1 + objectDeltaBytes.length);

  const [thirdDecoded] = decodeFetchObjectFields(thirdEncoded, secondContext, 0, false);
  // SUBGROUP_SAME → context の subgroupId (5n) が正しく伝搬
  assert.equal(thirdDecoded.subgroupId, 5n);
});

/**
 * createFirstFetchObjectFlags: Datagram 引数で DATAGRAM ビット付き flags を生成する。
 */
test("FetchObjectFields: createFirstFetchObjectFlags で Datagram 用 flags を生成できる", () => {
  const flags = createFirstFetchObjectFlags(false, true);

  assert.isOk(flags & FetchSerializationFlags.DATAGRAM);
  assert.isOk(flags & FetchSerializationFlags.GROUP_ID_PRESENT);
  assert.isOk(flags & FetchSerializationFlags.OBJECT_ID_PRESENT);
  assert.isOk(flags & FetchSerializationFlags.PRIORITY_PRESENT);
  // Datagram 時は SUBGROUP_PRESENT を含まない
  assert.isNotOk(
    (flags & FetchSerializationFlags.SUBGROUP_MASK) === FetchSerializationFlags.SUBGROUP_PRESENT,
  );
});

// ============================================================================
// Fetch Object Fields - Object ID オーバーフローチェックのテスト
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §11.4.1.1:
 * "If the computed Object ID would be greater than 2^64-1, the Subscriber
 *  MUST close the Session with DELTA_ENCODING_OVERFLOW."
 * 受信経路は DELTA_ENCODING_OVERFLOW として扱う。
 *
 * Object ID Delta なし (+1) で Object ID が overflow する場合。
 */
test("FetchObjectFields: Object ID +1 で 2^64-1 を超過する場合は DELTA_ENCODING_OVERFLOW", () => {
  const prior: FetchObjectContext = {
    groupId: 5n,
    subgroupId: 1n,
    objectId: (1n << 64n) - 1n,
    publisherPriority: 128,
  };

  // SUBGROUP_SAME (OBJECT_ID_PRESENT なし → +1)
  const flags = FetchSerializationFlags.SUBGROUP_SAME;
  const payloadLengthBytes = encodeVarint(50n);

  const data = new Uint8Array(1 + payloadLengthBytes.length);
  data[0] = flags;
  data.set(payloadLengthBytes, 1);

  assertFetchViolation(
    () => decodeFetchObjectFields(data, prior, 0, false),
    SessionErrorCode.DELTA_ENCODING_OVERFLOW,
    /computed object id out of range/,
  );
});

/**
 * Group 不変時の Object ID Delta で overflow する場合。
 * Prior: 2^64-2, delta: 3 → 2^64-2 + 3 + 2 = 2^64+3 > 2^64-1
 */
test("FetchObjectFields: Group 不変時の Object ID Delta で 2^64-1 を超過する場合は DELTA_ENCODING_OVERFLOW", () => {
  const prior: FetchObjectContext = {
    groupId: 5n,
    subgroupId: 1n,
    objectId: (1n << 64n) - 2n,
    publisherPriority: 128,
  };

  const flags = FetchSerializationFlags.SUBGROUP_SAME | FetchSerializationFlags.OBJECT_ID_PRESENT;

  const objectDeltaBytes = encodeVarint(3n);
  const payloadLengthBytes = encodeVarint(50n);

  const data = new Uint8Array(1 + objectDeltaBytes.length + payloadLengthBytes.length);
  data[0] = flags;
  data.set(objectDeltaBytes, 1);
  data.set(payloadLengthBytes, 1 + objectDeltaBytes.length);

  assertFetchViolation(
    () => decodeFetchObjectFields(data, prior, 0, false),
    SessionErrorCode.DELTA_ENCODING_OVERFLOW,
    /computed object id out of range/,
  );
});

/**
 * draft-ietf-moq-transport-23 §11.4.1 (Fetch Header) / Table 8 / §11.4.2:
 * End of Timed-Out Range (0x20C) が encode / decode で round-trip し、
 * アプリ向け status 種別が "timed_out" になることを検証する。
 */
test("FetchObjectFields: End of Timed-Out Range (0x20C) の round-trip で status 種別が timed_out になる", () => {
  // ワイヤ値の確認 (Table 8)
  assert.equal(FetchSerializationFlags.END_OF_TIMED_OUT_RANGE, 0x20c);

  const timedOut: FetchObjectFields = {
    serializationFlags: FetchSerializationFlags.END_OF_TIMED_OUT_RANGE,
    groupId: 7n,
    objectId: 3n,
    payloadLength: 0n,
  };
  const encoded = encodeFetchObjectFields(timedOut);
  const [decoded, , context] = decodeFetchObjectFields(encoded, null, 0, true);

  // アプリ向け status 種別の検証
  assert.equal(decoded.endOfRange, "timed_out");
  assert.equal(decoded.groupId, 7n);
  assert.equal(decoded.objectId, 3n);
  // End of Range は後続デコードの prior として引き継がれる
  assert.equal(context.groupId, 7n);
  assert.equal(context.objectId, 3n);
});

const endOfRangeCases = [
  { name: "non_existent", flags: FetchSerializationFlags.END_OF_NON_EXISTENT_RANGE },
  { name: "unknown", flags: FetchSerializationFlags.END_OF_UNKNOWN_RANGE },
  { name: "timed_out", flags: FetchSerializationFlags.END_OF_TIMED_OUT_RANGE },
  { name: "gone", flags: FetchSerializationFlags.END_OF_GONE_RANGE },
] as const;

for (const { name, flags } of endOfRangeCases) {
  /**
   * draft-ietf-moq-transport-23 §11.4.2 / §11.4.2.1:
   * End of Range indicator の wire は Serialization Flags + Group ID Delta +
   * Object ID Delta のみ (先頭エントリーは絶対値)。Object Payload Length は
   * 通常 Object のフィールドであり、EOR では読み書きしない。
   */
  test(`FetchObjectFields: End of Range (${name}) は先頭エントリーとして絶対 ID をエンコードする`, () => {
    const groupId = 0x1234n;
    const objectId = 0x5678n;
    const fields: FetchObjectFields = {
      serializationFlags: flags,
      groupId,
      objectId,
      // EOR では wire に書かれないことを確認するため 0 以外を指定する
      payloadLength: 123n,
    };
    const encoded = encodeFetchObjectFields(fields);
    const expected = new Uint8Array([
      ...encodeVarint(flags),
      ...encodeVarint(groupId),
      ...encodeVarint(objectId),
    ]);
    assert.deepEqual(encoded, expected);

    const [decoded, consumed] = decodeFetchObjectFields(encoded, null, 0, true);
    assert.equal(decoded.endOfRange, name);
    assert.equal(decoded.groupId, groupId);
    assert.equal(decoded.objectId, objectId);
    assert.equal(decoded.payloadLength, 0n);
    assert.equal(consumed, expected.length);
  });
}

/**
 * draft-ietf-moq-transport-23 §11.4.2:
 * End of Range indicator の直後に通常 Object が続く場合、EOR の 3 フィールドを
 * 消費した残りバッファから次の Serialization Flags を読み始められることを確認する。
 */
test("FetchObjectFields: End of Range の直後の通常 Object を続けてデコードできる", () => {
  const eorFields: FetchObjectFields = {
    serializationFlags: FetchSerializationFlags.END_OF_UNKNOWN_RANGE,
    groupId: 10n,
    objectId: 5n,
    payloadLength: 0n,
  };
  const eorEncoded = encodeFetchObjectFields(eorFields);
  const [decodedEor, eorConsumed, eorContext] = decodeFetchObjectFields(eorEncoded, null, 0, true);
  assert.equal(decodedEor.endOfRange, "unknown");
  assert.equal(decodedEor.payloadLength, 0n);
  assert.equal(eorConsumed, eorEncoded.length);

  const nextFields: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(),
    groupId: 11n,
    subgroupId: 1n,
    objectId: 6n,
    publisherPriority: 100,
    payloadLength: 0n,
  };
  const nextEncoded = encodeFetchObjectFields(nextFields, false, eorContext);

  const combined = new Uint8Array(eorEncoded.length + nextEncoded.length);
  combined.set(eorEncoded, 0);
  combined.set(nextEncoded, eorEncoded.length);

  const [combinedEor, combinedEorConsumed, combinedContext] = decodeFetchObjectFields(
    combined,
    null,
    0,
    true,
  );
  assert.equal(combinedEor.endOfRange, "unknown");
  assert.equal(combinedEorConsumed, eorEncoded.length);

  const [decodedNext, nextConsumed] = decodeFetchObjectFields(
    combined,
    combinedContext,
    combinedEorConsumed,
    false,
  );
  assert.equal(decodedNext.groupId, 11n);
  assert.equal(decodedNext.subgroupId, 1n);
  assert.equal(decodedNext.objectId, 6n);
  assert.equal(decodedNext.publisherPriority, 100);
  assert.equal(nextConsumed, nextEncoded.length);
});

/**
 * draft-ietf-moq-transport-23 §11.4.1 Table 8:
 * "If an endpoint receives any other value greater than 127, it MUST close the
 *  session with MALFORMED_OBJECT."
 * Table 8 の定義値 (End of Range 4 種、End of Group / End of Track) 以外の
 * 128 以上の値は未定義である。MALFORMED_OBJECT として拒否する。
 */
test("FetchObjectFields: 未定義の 128 以上の flags は MALFORMED_OBJECT で拒否される", () => {
  const prior: FetchObjectContext = {
    groupId: 5n,
    subgroupId: 1n,
    objectId: 5n,
    publisherPriority: 128,
  };

  // 0x30C: 0x20C と近傍だが未定義の不正値
  const undefinedValue = encodeVarint(0x30c);
  assertFetchViolation(
    () => decodeFetchObjectFields(undefinedValue, prior, 0, false),
    SessionErrorCode.MALFORMED_OBJECT,
    /invalid fetch serialization flags/,
  );
});

// ============================================================================
// draft-ietf-moq-transport-23 §11.4.2 / §11.4.2.1: 固定ワイヤでの delta 復号
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §11.4.1 (Fetch Header) / Table 8 / §11.4.2.1:
 * FETCH_HEADER 直後の先頭エントリーが End of Range indicator の場合だけ、
 * Group ID と Object ID は絶対値である。4 種の indicator を固定ワイヤで検証する。
 */
test("FetchObjectFields: FETCH_HEADER 直後の 4 種の End of Range は絶対 ID として復号される", () => {
  // Serialization Flags の固定ワイヤ:
  // 0x8C = [0x80, 0x8C] / 0x10C = [0x81, 0x0C] /
  // 0x20C = [0x82, 0x0C] / 0x40C = [0x84, 0x0C] (いずれも 2 バイト varint)
  const cases = [
    { name: "non_existent", flagBytes: [0x80, 0x8c] },
    { name: "unknown", flagBytes: [0x81, 0x0c] },
    { name: "timed_out", flagBytes: [0x82, 0x0c] },
    { name: "gone", flagBytes: [0x84, 0x0c] },
  ] as const;

  for (const { name, flagBytes } of cases) {
    // Group ID 10 / Object ID 3 の絶対値
    const data = new Uint8Array([...flagBytes, 0x0a, 0x03]);
    const [decoded, consumed, context] = decodeFetchObjectFields(data, null, 0, true);
    assert.equal(decoded.endOfRange, name);
    assert.equal(decoded.groupId, 10n);
    assert.equal(decoded.objectId, 3n);
    // End of Range は Object Payload Length を持たない
    assert.equal(decoded.payloadLength, 0n);
    assert.equal(consumed, data.length);
    // 復号した Location は後続エントリーの prior になる
    assert.equal(context.groupId, 10n);
    assert.equal(context.objectId, 3n);
  }
});

/**
 * draft-ietf-moq-transport-23 §11.4.2.1:
 * 通常 Object の後に初めて現れる End of Range indicator も、絶対 ID ではなく
 * 直前の Object を基準にした delta で復号する。
 */
test("FetchObjectFields: 通常 Object の後の End of Range は直前 Object 基準の delta で復号される", () => {
  // 先頭 Object の固定ワイヤ: Flags 0x1F (GROUP_ID_PRESENT | OBJECT_ID_PRESENT |
  // PRIORITY_PRESENT | SUBGROUP_PRESENT)、Group 10、Subgroup 1、Object 5、
  // Priority 100、Object Payload Length 0
  const firstData = new Uint8Array([0x1f, 0x0a, 0x01, 0x05, 0x64, 0x00]);
  const [first, firstConsumed, firstContext] = decodeFetchObjectFields(firstData, null, 0, true);
  assert.equal(first.groupId, 10n);
  assert.equal(first.objectId, 5n);
  assert.equal(firstConsumed, firstData.length);

  // End of Unknown Range: Group ID Delta 0、Object ID Delta 3
  // → Group 10、Object ID 5 + 3 + 1 = 9。
  // 絶対値として読むと Group ID 0 / Object ID 3 になり、誤読であることが分かる。
  const eorData = new Uint8Array([0x81, 0x0c, 0x00, 0x03]);
  const [eor, eorConsumed, eorContext] = decodeFetchObjectFields(eorData, firstContext, 0, false);
  assert.equal(eor.endOfRange, "unknown");
  assert.equal(eor.groupId, 10n);
  assert.equal(eor.objectId, 9n);
  assert.equal(eorConsumed, eorData.length);

  // Group を変える indicator: Group ID Delta 2 → Group 12、Object ID は絶対値 7
  const changedGroupData = new Uint8Array([0x81, 0x0c, 0x02, 0x07]);
  const [changedGroup, changedGroupConsumed] = decodeFetchObjectFields(
    changedGroupData,
    eorContext,
    0,
    false,
  );
  assert.equal(changedGroup.endOfRange, "unknown");
  assert.equal(changedGroup.groupId, 12n);
  assert.equal(changedGroup.objectId, 7n);
  assert.equal(changedGroupConsumed, changedGroupData.length);
});

/**
 * draft-ietf-moq-transport-23 §11.4.2.1:
 * "the prior Group ID and prior Object ID are the decoded IDs of the most recent
 *  preceding Object or End of Range indicator."
 * 連続する indicator は直前の indicator の復号値を基準にする。
 */
test("FetchObjectFields: 連続する End of Range indicator は直前の indicator を基準に復号される", () => {
  // 1 件目: End of Unknown Range (FETCH_HEADER 直後) の絶対 ID → Group 10 / Object 5
  const firstData = new Uint8Array([0x81, 0x0c, 0x0a, 0x05]);
  const [first, firstConsumed, firstContext] = decodeFetchObjectFields(firstData, null, 0, true);
  assert.equal(first.endOfRange, "unknown");
  assert.equal(first.groupId, 10n);
  assert.equal(first.objectId, 5n);
  assert.equal(firstConsumed, firstData.length);

  // 2 件目: End of Gone Range、Group ID Delta 0、Object ID Delta 2
  // → Group 10、Object ID 5 + 2 + 1 = 8
  const goneData = new Uint8Array([0x84, 0x0c, 0x00, 0x02]);
  const [gone, goneConsumed, goneContext] = decodeFetchObjectFields(
    goneData,
    firstContext,
    0,
    false,
  );
  assert.equal(gone.endOfRange, "gone");
  assert.equal(gone.groupId, 10n);
  assert.equal(gone.objectId, 8n);
  assert.equal(goneConsumed, goneData.length);

  // 3 件目: End of Non-Existent Range、Group ID Delta 1 → Group 11、
  // Object ID は新しい Group の絶対値 0
  const nonExistentData = new Uint8Array([0x80, 0x8c, 0x01, 0x00]);
  const [nonExistent, nonExistentConsumed, nonExistentContext] = decodeFetchObjectFields(
    nonExistentData,
    goneContext,
    0,
    false,
  );
  assert.equal(nonExistent.endOfRange, "non_existent");
  assert.equal(nonExistent.groupId, 11n);
  assert.equal(nonExistent.objectId, 0n);
  assert.equal(nonExistentConsumed, nonExistentData.length);
  // 復号した Location がさらに後続の prior になる
  assert.equal(nonExistentContext.groupId, 11n);
  assert.equal(nonExistentContext.objectId, 0n);
});

/**
 * draft-ietf-moq-transport-23 §11.4.2.1:
 * Descending Group Order の Group ID は prior - Group ID Delta である。
 * 通常 Object の -(Group ID Delta + 1) とは異なる。
 */
test("FetchObjectFields: Descending Group Order の End of Range は prior - Group ID Delta", () => {
  const prior: FetchObjectContext = {
    groupId: 100n,
    subgroupId: 2n,
    objectId: 5n,
    publisherPriority: 90,
  };

  // 同一 Group、Object ID Delta 2 → Group 100 / Object ID 5 + 2 + 1 = 8
  const sameGroupData = new Uint8Array([0x81, 0x0c, 0x00, 0x02]);
  const [sameGroup, sameGroupConsumed, sameGroupContext] = decodeFetchObjectFields(
    sameGroupData,
    prior,
    0,
    false,
    GroupOrder.DESCENDING,
  );
  assert.equal(sameGroup.endOfRange, "unknown");
  assert.equal(sameGroup.groupId, 100n);
  assert.equal(sameGroup.objectId, 8n);
  assert.equal(sameGroupConsumed, sameGroupData.length);

  // Group ID Delta 10 → Group 100 - 10 = 90、Object ID は絶対値 3
  const changedGroupData = new Uint8Array([0x81, 0x0c, 0x0a, 0x03]);
  const [changedGroup] = decodeFetchObjectFields(
    changedGroupData,
    sameGroupContext,
    0,
    false,
    GroupOrder.DESCENDING,
  );
  assert.equal(changedGroup.endOfRange, "unknown");
  assert.equal(changedGroup.groupId, 90n);
  assert.equal(changedGroup.objectId, 3n);
});

/**
 * draft-ietf-moq-transport-23 §11.4.2.2 / §11.4.1.1:
 * End of Range indicator の後で Group が変わる通常 Object は、indicator の
 * 復号位置を prior に Group ID Delta + 1 / 絶対 Object ID で復元する。
 * Subgroup ID / Priority は通常 Object の明示フィールドから取る。
 */
test("FetchObjectFields: End of Range の後の Group 変更 Object を復元できる", () => {
  // 実 Object (Group 10 / Subgroup 1 / Object 5 / Priority 100)
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(),
    groupId: 10n,
    subgroupId: 1n,
    objectId: 5n,
    publisherPriority: 100,
    payloadLength: 0n,
  };
  const [, , firstContext] = decodeFetchObjectFields(encodeFetchObjectFields(first), null, 0, true);

  // End of Unknown Range: Group ID Delta 2 → Group 12、Object ID は絶対値 3
  const eorData = new Uint8Array([0x81, 0x0c, 0x02, 0x03]);
  const [, , eorContext] = decodeFetchObjectFields(eorData, firstContext, 0, false);

  // 後続 Object: Flags 0x1F (GROUP_ID_PRESENT | OBJECT_ID_PRESENT |
  // PRIORITY_PRESENT | SUBGROUP_PRESENT)、Group ID Delta 0 → Group 13、
  // Subgroup 3、Object ID 4 (絶対値)、Priority 60、Object Payload Length 0
  const data = new Uint8Array([0x1f, 0x00, 0x03, 0x04, 0x3c, 0x00]);
  const [decoded, consumed] = decodeFetchObjectFields(data, eorContext, 0, false);
  assert.equal(decoded.groupId, 13n);
  assert.equal(decoded.subgroupId, 3n);
  assert.equal(decoded.objectId, 4n);
  assert.equal(decoded.publisherPriority, 60);
  assert.equal(consumed, data.length);
});

/**
 * draft-ietf-moq-transport-23 §2.1.2:
 * "receiving an Object that was recorded as Gone or Unknown is not an error."
 * End of Gone Range の後の実 Object は矛盾ではなく受理する。範囲と実 Object の
 * 突き合わせは Track 単位の状態追跡の責務であり、このモジュールは復号して返す
 * だけである。
 */
test("FetchObjectFields: End of Gone Range の後の実 Object を受理する", () => {
  // FETCH_HEADER 直後の End of Gone Range: Group 10 / Object 5 (絶対値)
  const eorData = new Uint8Array([0x84, 0x0c, 0x0a, 0x05]);
  const [eor, , eorContext] = decodeFetchObjectFields(eorData, null, 0, true);
  assert.equal(eor.endOfRange, "gone");
  assert.equal(eor.groupId, 10n);
  assert.equal(eor.objectId, 5n);

  // Gone と同じ Group の実 Object を続ける: Flags 0x17
  // (SUBGROUP_PRESENT | OBJECT_ID_PRESENT | PRIORITY_PRESENT)、
  // Subgroup 1、Object ID Delta 0 → 5 + 0 + 2 = 7、Priority 70
  const data = new Uint8Array([0x17, 0x01, 0x00, 0x46, 0x00]);
  const [decoded, consumed] = decodeFetchObjectFields(data, eorContext, 0, false);
  assert.equal(decoded.groupId, 10n);
  assert.equal(decoded.subgroupId, 1n);
  assert.equal(decoded.objectId, 7n);
  assert.equal(decoded.publisherPriority, 70);
  assert.equal(consumed, data.length);
});

/**
 * draft-ietf-moq-transport-23 §11.4.2:
 * End of Range indicator は Serialization Flags + Group ID Delta + Object ID Delta
 * の 3 フィールドだけである。途中で切れた場合は IncompleteDataError で
 * 次のチャンクを待つ。
 */
test("FetchObjectFields: 不完全な End of Range indicator は IncompleteDataError", () => {
  const prior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 1n,
    objectId: 5n,
    publisherPriority: 100,
  };

  // Flags のみ (Group ID Delta がない)
  assert.throws(
    () => decodeFetchObjectFields(new Uint8Array([0x84, 0x0c]), prior, 0, false),
    IncompleteDataError,
  );
  // Group ID Delta の途中 (2 バイト varint の 1 バイト目のみ)
  assert.throws(
    () => decodeFetchObjectFields(new Uint8Array([0x84, 0x0c, 0x80]), prior, 0, false),
    IncompleteDataError,
  );
  // Object ID Delta がない
  assert.throws(
    () => decodeFetchObjectFields(new Uint8Array([0x84, 0x0c, 0x00]), prior, 0, false),
    IncompleteDataError,
  );
  // FETCH_HEADER 直後の絶対 ID 形式でも、Object ID が欠ければ同じ
  assert.throws(
    () => decodeFetchObjectFields(new Uint8Array([0x80, 0x8c, 0x0a]), null, 0, true),
    IncompleteDataError,
  );
});

/**
 * draft-ietf-moq-transport-23 §11.4.2.1:
 * "If either decoded ID is less than zero or greater than 2^64-1, the Subscriber
 *  MUST close the Session with DELTA_ENCODING_OVERFLOW."
 * 受信経路は DELTA_ENCODING_OVERFLOW として扱う。
 */
test("FetchObjectFields: End of Range の算術 overflow は DELTA_ENCODING_OVERFLOW", () => {
  // Ascending: prior Group ID 2^64-2 + Group ID Delta 2 = 2^64 (超過)
  const nearMaxGroup: FetchObjectContext = {
    groupId: MAX_VARINT - 1n,
    subgroupId: 0n,
    objectId: 0n,
    publisherPriority: 0,
  };
  assertFetchViolation(
    () => decodeFetchObjectFields(new Uint8Array([0x80, 0x8c, 0x02, 0x00]), nearMaxGroup, 0, false),
    SessionErrorCode.DELTA_ENCODING_OVERFLOW,
    /computed end of range group id out of range/,
  );

  // Descending: prior Group ID 1 - Group ID Delta 2 = -1 (負数)
  const lowGroup: FetchObjectContext = {
    groupId: 1n,
    subgroupId: 0n,
    objectId: 0n,
    publisherPriority: 0,
  };
  assertFetchViolation(
    () =>
      decodeFetchObjectFields(
        new Uint8Array([0x80, 0x8c, 0x02, 0x00]),
        lowGroup,
        0,
        false,
        GroupOrder.DESCENDING,
      ),
    SessionErrorCode.DELTA_ENCODING_OVERFLOW,
    /computed end of range group id out of range/,
  );

  // 同一 Group: prior Object ID 2^64-2 + Object ID Delta 1 + 1 = 2^64 (超過)
  const nearMaxObject: FetchObjectContext = {
    groupId: 0n,
    subgroupId: 0n,
    objectId: MAX_VARINT - 1n,
    publisherPriority: 0,
  };
  assertFetchViolation(
    () =>
      decodeFetchObjectFields(new Uint8Array([0x80, 0x8c, 0x00, 0x01]), nearMaxObject, 0, false),
    SessionErrorCode.DELTA_ENCODING_OVERFLOW,
    /computed end of range object id out of range/,
  );
});

/**
 * draft-ietf-moq-transport-23 §11.4.2.1:
 * 復号結果がちょうど 0 / 2^64-1 になる境界は許容する
 * (DELTA_ENCODING_OVERFLOW は 0 未満・2^64-1 超過だけ)。
 */
test("FetchObjectFields: End of Range の ID が 0 / 2^64-1 になる境界は復号できる", () => {
  // 同一 Group: prior Object ID 2^64-2 + Object ID Delta 0 + 1 = 2^64-1
  const prior: FetchObjectContext = {
    groupId: 5n,
    subgroupId: 1n,
    objectId: MAX_VARINT - 1n,
    publisherPriority: 100,
  };
  const [decoded] = decodeFetchObjectFields(
    new Uint8Array([0x80, 0x8c, 0x00, 0x00]),
    prior,
    0,
    false,
  );
  assert.equal(decoded.groupId, 5n);
  assert.equal(decoded.objectId, MAX_VARINT);

  // Descending: prior Group ID 2 - Group ID Delta 2 = 0 (0 は許容される)
  const descendingPrior: FetchObjectContext = {
    groupId: 2n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
  };
  const [descended] = decodeFetchObjectFields(
    new Uint8Array([0x80, 0x8c, 0x02, 0x00]),
    descendingPrior,
    0,
    false,
    GroupOrder.DESCENDING,
  );
  assert.equal(descended.groupId, 0n);
  assert.equal(descended.objectId, 0n);
});

/**
 * draft-ietf-moq-transport-23 §11.4.2.1:
 * 送信側も受信側と対称の式で delta を組み立てる。表現できない移動
 * (Group Order と逆方向の Group 移動、同一 Group で増分 1 未満の Object ID)
 * と範囲外の ID は送信前に拒否する。
 */
test("FetchObjectFields: 表現できない End of Range の delta は送信前に拒否される", () => {
  const prior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 1n,
    objectId: 5n,
    publisherPriority: 100,
  };
  const eorFields = (groupId: bigint, objectId: bigint): FetchObjectFields => ({
    serializationFlags: FetchSerializationFlags.END_OF_UNKNOWN_RANGE,
    groupId,
    objectId,
    payloadLength: 0n,
  });

  // Ascending で Group が逆方向になり Group ID Delta が負になる
  assert.throws(
    () => encodeFetchObjectFields(eorFields(9n, 0n), false, prior),
    /end of range group id delta cannot be negative/,
  );
  // Descending で Group が逆方向になり Group ID Delta が負になる
  assert.throws(
    () => encodeFetchObjectFields(eorFields(11n, 0n), false, prior, GroupOrder.DESCENDING),
    /end of range group id delta cannot be negative/,
  );
  // 同一 Group で Object ID が prior + 1 未満 (Delta で表現できない)
  for (const objectId of [5n, 4n]) {
    assert.throws(
      () => encodeFetchObjectFields(eorFields(10n, objectId), false, prior),
      /end of range object id delta cannot represent object id/,
    );
  }
  // varint の範囲外 (負数・2^64-1 超過)
  assert.throws(
    () => encodeFetchObjectFields(eorFields(MAX_VARINT + 1n, 0n), false, null),
    /group id out of range/,
  );
  assert.throws(
    () => encodeFetchObjectFields(eorFields(1n, MAX_VARINT + 1n), false, null),
    /object id out of range/,
  );
  assert.throws(
    () => encodeFetchObjectFields(eorFields(-1n, 0n), false, null),
    /group id out of range/,
  );
  assert.throws(
    () => encodeFetchObjectFields(eorFields(1n, -1n), false, null),
    /object id out of range/,
  );
});

/**
 * draft-ietf-moq-transport-23 §11.4.2.1:
 * 送信側の End of Range delta 形式。Group 変更時は絶対 Object ID を書き、
 * 同一 Group では prior + Object ID Delta + 1 になる Delta を書く。
 * Object Payload Length は書かない。
 */
test("FetchObjectFields: End of Range の delta 形式の固定ワイヤ", () => {
  const ascendingPrior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 1n,
    objectId: 5n,
    publisherPriority: 100,
  };

  // Group 変更 (Group ID Delta 2) → Object ID は絶対値 7
  assert.deepEqual(
    encodeFetchObjectFields(
      {
        serializationFlags: FetchSerializationFlags.END_OF_TIMED_OUT_RANGE,
        groupId: 12n,
        objectId: 7n,
        payloadLength: 0n,
      },
      false,
      ascendingPrior,
    ),
    new Uint8Array([0x82, 0x0c, 0x02, 0x07]),
  );

  // 同一 Group (Group ID Delta 0) → Object ID Delta = 8 - 5 - 1 = 2
  assert.deepEqual(
    encodeFetchObjectFields(
      {
        serializationFlags: FetchSerializationFlags.END_OF_TIMED_OUT_RANGE,
        groupId: 10n,
        objectId: 8n,
        payloadLength: 0n,
      },
      false,
      ascendingPrior,
    ),
    new Uint8Array([0x82, 0x0c, 0x00, 0x02]),
  );

  // Descending: prior 100 → Group 90 は Group ID Delta 10、Object ID は絶対値 3
  const descendingPrior: FetchObjectContext = {
    groupId: 100n,
    subgroupId: 1n,
    objectId: 5n,
    publisherPriority: 100,
  };
  assert.deepEqual(
    encodeFetchObjectFields(
      {
        serializationFlags: FetchSerializationFlags.END_OF_TIMED_OUT_RANGE,
        groupId: 90n,
        objectId: 3n,
        payloadLength: 0n,
      },
      false,
      descendingPrior,
      GroupOrder.DESCENDING,
    ),
    new Uint8Array([0x82, 0x0c, 0x0a, 0x03]),
  );
});

// ============================================================================
// draft-ietf-moq-transport-23 §11.4.2.2: End of Group / End of Track indicator
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §11.4.2.2 (Prior Object Fields):
 * "When Serialization Flags is 0x80 (End of Group) or 0x81 (End of Track),
 *  no other fields are present. ... The prior Object ID becomes 2^64-1."
 * End of Group / End of Track は Flags だけを消費する indicator であり、直前の
 * 実 Object の位置を Group / Track の終端として返す。受理後は後続の ID 復元に
 * 使う prior Object ID が 2^64-1 になる。End of Track は Group の終端も意味する
 * ため、連続させても同じ実 Object の位置を使う。
 */
test("FetchObjectFields: End of Group / End of Track は Flags だけで消費される", () => {
  // 実 Object: Flags 0x1F (GROUP_ID_PRESENT | OBJECT_ID_PRESENT |
  // PRIORITY_PRESENT | SUBGROUP_PRESENT)、Group 10、Subgroup 1、Object 5、
  // Priority 100、Payload Length 2、Payload [0xAA, 0xBB]
  const objectData = new Uint8Array([0x1f, 0x0a, 0x01, 0x05, 0x64, 0x02, 0xaa, 0xbb]);
  const [, objectConsumed, objectContext] = decodeFetchObjectFields(objectData, null, 0, true);
  // 復号が消費するのはフィールドまでであり、Payload 2 バイトは含まない
  assert.equal(objectConsumed, objectData.length - 2);

  // End of Group (0x80) の varint は 2 バイト [0x80, 0x80]
  const eogData = new Uint8Array([0x80, 0x80]);
  const [eog, eogConsumed, eogContext] = decodeFetchObjectFields(eogData, objectContext, 0, false);
  // Flags だけを消費し、Group ID / Object ID / Payload Length は読まない
  assert.equal(eogConsumed, 2);
  assert.equal(eog.streamEnd?.kind, "end_of_group");
  // 終端位置は直前の実 Object である (End of Range の範囲端ではない)
  assert.equal(eog.streamEnd?.groupId, 10n);
  assert.equal(eog.streamEnd?.objectId, 5n);
  assert.equal(eog.groupId, 10n);
  assert.equal(eog.objectId, 5n);
  // indicator は Object ではないため Payload Length は 0
  assert.equal(eog.payloadLength, 0n);
  // Subgroup ID / Priority は最後の実 Object から引き継ぐ
  assert.equal(eog.subgroupId, 1n);
  assert.equal(eog.publisherPriority, 100);
  // 後続の prior Object ID は 2^64-1 になる
  assert.equal(eogContext.objectId, MAX_VARINT);
  assert.equal(eogContext.groupId, 10n);
  // 終端の参照先として最後の実 Object の位置を保持し続ける
  assert.deepEqual(eogContext.lastActualObject, { groupId: 10n, objectId: 5n });

  // End of Track (0x81) の varint は 2 バイト [0x80, 0x81]。
  // 直前が End of Group でも終端の参照先は同じ最後の実 Object である。
  const eotData = new Uint8Array([0x80, 0x81]);
  const [eot, eotConsumed, eotContext] = decodeFetchObjectFields(eotData, eogContext, 0, false);
  assert.equal(eotConsumed, 2);
  assert.equal(eot.streamEnd?.kind, "end_of_track");
  assert.equal(eot.streamEnd?.groupId, 10n);
  assert.equal(eot.streamEnd?.objectId, 5n);
  assert.equal(eotContext.objectId, MAX_VARINT);
  assert.deepEqual(eotContext.lastActualObject, { groupId: 10n, objectId: 5n });
});

/**
 * draft-ietf-moq-transport-23 §11.4.2.1 / §11.4.2.2:
 * Group ID Delta が非 0 の End of Range indicator を挟んで End of Group が来る場合、
 * 終端位置は最後の実 Object のまま、復号文脈の Group ID は EOR の復号値を維持する。
 * 同節は prior Object ID だけを 2^64-1 にすると定め、prior Group ID には触れない。
 */
test("FetchObjectFields: Group 変更 End of Range の後の End of Group は実 Object の位置を終端にする", () => {
  // 実 Object: Group 10 / Subgroup 1 / Object 5 / Priority 100
  const objectData = new Uint8Array([0x1f, 0x0a, 0x01, 0x05, 0x64, 0x00]);
  const [, , objectContext] = decodeFetchObjectFields(objectData, null, 0, true);

  // End of Unknown Range: Group ID Delta 2 → 10 + 2 = 12。Group が変わるため
  // Object ID Delta 0 は新しい Group の絶対 Object ID 0 になる。
  // 終端位置は実 Object の {10, 5} のまま
  const [, , eorContext] = decodeFetchObjectFields(
    new Uint8Array([0x81, 0x0c, 0x02, 0x00]),
    objectContext,
    0,
    false,
  );
  assert.equal(eorContext.groupId, 12n);
  assert.equal(eorContext.objectId, 0n);
  assert.deepEqual(eorContext.lastActualObject, { groupId: 10n, objectId: 5n });

  // End of Group: 終端位置は最後の実 Object の {10, 5}
  const [eog, consumed, eogContext] = decodeFetchObjectFields(
    new Uint8Array([0x80, 0x80]),
    eorContext,
    0,
    false,
  );
  assert.equal(consumed, 2);
  assert.equal(eog.streamEnd?.kind, "end_of_group");
  assert.deepEqual(eog.streamEnd, { kind: "end_of_group", groupId: 10n, objectId: 5n });
  // prior Group ID は EOR の復号値 12 を維持し、prior Object ID だけが 2^64-1 になる
  assert.equal(eogContext.groupId, 12n);
  assert.equal(eogContext.objectId, MAX_VARINT);
  assert.deepEqual(eogContext.lastActualObject, { groupId: 10n, objectId: 5n });

  // End of Group の後は別 Group の Object が続き得る (Group ID Delta 0 → 13)
  const nextData = new Uint8Array([0x0c, 0x00, 0x00, 0x00]);
  const [next] = decodeFetchObjectFields(nextData, eogContext, 0, false);
  assert.equal(next.groupId, 13n);
  assert.equal(next.objectId, 0n);
});

/**
 * draft-ietf-moq-transport-23 §11.4.2.2:
 * End of Group の後は新しい Group の Object が続き得る。prior Object ID が
 * 2^64-1 になった後でも、Group ID Delta と新しい Group の絶対 Object ID を
 * 持つ Object は正しく復号できる。
 */
test("FetchObjectFields: End of Group の後の Group 変更 Object を復号できる", () => {
  // 実 Object: Group 10 / Subgroup 1 / Object 5 / Priority 100
  const objectData = new Uint8Array([0x1f, 0x0a, 0x01, 0x05, 0x64, 0x00]);
  const [, , objectContext] = decodeFetchObjectFields(objectData, null, 0, true);

  // End of Group: {Group 10, Object 5} が最終 Object
  const [, , eogContext] = decodeFetchObjectFields(
    new Uint8Array([0x80, 0x80]),
    objectContext,
    0,
    false,
  );

  // 次の Group 11 の先頭 Object: Flags 0x0C
  // (GROUP_ID_PRESENT | OBJECT_ID_PRESENT)、Group ID Delta 0 → 10 + 0 + 1 = 11、
  // Object ID は新しい Group の絶対値 0、Priority は直前の実 Object の 100 を継承、
  // Payload Length 3、Payload [0xCC, 0xDD, 0xEE]
  const nextData = new Uint8Array([0x0c, 0x00, 0x00, 0x03, 0xcc, 0xdd, 0xee]);
  const [decoded, consumed, nextContext] = decodeFetchObjectFields(nextData, eogContext, 0, false);
  assert.equal(decoded.groupId, 11n);
  assert.equal(decoded.objectId, 0n);
  assert.equal(decoded.subgroupId, 0n);
  assert.equal(decoded.publisherPriority, 100);
  assert.equal(decoded.payloadLength, 3n);
  // 復号が消費するのはフィールドまでであり、Payload 3 バイトは含まない
  assert.equal(consumed, nextData.length - 3);
  // 新しい実 Object が終端の参照先になる
  assert.deepEqual(nextContext.lastActualObject, { groupId: 11n, objectId: 0n });
  assert.equal(nextContext.objectId, 0n);
});

/**
 * draft-ietf-moq-transport-23 §11.4.2.2:
 * End of Group / End of Track の参照先は「直前の実 Object」であり、間に
 * End of Range indicator を挟んでも変化しない。算術用の prior Object ID は
 * End of Range の復号位置に進むが、終端位置には使わない。
 */
test("FetchObjectFields: End of Range を挟んだ終端 indicator は最後の実 Object を参照する", () => {
  // 実 Object: Group 10 / Subgroup 1 / Object 5 / Priority 100
  const objectData = new Uint8Array([0x1f, 0x0a, 0x01, 0x05, 0x64, 0x00]);
  const [, , objectContext] = decodeFetchObjectFields(objectData, null, 0, true);

  // End of Unknown Range: Group ID Delta 0 / Object ID Delta 4
  // → Group 10、Object 5 + 4 + 1 = 10。算術用の prior は {10, 10} になる。
  const eorData = new Uint8Array([0x81, 0x0c, 0x00, 0x04]);
  const [eor, , eorContext] = decodeFetchObjectFields(eorData, objectContext, 0, false);
  assert.equal(eor.endOfRange, "unknown");
  assert.equal(eor.objectId, 10n);
  assert.equal(eorContext.objectId, 10n);
  assert.deepEqual(eorContext.lastActualObject, { groupId: 10n, objectId: 5n });

  // End of Group は End of Range の範囲端 {10, 10} ではなく実 Object {10, 5} を
  // 終端にする。
  const [eog, , eogContext] = decodeFetchObjectFields(
    new Uint8Array([0x80, 0x80]),
    eorContext,
    0,
    false,
  );
  assert.equal(eog.streamEnd?.kind, "end_of_group");
  assert.equal(eog.streamEnd?.groupId, 10n);
  assert.equal(eog.streamEnd?.objectId, 5n);

  // End of Track も同じ位置を再利用する (Object → End of Group → End of Track)
  const [eot] = decodeFetchObjectFields(new Uint8Array([0x80, 0x81]), eogContext, 0, false);
  assert.equal(eot.streamEnd?.kind, "end_of_track");
  assert.equal(eot.streamEnd?.groupId, 10n);
  assert.equal(eot.streamEnd?.objectId, 5n);
});

/**
 * draft-ietf-moq-transport-23 §11.4.2.2:
 * 前提となる実 Object を受信していない End of Group / End of Track は、存在しない
 * prior Object への参照として MALFORMED_OBJECT で拒否する。
 */
test("FetchObjectFields: 実 Object の無い End of Group / End of Track は MALFORMED_OBJECT", () => {
  // 先頭レコード (context なし) の indicator
  assertFetchViolation(
    () => decodeFetchObjectFields(new Uint8Array([0x80, 0x80]), null, 0, true),
    SessionErrorCode.MALFORMED_OBJECT,
    /end of group indicator requires a prior actual object/,
  );
  assertFetchViolation(
    () => decodeFetchObjectFields(new Uint8Array([0x80, 0x81]), null, 0, true),
    SessionErrorCode.MALFORMED_OBJECT,
    /end of track indicator requires a prior actual object/,
  );

  // 先頭レコードが End of Range の場合、実 Object はまだ 1 件も無い
  const [, , eorContext] = decodeFetchObjectFields(
    new Uint8Array([0x81, 0x0c, 0x0a, 0x05]),
    null,
    0,
    true,
  );
  assertFetchViolation(
    () => decodeFetchObjectFields(new Uint8Array([0x80, 0x80]), eorContext, 0, false),
    SessionErrorCode.MALFORMED_OBJECT,
    /requires a prior actual object/,
  );
});

/**
 * draft-ietf-moq-transport-23 §11.4.2.2:
 * End of Group / End of Track は Flags (vi64) だけを持つ。varint が途中で切れた
 * 場合は IncompleteDataError で次のチャンクを待つ。
 */
test("FetchObjectFields: 不完全な End of Group / End of Track は IncompleteDataError", () => {
  const prior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 1n,
    objectId: 5n,
    publisherPriority: 100,
    lastActualObject: { groupId: 10n, objectId: 5n },
  };

  // 2 バイト varint の 1 バイト目だけ
  assert.throws(
    () => decodeFetchObjectFields(new Uint8Array([0x80]), prior, 0, false),
    IncompleteDataError,
  );
  assert.throws(
    () => decodeFetchObjectFields(new Uint8Array([0x81]), prior, 0, false),
    IncompleteDataError,
  );
});

/**
 * draft-ietf-moq-transport-23 §11.4.2.2:
 * 送信側も End of Group / End of Track を Flags だけで符号化する。decode と対称に
 * 他のフィールドを書かない。
 */
test("FetchObjectFields: End of Group / End of Track は Flags だけで符号化される", () => {
  assert.deepEqual(
    encodeFetchObjectFields({
      serializationFlags: FetchSerializationFlags.END_OF_GROUP,
      payloadLength: 0n,
    }),
    new Uint8Array([0x80, 0x80]),
  );
  assert.deepEqual(
    encodeFetchObjectFields({
      serializationFlags: FetchSerializationFlags.END_OF_TRACK,
      payloadLength: 0n,
    }),
    new Uint8Array([0x80, 0x81]),
  );

  // 符号化した wire は decode で同じ終端種別になる
  const prior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 1n,
    objectId: 5n,
    publisherPriority: 100,
    lastActualObject: { groupId: 10n, objectId: 5n },
  };
  const encoded = encodeFetchObjectFields({
    serializationFlags: FetchSerializationFlags.END_OF_TRACK,
    payloadLength: 0n,
  });
  const [decoded, consumed] = decodeFetchObjectFields(encoded, prior, 0, false);
  assert.equal(consumed, encoded.length);
  assert.equal(decoded.streamEnd?.kind, "end_of_track");
  assert.equal(decoded.streamEnd?.objectId, 5n);
});

/**
 * draft-ietf-moq-transport-23 §11.4.2.2:
 * "The prior Object ID becomes 2^64-1."
 * 終端 indicator の後で Object ID Delta を省略した Object は prior + 1 を意味する
 * ため 2^64 になり、DELTA_ENCODING_OVERFLOW として拒否される。prior Object ID が
 * 2^64-1 に更新されていることの確認でもある。
 */
test("FetchObjectFields: End of Group の後の Object は prior 2^64-1 の加算で overflow する", () => {
  const objectData = new Uint8Array([0x1f, 0x0a, 0x01, 0x05, 0x64, 0x00]);
  const [, , objectContext] = decodeFetchObjectFields(objectData, null, 0, true);
  const [, , eogContext] = decodeFetchObjectFields(
    new Uint8Array([0x80, 0x80]),
    objectContext,
    0,
    false,
  );

  // Flags 0x08 (GROUP_ID_PRESENT のみ、Object ID Delta 省略) は Group 11 へ移り、
  // Object ID は Group の有無に関わらず prior + 1 で 2^64-1 + 1 になり範囲外になる。
  assertFetchViolation(
    () => decodeFetchObjectFields(new Uint8Array([0x08, 0x00]), eogContext, 0, false),
    SessionErrorCode.DELTA_ENCODING_OVERFLOW,
    /computed object id out of range/,
  );
});

// ============================================================================
// draft-23 適合監査 D-13: End of Range が先頭レコードのときの prior 参照
// draft-ietf-moq-transport-23 §11.4.2.2
// ============================================================================

/**
 * 先頭レコードが End of Range indicator のコンテキストを作る。
 * End of Range 自体は実 Object ではないため hasPriorActualObject は false。
 */
function firstRecordEndOfRangeContext(): FetchObjectContext {
  const eor: FetchObjectFields = {
    serializationFlags: FetchSerializationFlags.END_OF_UNKNOWN_RANGE,
    groupId: 10n,
    objectId: 5n,
    payloadLength: 0n,
  };
  const [, , context] = decodeFetchObjectFields(encodeFetchObjectFields(eor), null, 0, true);
  return context;
}

/**
 * draft-ietf-moq-transport-23 §11.4.2.2:
 * "Prior Subgroup ID: The Subgroup ID from the last actual Object before the
 *  End of Range indicator. If there was no prior Object, an endpoint that
 *  receives a flag referencing the prior Subgroup ID MUST close the session
 *  with MALFORMED_OBJECT."
 * 受信経路は MALFORMED_OBJECT として扱う。
 */
test("FetchObjectFields: 先頭レコードが End of Range の後の SUBGROUP_SAME は MALFORMED_OBJECT", () => {
  const context = firstRecordEndOfRangeContext();
  const next: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_SAME | FetchSerializationFlags.PRIORITY_PRESENT,
    objectId: 6n,
    publisherPriority: 100,
    payloadLength: 0n,
  };
  const encoded = encodeFetchObjectFields(next, false, context);

  assertFetchViolation(
    () => decodeFetchObjectFields(encoded, context, 0, false),
    SessionErrorCode.MALFORMED_OBJECT,
    /cannot reference prior subgroup id before any actual object/,
  );
});

test("FetchObjectFields: 先頭レコードが End of Range の後の SUBGROUP_PLUS_ONE は MALFORMED_OBJECT", () => {
  const context = firstRecordEndOfRangeContext();
  const next: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_PLUS_ONE | FetchSerializationFlags.PRIORITY_PRESENT,
    objectId: 6n,
    publisherPriority: 100,
    payloadLength: 0n,
  };
  const encoded = encodeFetchObjectFields(next, false, context);

  assertFetchViolation(
    () => decodeFetchObjectFields(encoded, context, 0, false),
    SessionErrorCode.MALFORMED_OBJECT,
    /cannot reference prior subgroup id before any actual object/,
  );
});

/**
 * draft-ietf-moq-transport-23 §11.4.2.2:
 * "Prior Priority: The Priority from the last actual Object before the End of
 *  Range indicator. If there was no prior Object, an endpoint that receives a
 *  flag referencing the prior Priority MUST close the session with
 *  MALFORMED_OBJECT."
 * 受信経路は MALFORMED_OBJECT として扱う。
 */
test("FetchObjectFields: 先頭レコードが End of Range の後の PRIORITY 省略は MALFORMED_OBJECT", () => {
  const context = firstRecordEndOfRangeContext();
  const next: FetchObjectFields = {
    serializationFlags: FetchSerializationFlags.SUBGROUP_PRESENT,
    subgroupId: 1n,
    objectId: 6n,
    payloadLength: 0n,
  };
  const encoded = encodeFetchObjectFields(next, false, context);

  assertFetchViolation(
    () => decodeFetchObjectFields(encoded, context, 0, false),
    SessionErrorCode.MALFORMED_OBJECT,
    /cannot reference prior priority before any actual object/,
  );
});

/**
 * prior Subgroup ID / prior Priority を参照しないフラグ (SUBGROUP_PRESENT +
 * PRIORITY_PRESENT) は、先頭レコードが End of Range でも正常にデコードできる
 * ことを検証する (誤検出防止)。
 */
test("FetchObjectFields: 先頭レコードが End of Range でも明示指定ならデコードできる", () => {
  const context = firstRecordEndOfRangeContext();
  const next: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_PRESENT | FetchSerializationFlags.PRIORITY_PRESENT,
    subgroupId: 1n,
    objectId: 6n,
    publisherPriority: 100,
    payloadLength: 0n,
  };
  const encoded = encodeFetchObjectFields(next, false, context);

  const [decoded, , nextContext] = decodeFetchObjectFields(encoded, context, 0, false);
  assert.equal(decoded.publisherPriority, 100);
  assert.equal(decoded.subgroupId, 1n);
  // 実 Object をデコードしたため、以後は prior 参照が可能になる
  assert.equal(nextContext.hasPriorActualObject, true);
});

/**
 * draft-ietf-moq-transport-23 §11.4.2.2:
 * 先頭から End of Range indicator が連続する場合も実 Object は 1 件も無いため、
 * prior Subgroup ID / prior Priority を参照するフラグは拒否される。
 */
test("FetchObjectFields: 先頭から End of Range が連続しても実 Object が無ければ継承参照は ProtocolViolationError", () => {
  const firstContext = firstRecordEndOfRangeContext();

  // 2 件目の End of Range (Group ID Delta 0、Object ID Delta 1)
  const secondEorData = new Uint8Array([0x84, 0x0c, 0x00, 0x01]);
  const [, , secondContext] = decodeFetchObjectFields(secondEorData, firstContext, 0, false);
  // indicator は実 Object ではないため、先行する実 Object の有無は false のまま
  assert.equal(secondContext.hasPriorActualObject, false);

  // 実 Object が無いまま prior Subgroup ID を参照する
  const subgroupReference = new Uint8Array([0x01, 0x00]);
  assert.throws(
    () => decodeFetchObjectFields(subgroupReference, secondContext, 0, false),
    ProtocolViolationError,
    /cannot reference prior subgroup id before any actual object/,
  );

  // 実 Object が無いまま prior Priority を省略して参照する
  const priorityReference = new Uint8Array([0x03, 0x01, 0x00]);
  assert.throws(
    () => decodeFetchObjectFields(priorityReference, secondContext, 0, false),
    ProtocolViolationError,
    /cannot reference prior priority before any actual object/,
  );
});

// ============================================================================
// draft-22 適合監査 D-7: Prior Group ID Gap / Prior Object ID Gap
// draft-ietf-moq-transport-23 §10.8 / §10.9
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §10.8:
 * "An Object has a Prior Group ID Gap larger than the Group ID."
 * Fetch Object でも単一 Object で判定できる malformed 条件を検出する。
 */
test("FetchObjectFields: Prior Group ID Gap が Group ID より大きいと MalformedTrackError", () => {
  const fields: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(true),
    groupId: 0n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    properties: encodeProperties([{ id: MOQTPropertyId.PRIOR_GROUP_ID_GAP, value: 1n }]),
    payloadLength: 0n,
  };
  const encoded = encodeFetchObjectFields(fields);

  assert.throws(
    () => decodeFetchObjectFields(encoded, null, 0, true),
    MalformedTrackError,
    /prior group id gap exceeds group id/,
  );
});

/**
 * draft-ietf-moq-transport-23 §10.9:
 * "An Object has a Prior Object ID Gap larger than the Object ID."
 */
test("FetchObjectFields: Prior Object ID Gap が Object ID より大きいと MalformedTrackError", () => {
  const fields: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(true),
    groupId: 0n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    properties: encodeProperties([{ id: MOQTPropertyId.PRIOR_OBJECT_ID_GAP, value: 1n }]),
    payloadLength: 0n,
  };
  const encoded = encodeFetchObjectFields(fields);

  assert.throws(
    () => decodeFetchObjectFields(encoded, null, 0, true),
    MalformedTrackError,
    /prior object id gap exceeds object id/,
  );
});

/**
 * draft-ietf-moq-transport-23 §10.8 / §10.9:
 * "An Object contains more than one instance of Prior Group ID Gap." /
 * "An Object contains more than one instance of Prior Object ID Gap." → malformed
 * Fetch Object でも同一 Object 内の複数出現を検出する。
 */
test("FetchObjectFields: PRIOR_GROUP_ID_GAP の複数出現で MalformedTrackError", () => {
  const fields: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(true),
    groupId: 0n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    properties: encodeProperties([
      { id: MOQTPropertyId.PRIOR_GROUP_ID_GAP, value: 0n },
      { id: MOQTPropertyId.PRIOR_GROUP_ID_GAP, value: 0n },
    ]),
    payloadLength: 0n,
  };
  const encoded = encodeFetchObjectFields(fields);

  assert.throws(
    () => decodeFetchObjectFields(encoded, null, 0, true),
    MalformedTrackError,
    /more than one instance of PRIOR_GROUP_ID_GAP/,
  );
});

/**
 * draft-ietf-moq-transport-23 §10.7 / §10.9:
 * mutable list と IMMUTABLE_PROPERTIES 配下を合わせて 2 回現れる場合も malformed とする。
 */
/**
 * draft-ietf-moq-transport-23 §8.3:
 * "If a receiver understands a Type, and the following Value or Length/Value
 *  does not match the serialization defined by that Type, the receiver MUST
 *  close the session with MALFORMED_KEY_VALUE."
 * 既知 Type の Value が varint として完結しない Fetch Object を検出する。
 */
test("FetchObjectFields: 既知 Type の Value 不一致で MALFORMED_KEY_VALUE", () => {
  const fields: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(true),
    groupId: 0n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    // deltaId=0x02 (OBJECT_DELIVERY_TIMEOUT), value=0x80 (varint が完結しない)
    properties: new Uint8Array([0x02, 0x80]),
    payloadLength: 0n,
  };
  const encoded = encodeFetchObjectFields(fields);

  const thrown = captureThrownError(() => decodeFetchObjectFields(encoded, null, 0, true));
  assert.instanceOf(thrown, SessionError);
  assert.equal((thrown as SessionError).code, SessionErrorCode.MALFORMED_KEY_VALUE);
  assert.match(
    (thrown as SessionError).message,
    /key-value-pair value does not match serialization/,
  );
});

/**
 * draft-ietf-moq-transport-23 §8.3:
 * 既知 Type の Length 宣言が残りバイトを超える Fetch Object を検出する。
 */
test("FetchObjectFields: 既知 Type の Length 宣言超過で MALFORMED_KEY_VALUE", () => {
  const fields: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(true),
    groupId: 0n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    // deltaId=0x0B (IMMUTABLE_PROPERTIES), length=5 宣言 + 2 バイトの切り詰め
    properties: new Uint8Array([0x0b, 0x05, 0xaa, 0xbb]),
    payloadLength: 0n,
  };
  const encoded = encodeFetchObjectFields(fields);

  const thrown = captureThrownError(() => decodeFetchObjectFields(encoded, null, 0, true));
  assert.instanceOf(thrown, SessionError);
  assert.equal((thrown as SessionError).code, SessionErrorCode.MALFORMED_KEY_VALUE);
  assert.match(
    (thrown as SessionError).message,
    /key-value-pair value does not match serialization/,
  );
});

test("FetchObjectFields: mutable と IMMUTABLE_PROPERTIES の合算 2 回の PRIOR_OBJECT_ID_GAP で MalformedTrackError", () => {
  const inner = encodeProperties([{ id: MOQTPropertyId.PRIOR_OBJECT_ID_GAP, value: 0n }]);
  const fields: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(true),
    groupId: 0n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    properties: encodeProperties([
      { id: MOQTPropertyId.IMMUTABLE_PROPERTIES, data: inner },
      { id: MOQTPropertyId.PRIOR_OBJECT_ID_GAP, value: 0n },
    ]),
    payloadLength: 0n,
  };
  const encoded = encodeFetchObjectFields(fields);

  assert.throws(
    () => decodeFetchObjectFields(encoded, null, 0, true),
    MalformedTrackError,
    /more than one instance of PRIOR_OBJECT_ID_GAP/,
  );
});

/**
 * draft-ietf-moq-transport-23 §8.3:
 * "The maximum length of a value is 2^16-1 bytes. If an endpoint receives a length
 *  larger than the maximum, it MUST close the session with FIELD_LENGTH_EXCEEDED."
 * Fetch Object の Object Properties でも同じ MUST が適用される。
 */
test("FetchObjectFields: Object Property の Length が 2^16-1 を超えると FIELD_LENGTH_EXCEEDED", () => {
  const properties = new Uint8Array([...encodeVarint(0x0dn), ...encodeVarint(65536n)]);
  const fields: FetchObjectFields = {
    serializationFlags:
      createFirstFetchObjectFlags(false) | FetchSerializationFlags.PROPERTIES_PRESENT,
    groupId: 1n,
    subgroupId: 0n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 0n,
    properties,
  };
  const encoded = encodeFetchObjectFields(fields);
  assertFetchViolation(
    () => decodeFetchObjectFields(encoded, null, 0, true),
    SessionErrorCode.FIELD_LENGTH_EXCEEDED,
    /properties value length exceeds maximum/,
  );
});

/**
 * draft-ietf-moq-transport-23 §8.3:
 * delta の累積が 2^64-1 を超える Object Properties は DELTA_ENCODING_OVERFLOW の
 * ProtocolViolationError になる。Fetch Object でも同じ MUST が適用される。
 */
test("FetchObjectFields: Object Property の delta 累積が 2^64-1 を超えると DELTA_ENCODING_OVERFLOW", () => {
  const properties = new Uint8Array([
    ...encodeVarint(MAX_VARINT),
    ...encodeVarint(0n),
    ...encodeVarint(1n),
  ]);
  const fields: FetchObjectFields = {
    serializationFlags:
      createFirstFetchObjectFlags(false) | FetchSerializationFlags.PROPERTIES_PRESENT,
    groupId: 1n,
    subgroupId: 0n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 0n,
    properties,
  };
  const encoded = encodeFetchObjectFields(fields);
  assertFetchViolation(
    () => decodeFetchObjectFields(encoded, null, 0, true),
    SessionErrorCode.DELTA_ENCODING_OVERFLOW,
    /delta id addition exceeds maximum/,
  );
});

// ============================================================================
// draft-ietf-moq-transport-23 §12.2: FETCH データストリームのセッション終了コード
// 型だけでなく SessionErrorCode を検証し、分類の退行を検出できるようにする
// ============================================================================

/** ProtocolViolationError を捕捉して SessionErrorCode を返す */
function fetchViolationCode(fn: () => unknown): SessionErrorCode | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof ProtocolViolationError) {
      return err.code;
    }
    throw err;
  }
  return undefined;
}

/**
 * draft-ietf-moq-transport-23 §11.4.1.1:
 * "If either decoded ID is less than zero or greater than 2^64-1, the
 *  Subscriber MUST close the Session with DELTA_ENCODING_OVERFLOW."
 * 通常 Object の計算 Object ID の上限超過を DELTA_ENCODING_OVERFLOW で閉じる。
 */
test("FetchObjectFields: 計算 Object ID の上限超過は DELTA_ENCODING_OVERFLOW", () => {
  const prior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 0n,
    objectId: MAX_VARINT - 1n,
    publisherPriority: 0,
  };
  assert.equal(
    fetchViolationCode(() =>
      decodeFetchObjectFields(new Uint8Array([0x05, 0x00, 0x00]), prior, 0, false),
    ),
    SessionErrorCode.DELTA_ENCODING_OVERFLOW,
  );
});

/**
 * draft-ietf-moq-transport-23 §11.4.2.1:
 * End of Range indicator の復元 Group ID / Object ID の範囲外も
 * DELTA_ENCODING_OVERFLOW で閉じる。
 */
test("FetchObjectFields: End of Range の ID 復元超過は DELTA_ENCODING_OVERFLOW", () => {
  const prior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 0n,
    objectId: 5n,
    publisherPriority: 0,
    lastActualObject: { groupId: 10n, objectId: 5n },
  };
  // End of Unknown Range: Group ID Delta 0 / Object ID Delta 2^64-1
  // → 5 + (2^64-1) + 1 で 2^64 を超えるため範囲外になる
  const objectIdDelta = MAX_VARINT;
  assert.equal(
    fetchViolationCode(() =>
      decodeFetchObjectFields(
        new Uint8Array([0x81, 0x0c, 0x00, ...encodeVarint(objectIdDelta)]),
        prior,
        0,
        false,
      ),
    ),
    SessionErrorCode.DELTA_ENCODING_OVERFLOW,
  );
});

/**
 * draft-ietf-moq-transport-23 §11.4.1 Table 8:
 * 定義されていない 128 以上の値は MALFORMED_OBJECT で閉じる。
 */
test("FetchObjectFields: 未定義の 128 以上の flags は MALFORMED_OBJECT", () => {
  const prior: FetchObjectContext = {
    groupId: 10n,
    subgroupId: 0n,
    objectId: 5n,
    publisherPriority: 0,
  };
  // 0x30C は varint で [0x83, 0x0C] (2^64-1 超の ID を持たない未定義の indicator 値)
  assert.equal(
    fetchViolationCode(() => decodeFetchObjectFields(encodeVarint(0x30c), prior, 0, false)),
    SessionErrorCode.MALFORMED_OBJECT,
  );
});

/**
 * draft-ietf-moq-transport-23 §11.4.2.2:
 * 先行する実 Object の無い End of Group は MALFORMED_OBJECT で閉じる。
 */
test("FetchObjectFields: 先頭の End of Group は MALFORMED_OBJECT", () => {
  assert.equal(
    fetchViolationCode(() => decodeFetchObjectFields(new Uint8Array([0x80, 0x80]), null, 0, false)),
    SessionErrorCode.MALFORMED_OBJECT,
  );
});

/**
 * draft-ietf-moq-transport-23 §11.4.1.1:
 * 先頭 Object が prior Subgroup ID を参照するフラグは MALFORMED_OBJECT で閉じる。
 */
test("FetchObjectFields: 先頭 Object の SUBGROUP_SAME 参照は MALFORMED_OBJECT", () => {
  // Flags 0x07 (SUBGROUP_SAME | OBJECT_ID_PRESENT | PRIORITY_PRESENT)
  assert.equal(
    fetchViolationCode(() => decodeFetchObjectFields(new Uint8Array([0x07, 0x00]), null, 0, true)),
    SessionErrorCode.MALFORMED_OBJECT,
  );
});
