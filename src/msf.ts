/**
 * MOQT Streaming Format (MSF) の型定義とシリアライズ関数
 *
 * MSF = LOC (メディアパッケージング) + Catalog (メタデータ) + Timeline (オプション)
 *
 * 参照: draft-ietf-moq-msf-01
 *
 * 本モジュールは draft-01 全面追従。MSF はアプリケーション層であり、MOQT トランスポート層 (session)
 * を閉じる責任を持たない。検証違反時の throw は plain `Error` で、呼び出し側 (subscriber 等) が
 * `try/catch` で吸収して UI 通知する。`ProtocolViolationError` は使わない。
 */

// =============================================================================
// 定数
// =============================================================================

/**
 * MSF バージョン文字列の型 (draft-ietf-moq-msf-01 §5.1.1)
 *
 * §5.1.1: A subscriber MUST NOT attempt to parse a catalog version which it
 * does not understand. For usage against IETF Internet-Draft releases, follow
 * the convention of specifying the version as "draft-XX".
 *
 * `"draft-01"` は Internet-Draft 段階の正規表記。`"1"` は §5.6 例 (non-normative)
 * で使用されている将来の RFC リリース版を想定した記述で、receive 側のみ受理する。
 * 出力 (encode) 時は常に `"draft-01"` を使用する。
 */
export type MsfVersion = "draft-01" | "1";

/** MSF バージョン (encode 時の値, draft-ietf-moq-msf-01 §5.1.1) */
export const MSF_VERSION: MsfVersion = "draft-01";

/**
 * decode 時に受理する MSF バージョン値の集合
 *
 * §5.1.1 「A subscriber MUST NOT attempt to parse a catalog version which it
 * does not understand」に従い、この集合に含まれない値は reject する。
 */
export const MSF_KNOWN_VERSIONS: ReadonlySet<MsfVersion> = new Set<MsfVersion>(["draft-01", "1"]);

/** Catalog トラック名 (固定, draft-ietf-moq-msf-01 §5) */
export const CATALOG_TRACK_NAME = "catalog";

/**
 * パッケージング形式 (draft-ietf-moq-msf-01 §5.2.4, Table 4)
 *
 * draft-00 の `"loc" | "mediatimeline" | "eventtimeline"` に
 * draft-01 で `"moqlog"`, `"moqmetrics"` が追加された。
 */
export type PackagingType = "loc" | "mediatimeline" | "eventtimeline" | "moqlog" | "moqmetrics";

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

// =============================================================================
// 補助型定義
// =============================================================================

/**
 * Buffers (draft-ietf-moq-msf-01 §5.2.9)
 *
 * `target` / `min` / `max` はいずれも optional。Unknown keys MUST be ignored。
 */
export interface Buffers {
  target?: number;
  min?: number;
  max?: number;
}

/**
 * Initialization Data List のエントリ (draft-ietf-moq-msf-01 §5.1.7)
 *
 * 現バージョンでは `type` は `"inline"` のみ定義されている (Table 2)。
 */
export interface InitDataEntry {
  /** catalog 内で一意な id (string) */
  id: string;
  /** 初期化データ形式 (現バージョンは `"inline"` のみ定義、将来追加に備えて string で受ける) */
  type: string;
  /** type に応じた payload (`inline` の場合は Base64 文字列) */
  data: string;
}

/**
 * Accessibility descriptor (draft-ietf-moq-msf-01 §5.2.44)
 *
 * 既知 scheme: `urn:scte:dash:cc:cea-608:2015`, `urn:scte:dash:cc:cea-708:2015` (Table 9)。
 */
export interface AccessibilityDescriptor {
  scheme: string;
  value: string;
}

/**
 * Authorization Info (draft-ietf-moq-msf-01 §5.2.42, Table 8)
 *
 * 既知 scheme: `privacy-pass`, `cat`。custom scheme は Reverse DNS。
 * 値は scheme-specific config object。
 */
export type AuthInfo = Record<string, unknown>;

/**
 * Media Timeline Template (draft-ietf-moq-msf-01 §5.2.15 / §7.4.1)
 *
 * 6 要素 JSON Array:
 * `[startMediaTime, deltaMediaTime, startLocation, deltaLocation, startWallclock, deltaWallclock]`
 *
 * §7.4.1: All six values are mandatory and MUST appear in the specified order.
 * §7.4.2: Publishers MUST NOT change the template values for a track after
 * the first Object has been published.
 *
 * 型では §7.4.2 を enforce できないため、publisher 側で「first Object publish 後の
 * template 変更を行わない」責務がある。`createCatalog` / `encodeCatalog` 利用者は
 * publish 開始後の template 書き換えを行ってはならない。
 *
 * Location 要素は MOQT GroupID/ObjectID 由来であり 64bit 整数値を表すため、
 * `Number.MAX_SAFE_INTEGER` を超える可能性がある。`bigint` で保持する。
 */
export type MediaTimelineTemplate = readonly [
  /** 1. startMediaTime (ms) */
  number,
  /** 2. deltaMediaTime (ms) */
  number,
  /** 3. startLocation [groupId, objectId] */
  readonly [bigint, bigint],
  /** 4. deltaLocation [groupIdDelta, objectIdDelta] */
  readonly [bigint, bigint],
  /** 5. startWallclock (Unix ms, VOD は 0 SHOULD) */
  number,
  /** 6. deltaWallclock (ms, VOD は 0 SHOULD) */
  number,
];

// =============================================================================
// Catalog 型定義
// =============================================================================

/**
 * Catalog トラック定義 (draft-ietf-moq-msf-01 §5.2)
 *
 * 各フィールドの section 番号は draft-01 Table 3 を参照。
 */
export interface CatalogTrack {
  /** トラック名 (必須, §5.2.3) */
  name: string;

  /** パッケージング形式 (必須, §5.2.4) */
  packaging: PackagingType;

  /**
   * ライブ配信かどうか (必須, §5.2.7)
   *
   * §5.2.7: A True value MUST never follow a False value.
   * 一度 false に遷移した track が再度 true に戻ることは禁止されている。型では enforce
   * できないため、publisher / subscriber 側の利用箇所で状態遷移を守る責務がある。
   */
  isLive: boolean;

  /** トラックの名前空間 (§5.2.2) */
  namespace?: string;

  /** Event Timeline タイプ (packaging=eventtimeline の場合に必須, §5.2.5) */
  eventType?: string;

  /** 目標遅延 (ms, §5.2.8、`buffers` と相互排他) */
  targetLatency?: number;

  /** Buffers (§5.2.9、`targetLatency` と相互排他) */
  buffers?: Buffers;

  /** トラックの役割 (§5.2.6) */
  role?: TrackRole;

  /** 人間が読めるラベル (§5.2.10) */
  label?: string;

  /** 同時レンダリンググループ (§5.2.11) */
  renderGroup?: number;

  /** 代替トラックグループ (ABR 用, §5.2.12) */
  altGroup?: number;

  /** Initialization Data List への参照 id (§5.2.13) */
  initRef?: string;

  /** 依存トラック名の配列 (§5.2.14) */
  depends?: string[];

  /** Media Timeline Template (§5.2.15 / §7.4) */
  template?: MediaTimelineTemplate;

  /** テンポラルレイヤー ID (§5.2.16) */
  temporalId?: number;

  /** スペーシャルレイヤー ID (§5.2.17) */
  spatialId?: number;

  /** コーデック (WebCodecs 形式, §5.2.18) */
  codec?: string;

  /** MIME タイプ (§5.2.19) */
  mimeType?: string;

  /** フレームレート (fps, §5.2.20) */
  framerate?: number;

  /** 1 秒あたりの時間単位数 (§5.2.21) */
  timescale?: number;

  /** 最大ビットレート (bps, §5.2.22) */
  bitrate?: number;

  /** 平均ビットレート (bps, §5.2.23) */
  avgBitrate?: number;

  /** 最大 GOP 長 (ms, §5.2.24) */
  maxGopDuration?: number;

  /** 最大 Group 長 (ms, §5.2.25) */
  maxGroupDuration?: number;

  /** 映像幅 (px, §5.2.26) */
  width?: number;

  /** 映像高さ (px, §5.2.27) */
  height?: number;

  /** オーディオサンプルレート (§5.2.28) */
  samplerate?: number;

  /** チャンネル構成 (§5.2.29) */
  channelConfig?: string;

  /** 表示幅 (px, §5.2.30) */
  displayWidth?: number;

  /** 表示高さ (px, §5.2.31) */
  displayHeight?: number;

  /** 言語タグ (RFC 5646, §5.2.32) */
  lang?: string;

  /** 親トラック名 (clone operation 内のみ MUST, §5.2.33) */
  parentName?: string;

  /** 親トラック名前空間 (clone operation 内のみ, §5.2.34) */
  parentNamespace?: string;

  /** トラック長 (ms, VOD 用, §5.2.35) */
  trackDuration?: number;

  /** 暗号化スキーム (§5.2.38) */
  encryptionScheme?: string;

