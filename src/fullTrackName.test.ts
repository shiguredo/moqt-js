/**
 * Full Track Name の比較キーの単体テスト
 * draft-ietf-moq-transport-21 Section 2.4.1 (Track Naming)
 */

import { test, assert } from "vite-plus/test";
import { fullTrackNameKey } from "./fullTrackName";

/**
 * draft-ietf-moq-transport-21 §2.4.1:
 * 区切り文字の曖昧さで異なる Full Track Name が同じキーにならないことを、
 * 旧実装 ("/" 連結) が衝突していた具体例で検証する。
 */
test("fullTrackNameKey: 区切り文字の曖昧さで衝突する Full Track Name を区別する", () => {
  // namespace ["a"] + trackName "b/c" と namespace ["a","b"] + trackName "c" は
  // "/" 連結ではどちらも "a/b/c" になっていた
  assert.equal(fullTrackNameKey(["a"], "b/c"), "1:a|3:b/c");
  assert.equal(fullTrackNameKey(["a", "b"], "c"), "1:a|1:b|1:c");
  assert.notEqual(fullTrackNameKey(["a"], "b/c"), fullTrackNameKey(["a", "b"], "c"));

  // 値に長さ付きキーの区切り ("|" / ":") が含まれてもフィールド境界が保たれる
  assert.notEqual(fullTrackNameKey(["a"], "|1:b"), fullTrackNameKey(["a|1:b"], ""));
  assert.notEqual(fullTrackNameKey(["1"], "a"), fullTrackNameKey(["1:a"], ""));
});

/**
 * draft-ietf-moq-transport-21 §2.4.1:
 * Track Namespace は 0 フィールド、Track Name は空を許す。境界が消えないよう
 * 空フィールドにも長さ ("0:") を付ける (空の Track Namespace Field は §8.7 が
 * 1 バイト以上を MUST とするため wire 上は現れないが、キー生成は任意の入力で
 * 境界を保つ)。
 */
test("fullTrackNameKey: 空の Track Namespace / Track Name でも境界が残る", () => {
  assert.equal(fullTrackNameKey([], ""), "0:");
  assert.equal(fullTrackNameKey([], "a"), "1:a");
  assert.equal(fullTrackNameKey(["a"], ""), "1:a|0:");
  // 空フィールドの位置と個数が違えば別のキーになる
  assert.notEqual(fullTrackNameKey(["", "a"], ""), fullTrackNameKey(["a"], ""));
  assert.notEqual(fullTrackNameKey([], "a"), fullTrackNameKey(["a"], ""));
});
