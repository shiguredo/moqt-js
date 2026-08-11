/**
 * Publisher 送信系 free function 群
 *
 * SessionImpl の sendObject / sendObjectInternal / closePublisherStream /
 * closePublisherStreamInternal / sendDatagram / getDatagramWriter / sendPublishDone
 * を free function として抽出する。
 *
 * draft-ietf-moq-transport-19 §2.2 (Subgroups):
 * "Objects from the same Subgroup MUST NOT be sent on different streams"
 * publisherSendQueues による Promise チェーン排他制御で同一トラックの逐次実行を保証する。
 */

import {
  encodeSubgroupHeader,
  SubgroupHeaderType,
  encodeObjectDatagram,
  encodeObjectFields,
  DatagramType,
} from "../dataStream";
import { ClosedSubgroupError, SessionError, SessionErrorCode } from "../error";
import { MessageType, PublishDoneStatusCode, ObjectStatus } from "../message";
import { encodeVarint } from "../varint";
import { type PublisherImpl, type SendObjectParams, type SendDatagramParams } from "../publisher";
import { calculateObjectIdDelta } from "./params";
import { isPeerStreamError } from "./errors";
import { mergeDeliveryTimeoutObjectProperties, appendGreaseObjectProperty } from "../properties";
import type { SessionInternal } from "./types";

/**
 * datagram 送信用 writer を取得する
 *
 * WebTransport の `datagrams.writable` は単一の WritableStream であり、writer は
 * 1 つだけロックを保持できる。最初の呼び出しで getWriter() して保持し、以降は同じ
 * writer を返す。
 */
export function publishGetDatagramWriter(
  session: SessionInternal,
): WritableStreamDefaultWriter<Uint8Array> {
  session.datagramWriter ??= session.transport.datagrams.writable.getWriter();
  return session.datagramWriter;
}

/**
 * オブジェクトを送信する（Promise チェーン排他制御付き）
 *
 * draft-ietf-moq-transport-19 §2.2:
 * "Objects from the same Subgroup MUST NOT be sent on different streams"
 */
export function publishSendObject(
  session: SessionInternal,
  publisher: PublisherImpl,
  params: SendObjectParams,
): Promise<void> {
  const trackAlias = publisher.getTrackAlias();
  const groupId = BigInt(params.groupId);
  const previousPromise = session.publisherSendQueues.get(trackAlias) ?? Promise.resolve();
  const currentPromise = previousPromise
    .catch(() => {})
    .then(() => {
      // 閉じた Subgroup への送信を拒否する
      // draft-ietf-moq-transport-19 §11.4.3
      if (session.closedSubgroups.has(`${trackAlias}:${groupId}`)) {
        throw new ClosedSubgroupError(
          `subgroup is closed: trackAlias=${trackAlias} groupId=${groupId}`,
          trackAlias,
          groupId,
        );
      }
    })
    .then(() => publishSendObjectInternal(session, publisher, params))
    .catch((err: unknown) => {
      publisher.handleError(err instanceof Error ? err : new Error(String(err)));
    });
  session.publisherSendQueues.set(trackAlias, currentPromise);
  return currentPromise;
}

/**
 * オブジェクト送信の内部実装
 *
 * draft-ietf-moq-transport-19 Section 11.4.2 (Subgroup Header)
 */
