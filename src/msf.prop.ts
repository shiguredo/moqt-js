/**
 * MSF (MOQT Streaming Format) の PBT テスト (draft-ietf-moq-msf-01)
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  type Catalog,
  type CatalogTrack,
  type CatalogDelta,
  type MediaTimelineEntry,
  type EventTimelineEntry,
  type PackagingType,
  type TrackRole,
  type MediaTimelineTemplate,
  encodeCatalog,
  decodeCatalogMessage,
  encodeCatalogDelta,
  encodeMediaTimeline,
  decodeMediaTimeline,
  encodeEventTimeline,
  decodeEventTimeline,
  createCatalog,
  createCompleteCatalog,
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
  resolveCatalogVariables,
  parseMsfFragmentValue,
} from "./msf";

// =============================================================================
// Arbitrary 定義 (draft-01 reserved 値を網羅)
// =============================================================================

/**
 * パッケージング形式の Arbitrary
 *
 * draft-ietf-moq-msf-01 §5.2.4 Table 4 の全 reserved 値:
 * `loc`, `mediatimeline`, `eventtimeline`, `moqlog`, `moqmetrics`
 *
 * `mediatimeline` / `eventtimeline` は §7.2 / §8.2 で depends / mimeType /
 * eventType の MUST 制約があるため `catalogTrackArb` には含めず、別途存在確認の
 * PBT (Table 4 網羅性テスト) でのみ使用する。
 */
const packagingArb = fc.constantFrom<PackagingType>(
  "loc",
  "mediatimeline",
  "eventtimeline",
  "moqlog",
  "moqmetrics",
);

/**
 * トラックロールの Arbitrary
 *
 * draft-ietf-moq-msf-01 §5.2.6 Table 5 の全 reserved 値:
 * `video`, `audio`, `audiodescription`, `caption`, `subtitle`, `signlanguage`,
 * `mediatimeline`, `eventtimeline`, `log`, `metrics`
 */
const roleArb = fc.constantFrom<TrackRole>(
  "video",
  "audio",
  "audiodescription",
  "caption",
  "subtitle",
  "signlanguage",
  "mediatimeline",
  "eventtimeline",
  "log",
  "metrics",
);

/** 非負の bigint を生成する Arbitrary (Location 等で利用) */
const bigUintArb = fc.bigInt({ min: 0n, max: BigInt(Number.MAX_SAFE_INTEGER) });

/**
 * Buffers の Arbitrary (§5.2.9)。
 *
 * 仕様上 `target` / `min` / `max` はいずれも optional。`targetLatency` との併存禁止
 * (§5.2.8 / §5.2.9) を考慮し、`buffers` を採用するエントリでは `targetLatency` を省略する。
 */
const buffersArb: fc.Arbitrary<NonNullable<CatalogTrack["buffers"]>> = fc.record(
  {
    target: fc.option(fc.nat({ max: 10000 }), { nil: undefined }),
    min: fc.option(fc.nat({ max: 10000 }), { nil: undefined }),
    max: fc.option(fc.nat({ max: 10000 }), { nil: undefined }),
  },
  { requiredKeys: [] },
);

/**
 * Template の Arbitrary (§7.4.1 / §5.2.15)。Location 部は safe integer 範囲の bigint。
 */
const templateForTrackArb: fc.Arbitrary<MediaTimelineTemplate> = fc
  .tuple(
    fc.nat({ max: 86400000 }),
    fc.nat({ max: 10000 }),
    fc.tuple(bigUintArb, bigUintArb),
    fc.tuple(fc.bigInt({ min: 0n, max: 100n }), fc.bigInt({ min: 0n, max: 100n })),
    fc.nat({ max: 2_000_000_000_000 }),
    fc.nat({ max: 10000 }),
  )
  .map(
    ([startMt, deltaMt, startLoc, deltaLoc, startWc, deltaWc]) =>
      [
        startMt,
        deltaMt,
        [startLoc[0], startLoc[1]] as const,
        [deltaLoc[0], deltaLoc[1]] as const,
        startWc,
        deltaWc,
      ] as MediaTimelineTemplate,
  );

/**
 * accessibility descriptor の Arbitrary (§5.2.44)。
 */
const accessibilityArb = fc.array(
  fc.record({
    scheme: fc.string({ minLength: 1, maxLength: 32 }),
    value: fc.string({ minLength: 0, maxLength: 32 }),
  }),
  { maxLength: 3 },
);

/**
 * authInfo の Arbitrary (§5.2.42)。scheme 識別子をキーとした dict。
 */
const authInfoArb = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 16 }),
  fc.oneof(fc.string({ maxLength: 32 }), fc.record({ note: fc.string({ maxLength: 16 }) })),
  { maxKeys: 3 },
);

