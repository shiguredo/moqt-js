/**
 * session/bidi.ts の単体テスト: publish ロールで受信した REQUEST_UPDATE の NEW_GROUP_REQUEST
 *
 * draft-ietf-moq-transport-22 §9.20.19 (NEW GROUP REQUEST Parameter):
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

/**
 * draft-ietf-moq-transport-22 §9.20.19 (NEW GROUP REQUEST Parameter):
 * "If the original publisher does not support dynamic Groups, it ignores the parameter"
 * DYNAMIC_GROUPS の広告有無で NEW_GROUP_REQUEST の扱いが変わることを表駆動で検証する。
 * どちらの場合も更新自体は受理して REQUEST_OK を 1 通返し、セッションは閉じない。
 * 広告ありのときだけ値をアプリ (onNewGroupRequest) へ知らせる。
 */
test("bidiReadRequestStreamMessages: DYNAMIC_GROUPS の広告有無で NEW_GROUP_REQUEST の通知が変わる (publish ロール)", async () => {
  const cases: {
    name: string;
    dynamicGroups: boolean;
    value: bigint;
    expectedRequests: bigint[];
  }[] = [
    {
      name: "広告ありは値をアプリへ知らせる",
      dynamicGroups: true,
      value: 0n,
      expectedRequests: [0n],
    },
    { name: "広告なしは無視する", dynamicGroups: false, value: 7n, expectedRequests: [] },
  ];

  for (const testCase of cases) {
    const result = await receiveNewGroupRequest(
      testCase.dynamicGroups,
      encodeVarint(testCase.value),
    );
    assert.deepEqual(result.responses, [MessageType.REQUEST_OK]);
    assert.deepEqual(result.requests, testCase.expectedRequests);
    assert.isUndefined(result.closedCode);
  }
});
