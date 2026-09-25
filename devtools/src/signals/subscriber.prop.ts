/**
 * hasActiveSubscriber の Property-Based Tests
 *
 * 任意の数の Subscriber について、購読の確立を待っている (isStarting) インスタンスが
 * 1 つでもあれば接続設定を使っている、1 つも無ければ使っていないと判定することを確かめる。
 *
 * 確立済みの購読 (subscriber.value が null でない) は、Fake (FakeSubscriber) に頼るテストを
 * 増やさないため生成しない。その判定は次の単体テストが固定する。
 * 「hasActiveSubscriber tracks instance.subscriber.value updates」
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { createSubscriberInstance, hasActiveSubscriber, subscriberInstances } from "./subscriber";

// Subscriber ごとに、購読の確立を待っているか (0 個も含む)
const startingFlagsArbitrary = fc.array(fc.boolean(), { maxLength: 5 });

test("hasActiveSubscriber: 確立を待っている Subscriber が 1 つでもあれば true、無ければ false", () => {
  fc.assert(
    fc.property(startingFlagsArbitrary, (startingFlags) => {
      subscriberInstances.value = new Map(
        startingFlags.map((starting, index) => {
          const instance = createSubscriberInstance(`subscriber-${index}`);
          instance.isStarting.value = starting;
          return [instance.id, instance];
        }),
      );

      try {
        assert.equal(hasActiveSubscriber.value, startingFlags.some(Boolean));
      } finally {
        subscriberInstances.value = new Map();
      }
    }),
  );
});
