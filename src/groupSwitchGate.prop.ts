/**
 * GroupSwitchGate の Property-Based Tests
 *
 * 各 Group を 1 本の Subgroup の stream で送る publisher の Object 列を生成し、
 * stream ごとの順序だけを保って stream をまたいだ到着順を任意に入れ替えて通す
 * (draft-ietf-moq-transport-21 Section 2.1: Object は順不同で届きうる)。各 stream の
 * 終わりは、その stream の最後の Object の後の任意の位置で通知する。
 *
 * - 各 Object はちょうど 1 回渡される (reset まで含めて失われず、重複しない)
 * - 同じ Group の Object は届いた順に渡される
 * - 各 stream の最初の Object が Group の順に届き、上限の時間に達しない到着列では、
 *   渡される Object の Group は減らない (前の Group の Object が次の Group の Object より
 *   後に渡らない)。まだ 1 つも Object が届いていない stream はゲートから見えないため、
 *   stream の始まりの順は前提にする (relay は Group の順に stream を開く)
 *
 * 個別の規則 (上限での解放、Subgroup ID の無い Object、複数の Subgroup) は
 * groupSwitchGate.test.ts の単体テストが固定する。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { GroupSwitchGate } from "./groupSwitchGate";

interface Delivered {
  readonly groupId: number;
  readonly objectId: number;
}

type Event =
  | { readonly kind: "object"; readonly groupId: number; readonly objectId: number }
  | { readonly kind: "end"; readonly groupId: number };

/**
 * Group ごとの Object 数から、stream ごとの順序を保って入れ替えた到着列を作る。
 * 選ぶ stream の順を乱数の列で決める (各 stream は Object を順に出し、最後に終わりを出す)
 */
function eventsArbitrary(streamsStartInGroupOrder: boolean) {
  return fc
    .record({
      groupSizes: fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 6 }),
      choices: fc.array(fc.nat(), { maxLength: 80 }),
    })
    .map(({ groupSizes, choices }) => {
      const streams: Event[][] = groupSizes.map((size, groupId) => [
        ...Array.from({ length: size }, (_, objectId) => ({
          kind: "object" as const,
          groupId,
          objectId,
        })),
        { kind: "end" as const, groupId },
      ]);
      const events: Event[] = [];
      let choice = 0;
      const started = groupSizes.map(() => false);
      while (streams.some((stream) => stream.length > 0)) {
        // stream の始まりを Group の順にする場合は、前の Group の stream が始まるまで
        // 次の Group の stream を選ばない
        const open = streams.filter(
          (stream, groupId) =>
            stream.length > 0 &&
            (!streamsStartInGroupOrder || groupId === 0 || started[groupId - 1] === true),
        );
        const stream = open[(choices[choice] ?? 0) % open.length];
        choice++;
        const event = stream?.shift();
        if (event !== undefined) {
          started[event.groupId] = true;
          events.push(event);
        }
      }
      return { groupSizes, events };
    });
}

test("GroupSwitchGate: 各 Object をちょうど 1 回、同じ Group の中では届いた順に渡す", () => {
  fc.assert(
    fc.property(eventsArbitrary(false), ({ groupSizes, events }) => {
      const gate = new GroupSwitchGate<Delivered>();
      const delivered: Delivered[] = [];
      for (const [index, event] of events.entries()) {
        if (event.kind === "object") {
          delivered.push(
            ...gate.push(
              { groupId: event.groupId, objectId: event.objectId },
              BigInt(event.groupId),
              0n,
              index,
            ),
          );
        } else {
          delivered.push(...gate.endSubgroup(BigInt(event.groupId), 0n, index));
        }
      }
      delivered.push(...gate.reset());

      const total = groupSizes.reduce((sum, size) => sum + size, 0);
      assert.equal(delivered.length, total);
      for (const [groupId, size] of groupSizes.entries()) {
        const objects = delivered
          .filter((object) => object.groupId === groupId)
          .map((object) => object.objectId);
        assert.deepEqual(
          objects,
          Array.from({ length: size }, (_, objectId) => objectId),
        );
      }
    }),
  );
});

test("GroupSwitchGate: 上限の時間に達しなければ、渡す Object の Group は減らない", () => {
  fc.assert(
    fc.property(eventsArbitrary(true), ({ events }) => {
      // 到着は 1 ms 間隔で、上限 (既定 50 ms) より十分長い上限にする
      const gate = new GroupSwitchGate<Delivered>(1_000_000);
      const delivered: Delivered[] = [];
      for (const [index, event] of events.entries()) {
        if (event.kind === "object") {
          delivered.push(
            ...gate.push(
              { groupId: event.groupId, objectId: event.objectId },
              BigInt(event.groupId),
              0n,
              index,
            ),
          );
        } else {
          delivered.push(...gate.endSubgroup(BigInt(event.groupId), 0n, index));
        }
        assert.deepEqual(gate.expire(index), []);
      }
      // すべての stream が終わった時点で保留は残らない
      assert.isNull(gate.holdDeadlineMs);
      for (let position = 1; position < delivered.length; position++) {
        assert.isAtLeast(
          delivered[position]?.groupId ?? 0,
          delivered[position - 1]?.groupId ?? 0,
          `Group ${delivered[position - 1]?.groupId} の後に Group ${delivered[position]?.groupId} が渡った`,
        );
      }
    }),
  );
});
