/**
 * MOQT Streaming Format (MSF) の型定義とシリアライズ関数
 *
 * MSF = LOC (メディアパッケージング) + Catalog (メタデータ) + Timeline (オプション)
 *
 * 参照: refs/moq/draft-ietf-moq-msf.md
 */

// =============================================================================
// 定数
// =============================================================================

/** MSF バージョン */
export const MSF_VERSION = 1;

/** Catalog トラック名 (固定) */
export const CATALOG_TRACK_NAME = "catalog";

/** パッケージング形式 */
export type PackagingType = "loc" | "mediatimeline" | "eventtimeline";

/** トラックの役割 (拡張可能) */
export type TrackRole = string;

// =============================================================================
// Catalog 型定義
// =============================================================================

/**
 * Catalog トラック定義
 */
export interface CatalogTrack {
  /** トラック名 (必須) */
  name: string;

  /** パッケージング形式 (必須) */
  packaging: PackagingType;

  /** ライブ配信かどうか (必須) */
  isLive: boolean;

  /** トラックの名前空間 */
  namespace?: string;

  /** 目標遅延 (ms) */
  targetLatency?: number;

  /** トラックの役割 */
  role?: TrackRole;

  /** 人間が読めるラベル */
  label?: string;

  /** 同時レンダリンググループ */
  renderGroup?: number;

  /** 代替トラックグループ (ABR 用) */
  altGroup?: number;

  /** Base64 エンコードされた初期化データ */
  initData?: string;

  /** 依存トラック名の配列 */
  depends?: string[];

  /** テンポラルレイヤー ID */
  temporalId?: number;

  /** スペーシャルレイヤー ID */
  spatialId?: number;

  /** コーデック (WebCodecs 形式) */
  codec?: string;

  /** MIME タイプ */
  mimeType?: string;

  /** フレームレート (fps) */
  framerate?: number;

  /** 1秒あたりの時間単位数 */
  timescale?: number;

  /** ビットレート (bps) */
  bitrate?: number;

  /** 映像幅 (px) */
  width?: number;

  /** 映像高さ (px) */
  height?: number;

  /** 表示幅 (px) */
  displayWidth?: number;

  /** 表示高さ (px) */
  displayHeight?: number;

  /** オーディオサンプルレート */
  samplerate?: number;

  /** チャンネル構成 */
  channelConfig?: string;

  /** 言語タグ (RFC 5646) */
  lang?: string;

  /** 親トラック名 (cloneTracks 用) */
  parentName?: string;

  /** トラック長 (ms, VOD 用) */
  trackDuration?: number;

  /** イベントタイムラインのタイプ (packaging が eventtimeline の場合に必須) */
  eventType?: string;
}

/**
 * Catalog ルート構造
 */
export interface Catalog {
  /** MSF バージョン (必須, 現在は 1) */
  version: typeof MSF_VERSION;

  /** トラック配列 (必須) */
  tracks: CatalogTrack[];

  /** 差分更新かどうか */
  deltaUpdate?: boolean;

  /** 追加するトラック (差分更新時) */
  addTracks?: CatalogTrack[];

  /** 削除するトラック名 (差分更新時) */
  removeTracks?: string[];

  /** 複製するトラック (差分更新時) */
  cloneTracks?: CatalogTrack[];

  /** 生成時刻 (Unix ms) */
  generatedAt?: number;

  /** 配信完了フラグ */
  isComplete?: boolean;
}

// =============================================================================
// Media Timeline 型定義
// =============================================================================

/**
 * Media Timeline エントリ
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
 * Event Timeline エントリ
 */
export interface EventTimelineEntry {
  /** 壁時計時間 (Unix ms) */
  t?: number;

  /** Location [groupId, objectId] */
  l?: [bigint, bigint];

  /** メディア PTS (ms) */
  m?: number;

  /** イベントデータ */
  data: Record<string, unknown>;
}

// =============================================================================
// Catalog エンコード/デコード
// =============================================================================