export async function publishSendObjectInternal(
  session: SessionInternal,
  publisher: PublisherImpl,
  params: SendObjectParams,
): Promise<void> {
  const trackAlias = publisher.getTrackAlias();
  const groupId = BigInt(params.groupId);
  const objectId = BigInt(params.objectId);

  let streamState = session.publisherStreams.get(trackAlias);

  // 新しい Group または最初のオブジェクト → 新しいストリームを開く
  if (!streamState || streamState.groupId !== groupId) {
    // 前のストリームを FIN で閉じる
    if (streamState) {
      session.publisherStreams.delete(trackAlias);
      try {
        await streamState.writer.close();
      } catch {
        // 既に閉じられている場合は無視
      }
    }

    // 新しいストリームを開く
    const stream = await session.transport.createUnidirectionalStream();
    session.statsUnidirectionalStreamsOpened++;
    publisher.incrementDataStreamCount();
    const writer = stream.getWriter();

    // Subgroup Header を書き込む
    // draft-ietf-moq-transport-19 Section 11.4.2
    const header = encodeSubgroupHeader({
      type: SubgroupHeaderType.FIRST_OBJ_EXT,
      trackAlias,
      groupId,
      publisherPriority: params.priority ?? 128,
      firstObject: true,
    });

    try {
      await writer.write(header);
    } catch (err) {
      try {
        writer.releaseLock();
      } catch {
        // releaseLock の失敗は無視し、元の write エラーを優先する
      }
      session.closedSubgroups.add(`${trackAlias}:${groupId}`);
      throw err;
    }

    streamState = { groupId, writer, previousObjectId: -1n };
    session.publisherStreams.set(trackAlias, streamState);
  }

  // Object ID 上限検証
  // draft-ietf-moq-transport-19 §11.4.2
  if (objectId < 0n || objectId > (1n << 64n) - 1n) {
    session.closeWithError(
      new SessionError(
        `object id exceeds maximum value: ${objectId}`,
        SessionErrorCode.PROTOCOL_VIOLATION,
      ),
    );
    return;
  }

  // Object ID Delta を計算
  const objectIdDelta = calculateObjectIdDelta(streamState.previousObjectId, objectId);

  // delivery timeout の Object Property は subgroup 先頭オブジェクトにのみ載せる
  const isFirstInSubgroup = streamState.previousObjectId < 0n;
  if (
    !isFirstInSubgroup &&
    (params.deliveryTimeout !== undefined || params.subgroupDeliveryTimeout !== undefined)
  ) {
    throw new Error(
      "deliveryTimeout/subgroupDeliveryTimeout can only be set on the first object in a subgroup",
    );
  }

  let objectProperties = params.properties;
  if (isFirstInSubgroup) {
    objectProperties = mergeDeliveryTimeoutObjectProperties(
      params.properties,
      params.deliveryTimeout,
      params.subgroupDeliveryTimeout,
    );
  }

  // GREASE Object Property - draft-ietf-moq-transport-19 §14 (Grease)
  // opt-in 時、各オブジェクトに 1 つ追加する。§11.2.1.2 により Object Properties は
  // status Normal のオブジェクトにのみ許容される（非 Normal は PROTOCOL_VIOLATION）ため、
  // Normal のときだけ注入する。
  const status = params.status ?? ObjectStatus.NORMAL;
  if (session.grease && status === ObjectStatus.NORMAL) {
    objectProperties = appendGreaseObjectProperty(objectProperties);
  }

  const data = encodeObjectFields(
    objectIdDelta,
    BigInt(params.payload.length),
    SubgroupHeaderType.FIRST_OBJ_EXT,
    status,
    objectProperties,
  );

  try {
    await streamState.writer.write(data);
    if (params.payload.length > 0) {
      await streamState.writer.write(params.payload);
    }
  } catch (err) {
    try {
      streamState.writer.releaseLock();
    } catch {
      // releaseLock の失敗は無視し、元の write エラーを優先する
    }
    session.closedSubgroups.add(`${trackAlias}:${groupId}`);
    throw err;
  }

  // 状態を更新
  streamState.previousObjectId = objectId;
}

/**
 * Publisher のストリームを閉じる（Promise チェーン排他制御付き）
 */
export function publishClosePublisherStream(
  session: SessionInternal,
  trackAlias: bigint,
): Promise<void> {
  const previousPromise = session.publisherSendQueues.get(trackAlias) ?? Promise.resolve();
  const currentPromise = previousPromise
    .catch(() => {})
    .then(() => publishClosePublisherStreamInternal(session, trackAlias));
  session.publisherSendQueues.set(trackAlias, currentPromise);
  return currentPromise;
}

/**
 * Publisher のストリームを閉じる内部実装
 */
export async function publishClosePublisherStreamInternal(
  session: SessionInternal,
  trackAlias: bigint,
): Promise<void> {
  const streamState = session.publisherStreams.get(trackAlias);
  if (streamState) {
    session.publisherStreams.delete(trackAlias);
    try {
      await Promise.race([
        streamState.writer.close(),
        new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error("writer.close() timed out")), 5000);
        }),
      ]);
    } catch {
      // タイムアウトまたは既にクローズされている場合は無視
    }
  }

  // publisher done 時に当該 trackAlias の closedSubgroups エントリをクリアする
  for (const key of session.closedSubgroups) {
    if (key.startsWith(`${trackAlias}:`)) {
      session.closedSubgroups.delete(key);
    }
  }
}

/**
 * datagram を送信する
 * draft-ietf-moq-transport-19 Section 11.3 (Datagrams)
 */
