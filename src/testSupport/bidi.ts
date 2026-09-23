/**
 * bidi テスト専用の共有ヘルパー
 *
 * 双方向ストリームのメッセージ処理テスト (src/session/bidi*.test.ts) で共有する
 * セッション・コンテキスト構築ヘルパーを集約する。テスト本文を持たないため
 * vitest の `test.include` (`src/**\/*.{test,prop}.ts`) に一致しない名前にして、
 * テストファイルとして収集されるのを避ける。ライブラリのビルド entry
 * (`src/index.ts`) からも到達しないため、配布物には含まれない。
 */

import { encodeRequestOkPayload } from "../message/session";
import { encodeFetchOkPayload } from "../message";
import { MessageType, MessageParameterType } from "../message/types";
import { AuthTokenCache } from "../session/authTokenCache";
import { SessionError } from "../error";
import { FetcherImpl } from "../fetcher";
import { encodeVarint, MAX_VARINT } from "../varint";
import { ControlStreamReader, ControlStreamWriter } from "../controlStream";
import { PublisherImpl } from "../publisher";
// draft-ietf-moq-transport-21 §11.3.1:
// SUBSCRIBE_OK 受理経路は pendingSubgroupBuffer.notifyAlias() を必ず呼ぶ。
// 実物を渡さないと TypeError になり、defaultBidiHandleError に握り潰されて
// pending.resolve と読み取りループ起動に到達しないままテストが通ってしまう。
import { PendingSubgroupBuffer } from "../pendingSubgroupBuffer";
import { type BidiSessionInternal, bidiSendPublishStateNotify } from "../session/bidi";
import type { SessionInternal } from "../session/types";
import {
  publishClosePublisherStream,
  publishMarkStreamOmitted,
  publishSendDatagram,
  publishSendObject,
  publishSendPublishDone,
} from "../session/publish";
import { concatUint8Arrays } from "./helpers";

/**
 * BidiSessionInternal のモックを構築する。
 * writer.write に渡されたバイト列を `written` に蓄積し、後からデコードして検証する。
 */
