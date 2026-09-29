import { computed, signal, untracked, type ReadonlySignal } from "@preact/signals";

/**
 * 統計の表示を更新する連番 (1 秒ごとに増える)
 *
 * 統計の値 (Object 数やフレーム数) は秒間数十回変わる。画面が signal を直接読むと
 * そのたびにパネル全体を描き直すため、統計はこの連番だけを購読し、値は連番が増えた
 * ときにまとめて読む
 */
export const statsTick = signal(0);

// interval はアプリで 1 本だけ起動する (パネルごとに増やさない)
let started = false;

/** 統計の連番を進める interval を起動する (最初の 1 回だけ動く) */
export function startStatsTick(): void {
  if (started) {
    return;
  }
  started = true;
  setInterval(() => {
    statsTick.value++;
  }, 1000);
}

/**
 * 統計の値を 1 秒ごとにまとめて読む signal を作る
 *
 * `build` の中の signal は購読しない (`untracked`)。戻り値の signal を読むと、連番が
 * 増えたときだけ `build` が走り、新しい値に変わる
 */
export function createStatsSignal<T>(build: () => T): ReadonlySignal<T> {
  return computed(() => {
    void statsTick.value;
    return untracked(build);
  });
}
