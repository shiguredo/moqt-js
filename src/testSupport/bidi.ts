/**
 * セッションを使うテスト専用の共有ヘルパー
 *
 * 双方向ストリームのメッセージ処理テスト (src/session/bidi*.test.ts) と、
 * 統計・debug 記録を観測する受信系テスト (src/session/incoming*.test.ts /
 * namespaceLoops*.test.ts / *.prop.ts) で共有するセッション・コンテキスト構築
 * ヘルパーを集約する。テスト本文を持たないため vitest の
 * `test.include` (`src/**\/*.{test,prop}.ts`) に一致しない名前にして、
 * テストファイルとして収集されるのを避ける。ライブラリのビルド entry
 * (`src/index.ts`) からも到達しないため、配布物には含まれない。
 *
 * セッションはすべて実 SessionImpl を使う。自モジュールの内部型
 * (BidiSessionInternal / IncomingPublishSessionInternal / SessionInternal) を
 * オブジェクトリテラルで満たすことはしない。SessionImpl の private フィールドは
 * 構造的部分型の判定に現れないため、内部型として参照する箇所だけ境界キャストを
 * 用意する (asBidiSessionInternal / asIncomingPublishSessionInternal /
 * asSessionInternal。いずれも実装は同一の SessionImpl であり、偽装ではない)。
 *
 * WebTransport はブラウザ API の境界でありテストが用意する必要がある。
 * ただし ReadableStream / WritableStream はすべて実 W3C Streams を使い、
 * write されたバイト列は実 WritableStream の sink で捕捉する
 * (WritableStreamDefaultWriter を偽装しない)。
 */

import { encodeRequestOkPayload } from "../message/session";
import { encodeLocation } from "../message";
import { MessageType, MessageParameterType } from "../message/types";
import { AuthTokenCache } from "../session/authTokenCache";
import { SessionError } from "../error";
import { FetcherImpl } from "../fetcher";
import { encodeVarint, MAX_VARINT } from "../varint";
import { ControlStreamReader, ControlStreamWriter } from "../controlStream";
import { type Publisher, PublisherImpl } from "../publisher";
import { SessionImpl, type ConnectCallbacks } from "../session";
import { type BidiSessionInternal, bidiSendPublishStateNotify } from "../session/bidi";
import type { IncomingPublishSessionInternal } from "../session/incomingPublish";
import type { SessionInternal } from "../session/types";
import {
  publishClosePublisherStream,
  publishCloseSubgroup,
  publishMarkStreamOmitted,
  publishSendDatagram,
  publishSendObject,
  publishSendPublishDone,
} from "../session/publish";
import { concatUint8Arrays } from "./helpers";

/**
 * 実 SessionImpl を内部型として参照するための境界キャスト
 *
 * BidiSessionInternal は SessionImpl の private フィールド (sessionState /
 * transport) を公開メンバーとして要求するため、構造的部分型では代入できない。
 * 実体は同じ SessionImpl であり、テストから内部 free function を呼ぶための
 * 型境界としてのみキャストする。オブジェクトリテラルによる偽装には使わない。
 */
export function asBidiSessionInternal(session: object): BidiSessionInternal {
  return session as unknown as BidiSessionInternal;
}

/**
 * 実 SessionImpl を IncomingPublishSessionInternal として参照する境界キャスト
 *
 * 理由は asBidiSessionInternal と同じ (private フィールドが構造的部分型の
 * 判定に現れないため)。実体は実 SessionImpl である。
 */
export function asIncomingPublishSessionInternal(
  session: SessionImpl,
): IncomingPublishSessionInternal {
  return session as unknown as IncomingPublishSessionInternal;
}

/**
 * 実 SessionImpl を SessionInternal として参照する境界キャスト
 *
 * 理由は asBidiSessionInternal と同じ。publish 系 free function は
 * SessionInternal を要求するが、実体は実 SessionImpl である。
 */
export function asSessionInternal(session: SessionImpl | BidiSessionInternal): SessionInternal {
  return session as unknown as SessionInternal;
}

/**
 * 1 本の Subgroup ストリームで観測した終端操作
 */
export interface SubgroupStreamRecord {
  closeCount: number;
  abortCount: number;
  abortReasons: unknown[];
  /** 実 sink が受け取った write のバイト列 (到着順) */
  writes: Uint8Array[];
}