export function publishSendDatagram(
  session: SessionInternal,
  publisher: PublisherImpl,
  params: SendDatagramParams,
): void {
  // セッションクローズ後は datagram を送らない
  if (session.sessionState === "closed") {
    return;
  }

  // GREASE Object Property - draft-ietf-moq-transport-19 §14 (Grease)
  // opt-in 時、datagram に 1 つ追加する。Datagram Type の Properties Present ビット
  // （bit 0）を正しく設定するため、hasProperties の判定より前に注入する。
  const properties = session.grease
    ? appendGreaseObjectProperty(params.properties)
    : params.properties;

  const hasProperties = properties !== undefined && properties.length > 0;
  const hasPriority = params.priority !== undefined;
  const endOfGroup = params.endOfGroup ?? false;

  // Datagram Type を決定
  // Section 11.3.1: Type bits = EndOfGroup(bit 1) | PROPERTIES(bit 0)
  let type: number;
  if (hasPriority) {
    if (endOfGroup) {
      type = hasProperties
        ? DatagramType.PAYLOAD_OBJ_EXT_END_GROUP
        : DatagramType.PAYLOAD_OBJ_END_GROUP;
    } else {
      type = hasProperties ? DatagramType.PAYLOAD_OBJ_EXT : DatagramType.PAYLOAD_OBJ;
    }
  } else {
    if (endOfGroup) {
      type = hasProperties
        ? DatagramType.PAYLOAD_OBJ_EXT_END_GROUP_NO_PRI
        : DatagramType.PAYLOAD_OBJ_END_GROUP_NO_PRI;
    } else {
      type = hasProperties ? DatagramType.PAYLOAD_OBJ_EXT_NO_PRI : DatagramType.PAYLOAD_OBJ_NO_PRI;
    }
  }

  const datagram = encodeObjectDatagram({
    type,
    trackAlias: publisher.getTrackAlias(),
    groupId: BigInt(params.groupId),
    objectId: BigInt(params.objectId),
    publisherPriority: params.priority ?? 128,
    properties,
    payload: params.payload,
  });

  const writer = publishGetDatagramWriter(session);
  writer.write(datagram).catch((err: unknown) => {
    if (session.sessionState === "closed") {
      return;
    }
    publisher.handleError(err instanceof Error ? err : new Error(String(err)));
  });
}

/**
 * PUBLISH_DONE を送信する
 * draft-ietf-moq-transport-19 Section 10.11 (PUBLISH_DONE)
 */
export async function publishSendPublishDone(
  session: SessionInternal,
  publisher: PublisherImpl,
): Promise<void> {
  const requestId = publisher.getRequestId();

  // セッション終了後は送信を試行しない。
  // アプリの session.close() では publishers が markClosed され done() が no-op に
  // なるが、ピア起因のセッション終了では markClosed が実行されないため、
  // ここでガードする。ガードしないと write / close がセッション終了起因の
  // エラーで失敗し、誤って PROTOCOL_VIOLATION に昇格して callbacks.error に
  // 通知される。
  if (session.sessionState === "closed") {
    return;
  }

  const streamCount = publisher.getDataStreamCount();
  const parts: Uint8Array[] = [];
  parts.push(encodeVarint(PublishDoneStatusCode.TRACK_ENDED));
  parts.push(encodeVarint(streamCount));
  parts.push(encodeVarint(0));

  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const payload = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    payload.set(part, offset);
    offset += part.length;
  }

  const streamInfo = session.requestStreams.get(requestId);
  if (streamInfo) {
    const message = session.controlWriter!.encode(MessageType.PUBLISH_DONE, payload);
    session.statsControlMessagesSent++;
    session.emitDebug("send", MessageType.PUBLISH_DONE, payload, {
      requestId: requestId.toString(),
      statusCode: PublishDoneStatusCode.TRACK_ENDED,
      streamCount: streamCount.toString(),
    });
    // write 失敗は従来どおり黙殺し、失敗エラーは close 失敗の非昇格判定に
    // 併用するため保持する (詳細は close 失敗のコメント参照)。
    let writeError: unknown;
    try {
      await streamInfo.writer.write(message);
    } catch (err) {
      writeError = err;
    }

    // draft-ietf-moq-transport-19 §10.11:
    // publisher は PUBLISH_DONE を最後のメッセージとして送信した後、bidi ストリームを閉じる
    try {
      await streamInfo.writer.close();
    } catch (err) {
      // draft-ietf-moq-transport-19 §3.3.3:
      // 「An endpoint that has already sent a FIN on its sending direction and
      //  subsequently wishes to cancel sends STOP_SENDING on the receiving
      //  direction.」— ピアが FIN 後に STOP_SENDING で当方の送信方向を
      // キャンセルした場合、write / close は WebTransportError
      // (source: "stream") で reject する (W3C WebTransport の実装挙動。
      // 判定は isPeerStreamError 参照)。
      // STOP_SENDING の到着は非同期のため、write() が成功した後に close() が
      // 失敗するレースが実 WebTransport で起こり得る。このとき close 失敗エラー
      // 自体の source を判定して非昇格にする。
      // また write が既にピア起因のキャンセルで失敗している場合、その後の close
      // 失敗 (Node の実装では source なしの TypeError になることがある) も同じ
      // キャンセルの結果であるため、write 失敗エラーも併せて判定して非昇格にする。
      // どちらも stream でない失敗は従来どおり PROTOCOL_VIOLATION でセッションを閉じる。
      if (!isPeerStreamError(err) && !isPeerStreamError(writeError)) {
        session.closeWithError(
          new SessionError(
            `failed to close stream after PUBLISH_DONE: ${err instanceof Error ? err.message : String(err)}`,
            SessionErrorCode.PROTOCOL_VIOLATION,
          ),
        );
      }
    }
  }

  session.requestStreams.delete(requestId);
  session.publishers.delete(requestId);
}
