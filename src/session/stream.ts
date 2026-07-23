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
import type { FetcherImpl } from "../fetcher";
import type { SubscriberImpl } from "../subscriber";
import type { GroupOrder } from "../message/types";
import { readDeliveryTimeoutObjectProperties } from "../properties";

/**
 * Object ID の最大値 (2^64 - 1)
 * draft-ietf-moq-transport-18 §11.4.2:
 * "If the resulting Object ID would be greater than 2^64 - 1,
 *  the endpoint MUST close the session with a PROTOCOL_VIOLATION."
 */
const maxObjectId = (1n << 64n) - 1n;

export interface StreamStatsUpdate {
  incrementObjectsReceived(subscribePath: boolean): void;
  incrementBytesReceived(subscribePath: boolean, bytes: number): void;
}

// ============================================================================
// processFetchObjects
// ============================================================================

/**
 * @param groupOrder - Group Order (GroupOrder.ASCENDING or GroupOrder.DESCENDING)
 *   draft-ietf-moq-transport-18 §11.4.4.1 Table 9
 */
export function processFetchObjects(
  buffer: Uint8Array,
  fetcher: FetcherImpl,
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

      // draft-ietf-moq-transport-18 Section 11.4.4.2:
      // End of Range レコードは実際のオブジェクトデータを含まないためスキップする。
      // コンテキスト (Group ID, Object ID 等) は既に newContext で更新済み。
      if (fields.endOfRange) {
        continue;
      }

      // draft-ietf-moq-transport-18 Section 11.2.1.1:
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

      fetcher.handleObject(object);
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

export function processSubgroupObjects(
  buffer: Uint8Array,
  subscribers: SubscriberImpl[],
  header: SubgroupHeader,
  previousObjectId: bigint,
  stats: StreamStatsUpdate,
): { remainingBuffer: Uint8Array; previousObjectId: bigint } {
  let offset = 0;
  let currentPreviousObjectId = previousObjectId;
  // draft-ietf-moq-transport-18 Section 11.4.2:
  // Subgroup ID = First Object ID の場合、最初のオブジェクトの Object ID を
  // Subgroup ID として使用する
  let resolvedSubgroupId = header.subgroupId;

  while (offset < buffer.length) {
    try {
      const [fields, fieldsConsumed] = decodeObjectFields(buffer, header.type, offset);

      const payloadLength = Number(fields.payloadLength);
      const totalNeeded = offset + fieldsConsumed + payloadLength;

      if (totalNeeded > buffer.length) {
        break;
      }

      offset += fieldsConsumed;

      let objectId: bigint;
      if (currentPreviousObjectId < 0n) {
        objectId = fields.objectIdDelta;
      } else {
        objectId = currentPreviousObjectId + fields.objectIdDelta + 1n;
      }
      currentPreviousObjectId = objectId;

      // Object ID の範囲検証: 0 以上 2^64-1 以下
      // draft-ietf-moq-transport-18 §11.4.2:
      // "If the resulting Object ID would be greater than 2^64 - 1,
      //  the endpoint MUST close the session with a PROTOCOL_VIOLATION."
      if (objectId > maxObjectId) {
        throw new ProtocolViolationError(
          `computed object id out of range: ${objectId}, expected 0 to 2^64-1`,
        );
      }

      resolvedSubgroupId ??= objectId;

      const payload = buffer.slice(offset, offset + payloadLength);
      offset += payloadLength;

      const object: MoqtObject = {
        groupId: header.groupId,
        subgroupId: resolvedSubgroupId,
        objectId,
        publisherPriority: header.publisherPriority,
        status: fields.status,
        properties: fields.properties.length > 0 ? fields.properties : undefined,
        payload,
      };

      // draft-ietf-moq-transport-19 Section 8:
      // subgroup 先頭オブジェクトの Object Property から delivery timeout を抽出する。
      // 先頭以外に同 ID が付いていても ignore（PROTOCOL_VIOLATION にしない）。
      if (previousObjectId < 0n && fields.properties.length > 0) {
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

      // draft-ietf-moq-transport-19 §5.1: 同一 alias の全 subscription に配送（filter 再適用は各 handleObject 内）
      for (const sub of subscribers) {
        sub.handleObject(object);
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
