import type { JSX } from "preact";
import { useMemo, useRef } from "preact/hooks";
import { useSignalEffect } from "@preact/signals";
import { autoScroll } from "../signals/debug";
import { getLogBuffer, logSequence, type LogEntry } from "../signals/debugLog";
import { pruneMapByLogId, type ViewMode } from "../utils/logRowState";
import { DebugLogRow } from "./DebugLogRow";

interface DebugLogListProps {
  /** 展開している行のログの連番 */
  expandedRows: ReadonlySet<number>;
  /** 展開した行の表示 (data / binary)。未指定の行は data */
  viewModes: ReadonlyMap<number, ViewMode>;
  /** 直前にコピーした行の key。コピーの表示を出す行を決める */
  copiedKey: string | null;
  onToggleRow: (logId: number) => void;
  onCopyRow: (entry: LogEntry, event: MouseEvent) => void;
  onSelectViewMode: (logId: number, viewMode: ViewMode) => void;
}

/**
 * デバッグログの一覧
 *
 * ログの連番を購読するのはこのコンポーネントだけにし、パネルを開いている間だけ
 * 購読を作る (パネルは閉じているときは何も描かない)。
 *
 * 表示は新しい順にする。並べ替えのため配列は作り直さず、末尾から読む。
 *
 * 行の vnode はログの連番で保持し、追記では作り直さない。Preact は `_original` が
 * 一致する vnode を再び受け取ると、その部分木の差分を省略する (内部実装への依存のため
 * `tests/e2e/devtools-debug-panel.spec.ts` が描画回数で固定する)。作り直すと 1 件追加で
 * 表示中のすべての行を描画することになり、1000 件表示では 1 件あたり 1000 行分になる。
 *
 * 作り直すのは展開の状態・表示モード・コピーの表示が変わったときだけで、コールバックは
 * 参照が安定していること (`entry` は追加後に書き換えないこと) が前提。表示に効く値を
 * 足したら `rowCache` の依存にも足すこと (oxlint の exhaustive-deps は無効にしてある)。
 */
export function DebugLogList({
  expandedRows,
  viewModes,
  copiedKey,
  onToggleRow,
  onCopyRow,
  onSelectViewMode,
}: DebugLogListProps) {
  // ログを追加したときに再描画するため連番を購読する。値自体は使わない
  void logSequence.value;
  const logs = getLogBuffer();

  const containerRef = useRef<HTMLDivElement>(null);

  // 新しいログを追加したときに先頭 (最新) へスクロールする。
  // logSequence の変化でのみ発火し、autoScroll トグル単体では発火しない
  useSignalEffect(() => {
    const sequence = logSequence.value;
    if (sequence === 0) return;
    if (!autoScroll.peek()) return;
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
  });

  // 行の vnode のキャッシュ。展開の状態・表示モード・コピーの表示が変わったら
  // 作り直す (依存が変わると新しい Map になり、すべての行を描画し直す)
  const rowCache = useMemo(
    () => new Map<number, JSX.Element>(),
    [expandedRows, viewModes, copiedKey],
  );

  const rows: JSX.Element[] = [];
  for (let i = logs.length - 1; i >= 0; i--) {
    const log = logs[i];
    if (log === undefined) {
      // ループ境界 (0 <= i < logs.length) により到達しない
      // (noUncheckedIndexedAccess で型上 undefined を含むための防御)
      continue;
    }
    let row = rowCache.get(log.id);
    if (row === undefined) {
      // 表示の key には配列の添字ではなくログの連番を使う。上限に達すると最古のログを
      // 捨てるため、添字を key にすると残っている行の key が 1 つずつずれ、同じログの行を
      // 同じ行として扱えなくなる
      row = (
        <DebugLogRow
          key={log.id}
          entry={log}
          isExpanded={expandedRows.has(log.id)}
          viewMode={viewModes.get(log.id) ?? "data"}
          isCopied={copiedKey === String(log.id)}
          onToggle={onToggleRow}
          onCopy={onCopyRow}
          onSelectViewMode={onSelectViewMode}
        />
      );
      rowCache.set(log.id, row);
    }
    rows.push(row);
  }

  // 上限で捨てたログの vnode をキャッシュから落とす。連番は増え続けるため、残すと
  // 長いセッションでメモリと 1 件追加のコストが増え続ける (実測: 500 件あふれさせると
  // 1 件追加が 3.1 ms から 6.0 ms になった)。ログを消したときも残さない
  const oldestLogId = logs[0]?.id ?? null;
  if (oldestLogId === null) {
    rowCache.clear();
  } else if (rowCache.size > logs.length) {
    const pruned = pruneMapByLogId(rowCache, oldestLogId);
    if (pruned !== rowCache) {
      rowCache.clear();
      for (const [logId, row] of pruned) {
        rowCache.set(logId, row);
      }
    }
  }

  return (
    <div
      ref={containerRef}
      data-testid="debug-log-list"
      class="h-[calc(100vh-190px)] overflow-y-auto p-4 font-mono text-sm"
    >
      {logs.length === 0 ? (
        <div class="flex items-center justify-center h-full text-slate-400">
          No logs yet. MOQT operations will appear here.
        </div>
      ) : (
        <div class="space-y-1">{rows}</div>
      )}
    </div>
  );
}
