import { test, assert } from "vite-plus/test";
import { formatCatalogValue } from "./catalogValue";

// catalog の値は JSON の値である (draft-ietf-moq-msf-01 §5.1)。接続設定の Tracks カードと
// Catalog パネルが同じ値に同じ書式を使うため、書式をこの 1 か所で固定する
test("formatCatalogValue: 数値と文字列はそのまま出す", () => {
  assert.equal(formatCatalogValue("samplerate", 48_000), "48000");
  assert.equal(formatCatalogValue("channelConfig", "2"), "2");
  assert.equal(formatCatalogValue("width", 1280), "1280");
  assert.equal(formatCatalogValue("packaging", "loc"), "loc");
  // isLive は真偽値。catalog の JSON と同じ表記にする
  assert.equal(formatCatalogValue("isLive", true), "true");
  assert.equal(formatCatalogValue("isLive", false), "false");
});

// ビットレートだけは単位を付ける (utils/logFormatters.ts の formatBitrate)。
// 1000 進の kbps / Mbps を使い、値が変わっても読み取れるようにする
test("formatCatalogValue: bitrate だけは単位を付ける", () => {
  assert.equal(formatCatalogValue("bitrate", 64_000), "64 kbps");
  assert.equal(formatCatalogValue("bitrate", 128_000), "128 kbps");
  assert.equal(formatCatalogValue("bitrate", 2_000_000), "2.0 Mbps");
  // bitrate 以外の数値には単位を付けない (catalog の生の値)
  assert.equal(formatCatalogValue("samplerate", 64_000), "64000");
});

// 配列 (depends) とオブジェクト (authInfo) は JSON の表記のまま出す。String() では
// "audio,video" や "[object Object]" になり、送っている catalog の値が読めなくなる
test("formatCatalogValue: 配列とオブジェクトは JSON の表記で出す", () => {
  assert.equal(formatCatalogValue("depends", ["audio", "video"]), '["audio","video"]');
  assert.equal(formatCatalogValue("depends", []), "[]");
  assert.equal(formatCatalogValue("authInfo", { cat: "%c4m%" }), '{"cat":"%c4m%"}');
  // null は JSON でも String でも "null" になる
  assert.equal(formatCatalogValue("label", null), "null");
});
