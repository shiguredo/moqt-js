/**
 * SessionImpl の単体テスト
 *
 * WebTransport のモックを渡して SessionImpl を構築し、送信前検証をテストする。
 */

import { test, assert } from "vite-plus/test";
import { SessionImpl } from "./session";

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

import { MessageType } from "./message";
import { createTrackNamespace, encodePublishPayload } from "./message";
import { decodeRequestErrorPayload } from "./message/session";
import { RequestErrorCode } from "./error";
import { ControlStreamReader, ControlStreamWriter } from "./controlStream";
import type { RangeFilterSpec } from "./message/parameter";

// ============================================================================
// 受信 PUBLISH の TRACK_PROPERTY_FILTER 評価 (draft-ietf-moq-transport-19 §5.1.3)
// ============================================================================

/**
 * 受信 PUBLISH 処理のテスト用に SessionImpl を構築する。
 * handleIncomingBidirectionalStream は private のため、型キャストでアクセスする。
 */
function createPublishReceiveSession(
  callbacks: {
    error?: (error: Error) => void;
  } = {},
): SessionImpl {
  const transport = {
    closed: new Promise<WebTransportCloseInfo>(() => {}),
  } as unknown as WebTransport;
  return new SessionImpl(transport, callbacks);
}

/**
 * tracksSubscriptions にエントリを登録する (private フィールドへのテスト用アクセス)。
 */
function registerTracksSubscription(
  session: SessionImpl,
  requestId: bigint,
  callbacks: { onPublish?: (suffix: string[], trackName: string) => unknown },
  rangeFilters?: RangeFilterSpec[],
): void {
  const internal = session as unknown as {
    tracksSubscriptions: Map<
      bigint,
      {
        callbacks: { onPublish?: (suffix: string[], trackName: string) => unknown };
        state: "active" | "closed";
        namespacePrefix: string[];
        rangeFilters?: RangeFilterSpec[];
      }
    >;
  };
  internal.tracksSubscriptions.set(requestId, {
    callbacks,
    state: "active",
    namespacePrefix: ["live"],
    rangeFilters,
  });
}

/**
 * 実 W3C 双方向ストリームを構築し、PUBLISH メッセージを注入する。
 * readableController.close() でストリームを閉じると受信ループが終了する。
 */
function createPublishStream(publishTrackProperties: { id: bigint; value: bigint }[]): {
  stream: WebTransportBidirectionalStream;
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
  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;

  // PUBLISH メッセージを構築して注入する
  const publishMsg = {
    type: MessageType.PUBLISH,
    // 受信側検証 (§10.1) を通すため奇数を指定する (peer 側の Request ID)
    requestId: 3n,
    trackNamespace: createTrackNamespace(["live", "video"]),
    trackName: new TextEncoder().encode("track"),
    trackAlias: 1n,
    parameters: [],
    trackProperties: publishTrackProperties,
  };
  const payload = encodePublishPayload(publishMsg);
  const framed = new ControlStreamWriter().encode(MessageType.PUBLISH, payload);
  readableController.enqueue(framed);

  return { stream, readableController, written };
}

/**
 * draft-ietf-moq-transport-19 §5.1.3:
 * 受信 PUBLISH の Track Properties が TRACK_PROPERTY_FILTER を満たさない場合、
 * onPublish が呼ばれず REQUEST_ERROR (UNINTERESTED) で拒否されることを検証する。
 */
test("受信 PUBLISH が TRACK_PROPERTY_FILTER を満たさない場合は UNINTERESTED で拒否される", async () => {
  const session = createPublishReceiveSession();
  let publishCalled = false;
  registerTracksSubscription(
    session,
    0n,
    {
      onPublish: () => {
        publishCalled = true;
        return { object: () => {} };
      },
    },
    [{ type: "trackProperty", setId: 0, propertyType: 0x30n, ranges: [{ start: 1n, end: 1n }] }],
  );

  const { stream, readableController, written } = createPublishStream([
    // フィルタは 0x30 = 1 を要求するが、PUBLISH は 0x30 = 0
    { id: 0x30n, value: 0n },
  ]);
  readableController.close();

  const handle = session as unknown as {
    handleIncomingBidirectionalStream: (s: WebTransportBidirectionalStream) => Promise<void>;
  };
  await handle.handleIncomingBidirectionalStream(stream);

  // onPublish は呼ばれず、REQUEST_ERROR (UNINTERESTED) が応答される
  assert.isFalse(publishCalled);
  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  const decoded = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.UNINTERESTED));
});