export function createBidiSession(): {
  session: BidiSessionInternal;
  written: Uint8Array[];
} {
  const written: Uint8Array[] = [];
  const writer = {
    write: async (data: Uint8Array): Promise<void> => {
      written.push(data);
    },
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  const session = {
    sessionState: "connected",
    transport: {},
    controlWriter: new ControlStreamWriter(),
    nextRequestId: 100n,
    requestStreams: new Map([
      [
        0n,
        {
          stream: {},
          writer,
          controlReader: new ControlStreamReader(),
        },
      ],
    ]),
    pendingPublish: new Map(),
    pendingSubscribe: new Map(),
    pendingFetch: new Map(),
    pendingTrackStatus: new Map(),
    pendingRequestUpdate: new Map(),
    fillFetchTargets: new Map(),
    publishers: new Map(),
    subscribers: new Map(),
    subscribersByAlias: new Map(),
    fetchers: new Map(),
    pendingSubgroupBuffer: new PendingSubgroupBuffer(),
    fetcherReadyCallbacks: new Map(),
    goawayReceivedOnRequestStreams: new Set(),
    unmatchedRequestOkAllowances: new Map(),
    peerMaxRequestUpdates: 0,
    peerMaxFilterRanges: 2,
    // draft-ietf-moq-transport-21 §9.1.7 (MAX_REQUEST_UPDATES):
    // 既定は未広告 (0 = 無制限) と未応答数なし
    localMaxRequestUpdates: 0,
    receivedRequestUpdateCounts: new Map(),
    namespaceSubscriptions: new Map(),
    tracksSubscriptions: new Map(),
    publisherStreams: new Map(),
    publisherSendQueues: new Map(),
    closedSubgroups: new Set(),
    statsControlMessagesSent: 0,
    emitDebug: () => {},
    closeWithError: () => {},
    validateIncomingRequestId: (_requestId: bigint): SessionError | null => null,
  } as unknown as BidiSessionInternal;

  return { session, written };
}

/**
 * draft-ietf-moq-transport-21 §9.20.10:
 * End Group が 2^64-1 を超える 3 フィールド表現の LOCATION_FILTER 値を手組みする。
 * 先頭 varint はバイト Length のため、フィールド部の実バイト長を指定する。
 */
export function buildExceedingLocationFilterValue(): Uint8Array {
  const exceedingFields = new Uint8Array([
    ...encodeVarint(1n),
    ...encodeVarint(0n),
    ...encodeVarint(MAX_VARINT),
  ]);
  return new Uint8Array([...encodeVarint(BigInt(exceedingFields.length)), ...exceedingFields]);
}

/**
 * マクロタスク 1 回分待ち、ストリーム読み取りループを進行させる
 *
 * enqueue したメッセージをループが処理し終えるまで待つために使う。
 * FIN (readableController.close()) を送ると PUBLISH_DONE 無しの失敗扱いで
 * 購読が closed になるため、配信の検証は FIN の前に済ませる必要がある。
 */
export async function waitForMacrotask(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * 1 本の Subgroup ストリームで観測した終端操作
 */
interface SubgroupStreamRecord {
  closeCount: number;
  abortCount: number;
  abortReasons: unknown[];
}

/**
 * 実 W3C ストリーム (`ReadableStream` + `WritableStream`) と実 Map で構成した
 * publish ロール用の session を構築する。ストリーム機構は実物であり、
 * 失敗注入点は sink のみ。session はテスト用のオブジェクトリテラルを
 * 型キャストしたものであり、BidiSessionInternal の未使用フィールドは
 * 最小限のダミー値で満たす。
 */
export function createPublishReadTestContext(
  writableSink: UnderlyingSink<Uint8Array>,
  authTokenCacheSize = 0,
): {
  session: BidiSessionInternal;
  stream: WebTransportBidirectionalStream;
  readableController: ReadableStreamDefaultController<Uint8Array>;
  events: string[];
  written: Uint8Array[];
  closedWithError: SessionError | undefined;
  closedWithErrorCount: number;
  publisher: PublisherImpl;
  requestId: bigint;
  controlReader: ControlStreamReader;
  subgroupStreams: SubgroupStreamRecord[];
} {
  const requestId = 10n;
  const events: string[] = [];
  const written: Uint8Array[] = [];
  // Subgroup ストリーム (createUnidirectionalStream) の終端操作の記録
  const subgroupStreams: SubgroupStreamRecord[] = [];
  let closedWithError: SessionError | undefined;
  // closeWithError の呼び出し回数。セッション終了後に同一チャンクの残りメッセージを
  // 処理し続けていないこと (error の二重通知が無いこと) を検証するために数える。
  let closedWithErrorCount = 0;

  let readableController!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      readableController = controller;
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk, controller) {
      events.push("write");
      written.push(chunk);
      if (writableSink.write) {
        return writableSink.write(chunk, controller);
      }
    },
    close() {
      events.push("close");
      if (writableSink.close) {
        return writableSink.close();
      }
    },
  });

  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;
  const writer = writable.getWriter();
  const controlReader = new ControlStreamReader();

  // Subgroup ストリームは close (FIN) と abort (RESET) を区別して記録する
  const transport = {
    createUnidirectionalStream: async (): Promise<WritableStream<Uint8Array>> => {
      const record: SubgroupStreamRecord = { closeCount: 0, abortCount: 0, abortReasons: [] };
      subgroupStreams.push(record);
      return new WritableStream<Uint8Array>({
        write() {},
        close() {
          record.closeCount += 1;
        },
        abort(reason) {
          record.abortCount += 1;
          record.abortReasons.push(reason);
        },
      });
    },
    // Datagram の送信 (Largest Location の更新と Subgroup の省略判定の切り分けに使う)
    datagrams: { writable: new WritableStream<Uint8Array>() },
  } as unknown as WebTransport;

  const publisher = new PublisherImpl(["test"], "track", requestId, 1n);
  // SessionImpl.publish と同じ配線 (Subgroup ストリームへの Object 送信と省略の記録)
  publisher.onSendObject = (params) =>
    publishSendObject(session as unknown as SessionInternal, publisher, params);
  publisher.onSendDatagram = (params) =>
    publishSendDatagram(session as unknown as SessionInternal, publisher, params);
  publisher.onSendObjectSkipped = (groupId) => {
    publishMarkStreamOmitted(session, publisher.getTrackAlias(), groupId);
  };
  // SessionImpl の onDoneInternal と同じ後始末 (データストリーム FIN → PUBLISH_DONE)
  publisher.onDoneInternal = async (status) => {
    await publishClosePublisherStream(session, publisher.getTrackAlias());
    await publishSendPublishDone(session, publisher, status);
  };
  // SessionImpl.publish と同じ配線 (PUBLISH_STATE_NOTIFY の送信経路)
  publisher.onNotifyStateChange = (options) =>
    bidiSendPublishStateNotify(session, publisher, options);

  const session = {
    sessionState: "connected",
    transport,
    grease: false,
    statsUnidirectionalStreamsOpened: 0,
    controlWriter: new ControlStreamWriter(),
    nextRequestId: 100n,
    requestStreams: new Map([[requestId, { stream, writer, controlReader }]]),
    pendingPublish: new Map(),
    pendingSubscribe: new Map(),
    pendingFetch: new Map(),
    pendingTrackStatus: new Map(),
    pendingRequestUpdate: new Map(),
    fillFetchTargets: new Map(),
    publishers: new Map([[requestId, publisher]]),
    subscribers: new Map(),
    subscribersByAlias: new Map(),
    fetchers: new Map(),
    pendingSubgroupBuffer: new PendingSubgroupBuffer(),
    fetcherReadyCallbacks: new Map(),
    goawayReceivedOnRequestStreams: new Set(),
    unmatchedRequestOkAllowances: new Map(),
    peerMaxRequestUpdates: 0,
    peerMaxFilterRanges: 0,
    // draft-ietf-moq-transport-21 §9.1.7 (MAX_REQUEST_UPDATES):
    // 既定は未広告 (0 = 無制限) と未応答数なし
    localMaxRequestUpdates: 0,
    receivedRequestUpdateCounts: new Map(),
    // draft-ietf-moq-transport-21 §8.9 / §9.1.3:
    // 受信 AUTHORIZATION TOKEN のキャッシュ。既定は上限 0 (未広告 = Alias 使用禁止) で、
    // Alias を使うテストは authTokenCacheSize を指定する。
    receivedAuthTokens: new AuthTokenCache(authTokenCacheSize),
    tracksSubscriptions: new Map(),
    publisherStreams: new Map(),
    publisherSendQueues: new Map(),
    closedSubgroups: new Set(),
    statsControlMessagesSent: 0,
    emitDebug: () => {},
    closeWithError: (error: SessionError) => {
      closedWithError = error;
      closedWithErrorCount++;
      // SessionImpl.closeWithError と同じく状態を closed へ遷移させる。
      // 遷移させないと、セッション終了後の読み取り打ち切り (sessionState ガード) を
      // 検証できない。BidiSessionInternal の sessionState は readonly 宣言だが、
      // 実装 (SessionImpl) は可変フィールドのため、テスト用の状態遷移として代入する。
      (session as unknown as { sessionState: string }).sessionState = "closed";
    },
    validateIncomingRequestId: (_requestId: bigint): SessionError | null => null,
  } as unknown as BidiSessionInternal;

  return {
    session,
    stream,
    readableController,
    events,
    written,
    // 値コピーではなく getter で返す (closeWithError 呼び出し後の代入を反映する)
    get closedWithError(): SessionError | undefined {
      return closedWithError;
    },
    get closedWithErrorCount(): number {
      return closedWithErrorCount;
    },
    publisher,
    requestId,
    controlReader,
    subgroupStreams,
  };
}

