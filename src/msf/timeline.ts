/**
 * Media Timeline / Event Timeline の encode / decode (draft-ietf-moq-msf-01 §7.1 / §8.1)
 *
 * gzip 圧縮は draft-01 §12.1 の MSF_COMPRESSION 経由で扱うため、本モジュールは
 * 無圧縮 JSON のみを出力する。
 *
 * 参照: draft-ietf-moq-msf-01
 */

import { assertJsonSafeBigInt, toMsfLocationBigInt } from "./json";
import type { EventTimelineEntry, MediaTimelineEntry } from "./types";

// =============================================================================
// Media Timeline encode/decode
// =============================================================================

/**
 * Media Timeline を JSON バイト列にエンコードする (draft-ietf-moq-msf-01 §7.1)
 *
 * bigint は JSON.stringify で扱えないため number に変換する。precision loss となる値は
 * 検出して throw する (自分の出力を自分で decode できないペアを生まない)。
 * gzip 圧縮は draft-01 §12.1 の MSF_COMPRESSION 経由で別 issue 対応のため、
 * 本関数は無圧縮 JSON のみ出力する。
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
 * JSON バイト列を Media Timeline にデコードする (draft-ietf-moq-msf-01 §7.1)
 *
 * gzip 自動検出は draft-01 §12.1 で MSF_COMPRESSION 経由に統一される予定のため
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
 * Event Timeline を JSON バイト列にエンコードする (draft-ietf-moq-msf-01 §8.1)
 *
 * gzip 圧縮は MSF_COMPRESSION (§12.1) 経由で別 issue 対応のため、本関数は
 * 無圧縮 JSON のみ出力する。
 */
export function encodeEventTimeline(entries: EventTimelineEntry[]): Uint8Array {
  const serializable = entries.map((entry, index) => {
    const result: Record<string, unknown> = { data: entry.data };

    if (entry.t !== undefined) {
      result["t"] = entry.t;
    }
    if (entry.l !== undefined) {
      // Location は MOQT GroupID / ObjectID 由来 unsigned 整数。precision loss は encode 時に throw。
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
 * gzip 自動検出は撤廃した (MSF_COMPRESSION 経由に統一予定)。
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
      // §8.1: Location は MOQT GroupID / ObjectID 由来。precision loss / 非整数 / 負数を throw。
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
