/**
 * MSF (MOQT Streaming Format) の単体テスト
 */

import { test, assert } from "vite-plus/test";
import {
  MSF_VERSION,
  CATALOG_TRACK_NAME,
  type Catalog,
  type CatalogTrack,
  type CatalogDelta,
  type MediaTimelineEntry,
  type EventTimelineEntry,
  decodeCatalogMessage,
  encodeCatalog,
  encodeCatalogDelta,
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
// テスト用ヘルパー
// =============================================================================

/**
 * 任意のオブジェクトを JSON バイト列にエンコードする
 */
function encodeDeltaRaw(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

async function assertRejectsWithMessage(
  factory: () => Promise<unknown>,
  messagePattern: RegExp,
): Promise<void> {
  try {
    await factory();
    assert.fail("expected promise to reject");
  } catch (error) {
    assert.match((error as Error).message, messagePattern);
  }
}

// =============================================================================
// Catalog エンコード/デコード
// =============================================================================

test("Catalog: フルカタログのエンコード/デコード", () => {
  const catalog: Catalog = {
    version: MSF_VERSION,
    tracks: [{ name: "video", packaging: "loc", isLive: true }],
  };
  const encoded = encodeCatalog(catalog);
  const decoded = decodeCatalogMessage(encoded);
  assert.deepStrictEqual(decoded, catalog);
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
// CatalogDelta エンコード/デコード
// =============================================================================

test("CatalogDelta: addTracks のエンコード/デコード", () => {
  // draft-ietf-moq-msf-00 §5.2: Add/Delete/Clone 操作は宣言順で保持する
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "add", tracks: [{ name: "audio", packaging: "loc", isLive: true }] }],
  };
  const encoded = encodeCatalogDelta(delta);
  const decoded = decodeCatalogMessage(encoded);
  assert.deepStrictEqual(decoded, delta);
});

test("CatalogDelta: removeTracks のエンコード/デコード", () => {
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "remove", tracks: [{ name: "video" }, { name: "slides" }] }],
  };
  const encoded = encodeCatalogDelta(delta);
  const decoded = decodeCatalogMessage(encoded);
  assert.deepStrictEqual(decoded, delta);
});

test("CatalogDelta: removeTracks に namespace を含める", () => {
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "remove", tracks: [{ name: "video", namespace: "example.com/room1" }] }],
  };
  const encoded = encodeCatalogDelta(delta);
  const decoded = decodeCatalogMessage(encoded) as CatalogDelta;
  const removeOp = decoded.operations[0];
  assert.strictEqual(removeOp.type, "remove");
  if (removeOp.type === "remove") {
    assert.strictEqual(removeOp.tracks[0].namespace, "example.com/room1");
  }
});

test("CatalogDelta: version を含む場合はエラー", () => {
  const invalid = { deltaUpdate: true, version: 1, addTracks: [] };
  assert.throws(
    () => decodeCatalogMessage(encodeDeltaRaw(invalid)),
    /invalid catalog delta format/,
  );
});

test("CatalogDelta: tracks を含む場合はエラー", () => {
  const invalid = { deltaUpdate: true, tracks: [], addTracks: [] };
  assert.throws(
    () => decodeCatalogMessage(encodeDeltaRaw(invalid)),
    /invalid catalog delta format/,
  );
});

test("CatalogDelta: addTracks/removeTracks/cloneTracks がない場合はエラー", () => {
  const invalid = { deltaUpdate: true, generatedAt: 123 };
  assert.throws(
    () => decodeCatalogMessage(encodeDeltaRaw(invalid)),
    /invalid catalog delta format/,
  );
});

test("CatalogDelta: operations に同一タイプの操作が重複する場合はエンコード時にエラー", () => {
  // JSON オブジェクトのキーは重複できないため、同一タイプの操作は 1 回のみ許可する
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [
      { type: "add", tracks: [{ name: "audio", packaging: "loc", isLive: true }] },
      { type: "add", tracks: [{ name: "video", packaging: "loc", isLive: true }] },
    ],
  };
  assert.throws(() => encodeCatalogDelta(delta), /duplicate operation type/);
});

test("CatalogDelta: addTracks 内のトラックに必須フィールドがない場合はデコード時にエラー", () => {
  // addTracks 内の各トラックも isCatalogTrack の検証を通すべき
  const raw = {
    deltaUpdate: true,
    addTracks: [{ name: "audio" }],
  };
  assert.throws(() => decodeCatalogMessage(encodeDeltaRaw(raw)), /invalid catalog delta format/);
});

