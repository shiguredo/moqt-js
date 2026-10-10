/**
 * 復号へ渡した timestamp から復号の出力を引く処理の単体テスト
 *
 * WebCodecs の `AudioDecoder` は出力の `AudioData.timestamp` を入力と完全には一致させない。
 * 実測 (実リレー、Opus、48 kHz) では 100 マイクロ秒だけ大きかった。完全一致だけで引くと、
 * 一致しない出力が続いた後は最も古い記録が永久に一致しなくなり、以降の対応がすべて引けなく
 * なる (実測: 記憶が 1 秒に 50 件増え続け、音声の TIMESTAMP の種類を失って、共有の時間軸へ
 * 音声の基準が記録されなくなった)。実測した形の入力列で、引けることと回復することを固定する
 *
 * 実測 (実リレー、CPU を 6 倍に遅くした再現) では、これとは別の形で引けなくなった。復号へ
 * 渡した記録と復号の出力の timestamp の格子が 9.7 ms ずれたまま残り (双方が 20 ms ごとに
 * 進むため差が縮まらない)、許容の中でも引けない状態が出力ごとに繰り返された (対応が引けた
 * 635 回の後、831 回続けて引けなくなった)。このとき音声の基準の遅れは最後に記録した値の
 * まま固定される。ずれるきっかけは配信側の TIMESTAMP の補正の段差と relay の cache の再送で
 * あり (実測: 入力の timestamp の間隔に -120 ms から +190 ms の跳びが 20 秒間に 30 回)、
 * 実装で防げない。そのため、引けないときは直前に分かっている種類を使う (`LastTimestampKind`)
 */

import { test, assert } from "vite-plus/test";
import {
  DECODER_OUTPUT_TIMESTAMP_TOLERANCE_MICROS,
  DECODE_INPUT_KIND_FALLBACK_MAX_DISTANCE_MICROS,
  LastTimestampKind,
  takeDecodeInputEntry,
} from "./decodeInputTimestamps";

/** 復号へ渡す timestamp の例 (マイクロ秒)。実測と同じ桁 (Unix epoch) にする */
const FIRST_INPUT_MICROS = 1_791_611_153_656_600;

/** Opus の 20 ms フレームの間隔 (マイクロ秒) */
const FRAME_MICROS = 20_000;

/** 実測した、入力と出力の timestamp の差 (マイクロ秒) */
const MEASURED_OUTPUT_SHIFT_MICROS = 100;

/**
 * 実測した、記録と復号の出力の timestamp の格子のずれ (マイクロ秒)
 *
 * 復号の出力が記録より古い側にずれる。実測では 9.7 ms と 19.8 ms (1 フレーム) があった
 */
const MEASURED_GRID_OFFSETS_MICROS = [9_700, 19_800];

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

test("takeDecodeInputEntry: 実測した 9.7 ms のずれでは引けず、その状態が続く", () => {
  // 実測 (実リレー、CPU を 6 倍に遅くした再現) では、記録と復号の出力の格子が 9.7 ms
  // ずれたまま残った。双方が 20 ms ごとに進むため差は縮まらない。この形では、記録は
  // 残り (この出力より古い記録は捨てる規則は、出力より新しい記録を消さない)、同じ判定が
  // 出力ごとに繰り返されて、以後の出力がすべて引けなくなる (実測: 対応が引けた 635 回の
  // 後、831 回続けて引けなくなった)
  const entries = new Map<number, "wallClock" | "mediaTime">();
  for (let index = 0; index < 50; index++) {
    entries.set(FIRST_INPUT_MICROS + index * FRAME_MICROS, "wallClock");
    const outputTimestamp =
      FIRST_INPUT_MICROS + index * FRAME_MICROS - MEASURED_GRID_OFFSETS_MICROS[0];
    assert.isUndefined(
      takeDecodeInputEntry(entries, outputTimestamp),
      `${index} 回目も対応が引けない`,
    );
    // 引けない状態が続いても記録は 1 件のままである (実測と同じ)
    assert.strictEqual(entries.size, 1, `${index} 回目の記録の数`);
  }
});