  /** 暗号化スイート (§5.2.39、`encryptionScheme` 指定時 MUST) */
  cipherSuite?: CipherSuite;

  /** 鍵 ID (§5.2.40) */
  keyId?: string;

  /** トラックベース鍵 (Base64, §5.2.41) */
  trackBaseKey?: string;

  /** 認可情報 (§5.2.42) */
  authInfo?: AuthInfo;

  /** Accessibility descriptor 配列 (§5.2.44) */
  accessibility?: AccessibilityDescriptor[];
}

/**
 * Publish track (draft-ietf-moq-msf-01 §5.1.5)
 *
 * subscriber が逆方向に publish するための track 定義。通常 track と同じ構造に
 * `connectionUri` (§5.2.36) / `token` (§5.2.37) が optional で付与可能。
 */
export interface PublishTrack extends CatalogTrack {
  /** MOQT エンドポイント URI (§5.2.36) */
  connectionUri?: string;

  /** 認証トークン (§5.2.37) */
  token?: string;
}

/**
 * removeTracks operation で使用するトラック識別子
 * (draft-ietf-moq-msf-01 §5.1.6 "remove")
 *
 * Each track object MUST include a Track Name field,
 * MAY include a Track Namespace field and MUST NOT hold any other fields.
 */
export interface RemoveTrack {
  /** トラック名 (必須) */
  name: string;

  /** トラックの名前空間 */
  namespace?: string;
}

/**
 * フルカタログ (draft-ietf-moq-msf-01 §5.1)
 *
 * version と tracks が必須。delta update ではない independent catalog。
 */
export interface Catalog {
  /** MSF バージョン (必須, §5.1.1) */
  version: MsfVersion;

  /** トラック配列 (必須, §5.1.4) */
  tracks: CatalogTrack[];

  /** 生成時刻 (Unix ms, §5.1.2) */
  generatedAt?: number;

  /**
   * 配信完了フラグ (§5.1.3)
   *
   * §5.1.3: This field MUST NOT be included if it is FALSE. This field MUST NOT
   * be removed from a catalog once it has been added.
   * 上記制約により、encode 時 / decode 時の双方で `false` 値は禁止する (実装は `true` のみ受理)。
   */
  isComplete?: true;

  /** Publish tracks (§5.1.5) */
  publishTracks?: PublishTrack[];

  /** Initialization Data List (§5.1.7) */
  initDataList?: InitDataEntry[];
}

/**
 * 差分更新カタログの operation (draft-ietf-moq-msf-01 §5.1.6)
 *
 * 各 operation は `{op, tracks}` 形式。同一 `op` 値の複数出現が許可される
 * (配列順 = 宣言順)。
 */
export type CatalogDeltaOperation =
  | { type: "add"; tracks: CatalogTrack[] }
  | { type: "remove"; tracks: RemoveTrack[] }
  | { type: "clone"; tracks: CatalogTrack[] };

/**
 * 差分更新カタログ (draft-ietf-moq-msf-01 §5.1.6 / §5.3)
 *
 * §5.3: A delta update MUST include the Delta Update field with at least one
 * operation. It MUST NOT contain an instance of a Tracks field or an MSF
 * version field.
 *
 * wire format は `{"deltaUpdate": [{"op": "...", "tracks": [...]}, ...]}` の
 * array 形式。draft-00 の `deltaUpdate: true + addTracks/removeTracks/cloneTracks`
 * boolean 形式とは互換性が無い (破壊的変更)。
 */
export interface CatalogDelta {
  /**
   * Catalog message が delta であることを示す内部マーカー (true 固定)。
   *
   * decode 後の判別を容易にするための内部フラグ。wire format には出力しない
   * (出力されるのは `deltaUpdate` 配列のみ)。
   */
  deltaUpdate: true;

  /** 操作リスト (宣言順, §5.1.6) */
  operations: CatalogDeltaOperation[];

  /** 生成時刻 (Unix ms, §5.1.2) */
  generatedAt?: number;
}

/**
 * カタログメッセージ (フルカタログまたは差分更新)
 */
export type CatalogMessage = Catalog | CatalogDelta;

/**
 * Catalog 系の検証コンテキスト
 *
 * `validateCatalogTrack` の第二引数として渡し、検証ルールを source 別に切り替える。
 *
 * - `root`: full catalog の `tracks` 配列内エントリ
 * - `publishTracks`: full catalog の `publishTracks` 配列内エントリ
 * - `add`: delta update の `add` operation 内エントリ
 * - `remove`: delta update の `remove` operation 内エントリ
 * - `clone`: delta update の `clone` operation 内エントリ
 *
 * `catalogNamespace` は §5.2.2「If it is not declared within a track, then
 * each track MUST inherit the namespace of the catalog track」に従い、namespace
 * が未指定なエントリの正規化に使用する。
 */
export interface ValidationContext {
  source: "root" | "publishTracks" | "add" | "remove" | "clone";
  catalogNamespace?: string;
}

// =============================================================================
// Media Timeline 型定義
// =============================================================================

/**
 * Media Timeline エントリ (draft-ietf-moq-msf-01 §7.1)
 *
 * `[mediaPts, [groupId, objectId], wallclock]`
 */
export type MediaTimelineEntry = [
  /** メディア PTS (ms) */
  number,
  /** Location [groupId, objectId] */
  [bigint, bigint],
  /** 壁時計時間 (Unix ms) */
  number,
];

// =============================================================================
// Event Timeline 型定義
// =============================================================================

/**
 * Event Timeline エントリ (draft-ietf-moq-msf-01 §8.1)
 *
 * data は任意の JSON 値 (オブジェクト、配列、文字列、数値等)。
 * 型と構造は Catalog の eventType フィールドで定義される。
 */
export interface EventTimelineEntry {
  /** 壁時計時間 (Unix ms) */
  t?: number;

  /** Location [groupId, objectId] */
  l?: [bigint, bigint];

  /** メディア PTS (ms) */
  m?: number;

  /** イベントデータ (構造は eventType で定義) */
  data: unknown;
}

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

// =============================================================================
// Catalog 検証
// =============================================================================

/**
 * unknown 値を `Catalog` として検証して返す (draft-ietf-moq-msf-01 §5.1)
 *
 * §5: A parser MUST ignore fields it does not understand.
 * 未知フィールド (root level) は ignore する。
 *
 * MUST 違反のみ throw する。`Error` メッセージは CLAUDE.md「先頭小文字、末尾
 * ピリオドなし、期待値と実際値を含む」に従う。
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
function assertTrackNameUnique(
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
function validateRemoveTrack(value: unknown, opIndex: number, trackIndex: number): RemoveTrack {
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
const KNOWN_CATALOG_ROOT_FIELDS: ReadonlySet<string> = new Set([
  "version",
  "tracks",
  "generatedAt",
  "isComplete",
  "publishTracks",
  "initDataList",
]);

/**
 * CatalogTrack の既知フィールド名（§5.2）。未知フィールド保持時に除外するために使う。
 * name / packaging / isLive は呼び出し側で検証済み、parentName / parentNamespace は clone 経路。
 */
const KNOWN_TRACK_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "packaging",
  "isLive",
  "namespace",
  "role",
  "label",
  "eventType",
  "targetLatency",
  "buffers",
  "renderGroup",
  "altGroup",
  "initRef",
  "depends",
  "template",
  "temporalId",
  "spatialId",
  "codec",
  "mimeType",
  "framerate",
  "timescale",
  "bitrate",
  "avgBitrate",
  "maxGopDuration",
  "maxGroupDuration",
  "width",
  "height",
  "samplerate",
  "channelConfig",
  "displayWidth",
  "displayHeight",
  "lang",
  "parentName",
  "parentNamespace",
  "trackDuration",
  "encryptionScheme",
  "cipherSuite",
  "keyId",
  "trackBaseKey",
  "authInfo",
  "accessibility",
  "connectionUri",
  "token",
]);

/**
 * 既知フィールドを pick して `CatalogTrack` を組み立てる共通ロジック。
 *
 * `name`, `packaging`, `isLive` は呼び出し側で検証済み。残りの optional
 * フィールドの型・MUST/MUST NOT 制約をここで検証する。
 *
 * `options.skipPackagingRequiredFields` は clone operation 用。clone では
 * packaging が継承される (= undefined のことがある) ため、packaging に応じた
 * MUST 検証 (depends / eventType / mimeType="application/json") を skip する。
 */
