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
 * 展開した行の data を表示用に整形する
 *
 * 整形できない data (循環参照など) でもパネルの行を壊さない。
 */
function formatRowData(data: unknown): string {
  try {
    return formatMessageData(data);
  } catch {
    return "(unserializable)";
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
  const hasData = entry.data !== undefined;
  const payload = entry.payload;
  const hasPayload = payload !== undefined;
  // data を持たず payload だけを持つ行は、展開したら Binary を出す。data の空文字を
  // 出すと、展開しても何も見えない行になる
  const effectiveViewMode = !hasData && hasPayload ? "binary" : viewMode;

  return (
    <div
      data-testid="debug-log-row"
      class={`rounded cursor-pointer transition-colors hover:ring-2 hover:ring-slate-300 ${getLevelColor(entry.level)}`}
      onClick={() => onToggle(logId)}
    >
      <div class="flex gap-2 p-2 items-center">
        {/* 展開アイコン */}
        {(hasData || hasPayload) && (
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
        {!hasData && !hasPayload && <div class="w-4" />}
        {/* 重要度。色だけに頼らず、行をコピーしたときや色覚に依らず読めるようにする */}
        <span
          data-testid="debug-log-level"
          class="shrink-0 w-12 text-xs font-semibold tracking-wide"
        >
          {entry.level.toUpperCase()}
        </span>
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
      {isExpanded && (hasData || hasPayload) && (
        <div class="mx-2 mb-2">
          {/* タブ。payload を持つ行だけ Binary を選べる。data を持たない行は
              Data タブを出さない (中身が空になるため) */}
          {hasPayload && (
            <div class="flex gap-1 mb-1">
              {hasData && (
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectViewMode(logId, "data");
                  }}
                  class={`px-2 py-0.5 text-xs rounded-t transition-colors ${
                    effectiveViewMode === "data"
                      ? "bg-white/70 text-slate-700 font-medium"
                      : "bg-white/30 text-slate-500 hover:bg-white/50"
                  }`}
                >
                  Data
                </button>
              )}
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectViewMode(logId, "binary");
                }}
                class={`px-2 py-0.5 text-xs rounded-t transition-colors ${
                  effectiveViewMode === "binary"
                    ? "bg-white/70 text-slate-700 font-medium"
                    : "bg-white/30 text-slate-500 hover:bg-white/50"
                }`}
              >
                Binary ({payload.length} bytes)
              </button>
            </div>
          )}
          {/* コンテンツ */}
          <pre class="text-xs p-3 bg-white/70 rounded overflow-auto max-h-96">
            {effectiveViewMode === "binary" && payload !== undefined
              ? formatHexDump(payload)
              : formatRowData(entry.data)}
          </pre>
        </div>
      )}
    </div>
  );
}
