/**
 * Codec config の単体テスト
 */

import { test, assert } from "vite-plus/test";
import {
  DEFAULT_AUDIO_CHANNELS,
  DEFAULT_AUDIO_SAMPLE_RATE,
  DEFAULT_VIDEO_FRAMERATE,
  getAudioDecoderConfig,
  getAudioEncoderConfig,
  getVideoDecoderConfig,
  getVideoEncoderConfig,
} from "./config";

// =============================================================================
// Audio Encoder Config
// =============================================================================

test("getAudioEncoderConfig(opus) は codec=opus の WebCodecs config を返す", () => {
  const config = getAudioEncoderConfig("opus", 64000, 48000, 2);
  assert.equal(config.codec, "opus");
  assert.equal(config.sampleRate, 48000);
  assert.equal(config.numberOfChannels, 2);
  assert.equal(config.bitrate, 64000);
});

test("getAudioEncoderConfig(aac) は codec=mp4a.40.2 を返す", () => {
  const config = getAudioEncoderConfig("aac", 128000, 44100, 1);
  assert.equal(config.codec, "mp4a.40.2");
  assert.equal(config.sampleRate, 44100);
  assert.equal(config.numberOfChannels, 1);
  assert.equal(config.bitrate, 128000);
});

test("getAudioEncoderConfig は sampleRate と channels のデフォルト値を適用する", () => {
  const config = getAudioEncoderConfig("opus", 64000);
  assert.equal(config.sampleRate, DEFAULT_AUDIO_SAMPLE_RATE);
  assert.equal(config.numberOfChannels, DEFAULT_AUDIO_CHANNELS);
});

// =============================================================================
// Audio Decoder Config
// =============================================================================

test("getAudioDecoderConfig(opus) は codec=opus を返す", () => {
  const config = getAudioDecoderConfig("opus", 48000, 2);
  assert.equal(config.codec, "opus");
  assert.equal(config.sampleRate, 48000);
  assert.equal(config.numberOfChannels, 2);
});

test("getAudioDecoderConfig(aac) は codec=mp4a.40.2 を返す", () => {
  const config = getAudioDecoderConfig("aac", 44100, 1);
  assert.equal(config.codec, "mp4a.40.2");
  assert.equal(config.sampleRate, 44100);
  assert.equal(config.numberOfChannels, 1);
});

test("getAudioDecoderConfig は sampleRate と channels のデフォルト値を適用する", () => {
  const config = getAudioDecoderConfig("aac");
  assert.equal(config.sampleRate, DEFAULT_AUDIO_SAMPLE_RATE);
  assert.equal(config.numberOfChannels, DEFAULT_AUDIO_CHANNELS);
});

// =============================================================================
// Video Encoder Config
// =============================================================================

test("getVideoEncoderConfig(vp8) は codec=vp8 を返す", () => {
  const config = getVideoEncoderConfig("vp8", 640, 480, 1_000_000, 30);
  assert.equal(config.codec, "vp8");
  assert.equal(config.width, 640);
  assert.equal(config.height, 480);
  assert.equal(config.bitrate, 1_000_000);
  assert.equal(config.framerate, 30);
});

test("getVideoEncoderConfig(vp9) は codec=vp09.00.10.08 を返す", () => {
  const config = getVideoEncoderConfig("vp9", 1280, 720, 2_000_000, 60);
  assert.equal(config.codec, "vp09.00.10.08");
  assert.equal(config.width, 1280);
  assert.equal(config.height, 720);
  assert.equal(config.framerate, 60);
});

test("getVideoEncoderConfig(h264) は annexb フォーマットの AVC オプションを含む", () => {
  const config = getVideoEncoderConfig("h264", 640, 480, 1_000_000, 30);
  assert.equal(config.codec, "avc1.42001f");
  assert.deepEqual(config.avc, { format: "annexb" });
});

test("getVideoEncoderConfig(h265) は codec=hvc1.1.6.L93.B0 を返す", () => {
  const config = getVideoEncoderConfig("h265", 640, 480, 1_000_000, 30);
  assert.equal(config.codec, "hvc1.1.6.L93.B0");
  // hevc オプションは TypeScript の VideoEncoderConfig に含まれないため型越しには検証しない
  const extended = config as unknown as { hevc?: { format: string } };
  assert.deepEqual(extended.hevc, { format: "annexb" });
});

test("getVideoEncoderConfig(av1) は codec=av01.0.04M.08 を返す", () => {
  const config = getVideoEncoderConfig("av1", 640, 480, 1_000_000, 30);
  assert.equal(config.codec, "av01.0.04M.08");
});

// =============================================================================
// Video Decoder Config
// =============================================================================

test("getVideoDecoderConfig は description を渡した場合そのまま含める", () => {
  const description = new Uint8Array([0x01, 0x02, 0x03]);
  const config = getVideoDecoderConfig("h264", 640, 480, description);
  assert.equal(config.codec, "avc1.42001f");
  assert.equal(config.codedWidth, 640);
  assert.equal(config.codedHeight, 480);
  assert.deepEqual(config.description, description);
});

test("getVideoDecoderConfig は description なしでも動作する", () => {
  const config = getVideoDecoderConfig("vp8", 640, 480);
  assert.equal(config.codec, "vp8");
  assert.isUndefined(config.description);
});

test("DEFAULT_VIDEO_FRAMERATE が 30 であること", () => {
  assert.equal(DEFAULT_VIDEO_FRAMERATE, 30);
});
