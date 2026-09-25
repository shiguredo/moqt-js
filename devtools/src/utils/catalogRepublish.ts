/**
 * catalog を送り直す間隔
 *
 * draft-ietf-moq-msf-01 Section 5.1: "A catalog object SHOULD be published only when the
 * availability of tracks changes, or after a period of time has passed such that the
 * catalog object might fall out of cache in a delivery network."
 *
 * draft-ietf-moq-transport-21 Section 10.3: relay は MAX_CACHE_DURATION を過ぎた Object を
 * cache から配ってはならない (MUST NOT)。MAX_CACHE_DURATION が無くても、実装の制約で
 * 捨てうる ("until implementation constraints cause them to be evicted")。
 *
 * catalog を配信の開始時にしか送らないと、catalog が relay の cache から落ちた後に購読を
 * 始めた相手は catalog を得られない。catalog の MAX_CACHE_DURATION の半分ごとに送り直す。
 * 草案の改訂でこの規定が変わる可能性がある。
 */

/**
 * 送り直しの間隔の下限 (ミリ秒)
 *
 * MAX_CACHE_DURATION が 0 (no cache) か小さいとき、relay は catalog を cache から配れず、
 * 後から購読を始めた相手は live で届く catalog を待つ。devtools の subscriber の catalog の
 * 待ち (既定 5 秒) より十分短くし、0 ms の繰り返しで送り続けないようにする
 */
export const CATALOG_REPUBLISH_MIN_INTERVAL_MS = 1_000;

/**
 * 送り直しの間隔の上限 (ミリ秒)
 *
 * relay は MAX_CACHE_DURATION の前でも実装の制約で catalog を捨てうる。catalog が cache に
 * 無い時間を抑える
 */
export const CATALOG_REPUBLISH_MAX_INTERVAL_MS = 30_000;

/**
 * catalog の MAX_CACHE_DURATION (ミリ秒) から、catalog を送り直す間隔 (ミリ秒) を決める
 *
 * 期限の半分とし、下限と上限に収める。
 */
export function catalogRepublishIntervalMs(maxCacheDurationMs: number): number {
  if (!Number.isInteger(maxCacheDurationMs) || maxCacheDurationMs < 0) {
    throw new Error(
      `maxCacheDurationMs must be a non-negative integer, got ${String(maxCacheDurationMs)}`,
    );
  }
  const half = Math.floor(maxCacheDurationMs / 2);
  return Math.min(
    CATALOG_REPUBLISH_MAX_INTERVAL_MS,
    Math.max(CATALOG_REPUBLISH_MIN_INTERVAL_MS, half),
  );
}
