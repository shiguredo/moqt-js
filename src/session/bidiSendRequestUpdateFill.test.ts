/**
 * session/bidi.ts の単体テスト: bidiSendRequestUpdate の FILL_PARAMETERS 送信
 *
 * bidiSendRequestUpdate の FILL_PARAMETERS 経路 (上限検証 / マージ /
 * in-flight の適用順) を検証する。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import { type MoqtObject } from "../dataStream";
import { ObjectStatus } from "../message";
import { MessageType, MessageParameterType, GroupOrder } from "../message/types";
import { encodeParameters, decodeFillParameters } from "../message";
import { decodeRequestUpdatePayload } from "../message/subscribe";
import { encodeLocationFilterParameter } from "../message/parameter";
import { InvalidFilterError } from "../error";
import { createBidiSession, buildExceedingLocationFilterValue } from "../testSupport/bidi";
import { concatUint8Arrays } from "../testSupport/helpers";
import { encodeVarint, MAX_VARINT } from "../varint";
import { ControlStreamReader } from "../controlStream";
import {
  bidiSendRequestUpdate,
  rejectPendingRequestUpdates,
  type BidiSessionInternal,
} from "./bidi";

// ============================================================================
// bidiSendRequestUpdate の FILL_PARAMETERS テスト
// draft-ietf-moq-transport-21 §3.4 / §9.20.16
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.20.16:
 * update({ fill }) で FILL_PARAMETERS (0x23) が REQUEST_UPDATE に載り、
 * 内側に指定内容が入ることを検証する。fill 要求元の Request ID は購読に
 * 関連付けられる。
 */
