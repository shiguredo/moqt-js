/**
 * デバッグパネルの行の状態の枝刈り
 *
 * 展開の状態と表示モードは、配列の添字ではなくログの連番で持つ。ログは上限
 * (`signals/debugLog.ts` の `MAX_LOGS`) に達すると古い方から捨てられるため、
 * 捨てられたログの連番を持ち続けると状態が単調に増える。
 *
 * どちらの関数も、落とすものがあるときだけ新しい Set / Map を作る。呼び出し側は
 * 「同じ参照が返ったら状態を変えない」ことで無駄な再描画を避ける。
 */

/** 展開したときの表示。data か payload (hex dump) か */
export type ViewMode = "data" | "binary";

/** 上限で捨てられたログの連番を落とす (残っている最も古い連番より小さい連番) */
export function pruneLogIds(
  values: ReadonlySet<number>,
  oldestLogId: number | null,
): ReadonlySet<number> {
  if (oldestLogId === null || values.size === 0) {
    return values;
  }
  let next: Set<number> | null = null;
  for (const value of values) {
    if (value < oldestLogId) {
      next ??= new Set(values);
      next.delete(value);
    }
  }
  return next ?? values;
}

/** 上限で捨てられたログの表示モードを落とす (pruneLogIds と同じ考え方) */
export function pruneViewModes(
  viewModes: ReadonlyMap<number, ViewMode>,
  oldestLogId: number | null,
): ReadonlyMap<number, ViewMode> {
  if (oldestLogId === null || viewModes.size === 0) {
    return viewModes;
  }
  let next: Map<number, ViewMode> | null = null;
  for (const logId of viewModes.keys()) {
    if (logId < oldestLogId) {
      next ??= new Map(viewModes);
      next.delete(logId);
    }
  }
  return next ?? viewModes;
}
