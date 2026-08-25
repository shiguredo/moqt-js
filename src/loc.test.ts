/**
 * LOC Track Property Scope Unit Tests
 * draft-ietf-moq-loc-04 Table 1 (TIMESCALE / VIDEO_CONFIG / AUDIO_CONFIG: Scope Track, Object)
 *
 * LOC Properties を Track Property としても扱えるようにする経路を検証する。
 * Track Properties も Object Properties も delta 符号化
 * (draft-ietf-moq-transport-19 §1.4.3 / §11.2.1.2 の Key-Value-Pairs) を使用する。
 * 単体エンコーダ / デコーダ（encodeTimestamp 等）は単一 Property 用の絶対 Type ワイヤであり、
 * 複数 Property のワイヤは encode*Properties / decode*Properties が担う。
 */

import { test, assert } from "vite-plus/test";
import {
  LOCPropertyId,
  encodeVideoProperties,
  encodeAudioProperties,
  encodeTimestamp,
  encodeVideoFrameMarking,
  encodeAudioLevel,
  encodeVideoConfig,
  encodeAudioConfig,
  decodeVideoProperties,
  decodeAudioProperties,
  resolveVideoProperties,
  resolveAudioProperties,
  type VideoFrameMarking,
} from "./loc";
import {
  encodeProperties,
  decodeProperties,
  decodeObjectPropertiesTolerant,
  mergeDeliveryTimeoutObjectProperties,
  appendGreaseObjectProperty,
  type Property,
} from "./properties";
import { isGreaseValue } from "./grease";
import { buildPublishTrackProperties } from "./session/params";

// キーフレーム用の VideoFrameMarking (I=true, D=false, B=true, TID=0, SID=0)
// Value バイト列は [0xe8, 0x00] (S=1, E=1, I=1, B=1)
const keyFrameMarking: VideoFrameMarking = {
  isIndependent: true,
  isDiscardable: false,
  isBaseLayerSync: true,
  temporalLayerId: 0,
  spatialLayerId: 0,
};

// 完了条件: LOCPropertyId.TIMESCALE / VIDEO_CONFIG / AUDIO_CONFIG を Property オブジェクトとして
// 構築し、encodeProperties() 経由で Track Properties バイト列に載せて復元できること。
test("LOC Track Properties を encodeProperties / decodeProperties で roundtrip する", () => {
  const videoConfig = new Uint8Array([0x01, 0x02, 0x03]);
  const audioConfig = new Uint8Array([0x04, 0x05]);
  const trackProperties = buildPublishTrackProperties({
    locTimescale: 90000n,
    locVideoConfig: videoConfig,
    locAudioConfig: audioConfig,
  });

  const encoded = encodeProperties(trackProperties);
  const decoded = decodeProperties(encoded);

  const timescale = decoded.find((p) => p.id === LOCPropertyId.TIMESCALE);
  const video = decoded.find((p) => p.id === LOCPropertyId.VIDEO_CONFIG);
  const audio = decoded.find((p) => p.id === LOCPropertyId.AUDIO_CONFIG);
  assert.equal(timescale?.value, 90000n);
  assert.deepEqual(Array.from(video?.data ?? []), Array.from(videoConfig));
  assert.deepEqual(Array.from(audio?.data ?? []), Array.from(audioConfig));
});

// resolveVideoProperties: Object のみ。Track Property がない場合は Object の値を使う。
test("resolveVideoProperties: Object のみ", () => {
  const objectProperties = encodeVideoProperties({ timestamp: 1234n, timescale: 48000n });
  const resolved = resolveVideoProperties(undefined, objectProperties);
  assert.equal(resolved.timestamp, 1234n);
  assert.equal(resolved.timescale, 48000n);
});

// resolveVideoProperties: Track のみ。Object Property がない場合は Track でフォールバックする。
test("resolveVideoProperties: Track のみ", () => {
  const trackProperties: Property[] = [
    { id: LOCPropertyId.TIMESCALE, value: 90000n },
    { id: LOCPropertyId.VIDEO_CONFIG, data: new Uint8Array([0x0a]) },
  ];
  const resolved = resolveVideoProperties(trackProperties, undefined);
  assert.equal(resolved.timescale, 90000n);
  assert.deepEqual(Array.from(resolved.config ?? []), [0x0a]);
  // timestamp は Object スコープのみのため Track からは取得しない
  assert.isUndefined(resolved.timestamp);
});