function buildValidatedCatalogTrack(
  obj: Record<string, unknown>,
  name: string,
  packaging: PackagingType | undefined,
  isLive: boolean | undefined,
  options?: { skipPackagingRequiredFields?: boolean },
): CatalogTrack {
  const track: CatalogTrack = { name } as CatalogTrack;
  if (packaging !== undefined) track.packaging = packaging;
  if (isLive !== undefined) track.isLive = isLive;

  pickIdentityFields(obj, name, track);
  pickEventType(obj, name, packaging, track);
  pickLatencyAndBuffers(obj, name, track);
  pickGroupAndInitRef(obj, name, track);
  pickDependsAndTemplate(obj, name, track);
  pickNumericAndStringFields(obj, name, track);
  pickTrackDuration(obj, name, isLive, track);
  pickEncryptionFields(obj, name, track);
  pickAuthAndAccessibility(obj, name, track);
  pickPublishTrackFields(obj, name, track);

  if (!options?.skipPackagingRequiredFields && packaging !== undefined) {
    validatePackagingSpecificRules(track, packaging, name);
  }

  // §5 parser MUST ignore unknown fields → 検証はしないが保持する（§5.4 Variable Substitution 対象）
  const trackRecord = track as unknown as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!KNOWN_TRACK_FIELDS.has(key)) {
      trackRecord[key] = obj[key];
    }
  }

  return track;
}

/** namespace / role / label (§5.2.2 / §5.2.6 / §5.2.10) を pick する */
function pickIdentityFields(obj: Record<string, unknown>, name: string, track: CatalogTrack): void {
  if ("namespace" in obj) {
    const value = obj["namespace"];
    if (typeof value !== "string") {
      throw new Error(
        `invalid track '${name}': namespace must be a string per §5.2.2, got ${typeof value}`,
      );
    }
    track.namespace = value;
  }
  if ("role" in obj) {
    const value = obj["role"];
    if (typeof value !== "string") {
      throw new Error(
        `invalid track '${name}': role must be a string per §5.2.6, got ${typeof value}`,
      );
    }
    track.role = value;
  }
  if ("label" in obj) {
    const value = obj["label"];
    if (typeof value !== "string") {
      throw new Error(
        `invalid track '${name}': label must be a string per §5.2.10, got ${typeof value}`,
      );
    }
    track.label = value;
  }
}

/** eventType を pick する (§5.2.5) */
function pickEventType(
  obj: Record<string, unknown>,
  name: string,
  packaging: PackagingType | undefined,
  track: CatalogTrack,
): void {
  if (!("eventType" in obj)) return;
  const value = obj["eventType"];
  if (typeof value !== "string") {
    throw new Error(
      `invalid track '${name}': eventType must be a string per §5.2.5, got ${typeof value}`,
    );
  }
  if (packaging !== undefined && packaging !== "eventtimeline") {
    throw new Error(
      `invalid track '${name}': eventType must not be used unless packaging is 'eventtimeline' per §5.2.5, got packaging='${packaging}'`,
    );
  }
  track.eventType = value;
}

/** targetLatency / buffers の相互排他検証と pick (§5.2.8 / §5.2.9) */
function pickLatencyAndBuffers(
  obj: Record<string, unknown>,
  name: string,
  track: CatalogTrack,
): void {
  const hasTargetLatency = "targetLatency" in obj;
  const hasBuffers = "buffers" in obj;
  if (hasTargetLatency && hasBuffers) {
    throw new Error(
      `invalid track '${name}': targetLatency and buffers must not coexist per §5.2.8 / §5.2.9`,
    );
  }
  if (hasTargetLatency) {
    const value = obj["targetLatency"];
    if (typeof value !== "number") {
      throw new Error(
        `invalid track '${name}': targetLatency must be a number per §5.2.8, got ${typeof value}`,
      );
    }
    track.targetLatency = value;
  }
  if (hasBuffers) {
    track.buffers = validateBuffers(obj["buffers"], name);
  }
}

/** renderGroup / altGroup / initRef を pick する (§5.2.11 / §5.2.12 / §5.2.13) */
function pickGroupAndInitRef(
  obj: Record<string, unknown>,
  name: string,
  track: CatalogTrack,
): void {
  pickOptionalNumber(obj, "renderGroup", "§5.2.11", track, name);
  pickOptionalNumber(obj, "altGroup", "§5.2.12", track, name);
  pickOptionalString(obj, "initRef", "§5.2.13", track, name);
}

/** depends / template を pick する (§5.2.14 / §5.2.15) */
function pickDependsAndTemplate(
  obj: Record<string, unknown>,
  name: string,
  track: CatalogTrack,
): void {
  if ("depends" in obj) {
    const value = obj["depends"];
    if (!Array.isArray(value) || !value.every((v): v is string => typeof v === "string")) {
      throw new Error(`invalid track '${name}': depends must be an array of strings per §5.2.14`);
    }
    track.depends = value;
  }
  if ("template" in obj) {
    track.template = validateMediaTimelineTemplate(obj["template"], name);
  }
}

/** temporalId/spatialId/codec/mimeType/dimension 系の単純な pick (§5.2.16〜§5.2.32) */
function pickNumericAndStringFields(
  obj: Record<string, unknown>,
  name: string,
  track: CatalogTrack,
): void {
  pickOptionalNumber(obj, "temporalId", "§5.2.16", track, name);
  pickOptionalNumber(obj, "spatialId", "§5.2.17", track, name);
  pickOptionalString(obj, "codec", "§5.2.18", track, name);
  pickOptionalString(obj, "mimeType", "§5.2.19", track, name);
  pickOptionalNumber(obj, "framerate", "§5.2.20", track, name);
  pickOptionalNumber(obj, "timescale", "§5.2.21", track, name);
  pickOptionalNumber(obj, "bitrate", "§5.2.22", track, name);
  pickOptionalNumber(obj, "avgBitrate", "§5.2.23", track, name);
  pickOptionalNumber(obj, "maxGopDuration", "§5.2.24", track, name);
  pickOptionalNumber(obj, "maxGroupDuration", "§5.2.25", track, name);
  pickOptionalNumber(obj, "width", "§5.2.26", track, name);
  pickOptionalNumber(obj, "height", "§5.2.27", track, name);
  pickOptionalNumber(obj, "samplerate", "§5.2.28", track, name);
  pickOptionalString(obj, "channelConfig", "§5.2.29", track, name);
  pickOptionalNumber(obj, "displayWidth", "§5.2.30", track, name);
  pickOptionalNumber(obj, "displayHeight", "§5.2.31", track, name);
  pickOptionalString(obj, "lang", "§5.2.32", track, name);
}

/** trackDuration を pick する (§5.2.35、isLive=true 時 MUST NOT) */
function pickTrackDuration(
  obj: Record<string, unknown>,
  name: string,
  isLive: boolean | undefined,
  track: CatalogTrack,
): void {
  if (!("trackDuration" in obj)) return;
  const value = obj["trackDuration"];
  if (typeof value !== "number") {
    throw new Error(
      `invalid track '${name}': trackDuration must be a number per §5.2.35, got ${typeof value}`,
    );
  }
  if (isLive === true) {
    throw new Error(
      `invalid track '${name}': trackDuration must not be included when isLive is true per §5.2.35`,
    );
  }
  track.trackDuration = value;
}

/** 暗号化系フィールドを pick する (§5.2.38〜§5.2.41) */
function pickEncryptionFields(
  obj: Record<string, unknown>,
  name: string,
  track: CatalogTrack,
): void {
  pickOptionalString(obj, "encryptionScheme", "§5.2.38", track, name);
  pickOptionalString(obj, "cipherSuite", "§5.2.39", track, name);
  pickOptionalString(obj, "keyId", "§5.2.40", track, name);
  pickOptionalString(obj, "trackBaseKey", "§5.2.41", track, name);
  // §5.2.39: cipherSuite MUST be present when encryptionScheme is specified.
  if (track.encryptionScheme !== undefined && track.cipherSuite === undefined) {
    throw new Error(
      `invalid track '${name}': cipherSuite must be present when encryptionScheme is specified per §5.2.39`,
    );
  }
}

/** authInfo / accessibility を pick する (§5.2.42 / §5.2.44) */
function pickAuthAndAccessibility(
  obj: Record<string, unknown>,
  name: string,
  track: CatalogTrack,
): void {
  if ("authInfo" in obj) {
    const value = obj["authInfo"];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(
        `invalid track '${name}': authInfo must be an object per §5.2.42, got ${
          value === null ? "null" : Array.isArray(value) ? "array" : typeof value
        }`,
      );
    }
    track.authInfo = value as AuthInfo;
  }
  if ("accessibility" in obj) {
    track.accessibility = validateAccessibility(obj["accessibility"], name);
  }
}

/** publishTracks 専用 (connectionUri / token) を pick する (§5.2.36 / §5.2.37) */
function pickPublishTrackFields(
  obj: Record<string, unknown>,
  name: string,
  track: CatalogTrack,
): void {
  if ("connectionUri" in obj) {
    const value = obj["connectionUri"];
    if (typeof value !== "string") {
      throw new Error(
        `invalid track '${name}': connectionUri must be a string per §5.2.36, got ${typeof value}`,
      );
    }
    (track as PublishTrack).connectionUri = value;
  }
  if ("token" in obj) {
    const value = obj["token"];
    if (typeof value !== "string") {
      throw new Error(
        `invalid track '${name}': token must be a string per §5.2.37, got ${typeof value}`,
      );
    }
    (track as PublishTrack).token = value;
  }
}

