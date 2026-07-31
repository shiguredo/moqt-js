/**
 * LOC Track Property Scope Unit Tests
 * draft-ietf-moq-loc-04 Table 1 (TIMESCALE / VIDEO_CONFIG / AUDIO_CONFIG: Scope Track, Object)
 *
 * LOC Properties を Track Property としても扱えるようにする経路を検証する。
 * Track Properties は delta 符号化（encodeProperties / decodeProperties）、
 * Object Properties は絶対 Type 連結（encode*Properties / decode*Properties）とワイヤ形式が異なる。
 */

import { test, assert } from "vite-plus/test";
import {
  LOCPropertyId,
  encodeVideoProperties,
  encodeAudioProperties,
  resolveVideoProperties,
  resolveAudioProperties,
} from "./loc";
import { encodeProperties, decodeProperties, type Property } from "./properties";
import { buildPublishTrackProperties } from "./session/params";

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
