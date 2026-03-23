/**
 * MOQT Streaming Format (MSF) の型定義とシリアライズ関数
 *
 * MSF = LOC (メディアパッケージング) + Catalog (メタデータ) + Timeline (オプション)
 *
 * 参照: draft-ietf-moq-msf-00
 */

// =============================================================================
// 定数
// =============================================================================

/** MSF バージョン (Section 5.1.1) */
export const MSF_VERSION = 1;

/** Catalog トラック名 (固定, Section 5) */
export const CATALOG_TRACK_NAME = "catalog";

/** パッケージング形式 (Section 5.1.12, Table 3) */
export type PackagingType = "loc" | "mediatimeline" | "eventtimeline";

/** トラックの役割 (Section 5.1.14, Table 4, 拡張可能) */
export type TrackRole = string;

// =============================================================================
// Catalog 型定義
// =============================================================================

/**
 * Catalog トラック定義 (Section 5.1.9)
 */
export interface CatalogTrack {
  /** トラック名 (必須, Section 5.1.11) */
  name: string;

  /** パッケージング形式 (必須, Section 5.1.12) */
  packaging: PackagingType;

  /** ライブ配信かどうか (必須, Section 5.1.15) */
  isLive: boolean;

  /** トラックの名前空間 (Section 5.1.10) */
  namespace?: string;

  /** 目標遅延 (ms, Section 5.1.16) */
  targetLatency?: number;

  /** トラックの役割 (Section 5.1.14) */
  role?: TrackRole;

  /** 人間が読めるラベル (Section 5.1.17) */
  label?: string;

  /** 同時レンダリンググループ (Section 5.1.18) */
  renderGroup?: number;

  /** 代替トラックグループ (ABR 用, Section 5.1.19) */
  altGroup?: number;

  /** Base64 エンコードされた初期化データ (Section 5.1.20) */
  initData?: string;

  /** 依存トラック名の配列 (Section 5.1.21) */
  depends?: string[];

  /** テンポラルレイヤー ID (Section 5.1.22) */
  temporalId?: number;

  /** スペーシャルレイヤー ID (Section 5.1.23) */
  spatialId?: number;

  /** コーデック (WebCodecs 形式, Section 5.1.24) */
  codec?: string;

  /** MIME タイプ (Section 5.1.25) */
  mimeType?: string;

  /** フレームレート (fps, Section 5.1.26) */
  framerate?: number;

  /** 1秒あたりの時間単位数 (Section 5.1.27) */
  timescale?: number;

  /** ビットレート (bps, Section 5.1.28) */
  bitrate?: number;

  /** 映像幅 (px, Section 5.1.29) */
  width?: number;

  /** 映像高さ (px, Section 5.1.30) */
  height?: number;

  /** 表示幅 (px, Section 5.1.33) */
  displayWidth?: number;

  /** 表示高さ (px, Section 5.1.34) */
  displayHeight?: number;

  /** オーディオサンプルレート (Section 5.1.31) */
  samplerate?: number;

  /** チャンネル構成 (Section 5.1.32) */
  channelConfig?: string;

  /** 言語タグ (RFC 5646, Section 5.1.35) */
  lang?: string;

  /** 親トラック名 (cloneTracks 用, Section 5.1.36) */
  parentName?: string;

  /** トラック長 (ms, VOD 用, Section 5.1.37) */
  trackDuration?: number;

  /** イベントタイムラインのタイプ (packaging が eventtimeline の場合に必須, Section 5.1.13) */
  eventType?: string;
}

/**
 * removeTracks で使用するトラック識別子 (Section 5.1.4)
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
 * フルカタログ (Section 5.1)
 *
 * version と tracks が必須。delta update ではないカタログ。
 */
export interface Catalog {
  /** MSF バージョン (必須, 現在は 1, Section 5.1.1) */
  version: typeof MSF_VERSION;

  /** トラック配列 (必須, Section 5.1.8) */
  tracks: CatalogTrack[];

  /** 生成時刻 (Unix ms, Section 5.1.6) */
  generatedAt?: number;

  /** 配信完了フラグ (Section 5.1.7) */
  isComplete?: boolean;
}

/**
 * 差分更新カタログ (Section 5.2)
 *
 * Delta update は version と tracks を含んではならない (MUST NOT)。
 * addTracks, removeTracks, cloneTracks のうち少なくとも 1 つが必須。
 */
export interface CatalogDelta {
  /** 差分更新フラグ (必須, Section 5.1.2) */
  deltaUpdate: true;

  /** 追加するトラック (Section 5.1.3) */
  addTracks?: CatalogTrack[];

  /** 削除するトラック (Section 5.1.4) */
  removeTracks?: RemoveTrack[];

  /** 複製するトラック (Section 5.1.5) */
  cloneTracks?: CatalogTrack[];

  /** 生成時刻 (Unix ms, Section 5.1.6) */
  generatedAt?: number;
}

