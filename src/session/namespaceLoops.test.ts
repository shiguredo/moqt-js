/**
 * session/namespaceLoops.ts の単体テスト
 *
 * 実 W3C ストリーム (`ReadableStream`) と実 Map で構成した session に
 * メッセージを注入し、namespace / tracks / publish namespace の各
 * ストリームループを検証する。対象は REQUEST_UPDATE 応答 (REQUEST_OK /
 * REQUEST_ERROR)、GOAWAY、NAMESPACE / NAMESPACE_DONE / PUBLISH_SKIPPED、
 * および長さ検証後メッセージデコード破損 (IncompleteDataError) 時の
 * PROTOCOL_VIOLATION でセッションが閉じる挙動。
 *
 * draft-ietf-moq-transport-19 §10.4 (GOAWAY) / §10.5 (REQUEST_OK) /
 * §10.9.2 (Updating Namespace Subscriptions) / §10.15 (PUBLISH_NAMESPACE) /
 * §10.16 (NAMESPACE) / §10.17 (NAMESPACE_DONE) / §10.19 (SUBSCRIBE_TRACKS) /
 * §10.20 (PUBLISH_SKIPPED)
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
import { createTrackNamespace } from "../message/parameter";
import {
  encodeNamespaceDonePayload,
  encodeNamespacePayload,
  encodePublishSkippedPayload,
} from "../message/namespace";
import {
  namespaceStartNamespaceStreamLoop,
  namespaceStartPublicationStreamLoop,
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

// ============================================================================
// namespace 系ループ共通: メッセージデコード破損と確立後メッセージのテスト
// draft-ietf-moq-transport-19 §10 (Control Messages) / §10.5 / §10.16-10.20
// ============================================================================

/**
 * draft-ietf-moq-transport-19 §10 / §10.5:
 * ループ内のメッセージデコードが IncompleteDataError (Length が揃った後の
 * フィールド構造の破損) の場合、黙殺されず PROTOCOL_VIOLATION でセッションが
 * 閉じることを検証する。変換は toProtocolViolationSessionError
 * (受信メッセージのデコード失敗は PROTOCOL_VIOLATION として扱うリポジトリ
 * 共通解釈) が行うため、デコーダの短縮ペイロードを feed すればよい。
 */
test("namespaceStartNamespaceStreamLoop: 破損 REQUEST_OK は PROTOCOL_VIOLATION で閉じる", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");

  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  // 不完全なペイロード (Number of Parameters=1 を宣言するが本体が無い) を feed する
  ctx.readableController.enqueue(
    ctx.controlWriter.encode(MessageType.REQUEST_OK, new Uint8Array([0x01])),
  );
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  // IncompleteDataError のメッセージが引き継がれる (デコード破損経由であることの証憑)
  assert.isTrue(ctx.getClosedWithError()!.message.includes("insufficient data"));
  // finally で subscription が掃除される
  assert.isFalse(ctx.session.namespaceSubscriptions.has(ctx.requestId));
});

test("namespaceStartTracksStreamLoop: 破損 REQUEST_OK は PROTOCOL_VIOLATION で閉じる", async () => {
  const ctx = createNamespaceLoopTestContext("tracks");

  const readPromise = namespaceStartTracksStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  // 不完全なペイロード (Number of Parameters=1 を宣言するが本体が無い) を feed する
  ctx.readableController.enqueue(
    ctx.controlWriter.encode(MessageType.REQUEST_OK, new Uint8Array([0x01])),
  );
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(ctx.getClosedWithError()!.message.includes("insufficient data"));
  // finally で subscription が掃除される
  assert.isFalse(ctx.session.tracksSubscriptions.has(ctx.requestId));
});

test("namespaceStartNamespaceStreamLoop: 正常な NAMESPACE / NAMESPACE_DONE でセッションが閉じない", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");
  let resolved = false;
  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {
      resolved = true;
    },
    () => {},
  );

  // 先頭に確立応答の REQUEST_OK、続けて NAMESPACE / NAMESPACE_DONE を feed する
  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  const suffix = createTrackNamespace(["live", "sports"]);
  ctx.readableController.enqueue(
    ctx.controlWriter.encode(
      MessageType.NAMESPACE,
      encodeNamespacePayload({ type: MessageType.NAMESPACE, trackNamespaceSuffix: suffix }),
    ),
  );
  ctx.readableController.enqueue(
    ctx.controlWriter.encode(
      MessageType.NAMESPACE_DONE,
      encodeNamespaceDonePayload({
        type: MessageType.NAMESPACE_DONE,
        trackNamespaceSuffix: suffix,
      }),
    ),
  );
  ctx.readableController.close();
  await readPromise;

  // 確立応答が反映され、正常な NAMESPACE / NAMESPACE_DONE はセッションを
  // 閉じない (回帰ガード)
  assert.isTrue(resolved);
  assert.isUndefined(ctx.getClosedWithError());
});

