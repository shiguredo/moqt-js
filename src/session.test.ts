/**
 * SessionImpl の単体テスト
 *
 * WebTransport のモックを渡して SessionImpl を構築し、送信前検証をテストする。
 */

import { test, assert } from "vite-plus/test";
import { SessionImpl, type TracksSubscriptionCallbacks } from "./session";
import { ControlStreamWriter, ControlStreamReader } from "./controlStream";
import { MessageType, encodeGoawayPayload } from "./message";
import { encodePublishPayload } from "./message/publish";
import { createTrackNamespace } from "./message/parameter";
import type { RangeFilterSpec } from "./message/parameter";
import { FetcherImpl } from "./fetcher";
import { MalformedTrackError, RequestError, RequestErrorCode } from "./error";
import {
  FetchHeaderType,
  FetchSerializationFlags,
  type FetchObjectFields,
  encodeFetchHeader,
  encodeFetchObjectFields,
  createFirstFetchObjectFlags,
  decodeFetchObjectFields,
} from "./dataStream";
import { bidiCancelFetch, type BidiSessionInternal } from "./session/bidi";

/**
 * SessionImpl を構築するための WebTransport モック
 *
 * 検証が throw する経路のテストでは、それより後 (createBidirectionalStream 等) に
 * 到達しないため、transport は最小限のプロパティのみでよい。
 */
function createSessionImpl(): SessionImpl {
  const transport = {
    closed: new Promise<WebTransportCloseInfo>(() => {}),
  } as unknown as WebTransport;
  return new SessionImpl(transport, {});
}

/**
 * draft-ietf-moq-transport-19 §10.12.3 (Fetch Handling):
 * "End Location MUST specify the same or a larger Location than Start
 *  Location for Standalone and Absolute Joining Fetches."
 * 不正な範囲をワイヤに載せないよう送信前に throw することを検証する。
 */
test("fetch: End Location の Group が Start Location より小さい場合は throw する", async () => {
  const session = createSessionImpl();

  let thrown: Error | undefined;
  try {
    await session.fetch(
      ["live"],
      "video",
      {
        startLocation: { group: 2n, object: 0n },
        endLocation: { group: 1n, object: 0n },
      },
      { object: () => {} },
    );
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("is smaller than start location"));
});

test("fetch: 同一 Group 内で End Location の Object が小さい場合は throw する", async () => {
  const session = createSessionImpl();

  let thrown: Error | undefined;
  try {
    await session.fetch(
      ["live"],
      "video",
      {
        startLocation: { group: 1n, object: 5n },
        endLocation: { group: 1n, object: 4n },
      },
      { object: () => {} },
    );
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("is smaller than start location"));
});

test("fetch: End Location が Start Location と等しい場合は Location 検証で throw しない", async () => {
  const session = createSessionImpl();

  let thrown: Error | undefined;
  try {
    await session.fetch(
      ["live"],
      "video",
      {
        startLocation: { group: 1n, object: 0n },
        endLocation: { group: 1n, object: 0n },
      },
      { object: () => {} },
    );
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  // Location 検証は通過する。後続の送信経路 (controlWriter 未初期化等) のエラーは対象外
  assert.isNull(thrown?.message.match(/is smaller than start location/) ?? null);
});

/**
 * draft-ietf-moq-transport-19 §10.3.1.6 (MAX FILTER RANGES):
 * ピアの MAX_FILTER_RANGES が 0 (未広告) の状態で FETCH の rangeFilters を
 * 指定すると throw することを検証する。
 * ガードは pendingFetch.set より前に配置されるため、pending エントリが残らない。
 */
test("fetch: peer MAX_FILTER_RANGES が 0 のとき rangeFilters 指定で throw する", async () => {
  const session = createSessionImpl();

  let thrown: Error | undefined;
  try {
    await session.fetch(
      ["live"],
      "video",
      {
        startLocation: { group: 0n, object: 0n },
        endLocation: { group: 1n, object: 0n },
        rangeFilters: [{ type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 1n }] }],
      },
      { object: () => {} },
    );
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("MAX_FILTER_RANGES is 0"));
  // ガードは pendingFetch.set より前に配置されるため、pending エントリが残らない
  assert.equal((session as unknown as { pendingFetch: Map<bigint, unknown> }).pendingFetch.size, 0);
});

