import { signal } from "@preact/signals";

// デバッグパネルの開閉状態
export const isDebugPanelOpen = signal(false);

// ログを追加したときに一覧を先頭 (最新) へスクロールするかどうか
export const autoScroll = signal(true);

export function toggleDebugPanel() {
  isDebugPanelOpen.value = !isDebugPanelOpen.value;
}

export function openDebugPanel() {
  isDebugPanelOpen.value = true;
}

export function closeDebugPanel() {
  isDebugPanelOpen.value = false;
}
