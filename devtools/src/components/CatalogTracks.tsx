import type { CatalogTrack } from "moqt-js";
import { formatBitrate } from "../utils/logFormatters";

/** catalog の値を表示用にする。bitrate は単位を付ける */
function formatCatalogValue(key: string, value: unknown): string {
  if (key === "bitrate" && typeof value === "number") {
    return formatBitrate(value);
  }
  return String(value);
}

// パネルごとの色 (Publisher は緑、Subscriber は青)
const TONE_CLASSES = {
  green: {
    box: "bg-green-50 border-green-200",
    title: "text-green-700",
    card: "border-green-100",
  },
  blue: {
    box: "bg-blue-50 border-blue-200",
    title: "text-blue-700",
    card: "border-blue-100",
  },
} as const;

interface CatalogTracksProps {
  tracks: readonly CatalogTrack[];
  tone: keyof typeof TONE_CLASSES;
  testId: string;
}

/**
 * catalog の Track の一覧
 *
 * Track ごとに、キーと値を 1 組ずつ横に詰めて並べ、幅が足りない分だけ折り返す。高さは
 * Track の数と中身に合わせ、欄の中でスクロールさせない (映像と音声の Track を一目で読める)。
 * 長い値 (initRef など) は 1 組の幅に収めて省き、全文はマウスを重ねると出る。
 * catalog を受け取る前も欄を描き、値を「-」にする
 */
export function CatalogTracks({ tracks, tone, testId }: CatalogTracksProps) {
  const classes = TONE_CLASSES[tone];
  return (
    <div class={`rounded-lg px-3 py-2 mb-4 border ${classes.box}`} data-testid={testId}>
      <h3
        class={`text-xs font-semibold uppercase tracking-wide mb-1 flex items-center gap-1.5 ${classes.title}`}
      >
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
        Catalog
      </h3>
      <div class="space-y-1" data-testid={`${testId}-tracks`}>
        {tracks.length === 0 ? (
          <div class="text-xs text-slate-400">-</div>
        ) : (
          tracks.map((track, index) => (
            <div
              key={index}
              class={`bg-white rounded px-2 py-1 border ${classes.card} flex flex-wrap gap-x-3 gap-y-0.5 text-xs leading-4`}
            >
              {Object.entries(track).map(([key, value]) => {
                const text = formatCatalogValue(key, value);
                return (
                  <span key={key} class="max-w-full flex gap-1 min-w-0" title={`${key}: ${text}`}>
                    <span class="text-slate-500 shrink-0">{key}</span>
                    <span class="font-semibold text-slate-700 truncate">{text}</span>
                  </span>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
