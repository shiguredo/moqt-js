/**
 * 受信系 free function 群
 *
 * SessionImpl の handleIncomingDatagram / waitForFetcher /
 * processFetchObjects ラッパー / processSubgroupObjects ラッパー
 * と、受信 bidi ストリームの先頭メッセージの 3 分類ディスパッチ
 * (incomingClassifyFirstBidiMessage / incomingSendRequestErrorAndClose /
 * incomingHandleFirstBidiMessage) を free function として抽出する。
 *
 * handleIncomingStream / handleSubgroupStream は SessionImpl に残留する
 * （状態結合が強いため）。
 */

import { decodeVarint } from "../varint";
import { decodeObjectDatagram, type MoqtObject } from "../dataStream";
import { ObjectStatus, MessageType, encodeRequestErrorPayload } from "../message";
import { RequestErrorCode, SessionError, SessionErrorCode } from "../error";
import { ControlStreamWriter, type ControlMessage } from "../controlStream";
import { toProtocolViolationSessionError } from "./errors";
import {
  processFetchObjects as streamProcessFetchObjects,
  processSubgroupObjects as streamProcessSubgroupObjects,
} from "./stream";
import type { FetcherImpl } from "../fetcher";
import type { SubscriberImpl } from "../subscriber";
import type { SessionInternal } from "./types";

// ============================================================================
// 受信 bidi ストリームの先頭メッセージ 3 分類
// ============================================================================

/**
 * 受信 bidi ストリームの先頭メッセージを 3 分類する
 *
 * draft-ietf-moq-transport-19 §3.3 (Session initialization):
 * リクエストストリームの先頭として許可されるメッセージは 7 種
 * (TRACK_STATUS / SUBSCRIBE / PUBLISH / FETCH / PUBLISH_NAMESPACE /
 * SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS)。
 * - "publish": 対応済み (moqt-js はクライアントのため受信 PUBLISH のみ処理する)
 * - "unsupported-request": 7 種のうち未対応の 6 種。
 *   draft-ietf-moq-transport-19 §4 (Extensibility):
 *   「Limited endpoints SHOULD respond to any unsupported messages with the
 *   appropriate NOT_SUPPORTED error code, rather than ignoring them.」
 * - "protocol-violation": 7 種以外 (未知タイプ等)。
 *   draft-ietf-moq-transport-19 §3.3:
 *   「Bidirectional streams MUST NOT begin with any other message type unless
 *   negotiated. If they do, the peer MUST close the Session with a
 *   PROTOCOL_VIOLATION.」
 */
export function incomingClassifyFirstBidiMessage(
  type: number,
): "publish" | "unsupported-request" | "protocol-violation" {
  switch (type) {
    case MessageType.PUBLISH:
      return "publish";
    case MessageType.TRACK_STATUS:
    case MessageType.SUBSCRIBE:
    case MessageType.FETCH:
    case MessageType.PUBLISH_NAMESPACE:
    case MessageType.SUBSCRIBE_NAMESPACE:
    case MessageType.SUBSCRIBE_TRACKS:
      return "unsupported-request";
    default:
      return "protocol-violation";
  }
}

/**
 * REQUEST_ERROR を送信し、送信方向を FIN で閉じた後に受信方向をキャンセルする
 *
 * draft-ietf-moq-transport-19 §3.3.3 (Request Cancellation and Rejection):
 * 「When an endpoint rejects a request without performing any application
 * processing, it SHOULD send a REQUEST_ERROR and FIN the stream.」
 * draft-ietf-moq-transport-19 §10.19 (SUBSCRIBE_TRACKS):
 * 「If it is an error, the stream will be closed via FIN after REQUEST_ERROR
 * is sent.」
 *
 * FIN (writer.close()) は writer.releaseLock() の前に実行する。
 * releaseLock 後の close() は WHATWG Streams 仕様上、ロック非保持時に
 * TypeError で reject する Promise を返すため、try ブロック内で await し
 * catch で吸収する。受信方向 (readable) は FIN 送信後に cancel() で閉じる
 * (draft-ietf-moq-transport-19 §3.3.3 の STOP_SENDING 相当)。
 */