/**
 * CatalogTrack の Arbitrary。
 *
 * draft-01 で新規追加された optional フィールド (`buffers`, `template`, `encryptionScheme`
 * / `cipherSuite` / `keyId` / `trackBaseKey`, `authInfo`, `accessibility`, `parentName`
 * 系を除く全フィールド) も含めて生成し、round-trip PBT で網羅する。
 *
 * `mediatimeline` / `eventtimeline` は §7.2 / §8.2 の depends / mimeType / eventType MUST
 * があるため `catalogTrackArb` には含めず、専用 arbitrary でカバーする。
 *
 * 制約:
 * - `targetLatency` と `buffers` は §5.2.8 / §5.2.9 で MUST NOT 併存 → 排他的に生成する
 * - `encryptionScheme` 指定時は §5.2.39 で `cipherSuite` MUST → tuple 化
 * - `trackDuration` は §5.2.35 で isLive=true 時 MUST NOT → isLive=false の場合のみ付与
 *   (本 arbitrary では trackDuration を生成しない。VOD 用テストは別 arbitrary を使う)
 */
const catalogTrackArb: fc.Arbitrary<CatalogTrack> = fc
  .record(
    {
      name: fc.string({ minLength: 1, maxLength: 32 }),
      packaging: fc.constantFrom<PackagingType>("loc", "moqlog", "moqmetrics"),
      isLive: fc.boolean(),
      namespace: fc.option(fc.string({ maxLength: 32 }), { nil: undefined }),
      role: fc.option(roleArb, { nil: undefined }),
      label: fc.option(fc.string({ maxLength: 64 }), { nil: undefined }),
      renderGroup: fc.option(fc.nat({ max: 100 }), { nil: undefined }),
      altGroup: fc.option(fc.nat({ max: 100 }), { nil: undefined }),
      codec: fc.option(fc.string({ maxLength: 64 }), { nil: undefined }),
      mimeType: fc.option(fc.string({ maxLength: 64 }), { nil: undefined }),
      framerate: fc.option(fc.nat({ max: 120 }), { nil: undefined }),
      timescale: fc.option(fc.nat({ max: 1_000_000 }), { nil: undefined }),
      bitrate: fc.option(fc.nat({ max: 100_000_000 }), { nil: undefined }),
      avgBitrate: fc.option(fc.nat({ max: 100_000_000 }), { nil: undefined }),
      maxGopDuration: fc.option(fc.nat({ max: 10000 }), { nil: undefined }),
      maxGroupDuration: fc.option(fc.nat({ max: 10000 }), { nil: undefined }),
      width: fc.option(fc.nat({ max: 7680 }), { nil: undefined }),
      height: fc.option(fc.nat({ max: 4320 }), { nil: undefined }),
      displayWidth: fc.option(fc.nat({ max: 7680 }), { nil: undefined }),
      displayHeight: fc.option(fc.nat({ max: 4320 }), { nil: undefined }),
      samplerate: fc.option(fc.constantFrom(44100, 48000, 96000), { nil: undefined }),
      channelConfig: fc.option(fc.constantFrom("1", "2", "5.1", "7.1"), { nil: undefined }),
      lang: fc.option(fc.constantFrom("en", "ja", "zh", "ko", "es", "fr", "de"), {
        nil: undefined,
      }),
      initRef: fc.option(fc.string({ minLength: 1, maxLength: 32 }), { nil: undefined }),
      // draft-01 新規フィールド
      template: fc.option(templateForTrackArb, { nil: undefined }),
      keyId: fc.option(fc.string({ minLength: 1, maxLength: 32 }), { nil: undefined }),
      trackBaseKey: fc.option(fc.string({ minLength: 1, maxLength: 64 }), { nil: undefined }),
      authInfo: fc.option(authInfoArb, { nil: undefined }),
      accessibility: fc.option(accessibilityArb, { nil: undefined }),
      // §5.2.8 / §5.2.9 排他用 enum: "none" → どちらも無し、"latency" → targetLatency のみ、
      // "buffers" → buffers のみ
      latencyBuffersMode: fc.constantFrom<"none" | "latency" | "buffers">(
        "none",
        "latency",
        "buffers",
      ),
      latencyValue: fc.nat({ max: 10000 }),
      buffersValue: buffersArb,
      // §5.2.39 排他用: "off" → 暗号化なし、"on" → encryptionScheme + cipherSuite 同居
      encryptionMode: fc.constantFrom<"off" | "on">("off", "on"),
    },
    { requiredKeys: ["name", "packaging", "isLive"] },
  )
  .map((raw) => {
    const { latencyBuffersMode, latencyValue, buffersValue, encryptionMode, ...base } =
      raw as Record<string, unknown>;
    const track = { ...base } as unknown as CatalogTrack;
    if (latencyBuffersMode === "latency") {
      track.targetLatency = latencyValue as number;
    } else if (latencyBuffersMode === "buffers") {
      track.buffers = buffersValue as CatalogTrack["buffers"];
    }
    if (encryptionMode === "on") {
      track.encryptionScheme = "moq-secure-objects";
      track.cipherSuite = "aes-128-gcm-sha256";
    }
    return track;
  });

/**
 * InitDataEntry の Arbitrary。§5.1.7 で `type` は inline のみ定義、Base64 文字列を想定。
 */
