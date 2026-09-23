/**
 * session/bidi.ts の単体テスト: publish ロールで受信した REQUEST_UPDATE の条件判定
 *
 * publish ロールのリクエストストリームで受信した REQUEST_UPDATE の
 * パラメータ検証と REQUEST_OK / REQUEST_ERROR / PUBLISH_DONE の応答を検証する。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { decodeRequestErrorPayload } from "../message/session";
import { decodePublishDonePayload } from "../message/publish";
import { MessageType, MessageParameterType, PublishDoneStatusCode } from "../message/types";
import {
  encodeParameters,
  encodeFillParameters,
  encodeAuthorizationToken,
  AuthorizationTokenAliasType,
} from "../message";
import { buildFillParameters } from "./params";
import { encodeRequestUpdatePayload } from "../message/subscribe";
import { encodeLocationFilterParameter } from "../message/parameter";
import { SessionErrorCode, RequestErrorCode } from "../error";
import {
  createPublishReadTestContext,
  buildOverflowingLocationFilterParameter,
} from "../testSupport/bidi";
import { concatUint8Arrays } from "../testSupport/helpers";
import { encodeVarint, MAX_VARINT } from "../varint";
import { ControlStreamReader } from "../controlStream";
import { bidiReadRequestStreamMessages, FILL_NOT_SUPPORTED_REASON } from "./bidi";

// ============================================================================
// bidiHandlePublishRequestUpdate のテスト
// draft-ietf-moq-transport-21 §9.5 ケース 1 (受信 PUBLISH 上の REQUEST_UPDATE)
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §3.3.2:
 * role=publish の受信 REQUEST_UPDATE に不正な Range Filter (値域違反) が
 * 含まれる場合、REQUEST_ERROR (INVALID_FILTER) で応答されることを検証する。
 * 検証は forward state 反映より前に配置されるため、状態は変更されない。
 */
test("bidiReadRequestStreamMessages: 不正な Range Filter を含む REQUEST_UPDATE に REQUEST_ERROR (INVALID_FILTER) が応答される (publish ロール)", async () => {
  const ctx = createPublishReadTestContext({});

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // PRIORITY_FILTER (0x27) で 255 超の値 (Start=11266) を含む REQUEST_UPDATE を feed する
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      {
        type: 0x27,
        value: new Uint8Array([0x04, 0x01, 0xac, 0x02, 0x00]),
      },
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // REQUEST_ERROR (INVALID_FILTER) が書き込まれ、forward state は変更されない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  const decoded = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.INVALID_FILTER));
  assert.equal(messages[1].type, MessageType.PUBLISH_DONE);
  const publishDone = decodePublishDonePayload(messages[1].payload);
  assert.equal(publishDone.statusCode, BigInt(PublishDoneStatusCode.UPDATE_FAILED));
  assert.equal(publishDone.streamCount, 0n);
  assert.isUndefined(ctx.closedWithError);
  // 検証は forward state 反映より前に配置されるため、状態は初期値 (true) のまま
  assert.isTrue(ctx.publisher.forwardState);
});

/**
 * draft-ietf-moq-transport-21 §9.20.10 / §9.20.16:
 * role=publish の受信 REQUEST_UPDATE の FILL_PARAMETERS 内側 LOCATION_FILTER が
 * End Group 超過の場合、PROTOCOL_VIOLATION でセッションを閉じることを検証する。
 */