/**
 * テスト用に session の sessionState を "closed" に遷移させる
 * (型上 readonly のため、テスト用に型を偽装して書き換える)
 */
export function forceSessionClosed(session: BidiSessionInternal): void {
  (session as unknown as { sessionState: "connected" | "closed" }).sessionState = "closed";
}

/**
 * End Group が 2^64-1 を超える LOCATION_FILTER パラメータを組み立てる
 *
 * draft-ietf-moq-transport-21 §9.20.10 の Length ベース表現で、StartGroup +
 * EndGroupDelta が超過する値を手組みする。encodeLocationFilterParameter
 * は送信前に throw するためエンコーダでは組み立てられない。
 * 4 フィールド表現 (EndObject 付き) も対象にする。
 */
export function buildOverflowingLocationFilterParameter(withEndObject = false): {
  type: number;
  value: Uint8Array;
} {
  // StartGroup=MAX_VARINT + StartObject=0 + EndGroupDelta=1
  // End Group = MAX_VARINT + 1 で 2^64-1 超過
  const rawFields = [encodeVarint(MAX_VARINT), encodeVarint(0n), encodeVarint(1n)];
  if (withEndObject) {
    rawFields.push(encodeVarint(0n));
  }
  const fields = new Uint8Array(rawFields.flatMap((part) => [...part]));
  const value = new Uint8Array([...encodeVarint(BigInt(fields.length)), ...fields]);
  return { type: MessageParameterType.LOCATION_FILTER, value };
}

