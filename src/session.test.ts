/**
 * SessionImpl の単体テスト
 *
 * WebTransport のモックを渡して SessionImpl を構築し、送信前検証をテストする。
 */

import { test, assert } from "vite-plus/test";
import {
  SessionImpl,
  type ConnectCallbacks,
  type SessionState,
  type SubscribeCallbacks,
  type TracksSubscriptionCallbacks,
} from "./session";
import { connect } from "./index";
import { ControlStreamWriter, ControlStreamReader } from "./controlStream";
import {
  MessageType,
  MessageParameterType,
  SetupOptionType,
  AuthorizationTokenAliasType,
  encodeAuthorizationToken,
  encodeGoawayPayload,
  encodePublishDonePayload,
  type AuthorizationToken,
} from "./message";
import {
  decodePublishStateNotifyPayload,
  encodeRequestOkPayload,
  encodePublishStateNotifyPayload,
} from "./message/session";
import { ObjectStatus, PublishDoneStatusCode, GroupOrder } from "./message/types";
import { encodePublishPayload } from "./message/publish";
import { encodeRequestUpdatePayload } from "./message/subscribe";
import {
  createTrackNamespace,
  encodeLocation,
  encodeLocationFilterParameter,
  getParameterLocationValue,
} from "./message/parameter";
import type { RangeFilterSpec } from "./message/parameter";
import { FetcherImpl, type Fetcher } from "./fetcher";
import { AuthTokenCache } from "./session/authTokenCache";
import {
  InvalidFilterError,
  MalformedTrackError,
  RequestError,
  RequestErrorCode,
  SessionError,
  SessionErrorCode,
} from "./error";
import {
  concatUint8Arrays,
  nodeProcess,
  priorGroupIdGapProperties,
  priorObjectIdGapProperties,
} from "./testSupport/helpers";
import { waitForMacrotask } from "./testSupport/bidi";
import { MAX_VARINT, decodeVarint, encodeVarint } from "./varint";
import {
  createSetup,
  decodeSetupPayload,
  encodeSetupPayload,
  getSetupMaxAuthTokenCacheSize,
  getSetupMaxFilterRanges,
  getSetupMaxRequestUpdates,
} from "./message/setup";
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
import { decodeFetchPayload, encodeFetchOkPayload, type Fetch } from "./message/fetch";
import { encodeProperties } from "./properties";
import { SubscriberImpl } from "./subscriber";
import { PublisherImpl } from "./publisher";
import {
  bidiCancelFetch,
  bidiCancelSubscription,
  RESET_REQUEST_STREAM_MESSAGE,
  RESET_FETCH_DATA_STREAM_MESSAGE,
  type BidiSessionInternal,
} from "./session/bidi";
import { REQUEST_UPDATE_STREAM_CLOSED_MESSAGE } from "./session/namespaceLoops";
import { incomingHandleFirstBidiMessage } from "./session/incoming";
import type { PriorGapTracking } from "./session/priorGapTracking";
import type { FullTrackNameKey } from "./fullTrackName";
import type { SessionInternal } from "./session/types";

/**
 * SessionImpl を構築するための WebTransport モック
 *
 * 検証が throw する経路のテストでは、それより後 (createBidirectionalStream 等) に
 * 到達しないため、transport は最小限のプロパティのみでよい。
 */
function createSessionImpl(callbacks: ConnectCallbacks = {}): SessionImpl {
  const transport = {
    closed: new Promise<WebTransportCloseInfo>(() => {}),
  } as unknown as WebTransport;
  return new SessionImpl(transport, callbacks);
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
 * draft-ietf-moq-transport-21 §3.3.1 (Location Filters):
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
 * draft-ietf-moq-transport-21 §9.1.6 (MAX FILTER RANGES):
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
 * draft-ietf-moq-transport-21 §3.3.2:
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
 * draft-ietf-moq-transport-21 §3.3.1 (Location Filters):
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

// ============================================================================
// 送信失敗時の pending 掃除
// ============================================================================

/**
 * controlWriter 未初期化のセッションで publish() を呼ぶと送信前に throw し、
 * pendingPublish にエントリが残らないことを検証する。
 *
 * 送信失敗で pending が残ると、セッション終了時の reject がハンドラ不在で
 * unhandled rejection の素になる。送信は pending 登録後のため try/catch で
 * 掃除する (subscribe() と同パターン)。
 */
test("publish: 送信失敗時に throw し pendingPublish が残らない", async () => {
  const session = createSessionImpl();

  let thrown: Error | undefined;
  try {
    await session.publish(["live"], "track");
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("Control writer not initialized"));
  assert.equal(
    (session as unknown as { pendingPublish: Map<bigint, unknown> }).pendingPublish.size,
    0,
  );
});

/**
 * controlWriter 未初期化のセッションで fetch() を呼ぶと送信前に throw し、
 * pendingFetch にエントリが残らないことを検証する。
 */
test("fetch: 送信失敗時に throw し pendingFetch が残らない", async () => {
  const session = createSessionImpl();

  let thrown: Error | undefined;
  try {
    await session.fetch(
      ["live"],
      "video",
      { filter: { startGroup: 1n, startObject: 0n } },
      {
        object: () => {},
      },
    );
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("Control writer not initialized"));
  assert.equal((session as unknown as { pendingFetch: Map<bigint, unknown> }).pendingFetch.size, 0);
});

/**
 * controlWriter 未初期化のセッションで trackStatus() を呼ぶと送信前に throw し、
 * pendingTrackStatus にエントリが残らないことを検証する。
 */
test("trackStatus: 送信失敗時に throw し pendingTrackStatus が残らない", async () => {
  const session = createSessionImpl();

  let thrown: Error | undefined;
  try {
    await session.trackStatus(["live"], "video");
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("Control writer not initialized"));
  assert.equal(
    (session as unknown as { pendingTrackStatus: Map<bigint, unknown> }).pendingTrackStatus.size,
    0,
  );
});

/**
 * controlWriter 未初期化のセッションで subscribe() を呼んでも
 * pendingSubscribe にエントリが残らないことを検証する (対応済みの回帰ガード)。
 */
test("subscribe: 送信失敗時に throw し pendingSubscribe が残らない", async () => {
  const session = createSessionImpl();

  let thrown: Error | undefined;
  try {
    await session.subscribe(["live"], "video", { object: () => {} });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("Control writer not initialized"));
  assert.equal(
    (session as unknown as { pendingSubscribe: Map<bigint, unknown> }).pendingSubscribe.size,
    0,
  );
});

/**
 * publish() のパラメータ構築が throw する場合 (負の EXPIRES)、
 * pendingPublish.set より前で失敗するためエントリが残らないことを検証する。
 */
test("publish: パラメータ構築の失敗で throw し pendingPublish が残らない", async () => {
  const session = createSessionImpl();

  let thrown: Error | undefined;
  try {
    await session.publish(["live"], "track", undefined, { expires: -1n });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.equal(
    (session as unknown as { pendingPublish: Map<bigint, unknown> }).pendingPublish.size,
    0,
  );
});

/**
 * 送信失敗した publish() の呼び出し元がエラーを観測した後、セッションを
 * close() しても孤児 Promise の reject による unhandled rejection が
 * 発生しないことを検証する。
 */
test("publish: 送信失敗後に close() しても unhandled rejection が発生しない", async () => {
  const session = createSessionImpl();

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  nodeProcess.on("unhandledRejection", onUnhandled);
  try {
    // 呼び出し元のエラーは観測する (内部の孤児 Promise だけが未観測になる構造)
    let thrown: Error | undefined;
    try {
      await session.publish(["live"], "track");
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    }
    assert.isDefined(thrown);
    assert.equal(
      (session as unknown as { pendingPublish: Map<bigint, unknown> }).pendingPublish.size,
      0,
    );
    await session.close();
    // unhandledRejection は reject 後のマイクロタスクで発火するため、50ms の
    // 壁時計待ちで確実に検出できる (CI 負荷を考慮した十分な余裕)。
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    assert.equal(unhandled.length, 0);
  } finally {
    nodeProcess.off("unhandledRejection", onUnhandled);
  }
});

/**
 * writer.write() が失敗する注入 transport で publish() を呼ぶためのセッションを構築する。
 *
 * 作成済みストリームの cancel / abort / releaseLock の呼び出しを観測できる。
 */
function createWriteFailureSession(): {
  session: SessionImpl;
  cancelled: unknown[];
  aborted: unknown[];
  isReleased: () => boolean;
} {
  const cancelled: unknown[] = [];
  const aborted: unknown[] = [];
  let released = false;
  const writer = {
    write: async (): Promise<void> => {
      throw new Error("write failed");
    },
    abort: async (reason?: unknown): Promise<void> => {
      aborted.push(reason);
    },
    releaseLock: (): void => {
      released = true;
    },
  };
  const stream = {
    readable: {
      cancel: async (reason?: unknown): Promise<void> => {
        cancelled.push(reason);
      },
    },
    writable: {
      getWriter: (): unknown => writer,
    },
  };
  const transport = {
    closed: new Promise<WebTransportCloseInfo>(() => {}),
    createBidirectionalStream: async (): Promise<WebTransportBidirectionalStream> =>
      stream as unknown as WebTransportBidirectionalStream,
  } as unknown as WebTransport;
  const session = new SessionImpl(transport, {});
  (session as unknown as { controlWriter: ControlStreamWriter }).controlWriter =
    new ControlStreamWriter();
  return { session, cancelled, aborted, isReleased: () => released };
}

/**
 * writer.write() 失敗時に作成済みストリームが RESET で閉じられ、
 * 呼び出し元に送信エラーが伝播し、pendingPublish が残らないことを検証する。
 *
 * RESET は readable.cancel() (STOP_SENDING 相当) と writer.abort() で行い、
 * FIN である writer.close() は使わない (bidiCancelSubscription と同形)。
 */
test("publish: write 失敗時にストリームが RESET で閉じられ pendingPublish が残らない", async () => {
  const { session, cancelled, aborted, isReleased } = createWriteFailureSession();

  let thrown: Error | undefined;
  try {
    await session.publish(["live"], "track");
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  // 呼び出し元には送信エラーが伝播する
  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("write failed"));
  // 作成済みストリームは RESET で閉じられる (固定 reason 文言を pin する)
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0], "request send failed");
  assert.equal(aborted.length, 1);
  assert.equal(aborted[0], "request send failed");
  assert.isTrue(isReleased());
  // pending エントリは残らず、requestStreams にも登録されない
  assert.equal(
    (session as unknown as { pendingPublish: Map<bigint, unknown> }).pendingPublish.size,
    0,
  );
  assert.equal(
    (session as unknown as { requestStreams: Map<bigint, unknown> }).requestStreams.size,
    0,
  );
});

/**
 * writer.write() 失敗時に fetch() の pendingFetch が残らず、
 * requestStreams にも登録されないことを検証する。
 */
test("fetch: write 失敗時に pendingFetch が残らず requestStreams も空のまま", async () => {
  const { session } = createWriteFailureSession();

  let thrown: Error | undefined;
  try {
    await session.fetch(
      ["live"],
      "video",
      { filter: { startGroup: 1n, startObject: 0n } },
      {
        object: () => {},
      },
    );
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("write failed"));
  assert.equal((session as unknown as { pendingFetch: Map<bigint, unknown> }).pendingFetch.size, 0);
  assert.equal(
    (session as unknown as { requestStreams: Map<bigint, unknown> }).requestStreams.size,
    0,
  );
});

/**
 * writer.write() 失敗時に trackStatus() の pendingTrackStatus が残らず、
 * requestStreams にも登録されないことを検証する。
 */
test("trackStatus: write 失敗時に pendingTrackStatus が残らず requestStreams も空のまま", async () => {
  const { session } = createWriteFailureSession();

  let thrown: Error | undefined;
  try {
    await session.trackStatus(["live"], "video");
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("write failed"));
  assert.equal(
    (session as unknown as { pendingTrackStatus: Map<bigint, unknown> }).pendingTrackStatus.size,
    0,
  );
  assert.equal(
    (session as unknown as { requestStreams: Map<bigint, unknown> }).requestStreams.size,
    0,
  );
});

/**
 * draft-ietf-moq-transport-21 §3.3.2:
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
 * draft-ietf-moq-transport-21 §3.3.2:
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
 * draft-ietf-moq-transport-21 §9.5.1 / §6.4.2.2:
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
 * draft-ietf-moq-transport-21 §9.2:
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
 * 双方向ストリーム (PUBLISH のリクエストストリーム) へ write されたバイト列は
 * written に蓄積し、PUBLISH_STATE_NOTIFY 等の送信メッセージの検証に使う。
 */
function createPublishSession(): {
  session: SessionImpl;
  readableController: ReadableStreamDefaultController<Uint8Array>;
  written: Uint8Array[];
} {
  let readableController!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      readableController = controller;
    },
  });
  const written: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      written.push(chunk);
    },
  });
  const transport = {
    closed: new Promise<WebTransportCloseInfo>(() => {}),
    createBidirectionalStream: async (): Promise<WebTransportBidirectionalStream> => {
      return { readable, writable } as unknown as WebTransportBidirectionalStream;
    },
    // Subgroup ストリーム (sendObject) は write のみを受け付ける実物で構成する
    createUnidirectionalStream: async (): Promise<WritableStream<Uint8Array>> => {
      return new WritableStream<Uint8Array>({});
    },
  } as unknown as WebTransport;
  const session = new SessionImpl(transport, {});
  (session as unknown as { controlWriter: ControlStreamWriter }).controlWriter =
    new ControlStreamWriter();
  return { session, readableController, written };
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
 * draft-ietf-moq-transport-21 §3.1 (Subscriptions):
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
 * draft-ietf-moq-transport-21 §3.1 (Subscriptions):
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
 * draft-ietf-moq-transport-21 §9.20.19 (FORWARD Parameter):
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
 * draft-ietf-moq-transport-21 §9.20.17 / §9.20.19 (FORWARD Parameter):
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
 * draft-ietf-moq-transport-21 §9.20.17 / §9.20.1:
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
 * draft-ietf-moq-transport-21 §9.10 (PUBLISH_STATE_NOTIFY) / §9.20.18:
 * Session.publish() が返す Publisher の notifyStateChange() が、確立した購読の
 * 双方向ストリームへ PUBLISH_STATE_NOTIFY を送信し、送信済み Object がある
 * 場合は LARGEST_OBJECT を必ず伴うことを検証する (公開 API から送信経路までの配線)。
 */
test("publish: notifyStateChange が LARGEST_OBJECT 付きの PUBLISH_STATE_NOTIFY を送信する", async () => {
  const { session, readableController, written } = createPublishSession();

  const promise = session.publish(["live"], "track");
  promise.catch(() => {});
  // FORWARD 省略の PUBLISH_OK を応答して購読を確立する
  const writer = new ControlStreamWriter();
  const okPayload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [],
  });
  readableController.enqueue(writer.encode(MessageType.REQUEST_OK, okPayload));
  const publisher = await promise;

  // Object を送信して LARGEST_OBJECT を既知にする
  await publisher.sendObject({ groupId: 3, objectId: 4, payload: new Uint8Array([1, 2, 3]) });
  // 変化した Forward State を購読者へ通知する
  await publisher.notifyStateChange({ forward: false });

  // リクエストストリームへ write されたメッセージ列から PUBLISH_STATE_NOTIFY を取り出す
  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  const notify = messages.find((message) => message.type === MessageType.PUBLISH_STATE_NOTIFY);
  assert.isDefined(notify);
  const decoded = decodePublishStateNotifyPayload(notify!.payload);

  // 送信済み Object があるため LARGEST_OBJECT が必ず載る
  const largestParam = decoded.parameters.find(
    (param) => param.type === MessageParameterType.LARGEST_OBJECT,
  );
  assert.isDefined(largestParam);
  assert.deepEqual(getParameterLocationValue(largestParam!), { group: 3n, object: 4n });
  // FORWARD は変化後の値 (0) を報告する
  const forwardParam = decoded.parameters.find(
    (param) => param.type === MessageParameterType.FORWARD,
  );
  assert.isDefined(forwardParam);
  assert.deepEqual([...forwardParam!.value], [0]);
  // 送信できた変更は publisher の Forward State へ反映される
  assert.isFalse(publisher.forwardState);

  readableController.close();
  await session.close();
});

/**
 * draft-ietf-moq-transport-21 §9.1.6:
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
 * draft-ietf-moq-transport-21 §3.4:
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
 * 受信 PUBLISH の処理完了 (SubscriberImpl の登録) を待つ
 *
 * createIncomingPublishStream の終端を保留したまま PUBLISH を処理させ、
 * 購読が active の間に handleObject でフィルタ適用を検証できるようにする。
 *
 * @param internal - 受信 PUBLISH の内部状態ビュー
 * @param requestId - 待機対象の Request ID (既定は INCOMING_PUBLISH_REQUEST_ID)
 */
async function waitForIncomingPublishSubscriber(
  internal: IncomingPublishStreamInternals,
  requestId: bigint = INCOMING_PUBLISH_REQUEST_ID,
): Promise<SubscriberImpl> {
  // 購読登録は PUBLISH 処理の同一マイクロタスク連鎖で完了する。上限は
  // 実装が壊れて登録されない場合に無限ループしないための安全弁として設ける
  for (let i = 0; i < 10 && internal.subscribers.get(requestId) === undefined; i++) {
    await yieldToMacrotask();
  }
  const subscriber = internal.subscribers.get(requestId);
  if (subscriber === undefined) {
    throw new Error("受信 PUBLISH の SubscriberImpl が登録されていない");
  }
  return subscriber;
}

// 既知偶数 Type (OBJECT_DELIVERY_TIMEOUT 0x02) の Value が varint として
// 完結しない malformed Track Properties。draft-ietf-moq-transport-21 §8.3 の
// KEY_VALUE_FORMATTING_ERROR 対象である。
const MALFORMED_TRACK_PROPERTIES = new Uint8Array([0x02, 0x80]);

/**
 * payload 末尾に生バイト列を連結する
 *
 * Track Properties はメッセージ payload の末尾を占めるため、正常な
 * エンコード結果への連結で malformed な受信メッセージを再現できる。
 * 空の suffix は payload をそのまま返す。
 */
function appendPayloadSuffix(payload: Uint8Array, suffix: Uint8Array): Uint8Array {
  if (suffix.length === 0) {
    return payload;
  }
  const result = new Uint8Array(payload.length + suffix.length);
  result.set(payload, 0);
  result.set(suffix, payload.length);
  return result;
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
 * @param parameters - PUBLISH の初期パラメータ (FORWARD 等の検証用)
 * @param writable - PUBLISH_OK 書き込み先。失敗を再現する場合は reject する sink を渡す
 * @param trackName - PUBLISH の Track Name (alias 再利用の検証用)
 * @param requestId - PUBLISH の Request ID (受信 ID は使い捨てのため再利用時は別値を使う)
 * @param trackPropertiesSuffix - Track Properties の末尾に連結する生バイト列
 *   (malformed Track Properties の再現用。正常系は空)
 * @param trackNamespace - PUBLISH の Track Namespace (区切り文字の衝突検証用)
 */
function createIncomingPublishStream(
  terminate: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
  extraFrames: Uint8Array[] = [],
  parameters: { type: number; value: Uint8Array }[] = [],
  writable: WritableStream<Uint8Array> = new WritableStream<Uint8Array>({}),
  trackName = "track",
  requestId: bigint = INCOMING_PUBLISH_REQUEST_ID,
  trackPropertiesSuffix: Uint8Array = new Uint8Array(0),
  trackNamespace: string[] = INCOMING_PUBLISH_NAMESPACE,
): WebTransportBidirectionalStream {
  const publishPayload = encodePublishPayload({
    type: MessageType.PUBLISH,
    requestId,
    trackNamespace: createTrackNamespace(trackNamespace),
    trackName: new TextEncoder().encode(trackName),
    trackAlias: INCOMING_PUBLISH_TRACK_ALIAS,
    parameters,
    trackProperties: [],
  });
  // Track Properties は payload 末尾を占めるため、生バイト列の連結で malformed を再現できる
  const payload = appendPayloadSuffix(publishPayload, trackPropertiesSuffix);
  const controlWriter = new ControlStreamWriter();
  const chunks = [controlWriter.encode(MessageType.PUBLISH, payload), ...extraFrames];
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
  return { readable, writable } as unknown as WebTransportBidirectionalStream;
}

/**
 * draft-ietf-moq-transport-21 §6.4.2.3:
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

// ============================================================================
// 既知 Type の serialization 不一致 (KEY_VALUE_FORMATTING_ERROR) で閉じる
// draft-ietf-moq-transport-21 §8.3 (Key-Value-Pair Structure)
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §8.3:
 * "If a receiver understands a Type, and the following Value or Length/Value
 *  does not match the serialization defined by that Type, the receiver MUST
 *  close the session with error code KEY_VALUE_FORMATTING_ERROR."
 * 既知 Type の Value が serialization に一致しない Track Properties を含む
 * 受信 PUBLISH はセッションを閉じる (handleIncomingBidirectionalStream の
 * decodePublishPayload catch 経由)。
 */
test("受信 PUBLISH の malformed Track Properties で KEY_VALUE_FORMATTING_ERROR で閉じる", async () => {
  let closedError: Error | undefined;
  const session = createSessionImpl({
    error: (error: Error) => {
      closedError = error;
    },
  });
  const internal = setupIncomingPublishStreamSession(session, { object: () => {} });

  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(
      (controller) => {
        controller.close();
      },
      [],
      [],
      new WritableStream<Uint8Array>({}),
      "track",
      INCOMING_PUBLISH_REQUEST_ID,
      MALFORMED_TRACK_PROPERTIES,
    ),
  );

  // 具体エラー (KEY_VALUE_FORMATTING_ERROR) でセッションが閉じる
  assert.isDefined(closedError);
  assert.instanceOf(closedError, SessionError);
  assert.equal((closedError as SessionError).code, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
  assert.equal(internal.sessionState, "closed");
});

/**
 * draft-ietf-moq-transport-21 §8.3 / §9.3:
 * 受信 PUBLISH ストリーム上で malformed な Track Properties を含む
 * REQUEST_UPDATE_OK を受信したら KEY_VALUE_FORMATTING_ERROR でセッションを
 * 閉じる (runPublishStreamSubLoop の catch 経由)。
 */
test("受信 PUBLISH ストリーム上の malformed な REQUEST_UPDATE_OK で KEY_VALUE_FORMATTING_ERROR で閉じる", async () => {
  let closedError: Error | undefined;
  const session = createSessionImpl({
    error: (error: Error) => {
      closedError = error;
    },
  });
  const internal = setupIncomingPublishStreamSession(session, { object: () => {} });

  const requestOkPayload = appendPayloadSuffix(
    encodeRequestOkPayload({
      type: MessageType.REQUEST_OK,
      parameters: [],
      trackProperties: [],
    }),
    MALFORMED_TRACK_PROPERTIES,
  );
  const requestOkFrame = new ControlStreamWriter().encode(MessageType.REQUEST_OK, requestOkPayload);

  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(
      (controller) => {
        controller.close();
      },
      [requestOkFrame],
    ),
  );

  assert.isDefined(closedError);
  assert.instanceOf(closedError, SessionError);
  assert.equal((closedError as SessionError).code, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
  assert.equal(internal.sessionState, "closed");
});

// ============================================================================
// 受信 PUBLISH の PUBLISH_OK 書き込み失敗時の掃除
// ============================================================================

/**
 * PUBLISH_OK 書き込みを失敗させる sink を作る。
 *
 * 失敗値の source 分類は src/session/errors.ts の既存判定に従う。
 */
function createFailingWritable(reason: unknown): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write() {
      throw reason;
    },
  });
}

/**
 * draft-ietf-moq-transport-21 §6.4.2.3:
 * PUBLISH_OK の書き込みがピア起因 (source: "stream") で失敗した場合、
 * subscriber に error 通知が入り state が closed になることを検証する。
 * (§5.1 MUST の PUBLISH_OK を送れていないため subscription を残さない)
 * 3 マップのエントリが残らずロックが解放されることも併せて検証する。
 * handleIncomingBidirectionalStream は reject しない (unhandled rejection なし)。
 */
