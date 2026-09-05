/**
 * MOQT Data Stream Fetch Object Fields - Property-Based Tests
 * draft-ietf-moq-transport-20 Section 11.4.4
 */
import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  type FetchObjectContext,
  FetchSerializationFlags,
  type FetchObjectFields,
  createFirstFetchObjectFlags,
  encodeFetchObjectFields,
  decodeFetchObjectFields,
} from "./dataStream";
import { GroupOrder } from "./message/types";
import { encodeVarint } from "./varint";
import { ProtocolViolationError } from "./error";

// ============================================================================
// arbitrary 定義
// ============================================================================

/**
 * Group Order の arbitrary
 */
const groupOrderArb = fc.constantFrom(GroupOrder.ASCENDING, GroupOrder.DESCENDING);

/**
 * 有効な Fetch Object Fields の arbitrary
 * テスト用の簡略版: すべての必須フィールドを含む先頭オブジェクト
 */
const firstFetchObjectFieldsArb = fc
  .record({
    groupId: fc.bigInt({ min: 0n, max: 1000000n }),
    subgroupId: fc.bigInt({ min: 0n, max: 1000000n }),
    objectId: fc.bigInt({ min: 0n, max: 1000000n }),
    publisherPriority: fc.integer({ min: 0, max: 255 }),
    payloadLength: fc.bigInt({ min: 0n, max: 100000n }),
    hasExtensions: fc.boolean(),
  })
  .map(({ groupId, subgroupId, objectId, publisherPriority, payloadLength, hasExtensions }) => {
    const flags = createFirstFetchObjectFlags(hasExtensions);
    const fields: FetchObjectFields = {
      serializationFlags: flags,
      groupId,
      subgroupId,
      objectId,
      publisherPriority,
      payloadLength,
    };
    return fields;
  });

// ============================================================================
// Ascending Group Order の PBT
// ============================================================================

/**
 * Ascending Group Order で先頭オブジェクトの encode→decode がラウンドトリップすることを検証する。
 */
test("FetchObjectFields: Ascending 先頭オブジェクトの encode→decode がラウンドトリップする", () => {
  fc.assert(
    fc.property(firstFetchObjectFieldsArb, (original) => {
      const encoded = encodeFetchObjectFields(original, false, null, GroupOrder.ASCENDING);
      const [decoded] = decodeFetchObjectFields(encoded, null, 0, true, GroupOrder.ASCENDING);

      assert.equal(decoded.groupId, original.groupId);
      assert.equal(decoded.subgroupId, original.subgroupId);
      assert.equal(decoded.objectId, original.objectId);
      assert.equal(decoded.publisherPriority, original.publisherPriority);
      assert.equal(decoded.payloadLength, original.payloadLength);
    }),
  );
});

/**
 * Ascending Group Order で複数オブジェクトの encode→decode がラウンドトリップすることを検証する。
 * オブジェクト 1: 先頭オブジェクト
 * オブジェクト 2: Group ID が増加するオブジェクト
 * 検証: Group ID が正しく計算されること。
 */
test("FetchObjectFields: Ascending 複数オブジェクトの encode→decode がラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.bigInt({ min: 1n, max: 1000000n }), // delta (groupStep)
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      (firstGroupId, groupStep, firstSubgroupId, firstObjectId, firstPriority, secondPriority) => {
        const secondGroupId = firstGroupId + groupStep;

        // 先頭オブジェクト
        const first: FetchObjectFields = {
          serializationFlags: createFirstFetchObjectFlags(false),
          groupId: firstGroupId,
          subgroupId: firstSubgroupId,
          objectId: firstObjectId,
          publisherPriority: firstPriority,
          payloadLength: 100n,
        };
        const firstEncoded = encodeFetchObjectFields(first, false, null, GroupOrder.ASCENDING);
        const [, , firstContext] = decodeFetchObjectFields(
          firstEncoded,
          null,
          0,
          true,
          GroupOrder.ASCENDING,
        );

        // 増加した Group ID のオブジェクト
        // Subgroup を変えることで Priority 一貫性チェックを回避する
        const second: FetchObjectFields = {
          serializationFlags:
            FetchSerializationFlags.GROUP_ID_PRESENT |
            FetchSerializationFlags.SUBGROUP_PRESENT |
            FetchSerializationFlags.OBJECT_ID_PRESENT |
            FetchSerializationFlags.PRIORITY_PRESENT,
          groupId: secondGroupId,
          subgroupId: firstSubgroupId + 1n, // 異なる Subgroup
          objectId: 0n,
          publisherPriority: secondPriority,
          payloadLength: 200n,
        };
        const secondEncoded = encodeFetchObjectFields(
          second,
          false,
          firstContext,
          GroupOrder.ASCENDING,
        );
        const [decoded] = decodeFetchObjectFields(
          secondEncoded,
          firstContext,
          0,
          false,
          GroupOrder.ASCENDING,
        );

        assert.equal(decoded.groupId, secondGroupId);
        assert.equal(decoded.subgroupId, firstSubgroupId + 1n);
        assert.equal(decoded.objectId, 0n);
        assert.equal(decoded.publisherPriority, secondPriority);
        assert.equal(decoded.payloadLength, 200n);
      },
    ),
  );
});

