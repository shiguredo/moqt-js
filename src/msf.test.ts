/**
 * MSF (MOQT Streaming Format) の単体テスト
 */

import { test, assert } from "vitest";
import {
  MSF_VERSION,
  CATALOG_TRACK_NAME,
  type Catalog,
  type CatalogTrack,
  type MediaTimelineEntry,
  type EventTimelineEntry,
  decodeCatalog,
  encodeMediaTimeline,
  decodeMediaTimeline,
  encodeEventTimeline,
  decodeEventTimeline,
  createCatalog,
  createCompleteCatalog,
  getVideoTracks,
  getAudioTracks,
  getTrackByName,
  getTracksByAltGroup,
  getTracksByRenderGroup,
  applyCatalogDelta,
  createInitialGroupId,
  selectTrackByMaxBitrate,
  selectTrackByMaxResolution,
  selectHighestBitrateTrack,
  selectLowestBitrateTrack,
} from "./msf";

// =============================================================================
// Catalog エラーケース
// =============================================================================

test("Catalog: 不正な version はエラー", () => {
  const invalidCatalog = { version: 2, tracks: [] };
  const encoded = new TextEncoder().encode(JSON.stringify(invalidCatalog));
  assert.throws(() => decodeCatalog(encoded), /invalid catalog format/);
});

test("Catalog: tracks が配列でない場合はエラー", () => {
  const invalidCatalog = { version: 1, tracks: "not an array" };
  const encoded = new TextEncoder().encode(JSON.stringify(invalidCatalog));
  assert.throws(() => decodeCatalog(encoded), /invalid catalog format/);
});

test("Catalog: トラックに必須フィールドがない場合はエラー", () => {
  const invalidCatalog = { version: 1, tracks: [{ name: "test" }] };
  const encoded = new TextEncoder().encode(JSON.stringify(invalidCatalog));
  assert.throws(() => decodeCatalog(encoded), /invalid catalog format/);
});

// =============================================================================
// Media Timeline
// =============================================================================

test("Media Timeline: 空配列のエンコード/デコード", () => {
  const entries: MediaTimelineEntry[] = [];
  const encoded = encodeMediaTimeline(entries);
  const decoded = decodeMediaTimeline(encoded);
  assert.deepStrictEqual(decoded, entries);
});

test("Media Timeline: 不正な形式はエラー", () => {
  const invalidData = new TextEncoder().encode('{"not": "an array"}');
  assert.throws(() => decodeMediaTimeline(invalidData), /invalid media timeline format/);
});

test("Media Timeline: 不正なエントリ形式はエラー", () => {
  const invalidData = new TextEncoder().encode("[[1, 2, 3]]");
  assert.throws(() => decodeMediaTimeline(invalidData), /invalid media timeline entry/);
});

// =============================================================================
// Event Timeline
// =============================================================================

test("Event Timeline: 空配列のエンコード/デコード", () => {
  const entries: EventTimelineEntry[] = [];
  const encoded = encodeEventTimeline(entries);
  const decoded = decodeEventTimeline(encoded);
  assert.deepStrictEqual(decoded, entries);
});

test("Event Timeline: 不正な形式はエラー", () => {
  const invalidData = new TextEncoder().encode('{"not": "an array"}');
  assert.throws(() => decodeEventTimeline(invalidData), /invalid event timeline format/);
});

test("Event Timeline: data がない場合はエラー", () => {
  const invalidData = new TextEncoder().encode('[{"t": 123}]');
  assert.throws(() => decodeEventTimeline(invalidData), /invalid event timeline entry/);
});

// =============================================================================
// createCatalog / createCompleteCatalog
// =============================================================================

test("createCatalog: オプションを含める", () => {
  const tracks: CatalogTrack[] = [{ name: "test", packaging: "loc", isLive: true }];
  const catalog = createCatalog(tracks, { generatedAt: 123456, isComplete: false });

  assert.strictEqual(catalog.version, MSF_VERSION);
  assert.strictEqual(catalog.generatedAt, 123456);
  assert.strictEqual(catalog.isComplete, false);
});

