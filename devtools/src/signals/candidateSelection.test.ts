import { test, assert } from "vite-plus/test";
import * as settings from "./connectionSettings";
import * as pub from "./publisher";
import {
  appendCandidateSelections,
  applyCandidateSelectionsFromUrl,
  PUBLISHER_CANDIDATE_QUERY_KEY,
  SUBSCRIBER_CANDIDATES_QUERY_KEY,
  takeInitialSubscriberCandidateSelection,
} from "./candidateSelection";
import { AUTO_CANDIDATE_SELECTION } from "../utils/candidateSelection";

const RELAY_A = "moqt://relay-a.example:4443/";
const RELAY_B = "moqt://relay-b.example:4443/";

// テスト間で候補と選択を持ち越さないためのリセット
function resetCandidateSelectionTestState(): void {
  applyCandidateSelectionsFromUrl("");
  settings.serverUrlCandidates.value = [];
  settings.serverUrlCandidatesSuspended.value = false;
}

/** 有効な候補を 2 件登録する */
function setTwoEnabledCandidates(): void {
  settings.serverUrlCandidates.value = [
    { url: RELAY_A, enabled: true },
    { url: RELAY_B, enabled: true },
  ];
}

test("applyCandidateSelectionsFromUrl: Publisher と購読ごとの固定を復元する", () => {
  resetCandidateSelectionTestState();
  setTwoEnabledCandidates();
  const search = new URLSearchParams({
    [PUBLISHER_CANDIDATE_QUERY_KEY]: RELAY_A,
    [SUBSCRIBER_CANDIDATES_QUERY_KEY]: JSON.stringify([null, RELAY_B]),
  }).toString();

  applyCandidateSelectionsFromUrl(search);

  assert.deepEqual(pub.pubCandidateSelection.value, { mode: "fixed", url: RELAY_A });
  // Subscriber は作られた順に取り出す
  assert.deepEqual(takeInitialSubscriberCandidateSelection(), AUTO_CANDIDATE_SELECTION);
  assert.deepEqual(takeInitialSubscriberCandidateSelection(), { mode: "fixed", url: RELAY_B });
  assert.deepEqual(takeInitialSubscriberCandidateSelection(), AUTO_CANDIDATE_SELECTION);

  resetCandidateSelectionTestState();
});

test("applyCandidateSelectionsFromUrl: 無効な候補と壊れた値は無視する", () => {
  resetCandidateSelectionTestState();
  settings.serverUrlCandidates.value = [
    { url: RELAY_A, enabled: true },
    { url: RELAY_B, enabled: false },
  ];
  const search = new URLSearchParams({
    [PUBLISHER_CANDIDATE_QUERY_KEY]: RELAY_B,
    [SUBSCRIBER_CANDIDATES_QUERY_KEY]: "not-json",
  }).toString();

  applyCandidateSelectionsFromUrl(search);

  assert.deepEqual(pub.pubCandidateSelection.value, AUTO_CANDIDATE_SELECTION);
  assert.deepEqual(takeInitialSubscriberCandidateSelection(), AUTO_CANDIDATE_SELECTION);

  resetCandidateSelectionTestState();
});

test("appendCandidateSelections: 固定した選択だけを URL に載せる", () => {
  resetCandidateSelectionTestState();
  setTwoEnabledCandidates();
  pub.pubCandidateSelection.value = { mode: "fixed", url: RELAY_A };

  const search = appendCandidateSelections("url=&urlCandidates=x", [
    AUTO_CANDIDATE_SELECTION,
    { mode: "fixed", url: RELAY_B },
  ]);

  const params = new URLSearchParams(search);
  assert.equal(params.get(PUBLISHER_CANDIDATE_QUERY_KEY), RELAY_A);
  assert.equal(params.get(SUBSCRIBER_CANDIDATES_QUERY_KEY), JSON.stringify([null, RELAY_B]));
  // 元のクエリは残す
  assert.equal(params.get("urlCandidates"), "x");

  resetCandidateSelectionTestState();
});

test("appendCandidateSelections: 固定が無ければパラメータを載せない", () => {
  resetCandidateSelectionTestState();
  setTwoEnabledCandidates();

  const search = appendCandidateSelections("url=", [AUTO_CANDIDATE_SELECTION]);
  const params = new URLSearchParams(search);
  assert.isNull(params.get(PUBLISHER_CANDIDATE_QUERY_KEY));
  assert.isNull(params.get(SUBSCRIBER_CANDIDATES_QUERY_KEY));

  resetCandidateSelectionTestState();
});

test("appendCandidateSelections: 候補が 1 件のときは選択を載せない", () => {
  resetCandidateSelectionTestState();
  settings.serverUrlCandidates.value = [{ url: RELAY_A, enabled: true }];
  pub.pubCandidateSelection.value = { mode: "fixed", url: RELAY_A };

  const search = appendCandidateSelections("url=", [{ mode: "fixed", url: RELAY_A }]);
  const params = new URLSearchParams(search);
  assert.isNull(params.get(PUBLISHER_CANDIDATE_QUERY_KEY));
  assert.isNull(params.get(SUBSCRIBER_CANDIDATES_QUERY_KEY));

  resetCandidateSelectionTestState();
});

test("appendCandidateSelections: 共有リンクの接続先を開いている page では選択を載せない", () => {
  resetCandidateSelectionTestState();
  setTwoEnabledCandidates();
  settings.serverUrlCandidatesSuspended.value = true;
  pub.pubCandidateSelection.value = { mode: "fixed", url: RELAY_A };

  const search = appendCandidateSelections("url=", [{ mode: "fixed", url: RELAY_B }]);
  const params = new URLSearchParams(search);
  assert.isNull(params.get(PUBLISHER_CANDIDATE_QUERY_KEY));
  assert.isNull(params.get(SUBSCRIBER_CANDIDATES_QUERY_KEY));

  resetCandidateSelectionTestState();
});
