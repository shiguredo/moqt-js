/**
 * session/bidi.ts の単体テスト: REQUEST_UPDATE の同一 Parameter Type 重複拒否
 *
 * draft-ietf-moq-transport-23 §9.19 (Control Message Parameters):
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
import { ControlStreamReader } from "../controlStream";
import { concatUint8Arrays } from "../testSupport/helpers";
import { decodeRequestUpdatePayload } from "../message/subscribe";
import { createPublishReadTestContext, waitForMacrotask } from "../testSupport/bidi";

/**
 * raw パラメータと型付きオプションの合算で PAUSED (0x11) が 2 件になる update は、
 * 送信前に拒否され pendingRequestUpdate / fillFetchTargets にエントリを残さない。
 */
test("bidiSendRequestUpdate: raw と型付きの同一 Type 重複は送信前に拒否される", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  subscriber.onUpdate = (options) => bidiSendRequestUpdate(ctx.session, subscriber, options);

  let rejected: unknown;
  try {
    await subscriber.update({
      // raw の PAUSED
      parameters: [
        {
          type: MessageParameterType.PAUSED,
          value: encodeUint8ParameterValue(0, "PAUSED"),
        },
      ],
      // 型付きオプションの PAUSED (合算で 0x11 が 2 件になる)
      paused: false,
    });
  } catch (error) {
    rejected = error;
  }

  assert.instanceOf(rejected, Error);
  assert.isTrue((rejected as Error).message.includes("duplicate message parameter type: 0x11"));
  // 送信バイトが 0 で、送信状態のエントリも残らない
  assert.equal(ctx.written.length, 0);
  assert.equal(ctx.session.pendingRequestUpdate.size, 0);
  assert.equal(ctx.session.fillFetchTargets.size, 0);
});

// 重複が無い REQUEST_UPDATE が送信され pendingRequestUpdate に 1 件登録される正常系は、
// bidiSendRequestUpdateNewGroupRequest.test.ts の「NEW_GROUP_REQUEST を含まない更新は
// DYNAMIC_GROUPS 無しでも送信できる」が同じ入力 (update({ paused: true })) と
// 同じアサーション (written > 0 / pending 1 件) で検証しているため、ここには置かない。
// なお AUTHORIZATION_TOKEN の反復許可を確認するテストは現状存在せず、
// 本ファイルの否定テストも PAUSED の重複拒否のみを検証している。

/**
 * draft-ietf-moq-transport-23 §9.19.18:
 * raw parameters で PAUSED を指定した場合も、REQUEST_OK 後に
 * Subscriber.paused へ反映できるよう pending に同じ値が保持される。
 */
test("bidiSendRequestUpdate: raw PAUSED が pending の paused に反映される", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});

  // REQUEST_OK 待ちの promise は pending の reject で解放する
  const sendPromise = bidiSendRequestUpdate(ctx.session, subscriber, {
    parameters: [
      { type: MessageParameterType.PAUSED, value: encodeUint8ParameterValue(1, "PAUSED") },
    ],
  });

  // 送信された REQUEST_UPDATE の pending に paused=true が保持される
  assert.equal(ctx.session.pendingRequestUpdate.size, 1);
  const pending = [...ctx.session.pendingRequestUpdate.values()][0];
  assert.isTrue(pending?.paused);
  pending?.reject(new Error("test cleanup"));
  await sendPromise.catch(() => {});
});

/**
 * draft-ietf-moq-transport-23 §9.19.18:
 * raw parameters の PAUSED が 0/1 以外なら、送信前にローカル API 誤用として拒否し、
 * 送信バイトと pending を残さない。
 */
test("bidiSendRequestUpdate: raw PAUSED の値域外は送信前に拒否される", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});

  let rejected: unknown;
  try {
    await bidiSendRequestUpdate(ctx.session, subscriber, {
      parameters: [
        { type: MessageParameterType.PAUSED, value: encodeUint8ParameterValue(2, "PAUSED") },
      ],
    });
  } catch (error) {
    rejected = error;
  }

  assert.instanceOf(rejected, Error);
  assert.match((rejected as Error).message, /invalid raw PAUSED in REQUEST_UPDATE/);
  assert.equal(ctx.written.length, 0);
  assert.equal(ctx.session.pendingRequestUpdate.size, 0);
});

