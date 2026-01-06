import { signal } from "@preact/signals";

// デバッグパネルの開閉状態
export const isDebugPanelOpen = signal(false);

export function toggleDebugPanel() {
  isDebugPanelOpen.value = !isDebugPanelOpen.value;
}

export function openDebugPanel() {
  isDebugPanelOpen.value = true;
}

export function closeDebugPanel() {
  isDebugPanelOpen.value = false;
}
