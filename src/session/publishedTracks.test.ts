/**
 * src/session/publishedTracks.ts の単体テスト
 *
 * draft-ietf-moq-transport-23 §3.6 (Subscribing to Tracks by Prefix):
 * publisher 側のデータ面 (公開済み Track registry、受信 SUBSCRIBE_TRACKS への
 * 一致判定、結果 PUBLISH、PUBLISH_SKIPPED、複数 subscription への fan-out) を、
 * 実 SessionImpl と実 W3C Streams で検証する。
 *
 * セッション・WebTransport は src/testSupport/bidi.ts のテスト用実装を使い、
 * PublisherImpl / IncomingTracksSubscriptionState は本番と同じオブジェクトを
 * 直接組み立てる。モック / スタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SessionImpl, type ConnectCallbacks } from "../session";
import { ControlStreamReader, ControlStreamWriter } from "../controlStream";
import { MessageParameterType, MessageType, PublishDoneStatusCode } from "../message/types";
import { decodePublishPayload } from "../message/publish";
import { decodePublishSkippedPayload, encodeSubscribeTracksPayload } from "../message/namespace";
import {
  decodeRequestErrorPayload,
  encodeRequestErrorPayload,
  encodeRequestOkPayload,
} from "../message/session";
import { encodeRequestUpdatePayload } from "../message/subscribe";
import {
  createTrackNamespace,
  encodeLocationFilterParameter,
  encodeTrackNamespace,
  getParameterLocationValue,
  trackNamespaceToStrings,
  type Parameter,
  type RangeFilterSpec,
} from "../message/parameter";
import { decodeVarint } from "../varint";
import { RequestError, RequestErrorCode } from "../error";
import {
  AuthorizationTokenAliasType,
  encodeAuthorizationToken,
} from "../message/authorizationToken";
import { fullTrackNameKey } from "../fullTrackName";
import type { PublisherImpl } from "../publisher";
import { decodeObjectDatagram, decodeSubgroupHeader, SubgroupHeaderType } from "../dataStream";
import { buildSubscribeTracksParameters } from "./params";
import {
  asBidiSessionInternal,
  asIncomingPublishSessionInternal,
  createTestBidirectionalStream,
  createTestWebTransport,
  waitForCondition,
  waitForMacrotask,
  type TestBidirectionalStream,
} from "../testSupport/bidi";
import type { BidiSessionInternal } from "./bidi";
import type { IncomingTracksSubscriptionState } from "./types";
import {
  publishedTrackSendSkipped,
  publishedTracksHasMatch,
  publishedTracksOnSubscriptionAccepted,
} from "./publishedTracks";
import { incomingPublishHandleBidirectionalStream } from "./incomingPublish";

/**
 * テスト用セッションの構成
 *
 * testTransport は実 SessionImpl に渡した WebTransport の境界実装であり、
 * 生成された双方向 / 単方向ストリームの実 WritableStream の書き込みを観測する。
 */
interface PublishedTracksTestContext {
  impl: SessionImpl;
  session: BidiSessionInternal;
  testTransport: ReturnType<typeof createTestWebTransport>;
}

/**
 * 実 SessionImpl と実ストリームでテスト用セッションを構築する
 *
 * initialize() を呼ばずに controlWriter だけを設定する。requestsPublish 系は
 * controlWriter が無いとフレーミングできないため、bidi テストと同じ前提を置く。
 */
function createPublishedTracksTestContext(
  callbacks: ConnectCallbacks = {},
): PublishedTracksTestContext {
  const testTransport = createTestWebTransport();
  const impl = new SessionImpl(testTransport.transport, callbacks);
  impl.controlWriter = new ControlStreamWriter();
  return {
    impl,
    session: asBidiSessionInternal(impl),
    testTransport,
  };
}

/**
 * 双方向ストリームを添字で取り出す (存在しない場合はテスト失敗にする)
 */
function requireBidirectionalStream(
  context: PublishedTracksTestContext,
  index: number,
): TestBidirectionalStream {
  const stream = context.testTransport.bidirectionalStreams[index];
  if (stream === undefined) {
    throw new Error(
      `双方向ストリーム ${index} が存在しない: 生成数 ${context.testTransport.bidirectionalStreams.length}`,
    );
  }
  return stream;
}

/**
 * 実 WritableStream に書かれた制御メッセージ列をデコードする
 *
 * 書き込みはメッセージ単位で行われるため、到着順に連結して ControlStreamReader へ
 * 渡せばフレーミング済みのメッセージ列になる。
 */
function decodeWrittenMessages(stream: TestBidirectionalStream): {
  type: number;
  payload: Uint8Array;
}[] {
  if (stream.written.length === 0) {
    return [];
  }
  const totalLength = stream.written.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of stream.written) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new ControlStreamReader().feed(bytes);
}

/**
 * 指定した型の制御メッセージのうち最初の 1 通を返す
 */
function findWrittenMessage(
  stream: TestBidirectionalStream,
  messageType: number,
): { type: number; payload: Uint8Array } | undefined {
  return decodeWrittenMessages(stream).find((message) => message.type === messageType);
}

/**
 * 指定した型の制御メッセージをすべて返す
 */
function findWrittenMessages(
  stream: TestBidirectionalStream,
  messageType: number,
): { type: number; payload: Uint8Array }[] {
  return decodeWrittenMessages(stream).filter((message) => message.type === messageType);
}

/**
 * PUBLISH_OK (REQUEST_OK) をピアから受け取ったことにする
 *
 * 実 readable に実フレームを enqueue し、bidiReadPublishResponse に
 * 購読確立の処理をさせる。
 */
function feedPublishOk(stream: TestBidirectionalStream): void {
  const payload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [],
    trackProperties: [],
  });
  stream.readableController.enqueue(
    new ControlStreamWriter().encode(MessageType.REQUEST_OK, payload),
  );
}

/**
 * SUBSCRIBE_TRACKS_ID を持つ結果 PUBLISH が書かれた双方向ストリームを待つ
 *
 * 新しい公開 (Session.publish) は、登録処理の中で一致する受信 SUBSCRIBE_TRACKS へ
 * 結果 PUBLISH を送るため、公開の完了時点で結果 PUBLISH ストリームが既に
 * 生成されていることがある。生成順に依存せず、SUBSCRIBE_TRACKS_ID の有無で
 * アプリ自身の PUBLISH と区別する。
 */
async function waitForResultPublishStream(
  context: PublishedTracksTestContext,
  fromIndex: number,
): Promise<TestBidirectionalStream> {
  let found: TestBidirectionalStream | undefined;
  await waitForCondition(() => {
    for (
      let index = fromIndex;
      index < context.testTransport.bidirectionalStreams.length;
      index += 1
    ) {
      const stream = requireBidirectionalStream(context, index);
      let messages: { type: number; payload: Uint8Array }[];
      try {
        messages = decodeWrittenMessages(stream);
      } catch {
        continue;
      }
      for (const message of messages) {
        if (message.type !== MessageType.PUBLISH) {
          continue;
        }
        const decoded = decodePublishPayload(message.payload);
        if (
          findParameter(decoded.parameters, MessageParameterType.SUBSCRIBE_TRACKS_ID) !== undefined
        ) {
          found = stream;
          return true;
        }
      }
    }
    return false;
  }, "SUBSCRIBE_TRACKS_ID を持つ結果 PUBLISH ストリームが生成される");
  if (found === undefined) {
    throw new Error("結果 PUBLISH ストリームが見つからない");
  }
  return found;
}

/**
 * 指定した Request ID の PUBLISH が書かれた双方向ストリームを待つ
 *
 * アプリの Session.publish は非同期にストリームを生成する。同じ公開処理の中で
 * 受信 SUBSCRIBE_TRACKS への結果 PUBLISH も生成され得るため、生成順ではなく
 * フレーム化済み PUBLISH の Request ID でアプリ自身のストリームを特定する。
 */
