import { useEffect, useRef, useState } from "preact/hooks";

interface CopyButtonProps {
  value: string;
  testId: string;
  label: string;
}

/**
 * 入力欄の値をクリップボードへコピーする小さなボタン。
 *
 * 配信中は接続設定の入力欄を編集できないが、値を確認してコピーしたいことがある。
 * `disabled` の入力欄は選択もできないため、値のコピー手段をボタンとして独立させる。
 */
export function CopyButton({ value, testId, label }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handleClick = async (): Promise<void> => {
    if (value === "") {
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(() => {
        setCopied(false);
        timerRef.current = null;
      }, 1500);
    } catch {
      // クリップボード API が使えない環境では表示だけ変えずに終了する
    }
  };

  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      disabled={value === ""}
      onClick={() => void handleClick()}
      class="shrink-0 px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white text-slate-700 hover:bg-slate-50 disabled:bg-slate-100 disabled:text-slate-400 disabled:cursor-not-allowed transition-colors"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}
