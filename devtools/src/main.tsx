import { render } from "preact";
import { App } from "./App";
import { initFromUrl, mode, savedServerUrl, url } from "./signals/connectionSettings";
import * as sub from "./signals/subscriber";
import { initTestApi } from "./testApi";
import { queryServerUrl, readStoredServerUrl } from "./utils/serverUrlStore";
import "./index.css";

async function start(): Promise<void> {
  const search = window.location.search;
  // クエリの url が無いときだけ、Save で残した Relay URI を戻す
  if (queryServerUrl(search) === null) {
    const stored = await readStoredServerUrl();
    if (stored !== null) {
      url.value = stored;
      savedServerUrl.value = stored;
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