test("受信 PUBLISH の PUBLISH_OK 書き込み失敗 (stream) で通知され掃除される", async () => {
  const session = createSessionImpl();
  let notifiedError: Error | undefined;
  let notifyCount = 0;
  let subscriber: SubscriberImpl | undefined;
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
    error: (error: Error) => {
      notifyCount += 1;
      notifiedError = error;
      subscriber = internal.subscribers.get(INCOMING_PUBLISH_REQUEST_ID);
    },
  });
  const writable = createFailingWritable(
    Object.assign(new Error("write failed"), { source: "stream" }),
  );

  // reject せず解決すること
  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(
      (controller) => {
        controller.close();
      },
      [],
      [],
      writable,
    ),
  );

  assert.equal(notifyCount, 1);
  assert.isDefined(notifiedError);
  // ピア起因の失敗は subloop 内の RESET 経路と同じ正規化文言で通知される
  assert.equal(notifiedError!.message, RESET_REQUEST_STREAM_MESSAGE);
  assert.isDefined(subscriber);
  assert.equal(subscriber!.state, "closed");
  // 後始末: 3 マップにエントリが残らない
  assert.equal(internal.subscribers.size, 0);
  assert.equal(
    (internal as unknown as { requestStreams: Map<bigint, unknown> }).requestStreams.size,
    0,
  );
  assert.equal(
    (internal as unknown as { subscribersByAlias: Map<bigint, unknown[]> }).subscribersByAlias.size,
    0,
  );
  // ロックは解放される
  assert.isFalse(writable.locked);
  // プロトコル違反ではないためセッションは閉じない
  assert.equal(internal.sessionState, "connected");
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.3:
 * PUBLISH_OK の書き込み失敗値に source が無い場合も、通知 + closed になることを検証する。
 * (Node 環境では WebTransportError が無いため message fallback で分類される)
 */
test("受信 PUBLISH の PUBLISH_OK 書き込み失敗 (source なし) で通知され掃除される", async () => {
  const session = createSessionImpl();
  let notifiedError: Error | undefined;
  let notifyCount = 0;
  let subscriber: SubscriberImpl | undefined;
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
    error: (error: Error) => {
      notifyCount += 1;
      notifiedError = error;
      subscriber = internal.subscribers.get(INCOMING_PUBLISH_REQUEST_ID);
    },
  });
  const writable = createFailingWritable(new Error("write failed"));

  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(
      (controller) => {
        controller.close();
      },
      [],
      [],
      writable,
    ),
  );

  assert.equal(notifyCount, 1);
  assert.isDefined(notifiedError);
  // source なしは正規化せず生の失敗値を通知する (stream 件との区別)
  assert.equal(notifiedError!.message, "write failed");
  assert.isDefined(subscriber);
  assert.equal(subscriber!.state, "closed");
  assert.equal(internal.subscribers.size, 0);
  assert.equal(
    (internal as unknown as { requestStreams: Map<bigint, unknown> }).requestStreams.size,
    0,
  );
  assert.equal(
    (internal as unknown as { subscribersByAlias: Map<bigint, unknown[]> }).subscribersByAlias.size,
    0,
  );
  assert.isFalse(writable.locked);
  assert.equal(internal.sessionState, "connected");
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.3:
 * PUBLISH_OK の書き込み失敗値が Error でない場合 (文字列 throw) も、
 * 通知 + closed になり掃除されることを検証する。
 */
test("受信 PUBLISH の PUBLISH_OK 書き込み失敗 (非 Error) で通知され掃除される", async () => {
  const session = createSessionImpl();
  let notifiedError: Error | undefined;
  let notifyCount = 0;
  let subscriber: SubscriberImpl | undefined;
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
    error: (error: Error) => {
      notifyCount += 1;
      notifiedError = error;
      subscriber = internal.subscribers.get(INCOMING_PUBLISH_REQUEST_ID);
    },
  });
  const writable = createFailingWritable("boom");

  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(
      (controller) => {
        controller.close();
      },
      [],
      [],
      writable,
    ),
  );

  assert.equal(notifyCount, 1);
  assert.isDefined(notifiedError);
  assert.equal(notifiedError!.message, "boom");
  assert.isDefined(subscriber);
  assert.equal(subscriber!.state, "closed");
  assert.equal(internal.subscribers.size, 0);
  assert.isFalse(writable.locked);
  assert.equal(internal.sessionState, "connected");
});

/**
 * draft-ietf-moq-transport-21 §6.6:
 * PUBLISH_OK の書き込み失敗がセッション終了起因 (source: "session") の場合、
 * 通知はせず state だけ closed にすることを検証する。
 * (通知なしのため subscriber 参照は取れず、session 分岐の実行は
 * 後始末と非通知で確認する)
 */
test("受信 PUBLISH の PUBLISH_OK 書き込み失敗 (session) で通知なく掃除される", async () => {
  const session = createSessionImpl();
  let notifyCount = 0;
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
    error: () => {
      notifyCount += 1;
    },
  });
  const writable = createFailingWritable(
    Object.assign(new Error("session closed by peer"), { source: "session" }),
  );

  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(
      (controller) => {
        controller.close();
      },
      [],
      [],
      writable,
    ),
  );

  assert.equal(notifyCount, 0);
  assert.equal(internal.subscribers.size, 0);
  assert.equal(
    (internal as unknown as { requestStreams: Map<bigint, unknown> }).requestStreams.size,
    0,
  );
  assert.equal(
    (internal as unknown as { subscribersByAlias: Map<bigint, unknown[]> }).subscribersByAlias.size,
    0,
  );
  assert.isFalse(writable.locked);
  assert.equal(internal.sessionState, "connected");
});

/**
 * draft-ietf-moq-transport-21 §3.1.2:
 * PUBLISH_OK 失敗で掃除された後は、別 Track への同一 Track Alias の後続
 * PUBLISH が DUPLICATE_TRACK_ALIAS で誤検出されないことを検証する。
 */
test("PUBLISH_OK 失敗後の同一 alias 再利用で DUPLICATE_TRACK_ALIAS にならない", async () => {
  const session = createSessionImpl();
  let notifyCount = 0;
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
    error: () => {
      notifyCount += 1;
    },
  });
  const failingWritable = createFailingWritable(
    Object.assign(new Error("write failed"), { source: "stream" }),
  );

  // 1 件目の PUBLISH_OK が失敗し、残存なく掃除される (通知 1 回)
  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(
      (controller) => {
        controller.close();
      },
      [],
      [],
      failingWritable,
    ),
  );
  assert.equal(internal.subscribers.size, 0);
  assert.equal(notifyCount, 1);

  // 別 Track に同一 alias を再割り当てしても誤検出されない
  // (後続ストリームは FIN で終わり、FIN 由来の通知は別経路の既存挙動)
  // Request ID は使い捨てのため別値 (奇数) を使う
  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(
      (controller) => {
        controller.close();
      },
      [],
      [],
      new WritableStream<Uint8Array>({}),
      "other",
      3n,
    ),
  );

  // 2 件目も処理完遂 (FIN 通知) し、セッションは閉じない
  assert.equal(notifyCount, 2);
  assert.equal(internal.sessionState, "connected");
  assert.equal(internal.subscribers.size, 0);
  assert.equal(
    (internal as unknown as { requestStreams: Map<bigint, unknown> }).requestStreams.size,
    0,
  );
  assert.equal(
    (internal as unknown as { subscribersByAlias: Map<bigint, unknown[]> }).subscribersByAlias.size,
    0,
  );
});

// ============================================================================
// 受信 PUBLISH の Track Alias 重複判定 (Full Track Name の比較キー)
// draft-ietf-moq-transport-21 §2.4.1 / §3.1.2
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §3.1 / §3.1.2:
 * 同一 Track への複数 PUBLISH は許容されるため、同一 Track に同一 Track Alias を
 * 使う 2 件目の PUBLISH を DUPLICATE_TRACK_ALIAS として拒否しない。
 * 受信 PUBLISH の重複判定と SubscriberImpl.getFullTrackNameKey が同じ比較キーを
 * 使っていることを検証する (片方だけ形式が変わると同一 Track が不一致になる)。
 */
test("同一 Track への複数 PUBLISH で DUPLICATE_TRACK_ALIAS にならない", async () => {
  let closedError: Error | undefined;
  const session = createSessionImpl({
    error: (error: Error) => {
      closedError = error;
    },
  });
  const internal = setupIncomingPublishStreamSession(session, { object: () => {} });

  // 1 件目を確立させ、ストリームは開いたままにする (alias 索引に残す)
  const firstHandle = internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(() => {}),
  );
  await waitForIncomingPublishSubscriber(internal);
  assert.equal(internal.subscribersByAlias.get(INCOMING_PUBLISH_TRACK_ALIAS)?.length, 1);

  // 2 件目は同一 Track (namespace ["live"] + trackName "track") + 同一 alias
  const secondHandle = internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(() => {}, [], [], new WritableStream<Uint8Array>({}), "track", 3n),
  );
  await waitForIncomingPublishSubscriber(internal, 3n);

  // 2 件とも同一 alias に登録され、セッションは閉じない
  assert.isUndefined(closedError);
  assert.equal(internal.sessionState, "connected");
  assert.equal(internal.subscribersByAlias.get(INCOMING_PUBLISH_TRACK_ALIAS)?.length, 2);

  // 後始末: 両ストリームを解除して読み取りループを終わらせる
  await internal.subscribers.get(INCOMING_PUBLISH_REQUEST_ID)?.unsubscribe();
  await internal.subscribers.get(3n)?.unsubscribe();
  await firstHandle;
  await secondHandle;
  assert.equal(internal.sessionState, "connected");
});

/**
 * draft-ietf-moq-transport-21 §2.4.1 / §3.1.2:
 * namespace ["live"] + trackName "track/x" と namespace ["live","track"] +
 * trackName "x" は "/" 連結では同じ "live/track/x" になっていた別 Track である。
 * 別 Track に同一 Track Alias が使われた場合は DUPLICATE_TRACK_ALIAS で閉じる。
 */
test("区切り文字が衝突する別 Track への同一 alias PUBLISH で DUPLICATE_TRACK_ALIAS になる", async () => {
  let closedError: Error | undefined;
  const session = createSessionImpl({
    error: (error: Error) => {
      closedError = error;
    },
  });
  const internal = setupIncomingPublishStreamSession(session, { object: () => {} });

  // 先行して namespace ["live"] + trackName "track/x" の購読が同一 alias で確立済み
  const existingSubscriber = new SubscriberImpl(
    ["live"],
    "track/x",
    INCOMING_PUBLISH_REQUEST_ID,
    INCOMING_PUBLISH_TRACK_ALIAS,
    () => {},
  );
  internal.subscribers.set(INCOMING_PUBLISH_REQUEST_ID, existingSubscriber);
  internal.subscribersByAlias.set(INCOMING_PUBLISH_TRACK_ALIAS, [existingSubscriber]);

  // 衝突する別 Track (namespace ["live","track"] + trackName "x") の PUBLISH を受信する
  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(
      (controller) => {
        controller.close();
      },
      [],
      [],
      new WritableStream<Uint8Array>({}),
      "x",
      3n,
      new Uint8Array(0),
      ["live", "track"],
    ),
  );

  // 旧実装で同じキーになっていた別 Track のため、alias 重複としてセッションを閉じる
  assert.isDefined(closedError);
  assert.equal((closedError as SessionError).code, SessionErrorCode.DUPLICATE_TRACK_ALIAS);
  assert.equal(internal.sessionState, "closed");
});

// ============================================================================
// 受信 PUBLISH の購読解除時の STOP_SENDING 到達
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §3.1:
 * 受信 PUBLISH 由来の subscriber について、読み取りループ生存中に
 * unsubscribe() を呼んだ場合、ロック保持者経由で cancel (STOP_SENDING 相当)
 * が到達し、後続の writer.abort() も実行されることを検証する。
 * 実 W3C ストリーム注入方式であり、ロック解除経路をまたぐことを検証する。
 */
test("受信 PUBLISH の購読解除で STOP_SENDING が到達し abort も実行される", async () => {
  const session = createSessionImpl();
  const notifiedErrors: Error[] = [];
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
    error: (error: Error) => {
      notifiedErrors.push(error);
    },
  });
  const aborted: unknown[] = [];
  const writable = new WritableStream<Uint8Array>({
    write() {},
    abort(reason) {
      aborted.push(reason);
    },
  });

  const handlePromise = internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(
      // チャンク枯渇後も FIN せず開いたままにする (読み取りループを待機させる)
      () => {},
      [],
      [],
      writable,
    ),
  );
  // PUBLISH 処理完了 (購読登録) を待つ。処理はマイクロタスク駆動のため
  // マクロタスク待ちで確定する
  await yieldToMacrotask();
  await yieldToMacrotask();
  const subscriber = internal.subscribers.get(INCOMING_PUBLISH_REQUEST_ID);
  assert.isDefined(subscriber);

  // 読み取りループ生存中に解除する
  await subscriber!.unsubscribe();

  // abort まで到達する (従来は cancel 失敗でスキップされた)
  assert.equal(aborted.length, 1);
  assert.equal(aborted[0], "subscription cancelled");
  // 自前解除のため error 通知はなく、Map も掃除され、state は閉じる
  assert.equal(notifiedErrors.length, 0);
  assert.equal(internal.subscribers.size, 0);
  assert.equal(
    (internal as unknown as { requestStreams: Map<bigint, unknown> }).requestStreams.size,
    0,
  );
  assert.equal(
    (internal as unknown as { subscribersByAlias: Map<bigint, unknown[]> }).subscribersByAlias.size,
    0,
  );
  assert.equal(subscriber!.state, "closed");
  assert.isFalse(writable.locked);
  // 読み取りループが終了し、セッションは閉じない
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error("受信ループがタイムアウトしました"));
    }, 5000);
  });
  try {
    await Promise.race([handlePromise, timeout]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
  assert.equal(internal.sessionState, "connected");
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.2 / §6.4.2.3 / §9.5.1:
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
 * draft-ietf-moq-transport-21 §6.4.2.2 / §6.4.2.3:
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
 * draft-ietf-moq-transport-21 §12.5:
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
 * draft-ietf-moq-transport-21 §9.2:
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
 * draft-ietf-moq-transport-21 §6.4.2.3 / §6.6 / §9.5.1:
 * 受信 PUBLISH ストリームでセッション終了起因 (source: "session") の読み取り
 * 失敗が起きても、通知はせず、state は closed にし、保留中の REQUEST_UPDATE は
 * 失敗として reject することを検証する (兄弟分岐・namespace ループと同順)。
 */
test("受信 PUBLISH ストリーム上のセッション終了の読み取り失敗では通知せず閉じて更新は reject される", async () => {
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

  // セッション終了は購読者への通知対象外だが、保留中の更新は失敗として reject する
  assert.isDefined(rejected);
  assert.equal(internals.pendingRequestUpdate.size, 0);
  assert.equal(notifyCount, 0);
  assert.equal(internal.sessionState, "connected");
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.3:
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
 * draft-ietf-moq-transport-21 §6.4.2.3:
 * source を持たない内部エラーでは、生のエラーが error コールバックへ
 * 通知され、state も closed になることを検証する (namespace ループと同規則)。
 */
test("受信 PUBLISH ストリーム上の source なしエラーでは error 通知され state も closed になる", async () => {
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

  // 応答待ちの REQUEST_UPDATE を注入する (通知より先に reject される)
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
      // source プロパティを持たない内部例外を再現する
      controller.error(new Error("internal error"));
    }),
  );

  // 生のエラーがそのまま通知され、state は closed になる
  assert.isDefined(notifiedError);
  assert.equal(notifiedError!.message, "internal error");
  assert.isDefined(subscriber);
  assert.equal(subscriber!.state, "closed");
  // 応答待ちの更新は通知より先に reject される
  assert.isDefined(rejected);
  assert.equal(internals.pendingRequestUpdate.size, 0);
  assert.equal(internal.sessionState, "connected");
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.3:
 * source を持たない内部エラーでアプリの error コールバックが throw しても、例外が
 * ループ外へ伝播せず state が closed になり後始末が走ることを検証する
 * (RESET 経路と同じ理由で吸収する)。
 */
test("受信 PUBLISH ストリーム上の source なしエラーで error コールバックが throw しても state は closed になる", async () => {
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
  // state は closed になり、後続のクリーンアップも走る
  assert.equal(subscriber!.state, "closed");
  assert.isUndefined(internal.subscribers.get(INCOMING_PUBLISH_REQUEST_ID));
  assert.equal(internal.sessionState, "connected");
});

/**
 * draft-ietf-moq-transport-21 §6.6:
 * WebTransport セッション終了起因 (source: "session") のエラーでは
 * error コールバックが呼ばれず、state が closed になることを検証する。
 * エラー投入をゲートで遅延させ、subloop 待機中の subscriber 参照を確保して
 * state を直接検証する。
 * Node 環境では WebTransportError グローバルが無いため、isSessionClosedError は
 * メッセージ文字列のフォールバック判定で抑止される (source プロパティによる判定は
 * src/session/errors.test.ts が FakeWebTransportError の注入で担保している)。
 */
test("受信 PUBLISH ストリーム上のセッション終了 (source: session) では error 通知されず state は closed になる", async () => {
  const session = createSessionImpl();
  let errorCalled = false;
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
    error: () => {
      errorCalled = true;
    },
  });

  // 応答待ちの REQUEST_UPDATE を注入する (通知なしでも reject される)
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

  // エラー投入をゲートで遅延させ、subloop 待機中の subscriber を確保する
  let releaseError!: () => void;
  const errorGate = new Promise<void>((resolve) => {
    releaseError = resolve;
  });
  const handlePromise = internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream((controller) => {
      void (async () => {
        await errorGate;
        controller.error(Object.assign(new Error("session closed by peer"), { source: "session" }));
      })();
    }),
  );
  await yieldToMacrotask();
  await yieldToMacrotask();
  const subscriber = internal.subscribers.get(INCOMING_PUBLISH_REQUEST_ID);
  assert.isDefined(subscriber);
  releaseError();
  await handlePromise;

  assert.isFalse(errorCalled);
  assert.equal(subscriber!.state, "closed");
  assert.isDefined(rejected);
  assert.equal(internals.pendingRequestUpdate.size, 0);
  assert.equal(internal.sessionState, "connected");
  assert.equal(internal.subscribers.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.2 / §6.4.2.3:
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
 * draft-ietf-moq-transport-21 §9.2:
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
 * draft-ietf-moq-transport-21 §9.9 / §3.1:
 * 正常な PUBLISH_DONE (TRACK_ENDED) の処理が変わらないことを検証する回帰
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
      statusCode: BigInt(PublishDoneStatusCode.TRACK_ENDED),
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
 * draft-ietf-moq-transport-21 §9.9 / §13:
 * 削除された 0x3 SUBSCRIPTION_ENDED を受信した場合、未知コードとして
 * INTERNAL_ERROR に正規化され、エラーとして通知されることを検証する。
 * 旧版が送る 0x3 はエラー扱いになる。
 */
test("受信 PUBLISH_DONE の削除された 0x3 は end と error の両方が通知される", async () => {
  const session = createSessionImpl();
  let endCalled = false;
  let errorCalled = false;
  let subscriber: SubscriberImpl | undefined;
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
      statusCode: 0x3n,
      streamCount: 0n,
      reasonPhrase: "",
    }),
  );

  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(
      (controller) => {
        controller.close();
      },
      [publishDoneFramed],
    ),
  );

  // 正規化によりエラーと終端の両方が通知され、セッションは閉じない
  assert.isTrue(endCalled);
  assert.isTrue(errorCalled);
  assert.isDefined(subscriber);
  assert.equal(subscriber!.state, "closed");
  assert.equal(internal.sessionState, "connected");
});

/**
 * draft-ietf-moq-transport-21 §9.5.2 / §4.1:
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

  let abortCalled = false;
  const writable = new WritableStream<Uint8Array>({
    abort() {
      abortCalled = true;
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
  // draft-ietf-moq-transport-21 §4.1 / §6.4.2.3:
  // ストリームが RESET (writer.abort()) で解除され、エントリが削除される
  assert.equal(entry.state, "closed");
  assert.isTrue(abortCalled);
  assert.isFalse(sessionInternal.namespaceSubscriptions.has(1n));
});

/**
 * draft-ietf-moq-transport-21 §9.5.2 / §4.1:
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
 * draft-ietf-moq-transport-21 §9.5.2:
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
  nodeProcess.on("unhandledRejection", onUnhandled);
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
    nodeProcess.off("unhandledRejection", onUnhandled);
  }
});

/**
 * draft-ietf-moq-transport-21 §9.5.2:
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
  nodeProcess.on("unhandledRejection", onUnhandled);
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
    nodeProcess.off("unhandledRejection", onUnhandled);
  }
});

/** Uint8Array 配列を連結するヘルパー */
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
 * draft-ietf-moq-transport-21 §12.1 (Malformed Tracks):
 * Malformed Track 検出時は「cancel any corresponding subscription or fetches
 * for that Track from that publisher」であり、セッションを閉じない。
 * draft-ietf-moq-transport-21 §3.2.1 (Fetch State Management):
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
 * draft-ietf-moq-transport-21 §12.1:
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
 * draft-ietf-moq-transport-21 §3.2.1:
 * 「A subscriber keeps FETCH state until it cancels the request (see
 *  Section 6.4.2.3), receives REQUEST_ERROR, or the FETCH data stream
 *  receives a FIN or is reset.」
 * FETCH データストリームの peer RESET_STREAM で、アプリの error コールバックが
 * 1 回だけ呼ばれ、正規化済み streamErrorCode が載り、fetcher が closed になって
 * fetchers から削除されることを検証する。セッションは閉じない。
 */
test("handleIncomingStream: FETCH データストリームの RESET_STREAM で fetcher が error 通知され state が破棄される", async () => {
  const requestId = 7n;
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
    handleIncomingStream(stream: ReadableStream<Uint8Array>): Promise<void>;
  };
  const receivedErrors: Error[] = [];
  let ended = false;
  const fetcher = new FetcherImpl(
    ["live"],
    "video",
    requestId,
    () => {},
    () => {
      ended = true;
    },
    (error) => {
      receivedErrors.push(error);
    },
  );
  internal.fetchers.set(requestId, fetcher);

  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const dataStream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const runPromise = internal.handleIncomingStream(dataStream);
  controller.enqueue(encodeFetchHeader({ type: FetchHeaderType, requestId }));
  // peer の RESET_STREAM 相当: reader.read() を reject させる (CANCELLED = 0x1)
  controller.error(
    Object.assign(new Error("reset by peer"), { source: "stream", streamErrorCode: 0x1 }),
  );
  await runPromise;

  // error コールバックが 1 回だけ呼ばれ、FETCH データストリームの reset と分かる
  assert.equal(receivedErrors.length, 1);
  assert.include(receivedErrors[0].message, RESET_FETCH_DATA_STREAM_MESSAGE);
  assert.match(receivedErrors[0].message, /CANCELLED\(0x1\)/);
  assert.equal((receivedErrors[0] as Error & { streamErrorCode?: number }).streamErrorCode, 0x1);
  // reset では正常終了 (end) を通知しない
  assert.isFalse(ended);
  assert.equal(fetcher.state, "closed");
  assert.isFalse(internal.fetchers.has(requestId));
  assert.isUndefined(sessionError.current);
});

/** createFetchGroupOrderContext が返す検証用コンテキスト */
interface FetchGroupOrderContext {
  sentFrames: Uint8Array[];
  objects: MoqtObject[];
  startFetch: () => Promise<Fetcher>;
  enqueueFetchOk: () => void;
  runFetchDataStream: (data: Uint8Array) => Promise<void>;
}

/**
 * session.fetch() の Group Order 配線を検証するセッションを構築する
 *
 * draft-ietf-moq-transport-21 §9.20.9 (GROUP ORDER Parameter) / §11.4.1.1 (Flags):
 * FETCH 応答の Group ID は要求時に指定した Group Order で解釈する。GROUP_ORDER は
 * FETCH_OK に出現しないため、要求時の値が復号まで届いているかを実ストリームで
 * 確かめられるようにする。
 *
 * 送信した FETCH メッセージを取り出すため、双方向ストリームの writable は書き込みを
 * 記録する偽 writer に差し替える。readable は FETCH_OK を注入するため実ストリームを使う。
 * 受信データストリームは incomingUnidirectionalStreams の受信ループを経由せず、
 * SessionImpl.handleIncomingStream を直接呼んで注入する。
 */
