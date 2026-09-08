/**
 * MOQT Session - データストリーム処理（純粋ヘルパー関数）
 *
 * SessionImpl から抽出した受信データストリーム処理の純粋関数。
 * 統計更新や handleObject 呼び出しはコールバック経由で行う。
 */

import type { FetchObjectContext, MoqtObject, SubgroupHeader } from "../dataStream";
import { decodeFetchObjectFields, decodeObjectFields } from "../dataStream";
import { IncompleteDataError, ProtocolViolationError } from "../error";
import { ObjectStatus } from "../message";
import type { SubscriberImpl } from "../subscriber";
import type { GroupOrder } from "../message/types";
import { readDeliveryTimeoutObjectProperties } from "../properties";

/**
 * Object ID の最大値 (2^64 - 1)
 * draft-ietf-moq-transport-20 §11.4.2:
 * "If the resulting Object ID would be greater than 2^64 - 1,
 *  the endpoint MUST close the session with a PROTOCOL_VIOLATION."
 */
const maxObjectId = (1n << 64n) - 1n;

interface StreamStatsUpdate {
  incrementObjectsReceived(subscribePath: boolean): void;
  incrementBytesReceived(subscribePath: boolean, bytes: number): void;
}

/**
 * Fetch オブジェクトの配送先
 *
 * 通常 FETCH は FetcherImpl、fill fetch ストリームは購読へのアダプタが入る。
 * どちらも active でなければ受け取らない契約は受け側が持つ。
 */
export interface FetchObjectSink {
  handleObject(object: MoqtObject): void;
}

// ============================================================================
// processFetchObjects
// ============================================================================

/**
 * @param groupOrder - Group Order (GroupOrder.ASCENDING or GroupOrder.DESCENDING)
 *   draft-ietf-moq-transport-20 §11.4.4.1 / §10.2.8
 */
export function processFetchObjects(
  buffer: Uint8Array,
  sink: FetchObjectSink,
  context: FetchObjectContext | null,
  isFirst: boolean,
  stats: StreamStatsUpdate,
  groupOrder: GroupOrder,
): {
  remainingBuffer: Uint8Array;
  context: FetchObjectContext | null;
  isFirst: boolean;
} {
  let offset = 0;
  let currentContext = context;
  let currentIsFirst = isFirst;

  while (offset < buffer.length) {
    try {
      const [fields, fieldsConsumed, newContext] = decodeFetchObjectFields(
        buffer,
        currentContext,
        offset,
        currentIsFirst,
        groupOrder,
      );

      const payloadLength = Number(fields.payloadLength);
      const totalNeeded = offset + fieldsConsumed + payloadLength;

      if (totalNeeded > buffer.length) {
        break;
      }

      offset += fieldsConsumed;

      const payload = buffer.slice(offset, offset + payloadLength);
      offset += payloadLength;

      currentContext = newContext;
      currentIsFirst = false;

      // draft-ietf-moq-transport-20 Section 11.4.4.2:
      // End of Range レコードは実際のオブジェクトデータを含まないためスキップする。
      // コンテキスト (Group ID, Object ID 等) は既に newContext で更新済み。
      if (fields.endOfRange) {
        continue;
      }

      // draft-ietf-moq-transport-20 Section 11.2.1.1:
      // Fetch Object には Object Status が存在しないため NORMAL として扱う
      const object: MoqtObject = {
        groupId: fields.groupId,
        subgroupId: fields.subgroupId,
        objectId: fields.objectId,
        publisherPriority: fields.publisherPriority,
        status: ObjectStatus.NORMAL,
        properties:
          fields.properties && fields.properties.length > 0 ? fields.properties : undefined,
        payload,
      };

      stats.incrementObjectsReceived(false);
      stats.incrementBytesReceived(false, payload.byteLength);

      sink.handleObject(object);
    } catch (err) {
      if (err instanceof IncompleteDataError) {
        break;
      }
      throw err;
    }
  }

  return {
    remainingBuffer: buffer.slice(offset),
    context: currentContext,
    isFirst: currentIsFirst,
  };
}

// ============================================================================
// processSubgroupObjects
// ============================================================================

/**
 * subgroup 配送時のアプリ例外の通知と継続のためのフック
 *
 * `incomingHandleDatagram` と同形の防御を `processSubgroupObjects` で行うため、
 * 呼び出し側 (incoming 層) がセッション由来のコールバックを注入する。
 * `recordCallbackError` は throw してはならない
 * (incoming 層の実装がデバッグ記録の失敗を握り潰す)。
 */
export interface SubgroupDeliveryHooks {
  /**
   * アプリ例外を当該 subscriber の error コールバックへ通知する。
   * Error 正規化は注入側の責務とする (datagram 経路と同形)。
   */
  notifyError: (subscriber: SubscriberImpl, error: unknown) => void;
  /**
   * error コールバック自体の throw をデバッグ記録する。
   * payload は当該オブジェクト単位 (datagram 経路の data 全体と異なる)。
   */
  recordCallbackError: (payload: Uint8Array, error: unknown) => void;
}