/**
 * Catalog を JSON 文字列にエンコードする
 */
export function encodeCatalog(catalog: Catalog): Uint8Array {
  const json = JSON.stringify(catalog);
  return new TextEncoder().encode(json);
}

/**
 * JSON バイト列を Catalog にデコードする
 */
export function decodeCatalog(data: Uint8Array): Catalog {
  const json = new TextDecoder().decode(data);
  const parsed = JSON.parse(json) as unknown;

  if (!isCatalog(parsed)) {
    throw new Error("invalid catalog format");
  }

  return parsed;
}

/**
 * オブジェクトが Catalog かどうかを検証する
 */
function isCatalog(obj: unknown): obj is Catalog {
  if (typeof obj !== "object" || obj === null) {
    return false;
  }

  const catalog = obj as Record<string, unknown>;

  // version は必須で 1 である必要がある
  if (catalog["version"] !== MSF_VERSION) {
    return false;
  }

  // tracks は必須で配列である必要がある
  const tracks = catalog["tracks"];
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
 * Media Timeline を JSON 文字列にエンコードする
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
 * JSON バイト列を Media Timeline にデコードする
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
 * Event Timeline を JSON 文字列にエンコードする
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
 * JSON バイト列を Event Timeline にデコードする
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
      data: obj["data"] as Record<string, unknown>,
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
 * オブジェクトが Event Timeline エントリかどうかを検証する
 */
function isEventTimelineEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }

  const obj = entry as Record<string, unknown>;

  // data は必須
  const data = obj["data"];
  if (typeof data !== "object" || data === null) {
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
 * 配信完了を示す Catalog を作成する
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
 * 差分更新を適用して新しい Catalog を作成する
 *
 * deltaUpdate: true の場合、addTracks, removeTracks, cloneTracks を適用する
 */
export function applyCatalogDelta(current: Catalog, delta: Catalog): Catalog {
  // deltaUpdate でない場合はそのまま置き換え
  if (!delta.deltaUpdate) {
    return delta;
  }

  // 現在のトラックをコピー
  let tracks = [...current.tracks];

  // removeTracks: 指定されたトラック名を削除
  if (delta.removeTracks && delta.removeTracks.length > 0) {
    const removeSet = new Set(delta.removeTracks);
    tracks = tracks.filter((track) => !removeSet.has(track.name));
  }

  // addTracks: 新しいトラックを追加
  if (delta.addTracks && delta.addTracks.length > 0) {
    tracks = [...tracks, ...delta.addTracks];
  }

  // cloneTracks: 既存トラックを複製して追加
  if (delta.cloneTracks && delta.cloneTracks.length > 0) {
    for (const cloneTrack of delta.cloneTracks) {
      // depends に指定されたトラックを探してベースにする
      if (cloneTrack.depends && cloneTrack.depends.length > 0) {
        const baseTrackName = cloneTrack.depends[0];
        const baseTrack = tracks.find((t) => t.name === baseTrackName);
        if (baseTrack) {
          // ベーストラックをコピーして cloneTrack のプロパティで上書き
          const cloned: CatalogTrack = { ...baseTrack, ...cloneTrack };
          tracks.push(cloned);
        }
      } else {
        // depends がない場合はそのまま追加
        tracks.push(cloneTrack);
      }
    }
  }

  return {
    version: MSF_VERSION,
    tracks,
    generatedAt: delta.generatedAt ?? current.generatedAt,
    isComplete: delta.isComplete,
  };
}

// =============================================================================
// Group 番号付け
// =============================================================================

/**
 * 最初の Group ID を生成する
 *
 * MSF 仕様: 最初の Group ID は一意な整数 (Unix エポックからのミリ秒を推奨)
 */
export function createInitialGroupId(): bigint {
  return BigInt(Date.now());
}

/**
 * 次の Group ID を計算する
 *
 * MSF 仕様: 以降の Group ID は 1 ずつ増加
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
