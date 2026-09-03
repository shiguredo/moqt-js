/**
 * テスト用 API
 *
 * Playwright (Python/JavaScript) から統計情報を取得するための
 * window.moqtDevTools グローバルオブジェクトを公開する
 */

import {
  framesEncoded,
  keyFramesEncoded,
  objectsSent,
  pubCurrentGroup,
  bytesSent,
  encoderState,
  pubStatus,
  objectsWithExtensions as pubObjectsWithExtensions,
} from "./signals/publisher";
import { subscriberInstances } from "./signals/subscriber";
import { url, certificateHash } from "./signals/connectionSettings";
import type { StatusType } from "./types";

/**
 * Publisher の統計情報
 */
export interface PublisherStats {
  status: StatusType;
  serverUrl: string;
  framesEncoded: number;
  keyFramesEncoded: number;
  objectsSent: number;
  currentGroup: number;
  bytesSent: number;
  encoderState: string;
  objectsWithExtensions: number;
}

/**
 * Subscriber の統計情報
 */
export interface SubscriberStats {
  id: string;
  status: StatusType;
  framesDecoded: number;
  keyFramesDecoded: number;
  objectsReceived: number;
  currentGroup: number;
  currentSubGroup: number;
  bytesReceived: number;
  objectsWithExtensions: number;
  decoderState: string;
  largestLocation: { group: string; object: string } | null;
}

/**
 * 接続設定
 */
export interface ConnectionSettings {
  serverUrl: string;
  certificateHash: string;
}

/**
 * テスト用 API インターフェース
 */
export interface MoqtDevToolsApi {
  getPublisher(): PublisherStats;
  getSubscribers(): SubscriberStats[];
  getSubscriber(id: string): SubscriberStats | null;
  getConnection(): ConnectionSettings;
}

/**
 * bigint を文字列に変換する
 * (JSON シリアライズで bigint はエラーになるため)
 */
function convertLargestLocation(
  location: { group: bigint; object: bigint } | null,
): { group: string; object: string } | null {
  if (location === null) {
    return null;
  }
  return {
    group: location.group.toString(),
    object: location.object.toString(),
  };
}

/**
 * テスト用 API を初期化して window オブジェクトに公開する
 */
export function initTestApi(): void {
  const api: MoqtDevToolsApi = {
    getPublisher: () => ({
      status: pubStatus.value,
      serverUrl: url.value,
      framesEncoded: framesEncoded.value,
      keyFramesEncoded: keyFramesEncoded.value,
      objectsSent: objectsSent.value,
      currentGroup: pubCurrentGroup.value,
      bytesSent: bytesSent.value,
      encoderState: encoderState.value,
      objectsWithExtensions: pubObjectsWithExtensions.value,
    }),

    getSubscribers: () =>
      Array.from(subscriberInstances.value.values()).map((sub) => ({
        id: sub.id,
        status: sub.status.value,
        framesDecoded: sub.framesDecoded.value,
        keyFramesDecoded: sub.keyFramesDecoded.value,
        objectsReceived: sub.objectsReceived.value,
        currentGroup: sub.currentGroup.value,
        currentSubGroup: sub.currentSubGroup.value,
        bytesReceived: sub.bytesReceived.value,
        objectsWithExtensions: sub.objectsWithExtensions.value,
        decoderState: sub.decoderState.value,
        largestLocation: convertLargestLocation(sub.largestLocation.value),
      })),

    getSubscriber: (id: string) => {
      const sub = subscriberInstances.value.get(id);
      if (!sub) {
        return null;
      }
      return {
        id: sub.id,
        status: sub.status.value,
        framesDecoded: sub.framesDecoded.value,
        keyFramesDecoded: sub.keyFramesDecoded.value,
        objectsReceived: sub.objectsReceived.value,
        currentGroup: sub.currentGroup.value,
        currentSubGroup: sub.currentSubGroup.value,
        bytesReceived: sub.bytesReceived.value,
        objectsWithExtensions: sub.objectsWithExtensions.value,
        decoderState: sub.decoderState.value,
        largestLocation: convertLargestLocation(sub.largestLocation.value),
      };
    },

    getConnection: () => ({
      serverUrl: url.value,
      certificateHash: certificateHash.value,
    }),
  };

  (window as unknown as { moqtDevTools: MoqtDevToolsApi }).moqtDevTools = api;
}

declare global {
  interface Window {
    moqtDevTools: MoqtDevToolsApi;
  }
}
