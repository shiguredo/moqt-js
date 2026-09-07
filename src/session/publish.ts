/**
 * Publisher 送信系 free function 群
 *
 * SessionImpl の sendObject / sendObjectInternal / closePublisherStream /
 * closePublisherStreamInternal / sendDatagram / getDatagramWriter / sendPublishDone
 * を free function として抽出する。
 *
 * draft-ietf-moq-transport-20 §2.2 (Subgroups):
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
import { encodeVarint, MAX_VARINT } from "../varint";
import { type PublisherImpl, type SendObjectParams, type SendDatagramParams } from "../publisher";
import { calculateObjectIdDelta } from "./params";
import { isPeerStreamError } from "./errors";
import { mergeDeliveryTimeoutObjectProperties, appendGreaseObjectProperty } from "../properties";
import type { SessionState } from "../session";
import type { SessionInternal } from "./types";
import type { BidiSessionInternal } from "./bidi";

/**
 * datagram 送信用 writer を取得する
 *
 * WebTransport の `datagrams.writable` は単一の WritableStream であり、writer は
 * 1 つだけロックを保持できる。最初の呼び出しで getWriter() して保持し、以降は同じ
 * writer を返す。
 */
function publishGetDatagramWriter(
  session: SessionInternal,
): WritableStreamDefaultWriter<Uint8Array> {
  session.datagramWriter ??= session.transport.datagrams.writable.getWriter();
  return session.datagramWriter;
}

/**
 * オブジェクトを送信する（Promise チェーン排他制御付き）
 *
 * draft-ietf-moq-transport-20 §2.2:
 * "Objects from the same Subgroup MUST NOT be sent on different streams"
 */