/**
 * PUBLISH_OK 応答の LOCATION_FILTER 検証を駆動するセッションを構築する
 *
 * 指定パラメータの PUBLISH_OK を ReadableStream に 1 通だけ enqueue し、
 * 解決・拒否・セッション終了の観測点を返す。PUBLISH_OK 受信時の値検証に使う。
 * 観測点はゲッター関数で返す (生成コンテキストごとの参照安定性のため)。
 */
export function createPublishOkValidationContext(
  parameters: { type: number; value: Uint8Array }[],
): {
  session: BidiSessionInternal;
  resolved: () => PublisherImpl | undefined;
  rejected: () => Error | undefined;
  closedWithError: () => SessionError | undefined;
  /** reject と close の発生順 (同一オブジェクト性と順序の検証用) */
  order: string[];
  requestId: bigint;
} {
  const requestId = 10n;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      const okPayload = encodeRequestOkPayload({
        type: MessageType.REQUEST_OK,
        parameters,
        trackProperties: [],
      });
      const writer = new ControlStreamWriter();
      controller.enqueue(writer.encode(MessageType.REQUEST_OK, okPayload));
      controller.close();
    },
  });
  const writable = new WritableStream<Uint8Array>({});
  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;
  const controlReader = new ControlStreamReader();

  let resolvedPublisher: PublisherImpl | undefined;
  let rejectedError: Error | undefined;
  let closedError: SessionError | undefined;
  const order: string[] = [];
  const session = {
    sessionState: "connected",
    transport: {},
    controlWriter: new ControlStreamWriter(),
    nextRequestId: 100n,
    pendingPublish: new Map([
      [
        requestId,
        {
          impl: new PublisherImpl(["test"], "track", requestId, 1n),
          resolve: (publisher: PublisherImpl) => {
            resolvedPublisher = publisher;
          },
          reject: (error: Error) => {
            order.push("reject");
            rejectedError = error;
          },
        },
      ],
    ]),
    requestStreams: new Map([[requestId, { stream, writer: writable.getWriter(), controlReader }]]),
    publishers: new Map(),
    subscribers: new Map(),
    subscribersByAlias: new Map(),
    fetchers: new Map(),
    pendingSubgroupBuffer: new PendingSubgroupBuffer(),
    fetcherReadyCallbacks: new Map(),
    pendingRequestUpdate: new Map(),
    fillFetchTargets: new Map(),
    goawayReceivedOnRequestStreams: new Set(),
    unmatchedRequestOkAllowances: new Map(),
    peerMaxRequestUpdates: 0,
    peerMaxFilterRanges: 0,
    // draft-ietf-moq-transport-21 §9.1.7 (MAX_REQUEST_UPDATES):
    // 既定は未広告 (0 = 無制限) と未応答数なし
    localMaxRequestUpdates: 0,
    receivedRequestUpdateCounts: new Map(),
    tracksSubscriptions: new Map(),
    publisherStreams: new Map(),
    publisherSendQueues: new Map(),
    closedSubgroups: new Set(),
    statsControlMessagesSent: 0,
    emitDebug: () => {},
    closeWithError: (error: SessionError) => {
      order.push("close");
      closedError = error;
    },
  } as unknown as BidiSessionInternal;

  return {
    session,
    resolved: () => resolvedPublisher,
    rejected: () => rejectedError,
    closedWithError: () => closedError,
    order,
    requestId,
  };
}

