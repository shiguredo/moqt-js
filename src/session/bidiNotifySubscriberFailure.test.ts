/**
 * session/bidi.ts の単体テスト: notifySubscriberFailure
 *
 * FIN without PUBLISH_DONE の失敗通知
 * notifySubscriberFailure の挙動を検証する。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import { FIN_WITHOUT_PUBLISH_DONE_MESSAGE, notifySubscriberFailure } from "./bidi";
import { createPublishReadTestContext } from "../testSupport/bidi";

// ============================================================================
// notifySubscriberFailure のテスト
// draft-ietf-moq-transport-21 §6.4.2.2 (FIN without PUBLISH_DONE は失敗扱い)
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §6.4.2.2:
 * active な subscriber に対して error 通知が行われ、state が closed になる
 * ことを検証する。
 */
test("notifySubscriberFailure: active な subscriber に error 通知し state を closed にする", () => {
  const ctx = createPublishReadTestContext({});
  let errorCalled: Error | undefined;
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    ctx.requestId,
    1n,
    () => {},
    undefined,
    undefined,
    (e) => {
      errorCalled = e;
    },
  );
  ctx.session.subscribers.set(ctx.requestId, subscriber);

  notifySubscriberFailure(ctx.session, ctx.requestId, new Error(FIN_WITHOUT_PUBLISH_DONE_MESSAGE));

  assert.isDefined(errorCalled);
  assert.equal(errorCalled!.message, FIN_WITHOUT_PUBLISH_DONE_MESSAGE);
  assert.equal(subscriber.state, "closed");
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.2:
 * error コールバックが throw した場合でも、finally で state が closed に
 * なることを検証する (error コールバックの例外で状態遷移が失われない)。
 */
test("notifySubscriberFailure: error コールバックが throw しても state は closed になる", () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    ctx.requestId,
    1n,
    () => {},
    undefined,
    undefined,
    () => {
      throw new Error("error callback failed");
    },
  );
  ctx.session.subscribers.set(ctx.requestId, subscriber);

  let thrown: Error | undefined;
  try {
    notifySubscriberFailure(
      ctx.session,
      ctx.requestId,
      new Error(FIN_WITHOUT_PUBLISH_DONE_MESSAGE),
    );
  } catch (err) {
    thrown = err instanceof Error ? err : new Error(String(err));
  }

  // throw は伝播するが、state は closed になっている
  assert.isDefined(thrown);
  assert.equal(thrown!.message, "error callback failed");
  assert.equal(subscriber.state, "closed");
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.2:
 * subscribers に存在しない requestId (unsubscribe 済み等) では何もしない
 * ことを検証する。
 */
test("notifySubscriberFailure: subscribers に存在しない requestId では何もしない", () => {
  const ctx = createPublishReadTestContext({});
  // subscribers に登録しないまま呼ぶ
  notifySubscriberFailure(ctx.session, ctx.requestId, new Error(FIN_WITHOUT_PUBLISH_DONE_MESSAGE));

  // セッションも閉じず、書き込みも発生しない
  assert.isUndefined(ctx.closedWithError);
  assert.equal(ctx.written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.2:
 * GOAWAY 受信済みの requestId (マイグレーション通知) では何もしないことを
 * 検証する (GOAWAY は subscription state に影響しない)。
 */
test("notifySubscriberFailure: GOAWAY 受信済みの requestId では何もしない", () => {
  const ctx = createPublishReadTestContext({});
  let errorCalled = false;
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    ctx.requestId,
    1n,
    () => {},
    undefined,
    undefined,
    () => {
      errorCalled = true;
    },
  );
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  // GOAWAY を受信済みの状態を作る
  ctx.session.goawayReceivedOnRequestStreams.add(ctx.requestId);

  notifySubscriberFailure(ctx.session, ctx.requestId, new Error(FIN_WITHOUT_PUBLISH_DONE_MESSAGE));

  // error 通知も state 遷移も行われない (migration はアプリの goawayCallback が処理する)
  assert.isFalse(errorCalled);
  assert.equal(subscriber.state, "active");
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.2:
 * state が active でない subscriber (正常な PUBLISH_DONE 済み等) では何も
 * しないことを検証する。
 */
test("notifySubscriberFailure: state が active でない subscriber では何もしない", () => {
  const ctx = createPublishReadTestContext({});
  let errorCalled = false;
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    ctx.requestId,
    1n,
    () => {},
    undefined,
    undefined,
    () => {
      errorCalled = true;
    },
  );
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  subscriber.markClosed();

  notifySubscriberFailure(ctx.session, ctx.requestId, new Error(FIN_WITHOUT_PUBLISH_DONE_MESSAGE));

  assert.isFalse(errorCalled);
  assert.equal(subscriber.state, "closed");
});
