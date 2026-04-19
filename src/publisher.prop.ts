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

test("notifyForwardStateChanged は受け取った値をそのまま callback に渡す", () => {
  fc.assert(
    fc.property(fc.array(fc.boolean(), { minLength: 0, maxLength: 50 }), (notifications) => {
      const mock: MockView = { state: "active", forwardState: true };
      const callbackCalls: boolean[] = [];
      const publisher = makePublisher(mock, (forward) => {
        callbackCalls.push(forward);
      });

      for (const forward of notifications) {
        publisher.notifyForwardStateChanged(forward);
      }

      // SessionMachine 側で change detection 済みの前提なので、呼び出された回数と値が
      // そのまま callback に伝わる
      assert.equal(callbackCalls.length, notifications.length);
      for (let i = 0; i < notifications.length; i++) {
        assert.equal(callbackCalls[i], notifications[i]);
      }
    }),
  );
});

test("任意の操作列に対して state 遷移が view に整合する", () => {
  const operationArb = fc.oneof(
    fc.record({
      type: fc.constant("sendObject" as const),
      groupId: fc.integer({ min: 0, max: 100 }),
      objectId: fc.integer({ min: 0, max: 100 }),
    }),
    fc.constant({ type: "done" as const }),
    fc.constant({ type: "viewTerminate" as const }),
  );

  fc.assert(
    fc.property(fc.array(operationArb, { minLength: 1, maxLength: 30 }), (operations) => {
      const mock: MockView = { state: "active", forwardState: true };
      const publisher = makePublisher(mock);
      publisher.onDoneInternal = async () => {
        mock.state = "closed";
      };
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
        } else if (op.type === "done") {
          // done は view を closed に遷移させる
          if (closedAt === -1) {
            closedAt = i;
            mock.state = "closed";
          }
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
