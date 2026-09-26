import { useRef } from "preact/hooks";
import { useSignalEffect } from "@preact/signals";
import { autoScroll } from "../signals/debug";
import { getLogBuffer, logSequence, type LogEntry } from "../signals/debugLog";
import { DebugLogRow, type ViewMode } from "./DebugLogRow";

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

  const rows = [];
  for (let i = logs.length - 1; i >= 0; i--) {
    const log = logs[i];
    if (log === undefined) {
      // ループ境界 (0 <= i < logs.length) により到達しない
      // (noUncheckedIndexedAccess で型上 undefined を含むための防御)
      continue;
    }
    // 表示の key には配列の添字ではなくログの連番を使う。添字だと、上限に達して
    // 最古を捨てたときに展開状態が別の行へ移る
    rows.push(
      <DebugLogRow
        key={log.id}
        entry={log}
        isExpanded={expandedRows.has(log.id)}
        viewMode={viewModes.get(log.id) ?? "data"}
        isCopied={copiedKey === String(log.id)}
        onToggle={onToggleRow}
        onCopy={onCopyRow}
        onSelectViewMode={onSelectViewMode}
      />,
    );
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
