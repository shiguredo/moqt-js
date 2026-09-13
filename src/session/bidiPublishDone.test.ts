/**
 * session/bidi.ts の単体テスト: bidiHandlePublishDone
 *
 * PUBLISH_DONE の終了通知 (正常終了 / INTERNAL_ERROR / closed 状態) が
 * SubscriberImpl のコールバックへ正しく伝わることを検証する。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";

// ============================================================================
// bidiHandlePublishDone のテスト
// ============================================================================

test("bidiHandlePublishDone: PUBLISH_DONE 正常終了で endCallback が呼ばれる", () => {
  let endCalled = false;
  let errorCalled: Error | undefined;

  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    0n,
    1n,
    () => {},
    undefined,
    () => {
      endCalled = true;
    },
    (e) => {
      errorCalled = e;
    },
  );

  subscriber.handleEnd(0x2n, undefined);

  assert.equal(endCalled, true);
  assert.equal(errorCalled, undefined);
});

test("bidiHandlePublishDone: PUBLISH_DONE INTERNAL_ERROR で errorCallback が呼ばれる", () => {
  let errorCalled: Error | undefined;

  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    0n,
    1n,
    () => {},
    undefined,
    () => {},
    (e) => {
      errorCalled = e;
    },
  );

  subscriber.handleEnd(0x0n, "internal error");

  assert.notEqual(errorCalled, undefined);
  assert.isTrue(errorCalled!.message.includes("PUBLISH_DONE"));
  assert.isTrue(errorCalled!.message.includes("internal error"));
});

test("bidiHandlePublishDone: closed 状態では endCallback が呼ばれない", () => {
  let endCalled = false;
  let errorCalled: Error | undefined;

  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    0n,
    1n,
    () => {},
    undefined,
    () => {
      endCalled = true;
    },
    (e) => {
      errorCalled = e;
    },
  );

  subscriber.markClosed();
  subscriber.handleEnd(0x2n, undefined);

  assert.equal(endCalled, false);
  assert.equal(errorCalled, undefined);
});
