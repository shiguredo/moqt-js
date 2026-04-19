/**
 * MOQT Subscription 状態管理ヘルパー
 * draft-ietf-moq-transport-17 Section 5.1 (Subscriptions), 9.8-9.13
 */

import {
  getParameterVarintValue,
  type Parameter,
  type TrackNamespace,
  VersionSpecificParameterType,
} from "../message";
import type { SubscriptionEntry, TrackRole } from "./types";

/**
 * FORWARD パラメータから Forward State を抽出する
 * draft-ietf-moq-transport-17 Section 9.3.10 (FORWARD Parameter)
 *
 * 省略時 1 (forward)、0 → 0、それ以外は 1 (default)。
 */
export function extractForwardState(parameters: Parameter[]): 0 | 1 {
  const param = parameters.find((p) => p.type === VersionSpecificParameterType.FORWARD);
  if (param === undefined) return 1;
  const value = getParameterVarintValue(param);
  return value === 0n ? 0 : 1;
}

/**
 * subscriptions_by_track の Map キーを生成する
 *
 * TrackNamespace の各要素と TrackName を hex 化して連結する。
 * role ごとに分離された空間でユニークになる。
 */
export function subscriptionKey(
  trackNamespace: TrackNamespace,
  trackName: Uint8Array,
  role: TrackRole,
): string {
  const nsHex = trackNamespace.tuple.map(bytesToHex).join(":");
  const nameHex = bytesToHex(trackName);
  return `${role}|${nsHex}|${nameHex}`;
}

function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (let i = 0; i < bytes.length; i++) {
    result += bytes[i].toString(16).padStart(2, "0");
  }
  return result;
}

/**
 * Subscription エントリを新規作成する
 */
export function createSubscriptionEntry(params: {
  requestId: bigint;
  initiator: SubscriptionEntry["initiator"];
  myRole: TrackRole;
  trackNamespace: TrackNamespace;
  trackName: Uint8Array;
  trackAlias: bigint | null;
  forwardState: 0 | 1;
}): SubscriptionEntry {
  return {
    requestId: params.requestId,
    initiator: params.initiator,
    myRole: params.myRole,
    trackNamespace: params.trackNamespace,
    trackName: params.trackName,
    trackAlias: params.trackAlias,
    state: params.initiator === "subscriber" ? "pendingSubscriber" : "pendingPublisher",
    forwardState: params.forwardState,
    largestLocation: null,
  };
}
