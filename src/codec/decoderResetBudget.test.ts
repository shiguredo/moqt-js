/**
 * 映像デコーダーの復帰予算のテスト
 *
 * 上限 (3 回)・復帰 (予算が 0 に戻る)・0 未満防止を固定する。
 * 上限の値そのものが契約であるため、期待値には定数ではなく 3 を直接書く。
 * 残りの回数は tryConsume() の結果 (true が続く回数と次に false になること) で判定する
 * (テストからしか使わない getter をプロダクション側に置かない)。
 * 再初期化そのもの (WebCodecs と Worker) はブラウザ依存のため実行できず、
 * デコーダー側の配線は実ブラウザの e2e で確認する。
 */

import { test, assert } from "vite-plus/test";
import { DecoderResetBudget } from "./decoderResetBudget";

test("DecoderResetBudget: 上限の 3 回まで再初期化でき、4 回目で false になる", () => {
  // 復号フレームを得ないまま再初期化を繰り返す状態を上限で打ち切る。
  // 上限は 3 回であり、その次の 1 回だけが拒否される
  const budget = new DecoderResetBudget();

  assert.isTrue(budget.tryConsume());
  assert.isTrue(budget.tryConsume());
  assert.isTrue(budget.tryConsume());
  assert.isFalse(budget.tryConsume());
});

test("DecoderResetBudget: 上限に達した後は消費が 0 未満にならない", () => {
  // 上限後の tryConsume は何も消費せず false を返し続ける。拒否が消費を減らす実装だと
  // 残り回数が負になり、次の呼び出しが再び成功する (上限の判定が呼び出し回数に依存する)
  const budget = new DecoderResetBudget();
  for (let index = 0; index < 3; index++) {
    assert.isTrue(budget.tryConsume());
  }

  for (let index = 0; index < 10; index++) {
    assert.isFalse(budget.tryConsume());
  }
});

test("DecoderResetBudget: restore で予算が戻り、再び上限まで消費できる", () => {
  // 復号フレームの出力と参照の異なる設定での configure が予算を戻す。
  // 戻った後は同じ上限まで再初期化できる
  const budget = new DecoderResetBudget();
  for (let index = 0; index < 3; index++) {
    assert.isTrue(budget.tryConsume());
  }
  assert.isFalse(budget.tryConsume());

  budget.restore();
  // 復帰の直後は消費が 0 に戻っているため、再び 3 回が成功して 4 回目が false になる
  for (let index = 0; index < 3; index++) {
    assert.isTrue(budget.tryConsume());
  }
  assert.isFalse(budget.tryConsume());
});

test("DecoderResetBudget: restore を繰り返しても上限を超えない", () => {
  // 復帰は消費を 0 に戻すだけであり、上限を増やさない。
  // 復帰のたびに上限が増えると、恒久エラーで再生成が止まらない
  const budget = new DecoderResetBudget();
  for (let index = 0; index < 5; index++) {
    budget.restore();
    // 何度復帰しても、成功するのは 3 回までで 4 回目は false になる
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.isTrue(budget.tryConsume());
    }
    assert.isFalse(budget.tryConsume());
  }
});

test("DecoderResetBudget: 複数インスタンスは独立する", () => {
  // デコーダーごとに予算を持つ。片方の消費が他方に影響しない
  const first = new DecoderResetBudget();
  const second = new DecoderResetBudget();

  for (let index = 0; index < 3; index++) {
    assert.isTrue(first.tryConsume());
  }
  assert.isFalse(first.tryConsume());
  // 他方は消費されていないため、上限の 3 回が成功して 4 回目が false になる
  for (let index = 0; index < 3; index++) {
    assert.isTrue(second.tryConsume());
  }
  assert.isFalse(second.tryConsume());
});
