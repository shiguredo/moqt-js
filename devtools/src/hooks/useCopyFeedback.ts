import { useSignal, type Signal } from "@preact/signals";
import { useCallback, useEffect, useRef } from "preact/hooks";

const DEFAULT_DURATION_MS = 1500;

export interface UseCopyFeedbackResult {
  /**
   * 現在ハイライト中の marker key を表す signal。未コピー時は null。
   * 呼び出し側は `copy()` 経由でのみ書き換えること。
   */
  feedback: Signal<string | null>;
  /**
   * クリップボードへ書き込み、成功時のみ marker をセットして duration 経過後に null に戻す。
   * 失敗時は #0149 の方針に従い `console.error` のみで feedback は変更しない。
   * @returns クリップボード書き込みの成否
   */
  copy: (text: string, markerKey: string) => Promise<boolean>;
}

/**
 * コピー操作のフィードバック (Copied! 表示) を管理する hook。
 *
 * 連続クリック時の早消えとアンマウント後の signal 書き込みを防ぐため、
 * setTimeout ID を ref で保持し、再コピー時 / アンマウント時に clearTimeout する。
 * 失敗時は feedback を変更しない (#0149) ことで「Failed」表示は出さない方針を踏襲する。
 */
export function useCopyFeedback(durationMs: number = DEFAULT_DURATION_MS): UseCopyFeedbackResult {
  const feedback = useSignal<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => {
      clearTimeout(timerRef.current);
    };
  }, []);

  const copy = useCallback(
    async (text: string, markerKey: string): Promise<boolean> => {
      try {
        await navigator.clipboard.writeText(text);
        feedback.value = markerKey;
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          feedback.value = null;
        }, durationMs);
        return true;
      } catch (error) {
        console.error("failed to write to clipboard:", error);
        return false;
      }
    },
    [durationMs, feedback],
  );

  return { feedback, copy };
}