async function waitForPublishStream(
  context: PublishedTracksTestContext,
  requestId: bigint,
  fromIndex: number,
): Promise<TestBidirectionalStream> {
  let found: TestBidirectionalStream | undefined;
  await waitForCondition(() => {
    for (
      let index = fromIndex;
      index < context.testTransport.bidirectionalStreams.length;
      index += 1
    ) {
      const stream = requireBidirectionalStream(context, index);
      let messages: { type: number; payload: Uint8Array }[];
      try {
        messages = decodeWrittenMessages(stream);
      } catch {
        // 書き込み途中のフレームはまだ判定できない
        continue;
      }
      for (const message of messages) {
        if (message.type !== MessageType.PUBLISH) {
          continue;
        }
        const decoded = decodePublishPayload(message.payload);
        if (decoded.requestId === requestId) {
          found = stream;
          return true;
        }
      }
    }
    return false;
  }, `Request ID ${requestId} の PUBLISH ストリームが生成される`);
  if (found === undefined) {
    throw new Error(`Request ID ${requestId} の PUBLISH ストリームが見つからない`);
  }
  return found;
}

/**
 * アプリの Session.publish を実行し、PUBLISH_OK を返して確立させる
 *
 * 実 SessionImpl.publish の送信経路 (requestsSendRequest) がストリームを生成する
 * のを待ち、そのストリームに PUBLISH_OK を feed する。戻り値は公開 API の
 * Publisher ではなく、内部状態を検証するための実 PublisherImpl である。
 */
async function publishTestTrack(
  context: PublishedTracksTestContext,
  namespace: string[],
  trackName: string,
  options?: Parameters<SessionImpl["publish"]>[3],
): Promise<PublisherImpl> {
  const streamCountBefore = context.testTransport.bidirectionalStreams.length;
  // requestsPublish は同期部で Request ID を採番する。呼び出し直後の nextRequestId を
  // 読むことで、アプリ自身の PUBLISH を結果 PUBLISH と取り違えない。
  const requestId = context.impl.nextRequestId;
  const promise = context.impl.publish(namespace, trackName, undefined, options);
  const publishStream = await waitForPublishStream(context, requestId, streamCountBefore);
  feedPublishOk(publishStream);
  const publisher = await promise;
  // 公開 API の戻り値は実 PublisherImpl である。publishedTracks の内部 API を
  // 検証するため、実装型として参照する (オブジェクトの偽装はしない)。
  return publisher as PublisherImpl;
}

/**
 * 受信 SUBSCRIBE_TRACKS の状態を実ストリーム付きで構築する
 *
 * 受信側ハンドラと同じ形で requestStreams に応答ストリームを登録し、
 * incomingTracksSubscriptions に状態を置く。応答ストリームの writer は
 * PUBLISH_SKIPPED の送信先として本番と同じものを渡す。
 */
function createIncomingTracksSubscription(
  context: PublishedTracksTestContext,
  requestId: bigint,
  namespacePrefix: string[],
  parameters: Parameter[] = [],
  rangeFilters: RangeFilterSpec[] = [],
  paused = false,
): { state: IncomingTracksSubscriptionState; responseStream: TestBidirectionalStream } {
  const responseStream = context.testTransport.createBidirectionalStream();
  const controlReader = new ControlStreamReader();
  context.impl.requestStreams.set(requestId, {
    stream: responseStream.stream,
    writer: responseStream.writer,
    controlReader,
  });
  const state: IncomingTracksSubscriptionState = {
    requestId,
    state: "active",
    namespacePrefix,
    writer: responseStream.writer,
    controlReader,
    parameters,
    paused,
    rangeFilters,
    publishedTracks: new Set(),
    publishSkipped: new Set(),
  };
  context.impl.incomingTracksSubscriptions.set(requestId, state);
  return { state, responseStream };
}

/**
 * 受信 SUBSCRIBE_TRACKS を受理し、生成された結果 PUBLISH ストリームを返す
 *
 * @param expectedCount - 期待する結果 PUBLISH の本数。0 の場合は非同期的な生成が
 *   無いことを確かめるためマクロタスクを回してから戻る。
 */
async function acceptSubscribeTracks(
  context: PublishedTracksTestContext,
  state: IncomingTracksSubscriptionState,
  expectedCount: number,
): Promise<TestBidirectionalStream[]> {
  const streamCountBefore = context.testTransport.bidirectionalStreams.length;
  publishedTracksOnSubscriptionAccepted(context.session, state);
  if (expectedCount === 0) {
    await waitForMacrotask();
    await waitForMacrotask();
    assert.equal(
      context.testTransport.bidirectionalStreams.length,
      streamCountBefore,
      "一致しない要求では結果 PUBLISH のストリームを生成しない",
    );
    return [];
  }
  await waitForCondition(
    () => context.testTransport.bidirectionalStreams.length === streamCountBefore + expectedCount,
    `結果 PUBLISH の双方向ストリームが ${expectedCount} 本生成される`,
  );
  const result: TestBidirectionalStream[] = [];
  for (let index = 0; index < expectedCount; index += 1) {
    result.push(requireBidirectionalStream(context, streamCountBefore + index));
  }
  return result;
}

/**
 * 結果 PUBLISH ストリームから PUBLISH の Request ID と Track Alias を取り出す
 */
function decodeResultPublish(
  stream: TestBidirectionalStream,
): ReturnType<typeof decodePublishPayload> {
  const message = findWrittenMessage(stream, MessageType.PUBLISH);
  if (message === undefined) {
    throw new Error("結果 PUBLISH ストリームに PUBLISH が書かれていない");
  }
  return decodePublishPayload(message.payload);
}

/**
 * 結果 PUBLISH に PUBLISH_OK を返して購読を確立し、実 PublisherImpl を返す
 */
async function establishResultPublish(
  context: PublishedTracksTestContext,
  stream: TestBidirectionalStream,
): Promise<PublisherImpl> {
  const decoded = decodeResultPublish(stream);
  feedPublishOk(stream);
  await waitForCondition(
    () => context.impl.publishers.has(decoded.requestId),
    `結果 PUBLISH の購読 (requestId=${decoded.requestId}) が確立する`,
  );
  const publisher = context.impl.publishers.get(decoded.requestId);
  if (publisher === undefined) {
    throw new Error(`結果 PUBLISH の Publisher が見つからない: requestId=${decoded.requestId}`);
  }
  // PUBLISH_OK の解決後に registry へ追加する処理 (Promise の .then) が走るのを待つ。
  // これを待たずに送信すると fan-out の対象に購読が入っていない。
  await waitForCondition(() => {
    for (const track of context.impl.publishedTracks.values()) {
      if (track.subscriptions.has(publisher)) {
        return true;
      }
    }
    return false;
  }, `結果 PUBLISH の購読 (requestId=${decoded.requestId}) が公開 Track registry に登録される`);
  return publisher;
}

/**
 * Parameter の一覧から指定 Type のものを取り出す
 */
function findParameter(parameters: Parameter[], parameterType: number): Parameter | undefined {
  return parameters.find((parameter) => parameter.type === parameterType);
}

/**
 * bigint の配列を昇順に並べ替える (Set 由来の値の比較用)
 */
