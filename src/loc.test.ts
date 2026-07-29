/**
 * LOC Track Property Helper Unit Tests
 * draft-ietf-moq-loc-04 Table 1: Scope = Track, Object
 */

import { test, assert } from "vite-plus/test";
import {
  LOCPropertyId,
  buildLocTrackProperties,
  resolveLocProperties,
  encodeTimescale,
  encodeVideoConfig,
  encodeAudioConfig,
} from "./loc";
import { encodeProperties, decodeProperties } from "./properties";

// buildLocTrackProperties は Track Property として送信可能な LOC Property を
// Property オブジェクト配列として構築する

test("LOC Track Property: 空オプションでは空配列を返す", () => {
  const props = buildLocTrackProperties({});
  assert.equal(props.length, 0);
});

test("LOC Track Property: timescale のみ指定", () => {
  const props = buildLocTrackProperties({ timescale: 90000n });
  assert.equal(props.length, 1);
  assert.equal(props[0].id, LOCPropertyId.TIMESCALE);
  assert.equal(props[0].value, 90000n);
});

test("LOC Track Property: videoConfig のみ指定", () => {
  const description = new Uint8Array([0x01, 0x02, 0x03]);
  const props = buildLocTrackProperties({ videoConfig: description });
  assert.equal(props.length, 1);
  assert.equal(props[0].id, LOCPropertyId.VIDEO_CONFIG);
  assert.deepEqual(props[0].data, description);
});

test("LOC Track Property: audioConfig のみ指定", () => {
  const description = new Uint8Array([0xaa, 0xbb]);
  const props = buildLocTrackProperties({ audioConfig: description });
  assert.equal(props.length, 1);
  assert.equal(props[0].id, LOCPropertyId.AUDIO_CONFIG);
  assert.deepEqual(props[0].data, description);
});

test("LOC Track Property: 全 3 種指定", () => {
  const videoDesc = new Uint8Array([0x01]);
  const audioDesc = new Uint8Array([0x02]);
  const props = buildLocTrackProperties({
    timescale: 48000n,
    videoConfig: videoDesc,
    audioConfig: audioDesc,
  });
  assert.equal(props.length, 3);
});

// encodeProperties 経由で Track Properties バイト列に載せられることを確認する
test("LOC Track Property: encodeProperties で roundtrip できる", () => {
  const videoDesc = new Uint8Array([0xde, 0xad]);
  const props = buildLocTrackProperties({
    timescale: 90000n,
    videoConfig: videoDesc,
  });
  const encoded = encodeProperties(props);
  const decoded = decodeProperties(encoded);

  // TIMESCALE (0x08) は偶数 ID なので varint value 形式
  const timescale = decoded.find((p) => p.id === LOCPropertyId.TIMESCALE);
  assert.isDefined(timescale);
  assert.equal(timescale.value, 90000n);

  // VIDEO_CONFIG (0x0D) は奇数 ID なので length + bytes 形式
  const videoConfig = decoded.find((p) => p.id === LOCPropertyId.VIDEO_CONFIG);
  assert.isDefined(videoConfig);
  assert.deepEqual(videoConfig.data, videoDesc);
});

// resolveLocProperties は Track Property と Object Property の両方を探索し、
// Object Property が Track Property を上書きする

test("LOC resolve: Track Properties のみ", () => {
  const trackProps = buildLocTrackProperties({ timescale: 90000n });
  const resolved = resolveLocProperties(trackProps);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].id, LOCPropertyId.TIMESCALE);
  assert.equal(resolved[0].value, 90000n);
});

test("LOC resolve: Object Properties のみ", () => {
  // Object Properties は絶対 Type 連結形式（encodeTimescale は ID + value）
  const objectPayload = encodeTimescale(48000n);
  const resolved = resolveLocProperties([], objectPayload);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].id, LOCPropertyId.TIMESCALE);
  assert.equal(resolved[0].value, 48000n);
});

test("LOC resolve: Object Property が Track Property を上書きする", () => {
  // Track に timescale=90000、Object に timescale=48000
  const trackProps = buildLocTrackProperties({ timescale: 90000n });
  const objectPayload = encodeTimescale(48000n);
  const resolved = resolveLocProperties(trackProps, objectPayload);

  const timescale = resolved.find((p) => p.id === LOCPropertyId.TIMESCALE);
  assert.isDefined(timescale);
  // Object が優先
  assert.equal(timescale.value, 48000n);
});

test("LOC resolve: Track と Object で異なる Property が共存する", () => {
  // Track に timescale、Object に videoConfig
  const trackProps = buildLocTrackProperties({ timescale: 90000n });
  const videoDesc = new Uint8Array([0x01, 0x02]);
  const objectPayload = encodeVideoConfig(videoDesc);
  const resolved = resolveLocProperties(trackProps, objectPayload);

  assert.equal(resolved.length, 2);
  const timescale = resolved.find((p) => p.id === LOCPropertyId.TIMESCALE);
  const videoConfig = resolved.find((p) => p.id === LOCPropertyId.VIDEO_CONFIG);
  assert.isDefined(timescale);
  assert.equal(timescale.value, 90000n);
  assert.isDefined(videoConfig);
  assert.deepEqual(videoConfig.data, videoDesc);
});

test("LOC resolve: 空の Object Properties は Track を維持する", () => {
  const trackProps = buildLocTrackProperties({
    timescale: 90000n,
    audioConfig: new Uint8Array([0xff]),
  });
  const resolved = resolveLocProperties(trackProps, new Uint8Array(0));
  assert.equal(resolved.length, 2);
});

test("LOC resolve: Object に複数 Property がある場合も全て解決する", () => {
  // Object に timescale + videoConfig + audioConfig を連結
  const videoDesc = new Uint8Array([0xaa]);
  const audioDesc = new Uint8Array([0xbb]);
  const ts = encodeTimescale(44100n);
  const vc = encodeVideoConfig(videoDesc);
  const ac = encodeAudioConfig(audioDesc);

  const objectPayload = new Uint8Array(ts.length + vc.length + ac.length);
  objectPayload.set(ts, 0);
  objectPayload.set(vc, ts.length);
  objectPayload.set(ac, ts.length + vc.length);

  const resolved = resolveLocProperties([], objectPayload);
  assert.equal(resolved.length, 3);

  const timescale = resolved.find((p) => p.id === LOCPropertyId.TIMESCALE);
  assert.isDefined(timescale);
  assert.equal(timescale.value, 44100n);

  const videoConfig = resolved.find((p) => p.id === LOCPropertyId.VIDEO_CONFIG);
  assert.isDefined(videoConfig);
  assert.deepEqual(videoConfig.data, videoDesc);

  const audioConfig = resolved.find((p) => p.id === LOCPropertyId.AUDIO_CONFIG);
  assert.isDefined(audioConfig);
  assert.deepEqual(audioConfig.data, audioDesc);
});
