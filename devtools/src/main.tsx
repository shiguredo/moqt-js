import { render } from "preact";
import { App } from "./App";
import {
  applyRelayUriInput,
  initFromUrl,
  mode,
  savedServerUrl,
} from "./signals/connectionSettings";
import * as sub from "./signals/subscriber";
import { initTestApi } from "./testApi";
import { startPreconditionWatch } from "./signals/preconditionWatch";
import { queryServerUrl, readStoredServerUrl } from "./utils/serverUrlStore";
import "./index.css";

async function start(): Promise<void> {
  const search = window.location.search;
  // クエリの url が無いときだけ、Save で残した MOQT URI を戻す
  if (queryServerUrl(search) === null) {
    const stored = await readStoredServerUrl();
    if (stored !== null) {
      // fragment を URI Fragment 欄へ映し、c4m の取り込みと msf fragment の namespace の
      // 固定も行う
      applyRelayUriInput(stored);
      savedServerUrl.value = stored;
    }
  }

  // URL のクエリパラメータから設定を読み込む
  initFromUrl(search);

  // テスト用 API を初期化 (window.moqtDevTools を公開)
  initTestApi();

  // A/V 同期と再生の判断が前提から外れていないかの判定を始める (1 秒ごと)。パネルの
  // 開け閉めや購読の有無に依らず動かし、「Copy for LLM」にも同じ値を出す
  startPreconditionWatch();

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
