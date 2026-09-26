import { buildDebugExportText } from "../utils/debugExportText";
import { maskC4mValue } from "../utils/c4m";
import { buildConnectionSettingsSnapshot } from "./connectionSettingsSnapshot";
import { getLogBuffer } from "./debugLog";
import { buildPublisherStats, buildSubscriberStats, type PublisherStats } from "./statsSnapshot";
import { getSubscriber, subscriberInstances } from "./subscriber";

/**
 * 「Copy for LLM」のテキストを現在の状態から組み立てる
 *
 * 統計と接続設定はスナップショット (`statsSnapshot.ts` /
 * `connectionSettingsSnapshot.ts`) から読み、整形は `utils/debugExportText.ts` が行う。
 * ここは「どの節を出すか」だけを決める。
 *
 * 最後に本文全体の c4m (認可トークン) を伏せる。設定の節だけでなく、統計の節の
 * `serverUrl` のように同じ Relay URI が別の節からも入るため、節ごとではなく
 * テキスト全体に対して行う。
 */

/**
 * Publisher の統計を出すかどうか
 *
 * 起動したまま何も配信していないページでは、全て 0 の統計を出しても読む側の
 * 役に立たないため節ごと省く。配信を始めたか、Catalog を送ったことがあれば出す。
 */
function isPublisherUsed(stats: PublisherStats): boolean {
  return (
    stats.status !== "disconnected" ||
    stats.codec !== "" ||
    stats.framesEncoded > 0 ||
    stats.catalog !== null
  );
}

/** 全節 (接続設定・publisher・全 subscriber・ログ) のテキストを組み立てる */
export function buildAllExportText(): string {
  const publisher = buildPublisherStats();
  return maskC4mValue(
    buildDebugExportText({
      connection: buildConnectionSettingsSnapshot(),
      publisher: isPublisherUsed(publisher) ? publisher : null,
      subscribers: Array.from(subscriberInstances.value.values()).map((sub) =>
        buildSubscriberStats(sub),
      ),
      logs: getLogBuffer(),
    }),
  );
}

/** Publisher のログをコピーするためのテキストを組み立てる */
export function buildPublisherExportText(): string {
  const publisher = buildPublisherStats();
  return maskC4mValue(
    buildDebugExportText({
      connection: buildConnectionSettingsSnapshot(),
      publisher: isPublisherUsed(publisher) ? publisher : null,
      subscribers: [],
      logs: getLogBuffer(),
      filter: "[publisher]",
    }),
  );
}

/**
 * 1 つの Subscriber のログをコピーするためのテキストを組み立てる
 *
 * Subscriber が見つからない場合は接続設定とログだけになる。
 */
export function buildSubscriberExportText(subscriberId: string): string {
  const subscriber = getSubscriber(subscriberId);
  return maskC4mValue(
    buildDebugExportText({
      connection: buildConnectionSettingsSnapshot(),
      publisher: null,
      subscribers: subscriber === undefined ? [] : [buildSubscriberStats(subscriber)],
      logs: getLogBuffer(),
      filter: `[${subscriberId}]`,
    }),
  );
}
