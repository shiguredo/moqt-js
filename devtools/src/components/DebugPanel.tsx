import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { useSignalEffect } from "@preact/signals";
import { useCopyFeedback } from "../hooks/useCopyFeedback";
import { mode } from "../signals/connectionSettings";
import { autoScroll, closeDebugPanel, isDebugPanelOpen } from "../signals/debug";
import {
  clearLog,
  getLogBuffer,
  logSequence,
  type LogEntry,
  type LogLevel,
} from "../signals/debugLog";
import {
  buildAllExportText,
  buildPublisherExportText,
  buildSubscriberExportText,
} from "../signals/debugExport";
import { subscriberIds } from "../signals/subscriber";
import { maskC4mValue } from "../utils/c4m";
import { formatLogEntryText } from "../utils/debugExportText";
import {
  LOG_LEVEL_OPTIONS,
  createDefaultLogLevels,
  createLogFilter,
  filterLogEntries,
  isLogFilterActive,
} from "../utils/logFilter";
import { pruneLogIds, pruneViewModes, type ViewMode } from "../utils/logRowState";
import { DebugLogCount, DebugLogNewCount, DebugLogVisibleCount } from "./DebugLogCount";
import { DebugLogList } from "./DebugLogList";

/** 一時停止した時点の表示 */
interface PausedLogView {
  /** 停止した時点のログ (古い順) */
  readonly entries: readonly LogEntry[];
  /** 停止した時点の logSequence。停止中に増えた件数を数える */
  readonly sequence: number;
}

/** 重要度の表示名 */
const LOG_LEVEL_LABELS: Readonly<Record<LogLevel, string>> = {
  info: "Info",
  warn: "Warn",
  error: "Error",
  debug: "Debug",
};

/**
 * デバッグパネル
 *
 * ログの一覧は `DebugLogList`、件数は `DebugLogCount` が出す。パネル本体はログの連番を
 * 読まないため、ログを追加してもここは再描画されない (絞り込み・一時停止・コピーの
 * フィードバックなどの操作をしたときだけ再描画する)。
 */
