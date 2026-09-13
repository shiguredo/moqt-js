/**
 * session/bidi.ts の単体テスト: 応答読み取りの未カバー分岐 (REQUEST_ERROR / GOAWAY)
 *
 * REQUEST_ERROR の付加情報の伝播と、確立前 GOAWAY の応答経路別の
 * 通知方法を検証する。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import { encodeRequestErrorPayload, encodeGoawayPayload } from "../message/session";
import { MessageType, GroupOrder } from "../message/types";
import { createTrackNamespace } from "../message";
import { RequestErrorCode, RequestError } from "../error";
import { PublisherImpl } from "../publisher";
import {
  bidiReadPublishResponse,
  bidiReadSubscribeResponse,
  bidiReadTrackStatusResponse,
} from "./bidi";
import { fullTrackNameKey } from "../fullTrackName";
import { createOkResponseReadTestContext } from "../testSupport/bidi";

// ============================================================================
// 応答読み取りの未カバー分岐 (REQUEST_ERROR / GOAWAY)
// draft-ietf-moq-transport-21 §9.4 (REQUEST_ERROR) / §9.2 (GOAWAY)
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.4:
 * REQUEST_ERROR の Retry Interval と Redirect は RequestError に保持して
 * アプリへ渡す。pending と requestStreams のエントリは残さず、セッションは
 * 閉じない (リクエスト単位の失敗である)。
 */
