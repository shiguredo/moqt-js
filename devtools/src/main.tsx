import { render } from "preact";
import { App } from "./App";
import { initFromUrl, mode, url } from "./signals/connectionSettings";
import * as sub from "./signals/subscriber";
import { initTestApi } from "./testApi";
import { noteQueryServerUrl, queryServerUrl, readStoredServerUrl } from "./utils/serverUrlStore";
import "./index.css";

async function start(): Promise<void> {
  const search = window.location.search;
  // 共有リンクの url は OPFS より優先し、覚えた値を上書きしない
  noteQueryServerUrl(search);
  if (queryServerUrl(search) === null) {
    const stored = await readStoredServerUrl();
    if (stored !== null) {
      url.value = stored;
    }
  }

  // URL のクエリパラメータから設定を読み込む
  initFromUrl(search);

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
}

void start();
