import { useRef, useEffect } from "preact/hooks";

/**
 * メッセージリストの自動スクロール用フック
 */
export function useAutoScroll(deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, deps);

  return ref;
}