/**
 * packaging に応じた MUST 検証
 * (§5.2.5 / §7.2 / §8.2)
 */
function validatePackagingSpecificRules(
  track: CatalogTrack,
  packaging: PackagingType,
  name: string,
): void {
  if (packaging === "mediatimeline") {
    // §7.2: depends MUST present, mimeType MUST = "application/json"
    if (track.depends === undefined) {
      throw new Error(`invalid track '${name}': mediatimeline track must include depends per §7.2`);
    }
    if (track.mimeType !== "application/json") {
      throw new Error(
        `invalid track '${name}': mediatimeline track must have mimeType='application/json' per §7.2, got '${
          track.mimeType ?? "(absent)"
        }'`,
      );
    }
  } else if (packaging === "eventtimeline") {
    // §5.2.5 / §8.2: eventType MUST, depends MUST, mimeType MUST = "application/json"
    if (track.eventType === undefined) {
      throw new Error(
        `invalid track '${name}': eventtimeline track must include eventType per §5.2.5 / §8.2`,
      );
    }
    if (track.depends === undefined) {
      throw new Error(`invalid track '${name}': eventtimeline track must include depends per §8.2`);
    }
    if (track.mimeType !== "application/json") {
      throw new Error(
        `invalid track '${name}': eventtimeline track must have mimeType='application/json' per §8.2, got '${
          track.mimeType ?? "(absent)"
        }'`,
      );
    }
  } else if (packaging === "moqlog") {
    // §9.4: packaging="moqlog" の Log track は role="log" が MUST
    if (track.role !== "log") {
      throw new Error(
        `invalid track '${name}': moqlog track must have role='log' per §9.4, got '${
          track.role ?? "(absent)"
        }'`,
      );
    }
  } else if (packaging === "moqmetrics") {
    // §10.4: packaging="moqmetrics" の Metrics track は role="metrics" が MUST
    if (track.role !== "metrics") {
      throw new Error(
        `invalid track '${name}': moqmetrics track must have role='metrics' per §10.4, got '${
          track.role ?? "(absent)"
        }'`,
      );
    }
  }

  // packaging に対する MUST NOT 検証。
  // §5.2.5: eventType MUST NOT be used unless packaging is 'eventtimeline'.
  // validateCatalogTrack 側でも検証しているが、clone 後の合成 track (base から eventType を継承し
  // packaging のみ override したケース) は validateCloneCatalogTrack で MUST 系をすべて skip して
  // いるため、applyCatalogDelta 後段からも本関数が呼ばれる経路で検出する必要がある。
  if (packaging !== "eventtimeline" && track.eventType !== undefined) {
    throw new Error(
      `invalid track '${name}': eventType must not be used unless packaging is 'eventtimeline' per §5.2.5, got packaging='${packaging}'`,
    );
  }
}

function pickOptionalNumber(
  obj: Record<string, unknown>,
  key: string,
  section: string,
  track: CatalogTrack,
  trackName: string,
): void {
  if (!(key in obj)) return;
  const value = obj[key];
  if (typeof value !== "number") {
    throw new Error(
      `invalid track '${trackName}': ${key} must be a number per ${section}, got ${typeof value}`,
    );
  }
  (track as unknown as Record<string, unknown>)[key] = value;
}

function pickOptionalString(
  obj: Record<string, unknown>,
  key: string,
  section: string,
  track: CatalogTrack,
  trackName: string,
): void {
  if (!(key in obj)) return;
  const value = obj[key];
  if (typeof value !== "string") {
    throw new Error(
      `invalid track '${trackName}': ${key} must be a string per ${section}, got ${typeof value}`,
    );
  }
  (track as unknown as Record<string, unknown>)[key] = value;
}

function validateBuffers(value: unknown, trackName: string): Buffers {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `invalid track '${trackName}': buffers must be an object per §5.2.9, got ${
        value === null ? "null" : Array.isArray(value) ? "array" : typeof value
      }`,
    );
  }
  const obj = value as Record<string, unknown>;
  const buffers: Buffers = {};
  for (const key of ["target", "min", "max"] as const) {
    if (key in obj) {
      const v = obj[key];
      if (typeof v !== "number") {
        throw new Error(
          `invalid track '${trackName}': buffers.${key} must be a number per §5.2.9, got ${typeof v}`,
        );
      }
      buffers[key] = v;
    }
  }
  // §5.2.9: Unknown keys in the target buffer object MUST be ignored → 未知キーは無視
  return buffers;
}

function validateAccessibility(value: unknown, trackName: string): AccessibilityDescriptor[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `invalid track '${trackName}': accessibility must be an array per §5.2.44, got ${typeof value}`,
    );
  }
  return value.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(
        `invalid track '${trackName}': accessibility[${i}] must be an object per §5.2.44, got ${
          entry === null ? "null" : typeof entry
        }`,
      );
    }
    const obj = entry as Record<string, unknown>;
    const scheme = obj["scheme"];
    const v = obj["value"];
    if (typeof scheme !== "string") {
      throw new Error(
        `invalid track '${trackName}': accessibility[${i}].scheme must be a string per §5.2.44, got ${typeof scheme}`,
      );
    }
    if (typeof v !== "string") {
      throw new Error(
        `invalid track '${trackName}': accessibility[${i}].value must be a string per §5.2.44, got ${typeof v}`,
      );
    }
    return { scheme, value: v };
  });
}

/**
 * MediaTimelineTemplate を検証する (draft-ietf-moq-msf-01 §5.2.15 / §7.4.1)
 *
 * §7.4.1: 6 要素 JSON Array、各要素の型と順序は固定。
 * Location 要素は 2 要素 number 配列、bigint 変換時に precision loss を検出する。
 */
function validateMediaTimelineTemplate(value: unknown, trackName: string): MediaTimelineTemplate {
  if (!Array.isArray(value) || value.length !== 6) {
    throw new Error(
      `invalid track '${trackName}': template must be a 6-element array per §7.4.1, got ${
        Array.isArray(value) ? `array of length ${value.length}` : typeof value
      }`,
    );
  }

  const startMediaTime = assertTemplateNumber(value[0], trackName, "startMediaTime");
  const deltaMediaTime = assertTemplateNumber(value[1], trackName, "deltaMediaTime");
  const startLocation = assertTemplateLocation(value[2], trackName, "startLocation");
  const deltaLocation = assertTemplateLocation(value[3], trackName, "deltaLocation");
  const startWallclock = assertTemplateNumber(value[4], trackName, "startWallclock");
  const deltaWallclock = assertTemplateNumber(value[5], trackName, "deltaWallclock");

  return [
    startMediaTime,
    deltaMediaTime,
    startLocation,
    deltaLocation,
    startWallclock,
    deltaWallclock,
  ] as const;
}

function assertTemplateNumber(value: unknown, trackName: string, field: string): number {
  if (typeof value !== "number") {
    throw new Error(
      `invalid track '${trackName}': template ${field} must be a number per §7.4.1, got ${typeof value}`,
    );
  }
  return value;
}

function assertTemplateLocation(
  value: unknown,
  trackName: string,
  field: string,
): readonly [bigint, bigint] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(
      `invalid track '${trackName}': template ${field} must be a 2-element array per §7.4.1, got ${
        Array.isArray(value) ? `array of length ${value.length}` : typeof value
      }`,
    );
  }
  const groupId = toTemplateLocationBigInt(value[0], trackName, `${field}[0]`);
  const objectId = toTemplateLocationBigInt(value[1], trackName, `${field}[1]`);
  return [groupId, objectId] as const;
}

function toTemplateLocationBigInt(value: unknown, trackName: string, field: string): bigint {
  return toMsfLocationBigInt(value, `template ${field}`, `track '${trackName}'`);
}

/**
 * MOQT Location 由来の JSON number を bigint に変換する共通 helper。
 *
 * draft-ietf-moq-transport-20 §1.4 で Group ID / Object ID は vi64 (unsigned 64bit) と
 * 規定される。JSON wire format で値を載せる場合、`Number.MAX_SAFE_INTEGER` を超える領域は
 * `JSON.parse` の段階で既に丸められているため、安全側に倒して reject する。負数も unsigned
 * 値域違反として reject する。
 *
 * - 非 number → reject
 * - 非整数 → reject
 * - 負数 → reject (MOQT Location は unsigned)
 * - safe integer 範囲外 → precision loss として reject
 */
function toMsfLocationBigInt(value: unknown, label: string, context: string): bigint {
  if (typeof value !== "number") {
    throw new Error(
      `invalid ${context}: ${label} must be a number per §7.4.1, got ${typeof value}`,
    );
  }
  if (!Number.isInteger(value)) {
    throw new Error(`invalid ${context}: ${label} must be an integer per §7.4.1, got ${value}`);
  }
  if (value < 0) {
    throw new Error(
      `invalid ${context}: ${label} must be non-negative (MOQT Location is unsigned), got ${value}`,
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `invalid ${context}: ${label} precision loss converting ${value} to bigint (outside safe integer range)`,
    );
  }
  return BigInt(value);
}

