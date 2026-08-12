/**
 * session/namespaceLoops.ts の単体テスト
 *
 * 実 W3C ストリーム (`ReadableStream`) と実 Map で構成した session に
 * メッセージを注入し、namespace 系ストリームループの REQUEST_UPDATE 応答
 * (REQUEST_OK / REQUEST_ERROR) 処理を検証する。
 *
 * draft-ietf-moq-transport-19 §10.9.2 (Updating Namespace Subscriptions)
 */

import { test, assert } from "vite-plus/test";
import { MessageType, MessageParameterType } from "../message";
import {
  encodeGoawayPayload,
  encodeRequestErrorPayload,
  encodeRequestOkPayload,
} from "../message/session";
import { ControlStreamReader, ControlStreamWriter } from "../controlStream";
import { RequestErrorCode, SessionError, SessionErrorCode } from "../error";
import {
  namespaceStartNamespaceStreamLoop,
  namespaceStartTracksStreamLoop,
} from "./namespaceLoops";
import type { SessionInternal } from "./types";

/**
 * namespace 系ストリームループ用のテストコンテキストを構築する。
 *
 * ストリーム機構は実物 (ReadableStream + WritableStream) であり、テストは
 * readableController.enqueue でメッセージを注入する。
 */
function createNamespaceLoopTestContext(kind: "namespace" | "tracks"): {
  session: SessionInternal;
  requestId: bigint;
  readableController: ReadableStreamDefaultController<Uint8Array>;
  controlWriter: ControlStreamWriter;
  subscription: {
    state: "active" | "closed";
    namespacePrefix: string[];
    pendingPrefix?: string[];
  };
  getClosedWithError: () => SessionError | undefined;
} {
  const requestId = 10n;

  let readableController!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      readableController = controller;
    },
  });
  const streamReader = readable.getReader();
  const controlReader = new ControlStreamReader();

  const subscription = {
    callbacks: {},
    state: "active" as const,
    namespacePrefix: ["live"],
  };

  let closedWithError: SessionError | undefined;
  const session = {
    namespaceSubscriptions: kind === "namespace" ? new Map([[requestId, subscription]]) : new Map(),
    tracksSubscriptions: kind === "tracks" ? new Map([[requestId, subscription]]) : new Map(),
    namespacePublications: new Map(),
    pendingRequestUpdate: new Map(),
    goawayReceivedOnRequestStreams: new Set(),
    callbacks: { debug: undefined },
    closeWithError: (error: SessionError) => {
      closedWithError = error;
    },
    createNamespaceSubscription: () => ({
      get state() {
        return "active";
      },
      unsubscribe: async () => {},
      update: async () => {},
    }),
    createTracksSubscription: () => ({
      get state() {
        return "active";
      },
      unsubscribe: async () => {},
      update: async () => {},
    }),
  } as unknown as SessionInternal;

  // ループは subscription.streamReader / subscription.controlReader を参照する
  Object.assign(subscription, { streamReader, controlReader });

  return {
    session,
    requestId,
    readableController,
    controlWriter: new ControlStreamWriter(),
    subscription,
    getClosedWithError: () => closedWithError,
  };
}

/** REQUEST_OK メッセージのフレームを生成する */
function requestOkMessage(
  controlWriter: ControlStreamWriter,
  trackProperties: { id: bigint; value: bigint }[] = [],
): Uint8Array {
  const payload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties,
  });
  return controlWriter.encode(MessageType.REQUEST_OK, payload);
}

/** パラメータ付き REQUEST_OK メッセージのフレームを生成する */
function requestOkMessageWithParameters(
  controlWriter: ControlStreamWriter,
  parameters: { type: number; value: Uint8Array }[],
): Uint8Array {
  const payload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters,
    trackProperties: [],
  });
  return controlWriter.encode(MessageType.REQUEST_OK, payload);
}

/** REQUEST_ERROR メッセージのフレームを生成する */
function requestErrorMessage(controlWriter: ControlStreamWriter, code: number): Uint8Array {
  const payload = encodeRequestErrorPayload({
    type: MessageType.REQUEST_ERROR,
    errorCode: BigInt(code),
    reasonPhrase: "prefix overlap",
    retryInterval: 0n,
  });
  return controlWriter.encode(MessageType.REQUEST_ERROR, payload);
}

