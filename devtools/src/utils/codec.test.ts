import { test, assert } from "vite-plus/test";
import { getCatalogCodec, getEncoderConfig, isResolution, parseResolution } from "./codec";
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

// 既定値と一般的な解像度が数値に変換される。
test("parseResolution parses WIDTHxHEIGHT", () => {
  assert.deepEqual(parseResolution("1280x720"), { width: 1280, height: 720 });
  assert.deepEqual(parseResolution("640x480"), { width: 640, height: 480 });
});

// URL クエリ由来の不正値で例外にし、NaN を getUserMedia へ流さない。
test("parseResolution throws on invalid values", () => {
  // 区切り文字違い・欠落・全角・負数・単位付きはすべて拒否する。
  for (const value of ["1280", "1280X720", "1280x", "x720", "1280x720px", "-1280x720", ""]) {
    assert.throws(() => parseResolution(value), /invalid resolution/);
  }
});

// 0 は幅・高さとして意味を持たないため拒否する。
test("parseResolution throws on zero width or height", () => {
  for (const value of ["0x720", "1280x0", "0x0", "01280x720"]) {
    assert.throws(() => parseResolution(value), /invalid resolution/);
  }
});

// 安全な整数の範囲外は Number の精度が落ちるため拒否する。
test("parseResolution throws when the value exceeds safe integers", () => {
  assert.throws(() => parseResolution("99999999999999999999x720"), /invalid resolution/);
});

// isResolution は parseResolution が受理する値だけを true にする。
test("isResolution accepts exactly the values parseResolution accepts", () => {
  for (const value of ["1280x720", "640x480", "1x1"]) {
    assert.ok(isResolution(value));
    assert.deepEqual(parseResolution(value), {
      width: Number(value.split("x")[0]),
      height: Number(value.split("x")[1]),
    });
  }
  for (const value of ["0x720", "1280x0", "1280", "1280X720", "1280x720px", "", " 1280x720"]) {
    assert.equal(isResolution(value), false);
  }
});