/**
 * テスト用 WebTransport が生成した双方向ストリームとその観測点
 *
 * readable はテストが readableController で feed し、writable は実
 * WritableStream の sink が受け取った chunk を written に記録する。
 */
export interface TestBidirectionalStream {
  stream: WebTransportBidirectionalStream;
  readable: ReadableStream<Uint8Array>;
  readableController: ReadableStreamDefaultController<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  /** 実 sink が受け取った write のバイト列 (到着順) */
  written: Uint8Array[];
  /** 実 sink の write / close の発生順 ("write" | "close") */
  events: string[];
  /** readable の cancel (STOP_SENDING 相当) に渡された理由 */
  cancelled: unknown[];
  /** writable の abort (RESET_STREAM 相当) に渡された理由 */
  aborted: unknown[];
}

/**
 * 実 W3C ストリームで双方向ストリームを 1 本構築する
 *
 * @param writableSink - 送信側の sink。省略時は write を記録するだけの sink になる
 */
export function createTestBidirectionalStream(
  writableSink: UnderlyingSink<Uint8Array> = {},
): TestBidirectionalStream {
  const written: Uint8Array[] = [];
  const events: string[] = [];
  const cancelled: unknown[] = [];
  const aborted: unknown[] = [];
  let readableController!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      readableController = controller;
    },
    cancel(reason) {
      cancelled.push(reason);
    },
  });
  const writable = new WritableStream<Uint8Array>({
    async write(chunk, controller) {
      events.push("write");
      written.push(chunk);
      if (writableSink.write !== undefined) {
        await writableSink.write(chunk, controller);
      }
    },
    async close() {
      events.push("close");
      if (writableSink.close !== undefined) {
        await writableSink.close();
      }
    },
    async abort(reason) {
      // 従来の events は write / close のみを表すため、abort は aborted へ記録する
      aborted.push(reason);
      if (writableSink.abort !== undefined) {
        await writableSink.abort(reason);
      }
    },
  });
  const stream = { readable, writable } as unknown as WebTransportBidirectionalStream;
  // writer は遅延取得する。production 側の bidiSendRequestOnBidiStream のように
  // stream.writable.getWriter() を自分で呼ぶ経路と同居させるため、この helper が
  // 先に lock を取らないようにする (取得後の lock は解除しない)。
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  return {
    stream,
    readable,
    readableController,
    writable,
    get writer(): WritableStreamDefaultWriter<Uint8Array> {
      writer ??= writable.getWriter();
      return writer;
    },
    written,
    events,
    cancelled,
    aborted,
  };
}

/**
 * テスト用 WebTransport の構成
 */
interface TestWebTransportOptions {
  /**
   * 双方向ストリームごとの writable sink を作る。
   * 省略時は write を記録するだけの sink になる。
   */
  bidiSink?: () => UnderlyingSink<Uint8Array>;
  /**
   * 単方向ストリーム (Subgroup 用) の factory。
   * 省略時は write を捨て、close / abort を record に記録する stream を返す。
   */
  unidirectionalStream?: (
    record: SubgroupStreamRecord,
  ) => WritableStream<Uint8Array> | Promise<WritableStream<Uint8Array>>;
  /**
   * datagrams.writable に載せる WritableStream。
   * 省略時は write を datagramChunks に記録する stream になる。
   */
  datagramWritable?: WritableStream<Uint8Array>;
  /**
   * datagrams.createWritable() に載せる factory。
   * WebTransport の実装差 (旧 writable / 現行 createWritable) を再現するために使う。
   */
  datagramCreateWritable?: () => WritableStream<Uint8Array>;
  /**
   * true のとき datagrams.writable を載せない。
   * 現行 API (createWritable のみ) の WebTransport を再現するために使う。
   */
  omitDatagramWritable?: boolean;
  /** reliability 属性 (ブラウザが公開していない場合を再現するなら省略) */
  reliability?: string;
}

/**
 * テスト用 WebTransport とその観測点
 *
 * transport 自体はブラウザ API の境界の代役だが、返すストリームは実 W3C
 * Streams である。close() は close 要求を記録し、closed の解決はテストが
 * resolveClosed() / rejectClosed() で明示的に行う。
 */
