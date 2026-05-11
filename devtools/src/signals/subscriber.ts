import { signal, computed, type Signal, type ReadonlySignal } from "@preact/signals";
import type { Session, Subscriber, Catalog } from "moqt-js";
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
 * 個々の Subscriber インスタンスの状態。
 *
 * 各フィールドは Signal で保持し、フィールド単位で購読/更新する。
 * `subscriberInstances` Map は要素追加/削除のみで再生成し、フィールド更新では
 * 再生成しない (個別 Signal が再描画を駆動する)。
 * `hasActiveSubscriber` computed は `instance.subscriber.value` を追跡するため
 * Signal 化が必須。
 */
export interface SubscriberInstance {
  // props として親から渡される識別子。再描画駆動には使わないため signal 不要。
  id: string;
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
  // Joining Fetch の最後のオブジェクトの location (重複除去用)
  joiningFetchLastLocation: Signal<{ group: bigint; object: bigint } | null>;
  // Track Properties に DYNAMIC_GROUPS=1 が含まれているかどうか。
  // draft-ietf-moq-transport-17 §9.3.11 により、true のときのみ
  // REQUEST_UPDATE で NEW_GROUP_REQUEST を送信できる。
  dynamicGroupsSupported: Signal<boolean>;
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
    joiningFetchLastLocation: signal<{ group: bigint; object: bigint } | null>(null),
    dynamicGroupsSupported: signal(false),
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
 * 衝突しない subscriber ID を生成する純粋関数。
 *
 * `generator` で短縮 ID 候補を生成し、`existingIds` と衝突したら再試行する。
 * `crypto.randomUUID` を直接置き換えるのではなく `generator` 引数として渡す
 * 設計にすることで、テストでは決定論的なクロージャを渡せる。
 *
 * @param existingIds 既存 ID の集合
 * @param generator 短縮 ID 候補を返す関数 (prefix 付きの完成 ID を返す)
 */
export function generateUniqueSubscriberId(
  existingIds: ReadonlySet<string>,
  generator: () => string,
): string {
  let candidate = generator();
  while (existingIds.has(candidate)) {
    candidate = generator();
  }
  return candidate;
}

// 本番用の短縮 ID 生成関数 (UUID v4 の先頭 8 文字)。
// HMR 時のカウンタ問題を回避するため crypto.randomUUID ベース。
function defaultSubscriberIdGenerator(): string {
  return `subscriber-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * 新しい Subscriber を追加する。
 * 短縮 ID の衝突 (32 bit 空間) が発生した場合に旧 instance が静かに上書きされて
 * WebTransport セッションと VideoDecoder がリークするのを防ぐため、
 * `generateUniqueSubscriberId` で既存 ID との衝突を回避する。
 */
export function addSubscriber(): string {
  const existingIds = new Set(subscriberInstances.value.keys());
  const id = generateUniqueSubscriberId(existingIds, defaultSubscriberIdGenerator);
  const instance = createSubscriberInstance(id);
  const newMap = new Map(subscriberInstances.value);
  newMap.set(id, instance);
  subscriberInstances.value = newMap;
  return id;
}

/**
 * Subscriber を削除する。
 *
 * Map 削除契機での外部リソース close 責務を集約する。
 * `useSubscriber.ts:cleanupSubscriber` と順序を揃えて decoder → session の順で
 * fire-and-forget close する。close 完了は待たない。
 *
 * `Session.close` / `DecoderWrapper.close` は冪等で二重実行は no-op のため、
 * `cleanupSubscriber` 経由の close と二重発火しても実害はない。
 */
export function removeSubscriber(id: string): void {
  const instance = getSubscriber(id);
  if (instance) {
    try {
      instance.decoder.value?.close();
    } catch {
      // 既にクローズ済みなら無視
    }
    instance.session.value?.close().catch(() => {
      // 既にクローズ済みなら無視
    });
  }
  const newMap = new Map(subscriberInstances.value);
  newMap.delete(id);
  subscriberInstances.value = newMap;
  // Map 差し替えで cached `computed` が undefined への変化通知を発火させた後に
  // キャッシュエントリを削除する。逆順では undefined 通知が壊れる。
  subscriberInstanceSignalCache.delete(id);
}

/**
 * Subscriber インスタンスを取得する
 */
export function getSubscriber(id: string): SubscriberInstance | undefined {
  return subscriberInstances.value.get(id);
}

/**
 * ID ごとの派生 `ReadonlySignal` キャッシュ。
 *
 * `subscriberInstances` Map 全体を購読せず、対象 ID の `SubscriberInstance`
 * 参照変化だけを通知する派生 signal を提供するためのキャッシュ。
 * テスト用にキャッシュ状態を観測できるよう export している。
 */
export const subscriberInstanceSignalCache = new Map<
  string,
  ReadonlySignal<SubscriberInstance | undefined>
>();

/**
 * 特定 ID 用の派生 `ReadonlySignal` を返す。
 *
 * `computed` の参照等値比較により、対象 ID の instance 参照が変わらない限り
 * 下流購読者には通知されない。Subscriber の追加・削除で Map 参照が
 * 差し替わっても、対象 ID 自身の instance が変化していなければ
 * `SubscriberPanel` の再評価は発生しない。
 *
 * https://github.com/preactjs/signals
 */
export function getSubscriberInstanceSignal(
  id: string,
): ReadonlySignal<SubscriberInstance | undefined> {
  let cached = subscriberInstanceSignalCache.get(id);
  if (cached === undefined) {
    cached = computed(() => subscriberInstances.value.get(id));
    subscriberInstanceSignalCache.set(id, cached);
  }
  return cached;
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