// =============================================================================
// Catalog 差分更新の適用
// =============================================================================

/**
 * 差分更新を適用して新しい Catalog を作成する
 * (draft-ietf-moq-msf-01 §5.1.6 / §5.3)
 *
 * §5.3: 操作は配列順に逐次適用する。
 * 親 / 削除対象探索キーは `(name, namespace ?? options.catalogNamespace)`
 * のタプル正規化を行う (§5.2.2「If it is not declared within a track, then
 * each track MUST inherit the namespace of the catalog track」)。
 *
 * `options.catalogNamespace` 自体が省略された場合は、両方の namespace が共に
 * 未指定の場合のみ一致とする (従来挙動と互換)。
 *
 * §5.1.3: isComplete は一度設定したら削除禁止 (MUST NOT) のため引き継ぐ。
 */
export function applyCatalogDelta(
  current: Catalog,
  delta: CatalogDelta,
  options?: { catalogNamespace?: string },
): Catalog {
  const catalogNamespace = options?.catalogNamespace;
  let tracks = [...current.tracks];

  // §5.1.3: isComplete=true は「これ以降 track 追加・更新・新コンテンツ発行を行わない」コミットメント。
  // 確定後の catalog に add/clone operation を含む delta を適用するのは MUST 違反。remove のみ許容する。
  if (current.isComplete === true) {
    for (const operation of delta.operations) {
      if (operation.type === "add" || operation.type === "clone") {
        throw new Error(
          `invalid catalog delta: cannot ${operation.type} tracks after isComplete=true per §5.1.3`,
        );
      }
    }
  }

  for (const operation of delta.operations) {
    if (operation.type === "remove") {
      for (const removeTrack of operation.tracks) {
        const targetNs = normalizeNamespace(removeTrack.namespace, catalogNamespace);
        tracks = tracks.filter((track) => {
          if (track.name !== removeTrack.name) {
            return true;
          }
          const trackNs = normalizeNamespace(track.namespace, catalogNamespace);
          return !namespaceMatches(trackNs, targetNs);
        });
      }
    } else if (operation.type === "add") {
      tracks = [...tracks, ...operation.tracks];
    } else if (operation.type === "clone") {
      for (const cloneTrack of operation.tracks) {
        if (!cloneTrack.parentName) {
          throw new Error(
            `invalid catalog delta: clone track missing parentName per §5.1.6 / §5.2.33`,
          );
        }
        const parentNs = normalizeNamespace(cloneTrack.parentNamespace, catalogNamespace);
        const baseTrack = tracks.find((t) => {
          if (t.name !== cloneTrack.parentName) return false;
          const trackNs = normalizeNamespace(t.namespace, catalogNamespace);
          return namespaceMatches(trackNs, parentNs);
        });
        if (!baseTrack) {
          throw new Error(
            `invalid catalog delta: clone track parent not found, parentName='${cloneTrack.parentName}'`,
          );
        }
        // ベーストラックをコピーして cloneTrack のプロパティで上書き。
        // parentName / parentNamespace はクローン後トラックには含めない。
        const { parentName: _pn, parentNamespace: _pns, ...cloneProps } = cloneTrack;
        const cloned: CatalogTrack = { ...baseTrack, ...cloneProps };
        // §5.1.6 "clone": The cloned track inherits all attributes from the parent except
        // the Track Name which MUST be new. parent と同じ (name, namespace) は新規でないので reject。
        const clonedNs = normalizeNamespace(cloned.namespace, catalogNamespace);
        const baseNs = normalizeNamespace(baseTrack.namespace, catalogNamespace);
        if (cloned.name === baseTrack.name && namespaceMatches(clonedNs, baseNs)) {
          throw new Error(
            `invalid catalog delta: clone track name '${cloned.name}' must differ from parent name per §5.1.6`,
          );
        }
        // §5.2.8 / §5.2.9: targetLatency と buffers の併存禁止。
        // clone で base から継承した一方を override せず他方を追加すると併存する。
        if (cloned.targetLatency !== undefined && cloned.buffers !== undefined) {
          throw new Error(
            `invalid catalog delta: cloned track '${cloned.name}' has both targetLatency and buffers per §5.2.8 / §5.2.9`,
          );
        }
        // §7.2 / §8.2: packaging 別の MUST 検証も clone 結果に対して再実行する。
        // 「base.packaging を継承 + 必須フィールドも継承」「clone で packaging を override + 必須を新規」
        // のどちらでも結果は MUST を満たす必要がある。validateCloneCatalogTrack は merge 前に
        // skipPackagingRequiredFields=true で skip しているため、ここで合成後を検証する。
        if (cloned.packaging !== undefined) {
          validatePackagingSpecificRules(cloned, cloned.packaging, cloned.name);
        }
        tracks.push(cloned);
      }
    }
  }

  // §5.2.3: 全 operation 適用後の tracks 配列で (name, namespace) uniqueness を再検証する。
  assertTrackNameUnique(tracks, "tracks");

  // §5.3 / §5.1.1: delta update に version は含まれない (MUST NOT)。current.version をそのまま維持する。
  const result: Catalog = {
    version: current.version,
    tracks,
  };
  const mergedGeneratedAt = delta.generatedAt ?? current.generatedAt;
  if (mergedGeneratedAt !== undefined) {
    result.generatedAt = mergedGeneratedAt;
  }

  if (current.isComplete === true) {
    result.isComplete = true;
  }
  if (current.publishTracks !== undefined) {
    result.publishTracks = current.publishTracks;
  }
  if (current.initDataList !== undefined) {
    result.initDataList = current.initDataList;
  }

  // root level の未知フィールドをベース catalog から引き継ぐ（§5 保持解釈）
  const currentRecord = current as unknown as Record<string, unknown>;
  const resultRecord = result as unknown as Record<string, unknown>;
  for (const key of Object.keys(current)) {
    if (!KNOWN_CATALOG_ROOT_FIELDS.has(key)) {
      resultRecord[key] = currentRecord[key];
    }
  }

  return result;
}

/**
 * `(track.namespace, catalogNamespace)` を解決し、比較用の正規化値を返す。
 *
 * - `track.namespace` が明示指定されていれば、その値を使う。
 * - `track.namespace` が未指定で `catalogNamespace` が指定されていれば、後者を使う。
 * - 両方未指定なら `undefined`。
 */
function normalizeNamespace(
  trackNamespace: string | undefined,
  catalogNamespace: string | undefined,
): string | undefined {
  if (trackNamespace !== undefined) return trackNamespace;
  if (catalogNamespace !== undefined) return catalogNamespace;
  return undefined;
}

function namespaceMatches(a: string | undefined, b: string | undefined): boolean {
  return a === b;
}

// =============================================================================
// Media Timeline encode/decode
// =============================================================================

/**
 * bigint Location 値が JSON 安全範囲内に収まることを確認し、収まらなければ throw する。
 *
 * MOQT Location は vi64 (unsigned 64bit) で `Number.MAX_SAFE_INTEGER` を超える可能性が
 * あるが、JSON wire 上は number として表現されるため超えると precision loss が発生する。
 * encode 時点で検出することで「自分の出力を自分で decode できない」状態を防ぐ。
 */
function assertJsonSafeBigInt(value: bigint, label: string, context: string): void {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (value < 0n) {
    throw new Error(
      `invalid ${context}: ${label} must be non-negative (MOQT Location is unsigned), got ${value}`,
    );
  }
  if (value > max) {
    throw new Error(
      `invalid ${context}: ${label} exceeds JSON safe integer range (max ${max}), got ${value}`,
    );
  }
}

/**
 * Media Timeline を JSON バイト列にエンコードする (draft-ietf-moq-msf-01 §7.1)
 *
 * bigint は JSON.stringify で扱えないため number に変換する。precision loss となる値は
 * 検出して reject する (自分の出力を自分で decode できないペアを生まない)。
 * gzip 圧縮は draft-01 §12.1 の MSF_COMPRESSION 経由で別 issue 対応のため、
 * 本関数は無圧縮 JSON のみ出力する。
 */
export async function encodeMediaTimeline(entries: MediaTimelineEntry[]): Promise<Uint8Array> {
  const serializable = entries.map(([mediaPts, [groupId, objectId], wallclock], index) => {
    assertJsonSafeBigInt(groupId, `location[0]`, `media timeline entry at index ${index}`);
    assertJsonSafeBigInt(objectId, `location[1]`, `media timeline entry at index ${index}`);
    return [mediaPts, [Number(groupId), Number(objectId)], wallclock];
  });

  const json = JSON.stringify(serializable);
  return new TextEncoder().encode(json);
}

/**
 * JSON バイト列を Media Timeline にデコードする (draft-ietf-moq-msf-01 §7.1)
 *
 * gzip 自動検出は draft-01 §12.1 で MSF_COMPRESSION 経由に統一される予定のため
 * 撤廃 (#0316)。入力は無圧縮 JSON のみ受理する。Location は MOQT GroupID / ObjectID
 * 由来の unsigned 整数で、JSON 安全範囲外の値は precision loss として reject する。
 */
