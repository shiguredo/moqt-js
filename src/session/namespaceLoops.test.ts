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
 * draft-ietf-moq-transport-21 §9.2 (GOAWAY) / §9.3 (REQUEST_OK) /
 * §9.5.2 (Updating Namespace Subscriptions) / §9.14 (PUBLISH_NAMESPACE) /
 * §9.16 (NAMESPACE) / §9.17 (NAMESPACE_DONE) / §9.18 (SUBSCRIBE_TRACKS) /
 * §9.19 (PUBLISH_SKIPPED)
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
    callbacks: Record<string, unknown>;
    writer: WritableStreamDefaultWriter<Uint8Array>;
  };
  writerClosed: () => Promise<void>;
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

  // 実 WritableStream を writer として注入し、GOAWAY 受信時の writer.close() を
  // ストリームの closed Promise で検証できるようにする。
  const writable = new WritableStream<Uint8Array>();
  const writer = writable.getWriter();

  const subscription = {
    callbacks: {},
    state: "active" as const,
    namespacePrefix: ["live"],
    writer,
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
      // 本番の SessionImpl.closeWithError は close() 内で保留中の更新を
      // 汎用エラーで reject する。テストでも同じ順序を再現する。
      for (const pendingUpdate of session.pendingRequestUpdate.values()) {
        pendingUpdate.reject(new Error("session closed"));
      }
      session.pendingRequestUpdate.clear();
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
    writerClosed: () => writer.closed,
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

/**
 * payload 末尾に malformed な Track Properties を連結する
 *
 * draft-ietf-moq-transport-21 §8.3:
 * "If a receiver understands a Type, and the following Value or Length/Value
 *  does not match the serialization defined by that Type, the receiver MUST
 *  close the session with error code KEY_VALUE_FORMATTING_ERROR."
 * 既知偶数 Type (OBJECT_DELIVERY_TIMEOUT 0x02) の Value を 2 バイト varint の
 * 先頭 1 バイト (0x80) だけで終端し、varint がバッファ内で完結しない状態を作る。
 * Track Properties はメッセージ payload の末尾を占めるため、正常な
 * エンコード結果への連結で malformed な受信メッセージを再現できる。
 */
function appendMalformedTrackProperties(payload: Uint8Array): Uint8Array {
  const malformed = new Uint8Array([0x02, 0x80]);
  const result = new Uint8Array(payload.length + malformed.length);
  result.set(payload, 0);
  result.set(malformed, payload.length);
  return result;
}

/**
 * draft-ietf-moq-transport-21 §9.4.1:
 * namespace 系リクエスト (SUBSCRIBE_NAMESPACE / PUBLISH_NAMESPACE /
 * SUBSCRIBE_TRACKS) への Redirect で Track Name が非空なら
 * PROTOCOL_VIOLATION でセッションを閉じる。
 */
test("namespaceStartNamespaceStreamLoop: 非空 Track Name の Redirect は PROTOCOL_VIOLATION", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");
  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  const payload = encodeRequestErrorPayload({
    type: MessageType.REQUEST_ERROR,
    errorCode: BigInt(RequestErrorCode.REDIRECT),
    reasonPhrase: "redirect",
    retryInterval: 0n,
    redirect: {
      connectUri: "https://example.com",
      trackNamespace: createTrackNamespace(["live"]),
      trackName: new TextEncoder().encode("video"),
    },
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.REQUEST_ERROR, payload));
  ctx.readableController.close();
  await readPromise;

  assert.equal(ctx.getClosedWithError()?.code, SessionErrorCode.PROTOCOL_VIOLATION);
});

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
  // §9.5.1 により失敗時はピアがストリームを閉じる
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
  // REQUEST_UPDATE 失敗時にピアがストリームを閉じるケース (§9.5.1) を再現する
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

test("namespaceStartNamespaceStreamLoop: REQUEST_UPDATE 応答のスコープ違反で保留中の更新が違反 SessionError 自体で reject される", async () => {
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
  // スコープ違反時は保留中の更新が違反 SessionError 自体で reject され
  // (update() のハング防止)、prefix は反映されない
  assert.isFalse(pending.resolved);
  assert.strictEqual(pending.rejected, ctx.getClosedWithError());
  assert.deepEqual(ctx.subscription.namespacePrefix, ["live"]);
  assert.isUndefined(ctx.subscription.pendingPrefix);
});

test("namespaceStartNamespaceStreamLoop: REQUEST_UPDATE 応答の Track Properties 非空で保留中の更新が違反 SessionError 自体で reject される", async () => {
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
  // §9.3: REQUEST_UPDATE_OK の Track Properties は空でなければならない
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
  // 検証失敗時は保留中の更新が違反 SessionError 自体で reject され
  // (update() のハング防止)、prefix は反映されない
  assert.isFalse(pending.resolved);
  assert.strictEqual(pending.rejected, ctx.getClosedWithError());
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
  // GOAWAY 受信後はセッションを閉じない (§9.2)
  assert.isUndefined(ctx.getClosedWithError());
});

test("namespaceStartNamespaceStreamLoop: 先頭 GOAWAY (resolved=false) で callbacks.goaway 通知 + Promise reject + セッション継続", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");
  const notifiedUris: string[] = [];
  let errorFired = false;
  Object.assign(ctx.subscription.callbacks, {
    goaway: (uri: string) => {
      notifiedUris.push(uri);
    },
    error: () => {
      errorFired = true;
    },
  });

  let rejectedError: Error | undefined;
  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    (err) => {
      rejectedError = err;
    },
  );

  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "moqt://new.example.com",
    timeout: 0n,
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.GOAWAY, goawayPayload));
  // draft-ietf-moq-transport-21 §9.2:
  // 確立前 GOAWAY 後も読み取りを継続する (2 通目 GOAWAY 検出のため)。
  // ピアの FIN でループが終了する。
  ctx.readableController.close();
  await readPromise;

  assert.deepEqual(notifiedUris, ["moqt://new.example.com"]);
  assert.isDefined(rejectedError);
  assert.equal(rejectedError!.message, "request stream goaway: moqt://new.example.com");
  assert.isUndefined(ctx.getClosedWithError());
  // resolved=false 経路は catch 節に到達しないため callbacks.error は発火しない
  assert.isFalse(errorFired);
  // finally 経路で subscription が closed に遷移していること
  assert.equal(ctx.subscription.state, "closed");
  // 初回 GOAWAY は goawayReceivedOnRequestStreams に追加される (重複検出用)
  assert.isTrue(ctx.session.goawayReceivedOnRequestStreams.has(ctx.requestId));
});

test("namespaceStartNamespaceStreamLoop: 先頭 GOAWAY で New Session URI が空文字の場合は fallback 文言で reject", async () => {
  // draft-ietf-moq-transport-21 §9.2: "If the URI is zero bytes long, the current URI is reused instead"
  // クライアントからサーバへの GOAWAY は必ず空 URI (「A client MUST send a zero-length New Session URI」)
  const ctx = createNamespaceLoopTestContext("namespace");
  const notifiedUris: string[] = [];
  Object.assign(ctx.subscription.callbacks, {
    goaway: (uri: string) => {
      notifiedUris.push(uri);
    },
  });

  let rejectedError: Error | undefined;
  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    (err) => {
      rejectedError = err;
    },
  );

  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "",
    timeout: 0n,
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.GOAWAY, goawayPayload));
  // 確立前 GOAWAY 後も読み取りを継続するため、ピアの FIN で終了させる。
  ctx.readableController.close();
  await readPromise;

  assert.deepEqual(notifiedUris, [""]);
  assert.isDefined(rejectedError);
  assert.equal(rejectedError!.message, "request stream goaway: no redirect URI");
});