function createFetchGroupOrderContext(
  groupOrder?: "Ascending" | "Descending",
): FetchGroupOrderContext {
  const sentFrames: Uint8Array[] = [];
  const writer = {
    write: async (data: Uint8Array): Promise<void> => {
      sentFrames.push(data);
    },
    releaseLock: (): void => {},
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  // ReadableStream の start はコンストラクタ内で同期的に呼ばれるため、
  // この変数は以降の参照時点で必ず代入済みになる (型に伝えるための非 null アサーション)
  let responseController!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      responseController = controller;
    },
  });

  const bidiStream = {
    readable,
    writable: { getWriter: (): unknown => writer },
  } as unknown as WebTransportBidirectionalStream;

  const transport = {
    closed: new Promise<WebTransportCloseInfo>(() => {}),
    createBidirectionalStream: async (): Promise<WebTransportBidirectionalStream> => bidiStream,
  } as unknown as WebTransport;

  const session = new SessionImpl(transport, {});
  const controlWriter = new ControlStreamWriter();
  (session as unknown as { controlWriter: ControlStreamWriter }).controlWriter = controlWriter;

  const objects: MoqtObject[] = [];
  // exactOptionalPropertyTypes では optional な groupOrder に undefined を渡せないため、
  // 指定がある場合だけ載せる
  const options = groupOrder === undefined ? {} : { groupOrder };

  return {
    sentFrames,
    objects,
    startFetch: () =>
      session.fetch(["live"], "video", options, {
        object: (object) => {
          objects.push(object);
        },
      }),
    enqueueFetchOk: () => {
      responseController.enqueue(
        controlWriter.encode(
          MessageType.FETCH_OK,
          encodeFetchOkPayload({
            type: MessageType.FETCH_OK,
            endOfTrack: true,
            endLocation: { group: 10n, object: 1n },
            parameters: [],
            trackProperties: [],
          }),
        ),
      );
    },
    runFetchDataStream: async (data: Uint8Array): Promise<void> => {
      const dataStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      });
      await (
        session as unknown as {
          handleIncomingStream(stream: ReadableStream<Uint8Array>): Promise<void>;
        }
      ).handleIncomingStream(dataStream);
    },
  };
}

/**
 * session.fetch() が送った FETCH メッセージをデコードする
 *
 * 制御メッセージと同一のフレーム形式 (Type + Length(16) + Payload) をほどいて
 * FETCH ペイロードをデコードし、FETCH データストリームの FETCH_HEADER が運ぶ
 * Request ID と、送信した GROUP_ORDER を検証できるようにする。
 */
function decodeSentFetch(frame: Uint8Array): Fetch {
  const [type, typeConsumed] = decodeVarint(frame, 0);
  assert.equal(Number(type), MessageType.FETCH);
  const length = ((frame[typeConsumed] ?? 0) << 8) | (frame[typeConsumed + 1] ?? 0);
  const payload = frame.slice(typeConsumed + 2, typeConsumed + 2 + length);
  return decodeFetchPayload(payload);
}

/**
 * session.fetch() が送った FETCH から GROUP_ORDER パラメータの値 (uint8) を取り出す
 */
function findSentGroupOrderValue(fetch: Fetch): Uint8Array | undefined {
  return fetch.parameters.find((parameter) => parameter.type === MessageParameterType.GROUP_ORDER)
    ?.value;
}

/**
 * Group ID が減少する 2 件の Object を含む FETCH データストリームを構築する
 *
 * 先頭 Object は Group 10 を絶対値で書き、2 件目は Group 7 を Descending の式で
 * 書く (delta = 10 - 7 - 1 = 2)。同じワイヤを Ascending の式で読むと 13、
 * Descending の式で読むと 7 になるため、Group Order が復号まで配線されているかを
 * 1 本のストリームで判定できる。delta を 0 以外にすることで、符号だけでなく
 * 「delta + 1」の計算そのものも検証できる。
 */
function buildGroupOrderProbeFetchStream(requestId: bigint): Uint8Array {
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(),
    groupId: 10n,
    subgroupId: 0n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 0n,
  };
  const firstEncoded = encodeFetchObjectFields(first);
  // 2 件目の delta 計算に使うコンテキストを先頭 Object のワイヤから求める
  const [, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);

  const second: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_SAME | FetchSerializationFlags.GROUP_ID_PRESENT,
    groupId: 7n,
    payloadLength: 0n,
  };
  const secondEncoded = encodeFetchObjectFields(second, false, firstContext, GroupOrder.DESCENDING);

  return concatUint8Arrays([
    encodeFetchHeader({ type: FetchHeaderType, requestId }),
    firstEncoded,
    secondEncoded,
  ]);
}

/**
 * draft-ietf-moq-transport-21 §11.4.1.1 (Flags):
 * FETCH 応答の Group ID は要求時の Group Order で解釈する。
 * session.fetch() に Descending を指定した場合、同じワイヤでも 2 件目以降の
 * Group ID が Descending の式 (prior - (delta + 1)) で復号されることを検証する。
 */
test("fetch: groupOrder Descending が FETCH 応答の Group ID 復号に反映される", async () => {
  const context = createFetchGroupOrderContext("Descending");

  const fetchPromise = context.startFetch();
  // FETCH メッセージの送信を待ち、ワイヤに出た GROUP_ORDER と Request ID を取得する
  await waitForMacrotask();
  assert.equal(context.sentFrames.length, 1);
  const sentFetch = decodeSentFetch(context.sentFrames[0] ?? new Uint8Array(0));
  // 要求した Descending が GROUP_ORDER パラメータ (0x22) の値 0x02 として載る
  assert.deepEqual(findSentGroupOrderValue(sentFetch), new Uint8Array([0x02]));
  context.enqueueFetchOk();
  await fetchPromise;

  await context.runFetchDataStream(buildGroupOrderProbeFetchStream(sentFetch.requestId));

  // 先頭 Object は絶対値で Group 10 / Object 0
  assert.equal(context.objects.length, 2);
  assert.equal(context.objects[0]?.groupId, 10n);
  assert.equal(context.objects[0]?.objectId, 0n);
  // 2 件目は Descending の式で 10 - (2 + 1) = 7
  assert.equal(context.objects[1]?.groupId, 7n);
  assert.equal(context.objects[1]?.objectId, 1n);
});

/**
 * draft-ietf-moq-transport-21 §9.20.9 (GROUP ORDER Parameter):
 * GROUP_ORDER を省略した FETCH は Ascending として復号する。
 * Descending の検証と同一のワイヤを流し、2 件目以降の Group ID が
 * Ascending の式 (prior + delta + 1) で復号されることを検証する。
 */
test("fetch: groupOrder 省略時は Ascending として FETCH 応答の Group ID を復号する", async () => {
  const context = createFetchGroupOrderContext();

  const fetchPromise = context.startFetch();
  await waitForMacrotask();
  assert.equal(context.sentFrames.length, 1);
  const sentFetch = decodeSentFetch(context.sentFrames[0] ?? new Uint8Array(0));
  // 省略時は GROUP_ORDER パラメータを送らない (ピアは Ascending で応答する)
  assert.isUndefined(findSentGroupOrderValue(sentFetch));
  context.enqueueFetchOk();
  await fetchPromise;

  await context.runFetchDataStream(buildGroupOrderProbeFetchStream(sentFetch.requestId));

  // 先頭 Object は絶対値で Group 10 / Object 0
  assert.equal(context.objects.length, 2);
  assert.equal(context.objects[0]?.groupId, 10n);
  assert.equal(context.objects[0]?.objectId, 0n);
  // 2 件目は Ascending の式で 10 + 2 + 1 = 13
  assert.equal(context.objects[1]?.groupId, 13n);
  assert.equal(context.objects[1]?.objectId, 1n);
});

/**
 * 制御ストリーム読み取りループ (startControlMessageLoop) を検証するための
 * セッションを構築する。
 */
function createControlLoopContext(controlMessageTimeoutMs = 10_000): {
  sessionError: { current: Error | undefined };
  errorControl: (error: unknown) => void;
  enqueue: (data: Uint8Array) => void;
  start: () => void;
  setSessionState: (state: string) => void;
} {
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
    sessionState: string;
    controlReceiveStream?: ReadableStream<Uint8Array>;
    controlReader?: ControlStreamReader;
    controlMessageTimeoutMs: number;
    startControlMessageLoop(): void;
  };
  // initialize() を経由せずタイムアウト値だけを差し替える
  internal.controlMessageTimeoutMs = controlMessageTimeoutMs;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  internal.controlReceiveStream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  internal.controlReader = new ControlStreamReader();
  internal.sessionState = "connected";
  return {
    sessionError,
    errorControl: (error) => {
      controller.error(error);
    },
    enqueue: (data) => {
      controller.enqueue(data);
    },
    start: () => internal.startControlMessageLoop(),
    setSessionState: (state) => {
      internal.sessionState = state;
    },
  };
}

/**
 * draft-ietf-moq-transport-21 §12.2:
 * CONTROL_MESSAGE_TIMEOUT (0x11) は「ピアが制御メッセージへの応答に時間を
 * かけすぎた」ことを示す。制御メッセージの Length が宣言されたまま本体が
 * 揃わない状態を保持し続けるピアを、期限で打ち切る。
 */
test("startControlMessageLoop: 半端な制御メッセージは CONTROL_MESSAGE_TIMEOUT で閉じる", async () => {
  const ctx = createControlLoopContext(20);
  ctx.start();
  // Type (0x40) + Length 宣言 5 + 本体 1 バイトのみの半端なメッセージ
  ctx.enqueue(new Uint8Array([0x40, 0x00, 0x05, 0xaa]));
  await new Promise((resolve) => {
    setTimeout(resolve, 80);
  });

  assert.isDefined(ctx.sessionError.current);
  assert.instanceOf(ctx.sessionError.current, SessionError);
  assert.equal(
    (ctx.sessionError.current as SessionError).code,
    SessionErrorCode.CONTROL_MESSAGE_TIMEOUT,
  );
  assert.isTrue(ctx.sessionError.current!.message.includes("control message timed out"));
});

/**
 * draft-ietf-moq-transport-21 §12.2:
 * 半端なメッセージが解消したら期限を解除する。後続で完結したメッセージは
 * 通常どおり処理され、タイムアウトで閉じない。
 */
test("startControlMessageLoop: 分割到着した制御メッセージはタイムアウトしない", async () => {
  const ctx = createControlLoopContext(60);
  ctx.start();
  // GOAWAY (0x10) + Length 宣言 2 + 本体を 1 バイトずつ分割して送る。
  // 本体は New Session URI Length 0 + Timeout 0 の正当な GOAWAY payload。
  ctx.enqueue(new Uint8Array([0x10, 0x00, 0x02]));
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  ctx.enqueue(new Uint8Array([0x00]));
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  ctx.enqueue(new Uint8Array([0x00]));
  await new Promise((resolve) => {
    setTimeout(resolve, 80);
  });

  // バッファが空になった時点で期限が解除されているため閉じない
  assert.isUndefined(ctx.sessionError.current);
});

/**
 * draft-ietf-moq-transport-21 §6.3:
 * 「A control stream MUST NOT be closed at the underlying transport layer
 *  during the session's lifetime.  Doing so results in the session being
 *  closed as a PROTOCOL_VIOLATION.」
 * 制御ストリームの RESET_STREAM でセッションが PROTOCOL_VIOLATION で閉じる。
 */
test("startControlMessageLoop: 制御ストリームの RESET_STREAM で PROTOCOL_VIOLATION でセッションが閉じる", async () => {
  const ctx = createControlLoopContext();
  ctx.start();
  ctx.errorControl(Object.assign(new Error("reset by peer"), { source: "stream" }));
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  assert.isDefined(ctx.sessionError.current);
  assert.equal(
    (ctx.sessionError.current as SessionError).code,
    SessionErrorCode.PROTOCOL_VIOLATION,
  );
});

/**
 * draft-ietf-moq-transport-21 §6.3:
 * 既に閉じたセッションで制御ストリームの read が reject しても誤って
 * callbacks.error を呼ばない。
 */
test("startControlMessageLoop: 既に閉じたセッションでは RESET_STREAM で callbacks.error を呼ばない", async () => {
  const ctx = createControlLoopContext();
  ctx.start();
  ctx.setSessionState("closed");
  ctx.errorControl(Object.assign(new Error("reset by peer"), { source: "stream" }));
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  assert.isUndefined(ctx.sessionError.current);
});

/**
 * draft-ietf-moq-transport-21 §6.3 / §6.6:
 * セッション終了起源 (source: "session") の read 失敗は PROTOCOL_VIOLATION に
 * 昇格せず、callbacks.error も呼ばない。
 */
test('startControlMessageLoop: source: "session" の read 失敗では昇格も通知も行わない', async () => {
  const ctx = createControlLoopContext();
  ctx.start();
  ctx.errorControl(Object.assign(new Error("transport closed"), { source: "session" }));
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  assert.isUndefined(ctx.sessionError.current);
});

/**
 * draft-ietf-moq-transport-21 §6.3:
 * アプリコールバック (callbacks.goaway 等) の throw ではセッションを閉じない。
 * 制御メッセージ処理は読み取りループの try 内にあるため throw は catch に
 * 到達するが、ピア起因ではないため PROTOCOL_VIOLATION に昇格させない。
 */
test("startControlMessageLoop: アプリコールバックの throw ではセッションを閉じない", async () => {
  const sessionError: { current: Error | undefined } = { current: undefined };
  const transport = {
    closed: new Promise<WebTransportCloseInfo>(() => {}),
  } as unknown as WebTransport;
  const session = new SessionImpl(transport, {
    goaway: () => {
      throw new Error("goaway callback failed");
    },
    error: (error) => {
      sessionError.current = error;
    },
  });
  const internal = session as unknown as {
    sessionState: SessionState;
    controlReceiveStream?: ReadableStream<Uint8Array>;
    controlReader?: ControlStreamReader;
    startControlMessageLoop(): void;
  };
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  internal.controlReceiveStream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  internal.controlReader = new ControlStreamReader();
  internal.sessionState = "connected";
  internal.startControlMessageLoop();

  // GOAWAY を流して goaway コールバックの throw を制御ループの catch に到達させる
  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "moqt://new.example.com",
    timeout: 0n,
  });
  controller.enqueue(new ControlStreamWriter().encode(MessageType.GOAWAY, goawayPayload));
  await yieldToMacrotask();

  // セッションは PROTOCOL_VIOLATION で閉じない (callbacks.error にはアプリ例外が渡る)
  assert.isDefined(sessionError.current);
  assert.equal(sessionError.current.message, "goaway callback failed");
  assert.notEqual((sessionError.current as SessionError).code, SessionErrorCode.PROTOCOL_VIOLATION);
});

/**
 * draft-ietf-moq-transport-21 §12.1:
 * FETCH 応答で同一 Group・同一 Subgroup の Publisher Priority 不一致を検出しても
 * セッションが閉じず、対象 FETCH がキャンセルされることを検証する。
 *
 * - 受信データストリームは STOP_SENDING 相当 (cancelStreamQuiet) で打ち切られる
 * - draft-ietf-moq-transport-21 §3.2.1 の MUST に従い、bidi リクエストストリームへ
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
 * draft-ietf-moq-transport-21 §12.1:
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

/**
 * draft-ietf-moq-transport-21 §3.6 / §12.1:
 * Mandatory Track Property (0x4000-0x7FFF) を含む Object Property を持つ FETCH
 * Object の受信は malformed Track の検出に当たる。decodeFetchObjectFields の
 * 単体テストは存在するが、session レベルの handleMalformedFetchTrack 経路
 * (fetcher の cancel・セッションは閉じない) を通す結合テストが無かった。
 */
test("FETCH データストリーム: Mandatory Track Property で FETCH を cancel しセッションを閉じない", async () => {
  const requestId = 1n;
  const ctx = createFetchPriorityMismatchContext(requestId);

  // 先頭 Object の Object Property に Mandatory Track Property を含める
  const properties = encodeProperties([{ id: 0x4000n, value: 0n }]);
  const parts = buildFetchStreamParts(requestId, properties);

  const handlePromise = ctx.run();
  ctx.enqueue(concatUint8Arrays([parts.headerBytes, parts.fieldsBytes, parts.payload]));
  await handlePromise;
  // cross-cancel は fire-and-forget のため到達を待つ
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  // セッションは閉じない
  assert.isUndefined(ctx.sessionError.current);
  // 受信データストリームは STOP_SENDING 相当で打ち切られる
  assert.isDefined(ctx.dataCancelledReason.current);
  assert.isTrue(ctx.dataCancelledReason.current!.includes("malformed track"));
  // draft-ietf-moq-transport-21 §3.2.1 の MUST に従い bidi リクエストストリームへ
  // STOP_SENDING が送られる
  assert.equal(ctx.bidiCancelledReason.current, "fetch cancelled");
  // fetchers / requestStreams から削除される
  assert.equal(ctx.internal.fetchers.size, 0);
  assert.equal(ctx.internal.requestStreams.size, 0);
  // error コールバックが MalformedTrackError で呼ばれる
  assert.instanceOf(ctx.receivedError.current, MalformedTrackError);
});

// ============================================================================
// データストリームの FIN 時の未完成 Object 検証 (§11.3)
// ============================================================================

