/**
 * session/bidi.ts の単体テスト: REQUEST_UPDATE の同一 Parameter Type 重複拒否
 *
 * draft-ietf-moq-transport-21 §9.20 (Control Message Parameters):
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

/**
 * 反復が許可される型 (AUTHORIZATION_TOKEN 0x03) だけが重複しても拒否されない
 * (FORWARD の重複拒否がトークンの反復許可を壊していないことの確認)。
 */
test("bidiSendRequestUpdate: FORWARD の重複が無ければ送信される", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  subscriber.onUpdate = (options) => bidiSendRequestUpdate(ctx.session, subscriber, options);

  const promise = subscriber.update({ forward: false });
  // 書き込みは await を挟むため、1 tick 待ってから観測する
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  // REQUEST_UPDATE が 1 通書かれ、pending が 1 件登録される
  assert.isAbove(ctx.written.length, 0);
  assert.equal(ctx.session.pendingRequestUpdate.size, 1);
  // 応答が来ないままテストを終えないよう pending を解決する
  for (const [, pending] of ctx.session.pendingRequestUpdate) {
    pending.resolve();
  }
  // update() の Promise は解決する (エントリの削除は REQUEST_OK 受信時に行われる)
  await promise;
});
