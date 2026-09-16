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
import {
  decodeDatagramTypeAndTrackAlias,
  decodeObjectDatagram,
  type MoqtObject,
  type ObjectDatagram,
} from "../dataStream";
import {
  ObjectStatus,
  MessageType,
  encodeRequestErrorPayload,
  decodeTrackNamespace,
  isRejectedReceiveNamespace,
} from "../message";
import type { GroupOrder } from "../message/types";
import { RequestErrorCode, SessionError, SessionErrorCode, MalformedTrackError } from "../error";
import { ControlStreamWriter, type ControlMessage } from "../controlStream";
import { toSessionCloseError } from "./errors";
import { cancelMalformedTrackPeers } from "./bidi";
import {
  processFetchObjects as streamProcessFetchObjects,
  processSubgroupObjects as streamProcessSubgroupObjects,
  type FetchObjectSink,
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
 * draft-ietf-moq-transport-21 §6.3 (Session initialization):
 * リクエストストリームの先頭として許可されるメッセージは 7 種
 * (TRACK_STATUS / SUBSCRIBE / PUBLISH / FETCH / PUBLISH_NAMESPACE /
 * SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS)。
 * - "publish": 対応済み (moqt-js はクライアントのため受信 PUBLISH のみ処理する)
 * - "unsupported-request": 7 種のうち未対応の 6 種。
 *   draft-ietf-moq-transport-21 §1.5 (Extensibility):
 *   「Limited endpoints SHOULD respond to any unsupported messages with the
 *   appropriate NOT_SUPPORTED error code, rather than ignoring them.」
 * - "protocol-violation": 7 種以外 (未知タイプ等)。
 *   draft-ietf-moq-transport-21 §6.3:
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
 * draft-ietf-moq-transport-21 §6.4.2.3 (Request Cancellation and Rejection):
 * 「When an endpoint rejects a request without performing any application
 * processing, it SHOULD send a REQUEST_ERROR and FIN the stream.」
 * draft-ietf-moq-transport-21 §9.18 (SUBSCRIBE_TRACKS):
 * 「If it is an error, the stream will be closed via FIN after REQUEST_ERROR
 * is sent.」
 *
 * FIN (writer.close()) は writer.releaseLock() の前に実行する。
 * releaseLock 後の close() は WHATWG Streams 仕様上、ロック非保持時に
 * TypeError で reject する Promise を返すため、try ブロック内で await し
 * catch で吸収する。受信方向 (readable) は FIN 送信後に cancel() で閉じる
 * (draft-ietf-moq-transport-21 §6.4.2.3 の STOP_SENDING 相当)。
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
 * draft-ietf-moq-transport-21 §6.4.2.1 (Request ID):
 * "The client generates even numbered Request IDs, starting at 0, and the
 *  server generates odd numbered Request IDs, starting at 1. Each endpoint
 *  increments its Request ID by 2 for each new request."
 * "If an endpoint receives a Request ID where the least significant bit is
 *  incorrect for the sender, or a duplicate Request ID, it MUST close the
 *  session with INVALID_REQUEST_ID."
 *
 * moqt-js は WebTransport 専用クライアントであり常に client ロールのため、
 * 受信リクエストの Request ID はサーバー発の奇数が期待値となる。
 *
 * パリティ・重複検証と receivedRequestIds への add を同一の同期ブロックで
 * 行う。受信 bidi ストリーム処理は fire-and-forget で並行実行されるため、
 * 検証と add の間に await を挟むと同一 ID の 2 本が同時に検証を通過し得る。
 * Set には add のみ行い、リクエスト完了後も削除しない (§6.4.2.1 の重複禁止は
 * セッション内での再出現の禁止であり、Map エントリの削除後も検出できる
 * 必要がある)。
 *
 * 違反時は INVALID_REQUEST_ID の SessionError を返す。セッションを閉じるのは
 * 呼び出し側の責務である (他の検証関数と同じエラー返却型)。
 *
 * @returns 検証に合格した場合は null、違反の場合は SessionError
 */
export function incomingValidateRequestId(
  requestId: bigint,
  receivedRequestIds: Set<bigint>,
): SessionError | null {
  // draft-ietf-moq-transport-21 §6.4.2.1:
  // moqt-js はクライアントロールのため、受信 Request ID は奇数 (サーバー発) が期待値。
  // LSB が 0 (偶数) はパリティ違反。
  if ((requestId & 1n) === 0n) {
    return new SessionError(
      `invalid request id parity: ${requestId}, expected odd (server-generated)`,
      SessionErrorCode.INVALID_REQUEST_ID,
    );
  }

  // draft-ietf-moq-transport-21 §6.4.2.1:
  // 同一 Request ID の再出現は INVALID_REQUEST_ID。
  // add は検証と同じ同期ブロック内で行い、拒否経路で return されるリクエストも
  // Request ID を消費したものとして記録する (§6.4.2.1「Each SUBSCRIBE, PUBLISH,
  // FETCH, SUBSCRIBE_NAMESPACE, SUBSCRIBE_TRACKS, PUBLISH_NAMESPACE,
  // REQUEST_UPDATE, and TRACK_STATUS message consumes a Request ID」)。
  if (receivedRequestIds.has(requestId)) {
    return new SessionError(
      `duplicate request id: ${requestId}`,
      SessionErrorCode.INVALID_REQUEST_ID,
    );
  }
  receivedRequestIds.add(requestId);
  return null;
}

/**
 * 受信 bidi ストリームの先頭メッセージを 3 分類してディスパッチする
 *
 * - 分類 1 (publish): false を返し、呼び出し側で従来の受信 PUBLISH 処理を
 *   継続させる。
 * - 分類 2 (unsupported-request): 先頭 varint を Request ID として検証し、
 *   REQUEST_ERROR (NOT_SUPPORTED) を応答して FIN で閉じ、true を返す。
 *   検証失敗は INVALID_REQUEST_ID、先頭欠落は PROTOCOL_VIOLATION で閉じる。
 *   検証通過時はセッションを閉じない (§1.5 SHOULD)。
 * - 分類 3 (protocol-violation): PROTOCOL_VIOLATION でセッションを閉じ、
 *   true を返す (§6.3 MUST)。
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
    // draft-ietf-moq-transport-21 §6.4.2.1 (Request ID):
    // 未対応 6 種の先頭は Request ID であり、分類 3 (先頭許可 7 種外)
    // は Request ID としては扱わない。PUBLISH 経路と同一の検証でパリティ・重複を検証し、
    // NOT_SUPPORTED 応答でも ID を消費して記録する (検証→応答の順)。
    // 先頭 varint が取れない空・切詰めはペイロード破損として閉じる。
    let requestId: bigint;
    // decodeVarint の第 2 戻り値は varint が消費したバイト数。先頭 (offset 0) から
    // 読むため、その値がそのまま Request ID 直後のオフセットになる。
    let requestIdLength: number;
    try {
      [requestId, requestIdLength] = decodeVarint(firstMsg.payload, 0);
    } catch (error) {
      // 空・切詰めの詳細はメッセージに残す (デバッグ時の区別のため)
      const detail = error instanceof Error ? error.message : String(error);
      session.closeWithError(
        new SessionError(
          `malformed unsupported request: missing request ID (${detail})`,
          SessionErrorCode.PROTOCOL_VIOLATION,
        ),
      );
      return true;
    }
    const requestIdError = session.validateIncomingRequestId(requestId);
    if (requestIdError !== null) {
      // 検証違反はセッションを閉じて打ち切る (NOT_SUPPORTED 応答は送らない)
      session.closeWithError(requestIdError);
      return true;
    }
    // draft-ietf-moq-transport-21 §2.4.2 (Reserved Namespaces) / §6.5
    // (Session-Level Tracks and Namespaces):
    // "An endpoint that receives a request for an unrecognized session-level track
    //  or namespace MUST reject it with REQUEST_ERROR using error code DOES_NOT_EXIST
    //  rather than passing it to the Application."
    // 未対応リクエストでも Request ID の直後にある Track Namespace を読み、先頭
    // フィールドが "." 単体または ".session" なら DOES_NOT_EXIST で拒否する (MUST)。
    // 受信 PUBLISH 経路 (SessionImpl の受信 PUBLISH 分岐) と同じ判定を使う。
    // Namespace をデコードできない場合は NOT_SUPPORTED を維持する。
    if (incomingIsRejectedNamespaceRequest(firstMsg.payload, requestIdLength)) {
      await incomingSendRequestErrorAndClose(
        stream,
        RequestErrorCode.DOES_NOT_EXIST,
        "request references reserved namespace",
      );
      return true;
    }
    // draft-ietf-moq-transport-21 §1.5 (Extensibility):
    // 未対応メッセージには NOT_SUPPORTED を応答する (SHOULD。引用は
    // incomingClassifyFirstBidiMessage の docstring 参照)。
    await incomingSendRequestErrorAndClose(
      stream,
      RequestErrorCode.NOT_SUPPORTED,
      "request type not supported",
    );
    return true;
  }
  // 7 種以外のメッセージタイプで始まる双方向ストリームは PROTOCOL_VIOLATION
  // draft-ietf-moq-transport-21 §6.3
  session.closeWithError(
    new SessionError(
      `expected a request message as first message on incoming bidirectional stream, got 0x${firstMsg.type.toString(16)}`,
      SessionErrorCode.PROTOCOL_VIOLATION,
    ),
  );
  return true;
}

/**
 * 未対応リクエストの先頭 Track Namespace が予約名前空間かを判定する
 *
 * draft-ietf-moq-transport-21 §2.4.2 (Reserved Namespaces) / §6.5 (Session-Level
 * Tracks and Namespaces) は、未認識の session-level track / namespace への要求を
 * DOES_NOT_EXIST で拒否することを MUST とする。未対応 6 種のメッセージはいずれも
 * Request ID の直後に Track Namespace を置くため、offset から Track Namespace を
 * 読んで判定する。
 *
 * Namespace をデコードできない場合は予約名前空間の判定を行わず、呼び出し側が
 * NOT_SUPPORTED を返す。デコード失敗には 2 種あるが、どちらも同じ扱いにする。
 *
 * - 切詰め (IncompleteDataError): 未対応メッセージの本体が本実装の想定と異なる
 * - 構造違反 (ProtocolViolationError: フィールド長 0 / 32 フィールド超 /
 *   4,096 バイト超。§2.4.1 / §8.7 は受信時に PROTOCOL_VIOLATION で閉じる MUST)
 *
 * 構造違反を閉じないのは、未対応リクエストの本文を本実装が解釈しないためである。
 * §1.5 (Extensibility) は未対応メッセージへの NOT_SUPPORTED 応答を求めており、
 * 本文の解釈結果でセッションを閉じると、将来のメッセージ定義が本実装の想定と
 * 異なる場合に相互運用を壊す。予約名前空間の MUST 拒否 (§2.4.2 / §6.5) は
 * Namespace が読めた場合に成立する。
 *
 * @param payload - 未対応リクエストのメッセージ本文
 * @param offset - Request ID (varint) の直後のオフセット
 * @returns 予約名前空間なら true
 */
function incomingIsRejectedNamespaceRequest(payload: Uint8Array, offset: number): boolean {
  try {
    const [namespace] = decodeTrackNamespace(payload, offset);
    return isRejectedReceiveNamespace(namespace.tuple);
  } catch {
    return false;
  }
}

/**
 * 受信した datagram を処理する
 *
 * draft-ietf-moq-transport-21 §11.5.2 (Padding Datagrams):
 * "The receiver MUST discard all data received in a padding datagram."
 *
 * draft-ietf-moq-transport-21 §11.2.1 (Object Datagram):
 * Track Alias で Subscriber を検索し、filter 再適用して配送する。
 *
 * アプリ例外は当該 subscriber の error コールバックへ通知し、
 * 残りの配送を継続する。セッションもストリームも閉じない
 * (subgroup 経路も同様に継続する)。
 */
export function incomingHandleDatagram(session: SessionInternal, data: Uint8Array): void {
  let datagram: ObjectDatagram;
  try {
    // PADDING datagram (0x132b3e29) を varint type のデコードで判定する
    if (data.length > 0) {
      const [datagramType] = decodeVarint(data, 0);
      if (Number(datagramType) === 0x132b3e29) {
        return;
      }
    }

    [datagram] = decodeObjectDatagram(data);
  } catch (err) {
    // デバッグ記録自体の throw (debug コールバックの throw) は伝播させない。
    try {
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
    } catch {
      // デバッグ記録の失敗は無視する
    }
    // SessionError (KEY_VALUE_FORMATTING_ERROR 等) はそのコードのまま、
    // ProtocolViolationError / IncompleteDataError は PROTOCOL_VIOLATION で
    // セッションを閉じる
    const sessionError = toSessionCloseError(err);
    if (sessionError !== null) {
      session.closeWithError(sessionError);
      return;
    }
    if (err instanceof MalformedTrackError) {
      // draft-ietf-moq-transport-21 §12.1:
      // malformed track を検出したら同一 Track の全購読と全 FETCH を cancel し、
      // セッションは閉じない。比較キーは trackAlias から購読を特定して得る。
      const trackAlias = decodeDatagramTrackAlias(data);
      if (trackAlias !== undefined) {
        const subscribers = session.subscribersByAlias.get(trackAlias) ?? [];
        const trackKey = subscribers[0]?.getFullTrackNameKey();
        if (trackKey !== undefined) {
          cancelMalformedTrackPeers(session, trackKey, err);
        }
      }
    }
    return;
  }

  // Track Alias で Subscriber を検索（draft-21 §3.1: 同一 alias に複数 subscription あり得る）
  const subscribers = session.subscribersByAlias.get(datagram.trackAlias);
  if (!subscribers || subscribers.length === 0) {
    return;
  }

  // datagram は Subgroup ID を持たないため subgroupId は載せない。
  // exactOptionalPropertyTypes では optional なフィールドに undefined を渡せないため、
  // 値がある場合だけ載せる (「未設定 = その経路では存在しない」を保つ)
  const object: MoqtObject = {
    groupId: datagram.groupId,
    objectId: datagram.objectId,
    status: datagram.status ?? ObjectStatus.NORMAL,
    payload: datagram.payload ?? new Uint8Array(0),
    ...(datagram.publisherPriority !== undefined
      ? { publisherPriority: datagram.publisherPriority }
      : {}),
    ...(datagram.properties !== undefined ? { properties: datagram.properties } : {}),
  };

  // 各 subscription に配送する (filter 再適用は各 handleDatagram/handleObject 内)。
  // アプリ例外 (同期 throw のみ) は当該 subscriber の error コールバックへ通知し、
  // 残りの配送を継続する。subgroup とは異なりセッションは閉じない。
  // 反復前に複製する。error コールバック内の unsubscribe() が
  // 配列を破壊的に変更しても、後続購読への配送が欠落しないようにする。
  for (const subscriber of subscribers.slice()) {
    try {
      if (subscriber.hasDatagramCallback()) {
        subscriber.handleDatagram(object);
      } else {
        subscriber.handleObject(object);
      }
    } catch (err) {
      // error コールバック自体の throw はデバッグ記録に残し、残りの配送を継続する。
      // 記録自体の throw (debug コールバックの throw) は伝播させない。
      try {
        subscriber.handleError(err instanceof Error ? err : new Error(String(err)));
      } catch (callbackError) {
        try {
          session.callbacks.debug?.({
            direction: "recv",
            type: 0,
            typeName: "DATAGRAM_CALLBACK_ERROR",
            payload: data,
            decoded: {
              error: callbackError instanceof Error ? callbackError.message : String(callbackError),
            },
            timestamp: Date.now(),
          });
        } catch {
          // デバッグ記録の失敗は無視する
        }
      }
    }
  }
}

/**
 * Object Datagram の Track Alias をデコードする
 *
 * decodeObjectDatagram が Mandatory Track Property の検出で throw した場合に、
 * cancel 対象の購読を引くための Track Alias を取り出す。Type Flags と Track Alias は
 * 先頭に固定配置されているため、デコード失敗時でも取り出せる。
 */
function decodeDatagramTrackAlias(data: Uint8Array): bigint | undefined {
  try {
    // 先頭固定フィールドの配置知識は decodeObjectDatagram と共有する
    // (decodeDatagramTypeAndTrackAlias)。片方だけが配置を変わると誤った
    // alias を引いて無関係な購読を cancel し得る。
    return decodeDatagramTypeAndTrackAlias(data, 0).trackAlias;
  } catch {
    return undefined;
  }
}

/**
 * Fetcher の登録を待つ
 *
 * draft-ietf-moq-transport-21 Section 9.12 (FETCH_OK):
 * "A publisher MAY send Objects in response to a FETCH before the
 *  FETCH_OK message is sent."
 * FETCH_OK より先にデータストリームが到着した場合に使用。
 *
 * フォールバックタイマーは確定時 (早期解決・タイムアウト発火・
 * セッション close 時のコールバック発火) に必ず解放する。
 * タイムアウト先行発火時は登録も解除し、後続 FETCH_OK まで
 * stale な待機を残さない。
 *
 * @param timeoutMs - フォールバックまでのミリ秒 (テスト用の短縮のためにある。
 * 本番呼び出しは既定値のままにする)
 */
export function incomingWaitForFetcher(
  session: SessionInternal,
  requestId: bigint,
  timeoutMs = 5000,
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
    let timer: ReturnType<typeof setTimeout> | undefined;

    const doResolve = () => {
      if (resolved) return;
      resolved = true;
      // 確定したタイマーは残さない
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      // 自分の登録を解除する (タイムアウト先行発火時の stale 防止。
      // FETCH_OK 到着時は呼び出し側がキーごと削除するため無害)
      const registered = session.fetcherReadyCallbacks.get(requestId);
      if (registered !== undefined) {
        const index = registered.indexOf(doResolve);
        if (index !== -1) {
          registered.splice(index, 1);
        }
        if (registered.length === 0) {
          session.fetcherReadyCallbacks.delete(requestId);
        }
      }
      resolve(session.fetchers.get(requestId) ?? null);
    };

    // コールバックを登録
    const callbacks = session.fetcherReadyCallbacks.get(requestId) ?? [];
    callbacks.push(doResolve);
    session.fetcherReadyCallbacks.set(requestId, callbacks);

    // タイムアウト: 指定時間以内に FETCH_OK が来なければ null
    timer = setTimeout(doResolve, timeoutMs);
  });
}

