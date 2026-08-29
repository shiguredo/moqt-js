/**
 * SessionImpl の単体テスト
 *
 * WebTransport のモックを渡して SessionImpl を構築し、送信前検証をテストする。
 */

import { test, assert } from "vite-plus/test";
import { SessionImpl, type TracksSubscriptionCallbacks } from "./session";
import { ControlStreamWriter, ControlStreamReader } from "./controlStream";
import { MessageType, encodeGoawayPayload } from "./message";
import { ObjectStatus } from "./message/types";
import { encodePublishPayload } from "./message/publish";
import { createTrackNamespace } from "./message/parameter";
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
import { MAX_VARINT } from "./varint";
import {
  FetchHeaderType,
  FetchSerializationFlags,
  type FetchObjectFields,
  SubgroupHeaderType,
  encodeFetchHeader,
  encodeFetchObjectFields,
  encodeObjectFields,
  encodeSubgroupHeader,
  createFirstFetchObjectFlags,
  decodeFetchObjectFields,
} from "./dataStream";
import { SubscriberImpl } from "./subscriber";
import { bidiCancelFetch, type BidiSessionInternal } from "./session/bidi";
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
 * draft-ietf-moq-transport-19 §5.1.2 (Location Filters):
 * AbsoluteRange の End Group (Start Location の Group + End Group Delta) が
 * 2^64-1 を超える filter を subscribe() に渡すと、送信前に InvalidFilterError
 * で reject される。Message Parameters 構築は pendingSubscribe.set より前
 * (Promise 作成前) に走するため、pending エントリが残らないことを検証する。
 */
test("subscribe: AbsoluteRange の End Group が 2^64-1 を超えると throw し pendingSubscribe が残らない", async () => {
  const session = createSessionImpl();

  let thrown: Error | undefined;
  try {
    await session.subscribe(
      ["live"],
      "video",
      { object: () => {} },
      {
        filter: {
          type: "AbsoluteRange",
          startLocation: { group: MAX_VARINT, object: 0n },
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
 * draft-ietf-moq-transport-19 §10.9.1 / §3.3.2:
 * 受信 PUBLISH ストリーム (runPublishStreamSubLoop) でピアが GOAWAY を送らずに
 * FIN した場合、応答待ちの REQUEST_UPDATE の update() の Promise が reject
 * され、エントリが削除されることを検証する。
 */
test("受信 PUBLISH ストリーム上のピア FIN で応答待ちの REQUEST_UPDATE が reject されエントリが削除される", async () => {
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
    tracksSubscriptions: Map<
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
    tracksSubscriptions: Map<
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
