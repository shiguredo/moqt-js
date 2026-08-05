import { bcdSupportEntries } from "../bcd";

/**
 * ブラウザ対応バッジ
 * BCD (MDN Browser Compat Data) に基づく対応状況を表示する
 */
export function BcdBadges({ name }: { name: string }) {
  const entry = bcdSupportEntries.find((e) => e.name === name);
  if (!entry) return null;

  const badge = (label: string, version: string | null) => {
    if (version === null) {
      return (
        <span class="px-1.5 py-0.5 text-[10px] rounded bg-red-100 text-red-600 font-medium">
          {label}: -
        </span>
      );
    }
    return (
      <span class="px-1.5 py-0.5 text-[10px] rounded bg-green-100 text-green-700 font-medium">
        {label}: {version}+
      </span>
    );
  };

  return (
    <span class="inline-flex items-center gap-1">
      {badge("Chrome", entry.chrome)}
      {badge("Firefox", entry.firefox)}
      {badge("Safari", entry.safari)}
    </span>
  );
}
