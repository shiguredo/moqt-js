/**
 * LOC Properties (Track / Object Scope) Unit Tests
 * draft-ietf-moq-loc-04 Table 1 (TIMESTAMP 0x10 / TIMESCALE 0x08 / VIDEO_FRAME_MARKING 0x09 /
 * AUDIO_LEVEL 0x0C / VIDEO_CONFIG 0x0D / AUDIO_CONFIG 0x0F)
 *
 * LOC Properties を Track Property と Object Property の両方で扱う経路、および
 * Object Properties の Key-Value-Pair delta 符号化（draft-ietf-moq-transport-20
 * §1.4.3 / §11.2.1.2）のワイヤ形式・寛容デコード・合成経路を検証する。
 * 単体エンコーダ / デコーダ（encodeTimestamp 等）は単一 Property 用の絶対 Type ワイヤであり、
 * 複数 Property のワイヤは encode*Properties / decode*Properties が担う。
 */

import { test, assert } from "vite-plus/test";
import {
  LOCPropertyId,
  encodeVideoProperties,
  encodeAudioProperties,
  encodeTimestamp,
  encodeTimescale,
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
// TID=0 では RFC 9626 §3.1 の MUST に従い encodeVideoFrameMarkingValue が B=0 に抑圧するため、
// Value バイト列は [0xe0, 0x00] (S=1, E=1, I=1, B=0) となる。
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
// （draft-ietf-moq-transport-20 §12.1 の SUBGROUP_DELIVERY_TIMEOUT 先例）。
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

// track 入力に Object スコープ専用の ID が現れても抽出しない (draft-ietf-moq-loc-04 Table 1 の scope)。
test("resolveVideoProperties: Track に Object スコープの ID を含めても抽出しない", () => {
  const trackProperties: Property[] = [
    { id: LOCPropertyId.TIMESTAMP, value: 5n },
    { id: LOCPropertyId.VIDEO_FRAME_MARKING, data: new Uint8Array([0xe8, 0x00]) },
    { id: LOCPropertyId.TIMESCALE, value: 90000n },
  ];
  const resolved = resolveVideoProperties(trackProperties, undefined);
  assert.isUndefined(resolved.timestamp);
  assert.isUndefined(resolved.frameMarking);
  assert.equal(resolved.timescale, 90000n);
});

test("resolveAudioProperties: Track に Object スコープの ID を含めても抽出しない", () => {
  const trackProperties: Property[] = [
    { id: LOCPropertyId.TIMESTAMP, value: 5n },
    { id: LOCPropertyId.AUDIO_LEVEL, value: 50n },
    { id: LOCPropertyId.TIMESCALE, value: 48000n },
  ];
  const resolved = resolveAudioProperties(trackProperties, undefined);
  assert.isUndefined(resolved.timestamp);
  assert.isUndefined(resolved.audioLevel);
  assert.equal(resolved.timescale, 48000n);
});

// Object と Track の両方が同一 Property を持つ場合は Object 優先 (Track フォールバックの写像)。
test("resolveVideoProperties: Object と Track の両方が config を持つ場合は Object を優先する", () => {
  const trackProperties: Property[] = [
    { id: LOCPropertyId.VIDEO_CONFIG, data: new Uint8Array([0x0a]) },
  ];
  const objectProperties = encodeVideoProperties({ config: new Uint8Array([0x0b]) });
  const resolved = resolveVideoProperties(trackProperties, objectProperties);
  assert.deepEqual(Array.from(resolved.config ?? []), [0x0b]);
});

// ==========================================================================
// 固定バイト列によるワイヤ形式検証 (draft-ietf-moq-transport-20 §1.4.3 / §11.2.1.2)
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

test("encodeVideoProperties: timescale 単体のワイヤは encodeTimescale とビット一致する", () => {
  const viaProps = encodeVideoProperties({ timescale: 48000n });
  assert.deepEqual(Array.from(viaProps), Array.from(encodeTimescale(48000n)));
});

test("encodeAudioProperties: timescale 単体のワイヤは encodeTimescale とビット一致する", () => {
  const viaProps = encodeAudioProperties({ timescale: 44100n });
  assert.deepEqual(Array.from(viaProps), Array.from(encodeTimescale(44100n)));
});

// 複数 Property: ID 昇順ソート後に delta 連鎖し、2 番目以降の Delta Type が前 ID との差分になる。
// timestamp (0x10) + frameMarking (0x09) → frameMarking が先頭になり、Delta Type は 0x09, 0x07。
test("encodeVideoProperties: timestamp + frameMarking のワイヤは delta 形式（Delta Type 0x09, 0x07）になる", () => {
  const encoded = encodeVideoProperties({
    timestamp: 1234n,
    frameMarking: keyFrameMarking,
  });
  // frameMarking: Delta Type 0x09, Length 2, Value [0xe0, 0x00] (TID=0 で B=0 抑圧)
  // timestamp:   Delta Type 0x07 (0x10 - 0x09), Value 1234 の varint [0x84, 0xd2]
  assert.deepEqual(Array.from(encoded), [0x09, 0x02, 0xe0, 0x00, 0x07, 0x84, 0xd2]);
});

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
// 抽出できたフィールドのみを設定して配信を継続する (delta 連鎖の寛容解釈)。
// 途中で壊れた場合は先行値のみ保持され、先頭から壊れた場合は全て未設定になる。
test("decodeVideoProperties: 不正な Length の後続 Property でも PROTOCOL_VIOLATION を送出せず、先行値のみ保持する", () => {
  // timescale (0x08) は正常、後続の frameMarking (0x09) が Length=10 を宣言するが
  // Value は 1 バイトしかない (不完全な delta KVP)。frameMarking の Delta Type は
  // 0x09 - 0x08 = 0x01。
  const wire = new Uint8Array([0x08, 0x80, 0x80, 0x01, 0x0a, 0xe8]);
  const decoded = decodeVideoProperties(wire);
  assert.equal(decoded.timescale, 128n);
  assert.isUndefined(decoded.timestamp);
  assert.isUndefined(decoded.frameMarking);
});

test("decodeVideoProperties: 先頭 Property の Length 宣言が切り詰まれた delta KVP でも PROTOCOL_VIOLATION を送出せず、フィールドを空にする", () => {
  // 先頭 Property (delta 0x09 → VIDEO_FRAME_MARKING) が Length=10 を宣言するが
  // Value は 1 バイトしかない (不完全な delta KVP)。この時点で抽出は全滅するため
  // 全てのフィールドが未設定になる。
  const wire = new Uint8Array([0x09, 0x0a, 0xe8]);
  const decoded = decodeVideoProperties(wire);
  assert.isUndefined(decoded.timestamp);
  assert.isUndefined(decoded.timescale);
  assert.isUndefined(decoded.frameMarking);
  assert.isUndefined(decoded.config);
});

test("decodeAudioProperties: 後続 Property が不完全でも PROTOCOL_VIOLATION を送出せず、先行値のみ保持する", () => {
  // audioLevel (0x0C) は正常、後続の未知奇数 ID (0x0C + 0x05 = 0x11) が Length=10 を宣言するが
  // Value は 1 バイトしかない (不完全な delta KVP)。
  const wire = new Uint8Array([0x0c, 0x80, 0xb2, 0x05, 0x0a, 0xe8]);
  const decoded = decodeAudioProperties(wire);
  assert.deepEqual(decoded.audioLevel, { level: 50, voiceActivity: true });
  assert.isUndefined(decoded.timestamp);
  assert.isUndefined(decoded.config);
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
  // 合成後も LOC フィールドが復元できる。
  // keyFrameMarking は isBaseLayerSync=true だが TID=0 のため encode 時に B=0 に抑圧され、
  // 復元後は isBaseLayerSync=false になる。
  const resolved = decodeVideoProperties(merged!);
  assert.deepEqual(resolved.frameMarking, { ...keyFrameMarking, isBaseLayerSync: false });
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
