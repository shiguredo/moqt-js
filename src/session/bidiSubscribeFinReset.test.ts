/**
 * session/bidi.ts の単体テスト: bidiReadRequestStreamMessages の FIN / RESET_STREAM 検出
 *
 * subscribe / publish ロールのリクエストストリームで FIN と RESET_STREAM を
 * 検出したときの通知・保留中 REQUEST_UPDATE の後始末を検証する。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import {
  encodeRequestOkPayload,
  encodeRequestErrorPayload,
  encodeGoawayPayload,
} from "../message/session";
import { encodePublishDonePayload } from "../message/publish";
import { MessageType } from "../message/types";
import { RequestErrorCode, RequestError, SessionErrorCode } from "../error";
import { REQUEST_UPDATE_STREAM_CLOSED_MESSAGE } from "./namespaceLoops";
import {
  bidiReadRequestStreamMessages,
  FIN_WITHOUT_PUBLISH_DONE_MESSAGE,
  RESET_REQUEST_STREAM_MESSAGE,
  createResetStreamError,
} from "./bidi";
import { createPublishReadTestContext } from "../testSupport/bidi";

// ============================================================================
// bidiReadRequestStreamMessages の FIN / RESET_STREAM 検出 (subscribe ロール) テスト
// draft-ietf-moq-transport-21 §6.4.2.2 (FIN) / §6.4.2.3 (RESET_STREAM)
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §6.4.2.2:
 * subscribe ロールでピア (publisher) が PUBLISH_DONE なしに FIN した場合、
 * error コールバックが呼ばれ state が closed になることを検証する。
 */
test("bidiReadRequestStreamMessages: ピアの FIN (subscribe ロール) で error 通知され state が closed になる", async () => {
  const ctx = createPublishReadTestContext({});
  let errorCalled: Error | undefined;
  let endCalled = false;
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    ctx.requestId,
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
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  // ピアの FIN を再現する
  ctx.readableController.close();
  await readPromise;

  // error 通知 + state closed。end は呼ばれない (FIN は失敗扱いであり正常終了ではない)
  assert.isDefined(errorCalled);
  assert.equal(errorCalled!.message, FIN_WITHOUT_PUBLISH_DONE_MESSAGE);
  assert.equal(subscriber.state, "closed");
  assert.isFalse(endCalled);
});

/**
 * draft-ietf-moq-transport-21 §9.5.1 / §6.4.2.2:
 * subscribe ロールでピアが FIN した場合、応答待ちの REQUEST_UPDATE
 * (update() の Promise) が reject され、エントリが削除されることを検証する。
 * 未解決のまま残すとアプリは FIN 後に update() の結果を待ち続ける。
 */
test("bidiReadRequestStreamMessages: ピアの FIN (subscribe ロール) で応答待ちの REQUEST_UPDATE が reject される", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  let rejected: Error | undefined;
  ctx.session.pendingRequestUpdate.set(90n, {
    resolve: () => {},
    reject: (err: Error) => {
      rejected = err;
    },
    targetRequestId: ctx.requestId,
  });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  // ピアの FIN を再現する
  ctx.readableController.close();
  await readPromise;

  // 応答待ちの REQUEST_UPDATE が reject され、エントリが削除される
  assert.isDefined(rejected);
  assert.equal(rejected!.message, REQUEST_UPDATE_STREAM_CLOSED_MESSAGE);
  assert.equal(ctx.session.pendingRequestUpdate.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.3:
 * subscribe ロールでピアが RESET_STREAM でストリームをエラー終了させた場合、
 * error コールバックが呼ばれ state が closed になることを検証する。プロトコル
 * 違反ではないためセッションは閉じない。エラーメッセージは FIN 経路
 * (PUBLISH_DONE なし) と区別できる固定文言になる。
 */
test("bidiReadRequestStreamMessages: ピアの RESET_STREAM (subscribe ロール) で error 通知され state が closed になる", async () => {
  const ctx = createPublishReadTestContext({});
  let errorCalled: Error | undefined;
  let endCalled = false;
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    ctx.requestId,
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
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  // ピアの RESET_STREAM 相当 (source: "stream" の reject) を再現する
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), { source: "stream" }),
  );
  await readPromise;

  // error 通知 + state closed + end は呼ばれない。セッションは閉じない
  assert.isDefined(errorCalled);
  assert.equal(errorCalled!.message, RESET_REQUEST_STREAM_MESSAGE);
  assert.equal(subscriber.state, "closed");
  assert.isFalse(endCalled);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.2 / §6.4.2.3 / §9.5.1:
 * subscribe ロールでピアが RESET_STREAM でストリームをエラー終了させた場合、
 * 応答待ちの REQUEST_UPDATE (update() の Promise) が reject され、エントリが
 * 削除されることを検証する。FIN 経路と同じ文言で失敗として扱う。
 */
test("bidiReadRequestStreamMessages: ピアの RESET_STREAM (subscribe ロール) で応答待ちの REQUEST_UPDATE が reject される", async () => {
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
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  // RESET 前に送信済みで応答待ちの REQUEST_UPDATE を注入する
  let rejected: Error | undefined;
  ctx.session.pendingRequestUpdate.set(90n, {
    resolve: () => {},
    reject: (err: Error) => {
      rejected = err;
    },
    targetRequestId: ctx.requestId,
  });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  // ピアの RESET_STREAM 相当 (source: "stream" の reject) を再現する
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), { source: "stream" }),
  );
  await readPromise;

  // 応答待ちの REQUEST_UPDATE が FIN 経路と同じ文言で reject され、
  // エントリが削除される。error 通知も行われる
  assert.isDefined(rejected);
  assert.equal(rejected!.message, REQUEST_UPDATE_STREAM_CLOSED_MESSAGE);
  assert.equal(ctx.session.pendingRequestUpdate.size, 0);
  assert.isDefined(errorCalled);
  assert.equal(subscriber.state, "closed");
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.2 / §6.4.2.3:
 * RESET_STREAM 通知でアプリの error コールバックが throw しても、
 * 応答待ちの REQUEST_UPDATE の reject が先に実行済みであることを検証する。
 * 通知より reject を先に置く順序の根拠を固定する。
 */
