/**
 * MSF の定数 (draft-ietf-moq-msf-02 §5.1.1 / §5.2.4 / §5.2.6 / §5.2.39)
 *
 * 参照: draft-ietf-moq-msf-02
 */

// =============================================================================
// 定数
// =============================================================================

/**
 * MSF バージョン文字列の型 (draft-ietf-moq-msf-02 §5.1.1)
 *
 * §5.1.1: A subscriber MUST NOT attempt to parse a catalog version which it
 * does not understand. For usage against IETF Internet-Draft releases, follow
 * the convention of specifying the version as "draft-XX".
 *
 * draft-01 との互換性は維持しない。draft-02 §5.1.1 の規約に従い、受理する値は
 * `"draft-02"` だけである。draft-01 の `"draft-01"` と、draft-01 の例が使っていた
 * `"1"` は受理しない。
 */
export type MsfVersion = "draft-02";

/** MSF バージョン (encode 時の値, draft-ietf-moq-msf-02 §5.1.1) */
export const MSF_VERSION: MsfVersion = "draft-02";

/**
 * decode 時に受理する MSF バージョン値の集合
 *
 * §5.1.1 「A subscriber MUST NOT attempt to parse a catalog version which it
 * does not understand」に従い、この集合に含まれない値は reject する。
 */
export const MSF_KNOWN_VERSIONS: ReadonlySet<MsfVersion> = new Set<MsfVersion>(["draft-02"]);

/** Catalog トラック名 (固定, draft-ietf-moq-msf-02 §5) */
export const CATALOG_TRACK_NAME = "catalog";

/**
 * パッケージング形式 (draft-ietf-moq-msf-02 §5.2.4, Table 5)
 *
 * draft-02 で `"catalog"` が追加された。catalog が別の catalog を参照することを表す。
 * 値の集合は `MSF_PACKAGING_VALUES` と一致させる。
 */
export type PackagingType =
  | "loc"
  | "mediatimeline"
  | "eventtimeline"
  | "moqlog"
  | "moqmetrics"
  | "catalog";

/**
 * 受理する packaging の値 (draft-02 §5.2.4 Table 5)
 *
 * §5.2.4: Allowed values are strings as defined in Table 5. 表に無い値は catalog の
 * packaging として受理しない。
 */
export const MSF_PACKAGING_VALUES: ReadonlySet<string> = new Set<string>([
  "loc",
  "mediatimeline",
  "eventtimeline",
  "moqlog",
  "moqmetrics",
  "catalog",
]);

/**
 * トラックの役割 (draft-ietf-moq-msf-02 §5.2.7, Table 5)
 *
 * Table 5 の reserved 値 (`video`, `audio`, `audiodescription`, `caption`,
 * `subtitle`, `signlanguage`, `mediatimeline`, `eventtimeline`, `log`,
 * `metrics`) は typo 検出のため定数 export で参照可能にしつつ、`Custom roles
 * MAY be used as long as they do not collide with the specified roles` を
 * 許容するため型自体は `string` とする。
 */
export type TrackRole = string;

/**
 * Table 5 で reserved として登録された role 値の集合。
 * カスタム role を許容するため、型は `TrackRole` (= string) のままにし、定数のみ提供する。
 */
export const RESERVED_TRACK_ROLES: ReadonlySet<string> = new Set([
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
]);

/**
 * 暗号化スイート (draft-ietf-moq-msf-02 §5.2.39, Table 7)
 *
 * `moq-secure-objects` scheme 配下で定義されている既知 3 値の他、custom
 * scheme は自由な文字列を取りうるため、型自体は `string` で保持する。既知値は
 * `KNOWN_CIPHER_SUITES` で参照する。
 */
export type CipherSuite = string;

/**
 * `moq-secure-objects` scheme 用に Table 7 で登録されている既知 cipher suite 集合。
 */
export const KNOWN_CIPHER_SUITES: ReadonlySet<string> = new Set([
  "aes-128-gcm-sha256",
  "aes-128-ctr-hmac-sha256-80",
  "aes-256-gcm-sha512",
]);

/**
 * LOC packaging の MOQT Stream へのマッピング (draft-02 §4.1.1 Table 1)
 *
 * - `group`: Group 内の全 Object を 1 つの Subgroup に Object ID 順で送る (既定)
 * - `object`: Object ごとに別の Subgroup に送る
 */
export type LocStreamMapping = "group" | "object";

/** LOC の `streamMapping` キーが未指定のときの既定値 (§4.1.1) */
export const DEFAULT_LOC_STREAM_MAPPING: LocStreamMapping = "group";

/**
 * `packagingMetadata` を `key=value` の並びとして解釈する (draft-02 §5.2.5)
 *
 * §5.2.5: Additional parameters ... encoded as a semicolon-separated list of key=value pairs
 * (e.g. key1=v1;key2=v2). Keys and values are case-sensitive and MUST NOT contain whitespace,
 * `=` or `;`. ... If the same key appears more than once, the first occurrence is used.
 *
 * 形式違反は `Error` にする。未定義の key は呼び出し側が無視する (§5.2.5)。
 *
 * @param metadata - `packagingMetadata` の値
 * @returns key から value への Map (最初の出現だけを持つ)
 * @throws Error 形式が不正なとき
 */
export function parsePackagingMetadata(metadata: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  if (metadata.length === 0) {
    return result;
  }
  for (const entry of metadata.split(";")) {
    const equalsIndex = entry.indexOf("=");
    if (equalsIndex === -1) {
      throw new Error(`invalid packagingMetadata: '${entry}' must be a key=value pair per §5.2.5`);
    }
    const key = entry.slice(0, equalsIndex);
    const value = entry.slice(equalsIndex + 1);
    // key / value は空白、`=`、`;` を含まない。`=` は key 側に現れない (最初の = で分割する)
    for (const [label, part] of [
      ["key", key],
      ["value", value],
    ] as const) {
      if (part.length === 0 || /[\s=;]/.test(part)) {
        throw new Error(
          `invalid packagingMetadata: ${label} of '${entry}' must be non-empty and must not contain whitespace, '=' or ';' per §5.2.5`,
        );
      }
    }
    if (!result.has(key)) {
      result.set(key, value);
    }
  }
  return result;
}

/**
 * track の LOC stream mapping を解決する (draft-02 §4.1.1 / §5.2.5)
 *
 * §4.1.1: If packagingMetadata is absent, or if it is present but does not carry a
 * streamMapping key, the mode group MUST be assumed.
 *
 * `loc` 以外の packaging では `streamMapping` を解釈しない (未定義の key は無視する)。
 * 値が `group` と `object` 以外なら Error にする。
 *
 * @param track - 対象の track
 * @returns 解決した stream mapping
 * @throws Error streamMapping の値が不正なとき
 */
export function resolveLocStreamMapping(track: {
  readonly packaging?: string;
  readonly packagingMetadata?: string;
}): LocStreamMapping {
  if (track.packaging !== "loc" || track.packagingMetadata === undefined) {
    return DEFAULT_LOC_STREAM_MAPPING;
  }
  const metadata = parsePackagingMetadata(track.packagingMetadata);
  const value = metadata.get("streamMapping");
  if (value === undefined) {
    return DEFAULT_LOC_STREAM_MAPPING;
  }
  if (value !== "group" && value !== "object") {
    throw new Error(`invalid streamMapping '${value}': must be 'group' or 'object' per §4.1.1`);
  }
  return value;
}