test("LastTimestampKind: 実測した格子のずれでも種類を失わない", () => {
  // 呼び出し側と同じ順で種類を決める (`src/createMediaSubscriber.ts` と
  // `devtools/src/hooks/useSubscriber.ts`)。引けたときはその記録の種類、引けないときは
  // 直前に分かっている種類、どちらも無ければ none
  const resolve = (
    entries: Map<number, "wallClock" | "mediaTime">,
    outputTimestamp: number,
    lastKind: LastTimestampKind<"wallClock" | "mediaTime">,
  ): "none" | "wallClock" | "mediaTime" =>
    takeDecodeInputEntry(entries, outputTimestamp) ??
    lastKind.fallbackFor(entries, outputTimestamp) ??
    "none";

  for (const offsetMicros of MEASURED_GRID_OFFSETS_MICROS) {
    const lastKind = new LastTimestampKind<"wallClock" | "mediaTime">();
    lastKind.update("wallClock");
    const entries = new Map<number, "wallClock" | "mediaTime">();
    let lost = 0;
    for (let index = 0; index < 50; index++) {
      entries.set(FIRST_INPUT_MICROS + index * FRAME_MICROS, "wallClock");
      const kind = resolve(
        entries,
        FIRST_INPUT_MICROS + index * FRAME_MICROS - offsetMicros,
        lastKind,
      );
      if (kind === "none") {
        lost += 1;
      }
    }
    // ずれが 1 フレーム (19.8 ms) のときは隣の記録を引く (種類は同じであるため実害は無い)。
    // どちらのずれでも、種類を失った出力は 1 つも無い
    assert.strictEqual(lost, 0, `${offsetMicros}: 種類を失った出力の数`);
  }
});

test("LastTimestampKind: 種類が変わったら新しい種類を使う", () => {
  // 種類は TIMESTAMP の Timescale の有無で決まる。ストリームの途中で変わったときに
  // 古い種類を使い続けると、誤った時間軸の値として共有の時間軸へ記録してしまう
  const lastKind = new LastTimestampKind<"wallClock" | "mediaTime">();
  const entries = new Map<number, "wallClock" | "mediaTime">();
  entries.set(FIRST_INPUT_MICROS, "wallClock");
  const outputTimestamp = FIRST_INPUT_MICROS - MEASURED_GRID_OFFSETS_MICROS[0];

  lastKind.update("wallClock");
  assert.strictEqual(lastKind.fallbackFor(entries, outputTimestamp), "wallClock");

  lastKind.update("mediaTime");
  assert.strictEqual(lastKind.fallbackFor(entries, outputTimestamp), "mediaTime");

  // 種類が分からない (TIMESTAMP が無い) 音では上書きしない。decoder へは 0 を渡すため、
  // その出力に古い種類を当てると 1970 年からの時刻として記録してしまう
  lastKind.update(null);
  assert.strictEqual(lastKind.fallbackFor(entries, outputTimestamp), "mediaTime");

  // 購読を始めるときなどに捨てたら、何も分かっていない状態へ戻る
  lastKind.reset();
  assert.isNull(lastKind.fallbackFor(entries, outputTimestamp));
});

test("LastTimestampKind: 別の時間軸の値には使わない", () => {
  const lastKind = new LastTimestampKind<"wallClock" | "mediaTime">();
  lastKind.update("wallClock");
  const entries = new Map<number, string>();
  entries.set(FIRST_INPUT_MICROS, "1 つ目");

  // 記録から離れた値 (TIMESTAMP が無い音の 0、メディア時刻、ミリ秒との取り違え) は
  // 別の時間軸の値であり、直前の種類を当てにしない
  assert.isNull(lastKind.fallbackFor(entries, 0));
  assert.isNull(
    lastKind.fallbackFor(
      entries,
      FIRST_INPUT_MICROS - DECODE_INPUT_KIND_FALLBACK_MAX_DISTANCE_MICROS - 1,
    ),
  );

  // 実測した格子のずれは当てにする
  assert.strictEqual(
    lastKind.fallbackFor(entries, FIRST_INPUT_MICROS - MEASURED_GRID_OFFSETS_MICROS[0]),
    "wallClock",
  );

  // 記録が無ければ、その出力が同じ時間軸のものかを言えない
  assert.isNull(lastKind.fallbackFor(new Map<number, string>(), FIRST_INPUT_MICROS));
});