function sortBigints(values: bigint[]): bigint[] {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** §3.6 / §9.5.2: 認可と更新の応答が成功した条件だけで再照合する。 */
test.each(["accepted", "rejected", "write-failed"] as const)(
  "SUBSCRIBE_TRACKS の prefix 更新は認可後に公開を反映する (%s)",
  async (outcome) => {
    let authorizationStarted = false;
    let finishAuthorization!: (decision: { accept: boolean }) => void;
    const authorization = new Promise<{ accept: boolean }>((resolve) => {
      finishAuthorization = resolve;
    });
    let finishAcknowledgment!: () => void;
    let failAcknowledgment!: (error: Error) => void;
    const acknowledgment = new Promise<void>((resolve, reject) => {
      finishAcknowledgment = resolve;
      failAcknowledgment = reject;
    });
    const context = createPublishedTracksTestContext({
      authorizeSubscribeTracks({ trackNamespacePrefix }) {
        if (trackNamespacePrefix[1] === "old") return { accept: true };
        assert.deepEqual(trackNamespacePrefix, ["current"]);
        authorizationStarted = true;
        return authorization;
      },
    });
    let writeCount = 0;
    const stream = createTestBidirectionalStream({
      async write() {
        writeCount++;
        if (writeCount === 2 && outcome !== "rejected") await acknowledgment;
      },
    });
    const writer = new ControlStreamWriter();
    stream.readableController.enqueue(
      writer.encode(
        MessageType.SUBSCRIBE_TRACKS,
        encodeSubscribeTracksPayload({
          type: MessageType.SUBSCRIBE_TRACKS,
          requestId: 1n,
          trackNamespacePrefix: createTrackNamespace(["current", "old"]),
          parameters: [],
        }),
      ),
    );
    await incomingPublishHandleBidirectionalStream(
      asIncomingPublishSessionInternal(context.impl),
      stream.stream,
    );
    const subscription = context.impl.incomingTracksSubscriptions.get(1n);
    assert.isDefined(subscription);

    const update = encodeRequestUpdatePayload({
      type: MessageType.REQUEST_UPDATE,
      requestId: 3n,
      parameters: [
        {
          type: MessageParameterType.TRACK_NAMESPACE_PREFIX,
          value: encodeTrackNamespace(createTrackNamespace(["current"])),
        },
        { type: MessageParameterType.PAUSED, value: Uint8Array.of(1) },
        // トークンを付けなくても、変更先の prefix は認可を要求する。
        ...(outcome !== "rejected"
          ? [
              {
                type: MessageParameterType.AUTHORIZATION_TOKEN,
                value: encodeAuthorizationToken({
                  aliasType: AuthorizationTokenAliasType.USE_VALUE,
                  tokenType: 1n,
                  tokenValue: Uint8Array.of(42),
                }),
              },
            ]
          : []),
      ],
    });
    stream.readableController.enqueue(writer.encode(MessageType.REQUEST_UPDATE, update));

    // 実際のアプリの公開を認可待ちと並行させる。新しい条件で派生 PUBLISH は作られない。
    await waitForCondition(
      () => authorizationStarted || stream.written.length === 2,
      "更新の処理が始まること",
    );
    assert.lengthOf(stream.written, 1, "応答は認可判定が完了するまで送らない");
    await publishTestTrack(context, ["current", "next"], "video");
    assert.deepEqual(subscription.namespacePrefix, ["current", "old"]);
    assert.isFalse(subscription.paused);
    assert.equal(context.impl.getStatistics().subscribeTracksPublishSent, 0);

    finishAuthorization({ accept: outcome !== "rejected" });
    await waitForCondition(() => stream.written.length === 2, "更新に対する応答が届くこと");
    const response = decodeWrittenMessages(stream)[1]!;
    if (outcome === "rejected") {
      assert.equal(response.type, MessageType.REQUEST_ERROR);
      assert.equal(
        decodeRequestErrorPayload(response.payload).errorCode,
        BigInt(RequestErrorCode.UNAUTHORIZED),
      );
    } else {
      assert.equal(response.type, MessageType.REQUEST_OK);
      // 書き込み待ちの間も確定済みの条件で照合する。
      assert.deepEqual(subscription.namespacePrefix, ["current", "old"]);
      assert.equal(context.impl.getStatistics().subscribeTracksPublishSent, 0);
      if (outcome === "accepted") {
        // REQUEST_OK より後にキューへ入る通知は、更新後の prefix を基準にする。
        publishedTrackSendSkipped(
          context.session,
          subscription,
          ["current", "old", "leaf"],
          "unavailable",
        );
        finishAcknowledgment();
        const result = decodeResultPublish(await waitForResultPublishStream(context, 0));
        assert.deepEqual(trackNamespaceToStrings(result.trackNamespace), ["current", "next"]);
        assert.deepEqual(
          findParameter(result.parameters, MessageParameterType.PAUSED)?.value,
          Uint8Array.of(1),
        );
        assert.equal(context.impl.getStatistics().subscribeTracksPublishSent, 1);
        const skipped = findWrittenMessage(stream, MessageType.PUBLISH_SKIPPED);
        assert.isDefined(skipped);
        assert.deepEqual(
          trackNamespaceToStrings(
            decodePublishSkippedPayload(skipped.payload).trackNamespaceSuffix,
          ),
          ["old", "leaf"],
        );
        return;
      }
      failAcknowledgment(new Error("更新応答を書き込めない"));
    }
    await waitForCondition(
      () => !context.impl.incomingTracksSubscriptions.has(1n),
      "更新を完了できなかった購読が閉じること",
    );
    assert.deepEqual(subscription.namespacePrefix, ["current", "old"]);
    assert.isFalse(subscription.paused);
    assert.equal(context.impl.getStatistics().subscribeTracksPublishSent, 0);
  },
);

/**
 * (a) Track Namespace Prefix の一致判定
 *
 * 複数の公開済み Track のうち、prefix に一致する Track にだけ結果 PUBLISH を
 * 送る。一致しない Track には PUBLISH も PUBLISH_SKIPPED も送らない。
 */
test("publishedTracks: Track Namespace Prefix に一致する Track にだけ結果 PUBLISH を送る", async () => {
  const context = createPublishedTracksTestContext();
  await publishTestTrack(context, ["ns"], "alpha");
  await publishTestTrack(context, ["other"], "beta");

  // 既定認可の一致判定は、公開済み Track の namespace 前方一致で行う。
  assert.isTrue(
    publishedTracksHasMatch(context.session, ["ns"]),
    "公開済み Track の prefix は一致する",
  );
  assert.isFalse(
    publishedTracksHasMatch(context.session, ["missing"]),
    "公開済み Track に一致しない prefix は既定認可で拒否される",
  );

  const { state } = createIncomingTracksSubscription(context, 11n, ["ns"]);
  const resultStreams = await acceptSubscribeTracks(context, state, 1);
  const resultStream = resultStreams[0];
  if (resultStream === undefined) {
    throw new Error("結果 PUBLISH ストリームが生成されていない");
  }
  const decoded = decodeResultPublish(resultStream);
  assert.deepEqual(
    trackNamespaceToStrings(decoded.trackNamespace),
    ["ns"],
    "prefix に一致する Track の namespace で PUBLISH を送る",
  );
  assert.equal(
    new TextDecoder().decode(decoded.trackName),
    "alpha",
    "prefix に一致する Track の Track Name で PUBLISH を送る",
  );
});

/**
 * (b) TRACK_PROPERTY_FILTER の評価
 *
 * draft-ietf-moq-transport-23 §3.6.1 / §3.3.2:
 * TRACK_PROPERTY_FILTER を通過しない Track には PUBLISH も PUBLISH_SKIPPED も
 * 送らない。通過する Track には PUBLISH を送る。
 */
test("publishedTracks: TRACK_PROPERTY_FILTER を通過しない Track には PUBLISH も PUBLISH_SKIPPED も送らない", async () => {
  const context = createPublishedTracksTestContext();
  // OBJECT_DELIVERY_TIMEOUT = 100 の Track Property を持つ Track を公開する。
  await publishTestTrack(context, ["ns"], "alpha", { deliveryTimeout: 100n });

  // 通過しないフィルタ: OBJECT_DELIVERY_TIMEOUT (0x02) が 200-300。
  const notMatchingFilters: RangeFilterSpec[] = [
    {
      type: "trackProperty",
      setId: 0,
      propertyType: 0x02n,
      ranges: [{ start: 200n, end: 300n }],
    },
  ];
  const notMatching = createIncomingTracksSubscription(
    context,
    10n,
    ["ns"],
    [],
    notMatchingFilters,
  );
  await acceptSubscribeTracks(context, notMatching.state, 0);
  assert.isTrue(
    notMatching.state.publishedTracks.size === 0 && notMatching.state.publishSkipped.size === 0,
    "フィルタ不通過の Track は PUBLISH も PUBLISH_SKIPPED も記録しない",
  );

  // 通過するフィルタ: OBJECT_DELIVERY_TIMEOUT (0x02) が 100-100。
  const matchingFilters: RangeFilterSpec[] = [
    {
      type: "trackProperty",
      setId: 0,
      propertyType: 0x02n,
      ranges: [{ start: 100n, end: 100n }],
    },
  ];
  const matching = createIncomingTracksSubscription(context, 13n, ["ns"], [], matchingFilters);
  const resultStreams = await acceptSubscribeTracks(context, matching.state, 1);
  assert.equal(resultStreams.length, 1, "フィルタを通過する Track には PUBLISH を送る");
});

test("publishedTracks: Track 条件と Object 条件の SetID を fan-out まで保持する", async () => {
  for (const objectOnlySet of [false, true]) {
    const context = createPublishedTracksTestContext();
    const application = await publishTestTrack(context, ["ns"], "alpha", { deliveryTimeout: 100n });
    const filters: RangeFilterSpec[] = [
      {
        type: "trackProperty",
        setId: 0,
        propertyType: 0x02n,
        ranges: [{ start: objectOnlySet ? 200n : 100n, end: objectOnlySet ? 200n : 100n }],
      },
      { type: "objectId", setId: 0, ranges: [{ start: 1n, end: 1n }] },
      ...(objectOnlySet
        ? []
        : [
            {
              type: "trackProperty" as const,
              setId: 1,
              propertyType: 0x02n,
              ranges: [{ start: 200n, end: 200n }],
            },
          ]),
      { type: "objectId", setId: 1, ranges: [{ start: 2n, end: 2n }] },
    ];
    // INCLUDE_PROPERTIES=0 でも元の Track 条件を評価する。純 Object の組は Track を拒否しない。
    const parameters = buildSubscribeTracksParameters({
      rangeFilters: filters,
      includeProperties: false,
    });
    const { state } = createIncomingTracksSubscription(context, 11n, ["ns"], parameters, filters);
    const streams = await acceptSubscribeTracks(context, state, 1);
    const stream = streams[0];
    assert.isDefined(stream);
    if (stream === undefined) throw new Error("結果 PUBLISH が生成されていない");
    assert.deepEqual(decodeResultPublish(stream).trackProperties, []);
    const derived = await establishResultPublish(context, stream);
    for (const objectId of [1, 2]) {
      await application.sendDatagram({ groupId: 0, objectId, payload: new Uint8Array([objectId]) });
    }
    await waitForCondition(
      () => context.testTransport.datagramChunks.length >= 3,
      "アプリの 2 件と条件に合う派生購読の 1 件が届く",
    );
    await waitForMacrotask();
    const delivered = context.testTransport.datagramChunks.map(
      (chunk) => decodeObjectDatagram(chunk)[0],
    );
    assert.equal(delivered.length, 3);
    assert.deepEqual(
      delivered
        .filter((object) => object.trackAlias === derived.getTrackAlias())
        .map((object) => object.objectId),
      [objectOnlySet ? 2n : 1n],
    );
  }
});

/**
 * (c) 結果 PUBLISH の parameter
 *
 * draft-ietf-moq-transport-23 §3.6.2 / §9.8 / §9.19.2 / §9.19.21 / §9.19.22:
 * - §9.8 の一覧にある SUBSCRIBE_TRACKS の parameter を載せる
 * - SUBSCRIBE_TRACKS_ID に受信 SUBSCRIBE_TRACKS の Request ID を載せる
 * - AUTHORIZATION_TOKEN と INCLUDE_PROPERTIES は載せない
 * - Range Filters / TRACK_PROPERTY_FILTER は載せない
 * - FILL_PARAMETERS は載せない (fill fetch ストリームを送る実装が無いため)
 * - INCLUDE_PROPERTIES=0 のときは Track Properties を空にする
 */
test("publishedTracks: 結果 PUBLISH に §9.8 の parameter と SUBSCRIBE_TRACKS_ID を載せる", async () => {
  const context = createPublishedTracksTestContext();
  await publishTestTrack(context, ["ns"], "alpha", {
    deliveryTimeout: 111n,
    subgroupDeliveryTimeout: 222n,
    maxCacheDuration: 333n,
    publisherPriority: 7,
  });

  const rangeFilters: RangeFilterSpec[] = [{ type: "objectId", setId: 0, ranges: [{ start: 0n }] }];
  const parameters = buildSubscribeTracksParameters({
    filter: { startGroup: 1n },
    deliveryTimeout: 444n,
    subgroupDeliveryTimeout: 555n,
    subscriberPriority: 8,
    groupOrder: "Descending",
    paused: true,
    fill: { fillTimeout: 999n },
    rangeFilters,
    includeProperties: false,
    authorizationToken: {
      aliasType: AuthorizationTokenAliasType.USE_VALUE,
      tokenType: 1n,
      tokenValue: new Uint8Array([0x01, 0x02]),
    },
  });
  const requestId = 11n;
  const { state } = createIncomingTracksSubscription(
    context,
    requestId,
    ["ns"],
    parameters,
    rangeFilters,
    true,
  );
  const resultStreams = await acceptSubscribeTracks(context, state, 1);
  const resultStream = resultStreams[0];
  if (resultStream === undefined) {
    throw new Error("結果 PUBLISH ストリームが生成されていない");
  }
  const decoded = decodeResultPublish(resultStream);

  // 結果 PUBLISH の送信開始を統計へ記録する (§3.6 の PUBLISH 送信数)。
  assert.equal(
    context.impl.getStatistics().subscribeTracksPublishSent,
    1,
    "結果 PUBLISH の送信数を統計へ加算する",
  );

  // SUBSCRIBE_TRACKS_ID は受信 SUBSCRIBE_TRACKS の Request ID である。
  const subscribeTracksId = findParameter(
    decoded.parameters,
    MessageParameterType.SUBSCRIBE_TRACKS_ID,
  );
  assert.isDefined(subscribeTracksId, "SUBSCRIBE_TRACKS_ID が結果 PUBLISH に載る");
  if (subscribeTracksId === undefined) {
    throw new Error("SUBSCRIBE_TRACKS_ID が無い");
  }
  const [decodedRequestId] = decodeVarint(subscribeTracksId.value);
  assert.equal(decodedRequestId, requestId, "SUBSCRIBE_TRACKS_ID は受信要求の Request ID である");

  // §9.8 の一覧にある subscription 初期条件の parameter が載る。
  for (const parameterType of [
    MessageParameterType.PAUSED,
    MessageParameterType.LOCATION_FILTER,
    MessageParameterType.GROUP_ORDER,
    MessageParameterType.OBJECT_DELIVERY_TIMEOUT,
    MessageParameterType.SUBGROUP_DELIVERY_TIMEOUT,
    MessageParameterType.SUBSCRIBER_PRIORITY,
  ]) {
    assert.isDefined(
      findParameter(decoded.parameters, parameterType),
      `parameter 0x${parameterType.toString(16)} が結果 PUBLISH に載る`,
    );
  }

  // §9.19.2 の MUST NOT: AUTHORIZATION_TOKEN は結果 PUBLISH にコピーしない。
  assert.isUndefined(
    findParameter(decoded.parameters, MessageParameterType.AUTHORIZATION_TOKEN),
    "AUTHORIZATION_TOKEN は結果 PUBLISH に載らない",
  );
  // §3.4: FILL_PARAMETERS を載せた PUBLISH は fill fetch ストリームを開く義務を
  // 負うが、結果 PUBLISH の送信経路は fill に対応していないため載せない。
  // 要求側は fill を指定しているが、結果 PUBLISH には引き継がない。
  assert.isUndefined(
    findParameter(decoded.parameters, MessageParameterType.FILL_PARAMETERS),
    "FILL_PARAMETERS は結果 PUBLISH に載らない",
  );
  // §9.19.22: INCLUDE_PROPERTIES は PUBLISH の parameter ではない。
  assert.isUndefined(
    findParameter(decoded.parameters, MessageParameterType.INCLUDE_PROPERTIES),
    "INCLUDE_PROPERTIES は結果 PUBLISH に載らない",
  );
  // Range Filters / TRACK_PROPERTY_FILTER は送信時の評価にだけ使う。
  for (const parameter of decoded.parameters) {
    assert.isFalse(
      parameter.type >= 0x25 && parameter.type <= 0x29,
      `Range Filter 0x${parameter.type.toString(16)} は結果 PUBLISH に載らない`,
    );
  }

  // INCLUDE_PROPERTIES=0 のため、結果 PUBLISH の Track Properties は空である。
  assert.deepEqual(
    decoded.trackProperties,
    [],
    "INCLUDE_PROPERTIES=0 のときは Track Properties を空にする",
  );

  // 派生 subscription の PublisherImpl には PAUSED と LOCATION_FILTER が反映される。
  const derivedPublisher = await establishResultPublish(context, resultStream);
  assert.isTrue(derivedPublisher.paused, "結果 PUBLISH の PAUSED=1 が購読状態に反映される");
  assert.deepEqual(
    derivedPublisher.getLocationFilter(),
    { startGroup: 1n },
    "LOCATION_FILTER が購読ごとの送信状態に反映される",
  );
});

/**
 * (d) 複数の SUBSCRIBE_TRACKS が同じ Track に一致する場合
 *
 * draft-ietf-moq-transport-23 §3.6:
 * 要求ごとに新しい PUBLISH を送り、SUBSCRIBE_TRACKS_ID で要求を対応付ける。
 * Track Alias は要求ごとに別の値を割り当てる。
 */
test("publishedTracks: 2 つの SUBSCRIBE_TRACKS が同じ Track に一致すると 2 本の PUBLISH を送る", async () => {
  const context = createPublishedTracksTestContext();
  await publishTestTrack(context, ["ns"], "alpha");

  const first = createIncomingTracksSubscription(context, 11n, ["ns"]);
  const second = createIncomingTracksSubscription(context, 13n, ["ns"]);
  const firstResults = await acceptSubscribeTracks(context, first.state, 1);
  const secondResults = await acceptSubscribeTracks(context, second.state, 1);

  const firstStream = firstResults[0];
  const secondStream = secondResults[0];
  if (firstStream === undefined || secondStream === undefined) {
    throw new Error("2 本の結果 PUBLISH ストリームが生成されていない");
  }
  const firstPublish = decodeResultPublish(firstStream);
  const secondPublish = decodeResultPublish(secondStream);

  const firstSubscribeTracksId = findParameter(
    firstPublish.parameters,
    MessageParameterType.SUBSCRIBE_TRACKS_ID,
  );
  const secondSubscribeTracksId = findParameter(
    secondPublish.parameters,
    MessageParameterType.SUBSCRIBE_TRACKS_ID,
  );
  assert.isDefined(firstSubscribeTracksId, "1 本目の PUBLISH に SUBSCRIBE_TRACKS_ID が載る");
  assert.isDefined(secondSubscribeTracksId, "2 本目の PUBLISH に SUBSCRIBE_TRACKS_ID が載る");
  if (firstSubscribeTracksId === undefined || secondSubscribeTracksId === undefined) {
    throw new Error("SUBSCRIBE_TRACKS_ID が無い");
  }
  assert.equal(decodeVarint(firstSubscribeTracksId.value)[0], 11n, "1 本目は要求 11 に対応する");
  assert.equal(decodeVarint(secondSubscribeTracksId.value)[0], 13n, "2 本目は要求 13 に対応する");
  assert.notEqual(
    firstPublish.trackAlias,
    secondPublish.trackAlias,
    "要求ごとに別の Track Alias を割り当てる",
  );
  assert.notEqual(
    firstPublish.requestId,
    secondPublish.requestId,
    "要求ごとに別の Request ID を割り当てる",
  );
});

/**
 * (e) fan-out が購読ごとの PAUSED / Location Filter を評価する
 *
 * draft-ietf-moq-transport-23 §3.1 / §3.3.1:
 * アプリの Publisher.sendObject / sendDatagram は、その Track の全 subscription の
 * うち PAUSED でなく Location Filter を通る subscription にだけ送る。
 * このテストでは 3 つの派生 subscription のうち 1 つだけが送信対象になることを、
 * 生成された単方向ストリームと datagram の数と Track Alias で確かめる。
 */
test("publishedTracks: fan-out が購読ごとの PAUSED と Location Filter を評価する", async () => {
  const context = createPublishedTracksTestContext();
  const applicationPublisher = await publishTestTrack(context, ["ns"], "alpha");

  // 購読 1: 通常の購読。Object / Datagram を受け取る。
  const normal = createIncomingTracksSubscription(context, 11n, ["ns"]);
  // 購読 2: PAUSED=1。Object / Datagram を受け取らない。
  const paused = createIncomingTracksSubscription(context, 13n, ["ns"], [], [], true);
  // 購読 3: Location Filter が Group 10 から。Group 0 の Object は範囲外。
  const filtered = createIncomingTracksSubscription(context, 15n, ["ns"]);
  filtered.state.parameters = buildSubscribeTracksParameters({
    filter: { startGroup: 10n, startObject: 0n },
  });

  // 購読 4: OBJECTID_FILTER が Object 10 から。Object 0 は不通過。
  const rangeFiltered = createIncomingTracksSubscription(
    context,
    17n,
    ["ns"],
    [],
    [{ type: "objectId", setId: 0, ranges: [{ start: 10n }] }],
  );

  const normalResult = await acceptSubscribeTracks(context, normal.state, 1);
  const pausedResult = await acceptSubscribeTracks(context, paused.state, 1);
  const filteredResult = await acceptSubscribeTracks(context, filtered.state, 1);
  const rangeFilteredResult = await acceptSubscribeTracks(context, rangeFiltered.state, 1);
  const normalPublisher = await establishResultPublish(
    context,
    normalResult[0] as TestBidirectionalStream,
  );
  const pausedPublisher = await establishResultPublish(
    context,
    pausedResult[0] as TestBidirectionalStream,
  );
  const filteredPublisher = await establishResultPublish(
    context,
    filteredResult[0] as TestBidirectionalStream,
  );
  const rangeFilteredPublisher = await establishResultPublish(
    context,
    rangeFilteredResult[0] as TestBidirectionalStream,
  );

  // 購読ごとの PublisherImpl が registry に登録されている。
  const track = context.session.publishedTracks.get(fullTrackNameKey(["ns"], "alpha"));
  assert.isDefined(track, "公開済み Track が registry に登録されている");
  assert.equal(
    track?.subscriptions.size,
    5,
    "アプリ 1 + 派生 4 の subscription が registry にある",
  );

  // Object を送る。アプリ自身と購読 1 の 2 本だけが単方向ストリームを開く。
  await applicationPublisher.sendObject({
    groupId: 0,
    objectId: 0,
    payload: new Uint8Array([0xaa]),
  });
  await waitForCondition(
    () => context.testTransport.unidirectionalStreams.length === 2,
    "PAUSED でも Location Filter 範囲外でもない 2 つの購読にだけ Object を送る",
  );
  assert.isTrue(pausedPublisher.paused, "購読 2 は paused のままである");
  assert.isTrue(
    normalPublisher.getTrackAlias() !== pausedPublisher.getTrackAlias(),
    "購読ごとに別の Track Alias を割り当てる",
  );
  assert.isTrue(
    normalPublisher.getTrackAlias() !== filteredPublisher.getTrackAlias(),
    "購読ごとに別の Track Alias を割り当てる",
  );
  assert.isTrue(
    normalPublisher.getTrackAlias() !== rangeFilteredPublisher.getTrackAlias(),
    "購読ごとに別の Track Alias を割り当てる",
  );

  // 単方向ストリームの Subgroup Header から、送信先の Track Alias を確認する。
  const openedAliases = new Set<bigint>();
  for (const record of context.testTransport.unidirectionalStreams) {
    const firstWrite = record.writes[0];
    if (firstWrite === undefined) {
      continue;
    }
    const [header] = decodeSubgroupHeader(firstWrite);
    openedAliases.add(header.trackAlias);
  }
  assert.deepEqual(
    sortBigints([...openedAliases]),
    sortBigints([applicationPublisher.getTrackAlias(), normalPublisher.getTrackAlias()]),
    "Object はアプリ自身と購読 1 にだけ届く",
  );

  // Datagram も同じ subscription 集合にだけ送る。
  await applicationPublisher.sendDatagram({
    groupId: 0,
    objectId: 1,
    payload: new Uint8Array([0xbb]),
  });
  await waitForCondition(
    () => context.testTransport.datagramChunks.length === 2,
    "fan-out の Datagram が 2 つの購読にだけ送られる",
  );
  const datagramAliases = new Set<bigint>();
  for (const chunk of context.testTransport.datagramChunks) {
    const [datagram] = decodeObjectDatagram(chunk);
    datagramAliases.add(datagram.trackAlias);
  }
  assert.deepEqual(
    sortBigints([...datagramAliases]),
    sortBigints([applicationPublisher.getTrackAlias(), normalPublisher.getTrackAlias()]),
    "Datagram はアプリ自身と購読 1 にだけ届く",
  );
});

/** §9.19.17: 後から追加した購読でも、公開済み Track の最大位置を通知する。 */
test("publishedTracks: 結果 PUBLISH と相対フィルタは公開 Track の Largest Object を共有する", async () => {
  const context = createPublishedTracksTestContext();
  const application = await publishTestTrack(context, ["ns"], "alpha");
  await application.sendObject({ groupId: 7, objectId: 3, payload: Uint8Array.of(1) });
  // 既に公開された Track に対して新しい購読を確立する。
  const late = createIncomingTracksSubscription(
    context,
    11n,
    ["ns"],
    [encodeLocationFilterParameter({ nextObject: true })],
  );
  const [stream] = await acceptSubscribeTracks(context, late.state, 1);
  if (stream === undefined) throw new Error("結果 PUBLISH が見つからない");
  const publish = decodeResultPublish(stream);
  const largest = findParameter(publish.parameters, MessageParameterType.LARGEST_OBJECT);
  assert.deepEqual(largest && getParameterLocationValue(largest), { group: 7n, object: 3n });

  const derived = await establishResultPublish(context, stream);
  assert.deepEqual(derived.getResolvedLocationFilter()?.start, { group: 7n, object: 4n });
  derived.setPaused(true);
  await application.sendDatagram({ groupId: 8, objectId: 2, payload: Uint8Array.of(2) });
  // 停止中の購読への配送がなくても、Track の最大位置は両方の購読から見える。
  assert.deepEqual(derived.getLargestLocation(), { group: 8n, object: 2n });
  await application.done();
});

/**
 * (g) Group の途中から確立した subscription への fan-out
 *
 * draft-ietf-moq-transport-23 §7.1 / §12.1:
 * 同じ Track の同じ (Group, Object) を複数の PUBLISH subscription へ送るとき、
 * Subgroup ID / Publisher Priority が subscription 間で食い違うと、relay は
 * その Track を Malformed として扱い PUBLISH_DONE (MALFORMED_TRACK) を送る。
 * Group の途中から確立した subscription は、Track で最初に開いた Subgroup ID を
 * EXPLICIT_EXT で明示し、Priority も Track で固定した値を使わなければならない。
 */
test("publishedTracks: Group の途中から確立した subscription は同じ Subgroup ID / Priority で fan-out を受ける", async () => {
  const context = createPublishedTracksTestContext();
  const applicationPublisher = await publishTestTrack(context, ["ns"], "alpha");

  // Object 0 を送って、Track の Subgroup 0 / Publisher Priority 7 を確定する。
  await applicationPublisher.sendObject({
    groupId: 0,
    objectId: 0,
    payload: new Uint8Array([0x00]),
    priority: 7,
  });
  await waitForCondition(
    () => context.testTransport.unidirectionalStreams.length === 1,
    "アプリ自身の subscription が Subgroup ストリームを開く",
  );

  // 同じ Group の途中で SUBSCRIBE_TRACKS の結果 PUBLISH を確立する。
  // この時点では既に Object 0 を送っているため、確立後は Group の途中からになる。
  const late = createIncomingTracksSubscription(context, 11n, ["ns"]);
  const lateResult = await acceptSubscribeTracks(context, late.state, 1);
  const latePublisher = await establishResultPublish(
    context,
    lateResult[0] as TestBidirectionalStream,
  );

  // Object 1 を、Subgroup を開いたときと違う Priority を指定して送る。
  // wire に載る Priority は Track で固定した 7 のままでなければならない
  // (§5.1.1: 1 つの Subgroup は 1 つの Publisher Priority を持つ)。
  await applicationPublisher.sendObject({
    groupId: 0,
    objectId: 1,
    payload: new Uint8Array([0x01]),
    priority: 200,
  });
  await waitForCondition(
    () => context.testTransport.unidirectionalStreams.length === 2,
    "Group の途中から確立した subscription も同じ Group の Object を受ける",
  );

  // 各 subscription の Subgroup Header を Track Alias で引く。
  const headerByAlias = new Map<bigint, ReturnType<typeof decodeSubgroupHeader>[0]>();
  for (const record of context.testTransport.unidirectionalStreams) {
    const firstWrite = record.writes[0];
    if (firstWrite === undefined) {
      continue;
    }
    const [header] = decodeSubgroupHeader(firstWrite);
    headerByAlias.set(header.trackAlias, header);
  }
  const applicationHeader = headerByAlias.get(applicationPublisher.getTrackAlias());
  const lateHeader = headerByAlias.get(latePublisher.getTrackAlias());
  assert.isDefined(applicationHeader, "アプリ自身の subscription の Header がある");
  assert.isDefined(lateHeader, "途中から確立した subscription の Header がある");

  // アプリ自身は先頭 Object 0 から Subgroup を開いたため、FIRST_OBJ_EXT に
  // FIRST_OBJECT ビットが付く。
  assert.equal(applicationHeader?.type, SubgroupHeaderType.FIRST_OBJ_EXT_FIRST);
  assert.isUndefined(
    applicationHeader?.subgroupId,
    "FIRST_OBJ_EXT は Subgroup ID をフィールドに持たない",
  );
  // 途中から確立した subscription は Subgroup ID 0 を明示する EXPLICIT_EXT を使う。
  // FIRST_OBJECT ビットは、そのストリームの先頭 Object が Subgroup の最初の
  // Object ではないため立てない (§2.2)。
  assert.equal(lateHeader?.type, SubgroupHeaderType.EXPLICIT_EXT);
  assert.equal(lateHeader?.subgroupId, 0n, "Track 共通の Subgroup ID 0 を明示する");
  assert.isFalse(lateHeader?.firstObject, "Subgroup の先頭 Object ではない");
  // Priority はどちらの subscription も Track で固定した 7 になる。
  assert.equal(applicationHeader?.publisherPriority, 7);
  assert.equal(lateHeader?.publisherPriority, 7, "Track で固定した Priority を共有する");

  // Datagram も Subscription 間で Priority を食い違わせない (§7.1)。
  // Datagram は Subgroup を持たないため、Priority だけを比べる。
  await applicationPublisher.sendDatagram({
    groupId: 0,
    objectId: 2,
    payload: new Uint8Array([0x02]),
    priority: 9,
  });
  await waitForCondition(
    () => context.testTransport.datagramChunks.length === 2,
    "Datagram が 2 つの subscription へ届く",
  );
  const datagramPriorities = context.testTransport.datagramChunks.map(
    (chunk) => decodeObjectDatagram(chunk)[0].publisherPriority,
  );
  assert.deepEqual(datagramPriorities, [9, 9], "Datagram の Priority も subscription 間で一致する");
});

/**
 * (f)(h) 同じ Full Track Name の registry 共有と、最後の Publisher の終了
 *
 * draft-ietf-moq-transport-23 §3.1.1 / §3.6:
 * 同じ Full Track Name を複数回 publish しても 1 つの PublishedTrackState を共有する。
 * Publisher.done() はその Publisher の PUBLISH subscription だけを閉じ、
 * 最後の Publisher が終了したら SUBSCRIBE_TRACKS 由来の subscription にも
 * PUBLISH_DONE (TRACK_ENDED) を送って registry から削除する。
 */
test("publishedTracks: 複数 publish で registry を共有し、最後の Publisher の終了で派生 subscription を閉じる", async () => {
  const context = createPublishedTracksTestContext();
  // TextEncoder が同じバイト列にする 2 つの名前は、registry と prefix 照合を共有する。
  const wireNamespace = ["ns\uFFFD"];
  const firstPublisher = await publishTestTrack(context, ["ns\uD800"], "alpha");
  const secondPublisher = await publishTestTrack(context, wireNamespace, "alpha");

  const key = fullTrackNameKey(wireNamespace, "alpha");
  const track = context.session.publishedTracks.get(key);
  assert.isDefined(track, "同じ Full Track Name の registry エントリがある");
  assert.equal(track?.publishers.size, 2, "2 回の publish が同じ PublishedTrackState を共有する");
  assert.strictEqual(
    track,
    context.session.publishedTracks.get(key),
    "2 回目の publish でも同じ registry エントリを引ける",
  );

  const incoming = createIncomingTracksSubscription(context, 11n, wireNamespace);
  const resultStreams = await acceptSubscribeTracks(context, incoming.state, 1);
  const resultStream = resultStreams[0];
  if (resultStream === undefined) {
    throw new Error("結果 PUBLISH ストリームが生成されていない");
  }
  const derivedPublisher = await establishResultPublish(context, resultStream);
  assert.equal(
    track?.subscriptions.size,
    3,
    "アプリ 2 + 派生 1 の subscription が registry にある",
  );

  // 1 つ目の Publisher.done() では registry も派生 subscription も維持する。
  await firstPublisher.done();
  const remainingTrack = context.session.publishedTracks.get(key);
  assert.isDefined(remainingTrack, "Publisher が残っている間は registry を維持する");
  assert.isFalse(
    remainingTrack?.publishers.has(firstPublisher) === true,
    "終了した Publisher は publishers から外れる",
  );
  assert.equal(
    derivedPublisher.state,
    "active",
    "最後の Publisher が終了するまで派生 subscription は active である",
  );

  // 最後の Publisher.done() で派生 subscription に PUBLISH_DONE を送る。
  await secondPublisher.done();
  assert.isUndefined(
    context.session.publishedTracks.get(key),
    "最後の Publisher の終了で registry から削除する",
  );
  assert.equal(derivedPublisher.state, "closed", "派生 subscription は closed になる");
  const doneMessage = findWrittenMessage(resultStream, MessageType.PUBLISH_DONE);
  assert.isDefined(doneMessage, "派生 subscription のストリームに PUBLISH_DONE が書かれる");
  if (doneMessage !== undefined) {
    const statusCode = decodeVarint(doneMessage.payload)[0];
    assert.equal(
      statusCode,
      BigInt(PublishDoneStatusCode.TRACK_ENDED),
      "派生 subscription の PUBLISH_DONE は TRACK_ENDED である",
    );
  }
  assert.isTrue(
    resultStream.events.includes("close"),
    "PUBLISH_DONE の後にストリームを FIN で閉じる",
  );
});

/**
 * (g) PUBLISH_SKIPPED の Track Namespace Suffix と再 PUBLISH の抑止
 *
 * draft-ietf-moq-transport-23 §3.6.3 / §9.18:
 * - Suffix は要求の prefix を除いた部分
 * - PUBLISH_SKIPPED を送った Track には、アプリが新たに公開するまで PUBLISH を送らない
 * - アプリが新たに公開したら、PUBLISH_SKIPPED の抑止を解除して PUBLISH を送る
 */
test("publishedTracks: PUBLISH_SKIPPED の Suffix を送り、新しい公開まで PUBLISH を抑止する", async () => {
  const context = createPublishedTracksTestContext();
  await publishTestTrack(context, ["ns", "child"], "track");
  const incoming = createIncomingTracksSubscription(context, 11n, ["ns"]);

  publishedTrackSendSkipped(context.session, incoming.state, ["ns", "child"], "track");
  // 更新の反映で公開済み Track を再照合しても、書き込み中の通知と PUBLISH を重ねない。
  publishedTracksOnSubscriptionAccepted(context.session, incoming.state);
  assert.isEmpty(incoming.state.publishedTracks);
  await waitForCondition(
    () => incoming.responseStream.written.length > 0,
    "PUBLISH_SKIPPED が応答ストリームへ書き込まれる",
  );
  const skipMessage = findWrittenMessage(incoming.responseStream, MessageType.PUBLISH_SKIPPED);
  assert.isDefined(skipMessage, "応答ストリームに PUBLISH_SKIPPED が書かれる");
  if (skipMessage === undefined) {
    throw new Error("PUBLISH_SKIPPED が無い");
  }
  const decodedSkip = decodePublishSkippedPayload(
    skipMessage.payload,
    0,
    createTrackNamespace(["ns"]),
  );
  assert.deepEqual(
    trackNamespaceToStrings(decodedSkip.trackNamespaceSuffix),
    ["child"],
    "Track Namespace Suffix は要求の prefix を除いた部分である",
  );
  assert.equal(
    new TextDecoder().decode(decodedSkip.trackName),
    "track",
    "PUBLISH_SKIPPED の Track Name は公開対象の Track Name である",
  );
  const skippedKey = fullTrackNameKey(["ns", "child"], "track");
  assert.isTrue(
    incoming.state.publishSkipped.has(skippedKey),
    "PUBLISH_SKIPPED を送った Full Track Name を記録する",
  );

  // アプリが新たに公開するまでは、同じ要求を再受理しても PUBLISH を送らない。
  await acceptSubscribeTracks(context, incoming.state, 0);
  assert.isTrue(
    incoming.state.publishSkipped.has(skippedKey),
    "新しい公開まで PUBLISH_SKIPPED の記録を維持する",
  );

  // アプリがその Track を新たに公開すると、PUBLISH_SKIPPED の抑止が解除され PUBLISH を送る。
  // 新しい公開の登録処理が受信 SUBSCRIBE_TRACKS への結果 PUBLISH も開始する。
  const streamCountBeforePublish = context.testTransport.bidirectionalStreams.length;
  await publishTestTrack(context, ["ns", "child"], "track");
  assert.isFalse(
    incoming.state.publishSkipped.has(skippedKey),
    "新しい公開で PUBLISH_SKIPPED の記録を消す",
  );
  assert.isTrue(
    incoming.state.publishedTracks.has(skippedKey),
    "新しい公開では派生 subscription へ PUBLISH を送る",
  );
  const resultStream = await waitForResultPublishStream(context, streamCountBeforePublish);
  assert.equal(
    findWrittenMessages(resultStream, MessageType.PUBLISH).length,
    1,
    "新しい公開で結果 PUBLISH を 1 本送る",
  );

  // 同じ要求で同じ Track を再 PUBLISH しない (§9.5.2)。
  await acceptSubscribeTracks(context, incoming.state, 0);
  assert.equal(
    findWrittenMessages(resultStream, MessageType.PUBLISH).length,
    1,
    "同じ SUBSCRIBE_TRACKS で同じ Track を再 PUBLISH しない",
  );
});

/**
 * (g) 結果 PUBLISH のフレーミングに失敗した場合の PUBLISH_SKIPPED
 *
 * draft-ietf-moq-transport-23 §3.6.3:
 * PUBLISH を送れない場合 (フレーミングの同期失敗) は、応答ストリームへ
 * PUBLISH_SKIPPED を送り、以後その要求について PUBLISH を送らない。
 * controlWriter のメッセージ上限を PUBLISH より大きく PUBLISH_SKIPPED より
 * 小さく設定し、フレーミングの失敗を実際の送信経路で起こす。
 */
test("publishedTracks: 結果 PUBLISH をフレーミングできなければ PUBLISH_SKIPPED を送る", async () => {
  const context = createPublishedTracksTestContext();
  await publishTestTrack(context, ["ns"], "track", { deliveryTimeout: 111n });

  const incoming = createIncomingTracksSubscription(context, 11n, ["ns"]);
  const controlWriter = context.impl.controlWriter;
  if (controlWriter === undefined) {
    throw new Error("controlWriter が設定されていない");
  }
  // PUBLISH のフレーム (namespace / Track Name / Track Properties を含む) は
  // 12 バイトを超え、PUBLISH_SKIPPED のフレーム (空 suffix + Track Name) は
  // 12 バイト以下になる上限を設定する。
  controlWriter.setMaxMessageSize(12);
  try {
    const streamCountBefore = context.testTransport.bidirectionalStreams.length;
    publishedTracksOnSubscriptionAccepted(context.session, incoming.state);
    await waitForMacrotask();
    assert.equal(
      context.testTransport.bidirectionalStreams.length,
      streamCountBefore,
      "フレーミングに失敗した PUBLISH は双方向ストリームを開かない",
    );
    const skipMessage = findWrittenMessage(incoming.responseStream, MessageType.PUBLISH_SKIPPED);
    assert.isDefined(skipMessage, "代わりに PUBLISH_SKIPPED を応答ストリームへ書く");
    assert.isTrue(
      incoming.state.publishSkipped.has(fullTrackNameKey(["ns"], "track")),
      "PUBLISH を送れなかった Track を PUBLISH_SKIPPED として記録する",
    );
  } finally {
    controlWriter.setMaxMessageSize(Number.MAX_SAFE_INTEGER);
  }
});

/**
 * peer cancel はその subscription だけを閉じる
 *
 * draft-ietf-moq-transport-23 §3.1.2 / §3.6:
 * 派生 subscription のピアキャンセル (RESET_STREAM) では、その subscription だけを
 * registry から外し、同じ Track のアプリ subscription と他の派生 subscription は
 * 維持する。
 */
test("publishedTracks: 派生 subscription の peer cancel はその subscription だけを閉じる", async () => {
  const context = createPublishedTracksTestContext();
  const applicationPublisher = await publishTestTrack(context, ["ns"], "alpha");

  const first = createIncomingTracksSubscription(context, 11n, ["ns"]);
  const second = createIncomingTracksSubscription(context, 13n, ["ns"]);
  const firstResults = await acceptSubscribeTracks(context, first.state, 1);
  const secondResults = await acceptSubscribeTracks(context, second.state, 1);
  const firstStream = firstResults[0];
  const secondStream = secondResults[0];
  if (firstStream === undefined || secondStream === undefined) {
    throw new Error("結果 PUBLISH ストリームが生成されていない");
  }
  const firstPublisher = await establishResultPublish(context, firstStream);
  const secondPublisher = await establishResultPublish(context, secondStream);

  // ピアの RESET_STREAM 相当 (source: "stream" の reject) を readable に起こす。
  firstStream.readableController.error(
    Object.assign(new Error("stream reset by peer"), { source: "stream" }),
  );
  await waitForCondition(
    () => firstPublisher.state === "closed",
    "peer cancel された派生 subscription が closed になる",
  );

  const track = context.session.publishedTracks.get(fullTrackNameKey(["ns"], "alpha"));
  assert.isDefined(track, "同じ Track の registry は残る");
  assert.isFalse(
    track?.subscriptions.has(firstPublisher) === true,
    "peer cancel された derived subscription は registry から外れる",
  );
  assert.isTrue(
    track?.subscriptions.has(applicationPublisher) === true,
    "アプリの subscription は維持される",
  );
  assert.isTrue(
    track?.subscriptions.has(secondPublisher) === true,
    "他の派生 subscription も維持される",
  );
});

/**
 * アプリ Publisher の peer cancel は最後の Publisher の終了として扱う
 *
 * draft-ietf-moq-transport-23 §3.1.2 / §3.6:
 * アプリの PUBLISH subscription が peer にキャンセルされた場合も、その
 * Full Track Name の最後の Publisher が終了したものとして扱い、SUBSCRIBE_TRACKS
 * 由来の subscription を PUBLISH_DONE で閉じて registry から削除する。
 */
test("publishedTracks: アプリ Publisher の peer cancel で派生 subscription を閉じる", async () => {
  const context = createPublishedTracksTestContext();
  const applicationPublisher = await publishTestTrack(context, ["ns"], "alpha");
  const incoming = createIncomingTracksSubscription(context, 11n, ["ns"]);
  const resultStreams = await acceptSubscribeTracks(context, incoming.state, 1);
  const resultStream = resultStreams[0];
  if (resultStream === undefined) {
    throw new Error("結果 PUBLISH ストリームが生成されていない");
  }
  const derivedPublisher = await establishResultPublish(context, resultStream);

  // アプリの PUBLISH ストリームを Request ID から特定し、ピアの RESET_STREAM
  // 相当 (source: "stream" の reject) を readable に起こす。
  const applicationStream = await waitForPublishStream(
    context,
    applicationPublisher.getRequestId(),
    0,
  );
  applicationStream.readableController.error(
    Object.assign(new Error("stream reset by peer"), { source: "stream" }),
  );
  await waitForCondition(
    () => applicationPublisher.state === "closed",
    "peer cancel されたアプリ Publisher が closed になる",
  );
  await waitForCondition(
    () => derivedPublisher.state === "closed",
    "最後の Publisher の終了として派生 subscription も閉じる",
  );
  assert.isUndefined(
    context.session.publishedTracks.get(fullTrackNameKey(["ns"], "alpha")),
    "最後の Publisher の終了で registry から削除する",
  );
  const doneMessage = findWrittenMessage(resultStream, MessageType.PUBLISH_DONE);
  assert.isDefined(doneMessage, "派生 subscription に PUBLISH_DONE を送る");
  if (doneMessage !== undefined) {
    const statusCode = decodeVarint(doneMessage.payload)[0];
    assert.equal(
      statusCode,
      BigInt(PublishDoneStatusCode.TRACK_ENDED),
      "peer cancel で閉じる派生 subscription は TRACK_ENDED である",
    );
  }
});

/**
 * draft-ietf-moq-transport-23 §3.6 / §9.5.2:
 * アプリの PUBLISH が PUBLISH_ERROR (REQUEST_ERROR) で拒否された場合、
 * その subscription を公開 Track registry から解除する。確立できなかった
 * subscription を registry に残すと、以後の Object fan-out の対象になってしまう。
 */
test("publishedTracks: アプリ PUBLISH の PUBLISH_ERROR で registry から解除する", async () => {
  const context = createPublishedTracksTestContext();
  const key = fullTrackNameKey(["ns"], "alpha");
  const streamCountBefore = context.testTransport.bidirectionalStreams.length;
  const requestId = context.impl.nextRequestId;
  const publishPromise = context.impl.publish(["ns"], "alpha");
  const publishStream = await waitForPublishStream(context, requestId, streamCountBefore);
  assert.isDefined(
    context.session.publishedTracks.get(key),
    "PUBLISH の送信開始時点で registry に登録する",
  );

  // PUBLISH_ERROR (REQUEST_ERROR) を実 readable へ enqueue する。
  const errorPayload = encodeRequestErrorPayload({
    type: MessageType.REQUEST_ERROR,
    errorCode: BigInt(RequestErrorCode.NOT_SUPPORTED),
    retryInterval: 0n,
    reasonPhrase: "publish is not supported",
  });
  publishStream.readableController.enqueue(
    new ControlStreamWriter().encode(MessageType.REQUEST_ERROR, errorPayload),
  );

  const rejection = await publishPromise.then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.instanceOf(rejection, RequestError, "PUBLISH の Promise は PUBLISH_ERROR で reject する");
  await waitForCondition(
    () => context.session.publishedTracks.get(key) === undefined,
    "PUBLISH_ERROR で registry から解除されること",
  );
});

/**
 * draft-ietf-moq-transport-23 §3.6.3 (Skipped Tracks):
 * 双方向ストリームを確保できないなど結果 PUBLISH を送れない場合は、
 * SUBSCRIBE_TRACKS の応答ストリームへ PUBLISH_SKIPPED を送り、以後その要求に
 * ついて PUBLISH を送らない。createBidirectionalStream() の失敗をテスト用
 * transport に注入して、実際の送信経路で確かめる。
 */
test("publishedTracks: 結果 PUBLISH の双方向ストリームを確保できなければ PUBLISH_SKIPPED を送る", async () => {
  const context = createPublishedTracksTestContext();
  await publishTestTrack(context, ["ns"], "alpha");

  // アプリの PUBLISH を確立した後に、双方向ストリームの作成失敗を注入する。
  context.testTransport.setCreateBidirectionalStreamError(
    new Error("bidirectional stream limit reached"),
  );
  const incoming = createIncomingTracksSubscription(context, 11n, ["ns"]);
  const streamCountBefore = context.testTransport.bidirectionalStreams.length;
  publishedTracksOnSubscriptionAccepted(context.session, incoming.state);

  await waitForCondition(
    () => incoming.responseStream.written.length > 0,
    "PUBLISH_SKIPPED が応答ストリームへ書き込まれること",
  );
  const skipMessage = findWrittenMessage(incoming.responseStream, MessageType.PUBLISH_SKIPPED);
  assert.isDefined(skipMessage, "代わりに PUBLISH_SKIPPED を送る");
  assert.equal(
    context.testTransport.bidirectionalStreams.length,
    streamCountBefore,
    "PUBLISH 用の双方向ストリームは生成されない",
  );
  await waitForCondition(
    () => incoming.state.publishSkipped.has(fullTrackNameKey(["ns"], "alpha")),
    "PUBLISH を送れなかった Track を PUBLISH_SKIPPED として記録する",
  );
  assert.equal(
    findWrittenMessages(incoming.responseStream, MessageType.PUBLISH).length,
    0,
    "PUBLISH_SKIPPED を送った Track には PUBLISH を送らない",
  );
});