/** 保留中の REQUEST_UPDATE を登録する */
function registerPendingUpdate(
  session: SessionInternal,
  requestId: bigint,
): { resolved: boolean; rejected: Error | undefined } {
  const state = { resolved: false, rejected: undefined as Error | undefined };
  session.pendingRequestUpdate.set(100n, {
    resolve: () => {
      state.resolved = true;
    },
    reject: (err: Error) => {
      state.rejected = err;
    },
    targetRequestId: requestId,
  });
  return state;
}

// ============================================================================
// namespaceStartNamespaceStreamLoop の REQUEST_UPDATE 応答処理
// ============================================================================

test("namespaceStartNamespaceStreamLoop: REQUEST_UPDATE 応答の REQUEST_OK で prefix が更新され pending が解決される", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");

  // 保留中の更新 (新 prefix ["live", "sports"]) を登録する
  const pending = registerPendingUpdate(ctx.session, ctx.requestId);
  ctx.subscription.pendingPrefix = ["live", "sports"];

  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  // 初期 REQUEST_OK (確立応答) を注入する
  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  // REQUEST_UPDATE 応答の REQUEST_OK (更新応答) を注入する
  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  ctx.readableController.close();
  await readPromise;

  // 更新応答の REQUEST_OK で pending が解決され、prefix が反映される
  assert.isTrue(pending.resolved);
  assert.isUndefined(pending.rejected);
  assert.deepEqual(ctx.subscription.namespacePrefix, ["live", "sports"]);
  assert.isUndefined(ctx.subscription.pendingPrefix);
  // セッションは閉じない
  assert.isUndefined(ctx.getClosedWithError());
});

test("namespaceStartNamespaceStreamLoop: REQUEST_UPDATE 応答の REQUEST_ERROR で pending が reject され prefix は更新されない", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");

  const pending = registerPendingUpdate(ctx.session, ctx.requestId);
  ctx.subscription.pendingPrefix = ["live", "sports"];

  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  // PREFIX_OVERLAP で失敗する更新応答を注入する
  ctx.readableController.enqueue(
    requestErrorMessage(ctx.controlWriter, RequestErrorCode.PREFIX_OVERLAP),
  );
  // §10.9.1 により失敗時はピアがストリームを閉じる
  ctx.readableController.close();
  await readPromise;

  assert.isFalse(pending.resolved);
  assert.isDefined(pending.rejected);
  assert.equal(pending.rejected!.message, "prefix overlap");
  // prefix は更新されず、pendingPrefix はクリアされる
  assert.deepEqual(ctx.subscription.namespacePrefix, ["live"]);
  assert.isUndefined(ctx.subscription.pendingPrefix);
  // 更新失敗は PROTOCOL_VIOLATION ではない (セッションは閉じない)
  assert.isUndefined(ctx.getClosedWithError());
});

test("namespaceStartNamespaceStreamLoop: 応答を待たずにストリームが閉じたら pending が reject される", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");

  const pending = registerPendingUpdate(ctx.session, ctx.requestId);
  ctx.subscription.pendingPrefix = ["live", "sports"];

  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  // REQUEST_UPDATE 失敗時にピアがストリームを閉じるケース (§10.9.1) を再現する
  ctx.readableController.close();
  await readPromise;

  assert.isFalse(pending.resolved);
  assert.isDefined(pending.rejected);
  assert.isTrue(
    pending.rejected!.message.includes("stream closed before receiving update response"),
  );
  assert.deepEqual(ctx.subscription.namespacePrefix, ["live"]);
  assert.isUndefined(ctx.subscription.pendingPrefix);
  assert.isUndefined(ctx.getClosedWithError());
});

test("namespaceStartNamespaceStreamLoop: 保留中の更新が無い 2 通目の REQUEST_OK は PROTOCOL_VIOLATION で閉じる", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");

  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  // pending が無い状態で 2 通目の REQUEST_OK (不正)
  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(ctx.getClosedWithError()!.message.includes("received second REQUEST_OK"));
});

test("namespaceStartNamespaceStreamLoop: 保留中の更新が無い REQUEST_ERROR は PROTOCOL_VIOLATION で閉じる", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");

  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  // pending が無い状態の REQUEST_ERROR (不正)
  ctx.readableController.enqueue(
    requestErrorMessage(ctx.controlWriter, RequestErrorCode.PREFIX_OVERLAP),
  );
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(
    ctx.getClosedWithError()!.message.includes("received REQUEST_ERROR after REQUEST_OK"),
  );
});

