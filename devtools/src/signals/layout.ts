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

/**
 * ライトボックス表示している映像のキー
 *
 * 映像はページの一部として小さく表示されているため、そのままでは画質を確かめにくい。
 * 押した映像だけをページの上に重ねて広く表示する。同時に開くのは 1 枚だけにしたいので、
 * どの映像を開いているかをここで持つ。null のときは開いていない
 *
 * Publisher と Subscriber で別の映像を開けるが、キーは呼び出し側が映像ごとの一意な値
 * (例: "publisher-video" / "subscriber-video-<id>") を渡す
 */
export const lightboxVideoKey = signal<string | null>(null);

/** 映像をライトボックス表示する (別の映像が開いていれば置き換える) */
export function openVideoLightbox(key: string): void {
  lightboxVideoKey.value = key;
}

/** ライトボックス表示を閉じる */
export function closeVideoLightbox(): void {
  lightboxVideoKey.value = null;
}