export function processSubgroupObjects(
  buffer: Uint8Array,
  subscribers: SubscriberImpl[],
  header: SubgroupHeader,
  previousObjectId: bigint,
  stats: StreamStatsUpdate,
  delivery: SubgroupDeliveryHooks,
  resolvedSubgroupId?: bigint,
): {
  remainingBuffer: Uint8Array;
  previousObjectId: bigint;
  resolvedSubgroupId: bigint | undefined;
} {
  let offset = 0;
  let currentPreviousObjectId = previousObjectId;
  // draft-ietf-moq-transport-20 Section 11.4.2:
  // Subgroup ID = First Object ID の場合、最初のオブジェクトの Object ID を
  // Subgroup ID として使用する。呼び出し側で保持した値を優先し、
  // 未保持時のみヘッダ由来値から初期化する (feed 間の状態引き継ぎ)。
  // 同一ストリームの同一 header の連続 feed を前提とする。
  let currentResolvedSubgroupId = resolvedSubgroupId ?? header.subgroupId;

  while (offset < buffer.length) {
    // この subgroup で最初のオブジェクトかどうかをデコード直前に捕捉する。
    // 同一 subgroup の 2 件目以降は currentPreviousObjectId が進むため false になる。
    // 仮引数 previousObjectId (バッチ先頭値) を使うとバッチ全体が先頭扱いになる。
    // 送信側 src/session/publish.ts の isFirstInSubgroup と対称。
    // 呼び出し側が previousObjectId を feed 間で引き継ぐことが前提。
    // draft-ietf-moq-transport-20 §8 / §12.1 / §12.2:
    // 先頭オブジェクトのみ上書きし、先頭以外は無視する。
    const isFirstInSubgroup = currentPreviousObjectId < 0n;
    try {
      const [fields, fieldsConsumed] = decodeObjectFields(buffer, header.type, offset);

      const payloadLength = Number(fields.payloadLength);
      const totalNeeded = offset + fieldsConsumed + payloadLength;

      if (totalNeeded > buffer.length) {
        break;
      }

      offset += fieldsConsumed;

      let objectId: bigint;
      if (isFirstInSubgroup) {
        objectId = fields.objectIdDelta;
      } else {
        objectId = currentPreviousObjectId + fields.objectIdDelta + 1n;
      }
      currentPreviousObjectId = objectId;

      // Object ID の範囲検証: 0 以上 2^64-1 以下
      // draft-ietf-moq-transport-20 §11.4.2:
      // "If the resulting Object ID would be greater than 2^64 - 1,
      //  the endpoint MUST close the session with a PROTOCOL_VIOLATION."
      if (objectId > maxObjectId) {
        throw new ProtocolViolationError(
          `computed object id out of range: ${objectId}, expected 0 to 2^64-1`,
        );
      }

      currentResolvedSubgroupId ??= objectId;

      const payload = buffer.slice(offset, offset + payloadLength);
      offset += payloadLength;

      const object: MoqtObject = {
        groupId: header.groupId,
        subgroupId: currentResolvedSubgroupId,
        objectId,
        publisherPriority: header.publisherPriority,
        status: fields.status,
        properties: fields.properties.length > 0 ? fields.properties : undefined,
        payload,
      };

      // draft-ietf-moq-transport-20 Section 8 / §12.1 / §12.2:
      // subgroup 先頭オブジェクトの Object Property から delivery timeout を抽出する。
      // 先頭以外に同 ID が付いていても ignore（PROTOCOL_VIOLATION にしない）。
      if (isFirstInSubgroup && fields.properties.length > 0) {
        const timeouts = readDeliveryTimeoutObjectProperties(fields.properties);
        if (timeouts.objectDeliveryTimeout !== undefined) {
          object.objectDeliveryTimeout = timeouts.objectDeliveryTimeout;
        }
        if (timeouts.subgroupDeliveryTimeout !== undefined) {
          object.subgroupDeliveryTimeout = timeouts.subgroupDeliveryTimeout;
        }
      }

      stats.incrementObjectsReceived(true);
      stats.incrementBytesReceived(true, payload.byteLength);

      // draft-ietf-moq-transport-20 §5.1: 同一 alias の全 subscription に配送
      // (filter 再適用は各 handleObject 内)。
      // アプリ例外は当該 subscriber の error コールバックへ通知し、
      // 残りの配送と同一ストリームの後続処理を継続する。セッションは閉じない。
      // 反復前に複製する (error コールバック内の unsubscribe() が
      // 配列を破壊的に変更しても、後続購読への配送が欠落しないようにする)。
      for (const sub of subscribers.slice()) {
        try {
          sub.handleObject(object);
        } catch (err) {
          // error コールバック自体の throw はデバッグ記録に残し、
          // 残りの配送を継続する。
          try {
            delivery.notifyError(sub, err);
          } catch (callbackError) {
            delivery.recordCallbackError(payload, callbackError);
          }
        }
      }
    } catch (err) {
      if (err instanceof IncompleteDataError) {
        break;
      }
      throw err;
    }
  }

  return {
    remainingBuffer: buffer.slice(offset),
    previousObjectId: currentPreviousObjectId,
    resolvedSubgroupId: currentResolvedSubgroupId,
  };
}

// ============================================================================
// concatChunks
// ============================================================================

export function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

// ============================================================================
// cancelStreamQuiet
// ============================================================================

export async function cancelStreamQuiet(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: string,
): Promise<void> {
  try {
    await reader.cancel(reason);
  } catch {
    // ignore
  }
}
