/**
 * 受信系 free function 群
 *
 * SessionImpl の handleIncomingDatagram / waitForFetcher /
 * processFetchObjects ラッパー / processSubgroupObjects ラッパー
 * と、受信 bidi ストリームの先頭メッセージの 3 分類ディスパッチ
 * (incomingClassifyFirstBidiMessage / incomingSendRequestErrorAndClose /
 * incomingHandleFirstBidiMessage) を free function として抽出する。
 *
 * handleIncomingStream と dataStreamHandleSubgroupStream は dataStreamIncoming.ts に
 * 移っている (状態結合が強いため)。
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
  validateFullTrackNameBytes,
  validateTrackNameNonEmpty,
} from "../message";
import { assertLengthWithinData } from "../length";
import type { GroupOrder } from "../message/types";
import { RequestErrorCode, SessionError, SessionErrorCode, MalformedTrackError } from "../error";
import { ControlStreamWriter, type ControlMessage } from "../controlStream";
import { toSessionCloseError } from "./errors";
import { cancelMalformedTrackPeers, type FillFetchTarget } from "./bidi";
import { getEndOfGroupFinalObjectId } from "./endOfGroupTracking";
import { assertNoObjectAfterFetchEnd, assertNoPriorIdGapTrackViolation } from "./priorGapTracking";
import {
  processFetchObjects as streamProcessFetchObjects,
  processSubgroupObjects as streamProcessSubgroupObjects,
  type FetchGapSemantics,
  type FetchObjectSink,
} from "./stream";
import type { FetcherImpl } from "../fetcher";
import type { SubscriberImpl } from "../subscriber";
import type { FullTrackNameKey } from "../fullTrackName";
import type { SessionInternal } from "./types";

// ============================================================================
// 受信 bidi ストリームの先頭メッセージ 3 分類
// ============================================================================

/**
 * 受信 bidi ストリームの先頭メッセージを 3 分類する
 *
 * draft-ietf-moq-transport-22 §6.3 (Session initialization):
 * リクエストストリームの先頭として許可されるメッセージは 7 種
 * (TRACK_STATUS / SUBSCRIBE / PUBLISH / FETCH / PUBLISH_NAMESPACE /
 * SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS)。
 * - "publish": 対応済み (moqt-js はクライアントのため受信 PUBLISH のみ処理する)
 * - "unsupported-request": 7 種のうち未対応の 6 種。
 *   draft-ietf-moq-transport-22 §1.6 (Modularity):
 *   「Limited endpoints SHOULD respond to any unsupported messages with the
 *   appropriate NOT_SUPPORTED error code, rather than ignoring them.」
 * - "protocol-violation": 7 種以外 (未知タイプ等)。
 *   draft-ietf-moq-transport-23 §6.3:
 *   「Bidirectional streams MUST NOT begin with any other message type unless
 *   negotiated. If they do, the peer MUST close the Session with
 *   UNEXPECTED_MESSAGE.」
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
 * REQUEST_ERROR の送信に載せる Error Details
 *
 * draft-ietf-moq-transport-23 §9.4.2:
 * REQUEST_ERROR の末尾は §8.3 の Key-Value-Pair 列 (Error Details) であり、
 * Message Parameters とは別の型空間・処理規則を持つ。現在この送信経路が載せる
 * 既知の Detail は UNSUPPORTED_PROPERTY (§9.4.2.2) だけである。
 */
export interface IncomingRequestErrorOptions {
  /**
   * UNSUPPORTED_PROPERTY Error Detail に載せる Mandatory Track Property の Type
   *
   * draft-ietf-moq-transport-23 §3.7 / §9.4.2.2:
   * 未対応の Mandatory Track Property で要求を拒否するとき、理解できなかった
   * 各 Type の Detail を載せることが SHOULD。同じ型の Detail を複数載せられる。
   * UNSUPPORTED_EXTENSION 以外の Error Code では指定してはならない。
   */
  readonly unsupportedPropertyTypes?: readonly bigint[];
}