test("CatalogDelta: removeTracks 内のトラックに name がない場合はデコード時にエラー", () => {
  // draft-ietf-moq-msf-00 §5.1.4: Each track object MUST include a Track Name field
  const raw = {
    deltaUpdate: true,
    removeTracks: [{ namespace: "room1" }],
  };
  assert.throws(() => decodeCatalogMessage(encodeDeltaRaw(raw)), /invalid catalog delta format/);
});

test("CatalogDelta: cloneTracks 内のトラックに必須フィールドがない場合はデコード時にエラー", () => {
  const raw = {
    deltaUpdate: true,
    cloneTracks: [{ parentName: "video" }],
  };
  assert.throws(() => decodeCatalogMessage(encodeDeltaRaw(raw)), /invalid catalog delta format/);
});

test("CatalogDelta: 複数操作の宣言順をデコードで保持する", () => {
  // draft-ietf-moq-msf-00 §5.2: JSON キー宣言順で操作を適用する
  // JSON では addTracks → removeTracks の順に宣言
  const raw = {
    deltaUpdate: true,
    addTracks: [{ name: "audio", packaging: "loc", isLive: true }],
    removeTracks: [{ name: "video" }],
  };
  const decoded = decodeCatalogMessage(encodeDeltaRaw(raw)) as CatalogDelta;
  assert.strictEqual(decoded.operations.length, 2);
  assert.strictEqual(decoded.operations[0].type, "add");
  assert.strictEqual(decoded.operations[1].type, "remove");
});

// =============================================================================
// Media Timeline
// =============================================================================

test("Media Timeline: 空配列のエンコード/デコード", async () => {
  const entries: MediaTimelineEntry[] = [];
  const encoded = await encodeMediaTimeline(entries);
  const decoded = await decodeMediaTimeline(encoded);
  assert.deepStrictEqual(decoded, entries);
});

test("Media Timeline: gzip のエンコード/デコード", async () => {
  const entries: MediaTimelineEntry[] = [
    [0, [0n, 0n], 1759924158381],
    [2002, [1n, 0n], 1759924160383],
  ];
  const encoded = await encodeMediaTimeline(entries, { gzip: true });
  const decoded = await decodeMediaTimeline(encoded);

  assert.strictEqual(encoded[0], 0x1f);
  assert.strictEqual(encoded[1], 0x8b);
  assert.deepStrictEqual(decoded, entries);
});

test("Media Timeline: 不正な形式はエラー", async () => {
  const invalidData = new TextEncoder().encode('{"not": "an array"}');
  await assertRejectsWithMessage(
    () => decodeMediaTimeline(invalidData),
    /invalid media timeline format/,
  );
});

test("Media Timeline: 不正なエントリ形式はエラー", async () => {
  const invalidData = new TextEncoder().encode("[[1, 2, 3]]");
  await assertRejectsWithMessage(
    () => decodeMediaTimeline(invalidData),
    /invalid media timeline entry/,
  );
});

// =============================================================================
// Event Timeline
// =============================================================================

test("Event Timeline: 空配列のエンコード/デコード", async () => {
  const entries: EventTimelineEntry[] = [];
  const encoded = await encodeEventTimeline(entries);
  const decoded = await decodeEventTimeline(encoded);
  assert.deepStrictEqual(decoded, entries);
});

test("Event Timeline: gzip のエンコード/デコード", async () => {
  const entries: EventTimelineEntry[] = [
    { l: [0n, 0n], data: [47.1812, 8.4592] },
    { l: [1n, 0n], data: [47.1662, 8.5155] },
  ];
  const encoded = await encodeEventTimeline(entries, { gzip: true });
  const decoded = await decodeEventTimeline(encoded);

  assert.strictEqual(encoded[0], 0x1f);
  assert.strictEqual(encoded[1], 0x8b);
  assert.deepStrictEqual(decoded, entries);
});

test("Event Timeline: 不正な形式はエラー", async () => {
  const invalidData = new TextEncoder().encode('{"not": "an array"}');
  await assertRejectsWithMessage(
    () => decodeEventTimeline(invalidData),
    /invalid event timeline format/,
  );
});