/**
 * Fetch オブジェクトのストリーミング処理ラッパー
 *
 * 統計カウンターを stream.ts の純粋関数に注入する薄いブリッジ。
 * SessionImpl.handleIncomingStream から呼ばれる。
 *
 * 計上先は受信経路で分ける。fill fetch ストリームのオブジェクトは
 * fill-delivered (§3.4)、通常 FETCH のオブジェクトは fetch 側であり、
 * 配送経路の区別 (MoqtObject.fillDelivered) と統計区分を一致させる。
 * 購読側 (subscribe) へは合算しない。購読の Location Filter と fill 範囲が
 * 重なる Object は publisher が両経路で別々に送るため、受信したストリームの
 * 種別どおりに 1 回ずつ計上する (同じ Location が 2 度届けば 2 回計上される)。
 *
 * @param viaFill - fill fetch ストリームからの受信なら true
 */
export function incomingProcessFetchObjects(
  session: SessionInternal,
  buffer: Uint8Array,
  sink: FetchObjectSink,
  context: import("../dataStream").FetchObjectContext | null,
  isFirst: boolean,
  groupOrder: GroupOrder,
  viaFill: boolean,
): {
  remainingBuffer: Uint8Array;
  context: import("../dataStream").FetchObjectContext | null;
  isFirst: boolean;
} {
  return streamProcessFetchObjects(
    buffer,
    sink,
    context,
    isFirst,
    {
      incrementObjectsReceived: () => {
        const stats = session as unknown as {
          statsObjectsReceivedViaFetch: number;
          statsObjectsReceivedViaFill: number;
        };
        if (viaFill) {
          stats.statsObjectsReceivedViaFill++;
        } else {
          stats.statsObjectsReceivedViaFetch++;
        }
      },
      incrementBytesReceived: (_subscribePath, bytes) => {
        const stats = session as unknown as {
          statsBytesReceivedViaFetch: number;
          statsBytesReceivedViaFill: number;
        };
        if (viaFill) {
          stats.statsBytesReceivedViaFill += bytes;
        } else {
          stats.statsBytesReceivedViaFetch += bytes;
        }
      },
    },
    groupOrder,
  );
}

