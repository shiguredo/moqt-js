/**
 * Catalog / Catalog Delta の encode / decode (draft-ietf-moq-msf-01 §5.1 / §5.1.6 / §5.3)
 *
 * JSON バイト列と Catalog 型の相互変換を担う。encode / decode の MUST 違反は plain `Error` で
 * throw する (`JSON.stringify` に載せられない値 (template 以外の bigint など) だけは TypeError
 * になる。Catalog の型では表現できない入力である)。
 *
 * 参照: draft-ietf-moq-msf-01
 */

import {
  KNOWN_CATALOG_DELTA_ROOT_FIELDS,
  KNOWN_CATALOG_ROOT_FIELDS,
  validateCatalog,
  validateCatalogTrack,
  validateRemoveTrack,
} from "./catalogValidation";
import { validateMediaTimelineTemplate } from "./catalogTrackValidation";
import { assertFiniteNumber } from "./json";
import { setOwnField } from "./ownFields";
import type {
  Catalog,
  CatalogDelta,
  CatalogDeltaOperation,
  CatalogMessage,
  CatalogTrack,
  RemoveTrack,
} from "./types";

// =============================================================================
// Catalog encode/decode
// =============================================================================

/**
 * フルカタログを JSON バイト列にエンコードする
 *
 * draft-ietf-moq-msf-01 §5.1.7: The Initialization Data List, if present,
 * MUST be located after the tracks array in the root of the JSON catalog.
 *
 * 送る形 (JSON) を `decodeCatalogMessage` に通してから返す。track と root の MUST / 型
 * (§5.1.1 / §5.1.2 / §5.1.3 / §5.1.4 / §5.1.5 / §5.1.7 / §5.2 / §7.2 / §8.2 / §9.4 / §10.4) は
 * decode 側と同じ関数・同じ文言で検証されるため、ライブラリ自身が「自分の
 * `decodeCatalogMessage` で読めない Catalog」を送る経路が残らない (相互接続の相手が拒否する
 * かどうかは、decode が検証する範囲に依存する)。従来 encode できていた違反 Catalog を拒否する
 * 破壊的変更になる。
 *
 * ECMAScript の `JSON.stringify` は object property の挿入順を保持する
 * (V8 / SpiderMonkey / JavaScriptCore の標準動作)。fixed-order object
 * literal で構築することで draft-01 の MUST 順序を守る。
 *
 * フィールド順序: `version → generatedAt → isComplete → tracks → publishTracks → initDataList`
 */
export function encodeCatalog(catalog: Catalog): Uint8Array {
  return buildCatalogBytes(catalog);
}

/**
 * Catalog がそのまま送れるかを検証する
 *
 * `createCatalog` が生成の時点で違反に気づくために使う。検証は `encodeCatalog` と同じ経路
 * (作ったバイト列を `decodeCatalogMessage` に通す) で行う。検証だけを行う入口は公開しない
 * (`src/msf.ts` / `src/index.ts` は Catalog / Timeline / fragment の解析 / トラック検索を公開し、
 * 内部ヘルパーはモジュール内に留める方針)。
 */
export function assertCatalogEncodable(catalog: Catalog): void {
  buildCatalogBytes(catalog);
}

/**
 * Catalog を wire のバイト列にする
 *
 * 検証は内部表現ではなく、実際に送る JSON に対して行う。`JSON.stringify` は toJSON と getter を
 * 呼び、非有限数を null にし、値が undefined のプロパティを落とし、疎配列の穴を null にする。
 * 内部表現をそのまま検証すると、これらの変換の分だけ「検証した値」と「送る値」がずれる。
 * 作ったバイト列をそのまま `decodeCatalogMessage` に通すことで、検証対象と送る対象を一致させる。
 *
 * JSON に出せない値 (template 以外の bigint、循環参照) は `JSON.stringify` が TypeError になる
 * (Catalog の型では表現できない入力であり、本関数では塞がない)。
 */
