import { render } from "preact";
import { App } from "./app";
import "./index.css";

const root = document.getElementById("app");
if (root === null) {
  throw new Error("app root element is missing");
}

/**
 * shaka-player の experimental build を読み込む。
 *
 * defer の classic script と module script の実行順に依存すると、window.shaka が
 * 未定義のまま画面が描画され、「experimental build is missing」と表示されることがある。
 * アプリの描画前に明示的に読み込み、失敗した場合だけ missing を出す。
 */
async function loadShakaPlayer(): Promise<void> {
  if (window.shaka !== undefined) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL("./shaka-player.experimental.js", document.baseURI).href;
    script.onload = () => {
      resolve();
    };
    script.onerror = () => {
      reject(new Error("failed to load shaka-player"));
    };
    document.head.append(script);
  });
}

try {
  await loadShakaPlayer();
} catch (error) {
  console.error("failed to load shaka-player", error);
}
render(<App />, root);