// resolveVideoProperties: 両方。同一 Property は Object が Track を上書きする
// （draft-ietf-moq-transport-19 §12.1 の SUBGROUP_DELIVERY_TIMEOUT 先例）。
test("resolveVideoProperties: 両方（Object 優先）", () => {
  const trackProperties: Property[] = [
    { id: LOCPropertyId.TIMESCALE, value: 90000n },
    { id: LOCPropertyId.VIDEO_CONFIG, data: new Uint8Array([0x0a]) },
  ];
  // Object は timescale を持ち、config は持たない
  const objectProperties = encodeVideoProperties({ timestamp: 5n, timescale: 48000n });
  const resolved = resolveVideoProperties(trackProperties, objectProperties);
  assert.equal(resolved.timestamp, 5n);
  // timescale は Object 優先
  assert.equal(resolved.timescale, 48000n);
  // config は Object が持たないため Track でフォールバック
  assert.deepEqual(Array.from(resolved.config ?? []), [0x0a]);
});

// resolveAudioProperties: Object のみ。Track Property がない場合は Object の値を使う。
test("resolveAudioProperties: Object のみ", () => {
  const objectProperties = encodeAudioProperties({ timestamp: 99n, timescale: 44100n });
  const resolved = resolveAudioProperties(undefined, objectProperties);
  assert.equal(resolved.timestamp, 99n);
  assert.equal(resolved.timescale, 44100n);
});

// resolveAudioProperties: Track のみ。Object Property がない場合は Track でフォールバックする。
test("resolveAudioProperties: Track のみ", () => {
  const trackProperties: Property[] = [
    { id: LOCPropertyId.TIMESCALE, value: 48000n },
    { id: LOCPropertyId.AUDIO_CONFIG, data: new Uint8Array([0x0c]) },
  ];
  const resolved = resolveAudioProperties(trackProperties, undefined);
  assert.equal(resolved.timescale, 48000n);
  assert.deepEqual(Array.from(resolved.config ?? []), [0x0c]);
  // timestamp / audioLevel は Object スコープのみのため Track からは取得しない
  assert.isUndefined(resolved.timestamp);
  assert.isUndefined(resolved.audioLevel);
});

// resolveAudioProperties: 両方（Object 優先）。Audio も Video と同じ優先規則。
test("resolveAudioProperties: 両方（Object 優先）", () => {
  const trackProperties: Property[] = [
    { id: LOCPropertyId.TIMESCALE, value: 90000n },
    { id: LOCPropertyId.AUDIO_CONFIG, data: new Uint8Array([0x0b]) },
  ];
  const objectProperties = encodeAudioProperties({ timestamp: 7n, timescale: 44100n });
  const resolved = resolveAudioProperties(trackProperties, objectProperties);
  assert.equal(resolved.timestamp, 7n);
  assert.equal(resolved.timescale, 44100n);
  assert.deepEqual(Array.from(resolved.config ?? []), [0x0b]);
});

// ==========================================================================
// 固定バイト列によるワイヤ形式検証 (draft-ietf-moq-transport-19 §1.4.3 / §11.2.1.2)
// ==========================================================================

// 単一 Property のワイヤは「先頭の Delta Type = 0 からの絶対値」と同一であり、
// 従来の絶対形式 (encodeTimestamp / encodeVideoFrameMarking 等) とビット一致する。
test("encodeVideoProperties: timestamp 単体のワイヤは encodeTimestamp とビット一致する", () => {
  const viaProps = encodeVideoProperties({ timestamp: 1234n });
  assert.deepEqual(Array.from(viaProps), Array.from(encodeTimestamp(1234n)));
});

test("encodeVideoProperties: frameMarking 単体のワイヤは encodeVideoFrameMarking とビット一致する", () => {
  const viaProps = encodeVideoProperties({ frameMarking: keyFrameMarking });
  assert.deepEqual(Array.from(viaProps), Array.from(encodeVideoFrameMarking(keyFrameMarking)));
});

test("encodeAudioProperties: timestamp 単体のワイヤは encodeTimestamp とビット一致する", () => {
  const viaProps = encodeAudioProperties({ timestamp: 99n });
  assert.deepEqual(Array.from(viaProps), Array.from(encodeTimestamp(99n)));
});