/** createDataStreamFinContext が返す検証用コンテキスト */
interface DataStreamFinContext {
  session: SessionImpl;
  internal: {
    fetchers: Map<bigint, FetcherImpl>;
    subscribersByAlias: Map<bigint, SubscriberImpl[]>;
    // malformed 検出時の cross-cancel (STOP_SENDING 相当) を検証するテストが
    // 登録する。登録が無いテストでは空 Map のまま使われない。
    requestStreams: Map<bigint, RequestStreamEntry>;
    // draft-ietf-moq-transport-21 §10.8 / §10.9 の Track 単位追跡
    priorGapTrackingByTrack: Map<FullTrackNameKey, PriorGapTracking>;
    handleIncomingStream(stream: ReadableStream<Uint8Array>): Promise<void>;
  };
  sessionError: { current: Error | undefined };
  /** debug コールバックが受け取った記録 (fill 失敗通知などの検証用) */
  debugRecords: { typeName: string; decoded?: Record<string, unknown> }[];
  enqueue: (data: Uint8Array) => void;
  fin: () => void;
  /** peer 起点のストリーム reset (RESET_STREAM 相当) を再現する */
  reset: (error: Error) => void;
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
function createDataStreamFinContext(
  options: { dataStreamTimeoutMs?: number } = {},
): DataStreamFinContext {
  const sessionError: { current: Error | undefined } = { current: undefined };
  let resolveClosed!: (info: WebTransportCloseInfo) => void;
  const closedPromise = new Promise<WebTransportCloseInfo>((resolve) => {
    resolveClosed = resolve;
  });
  const transport = { closed: closedPromise } as unknown as WebTransport;
  const debugRecords: { typeName: string; decoded?: Record<string, unknown> }[] = [];
  const session = new SessionImpl(transport, {
    error: (error) => {
      sessionError.current = error;
    },
    debug: (message) => {
      debugRecords.push(message);
    },
  });
  const internal = session as unknown as {
    fetchers: Map<bigint, FetcherImpl>;
    subscribersByAlias: Map<bigint, SubscriberImpl[]>;
    requestStreams: Map<bigint, RequestStreamEntry>;
    // draft-ietf-moq-transport-21 §10.8 / §10.9 の Track 単位追跡
    priorGapTrackingByTrack: Map<FullTrackNameKey, PriorGapTracking>;
    dataStreamTimeoutMs: number;
    handleIncomingStream(stream: ReadableStream<Uint8Array>): Promise<void>;
  };
  // initialize() を経由せずタイムアウト値だけを差し替える
  if (options.dataStreamTimeoutMs !== undefined) {
    internal.dataStreamTimeoutMs = options.dataStreamTimeoutMs;
  }

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
    debugRecords,
    enqueue: (data: Uint8Array) => {
      controller.enqueue(data);
    },
    fin: () => {
      controller.close();
    },
    // ピアの RESET_STREAM は readable の read() を reject させる
    reset: (error: Error) => {
      controller.error(error);
    },
    // transport.closed ハンドラは close() を経ずに sessionState を closed へ
    // 遷移させ、request 系の state も閉じる (markRequestObjectsClosed)。
    // pending の reject 等の終了処理は行わない。ハンドラの .then は
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
function buildSubgroupStreamParts(properties?: Uint8Array): StreamParts {
  // Property を含める場合は Properties Present のヘッダタイプを使う
  const headerType =
    properties === undefined ? SubgroupHeaderType.BASE : SubgroupHeaderType.BASE_EXT;
  const headerBytes = encodeSubgroupHeader({
    type: headerType,
    trackAlias: 7n,
    groupId: 1n,
    publisherPriority: 128,
    firstObject: false,
  });
  const fieldsBytes = encodeObjectFields(0n, 10n, headerType, ObjectStatus.NORMAL, properties);
  const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  return { headerBytes, fieldsBytes, payload };
}

/**
 * Fetch データストリームの構成バイト列を構築する。Object は payload
 * 宣言長 10 バイトが 1 つ。切り分けの制御方法は Subgroup と同じ。
 */
function buildFetchStreamParts(requestId: bigint, properties?: Uint8Array): StreamParts {
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(properties !== undefined),
    groupId: 10n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    properties,
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
 * draft-ietf-moq-transport-21 §3.6 / §12.1:
 * Object Property に Mandatory Track Property (0x4000-0x7FFF) を含む subgroup
 * ストリームは malformed であり、当該購読を cancel してセッションは閉じないことを
 * 検証する。
 */
test("Subgroup データストリーム: Mandatory Track Property で購読を cancel しセッションを閉じない", async () => {
  const ctx = createDataStreamFinContext();
  let delivered = 0;
  let notified: Error | undefined;
  const subscriber = new SubscriberImpl(
    ["live"],
    "video",
    1n,
    7n,
    () => {
      delivered++;
    },
    undefined,
    undefined,
    (error) => {
      notified = error;
    },
  );
  ctx.internal.subscribersByAlias.set(7n, [subscriber]);

  // bidi リクエストストリームを登録し、cross-cancel が STOP_SENDING 相当
  // (readable.cancel) と RESET_STREAM 相当 (writer.abort) を送ることを観測する
  const bidiCancelReasons: unknown[] = [];
  const bidiAbortReasons: unknown[] = [];
  const bidiReadable = new ReadableStream<Uint8Array>({
    cancel(reason) {
      bidiCancelReasons.push(reason);
    },
  });
  const bidiWritable = new WritableStream<Uint8Array>({
    abort(reason) {
      bidiAbortReasons.push(reason);
    },
  });
  ctx.internal.requestStreams.set(1n, {
    stream: {
      readable: bidiReadable,
      writable: bidiWritable,
    } as unknown as WebTransportBidirectionalStream,
    writer: bidiWritable.getWriter(),
    controlReader: new ControlStreamReader(),
  });

  const headerBytes = encodeSubgroupHeader({
    type: SubgroupHeaderType.BASE_EXT,
    trackAlias: 7n,
    groupId: 1n,
    publisherPriority: 128,
    firstObject: false,
  });
  const properties = encodeProperties([{ id: 0x4000n, value: 0n }]);
  const fieldsBytes = encodeObjectFields(
    0n,
    10n,
    SubgroupHeaderType.BASE_EXT,
    ObjectStatus.NORMAL,
    properties,
  );
  const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  const handlePromise = ctx.run();
  ctx.enqueue(concatUint8Arrays([headerBytes, fieldsBytes, payload]));
  ctx.fin();
  await handlePromise;

  // 配送されず、error が通知され、セッションは閉じない
  assert.equal(delivered, 0);
  assert.isDefined(notified);
  assert.isUndefined(ctx.sessionError.current);
  // alias から購読が外れる
  assert.equal((ctx.internal.subscribersByAlias.get(7n) ?? []).length, 0);
  // 購読は closed になる
  assert.equal(subscriber.state, "closed");
  // bidi リクエストストリームの両方向が cancel される
  // (draft-ietf-moq-transport-21 §12.1 の MUST cancel / §3.1 の STOP_SENDING 相当)
  assert.deepEqual(bidiCancelReasons, ["subscription cancelled"]);
  assert.deepEqual(bidiAbortReasons, ["subscription cancelled"]);
  assert.isFalse(ctx.internal.requestStreams.has(1n));
});

// ============================================================================
// Track 横断の Prior ID Gap 追跡 (§10.8 / §10.9)
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §10.9 / §12.1:
 * 同一 Group の受信済み Object を Prior Object ID Gap が覆う場合、malformed track
 * として同一 Track の購読と FETCH を cancel する。セッションは閉じない。
 * 追跡は Track 単位であり、購読も FETCH も尽きた時点で破棄される。
 */
test("Subgroup データストリーム: Prior Object ID Gap が受信済み Object を覆うと購読と FETCH を cancel する", async () => {
  const ctx = createDataStreamFinContext();
  let delivered = 0;
  let notified: Error | undefined;
  const subscriber = new SubscriberImpl(
    ["live"],
    "video",
    1n,
    7n,
    () => {
      delivered++;
    },
    undefined,
    undefined,
    (error) => {
      notified = error;
    },
  );
  ctx.internal.subscribersByAlias.set(7n, [subscriber]);

  // 同一 Track の FETCH も §12.1 の cancel 対象である
  const fetcherError: { current: Error | undefined } = { current: undefined };
  const fetcher = new FetcherImpl(
    ["live"],
    "video",
    3n,
    () => {},
    undefined,
    (error) => {
      fetcherError.current = error;
    },
  );
  // fetch() 実装と同じ挙動になるよう onCancel を bidiCancelFetch に配線する
  fetcher.onCancel = async () => {
    await bidiCancelFetch(ctx.internal as unknown as BidiSessionInternal, fetcher);
  };
  ctx.internal.fetchers.set(3n, fetcher);

  // bidi リクエストストリームを登録し、cross-cancel が STOP_SENDING 相当
  // (readable.cancel) と RESET_STREAM 相当 (writer.abort) を送ることを観測する
  const bidiCancelReasons: unknown[] = [];
  const bidiAbortReasons: unknown[] = [];
  const bidiReadable = new ReadableStream<Uint8Array>({
    cancel(reason) {
      bidiCancelReasons.push(reason);
    },
  });
  const bidiWritable = new WritableStream<Uint8Array>({
    abort(reason) {
      bidiAbortReasons.push(reason);
    },
  });
  ctx.internal.requestStreams.set(1n, {
    stream: {
      readable: bidiReadable,
      writable: bidiWritable,
    } as unknown as WebTransportBidirectionalStream,
    writer: bidiWritable.getWriter(),
    controlReader: new ControlStreamReader(),
  });

  // 同一 Group 3 の Object 8 (Gap 無し) の後に、Object 8 と 9 の不在を通知する
  // Object 10 (Prior Object ID Gap = 2) を流す
  const headerBytes = encodeSubgroupHeader({
    type: SubgroupHeaderType.BASE_EXT,
    trackAlias: 7n,
    groupId: 3n,
    publisherPriority: 128,
    firstObject: false,
  });
  const firstFields = encodeObjectFields(8n, 1n, SubgroupHeaderType.BASE_EXT);
  const secondFields = encodeObjectFields(
    1n,
    1n,
    SubgroupHeaderType.BASE_EXT,
    ObjectStatus.NORMAL,
    priorObjectIdGapProperties(2n),
  );

  const handlePromise = ctx.run();
  ctx.enqueue(
    concatUint8Arrays([
      headerBytes,
      firstFields,
      new Uint8Array([1]),
      secondFields,
      new Uint8Array([2]),
    ]),
  );
  ctx.fin();
  await handlePromise;
  // bidi ストリームの cancel 完了 (bidiCancelFetch の後始末) を待つ
  await yieldToMacrotask();

  // malformed の Object は配送されず、error が通知され、セッションは閉じない
  assert.equal(delivered, 1);
  assert.instanceOf(notified, MalformedTrackError);
  assert.isUndefined(ctx.sessionError.current);
  // 購読は cancel され alias から外れる
  assert.equal(subscriber.state, "closed");
  assert.equal((ctx.internal.subscribersByAlias.get(7n) ?? []).length, 0);
  assert.deepEqual(bidiCancelReasons, ["subscription cancelled"]);
  assert.deepEqual(bidiAbortReasons, ["subscription cancelled"]);
  // 同一 Track の FETCH も cancel される
  assert.instanceOf(fetcherError.current, MalformedTrackError);
  assert.equal(fetcher.state, "closed");
  assert.equal(ctx.internal.fetchers.size, 0);
  // 購読も FETCH も尽きたため Track の追跡状態は破棄される
  assert.equal(ctx.internal.priorGapTrackingByTrack.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §10.8 / §12.1:
 * FETCH データストリームでも Track 横断の Prior ID Gap 条件を検出し、同一 Track の
 * 購読と FETCH を cancel する。セッションは閉じない。
 */
test("Fetch データストリーム: Prior Group ID Gap が受信済み Group を覆うと購読と FETCH を cancel する", async () => {
  const ctx = createDataStreamFinContext();
  const requestId = 3n;
  let delivered = 0;
  let notified: Error | undefined;
  const subscriber = new SubscriberImpl(
    ["live"],
    "video",
    1n,
    7n,
    () => {
      delivered++;
    },
    undefined,
    undefined,
    (error) => {
      notified = error;
    },
  );
  ctx.internal.subscribersByAlias.set(7n, [subscriber]);

  const fetcherError: { current: Error | undefined } = { current: undefined };
  const fetcher = new FetcherImpl(
    ["live"],
    "video",
    requestId,
    () => {
      delivered++;
    },
    undefined,
    (error) => {
      fetcherError.current = error;
    },
  );
  fetcher.onCancel = async () => {
    await bidiCancelFetch(ctx.internal as unknown as BidiSessionInternal, fetcher);
  };
  ctx.internal.fetchers.set(requestId, fetcher);

  // 先頭 Object は Group 9、2 件目は Group 10 (Prior Group ID Gap = 1 で
  // Group 9 の不在を通知する) を流す。Group 9 は受信済みであり矛盾する
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(),
    groupId: 9n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 1n,
  };
  const firstEncoded = encodeFetchObjectFields(first);
  // コンテキスト (差分計算用) を先頭オブジェクトのデコード結果から求める
  const [, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);
  const second: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_SAME |
      FetchSerializationFlags.GROUP_ID_PRESENT |
      FetchSerializationFlags.OBJECT_ID_PRESENT |
      FetchSerializationFlags.PROPERTIES_PRESENT,
    groupId: 10n,
    objectId: 0n,
    properties: priorGroupIdGapProperties(1n),
    payloadLength: 1n,
  };
  const secondEncoded = encodeFetchObjectFields(second, false, firstContext);

  const handlePromise = ctx.run();
  ctx.enqueue(
    concatUint8Arrays([
      encodeFetchHeader({ type: FetchHeaderType, requestId }),
      firstEncoded,
      new Uint8Array([1]),
      secondEncoded,
      new Uint8Array([2]),
    ]),
  );
  ctx.fin();
  await handlePromise;
  await yieldToMacrotask();

  // 1 件目だけが配送され、error が通知され、セッションは閉じない
  assert.equal(delivered, 1);
  assert.instanceOf(notified, MalformedTrackError);
  assert.isUndefined(ctx.sessionError.current);
  assert.equal(subscriber.state, "closed");
  assert.instanceOf(fetcherError.current, MalformedTrackError);
  assert.equal(fetcher.state, "closed");
  assert.equal(ctx.internal.fetchers.size, 0);
  assert.equal(ctx.internal.priorGapTrackingByTrack.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §10.8 / §12.1:
 * fill fetch ストリームでも Track 横断の Prior ID Gap 条件を検出し、同一 Track の
 * 購読を cancel する。セッションは閉じない。
 */
test("fill fetch ストリーム: Prior Group ID Gap が受信済み Group を覆うと購読を cancel しセッションを閉じない", async () => {
  const { ctx, internals } = createFillFetchStreamContext();
  const requestId = 2n;
  let delivered = 0;
  let notified: Error | undefined;
  const subscriber = new SubscriberImpl(
    ["live"],
    "video",
    requestId,
    7n,
    () => {
      delivered++;
    },
    undefined,
    undefined,
    (error) => {
      notified = error;
    },
  );
  internals.subscribers.set(requestId, subscriber);
  internals.subscribersByAlias.set(7n, [subscriber]);
  internals.fillFetchTargets.set(requestId, {
    subscriber,
    groupOrder: GroupOrder.ASCENDING,
  });

  // 先頭 Object は Group 9、2 件目は Group 10 (Prior Group ID Gap = 1 で
  // Group 9 の不在を通知する) を流す
  const first: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(),
    groupId: 9n,
    subgroupId: 1n,
    objectId: 0n,
    publisherPriority: 100,
    payloadLength: 1n,
  };
  const firstEncoded = encodeFetchObjectFields(first);
  const [, , firstContext] = decodeFetchObjectFields(firstEncoded, null, 0, true);
  const second: FetchObjectFields = {
    serializationFlags:
      FetchSerializationFlags.SUBGROUP_SAME |
      FetchSerializationFlags.GROUP_ID_PRESENT |
      FetchSerializationFlags.OBJECT_ID_PRESENT |
      FetchSerializationFlags.PROPERTIES_PRESENT,
    groupId: 10n,
    objectId: 0n,
    properties: priorGroupIdGapProperties(1n),
    payloadLength: 1n,
  };
  const secondEncoded = encodeFetchObjectFields(second, false, firstContext);

  const handlePromise = ctx.run();
  ctx.enqueue(
    concatUint8Arrays([
      encodeFetchHeader({ type: FetchHeaderType, requestId }),
      firstEncoded,
      new Uint8Array([1]),
      secondEncoded,
      new Uint8Array([2]),
    ]),
  );
  ctx.fin();
  await handlePromise;

  // 1 件目だけが配送され、error が通知され、セッションは閉じない
  assert.equal(delivered, 1);
  assert.instanceOf(notified, MalformedTrackError);
  assert.isUndefined(ctx.sessionError.current);
  assert.equal(ctx.session.state, "connected");
  // 購読は cancel され fill の関連付けも消える
  assert.equal(subscriber.state, "closed");
  assert.equal((internals.subscribersByAlias.get(7n) ?? []).length, 0);
  assert.equal(internals.fillFetchTargets.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §10.8 / §10.9:
 * 追跡状態を破棄できるのは、その Track の購読と FETCH が 1 つも残っていない時点
 * だけである。FETCH は Track Alias を持たないため、購読の消滅だけでは Track の
 * 生存を判定できない。
 */
test("Prior ID Gap 追跡: 同一 Track の FETCH が残っている間は購読の終了で破棄しない", async () => {
  const ctx = createDataStreamFinContext();
  const subscriber = new SubscriberImpl(["live"], "video", 1n, 7n, () => {});
  ctx.internal.subscribersByAlias.set(7n, [subscriber]);

  // 実ストリームで Object 1 件を受信し、Track の追跡状態を作る
  const parts = buildSubgroupStreamParts();
  const handlePromise = ctx.run();
  ctx.enqueue(concatUint8Arrays([parts.headerBytes, parts.fieldsBytes, parts.payload]));
  ctx.fin();
  await handlePromise;

  const trackKey = subscriber.getFullTrackNameKey();
  assert.isTrue(ctx.internal.priorGapTrackingByTrack.has(trackKey));

  // 同一 Track の FETCH を登録してから購読を終了する
  const fetcher = new FetcherImpl(["live"], "video", 3n, () => {});
  ctx.internal.fetchers.set(3n, fetcher);
  await bidiCancelSubscription(ctx.session as unknown as BidiSessionInternal, subscriber);
  // FETCH が残っているため破棄しない
  assert.isTrue(ctx.internal.priorGapTrackingByTrack.has(trackKey));

  // FETCH を終了すると購読も FETCH も尽きるため破棄される
  await bidiCancelFetch(ctx.session as unknown as BidiSessionInternal, fetcher);
  assert.isFalse(ctx.internal.priorGapTrackingByTrack.has(trackKey));
});

/**
 * draft-ietf-moq-transport-21 §8.3:
 * "If a receiver understands a Type, and the following Value or Length/Value
 *  does not match the serialization defined by that Type, the receiver MUST
 *  close the session with error code KEY_VALUE_FORMATTING_ERROR."
 * Subgroup データストリームの Object Properties でも既知 Type の Length 宣言超過は
 * エラーコードを保持してセッションを閉じる。
 */
test("Subgroup データストリーム: 既知 Type の Length 宣言超過で KEY_VALUE_FORMATTING_ERROR", async () => {
  const ctx = createDataStreamFinContext();
  let delivered = 0;
  const subscriber = new SubscriberImpl(["live"], "video", 1n, 7n, () => {
    delivered++;
  });
  ctx.internal.subscribersByAlias.set(7n, [subscriber]);

  const parts = buildSubgroupStreamParts(new Uint8Array([0x0b, 0x05, 0xaa, 0xbb]));
  const handlePromise = ctx.run();
  ctx.enqueue(concatUint8Arrays([parts.headerBytes, parts.fieldsBytes, parts.payload]));
  ctx.fin();
  await handlePromise;

  assert.instanceOf(ctx.sessionError.current, SessionError);
  assert.equal(ctx.sessionError.current.code, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
  assert.equal(delivered, 0);
});

/**
 * draft-ietf-moq-transport-21 §11.3 (Streams):
 * "If a stream ends gracefully (i.e., the stream terminates with a FIN) in
 *  the middle of a serialized Object, the session SHOULD be closed with a
 *  PROTOCOL_VIOLATION."
 *
 * Subgroup データストリームが未完成 Object の途中でピア FIN された場合、
 * 黙殺せず PROTOCOL_VIOLATION でセッションを閉じることを検証する。
 * 宣言 payloadLength (10) が実際の到達バイト数 (4) より大きい場合、
 * processSubgroupObjects は Object 途中のバイト列を remainingBuffer と
 * して返す (IncompleteDataError ではなく totalNeeded > buffer.length の
 * break 経由)。未達 Object があるままの FIN は §11.3.2 の reset MUST に
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
 * draft-ietf-moq-transport-21 §6.6 (Termination):
 * closeWithError() はアプリ登録の error コールバックが throw しても
 * close() を必ず実行し、セッションを閉じることを検証する。
 * Subgroup 未完成 FIN の PROTOCOL_VIOLATION 経路で駆動する。
 */
test("closeWithError: error コールバックが throw してもセッションが閉じる", async () => {
  const notified: Error[] = [];
  const debugRecords: { typeName: string; decoded?: Record<string, unknown> }[] = [];
  const transportCloseCalls: unknown[] = [];
  const transport = {
    closed: new Promise<WebTransportCloseInfo>(() => {}),
    close: (info?: WebTransportCloseInfo) => {
      transportCloseCalls.push(info);
    },
  } as unknown as WebTransport;
  const session = new SessionImpl(transport, {
    error: (error) => {
      notified.push(error);
      throw new Error("callback boom");
    },
    debug: (message) => {
      debugRecords.push(message);
    },
  });
  const internal = session as unknown as {
    subscribers: Map<bigint, SubscriberImpl>;
    subscribersByAlias: Map<bigint, SubscriberImpl[]>;
    pendingPublish: Map<bigint, { resolve: () => void; reject: (error: Error) => void }>;
    handleIncomingStream(stream: ReadableStream<Uint8Array>): Promise<void>;
  };
  let delivered = 0;
  const subscriber = new SubscriberImpl(["live"], "video", 1n, 7n, () => {
    delivered++;
  });
  internal.subscribers.set(1n, subscriber);
  internal.subscribersByAlias.set(7n, [subscriber]);
  let rejected: Error | undefined;
  internal.pendingPublish.set(0n, {
    resolve: () => {},
    reject: (error) => {
      rejected = error;
    },
  });

  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const parts = buildSubgroupStreamParts();
  const handlePromise = internal.handleIncomingStream(stream);
  controller.enqueue(
    concatUint8Arrays([parts.headerBytes, parts.fieldsBytes, parts.payload.slice(0, 4)]),
  );
  controller.close();
  await handlePromise;

  // 通知コールバックの throw に関わらずセッションが閉じる
  assert.equal(session.state, "closed");
  // 本来の違反コードが通知される (INTERNAL_ERROR 化しない)
  assert.equal(notified.length, 1);
  assert.instanceOf(notified[0], SessionError);
  assert.equal((notified[0] as SessionError).code, SessionErrorCode.PROTOCOL_VIOLATION);
  // close() の終了処理が実行される
  assert.equal(transportCloseCalls.length, 1);
  // 本来の違反コードで閉じる (INTERNAL_ERROR 化しない)
  assert.equal(
    (transportCloseCalls[0] as { closeCode?: unknown } | undefined)?.closeCode,
    SessionErrorCode.PROTOCOL_VIOLATION,
  );
  assert.isDefined(rejected);
  assert.equal(subscriber.state, "closed");
  // 未完成 Object は配信されない
  assert.equal(delivered, 0);
  // throw の事実はデバッグ記録に残る
  const dataStreamErrors = debugRecords.filter((record) => record.typeName === "DATA_STREAM_ERROR");
  assert.equal(dataStreamErrors.length, 1);
  assert.isTrue(String(dataStreamErrors[0].decoded?.error).includes("callback boom"));
});

/**
 * draft-ietf-moq-transport-21 §6.6 (Termination):
 * error コールバックと debug コールバックの両方が throw しても、close() は
 * 実行され、例外は呼び出し元へ伝播しないことを検証する。
 */
test("closeWithError: error と debug の両方が throw しても閉じて伝播しない", async () => {
  const transportCloseCalls: unknown[] = [];
  const transport = {
    closed: new Promise<WebTransportCloseInfo>(() => {}),
    close: (info?: WebTransportCloseInfo) => {
      transportCloseCalls.push(info);
    },
  } as unknown as WebTransport;
  const session = new SessionImpl(transport, {
    error: () => {
      throw new Error("callback boom");
    },
    debug: () => {
      throw new Error("debug boom");
    },
  });
  const internal = session as unknown as {
    subscribersByAlias: Map<bigint, SubscriberImpl[]>;
    handleIncomingStream(stream: ReadableStream<Uint8Array>): Promise<void>;
  };
  const subscriber = new SubscriberImpl(["live"], "video", 1n, 7n, () => {});
  internal.subscribersByAlias.set(7n, [subscriber]);

  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const parts = buildSubgroupStreamParts();
  const handlePromise = internal.handleIncomingStream(stream);
  controller.enqueue(
    concatUint8Arrays([parts.headerBytes, parts.fieldsBytes, parts.payload.slice(0, 4)]),
  );
  controller.close();
  // 例外が伝播せず解決する
  await handlePromise;

  assert.equal(session.state, "closed");
  assert.equal(transportCloseCalls.length, 1);
});

/**
 * draft-ietf-moq-transport-21 §6.6 (Termination):
 * 正常系 (コールバックが throw しない) では先に callbacks.error、
 * 後に close の順で実行されることを検証する (回帰ガード)。
 */
test("closeWithError: 正常時は error 通知の後に close が実行される", async () => {
  const order: string[] = [];
  const transport = {
    closed: new Promise<WebTransportCloseInfo>(() => {}),
    close: () => {
      order.push("transport-close");
    },
  } as unknown as WebTransport;
  const session = new SessionImpl(transport, {
    error: () => {
      order.push("error");
    },
  });
  const internal = session as unknown as {
    subscribersByAlias: Map<bigint, SubscriberImpl[]>;
    handleIncomingStream(stream: ReadableStream<Uint8Array>): Promise<void>;
  };
  const subscriber = new SubscriberImpl(["live"], "video", 1n, 7n, () => {});
  internal.subscribersByAlias.set(7n, [subscriber]);

  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const parts = buildSubgroupStreamParts();
  const handlePromise = internal.handleIncomingStream(stream);
  controller.enqueue(
    concatUint8Arrays([parts.headerBytes, parts.fieldsBytes, parts.payload.slice(0, 4)]),
  );
  controller.close();
  await handlePromise;

  assert.deepEqual(order, ["error", "transport-close"]);
  assert.equal(session.state, "closed");
});

// ============================================================================
// ピア起点のセッション終了時の request 系オブジェクトの state 遷移
// ============================================================================

/**
 * ピア起点のセッション終了 (transport.closed) で state を閉じるための
 * セッションを構築する。closed Promise は呼び出し側で resolve / reject できる。
 */
function createPeerCloseSession(): {
  session: SessionImpl;
  closeCalls: WebTransportCloseInfo[];
  resolveClosed: (info: WebTransportCloseInfo) => void;
  rejectClosed: (reason?: unknown) => void;
} {
  const closeCalls: WebTransportCloseInfo[] = [];
  let resolveClosed!: (info: WebTransportCloseInfo) => void;
  let rejectClosed!: (reason?: unknown) => void;
  const closedPromise = new Promise<WebTransportCloseInfo>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  const transport = {
    closed: closedPromise,
  } as unknown as WebTransport;
  const session = new SessionImpl(transport, {
    close: (info) => {
      closeCalls.push(info);
    },
  });
  return { session, closeCalls, resolveClosed, rejectClosed };
}

/**
 * draft-ietf-moq-transport-21 §6.6 (Termination):
 * ピア起点で transport.closed が resolve した場合、登録済みの Publisher /
 * Subscriber / Fetcher の state が closed になることを検証する。
 * Namespace 系の state も closed になる。ConnectCallbacks.close は 1 回だけ
 * 呼ばれ、request 系の handleEnd / handleError は呼ばない。
 */
test("ピア起点の終了で Publisher / Subscriber / Fetcher の state が closed になる", async () => {
  const { session, closeCalls, resolveClosed } = createPeerCloseSession();
  const internal = session as unknown as {
    publishers: Map<bigint, PublisherImpl>;
    subscribers: Map<bigint, SubscriberImpl>;
    fetchers: Map<bigint, FetcherImpl>;
    namespaceSubscriptions: Map<bigint, { state: "active" | "closed" }>;
    tracksSubscriptions: Map<bigint, { state: "active" | "closed" }>;
    namespacePublications: Map<bigint, { state: "active" | "closed" }>;
  };
  const publisher = new PublisherImpl(["live"], "video", 0n, 1n);
  internal.publishers.set(0n, publisher);
  let notifiedError: Error | undefined;
  let ended = false;
  const subscriber = new SubscriberImpl(
    ["live"],
    "video",
    2n,
    3n,
    () => {},
    undefined,
    () => {
      ended = true;
    },
    (error) => {
      notifiedError = error;
    },
  );
  internal.subscribers.set(2n, subscriber);
  const fetcher = new FetcherImpl(
    ["live"],
    "video",
    4n,
    () => {},
    () => {},
    () => {},
  );
  internal.fetchers.set(4n, fetcher);
  internal.namespaceSubscriptions.set(5n, { state: "active" });
  internal.tracksSubscriptions.set(6n, { state: "active" });
  internal.namespacePublications.set(7n, { state: "active" });

  resolveClosed({ closeCode: 0, reason: "" });
  await Promise.resolve();

  assert.equal(session.state, "closed");
  assert.equal(publisher.state, "closed");
  assert.equal(subscriber.state, "closed");
  assert.equal(fetcher.state, "closed");
  assert.equal(internal.namespaceSubscriptions.get(5n)?.state, "closed");
  assert.equal(internal.tracksSubscriptions.get(6n)?.state, "closed");
  assert.equal(internal.namespacePublications.get(7n)?.state, "closed");
  // 通知は 1 回だけで、request 系の end / error は呼ばない
  assert.equal(closeCalls.length, 1);
  assert.isFalse(ended);
  assert.isUndefined(notifiedError);
});

/**
 * draft-ietf-moq-transport-21 §13 (Grease):
 * 未知の Session Termination コードは INTERNAL_ERROR として通知する。
 */
test("ピア起点の終了で未知の closeCode は INTERNAL_ERROR に正規化される", async () => {
  const { session, closeCalls, resolveClosed } = createPeerCloseSession();

  resolveClosed({ closeCode: 0x99, reason: "grease" });
  await Promise.resolve();

  assert.equal(session.state, "closed");
  assert.equal(closeCalls.length, 1);
  assert.equal(closeCalls[0].closeCode, SessionErrorCode.INTERNAL_ERROR);
});

/**
 * draft-ietf-moq-transport-21 §6.6 (Termination):
 * transport.closed が reject した場合も同様に state が閉じることを検証する。
 */
test("ピア起点の終了 (reject) でも request 系の state が closed になる", async () => {
  const { session, closeCalls, rejectClosed } = createPeerCloseSession();
  const internal = session as unknown as {
    subscribers: Map<bigint, SubscriberImpl>;
  };
  const subscriber = new SubscriberImpl(["live"], "video", 2n, 3n, () => {});
  internal.subscribers.set(2n, subscriber);

  rejectClosed(new Error("transport error"));
  // reject 経路は then 素通し + catch の 2 ホップでハンドラに届くため 2 tick 待つ
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(session.state, "closed");
  assert.equal(subscriber.state, "closed");
  assert.equal(closeCalls.length, 1);
});

/**
 * draft-ietf-moq-transport-21 §6.6 (Termination):
 * ピア起点の終了後は Subscriber.update() が "Subscriber is closed" で
 * reject すること (state ガードが効くこと) を検証する。
 */
test("ピア起点の終了後は Subscriber.update() が reject する", async () => {
  const { session, resolveClosed } = createPeerCloseSession();
  const internal = session as unknown as {
    subscribers: Map<bigint, SubscriberImpl>;
  };
  const subscriber = new SubscriberImpl(["live"], "video", 2n, 3n, () => {});
  internal.subscribers.set(2n, subscriber);

  resolveClosed({ closeCode: 0, reason: "" });
  await Promise.resolve();

  let thrown: Error | undefined;
  try {
    await subscriber.update({ forward: false });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }
  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("Subscriber is closed"));
});

/**
 * 回帰ガード: 自前起点の close() でも request 系の state が閉じることは
 * 従来どおりである (抽出前後で挙動が変わらないこと)。
 */
test("自前起点の close() でも request 系の state が閉じる", async () => {
  const { session } = createPeerCloseSession();
  const internal = session as unknown as {
    publishers: Map<bigint, PublisherImpl>;
    subscribers: Map<bigint, SubscriberImpl>;
    fetchers: Map<bigint, FetcherImpl>;
  };
  const publisher = new PublisherImpl(["live"], "video", 0n, 1n);
  internal.publishers.set(0n, publisher);
  const subscriber = new SubscriberImpl(["live"], "video", 2n, 3n, () => {});
  internal.subscribers.set(2n, subscriber);
  const fetcher = new FetcherImpl(
    ["live"],
    "video",
    4n,
    () => {},
    () => {},
    () => {},
  );
  internal.fetchers.set(4n, fetcher);

  await session.close();

  assert.equal(session.state, "closed");
  assert.equal(publisher.state, "closed");
  assert.equal(subscriber.state, "closed");
  assert.equal(fetcher.state, "closed");
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
 * draft-ietf-moq-transport-21 §11.3.2 (Closing Subgroup Streams):
 * "If a sender has delivered all objects in a Subgroup ... it MUST close
 *  the stream with a FIN."
 * Object 0 個 (empty Subgroup) を含む全ストリームが対象であり、
 * ヘッダーのみ FIN は未完成 Object を含まないため §11.3 の判定は
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
 * draft-ietf-moq-transport-21 §11.3.1 / §11.3.2:
 * pending mode (subscribers 未登録) でヘッダーのみの Subgroup ストリームが
 * FIN すると、その場で abandon して handleIncomingStream が解決する。
 * FIN 済み read() は以後も即解決の done を返すため、race を再登録すると
 * chunk 分岐が常に勝って無限ループになる (解決しない場合は 5 秒の
 * タイムアウトで失敗させる)。
 */
test("Subgroup pending mode: ヘッダーのみの FIN で abandon しハングしない", async () => {
  const ctx = createDataStreamFinContext();
  const internals = ctx.session as unknown as { pendingSubgroupBuffer: { streamCount: number } };

  const parts = buildSubgroupStreamParts();
  const handlePromise = ctx.run();
  ctx.enqueue(parts.headerBytes);
  ctx.fin();
  // 解決しない場合はタイムアウトで失敗させる (成功時は即解決する)
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error("handleIncomingStream がタイムアウトしました"));
    }, 5000);
  });
  try {
    await Promise.race([handlePromise, timeout]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }

  // pending entry は削除され、セッションは閉じない
  assert.equal(internals.pendingSubgroupBuffer.streamCount, 0);
  assert.isUndefined(ctx.sessionError.current);
  assert.equal(ctx.session.state, "connected");
});

/**
 * draft-ietf-moq-transport-21 §11.3.1 / §11.3.2:
 * pending mode でヘッダー + 完全 Object 1 件 + FIN の場合も end-of-stream で
 * abandon し、pending entry が残らずハングしないことを検証する。
 * (pending mode は payload を decode しないため残バッファ判定は行わない)
 */
test("Subgroup pending mode: 完全 Object 付き FIN で abandon しハングしない", async () => {
  const ctx = createDataStreamFinContext();
  const internals = ctx.session as unknown as { pendingSubgroupBuffer: { streamCount: number } };

  const parts = buildSubgroupStreamParts();
  const handlePromise = ctx.run();
  ctx.enqueue(concatUint8Arrays([parts.headerBytes, parts.fieldsBytes, parts.payload]));
  ctx.fin();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error("handleIncomingStream がタイムアウトしました"));
    }, 5000);
  });
  try {
    await Promise.race([handlePromise, timeout]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }

  assert.equal(internals.pendingSubgroupBuffer.streamCount, 0);
  assert.isUndefined(ctx.sessionError.current);
  assert.equal(ctx.session.state, "connected");
});

/**
 * draft-ietf-moq-transport-21 §11.3.1:
 * pending mode は payload を decode しないため、未完成 Object の途中での FIN
 * でも §11.3 の SHOULD 判定 (PROTOCOL_VIOLATION) を行わず abandon する。
 * subscriber mode の未完成 FIN 検出とは意図的な非対称である。
 */
test("Subgroup pending mode: 未完成 Object の途中の FIN でも閉じず abandon する", async () => {
  const ctx = createDataStreamFinContext();
  const internals = ctx.session as unknown as { pendingSubgroupBuffer: { streamCount: number } };

  const parts = buildSubgroupStreamParts();
  const handlePromise = ctx.run();
  ctx.enqueue(concatUint8Arrays([parts.headerBytes, parts.fieldsBytes, parts.payload.slice(0, 4)]));
  ctx.fin();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error("handleIncomingStream がタイムアウトしました"));
    }, 5000);
  });
  try {
    await Promise.race([handlePromise, timeout]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }

  assert.equal(internals.pendingSubgroupBuffer.streamCount, 0);
  assert.isUndefined(ctx.sessionError.current);
  assert.equal(ctx.session.state, "connected");
});