// ============================================================================
// Descending Group Order の PBT
// ============================================================================

/**
 * Descending Group Order で先頭オブジェクトの encode→decode がラウンドトリップすることを検証する。
 */
test("FetchObjectFields: Descending 先頭オブジェクトの encode→decode がラウンドトリップする", () => {
  fc.assert(
    fc.property(firstFetchObjectFieldsArb, (original) => {
      const encoded = encodeFetchObjectFields(original, false, null, GroupOrder.DESCENDING);
      const [decoded] = decodeFetchObjectFields(encoded, null, 0, true, GroupOrder.DESCENDING);

      assert.equal(decoded.groupId, original.groupId);
      assert.equal(decoded.subgroupId, original.subgroupId);
      assert.equal(decoded.objectId, original.objectId);
      assert.equal(decoded.publisherPriority, original.publisherPriority);
      assert.equal(decoded.payloadLength, original.payloadLength);
    }),
  );
});

/**
 * Descending Group Order で複数オブジェクトの encode→decode がラウンドトリップすることを検証する。
 * オブジェクト 1: 先頭オブジェクト（大きい Group ID）
 * オブジェクト 2: Group ID が減少するオブジェクト
 * 検証: Descending Group Order で正しくラウンドトリップすること。
 */
test("FetchObjectFields: Descending 複数オブジェクトの encode→decode がラウンドトリップする", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 100n, max: 1000000n }), // 十分に大きい先頭 Group ID
      fc.bigInt({ min: 1n, max: 99n }), // groupStep (1 以上 99 以下)
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      (firstGroupId, groupStep, firstSubgroupId, firstObjectId, firstPriority, secondPriority) => {
        const secondGroupId = firstGroupId - groupStep;

        // 先頭オブジェクト
        const first: FetchObjectFields = {
          serializationFlags: createFirstFetchObjectFlags(false),
          groupId: firstGroupId,
          subgroupId: firstSubgroupId,
          objectId: firstObjectId,
          publisherPriority: firstPriority,
          payloadLength: 100n,
        };
        const firstEncoded = encodeFetchObjectFields(first, false, null, GroupOrder.DESCENDING);
        const [, , firstContext] = decodeFetchObjectFields(
          firstEncoded,
          null,
          0,
          true,
          GroupOrder.DESCENDING,
        );

        // 減少した Group ID のオブジェクト
        // Subgroup を変えることで Priority 一貫性チェックを回避する
        const second: FetchObjectFields = {
          serializationFlags:
            FetchSerializationFlags.GROUP_ID_PRESENT |
            FetchSerializationFlags.SUBGROUP_PRESENT |
            FetchSerializationFlags.OBJECT_ID_PRESENT |
            FetchSerializationFlags.PRIORITY_PRESENT,
          groupId: secondGroupId,
          subgroupId: firstSubgroupId + 1n, // 異なる Subgroup
          objectId: 0n,
          publisherPriority: secondPriority,
          payloadLength: 200n,
        };
        const secondEncoded = encodeFetchObjectFields(
          second,
          false,
          firstContext,
          GroupOrder.DESCENDING,
        );
        const [decoded] = decodeFetchObjectFields(
          secondEncoded,
          firstContext,
          0,
          false,
          GroupOrder.DESCENDING,
        );

        assert.equal(decoded.groupId, secondGroupId);
        assert.equal(decoded.subgroupId, firstSubgroupId + 1n);
        assert.equal(decoded.objectId, 0n);
        assert.equal(decoded.publisherPriority, secondPriority);
        assert.equal(decoded.payloadLength, 200n);
      },
    ),
  );
});

