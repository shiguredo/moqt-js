/**
 * MOQT Fetch 状態管理ヘルパー
 * draft-ietf-moq-transport-17 Section 5.2, 9.14, 9.15
 */

import { type Fetch, FetchType } from "../message";
import type { FetchEntry, FetchKind, TrackRole } from "./types";

/**
 * Fetch メッセージの FetchType から FetchKind を求める
 * draft-ietf-moq-transport-17 Section 9.14 (FETCH)
 */
export function fetchKindFromWire(type: FetchType): FetchKind {
  switch (type) {
    case FetchType.STANDALONE:
      return "standalone";
    case FetchType.RELATIVE_JOINING:
      return "relativeJoining";
    case FetchType.ABSOLUTE_JOINING:
      return "absoluteJoining";
  }
}

/**
 * Fetch メッセージから FetchEntry を新規作成する
 */
export function createFetchEntry(msg: Fetch, myRole: TrackRole): FetchEntry {
  const kind = fetchKindFromWire(msg.fetchType);
  const standalone = msg.standalone;
  const joining = msg.joining;
  return {
    requestId: msg.requestId,
    kind,
    myRole,
    trackNamespace: standalone?.trackNamespace ?? null,
    trackName: standalone?.trackName ?? null,
    standaloneRange:
      standalone !== undefined
        ? { start: standalone.startLocation, end: standalone.endLocation }
        : null,
    joining:
      joining !== undefined
        ? {
            joiningRequestId: joining.joiningRequestId,
            joiningStart: joining.joiningStart,
          }
        : null,
    state: "pending",
    endLocation: null,
    endOfTrack: false,
  };
}
