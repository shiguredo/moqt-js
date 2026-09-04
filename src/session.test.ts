/**
 * SessionImpl の単体テスト
 *
 * WebTransport のモックを渡して SessionImpl を構築し、送信前検証をテストする。
 */

import { test, assert } from "vite-plus/test";
import {
  SessionImpl,
  type SessionState,
  type SubscribeCallbacks,
  type TracksSubscriptionCallbacks,
} from "./session";
import { ControlStreamWriter, ControlStreamReader } from "./controlStream";
import {
  MessageType,
  MessageParameterType,
  encodeGoawayPayload,
  encodePublishDonePayload,
} from "./message";
import { encodeRequestOkPayload, encodePublishStateNotifyPayload } from "./message/session";
import { ObjectStatus, PublishDoneStatusCode, GroupOrder } from "./message/types";
import { encodePublishPayload } from "./message/publish";
import { createTrackNamespace, encodeLocationFilterParameter } from "./message/parameter";
import type { RangeFilterSpec } from "./message/parameter";
import { FetcherImpl } from "./fetcher";
import {
  InvalidFilterError,
  MalformedTrackError,
  RequestError,
  RequestErrorCode,
  SessionError,
  SessionErrorCode,
} from "./error";
import { MAX_VARINT, encodeVarint } from "./varint";
import {
  FetchHeaderType,
  FetchSerializationFlags,
  type FetchObjectFields,
  type MoqtObject,
  SubgroupHeaderType,
  encodeFetchHeader,
  encodeFetchObjectFields,
  encodeObjectFields,
  encodeSubgroupHeader,
  createFirstFetchObjectFlags,
  decodeFetchObjectFields,
} from "./dataStream";
import { SubscriberImpl } from "./subscriber";
import { PublisherImpl } from "./publisher";
import {
  bidiCancelFetch,
  RESET_REQUEST_STREAM_MESSAGE,
  type BidiSessionInternal,
} from "./session/bidi";
import { REQUEST_UPDATE_STREAM_CLOSED_MESSAGE } from "./session/namespaceLoops";

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
 * テストで `as unknown as` キャストを使う際の tracksSubscriptions エントリの部分ビュー
 *
 * 実エントリ (SessionImpl.tracksSubscriptions) は namespace / stream / writer 系の
 * 全フィールドを持つが、フィルタ評価系と解除系のテストが読み書きする範囲だけを表す。
 * インライン型の重複を避けるための共有型である。
 */
interface TracksSubscriptionEntryView {
  callbacks: TracksSubscriptionCallbacks;
  state: "active" | "closed";
  namespacePrefix: string[];
  rangeFilters?: RangeFilterSpec[];
}

/**
 * 解除系テスト用の tracksSubscriptions エントリビュー
 *
 * unsubscribe() が writer を閉じ、pendingPrefix を掃除することを検証するため、
 * writer を必須フィールドとして扱う。
 */
interface TracksWriterSubscriptionEntryView {
  callbacks: TracksSubscriptionCallbacks;
  state: "active" | "closed";
  namespacePrefix: string[];
  pendingPrefix?: string[];
  writer: WritableStreamDefaultWriter<Uint8Array>;
}

/**
 * draft-ietf-moq-transport-20 §5.1.2 (Location Filters):
 * FetchOptions.filter に 3 フィールド (startGroup + startObject + endGroupDelta) の
 * End Group (StartGroup + EndGroupDelta) が 2^64-1 を超える filter を渡すと、
 * 送信前に InvalidFilterError で reject される。パラメータ構築は
 * pendingFetch.set より前 (Promise 作成前) に走るため、pending エントリが
 * 残らないことを検証する。
 */
test("fetch: filter の End Group が 2^64-1 を超えると throw し pendingFetch が残らない", async () => {
  const session = createSessionImpl();

  let thrown: Error | undefined;
  try {
    await session.fetch(
      ["live"],
      "video",
      {
        filter: {
          startGroup: MAX_VARINT,
          startObject: 0n,
          endGroupDelta: 1n,
        },
      },
      { object: () => {} },
    );
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown instanceof InvalidFilterError);
  assert.equal((session as unknown as { pendingFetch: Map<bigint, unknown> }).pendingFetch.size, 0);
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
 * draft-ietf-moq-transport-20 §5.1.2 (Location Filters):
 * 3 フィールド (startGroup + startObject + endGroupDelta) の End Group
 * (StartGroup + EndGroupDelta) が 2^64-1 を超える filter を subscribe() に
 * 渡すと、送信前に InvalidFilterError で reject される。Message Parameters
 * 構築は pendingSubscribe.set より前 (Promise 作成前) に走するため、pending
 * エントリが残らないことを検証する。
 */
test("subscribe: End Group が 2^64-1 を超えると throw し pendingSubscribe が残らない", async () => {
  const session = createSessionImpl();

  let thrown: Error | undefined;
  try {
    await session.subscribe(
      ["live"],
      "video",
      { object: () => {} },
      {
        filter: {
          startGroup: MAX_VARINT,
          startObject: 0n,
          endGroupDelta: 1n,
        },
      },
    );
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.instanceOf(thrown, InvalidFilterError);
  assert.isTrue(thrown!.message.includes("end group exceeds maximum"));
  // 送信前検証は pendingSubscribe.set より前に走るため、pending エントリが残らない
  assert.equal(
    (session as unknown as { pendingSubscribe: Map<bigint, unknown> }).pendingSubscribe.size,
    0,
  );
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
    tracksSubscriptions: Map<bigint, TracksSubscriptionEntryView>;
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
    tracksSubscriptions: Map<bigint, TracksSubscriptionEntryView>;
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
 * draft-ietf-moq-transport-19 §10.9.1 / §3.3.2:
 * 受信 PUBLISH ストリーム (runPublishStreamSubLoop) でピアが GOAWAY を送らずに
 * FIN した場合、応答待ちの REQUEST_UPDATE の update() の Promise が reject
 * され、エントリが削除されることを検証する。
 */
test("受信 PUBLISH ストリーム上のピア FIN で応答待ちの REQUEST_UPDATE が reject されエントリが削除される", async () => {
  const session = createSessionImpl();
  const sessionInternal = session as unknown as {
    tracksSubscriptions: Map<bigint, TracksSubscriptionEntryView>;
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

  // FIN 前に送信済みで応答待ちの REQUEST_UPDATE を注入する
  let rejected: Error | undefined;
  sessionInternal.pendingRequestUpdate.set(100n, {
    resolve: () => {},
    reject: (err: Error) => {
      rejected = err;
    },
    targetRequestId: 1n,
  });

  const publishPayload = encodePublishPayload({
    type: MessageType.PUBLISH,
    requestId: 1n,
    trackNamespace: createTrackNamespace(["live"]),
    trackName: new TextEncoder().encode("track"),
    trackAlias: 1n,
    parameters: [],
    trackProperties: [],
  });
  const controlWriter = new ControlStreamWriter();
  const publishFramed = controlWriter.encode(MessageType.PUBLISH, publishPayload);

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(publishFramed);
      // GOAWAY を送らずにピアが FIN する
      controller.close();
    },
  });
  const writable = new WritableStream<Uint8Array>({});
  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;

  await sessionInternal.handleIncomingBidirectionalStream(stream);

  // FIN 時点で未応答 REQUEST_UPDATE が reject され、エントリが削除される
  assert.isDefined(rejected);
  assert.equal(rejected!.message, REQUEST_UPDATE_STREAM_CLOSED_MESSAGE);
  assert.equal(sessionInternal.pendingRequestUpdate.size, 0);
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
    tracksSubscriptions: Map<bigint, TracksSubscriptionEntryView>;
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

/**
 * publish() を駆動するためのセッションを構築する
 *
 * 双方向ストリームは応答を返さない実物で構成し、PUBLISH_OK 受信前の
 * 初期状態を観測できるようにする。controlWriter は初期化済みとして注入する。
 * 検証後は session.close() で保留中の publish を片付ける。
 */
function createPublishSession(): {
  session: SessionImpl;
  readableController: ReadableStreamDefaultController<Uint8Array>;
} {
  let readableController!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      readableController = controller;
    },
  });
  const writable = new WritableStream<Uint8Array>({});
  const transport = {
    closed: new Promise<WebTransportCloseInfo>(() => {}),
    createBidirectionalStream: async (): Promise<WebTransportBidirectionalStream> => {
      return { readable, writable } as unknown as WebTransportBidirectionalStream;
    },
  } as unknown as WebTransport;
  const session = new SessionImpl(transport, {});
  (session as unknown as { controlWriter: ControlStreamWriter }).controlWriter =
    new ControlStreamWriter();
  return { session, readableController };
}

/**
 * publish() の保留エントリから生成直後の Publisher を取り出す
 *
 * publish() は最初の await より前に PublisherImpl を生成して登録するため、
 * 呼び出し直後に観測できる (PUBLISH_OK 受信前の初期値の検証に使う)。
 */
function getPendingPublisher(session: SessionImpl): PublisherImpl {
  const internals = session as unknown as {
    pendingPublish: Map<bigint, { impl: PublisherImpl }>;
  };
  assert.equal(internals.pendingPublish.size, 1, "保留中の publish が 1 件であること");
  const [pending] = internals.pendingPublish.values();
  return pending.impl;
}

/**
 * draft-ietf-moq-transport-20 §5.1 (Subscriptions):
 * "The initiator of the subscription sets the initial Forward State in
 *  either PUBLISH or SUBSCRIBE."
 * publish({ forward: false }) の場合、PUBLISH_OK 受信前の時点で
 * Publisher の Forward State が false になることを検証する。
 */
test("publish: forward false 指定時は PUBLISH_OK 受信前の forwardState が false になる", async () => {
  const { session, readableController } = createPublishSession();
  const forwardChanges: boolean[] = [];

  // 応答が返らないため Promise は未解決のまま残る。close 時の reject が
  // unhandled rejection にならないよう catch を付ける
  const promise = session.publish(
    ["live"],
    "track",
    {
      onForwardStateChange: (forward: boolean) => {
        forwardChanges.push(forward);
      },
    },
    { forward: false },
  );
  promise.catch(() => {});

  // PUBLISH_OK 受信前の観測では指定値が反映される
  assert.isFalse(getPendingPublisher(session).forwardState);
  // 初期値 true からの変化のため、初期設定でもコールバックが発火する
  assert.deepEqual(forwardChanges, [false]);

  // 実解体を模倣して読み取り側を閉じてからセッションを閉じる
  readableController.close();
  await session.close();
});

/**
 * draft-ietf-moq-transport-20 §5.1 (Subscriptions):
 * publish({ forward: true }) の場合、PUBLISH_OK 受信前の時点で
 * Publisher の Forward State が true になることを検証する (回帰ガード)。
 */
test("publish: forward true 指定時は PUBLISH_OK 受信前の forwardState が true になる", async () => {
  const { session, readableController } = createPublishSession();
  const forwardChanges: boolean[] = [];

  // 応答が返らないため Promise は未解決のまま残る。close 時の reject が
  // unhandled rejection にならないよう catch を付ける
  const promise = session.publish(
    ["live"],
    "track",
    {
      onForwardStateChange: (forward: boolean) => {
        forwardChanges.push(forward);
      },
    },
    { forward: true },
  );
  promise.catch(() => {});

  // PUBLISH_OK 受信前の観測では指定値が反映される
  assert.isTrue(getPendingPublisher(session).forwardState);
  // 初期値 true からの変化がないため、コールバックは発火しない
  assert.deepEqual(forwardChanges, []);

  // 実解体を模倣して読み取り側を閉じてからセッションを閉じる
  readableController.close();
  await session.close();
});

/**
 * draft-ietf-moq-transport-20 §10.2.18 (FORWARD Parameter):
 * "If the parameter is omitted from any other message, the default
 *  value is 1."
 * forward を省略した publish() の場合、PUBLISH_OK 受信前の時点で
 * Publisher の Forward State が true になることを検証する (回帰ガード)。
 */
test("publish: forward 省略時は PUBLISH_OK 受信前の forwardState が true になる", async () => {
  const { session, readableController } = createPublishSession();
  const forwardChanges: boolean[] = [];

  // 応答が返らないため Promise は未解決のまま残る。close 時の reject が
  // unhandled rejection にならないよう catch を付ける
  const promise = session.publish(["live"], "track", {
    onForwardStateChange: (forward: boolean) => {
      forwardChanges.push(forward);
    },
  });
  promise.catch(() => {});

  // 省略時はデフォルト 1 (true) が反映される
  assert.isTrue(getPendingPublisher(session).forwardState);
  // 初期値 true からの変化がないため、コールバックは発火しない
  assert.deepEqual(forwardChanges, []);

  // 実解体を模倣して読み取り側を閉じてからセッションを閉じる
  readableController.close();
  await session.close();
});

/**
 * draft-ietf-moq-transport-20 §10.2.16 / §10.2.18 (FORWARD Parameter):
 * PUBLISH_OK に出現できるのは EXPIRES のみであり、FORWARD は運ばれない。
 * publish({ forward: false }) の後に FORWARD 省略の PUBLISH_OK を受信した場合、
 * 初期値 false のまま維持され、更新は REQUEST_UPDATE 経路で扱うことを検証する。
 */
test("publish: forward false で開始後に FORWARD 省略の PUBLISH_OK で forwardState は false のまま", async () => {
  const { session, readableController } = createPublishSession();
  const forwardChanges: boolean[] = [];

  const promise = session.publish(
    ["live"],
    "track",
    {
      onForwardStateChange: (forward: boolean) => {
        forwardChanges.push(forward);
      },
    },
    { forward: false },
  );
  promise.catch(() => {});

  // PUBLISH_OK 受信前の観測では指定値が反映される
  assert.isFalse(getPendingPublisher(session).forwardState);

  // FORWARD 省略の PUBLISH_OK を応答する
  const writer = new ControlStreamWriter();
  const okPayload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [],
  });
  readableController.enqueue(writer.encode(MessageType.REQUEST_OK, okPayload));
  readableController.close();

  // PUBLISH_OK では Forward State を上書きせず、初期値 false のまま解決される
  const publisher = await promise;
  assert.isFalse(publisher.forwardState);
  // 発火は初期設定の 1 回のみになる
  assert.deepEqual(forwardChanges, [false]);

  await session.close();
});

