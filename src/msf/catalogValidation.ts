/**
 * Catalog メッセージの検証 (draft-ietf-moq-msf-01 §5.1 / §5.2)
 *
 * root level (version / tracks / isComplete / generatedAt / publishTracks /
 * initDataList) と track 単体の MUST / MUST NOT を検証する。track の各フィールド
 * 検証は catalogTrackValidation に委譲する。検証違反は plain `Error` で throw する。
 *
 * 参照: draft-ietf-moq-msf-01
 */

import { buildValidatedCatalogTrack } from "./catalogTrackValidation";
import { MSF_KNOWN_VERSIONS } from "./version";
import type { MsfVersion, PackagingType } from "./version";
import type {
  Catalog,
  CatalogTrack,
  InitDataEntry,
  PublishTrack,
  RemoveTrack,
  ValidationContext,
} from "./types";

// =============================================================================
// Catalog 検証
// =============================================================================

/**
 * unknown 値を `Catalog` として検証して返す (draft-ietf-moq-msf-01 §5.1)
 *
 * §5: A parser MUST ignore fields it does not understand.
 * 未知フィールド (root level) は ignore する。
 *
 * MUST 違反のみ throw する。`Error` メッセージは「先頭小文字、末尾ピリオドなし、
 * 期待値と実際値を含む」方針に従う。
 */
export function validateCatalog(value: unknown): Catalog {
  if (typeof value !== "object" || value === null) {
    throw new Error(
      `invalid catalog: expected object at root, got ${value === null ? "null" : typeof value}`,
    );
  }
  const obj = value as Record<string, unknown>;

  // §5.1.1 version: MSF_KNOWN_VERSIONS に含まれること
  const version = obj["version"];
  if (typeof version !== "string") {
    throw new Error(
      `invalid catalog: version must be a string per §5.1.1, got ${
        version === undefined ? "undefined" : typeof version
      }`,
    );
  }
  if (!MSF_KNOWN_VERSIONS.has(version as MsfVersion)) {
    const expected = Array.from(MSF_KNOWN_VERSIONS).join(", ");
    throw new Error(
      `invalid catalog: unsupported MSF version '${version}', expected one of [${expected}]`,
    );
  }

  // §5.1.4 tracks: Array MUST
  const tracksRaw = obj["tracks"];
  if (!Array.isArray(tracksRaw)) {
    throw new Error(
      `invalid catalog: tracks must be an array per §5.1.4, got ${
        tracksRaw === undefined ? "undefined" : typeof tracksRaw
      }`,
    );
  }

  // §5.1.3 isComplete: false 値は MUST NOT include 違反
  let isComplete: true | undefined;
  if ("isComplete" in obj) {
    if (obj["isComplete"] === true) {
      isComplete = true;
    } else {
      throw new Error(
        `invalid catalog: isComplete must not be included if false per §5.1.3, got ${String(
          obj["isComplete"],
        )}`,
      );
    }
  }

  // §5.1.2 generatedAt: optional number
  let generatedAt: number | undefined;
  if ("generatedAt" in obj) {
    const value = obj["generatedAt"];
    if (typeof value !== "number") {
      throw new Error(
        `invalid catalog: generatedAt must be a number per §5.1.2, got ${typeof value}`,
      );
    }
    generatedAt = value;
  }

  // tracks 配列内の各エントリを検証
  const tracks: CatalogTrack[] = tracksRaw.map((track) =>
    validateCatalogTrack(track, { source: "root" }),
  );

  // §5.2.3 「track names MUST be unique per namespace」を tracks 配列内で個別に検証する。
  // namespace 未指定なエントリの正規化に root のカタログ namespace は不要 (root catalog の
  // tracks 配列は relative であり、subscriber 側で catalog track の namespace を解決時に補完する)。
  assertTrackNameUnique(tracks, "tracks");

  // §5.1.5 publishTracks: optional Array
  let publishTracks: PublishTrack[] | undefined;
  if ("publishTracks" in obj) {
    const value = obj["publishTracks"];
    if (!Array.isArray(value)) {
      throw new Error(
        `invalid catalog: publishTracks must be an array per §5.1.5, got ${typeof value}`,
      );
    }
    publishTracks = value.map((track) => validateCatalogTrack(track, { source: "publishTracks" }));
    assertTrackNameUnique(publishTracks, "publishTracks");
  }

  // §5.1.7 initDataList: optional Array、id は配列内 unique
  let initDataList: InitDataEntry[] | undefined;
  if ("initDataList" in obj) {
    const value = obj["initDataList"];
    if (!Array.isArray(value)) {
      throw new Error(
        `invalid catalog: initDataList must be an array per §5.1.7, got ${typeof value}`,
      );
    }
    initDataList = value.map((entry, i) => validateInitDataEntry(entry, i));
    const ids = new Set<string>();
    for (const entry of initDataList) {
      if (ids.has(entry.id)) {
        throw new Error(
          `invalid catalog: duplicate initDataList id '${entry.id}', ids must be unique within the catalog per §5.1.7`,
        );
      }
      ids.add(entry.id);
    }
  }

  // §5 parser MUST ignore unknown fields → 検証はしないが保持する（§5.4 Variable Substitution 対象）
  const catalog: Catalog = { version: version as MsfVersion, tracks };
  if (generatedAt !== undefined) catalog.generatedAt = generatedAt;
  if (isComplete !== undefined) catalog.isComplete = isComplete;
  if (publishTracks !== undefined) catalog.publishTracks = publishTracks;
  if (initDataList !== undefined) catalog.initDataList = initDataList;
  // root level の未知フィールドを保持する（既知 6 key 以外）
  const catalogRecord = catalog as unknown as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!KNOWN_CATALOG_ROOT_FIELDS.has(key)) {
      catalogRecord[key] = obj[key];
    }
  }
  return catalog;
}