test("encodeAudioProperties: audioLevel 単体のワイヤは encodeAudioLevel とビット一致する", () => {
  const viaProps = encodeAudioProperties({
    audioLevel: { level: 50, voiceActivity: true },
  });
  assert.deepEqual(Array.from(viaProps), Array.from(encodeAudioLevel(50, true)));
});

test("encodeVideoProperties: config 単体のワイヤは encodeVideoConfig とビット一致する", () => {
  const config = new Uint8Array([0x01, 0x02]);
  const viaProps = encodeVideoProperties({ config });
  assert.deepEqual(Array.from(viaProps), Array.from(encodeVideoConfig(config)));
});

test("encodeAudioProperties: config 単体のワイヤは encodeAudioConfig とビット一致する", () => {
  const config = new Uint8Array([0xaa]);
  const viaProps = encodeAudioProperties({ config });
  assert.deepEqual(Array.from(viaProps), Array.from(encodeAudioConfig(config)));
});

// 複数 Property: ID 昇順ソート後に delta 連鎖し、2 番目以降の Delta Type が前 ID との差分になる。
// timestamp (0x10) + frameMarking (0x09) → frameMarking が先頭になり、Delta Type は 0x09, 0x07。
test("encodeVideoProperties: timestamp + frameMarking のワイヤは delta 形式（Delta Type 0x09, 0x07）になる", () => {
  const encoded = encodeVideoProperties({
    timestamp: 1234n,
    frameMarking: keyFrameMarking,
  });
  // frameMarking: Delta Type 0x09, Length 2, Value [0xe8, 0x00]
  // timestamp:   Delta Type 0x07 (0x10 - 0x09), Value 1234 の varint [0x84, 0xd2]
  assert.deepEqual(Array.from(encoded), [0x09, 0x02, 0xe8, 0x00, 0x07, 0x84, 0xd2]);
});

// audioLevel (0x0C) + timestamp (0x10): Delta Type は 0x0C, 0x04。
test("encodeAudioProperties: timestamp + audioLevel のワイヤは delta 形式（Delta Type 0x0C, 0x04）になる", () => {
  const encoded = encodeAudioProperties({
    timestamp: 42n,
    audioLevel: { level: 50, voiceActivity: true },
  });
  // audioLevel: Delta Type 0x0C, Value 0xB2 (level=50 | V=1) の varint [0x80, 0xb2]
  // timestamp:  Delta Type 0x04 (0x10 - 0x0C), Value 42
  assert.deepEqual(Array.from(encoded), [0x0c, 0x80, 0xb2, 0x04, 0x2a]);
});

// 仕様準拠の delta KVP 固定バイト列を直接入力しても、LOC フィールドを正しく抽出できる
// (対向実装がエンコードする形式。Property ID は昇順でなければならない)。
test("decodeVideoProperties: 仕様準拠の delta KVP 固定バイト列をデコードする", () => {
  // timescale (0x08): Delta Type 0x08, Value 128 の varint [0x80, 0x80]
  // timestamp  (0x10): Delta Type 0x08 (0x10 - 0x08), Value 168 の varint [0x80, 0xa8]
  const wire = new Uint8Array([0x08, 0x80, 0x80, 0x08, 0x80, 0xa8]);
  const decoded = decodeVideoProperties(wire);
  assert.equal(decoded.timescale, 128n);
  assert.equal(decoded.timestamp, 168n);
});

test("decodeAudioProperties: 仕様準拠の delta KVP 固定バイト列をデコードする", () => {
  // audioLevel (0x0C): Delta Type 0x0C, Value 0xB2 の varint [0x80, 0xb2]
  // timestamp  (0x10): Delta Type 0x04, Value 42
  const wire = new Uint8Array([0x0c, 0x80, 0xb2, 0x04, 0x2a]);
  const decoded = decodeAudioProperties(wire);
  assert.deepEqual(decoded.audioLevel, { level: 50, voiceActivity: true });
  assert.equal(decoded.timestamp, 42n);
});

