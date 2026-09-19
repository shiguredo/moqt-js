/**
 * session/bidi.ts の単体テスト: 応答と同一チャンクに連結されたメッセージの処理
 *
 * draft-ietf-moq-transport-21 §6.4.2 (Request Streams) / §9.3 / §9.5 / §9.10:
 * 制御メッセージは単一の QUIC ストリーム上で Length プレフィックスにより連続して
 * 運ばれるため、最初の応答 (PUBLISH_OK / SUBSCRIBE_OK / FETCH_OK) と後続メッセージが
 * 同一チャンクに同居し得る。ControlStreamReader.feed は取り出したメッセージを
 * バッファから削除するため、応答を読む bidiDispatchResponse が残りを
 * context.remainingMessages に保持し、読み取りループの初期メッセージとして
 * 先頭から処理しなければ、そのチャンクの 2 通目以降は永久に失われる。
 *
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { encodeRequestOkPayload, encodePublishStateNotifyPayload } from "../message/session";
import { encodeSubscribeOkPayload, encodeRequestUpdatePayload } from "../message/subscribe";
import { encodePublishDonePayload } from "../message/publish";
import { MessageType, MessageParameterType } from "../message/types";
import { SubscriberImpl } from "../subscriber";
import { ControlStreamReader } from "../controlStream";
import { concatUint8Arrays } from "../testSupport/helpers";
import { createPublishReadTestContext, waitForMacrotask } from "../testSupport/bidi";
import { bidiReadPublishResponse, bidiReadSubscribeResponse } from "./bidi";

// ============================================================================
// 同一チャンクの連結メッセージ
// draft-ietf-moq-transport-21 §6.4.2 / §9.3 / §9.5 / §9.10
// ============================================================================

/**
 * 最初の応答と連結するメッセージを 1 チャンクとして enqueue する
 *
 * 連結した状態を作るには writer の encode 結果を連結し、1 回の enqueue で
 * 読み取りループへ渡す必要がある。分けて enqueue すると別チャンクになり、
 * 検証したい経路 (context.remainingMessages) を通らない。
 */
function enqueueCoalesced(
  ctx: ReturnType<typeof createPublishReadTestContext>,
  first: Uint8Array,
  additional: Uint8Array[],
): void {
  ctx.readableController.enqueue(concatUint8Arrays([first, ...additional]));
}

/**
 * 空の Track Properties を持つ PUBLISH_OK を組み立てる
 *
 * draft-ietf-moq-transport-21 §9.3 (REQUEST_OK):
 * PUBLISH_OK の Track Properties は空が必須であり、載せると
 * PROTOCOL_VIOLATION になる。
 */
function buildPublishOk(ctx: ReturnType<typeof createPublishReadTestContext>): Uint8Array {
  const payload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [],
  });
  return ctx.session.controlWriter!.encode(MessageType.REQUEST_OK, payload);
}

/**
 * FORWARD パラメータ付きの REQUEST_UPDATE を組み立てる
 *
 * draft-ietf-moq-transport-21 §9.5 / §9.20.19:
 * REQUEST_UPDATE の Request ID は新規に消費される (§6.4.2.1) ため、
 * ストリーム紐付け ID とは別の値を載せる。
 */
function buildRequestUpdate(
  ctx: ReturnType<typeof createPublishReadTestContext>,
  forward: 0 | 1,
): Uint8Array {
  const payload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [{ type: MessageParameterType.FORWARD, value: new Uint8Array([forward]) }],
  });
  return ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, payload);
}