test("namespaceStartNamespaceStreamLoop: 確立後 (resolved=true) の GOAWAY で送信方向が FIN (writer.close()) され、読み取り継続 (2 通目 GOAWAY 検出) が維持される", async () => {
  // draft-ietf-moq-transport-21 §9.2:
  // 「the endpoint SHOULD ... close the old request stream using the appropriate mechanism
  //  (e.g. FIN, stream reset, or PUBLISH_DONE)」に従い、送信方向を FIN で閉じる。
  // 受信方向は読み取り継続し 2 通目 GOAWAY は PROTOCOL_VIOLATION として検出する。
  const ctx = createNamespaceLoopTestContext("namespace");
  const notifiedUris: string[] = [];
  Object.assign(ctx.subscription.callbacks, {
    goaway: (uri: string) => {
      notifiedUris.push(uri);
    },
  });

  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  // 確立の REQUEST_OK を先に注入する (resolved=true 状態にする)
  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  // その後 GOAWAY を注入する
  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "moqt://new.example.com",
    timeout: 0n,
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.GOAWAY, goawayPayload));
  // 送信方向 FIN の到達を writer.closed で確認する
  await ctx.writerClosed();
  // 2 通目 GOAWAY を注入すると PROTOCOL_VIOLATION でセッションが閉じる (読み取り継続の証)
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.GOAWAY, goawayPayload));
  ctx.readableController.close();
  await readPromise;

  assert.deepEqual(notifiedUris, ["moqt://new.example.com"]);
  // 2 通目 GOAWAY 検出でセッションが閉じる (§9.2 MUST)
  const err = ctx.getClosedWithError();
  assert.isDefined(err);
  assert.equal(err!.code, SessionErrorCode.PROTOCOL_VIOLATION);
});

test("namespaceStartNamespaceStreamLoop: ピア FIN で active namespace に NAMESPACE_DONE を補完し自方向も FIN する", async () => {
  // draft-ietf-moq-transport-21 §9.15:
  // FIN / RESET 受信時は各 active namespace に NAMESPACE_DONE を補完したものと扱う。
  // §6.4.2.2: ピアの FIN 後、requester は自方向も FIN で閉じる (SHOULD)。
  const ctx = createNamespaceLoopTestContext("namespace");
  const doneSuffixes: string[][] = [];
  Object.assign(ctx.subscription.callbacks, {
    onNamespaceDone: (suffix: string[]) => {
      doneSuffixes.push(suffix);
    },
  });

  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  ctx.readableController.enqueue(
    ctx.controlWriter.encode(
      MessageType.NAMESPACE,
      encodeNamespacePayload({
        type: MessageType.NAMESPACE,
        trackNamespaceSuffix: createTrackNamespace(["sports"]),
      }),
    ),
  );
  ctx.readableController.close();
  await ctx.writerClosed();
  await readPromise;

  assert.deepEqual(doneSuffixes, [["sports"]]);
  assert.isUndefined(ctx.getClosedWithError());
});

test("namespaceStartNamespaceStreamLoop: RESET_STREAM でも active namespace に NAMESPACE_DONE を補完する", async () => {
  // draft-ietf-moq-transport-21 §9.15: stream reset も FIN と同様に扱う。
  const ctx = createNamespaceLoopTestContext("namespace");
  const doneSuffixes: string[][] = [];
  Object.assign(ctx.subscription.callbacks, {
    onNamespaceDone: (suffix: string[]) => {
      doneSuffixes.push(suffix);
    },
  });

  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  ctx.readableController.enqueue(
    ctx.controlWriter.encode(
      MessageType.NAMESPACE,
      encodeNamespacePayload({
        type: MessageType.NAMESPACE,
        trackNamespaceSuffix: createTrackNamespace(["sports"]),
      }),
    ),
  );
  // キュー済みメッセージが処理されてから RESET を注入する
  // (controller.error() は未読チャンクを破棄するため)
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  // ピアの RESET_STREAM 相当 (WebTransportError 相当の reason で reject)
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), { source: "stream" }),
  );
  await readPromise;

  assert.deepEqual(doneSuffixes, [["sports"]]);
  assert.isUndefined(ctx.getClosedWithError());
});

test("namespaceStartNamespaceStreamLoop: NAMESPACE_DONE 済みの namespace は FIN で重複補完しない", async () => {
  // draft-ietf-moq-transport-21 §9.15:
  // 既に NAMESPACE_DONE を受けた namespace は active ではないため補完しない。
  const ctx = createNamespaceLoopTestContext("namespace");
  const doneSuffixes: string[][] = [];
  Object.assign(ctx.subscription.callbacks, {
    onNamespaceDone: (suffix: string[]) => {
      doneSuffixes.push(suffix);
    },
  });

  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  ctx.readableController.enqueue(
    ctx.controlWriter.encode(
      MessageType.NAMESPACE,
      encodeNamespacePayload({
        type: MessageType.NAMESPACE,
        trackNamespaceSuffix: createTrackNamespace(["sports"]),
      }),
    ),
  );
  ctx.readableController.enqueue(
    ctx.controlWriter.encode(
      MessageType.NAMESPACE_DONE,
      encodeNamespaceDonePayload({
        type: MessageType.NAMESPACE_DONE,
        trackNamespaceSuffix: createTrackNamespace(["sports"]),
      }),
    ),
  );
  ctx.readableController.close();
  await readPromise;

  // 明示的な NAMESPACE_DONE の 1 回だけ
  assert.deepEqual(doneSuffixes, [["sports"]]);
});

test("namespaceStartNamespaceStreamLoop: 確立前 GOAWAY 後の 2 通目 GOAWAY で PROTOCOL_VIOLATION で閉じる", async () => {
  // draft-ietf-moq-transport-21 §9.2:
  // "The endpoint MUST close the session with a PROTOCOL_VIOLATION ... if it
  //  receives more than one GOAWAY ... on a single request stream."
  // 確立前 GOAWAY 後も読み取りを継続し、同一チャンクの 2 通目を検出する。
  const ctx = createNamespaceLoopTestContext("namespace");

  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "",
    timeout: 0n,
  });
  const goaway = ctx.controlWriter.encode(MessageType.GOAWAY, goawayPayload);
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

test("namespaceStartNamespaceStreamLoop: 先頭に想定外メッセージ (NAMESPACE) は PROTOCOL_VIOLATION で閉じ、エラー文言に GOAWAY を含む", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");

  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  // 先頭に NAMESPACE (REQUEST_OK / REQUEST_ERROR / GOAWAY 以外) を注入する
  const namespacePayload = encodeNamespacePayload({
    type: MessageType.NAMESPACE,
    trackNamespaceSuffix: createTrackNamespace(["sports"]),
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.NAMESPACE, namespacePayload));
  ctx.readableController.close();
  await readPromise;

  const err = ctx.getClosedWithError();
  assert.isDefined(err);
  assert.equal(err!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.include(err!.message, "REQUEST_OK, REQUEST_ERROR, or GOAWAY");
  assert.include(err!.message, "namespace stream");
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
  // REQUEST_UPDATE 失敗時にピアがストリームを閉じるケース (§9.5.1) を再現する
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

test("namespaceStartTracksStreamLoop: 先頭 GOAWAY (resolved=false) で callbacks.goaway 通知 + Promise reject + セッション継続", async () => {
  const ctx = createNamespaceLoopTestContext("tracks");
  const notifiedUris: string[] = [];
  let errorFired = false;
  Object.assign(ctx.subscription.callbacks, {
    goaway: (uri: string) => {
      notifiedUris.push(uri);
    },
    error: () => {
      errorFired = true;
    },
  });

  let rejectedError: Error | undefined;
  const readPromise = namespaceStartTracksStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    (err) => {
      rejectedError = err;
    },
  );

  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "moqt://new.example.com",
    timeout: 0n,
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.GOAWAY, goawayPayload));
  // 確立前 GOAWAY 後も読み取りを継続するため、ピアの FIN で終了させる。
  ctx.readableController.close();
  await readPromise;

  assert.deepEqual(notifiedUris, ["moqt://new.example.com"]);
  assert.isDefined(rejectedError);
  assert.equal(rejectedError!.message, "request stream goaway: moqt://new.example.com");
  assert.isUndefined(ctx.getClosedWithError());
  assert.isFalse(errorFired);
  assert.equal(ctx.subscription.state, "closed");
  assert.isTrue(ctx.session.goawayReceivedOnRequestStreams.has(ctx.requestId));
});

test("namespaceStartTracksStreamLoop: ピア FIN で自方向を FIN する", async () => {
  // draft-ietf-moq-transport-21 §6.4.2.2:
  // ピアの FIN 後、requester は自方向も FIN で閉じる (SHOULD)。
  const ctx = createNamespaceLoopTestContext("tracks");

  const readPromise = namespaceStartTracksStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  ctx.readableController.close();
  await ctx.writerClosed();
  await readPromise;

  assert.isUndefined(ctx.getClosedWithError());
});