// 不正な delta / 不正な Length を含む Object Properties で PROTOCOL_VIOLATION を送出せず、
// 抽出できたフィールドのみを設定して配信を継続する (0360 と同じ寛容性)。
test("decodeVideoProperties: 不正な Length の後続 Property でも PROTOCOL_VIOLATION を送出せず、先行値のみ保持する", () => {
  // timescale (0x08) は正常、後続の frameMarking (0x09) が Length=10 を宣言するが
  // Value は 1 バイトしかない (不完全な delta KVP)。delta は前 Property との差分で
  // 連鎖するため、途中で壊れると後続 Property は抽出されない。
  const wire = new Uint8Array([0x08, 0x80, 0x80, 0x09, 0x0a, 0xe8]);
  const decoded = decodeVideoProperties(wire);
  assert.equal(decoded.timescale, 128n);
  assert.isUndefined(decoded.timestamp);
  assert.isUndefined(decoded.frameMarking);
});

test("decodeVideoProperties: 単一の不正な delta でも PROTOCOL_VIOLATION を送出せず、フィールドを空にする", () => {
  // 先頭がダミー Property (Length=10 宣言 + Value 1 バイト) のみの不完全な delta KVP
  const wire = new Uint8Array([0x09, 0x0a, 0xe8]);
  const decoded = decodeVideoProperties(wire);
  assert.isUndefined(decoded.timestamp);
  assert.isUndefined(decoded.timescale);
  assert.isUndefined(decoded.frameMarking);
  assert.isUndefined(decoded.config);
});

test("decodeVideoProperties: VIDEO_FRAME_MARKING の Value が不正 (Length=5) なら frameMarking 未設定", () => {
  // 単一 Property: Delta Type 0x09, Length 5, Value 5 バイト
  const wire = new Uint8Array([0x09, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05]);
  const decoded = decodeVideoProperties(wire);
  assert.isUndefined(decoded.frameMarking);
});

test("decodeVideoProperties: VIDEO_FRAME_MARKING の Value が不正 (Length=0) なら frameMarking 未設定", () => {
  // 単一 Property: Delta Type 0x09, Length 0
  const wire = new Uint8Array([0x09, 0x00]);
  const decoded = decodeVideoProperties(wire);
  assert.isUndefined(decoded.frameMarking);
});

// GREASE Property と LOC Property が混在した delta KVP から LOC フィールドのみ抽出する。
test("decodeVideoProperties: GREASE Property と LOC Property が混在する delta KVP から LOC のみ抽出する", () => {
  // timestamp (0x10): Delta Type 0x10, Value 42
  // GREASE  (0x9D): Delta Type 0x8D (0x9D - 0x10) の varint [0x80, 0x8d], Length 0 (N=0 の 0x7f*N+0x9D)
  const wire = new Uint8Array([0x10, 0x2a, 0x80, 0x8d, 0x00]);
  const decoded = decodeVideoProperties(wire);
  assert.equal(decoded.timestamp, 42n);
  assert.isUndefined(decoded.frameMarking);
});

// LOC Property と delivery timeout / GREASE の合成経路が delta 形式を維持する。
test("mergeDeliveryTimeoutObjectProperties: LOC バイト列を入力にしても delta 形式を維持する", () => {
  const loc = encodeVideoProperties({ timestamp: 1234n, frameMarking: keyFrameMarking });
  const merged = mergeDeliveryTimeoutObjectProperties(loc, 5000n, undefined);
  assert.isDefined(merged);
  const decoded = decodeObjectPropertiesTolerant(merged!);
  assert.ok(decoded.complete);
  // ID 昇順: OBJECT_DELIVERY_TIMEOUT (0x02) → VIDEO_FRAME_MARKING (0x09) → TIMESTAMP (0x10)
  assert.deepEqual(
    decoded.properties.map((property) => property.id),
    [0x02n, 0x09n, 0x10n],
  );
  // 合成後も LOC フィールドが復元できる
  const resolved = decodeVideoProperties(merged!);
  assert.deepEqual(resolved.frameMarking, keyFrameMarking);
  assert.equal(resolved.timestamp, 1234n);
});

test("appendGreaseObjectProperty: LOC バイト列を入力にしても delta 形式を維持する", () => {
  const loc = encodeVideoProperties({ timestamp: 1234n });
  const appended = appendGreaseObjectProperty(loc);
  const decoded = decodeObjectPropertiesTolerant(appended);
  assert.ok(decoded.complete);
  // ID 昇順: TIMESTAMP (0x10) → GREASE
  assert.equal(decoded.properties.length, 2);
  assert.equal(decoded.properties[0].id, 0x10n);
  assert.ok(isGreaseValue(decoded.properties[1].id));
});
