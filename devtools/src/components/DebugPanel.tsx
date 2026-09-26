import { useCallback, useEffect, useState } from "preact/hooks";
import { useSignalEffect } from "@preact/signals";
import { useCopyFeedback } from "../hooks/useCopyFeedback";
import { mode } from "../signals/connectionSettings";
import { autoScroll, closeDebugPanel, isDebugPanelOpen } from "../signals/debug";
import { clearLog, getLogBuffer, logSequence, type LogEntry } from "../signals/debugLog";
import {
  buildAllExportText,
  buildPublisherExportText,
  buildSubscriberExportText,
} from "../signals/debugExport";
import { subscriberIds } from "../signals/subscriber";
import { formatLogEntryText } from "../utils/debugExportText";
import { pruneLogIds, pruneViewModes, type ViewMode } from "../utils/logRowState";
import { DebugLogCount } from "./DebugLogCount";
import { DebugLogList } from "./DebugLogList";

/**
 * デバッグパネル
 *
 * ログの一覧は `DebugLogList`、件数は `DebugLogCount` が出す。パネル本体はログの連番を
 * 読まないため、ログを追加してもここは再描画されない。
 */
export function DebugPanel() {
  // 表示モード。subscriber モードでは Publisher の通知ボタンを隠す
  const currentMode = mode.value;

  // 展開状態と表示モードは配列の添字ではなくログの連番で持つ。添字で持つと、
  // 上限到達後に最古を捨てたときに状態が別の行へ移る
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<number>>(new Set());
  const [viewModes, setViewModes] = useState<ReadonlyMap<number, ViewMode>>(new Map());
  // 行コピーとボタンコピーは同時に「Copied!」表示しうるため hook を分離する
  const rowFeedback = useCopyFeedback();
  const buttonFeedback = useCopyFeedback();

  const toggleRow = useCallback((logId: number) => {
    setExpandedRows((previous) => {
      const next = new Set(previous);
      if (next.has(logId)) {
        next.delete(logId);
      } else {
        next.add(logId);
      }
      return next;
    });
  }, []);

  const selectViewMode = useCallback((logId: number, viewMode: ViewMode) => {
    setViewModes((previous) => new Map(previous).set(logId, viewMode));
  }, []);

  const copyRow = useCallback(
    async (entry: LogEntry, event: MouseEvent) => {
      event.stopPropagation();
      await rowFeedback.copy(formatLogEntryText(entry), String(entry.id));
    },
    [rowFeedback],
  );

  // 上限で捨てられたログの状態を落とす。useSignalEffect は再描画を起こさないため、
  // ログを追加してもパネル本体は再描画されない
  useSignalEffect(() => {
    void logSequence.value;
    const oldestLogId = getLogBuffer()[0]?.id ?? null;
    setExpandedRows((previous) => pruneLogIds(previous, oldestLogId));
    setViewModes((previous) => pruneViewModes(previous, oldestLogId));
  });

  // ESC キーでパネルを閉じる
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isDebugPanelOpen.value) {
        closeDebugPanel();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const hasExpandedRows = expandedRows.size > 0;

  const toggleExpandAll = () => {
    if (hasExpandedRows) {
      setExpandedRows(new Set());
      return;
    }
    // data を持つ行だけを展開する。識別にはログの連番を使う
    setExpandedRows(
      new Set(
        getLogBuffer()
          .filter((entry) => entry.data !== undefined)
          .map((entry) => entry.id),
      ),
    );
  };

  const clearLogs = () => {
    clearLog();
    // 捨てたログの状態を残さない
    setExpandedRows(new Set());
    setViewModes(new Map());
  };

  // 一括コピー: 全ログ
  const copyAllLogs = useCallback(async () => {
    await buttonFeedback.copy(buildAllExportText(), "all");
  }, [buttonFeedback]);

  // 一括コピー: Publisher ログ
  const copyPublisherLogs = useCallback(async () => {
    await buttonFeedback.copy(buildPublisherExportText(), "publisher");
  }, [buttonFeedback]);

  // 一括コピー: Subscriber ログ
  const copySubscriberLogs = useCallback(
    async (subscriberId: string) => {
      await buttonFeedback.copy(buildSubscriberExportText(subscriberId), subscriberId);
    },
    [buttonFeedback],
  );

  if (!isDebugPanelOpen.value) {
    return null;
  }

  return (
    <div class="fixed top-0 right-0 h-full w-[640px] bg-white shadow-2xl z-50 border-l border-slate-200">
      {/* ヘッダー */}
      <div class="flex items-center justify-between p-4 border-b border-slate-200 bg-slate-50">
        <h2 class="text-lg font-semibold text-slate-700 flex items-center gap-2">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          Debug Logs
        </h2>
        <button
          onClick={closeDebugPanel}
          class="p-2 hover:bg-slate-200 rounded-lg transition-colors"
          title="Close (Esc)"
        >
          <svg class="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      {/* コントロール */}
      <div class="flex items-center justify-between p-3 border-b border-slate-100">
        <div class="flex items-center gap-4 text-sm text-slate-600">
          <span data-testid="debug-log-count">
            Logs: <DebugLogCount />
          </span>
        </div>
        <div class="flex items-center gap-3">
          <label class="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={autoScroll.value}
              onChange={(event) => (autoScroll.value = event.currentTarget.checked)}
              class="rounded"
            />
            Auto Scroll
          </label>
          <button
            onClick={toggleExpandAll}
            class="w-24 py-1.5 bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {hasExpandedRows ? "Collapse All" : "Expand All"}
          </button>
          <button
            onClick={clearLogs}
            class="px-3 py-1.5 bg-slate-500 hover:bg-slate-600 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Clear
          </button>
        </div>
      </div>

      {/* 一括コピーボタン */}
      <div class="flex items-center gap-2 p-3 border-b border-slate-100 flex-wrap">
        <span class="text-sm text-slate-500">Copy for LLM:</span>
        <button
          onClick={copyAllLogs}
          data-testid="debug-log-copy-all"
          class={`px-3 py-1 text-xs font-medium rounded transition-colors ${
            buttonFeedback.feedback.value === "all"
              ? "bg-green-500 text-white"
              : "bg-slate-200 hover:bg-slate-300 text-slate-700"
          }`}
        >
          {buttonFeedback.feedback.value === "all" ? "Copied!" : "All"}
        </button>
        {/* Publisher は subscriber モードのページに存在しないためボタンも隠す。
            publisher モードでは Subscriber が 0 個なので Subscriber ごとのボタンは出ない */}
        {currentMode !== "subscriber" && (
          <button
            onClick={copyPublisherLogs}
            data-testid="debug-log-copy-publisher"
            class={`px-3 py-1 text-xs font-medium rounded transition-colors ${
              buttonFeedback.feedback.value === "publisher"
                ? "bg-green-500 text-white"
                : "bg-slate-200 hover:bg-slate-300 text-slate-700"
            }`}
          >
            {buttonFeedback.feedback.value === "publisher" ? "Copied!" : "Publisher"}
          </button>
        )}
        {subscriberIds.value.map((id) => (
          <button
            key={id}
            onClick={() => copySubscriberLogs(id)}
            data-testid={`debug-log-copy-${id}`}
            class={`px-3 py-1 text-xs font-medium rounded transition-colors ${
              buttonFeedback.feedback.value === id
                ? "bg-green-500 text-white"
                : "bg-slate-200 hover:bg-slate-300 text-slate-700"
            }`}
          >
            {buttonFeedback.feedback.value === id ? "Copied!" : id}
          </button>
        ))}
      </div>

      {/* ログの一覧 */}
      <DebugLogList
        expandedRows={expandedRows}
        viewModes={viewModes}
        copiedKey={rowFeedback.feedback.value}
        onToggleRow={toggleRow}
        onCopyRow={copyRow}
        onSelectViewMode={selectViewMode}
      />
    </div>
  );
}