/**
 * draft-ietf-moq-transport-19 §5.1.3:
 * FETCH で削除 (Length=0) を指定すると throw することを検証する。
 * ガードは pendingFetch.set より前に配置されるため、pending エントリが残らない。
 */
test("fetch: 削除指定の rangeFilters で throw する", async () => {
  const session = createSessionImpl();
  // MAX_FILTER_RANGES ガードを通過させるため、ピアの上限を設定する
  session.peerMaxFilterRanges = 10;

  let thrown: Error | undefined;
  try {
    await session.fetch(
      ["live"],
      "video",
      {
        startLocation: { group: 0n, object: 0n },
        endLocation: { group: 1n, object: 0n },
        rangeFilters: [{ type: "objectId", remove: true }],
      },
      { object: () => {} },
    );
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("cannot remove range filters in FETCH"));
  assert.equal((session as unknown as { pendingFetch: Map<bigint, unknown> }).pendingFetch.size, 0);
});

/**
 * draft-ietf-moq-transport-19 §5.1.3:
 * 受信 PUBLISH の Track Properties が TRACK_PROPERTY_FILTER に合致しない場合、
 * onPublish が呼ばれず REQUEST_ERROR (UNINTERESTED) で応答されることを検証する。
 *
 * handleIncomingBidirectionalStream は private のため、SessionImpl を
 * `as unknown as` でキャストして駆動する (実 W3C ストリーム注入方式)。
 */
test("受信 PUBLISH で TRACK_PROPERTY_FILTER 不通過なら onPublish が呼ばれず UNINTERESTED 応答", async () => {
  const session = createSessionImpl();
  const sessionInternal = session as unknown as {
    tracksSubscriptions: Map<
      bigint,
      {
        callbacks: TracksSubscriptionCallbacks;
        state: "active" | "closed";
        namespacePrefix: string[];
        rangeFilters?: RangeFilterSpec[];
      }
    >;
    receivedRequestIds: Set<bigint>;
    subscribersByAlias: Map<bigint, unknown[]>;
    controlWriter: ControlStreamWriter | undefined;
    emitDebug: () => void;
    handleIncomingBidirectionalStream: (stream: WebTransportBidirectionalStream) => Promise<void>;
  };

  let onPublishCalled = false;
  // TRACK_PROPERTY_FILTER: propertyType 0x30 の値が 100 のみ通過するフィルタ
  sessionInternal.tracksSubscriptions.set(1n, {
    callbacks: {
      onPublish: async () => {
        onPublishCalled = true;
        return { object: () => {} };
      },
      onNamespaceDone: () => {},
      onPublishSkipped: () => {},
    } as TracksSubscriptionCallbacks,
    state: "active",
    namespacePrefix: ["live"],
    rangeFilters: [
      {
        type: "trackProperty",
        setId: 0,
        propertyType: 0x20n,
        ranges: [{ start: 100n, end: 100n }],
      },
    ],
  });
  sessionInternal.receivedRequestIds = new Set();
  sessionInternal.subscribersByAlias = new Map();

  // 受信 PUBLISH: trackProperties に propertyType 0x30 の値 50 を持つ (フィルタ不通過)
  const publishPayload = encodePublishPayload({
    type: MessageType.PUBLISH,
    requestId: 1n,
    trackNamespace: createTrackNamespace(["live"]),
    trackName: new TextEncoder().encode("track"),
    trackAlias: 1n,
    parameters: [],
    trackProperties: [{ id: 0x20n, value: 50n }],
  });
  const controlWriter = new ControlStreamWriter();
  const framed = controlWriter.encode(MessageType.PUBLISH, publishPayload);

  // 受信ストリームを注入する (READ 方向に PUBLISH、WRITE 方向に REQUEST_ERROR が来る)
  const written: Uint8Array[] = [];
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(framed);
      controller.close();
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      written.push(chunk);
    },
  });
  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;

  await sessionInternal.handleIncomingBidirectionalStream(stream);

  // onPublish は呼ばれず、REQUEST_ERROR (UNINTERESTED) が書き込まれる
  assert.isFalse(onPublishCalled);
  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
});

