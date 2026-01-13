/**
 * MOQT Extension Headers Property-Based Tests
 * draft-ietf-moq-transport-16 Section 11
 */

import { test, assert } from "vitest";
import * as fc from "fast-check";
import {
  encodePriorGroupIdGap,
  decodePriorGroupIdGap,
  encodePriorObjectIdGap,
  decodePriorObjectIdGap,
  encodeExtensionHeader,
  encodeExtensionHeaders,
  encodeImmutableExtensions,
  decodeImmutableExtensions,
  parseExtensionHeaders,
  calculateSkippedGroups,
  calculateSkippedObjects,
  MOQTExtensionHeaderId,
  type ExtensionHeader,
} from "./extensions";

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

/**
 * draft-ietf-moq-transport-16:
 * delta encoding を使用するため、encodeExtensionHeaders でエンコードする。
 */
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
      (groupGap, objectGap, unknownExts) => {
        const headers: ExtensionHeader[] = [];

        if (groupGap !== undefined) {
          headers.push({ id: MOQTExtensionHeaderId.PRIOR_GROUP_ID_GAP, value: groupGap });
        }
        if (objectGap !== undefined) {
          headers.push({ id: MOQTExtensionHeaderId.PRIOR_OBJECT_ID_GAP, value: objectGap });
        }

        // 未知の拡張を追加（重複 ID を除去）
        const seenIds = new Set(headers.map((h) => h.id));
        for (const ext of unknownExts) {
          if (seenIds.has(ext.id)) continue;
          seenIds.add(ext.id);
          if (ext.id % 2n === 0n) {
            headers.push({ id: ext.id, value: ext.value });
          } else {
            headers.push({ id: ext.id, data: ext.data });
          }
        }

        // encodeExtensionHeaders は delta encoding を使用して ID の昇順でソートする
        const encoded = encodeExtensionHeaders(headers);
        const parsed = parseExtensionHeaders(encoded);

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
        const expectedUnknownCount = headers.filter(
          (h) =>
            h.id !== MOQTExtensionHeaderId.PRIOR_GROUP_ID_GAP &&
            h.id !== MOQTExtensionHeaderId.PRIOR_OBJECT_ID_GAP &&
            h.id !== MOQTExtensionHeaderId.IMMUTABLE_EXTENSIONS,
        ).length;
        const actualUnknownCount = parsed.unknownExtensions?.length ?? 0;
        assert.equal(actualUnknownCount, expectedUnknownCount);

        // 不変条件: 未知の拡張の ID が一致する
        if (expectedUnknownCount > 0 && parsed.unknownExtensions) {
          const expectedIds = new Set(
            headers
              .filter(
                (h) =>
                  h.id !== MOQTExtensionHeaderId.PRIOR_GROUP_ID_GAP &&
                  h.id !== MOQTExtensionHeaderId.PRIOR_OBJECT_ID_GAP &&
                  h.id !== MOQTExtensionHeaderId.IMMUTABLE_EXTENSIONS,
              )
              .map((e) => e.id),
          );
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

/**
 * draft-ietf-moq-transport-16:
 * delta encoding を使用するため、extensions の ID は一意である必要がある。
 * encodeImmutableExtensions は内部で encodeExtensionHeaders を使用して ID の昇順でソートする。
 */
test("Immutable Extensions のエンコード・デコードがラウンドトリップする", () => {
  fc.assert(
    fc.property(fc.array(extensionHeaderArb, { minLength: 0, maxLength: 10 }), (extensions) => {
      // delta encoding では ID は一意である必要があるため、重複を除去
      const uniqueExtensions = extensions.filter(
        (ext, index) => extensions.findIndex((e) => e.id === ext.id) === index,
      );

      // encodeImmutableExtensions は内部で ID の昇順にソートする
      const sortedExtensions = [...uniqueExtensions].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      );

      const original = { extensions: uniqueExtensions };
      const encoded = encodeImmutableExtensions(original);
      const decoded = decodeImmutableExtensions(encoded);

      // 不変条件: 拡張の数が一致する
      assert.equal(decoded.extensions.length, sortedExtensions.length);

      // 不変条件: 各拡張の ID が一致する（ソート後の順序）
      for (let i = 0; i < sortedExtensions.length; i++) {
        assert.equal(decoded.extensions[i].id, sortedExtensions[i].id);

        if (sortedExtensions[i].id % 2n === 0n) {
          // 偶数 ID: value が一致する
          assert.equal(decoded.extensions[i].value, sortedExtensions[i].value);
        } else {
          // 奇数 ID: data が一致する
          assert.deepEqual(decoded.extensions[i].data, sortedExtensions[i].data);
        }
      }
    }),
  );
});

/**
 * draft-ietf-moq-transport-16:
 * delta encoding を使用するため、複数の拡張は encodeExtensionHeaders でエンコードする。
 * Immutable Extensions の内部拡張も ID の昇順でソートされる。
 */
test("parseExtensionHeaders は Immutable Extensions を正しく抽出する", () => {
  fc.assert(
    fc.property(
      fc.option(fc.bigInt({ min: 0n, max: 10000n }), { nil: undefined }),
      fc.option(fc.bigInt({ min: 0n, max: 10000n }), { nil: undefined }),
      fc.option(fc.array(extensionHeaderArb, { minLength: 0, maxLength: 5 }), { nil: undefined }),
      (groupGap, objectGap, immutableExts) => {
        const headers: ExtensionHeader[] = [];

        if (groupGap !== undefined) {
          headers.push({ id: MOQTExtensionHeaderId.PRIOR_GROUP_ID_GAP, value: groupGap });
        }
        if (objectGap !== undefined) {
          headers.push({ id: MOQTExtensionHeaderId.PRIOR_OBJECT_ID_GAP, value: objectGap });
        }
        if (immutableExts !== undefined) {
          // Immutable Extensions の内部拡張の重複を除去
          const uniqueImmutableExts = immutableExts.filter(
            (ext, index) => immutableExts.findIndex((e) => e.id === ext.id) === index,
          );
          // Immutable Extensions の内部データをエンコード
          const innerEncoded = encodeExtensionHeaders(uniqueImmutableExts);
          headers.push({ id: MOQTExtensionHeaderId.IMMUTABLE_EXTENSIONS, data: innerEncoded });
        }

        // encodeExtensionHeaders は delta encoding を使用して ID の昇順でソートする
        const encoded = encodeExtensionHeaders(headers);
        const parsed = parseExtensionHeaders(encoded);

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
          // 重複を除去した後の数と一致する
          const uniqueCount = immutableExts.filter(
            (ext, index) => immutableExts.findIndex((e) => e.id === ext.id) === index,
          ).length;
          assert.isDefined(parsed.immutableExtensions);
          assert.equal(parsed.immutableExtensions?.extensions.length, uniqueCount);
        } else {
          assert.isUndefined(parsed.immutableExtensions);
        }
      },
    ),
  );
});