/**
 * draft-ietf-moq-transport-20 §10.2.16 / §10.2.1:
 * FORWARD は PUBLISH_OK に出現できない。FORWARD=0 の PUBLISH_OK を受信した場合、
 * スコープ違反として PROTOCOL_VIOLATION でセッションが閉じ、発行が
 * 失敗することを検証する。
 */
test("publish: forward false で開始後に FORWARD=0 の PUBLISH_OK でセッションが閉じる", async () => {
  const { session, readableController } = createPublishSession();
  const forwardChanges: boolean[] = [];

  const promise = session.publish(
    ["live"],
    "track",
    {
      onForwardStateChange: (forward: boolean) => {
        forwardChanges.push(forward);
      },
    },
    { forward: false },
  );
  promise.catch(() => {});

  // PUBLISH_OK 受信前の観測では指定値が反映される
  assert.isFalse(getPendingPublisher(session).forwardState);

  // FORWARD=0 の PUBLISH_OK を応答する (スコープ違反)
  const writer = new ControlStreamWriter();
  const okPayload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [{ type: MessageParameterType.FORWARD, value: new Uint8Array([0]) }],
    trackProperties: [],
  });
  readableController.enqueue(writer.encode(MessageType.REQUEST_OK, okPayload));
  readableController.close();

  // スコープ違反で発行は失敗し、セッションが閉じる
  // 特定エラー (PROTOCOL_VIOLATION) が汎用 close エラーに上書きされず届く
  let rejected: Error | undefined;
  try {
    await promise;
    assert.fail("publish は reject されるべき");
  } catch (error) {
    rejected = error instanceof Error ? error : new Error(String(error));
  }
  assert.isDefined(rejected);
  assert.isTrue(rejected instanceof SessionError);
  assert.equal((rejected as SessionError).code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.equal((session as unknown as { sessionState: string }).sessionState, "closed");
  assert.deepEqual(forwardChanges, [false]);

  await session.close();
});

/**
 * draft-ietf-moq-transport-19 §10.3.1.6:
 * SUBSCRIBE の fill 内側に Range Filters を指定した場合も、ピア未広告では
 * 送信前に throw することを検証する (購読単位の上限に含める)。
 */
test("subscribe: fill 内側の Range Filters があると peer 未広告では throw する", async () => {
  // createSessionImpl の peerMaxFilterRanges は既定 0 (未広告) のため、
  // Range 指定があると送信前に throw する
  const session = createSessionImpl();

  let thrown: Error | undefined;
  try {
    await session.subscribe(
      ["live"],
      "video",
      { object: () => {} },
      {
        fill: {
          rangeFilters: [{ type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 1n }] }],
        },
      },
    );
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("MAX_FILTER_RANGES is 0"));
});

/**
 * draft-ietf-moq-transport-20 §5.1.3:
 * SUBSCRIBE 送信に失敗した場合は fill 関連付けと保留中の SUBSCRIBE が残らない
 * ことを検証する (送信失敗時の掃除)。
 */
test("subscribe: 送信失敗時は fill 関連付けと保留中の SUBSCRIBE が残らない", async () => {
  // createSessionImpl の transport は双方向ストリームを開けないため、
  // 送信は失敗する
  const session = createSessionImpl();
  const internals = session as unknown as {
    fillFetchTargets: Map<bigint, unknown>;
    pendingSubscribe: Map<bigint, unknown>;
  };

  let thrown: Error | undefined;
  try {
    await session.subscribe(
      ["live"],
      "video",
      { object: () => {} },
      {
        fill: {
          filter: { startGroup: 10n, startObject: 2n },
        },
      },
    );
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.equal(internals.fillFetchTargets.size, 0);
  assert.equal(internals.pendingSubscribe.size, 0);
});

/**
 * 受信 PUBLISH の後続メッセージループ (runPublishStreamSubLoop) を検証するための
 * SessionImpl の内部メンバー
 *
 * handleIncomingBidirectionalStream は private のため、SessionImpl を
 * `as unknown as` でキャストして駆動する (実 W3C ストリーム注入方式)。
 */
interface IncomingPublishStreamInternals {
  tracksSubscriptions: Map<bigint, TracksSubscriptionEntryView>;
  subscribers: Map<bigint, SubscriberImpl>;
  subscribersByAlias: Map<bigint, SubscriberImpl[]>;
  requestStreams: Map<bigint, unknown>;
  sessionState: SessionState;
  handleIncomingBidirectionalStream: (stream: WebTransportBidirectionalStream) => Promise<void>;
}

// 受信 PUBLISH ストリームのテストで使う Request ID。PUBLISH を注入する側と
// subscribers / requestStreams を検証する側で同じ値を共有する
const INCOMING_PUBLISH_REQUEST_ID = 1n;

// createIncomingPublishStream が注入する PUBLISH の Track Alias
const INCOMING_PUBLISH_TRACK_ALIAS = 1n;

// createIncomingPublishStream が注入する PUBLISH の Track Namespace
const INCOMING_PUBLISH_NAMESPACE = ["live"];

/**
 * 受信 PUBLISH を受け付ける状態のセッションを作る
 *
 * SUBSCRIBE_TRACKS 相当の namespace 登録だけ行う。PUBLISH の受信で onPublish から
 * 返した SubscribeCallbacks を使って SubscriberImpl が内部生成される。
 *
 * 返り値の internal は SubscribeCallbacks のコールバック内から後で参照してよい
 * (コールバックの発火は必ず handleIncomingBidirectionalStream の呼び出し以降)。
 */
function setupIncomingPublishStreamSession(
  session: SessionImpl,
  subscribeCallbacks: SubscribeCallbacks,
): IncomingPublishStreamInternals {
  const internal = session as unknown as IncomingPublishStreamInternals;
  internal.tracksSubscriptions.set(INCOMING_PUBLISH_REQUEST_ID, {
    callbacks: {
      onPublish: async () => subscribeCallbacks,
    },
    state: "active",
    namespacePrefix: INCOMING_PUBLISH_NAMESPACE,
  });
  return internal;
}

/**
 * 受信 PUBLISH メッセージ入りの双方向ストリームを作る
 *
 * readable は highWaterMark を 0 にして pull ごとに 1 チャンクを渡す (消費側の
 * read() まで先行して feed しない)。これにより PUBLISH / 追加フレームが処理されて
 * から終端操作が届くようになり、注入順序が決定論的になる
 * (start() で enqueue 直後に error() を呼ぶとキューが破棄され PUBLISH が処理されない)。
 *
 * @param terminate - チャンクをすべて渡し終えた read() で呼ばれる終端操作。
 *   RESET_STREAM なら source: "stream" を持つ reject、内部例外なら source なし reject、
 *   セッション終了なら source: "session" を持つ reject、FIN なら close
 * @param extraFrames - PUBLISH の後に enqueue する追加フレーム (GOAWAY / PUBLISH_DONE など)
 */
function createIncomingPublishStream(
  terminate: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
  extraFrames: Uint8Array[] = [],
  parameters: { type: number; value: Uint8Array }[] = [],
): WebTransportBidirectionalStream {
  const publishPayload = encodePublishPayload({
    type: MessageType.PUBLISH,
    requestId: INCOMING_PUBLISH_REQUEST_ID,
    trackNamespace: createTrackNamespace(INCOMING_PUBLISH_NAMESPACE),
    trackName: new TextEncoder().encode("track"),
    trackAlias: INCOMING_PUBLISH_TRACK_ALIAS,
    parameters,
    trackProperties: [],
  });
  const controlWriter = new ControlStreamWriter();
  const chunks = [controlWriter.encode(MessageType.PUBLISH, publishPayload), ...extraFrames];
  const readable = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk === undefined) {
          // 渡すチャンクが無い = 前までの処理が consumer 側で終わった合図
          terminate(controller);
          return;
        }
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  const writable = new WritableStream<Uint8Array>({});
  return { readable, writable } as unknown as WebTransportBidirectionalStream;
}

