/**
 * 音声の再生の開始・停止の判定 (audioPlaybackLifecycle) の単体テスト
 *
 * 判定はオブジェクトの同一性だけを見る。ブラウザ API を使わず、同一性のトークンとして
 * 名前を持つだけのオブジェクトを渡して検証する (モックやスタブは使わない)。判定の
 * 組み合わせはテーブルで列挙し、同じ形の別オブジェクトが同一視されないことも固定する。
 */

import { test, assert } from "vite-plus/test";
import {
  discardStaleAudioPlaybackStart,
  isAudioPlaybackStartCurrent,
  playoutToKeepAfterStop,
  settleAudioPlaybackStart,
  shouldAttachAudioPlayback,
} from "./audioPlaybackLifecycle";

/** 判定に渡す同一性のトークンを作る (中身は見られない) */
function makeToken(name: string): { readonly name: string } {
  return { name };
}

// 判定はすべて「開始・停止に使ったオブジェクトが今も同じか」で決まる。同形でも別参照は
// 同一とみなさず、停止中は有効としない
test("音声再生の判定: 同一性・停止中・対象外を一覧で固定する", () => {
  const started = makeToken("started");
  const other = makeToken("other");
  const stopping = makeToken("stopping");
  const sameShape = makeToken("stopping");
  const cases: Array<[string, unknown, unknown]> = [
    ["playout: 停止した入口と同じ", playoutToKeepAfterStop(stopping, stopping), null],
    ["playout: 作り直された入口", playoutToKeepAfterStop(started, stopping), started],
    ["playout: 同形の別参照", playoutToKeepAfterStop(sameShape, stopping), sameShape],
    ["attach: 再生中", shouldAttachAudioPlayback(started, false), true],
    ["attach: 停止の drain 中", shouldAttachAudioPlayback(started, true), false],
    ["attach: 再生中の graph が無い", shouldAttachAudioPlayback(null, false), false],
    ["start: 開始の graph が今も対象", isAudioPlaybackStartCurrent(started, started, false), true],
    ["start: 停止の drain 中", isAudioPlaybackStartCurrent(started, started, true), false],
    ["start: 停止完了で対象が外れた", isAudioPlaybackStartCurrent(null, started, false), false],
    ["start: 新しい開始に置き換わった", isAudioPlaybackStartCurrent(other, started, false), false],
  ];
  for (const [label, actual, expected] of cases) {
    assert.strictEqual(actual, expected, label);
  }
});

// 開始→判定→確定の順序は E2E では作れないため、注入した関数の呼び出しで固定する。
// 停止 drain 中は Context を閉じず (停止側に任せる)、置き換えられたら自分の Context だけ
// 閉じ、今の再生のときだけ確定する
test("settleAudioPlaybackStart: 判定に応じて確定・破棄・何もしないを選ぶ", async () => {
  const cases = [
    { label: "今の再生", isCurrent: true, isStopping: false, expected: ["commit"], settled: true },
    { label: "停止の drain 中", isCurrent: true, isStopping: true, expected: [], settled: false },
    {
      label: "置き換えられた",
      isCurrent: false,
      isStopping: false,
      expected: ["discard"],
      settled: false,
    },
  ];
  for (const c of cases) {
    const calls: string[] = [];
    const settled = await settleAudioPlaybackStart({
      isCurrent: c.isCurrent,
      isStopping: c.isStopping,
      commit: () => calls.push("commit"),
      discard: async () => {
        calls.push("discard");
      },
    });
    assert.equal(settled, c.settled, c.label);
    assert.deepEqual(calls, c.expected, `${c.label} の後始末`);
  }
});

test("discardStaleAudioPlaybackStart: 停止の drain 中は Context を閉じない", async () => {
  const calls: string[] = [];
  await discardStaleAudioPlaybackStart(true, async () => {
    calls.push("discard");
  });
  assert.deepEqual(calls, [], "停止側が Context を閉じるため、ここでは閉じないこと");
  await discardStaleAudioPlaybackStart(false, async () => {
    calls.push("discard");
  });
  assert.deepEqual(calls, ["discard"], "置き換えられた開始は自分の Context だけ閉じること");
});