/**
 * draft-ietf-moq-transport-19 §5.1.3:
 * 受信 PUBLISH の Track Properties が TRACK_PROPERTY_FILTER に合致する場合、
 * onPublish が呼ばれることを検証する。
 */
test("受信 PUBLISH で TRACK_PROPERTY_FILTER 通過なら onPublish が呼ばれる", async () => {
  const session = createSessionImpl();
  const sessionInternal = session as unknown as {
    tracksSubscriptions: Map<
      bigint,
      {
        callbacks: TracksSubscriptionCallbacks;
        state: "active" | "closed";
        namespacePrefix: string[];
        rangeFilters?: RangeFilterSpec[];
      }
    >;
    receivedRequestIds: Set<bigint>;
    subscribersByAlias: Map<bigint, unknown[]>;
    handleIncomingBidirectionalStream: (stream: WebTransportBidirectionalStream) => Promise<void>;
  };

  let onPublishCalled = false;
  // TRACK_PROPERTY_FILTER: propertyType 0x30 の値が 100 のみ通過するフィルタ
  sessionInternal.tracksSubscriptions.set(1n, {
    callbacks: {
      onPublish: async () => {
        onPublishCalled = true;
        return { object: () => {} };
      },
      onNamespaceDone: () => {},
      onPublishSkipped: () => {},
    } as TracksSubscriptionCallbacks,
    state: "active",
    namespacePrefix: ["live"],
    rangeFilters: [
      {
        type: "trackProperty",
        setId: 0,
        propertyType: 0x20n,
        ranges: [{ start: 100n, end: 100n }],
      },
    ],
  });
  sessionInternal.receivedRequestIds = new Set();
  sessionInternal.subscribersByAlias = new Map();

  // 受信 PUBLISH: trackProperties に propertyType 0x30 の値 100 を持つ (フィルタ通過)
  const publishPayload = encodePublishPayload({
    type: MessageType.PUBLISH,
    requestId: 1n,
    trackNamespace: createTrackNamespace(["live"]),
    trackName: new TextEncoder().encode("track"),
    trackAlias: 1n,
    parameters: [],
    trackProperties: [{ id: 0x20n, value: 100n }],
  });
  const controlWriter = new ControlStreamWriter();
  const framed = controlWriter.encode(MessageType.PUBLISH, publishPayload);

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(framed);
      controller.close();
    },
  });
  const writable = new WritableStream<Uint8Array>({});
  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;

  await sessionInternal.handleIncomingBidirectionalStream(stream);

  assert.isTrue(onPublishCalled);
});

/**
 * draft-ietf-moq-transport-19 §10.4:
 * 受信 PUBLISH ストリーム (runPublishStreamSubLoop) で GOAWAY を受信した場合、
 * 旧ストリーム上の未応答 REQUEST_UPDATE の update() の Promise が reject され、
 * エントリが削除されることを検証する。
 */
