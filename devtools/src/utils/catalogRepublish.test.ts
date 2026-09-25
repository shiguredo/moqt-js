/**
 * catalogRepublishIntervalMs の単体テスト: 境界の値
 *
 * draft-ietf-moq-msf-01 Section 5.1: catalog は配信網の cache から落ちうる時間が過ぎたら
 * publish し直す (SHOULD)。draft-ietf-moq-transport-21 Section 10.3: relay は
 * MAX_CACHE_DURATION を過ぎた Object を cache から配ってはならない (MUST NOT)。
 * 一般の値の性質は catalogRepublish.prop.ts で確かめる。
 */

import { test, assert } from "vite-plus/test";
import {
  CATALOG_REPUBLISH_MAX_INTERVAL_MS,
  CATALOG_REPUBLISH_MIN_INTERVAL_MS,
  catalogRepublishIntervalMs,
} from "./catalogRepublish";

// MAX_CACHE_DURATION が 0 (no cache) のとき、relay は catalog を cache から配れない。
// 後から購読を始めた相手は live で届く catalog を待つため、下限の間隔で送り直す。
// 0 ms の繰り返しにはしない
test("catalogRepublishIntervalMs: MAX_CACHE_DURATION が 0 なら下限の間隔にする", () => {
  assert.equal(catalogRepublishIntervalMs(0), CATALOG_REPUBLISH_MIN_INTERVAL_MS);
});

// 画面で選べる最短 (10 秒) では、期限の半分の 5 秒ごとに送り直す
test("catalogRepublishIntervalMs: MAX_CACHE_DURATION が 10 秒なら 5 秒ごとに送り直す", () => {
  assert.equal(catalogRepublishIntervalMs(10_000), 5_000);
});

// 半分が下限を下回る値 (1 ミリ秒から 2 秒未満) は下限に揃える
test("catalogRepublishIntervalMs: 半分が下限を下回るときは下限にする", () => {
  assert.equal(catalogRepublishIntervalMs(1), CATALOG_REPUBLISH_MIN_INTERVAL_MS);
  assert.equal(catalogRepublishIntervalMs(1_999), CATALOG_REPUBLISH_MIN_INTERVAL_MS);
  assert.equal(catalogRepublishIntervalMs(2_000), CATALOG_REPUBLISH_MIN_INTERVAL_MS);
});

// 既定 (10 分) では、期限より前でも relay が捨てうるため上限の 30 秒ごとに送り直す
test("catalogRepublishIntervalMs: MAX_CACHE_DURATION が既定の 10 分なら上限の間隔にする", () => {
  assert.equal(catalogRepublishIntervalMs(600_000), CATALOG_REPUBLISH_MAX_INTERVAL_MS);
  assert.equal(catalogRepublishIntervalMs(60_000), CATALOG_REPUBLISH_MAX_INTERVAL_MS);
});

// 負の値と整数でない値は MAX_CACHE_DURATION として送れない (varint)。呼び出しの誤りとして扱う
test("catalogRepublishIntervalMs: 負の値と整数でない値は例外にする", () => {
  assert.throws(() => catalogRepublishIntervalMs(-1), /maxCacheDurationMs/);
  assert.throws(() => catalogRepublishIntervalMs(1.5), /maxCacheDurationMs/);
  assert.throws(() => catalogRepublishIntervalMs(Number.NaN), /maxCacheDurationMs/);
});
