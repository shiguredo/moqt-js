/**
 * session/bidi.ts の単体テスト: publish ロールで受信した REQUEST_UPDATE の NEW_GROUP_REQUEST
 *
 * draft-ietf-moq-transport-21 §9.20.20 (NEW GROUP REQUEST Parameter):
 * relay は下流の NEW_GROUP_REQUEST を REQUEST_UPDATE で publisher へ伝える。dynamic Groups に
 * 対応する publisher は、値が 0 か現在の Group より大きければ新しい Group を始める SHOULD。
 * moqt-js はアプリへ PublishCallbacks.onNewGroupRequest で知らせる。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { MessageType, MessageParameterType } from "../message/types";
import { encodeRequestUpdatePayload } from "../message/subscribe";
import { createPublishReadTestContext } from "../testSupport/bidi";
import { concatUint8Arrays } from "../testSupport/helpers";
import { encodeVarint } from "../varint";
import { ControlStreamReader } from "../controlStream";
import { bidiReadRequestStreamMessages } from "./bidi";

/**
 * NEW_GROUP_REQUEST を載せた REQUEST_UPDATE を 1 通受け取り、応答と callback の呼び出しを返す
 */
async function receiveNewGroupRequest(
  dynamicGroups: boolean,
  value: Uint8Array,
): Promise<{ responses: number[]; requests: bigint[]; closedCode: number | undefined }> {
  const ctx = createPublishReadTestContext({});
  const requests: bigint[] = [];
  ctx.publisher.dynamicGroups = dynamicGroups;
  ctx.publisher.newGroupRequestCallback = (newGroupRequest) => {
    requests.push(newGroupRequest);
  };
  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: ctx.requestId,
    parameters: [{ type: MessageParameterType.NEW_GROUP_REQUEST, value }],
  });
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload),
  );
  ctx.readableController.close();
  await readPromise;
  const responses = new ControlStreamReader()
    .feed(concatUint8Arrays(ctx.written))
    .map((message) => message.type);
  return { responses, requests, closedCode: ctx.closedWithError?.code };
}

// DYNAMIC_GROUPS を広告した publisher は、NEW_GROUP_REQUEST を受理して REQUEST_OK を返し、
// アプリへ値を知らせる
test("bidiReadRequestStreamMessages: DYNAMIC_GROUPS を広告した publisher は NEW_GROUP_REQUEST をアプリへ知らせる (publish ロール)", async () => {
  const result = await receiveNewGroupRequest(true, encodeVarint(0n));
  assert.deepEqual(result.responses, [MessageType.REQUEST_OK]);
  assert.deepEqual(result.requests, [0n]);
  assert.isUndefined(result.closedCode);
});

// 広告していない publisher は NEW_GROUP_REQUEST を無視する (§9.20.20 "If the original
// publisher does not support dynamic Groups, it ignores the parameter")。更新は受理する
test("bidiReadRequestStreamMessages: DYNAMIC_GROUPS を広告していない publisher は NEW_GROUP_REQUEST を知らせない (publish ロール)", async () => {
  const result = await receiveNewGroupRequest(false, encodeVarint(7n));
  assert.deepEqual(result.responses, [MessageType.REQUEST_OK]);
  assert.deepEqual(result.requests, []);
  assert.isUndefined(result.closedCode);
});
