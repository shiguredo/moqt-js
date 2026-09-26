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
  publishTimingStats,
  newGroupRequestsReceived,
} from "./signals/publisher";
import type { PublishTimingSnapshot } from "./utils/publishTimingStats";
import {
  subscriberInstances,
  type AvSyncSnapshot,
  type SubscriberInstance,
} from "./signals/subscriber";
import { url, certificateHash } from "./signals/connectionSettings";
import type { StatusType } from "./types";
import type { PlaybackTimingSnapshot } from "./utils/playbackTimingStats";

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
  // 符号化 (読んでから encoder の出力まで) と送信 (出力から sendObject の完了まで) の時間、
  // encoder の待ちで捨てたフレームの数 (publishTimingStats.ts)
  publishTiming: PublishTimingSnapshot;
  // 受けた新しい Group の要求 (NEW_GROUP_REQUEST) の数
  newGroupRequests: number;
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
  // Group の順序と欠落で復号せずに捨てた映像フレーム数 (VideoDecodeOrder の理由ごと)
  staleFramesDropped: number;
  missingReferenceFramesDropped: number;
  // 受信から表示までの時間の統計 (utils/playbackTimingStats.ts)。分布は直近 10 秒、
  // 止まりと表示キューのあふれは購読開始からの累積。latencyMs は送信側の壁時計の
  // LOC TIMESTAMP を基準にするため、別のマシンでは時計のずれを含む
  playbackTiming: PlaybackTimingSnapshot;
  // 音声と映像の同期の推定値 (同期ずれ・表示の遅れ・目標遅延・切り下げた分・時計の代用)。
  // 未購読、jitter buffer が無効、音声だけの購読では既定値 (null / null / null / 0 / false)
  avSync: AvSyncSnapshot;
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
  // 受信した音声の鳴らし方の数。基準を取り直した回数と、遅れが上限を超えて捨てた音の数
  audioPlayoutRebases: number;
  audioPlayoutDrops: number;
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
    staleFramesDropped: sub.staleFramesDropped.value,
    missingReferenceFramesDropped: sub.missingReferenceFramesDropped.value,
    playbackTiming: sub.playbackTiming.value,
    avSync: sub.avSync.value,
    decoderState: sub.decoderState.value,
    largestLocation: convertLargestLocation(sub.largestLocation.value),
    audioObjectsReceived: sub.audioObjectsReceived.value,
    audioChunksDecoded: sub.audioChunksDecoded.value,
    audioPeakDbfs: sub.audioPeakDbfs.value,
    audioRmsDbfs: sub.audioRmsDbfs.value,
    audioLastLevel: sub.audioLastLevel.value?.level ?? null,
    audioLastVoiceActivity: sub.audioLastLevel.value?.voiceActivity ?? null,
    audioPlayoutRebases: sub.audioPlayoutRebases.value,
    audioPlayoutDrops: sub.audioPlayoutDrops.value,
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
      publishTiming: publishTimingStats.value.snapshot(performance.now()),
      newGroupRequests: newGroupRequestsReceived.value,
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