function buildCatalogBytes(catalog: Catalog): Uint8Array {
  // fixed-order object literal で挿入順を保証する。
  // §5.1.7 「MUST be located after the tracks array」を守るため、initDataList を tracks より後に置く。
  // 各 optional フィールドは undefined を保持しない。
  // template の Location は内部 bigint だが JSON.stringify は bigint を扱えないため、
  // serialize 時に number へ変換する (decode 側で bigint に戻す)。
  const catalogRecord = catalog as unknown as Record<string, unknown>;
  const obj: Record<string, unknown> = {};
  obj["version"] = catalog.version;
  if (catalog.generatedAt !== undefined) {
    obj["generatedAt"] = catalog.generatedAt;
  }
  // §5.1.3: isComplete は own で enumerable なプロパティのときだけ wire に載せる (`JSON.stringify`
  // が読む値と同じ基準)。getter を 2 回読まないよう、値は 1 回だけ読む。`JSON.stringify` が
  // 出力しない値 (undefined / 関数 / シンボル / `toJSON` が undefined を返す値) は載らず、
  // 載った値が true 以外 (false / 非 boolean) なら自己 decode が decode と同じ文言で拒否する。
  const isComplete = catalog.isComplete;
  if (Object.keys(catalog).includes("isComplete") && isComplete !== undefined) {
    obj["isComplete"] = isComplete;
  }
  obj["tracks"] = serializeTracksForJson(catalog.tracks);
  if (catalog.publishTracks !== undefined) {
    obj["publishTracks"] = serializeTracksForJson(catalog.publishTracks);
  }
  if (catalog.initDataList !== undefined) {
    obj["initDataList"] = catalog.initDataList;
  }
  // root level の未知フィールドを保持する（§5: parser MUST ignore unknown fields の保持解釈）
  for (const key of Object.keys(catalog)) {
    if (!KNOWN_CATALOG_ROOT_FIELDS.has(key)) {
      setOwnField(obj, key, catalogRecord[key]);
    }
  }

  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  // 実際に送るバイト列を自分で decode して検証する (検証対象と送る対象を一致させる)
  const decoded = decodeCatalogMessage(bytes);
  // root の未知フィールドが `deltaUpdate` のときは delta update として読まれる。full catalog を
  // 名乗る関数が delta のバイト列を返さないよう、ここで確かめる (§5.1.6)。
  if (!("version" in decoded)) {
    throw new Error(
      "invalid catalog: the encoded JSON is read as a delta update per §5.1.6, got a catalog with a deltaUpdate field",
    );
  }
  return bytes;
}

/**
 * track の配列を JSON に載せる形へ変換する
 *
 * 実行時には配列でない値・object でない要素もあり得る (JavaScript から組み立てた Catalog)。
 * それらは変換せずそのまま載せ、`decodeCatalogMessage` の検証 (`tracks must be an array per
 * §5.1.4` / `invalid track: expected object`) に委ねる。ここで `map` や `template` を無条件に
 * 読むと TypeError になり、ライブラリの「検証違反は plain Error」という契約から外れる。
 */
function serializeTracksForJson(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  return value.map((track) => {
    if (typeof track !== "object" || track === null) {
      return track;
    }
    return serializeTrackForJson(track as CatalogTrack);
  });
}

/**
 * track を JSON シリアライズ可能な形に変換する (bigint → number)。
 *
 * `template` の Location bigint は number に変換する。それ以外のフィールドは
 * そのまま返す。スプレッドで shallow copy し、template だけ差し替える (`Object.assign`
 * は `[[Set]]` 経由で写すため、own `__proto__` で `[[Prototype]]` を差し替えてしまう)。
 *
 * template は変換の前に decode と同じ関数 (§7.4.1) で検証する。形が壊れた値を読むと TypeError
 * になり、ライブラリの「検証違反は plain Error」という契約から外れるためである。Location の
 * precision loss (負値 / `Number.MAX_SAFE_INTEGER` 超) もこの検証で検出する。
 */
