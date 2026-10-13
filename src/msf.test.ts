/**
 * MSF (MOQT Streaming Format) の単体テスト (draft-ietf-moq-msf-01 追従)
 */

import { test, assert } from "vite-plus/test";
import {
  MSF_VERSION,
  MSF_KNOWN_VERSIONS,
  CATALOG_TRACK_NAME,
  type Catalog,
  type CatalogTrack,
  type CatalogDelta,
  type EventTimelineEntry,
  type InitDataEntry,
  type MediaTimelineEntry,
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
  resolveCatalogVariables,
  resolveInitData,
  parseMsfFragmentValue,
  getConnectionParameter,
  assertMsfConnectionSupported,
  getWallclockRanges,
  getMediatimeRanges,
  getLocationRanges,
  getC4mParameter,
  createC4mAuthorizationToken,
  resolveMsfAuthorizationToken,
  validateCatalog,
  validateCatalogTrack,
  catalogAuthInfoForSetupToken,
  isAudioCodec,
} from "./msf";
import { AuthorizationTokenAliasType } from "./message/authorizationToken";
import { effectiveTargetLatencyMs, resolveSharedTargetLatencyMs } from "./msf/tracks";
import { MsfCompressionAlgorithm } from "./properties";

// =============================================================================
// テスト用ヘルパー
// =============================================================================

/**
 * 任意のオブジェクトを JSON バイト列にエンコードする
 */
function encodeRaw(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

/** JSON 文字列をそのままバイト列にする (`__proto__` を own property として持つ入力の組み立てに使う) */
function encodeRawJson(json: string): Uint8Array {
  return new TextEncoder().encode(json);
}

/** `__proto__` が own data property として保持され、`[[Prototype]]` が差し替わっていないことを検証する */
function assertOwnProtoField(value: object, expected: unknown): void {
  assert.strictEqual(Object.getPrototypeOf(value), Object.prototype);
  assert.isTrue(Object.hasOwn(value, "__proto__"));
  assert.deepEqual(Object.getOwnPropertyDescriptor(value, "__proto__"), {
    value: expected,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

// =============================================================================
// 定数 / バージョン
// =============================================================================

test("MSF_VERSION: encode 時は draft-01 を出力する (§5.1.1)", () => {
  assert.strictEqual(MSF_VERSION, "draft-01");
});

test("MSF_KNOWN_VERSIONS: draft-01 と 1 を受理する (§5.1.1)", () => {
  // draft-01 は Internet-Draft 段階の正規表記、1 は将来 RFC リリース版用の non-normative 例
  assert.isTrue(MSF_KNOWN_VERSIONS.has("draft-01"));
  assert.isTrue(MSF_KNOWN_VERSIONS.has("1"));
});

// =============================================================================
// Catalog エンコード/デコード
// =============================================================================

test("Catalog: フルカタログの round-trip (draft-01)", () => {
  const catalog: Catalog = {
    version: "draft-01",
    tracks: [{ name: "video", packaging: "loc", isLive: true }],
  };
  const encoded = encodeCatalog(catalog);
  const decoded = decodeCatalogMessage(encoded);
  assert.deepStrictEqual(decoded, catalog);
});

test("Catalog: 文字列 1 も decode 受理する (§5.1.1 non-normative 例)", () => {
  const raw = { version: "1", tracks: [{ name: "video", packaging: "loc", isLive: true }] };
  const decoded = decodeCatalogMessage(encodeRaw(raw)) as Catalog;
  assert.strictEqual(decoded.version, "1");
});

test("Catalog: draft-00 形式 (number 1) は unsupported version で reject", () => {
  const raw = { version: 1, tracks: [] };
  assert.throws(() => decodeCatalogMessage(encodeRaw(raw)), /version must be a string/);
});

test("Catalog: 未知 version 文字列は unsupported version で reject (§5.1.1)", () => {
  const raw = { version: "draft-99", tracks: [] };
  assert.throws(() => decodeCatalogMessage(encodeRaw(raw)), /unsupported MSF version 'draft-99'/);
});

test("Catalog: draft-00 は unsupported version で reject (§5.1.1)", () => {
  const raw = { version: "draft-00", tracks: [] };
  assert.throws(() => decodeCatalogMessage(encodeRaw(raw)), /unsupported MSF version 'draft-00'/);
});

test("Catalog: tracks が配列でない場合は reject (§5.1.4)", () => {
  const raw = { version: "draft-01", tracks: "not an array" };
  assert.throws(() => decodeCatalogMessage(encodeRaw(raw)), /tracks must be an array/);
});

test("Catalog: トラック必須フィールド (name/packaging/isLive) 欠落で reject", () => {
  // name only
  assert.throws(
    () => decodeCatalogMessage(encodeRaw({ version: "draft-01", tracks: [{ name: "v" }] })),
    /packaging must be a string/,
  );
});

test("Catalog: isComplete=false を含む場合は reject (§5.1.3)", () => {
  // §5.1.3: This field MUST NOT be included if it is FALSE.
  const raw = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true }],
    isComplete: false,
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(raw)),
    /isComplete must not be included if false/,
  );
});

test("Catalog: encode 時に isComplete=false が指定されたら reject (§5.1.3)", () => {
  // 内部的に呼び出すケース: isComplete: false の手書き Catalog を encode に渡した場合
  const catalog = {
    version: "draft-01",
    tracks: [],
    isComplete: false,
  } as unknown as Catalog;
  assert.throws(
    () => encodeCatalog(catalog),
    /isComplete must not be included if false per §5\.1\.3, got false/,
  );
});

test("Catalog: encode 時に isComplete が boolean でない値なら reject (§5.1.3)", () => {
  // §5.1.3 は JSON Type: Boolean。非 boolean を黙って落とすと §5.1.3 の型違反を黙認することに
  // なるため、wire に載せたうえで自己 decode (decode と同じ文言) に拒否させる。
  const catalog = {
    version: "draft-01",
    tracks: [],
    isComplete: "yes",
  } as unknown as Catalog;
  assert.throws(
    () => encodeCatalog(catalog),
    /isComplete must not be included if false per §5\.1\.3, got yes/,
  );
});

// §5.1.3 の isComplete は wire に出る形で判定する。値が undefined の own property は
// JSON.stringify が出力せず、継承した値は JSON.stringify が読まない。
test("Catalog: encode は isComplete の own property だけを wire に載せる (§5.1.3)", () => {
  const undefinedIsComplete = {
    version: "draft-01",
    tracks: [],
    isComplete: undefined,
  } as unknown as Catalog;
  const decoded = decodeCatalogMessage(encodeCatalog(undefinedIsComplete)) as Catalog;
  assert.isFalse(Object.hasOwn(decoded, "isComplete"));

  const inheritedIsComplete = Object.create({ isComplete: true }) as Record<string, unknown>;
  inheritedIsComplete.version = "draft-01";
  inheritedIsComplete.tracks = [];
  const inheritedDecoded = decodeCatalogMessage(
    encodeCatalog(inheritedIsComplete as unknown as Catalog),
  ) as Catalog;
  assert.isFalse(Object.hasOwn(inheritedDecoded, "isComplete"));
});

// root の未知フィールド `deltaUpdate` は decode を delta update の経路に落とす。full catalog を
// 名乗る関数が delta のバイト列を返さないことを固定する (§5.1.6)。
test("Catalog: encodeCatalog は root に deltaUpdate を持つ Catalog を delta として返さない", () => {
  // version と tracks が wire に無いと、decode は delta update として読む
  const withoutVersion = {
    tracks: undefined as unknown as CatalogTrack[],
    deltaUpdate: [{ op: "remove", tracks: [{ name: "x" }] }],
  } as unknown as Catalog;
  assert.throws(() => encodeCatalog(withoutVersion), /read as a delta update per §5\.1\.6/);

  // version がある場合は delta に含めてはならないフィールドとして拒否される (§5.3)
  const withVersion = {
    version: "draft-01",
    tracks: [],
    deltaUpdate: [],
  } as unknown as Catalog;
  assert.throws(
    () => encodeCatalog(withVersion),
    /invalid catalog delta: deltaUpdate must not contain MSF version field per §5\.3/,
  );
});

// JSON.parse は桁あふれした数値リテラル (1e999) を Infinity にする。生成日時も有限数でなければ
// 再 encode で null になり自分で decode できなくなるため、decode の時点で拒否する (§5.1.2)。
test("Catalog: decode は桁あふれした generatedAt を非有限数として reject する (§5.1.2)", () => {
  assert.throws(
    () =>
      decodeCatalogMessage(encodeRawJson('{"version":"draft-01","tracks":[],"generatedAt":1e999}')),
    /generatedAt must be a finite number per §5\.1\.2, got Infinity/,
  );
});

// 実行時には JavaScript から組み立てた delta で配列や object の型が崩れ得る。`length` や `type` を
// 無条件に読むと TypeError になり、「検証違反は plain Error」という契約から外れるため拒否する
// (operations が配列でない場合は §5.3 の「at least one operation」の文言にまとめ、operation が
// object でない場合は decode と同じ文言にする)。
test("CatalogDelta: operations が配列でない / operation が object でない場合は plain Error で reject する", () => {
  const nullOperations = { deltaUpdate: true, operations: null } as unknown as CatalogDelta;
  assert.throws(
    () => encodeCatalogDelta(nullOperations),
    /deltaUpdate must contain at least one operation per §5\.3/,
  );

  const nullOperation = { deltaUpdate: true, operations: [null] } as unknown as CatalogDelta;
  assert.throws(
    () => encodeCatalogDelta(nullOperation),
    /invalid catalog delta operation at index 0: expected object, got null/,
  );
});

test("CatalogDelta: 非有限数の generatedAt は encode / decode とも reject する (§5.1.2)", () => {
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "remove", tracks: [{ name: "x" }] }],
    generatedAt: Number.POSITIVE_INFINITY,
  };
  assert.throws(
    () => encodeCatalogDelta(delta),
    /generatedAt must be a finite number per §5\.1\.2, got Infinity/,
  );

  assert.throws(
    () =>
      decodeCatalogMessage(
        encodeRawJson(
          '{"deltaUpdate":[{"op":"remove","tracks":[{"name":"x"}]}],"generatedAt":1e999}',
        ),
      ),
    /generatedAt must be a finite number per §5\.1\.2, got Infinity/,
  );
});

// =============================================================================
// encode / 生成時の track 単位 MUST 検証
// =============================================================================
// §5.2 の track 単位 MUST は decode 側 (validateCatalog) だけでなく、Catalog の生成
// (createCatalog) と送信 (encodeCatalog) の時点でも検証する。仕様違反の Catalog を
// ライブラリ自身が送り、相互接続の相手に拒否されたり自分の decodeCatalogMessage で
// 読めなくなったりする経路を塞ぐためである。検証は decode と同じ関数を通すため、
// エラー文言も受信側と一致する。

// §5.2.3: Within the catalog, track names MUST be unique per namespace.
// 「Within the catalog」は tracks と publishTracks の両方を含む。
test("Catalog: encodeCatalog は tracks と publishTracks をまたぐ重複を reject する (§5.2.3)", () => {
  const catalog: Catalog = {
    version: "draft-01",
    tracks: [{ name: "log", packaging: "loc", isLive: true }],
    publishTracks: [{ name: "log", packaging: "moqlog", role: "log", isLive: true }],
  };
  assert.throws(
    () => encodeCatalog(catalog),
    /duplicate track name 'log' under namespace \(no namespace\) in publishTracks per §5\.2\.3/,
  );
});

// §5.2.13: initRef は initDataList (§5.1.7) のエントリを指す。参照切れの Catalog は
// 復号器の初期化データが無いまま configure へ進むため、encode の時点で拒否する。
test("Catalog: encodeCatalog は initRef の参照切れを reject する (§5.2.13)", () => {
  const catalog: Catalog = {
    version: "draft-01",
    tracks: [{ name: "video", packaging: "loc", isLive: true, initRef: "missing" }],
    initDataList: [{ id: "v-init", type: "inline", data: "AQID" }],
  };
  assert.throws(
    () => encodeCatalog(catalog),
    /track 'video' has initRef 'missing' not present in initDataList per §5\.2\.13/,
  );
});

test("Catalog: encodeCatalog は packaging 別 MUST を reject する (§5.2.5 / §9.4 / §10.4)", () => {
  // §9.4: packaging="moqlog" の track は role="log" が MUST
  const moqlog: Catalog = {
    version: "draft-01",
    tracks: [],
    publishTracks: [{ name: "log", packaging: "moqlog", isLive: true }],
  };
  assert.throws(
    () => encodeCatalog(moqlog),
    /moqlog track must have role='log' per §9\.4, got '\(absent\)'/,
  );

  // §10.4: packaging="moqmetrics" の track は role="metrics" が MUST
  const moqmetrics: Catalog = {
    version: "draft-01",
    tracks: [],
    publishTracks: [{ name: "metrics", packaging: "moqmetrics", isLive: true }],
  };
  assert.throws(
    () => encodeCatalog(moqmetrics),
    /moqmetrics track must have role='metrics' per §10\.4, got '\(absent\)'/,
  );

  // §5.2.5: eventType は packaging="eventtimeline" のときだけ使える
  const eventType: Catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, eventType: "com.example.chat" }],
  };
  assert.throws(
    () => encodeCatalog(eventType),
    /eventType must not be used unless packaging is 'eventtimeline' per §5\.2\.5/,
  );
});

test("Catalog: encodeCatalog は role=video / audio の必須フィールド欠落を reject する (§5.2.18 / §5.2.22)", () => {
  // §5.2.18: role=video は codec が MUST
  assert.throws(
    () =>
      encodeCatalog({
        version: "draft-01",
        tracks: [{ name: "v", packaging: "loc", isLive: true, role: "video", bitrate: 1_000_000 }],
      }),
    /video track must include codec per §5\.2\.18/,
  );

  // §5.2.22: role=video は bitrate が MUST
  assert.throws(
    () =>
      encodeCatalog({
        version: "draft-01",
        tracks: [{ name: "v", packaging: "loc", isLive: true, role: "video", codec: "vp8" }],
      }),
    /video track must include bitrate per §5\.2\.22/,
  );

  // §5.2.18: role=audio も codec が MUST
  assert.throws(
    () =>
      encodeCatalog({
        version: "draft-01",
        tracks: [{ name: "a", packaging: "loc", isLive: true, role: "audio", bitrate: 128_000 }],
      }),
    /audio track must include codec per §5\.2\.18/,
  );

  // §5.2.22: role=audio も bitrate が MUST
  assert.throws(
    () =>
      encodeCatalog({
        version: "draft-01",
        tracks: [{ name: "a", packaging: "loc", isLive: true, role: "audio", codec: "opus" }],
      }),
    /audio track must include bitrate per §5\.2\.22/,
  );
});

// role は optional であり custom role も許されるため、role を持たない最小形の track には
// §5.2.18 / §5.2.22 を課さない (従来どおり encode できる)。§5.2.28 / §5.2.29 は codec 条件で
// あり、codec を持たないこの track には課さない。role が video の必須フィールドは publishTracks
// 経由の既存テストが固定しているため、ここでは role を持たない track と、role=audio で必要な
// フィールドが揃った track だけを確かめる。
test("Catalog: encodeCatalog は role を持たない track と必須フィールドを満たす audio track を encode する", () => {
  const catalog: Catalog = {
    version: "draft-01",
    tracks: [
      { name: "raw", packaging: "loc", isLive: true },
      {
        name: "audio",
        packaging: "loc",
        isLive: true,
        role: "audio",
        codec: "opus",
        bitrate: 128_000,
        samplerate: 48_000,
        channelConfig: "2",
      },
    ],
  };
  const decoded = decodeCatalogMessage(encodeCatalog(catalog)) as Catalog;
  assert.deepStrictEqual(
    decoded.tracks.map((track) => track.name),
    ["raw", "audio"],
  );
});

