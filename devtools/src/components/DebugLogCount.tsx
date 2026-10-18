import { getLogBuffer, logSequence, type LogEntry } from "../signals/debugLog";
import {
  countMatchingLogEntries,
  isLogFilterActive,
  matchesLogFilter,
  type LogFilter,
} from "../utils/logFilter";

/**
 * ツールバーに出すログの件数
 *
 * パネル本体 (`DebugPanel`) にログの連番を読ませないためのコンポーネントである。
 * 本体が読むと、1 件追加するたびにパネル全体が再描画される。
 */
export function DebugLogCount() {
  // 追加・クリアで件数を出し直すため連番を購読する。値自体は使わない
  void logSequence.value;
  return getLogBuffer().length;
}

/**
 * 絞り込み後に表示している件数
 *
 * 絞り込みが既定の状態のときは呼び出し側がこのコンポーネントを描かないため、
 * ここでは常に条件に一致する件数を出す。分母は表示している一覧の件数
 * (一時停止中は停止した時点の件数) にし、停止中に増えた件数は別に出す。
 */
export function DebugLogVisibleCount({
  filter,
  pausedEntries,
}: {
  filter: LogFilter;
  pausedEntries: readonly LogEntry[] | null;
}) {
  // 追加・クリアで件数を出し直すため連番を購読する。値自体は使わない
  void logSequence.value;
  const sourceEntries = pausedEntries ?? getLogBuffer();
  const visibleCount = countMatchingLogEntries(sourceEntries, filter);
  return (
    <span data-testid="debug-log-visible-count" class="text-slate-400">
      {visibleCount} of {sourceEntries.length} shown
    </span>
  );
}

/**
 * 一時停止中に増えたログの件数
 *
 * 再開する前に、増えた分の量と内容の見当を付けるために出す。絞り込みが無いときは
 * 連番の差 (上限で捨てられた分も含む追加総数) を出す。絞り込み中はバッファに残って
 * いる一致数だけを数え、捨てられた分があるときは過少であり得るため "+" を付ける。
 */
export function DebugLogNewCount({
  sinceId,
  sinceSequence,
  filter,
}: {
  sinceId: number;
  sinceSequence: number;
  filter: LogFilter;
}) {
  // 追加・クリアで件数を出し直すため連番を購読する。値自体は使わない
  void logSequence.value;
  const addedCount = logSequence.value - sinceSequence;
  if (addedCount <= 0) {
    return null;
  }
  const filterActive = isLogFilterActive(filter);
  let retainedCount = 0;
  let matchingCount = 0;
  for (const entry of getLogBuffer()) {
    if (entry.id <= sinceId) {
      continue;
    }
    retainedCount += 1;
    if (matchesLogFilter(entry, filter)) {
      matchingCount += 1;
    }
  }
  const count = filterActive ? matchingCount : addedCount;
  if (count === 0) {
    return null;
  }
  // 上限で捨てられた分を数えられないときは、過少であることを "+" で示す
  const suffix = filterActive && addedCount > retainedCount ? "+" : "";
  return (
    <span
      data-testid="debug-log-new-count"
      aria-live="polite"
      class="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700"
    >
      {count}
      {suffix} new
    </span>
  );
}