/**
 * draft-ietf-moq-transport-19 §3.3.3:
 * 受信 PUBLISH から生成された subscriber に対してピアが RESET_STREAM でストリームを
 * エラー終了させた場合、error コールバックが呼ばれ state が closed になることを検証する。
 * bidiReadRequestStreamMessages の subscribe ロールと同じ扱いに揃える対応であり、
 * プロトコル違反ではないためセッションは閉じない。
 */
test("受信 PUBLISH ストリーム上のピア RESET_STREAM で error 通知され state が closed になる", async () => {
  const session = createSessionImpl();
  let notifiedError: Error | undefined;
  let notifyCount = 0;
  let subscriber: SubscriberImpl | undefined;
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
    error: (error: Error) => {
      notifyCount += 1;
      notifiedError = error;
      // error コールバックは requestStreams / subscribers の削除より前に呼ばれるため、
      // ここで引き取った SubscriberImpl の state を await 後 (markClosed 済み) に検証できる
      subscriber = internal.subscribers.get(INCOMING_PUBLISH_REQUEST_ID);
    },
  });

  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream((controller) => {
      // ピアの RESET_STREAM 相当 (source: "stream" の reject) を再現する
      controller.error(Object.assign(new Error("stream reset by peer"), { source: "stream" }));
    }),
  );

  // 通知は subscribe ロール側と同一の固定文言が 1 回だけ (raw 通知との二重通知ではない)
  assert.equal(notifyCount, 1);
  assert.isDefined(notifiedError);
  assert.equal(notifiedError!.message, RESET_REQUEST_STREAM_MESSAGE);
  assert.isDefined(subscriber);
  assert.equal(subscriber!.state, "closed");
  // プロトコル違反ではないためセッションは閉じない
  assert.equal(internal.sessionState, "connected");
});

/**
 * draft-ietf-moq-transport-19 §3.3.2 / §3.3.3 / §10.9.1:
 * 受信 PUBLISH ストリームでピアが RESET_STREAM でストリームをエラー終了させた
 * 場合、応答待ちの REQUEST_UPDATE が reject されエントリが削除されることを
 * 検証する。FIN 経路と同じ文言で失敗として扱う。
 */
test("受信 PUBLISH ストリーム上の RESET_STREAM で応答待ちの REQUEST_UPDATE が reject される", async () => {
  const session = createSessionImpl();
  let notifiedError: Error | undefined;
  let subscriber: SubscriberImpl | undefined;
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
    error: (error: Error) => {
      notifiedError = error;
      // error コールバックは requestStreams / subscribers の削除より前に呼ばれるため、
      // ここで引き取った SubscriberImpl の state を await 後 (markClosed 済み) に検証できる
      subscriber = internal.subscribers.get(INCOMING_PUBLISH_REQUEST_ID);
    },
  });

  // RESET 前に送信済みで応答待ちの REQUEST_UPDATE を注入する
  let rejected: Error | undefined;
  const internals = internal as unknown as {
    pendingRequestUpdate: Map<
      bigint,
      { resolve: () => void; reject: (err: Error) => void; targetRequestId: bigint }
    >;
  };
  internals.pendingRequestUpdate.set(100n, {
    resolve: () => {},
    reject: (err: Error) => {
      rejected = err;
    },
    targetRequestId: INCOMING_PUBLISH_REQUEST_ID,
  });

  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream((controller) => {
      // ピアの RESET_STREAM 相当 (source: "stream" の reject) を再現する
      controller.error(Object.assign(new Error("stream reset by peer"), { source: "stream" }));
    }),
  );

  // 応答待ちの REQUEST_UPDATE が FIN 経路と同じ文言で reject され、
  // エントリが削除される。error 通知も行われる
  assert.isDefined(rejected);
  assert.equal(rejected!.message, REQUEST_UPDATE_STREAM_CLOSED_MESSAGE);
  assert.equal(internals.pendingRequestUpdate.size, 0);
  assert.isDefined(notifiedError);
  assert.isDefined(subscriber);
  assert.equal(subscriber!.state, "closed");
  assert.equal(internal.sessionState, "connected");
});

/**
 * draft-ietf-moq-transport-19 §3.3.2 / §3.3.3:
 * 受信 PUBLISH ストリームの RESET_STREAM 通知でアプリの error コールバックが
 * throw しても、応答待ちの REQUEST_UPDATE の reject が先に実行済みであることを
 * 検証する。通知より reject を先に置く順序の根拠を固定する。
 */
test("受信 PUBLISH ストリーム上の RESET_STREAM 通知で error コールバックが throw しても応答待ちの更新は reject される", async () => {
  const session = createSessionImpl();
  let subscriber: SubscriberImpl | undefined;
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
    error: () => {
      subscriber = internal.subscribers.get(INCOMING_PUBLISH_REQUEST_ID);
      throw new Error("error callback failed");
    },
  });

  // RESET 前に送信済みで応答待ちの REQUEST_UPDATE を注入する
  let rejected: Error | undefined;
  const internals = internal as unknown as {
    pendingRequestUpdate: Map<
      bigint,
      { resolve: () => void; reject: (err: Error) => void; targetRequestId: bigint }
    >;
  };
  internals.pendingRequestUpdate.set(100n, {
    resolve: () => {},
    reject: (err: Error) => {
      rejected = err;
    },
    targetRequestId: INCOMING_PUBLISH_REQUEST_ID,
  });

  // コールバック例外が伝播して Promise が reject しないこと (await が解決する)
  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream((controller) => {
      controller.error(Object.assign(new Error("stream reset by peer"), { source: "stream" }));
    }),
  );

  // コールバック例外があっても reject は実行済みでエントリは削除される
  assert.isDefined(rejected);
  assert.equal(rejected!.message, REQUEST_UPDATE_STREAM_CLOSED_MESSAGE);
  assert.equal(internals.pendingRequestUpdate.size, 0);
  assert.isDefined(subscriber);
  assert.equal(subscriber!.state, "closed");
  assert.equal(internal.sessionState, "connected");
});

/**
 * draft-ietf-moq-transport-20 §3.3.4:
 * 受信 PUBLISH 経路でもピアの RESET_STREAM に付いたエラーコードが通知内容に
 * 反映されることを検証する。組み立ては subscribe ロール側と共用のため、
 * 配線 (生の失敗値を渡していること) ごと検証する。
 */
test("受信 PUBLISH ストリーム上の RESET_STREAM のエラーコードが通知内容に反映される", async () => {
  const session = createSessionImpl();
  let notifiedError: Error | undefined;
  let subscriber: SubscriberImpl | undefined;
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
    error: (error: Error) => {
      notifiedError = error;
      // error コールバックは requestStreams / subscribers の削除より前に呼ばれるため、
      // ここで引き取った SubscriberImpl の state を await 後 (markClosed 済み) に検証できる
      subscriber = internal.subscribers.get(INCOMING_PUBLISH_REQUEST_ID);
    },
  });

  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream((controller) => {
      // ピアが TOO_FAR_BEHIND (0x5) でリセットした場合を再現する
      controller.error(
        Object.assign(new Error("stream reset by peer"), {
          source: "stream",
          streamErrorCode: 0x5,
        }),
      );
    }),
  );

  // コード名付きの可変文言と正規化済みコード値の両方が伝わる
  assert.isDefined(notifiedError);
  assert.equal(notifiedError!.message, `${RESET_REQUEST_STREAM_MESSAGE}: TOO_FAR_BEHIND(0x5)`);
  assert.equal((notifiedError as unknown as { streamErrorCode?: unknown }).streamErrorCode, 0x5);
  assert.isDefined(subscriber);
  assert.equal(subscriber!.state, "closed");
  // プロトコル違反ではないためセッションは閉じない
  assert.equal(internal.sessionState, "connected");
});

/**
 * draft-ietf-moq-transport-19 §10.4:
 * 受信 PUBLISH ストリームで GOAWAY 受信後に RESET_STREAM が起きても、
 * 保留中の REQUEST_UPDATE には触れないことを検証する (GOAWAY 掃除に委ねる)。
 * GOAWAY 掃除の reject が上書きされないことで呼び出し自体の不在を固定する。
 */
test("受信 PUBLISH ストリーム上の GOAWAY 受信後の RESET_STREAM では応答待ちの更新に触れない", async () => {
  const session = createSessionImpl();
  let notifyCount = 0;
  let subscriber: SubscriberImpl | undefined;
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
    error: () => {
      notifyCount += 1;
      subscriber = internal.subscribers.get(INCOMING_PUBLISH_REQUEST_ID);
    },
  });

  // GOAWAY 前に送信済みで応答待ちの REQUEST_UPDATE を注入する
  // (GOAWAY 掃除で GOING_AWAY として reject される)
  let rejected: Error | undefined;
  const internals = internal as unknown as {
    pendingRequestUpdate: Map<
      bigint,
      { resolve: () => void; reject: (err: Error) => void; targetRequestId: bigint }
    >;
  };
  internals.pendingRequestUpdate.set(100n, {
    resolve: () => {},
    reject: (err: Error) => {
      rejected = err;
    },
    targetRequestId: INCOMING_PUBLISH_REQUEST_ID,
  });

  // GOAWAY を feed してから RESET_STREAM 相当の reject で終端する
  const writer = new ControlStreamWriter();
  const goawayFramed = writer.encode(
    MessageType.GOAWAY,
    encodeGoawayPayload({
      type: MessageType.GOAWAY,
      newSessionUri: "moqt://new.example.com",
      timeout: 0n,
    }),
  );
  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(
      (controller) => {
        controller.error(Object.assign(new Error("stream reset by peer"), { source: "stream" }));
      },
      [goawayFramed],
    ),
  );

  // GOAWAY 掃除の reject が残り、RESET 経路の文言で上書きされない
  assert.isDefined(rejected);
  assert.instanceOf(rejected, RequestError);
  assert.equal((rejected as RequestError).code, RequestErrorCode.GOING_AWAY);
  assert.equal(internals.pendingRequestUpdate.size, 0);
  // GOAWAY 後は migration の完了であり、error 通知も state 遷移もしない
  assert.equal(notifyCount, 0);
  assert.isUndefined(subscriber);
  assert.equal(internal.sessionState, "connected");
});

/**
 * draft-ietf-moq-transport-19 §3.3.3 / §3.5:
 * 受信 PUBLISH ストリームでセッション終了起因 (source: "session") の読み取り
 * 失敗が起きても、保留中の REQUEST_UPDATE に触れないことを検証する。
 */
