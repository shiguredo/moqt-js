/**
 * LOC (Low Overhead Container) Property-Based Tests
 * draft-ietf-moq-loc-02 に基づくプロパティテスト
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
  encodeAudioProperties,
  decodeAudioProperties,
  encodeConfig,
  decodeConfig,
  encodeVideoProperties,
  decodeVideoProperties,
  type AudioProperties,
  type VideoFrameMarking,
  type VideoProperties,
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

// Config 用の Arbitrary (任意のバイト列)
const configArb = fc.uint8Array({ minLength: 0, maxLength: 256 });

// VideoProperties 用の Arbitrary
const videoPropertiesArb: fc.Arbitrary<VideoProperties> = fc.record(
  {
    timestamp: fc.option(timestampArb, { nil: undefined }),
    timescale: fc.option(timescaleArb, { nil: undefined }),
    frameMarking: fc.option(videoFrameMarkingArb, { nil: undefined }),
    config: fc.option(configArb, { nil: undefined }),
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

test("Config の encode/decode ラウンドトリップが成立する", () => {
  fc.assert(
    fc.property(configArb, (config) => {
      const encoded = encodeConfig(config);
      const decoded = decodeConfig(encoded);
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

// AudioProperties のラウンドトリップは audioLevel を含まない場合のみ成立する
// 理由: AUDIO_LEVEL (ID: 6 = 0x06) と TIMESTAMP (ID: 0x06) の ID が衝突しているため、
// デコードループで ID 0x06 は常に TIMESTAMP として処理される。
// draft-ietf-moq-loc-02 の仕様上のバグであり、IANA による ID 再割り当てが必要。
// issues/0036-bug-loc-audio-level-timestamp-id-conflict.md

// AudioProperties (audioLevel を除く) 用の Arbitrary
const audioPropertiesWithoutLevelArb: fc.Arbitrary<AudioProperties> = fc.record(
  {
    timestamp: fc.option(timestampArb, { nil: undefined }),
    timescale: fc.option(timescaleArb, { nil: undefined }),
  },
  { requiredKeys: [] },
);

test("空の AudioProperties は空のバイト列にエンコードされる", () => {
  const encoded = encodeAudioProperties({});
  assert.equal(encoded.length, 0);
  const decoded = decodeAudioProperties(encoded);
  assert.isUndefined(decoded.timestamp);
  assert.isUndefined(decoded.timescale);
  assert.isUndefined(decoded.audioLevel);
});

test("audioLevel を含まない AudioProperties の encode/decode ラウンドトリップが成立する", () => {
  fc.assert(
    fc.property(audioPropertiesWithoutLevelArb, (properties) => {
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

      assert.isUndefined(decoded.audioLevel);
    }),
  );
});

// draft-ietf-moq-loc-02 の仕様バグの挙動を固定化する回帰テスト
// AUDIO_LEVEL (ID=6) と TIMESTAMP (ID=0x06) は同一 ID のため、
// decodeAudioProperties は audioLevel のバイト列を TIMESTAMP として読む
test("audioLevel 単独の AudioProperties は decode で TIMESTAMP として誤認される (仕様バグ #0036)", () => {
  const encoded = encodeAudioProperties({
    audioLevel: { level: 50, voiceActivity: true },
  });
  const decoded = decodeAudioProperties(encoded);
  // audioLevel としてではなく timestamp として読まれる
  assert.isUndefined(decoded.audioLevel);
  assert.isDefined(decoded.timestamp);
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

// =============================================================================
// 複数プロパティのテスト
// =============================================================================

test("VideoProperties: 全てのプロパティを含む場合のラウンドトリップ", () => {
  fc.assert(
    fc.property(
      timestampArb,
      timescaleArb,
      videoFrameMarkingArb,
      configArb,
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

// =============================================================================
// Property ID 形式のテスト
// =============================================================================

test("Timestamp: ID=0x06 (偶数) は varint 形式でエンコードされる", () => {
  const timestamp = 1234567890123456n;
  const encoded = encodeTimestamp(timestamp);
  const decoded = decodeTimestamp(encoded);

  // ID=0x06 は 1 バイトで表現できる
  assert.strictEqual(encoded[0], 0x06);
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
