/**
 * Media Timeline / Event Timeline の encode / decode (draft-ietf-moq-msf-02 §7.1 / §8.2)
 *
 * gzip 圧縮は draft-02 §12.1 の MSF_COMPRESSION (0x78) で signaling し、
 * `src/msf/compression.ts` の `compressGzip` / `decompressPayload` で扱う。
 * 本モジュールは無圧縮 JSON を入出力する。
 *
 * 参照: draft-ietf-moq-msf-02
 */

import { MSFPropertyId, resolveTrackPropertyData } from "../properties";
import type { Property } from "../properties";
import { assertJsonSafeBigInt, toMsfLocationBigInt } from "./json";
import type { EventTimelineEntry, MediaTimelineEntry } from "./types";

// =============================================================================
// Media Timeline encode/decode
// =============================================================================

/**
 * Media Timeline を JSON バイト列にエンコードする (draft-ietf-moq-msf-02 §7.1)
 *
 * bigint は JSON.stringify で扱えないため number に変換する。precision loss となる値は
 * 検出して throw する (自分の出力を自分で decode できないペアを生まない)。
 * gzip 圧縮は draft-02 §12.1 の MSF_COMPRESSION (0x78) で signaling し、
 * `src/msf/compression.ts` の `compressGzip` で圧縮する。本関数は無圧縮 JSON を出力する。
 */
export function encodeMediaTimeline(entries: MediaTimelineEntry[]): Uint8Array {
  const serializable = entries.map(([mediaPts, [groupId, objectId], wallclock], index) => {
    assertJsonSafeBigInt(groupId, `location[0]`, `media timeline entry at index ${index}`);
    assertJsonSafeBigInt(objectId, `location[1]`, `media timeline entry at index ${index}`);
    return [mediaPts, [Number(groupId), Number(objectId)], wallclock];
  });

  const json = JSON.stringify(serializable);
  return new TextEncoder().encode(json);
}

/**
 * JSON バイト列を Media Timeline にデコードする (draft-ietf-moq-msf-02 §7.1)
 *
 * gzip 自動検出は draft-02 §12.1 で MSF_COMPRESSION 経由に統一される予定のため
 * 撤廃した。入力は無圧縮 JSON のみ受理する。Location は MOQT GroupID / ObjectID
 * 由来の unsigned 整数で、JSON 安全範囲外の値は precision loss として throw する。
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
 * Event Timeline を JSON バイト列にエンコードする (draft-ietf-moq-msf-02 §8.2)
 *
 * index reference は大文字 `T` / `L` / `M` である。gzip 圧縮は MSF_COMPRESSION (§12.1)
 * 経由で扱うが、本関数は無圧縮 JSON のみ出力する。
 */
export function encodeEventTimeline(entries: EventTimelineEntry[]): Uint8Array {
  const serializable = entries.map((entry, index) => {
    // decode 側の isEventTimelineEntry と同じ条件を encode でも確かめる。encode が受理した
    // 値を自分の decode が拒否すると、送った payload を購読側が解釈できない
    let indexCount = 0;
    if (entry.T !== undefined) {
      if (typeof entry.T !== "number" || !Number.isFinite(entry.T)) {
        throw new Error(
          `invalid event timeline entry at index ${index}: T must be a finite number per §8.2`,
        );
      }
      indexCount++;
    }
    if (entry.L !== undefined) {
      indexCount++;
    }
    if (entry.M !== undefined) {
      if (typeof entry.M !== "number" || !Number.isFinite(entry.M)) {
        throw new Error(
          `invalid event timeline entry at index ${index}: M must be a finite number per §8.2`,
        );
      }
      indexCount++;
    }
    if (indexCount !== 1) {
      throw new Error(
        `invalid event timeline entry at index ${index}: exactly one of T, L, M must be present per §8.2`,
      );
    }
    if (!("data" in entry) || entry.data === undefined) {
      throw new Error(`invalid event timeline entry at index ${index}: data is required per §8.2`);
    }
    const result: Record<string, unknown> = { data: entry.data };

    if (entry.T !== undefined) {
      result["T"] = entry.T;
    }
    if (entry.L !== undefined) {
      // Location は MOQT GroupID / ObjectID 由来 unsigned 整数。precision loss は encode 時に throw。
      assertJsonSafeBigInt(entry.L[0], "location[0]", `event timeline entry at index ${index}`);
      assertJsonSafeBigInt(entry.L[1], "location[1]", `event timeline entry at index ${index}`);
      result["L"] = [Number(entry.L[0]), Number(entry.L[1])];
    }
    if (entry.M !== undefined) {
      result["M"] = entry.M;
    }

    return result;
  });

  const json = JSON.stringify(serializable);
  return new TextEncoder().encode(json);
}