test("受信 PUBLISH ストリーム上の GOAWAY 受信で応答待ちの REQUEST_UPDATE が reject されエントリが削除される", async () => {
  const session = createSessionImpl();
  const sessionInternal = session as unknown as {
    tracksSubscriptions: Map<
      bigint,
      {
        callbacks: TracksSubscriptionCallbacks;
        state: "active" | "closed";
        namespacePrefix: string[];
        rangeFilters?: RangeFilterSpec[];
      }
    >;
    receivedRequestIds: Set<bigint>;
    subscribersByAlias: Map<bigint, unknown[]>;
    pendingRequestUpdate: Map<
      bigint,
      {
        resolve: () => void;
        reject: (err: Error) => void;
        targetRequestId: bigint;
      }
    >;
    handleIncomingBidirectionalStream: (stream: WebTransportBidirectionalStream) => Promise<void>;
  };

  sessionInternal.tracksSubscriptions.set(1n, {
    callbacks: {
      onPublish: async () => {
        return { object: () => {} };
      },
      onNamespaceDone: () => {},
      onPublishSkipped: () => {},
    } as TracksSubscriptionCallbacks,
    state: "active",
    namespacePrefix: ["live"],
  });
  sessionInternal.receivedRequestIds = new Set();
  sessionInternal.subscribersByAlias = new Map();

  // GOAWAY 前に送信済みで応答待ちの REQUEST_UPDATE を注入する
  // (publishRequestId = 1n を targetRequestId とする)
  let rejected: Error | undefined;
  sessionInternal.pendingRequestUpdate.set(100n, {
    resolve: () => {},
    reject: (err: Error) => {
      rejected = err;
    },
    targetRequestId: 1n,
  });

  // 受信 PUBLISH を feed して subscriber を確立し、その後 GOAWAY を feed する
  const publishPayload = encodePublishPayload({
    type: MessageType.PUBLISH,
    requestId: 1n,
    trackNamespace: createTrackNamespace(["live"]),
    trackName: new TextEncoder().encode("track"),
    trackAlias: 1n,
    parameters: [],
    trackProperties: [],
  });
  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "moqt://new.example.com",
    timeout: 0n,
  });
  const controlWriter = new ControlStreamWriter();
  const publishFramed = controlWriter.encode(MessageType.PUBLISH, publishPayload);
  const goawayFramed = controlWriter.encode(MessageType.GOAWAY, goawayPayload);

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(publishFramed);
      controller.enqueue(goawayFramed);
      controller.close();
    },
  });
  const writable = new WritableStream<Uint8Array>({});
  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;

  await sessionInternal.handleIncomingBidirectionalStream(stream);

  // GOAWAY 受信時点で未応答 REQUEST_UPDATE が reject され、エントリが削除される
  assert.isDefined(rejected);
  assert.instanceOf(rejected, RequestError);
  assert.equal((rejected as RequestError).code, RequestErrorCode.GOING_AWAY);
  assert.equal(sessionInternal.pendingRequestUpdate.size, 0);
});

/** Uint8Array 配列を連結するヘルパー */
function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/** SessionImpl.requestStreams のエントリ型 (テストから注入するための複製) */
interface RequestStreamEntry {
  stream: WebTransportBidirectionalStream;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  controlReader: ControlStreamReader;
}

/** createFetchPriorityMismatchContext が返す検証用コンテキスト */
interface FetchPriorityMismatchContext {
  internal: {
    fetchers: Map<bigint, FetcherImpl>;
    requestStreams: Map<bigint, RequestStreamEntry>;
    handleIncomingStream(stream: ReadableStream<Uint8Array>): Promise<void>;
  };
  sessionError: { current: Error | undefined };
  receivedError: { current: Error | undefined };
  bidiCancelledReason: { current: string | undefined };
  dataCancelledReason: { current: string | undefined };
  enqueue: (data: Uint8Array) => void;
  run: () => Promise<void>;
}

/**
 * FETCH 応答で同一 Group・同一 Subgroup の Publisher Priority 不一致を検出した
 * 場合の処理を検証するためのコンテキストを構築する。
 *
 * draft-ietf-moq-transport-19 §2.4.2 (Malformed Tracks):
 * Malformed Track 検出時は「cancel any corresponding subscription or fetches
 * for that Track from that publisher」であり、セッションを閉じない。
 * draft-ietf-moq-transport-19 §5.2 (Fetch State Management):
 * キャンセル時は「It MUST send STOP_SENDING for the bidi request stream.」
 *
 * fetchers / requestStreams は FETCH 確立後の状態 (bidiSendRequestOnBidiStream が
 * 新規 bidi ストリームを requestStreams に登録済み) を直接再現して注入する。
 */