test("受信 PUBLISH ストリーム上のセッション終了の読み取り失敗では応答待ちの更新に触れない", async () => {
  const session = createSessionImpl();
  let notifyCount = 0;
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
    error: () => {
      notifyCount += 1;
    },
  });

  // 応答待ちの REQUEST_UPDATE を注入する
  let rejected: Error | undefined;
  const internals = internal as unknown as {
    pendingRequestUpdate: Map<
      bigint,
      { resolve: () => void; reject: (err: Error) => void; targetRequestId: bigint }
    >;
  };
  internals.pendingRequestUpdate.set(100n, {
    resolve: () => {},
    reject: (err: Error) => {
      rejected = err;
    },
    targetRequestId: INCOMING_PUBLISH_REQUEST_ID,
  });

  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream((controller) => {
      // セッション終了起因の読み取り失敗を再現する
      controller.error(Object.assign(new Error("session closed by peer"), { source: "session" }));
    }),
  );

  // セッション終了は購読者への通知対象外であり、保留中の更新にも触れない
  assert.isUndefined(rejected);
  assert.equal(internals.pendingRequestUpdate.size, 1);
  assert.equal(notifyCount, 0);
  assert.equal(internal.sessionState, "connected");
});

/**
 * draft-ietf-moq-transport-19 §3.3.3:
 * RESET_STREAM 通知でアプリの error コールバックが throw しても、例外がループ外へ
 * 伝播せず state が closed になることを検証する。伝播すると呼び出し元の
 * requestStreams / subscribers / subscribersByAlias のクリーンアップがスキップされる。
 */
test("受信 PUBLISH ストリーム上の RESET_STREAM 通知で error コールバックが throw しても state は closed になる", async () => {
  const session = createSessionImpl();
  let subscriber: SubscriberImpl | undefined;
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
    error: () => {
      subscriber = internal.subscribers.get(INCOMING_PUBLISH_REQUEST_ID);
      throw new Error("error callback failed");
    },
  });

  // コールバック例外が伝播して Promise が reject しないこと (await が解決する)
  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream((controller) => {
      controller.error(Object.assign(new Error("stream reset by peer"), { source: "stream" }));
    }),
  );

  // markClosed は notifySubscriberFailure 内の finally で実行される
  assert.isDefined(subscriber);
  assert.equal(subscriber!.state, "closed");
  // 後続のクリーンアップも通常どおり走っている
  assert.isUndefined(internal.subscribers.get(INCOMING_PUBLISH_REQUEST_ID));
  assert.isUndefined(internal.subscribersByAlias.get(INCOMING_PUBLISH_TRACK_ALIAS));
  assert.isUndefined(internal.requestStreams.get(INCOMING_PUBLISH_REQUEST_ID));
  assert.equal(internal.sessionState, "connected");
});

/**
 * draft-ietf-moq-transport-19 §3.3.3:
 * source を持たない内部エラーでは、従来どおり生のエラーが error コールバックへ
 * 通知され、state は closed にならないことを検証する (RESET_STREAM 限定の回帰ガード)。
 * 修正前の実装でも通る。
 */
test("受信 PUBLISH ストリーム上の source なしエラーでは error 通知されるが state は active のまま", async () => {
  const session = createSessionImpl();
  let notifiedError: Error | undefined;
  let subscriber: SubscriberImpl | undefined;
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
    error: (error: Error) => {
      notifiedError = error;
      subscriber = internal.subscribers.get(INCOMING_PUBLISH_REQUEST_ID);
    },
  });

  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream((controller) => {
      // source プロパティを持たない内部例外を再現する
      controller.error(new Error("internal error"));
    }),
  );

  // 生のエラーがそのまま通知される
  assert.isDefined(notifiedError);
  assert.equal(notifiedError!.message, "internal error");
  assert.isDefined(subscriber);
  assert.equal(subscriber!.state, "active");
  assert.equal(internal.sessionState, "connected");
});

/**
 * draft-ietf-moq-transport-19 §3.3.3:
 * source を持たない内部エラーでアプリの error コールバックが throw しても、例外が
 * ループ外へ伝播せず後始末が走ることを検証する (RESET 経路と同じ理由で吸収する)。
 * error 通知されるのに state が active のまま残るのは従来どおりであり、ここでは
 * 後始末と伝播のみを検証する。
 */
test("受信 PUBLISH ストリーム上の source なしエラーで error コールバックが throw しても後始末は走る", async () => {
  const session = createSessionImpl();
  let subscriber: SubscriberImpl | undefined;
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
    error: () => {
      subscriber = internal.subscribers.get(INCOMING_PUBLISH_REQUEST_ID);
      throw new Error("error callback failed");
    },
  });

  // コールバック例外が伝播して Promise が reject しないこと (await が解決する)
  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream((controller) => {
      controller.error(new Error("internal error"));
    }),
  );

  assert.isDefined(subscriber);
  // state は従来どおり active のまま、後続のクリーンアップは走る
  assert.equal(subscriber!.state, "active");
  assert.isUndefined(internal.subscribers.get(INCOMING_PUBLISH_REQUEST_ID));
  assert.equal(internal.sessionState, "connected");
});

/**
 * draft-ietf-moq-transport-19 §3.5:
 * WebTransport セッション終了起因 (source: "session") のエラーでは従来どおり
 * error コールバックが呼ばれないことを検証する (修正前の実装でも通る回帰ガード)。
 * Node 環境では WebTransportError グローバルが無いため、isSessionClosedError は
 * メッセージ文字列のフォールバック判定で抑止される (source プロパティによる判定は
 * src/session/errors.test.ts が FakeWebTransportError の注入で担保している)。
 */
test("受信 PUBLISH ストリーム上のセッション終了 (source: session) では error 通知されない", async () => {
  const session = createSessionImpl();
  let errorCalled = false;
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
    error: () => {
      errorCalled = true;
    },
  });

  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream((controller) => {
      controller.error(Object.assign(new Error("session closed by peer"), { source: "session" }));
    }),
  );

  assert.isFalse(errorCalled);
  assert.equal(internal.sessionState, "connected");
});

/**
 * draft-ietf-moq-transport-19 §10.4 / §3.3.3:
 * GOAWAY 受信済みの受信 PUBLISH ストリームで RESET_STREAM が起きても、error
 * コールバックが呼ばれず state も変わらないことを検証する (GOAWAY は migration
 * 通知であり失敗ではなく、subscription state に影響しない。通知経路の拡大を
 * 防ぐ回帰ガードで、修正前の実装でも通る)。
 * 抑止は外側の !goawayReceived と notifySubscriberFailure 内の
 * goawayReceivedOnRequestStreams ガードの両方で成立する。source なしの raw 通知を
 * 抑止するのは外側の goawayReceived だけであり、その専用部分は次テストで担保する。
 */
test("受信 PUBLISH ストリーム上の GOAWAY 受信後の RESET_STREAM では error 通知されず state も変わらない", async () => {
  const session = createSessionImpl();
  let errorCalled = false;
  let subscriber: SubscriberImpl | undefined;
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
    error: () => {
      errorCalled = true;
    },
    // goawayCallback は GOAWAY 受信時点 (subscriber 登録後・削除前) で呼ばれるため、
    // ここで引き取った SubscriberImpl の state を await 後に検証できる
    goaway: () => {
      subscriber = internal.subscribers.get(INCOMING_PUBLISH_REQUEST_ID);
    },
  });
  const controlWriter = new ControlStreamWriter();
  const goawayFramed = controlWriter.encode(
    MessageType.GOAWAY,
    encodeGoawayPayload({
      type: MessageType.GOAWAY,
      newSessionUri: "moqt://new.example.com",
      timeout: 0n,
    }),
  );

  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(
      (controller) => {
        controller.error(Object.assign(new Error("stream reset by peer"), { source: "stream" }));
      },
      [goawayFramed],
    ),
  );

  assert.isFalse(errorCalled);
  assert.isDefined(subscriber);
  assert.equal(subscriber!.state, "active");
  assert.equal(internal.sessionState, "connected");
});

/**
 * draft-ietf-moq-transport-19 §10.4:
 * GOAWAY 受信済みの受信 PUBLISH ストリームで source を持たない内部エラーが起きても、
 * error コールバックが呼ばれないことを検証する。この抑止は外側の !goawayReceived に
 * しかなく (notifySubscriberFailure 内の goawayReceivedOnRequestStreams ガードは
 * RESET 分岐にしか効かない)、前テストの RESET 版と対をなす外側ガード専用の回帰
 * ガードである (修正前の実装でも通る)。
 */
test("受信 PUBLISH ストリーム上の GOAWAY 受信後の source なしエラーでは error 通知されない", async () => {
  const session = createSessionImpl();
  let errorCalled = false;
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
    error: () => {
      errorCalled = true;
    },
    goaway: () => {},
  });
  const controlWriter = new ControlStreamWriter();
  const goawayFramed = controlWriter.encode(
    MessageType.GOAWAY,
    encodeGoawayPayload({
      type: MessageType.GOAWAY,
      newSessionUri: "moqt://new.example.com",
      timeout: 0n,
    }),
  );

  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(
      (controller) => {
        controller.error(new Error("internal error"));
      },
      [goawayFramed],
    ),
  );

  assert.isFalse(errorCalled);
  assert.equal(internal.sessionState, "connected");
});

/**
 * draft-ietf-moq-transport-19 §10.11 / §5.1:
 * 正常な PUBLISH_DONE (SUBSCRIPTION_ENDED) の処理が変わらないことを検証する回帰
 * ガード。handleEnd が state を closed にした時点でループ条件 (while の state
 * ガード) が偽になり、後続の読み取り (= ピア FIN 経路) 自体に入らない。よって
 * error は飛ばず、end だけが通知される。
 */
test("受信 PUBLISH ストリーム上の正常な PUBLISH_DONE では end のみ通知され error は通知しない", async () => {
  const session = createSessionImpl();
  let endCalled = false;
  let errorCalled = false;
  let subscriber: SubscriberImpl | undefined;
  // PUBLISH_DONE でループを抜けるため、終端操作 (read) には到達しない
  let terminateCalled = false;
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
    end: () => {
      endCalled = true;
      subscriber = internal.subscribers.get(INCOMING_PUBLISH_REQUEST_ID);
    },
    error: () => {
      errorCalled = true;
    },
  });
  const controlWriter = new ControlStreamWriter();
  const publishDoneFramed = controlWriter.encode(
    MessageType.PUBLISH_DONE,
    encodePublishDonePayload({
      type: MessageType.PUBLISH_DONE,
      statusCode: BigInt(PublishDoneStatusCode.SUBSCRIPTION_ENDED),
      streamCount: 0n,
      reasonPhrase: "",
    }),
  );

  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(
      (controller) => {
        terminateCalled = true;
        // PUBLISH_DONE 送信後のピア FIN 相当 (上記のとおり到達しない)
        controller.close();
      },
      [publishDoneFramed],
    ),
  );

  assert.isTrue(endCalled);
  assert.isFalse(errorCalled);
  assert.isFalse(terminateCalled);
  assert.isDefined(subscriber);
  assert.equal(subscriber!.state, "closed");
  assert.equal(internal.sessionState, "connected");
});

/**
 * draft-ietf-moq-transport-19 §10.9.2 / §6.1:
 * in-flight (REQUEST_OK 未受信) の更新がある状態で namespace の
 * unsubscribe() を呼ぶと、update() の Promise が reject され、pending エントリと
 * pendingPrefix が掃除されることを検証する。
 */