/**
 * draft-ietf-moq-transport-21 §11.3.1:
 * pending 中に subscriber が登録された場合は pending chunks を結合して
 * subscriber mode へ合流し、後続 Object が配信されることを検証する。
 * 本テストは逐次登録の合流を検証する。同時解決時の合流優先は
 * handleSubgroupStream の done 分岐による (chunk done 勝ちでも再取得する)。
 */
test("Subgroup pending mode: 待機中に subscriber 登録で合流し Object が配信される", async () => {
  const ctx = createDataStreamFinContext();
  let delivered = 0;
  const subscriber = new SubscriberImpl(["live"], "video", 1n, 7n, () => {
    delivered++;
  });
  const internals = ctx.session as unknown as {
    pendingSubgroupBuffer: {
      streamCount: number;
      notifyAlias: (trackAlias: bigint, reason: "subscriber") => void;
    };
  };

  const parts = buildSubgroupStreamParts();
  const handlePromise = ctx.run();
  ctx.enqueue(parts.headerBytes);
  await yieldToMacrotask();
  // pending 到達を確認する (到達前の notifyAlias は no-op になるため)
  assert.equal(internals.pendingSubgroupBuffer.streamCount, 1);
  // pending 中に subscriber を登録して通知する (SUBSCRIBE_OK 到着の再現)
  ctx.internal.subscribersByAlias.set(7n, [subscriber]);
  internals.pendingSubgroupBuffer.notifyAlias(7n, "subscriber");
  // 残りの Object と FIN を流す
  ctx.enqueue(concatUint8Arrays([parts.fieldsBytes, parts.payload]));
  ctx.fin();
  await handlePromise;

  // 合流して Object 1 件が配信され、entry は削除される
  assert.equal(delivered, 1);
  assert.equal(internals.pendingSubgroupBuffer.streamCount, 0);
  assert.isUndefined(ctx.sessionError.current);
  assert.equal(ctx.session.state, "connected");
});

/**
 * Subgroup ヘッダーが途中で切れた FIN (done) は Object が開始する前であり、
 * handleIncomingStream のヘッダーパース部で黙殺される (§11.3 の判定対象外)。
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
 * draft-ietf-moq-transport-21 §11.3 (Streams):
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
 * draft-ietf-moq-transport-21 §9.11 (FETCH):
 * Object 0 件の FETCH 応答は FETCH_HEADER + FIN が正当な形
 * ("If no Objects exist in the requested range, the publisher opens the
 *  unidirectional stream, sends the FETCH_HEADER (see Section 11.4.1)
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
// draft-ietf-moq-transport-21 §3.4 (Fill Semantics)
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
    subscribersByAlias: Map<bigint, SubscriberImpl[]>;
    fillFetchTargets: Map<bigint, { subscriber: SubscriberImpl; groupOrder: GroupOrder }>;
  };
} {
  const ctx = createDataStreamFinContext();
  const internals = ctx.internal as unknown as {
    subscribers: Map<bigint, SubscriberImpl>;
    subscribersByAlias: Map<bigint, SubscriberImpl[]>;
    fillFetchTargets: Map<bigint, { subscriber: SubscriberImpl; groupOrder: GroupOrder }>;
  };
  return { ctx, internals };
}

/**
 * draft-ietf-moq-transport-21 §3.4:
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
  // subscription では落とされる Location ({11, 0} 以降が通過し {10, 0} は不通過。
  // fill 経由は再適用を通さないため届く)
  subscriber.setLocationFilter({ startGroup: 0n });
  subscriber.setLargestLocation({ group: 10n, object: 0n });
  subscriber.resolveLocationFilter();

  // subscription 経由では Location Filter 再適用で {10, 0} が落ちる
  subscriber.handleObject({
    groupId: 10n,
    objectId: 0n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array(),
  });
  assert.equal(received.length, 0);

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
  // fill 配線 (handleFillObject 経由) の回帰ガード
  assert.isTrue(received[0].fillDelivered);
  assert.equal(internals.fillFetchTargets.size, 0);
  // 購読自体は継続する
  assert.equal(subscriber.state, "active");
});

/**
 * draft-ietf-moq-transport-21 §3.4:
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
  // fill 配線 (handleFillObject 経由) の回帰ガード
  assert.isTrue(received[0].fillDelivered);
  assert.isTrue(internals.fillFetchTargets.size === 0);
  assert.equal(subscriber.state, "active");
});

/**
 * draft-ietf-moq-transport-21 §11.3 (Streams):
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
 * draft-ietf-moq-transport-21 §8.3:
 * "If a receiver understands a Type, and the following Value or Length/Value
 *  does not match the serialization defined by that Type, the receiver MUST
 *  close the session with error code KEY_VALUE_FORMATTING_ERROR."
 * fill fetch ストリームの Object Properties でも既知 Type の Length 宣言超過は
 * セッションを閉じる (エラーコードを保持する)。
 */
test("fill fetch ストリーム: 既知 Type の Length 宣言超過で KEY_VALUE_FORMATTING_ERROR", async () => {
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

  // deltaId=0x0B (IMMUTABLE_PROPERTIES), length=5 宣言 + 2 バイトの切り詰め
  const parts = buildFetchStreamParts(requestId, new Uint8Array([0x0b, 0x05, 0xaa, 0xbb]));
  const handlePromise = ctx.run();
  ctx.enqueue(concatUint8Arrays([parts.headerBytes, parts.fieldsBytes, parts.payload]));
  ctx.fin();
  await handlePromise;

  assert.instanceOf(ctx.sessionError.current, SessionError);
  assert.equal(ctx.sessionError.current.code, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
  assert.equal(delivered, 0);
});

// ============================================================================
// データストリームの受信タイムアウト
// draft-ietf-moq-transport-21 §12.2 (DATA_STREAM_TIMEOUT)
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §12.2:
 * DATA_STREAM_TIMEOUT (0x12) は「ピアが開いたデータストリームで送るべき
 * データを送るのに時間をかけすぎた」ことを示す。Object の途中バイトを保持した
 * ままピアが送信を止めた場合、期限でセッションを閉じる。
 */
test("データストリーム: 途中バイトを保持したままタイムアウトすると DATA_STREAM_TIMEOUT で閉じる", async () => {
  const ctx = createDataStreamFinContext({ dataStreamTimeoutMs: 20 });
  const subscriber = new SubscriberImpl(["live"], "video", 1n, 7n, () => {});
  ctx.internal.subscribersByAlias.set(7n, [subscriber]);

  const parts = buildSubgroupStreamParts();
  const handlePromise = ctx.run();
  // payload 宣言長 10 バイトに対し 4 バイトだけ送って止める
  ctx.enqueue(concatUint8Arrays([parts.headerBytes, parts.fieldsBytes, parts.payload.slice(0, 4)]));
  await new Promise((resolve) => {
    setTimeout(resolve, 80);
  });
  // 期限切れで reader が cancel され読み取りループが終わる
  await handlePromise;

  assert.isDefined(ctx.sessionError.current);
  assert.instanceOf(ctx.sessionError.current, SessionError);
  assert.equal(
    (ctx.sessionError.current as SessionError).code,
    SessionErrorCode.DATA_STREAM_TIMEOUT,
  );
  assert.isTrue(ctx.sessionError.current!.message.includes("data stream timed out"));
});

/**
 * draft-ietf-moq-transport-21 §12.2:
 * Object が完成してバッファが空になったら期限を解除する。FIN を待つ間も
 * タイムアウトしない (ストリームは正常に開いたまま次の Object を待てる)。
 */
test("データストリーム: 完成した Object の処理後にタイムアウトしない", async () => {
  const ctx = createDataStreamFinContext({ dataStreamTimeoutMs: 20 });
  let delivered = 0;
  const subscriber = new SubscriberImpl(["live"], "video", 1n, 7n, () => {
    delivered++;
  });
  ctx.internal.subscribersByAlias.set(7n, [subscriber]);

  const parts = buildSubgroupStreamParts();
  const handlePromise = ctx.run();
  // 読み取りループはチャンク到着ごとにバッファを処理するため、
  // ヘッダー + Object フィールドと payload を別チャンクで送る
  ctx.enqueue(concatUint8Arrays([parts.headerBytes, parts.fieldsBytes]));
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  ctx.enqueue(parts.payload);
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  // 完成後も FIN を送らずに待つ
  await new Promise((resolve) => {
    setTimeout(resolve, 80);
  });

  // バッファが空なので期限は解除されており、セッションは閉じない
  assert.equal(delivered, 1);
  assert.isUndefined(ctx.sessionError.current);

  // 後始末のため FIN する
  ctx.fin();
  await handlePromise;
  assert.isUndefined(ctx.sessionError.current);
});

// ============================================================================
// 統計の受信経路別区分のテスト
// draft-ietf-moq-transport-21 §3.4 (Fill Semantics)
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §3.4 (Fill Semantics):
 * "An object delivered on the fill fetch stream is *fill-delivered*."
 * fill-delivered は通常 FETCH とも subscription-delivered とも別経路であるため、
 * 統計も fill 側の区分に計上し、fetch 側 / subscribe 側には計上しない。
 */
test("統計: fill fetch ストリームのオブジェクトは fill 側に計上する", async () => {
  const { ctx, internals } = createFillFetchStreamContext();
  const requestId = 2n;
  const subscriber = new SubscriberImpl(["live"], "video", requestId, 1n, () => {});
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

  const stats = ctx.session.getStatistics();
  assert.equal(stats.objectsReceivedViaFill, 1);
  assert.equal(stats.bytesReceivedViaFill, parts.payload.byteLength);
  // fill は通常 FETCH でも購読でもない
  assert.equal(stats.objectsReceivedViaFetch, 0);
  assert.equal(stats.bytesReceivedViaFetch, 0);
  assert.equal(stats.objectsReceivedViaSubscribe, 0);
  assert.equal(stats.bytesReceivedViaSubscribe, 0);
});

/**
 * 通常 FETCH のデータストリームのオブジェクトは fetch 側の区分に計上し、
 * fill 側には計上しない (回帰ガード)。fill 側区分の追加で通常 FETCH の
 * 計上先が変わっていないことを固定する。
 */
test("統計: 通常 FETCH のオブジェクトは fetch 側に計上し fill 側には計上しない", async () => {
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
  ctx.enqueue(concatUint8Arrays([parts.headerBytes, parts.fieldsBytes, parts.payload]));
  ctx.fin();
  await handlePromise;

  const stats = ctx.session.getStatistics();
  assert.equal(stats.objectsReceivedViaFetch, 1);
  assert.equal(stats.bytesReceivedViaFetch, parts.payload.byteLength);
  assert.equal(stats.objectsReceivedViaFill, 0);
  assert.equal(stats.bytesReceivedViaFill, 0);
  assert.equal(stats.objectsReceivedViaSubscribe, 0);
  assert.equal(stats.bytesReceivedViaSubscribe, 0);
});

/**
 * draft-ietf-moq-transport-21 §3.4 (Fill Semantics):
 * "When the fill range overlaps the subscription's Location filter, an object
 *  can be both fill-delivered and subscription-delivered."
 * 重なった範囲のオブジェクトは publisher が fill fetch ストリームと
 * Subgroup / Datagram の両方で送るため、受信側は受信したストリームの種別
 * どおりに 1 回ずつ計上する (片方に寄せない)。
 */
test("統計: fill と subscription の両経路で届いたオブジェクトは経路ごとに計上する", async () => {
  const { ctx, internals } = createFillFetchStreamContext();
  const requestId = 2n;
  const trackAlias = 7n;
  const subscriber = new SubscriberImpl(["live"], "video", requestId, trackAlias, () => {});
  internals.subscribers.set(requestId, subscriber);
  internals.subscribersByAlias.set(trackAlias, [subscriber]);
  internals.fillFetchTargets.set(requestId, {
    subscriber,
    groupOrder: GroupOrder.ASCENDING,
  });

  // fill fetch ストリームで 1 オブジェクト届ける
  const fillParts = buildFetchStreamParts(requestId);
  const fillPromise = ctx.run();
  ctx.enqueue(concatUint8Arrays([fillParts.headerBytes, fillParts.fieldsBytes, fillParts.payload]));
  ctx.fin();
  await fillPromise;

  // subscription の Subgroup ストリームでも 1 オブジェクト届ける
  const subgroupParts = buildSubgroupStreamParts();
  let subgroupController!: ReadableStreamDefaultController<Uint8Array>;
  const subgroupStream = new ReadableStream<Uint8Array>({
    start(controller) {
      subgroupController = controller;
    },
  });
  const subgroupPromise = ctx.internal.handleIncomingStream(subgroupStream);
  subgroupController.enqueue(
    concatUint8Arrays([
      subgroupParts.headerBytes,
      subgroupParts.fieldsBytes,
      subgroupParts.payload,
    ]),
  );
  subgroupController.close();
  await subgroupPromise;

  const stats = ctx.session.getStatistics();
  // 受信ストリームの種別ごとに 1 回ずつ計上する
  assert.equal(stats.objectsReceivedViaFill, 1);
  assert.equal(stats.bytesReceivedViaFill, fillParts.payload.byteLength);
  assert.equal(stats.objectsReceivedViaSubscribe, 1);
  assert.equal(stats.bytesReceivedViaSubscribe, subgroupParts.payload.byteLength);
  // 通常 FETCH は 1 件も受信していない
  assert.equal(stats.objectsReceivedViaFetch, 0);
  assert.equal(stats.bytesReceivedViaFetch, 0);
});

/**
 * draft-ietf-moq-transport-21 §3.4.1 (Opening and Closing Fill Fetch Streams):
 * "Because there is no REQUEST_ERROR associated with a fill fetch stream, the
 *  publisher signals a fill failure by resetting the stream" および
 * "Resetting or cancelling a fill fetch stream, by either endpoint, does not
 *  affect the subscription, which continues to deliver objects using
 *  subscribe subgroups and datagrams."
 * fill の失敗は購読の終了ではないため、購読の error ではなく fillError で通知し、
 * 購読とセッションが継続することを検証する。reset 前に受信したオブジェクトは
 * 配信される。
 */
test("fill fetch ストリーム: reset で fillError に通知し購読は継続する", async () => {
  const { ctx, internals } = createFillFetchStreamContext();
  const requestId = 2n;
  let delivered = 0;
  const fillErrors: Error[] = [];
  let subscriptionErrors = 0;
  const subscriber = new SubscriberImpl(
    ["live"],
    "video",
    requestId,
    1n,
    () => {
      delivered++;
    },
    undefined,
    undefined,
    () => {
      subscriptionErrors++;
    },
  );
  subscriber.fillErrorCallback = (error) => {
    fillErrors.push(error);
  };
  internals.subscribers.set(requestId, subscriber);
  internals.fillFetchTargets.set(requestId, {
    subscriber,
    groupOrder: GroupOrder.ASCENDING,
  });

  const parts = buildFetchStreamParts(requestId);
  const handlePromise = ctx.run();
  // handleFillFetchStream はチャンク到着ごとにバッファを処理するため、
  // ヘッダー + Object フィールドと payload を別チャンクで送り、
  // reset の前にオブジェクトを完成させる
  ctx.enqueue(concatUint8Arrays([parts.headerBytes, parts.fieldsBytes]));
  await yieldToMacrotask();
  ctx.enqueue(parts.payload);
  await yieldToMacrotask();
  // ピアが fill fetch ストリームを reset する (RESET_STREAM 相当)
  ctx.reset(Object.assign(new Error("fill reset by publisher"), { source: "stream" }));
  await handlePromise;

  // fill 失敗は fillError で通知され、購読終了の通知は出ない
  assert.equal(fillErrors.length, 1);
  assert.equal(fillErrors[0].message, "fill reset by publisher");
  assert.equal(subscriptionErrors, 0);
  // セッションは閉じず、reset 前のオブジェクトは配信されている
  assert.isUndefined(ctx.sessionError.current);
  assert.equal(ctx.session.state, "connected");
  assert.equal(delivered, 1);
  // fill 関連付けは消え、購読は継続する
  assert.equal(internals.fillFetchTargets.size, 0);
  assert.equal(subscriber.state, "active");
});

/**
 * draft-ietf-moq-transport-21 §3.4.1:
 * "The publisher signals that the fill is complete by closing the stream with
 *  a FIN once all objects in the fill range have been delivered."
 * FIN は fill の正常完了であるため fillError を通知しない。
 */
test("fill fetch ストリーム: FIN 正常完了では fillError を通知しない", async () => {
  const { ctx, internals } = createFillFetchStreamContext();
  const requestId = 2n;
  const fillErrors: Error[] = [];
  const subscriber = new SubscriberImpl(["live"], "video", requestId, 1n, () => {});
  subscriber.fillErrorCallback = (error) => {
    fillErrors.push(error);
  };
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

  assert.equal(fillErrors.length, 0);
  assert.isUndefined(ctx.sessionError.current);
  assert.equal(subscriber.state, "active");
});

/**
 * draft-ietf-moq-transport-21 §12.1 (Malformed Tracks):
 * Malformed Track の検出は購読自体の cancel を伴うため、アプリへの通知は
 * 購読の error コールバックが担う。fill の失敗通知 (fillError) は購読の継続を
 * 前提とするため呼ばない (二重通知を防ぐ)。
 */
test("fill fetch ストリーム: Malformed Track は fillError ではなく購読の error で通知する", async () => {
  const { ctx, internals } = createFillFetchStreamContext();
  const requestId = 2n;
  const trackAlias = 1n;
  let subscriptionError: Error | undefined;
  let fillNotified = 0;
  const subscriber = new SubscriberImpl(
    ["live"],
    "video",
    requestId,
    trackAlias,
    () => {},
    undefined,
    undefined,
    (error) => {
      subscriptionError = error;
    },
  );
  subscriber.fillErrorCallback = () => {
    fillNotified++;
  };
  internals.subscribers.set(requestId, subscriber);
  internals.subscribersByAlias.set(trackAlias, [subscriber]);
  internals.fillFetchTargets.set(requestId, {
    subscriber,
    groupOrder: GroupOrder.ASCENDING,
  });

  // Mandatory Track Property (0x4000-0x7FFF) を含む Object Property は malformed
  const properties = encodeProperties([{ id: 0x4000n, value: 0n }]);
  const parts = buildFetchStreamParts(requestId, properties);
  const handlePromise = ctx.run();
  ctx.enqueue(concatUint8Arrays([parts.headerBytes, parts.fieldsBytes, parts.payload]));
  ctx.fin();
  await handlePromise;

  assert.instanceOf(subscriptionError, MalformedTrackError);
  assert.equal(fillNotified, 0);
  assert.isUndefined(ctx.sessionError.current);
  assert.equal(subscriber.state, "closed");
});

/**
 * fillError コールバックの throw は後始末を止めないが、無音にはしない。
 * 握り潰した例外をデバッグ記録に残すことを検証する。
 */
test("fill fetch ストリーム: fillError コールバックの throw は握り潰して記録する", async () => {
  const { ctx, internals } = createFillFetchStreamContext();
  const requestId = 2n;
  const subscriber = new SubscriberImpl(["live"], "video", requestId, 1n, () => {});
  subscriber.fillErrorCallback = () => {
    throw new Error("app fillError callback failure");
  };
  internals.subscribers.set(requestId, subscriber);
  internals.fillFetchTargets.set(requestId, {
    subscriber,
    groupOrder: GroupOrder.ASCENDING,
  });

  const parts = buildFetchStreamParts(requestId);
  const handlePromise = ctx.run();
  ctx.enqueue(concatUint8Arrays([parts.headerBytes, parts.fieldsBytes]));
  ctx.reset(Object.assign(new Error("fill reset by publisher"), { source: "stream" }));
  await handlePromise;

  // throw しても購読は継続し、セッションも閉じない
  assert.equal(subscriber.state, "active");
  assert.isUndefined(ctx.sessionError.current);
  assert.equal(internals.fillFetchTargets.size, 0);
  // 握り潰した例外はデバッグ記録に残る
  const records = ctx.debugRecords.filter(
    (record) => record.typeName === "FILL_ERROR_CALLBACK_ERROR",
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].decoded?.error, "app fillError callback failure");
});

/**
 * アプリの object コールバックの throw を fill ストリーム自体の失敗と誤認しない
 * ことを検証する。subgroup 経路が SUBGROUP_CALLBACK_ERROR として記録しつつ配送を
 * 継続するのと同じ扱いにし、fillError は通知しない。
 */