test("createCompleteCatalog: 配信完了 Catalog を生成する", () => {
  const catalog = createCompleteCatalog();
  assert.strictEqual(catalog.version, MSF_VERSION);
  assert.deepStrictEqual(catalog.tracks, []);
  assert.strictEqual(catalog.isComplete, true);
});

// =============================================================================
// トラック検索
// =============================================================================

test("getVideoTracks: ビデオトラックのみを返す", () => {
  const catalog: Catalog = {
    version: MSF_VERSION,
    tracks: [
      { name: "video1", packaging: "loc", isLive: true, role: "video" },
      { name: "audio1", packaging: "loc", isLive: true, role: "audio" },
      { name: "video2", packaging: "loc", isLive: true, role: "video" },
    ],
  };

  const videoTracks = getVideoTracks(catalog);
  assert.strictEqual(videoTracks.length, 2);
  assert.isTrue(videoTracks.every((t) => t.role === "video"));
});

test("getAudioTracks: オーディオトラックのみを返す", () => {
  const catalog: Catalog = {
    version: MSF_VERSION,
    tracks: [
      { name: "video1", packaging: "loc", isLive: true, role: "video" },
      { name: "audio1", packaging: "loc", isLive: true, role: "audio" },
      { name: "audio2", packaging: "loc", isLive: true, role: "audio" },
    ],
  };

  const audioTracks = getAudioTracks(catalog);
  assert.strictEqual(audioTracks.length, 2);
  assert.isTrue(audioTracks.every((t) => t.role === "audio"));
});

test("getTrackByName: 名前でトラックを検索する", () => {
  const catalog: Catalog = {
    version: MSF_VERSION,
    tracks: [
      { name: "video", packaging: "loc", isLive: true },
      { name: "audio", packaging: "loc", isLive: true },
    ],
  };

  const track = getTrackByName(catalog, "video");
  assert.isDefined(track);
  assert.strictEqual(track?.name, "video");

  const notFound = getTrackByName(catalog, "nonexistent");
  assert.isUndefined(notFound);
});

test("getTracksByAltGroup: altGroup でトラックを検索する", () => {
  const catalog: Catalog = {
    version: MSF_VERSION,
    tracks: [
      { name: "hd", packaging: "loc", isLive: true, altGroup: 1 },
      { name: "sd", packaging: "loc", isLive: true, altGroup: 1 },
      { name: "audio", packaging: "loc", isLive: true, altGroup: 2 },
    ],
  };

  const group1 = getTracksByAltGroup(catalog, 1);
  assert.strictEqual(group1.length, 2);
  assert.isTrue(group1.every((t) => t.altGroup === 1));
});

test("getTracksByRenderGroup: renderGroup でトラックを検索する", () => {
  const catalog: Catalog = {
    version: MSF_VERSION,
    tracks: [
      { name: "video", packaging: "loc", isLive: true, renderGroup: 1 },
      { name: "audio", packaging: "loc", isLive: true, renderGroup: 1 },
      { name: "caption", packaging: "loc", isLive: true, renderGroup: 2 },
    ],
  };

  const group1 = getTracksByRenderGroup(catalog, 1);
  assert.strictEqual(group1.length, 2);
  assert.isTrue(group1.every((t) => t.renderGroup === 1));
});

test("CATALOG_TRACK_NAME: 定数が正しい", () => {
  assert.strictEqual(CATALOG_TRACK_NAME, "catalog");
});

// =============================================================================
// Catalog 差分更新
// =============================================================================

test("applyCatalogDelta: deltaUpdate が false の場合はそのまま置き換え", () => {
  const current: Catalog = {
    version: MSF_VERSION,
    tracks: [{ name: "old", packaging: "loc", isLive: true }],
  };

  const delta: Catalog = {
    version: MSF_VERSION,
    tracks: [{ name: "new", packaging: "loc", isLive: true }],
    deltaUpdate: false,
  };

  const result = applyCatalogDelta(current, delta);
  assert.strictEqual(result.tracks.length, 1);
  assert.strictEqual(result.tracks[0].name, "new");
});