test("bidiReadRequestStreamMessages: RESET_STREAM 通知で error コールバックが throw しても応答待ちの更新は reject される", async () => {
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
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  // RESET 前に送信済みで応答待ちの REQUEST_UPDATE を注入する
  let rejected: Error | undefined;
  ctx.session.pendingRequestUpdate.set(90n, {
    resolve: () => {},
    reject: (err: Error) => {
      rejected = err;
    },
    targetRequestId: ctx.requestId,
  });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), { source: "stream" }),
  );
  await readPromise;

  // コールバック例外があっても reject は実行済みでエントリは削除される
  assert.isDefined(rejected);
  assert.equal(rejected!.message, REQUEST_UPDATE_STREAM_CLOSED_MESSAGE);
  assert.equal(ctx.session.pendingRequestUpdate.size, 0);
  assert.equal(subscriber.state, "closed");
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.2:
 * GOAWAY 受信済みの subscribe ロールで RESET_STREAM が起きても、
 * 保留中の REQUEST_UPDATE には触れないことを検証する (GOAWAY 掃除に委ねる)。
 * 呼び出し自体が起きないため、注入したエントリが残る。
 */
test("bidiReadRequestStreamMessages: GOAWAY 受信後の RESET_STREAM では応答待ちの更新に触れない", async () => {
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
  ctx.session.subscribersByAlias.set(1n, [subscriber]);
  ctx.session.goawayReceivedOnRequestStreams.add(ctx.requestId);

  // GOAWAY 掃除をすり抜けた保留中の更新を模して注入する
  let rejected: Error | undefined;
  ctx.session.pendingRequestUpdate.set(90n, {
    resolve: () => {},
    reject: (err: Error) => {
      rejected = err;
    },
    targetRequestId: ctx.requestId,
  });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), { source: "stream" }),
  );
  await readPromise;

  // GOAWAY 後の破壊は migration の完了であり、reject も通知もしない
  assert.isUndefined(rejected);
  assert.equal(ctx.session.pendingRequestUpdate.size, 1);
  assert.isFalse(errorCalled);
  assert.equal(subscriber.state, "active");
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.3 / §6.6:
 * セッション終了起因 (source: "session") の読み取り失敗では、
 * 保留中の REQUEST_UPDATE に触れないことを検証する。
 */
