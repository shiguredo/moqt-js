/**
 * LOC (Low Overhead Container) Property-Based Tests
 * draft-ietf-moq-loc-01 に基づくプロパティテスト
 */

import { test, assert } from "vitest";
import * as fc from "fast-check";
import {
  encodeCaptureTimestamp,
  decodeCaptureTimestamp,
  encodeVideoFrameMarking,
  decodeVideoFrameMarking,
  encodeAudioLevel,
  decodeAudioLevel,
  encodeConfig,
  decodeConfig,
  encodeVideoHeaderExtensions,
  decodeVideoHeaderExtensions,
  encodeAudioHeaderExtensions,
  decodeAudioHeaderExtensions,
  type VideoFrameMarking,
  type VideoHeaderExtensions,
  type AudioHeaderExtensions,
} from "./loc";

// varint の最大値
const MAX_VARINT = 4611686018427387903n;

// CaptureTimestamp 用の Arbitrary (Unix epoch からのマイクロ秒)
const captureTimestampArb = fc.bigInt({ min: 0n, max: MAX_VARINT });

// VideoFrameMarking 用の Arbitrary
const videoFrameMarkingArb: fc.Arbitrary<VideoFrameMarking> = fc.record({
  isIndependent: fc.boolean(),
  isDiscardable: fc.boolean(),
  isBaseLayerSync: fc.boolean(),
  // 3 bits (0-7)
  temporalLayerId: fc.integer({ min: 0, max: 7 }),
  // 2 bits (0-3)
  spatialLayerId: fc.integer({ min: 0, max: 3 }),
});

// AudioLevel 用の Arbitrary
const audioLevelArb = fc.record({
  // 7 bits (0-127)
  level: fc.integer({ min: 0, max: 127 }),
  voiceActivity: fc.boolean(),
});

// Config 用の Arbitrary (任意のバイト列)
const configArb = fc.uint8Array({ minLength: 0, maxLength: 256 });

// VideoHeaderExtensions 用の Arbitrary
const videoHeaderExtensionsArb: fc.Arbitrary<VideoHeaderExtensions> = fc.record(
  {
    captureTimestamp: fc.option(captureTimestampArb, { nil: undefined }),
    frameMarking: fc.option(videoFrameMarkingArb, { nil: undefined }),
    config: fc.option(configArb, { nil: undefined }),
  },
  { requiredKeys: [] },
);

// AudioHeaderExtensions 用の Arbitrary
const audioHeaderExtensionsArb: fc.Arbitrary<AudioHeaderExtensions> = fc.record(
  {
    captureTimestamp: fc.option(captureTimestampArb, { nil: undefined }),
    audioLevel: fc.option(audioLevelArb, { nil: undefined }),
  },
  { requiredKeys: [] },
);

test("CaptureTimestamp の encode/decode ラウンドトリップが成立する", () => {
  fc.assert(
    fc.property(captureTimestampArb, (timestamp) => {
      const encoded = encodeCaptureTimestamp(timestamp);
      const decoded = decodeCaptureTimestamp(encoded);
      assert.equal(decoded, timestamp);
    }),
  );
});

test("VideoFrameMarking の encode/decode ラウンドトリップが成立する", () => {
  fc.assert(
    fc.property(videoFrameMarkingArb, (marking) => {
      const encoded = encodeVideoFrameMarking(marking);
      const decoded = decodeVideoFrameMarking(encoded);
      assert.deepEqual(decoded, marking);
    }),
  );
});

test("AudioLevel の encode/decode ラウンドトリップが成立する", () => {
  fc.assert(
    fc.property(audioLevelArb, ({ level, voiceActivity }) => {
      const encoded = encodeAudioLevel(level, voiceActivity);
      const decoded = decodeAudioLevel(encoded);
      assert.equal(decoded.level, level);
      assert.equal(decoded.voiceActivity, voiceActivity);
    }),
  );
});

test("Config の encode/decode ラウンドトリップが成立する", () => {
  fc.assert(
    fc.property(configArb, (config) => {
      const encoded = encodeConfig(config);
      const decoded = decodeConfig(encoded);
      assert.deepEqual(decoded, config);
    }),
  );
});

test("VideoHeaderExtensions の encode/decode ラウンドトリップが成立する", () => {
  fc.assert(
    fc.property(videoHeaderExtensionsArb, (extensions) => {
      const encoded = encodeVideoHeaderExtensions(extensions);
      const decoded = decodeVideoHeaderExtensions(encoded);

      if (extensions.captureTimestamp !== undefined) {
        assert.equal(decoded.captureTimestamp, extensions.captureTimestamp);
      } else {
        assert.isUndefined(decoded.captureTimestamp);
      }

      if (extensions.frameMarking !== undefined) {
        assert.deepEqual(decoded.frameMarking, extensions.frameMarking);
      } else {
        assert.isUndefined(decoded.frameMarking);
      }

      if (extensions.config !== undefined) {
        assert.deepEqual(decoded.config, extensions.config);
      } else {
        assert.isUndefined(decoded.config);
      }
    }),
  );
});

test("AudioHeaderExtensions の encode/decode ラウンドトリップが成立する", () => {
  fc.assert(
    fc.property(audioHeaderExtensionsArb, (extensions) => {
      const encoded = encodeAudioHeaderExtensions(extensions);
      const decoded = decodeAudioHeaderExtensions(encoded);

      if (extensions.captureTimestamp !== undefined) {
        assert.equal(decoded.captureTimestamp, extensions.captureTimestamp);
      } else {
        assert.isUndefined(decoded.captureTimestamp);
      }

      if (extensions.audioLevel !== undefined) {
        assert.deepEqual(decoded.audioLevel, extensions.audioLevel);
      } else {
        assert.isUndefined(decoded.audioLevel);
      }
    }),
  );
});

