/**
 * Subscriber Property-Based Tests
 * draft-ietf-moq-transport-17 Section 5.1
 */

import { test, assert } from "vitest";
import * as fc from "fast-check";
import { SubscriberImpl } from "./subscriber";
import type { MoqtObject } from "./dataStream";
import { ObjectStatus } from "./message/types";

function createObject(groupId: bigint, objectId: bigint): MoqtObject {
  return {
    groupId,
    objectId,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array([1, 2, 3]),
  };
}

test("オブジェクトは即座に配信される", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.integer({ min: 0, max: 99 }), { minLength: 1, maxLength: 30 }),
      (objectIds) => {
        const delivered: MoqtObject[] = [];
        const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, (obj) =>
          delivered.push(obj),
        );

        for (const id of objectIds) {
          subscriber.handleObject(createObject(0n, BigInt(id)));
        }

        // 不変条件: 全てのオブジェクトが配信される
        assert.equal(delivered.length, objectIds.length);
        const deliveredIds = new Set(delivered.map((obj) => Number(obj.objectId)));
        for (const id of objectIds) {
          assert.isTrue(deliveredIds.has(id));
        }
      },
    ),
  );
});

test("オブジェクトは送信順序で配信される", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 20 }), (count) => {
      const delivered: MoqtObject[] = [];
      const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, (obj) =>
        delivered.push(obj),
      );

      // 任意の順序で送信
      const ids = Array.from({ length: count }, (_, i) => i);
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }

      for (const id of ids) {
        subscriber.handleObject(createObject(0n, BigInt(id)));
      }

      // 不変条件: 送信順序と同じ順序で配信される（リオーダリングなし）
      assert.equal(delivered.length, count);
      for (let i = 0; i < delivered.length; i++) {
        assert.equal(Number(delivered[i].objectId), ids[i]);
      }
    }),
  );
});

test("closed 状態ではオブジェクトは配信されない", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(fc.integer({ min: 1, max: 99 }), { minLength: 1, maxLength: 20 }),
      fc.boolean(),
      async (objectIds, useMarkClosed) => {
        const delivered: MoqtObject[] = [];
        const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, (obj) =>
          delivered.push(obj),
        );

        if (useMarkClosed) {
          subscriber.markClosed();
        } else {
          await subscriber.unsubscribe();
        }

        // closed 状態でオブジェクトを送信
        for (const id of objectIds) {
          subscriber.handleObject(createObject(0n, BigInt(id)));
        }

        // 不変条件: closed 状態では配信されない
        assert.equal(delivered.length, 0);
      },
    ),
  );
});
