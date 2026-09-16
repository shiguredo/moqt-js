/**
 * session/bidi.ts の単体テスト: 応答スコープ違反で具体エラーが reject される
 *
 * 応答のパラメータスコープ違反で違反 SessionError 自体が reject されることと、
 * 応答の完了処理、bidiSendRequestUpdate の raw パラメータ検証を扱う。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import { TrackPropertyId } from "../properties";
import { type MoqtObject } from "../dataStream";
import { ObjectStatus } from "../message";
import {
  encodeRequestOkPayload,
  encodeRequestErrorPayload,
  encodeGoawayPayload,
} from "../message/session";
import { encodeFetchOkPayload } from "../message/fetch";
import { MessageType, MessageParameterType, GroupOrder } from "../message/types";
import { encodeParameters, encodeRangeFilter, type Parameter } from "../message";
import { decodeRequestUpdatePayload, encodeSubscribeOkPayload } from "../message/subscribe";
import { encodeLocationFilterParameter } from "../message/parameter";
import { SessionError, SessionErrorCode, RequestErrorCode, InvalidFilterError } from "../error";
import {
  createBidiSession,
  buildExceedingLocationFilterValue,
  createOkResponseReadTestContext,
} from "../testSupport/bidi";
import { concatUint8Arrays } from "../testSupport/helpers";
import { encodeVarint, decodeVarint } from "../varint";
import { ControlStreamReader } from "../controlStream";
import { PublisherImpl } from "../publisher";
import { incomingWaitForFetcher } from "./incoming";
import type { SessionInternal } from "./types";
import {
  bidiReadFetchResponse,
  bidiReadPublishResponse,
  bidiReadSubscribeResponse,
  bidiReadTrackStatusResponse,
  bidiSendRequestUpdate,
} from "./bidi";
import { FetcherImpl } from "../fetcher";
import { fullTrackNameKey } from "../fullTrackName";

// ============================================================================
// 応答スコープ違反で具体エラーが reject される
// draft-ietf-moq-transport-21 §9.20.1 (Parameter Scope)
// PUBLISH 応答経路と同一パターン (削除・reject・close の順序と同一オブジェクト)
// ============================================================================

test("bidiReadTrackStatusResponse: REQUEST_OK 受信後に自方向を FIN する", async () => {
  // draft-ietf-moq-transport-21 §9.13 / §6.4.2.2:
  // TRACK_STATUS_OK / REQUEST_ERROR の送受信後に bidi ストリームは FIN で閉じる。
  const ctx = createOkResponseReadTestContext();
  let resolved = false;
  ctx.session.pendingTrackStatus.set(ctx.requestId, {
    // malformed 検出時の cross-cancel 用の比較キー (本テストでは未使用)
    trackKey: fullTrackNameKey(["test"], "track"),
    resolve: () => {
      resolved = true;
    },
    reject: () => {},
  });
  const writer = ctx.session.requestStreams.get(ctx.requestId)?.writer;

  const readPromise = bidiReadTrackStatusResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  const okPayload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [],
  });
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.REQUEST_OK, okPayload),
  );
  await readPromise;

  assert.isTrue(resolved);
  assert.isDefined(writer);
  // writer.close() が呼ばれていれば closed が解決する (未 FIN ならハングする)
  await writer!.closed;
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
});

test("bidiReadTrackStatusResponse: REQUEST_ERROR 受信後に自方向を FIN する", async () => {
  // draft-ietf-moq-transport-21 §9.13 / §6.4.2.2: 失敗応答後も FIN で閉じる。
  const ctx = createOkResponseReadTestContext();
  let rejected: Error | undefined;
  ctx.session.pendingTrackStatus.set(ctx.requestId, {
    // malformed 検出時の cross-cancel 用の比較キー (本テストでは未使用)
    trackKey: fullTrackNameKey(["test"], "track"),
    resolve: () => {},
    reject: (error: Error) => {
      rejected = error;
    },
  });
  const writer = ctx.session.requestStreams.get(ctx.requestId)?.writer;

  const readPromise = bidiReadTrackStatusResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  const errorPayload = encodeRequestErrorPayload({
    type: MessageType.REQUEST_ERROR,
    errorCode: BigInt(RequestErrorCode.DOES_NOT_EXIST),
    retryInterval: 0n,
    reasonPhrase: "not found",
  });
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.REQUEST_ERROR, errorPayload),
  );
  await readPromise;

  assert.isDefined(rejected);
  assert.isDefined(writer);
  await writer!.closed;
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §9 (Message Length) / §8.5 (Reason Phrase):
 * Reason Phrase Length が残りバイトを超える不完全な REQUEST_ERROR を受信した
 * 場合、共通リーダの catch が PROTOCOL_VIOLATION の SessionError に変換し、
 * pending を reject してからセッションを閉じる。TRACK_STATUS の
 * handleRequestError は closeRequestStreamWriter を await する非同期処理の
 * ため、共通リーダが awaiting せずに握り潰さないことを検証する。
 */
