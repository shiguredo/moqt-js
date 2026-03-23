/**
 * MSF (MOQT Streaming Format) の PBT テスト
 */

import { test, assert } from "vitest";
import * as fc from "fast-check";
import {
  MSF_VERSION,
  CATALOG_TRACK_NAME,
  type Catalog,
  type CatalogTrack,
  type CatalogDelta,
  type MediaTimelineEntry,
  type EventTimelineEntry,
  encodeCatalog,
  decodeCatalogMessage,
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
  nextGroupId,
  selectTrackByMaxBitrate,
  selectTrackByMaxResolution,
  selectHighestBitrateTrack,
  selectLowestBitrateTrack,
} from "./msf";

// =============================================================================
// Arbitrary 定義
// =============================================================================

/**
 * パッケージング形式の Arbitrary
 */
const packagingArb = fc.constantFrom("loc", "mediatimeline", "eventtimeline") as fc.Arbitrary<
  "loc" | "mediatimeline" | "eventtimeline"
>;

/**
 * トラックロールの Arbitrary
 */
const roleArb = fc.constantFrom("video", "audio", "caption", "metadata");

/**
 * CatalogTrack の Arbitrary
 */
const catalogTrackArb: fc.Arbitrary<CatalogTrack> = fc.record({
  name: fc.string({ minLength: 1, maxLength: 32 }),
  packaging: packagingArb,
  isLive: fc.boolean(),
  namespace: fc.option(fc.string({ maxLength: 32 }), { nil: undefined }),
  targetLatency: fc.option(fc.nat({ max: 10000 }), { nil: undefined }),
  role: fc.option(roleArb, { nil: undefined }),
  label: fc.option(fc.string({ maxLength: 64 }), { nil: undefined }),
  renderGroup: fc.option(fc.nat({ max: 100 }), { nil: undefined }),
  altGroup: fc.option(fc.nat({ max: 100 }), { nil: undefined }),
  codec: fc.option(fc.string({ maxLength: 64 }), { nil: undefined }),
  mimeType: fc.option(fc.string({ maxLength: 64 }), { nil: undefined }),
  framerate: fc.option(fc.nat({ max: 120 }), { nil: undefined }),
  timescale: fc.option(fc.nat({ max: 1_000_000 }), { nil: undefined }),
  bitrate: fc.option(fc.nat({ max: 100_000_000 }), { nil: undefined }),
  width: fc.option(fc.nat({ max: 7680 }), { nil: undefined }),
  height: fc.option(fc.nat({ max: 4320 }), { nil: undefined }),
  displayWidth: fc.option(fc.nat({ max: 7680 }), { nil: undefined }),
  displayHeight: fc.option(fc.nat({ max: 4320 }), { nil: undefined }),
  samplerate: fc.option(fc.constantFrom(44100, 48000, 96000), { nil: undefined }),
  channelConfig: fc.option(fc.constantFrom("1", "2", "5.1", "7.1"), { nil: undefined }),
  lang: fc.option(fc.constantFrom("en", "ja", "zh", "ko", "es", "fr", "de"), { nil: undefined }),
  parentName: fc.option(fc.string({ maxLength: 32 }), { nil: undefined }),
  trackDuration: fc.option(fc.nat({ max: 86400000 }), { nil: undefined }),
  eventType: fc.option(fc.string({ maxLength: 64 }), { nil: undefined }),
});

/**
 * Catalog の Arbitrary
 */
const catalogArb: fc.Arbitrary<Catalog> = fc.record({
  version: fc.constant(MSF_VERSION as typeof MSF_VERSION),
  tracks: fc.array(catalogTrackArb, { minLength: 1, maxLength: 10 }),
  generatedAt: fc.option(fc.nat({ max: Date.now() + 86400000 }), { nil: undefined }),
  isComplete: fc.option(fc.boolean(), { nil: undefined }),
});

/**
 * 非負の bigint を生成する Arbitrary
 */
const bigUintArb = fc.bigInt({ min: 0n, max: BigInt(Number.MAX_SAFE_INTEGER) });

/**
 * Media Timeline エントリの Arbitrary
 */
