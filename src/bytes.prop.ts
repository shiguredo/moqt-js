import { assert, test } from "vite-plus/test";
import * as fc from "fast-check";
import { bytesEqual } from "./bytes";

test("bytesEqual はビューの前後を除き、語の途中と末尾の不一致を検出する", () => {
  const size = fc.oneof(
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 256, max: 259 }),
    fc.integer({ min: 260, max: 4096 }),
  );
  const bytes = size.chain((length) => fc.uint8Array({ minLength: length, maxLength: length }));
  const offset = fc.integer({ min: 0, max: 7 });
  fc.assert(
    fc.property(bytes, offset, offset, fc.nat(), (value, leftOffset, rightOffset, position) => {
      // ビューの外側だけ異なる配列を作り、比較が byteOffset と length に従うか確認する。
      const left = new Uint8Array(leftOffset + value.length + 4)
        .fill(0x11)
        .subarray(leftOffset, leftOffset + value.length);
      const right = new Uint8Array(rightOffset + value.length + 4)
        .fill(0x22)
        .subarray(rightOffset, rightOffset + value.length);
      left.set(value);
      right.set(value);
      assert.isTrue(bytesEqual(left, right));
      if (value.length === 0) return;

      // 語単位の比較を使うときも、先頭・途中・末尾のどの違いも検出する。
      for (const index of [0, position % value.length, value.length - 1]) {
        right[index] = value[index]! ^ 0x80;
        assert.isFalse(bytesEqual(left, right));
        right[index] = value[index]!;
      }
      assert.isFalse(bytesEqual(left, right.subarray(1)));
    }),
  );
});
