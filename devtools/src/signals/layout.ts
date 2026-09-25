import { signal } from "@preact/signals";
import { readStoredFlag, writeStoredFlag } from "../utils/storedFlag";

// 接続設定の欄の開け閉めを覚える localStorage のキー
const CONNECTION_SETTINGS_OPEN_KEY = "moqt-devtools.connectionSettingsOpen";

/**
 * 接続設定の欄が開いているか
 *
 * 既定は開く。開け閉めはブラウザに覚え、再読み込みしても同じ状態で始める
 * (覚えられないときは既定の開いた状態で始める)
 */
export const isConnectionSettingsOpen = signal(readStoredFlag(CONNECTION_SETTINGS_OPEN_KEY, true));

/** 接続設定の欄を開け閉めし、その状態を覚える */
export function toggleConnectionSettings(): void {
  const open = !isConnectionSettingsOpen.value;
  isConnectionSettingsOpen.value = open;
  writeStoredFlag(CONNECTION_SETTINGS_OPEN_KEY, open);
}