/**
 * draft-ietf-moq-transport-23 §9.19:
 * raw parameters に PAUSED を 2 件載せた場合も、同一 Type の重複として
 * 送信前に拒否し、送信バイトと pending を残さない。
 */
test("bidiSendRequestUpdate: raw PAUSED が 2 件なら送信前に拒否される", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});

  let rejected: unknown;
  try {
    await bidiSendRequestUpdate(ctx.session, subscriber, {
      parameters: [
        { type: MessageParameterType.PAUSED, value: encodeUint8ParameterValue(0, "PAUSED") },
        { type: MessageParameterType.PAUSED, value: encodeUint8ParameterValue(1, "PAUSED") },
      ],
    });
  } catch (error) {
    rejected = error;
  }

  assert.instanceOf(rejected, Error);
  assert.match((rejected as Error).message, /duplicate message parameter type: 0x11/);
  assert.equal(ctx.written.length, 0);
  assert.equal(ctx.session.pendingRequestUpdate.size, 0);
});

/**
 * draft-ietf-moq-transport-23 §9.19.18:
 * 型付き `update({ paused })` が PAUSED を 1 (paused) / 0 (unpaused) として送り、
 * pending の paused にも同じ値が入ることを 2 方向で検証する。
 */
test("bidiSendRequestUpdate: 型付き paused のワイヤ値と pending が一致する", async () => {
  for (const paused of [true, false]) {
    const ctx = createPublishReadTestContext({});
    const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});

    const sendPromise = bidiSendRequestUpdate(ctx.session, subscriber, { paused });
    // WritableStream の write が実行されるまで待つ
    await waitForMacrotask();

    // 送信された REQUEST_UPDATE の PAUSED をデコードして確認する
    const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
    assert.equal(messages.length, 1, `paused=${paused}`);
    const decoded = decodeRequestUpdatePayload(messages[0]!.payload);
    const pausedParam = decoded.parameters.find(
      (param) => param.type === MessageParameterType.PAUSED,
    );
    assert.isDefined(pausedParam, `paused=${paused}`);
    assert.deepEqual(pausedParam!.value, new Uint8Array([paused ? 1 : 0]), `paused=${paused}`);
    // pending の paused も同じ値で、REQUEST_OK 後に Subscriber.paused へ反映される
    const pending = [...ctx.session.pendingRequestUpdate.values()][0];
    assert.equal(pending?.paused, paused, `paused=${paused}`);

    pending?.reject(new Error("test cleanup"));
    await sendPromise.catch(() => {});
  }
});

/**
 * draft-ietf-moq-transport-23 §9.19.18:
 * paused を省略した REQUEST_UPDATE には PAUSED が載らず、pending の paused も
 * undefined (REQUEST_OK 受信時に状態を変えない) になる。
 */
test("bidiSendRequestUpdate: paused 省略時は PAUSED を送らず状態を変えない", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});

  const sendPromise = bidiSendRequestUpdate(ctx.session, subscriber, {});
  // WritableStream の write が実行されるまで待つ
  await waitForMacrotask();

  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  const decoded = decodeRequestUpdatePayload(messages[0]!.payload);
  assert.isUndefined(
    decoded.parameters.find((param) => param.type === MessageParameterType.PAUSED),
  );
  const pending = [...ctx.session.pendingRequestUpdate.values()][0];
  assert.isUndefined(pending?.paused);

  pending?.reject(new Error("test cleanup"));
  await sendPromise.catch(() => {});
});

/**
 * draft-ietf-moq-transport-23 §9.19.18:
 * PAUSED は uint8 のため、raw Value が 1 バイトでない場合は送信前に拒否する。
 */
test("bidiSendRequestUpdate: raw PAUSED の Value が 1 バイトでない場合は拒否される", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});

  let rejected: unknown;
  try {
    await bidiSendRequestUpdate(ctx.session, subscriber, {
      parameters: [{ type: MessageParameterType.PAUSED, value: new Uint8Array([1, 0]) }],
    });
  } catch (error) {
    rejected = error;
  }

  assert.instanceOf(rejected, Error);
  assert.match((rejected as Error).message, /invalid raw PAUSED in REQUEST_UPDATE/);
  assert.equal(ctx.written.length, 0);
  assert.equal(ctx.session.pendingRequestUpdate.size, 0);
});