test("namespaceStartTracksStreamLoop: 確立前 GOAWAY 後の 2 通目 GOAWAY で PROTOCOL_VIOLATION で閉じる", async () => {
  // draft-ietf-moq-transport-21 §9.2: 同一リクエストストリームの重複 GOAWAY は違反。
  const ctx = createNamespaceLoopTestContext("tracks");

  const readPromise = namespaceStartTracksStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "",
    timeout: 0n,
  });
  const goaway = ctx.controlWriter.encode(MessageType.GOAWAY, goawayPayload);
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

test("namespaceStartTracksStreamLoop: 先頭に想定外メッセージ (PUBLISH_SKIPPED) は PROTOCOL_VIOLATION で閉じ、エラー文言に GOAWAY を含む", async () => {
  const ctx = createNamespaceLoopTestContext("tracks");

  const readPromise = namespaceStartTracksStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  const skippedPayload = encodePublishSkippedPayload({
    type: MessageType.PUBLISH_SKIPPED,
    trackNamespaceSuffix: createTrackNamespace(["sports"]),
    trackName: new TextEncoder().encode("game"),
  });
  ctx.readableController.enqueue(
    ctx.controlWriter.encode(MessageType.PUBLISH_SKIPPED, skippedPayload),
  );
  ctx.readableController.close();
  await readPromise;

  const err = ctx.getClosedWithError();
  assert.isDefined(err);
  assert.equal(err!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.include(err!.message, "REQUEST_OK, REQUEST_ERROR, or GOAWAY");
  assert.include(err!.message, "tracks stream");
});

/**
 * onPublishSkipped の throw を握り潰し、購読 (ループ) を継続することを検証する。
 * throw の後に届く PUBLISH_SKIPPED が処理されることを観測する。
 */
test("namespaceStartTracksStreamLoop: onPublishSkipped の throw で購読が終了しない", async () => {
  const ctx = createNamespaceLoopTestContext("tracks");
  let skippedCalls = 0;
  ctx.subscription.callbacks.onPublishSkipped = () => {
    skippedCalls++;
    throw new Error("app onPublishSkipped failure");
  };

  const readPromise = namespaceStartTracksStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  const skippedMessage = (): Uint8Array =>
    ctx.controlWriter.encode(
      MessageType.PUBLISH_SKIPPED,
      encodePublishSkippedPayload({
        type: MessageType.PUBLISH_SKIPPED,
        trackNamespaceSuffix: createTrackNamespace(["sports"]),
        trackName: new TextEncoder().encode("game"),
      }),
    );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  ctx.readableController.enqueue(skippedMessage());
  ctx.readableController.enqueue(skippedMessage());
  ctx.readableController.close();
  await readPromise;

  // 2 件目の PUBLISH_SKIPPED も処理されており、throw でループが終了していない
  assert.equal(skippedCalls, 2);
  assert.isUndefined(ctx.getClosedWithError());
});

test("namespaceStartTracksStreamLoop: 確立後 (resolved=true) の GOAWAY で送信方向が FIN (writer.close()) され、読み取り継続が維持される", async () => {
  // draft-ietf-moq-transport-21 §9.2:
  // 送信方向は FIN で閉じる。受信方向は読み取り継続して 2 通目 GOAWAY を検出する。
  const ctx = createNamespaceLoopTestContext("tracks");
  const notifiedUris: string[] = [];
  Object.assign(ctx.subscription.callbacks, {
    goaway: (uri: string) => {
      notifiedUris.push(uri);
    },
  });

  const readPromise = namespaceStartTracksStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "moqt://new.example.com",
    timeout: 0n,
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.GOAWAY, goawayPayload));
  await ctx.writerClosed();
  // 2 通目 GOAWAY を注入するとセッションが PROTOCOL_VIOLATION で閉じる (読み取り継続の証)
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.GOAWAY, goawayPayload));
  ctx.readableController.close();
  await readPromise;

  assert.deepEqual(notifiedUris, ["moqt://new.example.com"]);
  const err2 = ctx.getClosedWithError();
  assert.isDefined(err2);
  assert.equal(err2!.code, SessionErrorCode.PROTOCOL_VIOLATION);
});

// ============================================================================
// namespace 系ループ共通: メッセージデコード破損と確立後メッセージのテスト
// draft-ietf-moq-transport-21 §9 (Control Messages) / §9.3 / §9.15-9.19
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9 / §9.3:
 * ループ内のメッセージデコードが IncompleteDataError (Length が揃った後の
 * フィールド構造の破損) の場合、黙殺されず PROTOCOL_VIOLATION でセッションが
 * 閉じることを検証する。変換は toSessionCloseError
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

/**
 * onNamespace の throw を握り潰し、購読 (ループ) を継続することを検証する。
 *
 * createNamespaceActiveTracker.emitAll / namespaceNotifyError と同じ
 * 「アプリのコールバック例外で後始末を止めない」方針。後続の NAMESPACE が
 * 処理されることでループが終了していないことを観測する。
 */
test("namespaceStartNamespaceStreamLoop: onNamespace の throw で購読が終了しない", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");
  let namespaceCalls = 0;
  ctx.subscription.callbacks.onNamespace = () => {
    namespaceCalls++;
    throw new Error("app onNamespace failure");
  };

  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  const suffix = createTrackNamespace(["live", "sports"]);
  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  ctx.readableController.enqueue(
    ctx.controlWriter.encode(
      MessageType.NAMESPACE,
      encodeNamespacePayload({ type: MessageType.NAMESPACE, trackNamespaceSuffix: suffix }),
    ),
  );
  ctx.readableController.enqueue(
    ctx.controlWriter.encode(
      MessageType.NAMESPACE,
      encodeNamespacePayload({ type: MessageType.NAMESPACE, trackNamespaceSuffix: suffix }),
    ),
  );
  ctx.readableController.close();
  await readPromise;

  // 2 件目の NAMESPACE も処理されており、throw でループが終了していない
  assert.equal(namespaceCalls, 2);
  assert.isUndefined(ctx.getClosedWithError());
});

/**
 * onNamespaceDone の throw を握り潰し、購読 (ループ) を継続することを検証する。
 * throw の後に届く NAMESPACE が処理されることを観測する。
 */
test("namespaceStartNamespaceStreamLoop: onNamespaceDone の throw で購読が終了しない", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");
  let namespaceCalls = 0;
  let namespaceDoneCalls = 0;
  ctx.subscription.callbacks.onNamespace = () => {
    namespaceCalls++;
  };
  ctx.subscription.callbacks.onNamespaceDone = () => {
    namespaceDoneCalls++;
    throw new Error("app onNamespaceDone failure");
  };

  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  const suffix = createTrackNamespace(["live", "sports"]);
  const nextSuffix = createTrackNamespace(["live", "news"]);
  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
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
  // NAMESPACE_DONE の throw 後も次の NAMESPACE を処理する
  ctx.readableController.enqueue(
    ctx.controlWriter.encode(
      MessageType.NAMESPACE,
      encodeNamespacePayload({ type: MessageType.NAMESPACE, trackNamespaceSuffix: nextSuffix }),
    ),
  );
  ctx.readableController.close();
  await readPromise;

  // 2 件目の NAMESPACE (別 suffix) も処理されており、throw でループが終了していない
  assert.equal(namespaceCalls, 2);
  // 明示的な NAMESPACE_DONE (1 回目) と、FIN 時の補完通知 (2 件目の suffix)
  assert.equal(namespaceDoneCalls, 2);
  assert.isUndefined(ctx.getClosedWithError());
});

/**
 * onNamespaceDone の throw を握り潰した後も、NAMESPACE_DONE 済みの追跡状態が
 * 更新され、FIN 時の補完通知で同じ suffix が二重通知されないことを検証する。
 *
 * 握り潰さずに catch へ抜けると activeTracker.remove が飛び、catch の
 * emitAll() が同じ suffix を onNamespaceDone として再通知する。
 */
