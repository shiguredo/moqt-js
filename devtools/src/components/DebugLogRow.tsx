import type { LogEntry, LogLevel } from "../signals/debugLog";
import { formatHexDump, formatMessageData } from "../utils/logFormatters";
import type { ViewMode } from "../utils/logRowState";

interface DebugLogRowProps {
  entry: LogEntry;
  /** 展開しているかどうか */
  isExpanded: boolean;
  /** 展開したときの表示 */
  viewMode: ViewMode;
  /** この行をコピーした直後かどうか */
  isCopied: boolean;
  onToggle: (logId: number) => void;
  onCopy: (entry: LogEntry, event: MouseEvent) => void;
  onSelectViewMode: (logId: number, viewMode: ViewMode) => void;
}

/** 重要度ごとの色 */
function getLevelColor(level: LogLevel): string {
  switch (level) {
    case "error":
      return "text-red-600 bg-red-50";
    case "warn":
      return "text-yellow-600 bg-yellow-50";
    case "info":
      return "text-blue-600 bg-blue-50";
    default:
      // "debug" および未知のレベルは灰色で表示する
      return "text-slate-600 bg-slate-50";
  }
}

/**
 * デバッグログの 1 行
 *
 * 時刻は追加時に整形済みの値 (`formattedTimestamp` / `formattedElapsed` /
 * `formattedDelta`) をそのまま出す。ここで整形し直すと、1 件追加するたびに
 * 表示中の全行の整形コストがかかる。
 */
export function DebugLogRow({
  entry,
  isExpanded,
  viewMode,
  isCopied,
  onToggle,
  onCopy,
  onSelectViewMode,
}: DebugLogRowProps) {
  const logId = entry.id;

  return (
    <div
      data-testid="debug-log-row"
      class={`rounded cursor-pointer transition-colors hover:ring-2 hover:ring-slate-300 ${getLevelColor(entry.level)}`}
      onClick={() => onToggle(logId)}
    >
      <div class="flex gap-2 p-2 items-center">
        {/* 展開アイコン */}
        {entry.data !== undefined && (
          <svg
            class={`w-4 h-4 text-slate-400 transition-transform ${isExpanded ? "rotate-90" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M9 5l7 7-7 7"
            />
          </svg>
        )}
        {entry.data === undefined && <div class="w-4" />}
        {/* タイムスタンプ列 */}
        <div class="flex flex-col text-xs whitespace-nowrap min-w-[140px]">
          <span class="text-slate-600 font-medium">{entry.formattedTimestamp}</span>
          <div class="flex gap-2 text-slate-400">
            <span>{entry.formattedElapsed}</span>
            {entry.formattedDelta !== "" && (
              <span class="text-slate-300">{entry.formattedDelta}</span>
            )}
          </div>
        </div>
        {/* メッセージ */}
        <span class="flex-1 break-all">{entry.message}</span>
        {/* コピーボタン */}
        <button
          onClick={(event) => onCopy(entry, event)}
          class="p-1 hover:bg-white/50 rounded transition-colors"
          title="Copy to clipboard"
        >
          {isCopied ? (
            <svg
              class="w-4 h-4 text-green-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M5 13l4 4L19 7"
              />
            </svg>
          ) : (
            <svg
              class="w-4 h-4 text-slate-400 hover:text-slate-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
          )}
        </button>
      </div>
      {/* データ（展開時のみ表示） */}
      {isExpanded && (entry.data !== undefined || entry.payload !== undefined) && (
        <div class="mx-2 mb-2">
          {/* タブ */}
          {entry.payload !== undefined && (
            <div class="flex gap-1 mb-1">
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectViewMode(logId, "data");
                }}
                class={`px-2 py-0.5 text-xs rounded-t transition-colors ${
                  viewMode === "data"
                    ? "bg-white/70 text-slate-700 font-medium"
                    : "bg-white/30 text-slate-500 hover:bg-white/50"
                }`}
              >
                Data
              </button>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectViewMode(logId, "binary");
                }}
                class={`px-2 py-0.5 text-xs rounded-t transition-colors ${
                  viewMode === "binary"
                    ? "bg-white/70 text-slate-700 font-medium"
                    : "bg-white/30 text-slate-500 hover:bg-white/50"
                }`}
              >
                Binary ({entry.payload.length} bytes)
              </button>
            </div>
          )}
          {/* コンテンツ */}
          <pre class="text-xs p-3 bg-white/70 rounded overflow-auto max-h-96">
            {viewMode === "binary" && entry.payload !== undefined
              ? formatHexDump(entry.payload)
              : formatMessageData(entry.data)}
          </pre>
        </div>
      )}
    </div>
  );
}
