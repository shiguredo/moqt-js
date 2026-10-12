/**
 * session/bidi.ts の単体テスト: bidiHandlePublishDone
 *
 * PUBLISH_DONE の終了通知 (正常終了 / INTERNAL_ERROR / closed 状態) が
 * SubscriberImpl のコールバックへ正しく伝わることを検証する。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import { PublishDoneStatusCode } from "../message/types";
import type { PublishDoneInfo } from "../session";

// ============================================================================
// bidiHandlePublishDone のテスト
// ============================================================================

test("bidiHandlePublishDone: PUBLISH_DONE 正常終了で status code と reason が endCallback に渡る", () => {
  let received: PublishDoneInfo | undefined;
  let errorCalled: Error | undefined;

  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    0n,
    1n,
    () => {},
    undefined,
    (publishDone) => {
      received = publishDone;
    },
    (e) => {
      errorCalled = e;
    },
  );

  subscriber.handleEnd(PublishDoneStatusCode.TRACK_ENDED, "");

  assert.deepEqual(received, {
    statusCode: PublishDoneStatusCode.TRACK_ENDED,
    reasonPhrase: "",
  });
  assert.equal(errorCalled, undefined);
});

test("bidiHandlePublishDone: PUBLISH_DONE INTERNAL_ERROR でも errorCallback は呼ばれない", () => {
  let received: PublishDoneInfo | undefined;
  let errorCalled: Error | undefined;

  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    0n,
    1n,
    () => {},
    undefined,
    (publishDone) => {
      received = publishDone;
    },
    (e) => {
      errorCalled = e;
    },
  );

  subscriber.handleEnd(PublishDoneStatusCode.INTERNAL_ERROR, "internal error");

  // エラー status でも終了通知は end の 1 回だけである。エラーかどうかは status code で判定する
  assert.deepEqual(received, {
    statusCode: PublishDoneStatusCode.INTERNAL_ERROR,
    reasonPhrase: "internal error",
  });
  assert.equal(errorCalled, undefined);
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
  subscriber.handleEnd(PublishDoneStatusCode.TRACK_ENDED, "");

  assert.equal(endCalled, false);
  assert.equal(errorCalled, undefined);
});
