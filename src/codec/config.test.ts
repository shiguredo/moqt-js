/**
 * コーデック設定生成関数のテスト
 *
 * WebCodecs に渡す codec 文字列は 1 文字でも誤ると初期化が失敗するため、
 * 各コーデックのマッピングと引数の透過・デフォルト値・フォールバックを pin する。
 */

import { test, assert } from "vite-plus/test";
import {
  getVideoEncoderConfig,
  getVideoDecoderConfig,
  getAudioEncoderConfig,
  getAudioDecoderConfig,
  DEFAULT_AUDIO_SAMPLE_RATE,
  DEFAULT_AUDIO_CHANNELS,
} from "./config";
import type { AudioCodecType, VideoCodecType } from "./types";

// ============================================================================
// getVideoEncoderConfig
// ============================================================================

test("getVideoEncoderConfig: vp8 は codec 文字列 vp8 を返す", () => {
  const config = getVideoEncoderConfig("vp8", 640, 480, 1_000_000, 30);
  assert.equal(config.codec, "vp8");
});

test("getVideoEncoderConfig: vp9 は codec 文字列 vp09.00.10.08 を返す", () => {
  const config = getVideoEncoderConfig("vp9", 640, 480, 1_000_000, 30);
  assert.equal(config.codec, "vp09.00.10.08");
});

test("getVideoEncoderConfig: av1 は codec 文字列 av01.0.04M.08 を返す", () => {
  const config = getVideoEncoderConfig("av1", 640, 480, 1_000_000, 30);
  assert.equal(config.codec, "av01.0.04M.08");
});

test("getVideoEncoderConfig: h264 は codec 文字列 avc1.42001f と avc.format annexb を返す", () => {
  const config = getVideoEncoderConfig("h264", 640, 480, 1_000_000, 30);
  assert.equal(config.codec, "avc1.42001f");
  // H.264 は Annex B 形式を明示する必要がある
  assert.deepEqual(config.avc, { format: "annexb" });
});

test("getVideoEncoderConfig: h265 は codec 文字列 hvc1.1.6.L93.B0 と hevc.format annexb を返す", () => {
  const config = getVideoEncoderConfig("h265", 640, 480, 1_000_000, 30);
  assert.equal(config.codec, "hvc1.1.6.L93.B0");
  // H.265 も Annex B 形式を明示する必要がある。
  // lib.dom.d.ts の VideoEncoderConfig 型は WebCodecs の hevc フィールドを
  // まだ定義していないため、実行時の値を型キャストで検証する。
  assert.deepEqual((config as { hevc?: unknown }).hevc, { format: "annexb" });
});

test("getVideoEncoderConfig: width / height / bitrate / framerate が引数どおりに反映される", () => {
  // 数値フィールドが透過されることを検証する
  const config = getVideoEncoderConfig("vp8", 1920, 1080, 5_000_000, 60);
  assert.equal(config.width, 1920);
  assert.equal(config.height, 1080);
  assert.equal(config.bitrate, 5_000_000);
  assert.equal(config.framerate, 60);
});

test("getVideoEncoderConfig: 未知の codec は vp8 にフォールバックする", () => {
  // default 分岐の検証。union 外の値を渡すため型アサーションを使う
  const config = getVideoEncoderConfig("unknown" as VideoCodecType, 640, 480, 1_000_000, 30);
  assert.equal(config.codec, "vp8");
  assert.equal(config.width, 640);
  assert.equal(config.height, 480);
});

// ============================================================================
// getVideoDecoderConfig
// ============================================================================

test("getVideoDecoderConfig: 各コーデックの codec 文字列を返す", () => {
  // Decoder も Encoder と同じ codec 文字列マッピングを使う
  assert.equal(getVideoDecoderConfig("vp8", 640, 480).codec, "vp8");
  assert.equal(getVideoDecoderConfig("vp9", 640, 480).codec, "vp09.00.10.08");
  assert.equal(getVideoDecoderConfig("av1", 640, 480).codec, "av01.0.04M.08");
  assert.equal(getVideoDecoderConfig("h264", 640, 480).codec, "avc1.42001f");
  assert.equal(getVideoDecoderConfig("h265", 640, 480).codec, "hvc1.1.6.L93.B0");
});