test("fill fetch ストリーム: object コールバックの throw でも受信を継続し fillError を通知しない", async () => {
  const { ctx, internals } = createFillFetchStreamContext();
  const requestId = 2n;
  let delivered = 0;
  let fillNotified = 0;
  const subscriber = new SubscriberImpl(["live"], "video", requestId, 1n, () => {
    delivered++;
    throw new Error("app object callback failure");
  });
  subscriber.fillErrorCallback = () => {
    fillNotified++;
  };
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

  // オブジェクトは配信され (コールバックの throw は記録のみ)、fill は正常完了する
  assert.equal(delivered, 1);
  assert.equal(fillNotified, 0);
  assert.isUndefined(ctx.sessionError.current);
  assert.equal(internals.fillFetchTargets.size, 0);
  const records = ctx.debugRecords.filter((record) => record.typeName === "FILL_CALLBACK_ERROR");
  assert.equal(records.length, 1);
  assert.equal(records[0].decoded?.error, "app object callback failure");
});

/**
 * draft-ietf-moq-transport-21 §11.1.2 (Object Status):
 * Subgroup の終わりは status ではなく FIN で通知される
 * ("The end of a Subgroup is signaled by closing its stream with a FIN
 *  (see Section 11.3.2).")。
 * END_OF_GROUP status Object を最後に配信して FIN する形は status varint
 * が decodeObjectFields で必ず消費されるため残バッファは空になり、
 * §11.3 の判定は誤検出しない。先頭の完成 Object と合わせて両方配信される
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
 * §11.3 のもう一方の境界: status varint が途中で切れた FIN は
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
 * close() を経ずに sessionState を closed へ遷移させ request 系の state も
 * 閉じるが、close() の終了処理 (pending reject 等) は行わないため、
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

  // 新たな通知はしない (黙殺)。subscriber は subscribersByAlias にのみ登録
  // (subscribers Map には無い) ので markRequestObjectsClosed の対象外であり、
  // state は変わらない
  assert.isUndefined(ctx.sessionError.current);
  assert.equal(delivered, 0);
  assert.equal(subscriber.state, "active");
});

/**
 * セッション終了済み経路の抑制 (Fetch): transport.closed ハンドラ経由で
 * sessionState が closed になり fetcher も closed になった状態で
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
  // transport.closed 由来の遷移でも fetcher は closed になる
  // (close() 経由と同じく markClosed が走る。 Map には残る)
  assert.equal(fetcher.state, "closed");
  assert.equal(ctx.internal.fetchers.size, 1);
});

/**
 * draft-ietf-moq-transport-21 §9.10:
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
 * draft-ietf-moq-transport-21 §9.10 / §9.20.1:
 * 受信 PUBLISH ストリーム上で許可外パラメータを含む PUBLISH_STATE_NOTIFY を
 * 受信した場合、PROTOCOL_VIOLATION でセッションを閉じることを検証する。
 */
test("受信 PUBLISH ストリーム上の許可外パラメータの PUBLISH_STATE_NOTIFY でセッションが閉じる", async () => {
  const errors: Error[] = [];
  const session = createSessionImpl({
    error: (error) => {
      errors.push(error);
    },
  });
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
  // スコープ違反の具体エラーで閉じていることが code とメッセージから分かる
  assert.equal(errors.length, 1);
  assert.instanceOf(errors[0], SessionError);
  assert.equal((errors[0] as SessionError).code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(
    errors[0].message.includes("parameter type 0x20 not allowed in PUBLISH_STATE_NOTIFY"),
  );
});

/**
 * draft-ietf-moq-transport-21 §9.5 (REQUEST_UPDATE):
 * "The receiver of a REQUEST_UPDATE MUST respond with exactly one REQUEST_OK
 *  or REQUEST_ERROR message ..."
 * 受信 PUBLISH ストリーム上の REQUEST_OK は自 endpoint が送った REQUEST_UPDATE への
 * 応答である。対応する未応答の REQUEST_UPDATE が無い REQUEST_OK は 2 通目以降の
 * 応答であり、PROTOCOL_VIOLATION でセッションを閉じる。
 */
test("受信 PUBLISH ストリーム上の未対応 REQUEST_OK で PROTOCOL_VIOLATION で閉じる", async () => {
  const errors: Error[] = [];
  const session = createSessionImpl({
    error: (error: Error) => {
      errors.push(error);
    },
  });
  const sessionInternal = session as unknown as {
    sessionState: SessionState;
  };
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
  });

  // 自 endpoint は REQUEST_UPDATE を送っていないため、REQUEST_OK は対応が無い
  const writer = new ControlStreamWriter();
  const okFramed = writer.encode(
    MessageType.REQUEST_OK,
    encodeRequestOkPayload({
      type: MessageType.REQUEST_OK,
      parameters: [],
      trackProperties: [],
    }),
  );
  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(
      (controller) => {
        controller.close();
      },
      [okFramed],
    ),
  );

  assert.equal(sessionInternal.sessionState, "closed");
  // 同一チャンク内で閉じた後に残りのメッセージを処理しないため、通知は 1 回だけ
  assert.equal(errors.length, 1);
  assert.instanceOf(errors[0], SessionError);
  assert.equal((errors[0] as SessionError).code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(errors[0].message.includes("no outstanding REQUEST_UPDATE"));
});

/**
 * セッション終了後に同一チャンクの残りメッセージを処理しない検証。
 * 1 通目の REQUEST_OK がパラメータスコープ違反でセッションを閉じた場合、
 * 同一チャンクに連結された 2 通目を処理すると、そこでも違反が検出されて
 * callbacks.error が二重に通知される。
 */
test("受信 PUBLISH ストリーム上の REQUEST_OK で閉じた後は同一チャンクの残りを処理しない", async () => {
  const errors: Error[] = [];
  const session = createSessionImpl({
    error: (error: Error) => {
      errors.push(error);
    },
  });
  const sessionInternal = session as unknown as {
    sessionState: SessionState;
  };
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
  });

  // REQUEST_OK は自 endpoint が送った REQUEST_UPDATE への応答でなければならない。
  // 未応答の REQUEST_UPDATE が無いため 1 通目はこの判定でセッションを閉じる
  // (REQUEST_UPDATE_OK に SUBSCRIBER_PRIORITY が許可されないことも同時に成立するが、
  // 判定は未応答チェックが先)。
  const writer = new ControlStreamWriter();
  const invalidOk = writer.encode(
    MessageType.REQUEST_OK,
    encodeRequestOkPayload({
      type: MessageType.REQUEST_OK,
      parameters: [{ type: MessageParameterType.SUBSCRIBER_PRIORITY, value: new Uint8Array([10]) }],
      trackProperties: [],
    }),
  );
  // 2 通を 1 チャンクに連結する (同一チャンクの残りメッセージを再現する)
  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(
      (controller) => {
        controller.close();
      },
      [concatUint8Arrays([invalidOk, invalidOk])],
    ),
  );

  assert.equal(sessionInternal.sessionState, "closed");
  // 1 通目で閉じた後に 2 通目を処理しないため、通知は 1 回だけ
  assert.equal(errors.length, 1);
  assert.instanceOf(errors[0], SessionError);
  assert.equal((errors[0] as SessionError).code, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.isTrue(errors[0].message.includes("no outstanding REQUEST_UPDATE"));
});

/**
 * draft-ietf-moq-transport-21 §9.8:
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
 * draft-ietf-moq-transport-21 §9.8 / §3.3.1:
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
 * draft-ietf-moq-transport-21 §9.20.18 / §3.3.1 / §9.20.10:
 * 受信 PUBLISH が LARGEST_OBJECT と Next Object 形式の相対 LOCATION_FILTER を
 * 同時に運ぶ場合、フィルタは PUBLISH の LARGEST_OBJECT 基準で一度だけ解決される。
 * LARGEST_OBJECT {7, 2} のとき開始位置は {7, 3} になる。
 */
test("受信 PUBLISH の Next Object フィルタが PUBLISH の LARGEST_OBJECT で解決される", async () => {
  const session = createSessionImpl();
  const delivered: Array<[bigint, bigint]> = [];
  const internal = setupIncomingPublishStreamSession(session, {
    object: (object) => {
      delivered.push([object.groupId, object.objectId]);
    },
  });

  // 購読が active の間に handleObject を検証するため、PUBLISH 後の終端を保持する
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const parameters = [
    encodeLocationFilterParameter({ startGroup: 0n, startObject: 0n }),
    { type: MessageParameterType.LARGEST_OBJECT, value: encodeLocation({ group: 7n, object: 2n }) },
  ];
  const handlePromise = internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(
      (controller) => {
        streamController = controller;
      },
      [],
      parameters,
    ),
  );

  const subscriber = await waitForIncomingPublishSubscriber(internal);
  // LARGEST_OBJECT が購読へ反映される
  assert.deepEqual(subscriber.largestLocation, { group: 7n, object: 2n });

  // 開始位置 {7, 3} より前の {7, 2} は不通過、{7, 3} は配信される
  subscriber.handleObject({
    groupId: 7n,
    objectId: 2n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array(),
  });
  subscriber.handleObject({
    groupId: 7n,
    objectId: 3n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array(),
  });
  assert.deepEqual(delivered, [[7n, 3n]]);

  // 後始末: FIN でストリームを閉じ、ハンドリングを完了させる
  if (streamController === undefined) {
    throw new Error("受信 PUBLISH ストリームの終端操作が取得できていない");
  }
  streamController.close();
  await handlePromise;
});

/**
 * draft-ietf-moq-transport-21 §9.20.18 / §3.3.1 / §9.20.10:
 * 1 フィールドの相対 LOCATION_FILTER も PUBLISH の LARGEST_OBJECT 基準で解決される。
 * LARGEST_OBJECT {7, 2} のとき開始位置は {8, 0} になる。
 */
test("受信 PUBLISH の相対 LOCATION_FILTER が PUBLISH の LARGEST_OBJECT で解決される", async () => {
  const session = createSessionImpl();
  const delivered: Array<[bigint, bigint]> = [];
  const internal = setupIncomingPublishStreamSession(session, {
    object: (object) => {
      delivered.push([object.groupId, object.objectId]);
    },
  });

  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const parameters = [
    encodeLocationFilterParameter({ startGroup: 0n }),
    { type: MessageParameterType.LARGEST_OBJECT, value: encodeLocation({ group: 7n, object: 2n }) },
  ];
  const handlePromise = internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(
      (controller) => {
        streamController = controller;
      },
      [],
      parameters,
    ),
  );

  const subscriber = await waitForIncomingPublishSubscriber(internal);
  assert.deepEqual(subscriber.largestLocation, { group: 7n, object: 2n });

  // 開始位置 {8, 0} より前の {7, 3} は不通過、{8, 0} は配信される
  subscriber.handleObject({
    groupId: 7n,
    objectId: 3n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array(),
  });
  subscriber.handleObject({
    groupId: 8n,
    objectId: 0n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array(),
  });
  assert.deepEqual(delivered, [[8n, 0n]]);

  // 後始末: FIN でストリームを閉じ、ハンドリングを完了させる
  if (streamController === undefined) {
    throw new Error("受信 PUBLISH ストリームの終端操作が取得できていない");
  }
  streamController.close();
  await handlePromise;
});

/**
 * draft-ietf-moq-transport-21 §9.20.18:
 * 受信 PUBLISH が LARGEST_OBJECT のみを運ぶ場合 (LOCATION_FILTER なし)、
 * 購読の largestLocation に反映され、フィルタ未指定のため全 Object が配信される。
 */
test("受信 PUBLISH の LARGEST_OBJECT のみが購読に反映される", async () => {
  const session = createSessionImpl();
  const delivered: Array<[bigint, bigint]> = [];
  const internal = setupIncomingPublishStreamSession(session, {
    object: (object) => {
      delivered.push([object.groupId, object.objectId]);
    },
  });

  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const parameters = [
    { type: MessageParameterType.LARGEST_OBJECT, value: encodeLocation({ group: 7n, object: 2n }) },
  ];
  const handlePromise = internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(
      (controller) => {
        streamController = controller;
      },
      [],
      parameters,
    ),
  );

  const subscriber = await waitForIncomingPublishSubscriber(internal);
  assert.deepEqual(subscriber.largestLocation, { group: 7n, object: 2n });

  // LOCATION_FILTER が無いため、LARGEST_OBJECT 以前の Object も含めて全通過する
  subscriber.handleObject({
    groupId: 7n,
    objectId: 0n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array(),
  });
  subscriber.handleObject({
    groupId: 7n,
    objectId: 2n,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array(),
  });
  assert.deepEqual(delivered, [
    [7n, 0n],
    [7n, 2n],
  ]);

  // 後始末: FIN でストリームを閉じ、ハンドリングを完了させる
  if (streamController === undefined) {
    throw new Error("受信 PUBLISH ストリームの終端操作が取得できていない");
  }
  streamController.close();
  await handlePromise;
});

/**
 * draft-ietf-moq-transport-21 §9.8 / §9.20.1:
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
    const errors: Error[] = [];
    const session = createSessionImpl({
      error: (error) => {
        errors.push(error);
      },
    });
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
    // スコープ違反の具体エラーで閉じていることが code とメッセージから分かる
    assert.equal(errors.length, 1);
    assert.instanceOf(errors[0], SessionError);
    assert.equal((errors[0] as SessionError).code, SessionErrorCode.PROTOCOL_VIOLATION);
    assert.isTrue(errors[0].message.includes("not allowed in PUBLISH"));
  }
});

/**
 * draft-ietf-moq-transport-21 §9.20.19 / §9.20.9 / §9.20.18 / §3.3.1:
 * 受信 PUBLISH に値域外の FORWARD / GROUP_ORDER、End Group 超過の
 * LOCATION_FILTER、Location 構造が不正な LARGEST_OBJECT が含まれる場合、
 * PROTOCOL_VIOLATION でセッションを閉じることを検証する。
 * FORWARD / GROUP_ORDER / LARGEST_OBJECT はデコード層で先に検出され、
 * LOCATION_FILTER 超過は初期パラメータ反映時に検出される。
 */