test("bidiReadRequestStreamMessages: セッション終了の読み取り失敗では応答待ちの更新に触れない", async () => {
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
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  let rejected: Error | undefined;
  ctx.session.pendingRequestUpdate.set(90n, {
    resolve: () => {},
    reject: (err: Error) => {
      rejected = err;
    },
    targetRequestId: ctx.requestId,
  });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  ctx.readableController.error(
    Object.assign(new Error("session closed by peer"), { source: "session" }),
  );
  await readPromise;

  // セッション終了は購読者への通知対象外であり、保留中の更新にも触れない
  assert.isUndefined(rejected);
  assert.equal(ctx.session.pendingRequestUpdate.size, 1);
  assert.isFalse(errorCalled);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §12.5:
 * ピアが RESET_STREAM にエラーコードを付けて終了した場合、通知される
 * エラーのメッセージにコード名が付加され、構造化されたコード値でも
 * 参照できることを検証する。アプリが終了理由を区別できるようにする
 * ための振る舞いであり、セッションは閉じない。
 */
test("bidiReadRequestStreamMessages: ピアの RESET_STREAM のエラーコードが通知内容に反映される", async () => {
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
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  // ピアが TOO_FAR_BEHIND (0x5) でリセットした場合を再現する
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), {
      source: "stream",
      streamErrorCode: 0x5,
    }),
  );
  await readPromise;

  // コード名付きの可変文言と正規化済みコード値の両方が伝わる
  assert.isDefined(errorCalled);
  assert.equal(errorCalled!.message, `${RESET_REQUEST_STREAM_MESSAGE}: TOO_FAR_BEHIND(0x5)`);
  assert.equal((errorCalled as unknown as { streamErrorCode?: unknown }).streamErrorCode, 0x5);
  assert.equal(subscriber.state, "closed");
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §12.5:
 * ピアの実装がエラーコードを提供しない場合 (undefined) は、従来の固定文言
 * のみで通知し、コード値のプロパティを付けないことを検証する。
 * 仕様外の組み合わせに対する後方互換の振る舞いである。
 */
test("bidiReadRequestStreamMessages: RESET_STREAM のエラーコードが無い場合は固定文言のみで通知される", async () => {
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
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  // エラーコードを持たない実装からのリセットを再現する
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), {
      source: "stream",
      streamErrorCode: undefined,
    }),
  );
  await readPromise;

  // 固定文言のみで、コード値のプロパティは存在しない
  assert.isDefined(errorCalled);
  assert.equal(errorCalled!.message, RESET_REQUEST_STREAM_MESSAGE);
  assert.isFalse("streamErrorCode" in errorCalled!);
  assert.equal(subscriber.state, "closed");
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §12.5:
 * 仕様の列挙に無いエラーコードでリセットされた場合は内部エラーに正規化
 * されることを検証する。未知値の扱いはデータストリーム系エラーコードの
 * 共通規則に従う。
 */
test("bidiReadRequestStreamMessages: 未知の RESET_STREAM エラーコードは内部エラーに正規化される", async () => {
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
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  // 列挙に無いコード値でのリセットを再現する
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), {
      source: "stream",
      streamErrorCode: 0x99,
    }),
  );
  await readPromise;

  // 内部エラー名と 0x0 に正規化される
  assert.isDefined(errorCalled);
  assert.equal(errorCalled!.message, `${RESET_REQUEST_STREAM_MESSAGE}: INTERNAL_ERROR(0x0)`);
  assert.equal((errorCalled as unknown as { streamErrorCode?: unknown }).streamErrorCode, 0x0);
  assert.equal(subscriber.state, "closed");
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §12.5:
 * エラーコードが数値以外 (他実装の型差異など) の場合は固定文言のみで
 * 通知することを検証する。文字列比較に依存せず構造化値の有無で判断
 * できるようにするため、プロパティ自体を付けない。
 */
test("bidiReadRequestStreamMessages: 数値でない RESET_STREAM エラーコードは無視される", async () => {
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
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  // 数値でないコード値でのリセットを再現する
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), {
      source: "stream",
      streamErrorCode: "1",
    }),
  );
  await readPromise;

  // 固定文言のみで、コード値のプロパティは存在しない
  assert.isDefined(errorCalled);
  assert.equal(errorCalled!.message, RESET_REQUEST_STREAM_MESSAGE);
  assert.isFalse("streamErrorCode" in errorCalled!);
  assert.equal(subscriber.state, "closed");
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §12.5:
 * 通知用エラー組み立ての単体検証。
 * 読み取り失敗値の取り出し・正規化・文言付加の対応を、ストリーム駆動を
 * 介さず直接確認する。受信 PUBLISH 経路も同じ組み立てを共用するため、
 * 両経路の文言一致が構造的に保たれる。
 */