/**
 * draft-ietf-moq-transport-21 §9.3 / §9.5 / §9.20.19:
 * 送信 PUBLISH の PUBLISH_OK と同一チャンクに REQUEST_UPDATE が連結されている
 * 場合も取りこぼさず処理することを検証する。
 *
 * publisher (自 endpoint) はピア subscriber からの REQUEST_UPDATE に対して
 * REQUEST_OK を 1 通返し (MUST)、FORWARD パラメータの値を自 endpoint の
 * Forward State へ反映しなければならない (§9.20.19「Forward State is a
 *  boolean indicating whether the publisher is permitted to send Objects」)。
 * 連結分を処理しないと publisher は Forward State 0 のままとなり、REQUEST_OK も
 * 返らないため、購読は Objects を受け取れない。
 *
 * sora-moq リレーは購読者が居ない間 Forward State 0 を要求し、購読者が現れると
 * REQUEST_UPDATE (FORWARD=1) を PUBLISH_OK の直後に送る。この経路が壊れると
 * 配信が開始されない。
 */
test("bidiReadPublishResponse: PUBLISH_OK と同一チャンクの REQUEST_UPDATE も処理される", async () => {
  const ctx = createPublishReadTestContext({});
  // 受信 PUBLISH を受理する前は Forward State 0 (ピアが購読者不在で要求) にする
  ctx.publisher.setForwardState(false);

  let resolved = false;
  ctx.session.pendingPublish.set(ctx.requestId, {
    resolve: () => {
      resolved = true;
    },
    reject: () => {},
    impl: ctx.publisher,
  });

  const readPromise = bidiReadPublishResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  enqueueCoalesced(ctx, buildPublishOk(ctx), [buildRequestUpdate(ctx, 1)]);
  await readPromise;
  // REQUEST_UPDATE の処理は応答の書き込みを await するため、読み取りループの
  // 初期メッセージ処理が終わるまで待つ。ここを待たずに検証すると、連結分が
  // 失われていても同じ結果になり、回帰テストとして機能しない。
  await waitForMacrotask();
  ctx.readableController.close();
  await waitForMacrotask();

  // PUBLISH_OK が最初の応答として処理される
  assert.isTrue(resolved);
  assert.isTrue(ctx.session.publishers.has(ctx.requestId));
  // 連結された REQUEST_UPDATE が処理され、Forward State が 1 に変わる
  assert.isTrue(ctx.publisher.forwardState);
  // §9.5 の MUST により REQUEST_OK がちょうど 1 通応答される
  const written = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(written.length, 1);
  assert.equal(written[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.3 / §9.20.19:
 * 連結された REQUEST_UPDATE で Forward State 0 が要求された場合も反映される
 * ことを検証する。連結分が失われると Forward State は 1 のままになり、
 * 購読者が居ないのに Objects を送り続ける。
 */
test("bidiReadPublishResponse: PUBLISH_OK と同一チャンクの REQUEST_UPDATE (FORWARD=0) も処理される", async () => {
  const ctx = createPublishReadTestContext({});
  ctx.publisher.setForwardState(true);
  ctx.session.pendingPublish.set(ctx.requestId, {
    resolve: () => {},
    reject: () => {},
    impl: ctx.publisher,
  });

  const readPromise = bidiReadPublishResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  enqueueCoalesced(ctx, buildPublishOk(ctx), [buildRequestUpdate(ctx, 0)]);
  await readPromise;
  await waitForMacrotask();
  ctx.readableController.close();
  await waitForMacrotask();

  // draft-ietf-moq-transport-21 §9.20.19:
  // Forward State 0 は「publisher は Objects を送ってはならない」を意味する
  assert.isFalse(ctx.publisher.forwardState);
  const written = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(written.length, 1);
  assert.equal(written[0].type, MessageType.REQUEST_OK);
});

/**
 * draft-ietf-moq-transport-21 §9.3 / §9.10:
 * 送信 SUBSCRIBE の SUBSCRIBE_OK と同一チャンクに PUBLISH_DONE が連結されている
 * 場合も取りこぼさず処理することを検証する。
 *
 * publisher が最初の Object を送らずに購読を終える (Track の終端に達した等) 場合、
 * SUBSCRIBE_OK の直後に PUBLISH_DONE が届く。連結分を処理しないと購読が終了せず、
 * アプリの終了コールバックも呼ばれない。
 */
test("bidiReadSubscribeResponse: SUBSCRIBE_OK と同一チャンクの PUBLISH_DONE も処理される", async () => {
  const ctx = createPublishReadTestContext({});
  let ended = 0;
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    ctx.requestId,
    1n,
    () => {},
    undefined,
    () => {
      ended++;
    },
  );
  ctx.session.pendingSubscribe.set(ctx.requestId, {
    resolve: () => {},
    reject: () => {},
    impl: subscriber,
    objectCallback: () => {},
  });

  const readPromise = bidiReadSubscribeResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  const okPayload = encodeSubscribeOkPayload({
    type: MessageType.SUBSCRIBE_OK,
    trackAlias: 1n,
    parameters: [],
    trackProperties: [],
  });
  const donePayload = encodePublishDonePayload({
    type: MessageType.PUBLISH_DONE,
    statusCode: 0n,
    streamCount: 0n,
    reasonPhrase: "end of track",
  });
  enqueueCoalesced(ctx, ctx.session.controlWriter!.encode(MessageType.SUBSCRIBE_OK, okPayload), [
    ctx.session.controlWriter!.encode(MessageType.PUBLISH_DONE, donePayload),
  ]);
  await readPromise;

  // SUBSCRIBE_OK で購読が確立し、連結された PUBLISH_DONE で終了が通知される
  assert.equal(ended, 1);
  assert.equal(subscriber.state, "closed");
  // 正常終了でありセッションは閉じない
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.3 / §9.10:
 * 送信 SUBSCRIBE の SUBSCRIBE_OK と同一チャンクに PUBLISH_STATE_NOTIFY が
 * 連結されている場合も取りこぼさず処理することを検証する。
 *
 * SUBSCRIBE_OK の LARGEST_OBJECT で開始位置を確定した直後に、publisher が
 * 状態変化 (LARGEST_OBJECT の前進) を同一チャンクで通知し得る。連結分を
 * 処理しないと購読状態が古いままになり、既に存在しない位置から待ち続ける。
 */
test("bidiReadSubscribeResponse: SUBSCRIBE_OK と同一チャンクの PUBLISH_STATE_NOTIFY も処理される", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  subscriber.setLocationFilter({ startGroup: 0n, startObject: 0n });
  ctx.session.pendingSubscribe.set(ctx.requestId, {
    resolve: () => {},
    reject: () => {},
    impl: subscriber,
    objectCallback: () => {},
  });

  const readPromise = bidiReadSubscribeResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  const okPayload = encodeSubscribeOkPayload({
    type: MessageType.SUBSCRIBE_OK,
    trackAlias: 1n,
    parameters: [
      { type: MessageParameterType.LARGEST_OBJECT, value: new Uint8Array([0x07, 0x02]) },
    ],
    trackProperties: [],
  });
  const notifyPayload = encodePublishStateNotifyPayload({
    type: MessageType.PUBLISH_STATE_NOTIFY,
    parameters: [
      { type: MessageParameterType.LARGEST_OBJECT, value: new Uint8Array([0x09, 0x04]) },
    ],
  });
  enqueueCoalesced(ctx, ctx.session.controlWriter!.encode(MessageType.SUBSCRIBE_OK, okPayload), [
    ctx.session.controlWriter!.encode(MessageType.PUBLISH_STATE_NOTIFY, notifyPayload),
  ]);
  await readPromise;

  // SUBSCRIBE_OK の LARGEST_OBJECT {7, 2} ではなく、連結された通知の {9, 4} が最終値
  assert.deepEqual(subscriber.largestLocation, { group: 9n, object: 4n });
  // §9.10 の MUST により PUBLISH_STATE_NOTIFY への応答は送らない
  assert.equal(ctx.written.length, 0);
  assert.isUndefined(ctx.closedWithError);
});
