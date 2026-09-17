/**
 * session/bidi.ts の単体テスト: fetch ロールの bidiReadRequestStreamMessages
 *
 * draft-ietf-moq-transport-21 §9.5 / §9.10 / §9.11 / §9.12 / §9.2 / §6.4.2.2:
 * FETCH_OK 受理後も双方向ストリームの読み取りを継続し、逸脱したピアの
 * REQUEST_UPDATE / PUBLISH_STATE_NOTIFY を PROTOCOL_VIOLATION として検出すること、
 * ピア FIN の後始末、2 通目 GOAWAY の検出、GOAWAY の goawayCallback、
 * Fetcher.cancel() による読み取り停止、Fetch Object を運ぶ単方向データストリーム
 * 側の挙動が変わらないことを検証する。
 *
 * 実 W3C ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { decodeFetchOkPayload, encodeFetchOkPayload } from "../message";
import {
  encodeGoawayPayload,
  encodePublishStateNotifyPayload,
  encodeRequestOkPayload,
} from "../message/session";
import { encodeRequestUpdatePayload } from "../message/subscribe";
import { MessageType, MessageParameterType } from "../message/types";
import { SessionErrorCode } from "../error";
import { FetcherImpl } from "../fetcher";
import { concatUint8Arrays } from "../testSupport/helpers";
import { createFetchReadTestContext, waitForMacrotask } from "../testSupport/bidi";
import { bidiCancelFetch, bidiReadFetchResponse } from "./bidi";

// ============================================================================
// fetch ロールの読み取りループ
// draft-ietf-moq-transport-21 §9.5 / §9.10 / §9.11 / §9.12 / §9.2 / §6.4.2.2
// ============================================================================

/**
 * テスト用の controlWriter の面
 *
 * メッセージの組み立てに必要なのは encode だけである。
 */
interface MessageEncoder {
  encode(type: number, payload: Uint8Array): Uint8Array;
}

/**
 * REQUEST_UPDATE メッセージを組み立てる
 *
 * FETCH を対象とする REQUEST_UPDATE の送信経路は本実装に存在しないため
 * (bidiSendRequestUpdate は SubscriberImpl のみ受け付ける)、逸脱したピアが
 * 送ってくるワイヤをテスト側で組み立てる。
 */
function buildRequestUpdateMessage(encoder: MessageEncoder): Uint8Array {
  const payload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [],
  });
  return encoder.encode(MessageType.REQUEST_UPDATE, payload);
}

/**
 * GOAWAY メッセージを組み立てる
 */
function buildGoawayMessage(encoder: MessageEncoder): Uint8Array {
  const payload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "moqt://new.example.com",
    timeout: 0n,
  });
  return encoder.encode(MessageType.GOAWAY, payload);
}

/**
 * PUBLISH_STATE_NOTIFY メッセージを組み立てる
 */
function buildPublishStateNotifyMessage(encoder: MessageEncoder): Uint8Array {
  const payload = encodePublishStateNotifyPayload({
    type: MessageType.PUBLISH_STATE_NOTIFY,
    parameters: [
      { type: MessageParameterType.LARGEST_OBJECT, value: new Uint8Array([0x07, 0x02]) },
    ],
  });
  return encoder.encode(MessageType.PUBLISH_STATE_NOTIFY, payload);
}

/**
 * REQUEST_OK メッセージを組み立てる
 *
 * draft-ietf-moq-transport-21 §9.3 (REQUEST_OK):
 * 確立後の REQUEST_OK (REQUEST_UPDATE_OK) は Track Properties が空必須である。
 */
function buildRequestOkMessage(encoder: MessageEncoder): Uint8Array {
  const payload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [],
  });
  return encoder.encode(MessageType.REQUEST_OK, payload);
}

