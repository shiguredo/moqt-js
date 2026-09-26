import { buildQueryStringForMode, mode, MODES } from "../signals/connectionSettings";
import type { DevtoolsMode } from "../types";

// ヘッダーの副題に並べる表示モードの表示名。並びは MODES の順にする
const MODE_LABELS: Record<DevtoolsMode, string> = {
  both: "Publisher & Subscriber",
  publisher: "Publisher",
  subscriber: "Subscriber",
};

/**
 * ヘッダーの副題 (Media over QUIC Transport - ...) の行
 *
 * ほかのモードへのリンクは、今の接続設定を載せた URL を新しいタブで開く。`href` を
 * 今の設定に追従させるため `buildQueryStringForMode` が接続設定の signal を読むので、
 * この購読をこのコンポーネントの中だけに閉じ込める。`App` の中で読むと、設定を
 * 1 文字変えるたびに `App` とその子の関数本体が再実行される。
 */
export function ModeSubtitle() {
  // 今のモードは太字にし、リンクにしない。ページの中に切り替えの UI を
  // 置かないため、この表示が今のモードを知る唯一の手がかりになる
  const currentMode = mode.value;

  return (
    <p class="text-slate-500 mt-1">
      Media over QUIC Transport -{" "}
      {MODES.map((targetMode, index) => (
        <span key={targetMode}>
          {index > 0 && <span class="text-slate-300"> | </span>}
          {targetMode === currentMode ? (
            <strong class="text-slate-700">{MODE_LABELS[targetMode]}</strong>
          ) : (
            // 他のモードは今の接続設定を載せた URL を新しいタブで開く。href を
            // 今の設定に追従させ、押す前にブラウザのメニューからコピーできるようにする
            <a
              href={`?${buildQueryStringForMode(targetMode)}`}
              target="_blank"
              rel="noopener noreferrer"
              data-testid={`mode-link-${targetMode}`}
              class="text-blue-500 hover:text-blue-600 underline"
            >
              {MODE_LABELS[targetMode]}
            </a>
          )}
        </span>
      ))}
    </p>
  );
}