test("applyCatalogDelta: deltaUpdate が undefined の場合はそのまま置き換え", () => {
  const current: Catalog = {
    version: MSF_VERSION,
    tracks: [{ name: "old", packaging: "loc", isLive: true }],
  };

  const delta: Catalog = {
    version: MSF_VERSION,
    tracks: [{ name: "new", packaging: "loc", isLive: true }],
  };

  const result = applyCatalogDelta(current, delta);
  assert.strictEqual(result.tracks.length, 1);
  assert.strictEqual(result.tracks[0].name, "new");
});

test("applyCatalogDelta: addTracks でトラックを追加", () => {
  const current: Catalog = {
    version: MSF_VERSION,
    tracks: [{ name: "video", packaging: "loc", isLive: true }],
  };

  const delta: Catalog = {
    version: MSF_VERSION,
    tracks: [],
    deltaUpdate: true,
    addTracks: [{ name: "audio", packaging: "loc", isLive: true }],
  };

  const result = applyCatalogDelta(current, delta);
  assert.strictEqual(result.tracks.length, 2);
  assert.strictEqual(result.tracks[0].name, "video");
  assert.strictEqual(result.tracks[1].name, "audio");
});

test("applyCatalogDelta: removeTracks でトラックを削除", () => {
  const current: Catalog = {
    version: MSF_VERSION,
    tracks: [
      { name: "video", packaging: "loc", isLive: true },
      { name: "audio", packaging: "loc", isLive: true },
    ],
  };

  const delta: Catalog = {
    version: MSF_VERSION,
    tracks: [],
    deltaUpdate: true,
    removeTracks: ["audio"],
  };

  const result = applyCatalogDelta(current, delta);
  assert.strictEqual(result.tracks.length, 1);
  assert.strictEqual(result.tracks[0].name, "video");
});

test("applyCatalogDelta: cloneTracks でトラックを複製", () => {
  const current: Catalog = {
    version: MSF_VERSION,
    tracks: [
      { name: "video", packaging: "loc", isLive: true, codec: "av1", width: 1920, height: 1080 },
    ],
  };

  const delta: Catalog = {
    version: MSF_VERSION,
    tracks: [],
    deltaUpdate: true,
    cloneTracks: [
      {
        name: "video-sd",
        packaging: "loc",
        isLive: true,
        depends: ["video"],
        width: 640,
        height: 480,
      },
    ],
  };

  const result = applyCatalogDelta(current, delta);
  assert.strictEqual(result.tracks.length, 2);
  assert.strictEqual(result.tracks[1].name, "video-sd");
  assert.strictEqual(result.tracks[1].codec, "av1");
  assert.strictEqual(result.tracks[1].width, 640);
  assert.strictEqual(result.tracks[1].height, 480);
});

test("applyCatalogDelta: 複合操作 (remove + add)", () => {
  const current: Catalog = {
    version: MSF_VERSION,
    tracks: [
      { name: "video-hd", packaging: "loc", isLive: true },
      { name: "audio", packaging: "loc", isLive: true },
    ],
  };

  const delta: Catalog = {
    version: MSF_VERSION,
    tracks: [],
    deltaUpdate: true,
    removeTracks: ["video-hd"],
    addTracks: [{ name: "video-sd", packaging: "loc", isLive: true }],
  };

  const result = applyCatalogDelta(current, delta);
  assert.strictEqual(result.tracks.length, 2);
  assert.isTrue(result.tracks.some((t) => t.name === "audio"));
  assert.isTrue(result.tracks.some((t) => t.name === "video-sd"));
  assert.isFalse(result.tracks.some((t) => t.name === "video-hd"));
});

// =============================================================================
// Group 番号付け
// =============================================================================

test("createInitialGroupId: Unix ms ベースの bigint を返す", () => {
  const before = BigInt(Date.now());
  const groupId = createInitialGroupId();
  const after = BigInt(Date.now());

  assert.isTrue(groupId >= before);
  assert.isTrue(groupId <= after);
});