const mediaTimelineEntryArb: fc.Arbitrary<MediaTimelineEntry> = fc.tuple(
  fc.nat({ max: 86400000 }),
  fc.tuple(bigUintArb, bigUintArb),
  fc.nat({ max: Date.now() + 86400000 }),
);

/**
 * Event Timeline エントリの Arbitrary
 */
const eventTimelineEntryArb: fc.Arbitrary<EventTimelineEntry> = fc.record({
  t: fc.option(fc.nat({ max: Date.now() + 86400000 }), { nil: undefined }),
  l: fc.option(fc.tuple(bigUintArb, bigUintArb), { nil: undefined }),
  m: fc.option(fc.nat({ max: 86400000 }), { nil: undefined }),
  data: fc.oneof(
    fc.object({
      key: fc.string({ maxLength: 16 }),
      values: [fc.string(), fc.nat(), fc.boolean()],
      maxDepth: 1,
      maxKeys: 5,
    }),
    fc.array(fc.oneof(fc.nat(), fc.string(), fc.boolean()), { maxLength: 5 }),
    fc.string(),
    fc.nat(),
  ) as fc.Arbitrary<unknown>,
});

// =============================================================================
// Catalog テスト
// =============================================================================

test("Catalog: エンコード/デコードのラウンドトリップ", () => {
  fc.assert(
    fc.property(catalogArb, (catalog) => {
      const encoded = encodeCatalog(catalog);
      const decoded = decodeCatalogMessage(encoded);

      // JSON は undefined を保持しないため、同じ JSON 文字列になることを確認
      assert.strictEqual(JSON.stringify(decoded), JSON.stringify(catalog));
    }),
  );
});

test("Catalog: エンコード結果は有効な JSON", () => {
  fc.assert(
    fc.property(catalogArb, (catalog) => {
      const encoded = encodeCatalog(catalog);
      const json = new TextDecoder().decode(encoded);
      assert.doesNotThrow(() => JSON.parse(json));
    }),
  );
});

test("Catalog: version は常に MSF_VERSION", () => {
  fc.assert(
    fc.property(catalogArb, (catalog) => {
      const encoded = encodeCatalog(catalog);
      const decoded = decodeCatalogMessage(encoded) as Catalog;
      assert.strictEqual(decoded.version, MSF_VERSION);
    }),
  );
});

test("Catalog: 不正な version はエラー", () => {
  const invalidCatalog = { version: 2, tracks: [] };
  const encoded = new TextEncoder().encode(JSON.stringify(invalidCatalog));
  assert.throws(() => decodeCatalogMessage(encoded), /invalid catalog format/);
});

test("Catalog: tracks が配列でない場合はエラー", () => {
  const invalidCatalog = { version: 1, tracks: "not an array" };
  const encoded = new TextEncoder().encode(JSON.stringify(invalidCatalog));
  assert.throws(() => decodeCatalogMessage(encoded), /invalid catalog format/);
});

test("Catalog: トラックに必須フィールドがない場合はエラー", () => {
  const invalidCatalog = { version: 1, tracks: [{ name: "test" }] };
  const encoded = new TextEncoder().encode(JSON.stringify(invalidCatalog));
  assert.throws(() => decodeCatalogMessage(encoded), /invalid catalog format/);
});

// =============================================================================
// Media Timeline テスト
// =============================================================================

test("Media Timeline: エンコード/デコードのラウンドトリップ", () => {
  fc.assert(
    fc.property(fc.array(mediaTimelineEntryArb, { maxLength: 100 }), (entries) => {
      const encoded = encodeMediaTimeline(entries);
      const decoded = decodeMediaTimeline(encoded);
      assert.deepStrictEqual(decoded, entries);
    }),
  );
});

test("Media Timeline: 空配列のエンコード/デコード", () => {
  const entries: MediaTimelineEntry[] = [];
  const encoded = encodeMediaTimeline(entries);
  const decoded = decodeMediaTimeline(encoded);
  assert.deepStrictEqual(decoded, entries);
});

test("Media Timeline: 不正な形式はエラー", () => {
  // 有効な JSON だが配列ではない
  const invalidData = new TextEncoder().encode('{"not": "an array"}');
  assert.throws(() => decodeMediaTimeline(invalidData), /invalid media timeline format/);
});