/**
 * カタログメッセージ (フルカタログまたは差分更新)
 */
export type CatalogMessage = Catalog | CatalogDelta;

// =============================================================================
// Media Timeline 型定義
// =============================================================================

/**
 * Media Timeline エントリ (Section 7.1)
 *
 * [mediaPts, [groupId, objectId], wallclock]
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
 * Event Timeline エントリ (Section 8.1)
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

  /** イベントデータ (Section 8.1, 構造は eventType で定義) */
  data: unknown;
}

// =============================================================================
// Catalog エンコード/デコード
// =============================================================================

/**
 * フルカタログを JSON 文字列にエンコードする
 */
export function encodeCatalog(catalog: Catalog): Uint8Array {
  const json = JSON.stringify(catalog);
  return new TextEncoder().encode(json);
}

/**
 * 差分更新カタログを JSON 文字列にエンコードする
 */
export function encodeCatalogDelta(delta: CatalogDelta): Uint8Array {
  const json = JSON.stringify(delta);
  return new TextEncoder().encode(json);
}

/**
 * JSON バイト列をカタログメッセージにデコードする (Section 5.1, 5.2)
 *
 * deltaUpdate: true の場合は CatalogDelta として、
 * そうでない場合はフルカタログ (Catalog) としてデコードする。
 */
export function decodeCatalogMessage(data: Uint8Array): CatalogMessage {
  const json = new TextDecoder().decode(data);
  const parsed = JSON.parse(json) as unknown;

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("invalid catalog format: expected object");
  }

  const obj = parsed as Record<string, unknown>;

  // deltaUpdate: true の場合は差分更新
  if (obj["deltaUpdate"] === true) {
    if (!isCatalogDelta(obj)) {
      throw new Error("invalid catalog delta format");
    }
    return obj as unknown as CatalogDelta;
  }

  // それ以外はフルカタログ
  if (!isCatalog(obj)) {
    throw new Error("invalid catalog format");
  }

  return obj as unknown as Catalog;
}

/**
 * オブジェクトがフルカタログかどうかを検証する
 */
function isCatalog(obj: Record<string, unknown>): boolean {
  // version は必須で MSF_VERSION (1) である必要がある
  if (obj["version"] !== MSF_VERSION) {
    return false;
  }

  // tracks は必須で配列である必要がある
  const tracks = obj["tracks"];
  if (!Array.isArray(tracks)) {
    return false;
  }

  // 各トラックを検証
  for (const track of tracks) {
    if (!isCatalogTrack(track)) {
      return false;
    }
  }

  return true;
}

/**
 * オブジェクトが差分更新カタログかどうかを検証する (Section 5.2)
 */
function isCatalogDelta(obj: Record<string, unknown>): boolean {
  // deltaUpdate: true は必須
  if (obj["deltaUpdate"] !== true) {
    return false;
  }

  // version と tracks を含んではならない (MUST NOT)
  if ("version" in obj || "tracks" in obj) {
    return false;
  }

  // addTracks, removeTracks, cloneTracks のうち少なくとも 1 つが必須
  const hasAddTracks = Array.isArray(obj["addTracks"]);
  const hasRemoveTracks = Array.isArray(obj["removeTracks"]);
  const hasCloneTracks = Array.isArray(obj["cloneTracks"]);

  if (!hasAddTracks && !hasRemoveTracks && !hasCloneTracks) {
    return false;
  }

  return true;
}

/**
 * オブジェクトが CatalogTrack かどうかを検証する
 */
function isCatalogTrack(obj: unknown): obj is CatalogTrack {
  if (typeof obj !== "object" || obj === null) {
    return false;
  }

  const track = obj as Record<string, unknown>;

  // name は必須
  if (typeof track["name"] !== "string") {
    return false;
  }

  // packaging は必須
  if (typeof track["packaging"] !== "string") {
    return false;
  }

  // isLive は必須
  if (typeof track["isLive"] !== "boolean") {
    return false;
  }

  return true;
}

// =============================================================================
// Media Timeline エンコード/デコード
// =============================================================================

/**
 * Media Timeline を JSON 文字列にエンコードする (Section 7.1)
 *
 * bigint は JSON.stringify で扱えないため、number に変換する
 */
export function encodeMediaTimeline(entries: MediaTimelineEntry[]): Uint8Array {
  // bigint を number に変換
  const serializable = entries.map(([mediaPts, [groupId, objectId], wallclock]) => [
    mediaPts,
    [Number(groupId), Number(objectId)],
    wallclock,
  ]);

  const json = JSON.stringify(serializable);
  return new TextEncoder().encode(json);
}

/**
 * JSON バイト列を Media Timeline にデコードする (Section 7.1)
 */
export function decodeMediaTimeline(data: Uint8Array): MediaTimelineEntry[] {
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

    return [mediaPts, [BigInt(groupId), BigInt(objectId)], wallclock] as MediaTimelineEntry;
  });
}

