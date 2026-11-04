/**
 * MOQT Data Stream - Property-Based Tests
 *
 * Subgroup Header (draft-ietf-moq-transport-22 Section 11.3.1) と
 * Fetch Object Fields (Section 11.4.1) の encode→decode ラウンドトリップを検証する。
 */
import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  type FetchObjectContext,
  FetchSerializationFlags,
  type FetchObjectFields,
  type SubgroupHeader,
  SubgroupHeaderType,
  createFetchObjectFlags,
  createFirstFetchObjectFlags,
  encodeFetchObjectFields,
  decodeFetchObjectFields,
  encodeSubgroupHeader,
  decodeSubgroupHeader,
} from "./dataStream";
import { GroupOrder } from "./message/types";
import { encodeVarint, MAX_VARINT } from "./varint";
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

/**
 * Subgroup Header の形 (Type Flags と後続フィールドの有無) の一覧
 *
 * draft-ietf-moq-transport-22 §11.3.1:
 * Type Flags は Priority Present (0x10-0x1D は Yes / 0x30-0x3D は No) と
 * SUBGROUP_ID_MODE (Subgroup ID = 0 / First Object ID / 明示フィールド) の
 * 組み合わせで後続フィールドの有無が変わる。FIRST_OBJECT ビット (0x40) は
 * firstObject から OR するため、0x50 系の型は生成対象に含めない。
 *
 * subgroupIdSource は decode 後の subgroupId の期待値を表す。
 * - "zero": Subgroup ID = 0 (フィールドなし、0n が入る)
 * - "firstObject": Subgroup ID = First Object ID (フィールドなし、undefined)
 * - "field": 明示的な Subgroup ID フィールドあり
 */
const subgroupHeaderShapes = [
  // Priority Present = Yes
  { type: SubgroupHeaderType.BASE, hasPriority: true, subgroupIdSource: "zero" },
  { type: SubgroupHeaderType.BASE_EXT, hasPriority: true, subgroupIdSource: "zero" },
  { type: SubgroupHeaderType.FIRST_OBJ, hasPriority: true, subgroupIdSource: "firstObject" },
  { type: SubgroupHeaderType.FIRST_OBJ_EXT, hasPriority: true, subgroupIdSource: "firstObject" },
  { type: SubgroupHeaderType.EXPLICIT, hasPriority: true, subgroupIdSource: "field" },
  { type: SubgroupHeaderType.EXPLICIT_EXT, hasPriority: true, subgroupIdSource: "field" },
  // Priority Present = Yes + END_OF_GROUP ビット (0x08)
  { type: SubgroupHeaderType.BASE_END_GROUP, hasPriority: true, subgroupIdSource: "zero" },
  {
    type: SubgroupHeaderType.FIRST_OBJ_EXT_END_GROUP,
    hasPriority: true,
    subgroupIdSource: "firstObject",
  },
  // Priority Present = No (publisherPriority は wire に載らない)
  { type: SubgroupHeaderType.BASE_NO_PRIORITY, hasPriority: false, subgroupIdSource: "zero" },
  {
    type: SubgroupHeaderType.FIRST_OBJ_NO_PRIORITY,
    hasPriority: false,
    subgroupIdSource: "firstObject",
  },
  {
    type: SubgroupHeaderType.EXPLICIT_NO_PRIORITY,
    hasPriority: false,
    subgroupIdSource: "field",
  },
  // Priority Present = No + END_OF_GROUP ビット (0x08)
  {
    type: SubgroupHeaderType.EXPLICIT_END_GROUP_NO_PRIORITY,
    hasPriority: false,
    subgroupIdSource: "field",
  },
] as const;

/**
 * 有効な Subgroup Header の arbitrary
 *
 * firstObject は true / false の両方を生成し、wire 上で FIRST_OBJECT ビット
 * (0x40) が立つ場合と立たない場合の双方を検証対象にする (false と未設定の
 * 区別が無いことを型とラウンドトリップの両面から確認する)。
 */
