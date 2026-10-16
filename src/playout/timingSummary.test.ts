import { test, assert } from "vite-plus/test";
import { summarizeTimings } from "./timingSummary";

// 完了条件: 百分位は nearest-rank 法で求める (値を昇順に並べて ceil(p * n) 番目)。
// 1 から 100 の 100 個なら p50 は 50、p95 は 95、max は 100 になる。映像と音声の時間の
// 統計で同じ求め方を使うため、ここで固定する
test("summarizeTimings: nearest-rank 法で p50 / p95 / max を求める", () => {
  const values = Array.from({ length: 100 }, (_, index) => 100 - index);
  assert.deepEqual(summarizeTimings(values), { p50: 50, p95: 95, max: 100 });
});

// 完了条件: 値が 1 個なら 3 つとも同じ値、値が無ければ null を返す
test("summarizeTimings: 1 個なら p50 / p95 / max はその値、空なら null", () => {
  assert.deepEqual(summarizeTimings([7]), { p50: 7, p95: 7, max: 7 });
  assert.isNull(summarizeTimings([]));
});

// 完了条件: 与えた配列を書き換えない (呼び出し側が窓の値を持ち続けるため)
test("summarizeTimings: 渡した配列を並べ替えない", () => {
  const values = [3, 1, 2];
  summarizeTimings(values);
  assert.deepEqual(values, [3, 1, 2]);
});