/**
 * REQUEST_ERROR を送信し、送信方向を FIN で閉じた後に受信方向をキャンセルする
 *
 * draft-ietf-moq-transport-22 §6.4.2.3 (Request Cancellation and Rejection):
 * 「When an endpoint rejects a request without performing any application
 * processing, it SHOULD send a REQUEST_ERROR and FIN the stream.」
 * draft-ietf-moq-transport-22 §3.6 (Subscribing to Tracks by Prefix):
 * 「If it is an error, the stream will be closed via FIN after SUBSCRIBE_TRACKS_ERROR
 * is sent.」
 *
 * FIN (writer.close()) は writer.releaseLock() の前に実行する。
 * releaseLock 後の close() は WHATWG Streams 仕様上、ロック非保持時に
 * TypeError で reject する Promise を返すため、try ブロック内で await し
 * catch で吸収する。受信方向 (readable) は FIN 送信後に cancel() で閉じる
 * (draft-ietf-moq-transport-22 §6.4.2.3 の STOP_SENDING 相当)。
 *
 * @param options - Error Details として載せる構造情報 (省略時は Detail なし)
 */
export async function incomingSendRequestErrorAndClose(
  stream: WebTransportBidirectionalStream,
  errorCode: RequestErrorCode,
  reasonPhrase: string,
  peerMaxControlMessageSize: number,
  options: IncomingRequestErrorOptions = {},
): Promise<void> {
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  try {
    writer = stream.writable.getWriter();
    const unsupportedPropertyTypes = options.unsupportedPropertyTypes ?? [];
    const errorPayload = encodeRequestErrorPayload({
      type: MessageType.REQUEST_ERROR,
      errorCode: BigInt(errorCode),
      retryInterval: 0n,
      reasonPhrase,
      // exactOptionalPropertyTypes では optional なフィールドに undefined を渡せないため、
      // 値がある場合だけ載せる
      ...(unsupportedPropertyTypes.length > 0 ? { unsupportedPropertyTypes } : {}),
    });
    // 送信上限はピアが広告した MAX_CONTROL_MESSAGE_SIZE に合わせる
    // (draft-ietf-moq-transport-23 §9.1.8)。
    const controlWriter = new ControlStreamWriter(peerMaxControlMessageSize);
    const framed = controlWriter.encode(MessageType.REQUEST_ERROR, errorPayload);
    await writer.write(framed);
    await writer.close();
  } catch {
    // 失敗の原因ごとに後始末が異なる。
    // - write 失敗: writable がエラー状態 (ピアの RESET_STREAM / セッション終了等)。
    //   close() を試行しても失敗するだけのため FIN は送信しない。ストリームは
    //   QUIC レベルで既にクローズされており、リソースリークは発生しない。
    // - フレーミング失敗: ピアの MAX_CONTROL_MESSAGE_SIZE を超える REQUEST_ERROR は
    //   仕様上送信できない (MUST NOT)。送信方向は開いたままにせず、受信方向の
    //   cancel のみ行う (writer は finally で releaseLock する)。
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
 * draft-ietf-moq-transport-22 §6.4.2.1 (Request ID):
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
  // draft-ietf-moq-transport-22 §6.4.2.1:
  // moqt-js はクライアントロールのため、受信 Request ID は奇数 (サーバー発) が期待値。
  // LSB が 0 (偶数) はパリティ違反。
  if ((requestId & 1n) === 0n) {
    return new SessionError(
      `invalid request id parity: ${requestId}, expected odd (server-generated)`,
      SessionErrorCode.INVALID_REQUEST_ID,
    );
  }

  // draft-ietf-moq-transport-22 §6.4.2.1:
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
 *   検証失敗は INVALID_REQUEST_ID、先頭欠落は MALFORMED_MESSAGE で閉じる。
 *   検証通過時はセッションを閉じない (§1.6 (Modularity) SHOULD)。
 * - 分類 3 (protocol-violation): UNEXPECTED_MESSAGE でセッションを閉じ、
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
    // draft-ietf-moq-transport-22 §6.4.2.1 (Request ID):
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
          SessionErrorCode.MALFORMED_MESSAGE,
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
    // draft-ietf-moq-transport-23 §2.4.1 (Track Naming) / §9.4.2.1 / §8.7:
    // 未対応リクエストでも、Request ID の直後にある共通 prefix
    // (Track Namespace、Track Name を持つ種別では Track Name Length と Track Name)
    // を検証する。名前の検証だけを行い、要求を受理する機能は追加しない。
    // 構造不正・上限超過は §8.7 / §12.2 の分類 (INVALID_TRACK_NAMESPACE /
    // FIELD_LENGTH_EXCEEDED / MALFORMED_MESSAGE / 空 Track Name は
    // PROTOCOL_VIOLATION) で閉じ、NOT_SUPPORTED で隠さない。
    const prefixResult = incomingValidateUnsupportedRequestPrefix(
      session,
      firstMsg,
      requestIdLength,
    );
    if (prefixResult === null) {
      return true;
    }
    // draft-ietf-moq-transport-22 §2.4.3 (Reserved Namespaces) / §6.5
    // (Session-Level Tracks and Namespaces):
    // "An endpoint that receives a request for an unrecognized session-level track
    //  or namespace MUST reject it with REQUEST_ERROR using error code DOES_NOT_EXIST
    //  rather than passing it to the Application."
    // 受信 PUBLISH 経路と同じ判定を使う。
    if (prefixResult.rejectedNamespace) {
      await incomingSendRequestErrorAndClose(
        stream,
        RequestErrorCode.DOES_NOT_EXIST,
        "request references reserved namespace",
        session.peerMaxControlMessageSize,
      );
      return true;
    }
    // draft-ietf-moq-transport-22 §1.6 (Modularity):
    // 未対応メッセージには NOT_SUPPORTED を応答する (SHOULD。引用は
    // incomingClassifyFirstBidiMessage の docstring 参照)。
    await incomingSendRequestErrorAndClose(
      stream,
      RequestErrorCode.NOT_SUPPORTED,
      "request type not supported",
      session.peerMaxControlMessageSize,
    );
    return true;
  }
  // 7 種以外のメッセージタイプで始まる双方向ストリームは UNEXPECTED_MESSAGE
  // draft-ietf-moq-transport-23 §6.3
  session.closeWithError(
    new SessionError(
      `expected a request message as first message on incoming bidirectional stream, got 0x${firstMsg.type.toString(16)}`,
      SessionErrorCode.UNEXPECTED_MESSAGE,
    ),
  );
  return true;
}

