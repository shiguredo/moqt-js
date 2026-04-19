/**
 * Subscriber Property-Based Tests
 * draft-ietf-moq-transport-17 Section 5.1
 */

import * as fc from "fast-check";
import { assert, test } from "vite-plus/test";
import type { MoqtObject } from "./dataStream";
import { createTrackNamespace, encodeTrackName } from "./message";
import { ObjectStatus } from "./message/types";
import { SubscriberImpl, type SubscriptionViewAccessor } from "./subscriber";
import type { SubscriptionView } from "./session/types";

function createObject(groupId: bigint, objectId: bigint): MoqtObject {
  return {
    groupId,
    objectId,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array([1, 2, 3]),
  };
}

interface MockView {
  state: "active" | "closed";
}

function makeSubscriber(mock: MockView, onObject: (object: MoqtObject) => void): SubscriberImpl {
  const viewAccessor: SubscriptionViewAccessor = (): SubscriptionView => ({
    requestId: 0n,
    trackNamespace: createTrackNamespace(["namespace"]),
    trackName: encodeTrackName("track"),
    trackAlias: 0n,
    state: mock.state,
    isEstablished: true,
    largestLocation: null,
    trackProperties: [],
  });
  return new SubscriberImpl(["namespace"], "track", 0n, viewAccessor, onObject);
}

test("オブジェクトは即座に配信される", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.integer({ min: 0, max: 99 }), { minLength: 1, maxLength: 30 }),
      (objectIds) => {
        const delivered: MoqtObject[] = [];
        const mock: MockView = { state: "active" };
        const subscriber = makeSubscriber(mock, (obj) => delivered.push(obj));

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
      const mock: MockView = { state: "active" };
      const subscriber = makeSubscriber(mock, (obj) => delivered.push(obj));

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

test("view が closed を返すとオブジェクトは配信されない", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.integer({ min: 1, max: 99 }), { minLength: 1, maxLength: 20 }),
      (objectIds) => {
        const delivered: MoqtObject[] = [];
        const mock: MockView = { state: "closed" };
        const subscriber = makeSubscriber(mock, (obj) => delivered.push(obj));

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
