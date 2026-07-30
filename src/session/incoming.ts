/**
 * 受信系 free function 群
 *
 * SessionImpl の handleIncomingDatagram / waitForFetcher /
 * processFetchObjects ラッパー / processSubgroupObjects ラッパー
 * を free function として抽出する。
 *
 * handleIncomingStream / handleSubgroupStream は SessionImpl に残留する
 * （状態結合が強いため。issue 0302 設計方針参照）。
 */

import { decodeVarint } from "../varint";
import { decodeObjectDatagram, type MoqtObject } from "../dataStream";
import { ObjectStatus } from "../message";
import { toProtocolViolationSessionError } from "./errors";
import {
  processFetchObjects as streamProcessFetchObjects,
  processSubgroupObjects as streamProcessSubgroupObjects,
} from "./stream";
import type { FetcherImpl } from "../fetcher";
import type { SubscriberImpl } from "../subscriber";
import type { SessionInternal } from "./types";

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
    // ProtocolViolationError は仕様違反のため PROTOCOL_VIOLATION でセッションを閉じる
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