test("namespaceStartNamespaceStreamLoop: onNamespaceDone の throw 後も FIN で二重通知しない", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");
  let namespaceDoneCalls = 0;
  ctx.subscription.callbacks.onNamespaceDone = () => {
    namespaceDoneCalls++;
    throw new Error("app onNamespaceDone failure");
  };

  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  const suffix = createTrackNamespace(["live", "sports"]);
  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
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
  // FIN で emitAll() の補完通知経路に入る
  ctx.readableController.close();
  await readPromise;

  // 明示的な NAMESPACE_DONE の 1 回だけで、FIN の補完通知は発生しない
  assert.equal(namespaceDoneCalls, 1);
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

test("namespaceStartNamespaceStreamLoop: unsubscribe 後の遅延 REQUEST_OK で PROTOCOL_VIOLATION にならない", async () => {
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

  // 確立応答を feed して処理を待つ
  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  assert.isTrue(resolved);

  // unsubscribe() 相当: state を closed にした後、ピアから遅延 REQUEST_OK が
  // 別フィードとして届く実運用の流れを再現する (while 条件は read() 開始時に
  // 検査済みのため、for ループ冒頭のガードが唯一の防衛線になる)。
  ctx.subscription.state = "closed";
  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  ctx.readableController.close();
  await readPromise;

  // 遅延 REQUEST_OK は state ガードで無視され、セッションは閉じない
  assert.isUndefined(ctx.getClosedWithError());
});

test("namespaceStartNamespaceStreamLoop: unsubscribe 後の遅延 REQUEST_ERROR で PROTOCOL_VIOLATION にならない", async () => {
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

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  assert.isTrue(resolved);

  // unsubscribe 相当で state を closed にしてから、遅延 REQUEST_ERROR を feed する
  ctx.subscription.state = "closed";
  ctx.readableController.enqueue(
    requestErrorMessage(ctx.controlWriter, RequestErrorCode.PREFIX_OVERLAP),
  );
  ctx.readableController.close();
  await readPromise;

  // 遅延 REQUEST_ERROR は state ガードで無視され、セッションは閉じない
  assert.isUndefined(ctx.getClosedWithError());
});

test("namespaceStartNamespaceStreamLoop: unsubscribe 後の遅延 NAMESPACE / NAMESPACE_DONE / GOAWAY でコールバックが発火しない", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");
  const fired: string[] = [];
  ctx.subscription.callbacks = {
    onNamespace: () => {
      fired.push("onNamespace");
    },
    onNamespaceDone: () => {
      fired.push("onNamespaceDone");
    },
    goaway: () => {
      fired.push("goaway");
    },
  };
  let resolved = false;
  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {
      resolved = true;
    },
    () => {},
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  assert.isTrue(resolved);

  // unsubscribe 相当で state を closed にしてから、遅延 NAMESPACE /
  // NAMESPACE_DONE / GOAWAY を feed する
  const suffix = createTrackNamespace(["live", "sports"]);
  ctx.subscription.state = "closed";
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
  ctx.readableController.enqueue(
    ctx.controlWriter.encode(
      MessageType.GOAWAY,
      encodeGoawayPayload({
        type: MessageType.GOAWAY,
        newSessionUri: "moqt://new.example.com",
        timeout: 0n,
      }),
    ),
  );
  ctx.readableController.close();
  await readPromise;

  // state ガードとループ終了により、spurious コールバックも PROTOCOL_VIOLATION
  // も発生しない (最初の NAMESPACE がガードで無視された後、while 条件により
  // ループが終了して以後のメッセージは処理されない)
  assert.deepEqual(fired, []);
  assert.isUndefined(ctx.getClosedWithError());
});

test("namespaceStartTracksStreamLoop: unsubscribe 後の遅延 REQUEST_OK で PROTOCOL_VIOLATION にならない", async () => {
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

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  assert.isTrue(resolved);

  // unsubscribe 相当で state を closed にしてから、遅延 REQUEST_OK を feed する
  ctx.subscription.state = "closed";
  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  ctx.readableController.close();
  await readPromise;

  // 遅延 REQUEST_OK は state ガードで無視され、セッションは閉じない
  assert.isUndefined(ctx.getClosedWithError());
});

test("namespaceStartTracksStreamLoop: unsubscribe 後の遅延 REQUEST_ERROR で PROTOCOL_VIOLATION にならない", async () => {
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

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  assert.isTrue(resolved);

  // unsubscribe 相当で state を closed にしてから、遅延 REQUEST_ERROR を feed する
  ctx.subscription.state = "closed";
  ctx.readableController.enqueue(
    requestErrorMessage(ctx.controlWriter, RequestErrorCode.PREFIX_OVERLAP),
  );
  ctx.readableController.close();
  await readPromise;

  // 遅延 REQUEST_ERROR は state ガードで無視され、セッションは閉じない
  assert.isUndefined(ctx.getClosedWithError());
});

test("namespaceStartTracksStreamLoop: unsubscribe 後の遅延 PUBLISH_SKIPPED でコールバックが発火しない", async () => {
  const ctx = createNamespaceLoopTestContext("tracks");
  let onPublishSkippedCalled = false;
  ctx.subscription.callbacks = {
    onPublishSkipped: () => {
      onPublishSkippedCalled = true;
    },
  };
  let resolved = false;
  const readPromise = namespaceStartTracksStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {
      resolved = true;
    },
    () => {},
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  assert.isTrue(resolved);

  // unsubscribe 相当で state を closed にしてから、遅延 PUBLISH_SKIPPED を feed する
  ctx.subscription.state = "closed";
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

  // state ガードにより onPublishSkipped の spurious 発火は発生しない
  assert.isFalse(onPublishSkippedCalled);
  assert.isUndefined(ctx.getClosedWithError());
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
// draft-ietf-moq-transport-21 §9.14 (PUBLISH_NAMESPACE、応答は §9.3 / §9.4)
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
  publication: {
    callbacks: Record<string, unknown>;
    state: string;
  };
  writerClosed: () => Promise<void>;
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

  // 実 WritableStream を writer として注入し、GOAWAY 受信時の writer.close() を
  // ストリームの closed Promise で検証できるようにする。
  const writable = new WritableStream<Uint8Array>();
  const writer = writable.getWriter();

  const publication = {
    callbacks: {},
    state: "pending" as const,
    streamReader,
    controlReader,
    writer,
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
    // テストから publication の callbacks / state を直接参照できるようにする
    // (session の内部 Map から取り出すキャストを不要にする)
    publication,
    writerClosed: () => writer.closed,
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

test("namespaceStartPublicationStreamLoop: 先頭 GOAWAY (resolved=false) で callbacks.goaway 通知 + Promise reject + セッション継続", async () => {
  const ctx = createPublicationLoopTestContext();
  const publication = ctx.session.namespacePublications.get(ctx.requestId)! as unknown as {
    callbacks: Record<string, unknown>;
    state: string;
  };
  const notifiedUris: string[] = [];
  let errorFired = false;
  Object.assign(publication.callbacks, {
    goaway: (uri: string) => {
      notifiedUris.push(uri);
    },
    error: () => {
      errorFired = true;
    },
  });

  let rejectedError: Error | undefined;
  const readPromise = namespaceStartPublicationStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    (err) => {
      rejectedError = err;
    },
  );

  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "moqt://new.example.com",
    timeout: 0n,
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.GOAWAY, goawayPayload));
  // 確立前 GOAWAY 後も読み取りを継続するため、ピアの FIN で終了させる。
  ctx.readableController.close();
  await readPromise;

  assert.deepEqual(notifiedUris, ["moqt://new.example.com"]);
  assert.isDefined(rejectedError);
  assert.equal(rejectedError!.message, "request stream goaway: moqt://new.example.com");
  assert.isUndefined(ctx.getClosedWithError());
  assert.isFalse(errorFired);
  assert.equal(publication.state, "closed");
  assert.isFalse(ctx.session.namespacePublications.has(ctx.requestId));
  assert.isTrue(ctx.session.goawayReceivedOnRequestStreams.has(ctx.requestId));
});

test("namespaceStartPublicationStreamLoop: ピア FIN で自方向を FIN する", async () => {
  // draft-ietf-moq-transport-21 §6.4.2.2:
  // ピアの FIN 後、requester は自方向も FIN で閉じる (SHOULD)。
  const ctx = createPublicationLoopTestContext();

  const readPromise = namespaceStartPublicationStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  ctx.readableController.close();
  await ctx.writerClosed();
  await readPromise;

  assert.isUndefined(ctx.getClosedWithError());
});

test("namespaceStartPublicationStreamLoop: 確立前 GOAWAY 後の 2 通目 GOAWAY で PROTOCOL_VIOLATION で閉じる", async () => {
  // draft-ietf-moq-transport-21 §9.2: 同一リクエストストリームの重複 GOAWAY は違反。
  const ctx = createPublicationLoopTestContext();

  const readPromise = namespaceStartPublicationStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "",
    timeout: 0n,
  });
  const goaway = ctx.controlWriter.encode(MessageType.GOAWAY, goawayPayload);
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

