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
 * トラックの役割 (draft-ietf-moq-msf-01 §5.2.6, Table 5)
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
 * 暗号化スイート (draft-ietf-moq-msf-01 §5.2.39, Table 7)
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