/**
 * 応答読み取り用の session を構築する。ストリーム機構は実物であり、
 * session はテスト用のオブジェクトリテラルを型キャストしたものである。
 */
export function createOkResponseReadTestContext(): {
  session: BidiSessionInternal;
  stream: WebTransportBidirectionalStream;
  readableController: ReadableStreamDefaultController<Uint8Array>;
  controlReader: ControlStreamReader;
  controlWriter: ControlStreamWriter;
  getClosedWithError: () => SessionError | undefined;
  order: string[];
  requestId: bigint;
} {
  const requestId = 10n;

  let readableController!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      readableController = controller;
    },
  });
  const writable = new WritableStream<Uint8Array>();
  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;
  const writer = writable.getWriter();
  const controlReader = new ControlStreamReader();

  let closedWithError: SessionError | undefined;
  // reject → closeWithError の順序を記録する
  const order: string[] = [];
  const controlWriter = new ControlStreamWriter();
  const session = {
    sessionState: "connected",
    transport: {},
    controlWriter,
    nextRequestId: 100n,
    requestStreams: new Map([[requestId, { stream, writer, controlReader }]]),
    pendingPublish: new Map(),
    pendingSubscribe: new Map(),
    pendingFetch: new Map(),
    pendingTrackStatus: new Map(),
    pendingRequestUpdate: new Map(),
    fillFetchTargets: new Map(),
    publishers: new Map(),
    subscribers: new Map(),
    subscribersByAlias: new Map(),
    fetchers: new Map(),
    pendingSubgroupBuffer: new PendingSubgroupBuffer(),
    fetcherReadyCallbacks: new Map(),
    goawayReceivedOnRequestStreams: new Set(),
    unmatchedRequestOkAllowances: new Map(),
    peerMaxRequestUpdates: 0,
    peerMaxFilterRanges: 0,
    // draft-ietf-moq-transport-21 §9.1.7 (MAX_REQUEST_UPDATES):
    // 既定は未広告 (0 = 無制限) と未応答数なし
    localMaxRequestUpdates: 0,
    receivedRequestUpdateCounts: new Map(),
    namespaceSubscriptions: new Map(),
    tracksSubscriptions: new Map(),
    publisherStreams: new Map(),
    publisherSendQueues: new Map(),
    closedSubgroups: new Set(),
    statsControlMessagesSent: 0,
    emitDebug: () => {},
    closeWithError: (error: SessionError) => {
      order.push("close");
      closedWithError = error;
    },
  } as unknown as BidiSessionInternal;

  return {
    session,
    stream,
    readableController,
    controlReader,
    controlWriter,
    // 値コピーではなく getter で返す (closeWithError 呼び出し後の代入を反映する)
    getClosedWithError: () => closedWithError,
    order,
    requestId,
  };
}

/**
 * SUBSCRIBE_OK / FETCH_OK の MalformedTrackError 経路で bidi ストリームが
 * cancel されることを観測するためのセッションを構築する。
 *
 * readable の cancel (STOP_SENDING 相当) と writable の abort (RESET_STREAM
 * 相当) の到達理由を記録する。
 */