// JSON.stringify は値が undefined のプロパティを出力しないため、そのようなフィールドは
// wire に現れない (受け手からは未指定に見える)。送っても問題のない Catalog を encode 時に
// 拒否しないことを固定する (exactOptionalPropertyTypes の型では書けないが、JavaScript から
// 組み立てた object には現れる)。
test("Catalog: encodeCatalog は JSON に出ない undefined の値のフィールドを未指定として扱う", () => {
  const catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, displayHeight: undefined }],
  } as unknown as Catalog;
  const decoded = decodeCatalogMessage(encodeCatalog(catalog)) as Catalog;
  assert.isUndefined(decoded.tracks[0].displayHeight);
});

// JSON.stringify は関数値とシンボル値のプロパティも出力しない。
test("Catalog: encodeCatalog は JSON に出ない関数値のフィールドを未指定として扱う", () => {
  const catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, displayHeight: () => 1 }],
  } as unknown as Catalog;
  const decoded = decodeCatalogMessage(encodeCatalog(catalog)) as Catalog;
  assert.isUndefined(decoded.tracks[0].displayHeight);
});

test("Catalog: encodeCatalog は JSON に出ないシンボル値のフィールドを未指定として扱う", () => {
  const catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, displayHeight: Symbol("height") }],
  } as unknown as Catalog;
  const decoded = decodeCatalogMessage(encodeCatalog(catalog)) as Catalog;
  assert.isUndefined(decoded.tracks[0].displayHeight);
});

// JSON.stringify は疎配列の穴を null にする。encode は送る JSON を decode で検証するため、
// 穴を読み飛ばす検証 (every) に頼らず wire の null として拒否できる。
test("Catalog: encodeCatalog は depends の穴を wire と同じ null として reject する", () => {
  const depends: string[] = [];
  depends[1] = "video";
  const catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, depends }],
  } as unknown as Catalog;
  assert.throws(() => encodeCatalog(catalog), /depends must be an array of strings per §5\.2\.14/);
});

// JSON は非有限数 (NaN / ±Infinity) を null にするため、wire では §5.2 の number でなくなる。
// encode は送る JSON を decode で検証するため、decode と同じ文言で拒否される。
test("Catalog: encodeCatalog は非有限数のフィールドを reject する", () => {
  assert.throws(
    () =>
      encodeCatalog({
        version: "draft-01",
        tracks: [{ name: "v", packaging: "loc", isLive: true, bitrate: Number.NaN }],
      }),
    /bitrate must be a number per §5\.2\.22, got object/,
  );

  assert.throws(
    () =>
      encodeCatalog({
        version: "draft-01",
        tracks: [{ name: "v", packaging: "loc", isLive: true, width: Number.POSITIVE_INFINITY }],
      }),
    /width must be a number per §5\.2\.26, got object/,
  );

  // template の number 要素 (§7.4.1) は変換の前の検証で拒否される
  assert.throws(
    () =>
      encodeCatalog({
        version: "draft-01",
        tracks: [
          {
            name: "vod",
            packaging: "loc",
            isLive: false,
            template: [Number.NaN, 0, [0n, 0n], [0n, 0n], 0, 0],
          },
        ],
      }),
    /template startMediaTime must be a finite number per §7\.4\.1, got NaN/,
  );
});

// JSON.parse は桁あふれした数値リテラル (1e999) を Infinity にする。wire では number だが
// 有限でなく、再 encode すると null になって自分で decode できなくなるため、decode の時点で
// 拒否する (`JSON.stringify` は非有限数を null にする。ECMA-262 の SerializeJSONProperty)。
test("Catalog: decode は桁あふれした数値リテラルを非有限数として reject する (§5.2.22)", () => {
  const raw =
    '{"version":"draft-01","tracks":[{"name":"v","packaging":"loc","isLive":true,"bitrate":1e999}]}';
  assert.throws(
    () => decodeCatalogMessage(encodeRawJson(raw)),
    /bitrate must be a finite number per §5\.2\.22, got Infinity/,
  );
});

// §5.1.7: initDataList のエントリと id の uniqueness。decode と同じ関数を通すため、壊れた
// entry は TypeError ではなく decode と同じ文言の plain Error になる。
test("Catalog: encodeCatalog と createCatalog は initDataList の構造違反を reject する", () => {
  const notAnObject = {
    version: "draft-01",
    tracks: [],
    initDataList: [null],
  } as unknown as Catalog;
  assert.throws(
    () => encodeCatalog(notAnObject),
    /invalid initDataList entry at index 0: expected object, got null/,
  );
  assert.throws(
    () => createCatalog([], { initDataList: [null] as unknown as InitDataEntry[] }),
    /invalid initDataList entry at index 0: expected object, got null/,
  );

  const duplicatedIds: Catalog = {
    version: "draft-01",
    tracks: [],
    initDataList: [
      { id: "init-1", type: "inline", data: "AQID" },
      { id: "init-1", type: "inline", data: "AQID" },
    ],
  };
  assert.throws(
    () => encodeCatalog(duplicatedIds),
    /duplicate initDataList id 'init-1', ids must be unique within the catalog per §5\.1\.7/,
  );
});

// JavaScript から組み立てた Catalog では、配列であるべきフィールドが何でもあり得る。`map` や
// `template` を無条件に読むと TypeError になり、「検証違反は plain Error」という契約から外れる
// ため、decode と同じ文言の plain Error で拒否する。
test("Catalog: encodeCatalog と createCatalog は配列でない tracks / publishTracks を reject する", () => {
  const missingTracks = { version: "draft-01" } as unknown as Catalog;
  assert.throws(
    () => encodeCatalog(missingTracks),
    /invalid catalog: tracks must be an array per §5\.1\.4, got undefined/,
  );

  const nullTracks = { version: "draft-01", tracks: null } as unknown as Catalog;
  assert.throws(
    () => encodeCatalog(nullTracks),
    /invalid catalog: tracks must be an array per §5\.1\.4, got object/,
  );

  const stringPublishTracks = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true }],
    publishTracks: "abc",
  } as unknown as Catalog;
  assert.throws(
    () => encodeCatalog(stringPublishTracks),
    /invalid catalog: publishTracks must be an array per §5\.1\.5, got string/,
  );

  assert.throws(
    () => createCatalog(null as unknown as CatalogTrack[]),
    /invalid catalog: tracks must be an array per §5\.1\.4, got object/,
  );
});

test("Catalog: encodeCatalog は配列内の object でない要素と配列でない template を reject する", () => {
  // object でない要素は decode 側の検証 (expected object) に委ねる
  const nullElement = {
    version: "draft-01",
    tracks: [null],
  } as unknown as Catalog;
  assert.throws(() => encodeCatalog(nullElement), /invalid track: expected object, got null/);

  // template が配列でない場合は 6 要素の検証で拒否する (要素数を読んで TypeError にしない)
  const notArrayTemplate = {
    version: "draft-01",
    tracks: [{ name: "vod", packaging: "loc", isLive: false, template: "abc" }],
  } as unknown as Catalog;
  assert.throws(
    () => encodeCatalog(notArrayTemplate),
    /template must be a 6-element array per §7\.4\.1, got string/,
  );

  // 配列だが 6 要素未満の場合も、要素を読む前に decode と同じ文言で拒否する
  const shortTemplate = {
    version: "draft-01",
    tracks: [{ name: "vod", packaging: "loc", isLive: false, template: [0, 0] }],
  } as unknown as Catalog;
  assert.throws(
    () => encodeCatalog(shortTemplate),
    /template must be a 6-element array per §7\.4\.1, got array of length 2/,
  );

  // Location が 2 要素配列でない場合も同じ
  const badLocationTemplate = {
    version: "draft-01",
    tracks: [{ name: "vod", packaging: "loc", isLive: false, template: [0, 0, null, null, 0, 0] }],
  } as unknown as Catalog;
  assert.throws(
    () => encodeCatalog(badLocationTemplate),
    /template startLocation must be a 2-element array per §7\.4\.1, got object/,
  );
});

// §7.2 / §8.2 の packaging 別 MUST (depends / mimeType) も encode の時点で拒否する。
test("Catalog: encodeCatalog は §7.2 / §8.2 の depends / mimeType の MUST を reject する", () => {
  assert.throws(
    () =>
      encodeCatalog({
        version: "draft-01",
        tracks: [
          { name: "t", packaging: "mediatimeline", isLive: true, mimeType: "application/json" },
        ],
      }),
    /mediatimeline track must include depends per §7\.2/,
  );

  assert.throws(
    () =>
      encodeCatalog({
        version: "draft-01",
        tracks: [
          {
            name: "t",
            packaging: "eventtimeline",
            isLive: true,
            eventType: "com.example.chat",
            depends: [],
          },
        ],
      }),
    /eventtimeline track must have mimeType='application\/json' per §8\.2, got '\(absent\)'/,
  );
});

test("Catalog: encodeCatalog の JSON フィールド順序は version→...→tracks→publishTracks→initDataList (§5.1.7)", () => {
  // §5.1.7: The Initialization Data List, if present, MUST be located after the tracks array.
  // publishTracks の moqlog track は §9.4 が role="log" を MUST とするため付ける
  // (encode 時にも track 単位の MUST を検証する)。
  const catalog: Catalog = {
    version: "draft-01",
    tracks: [{ name: "video", packaging: "loc", isLive: true }],
    initDataList: [{ id: "v-init", type: "inline", data: "AQID" }],
    publishTracks: [{ name: "log", packaging: "moqlog", role: "log", isLive: true }],
  };
  const json = new TextDecoder().decode(encodeCatalog(catalog));
  const tracksAt = json.indexOf('"tracks"');
  const publishTracksAt = json.indexOf('"publishTracks"');
  const initDataListAt = json.indexOf('"initDataList"');
  assert.isTrue(tracksAt < publishTracksAt);
  assert.isTrue(publishTracksAt < initDataListAt);
});

test("Catalog: tracks 配列内 (name, namespace) タプル重複は reject (§5.2.3)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [
      { name: "video", packaging: "loc", isLive: true, namespace: "room1" },
      { name: "video", packaging: "loc", isLive: true, namespace: "room1" },
    ],
  };
  assert.throws(() => decodeCatalogMessage(encodeRaw(catalog)), /duplicate track name 'video'/);
});

test("Catalog: tracks と publishTracks をまたぐ (name, namespace) 重複は reject (§5.2.3)", () => {
  // §5.2.3: "Within the catalog, track names MUST be unique per namespace."
  // 「Within the catalog」は両配列を含むため、subscribe 用と publish 用の同名共存は拒否する。
  // 違反した track の由来 (publishTracks) がエラー文言に含まれる。
  const catalog = {
    version: "draft-01",
    tracks: [{ name: "log", packaging: "loc", isLive: true }],
    publishTracks: [{ name: "log", packaging: "moqlog", role: "log", isLive: true }],
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(catalog)),
    /duplicate track name 'log' under namespace \(no namespace\) in publishTracks per §5\.2\.3/,
  );
});

test("Catalog: tracks と publishTracks で namespace が異なれば同名でも受理される (§5.2.3)", () => {
  const catalog: Catalog = {
    version: "draft-01",
    tracks: [{ name: "video", packaging: "loc", isLive: true, namespace: "room1" }],
    publishTracks: [
      {
        name: "video",
        packaging: "loc",
        isLive: true,
        namespace: "room2",
        role: "video",
        codec: "av01",
        bitrate: 1,
      },
    ],
  };
  const decoded = decodeCatalogMessage(encodeCatalog(catalog)) as Catalog;
  assert.strictEqual(decoded.tracks[0].name, "video");
  assert.strictEqual(decoded.publishTracks?.[0].name, "video");
});

// isAudioCodec は WebCodecs Codec Registry §3 Audio Codec Registry の codec string を受理し、
// 高レベル API の parseAudioCodec が扱う opus / mp4a を含む (判定が狭まると §5.2.28 / §5.2.29
// の MUST が抜けるため、登録済みの audio codec を網羅する)。
test("isAudioCodec: Audio Codec Registry の codec string を受理する (§5.2.28 / §5.2.29)", () => {
  for (const codec of [
    "alaw",
    "flac",
    "mp3",
    "mp4a.40.2",
    "mp4a.69",
    "opus",
    "pcm-s16",
    "pcm-f32",
    "ulaw",
    "vorbis",
  ]) {
    assert.isTrue(isAudioCodec(codec), codec);
  }
});

test("isAudioCodec: video codec と未知の codec は audio codec と判定しない", () => {
  for (const codec of [
    "av01.0.04M.08",
    "avc1.42001f",
    "hvc1.1.6.L93.B0",
    "vp8",
    "vp09.00.10.08",
    "com.example.custom",
  ]) {
    assert.isFalse(isAudioCodec(codec), codec);
  }
});

test("Catalog: role=video で codec が無いと reject (§5.2.18)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, role: "video", bitrate: 1000 }],
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(catalog)),
    /invalid track 'v': video track must include codec per §5\.2\.18/,
  );
});

test("Catalog: role=video で bitrate が無いと reject (§5.2.22)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, role: "video", codec: "av01" }],
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(catalog)),
    /invalid track 'v': video track must include bitrate per §5\.2\.22/,
  );
});

test("Catalog: role=audio で codec が無いと reject (§5.2.18。role 条件)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [
      {
        name: "a",
        packaging: "loc",
        isLive: true,
        role: "audio",
        bitrate: 128000,
        samplerate: 48000,
        channelConfig: "2",
      },
    ],
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(catalog)),
    /invalid track 'a': audio track must include codec per §5\.2\.18/,
  );
});

test("Catalog: role=audio で bitrate が無いと reject (§5.2.22。role 条件)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [
      {
        name: "a",
        packaging: "loc",
        isLive: true,
        role: "audio",
        codec: "opus",
        samplerate: 48000,
        channelConfig: "2",
      },
    ],
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(catalog)),
    /invalid track 'a': audio track must include bitrate per §5\.2\.22/,
  );
});

// §5.2.28 / §5.2.29 は packaging にも依存しない。moqlog / moqmetrics の track は codec を
// 要求されない (§9.4 / §10.4) が、audio codec を持つなら samplerate / channelConfig が MUST。
test("Catalog: moqlog の track でも audio codec を持てば samplerate が MUST (§5.2.28)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [],
    publishTracks: [{ name: "log", packaging: "moqlog", role: "log", isLive: true, codec: "opus" }],
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(catalog)),
    /invalid track 'log': audio track must include samplerate per §5\.2\.28/,
  );
});

// §5.2.28 / §5.2.29 の条件は「audio codecs are specified」であり role ではない
// (draft-ietf-moq-msf-01 §5.2.6 Table 5 の audio 系 role は audio と audiodescription で、
// custom role も許される)。audio codec を持つ track には role によらず必須にする。
test("Catalog: role=audiodescription で audio codec を持ち samplerate が無いと reject (§5.2.28)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [
      {
        name: "a",
        packaging: "loc",
        isLive: true,
        role: "audiodescription",
        codec: "opus",
        bitrate: 128000,
        channelConfig: "2",
      },
    ],
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(catalog)),
    /invalid track 'a': audio track must include samplerate per §5\.2\.28/,
  );
});