interface TestWebTransport {
  transport: WebTransport;
  /** 双方向ストリームを 1 本作り、生成順に bidirectionalStreams へ積む */
  createBidirectionalStream(): TestBidirectionalStream;
  bidirectionalStreams: TestBidirectionalStream[];
  unidirectionalStreams: SubgroupStreamRecord[];
  /** datagrams.writable へ書かれた chunk (既定 sink を使う場合のみ) */
  datagramChunks: Uint8Array[];
  /** transport.close() に渡された情報 */
  getCloseInfo(): WebTransportCloseInfo | undefined;
  /** transport.closed を解決する (ピア起点の終了を再現する) */
  resolveClosed(info?: WebTransportCloseInfo): void;
  /** transport.closed を reject する (異常終了を再現する) */
  rejectClosed(error: Error): void;
}

/**
 * 実 W3C ストリームを返すテスト用 WebTransport を構築する
 */
export function createTestWebTransport(options: TestWebTransportOptions = {}): TestWebTransport {
  const bidirectionalStreams: TestBidirectionalStream[] = [];
  const unidirectionalStreams: SubgroupStreamRecord[] = [];
  const datagramChunks: Uint8Array[] = [];
  let closeInfo: WebTransportCloseInfo | undefined;
  let resolveClosed!: (info: WebTransportCloseInfo) => void;
  let rejectClosed!: (error: Error) => void;
  const closed = new Promise<WebTransportCloseInfo>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });

  const createBidirectionalStream = (): TestBidirectionalStream => {
    const created = createTestBidirectionalStream(options.bidiSink?.());
    bidirectionalStreams.push(created);
    return created;
  };

  const datagramWritable =
    options.datagramWritable ??
    new WritableStream<Uint8Array>({
      write(chunk) {
        datagramChunks.push(chunk);
      },
    });
  // WebTransportDatagramDuplexStream の全フィールドを実物で満たす。readable は
  // テストが datagram 受信ループを起動しない限り読まれないため空のままにする
  const datagrams: Record<string, unknown> = {
    readable: new ReadableStream<Uint8Array>(),
    maxDatagramSize: 65536,
    incomingMaxAge: null,
    outgoingMaxAge: null,
  };
  if (options.omitDatagramWritable !== true) {
    datagrams["writable"] = datagramWritable;
  }
  if (options.datagramCreateWritable !== undefined) {
    datagrams["createWritable"] = options.datagramCreateWritable;
  }

  // 未使用の受信ストリーム。SessionImpl の受信ループを起動したテストが
  // 明示的に stream を注入する場合だけ使う
  const incomingBidirectionalStreams = new ReadableStream<WebTransportBidirectionalStream>();
  const incomingUnidirectionalStreams = new ReadableStream<ReadableStream<Uint8Array>>();

  const transport = {
    closed,
    reliability: options.reliability,
    createBidirectionalStream: async (): Promise<WebTransportBidirectionalStream> => {
      return createBidirectionalStream().stream;
    },
    createUnidirectionalStream: async (): Promise<WritableStream<Uint8Array>> => {
      const record: SubgroupStreamRecord = {
        closeCount: 0,
        abortCount: 0,
        abortReasons: [],
        writes: [],
      };
      unidirectionalStreams.push(record);
      if (options.unidirectionalStream !== undefined) {
        return options.unidirectionalStream(record);
      }
      return new WritableStream<Uint8Array>({
        write(chunk) {
          record.writes.push(chunk);
        },
        close() {
          record.closeCount += 1;
        },
        abort(reason) {
          record.abortCount += 1;
          record.abortReasons.push(reason);
        },
      });
    },
    incomingBidirectionalStreams,
    incomingUnidirectionalStreams,
    datagrams,
    close(info?: WebTransportCloseInfo): void {
      // close() は close 要求を記録するだけにし、closed の解決はテストが
      // resolveClosed() で明示的に行う。実 WebTransport でも closed の解決は
      // 非同期に届くため、セッション終了処理の途中でコンストラクタの
      // transport.closed ハンドラ (pending の reject 等) が割り込まないようにする。
      closeInfo = info ?? { closeCode: 0, reason: "" };
    },
  } as unknown as WebTransport;

  return {
    transport,
    createBidirectionalStream,
    bidirectionalStreams,
    unidirectionalStreams,
    datagramChunks,
    getCloseInfo: () => closeInfo,
    resolveClosed: (info) => {
      resolveClosed(info ?? { closeCode: 0, reason: "" });
    },
    rejectClosed: (error) => {
      rejectClosed(error);
    },
  };
}