test("namespace の unsubscribe() で in-flight の update() が reject され pending が掃除される", async () => {
  const session = createSessionImpl();
  const sessionInternal = session as unknown as {
    namespaceSubscriptions: Map<
      bigint,
      {
        callbacks: object;
        state: "active" | "closed";
        namespacePrefix: string[];
        pendingPrefix?: string[];
        writer: WritableStreamDefaultWriter<Uint8Array>;
      }
    >;
    pendingRequestUpdate: Map<
      bigint,
      {
        resolve: () => void;
        reject: (err: Error) => void;
        targetRequestId: bigint;
      }
    >;
  };

  let closeCalled = false;
  const writable = new WritableStream<Uint8Array>({
    close() {
      closeCalled = true;
    },
  });
  const entry = {
    callbacks: {},
    state: "active" as "active" | "closed",
    namespacePrefix: ["live"],
    pendingPrefix: ["live", "sports"],
    writer: writable.getWriter(),
  };
  sessionInternal.namespaceSubscriptions.set(1n, entry);

  let rejected: Error | undefined;
  sessionInternal.pendingRequestUpdate.set(200n, {
    resolve: () => {},
    reject: (err: Error) => {
      rejected = err;
    },
    targetRequestId: 1n,
  });

  const subscription = session.createNamespaceSubscription(1n);
  await subscription.unsubscribe();

  // update() の Promise が reject され、pending エントリと pendingPrefix が掃除される
  assert.isDefined(rejected);
  assert.equal(rejected!.message, REQUEST_UPDATE_STREAM_CLOSED_MESSAGE);
  assert.equal(sessionInternal.pendingRequestUpdate.size, 0);
  assert.isUndefined(entry.pendingPrefix);
  // ストリームが FIN (writer.close()) で閉じられ、エントリが削除される
  assert.equal(entry.state, "closed");
  assert.isTrue(closeCalled);
  assert.isFalse(sessionInternal.namespaceSubscriptions.has(1n));
});

/**
 * draft-ietf-moq-transport-19 §10.9.2 / §6.1:
 * tracks 側の unsubscribe() でも namespace 側と同様に、in-flight の update() の
 * Promise が reject され、pending エントリと pendingPrefix が掃除されることを
 * 検証する。
 */
test("tracks の unsubscribe() で in-flight の update() が reject され pending が掃除される", async () => {
  const session = createSessionImpl();
  const sessionInternal = session as unknown as {
    tracksSubscriptions: Map<bigint, TracksWriterSubscriptionEntryView>;
    pendingRequestUpdate: Map<
      bigint,
      {
        resolve: () => void;
        reject: (err: Error) => void;
        targetRequestId: bigint;
      }
    >;
  };

  const writable = new WritableStream<Uint8Array>();
  const entry = {
    callbacks: {},
    state: "active" as "active" | "closed",
    namespacePrefix: ["live"],
    pendingPrefix: ["live", "sports"],
    writer: writable.getWriter(),
  };
  sessionInternal.tracksSubscriptions.set(1n, entry);

  let rejected: Error | undefined;
  sessionInternal.pendingRequestUpdate.set(200n, {
    resolve: () => {},
    reject: (err: Error) => {
      rejected = err;
    },
    targetRequestId: 1n,
  });

  const subscription = session.createTracksSubscription(1n);
  await subscription.unsubscribe();

  assert.isDefined(rejected);
  assert.equal(rejected!.message, REQUEST_UPDATE_STREAM_CLOSED_MESSAGE);
  assert.equal(sessionInternal.pendingRequestUpdate.size, 0);
  assert.isUndefined(entry.pendingPrefix);
  assert.equal(entry.state, "closed");
  assert.isFalse(sessionInternal.tracksSubscriptions.has(1n));
});

/**
 * draft-ietf-moq-transport-19 §10.9.2:
 * update() を fire-and-forget (返り値を観測しない) で呼び、その後に
 * unsubscribe() した場合、update() の reject が unhandled rejection に
 * ならないことを検証する。
 */