export async function incomingSendRequestErrorAndClose(
  stream: WebTransportBidirectionalStream,
  errorCode: RequestErrorCode,
  reasonPhrase: string,
): Promise<void> {
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  try {
    writer = stream.writable.getWriter();
    const errorPayload = encodeRequestErrorPayload({
      type: MessageType.REQUEST_ERROR,
      errorCode: BigInt(errorCode),
      retryInterval: 0n,
      reasonPhrase,
    });
    const controlWriter = new ControlStreamWriter();
    const framed = controlWriter.encode(MessageType.REQUEST_ERROR, errorPayload);
    await writer.write(framed);
    await writer.close();
  } catch {
    // ストリームが既に閉じている場合は無視。
    // write が失敗するのは writable がエラー状態 (ピアの RESET_STREAM /
    // セッション終了等) の場合であり、その場合は close() を試行しても
    // 失敗するだけのため FIN は送信しない。ストリームは QUIC レベルで
    // 既にクローズされており、リソースリークは発生しない。
  } finally {
    if (writer !== null) {
      try {
        writer.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }
  try {
    await stream.readable.cancel("request rejected");
  } catch {
    /* ignore */
  }
}

/**
 * 受信 Request ID のパリティ・重複検証を行う
 *
 * draft-ietf-moq-transport-19 §10.1 (Request ID):
 * "The client generates even numbered Request IDs, starting at 0, and the
 *  server generates odd numbered Request IDs, starting at 1. Each endpoint
 *  increments its Request ID by 2 for each new request."
 * "If an endpoint receives a Request ID where the least significant bit is
 *  incorrect for the sender, or a duplicate Request ID, it MUST close the
 *  session with INVALID_REQUEST_ID."
 *
 * moqt-js は WebTransport 専用クライアントであり常に client ロールのため、
 * 受信 PUBLISH の Request ID はサーバー発の奇数が期待値となる。
 *
 * パリティ・重複検証と receivedRequestIds への add を同一の同期ブロックで
 * 行う。受信 bidi ストリーム処理は fire-and-forget で並行実行されるため、
 * 検証と add の間に await を挟むと同一 ID の 2 本が同時に検証を通過し得る。
 * Set には add のみ行い、リクエスト完了後も削除しない (§10.1 の重複禁止は
 * セッション内での再出現の禁止であり、Map エントリの削除後も検出できる
 * 必要がある)。
 *
 * @returns 検証に合格した場合は true、違反で closeSession を呼んだ場合は false
 */
export function incomingValidateRequestId(
  requestId: bigint,
  receivedRequestIds: Set<bigint>,
  closeSession: (error: SessionError) => void,
): boolean {
  // draft-ietf-moq-transport-19 §10.1:
  // moqt-js はクライアントロールのため、受信 Request ID は奇数 (サーバー発) が期待値。
  // LSB が 0 (偶数) はパリティ違反。
  if ((requestId & 1n) === 0n) {
    closeSession(
      new SessionError(
        `invalid request id parity: ${requestId}, expected odd (server-generated)`,
        SessionErrorCode.INVALID_REQUEST_ID,
      ),
    );
    return false;
  }

  // draft-ietf-moq-transport-19 §10.1:
  // 同一 Request ID の再出現は INVALID_REQUEST_ID。
  // add は検証と同じ同期ブロック内で行い、拒否経路で return される PUBLISH も
  // Request ID を消費したものとして記録する (§10.1「Each SUBSCRIBE, PUBLISH,
  // FETCH, SUBSCRIBE_NAMESPACE, SUBSCRIBE_TRACKS, PUBLISH_NAMESPACE,
  // REQUEST_UPDATE, and TRACK_STATUS message consumes a Request ID」)。
  if (receivedRequestIds.has(requestId)) {
    closeSession(
      new SessionError(`duplicate request id: ${requestId}`, SessionErrorCode.INVALID_REQUEST_ID),
    );
    return false;
  }
  receivedRequestIds.add(requestId);
  return true;
}

/**
 * 受信 bidi ストリームの先頭メッセージを 3 分類してディスパッチする
 *
 * - 分類 1 (publish): false を返し、呼び出し側で従来の受信 PUBLISH 処理を
 *   継続させる。
 * - 分類 2 (unsupported-request): REQUEST_ERROR (NOT_SUPPORTED) を応答して
 *   FIN で閉じ、true を返す。セッションは閉じない (§4 SHOULD)。
 * - 分類 3 (protocol-violation): PROTOCOL_VIOLATION でセッションを閉じ、
 *   true を返す (§3.3 MUST)。
 *
 * @returns 先頭メッセージの処理を完了した場合は true、従来の PUBLISH 処理を
 *          継続する場合は false
 */
export async function incomingHandleFirstBidiMessage(
  session: SessionInternal,
  stream: WebTransportBidirectionalStream,
  firstMsg: ControlMessage,
): Promise<boolean> {
  const classification = incomingClassifyFirstBidiMessage(firstMsg.type);
  if (classification === "publish") {
    return false;
  }
  if (classification === "unsupported-request") {
    // 受信メッセージをデバッグ出力する (moqlog / debug コールバックで
    // 未対応リクエストの受信を観測できるようにする)
    session.emitDebug("recv", firstMsg.type, firstMsg.payload);
    // draft-ietf-moq-transport-19 §4 (Extensibility):
    // 未対応メッセージには NOT_SUPPORTED を応答する (SHOULD。引用は
    // incomingClassifyFirstBidiMessage の docstring 参照)。
    // ペイロードをデコードしないため、各メッセージ節の MUST 検証
    // (§10.1 の Request ID パリティ・重複、§10.19 の Track Namespace Prefix
    // 32 フィールド上限等) は分類 2 では適用されない (残余リスク。
    // Request ID 検証は受信 PUBLISH (分類 1) のみに適用される)。
    await incomingSendRequestErrorAndClose(
      stream,
      RequestErrorCode.NOT_SUPPORTED,
      "request type not supported",
    );
    return true;
  }
  // 7 種以外のメッセージタイプで始まる双方向ストリームは PROTOCOL_VIOLATION
  // draft-ietf-moq-transport-19 §3.3
  session.closeWithError(
    new SessionError(
      `expected a request message as first message on incoming bidirectional stream, got 0x${firstMsg.type.toString(16)}`,
      SessionErrorCode.PROTOCOL_VIOLATION,
    ),
  );
  return true;
}

/**
 * 受信した datagram を処理する
 *
 * draft-ietf-moq-transport-19 §11.5.2 (Padding Datagrams):
 * "The receiver MUST discard all data received in a padding datagram."
 *
 * draft-ietf-moq-transport-19 §11.3.1 (Object Datagram):
 * Track Alias で Subscriber を検索し、filter 再適用して配送する。
 */
export function incomingHandleDatagram(session: SessionInternal, data: Uint8Array): void {
  try {
    // PADDING datagram (0x132b3e29) を varint type のデコードで判定する
    if (data.length > 0) {
      const [datagramType] = decodeVarint(data, 0);
      if (Number(datagramType) === 0x132b3e29) {
        return;
      }
    }

    const [datagram] = decodeObjectDatagram(data);

    // Track Alias で Subscriber を検索（draft-19 §5.1: 同一 alias に複数 subscription あり得る）
    const subscribers = session.subscribersByAlias.get(datagram.trackAlias);
    if (!subscribers || subscribers.length === 0) {
      return;
    }

    const object: MoqtObject = {
      groupId: datagram.groupId,
      subgroupId: undefined,
      objectId: datagram.objectId,
      publisherPriority: datagram.publisherPriority,
      status: datagram.status ?? ObjectStatus.NORMAL,
      properties: datagram.properties,
      payload: datagram.payload ?? new Uint8Array(0),
    };

    // 各 subscription に filter 再適用して配送
    for (const subscriber of subscribers) {
      if (subscriber.hasDatagramCallback()) {
        subscriber.handleDatagram(object);
      } else {
        subscriber.handleObject(object);
      }
    }
  } catch (err) {
    session.callbacks.debug?.({
      direction: "recv",
      type: 0,
      typeName: "DATAGRAM_DECODE_ERROR",
      payload: data,
      decoded: {
        error: err instanceof Error ? err.message : String(err),
      },
      timestamp: Date.now(),
    });
    // ProtocolViolationError / IncompleteDataError は仕様違反として PROTOCOL_VIOLATION でセッションを閉じる
    const sessionError = toProtocolViolationSessionError(err);
    if (sessionError !== null) {
      session.closeWithError(sessionError);
    }
  }
}

/**
 * Fetcher の登録を待つ
 *
 * draft-ietf-moq-transport-19 Section 10.13 (FETCH_OK):
 * "A publisher MAY send Objects in response to a FETCH before the
 *  FETCH_OK message is sent."
 * FETCH_OK より先にデータストリームが到着した場合に使用。
 */
export function incomingWaitForFetcher(
  session: SessionInternal,
  requestId: bigint,
): Promise<FetcherImpl | null> {
  return new Promise<FetcherImpl | null>((resolve) => {
    // 既に登録されている場合は即座に返す
    const existing = session.fetchers.get(requestId);
    if (existing) {
      resolve(existing);
      return;
    }

    // pendingFetch に存在しない場合は不明なリクエスト
    if (!session.pendingFetch.has(requestId)) {
      resolve(null);
      return;
    }

    let resolved = false;

    const doResolve = () => {
      if (resolved) return;
      resolved = true;
      resolve(session.fetchers.get(requestId) ?? null);
    };

    // コールバックを登録
    const callbacks = session.fetcherReadyCallbacks.get(requestId) ?? [];
    callbacks.push(doResolve);
    session.fetcherReadyCallbacks.set(requestId, callbacks);

    // タイムアウト: 5 秒以内に FETCH_OK が来なければ null
    setTimeout(doResolve, 5000);
  });
}

/**
 * Fetch オブジェクトのストリーミング処理ラッパー
 *
 * 統計カウンターを stream.ts の純粋関数に注入する薄いブリッジ。
 * SessionImpl.handleIncomingStream から呼ばれる。
 */
export function incomingProcessFetchObjects(
  session: SessionInternal,
  buffer: Uint8Array,
  fetcher: FetcherImpl,
  context: import("../dataStream").FetchObjectContext | null,
  isFirst: boolean,
): {
  remainingBuffer: Uint8Array;
  context: import("../dataStream").FetchObjectContext | null;
  isFirst: boolean;
} {
  return streamProcessFetchObjects(
    buffer,
    fetcher,
    context,
    isFirst,
    {
      incrementObjectsReceived: () => {
        (session as unknown as { statsObjectsReceivedViaFetch: number })
          .statsObjectsReceivedViaFetch++;
      },
      incrementBytesReceived: (_subscribePath, bytes) => {
        (session as unknown as { statsBytesReceivedViaFetch: number }).statsBytesReceivedViaFetch +=
          bytes;
      },
    },
    fetcher.getGroupOrder(),
  );
}

/**
 * Subgroup オブジェクトのストリーミング処理ラッパー
 *
 * 統計カウンターを stream.ts の純粋関数に注入する薄いブリッジ。
 * SessionImpl.handleSubgroupStream から呼ばれる。
 */
export function incomingProcessSubgroupObjects(
  session: SessionInternal,
  buffer: Uint8Array,
  subscribers: SubscriberImpl[],
  header: import("../dataStream").SubgroupHeader,
  previousObjectId: bigint,
): { remainingBuffer: Uint8Array; previousObjectId: bigint } {
  return streamProcessSubgroupObjects(buffer, subscribers, header, previousObjectId, {
    incrementObjectsReceived: () => {
      (session as unknown as { statsObjectsReceivedViaSubscribe: number })
        .statsObjectsReceivedViaSubscribe++;
    },
    incrementBytesReceived: (_subscribePath, bytes) => {
      (
        session as unknown as { statsBytesReceivedViaSubscribe: number }
      ).statsBytesReceivedViaSubscribe += bytes;
    },
  });
}
