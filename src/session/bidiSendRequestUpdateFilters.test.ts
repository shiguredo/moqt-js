/**
 * session/bidi.ts の単体テスト: bidiSendRequestUpdate の Range Filters 送信
 *
 * bidiSendRequestUpdate が Range Filters を REQUEST_UPDATE として
 * エンコードする挙動を検証する。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import { MessageType, MessageParameterType } from "../message/types";
import { decodeRequestUpdatePayload } from "../message/subscribe";
import { createBidiSession } from "../testSupport/bidi";
import { concatUint8Arrays } from "../testSupport/helpers";
import { ControlStreamReader } from "../controlStream";
import { bidiSendRequestUpdate } from "./bidi";

// ============================================================================
// bidiSendRequestUpdate の Range Filters テスト
// draft-ietf-moq-transport-21 §3.3.2 / §9.1.6
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §3.3.2:
 * REQUEST_UPDATE では TRACK_PROPERTY_FILTER (0x29) は一律 throw する。
 * moqt-js が送信する REQUEST_UPDATE はすべて per-subscription の更新 (§9.5) であり、
 * 0x29 が許可される SUBSCRIBE_TRACKS リクエスト自身のストリーム上の REQUEST_UPDATE
 * (「REQUEST_UPDATE for it」) に該当しないため。
 */
test("bidiSendRequestUpdate: TRACK_PROPERTY_FILTER を含む rangeFilters で throw する", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      rangeFilters: [
        { type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 1n }] },
        { type: "trackProperty", remove: true },
      ],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("TRACK_PROPERTY_FILTER"));
});

/**
 * draft-ietf-moq-transport-21 §3.3.2:
 * REQUEST_UPDATE の rangeFilters (0x29 以外) が REQUEST_UPDATE にエンコードされ、
 * 削除 (Length=0) も許可されることを検証する。
 */
test("bidiSendRequestUpdate: rangeFilters が REQUEST_UPDATE にエンコードされる", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  // bidiSendRequestUpdate は REQUEST_OK 受信まで resolve しない Promise を返すため、
  // 送信完了後に pendingRequestUpdate の Promise を解決してから await する
  const updatePromise = bidiSendRequestUpdate(session, subscriber, {
    rangeFilters: [
      { type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 1n }] },
      { type: "objectId", remove: true },
    ],
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  // writer.write されたバイト列を ControlStreamReader でフレームに分解する
  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_UPDATE);

  const decoded = decodeRequestUpdatePayload(messages[0].payload);
  assert.isDefined(decoded.parameters.find((p) => p.type === MessageParameterType.SUBGROUP_FILTER));
  assert.isDefined(decoded.parameters.find((p) => p.type === MessageParameterType.OBJECTID_FILTER));
});