/**
 * FETCH_OK の読み取りを完了させ、fetchers への登録を確認する
 *
 * bidiReadFetchResponse は FETCH_OK を最初の応答として処理し、直後に読み取り
 * ループを fire-and-forget で起動する。この関数が返った時点で読み取りループは
 * 既に起動しているが、終了しているとは限らない (FIN まで読み続ける)。
 *
 * @param beforeEachRead - FETCH_OK を読ませる前に呼ぶ処理。FETCH_OK と同一
 *   チャンクへ連結するメッセージの push に使う。
 */
async function acceptFetchOk(
  ctx: ReturnType<typeof createFetchReadTestContext>,
  beforeEachRead?: (ctx: ReturnType<typeof createFetchReadTestContext>) => void,
): Promise<void> {
  beforeEachRead?.(ctx);
  ctx.flushInitialChunk();
  await bidiReadFetchResponse(ctx.session, ctx.requestId, ctx.stream, ctx.controlReader);
  assert.isTrue(ctx.session.fetchers.has(ctx.requestId));
}

// ----------------------------------------------------------------------------
// REQUEST_UPDATE (§9.5 MUST)
// ----------------------------------------------------------------------------

/**
 * draft-ietf-moq-transport-21 §9.5 (REQUEST_UPDATE):
 * 「The sender of a request (SUBSCRIBE, PUBLISH, FETCH, ...) can later send a
 *  REQUEST_UPDATE on the same bidi stream as the request to modify it. A
 *  subscriber can also send REQUEST_UPDATE to modify parameters of a
 *  subscription established with PUBLISH.」
 * 「An endpoint that receives a REQUEST_UPDATE other than in the two cases
 *  above MUST close the session with a PROTOCOL_VIOLATION.」
 * FETCH の responder (ピア) からの REQUEST_UPDATE は 2 ケースに該当しない。
 * FETCH_OK 受理後に別チャンクで受信した場合に PROTOCOL_VIOLATION でセッションが
 * 閉じることを検証する。
 */