test("namespace の update() を fire-and-forget で呼び出しても unsubscribe() による reject が未処理にならない", async () => {
  const session = createSessionImpl();
  const sessionInternal = session as unknown as {
    controlWriter: ControlStreamWriter;
    namespaceSubscriptions: Map<
      bigint,
      {
        callbacks: object;
        state: "active" | "closed";
        namespacePrefix: string[];
        pendingPrefix?: string[];
        writer: WritableStreamDefaultWriter<Uint8Array>;
      }
    >;
    pendingRequestUpdate: Map<
      bigint,
      {
        resolve: () => void;
        reject: (err: Error) => void;
        targetRequestId: bigint;
      }
    >;
  };
  sessionInternal.controlWriter = new ControlStreamWriter();
  const writable = new WritableStream<Uint8Array>();
  sessionInternal.namespaceSubscriptions.set(1n, {
    callbacks: {},
    state: "active",
    namespacePrefix: ["live"],
    writer: writable.getWriter(),
  });

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const subscription = session.createNamespaceSubscription(1n);
    // fire-and-forget: 返り値の Promise を観測しない
    void subscription.update({ trackNamespacePrefix: ["live", "sports"] });
    // 応答が届かないまま unsubscribe() して update() の reject を発生させる。
    // unhandledRejection は reject 後のマイクロタスクで発火するため、50ms の
    // 壁時計待ちで確実に検出できる (CI 負荷を考慮した十分な余裕)。
    await subscription.unsubscribe();
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    assert.equal(unhandled.length, 0);
    // reject が実際に発生したこと、および掃除が行われたことを併せて検証する
    assert.equal(sessionInternal.pendingRequestUpdate.size, 0);
    assert.equal(sessionInternal.namespaceSubscriptions.has(1n), false);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

/**
 * draft-ietf-moq-transport-19 §10.9.2:
 * tracks 側の update() も namespace 側と同様に、fire-and-forget で呼び出して
 * も unsubscribe() の reject が unhandled rejection にならないことを検証する。
 */
test("tracks の update() を fire-and-forget で呼び出しても unsubscribe() による reject が未処理にならない", async () => {
  const session = createSessionImpl();
  const sessionInternal = session as unknown as {
    controlWriter: ControlStreamWriter;
    tracksSubscriptions: Map<bigint, TracksWriterSubscriptionEntryView>;
    pendingRequestUpdate: Map<
      bigint,
      {
        resolve: () => void;
        reject: (err: Error) => void;
        targetRequestId: bigint;
      }
    >;
  };
  sessionInternal.controlWriter = new ControlStreamWriter();
  const writable = new WritableStream<Uint8Array>();
  sessionInternal.tracksSubscriptions.set(1n, {
    callbacks: {},
    state: "active",
    namespacePrefix: ["live"],
    writer: writable.getWriter(),
  });

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const subscription = session.createTracksSubscription(1n);
    // fire-and-forget: 返り値の Promise を観測しない
    void subscription.update({ trackNamespacePrefix: ["live", "sports"] });
    await subscription.unsubscribe();
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    assert.equal(unhandled.length, 0);
    assert.equal(sessionInternal.pendingRequestUpdate.size, 0);
    assert.equal(sessionInternal.tracksSubscriptions.has(1n), false);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
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
 * この検証は fetch() で登録された FETCH に適用される。fetch() は
 * bidiSendRequestOnBidiStream で新規 bidi ストリームを開いて requestStreams に
 * 登録するため (§10.13「A subscriber sends FETCH as the first message on a new
 * bidi stream」)、FETCH のデータストリームで検出した場合は
 * §5.2 の MUST どおり bidi リクエストストリームへ STOP_SENDING が送られる
 * (この判断を本テストで固定する)。
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

// ============================================================================
// データストリームの FIN 時の未完成 Object 検証 (§11.4)
// ============================================================================

/** createDataStreamFinContext が返す検証用コンテキスト */
interface DataStreamFinContext {
  session: SessionImpl;
  internal: {
    fetchers: Map<bigint, FetcherImpl>;
    subscribersByAlias: Map<bigint, SubscriberImpl[]>;
    handleIncomingStream(stream: ReadableStream<Uint8Array>): Promise<void>;
  };
  sessionError: { current: Error | undefined };
  enqueue: (data: Uint8Array) => void;
  fin: () => void;
  /** peer 起点のセッション終了 (transport.closed) を再現する */
  closeTransport: () => Promise<void>;
  run: () => Promise<void>;
}

/**
 * 受信データストリーム (Subgroup / Fetch) を handleIncomingStream で駆動し、
 * 実 W3C ReadableStream への chunk 注入と close (FIN) でピアの graceful
 * 終了を再現するためのコンテキストを構築する。
 *
 * セッションが閉じられたことは callbacks.error に記録された SessionError と
 * session.state の両方で判定する (closeWithError は callbacks.error 通知後に
 * close を呼び、close は同期先頭で sessionState を closed にする)。
 */
function createDataStreamFinContext(): DataStreamFinContext {
  const sessionError: { current: Error | undefined } = { current: undefined };
  let resolveClosed!: (info: WebTransportCloseInfo) => void;
  const closedPromise = new Promise<WebTransportCloseInfo>((resolve) => {
    resolveClosed = resolve;
  });
  const transport = { closed: closedPromise } as unknown as WebTransport;
  const session = new SessionImpl(transport, {
    error: (error) => {
      sessionError.current = error;
    },
  });
  const internal = session as unknown as {
    fetchers: Map<bigint, FetcherImpl>;
    subscribersByAlias: Map<bigint, SubscriberImpl[]>;
    handleIncomingStream(stream: ReadableStream<Uint8Array>): Promise<void>;
  };

  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  return {
    session,
    internal,
    sessionError,
    enqueue: (data: Uint8Array) => {
      controller.enqueue(data);
    },
    fin: () => {
      controller.close();
    },
    // transport.closed ハンドラは close() を経ずに sessionState を closed へ
    // 遷移させる (fetcher / subscriber は active のまま)。ハンドラの .then は
    // resolve 時にマイクロタスク 1 回で走るため、await Promise.resolve() で
    // 遷移完了を確定できる (直後の state アサートで前提も検証する)
    closeTransport: async () => {
      resolveClosed({});
      await Promise.resolve();
    },
    run: () => internal.handleIncomingStream(stream),
  };
}

/** データストリーム構成部品 (ヘッダー / Object フィールド / 宣言どおりの完成 payload) */
interface StreamParts {
  headerBytes: Uint8Array;
  fieldsBytes: Uint8Array;
  payload: Uint8Array;
}

/**
 * Subgroup データストリーム (BASE 0x10, trackAlias 7, Group 1) の構成バイト列を
 * 構築する。Object は payload 宣言長 10 バイトが 1 つ。
 * テスト側は payload の切り分けと FIN のタイミングを制御して
 * 未完成 FIN / 分割後に完成 FIN の両ケースを組み立てる。
 */
function buildSubgroupStreamParts(): StreamParts {
  const headerBytes = encodeSubgroupHeader({
    type: SubgroupHeaderType.BASE,
    trackAlias: 7n,
    groupId: 1n,
    publisherPriority: 128,
  });
  const fieldsBytes = encodeObjectFields(0n, 10n, SubgroupHeaderType.BASE);
  const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  return { headerBytes, fieldsBytes, payload };
}

/**
 * Fetch データストリームの構成バイト列を構築する。Object は payload
 * 宣言長 10 バイトが 1 つ。切り分けの制御方法は Subgroup と同じ。
 */
function buildFetchStreamParts(requestId: bigint): StreamParts {
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(),
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 10n,
  };
  const headerBytes = encodeFetchHeader({ type: FetchHeaderType, requestId });
  const fieldsBytes = encodeFetchObjectFields(first);
  const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  return { headerBytes, fieldsBytes, payload };
}

/** マクロタスク 1 回分待ち、ストリーム読み取りループを進行させる */
async function yieldToMacrotask(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * draft-ietf-moq-transport-19 §11.4 (Streams):
 * "If a stream ends gracefully (i.e., the stream terminates with a FIN) in
 *  the middle of a serialized Object, the session SHOULD be closed with a
 *  PROTOCOL_VIOLATION."
 *
 * Subgroup データストリームが未完成 Object の途中でピア FIN された場合、
 * 黙殺せず PROTOCOL_VIOLATION でセッションを閉じることを検証する。
 * 宣言 payloadLength (10) が実際の到達バイト数 (4) より大きい場合、
 * processSubgroupObjects は Object 途中のバイト列を remainingBuffer と
 * して返す (IncompleteDataError ではなく totalNeeded > buffer.length の
 * break 経由)。未達 Object があるままの FIN は §11.4.3 の reset MUST に
 * 反する違反ワイヤであり、FIN 検出時点で残バッファが非空になる。
 */
test("Subgroup データストリーム: 未完成 Object の途中でピア FIN されると PROTOCOL_VIOLATION でセッションを閉じる", async () => {
  const ctx = createDataStreamFinContext();
  let delivered = 0;
  const subscriber = new SubscriberImpl(["live"], "video", 1n, 7n, () => {
    delivered++;
  });
  ctx.internal.subscribersByAlias.set(7n, [subscriber]);

  const parts = buildSubgroupStreamParts();
  const handlePromise = ctx.run();
  ctx.enqueue(concatUint8Arrays([parts.headerBytes, parts.fieldsBytes, parts.payload.slice(0, 4)]));
  ctx.fin();
  await handlePromise;

  // PROTOCOL_VIOLATION の SessionError でセッションが閉じられる
  assert.instanceOf(ctx.sessionError.current, SessionError);
  assert.equal(ctx.sessionError.current.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.match(
    ctx.sessionError.current.message,
    /subgroup data stream ended with incomplete object/,
  );
  assert.equal(ctx.session.state, "closed");
  // 未完成 Object は配信されない
  assert.equal(delivered, 0);
});

/**
 * 回帰ガード: Object を 3 チャンクに分割配信する間 (FIN なし) は、
 * Object が未完成のままでも「次チャンク待ち」でありセッションは閉じない
 * ことを中間時点のアサートで固定する。完成後に FIN されたなら従来どおり
 * 正常完了である。
 */
test("Subgroup データストリーム: チャンク分割中は閉じず Object 完成後の FIN で閉じない", async () => {
  const ctx = createDataStreamFinContext();
  let delivered = 0;
  const subscriber = new SubscriberImpl(["live"], "video", 1n, 7n, () => {
    delivered++;
  });
  ctx.internal.subscribersByAlias.set(7n, [subscriber]);

  const parts = buildSubgroupStreamParts();
  const handlePromise = ctx.run();
  // payload 2/10 (FIN なし): 次チャンク待ちのまま進行しない
  ctx.enqueue(concatUint8Arrays([parts.headerBytes, parts.fieldsBytes, parts.payload.slice(0, 2)]));
  await yieldToMacrotask();
  assert.isUndefined(ctx.sessionError.current);
  assert.equal(ctx.session.state, "connected");
  assert.equal(delivered, 0);
  // payload 5/10 (依然未完成・FIN なし): ここでも閉じない
  ctx.enqueue(parts.payload.slice(2, 5));
  await yieldToMacrotask();
  assert.isUndefined(ctx.sessionError.current);
  assert.equal(delivered, 0);
  // 残りを配信して完成、その後に FIN
  ctx.enqueue(parts.payload.slice(5));
  ctx.fin();
  await handlePromise;

  assert.isUndefined(ctx.sessionError.current);
  assert.equal(ctx.session.state, "connected");
  assert.equal(delivered, 1);
});

/**
 * draft-ietf-moq-transport-19 §11.4.3 (Closing Subgroup Streams):
 * "If a sender has delivered all objects in a Subgroup ... it MUST close
 *  the stream with a FIN."
 * Object 0 個 (empty Subgroup) を含む全ストリームが対象であり、
 * ヘッダーのみ FIN は未完成 Object を含まないため §11.4 の判定は
 * 誤検出しないことを検証する。
 */
test("Subgroup データストリーム: ヘッダーのみの FIN はセッションを閉じない", async () => {
  const ctx = createDataStreamFinContext();
  const subscriber = new SubscriberImpl(["live"], "video", 1n, 7n, () => {});
  ctx.internal.subscribersByAlias.set(7n, [subscriber]);

  const parts = buildSubgroupStreamParts();
  const handlePromise = ctx.run();
  ctx.enqueue(parts.headerBytes);
  ctx.fin();
  await handlePromise;

  assert.isUndefined(ctx.sessionError.current);
  assert.equal(ctx.session.state, "connected");
});

/**
 * Subgroup ヘッダーが途中で切れた FIN (done) は Object が開始する前であり、
 * handleIncomingStream のヘッダーパース部で黙殺される (§11.4 の判定対象外)。
 * この break が無いと解決済み read() の無限周回になるため、ハングしない
 * (= handlePromise が解決する) こととセッションを閉じないことを固定する。
 */
test("Subgroup データストリーム: ヘッダー途中切れの FIN は黙殺され閉じない", async () => {
  const ctx = createDataStreamFinContext();
  const subscriber = new SubscriberImpl(["live"], "video", 1n, 7n, () => {});
  ctx.internal.subscribersByAlias.set(7n, [subscriber]);

  const parts = buildSubgroupStreamParts();
  const handlePromise = ctx.run();
  // ヘッダーの最後の 1 バイトを欠落させて FIN
  ctx.enqueue(parts.headerBytes.slice(0, -1));
  ctx.fin();
  await handlePromise;

  assert.isUndefined(ctx.sessionError.current);
  assert.equal(ctx.session.state, "connected");
});

/**
 * Fetch ヘッダー途中切れの FIN も Subgroup と同じく黙殺経路
 * (ヘッダーパース部の done break) であり、閉じないことを固定する。
 */
test("Fetch データストリーム: ヘッダー途中切れの FIN は黙殺され閉じない", async () => {
  const ctx = createDataStreamFinContext();
  const requestId = 1n;
  const fetcher = new FetcherImpl(
    ["live"],
    "video",
    requestId,
    () => {},
    () => {},
  );
  ctx.internal.fetchers.set(requestId, fetcher);

  const parts = buildFetchStreamParts(requestId);
  const handlePromise = ctx.run();
  // ヘッダーの最後の 1 バイトを欠落させて FIN
  ctx.enqueue(parts.headerBytes.slice(0, -1));
  ctx.fin();
  await handlePromise;

  assert.isUndefined(ctx.sessionError.current);
  assert.equal(ctx.session.state, "connected");
  // ヘッダー未確定のため fetchers の削除も handleEnd も行われない
  assert.equal(ctx.internal.fetchers.size, 1);
});

/**
 * draft-ietf-moq-transport-19 §11.4 (Streams):
 * Fetch データストリームでも未完成 Object の途中のピア FIN は
 * PROTOCOL_VIOLATION でセッションを閉じることを検証する。
 * 加えて fetcher.handleEnd() が呼ばれない (正常終了として扱われない) ことを
 * end コールバックの未発火で検証し、fetcher が close() の markClosed で
 * 閉じられること (fetchers の Map エントリは削除されない) を検証する。
 */
test("Fetch データストリーム: 未完成 Object の途中でピア FIN されると PROTOCOL_VIOLATION でセッションを閉じる", async () => {
  const ctx = createDataStreamFinContext();
  const requestId = 1n;
  let delivered = 0;
  let ended = false;
  const fetcher = new FetcherImpl(
    ["live"],
    "video",
    requestId,
    () => {
      delivered++;
    },
    () => {
      ended = true;
    },
  );
  ctx.internal.fetchers.set(requestId, fetcher);

  const parts = buildFetchStreamParts(requestId);
  const handlePromise = ctx.run();
  ctx.enqueue(concatUint8Arrays([parts.headerBytes, parts.fieldsBytes, parts.payload.slice(0, 4)]));
  ctx.fin();
  await handlePromise;

  assert.instanceOf(ctx.sessionError.current, SessionError);
  assert.equal(ctx.sessionError.current.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.match(ctx.sessionError.current.message, /fetch data stream ended with incomplete object/);
  assert.equal(ctx.session.state, "closed");
  // handleEnd() は呼ばれない (欠落を正常終了として通知しない)
  assert.isFalse(ended);
  assert.equal(delivered, 0);
  // fetcher は close() の markClosed で閉じられる (Map エントリは残る)
  assert.equal(fetcher.state, "closed");
  assert.equal(ctx.internal.fetchers.size, 1);
});

/**
 * draft-ietf-moq-transport-19 §10.12.3 (Fetch Handling):
 * Object 0 件の FETCH 応答は FETCH_HEADER + FIN が正当な形
 * ("If no Objects exist in the requested range, the publisher opens the
 *  unidirectional stream, sends the FETCH_HEADER (see Section 11.4.4)
 *  and closes the stream with a FIN.")。
 * Fetch 側もヘッダーのみ FIN では handleEnd() による正常終了が通り、
 * セッションが閉じられないことを検証する。
 */
test("Fetch データストリーム: ヘッダーのみの FIN は正常終了しセッションは閉じない", async () => {
  const ctx = createDataStreamFinContext();
  const requestId = 1n;
  let ended = false;
  const fetcher = new FetcherImpl(
    ["live"],
    "video",
    requestId,
    () => {},
    () => {
      ended = true;
    },
  );
  ctx.internal.fetchers.set(requestId, fetcher);

  const parts = buildFetchStreamParts(requestId);
  const handlePromise = ctx.run();
  ctx.enqueue(parts.headerBytes);
  ctx.fin();
  await handlePromise;

  assert.isUndefined(ctx.sessionError.current);
  assert.equal(ctx.session.state, "connected");
  assert.isTrue(ended);
  assert.equal(ctx.internal.fetchers.size, 0);
});

/**
 * 回帰ガード: Fetch データストリームで Object を完成させた状態の FIN は
 * 従来どおり正常終了 (handleEnd による end コールバック通知 + fetchers 削除)
 * であり、セッションは閉じられない。
 */
test("Fetch データストリーム: Object 完成後の FIN は正常終了しセッションは閉じない", async () => {
  const ctx = createDataStreamFinContext();
  const requestId = 1n;
  let delivered = 0;
  let ended = false;
  const fetcher = new FetcherImpl(
    ["live"],
    "video",
    requestId,
    () => {
      delivered++;
    },
    () => {
      ended = true;
    },
  );
  ctx.internal.fetchers.set(requestId, fetcher);

  const parts = buildFetchStreamParts(requestId);
  const handlePromise = ctx.run();
  // 途中チャンク (FIN なし) を経由して Object を完成させる
  ctx.enqueue(concatUint8Arrays([parts.headerBytes, parts.fieldsBytes, parts.payload.slice(0, 4)]));
  ctx.enqueue(parts.payload.slice(4));
  ctx.fin();
  await handlePromise;

  assert.isUndefined(ctx.sessionError.current);
  assert.equal(ctx.session.state, "connected");
  assert.equal(delivered, 1);
  assert.isTrue(ended);
  assert.equal(ctx.internal.fetchers.size, 0);
});

// ============================================================================
// fill fetch ストリームの受信テスト
// draft-ietf-moq-transport-20 §5.1.3 (Fill Semantics)
// ============================================================================

/**
 * fill fetch ストリームの受信駆動コンテキストを構築する
 *
 * 購読 (SubscriberImpl) と fill 関連付けを登録し、FETCH_HEADER 形式の
 * fill ストリームを handleIncomingStream で駆動できるようにする。
 */
function createFillFetchStreamContext(): {
  ctx: ReturnType<typeof createDataStreamFinContext>;
  internals: {
    subscribers: Map<bigint, SubscriberImpl>;
    fillFetchTargets: Map<bigint, { subscriber: SubscriberImpl; groupOrder: GroupOrder }>;
  };
} {
  const ctx = createDataStreamFinContext();
  const internals = ctx.internal as unknown as {
    subscribers: Map<bigint, SubscriberImpl>;
    fillFetchTargets: Map<bigint, { subscriber: SubscriberImpl; groupOrder: GroupOrder }>;
  };
  return { ctx, internals };
}

/**
 * draft-ietf-moq-transport-20 §5.1.3:
 * SUBSCRIBE の Request ID を運ぶ fill fetch ストリーム (初期 fill) が、
 * 購読に紐付けて受信できることを検証する。FIN は fill 完了であり、
 * 関連付けが消え、購読自体は継続する。
 */
test("fill fetch ストリーム: 初期 fill (SUBSCRIBE Request ID) が購読に紐付けて受信される", async () => {
  const { ctx, internals } = createFillFetchStreamContext();
  const requestId = 2n;
  const received: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["live"], "video", requestId, 1n, (object) => {
    received.push(object);
  });
  internals.subscribers.set(requestId, subscriber);
  internals.fillFetchTargets.set(requestId, {
    subscriber,
    groupOrder: GroupOrder.ASCENDING,
  });

  const parts = buildFetchStreamParts(requestId);
  const handlePromise = ctx.run();
  ctx.enqueue(concatUint8Arrays([parts.headerBytes, parts.fieldsBytes, parts.payload]));
  ctx.fin();
  await handlePromise;

  // fill オブジェクトが購読に配信され、関連付けが消える
  assert.isUndefined(ctx.sessionError.current);
  assert.equal(ctx.session.state, "connected");
  assert.equal(received.length, 1);
  assert.equal(received[0].groupId, 10n);
  assert.equal(received[0].objectId, 0n);
  assert.deepEqual(received[0].payload, parts.payload);
  assert.equal(internals.fillFetchTargets.size, 0);
  // 購読自体は継続する
  assert.equal(subscriber.state, "active");
});

/**
 * draft-ietf-moq-transport-20 §5.1.3:
 * REQUEST_UPDATE の Request ID を運ぶ fill fetch ストリーム (後続 fill) が、
 * 応答済み (pending なし) でも購読に紐付けて受信できることを検証する。
 */
test("fill fetch ストリーム: 後続 fill (REQUEST_UPDATE Request ID、応答済み) が購読に紐付けて受信される", async () => {
  const { ctx, internals } = createFillFetchStreamContext();
  const subscribeRequestId = 2n;
  const updateRequestId = 100n;
  const received: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["live"], "video", subscribeRequestId, 1n, (object) => {
    received.push(object);
  });
  internals.subscribers.set(subscribeRequestId, subscriber);
  // REQUEST_OK 受理済みを模して pending なしで関連付けだけを残す
  internals.fillFetchTargets.set(updateRequestId, {
    subscriber,
    groupOrder: GroupOrder.ASCENDING,
  });

  const parts = buildFetchStreamParts(updateRequestId);
  const handlePromise = ctx.run();
  ctx.enqueue(concatUint8Arrays([parts.headerBytes, parts.fieldsBytes, parts.payload]));
  ctx.fin();
  await handlePromise;

  // fill オブジェクトが購読に配信され、関連付けが消える
  assert.isUndefined(ctx.sessionError.current);
  assert.equal(ctx.session.state, "connected");
  assert.equal(received.length, 1);
  assert.equal(received[0].groupId, 10n);
  assert.isTrue(internals.fillFetchTargets.size === 0);
  assert.equal(subscriber.state, "active");
});

/**
 * draft-ietf-moq-transport-20 §11.4 (Streams):
 * fill fetch ストリームでも未完成 Object の途中の FIN は PROTOCOL_VIOLATION で
 * セッションを閉じることを検証する (FETCH と同一の完全性規則)。
 */
test("fill fetch ストリーム: 未完成 Object の途中で FIN されるとセッションを閉じる", async () => {
  const { ctx, internals } = createFillFetchStreamContext();
  const requestId = 2n;
  let delivered = 0;
  const subscriber = new SubscriberImpl(["live"], "video", requestId, 1n, () => {
    delivered++;
  });
  internals.subscribers.set(requestId, subscriber);
  internals.fillFetchTargets.set(requestId, {
    subscriber,
    groupOrder: GroupOrder.ASCENDING,
  });

  const parts = buildFetchStreamParts(requestId);
  const handlePromise = ctx.run();
  ctx.enqueue(concatUint8Arrays([parts.headerBytes, parts.fieldsBytes, parts.payload.slice(0, 4)]));
  ctx.fin();
  await handlePromise;

  assert.instanceOf(ctx.sessionError.current, SessionError);
  assert.equal(ctx.sessionError.current.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.equal(delivered, 0);
});

/**
 * draft-ietf-moq-transport-19 §11.2.1.1 (Object Status):
 * Subgroup の終わりは status ではなく FIN で通知される
 * ("The end of a Subgroup is signaled by closing its stream with a FIN
 *  (see Section 11.4.3).")。
 * END_OF_GROUP status Object を最後に配信して FIN する形は status varint
 * が decodeObjectFields で必ず消費されるため残バッファは空になり、
 * §11.4 の判定は誤検出しない。先頭の完成 Object と合わせて両方配信される
 * ことも固定する。
 */
test("Subgroup データストリーム: END_OF_GROUP status 配信後の FIN はセッションを閉じない", async () => {
  const ctx = createDataStreamFinContext();
  let delivered = 0;
  const subscriber = new SubscriberImpl(["live"], "video", 1n, 7n, () => {
    delivered++;
  });
  ctx.internal.subscribersByAlias.set(7n, [subscriber]);

  const parts = buildSubgroupStreamParts();
  // 完成 Object の後に END_OF_GROUP status Object (payload 0 バイト) を続ける
  const statusBytes = encodeObjectFields(
    1n,
    0n,
    SubgroupHeaderType.BASE,
    ObjectStatus.END_OF_GROUP,
  );
  const handlePromise = ctx.run();
  ctx.enqueue(
    concatUint8Arrays([parts.headerBytes, parts.fieldsBytes, parts.payload, statusBytes]),
  );
  ctx.fin();
  await handlePromise;

  assert.isUndefined(ctx.sessionError.current);
  assert.equal(ctx.session.state, "connected");
  // 完成 Object と status Object の両方配信される
  assert.equal(delivered, 2);
});

/**
 * §11.4 のもう一方の境界: status varint が途中で切れた FIN は
 * 「シリアライズされた Object の途中」であり PROTOCOL_VIOLATION で閉じる。
 * 上記テスト (status 配信済み + FIN) と対にすることで、status varint の
 * 消費における誤検出 / 見逃しの双方を固定する。
 */
test("Subgroup データストリーム: END_OF_GROUP status 途中切れの FIN は PROTOCOL_VIOLATION でセッションを閉じる", async () => {
  const ctx = createDataStreamFinContext();
  let delivered = 0;
  const subscriber = new SubscriberImpl(["live"], "video", 1n, 7n, () => {
    delivered++;
  });
  ctx.internal.subscribersByAlias.set(7n, [subscriber]);

  const parts = buildSubgroupStreamParts();
  const statusBytes = encodeObjectFields(
    1n,
    0n,
    SubgroupHeaderType.BASE,
    ObjectStatus.END_OF_GROUP,
  );
  const handlePromise = ctx.run();
  // status varint の最終 1 バイトを欠落させて FIN (IncompleteDataError 経由の break)
  ctx.enqueue(
    concatUint8Arrays([
      parts.headerBytes,
      parts.fieldsBytes,
      parts.payload,
      statusBytes.slice(0, -1),
    ]),
  );
  ctx.fin();
  await handlePromise;

  assert.instanceOf(ctx.sessionError.current, SessionError);
  assert.equal(ctx.sessionError.current.code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.match(
    ctx.sessionError.current.message,
    /subgroup data stream ended with incomplete object/,
  );
  assert.equal(ctx.session.state, "closed");
  // 先頭の完成 Object は FIN 前に配信済み
  assert.equal(delivered, 1);
});

/**
 * セッション終了済み経路の抑制 (Subgroup): transport.closed ハンドラは
 * close() を経ずに sessionState だけを closed へ遷移させるため、
 * 未完成 Object の途中 FIN を検出しても closeWithError は呼ばれない
 * (セッションは既に終了しており、ここでの PROTOCOL_VIOLATION 通知は
 * spurious になる)。判定自体は通るため end 相当の進行は発生しないことも
 * 併せて固定する。
 */
test("Subgroup データストリーム: セッション close 済み経路の未完成 Object FIN は通知しない", async () => {
  const ctx = createDataStreamFinContext();
  let delivered = 0;
  const subscriber = new SubscriberImpl(["live"], "video", 1n, 7n, () => {
    delivered++;
  });
  ctx.internal.subscribersByAlias.set(7n, [subscriber]);

  await ctx.closeTransport();
  assert.equal(ctx.session.state, "closed");

  const parts = buildSubgroupStreamParts();
  const handlePromise = ctx.run();
  ctx.enqueue(concatUint8Arrays([parts.headerBytes, parts.fieldsBytes, parts.payload.slice(0, 4)]));
  ctx.fin();
  await handlePromise;

  // 新たな通知はしない (黙殺)。 subscriber も閉じられていない
  assert.isUndefined(ctx.sessionError.current);
  assert.equal(delivered, 0);
});

/**
 * セッション終了済み経路の抑制 (Fetch): transport.closed ハンドラ経由で
 * sessionState だけが closed になった状態 (fetcher は active のまま) で
 * 未完成 Object の途中 FIN を受け取ると、closeWithError (新たな
 * PROTOCOL_VIOLATION 通知) はスキップされ、fetcher.handleEnd() で
 * 正常終了も通知しないことを検証する。
 */
test("Fetch データストリーム: セッション close 済み経路でも未完成 Object の FIN は end を通知しない", async () => {
  const ctx = createDataStreamFinContext();
  const requestId = 1n;
  let delivered = 0;
  let ended = false;
  const fetcher = new FetcherImpl(
    ["live"],
    "video",
    requestId,
    () => {
      delivered++;
    },
    () => {
      ended = true;
    },
  );
  ctx.internal.fetchers.set(requestId, fetcher);

  // peer 起点のセッション終了を再現し、sessionState を closed へ遷移させる
  await ctx.closeTransport();
  assert.equal(ctx.session.state, "closed");

  const parts = buildFetchStreamParts(requestId);
  const handlePromise = ctx.run();
  ctx.enqueue(concatUint8Arrays([parts.headerBytes, parts.fieldsBytes, parts.payload.slice(0, 4)]));
  ctx.fin();
  await handlePromise;

  // 通知は抑制されるが、handleEnd() も呼ばない (正常終了として扱わない)
  assert.isUndefined(ctx.sessionError.current);
  assert.isFalse(ended);
  assert.equal(delivered, 0);
  // transport.closed 由来の遷移では fetcher は active のまま Map に残る
  // (close() 経由と違い markClosed が走らないため。セッション終了済みで実害なし)
  assert.equal(fetcher.state, "active");
  assert.equal(ctx.internal.fetchers.size, 1);
});

/**
 * draft-ietf-moq-transport-20 §10.10:
 * 受信 PUBLISH で確立した購読のストリーム上で publisher 発の
 * PUBLISH_STATE_NOTIFY を受信した場合、subscriber 状態に反映されることを
 * 検証する。応答は送信しない。
 */
test("受信 PUBLISH ストリーム上の PUBLISH_STATE_NOTIFY で subscriber 状態が反映される", async () => {
  const session = createSessionImpl();
  let notifiedError: Error | undefined;
  let subscriber: SubscriberImpl | undefined;
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
    error: (error: Error) => {
      notifiedError = error;
      // error コールバックは requestStreams / subscribers の削除より前に呼ばれるため、
      // ここで引き取った SubscriberImpl の state を await 後に検証できる
      subscriber = internal.subscribers.get(INCOMING_PUBLISH_REQUEST_ID);
    },
  });

  // LARGEST_OBJECT ({7, 2}) + FORWARD=0 を通知し、その後 FIN する
  const writer = new ControlStreamWriter();
  const notifyFramed = writer.encode(
    MessageType.PUBLISH_STATE_NOTIFY,
    encodePublishStateNotifyPayload({
      type: MessageType.PUBLISH_STATE_NOTIFY,
      parameters: [
        {
          type: MessageParameterType.LARGEST_OBJECT,
          value: new Uint8Array([0x07, 0x02]),
        },
        { type: MessageParameterType.FORWARD, value: new Uint8Array([0]) },
      ],
    }),
  );
  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(
      (controller) => {
        controller.close();
      },
      [notifyFramed],
    ),
  );

  // 通知内容が反映される。後続 FIN による error 通知は別経路の既存挙動
  assert.isDefined(subscriber);
  assert.deepEqual(subscriber!.largestLocation, { group: 7n, object: 2n });
  assert.isFalse(subscriber!.forwardState);
  assert.isDefined(notifiedError);
  assert.equal(internal.sessionState, "connected");
});

/**
 * draft-ietf-moq-transport-20 §10.10 / §10.2.1:
 * 受信 PUBLISH ストリーム上で許可外パラメータを含む PUBLISH_STATE_NOTIFY を
 * 受信した場合、PROTOCOL_VIOLATION でセッションを閉じることを検証する。
 */
test("受信 PUBLISH ストリーム上の許可外パラメータの PUBLISH_STATE_NOTIFY でセッションが閉じる", async () => {
  const session = createSessionImpl();
  const sessionInternal = session as unknown as {
    sessionState: SessionState;
  };
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
  });

  // SUBSCRIBER_PRIORITY (0x20) は本メッセージに許可されない
  const writer = new ControlStreamWriter();
  const notifyFramed = writer.encode(
    MessageType.PUBLISH_STATE_NOTIFY,
    encodePublishStateNotifyPayload({
      type: MessageType.PUBLISH_STATE_NOTIFY,
      parameters: [{ type: MessageParameterType.SUBSCRIBER_PRIORITY, value: new Uint8Array([10]) }],
    }),
  );
  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(
      (controller) => {
        controller.close();
      },
      [notifyFramed],
    ),
  );

  assert.equal(sessionInternal.sessionState, "closed");
});