test("createResetStreamError: エラーコードの有無と未知値の扱いが仕様どおりになる", () => {
  // 既知のコード値は名称付き文言とコード値を持つ
  const known = createResetStreamError(
    Object.assign(new Error("reset"), { source: "stream", streamErrorCode: 0x1 }),
  );
  assert.equal(known.message, `${RESET_REQUEST_STREAM_MESSAGE}: CANCELLED(0x1)`);
  assert.equal((known as unknown as { streamErrorCode?: unknown }).streamErrorCode, 0x1);

  // 2 桁表示のコード値も仕様表記どおりに組み立てられる
  const twoDigits = createResetStreamError(
    Object.assign(new Error("reset"), { source: "stream", streamErrorCode: 0x12 }),
  );
  assert.equal(twoDigits.message, `${RESET_REQUEST_STREAM_MESSAGE}: MALFORMED_TRACK(0x12)`);
  assert.equal((twoDigits as unknown as { streamErrorCode?: unknown }).streamErrorCode, 0x12);

  // コード値が無い場合は固定文言のみでプロパティを持たない
  const missing = createResetStreamError(Object.assign(new Error("reset"), { source: "stream" }));
  assert.equal(missing.message, RESET_REQUEST_STREAM_MESSAGE);
  assert.isFalse("streamErrorCode" in missing);

  // 未知値は内部エラーに正規化される
  const unknownCode = createResetStreamError(
    Object.assign(new Error("reset"), { source: "stream", streamErrorCode: 0x99 }),
  );
  assert.equal(unknownCode.message, `${RESET_REQUEST_STREAM_MESSAGE}: INTERNAL_ERROR(0x0)`);
  assert.equal((unknownCode as unknown as { streamErrorCode?: unknown }).streamErrorCode, 0x0);

  // 数値だが列挙外の境界値も内部エラーに正規化される
  for (const boundary of [Number.NaN, 1.5, -1, 2 ** 53]) {
    const normalized = createResetStreamError(
      Object.assign(new Error("reset"), { source: "stream", streamErrorCode: boundary }),
    );
    assert.equal(normalized.message, `${RESET_REQUEST_STREAM_MESSAGE}: INTERNAL_ERROR(0x0)`);
    assert.equal((normalized as unknown as { streamErrorCode?: unknown }).streamErrorCode, 0x0);
  }

  // 数値以外 (文字列・bigint) は固定文言のみでプロパティを持たない
  const stringCode = createResetStreamError(
    Object.assign(new Error("reset"), { source: "stream", streamErrorCode: "1" }),
  );
  assert.equal(stringCode.message, RESET_REQUEST_STREAM_MESSAGE);
  assert.isFalse("streamErrorCode" in stringCode);
  const bigintCode = createResetStreamError(
    Object.assign(new Error("reset"), { source: "stream", streamErrorCode: 1n }),
  );
  assert.equal(bigintCode.message, RESET_REQUEST_STREAM_MESSAGE);
  assert.isFalse("streamErrorCode" in bigintCode);

  // 非オブジェクトや null は固定文言のみで例外を投げない
  const nullError = createResetStreamError(null);
  assert.equal(nullError.message, RESET_REQUEST_STREAM_MESSAGE);
  assert.isFalse("streamErrorCode" in nullError);
  const undefinedError = createResetStreamError(undefined);
  assert.equal(undefinedError.message, RESET_REQUEST_STREAM_MESSAGE);
  assert.isFalse("streamErrorCode" in undefinedError);
});

/**
 * draft-ietf-moq-transport-21 §9.2 / §6.4.2.3:
 * GOAWAY 受信済みの subscribe ロールの RESET_STREAM では error 通知されない
 * ことを検証する (GOAWAY 後の旧ストリームの破壊は migration の完了であり、
 * GOAWAY 後の FIN と同じ扱い)。修正前の実装でも通る回帰ガードである
 * (通知経路の拡大を防ぐ)。
 */
test("bidiReadRequestStreamMessages: GOAWAY 受信後の RESET_STREAM (subscribe ロール) では error 通知されない", async () => {
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
  ctx.session.subscribersByAlias.set(1n, [subscriber]);
  ctx.session.goawayReceivedOnRequestStreams.add(ctx.requestId);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), { source: "stream" }),
  );
  await readPromise;

  // GOAWAY 後は state も変更されない (notifySubscriberFailure 全体が no-op)
  assert.isFalse(errorCalled);
  assert.equal(subscriber.state, "active");
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.3:
 * publish ロールのピア (requester) の RESET_STREAM では error 通知されない
 * ことを検証する (対象ロール限定の回帰ガード。修正前の実装でも通る)。
 */
