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
import { RequestError, RequestErrorCode, SessionError, SessionErrorCode } from "../error";
import { createTrackNamespace } from "../message/parameter";
import { encodeParameterTrackNamespace } from "../message";
import { encodeRequestUpdatePayload } from "../message/subscribe";
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
import { appendMalformedTrackProperties } from "../testSupport/helpers";

/**
 * テストで観測するデバッグ記録
 *
 * DebugMessage 全体は必要としないため、検証に使う typeName と decoded だけを
 * 構造的に受け取る。実物の debug コールバックは DebugMessage を渡すため、
 * 構造的部分型としてそのまま代入できる。
 */
interface DebugRecord {
  typeName: string;
  decoded?: Record<string, unknown>;
}

/**
 * REQUEST_CALLBACK_ERROR のデバッグ記録が 1 件だけあることを検証する
 *
 * リクエスト単位の error コールバックが throw したときだけ記録される。
 * 正常な通知では記録が増えないため、件数が 1 であることがそのまま
 * 「throw した 1 回だけ記録した」ことの検証になる。
 */
function assertRequestCallbackErrorRecord(
  debugRecords: DebugRecord[],
  expected: { requestId: bigint; message: string },
): void {
  const records = debugRecords.filter((record) => record.typeName === "REQUEST_CALLBACK_ERROR");
  assert.equal(records.length, 1);
  assert.equal(records[0].decoded?.error, expected.message);
  assert.equal(records[0].decoded?.requestId, expected.requestId.toString());
}

/**
 * 対象のループ種別
 *
 * namespace は SUBSCRIBE_NAMESPACE、tracks は SUBSCRIBE_TRACKS、publication は
 * PUBLISH_NAMESPACE のループを指す。3 ループの鏡写しテストはこの値を
 * パラメータとして回し、ループ固有のテストだけを個別に書く。
 */
type LoopKind = "namespace" | "tracks" | "publication";

/** ループ種別ごとの state (subscription は "active" / "closed"、publication は "pending" も取る) */
type LoopTargetState = "active" | "pending" | "closed";

/** テストから直接参照するループ対象 (subscription / publication) の構造 */
interface LoopTarget {
  state: LoopTargetState;
  callbacks: Record<string, unknown>;
  namespacePrefix: string[];
  pendingPrefix?: string[];
  writer: WritableStreamDefaultWriter<Uint8Array>;
}

/** パラメータ化したテストの 1 行分 */
interface LoopCase {
  /** 失敗時にループ種別を判別できるようにテスト名へ含める名前 */
  kind: LoopKind;
  /** createNamespaceLoopTestContext / startLoop へ渡すループ種別 */
  loop: LoopKind;
}

/** namespace 系 3 ループを回すシナリオ (失敗時のテスト名にループ種別が入る) */
const LOOP_CASES: readonly LoopCase[] = [
  { kind: "namespace", loop: "namespace" },
  { kind: "tracks", loop: "tracks" },
  { kind: "publication", loop: "publication" },
];

/** subscription 系 2 ループを回すシナリオ (publication は subscription を持たない) */
const SUBSCRIPTION_LOOP_CASES: readonly LoopCase[] = LOOP_CASES.filter(
  (loopCase) => loopCase.kind !== "publication",
);

/**
 * namespace 系ストリームループ用のテストコンテキストを構築する。
 *
 * ループ種別ごとの差 (subscription / publication、対象 Map、pendingRequestUpdate
 * の有無) はこの関数が吸収し、鏡写しのシナリオは同じハーネスで回す。ストリーム
 * 機構は実物 (ReadableStream + WritableStream) であり、テストは
 * readableController.enqueue でメッセージを注入する。
 */
function createNamespaceLoopTestContext(kind: LoopKind): {
  session: SessionInternal;
  requestId: bigint;
  readableController: ReadableStreamDefaultController<Uint8Array>;
  controlWriter: ControlStreamWriter;
  /** 通知コールバックの差し替えと state 遷移に使うループ対象 */
  target: LoopTarget;
  /** ループ対象が登録されている session の Map (finally の掃除の検証に使う) */
  targetMap: Map<bigint, unknown>;
  /** subscription 系ループ専用の別名 (subscription のプロパティを直接参照するテスト用) */
  subscription: LoopTarget;
  /** publication ループ専用の別名 (publication のプロパティを直接参照するテスト用) */
  publication: LoopTarget;
  writerClosed: () => Promise<void>;
  isReadableCancelled: () => boolean;
  getClosedWithError: () => SessionError | undefined;
  debugRecords: DebugRecord[];
} {
  const requestId = 10n;

  let readableController!: ReadableStreamDefaultController<Uint8Array>;
  // reader.cancel() による受信方向のクローズを観測する。
  // stream が既に closed / errored の場合は source の cancel は呼ばれないため、
  // cancel を観測するテストは readable を close せずに検証する。
  let readableCancelled = false;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      readableController = controller;
    },
    cancel() {
      readableCancelled = true;
    },
  });
  const streamReader = readable.getReader();
  const controlReader = new ControlStreamReader();

  // 実 WritableStream を writer として注入し、GOAWAY 受信時の writer.close() を
  // ストリームの closed Promise で検証できるようにする。
  const writable = new WritableStream<Uint8Array>();
  const writer = writable.getWriter();

  // subscription は確立済み ("active") から始め、publication は応答待ちの
  // "pending" から始める。テストはこのオブジェクトを直接書き換えて
  // unsubscribe 相当の状態遷移を再現する。
  const target: LoopTarget = {
    callbacks: {},
    state: kind === "publication" ? "pending" : "active",
    namespacePrefix: kind === "publication" ? [] : ["live"],
    writer,
  };

  let closedWithError: SessionError | undefined;
  const debugRecords: DebugRecord[] = [];
  const session = {
    namespaceSubscriptions: new Map(kind === "namespace" ? [[requestId, target]] : []),
    tracksSubscriptions: new Map(kind === "tracks" ? [[requestId, target]] : []),
    namespacePublications: new Map(kind === "publication" ? [[requestId, target]] : []),
    pendingRequestUpdate: new Map(),
    goawayReceivedOnRequestStreams: new Set(),
    unmatchedRequestOkAllowances: new Map(),
    callbacks: {
      debug: (message: DebugRecord) => {
        debugRecords.push(message);
      },
    },
    closeWithError: (error: SessionError) => {
      closedWithError = error;
      // 本番の SessionImpl.closeWithError は close() 内で保留中の更新を
      // 汎用エラーで reject する。テストでも同じ順序を再現する
      // (publication ループは REQUEST_UPDATE を扱わないため対象は常に空)。
      if (kind === "publication") {
        return;
      }
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
    createNamespacePublication: () => ({
      get state() {
        return "active";
      },
      unsubscribe: async () => {},
    }),
  } as unknown as SessionInternal;

  // ループは対象の streamReader / controlReader を参照する
  Object.assign(target, { streamReader, controlReader });

  // target は必ず上で Map へ登録済みのため、undefined を含まない型で取り出す
  const targetMap = (
    kind === "namespace"
      ? session.namespaceSubscriptions
      : kind === "tracks"
        ? session.tracksSubscriptions
        : session.namespacePublications
  ) as Map<bigint, unknown>;

  return {
    session,
    requestId,
    readableController,
    controlWriter: new ControlStreamWriter(),
    target,
    targetMap,
    // subscription 系ループと publication ループで同じ対象を参照する
    subscription: target,
    publication: target,
    writerClosed: () => writer.closed,
    isReadableCancelled: () => readableCancelled,
    getClosedWithError: () => closedWithError,
    debugRecords,
  };
}