test("Media Timeline: 不正なエントリ形式はエラー", () => {
  const invalidData = new TextEncoder().encode("[[1, 2, 3]]");
  assert.throws(() => decodeMediaTimeline(invalidData), /invalid media timeline entry/);
});

// =============================================================================
// Event Timeline テスト
// =============================================================================

test("Event Timeline: エンコード/デコードのラウンドトリップ", () => {
  fc.assert(
    fc.property(fc.array(eventTimelineEntryArb, { maxLength: 100 }), (entries) => {
      const encoded = encodeEventTimeline(entries);
      const decoded = decodeEventTimeline(encoded);

      // 各エントリを比較
      assert.strictEqual(decoded.length, entries.length);
      for (let i = 0; i < entries.length; i++) {
        const original = entries[i];
        const result = decoded[i];

        // data を比較
        assert.deepStrictEqual(result.data, original.data);

        // t を比較 (undefined は JSON で保持されない)
        if (original.t !== undefined) {
          assert.strictEqual(result.t, original.t);
        }

        // m を比較
        if (original.m !== undefined) {
          assert.strictEqual(result.m, original.m);
        }

        // l を比較 (bigint は number に変換される)
        if (original.l !== undefined) {
          assert.isDefined(result.l);
          assert.strictEqual(result.l![0], original.l[0]);
          assert.strictEqual(result.l![1], original.l[1]);
        }
      }
    }),
  );
});

test("Event Timeline: 空配列のエンコード/デコード", () => {
  const entries: EventTimelineEntry[] = [];
  const encoded = encodeEventTimeline(entries);
  const decoded = decodeEventTimeline(encoded);
  assert.deepStrictEqual(decoded, entries);
});

test("Event Timeline: 不正な形式はエラー", () => {
  // 有効な JSON だが配列ではない
  const invalidData = new TextEncoder().encode('{"not": "an array"}');
  assert.throws(() => decodeEventTimeline(invalidData), /invalid event timeline format/);
});

test("Event Timeline: data がない場合はエラー", () => {
  const invalidData = new TextEncoder().encode('[{"t": 123}]');
  assert.throws(() => decodeEventTimeline(invalidData), /invalid event timeline entry/);
});

// =============================================================================
// ヘルパー関数テスト
// =============================================================================

test("createCatalog: 正しい構造を生成する", () => {
  fc.assert(
    fc.property(fc.array(catalogTrackArb, { minLength: 1, maxLength: 5 }), (tracks) => {
      const catalog = createCatalog(tracks);
      assert.strictEqual(catalog.version, MSF_VERSION);
      assert.deepStrictEqual(catalog.tracks, tracks);
    }),
  );
});

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
// Catalog 差分更新テスト
// =============================================================================

test("applyCatalogDelta: addTracks でトラックを追加", () => {
  const current: Catalog = {
    version: MSF_VERSION,
    tracks: [{ name: "video", packaging: "loc", isLive: true }],
  };

  const delta: CatalogDelta = {
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

  const delta: CatalogDelta = {
    deltaUpdate: true,
    removeTracks: [{ name: "audio" }],
  };

  const result = applyCatalogDelta(current, delta);
  assert.strictEqual(result.tracks.length, 1);
  assert.strictEqual(result.tracks[0].name, "video");
});

test("applyCatalogDelta: cloneTracks で parentName を使用して複製", () => {
  const current: Catalog = {
    version: MSF_VERSION,
    tracks: [
      { name: "video", packaging: "loc", isLive: true, codec: "av1", width: 1920, height: 1080 },
    ],
  };

  const delta: CatalogDelta = {
    deltaUpdate: true,
    cloneTracks: [
      {
        name: "video-sd",
        packaging: "loc",
        isLive: true,
        parentName: "video",
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

  const delta: CatalogDelta = {
    deltaUpdate: true,
    removeTracks: [{ name: "video-hd" }],
    addTracks: [{ name: "video-sd", packaging: "loc", isLive: true }],
  };

  const result = applyCatalogDelta(current, delta);
  assert.strictEqual(result.tracks.length, 2);
  assert.isTrue(result.tracks.some((t) => t.name === "audio"));
  assert.isTrue(result.tracks.some((t) => t.name === "video-sd"));
  assert.isFalse(result.tracks.some((t) => t.name === "video-hd"));
});

// =============================================================================
// Group 番号付けテスト
// =============================================================================

test("createInitialGroupId: Unix ms ベースの bigint を返す", () => {
  const before = BigInt(Date.now());
  const groupId = createInitialGroupId();
  const after = BigInt(Date.now());

  assert.isTrue(groupId >= before);
  assert.isTrue(groupId <= after);
});

test("nextGroupId: 1 増加する", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: BigInt(Number.MAX_SAFE_INTEGER) - 1n }), (current) => {
      const next = nextGroupId(current);
      assert.strictEqual(next, current + 1n);
    }),
  );
});

