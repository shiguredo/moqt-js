/**
 * LOC (Low Overhead Container) Property-Based Tests
 * draft-ietf-moq-loc-04 に基づくプロパティテスト
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { ProtocolViolationError, IncompleteDataError } from "./error";
import { encodeVarint, MAX_VARINT } from "./varint";
import { assertKeyValueFormattingError } from "./testSupport/helpers";
import { assertKnownPropertyValueInObjectProperties, encodeProperties } from "./properties";
import {
  LOCPropertyId,
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
  encodeLocObjectPayload,
  decodeLocObjectPayload,
  type VideoFrameMarking,
  type VideoProperties,
  type AudioProperties,
} from "./loc";

// Timestamp 用の Arbitrary (Unix epoch からのマイクロ秒、または Timescale ありの場合はメディア時間)
const timestampArb = fc.bigInt({ min: 0n, max: MAX_VARINT });

// Timescale 用の Arbitrary (1 秒あたりの Timestamp 単位数)
const timescaleArb = fc.bigInt({ min: 1n, max: MAX_VARINT });

// VideoFrameMarking 用の Arbitrary。
// TID=0 のとき isBaseLayerSync=true は encodeVideoFrameMarkingValue が
// RFC 9626 §3.1「When the TID is 0 or if no scalability is used, this MUST be 0」
// に従い B=0 に抑圧するため round-trip 恒等が崩れる。TID=0 では isBaseLayerSync=false に
// 制約して round-trip 恒等を保つ。
const videoFrameMarkingArb: fc.Arbitrary<VideoFrameMarking> = fc
  .integer({ min: 0, max: 7 })
  .chain((temporalLayerId) =>
    fc.record({
      isIndependent: fc.boolean(),
      isDiscardable: fc.boolean(),
      isBaseLayerSync: temporalLayerId === 0 ? fc.constant(false) : fc.boolean(),
      temporalLayerId: fc.constant(temporalLayerId),
      // RFC 9626 §3.1: LID は 8 bits (0-255)
      spatialLayerId: fc.integer({ min: 0, max: 255 }),
    }),
  );

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

// AudioProperties 用の Arbitrary
const audioPropertiesArb: fc.Arbitrary<AudioProperties> = fc.record(
  {
    timestamp: fc.option(timestampArb, { nil: undefined }),
    timescale: fc.option(timescaleArb, { nil: undefined }),
    audioLevel: fc.option(audioLevelArb, { nil: undefined }),
    config: fc.option(configArb, { nil: undefined }),
  },
  { requiredKeys: [] },
);

/**
 * VIDEO_FRAME_MARKING のワイヤを手組みする (ID + length + value bytes)
 */
function buildVideoFrameMarkingWire(length: number, value: Uint8Array): Uint8Array {
  const idBytes = encodeVarint(LOCPropertyId.VIDEO_FRAME_MARKING);
  const lengthBytes = encodeVarint(BigInt(length));
  const result = new Uint8Array(idBytes.length + lengthBytes.length + value.length);
  result.set(idBytes, 0);
  result.set(lengthBytes, idBytes.length);
  result.set(value, idBytes.length + lengthBytes.length);
  return result;
}

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
    fc.property(configArb, (config) => {
      const encoded = encodeVideoConfig(config);
      const decoded = decodeVideoConfig(encoded);
      assert.deepEqual(decoded, config);
    }),
  );
});

test("AudioConfig の encode/decode ラウンドトリップが成立する", () => {
  fc.assert(
    fc.property(configArb, (config) => {
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

      if (properties.config !== undefined) {
        assert.deepEqual(decoded.config, properties.config);
      } else {
        assert.isUndefined(decoded.config);
      }
    }),
  );
});