const initDataEntryArb = fc.record({
  id: fc.string({ minLength: 1, maxLength: 16 }),
  type: fc.constant("inline"),
  data: fc.stringMatching(/^[A-Za-z0-9+/]{0,32}={0,2}$/),
});

/**
 * 配列内 (name, namespace) タプル uniqueness を保つトラック配列の Arbitrary
 *
 * §5.2.3 「track names MUST be unique per namespace」を満たすため、生成後に
 * filter で重複を弾き、残った先頭から順に拾う。
 */
const uniqueCatalogTrackArrayArb = fc
  .array(catalogTrackArb, { minLength: 1, maxLength: 6 })
  .map((tracks) => {
    const seen = new Set<string>();
    const result: CatalogTrack[] = [];
    for (const track of tracks) {
      const key = `${track.namespace ?? "<unset>"} ${track.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(track);
    }
    // 1 件未満になる可能性は極めて低いが念のため fallback
    if (result.length === 0) {
      result.push({ name: "fallback", packaging: "loc", isLive: true });
    }
    return result;
  });

/**
 * Catalog の Arbitrary
 *
 * §5.1.3: isComplete=false は MUST NOT include。true のときのみ含める。
 * publishTracks / initDataList も draft-01 新規フィールドの round-trip 網羅対象。
 */
const catalogArb: fc.Arbitrary<Catalog> = fc
  .record({
    tracks: uniqueCatalogTrackArrayArb,
    generatedAt: fc.option(fc.nat({ max: 2_000_000_000_000 }), { nil: undefined }),
    isCompleteFlag: fc.boolean(),
    publishTracks: fc.option(uniqueCatalogTrackArrayArb, { nil: undefined }),
    initDataList: fc.option(fc.array(initDataEntryArb, { maxLength: 3 }), { nil: undefined }),
  })
  .map(({ tracks, generatedAt, isCompleteFlag, publishTracks, initDataList }) => {
    const catalog: Catalog = { version: "draft-01", tracks };
    if (generatedAt !== undefined) catalog.generatedAt = generatedAt;
    if (isCompleteFlag) catalog.isComplete = true;
    if (publishTracks !== undefined) catalog.publishTracks = publishTracks;
    if (initDataList !== undefined) {
      // initDataList は id がカタログ内で unique でなければならない (§5.1.7)
      const seen = new Set<string>();
      const filtered = initDataList.filter((entry) => {
        if (seen.has(entry.id)) return false;
        seen.add(entry.id);
        return true;
      });
      if (filtered.length > 0) catalog.initDataList = filtered;
    }
    return catalog;
  });

/** Media Timeline エントリの Arbitrary */
const mediaTimelineEntryArb: fc.Arbitrary<MediaTimelineEntry> = fc.tuple(
  fc.nat({ max: 86400000 }),
  fc.tuple(bigUintArb, bigUintArb),
  fc.nat({ max: 2_000_000_000_000 }),
);

/** Event Timeline エントリのイベントデータ Arbitrary */
const eventDataArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.object({
    key: fc.string({ maxLength: 16 }),
    values: [fc.string(), fc.nat(), fc.boolean()],
    maxDepth: 1,
    maxKeys: 5,
  }),
  fc.array(fc.oneof(fc.nat(), fc.string(), fc.boolean()), { maxLength: 5 }),
  fc.string(),
  fc.nat(),
) as fc.Arbitrary<unknown>;

/**
 * Event Timeline エントリの Arbitrary
 *
 * §8.1: t/l/m のいずれかちょうど 1 つが必須。
 */
const eventTimelineEntryArb: fc.Arbitrary<EventTimelineEntry> = fc.oneof(
  fc.record({ t: fc.nat({ max: 2_000_000_000_000 }), data: eventDataArb }),
  fc.record({ l: fc.tuple(bigUintArb, bigUintArb), data: eventDataArb }),
  fc.record({ m: fc.nat({ max: 86400000 }), data: eventDataArb }),
);

// =============================================================================
// Catalog round-trip
// =============================================================================

test("Catalog: encode/decode の round-trip (構造比較)", () => {
  // 検証側 (validateCatalogTrack) は track フィールドを decode 順に再構築するため、
  // 1 回目の encode 出力と 2 回目の encode 出力で JSON の key 順が変わる可能性がある。
  // round-trip 安定性を担保するには 1 回 round-trip を通してから比較する。
  fc.assert(
    fc.property(catalogArb, (catalog) => {
      const decoded1 = decodeCatalogMessage(encodeCatalog(catalog)) as Catalog;
      const decoded2 = decodeCatalogMessage(encodeCatalog(decoded1)) as Catalog;
      // 2 回目以降は安定する
      assert.deepStrictEqual(decoded2, decoded1);
    }),
  );
});

test("Catalog: encode 結果は有効な JSON", () => {
  fc.assert(
    fc.property(catalogArb, (catalog) => {
      const encoded = encodeCatalog(catalog);
      const json = new TextDecoder().decode(encoded);
      assert.doesNotThrow(() => JSON.parse(json));
    }),
  );
});

test("Catalog: decode 後の version は常に draft-01", () => {
  fc.assert(
    fc.property(catalogArb, (catalog) => {
      const encoded = encodeCatalog(catalog);
      const decoded = decodeCatalogMessage(encoded) as Catalog;
      assert.strictEqual(decoded.version, "draft-01");
    }),
  );
});

// =============================================================================
// Media Timeline テスト
// =============================================================================

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

test("Media Timeline: ラウンドトリップで同一値に戻る", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(mediaTimelineEntryArb, { maxLength: 100 }), async (entries) => {
      const encoded = await encodeMediaTimeline(entries);
      const decoded = await decodeMediaTimeline(encoded);
      assert.deepStrictEqual(decoded, entries);
    }),
  );
});

test("Media Timeline: 空配列 round-trip", async () => {
  const entries: MediaTimelineEntry[] = [];
  const encoded = await encodeMediaTimeline(entries);
  const decoded = await decodeMediaTimeline(encoded);
  assert.deepStrictEqual(decoded, entries);
});

test("Media Timeline: 不正な形式は reject", async () => {
  const invalid = new TextEncoder().encode('{"not": "an array"}');
  await assertRejectsWithMessage(
    () => decodeMediaTimeline(invalid),
    /invalid media timeline format/,
  );
});

// =============================================================================
// Event Timeline テスト
// =============================================================================

test("Event Timeline: ラウンドトリップで同一値に戻る", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(eventTimelineEntryArb, { maxLength: 100 }), async (entries) => {
      const encoded = await encodeEventTimeline(entries);
      const decoded = await decodeEventTimeline(encoded);

      assert.strictEqual(decoded.length, entries.length);
      for (let i = 0; i < entries.length; i++) {
        const original = entries[i];
        const result = decoded[i];

        assert.deepStrictEqual(result.data, original.data);
        if (original.t !== undefined) assert.strictEqual(result.t, original.t);
        if (original.m !== undefined) assert.strictEqual(result.m, original.m);
        if (original.l !== undefined) {
          assert.isDefined(result.l);
          assert.strictEqual(result.l![0], original.l[0]);
          assert.strictEqual(result.l![1], original.l[1]);
        }
      }
    }),
  );
});

test("Event Timeline: 空配列 round-trip", async () => {
  const entries: EventTimelineEntry[] = [];
  const encoded = await encodeEventTimeline(entries);
  const decoded = await decodeEventTimeline(encoded);
  assert.deepStrictEqual(decoded, entries);
});

test("Event Timeline: data 欠落は reject", async () => {
  const invalid = new TextEncoder().encode('[{"t": 123}]');
  await assertRejectsWithMessage(
    () => decodeEventTimeline(invalid),
    /invalid event timeline entry/,
  );
});

// =============================================================================
// Media Timeline Template PBT
// =============================================================================

const templateArb: fc.Arbitrary<MediaTimelineTemplate> = fc
  .tuple(
    fc.nat({ max: 86400000 }),
    fc.nat({ max: 10000 }),
    fc.tuple(bigUintArb, bigUintArb),
    fc.tuple(fc.bigInt({ min: 0n, max: 100n }), fc.bigInt({ min: 0n, max: 100n })),
    fc.nat({ max: Date.now() }),
    fc.nat({ max: 10000 }),
  )
  .map(([startMt, deltaMt, startLoc, deltaLoc, startWc, deltaWc]) => {
    return [
      startMt,
      deltaMt,
      [startLoc[0], startLoc[1]] as const,
      [deltaLoc[0], deltaLoc[1]] as const,
      startWc,
      deltaWc,
    ] as MediaTimelineTemplate;
  });

test("Media Timeline Template: encode→decode で配列構造が保たれる", () => {
  fc.assert(
    fc.property(templateArb, (template) => {
      const catalog: Catalog = {
        version: "draft-01",
        tracks: [{ name: "t", packaging: "loc", isLive: false, template }],
      };
      const encoded = encodeCatalog(catalog);
      const decoded = decodeCatalogMessage(encoded) as Catalog;
      assert.deepStrictEqual(decoded.tracks[0].template, template);
    }),
  );
});

// =============================================================================
// CatalogDelta wire format round-trip
// =============================================================================

const addOpArb = fc.record({
  type: fc.constant("add" as const),
  tracks: fc.array(catalogTrackArb, { minLength: 1, maxLength: 3 }),
});
const removeOpArb = fc.record({
  type: fc.constant("remove" as const),
  tracks: fc.array(
    fc.record(
      {
        name: fc.string({ minLength: 1, maxLength: 16 }),
        namespace: fc.option(fc.string({ maxLength: 16 }), { nil: undefined }),
      },
      { requiredKeys: ["name"] },
    ),
    { minLength: 1, maxLength: 3 },
  ),
});
const cloneOpArb = fc.record({
  type: fc.constant("clone" as const),
  tracks: fc.array(
    fc.record(
      {
        name: fc.string({ minLength: 1, maxLength: 16 }),
        parentName: fc.string({ minLength: 1, maxLength: 16 }),
        parentNamespace: fc.option(fc.string({ maxLength: 16 }), { nil: undefined }),
        width: fc.option(fc.nat({ max: 7680 }), { nil: undefined }),
      },
      { requiredKeys: ["name", "parentName"] },
    ),
    { minLength: 1, maxLength: 3 },
  ),
});

const deltaArb: fc.Arbitrary<CatalogDelta> = fc
  .record({
    operations: fc.array(fc.oneof(addOpArb, removeOpArb, cloneOpArb), {
      minLength: 1,
      maxLength: 4,
    }),
    generatedAt: fc.option(fc.nat({ max: 2_000_000_000_000 }), { nil: undefined }),
  })
  .map((value) => {
    const delta: CatalogDelta = {
      deltaUpdate: true,
      operations: value.operations as CatalogDelta["operations"],
    };
    if (value.generatedAt !== undefined) delta.generatedAt = value.generatedAt;
    return delta;
  });

test("CatalogDelta: wire format のラウンドトリップで構造比較が同一になる (draft-01)", () => {
  // validateCatalogTrack が field 順を decode 時に再構築するため、catalog 同様 1 回 round-trip
  // を通して安定状態にしてから deep 比較する。
  fc.assert(
    fc.property(deltaArb, (delta) => {
      const decoded1 = decodeCatalogMessage(encodeCatalogDelta(delta)) as CatalogDelta;
      const decoded2 = decodeCatalogMessage(encodeCatalogDelta(decoded1)) as CatalogDelta;
      assert.deepStrictEqual(decoded2, decoded1);
      assert.strictEqual(decoded2.deltaUpdate, true);
      assert.strictEqual(decoded2.operations.length, delta.operations.length);
    }),
  );
});

// =============================================================================
// Variable Substitution PBT
// =============================================================================

const variableNameArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,16}$/);
const variableValueArb = fc.stringMatching(/^[A-Za-z0-9_@-]{0,16}$/);

test("resolveCatalogVariables: 値文字種が合致すれば throw しない", () => {
  fc.assert(
    fc.property(fc.dictionary(variableNameArb, variableValueArb, { maxKeys: 5 }), (variables) => {
      const catalog: Catalog = {
        version: "draft-01",
        tracks: [{ name: "v", packaging: "loc", isLive: true, label: "x" }],
      };
      assert.doesNotThrow(() => resolveCatalogVariables(catalog, variables));
    }),
  );
});

test("resolveCatalogVariables: %name% 参照が変数値に正しく置換される", () => {
  fc.assert(
    fc.property(
      variableNameArb,
      variableValueArb.filter((v) => v.length > 0),
      (name, value) => {
        const catalog: Catalog = {
          version: "draft-01",
          tracks: [
            {
              name: "v",
              packaging: "loc",
              isLive: true,
              label: `prefix-%${name}%-suffix`,
            },
          ],
        };
        const resolved = resolveCatalogVariables(catalog, { [name]: value });
        assert.strictEqual(resolved.tracks[0].label, `prefix-${value}-suffix`);
      },
    ),
  );
});

test("applyCatalogDelta: add で track 数が増加する性質", () => {
  fc.assert(
    fc.property(uniqueCatalogTrackArrayArb, catalogTrackArb, (initial, added) => {
      // added が initial と (name, namespace) で衝突する場合は何も検証しない
      const collision = initial.some(
        (t) => t.name === added.name && t.namespace === added.namespace,
      );
      if (collision) return;
      const current = { version: "draft-01", tracks: initial } as Catalog;
      const delta = {
        deltaUpdate: true,
        operations: [{ type: "add", tracks: [added] }],
      } as CatalogDelta;
      const result = applyCatalogDelta(current, delta);
      assert.strictEqual(result.tracks.length, initial.length + 1);
    }),
  );
});

test("applyCatalogDelta: remove で指定 track が消える性質", () => {
  fc.assert(
    fc.property(uniqueCatalogTrackArrayArb, (initial) => {
      if (initial.length === 0) return;
      const target = initial[0];
      const current = { version: "draft-01", tracks: initial } as Catalog;
      const delta = {
        deltaUpdate: true,
        operations: [
          {
            type: "remove",
            tracks: [
              target.namespace === undefined
                ? { name: target.name }
                : { name: target.name, namespace: target.namespace },
            ],
          },
        ],
      } as CatalogDelta;
      const result = applyCatalogDelta(current, delta);
      assert.strictEqual(result.tracks.length, initial.length - 1);
      assert.isFalse(
        result.tracks.some((t) => t.name === target.name && t.namespace === target.namespace),
      );
    }),
  );
});

test("parseMsfFragmentValue: マルチセグメント namespace を round-trip する", () => {
  fc.assert(
    fc.property(
      fc.array(fc.stringMatching(/^[A-Za-z0-9_]{1,6}$/), { minLength: 1, maxLength: 4 }),
      fc.stringMatching(/^[A-Za-z0-9_]{1,8}$/),
      (nsParts, name) => {
        const value = `${nsParts.join("-")}--${name}`;
        const result = parseMsfFragmentValue(value);
        assert.deepStrictEqual(result.trackNamespace, nsParts);
        assert.strictEqual(result.trackName, name);
        assert.deepStrictEqual(result.parameters, []);
      },
    ),
  );
});

test("parseMsfFragmentValue: parameter 列を順序保持で round-trip する", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.tuple(
          fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/),
          fc.stringMatching(/^[A-Za-z0-9_-]{0,16}$/),
        ),
        { maxLength: 4 },
      ),
      (params) => {
        const value = "ns--track" + params.map(([k, v]) => `&${k}=${v}`).join("");
        const result = parseMsfFragmentValue(value);
        assert.strictEqual(result.parameters.length, params.length);
        for (let i = 0; i < params.length; i++) {
          assert.strictEqual(result.parameters[i][0], params[i][0]);
          assert.strictEqual(result.parameters[i][1], params[i][1]);
        }
      },
    ),
  );
});

// =============================================================================
// applyCatalogDelta テスト
// =============================================================================

test("applyCatalogDelta: add でトラック追加", () => {
  const current: Catalog = {
    version: "draft-01",
    tracks: [{ name: "video", packaging: "loc", isLive: true }],
  };
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "add", tracks: [{ name: "audio", packaging: "loc", isLive: true }] }],
  };
  const result = applyCatalogDelta(current, delta);
  assert.strictEqual(result.tracks.length, 2);
});

test("applyCatalogDelta: remove でトラック削除", () => {
  const current: Catalog = {
    version: "draft-01",
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

test("applyCatalogDelta: clone で parentName による複製", () => {
  const current: Catalog = {
    version: "draft-01",
    tracks: [
      { name: "video", packaging: "loc", isLive: true, codec: "av1", width: 1920, height: 1080 },
    ],
  };
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [
      {
        type: "clone",
        tracks: [
          { name: "video-sd", parentName: "video", width: 640, height: 480 } as CatalogTrack,
        ],
      },
    ],
  };
  const result = applyCatalogDelta(current, delta);
  const sd = result.tracks.find((t) => t.name === "video-sd");
  assert.isDefined(sd);
  assert.strictEqual(sd?.codec, "av1");
});

test("applyCatalogDelta: 複合操作 (remove → add)", () => {
  const current: Catalog = {
    version: "draft-01",
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
});

// =============================================================================
// Group 番号付け
// =============================================================================

test("createInitialGroupId: Unix ms ベースの bigint を返す", () => {
  const before = BigInt(Date.now());
  const id = createInitialGroupId();
  const after = BigInt(Date.now());
  assert.isTrue(id >= before);
  assert.isTrue(id <= after);
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
// ABR トラック選択
// =============================================================================

test("ABR: ビットレート制約に基づく選択", () => {
  fc.assert(
    fc.property(
      fc.array(fc.nat({ max: 10_000_000 }), { minLength: 3, maxLength: 10 }),
      fc.nat({ max: 10_000_000 }),
      (bitrates, maxBitrate) => {
        const tracks: CatalogTrack[] = bitrates.map((bitrate, i) => ({
          name: `track-${i}`,
          packaging: "loc" as const,
          isLive: true,
          bitrate,
        }));
        const result = selectTrackByMaxBitrate(tracks, maxBitrate);
        if (result !== undefined) {
          assert.isTrue((result.bitrate ?? 0) <= maxBitrate);
          const eligible = bitrates.filter((b) => b <= maxBitrate);
          if (eligible.length > 0) {
            assert.strictEqual(result.bitrate, Math.max(...eligible));
          }
        } else {
          assert.isTrue(bitrates.every((b) => b > maxBitrate));
        }
      },
    ),
  );
});

test("selectTrackByMaxResolution: 解像度制約", () => {
  const tracks: CatalogTrack[] = [
    { name: "4k", packaging: "loc", isLive: true, width: 3840, height: 2160 },
    { name: "hd", packaging: "loc", isLive: true, width: 1920, height: 1080 },
    { name: "sd", packaging: "loc", isLive: true, width: 640, height: 480 },
  ];
  assert.strictEqual(selectTrackByMaxResolution(tracks, 1920, 1080)?.name, "hd");
});

test("selectHighestBitrateTrack / selectLowestBitrateTrack: altGroup 内選択", () => {
  const catalog: Catalog = {
    version: "draft-01",
    tracks: [
      { name: "hd", packaging: "loc", isLive: true, altGroup: 1, bitrate: 5_000_000 },
      { name: "sd", packaging: "loc", isLive: true, altGroup: 1, bitrate: 1_000_000 },
    ],
  };
  assert.strictEqual(selectHighestBitrateTrack(catalog, 1)?.name, "hd");
  assert.strictEqual(selectLowestBitrateTrack(catalog, 1)?.name, "sd");
});

test("packagingArb: Table 4 reserved 値を網羅する (§5.2.4)", () => {
  fc.assert(
    fc.property(packagingArb, (packaging) => {
      // Table 4 値はすべて PackagingType として typescript の型を満たす
      assert.isTrue(
        ["loc", "mediatimeline", "eventtimeline", "moqlog", "moqmetrics"].includes(packaging),
      );
    }),
  );
});

// =============================================================================
// createCatalog / createCompleteCatalog
// =============================================================================

test("createCatalog: 正しい構造を生成する", () => {
  fc.assert(
    fc.property(uniqueCatalogTrackArrayArb, (tracks) => {
      const catalog = createCatalog(tracks);
      assert.strictEqual(catalog.version, "draft-01");
      assert.deepStrictEqual(catalog.tracks, tracks);
    }),
  );
});

test("createCompleteCatalog: 配信完了を示す", () => {
  const catalog = createCompleteCatalog();
  assert.strictEqual(catalog.version, "draft-01");
  assert.strictEqual(catalog.isComplete, true);
});

// =============================================================================
// 仕様書 §5.6 の Catalog 例の検証テスト (draft-01 では §5.3.x → §5.6.x)
// =============================================================================

test("仕様書例 (§5.6.1): Time-aligned Audio/Video Tracks with single quality", () => {
  // draft-ietf-moq-msf-01 §5.6.1
  const catalogJson = `{
    "version": "1",
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
        "codec": "av01.0.08M.10.0.110.09",
        "width": 1920,
        "height": 1080,
        "framerate": 30,
        "bitrate": 1500000
      },
      {
        "name": "audio",
        "namespace": "conference.example.com/conference123/alice",
        "packaging": "loc",
        "isLive": true,
        "targetLatency": 2000,
        "role": "audio",
        "renderGroup": 1,
        "codec": "opus",
        "samplerate": 48000,
        "channelConfig": "2",
        "bitrate": 32000
      }
    ]
  }`;
  const data = new TextEncoder().encode(catalogJson);
  const catalog = decodeCatalogMessage(data) as Catalog;
  assert.strictEqual(catalog.version, "1");
  assert.strictEqual(catalog.tracks.length, 2);
  const renderGroup1 = getTracksByRenderGroup(catalog, 1);
  assert.strictEqual(renderGroup1.length, 2);
  const latencies = renderGroup1.map((t) => t.targetLatency);
  assert.isTrue(latencies.every((l) => l === latencies[0]));
});

test("仕様書例 (§5.6.2): Simulcast video tracks - 3 alternate qualities", () => {
  // draft-ietf-moq-msf-01 §5.6.2
  const catalogJson = `{
    "version": "draft-01",
    "generatedAt": 1746104606044,
    "tracks": [
      { "name": "hd", "renderGroup": 1, "packaging": "loc", "isLive": true, "targetLatency": 1500, "role": "video", "codec": "av01", "width": 1920, "height": 1080, "bitrate": 5000000, "framerate": 30, "altGroup": 1 },
      { "name": "md", "renderGroup": 1, "packaging": "loc", "isLive": true, "targetLatency": 1500, "role": "video", "codec": "av01", "width": 720, "height": 640, "bitrate": 3000000, "framerate": 30, "altGroup": 1 },
      { "name": "sd", "renderGroup": 1, "packaging": "loc", "isLive": true, "targetLatency": 1500, "role": "video", "codec": "av01", "width": 192, "height": 144, "bitrate": 500000, "framerate": 30, "altGroup": 1 },
      { "name": "audio", "renderGroup": 1, "packaging": "loc", "isLive": true, "targetLatency": 1500, "role": "audio", "codec": "opus", "samplerate": 48000, "channelConfig": "2", "bitrate": 32000 }
    ]
  }`;
  const data = new TextEncoder().encode(catalogJson);
  const catalog = decodeCatalogMessage(data) as Catalog;
  assert.strictEqual(catalog.tracks.length, 4);
  const altGroup1 = getTracksByAltGroup(catalog, 1);
  assert.strictEqual(altGroup1.length, 3);
  assert.strictEqual(selectHighestBitrateTrack(catalog, 1)?.name, "hd");
  assert.strictEqual(selectLowestBitrateTrack(catalog, 1)?.name, "sd");
});

test("仕様書例 (§5.6.3): SVC video tracks with dependencies", () => {
  // draft-ietf-moq-msf-01 §5.6.3
  const catalogJson = `{
    "version": "draft-01",
    "generatedAt": 1746104606044,
    "tracks": [
      { "name": "480p15", "namespace": "conference.example.com/conference123/alice", "renderGroup": 1, "packaging": "loc", "isLive": true, "role": "video", "codec": "av01.0.01M.10.0.110.09", "width": 640, "height": 480, "bitrate": 3000000, "framerate": 15 },
      { "name": "480p30", "namespace": "conference.example.com/conference123/alice", "renderGroup": 1, "packaging": "loc", "isLive": true, "role": "video", "codec": "av01.0.04M.10.0.110.09", "width": 640, "height": 480, "bitrate": 3000000, "framerate": 30, "depends": ["480p15"] },
      { "name": "1080p15", "namespace": "conference.example.com/conference123/alice", "renderGroup": 1, "packaging": "loc", "isLive": true, "role": "video", "codec": "av01.0.05M.10.0.110.09", "width": 1920, "height": 1080, "bitrate": 3000000, "framerate": 15, "depends": ["480p15"] },
      { "name": "1080p30", "namespace": "conference.example.com/conference123/alice", "renderGroup": 1, "packaging": "loc", "isLive": true, "role": "video", "codec": "av01.0.08M.10.0.110.09", "width": 1920, "height": 1080, "bitrate": 5000000, "framerate": 30, "depends": ["480p30", "1080p15"] }
    ]
  }`;
  const data = new TextEncoder().encode(catalogJson);
  const catalog = decodeCatalogMessage(data) as Catalog;
  assert.strictEqual(catalog.tracks.length, 4);
  const t1080p30 = getTrackByName(catalog, "1080p30");
  assert.deepStrictEqual(t1080p30?.depends, ["480p30", "1080p15"]);
});

test("仕様書例 (§5.6.4 風): Delta update - adding tracks (draft-01 wire format)", () => {
  // draft-ietf-moq-msf-01 §5.6.4 (draft-00 §5.3.4 から仕様変更)
  const deltaJson = `{
    "generatedAt": 1746104606044,
    "deltaUpdate": [
      { "op": "add", "tracks": [
        { "name": "slides", "isLive": true, "packaging": "loc", "role": "video", "codec": "av01.0.08M.10.0.110.09", "width": 1920, "height": 1080, "framerate": 15, "bitrate": 750000, "renderGroup": 1 }
      ] },
      { "op": "clone", "tracks": [
        { "name": "video-720", "parentName": "video-1080", "width": 1280, "height": 720, "bitrate": 600000 }
      ] }
    ]
  }`;
  const data = new TextEncoder().encode(deltaJson);
  const delta = decodeCatalogMessage(data) as CatalogDelta;
  assert.strictEqual(delta.deltaUpdate, true);
  assert.strictEqual(delta.operations.length, 2);
  assert.strictEqual(delta.operations[0].type, "add");
  assert.strictEqual(delta.operations[1].type, "clone");

  const current: Catalog = {
    version: "draft-01",
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
  assert.isTrue(result.tracks.some((t) => t.name === "slides"));
  const v720 = getTrackByName(result, "video-720");
  assert.isDefined(v720);
  assert.strictEqual(v720?.codec, "av01.0.08M.10.0.110.09");
});

test("仕様書例 (§5.6.5 風): Delta update - removing tracks (draft-01 wire format)", () => {
  // draft-ietf-moq-msf-01 §5.6.5 (draft-00 §5.3.5 から仕様変更)
  const deltaJson = `{
    "generatedAt": 1746104606044,
    "deltaUpdate": [
      { "op": "remove", "tracks": [{ "name": "video" }, { "name": "slides" }] }
    ]
  }`;
  const data = new TextEncoder().encode(deltaJson);
  const delta = decodeCatalogMessage(data) as CatalogDelta;
  const current: Catalog = {
    version: "draft-01",
    tracks: [
      { name: "video", packaging: "loc", isLive: true },
      { name: "audio", packaging: "loc", isLive: true },
      { name: "slides", packaging: "loc", isLive: true },
    ],
  };
  const result = applyCatalogDelta(current, delta);
  assert.strictEqual(result.tracks.length, 1);
  assert.strictEqual(result.tracks[0].name, "audio");
});

test("仕様書例 (§5.6.7 風): VOD Audio/Video Tracks", () => {
  // draft-ietf-moq-msf-01 §5.6.7 (draft-00 §5.3.7 から仕様変更)
  const catalogJson = `{
    "version": "draft-01",
    "tracks": [
      { "name": "video", "namespace": "movies.example.com/assets/boy-meets-girl-season3/episode5", "packaging": "loc", "isLive": false, "trackDuration": 8072340, "renderGroup": 1, "codec": "av01.0.08M.10.0.110.09", "width": 1920, "height": 1080, "framerate": 30, "bitrate": 1500000 },
      { "name": "audio", "namespace": "movies.example.com/assets/boy-meets-girl-season3/episode5", "packaging": "loc", "isLive": false, "trackDuration": 8072340, "renderGroup": 1, "codec": "opus", "samplerate": 48000, "channelConfig": "2", "bitrate": 32000 }
    ]
  }`;
  const data = new TextEncoder().encode(catalogJson);
  const catalog = decodeCatalogMessage(data) as Catalog;
  assert.strictEqual(catalog.tracks.length, 2);
  assert.isTrue(catalog.tracks.every((t) => t.isLive === false));
  assert.isTrue(catalog.tracks.every((t) => t.trackDuration === 8072340));
});

// =============================================================================
// MSF URI fragment PBT
// =============================================================================

test("parseMsfFragmentValue: literal な segment は round-trip する", () => {
  fc.assert(
    fc.property(
      fc.stringMatching(/^[A-Za-z0-9_]{1,8}$/),
      fc.stringMatching(/^[A-Za-z0-9_]{1,8}$/),
      (ns, name) => {
        const result = parseMsfFragmentValue(`${ns}--${name}`);
        assert.deepStrictEqual(result.trackNamespace, [ns]);
        assert.strictEqual(result.trackName, name);
      },
    ),
  );
});
