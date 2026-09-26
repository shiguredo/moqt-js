/**
 * テスト用 API
 *
 * Playwright (Python/JavaScript) から統計情報を取得するための
 * window.moqtDevTools グローバルオブジェクトを公開する。
 *
 * 統計の組み立ては signals/statsSnapshot.ts が唯一の実装である。画面の表示と
 * デバッグパネルの「Copy for LLM」も同じスナップショットを読む。
 */

import { buildPublisherStats, buildSubscriberStats } from "./signals/statsSnapshot";
import type { PublisherStats, SubscriberStats } from "./signals/statsSnapshot";
import { subscriberInstances } from "./signals/subscriber";
import { url, certificateHash } from "./signals/connectionSettings";

// 統計の型はテストからも参照するため、ここから再 export する
export type { PublisherStats, SubscriberStats };
export { buildPublisherStats, buildSubscriberStats };

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
 * テスト用 API を初期化して window オブジェクトに公開する
 */
export function initTestApi(): void {
  const api: MoqtDevToolsApi = {
    getPublisher: () => buildPublisherStats(),

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