// ============================================================================
// 双方向 PBT (Ascending/Descending 両方)
// ============================================================================

/**
 * Ascending/Descending 両方で先頭オブジェクトのラウンドトリップが成功することを検証する。
 */
test("FetchObjectFields: Ascending/Descending 両方で先頭オブジェクトのラウンドトリップが成功する", () => {
  fc.assert(
    fc.property(firstFetchObjectFieldsArb, groupOrderArb, (original, groupOrder) => {
      const encoded = encodeFetchObjectFields(original, false, null, groupOrder);
      const [decoded] = decodeFetchObjectFields(encoded, null, 0, true, groupOrder);

      assert.equal(decoded.groupId, original.groupId);
      assert.equal(decoded.subgroupId, original.subgroupId);
      assert.equal(decoded.objectId, original.objectId);
      assert.equal(decoded.publisherPriority, original.publisherPriority);
      assert.equal(decoded.payloadLength, original.payloadLength);
    }),
  );
});

// ============================================================================
// Group ID 範囲検証 PBT
// ============================================================================

/**
 * Ascending で最大値を超える Group ID を計算させると ProtocolViolationError が throw されることを検証する。
 */
test("FetchObjectFields: Ascending で Group ID が 2^64-1 を超える場合に ProtocolViolationError", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 1n, max: 100n }), // delta
      (delta) => {
        const nearMax = (1n << 64n) - 1n;
        const priorGroupId = nearMax - delta + 1n; // prior + delta + 1 > nearMax になるように

        const flags =
          FetchSerializationFlags.GROUP_ID_PRESENT |
          FetchSerializationFlags.SUBGROUP_ZERO |
          FetchSerializationFlags.OBJECT_ID_PRESENT |
          FetchSerializationFlags.PRIORITY_PRESENT;

        const groupDeltaBytes = encodeVarint(delta);
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
        data[offset] = 128;
        offset += 1;
        data.set(payloadLengthBytes, offset);

        const prior: FetchObjectContext = {
          groupId: priorGroupId,
          subgroupId: 0n,
          objectId: 0n,
          publisherPriority: 128,
        };

        assert.throws(
          () => decodeFetchObjectFields(data, prior, 0, false, GroupOrder.ASCENDING),
          ProtocolViolationError,
          /computed group id out of range/,
        );
      },
    ),
  );
});

/**
 * Descending で 0 未満の Group ID を計算させると ProtocolViolationError が throw されることを検証する。
 */
test("FetchObjectFields: Descending で Group ID が 0 未満になる場合に ProtocolViolationError", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 1n, max: 100n }), // delta
      fc.bigInt({ min: 0n, max: 99n }), // priorGroupId (0 以上、delta より小さい)
      (delta, priorGroupId) => {
        // priorGroupId - delta - 1 < 0 の場合のみ有効なテスト
        fc.pre(priorGroupId < delta + 1n);

        const flags =
          FetchSerializationFlags.GROUP_ID_PRESENT |
          FetchSerializationFlags.SUBGROUP_ZERO |
          FetchSerializationFlags.OBJECT_ID_PRESENT |
          FetchSerializationFlags.PRIORITY_PRESENT;

        const groupDeltaBytes = encodeVarint(delta);
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
        data[offset] = 128;
        offset += 1;
        data.set(payloadLengthBytes, offset);

        const prior: FetchObjectContext = {
          groupId: priorGroupId,
          subgroupId: 0n,
          objectId: 0n,
          publisherPriority: 128,
        };

        assert.throws(
          () => decodeFetchObjectFields(data, prior, 0, false, GroupOrder.DESCENDING),
          ProtocolViolationError,
          /computed group id out of range/,
        );
      },
    ),
  );
});