test("AudioProperties: timestamp と audioLevel を同時に載せたラウンドトリップが成立する", () => {
  // draft-04 で TIMESTAMP=0x10 / AUDIO_LEVEL=0x0C に分離されたため、同時載せが可能
  fc.assert(
    fc.property(timestampArb, audioLevelArb, (timestamp, audioLevel) => {
      const properties: AudioProperties = { timestamp, audioLevel };
      const encoded = encodeAudioProperties(properties);
      const decoded = decodeAudioProperties(encoded);
      assert.equal(decoded.timestamp, timestamp);
      assert.deepEqual(decoded.audioLevel, audioLevel);
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
  assert.isUndefined(decoded.config);
});

// =============================================================================
// 全てのプロパティを含む場合のラウンドトリップ (多段 delta)
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

test("AudioProperties: 全てのプロパティを含む場合のラウンドトリップ", () => {
  fc.assert(
    fc.property(
      timestampArb,
      timescaleArb,
      audioLevelArb,
      configArb,
      (ts, timescale, audioLevel, config) => {
        const properties: AudioProperties = {
          timestamp: ts,
          timescale,
          audioLevel,
          config,
        };

        const encoded = encodeAudioProperties(properties);
        const decoded = decodeAudioProperties(encoded);

        assert.strictEqual(decoded.timestamp, ts);
        assert.strictEqual(decoded.timescale, timescale);
        assert.deepEqual(decoded.audioLevel, audioLevel);
        assert.deepEqual(decoded.config, config);
      },
    ),
  );
});

// =============================================================================
// Property ID 形式のテスト (draft-ietf-moq-loc-04 §6.1 Table 1)
// =============================================================================

test("Timestamp: ID=0x10 (偶数) は varint 形式でエンコードされる", () => {
  const timestamp = 1234567890123456n;
  const encoded = encodeTimestamp(timestamp);
  const decoded = decodeTimestamp(encoded);

  assert.strictEqual(encoded[0], 0x10);
  assert.strictEqual(decoded, timestamp);
});

test("Timescale: ID=0x08 (偶数) は varint 形式でエンコードされる", () => {
  const timescale = 90000n;
  const encoded = encodeTimescale(timescale);
  const decoded = decodeTimescale(encoded);

  assert.strictEqual(encoded[0], 0x08);
  assert.strictEqual(decoded, timescale);
});

test("AudioLevel: ID=0x0C (偶数) は varint 形式でエンコードされる", () => {
  const encoded = encodeAudioLevel(50, true);
  assert.strictEqual(encoded[0], 0x0c);
});

test("VideoConfig: ID=0x0D (奇数) は length + bytes 形式でエンコードされる", () => {
  const config = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
  const encoded = encodeVideoConfig(config);
  const decoded = decodeVideoConfig(encoded);

  assert.strictEqual(encoded[0], 0x0d);
  assert.strictEqual(encoded[1], 5);
  assert.deepEqual(decoded, config);
});

test("AudioConfig: ID=0x0F (奇数) は length + bytes 形式でエンコードされる", () => {
  const config = new Uint8Array([0xaa, 0xbb]);
  const encoded = encodeAudioConfig(config);
  const decoded = decodeAudioConfig(encoded);

  assert.strictEqual(encoded[0], 0x0f);
  assert.strictEqual(encoded[1], 2);
  assert.deepEqual(decoded, config);
});

test("VideoConfig / AudioConfig: 空 description のラウンドトリップが成立する", () => {
  const empty = new Uint8Array(0);
  assert.deepEqual(decodeVideoConfig(encodeVideoConfig(empty)), empty);
  assert.deepEqual(decodeAudioConfig(encodeAudioConfig(empty)), empty);
});

// =============================================================================
// VIDEO_FRAME_MARKING Length 1–4 の decode
// =============================================================================

test("VideoFrameMarking: Length=1 でも byte1 の TID / B はワイヤの値を読む (L=0 かつ TID≠0 を送る実装の受理)", () => {
  // RFC 9626 §3.1 の L=0 形は byte1 に B と TID を載せられる。§3.2 の受信側は下位 4 bits を
  // 無視するため区別できないが、decode 側はワイヤの値を忠実に読み出す
  const wire = buildVideoFrameMarkingWire(1, new Uint8Array([0xc9]));
  const decoded = decodeVideoFrameMarking(wire);
  assert.strictEqual(decoded.temporalLayerId, 1);
  assert.strictEqual(decoded.isBaseLayerSync, true);
  assert.strictEqual(decoded.spatialLayerId, 0);
});

test("VideoFrameMarking: Length=1 (§3.1 L=0 の 1 オクテット形 / §3.2 short extension 相当、LID 暗黙 0) は spatialLayerId=0 として decodeVideoFrameMarking で解釈される", () => {
  // I=1, D=0, B=1, TID=0 → byte1 = 0x80|0x40|0x20|0x08 = 0xE8。
  // Length=1 (LID 省略) は LID 暗黙 0 扱い。B=1 の受理は「TID=0 で B=1 のワイヤは decode 側で
  // isBaseLayerSync=true として忠実に読み出す」の別テストで検証している。
  const wire = buildVideoFrameMarkingWire(1, new Uint8Array([0xe8]));
  const decoded = decodeVideoFrameMarking(wire);
  assert.strictEqual(decoded.isIndependent, true);
  assert.strictEqual(decoded.isDiscardable, false);
  assert.strictEqual(decoded.isBaseLayerSync, true);
  assert.strictEqual(decoded.temporalLayerId, 0);
  assert.strictEqual(decoded.spatialLayerId, 0);
});

test("VideoFrameMarking: Length=1 (§3.1 L=0 の 1 オクテット形 / §3.2 short extension 相当、LID 暗黙 0) は spatialLayerId=0 として decodeVideoProperties で解釈される", () => {
  const wire = buildVideoFrameMarkingWire(1, new Uint8Array([0xe8]));
  const decoded = decodeVideoProperties(wire);
  assert.deepEqual(decoded.frameMarking, {
    isIndependent: true,
    isDiscardable: false,
    isBaseLayerSync: true,
    temporalLayerId: 0,
    spatialLayerId: 0,
  });
});

test("VideoFrameMarking: Length=3 (Long Extension + TL0PICIDX) は先頭 2 バイトを解釈し宣言 Length を消費する", () => {
  // Length=3: byte1 / byte2 (LID) がフィールド、3 バイト目は TL0PICIDX (消費のみで解釈しない)
  // RFC 9626 §3.1: LID は 8 bit のため byte2=0x20 は LID 32 として復元する
  const value = new Uint8Array([0xe8, 0x20, 0xff]);
  const wire = buildVideoFrameMarkingWire(3, value);
  const decoded = decodeVideoFrameMarking(wire);
  assert.strictEqual(decoded.isIndependent, true);
  assert.strictEqual(decoded.isBaseLayerSync, true);
  assert.strictEqual(decoded.spatialLayerId, 0x20);

  // 余剰バイトを消費したうえで後続 TIMESTAMP が読めること。
  // Object Properties は delta encoding (Figure 2) のため、後続 TIMESTAMP (0x10) は
  // 前 Property VIDEO_FRAME_MARKING (0x09) との差分 Delta Type 0x07 で書く。
  const trailing = encodeVarint(42n);
  const combined = new Uint8Array(wire.length + 1 + trailing.length);
  combined.set(wire, 0);
  combined.set([0x07], wire.length);
  combined.set(trailing, wire.length + 1);
  const props = decodeVideoProperties(combined);
  assert.deepEqual(props.frameMarking, decoded);
  assert.strictEqual(props.timestamp, 42n);
});

test("VideoFrameMarking: Length=4 (loc-04 §2.3.2.2 の受理範囲、余剰付き) は decodeVideoProperties でも宣言 Length を消費する", () => {
  // RFC 9626 §3.1: LID は 8 bit のため byte2=0x10 は LID 16
  const value = new Uint8Array([0xe8, 0x10, 0xaa, 0xbb]);
  const wire = buildVideoFrameMarkingWire(4, value);
  // 後続 TIMESTAMP (0x10) は Delta Type 0x07 (0x10 - 0x09) で書く
  const trailing = encodeVarint(7n);
  const combined = new Uint8Array(wire.length + 1 + trailing.length);
  combined.set(wire, 0);
  combined.set([0x07], wire.length);
  combined.set(trailing, wire.length + 1);

  const viaMarking = decodeVideoFrameMarking(wire);
  const viaProps = decodeVideoProperties(combined);
  assert.deepEqual(viaProps.frameMarking, viaMarking);
  assert.strictEqual(viaProps.timestamp, 7n);
  assert.strictEqual(viaMarking.spatialLayerId, 0x10);
});

test("VideoFrameMarking: Length=0 は単体デコーダでは ProtocolViolationError、寛容デコーダでは frameMarking 未設定", () => {
  const wire = buildVideoFrameMarkingWire(0, new Uint8Array(0));
  assert.throws(() => decodeVideoFrameMarking(wire), ProtocolViolationError);
  // decodeVideoProperties は寛容な delta デコードであり、不正な Value の
  // frameMarking は未設定として扱い、PROTOCOL_VIOLATION を送出しない
  const props = decodeVideoProperties(wire);
  assert.isUndefined(props.frameMarking);
});

test("VideoFrameMarking: Length=5 は単体デコーダでは ProtocolViolationError、寛容デコーダでは frameMarking 未設定", () => {
  const wire = buildVideoFrameMarkingWire(5, new Uint8Array([1, 2, 3, 4, 5]));
  assert.throws(() => decodeVideoFrameMarking(wire), ProtocolViolationError);
  const props = decodeVideoProperties(wire);
  assert.isUndefined(props.frameMarking);
});

test("VideoFrameMarking: Value バイト不足は単体デコーダでは ProtocolViolationError、寛容デコーダでは未設定", () => {
  // Length=2 を宣言するが Value は 1 バイトしかない
  const wire = buildVideoFrameMarkingWire(2, new Uint8Array([0xe8]));
  assert.throws(() => decodeVideoFrameMarking(wire), ProtocolViolationError);
  const props = decodeVideoProperties(wire);
  assert.isUndefined(props.frameMarking);
  assert.isUndefined(props.timestamp);
});

// =============================================================================
// VIDEO_FRAME_MARKING の RFC 9626 §3.1 準拠 (LID 8 bits マッピング / B 抑圧 / L の選択)
// =============================================================================

test("VideoFrameMarking: encodeVideoFrameMarking の Value 長は LID と TID が 0 のときだけ 1 オクテットになる (PBT)", () => {
  // RFC 9626 §3.1: L=0 の 1 オクテット形は LID と TL0PICIDX を省略する場合のみ。
  // TL0PICIDX は常に省略するため、LID=0 かつ TID=0 のときに限る
  fc.assert(
    fc.property(videoFrameMarkingArb, (marking) => {
      const encoded = encodeVideoFrameMarking(marking);
      const expectedLength = marking.spatialLayerId === 0 && marking.temporalLayerId === 0 ? 3 : 4;
      assert.strictEqual(
        encoded.length,
        expectedLength,
        `LID=${marking.spatialLayerId} TID=${marking.temporalLayerId} の Value 長が ${expectedLength} ではない`,
      );
      // Value の 1 バイト目は常に S=1 / E=1、2 バイト形の 2 バイト目は LID
      assert.strictEqual(encoded[2]! & 0xc0, 0xc0);
      if (expectedLength === 4) {
        assert.strictEqual(encoded[3], marking.spatialLayerId);
      }
    }),
  );
});

test("VideoFrameMarking: encode は spatialLayerId を LID (byte2) の 8 bit 全体に載せる", () => {
  // RFC 9626 §3.1: LID は 8 bit。TID=1 で 2 オクテット形になる。
  for (const spatialLayerId of [0, 1, 2, 3, 4, 7, 128, 255]) {
    const marking: VideoFrameMarking = {
      isIndependent: false,
      isDiscardable: false,
      isBaseLayerSync: false,
      temporalLayerId: 1,
      spatialLayerId,
    };
    const encoded = encodeVideoFrameMarking(marking);
    // TID=1 のため常に 2 オクテット形: encoded = [ID(0x09), Length(2), byte1, byte2]
    assert.strictEqual(encoded.length, 4);
    assert.strictEqual(encoded[0], 0x09);
    assert.strictEqual(encoded[1], 2);
    // byte1: S=1, E=1, TID=1 → 0xC1 (I / D / B は全て false)
    assert.strictEqual(encoded[2], 0xc1);
    // byte2: spatialLayerId が 8 bit 全体に載る
    assert.strictEqual(encoded[3], spatialLayerId);
  }
});

test("VideoFrameMarking: decode は LID (byte2) の 8 bit 全体を spatialLayerId として復元する", () => {
  // RFC 9626 §3.1: LID は 8 bit。4 以上の値もそのまま復元する。
  for (const lid of [0x00, 0x01, 0x04, 0x07, 0x20, 0x80, 0xff]) {
    // TID=1 で B=0 の byte1 = 0xC1
    const wire = buildVideoFrameMarkingWire(2, new Uint8Array([0xc1, lid]));
    const decoded = decodeVideoFrameMarking(wire);
    assert.strictEqual(decoded.spatialLayerId, lid);
  }
});

test("VideoFrameMarking: TID=0 かつ isBaseLayerSync=true の encode 入力は B=0 に抑圧されワイヤ [0x09, 0x01, 0xe0] になる", () => {
  // RFC 9626 §3.1「When the TID is 0 or if no scalability is used, this MUST be 0」
  const marking: VideoFrameMarking = {
    isIndependent: true,
    isDiscardable: false,
    isBaseLayerSync: true,
    temporalLayerId: 0,
    spatialLayerId: 0,
  };
  const encoded = encodeVideoFrameMarking(marking);
  // 1 オクテット形 (LID=0 かつ TID=0): byte1 = S=1, E=1, I=1, D=0, B=0 (抑圧), TID=0 → 0xE0
  assert.deepEqual(Array.from(encoded), [0x09, 0x01, 0xe0]);
});

test("VideoFrameMarking: TID=0 で B=1 のワイヤは decode 側で isBaseLayerSync=true として忠実に読み出す", () => {
  // decode 側は正規化しない。encode 出力としては (TID=0, B=1) の組み合わせは存在しないが、
  // 準拠しないピアからのワイヤを decode するときはワイヤの値をそのまま反映する。
  // byte1 = 0x80|0x40|0x20|0x08 = 0xE8 (S=1, E=1, I=1, D=0, B=1, TID=0)
  const wire = buildVideoFrameMarkingWire(2, new Uint8Array([0xe8, 0x00]));
  const decoded = decodeVideoFrameMarking(wire);
  assert.strictEqual(decoded.isBaseLayerSync, true);
  assert.strictEqual(decoded.temporalLayerId, 0);
});

test("VideoFrameMarking: TID≠0 のとき isBaseLayerSync は入力を忠実にワイヤに反映する", () => {
  // TID=1 では抑圧されず、入力の isBaseLayerSync がそのまま B ビットに反映される。
  const withSync: VideoFrameMarking = {
    isIndependent: false,
    isDiscardable: false,
    isBaseLayerSync: true,
    temporalLayerId: 1,
    spatialLayerId: 0,
  };
  const encoded = encodeVideoFrameMarking(withSync);
  // byte1: S=1, E=1, B=1, TID=1 → 0xC9
  assert.strictEqual(encoded[2], 0xc9);
  const decoded = decodeVideoFrameMarking(encoded);
  assert.strictEqual(decoded.isBaseLayerSync, true);
  assert.strictEqual(decoded.temporalLayerId, 1);
});

// =============================================================================
// VIDEO_FRAME_MARKING の値域外入力の折り畳み (encode 側マスク)
// =============================================================================
//
// videoFrameMarkingArb は RFC 9626 §3.1 の定義域 (TID 0-7 / LID 0-255) のみを生成するため、
// 値域外入力の折り畳みは PBT では検証されない。encodeVideoFrameMarkingValue が持つ
// `& 0x07` / `& 0xff` マスクの挙動をここで pin する。

test("VideoFrameMarking: temporalLayerId の値域外は下位 3 bits に折り畳まれる", () => {
  // JS のビット演算は ToInt32 で整数化するため、非整数は 0 方向に切り捨てられる
  const cases: Array<{ input: number; expected: number }> = [
    { input: 8, expected: 0 },
    { input: 9, expected: 1 },
    { input: 15, expected: 7 },
    { input: 255, expected: 7 },
    { input: -1, expected: 7 },
    { input: 3.7, expected: 3 },
  ];
  for (const { input, expected } of cases) {
    const marking: VideoFrameMarking = {
      isIndependent: false,
      isDiscardable: false,
      // B 抑圧の影響を排除するため isBaseLayerSync は false にする
      isBaseLayerSync: false,
      temporalLayerId: input,
      spatialLayerId: 0,
    };
    const encoded = encodeVideoFrameMarking(marking);
    // RFC 9626 §3.1: TID が 0 に折り畳まれる入力 (8 など) は LID=0 と合わせて
    // 1 オクテット形になるため、byte1 は encoded[2] で共通に検証できる
    // byte1 = S(0x80) | E(0x40) | TID (I / D / B は全て false)
    assert.strictEqual(
      encoded[2],
      0xc0 | expected,
      `temporalLayerId=${input} は下位 3 bits に折り畳まれるはず`,
    );
    assert.strictEqual(decodeVideoFrameMarking(encoded).temporalLayerId, expected);
  }
});

test("VideoFrameMarking: spatialLayerId の値域外は下位 8 bits に折り畳まれる", () => {
  // RFC 9626 §3.1: LID は 8 bit。値域外の負値・小数・256 以上は下位 8 bits になる
  const cases: Array<{ input: number; expected: number }> = [
    { input: 256, expected: 0 },
    { input: 257, expected: 1 },
    { input: 511, expected: 255 },
    { input: 512, expected: 0 },
    { input: -1, expected: 255 },
    { input: 2.9, expected: 2 },
  ];
  // TID=0 の場合は折り畳み後の LID が 0 のとき 1 オクテット形になる (上のテストで固定)
  for (const { input, expected } of cases) {
    const marking: VideoFrameMarking = {
      isIndependent: false,
      isDiscardable: false,
      isBaseLayerSync: false,
      // TID=1 で 2 オクテット形に固定する (B 抑圧の対象外でもある)
      temporalLayerId: 1,
      spatialLayerId: input,
    };
    const encoded = encodeVideoFrameMarking(marking);
    assert.strictEqual(
      encoded[3],
      expected,
      `spatialLayerId=${input} は下位 8 bits に折り畳まれるはず`,
    );
    assert.strictEqual(decodeVideoFrameMarking(encoded).spatialLayerId, expected);
  }
});

test("VideoFrameMarking: 折り畳みで LID=0 かつ TID=0 になると 1 オクテット形になる", () => {
  // RFC 9626 §3.1 の L=0 は折り畳み後の LID と TID で判定する
  const marking: VideoFrameMarking = {
    isIndependent: true,
    isDiscardable: false,
    isBaseLayerSync: false,
    temporalLayerId: 8,
    spatialLayerId: 256,
  };
  const encoded = encodeVideoFrameMarking(marking);
  // TID=8 & 0x07 = 0、LID=256 & 0xff = 0 → 1 オクテット形 (B も TID=0 で抑圧)
  assert.deepEqual(Array.from(encoded), [0x09, 0x01, 0xe0]);
});

test("VideoFrameMarking: temporalLayerId=8 は TID=0 に折り畳まれ isBaseLayerSync が抑圧される", () => {
  // B 抑圧の判定はマスク後の TID で行われるため、値域外の 8 は TID=0 と同じ扱いになる
  const marking: VideoFrameMarking = {
    isIndependent: true,
    isDiscardable: false,
    isBaseLayerSync: true,
    temporalLayerId: 8,
    spatialLayerId: 0,
  };
  const encoded = encodeVideoFrameMarking(marking);
  // byte1: S=1, E=1, I=1, B=0 (抑圧), TID=0 → 0xE0。LID=0 かつ TID=0 のため 1 オクテット形
  assert.deepEqual(Array.from(encoded), [0x09, 0x01, 0xe0]);
});

test("VideoFrameMarking: encodeVideoProperties 経由でも値域外は同じマスクで折り畳まれる", () => {
  // encodeVideoProperties は encodeVideoFrameMarking を経由せず
  // encodeVideoFrameMarkingValue を直接呼ぶ。単体エンコーダと Properties 経由の
  // 2 経路で折り畳み結果が一致することを pin する
  const properties: VideoProperties = {
    frameMarking: {
      isIndependent: false,
      isDiscardable: false,
      isBaseLayerSync: false,
      temporalLayerId: 11,
      spatialLayerId: 256,
    },
  };
  const decoded = decodeVideoProperties(encodeVideoProperties(properties));
  assert.deepEqual(decoded.frameMarking, {
    isIndependent: false,
    isDiscardable: false,
    isBaseLayerSync: false,
    // 11 & 0x07
    temporalLayerId: 3,
    // 256 & 0xff
    spatialLayerId: 0,
  });
});

// =============================================================================
// 未知 ID のスキップ
// =============================================================================

test("未知の偶数 ID は vi64 としてスキップされる", () => {
  // Object Properties は delta encoding (Figure 2) のため ID は昇順連鎖する。
  // 未知偶数 ID 0x0E + value 99、その後 TIMESTAMP (0x10, delta 0x02)
  const data = new Uint8Array([0x0e, 0x63, 0x02, 0x7b]);

  const video = decodeVideoProperties(data);
  assert.strictEqual(video.timestamp, 123n);

  const audio = decodeAudioProperties(data);
  assert.strictEqual(audio.timestamp, 123n);
});

test("未知の奇数 ID は length + bytes としてスキップされる", () => {
  // TIMESTAMP (0x10, delta 0x10) の後に未知奇数 ID 0x11 (delta 0x01) + length 3 + 3 bytes
  // timestamp value 456 の varint は [0x81, 0xc8]
  const data = new Uint8Array([0x10, 0x81, 0xc8, 0x01, 0x03, 0x01, 0x02, 0x03]);

  const video = decodeVideoProperties(data);
  assert.strictEqual(video.timestamp, 456n);

  const audio = decodeAudioProperties(data);
  assert.strictEqual(audio.timestamp, 456n);
});

// =============================================================================
// 代表値に基づくテスト (VideoFrameMarking のキーフレーム / レイヤー、AudioLevel の無音 / 有音)
// =============================================================================

test("VideoFrameMarking: キーフレーム (I=true, D=false, B=true, TID=0) は encode で B=0 に抑圧される", () => {
  // キーフレームは独立 (I=true)、破棄不可 (D=false)、ベースレイヤー同期 (B=true)。
  // ただし TID=0 のとき RFC 9626 §3.1 の MUST に従い encodeVideoFrameMarkingValue が
  // B=0 に抑圧するため、round-trip 後の isBaseLayerSync は false になる。
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
  assert.strictEqual(decoded.isBaseLayerSync, false);
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

// =============================================================================
// Object Payload Private Properties フレーミング（暫定ワイヤ）
// =============================================================================

/** 空でないバイト列 Arbitrary（1 バイト varint length 領域） */
const nonEmptyBytesArb = fc.uint8Array({ minLength: 1, maxLength: 64 });

/** multi-byte varint length を含む Private 領域（128–256 バイト） */
const multiByteLengthPrivateArb = fc.uint8Array({ minLength: 128, maxLength: 256 });

test("encodeLocObjectPayload: 空 Private は LOC Payload とビット一致する", () => {
  fc.assert(
    fc.property(fc.uint8Array({ minLength: 0, maxLength: 256 }), (locPayload) => {
      // 空 Private では length prefix を付けない
      const encoded = encodeLocObjectPayload(new Uint8Array(0), locPayload);
      assert.deepEqual(Array.from(encoded), Array.from(locPayload));
    }),
  );
});

test("encodeLocObjectPayload / decodeLocObjectPayload: 非空 Private の round-trip が成立する", () => {
  fc.assert(
    fc.property(nonEmptyBytesArb, nonEmptyBytesArb, (privateProperties, locPayload) => {
      const encoded = encodeLocObjectPayload(privateProperties, locPayload);
      const decoded = decodeLocObjectPayload(encoded, { framed: true });
      assert.deepEqual(Array.from(decoded.privateProperties), Array.from(privateProperties));
      assert.deepEqual(Array.from(decoded.locPayload), Array.from(locPayload));
      // 戻り値は入力の独立コピーである（mutation しても encoded に波及しない）
      const encodedSnapshot = Array.from(encoded);
      decoded.privateProperties[0] = (decoded.privateProperties[0] ?? 0) ^ 0xff;
      decoded.locPayload[0] = (decoded.locPayload[0] ?? 0) ^ 0xff;
      assert.deepEqual(Array.from(encoded), encodedSnapshot);
    }),
  );
});

test("encodeLocObjectPayload / decodeLocObjectPayload: multi-byte varint length でも round-trip する", () => {
  fc.assert(
    fc.property(multiByteLengthPrivateArb, nonEmptyBytesArb, (privateProperties, locPayload) => {
      // Private 長 128 以上で length prefix が 2 バイト以上になる経路を固定する
      const encoded = encodeLocObjectPayload(privateProperties, locPayload);
      const decoded = decodeLocObjectPayload(encoded, { framed: true });
      assert.deepEqual(Array.from(decoded.privateProperties), Array.from(privateProperties));
      assert.deepEqual(Array.from(decoded.locPayload), Array.from(locPayload));
    }),
  );
});

test("encodeLocObjectPayload / decodeLocObjectPayload: locPayload が空でも round-trip する", () => {
  const privateProperties = new Uint8Array([0xaa, 0xbb, 0xcc]);
  const encoded = encodeLocObjectPayload(privateProperties, new Uint8Array(0));
  const decoded = decodeLocObjectPayload(encoded, { framed: true });
  assert.deepEqual(Array.from(decoded.privateProperties), Array.from(privateProperties));
  assert.strictEqual(decoded.locPayload.length, 0);
});

test("decodeLocObjectPayload: framed=false （既定）は全体を locPayload とし private は空", () => {
  fc.assert(
    fc.property(fc.uint8Array({ minLength: 0, maxLength: 128 }), (objectPayload) => {
      const decodedDefault = decodeLocObjectPayload(objectPayload);
      const decodedExplicit = decodeLocObjectPayload(objectPayload, { framed: false });
      assert.strictEqual(decodedDefault.privateProperties.length, 0);
      assert.deepEqual(Array.from(decodedDefault.locPayload), Array.from(objectPayload));
      assert.strictEqual(decodedExplicit.privateProperties.length, 0);
      assert.deepEqual(Array.from(decodedExplicit.locPayload), Array.from(objectPayload));
      // framed=false でも戻り値は入力の独立コピー
      if (decodedDefault.locPayload.length > 0) {
        decodedDefault.locPayload[0] = (decodedDefault.locPayload[0] ?? 0) ^ 0xff;
        assert.notDeepEqual(Array.from(decodedDefault.locPayload), Array.from(objectPayload));
      }
    }),
  );
});

test("decodeLocObjectPayload: framed=true の空バッファは ProtocolViolationError", () => {
  try {
    decodeLocObjectPayload(new Uint8Array(0), { framed: true });
    assert.fail("例外が投げられるべき");
  } catch (error) {
    assert.ok(error instanceof ProtocolViolationError);
    assert.ok(!(error instanceof IncompleteDataError));
  }
});

test("decodeLocObjectPayload: framed=true の不完全 varint は ProtocolViolationError", () => {
  // 2 バイト長を宣言するが 1 バイトしか無い
  try {
    decodeLocObjectPayload(new Uint8Array([0x80]), { framed: true });
    assert.fail("例外が投げられるべき");
  } catch (error) {
    assert.ok(error instanceof ProtocolViolationError);
    assert.ok(!(error instanceof IncompleteDataError));
  }
});

test("decodeLocObjectPayload: framed=true の length=0 は ProtocolViolationError", () => {
  // varint(0) = 0x00
  assert.throws(
    () => decodeLocObjectPayload(new Uint8Array([0x00, 0x01, 0x02]), { framed: true }),
    ProtocolViolationError,
  );
});

test("decodeLocObjectPayload: framed=true で privateLength が残りを超えると ProtocolViolationError", () => {
  // length=5 だが残りが 2 バイトしかない
  const payload = new Uint8Array([0x05, 0xaa, 0xbb]);
  assert.throws(() => decodeLocObjectPayload(payload, { framed: true }), ProtocolViolationError);
});

test("decodeLocObjectPayload: framed=true で Number.MAX_SAFE_INTEGER 超は ProtocolViolationError", () => {
  // 9 バイト varint で Number.MAX_SAFE_INTEGER + 1 を載せる
  const tooLarge = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  const lengthBytes = encodeVarint(tooLarge);
  assert.throws(
    () => decodeLocObjectPayload(lengthBytes, { framed: true }),
    ProtocolViolationError,
  );
});

test("空 encode 結果を framed=true で decode しても round-trip にはならない", () => {
  // 空 Private のカノニカル形は prefix 無し。先頭バイトを誤って length と解釈しうる
  const locPayload = new Uint8Array([0x05, 0x11, 0x22, 0x33, 0x44, 0x55]);
  const encoded = encodeLocObjectPayload(new Uint8Array(0), locPayload);
  assert.deepEqual(Array.from(encoded), Array.from(locPayload));

  // framed=true で分割すると先頭 0x05 を length とみなし、残りが locPayload になる（元と異なる）
  const decoded = decodeLocObjectPayload(encoded, { framed: true });
  assert.notDeepEqual(Array.from(decoded.locPayload), Array.from(locPayload));
  assert.strictEqual(decoded.privateProperties.length, 5);
});

test("encodeVideoProperties → encodeLocObjectPayload → framed decode → decodeVideoProperties の結合", () => {
  const properties: VideoProperties = {
    timestamp: 12345n,
    timescale: 90000n,
  };
  const privateBytes = encodeVideoProperties(properties);
  const locPayload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const encoded = encodeLocObjectPayload(privateBytes, locPayload);
  const { privateProperties, locPayload: decodedPayload } = decodeLocObjectPayload(encoded, {
    framed: true,
  });
  const decoded = decodeVideoProperties(privateProperties);
  assert.strictEqual(decoded.timestamp, 12345n);
  assert.strictEqual(decoded.timescale, 90000n);
  assert.deepEqual(Array.from(decodedPayload), Array.from(locPayload));
});

// draft-ietf-moq-loc-04 §2.3.3.2:
// Audio Level の Value は "vi64 (1-2 bytes to encode values 0x00-0xFF)" であり、
// 0xFF を超える値は 0x100 から MAX_VARINT までの全域で拒否する
// (draft-ietf-moq-transport-21 §8.3 の serialization 不一致)。
const outOfRangeAudioLevelArb = fc.bigInt({ min: 0x100n, max: MAX_VARINT });

test("Audio Level の値域外の値は全域で KEY_VALUE_FORMATTING_ERROR になる", () => {
  fc.assert(
    fc.property(outOfRangeAudioLevelArb, (value) => {
      // 単一 Property の Delta Type は ID そのものになるため、
      // decodeAudioLevel の絶対 Type ワイヤとしても使える
      const wire = encodeProperties([{ id: LOCPropertyId.AUDIO_LEVEL, value }]);
      assertKeyValueFormattingError(() => decodeAudioLevel(wire));
      assertKeyValueFormattingError(() => assertKnownPropertyValueInObjectProperties(wire));
    }),
  );
});