test("bidiSendRequestUpdate: fill が FILL_PARAMETERS として REQUEST_UPDATE にエンコードされる", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  // bidiSendRequestUpdate は REQUEST_OK 受信まで resolve しない Promise を返すため、
  // 送信完了後に pendingRequestUpdate の Promise を解決してから await する
  const updatePromise = bidiSendRequestUpdate(session, subscriber, {
    fill: {
      filter: { startGroup: 10n, startObject: 2n },
      fillTimeout: 100n,
      subscriberPriority: 10,
      groupOrder: "Descending",
    },
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
  const fillParam = decoded.parameters.find((p) => p.type === MessageParameterType.FILL_PARAMETERS);
  assert.isDefined(fillParam);
  const inner = decodeFillParameters(fillParam!);
  assert.isDefined(inner.find((p) => p.type === MessageParameterType.LOCATION_FILTER));
  assert.isDefined(inner.find((p) => p.type === MessageParameterType.FILL_TIMEOUT));
  assert.isDefined(inner.find((p) => p.type === MessageParameterType.SUBSCRIBER_PRIORITY));
  assert.isDefined(inner.find((p) => p.type === MessageParameterType.GROUP_ORDER));

  // fill 要求元の Request ID (100n) が購読に関連付けられる
  const target = session.fillFetchTargets.get(100n);
  assert.isDefined(target);
  assert.equal(target!.subscriber, subscriber);
  assert.equal(target!.groupOrder, GroupOrder.DESCENDING);
});

/**
 * draft-ietf-moq-transport-21 §9.20.10 / §9.20.16:
 * fill 内の LOCATION_FILTER が End Group 超過の場合は送信前に throw する。
 */
test("bidiSendRequestUpdate: fill 内の LOCATION_FILTER が End Group 超過の場合は throw する", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      fill: {
        filter: { startGroup: MAX_VARINT, startObject: 0n, endGroupDelta: 1n },
      },
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("absolute range end group exceeds maximum"));
  // 失敗時は fill 関連付けも残らない
  assert.equal(session.fillFetchTargets.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.1.6:
 * fill 内側の Range Filters も購読単位の上限に含め、上限超過では送信前に
 * throw することを検証する。
 */
test("bidiSendRequestUpdate: fill 内側の Range Filters が上限超過の場合は throw する", async () => {
  // createBidiSession の peerMaxFilterRanges は 2 のため、3 Ranges で超過する
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      fill: {
        rangeFilters: [
          {
            type: "subgroup",
            setId: 0,
            ranges: [
              { start: 0n, end: 1n },
              { start: 3n, end: 4n },
              { start: 5n, end: 6n },
            ],
          },
        ],
      },
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("exceeds peer MAX_FILTER_RANGES 2"));
  // 失敗時は fill 関連付けも残らない
  assert.equal(session.fillFetchTargets.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.1.6:
 * in-flight 中の fill 内側 Range Filters も上限合算に含め、合計超過では
 * 送信前に throw することを検証する。
 */
test("bidiSendRequestUpdate: in-flight の fill と合計で上限超過の場合は throw する", async () => {
  // createBidiSession の peerMaxFilterRanges は 2 のため、2 + 1 で超過する
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  // 1 件目の fill 更新を in-flight のまま残す (2 Ranges)
  const firstPromise = bidiSendRequestUpdate(session, subscriber, {
    fill: {
      rangeFilters: [
        {
          type: "subgroup",
          setId: 0,
          ranges: [
            { start: 0n, end: 1n },
            { start: 3n, end: 4n },
          ],
        },
      ],
    },
  });
  firstPromise.catch(() => {});

  // 2 件目の fill 更新 (1 Range) は合計 3 で上限 2 を超えるため throw する
  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      fill: {
        rangeFilters: [{ type: "subgroup", setId: 1, ranges: [{ start: 0n, end: 1n }] }],
      },
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("exceeds peer MAX_FILTER_RANGES 2"));
  // 1 件目の関連付けは残り、2 件目は登録されない
  assert.equal(session.fillFetchTargets.size, 1);

  // 後始末: 1 件目を解決して unhandled にしない
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await firstPromise;
});

/**
 * draft-ietf-moq-transport-21 §9.20.16:
 * update の fill で GROUP_ORDER を省略した場合、subscription の指定を継承して
 * 関連付けられることを検証する。
 */
test("bidiSendRequestUpdate: fill の GROUP_ORDER 省略時は subscription の指定を継承する", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  subscriber.setGroupOrder("Descending");

  const updatePromise = bidiSendRequestUpdate(session, subscriber, {
    fill: {
      filter: { startGroup: 10n, startObject: 2n },
    },
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  const target = session.fillFetchTargets.get(100n);
  assert.isDefined(target);
  assert.equal(target!.groupOrder, GroupOrder.DESCENDING);
});

test("bidiSendRequestUpdate: Range Filters の Ranges 数が MAX_FILTER_RANGES を超えると throw する", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      rangeFilters: [
        {
          type: "subgroup",
          setId: 0,
          ranges: [
            { start: 0n, end: 1n },
            { start: 3n, end: 4n },
            { start: 5n, end: 6n },
          ],
        },
      ],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("exceeds peer MAX_FILTER_RANGES 2"));
});

test("bidiSendRequestUpdate: Range Filters が MAX_FILTER_RANGES 以内なら throw しない", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  let thrown: Error | undefined;
  try {
    // pendingRequestUpdate の Promise を解決してから await する
    const updatePromise = bidiSendRequestUpdate(session, subscriber, {
      rangeFilters: [
        {
          type: "subgroup",
          setId: 0,
          ranges: [
            { start: 0n, end: 1n },
            { start: 3n, end: 4n },
          ],
        },
      ],
    });
    for (const [, pending] of session.pendingRequestUpdate) {
      pending.resolve();
    }
    await updatePromise;
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isUndefined(thrown);
});

/**
 * draft-ietf-moq-transport-21 §9.1.6 / §3.3.2:
 * MAX_FILTER_RANGES は「マージ後のフィルタ状態」に対して適用される。
 * 既存フィルタ (2 Range) と update (1 Range) のマージ後 (3 Range) が
 * 上限 2 を超える場合、update 単体では合法でも送信前に throw することを
 * 検証する。
 */
test("bidiSendRequestUpdate: 既存フィルタとマージすると MAX_FILTER_RANGES を超える場合に throw する", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  // 既存フィルタ (subgroup 2 Range。単体では上限 2 以内)
  subscriber.setRangeFilters([
    {
      type: "subgroup",
      setId: 0,
      ranges: [
        { start: 0n, end: 1n },
        { start: 3n, end: 4n },
      ],
    },
  ]);

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      rangeFilters: [
        {
          type: "objectId",
          setId: 0,
          ranges: [{ start: 5n, end: 6n }],
        },
      ],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("exceeds peer MAX_FILTER_RANGES 2"));
  // throw 時に pending エントリが残らない
  assert.equal(session.pendingRequestUpdate.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * raw パラメータ経路の LOCATION_FILTER (0x21) も型付き経路と同じ
 * End Group 検証の対象にする。超過時は InvalidFilterError で送信前に
 * 拒否し、pending エントリを残さない。
 */
test("bidiSendRequestUpdate: raw LOCATION_FILTER の End Group 超過で InvalidFilterError", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  // StartGroup(1) + EndGroupDelta(2^64-1) が 2^64-1 を超える 3 フィールド表現を手組みする
  const exceeding = buildExceedingLocationFilterValue();

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      parameters: [{ type: MessageParameterType.LOCATION_FILTER, value: exceeding }],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.instanceOf(thrown, InvalidFilterError);
  assert.isTrue(thrown!.message.includes("absolute range end group exceeds maximum"));
  // throw 時に pending エントリが残らない
  assert.equal(session.pendingRequestUpdate.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * トップレベルの LOCATION_FILTER が複数ある場合も全件検証し、
 * 2 件目以降の超過を見逃さない。
 */
test("bidiSendRequestUpdate: 2 件目の raw LOCATION_FILTER 超過も InvalidFilterError", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  const exceeding = buildExceedingLocationFilterValue();

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      parameters: [
        encodeLocationFilterParameter({ startGroup: 1n, startObject: 2n }),
        { type: MessageParameterType.LOCATION_FILTER, value: exceeding },
      ],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.instanceOf(thrown, InvalidFilterError);
  assert.isTrue(thrown!.message.includes("absolute range end group exceeds maximum"));
  assert.equal(session.pendingRequestUpdate.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * 正常な raw LOCATION_FILTER は従来どおり送信でき、
 * LOCATION_FILTER 以外の raw パラメータは検証対象にしない。
 */
test("bidiSendRequestUpdate: 正常な raw LOCATION_FILTER は送信できる", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  const updatePromise = bidiSendRequestUpdate(session, subscriber, {
    parameters: [
      encodeLocationFilterParameter({ startGroup: 1n, startObject: 2n }),
      { type: MessageParameterType.SUBSCRIBER_PRIORITY, value: new Uint8Array([0x01]) },
    ],
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  assert.equal(messages.length, 1);
  const decoded = decodeRequestUpdatePayload(messages[0].payload);
  assert.isDefined(decoded.parameters.find((p) => p.type === MessageParameterType.LOCATION_FILTER));
  // LOCATION_FILTER 以外の raw パラメータは検証対象にせず素通しする
  assert.isDefined(
    decoded.parameters.find((p) => p.type === MessageParameterType.SUBSCRIBER_PRIORITY),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.20.10 / §9.20.16:
 * 手組みの raw FILL_PARAMETERS 内側の LOCATION_FILTER が End Group 超過の
 * 場合は送信前に InvalidFilterError で拒否し、pending エントリを残さない。
 */
test("bidiSendRequestUpdate: raw FILL_PARAMETERS 内側の End Group 超過で InvalidFilterError", async () => {
  // 内側 LOCATION_FILTER が超過する raw FILL_PARAMETERS を手組みする
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  const exceeding = buildExceedingLocationFilterValue();
  const inner = encodeParameters([
    { type: MessageParameterType.LOCATION_FILTER, value: exceeding },
  ]);

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      parameters: [{ type: MessageParameterType.FILL_PARAMETERS, value: inner }],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  // 内側の超過が InvalidFilterError に変換される
  assert.instanceOf(thrown, InvalidFilterError);
  assert.isTrue(thrown!.message.includes("absolute range end group exceeds maximum"));
  // throw 時に pending エントリが残らず、ワイヤ書き込みもない
  assert.equal(session.pendingRequestUpdate.size, 0);
  assert.equal(written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.20.10 / §9.20.16:
 * 単一の raw FILL_PARAMETERS の内側超過を InvalidFilterError で拒否する。
 * 複数件の場合は重複検査が先に拒否するため、内側検証は単一の場合に到達する。
 */
test("bidiSendRequestUpdate: 単一の raw FILL_PARAMETERS 内側超過も InvalidFilterError", async () => {
  // 内側が超過する単一の組み合わせを手組みする
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  const exceeding = buildExceedingLocationFilterValue();
  const exceedingInner = encodeParameters([
    { type: MessageParameterType.LOCATION_FILTER, value: exceeding },
  ]);

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      parameters: [{ type: MessageParameterType.FILL_PARAMETERS, value: exceedingInner }],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  // 内側の超過が InvalidFilterError に変換される
  assert.instanceOf(thrown, InvalidFilterError);
  assert.isTrue(thrown!.message.includes("absolute range end group exceeds maximum"));
  assert.equal(session.pendingRequestUpdate.size, 0);
  assert.equal(written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.20.10 / §9.20.16:
 * 4 フィールド表現 (EndObject 付き) の内側超過も送信前に拒否する。
 * 3 フィールドとは別分岐のため到達を確認する。
 */
test("bidiSendRequestUpdate: raw FILL_PARAMETERS 内側の 4 フィールド超過も InvalidFilterError", async () => {
  // StartGroup(1) + EndGroupDelta(2^64-1) が超過する 4 フィールド表現を手組みする
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  const exceedingFields = new Uint8Array([
    ...encodeVarint(1n),
    ...encodeVarint(0n),
    ...encodeVarint(MAX_VARINT),
    ...encodeVarint(0n),
  ]);
  const exceedingValue = new Uint8Array([
    ...encodeVarint(BigInt(exceedingFields.length)),
    ...exceedingFields,
  ]);
  const inner = encodeParameters([
    { type: MessageParameterType.LOCATION_FILTER, value: exceedingValue },
  ]);

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      parameters: [{ type: MessageParameterType.FILL_PARAMETERS, value: inner }],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  // 4 フィールド分岐の超過が InvalidFilterError に変換される
  assert.instanceOf(thrown, InvalidFilterError);
  assert.isTrue(thrown!.message.includes("absolute range end group exceeds maximum"));
  assert.equal(session.pendingRequestUpdate.size, 0);
  assert.equal(written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.20.16:
 * 正常な raw FILL_PARAMETERS は従来どおり送信でき、
 * ワイヤ上の parameters に FILL_PARAMETERS が残る (回帰ガード)。
 */
test("bidiSendRequestUpdate: 正常な raw FILL_PARAMETERS は送信できる", async () => {
  // 正常な内側 LOCATION_FILTER を包んだ raw FILL_PARAMETERS を渡す。
  // 購読への関連付け登録は別テストで検証する
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  const normalInner = encodeParameters([
    encodeLocationFilterParameter({ startGroup: 1n, startObject: 2n }),
  ]);

  const updatePromise = bidiSendRequestUpdate(session, subscriber, {
    parameters: [{ type: MessageParameterType.FILL_PARAMETERS, value: normalInner }],
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  assert.equal(messages.length, 1);
  const decoded = decodeRequestUpdatePayload(messages[0].payload);
  const sentFill = decoded.parameters.find((p) => p.type === MessageParameterType.FILL_PARAMETERS);
  assert.isDefined(sentFill);
  // 内側の LOCATION_FILTER が保持されている
  const sentInner = decodeFillParameters(sentFill);
  assert.isDefined(sentInner.find((p) => p.type === MessageParameterType.LOCATION_FILTER));
});

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * bidiSendRequestUpdate は送信時の LOCATION_FILTER (先頭 1 件のデコード値) を
 * pending に保持し、REQUEST_OK 受信時の反映に使うことを検証する。
 */
test("bidiSendRequestUpdate: 送信時の LOCATION_FILTER が pending に保持される", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  const updatePromise = bidiSendRequestUpdate(session, subscriber, {
    parameters: [encodeLocationFilterParameter({ startGroup: 2n, startObject: 3n })],
  });
  assert.equal(session.pendingRequestUpdate.size, 1);
  for (const [, pending] of session.pendingRequestUpdate) {
    assert.deepEqual(pending.locationFilter, { startGroup: 2n, startObject: 3n });
    pending.resolve();
  }
  await updatePromise;
});

/**
 * draft-ietf-moq-transport-21 §9.5.1:
 * REQUEST_ERROR (coalescing による reject) では送信時の LOCATION_FILTER が
 * 反映されないことを検証する。
 */
test("rejectPendingRequestUpdates: 失敗時は送信時の LOCATION_FILTER が反映されない", () => {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 1n, (obj) => delivered.push(obj));
  subscriber.setLocationFilter({ startGroup: 1n, startObject: 0n });
  const session = {
    closeWithError: () => {},
    subscribers: new Map([[0n, subscriber]]),
    pendingRequestUpdate: new Map([
      [
        100n,
        {
          resolve: () => {},
          reject: () => {},
          targetRequestId: 0n,
          locationFilter: { startGroup: 5n, startObject: 0n },
        },
      ],
    ]),
  } as unknown as BidiSessionInternal;

  rejectPendingRequestUpdates(session, 0n, new Error("REQUEST_ERROR"));

  // 失敗時は旧フィルタのまま (group 1 は通過、group 0 は不通過)
  subscriber.handleObject({
    groupId: 0n,
    subgroupId: 0n,
    objectId: 0n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array([1]),
  });
  subscriber.handleObject({
    groupId: 1n,
    subgroupId: 0n,
    objectId: 0n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array([1]),
  });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].groupId, 1n);
  assert.equal(session.pendingRequestUpdate.size, 0);
});

test("bidiSendRequestUpdate: マージ後の状態が上限以内なら throw しない", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  subscriber.setRangeFilters([{ type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 1n }] }]);

  let thrown: Error | undefined;
  try {
    const updatePromise = bidiSendRequestUpdate(session, subscriber, {
      rangeFilters: [{ type: "objectId", setId: 0, ranges: [{ start: 5n, end: 6n }] }],
    });
    for (const [, pending] of session.pendingRequestUpdate) {
      pending.resolve();
    }
    await updatePromise;
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isUndefined(thrown);
});

/**
 * draft-ietf-moq-transport-21 §9.5.1:
 * 「Parameter values from later REQUEST_UPDATE messages override values from
 *  earlier ones.」により、in-flight の update (送信順) もマージに含めて
 * 検証する。in-flight の削除 update が反映されない場合は
 * subgroup 2 Range + objectId 1 Range = 3 Range (> 2) で超過するケースが、
 * 削除後は objectId 1 Range で上限以内になることを検証する (判別力を持つ)。
 */
test("bidiSendRequestUpdate: in-flight の削除 update がマージに反映される", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  subscriber.setRangeFilters([
    {
      type: "subgroup",
      setId: 0,
      ranges: [
        { start: 0n, end: 1n },
        { start: 3n, end: 4n },
      ],
    },
  ]);
  // in-flight の update (subgroup を全削除) を送信順で登録する
  session.pendingRequestUpdate.set(90n, {
    resolve: () => {},
    reject: () => {},
    targetRequestId: 0n,
    rangeFilters: [{ type: "subgroup", remove: true }],
  });

  let thrown: Error | undefined;
  try {
    const updatePromise = bidiSendRequestUpdate(session, subscriber, {
      rangeFilters: [{ type: "objectId", setId: 0, ranges: [{ start: 5n, end: 6n }] }],
    });
    for (const [, pending] of session.pendingRequestUpdate) {
      pending.resolve();
    }
    await updatePromise;
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isUndefined(thrown);
});

/**
 * draft-ietf-moq-transport-21 §9.5.1:
 * in-flight の update は送信順 (挿入順) で適用され、後からの値が前の値を
 * 上書きする。同じ型を 3 → 2 に置換する 2 件の in-flight を登録し、
 * 最後の値 (2 Range) でマージされることを検証する (先発が勝つ順序なら
 * 3 Range + 今回の 1 Range = 4 Range > 3 で throw するため判別力を持つ)。
 */
test("bidiSendRequestUpdate: in-flight の update は送信順で適用される", async () => {
  const { session } = createBidiSession();
  (session as unknown as { peerMaxFilterRanges: number }).peerMaxFilterRanges = 3;
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  subscriber.setRangeFilters([
    {
      type: "subgroup",
      setId: 0,
      ranges: [
        { start: 0n, end: 1n },
        { start: 3n, end: 4n },
      ],
    },
  ]);
  // in-flight 1 件目: subgroup を 3 Range に置換
  session.pendingRequestUpdate.set(90n, {
    resolve: () => {},
    reject: () => {},
    targetRequestId: 0n,
    rangeFilters: [
      {
        type: "subgroup",
        setId: 0,
        ranges: [
          { start: 10n, end: 11n },
          { start: 12n, end: 13n },
          { start: 14n, end: 15n },
        ],
      },
    ],
  });
  // in-flight 2 件目: subgroup を 2 Range に置換 (送信順で最後)
  session.pendingRequestUpdate.set(92n, {
    resolve: () => {},
    reject: () => {},
    targetRequestId: 0n,
    rangeFilters: [
      {
        type: "subgroup",
        setId: 0,
        ranges: [
          { start: 20n, end: 21n },
          { start: 22n, end: 23n },
        ],
      },
    ],
  });

  let thrown: Error | undefined;
  try {
    const updatePromise = bidiSendRequestUpdate(session, subscriber, {
      rangeFilters: [{ type: "objectId", setId: 0, ranges: [{ start: 5n, end: 6n }] }],
    });
    for (const [, pending] of session.pendingRequestUpdate) {
      pending.resolve();
    }
    await updatePromise;
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isUndefined(thrown);
});

test("bidiSendRequestUpdate: in-flight の update でマージ後が上限超過になる場合に throw する", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  subscriber.setRangeFilters([{ type: "objectId", setId: 0, ranges: [{ start: 0n, end: 1n }] }]);
  // in-flight の update (subgroup 2 Range。対象型が異なるため objectId と共存)
  session.pendingRequestUpdate.set(90n, {
    resolve: () => {},
    reject: () => {},
    targetRequestId: 0n,
    rangeFilters: [
      {
        type: "subgroup",
        setId: 0,
        ranges: [
          { start: 2n, end: 3n },
          { start: 4n, end: 5n },
        ],
      },
    ],
  });

  let thrown: Error | undefined;
  try {
    // 今回の update (objectId 1 Range) は単体では上限 2 以内だが、
    // in-flight の subgroup 2 Range を含むマージ後は 3 Range になる
    await bidiSendRequestUpdate(session, subscriber, {
      rangeFilters: [{ type: "objectId", setId: 0, ranges: [{ start: 10n, end: 11n }] }],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("exceeds peer MAX_FILTER_RANGES 2"));
});

/**
 * draft-ietf-moq-transport-21 §9.1.6:
 * ピアの MAX_FILTER_RANGES = 0 (未広告) の場合は §9.1.6 により送信禁止。
 * マージ後が空になる削除のみの update でも throw することを検証する
 * (既存ガードの維持)。
 */
test("bidiSendRequestUpdate: MAX_FILTER_RANGES が 0 のとき削除のみの update でも throw する", async () => {
  const { session } = createBidiSession();
  (session as unknown as { peerMaxFilterRanges: number }).peerMaxFilterRanges = 0;
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      rangeFilters: [{ type: "subgroup", remove: true }],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("MAX_FILTER_RANGES is 0"));
  assert.equal(session.pendingRequestUpdate.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.1.6:
 * 空配列の rangeFilters (フィルタ指定なしの no-op メッセージ) は、ピアの
 * MAX_FILTER_RANGES が 0 (未広告) でも送信できる (フィルタパラメータ自体が
 * 送信されないため。旧実装でも送信可能だった挙動の維持)。
 * ガードが「undefined でも空配列でも throw する」形に退化した場合に
 * 送信経路に到達しないことを検出できるよう、メッセージ書き込みまで
 * 確認する。
 */
test("bidiSendRequestUpdate: 空配列の rangeFilters は MAX_FILTER_RANGES が 0 でも送信できる", async () => {
  const { session, written } = createBidiSession();
  (session as unknown as { peerMaxFilterRanges: number }).peerMaxFilterRanges = 0;
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  let thrown: Error | undefined;
  try {
    const updatePromise = bidiSendRequestUpdate(session, subscriber, {
      rangeFilters: [],
    });
    for (const [, pending] of session.pendingRequestUpdate) {
      pending.resolve();
    }
    await updatePromise;
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isUndefined(thrown);
  // REQUEST_UPDATE メッセージが送信経路に到達している
  assert.equal(written.length, 1);
});

/**
 * draft-ietf-moq-transport-21 §3.3.2:
 * 削除を含む update は削除後の状態で検証される (既存の同型フィルタは
 * マージで取り除かれ、Ranges 数に数えられない)。本テストが検出するのは
 * 「update をマージせず連結する」誤実装のみである (削除後の Ranges 数と
 * 単体の Ranges 数が一致するケースのため)。
 */
test("bidiSendRequestUpdate: 削除を含む update は削除後の状態で検証される", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  subscriber.setRangeFilters([
    {
      type: "subgroup",
      setId: 0,
      ranges: [
        { start: 0n, end: 1n },
        { start: 3n, end: 4n },
      ],
    },
  ]);

  let thrown: Error | undefined;
  try {
    const updatePromise = bidiSendRequestUpdate(session, subscriber, {
      rangeFilters: [
        { type: "subgroup", remove: true },
        { type: "objectId", setId: 0, ranges: [{ start: 5n, end: 6n }] },
      ],
    });
    for (const [, pending] of session.pendingRequestUpdate) {
      pending.resolve();
    }
    await updatePromise;
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isUndefined(thrown);
});

/** Uint8Array 配列を連結するヘルパー */