/**
 * JSON バイト列を Event Timeline にデコードする (draft-ietf-moq-msf-02 §8.2)
 *
 * index reference は大文字 `T` / `L` / `M` だけを受理する。draft-01 の小文字 key は
 * 互換性を維持しないため受理しない。gzip 自動検出は撤廃した (MSF_COMPRESSION 経由)。
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

    const T = obj["T"];
    if (typeof T === "number") {
      result.T = T;
    }

    const L = obj["L"];
    if (Array.isArray(L) && L.length === 2) {
      // §8.2: Location は MOQT GroupID / ObjectID 由来。precision loss / 非整数 / 負数を throw。
      const context = `event timeline entry at index ${index}`;
      result.L = [
        toMsfLocationBigInt(L[0], "location[0]", context),
        toMsfLocationBigInt(L[1], "location[1]", context),
      ];
    }

    const M = obj["M"];
    if (typeof M === "number") {
      result.M = M;
    }

    return result;
  });
}

/**
 * オブジェクトが Event Timeline エントリかどうかを検証する (draft-ietf-moq-msf-02 §8.2)
 *
 * data は必須 (任意の JSON 値)。
 * T (壁時計), L (Location), M (メディア PTS) は index reference で、ちょうど 1 つのみ MUST。
 */
function isEventTimelineEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }

  const obj = entry as Record<string, unknown>;

  if (!("data" in obj) || obj["data"] === undefined) {
    return false;
  }

  const T = obj["T"];
  if (T !== undefined && typeof T !== "number") {
    return false;
  }

  const L = obj["L"];
  if (L !== undefined) {
    if (!Array.isArray(L) || L.length !== 2) {
      return false;
    }
    if (typeof L[0] !== "number" || typeof L[1] !== "number") {
      return false;
    }
  }

  const M = obj["M"];
  if (M !== undefined && typeof M !== "number") {
    return false;
  }

  const indexCount =
    (T !== undefined ? 1 : 0) + (L !== undefined ? 1 : 0) + (M !== undefined ? 1 : 0);
  if (indexCount !== 1) {
    return false;
  }

  return true;
}

// =============================================================================
// Event Timeline header data
// =============================================================================

/**
 * Event Timeline の header data を Track Properties から取り出す
 * (draft-ietf-moq-msf-02 §8.1 / §12.3.1)
 *
 * §8.1: 購読側は payload を解釈する前に `MSF_EVENT_TIMELINE_HEADER` Track property の
 * 有無を確認する MUST がある。property が無い場合は header data が提供されないことを意味する。
 *
 * header の直列化は eventType が定義する。ライブラリは解釈せず、バイト列のまま返す。
 *
 * @param properties - SUBSCRIBE_OK / FETCH_OK / PUBLISH で受け取った Track Properties
 * @returns header data のバイト列。property が無ければ undefined
 */
export function resolveEventTimelineHeader(
  properties: ReadonlyArray<Property>,
): Uint8Array | undefined {
  return resolveTrackPropertyData(properties, MSFPropertyId.MSF_EVENT_TIMELINE_HEADER);
}

// =============================================================================
// Accessible Window Time
// =============================================================================

/**
 * media timeline を accessible window の範囲に絞る (draft-02 §5.2.45 / §7)
 *
 * §5.2.45: The accessibleWindowTime defines a time delta in wallclock milliseconds behind the
 * live edge at which content in this track remains accessible. To calculate the earliest
 * available content, a client would subtract the accessibleWindowTime value from the current
 * wallclock time to give the trailing threshold and then search the appropriate media timeline
 * track for the earliest Group whose wallclock time is greater than this trailing threshold.
 *
 * §7: Subscribers of media timeline tracks MUST apply any Accessible Window Time constraints
 * before attempting to retrieve content based on a media timeline description.
 *
 * wallclock が 0 のエントリ (VOD や wallclock 不明) は判定に使えないため残す。
 *
 * @param entries - media timeline のエントリ列 (media time 順)
 * @param accessibleWindowTime - wallclock ミリ秒の遡り幅
 * @param nowWallclockMs - 現在の wallclock (Unix ms)
 * @returns 閾値以降のエントリ
 */
export function filterMediaTimelineByAccessibleWindow(
  entries: readonly MediaTimelineEntry[],
  accessibleWindowTime: number,
  nowWallclockMs: number,
): MediaTimelineEntry[] {
  const threshold = nowWallclockMs - accessibleWindowTime;
  return entries.filter(([, , wallclock]) => wallclock === 0 || wallclock >= threshold);
}

/**
 * Track Properties から Event Timeline header を解決して payload を decode する
 * (draft-02 §8.1 / §12.3.1)
 *
 * §8.1: Subscribers to an Event Timeline Track MUST check for the presence of this track
 * property before parsing the payload of the event timeline track. Usage of this track
 * property is optional. Absence of the MSF_EVENT_TIMELINE_HEADER Track property indicates that
 * no header data is provided for the Event Timeline Track.
 *
 * MSF_EVENT_TIMELINE_HEADER は Track scope の property であり (0x7B)、SUBSCRIBE_OK などの
 * Track Properties で届く。Object properties には載らない。したがって購読ハンドルが保持する
 * Track Properties を渡す。
 *
 * header の不在は不正ではなく「ヘッダデータなし」を意味する。本関数は header を必ず解決した
 * うえで payload を decode し、解決結果を呼び出し側へ返す (payload の解釈と header の確認を
 * 分離しない)。
 *
 * @param trackProperties - 購読ハンドルが持つ Track Properties
 * @param payload - Object の payload
 * @returns エントリ列と header data (header が無ければ undefined)
 * @throws Error payload が Event Timeline として不正なとき
 */