test("namespaceStartPublicationStreamLoop: 確立後 (resolved=true) の GOAWAY で送信方向が FIN (writer.close()) される", async () => {
  // draft-ietf-moq-transport-21 §9.2:
  // publication ループも namespace / tracks と同様、送信方向を FIN で閉じる。
  // §6.4.2.2 の PUBLISH_DONE MUST は Established subscription 限定であり
  // namespace publication は対象外 (§9.2 の FIN 選択肢が妥当)。
  const ctx = createPublicationLoopTestContext();
  const publication = ctx.session.namespacePublications.get(ctx.requestId)! as unknown as {
    callbacks: Record<string, unknown>;
  };
  const notifiedUris: string[] = [];
  Object.assign(publication.callbacks, {
    goaway: (uri: string) => {
      notifiedUris.push(uri);
    },
  });

  const readPromise = namespaceStartPublicationStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "moqt://new.example.com",
    timeout: 0n,
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.GOAWAY, goawayPayload));
  await ctx.writerClosed();
  // 2 通目 GOAWAY を注入するとセッションが PROTOCOL_VIOLATION で閉じる (読み取り継続の証)
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.GOAWAY, goawayPayload));
  ctx.readableController.close();
  await readPromise;

  assert.deepEqual(notifiedUris, ["moqt://new.example.com"]);
  const err = ctx.getClosedWithError();
  assert.isDefined(err);
  assert.equal(err!.code, SessionErrorCode.PROTOCOL_VIOLATION);
});

// ============================================================================
// 確立前の検証失敗で Promise が reject される
// draft-ietf-moq-transport-21 §9.14 / §9.15 / §9.18:
// ピアの初期応答が仕様違反でも呼び出し元の Promise を永久ハングさせず、
// closeWithError に渡す SessionError と同一オブジェクトで reject する
// (PUBLISH 応答経路と同一パターン)。
// ============================================================================

test("namespaceStartNamespaceStreamLoop: 先頭の想定外メッセージで reject し同一オブジェクトで閉じる", async () => {
  // 先頭メッセージ検証の失敗は close だけでなく呼び出し元へ reject する
  const ctx = createNamespaceLoopTestContext("namespace");

  let rejectedError: Error | undefined;
  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    (err) => {
      rejectedError = err;
    },
  );

  // 先頭に NAMESPACE (REQUEST_OK / REQUEST_ERROR / GOAWAY 以外) を注入する
  const namespacePayload = encodeNamespacePayload({
    type: MessageType.NAMESPACE,
    trackNamespaceSuffix: createTrackNamespace(["sports"]),
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.NAMESPACE, namespacePayload));
  ctx.readableController.close();
  await readPromise;

  // reject される値は closeWithError に渡す値と同一オブジェクトである
  assert.isDefined(rejectedError);
  assert.isDefined(ctx.getClosedWithError());
  assert.strictEqual(rejectedError, ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
});

test("namespaceStartNamespaceStreamLoop: 初期 REQUEST_OK のスコープ違反で reject し同一オブジェクトで閉じる", async () => {
  // 初期応答のパラメータスコープ違反も呼び出し元へ reject する
  const ctx = createNamespaceLoopTestContext("namespace");

  let rejectedError: Error | undefined;
  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    (err) => {
      rejectedError = err;
    },
  );

  // FORWARD は SUBSCRIBE_NAMESPACE_OK (EXPIRES のみ許可) のスコープ違反である
  ctx.readableController.enqueue(
    requestOkMessageWithParameters(ctx.controlWriter, [
      { type: MessageParameterType.FORWARD, value: new Uint8Array([1]) },
    ]),
  );
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(rejectedError);
  assert.isDefined(ctx.getClosedWithError());
  assert.strictEqual(rejectedError, ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(
    ctx.getClosedWithError()!.message.includes("not allowed in SUBSCRIBE_NAMESPACE_OK"),
  );
});

test("namespaceStartNamespaceStreamLoop: 初期 REQUEST_OK の Track Properties 非空で reject し同一オブジェクトで閉じる", async () => {
  // §9.3 の空必須違反も呼び出し元へ reject する
  const ctx = createNamespaceLoopTestContext("namespace");

  let rejectedError: Error | undefined;
  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    (err) => {
      rejectedError = err;
    },
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter, [{ id: 0n, value: 1n }]));
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(rejectedError);
  assert.isDefined(ctx.getClosedWithError());
  assert.strictEqual(rejectedError, ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(
    ctx
      .getClosedWithError()!
      .message.includes("track properties must be empty in SUBSCRIBE_NAMESPACE_OK"),
  );
});

test("namespaceStartTracksStreamLoop: 先頭の想定外メッセージで reject し同一オブジェクトで閉じる", async () => {
  // 先頭メッセージ検証の失敗は close だけでなく呼び出し元へ reject する
  const ctx = createNamespaceLoopTestContext("tracks");

  let rejectedError: Error | undefined;
  const readPromise = namespaceStartTracksStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    (err) => {
      rejectedError = err;
    },
  );

  // 先頭に PUBLISH_SKIPPED (REQUEST_OK / REQUEST_ERROR / GOAWAY 以外) を注入する
  const skippedPayload = encodePublishSkippedPayload({
    type: MessageType.PUBLISH_SKIPPED,
    trackNamespaceSuffix: createTrackNamespace(["sports"]),
    trackName: new TextEncoder().encode("track"),
  });
  ctx.readableController.enqueue(
    ctx.controlWriter.encode(MessageType.PUBLISH_SKIPPED, skippedPayload),
  );
  ctx.readableController.close();
  await readPromise;

  // reject される値は closeWithError に渡す値と同一オブジェクトである
  assert.isDefined(rejectedError);
  assert.isDefined(ctx.getClosedWithError());
  assert.strictEqual(rejectedError, ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
});

test("namespaceStartTracksStreamLoop: 初期 REQUEST_OK のスコープ違反で reject し同一オブジェクトで閉じる", async () => {
  // 初期応答のパラメータスコープ違反も呼び出し元へ reject する
  const ctx = createNamespaceLoopTestContext("tracks");

  let rejectedError: Error | undefined;
  const readPromise = namespaceStartTracksStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    (err) => {
      rejectedError = err;
    },
  );

  // FORWARD は SUBSCRIBE_TRACKS_OK (EXPIRES のみ許可) のスコープ違反である
  ctx.readableController.enqueue(
    requestOkMessageWithParameters(ctx.controlWriter, [
      { type: MessageParameterType.FORWARD, value: new Uint8Array([1]) },
    ]),
  );
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(rejectedError);
  assert.isDefined(ctx.getClosedWithError());
  assert.strictEqual(rejectedError, ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(ctx.getClosedWithError()!.message.includes("not allowed in SUBSCRIBE_TRACKS_OK"));
});

test("namespaceStartPublicationStreamLoop: 初期 REQUEST_OK のスコープ違反で reject し同一オブジェクトで閉じる", async () => {
  // 初期応答のパラメータスコープ違反も呼び出し元へ reject する
  const ctx = createPublicationLoopTestContext();

  let rejectedError: Error | undefined;
  const readPromise = namespaceStartPublicationStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    (err) => {
      rejectedError = err;
    },
  );

  // FORWARD は PUBLISH_NAMESPACE_OK (EXPIRES のみ許可) のスコープ違反である
  ctx.readableController.enqueue(
    requestOkMessageWithParameters(ctx.controlWriter, [
      { type: MessageParameterType.FORWARD, value: new Uint8Array([1]) },
    ]),
  );
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(rejectedError);
  assert.isDefined(ctx.getClosedWithError());
  assert.strictEqual(rejectedError, ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(ctx.getClosedWithError()!.message.includes("not allowed in PUBLISH_NAMESPACE_OK"));
});

test("namespaceStartPublicationStreamLoop: 初期 REQUEST_OK の Track Properties 非空で reject し同一オブジェクトで閉じる", async () => {
  // §9.3 の空必須違反も呼び出し元へ reject する
  const ctx = createPublicationLoopTestContext();

  let rejectedError: Error | undefined;
  const readPromise = namespaceStartPublicationStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    (err) => {
      rejectedError = err;
    },
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter, [{ id: 0n, value: 1n }]));
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(rejectedError);
  assert.isDefined(ctx.getClosedWithError());
  assert.strictEqual(rejectedError, ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(
    ctx
      .getClosedWithError()!
      .message.includes("track properties must be empty in PUBLISH_NAMESPACE_OK"),
  );
});

