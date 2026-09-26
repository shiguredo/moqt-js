/**
 * CatchUpGate の Property-Based Tests
 *
 * SUBSCRIBE_OK の LARGEST_OBJECT を境界にした判定が、Location の辞書順
 * (draft-ietf-moq-transport-21 Section 8.2 の Group ID と Object ID の比較) と一致することを
 * 確かめる。境界そのもの (同じ位置、Group をまたぐ場合) の境界値と、reset の振る舞いは
 * catchUpGate.test.ts の単体テストが固定する。
 *
 * 期待値は実装と別に書き、同じ比較関数を使い回さない。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import type { Location } from "moqt-js";
import { CatchUpGate } from "./catchUpGate";

/** 判定に使う Location。Group ID と Object ID が重複する場合も作る */
const locationArbitrary: fc.Arbitrary<Location> = fc.record({
  group: fc.bigInt({ min: 0n, max: 8n }),
  object: fc.bigInt({ min: 0n, max: 4n }),
});

/** 位置の列 (Object は順不同で届きうるため、任意の並びを作る) */
const positionsArbitrary: fc.Arbitrary<Location[]> = fc.array(locationArbitrary, { maxLength: 20 });

/**
 * 境界より後の位置かどうかの期待値 (辞書順を実装と別に書く)
 */
function expectedLive(position: Location, boundary: Location): boolean {
  if (position.group !== boundary.group) {
    return position.group > boundary.group;
  }
  return position.object > boundary.object;
}

test("位置が境界より後かどうかの判定が辞書順と一致する", () => {
  // Group ID を先に見て、同じ Group のときだけ Object ID を見る
  fc.assert(
    fc.property(locationArbitrary, locationArbitrary, (boundary, position) => {
      const gate = new CatchUpGate();
      gate.setBoundary(boundary);
      assert.strictEqual(
        gate.evaluate(position).live,
        expectedLive(position, boundary),
        "境界以前かどうかの判定が辞書順と一致しない",
      );
    }),
  );
});

test("境界を越えたことを知らせるのは、最初に境界より後になった 1 回だけである", () => {
  // 知らせた後も、遅着した境界以前の位置は再生しない
  fc.assert(
    fc.property(locationArbitrary, positionsArbitrary, (boundary, positions) => {
      const gate = new CatchUpGate();
      gate.setBoundary(boundary);
      let reached = false;
      for (const position of positions) {
        const decision = gate.evaluate(position);
        assert.strictEqual(
          decision.boundaryReached,
          decision.live && !reached,
          "境界を越えたことを知らせる回数が、最初の 1 回になっていない",
        );
        if (decision.live) {
          reached = true;
        }
        assert.strictEqual(
          decision.live,
          expectedLive(position, boundary),
          "境界を越えた後の判定が辞書順と一致しない",
        );
      }
      if (positions.some((position) => expectedLive(position, boundary))) {
        assert.isTrue(gate.catchUpCompleted, "境界を越えたのに追いつき中と判定した");
      }
    }),
  );
});

test("境界が無いときは、どの位置も再生し、追いつきは完了している", () => {
  // 購読の時点で Object が無い場合 (LARGEST_OBJECT の省略) は、cache から配られる分が無い
  fc.assert(
    fc.property(positionsArbitrary, (positions) => {
      const gate = new CatchUpGate();
      gate.setBoundary(null);
      for (const position of positions) {
        const decision = gate.evaluate(position);
        assert.isTrue(decision.live, "境界が無いのに再生しないと判定した");
        assert.isFalse(decision.boundaryReached, "境界が無いのに境界を越えたと知らせた");
      }
      assert.isTrue(gate.catchUpCompleted, "境界が無いのに追いつき中と判定した");
    }),
  );
});
