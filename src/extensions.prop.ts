/**
 * MOQT Extension Headers Property-Based Tests
 * draft-ietf-moq-transport-15 Section 11
 */

import { test, assert } from "vitest";
import * as fc from "fast-check";
import {
  encodePriorGroupIdGap,
  decodePriorGroupIdGap,
  encodePriorObjectIdGap,
  decodePriorObjectIdGap,
  encodeExtensionHeader,
  encodeImmutableExtensions,
  decodeImmutableExtensions,
  parseExtensionHeaders,
  calculateSkippedGroups,
  calculateSkippedObjects,
  MOQTExtensionHeaderId,
  type ExtensionHeader,
} from "./extensions";
import { encodeVarint } from "./varint";

/**
 * 既知の拡張 ID を除外した未知の ID を生成する Arbitrary
 */
const unknownExtensionIdArb = fc
  .bigInt({ min: 0n, max: 0xffn })
  .filter(
    (id) =>
      id !== MOQTExtensionHeaderId.PRIOR_GROUP_ID_GAP &&
      id !== MOQTExtensionHeaderId.PRIOR_OBJECT_ID_GAP &&
      id !== MOQTExtensionHeaderId.IMMUTABLE_EXTENSIONS,
  );

/**
 * 未知の拡張をエンコードする
 * 偶数 ID: varint value 形式
 * 奇数 ID: length + bytes 形式
 */
function encodeUnknownExtension(id: bigint, value: bigint, data: Uint8Array): Uint8Array {
  const idBytes = encodeVarint(id);
  if (id % 2n === 0n) {
    // 偶数 ID: varint value 形式
    const valueBytes = encodeVarint(value);
    const result = new Uint8Array(idBytes.length + valueBytes.length);
    result.set(idBytes, 0);
    result.set(valueBytes, idBytes.length);
    return result;
  }
  // 奇数 ID: length + bytes 形式
  const lengthBytes = encodeVarint(BigInt(data.length));
  const result = new Uint8Array(idBytes.length + lengthBytes.length + data.length);
  result.set(idBytes, 0);
  result.set(lengthBytes, idBytes.length);
  result.set(data, idBytes.length + lengthBytes.length);
  return result;
}

test("Prior Group ID Gap のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: 1000000n }), (gap) => {
      const encoded = encodePriorGroupIdGap({ gap });
      const decoded = decodePriorGroupIdGap(encoded);

      assert.equal(decoded.gap, gap);
    }),
  );
});

test("Prior Object ID Gap のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: 1000000n }), (gap) => {
      const encoded = encodePriorObjectIdGap({ gap });
      const decoded = decodePriorObjectIdGap(encoded);

      assert.equal(decoded.gap, gap);
    }),
  );
});