test("Catalog: role 未指定で audio codec を持ち channelConfig が無いと reject (§5.2.29)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [
      {
        name: "a",
        packaging: "loc",
        isLive: true,
        codec: "opus",
        samplerate: 48000,
      },
    ],
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(catalog)),
    /invalid track 'a': audio track must include channelConfig per §5\.2\.29/,
  );
});

test("Catalog: custom role で audio codec を持ち samplerate が無いと reject (§5.2.28)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [
      {
        name: "a",
        packaging: "loc",
        isLive: true,
        role: "com.example.commentary",
        codec: "mp4a.40.2",
        bitrate: 128000,
        channelConfig: "2",
      },
    ],
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(catalog)),
    /invalid track 'a': audio track must include samplerate per §5\.2\.28/,
  );
});

// §5.2.28 / §5.2.29 は audio codec が条件であるため、role=audio でも codec が audio codec で
// なければ課さない (codec / bitrate の必須は §5.2.18 / §5.2.22 として残る)。
test("Catalog: role=audio でも audio codec でなければ samplerate / channelConfig を課さない", () => {
  const catalog: Catalog = {
    version: "draft-01",
    tracks: [
      {
        name: "a",
        packaging: "loc",
        isLive: true,
        role: "audio",
        codec: "com.example.custom",
        bitrate: 128000,
      },
    ],
  };
  const decoded = decodeCatalogMessage(encodeCatalog(catalog)) as Catalog;
  assert.strictEqual(decoded.tracks[0].codec, "com.example.custom");
});

test("Catalog: encodeCatalog も role 未指定で audio codec の samplerate 欠落を reject する (§5.2.28)", () => {
  assert.throws(
    () =>
      encodeCatalog({
        version: "draft-01",
        tracks: [{ name: "a", packaging: "loc", isLive: true, codec: "opus", channelConfig: "2" }],
      }),
    /audio track must include samplerate per §5\.2\.28/,
  );
});

test("Catalog: encodeCatalog も role 未指定で audio codec の channelConfig 欠落を reject する (§5.2.29)", () => {
  assert.throws(
    () =>
      encodeCatalog({
        version: "draft-01",
        tracks: [{ name: "a", packaging: "loc", isLive: true, codec: "opus", samplerate: 48000 }],
      }),
    /audio track must include channelConfig per §5\.2\.29/,
  );
});

// 検証順は packaging 別 MUST → role 条件 (codec → bitrate) → codec 条件 (samplerate →
// channelConfig)。role=audio の代表ケースで、どのエラーが先に報告されるかを固定する
// (入力は既存テストと同じ組み合わせを使い、報告されるエラーの優先順位だけを確かめる)。
test("Catalog: role=audio の欠落は codec / bitrate (§5.2.18 / §5.2.22) が samplerate より先に報告される", () => {
  // bitrate と samplerate の両方が無いときは role 条件の bitrate が先
  assert.throws(
    () =>
      decodeCatalogMessage(
        encodeRaw({
          version: "draft-01",
          tracks: [{ name: "a", packaging: "loc", isLive: true, role: "audio", codec: "opus" }],
        }),
      ),
    /audio track must include bitrate per §5\.2\.22/,
  );

  // bitrate があり samplerate と channelConfig が無いときは samplerate が先
  assert.throws(
    () =>
      decodeCatalogMessage(
        encodeRaw({
          version: "draft-01",
          tracks: [
            {
              name: "a",
              packaging: "loc",
              isLive: true,
              role: "audio",
              codec: "opus",
              bitrate: 128000,
            },
          ],
        }),
      ),
    /audio track must include samplerate per §5\.2\.28/,
  );
});

test("Catalog: audio codec を持ち role=audio の track で samplerate が無いと reject (§5.2.28)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [
      {
        name: "a",
        packaging: "loc",
        isLive: true,
        role: "audio",
        codec: "opus",
        bitrate: 128000,
        channelConfig: "2",
      },
    ],
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(catalog)),
    /invalid track 'a': audio track must include samplerate per §5\.2\.28/,
  );
});

test("Catalog: audio codec を持ち role=audio の track で channelConfig が無いと reject (§5.2.29)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [
      {
        name: "a",
        packaging: "loc",
        isLive: true,
        role: "audio",
        codec: "opus",
        bitrate: 128000,
        samplerate: 48000,
      },
    ],
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(catalog)),
    /invalid track 'a': audio track must include channelConfig per §5\.2\.29/,
  );
});

test("Catalog: tracks の initRef の参照切れも reject (§5.2.13)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, initRef: "missing" }],
    initDataList: [],
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(catalog)),
    /invalid catalog: track 'v' has initRef 'missing' not present in initDataList per §5\.2\.13/,
  );
});

test("Catalog: initDataList の id 自体が変数を含む場合は initRef を検証しない (§5.4)", () => {
  // 置換後の id は判定できないため、参照切れを確定できない
  const catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, initRef: "init1" }],
    initDataList: [{ id: "%init%", type: "inline", data: "AAAA" }],
  };
  const decoded = decodeCatalogMessage(encodeRaw(catalog)) as Catalog;
  assert.strictEqual(decoded.tracks[0].initRef, "init1");
});

test("Catalog: publishTracks の initRef の参照切れも reject (§5.2.13)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [],
    publishTracks: [{ name: "v", packaging: "loc", isLive: true, initRef: "missing" }],
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(catalog)),
    /invalid catalog: track 'v' has initRef 'missing' not present in initDataList per §5\.2\.13/,
  );
});

test("Catalog: initRef は type を問わず initDataList のエントリを指せば受理される (§5.2.13)", () => {
  // 参照先の有無だけを見て type は問わない (inline / inline 以外の両方)
  const catalog = {
    version: "draft-01",
    tracks: [
      { name: "v", packaging: "loc", isLive: true, initRef: "init1" },
      { name: "a", packaging: "loc", isLive: true, initRef: "init2" },
    ],
    initDataList: [
      { id: "init1", type: "inline", data: "AAAA" },
      { id: "init2", type: "uri", data: "https://example.com/init.mp4" },
    ],
  };
  const decoded = decodeCatalogMessage(encodeRaw(catalog)) as Catalog;
  assert.strictEqual(decoded.tracks[0].initRef, "init1");
  assert.strictEqual(decoded.tracks[1].initRef, "init2");
});

test("Catalog: initRef の §5.4 変数の判定は値の途中に % がある場合も対象外になる (§5.4)", () => {
  // §5.4.1 は %name% が値の任意位置に現れ得るため、前方一致ではなく部分一致で判定する
  const catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, initRef: "prefix-%init%" }],
  };
  const decoded = decodeCatalogMessage(encodeRaw(catalog)) as Catalog;
  assert.strictEqual(decoded.tracks[0].initRef, "prefix-%init%");
});

test("Catalog: initDataList の id の途中に % がある場合も initRef を検証しない (§5.4)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, initRef: "init1" }],
    initDataList: [{ id: "init-%x%", type: "inline", data: "AAAA" }],
  };
  const decoded = decodeCatalogMessage(encodeRaw(catalog)) as Catalog;
  assert.strictEqual(decoded.tracks[0].initRef, "init1");
});

test("Catalog: initRef の参照切れ判定は §5.4 の変数を含む値を対象外にする (§5.4)", () => {
  // 置換前の値は参照先を判定できないため、未解決の %name% は拒否しない
  const catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, initRef: "%init%" }],
  };
  const decoded = decodeCatalogMessage(encodeRaw(catalog)) as Catalog;
  assert.strictEqual(decoded.tracks[0].initRef, "%init%");
});

test("Catalog: publishTracks 配列内の name uniqueness 違反は reject (§5.2.3)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [],
    publishTracks: [
      { name: "log", packaging: "moqlog", role: "log", isLive: true },
      { name: "log", packaging: "moqlog", role: "log", isLive: true },
    ],
  };
  assert.throws(() => decodeCatalogMessage(encodeRaw(catalog)), /duplicate track name 'log'/);
});

test("Catalog: targetLatency と buffers の併存は reject (§5.2.8/§5.2.9)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [
      {
        name: "v",
        packaging: "loc",
        isLive: true,
        targetLatency: 2000,
        buffers: { target: 1500 },
      },
    ],
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(catalog)),
    /targetLatency and buffers must not coexist/,
  );
});

test("Catalog: packaging=eventtimeline で eventType 欠落は reject (§5.2.5/§8.2)", () => {
  // depends と mimeType は揃えて、eventType 欠落のみを検出させる
  const catalog = {
    version: "draft-01",
    tracks: [
      {
        name: "e",
        packaging: "eventtimeline",
        isLive: true,
        depends: ["v"],
        mimeType: "application/json",
      },
    ],
  };
  assert.throws(() => decodeCatalogMessage(encodeRaw(catalog)), /must include eventType/);
});

test("Catalog: packaging が eventtimeline 以外で eventType 含有は reject (§5.2.5)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, eventType: "x" }],
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(catalog)),
    /eventType must not be used unless packaging is 'eventtimeline'/,
  );
});

test("Catalog: packaging=mediatimeline で depends 欠落は reject (§7.2)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [{ name: "t", packaging: "mediatimeline", isLive: true, mimeType: "application/json" }],
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(catalog)),
    /mediatimeline track must include depends/,
  );
});

test("Catalog: packaging=mediatimeline で mimeType≠application/json は reject (§7.2)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [
      {
        name: "t",
        packaging: "mediatimeline",
        isLive: true,
        depends: ["v"],
        mimeType: "text/plain",
      },
    ],
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(catalog)),
    /must have mimeType='application\/json'/,
  );
});

test("Catalog: packaging=eventtimeline で depends/mimeType/eventType の MUST が揃わないと reject (§8.2)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [
      // eventType はあるが mimeType が欠落
      {
        name: "e",
        packaging: "eventtimeline",
        isLive: true,
        eventType: "x",
        depends: ["v"],
      },
    ],
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(catalog)),
    /eventtimeline track must have mimeType='application\/json'/,
  );
});

test("Catalog: encryptionScheme 指定時に cipherSuite 欠落は reject (§5.2.39)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [
      {
        name: "v",
        packaging: "loc",
        isLive: true,
        encryptionScheme: "moq-secure-objects",
      },
    ],
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(catalog)),
    /cipherSuite must be present when encryptionScheme is specified/,
  );
});

test("Catalog: mimetype (lowercase) は reject (draft-01 Table 3)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, mimetype: "video/mp4" }],
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(catalog)),
    /use mimeType per draft-01 Table 3/,
  );
});

test("Catalog: parentName を delta 外で含めると reject (§5.2.33)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, parentName: "base" }],
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(catalog)),
    /parentName must only be included inside a clone operation/,
  );
});

test("Catalog: connectionUri/token を root tracks に含めると reject (§5.2.36/§5.2.37)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, connectionUri: "moqt://example.com" }],
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(catalog)),
    /connectionUri must only be used in publishTracks/,
  );
});

test("Catalog: publishTracks では connectionUri を許可", () => {
  const catalog: Catalog = {
    version: "draft-01",
    tracks: [],
    publishTracks: [
      {
        name: "log",
        packaging: "moqlog",
        role: "log",
        isLive: true,
        connectionUri: "moqt://logs.example.com:4443",
        token: "abc",
      },
    ],
  };
  const decoded = decodeCatalogMessage(encodeCatalog(catalog)) as Catalog;
  assert.strictEqual(decoded.publishTracks?.[0].connectionUri, "moqt://logs.example.com:4443");
  assert.strictEqual(decoded.publishTracks?.[0].token, "abc");
});

// draft-ietf-moq-msf-01 §9.4: packaging="moqlog" の Log track は role="log" が MUST。
test("Catalog: packaging=moqlog で role=log は許可 (§9.4)", () => {
  const catalog: Catalog = {
    version: "draft-01",
    tracks: [],
    publishTracks: [{ name: "log", packaging: "moqlog", role: "log", isLive: true }],
  };
  const decoded = decodeCatalogMessage(encodeCatalog(catalog)) as Catalog;
  assert.strictEqual(decoded.publishTracks?.[0].role, "log");
});

test("Catalog: packaging=moqlog で role 欠落は reject (§9.4)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [],
    publishTracks: [{ name: "log", packaging: "moqlog", isLive: true }],
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(catalog)),
    /moqlog track must have role='log' per §9.4/,
  );
});

test("Catalog: packaging=moqlog で role=log 以外は reject (§9.4)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [],
    publishTracks: [{ name: "log", packaging: "moqlog", role: "video", isLive: true }],
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(catalog)),
    /moqlog track must have role='log' per §9.4/,
  );
});

// draft-ietf-moq-msf-01 §10.4: packaging="moqmetrics" の Metrics track は role="metrics" が MUST。
test("Catalog: packaging=moqmetrics で role=metrics は許可 (§10.4)", () => {
  const catalog: Catalog = {
    version: "draft-01",
    tracks: [],
    publishTracks: [{ name: "metrics", packaging: "moqmetrics", role: "metrics", isLive: true }],
  };
  const decoded = decodeCatalogMessage(encodeCatalog(catalog)) as Catalog;
  assert.strictEqual(decoded.publishTracks?.[0].role, "metrics");
});

test("Catalog: packaging=moqmetrics で role 欠落は reject (§10.4)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [],
    publishTracks: [{ name: "metrics", packaging: "moqmetrics", isLive: true }],
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(catalog)),
    /moqmetrics track must have role='metrics' per §10.4/,
  );
});

test("Catalog: packaging=moqmetrics で role=metrics 以外は reject (§10.4)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [],
    publishTracks: [{ name: "metrics", packaging: "moqmetrics", role: "video", isLive: true }],
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(catalog)),
    /moqmetrics track must have role='metrics' per §10.4/,
  );
});

test("Catalog: trackDuration を isLive=true で含めると reject (§5.2.35)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, trackDuration: 1000 }],
  };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(catalog)),
    /trackDuration must not be included when isLive is true/,
  );
});

test("Catalog: 未知ルートフィールドは検証しないが保持する (§5)", () => {
  // §5: A parser MUST ignore fields it does not understand.
  // 本実装では「ignore」を「検証はしないが保持」と解釈する（§5.4 Variable Substitution の対象になり得るため）。
  const raw = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true }],
    customRootField: { foo: "bar" },
  };
  const decoded = decodeCatalogMessage(encodeRaw(raw)) as Catalog;
  assert.strictEqual(decoded.tracks[0].name, "v");
  assert.deepEqual((decoded as unknown as Record<string, unknown>).customRootField, {
    foo: "bar",
  });
});

// __proto__ の取り扱い（§5 の未知フィールド保持）
//
// JSON.parse は "__proto__" を own data property として作るため Object.keys に現れる。
// 通常の代入で別のオブジェクトへ写すと Object.prototype の __proto__ setter が呼ばれ
// [[Prototype]] が差し替わる。保持・再出力・置換の各経路がそれを踏まないことを固定する。
// 入力は生の JSON 文字列にする (オブジェクトリテラルの "__proto__" は own property に
// ならないため、リテラルで書くと検証にならない)。

test("Catalog: __proto__ を含む未知ルートフィールドを decode してもプロトタイプが差し替わらない (§5)", () => {
  const json =
    '{"version":"draft-01","tracks":[{"name":"v","packaging":"loc","isLive":true}],"__proto__":{"polluted":true}}';
  const decoded = decodeCatalogMessage(encodeRawJson(json)) as Catalog;
  assertOwnProtoField(decoded, { polluted: true });
  // encode → 再 decode でも own property として保持される (round-trip)
  assertOwnProtoField(decodeCatalogMessage(encodeCatalog(decoded)), { polluted: true });
});