/**
 * 実 SessionImpl にリクエストストリームを登録する
 *
 * 実 WebTransport の createBidirectionalStream() が返した実ストリームを
 * SessionImpl.requestStreams へ登録する。writer は実 WritableStream の writer、
 * controlReader は実物である。
 *
 * @returns 登録したエントリと観測点
 */
export function attachTestRequestStream(
  session: SessionImpl,
  requestId: bigint,
  stream: TestBidirectionalStream,
): {
  stream: WebTransportBidirectionalStream;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  controlReader: ControlStreamReader;
} {
  const controlReader = new ControlStreamReader();
  session.requestStreams.set(requestId, {
    stream: stream.stream,
    writer: stream.writer,
    controlReader,
  });
  return {
    stream: stream.stream,
    writer: stream.writer,
    controlReader,
  };
}

/**
 * セッションの error コールバックで closeWithError を観測する
 *
 * 実 SessionImpl.closeWithError は ConnectCallbacks.error を呼んでから
 * sessionState を closed にするため、このコールバックが closeWithError の
 * 実挙動の観測点になる。SessionError 以外は closeWithError 由来ではないため
 * 記録しない (型を偽装して握り潰さない)。
 */
function createClosedErrorRecorder(callbacks: ConnectCallbacks = {}): {
  callbacks: ConnectCallbacks;
  getClosedWithError: () => SessionError | undefined;
  getClosedWithErrorCount: () => number;
} {
  let closedWithError: SessionError | undefined;
  let closedWithErrorCount = 0;
  const wrapped: ConnectCallbacks = {
    ...callbacks,
    error(error) {
      closedWithErrorCount += 1;
      if (error instanceof SessionError) {
        closedWithError = error;
      }
      callbacks.error?.(error);
    },
  };
  return {
    callbacks: wrapped,
    getClosedWithError: () => closedWithError,
    getClosedWithErrorCount: () => closedWithErrorCount,
  };
}

/**
 * SessionImpl.publish と同じ配線で PublisherImpl を組み立てる
 *
 * セッションは実 SessionImpl であり、PublisherImpl も本番と同じ
 * free function へ配線する。テストが PUBLISH 応答を直接 feed するため、
 * 公開 API publish() の非同期なストリーム生成を待たずに済む。
 */
function createWiredPublisher(
  session: SessionImpl,
  namespace: string[],
  trackName: string,
  requestId: bigint,
  trackAlias: bigint,
): PublisherImpl {
  const bidiSession = asBidiSessionInternal(session);
  const internalSession = asSessionInternal(session);
  const publisher = new PublisherImpl(namespace, trackName, requestId, trackAlias);
  publisher.onSendObject = (params) => publishSendObject(internalSession, publisher, params);
  publisher.onSendDatagram = (params) => publishSendDatagram(internalSession, publisher, params);
  publisher.onSendObjectSkipped = (groupId) => {
    publishMarkStreamOmitted(bidiSession, publisher.getTrackAlias(), groupId);
  };
  publisher.onCloseSubgroup = () => publishCloseSubgroup(bidiSession, publisher.getTrackAlias());
  publisher.onDoneInternal = async (status) => {
    await publishClosePublisherStream(bidiSession, publisher.getTrackAlias());
    await publishSendPublishDone(bidiSession, publisher, status);
  };
  publisher.onNotifyStateChange = (options) =>
    bidiSendPublishStateNotify(bidiSession, publisher, options);
  return publisher;
}

/**
 * 内部状態が空の実 SessionImpl を bidi テスト用に提供する
 *
 * 後始末系 (cancelMalformedTrackPeers など) のテストが、実セッションの
 * Map に実オブジェクトを登録して使う。セッションの型を偽装しない。
 */
export function createTestBidiSession(callbacks: ConnectCallbacks = {}): {
  session: BidiSessionInternal;
  impl: SessionImpl;
} {
  const testTransport = createTestWebTransport();
  const impl = new SessionImpl(testTransport.transport, callbacks);
  impl.controlWriter = new ControlStreamWriter();
  return { session: asBidiSessionInternal(impl), impl };
}

/**
 * 統計・debug 記録の観測用に、内部状態が空の実 SessionImpl を提供する
 *
 * incoming / namespaceLoops のテストは SessionInternal の free function を直接
 * 呼ぶが、セッション自体は実 SessionImpl でなければならない。統計カウンタ、
 * debug コールバック、closeWithError の後始末はいずれも SessionImpl の実装が
 * 持つ振る舞いであり、オブジェクトリテラルで代用すると観測対象が実装から
 * ずれる。SessionImpl の private フィールドは構造的部分型の判定に現れないため、
 * SessionInternal として参照する箇所だけ境界キャストする。
 */
