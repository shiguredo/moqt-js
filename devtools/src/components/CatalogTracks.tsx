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
 * catalog を受け取る前も欄を描き、値を「-」にする。受け取った時点で欄が現れたり、
 * Track の数で高さが変わったりすると、その下の項目 (画面の幅が狭いときは下に並ぶ
 * パネルの映像) の位置が動く。一覧の領域の高さは固定し、収まらない分は欄の中で
 * スクロールする
 */
export function CatalogTracks({ tracks, tone, testId }: CatalogTracksProps) {
  const classes = TONE_CLASSES[tone];
  return (
    <div class={`rounded-lg p-4 mb-4 border ${classes.box}`} data-testid={testId}>
      <h3
        class={`text-xs font-semibold uppercase tracking-wide mb-3 flex items-center gap-2 ${classes.title}`}
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
        Catalog
      </h3>
      <div class="h-44 overflow-y-auto space-y-2" data-testid={`${testId}-tracks`}>
        {tracks.length === 0 ? (
          <div class="text-xs text-slate-400">-</div>
        ) : (
          tracks.map((track, index) => (
            <div key={index} class={`bg-white rounded-lg p-3 border ${classes.card}`}>
              <div class="grid grid-cols-4 gap-2 text-xs">
                {Object.entries(track).map(([key, value]) => (
                  <div key={key}>
                    <div class="text-slate-500">{key}</div>
                    <div
                      class="font-semibold text-slate-700 truncate"
                      title={formatCatalogValue(key, value)}
                    >
                      {formatCatalogValue(key, value)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