test("bidiReadTrackStatusResponse: 不完全な REQUEST_ERROR で PROTOCOL_VIOLATION として閉じる", async () => {
  const ctx = createOkResponseReadTestContext();
  let rejected: Error | undefined;
  ctx.session.pendingTrackStatus.set(ctx.requestId, {
    // malformed 検出時の cross-cancel 用の比較キー (本テストでは未使用)
    trackKey: fullTrackNameKey(["test"], "track"),
    resolve: () => {},
    reject: (error: Error) => {
      rejected = error;
    },
  });

  const readPromise = bidiReadTrackStatusResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  // 正常な REQUEST_ERROR の Reason Phrase の一部を切り詰め、
  // Reason Phrase Length が残りバイトを超える状態を作る
  const errorPayload = encodeRequestErrorPayload({
    type: MessageType.REQUEST_ERROR,
    errorCode: BigInt(RequestErrorCode.DOES_NOT_EXIST),
    retryInterval: 0n,
    reasonPhrase: "not found",
  });
  const truncatedPayload = errorPayload.slice(0, -3);
  ctx.readableController.enqueue(
    ctx.session.controlWriter!.encode(MessageType.REQUEST_ERROR, truncatedPayload),
  );
  await readPromise;

  // 不完全な payload は PROTOCOL_VIOLATION に変換され、同一オブジェクトで
  // reject と close が行われる
  const closedError = ctx.getClosedWithError();
  assert.instanceOf(closedError, SessionError);
  if (closedError === undefined) {
    assert.fail("PROTOCOL_VIOLATION の SessionError を期待したが undefined だった");
  }
  assert.strictEqual(rejected, closedError);
  assert.equal(closedError.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isFalse(ctx.session.pendingTrackStatus.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
});

test("bidiReadPublishResponse: 確立前 GOAWAY 後の 2 通目 GOAWAY で PROTOCOL_VIOLATION で閉じる", async () => {
  // draft-ietf-moq-transport-21 §9.2:
  // 確立前 GOAWAY 後も読み取りを継続し、同一ストリームの 2 通目を検出する。
  const ctx = createOkResponseReadTestContext();
  const publisher = new PublisherImpl(["test"], "track", ctx.requestId, 1n, () => {});
  ctx.session.pendingPublish.set(ctx.requestId, {
    resolve: () => {},
    reject: () => {},
    impl: publisher,
  });

  const readPromise = bidiReadPublishResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "",
    timeout: 0n,
  });
  const goaway = ctx.session.controlWriter!.encode(MessageType.GOAWAY, goawayPayload);
  // 同一チャンクに 2 通連結する
  const concatenated = new Uint8Array(goaway.length * 2);
  concatenated.set(goaway, 0);
  concatenated.set(goaway, goaway.length);
  ctx.readableController.enqueue(concatenated);
  ctx.readableController.close();
  await readPromise;

  const error = ctx.getClosedWithError();
  assert.isDefined(error);
  assert.equal(error!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(error!.message.includes("received duplicate goaway on request stream"));
});

test("bidiReadSubscribeResponse: SUBSCRIBE_OK のスコープ違反で具体エラーが reject される", async () => {
  // 初期応答のパラメータスコープ違反は汎用 close エラーに埋もれさせない
  const ctx = createOkResponseReadTestContext();
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  let rejected: Error | undefined;
  ctx.session.pendingSubscribe.set(ctx.requestId, {
    resolve: () => {},
    reject: (error: Error) => {
      ctx.order.push("reject");
      rejected = error;
    },
    impl: subscriber,
    objectCallback: () => {},
  });
  // 実運用の鍵は更新の Request ID だが、削除対象の確認のため購読 ID で登録する
  ctx.session.fillFetchTargets.set(ctx.requestId, {
    subscriber,
    groupOrder: GroupOrder.ASCENDING,
  });

  const readPromise = bidiReadSubscribeResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  // FORWARD は SUBSCRIBE_OK (EXPIRES / LARGEST_OBJECT のみ許可) のスコープ違反である
  const okPayload = encodeSubscribeOkPayload({
    type: MessageType.SUBSCRIBE_OK,
    trackAlias: 1n,
    parameters: [{ type: MessageParameterType.FORWARD, value: new Uint8Array([1]) }],
    trackProperties: [],
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.SUBSCRIBE_OK, okPayload));
  ctx.readableController.close();
  await readPromise;

  // 具体エラーで reject され、同一オブジェクトで閉じる
  assert.isDefined(rejected);
  assert.isDefined(ctx.getClosedWithError());
  assert.strictEqual(rejected, ctx.getClosedWithError());
  // reject してから閉じる順序である
  assert.deepEqual(ctx.order, ["reject", "close"]);
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(
    ctx.getClosedWithError()!.message.includes("parameter type 0x10 not allowed in SUBSCRIBE_OK"),
  );
  // 削除集合 (pendingSubscribe + requestStreams + fillFetchTargets) が掃除される
  assert.isFalse(ctx.session.pendingSubscribe.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
  assert.isFalse(ctx.session.fillFetchTargets.has(ctx.requestId));
});

test("bidiReadSubscribeResponse: SUBSCRIBE_OK の LARGEST_OBJECT で相対 Location Filter が一度だけ確定する", async () => {
  const ctx = createOkResponseReadTestContext();
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, (object) => {
    delivered.push(object);
  });
  // SUBSCRIBE 送信時: Next Object フィルタ (LARGEST_OBJECT 未受信)
  subscriber.setLocationFilter({ startGroup: 0n, startObject: 0n });
  ctx.session.pendingSubscribe.set(ctx.requestId, {
    resolve: () => {},
    reject: () => {},
    impl: subscriber,
    objectCallback: () => {},
  });

  const readPromise = bidiReadSubscribeResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  // SUBSCRIBE_OK に LARGEST_OBJECT = {7, 2} を載せる
  const okPayload = encodeSubscribeOkPayload({
    type: MessageType.SUBSCRIBE_OK,
    trackAlias: 1n,
    parameters: [
      { type: MessageParameterType.LARGEST_OBJECT, value: new Uint8Array([0x07, 0x02]) },
    ],
    trackProperties: [],
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.SUBSCRIBE_OK, okPayload));
  ctx.readableController.close();
  await readPromise;

  // SUBSCRIBE_OK で開始位置が {7, 3} に確定する
  subscriber.handleObject({
    groupId: 7n,
    objectId: 2n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array(),
  });
  assert.equal(delivered.length, 0);
  subscriber.handleObject({
    groupId: 7n,
    objectId: 3n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array(),
  });
  assert.equal(delivered.length, 1);

  // 以降の LARGEST_OBJECT 更新では開始位置が前進しない
  subscriber.setLargestLocation({ group: 9n, object: 0n });
  subscriber.handleObject({
    groupId: 8n,
    objectId: 0n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array(),
  });
  assert.equal(delivered.length, 2);
  // SUBSCRIBE_OK の正常系でセッションが閉じない
  assert.isUndefined(ctx.getClosedWithError());
});

test("bidiReadFetchResponse: FETCH_OK のスコープ違反で具体エラーが reject される", async () => {
  // 初期応答のパラメータスコープ違反は汎用 close エラーに埋もれさせない
  const ctx = createOkResponseReadTestContext();
  const fetcher = new FetcherImpl(["test"], "track", ctx.requestId, () => {});
  let rejected: Error | undefined;
  ctx.session.pendingFetch.set(ctx.requestId, {
    resolve: () => {},
    reject: (error: Error) => {
      ctx.order.push("reject");
      rejected = error;
    },
    impl: fetcher,
  });

  const readPromise = bidiReadFetchResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  // FORWARD は FETCH_OK (許可なし) のスコープ違反である
  const okPayload = encodeFetchOkPayload({
    type: MessageType.FETCH_OK,
    endOfTrack: false,
    endLocation: { group: 0n, object: 0n },
    parameters: [{ type: MessageParameterType.FORWARD, value: new Uint8Array([1]) }],
    trackProperties: [],
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.FETCH_OK, okPayload));
  ctx.readableController.close();
  await readPromise;

  // 具体エラーで reject され、同一オブジェクトで閉じる
  assert.isDefined(rejected);
  assert.isDefined(ctx.getClosedWithError());
  assert.strictEqual(rejected, ctx.getClosedWithError());
  // reject してから閉じる順序である
  assert.deepEqual(ctx.order, ["reject", "close"]);
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(
    ctx.getClosedWithError()!.message.includes("parameter type 0x10 not allowed in FETCH_OK"),
  );
  // 削除集合 (pendingFetch + requestStreams) が掃除される
  assert.isFalse(ctx.session.pendingFetch.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
});

test("bidiReadTrackStatusResponse: TRACK_STATUS_OK のスコープ違反で具体エラーが reject される", async () => {
  // 初期応答のパラメータスコープ違反は汎用 close エラーに埋もれさせない
  const ctx = createOkResponseReadTestContext();
  let rejected: Error | undefined;
  ctx.session.pendingTrackStatus.set(ctx.requestId, {
    // malformed 検出時の cross-cancel 用の比較キー (本テストでは未使用)
    trackKey: fullTrackNameKey(["test"], "track"),
    resolve: () => {},
    reject: (error: Error) => {
      ctx.order.push("reject");
      rejected = error;
    },
  });

  const readPromise = bidiReadTrackStatusResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  // FORWARD は TRACK_STATUS_OK (LARGEST_OBJECT のみ許可) のスコープ違反である
  const okPayload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [{ type: MessageParameterType.FORWARD, value: new Uint8Array([1]) }],
    trackProperties: [],
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.REQUEST_OK, okPayload));
  ctx.readableController.close();
  await readPromise;

  // 具体エラーで reject され、同一オブジェクトで閉じる
  assert.isDefined(rejected);
  assert.isDefined(ctx.getClosedWithError());
  assert.strictEqual(rejected, ctx.getClosedWithError());
  // reject してから閉じる順序である
  assert.deepEqual(ctx.order, ["reject", "close"]);
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(
    ctx
      .getClosedWithError()!
      .message.includes("parameter type 0x10 not allowed in TRACK_STATUS_OK"),
  );
  // 削除集合 (pendingTrackStatus + requestStreams) が掃除される
  assert.isFalse(ctx.session.pendingTrackStatus.has(ctx.requestId));
  assert.isFalse(ctx.session.requestStreams.has(ctx.requestId));
});