test("getVideoDecoderConfig: codedWidth / codedHeight に width / height を設定する", () => {
  const config = getVideoDecoderConfig("vp9", 1280, 720);
  assert.equal(config.codedWidth, 1280);
  assert.equal(config.codedHeight, 720);
});

test("getVideoDecoderConfig: description を透過する", () => {
  // avcC / hvcC 等の extradata がそのまま description に渡ることを検証する
  const description = new Uint8Array([0x01, 0x02, 0x03]);
  const config = getVideoDecoderConfig("h264", 640, 480, description);
  assert.deepEqual(config.description, description);
});

test("getVideoDecoderConfig: description 省略時は undefined になる", () => {
  const config = getVideoDecoderConfig("vp8", 640, 480);
  assert.isUndefined(config.description);
});

test("getVideoDecoderConfig: 未知の codec は vp8 にフォールバックする", () => {
  const config = getVideoDecoderConfig("unknown" as VideoCodecType, 640, 480);
  assert.equal(config.codec, "vp8");
});

// ============================================================================
// getAudioEncoderConfig
// ============================================================================

test("getAudioEncoderConfig: opus は codec 文字列 opus を返す", () => {
  const config = getAudioEncoderConfig("opus", 128_000);
  assert.equal(config.codec, "opus");
});

test("getAudioEncoderConfig: aac は codec 文字列 mp4a.40.2 を返す", () => {
  const config = getAudioEncoderConfig("aac", 128_000);
  assert.equal(config.codec, "mp4a.40.2");
});

test("getAudioEncoderConfig: bitrate が引数どおりに反映される", () => {
  const config = getAudioEncoderConfig("opus", 96_000);
  assert.equal(config.bitrate, 96_000);
});

test("getAudioEncoderConfig: sampleRate / channels 省略時はデフォルト値を使う", () => {
  // sampleRate=48000, channels=2 のデフォルトが適用されることを検証する
  const config = getAudioEncoderConfig("opus", 128_000);
  assert.equal(config.sampleRate, DEFAULT_AUDIO_SAMPLE_RATE);
  assert.equal(config.numberOfChannels, DEFAULT_AUDIO_CHANNELS);
  assert.equal(config.sampleRate, 48_000);
  assert.equal(config.numberOfChannels, 2);
});

test("getAudioEncoderConfig: sampleRate / channels を指定すると引数どおりに反映される", () => {
  const config = getAudioEncoderConfig("aac", 128_000, 44_100, 1);
  assert.equal(config.sampleRate, 44_100);
  assert.equal(config.numberOfChannels, 1);
});

test("getAudioEncoderConfig: 未知の codec は opus にフォールバックする", () => {
  const config = getAudioEncoderConfig("unknown" as AudioCodecType, 128_000);
  assert.equal(config.codec, "opus");
});

// ============================================================================
// getAudioDecoderConfig
// ============================================================================

test("getAudioDecoderConfig: 各コーデックの codec 文字列を返す", () => {
  assert.equal(getAudioDecoderConfig("opus").codec, "opus");
  assert.equal(getAudioDecoderConfig("aac").codec, "mp4a.40.2");
});

test("getAudioDecoderConfig: sampleRate / channels 省略時はデフォルト値を使う", () => {
  // Encoder と同じく sampleRate=48000, channels=2 のデフォルトが適用されることを検証する
  const config = getAudioDecoderConfig("opus");
  assert.equal(config.sampleRate, DEFAULT_AUDIO_SAMPLE_RATE);
  assert.equal(config.numberOfChannels, DEFAULT_AUDIO_CHANNELS);
  assert.equal(config.sampleRate, 48_000);
  assert.equal(config.numberOfChannels, 2);
});

test("getAudioDecoderConfig: sampleRate / channels を指定すると引数どおりに反映される", () => {
  const config = getAudioDecoderConfig("aac", 16_000, 1);
  assert.equal(config.sampleRate, 16_000);
  assert.equal(config.numberOfChannels, 1);
});

test("getAudioDecoderConfig: 未知の codec は opus にフォールバックする", () => {
  const config = getAudioDecoderConfig("unknown" as AudioCodecType);
  assert.equal(config.codec, "opus");
});