function serializeTrackForJson(track: CatalogTrack): Record<string, unknown> {
  if (track.template === undefined) {
    return track as unknown as Record<string, unknown>;
  }
  const [startMt, deltaMt, startLoc, deltaLoc, startWc, deltaWc] = validateMediaTimelineTemplate(
    track.template,
    track.name,
  );
  const serializedTemplate = [
    startMt,
    deltaMt,
    [Number(startLoc[0]), Number(startLoc[1])],
    [Number(deltaLoc[0]), Number(deltaLoc[1])],
    startWc,
    deltaWc,
  ];
  return { ...(track as unknown as Record<string, unknown>), template: serializedTemplate };
}

/**
 * 差分更新カタログを JSON バイト列にエンコードする
 * (draft-ietf-moq-msf-01 §5.1.6 / §5.3)
 *
 * wire format: `{"deltaUpdate": [{"op": "add", "tracks": [...]}, ...]}`
 *
 * `operations` 配列の宣言順を `deltaUpdate` 配列順として出力する。
 * 同一 `op` 値の複数出現が許可されているため、操作の重複検証は行わない
 * (draft-00 の制約を撤去)。
 *
 * track 単位の MUST の検証は行わない。`clone` は親から属性を継承するため、delta 単体では
 * 合成後の属性が決まらない (§5.1.6)。`add` / `remove` は delta 単体で属性が決まるが、encode の
 * 時点で何を検証すべきか (delta 単体か合成後か) の判断は `encodeCatalog` とは別になるため、
 * 本関数では対象外とする。decode した delta は `decodeCatalogMessage` が op ごとに検証し、
 * 合成後の packaging / role の MUST と (name, namespace) の uniqueness、initRef の参照切れは
 * `applyCatalogDelta` が検証する。
 *
 * root の `generatedAt` は型と有限数 (§5.1.2) を検証する。JSON は非有限数を null にし、送った
 * delta を自分で decode できなくなるためである (encodeCatalog の自己 decode に相当する検証を
 * delta の範囲では行わないための、最低限の確認)。
 *
 * track の `template` は JSON の形へ変換する前提の検証 (§5.2.15 / §7.4.1) だけを encode 時に行い、
 * 違反は plain `Error` で拒否する。それ以外の track 単位の MUST と、`tracks` が配列でない場合は
 * wire に載せて decode の検証に委ねる。
 *
 * 実行時には JavaScript から組み立てた delta で `operations` や operation の型が崩れ得るため、
 * それらは plain `Error` で拒否する (配列の `length` や operation のフィールドを無条件に読むと
 * TypeError になる)。
 */
