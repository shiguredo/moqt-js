/**
 * MOQT Namespace / TrackStatus 状態管理ヘルパー
 * draft-ietf-moq-transport-17 Section 6, 9.16-9.21
 */

import { NamespaceSubscribeMode, type TrackNamespace } from "../message";
import type {
  NamespacePublicationEntry,
  NamespaceSubscribeOptions,
  NamespaceSubscriptionEntry,
  TrackRole,
  TrackStatusEntry,
} from "./types";

/**
 * Wire 上の NamespaceSubscribeMode を内部 NamespaceSubscribeOptions に変換する
 * draft-ietf-moq-transport-17 Section 9.20 (SUBSCRIBE_NAMESPACE)
 */
export function namespaceSubscribeOptionsFromMode(
  mode: NamespaceSubscribeMode,
): NamespaceSubscribeOptions {
  switch (mode) {
    case NamespaceSubscribeMode.PUBLISH:
      return "publishOnly";
    case NamespaceSubscribeMode.NAMESPACE:
      return "namespaceOnly";
    case NamespaceSubscribeMode.BOTH:
      return "both";
  }
}

export function createNamespacePublicationEntry(params: {
  requestId: bigint;
  myRole: TrackRole;
  trackNamespace: TrackNamespace;
}): NamespacePublicationEntry {
  return {
    requestId: params.requestId,
    myRole: params.myRole,
    trackNamespace: params.trackNamespace,
    state: "pending",
  };
}

export function createNamespaceSubscriptionEntry(params: {
  requestId: bigint;
  myRole: TrackRole;
  prefix: TrackNamespace;
  options: NamespaceSubscribeOptions;
}): NamespaceSubscriptionEntry {
  return {
    requestId: params.requestId,
    myRole: params.myRole,
    prefix: params.prefix,
    options: params.options,
    state: "pending",
  };
}

export function createTrackStatusEntry(params: {
  requestId: bigint;
  myRole: TrackRole;
  trackNamespace: TrackNamespace;
  trackName: Uint8Array;
}): TrackStatusEntry {
  return {
    requestId: params.requestId,
    myRole: params.myRole,
    trackNamespace: params.trackNamespace,
    trackName: params.trackName,
    state: "pending",
  };
}