test("bidiReadRequestStreamMessages: ピアの RESET_STREAM (publish ロール) では error 通知されない", async () => {
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
  // publish ロールにも subscriber を登録しておき、呼ばれないことを検証する
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), { source: "stream" }),
  );
  await readPromise;

  assert.isFalse(errorCalled);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * publish ロールの検証用に、開いている Subgroup データストリームと送信キューを
 * 登録する。abort の到達理由を記録する。
 */
function setOpenPublisherStream(ctx: ReturnType<typeof createPublishReadTestContext>): {
  trackAlias: bigint;
  dataAborted: unknown[];
} {
  const trackAlias = ctx.publisher.getTrackAlias();
  const dataAborted: unknown[] = [];
  const dataWritable = new WritableStream<Uint8Array>({
    abort(reason) {
      dataAborted.push(reason);
    },
  });
  ctx.session.publisherStreams.set(trackAlias, {
    groupId: 0n,
    writer: dataWritable.getWriter(),
    previousObjectId: -1n,
  });
  ctx.session.publisherSendQueues.set(trackAlias, Promise.resolve());
  ctx.session.closedSubgroups.add(`${trackAlias}:0`);
  return { trackAlias, dataAborted };
}

/**
 * draft-ietf-moq-transport-21 §3.1.1:
 * 「The Publisher can remove subscription state as soon as it has received
 *  STOP_SENDING.  It MUST reset any open streams associated with the
 *  SUBSCRIBE.」
 * publish ロールでピアの STOP_SENDING (送信方向 reset) を検出したとき、
 * 開いている Subgroup データストリームを reset (abort) し、購読状態を削除して
 * PublisherImpl を closed にする。
 */
test("bidiReadRequestStreamMessages: publish ロールで STOP_SENDING を検出してデータストリームを reset する", async () => {
  const ctx = createPublishReadTestContext({});
  const { trackAlias, dataAborted } = setOpenPublisherStream(ctx);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // ピアの STOP_SENDING 相当: 当方の送信方向を reset して writer.closed を
  // reject させ、送信方向の終了監視を発火させる
  const streamInfo = ctx.session.requestStreams.get(ctx.requestId) as unknown as {
    writer: WritableStreamDefaultWriter<Uint8Array>;
  };
  // ピア起因 (source: "stream") の送信方向終了として writer.closed を reject させる
  await streamInfo.writer.abort(Object.assign(new Error("stop sending"), { source: "stream" }));
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  assert.deepEqual(dataAborted, ["peer cancelled subscription"]);
  assert.isFalse(ctx.session.publisherStreams.has(trackAlias));
  assert.isFalse(ctx.session.publisherSendQueues.has(trackAlias));
  assert.isFalse(ctx.session.closedSubgroups.has(`${trackAlias}:0`));
  assert.isFalse(ctx.session.publishers.has(ctx.requestId));
  assert.equal(ctx.publisher.state, "closed");
  // 読み取りループを終わらせる
  ctx.readableController.close();
  await readPromise;
});

/**
 * draft-ietf-moq-transport-21 §3.1.1:
 * publish ロールでピアの RESET_STREAM (reader.read() の reject) を検出した
 * ときも、開いている Subgroup データストリームを reset (abort) し、購読状態を
 * 削除して PublisherImpl を closed にする。
 */
test("bidiReadRequestStreamMessages: publish ロールで RESET_STREAM を検出してデータストリームを reset する", async () => {
  const ctx = createPublishReadTestContext({});
  const { trackAlias, dataAborted } = setOpenPublisherStream(ctx);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), { source: "stream" }),
  );
  await readPromise;
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  assert.deepEqual(dataAborted, ["peer cancelled subscription"]);
  assert.isFalse(ctx.session.publisherStreams.has(trackAlias));
  assert.isFalse(ctx.session.publisherSendQueues.has(trackAlias));
  assert.isFalse(ctx.session.closedSubgroups.has(`${trackAlias}:0`));
  assert.isFalse(ctx.session.publishers.has(ctx.requestId));
  assert.equal(ctx.publisher.state, "closed");
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.3:
 * error コールバックが throw しても、notification 経路で吸収され unhandled
 * rejection にならず、state が closed になることを検証する。
 */