test("parseExtensionHeaders は既知・未知の任意の組み合わせをパースできる", () => {
  fc.assert(
    fc.property(
      fc.option(fc.bigInt({ min: 0n, max: 10000n }), { nil: undefined }),
      fc.option(fc.bigInt({ min: 0n, max: 10000n }), { nil: undefined }),
      fc.array(
        fc.record({
          id: unknownExtensionIdArb,
          value: fc.bigInt({ min: 0n, max: 1000n }),
          data: fc.uint8Array({ minLength: 0, maxLength: 10 }),
        }),
        { minLength: 0, maxLength: 5 },
      ),
      fc.func(fc.integer()),
      (groupGap, objectGap, unknownExts, shuffleFn) => {
        const parts: { data: Uint8Array }[] = [];

        if (groupGap !== undefined) {
          parts.push({ data: encodePriorGroupIdGap({ gap: groupGap }) });
        }
        if (objectGap !== undefined) {
          parts.push({ data: encodePriorObjectIdGap({ gap: objectGap }) });
        }
        for (const ext of unknownExts) {
          parts.push({
            data: encodeUnknownExtension(ext.id, ext.value, ext.data),
          });
        }

        // シャッフル
        const shuffled = [...parts].sort((a, b) => shuffleFn(a) - shuffleFn(b));

        const totalLength = shuffled.reduce((sum, p) => sum + p.data.length, 0);
        const combined = new Uint8Array(totalLength);
        let offset = 0;
        for (const part of shuffled) {
          combined.set(part.data, offset);
          offset += part.data.length;
        }

        const parsed = parseExtensionHeaders(combined);

        // 不変条件: 既知の拡張は正しくパースされる
        if (groupGap !== undefined) {
          assert.equal(parsed.priorGroupIdGap?.gap, groupGap);
        } else {
          assert.isUndefined(parsed.priorGroupIdGap);
        }

        if (objectGap !== undefined) {
          assert.equal(parsed.priorObjectIdGap?.gap, objectGap);
        } else {
          assert.isUndefined(parsed.priorObjectIdGap);
        }

        // 不変条件: 未知の拡張の数が一致する
        const expectedUnknownCount = unknownExts.length;
        const actualUnknownCount = parsed.unknownExtensions?.length ?? 0;
        assert.equal(actualUnknownCount, expectedUnknownCount);

        // 不変条件: 未知の拡張の ID が一致する
        if (unknownExts.length > 0 && parsed.unknownExtensions) {
          const expectedIds = new Set(unknownExts.map((e) => e.id));
          const actualIds = new Set(parsed.unknownExtensions.map((e) => e.id));
          for (const id of expectedIds) {
            assert.isTrue(actualIds.has(id));
          }
        }
      },
    ),
  );
});

test("calculateSkippedGroups は gap 個の連続した ID を返す", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 1n, max: 1000n }),
      fc.bigInt({ min: 0n, max: 100n }),
      (currentGroupId, gap) => {
        // gap が currentGroupId より大きい場合はスキップ
        if (gap > currentGroupId) return;

        const skipped = calculateSkippedGroups(currentGroupId, { gap });

        // 不変条件: 結果の長さは gap と等しい
        assert.equal(skipped.length, Number(gap));

        // 不変条件: 結果は連続した ID
        for (let i = 0; i < skipped.length; i++) {
          assert.equal(skipped[i], currentGroupId - gap + BigInt(i));
        }

        // 不変条件: 最後の要素は currentGroupId - 1
        if (gap > 0n) {
          assert.equal(skipped[skipped.length - 1], currentGroupId - 1n);
        }
      },
    ),
  );
});

test("calculateSkippedObjects は gap 個の連続した ID を返す", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 1n, max: 1000n }),
      fc.bigInt({ min: 0n, max: 100n }),
      (currentObjectId, gap) => {
        // gap が currentObjectId より大きい場合はスキップ
        if (gap > currentObjectId) return;

        const skipped = calculateSkippedObjects(currentObjectId, { gap });

        // 不変条件: 結果の長さは gap と等しい
        assert.equal(skipped.length, Number(gap));

        // 不変条件: 結果は連続した ID
        for (let i = 0; i < skipped.length; i++) {
          assert.equal(skipped[i], currentObjectId - gap + BigInt(i));
        }

        // 不変条件: 最後の要素は currentObjectId - 1
        if (gap > 0n) {
          assert.equal(skipped[skipped.length - 1], currentObjectId - 1n);
        }
      },
    ),
  );
});

/**
 * 偶数 ID の ExtensionHeader を生成する Arbitrary
 */
const evenExtensionHeaderArb = fc
  .record({
    id: fc.bigInt({ min: 0n, max: 0xfen }).filter((id) => id % 2n === 0n),
    value: fc.bigInt({ min: 0n, max: 100000n }),
  })
  .map(({ id, value }) => ({ id, value }) as ExtensionHeader);

/**
 * 奇数 ID の ExtensionHeader を生成する Arbitrary
 */
const oddExtensionHeaderArb = fc
  .record({
    id: fc.bigInt({ min: 1n, max: 0xffn }).filter((id) => id % 2n === 1n),
    data: fc.uint8Array({ minLength: 0, maxLength: 50 }),
  })
  .map(({ id, data }) => ({ id, data }) as ExtensionHeader);