export async function decodeMediaTimeline(data: Uint8Array): Promise<MediaTimelineEntry[]> {
  const json = new TextDecoder().decode(data);
  const parsed = JSON.parse(json) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error("invalid media timeline format: expected array");
  }

  return parsed.map((entry, index) => {
    if (!isMediaTimelineEntry(entry)) {
      throw new Error(`invalid media timeline entry at index ${index}`);
    }

    const [mediaPts, [groupId, objectId], wallclock] = entry as [number, [number, number], number];
    const context = `media timeline entry at index ${index}`;
    return [
      mediaPts,
      [
        toMsfLocationBigInt(groupId, "location[0]", context),
        toMsfLocationBigInt(objectId, "location[1]", context),
      ],
      wallclock,
    ] as MediaTimelineEntry;
  });
}

function isMediaTimelineEntry(entry: unknown): boolean {
  if (!Array.isArray(entry) || entry.length !== 3) {
    return false;
  }

  const [mediaPts, location, wallclock] = entry;

  if (typeof mediaPts !== "number") {
    return false;
  }

  if (!Array.isArray(location) || location.length !== 2) {
    return false;
  }

  if (typeof location[0] !== "number" || typeof location[1] !== "number") {
    return false;
  }

  if (typeof wallclock !== "number") {
    return false;
  }

  return true;
}

// =============================================================================
// Event Timeline encode/decode
// =============================================================================

/**
 * Event Timeline を JSON バイト列にエンコードする (draft-ietf-moq-msf-01 §8.1)
 *
 * gzip 圧縮は MSF_COMPRESSION (§12.1) 経由で別 issue 対応のため、本関数は
 * 無圧縮 JSON のみ出力する。
 */
export async function encodeEventTimeline(entries: EventTimelineEntry[]): Promise<Uint8Array> {
  const serializable = entries.map((entry, index) => {
    const result: Record<string, unknown> = { data: entry.data };

    if (entry.t !== undefined) {
      result["t"] = entry.t;
    }
    if (entry.l !== undefined) {
      // Location は MOQT GroupID / ObjectID 由来 unsigned 整数。precision loss は encode 時に reject。
      assertJsonSafeBigInt(entry.l[0], "location[0]", `event timeline entry at index ${index}`);
      assertJsonSafeBigInt(entry.l[1], "location[1]", `event timeline entry at index ${index}`);
      result["l"] = [Number(entry.l[0]), Number(entry.l[1])];
    }
    if (entry.m !== undefined) {
      result["m"] = entry.m;
    }

    return result;
  });

  const json = JSON.stringify(serializable);
  return new TextEncoder().encode(json);
}

/**
 * JSON バイト列を Event Timeline にデコードする (draft-ietf-moq-msf-01 §8.1)
 *
 * gzip 自動検出は撤廃 (#0316、MSF_COMPRESSION 経由に統一予定)。
 */
export async function decodeEventTimeline(data: Uint8Array): Promise<EventTimelineEntry[]> {
  const json = new TextDecoder().decode(data);
  const parsed = JSON.parse(json) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error("invalid event timeline format: expected array");
  }

  return parsed.map((entry, index) => {
    if (!isEventTimelineEntry(entry)) {
      throw new Error(`invalid event timeline entry at index ${index}`);
    }

    const obj = entry as Record<string, unknown>;
    const result: EventTimelineEntry = {
      data: obj["data"],
    };

    const t = obj["t"];
    if (typeof t === "number") {
      result.t = t;
    }

    const l = obj["l"];
    if (Array.isArray(l) && l.length === 2) {
      // §8.1: Location は MOQT GroupID / ObjectID 由来。precision loss / 非整数 / 負数を reject。
      const context = `event timeline entry at index ${index}`;
      result.l = [
        toMsfLocationBigInt(l[0], "location[0]", context),
        toMsfLocationBigInt(l[1], "location[1]", context),
      ];
    }

    const m = obj["m"];
    if (typeof m === "number") {
      result.m = m;
    }

    return result;
  });
}

/**
 * オブジェクトが Event Timeline エントリかどうかを検証する (draft-ietf-moq-msf-01 §8.1)
 *
 * data は必須 (任意の JSON 値)。
 * t (壁時計), l (Location), m (メディア PTS) はインデックス参照で、ちょうど 1 つのみ MUST。
 */
function isEventTimelineEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }

  const obj = entry as Record<string, unknown>;

  if (!("data" in obj) || obj["data"] === undefined) {
    return false;
  }

  const t = obj["t"];
  if (t !== undefined && typeof t !== "number") {
    return false;
  }

  const l = obj["l"];
  if (l !== undefined) {
    if (!Array.isArray(l) || l.length !== 2) {
      return false;
    }
    if (typeof l[0] !== "number" || typeof l[1] !== "number") {
      return false;
    }
  }

  const m = obj["m"];
  if (m !== undefined && typeof m !== "number") {
    return false;
  }

  const indexCount =
    (t !== undefined ? 1 : 0) + (l !== undefined ? 1 : 0) + (m !== undefined ? 1 : 0);
  if (indexCount !== 1) {
    return false;
  }

  return true;
}