test("Catalog: 未知ルートフィールドの __proto__ が null でもプロトタイプが差し替わらない (§5)", () => {
  // 通常の代入では null プロトタイプになり、Object.prototype のメソッドを継承経由で
  // 呼べないオブジェクトができていた
  const json =
    '{"version":"draft-01","tracks":[{"name":"v","packaging":"loc","isLive":true}],"__proto__":null}';
  const decoded = decodeCatalogMessage(encodeRawJson(json)) as Catalog;
  assertOwnProtoField(decoded, null);
});

test("Catalog: 未知ルートフィールドの __proto__ に偽の既知フィールドを入れても encode に漏れない (§5)", () => {
  // 通常の代入では差し替えたプロトタイプ経由で generatedAt / isComplete が見え、
  // 再 encode の JSON に載っていた
  const json =
    '{"version":"draft-01","tracks":[{"name":"v","packaging":"loc","isLive":true}],"__proto__":{"generatedAt":"evil","isComplete":true}}';
  const decoded = decodeCatalogMessage(encodeRawJson(json)) as Catalog;
  assert.isUndefined(decoded.generatedAt);
  assert.isUndefined(decoded.isComplete);
  const redecoded = decodeCatalogMessage(encodeCatalog(decoded)) as Catalog;
  assert.isFalse(Object.hasOwn(redecoded, "generatedAt"));
  assert.isFalse(Object.hasOwn(redecoded, "isComplete"));
});

test("Catalog: __proto__ を含む未知 track フィールドを decode してもプロトタイプが差し替わらない (§5)", () => {
  const json =
    '{"version":"draft-01","tracks":[{"name":"v","packaging":"loc","isLive":true,"__proto__":{"polluted":true}}]}';
  const decoded = decodeCatalogMessage(encodeRawJson(json)) as Catalog;
  assertOwnProtoField(decoded.tracks[0], { polluted: true });
  // encode の wire にも own property として現れる
  const wire = JSON.parse(new TextDecoder().decode(encodeCatalog(decoded))) as {
    tracks: Record<string, unknown>[];
  };
  assert.isTrue(Object.hasOwn(wire.tracks[0], "__proto__"));
});

test("Catalog: 未知ルートフィールドの __proto__ が配列でもプロトタイプが差し替わらない (§5)", () => {
  // 通常の代入では配列インスタンスがプロトタイプになり、継承経由で length と添字が見えていた
  const json =
    '{"version":"draft-01","tracks":[{"name":"v","packaging":"loc","isLive":true}],"__proto__":[1,2]}';
  const decoded = decodeCatalogMessage(encodeRawJson(json)) as Catalog;
  assertOwnProtoField(decoded, [1, 2]);
  assert.isUndefined((decoded as unknown as { length?: number }).length);
});

test("Catalog: template を持つ track でも __proto__ が encode で保持される (§5 / §7.4.1)", () => {
  // template を持つ track だけが serializeTrackForJson のコピー経路を通る。このコピーが
  // Object.assign だと own `__proto__` が wire から消え、プロトタイプが差し替わる
  const json =
    '{"version":"draft-01","tracks":[{"name":"vod","packaging":"mediatimeline","isLive":false,"depends":["v"],"mimeType":"application/json","template":[0,1000,[0,0],[0,0],0,0],"__proto__":{"polluted":true}}]}';
  const decoded = decodeCatalogMessage(encodeRawJson(json)) as Catalog;
  const redecoded = decodeCatalogMessage(encodeCatalog(decoded)) as Catalog;
  assertOwnProtoField(redecoded.tracks[0], { polluted: true });
  // template の bigint 変換を含めて round-trip する
  assert.deepStrictEqual(redecoded.tracks[0].template, [0, 1000, [0n, 0n], [0n, 0n], 0, 0]);
});

test("CatalogDelta: __proto__ を含む未知ルートフィールドを decode してもプロトタイプが差し替わらない (§5)", () => {
  const json =
    '{"deltaUpdate":[{"op":"add","tracks":[{"name":"v","packaging":"loc","isLive":true}]}],"__proto__":{"polluted":true}}';
  const decoded = decodeCatalogMessage(encodeRawJson(json)) as CatalogDelta;
  assertOwnProtoField(decoded, { polluted: true });
  // encode → 再 decode でも保持される (round-trip)
  assertOwnProtoField(decodeCatalogMessage(encodeCatalogDelta(decoded)), { polluted: true });
});

test("applyCatalogDelta: 引き継いだ __proto__ でもプロトタイプが差し替わらない (§5)", () => {
  const json =
    '{"version":"draft-01","tracks":[{"name":"v","packaging":"loc","isLive":true}],"__proto__":{"polluted":true}}';
  const current = decodeCatalogMessage(encodeRawJson(json)) as Catalog;
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "add", tracks: [{ name: "audio", packaging: "loc", isLive: true }] }],
  };
  const result = applyCatalogDelta(current, delta);
  assertOwnProtoField(result, { polluted: true });
  assert.strictEqual(result.tracks.length, 2);
});

test("resolveCatalogVariables: 未知 root field の __proto__ を置換してもプロトタイプが差し替わらない (§5.4)", () => {
  // string 値の __proto__ は decode の代入で無視されてフィールドごと消えていた
  // (この関数自身の代入先は spread 済みのため挙動は変わらない)
  const json =
    '{"version":"draft-01","tracks":[{"name":"v","packaging":"loc","isLive":true}],"__proto__":"%id%"}';
  const decoded = decodeCatalogMessage(encodeRawJson(json)) as Catalog;
  const resolved = resolveCatalogVariables(decoded, { id: "42" });
  assertOwnProtoField(resolved, "42");
});

test("resolveCatalogVariables: 未知 track フィールドの __proto__ を置換してもプロトタイプが差し替わらない (§5.4)", () => {
  const json =
    '{"version":"draft-01","tracks":[{"name":"v","packaging":"loc","isLive":true,"__proto__":"%id%"}]}';
  const decoded = decodeCatalogMessage(encodeRawJson(json)) as Catalog;
  const resolved = resolveCatalogVariables(decoded, { id: "42" });
  assertOwnProtoField(resolved.tracks[0], "42");
});

test("resolveCatalogVariables: ネストした未知フィールドの __proto__ でもプロトタイプが差し替わらない (§5.4)", () => {
  const json =
    '{"version":"draft-01","tracks":[{"name":"v","packaging":"loc","isLive":true,"vendorExt":{"__proto__":{"polluted":true},"url":"https://log.example/%id%"}}]}';
  const decoded = decodeCatalogMessage(encodeRawJson(json)) as Catalog;
  const resolved = resolveCatalogVariables(decoded, { id: "42" });
  const vendorExt = (resolved.tracks[0] as unknown as Record<string, unknown>).vendorExt as {
    url: string;
  };
  assertOwnProtoField(vendorExt, { polluted: true });
  // ネスト内の string も従来どおり置換される
  assert.strictEqual(vendorExt.url, "https://log.example/42");
});

test("resolveCatalogVariables: authInfo の __proto__ が object 値でもプロトタイプが差し替わらない (§5.2.42)", () => {
  // authInfo の値は scheme-specific の configuration object であり (§5.2.42)、
  // object を代入すると通常の代入ではプロトタイプが差し替わっていた
  const json =
    '{"version":"draft-01","tracks":[{"name":"v","packaging":"loc","isLive":true,"authInfo":{"__proto__":{"cat":true},"scheme":"%id%"}}]}';
  const decoded = decodeCatalogMessage(encodeRawJson(json)) as Catalog;
  const resolved = resolveCatalogVariables(decoded, { id: "42" });
  const authInfo = resolved.tracks[0].authInfo;
  assert.isDefined(authInfo);
  assertOwnProtoField(authInfo as object, { cat: true });
  assert.strictEqual((authInfo as Record<string, unknown>).scheme, "42");
});

test("Catalog: template の round-trip と precision loss reject (§7.4.1)", () => {
  // §7.4.1: 6 要素配列 [startMediaTime, deltaMediaTime, startLocation, deltaLocation, startWallclock, deltaWallclock]
  const catalog: Catalog = {
    version: "draft-01",
    tracks: [
      {
        name: "vod",
        packaging: "loc",
        isLive: false,
        template: [0, 2002, [0n, 0n], [1n, 0n], 1759924158381, 2002],
      },
    ],
  };
  const encoded = encodeCatalog(catalog);
  const decoded = decodeCatalogMessage(encoded) as Catalog;
  // bigint → number で再変換され、validate 側で bigint に戻る
  assert.deepStrictEqual(decoded.tracks[0].template, [
    0,
    2002,
    [0n, 0n],
    [1n, 0n],
    1759924158381,
    2002,
  ]);
});

test("Catalog: encodeCatalog 時に template Location が precision loss する値は reject (§7.4.1)", () => {
  // encode 経路でも (decode 経路と同様に) Number.MAX_SAFE_INTEGER 超の bigint を弾く。
  // 自分の出力を自分で decode できないペアを生まないため。
  const catalog: Catalog = {
    version: "draft-01",
    tracks: [
      {
        name: "v",
        packaging: "loc",
        isLive: false,
        template: [0, 2002, [BigInt(Number.MAX_SAFE_INTEGER) + 1n, 0n], [1n, 0n], 0, 0],
      },
    ],
  };
  assert.throws(
    () => encodeCatalog(catalog),
    /template startLocation\[0\] exceeds JSON safe integer range/,
  );
});

test("applyCatalogDelta: 合成後の tracks と引き継いだ publishTracks をまたぐ重複は reject (§5.2.3)", () => {
  const current: Catalog = {
    version: "draft-01",
    tracks: [],
    publishTracks: [{ name: "v", packaging: "loc", isLive: true, namespace: "room1" }],
  };
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [
      {
        type: "add",
        tracks: [{ name: "v", packaging: "loc", isLive: true, namespace: "room1" }],
      },
    ],
  };
  // tracks を先に走査するため、重複として報告されるのは publishTracks 側の track
  assert.throws(
    () => applyCatalogDelta(current, delta),
    /duplicate track name 'v' under namespace 'room1' in publishTracks per §5\.2\.3/,
  );
});

// codec の型検証は decode 側 (§5.2.18) の責務であり、clone 合成後の検証は型が崩れた値を
// 素通りさせる。ここで TypeError を出すと「検証違反は plain Error」という契約から外れるため、
// 手組み delta の clone で非文字列 codec を渡しても throw しないことを固定する。
test("applyCatalogDelta: clone 合成後に codec が文字列でなくても TypeError にしない", () => {
  const current: Catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, codec: "vp8", bitrate: 1_000_000 }],
  };
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [
      {
        type: "clone",
        tracks: [{ name: "a", parentName: "v", codec: 123 } as unknown as CatalogTrack],
      },
    ],
  };
  assert.doesNotThrow(() => applyCatalogDelta(current, delta));
});

// §5.2.28 / §5.2.29: clone で codec を上書きした結果も合成後に再検証する (clone 単体では
// 合成後の属性が決まらないため、decode 側の検証では捕捉できない)。親が audio codec を持つ場合は
// 親の時点で samplerate / channelConfig が揃っているため、上書きで新たに audio codec になる
// ケースを固定する。
test("applyCatalogDelta: clone 合成後の track が audio codec を持つなら samplerate が MUST (§5.2.28)", () => {
  const current: Catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, codec: "vp8", bitrate: 1_000_000 }],
  };
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [
      { type: "clone", tracks: [{ name: "a", parentName: "v", codec: "opus" } as CatalogTrack] },
    ],
  };
  assert.throws(
    () => applyCatalogDelta(current, delta),
    /invalid track 'a': audio track must include samplerate per §5\.2\.28/,
  );
});

test("applyCatalogDelta: add の initRef 参照切れは合成後に reject される (§5.2.13)", () => {
  const current: Catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, initRef: "init1" }],
    initDataList: [{ id: "init1", type: "inline", data: "AAAA" }],
  };
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [
      { type: "add", tracks: [{ name: "a", packaging: "loc", isLive: true, initRef: "missing" }] },
    ],
  };
  assert.throws(
    () => applyCatalogDelta(current, delta),
    /invalid catalog: track 'a' has initRef 'missing' not present in initDataList per §5\.2\.13/,
  );
});

test("applyCatalogDelta: clone で initRef を参照切れに上書きすると reject される (§5.2.13)", () => {
  const current: Catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, initRef: "init1" }],
    initDataList: [{ id: "init1", type: "inline", data: "AAAA" }],
  };
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [
      {
        type: "clone",
        tracks: [{ name: "v2", parentName: "v", initRef: "missing" } as CatalogTrack],
      },
    ],
  };
  assert.throws(
    () => applyCatalogDelta(current, delta),
    /invalid catalog: track 'v2' has initRef 'missing' not present in initDataList per §5\.2\.13/,
  );
});

test("applyCatalogDelta: 引き継いだ publishTracks の initRef 参照切れも reject される (§5.2.13)", () => {
  // delta が tracks だけを変更する場合でも、引き継いだ publishTracks の参照切れは検出する
  const current: Catalog = {
    version: "draft-01",
    tracks: [],
    publishTracks: [{ name: "v", packaging: "loc", isLive: true, initRef: "missing" }],
    initDataList: [{ id: "init1", type: "inline", data: "AAAA" }],
  };
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "add", tracks: [{ name: "a", packaging: "loc", isLive: true }] }],
  };
  assert.throws(
    () => applyCatalogDelta(current, delta),
    /invalid catalog: track 'v' has initRef 'missing' not present in initDataList per §5\.2\.13/,
  );
});

test("applyCatalogDelta: catalogNamespace 解決後の配列またぎ重複は reject される (§5.2.2/§5.2.3)", () => {
  // publishTracks の track は namespace 未指定で options.catalogNamespace="room1" に解決され、
  // delta で追加する tracks の namespace="room1" と同一になる
  const current: Catalog = {
    version: "draft-01",
    tracks: [],
    publishTracks: [{ name: "v", packaging: "loc", isLive: true }],
  };
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [
      { type: "add", tracks: [{ name: "v", packaging: "loc", isLive: true, namespace: "room1" }] },
    ],
  };
  assert.throws(
    () => applyCatalogDelta(current, delta, { catalogNamespace: "room1" }),
    /duplicate track name 'v' under namespace 'room1' in publishTracks per §5\.2\.3/,
  );
});

test("applyCatalogDelta: clone 合成後は packaging 別 MUST が role 条件付き MUST より先に reject する", () => {
  // base は role=video で codec を欠き、clone で packaging を moqmetrics に上書きする。
  // 合成後は packaging 別 MUST (§10.4 の role='metrics') が先に検証される
  // (role 条件付き MUST §5.2.18 の違反も同時に成立するが、検証順は packaging が先)
  const current: Catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, role: "video", bitrate: 1000 }],
  };
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [
      {
        type: "clone",
        tracks: [{ name: "v2", parentName: "v", packaging: "moqmetrics" } as CatalogTrack],
      },
    ],
  };
  assert.throws(
    () => applyCatalogDelta(current, delta),
    /moqmetrics track must have role='metrics' per §10\.4/,
  );
});

