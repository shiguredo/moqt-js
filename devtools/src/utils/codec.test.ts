import { test, assert } from "vite-plus/test";
import { getCatalogCodec, getEncoderConfig } from "./codec";
import type { CodecType } from "../types";

// Catalog の codec 文字列はエンコーダ設定と一致させる。
// h264 / h265 選択時に av1 用文字列を誤記しないことの検証。
test("getCatalogCodec returns expected catalog codec strings", () => {
  assert.equal(getCatalogCodec("vp8"), "vp8");
  assert.equal(getCatalogCodec("vp9"), "vp09.00.10.08");
  assert.equal(getCatalogCodec("av1"), "av01.0.04M.08");
  assert.equal(getCatalogCodec("h264"), "avc1.42001f");
  assert.equal(getCatalogCodec("h265"), "hvc1.1.6.L93.B0");
});

// 対応表の重複による将来の乖離を検出するため、
// getEncoderConfig の codec 文字列との一致を検証する。
// width 等は codec 文字列に影響しない任意値である。
test("getCatalogCodec matches getEncoderConfig codec strings", () => {
  const codecs = ["vp8", "vp9", "av1", "h264", "h265"] as const;
  for (const codec of codecs) {
    assert.equal(getCatalogCodec(codec), getEncoderConfig(codec, 640, 480, 1000000, 30).codec);
  }
  // default フォールバックの一致
  const unknownCodec = "unknown" as unknown as CodecType;
  assert.equal(
    getCatalogCodec(unknownCodec),
    getEncoderConfig(unknownCodec, 640, 480, 1000000, 30).codec,
  );
});