test("bidiReadRequestStreamMessages: RESET_STREAM 通知で error コールバックが throw しても state は closed になる", async () => {
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
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), { source: "stream" }),
  );
  // コールバック例外が伝播して unhandled rejection にならないこと (await が解決する)
  await readPromise;

  assert.equal(subscriber.state, "closed");
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.3 / §6.6:
 * ピア起因のセッション終了 (source: "session") および source を持たない
 * 内部エラーでは error コールバックが呼ばれないことを検証する
 * (isPeerStreamError ガードの回帰ガード。修正前の実装でも通る)。
 */
test("bidiReadRequestStreamMessages: セッション終了や source なしエラー (subscribe ロール) では error 通知されない", async () => {
  const errors: Error[] = [
    Object.assign(new Error("session closed by peer"), { source: "session" }),
    new Error("internal error"),
  ];
  for (const error of errors) {
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
    ctx.session.subscribersByAlias.set(1n, [subscriber]);

    const readPromise = bidiReadRequestStreamMessages(
      ctx.session,
      ctx.requestId,
      ctx.stream,
      ctx.controlReader,
      "subscribe",
    );
    ctx.readableController.error(error);
    await readPromise;

    assert.isFalse(errorCalled, `エラー通知が発生しました: ${error.message}`);
    assert.isUndefined(ctx.closedWithError);
  }
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.2:
 * publish ロールではピア (requester) の FIN は正常完了シグナルであり、
 * error 通知されず state も変更されないことを検証する (対象ロール限定の
 * 回帰ガード)。
 */
test("bidiReadRequestStreamMessages: ピアの FIN (publish ロール) では error 通知されない", async () => {
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
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  ctx.readableController.close();
  await readPromise;

  // error 通知も state 遷移も行われない
  assert.isFalse(errorCalled);
  assert.equal(subscriber.state, "active");
});

/**
 * draft-ietf-moq-transport-21 §9.2 / §6.4.2.2:
 * GOAWAY 受信後の FIN (subscribe ロール) では error 通知されないことを
 * 検証する (GOAWAY は migration 通知であり失敗ではない)。
 */
test("bidiReadRequestStreamMessages: GOAWAY 受信後の FIN (subscribe ロール) では error 通知されない", async () => {
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
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  // GOAWAY を実際に feed してから FIN する (validateNoDuplicateGoawayOnRequestStream
  // が goawayReceivedOnRequestStreams に登録する実経路)
  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "moqt://new.example.com",
    timeout: 0n,
  });
  const goawayMessage = ctx.session.controlWriter!.encode(MessageType.GOAWAY, goawayPayload);
  ctx.readableController.enqueue(goawayMessage);
  ctx.readableController.close();
  await readPromise;

  // error 通知も state 遷移も行われない
  assert.isFalse(errorCalled);
  assert.equal(subscriber.state, "active");
  // GOAWAY ハンドラが close() 済み (events に "close" が 1 回入る)。FIN 検出時の
  // 2 回目の close() は reject して黙殺されるため、sink の close は 1 回のみ
  // (unhandled rejection も発生しない)
  assert.deepEqual(ctx.events, ["close"]);
});

/**
 * draft-ietf-moq-transport-21 §9.2:
 * GOAWAY 受信時点で旧ストリーム上の未応答 REQUEST_UPDATE は失敗として扱い、
 * update() の Promise を reject してエントリを削除することを検証する。
 * GOAWAY 後の読み取り継続中に REQUEST_OK が届いても、エントリ削除済みのため
 * 二重解決しない (Forward State の誤反映も起きない)。
 */