test("applyCatalogDelta: clone 合成後の role 条件付き MUST が再検証される (§5.2.18)", () => {
  // base から role=video を継承した clone が codec を持たない場合は、合成後に reject する
  // (clone 単体の検証では packaging 別 MUST と同様に skip しているため、合成後の再検証で検出する)
  const current: Catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, role: "video", bitrate: 1000 }],
  };
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "clone", tracks: [{ name: "v2", parentName: "v" } as CatalogTrack] }],
  };
  assert.throws(
    () => applyCatalogDelta(current, delta),
    /invalid track 'v2': video track must include codec per §5\.2\.18/,
  );
});

test("applyCatalogDelta: isComplete=true 確定後の add operation は reject (§5.1.3)", () => {
  // §5.1.3: isComplete は new track 追加禁止のコミットメント。確定後の add は MUST 違反。
  const current: Catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true }],
    isComplete: true,
  };
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "add", tracks: [{ name: "audio", packaging: "loc", isLive: true }] }],
  };
  assert.throws(() => applyCatalogDelta(current, delta), /cannot add tracks after isComplete=true/);
});

test("applyCatalogDelta: isComplete=true 確定後の clone operation は reject (§5.1.3)", () => {
  const current: Catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true }],
    isComplete: true,
  };
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [
      {
        type: "clone",
        tracks: [{ name: "v2", parentName: "v" } as CatalogTrack],
      },
    ],
  };
  assert.throws(
    () => applyCatalogDelta(current, delta),
    /cannot clone tracks after isComplete=true/,
  );
});

test("applyCatalogDelta: clone で base.eventType を継承し packaging を loc に override すると reject (§5.2.5)", () => {
  // §5.2.5: eventType MUST NOT be used unless packaging is 'eventtimeline'.
  // base から eventType を継承したまま packaging を別の値に override すると、合成結果が MUST NOT 違反になる。
  const current: Catalog = {
    version: "draft-01",
    tracks: [
      {
        name: "ev",
        packaging: "eventtimeline",
        isLive: true,
        eventType: "x",
        depends: ["v"],
        mimeType: "application/json",
      },
    ],
  };
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [
      {
        type: "clone",
        tracks: [{ name: "ev-clone", parentName: "ev", packaging: "loc" } as CatalogTrack],
      },
    ],
  };
  assert.throws(
    () => applyCatalogDelta(current, delta),
    /eventType must not be used unless packaging is 'eventtimeline'/,
  );
});

test("applyCatalogDelta: clone で packaging を mediatimeline に上書き + depends 欠落は reject (§7.2)", () => {
  // clone で base.packaging=loc を mediatimeline に override したが depends/mimeType が無い場合、
  // 適用後に §7.2 MUST 違反として reject される。
  const current: Catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true }],
  };
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [
      {
        type: "clone",
        tracks: [{ name: "timeline", parentName: "v", packaging: "mediatimeline" } as CatalogTrack],
      },
    ],
  };
  assert.throws(
    () => applyCatalogDelta(current, delta),
    /mediatimeline track must include depends/,
  );
});

test("applyCatalogDelta: clone で packaging を moqlog に上書き + role 欠落は reject (§9.4)", () => {
  // clone で base.packaging=loc を moqlog に override したが role="log" が無い場合、
  // 適用後に §9.4 MUST 違反として reject される。
  const current: Catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true }],
  };
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [
      {
        type: "clone",
        tracks: [{ name: "log", parentName: "v", packaging: "moqlog" } as CatalogTrack],
      },
    ],
  };
  assert.throws(
    () => applyCatalogDelta(current, delta),
    /moqlog track must have role='log' per §9.4/,
  );
});

test("applyCatalogDelta: clone で packaging を moqmetrics に上書き + role 欠落は reject (§10.4)", () => {
  // clone で base.packaging=loc を moqmetrics に override したが role="metrics" が無い場合、
  // 適用後に §10.4 MUST 違反として reject される。
  const current: Catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true }],
  };
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [
      {
        type: "clone",
        tracks: [{ name: "metrics", parentName: "v", packaging: "moqmetrics" } as CatalogTrack],
      },
    ],
  };
  assert.throws(
    () => applyCatalogDelta(current, delta),
    /moqmetrics track must have role='metrics' per §10.4/,
  );
});

test("Catalog: template の Location が precision loss する値は reject (§7.4.1)", () => {
  // 2^53 + 1 = 9007199254740993 は number で表現できず 9007199254740992 に丸められる。
  // BigInt(9007199254740992) → 9007199254740992n → Number(...) === 9007199254740992 となる一方、
  // 後段で別の整数を渡したつもりが丸めにより一致するため、ここでは JSON literal で精度欠落値を埋め込む。
  const json =
    '{"version":"draft-01","tracks":[{"name":"v","packaging":"loc","isLive":false,"template":[0,2002,[9007199254740993,0],[1,0],0,0]}]}';
  assert.throws(() => decodeCatalogMessage(new TextEncoder().encode(json)), /precision loss/);
});

// =============================================================================
// CatalogDelta wire format (draft-01)
// =============================================================================

test("CatalogDelta: encode は deltaUpdate 配列形式で op キーを出力する (§5.1.6)", () => {
  // draft-01 wire: { "deltaUpdate": [ {"op":"add","tracks":[...]} ] }
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "add", tracks: [{ name: "audio", packaging: "loc", isLive: true }] }],
  };
  const encoded = encodeCatalogDelta(delta);
  const parsed = JSON.parse(new TextDecoder().decode(encoded)) as { deltaUpdate: unknown[] };
  assert.isTrue(Array.isArray(parsed.deltaUpdate));
  const op = parsed.deltaUpdate[0] as Record<string, unknown>;
  assert.strictEqual(op.op, "add");
  assert.isFalse("type" in op);
});

test("CatalogDelta: add の round-trip (draft-01)", () => {
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "add", tracks: [{ name: "audio", packaging: "loc", isLive: true }] }],
  };
  const encoded = encodeCatalogDelta(delta);
  const decoded = decodeCatalogMessage(encoded);
  assert.deepStrictEqual(decoded, delta);
});

test("CatalogDelta: remove の round-trip (namespace 付き)", () => {
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "remove", tracks: [{ name: "video", namespace: "room1" }] }],
  };
  const encoded = encodeCatalogDelta(delta);
  const decoded = decodeCatalogMessage(encoded) as CatalogDelta;
  const removeOp = decoded.operations[0];
  assert.strictEqual(removeOp.type, "remove");
  if (removeOp.type === "remove") {
    assert.strictEqual(removeOp.tracks[0].namespace, "room1");
  }
});

test("CatalogDelta: clone の round-trip (parentName + parentNamespace)", () => {
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [
      {
        type: "clone",
        tracks: [
          {
            name: "v-720",
            packaging: "loc",
            isLive: true,
            parentName: "v-1080",
            parentNamespace: "room1",
            width: 1280,
            height: 720,
          },
        ],
      },
    ],
  };
  const encoded = encodeCatalogDelta(delta);
  const decoded = decodeCatalogMessage(encoded);
  assert.deepStrictEqual(decoded, delta);
});

test("CatalogDelta: 未知ルートフィールドは decode → encode で round-trip する (§5)", () => {
  // full 側と同一の保持解釈。未知フィールドは検証せず保持する
  const raw = {
    deltaUpdate: [{ op: "add", tracks: [{ name: "v", packaging: "loc", isLive: true }] }],
    generatedAt: 1720367991000,
    publishTracks: [{ name: "p", packaging: "loc", isLive: true }],
    customRootField: { foo: "bar" },
  };
  const decoded = decodeCatalogMessage(encodeRaw(raw)) as CatalogDelta;
  assert.deepEqual((decoded as unknown as Record<string, unknown>).customRootField, {
    foo: "bar",
  });
  assert.deepEqual((decoded as unknown as Record<string, unknown>).publishTracks, [
    { name: "p", packaging: "loc", isLive: true },
  ]);
  // 内部表現 operations が wire に漏れず、未知が wire に載ること
  const wire = JSON.parse(new TextDecoder().decode(encodeCatalogDelta(decoded))) as Record<
    string,
    unknown
  >;
  assert.isFalse("operations" in wire);
  assert.deepEqual(wire.customRootField, { foo: "bar" });
  const redecoded = decodeCatalogMessage(encodeCatalogDelta(decoded)) as CatalogDelta;
  assert.deepEqual((redecoded as unknown as Record<string, unknown>).customRootField, {
    foo: "bar",
  });
  assert.isTrue(redecoded.deltaUpdate);
  assert.strictEqual(redecoded.operations.length, 1);
  assert.strictEqual(redecoded.generatedAt, 1720367991000);
});

test("CatalogDelta: 同一 op の複数出現を許可する (draft-01 §5.1.6)", () => {
  // draft-00 では JSON キー重複制約で禁止されていたが、draft-01 では配列形式のため許可。
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [
      { type: "add", tracks: [{ name: "a", packaging: "loc", isLive: true }] },
      { type: "add", tracks: [{ name: "b", packaging: "loc", isLive: true }] },
    ],
  };
  const encoded = encodeCatalogDelta(delta);
  const decoded = decodeCatalogMessage(encoded) as CatalogDelta;
  assert.strictEqual(decoded.operations.length, 2);
  assert.strictEqual(decoded.operations[0].type, "add");
  assert.strictEqual(decoded.operations[1].type, "add");
});

test("CatalogDelta: version を含む場合は reject (§5.3)", () => {
  const raw = { version: "draft-01", deltaUpdate: [{ op: "add", tracks: [] }] };
  assert.throws(() => decodeCatalogMessage(encodeRaw(raw)), /must not contain MSF version field/);
});

test("CatalogDelta: tracks を含む場合は reject (§5.3)", () => {
  const raw = { tracks: [], deltaUpdate: [{ op: "add", tracks: [] }] };
  assert.throws(() => decodeCatalogMessage(encodeRaw(raw)), /must not contain tracks field/);
});

test("CatalogDelta: deltaUpdate が空配列は reject (§5.3)", () => {
  const raw = { deltaUpdate: [] };
  assert.throws(() => decodeCatalogMessage(encodeRaw(raw)), /must contain at least one operation/);
});

test("CatalogDelta: deltaUpdate=true (draft-00 boolean 形式) は reject", () => {
  const raw = { deltaUpdate: true, addTracks: [{ name: "a", packaging: "loc", isLive: true }] };
  assert.throws(() => decodeCatalogMessage(encodeRaw(raw)), /deltaUpdate must be an array/);
});

test("CatalogDelta: 旧 draft-00 形式 addTracks/removeTracks/cloneTracks root level は reject", () => {
  // deltaUpdate を含まなくても root に addTracks が出現すれば draft-00 形式試行とみなす
  const raw = { addTracks: [{ name: "a", packaging: "loc", isLive: true }] };
  assert.throws(
    () => decodeCatalogMessage(encodeRaw(raw)),
    /addTracks\/removeTracks\/cloneTracks at root level are obsolete in draft-01/,
  );
});

test("CatalogDelta: 未知 op 値は reject (§5.1.6)", () => {
  const raw = { deltaUpdate: [{ op: "patch", tracks: [] }] };
  assert.throws(() => decodeCatalogMessage(encodeRaw(raw)), /unknown op 'patch'/);
});

test("CatalogDelta: tracks 欠落の operation は reject (§5.1.6)", () => {
  const raw = { deltaUpdate: [{ op: "add" }] };
  assert.throws(() => decodeCatalogMessage(encodeRaw(raw)), /tracks must be an array/);
});

test("CatalogDelta: remove operation で追加フィールドは reject (§5.1.6)", () => {
  const raw = {
    deltaUpdate: [{ op: "remove", tracks: [{ name: "v", packaging: "loc" }] }],
  };
  assert.throws(() => decodeCatalogMessage(encodeRaw(raw)), /unexpected field 'packaging'/);
});

test("CatalogDelta: clone operation で parentName 欠落は reject (§5.2.33)", () => {
  const raw = {
    deltaUpdate: [{ op: "clone", tracks: [{ name: "v-clone" }] }],
  };
  assert.throws(() => decodeCatalogMessage(encodeRaw(raw)), /parentName must be a string/);
});

test("CatalogDelta: encodeCatalogDelta で operations が空は reject (§5.3)", () => {
  const delta: CatalogDelta = { deltaUpdate: true, operations: [] };
  assert.throws(() => encodeCatalogDelta(delta), /at least one operation/);
});

// =============================================================================
// applyCatalogDelta (namespace 正規化)
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
  assert.strictEqual(result.tracks[1].name, "audio");
});

test("applyCatalogDelta: remove で namespace を考慮して削除", () => {
  const current: Catalog = {
    version: "draft-01",
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

test("applyCatalogDelta: clone で parentName による複製", () => {
  const current: Catalog = {
    version: "draft-01",
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
          },
        ],
      },
    ],
  };
  const result = applyCatalogDelta(current, delta);
  const v720 = result.tracks.find((t) => t.name === "video-720");
  assert.isDefined(v720);
  assert.strictEqual(v720?.codec, "av1");
  assert.strictEqual(v720?.width, 1280);
  assert.isUndefined(v720?.parentName);
});

test("applyCatalogDelta: parentNamespace 省略 + options.catalogNamespace で親を解決 (§5.2.2)", () => {
  // §5.2.2: namespace 未指定なら catalog track の namespace を inherit
  // parentNamespace 未指定 + options.catalogNamespace="room1" → parent も namespace="room1" として解決
  const current: Catalog = {
    version: "draft-01",
    tracks: [{ name: "parent", packaging: "loc", isLive: true, namespace: "room1" }],
  };
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [
      {
        type: "clone",
        tracks: [{ name: "child", parentName: "parent" } as CatalogTrack],
      },
    ],
  };
  const result = applyCatalogDelta(current, delta, { catalogNamespace: "room1" });
  // namespace は parent から継承される
  const child = result.tracks.find((t) => t.name === "child");
  assert.isDefined(child);
  assert.strictEqual(child?.namespace, "room1");
});

test("applyCatalogDelta: clone の parentName が見つからないと throw", () => {
  const current: Catalog = {
    version: "draft-01",
    tracks: [{ name: "video", packaging: "loc", isLive: true }],
  };
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [
      {
        type: "clone",
        tracks: [{ name: "v-clone", parentName: "nonexistent" } as CatalogTrack],
      },
    ],
  };
  assert.throws(() => applyCatalogDelta(current, delta), /clone track parent not found/);
});

test("applyCatalogDelta: 存在しない remove は throw する", () => {
  // add 重複・clone 親不存在と同一契約 (plain Error)。typo を検出する
  const current: Catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true }],
  };
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "remove", tracks: [{ name: "typo" }] }],
  };
  assert.throws(() => applyCatalogDelta(current, delta), /remove track not found/);
});

test("applyCatalogDelta: namespace 不一致の remove は throw する", () => {
  // 正規化比較のため、名前一致でも namespace 不一致は不存在になる
  const current: Catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, namespace: "room1" }],
  };
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "remove", tracks: [{ name: "v", namespace: "wrong" }] }],
  };
  assert.throws(() => applyCatalogDelta(current, delta), /remove track not found/);
});

test("applyCatalogDelta: 同名異 namespace は catalogNamespace 解決で削除する", () => {
  // 既存の明示 namespace 削除と異なり、省略 namespace の解決経路を検証する
  const current: Catalog = {
    version: "draft-01",
    tracks: [
      { name: "v", packaging: "loc", isLive: true, namespace: "room1" },
      { name: "v", packaging: "loc", isLive: true, namespace: "room2" },
    ],
  };
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "remove", tracks: [{ name: "v" }] }],
  };
  const result = applyCatalogDelta(current, delta, { catalogNamespace: "room1" });
  assert.strictEqual(result.tracks.length, 1);
  assert.strictEqual(result.tracks[0].namespace, "room2");
});

