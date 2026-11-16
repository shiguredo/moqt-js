/**
 * Catalog のトラック検索・生成と Group 番号付け
 * (draft-ietf-moq-msf-02 §5.1.7 / §5.2.14 / §6.1)
 *
 * `createCatalog` は生成した Catalog がそのまま送れるかを `catalogCodec` の
 * `assertCatalogEncodable` で確かめる (実際に送る JSON を decode 側の検証に通す)。
 *
 * 参照: draft-ietf-moq-msf-02
 */

/**
 * catalog が参照する別 catalog の track を返す (draft-02 §5 冒頭 / §5.2.4 Table 5)
 *
 * §5: A catalog track MAY reference other catalog tracks.
 * 参照先の track は `packaging: "catalog"` で表される。トップレベルの catalog track だけが
 * Track Name `"catalog"` を持ち、参照先は任意の名前を取れる。
 *
 * 本関数は track を抽出するだけで、参照先 catalog の購読は行わない。購読するかどうかは
 * 利用者が決める。
 *
 * @param catalog - 対象の catalog
 * @returns `packaging: "catalog"` の track の配列 (宣言順)
 */
export function getReferencedCatalogs(catalog: Catalog): CatalogTrack[] {
  return catalog.tracks.filter((track) => track.packaging === "catalog");
}

/**
 * track を購読する Track Namespace を決める (draft-02 §5.2.2)
 *
 * §5.2.2: If the track namespace is not declared within a track object, then the track MUST
 * inherit the Track Namespace of the catalog track, that is, the Track Namespace under which
 * the catalog itself was subscribed. A namespace declared in a track object replaces (and does
 * not extend) any inherited namespace.
 *
 * @param track - 対象の track
 * @param catalogNamespace - catalog を購読した Track Namespace フィールド列
 * @returns 購読に使う Track Namespace フィールド列
 */
export function resolveCatalogTrackNamespace(
  track: Pick<CatalogTrack, "namespace">,
  catalogNamespace: readonly string[],
): string[] {
  if (track.namespace === undefined) {
    return [...catalogNamespace];
  }
  return catalogNamespaceFields(track.namespace);
}

/**
 * catalog の Track Namespace 文字列を MOQT の Track Namespace フィールド列に変換する
 *
 * draft-02 §5.2.2: The value is a single JSON string in which the '/' character (U+002F
 * SOLIDUS) delimits the boundaries between Track Namespace Fields. The string is split at
 * each '/' character, and the resulting substrings correspond, in order, to the Track
 * Namespace Fields of the MOQT Track Namespace.
 *
 * decode の時点で形式を検証しているため、ここでは分割だけを行う。呼び出し側が
 * 任意の文字列を渡す場合に備え、空のフィールドは Error にする。
 *
 * @param namespace - catalog の `namespace` フィールドの値
 * @returns MOQT の Track Namespace フィールド列
 * @throws Error 空のフィールドを含むとき
 */
export function catalogNamespaceFields(namespace: string): string[] {
  const fields = namespace.split("/");
  for (const [index, field] of fields.entries()) {
    if (field.length === 0) {
      throw new Error(
        `invalid catalog namespace: field at index ${index} must not be empty per §5.2.2`,
      );
    }
  }
  return fields;
}

import { assertCatalogEncodable } from "./catalogCodec";
import { MSF_VERSION } from "./version";
import type { Catalog, CatalogTrack, InitDataEntry } from "./types";
import type { PackagingType, TrackRole } from "./version";

// =============================================================================
// 初期化データ解決 helper
// =============================================================================

/**
 * Catalog から track の初期化データを解決する
 * (draft-ietf-moq-msf-02 §5.1.7 / §5.2.14)
 *
 * track.initRef が `Catalog.initDataList` のエントリ `id` を参照していれば、
 * その `data` (`type: "inline"` の場合は Base64 文字列) を返す。
 *
 * - initRef が未指定 → undefined
 * - initRef が指定されているが initDataList にエントリが無い → undefined
 *   (parser MUST ignore unknown 互換、§5)
 * - initDataList エントリの `type` が `"inline"` 以外 → undefined
 *   (§5.1.7 Table 3: inline / track-property / object-property を定義)
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
 *
 * 生成した Catalog を `assertCatalogEncodable` で検証する。実際に送る JSON を decode 側の
 * 検証に通すため、track 単位の MUST などの違反は組み立てた時点で分かる。従来作成できていた
 * 違反 Catalog を拒否する破壊的変更になる。
 *
 * 検証を通った `tracks` / `publishTracks` / `initDataList` は変換せずそのまま保持する。
 * 生成後に書き換えても検証はやり直されないため、`encodeCatalog` が送信の直前に再検証する。
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
  assertCatalogEncodable(catalog);
  return catalog;
}

/**
 * 配信完了を示す Catalog を作成する
 *
 * draft-ietf-moq-msf-02 §5.1.3 (Is Complete):
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
 * draft-ietf-moq-msf-02 §5.2.9: `isLive` が false のトラックの `targetLatency` は
 * 無視する MUST。宣言が無いときは null を返し、使う側が表示の遅れを選ぶ (MAY)。
 * 負や非有限の値は表示の遅れにできないため、宣言が無いものとして null を返す
 * (入口の `setTargetLatencyMs` は 0 以上だけを受け取るため、ここで正規化しないと
 * 購読の開始が失敗する)。
 *
 * @param track - 対象のトラック。解決できていないときは null
 */
