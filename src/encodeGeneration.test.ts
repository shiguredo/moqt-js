/**
 * 符号化の出力を送るかの判定の境界のテスト
 *
 * 依頼した時点の世代と現在の世代の比較で送るかどうかを決める。系列の性質は
 * encodeGeneration.prop.ts が確かめる (ここは境界だけを固定する)。
 */

import { test, assert } from "vite-plus/test";
import {
  recordEncodeGeneration,
  shouldSendEncodedChunk,
  type EncodeGenerationRecords,
} from "./encodeGeneration";

test("shouldSendEncodedChunk: 記録が無い出力は送らない", () => {
  // 配信を始める前の出力、配信ごとの初期化で記録を消した後の出力
  const records: EncodeGenerationRecords = new Map();

  assert.isFalse(shouldSendEncodedChunk(records, 0, 1000));
  assert.isFalse(shouldSendEncodedChunk(records, 3, 1000));
});

test("shouldSendEncodedChunk: 異なる世代で同じ timestamp を記録すると新しい記録へ置き換わる", () => {
  // このテストは記録の置き換えだけを検査する。出力は timestamp しか持たないため、
  // 停止前後の世代で値を再利用した場合に、旧世代の出力を識別できるという保証ではない。
  // 異なる世代の上書きは最新の世代だけを保持する。同じ世代で重複する取得時刻は
  // 複数の入力であり、すべて出力する性質を PBT と実 WebCodecs の検証で確かめる。
  const records: EncodeGenerationRecords = new Map();
  recordEncodeGeneration(records, 1, 500);
  recordEncodeGeneration(records, 2, 500);

  assert.isFalse(shouldSendEncodedChunk(records, 1, 500), "古い世代の記録で送っている");
  // 取り出した記録は消える
  assert.isFalse(shouldSendEncodedChunk(records, 2, 500), "取り出した記録が消えていない");
});