test("namespaceStartNamespaceStreamLoop: REQUEST_UPDATE 応答の REQUEST_OK でスコープ違反パラメータは PROTOCOL_VIOLATION で閉じる", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");

  const pending = registerPendingUpdate(ctx.session, ctx.requestId);
  ctx.subscription.pendingPrefix = ["live", "sports"];

  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  // FORWARD は REQUEST_UPDATE_OK_ALLOWED_PARAMS (LARGEST_OBJECT / EXPIRES) に含まれない
  ctx.readableController.enqueue(
    requestOkMessageWithParameters(ctx.controlWriter, [
      { type: MessageParameterType.FORWARD, value: new Uint8Array([1]) },
    ]),
  );
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(ctx.getClosedWithError()!.message.includes("not allowed in REQUEST_UPDATE_OK"));
  // スコープ違反時はセッションが閉じられるため、保留中の更新は失敗として
  // reject され (update() のハング防止)、prefix は反映されない
  assert.isFalse(pending.resolved);
  assert.isDefined(pending.rejected);
  assert.isTrue(
    pending.rejected!.message.includes(
      "session closed with PROTOCOL_VIOLATION in REQUEST_UPDATE_OK",
    ),
  );
  assert.deepEqual(ctx.subscription.namespacePrefix, ["live"]);
  assert.isUndefined(ctx.subscription.pendingPrefix);
});

test("namespaceStartNamespaceStreamLoop: REQUEST_UPDATE 応答の REQUEST_OK で Track Properties 非空は PROTOCOL_VIOLATION で閉じる", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");

  const pending = registerPendingUpdate(ctx.session, ctx.requestId);
  ctx.subscription.pendingPrefix = ["live", "sports"];

  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  // §10.5: REQUEST_UPDATE_OK の Track Properties は空でなければならない
  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter, [{ id: 0n, value: 1n }]));
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(
    ctx
      .getClosedWithError()!
      .message.includes("track properties must be empty in REQUEST_UPDATE_OK"),
  );
  // 検証失敗時はセッションが閉じられるため、保留中の更新は失敗として
  // reject され (update() のハング防止)、prefix は反映されない
  assert.isFalse(pending.resolved);
  assert.isDefined(pending.rejected);
  assert.isTrue(
    pending.rejected!.message.includes(
      "session closed with PROTOCOL_VIOLATION in REQUEST_UPDATE_OK",
    ),
  );
  assert.deepEqual(ctx.subscription.namespacePrefix, ["live"]);
  assert.isUndefined(ctx.subscription.pendingPrefix);
});

test("namespaceStartNamespaceStreamLoop: RESET_STREAM (read 例外) でも保留中の更新が reject される", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");

  const pending = registerPendingUpdate(ctx.session, ctx.requestId);
  ctx.subscription.pendingPrefix = ["live", "sports"];

  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  // ピアの RESET_STREAM 相当 (WebTransportError 相当の reason で reject)
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), { source: "stream" }),
  );
  await readPromise;

  assert.isFalse(pending.resolved);
  assert.isDefined(pending.rejected);
  assert.isTrue(
    pending.rejected!.message.includes("stream closed before receiving update response"),
  );
  assert.deepEqual(ctx.subscription.namespacePrefix, ["live"]);
  assert.isUndefined(ctx.subscription.pendingPrefix);
  // RESET_STREAM (read 例外) はセッションを閉じない (PROTOCOL_VIOLATION に昇格しない)
  assert.isUndefined(ctx.getClosedWithError());
});

test("namespaceStartNamespaceStreamLoop: GOAWAY 受信後の REQUEST_ERROR で保留中の更新が reject される", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");

  const pending = registerPendingUpdate(ctx.session, ctx.requestId);
  ctx.subscription.pendingPrefix = ["live", "sports"];

  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  // GOAWAY を受信する (goawayReceived フラグが立つ)
  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "moqt://new.example.com",
    timeout: 0n,
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.GOAWAY, goawayPayload));
  // GOAWAY 後に REQUEST_ERROR が届く (spurious PROTOCOL_VIOLATION は防がれる)
  ctx.readableController.enqueue(
    requestErrorMessage(ctx.controlWriter, RequestErrorCode.PREFIX_OVERLAP),
  );
  ctx.readableController.close();
  await readPromise;

  // GOAWAY 後でも保留中の更新は失敗として reject される
  assert.isFalse(pending.resolved);
  assert.isDefined(pending.rejected);
  assert.equal(pending.rejected!.message, "prefix overlap");
  assert.deepEqual(ctx.subscription.namespacePrefix, ["live"]);
  assert.isUndefined(ctx.subscription.pendingPrefix);
  // GOAWAY 受信後はセッションを閉じない (§10.4)
  assert.isUndefined(ctx.getClosedWithError());
});

