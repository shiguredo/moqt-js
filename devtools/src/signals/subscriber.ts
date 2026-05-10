import { signal, computed, type Signal } from "@preact/signals";
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
 *
 * 各フィールドは Signal で保持し、フィールド単位で購読/更新する。
 * Map の subscriberInstances は要素追加/削除のみで再生成し、
 * フィールド更新では再生成しない (個別 Signal が再描画を駆動する)。
 */
export interface SubscriberInstance {
  // 不変フィールド (signal 不要)
  id: string;
  // 参照フィールド (publisher と揃えるため signal 化)
  session: Signal<Session | null>;
  subscriber: Signal<Subscriber | null>;
  catalogSubscriber: Signal<Subscriber | null>;
  catalog: Signal<Catalog | null>;
  decoder: Signal<DecoderWrapper | null>;
  // 状態フィールド
  decoderConfigured: Signal<boolean>;
  status: Signal<StatusType>;
  statusMessage: Signal<string>;
  codec: Signal<string>;
  // 停止処理中フラグ (二重実行防止)
  isStopping: Signal<boolean>;
  // Joining Fetch 設定
  joiningFetchEnabled: Signal<boolean>;
  // NEW_GROUP_REQUEST 設定 (初回接続時に新しいグループを要求)
  newGroupRequestEnabled: Signal<boolean>;
  // 統計
  framesDecoded: Signal<number>;
  keyFramesDecoded: Signal<number>;
  objectsReceived: Signal<number>;
  currentGroup: Signal<number>;
  currentSubGroup: Signal<number>;
  bytesReceived: Signal<number>;
  // デコードパイプライン統計
  objectsWithExtensions: Signal<number>;
  chunksCreated: Signal<number>;
  chunksDecoded: Signal<number>;
  chunksSkipped: Signal<number>;
  decodeErrors: Signal<number>;
  decoderState: Signal<string>;
  // Joining Fetch 統計
  joiningFetchStats: Signal<JoiningFetchStats | null>;
  // largestLocation
  largestLocation: Signal<{ group: bigint; object: bigint } | null>;
  // Joining Fetch 中のライブオブジェクトバッファ
  joiningFetchInProgress: Signal<boolean>;
  liveObjectBuffer: Signal<MoqtObject[]>;
  // Joining Fetch の最後のオブジェクトの location (重複除去用)
  joiningFetchLastLocation: Signal<{ group: bigint; object: bigint } | null>;
}

/**
 * 新しい Subscriber インスタンスを作成する
 */
export function createSubscriberInstance(id: string): SubscriberInstance {
  return {
    id,
    session: signal<Session | null>(null),
    subscriber: signal<Subscriber | null>(null),
    catalogSubscriber: signal<Subscriber | null>(null),
    catalog: signal<Catalog | null>(null),
    decoder: signal<DecoderWrapper | null>(null),
    decoderConfigured: signal(false),
    status: signal<StatusType>("disconnected"),
    statusMessage: signal("Ready to subscribe"),
    codec: signal(""),
    isStopping: signal(false),
    joiningFetchEnabled: signal(true),
    newGroupRequestEnabled: signal(false),
    framesDecoded: signal(0),
    keyFramesDecoded: signal(0),
    objectsReceived: signal(0),
    currentGroup: signal(0),
    currentSubGroup: signal(0),
    bytesReceived: signal(0),
    objectsWithExtensions: signal(0),
    chunksCreated: signal(0),
    chunksDecoded: signal(0),
    chunksSkipped: signal(0),
    decodeErrors: signal(0),
    decoderState: signal("unconfigured"),
    joiningFetchStats: signal<JoiningFetchStats | null>(null),
    largestLocation: signal<{ group: bigint; object: bigint } | null>(null),
    joiningFetchInProgress: signal(false),
    liveObjectBuffer: signal<MoqtObject[]>([]),
    joiningFetchLastLocation: signal<{ group: bigint; object: bigint } | null>(null),
  };
}

/**
 * 全ての Subscriber インスタンスを管理する Map
 *
 * Map は要素追加/削除のみで再生成する。インスタンス内のフィールド更新では再生成しない
 * (フィールド単位の Signal で再描画を駆動する)。
 */
export const subscriberInstances = signal<Map<string, SubscriberInstance>>(new Map());

/**
 * 新しい Subscriber を追加する
 *
 * UUID v4 の先頭 8 文字を使った短縮 ID を生成する。devtools 内部識別子としての衝突
 * リスクは十分に低い。HMR でモジュールが再評価された際にカウンタを引き継いで歯抜け
 * 番号が発生する問題を回避する目的。
 * `crypto.randomUUID()` は WebTransport の Secure Context 要件 (HTTPS / localhost)
 * の範囲で常に利用可能なためフォールバックは設けない。
 */
export function addSubscriber(): string {
  const id = `subscriber-${crypto.randomUUID().slice(0, 8)}`;
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
    if (instance.subscriber.value !== null) {
      return true;
    }
  }
  return false;
});