/**
 * draft-ietf-moq-transport-19 §5.1.3:
 * 受信 PUBLISH の Track Properties が TRACK_PROPERTY_FILTER を満たす場合、
 * onPublish が呼ばれることを検証する。
 */
test("受信 PUBLISH が TRACK_PROPERTY_FILTER を満たす場合は onPublish が呼ばれる", async () => {
  const session = createPublishReceiveSession();
  let publishCalled = false;
  registerTracksSubscription(
    session,
    0n,
    {
      onPublish: () => {
        publishCalled = true;
        return { object: () => {} };
      },
    },
    [{ type: "trackProperty", setId: 0, propertyType: 0x30n, ranges: [{ start: 1n, end: 1n }] }],
  );

  const { stream, readableController } = createPublishStream([
    // フィルタの要求どおり 0x30 = 1
    { id: 0x30n, value: 1n },
  ]);
  readableController.close();

  const handle = session as unknown as {
    handleIncomingBidirectionalStream: (s: WebTransportBidirectionalStream) => Promise<void>;
  };
  await handle.handleIncomingBidirectionalStream(stream);

  assert.isTrue(publishCalled);
});

/**
 * draft-ietf-moq-transport-19 §5.1.3:
 * TRACK_PROPERTY_FILTER を含まない SUBSCRIBE_TRACKS 由来の受信 PUBLISH は
 * フィルタ評価を通過して onPublish が呼ばれることを検証する。
 */
test("TRACK_PROPERTY_FILTER が無い場合は受信 PUBLISH が通過する", async () => {
  const session = createPublishReceiveSession();
  let publishCalled = false;
  registerTracksSubscription(session, 0n, {
    onPublish: () => {
      publishCalled = true;
      return { object: () => {} };
    },
  });

  const { stream, readableController } = createPublishStream([{ id: 0x30n, value: 0n }]);
  readableController.close();

  const handle = session as unknown as {
    handleIncomingBidirectionalStream: (s: WebTransportBidirectionalStream) => Promise<void>;
  };
  await handle.handleIncomingBidirectionalStream(stream);

  assert.isTrue(publishCalled);
});

/**
 * draft-ietf-moq-transport-19 §5.1.3:
 * 同一 namespace prefix に複数の SUBSCRIBE_TRACKS がマッチする場合、
 * 先に登録された subscription の TRACK_PROPERTY_FILTER を満たさなくても、
 * 後続の subscription が満たせば受理されることを検証する。
 * (matchPublishToSubscription はフィルタを通過する最初のマッチを返す)
 */
test("複数マッチ時に先勝ちの subscription がフィルタ不通過でも後続が通過すれば受理される", async () => {
  const session = createPublishReceiveSession();
  const calledSuffixes: string[] = [];
  // 先勝ち: フィルタ不通過 (0x30 = 2 を要求)
  registerTracksSubscription(
    session,
    0n,
    {
      onPublish: (suffix) => {
        calledSuffixes.push(`first:${suffix.join("/")}`);
        return { object: () => {} };
      },
    },
    [{ type: "trackProperty", setId: 0, propertyType: 0x30n, ranges: [{ start: 2n, end: 2n }] }],
  );
  // 後続: フィルタ通過 (0x30 = 1 を要求)
  registerTracksSubscription(
    session,
    2n,
    {
      onPublish: (suffix) => {
        calledSuffixes.push(`second:${suffix.join("/")}`);
        return { object: () => {} };
      },
    },
    [{ type: "trackProperty", setId: 0, propertyType: 0x30n, ranges: [{ start: 1n, end: 1n }] }],
  );

  const { stream, readableController } = createPublishStream([{ id: 0x30n, value: 1n }]);
  readableController.close();

  const handle = session as unknown as {
    handleIncomingBidirectionalStream: (s: WebTransportBidirectionalStream) => Promise<void>;
  };
  await handle.handleIncomingBidirectionalStream(stream);

  // 後続の subscription のみが受理される
  assert.deepEqual(calledSuffixes, ["second:video"]);
});