// =============================================================================
// ABR トラック選択テスト
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

// =============================================================================
// 仕様書 Section 5.2 の Catalog 例の検証テスト
// =============================================================================

test("仕様書例: Time-aligned Audio/Video Tracks with single quality", () => {
  // refs/moq/draft-ietf-moq-msf.md Section 5.2.1
  const catalogJson = `{
    "version": 1,
    "generatedAt": 1746104606044,
    "tracks": [
      {
        "name": "1080p-video",
        "namespace": "conference.example.com/conference123/alice",
        "packaging": "loc",
        "isLive": true,
        "targetLatency": 2000,
        "role": "video",
        "renderGroup": 1,
        "codec":"av01.0.08M.10.0.110.09",
        "width":1920,
        "height":1080,
        "framerate":30,
        "bitrate":1500000
      },
      {
        "name": "audio",
        "namespace": "conference.example.com/conference123/alice",
        "packaging": "loc",
        "isLive": true,
        "targetLatency": 2000,
        "role": "audio",
        "renderGroup": 1,
        "codec":"opus",
        "samplerate":48000,
        "channelConfig":"2",
        "bitrate":32000
      }
    ]
  }`;

  const data = new TextEncoder().encode(catalogJson);
  const catalog = decodeCatalogMessage(data) as Catalog;

  assert.strictEqual(catalog.version, MSF_VERSION);
  assert.strictEqual(catalog.tracks.length, 2);

  // 同じ renderGroup を持つトラックは時間整列されている
  const renderGroup1 = getTracksByRenderGroup(catalog, 1);
  assert.strictEqual(renderGroup1.length, 2);

  // 同じ targetLatency を持つべき
  const latencies = renderGroup1.map((t) => t.targetLatency);
  assert.isTrue(latencies.every((l) => l === latencies[0]));
});

test("仕様書例: Simulcast video tracks - 3 alternate qualities", () => {
  // refs/moq/draft-ietf-moq-msf.md Section 5.2.2
  const catalogJson = `{
    "version": 1,
    "generatedAt": 1746104606044,
    "tracks":[
      {
        "name": "hd",
        "renderGroup": 1,
        "packaging": "loc",
        "isLive": true,
        "targetLatency": 1500,
        "role": "video",
        "codec":"av01",
        "width":1920,
        "height":1080,
        "bitrate":5000000,
        "framerate":30,
        "altGroup":1
      },
      {
        "name": "md",
        "renderGroup": 1,
        "packaging": "loc",
        "isLive": true,
        "targetLatency": 1500,
        "role": "video",
        "codec":"av01",
        "width":720,
        "height":640,
        "bitrate":3000000,
        "framerate":30,
        "altGroup":1
      },
      {
        "name": "sd",
        "renderGroup": 1,
        "packaging": "loc",
        "isLive": true,
        "targetLatency": 1500,
        "role": "video",
        "codec":"av01",
        "width":192,
        "height":144,
        "bitrate":500000,
        "framerate":30,
        "altGroup":1
      },
      {
        "name": "audio",
        "renderGroup": 1,
        "packaging": "loc",
        "isLive": true,
        "targetLatency": 1500,
        "role": "audio",
        "codec":"opus",
        "samplerate":48000,
        "channelConfig":"2",
        "bitrate":32000
      }
    ]
  }`;

  const data = new TextEncoder().encode(catalogJson);
  const catalog = decodeCatalogMessage(data) as Catalog;

  assert.strictEqual(catalog.version, MSF_VERSION);
  assert.strictEqual(catalog.tracks.length, 4);

  // altGroup 1 のトラック（ビデオのみ）
  const altGroup1 = getTracksByAltGroup(catalog, 1);
  assert.strictEqual(altGroup1.length, 3);

  // 同じ altGroup のトラックは同一 targetLatency を持つべき
  const latencies = altGroup1.map((t) => t.targetLatency);
  assert.isTrue(latencies.every((l) => l === latencies[0]));

  // ABR: 最高ビットレートは hd
  const highest = selectHighestBitrateTrack(catalog, 1);
  assert.isDefined(highest);
  assert.strictEqual(highest?.name, "hd");

  // ABR: 最低ビットレートは sd
  const lowest = selectLowestBitrateTrack(catalog, 1);
  assert.isDefined(lowest);
  assert.strictEqual(lowest?.name, "sd");
});

