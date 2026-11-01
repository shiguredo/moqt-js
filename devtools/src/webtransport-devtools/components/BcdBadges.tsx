import { bcdSupportEntries, type BcdBrowserSupport, type BcdSupportName } from "../bcd";

/**
 * 1 ブラウザ分の対応バッジ
 * - null: 未対応 (赤の "-")
 * - "preview": プレビュー版でのみ対応 (琥珀の "preview")
 * - バージョン文字列: 対応開始バージョン (緑の "x+")
 */
function BrowserSupportBadge({ label, version }: { label: string; version: BcdBrowserSupport }) {
  if (version === null) {
    return (
      <span class="px-1.5 py-0.5 text-[10px] rounded bg-red-100 text-red-600 font-medium">
        {label}: -
      </span>
    );
  }
  if (version === "preview") {
    return (
      <span class="px-1.5 py-0.5 text-[10px] rounded bg-amber-100 text-amber-700 font-medium">
        {label}: preview
      </span>
    );
  }
  return (
    <span class="px-1.5 py-0.5 text-[10px] rounded bg-green-100 text-green-700 font-medium">
      {label}: {version}+
    </span>
  );
}

/**
 * ブラウザ対応バッジ
 * BCD (MDN Browser Compat Data) に基づく対応状況を表示する
 */
export function BcdBadges({ name }: { name: BcdSupportName }) {
  const entry = bcdSupportEntries.find((e) => e.name === name);
  if (!entry) return null;

  return (
    <span class="inline-flex items-center gap-1" title={entry.notes ?? `W3C ${entry.section}`}>
      <BrowserSupportBadge label="Chrome" version={entry.chrome} />
      <BrowserSupportBadge label="Firefox" version={entry.firefox} />
      <BrowserSupportBadge label="Safari" version={entry.safari} />
      {entry.experimental === true && (
        <span class="px-1.5 py-0.5 text-[10px] rounded bg-purple-100 text-purple-700 font-medium">
          experimental
        </span>
      )}
    </span>
  );
}