test("受信 PUBLISH の不正なパラメータでセッションが閉じる", async () => {
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
    // Location の 2 つ目の varint (Object) が欠落した LARGEST_OBJECT
    [{ type: MessageParameterType.LARGEST_OBJECT, value: new Uint8Array([0x07]) }],
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

// ============================================================================
// namespace 系 3 API の送信失敗時の後始末
// 取得済み streamReader / writer のロックを残さない (Map 登録は成功時のみ)
// ============================================================================

/**
 * namespace 系送信テスト用の transport を構築する。
 *
 * 実ストリーム (ReadableStream / WritableStream) を使うため、
 * ロックの残留は getReader / getWriter の再取得可否で検証できる。
 */
function createNamespaceSendFailureTransport(failWrites: boolean): {
  transport: WebTransport;
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  cancelled: unknown[];
  aborted: unknown[];
  closed: unknown[];
} {
  const cancelled: unknown[] = [];
  const aborted: unknown[] = [];
  // cancel / abort の呼び出しを記録し、実処理に委譲する。
  // reader の cancel は readable 側の underlying で観測する。
  // writer の abort は API 取得の writer をラップして観測する
  // (エラー状態のストリームでは sink の abort が呼ばれないため)。
  const readable = new ReadableStream<Uint8Array>({
    cancel: (reason?: unknown) => {
      cancelled.push(reason);
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write: async () => {
      if (failWrites) {
        throw new Error("write failed");
      }
    },
  });
  const closed: unknown[] = [];
  const originalGetWriter = writable.getWriter.bind(writable);
  writable.getWriter = () => {
    const writer = originalGetWriter();
    const originalAbort = writer.abort.bind(writer);
    writer.abort = async (reason?: unknown) => {
      aborted.push(reason);
      return originalAbort(reason);
    };
    const originalClose = writer.close.bind(writer);
    writer.close = async () => {
      closed.push("close");
      return originalClose();
    };
    return writer;
  };
  const transport = {
    closed: new Promise<WebTransportCloseInfo>(() => {}),
    createBidirectionalStream: async (): Promise<WebTransportBidirectionalStream> =>
      ({ readable, writable }) as unknown as WebTransportBidirectionalStream,
  } as unknown as WebTransport;
  return { transport, readable, writable, cancelled, aborted, closed };
}

test("subscribeNamespace: write 失敗時にストリームリソースを掃除して Map に登録しない", async () => {
  // 送信失敗時は reader / writer のロックを残さず、登録も行わない
  const { transport, readable, writable, cancelled, aborted, closed } =
    createNamespaceSendFailureTransport(true);
  const session = new SessionImpl(transport, {});

  let thrown: Error | undefined;
  try {
    await session.subscribeNamespace(["live"], {});
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  // 呼び出し元には送信エラーが伝播する
  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("write failed"));
  // reader / writer のロックは残らない (再取得できる)
  assert.isFalse(readable.locked);
  assert.isFalse(writable.locked);
  // RESET 相当 (cancel / abort) で閉じ、FIN である close は使わない
  assert.deepEqual(cancelled, ["namespace request send failed"]);
  assert.deepEqual(aborted, ["namespace request send failed"]);
  assert.deepEqual(closed, []);
  readable.getReader().releaseLock();
  writable.getWriter().releaseLock();
  // Map に登録されない
  assert.equal(
    (session as unknown as { namespaceSubscriptions: Map<bigint, unknown> }).namespaceSubscriptions
      .size,
    0,
  );
});

test("subscribeTracks: write 失敗時にストリームリソースを掃除して Map に登録しない", async () => {
  // 送信失敗時は reader / writer のロックを残さず、登録も行わない
  const { transport, readable, writable, cancelled, aborted, closed } =
    createNamespaceSendFailureTransport(true);
  const session = new SessionImpl(transport, {});

  let thrown: Error | undefined;
  try {
    await session.subscribeTracks(["live"], {});
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("write failed"));
  assert.isFalse(readable.locked);
  assert.isFalse(writable.locked);
  // RESET 相当 (cancel / abort) で閉じ、FIN である close は使わない
  assert.deepEqual(cancelled, ["namespace request send failed"]);
  assert.deepEqual(aborted, ["namespace request send failed"]);
  assert.deepEqual(closed, []);
  readable.getReader().releaseLock();
  writable.getWriter().releaseLock();
  assert.equal(
    (session as unknown as { tracksSubscriptions: Map<bigint, unknown> }).tracksSubscriptions.size,
    0,
  );
});

test("publishNamespace: write 失敗時にストリームリソースを掃除して Map に登録しない", async () => {
  // 送信失敗時は reader / writer のロックを残さず、登録も行わない
  const { transport, readable, writable, cancelled, aborted, closed } =
    createNamespaceSendFailureTransport(true);
  const session = new SessionImpl(transport, {});

  let thrown: Error | undefined;
  try {
    await session.publishNamespace(["live"], {});
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("write failed"));
  assert.isFalse(readable.locked);
  assert.isFalse(writable.locked);
  // RESET 相当 (cancel / abort) で閉じ、FIN である close は使わない
  assert.deepEqual(cancelled, ["namespace request send failed"]);
  assert.deepEqual(aborted, ["namespace request send failed"]);
  assert.deepEqual(closed, []);
  readable.getReader().releaseLock();
  writable.getWriter().releaseLock();
  assert.equal(
    (session as unknown as { namespacePublications: Map<bigint, unknown> }).namespacePublications
      .size,
    0,
  );
});

test("subscribeNamespace: 送信前の throw でもストリームリソースを掃除する", async () => {
  // encode / build ではなく debug コールバックの throw で送信前失敗を起こす
  const { transport, readable, writable, cancelled, aborted, closed } =
    createNamespaceSendFailureTransport(false);
  const session = new SessionImpl(transport, {
    debug: () => {
      throw new Error("debug boom");
    },
  });

  let thrown: Error | undefined;
  try {
    await session.subscribeNamespace(["live"], {});
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  // 元のエラーが再 throw される
  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("debug boom"));
  assert.isFalse(readable.locked);
  assert.isFalse(writable.locked);
  // RESET 相当 (cancel / abort) で閉じ、FIN である close は使わない
  assert.deepEqual(cancelled, ["namespace request send failed"]);
  assert.deepEqual(aborted, ["namespace request send failed"]);
  assert.deepEqual(closed, []);
  readable.getReader().releaseLock();
  writable.getWriter().releaseLock();
  assert.equal(
    (session as unknown as { namespaceSubscriptions: Map<bigint, unknown> }).namespaceSubscriptions
      .size,
    0,
  );
});

test("subscribeTracks: 送信前の throw でもストリームリソースを掃除する", async () => {
  // debug コールバックの throw で送信前失敗を起こす (encode / build 失敗の代理。
  // catch はエラー種別で分岐しないため、代理経路で catch 全体が検証される)
  const { transport, readable, writable, cancelled, aborted, closed } =
    createNamespaceSendFailureTransport(false);
  const session = new SessionImpl(transport, {
    debug: () => {
      throw new Error("debug boom");
    },
  });

  let thrown: Error | undefined;
  try {
    await session.subscribeTracks(["live"], {});
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("debug boom"));
  assert.isFalse(readable.locked);
  assert.isFalse(writable.locked);
  // RESET 相当 (cancel / abort) で閉じ、FIN である close は使わない
  assert.deepEqual(cancelled, ["namespace request send failed"]);
  assert.deepEqual(aborted, ["namespace request send failed"]);
  assert.deepEqual(closed, []);
  readable.getReader().releaseLock();
  writable.getWriter().releaseLock();
  assert.equal(
    (session as unknown as { tracksSubscriptions: Map<bigint, unknown> }).tracksSubscriptions.size,
    0,
  );
});

test("publishNamespace: 送信前の throw でもストリームリソースを掃除する", async () => {
  // debug コールバックの throw で送信前失敗を起こす (encode / build 失敗の代理)
  const { transport, readable, writable, cancelled, aborted, closed } =
    createNamespaceSendFailureTransport(false);
  const session = new SessionImpl(transport, {
    debug: () => {
      throw new Error("debug boom");
    },
  });

  let thrown: Error | undefined;
  try {
    await session.publishNamespace(["live"], {});
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("debug boom"));
  assert.isFalse(readable.locked);
  assert.isFalse(writable.locked);
  // RESET 相当 (cancel / abort) で閉じ、FIN である close は使わない
  assert.deepEqual(cancelled, ["namespace request send failed"]);
  assert.deepEqual(aborted, ["namespace request send failed"]);
  assert.deepEqual(closed, []);
  readable.getReader().releaseLock();
  writable.getWriter().releaseLock();
  assert.equal(
    (session as unknown as { namespacePublications: Map<bigint, unknown> }).namespacePublications
      .size,
    0,
  );
});

/**
 * draft-ietf-moq-transport-21 §6.4.2.1 (Request ID):
 * 実 SessionImpl で validateIncomingRequestId 消費後に未対応リクエストを処理すると、
 * 同一 receivedRequestIds の共有により重複検出して INVALID_REQUEST_ID で
 * 閉じることを検証する (validate 委譲と未対応経路の同一 Set 共有の配線ガード。
 * 受信 PUBLISH ハンドラ自体の呼出しは含まない)。
 */
test("SessionImpl の validateIncomingRequestId 消費後に未対応リクエストで重複検出して閉じる", async () => {
  // 生産委譲 (SessionImpl.validateIncomingRequestId) で Request ID を消費する
  const transport = {
    closed: new Promise<WebTransportCloseInfo>(() => {}),
    close: () => {},
  } as unknown as WebTransport;
  const notified: Error[] = [];
  const session = new SessionImpl(transport, {
    error: (error) => {
      notified.push(error);
    },
  });

  assert.isNull(session.validateIncomingRequestId(1n));

  // 同一インスタンスに未対応 SUBSCRIBE (Request ID 1) を処理させる
  const stream = {
    readable: new ReadableStream<Uint8Array>({}),
    writable: new WritableStream<Uint8Array>(),
  } as unknown as WebTransportBidirectionalStream;
  const result = await incomingHandleFirstBidiMessage(
    session as unknown as SessionInternal,
    stream,
    {
      type: MessageType.SUBSCRIBE,
      payload: new Uint8Array([0x01]),
    },
  );

  // 重複検出で INVALID_REQUEST_ID によりセッションが閉じる
  assert.isTrue(result);
  assert.equal(session.state, "closed");
  assert.equal(notified.length, 1);
  assert.instanceOf(notified[0], SessionError);
  assert.equal((notified[0] as SessionError).code, SessionErrorCode.INVALID_REQUEST_ID);
});

// ============================================================================
// draft-21 適合監査: SETUP の上限広告と localMaxFilterRanges (A-5 / I-1)
// ============================================================================

/**
 * SessionImpl の localMaxFilterRanges の既定値は 0 (未広告 = Range Filter
 * 受信拒否) であることを検証する (draft-ietf-moq-transport-21 §9.1.6)。
 */
test("SessionImpl: localMaxFilterRanges の既定値は 0", () => {
  const session = createSessionImpl();
  assert.equal(session.localMaxFilterRanges, 0);
});

/**
 * SessionImpl の localMaxRequestUpdates の既定値は 0 (未広告 = 無制限) である
 * ことを検証する (draft-ietf-moq-transport-21 §9.1.7)。
 * §9.1.6 の MAX_FILTER_RANGES の 0 が「受信拒否」なのとは意味が逆である。
 */
test("SessionImpl: localMaxRequestUpdates の既定値は 0", () => {
  const session = createSessionImpl();
  assert.equal(session.localMaxRequestUpdates, 0);
});

/**
 * initialize() が MAX_AUTH_TOKEN_CACHE_SIZE / MAX_REQUEST_UPDATES /
 * MAX_FILTER_RANGES を SETUP で広告し、自 endpoint の MAX_FILTER_RANGES を
 * localMaxFilterRanges に保持することを検証する
 * (draft-ietf-moq-transport-21 §9.1.3 / §9.1.6 / §9.1.7)。
 */
test("initialize: SETUP で上限を広告し localMaxFilterRanges を保持する", async () => {
  const sentChunks: Uint8Array[] = [];
  const clientWritable = new WritableStream<Uint8Array>({
    write(chunk) {
      sentChunks.push(chunk);
    },
  });
  // サーバー制御ストリーム: ストリームタイプ + フレーミング済み SETUP を 1 回だけ流す
  const serverSetup = encodeSetupPayload(createSetup({ moqtImplementation: false }));
  const serverControlWriter = new ControlStreamWriter();
  const serverControlStream = new ReadableStream<Uint8Array>({
    start(controller) {
      const framed = new Uint8Array([
        ...encodeVarint(MessageType.SETUP),
        ...serverControlWriter.encode(MessageType.SETUP, serverSetup),
      ]);
      controller.enqueue(framed);
    },
  });
  const incomingUnidirectionalStreams = new ReadableStream<ReadableStream<Uint8Array>>({
    start(controller) {
      controller.enqueue(serverControlStream);
    },
  });
  const incomingBidirectionalStreams = new ReadableStream<WebTransportBidirectionalStream>({
    start() {},
  });
  const datagramsReadable = new ReadableStream<Uint8Array>({ start() {} });
  const transport = {
    closed: new Promise<WebTransportCloseInfo>(() => {}),
    createUnidirectionalStream: async () => clientWritable,
    incomingUnidirectionalStreams,
    incomingBidirectionalStreams,
    datagrams: {
      readable: datagramsReadable,
      writable: new WritableStream<Uint8Array>(),
    },
  } as unknown as WebTransport;

  const session = new SessionImpl(transport, {});
  // 未広告の既定値は 0 (無制限)。§9.1.6 の MAX_FILTER_RANGES の 0 = 受信拒否とは
  // 意味が逆であるため、受信側のガードでも 0 を拒否として扱わない
  assert.equal(session.localMaxRequestUpdates, 0);
  await session.initialize({
    maxAuthTokenCacheSize: 1024,
    maxRequestUpdates: 8,
    maxFilterRanges: 4,
  });

  // 自 endpoint の上限を保持する
  assert.equal(session.localMaxFilterRanges, 4);
  assert.equal(session.localMaxRequestUpdates, 8);

  // 送信した SETUP から広告値を取得する
  const sent = concatUint8Arrays(sentChunks);
  const [streamType, consumed] = decodeVarint(sent, 0);
  assert.equal(Number(streamType), MessageType.SETUP);
  const messages = new ControlStreamReader().feed(sent.slice(consumed));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.SETUP);
  const setup = decodeSetupPayload(messages[0].payload);
  assert.equal(getSetupMaxAuthTokenCacheSize(setup), 1024);
  assert.equal(getSetupMaxRequestUpdates(setup), 8);
  assert.equal(getSetupMaxFilterRanges(setup), 4);
});

// ============================================================================
// draft-21 適合監査: 受信 PUBLISH 経路の MAX_REQUEST_UPDATES 強制 (§9.1.7)
// ============================================================================

/**
 * 受信 PUBLISH の REQUEST_UPDATE を連結した 1 チャンクを作る
 *
 * draft-ietf-moq-transport-21 §9.1.7 の上限超過は 1 回の read に上限 + 1 通が
 * 含まれる場合に検出するため、テストでは複数通を 1 チャンクに連結して届ける。
 */
function encodeIncomingRequestUpdateChunk(requestIds: bigint[]): Uint8Array {
  const writer = new ControlStreamWriter();
  return concatUint8Arrays(
    requestIds.map((requestId) =>
      writer.encode(
        MessageType.REQUEST_UPDATE,
        encodeRequestUpdatePayload({ type: MessageType.REQUEST_UPDATE, requestId, parameters: [] }),
      ),
    ),
  );
}

/**
 * draft-ietf-moq-transport-21 §9.1.7 (MAX_REQUEST_UPDATES):
 * 受信 PUBLISH ストリームのサブループ (SessionImpl.runPublishStreamSubLoop) で、
 * 自 endpoint が広告した上限 N を超える N+1 通の REQUEST_UPDATE を 1 チャンクで
 * 受信した場合、N+1 通目の処理で TOO_MANY_REQUEST_UPDATES によりセッションが
 * 閉じる MUST を検証する。上限は initialize() を経ないテストのため直接設定する。
 */
test("受信 PUBLISH ストリーム上の MAX_REQUEST_UPDATES 超過で TOO_MANY_REQUEST_UPDATES により閉じる", async () => {
  const errors: Error[] = [];
  const session = createSessionImpl({
    error: (error) => {
      errors.push(error);
    },
  });
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
  });
  // 自 endpoint が上限 2 を広告した状態にする
  session.localMaxRequestUpdates = 2;

  // 1 回の read に 3 通 (上限 2 + 1) を連結した 1 チャンクを届ける。
  // update() ではなくピアが送る REQUEST_UPDATE のため Request ID は奇数を直接使う。
  const updateChunk = encodeIncomingRequestUpdateChunk([101n, 103n, 105n]);
  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(
      (controller) => {
        controller.close();
      },
      [updateChunk],
    ),
  );

  // 3 通目の処理でセッションが閉じ、error コールバックは 1 回だけ呼ばれる
  assert.equal(internal.sessionState, "closed");
  assert.equal(errors.length, 1);
  assert.instanceOf(errors[0], SessionError);
  assert.equal((errors[0] as SessionError).code, SessionErrorCode.TOO_MANY_REQUEST_UPDATES);
  // ストリーム終了時にストリーム単位の未応答数は破棄される
  assert.equal(session.receivedRequestUpdateCounts.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.1.7 (MAX_REQUEST_UPDATES):
 * 「A value of 0 means the endpoint does not limit REQUEST_UPDATE concurrency.」
 * 未広告 (既定値 0) では上限 + 1 通のチャンクを届けてもセッションは閉じず、
 * すべての REQUEST_UPDATE が処理されることを検証する。§9.1.6 の
 * MAX_FILTER_RANGES の 0 が「受信拒否」なのとは意味が逆である。
 */
test("受信 PUBLISH ストリーム上の REQUEST_UPDATE は未広告 (0 = 無制限) なら何通でも閉じない", async () => {
  const errors: Error[] = [];
  const session = createSessionImpl({
    error: (error) => {
      errors.push(error);
    },
  });
  const internal = setupIncomingPublishStreamSession(session, {
    object: () => {},
  });
  // 未広告 (既定値 0 = 無制限) のまま 4 通を 1 チャンクで届ける
  const updateChunk = encodeIncomingRequestUpdateChunk([101n, 103n, 105n, 107n]);
  await internal.handleIncomingBidirectionalStream(
    createIncomingPublishStream(
      (controller) => {
        controller.close();
      },
      [updateChunk],
    ),
  );

  // 上限判定を行わないためセッションは閉じず、エラーも通知されない
  assert.equal(internal.sessionState, "connected");
  assert.equal(errors.length, 0);
  // 各チャンクの処理後とストリーム終了時に未応答数は破棄される
  assert.equal(session.receivedRequestUpdateCounts.size, 0);
});

// ============================================================================
// draft-21 適合修正の回帰テスト
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §6.3 (Session initialization):
 * データストリーム (Object) が制御ストリームより先に到着しても
 * PROTOCOL_VIOLATION で閉じず、SETUP 完了後にバッファリングして処理する。
 */
test("initialize: 制御ストリームより先にデータストリームが到着しても PROTOCOL_VIOLATION にしない", async () => {
  const clientWritable = new WritableStream<Uint8Array>();
  const serverSetup = encodeSetupPayload(createSetup({ moqtImplementation: false }));
  const serverControlWriter = new ControlStreamWriter();
  const serverControlStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new Uint8Array([
          ...encodeVarint(MessageType.SETUP),
          ...serverControlWriter.encode(MessageType.SETUP, serverSetup),
        ]),
      );
    },
  });

  let dataController!: ReadableStreamDefaultController<Uint8Array>;
  const headerBytes = encodeSubgroupHeader({
    type: SubgroupHeaderType.BASE,
    trackAlias: 7n,
    groupId: 1n,
    publisherPriority: 128,
    firstObject: false,
  });
  const fieldsBytes = encodeObjectFields(0n, 0n, SubgroupHeaderType.BASE);
  const dataStream = new ReadableStream<Uint8Array>({
    start(controller) {
      dataController = controller;
      controller.enqueue(concatUint8Arrays([headerBytes, fieldsBytes]));
    },
  });

  const incomingUnidirectionalStreams = new ReadableStream<ReadableStream<Uint8Array>>({
    start(controller) {
      // データストリームを制御ストリームより先に流す
      controller.enqueue(dataStream);
      controller.enqueue(serverControlStream);
    },
  });
  const transport = {
    closed: new Promise<WebTransportCloseInfo>(() => {}),
    createUnidirectionalStream: async () => clientWritable,
    incomingUnidirectionalStreams,
    incomingBidirectionalStreams: new ReadableStream<WebTransportBidirectionalStream>({
      start() {},
    }),
    datagrams: {
      readable: new ReadableStream<Uint8Array>({ start() {} }),
      writable: new WritableStream<Uint8Array>(),
    },
  } as unknown as WebTransport;

  const errors: Error[] = [];
  const session = new SessionImpl(transport, {
    error: (error) => {
      errors.push(error);
    },
  });
  await session.initialize();

  // データストリーム先着でも制御ストリームを特定して SETUP を処理する
  assert.equal(session.state, "connected");
  assert.equal(errors.length, 0);

  // バッファリングしたデータストリームが handleIncomingStream へ渡される
  await yieldToMacrotask();
  const stats = session.getStatistics();
  assert.equal(stats.unidirectionalStreamsReceived, 1);
  assert.equal(stats.subgroupHeadersReceived, 1);

  // 開いたストリームを閉じて後始末する
  dataController.close();
});

/**
 * draft-ietf-moq-transport-21 §6.2 / §6.2.1:
 * WebTransport では WT-Available-Protocols に MOQT プロトコル識別子を提示する。
 * draft-21 は "moqt-21"。
 */
test("connect: WebTransport に protocols ['moqt-21'] を渡す", async () => {
  const originalWebTransport = (globalThis as { WebTransport?: unknown }).WebTransport;
  const recordedOptions: WebTransportOptions[] = [];
  class RecordingWebTransport {
    readonly ready: Promise<void>;
    constructor(_url: string, options?: WebTransportOptions) {
      recordedOptions.push(options ?? {});
      // initialize まで進めないよう ready を reject させる
      this.ready = Promise.reject(new Error("stop before initialize"));
    }
  }
  (globalThis as { WebTransport?: unknown }).WebTransport = RecordingWebTransport;
  let thrown: Error | undefined;
  try {
    await connect("moqt://example.com/moqt");
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  } finally {
    (globalThis as { WebTransport?: unknown }).WebTransport = originalWebTransport;
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("stop before initialize"));
  assert.equal(recordedOptions.length, 1);
  assert.deepEqual(recordedOptions[0].protocols, ["moqt-21"]);
});

/** namespace 系解除テスト用のストリームを構築する (cancel / abort を観測する) */
function createCancelObservingStream(): {
  streamReader: ReadableStreamDefaultReader<Uint8Array>;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  cancelled: unknown[];
  aborted: unknown[];
} {
  const cancelled: unknown[] = [];
  const aborted: unknown[] = [];
  const readable = new ReadableStream<Uint8Array>({
    cancel: (reason?: unknown) => {
      cancelled.push(reason);
    },
  });
  const writable = new WritableStream<Uint8Array>({
    abort: (reason?: unknown) => {
      aborted.push(reason);
    },
  });
  return { streamReader: readable.getReader(), writer: writable.getWriter(), cancelled, aborted };
}

/**
 * draft-ietf-moq-transport-21 §4.1 / §6.4.2.3:
 * SUBSCRIBE_NAMESPACE の解除は送信方向 RESET (writer.abort()) と
 * 受信方向 STOP_SENDING (reader.cancel()) で行う (FIN ではない)。
 */
test("namespace の unsubscribe() は送信方向 abort と受信方向 cancel で解除する", async () => {
  const session = createSessionImpl();
  const internal = session as unknown as {
    namespaceSubscriptions: Map<
      bigint,
      {
        callbacks: object;
        state: "active" | "closed";
        namespacePrefix: string[];
        streamReader: ReadableStreamDefaultReader<Uint8Array>;
        controlReader: ControlStreamReader;
        writer: WritableStreamDefaultWriter<Uint8Array>;
      }
    >;
  };
  const { streamReader, writer, cancelled, aborted } = createCancelObservingStream();
  internal.namespaceSubscriptions.set(1n, {
    callbacks: {},
    state: "active",
    namespacePrefix: ["live"],
    streamReader,
    controlReader: new ControlStreamReader(),
    writer,
  });

  await session.createNamespaceSubscription(1n).unsubscribe();

  assert.deepEqual(cancelled, ["namespace subscription cancelled"]);
  assert.deepEqual(aborted, ["namespace subscription cancelled"]);
  assert.isFalse(internal.namespaceSubscriptions.has(1n));
});

/**
 * draft-ietf-moq-transport-21 §4.1 / §6.4.2.3:
 * SUBSCRIBE_TRACKS の解除も namespace と同様に RESET / STOP_SENDING で行う。
 */
test("tracks の unsubscribe() は送信方向 abort と受信方向 cancel で解除する", async () => {
  const session = createSessionImpl();
  const internal = session as unknown as {
    tracksSubscriptions: Map<
      bigint,
      {
        callbacks: object;
        state: "active" | "closed";
        namespacePrefix: string[];
        streamReader: ReadableStreamDefaultReader<Uint8Array>;
        controlReader: ControlStreamReader;
        writer: WritableStreamDefaultWriter<Uint8Array>;
      }
    >;
  };
  const { streamReader, writer, cancelled, aborted } = createCancelObservingStream();
  internal.tracksSubscriptions.set(1n, {
    callbacks: {},
    state: "active",
    namespacePrefix: ["live"],
    streamReader,
    controlReader: new ControlStreamReader(),
    writer,
  });

  await session.createTracksSubscription(1n).unsubscribe();

  assert.deepEqual(cancelled, ["tracks subscription cancelled"]);
  assert.deepEqual(aborted, ["tracks subscription cancelled"]);
  assert.isFalse(internal.tracksSubscriptions.has(1n));
});

/**
 * draft-ietf-moq-transport-21 §4.2 / §6.4.2.3:
 * PUBLISH_NAMESPACE の撤回も RESET / STOP_SENDING で行う。
 */
test("publishNamespace の done() は送信方向 abort と受信方向 cancel で撤回する", async () => {
  const session = createSessionImpl();
  const internal = session as unknown as {
    namespacePublications: Map<
      bigint,
      {
        callbacks: object;
        state: "pending" | "active" | "closed";
        namespace: string[];
        stream: WebTransportBidirectionalStream;
        streamReader: ReadableStreamDefaultReader<Uint8Array>;
        controlReader: ControlStreamReader;
        writer: WritableStreamDefaultWriter<Uint8Array>;
      }
    >;
  };
  const { streamReader, writer, cancelled, aborted } = createCancelObservingStream();
  internal.namespacePublications.set(1n, {
    callbacks: {},
    state: "active",
    namespace: ["live"],
    stream: {} as WebTransportBidirectionalStream,
    streamReader,
    controlReader: new ControlStreamReader(),
    writer,
  });

  await session.createNamespacePublication(1n).done();

  assert.deepEqual(cancelled, ["namespace publication cancelled"]);
  assert.deepEqual(aborted, ["namespace publication cancelled"]);
  assert.isFalse(internal.namespacePublications.has(1n));
});

/**
 * draft-ietf-moq-transport-21 §6.6.1:
 * GOAWAY_TIMEOUT は未完了の購読・fetch がある場合のみ張る。
 */
test("goaway: 未完了の購読・fetch が無い場合は GOAWAY_TIMEOUT タイマーを張らない", async () => {
  const session = createSessionImpl();
  const internal = session as unknown as {
    controlSendStream?: WritableStream<Uint8Array>;
    controlWriter?: ControlStreamWriter;
    goawayTimeoutId: ReturnType<typeof setTimeout> | null;
  };
  internal.controlSendStream = new WritableStream<Uint8Array>();
  internal.controlWriter = new ControlStreamWriter();

  await session.goaway(undefined, 1000n);

  assert.isNull(internal.goawayTimeoutId);
});

/**
 * draft-ietf-moq-transport-21 §6.6.1:
 * 未完了の購読がある場合は GOAWAY_TIMEOUT タイマーを張る。
 */
test("goaway: 未完了の購読がある場合は GOAWAY_TIMEOUT タイマーを張る", async () => {
  const session = createSessionImpl();
  const internal = session as unknown as {
    controlSendStream?: WritableStream<Uint8Array>;
    controlWriter?: ControlStreamWriter;
    goawayTimeoutId: ReturnType<typeof setTimeout> | null;
    subscribers: Map<bigint, SubscriberImpl>;
  };
  internal.controlSendStream = new WritableStream<Uint8Array>();
  internal.controlWriter = new ControlStreamWriter();
  internal.subscribers.set(1n, new SubscriberImpl(["live"], "video", 1n, 1n, () => {}));

  await session.goaway(undefined, 1000n);

  assert.isNotNull(internal.goawayTimeoutId);
  // テスト後にタイマーを残さない
  clearTimeout(internal.goawayTimeoutId as ReturnType<typeof setTimeout>);
  internal.goawayTimeoutId = null;
});

/**
 * draft-ietf-moq-transport-21 §6.6.1:
 * GOAWAY 受信後は Established 購読が無くなるまで NO_ERROR クローズを待つ。
 */
test("handleGoaway: Established 購読が残っている間は閉じず、購読終了後に閉じる", async () => {
  let closeCalled = false;
  const transport = {
    closed: new Promise<WebTransportCloseInfo>(() => {}),
    close: () => {
      closeCalled = true;
    },
  } as unknown as WebTransport;
  const session = new SessionImpl(transport, {});
  const internal = session as unknown as {
    subscribers: Map<bigint, SubscriberImpl>;
    handleGoaway(payload: Uint8Array): Record<string, unknown>;
  };
  internal.subscribers.set(1n, new SubscriberImpl(["live"], "video", 1n, 1n, () => {}));

  const payload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "",
    timeout: 0n,
  });
  internal.handleGoaway(payload);

  // 購読が残っている間は閉じない
  assert.equal(session.state, "connected");
  assert.isFalse(closeCalled);

  // 購読を除去して drain 通知すると NO_ERROR で閉じる
  internal.subscribers.clear();
  session.onRequestDrained();
  assert.equal(session.state, "closed");
  assert.isTrue(closeCalled);
});

/**
 * draft-ietf-moq-transport-21 §6.6 (Termination):
 * ピア起点で transport.closed が解決した場合も、保留中のリクエスト Promise を
 * reject してアプリを待たせ続けない。
 */
test("transport.closed で保留中のリクエスト Promise を reject する", async () => {
  let resolveClosed!: (info: WebTransportCloseInfo) => void;
  const closedPromise = new Promise<WebTransportCloseInfo>((resolve) => {
    resolveClosed = resolve;
  });
  const transport = { closed: closedPromise } as unknown as WebTransport;
  const session = new SessionImpl(transport, {});
  const internal = session as unknown as {
    pendingSubscribe: Map<
      bigint,
      {
        resolve: () => void;
        reject: (err: Error) => void;
        impl: SubscriberImpl;
        objectCallback: () => void;
      }
    >;
  };
  let rejected: Error | undefined;
  internal.pendingSubscribe.set(1n, {
    resolve: () => {},
    reject: (error: Error) => {
      rejected = error;
    },
    impl: new SubscriberImpl(["live"], "video", 1n, 0n, () => {}),
    objectCallback: () => {},
  });

  resolveClosed({ closeCode: 0, reason: "peer closed" });
  await yieldToMacrotask();

  assert.isDefined(rejected);
  assert.equal(rejected!.message, "session closed by peer");
  assert.equal(session.state, "closed");
  assert.equal(internal.pendingSubscribe.size, 0);
});

/**
 * テスト用に Uint8Array チャンクを連結する
 */
// ============================================================================
// draft-ietf-moq-transport-21 §8.9 / §9.1.4: 受信 SETUP の Authorization Token
// ============================================================================

/**
 * 受信 SETUP に Authorization Token を載せて initialize() するためのセッションを作る
 *
 * §9.1.4 の DELETE / USE_ALIAS は送信側の createSetup が拒否するため、
 * Setup Options を直接組み立ててサーバー制御ストリームに流す。
 * 制御ストリームはストリームタイプ + フレーミング済み SETUP を 1 通だけ流す。
 */
function createIncomingSetupSession(
  parameters: { type: number; value: Uint8Array }[],
): SessionImpl {
  const clientWritable = new WritableStream<Uint8Array>({});
  const serverControlWriter = new ControlStreamWriter();
  const serverControlStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new Uint8Array([
          ...encodeVarint(MessageType.SETUP),
          ...serverControlWriter.encode(
            MessageType.SETUP,
            encodeSetupPayload({ type: MessageType.SETUP, parameters }),
          ),
        ]),
      );
    },
  });
  const incomingUnidirectionalStreams = new ReadableStream<ReadableStream<Uint8Array>>({
    start(controller) {
      controller.enqueue(serverControlStream);
    },
  });
  const incomingBidirectionalStreams = new ReadableStream<WebTransportBidirectionalStream>({
    start() {},
  });
  const transport = {
    closed: new Promise<WebTransportCloseInfo>(() => {}),
    createUnidirectionalStream: async () => clientWritable,
    incomingUnidirectionalStreams,
    incomingBidirectionalStreams,
    datagrams: {
      readable: new ReadableStream<Uint8Array>({ start() {} }),
      writable: new WritableStream<Uint8Array>(),
    },
  } as unknown as WebTransport;
  return new SessionImpl(transport, {});
}

/**
 * 受信 SETUP の違反検証用セッションを作る
 *
 * transport.close の呼び出し (回数と closeCode) とアプリの error コールバックを記録する。
 * `controlBytes` は制御ストリームの生バイト列 (ストリームタイプ varint + フレーミング済み
 * メッセージ) で、SETUP のデコード失敗や先頭メッセージ違反も再現できる。
 */
function createSetupViolationSession(controlBytes: Uint8Array): {
  session: SessionImpl;
  closeCalls: { closeCode?: number; reason?: string }[];
  notified: Error[];
} {
  const clientWritable = new WritableStream<Uint8Array>({});
  const closeCalls: { closeCode?: number; reason?: string }[] = [];
  const notified: Error[] = [];
  const serverControlStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(controlBytes);
    },
  });
  const incomingUnidirectionalStreams = new ReadableStream<ReadableStream<Uint8Array>>({
    start(controller) {
      controller.enqueue(serverControlStream);
    },
  });
  const incomingBidirectionalStreams = new ReadableStream<WebTransportBidirectionalStream>({
    start() {},
  });
  const transport = {
    closed: new Promise<WebTransportCloseInfo>(() => {}),
    createUnidirectionalStream: async () => clientWritable,
    incomingUnidirectionalStreams,
    incomingBidirectionalStreams,
    datagrams: {
      readable: new ReadableStream<Uint8Array>({ start() {} }),
      writable: new WritableStream<Uint8Array>(),
    },
    // W3C WebTransport の close() は単一の WebTransportCloseInfo を取る
    close: async (info?: WebTransportCloseInfo) => {
      closeCalls.push({ closeCode: info?.closeCode, reason: info?.reason });
    },
  } as unknown as WebTransport;
  const session = new SessionImpl(transport, {
    error: (error: Error) => {
      notified.push(error);
    },
  });
  return { session, closeCalls, notified };
}

