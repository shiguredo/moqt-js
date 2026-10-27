import { test, assert } from "vite-plus/test";
import {
  AUTO_CANDIDATE_SELECTION,
  fixedCandidateUrl,
  formatSubscriberCandidateSelections,
  parseSubscriberCandidateSelections,
} from "./candidateSelection";

// 自動選択は URI を持たず、固定のときだけ URI を返す
test("fixedCandidateUrl: 固定のときだけ候補の URI を返す", () => {
  assert.isNull(fixedCandidateUrl(AUTO_CANDIDATE_SELECTION));
  assert.equal(
    fixedCandidateUrl({ mode: "fixed", url: "moqt://relay-a.example:4443/" }),
    "moqt://relay-a.example:4443/",
  );
});

// Copy URL の購読ごとの選択は、固定した URI と null (自動) の配列
test("parseSubscriberCandidateSelections: URI と null の配列を読む", () => {
  assert.deepEqual(parseSubscriberCandidateSelections('["moqt://relay-a.example:4443/",null]'), [
    "moqt://relay-a.example:4443/",
    null,
  ]);
  assert.deepEqual(parseSubscriberCandidateSelections("[]"), []);
});

// 壊れた値や、文字列と null 以外を含む値は選択を無視する (自動選択に戻す)
test("parseSubscriberCandidateSelections: 壊れた値は null を返す", () => {
  assert.isNull(parseSubscriberCandidateSelections("not-json"));
  assert.isNull(parseSubscriberCandidateSelections('{"url":"moqt://relay-a.example:4443/"}'));
  assert.isNull(parseSubscriberCandidateSelections("[1]"));
  assert.isNull(parseSubscriberCandidateSelections('["moqt://relay-a.example:4443/",{}]'));
});

// 購読ごとの選択は、固定した候補が 1 つも無ければ URL に載せない
test("formatSubscriberCandidateSelections: 固定が無ければ null、あれば位置を保つ", () => {
  assert.isNull(
    formatSubscriberCandidateSelections([AUTO_CANDIDATE_SELECTION, AUTO_CANDIDATE_SELECTION]),
  );
  assert.equal(
    formatSubscriberCandidateSelections([
      AUTO_CANDIDATE_SELECTION,
      { mode: "fixed", url: "moqt://relay-b.example:4443/" },
    ]),
    '[null,"moqt://relay-b.example:4443/"]',
  );
});
