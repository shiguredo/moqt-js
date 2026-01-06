import { render } from "preact";
import { App } from "./App";
import { initFromUrl } from "./signals/connectionSettings";
import { initTestApi } from "./testApi";
import "./index.css";

// URL のクエリパラメータから設定を読み込む
initFromUrl();

// テスト用 API を初期化 (window.moqtDevTools を公開)
initTestApi();

const root = document.getElementById("app");
if (root) {
  render(<App />, root);
}
