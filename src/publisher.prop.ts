/**
 * Publisher Property-Based Tests
 * draft-ietf-moq-transport-17 Section 5.2
 */

import * as fc from "fast-check";
import { assert, test } from "vite-plus/test";
import { createTrackNamespace, encodeTrackName } from "./message";
import { PublisherImpl, type PublicationViewAccessor } from "./publisher";
import type { PublicationView } from "./session/types";

interface MockView {
  state: "active" | "closed";
  forwardState: boolean;
}

function makePublisher(
  mock: MockView,
  onForwardStateChange?: (forward: boolean) => void,
): PublisherImpl {
  const viewAccessor: PublicationViewAccessor = (): PublicationView => ({
    requestId: 0n,
    trackNamespace: createTrackNamespace(["namespace"]),
    trackName: encodeTrackName("track"),
    trackAlias: 0n,
    state: mock.state,
    isEstablished: true,
    forwardState: mock.forwardState,
  });
  return new PublisherImpl(
    ["namespace"],
    "track",
    0n,
    0n,
    viewAccessor,
    undefined,
    onForwardStateChange,
  );
}

test("setForwardState は forwardState が変化した場合のみコールバックを呼ぶ", () => {
  fc.assert(
    fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 50 }), (states) => {
      const mock: MockView = { state: "active", forwardState: true };
      const callbackCalls: boolean[] = [];
      const publisher = makePublisher(mock, (forward) => {
        callbackCalls.push(forward);
      });

      // 初期状態は MOQT spec のデフォルト (true) と揃える
      let previousState = true;
      let expectedCallCount = 0;

      for (const state of states) {
        mock.forwardState = state;
        publisher.setForwardState(state);
        if (state !== previousState) {
          expectedCallCount++;
        }
        previousState = state;
      }

      // 不変条件: 状態が変化した回数とコールバック呼び出し回数が一致
      assert.equal(callbackCalls.length, expectedCallCount);

      // 不変条件: コールバックの引数は状態変化後の値
      let checkState = true;
      let callIndex = 0;
      for (const state of states) {
        if (state !== checkState) {
          assert.equal(callbackCalls[callIndex], state);
          callIndex++;
        }
        checkState = state;
      }
    }),
  );
});

test("任意の操作列に対して状態遷移が一貫している", () => {
  const operationArb = fc.oneof(
    fc.record({
      type: fc.constant("sendObject" as const),
      groupId: fc.integer({ min: 0, max: 100 }),
      objectId: fc.integer({ min: 0, max: 100 }),
    }),
    fc.constant({ type: "markClosed" as const }),
    fc.constant({ type: "done" as const }),
    fc.constant({ type: "viewTerminate" as const }),
  );

  fc.assert(
    fc.property(fc.array(operationArb, { minLength: 1, maxLength: 30 }), (operations) => {
      const mock: MockView = { state: "active", forwardState: true };
      const publisher = makePublisher(mock);
      let closedAt = -1;
      let sendErrorCount = 0;

      for (let i = 0; i < operations.length; i++) {
        const op = operations[i];

        if (op.type === "sendObject") {
          if (closedAt !== -1) {
            // 不変条件: closed 後の sendObject は必ずエラー
            try {
              publisher.sendObject({
                groupId: op.groupId,
                objectId: op.objectId,
                payload: new Uint8Array([1, 2, 3]),
              });
              assert.fail("closed 後の sendObject はエラーになるべき");
            } catch {
              sendErrorCount++;
            }
          } else {
            publisher.sendObject({
              groupId: op.groupId,
              objectId: op.objectId,
              payload: new Uint8Array([1, 2, 3]),
            });
          }
        } else if (op.type === "markClosed") {
          publisher.markClosed();
          if (closedAt === -1) closedAt = i;
        } else if (op.type === "done") {
          // done は markClosed 相当 (非同期だがここでは同期的に扱う)
          if (closedAt === -1) closedAt = i;
          publisher.markClosed();
        } else if (op.type === "viewTerminate") {
          mock.state = "closed";
          if (closedAt === -1) closedAt = i;
        }
      }

      // 不変条件: 一度 closed になったら戻らない
      if (closedAt !== -1) {
        assert.equal(publisher.state, "closed");
      }

      // 不変条件: closed 後の sendObject 操作は全てエラー
      const sendAfterClose = operations.filter(
        (op, i) => op.type === "sendObject" && closedAt !== -1 && i > closedAt,
      ).length;
      assert.equal(sendErrorCount, sendAfterClose);
    }),
  );
});
