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
import { FetcherImpl } from "../fetcher";
import {
  bidiReadFetchResponse,
  bidiReadPublishResponse,
  bidiReadSubscribeResponse,
  bidiReadTrackStatusResponse,
} from "./bidi";
import { fullTrackNameKey } from "../fullTrackName";
import { createOkResponseReadTestContext } from "../testSupport/bidi";

// ============================================================================
// 応答読み取りの未カバー分岐 (REQUEST_ERROR / GOAWAY)
// draft-ietf-moq-transport-22 §9.4 (REQUEST_ERROR) / §9.2 (GOAWAY)
// ============================================================================

/**
 * REQUEST_ERROR の Retry Interval / Redirect を RequestError に載せる経路の表。
 *
 * draft-ietf-moq-transport-22 §9.4 (REQUEST_ERROR) / §9.4.2 (Redirect):
 * "Retry Interval" と "Redirect" は応答経路 (PUBLISH / SUBSCRIBE / FETCH /
 * TRACK_STATUS) によらずアプリへ渡す。経路ごとに付け忘れないことを、
 * reader ごとの設定と期待値の組で固定する。
 */
interface RedirectErrorCase {
  /** 受信させる REQUEST_ERROR の reasonPhrase (そのまま message になる) */
  reasonPhrase: string;
  retryInterval: bigint;
  connectUri: string;
  /** Redirect の Track Name (Track Namespace は全ケース共通で ["live"]) */
  trackName: string;
  /** pending 登録・読み取りループ起動・REQUEST_ERROR ペイロードの投入 */
  run: (
    ctx: ReturnType<typeof createOkResponseReadTestContext>,
    payload: Uint8Array,
    onReject: (error: Error) => void,
  ) => Promise<void>;
  /** ケース固有の削除集合の検証 (省略時は共通の検証のみ) */
  verifyCleanup?: (ctx: ReturnType<typeof createOkResponseReadTestContext>) => void;
}

/** REDIRECT の REQUEST_ERROR ペイロードを組み立てる */
function encodeRedirectRequestError(
  reasonPhrase: string,
  retryInterval: bigint,
  connectUri: string,
  trackName: string,
): Uint8Array {
  return encodeRequestErrorPayload({
    type: MessageType.REQUEST_ERROR,
    // draft-ietf-moq-transport-22 §9.4.2: Redirect は Error Code が REDIRECT のときだけ載る
    errorCode: BigInt(RequestErrorCode.REDIRECT),
    reasonPhrase,
    retryInterval,
    redirect: {
      connectUri,
      trackNamespace: createTrackNamespace(["live"]),
      trackName: new TextEncoder().encode(trackName),
    },
  });
}

