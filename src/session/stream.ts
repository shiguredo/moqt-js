/**
 * MOQT Session - データストリーム処理（純粋ヘルパー関数）
 *
 * SessionImpl から抽出した受信データストリーム処理の純粋関数。
 * 統計更新や handleObject 呼び出しはコールバック経由で行う。
 */

import type { FetchObjectContext, MoqtObject, SubgroupHeader } from "../dataStream";
import { decodeFetchObjectFields, decodeObjectFields } from "../dataStream";
import { IncompleteDataError } from "../error";
import { ObjectStatus } from "../message";
import type { FetcherImpl } from "../fetcher";
import type { SubscriberImpl } from "../subscriber";
import type { GroupOrder } from "../message/types";

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
  subscriber: SubscriberImpl,
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

      stats.incrementObjectsReceived(true);
      stats.incrementBytesReceived(true, payload.byteLength);

      subscriber.handleObject(object);
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