export function createCancelObservableResponseContext(): {
  session: BidiSessionInternal;
  stream: WebTransportBidirectionalStream;
  readableController: ReadableStreamDefaultController<Uint8Array>;
  controlReader: ControlStreamReader;
  controlWriter: ControlStreamWriter;
  requestId: bigint;
  cancelled: unknown[];
  aborted: unknown[];
  getClosedWithError: () => SessionError | undefined;
} {
  const requestId = 10n;
  let readableController!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled: unknown[] = [];
  const aborted: unknown[] = [];
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      readableController = controller;
    },
    cancel(reason) {
      cancelled.push(reason);
    },
  });
  const writable = new WritableStream<Uint8Array>({
    abort(reason) {
      aborted.push(reason);
    },
  });
  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;
  const writer = writable.getWriter();
  const controlReader = new ControlStreamReader();
  let closedWithError: SessionError | undefined;
  const controlWriter = new ControlStreamWriter();
  const session = {
    sessionState: "connected",
    transport: {},
    controlWriter,
    nextRequestId: 100n,
    requestStreams: new Map([[requestId, { stream, writer, controlReader }]]),
    pendingPublish: new Map(),
    pendingSubscribe: new Map(),
    pendingFetch: new Map(),
    pendingTrackStatus: new Map(),
    pendingRequestUpdate: new Map(),
    fillFetchTargets: new Map(),
    publishers: new Map(),
    subscribers: new Map(),
    subscribersByAlias: new Map(),
    fetchers: new Map(),
    pendingSubgroupBuffer: new PendingSubgroupBuffer(),
    fetcherReadyCallbacks: new Map(),
    goawayReceivedOnRequestStreams: new Set(),
    unmatchedRequestOkAllowances: new Map(),
    peerMaxRequestUpdates: 0,
    peerMaxFilterRanges: 0,
    // draft-ietf-moq-transport-21 §9.1.7 (MAX_REQUEST_UPDATES):
    // 既定は未広告 (0 = 無制限) と未応答数なし
    localMaxRequestUpdates: 0,
    receivedRequestUpdateCounts: new Map(),
    namespaceSubscriptions: new Map(),
    tracksSubscriptions: new Map(),
    publisherStreams: new Map(),
    publisherSendQueues: new Map(),
    closedSubgroups: new Set(),
    statsControlMessagesSent: 0,
    emitDebug: () => {},
    closeWithError: (error: SessionError) => {
      closedWithError = error;
    },
  } as unknown as BidiSessionInternal;
  return {
    session,
    stream,
    readableController,
    controlReader,
    controlWriter,
    requestId,
    cancelled,
    aborted,
    getClosedWithError: () => closedWithError,
  };
}

/**
 * 確立後の FETCH 応答ストリーム読み取りを検証するための session を構築する
 *
 * draft-ietf-moq-transport-21 §9.11 / §9.12 / §9.5 / §9.10:
 * FETCH_OK を最初の応答として与え、pendingFetch を解決して fetchers に登録する。
 * fetch ロールの読み取りループ (bidiReadRequestStreamMessages) が当該双方向
 * ストリームを読み続けることを、実 W3C ストリームと実 Map で検証するために使う。
 * ストリーム機構は実物であり、session はテスト用のオブジェクトリテラルを
 * 型キャストしたものである。
 *
 * `additionalMessages` は FETCH_OK と同一チャンクに連結するメッセージ列である
 * (bidiDispatchResponse が context.remainingMessages に保持する分を再現する)。
 * 呼び出し側は返り値の additionalMessages へ push したうえで flushInitialChunk() を
 * 呼び、FETCH_OK を読ませる。これにより組み立てに controlWriter を要する
 * メッセージも連結できる。ピアの FIN を送るテストは readableController.close() を
 * 明示的に呼ぶ。
 *
 * `closedWithErrorCount` を返すのは、セッション終了後に同一チャンクの
 * 残りメッセージを処理し続けていないこと (error の二重通知が無いこと) を
 * 検証できるようにするためである。
 */