test("bidiReadFetchResponse: FETCH_OK で複数の待機者が全員解決する", async () => {
  // broadcast 側の複製反復により、1 件目の登録解除で 2 件目が欠落しない。
  // 2 件目の timer を長くし、コールバック発火 (即時) と timer 代替 (遅延) を
  // 経過時間で区別する
  const ctx = createOkResponseReadTestContext();
  const fetcher = new FetcherImpl(["test"], "track", ctx.requestId, () => {});
  ctx.session.pendingFetch.set(ctx.requestId, {
    resolve: () => {},
    reject: () => {},
    impl: fetcher,
  });
  const internal = ctx.session as unknown as SessionInternal;
  const first = incomingWaitForFetcher(internal, ctx.requestId, 100);
  const second = incomingWaitForFetcher(internal, ctx.requestId, 1000);

  const readPromise = bidiReadFetchResponse(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
  );
  const okPayload = encodeFetchOkPayload({
    type: MessageType.FETCH_OK,
    endOfTrack: false,
    endLocation: { group: 0n, object: 0n },
    parameters: [],
    trackProperties: [],
  });
  const started = Date.now();
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.FETCH_OK, okPayload));
  ctx.readableController.close();
  await readPromise;

  assert.strictEqual(await first, fetcher);
  assert.strictEqual(await second, fetcher);
  // コールバック発火なら即時解決する (timer 代替なら 1000ms 掛かる)。
  // 閾値 500ms は壁時計依存だが、即時と満了の中間で余裕を持つ
  assert.isBelow(Date.now() - started, 500);
  assert.isFalse(ctx.session.fetcherReadyCallbacks.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §9.20.20:
 * update({ newGroupRequest }) で NEW_GROUP_REQUEST (0x32) が REQUEST_UPDATE に
 * varint 符号化で載ることを検証する。
 */
test("bidiSendRequestUpdate: newGroupRequest が NEW_GROUP_REQUEST としてエンコードされる", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  // §9.20.20 の MUST NOT により DYNAMIC_GROUPS=1 を受けている購読だけが送信できる
  subscriber.setTrackProperties([{ id: TrackPropertyId.DYNAMIC_GROUPS, value: 1n }]);

  const updatePromise = bidiSendRequestUpdate(session, subscriber, {
    newGroupRequest: 42n,
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  assert.equal(messages.length, 1);
  const decoded = decodeRequestUpdatePayload(messages[0].payload);
  const param = decoded.parameters.find((p) => p.type === MessageParameterType.NEW_GROUP_REQUEST);
  assert.isDefined(param);
  assert.equal(decodeVarint(param!.value)[0], 42n);
});

/**
 * draft-ietf-moq-transport-21 §9.20.20:
 * 規定値 0 の NEW_GROUP_REQUEST が varint 単一バイトで載ることを検証する。
 */
test("bidiSendRequestUpdate: newGroupRequest の 0 がエンコードされる", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  // §9.20.20 の MUST NOT により DYNAMIC_GROUPS=1 を受けている購読だけが送信できる
  subscriber.setTrackProperties([{ id: TrackPropertyId.DYNAMIC_GROUPS, value: 1n }]);

  const updatePromise = bidiSendRequestUpdate(session, subscriber, {
    newGroupRequest: 0n,
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  assert.equal(messages.length, 1);
  const decoded = decodeRequestUpdatePayload(messages[0].payload);
  const param = decoded.parameters.find((p) => p.type === MessageParameterType.NEW_GROUP_REQUEST);
  assert.isDefined(param);
  assert.equal(param!.value.length, 1);
  assert.equal(decodeVarint(param!.value)[0], 0n);
});

/**
 * draft-ietf-moq-transport-21 §9.20:
 * raw NEW_GROUP_REQUEST と型付きの併用は送信前に拒否されることを検証する。
 */
test("bidiSendRequestUpdate: raw と型付きの NEW_GROUP_REQUEST 重複は拒否される", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  let thrown: unknown = null;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      parameters: [{ type: MessageParameterType.NEW_GROUP_REQUEST, value: encodeVarint(1n) }],
      newGroupRequest: 2n,
    });
  } catch (error) {
    thrown = error;
  }
  assert.isTrue(thrown instanceof Error);
  assert.match((thrown as Error).message, /duplicate NEW_GROUP_REQUEST/);
  assert.equal(session.pendingRequestUpdate.size, 0);
  assert.equal(written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.20:
 * raw NEW_GROUP_REQUEST 同士の重複も送信前に拒否されることを検証する。
 */
test("bidiSendRequestUpdate: raw の NEW_GROUP_REQUEST 重複は拒否される", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  let thrown: unknown = null;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      parameters: [
        { type: MessageParameterType.NEW_GROUP_REQUEST, value: encodeVarint(1n) },
        { type: MessageParameterType.NEW_GROUP_REQUEST, value: encodeVarint(2n) },
      ],
    });
  } catch (error) {
    thrown = error;
  }
  assert.isTrue(thrown instanceof Error);
  assert.match((thrown as Error).message, /duplicate NEW_GROUP_REQUEST/);
  assert.equal(session.pendingRequestUpdate.size, 0);
  assert.equal(written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.20.20:
 * 負の newGroupRequest は送信前に拒否されることを検証する。
 */
test("bidiSendRequestUpdate: 負の newGroupRequest は送信前に拒否される", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  let thrown: unknown = null;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      newGroupRequest: -1n,
    });
  } catch (error) {
    thrown = error;
  }
  assert.isTrue(thrown instanceof Error);
  assert.match((thrown as Error).message, /must not be negative/);
  assert.equal(session.pendingRequestUpdate.size, 0);
  assert.equal(written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.20 / §9.20.16:
 * raw FILL_PARAMETERS が 2 件の update() は送信前に拒否され、
 * pendingRequestUpdate に entry が残らないことを検証する。
 */
test("bidiSendRequestUpdate: raw FILL_PARAMETERS の重複は送信前に拒否される", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  const normalInner = encodeParameters([
    encodeLocationFilterParameter({ startGroup: 1n, startObject: 2n }),
  ]);

  let thrown: unknown = null;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      parameters: [
        { type: MessageParameterType.FILL_PARAMETERS, value: normalInner },
        { type: MessageParameterType.FILL_PARAMETERS, value: normalInner },
      ],
    });
  } catch (error) {
    thrown = error;
  }
  assert.instanceOf(thrown, InvalidFilterError);
  assert.match((thrown as Error).message, /duplicate FILL_PARAMETERS/);
  assert.equal(session.pendingRequestUpdate.size, 0);
  assert.equal(written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.20 / §9.20.16:
 * 型付き fill と raw FILL_PARAMETERS の併用は送信前に拒否されることを検証する。
 */
test("bidiSendRequestUpdate: 型付き fill と raw FILL_PARAMETERS の併用は送信前に拒否される", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  const normalInner = encodeParameters([
    encodeLocationFilterParameter({ startGroup: 1n, startObject: 2n }),
  ]);

  let thrown: unknown = null;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      fill: {},
      parameters: [{ type: MessageParameterType.FILL_PARAMETERS, value: normalInner }],
    });
  } catch (error) {
    thrown = error;
  }
  assert.instanceOf(thrown, InvalidFilterError);
  assert.match((thrown as Error).message, /duplicate FILL_PARAMETERS/);
  assert.equal(session.pendingRequestUpdate.size, 0);
  assert.equal(session.fillFetchTargets.size, 0);
  assert.equal(written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.20 / §9.20.16:
 * 重複検査は内側デコード検証より先に行われ、二重不正入力では
 * 重複エラーが優先されることを検証する。
 */
test("bidiSendRequestUpdate: 重複と内側不正の二重不正では重複エラーが優先される", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  const exceeding = buildExceedingLocationFilterValue();
  const exceedingInner = encodeParameters([
    { type: MessageParameterType.LOCATION_FILTER, value: exceeding },
  ]);

  let thrown: unknown = null;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      parameters: [
        { type: MessageParameterType.FILL_PARAMETERS, value: exceedingInner },
        { type: MessageParameterType.FILL_PARAMETERS, value: exceedingInner },
      ],
    });
  } catch (error) {
    thrown = error;
  }
  assert.instanceOf(thrown, InvalidFilterError);
  assert.match((thrown as Error).message, /duplicate FILL_PARAMETERS/);
  assert.equal(session.pendingRequestUpdate.size, 0);
  assert.equal(written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §3.4 / §9.20.16:
 * 単一の raw FILL_PARAMETERS の fill 要求が updateRequestId で購読に
 * 関連付けられることを検証する。内側に GROUP_ORDER がなければ
 * 購読の指定を継承する。
 */
test("bidiSendRequestUpdate: 単一 raw FILL は購読に関連付けられる", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  subscriber.setGroupOrder("Descending");
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

  assert.equal(written.length, 1);
  // ワイヤ上の REQUEST_UPDATE と map キーの対応付け (ワイヤ検証の詳細は別テスト)
  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  const decoded = decodeRequestUpdatePayload(messages[0].payload);
  assert.equal(decoded.requestId, 100n);
  assert.isDefined(decoded.parameters.find((p) => p.type === MessageParameterType.FILL_PARAMETERS));
  const target = session.fillFetchTargets.get(100n);
  assert.isDefined(target);
  assert.strictEqual(target!.subscriber, subscriber);
  assert.equal(target!.groupOrder, GroupOrder.DESCENDING);
  // targetRequestId (購読の 0n) には登録しないこと
  assert.isFalse(session.fillFetchTargets.has(0n));
});

