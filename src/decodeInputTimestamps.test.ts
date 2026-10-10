/**
 * 復号へ渡した timestamp から復号の出力を引く処理の単体テスト
 *
 * WebCodecs の `AudioDecoder` は出力の `AudioData.timestamp` を入力と完全には一致させない。
 * 実測 (実リレー、Opus、48 kHz) では 100 マイクロ秒だけ大きかった。完全一致だけで引くと、
 * 一致しない出力が続いた後は最も古い記録が永久に一致しなくなり、以降の対応がすべて引けなく
 * なる (実測: 記憶が 1 秒に 50 件増え続け、音声の TIMESTAMP の種類を失って、共有の時間軸へ
 * 音声の基準が記録されなくなった)。実測した形の入力列で、引けることと回復することを固定する
 */

import { test, assert } from "vite-plus/test";
import {
  DECODER_OUTPUT_TIMESTAMP_TOLERANCE_MICROS,
  takeDecodeInputEntry,
} from "./decodeInputTimestamps";

/** 復号へ渡す timestamp の例 (マイクロ秒)。実測と同じ桁 (Unix epoch) にする */
const FIRST_INPUT_MICROS = 1_791_611_153_656_600;

/** Opus の 20 ms フレームの間隔 (マイクロ秒) */
const FRAME_MICROS = 20_000;

/** 実測した、入力と出力の timestamp の差 (マイクロ秒) */
const MEASURED_OUTPUT_SHIFT_MICROS = 100;

test("takeDecodeInputEntry: 完全一致する記録を取り出す", () => {
  const entries = new Map<number, string>();
  entries.set(FIRST_INPUT_MICROS, "1 つ目");
  entries.set(FIRST_INPUT_MICROS + FRAME_MICROS, "2 つ目");

  assert.strictEqual(takeDecodeInputEntry(entries, FIRST_INPUT_MICROS), "1 つ目");
  // 引いた記録は忘れる
  assert.strictEqual(entries.size, 1);
  assert.strictEqual(takeDecodeInputEntry(entries, FIRST_INPUT_MICROS + FRAME_MICROS), "2 つ目");
  assert.strictEqual(entries.size, 0);
});

test("takeDecodeInputEntry: 復号の出力が入力より 100 マイクロ秒大きくても取り出す", () => {
  // 実測した形そのもの。完全一致しないため、最も古い記録を許容の中で引く
  const entries = new Map<number, string>();
  entries.set(FIRST_INPUT_MICROS, "1 つ目");

  assert.strictEqual(
    takeDecodeInputEntry(entries, FIRST_INPUT_MICROS + MEASURED_OUTPUT_SHIFT_MICROS),
    "1 つ目",
  );
  assert.strictEqual(entries.size, 0);
});

test("takeDecodeInputEntry: 許容を超えて離れた記録は取り出さない", () => {
  // 隣のフレームと取り違えない (出力が 20 ms 先へ進んだとき、古い記録を引かない)
  const entries = new Map<number, string>();
  entries.set(FIRST_INPUT_MICROS, "1 つ目");

  assert.isUndefined(
    takeDecodeInputEntry(entries, FIRST_INPUT_MICROS + FRAME_MICROS + MEASURED_OUTPUT_SHIFT_MICROS),
  );
  // 引けなかった記録は残す (次の出力で引ける可能性がある)。ただし許容より古くなった分は
  // 対応しないため捨てる
  assert.strictEqual(entries.size, 0);
});

test("takeDecodeInputEntry: 一致しないままになっても、古い記録を捨てて次の記録を引ける", () => {
  // 最初の出力が 1 つ目の記録と対応しなかった (出力が欠けた) 後も、2 つ目の出力は
  // 2 つ目の記録から引ける。古い記録を残すと、以降の対応がすべて引けなくなる
  const entries = new Map<number, string>();
  entries.set(FIRST_INPUT_MICROS, "1 つ目");
  entries.set(FIRST_INPUT_MICROS + FRAME_MICROS, "2 つ目");

  // 1 つ目の記録は、2 つ目の出力の timestamp より 1 フレーム分古い。捨てて 2 つ目を引く
  assert.strictEqual(
    takeDecodeInputEntry(entries, FIRST_INPUT_MICROS + FRAME_MICROS + MEASURED_OUTPUT_SHIFT_MICROS),
    "2 つ目",
  );
  assert.strictEqual(entries.size, 0);
});

test("takeDecodeInputEntry: 許容の境界は取り出す", () => {
  const entries = new Map<number, string>();
  entries.set(FIRST_INPUT_MICROS, "1 つ目");
  assert.strictEqual(
    takeDecodeInputEntry(entries, FIRST_INPUT_MICROS + DECODER_OUTPUT_TIMESTAMP_TOLERANCE_MICROS),
    "1 つ目",
  );

  const over = new Map<number, string>();
  over.set(FIRST_INPUT_MICROS, "1 つ目");
  assert.isUndefined(
    takeDecodeInputEntry(over, FIRST_INPUT_MICROS + DECODER_OUTPUT_TIMESTAMP_TOLERANCE_MICROS + 1),
  );
});

test("takeDecodeInputEntry: 記録が無ければ undefined", () => {
  assert.isUndefined(takeDecodeInputEntry(new Map<number, string>(), FIRST_INPUT_MICROS));
});