/**
 * 配列が Media Timeline エントリかどうかを検証する
 */
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
// Event Timeline エンコード/デコード
// =============================================================================

/**
 * Event Timeline を JSON 文字列にエンコードする (Section 8.1)
 */
export function encodeEventTimeline(entries: EventTimelineEntry[]): Uint8Array {
  // bigint を number に変換
  const serializable = entries.map((entry) => {
    const result: Record<string, unknown> = { data: entry.data };

    if (entry.t !== undefined) {
      result["t"] = entry.t;
    }
    if (entry.l !== undefined) {
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
 * JSON バイト列を Event Timeline にデコードする (Section 8.1)
 */
export function decodeEventTimeline(data: Uint8Array): EventTimelineEntry[] {
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
      result.l = [BigInt(l[0] as number), BigInt(l[1] as number)];
    }

    const m = obj["m"];
    if (typeof m === "number") {
      result.m = m;
    }

    return result;
  });
}

/**
 * オブジェクトが Event Timeline エントリかどうかを検証する (Section 8.1)
 *
 * data は必須 (任意の JSON 値)。
 * t, l, m はインデックス参照で、少なくとも 1 つが必要。
 */
function isEventTimelineEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }

  const obj = entry as Record<string, unknown>;

  // data は必須 (undefined や null でない任意の JSON 値)
  if (!("data" in obj) || obj["data"] === undefined) {
    return false;
  }

  // t はオプションだが、存在する場合は number
  const t = obj["t"];
  if (t !== undefined && typeof t !== "number") {
    return false;
  }

  // l はオプションだが、存在する場合は [number, number]
  const l = obj["l"];
  if (l !== undefined) {
    if (!Array.isArray(l) || l.length !== 2) {
      return false;
    }
    if (typeof l[0] !== "number" || typeof l[1] !== "number") {
      return false;
    }
  }

  // m はオプションだが、存在する場合は number
  const m = obj["m"];
  if (m !== undefined && typeof m !== "number") {
    return false;
  }

  return true;
}

// =============================================================================
// ヘルパー関数
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
  return {
    version: MSF_VERSION,
    tracks,
    ...options,
  };
}

/**
 * 配信完了を示す Catalog を作成する (Section 5.1.7, 9.2)
 */
export function createCompleteCatalog(): Catalog {
  return {
    version: MSF_VERSION,
    tracks: [],
    isComplete: true,
  };
}

// =============================================================================
// Catalog 差分更新
// =============================================================================

/**
 * 差分更新を適用して新しい Catalog を作成する (Section 5.2)
 *
 * The Add, Delete and Clone operations are applied sequentially
 * in the order they are declared in the document.
 */
export function applyCatalogDelta(current: Catalog, delta: CatalogDelta): Catalog {
  let tracks = [...current.tracks];

  // removeTracks: 指定されたトラックを name (+namespace) で削除 (Section 5.1.4)
  if (delta.removeTracks && delta.removeTracks.length > 0) {
    for (const removeTrack of delta.removeTracks) {
      tracks = tracks.filter((track) => {
        if (track.name !== removeTrack.name) {
          return true;
        }
        // namespace が指定されている場合はそれも一致する必要がある
        if (removeTrack.namespace !== undefined) {
          return track.namespace !== removeTrack.namespace;
        }
        return false;
      });
    }
  }

  // addTracks: 新しいトラックを追加 (Section 5.1.3)
  if (delta.addTracks && delta.addTracks.length > 0) {
    tracks = [...tracks, ...delta.addTracks];
  }

  // cloneTracks: parentName で指定された既存トラックを複製して追加 (Section 5.1.5, 5.1.36)
  if (delta.cloneTracks && delta.cloneTracks.length > 0) {
    for (const cloneTrack of delta.cloneTracks) {
      if (cloneTrack.parentName) {
        const baseTrack = tracks.find((t) => t.name === cloneTrack.parentName);
        if (baseTrack) {
          // ベーストラックをコピーして cloneTrack のプロパティで上書き
          // parentName はクローン後のトラックからは削除する
          const { parentName: _, ...cloneProps } = cloneTrack;
          const cloned: CatalogTrack = { ...baseTrack, ...cloneProps };
          tracks.push(cloned);
        }
      }
    }
  }

  return {
    version: MSF_VERSION,
    tracks,
    generatedAt: delta.generatedAt ?? current.generatedAt,
  };
}

// =============================================================================
// Group 番号付け
// =============================================================================

/**
 * 最初の Group ID を生成する (Section 6.1)
 *
 * The Group ID of the first Group published in a track at application startup
 * MUST be a unique integer that will not repeat in the future.
 */
export function createInitialGroupId(): bigint {
  return BigInt(Date.now());
}

/**
 * 次の Group ID を計算する (Section 6.1)
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
