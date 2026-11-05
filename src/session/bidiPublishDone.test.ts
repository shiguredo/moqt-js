/**
 * SubscriberImpl.handleEnd の単体テスト
 *
 * PUBLISH_DONE の終了通知 (正常終了 / INTERNAL_ERROR / closed 状態) が
 * SubscriberImpl の endCallback へ正しく伝わることを検証する。
 * bidiHandlePublishDone を含む実ストリーム経路は src/session/bidi.prop.ts が
 * 検証する。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import { PublishDoneStatusCode } from "../message/types";
import type { PublishDoneInfo } from "../session";

// ============================================================================
// SubscriberImpl.handleEnd のテスト
// ============================================================================

test("handleEnd: PUBLISH_DONE 正常終了で status code と reason が endCallback に渡る", () => {
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

  subscriber.handleEnd(PublishDoneStatusCode.TRACK_ENDED, 4n, "");

  assert.deepEqual(received, {
    statusCode: PublishDoneStatusCode.TRACK_ENDED,
    streamCount: 4n,
    reasonPhrase: "",
  });
  assert.equal(errorCalled, undefined);
});

test("handleEnd: PUBLISH_DONE INTERNAL_ERROR でも errorCallback は呼ばれない", () => {
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

  subscriber.handleEnd(PublishDoneStatusCode.INTERNAL_ERROR, 2n, "internal error");

  // エラー status でも終了通知は end の 1 回だけである。エラーかどうかは status code で判定する
  assert.deepEqual(received, {
    statusCode: PublishDoneStatusCode.INTERNAL_ERROR,
    streamCount: 2n,
    reasonPhrase: "internal error",
  });
  assert.equal(errorCalled, undefined);
});

test("handleEnd: closed 状態では endCallback が呼ばれない", () => {
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
  subscriber.handleEnd(PublishDoneStatusCode.TRACK_ENDED, 0n, "");

  assert.equal(endCalled, false);
  assert.equal(errorCalled, undefined);
});