test("bidiReadRequestStreamMessages: GOAWAY 受信時に応答待ちの REQUEST_UPDATE が reject され二重解決しない", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  // 遅延 REQUEST_OK による Forward State の誤反映を検出するため、
  // Forward State を false にしておく (エントリの forward は true)
  subscriber.setForwardState(false);

  // GOAWAY 前に送信済みで応答待ちの REQUEST_UPDATE を注入する
  let rejected: Error | undefined;
  let resolved = false;
  const updateId = 100n;
  ctx.session.pendingRequestUpdate.set(updateId, {
    resolve: () => {
      resolved = true;
    },
    reject: (err: Error) => {
      rejected = err;
    },
    targetRequestId: ctx.requestId,
    forward: true,
  });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  // GOAWAY → 遅延 REQUEST_OK → FIN の順に feed する
  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "moqt://new.example.com",
    timeout: 0n,
  });
  // controlWriter は createPublishReadTestContext で設定済みのため安全
  const goawayMessage = ctx.session.controlWriter!.encode(MessageType.GOAWAY, goawayPayload);
  ctx.readableController.enqueue(goawayMessage);
  const requestOkPayload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [],
  });
  // controlWriter は createPublishReadTestContext で設定済みのため安全
  const requestOkMessage = ctx.session.controlWriter!.encode(
    MessageType.REQUEST_OK,
    requestOkPayload,
  );
  ctx.readableController.enqueue(requestOkMessage);
  ctx.readableController.close();
  await readPromise;

  // GOAWAY 受信時点で未応答 REQUEST_UPDATE が reject され、エントリが削除される
  assert.isDefined(rejected);
  assert.instanceOf(rejected, RequestError);
  assert.equal((rejected as RequestError).code, RequestErrorCode.GOING_AWAY);
  assert.equal(ctx.session.pendingRequestUpdate.size, 0);
  // GOAWAY 後の REQUEST_OK はエントリ削除済みのため二重解決しない
  assert.isFalse(resolved);
  // 遅延 REQUEST_OK による Forward State の誤反映も起きない (false のまま)
  assert.isFalse(subscriber.forwardState);
  // 遅延 REQUEST_OK は「2 通目の応答」ではないため PROTOCOL_VIOLATION で閉じない
  // (GOAWAY 受信済みの request stream では違反判定を行わない)
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.5.1 (Updating Subscriptions):
 * "If the coalesced REQUEST_UPDATE results in REQUEST_ERROR, only a single
 *  REQUEST_ERROR will be sent and the sender of the REQUEST_UPDATEs will not
 *  always be able to determine which caused an error."
 * coalescing は失敗した更新を 1 通にまとめるだけであり、同時に in-flight だった
 * 成功分の更新には §9.5 の MUST により REQUEST_OK が別途届く。
 * REQUEST_ERROR で pending を消した後に届く REQUEST_OK を 2 通目の応答として
 * セッションを閉じないことを検証する。
 */
test("bidiReadRequestStreamMessages: coalescing された REQUEST_ERROR 後の遅延 REQUEST_OK では閉じない", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  // in-flight の REQUEST_UPDATE を 1 件注入する
  let rejected: Error | undefined;
  ctx.session.pendingRequestUpdate.set(100n, {
    resolve: () => {},
    reject: (err: Error) => {
      rejected = err;
    },
    targetRequestId: ctx.requestId,
  });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  // coalescing された REQUEST_ERROR → 成功分の遅延 REQUEST_OK → FIN の順に feed する
  const requestErrorPayload = encodeRequestErrorPayload({
    type: MessageType.REQUEST_ERROR,
    errorCode: 0x3n,
    retryInterval: 0n,
    reasonPhrase: "update failed",
  });
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.REQUEST_ERROR, requestErrorPayload),
  );
  const requestOkPayload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [],
  });
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.REQUEST_OK, requestOkPayload),
  );
  ctx.readableController.close();
  await readPromise;

  // pending は REQUEST_ERROR で 1 件だけ reject され、遅延 REQUEST_OK は違反ではない
  assert.isDefined(rejected);
  assert.equal(ctx.session.pendingRequestUpdate.size, 0);
  assert.isUndefined(ctx.closedWithError);
  assert.equal(ctx.closedWithErrorCount, 0);
});

/**
 * 上の続き: coalescing で消えた 1 件分の許容枠を使い切った後に、さらに
 * pending の無い REQUEST_OK を受信した場合は 2 通目の応答であり
 * PROTOCOL_VIOLATION でセッションを閉じる。
 */
test("bidiReadRequestStreamMessages: coalescing 後の許容枠を超えた REQUEST_OK で閉じる", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  ctx.session.pendingRequestUpdate.set(100n, {
    resolve: () => {},
    reject: () => {},
    targetRequestId: ctx.requestId,
  });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  const requestErrorPayload = encodeRequestErrorPayload({
    type: MessageType.REQUEST_ERROR,
    errorCode: 0x3n,
    retryInterval: 0n,
    reasonPhrase: "update failed",
  });
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.REQUEST_ERROR, requestErrorPayload),
  );
  const requestOkPayload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [],
  });
  // 1 通目は許容枠 (REQUEST_ERROR で消した 1 件分) を消費し、2 通目で閉じる
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.REQUEST_OK, requestOkPayload),
  );
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.REQUEST_OK, requestOkPayload),
  );
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.equal(ctx.closedWithErrorCount, 1);
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.2:
 * 正常な PUBLISH_DONE → FIN の経路では end コールバックのみが呼ばれ、
 * error コールバックは呼ばれないことを検証する (正常経路の温存ガード)。
 */
