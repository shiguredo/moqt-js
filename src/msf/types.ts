/**
 * MSF の型定義 (draft-ietf-moq-msf-01 §5)
 *
 * Catalog / Catalog Delta / Media Timeline / Event Timeline の wire format を
 * 表現する型をまとめる。
 *
 * 参照: draft-ietf-moq-msf-01
 */

import type { CipherSuite, MsfVersion, PackagingType, TrackRole } from "./version";

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
 * 各フィールドの section 番号は draft-02 Table 4 を参照。
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

  /**
   * 依存先の配列 (draft-02 §5.2.15)
   *
   * 要素は JSON String (Track Name) か JSON Number (renderGroup) である。
   * すべての要素が catalog 内で解決しなければならない (解決しない catalog は invalid)。
   */
  depends?: readonly (string | number)[];

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

  /**
   * publish track の MOQT 接続先 URI (draft-02 §5.2.37、Table 4 の JSON 名は connectionURI)
   *
   * 指定された場合、購読側はこの URI へ新しい MOQT 接続を張って track を publish する。
   * 省略した場合は catalog を受信した接続を再利用する SHOULD。
   */
  connectionURI?: string;
}

/**
 * Publish track (draft-ietf-moq-msf-02 §5.1.5)
 *
 * subscriber が逆方向に publish するための track 定義。構造は通常の track と同じで、
 * 接続先を表す `connectionURI` (§5.2.37) は `CatalogTrack` 側のフィールドである。
 *
 * draft-02 は track-level の `token` を廃止し、publish の認可は `authInfo` (§5.2.42) で
 * 表す。draft-01 との互換性は維持しない。
 */
export type PublishTrack = CatalogTrack;

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
 * `update` operation で使用する track 更新の指定
 * (draft-ietf-moq-msf-02 §5.1.6 "update")
 *
 * Each track object MUST include a Parent Name field and MAY include a Parent
 * namespace field. Attributes declared in the track object override existing
 * values.
 *
 * `parentName` で対象を特定するため `name` は省略できる。`name` を宣言した場合は
 * Track Name の変更になる (`name` も上書き対象の属性である)。
 */
export type UpdateTrack = {
  /** 更新対象の track 名 (必須) */
  parentName: string;

  /** 更新対象の track 名前空間 */
  parentNamespace?: string;
} & Partial<Omit<CatalogTrack, "parentName" | "parentNamespace">>;

/**
 * 差分更新カタログの operation (draft-ietf-moq-msf-02 §5.1.6)
 *
 * 各 operation は `{op, tracks}` 形式。同一 `op` 値の複数出現が許可される
 * (配列順 = 宣言順)。
 *
 * draft-02 で `update` が追加された。`clone` は新しい Track Name を MUST とするが、
 * `update` は `parentName` で対象を指定して属性だけを上書きする。
 */
export type CatalogDeltaOperation =
  | { type: "add"; tracks: CatalogTrack[] }
  | { type: "remove"; tracks: RemoveTrack[] }
  | { type: "clone"; tracks: CatalogTrack[] }
  | { type: "update"; tracks: UpdateTrack[] };

/**
 * 差分更新カタログ (draft-ietf-moq-msf-02 §5.1.6 / §5.3)
 *
 * §5.3: A delta update MUST include the Delta Update field with at least one
 * operation and the generatedAt field. It MUST NOT include any other Root
 * Catalog fields.
 *
 * wire format は `{"generatedAt": ..., "deltaUpdate": [{op, tracks}, ...]}` の
 * array 形式。`version` / `tracks` / `publishTracks` / `isComplete` /
 * `initDataList` を含む delta は不正である。
 *
 * 未知ルートフィールドは §5.3 が MUST NOT とするため保持しない。
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

  /** 生成時刻 (Unix ms, §5.1.2)。delta update では必須 (§5.3) */
  generatedAt: number;
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
 * - `clone`: delta update の `clone` operation 内エントリ
 *
 * `remove` operation のエントリは `validateRemoveTrack` で検証するため、この
 * コンテキストには現れない。`update` operation のエントリは `name` と `packaging` を
 * 省略できるため、`validateUpdateCatalogTrack` が別に扱う。
 */
export interface ValidationContext {
  source: "root" | "publishTracks" | "add" | "clone";
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
 * Event Timeline エントリ (draft-ietf-moq-msf-02 §8.2)
 *
 * index reference は `T` (wallclock)、`L` (Location)、`M` (Media PTS) のいずれか 1 つ。
 * `data` は任意の JSON 値であり、型と構造は Catalog の eventType フィールドで定義される。
 *
 * draft-01 は小文字 `t` / `l` / `m` だった。draft-02 で大文字に変わり、draft-01 との
 * 互換性は維持しない。
 */
export interface EventTimelineEntry {
  /** 壁時計時間 (Unix ms) */
  T?: number;

  /** Location [groupId, objectId] */
  L?: [bigint, bigint];

  /** メディア PTS (ms) */
  M?: number;

  /** イベントデータ (構造は eventType で定義) */
  data: unknown;
}
