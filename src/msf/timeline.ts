/**
 * Media Timeline / Event Timeline の encode / decode (draft-ietf-moq-msf-02 §7.1 / §8.1)
 *
 * gzip 圧縮は draft-02 §12.1 の MSF_COMPRESSION 経由で扱うが、MSF_COMPRESSION の
 * Property ID が §14.3 で IANA 未割当 (TBD) のため未実装であり、本モジュールは
 * 無圧縮 JSON のみを出力する。
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
 * gzip 圧縮は draft-02 §12.1 の MSF_COMPRESSION 経由で扱うが、MSF_COMPRESSION の
 * Property ID が §14.3 で IANA 未割当 (TBD) のため未実装であり、本関数は無圧縮 JSON
 * のみ出力する。
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
