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
  return pruneMapByLogId(viewModes, oldestLogId);
}

/**
 * 上限で捨てられたログの値を落とす (連番をキーにした Map)
 *
 * 表示モードや行の vnode のキャッシュのように、ログの連番をキーにした Map へ使う。
 * 落とすものが無ければ同じ Map を返す (呼び出し側の再描画を起こさない)。
 * 上限に達した後は 1 件追加ごとに全キーを走査するが、1000 件で約 11 µs のため
 * 1 件追加のコストにはほとんど効かない (実測)。
 */
export function pruneMapByLogId<T>(
  values: ReadonlyMap<number, T>,
  oldestLogId: number | null,
): ReadonlyMap<number, T> {
  if (oldestLogId === null || values.size === 0) {
    return values;
  }
  let next: Map<number, T> | null = null;
  for (const logId of values.keys()) {
    if (logId < oldestLogId) {
      next ??= new Map(values);
      next.delete(logId);
    }
  }
  return next ?? values;
}
