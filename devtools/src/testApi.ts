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
import { subscriberInstances, type SubscriberInstance } from "./signals/subscriber";
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
  // 音声トラックの受信数とデコード数 (catalog に音声トラックが無いときは 0 のまま)
  audioObjectsReceived: number;
  audioChunksDecoded: number;
  // 復号した音声のレベル (dBFS)。まだ復号していないときは null
  audioPeakDbfs: number | null;
  audioRmsDbfs: number | null;
  // 直近に受信した object の LOC Audio Level (-dBov) と voice activity。
  // Audio Level が載っていない object を受けたときは null
  audioLastLevel: number | null;
  audioLastVoiceActivity: boolean | null;
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
 * Subscriber インスタンスの統計を公開用の形に変換する
 *
 * 一覧 (getSubscribers) と単数 (getSubscriber) で同じ形を返すため 1 箇所にまとめる。
 */
export function buildSubscriberStats(sub: SubscriberInstance): SubscriberStats {
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
    audioObjectsReceived: sub.audioObjectsReceived.value,
    audioChunksDecoded: sub.audioChunksDecoded.value,
    audioPeakDbfs: sub.audioPeakDbfs.value,
    audioRmsDbfs: sub.audioRmsDbfs.value,
    audioLastLevel: sub.audioLastLevel.value?.level ?? null,
    audioLastVoiceActivity: sub.audioLastLevel.value?.voiceActivity ?? null,
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
      Array.from(subscriberInstances.value.values()).map((sub) => buildSubscriberStats(sub)),

    getSubscriber: (id: string) => {
      const sub = subscriberInstances.value.get(id);
      return sub ? buildSubscriberStats(sub) : null;
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
