/**
 * storedFlag の単体テスト
 *
 * 画面の開け閉めなど、見る人ごとの使い勝手のための on / off をブラウザに覚える。覚えていない
 * ときや読めない値のときは既定の値を使う。単体テストは Node で動き、localStorage が無いため、
 * localStorage が使えないときの振る舞い (既定の値を使い、書けなくても投げない) もここで確かめる
 */

import { test, assert } from "vite-plus/test";
import { parseStoredFlag, readStoredFlag, writeStoredFlag } from "./storedFlag";

// 覚えた "1" / "0" は既定の値に依らずそのまま on / off になる
test("parseStoredFlag: 覚えた 1 / 0 を on / off にする", () => {
  assert.isTrue(parseStoredFlag("1", false));
  assert.isFalse(parseStoredFlag("0", true));
});

// 覚えていない (null) ときは既定の値を使う
test("parseStoredFlag: 覚えていないときは既定の値を使う", () => {
  assert.isTrue(parseStoredFlag(null, true));
  assert.isFalse(parseStoredFlag(null, false));
});

// 他の値 (手で書き換えた、形式を変えたなど) は読めない値として既定の値を使う
test("parseStoredFlag: 読めない値は既定の値を使う", () => {
  assert.isTrue(parseStoredFlag("true", true));
  assert.isFalse(parseStoredFlag("yes", false));
  assert.isTrue(parseStoredFlag("", true));
});

// localStorage が使えない (Node、プライベートウィンドウ、保存の拒否など) ときは既定の値を使い、
// 書いても投げない (画面は覚えずに動き続ける)
test("readStoredFlag / writeStoredFlag: localStorage が使えないときは既定の値を使い、書いても投げない", () => {
  writeStoredFlag("moqt-devtools.test", false);
  assert.isTrue(readStoredFlag("moqt-devtools.test", true));
  assert.isFalse(readStoredFlag("moqt-devtools.test", false));
});