/**
 * draft-ietf-moq-transport-19 §5.1.3:
 * 同一 namespace prefix に複数の SUBSCRIBE_TRACKS がマッチする場合、
 * すべての subscription が TRACK_PROPERTY_FILTER を満たさなければ
 * UNINTERESTED で拒否されることを検証する。
 */
test("複数マッチ時にすべての subscription がフィルタ不通過なら UNINTERESTED で拒否される", async () => {
  const session = createPublishReceiveSession();
  let publishCalled = false;
  // 先勝ち: フィルタ不通過 (0x30 = 2 を要求)
  registerTracksSubscription(
    session,
    0n,
    {
      onPublish: () => {
        publishCalled = true;
        return { object: () => {} };
      },
    },
    [{ type: "trackProperty", setId: 0, propertyType: 0x30n, ranges: [{ start: 2n, end: 2n }] }],
  );
  // 後続: フィルタ不通過 (0x30 = 3 を要求)
  registerTracksSubscription(
    session,
    2n,
    {
      onPublish: () => {
        publishCalled = true;
        return { object: () => {} };
      },
    },
    [{ type: "trackProperty", setId: 0, propertyType: 0x30n, ranges: [{ start: 3n, end: 3n }] }],
  );

  const { stream, readableController, written } = createPublishStream([{ id: 0x30n, value: 1n }]);
  readableController.close();

  const handle = session as unknown as {
    handleIncomingBidirectionalStream: (s: WebTransportBidirectionalStream) => Promise<void>;
  };
  await handle.handleIncomingBidirectionalStream(stream);

  // onPublish は呼ばれず、REQUEST_ERROR (UNINTERESTED) が応答される
  assert.isFalse(publishCalled);
  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_ERROR);
  const decoded = decodeRequestErrorPayload(messages[0].payload);
  assert.equal(decoded.errorCode, BigInt(RequestErrorCode.UNINTERESTED));
});

/**
 * 受信 PUBLISH 処理が SubscriberImpl へ渡す Range Filter の glue を検証する。
 * SUBSCRIBE_TRACKS の rangeFilters が remove エントリを除いてそのまま
 * impl.setRangeFilters に渡されることを確認する (TRACK_PROPERTY_FILTER を
 * 含む。オブジェクト評価では evaluateRangeFilters が除外するため、保持して
 * も二重適用にならない)。remove は REQUEST_UPDATE の更新操作であり、
 * 評価対象ではないため保持しない。
 */
test("受信 PUBLISH は remove を除く Range Filter を SubscriberImpl に渡す", async () => {
  const session = createPublishReceiveSession();
  registerTracksSubscription(
    session,
    0n,
    {
      onPublish: () => {
        return { object: () => {} };
      },
    },
    [
      { type: "trackProperty", setId: 0, propertyType: 0x30n, ranges: [{ start: 1n, end: 1n }] },
      { type: "objectId", setId: 0, ranges: [{ start: 3n, end: 5n }] },
      { type: "objectId", remove: true },
    ],
  );

  const { stream, readableController } = createPublishStream([{ id: 0x30n, value: 1n }]);
  // ストリームは閉じずに PUBLISH 処理のみ完了させる (ループ終了で impl が
  // 削除されるのを防ぐ)

  const handle = session as unknown as {
    handleIncomingBidirectionalStream: (s: WebTransportBidirectionalStream) => Promise<void>;
  };
  const processing = handle.handleIncomingBidirectionalStream(stream);
  // 受信 PUBLISH 処理はマイクロタスクのみで完結する (reader.read / onPublish /
  // subscribers.set に macrotask 待ちがない) ため、1 回の macrotask 待ち
  // (setTimeout) で subscribers 登録まで到達済みになる
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 10);
  });

  // SubscriberImpl に渡されたフィルタを取得する (private フィールドへのテスト用アクセス)
  const internal = session as unknown as {
    subscribers: Map<bigint, { getRangeFilters: () => unknown }>;
  };
  const impl = internal.subscribers.get(3n);
  assert.isDefined(impl);
  assert.deepEqual(impl?.getRangeFilters(), [
    { type: "trackProperty", setId: 0, propertyType: 0x30n, ranges: [{ start: 1n, end: 1n }] },
    { type: "objectId", setId: 0, ranges: [{ start: 3n, end: 5n }] },
  ]);

  // ストリームを閉じて受信ループを終了させる
  readableController.close();
  await processing;
});