test("仕様書例: SVC video tracks with dependencies", () => {
  // refs/moq/draft-ietf-moq-msf.md Section 5.2.3
  const catalogJson = `{
    "version": 1,
    "generatedAt": 1746104606044,
    "tracks":[
      {
        "name": "480p15",
        "namespace": "conference.example.com/conference123/alice",
        "renderGroup": 1,
        "packaging": "loc",
        "isLive": true,
        "role": "video",
        "codec":"av01.0.01M.10.0.110.09",
        "width":640,
        "height":480,
        "bitrate":3000000,
        "framerate":15
      },
      {
        "name": "480p30",
        "namespace": "conference.example.com/conference123/alice",
        "renderGroup": 1,
        "packaging": "loc",
        "isLive": true,
        "role": "video",
        "codec":"av01.0.04M.10.0.110.09",
        "width":640,
        "height":480,
        "bitrate":3000000,
        "framerate":30,
        "depends": ["480p15"]
      },
      {
        "name": "1080p15",
        "namespace": "conference.example.com/conference123/alice",
        "renderGroup": 1,
        "packaging": "loc",
        "isLive": true,
        "role": "video",
        "codec":"av01.0.05M.10.0.110.09",
        "width":1920,
        "height":1080,
        "bitrate":3000000,
        "framerate":15,
        "depends":["480p15"]
      },
      {
        "name": "1080p30",
        "namespace": "conference.example.com/conference123/alice",
        "renderGroup": 1,
        "packaging": "loc",
        "isLive": true,
        "role": "video",
        "codec":"av01.0.08M.10.0.110.09",
        "width":1920,
        "height":1080,
        "bitrate":5000000,
        "framerate":30,
        "depends": ["480p30", "1080p15"]
      },
      {
        "name": "audio",
        "namespace": "conference.example.com/conference123/alice",
        "renderGroup": 1,
        "packaging": "loc",
        "isLive": true,
        "role": "audio",
        "codec":"opus",
        "samplerate":48000,
        "channelConfig":"2",
        "bitrate":32000
      }
    ]
  }`;

  const data = new TextEncoder().encode(catalogJson);
  const catalog = decodeCatalogMessage(data) as Catalog;

  assert.strictEqual(catalog.version, MSF_VERSION);
  assert.strictEqual(catalog.tracks.length, 5);

  // 依存関係の検証
  const track480p30 = getTrackByName(catalog, "480p30");
  assert.isDefined(track480p30);
  assert.deepStrictEqual(track480p30?.depends, ["480p15"]);

  const track1080p30 = getTrackByName(catalog, "1080p30");
  assert.isDefined(track1080p30);
  assert.deepStrictEqual(track1080p30?.depends, ["480p30", "1080p15"]);
});