export function effectiveTargetLatencyMs(track: CatalogTrack | null): number | null {
  if (track === null || !track.isLive) {
    return null;
  }
  const latencyMs = track.targetLatency;
  if (latencyMs === undefined || !Number.isFinite(latencyMs) || latencyMs < 0) {
    // 負や非有限は表示の遅れにならない。宣言が無いものとして扱う (start を失敗させない)
    return null;
  }
  return latencyMs;
}

/**
 * 2 つのトラックが同じ render group か alternate group に属するか
 *
 * draft-ietf-moq-msf-02 §5.2.9 の「同じ値でなければならない MUST」は同じ group の
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
 * draft-ietf-moq-msf-02 §5.2.9:
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
 * 最初の Group ID を生成する (draft-ietf-moq-msf-02 §6.1)
 *
 * The Group ID of the first Group published in a track at application startup
 * MUST be a unique integer that will not repeat in the future.
 */
export function createInitialGroupId(): bigint {
  return BigInt(Date.now());
}

/**
 * 次の Group ID を計算する (draft-ietf-moq-msf-02 §6.1)
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

/**
 * トラック切替の有効な切替点を計算する (draft-02 §6.3.2)
 *
 * §6.3.2: Given a source track with keyframeSpacing S and a target track with keyframeSpacing T,
 * a switch from Group ID G and Object ID N of the source track is valid if `(G * S + N) / T`
 * yields an integer. That integer is the Group ID in the target track at which the subscriber
 * begins receiving objects, starting at Object ID 0.
 *
 * 切替元と切替先の両方に `keyframeSpacing` が必要である。§4.3 が alternate group 内の各 track に
 * MUST で要求しているため、無い場合はエラーにする。
 *
 * @param sourceKeyframeSpacing - 切替元の keyframeSpacing (S)
 * @param targetKeyframeSpacing - 切替先の keyframeSpacing (T)
 * @param location - 切替元で最後に受信した位置 (Group ID と Object ID)
 * @returns 切替可能かどうかと、切替可能な場合の切替先の開始 Group ID
 * @throws Error keyframeSpacing が正の整数でないとき
 */
export function calculateTrackSwitchPoint(
  sourceKeyframeSpacing: number,
  targetKeyframeSpacing: number,
  location: { readonly groupId: bigint; readonly objectId: bigint },
): { readonly valid: boolean; readonly startGroupId?: bigint } {
  for (const [label, value] of [
    ["source", sourceKeyframeSpacing],
    ["target", targetKeyframeSpacing],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `${label} keyframeSpacing must be a positive integer per §5.2.46, got ${value}`,
      );
    }
  }
  // (G * S + N) を T で割った余りが 0 なら切替可能。商が切替先の開始 Group ID になる
  const sourceSpacing = BigInt(sourceKeyframeSpacing);
  const targetSpacing = BigInt(targetKeyframeSpacing);
  const position = location.groupId * sourceSpacing + location.objectId;
  if (position % targetSpacing !== 0n) {
    return { valid: false };
  }
  return { valid: true, startGroupId: position / targetSpacing };
}

/**
 * `initRef` の参照先エントリを返す (draft-02 §5.1.7 / §5.2.14)
 *
 * Table 3 の type ごとに `data` の意味が異なる。
 * - `inline`: Base64 でエンコードされた初期化データ
 * - `track-property` / `object-property`: 初期化データを運ぶ property の type (hex 表記)
 *
 * `resolveInitData` は inline の Base64 だけを返すため、property 型の property type を
 * 知りたい場合は本関数を使う。
 *
 * @param catalog - 対象の catalog
 * @param track - 対象の track
 * @returns 参照先のエントリ。initRef が無い / 解決できないときは undefined
 */
export function resolveInitDataEntry(
  catalog: Catalog,
  track: CatalogTrack,
): InitDataEntry | undefined {
  if (track.initRef === undefined) {
    return undefined;
  }
  return catalog.initDataList?.find((entry) => entry.id === track.initRef);
}

// =============================================================================
// 参照カタログの循環検出 / publishTracks / 購読 endpoint
// =============================================================================

