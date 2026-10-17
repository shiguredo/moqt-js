/**
 * 符号化の出力を送るかの判定の境界のテスト
 *
 * 依頼した時点の世代と現在の世代の比較で送るかどうかを決める。系列の性質は
 * encodeGeneration.prop.ts が確かめる (ここは境界だけを固定する)。
 */

import { test, assert } from "vite-plus/test";
import { recordEncodeGeneration, shouldSendEncodedChunk } from "./encodeGeneration";

test("shouldSendEncodedChunk: 記録が無い出力は送らない", () => {
  // 配信を始める前の出力、配信ごとの初期化で記録を消した後の出力
  const records = new Map<number, number>();

  assert.isFalse(shouldSendEncodedChunk(records, 0, 1000));
  assert.isFalse(shouldSendEncodedChunk(records, 3, 1000));
});

test("shouldSendEncodedChunk: 同じ timestamp の記録は後から来たもので上書きされる", () => {
  // 入力の timestamp が重複した場合。記録は後から来たものだけが残り、古い世代では送らない。
  // 本番では入力の timestamp は単調であり、停止をまたいで同じ値は現れない前提である
  // (現れた場合は、止める前に依頼した出力が現在の世代と一致して送られ得る)
  const records = new Map<number, number>();
  recordEncodeGeneration(records, 1, 500);
  recordEncodeGeneration(records, 2, 500);

  assert.isFalse(shouldSendEncodedChunk(records, 1, 500), "古い世代の記録で送っている");
  // 取り出した記録は消える
  assert.isFalse(shouldSendEncodedChunk(records, 2, 500), "取り出した記録が消えていない");
});