test("bidiReadPublishResponse: REQUEST_ERROR の retryInterval と redirect が RequestError に載る", async () => {
  const ctx = createOkResponseReadTestContext();
  const publisher = new PublisherImpl(["test"], "track", ctx.requestId, 1n, () => {});
  let rejected: Error | undefined;
  ctx.session.pendingPublish.set(ctx.requestId, {
    resolve: () => {},
    reject: (error: Error) => {
      rejected = error;
    },
    impl: publisher,
  });

  const readPromise = bidiReadPublishResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  const errorPayload = encodeRequestErrorPayload({
    type: MessageType.REQUEST_ERROR,
    // draft-ietf-moq-transport-21 §9.4.2: Redirect は Error Code が REDIRECT のときだけ載る
    errorCode: BigInt(RequestErrorCode.REDIRECT),
    reasonPhrase: "try later",
    retryInterval: 5n,
    redirect: {
      connectUri: "moqt://new.example.com",
      trackNamespace: createTrackNamespace(["live"]),
      trackName: new TextEncoder().encode("video"),
    },
  });
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.REQUEST_ERROR, errorPayload),
  );
  ctx.readableController.close();
  await readPromise;

  assert.instanceOf(rejected, RequestError);
  const requestError = rejected as RequestError;
  assert.equal(requestError.message, "try later");
  assert.equal(requestError.code, RequestErrorCode.REDIRECT);
  assert.equal(requestError.retryInterval, 5n);
  // RedirectInfo は decode 結果をそのまま保持する (Namespace / Track Name はバイト列)
  assert.deepEqual(requestError.redirect, {
    connectUri: "moqt://new.example.com",
    trackNamespace: [new TextEncoder().encode("live")],
    trackName: new TextEncoder().encode("video"),
  });
  // リクエスト単位の失敗でありセッションは閉じない
  assert.isUndefined(ctx.getClosedWithError());
  assert.isFalse(ctx.session.pendingPublish.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §9.4:
 * SUBSCRIBE の REQUEST_ERROR では pending と requestStreams に加えて、
 * 初回 fill の関連付け (fillFetchTargets) も残さない。
 */
test("bidiReadSubscribeResponse: REQUEST_ERROR で fillFetchTargets も削除される", async () => {
  const ctx = createOkResponseReadTestContext();
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  let rejected: Error | undefined;
  ctx.session.pendingSubscribe.set(ctx.requestId, {
    resolve: () => {},
    reject: (error: Error) => {
      rejected = error;
    },
    impl: subscriber,
    objectCallback: () => {},
  });
  ctx.session.fillFetchTargets.set(ctx.requestId, {
    subscriber,
    groupOrder: GroupOrder.ASCENDING,
  });

  const readPromise = bidiReadSubscribeResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  const errorPayload = encodeRequestErrorPayload({
    type: MessageType.REQUEST_ERROR,
    errorCode: BigInt(RequestErrorCode.PREFIX_OVERLAP),
    reasonPhrase: "prefix overlap",
    retryInterval: 0n,
  });
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.REQUEST_ERROR, errorPayload),
  );
  ctx.readableController.close();
  await readPromise;

  assert.instanceOf(rejected, RequestError);
  assert.equal((rejected as RequestError).code, RequestErrorCode.PREFIX_OVERLAP);
  assert.isUndefined(ctx.getClosedWithError());
  assert.isFalse(ctx.session.pendingSubscribe.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isFalse(ctx.session.fillFetchTargets.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §9.2:
 * 確立前の GOAWAY は当該リクエストのマイグレーションであり、購読の
 * goawayCallback へ新しい URI を通知する。pending と requestStreams に加えて
 * 初回 fill の関連付けも削除し、同一ストリームの 2 通目検出のために
 * goawayReceivedOnRequestStreams へ登録する。セッションは閉じない。
 */
test("bidiReadSubscribeResponse: 確立前 GOAWAY で goawayCallback と削除集合が処理される", async () => {
  const ctx = createOkResponseReadTestContext();
  const goawayUris: string[] = [];
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  subscriber.goawayCallback = (uri) => {
    goawayUris.push(uri);
  };
  let rejected: Error | undefined;
  ctx.session.pendingSubscribe.set(ctx.requestId, {
    resolve: () => {},
    reject: (error: Error) => {
      rejected = error;
    },
    impl: subscriber,
    objectCallback: () => {},
  });
  ctx.session.fillFetchTargets.set(ctx.requestId, {
    subscriber,
    groupOrder: GroupOrder.ASCENDING,
  });

  const readPromise = bidiReadSubscribeResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "moqt://new.example.com",
    timeout: 0n,
  });
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.GOAWAY, goawayPayload),
  );
  ctx.readableController.close();
  await readPromise;

  assert.deepEqual(goawayUris, ["moqt://new.example.com"]);
  assert.isDefined(rejected);
  assert.equal(rejected!.message, "request stream goaway");
  // リクエスト単位のマイグレーションでありセッションは閉じない
  assert.isUndefined(ctx.getClosedWithError());
  assert.isFalse(ctx.session.pendingSubscribe.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isFalse(ctx.session.fillFetchTargets.has(ctx.requestId));
  assert.isTrue(ctx.session.goawayReceivedOnRequestStreams.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §9.2:
 * TRACK_STATUS は単発リクエストであり ongoing loop を持たないため、
 * 確立前 GOAWAY で goawayCallback は呼ばない。新しい URI は reject する
 * Error のメッセージに含めて通知する。セッションは閉じない。
 */
test("bidiReadTrackStatusResponse: 確立前 GOAWAY は goawayCallback を呼ばずメッセージで通知する", async () => {
  const ctx = createOkResponseReadTestContext();
  let rejected: Error | undefined;
  ctx.session.pendingTrackStatus.set(ctx.requestId, {
    resolve: () => {},
    reject: (error: Error) => {
      rejected = error;
    },
    trackKey: fullTrackNameKey(["test"], "track"),
  });

  const readPromise = bidiReadTrackStatusResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "moqt://new.example.com",
    timeout: 0n,
  });
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.GOAWAY, goawayPayload),
  );
  ctx.readableController.close();
  await readPromise;

  // newSessionUri はメッセージ経由で通知される
  assert.isDefined(rejected);
  assert.isTrue(rejected!.message.includes("moqt://new.example.com"));
  assert.isUndefined(ctx.getClosedWithError());
  assert.isFalse(ctx.session.pendingTrackStatus.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isTrue(ctx.session.goawayReceivedOnRequestStreams.has(ctx.requestId));
});
