/**
 * VideoDecodeOrder の Property-Based Tests
 *
 * publisher が送る映像 Object 列をモデルとして生成し、損失と到着順の入れ替えを
 * 任意に加えて VideoDecodeOrder に通す。復号すると判定した Object 列が、decoder が
 * 参照フレームを欠かさずに復号できる列になっていることを、実装と独立した判定で
 * 確かめる。
 *
 * - 各 Group の先頭 (Object ID 0) はキーフレームであり、以降は直前の Object を参照する
 *   delta である
 * - publisher は Object ID を飛ばすことがあり、飛ばした数は次の Object の Prior Object
 *   ID Gap (draft-ietf-moq-transport-21 Section 10.9) で示す
 * - 経路では任意の Object が失われ、到着順は任意に入れ替わる (Section 2.1)
 *
 * 境界値 (前の Group の遅着、Prior Object ID Gap の範囲外の欠けなど) は
 * videoDecodeOrder.test.ts の単体テストが固定する。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { VideoDecodeOrder, type VideoObjectPosition } from "./videoDecodeOrder";

/**
 * publisher が送った 1 Object
 */
interface PublishedObject extends VideoObjectPosition {
  /**
   * 同じ Group で、この Object の直前に存在する Object の Object ID
   * (先頭の Object は null)
   */
  readonly previousExistingObjectId: bigint | null;
}

/**
 * 1 Group 分の Object を生成する
 *
 * 各 Object について、直前に publisher が飛ばした Object ID の数 (0 から 2) を選ぶ。
 * 先頭の Object は Object ID 0 のキーフレームであり、飛ばしは無い。
 */
function groupArbitrary(groupId: bigint): fc.Arbitrary<PublishedObject[]> {
  return fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 0, maxLength: 8 }).map((skips) => {
    const objects: PublishedObject[] = [
      {
        groupId,
        objectId: 0n,
        isKeyFrame: true,
        priorObjectIdGap: 0n,
        previousExistingObjectId: null,
      },
    ];
    let objectId = 0n;
    for (const skip of skips) {
      const previous = objectId;
      objectId += BigInt(skip) + 1n;
      objects.push({
        groupId,
        objectId,
        isKeyFrame: false,
        priorObjectIdGap: BigInt(skip),
        previousExistingObjectId: previous,
      });
    }
    return objects;
  });
}

/**
 * 連続する Group の Object 列を生成する (Group ID は 0 から順に振る)
 */
const publishedArbitrary: fc.Arbitrary<PublishedObject[]> = fc
  .integer({ min: 1, max: 5 })
  .chain((groupCount) =>
    fc.tuple(
      ...Array.from({ length: groupCount }, (_unused, index) => groupArbitrary(BigInt(index))),
    ),
  )
  .map((groups) => groups.flat());

/**
 * 損失と到着順の入れ替えを加えた受信列を生成する
 */
const receivedArbitrary: fc.Arbitrary<{
  published: PublishedObject[];
  received: PublishedObject[];
}> = publishedArbitrary.chain((published) =>
  fc
    .shuffledSubarray(published, { minLength: 0, maxLength: published.length })
    .map((received) => ({ published, received })),
);

/**
 * VideoDecodeOrder が復号すると判定した Object を到着順に返す
 */
function decodedObjects(received: readonly PublishedObject[]): PublishedObject[] {
  const decodeOrder = new VideoDecodeOrder();
  return received.filter((object) => decodeOrder.admit(object).decode);
}

test("復号する delta は、同じ Group で直前に復号した Object の次に存在する Object である", () => {
  // decoder は delta の参照先 (直前に存在する Object) を復号済みでなければならない。
  // 損失と入れ替えがあっても、参照先を欠いた delta を復号しないことを確かめる
  fc.assert(
    fc.property(receivedArbitrary, ({ received }) => {
      const decoded = decodedObjects(received);
      decoded.forEach((object, index) => {
        if (object.isKeyFrame) {
          return;
        }
        const previous = decoded[index - 1];
        assert.isDefined(previous, "キーフレームより前の delta を復号した");
        assert.strictEqual(object.groupId, previous?.groupId, "別の Group の delta を復号した");
        assert.strictEqual(
          object.previousExistingObjectId,
          previous?.objectId,
          "参照先を復号していない delta を復号した",
        );
      });
    }),
  );
});

test("復号する Group の ID は非減少である", () => {
  // 次の Group のキーフレームを復号した後に、前の Group の Object を復号しない
  fc.assert(
    fc.property(receivedArbitrary, ({ received }) => {
      const decoded = decodedObjects(received);
      for (let index = 1; index < decoded.length; index++) {
        const previous = decoded[index - 1];
        const current = decoded[index];
        assert.isDefined(previous);
        assert.isDefined(current);
        if (previous !== undefined && current !== undefined) {
          assert.isTrue(current.groupId >= previous.groupId, "前の Group の Object を復号した");
        }
      }
    }),
  );
});

test("損失も入れ替えも無ければ、すべての Object を復号する", () => {
  // Prior Object ID Gap で示した Object ID の飛びは欠落ではないため、どこでも止まらない
  fc.assert(
    fc.property(publishedArbitrary, (published) => {
      assert.strictEqual(decodedObjects(published).length, published.length);
    }),
  );
});