/**
 * 参照カタログを辿って循環と深さ超過を検出する (draft-02 §13.7)
 *
 * §13.7 は、catalog の参照を辿る実装に循環検出と展開後の上限を MUST で要求する。
 * 本実装は自動で参照を辿らないため、利用者が辿るときにこの関数で検証する。
 *
 * @param root - 起点の catalog
 * @param resolve - 参照先 track から catalog を返すコールバック。解決できなければ undefined
 * @param options - 深さ上限 (既定 8)
 * @returns 到達した catalog の数
 * @throws Error 循環または深さ超過のとき
 */
export function assertCatalogReferenceAcyclic(
  root: Catalog,
  resolve: (track: CatalogTrack) => Catalog | undefined,
  options?: { readonly maxDepth?: number },
): number {
  const maxDepth = options?.maxDepth ?? 8;
  const visited = new Set<Catalog>();
  const walk = (catalog: Catalog, depth: number): number => {
    if (depth > maxDepth) {
      throw new Error(`invalid catalog reference: depth exceeds ${maxDepth} per §13.7`);
    }
    if (visited.has(catalog)) {
      throw new Error("invalid catalog reference: cycle detected per §13.7");
    }
    visited.add(catalog);
    let count = 1;
    for (const track of getReferencedCatalogs(catalog)) {
      const next = resolve(track);
      if (next !== undefined) {
        count += walk(next, depth + 1);
      }
    }
    visited.delete(catalog);
    return count;
  };
  return walk(root, 0);
}

/**
 * publishTracks を組み立てる (draft-02 §5.1.5 / §9.4 / §10.4)
 *
 * log / metrics の track 定義を catalog の `publishTracks` に載せられる形にする。
 * namespace は catalog の `/` 区切り表現 (§5.2.2) で指定する。
 *
 * @param entries - track の定義
 * @returns publishTracks に渡せる track の配列
 */
export function createPublishTracks(
  entries: readonly {
    readonly name: string;
    readonly namespace: string;
    readonly packaging: PackagingType;
    readonly role: TrackRole;
    readonly isLive?: boolean;
  }[],
): CatalogTrack[] {
  return entries.map((entry) => ({
    name: entry.name,
    namespace: entry.namespace,
    packaging: entry.packaging,
    role: entry.role,
    isLive: entry.isLive ?? true,
  }));
}

/**
 * catalog の publishTracks を取り出す (draft-02 §5.1.5)
 *
 * @param catalog - 対象の catalog
 * @param role - 指定するとその role だけに絞る
 * @returns publishTracks の track の配列
 */
export function getPublishTracks(catalog: Catalog, role?: TrackRole): CatalogTrack[] {
  const tracks = catalog.publishTracks ?? [];
  return role === undefined ? [...tracks] : tracks.filter((track) => track.role === role);
}

/**
 * track を購読する MOQT endpoint を決める (draft-02 §5.2.37)
 *
 * §5.2.37: if a track object includes a connectionURI, the subscriber MUST establish a new
 * MOQT connection to the given endpoint before subscribing.
 *
 * 高レベル購読は 1 接続を前提にしているため、`connectionURI` がある track は
 * 利用者がこの関数で endpoint を解決し、その URI に対して別の購読を立てる。
 *
 * @param track - 購読する track
 * @param defaultUri - `connectionURI` が無いときに使う URI
 * @returns 購読先の URI
 */
export function resolveSubscribeEndpoint(
  track: Pick<CatalogTrack, "connectionURI">,
  defaultUri: string,
): string {
  return track.connectionURI ?? defaultUri;
}

/**
 * 映像 track の切替を計画する (draft-02 §6.3 / §6.3.2)
 *
 * 切替元と切替先の `keyframeSpacing` から、切替先を購読し始める Group を決める。
 * 両方に `keyframeSpacing` が必要である (§4.3)。
 *
 * @param current - 切替元の track
 * @param target - 切替先の track
 * @param location - 切替元で最後に受信した位置
 * @returns 切替先の開始 Group ID
 * @throws Error keyframeSpacing が無いとき、または現在位置が切替点でないとき
 */
export function planTrackSwitch(
  current: Pick<CatalogTrack, "name" | "keyframeSpacing">,
  target: Pick<CatalogTrack, "name" | "keyframeSpacing">,
  location: { readonly groupId: bigint; readonly objectId: bigint },
): { readonly startGroupId: bigint } {
  if (current.keyframeSpacing === undefined || target.keyframeSpacing === undefined) {
    throw new Error(
      `cannot switch track '${target.name}': keyframeSpacing is required on both tracks per §4.3`,
    );
  }
  const point = calculateTrackSwitchPoint(
    current.keyframeSpacing,
    target.keyframeSpacing,
    location,
  );
  if (!point.valid || point.startGroupId === undefined) {
    throw new Error(
      `cannot switch track '${target.name}': the current position is not a valid switch point per §6.3.2`,
    );
  }
  return { startGroupId: point.startGroupId };
}