test("namespaceStartNamespaceStreamLoop: 対応する NAMESPACE に先立つ NAMESPACE_DONE は PROTOCOL_VIOLATION で閉じる", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");

  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  // 先頭に確立応答の REQUEST_OK、続けて NAMESPACE を経ない NAMESPACE_DONE を feed する
  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  ctx.readableController.enqueue(
    ctx.controlWriter.encode(
      MessageType.NAMESPACE_DONE,
      encodeNamespaceDonePayload({
        type: MessageType.NAMESPACE_DONE,
        trackNamespaceSuffix: createTrackNamespace(["live", "sports"]),
      }),
    ),
  );
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(ctx.getClosedWithError()!.message.includes("before corresponding NAMESPACE"));
});

test("namespaceStartTracksStreamLoop: 正常な PUBLISH_SKIPPED でセッションが閉じない", async () => {
  const ctx = createNamespaceLoopTestContext("tracks");
  let resolved = false;
  const readPromise = namespaceStartTracksStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {
      resolved = true;
    },
    () => {},
  );

  // 先頭に確立応答の REQUEST_OK、続けて PUBLISH_SKIPPED を feed する
  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  ctx.readableController.enqueue(
    ctx.controlWriter.encode(
      MessageType.PUBLISH_SKIPPED,
      encodePublishSkippedPayload({
        type: MessageType.PUBLISH_SKIPPED,
        trackNamespaceSuffix: createTrackNamespace(["live", "sports"]),
        trackName: new TextEncoder().encode("track1"),
      }),
    ),
  );
  ctx.readableController.close();
  await readPromise;

  // 確立応答が反映され、正常な PUBLISH_SKIPPED はセッションを閉じない (回帰ガード)
  assert.isTrue(resolved);
  assert.isUndefined(ctx.getClosedWithError());
});

// ============================================================================
// namespaceStartPublicationStreamLoop のテスト
// draft-ietf-moq-transport-19 §10.15 (PUBLISH_NAMESPACE、応答は §10.5 / §10.6)
// ============================================================================

/**
 * namespaceStartPublicationStreamLoop 用のテストコンテキストを構築する。
 *
 * ストリーム機構は実物 (ReadableStream) であり、テストは
 * readableController.enqueue でメッセージを注入する。ループが参照する
 * state / streamReader / controlReader / callbacks を備えた publication と、
 * closeWithError 等の必要なメソッドを持つ session を構築する。
 */
function createPublicationLoopTestContext(): {
  session: SessionInternal;
  requestId: bigint;
  readableController: ReadableStreamDefaultController<Uint8Array>;
  controlWriter: ControlStreamWriter;
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

  const publication = {
    callbacks: {},
    state: "pending" as const,
    streamReader,
    controlReader,
  };

  let closedWithError: SessionError | undefined;
  const session = {
    namespaceSubscriptions: new Map(),
    tracksSubscriptions: new Map(),
    namespacePublications: new Map([[requestId, publication]]),
    pendingRequestUpdate: new Map(),
    goawayReceivedOnRequestStreams: new Set(),
    callbacks: { debug: undefined },
    closeWithError: (error: SessionError) => {
      closedWithError = error;
    },
    createNamespacePublication: () => ({
      get state() {
        return "active";
      },
      unsubscribe: async () => {},
    }),
  } as unknown as SessionInternal;

  return {
    session,
    requestId,
    readableController,
    controlWriter: new ControlStreamWriter(),
    getClosedWithError: () => closedWithError,
  };
}

test("namespaceStartPublicationStreamLoop: 正常な REQUEST_OK で解決されセッションが閉じない", async () => {
  const ctx = createPublicationLoopTestContext();
  let resolved = false;
  const readPromise = namespaceStartPublicationStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {
      resolved = true;
    },
    () => {},
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  ctx.readableController.close();
  await readPromise;

  assert.isTrue(resolved);
  assert.isUndefined(ctx.getClosedWithError());
});

test("namespaceStartPublicationStreamLoop: 破損 REQUEST_OK は PROTOCOL_VIOLATION で閉じる", async () => {
  const ctx = createPublicationLoopTestContext();

  const readPromise = namespaceStartPublicationStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  // 不完全なペイロード (Number of Parameters=1 を宣言するが本体が無い) を feed する
  ctx.readableController.enqueue(
    ctx.controlWriter.encode(MessageType.REQUEST_OK, new Uint8Array([0x01])),
  );
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(ctx.getClosedWithError()!.message.includes("insufficient data"));
  // finally で publication が掃除される
  assert.isFalse(ctx.session.namespacePublications.has(ctx.requestId));
});
