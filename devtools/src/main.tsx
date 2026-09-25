import { render } from "preact";
import { App } from "./App";
import { initFromUrl, mode } from "./signals/connectionSettings";
import * as sub from "./signals/subscriber";
import { initTestApi } from "./testApi";
import "./index.css";

// URL のクエリパラメータから設定を読み込む
initFromUrl(window.location.search);

// テスト用 API を初期化 (window.moqtDevTools を公開)
initTestApi();

// 初期化: Publisher 以外のモードでは最初の Subscriber を作成する。
// publisher モードは Publisher だけのページのため、Subscriber を 1 つも作らない
if (mode.value !== "publisher" && sub.subscriberIds.value.length === 0) {
  sub.addSubscriber();
}

const root = document.getElementById("app");
if (root) {
  render(<App />, root);
}
