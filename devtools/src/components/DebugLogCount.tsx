import { getLogBuffer, logSequence } from "../signals/debugLog";

/**
 * ツールバーに出すログの件数
 *
 * ログの連番を読むのは件数を出すコンポーネントだけに閉じる。パネル本体 (`DebugPanel`) が
 * 読むと、1 件追加するたびにパネル全体が再描画される。
 */
export function DebugLogCount() {
  // 追加・クリアで件数を出し直すため連番を購読する。値自体は使わない
  void logSequence.value;
  return getLogBuffer().length;
}

/**
 * Debug ボタンに出す件数のバッジ
 *
 * ログが無いときは何も描かない (赤い丸だけが残らないようにする)。
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
