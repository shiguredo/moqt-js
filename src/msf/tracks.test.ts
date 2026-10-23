/**
 * `targetLatency` の解決の単体テスト
 *
 * catalog の `targetLatency` は Number とだけ定められており (draft-ietf-moq-msf-01
 * §5.2.8)、負や非有限の値が来ても購読を失敗させない。`isLive` が false のトラックの値は
 * 無視する MUST。
 */

import { assert, test } from "vite-plus/test";
import { effectiveTargetLatencyMs } from "./tracks";
import type { CatalogTrack } from "./types";

/** targetLatency の解決にだけ使う最小のトラック */
function makeTrack(isLive: boolean, targetLatency?: number): CatalogTrack {
  return { isLive, targetLatency } as unknown as CatalogTrack;
}

test("effectiveTargetLatencyMs: 生きたトラックの宣言をそのまま使う", () => {
  assert.strictEqual(effectiveTargetLatencyMs(makeTrack(true, 100)), 100);
  assert.strictEqual(effectiveTargetLatencyMs(makeTrack(true, 0)), 0);
});

test("effectiveTargetLatencyMs: 宣言が無ければ null", () => {
  assert.isNull(effectiveTargetLatencyMs(makeTrack(true)));
});

test("effectiveTargetLatencyMs: isLive が false のトラックは無視する", () => {
  // draft-ietf-moq-msf-01 §5.2.8 の MUST
  assert.isNull(effectiveTargetLatencyMs(makeTrack(false, 100)));
});

test("effectiveTargetLatencyMs: 負や非有限は宣言なしとして扱う", () => {
  // 負の遅れは作れない。ここで null にしないと、入口の setTargetLatencyMs の検証で
  // start 全体が失敗する (旧実装は timeline が受理していた)
  assert.isNull(effectiveTargetLatencyMs(makeTrack(true, -1)));
  assert.isNull(effectiveTargetLatencyMs(makeTrack(true, Number.NaN)));
  assert.isNull(effectiveTargetLatencyMs(makeTrack(true, Number.POSITIVE_INFINITY)));
});
