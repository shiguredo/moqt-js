import { enabledServerUrlCandidateUrls, namespaceArray, url } from "../signals/connectionSettings";
import { pubSelectedServerUrl } from "../signals/publisher";
import * as sub from "../signals/subscriber";

/**
 * moqt-devtools のヘッダーに並べる Shaka Player へのツールリンク。
 *
 * 接続設定を読むのはこのコンポーネントの中だけに閉じ込める。`App` の関数本体で
 * signal を読むと、設定を 1 文字変えるたびに `App` 全体が再実行されるため。
 * Publisher / Subscriber が接続に使った relay、無ければ有効な候補の先頭を選び、
 * Shaka Player 向けに / 区切りへ直した namespace と一緒にクエリへ載せる。
 */
export function ShakaPlayerLink() {
  const params = new URLSearchParams();
  const publisherUrl = pubSelectedServerUrl.value;
  let relayUrl: string;
  if (publisherUrl !== null && publisherUrl !== "") {
    relayUrl = publisherUrl;
  } else {
    relayUrl = firstSubscriberRelayUrl() ?? enabledServerUrlCandidateUrls.value[0] ?? url.value;
  }
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

/** Subscriber が接続に使った relay のうち、最初に見つかったものを返す。 */
function firstSubscriberRelayUrl(): string | null {
  for (const id of sub.subscriberIds.value) {
    const selected = sub.subscriberInstances.value.get(id)?.selectedServerUrl.value ?? null;
    if (selected !== null && selected !== "") {
      return selected;
    }
  }
  return null;
}
