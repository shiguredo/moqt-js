/**
 * src/session/params.ts の純粋関数テスト
 */

import { test, assert } from "vite-plus/test";
import { clampTimeoutMs } from "./params";

// ============================================================================
// clampTimeoutMs
// ============================================================================

test("clampTimeoutMs: 通常値はそのまま number に変換される", () => {
  // 上限以下の通常のタイムアウト値は変化しないことを検証する
  assert.equal(clampTimeoutMs(1000n), 1000);
});

test("clampTimeoutMs: 1n はそのまま 1 になる", () => {
  assert.equal(clampTimeoutMs(1n), 1);
});

test("clampTimeoutMs: 上限ちょうど (2^31 - 1) はクランプされない", () => {
  // 2147483647 (2^31 - 1) は setTimeout の上限ちょうどなのでそのまま返す
  assert.equal(clampTimeoutMs(2147483647n), 2147483647);
});

test("clampTimeoutMs: 上限 +1 は 2^31 - 1 にクランプされる", () => {
  // 2147483648 (上限 +1) を超えると即発火するため上限でクランプする
  assert.equal(clampTimeoutMs(2147483648n), 2147483647);
});

test("clampTimeoutMs: varint 上限近傍の巨大値も 2^31 - 1 にクランプされる", () => {
  // 受信 GOAWAY のピア由来の巨大値 (2^62) でも上限で抑えられることを検証する
  assert.equal(clampTimeoutMs(2n ** 62n), 2147483647);
});

test("clampTimeoutMs: bigint の最大級の値でも 2^31 - 1 にクランプされる", () => {
  // varint の理論上限 (2^64 - 1) でも Number 変換が Infinity にならず上限でクランプされる
  assert.equal(clampTimeoutMs(18446744073709551615n), 2147483647);
});