test("applyCatalogDelta: 同一 op 内の二重 remove は 2 回目で throw する", () => {
  // 逐次適用のため、1 回目で消えた track の 2 回目は不存在になる
  const current: Catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true }],
  };
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "remove", tracks: [{ name: "v" }, { name: "v" }] }],
  };
  assert.throws(() => applyCatalogDelta(current, delta), /remove track not found/);
});

test("applyCatalogDelta: isComplete を引き継ぐ (§5.1.3 remove のみ許容)", () => {
  // §5.1.3: isComplete=true 確定後の add/clone は MUST 違反 (別テストで reject 確認済)。
  // remove は確定後も許容され、isComplete=true は結果に引き継がれる。
  const current: Catalog = {
    version: "draft-01",
    tracks: [{ name: "audio", packaging: "loc", isLive: true }],
    isComplete: true,
  };
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "remove", tracks: [{ name: "audio" }] }],
  };
  const result = applyCatalogDelta(current, delta);
  assert.strictEqual(result.isComplete, true);
  assert.strictEqual(result.tracks.length, 0);
});

test("applyCatalogDelta: generatedAt を更新する", () => {
  const current: Catalog = {
    version: "draft-01",
    tracks: [],
    generatedAt: 100,
  };
  const delta: CatalogDelta = {
    deltaUpdate: true,
    generatedAt: 200,
    operations: [{ type: "add", tracks: [{ name: "v", packaging: "loc", isLive: true }] }],
  };
  const result = applyCatalogDelta(current, delta);
  assert.strictEqual(result.generatedAt, 200);
});

// =============================================================================
// Initialization Data List / initRef
// =============================================================================

test("resolveInitData: initDataList と initRef で initData を解決する (§5.1.7/§5.2.13)", () => {
  const catalog: Catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, initRef: "v-init" }],
    initDataList: [{ id: "v-init", type: "inline", data: "AQIDBA==" }],
  };
  assert.strictEqual(resolveInitData(catalog, catalog.tracks[0]), "AQIDBA==");
});

test("resolveInitData: initRef 未指定なら undefined", () => {
  const catalog: Catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true }],
  };
  assert.isUndefined(resolveInitData(catalog, catalog.tracks[0]));
});

test("Catalog: initDataList の id 重複は reject (§5.1.7)", () => {
  const catalog = {
    version: "draft-01",
    tracks: [],
    initDataList: [
      { id: "a", type: "inline", data: "AQ==" },
      { id: "a", type: "inline", data: "AQ==" },
    ],
  };
  assert.throws(() => decodeCatalogMessage(encodeRaw(catalog)), /duplicate initDataList id 'a'/);
});

// =============================================================================
// Variable Substitution (§5.4)
// =============================================================================

test("resolveCatalogVariables: 正常置換の round-trip", () => {
  const catalog: Catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, label: "watermark-%user%" }],
  };
  const resolved = resolveCatalogVariables(catalog, { user: "alice" });
  assert.strictEqual(resolved.tracks[0].label, "watermark-alice");
});

test("resolveCatalogVariables: 変数値の文字種違反は reject (§5.4.1)", () => {
  const catalog: Catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, label: "x" }],
  };
  // ; は禁止文字 (§5.4.1)
  assert.throws(
    () => resolveCatalogVariables(catalog, { user: "ali;ce" }),
    /contains disallowed characters/,
  );
});

test("resolveCatalogVariables: 変数名の文字種違反は reject (§5.4.1)", () => {
  const catalog: Catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true }],
  };
  // 空白は禁止
  assert.throws(
    () => resolveCatalogVariables(catalog, { "bad name": "x" }),
    /invalid variable name/,
  );
});

test("resolveCatalogVariables: % リテラル単独は reject (§5.4.1)", () => {
  const catalog: Catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, label: "100% off" }],
  };
  assert.throws(() => resolveCatalogVariables(catalog, {}), /literal %/);
});

// 未知フィールドの Variable Substitution（§5.4 / §5.6.14）
// decodeCatalogMessage → validateCatalog → resolveCatalogVariables の end-to-end 経路で、
// 未知 string field 内の %var% が置換されることを検証する。

test("resolveCatalogVariables: 未知 track field の %var% を end-to-end で置換する (§5.6.14)", () => {
  // §5.6.14 の例: 未知 field "c4m" の "%token%" が置換される
  const raw = {
    version: "draft-01",
    tracks: [
      {
        name: "cmcdv2-%id%",
        namespace: "advertising-decisions/live-sports/%event%",
        packaging: "eventtimeline",
        isLive: true,
        eventType: "com.example.iab.vast",
        depends: ["v"],
        mimeType: "application/json",
        c4m: "%token%",
      },
    ],
  };
  // decode 経路で未知 field c4m が保持される
  const decoded = decodeCatalogMessage(encodeRaw(raw)) as Catalog;
  assert.strictEqual((decoded.tracks[0] as unknown as Record<string, unknown>).c4m, "%token%");

  // resolve 経路で既知 field と未知 field の両方が置換される
  const resolved = resolveCatalogVariables(decoded, { token: "1234", id: "bob", event: "xyz" });
  assert.strictEqual(resolved.tracks[0].name, "cmcdv2-bob");
  assert.strictEqual(resolved.tracks[0].namespace, "advertising-decisions/live-sports/xyz");
  assert.strictEqual((resolved.tracks[0] as unknown as Record<string, unknown>).c4m, "1234");
});

test("resolveCatalogVariables: 未知 root field の %var% を置換する", () => {
  const raw = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true }],
    customEndpoint: "https://log.example.com/%id%",
  };
  const decoded = decodeCatalogMessage(encodeRaw(raw)) as Catalog;
  const resolved = resolveCatalogVariables(decoded, { id: "viewer1" });
  assert.strictEqual(
    (resolved as unknown as Record<string, unknown>).customEndpoint,
    "https://log.example.com/viewer1",
  );
});

test("resolveCatalogVariables: ネスト object / array 内の未知 field 文字列も置換する", () => {
  // §5.4 にネスト再帰規則は無いが、本実装の方針としてネスト内も走査する
  const raw = {
    version: "draft-01",
    tracks: [
      {
        name: "v",
        packaging: "loc",
        isLive: true,
        vendorExt: { url: "https://x.example/%id%", list: ["a-%id%", "static"] },
      },
    ],
  };
  const decoded = decodeCatalogMessage(encodeRaw(raw)) as Catalog;
  const resolved = resolveCatalogVariables(decoded, { id: "42" });
  const vendorExt = (resolved.tracks[0] as unknown as Record<string, unknown>).vendorExt as {
    url: string;
    list: string[];
  };
  assert.strictEqual(vendorExt.url, "https://x.example/42");
  assert.deepEqual(vendorExt.list, ["a-42", "static"]);
});

test("Catalog: 未知 track field は decode で保持され encode で再出力される", () => {
  const raw = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true, c4m: "abc" }],
  };
  const decoded = decodeCatalogMessage(encodeRaw(raw)) as Catalog;
  assert.strictEqual((decoded.tracks[0] as unknown as Record<string, unknown>).c4m, "abc");
  // encode → decode で未知 field が round-trip する
  const redecoded = decodeCatalogMessage(encodeCatalog(decoded)) as Catalog;
  assert.strictEqual((redecoded.tracks[0] as unknown as Record<string, unknown>).c4m, "abc");
});

test("resolveCatalogVariables: 未知 publishTracks field の %var% を置換する", () => {
  const raw = {
    version: "draft-01",
    tracks: [],
    publishTracks: [
      { name: "log", packaging: "moqlog", role: "log", isLive: true, c4m: "%token%" },
    ],
  };
  const decoded = decodeCatalogMessage(encodeRaw(raw)) as Catalog;
  const resolved = resolveCatalogVariables(decoded, { token: "abc" });
  const publishTrack = resolved.publishTracks?.[0];
  assert.isDefined(publishTrack);
  assert.strictEqual((publishTrack as unknown as Record<string, unknown>).c4m, "abc");
});

test("applyCatalogDelta: 未知 root field をベース catalog から引き継ぐ", () => {
  const raw = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true }],
    customRootField: "kept",
  };
  const current = decodeCatalogMessage(encodeRaw(raw)) as Catalog;
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "add", tracks: [{ name: "audio", packaging: "loc", isLive: true }] }],
  };
  const result = applyCatalogDelta(current, delta);
  assert.strictEqual((result as unknown as Record<string, unknown>).customRootField, "kept");
  assert.strictEqual(result.tracks.length, 2);
});

test("applyCatalogDelta: delta 側の未知 root field は結果にマージしない", () => {
  // ベース側の未知のみ引き継ぎ、delta 側の未知は decode → encode でのみ保持する
  const current: Catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true }],
  };
  const delta = {
    deltaUpdate: true,
    operations: [{ type: "add", tracks: [{ name: "audio", packaging: "loc", isLive: true }] }],
    customRootField: { foo: "bar" },
  } as unknown as CatalogDelta;
  const result = applyCatalogDelta(current, delta);
  assert.isFalse("customRootField" in result);
  assert.strictEqual(result.tracks.length, 2);
});

// =============================================================================
// MSF URI Fragment Parsing (§11.1)
// =============================================================================

test("parseMsfFragmentValue: 仕様例の round-trip (§11.1.3)", () => {
  // 例: customer-livestream-123--catalog
  const result = parseMsfFragmentValue("customer-livestream-123--catalog");
  assert.deepStrictEqual(result.trackNamespace, ["customer", "livestream", "123"]);
  assert.strictEqual(result.trackName, "catalog");
  assert.deepStrictEqual(result.parameters, []);
});

test("parseMsfFragmentValue: connection=q parameter を解析", () => {
  const result = parseMsfFragmentValue("ns--track&connection=q");
  assert.deepStrictEqual(result.parameters, [["connection", "q"]]);
  assert.strictEqual(getConnectionParameter(result.parameters), "q");
});

// assertMsfConnectionSupported（§11.1.1 connection による transport 選択の適用）
test("assertMsfConnectionSupported: connection=q は Native QUIC 未実装で throw", () => {
  assert.throws(
    () => assertMsfConnectionSupported({ type: "msf", value: "ns--track&connection=q" }),
    /connection='q' requires Native QUIC/,
  );
});

test("assertMsfConnectionSupported: connection=wt は WebTransport を許可（throw しない）", () => {
  assertMsfConnectionSupported({ type: "msf", value: "ns--track&connection=wt" });
});

test("assertMsfConnectionSupported: connection 欠如は現行 WebTransport（throw しない）", () => {
  assertMsfConnectionSupported({ type: "msf", value: "ns--track" });
});

test("assertMsfConnectionSupported: connection 不正値は silent ignore（throw しない）", () => {
  // getConnectionParameter が undefined を返すため connection 欠如と同じ扱い
  assertMsfConnectionSupported({ type: "msf", value: "ns--track&connection=xyz" });
});

test("assertMsfConnectionSupported: msf 以外の fragment / null は対象外（throw しない）", () => {
  assertMsfConnectionSupported({ type: "other", value: "anything" });
  assertMsfConnectionSupported(null);
});

test("parseMsfFragmentValue: 複数 wallclock-range を順序保持で返す (§11.1.1)", () => {
  // §11.1.1: union of those ranges → 順序保持 + 重複許容
  const result = parseMsfFragmentValue("ns--track&wallclock-range=100-200&wallclock-range=300-400");
  assert.deepStrictEqual(result.parameters, [
    ["wallclock-range", "100-200"],
    ["wallclock-range", "300-400"],
  ]);
});

test("parseMsfFragmentValue: 大文字 hex (.2D) は reject (§11.1.2)", () => {
  assert.throws(
    () => parseMsfFragmentValue("ns.2D--track"),
    /"\." must be followed by two lowercase hexadecimal digits in msf fragment namespace field at index 0, got "\.2D"/,
  );
});

test("parseMsfFragmentValue: ~ リテラルは reject (§11.1.2 unreserved 文字集合違反)", () => {
  // §11.1.2: literal は [A-Za-z0-9_] のみ。`~` は MUST 非 literal なので一般 reject 経路で弾かれる。
  assert.throws(
    () => parseMsfFragmentValue("ns~name--track"),
    /character "~" in msf fragment namespace field at index 0 is not in \[A-Za-z0-9_\]/,
  );
});

test("parseMsfFragmentValue: literal で書ける byte の hex 表現は reject (§8.8 MUST reject)", () => {
  // §8.8 は「a byte that could have been represented literally but was hex-encoded」を
  // MUST reject とする。§11.1.2 はこの規則を normatively 採用する
  assert.throws(
    () => parseMsfFragmentValue("n.61--track"),
    /byte "\.61" must be written literally in msf fragment namespace field at index 0/,
  );
  assert.throws(
    () => parseMsfFragmentValue("ns--tr.61ck"),
    /byte "\.61" must be written literally in msf fragment track name/,
  );
});

test("parseMsfFragmentValue: 空の Track Namespace Field は reject (§8.7 MUST 1 バイト以上)", () => {
  // 区切りと区別できないため、§8.8 の表記にも書く方法が無い
  assert.throws(
    () => parseMsfFragmentValue("-x--track"),
    /invalid msf fragment value: track namespace field at index 0 must not be empty/,
  );
  // 先頭以外に空のフィールドは表記できない (先頭の `--` が区切りとして読まれる)。
  // 末尾の区切りは track name の literal 違反として拒否される
  assert.throws(
    () => parseMsfFragmentValue("x---track"),
    /character "-" in msf fragment track name is not in \[A-Za-z0-9_\]/,
  );
  // namespace 部が空 (0 フィールド) の `--track` は §2.4.1 が許すため受理する
  assert.deepStrictEqual(parseMsfFragmentValue("--track").trackNamespace, []);
});

test("parseMsfFragmentValue: ? 含有は reject (§11.1)", () => {
  assert.throws(() => parseMsfFragmentValue("ns--track?foo=bar"), /'\?' must be percent-encoded/);
});

test("parseMsfFragmentValue: -- 区切りが無い入力は reject (§11.1.2)", () => {
  assert.throws(() => parseMsfFragmentValue("no-delim-here"), /missing '--' delimiter/);
});

test("parseMsfFragmentValue: percent-decoded byte の round-trip", () => {
  // 'a' = 0x61, '-' = 0x2d
  const result = parseMsfFragmentValue("a.2da--catalog");
  assert.strictEqual(result.trackNamespace[0], "a-a");
});

// =============================================================================
// MsfCompressionAlgorithm
// =============================================================================

test("MsfCompressionAlgorithm: NONE=0n と GZIP=1n を定数として export している (§12.1 / §14.4 Table 15)", () => {
  assert.strictEqual(MsfCompressionAlgorithm.NONE, 0n);
  assert.strictEqual(MsfCompressionAlgorithm.GZIP, 1n);
});

// =============================================================================
// validateCatalog / validateCatalogTrack の export 確認
// =============================================================================

test("validateCatalog: 有効な catalog をそのまま返す", () => {
  const obj = { version: "draft-01", tracks: [{ name: "v", packaging: "loc", isLive: true }] };
  const catalog = validateCatalog(obj);
  assert.strictEqual(catalog.version, "draft-01");
});

test("validateCatalogTrack: root source で必須欠落を reject", () => {
  assert.throws(
    () => validateCatalogTrack({ name: "v" }, { source: "root" }),
    /packaging must be a string/,
  );
});