test("Event Timeline: data がない場合はエラー", async () => {
  // draft-ietf-moq-msf-00 §8.1: data は必須
  const invalidData = new TextEncoder().encode('[{"t": 123}]');
  await assertRejectsWithMessage(
    () => decodeEventTimeline(invalidData),
    /invalid event timeline entry/,
  );
});

test("Event Timeline: インデックスが 1 つもない場合はエラー", async () => {
  // draft-ietf-moq-msf-00 §8.1: t/l/m のいずれか 1 つが必須
  const invalidData = new TextEncoder().encode('[{"data": "event"}]');
  await assertRejectsWithMessage(
    () => decodeEventTimeline(invalidData),
    /invalid event timeline entry/,
  );
});

test("Event Timeline: インデックスが複数ある場合はエラー", async () => {
  // draft-ietf-moq-msf-00 §8.1: 同一レコード内で複数のインデックスは禁止
  const invalidData = new TextEncoder().encode('[{"t": 123, "m": 456, "data": "event"}]');
  await assertRejectsWithMessage(
    () => decodeEventTimeline(invalidData),
    /invalid event timeline entry/,
  );
});

test("Event Timeline: data が配列の場合も正常にデコードする", async () => {
  // RFC Section 8.4.2: "data": [47.1812, 8.4592]
  const entries: EventTimelineEntry[] = [
    { l: [0n, 0n], data: [47.1812, 8.4592] },
    { l: [1n, 0n], data: [47.1662, 8.5155] },
  ];
  const encoded = await encodeEventTimeline(entries);
  const decoded = await decodeEventTimeline(encoded);

  assert.strictEqual(decoded.length, 2);
  assert.deepStrictEqual(decoded[0].data, [47.1812, 8.4592]);
  assert.deepStrictEqual(decoded[1].data, [47.1662, 8.5155]);
});

test("Event Timeline: data が文字列の場合も正常にデコードする", async () => {
  const entries: EventTimelineEntry[] = [{ t: 123, data: "hello" }];
  const encoded = await encodeEventTimeline(entries);
  const decoded = await decodeEventTimeline(encoded);
  assert.strictEqual(decoded[0].data, "hello");
});

test("Event Timeline: data が数値の場合も正常にデコードする", async () => {
  const entries: EventTimelineEntry[] = [{ t: 123, data: 42 }];
  const encoded = await encodeEventTimeline(entries);
  const decoded = await decodeEventTimeline(encoded);
  assert.strictEqual(decoded[0].data, 42);
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

test("applyCatalogDelta: addTracks でトラックを追加", () => {
  const current: Catalog = {
    version: MSF_VERSION,
    tracks: [{ name: "video", packaging: "loc", isLive: true }],
  };

  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "add", tracks: [{ name: "audio", packaging: "loc", isLive: true }] }],
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
    operations: [{ type: "remove", tracks: [{ name: "audio" }] }],
  };

  const result = applyCatalogDelta(current, delta);
  assert.strictEqual(result.tracks.length, 1);
  assert.strictEqual(result.tracks[0].name, "video");
});

test("applyCatalogDelta: removeTracks で namespace を考慮して削除", () => {
  const current: Catalog = {
    version: MSF_VERSION,
    tracks: [
      { name: "video", packaging: "loc", isLive: true, namespace: "room1" },
      { name: "video", packaging: "loc", isLive: true, namespace: "room2" },
    ],
  };

  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "remove", tracks: [{ name: "video", namespace: "room1" }] }],
  };

  const result = applyCatalogDelta(current, delta);
  assert.strictEqual(result.tracks.length, 1);
  assert.strictEqual(result.tracks[0].namespace, "room2");
});

test("applyCatalogDelta: cloneTracks で parentName を使用して複製", () => {
  const current: Catalog = {
    version: MSF_VERSION,
    tracks: [
      {
        name: "video-1080",
        packaging: "loc",
        isLive: true,
        codec: "av1",
        width: 1920,
        height: 1080,
      },
    ],
  };

  // draft-ietf-moq-msf-00 §5.1.5: parentName でベーストラックを指定
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [
      {
        type: "clone",
        tracks: [
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
      },
    ],
  };

  const result = applyCatalogDelta(current, delta);
  assert.strictEqual(result.tracks.length, 2);
  assert.strictEqual(result.tracks[1].name, "video-720");
  assert.strictEqual(result.tracks[1].codec, "av1");
  assert.strictEqual(result.tracks[1].width, 1280);
  assert.strictEqual(result.tracks[1].height, 720);
});

