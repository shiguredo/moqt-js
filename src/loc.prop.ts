/**
 * LOC (Low Overhead Container) Property-Based Tests
 * draft-ietf-moq-loc-04 に基づくプロパティテスト
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  encodeTimestamp,
  decodeTimestamp,
  encodeTimescale,
  decodeTimescale,
  encodeVideoFrameMarking,
  decodeVideoFrameMarking,
  encodeAudioLevel,
  decodeAudioLevel,
  encodeVideoConfig,
  decodeVideoConfig,
  encodeAudioConfig,
  decodeAudioConfig,
  encodeVideoProperties,
  decodeVideoProperties,
  encodeAudioProperties,
  decodeAudioProperties,
  type VideoFrameMarking,
  type VideoProperties,
  type AudioProperties,
} from "./loc";

// varint の最大値
const MAX_VARINT = 4611686018427387903n;

// Timestamp 用の Arbitrary (Unix epoch からのマイクロ秒、または Timescale ありの場合はメディア時間)
const timestampArb = fc.bigInt({ min: 0n, max: MAX_VARINT });

// Timescale 用の Arbitrary (1 秒あたりの Timestamp 単位数)
const timescaleArb = fc.bigInt({ min: 1n, max: MAX_VARINT });

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

// VideoConfig 用の Arbitrary (任意のバイト列)
const videoConfigArb = fc.uint8Array({ minLength: 0, maxLength: 256 });

// AudioConfig 用の Arbitrary (任意のバイト列)
const audioConfigArb = fc.uint8Array({ minLength: 0, maxLength: 256 });

// VideoProperties 用の Arbitrary
const videoPropertiesArb: fc.Arbitrary<VideoProperties> = fc.record(
  {
    timestamp: fc.option(timestampArb, { nil: undefined }),
    timescale: fc.option(timescaleArb, { nil: undefined }),
    frameMarking: fc.option(videoFrameMarkingArb, { nil: undefined }),
    config: fc.option(videoConfigArb, { nil: undefined }),
  },
  { requiredKeys: [] },
);

// AudioProperties 用の Arbitrary
const audioPropertiesArb: fc.Arbitrary<AudioProperties> = fc.record(
  {
    timestamp: fc.option(timestampArb, { nil: undefined }),
    timescale: fc.option(timescaleArb, { nil: undefined }),
    audioLevel: fc.option(audioLevelArb, { nil: undefined }),
    audioConfig: fc.option(audioConfigArb, { nil: undefined }),
  },
  { requiredKeys: [] },
);

test("Timestamp の encode/decode ラウンドトリップが成立する", () => {
  fc.assert(
    fc.property(timestampArb, (timestamp) => {
      const encoded = encodeTimestamp(timestamp);
      const decoded = decodeTimestamp(encoded);
      assert.equal(decoded, timestamp);
    }),
  );
});

test("Timescale の encode/decode ラウンドトリップが成立する", () => {
  fc.assert(
    fc.property(timescaleArb, (timescale) => {
      const encoded = encodeTimescale(timescale);
      const decoded = decodeTimescale(encoded);
      assert.equal(decoded, timescale);
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

test("VideoConfig の encode/decode ラウンドトリップが成立する", () => {
  fc.assert(
    fc.property(videoConfigArb, (config) => {
      const encoded = encodeVideoConfig(config);
      const decoded = decodeVideoConfig(encoded);
      assert.deepEqual(decoded, config);
    }),
  );
});

test("AudioConfig の encode/decode ラウンドトリップが成立する", () => {
  fc.assert(
    fc.property(audioConfigArb, (config) => {
      const encoded = encodeAudioConfig(config);
      const decoded = decodeAudioConfig(encoded);
      assert.deepEqual(decoded, config);
    }),
  );
});

test("VideoProperties の encode/decode ラウンドトリップが成立する", () => {
  fc.assert(
    fc.property(videoPropertiesArb, (properties) => {
      const encoded = encodeVideoProperties(properties);
      const decoded = decodeVideoProperties(encoded);

      if (properties.timestamp !== undefined) {
        assert.equal(decoded.timestamp, properties.timestamp);
      } else {
        assert.isUndefined(decoded.timestamp);
      }

      if (properties.timescale !== undefined) {
        assert.equal(decoded.timescale, properties.timescale);
      } else {
        assert.isUndefined(decoded.timescale);
      }

      if (properties.frameMarking !== undefined) {
        assert.deepEqual(decoded.frameMarking, properties.frameMarking);
      } else {
        assert.isUndefined(decoded.frameMarking);
      }

      if (properties.config !== undefined) {
        assert.deepEqual(decoded.config, properties.config);
      } else {
        assert.isUndefined(decoded.config);
      }
    }),
  );
});

// draft-ietf-moq-loc-04 で AUDIO_LEVEL (0x0C) と TIMESTAMP (0x10) の ID 衝突が解消されたため、
// AudioProperties のラウンドトリップテストが正常に動作する
test("AudioProperties の encode/decode ラウンドトリップが成立する", () => {
  fc.assert(
    fc.property(audioPropertiesArb, (properties) => {
      const encoded = encodeAudioProperties(properties);
      const decoded = decodeAudioProperties(encoded);

      if (properties.timestamp !== undefined) {
        assert.equal(decoded.timestamp, properties.timestamp);
      } else {
        assert.isUndefined(decoded.timestamp);
      }

      if (properties.timescale !== undefined) {
        assert.equal(decoded.timescale, properties.timescale);
      } else {
        assert.isUndefined(decoded.timescale);
      }

      if (properties.audioLevel !== undefined) {
        assert.deepEqual(decoded.audioLevel, properties.audioLevel);
      } else {
        assert.isUndefined(decoded.audioLevel);
      }

      if (properties.audioConfig !== undefined) {
        assert.deepEqual(decoded.audioConfig, properties.audioConfig);
      } else {
        assert.isUndefined(decoded.audioConfig);
      }
    }),
  );
});

test("空の VideoProperties は空のバイト列にエンコードされる", () => {
  const properties: VideoProperties = {};
  const encoded = encodeVideoProperties(properties);
  assert.equal(encoded.length, 0);
  const decoded = decodeVideoProperties(encoded);
  assert.isUndefined(decoded.timestamp);
  assert.isUndefined(decoded.timescale);
  assert.isUndefined(decoded.frameMarking);
  assert.isUndefined(decoded.config);
});

test("空の AudioProperties は空のバイト列にエンコードされる", () => {
  const properties: AudioProperties = {};
  const encoded = encodeAudioProperties(properties);
  assert.equal(encoded.length, 0);
  const decoded = decodeAudioProperties(encoded);
  assert.isUndefined(decoded.timestamp);
  assert.isUndefined(decoded.timescale);
  assert.isUndefined(decoded.audioLevel);
  assert.isUndefined(decoded.audioConfig);
});

// =============================================================================
// 複数プロパティのテスト
// =============================================================================

test("VideoProperties: 全てのプロパティを含む場合のラウンドトリップ", () => {
  fc.assert(
    fc.property(
      timestampArb,
      timescaleArb,
      videoFrameMarkingArb,
      videoConfigArb,
      (ts, timescale, marking, config) => {
        const properties: VideoProperties = {
          timestamp: ts,
          timescale,
          frameMarking: marking,
          config,
        };

        const encoded = encodeVideoProperties(properties);
        const decoded = decodeVideoProperties(encoded);

        assert.strictEqual(decoded.timestamp, ts);
        assert.strictEqual(decoded.timescale, timescale);
        assert.deepEqual(decoded.frameMarking, marking);
        assert.deepEqual(decoded.config, config);
      },
    ),
  );
});

test("AudioProperties: 全てのプロパティを含む場合のラウンドトリップ", () => {
  fc.assert(
    fc.property(
      timestampArb,
      timescaleArb,
      audioLevelArb,
      audioConfigArb,
      (ts, timescale, level, config) => {
        const properties: AudioProperties = {
          timestamp: ts,
          timescale,
          audioLevel: level,
          audioConfig: config,
        };

        const encoded = encodeAudioProperties(properties);
        const decoded = decodeAudioProperties(encoded);

        assert.strictEqual(decoded.timestamp, ts);
        assert.strictEqual(decoded.timescale, timescale);
        assert.deepEqual(decoded.audioLevel, level);
        assert.deepEqual(decoded.audioConfig, config);
      },
    ),
  );
});

// =============================================================================
// Property ID 形式のテスト
// =============================================================================

test("Timestamp: ID=0x10 (偶数) は varint 形式でエンコードされる", () => {
  const timestamp = 1234567890123456n;
  const encoded = encodeTimestamp(timestamp);
  const decoded = decodeTimestamp(encoded);

  // ID=0x10 は 1 バイトで表現できる
  assert.strictEqual(encoded[0], 0x10);
  assert.strictEqual(decoded, timestamp);
});

test("Timescale: ID=0x08 (偶数) は varint 形式でエンコードされる", () => {
  const timescale = 90000n;
  const encoded = encodeTimescale(timescale);
  const decoded = decodeTimescale(encoded);

  // ID=0x08 は 1 バイトで表現できる
  assert.strictEqual(encoded[0], 0x08);
  assert.strictEqual(decoded, timescale);
});

test("VideoConfig: ID=0x0D (奇数) は length + bytes 形式でエンコードされる", () => {
  const config = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
  const encoded = encodeVideoConfig(config);
  const decoded = decodeVideoConfig(encoded);

  // ID=0x0D は 1 バイトで表現できる
  assert.strictEqual(encoded[0], 0x0d);
  // 次のバイトは length
  assert.strictEqual(encoded[1], 5);
  assert.deepEqual(decoded, config);
});

test("AudioConfig: ID=0x0F (奇数) は length + bytes 形式でエンコードされる", () => {
  const config = new Uint8Array([0x01, 0x02, 0x03]);
  const encoded = encodeAudioConfig(config);
  const decoded = decodeAudioConfig(encoded);

  // ID=0x0F は 1 バイトで表現できる
  assert.strictEqual(encoded[0], 0x0f);
  // 次のバイトは length
  assert.strictEqual(encoded[1], 3);
  assert.deepEqual(decoded, config);
});

test("VideoFrameMarking: ID=0x09 (奇数) は length + bytes 形式でエンコードされる", () => {
  const marking: VideoFrameMarking = {
    isIndependent: true,
    isDiscardable: false,
    isBaseLayerSync: true,
    temporalLayerId: 0,
    spatialLayerId: 0,
  };
  const encoded = encodeVideoFrameMarking(marking);
  const decoded = decodeVideoFrameMarking(encoded);

  // ID=0x09 は 1 バイトで表現できる
  assert.strictEqual(encoded[0], 0x09);
  // 次のバイトは length (RFC9626 の 2 バイト)
  assert.strictEqual(encoded[1], 2);
  assert.deepEqual(decoded, marking);
});

test("AudioLevel: ID=0x0C (偶数) は varint 形式でエンコードされる", () => {
  const encoded = encodeAudioLevel(50, true);
  const decoded = decodeAudioLevel(encoded);

  // ID=0x0C は 1 バイトで表現できる
  assert.strictEqual(encoded[0], 0x0c);
  assert.strictEqual(decoded.level, 50);
  assert.strictEqual(decoded.voiceActivity, true);
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