const subgroupHeaderArb = fc
  .record({
    shape: fc.constantFrom(...subgroupHeaderShapes),
    trackAlias: fc.bigInt({ min: 0n, max: MAX_VARINT }),
    groupId: fc.bigInt({ min: 0n, max: MAX_VARINT }),
    subgroupId: fc.bigInt({ min: 0n, max: MAX_VARINT }),
    publisherPriority: fc.integer({ min: 0, max: 255 }),
    firstObject: fc.boolean(),
  })
  .map(({ shape, trackAlias, groupId, subgroupId, publisherPriority, firstObject }) => {
    const header: SubgroupHeader = {
      type: shape.type,
      trackAlias,
      groupId,
      // 明示的な Subgroup ID フィールドを持つ型だけ値を載せる
      ...(shape.subgroupIdSource === "field" ? { subgroupId } : {}),
      publisherPriority,
      firstObject,
    };
    return { shape, header };
  });

// ============================================================================
// Ascending Group Order の PBT
// ============================================================================

/**
 * draft-ietf-moq-transport-22 §11.4.1.1:
 * DATAGRAM ビットが立つ先頭オブジェクトの encode→decode がラウンドトリップし、
 * Subgroup ID フィールドを消費しない (subgroupId = 0n) ことを検証する。
 */
/**
 * FetchObjectFields の roundtrip は本 PBT が担う。
 *
 * DATAGRAM 先頭オブジェクトは下位 2 ビットの値 (0〜3) と Properties の有無の
 * 組み合わせを網羅する。単体テストには同じ往復を固定値 1 組で検証するものを
 * 置かない (shiguredo-typescript の「PBT でカバーできるものを単体テストで
 * 書かないこと」)。単体テストは PBT で表現できない意図的なエラーパス
 * (Object ID の overflow、timed_out の status 種別など) に絞る。
 */