export function DebugPanel() {
  // 表示モード。subscriber モードでは Publisher の通知ボタンを隠す
  const currentMode = mode.value;
  const subscriberIdList = subscriberIds.value;

  // 展開状態と表示モードは配列の添字ではなくログの連番で持つ。添字で持つと、
  // 上限到達後に最古を捨てたときに状態が別の行へ移る
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<number>>(new Set());
  const [viewModes, setViewModes] = useState<ReadonlyMap<number, ViewMode>>(new Map());

  // 絞り込み条件。閉じて開き直しても保つ (パネルは閉じてもコンポーネントは残る)
  const [query, setQuery] = useState("");
  const [levels, setLevels] = useState<ReadonlySet<LogLevel>>(createDefaultLogLevels);
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  // 一時停止中の表示。停止した時点のログと、そのときの連番を持つ
  const [paused, setPaused] = useState<PausedLogView | null>(null);
  const pausedEntries = paused?.entries ?? null;
  // 停止中に何件追加されたかは連番の差で数える (上限で捨てられた分も含める)
  const pausedSequence = paused?.sequence ?? 0;

  // 行コピーとボタンコピーは同時に「Copied!」表示しうるため hook を分離する
  const rowFeedback = useCopyFeedback();
  const buttonFeedback = useCopyFeedback();
  const rowCopy = rowFeedback.copy;

  // 選択中の接続元が消えた (Subscriber を削除した) ときは全接続元に戻す。
  // select の value に存在しない値を渡さない
  const sourceOptions = ["publisher", ...subscriberIdList];
  const effectiveSource =
    sourceFilter !== null && sourceOptions.includes(sourceFilter) ? sourceFilter : null;

  const filter = useMemo(
    () => createLogFilter(query, levels, effectiveSource),
    [query, levels, effectiveSource],
  );

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

  // 行のコールバックは参照を安定させる (行の vnode を使い回すため、参照が変わると
  // すべての行を描画し直すことになる)。`copy` は useCopyFeedback の中で useCallback
  // されているため、依存は `copy` にする
  const copyRow = useCallback(
    async (entry: LogEntry, event: MouseEvent) => {
      event.stopPropagation();
      await rowCopy(maskC4mValue(formatLogEntryText(entry)), String(entry.id));
    },
    [rowCopy],
  );

  // 上限で捨てられたログの状態を落とす。useSignalEffect は再描画を起こさないため、
  // ログを追加してもパネル本体は再描画されない。一時停止中は表示しているスナップショット
  // を基準にする (保持側から捨てられても表示中の行の状態を消さない)
  useSignalEffect(() => {
    void logSequence.value;
    const entries = pausedEntries ?? getLogBuffer();
    const oldestLogId = entries[0]?.id ?? null;
    setExpandedRows((previous) => pruneLogIds(previous, oldestLogId));
    setViewModes((previous) => pruneViewModes(previous, oldestLogId));
  });

  // 一時停止から再開したら、停止中に保持側から捨てられたログの展開状態を落とす。
  // logSequence の変化では pausedEntries が変わらないため、専用の effect で行う
  useEffect(() => {
    if (paused !== null) {
      return;
    }
    const oldestLogId = getLogBuffer()[0]?.id ?? null;
    setExpandedRows((previous) => pruneLogIds(previous, oldestLogId));
    setViewModes((previous) => pruneViewModes(previous, oldestLogId));
  }, [paused]);

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
    // 表示している行のうち data か payload を持つ行を展開する。識別にはログの連番を使う
    const sourceEntries = pausedEntries ?? getLogBuffer();
    setExpandedRows(
      new Set(
        filterLogEntries(sourceEntries, filter)
          .filter((entry) => entry.data !== undefined || entry.payload !== undefined)
          .map((entry) => entry.id),
      ),
    );
  };

  const clearLogs = () => {
    clearLog();
    // 捨てたログの状態を残さない
    setExpandedRows(new Set());
    setViewModes(new Map());
    setPaused(null);
  };

  const togglePause = () => {
    if (paused === null) {
      // 保持しているログをコピーして、その時点の一覧を固定する。コピーするのは
      // 参照の配列だけで、LogEntry 自体は共有する (追加後に書き換えない前提)。
      // 停止中の増加件数は連番の差で数える
      setPaused({ entries: [...getLogBuffer()], sequence: logSequence.peek() });
    } else {
      setPaused(null);
    }
  };

  const toggleLevel = (level: LogLevel) => {
    setLevels((previous) => {
      const next = new Set(previous);
      if (next.has(level)) {
        next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  };

  const resetFilter = () => {
    setQuery("");
    setLevels(createDefaultLogLevels());
    setSourceFilter(null);
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

  // 一括コピー: 画面に表示しているログ (絞り込み後、一時停止中は停止時点のもの)
  const copyVisibleLogs = useCallback(async () => {
    const entries = pausedEntries ?? getLogBuffer();
    const text = maskC4mValue(
      filterLogEntries(entries, filter)
        .map((entry) => formatLogEntryText(entry))
        .join("\n\n"),
    );
    if (text === "") {
      // 一致するログが無いときに空文字をコピーして「Copied!」を出さない
      return;
    }
    await buttonFeedback.copy(text, "visible");
  }, [buttonFeedback, filter, pausedEntries]);

  if (!isDebugPanelOpen.value) {
    return null;
  }

  const isPaused = pausedEntries !== null;
  // 一時停止中に増えたログは、停止した時点の最後のログより後のもの
  const pausedLastId = pausedEntries?.at(-1)?.id ?? -1;

  return (
    <div
      data-testid="debug-panel"
      class="fixed top-0 right-0 bottom-0 z-50 flex w-full max-w-full flex-col border-l border-slate-200 bg-white shadow-2xl lg:top-20 lg:w-[640px]"
    >
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
      <div class="flex flex-wrap items-center justify-between gap-2 p-3 border-b border-slate-100">
        <div class="flex items-center gap-3 text-sm text-slate-600">
          <span data-testid="debug-log-count">
            Logs: <DebugLogCount />
          </span>
          {isLogFilterActive(filter) && (
            <DebugLogVisibleCount filter={filter} pausedEntries={pausedEntries} />
          )}
        </div>
        <div class="flex flex-wrap items-center gap-2">
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
            onClick={togglePause}
            data-testid="debug-log-pause"
            class={`w-24 py-1.5 text-white text-sm font-medium rounded-lg transition-colors ${
              isPaused ? "bg-emerald-500 hover:bg-emerald-600" : "bg-slate-500 hover:bg-slate-600"
            }`}
          >
            {isPaused ? "Resume" : "Pause"}
          </button>
          {isPaused && (
            <DebugLogNewCount
              sinceId={pausedLastId}
              sinceSequence={pausedSequence}
              filter={filter}
            />
          )}
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

      {/* 絞り込み */}
      <div class="flex items-center gap-2 px-3 py-2 border-b border-slate-100">
        <input
          type="search"
          value={query}
          onInput={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            // 検索語があるときの Esc は検索語だけを消す (パネルを閉じない)。
            // パネルを閉じる Esc は document のリスナーが処理するため、
            // ここで伝播を止める
            if (event.key === "Escape" && query !== "") {
              event.stopPropagation();
              setQuery("");
            }
          }}
          placeholder="Filter logs..."
          aria-label="Filter logs"
          data-testid="debug-log-filter"
          class="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-sm"
        />
        <select
          value={effectiveSource ?? ""}
          onChange={(event) =>
            setSourceFilter(event.currentTarget.value === "" ? null : event.currentTarget.value)
          }
          aria-label="Filter by source"
          data-testid="debug-log-source"
          class="rounded border border-slate-300 px-2 py-1 text-sm"
        >
          <option value="">All Sources</option>
          <option value="publisher">Publisher</option>
          {subscriberIdList.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        {isLogFilterActive(filter) && (
          <button
            onClick={resetFilter}
            data-testid="debug-log-filter-reset"
            class="px-2 py-1 text-xs font-medium rounded bg-slate-200 hover:bg-slate-300 text-slate-700 transition-colors"
          >
            Reset
          </button>
        )}
      </div>

      {/* 重要度 */}
      <div class="flex flex-wrap items-center gap-3 px-3 py-2 border-b border-slate-100 text-sm text-slate-600">
        <span class="text-slate-500">Levels:</span>
        {LOG_LEVEL_OPTIONS.map((level) => (
          <label key={level} class="flex items-center gap-1">
            <input
              type="checkbox"
              checked={levels.has(level)}
              onChange={() => toggleLevel(level)}
              data-testid={`debug-log-level-${level}`}
              class="rounded"
            />
            {LOG_LEVEL_LABELS[level]}
          </label>
        ))}
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
        {/* 絞り込み中・一時停止中は、画面に出ているログだけをコピーできるようにする */}
        {(isLogFilterActive(filter) || isPaused) && (
          <button
            onClick={copyVisibleLogs}
            data-testid="debug-log-copy-visible"
            class={`px-3 py-1 text-xs font-medium rounded transition-colors ${
              buttonFeedback.feedback.value === "visible"
                ? "bg-green-500 text-white"
                : "bg-slate-200 hover:bg-slate-300 text-slate-700"
            }`}
          >
            {buttonFeedback.feedback.value === "visible" ? "Copied!" : "Visible"}
          </button>
        )}
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
        {subscriberIdList.map((id) => (
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
        filter={filter}
        pausedEntries={pausedEntries}
        onToggleRow={toggleRow}
        onCopyRow={copyRow}
        onSelectViewMode={selectViewMode}
      />
    </div>
  );
}
