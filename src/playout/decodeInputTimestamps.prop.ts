/**
 * takeDecodeInputEntry / LastTimestampKind の Property-Based Tests
 *
 * 復号へ渡した timestamp の記録から、復号の出力の timestamp で対応を引く処理が満たすべき
 * 性質を、任意の記録と問い合わせの列で確かめる。この処理は「復号の出力の timestamp は投入した
 * 値と小数だけずれる」「負荷時に大きくずれる」という実測に支えられており、ずれたまま引けなく
 * なると音の種類を失うため、境界の扱いを直接固定する。
 *
 * - 完全一致する記録があれば、それを引く
 * - 一致する記録が無ければ、許容の中では最も近い記録を引く
 * - 許容の中に記録が無ければ undefined を返し、記録は消費しない
 * - 引いた記録は 1 回だけ引ける (同じ記録が 2 回返らない)
 * - 引いた値の timestamp は、問い合わせた timestamp から許容以内にある
 * - 一致する記録が無かったときは、問い合わせの後、許容より古い記録が残らない (古い記録が
 *   永久に一致しなくなるのを防ぐ)。完全一致で引けたときはその走査を通らないため残り得る
 * - 許容以内の記録は、引かれない限り残る
 * - `LastTimestampKind` は、記録が近くにあるときだけ覚えている種類を返す
 *
 * 記録は「記録した順に並ぶ (timestamp が昇順)」という前提で作る。実際の呼び出し側
 * (src/createMediaSubscriber.ts) は復号へ渡した順に記録するためである。個別の境界 (許容
 * ちょうど、許容 + 1、空の記録) は src/playout/decodeInputTimestamps.test.ts の単体テストが
 * 固定する。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  DECODE_INPUT_KIND_FALLBACK_MAX_DISTANCE_MICROS,
  LastTimestampKind,
  takeDecodeInputEntry,
} from "./decodeInputTimestamps";

// 最初の記録の timestamp (マイクロ秒)。0 と負の値も作れるよう余裕を持たせる
const FIRST_TIMESTAMP_MICROS = 1_000_000;

/** 記録と問い合わせの列 */
function scenarioArbitrary() {
  return fc.record({
    // 復号へ渡した記録。timestamp は昇順になる (記録した順に並ぶ)
    entries: fc.array(fc.integer({ min: 1, max: 40_000 }), { minLength: 0, maxLength: 12 }),
    // 問い合わせの timestamp。直前の記録からのずれ (マイクロ秒)
    offsets: fc.array(fc.integer({ min: -8_000, max: 8_000 }), { minLength: 0, maxLength: 12 }),
    toleranceMicros: fc.integer({ min: 1, max: 20_000 }),
  });
}