export function createTestSessionInternal(callbacks: ConnectCallbacks = {}): {
  session: SessionInternal;
  impl: SessionImpl;
} {
  const testTransport = createTestWebTransport();
  const impl = new SessionImpl(testTransport.transport, callbacks);
  impl.controlWriter = new ControlStreamWriter();
  return { session: asSessionInternal(impl), impl };
}

/**
 * 実 SessionImpl 上に bidi 送信系テスト用のセッションを構築する
 *
 * SessionImpl.publish が受け取る Request ID は 0n から始まるが、テストは
 * 100n を fill の Request ID として期待するため nextRequestId を 100n にする。
 * peerMaxFilterRanges は Range Filter の上限検証テストが 2 を前提にする。
 * requestStreams には SubscriberImpl の Request ID (0n) の実ストリームを登録する。
 */
export function createBidiSession(
  options: {
    /**
     * 双方向ストリームの writable sink。write 失敗などの失敗注入に使う。
     * 省略時は write を記録するだけの sink になる。
     */
    bidiSink?: () => UnderlyingSink<Uint8Array>;
    /** セッション終了 (error 通知) を観測するためのコールバック */
    callbacks?: ConnectCallbacks;
  } = {},
): {
  session: BidiSessionInternal;
  written: Uint8Array[];
  /** 実 SessionImpl.closeWithError の観測点 */
  closeObserver: {
    closed: () => SessionError | undefined;
    count: () => number;
  };
} {
  const recorder = createClosedErrorRecorder(options.callbacks);
  const testTransport = createTestWebTransport(
    options.bidiSink !== undefined ? { bidiSink: options.bidiSink } : {},
  );
  const session = new SessionImpl(testTransport.transport, recorder.callbacks);
  session.nextRequestId = 100n;
  session.peerMaxFilterRanges = 2;
  session.controlWriter = new ControlStreamWriter();
  const requestStream = testTransport.createBidirectionalStream();
  attachTestRequestStream(session, 0n, requestStream);
  return {
    session: asBidiSessionInternal(session),
    written: requestStream.written,
    closeObserver: {
      closed: recorder.getClosedWithError,
      count: recorder.getClosedWithErrorCount,
    },
  };
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
 * 実 W3C ストリームと実 SessionImpl で publish ロール用の session を構築する
 *
 * ストリーム機構は実物であり、失敗注入点は writable sink のみ。
 * `written` は実 WritableStream の sink が受け取った chunk を到着順に記録する。
 * 購読単位の状態 (Range Filter など) を検証するテストのため、datagram の
 * sink が受け取った chunk も返す。
 */
export function createPublishReadTestContext(
  writableSink: UnderlyingSink<Uint8Array>,
  authTokenCacheSize = 0,
  options: {
    /**
     * 単方向ストリーム (Subgroup) の factory。省略時は write を記録するだけの
     * sink になる。write の完了タイミングを制御するテストで使う。
     */
    unidirectionalStream?: (
      record: SubgroupStreamRecord,
    ) => WritableStream<Uint8Array> | Promise<WritableStream<Uint8Array>>;
  } = {},
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
  datagramChunks: Uint8Array[];
} {
  const requestId = 10n;
  const recorder = createClosedErrorRecorder();
  const testTransport = createTestWebTransport({
    bidiSink: () => writableSink,
    ...(options.unidirectionalStream !== undefined
      ? { unidirectionalStream: options.unidirectionalStream }
      : {}),
  });
  const session = new SessionImpl(testTransport.transport, recorder.callbacks);
  session.nextRequestId = 100n;
  // draft-ietf-moq-transport-23 §8.9 / §9.1.3:
  // 受信 AUTHORIZATION TOKEN のキャッシュ。既定は上限 0 (未広告 = Alias 使用禁止) で、
  // Alias を使うテストは authTokenCacheSize を指定する。
  session.receivedAuthTokens = new AuthTokenCache(authTokenCacheSize);
  session.controlWriter = new ControlStreamWriter();
  const requestStream = testTransport.createBidirectionalStream();
  const requestStreamInfo = attachTestRequestStream(session, requestId, requestStream);

  // SessionImpl.publish と同じ配線 (Subgroup ストリームへの Object 送信と省略の記録)
  const publisher = createWiredPublisher(session, ["test"], "track", requestId, 1n);
  session.publishers.set(requestId, publisher);

  return {
    session: asBidiSessionInternal(session),
    stream: requestStreamInfo.stream,
    readableController: requestStream.readableController,
    events: requestStream.events,
    written: requestStream.written,
    // 値コピーではなく getter で返す (closeWithError 呼び出し後の代入を反映する)
    get closedWithError(): SessionError | undefined {
      return recorder.getClosedWithError();
    },
    get closedWithErrorCount(): number {
      return recorder.getClosedWithErrorCount();
    },
    publisher,
    requestId,
    controlReader: requestStreamInfo.controlReader,
    subgroupStreams: testTransport.unidirectionalStreams,
    datagramChunks: testTransport.datagramChunks,
  };
}

/**
 * テスト用に実 SessionImpl を閉じる
 *
 * 型上 readonly の sessionState を書き換えるのではなく、実 API の close() を
 * 呼ぶ。close() は sessionState を同期的に "closed" にし、pending の reject と
 * 保持ストリームの abort を本番と同じく行う。
 */
export function forceSessionClosed(session: BidiSessionInternal): void {
  // 呼び出し元は実 SessionImpl を渡す契約だが、BidiSessionInternal には
  // close() が現れないため、実装 (SessionImpl) の実メソッドを呼ぶための
  // 境界キャストを行う。状態を直接書き換える偽装ではない。
  const impl = session as unknown as SessionImpl;
  void impl.close();
}

/**
 * End Group が 2^64-1 を超える LOCATION_FILTER パラメータを組み立てる
 *
 * draft-ietf-moq-transport-23 §9.19.9 の Location Filter Type ベース表現で、
 * StartGroup + EndGroupDelta が超過する値を手組みする。
 * encodeLocationFilterParameter は送信前に throw するためエンコーダでは
 * 組み立てられない。4 フィールド表現 (EndObject 付き) も対象にする。
 */
export function buildOverflowingLocationFilterParameter(withEndObject = false): {
  type: number;
  value: Uint8Array;
} {
  // Type 0x03 (または 0x04) + StartGroup=MAX_VARINT + StartObject=0 + EndGroupDelta=1
  // End Group = MAX_VARINT + 1 で 2^64-1 超過
  const rawFields = [
    encodeVarint(withEndObject ? 0x04n : 0x03n),
    encodeVarint(MAX_VARINT),
    encodeVarint(0n),
    encodeVarint(1n),
  ];
  if (withEndObject) {
    rawFields.push(encodeVarint(0n));
  }
  const value = new Uint8Array(rawFields.flatMap((part) => [...part]));
  return { type: MessageParameterType.LOCATION_FILTER, value };
}

/**
 * PUBLISH 応答 (REQUEST_OK) の生メッセージを feed する検証用セッションを構築する
 *
 * 指定した 1 通だけを実 readable へ enqueue し、ピアの FIN も再現する。
 * 解決・拒否・セッション終了の観測点を返す。PUBLISH_OK 受信時の値検証に使う。
 * 観測点はゲッター関数で返す (生成コンテキストごとの参照安定性のため)。
 */
export function createPublishResponseValidationContext(okMessage: Uint8Array): {
  session: BidiSessionInternal;
  stream: WebTransportBidirectionalStream;
  readableController: ReadableStreamDefaultController<Uint8Array>;
  controlReader: ControlStreamReader;
  written: Uint8Array[];
  events: string[];
  publisher: PublisherImpl;
  resolved: () => Publisher | undefined;
  rejected: () => Error | undefined;
  closedWithError: () => SessionError | undefined;
  getClosedWithErrorCount: () => number;
  /** reject と close の発生順 (同一オブジェクト性と順序の検証用) */
  order: string[];
  requestId: bigint;
} {
  const requestId = 10n;
  const order: string[] = [];
  let closedError: SessionError | undefined;
  let closedWithErrorCount = 0;
  const testTransport = createTestWebTransport();
  const session = new SessionImpl(testTransport.transport, {
    error(error) {
      order.push("close");
      closedWithErrorCount += 1;
      if (error instanceof SessionError) {
        closedError = error;
      }
    },
  });
  session.nextRequestId = 100n;
  session.controlWriter = new ControlStreamWriter();
  const requestStream = testTransport.createBidirectionalStream();
  const requestStreamInfo = attachTestRequestStream(session, requestId, requestStream);

  // 応答メッセージを実 readable へ enqueue し、ピアの FIN も再現する
  requestStream.readableController.enqueue(okMessage);
  requestStream.readableController.close();

  let resolvedPublisher: Publisher | undefined;
  let rejectedError: Error | undefined;
  const publisher = new PublisherImpl(["test"], "track", requestId, 1n);
  session.pendingPublish.set(requestId, {
    impl: publisher,
    resolve: (value: Publisher) => {
      resolvedPublisher = value;
    },
    reject: (error: Error) => {
      order.push("reject");
      rejectedError = error;
    },
  });

  return {
    session: asBidiSessionInternal(session),
    stream: requestStreamInfo.stream,
    readableController: requestStream.readableController,
    controlReader: requestStreamInfo.controlReader,
    written: requestStream.written,
    events: requestStream.events,
    publisher,
    resolved: () => resolvedPublisher,
    rejected: () => rejectedError,
    closedWithError: () => closedError,
    getClosedWithErrorCount: () => closedWithErrorCount,
    order,
    requestId,
  };
}

/**
 * PUBLISH_OK 応答の LOCATION_FILTER 検証を駆動するセッションを構築する
 *
 * 指定パラメータの PUBLISH_OK を ReadableStream に 1 通だけ enqueue し、
 * 解決・拒否・セッション終了の観測点を返す。PUBLISH_OK 受信時の値検証に使う。
 */
export function createPublishOkValidationContext(
  parameters: { type: number; value: Uint8Array }[],
): ReturnType<typeof createPublishResponseValidationContext> {
  const okPayload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters,
    trackProperties: [],
  });
  const okMessage = new ControlStreamWriter().encode(MessageType.REQUEST_OK, okPayload);
  return createPublishResponseValidationContext(okMessage);
}