export function createFetchReadTestContext(additionalMessages: Uint8Array[] = []): {
  session: BidiSessionInternal;
  stream: WebTransportBidirectionalStream;
  readableController: ReadableStreamDefaultController<Uint8Array>;
  controlReader: ControlStreamReader;
  controlWriter: ControlStreamWriter;
  requestId: bigint;
  fetcher: FetcherImpl;
  /** FETCH_OK と同一チャンクに連結するメッセージ列 (flushInitialChunk 前に push する) */
  additionalMessages: Uint8Array[];
  /** FETCH_OK と additionalMessages を 1 チャンクとして enqueue する */
  flushInitialChunk: () => void;
  /** written は値コピーではなく現在の配列を参照する (append を反映する) */
  written: Uint8Array[];
  getClosedWithError: () => SessionError | undefined;
  getClosedWithErrorCount: () => number;
} {
  const requestId = 10n;
  const written: Uint8Array[] = [];
  let closedWithError: SessionError | undefined;
  let closedWithErrorCount = 0;

  let readableController!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      readableController = controller;
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      written.push(chunk);
    },
  });
  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;
  const writer = writable.getWriter();
  const controlReader = new ControlStreamReader();
  const controlWriter = new ControlStreamWriter();

  const fetcher = new FetcherImpl(["test"], "track", requestId, () => {});

  const session = {
    sessionState: "connected",
    transport: {},
    controlWriter,
    nextRequestId: 100n,
    requestStreams: new Map([[requestId, { stream, writer, controlReader }]]),
    pendingPublish: new Map(),
    pendingSubscribe: new Map(),
    pendingFetch: new Map([
      [
        requestId,
        {
          impl: fetcher,
          resolve: () => {},
          reject: () => {},
        },
      ],
    ]),
    pendingTrackStatus: new Map(),
    pendingRequestUpdate: new Map(),
    fillFetchTargets: new Map(),
    publishers: new Map(),
    subscribers: new Map(),
    subscribersByAlias: new Map(),
    fetchers: new Map(),
    pendingSubgroupBuffer: new PendingSubgroupBuffer(),
    fetcherReadyCallbacks: new Map(),
    goawayReceivedOnRequestStreams: new Set(),
    unmatchedRequestOkAllowances: new Map(),
    peerMaxRequestUpdates: 0,
    peerMaxFilterRanges: 0,
    // draft-ietf-moq-transport-21 §9.1.7 (MAX_REQUEST_UPDATES):
    // 既定は未広告 (0 = 無制限) と未応答数なし
    localMaxRequestUpdates: 0,
    receivedRequestUpdateCounts: new Map(),
    // draft-ietf-moq-transport-21 §8.9 / §9.1.3:
    // 受信 AUTHORIZATION TOKEN のキャッシュ。既定は上限 0 (未広告 = Alias 使用禁止)。
    receivedAuthTokens: new AuthTokenCache(0),
    namespaceSubscriptions: new Map(),
    tracksSubscriptions: new Map(),
    publisherStreams: new Map(),
    publisherSendQueues: new Map(),
    closedSubgroups: new Set(),
    statsControlMessagesSent: 0,
    emitDebug: () => {},
    closeWithError: (error: SessionError) => {
      closedWithError = error;
      closedWithErrorCount++;
      // SessionImpl.closeWithError と同じく状態を closed へ遷移させる。
      // 遷移させないと、セッション終了後の読み取り打ち切り (sessionState ガード) を
      // 検証できない。BidiSessionInternal の sessionState は readonly 宣言だが、
      // 実装 (SessionImpl) は可変フィールドのため、テスト用の状態遷移として代入する。
      (session as unknown as { sessionState: string }).sessionState = "closed";
    },
    validateIncomingRequestId: (_requestId: bigint): SessionError | null => null,
  } as unknown as BidiSessionInternal;

  // FETCH_OK (End of Track あり / End Location {0, 0} / パラメータなし) を
  // 最初の応答として組み立てる。同一チャンクに連結するメッセージは呼び出し側が
  // additionalMessages へ push し、flushInitialChunk() で 1 チャンクとして
  // enqueue する。連結されたメッセージは bidiDispatchResponse が
  // context.remainingMessages に保持する。
  const fetchOkPayload = encodeFetchOkPayload({
    type: MessageType.FETCH_OK,
    endOfTrack: true,
    endLocation: { group: 0n, object: 0n },
    parameters: [],
    trackProperties: [],
  });

  return {
    session,
    stream,
    readableController,
    controlReader,
    controlWriter,
    requestId,
    fetcher,
    additionalMessages,
    written,
    flushInitialChunk: () => {
      readableController.enqueue(
        concatUint8Arrays([
          controlWriter.encode(MessageType.FETCH_OK, fetchOkPayload),
          ...additionalMessages,
        ]),
      );
    },
    // 値コピーではなく getter で返す (closeWithError 呼び出し後の代入を反映する)
    getClosedWithError: () => closedWithError,
    getClosedWithErrorCount: () => closedWithErrorCount,
  };
}
