import { test, assert } from "vite-plus/test";
import { useCopyFeedback } from "./useCopyFeedback";

// hook 本体は Preact ランタイム下でしか呼べないため、API シグネチャの
// type-only 検証と navigator.clipboard 不在ガードを行う最小限のテストに留める。

test("useCopyFeedback is a function with single-arg signature", () => {
  assert.equal(typeof useCopyFeedback, "function");
  // durationMs は optional のため引数 0 個の呼び出しを許容する型定義。
  // 型レベルの検証は tsc が担保する。
  assert.equal(useCopyFeedback.length, 0);
});

// navigator.clipboard が利用可能な環境では copy() の挙動検証は
// renderHook 等の Preact テストランタイム導入後に拡張する。
test("test environment assumption: navigator.clipboard is unavailable in jsdom", () => {
  // jsdom 経由のテスト環境では navigator.clipboard は基本的に未定義。
  // polyfill が混入した場合は明示的に失敗させて気付けるようにする。
  if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
    throw new Error(
      "navigator.clipboard is unexpectedly polyfilled; hook tests need real Preact runtime",
    );
  }
  assert.ok(true);
});
