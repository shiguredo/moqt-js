import { namespaceArray, url } from "../signals/connectionSettings";
import { pubSelectedServerUrl } from "../signals/publisher";

/**
 * moqt-devtools のヘッダーに並べる Shaka Player へのツールリンク。
 *
 * 接続設定を読むのはこのコンポーネントの中だけに閉じ込める。`App` の関数本体で
 * signal を読むと、設定を 1 文字変えるたびに `App` 全体が再実行されるため。
 * Publisher が接続に使った relay と、Shaka Player 向けに / 区切りへ直した
 * namespace をクエリに載せる。
 */
export function ShakaPlayerLink() {
  const params = new URLSearchParams();
  const relayUrl = pubSelectedServerUrl.value ?? url.value;
  if (relayUrl !== "") {
    params.set("url", relayUrl);
  }
  const shakaNamespace = namespaceArray.value.join("/");
  if (shakaNamespace !== "") {
    params.set("namespace", shakaNamespace);
  }
  const query = params.toString();
  return (
    <a
      href={`/shaka-player.html${query === "" ? "" : `?${query}`}`}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="shaka-player-link"
      class="text-blue-500 hover:text-blue-600 underline"
    >
      Shaka Player
    </a>
  );
}