function createFetchPriorityMismatchContext(requestId: bigint): FetchPriorityMismatchContext {
  // セッションが誤って閉じたことを検出するため、error コールバックを記録する
  const sessionError: { current: Error | undefined } = { current: undefined };
  const transport = {
    closed: new Promise<WebTransportCloseInfo>(() => {}),
  } as unknown as WebTransport;
  const session = new SessionImpl(transport, {
    error: (error) => {
      sessionError.current = error;
    },
  });

  const internal = session as unknown as {
    fetchers: Map<bigint, FetcherImpl>;
    requestStreams: Map<bigint, RequestStreamEntry>;
    handleIncomingStream(stream: ReadableStream<Uint8Array>): Promise<void>;
  };

  // error コールバックを記録する FetcherImpl
  const receivedError: { current: Error | undefined } = { current: undefined };
  const fetcher = new FetcherImpl(
    ["live"],
    "video",
    requestId,
    () => {},
    undefined,
    (error) => {
      receivedError.current = error;
    },
  );

  // fetch() 実装と同じ挙動になるよう onCancel を bidiCancelFetch に配線する
  // (fetch() 実装は this.cancelFetch を経由して bidiCancelFetch を呼ぶ)
  fetcher.onCancel = async () => {
    await bidiCancelFetch(internal as unknown as BidiSessionInternal, fetcher);
  };

  // bidi リクエストストリーム (STOP_SENDING 検証用)
  const bidiCancelledReason: { current: string | undefined } = { current: undefined };
  const bidiReadable = new ReadableStream<Uint8Array>({
    cancel(reason) {
      bidiCancelledReason.current = reason as string;
    },
  });
  const bidiWritable = new WritableStream<Uint8Array>();
  const bidiStream = {
    readable: bidiReadable,
    writable: bidiWritable,
  } as unknown as WebTransportBidirectionalStream;
  const bidiWriter = bidiWritable.getWriter();

  internal.fetchers.set(requestId, fetcher);
  internal.requestStreams.set(requestId, {
    stream: bidiStream,
    writer: bidiWriter,
    controlReader: new ControlStreamReader(),
  });

  // FETCH データストリーム (受信データストリームの cancel を記録する)
  const dataCancelledReason: { current: string | undefined } = { current: undefined };
  let dataController!: ReadableStreamDefaultController<Uint8Array>;
  const dataStream = new ReadableStream<Uint8Array>({
    start(controller) {
      dataController = controller;
    },
    cancel(reason) {
      dataCancelledReason.current = reason as string;
    },
  });

  return {
    internal,
    sessionError,
    receivedError,
    bidiCancelledReason,
    dataCancelledReason,
    enqueue: (data: Uint8Array) => {
      dataController.enqueue(data);
    },
    run: () => internal.handleIncomingStream(dataStream),
  };
}

/**
 * 同一 Group・同一 Subgroup で Publisher Priority 不一致を含む FETCH データ
 * ストリームのチャンク列を構築する。
 *
 * draft-ietf-moq-transport-19 §2.4.2:
 * 先頭オブジェクト (Priority 100) の後に、同一 Group・同一 Subgroup で異なる
 * Priority (200) のオブジェクトを続ける。
 *
 * チャンク 1: FETCH ヘッダー + 先頭オブジェクト
 * チャンク 2: Priority 不一致のオブジェクト
 * 1 チャンク目でまとめて流すことも、2 チャンクに分割して流すこともできる。
 */
function buildPriorityMismatchFetchChunks(requestId: bigint): Uint8Array[] {
  // 先頭オブジェクト (Group 10, Subgroup 1, Priority 100)
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(),
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 0n,
  };
  const firstEncoded = encodeFetchObjectFields(first);

  // コンテキスト (objectId delta 計算用) を先頭オブジェクトから求める
  const [, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);

  // 同一 Group・同一 Subgroup で異なる Priority (200) のオブジェクト
  const second: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_SAME |
      FetchSerializationFlags.OBJECT_ID_PRESENT |
      FetchSerializationFlags.PRIORITY_PRESENT,
    objectId: 1n,
    publisherPriority: 200,
    payloadLength: 0n,
  };
  const secondEncoded = encodeFetchObjectFields(second, false, firstContext);

  return [
    concatUint8Arrays([encodeFetchHeader({ type: FetchHeaderType, requestId }), firstEncoded]),
    secondEncoded,
  ];
}

/**
 * Priority 不一致検出時の FETCH キャンセル処理の検証アサーション群
 *
 * セッション不閉鎖 / データストリーム打ち切り / bidi リクエストストリームへの
 * STOP_SENDING / fetchers・requestStreams からの削除 / error コールバック通知を
 * 一括で検証する。
 */