/**
 * closeWithError からの close() 完了を待つ
 *
 * closeWithError は close() を fire-and-forget で呼ぶため、initialize() の reject を
 * await しただけでは transport.close が未実行のことがある。
 */
async function waitForTransportClose(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
}

/**
 * 制御ストリームの生バイト列 (ストリームタイプ varint + フレーミング済みメッセージ) を組み立てる
 */
function buildControlStreamBytes(
  body: Uint8Array,
  messageType: number = MessageType.SETUP,
): Uint8Array {
  const writer = new ControlStreamWriter();
  return concatUint8Arrays([encodeVarint(MessageType.SETUP), writer.encode(messageType, body)]);
}

/**
 * SETUP の AUTHORIZATION TOKEN Setup Option を組み立てる
 *
 * draft-ietf-moq-transport-21 §9.1.4: オプション値は §8.9 の Token 構造。
 */
function authTokenSetupOption(token: AuthorizationToken): {
  type: number;
  value: Uint8Array;
} {
  return {
    type: SetupOptionType.AUTHORIZATION_TOKEN,
    value: encodeAuthorizationToken(token),
  };
}

/**
 * initialize() が指定コードの SessionError で失敗することを検証する
 *
 * 本テストランナーの assert には rejects が無いため、try/catch で捕捉して
 * 未捕捉 (成功してしまった) 場合も失敗として検出する。
 */
async function assertInitializeFailsWith(
  session: SessionImpl,
  expectedCode: SessionErrorCode,
): Promise<void> {
  let thrown: unknown;
  try {
    await session.initialize({ maxAuthTokenCacheSize: 1024 });
  } catch (error) {
    thrown = error;
  }
  assert.instanceOf(thrown, SessionError);
  assert.equal((thrown as SessionError).code, expectedCode);
}

/**
 * draft-ietf-moq-transport-21 §9.1.1 (AUTHORITY):
 * "When an AUTHORITY option is received from a server, or when an AUTHORITY option
 *  is received while WebTransport is used, ... the session MUST be closed with
 *  INVALID_AUTHORITY."
 * initialize() の失敗だけでなく、トランスポートも閉じてピアへコードを伝えることを検証する。
 */
test("initialize: 受信 SETUP の AUTHORITY で INVALID_AUTHORITY で閉じる", async () => {
  const ctx = createSetupViolationSession(
    buildControlStreamBytes(
      encodeSetupPayload({
        type: MessageType.SETUP,
        parameters: [
          { type: SetupOptionType.AUTHORITY, value: new TextEncoder().encode("example.com") },
        ],
      }),
    ),
  );

  await assertInitializeFailsWith(ctx.session, SessionErrorCode.INVALID_AUTHORITY);
  await waitForTransportClose();
  // transport.close は 1 回だけ、同じコードで呼ばれる
  assert.equal(ctx.closeCalls.length, 1);
  assert.equal(ctx.closeCalls[0].closeCode, SessionErrorCode.INVALID_AUTHORITY);
  // アプリの error 通知も 1 回だけ
  assert.equal(ctx.notified.length, 1);
  assert.equal((ctx.notified[0] as SessionError).code, SessionErrorCode.INVALID_AUTHORITY);
});

/**
 * draft-ietf-moq-transport-21 §9.1.2 (PATH):
 * "When a PATH setup option is received from a server, or when a PATH parameter is
 *  received while WebTransport is used, ... the session MUST be closed with INVALID_PATH."
 */
test("initialize: 受信 SETUP の PATH で INVALID_PATH で閉じる", async () => {
  const ctx = createSetupViolationSession(
    buildControlStreamBytes(
      encodeSetupPayload({
        type: MessageType.SETUP,
        parameters: [{ type: SetupOptionType.PATH, value: new TextEncoder().encode("/moqt") }],
      }),
    ),
  );

  await assertInitializeFailsWith(ctx.session, SessionErrorCode.INVALID_PATH);
  await waitForTransportClose();
  assert.equal(ctx.closeCalls.length, 1);
  assert.equal(ctx.closeCalls[0].closeCode, SessionErrorCode.INVALID_PATH);
  assert.equal(ctx.notified.length, 1);
  assert.equal((ctx.notified[0] as SessionError).code, SessionErrorCode.INVALID_PATH);
});

/**
 * draft-ietf-moq-transport-21 §9 (Control Messages):
 * メッセージ Length と Body 長の不一致は PROTOCOL_VIOLATION でセッションを閉じる MUST。
 * KVP の宣言 Length が残りデータを超える SETUP でも、initialize() の失敗と同時に
 * セッションが閉じられることを検証する。
 */
test("initialize: 受信 SETUP のデコード失敗で PROTOCOL_VIOLATION で閉じる", async () => {
  // パラメータ数 1、Type 0x05、宣言 Length 10 に対して値が 2 バイトしかない
  const malformedBody = new Uint8Array([0x01, 0x05, 0x00, 0x0a, 0x01, 0x02]);
  const ctx = createSetupViolationSession(buildControlStreamBytes(malformedBody));

  // initialize() は失敗を reject で伝える契約のため、正規化前の例外がそのまま伝播する
  let thrown: unknown;
  try {
    await ctx.session.initialize({ maxAuthTokenCacheSize: 1024 });
  } catch (error) {
    thrown = error;
  }
  assert.isDefined(thrown);
  // close() は closeWithError から fire-and-forget で呼ばれるため、完了を待つ
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  // セッションは PROTOCOL_VIOLATION で閉じられ、ピアにも同じコードが伝わる
  assert.equal(ctx.closeCalls.length, 1);
  assert.equal(ctx.closeCalls[0].closeCode, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.equal(ctx.notified.length, 1);
  assert.instanceOf(ctx.notified[0], SessionError);
  assert.equal((ctx.notified[0] as SessionError).code, SessionErrorCode.PROTOCOL_VIOLATION);
});

/**
 * draft-ietf-moq-transport-21 §9.1 (SETUP):
 * 制御ストリームの先頭メッセージが SETUP でない場合は PROTOCOL_VIOLATION で閉じる。
 */
test("initialize: 先頭メッセージが SETUP でない場合も PROTOCOL_VIOLATION で閉じる", async () => {
  const ctx = createSetupViolationSession(
    buildControlStreamBytes(new Uint8Array(0), MessageType.GOAWAY),
  );

  await assertInitializeFailsWith(ctx.session, SessionErrorCode.PROTOCOL_VIOLATION);
  await waitForTransportClose();
  assert.equal(ctx.closeCalls.length, 1);
  assert.equal(ctx.closeCalls[0].closeCode, SessionErrorCode.PROTOCOL_VIOLATION);
  assert.equal(ctx.notified.length, 1);
  assert.equal((ctx.notified[0] as SessionError).code, SessionErrorCode.PROTOCOL_VIOLATION);
});

/**
 * 既存の AUTHORIZATION TOKEN 経路 (DUPLICATE_AUTH_TOKEN_ALIAS) でも、
 * reject する例外の code と
 * transport.close / error 通知が 1 回ずつであることが変わらないことを検証する。
 */
test("initialize: 同一 Alias 再 REGISTER でトランスポートも 1 回だけ閉じる", async () => {
  const registerToken: AuthorizationToken = {
    aliasType: AuthorizationTokenAliasType.REGISTER,
    tokenAlias: 5n,
    tokenType: 1n,
    tokenValue: new Uint8Array([1]),
  };
  const ctx = createSetupViolationSession(
    buildControlStreamBytes(
      encodeSetupPayload({
        type: MessageType.SETUP,
        parameters: [authTokenSetupOption(registerToken), authTokenSetupOption(registerToken)],
      }),
    ),
  );

  await assertInitializeFailsWith(ctx.session, SessionErrorCode.DUPLICATE_AUTH_TOKEN_ALIAS);
  await waitForTransportClose();
  assert.equal(ctx.closeCalls.length, 1);
  assert.equal(ctx.closeCalls[0].closeCode, SessionErrorCode.DUPLICATE_AUTH_TOKEN_ALIAS);
  assert.equal(ctx.notified.length, 1);
  assert.equal((ctx.notified[0] as SessionError).code, SessionErrorCode.DUPLICATE_AUTH_TOKEN_ALIAS);
});

/**
 * draft-ietf-moq-transport-21 §9.1.4 / §8.9:
 * 受信 SETUP の REGISTER が自 endpoint のトークンキャッシュへ登録されることを
 * 検証する。上限は広告した MAX_AUTH_TOKEN_CACHE_SIZE (§9.1.3)。
 */
test("initialize: 受信 SETUP の REGISTER がトークンキャッシュへ登録される", async () => {
  const session = createIncomingSetupSession([
    authTokenSetupOption({
      aliasType: AuthorizationTokenAliasType.REGISTER,
      tokenAlias: 3n,
      tokenType: 7n,
      tokenValue: new Uint8Array([0xaa, 0xbb]),
    }),
  ]);

  await session.initialize({ maxAuthTokenCacheSize: 1024 });

  // 自 endpoint が広告した上限を保持する
  assert.equal(session.localMaxAuthTokenCacheSize, 1024);
  // ピアが REGISTER した Alias を解決できる
  assert.deepEqual(session.receivedAuthTokens.resolve(3n), {
    status: "resolved",
    tokenType: 7n,
    tokenValue: new Uint8Array([0xaa, 0xbb]),
  });
  // §9.1.3: エントリサイズは 16 バイト + Token Value 長
  assert.equal(session.receivedAuthTokens.size, 18);
});

/**
 * draft-ietf-moq-transport-21 §9.1.4 / §8.9:
 * 受信 SETUP で登録済み Alias を再 REGISTER した場合は
 * DUPLICATE_AUTH_TOKEN_ALIAS でセッションを閉じる MUST を検証する。
 */
test("initialize: 受信 SETUP の同一 Alias 再 REGISTER は DUPLICATE_AUTH_TOKEN_ALIAS で閉じる", async () => {
  const registerToken: AuthorizationToken = {
    aliasType: AuthorizationTokenAliasType.REGISTER,
    tokenAlias: 5n,
    tokenType: 1n,
    tokenValue: new Uint8Array([1]),
  };
  const session = createIncomingSetupSession([
    authTokenSetupOption(registerToken),
    authTokenSetupOption(registerToken),
  ]);

  await assertInitializeFailsWith(session, SessionErrorCode.DUPLICATE_AUTH_TOKEN_ALIAS);
});

/**
 * draft-ietf-moq-transport-21 §9.1.4:
 * SETUP の DELETE は server 宛の MUST だが、client である moqt-js も
 * 防御的検査として PROTOCOL_VIOLATION でセッションを閉じることを検証する。
 */
test("initialize: 受信 SETUP の DELETE は PROTOCOL_VIOLATION で閉じる", async () => {
  const session = createIncomingSetupSession([
    authTokenSetupOption({ aliasType: AuthorizationTokenAliasType.DELETE, tokenAlias: 1n }),
  ]);

  await assertInitializeFailsWith(session, SessionErrorCode.PROTOCOL_VIOLATION);
});

/**
 * draft-ietf-moq-transport-21 §9.1.4:
 * SETUP の USE_ALIAS も同様に PROTOCOL_VIOLATION でセッションを閉じることを検証する。
 * SETUP 時点で解決できる Alias は存在しないため、登録済みでも拒否する。
 */
test("initialize: 受信 SETUP の USE_ALIAS は PROTOCOL_VIOLATION で閉じる", async () => {
  const session = createIncomingSetupSession([
    authTokenSetupOption({
      aliasType: AuthorizationTokenAliasType.REGISTER,
      tokenAlias: 1n,
      tokenType: 1n,
      tokenValue: new Uint8Array([1]),
    }),
    authTokenSetupOption({ aliasType: AuthorizationTokenAliasType.USE_ALIAS, tokenAlias: 1n }),
  ]);

  await assertInitializeFailsWith(session, SessionErrorCode.PROTOCOL_VIOLATION);
});

/**
 * draft-ietf-moq-transport-21 §9.1.4:
 * 受信 SETUP の REGISTER が MAX_AUTH_TOKEN_CACHE_SIZE を超える場合、
 * AUTH_TOKEN_CACHE_OVERFLOW でセッションを失敗させず USE_VALUE として扱う MUST を
 * 検証する。MAX_AUTH_TOKEN_CACHE_SIZE を広告しない既定 (0) が上限になる。
 */
test("initialize: 受信 SETUP の上限超過 REGISTER は USE_VALUE 扱いで閉じない", async () => {
  const session = createIncomingSetupSession([
    authTokenSetupOption({
      aliasType: AuthorizationTokenAliasType.REGISTER,
      tokenAlias: 1n,
      tokenType: 1n,
      tokenValue: new Uint8Array([1]),
    }),
  ]);

  // 上限を広告しない (既定 0 = Alias 使用禁止)
  await session.initialize();

  // キャッシュへ登録されず、Alias は解決できない
  assert.equal(session.receivedAuthTokens.size, 0);
  assert.deepEqual(session.receivedAuthTokens.resolve(1n), { status: "unknown-alias" });
  // セッションは閉じない
  assert.equal(session.state, "connected");
});

/**
 * draft-ietf-moq-transport-21 §8.9:
 * Token 構造がデコードできない場合は KEY_VALUE_FORMATTING_ERROR で
 * セッションを閉じる MUST を検証する。0x04 は未定義の Alias Type。
 */
test("initialize: 受信 SETUP のデコード不能 Token は KEY_VALUE_FORMATTING_ERROR で閉じる", async () => {
  const session = createIncomingSetupSession([
    { type: SetupOptionType.AUTHORIZATION_TOKEN, value: new Uint8Array([0x04]) },
  ]);

  await assertInitializeFailsWith(session, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
});

// ============================================================================
// draft-ietf-moq-transport-21 §8.9 / §9.20.3: 受信 PUBLISH の Authorization Token
// ============================================================================

/**
 * 受信 PUBLISH に AUTHORIZATION TOKEN パラメータを載せて処理させるハーネス
 *
 * トークンキャッシュの上限は自 endpoint が広告した MAX_AUTH_TOKEN_CACHE_SIZE
 * (§9.1.3) である。initialize() を経ずに SessionImpl を直接組み立てるテストでは
 * 広告値とキャッシュを直接設定する。
 *
 * @param authTokenCacheSize - 自 endpoint が広告する上限 (0 = Alias 使用禁止)
 */
function createPublishAuthTokenContext(authTokenCacheSize: number): {
  session: SessionImpl;
  errors: Error[];
  written: Uint8Array[];
  handle: (parameters: { type: number; value: Uint8Array }[], requestId?: bigint) => Promise<void>;
} {
  const errors: Error[] = [];
  const session = createSessionImpl({
    error: (error) => {
      errors.push(error);
    },
  });
  const sessionInternal = session as unknown as {
    tracksSubscriptions: Map<bigint, TracksSubscriptionEntryView>;
    receivedRequestIds: Set<bigint>;
    subscribersByAlias: Map<bigint, unknown[]>;
    handleIncomingBidirectionalStream: (stream: WebTransportBidirectionalStream) => Promise<void>;
  };

  // 受信 PUBLISH を購読へマッチさせるため、namespace 前方一致する購読を登録する。
  // §8.9 の MUST (REGISTER はメッセージが他の理由で失敗しても登録を維持する) を
  // 検証できるよう、トークン処理はマッチングより前に走る。
  sessionInternal.tracksSubscriptions.set(1n, {
    callbacks: {
      onPublish: async () => ({ object: () => {} }),
      onNamespaceDone: () => {},
      onPublishSkipped: () => {},
    } as TracksSubscriptionCallbacks,
    state: "active",
    namespacePrefix: ["live"],
    rangeFilters: [],
  });
  sessionInternal.receivedRequestIds = new Set();
  sessionInternal.subscribersByAlias = new Map();

  session.localMaxAuthTokenCacheSize = authTokenCacheSize;
  session.receivedAuthTokens = new AuthTokenCache(authTokenCacheSize);

  const written: Uint8Array[] = [];
  return {
    session,
    errors,
    written,
    handle: async (parameters, requestId = 1n) => {
      const publishPayload = encodePublishPayload({
        type: MessageType.PUBLISH,
        requestId,
        trackNamespace: createTrackNamespace(["live"]),
        trackName: new TextEncoder().encode("track"),
        trackAlias: 1n,
        parameters,
        trackProperties: [],
      });
      const framed = new ControlStreamWriter().encode(MessageType.PUBLISH, publishPayload);
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
    },
  };
}

/**
 * draft-ietf-moq-transport-21 §9.20.3 / §8.9:
 * 受信 PUBLISH の AUTHORIZATION TOKEN パラメータの REGISTER が
 * トークンキャッシュへ登録されることを検証する。
 */
test("受信 PUBLISH: AUTHORIZATION TOKEN の REGISTER がトークンキャッシュへ登録される", async () => {
  const ctx = createPublishAuthTokenContext(1024);

  await ctx.handle([
    {
      type: MessageParameterType.AUTHORIZATION_TOKEN,
      value: encodeAuthorizationToken({
        aliasType: AuthorizationTokenAliasType.REGISTER,
        tokenAlias: 2n,
        tokenType: 9n,
        tokenValue: new Uint8Array([0x11, 0x22]),
      }),
    },
  ]);

  // §9.1.3: エントリサイズは 16 バイト + Token Value 長
  assert.deepEqual(ctx.session.receivedAuthTokens.resolve(2n), {
    status: "resolved",
    tokenType: 9n,
    tokenValue: new Uint8Array([0x11, 0x22]),
  });
  assert.equal(ctx.session.receivedAuthTokens.size, 18);
  assert.equal(ctx.session.state, "connected");
  assert.equal(ctx.errors.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §9.20.3 / §8.9:
 * 受信 PUBLISH の USE_ALIAS が登録済みの Token Type / Value を解決し、
 * セッションを閉じないことを検証する。
 */
test("受信 PUBLISH: 登録済み Alias の USE_ALIAS は解決されセッションを閉じない", async () => {
  const ctx = createPublishAuthTokenContext(1024);

  await ctx.handle([
    {
      type: MessageParameterType.AUTHORIZATION_TOKEN,
      value: encodeAuthorizationToken({
        aliasType: AuthorizationTokenAliasType.REGISTER,
        tokenAlias: 4n,
        tokenType: 5n,
        tokenValue: new Uint8Array([0x33]),
      }),
    },
  ]);
  await ctx.handle(
    [
      {
        type: MessageParameterType.AUTHORIZATION_TOKEN,
        value: encodeAuthorizationToken({
          aliasType: AuthorizationTokenAliasType.USE_ALIAS,
          tokenAlias: 4n,
        }),
      },
    ],
    3n,
  );

  assert.equal(ctx.session.state, "connected");
  assert.equal(ctx.errors.length, 0);
});

/**
 * draft-ietf-moq-transport-21 §8.9 / §6.6 / §12.2:
 * 未登録 Alias を参照する USE_ALIAS は Session Termination の
 * UNKNOWN_AUTH_TOKEN_ALIAS (0x17) でセッションを閉じることを検証する。
 * 0x17 は §16.11.2 (REQUEST_ERROR Codes) に収載されていないため、
 * REQUEST_ERROR では送らない。REQUEST_ERROR も PUBLISH_DONE も書かれない。
 */
test("受信 PUBLISH: 未登録 Alias の USE_ALIAS は UNKNOWN_AUTH_TOKEN_ALIAS でセッションを閉じる", async () => {
  const ctx = createPublishAuthTokenContext(1024);

  await ctx.handle([
    {
      type: MessageParameterType.AUTHORIZATION_TOKEN,
      value: encodeAuthorizationToken({
        aliasType: AuthorizationTokenAliasType.USE_ALIAS,
        tokenAlias: 99n,
      }),
    },
  ]);

  // セッションを閉じるため REQUEST_ERROR も PUBLISH_DONE も送らない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 0);
  assert.equal(ctx.session.state, "closed");
  assert.equal(ctx.errors.length, 1);
  assert.instanceOf(ctx.errors[0], SessionError);
  assert.equal((ctx.errors[0] as SessionError).code, SessionErrorCode.UNKNOWN_AUTH_TOKEN_ALIAS);
});

/**
 * draft-ietf-moq-transport-21 §8.9 / §9.1.3:
 * Message Parameter の REGISTER が MAX_AUTH_TOKEN_CACHE_SIZE を超える場合は
 * AUTH_TOKEN_CACHE_OVERFLOW でセッションを終了する MUST を検証する。
 * SETUP 経路 (§9.1.4) と異なり USE_VALUE へ降格しない。
 */
test("受信 PUBLISH: 上限超過 REGISTER は AUTH_TOKEN_CACHE_OVERFLOW でセッションを閉じる", async () => {
  // 上限 0 (未広告) では Alias を 1 つも登録できない
  const ctx = createPublishAuthTokenContext(0);

  await ctx.handle([
    {
      type: MessageParameterType.AUTHORIZATION_TOKEN,
      value: encodeAuthorizationToken({
        aliasType: AuthorizationTokenAliasType.REGISTER,
        tokenAlias: 1n,
        tokenType: 1n,
        tokenValue: new Uint8Array([0x44]),
      }),
    },
  ]);

  assert.equal(ctx.session.state, "closed");
  assert.equal(ctx.errors.length, 1);
  assert.instanceOf(ctx.errors[0], SessionError);
  assert.equal((ctx.errors[0] as SessionError).code, SessionErrorCode.AUTH_TOKEN_CACHE_OVERFLOW);
});

/**
 * draft-ietf-moq-transport-21 §8.9 / §6.6 / §12.2:
 * 1 通の PUBLISH 内で REGISTER → DELETE → USE_ALIAS の順に現れる場合、
 * DELETE まで適用されたうえで USE_ALIAS が未登録として扱われ、
 * UNKNOWN_AUTH_TOKEN_ALIAS (0x17) の Session Termination でセッションが
 * 閉じることを検証する。
 */
test("受信 PUBLISH: 同一メッセージ内の DELETE で退役した Alias への USE_ALIAS は Session Termination になる", async () => {
  const ctx = createPublishAuthTokenContext(1024);

  await ctx.handle([
    {
      type: MessageParameterType.AUTHORIZATION_TOKEN,
      value: encodeAuthorizationToken({
        aliasType: AuthorizationTokenAliasType.REGISTER,
        tokenAlias: 6n,
        tokenType: 1n,
        tokenValue: new Uint8Array([0x55]),
      }),
    },
    {
      type: MessageParameterType.AUTHORIZATION_TOKEN,
      value: encodeAuthorizationToken({
        aliasType: AuthorizationTokenAliasType.DELETE,
        tokenAlias: 6n,
      }),
    },
    {
      type: MessageParameterType.AUTHORIZATION_TOKEN,
      value: encodeAuthorizationToken({
        aliasType: AuthorizationTokenAliasType.USE_ALIAS,
        tokenAlias: 6n,
      }),
    },
  ]);

  // セッションが閉じるため、REQUEST_OK / REQUEST_ERROR も PUBLISH_DONE も送らない。
  // 受信トークンキャッシュはセッション終了時に破棄される (§8.9) ので size は 0 になる。
  // DELETE が適用されたこと自体の検証は、セッションを閉じないキャッシュ層の
  // authTokenCache.test.ts (DELETE → USE_ALIAS のテスト) が担う。
  const messages = new ControlStreamReader().feed(concatUint8Arrays(ctx.written));
  assert.equal(messages.length, 0);
  assert.equal(ctx.session.state, "closed");
  assert.equal(ctx.session.receivedAuthTokens.size, 0);
  assert.equal(ctx.errors.length, 1);
  assert.instanceOf(ctx.errors[0], SessionError);
  assert.equal((ctx.errors[0] as SessionError).code, SessionErrorCode.UNKNOWN_AUTH_TOKEN_ALIAS);
  // 原因の Alias 値が診断メッセージに含まれる
  assert.match((ctx.errors[0] as SessionError).message, /alias=6/);
});

/**
 * draft-ietf-moq-transport-21 §8.9:
 * Token 構造がデコードできない AUTHORIZATION TOKEN パラメータは
 * KEY_VALUE_FORMATTING_ERROR でセッションを閉じる MUST を検証する。
 */
test("受信 PUBLISH: デコード不能な Token は KEY_VALUE_FORMATTING_ERROR で閉じる", async () => {
  const ctx = createPublishAuthTokenContext(1024);

  // 未知の Alias Type (0x04) は Token 構造としてデコードできない
  await ctx.handle([
    { type: MessageParameterType.AUTHORIZATION_TOKEN, value: new Uint8Array([0x04]) },
  ]);

  assert.equal(ctx.session.state, "closed");
  assert.equal(ctx.errors.length, 1);
  assert.instanceOf(ctx.errors[0], SessionError);
  assert.equal((ctx.errors[0] as SessionError).code, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
});