// ============================================================================
// namespaceStartTracksStreamLoop の REQUEST_UPDATE 応答処理
// ============================================================================

test("namespaceStartTracksStreamLoop: REQUEST_UPDATE 応答の REQUEST_OK で prefix が更新され pending が解決される", async () => {
  const ctx = createNamespaceLoopTestContext("tracks");

  const pending = registerPendingUpdate(ctx.session, ctx.requestId);
  ctx.subscription.pendingPrefix = ["live", "sports"];

  const readPromise = namespaceStartTracksStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  ctx.readableController.close();
  await readPromise;

  assert.isTrue(pending.resolved);
  assert.isUndefined(pending.rejected);
  // tracksSubscriptions の namespacePrefix は PUBLISH マッチングに使われるため更新される
  assert.deepEqual(ctx.subscription.namespacePrefix, ["live", "sports"]);
  assert.isUndefined(ctx.subscription.pendingPrefix);
  assert.isUndefined(ctx.getClosedWithError());
});

test("namespaceStartTracksStreamLoop: REQUEST_UPDATE 応答の REQUEST_ERROR で pending が reject され prefix は更新されない", async () => {
  const ctx = createNamespaceLoopTestContext("tracks");

  const pending = registerPendingUpdate(ctx.session, ctx.requestId);
  ctx.subscription.pendingPrefix = ["live", "sports"];

  const readPromise = namespaceStartTracksStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  ctx.readableController.enqueue(
    requestErrorMessage(ctx.controlWriter, RequestErrorCode.PREFIX_OVERLAP),
  );
  ctx.readableController.close();
  await readPromise;

  assert.isFalse(pending.resolved);
  assert.isDefined(pending.rejected);
  assert.deepEqual(ctx.subscription.namespacePrefix, ["live"]);
  assert.isUndefined(ctx.subscription.pendingPrefix);
  assert.isUndefined(ctx.getClosedWithError());
});

test("namespaceStartTracksStreamLoop: 応答を待たずにストリームが閉じたら pending が reject される", async () => {
  const ctx = createNamespaceLoopTestContext("tracks");

  const pending = registerPendingUpdate(ctx.session, ctx.requestId);
  ctx.subscription.pendingPrefix = ["live", "sports"];

  const readPromise = namespaceStartTracksStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  // REQUEST_UPDATE 失敗時にピアがストリームを閉じるケース (§10.9.1) を再現する
  ctx.readableController.close();
  await readPromise;

  assert.isFalse(pending.resolved);
  assert.isDefined(pending.rejected);
  assert.isTrue(
    pending.rejected!.message.includes("stream closed before receiving update response"),
  );
  assert.deepEqual(ctx.subscription.namespacePrefix, ["live"]);
  assert.isUndefined(ctx.subscription.pendingPrefix);
  assert.isUndefined(ctx.getClosedWithError());
});

test("namespaceStartTracksStreamLoop: 保留中の更新が無い 2 通目の REQUEST_OK は PROTOCOL_VIOLATION で閉じる", async () => {
  const ctx = createNamespaceLoopTestContext("tracks");

  const readPromise = namespaceStartTracksStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  // pending が無い状態で 2 通目の REQUEST_OK (不正)
  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(ctx.getClosedWithError()!.message.includes("received second REQUEST_OK"));
});

test("namespaceStartTracksStreamLoop: 保留中の更新が無い REQUEST_ERROR は PROTOCOL_VIOLATION で閉じる", async () => {
  const ctx = createNamespaceLoopTestContext("tracks");

  const readPromise = namespaceStartTracksStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  // pending が無い状態の REQUEST_ERROR (不正)
  ctx.readableController.enqueue(
    requestErrorMessage(ctx.controlWriter, RequestErrorCode.PREFIX_OVERLAP),
  );
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(
    ctx.getClosedWithError()!.message.includes("received REQUEST_ERROR after REQUEST_OK"),
  );
});