test("takeDecodeInputEntry: 完全一致・最も近い記録・消費の規則を守る", () => {
  fc.assert(
    fc.property(scenarioArbitrary(), ({ entries, offsets, toleranceMicros }) => {
      // 記録した順に並ぶ timestamp と、その値 (値は添字にして 1 回だけ引けることを見る)
      const keys: number[] = [];
      let timestamp = FIRST_TIMESTAMP_MICROS;
      for (const gap of entries) {
        timestamp += gap;
        keys.push(timestamp);
      }
      const map = new Map<number, number>();
      keys.forEach((key, index) => map.set(key, index));

      const taken = new Set<number>();
      for (const [queryIndex, offset] of offsets.entries()) {
        // 問い合わせる timestamp (記録が無ければ任意の値)
        const anchor =
          keys.length === 0 ? FIRST_TIMESTAMP_MICROS : (keys[queryIndex % keys.length] ?? 0);
        const outputTimestampMicros = anchor + offset;
        // 呼ぶ前の記録から期待を求める
        const before = new Map(map);
        const exact = before.get(outputTimestampMicros);
        let nearestKey: number | null = null;
        let nearestDistance = Number.POSITIVE_INFINITY;
        for (const key of before.keys()) {
          const distance = Math.abs(key - outputTimestampMicros);
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestKey = key;
          }
        }
        const withinTolerance = nearestKey !== null && nearestDistance <= toleranceMicros;

        const result = takeDecodeInputEntry(map, outputTimestampMicros, toleranceMicros);

        // 完全一致があればそれを引く
        if (exact !== undefined) {
          assert.equal(result, exact, `完全一致の記録を引くこと (${queryIndex} 回目)`);
        } else if (withinTolerance) {
          assert.equal(
            result,
            before.get(nearestKey ?? 0),
            `許容の中では最も近い記録を引くこと (${queryIndex} 回目)`,
          );
        } else {
          assert.isUndefined(result, `許容の中に記録が無ければ引かないこと (${queryIndex} 回目)`);
        }
        // 引いた値は 1 回だけ引ける
        if (result !== undefined) {
          assert.isFalse(taken.has(result), `同じ記録を 2 回引かないこと (${queryIndex} 回目)`);
          taken.add(result);
          // 引いた記録は、問い合わせた timestamp から許容以内にある
          const key = keys[result] ?? 0;
          assert.isAtMost(
            Math.abs(key - outputTimestampMicros),
            toleranceMicros,
            `引いた記録が許容以内にあること (${queryIndex} 回目)`,
          );
        }
        // 完全一致で引けたときは、古い記録を捨てる走査を通らない (そのまま返る)。捨てるのは
        // 一致する記録が無かったときであり、そのときに限り、許容より古い記録は残らない
        if (exact === undefined) {
          for (const key of map.keys()) {
            assert.isAtMost(
              outputTimestampMicros - key,
              toleranceMicros,
              `許容より古い記録が残らないこと (${queryIndex} 回目)`,
            );
          }
        }
        // 引かなかった許容以内の記録は残る
        for (const [key, value] of before) {
          if (taken.has(value)) {
            continue;
          }
          if (Math.abs(key - outputTimestampMicros) <= toleranceMicros) {
            assert.isTrue(map.has(key), `許容以内の記録が引かれずに残ること (${queryIndex} 回目)`);
          }
        }
      }
    }),
    { numRuns: 300 },
  );
});

test("LastTimestampKind: 記録が近くにあるときだけ覚えている種類を返す", () => {
  fc.assert(
    fc.property(
      fc.option(fc.constantFrom("wallClock" as const, "mediaTime" as const), { nil: null }),
      fc.array(fc.record({ gap: fc.integer({ min: 1, max: 30_000 }) }), {
        maxLength: 8,
      }),
      fc.oneof(
        fc.integer({ min: 0, max: DECODE_INPUT_KIND_FALLBACK_MAX_DISTANCE_MICROS }),
        fc.integer({
          min: DECODE_INPUT_KIND_FALLBACK_MAX_DISTANCE_MICROS + 1,
          max: DECODE_INPUT_KIND_FALLBACK_MAX_DISTANCE_MICROS * 2,
        }),
      ),
      (kind, entries, distanceMicros) => {
        const last = new LastTimestampKind<"wallClock" | "mediaTime">();
        last.reset();
        assert.isNull(
          last.fallbackFor(new Map<number, number>(), FIRST_TIMESTAMP_MICROS),
          "記録が無ければ種類を返さないこと",
        );
        last.update(kind);
        const map = new Map<number, number>();
        let timestamp = FIRST_TIMESTAMP_MICROS;
        for (const [index, entry] of entries.entries()) {
          timestamp += entry.gap;
          map.set(timestamp, index);
        }
        const outputTimestampMicros =
          (entries.length === 0 ? FIRST_TIMESTAMP_MICROS : timestamp) + distanceMicros;
        const fallback = last.fallbackFor(map, outputTimestampMicros);
        if (kind === null) {
          assert.isNull(fallback, "種類を観測していなければ返さないこと");
          return;
        }
        if (map.size === 0) {
          assert.isNull(fallback, "記録が無ければ種類を返さないこと");
          return;
        }
        let nearest = Number.POSITIVE_INFINITY;
        for (const key of map.keys()) {
          nearest = Math.min(nearest, Math.abs(outputTimestampMicros - key));
        }
        if (nearest <= DECODE_INPUT_KIND_FALLBACK_MAX_DISTANCE_MICROS) {
          assert.equal(fallback, kind, "記録が近ければ覚えている種類を返すこと");
        } else {
          assert.isNull(fallback, "記録が遠ければ種類を返さないこと");
        }
      },
    ),
    { numRuns: 200 },
  );
});
