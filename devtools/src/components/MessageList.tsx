import type { EventTimelineEntry } from "moqt-js";
import { formatEventEntryData } from "../utils/eventTimeline";

interface MessageListProps {
  /** 受信した event timeline の entry (古い順) */
  entries: readonly EventTimelineEntry[];
  testId: string;
}

/**
 * event timeline で受信した entry を、時刻と data の一覧で表示する
 *
 * devtools の publisher は `{ text }` を送るが、他の publisher の data は構造が異なりうる
 * ため、text が無いときは JSON として表示する (utils/eventTimeline.ts)。受信前も欄を
 * 描き、値を「-」にする
 */
export function MessageList({ entries, testId }: MessageListProps) {
  return (
    <div class="rounded-lg px-3 py-2 mb-4 border bg-amber-50 border-amber-200" data-testid={testId}>
      <h3 class="text-xs font-semibold uppercase tracking-wide mb-1 flex items-center gap-1.5 text-amber-700">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
          />
        </svg>
        Messages
      </h3>
      {entries.length === 0 ? (
        <div class="text-xs text-slate-400" data-testid={`${testId}-empty`}>
          -
        </div>
      ) : (
        <ol class="space-y-0.5 max-h-40 overflow-y-auto" data-testid={`${testId}-list`}>
          {entries.map((entry, index) => (
            <li key={index} class="flex gap-2 text-xs leading-5">
              <span class="shrink-0 text-slate-500">{formatMessageTime(entry.t)}</span>
              <span class="break-all text-slate-700">{formatEventEntryData(entry.data)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * entry の壁時計 (Unix epoch ミリ秒) を表示用の時刻にする
 *
 * index 参照が壁時計でない entry (Media PTS や Location) は時刻を決められないため「-」
 */
function formatMessageTime(wallClockMs: number | undefined): string {
  if (wallClockMs === undefined) {
    return "-";
  }
  return new Date(wallClockMs).toLocaleTimeString();
}