/**
 * tracks / publishTracks 配列内で `(name, namespace)` タプル uniqueness を検証する。
 * (draft-ietf-moq-msf-01 §5.2.3)
 *
 * §5.2.3: track names MUST be unique per namespace.
 *
 * namespace 未指定 (undefined) のエントリは「同じく namespace 未指定の他エントリ」と
 * のみ衝突判定する (catalog namespace が validation context にない root レベルの
 * 場合は両方未指定なら catalog-level namespace inherit で同一とみなされる)。
 */
export function assertTrackNameUnique(
  tracks: CatalogTrack[],
  arrayName: "tracks" | "publishTracks",
): void {
  // namespace を持つ track と持たない track を別容器で管理することで、
  // 文字列連結による衝突 (例: namespace="a b" name="c" と namespace="a" name="b c") を防ぐ。
  const seenWithNs = new Map<string, Set<string>>();
  const seenWithoutNs = new Set<string>();
  for (const track of tracks) {
    if (track.namespace === undefined) {
      if (seenWithoutNs.has(track.name)) {
        throw new Error(
          `invalid catalog: duplicate track name '${track.name}' under namespace (no namespace) in ${arrayName} per §5.2.3`,
        );
      }
      seenWithoutNs.add(track.name);
    } else {
      let names = seenWithNs.get(track.namespace);
      if (names === undefined) {
        names = new Set<string>();
        seenWithNs.set(track.namespace, names);
      }
      if (names.has(track.name)) {
        throw new Error(
          `invalid catalog: duplicate track name '${track.name}' under namespace '${track.namespace}' in ${arrayName} per §5.2.3`,
        );
      }
      names.add(track.name);
    }
  }
}

/**
 * `RemoveTrack` を検証する (draft-ietf-moq-msf-01 §5.1.6 "remove")
 *
 * §5.1.6: MUST include a Track Name, MAY include a Track Namespace,
 * MUST NOT hold any other fields.
 */
export function validateRemoveTrack(
  value: unknown,
  opIndex: number,
  trackIndex: number,
): RemoveTrack {
  if (typeof value !== "object" || value === null) {
    throw new Error(
      `invalid remove track at op[${opIndex}].tracks[${trackIndex}]: expected object, got ${
        value === null ? "null" : typeof value
      }`,
    );
  }
  const obj = value as Record<string, unknown>;

  const name = obj["name"];
  if (typeof name !== "string") {
    throw new Error(
      `invalid remove track at op[${opIndex}].tracks[${trackIndex}]: name must be a string per §5.1.6, got ${typeof name}`,
    );
  }

  const result: RemoveTrack = { name };

  if ("namespace" in obj) {
    const namespace = obj["namespace"];
    if (typeof namespace !== "string") {
      throw new Error(
        `invalid remove track at op[${opIndex}].tracks[${trackIndex}]: namespace must be a string per §5.1.6, got ${typeof namespace}`,
      );
    }
    result.namespace = namespace;
  }

  // §5.1.6: MUST NOT hold any other fields
  for (const key of Object.keys(obj)) {
    if (key !== "name" && key !== "namespace") {
      throw new Error(
        `invalid remove track at op[${opIndex}].tracks[${trackIndex}]: unexpected field '${key}', remove tracks accept only name and namespace per §5.1.6`,
      );
    }
  }

  return result;
}

