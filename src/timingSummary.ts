/**
 * 値の分布の要約 (p50 / p95 / max)
 *
 * 受信から表示までの時間の統計 (devtools の `utils/playbackTimingStats.ts`) と、音声の
 * 再生の観測 (`audioPlayoutTimingStats.ts`) が共通で使う。どちらも「直近の窓の値が
 * どこに集まっているか」を同じ求め方で出し、比べられるようにするためである。
 *
 * ブラウザ API に依存しない。
 */

/** 分布の要約 (ミリ秒) */
export interface TimingSummary {
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

/**
 * 値の分布を p50 / p95 / max に要約する
 *
 * 百分位は nearest-rank 法 (昇順に並べて ceil(p * n) 番目) で求める。値が無ければ null。
 */
export function summarizeTimings(values: readonly number[]): TimingSummary | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    max: nearestRank(sorted, 1),
  };
}

function nearestRank(sorted: readonly number[], ratio: number): number {
  const index = Math.max(0, Math.ceil(ratio * sorted.length) - 1);
  return sorted[index] ?? Number.NaN;
}