/**
 * draft-ietf-moq-transport-20 §10.11:
 * 受信 PUBLISH に Subscription Parameters (FORWARD / timeouts /
 * SUBSCRIBER_PRIORITY / LOCATION_FILTER) が含まれても、スコープ検証を通過し
 * セッションが閉じないことを検証する。
 */
test("受信 PUBLISH の Subscription Parameters は PROTOCOL_VIOLATION にならない", async () => {
  const session = createSessionImpl();
  let subscriber: SubscriberImpl | undefined;
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
    error: () => {
      // error コールバックは登録削除より前に呼ばれるため、ここで購読を引き取る
      subscriber = internal.subscribers.get(INCOMING_PUBLISH_REQUEST_ID);
    },
  });

  // FORWARD + 新規 4 種 (timeouts 2 種 / PRIORITY / LOCATION_FILTER) を
  // 含む PUBLISH を注入し、その後 FIN する
  const parameters = [
    { type: MessageParameterType.FORWARD, value: new Uint8Array([1]) },
    { type: MessageParameterType.OBJECT_DELIVERY_TIMEOUT, value: new Uint8Array([0x05]) },
    { type: MessageParameterType.SUBGROUP_DELIVERY_TIMEOUT, value: new Uint8Array([0x06]) },
    { type: MessageParameterType.SUBSCRIBER_PRIORITY, value: new Uint8Array([10]) },
    encodeLocationFilterParameter({ startGroup: 3n }),
  ];
  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(
      (controller) => {
        controller.close();
      },
      [],
      parameters,
    ),
  );

  // スコープ違反ではないためセッションは閉じず、購読が確立する
  assert.isDefined(subscriber);
  assert.isTrue(subscriber!.forwardState);
  assert.equal(internal.sessionState, "connected");
});