export function decodeEventTimelineObject(
  trackProperties: ReadonlyArray<Property>,
  payload: Uint8Array,
): { entries: EventTimelineEntry[]; header: Uint8Array | undefined } {
  return {
    entries: decodeEventTimeline(payload),
    header: resolveEventTimelineHeader(trackProperties),
  };
}

// =============================================================================
// URI fragment の range 適用
// =============================================================================

/**
 * media timeline を URI fragment の range で絞る (draft-02 §11.1.1)
 *
 * - `wallclock-range`: wallclock (Unix ms) の inclusive 範囲
 * - `mediatime-range`: media time (ms) の inclusive 範囲
 * - `location-range`: Group ID / Object ID の inclusive 範囲
 *
 * 各 range は union で解釈する (§11.1.1 MUST)。空配列は「その種類の指定なし」であり、
 * 全件を通す。種類をまたぐ場合は AND (すべての種類を満たす) とする。
 *
 * @param entries - media timeline のエントリ列
 * @param ranges - 適用する range。省略した種類は絞らない
 * @returns 条件を満たすエントリ
 */
export function filterMediaTimelineByRanges(
  entries: readonly MediaTimelineEntry[],
  ranges: {
    readonly wallclock?: readonly { readonly start: number; readonly end?: number }[];
    readonly mediaTime?: readonly { readonly start: number; readonly end?: number }[];
    readonly location?: readonly {
      readonly start: { readonly groupId: bigint; readonly objectId?: bigint };
      readonly end?: { readonly groupId: bigint; readonly objectId?: bigint };
    }[];
  },
): MediaTimelineEntry[] {
  const inTimeRange = (
    value: number,
    candidates: readonly { readonly start: number; readonly end?: number }[],
  ): boolean =>
    candidates.some(
      (range) => value >= range.start && (range.end === undefined || value <= range.end),
    );

  const inLocationRange = (
    location: readonly [bigint, bigint],
    candidates: readonly {
      readonly start: { readonly groupId: bigint; readonly objectId?: bigint };
      readonly end?: { readonly groupId: bigint; readonly objectId?: bigint };
    }[],
  ): boolean => {
    const [group, object] = location;
    const compare = (
      candidate: { readonly groupId: bigint; readonly objectId?: bigint },
      target: readonly [bigint, bigint],
    ): number => {
      if (candidate.groupId !== target[0]) {
        return candidate.groupId < target[0] ? -1 : 1;
      }
      // Object ID 省略は Group 全体を指す
      if (candidate.objectId === undefined) {
        return 0;
      }
      return candidate.objectId < target[1] ? -1 : candidate.objectId > target[1] ? 1 : 0;
    };
    return candidates.some(
      (range) =>
        compare(range.start, [group, object]) <= 0 &&
        (range.end === undefined || compare(range.end, [group, object]) >= 0),
    );
  };

  return entries.filter((entry) => {
    const [, location, wallclock] = entry;
    if (ranges.wallclock !== undefined && !inTimeRange(wallclock, ranges.wallclock)) {
      return false;
    }
    if (ranges.mediaTime !== undefined && !inTimeRange(entry[0], ranges.mediaTime)) {
      return false;
    }
    if (ranges.location !== undefined && !inLocationRange(location, ranges.location)) {
      return false;
    }
    return true;
  });
}

/**
 * accessible window を適用した取得開始位置を返す (draft-02 §5.2.45 / §7)
 *
 * §7: Subscribers of media timeline tracks MUST apply any Accessible Window Time constraints
 * before attempting to retrieve content based on a media timeline description.
 *
 * 窓を適用した最初のエントリの Location を取得開始位置とする。エントリが残らない場合は
 * ライブエッジより後ろが取得できないため undefined を返す。
 *
 * @param entries - media timeline のエントリ列 (media time 順)
 * @param track - media timeline の track
 * @param nowWallclockMs - 現在の wallclock (Unix ms)
 * @returns 取得開始位置。窓内にエントリが無ければ undefined
 */
export function resolveAccessibleStart(
  entries: readonly MediaTimelineEntry[],
  track: { readonly accessibleWindowTime?: number },
  nowWallclockMs: number,
): { readonly mediaTime: number; readonly location: readonly [bigint, bigint] } | undefined {
  const filtered =
    track.accessibleWindowTime === undefined
      ? [...entries]
      : filterMediaTimelineByAccessibleWindow(entries, track.accessibleWindowTime, nowWallclockMs);
  const first = filtered[0];
  if (first === undefined) {
    return undefined;
  }
  return { mediaTime: first[0], location: first[1] };
}