/**
 * 応答読み取り用の session を実 SessionImpl で構築する
 */
export function createOkResponseReadTestContext(): {
  session: BidiSessionInternal;
  stream: WebTransportBidirectionalStream;
  readableController: ReadableStreamDefaultController<Uint8Array>;
  controlReader: ControlStreamReader;
  controlWriter: ControlStreamWriter;
  getClosedWithError: () => SessionError | undefined;
  getClosedWithErrorCount: () => number;
  order: string[];
  requestId: bigint;
} {
  const requestId = 10n;
  const order: string[] = [];
  const recorder = createClosedErrorRecorder({
    error() {
      // reject → closeWithError の順序を記録する
      order.push("close");
    },
  });
  const testTransport = createTestWebTransport();
  const session = new SessionImpl(testTransport.transport, recorder.callbacks);
  session.nextRequestId = 100n;
  session.controlWriter = new ControlStreamWriter();
  const requestStream = testTransport.createBidirectionalStream();
  const requestStreamInfo = attachTestRequestStream(session, requestId, requestStream);

  return {
    session: asBidiSessionInternal(session),
    stream: requestStreamInfo.stream,
    readableController: requestStream.readableController,
    controlReader: requestStreamInfo.controlReader,
    controlWriter: session.controlWriter,
    // 値コピーではなく getter で返す (closeWithError 呼び出し後の代入を反映する)
    getClosedWithError: recorder.getClosedWithError,
    getClosedWithErrorCount: recorder.getClosedWithErrorCount,
    order,
    requestId,
  };
}