/**
 * 未対応リクエストの共通 prefix を検証する
 *
 * draft-ietf-moq-transport-23 §2.4.1 (Track Naming) / §8.7 (Track Namespace
 * Structure):
 * 未対応の SUBSCRIBE / FETCH / TRACK_STATUS は通常のメッセージと同じ
 * Request ID + Track Namespace + Track Name Length + Track Name の prefix を持ち、
 * PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS は Track Name を持たない。
 * 本関数は prefix の構造と名前だけを検証し、要求を受理する機能は追加しない。
 *
 * - Track Namespace の構造違反は §8.7 の INVALID_TRACK_NAMESPACE /
 *   FIELD_LENGTH_EXCEEDED (decodeTrackNamespace が投げる) として閉じる。
 * - 切詰めは MALFORMED_MESSAGE として閉じる。
 * - Track Name が 0 バイトなら §2.4.1 の PROTOCOL_VIOLATION として閉じる。
 *
 * @param payload - 未対応リクエストのメッセージ本文
 * @param firstMsg - 先頭メッセージ (種類と本文)
 * @param offset - Request ID (varint) の直後のオフセット
 * @returns 検証結果。セッションを閉じて処理を打ち切る場合は null
 */
function incomingValidateUnsupportedRequestPrefix(
  session: SessionInternal,
  firstMsg: ControlMessage,
  offset: number,
): { rejectedNamespace: boolean } | null {
  let trackNamespace: ReturnType<typeof decodeTrackNamespace>[0];
  let namespaceConsumed: number;
  try {
    [trackNamespace, namespaceConsumed] = decodeTrackNamespace(firstMsg.payload, offset);
  } catch (error) {
    incomingCloseOnUnsupportedRequestPrefixError(session, "track namespace", error);
    return null;
  }

  if (incomingUnsupportedRequestHasTrackName(firstMsg.type)) {
    try {
      const nameOffset = offset + namespaceConsumed;
      const [nameLen, nameLenConsumed] = decodeVarint(firstMsg.payload, nameOffset);
      assertLengthWithinData(
        "unsupported request track name",
        nameLen,
        nameOffset + nameLenConsumed,
        firstMsg.payload.length,
      );
      const trackNameStart = nameOffset + nameLenConsumed;
      const trackName = firstMsg.payload.slice(trackNameStart, trackNameStart + Number(nameLen));
      validateTrackNameNonEmpty(trackName, "unsupported request");
      // draft-ietf-moq-transport-23 §8.7: Full Track Name (namespace + name) が
      // 上限を超えたら FIELD_LENGTH_EXCEEDED で閉じる。通常 decoder の
      // validateFullTrackNameBytes と同じ検証を未対応要求の経路でも行う。
      validateFullTrackNameBytes(trackNamespace, trackName);
    } catch (error) {
      incomingCloseOnUnsupportedRequestPrefixError(session, "track name", error);
      return null;
    }
  }

  return { rejectedNamespace: isRejectedReceiveNamespace(trackNamespace.tuple) };
}