/**
 * draft-ietf-moq-transport-19 §5.1.3:
 * TRACK_PROPERTY_FILTER (SetID=0) と OBJECTID_FILTER (SetID=1) が混在する場合、
 * SetID 単位の AND / SetID 間 OR の結合規則が種別をまたいで適用される。
 * track 評価が不通過 (SetID 0) でも、objectId フィルタ (SetID 1) が存在する
 * ため PUBLISH は受理される (UNINTERESTED にしない) ことを検証する。
 * (オブジェクト評価での SetID 結合は filter.test.ts で検証済み)
 */
test("SetID 混在時は track 不通過でもオブジェクトフィルタの SetID があれば受理される", async () => {
  const session = createPublishReceiveSession();
  let publishCalled = false;
  registerTracksSubscription(
    session,
    0n,
    {
      onPublish: () => {
        publishCalled = true;
        return { object: () => {} };
      },
    },
    [
      // SetID 0: TRACK_PROPERTY_FILTER (0x30 = 1 を要求)
      { type: "trackProperty", setId: 0, propertyType: 0x30n, ranges: [{ start: 1n, end: 1n }] },
      // SetID 1: OBJECTID_FILTER (3-5 を要求)
      { type: "objectId", setId: 1, ranges: [{ start: 3n, end: 5n }] },
    ],
  );

  // PUBLISH は 0x30 = 0 (track 不通過) だが、SetID 1 の objectId フィルタが
  // 存在するため受理される
  const { stream, readableController } = createPublishStream([{ id: 0x30n, value: 0n }]);
  readableController.close();

  const handle = session as unknown as {
    handleIncomingBidirectionalStream: (s: WebTransportBidirectionalStream) => Promise<void>;
  };
  await handle.handleIncomingBidirectionalStream(stream);

  assert.isTrue(publishCalled);
});

/**
 * draft-ietf-moq-transport-19 §11.1:
 * 同一 Track Alias が異なる Track に使われている場合は DUPLICATE_TRACK_ALIAS
 * でセッション終了 (MUST)。TRACK_PROPERTY_FILTER 不通過の PUBLISH でも
 * 検証が行われることを検証する (alias 検証が match 判定より前に移動した
 * ことの回帰テスト)。
 */
test("フィルタ不通過の PUBLISH でも DUPLICATE_TRACK_ALIAS でセッションが閉じる", async () => {
  const errors: Error[] = [];
  const session = createPublishReceiveSession({ error: (err) => errors.push(err) });

  // 既に alias 1 が "live/video" に確立済みの状態を作る
  const internal = session as unknown as {
    subscribersByAlias: Map<bigint, { getFullTrackName: () => string }[]>;
  };
  internal.subscribersByAlias.set(1n, [{ getFullTrackName: () => "live/video" }]);

  // フィルタ不通過の subscription を登録する (0x30 = 1 を要求)
  registerTracksSubscription(
    session,
    0n,
    {
      onPublish: () => {
        return { object: () => {} };
      },
    },
    [{ type: "trackProperty", setId: 0, propertyType: 0x30n, ranges: [{ start: 1n, end: 1n }] }],
  );

  // 別の Track ("live/other") に alias 1 を使い、0x30 = 0 (フィルタ不通過)
  const { stream, readableController } = createPublishStream([{ id: 0x30n, value: 0n }]);
  readableController.close();

  const handle = session as unknown as {
    handleIncomingBidirectionalStream: (s: WebTransportBidirectionalStream) => Promise<void>;
  };
  await handle.handleIncomingBidirectionalStream(stream);

  // フィルタ不通過でも alias 検証が先に走り、DUPLICATE_TRACK_ALIAS でセッションが閉じる
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /track alias 0x1 used for different tracks/);
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
