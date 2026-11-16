/**
 * Variable Substitution と置換後の参照検証
 * (draft-ietf-moq-msf-02 §5.4 / §5.2.14 / §5.1.7)
 *
 * 置換を行う `resolveCatalogVariables` が、置換後の Catalog の initRef が initDataList の
 * エントリを指していることも確かめる (置換前は `validateCatalog` が `%` を含む値を対象外に
 * しているため、参照切れの最後の砦になる)。
 *
 * 参照: draft-ietf-moq-msf-02
 */

import { KNOWN_CATALOG_ROOT_FIELDS, validateCatalog } from "./catalogValidation";
import { KNOWN_TRACK_FIELDS } from "./catalogTrackValidation";
import { setOwnField } from "./ownFields";
import type { AuthInfo, Catalog, CatalogTrack, InitDataEntry } from "./types";

// =============================================================================
// Variable Substitution と置換後の参照検証
// =============================================================================

/**
 * 変数値の文字集合 (draft-02 §5.4.1)
 *
 * §5.4.1: Variable values MUST consist only of alphanumeric characters, hyphens, underscores,
 * plus sign, forward slash, equals, period and the at sign (@). Special characters including
 * commas, semicolons, quotes, ampersands, and other punctuation MUST NOT appear.
 *
 * draft-01 は `+` `/` `=` `.` を許可していなかった。draft-02 で追加されたため、base64url 以外の
 * 値や URL の断片も変数として配れる。
 */
const VARIABLE_VALUE_PATTERN = /^[A-Za-z0-9_@+/.=-]*$/;

/**
 * 変数参照のパターン (draft-02 §5.4.1)
 *
 * draft-02 は変数名の文字集合を定めていないため、`%` に挟まれた非空の文字列を変数名として
 * 扱う。空の参照 (`%%`) は変数参照として解釈せず、literal の `%` として拒否する。
 */
const VARIABLE_REFERENCE_PATTERN = /%([^%]+)%/g;

/**
 * Catalog 内の string 値に対して `%name%` を置換した新しい Catalog を返す。
 * (draft-ietf-moq-msf-02 §5.4)
 *
 * §5.4.1:
 * - 変数名の文字集合は定められていない (draft-01 の制限は撤廃された)。case-sensitive。
 * - 値は英数字 / ハイフン / アンダースコア / `+` / `/` / `=` / `.` / `@` のみ。
 * - `%` リテラルは変数参照の一部としてのみ許容される。
 *
 * §5.4.2: 変数は URL fragment 由来のみで解決する。query parameter MUST NOT。
 * 入力 `variables` の出所制御は呼び出し側の責務。
 *
 * 走査対象は `Catalog` の既知 named field 内 string 値に加え、root / track の未知フィールド
 * （`validateCatalog` が保持する未知フィールド等）の string 値も含む。未知フィールドは
 * ネストした object / array 内の string も再帰的に走査する（§5.4 に再帰規則は無いが本実装の方針）。
 *
 * §13.5: 置換を行った catalog は、置換後の値で検証しなければならない (MUST)。本関数は
 * 置換の前後で `validateCatalog` を通す。
 *
 * - 置換前: 型を迂回した入力 (JavaScript から組み立てた値) に対して `TypeError` ではなく
 *   plain `Error` を返す (§5.1.1〜§5.2 の型検証を先に行う)
 * - 置換後: role / codec / mimeType を条件にする §5.2.19 / §5.2.23 / §5.2.29 / §5.2.30、
 *   packaging と role の組み合わせを条件にする §5.2.4.1、置換で初めて生じる §5.2.3 の
 *   Full Track Name 重複と §5.1.7 の `initDataList` の id 重複、§5.2.14 の initRef 参照切れを
 *   すべて再検証する
 *
 * 未定義変数は空文字になる (§5.4 は未定義変数の扱いを定めていない) ため、`initRef: "%missing%"`
 * は id が空文字のエントリが無ければ参照切れとして throw する。
 *
 * なお本関数を呼ばない経路 (購読側の `resolveInitData` の直呼びなど) は、wire 上の `%name%` を
 * 解決しないため保護されない。
 */
export function resolveCatalogVariables(
  catalog: Catalog,
  variables: Readonly<Record<string, string>>,
): Catalog {
  // 変数値の制約検証。変数名の文字集合は draft-02 で撤廃されたため検証しない。
  // 値の制約は注入対策として §5.4.1 が定めているため残す
  for (const [name, value] of Object.entries(variables)) {
    if (!VARIABLE_VALUE_PATTERN.test(value)) {
      throw new Error(
        `invalid variable value for '${name}': '${value}' contains disallowed characters per §5.4.1`,
      );
    }
  }

  // §13.5: 置換前に入力を検証する。型を迂回した値で TypeError にせず、plain Error を返す
  const input = validateCatalog(catalog);
  const result: Catalog = { ...input };
  // root level の未知フィールドにも %var% 置換を適用する（§5.4）。
  // result は spread 済みのため setOwnField に揃えても挙動は変わらない
  const catalogRecord = input as unknown as Record<string, unknown>;
  const resultRecord = result as unknown as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!KNOWN_CATALOG_ROOT_FIELDS.has(key)) {
      setOwnField(resultRecord, key, substituteUnknownValue(catalogRecord[key], variables, key));
    }
  }
  result.tracks = input.tracks.map((track) => substituteTrack(track, variables));
  if (input.publishTracks !== undefined) {
    result.publishTracks = input.publishTracks.map((track) => substituteTrack(track, variables));
  }
  if (input.initDataList !== undefined) {
    result.initDataList = input.initDataList.map((entry) =>
      substituteInitDataEntry(entry, variables),
    );
  }
  // §13.5: 置換後の値で catalog 全体を再検証する。条件付き MUST の条件 (role / codec /
  // mimeType) が変わり得るため、参照切れだけでなく全体を通す
  return validateCatalog(result);
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
  // depends は (string | number)[]。Number は renderGroup 参照であり置換の対象外
  if (track.depends !== undefined) {
    result.depends = track.depends.map((d, i) =>
      typeof d === "string" ? substituteString(d, variables, `tracks[].depends[${i}]`) : d,
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
  // connectionURI は publish track の接続先 URI。変数置換の対象に含める
  if (track.connectionURI !== undefined) {
    result.connectionURI = substituteString(
      track.connectionURI,
      variables,
      "tracks[].connectionURI",
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
  // type は Table 3 の列挙値であり変数参照を許さない (置換すると列挙外の値になり得る)
  return {
    id: substituteString(entry.id, variables, "initDataList[].id"),
    type: entry.type,
    data: substituteString(entry.data, variables, "initDataList[].data"),
  };
}