test("applyCatalogDelta: 複合操作 (remove → add)", () => {
  const current: Catalog = {
    version: MSF_VERSION,
    tracks: [
      { name: "video-hd", packaging: "loc", isLive: true },
      { name: "audio", packaging: "loc", isLive: true },
    ],
  };

  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [
      { type: "remove", tracks: [{ name: "video-hd" }] },
      { type: "add", tracks: [{ name: "video-sd", packaging: "loc", isLive: true }] },
    ],
  };

  const result = applyCatalogDelta(current, delta);
  assert.strictEqual(result.tracks.length, 2);
  assert.isTrue(result.tracks.some((t) => t.name === "audio"));
  assert.isTrue(result.tracks.some((t) => t.name === "video-sd"));
  assert.isFalse(result.tracks.some((t) => t.name === "video-hd"));
});

test("applyCatalogDelta: 宣言順を守って操作を適用する (add → remove で同名トラック)", () => {
  // draft-ietf-moq-msf-00 §5.2: 宣言順に操作を逐次適用する
  // add "new-track" を先に行い、続いて remove "new-track" を行うと最終的に残らない
  // 逆順 (remove → add) なら "new-track" が残る
  const current: Catalog = {
    version: MSF_VERSION,
    tracks: [{ name: "existing", packaging: "loc", isLive: true }],
  };

  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [
      { type: "add", tracks: [{ name: "new-track", packaging: "loc", isLive: true }] },
      { type: "remove", tracks: [{ name: "new-track" }] },
    ],
  };

  const result = applyCatalogDelta(current, delta);
  assert.strictEqual(result.tracks.length, 1);
  assert.strictEqual(result.tracks[0].name, "existing");
  assert.isFalse(result.tracks.some((t) => t.name === "new-track"));
});

test("applyCatalogDelta: generatedAt を引き継ぐ", () => {
  const current: Catalog = {
    version: MSF_VERSION,
    tracks: [{ name: "video", packaging: "loc", isLive: true }],
    generatedAt: 100,
  };

  const delta: CatalogDelta = {
    deltaUpdate: true,
    generatedAt: 200,
    operations: [{ type: "add", tracks: [{ name: "audio", packaging: "loc", isLive: true }] }],
  };

  const result = applyCatalogDelta(current, delta);
  assert.strictEqual(result.generatedAt, 200);
});

test("applyCatalogDelta: isComplete を引き継ぐ", () => {
  // draft-ietf-moq-msf-00 §5.1.7: isComplete は一度設定したら削除禁止 (MUST NOT)
  const current: Catalog = {
    version: MSF_VERSION,
    tracks: [{ name: "video", packaging: "loc", isLive: true }],
    isComplete: true,
  };

  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "add", tracks: [{ name: "audio", packaging: "loc", isLive: true }] }],
  };

  const result = applyCatalogDelta(current, delta);
  assert.strictEqual(result.isComplete, true);
});

test("applyCatalogDelta: isComplete が未設定の場合は引き継がない", () => {
  const current: Catalog = {
    version: MSF_VERSION,
    tracks: [{ name: "video", packaging: "loc", isLive: true }],
  };

  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "add", tracks: [{ name: "audio", packaging: "loc", isLive: true }] }],
  };

  const result = applyCatalogDelta(current, delta);
  assert.isUndefined(result.isComplete);
});

test("applyCatalogDelta: cloneTracks で parentName がない場合はエラー", () => {
  // draft-ietf-moq-msf-00 §5.1.5: Each track object MUST include a Parent Name field
  const current: Catalog = {
    version: MSF_VERSION,
    tracks: [{ name: "video", packaging: "loc", isLive: true }],
  };

  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [
      {
        type: "clone",
        tracks: [{ name: "video-clone", packaging: "loc", isLive: true }],
      },
    ],
  };

  assert.throws(() => applyCatalogDelta(current, delta), /clone track missing parentName/);
});

test("applyCatalogDelta: cloneTracks で親トラックが存在しない場合はエラー", () => {
  const current: Catalog = {
    version: MSF_VERSION,
    tracks: [{ name: "video", packaging: "loc", isLive: true }],
  };

  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [
      {
        type: "clone",
        tracks: [
          {
            name: "video-clone",
            packaging: "loc",
            isLive: true,
            parentName: "nonexistent",
          },
        ],
      },
    ],
  };

  assert.throws(() => applyCatalogDelta(current, delta), /clone track parent not found/);
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
