/**
 * subscriberControlState の単体テスト
 *
 * 入力は 3 つの真偽値なので、8 通りをすべて確かめる。
 */

import { test, assert } from "vite-plus/test";
import { subscriberControlState } from "./subscriberControls";

// 何もしていない: Start Subscribing だけを押せる
test("subscriberControlState: 購読していないときは Start Subscribing だけを押せる", () => {
  assert.deepEqual(
    subscriberControlState({ subscribed: false, starting: false, stopping: false }),
    {
      active: false,
      startDisabled: false,
      stopDisabled: true,
    },
  );
});

// 購読を始めてから確立するまで (接続、catalog の待ち、decoder の構成、映像トラックの購読):
// 購読中として扱い、Stop で止められ、Start Subscribing を重ねて押せない
test("subscriberControlState: 購読の確立を待っている間は Stop だけを押せる", () => {
  assert.deepEqual(subscriberControlState({ subscribed: false, starting: true, stopping: false }), {
    active: true,
    startDisabled: true,
    stopDisabled: false,
  });
});

// 購読が確立した後: Stop だけを押せる
test("subscriberControlState: 購読中は Stop だけを押せる", () => {
  assert.deepEqual(subscriberControlState({ subscribed: true, starting: false, stopping: false }), {
    active: true,
    startDisabled: true,
    stopDisabled: false,
  });
  // 確立と開始中が同時に立っていても購読中である
  assert.deepEqual(subscriberControlState({ subscribed: true, starting: true, stopping: false }), {
    active: true,
    startDisabled: true,
    stopDisabled: false,
  });
});

// 停止処理の間はどちらも押せない (二重実行の防止)
test("subscriberControlState: 停止処理の間はどちらのボタンも押せない", () => {
  for (const subscribed of [false, true]) {
    for (const starting of [false, true]) {
      const state = subscriberControlState({ subscribed, starting, stopping: true });
      assert.isTrue(state.startDisabled, `subscribed=${subscribed} starting=${starting}`);
      assert.isTrue(state.stopDisabled, `subscribed=${subscribed} starting=${starting}`);
    }
  }
});
