/**
 * session/requests.ts の単体テスト: リクエストストリームの受信上限の配線
 *
 * draft-ietf-moq-transport-23 §9.1.8:
 * リクエストストリーム上の制御メッセージも MAX_CONTROL_MESSAGE_SIZE の上限に従う。
 * 送信の async 部 requestsSendRequest が生成する ControlStreamReader にセッションの
 * 受信上限が配線され、その reader で受信ループが応答を読むことを検証する。
 * 既定値 (65535) と異なる上限で生成された reader が超過を検出できることを確認する。
 * 実 SessionImpl と実 W3C ストリーム、実際の受信ループ (bidiReadTrackStatusResponse) で
 * 検証する (モックライブラリは使わない)。
 */

import { test, assert } from "vite-plus/test";
import { ControlStreamWriter } from "../controlStream";
import { SessionError, SessionErrorCode } from "../error";
import { fullTrackNameKey } from "../fullTrackName";
import { MessageType } from "../message/types";
import { bidiFrameRequestMessage, bidiReadTrackStatusResponse } from "./bidi";
import { requestsSendRequest, type RequestsSessionInternal } from "./requests";
import type { TrackStatusResult } from "./publicTypes";
import { SessionImpl } from "../session";
import { createTestWebTransport } from "../testSupport/bidi";

test("requestsSendRequest: リクエストストリームの reader をセッションの受信上限で作る", async () => {
  // ストリームは実 W3C Streams。write されたバイト列は実 WritableStream の sink で
  // 捕捉する (WritableStreamDefaultWriter は production 側が取得する実物)。
  const testTransport = createTestWebTransport();
  const session = new SessionImpl(testTransport.transport, {});
  session.controlWriter = new ControlStreamWriter();
  // 既定値 (65535) と異なる上限にして、生成された reader への配線を区別できるようにする
  session.localMaxControlMessageSize = 4;

  // 応答待ちの TRACK_STATUS を登録する (requestsTrackStatus の同期部と同じ形)。
  // 受信ループはこの pending を引いて応答を待ち、失敗したら reject する
  const requestId = 0n;
  let rejectRequest: (error: Error) => void = () => {};
  const settled = new Promise<TrackStatusResult>((resolve, reject) => {
    rejectRequest = reject;
    session.pendingTrackStatus.set(requestId, {
      resolve,
      reject,
      trackKey: fullTrackNameKey(["live"], "video"),
    });
  }).then(
    () => null,
    (error: unknown) => error,
  );

  // 送信の async 部を実行する。フレーミングは同期部と同じく bidiFrameRequestMessage で行う
  const requestsSession = session as unknown as RequestsSessionInternal;
  const payload = new Uint8Array([0x01]);
  await requestsSendRequest(requestsSession, {
    requestId,
    type: MessageType.TRACK_STATUS,
    payload,
    framed: bidiFrameRequestMessage(requestsSession, MessageType.TRACK_STATUS, payload),
    decoded: {},
    normalizedOptions: undefined,
    reject: rejectRequest,
    pending: session.pendingTrackStatus,
    deletesFillFetchTarget: false,
    priorGapTrackingKey: undefined,
    readResponse: bidiReadTrackStatusResponse,
  });

  // 送信したメッセージは制御メッセージとしてフレーミングされ、1 回だけ書かれている
  const created = testTransport.bidirectionalStreams[0];
  if (created === undefined) {
    assert.fail("双方向ストリームが作成されていない");
  }
  assert.equal(created.written.length, 1);
  // Session が開いたまま送信を終えたため、requestStreams に登録されている
  assert.isTrue(session.requestStreams.has(requestId));

  // Type 0x10 と本文長 5 の宣言だけを流して readable を閉じる。受信ループの reader は
  // セッションの受信上限 4 で作られているため、本文が揃う前の宣言の時点で
  // FIELD_LENGTH_EXCEEDED になり、応答待ちがその SessionError で reject される。
  // 既定値 65535 の reader では宣言で失敗せず、閉じた readable を読んで
  // SessionError ではないエラーで reject するため、配線の誤りを区別できる
  created.readableController.enqueue(new Uint8Array([0x10, 0x05]));
  created.readableController.close();
  const rejected = await settled;
  assert.instanceOf(rejected, SessionError);
  assert.equal((rejected as SessionError).code, SessionErrorCode.FIELD_LENGTH_EXCEEDED);
});
