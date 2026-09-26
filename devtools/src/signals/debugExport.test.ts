import { test, assert, beforeEach } from "vite-plus/test";
import {
  buildAllExportText,
  buildPublisherExportText,
  buildSubscriberExportText,
} from "./debugExport";
import { __resetLogStateForTest, addLog, clearLog } from "./debugLog";
import * as pub from "./publisher";
import { addSubscriber, removeSubscriber, subscriberInstances } from "./subscriber";

/**
 * Copy for LLM の本文の組み立て
 *
 * どの節を出すかはここで決める。項目の整形は `utils/debugExportText.ts` が行うため、
 * このテストは節の選択と絞り込みだけを見る。
 */

/** Publisher の状態を既定値へ戻す (前のテストの値を持ち越さない) */
function resetPublisherState(): void {
  pub.pubStatus.value = "disconnected";
  pub.pubCodec.value = "";
  pub.framesEncoded.value = 0;
  pub.catalog.value = null;
}

beforeEach(() => {
  __resetLogStateForTest();
  resetPublisherState();
  // 削除で Map が置き換わるため、先に ID を控えてから消す
  for (const id of Array.from(subscriberInstances.value.keys())) {
    removeSubscriber(id);
  }
});

test("buildAllExportText: 配信していないときは Publisher の節を出さず、ログは全部出す", () => {
  // 起動したまま何も配信していないページでは、全て 0 の統計を出しても読む側の役に立たない
  addLog("info", "[publisher] [SEND] SETUP");
  addLog("info", "[subscriber-1] [RECV] SETUP");

  const text = buildAllExportText();

  assert.include(text, "=== Connection Settings ===");
  assert.notInclude(text, "Publisher Statistics");
  assert.include(text, "=== Debug Logs ===");
  assert.include(text, "[publisher] [SEND] SETUP");
  assert.include(text, "[subscriber-1] [RECV] SETUP");
});

test("buildAllExportText: 配信を始めたら Publisher の節を出す", () => {
  // 配信を始めたかどうかは、状態・codec・符号化したフレーム数・Catalog のどれかで分かる
  const usedStates: [string, () => void][] = [
    ["状態が接続済み", () => (pub.pubStatus.value = "connected")],
    ["codec が決まっている", () => (pub.pubCodec.value = "vp8")],
    ["フレームを符号化した", () => (pub.framesEncoded.value = 1)],
    // tracks が空でも Catalog を受け取ったこと自体が配信の開始を意味する
    ["Catalog を送った", () => (pub.catalog.value = { version: "draft-01", tracks: [] })],
  ];

  for (const [label, markUsed] of usedStates) {
    resetPublisherState();
    markUsed();
    assert.include(buildAllExportText(), "=== Publisher Statistics ===", label);
  }
});

test("buildAllExportText: Subscriber ごとに節を出す", () => {
  const first = addSubscriber();
  const second = addSubscriber();

  const text = buildAllExportText();

  assert.include(text, `=== Subscriber Statistics (${first}) ===`);
  assert.include(text, `=== Subscriber Statistics (${second}) ===`);
});

test("buildPublisherExportText: Publisher の節と [publisher] のログだけを出す", () => {
  pub.framesEncoded.value = 3;
  addLog("info", "[publisher] [SEND] OBJECT");
  addLog("info", "[subscriber-1] [RECV] OBJECT");

  const text = buildPublisherExportText();

  assert.include(text, "=== Publisher Statistics ===");
  assert.include(text, "framesEncoded: 3");
  assert.include(text, "=== Debug Logs ([publisher]) ===");
  assert.include(text, "[publisher] [SEND] OBJECT");
  // 他の Subscriber のログと統計は出さない
  assert.notInclude(text, "[subscriber-1] [RECV] OBJECT");
  assert.notInclude(text, "Subscriber Statistics");
});

test("buildSubscriberExportText: 指定した Subscriber の節と、その id のログだけを出す", () => {
  const target = addSubscriber();
  const other = addSubscriber();
  addLog("info", `[${target}] [RECV] OBJECT`);
  addLog("info", `[${other}] [RECV] OBJECT`);

  const text = buildSubscriberExportText(target);

  assert.include(text, `=== Subscriber Statistics (${target}) ===`);
  assert.include(text, `=== Debug Logs ([${target}]) ===`);
  assert.include(text, `[${target}] [RECV] OBJECT`);
  assert.notInclude(text, `[${other}] [RECV] OBJECT`);
  assert.notInclude(text, "Publisher Statistics");
});

test("buildSubscriberExportText: 見つからない id では接続設定とログだけを出す", () => {
  // 消した Subscriber のコピーボタンが残っていても本文は壊さない
  addLog("info", "[gone] [RECV] OBJECT");

  const text = buildSubscriberExportText("gone");

  assert.include(text, "=== Connection Settings ===");
  assert.notInclude(text, "Subscriber Statistics");
  assert.include(text, "=== Debug Logs ([gone]) ===");
});

test("buildAllExportText: ログを消しても節は残る", () => {
  // ログが無いときも設定と統計はコピーできる
  addLog("info", "before");
  clearLog();

  const text = buildAllExportText();

  assert.include(text, "=== Connection Settings ===");
  assert.include(text, "=== Debug Logs ===");
  assert.notInclude(text, "before");
});