// =============================================================================
// Media Timeline
// =============================================================================

test("Media Timeline: 空配列の round-trip", () => {
  const entries: MediaTimelineEntry[] = [];
  const encoded = encodeMediaTimeline(entries);
  const decoded = decodeMediaTimeline(encoded);
  assert.deepStrictEqual(decoded, entries);
});

test("Media Timeline: 通常の round-trip (gzip 撤廃後)", () => {
  // draft-01 では options.gzip は撤廃され、無圧縮 JSON のみ
  const entries: MediaTimelineEntry[] = [
    [0, [0n, 0n], 1759924158381],
    [2002, [1n, 0n], 1759924160383],
  ];
  const encoded = encodeMediaTimeline(entries);
  const decoded = decodeMediaTimeline(encoded);
  // 先頭バイトが gzip magic (0x1f 0x8b) ではなく JSON `[` (0x5b) であることを確認
  assert.strictEqual(encoded[0], 0x5b);
  assert.deepStrictEqual(decoded, entries);
});

test("Media Timeline: 不正な形式は throw", () => {
  const invalid = new TextEncoder().encode('{"not": "an array"}');
  assert.throws(() => decodeMediaTimeline(invalid), /invalid media timeline format/);
});

// =============================================================================
// Event Timeline
// =============================================================================

test("Event Timeline: 空配列の round-trip", () => {
  const entries: EventTimelineEntry[] = [];
  const encoded = encodeEventTimeline(entries);
  const decoded = decodeEventTimeline(encoded);
  assert.deepStrictEqual(decoded, entries);
});

test("Event Timeline: data 欠落は throw (§8.1)", () => {
  const invalid = new TextEncoder().encode('[{"t": 123}]');
  assert.throws(() => decodeEventTimeline(invalid), /invalid event timeline entry/);
});

test("Event Timeline: t/l/m 複数指定は throw (§8.1)", () => {
  const invalid = new TextEncoder().encode('[{"t": 1, "m": 2, "data": "x"}]');
  assert.throws(() => decodeEventTimeline(invalid), /invalid event timeline entry/);
});

// =============================================================================
// createCatalog / createCompleteCatalog / helper
// =============================================================================

test("createCatalog: version は draft-01 になる", () => {
  const catalog = createCatalog([{ name: "v", packaging: "loc", isLive: true }]);
  assert.strictEqual(catalog.version, "draft-01");
});

test("createCatalog: isComplete=false は無視する (§5.1.3)", () => {
  const catalog = createCatalog([], { isComplete: false as unknown as true });
  assert.isUndefined(catalog.isComplete);
});

// 生成の時点で track 単位の MUST を検証する。encode と同じ関数を使うため、組み立てた
// Catalog を送るまでの間に不正な状態を持ち回らない。
test("createCatalog: track 単位の MUST 違反を reject する", () => {
  // §5.2.18: role=video は codec が MUST
  assert.throws(
    () =>
      createCatalog([
        { name: "v", packaging: "loc", isLive: true, role: "video", bitrate: 1_000_000 },
      ]),
    /video track must include codec per §5\.2\.18/,
  );

  // §5.2.3: tracks と options.publishTracks をまたぐ (name, namespace) の重複
  assert.throws(
    () =>
      createCatalog([{ name: "log", packaging: "loc", isLive: true }], {
        publishTracks: [{ name: "log", packaging: "moqlog", role: "log", isLive: true }],
      }),
    /duplicate track name 'log' under namespace \(no namespace\) in publishTracks per §5\.2\.3/,
  );

  // §5.2.13: initRef の参照切れ
  assert.throws(
    () =>
      createCatalog([{ name: "v", packaging: "loc", isLive: true, initRef: "missing" }], {
        initDataList: [{ id: "init-1", type: "inline", data: "AQID" }],
      }),
    /track 'v' has initRef 'missing' not present in initDataList per §5\.2\.13/,
  );
});

// 検証は track を組み替えず、渡された配列をそのまま Catalog に載せる (呼び出し側が保持して
// いる配列と identity が変わると思わぬ共有のずれを生む)。
test("createCatalog: 検証を通った tracks をそのまま保持する", () => {
  const tracks: CatalogTrack[] = [
    { name: "raw", packaging: "loc", isLive: true },
    {
      name: "v",
      packaging: "loc",
      isLive: true,
      role: "video",
      codec: "vp8",
      bitrate: 1_000_000,
    },
  ];
  const catalog = createCatalog(tracks);
  assert.strictEqual(catalog.tracks, tracks);
});

// 非有限数は wire では null になり §5.2 の number MUST を満たさないため、生成の時点でも
// decode と同じ文言で拒否する。
test("createCatalog: 非有限数のフィールドを reject する", () => {
  assert.throws(
    () => createCatalog([{ name: "v", packaging: "loc", isLive: true, bitrate: Number.NaN }]),
    /bitrate must be a number per §5\.2\.22, got object/,
  );
});

// template の Location は内部表現で bigint を持つ。JSON 安全範囲外の値は encode 時に
// number へ落とせず「自分の出力を自分で decode できない」ペアになるため、生成の時点で拒否する。
test("createCatalog: template の Location が JSON 安全範囲外なら reject する (§7.4.1)", () => {
  assert.throws(
    () =>
      createCatalog([
        {
          name: "vod",
          packaging: "loc",
          isLive: false,
          template: [0, 2002, [BigInt(Number.MAX_SAFE_INTEGER) + 1n, 0n], [0n, 0n], 0, 0],
        },
      ]),
    /template startLocation\[0\] exceeds JSON safe integer range/,
  );

  assert.throws(
    () =>
      createCatalog([
        {
          name: "vod",
          packaging: "loc",
          isLive: false,
          template: [0, 2002, [-1n, 0n], [0n, 0n], 0, 0],
        },
      ]),
    /template startLocation\[0\] must be non-negative/,
  );
});

test("createCompleteCatalog: isComplete=true の Catalog を生成する", () => {
  const catalog = createCompleteCatalog();
  assert.strictEqual(catalog.version, "draft-01");
  assert.deepStrictEqual(catalog.tracks, []);
  assert.strictEqual(catalog.isComplete, true);
});

test("CATALOG_TRACK_NAME: 定数が catalog", () => {
  assert.strictEqual(CATALOG_TRACK_NAME, "catalog");
});

test("getVideoTracks/getAudioTracks: role でフィルタする", () => {
  const catalog: Catalog = {
    version: "draft-01",
    tracks: [
      { name: "v1", packaging: "loc", isLive: true, role: "video" },
      { name: "a1", packaging: "loc", isLive: true, role: "audio" },
      { name: "v2", packaging: "loc", isLive: true, role: "video" },
    ],
  };
  assert.strictEqual(getVideoTracks(catalog).length, 2);
  assert.strictEqual(getAudioTracks(catalog).length, 1);
});

test("getTrackByName: 名前一致で返す", () => {
  const catalog: Catalog = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true }],
  };
  assert.strictEqual(getTrackByName(catalog, "v")?.name, "v");
  assert.isUndefined(getTrackByName(catalog, "x"));
});

test("getTracksByAltGroup / getTracksByRenderGroup: グループ番号でフィルタする", () => {
  const catalog: Catalog = {
    version: "draft-01",
    tracks: [
      { name: "hd", packaging: "loc", isLive: true, altGroup: 1, renderGroup: 10 },
      { name: "sd", packaging: "loc", isLive: true, altGroup: 1, renderGroup: 10 },
      { name: "audio", packaging: "loc", isLive: true, altGroup: 2, renderGroup: 10 },
    ],
  };
  assert.strictEqual(getTracksByAltGroup(catalog, 1).length, 2);
  assert.strictEqual(getTracksByRenderGroup(catalog, 10).length, 3);
});

// =============================================================================
// targetLatency の解決 (§5.2.8)
// =============================================================================

/** targetLatency の解決のテストで使うライブのトラックを作る */
function targetLatencyTrack(
  options: {
    targetLatency?: number;
    renderGroup?: number;
    altGroup?: number;
    isLive?: boolean;
  } = {},
): CatalogTrack {
  const track: CatalogTrack = { name: "track", packaging: "loc", isLive: options.isLive ?? true };
  if (options.targetLatency !== undefined) track.targetLatency = options.targetLatency;
  if (options.renderGroup !== undefined) track.renderGroup = options.renderGroup;
  if (options.altGroup !== undefined) track.altGroup = options.altGroup;
  return track;
}

test("effectiveTargetLatencyMs: isLive が false のトラックの宣言は無視する (§5.2.8 の MUST)", () => {
  // §5.2.8: isLive が false の track の targetLatency は無視する MUST
  assert.isNull(
    effectiveTargetLatencyMs(targetLatencyTrack({ targetLatency: 100, isLive: false })),
  );
  // 未解決 (トラックが無い) ときも使える値は無い
  assert.isNull(effectiveTargetLatencyMs(null));
  // ライブのトラックは宣言した値をそのまま使う
  assert.strictEqual(effectiveTargetLatencyMs(targetLatencyTrack({ targetLatency: 100 })), 100);
  // 宣言が無いときは null を返し、購読側が遅延を選ぶ (§5.2.8 の MAY)
  assert.isNull(effectiveTargetLatencyMs(targetLatencyTrack()));
});

test("resolveSharedTargetLatencyMs: 両方に無いときは null を返し、共有する値を作らない (§5.2.8)", () => {
  // どちらも宣言していないときは、揺らぎから求めた再生の遅れだけを使うフォールバックになる
  assert.deepEqual(resolveSharedTargetLatencyMs(targetLatencyTrack(), targetLatencyTrack()), {
    value: null,
    conflict: false,
  });
  // どちらも解決できていない (購読していない、catalog から引けない) ときも同じ
  assert.deepEqual(resolveSharedTargetLatencyMs(null, null), { value: null, conflict: false });
});

test("resolveSharedTargetLatencyMs: 片方にだけあるときはその値を使い、通知しない (§5.2.8)", () => {
  const audio = targetLatencyTrack({ targetLatency: 100, renderGroup: 1 });
  const video = targetLatencyTrack({ renderGroup: 1 });
  // 宣言が無い側は遅延を選んでよい (MAY) ため、宣言がある側の値に揃える
  assert.deepEqual(resolveSharedTargetLatencyMs(audio, video), { value: 100, conflict: false });
  assert.deepEqual(resolveSharedTargetLatencyMs(video, audio), { value: 100, conflict: false });
  // 解決できていないトラック (null) を渡したときも同じ
  assert.deepEqual(resolveSharedTargetLatencyMs(audio, null), { value: 100, conflict: false });
  assert.deepEqual(resolveSharedTargetLatencyMs(null, audio), { value: 100, conflict: false });
});

test("resolveSharedTargetLatencyMs: 両方にあって同じときはその値を使い、通知しない (§5.2.8)", () => {
  const audio = targetLatencyTrack({ targetLatency: 100, renderGroup: 1 });
  const video = targetLatencyTrack({ targetLatency: 100, renderGroup: 1 });
  assert.deepEqual(resolveSharedTargetLatencyMs(audio, video), { value: 100, conflict: false });
  // 0 ms は未指定ではなく有効な値であり、同じ値として扱う
  assert.deepEqual(
    resolveSharedTargetLatencyMs(
      targetLatencyTrack({ targetLatency: 0 }),
      targetLatencyTrack({ targetLatency: 0 }),
    ),
    { value: 0, conflict: false },
  );
});

test("resolveSharedTargetLatencyMs: 同じ render group で値が異なるときは大きい方を使い、通知する (§5.2.8 の MUST)", () => {
  // §5.2.8: 同じ render group の track は同じ targetLatency でなければならない MUST
  const audio = targetLatencyTrack({ targetLatency: 100, renderGroup: 1 });
  const video = targetLatencyTrack({ targetLatency: 200, renderGroup: 1 });
  assert.deepEqual(resolveSharedTargetLatencyMs(audio, video), { value: 200, conflict: true });
  // 音声と映像を入れ替えても大きい方を使う (小さい方の要求より早く出さない)
  assert.deepEqual(resolveSharedTargetLatencyMs(video, audio), { value: 200, conflict: true });
});

test("resolveSharedTargetLatencyMs: 同じ alternate group で値が異なるときは大きい方を使い、通知する (§5.2.8 の MUST)", () => {
  // §5.2.8 の MUST は同じ alternate group の track にも掛かる (ABR の切り替え先)
  const audio = targetLatencyTrack({ targetLatency: 150, altGroup: 2 });
  const video = targetLatencyTrack({ targetLatency: 50, altGroup: 2 });
  assert.deepEqual(resolveSharedTargetLatencyMs(audio, video), { value: 150, conflict: true });
  assert.deepEqual(resolveSharedTargetLatencyMs(video, audio), { value: 150, conflict: true });
});

test("resolveSharedTargetLatencyMs: group が無いか異なるときは大きい方を使い、通知しない (§5.2.8)", () => {
  // group が無い track 同士は仕様に反しないため通知しない
  assert.deepEqual(
    resolveSharedTargetLatencyMs(
      targetLatencyTrack({ targetLatency: 100 }),
      targetLatencyTrack({ targetLatency: 300 }),
    ),
    { value: 300, conflict: false },
  );
  // render group も alternate group も異なるときも通知しない
  assert.deepEqual(
    resolveSharedTargetLatencyMs(
      targetLatencyTrack({ targetLatency: 100, renderGroup: 1, altGroup: 1 }),
      targetLatencyTrack({ targetLatency: 300, renderGroup: 2, altGroup: 2 }),
    ),
    { value: 300, conflict: false },
  );
  // 片方だけが group を持つときも仕様に反しないため通知しない
  assert.deepEqual(
    resolveSharedTargetLatencyMs(
      targetLatencyTrack({ targetLatency: 100, renderGroup: 1 }),
      targetLatencyTrack({ targetLatency: 300 }),
    ),
    { value: 300, conflict: false },
  );
});

test("resolveSharedTargetLatencyMs: isLive が false のトラックの値は無視する (§5.2.8 の MUST)", () => {
  const live = targetLatencyTrack({ targetLatency: 200, renderGroup: 1 });
  const notLive = targetLatencyTrack({ targetLatency: 100, renderGroup: 1, isLive: false });
  // isLive が false の側の値は使わないため、値の差は無く通知も要らない
  assert.deepEqual(resolveSharedTargetLatencyMs(notLive, live), { value: 200, conflict: false });
  assert.deepEqual(resolveSharedTargetLatencyMs(live, notLive), { value: 200, conflict: false });
  // どちらも isLive が false のときは共有する値が無く、フォールバックになる
  assert.deepEqual(resolveSharedTargetLatencyMs(notLive, notLive), {
    value: null,
    conflict: false,
  });
});

// =============================================================================
// Group 番号付け
// =============================================================================

test("createInitialGroupId: Unix ms ベースの bigint を返す (§6.1)", () => {
  const before = BigInt(Date.now());
  const id = createInitialGroupId();
  const after = BigInt(Date.now());
  assert.isTrue(id >= before);
  assert.isTrue(id <= after);
});

// =============================================================================
// ABR トラック選択
// =============================================================================

test("selectTrackByMaxBitrate: 最大ビットレートを選択", () => {
  const tracks: CatalogTrack[] = [
    { name: "hd", packaging: "loc", isLive: true, bitrate: 5_000_000 },
    { name: "sd", packaging: "loc", isLive: true, bitrate: 1_000_000 },
  ];
  assert.strictEqual(selectTrackByMaxBitrate(tracks, 2_000_000)?.name, "sd");
});