test("namespaceStartPublicationStreamLoop: 想定外の先頭メッセージで reject し同一オブジェクトで閉じる", async () => {
  // 想定外の先頭メッセージは close だけでなく呼び出し元へ reject する
  const ctx = createPublicationLoopTestContext();

  let rejectedError: Error | undefined;
  const readPromise = namespaceStartPublicationStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    (err) => {
      rejectedError = err;
    },
  );

  // 先頭に NAMESPACE (REQUEST_OK / REQUEST_ERROR / GOAWAY 以外) を注入する
  const namespacePayload = encodeNamespacePayload({
    type: MessageType.NAMESPACE,
    trackNamespaceSuffix: createTrackNamespace(["sports"]),
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.NAMESPACE, namespacePayload));
  ctx.readableController.close();
  await readPromise;

  // reject される値は closeWithError に渡す値と同一オブジェクトである
  assert.isDefined(rejectedError);
  assert.isDefined(ctx.getClosedWithError());
  assert.strictEqual(rejectedError, ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
});

test("namespaceStartPublicationStreamLoop: 確立後の想定外メッセージは reject せず閉じるのみにする", async () => {
  // 確立後の未知メッセージは close のみで、解決済み Promise への二重 reject はない
  const ctx = createPublicationLoopTestContext();

  let resolvedCount = 0;
  let rejectedError: Error | undefined;
  const readPromise = namespaceStartPublicationStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {
      resolvedCount++;
    },
    (err) => {
      rejectedError = err;
    },
  );

  // 正常な REQUEST_OK で確立させてから想定外メッセージを注入する
  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  const namespacePayload = encodeNamespacePayload({
    type: MessageType.NAMESPACE,
    trackNamespaceSuffix: createTrackNamespace(["sports"]),
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.NAMESPACE, namespacePayload));
  ctx.readableController.close();
  await readPromise;

  // Promise は 1 回解決され、reject は発火しないままセッションが閉じる
  assert.equal(resolvedCount, 1);
  assert.isUndefined(rejectedError);
  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
});

test("namespaceStartPublicationStreamLoop: 確立後の 2 通目 REQUEST_OK は重複として閉じ、reject しない", async () => {
  // 確立後の 2 通目 REQUEST_OK は scope 検証より先に重複として閉じる
  const ctx = createPublicationLoopTestContext();

  let resolvedCount = 0;
  let rejectedError: Error | undefined;
  const readPromise = namespaceStartPublicationStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {
      resolvedCount++;
    },
    (err) => {
      rejectedError = err;
    },
  );

  // 正常な REQUEST_OK で確立させてから、スコープ違反付きの 2 通目を注入する
  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  ctx.readableController.enqueue(
    requestOkMessageWithParameters(ctx.controlWriter, [
      { type: MessageParameterType.FORWARD, value: new Uint8Array([1]) },
    ]),
  );
  ctx.readableController.close();
  await readPromise;

  // 重複優先のため scope 違反ではなく重複として閉じ、reject は発火しない
  assert.equal(resolvedCount, 1);
  assert.isUndefined(rejectedError);
  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(ctx.getClosedWithError()!.message.includes("received duplicate REQUEST_OK"));
});

// ============================================================================
// 既知 Type の serialization 不一致 (KEY_VALUE_FORMATTING_ERROR) で閉じる
// draft-ietf-moq-transport-21 §8.3 (Key-Value-Pair Structure)
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §8.3 / §9.3:
 * malformed な Track Properties を含む SUBSCRIBE_NAMESPACE_OK を受信したら
 * KEY_VALUE_FORMATTING_ERROR でセッションを閉じる。確立前の失敗は
 * 呼び出し元へ close と同一オブジェクトで reject してから閉じる。
 */
test("namespaceStartNamespaceStreamLoop: malformed な REQUEST_OK で KEY_VALUE_FORMATTING_ERROR で閉じる", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");

  let rejectedError: Error | undefined;
  // reject が close より先であることを、reject 時点でまだ閉じていないことで検証する
  let rejectedBeforeClose = false;
  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    (err) => {
      rejectedError = err;
      rejectedBeforeClose = ctx.getClosedWithError() === undefined;
    },
  );

  const okPayload = appendMalformedTrackProperties(
    encodeRequestOkPayload({
      type: MessageType.REQUEST_OK,
      parameters: [],
      trackProperties: [],
    }),
  );
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.REQUEST_OK, okPayload));
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(rejectedError);
  assert.isDefined(ctx.getClosedWithError());
  assert.strictEqual(rejectedError, ctx.getClosedWithError());
  assert.isTrue(rejectedBeforeClose);
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
  // finally で subscription が掃除される
  assert.isFalse(ctx.session.namespaceSubscriptions.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §8.3 / §9.3:
 * malformed な Track Properties を含む SUBSCRIBE_TRACKS_OK を受信したら
 * KEY_VALUE_FORMATTING_ERROR でセッションを閉じる。
 */
test("namespaceStartTracksStreamLoop: malformed な REQUEST_OK で KEY_VALUE_FORMATTING_ERROR で閉じる", async () => {
  const ctx = createNamespaceLoopTestContext("tracks");

  let rejectedError: Error | undefined;
  const readPromise = namespaceStartTracksStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    (err) => {
      rejectedError = err;
    },
  );

  const okPayload = appendMalformedTrackProperties(
    encodeRequestOkPayload({
      type: MessageType.REQUEST_OK,
      parameters: [],
      trackProperties: [],
    }),
  );
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.REQUEST_OK, okPayload));
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(rejectedError);
  assert.isDefined(ctx.getClosedWithError());
  assert.strictEqual(rejectedError, ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
  // finally で subscription が掃除される
  assert.isFalse(ctx.session.tracksSubscriptions.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §8.3 / §9.3:
 * malformed な Track Properties を含む PUBLISH_NAMESPACE_OK を受信したら
 * KEY_VALUE_FORMATTING_ERROR でセッションを閉じる。
 */
test("namespaceStartPublicationStreamLoop: malformed な REQUEST_OK で KEY_VALUE_FORMATTING_ERROR で閉じる", async () => {
  const ctx = createPublicationLoopTestContext();

  let rejectedError: Error | undefined;
  const readPromise = namespaceStartPublicationStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    (err) => {
      rejectedError = err;
    },
  );

  const okPayload = appendMalformedTrackProperties(
    encodeRequestOkPayload({
      type: MessageType.REQUEST_OK,
      parameters: [],
      trackProperties: [],
    }),
  );
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.REQUEST_OK, okPayload));
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(rejectedError);
  assert.isDefined(ctx.getClosedWithError());
  assert.strictEqual(rejectedError, ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
  // finally で publication が掃除される
  assert.isFalse(ctx.session.namespacePublications.has(ctx.requestId));
});

// ============================================================================
// 空必須メッセージの未知 Mandatory Track Property
// draft-ietf-moq-transport-21 §9.3 (REQUEST_OK) / §3.6 (Mandatory Track Properties)
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.3:
 * 「they are empty in PUBLISH_OK, REQUEST_UPDATE_OK, SUBSCRIBE_NAMESPACE_OK and
 *  PUBLISH_NAMESPACE_OK.  If an endpoint receives Track Properties in one of
 *  these messages it MUST close the session with a PROTOCOL_VIOLATION.」
 * 未知 Mandatory Track Property (0x4000-0x7FFF) は decodeProperties が
 * MalformedTrackError を throw するため、初期 SUBSCRIBE_NAMESPACE_OK では
 * PROTOCOL_VIOLATION へ変換して閉じ、購読の Promise を reject する。
 */
test("namespaceStartNamespaceStreamLoop: 初期 SUBSCRIBE_NAMESPACE_OK の未知 Mandatory Track Property で PROTOCOL_VIOLATION で閉じる", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");
  let rejectedError: Error | undefined;

  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    (err) => {
      rejectedError = err;
    },
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter, [{ id: 0x4000n, value: 1n }]));
  ctx.readableController.close();
  await readPromise;

  // 確立前の違反は呼び出し元の Promise を reject してから閉じる
  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(ctx.getClosedWithError()!.message.includes("unknown mandatory track property"));
  assert.strictEqual(rejectedError, ctx.getClosedWithError());
});