/**
 * 未対応リクエストの prefix 検証エラーでセッションを閉じる
 *
 * 切詰めは MALFORMED_MESSAGE、§2.4.1 / §8.7 の構造違反はデコード済みエラーの
 * SessionErrorCode をそのまま使う (§12.2 の分類に揃える)。
 */
function incomingCloseOnUnsupportedRequestPrefixError(
  session: SessionInternal,
  fieldName: string,
  error: unknown,
): void {
  const sessionError =
    toSessionCloseError(error) ??
    new SessionError(
      `malformed unsupported request: invalid ${fieldName} (${error instanceof Error ? error.message : String(error)})`,
      SessionErrorCode.MALFORMED_MESSAGE,
    );
  session.closeWithError(sessionError);
}

/**
 * 未対応リクエストのうち Track Name を持つメッセージ種別を判定する
 *
 * draft-ietf-moq-transport-23 §9.6 (SUBSCRIBE) / §9.11 (FETCH) / §9.12
 * (TRACK_STATUS) は Track Name を持ち、namespace 系の 3 種は持たない。
 */
function incomingUnsupportedRequestHasTrackName(type: number): boolean {
  return (
    type === MessageType.SUBSCRIBE ||
    type === MessageType.FETCH ||
    type === MessageType.TRACK_STATUS
  );
}

/**
 * 受信した datagram を処理する
 *
 * draft-ietf-moq-transport-22 §11.5.2 (Padding Datagrams):
 * "The receiver MUST discard all data received in a padding datagram."
 *
 * draft-ietf-moq-transport-22 §11.2.1 (Object Datagram):
 * Track Alias で Subscriber を検索し、filter 再適用して配送する。
 *
 * アプリ例外は当該 subscriber の error コールバックへ通知し、
 * 残りの配送を継続する。セッションもストリームも閉じない
 * (subgroup 経路も同様に継続する)。
 *
 * draft-ietf-moq-transport-22 §10.8 / §10.9:
 * Track 横断の Prior ID Gap 条件 (過去に受信した Object を覆う gap、過去に通知
 * された gap 内の Location、同一 Group 内で異なる gap 値) は Track 単位の追跡が
 * 必要であり、この経路で検証する。検証は Object の decode 後・配送前に行い、
 * throw は下の catch が受けて malformed track として cancel する。
 */