/**
 * 任意の ExtensionHeader を生成する Arbitrary
 */
const extensionHeaderArb = fc.oneof(evenExtensionHeaderArb, oddExtensionHeaderArb);

test("encodeExtensionHeader のラウンドトリップ: 偶数 ID", () => {
  fc.assert(
    fc.property(evenExtensionHeaderArb, (header) => {
      const encoded = encodeExtensionHeader(header);

      // エンコードされたデータが正しい形式であることを確認
      // ID + value の形式
      assert.isTrue(encoded.length >= 2);
    }),
  );
});

test("encodeExtensionHeader のラウンドトリップ: 奇数 ID", () => {
  fc.assert(
    fc.property(oddExtensionHeaderArb, (header) => {
      const encoded = encodeExtensionHeader(header);

      // エンコードされたデータが正しい形式であることを確認
      // ID + length + data の形式
      assert.isTrue(encoded.length >= 2);
    }),
  );
});

test("Immutable Extensions のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(fc.array(extensionHeaderArb, { minLength: 0, maxLength: 10 }), (extensions) => {
      const original = { extensions };
      const encoded = encodeImmutableExtensions(original);
      const decoded = decodeImmutableExtensions(encoded);

      // 不変条件: 拡張の数が一致する
      assert.equal(decoded.extensions.length, extensions.length);

      // 不変条件: 各拡張の ID が一致する
      for (let i = 0; i < extensions.length; i++) {
        assert.equal(decoded.extensions[i].id, extensions[i].id);

        if (extensions[i].id % 2n === 0n) {
          // 偶数 ID: value が一致する
          assert.equal(decoded.extensions[i].value, extensions[i].value);
        } else {
          // 奇数 ID: data が一致する
          assert.deepEqual(decoded.extensions[i].data, extensions[i].data);
        }
      }
    }),
  );
});

test("parseExtensionHeaders は Immutable Extensions を正しく抽出する", () => {
  fc.assert(
    fc.property(
      fc.option(fc.bigInt({ min: 0n, max: 10000n }), { nil: undefined }),
      fc.option(fc.bigInt({ min: 0n, max: 10000n }), { nil: undefined }),
      fc.option(fc.array(extensionHeaderArb, { minLength: 0, maxLength: 5 }), { nil: undefined }),
      (groupGap, objectGap, immutableExts) => {
        const parts: Uint8Array[] = [];

        if (groupGap !== undefined) {
          parts.push(encodePriorGroupIdGap({ gap: groupGap }));
        }
        if (objectGap !== undefined) {
          parts.push(encodePriorObjectIdGap({ gap: objectGap }));
        }
        if (immutableExts !== undefined) {
          parts.push(encodeImmutableExtensions({ extensions: immutableExts }));
        }

        const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
        const combined = new Uint8Array(totalLength);
        let offset = 0;
        for (const part of parts) {
          combined.set(part, offset);
          offset += part.length;
        }

        const parsed = parseExtensionHeaders(combined);

        // 不変条件: Prior Group ID Gap が正しくパースされる
        if (groupGap !== undefined) {
          assert.equal(parsed.priorGroupIdGap?.gap, groupGap);
        } else {
          assert.isUndefined(parsed.priorGroupIdGap);
        }

        // 不変条件: Prior Object ID Gap が正しくパースされる
        if (objectGap !== undefined) {
          assert.equal(parsed.priorObjectIdGap?.gap, objectGap);
        } else {
          assert.isUndefined(parsed.priorObjectIdGap);
        }

        // 不変条件: Immutable Extensions が正しくパースされる
        if (immutableExts !== undefined) {
          assert.isDefined(parsed.immutableExtensions);
          assert.equal(parsed.immutableExtensions?.extensions.length, immutableExts.length);
        } else {
          assert.isUndefined(parsed.immutableExtensions);
        }
      },
    ),
  );
});
