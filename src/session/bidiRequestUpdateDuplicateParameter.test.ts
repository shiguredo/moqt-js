/**
 * session/bidi.ts の単体テスト: REQUEST_UPDATE の同一 Parameter Type 重複拒否
 *
 * draft-ietf-moq-transport-22 §9.20 (Control Message Parameters):
 * "Senders MUST NOT repeat the same Parameter Type in a message unless the
 *  parameter definition explicitly allows multiple instances of that type to be
 *  sent in a single message."
 * 送信側が重複を生成するとピアが PROTOCOL_VIOLATION でセッションを閉じるため、
 * 送信前にローカルで拒否することを検証する。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import { MessageParameterType } from "../message/types";
import { encodeUint8ParameterValue } from "../message";
import { bidiSendRequestUpdate } from "./bidi";
import { createPublishReadTestContext } from "../testSupport/bidi";

/**
 * raw パラメータと型付きオプションの合算で FORWARD (0x10) が 2 件になる update は、
 * 送信前に拒否され pendingRequestUpdate / fillFetchTargets にエントリを残さない。
 */
test("bidiSendRequestUpdate: raw と型付きの同一 Type 重複は送信前に拒否される", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  subscriber.onUpdate = (options) => bidiSendRequestUpdate(ctx.session, subscriber, options);

  let rejected: unknown;
  try {
    await subscriber.update({
      // raw の FORWARD
      parameters: [
        {
          type: MessageParameterType.FORWARD,
          value: encodeUint8ParameterValue(1, "FORWARD"),
        },
      ],
      // 型付きオプションの FORWARD (合算で 0x10 が 2 件になる)
      forward: true,
    });
  } catch (error) {
    rejected = error;
  }

  assert.instanceOf(rejected, Error);
  assert.isTrue((rejected as Error).message.includes("duplicate message parameter type: 0x10"));
  // 送信バイトが 0 で、送信状態のエントリも残らない
  assert.equal(ctx.written.length, 0);
  assert.equal(ctx.session.pendingRequestUpdate.size, 0);
  assert.equal(ctx.session.fillFetchTargets.size, 0);
});

// 重複が無い REQUEST_UPDATE が送信され pendingRequestUpdate に 1 件登録される正常系は、
// bidiSendRequestUpdateNewGroupRequest.test.ts の「NEW_GROUP_REQUEST を含まない更新は
// DYNAMIC_GROUPS 無しでも送信できる」が同じ入力 (update({ forward: false })) と
// 同じアサーション (written > 0 / pending 1 件) で検証しているため、ここには置かない。
// なお AUTHORIZATION_TOKEN の反復許可を確認するテストは現状存在せず、
// 本ファイルの否定テストも FORWARD の重複拒否のみを検証している。
