import type { JSX } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useSignalEffect } from "@preact/signals";
import { autoScroll } from "../signals/debug";
import { getLogBuffer, logSequence, type LogEntry } from "../signals/debugLog";
import { matchesLogFilter, type LogFilter } from "../utils/logFilter";
import { pruneMapByLogId, type ViewMode } from "../utils/logRowState";
import { DebugLogRow } from "./DebugLogRow";

/** 先頭 (最新) とみなすスクロール位置のしきい値 (px) */
const SCROLL_TOP_THRESHOLD = 8;

interface DebugLogListProps {
  /** 展開している行のログの連番 */
  expandedRows: ReadonlySet<number>;
  /** 展開した行の表示 (data / binary)。未指定の行は data */
  viewModes: ReadonlyMap<number, ViewMode>;
  /** 直前にコピーした行の key。コピーの表示を出す行を決める */
  copiedKey: string | null;
  /** 表示するログの絞り込み条件 */
  filter: LogFilter;
  /** 一時停止中の表示に使うログ。null なら最新のログを表示する */
  pausedEntries: readonly LogEntry[] | null;
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
  filter,
  pausedEntries,
  onToggleRow,
  onCopyRow,
  onSelectViewMode,
}: DebugLogListProps) {
  // ログを追加したときに再描画するため連番を購読する。値自体は使わない
  void logSequence.value;
  // 一時停止中は停止した時点のログ、そうでなければ最新のログを表示する
  const sourceEntries = pausedEntries ?? getLogBuffer();

  const containerRef = useRef<HTMLDivElement>(null);

  // 先頭 (最新) を表示しているか。先頭から離れている間は新しいログで
  // 引き戻さず、「Jump to latest」ボタンを出す
  const [isAtTop, setIsAtTop] = useState(true);
  // スクロールイベントと Jump to latest の操作だけで更新する控え。描画中の
  // state の更新を避けつつ、useSignalEffect から最新の位置を読む
  const isAtTopRef = useRef(true);

  // 新しいログを追加したときに先頭 (最新) へスクロールする。
  // 先頭から離れて読んでいる間と一時停止中は引き戻さない。
  // logSequence の変化でのみ発火し、autoScroll トグル単体では発火しない
  useSignalEffect(() => {
    const sequence = logSequence.value;
    if (sequence === 0) return;
    if (pausedEntries !== null) return;
    if (!autoScroll.peek()) return;
    if (!isAtTopRef.current) return;
    containerRef.current?.scrollTo({ top: 0 });
  });

  const handleScroll = useCallback((event: Event) => {
    const element = event.currentTarget as HTMLDivElement;
    const atTop = element.scrollTop <= SCROLL_TOP_THRESHOLD;
    if (atTop === isAtTopRef.current) {
      return;
    }
    isAtTopRef.current = atTop;
    setIsAtTop(atTop);
  }, []);

  const jumpToLatest = useCallback(() => {
    containerRef.current?.scrollTo({ top: 0 });
    // スクロールイベントを待たずにボタンを消す (位置が既に先頭のときも含む)
    isAtTopRef.current = true;
    setIsAtTop(true);
  }, []);

  // 一時停止から再開したら先頭 (最新) へ戻る
  const wasPausedRef = useRef(pausedEntries !== null);
  useEffect(() => {
    const paused = pausedEntries !== null;
    if (wasPausedRef.current && !paused) {
      jumpToLatest();
    }
    wasPausedRef.current = paused;
  }, [pausedEntries, jumpToLatest]);

  // 行の vnode のキャッシュ。展開の状態・表示モード・コピーの表示が変わったら
  // 作り直す (依存が変わると新しい Map になり、すべての行を描画し直す)。
  // 絞り込みは行の中身を変えないため依存に含めない (表示する行の取捨だけが変わる)
  const rowCache = useMemo(
    () => new Map<number, JSX.Element>(),
    [expandedRows, viewModes, copiedKey],
  );

  const rows: JSX.Element[] = [];
  for (let i = sourceEntries.length - 1; i >= 0; i--) {
    const log = sourceEntries[i];
    if (log === undefined) {
      // ループ境界 (0 <= i < sourceEntries.length) により到達しない
      // (noUncheckedIndexedAccess で型上 undefined を含むための防御)
      continue;
    }
    if (!matchesLogFilter(log, filter)) {
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
  const oldestLogId = sourceEntries[0]?.id ?? null;
  if (oldestLogId === null) {
    rowCache.clear();
  } else if (rowCache.size > sourceEntries.length) {
    const pruned = pruneMapByLogId(rowCache, oldestLogId);
    if (pruned !== rowCache) {
      rowCache.clear();
      for (const [logId, row] of pruned) {
        rowCache.set(logId, row);
      }
    }
  }

  return (
    <div class="relative flex-1 min-h-0">
      <div
        ref={containerRef}
        data-testid="debug-log-list"
        onScroll={handleScroll}
        class="absolute inset-0 overflow-y-auto p-4 font-mono text-sm"
      >
        {sourceEntries.length === 0 ? (
          <div class="flex items-center justify-center h-full text-slate-400">
            {pausedEntries !== null
              ? "Paused with no logs. New logs will appear after resuming."
              : "No logs yet. MOQT operations will appear here."}
          </div>
        ) : rows.length === 0 ? (
          <div class="flex items-center justify-center h-full text-slate-400">
            No logs match the filter.
          </div>
        ) : (
          <div class="space-y-1">{rows}</div>
        )}
      </div>
      {/* 先頭から離れて読んでいる間だけ出す。押すと最新へ戻る */}
      {!isAtTop && (
        <button
          onClick={jumpToLatest}
          data-testid="debug-log-jump-latest"
          class="absolute bottom-4 right-4 px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium rounded-lg shadow-lg transition-colors"
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}
