/**
 * session/stream.ts の純粋関数の単体テスト
 */

import { test, assert } from "vite-plus/test";
import { concatChunks } from "./stream";

// ============================================================================
// concatChunks
// ============================================================================

test("concatChunks: 空配列は空の Uint8Array を返す", () => {
  const result = concatChunks([]);
  assert.equal(result.byteLength, 0);
});

test("concatChunks: 単一チャンクはそのまま返す", () => {
  const chunk = new Uint8Array([1, 2, 3]);
  const result = concatChunks([chunk]);
  assert.equal(result.byteLength, 3);
  assert.deepEqual([...result], [1, 2, 3]);
});

test("concatChunks: 複数チャンクを結合する", () => {
  const result = concatChunks([
    new Uint8Array([1, 2]),
    new Uint8Array([3, 4, 5]),
    new Uint8Array([6]),
  ]);
  assert.equal(result.byteLength, 6);
  assert.deepEqual([...result], [1, 2, 3, 4, 5, 6]);
});

test("concatChunks: 空チャンクが混ざっても正しく結合する", () => {
  const result = concatChunks([
    new Uint8Array([]),
    new Uint8Array([1, 2]),
    new Uint8Array([]),
    new Uint8Array([3]),
  ]);
  assert.equal(result.byteLength, 3);
  assert.deepEqual([...result], [1, 2, 3]);
});
