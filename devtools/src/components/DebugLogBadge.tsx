import { getLogBuffer, logSequence } from "../signals/debugLog";

/**
 * Debug ボタンに出すログ件数のバッジ
 *
 * ログが無いときは何も描かない (赤い丸だけが残らないようにする)。
 * 件数を読むのはこのコンポーネントだけに閉じるため、ログを追加しても App は再描画されない。
 */
export function DebugLogBadge() {
  void logSequence.value;
  const count = getLogBuffer().length;
  if (count === 0) {
    return null;
  }
  return (
    <span
      data-testid="debug-log-badge"
      class="bg-red-500 text-white text-xs font-bold rounded-full min-w-[24px] h-6 flex items-center justify-center px-1.5"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
