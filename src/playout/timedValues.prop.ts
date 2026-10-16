/**
 * TimedValues の Property-Based Tests
 *
 * 「記録した時刻の順に並んだ値の列」を任意の操作列 (記録・窓より古い値の削除・問い合わせ) で
 * 駆動し、素直な配列 (窓の外の値を捨てるだけのモデル) と一致することを確かめる。
 *
 * - `current()` は窓の中の値を記録の順で返す
 * - `since(t)` は時刻が t より後の値を記録の順で返し、`countAfter(t)` はその数に一致する
 * - `minAfter(t)` は時刻が t 以降の値の最小値 (境界を含む) であり、無ければ null
 * - `oldest()` は窓の中の最も古い記録 (時刻と値) であり、無ければ null
 * - `prune(t)` は時刻が t より前の値を捨てるだけで、ほかの値を変えない
 * - `clear()` の後は何も残らない
 *
 * 位置を進める実装 (先頭から捨てて、半分を超えたらまとめて詰め直す) は観測できない内部の
 * 都合であるため、外から見た値だけを比べる。境界の細かい規則 (ちょうど窓の境目の時刻、
 * 空の列) は src/playout/timedValues.test.ts の単体テストが固定する。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { TimedValues } from "./timedValues";

/** 窓の外の値を捨てるだけのモデル (素直な実装) */
interface Entry {
  readonly atMs: number;
  readonly value: number;
}

/**
 * 操作の列を作る
 *
 * 記録の時刻は `performance.now()` と同じく単調に増えるため、記録は前からの差 (0 以上) で
 * 作る。削除と問い合わせの時刻は「今から何ミリ秒前か」で作り、窓の内側と外側の両方を通す
 */
function operationsArbitrary() {
  return fc.array(
    fc.oneof(
      fc.record({
        kind: fc.constant("push" as const),
        gapMs: fc.integer({ min: 0, max: 50 }),
        value: fc.integer({ min: -1_000, max: 1_000 }),
      }),
      fc.record({
        kind: fc.constant("prune" as const),
        backMs: fc.integer({ min: 0, max: 300 }),
      }),
      fc.record({ kind: fc.constant("clear" as const) }),
      fc.record({
        kind: fc.constant("query" as const),
        backMs: fc.integer({ min: 0, max: 300 }),
      }),
    ),
    { maxLength: 80 },
  );
}

test("TimedValues: 窓の中の値・数・最小値・最も古い記録が素直な配列と一致する", () => {
  fc.assert(
    fc.property(operationsArbitrary(), (operations) => {
      const series = new TimedValues();
      // 素直なモデル。削除された値は積まなかったものとして扱う
      let entries: Entry[] = [];
      // 記録の時刻 (単調に増える)
      let nowMs = 0;
      let queries = 0;

      for (const operation of operations) {
        switch (operation.kind) {
          case "push": {
            nowMs += operation.gapMs;
            series.push(nowMs, operation.value);
            entries.push({ atMs: nowMs, value: operation.value });
            break;
          }
          case "prune": {
            const minAtMs = nowMs - operation.backMs;
            series.prune(minAtMs);
            entries = entries.filter((entry) => entry.atMs >= minAtMs);
            break;
          }
          case "clear": {
            series.clear();
            entries = [];
            break;
          }
          case "query": {
            queries++;
            const atMs = nowMs - operation.backMs;
            // 窓の中の値は記録の順のままである
            assert.deepEqual(
              series.current(),
              entries.map((entry) => entry.value),
              `current() が窓の中の値と一致すること (${queries} 回目の問い合わせ)`,
            );
            // 時刻が atMs より後の値 (境界は含まない)
            const after = entries.filter((entry) => entry.atMs > atMs);
            assert.deepEqual(
              series.since(atMs),
              after.map((entry) => entry.value),
              `since(${atMs}) が t より後の値と一致すること (${queries} 回目)`,
            );
            assert.equal(
              series.countAfter(atMs),
              after.length,
              `countAfter(${atMs}) が since の数と一致すること (${queries} 回目)`,
            );
            // 時刻が atMs 以降の値 (境界を含む)。minAfter だけが境界を含む
            const atOrAfter = entries.filter((entry) => entry.atMs >= atMs);
            assert.equal(
              series.minAfter(atMs),
              atOrAfter.length === 0
                ? null
                : atOrAfter.reduce(
                    (minimum, entry) => Math.min(minimum, entry.value),
                    Number.POSITIVE_INFINITY,
                  ),
              `minAfter(${atMs}) が t 以降の最小値と一致すること (${queries} 回目)`,
            );
            const oldest = entries[0];
            assert.deepEqual(
              series.oldest(),
              oldest === undefined ? null : { atMs: oldest.atMs, value: oldest.value },
              `oldest() が最も古い記録と一致すること (${queries} 回目)`,
            );
            break;
          }
        }
      }
    }),
    { numRuns: 200 },
  );
});

/**
 * 窓より古い値を捨てても、窓の中の問い合わせの結果は変わらない
 *
 * `prune` は捨てるだけであり、残った値の見え方を変えない (位置を進める実装の詰め直しが
 * 観測できる差を生まない) ことを確かめる
 */
test("TimedValues: prune は窓の中の問い合わせの結果を変えない", () => {
  fc.assert(
    fc.property(
      fc.array(fc.record({ gapMs: fc.integer({ min: 0, max: 20 }), value: fc.integer() }), {
        minLength: 1,
        maxLength: 40,
      }),
      fc.integer({ min: 0, max: 200 }),
      (records, backMs) => {
        const pruned = new TimedValues();
        const kept = new TimedValues();
        let nowMs = 0;
        for (const record of records) {
          nowMs += record.gapMs;
          pruned.push(nowMs, record.value);
          kept.push(nowMs, record.value);
        }
        const minAtMs = nowMs - backMs;
        pruned.prune(minAtMs);
        // 窓の中 (時刻が minAtMs 以降) の問い合わせは、削除の有無によらず同じである。
        // 窓の外 (minAtMs より前) は削除で変わるため比べない
        assert.deepEqual(
          pruned.current(),
          kept.since(minAtMs - 1),
          `current() が届いた値のうち窓の中のものと一致すること (minAtMs=${minAtMs})`,
        );
        for (const atMs of [minAtMs, minAtMs + 1, nowMs, nowMs + 1]) {
          assert.deepEqual(
            pruned.since(atMs),
            kept.since(atMs),
            `since(${atMs}) が prune の前後で変わらないこと`,
          );
          assert.equal(pruned.countAfter(atMs), kept.countAfter(atMs), `countAfter(${atMs})`);
          assert.equal(pruned.minAfter(atMs), kept.minAfter(atMs), `minAfter(${atMs})`);
        }
        // oldest() は窓の外の値を捨てた結果そのものであるため、prune の前後で変わり得る
        // (この性質は 1 つ目のプロパティが記録の順との一致として確かめる)
      },
    ),
    { numRuns: 100 },
  );
});