export function incomingHandleDatagram(session: SessionInternal, data: Uint8Array): void {
  let datagram: ObjectDatagram;
  // draft-ietf-moq-transport-22 §10.8 / §10.9:
  // 追跡検証に使う比較キーは decode の前に解決する。購読の解決後まで遅らせると
  // MalformedTrackError が下の catch を素通りし、SessionImpl の datagram 受信
  // ループごと終了して §12.1 の cancel まで到達しない。キーを解決できない
  // datagram (alias 不明・購読 0 件) は検証しない。
  const trackKey = incomingResolveDatagramTrackKey(session, data);
  try {
    // PADDING datagram (0x132b3e29) を varint type のデコードで判定する
    if (data.length > 0) {
      const [datagramType] = decodeVarint(data, 0);
      if (Number(datagramType) === 0x132b3e29) {
        return;
      }
    }

    [datagram] = decodeObjectDatagram(data);

    // 追跡検証は Object のフィールドが揃った後に行う。単一 Object の gap 条件は
    // decodeObjectDatagram が先に検証しており、ここでは重複して呼ばない。
    if (trackKey !== undefined) {
      const tracking = { trackingByTrack: session.priorGapTrackingByTrack, trackKey };
      // draft-ietf-moq-transport-23 §12.1 条件 4 / 5 (FETCH の終端 indicator)。
      // 詳細は assertNoObjectAfterFetchEnd の JSDoc を参照する。
      assertNoObjectAfterFetchEnd(tracking, datagram.groupId, datagram.objectId);
      // draft-ietf-moq-transport-23 §12.1 条件 10:
      // Datagram の Object Status (END_OF_GROUP / END_OF_TRACK) も非存在の通知で
      // あるため、Track 単位の状態として受信位置との前後関係を検証・記録する。
      assertNoPriorIdGapTrackViolation(
        tracking,
        datagram.groupId,
        datagram.objectId,
        datagram.properties,
        datagram.status ?? ObjectStatus.NORMAL,
      );
    }
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
    // SessionError (MALFORMED_KEY_VALUE 等) はそのコードのまま、
    // ProtocolViolationError は自身の code、IncompleteDataError は datagram の
    // Object 構造破損として MALFORMED_OBJECT でセッションを閉じる
    const sessionError = toSessionCloseError(err, SessionErrorCode.MALFORMED_OBJECT);
    if (sessionError !== null) {
      session.closeWithError(sessionError);
      return;
    }
    if (err instanceof MalformedTrackError) {
      // draft-ietf-moq-transport-22 §12.1:
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

  // Track Alias で Subscriber を検索（draft-ietf-moq-transport-22 §3.1: 同一 alias に複数 subscription あり得る）
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
 * Object Datagram から追跡対象 Track の比較キーを解決する
 *
 * datagram は Full Track Name を直接持たないため、Track Alias から購読を引き、
 * その購読が持つ比較キー (fullTrackNameKey の戻り値) を使う。
 *
 * 対象範囲: alias を特定でき、かつその alias に購読がある場合だけ解決できる。
 * どちらも満たさない datagram は Track を決められないため追跡検証の対象外と
 * する (cancel 対象も存在しない)。
 *
 * @returns 解決できた場合は比較キー、alias 不明・購読 0 件は undefined
 */
function incomingResolveDatagramTrackKey(
  session: SessionInternal,
  data: Uint8Array,
): FullTrackNameKey | undefined {
  const trackAlias = decodeDatagramTrackAlias(data);
  if (trackAlias === undefined) {
    return undefined;
  }
  return session.subscribersByAlias.get(trackAlias)?.[0]?.getFullTrackNameKey();
}

/**
 * 待機する PUBLISH 初期 fill ストリーム数の上限
 *
 * draft-ietf-moq-transport-23 §3.4.1 の fill fetch は Request ID ごとに待機する。
 * 悪意あるピアが未確定の Request ID の FETCH_HEADER を大量に送るのを防ぐため、
 * Session 単位で待機 stream 数を制限する (超過分は待機せず cancel する)。
 */
const MAX_WAITING_PUBLISH_FILL_STREAMS = 1024;

/** PUBLISH 初期 fill の待機タイムアウト (ミリ秒) */
const PUBLISH_FILL_WAIT_TIMEOUT_MS = 5000;

/**
 * PUBLISH 初期 fill の受信先登録を待つ
 *
 * draft-ietf-moq-transport-23 §3.4 / §3.4.1:
 * PUBLISH の FILL_PARAMETERS による初期 fill fetch ストリームの FETCH_HEADER は
 * PUBLISH の Request ID を運ぶ。PUBLISH の到着が遅れることがあるため、
 * fillFetchTargets への登録を短時間待つ。
 *
 * 次の ID は待たずに null を返す:
 * - 既に fill target がある (待機不要)
 * - 通常 FETCH として判明している (pendingFetch / fetchers)
 * - 受信 PUBLISH の処理が完了している (拒否済み・fill を開かないと確定済み)
 * 上限超過とタイムアウトも null とし、呼び出し側が stream を cancel する。
 *
 * @param timeoutMs - 待機時間 (テスト用の短縮用)
 * @returns 登録された fill target、登録されなかった場合は null
 */
export function incomingWaitForPublishFillTarget(
  session: SessionInternal,
  requestId: bigint,
  timeoutMs = PUBLISH_FILL_WAIT_TIMEOUT_MS,
): Promise<FillFetchTarget | null> {
  return new Promise<FillFetchTarget | null>((resolve) => {
    const existing = session.fillFetchTargets.get(requestId);
    if (existing !== undefined) {
      resolve(existing);
      return;
    }
    if (session.pendingFetch.has(requestId) || session.fetchers.has(requestId)) {
      resolve(null);
      return;
    }
    if (session.receivedRequestIds.has(requestId) && !session.publishingRequestIds.has(requestId)) {
      // 処理済み (拒否済み・fill を開かない) の PUBLISH 宛て。待機しない
      resolve(null);
      return;
    }
    if (session.publishFillWaitingStreams >= MAX_WAITING_PUBLISH_FILL_STREAMS) {
      resolve(null);
      return;
    }
    session.publishFillWaitingStreams += 1;

    let resolved = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const doResolve = () => {
      if (resolved) return;
      resolved = true;
      session.publishFillWaitingStreams -= 1;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      const registered = session.publishFillReadyCallbacks.get(requestId);
      if (registered !== undefined) {
        const index = registered.indexOf(doResolve);
        if (index !== -1) {
          registered.splice(index, 1);
        }
        if (registered.length === 0) {
          session.publishFillReadyCallbacks.delete(requestId);
        }
      }
      resolve(session.fillFetchTargets.get(requestId) ?? null);
    };

    const callbacks = session.publishFillReadyCallbacks.get(requestId) ?? [];
    callbacks.push(doResolve);
    session.publishFillReadyCallbacks.set(requestId, callbacks);
    timer = setTimeout(doResolve, timeoutMs);
  });
}

/**
 * PUBLISH の受理・拒否が確定した時点で、同じ Request ID の fill 待機者を起こす
 *
 * draft-ietf-moq-transport-23 §3.4.1:
 * 拒否・paused・fill 不提示など fill fetch ストリームを開かないと確定した場合も、
 * 待機している stream を失敗させる (呼び出し側が cancel する)。
 * 処理中フラグも落とし、以降の待機を「処理済み」として即時失敗させる。
 */
export function incomingSettlePublishFillWaiters(
  session: SessionInternal,
  requestId: bigint,
): void {
  session.publishingRequestIds.delete(requestId);
  const callbacks = session.publishFillReadyCallbacks.get(requestId);
  if (callbacks === undefined) {
    return;
  }
  session.publishFillReadyCallbacks.delete(requestId);
  // doResolve は自分の登録解除 (splice) を行うため、複製して反復する
  for (const callback of callbacks.slice()) {
    callback();
  }
}

/**
 * Fetcher の登録を待つ
 *
 * draft-ietf-moq-transport-22 §3.2 (Fetch):
 * "The publisher MAY send Objects in response to a FETCH before the
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
 * fill-delivered (draft-ietf-moq-transport-22 §3.4)、通常 FETCH のオブジェクトは fetch 側であり、
 * 配送経路の区別 (MoqtObject.fillDelivered) と統計区分を一致させる。
 * 購読側 (subscribe) へは合算しない。購読の Location Filter と fill 範囲が
 * 重なる Object は publisher が両経路で別々に送るため、受信したストリームの
 * 種別どおりに 1 回ずつ計上する (同じ Location が 2 度届けば 2 回計上される)。
 *
 * @param viaFill - fill fetch ストリームからの受信なら true
 * @param trackKey - 追跡対象 Track の比較キー。通常 FETCH は Fetcher、fill fetch は
 *   購読が持つ比較キーを渡す (§10.8 / §10.9 の Track 横断検証と、FETCH の
 *   End of Group / End of Track indicator が確定した終端の検証に使う)。
 * @param fetchGap - FETCH 要求の範囲と Range Filter の有無。通常 FETCH だけが渡し、
 *   fill fetch では省略する (§3.2.2 の暗黙 gap を非存在として扱うかの判定に使う)。
 */
export function incomingProcessFetchObjects(
  session: SessionInternal,
  buffer: Uint8Array,
  sink: FetchObjectSink,
  context: import("../dataStream").FetchObjectContext | null,
  isFirst: boolean,
  groupOrder: GroupOrder,
  viaFill: boolean,
  trackKey: FullTrackNameKey,
  fetchGap?: FetchGapSemantics,
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
    { trackingByTrack: session.priorGapTrackingByTrack, trackKey },
    fetchGap,
  );
}

/**
 * Subgroup オブジェクトのストリーミング処理ラッパー
 *
 * 統計カウンターと配送フックを stream.ts の純粋関数に注入する薄いブリッジ。
 * resolvedSubgroupId を透過し、feed 間の解決値を引き継ぐ
 * (明示型・0 系はヘッダ値のため透過しても no-op になる)。
 * dataStreamHandleSubgroupStream から呼ばれる。
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
  // draft-ietf-moq-transport-22 §12.1 条件 4:
  // Group の最終 Object は Group 単位で既知になる。Subgroup ストリームをまたいだ
  // 検出のためセッションが Track Alias と Group ID の 2 段 Map で保持する。
  // 上限を超えて追跡から外れた Track Alias / Group は未登録として undefined に
  // なるため、その Group では超過を検出しない (検出漏れのみで誤検出は生まない)。
  const endOfGroupFinalObjectId = getEndOfGroupFinalObjectId(
    session.receivedEndOfGroupFinalObjectIds,
    header.trackAlias,
    header.groupId,
  );
  // draft-ietf-moq-transport-22 §10.8 / §10.9:
  // Subgroup は Full Track Name を直接持たないため、Track Alias から購読を引き、
  // その購読が持つ比較キー (fullTrackNameKey の戻り値) を追跡対象のキーにする。
  const trackKey = subscribers[0]?.getFullTrackNameKey();
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
    // draft-ietf-moq-transport-22 §10.8 / §10.9:
    // Track 横断の追跡検証に使う比較キーは、購読が特定できた場合だけ解決できる。
    // 購読が特定できないと Object の decode 自体を行わないため、キーは必ず解決できる。
    trackKey === undefined
      ? undefined
      : { trackingByTrack: session.priorGapTrackingByTrack, trackKey },
  );
}