/**
 * ループ種別に対応する namespace 系ストリームループを起動する
 *
 * 3 ループの入口はそれぞれ別関数のため、鏡写しのシナリオはここで 1 箇所に
 * まとめて呼び分ける。
 */
function startLoop(
  kind: LoopKind,
  session: SessionInternal,
  requestId: bigint,
  resolve: () => void,
  reject: (error: Error) => void,
): Promise<void> {
  if (kind === "namespace") {
    return namespaceStartNamespaceStreamLoop(session, requestId, resolve, reject);
  }
  if (kind === "tracks") {
    return namespaceStartTracksStreamLoop(session, requestId, resolve, reject);
  }
  return namespaceStartPublicationStreamLoop(session, requestId, resolve, reject);
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

/**
 * 先頭メッセージ検証で弾かれる想定外メッセージのフレームを生成する
 *
 * namespace / tracks は先頭メッセージガード、publication は unknown message type
 * として閉じる経路になり、いずれも REQUEST_OK / REQUEST_ERROR / GOAWAY 以外の
 * メッセージを注入すれば同じ検証 (PROTOCOL_VIOLATION で reject + close) になる。
 * ループ固有のメッセージ集合の差はここに閉じ込める。
 */
function firstUnexpectedMessage(kind: LoopKind, controlWriter: ControlStreamWriter): Uint8Array {
  if (kind === "tracks") {
    // tracks ループにだけ届く PUBLISH_SKIPPED (§9.19) を先頭に置く
    return controlWriter.encode(
      MessageType.PUBLISH_SKIPPED,
      encodePublishSkippedPayload({
        type: MessageType.PUBLISH_SKIPPED,
        trackNamespaceSuffix: createTrackNamespace(["sports"]),
        trackName: new TextEncoder().encode("track"),
      }),
    );
  }
  // namespace / publication は NAMESPACE (§9.16) を先頭に置く
  return controlWriter.encode(
    MessageType.NAMESPACE,
    encodeNamespacePayload({
      type: MessageType.NAMESPACE,
      trackNamespaceSuffix: createTrackNamespace(["sports"]),
    }),
  );
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

/**
 * draft-ietf-moq-transport-21 §9.4.1:
 * PUBLISH_NAMESPACE (publication ループ) の初回応答 REQUEST_ERROR でも、Redirect の
 * Track Name が非空なら PROTOCOL_VIOLATION でセッションを閉じる
 * (namespace 系リクエストは Track Name を空にする MUST)。
 */
test("namespaceStartPublicationStreamLoop: 非空 Track Name の Redirect は PROTOCOL_VIOLATION", async () => {
  const ctx = createNamespaceLoopTestContext("publication");
  const readPromise = startLoop(
    "publication",
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

/**
 * draft-ietf-moq-transport-21 §9.4.1 / §9.4.2 / §12.3:
 * namespace 系の応答でも Retry Interval と Redirect (Track Name は空) を保持してアプリへ
 * 渡す。Reason Phrase が空のときは Error Code を含む固定文言にする。
 */
test("namespaceStartPublicationStreamLoop: Redirect の retryInterval と redirect が保持される", async () => {
  const ctx = createNamespaceLoopTestContext("publication");
  let rejectedPublication: Error | undefined;
  const readPromise = startLoop(
    "publication",
    ctx.session,
    ctx.requestId,
    () => {},
    (error) => {
      rejectedPublication = error;
    },
  );

  const payload = encodeRequestErrorPayload({
    type: MessageType.REQUEST_ERROR,
    errorCode: BigInt(RequestErrorCode.REDIRECT),
    reasonPhrase: "",
    retryInterval: 23n,
    redirect: {
      connectUri: "https://example.com",
      trackNamespace: createTrackNamespace(["live"]),
      // namespace-scoped のリクエストでは Track Name は空でなければならない (§9.4.1)
      trackName: new Uint8Array(0),
    },
  });
  ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.REQUEST_ERROR, payload));
  ctx.readableController.close();
  await readPromise;

  assert.instanceOf(rejectedPublication, RequestError);
  const requestError = rejectedPublication as RequestError;
  assert.equal(requestError.code, RequestErrorCode.REDIRECT);
  assert.equal(requestError.retryInterval, 23n);
  assert.deepEqual(requestError.redirect, {
    connectUri: "https://example.com",
    trackNamespace: [new TextEncoder().encode("live")],
    trackName: new Uint8Array(0),
  });
  // Reason Phrase が空のときの固定文言
  assert.equal(requestError.message, "Request failed with code 52");
  // リクエスト単位の失敗でありセッションは閉じない
  assert.isUndefined(ctx.getClosedWithError());
});

// ============================================================================
// 自側が要求した namespace / tracks ストリームで受信する REQUEST_UPDATE
// draft-ietf-moq-transport-21 §9.5 (REQUEST_UPDATE) / §9.5.2
// (Updating Namespace Subscriptions)
//
// REQUEST_UPDATE を送れるのは要求の送信者 (自側) であり、ピアからの受信は
// §9.5 の 2 ケースに該当しない。§9.5 の MUST により PROTOCOL_VIOLATION で
// セッションを閉じる (受理してはならない)。
// ============================================================================

SUBSCRIPTION_LOOP_CASES.forEach(({ kind, loop }) => {
  test(`確立済み namespace ストリーム上の REQUEST_UPDATE で PROTOCOL_VIOLATION で閉じる: ${kind} ループ`, async () => {
    const ctx = createNamespaceLoopTestContext(loop);

    const readPromise = startLoop(
      loop,
      ctx.session,
      ctx.requestId,
      () => {},
      () => {},
    );

    // 初期 REQUEST_OK (確立応答) を注入する
    ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
    // §9.5.2 の TRACK_NAMESPACE_PREFIX 更新をピアから受信した状況を再現する
    const updatePayload = encodeRequestUpdatePayload({
      type: MessageType.REQUEST_UPDATE,
      requestId: ctx.requestId,
      parameters: [encodeParameterTrackNamespace(createTrackNamespace(["live", "sports"]))],
    });
    ctx.readableController.enqueue(
      ctx.controlWriter.encode(MessageType.REQUEST_UPDATE, updatePayload),
    );
    ctx.readableController.close();
    await readPromise;

    // 応答は送らず、PROTOCOL_VIOLATION でセッションを閉じる
    assert.equal(ctx.getClosedWithError()?.code, SessionErrorCode.PROTOCOL_VIOLATION);
    assert.isTrue(ctx.getClosedWithError()!.message.includes("stream message type"));
    // prefix は更新されない
    assert.notDeepEqual(ctx.target.namespacePrefix, ["live", "sports"]);
  });
});

// ============================================================================
// 3 ループ共通: REQUEST_UPDATE 応答の処理
// draft-ietf-moq-transport-21 §9.3 (REQUEST_OK) / §9.5.2
// (Updating Namespace Subscriptions) / §9.5.1 (応答前にストリームが閉じた場合)
//
// namespace / tracks の subscription 系 2 ループは、初期応答と更新応答で
// 同じ REQUEST_OK / REQUEST_ERROR ハンドラを通るため、鏡写しのテストを
// ループ種別でパラメータ化して 1 箇所保守にする。
// ============================================================================

// REQUEST_UPDATE 応答の連鎖 (REQUEST_OK での prefix 反映 / REQUEST_ERROR での
// reject / 応答未達の FIN での reject) は、任意の prefix と保留中更新集合を
// 扱う PBT (namespaceLoops.prop.ts) へ移した。

// 保留中の更新が無い 2 通目の REQUEST_OK は、仕様違反として PROTOCOL_VIOLATION で閉じる
SUBSCRIPTION_LOOP_CASES.forEach(({ kind, loop }) => {
  test(`保留中の更新が無い 2 通目の REQUEST_OK は PROTOCOL_VIOLATION で閉じる: ${kind} ループ`, async () => {
    const ctx = createNamespaceLoopTestContext(loop);

    const readPromise = startLoop(
      loop,
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
});

// 確立前の初期 REQUEST_ERROR でも Retry Interval と Redirect を保持してアプリへ渡す
SUBSCRIPTION_LOOP_CASES.forEach(({ kind, loop }) => {
  test(`初期 REQUEST_ERROR の retryInterval と redirect が保持される: ${kind} ループ`, async () => {
    const ctx = createNamespaceLoopTestContext(loop);
    let rejectedLoop: Error | undefined;
    const readPromise = startLoop(
      loop,
      ctx.session,
      ctx.requestId,
      () => {},
      (error) => {
        rejectedLoop = error;
      },
    );

    const payload = encodeRequestErrorPayload({
      type: MessageType.REQUEST_ERROR,
      errorCode: BigInt(RequestErrorCode.REDIRECT),
      reasonPhrase: "redirect",
      retryInterval: 37n,
      redirect: {
        connectUri: "https://example.com",
        trackNamespace: createTrackNamespace(["live"]),
        // namespace-scoped のリクエストでは Track Name は空でなければならない (§9.4.1)
        trackName: new Uint8Array(0),
      },
    });
    ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.REQUEST_ERROR, payload));
    ctx.readableController.close();
    await readPromise;

    assert.instanceOf(rejectedLoop, RequestError);
    const requestError = rejectedLoop as RequestError;
    assert.equal(requestError.code, RequestErrorCode.REDIRECT);
    assert.equal(requestError.retryInterval, 37n);
    assert.equal(requestError.redirect?.connectUri, "https://example.com");
    assert.isUndefined(ctx.getClosedWithError());
  });
});

// 確立後の REQUEST_ERROR (REQUEST_UPDATE の失敗) でも Retry Interval と Redirect を
// reject する RequestError に載せる
SUBSCRIPTION_LOOP_CASES.forEach(({ kind, loop }) => {
  test(`確立後の REQUEST_ERROR の retryInterval と redirect が載る: ${kind} ループ`, async () => {
    const ctx = createNamespaceLoopTestContext(loop);

    const pending = registerPendingUpdate(ctx.session, ctx.requestId);

    const readPromise = startLoop(
      loop,
      ctx.session,
      ctx.requestId,
      () => {},
      () => {},
    );

    ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
    const payload = encodeRequestErrorPayload({
      type: MessageType.REQUEST_ERROR,
      errorCode: BigInt(RequestErrorCode.REDIRECT),
      reasonPhrase: "update redirect",
      retryInterval: 29n,
      redirect: {
        connectUri: "https://example.com",
        trackNamespace: createTrackNamespace(["live"]),
        // namespace-scoped のリクエストでは Track Name は空でなければならない (§9.4.1)
        trackName: new Uint8Array(0),
      },
    });
    ctx.readableController.enqueue(ctx.controlWriter.encode(MessageType.REQUEST_ERROR, payload));
    ctx.readableController.close();
    await readPromise;

    assert.isFalse(pending.resolved);
    assert.isDefined(pending.rejected);
    assert.instanceOf(pending.rejected, RequestError);
    const requestError = pending.rejected as RequestError;
    assert.equal(requestError.code, RequestErrorCode.REDIRECT);
    assert.equal(requestError.retryInterval, 29n);
    assert.deepEqual(requestError.redirect, {
      connectUri: "https://example.com",
      trackNamespace: [new TextEncoder().encode("live")],
      trackName: new Uint8Array(0),
    });
    assert.isUndefined(ctx.getClosedWithError());
  });
});

// 保留中の更新が無い REQUEST_ERROR は、仕様違反として PROTOCOL_VIOLATION で閉じる
SUBSCRIPTION_LOOP_CASES.forEach(({ kind, loop }) => {
  test(`保留中の更新が無い REQUEST_ERROR は PROTOCOL_VIOLATION で閉じる: ${kind} ループ`, async () => {
    const ctx = createNamespaceLoopTestContext(loop);

    const readPromise = startLoop(
      loop,
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
});

// 確立前 GOAWAY 後も読み取りは継続し、2 通目 GOAWAY は PROTOCOL_VIOLATION で閉じる
LOOP_CASES.forEach(({ kind, loop }) => {
  test(`確立前 GOAWAY 後の 2 通目 GOAWAY で PROTOCOL_VIOLATION で閉じる: ${kind} ループ`, async () => {
    // draft-ietf-moq-transport-21 §9.2:
    // "The endpoint MUST close the session with a PROTOCOL_VIOLATION ... if it
    //  receives more than one GOAWAY ... on a single request stream."
    // 確立前 GOAWAY 後も読み取りを継続し、同一チャンクの 2 通目を検出する。
    const ctx = createNamespaceLoopTestContext(loop);

    const readPromise = startLoop(
      loop,
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
});

// ピア FIN で自方向も FIN し、graceful closure を完了する
LOOP_CASES.forEach(({ kind, loop }) => {
  test(`ピア FIN で自方向を FIN する: ${kind} ループ`, async () => {
    // draft-ietf-moq-transport-21 §6.4.2.2:
    // ピアの FIN 後、requester は自方向も FIN で閉じる (SHOULD)。
    const ctx = createNamespaceLoopTestContext(loop);

    const readPromise = startLoop(
      loop,
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
});

// unsubscribe 後の遅延 REQUEST_OK / REQUEST_ERROR を state ガードで無視する
SUBSCRIPTION_LOOP_CASES.forEach(({ kind, loop }) => {
  /**
   * unsubscribe() 相当で state を "closed" にした後に届く遅延応答は、
   * ループ冒頭の state ガードで無視され PROTOCOL_VIOLATION にならない。
   * 確立応答を feed して resolved にしてから state を閉じる実運用の流れを再現する。
   *
   * draft-ietf-moq-transport-21 §9.5.1:
   * ピアは応答を返しただけであり、購読解除後の遅延応答を仕様違反として
   * 閉じてはならない。
   */
  test(`unsubscribe 後の遅延 REQUEST_OK で PROTOCOL_VIOLATION にならない: ${kind} ループ`, async () => {
    const ctx = createNamespaceLoopTestContext(loop);
    let resolved = false;
    const readPromise = startLoop(
      loop,
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
    ctx.target.state = "closed";
    ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
    ctx.readableController.close();
    await readPromise;

    // 遅延 REQUEST_OK は state ガードで無視され、セッションは閉じない
    assert.isUndefined(ctx.getClosedWithError());
  });
});

SUBSCRIPTION_LOOP_CASES.forEach(({ kind, loop }) => {
  test(`unsubscribe 後の遅延 REQUEST_ERROR で PROTOCOL_VIOLATION にならない: ${kind} ループ`, async () => {
    const ctx = createNamespaceLoopTestContext(loop);
    let resolved = false;
    const readPromise = startLoop(
      loop,
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
    ctx.target.state = "closed";
    ctx.readableController.enqueue(
      requestErrorMessage(ctx.controlWriter, RequestErrorCode.PREFIX_OVERLAP),
    );
    ctx.readableController.close();
    await readPromise;

    // 遅延 REQUEST_ERROR は state ガードで無視され、セッションは閉じない
    assert.isUndefined(ctx.getClosedWithError());
  });
});

// REQUEST_UPDATE 応答 (REQUEST_UPDATE_OK) の検証失敗は、保留中の更新を違反
// SessionError 自体で reject してからセッションを閉じる (update() のハング防止)。
// 検証順はスコープ → Track Properties であり、どちらも prefix は反映しない。
test("namespaceStartNamespaceStreamLoop: REQUEST_UPDATE 応答のスコープ違反で保留中の更新が違反 SessionError 自体で reject される", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");

  const pending = registerPendingUpdate(ctx.session, ctx.requestId);
  ctx.subscription.pendingPrefix = ["live", "sports"];

  const readPromise = startLoop(
    "namespace",
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

  const readPromise = startLoop(
    "namespace",
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

// 正常な NAMESPACE / NAMESPACE_DONE でセッションが閉じないことは、任意の
// suffix 列を扱う PBT (namespaceLoops.prop.ts) へ移した。

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
  ctx.target.callbacks.onNamespace = () => {
    namespaceCalls++;
    throw new Error("app onNamespace failure");
  };

  const readPromise = startLoop(
    "namespace",
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
 * 通知コールバックが callbacks をレシーバとして呼ばれる (`this` が保たれる)
 * ことを検証する。関数参照だけを取り出して呼ぶとオブジェクトリテラルの
 * メソッドで `this` が失われ、握り潰しにより無言でハンドラが動かなくなる。
 */
test("namespaceStartNamespaceStreamLoop: onNamespace の this が callbacks を指す", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");
  // `this` を参照するオブジェクトリテラルのメソッドを注入する
  ctx.target.callbacks.onNamespace = function onNamespace(this: Record<string, unknown>): void {
    this.invokedWithReceiver = true;
  };

  const readPromise = startLoop(
    "namespace",
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
  ctx.readableController.close();
  await readPromise;

  assert.isTrue(ctx.target.callbacks.invokedWithReceiver === true);
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
  ctx.target.callbacks.onNamespace = () => {
    namespaceCalls++;
  };
  ctx.target.callbacks.onNamespaceDone = () => {
    namespaceDoneCalls++;
    throw new Error("app onNamespaceDone failure");
  };

  const readPromise = startLoop(
    "namespace",
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
  ctx.target.callbacks.onNamespaceDone = () => {
    namespaceDoneCalls++;
    throw new Error("app onNamespaceDone failure");
  };

  const readPromise = startLoop(
    "namespace",
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

  const readPromise = startLoop(
    "namespace",
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

test("namespaceStartNamespaceStreamLoop: 先頭 GOAWAY で New Session URI が空文字の場合は fallback 文言で reject", async () => {
  // draft-ietf-moq-transport-21 §9.2: "If the URI is zero bytes long, the current URI is reused instead"
  // クライアントからサーバへの GOAWAY は必ず空 URI (「A client MUST send a zero-length New Session URI」)
  const ctx = createNamespaceLoopTestContext("namespace");
  const notifiedUris: string[] = [];
  Object.assign(ctx.target.callbacks, {
    goaway: (uri: string) => {
      notifiedUris.push(uri);
    },
  });

  let rejectedError: Error | undefined;
  const readPromise = startLoop(
    "namespace",
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

test("namespaceStartNamespaceStreamLoop: 先頭に想定外メッセージ (NAMESPACE) は PROTOCOL_VIOLATION で閉じ、エラー文言に GOAWAY を含む", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");

  const readPromise = startLoop(
    "namespace",
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

// ピア FIN での active namespace への NAMESPACE_DONE 補完 (自方向の FIN を含む) は、
// 任意の NAMESPACE / NAMESPACE_DONE 列を扱う PBT (namespaceLoops.prop.ts) へ移した。

test("namespaceStartNamespaceStreamLoop: RESET_STREAM でも active namespace に NAMESPACE_DONE を補完する", async () => {
  // draft-ietf-moq-transport-21 §9.15: stream reset も FIN と同様に扱う。
  const ctx = createNamespaceLoopTestContext("namespace");
  const doneSuffixes: string[][] = [];
  Object.assign(ctx.target.callbacks, {
    onNamespaceDone: (suffix: string[]) => {
      doneSuffixes.push(suffix);
    },
  });

  const readPromise = startLoop(
    "namespace",
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

test("namespaceStartTracksStreamLoop: 先頭の想定外メッセージで reject し同一オブジェクトで閉じる", async () => {
  // 先頭メッセージ検証の失敗は close だけでなく呼び出し元へ reject する
  const ctx = createNamespaceLoopTestContext("tracks");

  let rejectedError: Error | undefined;
  const readPromise = startLoop(
    "tracks",
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

// 先頭メッセージガードは PUBLISH_SKIPPED のような「そのループが処理する
// メッセージ」でも、確立前は REQUEST_OK / REQUEST_ERROR / GOAWAY 以外を許さない
// (§9.18 MUST)。エラー文言に許可される 3 種とループ種別が入ることを固定する。
test("namespaceStartTracksStreamLoop: 先頭に想定外メッセージ (PUBLISH_SKIPPED) は PROTOCOL_VIOLATION で閉じ、エラー文言に GOAWAY を含む", async () => {
  const ctx = createNamespaceLoopTestContext("tracks");

  const readPromise = startLoop(
    "tracks",
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

test("namespaceStartTracksStreamLoop: 初期 REQUEST_OK のスコープ違反で reject し同一オブジェクトで閉じる", async () => {
  // 初期応答のパラメータスコープ違反も呼び出し元へ reject する
  const ctx = createNamespaceLoopTestContext("tracks");

  let rejectedError: Error | undefined;
  const readPromise = startLoop(
    "tracks",
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

// 正常なメッセージ列 (確立応答 + ループ固有の通知メッセージ) でセッションが
// 閉じないことは、任意の suffix / track name を扱う PBT (namespaceLoops.prop.ts)
// へ移した。

// ============================================================================
// 3 ループ共通: 確立前 GOAWAY / 確立後 GOAWAY / FIN (publication を含む)
// draft-ietf-moq-transport-21 §9.2 (GOAWAY) / §6.4.2.2 (FIN)
// ============================================================================

/**
 * 先頭 GOAWAY の受理ケース (3 ループで完全に同一処理)
 *
 * 確立前の GOAWAY はマイグレーション扱いで callbacks.goaway を通知し、
 * 呼び出し元の Promise を reject したうえで読み取りを継続する。
 */
LOOP_CASES.forEach(({ kind, loop }) => {
  test(`先頭 GOAWAY (resolved=false) で callbacks.goaway 通知 + Promise reject + セッション継続: ${kind} ループ`, async () => {
    const ctx = createNamespaceLoopTestContext(loop);
    const notifiedUris: string[] = [];
    let errorFired = false;
    Object.assign(ctx.target.callbacks, {
      goaway: (uri: string) => {
        notifiedUris.push(uri);
      },
      error: () => {
        errorFired = true;
      },
    });

    let rejectedError: Error | undefined;
    const readPromise = startLoop(
      loop,
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
    // finally 経路で対象が closed に遷移していること
    assert.equal(ctx.target.state, "closed");
    // 初回 GOAWAY は goawayReceivedOnRequestStreams に追加される (重複検出用)
    assert.isTrue(ctx.session.goawayReceivedOnRequestStreams.has(ctx.requestId));
    assert.isFalse(ctx.targetMap.has(ctx.requestId));
  });
});

/**
 * 確立後 GOAWAY の受理ケース (3 ループで完全に同一処理)
 *
 * 送信方向を FIN (writer.close()) で閉じ、受信方向は読み取りを継続して
 * 2 通目 GOAWAY を PROTOCOL_VIOLATION として検出する。
 */
LOOP_CASES.forEach(({ kind, loop }) => {
  test(`確立後 (resolved=true) の GOAWAY で送信方向が FIN (writer.close()) され、読み取り継続が維持される: ${kind} ループ`, async () => {
    // draft-ietf-moq-transport-21 §9.2:
    // 「the endpoint SHOULD ... close the old request stream using the appropriate
    //  mechanism (e.g. FIN, stream reset, or PUBLISH_DONE)」に従い、送信方向を FIN
    // で閉じる。受信方向は読み取り継続し 2 通目 GOAWAY は PROTOCOL_VIOLATION として
    // 検出する。
    const ctx = createNamespaceLoopTestContext(loop);
    const notifiedUris: string[] = [];
    Object.assign(ctx.target.callbacks, {
      goaway: (uri: string) => {
        notifiedUris.push(uri);
      },
    });

    const readPromise = startLoop(
      loop,
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
    const error = ctx.getClosedWithError();
    assert.isDefined(error);
    assert.equal(error!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  });
});

/**
 * 確立前 (resolved=false) の GOAWAY 後の REQUEST_ERROR のケース
 *
 * 確立前 GOAWAY の後は REQUEST_ERROR を処理せず読み取りだけを継続するため
 * (spurious な PROTOCOL_VIOLATION を防ぐ §9.2)、保留中の更新は
 * 「応答を待たずにピアがストリームを閉じた」場合と同じ経路で reject される。
 * publication ループは REQUEST_UPDATE を扱わないため subscription 系 2 ループ
 * だけを回す。
 */
SUBSCRIPTION_LOOP_CASES.forEach(({ kind, loop }) => {
  test(`GOAWAY 受信後の REQUEST_ERROR で保留中の更新が reject される: ${kind} ループ`, async () => {
    const ctx = createNamespaceLoopTestContext(loop);

    const pending = registerPendingUpdate(ctx.session, ctx.requestId);
    ctx.target.pendingPrefix = ["live", "sports"];

    const readPromise = startLoop(
      loop,
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
    // Retry Interval と Redirect も載せ、pending の reject に引き継がれることを検証する
    const errorPayload = encodeRequestErrorPayload({
      type: MessageType.REQUEST_ERROR,
      errorCode: BigInt(RequestErrorCode.REDIRECT),
      reasonPhrase: "prefix overlap",
      retryInterval: 31n,
      redirect: {
        connectUri: "https://example.com",
        trackNamespace: createTrackNamespace(["live"]),
        // namespace-scoped のリクエストでは Track Name は空でなければならない (§9.4.1)
        trackName: new Uint8Array(0),
      },
    });
    ctx.readableController.enqueue(
      ctx.controlWriter.encode(MessageType.REQUEST_ERROR, errorPayload),
    );
    ctx.readableController.close();
    await readPromise;

    // GOAWAY 後でも保留中の更新は失敗として reject される
    assert.isFalse(pending.resolved);
    assert.isDefined(pending.rejected);
    assert.equal(pending.rejected!.message, "prefix overlap");
    assert.instanceOf(pending.rejected, RequestError);
    assert.equal((pending.rejected as RequestError).retryInterval, 31n);
    assert.equal((pending.rejected as RequestError).redirect?.connectUri, "https://example.com");
    assert.deepEqual(ctx.target.namespacePrefix, ["live"]);
    assert.isUndefined(ctx.target.pendingPrefix);
    // GOAWAY 受信後はセッションを閉じない (§9.2)
    assert.isUndefined(ctx.getClosedWithError());
  });
});

// ============================================================================
// 確立前の検証失敗で Promise が reject される
// draft-ietf-moq-transport-21 §9.14 / §9.15 / §9.18:
// ピアの初期応答が仕様違反でも呼び出し元の Promise を永久ハングさせず、
// closeWithError に渡す SessionError と同一オブジェクトで reject する
// (PUBLISH 応答経路と同一パターン)。3 ループの検証内容は同一のため
// ループ種別でパラメータ化し、期待するエラー文言だけをケース側に置く。
// ============================================================================

/**
 * 先頭の想定外メッセージで reject し同一オブジェクトで閉じるケース
 *
 * 先頭メッセージ検証の失敗は close だけでなく呼び出し元へ reject する。
 * namespace / tracks は先頭メッセージガード、publication は REQUEST_OK /
 * REQUEST_ERROR / GOAWAY 以外を unknown message type として閉じる経路になる。
 */
LOOP_CASES.forEach(({ kind, loop }) => {
  test(`先頭の想定外メッセージで reject し同一オブジェクトで閉じる: ${kind} ループ`, async () => {
    const ctx = createNamespaceLoopTestContext(loop);

    let rejectedError: Error | undefined;
    const readPromise = startLoop(
      loop,
      ctx.session,
      ctx.requestId,
      () => {},
      (err) => {
        rejectedError = err;
      },
    );

    // 先頭に REQUEST_OK / REQUEST_ERROR / GOAWAY 以外のメッセージを注入する
    ctx.readableController.enqueue(firstUnexpectedMessage(loop, ctx.controlWriter));
    ctx.readableController.close();
    await readPromise;

    // reject される値は closeWithError に渡す値と同一オブジェクトである
    assert.isDefined(rejectedError);
    assert.isDefined(ctx.getClosedWithError());
    assert.strictEqual(rejectedError, ctx.getClosedWithError());
    assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
  });
});

/**
 * 初期 REQUEST_OK のパラメータスコープ違反で reject し同一オブジェクトで閉じるケース
 *
 * FORWARD は *_OK (EXPIRES のみ許可) のスコープ違反であり、期待するエラー文言に
 * ループ種別ごとのメッセージ名が入る。
 */
const INITIAL_SCOPE_VIOLATION_CASES: readonly { loop: LoopKind; okTypeName: string }[] = [
  { loop: "namespace", okTypeName: "SUBSCRIBE_NAMESPACE_OK" },
  { loop: "tracks", okTypeName: "SUBSCRIBE_TRACKS_OK" },
  { loop: "publication", okTypeName: "PUBLISH_NAMESPACE_OK" },
];

INITIAL_SCOPE_VIOLATION_CASES.forEach(({ loop, okTypeName }) => {
  test(`初期 REQUEST_OK のスコープ違反で reject し同一オブジェクトで閉じる: ${loop} ループ`, async () => {
    const ctx = createNamespaceLoopTestContext(loop);

    let rejectedError: Error | undefined;
    const readPromise = startLoop(
      loop,
      ctx.session,
      ctx.requestId,
      () => {},
      (err) => {
        rejectedError = err;
      },
    );

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
    assert.isTrue(ctx.getClosedWithError()!.message.includes(`not allowed in ${okTypeName}`));
  });
});
/**
 * 初期 REQUEST_OK の Track Properties 非空で reject し同一オブジェクトで閉じるケース
 *
 * draft-ietf-moq-transport-21 §9.3 の空必須違反も呼び出し元へ reject する。
 * tracks (SUBSCRIBE_TRACKS_OK) は空必須の列挙に含まれないためこのシナリオを
 * 持たず、namespace / publication の 2 ループを回す。
 */
const INITIAL_TRACK_PROPERTIES_CASES: readonly { loop: LoopKind; okTypeName: string }[] = [
  { loop: "namespace", okTypeName: "SUBSCRIBE_NAMESPACE_OK" },
  { loop: "publication", okTypeName: "PUBLISH_NAMESPACE_OK" },
];

INITIAL_TRACK_PROPERTIES_CASES.forEach(({ loop, okTypeName }) => {
  test(`初期 REQUEST_OK の Track Properties 非空で reject し同一オブジェクトで閉じる: ${loop} ループ`, async () => {
    const ctx = createNamespaceLoopTestContext(loop);

    let rejectedError: Error | undefined;
    const readPromise = startLoop(
      loop,
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
      ctx.getClosedWithError()!.message.includes(`track properties must be empty in ${okTypeName}`),
    );
  });
});

/**
 * REQUEST_UPDATE_OK の未知 Mandatory Track Property で PROTOCOL_VIOLATION で閉じるケース
 *
 * draft-ietf-moq-transport-21 §9.3:
 * 確立後の REQUEST_UPDATE_OK は Track Properties が空必須であり、未知 Mandatory
 * Track Property を含めた場合は PROTOCOL_VIOLATION で閉じ、保留中の更新を違反
 * SessionError 自体で reject する (update() のハング防止)。prefix は反映しない。
 * publication ループは REQUEST_UPDATE を扱わないため subscription 系 2 ループだけを回す。
 */
SUBSCRIPTION_LOOP_CASES.forEach(({ kind, loop }) => {
  test(`REQUEST_UPDATE 応答の未知 Mandatory Track Property で PROTOCOL_VIOLATION で閉じる: ${kind} ループ`, async () => {
    const ctx = createNamespaceLoopTestContext(loop);

    const pending = registerPendingUpdate(ctx.session, ctx.requestId);
    ctx.target.pendingPrefix = ["live", "sports"];

    const readPromise = startLoop(
      loop,
      ctx.session,
      ctx.requestId,
      () => {},
      () => {},
    );

    ctx.readableController.enqueue(requestOkMessage(ctx.controlWriter));
    ctx.readableController.enqueue(
      requestOkMessage(ctx.controlWriter, [{ id: 0x4000n, value: 1n }]),
    );
    ctx.readableController.close();
    await readPromise;

    assert.isDefined(ctx.getClosedWithError());
    assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
    assert.isFalse(pending.resolved);
    assert.strictEqual(pending.rejected, ctx.getClosedWithError());
    assert.deepEqual(ctx.target.namespacePrefix, ["live"]);
    // 違反で reject した更新の pendingPrefix はクリアされる (次回 update() を妨げない)
    assert.isUndefined(ctx.target.pendingPrefix);
  });
});

test("namespaceStartPublicationStreamLoop: 想定外の先頭メッセージで reject し同一オブジェクトで閉じる", async () => {
  // 想定外の先頭メッセージは close だけでなく呼び出し元へ reject する
  const ctx = createNamespaceLoopTestContext("publication");

  let rejectedError: Error | undefined;
  const readPromise = startLoop(
    "publication",
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
  const ctx = createNamespaceLoopTestContext("publication");

  let resolvedCount = 0;
  let rejectedError: Error | undefined;
  const readPromise = startLoop(
    "publication",
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
  const ctx = createNamespaceLoopTestContext("publication");

  let resolvedCount = 0;
  let rejectedError: Error | undefined;
  const readPromise = startLoop(
    "publication",
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

// 2 通目 REQUEST_OK が未知 Mandatory Track Property でデコードできない場合も、
// PUBLISH_NAMESPACE_OK は Track Properties が空必須 (§9.3) のため
// PROTOCOL_VIOLATION で閉じる (namespaceDecodeRequestOkWithoutTrackProperties 経由)。
test("namespaceStartPublicationStreamLoop: 確立後の 2 通目 REQUEST_OK の未知 Mandatory Track Property で PROTOCOL_VIOLATION で閉じる", async () => {
  const ctx = createNamespaceLoopTestContext("publication");

  const readPromise = startLoop(
    "publication",
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
// 既知 Type の serialization 不一致 (KEY_VALUE_FORMATTING_ERROR) で閉じる
// draft-ietf-moq-transport-21 §8.3 (Key-Value-Pair Structure) / §9.3
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9 / §9.3:
 * ループ内のメッセージデコードが IncompleteDataError (Length が揃った後の
 * フィールド構造の破損) の場合、黙殺されず PROTOCOL_VIOLATION でセッションが
 * 閉じることを検証する。変換は toSessionCloseError
 * (受信メッセージのデコード失敗は PROTOCOL_VIOLATION として扱うリポジトリ
 * 共通解釈) が行うため、デコーダの短縮ペイロードを feed すればよい。
 */
LOOP_CASES.forEach(({ kind, loop }) => {
  test(`破損 REQUEST_OK は PROTOCOL_VIOLATION で閉じる: ${kind} ループ`, async () => {
    const ctx = createNamespaceLoopTestContext(loop);

    const readPromise = startLoop(
      loop,
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
    // finally で対象が掃除される
    assert.isFalse(ctx.targetMap.has(ctx.requestId));
  });
});

/**
 * malformed な Track Properties を含む *_OK を受信したら
 * KEY_VALUE_FORMATTING_ERROR でセッションを閉じるケース
 *
 * 確立前の失敗は呼び出し元へ close と同一オブジェクトで reject してから閉じ、
 * finally で対象が掃除される。namespace ループのテストだけが reject が close より
 * 先であることを検証しているため、その検証はケース側のフラグで切り替える
 * (検証内容を増減させないため)。
 */
const MALFORMED_REQUEST_OK_CASES: readonly { loop: LoopKind; rejectsBeforeClose: boolean }[] = [
  { loop: "namespace", rejectsBeforeClose: true },
  { loop: "tracks", rejectsBeforeClose: false },
  { loop: "publication", rejectsBeforeClose: false },
];

MALFORMED_REQUEST_OK_CASES.forEach(({ loop, rejectsBeforeClose }) => {
  test(`malformed な REQUEST_OK で KEY_VALUE_FORMATTING_ERROR で閉じる: ${loop} ループ`, async () => {
    const ctx = createNamespaceLoopTestContext(loop);

    let rejectedError: Error | undefined;
    // reject が close より先であることを、reject 時点でまだ閉じていないことで検証する
    let rejectedBeforeClose = false;
    const readPromise = startLoop(
      loop,
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
    if (rejectsBeforeClose) {
      assert.isTrue(rejectedBeforeClose);
    }
    assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
    // finally で対象が掃除される
    assert.isFalse(ctx.targetMap.has(ctx.requestId));
  });
});

// ============================================================================
// 空必須メッセージの未知 Mandatory Track Property
// draft-ietf-moq-transport-21 §9.3 (REQUEST_OK) / §3.6 (Mandatory Track Properties)
// ============================================================================

/**
 * 初期 *_OK の未知 Mandatory Track Property で PROTOCOL_VIOLATION で閉じるケース
 *
 * draft-ietf-moq-transport-21 §9.3:
 * 「they are empty in PUBLISH_OK, REQUEST_UPDATE_OK, SUBSCRIBE_NAMESPACE_OK and
 *  PUBLISH_NAMESPACE_OK.  If an endpoint receives Track Properties in one of
 *  these messages it MUST close the session with a PROTOCOL_VIOLATION.」
 * 未知 Mandatory Track Property (0x4000-0x7FFF) は decodeProperties が
 * MalformedTrackError を throw するため、初期 OK では PROTOCOL_VIOLATION へ変換して
 * 閉じ、確立前の購読 / 公開の Promise を reject する。
 *
 * tracks (SUBSCRIBE_TRACKS_OK) は §9.3 の空必須の列挙に含まれず Track Properties を
 * 運べるため、このシナリオを持たず namespace / publication の 2 ループを回す。
 */
const INITIAL_UNKNOWN_MANDATORY_CASES: readonly LoopKind[] = ["namespace", "publication"];

INITIAL_UNKNOWN_MANDATORY_CASES.forEach((loop) => {
  test(`初期 *_OK の未知 Mandatory Track Property で PROTOCOL_VIOLATION で閉じる: ${loop} ループ`, async () => {
    const ctx = createNamespaceLoopTestContext(loop);
    let rejectedError: Error | undefined;

    const readPromise = startLoop(
      loop,
      ctx.session,
      ctx.requestId,
      () => {},
      (err) => {
        rejectedError = err;
      },
    );

    ctx.readableController.enqueue(
      requestOkMessage(ctx.controlWriter, [{ id: 0x4000n, value: 1n }]),
    );
    ctx.readableController.close();
    await readPromise;

    // 確立前の違反は呼び出し元の Promise を reject してから閉じる
    assert.isDefined(ctx.getClosedWithError());
    assert.equal(ctx.getClosedWithError()!.code, SessionErrorCode.PROTOCOL_VIOLATION);
    assert.isTrue(ctx.getClosedWithError()!.message.includes("unknown mandatory track property"));
    assert.strictEqual(rejectedError, ctx.getClosedWithError());
  });
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

// ============================================================================
// error コールバックの例外で後始末が止まらないこと
//
// 購読 / 公開単位の callbacks.error が throw しても、通知の失敗で後始末
// (確立前 Promise の reject・保留中 REQUEST_UPDATE の reject・
// 該当時の session.closeWithError) が中断されないこと。
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §8.3 / §9.3:
 * error コールバックが throw しても、malformed な Track Properties の通知後に
 * 確立前 Promise の reject とセッションクローズが実行されることを検証する。
 * 通知は 1 回だけで、二重通知にならない。
 */
LOOP_CASES.forEach(({ kind, loop }) => {
  test(`error コールバックの throw を無視して reject とセッションクローズが実行される: ${kind} ループ`, async () => {
    const ctx = createNamespaceLoopTestContext(loop);
    const notifiedMessages: string[] = [];
    Object.assign(ctx.target.callbacks, {
      error: (error: Error): void => {
        notifiedMessages.push(error.message);
        throw new Error("app error callback failure");
      },
    });

    let rejectedError: Error | undefined;
    const readPromise = startLoop(
      loop,
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
    // finally で対象が掃除される
    assert.isFalse(ctx.targetMap.has(ctx.requestId));
    // アプリの error コールバックの throw は REQUEST_CALLBACK_ERROR として記録される
    assertRequestCallbackErrorRecord(ctx.debugRecords, {
      requestId: ctx.requestId,
      message: "app error callback failure",
    });
  });
});

/**
 * draft-ietf-moq-transport-21 §9.5.1:
 * resolved 後の read 失敗 (RESET_STREAM 相当) でも、error コールバックの throw に
 * かかわらず保留中 REQUEST_UPDATE が reject されることを検証する。
 * publication ループは REQUEST_UPDATE を扱わないため subscription 系 2 ループだけを回す。
 */
SUBSCRIPTION_LOOP_CASES.forEach(({ kind, loop }) => {
  test(`error コールバックの throw を無視して保留中の更新が reject される: ${kind} ループ`, async () => {
    const ctx = createNamespaceLoopTestContext(loop);
    let notifyCount = 0;
    Object.assign(ctx.target.callbacks, {
      error: (): void => {
        notifyCount += 1;
        throw new Error("app error callback failure");
      },
    });

    const pending = registerPendingUpdate(ctx.session, ctx.requestId);
    ctx.target.pendingPrefix = ["live", "sports"];

    const readPromise = startLoop(
      loop,
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
    // 失敗した更新の prefix は反映されない
    assert.deepEqual(ctx.target.namespacePrefix, ["live"]);
    assert.isUndefined(ctx.target.pendingPrefix);
    // RESET_STREAM (read 例外) はセッションを閉じない
    assert.isUndefined(ctx.getClosedWithError());
    // アプリの error コールバックの throw は REQUEST_CALLBACK_ERROR として記録される
    assertRequestCallbackErrorRecord(ctx.debugRecords, {
      requestId: ctx.requestId,
      message: "app error callback failure",
    });
  });
});

/**
 * draft-ietf-moq-transport-21 §8.3 / §9.3:
 * error コールバックが throw しても、デコード破損 (IncompleteDataError) の通知後に
 * 確立前 Promise の reject とセッションクローズが実行されることを検証する。
 * reject は受信した IncompleteDataError のまま、close は PROTOCOL_VIOLATION へ変換される。
 */
test("namespaceStartNamespaceStreamLoop: error コールバックの throw を無視して破損メッセージでセッションが閉じる", async () => {
  const ctx = createNamespaceLoopTestContext("namespace");
  Object.assign(ctx.subscription.callbacks, {
    error: (): void => {
      throw new Error("app error callback failure");
    },
  });

  let rejectedError: Error | undefined;
  const readPromise = startLoop(
    "namespace",
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
  // アプリの error コールバックの throw は REQUEST_CALLBACK_ERROR として記録される
  assertRequestCallbackErrorRecord(ctx.debugRecords, {
    requestId: ctx.requestId,
    message: "app error callback failure",
  });
});

/**
 * 確立前 REQUEST_ERROR の通知で error コールバックが throw しても、
 * 確立前 Promise が reject されることを検証する。
 * リクエスト失敗はセッションを閉じず、finally で対象が掃除される。
 */
LOOP_CASES.forEach(({ kind, loop }) => {
  test(`確立前 REQUEST_ERROR で error コールバックの throw を無視して reject する: ${kind} ループ`, async () => {
    const ctx = createNamespaceLoopTestContext(loop);
    let notifyCount = 0;
    Object.assign(ctx.target.callbacks, {
      error: (): void => {
        notifyCount += 1;
        throw new Error("app error callback failure");
      },
    });

    let rejectedError: Error | undefined;
    const readPromise = startLoop(
      loop,
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
    // finally で対象が掃除される
    assert.isFalse(ctx.targetMap.has(ctx.requestId));
    // アプリの error コールバックの throw は REQUEST_CALLBACK_ERROR として記録される
    assertRequestCallbackErrorRecord(ctx.debugRecords, {
      requestId: ctx.requestId,
      message: "app error callback failure",
    });
  });
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.2 / §6.4.2.3:
 * 確立前に REQUEST_ERROR を受信したら、送信方向を FIN し、受信方向を cancel
 * (STOP_SENDING 相当) してストリームをライブラリの管理外に残さない。
 */
LOOP_CASES.forEach(({ kind, loop }) => {
  test(`確立前 REQUEST_ERROR で送信方向を FIN し受信方向を cancel する: ${kind} ループ`, async () => {
    const ctx = createNamespaceLoopTestContext(loop);
    let rejectedError: Error | undefined;
    const readPromise = startLoop(
      loop,
      ctx.session,
      ctx.requestId,
      () => {},
      (err) => {
        rejectedError = err;
      },
    );

    // REQUEST_OK を挟まずに REQUEST_ERROR (リクエスト失敗) を受信する。
    // readable を close すると cancel を観測できないため FIN はしない。
    ctx.readableController.enqueue(
      requestErrorMessage(ctx.controlWriter, RequestErrorCode.PREFIX_OVERLAP),
    );
    await readPromise;

    assert.isDefined(rejectedError);
    // 送信方向が FIN され、受信方向が cancel されている
    await ctx.writerClosed();
    assert.isTrue(ctx.isReadableCancelled());
    // セッションは閉じず、finally で対象が掃除される
    assert.isUndefined(ctx.getClosedWithError());
    assert.isFalse(ctx.targetMap.has(ctx.requestId));
  });
});
