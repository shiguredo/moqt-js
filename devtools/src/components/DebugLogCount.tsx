import { getLogBuffer, logSequence } from "../signals/debugLog";

/**
 * ツールバーに出すログの件数
 *
 * パネル本体 (`DebugPanel`) にログの連番を読ませないためのコンポーネントである。
 * 本体が読むと、1 件追加するたびにパネル全体が再描画される。
 */
export function DebugLogCount() {
  // 追加・クリアで件数を出し直すため連番を購読する。値自体は使わない
  void logSequence.value;
  return getLogBuffer().length;
}