/**
 * Subgroup オブジェクトのストリーミング処理ラッパー
 *
 * 統計カウンターと配送フックを stream.ts の純粋関数に注入する薄いブリッジ。
 * resolvedSubgroupId を透過し、feed 間の解決値を引き継ぐ
 * (明示型・0 系はヘッダ値のため透過しても no-op になる)。
 * SessionImpl.handleSubgroupStream から呼ばれる。
 */
export function incomingProcessSubgroupObjects(
  session: SessionInternal,
  buffer: Uint8Array,
  subscribers: SubscriberImpl[],
  header: import("../dataStream").SubgroupHeader,
  previousObjectId: bigint,
  resolvedSubgroupId?: bigint,
): {
  remainingBuffer: Uint8Array;
  previousObjectId: bigint;
  resolvedSubgroupId: bigint | undefined;
  updatedEndOfGroupFinalObjectId: bigint | undefined;
} {
  // draft-ietf-moq-transport-21 §12.1 条件 4:
  // Group の最終 Object は Group 単位で既知になる。Subgroup ストリームをまたいだ
  // 検出のためセッションが `${trackAlias}:${groupId}` で保持する。
  const endOfGroupKey = `${header.trackAlias}:${header.groupId}`;
  const endOfGroupFinalObjectId = session.receivedEndOfGroupFinalObjectIds.get(endOfGroupKey);
  return streamProcessSubgroupObjects(
    buffer,
    subscribers,
    header,
    previousObjectId,
    {
      incrementObjectsReceived: () => {
        (session as unknown as { statsObjectsReceivedViaSubscribe: number })
          .statsObjectsReceivedViaSubscribe++;
      },
      incrementBytesReceived: (_subscribePath, bytes) => {
        (
          session as unknown as { statsBytesReceivedViaSubscribe: number }
        ).statsBytesReceivedViaSubscribe += bytes;
      },
    },
    {
      notifyError: (subscriber, error) => {
        subscriber.handleError(error instanceof Error ? error : new Error(String(error)));
      },
      recordCallbackError: (payload, error) => {
        try {
          session.callbacks.debug?.({
            direction: "recv",
            type: 0,
            typeName: "SUBGROUP_CALLBACK_ERROR",
            payload,
            decoded: {
              error: error instanceof Error ? error.message : String(error),
            },
            timestamp: Date.now(),
          });
        } catch {
          // デバッグ記録の失敗は無視する
        }
      },
    },
    resolvedSubgroupId,
    // exactOptionalPropertyTypes では optional な finalObjectId に undefined を渡せないため、
    // 既知の最終 Object ID がある場合だけ載せる
    endOfGroupFinalObjectId === undefined ? {} : { finalObjectId: endOfGroupFinalObjectId },
  );
}