function assertFetchCancelledOnPriorityMismatch(ctx: FetchPriorityMismatchContext): void {
  // セッションは閉じない
  assert.isUndefined(ctx.sessionError.current);
  // 受信データストリームは STOP_SENDING 相当で打ち切られる
  assert.isDefined(ctx.dataCancelledReason.current);
  assert.isTrue(ctx.dataCancelledReason.current!.includes("malformed track"));
  // §5.2 の MUST に従い bidi リクエストストリームへ STOP_SENDING が送られる
  assert.equal(ctx.bidiCancelledReason.current, "fetch cancelled");
  // fetchers / requestStreams から削除される
  assert.equal(ctx.internal.fetchers.size, 0);
  assert.equal(ctx.internal.requestStreams.size, 0);
  // error コールバックが MalformedTrackError で呼ばれる
  assert.instanceOf(ctx.receivedError.current, MalformedTrackError);
  assert.match(
    // 直前に assert.instanceOf で MalformedTrackError を確認済みのため安全
    ctx.receivedError.current!.message,
    /malformed track: different priorities in same subgroup/,
  );
}

/**
 * draft-ietf-moq-transport-19 §2.4.2:
 * FETCH 応答で同一 Group・同一 Subgroup の Publisher Priority 不一致を検出しても
 * セッションが閉じず、対象 FETCH がキャンセルされることを検証する。
 *
 * - 受信データストリームは STOP_SENDING 相当 (cancelStreamQuiet) で打ち切られる
 * - draft-ietf-moq-transport-19 §5.2 の MUST に従い、bidi リクエストストリームへ
 *   STOP_SENDING (readable.cancel) が送られる
 * - fetchers / requestStreams から削除される
 * - error コールバックが MalformedTrackError で呼ばれる
 *
 * この検証は fetch() / bidiSendJoiningFetch のどちらで登録された FETCH にも共通に
 * 適用される。両者は bidiSendRequestOnBidiStream で新規 bidi ストリームを開いて
 * requestStreams に登録するため (§10.12「A subscriber sends FETCH as the first
 * message on a new bidi stream」)、Joining Fetch のデータストリームで検出した場合も
 * Standalone Fetch と同じく STOP_SENDING が送られる (この判断を本テストで固定する)。
 */
test("FETCH 応答の Priority 不一致でセッションは閉じず FETCH がキャンセルされ error コールバックが呼ばれる", async () => {
  const requestId = 1n;
  const ctx = createFetchPriorityMismatchContext(requestId);
  const chunks = buildPriorityMismatchFetchChunks(requestId);

  // ヘッダー + 先頭オブジェクト + 不一致オブジェクトを 1 チャンクで流し込む
  const handlePromise = ctx.run();
  ctx.enqueue(concatUint8Arrays(chunks));
  await handlePromise;

  assertFetchCancelledOnPriorityMismatch(ctx);
});

/**
 * draft-ietf-moq-transport-19 §2.4.2:
 * Priority 不一致のオブジェクトが 2 チャンク目 (fetchContext を永続化してから)
 * で検出される場合も、セッションは閉じず FETCH がキャンセルされることを検証する。
 *
 * FETCH オブジェクトは prior context を参照するシリアライゼーションフラグを持つため、
 * デコードコンテキストはチャンクを跨いで永続化される。不一致の検出がチャンク境界の
 * どちら側でも同じキャンセル経路を通ることを固定する。
 */
test("FETCH 応答の Priority 不一致 (2 チャンク分割) でも FETCH がキャンセルされ error コールバックが呼ばれる", async () => {
  const requestId = 1n;
  const ctx = createFetchPriorityMismatchContext(requestId);
  const chunks = buildPriorityMismatchFetchChunks(requestId);

  // ヘッダー + 先頭オブジェクトと不一致オブジェクトを別チャンクに分割して流し込む
  const handlePromise = ctx.run();
  for (const chunk of chunks) {
    ctx.enqueue(chunk);
  }
  await handlePromise;

  assertFetchCancelledOnPriorityMismatch(ctx);
});