/**
 * SUBSCRIBE_OK / FETCH_OK の MalformedTrackError 経路で bidi ストリームが
 * cancel されることを観測するための実 SessionImpl を構築する
 *
 * readable の cancel (STOP_SENDING 相当) と writable の abort (RESET_STREAM
 * 相当) の到達理由を実ストリームで記録する。
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
  const recorder = createClosedErrorRecorder();
  // writable の abort (RESET_STREAM 相当) は実 WritableStream の abort ハンドラで
  // TestBidirectionalStream.aborted に記録されるため、専用の sink は要らない
  const testTransport = createTestWebTransport();
  const session = new SessionImpl(testTransport.transport, recorder.callbacks);
  session.nextRequestId = 100n;
  session.controlWriter = new ControlStreamWriter();
  const requestStream = testTransport.createBidirectionalStream();
  const requestStreamInfo = attachTestRequestStream(session, requestId, requestStream);
  return {
    session: asBidiSessionInternal(session),
    stream: requestStreamInfo.stream,
    readableController: requestStream.readableController,
    controlReader: requestStreamInfo.controlReader,
    controlWriter: session.controlWriter,
    requestId,
    cancelled: requestStream.cancelled,
    aborted: requestStream.aborted,
    getClosedWithError: recorder.getClosedWithError,
  };
}

/**
 * 確立後の FETCH 応答ストリーム読み取りを検証するための実 SessionImpl を構築する
 *
 * draft-ietf-moq-transport-23 §3.2 / §9.3 / §9.11 / §9.5 / §9.10:
 * FETCH の成功応答 (REQUEST_OK / FETCH_OK) を最初の応答として与え、pendingFetch を
 * 解決して fetchers に登録する。要求範囲はフィルタなし ({0, 0} から Largest Object
 * まで) とし、応答の LARGEST_OBJECT を {0, 0} にして終端を {0, 0} に確定させる。
 * fetch ロールの読み取りループ (bidiReadRequestStreamMessages) が当該双方向
 * ストリームを読み続けることを、実 W3C ストリームと実 SessionImpl で検証する。
 *
 * `additionalMessages` は FETCH の成功応答と同一チャンクに連結するメッセージ列である
 * (bidiDispatchResponse が context.remainingMessages に保持する分を再現する)。
 * 呼び出し側は返り値の additionalMessages へ push したうえで flushInitialChunk() を
 * 呼び、応答を読ませる。これにより組み立てに controlWriter を要する
 * メッセージも連結できる。ピアの FIN を送るテストは readableController.close() を
 * 明示的に呼ぶ。
 *
 * `getClosedWithErrorCount` を返すのは、セッション終了後に同一チャンクの
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
  /** FETCH の成功応答と同一チャンクに連結するメッセージ列 (flushInitialChunk 前に push する) */
  additionalMessages: Uint8Array[];
  /** 成功応答と additionalMessages を 1 チャンクとして enqueue する */
  flushInitialChunk: () => void;
  /** written は値コピーではなく現在の配列を参照する (append を反映する) */
  written: Uint8Array[];
  getClosedWithError: () => SessionError | undefined;
  getClosedWithErrorCount: () => number;
} {
  const requestId = 10n;
  const recorder = createClosedErrorRecorder();
  const testTransport = createTestWebTransport();
  const session = new SessionImpl(testTransport.transport, recorder.callbacks);
  session.nextRequestId = 100n;
  session.controlWriter = new ControlStreamWriter();
  const requestStream = testTransport.createBidirectionalStream();
  const requestStreamInfo = attachTestRequestStream(session, requestId, requestStream);

  const fetcher = new FetcherImpl(["test"], "track", requestId, () => {});
  session.pendingFetch.set(requestId, {
    impl: fetcher,
    resolve: () => {},
    reject: () => {},
  });

  // FETCH の成功応答 (REQUEST_OK) を最初の応答として組み立てる。
  // フィルタなしの要求範囲 ({0, 0} から Largest Object まで) に対する応答として、
  // LARGEST_OBJECT {0, 0} を載せ、応答の終端を {0, 0} に確定させる。
  // 同一チャンクに連結するメッセージは呼び出し側が additionalMessages へ push し、
  // flushInitialChunk() で 1 チャンクとして enqueue する。連結されたメッセージは
  // bidiDispatchResponse が context.remainingMessages に保持する。
  const fetchOkPayload = encodeRequestOkPayload({
    type: MessageType.REQUEST_OK,
    parameters: [
      {
        type: MessageParameterType.LARGEST_OBJECT,
        value: encodeLocation({ group: 0n, object: 0n }),
      },
    ],
    trackProperties: [],
  });

  return {
    session: asBidiSessionInternal(session),
    stream: requestStreamInfo.stream,
    readableController: requestStream.readableController,
    controlReader: requestStreamInfo.controlReader,
    controlWriter: session.controlWriter,
    requestId,
    fetcher,
    additionalMessages,
    written: requestStream.written,
    flushInitialChunk: () => {
      requestStream.readableController.enqueue(
        concatUint8Arrays([
          session.controlWriter!.encode(MessageType.REQUEST_OK, fetchOkPayload),
          ...additionalMessages,
        ]),
      );
    },
    // 値コピーではなく getter で返す (closeWithError 呼び出し後の代入を反映する)
    getClosedWithError: recorder.getClosedWithError,
    getClosedWithErrorCount: recorder.getClosedWithErrorCount,
  };
}