test("bidiReadRequestStreamMessages: FILL 内側の LOCATION_FILTER 超過の REQUEST_UPDATE (publish ロール) でセッションが閉じる", async () => {
  const ctx = createPublishReadTestContext({});

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // 内側の End Group = MAX_VARINT + 1 超過を手組みする
  const fields = new Uint8Array([
    ...encodeVarint(MAX_VARINT),
    ...encodeVarint(0n),
    ...encodeVarint(1n),
  ]);
  const overflowValue = new Uint8Array([...encodeVarint(BigInt(fields.length)), ...fields]);
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      encodeFillParameters([{ type: MessageParameterType.LOCATION_FILTER, value: overflowValue }]),
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // PROTOCOL_VIOLATION でセッションが閉じ、REQUEST_OK は応答されない
  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.equal(ctx.written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §3.3.2 / §9.20.16:
 * role=publish の受信 REQUEST_UPDATE の FILL_PARAMETERS 内側 Range Filter が
 * 値違反の場合、外側と同様に REQUEST_ERROR (INVALID_FILTER) で応答されることを
 * 検証する。
 */
test("bidiReadRequestStreamMessages: FILL 内側の Range Filter 値違反の REQUEST_UPDATE (publish ロール) で INVALID_FILTER が応答される", async () => {
  const ctx = createPublishReadTestContext({});

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // PRIORITY_FILTER (0x27) で 255 超の値を内側に含める
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      encodeFillParameters([{ type: 0x27, value: new Uint8Array([0x04, 0x01, 0xac, 0x02, 0x00]) }]),
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // REQUEST_ERROR (INVALID_FILTER) が応答され、セッションは閉じない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  const decoded = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.INVALID_FILTER));
  assert.equal(messages[1].type, MessageType.PUBLISH_DONE);
  const publishDone = decodePublishDonePayload(messages[1].payload);
  assert.equal(publishDone.statusCode, BigInt(PublishDoneStatusCode.UPDATE_FAILED));
  assert.equal(publishDone.streamCount, 0n);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.20.16:
 * role=publish の受信 REQUEST_UPDATE の FILL_PARAMETERS 内側に除去が含まれる
 * 場合、一回限りの fill に意味を持たないため REQUEST_ERROR (INVALID_FILTER)
 * で応答されることを検証する。
 */
test("bidiReadRequestStreamMessages: FILL 内側の除去を含む REQUEST_UPDATE (publish ロール) で INVALID_FILTER が応答される", async () => {
  const ctx = createPublishReadTestContext({});

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // SUBGROUP_FILTER の除去 (Length=0) を内側に含める
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [encodeFillParameters([{ type: 0x25, value: new Uint8Array([0x00]) }])],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // REQUEST_ERROR (INVALID_FILTER) が応答され、セッションは閉じない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  const decoded = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.INVALID_FILTER));
  assert.equal(messages[1].type, MessageType.PUBLISH_DONE);
  const publishDone = decodePublishDonePayload(messages[1].payload);
  assert.equal(publishDone.statusCode, BigInt(PublishDoneStatusCode.UPDATE_FAILED));
  assert.equal(publishDone.streamCount, 0n);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * role=publish の受信 REQUEST_UPDATE に End Group 超過の LOCATION_FILTER が
 * 含まれる場合、PROTOCOL_VIOLATION でセッションを閉じることを検証する。
 * REQUEST_OK は応答されない。
 */
test("bidiReadRequestStreamMessages: End Group 超過の LOCATION_FILTER を含む REQUEST_UPDATE (publish ロール) でセッションが閉じる", async () => {
  // 3 フィールド表現と 4 フィールド (EndObject 付き) 表現の両方で検証する
  const overflowing = [
    buildOverflowingLocationFilterParameter(),
    buildOverflowingLocationFilterParameter(true),
  ];
  for (const parameter of overflowing) {
    const ctx = createPublishReadTestContext({});

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
      parameters: [parameter],
    });
    const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
    ctx.readableController.enqueue(message);
    ctx.readableController.close();
    await readPromise;

    // PROTOCOL_VIOLATION でセッションが閉じ、REQUEST_OK は応答されない
    assert.isDefined(ctx.closedWithError);
    assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
    assert.equal(ctx.written.length, 0);
  }
});

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * role=publish の受信 REQUEST_UPDATE に正常な LOCATION_FILTER が含まれる場合、
 * 従来どおり REQUEST_OK が応答されセッションが閉じないことを検証する
 * (回帰ガード)。
 */
test("bidiReadRequestStreamMessages: 正常な LOCATION_FILTER を含む REQUEST_UPDATE (publish ロール) で REQUEST_OK が応答される", async () => {
  const ctx = createPublishReadTestContext({});

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // 除去 (Length 0) / 1 フィールド相対 / AbsoluteStart / 域内 AbsoluteRange /
  // End Group = 2^64-1 ちょうどの境界値の 5 種はいずれも有効
  const validFilters = [
    encodeLocationFilterParameter({ reset: true }),
    encodeLocationFilterParameter({ startGroup: 3n }),
    encodeLocationFilterParameter({ startGroup: 10n, startObject: 2n }),
    encodeLocationFilterParameter({ startGroup: 10n, startObject: 2n, endGroupDelta: 5n }),
    encodeLocationFilterParameter({
      startGroup: MAX_VARINT - 5n,
      startObject: 7n,
      endGroupDelta: 5n,
    }),
  ];
  for (const filter of validFilters) {
    const updatePayload = encodeRequestUpdatePayload({
      type: MessageType.REQUEST_UPDATE,
      requestId: ctx.requestId,
      parameters: [filter],
    });
    const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
    ctx.readableController.enqueue(message);
  }
  ctx.readableController.close();
  await readPromise;

  // 5 通とも REQUEST_OK が応答され、セッションは閉じない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 5);
  for (const response of messages) {
    assert.equal(response.type, MessageType.REQUEST_OK);
  }
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.20.16:
 * role=publish の受信 REQUEST_UPDATE に一覧外のパラメータを含む
 * FILL_PARAMETERS が含まれる場合、PROTOCOL_VIOLATION でセッションを閉じることを
 * 検証する。REQUEST_OK は応答されない。
 */
test("bidiReadRequestStreamMessages: 一覧外を含む FILL_PARAMETERS の REQUEST_UPDATE (publish ロール) でセッションが閉じる", async () => {
  const ctx = createPublishReadTestContext({});

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // FORWARD (0x10) は Table 6 の一覧に無いため、内側に含めると違反になる
  const inner = encodeParameters([
    { type: MessageParameterType.FORWARD, value: new Uint8Array([1]) },
  ]);
  const lengthBytes = encodeVarint(BigInt(inner.length));
  const fillValue = new Uint8Array([...lengthBytes, ...inner]);
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [{ type: MessageParameterType.FILL_PARAMETERS, value: fillValue }],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // PROTOCOL_VIOLATION でセッションが閉じ、REQUEST_OK は応答されない
  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.equal(ctx.written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §3.4.1 / §9.5.1:
 * role=publish の受信 REQUEST_UPDATE に Forward State=1 で fill 範囲が空でない
 * FILL_PARAMETERS が含まれる場合、moqt-js は fill fetch ストリームを開けない
 * ため黙殺せず REQUEST_ERROR (NOT_SUPPORTED) で拒否し、PUBLISH_DONE
 * (UPDATE_FAILED) で購読を終了する。
 */
test("bidiReadRequestStreamMessages: fill 範囲が空でない FILL_PARAMETERS の REQUEST_UPDATE (publish ロール) で REQUEST_ERROR (NOT_SUPPORTED) が応答される", async () => {
  const ctx = createPublishReadTestContext({});
  // Largest Object を {groupId: 5, objectId: 0} にして fill 範囲を確定させる
  await ctx.publisher.sendObject({ groupId: 5, objectId: 0, payload: new Uint8Array() });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // fill 範囲の開始 {1, 0} は Largest Object {5, 0} 以前であり空でない
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      encodeFillParameters(
        buildFillParameters(
          {
            filter: { startGroup: 1n, startObject: 0n },
            fillTimeout: 100n,
          },
          "REQUEST_UPDATE",
        ),
      ),
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // REQUEST_ERROR (NOT_SUPPORTED) の後に PUBLISH_DONE (UPDATE_FAILED) が送出される
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  const requestError = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(requestError.errorCode, BigInt(RequestErrorCode.NOT_SUPPORTED));
  assert.equal(requestError.reasonPhrase, FILL_NOT_SUPPORTED_REASON);
  assert.equal(messages[1].type, MessageType.PUBLISH_DONE);
  const publishDone = decodePublishDonePayload(messages[1].payload);
  assert.equal(publishDone.statusCode, BigInt(PublishDoneStatusCode.UPDATE_FAILED));
  // テストは Largest Object を確定させるために Object を 1 つ送っており、
  // ハーネスは SessionImpl.publish と同じ配線で Subgroup ストリームを開くため 1 になる
  assert.equal(publishDone.streamCount, 1n);
  assert.equal(publishDone.reasonPhrase, "");
  // 拒否後は PublisherImpl が closed になり、後続の sendObject は fail-fast 拒否される
  assert.equal(ctx.publisher.state, "closed");
  assert.isFalse(ctx.session.publishers.has(ctx.requestId));
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §3.4:
 * 「the fill range never extends beyond Largest Object」ため、Largest Object を
 * まだ送信していない (null) 場合は fill 範囲が常に空になり、fill fetch
 * ストリームは開かれない。REQUEST_OK で受理される。
 */
test("bidiReadRequestStreamMessages: Largest Object 未受信の FILL_PARAMETERS の REQUEST_UPDATE (publish ロール) で REQUEST_OK が応答される", async () => {
  const ctx = createPublishReadTestContext({});
  // sendObject を呼ばないため Largest Object は null のまま

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      encodeFillParameters(
        buildFillParameters({ filter: { startGroup: 10n, startObject: 2n } }, "REQUEST_UPDATE"),
      ),
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // fill 範囲が空のため REQUEST_OK が応答され、セッションは閉じない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §3.4.1:
 * 「FILL_PARAMETERS carried while Forward State is 0 opens no fill fetch
 *  stream.」Forward State=0 の FILL_PARAMETERS は fill ストリームを開かない
 * ため、従来どおり REQUEST_OK で受理される。
 */
test("bidiReadRequestStreamMessages: Forward State=0 の FILL_PARAMETERS の REQUEST_UPDATE (publish ロール) で REQUEST_OK が応答される", async () => {
  const ctx = createPublishReadTestContext({});
  // Largest Object を {groupId: 5, objectId: 0} にして fill 範囲を確定させる
  // (null のままだと範囲が空になり Forward State 分岐を判別できない)
  await ctx.publisher.sendObject({ groupId: 5, objectId: 0, payload: new Uint8Array() });
  // Forward State 0 を直接設定する (setForwardState はセッション内部 API)
  ctx.publisher.setForwardState(false);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // fill 範囲 {1, 0} は Largest Object {5, 0} 以前であり空でない
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      encodeFillParameters(
        buildFillParameters(
          { filter: { startGroup: 1n, startObject: 0n }, fillTimeout: 100n },
          "REQUEST_UPDATE",
        ),
      ),
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // fill ストリームは開かれないため REQUEST_OK が応答され、セッションは閉じない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §3.4:
 * 「If the fill range is empty, or starts after Largest Object, the publisher
 *  does not open a fill fetch stream.」fill 範囲の開始が Largest Object より
 * 後を指す場合は fill ストリームを開かないため REQUEST_OK で受理される。
 */
test("bidiReadRequestStreamMessages: Largest Object より後の FILL_PARAMETERS の REQUEST_UPDATE (publish ロール) で REQUEST_OK が応答される", async () => {
  const ctx = createPublishReadTestContext({});
  // Largest Object を {groupId: 1, objectId: 0} にする
  await ctx.publisher.sendObject({ groupId: 1, objectId: 0, payload: new Uint8Array() });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // fill 範囲の開始が Largest Object {1, 0} より後
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      encodeFillParameters(
        buildFillParameters({ filter: { startGroup: 2n, startObject: 0n } }, "REQUEST_UPDATE"),
      ),
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §3.4:
 * fill 範囲は「FILL_PARAMETERS 内の LOCATION_FILTER、省略時は購読の
 * Location Filter」で決まる。内側の LOCATION_FILTER が購読の Location Filter
 * より優先されることを検証する (内側のみ範囲内 -> 拒否)。
 */
test("bidiReadRequestStreamMessages: FILL_PARAMETERS 内側の LOCATION_FILTER が購読の Location Filter より優先される (publish ロール)", async () => {
  const ctx = createPublishReadTestContext({});
  // Largest Object を {groupId: 5, objectId: 0} にする
  await ctx.publisher.sendObject({ groupId: 5, objectId: 0, payload: new Uint8Array() });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // 購読の Location Filter は絶対指定 {6, 0} で Largest Object {5, 0} より後
  // (範囲が空)、内側は相対指定 {1} で {5, 0} を指し範囲内
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      encodeLocationFilterParameter({ startGroup: 6n, startObject: 0n }),
      encodeFillParameters([encodeLocationFilterParameter({ startGroup: 1n })]),
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // 内側の LOCATION_FILTER が優先され、fill 範囲が空でないため拒否される
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  assert.equal(
    decodeRequestErrorPayload(messages[0].payload).errorCode,
    BigInt(RequestErrorCode.NOT_SUPPORTED),
  );
  // 拒否した更新の LOCATION_FILTER は購読状態へ反映されない
  assert.isUndefined(ctx.publisher.getResolvedLocationFilter());
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §3.4:
 * FILL_PARAMETERS 内に LOCATION_FILTER が無い場合、購読の Location Filter を
 * 使って fill 範囲を評価する。購読の Location Filter は REQUEST_UPDATE 間で
 * 保持される (§9.5「If a parameter ... is not present in REQUEST_UPDATE, its
 * value remains unchanged.」) ことも合わせて検証する。
 */
test("bidiReadRequestStreamMessages: 内側 LOCATION_FILTER 省略時は保持した購読の Location Filter で評価する (publish ロール)", async () => {
  const ctx = createPublishReadTestContext({});
  // Largest Object を {groupId: 5, objectId: 0} にする
  await ctx.publisher.sendObject({ groupId: 5, objectId: 0, payload: new Uint8Array() });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // 1 通目: 購読の Location Filter を絶対指定 {6, 0} に設定する (範囲が空)
  const filterPayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [encodeLocationFilterParameter({ startGroup: 6n, startObject: 0n })],
  });
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, filterPayload),
  );
  // 2 通目: LOCATION_FILTER を含まない FILL_PARAMETERS (FILL_TIMEOUT のみ)
  const fillPayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 103n,
    parameters: [
      encodeFillParameters(buildFillParameters({ fillTimeout: 100n }, "REQUEST_UPDATE")),
    ],
  });
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, fillPayload),
  );
  ctx.readableController.close();
  await readPromise;

  // 1 通目・2 通目とも REQUEST_OK。2 通目は内側 LOCATION_FILTER が無いため
  // 保持した購読の Location Filter {6, 0} (範囲が空) で評価される。保持が壊れて
  // フィルタなし (トラック全体) になると fill 範囲が空でなくなり REQUEST_ERROR
  // になるため、このテストは保持の有無を判別できる。
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.equal(messages[1].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §3.3.1:
 * 相対指定の Location Filter は設定時点の LARGEST_OBJECT で解決して固定する。
 * 設定後に Largest Object が進んでも保持した解決済みフィルタを再解決しない
 * ことを検証する (再解決すると fill 範囲が空に化けて REQUEST_OK になる)。
 */
test("bidiReadRequestStreamMessages: 保持した相対 Location Filter を Largest Object 更新後に再解決しない (publish ロール)", async () => {
  const ctx = createPublishReadTestContext({});
  // Largest Object を {groupId: 10, objectId: 0} にしてから相対指定 {0} (Next
  // Group) を設定する。設定時点で {11, 0} に解決されて固定される
  await ctx.publisher.sendObject({ groupId: 10, objectId: 0, payload: new Uint8Array() });
  ctx.publisher.setLocationFilter({ startGroup: 0n });
  assert.deepEqual(ctx.publisher.getResolvedLocationFilter()?.start, { group: 11n, object: 0n });
  // Largest Object を {11, 0} に進める
  await ctx.publisher.sendObject({ groupId: 11, objectId: 0, payload: new Uint8Array() });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // 内側 LOCATION_FILTER を含まない FILL_PARAMETERS (FILL_TIMEOUT のみ)
  const fillPayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      encodeFillParameters(buildFillParameters({ fillTimeout: 100n }, "REQUEST_UPDATE")),
    ],
  });
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, fillPayload),
  );
  ctx.readableController.close();
  await readPromise;

  // 設定時に固定した {11, 0} (Largest Object と同値) で fill 範囲が空でないため
  // REQUEST_ERROR (NOT_SUPPORTED) + PUBLISH_DONE になる。相対指定を現在の
  // Largest Object {11, 0} で再解決すると {12, 0} になり空と誤判定して
  // REQUEST_OK になるため、このテストは再解決の有無を判別できる。
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  assert.equal(
    decodeRequestErrorPayload(messages[0].payload).errorCode,
    BigInt(RequestErrorCode.NOT_SUPPORTED),
  );
  assert.equal(messages[1].type, MessageType.PUBLISH_DONE);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §3.4:
 * 購読の Location Filter も FILL_PARAMETERS 内の LOCATION_FILTER も無い場合、
 * fill 範囲はトラック全体 (Largest Object まで) になる。Largest Object が
 * あるため空でなく、REQUEST_ERROR (NOT_SUPPORTED) で拒否される。
 */
test("bidiReadRequestStreamMessages: フィルタ指定なしの FILL_PARAMETERS の REQUEST_UPDATE (publish ロール) で REQUEST_ERROR (NOT_SUPPORTED) が応答される", async () => {
  const ctx = createPublishReadTestContext({});
  // Largest Object を {groupId: 5, objectId: 0} にする
  await ctx.publisher.sendObject({ groupId: 5, objectId: 0, payload: new Uint8Array() });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // FILL_TIMEOUT のみで LOCATION_FILTER を一切指定しない
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      encodeFillParameters(buildFillParameters({ fillTimeout: 100n }, "REQUEST_UPDATE")),
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  assert.equal(
    decodeRequestErrorPayload(messages[0].payload).errorCode,
    BigInt(RequestErrorCode.NOT_SUPPORTED),
  );
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §3.4 / §9.20.10:
 * 4 フィールド指定で End Object が Start Object より小さい場合、フィルタ自身が
 * 空になり配信できる Object が無い。fill fetch ストリームは開かれないため
 * REQUEST_OK で受理される。
 */
test("bidiReadRequestStreamMessages: フィルタ自身が空の FILL_PARAMETERS の REQUEST_UPDATE (publish ロール) で REQUEST_OK が応答される", async () => {
  const ctx = createPublishReadTestContext({});
  // Largest Object を {groupId: 5, objectId: 5} にする。fill 範囲の開始 {5, 5}
  // は Largest Object 以前であり、「Largest Object より後」判定では空にならない
  // (自己空判定だけが空を返すことを判別できる)。
  await ctx.publisher.sendObject({ groupId: 5, objectId: 5, payload: new Uint8Array() });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // StartGroup = EndGroup = 5 で End Object (3) < Start Object (5) の空フィルタ
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      encodeFillParameters([
        encodeLocationFilterParameter({
          startGroup: 5n,
          startObject: 5n,
          endGroupDelta: 0n,
          endObject: 3n,
        }),
      ]),
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.20.19 / §3.4.1:
 * 同一 REQUEST_UPDATE で FORWARD=0 と FILL_PARAMETERS を送る場合、更新適用後の
 * Forward State は 0 であり fill fetch ストリームは開かれない。REQUEST_OK で
 * 受理され、Forward State も 0 に反映される。
 */
test("bidiReadRequestStreamMessages: 同一更新の FORWARD=0 と FILL_PARAMETERS の REQUEST_UPDATE (publish ロール) で REQUEST_OK が応答される", async () => {
  const ctx = createPublishReadTestContext({});
  // Largest Object を {groupId: 5, objectId: 0} にする
  await ctx.publisher.sendObject({ groupId: 5, objectId: 0, payload: new Uint8Array() });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // FORWARD=0 と範囲内の fill 要求を同一更新に載せる
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      { type: MessageParameterType.FORWARD, value: new Uint8Array([0]) },
      encodeFillParameters(
        buildFillParameters({ filter: { startGroup: 1n, startObject: 0n } }, "REQUEST_UPDATE"),
      ),
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isFalse(ctx.publisher.forwardState);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.20.19 / §3.4.1:
 * 現在 Forward State=0 でも、同一 REQUEST_UPDATE で FORWARD=1 に変えつつ
 * 範囲内の FILL_PARAMETERS を載せた場合は更新適用後の Forward State が 1 に
 * なるため fill fetch ストリームが必要になり、REQUEST_ERROR (NOT_SUPPORTED) で
 * 拒否される。
 */
test("bidiReadRequestStreamMessages: FORWARD=0 から FORWARD=1 に更新しつつ FILL_PARAMETERS を載せた REQUEST_UPDATE (publish ロール) で REQUEST_ERROR (NOT_SUPPORTED) が応答される", async () => {
  const ctx = createPublishReadTestContext({});
  // Largest Object を {groupId: 5, objectId: 0} にする
  await ctx.publisher.sendObject({ groupId: 5, objectId: 0, payload: new Uint8Array() });
  ctx.publisher.setForwardState(false);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // FORWARD=1 と範囲内の fill 要求を同一更新に載せる
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      { type: MessageParameterType.FORWARD, value: new Uint8Array([1]) },
      encodeFillParameters(
        buildFillParameters({ filter: { startGroup: 1n, startObject: 0n } }, "REQUEST_UPDATE"),
      ),
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // 更新後の Forward State は 1 のため拒否される
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  assert.equal(
    decodeRequestErrorPayload(messages[0].payload).errorCode,
    BigInt(RequestErrorCode.NOT_SUPPORTED),
  );
  // 拒否した更新の FORWARD=1 は反映されない
  assert.isFalse(ctx.publisher.forwardState);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §3.4:
 * 「When the subscription has no Location filter, or the LOCATION_FILTER inside
 *  FILL_PARAMETERS is zero-length, the fill range is the entire track up to
 *  Largest Object.」内側 LOCATION_FILTER の reset (Length 0) はトラック全体を
 * 指し、Largest Object があるため空でなく拒否される。
 */
test("bidiReadRequestStreamMessages: FILL_PARAMETERS 内側 LOCATION_FILTER が reset の REQUEST_UPDATE (publish ロール) で REQUEST_ERROR (NOT_SUPPORTED) が応答される", async () => {
  const ctx = createPublishReadTestContext({});
  // Largest Object を {groupId: 5, objectId: 0} にする
  await ctx.publisher.sendObject({ groupId: 5, objectId: 0, payload: new Uint8Array() });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [encodeFillParameters([encodeLocationFilterParameter({ reset: true })])],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  assert.equal(
    decodeRequestErrorPayload(messages[0].payload).errorCode,
    BigInt(RequestErrorCode.NOT_SUPPORTED),
  );
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.20.16:
 * 「A parameter that is omitted from FILL_PARAMETERS takes the value it has for
 *  the subscription」ため、内側 LOCATION_FILTER 省略時は同一 REQUEST_UPDATE の
 * top-level LOCATION_FILTER (更新後の購読値) を使って fill 範囲を評価する。
 */
test("bidiReadRequestStreamMessages: 同一更新の LOCATION_FILTER を内側省略時の購読フィルタに使う (publish ロール)", async () => {
  const ctx = createPublishReadTestContext({});
  // Largest Object を {groupId: 5, objectId: 0} にする
  await ctx.publisher.sendObject({ groupId: 5, objectId: 0, payload: new Uint8Array() });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // top-level LOCATION_FILTER は絶対指定 {6, 0} (範囲が空)、内側は省略
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      encodeLocationFilterParameter({ startGroup: 6n, startObject: 0n }),
      encodeFillParameters(buildFillParameters({ fillTimeout: 100n }, "REQUEST_UPDATE")),
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // 同一更新の LOCATION_FILTER {6, 0} が使われて fill 範囲が空になり受理される。
  // top-level を無視して保持値 (未設定 = フィルタなし) を使えばトラック全体と
  // なり REQUEST_ERROR になるため、このテストは参照元を判別できる。
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §3.3.1 / §3.4:
 * Next Object フィルタ (StartGroup = StartObject = 0) は
 * {Largest Object.Group, Largest Object.Object + 1} に解決される。Largest
 * Object {5, 0} に対して {5, 1} は後方のため fill 範囲が空になり REQUEST_OK。
 */
test("bidiReadRequestStreamMessages: Next Object の FILL_PARAMETERS の REQUEST_UPDATE (publish ロール) で REQUEST_OK が応答される", async () => {
  const ctx = createPublishReadTestContext({});
  // Largest Object を {groupId: 5, objectId: 0} にする
  await ctx.publisher.sendObject({ groupId: 5, objectId: 0, payload: new Uint8Array() });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      encodeFillParameters([encodeLocationFilterParameter({ startGroup: 0n, startObject: 0n })]),
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §3.3.2:
 * role=publish の受信 REQUEST_UPDATE に同一組み合わせの重複 Range Filter が
 * 含まれる場合、REQUEST_ERROR (INVALID_FILTER) で応答されることを検証する。
 */
test("bidiReadRequestStreamMessages: 重複組み合わせの Range Filter を含む REQUEST_UPDATE に REQUEST_ERROR (INVALID_FILTER) が応答される (publish ロール)", async () => {
  const ctx = createPublishReadTestContext({});

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // 同一 (Type=0x25, SetID=1) の SUBGROUP_FILTER を 2 つ含む REQUEST_UPDATE
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      { type: 0x25, value: new Uint8Array([0x03, 0x01, 0x00, 0x00]) },
      { type: 0x25, value: new Uint8Array([0x03, 0x01, 0x00, 0x00]) },
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  const decoded = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.INVALID_FILTER));
  assert.equal(messages[1].type, MessageType.PUBLISH_DONE);
  const publishDone = decodePublishDonePayload(messages[1].payload);
  assert.equal(publishDone.statusCode, BigInt(PublishDoneStatusCode.UPDATE_FAILED));
  assert.equal(publishDone.streamCount, 0n);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.5 / §9:
 * role=publish の受信 REQUEST_UPDATE のペイロードが不完全 (メッセージ構造の
 * 破損) な場合、黙殺せず PROTOCOL_VIOLATION でセッションが閉じることを
 * 検証する。ControlStreamReader が Length 分の完全なメッセージのみ渡す
 * ため、IncompleteDataError はここでは構造破損を意味する。
 */
test("bidiReadRequestStreamMessages: 破損 REQUEST_UPDATE (publish ロール) で PROTOCOL_VIOLATION でセッションが閉じる", async () => {
  const ctx = createPublishReadTestContext({});

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  // Request ID の後に Parameters が無い不完全なペイロードを feed する
  const invalidPayload = new Uint8Array([0x01]);
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, invalidPayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // REQUEST_OK / REQUEST_ERROR は応答されず、PROTOCOL_VIOLATION でセッションが閉じる
  assert.equal(ctx.written.length, 0);
  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(ctx.closedWithError!.message.includes("invalid REQUEST_UPDATE payload"));
});

/**
 * draft-ietf-moq-transport-21 §9.5 / §9.20.19:
 * role=publish の受信 REQUEST_UPDATE が正常な場合、FORWARD が publisher の
 * Forward State に反映され REQUEST_OK が応答されることを検証する (回帰
 * ガード)。IncompleteDataError の変換対象追加で既存処理が変わらないことを
 * 担保する。
 */
test("bidiReadRequestStreamMessages: 正常な REQUEST_UPDATE (publish ロール) で FORWARD が反映され REQUEST_OK が応答される", async () => {
  const ctx = createPublishReadTestContext({});

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [{ type: MessageParameterType.FORWARD, value: new Uint8Array([0]) }],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // FORWARD=0 が publisher の Forward State に反映され、REQUEST_OK が応答される
  assert.equal(ctx.publisher.forwardState, false);
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.5 / §9.20.19:
 * role=publish の受信 REQUEST_UPDATE で FORWARD が省略された場合、Forward
 * State は変化しないことを検証する (extractForwardState のデフォルト true に
 * よる上書きを防ぐ)。FORWARD=0 を受けて送信を止めたアプリが、パラメータ無し
 * の REQUEST_UPDATE で送信を再開してしまうケースの回帰ガード。
 */
test("bidiReadRequestStreamMessages: FORWARD 省略の REQUEST_UPDATE (publish ロール) で Forward State は不変", async () => {
  const ctx = createPublishReadTestContext({});
  // FORWARD=0 を受けて送信を止めた状態を作る (アプリ側の反映)
  ctx.publisher.setForwardState(false);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // Forward State は false のまま、REQUEST_OK が応答される
  assert.equal(ctx.publisher.forwardState, false);
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §9.5 / §9.20.19:
 * role=publish の受信 REQUEST_UPDATE で FORWARD=1 が明示された場合、Forward
 * State が true に反映されることを検証する (FORWARD 省略時は不変ではなく
 * 省略以外の本分岐が従来どおり動作することの回帰ガード)。
 */
test("bidiReadRequestStreamMessages: FORWARD=1 の REQUEST_UPDATE (publish ロール) で Forward State が true に反映される", async () => {
  const ctx = createPublishReadTestContext({});
  // FORWARD=0 に変更した状態から、FORWARD=1 の明示で戻ることも検証する
  ctx.publisher.setForwardState(false);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [{ type: MessageParameterType.FORWARD, value: new Uint8Array([1]) }],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // Forward State が true に反映され、REQUEST_OK が応答される
  assert.equal(ctx.publisher.forwardState, true);
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_OK);
  assert.isUndefined(ctx.closedWithError);
});

/**
 * draft-ietf-moq-transport-21 §8.9 / §6.6 / §12.2 / §9.5.1:
 * role=publish の受信 REQUEST_UPDATE が未登録 Alias を参照する場合、
 * Session Termination の UNKNOWN_AUTH_TOKEN_ALIAS (0x17) でセッションを閉じることを
 * 検証する。セッションが閉じるため §9.5 の REQUEST_OK / REQUEST_ERROR と
 * §9.5.1 の PUBLISH_DONE (UPDATE_FAILED) はどちらも送らない。
 */
test("bidiReadRequestStreamMessages: 未登録 Alias の REQUEST_UPDATE (publish ロール) は UNKNOWN_AUTH_TOKEN_ALIAS でセッションを閉じる", async () => {
  const ctx = createPublishReadTestContext({}, 1024);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  const updatePayload = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      {
        type: MessageParameterType.AUTHORIZATION_TOKEN,
        value: encodeAuthorizationToken({
          aliasType: AuthorizationTokenAliasType.USE_ALIAS,
          tokenAlias: 77n,
        }),
      },
    ],
  });
  const message = ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, updatePayload);
  ctx.readableController.enqueue(message);
  ctx.readableController.close();
  await readPromise;

  // セッションを閉じるため REQUEST_OK / REQUEST_ERROR も PUBLISH_DONE も送らない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 0);
  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError.code, SessionErrorCode.UNKNOWN_AUTH_TOKEN_ALIAS);
});

/**
 * draft-ietf-moq-transport-21 §8.9 / §6.6 / §12.2:
 * 同一チャンクに REQUEST_UPDATE が 2 通連結され先頭が未登録 Alias を参照する場合、
 * セッション終了後に残りのメッセージを処理しないことを検証する。処理を続けると
 * 再びセッション終了を検出して error コールバックが二重に通知される。
 */
test("bidiReadRequestStreamMessages: 未登録 Alias で閉じた後は同一チャンクの残り REQUEST_UPDATE を処理しない (publish ロール)", async () => {
  const ctx = createPublishReadTestContext({}, 1024);

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "publish",
  );
  const unknownAliasUpdate = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 101n,
    parameters: [
      {
        type: MessageParameterType.AUTHORIZATION_TOKEN,
        value: encodeAuthorizationToken({
          aliasType: AuthorizationTokenAliasType.USE_ALIAS,
          tokenAlias: 78n,
        }),
      },
    ],
  });
  const trailingUpdate = encodeRequestUpdatePayload({
    type: MessageType.REQUEST_UPDATE,
    requestId: 103n,
    parameters: [
      {
        type: MessageParameterType.AUTHORIZATION_TOKEN,
        value: encodeAuthorizationToken({
          aliasType: AuthorizationTokenAliasType.USE_ALIAS,
          // 2 通目も未登録 Alias にする。処理を続けると closeWithError が 2 回
          // 呼ばれるため、この assert が回帰を直接捕まえる。
          tokenAlias: 79n,
        }),
      },
    ],
  });
  // 2 通を 1 チャンクに連結して enqueue する
  ctx.readableController.enqueue(
    concatUint8Arrays([
      ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, unknownAliasUpdate),
      ctx.session.controlWriter!.encode(MessageType.REQUEST_UPDATE, trailingUpdate),
    ]),
  );
  ctx.readableController.close();
  await readPromise;

  // セッション終了は 1 回だけで、後続の REQUEST_UPDATE は処理されない
  assert.equal(ctx.closedWithErrorCount, 1);
  assert.isDefined(ctx.closedWithError);
  assert.equal(ctx.closedWithError.code, SessionErrorCode.UNKNOWN_AUTH_TOKEN_ALIAS);
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 0);
});
