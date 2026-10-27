/**
 * Variable Substitution と置換後の参照検証
 * (draft-ietf-moq-msf-01 §5.4 / §5.2.13 / §5.1.7)
 *
 * 置換を行う `resolveCatalogVariables` が、置換後の Catalog の initRef が initDataList の
 * エントリを指していることも確かめる (置換前は `validateCatalog` が `%` を含む値を対象外に
 * しているため、参照切れの最後の砦になる)。
 *
 * 参照: draft-ietf-moq-msf-01
 */

import { KNOWN_CATALOG_ROOT_FIELDS, assertInitRefResolvable } from "./catalogValidation";
import { KNOWN_TRACK_FIELDS } from "./catalogTrackValidation";
import { setOwnField } from "./ownFields";
import type { AuthInfo, Catalog, CatalogTrack, InitDataEntry, PublishTrack } from "./types";

// =============================================================================
// Variable Substitution と置換後の参照検証
// =============================================================================

const VARIABLE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const VARIABLE_VALUE_PATTERN = /^[A-Za-z0-9_@-]*$/;
const VARIABLE_REFERENCE_PATTERN = /%([A-Za-z0-9_-]+)%/g;

/**
 * Catalog 内の string 値に対して `%name%` を置換した新しい Catalog を返す。
 * (draft-ietf-moq-msf-01 §5.4)
 *
 * §5.4.1:
 * - 変数名は英数字 / ハイフン / アンダースコアのみ、case-sensitive。
 * - 値は英数字 / ハイフン / アンダースコア / `@` のみ。
 * - `%` リテラルは変数参照の一部としてのみ許容される。
 *
 * §5.4.2: 変数は URL fragment 由来のみで解決する。query parameter MUST NOT。
 * 入力 `variables` の出所制御は呼び出し側の責務。
 *
 * 走査対象は `Catalog` の既知 named field 内 string 値に加え、root / track の未知フィールド
 * （`validateCatalog` が保持する、§5.6.14 例の `c4m` 等）の string 値も含む。未知フィールドは
 * ネストした object / array 内の string も再帰的に走査する（§5.4 に再帰規則は無いが本実装の方針）。
 *
 * 置換後は `initRef` の参照先を判定できるため、`initDataList` に無い `initRef` は throw する
 * (§5.2.13 / §5.1.7)。置換前は `%` を含む値の参照先を判定できないため `validateCatalog` が
 * 検証を skip しており、置換を行う本関数が最後の砦になる (`substituteString` が置換後に残った
 * `%` を reject するため、検証対象の `initRef` と `initDataList` の id に `%` は残らない。
 * `authInfo` のキーのように置換対象外の値には `%` が残り得る)。未定義変数は空文字になる
 * (§5.4 は未定義変数の扱いを定めていない) ため、`initRef: "%missing%"` は id が空文字の
 * エントリが無ければ参照切れとして throw する。
 *
 * `validateCatalog` 全体は再実行しない。検証は initRef の参照切れに限定する。置換で値が変わる
 * string フィールドが他の MUST の条件になっている場合は検証結果が変わり得るためである
 * (role を条件にする §5.2.18 / §5.2.22、codec を条件にする §5.2.28 / §5.2.29 など。
 * `role: "%r%"` が `video` になると codec / bitrate が必須になる)。置換結果を再 encode する
 * 呼び出し元では `encodeCatalog` が拒否するが、購読側のように置換結果を in-memory で使う経路
 * では検証されない。再実行すると、置換によって初めて生じる §5.2.3 の重複などの別の判断も混ざる。
 *
 * 同じ理由で置換によって初めて生じる §5.1.7 の `initDataList` の id 重複も検証しない
 * (送信時の `encodeCatalog` が拒否する。呼び出し元が `resolveInitData` で解決する場合は
 * 先頭の一致で解決されるため、参照切れと違って沈黙する点に注意する)。
 *
 * なお本関数を呼ばない経路 (購読側の `resolveInitData` の直呼びなど) は、wire 上の `%name%` を
 * 解決しないため保護されない。
 */
export function resolveCatalogVariables(
  catalog: Catalog,
  variables: Readonly<Record<string, string>>,
): Catalog {
  // 変数名と値の制約検証
  for (const [name, value] of Object.entries(variables)) {
    if (!VARIABLE_NAME_PATTERN.test(name)) {
      throw new Error(
        `invalid variable name '${name}': must consist of alphanumeric characters, hyphens, and underscores per §5.4.1`,
      );
    }
    if (!VARIABLE_VALUE_PATTERN.test(value)) {
      throw new Error(
        `invalid variable value for '${name}': '${value}' contains disallowed characters per §5.4.1`,
      );
    }
  }

  const result: Catalog = { ...catalog };
  // root level の未知フィールドにも %var% 置換を適用する（§5.4）。
  // result は spread 済みのため setOwnField に揃えても挙動は変わらない
  const catalogRecord = catalog as unknown as Record<string, unknown>;
  const resultRecord = result as unknown as Record<string, unknown>;
  for (const key of Object.keys(catalog)) {
    if (!KNOWN_CATALOG_ROOT_FIELDS.has(key)) {
      setOwnField(resultRecord, key, substituteUnknownValue(catalogRecord[key], variables, key));
    }
  }
  result.tracks = catalog.tracks.map((track) => substituteTrack(track, variables));
  if (catalog.publishTracks !== undefined) {
    result.publishTracks = catalog.publishTracks.map(
      (track) => substituteTrack(track, variables) as PublishTrack,
    );
  }
  if (catalog.initDataList !== undefined) {
    result.initDataList = catalog.initDataList.map((entry) =>
      substituteInitDataEntry(entry, variables),
    );
  }
  // §5.2.13 / §5.1.7: 置換後は参照先を判定できるため、参照切れの Catalog を返さない。
  assertInitRefResolvable(result.tracks, result.publishTracks, result.initDataList);
  return result;
}