/**
 * `InitDataEntry` を検証する (draft-ietf-moq-msf-01 §5.1.7)
 */
function validateInitDataEntry(value: unknown, index: number): InitDataEntry {
  if (typeof value !== "object" || value === null) {
    throw new Error(
      `invalid initDataList entry at index ${index}: expected object, got ${
        value === null ? "null" : typeof value
      }`,
    );
  }
  const obj = value as Record<string, unknown>;
  const id = obj["id"];
  const type = obj["type"];
  const data = obj["data"];
  if (typeof id !== "string") {
    throw new Error(
      `invalid initDataList entry at index ${index}: id must be a string per §5.1.7, got ${typeof id}`,
    );
  }
  if (typeof type !== "string") {
    throw new Error(
      `invalid initDataList entry at index ${index}: type must be a string per §5.1.7, got ${typeof type}`,
    );
  }
  if (typeof data !== "string") {
    throw new Error(
      `invalid initDataList entry at index ${index}: data must be a string per §5.1.7, got ${typeof data}`,
    );
  }
  return { id, type, data };
}

/**
 * unknown 値を `CatalogTrack` として検証して返す (draft-ietf-moq-msf-01 §5.2)
 *
 * `ctx.source` により validation rule を切り替える:
 * - `clone`: parentName MUST、parentNamespace MAY、それ以外の通常 track 必須 (name) を維持
 * - `add`: 通常の必須 (name, packaging, isLive) を検証、parentName / parentNamespace は禁止
 * - `root` / `publishTracks`: 通常の必須を検証、parentName / parentNamespace は禁止
 * - `publishTracks`: 加えて connectionUri / token を許可、それ以外は禁止
 *
 * その他の MUST / MUST NOT (eventType / template / buffers / encryption / mimeType 等)
 * は ctx 共通で検証する。
 *
 * §5: A parser MUST ignore fields it does not understand. → 既知フィールドのみ
 * pick して返し、未知フィールドは黙って捨てる。
 */
export function validateCatalogTrack(value: unknown, ctx: ValidationContext): CatalogTrack {
  if (typeof value !== "object" || value === null) {
    throw new Error(
      `invalid track: expected object, got ${value === null ? "null" : typeof value}`,
    );
  }
  const obj = value as Record<string, unknown>;

  // clone operation は parent 由来の属性継承を前提にしているため、name 以外の必須を緩める。
  if (ctx.source === "clone") {
    return validateCloneCatalogTrack(obj);
  }

  // 通常 track の必須フィールド
  const nameRaw = obj["name"];
  if (typeof nameRaw !== "string") {
    throw new Error(`invalid track: name must be a string per §5.2.3, got ${typeof nameRaw}`);
  }
  const name: string = nameRaw;

  const packagingRaw = obj["packaging"];
  if (typeof packagingRaw !== "string") {
    throw new Error(
      `invalid track '${name}': packaging must be a string per §5.2.4, got ${typeof packagingRaw}`,
    );
  }
  const packaging = packagingRaw as PackagingType;

  const isLiveRaw = obj["isLive"];
  if (typeof isLiveRaw !== "boolean") {
    throw new Error(
      `invalid track '${name}': isLive must be a boolean per §5.2.7, got ${typeof isLiveRaw}`,
    );
  }
  const isLive: boolean = isLiveRaw;

  // mimeType: §5.2.19 で正規フィールド名。lowercase `mimetype` を含めば reject (mimeType 同居も MUST NOT)。
  if ("mimetype" in obj) {
    throw new Error(
      `invalid track '${name}': use mimeType per draft-01 Table 3, got mimetype (lowercase)`,
    );
  }

  // parentName / parentNamespace は clone operation 専用 (§5.2.33 / §5.2.34)
  if ("parentName" in obj) {
    throw new Error(
      `invalid track '${name}': parentName must only be included inside a clone operation per §5.2.33`,
    );
  }
  if ("parentNamespace" in obj) {
    throw new Error(
      `invalid track '${name}': parentNamespace must only be included inside a clone operation per §5.2.34`,
    );
  }

  // connectionUri / token は publishTracks 専用 (§5.2.36 / §5.2.37)
  if (ctx.source !== "publishTracks") {
    if ("connectionUri" in obj) {
      throw new Error(
        `invalid track '${name}': connectionUri must only be used in publishTracks per §5.2.36`,
      );
    }
    if ("token" in obj) {
      throw new Error(
        `invalid track '${name}': token must only be used in publishTracks per §5.2.37`,
      );
    }
  }

  // 共通 MUST / MUST NOT 検証
  return buildValidatedCatalogTrack(obj, name, packaging, isLive);
}