test("bidiReadFetchResponse: FETCH 応答ストリーム上の REQUEST_UPDATE で PROTOCOL_VIOLATION になる", async () => {
  const ctx = createFetchReadTestContext();
  await acceptFetchOk(ctx);

  // FETCH_OK とは別チャンクで REQUEST_UPDATE を届ける
  ctx.readableController.enqueue(buildRequestUpdateMessage(ctx.controlWriter));
  ctx.readableController.close();
  await waitForMacrotask();

  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(
    ctx.getClosedWithError()!.message.includes("unexpected REQUEST_UPDATE on fetch stream"),
  );
  // §9.5 の応答 (REQUEST_OK / REQUEST_ERROR) も §9.5.1 の PUBLISH_DONE も送らない
  assert.equal(ctx.written.length, 0);
  // セッション終了のため requestStreams のエントリは削除される
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §9.5:
 * FETCH_OK と同一チャンクに REQUEST_UPDATE が連結されている場合も取りこぼさず
 * 検出することを検証する。bidiDispatchResponse は最初の応答で読んだ 2 通目以降を
 * context.remainingMessages に保持し、ControlStreamReader は取り出したメッセージを
 * バッファから削除する。読み取りループが初期メッセージとして先頭から処理しなければ
 * この REQUEST_UPDATE は失われる。
 */
test("bidiReadFetchResponse: FETCH_OK と同一チャンクの REQUEST_UPDATE でも PROTOCOL_VIOLATION になる", async () => {
  const ctx = createFetchReadTestContext();
  // FETCH_OK と連結する REQUEST_UPDATE を controlWriter で組み立てて push する
  await acceptFetchOk(ctx, (target) => {
    target.additionalMessages.push(buildRequestUpdateMessage(target.controlWriter));
  });

  ctx.readableController.close();
  await waitForMacrotask();

  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(
    ctx.getClosedWithError()!.message.includes("unexpected REQUEST_UPDATE on fetch stream"),
  );
  assert.equal(ctx.written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.5 / §9.2:
 * GOAWAY を受信済みの FETCH 応答ストリームでも REQUEST_UPDATE は
 * PROTOCOL_VIOLATION になることを検証する。fetch ロールの判定は
 * bidiPreflightRequestUpdate の中で GOAWAY 分岐より前に置かれており、subscribe
 * ロールの「GOAWAY 受信済みなら無視する」逸脱には揃えない。
 * 判定を GOAWAY 分岐の後ろに置くと、この条件で REQUEST_UPDATE が無視される。
 */
test("bidiReadFetchResponse: GOAWAY 受信済みでも REQUEST_UPDATE で PROTOCOL_VIOLATION になる", async () => {
  const ctx = createFetchReadTestContext();
  await acceptFetchOk(ctx);
  // 1 通目の GOAWAY を受信済みにする (§9.2 で当該 request stream は移行対象)
  ctx.readableController.enqueue(buildGoawayMessage(ctx.controlWriter));
  await waitForMacrotask();
  assert.isTrue(ctx.session.goawayReceivedOnRequestStreams.has(ctx.requestId));
  assert.equal(ctx.getClosedWithErrorCount(), 0);

  ctx.readableController.enqueue(buildRequestUpdateMessage(ctx.controlWriter));
  ctx.readableController.close();
  await waitForMacrotask();

  assert.equal(ctx.getClosedWithErrorCount(), 1);
  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(
    ctx.getClosedWithError()!.message.includes("unexpected REQUEST_UPDATE on fetch stream"),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.1.7 (MAX_REQUEST_UPDATES) / §9.5:
 * fetch ロールは §9.5 の MUST により PROTOCOL_VIOLATION で即座に閉じるため、
 * 受信 REQUEST_UPDATE を未応答数として数えないことを検証する。
 */
test("bidiReadFetchResponse: FETCH 応答ストリームの REQUEST_UPDATE は未応答数に数えない", async () => {
  const ctx = createFetchReadTestContext();
  await acceptFetchOk(ctx);

  ctx.readableController.enqueue(buildRequestUpdateMessage(ctx.controlWriter));
  ctx.readableController.close();
  await waitForMacrotask();

  assert.isFalse(ctx.session.receivedRequestUpdateCounts.has(ctx.requestId));
});

// ----------------------------------------------------------------------------
// PUBLISH_STATE_NOTIFY (§9.10 MUST)
// ----------------------------------------------------------------------------

/**
 * draft-ietf-moq-transport-21 §9.10 (PUBLISH_STATE_NOTIFY):
 * 「PUBLISH_STATE_NOTIFY applies only to subscriptions, and is sent only by the
 *  publisher. An endpoint that receives a PUBLISH_STATE_NOTIFY for any other
 *  request type, or from the subscriber, MUST close the session with a
 *  PROTOCOL_VIOLATION.」
 * FETCH は subscription ではないため、FETCH 応答ストリーム上の
 * PUBLISH_STATE_NOTIFY でセッションが閉じることを検証する。
 */
test("bidiReadFetchResponse: FETCH 応答ストリーム上の PUBLISH_STATE_NOTIFY で PROTOCOL_VIOLATION になる", async () => {
  const ctx = createFetchReadTestContext();
  await acceptFetchOk(ctx);

  ctx.readableController.enqueue(buildPublishStateNotifyMessage(ctx.controlWriter));
  ctx.readableController.close();
  await waitForMacrotask();

  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  // エラー文言が publish 固定ではなく、実際のロール (fetch) を載せる
  assert.isTrue(
    ctx.getClosedWithError()!.message.includes("unexpected PUBLISH_STATE_NOTIFY on fetch stream"),
  );
  assert.equal(ctx.written.length, 0);
});

// ----------------------------------------------------------------------------
// ピア FIN (§6.4.2.2 SHOULD)
// ----------------------------------------------------------------------------

/**
 * draft-ietf-moq-transport-21 §6.4.2.2 (Graceful Request Stream Closure):
 * 「A FIN sent by the responder after its response and any subsequent messages
 *  for the request signals that the request is complete; if it has not already
 *  done so, the requester SHOULD then send a FIN on its direction, gracefully
 *  closing the stream.」
 * fetch ロールでは publish ロールの削除遅延を適用せず、ピア FIN で自方向を FIN で
 * 閉じて requestStreams からエントリを削除することを検証する。FETCH に
 * PUBLISH_DONE は無く (§9.11)、responder の FIN は正常完了であるため、
 * 購読向けの失敗通知 (notifySubscriberFailure) も呼ばない。
 */
test("bidiReadFetchResponse: ピア FIN で自方向を FIN で閉じて requestStreams から削除する", async () => {
  const ctx = createFetchReadTestContext();
  // 購読向けの失敗通知が呼ばれないことを観測する (fetcher の error コールバック)
  let errorCalled = false;
  ctx.fetcher.handleError = () => {
    errorCalled = true;
  };
  await acceptFetchOk(ctx);
  const streamInfo = ctx.session.requestStreams.get(ctx.requestId);
  assert.isDefined(streamInfo);

  // ピアの graceful FIN を再現する (reader.read() が { done: true } を返す)
  ctx.readableController.close();
  // 自方向が FIN で閉じられる (writer.close() の解決後に finally の後始末が
  // 走るため、reader の解放を待ってから requestStreams を検証する)
  await streamInfo!.writer.closed;
  await waitForMacrotask();

  assert.equal(ctx.getClosedWithErrorCount(), 0);
  // requestStreams のエントリが削除される (fetch ロールは削除遅延の対象外)
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  // 購読向けの失敗通知は呼ばれない
  assert.isFalse(errorCalled);
  // データストリームの登録 (fetchers) は双方向ストリームの FIN では変更しない
  assert.isTrue(ctx.session.fetchers.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.2:
 * 応答以外にメッセージを送らない FETCH (FETCH_OK のみで完結する応答) でも、
 * ピア FIN に対する自方向 FIN の SHOULD は成立する。書き込みを伴わず close だけが
 * 実行されることを検証する。
 */
test("bidiReadFetchResponse: 追加メッセージなしのピア FIN でも自方向 FIN のみ実行される", async () => {
  const ctx = createFetchReadTestContext();
  await acceptFetchOk(ctx);
  const streamInfo = ctx.session.requestStreams.get(ctx.requestId);
  assert.isDefined(streamInfo);

  ctx.readableController.close();
  await streamInfo!.writer.closed;
  await waitForMacrotask();

  // 応答の書き込みは 1 通も発生しない
  assert.equal(ctx.written.length, 0);
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.equal(ctx.getClosedWithErrorCount(), 0);
});

// ----------------------------------------------------------------------------
// GOAWAY (§9.2)
// ----------------------------------------------------------------------------

/**
 * draft-ietf-moq-transport-21 §9.2 (GOAWAY):
 * 「The endpoint MUST close the session with a PROTOCOL_VIOLATION (Section 12.2)
 *  if it receives more than one GOAWAY on the control stream or on a single
 *  request stream.」
 * 確立後の FETCH 応答ストリームでも 2 通目の GOAWAY を検出することを検証する。
 * 1 通目と 2 通目を同一チャンクに連結し、重複判定が 1 通目の登録後に行われる
 * ことも確認する。
 */
test("bidiReadFetchResponse: 2 通目 GOAWAY で PROTOCOL_VIOLATION になる", async () => {
  const ctx = createFetchReadTestContext();
  await acceptFetchOk(ctx);
  const goaway = buildGoawayMessage(ctx.controlWriter);

  ctx.readableController.enqueue(concatUint8Arrays([goaway, goaway]));
  ctx.readableController.close();
  await waitForMacrotask();

  assert.isTrue(ctx.session.goawayReceivedOnRequestStreams.has(ctx.requestId));
  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(
    ctx.getClosedWithError()!.message.includes("received duplicate goaway on request stream"),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.2:
 * 「Upon receiving a GOAWAY on a request stream, the endpoint SHOULD re-issue
 *  that specific request ... and close the old request stream using the
 *  appropriate mechanism (e.g. FIN, stream reset, or PUBLISH_DONE).」
 * 確立後の GOAWAY で Fetcher の goawayCallback が呼ばれ、自方向が FIN で
 * 閉じられることを検証する。読み取りは 2 通目 GOAWAY の検出 (§9.2 MUST) のため
 * 継続し、requestStreams のエントリも残る。
 */
test("bidiReadFetchResponse: 確立後の GOAWAY で goawayCallback が呼ばれ自方向が FIN で閉じる", async () => {
  const ctx = createFetchReadTestContext();
  let goawayUri: string | undefined;
  ctx.fetcher.goawayCallback = (newSessionUri: string) => {
    goawayUri = newSessionUri;
  };
  await acceptFetchOk(ctx);

  ctx.readableController.enqueue(buildGoawayMessage(ctx.controlWriter));
  await waitForMacrotask();

  // goawayCallback が新しいセッション URI 付きで呼ばれる
  assert.equal(goawayUri, "moqt://new.example.com");
  // 自方向が FIN で閉じられる
  const streamInfo = ctx.session.requestStreams.get(ctx.requestId);
  assert.isDefined(streamInfo);
  await streamInfo!.writer.closed;
  // 1 通目 GOAWAY ではセッションを閉じない
  assert.equal(ctx.getClosedWithErrorCount(), 0);
  // 読み取り継続のため requestStreams のエントリは残る
  assert.isTrue(ctx.session.requestStreams.has(ctx.requestId));

  // ピア FIN でエントリが削除される (fetch ロールは削除遅延の対象外)
  ctx.readableController.close();
  await waitForMacrotask();
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  // 2 通目の GOAWAY を受信していないためセッションは閉じない
  assert.equal(ctx.getClosedWithErrorCount(), 0);
});

// ----------------------------------------------------------------------------
// cancel (§3.2.1 MUST)
// ----------------------------------------------------------------------------

/**
 * draft-ietf-moq-transport-21 §3.2.1 (Fetch State Management):
 * 「It MUST send STOP_SENDING for the bidi request stream.」
 * 確立後の FETCH では読み取りループが readable のロックを保持するため、
 * bidiCancelFetch は保持中の reader 経由で cancel する分岐を使う。
 * Fetcher.cancel() が読み取りループを停止できることを検証する。
 */
test("bidiCancelFetch: 確立後の Fetcher.cancel() が読み取りループを停止する", async () => {
  const ctx = createFetchReadTestContext();
  let cancelCalled = false;
  ctx.fetcher.onCancel = async () => {
    cancelCalled = true;
  };
  await acceptFetchOk(ctx);
  // 読み取りループが reader を登録している (この登録が cancel 分岐の前提)
  assert.isDefined(ctx.session.requestStreams.get(ctx.requestId)?.reader);

  // アプリの cancel() は onCancel (実装では SessionImpl.cancelFetch) を呼ぶ
  await ctx.fetcher.cancel();
  assert.isTrue(cancelCalled);
  await bidiCancelFetch(ctx.session, ctx.fetcher);
  await waitForMacrotask();

  // reader 経由の cancel で読み取りループが終了する
  assert.equal(ctx.fetcher.state, "closed");
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isFalse(ctx.session.fetchers.has(ctx.requestId));
  // 購読向けの失敗通知もセッション終了も起きない
  assert.equal(ctx.getClosedWithErrorCount(), 0);
});

/**
 * FetcherImpl.cancel() は onCancel を await する前に state を closed にする。
 * malformed track の重複検出などで cancel が重なっても、後始末が 1 回だけ
 * 実行されることを検証する。
 */
test("bidiCancelFetch: 二重 cancel でも後始末が 1 回だけ実行される", async () => {
  const requestId = 10n;
  let cancelCount = 0;
  const fetcher = new FetcherImpl(["test"], "track", requestId, () => {});
  fetcher.onCancel = async () => {
    cancelCount++;
  };

  await fetcher.cancel();
  await fetcher.cancel();

  assert.equal(cancelCount, 1);
  assert.equal(fetcher.state, "closed");
});

// ----------------------------------------------------------------------------
// 正常系 (Fetch Object は単方向データストリーム側)
// ----------------------------------------------------------------------------

/**
 * draft-ietf-moq-transport-21 §9.11 (FETCH):
 * 「The publisher creates a new unidirectional stream that is used to send the
 *  Objects. The FETCH_OK or REQUEST_ERROR can come at any time relative to
 *  object delivery.」
 * FETCH の正常系は「FETCH_OK は双方向ストリーム、Fetch Object とその終端 FIN は
 * 単方向データストリーム」である。データストリーム側の登録と削除は SessionImpl が
 * 担い、双方向ストリームの読み取りループを起動しても影響しないことを検証する。
 */
test("bidiReadFetchResponse: 正常系で fetchers の登録と削除の挙動が変わらない", async () => {
  const ctx = createFetchReadTestContext();
  await acceptFetchOk(ctx);
  // FETCH_OK 受理で fetchers に登録される (SessionImpl.handleIncomingStream が
  // FETCH_HEADER の Request ID から fetcher を引く)
  assert.equal(ctx.session.fetchers.get(ctx.requestId), ctx.fetcher);

  // データストリームの終端 FIN は SessionImpl.handleEnd が処理する。ここでは同じ
  // 後始末 (handleEnd + fetchers からの削除) を直接呼び、双方向ストリーム側の
  // 操作が fetchers を変えないことを確かめる。
  ctx.fetcher.handleEnd();
  ctx.session.fetchers.delete(ctx.requestId);
  assert.isFalse(ctx.session.fetchers.has(ctx.requestId));
  assert.equal(ctx.fetcher.state, "closed");

  // 双方向ストリームの FIN は fetchers の削除状態を変えない
  ctx.readableController.close();
  await waitForMacrotask();
  assert.isFalse(ctx.session.fetchers.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.equal(ctx.getClosedWithErrorCount(), 0);
});

/**
 * draft-ietf-moq-transport-21 §9.12 (FETCH_OK):
 * End of Track / End Location / Track Properties が Fetcher へ反映されることを
 * 検証する。読み取りループを起動しても FETCH_OK の解釈は変わらない。
 */
test("bidiReadFetchResponse: FETCH_OK の内容が Fetcher に反映される", async () => {
  const ctx = createFetchReadTestContext();
  await acceptFetchOk(ctx);

  assert.isTrue(ctx.fetcher.endOfTrack);
  assert.deepEqual(ctx.fetcher.endLocation, { group: 0n, object: 0n });
  assert.deepEqual(ctx.fetcher.trackProperties, []);
  assert.isUndefined(ctx.getClosedWithError());
  // テスト側の期待値がテストヘルパーの組み立てと一致していることを確認する
  assert.deepEqual(
    decodeFetchOkPayload(
      encodeFetchOkPayload({
        type: MessageType.FETCH_OK,
        endOfTrack: true,
        endLocation: { group: 0n, object: 0n },
        parameters: [],
        trackProperties: [],
      }),
    ).endLocation,
    ctx.fetcher.endLocation,
  );
});

// ----------------------------------------------------------------------------
// その他のメッセージ型
// ----------------------------------------------------------------------------

/**
 * draft-ietf-moq-transport-21 §9.5 (REQUEST_UPDATE) / §3.1:
 * 確立後の REQUEST_OK は REQUEST_UPDATE_OK であり、自 endpoint が送った
 * REQUEST_UPDATE に 1 対 1 で対応する。moqt-js は FETCH の REQUEST_UPDATE を
 * 送らないため、FETCH 応答ストリーム上の REQUEST_OK は対応する更新を持たない。
 * fetch ロールは既存の switch の扱いをそのまま通し (本 issue のスコープでは
 * 状態を変えない)、対応する保留中の更新が無い REQUEST_OK は
 * bidiHandleRequestUpdateOk の既存判定で PROTOCOL_VIOLATION になることを
 * 検証する (publish ロールの REQUEST_UPDATE 応答経路には落ちない)。
 */
test("bidiReadFetchResponse: FETCH 応答ストリーム上の REQUEST_OK は保留中の更新が無く PROTOCOL_VIOLATION になる", async () => {
  const ctx = createFetchReadTestContext();
  await acceptFetchOk(ctx);

  ctx.readableController.enqueue(buildRequestOkMessage(ctx.controlWriter));
  ctx.readableController.close();
  await waitForMacrotask();

  assert.equal(ctx.getClosedWithErrorCount(), 1);
  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(ctx.getClosedWithError()!.message.includes("no outstanding REQUEST_UPDATE"));
  // REQUEST_UPDATE への応答も PUBLISH_DONE も送らない
  assert.equal(ctx.written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.11 (FETCH):
 * FETCH に PUBLISH_DONE は定義されていない。既存の switch の扱いどおり
 * デコードだけを行い、subscribers にエントリが無いため状態を変えずに読み取りを
 * 継続することを検証する。
 */
test("bidiReadFetchResponse: FETCH 応答ストリーム上の PUBLISH_DONE では状態を変えない", async () => {
  const ctx = createFetchReadTestContext();
  await acceptFetchOk(ctx);
  // PUBLISH_DONE (TRACK_ENDED / Stream Count 0 / 空の reasonPhrase) を届ける
  const publishDonePayload = new Uint8Array([0x02, 0x00, 0x00]);
  ctx.readableController.enqueue(
    ctx.controlWriter.encode(MessageType.PUBLISH_DONE, publishDonePayload),
  );
  await waitForMacrotask();

  assert.equal(ctx.getClosedWithErrorCount(), 0);
  assert.isTrue(ctx.session.requestStreams.has(ctx.requestId));
  assert.equal(ctx.fetcher.state, "active");
});

/**
 * 未知のメッセージ型を受信した場合は PROTOCOL_VIOLATION でセッションを閉じる
 * (既存の default 分岐)。fetch ロールでも扱いが変わらないことを検証する。
 */
test("bidiReadFetchResponse: FETCH 応答ストリーム上の未知メッセージ型で PROTOCOL_VIOLATION になる", async () => {
  const ctx = createFetchReadTestContext();
  await acceptFetchOk(ctx);

  // 制御メッセージとして扱わない型 (0x7f) を届ける
  ctx.readableController.enqueue(ctx.controlWriter.encode(0x7f, new Uint8Array()));
  ctx.readableController.close();
  await waitForMacrotask();

  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(
    ctx.getClosedWithError()!.message.includes("unknown request stream message type: 0x7f"),
  );
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.3 / §12.5:
 * ピアの RESET_STREAM による読み取り失敗は handleRequestStreamReadError を通す。
 * fetch ロールは「publish 以外」の分岐に落ちるが、購読も保留中の更新も無いため
 * 通知は発生せず、セッションも閉じないことを検証する。
 */
test("bidiReadFetchResponse: ピアの RESET_STREAM ではセッションを閉じず通知もしない", async () => {
  const ctx = createFetchReadTestContext();
  let errorCalled = false;
  ctx.fetcher.handleError = () => {
    errorCalled = true;
  };
  await acceptFetchOk(ctx);

  // ピアの RESET_STREAM を再現する (WebTransportError 相当の reason で reject)
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), { source: "stream" }),
  );
  await waitForMacrotask();

  assert.equal(ctx.getClosedWithErrorCount(), 0);
  assert.isFalse(errorCalled);
  // RESET_STREAM は FIN ではないため requestStreams から削除される
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
});