/**
 * draft-ietf-moq-transport-21 §3.4 / §9.20.16:
 * raw FILL 内側の GROUP_ORDER が登録に使われることを検証する。
 */
test("bidiSendRequestUpdate: raw FILL 内側の GROUP_ORDER が登録される", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  const innerWithOrder = encodeParameters([
    encodeLocationFilterParameter({ startGroup: 1n, startObject: 2n }),
    { type: MessageParameterType.GROUP_ORDER, value: new Uint8Array([0x02]) },
  ]);

  const updatePromise = bidiSendRequestUpdate(session, subscriber, {
    parameters: [{ type: MessageParameterType.FILL_PARAMETERS, value: innerWithOrder }],
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  const target = session.fillFetchTargets.get(100n);
  assert.isDefined(target);
  assert.equal(target!.groupOrder, GroupOrder.DESCENDING);
  assert.equal(session.fillFetchTargets.size, 1);
  assert.isFalse(session.fillFetchTargets.has(0n));
});

/**
 * draft-ietf-moq-transport-21 §3.4 / §9.20.16:
 * raw FILL 内側の GROUP_ORDER 0x01 は Ascending として登録され、
 * 内側指定が購読指定より優先されることを検証する。
 */
test("bidiSendRequestUpdate: raw FILL 内側の GROUP_ORDER 0x01 は Ascending になる", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  subscriber.setGroupOrder("Descending");
  const innerWithAscending = encodeParameters([
    encodeLocationFilterParameter({ startGroup: 1n, startObject: 2n }),
    { type: MessageParameterType.GROUP_ORDER, value: new Uint8Array([0x01]) },
  ]);

  const updatePromise = bidiSendRequestUpdate(session, subscriber, {
    parameters: [{ type: MessageParameterType.FILL_PARAMETERS, value: innerWithAscending }],
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  const target = session.fillFetchTargets.get(100n);
  assert.isDefined(target);
  assert.equal(target!.groupOrder, GroupOrder.ASCENDING);
  assert.equal(session.fillFetchTargets.size, 1);
  assert.isFalse(session.fillFetchTargets.has(0n));
});

/**
 * draft-ietf-moq-transport-21 §3.4 / §9.20.16:
 * 内側と購読の両方に GROUP_ORDER がなければ Ascending になることを検証する。
 */
test("bidiSendRequestUpdate: GROUP_ORDER 両省略時は Ascending になる", async () => {
  const { session } = createBidiSession();
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

  const target = session.fillFetchTargets.get(100n);
  assert.isDefined(target);
  assert.equal(target!.groupOrder, GroupOrder.ASCENDING);
  assert.equal(session.fillFetchTargets.size, 1);
  assert.isFalse(session.fillFetchTargets.has(0n));
});

/**
 * draft-ietf-moq-transport-21 §3.4:
 * FILL なしの update() では関連付けが登録されないことを検証する。
 */
test("bidiSendRequestUpdate: FILL なしでは関連付けを登録しない", async () => {
  const { session } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  const updatePromise = bidiSendRequestUpdate(session, subscriber, {});
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  assert.equal(session.fillFetchTargets.size, 0);
});

/**
 * raw FILL 内側の Range Filter を手組みするテスト用ヘルパー
 */
function buildRawFillWithRanges(ranges: { start: bigint; end: bigint }[]): Parameter {
  const inner = encodeParameters([
    {
      type: MessageParameterType.SUBGROUP_FILTER,
      value: encodeRangeFilter({ type: "subgroup", setId: 0, ranges }),
    },
  ]);
  return { type: MessageParameterType.FILL_PARAMETERS, value: inner };
}

/**
 * draft-ietf-moq-transport-21 §9.1.6:
 * raw FILL 内側 Range が上限検証に含まれ、超過時は送信前に
 * throw することを検証する。
 */
test("bidiSendRequestUpdate: raw FILL 内側 Range の上限超過は throw する", async () => {
  // createBidiSession の peerMaxFilterRanges は 2 のため、3 Ranges で超過する
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      parameters: [
        buildRawFillWithRanges([
          { start: 0n, end: 1n },
          { start: 3n, end: 4n },
          { start: 5n, end: 6n },
        ]),
      ],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("exceeds peer MAX_FILTER_RANGES 2"));
  assert.equal(session.pendingRequestUpdate.size, 0);
  assert.equal(session.fillFetchTargets.size, 0);
  assert.equal(written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.1.6:
 * in-flight 中の raw FILL 内側 Range も上限合算に含めることを検証する。
 */
test("bidiSendRequestUpdate: in-flight の raw FILL と合計で上限超過の場合は throw する", async () => {
  // createBidiSession の peerMaxFilterRanges は 2 のため、2 + 1 で超過する
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  // 1 件目の raw FILL 更新を in-flight のまま残す (2 Ranges)
  const firstPromise = bidiSendRequestUpdate(session, subscriber, {
    parameters: [
      buildRawFillWithRanges([
        { start: 0n, end: 1n },
        { start: 3n, end: 4n },
      ]),
    ],
  });
  firstPromise.catch(() => {});

  // 2 件目の型付き fill 更新 (1 Range) は合計 3 で上限 2 を超えるため throw する
  const writtenBefore = written.length;
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
  // 1 件目の関連付けは残り、2 件目は登録・送信されない
  assert.equal(session.fillFetchTargets.size, 1);
  assert.equal(session.pendingRequestUpdate.size, 1);
  assert.equal(written.length, writtenBefore);

  // 1 件目は未解決のまま残す (テスト終了時に破棄される。
  // 既存の型付き in-flight テストは resolve するが、こちらは残留検証のため残す)
  await Promise.resolve();
});

/**
 * draft-ietf-moq-transport-21 §9.1.6:
 * 上限以内の raw FILL 内側 Range は送信できることを検証する。
 */
test("bidiSendRequestUpdate: 上限以内の raw FILL 内側 Range は送信できる", async () => {
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  const updatePromise = bidiSendRequestUpdate(session, subscriber, {
    parameters: [buildRawFillWithRanges([{ start: 0n, end: 1n }])],
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  assert.equal(written.length, 1);
  assert.equal(session.fillFetchTargets.size, 1);
});

/**
 * draft-ietf-moq-transport-21 §9.1.6:
 * 複数種別の内側 Range Filter も合算されることを検証する。
 */
test("bidiSendRequestUpdate: 複数種別の raw FILL 内側 Range も合算される", async () => {
  // SUBGROUP 2 件 + PRIORITY 1 件で合計 3 となり上限 2 を超える
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});
  const inner = encodeParameters([
    {
      type: MessageParameterType.SUBGROUP_FILTER,
      value: encodeRangeFilter({
        type: "subgroup",
        setId: 0,
        ranges: [
          { start: 0n, end: 1n },
          { start: 3n, end: 4n },
        ],
      }),
    },
    {
      type: MessageParameterType.PRIORITY_FILTER,
      value: encodeRangeFilter({ type: "priority", setId: 0, ranges: [{ start: 0n, end: 1n }] }),
    },
  ]);

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      parameters: [{ type: MessageParameterType.FILL_PARAMETERS, value: inner }],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("exceeds peer MAX_FILTER_RANGES 2"));
  assert.equal(session.pendingRequestUpdate.size, 0);
  assert.equal(session.fillFetchTargets.size, 0);
  assert.equal(written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.1.6:
 * 外側 Range と raw FILL 内側 Range の同一メッセージ合算で
 * 上限超過の場合は throw することを検証する。
 */
test("bidiSendRequestUpdate: 外側と raw FILL 内側の合算で上限超過の場合は throw する", async () => {
  // createBidiSession の peerMaxFilterRanges は 2 のため、外側 1 + 内側 2 で超過する
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      rangeFilters: [{ type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 1n }] }],
      parameters: [
        buildRawFillWithRanges([
          { start: 2n, end: 3n },
          { start: 4n, end: 5n },
        ]),
      ],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("exceeds peer MAX_FILTER_RANGES 2"));
  assert.equal(session.pendingRequestUpdate.size, 0);
  assert.equal(session.fillFetchTargets.size, 0);
  assert.equal(written.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.1.6:
 * in-flight 中の型付き fill と新規 raw FILL の合計で上限超過の場合は
 * throw することを検証する (逆方向の合算)。
 */
test("bidiSendRequestUpdate: in-flight の型付き fill と raw 新規の合計超過は throw する", async () => {
  // createBidiSession の peerMaxFilterRanges は 2 のため、2 + 1 で超過する
  const { session, written } = createBidiSession();
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 0n, () => {});

  // 1 件目の型付き fill 更新を in-flight のまま残す (2 Ranges)
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

  // 2 件目の raw FILL 更新 (1 Range) は合計 3 で上限 2 を超えるため throw する
  const writtenBefore = written.length;
  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(session, subscriber, {
      parameters: [buildRawFillWithRanges([{ start: 5n, end: 6n }])],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("exceeds peer MAX_FILTER_RANGES 2"));
  assert.equal(session.fillFetchTargets.size, 1);
  assert.equal(session.pendingRequestUpdate.size, 1);
  assert.equal(written.length, writtenBefore);

  // 1 件目は未解決のまま残す (テスト終了時に破棄される。
  // 既存の型付き in-flight テストは resolve するが、こちらは残留検証のため残す)
  await Promise.resolve();
});
