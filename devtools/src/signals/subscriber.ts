import { signal, computed } from "@preact/signals";
import type { Session, Subscriber, MoqtObject, Catalog } from "moqt-js";
import type { StatusType } from "../types";
import type { DecoderWrapper } from "../utils/DecoderWrapper";

/**
 * Joining Fetch の統計情報
 */
export interface JoiningFetchStats {
  objectsReceived: number;
  bytesReceived: number;
  completed: boolean;
  /**
   * Joining Fetch 中にバッファされたライブオブジェクト数
   */
  bufferedLiveObjects: number;
}

/**
 * 個々の Subscriber インスタンスの状態
 */
export interface SubscriberInstance {
  id: string;
  session: Session | null;
  subscriber: Subscriber | null;
  catalogSubscriber: Subscriber | null;
  catalog: Catalog | null;
  decoder: DecoderWrapper | null;
  decoderConfigured: boolean;
  status: StatusType;
  statusMessage: string;
  codec: string;
  // 停止処理中フラグ（二重実行防止）
  isStopping: boolean;
  // Joining Fetch 設定
  joiningFetchEnabled: boolean;
  // NEW_GROUP_REQUEST 設定（初回接続時に新しいグループを要求）
  newGroupRequestEnabled: boolean;
  // 統計
  framesDecoded: number;
  keyFramesDecoded: number;
  objectsReceived: number;
  currentGroup: number;
  currentSubGroup: number;
  bytesReceived: number;
  // デコードパイプライン統計
  objectsWithExtensions: number;
  chunksCreated: number;
  chunksDecoded: number;
  chunksSkipped: number;
  decodeErrors: number;
  decoderState: string;
  // Joining Fetch 統計
  joiningFetchStats: JoiningFetchStats | null;
  // largestLocation
  largestLocation: { group: bigint; object: bigint } | null;
  // Joining Fetch 中のライブオブジェクトバッファ
  joiningFetchInProgress: boolean;
  liveObjectBuffer: MoqtObject[];
  // Joining Fetch の最後のオブジェクトの location（重複除去用）
  joiningFetchLastLocation: { group: bigint; object: bigint } | null;
}

/**
 * 新しい Subscriber インスタンスを作成する
 */
export function createSubscriberInstance(id: string): SubscriberInstance {
  return {
    id,
    session: null,
    subscriber: null,
    catalogSubscriber: null,
    catalog: null,
    decoder: null,
    decoderConfigured: false,
    status: "disconnected",
    statusMessage: "Ready to subscribe",
    codec: "",
    isStopping: false,
    joiningFetchEnabled: true,
    newGroupRequestEnabled: false,
    framesDecoded: 0,
    keyFramesDecoded: 0,
    objectsReceived: 0,
    currentGroup: 0,
    currentSubGroup: 0,
    bytesReceived: 0,
    objectsWithExtensions: 0,
    chunksCreated: 0,
    chunksDecoded: 0,
    chunksSkipped: 0,
    decodeErrors: 0,
    decoderState: "unconfigured",
    joiningFetchStats: null,
    largestLocation: null,
    joiningFetchInProgress: false,
    liveObjectBuffer: [],
    joiningFetchLastLocation: null,
  };
}

/**
 * 全ての Subscriber インスタンスを管理する Map
 */
export const subscriberInstances = signal<Map<string, SubscriberInstance>>(new Map());

/**
 * 次の Subscriber ID
 */
let nextSubscriberId = 1;

/**
 * 新しい Subscriber を追加する
 */
export function addSubscriber(): string {
  const id = `subscriber-${nextSubscriberId++}`;
  const instance = createSubscriberInstance(id);
  const newMap = new Map(subscriberInstances.value);
  newMap.set(id, instance);
  subscriberInstances.value = newMap;
  return id;
}

/**
 * Subscriber を削除する
 */
export function removeSubscriber(id: string): void {
  const newMap = new Map(subscriberInstances.value);
  newMap.delete(id);
  subscriberInstances.value = newMap;
}

/**
 * Subscriber インスタンスを更新する
 */
export function updateSubscriber(id: string, updates: Partial<SubscriberInstance>): void {
  const instance = subscriberInstances.value.get(id);
  if (!instance) return;

  const newMap = new Map(subscriberInstances.value);
  newMap.set(id, { ...instance, ...updates });
  subscriberInstances.value = newMap;
}

/**
 * Subscriber インスタンスを取得する
 */
export function getSubscriber(id: string): SubscriberInstance | undefined {
  return subscriberInstances.value.get(id);
}

/**
 * Subscriber ID のリストを取得する computed signal
 */
export const subscriberIds = computed(() => {
  return Array.from(subscriberInstances.value.keys());
});

/**
 * アクティブな Subscriber があるかどうか
 */
export const hasActiveSubscriber = computed(() => {
  for (const instance of subscriberInstances.value.values()) {
    if (instance.subscriber !== null) {
      return true;
    }
  }
  return false;
});