// =============================================================================
// Variable Substitution (draft-ietf-moq-msf-01 §5.4)
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
  // root level の未知フィールドにも %var% 置換を適用する（§5.4）
  const catalogRecord = catalog as unknown as Record<string, unknown>;
  const resultRecord = result as unknown as Record<string, unknown>;
  for (const key of Object.keys(catalog)) {
    if (!KNOWN_CATALOG_ROOT_FIELDS.has(key)) {
      resultRecord[key] = substituteUnknownValue(catalogRecord[key], variables, key);
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
  return result;
}

function substituteString(
  value: string,
  variables: Readonly<Record<string, string>>,
  fieldPath: string,
): string {
  const replaced = value.replace(VARIABLE_REFERENCE_PATTERN, (_match, name: string) => {
    return Object.hasOwn(variables, name) ? variables[name] : "";
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
      (result as unknown as Record<string, unknown>)[key] = substituteString(
        value,
        variables,
        `tracks[].${key}`,
      );
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
        replaced[k] = substituteString(v, variables, `tracks[].authInfo.${k}`);
      } else {
        replaced[k] = v;
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
  for (const key of Object.keys(track)) {
    if (!KNOWN_TRACK_FIELDS.has(key)) {
      (result as unknown as Record<string, unknown>)[key] = substituteUnknownValue(
        (track as unknown as Record<string, unknown>)[key],
        variables,
        `tracks[].${key}`,
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
      replaced[k] = substituteUnknownValue(v, variables, `${fieldPath}.${k}`);
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

// =============================================================================
// MSF URI fragment 解析 (draft-ietf-moq-msf-01 §11.1)
// =============================================================================

/**
 * MSF URI fragment value (`msf:` の後) のパース結果
 * (draft-ietf-moq-msf-01 §11.1)
 */
export interface MsfFragmentValue {
  /** 名前空間 tuple (`-` 単一ハイフン区切り、`--` の左側) */
  trackNamespace: string[];
  /** トラック名 (`--` の右側) */
  trackName: string;
  /**
   * key-value parameter 列 (順序保持)
   *
   * §11.1.1: 同一 key の複数出現が許可される (`MUST process the union of those ranges`)。
   */
  parameters: ReadonlyArray<readonly [string, string]>;
}

/**
 * MSF URI fragment value をパースする (draft-ietf-moq-msf-01 §11.1)
 *
 * 入力: `msf:` を除去した後の値 (例: `customer-livestream-123--catalog&connection=q`)。
 *
 * - `&` で parameter 列を分離 (track-identifier 内に `&` は MUST NOT)
 * - `--` で namespace tuple / track name を分離
 * - 名前空間 tuple は `-` で要素分解
 * - 各 byte の percent-encoding は `.HH` (lowercase 2 hex digits)
 * - literal 文字は `[A-Za-z0-9_]` のみ (§11.1.2)
 */
export function parseMsfFragmentValue(value: string): MsfFragmentValue {
  if (value.length === 0) {
    throw new Error("invalid msf fragment value: empty");
  }
  // `?` は track-identifier 内 MUST NOT (出現時 `%3F` percent-encode)
  if (value.includes("?")) {
    throw new Error("invalid msf fragment value: '?' must be percent-encoded as %3F per §11.1");
  }

  // `&` で track-identifier と parameter list を分離
  const segments = value.split("&");
  const trackIdentifier = segments[0];
  const parameterSegments = segments.slice(1);

  if (trackIdentifier.length === 0) {
    throw new Error("invalid msf fragment value: track identifier is empty");
  }

  // `--` で namespace / track name を分離
  const doubleHyphenIndex = trackIdentifier.indexOf("--");
  if (doubleHyphenIndex === -1) {
    throw new Error(
      "invalid msf fragment value: missing '--' delimiter between namespace and track name per §11.1.2",
    );
  }
  const namespacePart = trackIdentifier.slice(0, doubleHyphenIndex);
  const trackNamePart = trackIdentifier.slice(doubleHyphenIndex + 2);

  if (trackNamePart.length === 0) {
    throw new Error("invalid msf fragment value: track name is empty per §11.1.2");
  }

  // namespace tuple を `-` で分解。namespace 部が空でも tuple は空配列で許容する
  // (catalog track はトップレベル namespace 無しでも parseable)。
  const trackNamespace =
    namespacePart.length === 0
      ? []
      : namespacePart.split("-").map((s) => decodeMsfSegment(s, "namespace"));
  const trackName = decodeMsfSegment(trackNamePart, "track name");

  // parameters の `key=value` 列を順序保持でパース
  const parameters: Array<readonly [string, string]> = [];
  for (const seg of parameterSegments) {
    const eqIndex = seg.indexOf("=");
    if (eqIndex === -1) {
      throw new Error(
        `invalid msf fragment value: parameter '${seg}' must be in key=value format per §11.1`,
      );
    }
    const key = seg.slice(0, eqIndex);
    const v = seg.slice(eqIndex + 1);
    if (key.length === 0) {
      throw new Error("invalid msf fragment value: parameter key is empty per §11.1");
    }
    parameters.push([key, v] as const);
  }

  return { trackNamespace, trackName, parameters };
}

/**
 * MSF namespace-name 文字列の 1 セグメントを decode する。
 *
 * - 大文字 hex (`.HH` の H が大文字) は受信 MUST 拒否 (§11.1.2)
 * - literal 文字集合は `[A-Za-z0-9_]` のみ (§11.1.2)
 *   それ以外 (`-` / `.` / `~` や 非 ASCII byte 等) は literal として禁止、
 *   `.HH` percent-encoded sequence でのみ表現可能。
 * - 既知 `.HH` は percent-decode する。連続する `.HH` byte は UTF-8 シーケンス
 *   として一旦バッファし、最後に TextDecoder で UTF-8 文字列化する (§11.1.2:
 *   「All other byte values ... MUST be percent-encoded」は byte values への
 *   制約であり、復元側はバイト列を UTF-8 として解釈する責務がある)。
 */
function decodeMsfSegment(segment: string, role: "namespace" | "track name"): string {
  // バイト列ベースで decode する: literal ASCII は code point < 128 で 1 byte、
  // `.HH` percent-encoded は対応する byte 値 を Uint8Array に積み、最後にまとめて UTF-8 化する。
  const bytes: number[] = [];
  let i = 0;
  while (i < segment.length) {
    const ch = segment[i];
    if (ch === ".") {
      // .HH percent-encoding
      if (i + 2 >= segment.length) {
        throw new Error(
          `invalid msf fragment value: incomplete percent-encoded sequence in ${role} per §11.1.2`,
        );
      }
      const hex = segment.slice(i + 1, i + 3);
      if (!/^[0-9a-f]{2}$/.test(hex)) {
        throw new Error(
          `invalid msf fragment value: percent-encoding must use lowercase hex digits in ${role} per §11.1.2, got '.${hex}'`,
        );
      }
      bytes.push(Number.parseInt(hex, 16));
      i += 3;
    } else if (/[A-Za-z0-9_]/.test(ch)) {
      bytes.push(ch.charCodeAt(0));
      i += 1;
    } else {
      throw new Error(
        `invalid msf fragment value: unreserved character set in ${role} is [A-Za-z0-9_] per §11.1.2, got '${ch}'`,
      );
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    throw new Error(
      `invalid msf fragment value: percent-encoded bytes in ${role} are not valid UTF-8 per §11.1.2`,
    );
  }
}

/**
 * `connection` パラメータの値を取得する (draft-ietf-moq-msf-01 §11.1.1)
 *
 * 戻り値: `"q"` (Native QUIC MUST) / `"wt"` (WebTransport MUST) / `undefined`
 */
export function getConnectionParameter(
  parameters: ReadonlyArray<readonly [string, string]>,
): "q" | "wt" | undefined {
  for (const [key, value] of parameters) {
    if (key === "connection") {
      if (value === "q" || value === "wt") return value;
      return undefined;
    }
  }
  return undefined;
}

/**
 * msf fragment の connection パラメータがサポートされる transport か検証する
 * (draft-ietf-moq-msf-01 §11.1.1)
 *
 * connection=q は Native QUIC MUST だが未実装のため reject する。
 * connection=wt / 欠如 / 不正値（undefined）は WebTransport（現行）を許可する。
 * msf 以外の fragment type は対象外（何もしない）。
 *
 * @param fragment moqt URI fragment（type / value の組、指定なしは null）
 * @throws Error connection=q のとき（Native QUIC 未実装）。msf fragment value が不正な場合は
 *   parseMsfFragmentValue のエラーが伝播する。
 */
export function assertMsfConnectionSupported(
  fragment: {
    readonly type: string;
    readonly value: string;
  } | null,
): void {
  if (fragment?.type !== "msf") {
    return;
  }
  const connection = getConnectionParameter(parseMsfFragmentValue(fragment.value).parameters);
  if (connection === "q") {
    throw new Error(
      "msf fragment connection='q' requires Native QUIC, which is not implemented (only 'wt' WebTransport is supported)",
    );
  }
}

// =============================================================================
// MSF URI Fragment reserved key helpers (draft-ietf-moq-msf-01 §11.1.1)
// =============================================================================

/**
 * wallclock-range / mediatime-range のパース結果
 */
export interface MsfTimeRange {
  start: number;
  end?: number;
}

/**
 * location-range のパース結果
 */
export interface MsfLocationRange {
  start: { groupId: bigint; objectId?: bigint };
  end?: { groupId: bigint; objectId?: bigint };
}

/**
 * wallclock-range パラメータを取得する
 *
 * draft-ietf-moq-msf-01 §11.1.1: range は inclusive。終端省略で open range MAY。
 * 同一 key 複数は union MUST。不正値はスキップして走査を続行する。
 * start 省略形（例: "-200"）は不正値としてスキップする。
 */
export function getWallclockRanges(
  parameters: ReadonlyArray<readonly [string, string]>,
): MsfTimeRange[] {
  return parseTimeRanges(parameters, "wallclock-range");
}

/**
 * mediatime-range パラメータを取得する
 *
 * draft-ietf-moq-msf-01 §11.1.1: wallclock-range と同じ形式。
 */
export function getMediatimeRanges(
  parameters: ReadonlyArray<readonly [string, string]>,
): MsfTimeRange[] {
  return parseTimeRanges(parameters, "mediatime-range");
}

/**
 * location-range パラメータを取得する
 *
 * draft-ietf-moq-msf-01 §11.1.1: Group.Object を `.`、範囲を `-` で区切る。
 * 第 2 値省略時は `.` / `-` を MUST omit。
 * 不正値はスキップして走査を続行する。
 */
export function getLocationRanges(
  parameters: ReadonlyArray<readonly [string, string]>,
): MsfLocationRange[] {
  const ranges: MsfLocationRange[] = [];
  for (const [key, value] of parameters) {
    if (key !== "location-range") continue;
    const parsed = parseLocationRangeValue(value);
    if (parsed !== undefined) {
      ranges.push(parsed);
    }
  }
  return ranges;
}

/**
 * c4m パラメータを取得する
 *
 * draft-ietf-moq-msf-01 §11.1.1: base64 文字列のまま返す。検証しない。
 * 最初の c4m エントリを返す。
 */
export function getC4mParameter(
  parameters: ReadonlyArray<readonly [string, string]>,
): string | undefined {
  for (const [key, value] of parameters) {
    if (key === "c4m") {
      return value;
    }
  }
  return undefined;
}

/**
 * wallclock-range / mediatime-range の共通パース処理
 */
function parseTimeRanges(
  parameters: ReadonlyArray<readonly [string, string]>,
  keyName: string,
): MsfTimeRange[] {
  const ranges: MsfTimeRange[] = [];
  for (const [key, value] of parameters) {
    if (key !== keyName) continue;
    const parsed = parseTimeRangeValue(value);
    if (parsed !== undefined) {
      ranges.push(parsed);
    }
  }
  return ranges;
}

/**
 * "start-end" 形式の time range 値をパースする。
 * 不正値は undefined を返す（スキップ）。
 */
function parseTimeRangeValue(value: string): MsfTimeRange | undefined {
  if (value.length === 0) return undefined;
  // start 省略形（"-200"）は不正
  if (value.startsWith("-")) return undefined;

  const dashIndex = value.indexOf("-");
  if (dashIndex === -1) {
    // start のみ
    const start = Number(value);
    if (!Number.isFinite(start)) return undefined;
    return { start };
  }

  const startStr = value.slice(0, dashIndex);
  const endStr = value.slice(dashIndex + 1);
  if (startStr.length === 0) return undefined;

  const start = Number(startStr);
  if (!Number.isFinite(start)) return undefined;

  if (endStr.length === 0) {
    // open range: "start-"
    return { start };
  }

  const end = Number(endStr);
  if (!Number.isFinite(end)) return undefined;

  return { start, end };
}

/**
 * location-range 値をパースする。
 * 形式: "Group.Object-Group.Object" / "Group.Object" / "Group-Group"
 * 不正値は undefined を返す（スキップ）。
 */
function parseLocationRangeValue(value: string): MsfLocationRange | undefined {
  if (value.length === 0) return undefined;
  // start 省略形（"-..."）は不正
  if (value.startsWith("-")) return undefined;

  const dashIndex = value.indexOf("-");
  if (dashIndex === -1) {
    // start のみ
    const start = parseLocationPoint(value);
    if (start === undefined) return undefined;
    return { start };
  }

  const startStr = value.slice(0, dashIndex);
  const endStr = value.slice(dashIndex + 1);
  if (startStr.length === 0) return undefined;

  const start = parseLocationPoint(startStr);
  if (start === undefined) return undefined;

  if (endStr.length === 0) {
    // open range: "start-"
    return { start };
  }

  const end = parseLocationPoint(endStr);
  if (end === undefined) return undefined;

  return { start, end };
}

/**
 * "Group" または "Group.Object" 形式をパースする。
 * ドット過多（"1.2.3"）や末尾ドット（"1."）は不正。
 */
function parseLocationPoint(value: string): { groupId: bigint; objectId?: bigint } | undefined {
  if (value.length === 0) return undefined;

  const dotIndex = value.indexOf(".");
  if (dotIndex === -1) {
    // Group のみ
    const groupId = parseNonNegativeBigInt(value);
    if (groupId === undefined) return undefined;
    return { groupId };
  }

  // ドットが複数ある場合は不正
  if (value.includes(".", dotIndex + 1)) return undefined;

  const groupStr = value.slice(0, dotIndex);
  const objectStr = value.slice(dotIndex + 1);
  // 末尾ドット（"1."）は不正
  if (groupStr.length === 0 || objectStr.length === 0) return undefined;

  const groupId = parseNonNegativeBigInt(groupStr);
  if (groupId === undefined) return undefined;

  const objectId = parseNonNegativeBigInt(objectStr);
  if (objectId === undefined) return undefined;

  return { groupId, objectId };
}

/**
 * 非負整数文字列を bigint にパースする。不正値は undefined。
 */
function parseNonNegativeBigInt(value: string): bigint | undefined {
  if (value.length === 0) return undefined;
  if (!/^[0-9]+$/.test(value)) return undefined;
  return BigInt(value);
}

// =============================================================================
// 初期化データ解決 helper
// =============================================================================

/**
 * Catalog から track の初期化データを解決する
 * (draft-ietf-moq-msf-01 §5.1.7 / §5.2.13)
 *
 * track.initRef が `Catalog.initDataList` のエントリ `id` を参照していれば、
 * その `data` (`type: "inline"` の場合は Base64 文字列) を返す。
 *
 * - initRef が未指定 → undefined
 * - initRef が指定されているが initDataList にエントリが無い → undefined
 *   (parser MUST ignore unknown 互換、§5)
 * - initDataList エントリの `type` が `"inline"` 以外 → undefined
 *   (現バージョンでは inline のみ定義、§5.1.7 Table 2)
 */
export function resolveInitData(catalog: Catalog, track: CatalogTrack): string | undefined {
  if (track.initRef === undefined) return undefined;
  if (catalog.initDataList === undefined) return undefined;
  const entry = catalog.initDataList.find((e) => e.id === track.initRef);
  if (entry === undefined) return undefined;
  if (entry.type !== "inline") return undefined;
  return entry.data;
}

// =============================================================================
// Catalog ヘルパー関数
// =============================================================================

/**
 * Catalog からビデオトラックを取得する
 */
export function getVideoTracks(catalog: Catalog): CatalogTrack[] {
  return catalog.tracks.filter((track) => track.role === "video");
}

/**
 * Catalog からオーディオトラックを取得する
 */
export function getAudioTracks(catalog: Catalog): CatalogTrack[] {
  return catalog.tracks.filter((track) => track.role === "audio");
}

/**
 * Catalog から指定した名前のトラックを取得する
 */
export function getTrackByName(catalog: Catalog, name: string): CatalogTrack | undefined {
  return catalog.tracks.find((track) => track.name === name);
}

/**
 * Catalog から指定した altGroup のトラックを取得する (ABR 用)
 */
export function getTracksByAltGroup(catalog: Catalog, altGroup: number): CatalogTrack[] {
  return catalog.tracks.filter((track) => track.altGroup === altGroup);
}

/**
 * Catalog から指定した renderGroup のトラックを取得する
 */
export function getTracksByRenderGroup(catalog: Catalog, renderGroup: number): CatalogTrack[] {
  return catalog.tracks.filter((track) => track.renderGroup === renderGroup);
}

/**
 * 新しい Catalog を作成する
 */
export function createCatalog(
  tracks: CatalogTrack[],
  options?: Partial<Omit<Catalog, "version" | "tracks">>,
): Catalog {
  const catalog: Catalog = { version: MSF_VERSION, tracks };
  if (options !== undefined) {
    if (options.generatedAt !== undefined) catalog.generatedAt = options.generatedAt;
    // §5.1.3: isComplete は true 値のみ。`false` 指定や `undefined` は無視する。
    if (options.isComplete === true) catalog.isComplete = true;
    if (options.publishTracks !== undefined) catalog.publishTracks = options.publishTracks;
    if (options.initDataList !== undefined) catalog.initDataList = options.initDataList;
  }
  return catalog;
}

/**
 * 配信完了を示す Catalog を作成する
 * (draft-ietf-moq-msf-01 §5.1.3 / §9.2)
 */
export function createCompleteCatalog(): Catalog {
  return {
    version: MSF_VERSION,
    tracks: [],
    isComplete: true,
  };
}

// =============================================================================
// Group 番号付け
// =============================================================================

/**
 * 最初の Group ID を生成する (draft-ietf-moq-msf-01 §6.1)
 *
 * The Group ID of the first Group published in a track at application startup
 * MUST be a unique integer that will not repeat in the future.
 */
export function createInitialGroupId(): bigint {
  return BigInt(Date.now());
}

/**
 * 次の Group ID を計算する (draft-ietf-moq-msf-01 §6.1)
 *
 * Each subsequent Group ID MUST increase by 1.
 */
export function nextGroupId(current: bigint): bigint {
  return current + 1n;
}

// =============================================================================
// ABR トラック選択
// =============================================================================

/**
 * 指定したビットレート以下で最大のビットレートを持つトラックを選択する
 */
export function selectTrackByMaxBitrate(
  tracks: CatalogTrack[],
  maxBitrate: number,
): CatalogTrack | undefined {
  const eligible = tracks.filter(
    (track) => track.bitrate !== undefined && track.bitrate <= maxBitrate,
  );
  if (eligible.length === 0) {
    return undefined;
  }
  return eligible.reduce((best, track) => {
    if (best.bitrate === undefined) return track;
    if (track.bitrate === undefined) return best;
    return track.bitrate > best.bitrate ? track : best;
  });
}

/**
 * 指定した解像度以下で最大の解像度を持つトラックを選択する
 */
export function selectTrackByMaxResolution(
  tracks: CatalogTrack[],
  maxWidth: number,
  maxHeight: number,
): CatalogTrack | undefined {
  const eligible = tracks.filter(
    (track) =>
      track.width !== undefined &&
      track.height !== undefined &&
      track.width <= maxWidth &&
      track.height <= maxHeight,
  );
  if (eligible.length === 0) {
    return undefined;
  }
  return eligible.reduce((best, track) => {
    const bestPixels = (best.width ?? 0) * (best.height ?? 0);
    const trackPixels = (track.width ?? 0) * (track.height ?? 0);
    return trackPixels > bestPixels ? track : best;
  });
}

/**
 * altGroup 内で最高ビットレートのトラックを選択する
 */
export function selectHighestBitrateTrack(
  catalog: Catalog,
  altGroup: number,
): CatalogTrack | undefined {
  const tracks = getTracksByAltGroup(catalog, altGroup);
  if (tracks.length === 0) {
    return undefined;
  }
  return tracks.reduce((best, track) => {
    if (best.bitrate === undefined) return track;
    if (track.bitrate === undefined) return best;
    return track.bitrate > best.bitrate ? track : best;
  });
}

/**
 * altGroup 内で最低ビットレートのトラックを選択する
 */
export function selectLowestBitrateTrack(
  catalog: Catalog,
  altGroup: number,
): CatalogTrack | undefined {
  const tracks = getTracksByAltGroup(catalog, altGroup);
  if (tracks.length === 0) {
    return undefined;
  }
  return tracks.reduce((best, track) => {
    if (best.bitrate === undefined) return track;
    if (track.bitrate === undefined) return best;
    return track.bitrate < best.bitrate ? track : best;
  });
}