export function encodeCatalogDelta(delta: CatalogDelta): Uint8Array {
  // 実行時には配列でない値もあり得る (§5.3: at least one operation の MUST は要素数で判定する)
  const operations: unknown = delta.operations;
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error(
      "invalid catalog delta: deltaUpdate must contain at least one operation per §5.3",
    );
  }

  // operation の TS 内部表現 (`type`) を wire format (`op`) に変換する。
  // remove operation の tracks は RemoveTrack[] (template を持たない) でそのまま JSON 化できるが、
  // add / clone は CatalogTrack[] であり template の bigint Location を含み得るため、
  // encodeCatalog と同じ変換を経由して bigint → number 変換する。
  const deltaUpdate = operations.map((operation, index) => {
    if (typeof operation !== "object" || operation === null) {
      throw new Error(
        `invalid catalog delta operation at index ${index}: expected object, got ${
          operation === null ? "null" : typeof operation
        }`,
      );
    }
    // object であることは確認済みのため、内部表現として読む
    const currentOperation = operation as CatalogDeltaOperation;
    if (currentOperation.type === "remove") {
      return { op: currentOperation.type, tracks: currentOperation.tracks };
    }
    return {
      op: currentOperation.type,
      tracks: serializeTracksForJson(currentOperation.tracks),
    };
  });

  // fixed-order object literal: deltaUpdate を先頭に、generatedAt があれば末尾に置く。
  const obj: Record<string, unknown> = { deltaUpdate };
  const generatedAt: unknown = delta.generatedAt;
  if (generatedAt !== undefined) {
    if (typeof generatedAt !== "number") {
      throw new Error(
        `invalid catalog delta: generatedAt must be a number per §5.1.2, got ${typeof generatedAt}`,
      );
    }
    assertFiniteNumber(generatedAt, "generatedAt", "catalog delta", "§5.1.2");
    obj["generatedAt"] = generatedAt;
  }
  // root level の未知フィールドを保持する（§5 保持解釈。full 側 encodeCatalog と同一方針）。
  // 内部表現 (deltaUpdate マーカー・operations 配列) は除外する
  const deltaRecord = delta as unknown as Record<string, unknown>;
  for (const key of Object.keys(delta)) {
    if (!KNOWN_CATALOG_DELTA_ROOT_FIELDS.has(key)) {
      setOwnField(obj, key, deltaRecord[key]);
    }
  }

  const json = JSON.stringify(obj);
  return new TextEncoder().encode(json);
}

/**
 * JSON バイト列をカタログメッセージにデコードする
 * (draft-ietf-moq-msf-01 §5.1, §5.1.6, §5.3)
 *
 * - `deltaUpdate` フィールドが Array の場合 → `CatalogDelta` として返す
 * - `deltaUpdate` フィールドが Array 以外で含まれている → reject
 *   (draft-00 boolean 形式 `deltaUpdate: true` を含む)
 * - それ以外 → `Catalog` として `validateCatalog` で検証して返す
 */
export function decodeCatalogMessage(data: Uint8Array): CatalogMessage {
  const json = new TextDecoder().decode(data);
  const parsed = JSON.parse(json) as unknown;

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("invalid catalog message: expected object at root, got non-object value");
  }

  const obj = parsed as Record<string, unknown>;

  // §5.1.6 deltaUpdate field の有無 / 型で full catalog / delta update を判別する。
  if ("deltaUpdate" in obj) {
    if (!Array.isArray(obj["deltaUpdate"])) {
      throw new Error(
        `invalid catalog message: deltaUpdate must be an array per §5.1.6, got ${
          obj["deltaUpdate"] === null ? "null" : typeof obj["deltaUpdate"]
        }`,
      );
    }
    return decodeCatalogDelta(obj);
  }

  // draft-00 の root level `addTracks` / `removeTracks` / `cloneTracks` を含む JSON は
  // 旧形式の delta update 試行とみなして reject する。
  if ("addTracks" in obj || "removeTracks" in obj || "cloneTracks" in obj) {
    throw new Error(
      "invalid catalog message: addTracks/removeTracks/cloneTracks at root level are obsolete in draft-01 (use deltaUpdate array per §5.1.6)",
    );
  }

  // それ以外は full catalog として検証
  return validateCatalog(obj);
}

/**
 * オブジェクトを `CatalogDelta` にデコードする
 * (draft-ietf-moq-msf-01 §5.1.6 / §5.3)
 *
 * §5.3: MUST NOT contain an instance of a Tracks field or an MSF version field.
 */