/**
 * draft-ietf-moq-transport-21 §9.3:
 * 確立後の REQUEST_UPDATE_OK に未知 Mandatory Track Property を含めた場合も
 * PROTOCOL_VIOLATION で閉じ、保留中の更新を違反 SessionError 自体で reject する
 * (update() のハング防止)。prefix は反映しない。
 */
test("namespaceStartNamespaceStreamLoop: REQUEST_UPDATE 応答の未知 Mandatory Track Property で PROTOCOL_VIOLATION で閉じる", async () => {
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
  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter, [{ id: 0x4000n, value: 1n }]));
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isFalse(pending.resolved);
  assert.strictEqual(pending.rejected, ctx.getClosedWithError());
  assert.deepEqual(ctx.subscription.namespacePrefix, ["live"]);
  assert.isUndefined(ctx.subscription.pendingPrefix);
});

/**
 * draft-ietf-moq-transport-21 §9.3:
 * tracks ストリームの確立後 REQUEST_UPDATE_OK も空必須であり、未知 Mandatory
 * Track Property では PROTOCOL_VIOLATION で閉じる。
 */
test("namespaceStartTracksStreamLoop: REQUEST_UPDATE 応答の未知 Mandatory Track Property で PROTOCOL_VIOLATION で閉じる", async () => {
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
  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter, [{ id: 0x4000n, value: 1n }]));
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isFalse(pending.resolved);
  assert.strictEqual(pending.rejected, ctx.getClosedWithError());
  assert.deepEqual(ctx.subscription.namespacePrefix, ["live"]);
});

/**
 * draft-ietf-moq-transport-21 §9.3:
 * SUBSCRIBE_TRACKS_OK は空必須の列挙に含まれず Track Properties を運べるため、
 * 未知 Mandatory Track Property を含んでいてもセッションは閉じない (非退行)。
 * 読み取り失敗として購読の Promise が reject される既存挙動を維持する。
 */
test("namespaceStartTracksStreamLoop: 初期 SUBSCRIBE_TRACKS_OK の未知 Mandatory Track Property ではセッションを閉じない", async () => {
  const ctx = createNamespaceLoopTestContext("tracks");
  let rejectedError: Error | undefined;

  const readPromise = namespaceStartTracksStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    (err) => {
      rejectedError = err;
    },
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter, [{ id: 0x4000n, value: 1n }]));
  ctx.readableController.close();
  await readPromise;

  assert.isUndefined(ctx.getClosedWithError());
  assert.isDefined(rejectedError);
});

/**
 * draft-ietf-moq-transport-21 §9.3:
 * 初期 PUBLISH_NAMESPACE_OK も Track Properties が空必須であり、未知 Mandatory
 * Track Property では PROTOCOL_VIOLATION で閉じる。確立前の検証失敗は呼び出し元の
 * Promise を reject してから閉じる。
 */
test("namespaceStartPublicationStreamLoop: 初期 PUBLISH_NAMESPACE_OK の未知 Mandatory Track Property で PROTOCOL_VIOLATION で閉じる", async () => {
  const ctx = createPublicationLoopTestContext();
  let rejectedError: Error | undefined;

  const readPromise = namespaceStartPublicationStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    (err) => {
      rejectedError = err;
    },
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter, [{ id: 0x4000n, value: 1n }]));
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(ctx.getClosedWithError()!.message.includes("unknown mandatory track property"));
  assert.strictEqual(rejectedError, ctx.getClosedWithError());
});

/**
 * draft-ietf-moq-transport-21 §9.3:
 * publication ストリームの確立後 (2 通目) REQUEST_OK に未知 Mandatory Track Property を
 * 含めた場合も PROTOCOL_VIOLATION で閉じる。重複 REQUEST_OK の違反と同じコードであり、
 * 未知 Mandatory の検出は decode 時点で先に成立する。
 */
test("namespaceStartPublicationStreamLoop: 確立後の 2 通目 REQUEST_OK の未知 Mandatory Track Property で PROTOCOL_VIOLATION で閉じる", async () => {
  const ctx = createPublicationLoopTestContext();

  const readPromise = namespaceStartPublicationStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter, [{ id: 0x4000n, value: 1n }]));
  ctx.readableController.close();
  await readPromise;

  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(ctx.getClosedWithError()!.message.includes("unknown mandatory track property"));
});

// ============================================================================
// error コールバックの例外で後始末が止まらないこと
//
// 購読単位の callbacks.error が throw しても、通知の失敗で後始末
// (確立前 Promise の reject・保留中 REQUEST_UPDATE の reject・
// 該当時の session.closeWithError) が中断されないこと。
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §8.3 / §9.3:
 * error コールバックが throw しても、malformed な Track Properties の通知後に
 * 確立前 Promise の reject とセッションクローズが実行されることを検証する。
 */
test("namespaceStartNamespaceStreamLoop: error コールバックの throw を無視して reject とセッションクローズが実行される", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");
  const notifiedMessages: string[] = [];
  Object.assign(ctx.subscription.callbacks, {
    error: (error: Error): void => {
      notifiedMessages.push(error.message);
      throw new Error("app error callback failure");
    },
  });

  let rejectedError: Error | undefined;
  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    (err) => {
      rejectedError = err;
    },
  );

  // malformed な Track Properties を注入して KEY_VALUE_FORMATTING_ERROR を発生させる
  const okPayload = appendMalformedTrackProperties(
    encodeRequestOkPayload({
      type: MessageType.REQUEST_OK,
      parameters: [],
      trackProperties: [],
    }),
  );
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.REQUEST_OK, okPayload));
  ctx.readableController.close();
  await readPromise;

  // 通知は 1 回だけ (コールバックの throw で二重通知にならない)
  assert.equal(notifiedMessages.length, 1);
  // throw しても reject が実行され、close に渡す値と同一オブジェクトである
  assert.isDefined(rejectedError);
  assert.isDefined(ctx.getClosedWithError());
  assert.strictEqual(rejectedError, ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
  // 通知されたエラーは close に渡した SessionError と同じである
  assert.equal(notifiedMessages[0], ctx.getClosedWithError()!.message);
  // finally で subscription が掃除される
  assert.isFalse(ctx.session.namespaceSubscriptions.has(ctx.requestId));
});

/**
 * 破損した REQUEST_OK (宣言 Length に対し本体が不足) を catch で受けた場合も、
 * error コールバックの throw にかかわらず reject とセッションクローズ
 * (IncompleteDataError は PROTOCOL_VIOLATION に変換される) が実行されることを検証する。
 */
test("namespaceStartNamespaceStreamLoop: error コールバックの throw を無視して破損メッセージでセッションが閉じる", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");
  Object.assign(ctx.subscription.callbacks, {
    error: (): void => {
      throw new Error("app error callback failure");
    },
  });

  let rejectedError: Error | undefined;
  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    (err) => {
      rejectedError = err;
    },
  );

  // 不完全なペイロード (Number of Parameters=1 を宣言するが本体が無い) を注入する
  ctx.readableController.enqueue(
    ctx.controlWriter.encode(MessageType.REQUEST_OK, new Uint8Array([0x01])),
  );
  ctx.readableController.close();
  await readPromise;

  // reject は受信した IncompleteDataError のまま、close は PROTOCOL_VIOLATION へ変換される
  assert.isDefined(rejectedError);
  assert.isTrue(rejectedError!.message.includes("insufficient data"));
  assert.isDefined(ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(ctx.getClosedWithError()!.message.includes("insufficient data"));
  // finally で subscription が掃除される
  assert.isFalse(ctx.session.namespaceSubscriptions.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §9.5.1:
 * resolved 後の read 失敗 (RESET_STREAM 相当) でも、error コールバックの throw に
 * かかわらず保留中 REQUEST_UPDATE が reject されることを検証する。
 */
test("namespaceStartNamespaceStreamLoop: error コールバックの throw を無視して保留中の更新が reject される", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");
  let notifyCount = 0;
  Object.assign(ctx.subscription.callbacks, {
    error: (): void => {
      notifyCount += 1;
      throw new Error("app error callback failure");
    },
  });

  const pending = registerPendingUpdate(ctx.session, ctx.requestId);
  ctx.subscription.pendingPrefix = ["live", "sports"];

  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  // 確立後にピアの RESET_STREAM 相当でストリームが失敗する
  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), { source: "stream" }),
  );
  await readPromise;

  assert.equal(notifyCount, 1);
  assert.isFalse(pending.resolved);
  assert.isDefined(pending.rejected);
  assert.isTrue(
    pending.rejected!.message.includes("stream closed before receiving update response"),
  );
  // RESET_STREAM (read 例外) はセッションを閉じない
  assert.isUndefined(ctx.getClosedWithError());
});