/**
 * clone operation 内の track を検証する
 * (draft-ietf-moq-msf-01 §5.1.6 "clone" + §5.2.33 / §5.2.34)
 *
 * §5.1.6 "clone": Each track object MUST include a Parent Name field and
 * MAY include a Parent namespace field. The cloned track inherits all
 * attributes from the parent except the Track Name which MUST be new.
 *
 * clone は parent 由来属性を継承するため、packaging / isLive は MUST 解除する
 * (継承される)。name と parentName のみ MUST。
 */
function validateCloneCatalogTrack(obj: Record<string, unknown>): CatalogTrack {
  const name = obj["name"];
  if (typeof name !== "string") {
    throw new Error(`invalid clone track: name must be a string per §5.1.6, got ${typeof name}`);
  }
  const parentName = obj["parentName"];
  if (typeof parentName !== "string") {
    throw new Error(
      `invalid clone track '${name}': parentName must be a string per §5.1.6 / §5.2.33, got ${typeof parentName}`,
    );
  }

  // parentNamespace は MAY (optional)
  let parentNamespace: string | undefined;
  if ("parentNamespace" in obj) {
    const value = obj["parentNamespace"];
    if (typeof value !== "string") {
      throw new Error(
        `invalid clone track '${name}': parentNamespace must be a string per §5.2.34, got ${typeof value}`,
      );
    }
    parentNamespace = value;
  }

  // mimetype lowercase 検出 (mimeType 同居も含めて lowercase は MUST NOT)
  if ("mimetype" in obj) {
    throw new Error(
      `invalid clone track '${name}': use mimeType per draft-01 Table 3, got mimetype (lowercase)`,
    );
  }

  // clone operation 内も publishTracks 専用フィールド (§5.2.36 / §5.2.37) は MUST NOT
  if ("connectionUri" in obj) {
    throw new Error(
      `invalid clone track '${name}': connectionUri must only be used in publishTracks per §5.2.36`,
    );
  }
  if ("token" in obj) {
    throw new Error(
      `invalid clone track '${name}': token must only be used in publishTracks per §5.2.37`,
    );
  }

  // clone では packaging / isLive は不要だが、与えられた場合は型を検証する。
  const packagingRaw = obj["packaging"];
  if (packagingRaw !== undefined && typeof packagingRaw !== "string") {
    throw new Error(
      `invalid clone track '${name}': packaging must be a string when present per §5.2.4, got ${typeof packagingRaw}`,
    );
  }
  const isLiveRaw = obj["isLive"];
  if (isLiveRaw !== undefined && typeof isLiveRaw !== "boolean") {
    throw new Error(
      `invalid clone track '${name}': isLive must be a boolean when present per §5.2.7, got ${typeof isLiveRaw}`,
    );
  }
  const packaging: PackagingType | undefined = packagingRaw as PackagingType | undefined;
  const isLive = isLiveRaw;

  const track = buildValidatedCatalogTrack(obj, name, packaging, isLive, {
    skipPackagingRequiredFields: true,
  });
  track.parentName = parentName;
  if (parentNamespace !== undefined) {
    track.parentNamespace = parentNamespace;
  }
  return track;
}

/**
 * Catalog root の既知フィールド名（§5.1）。未知フィールド保持・置換時に除外するために使う。
 */
export const KNOWN_CATALOG_ROOT_FIELDS: ReadonlySet<string> = new Set([
  "version",
  "tracks",
  "generatedAt",
  "isComplete",
  "publishTracks",
  "initDataList",
]);

/**
 * CatalogDelta の既知ルートフィールド名（wire 名・内部表現・防御対象の和集合）。
 *
 * wire 名の `deltaUpdate` 配列は内部で `operations` に読み替えるため、
 * 両方を既知として扱い、未知フィールド保持の対象外にする。
 * `generatedAt` は両方向の除外に必須である。
 * `version` / `tracks` は decode で reject する MUST NOT のため、
 * cast 混入時の wire 漏出も抑止する。
 */
export const KNOWN_CATALOG_DELTA_ROOT_FIELDS: ReadonlySet<string> = new Set([
  "deltaUpdate",
  "operations",
  "generatedAt",
  "version",
  "tracks",
]);
