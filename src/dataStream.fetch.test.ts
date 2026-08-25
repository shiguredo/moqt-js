/**
 * MOQT データストリーム Fetch テスト
 * draft-ietf-moq-transport-19 Section 11.4.4 (Fetch Header and Objects)
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
import { encodeVarint } from "./varint";
import { IncompleteDataError, MalformedTrackError } from "./error";

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

// draft-ietf-moq-transport-19 Section 11.2.1.1:
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
 * draft-ietf-moq-transport-19 Section 11.4.4:
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
 * draft-ietf-moq-transport-19 §2.4.2 (Malformed Tracks):
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
  const secondFlags =
    FetchSerializationFlags.SUBGROUP_SAME |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;
  const objectIdBytes = encodeVarint(1n);
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
 * draft-ietf-moq-transport-19 §2.2:
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
 * draft-ietf-moq-transport-19 §2.2:
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
 * draft-ietf-moq-transport-19 §11.4.4.1:
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
 * 比較対象にしない (draft-ietf-moq-transport-19 §2.4.2 の比較対象は
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
    serializationFlags:
      FetchSerializationFlags.DATAGRAM |
      FetchSerializationFlags.OBJECT_ID_PRESENT |
      FetchSerializationFlags.PRIORITY_PRESENT,
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
      FetchSerializationFlags.SUBGROUP_SAME |
      FetchSerializationFlags.OBJECT_ID_PRESENT |
      FetchSerializationFlags.PRIORITY_PRESENT,
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
 * draft-ietf-moq-transport-19 §2.4.2:
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
    serializationFlags:
      FetchSerializationFlags.DATAGRAM |
      FetchSerializationFlags.OBJECT_ID_PRESENT |
      FetchSerializationFlags.PRIORITY_PRESENT,
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
      FetchSerializationFlags.SUBGROUP_SAME |
      FetchSerializationFlags.OBJECT_ID_PRESENT |
      FetchSerializationFlags.PRIORITY_PRESENT,
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
 * draft-ietf-moq-transport-19 §2.4.2 / §11.4.4.2:
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

  // End of Range (Group 11 へ変更)
  const eor: FetchObjectFields = {
    serializationFlags: FetchSerializationFlags.END_OF_UNKNOWN_RANGE,
    groupId: 11n,
    objectId: 0n,
    payloadLength: 0n,
  };
  const eorEncoded = encodeFetchObjectFields(eor);
  const [, , eorContext] = decodeFetchObjectFields(eorEncoded, firstContext, 0, false);

  // 新 Group 内の同一 Subgroup ID (Priority 50。旧 Group の Subgroup と無関係)
  const third: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_PRESENT |
      FetchSerializationFlags.OBJECT_ID_PRESENT |
      FetchSerializationFlags.PRIORITY_PRESENT,
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
 * draft-ietf-moq-transport-19 §2.4.2 / §11.4.4.2:
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

  // 同一 Group の End of Range (Group は変更されない)
  const eor: FetchObjectFields = {
    serializationFlags: FetchSerializationFlags.END_OF_UNKNOWN_RANGE,
    groupId: 10n,
    objectId: 9n,
    payloadLength: 0n,
  };
  const eorEncoded = encodeFetchObjectFields(eor);
  const [, , eorContext] = decodeFetchObjectFields(eorEncoded, firstContext, 0, false);

  // End of Range 後の同一 Subgroup オブジェクト (Priority 150: 直前の 100 と不一致)
  const third: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_SAME |
      FetchSerializationFlags.OBJECT_ID_PRESENT |
      FetchSerializationFlags.PRIORITY_PRESENT,
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
 * draft-ietf-moq-transport-19 §11.4.4.1 Table 9:
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
    serializationFlags:
      FetchSerializationFlags.DATAGRAM |
      FetchSerializationFlags.OBJECT_ID_PRESENT |
      FetchSerializationFlags.PRIORITY_PRESENT,
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
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_SAME | FetchSerializationFlags.OBJECT_ID_PRESENT,
    objectId: 2n,
    payloadLength: 50n,
  };
  const thirdEncoded = encodeFetchObjectFields(third, false, datagramContext);

  const [decoded] = decodeFetchObjectFields(thirdEncoded, datagramContext, 0, false);
  // 直近の実オブジェクト (Datagram 200) の値を継承する
  assert.equal(decoded.publisherPriority, 200);
});

/**
 * draft-ietf-moq-transport-19 §2.4.2:
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
    serializationFlags:
      FetchSerializationFlags.DATAGRAM |
      FetchSerializationFlags.OBJECT_ID_PRESENT |
      FetchSerializationFlags.PRIORITY_PRESENT,
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
      FetchSerializationFlags.SUBGROUP_SAME |
      FetchSerializationFlags.OBJECT_ID_PRESENT |
      FetchSerializationFlags.PRIORITY_PRESENT,
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
 * draft-ietf-moq-transport-19 §2.4.2:
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
      FetchSerializationFlags.SUBGROUP_SAME |
      FetchSerializationFlags.OBJECT_ID_PRESENT |
      FetchSerializationFlags.PRIORITY_PRESENT,
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
 * draft-ietf-moq-transport-19 §11.4.4.1 Table 9:
 * "If the Group Order is Ascending (default), the Group ID is the prior
 *  Object's Group ID plus the Group ID Delta + 1."
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
 * draft-ietf-moq-transport-19 §11.4.4.1 Table 9:
 * "When the Group ID Delta field is not present, the Object ID is the
 *  prior Object's ID plus the Object ID Delta if present."
 *
 * 非先頭オブジェクトで GROUP_ID_PRESENT なし、OBJECT_ID_PRESENT ありの場合、
 * delta から正しい Object ID (prior + delta) を計算することを検証する。
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

  // delta_object=3 (Group 不変時は prior + delta)
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
  // objectId = prior.objectId + delta = 5 + 3 = 8
  assert.equal(decoded.objectId, 8n);
  assert.equal(decoded.publisherPriority, 128);
  assert.equal(decoded.payloadLength, 50n);
  assert.equal(newContext.objectId, 8n);
});

/**
 * draft-ietf-moq-transport-19 §11.4.4.1:
 * encode → decode で複数オブジェクトの delta encoding が正しく roundtrip することを検証する。
 * オブジェクト 1: group=10, object=0  (先頭)
 * オブジェクト 2: group=10, object=3  (Group 不変, OBJECT_ID_PRESENT, delta エンコード)
 * オブジェクト 3: group=14, object=0  (Group 変更, GROUP_ID_PRESENT, delta エンコード)
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

  // オブジェクト 2: Group 不変, object=3 (delta=3), SUBGROUP_SAME
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
// Fetch Object Fields - Descending Group Order のテスト
// ============================================================================

/**
 * draft-ietf-moq-transport-19 §11.4.4.1 Table 9:
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
 * draft-ietf-moq-transport-19 §11.4.4.1 Table 9:
 * "If the Group Order is Descending, the Group ID is the prior Object's
 *  Group ID minus the (Group ID Delta + 1)."
 *
 * "If the computed Group ID would be less than 0 or greater than 2^64-1,
 *  the Subscriber MUST close the Session with error 'PROTOCOL_VIOLATION'."
 *
 * Descending 時に Group ID が 0 未満になる場合、ProtocolViolationError が throw されることを検証する。
 */