test("FetchObjectFields: DATAGRAM 先頭オブジェクトの encode→decode がラウンドトリップする", () => {
  fc.assert(
    fc.property(
      firstFetchObjectFieldsArb,
      fc.constantFrom(0, 1, 2, 3),
      (original, subgroupBits) => {
        // DATAGRAM では下位 2 ビットの値に関わらず Subgroup ID を持たない
        const datagram: FetchObjectFields = {
          ...original,
          serializationFlags:
            createFirstFetchObjectFlags(
              (original.serializationFlags & FetchSerializationFlags.PROPERTIES_PRESENT) !== 0,
              true,
            ) | subgroupBits,
        };
        const encoded = encodeFetchObjectFields(datagram, false, null, GroupOrder.ASCENDING);
        const [decoded, consumed] = decodeFetchObjectFields(
          encoded,
          null,
          0,
          true,
          GroupOrder.ASCENDING,
        );

        assert.equal(consumed, encoded.length);
        assert.equal(decoded.groupId, datagram.groupId);
        assert.equal(decoded.subgroupId, 0n);
        assert.equal(decoded.objectId, datagram.objectId);
        assert.equal(decoded.publisherPriority, datagram.publisherPriority);
        assert.equal(decoded.payloadLength, datagram.payloadLength);
      },
    ),
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
// 同一 Group の Object ID Delta +2 の PBT
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §11.4.1.1:
 * "When the Group ID Delta field is not present, the Object ID is the prior
 *  Object's ID plus the Object ID Delta + 2 if present. If Object ID Delta is
 *  not present, the Object ID is the prior Object's ID plus one, regardless of
 *  which group it belongs to."
 *
 * 先頭 Object の後ろに同一 Group の Object を増分 1〜4 で並べ、
 * - 増分 1 は Delta 省略 (prior + 1)
 * - 増分 2 以上は明示 Delta (prior + Delta + 2、Delta = 増分 - 2)
 * で encode / decode / フラグ生成が一致することを検証する。wire の Delta
 * バイト列も直接検証し、送受信双方が同じ誤りを持つラウンドトリップだけでは
 * 検出できないことを補う。
 */
test("FetchObjectFields: 同一 Group の Object ID が prior + Delta + 2 で復元される", () => {
  fc.assert(
    fc.property(
      // groupId / subgroupId / 先頭 Object の Object ID / publisherPriority / 増分
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.integer({ min: 0, max: 255 }),
      fc.array(fc.bigInt({ min: 1n, max: 4n }), { minLength: 1, maxLength: 4 }),
      groupOrderArb,
      (groupId, subgroupId, firstObjectId, publisherPriority, increments, groupOrder) => {
        // 先頭 Object は Group ID / Object ID を絶対値で持つ
        const first: FetchObjectFields = {
          serializationFlags: createFirstFetchObjectFlags(false),
          groupId,
          subgroupId,
          objectId: firstObjectId,
          publisherPriority,
          payloadLength: 0n,
        };
        const firstEncoded = encodeFetchObjectFields(first, false, null, groupOrder);
        const [, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true, groupOrder);

        let context: FetchObjectContext = firstContext;
        let previousObjectId = firstObjectId;
        for (const increment of increments) {
          const objectId = previousObjectId + increment;
          const flags = createFetchObjectFlags(
            { groupId, subgroupId, objectId, publisherPriority },
            context,
            false,
          );
          // 同一 Group では増分 1 だけ Delta を省略する
          assert.equal((flags & FetchSerializationFlags.OBJECT_ID_PRESENT) !== 0, increment >= 2n);

          const fields: FetchObjectFields = {
            serializationFlags: flags,
            objectId,
            payloadLength: 0n,
          };
          const encoded = encodeFetchObjectFields(fields, false, context, groupOrder);

          // wire は [Flags][Object ID Delta (明示時のみ)][Object Payload Length] の
          // 順である。Group / Subgroup / Priority は先頭と同じため省略される
          const expectedParts: number[] = [flags];
          if (increment >= 2n) {
            expectedParts.push(...encodeVarint(increment - 2n));
          }
          expectedParts.push(0);
          assert.deepEqual([...encoded], expectedParts);

          const [decoded, , nextContext] = decodeFetchObjectFields(
            encoded,
            context,
            0,
            false,
            groupOrder,
          );
          assert.equal(decoded.objectId, objectId);
          assert.equal(decoded.groupId, groupId);
          assert.equal(decoded.subgroupId, subgroupId);
          assert.equal(decoded.publisherPriority, publisherPriority);

          // 実際の受信経路と同じく、decode が返した context を次段へ引き継ぐ
          context = nextContext;
          previousObjectId = objectId;
        }
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-23 §11.4.1.1:
 * Group ID Delta が無い Object の Object ID は prior + Delta + 2 である。
 * 任意の prior と Delta を組み立て、2^64-1 を超える場合は
 * DELTA_ENCODING_OVERFLOW (現行は ProtocolViolationError = PROTOCOL_VIOLATION)
 * として拒否されることを検証する。
 */
test("FetchObjectFields: 任意の prior と Delta から Object ID が prior + Delta + 2 で復元される", () => {
  fc.assert(
    fc.property(
      // prior Object ID / Object ID Delta
      fc.bigInt({ min: 0n, max: MAX_VARINT }),
      fc.bigInt({ min: 0n, max: MAX_VARINT }),
      (priorObjectId, delta) => {
        const prior: FetchObjectContext = {
          groupId: 0n,
          subgroupId: 0n,
          objectId: priorObjectId,
          publisherPriority: 0,
        };

        // Serialization Flags = SUBGROUP_SAME | OBJECT_ID_PRESENT、Payload Length=0
        const data = new Uint8Array([0x05, ...encodeVarint(delta), 0x00]);
        const expectedObjectId = priorObjectId + delta + 2n;

        if (expectedObjectId > MAX_VARINT) {
          assert.throws(
            () => decodeFetchObjectFields(data, prior, 0, false),
            ProtocolViolationError,
          );
        } else {
          const [decoded] = decodeFetchObjectFields(data, prior, 0, false);
          assert.equal(decoded.objectId, expectedObjectId);
        }
      },
    ),
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

// ============================================================================
// End of Range indicator の delta 形式の PBT
// draft-ietf-moq-transport-23 §11.4.2 / §11.4.2.1
// ============================================================================

/**
 * End of Range indicator の種別一覧
 *
 * draft-ietf-moq-transport-23 §11.4.1 (Fetch Header) / Table 8:
 * 0x8C (End of Non-Existent Range) / 0x10C (End of Unknown Range) /
 * 0x20C (End of Timed-Out Range) / 0x40C (End of Gone Range)。
 */
const endOfRangeFlagCases = [
  { name: "non_existent", flags: FetchSerializationFlags.END_OF_NON_EXISTENT_RANGE },
  { name: "unknown", flags: FetchSerializationFlags.END_OF_UNKNOWN_RANGE },
  { name: "timed_out", flags: FetchSerializationFlags.END_OF_TIMED_OUT_RANGE },
  { name: "gone", flags: FetchSerializationFlags.END_OF_GONE_RANGE },
] as const;

/**
 * draft-ietf-moq-transport-23 §11.4.2.1 (ID Decoding):
 * "If this End of Range indicator is the first entry after the FETCH_HEADER,
 *  both fields encode absolute IDs. Otherwise, the prior Group ID and prior
 *  Object ID are the decoded IDs of the most recent preceding Object or End of
 *  Range indicator."
 *
 * 実 Object の後に 4 種の indicator を置き、同一 Group (Group ID Delta = 0) と
 * Group 変更 (Group ID Delta 非 0) の両方、および Ascending / Descending の
 * 両方で encode→decode がラウンドトリップすることを検証する。wire は
 * Flags + Group ID Delta + Object ID Delta の 3 フィールドだけであり、
 * Object Payload Length を持たないことも直接確認する。
 */
test("FetchObjectFields: End of Range indicator の delta 形式がラウンドトリップする", () => {
  fc.assert(
    fc.property(
      // 先頭 Object の Group ID / Subgroup ID / Object ID / Publisher Priority
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.integer({ min: 0, max: 255 }),
      // Group の移動量 (0 なら同一 Group) と、同一 Group 内の Object ID の増分 /
      // Group 変更時の絶対 Object ID の材料
      fc.bigInt({ min: 0n, max: 1000n }),
      fc.bigInt({ min: 1n, max: 1001n }),
      fc.constantFrom(...endOfRangeFlagCases),
      groupOrderArb,
      (
        firstGroupId,
        firstSubgroupId,
        firstObjectId,
        publisherPriority,
        groupStep,
        objectStep,
        { name, flags },
        groupOrder,
      ) => {
        // Descending では Group ID が負になる移動を生成しない
        fc.pre(groupOrder === GroupOrder.ASCENDING || firstGroupId >= groupStep);

        // 先頭 Object は Group ID / Object ID を絶対値で持つ
        const first: FetchObjectFields = {
          serializationFlags: createFirstFetchObjectFlags(false),
          groupId: firstGroupId,
          subgroupId: firstSubgroupId,
          objectId: firstObjectId,
          publisherPriority,
          payloadLength: 0n,
        };
        const firstEncoded = encodeFetchObjectFields(first, false, null, groupOrder);
        const [, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true, groupOrder);

        // 対象 Location。Group ID Delta = 0 なら同一 Group で Object ID は
        // prior + Object ID Delta + 1 だけ進み、Group 変更時は新しい Group の
        // 絶対 Object ID になる (§11.4.2.1)。
        const targetGroupId =
          groupOrder === GroupOrder.DESCENDING
            ? firstGroupId - groupStep
            : firstGroupId + groupStep;
        const targetObjectId = groupStep === 0n ? firstObjectId + objectStep : objectStep - 1n;
        const expectedGroupDelta = groupStep;
        const expectedObjectDelta =
          groupStep === 0n ? targetObjectId - firstObjectId - 1n : targetObjectId;

        const eor: FetchObjectFields = {
          serializationFlags: flags,
          groupId: targetGroupId,
          objectId: targetObjectId,
          payloadLength: 0n,
        };
        const encoded = encodeFetchObjectFields(eor, false, firstContext, groupOrder);

        // 固定ワイヤ: Flags + Group ID Delta + Object ID Delta のみ。
        // Object Payload Length は End of Range には存在しない。
        assert.deepEqual(
          [...encoded],
          [
            ...encodeVarint(flags),
            ...encodeVarint(expectedGroupDelta),
            ...encodeVarint(expectedObjectDelta),
          ],
        );

        const [decoded, consumed, eorContext] = decodeFetchObjectFields(
          encoded,
          firstContext,
          0,
          false,
          groupOrder,
        );
        assert.equal(consumed, encoded.length);
        assert.equal(decoded.endOfRange, name);
        assert.equal(decoded.groupId, targetGroupId);
        assert.equal(decoded.objectId, targetObjectId);
        // End of Range は Object Payload Length を持たないため 0
        assert.equal(decoded.payloadLength, 0n);
        // Subgroup ID / Priority は indicator より前の最後の実 Object から引き継ぐ
        assert.equal(decoded.subgroupId, firstSubgroupId);
        assert.equal(decoded.publisherPriority, publisherPriority);
        // 復号した Location が後続エントリーの prior になる
        assert.equal(eorContext.groupId, targetGroupId);
        assert.equal(eorContext.objectId, targetObjectId);
      },
    ),
  );
});

/**
 * draft-ietf-moq-transport-23 §11.4.2.1:
 * "the prior Group ID and prior Object ID are the decoded IDs of the most recent
 *  preceding Object or End of Range indicator."
 *
 * 実 Object を 1 件も挟まずに indicator を 3 件並べ、2 件目・3 件目が直前の
 * indicator の復号位置を prior にしていることを検証する。1 件目だけが絶対 ID で、
 * 2 件目は同一 Group の Object ID Delta、3 件目は Group 変更の絶対 Object ID を
 * 持つ。
 */
test("FetchObjectFields: 連続する End of Range の prior は直前の indicator の復号位置になる", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      fc.bigInt({ min: 0n, max: 1000n }),
      fc.bigInt({ min: 1n, max: 1000n }),
      fc.bigInt({ min: 0n, max: 1000000n }),
      groupOrderArb,
      (firstGroupId, firstObjectId, sameGroupObjectDelta, groupStep, thirdObjectId, groupOrder) => {
        // Descending では Group ID が負になる移動を生成しない
        fc.pre(groupOrder === GroupOrder.ASCENDING || firstGroupId >= groupStep);

        // 1 件目: FETCH_HEADER 直後の indicator は Group ID / Object ID とも絶対値
        const first: FetchObjectFields = {
          serializationFlags: FetchSerializationFlags.END_OF_UNKNOWN_RANGE,
          groupId: firstGroupId,
          objectId: firstObjectId,
          payloadLength: 0n,
        };
        const firstEncoded = encodeFetchObjectFields(first, false, null, groupOrder);
        const [firstDecoded, firstConsumed, firstContext] = decodeFetchObjectFields(
          firstEncoded,
          null,
          0,
          true,
          groupOrder,
        );
        assert.equal(firstConsumed, firstEncoded.length);
        assert.equal(firstDecoded.endOfRange, "unknown");
        assert.equal(firstDecoded.groupId, firstGroupId);
        assert.equal(firstDecoded.objectId, firstObjectId);

        // 2 件目: 同一 Group (Group ID Delta = 0) の Gone indicator。
        // Object ID は prior + Object ID Delta + 1 である。
        const secondObjectId = firstObjectId + sameGroupObjectDelta + 1n;
        const second: FetchObjectFields = {
          serializationFlags: FetchSerializationFlags.END_OF_GONE_RANGE,
          groupId: firstGroupId,
          objectId: secondObjectId,
          payloadLength: 0n,
        };
        const secondEncoded = encodeFetchObjectFields(second, false, firstContext, groupOrder);
        assert.deepEqual(
          [...secondEncoded],
          [
            ...encodeVarint(FetchSerializationFlags.END_OF_GONE_RANGE),
            0x00,
            ...encodeVarint(sameGroupObjectDelta),
          ],
        );
        const [secondDecoded, secondConsumed, secondContext] = decodeFetchObjectFields(
          secondEncoded,
          firstContext,
          0,
          false,
          groupOrder,
        );
        assert.equal(secondConsumed, secondEncoded.length);
        assert.equal(secondDecoded.endOfRange, "gone");
        assert.equal(secondDecoded.groupId, firstGroupId);
        assert.equal(secondDecoded.objectId, secondObjectId);

        // 3 件目: Group 変更の indicator。Group ID は prior ± Group ID Delta、
        // Object ID Delta は新しい Group の絶対 Object ID である。
        const thirdGroupId =
          groupOrder === GroupOrder.DESCENDING
            ? firstGroupId - groupStep
            : firstGroupId + groupStep;
        const third: FetchObjectFields = {
          serializationFlags: FetchSerializationFlags.END_OF_NON_EXISTENT_RANGE,
          groupId: thirdGroupId,
          objectId: thirdObjectId,
          payloadLength: 0n,
        };
        const thirdEncoded = encodeFetchObjectFields(third, false, secondContext, groupOrder);
        assert.deepEqual(
          [...thirdEncoded],
          [
            ...encodeVarint(FetchSerializationFlags.END_OF_NON_EXISTENT_RANGE),
            ...encodeVarint(groupStep),
            ...encodeVarint(thirdObjectId),
          ],
        );
        const [thirdDecoded, thirdConsumed, thirdContext] = decodeFetchObjectFields(
          thirdEncoded,
          secondContext,
          0,
          false,
          groupOrder,
        );
        assert.equal(thirdConsumed, thirdEncoded.length);
        assert.equal(thirdDecoded.endOfRange, "non_existent");
        assert.equal(thirdDecoded.groupId, thirdGroupId);
        assert.equal(thirdDecoded.objectId, thirdObjectId);
        assert.equal(thirdContext.groupId, thirdGroupId);
        assert.equal(thirdContext.objectId, thirdObjectId);
      },
    ),
  );
});

// ============================================================================
// Subgroup Header (draft-ietf-moq-transport-22 Section 11.3.1) の PBT
// ============================================================================

/**
 * Subgroup Header の encode→decode がラウンドトリップすることを検証する。
 *
 * FIRST_OBJECT ビット (0x40) は firstObject の true / false に応じて wire の
 * Type Flags に現れ、decode 後も同じ boolean として復元される (false と
 * 未設定の区別が無い)。Type Flags の一致で wire 表現が変わっていないことを
 * 確認する。単体テストは PBT で表現できない意図的なエラーパス (予約値・
 * 不正な Type Flags・バッファ不足) に絞る。
 */
test("SubgroupHeader: encode→decode がラウンドトリップし firstObject を保持する", () => {
  fc.assert(
    fc.property(subgroupHeaderArb, ({ shape, header }) => {
      const encoded = encodeSubgroupHeader(header);
      const [decoded, consumed] = decodeSubgroupHeader(encoded);

      // firstObject は true / false のどちらも同じ値で復元される
      assert.equal(decoded.firstObject, header.firstObject);
      // wire の Type Flags は FIRST_OBJECT ビットの有無だけが入力と異なる
      assert.equal(decoded.type, header.firstObject ? header.type | 0x40 : header.type);
      assert.equal(decoded.trackAlias, header.trackAlias);
      assert.equal(decoded.groupId, header.groupId);

      // SUBGROUP_ID_MODE ごとに decode 後の subgroupId が決まる
      if (shape.subgroupIdSource === "field") {
        assert.equal(decoded.subgroupId, header.subgroupId);
      } else if (shape.subgroupIdSource === "zero") {
        assert.equal(decoded.subgroupId, 0n);
      } else {
        assert.isUndefined(decoded.subgroupId);
      }

      // Priority Present = No の型では publisherPriority が wire に載らない
      assert.equal(
        decoded.publisherPriority,
        shape.hasPriority ? header.publisherPriority : undefined,
      );
      assert.equal(consumed, encoded.length);
    }),
  );
});