const REDIRECT_ERROR_CASES: RedirectErrorCase[] = [
  {
    reasonPhrase: "try later",
    retryInterval: 5n,
    connectUri: "moqt://new.example.com",
    trackName: "video",
    run: async (ctx, payload, onReject) => {
      const publisher = new PublisherImpl(["test"], "track", ctx.requestId, 1n, () => {});
      ctx.session.pendingPublish.set(ctx.requestId, {
        resolve: () => {},
        reject: onReject,
        impl: publisher,
      });

      const readPromise = bidiReadPublishResponse(
        ctx.session,
        ctx.requestId,
        ctx.stream,
        ctx.controlReader,
      );
      ctx.readableController.enqueue(
        ctx.session.controlWriter!.encode(MessageType.REQUEST_ERROR, payload),
      );
      ctx.readableController.close();
      await readPromise;
    },
    verifyCleanup: (ctx) => {
      assert.isFalse(ctx.session.pendingPublish.has(ctx.requestId));
      assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
    },
  },
  {
    reasonPhrase: "subscribe redirect",
    retryInterval: 3n,
    connectUri: "moqt://subscribe.example.com",
    trackName: "video",
    run: async (ctx, payload, onReject) => {
      const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
      ctx.session.pendingSubscribe.set(ctx.requestId, {
        resolve: () => {},
        reject: onReject,
        impl: subscriber,
        objectCallback: () => {},
      });

      const readPromise = bidiReadSubscribeResponse(
        ctx.session,
        ctx.requestId,
        ctx.stream,
        ctx.controlReader,
      );
      ctx.readableController.enqueue(
        ctx.session.controlWriter!.encode(MessageType.REQUEST_ERROR, payload),
      );
      ctx.readableController.close();
      await readPromise;
    },
  },
  {
    reasonPhrase: "fetch redirect",
    retryInterval: 7n,
    connectUri: "moqt://fetch.example.com",
    trackName: "audio",
    run: async (ctx, payload, onReject) => {
      const fetcher = new FetcherImpl(["test"], "track", ctx.requestId, () => {});
      ctx.session.pendingFetch.set(ctx.requestId, {
        resolve: () => {},
        reject: onReject,
        impl: fetcher,
      });

      const readPromise = bidiReadFetchResponse(
        ctx.session,
        ctx.requestId,
        ctx.stream,
        ctx.controlReader,
      );
      ctx.readableController.enqueue(
        ctx.session.controlWriter!.encode(MessageType.REQUEST_ERROR, payload),
      );
      ctx.readableController.close();
      await readPromise;
    },
  },
  {
    reasonPhrase: "track status redirect",
    retryInterval: 11n,
    connectUri: "moqt://status.example.com",
    trackName: "video",
    run: async (ctx, payload, onReject) => {
      ctx.session.pendingTrackStatus.set(ctx.requestId, {
        // malformed 検出時の cross-cancel 用の比較キー (本テストでは未使用)
        trackKey: fullTrackNameKey(["test"], "track"),
        resolve: () => {},
        reject: onReject,
      });

      const readPromise = bidiReadTrackStatusResponse(
        ctx.session,
        ctx.requestId,
        ctx.stream,
        ctx.controlReader,
      );
      ctx.readableController.enqueue(
        ctx.session.controlWriter!.encode(MessageType.REQUEST_ERROR, payload),
      );
      ctx.readableController.close();
      await readPromise;
    },
  },
];

/**
 * draft-ietf-moq-transport-22 §9.4 / §9.4.2 / §12.3:
 * REQUEST_ERROR の Retry Interval と Redirect は、どの応答 reader でも
 * RequestError に保持してアプリへ渡す。pending と requestStreams のエントリは
 * 残さず、セッションは閉じない (リクエスト単位の失敗である)。
 * reader 間で違うのは入力値と pending の種類だけであるため表駆動 1 本に統合する。
 */
test("REQUEST_ERROR の retryInterval と redirect はどの応答 reader でも RequestError に載る", async () => {
  for (const testCase of REDIRECT_ERROR_CASES) {
    const ctx = createOkResponseReadTestContext();
    let rejected: Error | undefined;
    const payload = encodeRedirectRequestError(
      testCase.reasonPhrase,
      testCase.retryInterval,
      testCase.connectUri,
      testCase.trackName,
    );

    await testCase.run(ctx, payload, (error) => {
      rejected = error;
    });

    assert.instanceOf(rejected, RequestError);
    const requestError = rejected as RequestError;
    assert.equal(requestError.message, testCase.reasonPhrase);
    assert.equal(requestError.code, RequestErrorCode.REDIRECT);
    assert.equal(requestError.retryInterval, testCase.retryInterval);
    // RedirectInfo は decode 結果をそのまま保持する (Namespace / Track Name はバイト列)
    assert.deepEqual(requestError.redirect, {
      connectUri: testCase.connectUri,
      trackNamespace: [new TextEncoder().encode("live")],
      trackName: new TextEncoder().encode(testCase.trackName),
    });
    // リクエスト単位の失敗でありセッションは閉じない
    assert.isUndefined(ctx.getClosedWithError());
    testCase.verifyCleanup?.(ctx);
  }
});

/**
 * draft-ietf-moq-transport-22 §9.4:
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
  // REDIRECT 以外のコードでは Retry Interval だけが載り、Redirect は付かない
  assert.equal((rejected as RequestError).retryInterval, 0n);
  assert.isUndefined((rejected as RequestError).redirect);
  assert.isUndefined(ctx.getClosedWithError());
  assert.isFalse(ctx.session.pendingSubscribe.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isFalse(ctx.session.fillFetchTargets.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-22 §9.2:
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
 * draft-ietf-moq-transport-22 §9.2:
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
