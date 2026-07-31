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
  resolveCatalogVariables,
  resolveInitData,
  parseMsfFragmentValue,
  getConnectionParameter,
  getWallclockRanges,
  getMediatimeRanges,
  getLocationRanges,
  getC4mParameter,
  validateCatalog,
  validateCatalogTrack,
} from "./msf";
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
  assert.throws(() => encodeCatalog(catalog), /isComplete must be true if present/);
});

test("Catalog: encodeCatalog の JSON フィールド順序は version→...→tracks→publishTracks→initDataList (§5.1.7)", () => {
  // §5.1.7: The Initialization Data List, if present, MUST be located after the tracks array.
  const catalog: Catalog = {
    version: "draft-01",
    tracks: [{ name: "video", packaging: "loc", isLive: true }],
    initDataList: [{ id: "v-init", type: "inline", data: "AQID" }],
    publishTracks: [{ name: "log", packaging: "moqlog", isLive: true }],
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

test("Catalog: tracks と publishTracks の合算 uniqueness は行わない (subscribe/publish 同名共存許容)", () => {
  const catalog: Catalog = {
    version: "draft-01",
    tracks: [{ name: "log", packaging: "loc", isLive: true }],
    publishTracks: [{ name: "log", packaging: "moqlog", role: "log", isLive: true }],
  };
  const encoded = encodeCatalog(catalog);
  // round-trip が成立する = 例外なくデコードされる
  const decoded = decodeCatalogMessage(encoded) as Catalog;
  assert.strictEqual(decoded.tracks[0].name, "log");
  assert.strictEqual(decoded.publishTracks?.[0].name, "log");
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

test("Catalog: 未知ルートフィールドは ignore する (§5)", () => {
  // §5: A parser MUST ignore fields it does not understand.
  const raw = {
    version: "draft-01",
    tracks: [{ name: "v", packaging: "loc", isLive: true }],
    customRootField: { foo: "bar" },
  };
  const decoded = decodeCatalogMessage(encodeRaw(raw)) as Catalog;
  assert.strictEqual(decoded.tracks[0].name, "v");
  assert.isFalse("customRootField" in decoded);
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

test("parseMsfFragmentValue: 複数 wallclock-range を順序保持で返す (§11.1.1)", () => {
  // §11.1.1: union of those ranges → 順序保持 + 重複許容
  const result = parseMsfFragmentValue("ns--track&wallclock-range=100-200&wallclock-range=300-400");
  assert.deepStrictEqual(result.parameters, [
    ["wallclock-range", "100-200"],
    ["wallclock-range", "300-400"],
  ]);
});

test("parseMsfFragmentValue: 大文字 hex (.2D) は reject (§11.1.2)", () => {
  assert.throws(() => parseMsfFragmentValue("ns.2D--track"), /lowercase hex digits/);
});

test("parseMsfFragmentValue: ~ リテラルは reject (§11.1.2 unreserved 文字集合違反)", () => {
  // §11.1.2: literal は [A-Za-z0-9_] のみ。`~` は MUST 非 literal なので一般 reject 経路で弾かれる。
  assert.throws(
    () => parseMsfFragmentValue("ns~name--track"),
    /unreserved character set in namespace is \[A-Za-z0-9_\]/,
  );
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

test("Media Timeline: 空配列の round-trip", async () => {
  const entries: MediaTimelineEntry[] = [];
  const encoded = await encodeMediaTimeline(entries);
  const decoded = await decodeMediaTimeline(encoded);
  assert.deepStrictEqual(decoded, entries);
});

test("Media Timeline: 通常の round-trip (gzip 撤廃後)", async () => {
  // draft-01 では options.gzip は撤廃され、無圧縮 JSON のみ
  const entries: MediaTimelineEntry[] = [
    [0, [0n, 0n], 1759924158381],
    [2002, [1n, 0n], 1759924160383],
  ];
  const encoded = await encodeMediaTimeline(entries);
  const decoded = await decodeMediaTimeline(encoded);
  // 先頭バイトが gzip magic (0x1f 0x8b) ではなく JSON `[` (0x5b) であることを確認
  assert.strictEqual(encoded[0], 0x5b);
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
// Event Timeline
// =============================================================================

test("Event Timeline: 空配列の round-trip", async () => {
  const entries: EventTimelineEntry[] = [];
  const encoded = await encodeEventTimeline(entries);
  const decoded = await decodeEventTimeline(encoded);
  assert.deepStrictEqual(decoded, entries);
});

test("Event Timeline: data 欠落は reject (§8.1)", async () => {
  const invalid = new TextEncoder().encode('[{"t": 123}]');
  await assertRejectsWithMessage(
    () => decodeEventTimeline(invalid),
    /invalid event timeline entry/,
  );
});

test("Event Timeline: t/l/m 複数指定は reject (§8.1)", async () => {
  const invalid = new TextEncoder().encode('[{"t": 1, "m": 2, "data": "x"}]');
  await assertRejectsWithMessage(
    () => decodeEventTimeline(invalid),
    /invalid event timeline entry/,
  );
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
