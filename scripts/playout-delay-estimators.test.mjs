/** 実験用の区間最大値推定器は、境界と忘却を独立して検査する。 */
import { test, assert } from "vite-plus/test";
import { IntervalPeakDelay, SpikeDelayGate } from "./playout-delay-estimators.mjs";

test("区間が終わるまで未確定とし、境界の到着を次の区間へ入れる", () => {
  const estimator = new IntervalPeakDelay();
  estimator.observe(0, 0);
  estimator.observe(499, 31);
  assert.isNull(estimator.delayMs);
  estimator.observe(501, 91);
  assert.equal(estimator.delayMs, 40, "完了した区間の最大 31 ms を 20 ms 幅で切り上げること");
  estimator.observe(1002, 0);
  assert.equal(estimator.delayMs, 100, "次の区間の 91 ms を反映すること");
});

test("一度のピークは即座に忘れず、正常な観測の継続で回復する", () => {
  const estimator = new IntervalPeakDelay();
  estimator.observe(0, 100);
  estimator.observe(501, 0);
  assert.equal(estimator.delayMs, 120);
  for (let index = 2; index < 300; index++) estimator.observe(index * 501, 0);
  assert.equal(estimator.delayMs, 20);
});

test("非有限の到着時刻と遅れで分布を汚さない", () => {
  const estimator = new IntervalPeakDelay();
  estimator.observe(0, 0);
  estimator.observe(Number.NaN, 50);
  estimator.observe(200, Number.NaN);
  estimator.observe(501, 0);
  assert.equal(estimator.delayMs, 20);
});

test("突発的な遅延中は分布を学習せず、遅れが戻れば直ちに通常の推定へ戻す", () => {
  // Moon らの head=4 / tail=2 を使う。相対遅延が 0 でも基準は 1 フレーム分を保つ。
  const gate = new SpikeDelayGate();
  assert.isTrue(gate.observe(10, 0, 20));
  assert.isFalse(gate.active);
  assert.isFalse(gate.observe(180, 10, 20));
  assert.isTrue(gate.active);
  assert.isFalse(gate.observe(60, 10, 20));
  assert.isTrue(gate.observe(40, 10, 20));
  assert.isFalse(gate.active);
  assert.isTrue(gate.observe(60, 10, 20), "通常の 60 ms の揺らぎは次の再発に備えて学習すること");
});
