/**
 * session/bidi.ts の単体テスト: REQUEST_UPDATE の NEW_GROUP_REQUEST と DYNAMIC_GROUPS
 *
 * draft-ietf-moq-transport-21 §9.20.20 (NEW GROUP REQUEST Parameter):
 * "A subscriber MUST NOT send this parameter in REQUEST_UPDATE if the Track did
 *  not include the DYNAMIC_GROUPS Property with value 1.  A subscriber MAY include
 *  this parameter in SUBSCRIBE without foreknowledge of support."
 * REQUEST_UPDATE 経路だけが DYNAMIC_GROUPS を要求されることを検証する。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import { MessageParameterType } from "../message/types";
import { MOQTPropertyId, TrackPropertyId, encodeProperties } from "../properties";
import { bidiSendRequestUpdate } from "./bidi";
import { createPublishReadTestContext } from "../testSupport/bidi";

/** 検証対象のエラーメッセージ (§9.20.20 の MUST NOT 違反) */
const ERROR_MESSAGE =
  "cannot send NEW_GROUP_REQUEST in REQUEST_UPDATE: track did not include DYNAMIC_GROUPS property with value 1";

/** テスト用の購読とセッションを組み立てる */
function createUpdateContext(
  trackProperties: { id: bigint; value?: bigint; data?: Uint8Array }[],
): {
  session: ReturnType<typeof createPublishReadTestContext>["session"];
  subscriber: SubscriberImpl;
  written: Uint8Array[];
} {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  subscriber.onUpdate = (options) => bidiSendRequestUpdate(ctx.session, subscriber, options);
  subscriber.setTrackProperties(trackProperties);
  return { session: ctx.session, subscriber, written: ctx.written };
}

/**
 * DYNAMIC_GROUPS=1 を受けていない購読では、型付きの NEW_GROUP_REQUEST は送信前に拒否される。
 */
test("bidiSendRequestUpdate: DYNAMIC_GROUPS の無い購読で newGroupRequest は拒否される", async () => {
  const { session, subscriber, written } = createUpdateContext([]);

  let rejected: unknown;
  try {
    await subscriber.update({ newGroupRequest: 5n });
  } catch (error) {
    rejected = error;
  }

  assert.instanceOf(rejected, Error);
  assert.equal((rejected as Error).message, ERROR_MESSAGE);
  // 送信バイトが 0 で、送信状態のエントリも残らない
  assert.equal(written.length, 0);
  assert.equal(session.pendingRequestUpdate.size, 0);
  assert.equal(session.fillFetchTargets.size, 0);
});

/**
 * DYNAMIC_GROUPS が値 0 の場合も、値に依らず送信自体が禁止されるため拒否される。
 */
test("bidiSendRequestUpdate: DYNAMIC_GROUPS=0 の購読で newGroupRequest は拒否される", async () => {
  const { subscriber } = createUpdateContext([{ id: TrackPropertyId.DYNAMIC_GROUPS, value: 0n }]);

  let rejected: unknown;
  try {
    await subscriber.update({ newGroupRequest: 0n });
  } catch (error) {
    rejected = error;
  }
  assert.equal((rejected as Error)?.message, ERROR_MESSAGE);
});

/**
 * raw パラメータ経由の NEW_GROUP_REQUEST (0x32) も同じ検査の対象である。
 */
test("bidiSendRequestUpdate: raw の NEW_GROUP_REQUEST も DYNAMIC_GROUPS が無ければ拒否される", async () => {
  const { subscriber, written } = createUpdateContext([]);

  let rejected: unknown;
  try {
    await subscriber.update({
      parameters: [{ type: MessageParameterType.NEW_GROUP_REQUEST, value: new Uint8Array([0x01]) }],
    });
  } catch (error) {
    rejected = error;
  }
  assert.equal((rejected as Error)?.message, ERROR_MESSAGE);
  assert.equal(written.length, 0);
});

/**
 * DYNAMIC_GROUPS=1 を受けていれば送信できる (mutable 側)。
 */
test("bidiSendRequestUpdate: DYNAMIC_GROUPS=1 の購読では newGroupRequest を送信できる", async () => {
  const { session, subscriber, written } = createUpdateContext([
    { id: TrackPropertyId.DYNAMIC_GROUPS, value: 1n },
  ]);

  const promise = subscriber.update({ newGroupRequest: 1n });
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  assert.isAbove(written.length, 0);
  assert.equal(session.pendingRequestUpdate.size, 1);
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await promise;
});

/**
 * DYNAMIC_GROUPS=1 が Immutable Properties (0x0B) 配下にあっても送信できる
 * (draft-ietf-moq-transport-21 §10.7 の二重検索)。
 */
test("bidiSendRequestUpdate: Immutable Properties 配下の DYNAMIC_GROUPS=1 でも送信できる", async () => {
  const inner = encodeProperties([{ id: TrackPropertyId.DYNAMIC_GROUPS, value: 1n }]);
  const { session, subscriber, written } = createUpdateContext([
    { id: MOQTPropertyId.IMMUTABLE_PROPERTIES, data: inner },
  ]);

  const promise = subscriber.update({ newGroupRequest: 1n });
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  assert.isAbove(written.length, 0);
  assert.equal(session.pendingRequestUpdate.size, 1);
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await promise;
});

/**
 * NEW_GROUP_REQUEST を含まない更新は DYNAMIC_GROUPS の有無に関わらず従来どおり送信できる
 * (検査が 0x32 に限定されていることの確認)。
 */
test("bidiSendRequestUpdate: NEW_GROUP_REQUEST を含まない更新は DYNAMIC_GROUPS 無しでも送信できる", async () => {
  const { session, subscriber, written } = createUpdateContext([]);

  const promise = subscriber.update({ forward: false });
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  assert.isAbove(written.length, 0);
  assert.equal(session.pendingRequestUpdate.size, 1);
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await promise;
});