function decodeCatalogDelta(obj: Record<string, unknown>): CatalogDelta {
  // §5.3 MUST NOT: version / tracks を含む delta は reject
  if ("version" in obj) {
    throw new Error(
      "invalid catalog delta: deltaUpdate must not contain MSF version field per §5.3",
    );
  }
  if ("tracks" in obj) {
    throw new Error("invalid catalog delta: deltaUpdate must not contain tracks field per §5.3");
  }

  const deltaUpdateRaw = obj["deltaUpdate"];
  if (!Array.isArray(deltaUpdateRaw)) {
    // decodeCatalogMessage 側で検証済みだが防御的に再チェック
    throw new Error("invalid catalog delta: deltaUpdate must be an array per §5.1.6");
  }
  // §5.3: at least one operation MUST
  if (deltaUpdateRaw.length === 0) {
    throw new Error(
      "invalid catalog delta: deltaUpdate must contain at least one operation per §5.3",
    );
  }

  const operations: CatalogDeltaOperation[] = [];
  for (let i = 0; i < deltaUpdateRaw.length; i++) {
    operations.push(decodeCatalogDeltaOperation(deltaUpdateRaw[i], i));
  }

  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations,
  };

  // §5.1.2: generatedAt は number。型不一致は MUST 違反として validate 側と同じく reject する
  // (catalog 経路との非対称を解消)。
  if ("generatedAt" in obj) {
    const generatedAt = obj["generatedAt"];
    if (typeof generatedAt !== "number") {
      throw new Error(
        `invalid catalog delta: generatedAt must be a number per §5.1.2, got ${typeof generatedAt}`,
      );
    }
    // 桁あふれした数値リテラル (1e999) は Infinity になる。再 encode で null になり自分で
    // decode できなくなるため受理しない (validateCatalog と同じ扱い)
    assertFiniteNumber(generatedAt, "generatedAt", "catalog delta", "§5.1.2");
    delta.generatedAt = generatedAt;
  }

  // §5 parser MUST ignore unknown fields → 検証はしないが full 側と同様に保持する（§5 保持解釈）。
  // 内部表現 (deltaUpdate マーカー・operations 配列) は wire 名と異なるため除外する。
  // §5.3 が MUST NOT とするのは version / tracks のみのため、それ以外
  // (publishTracks 等) は未知として保持する。
  const deltaRecord = delta as unknown as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!KNOWN_CATALOG_DELTA_ROOT_FIELDS.has(key)) {
      setOwnField(deltaRecord, key, obj[key]);
    }
  }

  return delta;
}

/**
 * delta update 内の単一 operation を検証して `CatalogDeltaOperation` に変換する
 * (draft-ietf-moq-msf-01 §5.1.6)
 */
function decodeCatalogDeltaOperation(value: unknown, index: number): CatalogDeltaOperation {
  if (typeof value !== "object" || value === null) {
    throw new Error(
      `invalid catalog delta operation at index ${index}: expected object, got ${value === null ? "null" : typeof value}`,
    );
  }
  const op = (value as Record<string, unknown>)["op"];
  const tracksRaw = (value as Record<string, unknown>)["tracks"];

  if (typeof op !== "string") {
    throw new Error(
      `invalid catalog delta operation at index ${index}: op must be a string per §5.1.6, got ${typeof op}`,
    );
  }
  if (!Array.isArray(tracksRaw)) {
    throw new Error(
      `invalid catalog delta operation at index ${index}: tracks must be an array per §5.1.6, got ${
        tracksRaw === undefined ? "undefined" : typeof tracksRaw
      }`,
    );
  }

  if (op === "add") {
    const tracks: CatalogTrack[] = tracksRaw.map((track) =>
      validateCatalogTrack(track, { source: "add" }),
    );
    return { type: "add", tracks };
  }
  if (op === "remove") {
    const tracks: RemoveTrack[] = tracksRaw.map((track, j) => validateRemoveTrack(track, index, j));
    return { type: "remove", tracks };
  }
  if (op === "clone") {
    const tracks: CatalogTrack[] = tracksRaw.map((track) =>
      validateCatalogTrack(track, { source: "clone" }),
    );
    return { type: "clone", tracks };
  }

  throw new Error(
    `invalid catalog delta operation at index ${index}: unknown op '${op}', expected one of [add, remove, clone]`,
  );
}