/**
 * 確立前 REQUEST_ERROR の通知で error コールバックが throw しても、
 * 確立前 Promise が reject されることを検証する。
 */
test("namespaceStartNamespaceStreamLoop: 確立前 REQUEST_ERROR で error コールバックの throw を無視して reject する", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");
  let notifyCount = 0;
  Object.assign(ctx.subscription.callbacks, {
    error: (): void => {
      notifyCount += 1;
      throw new Error("app error callback failure");
    },
  });

  let rejectedError: Error | undefined;
  const readPromise = namespaceStartNamespaceStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    (err) => {
      rejectedError = err;
    },
  );

  // REQUEST_OK を挟まずに REQUEST_ERROR (リクエスト失敗) を受信する
  ctx.readableController.enqueue(
    requestErrorMessage(ctx.controlWriter, RequestErrorCode.PREFIX_OVERLAP),
  );
  ctx.readableController.close();
  await readPromise;

  assert.equal(notifyCount, 1);
  // リクエスト失敗はセッションを閉じず、確立前 Promise を reject する
  assert.isDefined(rejectedError);
  assert.equal(rejectedError!.message, "prefix overlap");
  assert.isUndefined(ctx.getClosedWithError());
  // finally で subscription が掃除される
  assert.isFalse(ctx.session.namespaceSubscriptions.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §8.3 / §9.3:
 * tracks ループでも error コールバックの throw で reject とセッションクローズが
 * 止まらないことを検証する。
 */
test("namespaceStartTracksStreamLoop: error コールバックの throw を無視して reject とセッションクローズが実行される", async () => {
  const ctx = createNamespaceLoopTestContext("tracks");
  const notifiedMessages: string[] = [];
  Object.assign(ctx.subscription.callbacks, {
    error: (error: Error): void => {
      notifiedMessages.push(error.message);
      throw new Error("app error callback failure");
    },
  });

  let rejectedError: Error | undefined;
  const readPromise = namespaceStartTracksStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    (err) => {
      rejectedError = err;
    },
  );

  const okPayload = appendMalformedTrackProperties(
    encodeRequestOkPayload({
      type: MessageType.REQUEST_OK,
      parameters: [],
      trackProperties: [],
    }),
  );
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.REQUEST_OK, okPayload));
  ctx.readableController.close();
  await readPromise;

  assert.equal(notifiedMessages.length, 1);
  assert.isDefined(rejectedError);
  assert.isDefined(ctx.getClosedWithError());
  assert.strictEqual(rejectedError, ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
  // 通知されたエラーは close に渡した SessionError と同じである
  assert.equal(notifiedMessages[0], ctx.getClosedWithError()!.message);
  // finally で subscription が掃除される
  assert.isFalse(ctx.session.tracksSubscriptions.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §9.5.1:
 * tracks ループでも resolved 後の read 失敗で error コールバックが throw しても
 * 保留中 REQUEST_UPDATE が reject されることを検証する。
 */
test("namespaceStartTracksStreamLoop: error コールバックの throw を無視して保留中の更新が reject される", async () => {
  const ctx = createNamespaceLoopTestContext("tracks");
  let notifyCount = 0;
  Object.assign(ctx.subscription.callbacks, {
    error: (): void => {
      notifyCount += 1;
      throw new Error("app error callback failure");
    },
  });

  const pending = registerPendingUpdate(ctx.session, ctx.requestId);
  ctx.subscription.pendingPrefix = ["live", "sports"];

  const readPromise = namespaceStartTracksStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    () => {},
  );

  ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
  ctx.readableController.error(
    Object.assign(new Error("stream reset by peer"), { source: "stream" }),
  );
  await readPromise;

  assert.equal(notifyCount, 1);
  assert.isFalse(pending.resolved);
  assert.isDefined(pending.rejected);
  assert.isTrue(
    pending.rejected!.message.includes("stream closed before receiving update response"),
  );
  assert.isUndefined(ctx.getClosedWithError());
});

/**
 * 確立前 REQUEST_ERROR の通知で error コールバックが throw しても、
 * tracks ループの確立前 Promise が reject されることを検証する。
 */
test("namespaceStartTracksStreamLoop: 確立前 REQUEST_ERROR で error コールバックの throw を無視して reject する", async () => {
  const ctx = createNamespaceLoopTestContext("tracks");
  let notifyCount = 0;
  Object.assign(ctx.subscription.callbacks, {
    error: (): void => {
      notifyCount += 1;
      throw new Error("app error callback failure");
    },
  });

  let rejectedError: Error | undefined;
  const readPromise = namespaceStartTracksStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    (err) => {
      rejectedError = err;
    },
  );

  ctx.readableController.enqueue(
    requestErrorMessage(ctx.controlWriter, RequestErrorCode.PREFIX_OVERLAP),
  );
  ctx.readableController.close();
  await readPromise;

  assert.equal(notifyCount, 1);
  assert.isDefined(rejectedError);
  assert.equal(rejectedError!.message, "prefix overlap");
  assert.isUndefined(ctx.getClosedWithError());
  // finally で subscription が掃除される
  assert.isFalse(ctx.session.tracksSubscriptions.has(ctx.requestId));
});

/**
 * draft-ietf-moq-transport-21 §8.3 / §9.3:
 * publication ループでも error コールバックの throw で reject とセッションクローズが
 * 止まらないことを検証する。
 */
test("namespaceStartPublicationStreamLoop: error コールバックの throw を無視して reject とセッションクローズが実行される", async () => {
  const ctx = createPublicationLoopTestContext();
  const notifiedMessages: string[] = [];
  Object.assign(ctx.publication.callbacks, {
    error: (error: Error): void => {
      notifiedMessages.push(error.message);
      throw new Error("app error callback failure");
    },
  });

  let rejectedError: Error | undefined;
  const readPromise = namespaceStartPublicationStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    (err) => {
      rejectedError = err;
    },
  );

  const okPayload = appendMalformedTrackProperties(
    encodeRequestOkPayload({
      type: MessageType.REQUEST_OK,
      parameters: [],
      trackProperties: [],
    }),
  );
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.REQUEST_OK, okPayload));
  ctx.readableController.close();
  await readPromise;

  assert.equal(notifiedMessages.length, 1);
  assert.isDefined(rejectedError);
  assert.isDefined(ctx.getClosedWithError());
  assert.strictEqual(rejectedError, ctx.getClosedWithError());
  assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
  // 通知されたエラーは close に渡した SessionError と同じである
  assert.equal(notifiedMessages[0], ctx.getClosedWithError()!.message);
  // finally で publication が掃除される
  assert.isFalse(ctx.session.namespacePublications.has(ctx.requestId));
});

/**
 * 確立前 REQUEST_ERROR の通知で error コールバックが throw しても、
 * publication ループの確立前 Promise が reject されることを検証する。
 */
test("namespaceStartPublicationStreamLoop: 確立前 REQUEST_ERROR で error コールバックの throw を無視して reject する", async () => {
  const ctx = createPublicationLoopTestContext();
  let notifyCount = 0;
  Object.assign(ctx.publication.callbacks, {
    error: (): void => {
      notifyCount += 1;
      throw new Error("app error callback failure");
    },
  });

  let rejectedError: Error | undefined;
  const readPromise = namespaceStartPublicationStreamLoop(
    ctx.session,
    ctx.requestId,
    () => {},
    (err) => {
      rejectedError = err;
    },
  );

  ctx.readableController.enqueue(
    requestErrorMessage(ctx.controlWriter, RequestErrorCode.PREFIX_OVERLAP),
  );
  ctx.readableController.close();
  await readPromise;

  assert.equal(notifyCount, 1);
  assert.isDefined(rejectedError);
  assert.equal(rejectedError!.message, "prefix overlap");
  assert.isUndefined(ctx.getClosedWithError());
  // finally で publication が掃除される
  assert.isFalse(ctx.session.namespacePublications.has(ctx.requestId));
});
