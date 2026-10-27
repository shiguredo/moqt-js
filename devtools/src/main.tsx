import { render } from "preact";
import { App } from "./App";
import { initFromUrl, mode, serverUrlCandidates } from "./signals/connectionSettings";
import { applyCandidateSelectionsFromUrl } from "./signals/candidateSelection";
import * as sub from "./signals/subscriber";
import { initTestApi } from "./testApi";
import { startPreconditionWatch } from "./signals/preconditionWatch";
import { readServerUrlEntries } from "./utils/serverUrlStore";
import "./index.css";

async function start(): Promise<void> {
  // OPFS に保存した接続先の候補を読む。URI 欄は候補の表示欄なので、ここでは URI 欄へ
  // 適用しない (接続のたびに候補から選ぶ)
  serverUrlCandidates.value = await readServerUrlEntries();

  // URL のクエリパラメータから設定を読み込む
  initFromUrl(window.location.search);
  // パネルごとの接続先の選択 (自動 / 固定) は接続設定とは別に復元する。候補の一覧を
  // 読み込んだ後でないと有効な候補を判定できないため、initFromUrl の後に呼ぶ
  applyCandidateSelectionsFromUrl(window.location.search);

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
