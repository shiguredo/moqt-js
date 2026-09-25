/**
 * catalogRepublishIntervalMs の性質
 *
 * 送り直しの間隔は常に下限以上、上限以下である。MAX_CACHE_DURATION が下限の 2 倍以上なら、
 * relay が catalog を配れなくなる前 (MAX_CACHE_DURATION より前) に送り直す
 * (draft-ietf-moq-transport-21 Section 10.3、draft-ietf-moq-msf-01 Section 5.1)。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  CATALOG_REPUBLISH_MAX_INTERVAL_MS,
  CATALOG_REPUBLISH_MIN_INTERVAL_MS,
  catalogRepublishIntervalMs,
} from "./catalogRepublish";

// MAX_CACHE_DURATION は varint だが、画面の選択肢と JavaScript の安全な整数に収める
const maxCacheDurationArbitrary = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });

test("catalogRepublishIntervalMs: 間隔は下限以上、上限以下である", () => {
  fc.assert(
    fc.property(maxCacheDurationArbitrary, (maxCacheDurationMs) => {
      const interval = catalogRepublishIntervalMs(maxCacheDurationMs);
      assert.isAtLeast(interval, CATALOG_REPUBLISH_MIN_INTERVAL_MS);
      assert.isAtMost(interval, CATALOG_REPUBLISH_MAX_INTERVAL_MS);
      assert.isTrue(Number.isInteger(interval));
    }),
  );
});

test("catalogRepublishIntervalMs: MAX_CACHE_DURATION が下限の 2 倍以上なら、その半分以下で送り直す", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: CATALOG_REPUBLISH_MIN_INTERVAL_MS * 2, max: Number.MAX_SAFE_INTEGER }),
      (maxCacheDurationMs) => {
        const interval = catalogRepublishIntervalMs(maxCacheDurationMs);
        // 期限の半分以下なので、期限が切れる前に次の catalog が cache に入る
        assert.isAtMost(interval, maxCacheDurationMs / 2);
        assert.isBelow(interval, maxCacheDurationMs);
      },
    ),
  );
});