test("selectTrackByMaxResolution: 指定解像度以下で最大を選択", () => {
  const tracks: CatalogTrack[] = [
    { name: "4k", packaging: "loc", isLive: true, width: 3840, height: 2160 },
    { name: "hd", packaging: "loc", isLive: true, width: 1920, height: 1080 },
  ];
  assert.strictEqual(selectTrackByMaxResolution(tracks, 1920, 1080)?.name, "hd");
});

test("selectHighestBitrateTrack / selectLowestBitrateTrack: altGroup 内で選択", () => {
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

// =============================================================================
// MSF URI Fragment reserved key helpers (§11.1.1)
// =============================================================================

// --- getWallclockRanges ---

test("getWallclockRanges: 仕様例 start-end", () => {
  const params: Array<readonly [string, string]> = [["wallclock-range", "100-200"]];
  const result = getWallclockRanges(params);
  assert.deepEqual(result, [{ start: 100, end: 200 }]);
});

test("getWallclockRanges: start のみ（open range）", () => {
  const params: Array<readonly [string, string]> = [["wallclock-range", "500"]];
  const result = getWallclockRanges(params);
  assert.deepEqual(result, [{ start: 500 }]);
});

test("getWallclockRanges: 複数エントリは union", () => {
  const params: Array<readonly [string, string]> = [
    ["wallclock-range", "100-200"],
    ["wallclock-range", "300-400"],
  ];
  const result = getWallclockRanges(params);
  assert.deepEqual(result, [
    { start: 100, end: 200 },
    { start: 300, end: 400 },
  ]);
});

test("getWallclockRanges: 不正値はスキップ", () => {
  const params: Array<readonly [string, string]> = [
    ["wallclock-range", "abc"],
    ["wallclock-range", "-200"],
    ["wallclock-range", ""],
    ["wallclock-range", "100-200"],
  ];
  const result = getWallclockRanges(params);
  assert.deepEqual(result, [{ start: 100, end: 200 }]);
});

test("getWallclockRanges: 該当なしは空配列", () => {
  const params: Array<readonly [string, string]> = [["connection", "wt"]];
  assert.deepEqual(getWallclockRanges(params), []);
});

// --- getMediatimeRanges ---

test("getMediatimeRanges: 仕様例 start-end", () => {
  const params: Array<readonly [string, string]> = [["mediatime-range", "0-5000"]];
  const result = getMediatimeRanges(params);
  assert.deepEqual(result, [{ start: 0, end: 5000 }]);
});

test("getMediatimeRanges: 不正値はスキップ", () => {
  const params: Array<readonly [string, string]> = [
    ["mediatime-range", "-100"],
    ["mediatime-range", "1000"],
  ];
  const result = getMediatimeRanges(params);
  assert.deepEqual(result, [{ start: 1000 }]);
});

// --- getLocationRanges ---

test("getLocationRanges: 仕様例 Group.Object-Group.Object", () => {
  const params: Array<readonly [string, string]> = [["location-range", "34.0-2145.16"]];
  const result = getLocationRanges(params);
  assert.deepEqual(result, [
    { start: { groupId: 34n, objectId: 0n }, end: { groupId: 2145n, objectId: 16n } },
  ]);
});

test("getLocationRanges: 仕様例 Group.Object（end なし）", () => {
  const params: Array<readonly [string, string]> = [["location-range", "16.24"]];
  const result = getLocationRanges(params);
  assert.deepEqual(result, [{ start: { groupId: 16n, objectId: 24n } }]);
});

test("getLocationRanges: 仕様例 Group-Group（objectId なし）", () => {
  const params: Array<readonly [string, string]> = [["location-range", "16-24"]];
  const result = getLocationRanges(params);
  assert.deepEqual(result, [{ start: { groupId: 16n }, end: { groupId: 24n } }]);
});

test("getLocationRanges: ドット過多はスキップ", () => {
  const params: Array<readonly [string, string]> = [["location-range", "1.2.3"]];
  assert.deepEqual(getLocationRanges(params), []);
});

test("getLocationRanges: 末尾ドットはスキップ", () => {
  const params: Array<readonly [string, string]> = [["location-range", "1."]];
  assert.deepEqual(getLocationRanges(params), []);
});

test("getLocationRanges: 有効/不正混在で有効分だけ返る", () => {
  const params: Array<readonly [string, string]> = [
    ["location-range", "1.2.3"],
    ["location-range", "10.5-20.8"],
    ["location-range", ""],
  ];
  const result = getLocationRanges(params);
  assert.deepEqual(result, [
    { start: { groupId: 10n, objectId: 5n }, end: { groupId: 20n, objectId: 8n } },
  ]);
});

test("getLocationRanges: start 省略形はスキップ", () => {
  const params: Array<readonly [string, string]> = [["location-range", "-100.5"]];
  assert.deepEqual(getLocationRanges(params), []);
});

// --- getC4mParameter ---

test("getC4mParameter: 最初の c4m を返す", () => {
  const params: Array<readonly [string, string]> = [
    ["c4m", "dG9rZW4x"],
    ["c4m", "dG9rZW4y"],
  ];
  assert.strictEqual(getC4mParameter(params), "dG9rZW4x");
});

test("getC4mParameter: 該当なしは undefined", () => {
  const params: Array<readonly [string, string]> = [["connection", "wt"]];
  assert.isUndefined(getC4mParameter(params));
});

test("getC4mParameter: 空文字列もそのまま返す（検証しない）", () => {
  const params: Array<readonly [string, string]> = [["c4m", ""]];
  assert.strictEqual(getC4mParameter(params), "");
});

// =============================================================================
// catalog の track に載せる Authorization Info (draft-ietf-moq-msf-01 §5.2.42)
// =============================================================================

// CAT の Token Type (draft-ietf-moq-c4m-01 §7.1 Table 4)
const CAT_TOKEN_TYPE = 1n;
const TOKEN_VALUE = new Uint8Array([0xd2, 0x84, 0x43]);

/**
 * §5.2.42: authInfo は track の認可が必要なことを視聴側に示す。SETUP の Authorization Token が
 * C4M のトークン (CAT) のときだけ、CAT のスキーム名 `cat` と、§11.1.1 の予約パラメータ `c4m` を
 * 指す変数参照を返す。トークンそのものは返さない (catalog はすべての視聴者に届くため)
 */
test("catalogAuthInfoForSetupToken: CAT の USE_VALUE と REGISTER だけが authInfo を持つ", () => {
  const useValue = catalogAuthInfoForSetupToken({
    aliasType: AuthorizationTokenAliasType.USE_VALUE,
    tokenType: CAT_TOKEN_TYPE,
    tokenValue: TOKEN_VALUE,
  });
  assert.deepEqual(useValue, { cat: "%c4m%" });

  const register = catalogAuthInfoForSetupToken({
    aliasType: AuthorizationTokenAliasType.REGISTER,
    tokenAlias: 0n,
    tokenType: CAT_TOKEN_TYPE,
    tokenValue: TOKEN_VALUE,
  });
  assert.deepEqual(register, { cat: "%c4m%" });

  // CAT 以外の Token Type (0 は out-of-band) は authInfo を持たない
  assert.isUndefined(
    catalogAuthInfoForSetupToken({
      aliasType: AuthorizationTokenAliasType.USE_VALUE,
      tokenType: 0n,
      tokenValue: TOKEN_VALUE,
    }),
  );
  // DELETE / USE_ALIAS は Token Type を持たないため判定できない
  assert.isUndefined(
    catalogAuthInfoForSetupToken({ aliasType: AuthorizationTokenAliasType.DELETE, tokenAlias: 0n }),
  );
  assert.isUndefined(
    catalogAuthInfoForSetupToken({
      aliasType: AuthorizationTokenAliasType.USE_ALIAS,
      tokenAlias: 0n,
    }),
  );
  // トークンが無ければ authInfo を持たない
  assert.isUndefined(catalogAuthInfoForSetupToken(undefined));
});

/**
 * 配信が書いた authInfo が視聴側で読め、fragment の `c4m` で置換できることを確かめる。
 *
 * - §5.2.42: authInfo は Track Object の Object であり、decodeCatalogMessage が保持する
 * - §5.4 / §5.2.43: 変数参照 `%c4m%` は、catalog を得た URI の fragment の `c4m` の値で
 *   置換できる。§5.4.1 は変数の値に英数字 / `-` / `_` / `@` しか許さないため、`-` と `_` を
 *   含むパディング無しの base64url の値でも置換できる
 */
test("catalogAuthInfoForSetupToken: 書いた authInfo が読め、fragment の c4m で置換できる", () => {
  const authInfo = catalogAuthInfoForSetupToken({
    aliasType: AuthorizationTokenAliasType.USE_VALUE,
    tokenType: CAT_TOKEN_TYPE,
    tokenValue: TOKEN_VALUE,
  });
  if (authInfo === undefined) {
    throw new Error("expected authInfo for a CAT");
  }
  const catalog = createCatalog([
    {
      name: "video",
      packaging: "loc",
      isLive: true,
      role: "video",
      codec: "vp8",
      bitrate: 1000,
      authInfo,
    },
  ]);

  const decoded = decodeCatalogMessage(encodeCatalog(catalog));
  if (!("version" in decoded)) {
    throw new Error("expected a full catalog, got a delta update");
  }
  assert.deepEqual(decoded.tracks[0].authInfo, { cat: "%c4m%" });

  // パディング無しの base64url は - と _ を含みうる
  const c4m = "0oRD-_ab";
  const resolved = resolveCatalogVariables(decoded, { c4m });
  assert.deepEqual(resolved.tracks[0].authInfo, { cat: c4m });
});

// --- createC4mAuthorizationToken / resolveMsfAuthorizationToken ---
// draft-ietf-moq-msf-01 §11.1.1 (c4m) / §11.4.3 (Presenting Authorization)
// draft-ietf-moq-c4m-01 §7.1 Table 4 (Token Type 0x01 = CAT)
// draft-ietf-moq-transport-22 §9.1.4 (AUTHORIZATION TOKEN Setup Option) / §8.9 (Token 構造)

test("createC4mAuthorizationToken: 標準 Base64 を USE_VALUE / Token Type 1 (CAT) にする", () => {
  // "AQID" は [0x01, 0x02, 0x03] の標準 Base64 (パディング不要)
  const token = createC4mAuthorizationToken("AQID");

  assert.isDefined(token);
  // draft-ietf-moq-transport-22 §8.9: SETUP では DELETE / USE_ALIAS を送れないため USE_VALUE
  assert.strictEqual(token?.aliasType, AuthorizationTokenAliasType.USE_VALUE);
  // draft-ietf-moq-c4m-01 §7.1 Table 4: 0x01 は CAT
  assert.strictEqual(token?.tokenType, 1n);
  assert.deepEqual(token?.tokenValue, new Uint8Array([0x01, 0x02, 0x03]));
});

test("createC4mAuthorizationToken: base64url (パディング無し) を復号する", () => {
  // "3q2-7w" は [0xde, 0xad, 0xbe, 0xef] の base64url (c4m-01 付録 A と同じ形式)
  const token = createC4mAuthorizationToken("3q2-7w");

  assert.isDefined(token);
  assert.deepEqual(token?.tokenValue, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
});

test("createC4mAuthorizationToken: base64url の - と _ を復号する", () => {
  // "----" は [0xfb, 0xef, 0xbe]、"__8" は [0xff, 0xff] の base64url
  assert.deepEqual(
    createC4mAuthorizationToken("----")?.tokenValue,
    new Uint8Array([0xfb, 0xef, 0xbe]),
  );
  assert.deepEqual(createC4mAuthorizationToken("__8")?.tokenValue, new Uint8Array([0xff, 0xff]));
});

test("createC4mAuthorizationToken: 標準 Base64 の + / とパディングを復号する", () => {
  // "//8=" は [0xff, 0xff] の標準 Base64 (パディング付き)
  assert.deepEqual(createC4mAuthorizationToken("//8=")?.tokenValue, new Uint8Array([0xff, 0xff]));
});

test("createC4mAuthorizationToken: Base64 として復号できない値は undefined", () => {
  // 値が空の c4m= はトークンを運んでいない
  assert.isUndefined(createC4mAuthorizationToken(""));
  assert.isUndefined(createC4mAuthorizationToken("not base64!!"));
  // 端数のビットが 0 でない非正規な Base64 も拒否する (RFC 4648 Section 3.5)
  assert.isUndefined(createC4mAuthorizationToken("QUF="));
});

test("resolveMsfAuthorizationToken: msf fragment の c4m を Authorization Token にする", () => {
  const token = resolveMsfAuthorizationToken({
    type: "msf",
    value: "room-123--catalog&c4m=AQID",
  });

  assert.isDefined(token);
  assert.strictEqual(token?.aliasType, AuthorizationTokenAliasType.USE_VALUE);
  assert.strictEqual(token?.tokenType, 1n);
  assert.deepEqual(token?.tokenValue, new Uint8Array([0x01, 0x02, 0x03]));
});

test("resolveMsfAuthorizationToken: c4m 以外のパラメータが並んでいても c4m を使う", () => {
  // connection=wt は transport 選択、location-range は subclip の指定であり、c4m と共存する
  const token = resolveMsfAuthorizationToken({
    type: "msf",
    value: "room-123--catalog&connection=wt&c4m=AQID&location-range=34-64",
  });

  assert.deepEqual(token?.tokenValue, new Uint8Array([0x01, 0x02, 0x03]));
});

test("resolveMsfAuthorizationToken: 複数の c4m は最初の値を使う", () => {
  // msf は c4m の複数指定を規定していないため、既存の getC4mParameter と同じく最初の値を使う
  const token = resolveMsfAuthorizationToken({
    type: "msf",
    value: "room-123--catalog&c4m=AQID&c4m=BAUG",
  });

  assert.deepEqual(token?.tokenValue, new Uint8Array([0x01, 0x02, 0x03]));
});

test("resolveMsfAuthorizationToken: fragment なし / msf 以外 / c4m なしは undefined", () => {
  assert.isUndefined(resolveMsfAuthorizationToken(null));
  // fragment type identifier が msf でない場合は c4m を探さない
  assert.isUndefined(resolveMsfAuthorizationToken({ type: "loc", value: "room--video&c4m=AQID" }));
  assert.isUndefined(resolveMsfAuthorizationToken({ type: "msf", value: "room-123--catalog" }));
  assert.isUndefined(
    resolveMsfAuthorizationToken({ type: "msf", value: "room-123--catalog&connection=wt" }),
  );
});

test("resolveMsfAuthorizationToken: 復号できない c4m は throw し、値とメッセージに残さない", () => {
  let thrown: Error | undefined;
  try {
    // 空白と ! を含む値は Base64 として復号できない
    resolveMsfAuthorizationToken({
      type: "msf",
      value: "room-123--catalog&c4m=not base64!!",
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.strictEqual(
    thrown?.message,
    "msf fragment c4m must be a Base64 encoded C4M token (draft-ietf-moq-msf-01 Section 11.1.1)",
  );
  // 認可トークンの値はエラーメッセージへ出さない
  assert.isFalse(thrown?.message.includes("not base64!!"));
});

test("resolveMsfAuthorizationToken: 値が空の c4m= は throw する", () => {
  // c4m= はトークンを運んでいないため、空の Token Value を送らずに接続前でエラーにする
  let thrown: Error | undefined;
  try {
    resolveMsfAuthorizationToken({ type: "msf", value: "room-123--catalog&c4m=" });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
});
