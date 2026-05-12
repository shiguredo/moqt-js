import { useSignal, type Signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";

const RESET_DELAY_MS = 2000;
const LABEL_INITIAL = "Copy URL";
const LABEL_SUCCESS = "Copied!";
const LABEL_FAILED = "Failed";

export interface UseCopyUrlButtonResult {
  /**
   * ボタンに表示する文字列の signal。
   * 初期値は "Copy URL"、成功時に "Copied!"、失敗時に "Failed"、
   * 2 秒後に "Copy URL" に戻る。
   */
  buttonText: Signal<string>;
  /**
   * ボタン onClick に直接渡せる handler。
   * `buildQueryString()` の結果でクエリを構築し、`history.replaceState` で
   * URL を書き換えた上で `navigator.clipboard.writeText` を呼び出す。
   */
  copy: () => void;
}

/**
 * Copy URL ボタンの状態とハンドラを管理する hook。
 * 連続クリック時に古い timer を clearTimeout してから新規 setTimeout を予約することで、
 * 新しい「Copied!」表示が旧 timer に上書きされて早消えするのを防ぐ。
 * アンマウント時にも timer を解放する。
 *
 * @param buildQueryString 現在の設定からクエリ文字列を構築する関数。
 *   moqt-devtools と webtransport-devtools で実装が異なるため引数で受け取る。
 */
export function useCopyUrlButton(buildQueryString: () => string): UseCopyUrlButtonResult {
  const buttonText = useSignal(LABEL_INITIAL);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    return () => {
      clearTimeout(timerRef.current);
    };
  }, []);

  const scheduleReset = (): void => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      buttonText.value = LABEL_INITIAL;
    }, RESET_DELAY_MS);
  };

  const copy = (): void => {
    const queryString = buildQueryString();
    const fullUrl = `${window.location.origin}${window.location.pathname}?${queryString}`;
    window.history.replaceState(null, "", `?${queryString}`);
    navigator.clipboard.writeText(fullUrl).then(
      () => {
        buttonText.value = LABEL_SUCCESS;
        scheduleReset();
      },
      () => {
        buttonText.value = LABEL_FAILED;
        scheduleReset();
      },
    );
  };

  return { buttonText, copy };
}