test("仕様書例: Delta update - adding tracks", () => {
  // draft-ietf-moq-msf-00 Section 5.3.4
  const delta: CatalogDelta = {
    deltaUpdate: true,
    generatedAt: 1746104606044,
    addTracks: [
      {
        name: "slides",
        isLive: true,
        packaging: "loc",
        role: "video",
        codec: "av01.0.08M.10.0.110.09",
        width: 1920,
        height: 1080,
        framerate: 15,
        bitrate: 750000,
        renderGroup: 1,
      },
    ],
    cloneTracks: [
      {
        name: "video-720",
        packaging: "loc",
        isLive: true,
        parentName: "video-1080",
        width: 1280,
        height: 720,
        bitrate: 600000,
      },
    ],
  };

  // 現在の Catalog
  const current: Catalog = {
    version: MSF_VERSION,
    tracks: [
      {
        name: "video-1080",
        packaging: "loc",
        isLive: true,
        codec: "av01.0.08M.10.0.110.09",
        width: 1920,
        height: 1080,
        bitrate: 1500000,
      },
    ],
  };

  const result = applyCatalogDelta(current, delta);

  // addTracks で slides が追加されている
  assert.isTrue(result.tracks.some((t) => t.name === "slides"));

  // cloneTracks で video-720 が追加されている (video-1080 からクローン)
  const video720 = getTrackByName(result, "video-720");
  assert.isDefined(video720);
  assert.strictEqual(video720?.width, 1280);
  assert.strictEqual(video720?.height, 720);
  assert.strictEqual(video720?.bitrate, 600000);
  // ベーストラックの codec を継承
  assert.strictEqual(video720?.codec, "av01.0.08M.10.0.110.09");
});

test("仕様書例: Delta update - removing tracks", () => {
  // draft-ietf-moq-msf-00 Section 5.3.5
  const delta: CatalogDelta = {
    deltaUpdate: true,
    generatedAt: 1746104606044,
    removeTracks: [{ name: "video" }, { name: "slides" }],
  };

  const current: Catalog = {
    version: MSF_VERSION,
    tracks: [
      { name: "video", packaging: "loc", isLive: true },
      { name: "audio", packaging: "loc", isLive: true },
      { name: "slides", packaging: "loc", isLive: true },
    ],
  };

  const result = applyCatalogDelta(current, delta);

  assert.strictEqual(result.tracks.length, 1);
  assert.strictEqual(result.tracks[0].name, "audio");
  assert.isFalse(result.tracks.some((t) => t.name === "video"));
  assert.isFalse(result.tracks.some((t) => t.name === "slides"));
});

test("仕様書例: VOD Audio/Video Tracks", () => {
  // refs/moq/draft-ietf-moq-msf.md Section 5.2.7
  const catalogJson = `{
    "version": 1,
    "tracks": [
      {
        "name": "video",
        "namespace": "movies.example.com/assets/boy-meets-girl-season3/episode5",
        "packaging": "loc",
        "isLive": false,
        "trackDuration": 8072340,
        "renderGroup": 1,
        "codec":"av01.0.08M.10.0.110.09",
        "width":1920,
        "height":1080,
        "framerate":30,
        "bitrate":1500000
      },
      {
        "name": "audio",
        "namespace": "movies.example.com/assets/boy-meets-girl-season3/episode5",
        "packaging": "loc",
        "isLive": false,
        "trackDuration": 8072340,
        "renderGroup": 1,
        "codec":"opus",
        "samplerate":48000,
        "channelConfig":"2",
        "bitrate":32000
      }
    ]
  }`;

  const data = new TextEncoder().encode(catalogJson);
  const catalog = decodeCatalogMessage(data) as Catalog;

  assert.strictEqual(catalog.version, MSF_VERSION);
  assert.strictEqual(catalog.tracks.length, 2);

  // VOD なので isLive は false
  assert.isTrue(catalog.tracks.every((t) => t.isLive === false));

  // trackDuration が設定されている
  assert.isTrue(catalog.tracks.every((t) => t.trackDuration === 8072340));

  // VOD には generatedAt がない
  assert.isUndefined(catalog.generatedAt);
});

test("Delta Updates: 操作の順序 (removeTracks → addTracks → cloneTracks)", () => {
  // 同名のトラックを削除してから追加する場合
  const current: Catalog = {
    version: MSF_VERSION,
    tracks: [
      { name: "video", packaging: "loc", isLive: true, bitrate: 1000000 },
      { name: "audio", packaging: "loc", isLive: true },
    ],
  };

  const delta: CatalogDelta = {
    deltaUpdate: true,
    removeTracks: [{ name: "video" }],
    addTracks: [{ name: "video", packaging: "loc", isLive: true, bitrate: 2000000 }],
  };

  const result = applyCatalogDelta(current, delta);

  // video は新しいビットレートで存在するべき
  const videoTrack = getTrackByName(result, "video");
  assert.isDefined(videoTrack);
  assert.strictEqual(videoTrack?.bitrate, 2000000);
});

