/**
 * 画面の開け閉めの signal の単体テスト
 */

import { test, assert } from "vite-plus/test";
import { isConnectionSettingsOpen, toggleConnectionSettings } from "./layout";

// 接続設定の欄は既定で開く (覚えた状態が無いとき。単体テストの Node には localStorage が無い)
test("isConnectionSettingsOpen: 既定は開いている", () => {
  assert.isTrue(isConnectionSettingsOpen.value);
});

// 見出しを押すたびに開け閉めが入れ替わる
test("toggleConnectionSettings: 押すたびに開け閉めが入れ替わる", () => {
  isConnectionSettingsOpen.value = true;
  toggleConnectionSettings();
  assert.isFalse(isConnectionSettingsOpen.value);
  toggleConnectionSettings();
  assert.isTrue(isConnectionSettingsOpen.value);
});