test("bidiReadRequestStreamMessages: PUBLISH_DONE 後の FIN (subscribe ロール) では end のみが呼ばれる", async () => {
  const ctx = createPublishReadTestContext({});
  let errorCalled = false;
  let endCalled = false;
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    ctx.requestId,
    1n,
    () => {},
    undefined,
    () => {
      endCalled = true;
    },
    () => {
      errorCalled = true;
    },
  );
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  // PUBLISH_DONE (TRACK_ENDED) を feed してから FIN
  const publishDonePayload = encodePublishDonePayload({
    type: MessageType.PUBLISH_DONE,
    statusCode: 0x2n,
    streamCount: 0n,
    reasonPhrase: "",
  });
  const message = ctx.session.controlWriter!.encode(MessageType.PUBLISH_DONE, publishDonePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // end のみが呼ばれ、error は呼ばれない
  assert.isTrue(endCalled);
  assert.isFalse(errorCalled);
  assert.equal(subscriber.state, "closed");
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.2 / §9.9:
 * エラー statusCode の PUBLISH_DONE 後に FIN した場合、error 通知は
 * PUBLISH_DONE 由来の 1 回のみであり、FIN 検出で追加の error 通知が
 * 発生しないことを検証する (spurious 二重通知の回帰ガード)。
 */
test("bidiReadRequestStreamMessages: エラー statusCode の PUBLISH_DONE 後の FIN では error 通知が 1 回のみ", async () => {
  const ctx = createPublishReadTestContext({});
  const errorMessages: string[] = [];
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    ctx.requestId,
    1n,
    () => {},
    undefined,
    () => {},
    (e) => {
      errorMessages.push(e.message);
    },
  );
  ctx.session.subscribers.set(ctx.requestId, subscriber);
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  // エラー statusCode (INTERNAL_ERROR) の PUBLISH_DONE を feed してから FIN
  const publishDonePayload = encodePublishDonePayload({
    type: MessageType.PUBLISH_DONE,
    statusCode: 0x0n,
    streamCount: 0n,
    reasonPhrase: "",
  });
  const message = ctx.session.controlWriter!.encode(MessageType.PUBLISH_DONE, publishDonePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // PUBLISH_DONE 由来の error 通知 1 回のみ (FIN で追加通知されない。
  // handleEnd はエラー statusCode でも endCallback を呼ぶ既存仕様のため
  // end の呼び出し有無は検証しない)
  assert.equal(errorMessages.length, 1);
  assert.isTrue(errorMessages[0].includes("PUBLISH_DONE"));
  assert.equal(subscriber.state, "closed");
  // エラー statusCode の PUBLISH_DONE → FIN でも自方向の FIN (writer.close())
  // が送信される
  assert.deepEqual(ctx.events, ["close"]);
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.2:
 * subscribers に未登録の requestId で FIN した場合、通知は発生せず
 * セッションも閉じないことを検証する (統合レベル。free function 単体の
 * no-op ガードと対になる)。
 */
test("bidiReadRequestStreamMessages: subscribers 未登録の requestId の FIN では通知されない", async () => {
  const ctx = createPublishReadTestContext({});
  // subscribers には登録しない (finally の requestStreams 削除は実行されるが、
  // 通知対象の subscriber が存在しないため通知は発生しない)

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  ctx.readableController.close();
  await readPromise;

  // 通知もセッションクローズも発生しない
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.2:
 * error コールバックが throw しても、セッションは閉じず state が closed に
 * なることを統合レベルで検証する (free function 単体の throw 伝播検証と
 * 対になる。本番経路の catch は throw を黙殺し、markClosed は finally で
 * 保証される)。
 */
test("bidiReadRequestStreamMessages: error コールバックが throw してもセッションが閉じず state が closed になる", async () => {
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
  ctx.session.subscribersByAlias.set(1n, [subscriber]);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  ctx.readableController.close();
  await readPromise;

  // throw はループ catch で黙殺され、セッションは閉じない。state は closed
  assert.isUndefined(ctx.closedWithError);
  assert.equal(subscriber.state, "closed");
  // error コールバックが throw しても、try/finally により自方向の FIN
  // (writer.close()) が送信される
  assert.deepEqual(ctx.events, ["close"]);
});