/**
 * draft-ietf-moq-transport-20 §10.11 / §5.1.2:
 * 受信 PUBLISH の LOCATION_FILTER が subscriber の初期フィルタとして
 * 反映されることを検証する。
 */
test("受信 PUBLISH の LOCATION_FILTER が subscriber に反映される", async () => {
  const session = createSessionImpl();
  let subscriber: SubscriberImpl | undefined;
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
    error: () => {
      subscriber = internal.subscribers.get(INCOMING_PUBLISH_REQUEST_ID);
    },
  });

  const filter = encodeLocationFilterParameter({ startGroup: 10n, startObject: 2n });
  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(
      (controller) => {
        controller.close();
      },
      [],
      [filter],
    ),
  );

  // 初期フィルタとして反映される
  // (LocationFilter の公開取得子がないため内部フィールドを直接確認する)
  assert.isDefined(subscriber);
  const locationFilter = (subscriber as unknown as { locationFilter: unknown }).locationFilter as {
    startGroup?: bigint;
    startObject?: bigint;
  };
  assert.isDefined(locationFilter);
  assert.equal(locationFilter.startGroup, 10n);
  assert.equal(locationFilter.startObject, 2n);
  assert.equal(internal.sessionState, "connected");
});

/**
 * draft-ietf-moq-transport-20 §10.11 / §10.2.1:
 * 受信 PUBLISH に許可外パラメータ (NEW_GROUP_REQUEST / Range Filters /
 * FILL_PARAMETERS) が含まれる場合、PROTOCOL_VIOLATION でセッションを
 * 閉じることを検証する。
 */
test("受信 PUBLISH の許可外パラメータでセッションが閉じる", async () => {
  const prohibited = [
    [{ type: MessageParameterType.NEW_GROUP_REQUEST, value: new Uint8Array([0x01]) }],
    [{ type: MessageParameterType.SUBGROUP_FILTER, value: new Uint8Array([0x00]) }],
    [{ type: MessageParameterType.FILL_PARAMETERS, value: new Uint8Array([0x00]) }],
  ];
  for (const parameters of prohibited) {
    const session = createSessionImpl();
    const sessionInternal = session as unknown as {
      sessionState: SessionState;
    };
    const internal = setupIncomingPublishStreamSession(session, {
      object: () => {},
    });

    await internal.handleIncomingBidirectionalStream(
      createIncomingPublishStream(
        (controller) => {
          controller.close();
        },
        [],
        parameters,
      ),
    );

    assert.equal(sessionInternal.sessionState, "closed");
  }
});

/**
 * draft-ietf-moq-transport-20 §10.2.18 / §10.2.8 / §5.1.2:
 * 受信 PUBLISH に値域外の FORWARD / GROUP_ORDER / End Group 超過の
 * LOCATION_FILTER が含まれる場合、PROTOCOL_VIOLATION でセッションを
 * 閉じることを検証する。FORWARD / GROUP_ORDER はデコード層で先に
 * 検出され、LOCATION_FILTER 超過は初期パラメータ反映時に検出される。
 */
test("受信 PUBLISH の値域外パラメータでセッションが閉じる", async () => {
  // StartGroup=MAX_VARINT + StartObject=0 + EndGroupDelta=1 で End Group 超過
  const overflowFields = new Uint8Array([
    ...encodeVarint(MAX_VARINT),
    ...encodeVarint(0n),
    ...encodeVarint(1n),
  ]);
  const overflowValue = new Uint8Array([
    ...encodeVarint(BigInt(overflowFields.length)),
    ...overflowFields,
  ]);
  const invalidCases = [
    [{ type: MessageParameterType.FORWARD, value: new Uint8Array([2]) }],
    [{ type: MessageParameterType.GROUP_ORDER, value: new Uint8Array([0x03]) }],
    [{ type: MessageParameterType.LOCATION_FILTER, value: overflowValue }],
  ];
  for (const parameters of invalidCases) {
    const session = createSessionImpl();
    const sessionInternal = session as unknown as {
      sessionState: SessionState;
    };
    const internal = setupIncomingPublishStreamSession(session, {
      object: () => {},
    });

    await internal.handleIncomingBidirectionalStream(
      createIncomingPublishStream(
        (controller) => {
          controller.close();
        },
        [],
        parameters,
      ),
    );

    assert.equal(sessionInternal.sessionState, "closed");
  }
});