function substituteString(
  value: string,
  variables: Readonly<Record<string, string>>,
  fieldPath: string,
): string {
  const replaced = value.replaceAll(VARIABLE_REFERENCE_PATTERN, (_match, name: string) => {
    if (!Object.hasOwn(variables, name)) {
      return "";
    }
    const replacement = variables[name];
    if (replacement === undefined) {
      // Object.hasOwn の真偽と index signature の型が一致しないため undefined を含むが、
      // OwnProperty がある場合は必ず string が入る。到達しない防御として空文字にする
      return "";
    }
    return replacement;
  });
  // 置換後に残った `%` は literal とみなして reject (§5.4.1)
  if (replaced.includes("%")) {
    throw new Error(
      `invalid catalog: literal % at ${fieldPath}='${value}' is not allowed per §5.4.1`,
    );
  }
  return replaced;
}

function substituteTrack(
  track: CatalogTrack,
  variables: Readonly<Record<string, string>>,
): CatalogTrack {
  const result: CatalogTrack = { ...track };
  // 動的キーで書き戻すため、既知 / 未知フィールドで共用する Record ビューを用意する
  const trackRecord = track as unknown as Record<string, unknown>;
  const resultRecord = result as unknown as Record<string, unknown>;
  // 単純な string field
  const stringFields: (keyof CatalogTrack)[] = [
    "name",
    "namespace",
    "eventType",
    "role",
    "label",
    "initRef",
    "codec",
    "mimeType",
    "channelConfig",
    "lang",
    "parentName",
    "parentNamespace",
    "encryptionScheme",
    "cipherSuite",
    "keyId",
    "trackBaseKey",
  ];
  for (const key of stringFields) {
    const value = track[key];
    if (typeof value === "string") {
      setOwnField(resultRecord, key, substituteString(value, variables, `tracks[].${key}`));
    }
  }
  // depends は string[]
  if (track.depends !== undefined) {
    result.depends = track.depends.map((d, i) =>
      substituteString(d, variables, `tracks[].depends[${i}]`),
    );
  }
  // accessibility は { scheme, value }[]
  if (track.accessibility !== undefined) {
    result.accessibility = track.accessibility.map((entry, i) => ({
      scheme: substituteString(entry.scheme, variables, `tracks[].accessibility[${i}].scheme`),
      value: substituteString(entry.value, variables, `tracks[].accessibility[${i}].value`),
    }));
  }
  // authInfo はキーと値が string のとき置換 (キーは scheme 識別子のため、ここでは値のみ走査)
  if (track.authInfo !== undefined) {
    const replaced: AuthInfo = {};
    for (const [k, v] of Object.entries(track.authInfo)) {
      if (typeof v === "string") {
        setOwnField(replaced, k, substituteString(v, variables, `tracks[].authInfo.${k}`));
      } else {
        setOwnField(replaced, k, v);
      }
    }
    result.authInfo = replaced;
  }
  // PublishTrack の追加フィールド
  const publishTrack = track as PublishTrack;
  if (publishTrack.connectionUri !== undefined) {
    (result as PublishTrack).connectionUri = substituteString(
      publishTrack.connectionUri,
      variables,
      "publishTracks[].connectionUri",
    );
  }
  if (publishTrack.token !== undefined) {
    (result as PublishTrack).token = substituteString(
      publishTrack.token,
      variables,
      "publishTracks[].token",
    );
  }
  // 未知フィールド（KNOWN_TRACK_FIELDS 以外）にも %var% 置換を適用する（§5.4、§5.6.14 例 c4m）。
  // §5.4 にネスト再帰規則は無いが、本実装ではネスト object / array 内の string も走査する
  // （再帰方針は本実装で定義しテストで固定する）。
  // result は spread 済みのため setOwnField に揃えても挙動は変わらない
  for (const key of Object.keys(track)) {
    if (!KNOWN_TRACK_FIELDS.has(key)) {
      setOwnField(
        resultRecord,
        key,
        substituteUnknownValue(trackRecord[key], variables, `tracks[].${key}`),
      );
    }
  }
  return result;
}

/**
 * 未知フィールドの値に対して再帰的に %var% 置換を適用する。
 *
 * string は substituteString で置換、array / object は要素・値を再帰走査、
 * それ以外（number / boolean / null）はそのまま返す。
 */
function substituteUnknownValue(
  value: unknown,
  variables: Readonly<Record<string, string>>,
  fieldPath: string,
): unknown {
  if (typeof value === "string") {
    return substituteString(value, variables, fieldPath);
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => substituteUnknownValue(item, variables, `${fieldPath}[${i}]`));
  }
  if (typeof value === "object" && value !== null) {
    const replaced: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      setOwnField(replaced, k, substituteUnknownValue(v, variables, `${fieldPath}.${k}`));
    }
    return replaced;
  }
  return value;
}

function substituteInitDataEntry(
  entry: InitDataEntry,
  variables: Readonly<Record<string, string>>,
): InitDataEntry {
  return {
    id: substituteString(entry.id, variables, "initDataList[].id"),
    type: substituteString(entry.type, variables, "initDataList[].type"),
    data: substituteString(entry.data, variables, "initDataList[].data"),
  };
}