test("FetchObjectFields: Descending で Group ID が 0 未満になる場合は ProtocolViolationError", () => {
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

  assert.throws(
    () => decodeFetchObjectFields(data, prior, 0, false, GroupOrder.DESCENDING),
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
 * draft-ietf-moq-transport-19 §11.4.4.1:
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
 * DATAGRAM + SUBGROUP_PRESENT (0x43): wire 上の Subgroup ID vi64 を読み飛ばし、
 * subgroupId = 0n を返すことを検証する。
 *
 * ワイヤーフォーマット: flags, group_id, subgroup_id, object_id, priority, payload_length
 * DATAGRAM+SUBGROUP_PRESENT なので group_id の後の subgroup_id_vi64 は読み飛ばされる。
 */
test("FetchObjectFields: DATAGRAM+SUBGROUP_PRESENT (0x43) で Subgroup ID vi64 を読み飛ばす", () => {
  const flags =
    FetchSerializationFlags.DATAGRAM |
    FetchSerializationFlags.SUBGROUP_PRESENT |
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;

  // wire: [flags][groupId=5][subgroupId_vi64=99][objectId=10][priority=64][payloadLength=50]
  const subgroupIdBytes = encodeVarint(99n);
  const data = new Uint8Array(1 + 1 + subgroupIdBytes.length + 3);
  data[0] = flags;
  data[1] = 5; // groupId
  data.set(subgroupIdBytes, 2);
  data[2 + subgroupIdBytes.length] = 10; // objectId
  data[2 + subgroupIdBytes.length + 1] = 64; // priority
  data[2 + subgroupIdBytes.length + 2] = 50; // payloadLength

  const [decoded] = decodeFetchObjectFields(data, null, 0, true);

  assert.equal(decoded.groupId, 5n);
  assert.equal(decoded.subgroupId, 0n); // 読み飛ばしたので 0n
  assert.equal(decoded.objectId, 10n);
  assert.equal(decoded.publisherPriority, 64);
  assert.equal(decoded.payloadLength, 50n);
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
test("FetchObjectFields: 非Datagram→Datagram→非Datagram の混在で Subgroup ID が正しく伝搬する", () => {
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

/**
 * encode → decode roundtrip: Datagram つきの先頭オブジェクト
 */
test("FetchObjectFields: Datagram 先頭オブジェクトの encode→decode roundtrip", () => {
  const flags = createFirstFetchObjectFlags(false, true);
  const original: FetchObjectFields = {
    serializationFlags: flags,
    groupId: 100n,
    subgroupId: 0n, // Datagram 時は 0n
    objectId: 50n,
    publisherPriority: 200,
    payloadLength: 1000n,
  };

  const encoded = encodeFetchObjectFields(original);
  const [decoded, , context] = decodeFetchObjectFields(encoded, null, 0, true);

  assert.equal(decoded.groupId, 100n);
  assert.equal(decoded.subgroupId, 0n);
  assert.equal(decoded.objectId, 50n);
  assert.equal(decoded.publisherPriority, 200);
  assert.equal(decoded.payloadLength, 1000n);
  assert.equal(context.subgroupId, 0n);
});

// ============================================================================
// Fetch Object Fields - Object ID オーバーフローチェックのテスト
// ============================================================================

/**
 * draft-ietf-moq-transport-19 §11.4.4.1 Table 9:
 * "If the computed Object ID would be greater than 2^64-1, the
 *  Subscriber MUST close the Session with error 'PROTOCOL_VIOLATION'."
 *
 * Object ID Delta なし（+1）で Object ID が overflow する場合。
 */
test("FetchObjectFields: Object ID +1 で 2^64-1 を超過する場合は ProtocolViolationError", () => {
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

  assert.throws(
    () => decodeFetchObjectFields(data, prior, 0, false),
    /computed object id out of range/,
  );
});

/**
 * Group 不変時の Object ID Delta で overflow する場合。
 * Prior: 2^64-2, delta: 3 → 2^64-2 + 3 = 2^64+1 > 2^64-1
 */
test("FetchObjectFields: Group 不変時の Object ID Delta で 2^64-1 を超過する場合は ProtocolViolationError", () => {
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

  assert.throws(
    () => decodeFetchObjectFields(data, prior, 0, false),
    /computed object id out of range/,
  );
});
