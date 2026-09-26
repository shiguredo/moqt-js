/**
 * Catalog のトラック検索・生成と Group 番号付け
 * (draft-ietf-moq-msf-01 §5.1.7 / §5.2.13 / §6.1)
 *
 * 参照: draft-ietf-moq-msf-01
 */

import { MSF_VERSION } from "./version";
import type { Catalog, CatalogTrack } from "./types";

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
 *
 * draft-ietf-moq-msf-01 §5.1.3 (Is Complete):
 * "A catalog-level indication that the broadcast is complete. This is a
 *  commitment that all tracks are complete, no new tracks will be added to the
 *  catalog, and no new content will be published on any track."
 * isComplete は true のときのみ含める (FALSE は MUST NOT)。
 */
export function createCompleteCatalog(): Catalog {
  return {
    version: MSF_VERSION,
    tracks: [],
    isComplete: true,
  };
}

// =============================================================================
// targetLatency の解決
// =============================================================================

/**
 * トラックが宣言する `targetLatency` を使える値にする (ミリ秒)
 *
 * draft-ietf-moq-msf-01 §5.2.8: `isLive` が false のトラックの `targetLatency` は
 * 無視する MUST。宣言が無いときは null を返し、使う側が表示の遅れを選ぶ (MAY)。
 *
 * @param track - 対象のトラック。解決できていないときは null
 */
export function effectiveTargetLatencyMs(track: CatalogTrack | null): number | null {
  if (track === null || !track.isLive) {
    return null;
  }
  return track.targetLatency ?? null;
}

/**
 * 2 つのトラックが同じ render group か alternate group に属するか
 *
 * draft-ietf-moq-msf-01 §5.2.8 の「同じ値でなければならない MUST」は同じ group の
 * track に限られる。group が無い、または異なる場合は仕様に反しない。
 */
function sharesRenderOrAlternateGroup(
  audio: CatalogTrack | null,
  video: CatalogTrack | null,
): boolean {
  if (audio === null || video === null) {
    return false;
  }
  const sameRenderGroup =
    audio.renderGroup !== undefined && audio.renderGroup === video.renderGroup;
  const sameAlternateGroup = audio.altGroup !== undefined && audio.altGroup === video.altGroup;
  return sameRenderGroup || sameAlternateGroup;
}

/**
 * 音声と映像で使う `targetLatency` を 1 つ決める (ミリ秒)
 *
 * draft-ietf-moq-msf-01 §5.2.8:
 * - `isLive` が false の track の `targetLatency` は無視する (MUST)
 * - 同じ render group (または alternate group) の track は同じ値でなければならない (MUST)
 * - 無い場合、プレイヤーが遅延を選んでよい (MAY)
 *
 * 片方にしか無いときは、もう片方は遅延を選んでよいため同じ値を使って揃える。両方にあって
 * 異なるときは、同じ group なら MUST 違反として `conflict` を真にして通知を呼び出し側へ
 * 委ね (ライブラリは `onError`、devtools は警告ログ)、大きい方を使う (小さい方の要求より
 * 早く出さない)。group が違う、または無いときは仕様に反しないため通知しない。
 *
 * @param audio - 購読する音声トラック。購読しない、または解決できていないときは null
 * @param video - 購読する映像トラック。購読しない、または解決できていないときは null
 * @returns `value` は共有して使う値 (使わないときは null)、`conflict` は同じ group の
 *   track で値が異なり通知が必要かどうか
 */
export function resolveSharedTargetLatencyMs(
  audio: CatalogTrack | null,
  video: CatalogTrack | null,
): { value: number | null; conflict: boolean } {
  const audioMs = effectiveTargetLatencyMs(audio);
  const videoMs = effectiveTargetLatencyMs(video);
  if (audioMs === null) {
    return { value: videoMs, conflict: false };
  }
  if (videoMs === null) {
    return { value: audioMs, conflict: false };
  }
  if (audioMs === videoMs) {
    return { value: audioMs, conflict: false };
  }
  return {
    value: Math.max(audioMs, videoMs),
    conflict: sharesRenderOrAlternateGroup(audio, video),
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
