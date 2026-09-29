import type { CatalogTrack } from "moqt-js";
import { formatFullTrackName } from "../../../src/fullTrackName.ts";
import { formatBitrate } from "../utils/logFormatters";

/** catalog の値を表示用にする。bitrate は単位を付ける */
function formatCatalogValue(key: string, value: unknown): string {
  if (key === "bitrate" && typeof value === "number") {
    return formatBitrate(value);
  }
  return String(value);
}

/**
 * Track の Full Track Name を組み立てる (表示できないときは null)
 *
 * draft-ietf-moq-msf-01 §5.2.2: track object の `namespace` は省略可能で、省略時は
 * catalog track の namespace を継承する。指定されている場合は catalog の例と同じ
 * "/" 区切りとして Track Namespace のフィールドに分解する。Full Track Name の表記は
 * draft-ietf-moq-transport-21 §8.8 に従う
 */
function resolveTrackFullTrackName(
  track: CatalogTrack,
  catalogTrackNamespace: readonly string[],
): string | null {
  const trackNamespace =
    track.namespace === undefined
      ? catalogTrackNamespace
      : track.namespace.split("/").filter((field) => field.length > 0);
  try {
    return formatFullTrackName(trackNamespace, track.name);
  } catch {
    // 空の Track Namespace Field など §8.8 の表記にできない値では行に出さない
    return null;
  }
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
  /**
   * catalog track の Track Namespace (接続設定の namespace)。
   * 各トラックの Full Track Name を組み立てるのに使う (§5.2.2 で track が
   * namespace を持つ場合はそちらを優先する)
   */
  trackNamespace: readonly string[];
  tone: keyof typeof TONE_CLASSES;
  testId: string;
}

/**
 * トラックを media / data のどちらへ並べるか
 *
 * draft-ietf-moq-msf-01 §5.2.4 (Table 3 / Table 4): `loc` は音声 / 映像などの
 * メディアを運ぶパッケージングで、`mediatimeline` / `eventtimeline` / `moqlog` /
 * `moqmetrics` はデータを運ぶ。Catalog パネルはこの 2 つを分けて並べる
 */
function resolveTrackGroup(track: CatalogTrack): "media" | "data" {
  return track.packaging === "loc" ? "media" : "data";
}

interface CatalogTrackRowProps {
  track: CatalogTrack;
  trackNamespace: readonly string[];
  cardClass: string;
}

/** トラック 1 件の行。1 行目に Full Track Name、2 行目以降に残りのキーと値 */
function CatalogTrackRow({ track, trackNamespace, cardClass }: CatalogTrackRowProps) {
  const fullTrackName = resolveTrackFullTrackName(track, trackNamespace);
  // Full Track Name を組み立てられないときは track name をそのまま出す
  // (name は Full Track Name に含まれるため、行から消えないようにする)
  const title = fullTrackName ?? track.name;
  return (
    <div class={`bg-white rounded px-2 py-1 border ${cardClass}`}>
      <div
        class="text-xs font-semibold text-slate-700 truncate"
        title={fullTrackName === null ? `name: ${track.name}` : `Full Track Name: ${fullTrackName}`}
      >
        {title}
      </div>
      <div class="flex flex-wrap gap-x-3 text-xs leading-4">
        {Object.entries(track)
          // name (§5.2.3) は 1 行目に出す
          .filter(([key]) => key !== "name")
          .map(([key, value]) => {
            const text = formatCatalogValue(key, value);
            return (
              <span key={key} class="max-w-full flex gap-1 min-w-0" title={`${key}: ${text}`}>
                <span class="text-slate-500 shrink-0">{key}</span>
                <span class="text-slate-700 truncate">{text}</span>
              </span>
            );
          })}
      </div>
    </div>
  );
}

interface CatalogTrackGroupProps {
  /** グループの見出し (Media / Data) */
  label: string;
  tracks: readonly CatalogTrack[];
  trackNamespace: readonly string[];
  cardClass: string;
}

/** グループの見出しとトラックの一覧。トラックが無いときは何も描かない */
function CatalogTrackGroup({ label, tracks, trackNamespace, cardClass }: CatalogTrackGroupProps) {
  if (tracks.length === 0) {
    return null;
  }
  return (
    <div>
      <div class="text-xs font-semibold text-slate-500 mb-0.5">
        {label} ({tracks.length})
      </div>
      <div class="space-y-1">
        {tracks.map((track, index) => (
          <CatalogTrackRow
            key={index}
            track={track}
            trackNamespace={trackNamespace}
            cardClass={cardClass}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * catalog の Track の一覧
 *
 * Track をメディア (`packaging: "loc"`) とデータ (それ以外) に分けて並べる
 * (§5.2.4)。グループの見出しには件数を出す。Track ごとに、1 行目へ namespace を
 * 含む Full Track Name を出し (draft-ietf-moq-transport-21 §8.8)、2 行目以降へ
 * 残りのキーと値を 1 組ずつ横に詰めて並べる。幅が足りない分だけ折り返す。高さは
 * Track の数と中身に合わせ、欄の中でスクロールさせない (映像と音声の Track を
 * 一目で読める)。長い値 (initRef など) は 1 組の幅に収めて省き、全文はマウスを
 * 重ねると出る。catalog を受け取る前も欄を描き、値を「-」にする。
 *
 * track name 単体 (`name`) は 1 行目の Full Track Name に含まれるため出さない
 */
export function CatalogTracks({ tracks, trackNamespace, tone, testId }: CatalogTracksProps) {
  const classes = TONE_CLASSES[tone];
  const mediaTracks = tracks.filter((track) => resolveTrackGroup(track) === "media");
  const dataTracks = tracks.filter((track) => resolveTrackGroup(track) === "data");
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
      <div class="space-y-1.5" data-testid={`${testId}-tracks`}>
        {tracks.length === 0 ? (
          <div class="text-xs text-slate-400">-</div>
        ) : (
          <>
            <CatalogTrackGroup
              label="Media"
              tracks={mediaTracks}
              trackNamespace={trackNamespace}
              cardClass={classes.card}
            />
            <CatalogTrackGroup
              label="Data"
              tracks={dataTracks}
              trackNamespace={trackNamespace}
              cardClass={classes.card}
            />
          </>
        )}
      </div>
    </div>
  );
}