// =============================================================================
// Event Timeline の制約テスト
// =============================================================================

test("Event Timeline: t, l, m のインデックス参照を持つエントリ", () => {
  // 壁時計時間でインデックス
  const entriesWithT: EventTimelineEntry[] = [
    { t: 1756885678361, data: { status: "in_progress" } },
    { t: 1756885981542, data: { status: "completed" } },
  ];

  const encodedT = encodeEventTimeline(entriesWithT);
  const decodedT = decodeEventTimeline(encodedT);

  assert.strictEqual(decodedT.length, 2);
  assert.strictEqual(decodedT[0].t, 1756885678361);
  assert.isUndefined(decodedT[0].l);
  assert.isUndefined(decodedT[0].m);

  // Location でインデックス
  const entriesWithL: EventTimelineEntry[] = [
    { l: [0n, 0n], data: { coords: [47.1812, 8.4592] } },
    { l: [1n, 0n], data: { coords: [47.1662, 8.5155] } },
  ];

  const encodedL = encodeEventTimeline(entriesWithL);
  const decodedL = decodeEventTimeline(encodedL);

  assert.strictEqual(decodedL.length, 2);
  assert.deepStrictEqual(decodedL[0].l, [0n, 0n]);
  assert.isUndefined(decodedL[0].t);
  assert.isUndefined(decodedL[0].m);

  // メディア PTS でインデックス
  const entriesWithM: EventTimelineEntry[] = [
    { m: 0, data: { marker: "start" } },
    { m: 5000, data: { marker: "chapter1" } },
  ];

  const encodedM = encodeEventTimeline(entriesWithM);
  const decodedM = decodeEventTimeline(encodedM);

  assert.strictEqual(decodedM.length, 2);
  assert.strictEqual(decodedM[0].m, 0);
  assert.isUndefined(decodedM[0].t);
  assert.isUndefined(decodedM[0].l);
});

test("Media Timeline: 仕様書例のエントリ形式を検証", () => {
  // 仕様書の例
  const timelineJson = `[
    [0, [0,0], 1759924158381],
    [2002, [1,0], 1759924160383],
    [4004, [2,0], 1759924162385],
    [6006, [3,0], 1759924164387],
    [8008, [4,0], 1759924166389]
  ]`;

  const data = new TextEncoder().encode(timelineJson);
  const entries = decodeMediaTimeline(data);

  assert.strictEqual(entries.length, 5);

  // 各エントリの構造を検証
  for (let i = 0; i < entries.length; i++) {
    const [mediaPts, [groupId, objectId], wallclock] = entries[i];

    // mediaPts は増加している
    assert.strictEqual(mediaPts, i * 2002);

    // groupId は順番に増加
    assert.strictEqual(groupId, BigInt(i));

    // objectId は 0
    assert.strictEqual(objectId, 0n);

    // wallclock は増加している
    assert.strictEqual(wallclock, 1759924158381 + i * 2002);
  }
});

test("ABR: ビットレート制約に基づく選択", () => {
  fc.assert(
    fc.property(
      fc.array(fc.nat({ max: 10000000 }), { minLength: 3, maxLength: 10 }),
      fc.nat({ max: 10000000 }),
      (bitrates, maxBitrate) => {
        const tracks: CatalogTrack[] = bitrates.map((bitrate, i) => ({
          name: `track-${i}`,
          packaging: "loc" as const,
          isLive: true,
          bitrate,
        }));

        const result = selectTrackByMaxBitrate(tracks, maxBitrate);

        if (result !== undefined) {
          // 選択されたトラックは maxBitrate 以下
          assert.isTrue((result.bitrate ?? 0) <= maxBitrate);

          // maxBitrate 以下の中で最大
          const eligibleBitrates = bitrates.filter((b) => b <= maxBitrate);
          if (eligibleBitrates.length > 0) {
            const maxEligible = Math.max(...eligibleBitrates);
            assert.strictEqual(result.bitrate, maxEligible);
          }
        } else {
          // undefined の場合、maxBitrate 以下のトラックがない
          assert.isTrue(bitrates.every((b) => b > maxBitrate));
        }
      },
    ),
  );
});