test("空の VideoHeaderExtensions は空のバイト列にエンコードされる", () => {
  const extensions: VideoHeaderExtensions = {};
  const encoded = encodeVideoHeaderExtensions(extensions);
  assert.equal(encoded.length, 0);
  const decoded = decodeVideoHeaderExtensions(encoded);
  assert.isUndefined(decoded.captureTimestamp);
  assert.isUndefined(decoded.frameMarking);
  assert.isUndefined(decoded.config);
});

test("空の AudioHeaderExtensions は空のバイト列にエンコードされる", () => {
  const extensions: AudioHeaderExtensions = {};
  const encoded = encodeAudioHeaderExtensions(extensions);
  assert.equal(encoded.length, 0);
  const decoded = decodeAudioHeaderExtensions(encoded);
  assert.isUndefined(decoded.captureTimestamp);
  assert.isUndefined(decoded.audioLevel);
});

// =============================================================================
// 複数 extension のテスト
// =============================================================================

test("VideoHeaderExtensions: 全ての extension を含む場合のラウンドトリップ", () => {
  fc.assert(
    fc.property(captureTimestampArb, videoFrameMarkingArb, configArb, (ts, marking, config) => {
      const extensions: VideoHeaderExtensions = {
        captureTimestamp: ts,
        frameMarking: marking,
        config,
      };

      const encoded = encodeVideoHeaderExtensions(extensions);
      const decoded = decodeVideoHeaderExtensions(encoded);

      assert.strictEqual(decoded.captureTimestamp, ts);
      assert.deepEqual(decoded.frameMarking, marking);
      assert.deepEqual(decoded.config, config);
    }),
  );
});

test("AudioHeaderExtensions: 全ての extension を含む場合のラウンドトリップ", () => {
  fc.assert(
    fc.property(captureTimestampArb, audioLevelArb, (ts, audioLevel) => {
      const extensions: AudioHeaderExtensions = {
        captureTimestamp: ts,
        audioLevel,
      };

      const encoded = encodeAudioHeaderExtensions(extensions);
      const decoded = decodeAudioHeaderExtensions(encoded);

      assert.strictEqual(decoded.captureTimestamp, ts);
      assert.deepEqual(decoded.audioLevel, audioLevel);
    }),
  );
});

// =============================================================================
// Header Extension ID 形式のテスト
// =============================================================================

test("CaptureTimestamp: ID=2 (偶数) は varint 形式でエンコードされる", () => {
  const timestamp = 1234567890123456n;
  const encoded = encodeCaptureTimestamp(timestamp);
  const decoded = decodeCaptureTimestamp(encoded);

  // ID=2 は 1 バイトで表現できる
  assert.strictEqual(encoded[0], 2);
  assert.strictEqual(decoded, timestamp);
});

test("Config: ID=13 (奇数) は length + bytes 形式でエンコードされる", () => {
  const config = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
  const encoded = encodeConfig(config);
  const decoded = decodeConfig(encoded);

  // ID=13 は 1 バイトで表現できる
  assert.strictEqual(encoded[0], 13);
  // 次のバイトは length
  assert.strictEqual(encoded[1], 5);
  assert.deepEqual(decoded, config);
});

// =============================================================================
// 仕様書例に基づくテスト
// =============================================================================

test("VideoFrameMarking: キーフレーム (I=true, D=false, B=true) のエンコード", () => {
  // キーフレームは独立 (I=true)、破棄不可 (D=false)、ベースレイヤー同期 (B=true)
  const keyFrameMarking: VideoFrameMarking = {
    isIndependent: true,
    isDiscardable: false,
    isBaseLayerSync: true,
    temporalLayerId: 0,
    spatialLayerId: 0,
  };

  const encoded = encodeVideoFrameMarking(keyFrameMarking);
  const decoded = decodeVideoFrameMarking(encoded);

  assert.strictEqual(decoded.isIndependent, true);
  assert.strictEqual(decoded.isDiscardable, false);
  assert.strictEqual(decoded.isBaseLayerSync, true);
  assert.strictEqual(decoded.temporalLayerId, 0);
  assert.strictEqual(decoded.spatialLayerId, 0);
});

test("VideoFrameMarking: 時間的上位レイヤーフレーム (TID=2) のエンコード", () => {
  const temporalLayerFrame: VideoFrameMarking = {
    isIndependent: false,
    isDiscardable: true,
    isBaseLayerSync: false,
    temporalLayerId: 2,
    spatialLayerId: 0,
  };

  const encoded = encodeVideoFrameMarking(temporalLayerFrame);
  const decoded = decodeVideoFrameMarking(encoded);

  assert.strictEqual(decoded.isIndependent, false);
  assert.strictEqual(decoded.isDiscardable, true);
  assert.strictEqual(decoded.temporalLayerId, 2);
});

test("AudioLevel: 無音 (level=127, V=false) のエンコード", () => {
  // RFC6464: level=127 は無音を示す
  const encoded = encodeAudioLevel(127, false);
  const decoded = decodeAudioLevel(encoded);

  assert.strictEqual(decoded.level, 127);
  assert.strictEqual(decoded.voiceActivity, false);
});

test("AudioLevel: 音声活動あり (level=50, V=true) のエンコード", () => {
  const encoded = encodeAudioLevel(50, true);
  const decoded = decodeAudioLevel(encoded);

  assert.strictEqual(decoded.level, 50);
  assert.strictEqual(decoded.voiceActivity, true);
});
