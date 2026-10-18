/**
 * 画面の開け閉めの signal の単体テスト
 */

import { test, assert } from "vite-plus/test";
import {
  closeVideoLightbox,
  isConnectionSettingsOpen,
  lightboxVideoKey,
  openVideoLightbox,
  toggleConnectionSettings,
} from "./layout";

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

// ライトボックスは初期状態では開いていない (ページを開いた直後の状態)
test("lightboxVideoKey: 既定では開いている映像が無い", () => {
  closeVideoLightbox();
  assert.isNull(lightboxVideoKey.value);
});

// 映像を開くとそのキーを保持し、別の映像を開くと 1 枚だけに置き換わる
test("openVideoLightbox: 後から開いた映像だけがライトボックスになる", () => {
  openVideoLightbox("publisher-video");
  assert.equal(lightboxVideoKey.value, "publisher-video");

  openVideoLightbox("subscriber-video-subscriber-00000000");
  assert.equal(lightboxVideoKey.value, "subscriber-video-subscriber-00000000");
});

// 閉じると開いている映像が無くなる
test("closeVideoLightbox: 開いている映像を閉じる", () => {
  openVideoLightbox("publisher-video");
  closeVideoLightbox();
  assert.isNull(lightboxVideoKey.value);
});
