/**
 * Catalog / Catalog Delta の encode / decode (draft-ietf-moq-msf-01 §5.1 / §5.1.6 / §5.3)
 *
 * JSON バイト列と Catalog 型の相互変換を担う。decode 時の MUST 違反は
 * plain `Error` で throw する。
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
import { assertJsonSafeBigInt } from "./json";
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
 * ECMAScript の `JSON.stringify` は object property の挿入順を保持する
 * (V8 / SpiderMonkey / JavaScriptCore の標準動作)。fixed-order object
 * literal で構築することで draft-01 の MUST 順序を守る。
 *
 * フィールド順序: `version → generatedAt → isComplete → tracks → publishTracks → initDataList`
 */
export function encodeCatalog(catalog: Catalog): Uint8Array {
  // §5.1.3: isComplete MUST NOT be included if FALSE → encode 時に true のみ通す。
  if (catalog.isComplete !== undefined && !catalog.isComplete) {
    throw new Error(
      `invalid catalog: isComplete must be true if present per §5.1.3, got ${String(catalog.isComplete)}`,
    );
  }

  // fixed-order object literal で挿入順を保証する。
  // §5.1.7 「MUST be located after the tracks array」を守るため、initDataList を tracks より後に置く。
  // 各 optional フィールドは undefined を保持しない。
  // template の Location は内部 bigint だが JSON.stringify は bigint を扱えないため、
  // serialize 時に number へ変換する (decode 側で bigint に戻す)。
  const obj: Record<string, unknown> = {};
  obj["version"] = catalog.version;
  if (catalog.generatedAt !== undefined) {
    obj["generatedAt"] = catalog.generatedAt;
  }
  if (catalog.isComplete === true) {
    obj["isComplete"] = true;
  }
  obj["tracks"] = catalog.tracks.map(serializeTrackForJson);
  if (catalog.publishTracks !== undefined) {
    obj["publishTracks"] = catalog.publishTracks.map(serializeTrackForJson);
  }
  if (catalog.initDataList !== undefined) {
    obj["initDataList"] = catalog.initDataList;
  }
  // root level の未知フィールドを保持する（§5: parser MUST ignore unknown fields の保持解釈）
  const catalogRecord = catalog as unknown as Record<string, unknown>;
  for (const key of Object.keys(catalog)) {
    if (!KNOWN_CATALOG_ROOT_FIELDS.has(key)) {
      obj[key] = catalogRecord[key];
    }
  }

  const json = JSON.stringify(obj);
  return new TextEncoder().encode(json);
}

/**
 * track を JSON シリアライズ可能な形に変換する (bigint → number)。
 *
 * `template` の Location bigint は number に変換する。それ以外のフィールドは
 * そのまま返す。`Object.assign` で shallow copy し、template だけ差し替える。
 */
function serializeTrackForJson(track: CatalogTrack): Record<string, unknown> {
  if (track.template === undefined) {
    return track as unknown as Record<string, unknown>;
  }
  const [startMt, deltaMt, startLoc, deltaLoc, startWc, deltaWc] = track.template;
  // template Location も MOQT GroupID / ObjectID 由来の unsigned 整数。Media/Event Timeline
  // と同じく encode 時に precision loss / 負数 / safe integer 範囲外を reject する
  // (自分の出力を自分で decode できないペアを生まない)。
  const context = `track '${track.name}'`;
  assertJsonSafeBigInt(startLoc[0], "template startLocation[0]", context);
  assertJsonSafeBigInt(startLoc[1], "template startLocation[1]", context);
  assertJsonSafeBigInt(deltaLoc[0], "template deltaLocation[0]", context);
  assertJsonSafeBigInt(deltaLoc[1], "template deltaLocation[1]", context);
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
 */
export function encodeCatalogDelta(delta: CatalogDelta): Uint8Array {
  // §5.3: A delta update MUST include the Delta Update field with at least one operation.
  if (delta.operations.length === 0) {
    throw new Error(
      "invalid catalog delta: deltaUpdate must contain at least one operation per §5.3",
    );
  }

  // operation の TS 内部表現 (`type`) を wire format (`op`) に変換する。
  // remove operation の tracks は RemoveTrack[] (template を持たない) でそのまま JSON 化できるが、
  // add / clone は CatalogTrack[] であり template の bigint Location を含み得るため、
  // encodeCatalog と同じ serializeTrackForJson を経由して bigint → number 変換する。
  const deltaUpdate = delta.operations.map((operation) => {
    if (operation.type === "remove") {
      return { op: operation.type, tracks: operation.tracks };
    }
    return { op: operation.type, tracks: operation.tracks.map(serializeTrackForJson) };
  });

  // fixed-order object literal: deltaUpdate を先頭に、generatedAt があれば末尾に置く。
  const obj: Record<string, unknown> = { deltaUpdate };
  if (delta.generatedAt !== undefined) {
    obj["generatedAt"] = delta.generatedAt;
  }
  // root level の未知フィールドを保持する（§5 保持解釈。full 側 encodeCatalog と同一方針）。
  // 内部表現 (deltaUpdate マーカー・operations 配列) は除外する
  const deltaRecord = delta as unknown as Record<string, unknown>;
  for (const key of Object.keys(delta)) {
    if (!KNOWN_CATALOG_DELTA_ROOT_FIELDS.has(key)) {
      obj[key] = deltaRecord[key];
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
    delta.generatedAt = generatedAt;
  }

  // §5 parser MUST ignore unknown fields → 検証はしないが full 側と同様に保持する（§5 保持解釈）。
  // 内部表現 (deltaUpdate マーカー・operations 配列) は wire 名と異なるため除外する。
  // §5.3 が MUST NOT とするのは version / tracks のみのため、それ以外
  // (publishTracks 等) は未知として保持する。
  const deltaRecord = delta as unknown as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!KNOWN_CATALOG_DELTA_ROOT_FIELDS.has(key)) {
      deltaRecord[key] = obj[key];
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