export function publishSendObject(
  session: SessionInternal,
  publisher: PublisherImpl,
  params: SendObjectParams,
): Promise<void> {
  const trackAlias = publisher.getTrackAlias();
  // draft-ietf-moq-transport-20 §11.4.2 / §11.3:
  // 不正 ID はローカル API 誤用のため、副作用 (ストリーム生成・統計加算・
  // キュー登録) の前に fail-fast で呼び出し元へ返す。groupId も objectId と
  // 同一契約に揃える (吸収して resolve する旧契約はやめる)。
  // 通知契約のため handleError も呼び、返値 Promise は reject する (解決しない)。
  let groupId: bigint;
  try {
    groupId = validateGroupAndObjectIdRange("group id", params.groupId);
    validateGroupAndObjectIdRange("object id", params.objectId);
  } catch (error) {
    const rejection = error instanceof Error ? error : new Error(String(error));
    publisher.handleError(rejection);
    return Promise.reject(rejection);
  }
  const previousPromise = session.publisherSendQueues.get(trackAlias) ?? Promise.resolve();
  const currentPromise = previousPromise
    .catch(() => {})
    .then(() => {
      // 閉じた Subgroup への送信を拒否する
      // draft-ietf-moq-transport-20 §11.4.3
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
 * Group ID / Object ID の値域を検証して bigint で返す
 *
 * draft-ietf-moq-transport-20 §11.4.2 / §11.3:
 * Group ID / Object ID は 0 以上 2^64-1 以下の整数である
 * (varint 上限と一致し、単一出所化のため MAX_VARINT を使う)。
 * 不正値はローカル API 誤用のため throw で呼び出し元へ返す
 * (セッションは閉じない)。
 *
 * @throws Error 非整数・範囲外の場合 (期待値と実際値を含む)
 */
function validateGroupAndObjectIdRange(kind: "group id" | "object id", value: number): bigint {
  if (!Number.isInteger(value)) {
    throw new Error(`invalid ${kind}: ${value}, expected integer 0 to ${MAX_VARINT}`);
  }
  const id = BigInt(value);
  if (id < 0n || id > MAX_VARINT) {
    throw new Error(`invalid ${kind}: ${value}, expected 0 to ${MAX_VARINT}`);
  }
  return id;
}

/**
 * オブジェクト送信の内部実装
 *
 * draft-ietf-moq-transport-20 Section 11.4.2 (Subgroup Header)
 */
export async function publishSendObjectInternal(
  session: SessionInternal,
  publisher: PublisherImpl,
  params: SendObjectParams,
): Promise<void> {
  const trackAlias = publisher.getTrackAlias();
  // ID 範囲検証は lookup・FIN より前に行う。公開経路では publishSendObject の
  // fail-fast が先に拒否するため、この throw が公開経路の handleError と
  // 二重通知になることはない。
  const groupId = validateGroupAndObjectIdRange("group id", params.groupId);
  const objectId = validateGroupAndObjectIdRange("object id", params.objectId);

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

    // Subgroup Header をエンコードする
    // draft-ietf-moq-transport-20 Section 11.4.2
    // ストリーム生成前にエンコードする。trackAlias / groupId が 2^64-1 を
    // 超える等でエンコードが throw した場合、新規ストリーム生成という
    // 副作用なしで失敗させるためである (グループ切替時の前ストリームの
    // FIN はエンコード前に実行済み)。
    const header = encodeSubgroupHeader({
      type: SubgroupHeaderType.FIRST_OBJ_EXT,
      trackAlias,
      groupId,
      publisherPriority: params.priority ?? 128,
      firstObject: true,
    });

    // 新しいストリームを開く
    const stream = await session.transport.createUnidirectionalStream();
    session.statsUnidirectionalStreamsOpened++;
    publisher.incrementDataStreamCount();
    const writer = stream.getWriter();

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

  // GREASE Object Property - draft-ietf-moq-transport-20 §14 (Grease)
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

  // Object Fields と payload は 1 回の write() で送信する。
  // draft-ietf-moq-transport-20 §11.4 / §11.4.3:
  // 2 回の write() の間に close (FIN) が割り込むと、宣言 payloadLength 未達の
  // FIN を送出し得る (§11.4 の serialized Object 途中の FIN / §11.4.3 の
  // 配信途中終了は reset MUST)。QUIC/WebTransport の write はセグメント境界を
  // 保証しないため、連結して単一 write にすることで割り込みの窓を構造的に
  // 無くす。
  // 空 payload 時は fields のみの単一 write になる (従来どおり)。
  // なお Subgroup Header の write と本 write の間には窓が残るが、header のみの
  // FIN は Object 途中の FIN には当たらず、session 終了時の teardown 競合に
  // 限定される。
  let objectBytes = data;
  if (params.payload.length > 0) {
    objectBytes = new Uint8Array(data.length + params.payload.length);
    objectBytes.set(data, 0);
    objectBytes.set(params.payload, data.length);
  }

  try {
    await streamState.writer.write(objectBytes);
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
  session: BidiSessionInternal,
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
async function publishClosePublisherStreamInternal(
  session: BidiSessionInternal,
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
 * draft-ietf-moq-transport-20 Section 11.3 (Datagrams)
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

  // 不正 ID はローカル API 誤用のため、送信前に通知して throw する
  // (戻り値が void のため throw 維持。sendObject の通知 + reject と対称)。
  // closed 時は検証より先に no-op で返す (終了後の送信試行を抑止する)。
  let groupId: bigint;
  let objectId: bigint;
  try {
    groupId = validateGroupAndObjectIdRange("group id", params.groupId);
    objectId = validateGroupAndObjectIdRange("object id", params.objectId);
  } catch (error) {
    const rejection = error instanceof Error ? error : new Error(String(error));
    publisher.handleError(rejection);
    throw rejection;
  }

  // GREASE Object Property - draft-ietf-moq-transport-20 §14 (Grease)
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

  // エンコード失敗もローカル誤用のため通知して throw する
  // (ID 検証と同一の通知契約にする)。
  let datagram: Uint8Array;
  try {
    datagram = encodeObjectDatagram({
      type,
      trackAlias: publisher.getTrackAlias(),
      groupId,
      objectId,
      publisherPriority: params.priority ?? 128,
      properties,
      payload: params.payload,
    });
  } catch (error) {
    const rejection = error instanceof Error ? error : new Error(String(error));
    publisher.handleError(rejection);
    throw rejection;
  }

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
 * draft-ietf-moq-transport-20 Section 10.12 (PUBLISH_DONE)
 *
 * status は必須引数とする (後方互換の既定値は付けない)。
 * 正常終了は TRACK_ENDED、REQUEST_UPDATE 失敗時は UPDATE_FAILED を渡す。
 */
export async function publishSendPublishDone(
  session: BidiSessionInternal,
  publisher: PublisherImpl,
  status: PublishDoneStatusCode,
): Promise<void> {
  await publishSendPublishDoneCore(
    session,
    publisher.getRequestId(),
    publisher.getDataStreamCount(),
    status,
  );
}

/**
 * Publisher がない購読に PUBLISH_DONE を送信する
 *
 * draft-ietf-moq-transport-20 §10.12:
 * 開設ストリーム数の正確数を確定できないため、Stream Count は
 * 呼び出し側が決める (不明な場合は 2^64 - 1 の MUST 後段に従う)。
 * Error Reason は空のまま変えない。
 *
 * @param streamCount - 開設ストリーム数。不明な場合は MAX_VARINT (2^64 - 1) を渡す
 */
export async function publishSendPublishDoneWithoutPublisher(
  session: BidiSessionInternal,
  requestId: bigint,
  streamCount: bigint,
  status: PublishDoneStatusCode,
): Promise<void> {
  await publishSendPublishDoneCore(session, requestId, streamCount, status);
}

async function publishSendPublishDoneCore(
  session: BidiSessionInternal,
  requestId: bigint,
  streamCount: bigint,
  status: PublishDoneStatusCode,
): Promise<void> {
  // セッション終了後は送信を試行しない。
  // アプリの session.close() でもピア起点の終了でも publishers は markClosed
  // され done() が no-op になるが、ストリーム単位の終了とセッション終了の
  // レースがあるため、ここでガードする。ガードしないと write / close が
  // セッション終了起因のエラーで失敗し、誤って PROTOCOL_VIOLATION に昇格して
  // callbacks.error に通知される。
  if (session.sessionState === "closed") {
    return;
  }

  const parts: Uint8Array[] = [];
  parts.push(encodeVarint(status));
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
  // controlWriter 不在では何も送信できない (終了処理はベストエフォートのため
  // 黙殺し、後段のマップ掃除は行う)。
  if (streamInfo && session.controlWriter) {
    const message = session.controlWriter.encode(MessageType.PUBLISH_DONE, payload);
    session.statsControlMessagesSent++;
    // アプリの debug コールバック例外で終了処理を壊さないよう隔離する
    // (bidiSendRequestMessage 内の emitDebug は try 内にあるため同様に安全)。
    try {
      session.emitDebug("send", MessageType.PUBLISH_DONE, payload, {
        requestId: requestId.toString(),
        statusCode: status,
        streamCount: streamCount.toString(),
      });
    } catch {
      // アプリのコールバック例外は無視する
    }
    // write 失敗は従来どおり黙殺し、失敗エラーは close 失敗の非昇格判定に
    // 併用するため保持する (詳細は close 失敗のコメント参照)。
    let writeError: unknown;
    try {
      await streamInfo.writer.write(message);
    } catch (err) {
      writeError = err;
    }

    // draft-ietf-moq-transport-20 §10.12:
    // publisher は PUBLISH_DONE を最後のメッセージとして送信した後、bidi ストリームを閉じる
    try {
      await streamInfo.writer.close();
    } catch (err) {
      // draft-ietf-moq-transport-20 §3.3.3:
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
        // session.close() との並行実行では、ローカルの writer.abort() 起因の
        // close 失敗 (source なしの TypeError) がここに到達し得る。セッションは
        // 既に閉じているため、この失敗はピアの違反ではなく誤報になる。
        // 入り口ガード (関数先頭の sessionState チェック) 通過後にセッションが
        // 閉じた場合は PROTOCOL_VIOLATION に昇格しない。
        // ピア起因のセッション終了 (transport.closed) は sessionState 遷移が
        // 非同期のため、reject 処理時に遷移が完了している場合のみ再確認が
        // 機能する。遷移より先に reject が処理された場合は昇格し得る既知の
        // 残余リスクである (エラーの source 判定に依存せず、sessionState の
        // 再確認のみで判定する設計のため。両経路の検証は bidi.test.ts の
        // close() 並行テスト / ピア起因テストを参照)。
        // なお、入り口ガードにより sessionState は "connected" に絞り込まれる
        // ため、絞り込みを解除して実状態を再確認する。
        if ((session.sessionState as SessionState) !== "closed") {
          session.closeWithError(
            new SessionError(
              `failed to close stream after PUBLISH_DONE: ${err instanceof Error ? err.message : String(err)}`,
              SessionErrorCode.PROTOCOL_VIOLATION,
            ),
          );
        }
      }
    }
  }

  session.requestStreams.delete(requestId);
  session.publishers.delete(requestId);
}