// =============================================================================
// ABR トラック選択
// =============================================================================

test("selectTrackByMaxBitrate: 指定ビットレート以下で最大を選択", () => {
  const tracks: CatalogTrack[] = [
    { name: "hd", packaging: "loc", isLive: true, bitrate: 5000000 },
    { name: "sd", packaging: "loc", isLive: true, bitrate: 1000000 },
    { name: "ld", packaging: "loc", isLive: true, bitrate: 500000 },
  ];

  const result = selectTrackByMaxBitrate(tracks, 2000000);
  assert.isDefined(result);
  assert.strictEqual(result?.name, "sd");
});

test("selectTrackByMaxBitrate: 該当なしの場合は undefined", () => {
  const tracks: CatalogTrack[] = [{ name: "hd", packaging: "loc", isLive: true, bitrate: 5000000 }];

  const result = selectTrackByMaxBitrate(tracks, 1000000);
  assert.isUndefined(result);
});

test("selectTrackByMaxBitrate: bitrate がないトラックはスキップ", () => {
  const tracks: CatalogTrack[] = [
    { name: "hd", packaging: "loc", isLive: true },
    { name: "sd", packaging: "loc", isLive: true, bitrate: 1000000 },
  ];

  const result = selectTrackByMaxBitrate(tracks, 2000000);
  assert.isDefined(result);
  assert.strictEqual(result?.name, "sd");
});

test("selectTrackByMaxResolution: 指定解像度以下で最大を選択", () => {
  const tracks: CatalogTrack[] = [
    { name: "4k", packaging: "loc", isLive: true, width: 3840, height: 2160 },
    { name: "hd", packaging: "loc", isLive: true, width: 1920, height: 1080 },
    { name: "sd", packaging: "loc", isLive: true, width: 640, height: 480 },
  ];

  const result = selectTrackByMaxResolution(tracks, 1920, 1080);
  assert.isDefined(result);
  assert.strictEqual(result?.name, "hd");
});

test("selectTrackByMaxResolution: 該当なしの場合は undefined", () => {
  const tracks: CatalogTrack[] = [
    { name: "4k", packaging: "loc", isLive: true, width: 3840, height: 2160 },
  ];

  const result = selectTrackByMaxResolution(tracks, 1920, 1080);
  assert.isUndefined(result);
});

test("selectHighestBitrateTrack: altGroup 内で最高ビットレートを選択", () => {
  const catalog: Catalog = {
    version: MSF_VERSION,
    tracks: [
      { name: "hd", packaging: "loc", isLive: true, altGroup: 1, bitrate: 5000000 },
      { name: "sd", packaging: "loc", isLive: true, altGroup: 1, bitrate: 1000000 },
      { name: "audio", packaging: "loc", isLive: true, altGroup: 2, bitrate: 128000 },
    ],
  };

  const result = selectHighestBitrateTrack(catalog, 1);
  assert.isDefined(result);
  assert.strictEqual(result?.name, "hd");
});

test("selectLowestBitrateTrack: altGroup 内で最低ビットレートを選択", () => {
  const catalog: Catalog = {
    version: MSF_VERSION,
    tracks: [
      { name: "hd", packaging: "loc", isLive: true, altGroup: 1, bitrate: 5000000 },
      { name: "sd", packaging: "loc", isLive: true, altGroup: 1, bitrate: 1000000 },
      { name: "audio", packaging: "loc", isLive: true, altGroup: 2, bitrate: 128000 },
    ],
  };

  const result = selectLowestBitrateTrack(catalog, 1);
  assert.isDefined(result);
  assert.strictEqual(result?.name, "sd");
});

test("selectHighestBitrateTrack: altGroup が存在しない場合は undefined", () => {
  const catalog: Catalog = {
    version: MSF_VERSION,
    tracks: [{ name: "video", packaging: "loc", isLive: true, altGroup: 1, bitrate: 5000000 }],
  };

  const result = selectHighestBitrateTrack(catalog, 99);
  assert.isUndefined(result);
});
