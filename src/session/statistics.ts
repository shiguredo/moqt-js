/**
 * セッションレベルの統計情報
 *
 * SessionImpl.getStatistics() の組み立てを free function として抽出する。
 * 集計対象は受信経路ごとの累計カウンター、バッファ / ストリームの現在値、
 * 制御メッセージの累計である。カウンターの加算は各経路
 * (publish.ts / incoming.ts / bidi.ts / session.ts) が行い、ここでは読むだけにする。
 */

import type { PendingSubgroupBuffer } from "../pendingSubgroupBuffer";

/**
 * セッションレベルの統計情報
 */
export interface SessionStatistics {
  // オブジェクト受信
  /**
   * 通常 FETCH のデータストリーム経由で受信したオブジェクト数
   *
   * fill fetch ストリーム経由のオブジェクトは含まない (objectsReceivedViaFill を参照)。
   * draft-ietf-moq-transport-21 §3.4 (Fill Semantics) の fill-delivered と
   * 通常 FETCH は別経路のため、配送経路の区別 (MoqtObject.fillDelivered) と
   * 統計区分を一致させている。
   */
  objectsReceivedViaFetch: number;
  /** fill fetch ストリーム経由で受信したオブジェクト数 */
  objectsReceivedViaFill: number;
  /** SUBSCRIBE 経由で受信したオブジェクト数 */
  objectsReceivedViaSubscribe: number;
  /** 通常 FETCH のデータストリーム経由で受信したバイト数 (fill 経由は含まない) */
  bytesReceivedViaFetch: number;
  /** fill fetch ストリーム経由で受信したバイト数 */
  bytesReceivedViaFill: number;
  /** SUBSCRIBE 経由で受信したバイト数 */
  bytesReceivedViaSubscribe: number;

  // バッファ状態
  /** SUBSCRIBE_OK 前に到着した Subgroup ストリーム数 */
  pendingSubgroupStreamsCount: number;
  /** SUBSCRIBE_OK 前に到着した Subgroup ストリームのバイト数 */
  pendingSubgroupStreamsBytes: number;

  // ストリーム状態
  /** アクティブな Publisher 数 */
  activePublishers: number;
  /** アクティブな Subscriber 数 */
  activeSubscribers: number;
  /** アクティブな Fetcher 数 */
  activeFetchers: number;

  // WebTransport ストリーム統計
  /** Publisher が開いている送信ストリーム数 */
  publisherStreamsOpen: number;
  /** 現在読み取り中の受信ストリーム数 */
  subscriberStreamsActive: number;

  // データストリーム統計（累計）
  /** Publisher が開いた送信ストリーム数（累計） */
  unidirectionalStreamsOpened: number;
  /** 受信した Unidirectional ストリーム数 */
  unidirectionalStreamsReceived: number;
  /** パースした Subgroup ヘッダー数 */
  subgroupHeadersReceived: number;
  /** パースした Fetch ヘッダー数 */
  fetchHeadersReceived: number;

  // Control Stream 統計（累計）
  /** 送信した Control Message 数 */
  controlMessagesSent: number;
  /** 受信した Control Message 数 */
  controlMessagesReceived: number;
}

/**
 * 統計の集計元
 *
 * SessionImpl のフィールドのうち、統計の組み立てに必要なものだけを宣言する。
 * Map の要素型は件数しか見ないため unknown とする (要素型に依存しない)。
 */
export interface SessionStatisticsSource {
  readonly pendingSubgroupBuffer: PendingSubgroupBuffer;
  readonly publishers: ReadonlyMap<bigint, unknown>;
  readonly subscribers: ReadonlyMap<bigint, unknown>;
  readonly fetchers: ReadonlyMap<bigint, unknown>;
  readonly publisherStreams: ReadonlyMap<bigint, unknown>;

  readonly statsObjectsReceivedViaFetch: number;
  readonly statsObjectsReceivedViaFill: number;
  readonly statsObjectsReceivedViaSubscribe: number;
  readonly statsBytesReceivedViaFetch: number;
  readonly statsBytesReceivedViaFill: number;
  readonly statsBytesReceivedViaSubscribe: number;
  readonly statsUnidirectionalStreamsOpened: number;
  readonly statsUnidirectionalStreamsReceived: number;
  readonly statsSubscriberStreamsActive: number;
  readonly statsSubgroupHeadersReceived: number;
  readonly statsFetchHeadersReceived: number;
  readonly statsControlMessagesSent: number;
  readonly statsControlMessagesReceived: number;
}

/**
 * セッションレベルの統計情報を取得する
 */
export function sessionGetStatistics(session: SessionStatisticsSource): SessionStatistics {
  return {
    objectsReceivedViaFetch: session.statsObjectsReceivedViaFetch,
    objectsReceivedViaFill: session.statsObjectsReceivedViaFill,
    objectsReceivedViaSubscribe: session.statsObjectsReceivedViaSubscribe,
    bytesReceivedViaFetch: session.statsBytesReceivedViaFetch,
    bytesReceivedViaFill: session.statsBytesReceivedViaFill,
    bytesReceivedViaSubscribe: session.statsBytesReceivedViaSubscribe,
    pendingSubgroupStreamsCount: session.pendingSubgroupBuffer.streamCount,
    pendingSubgroupStreamsBytes: session.pendingSubgroupBuffer.totalBytes,
    activePublishers: session.publishers.size,
    activeSubscribers: session.subscribers.size,
    activeFetchers: session.fetchers.size,
    publisherStreamsOpen: session.publisherStreams.size,
    subscriberStreamsActive: session.statsSubscriberStreamsActive,
    unidirectionalStreamsOpened: session.statsUnidirectionalStreamsOpened,
    unidirectionalStreamsReceived: session.statsUnidirectionalStreamsReceived,
    subgroupHeadersReceived: session.statsSubgroupHeadersReceived,
    fetchHeadersReceived: session.statsFetchHeadersReceived,
    controlMessagesSent: session.statsControlMessagesSent,
    controlMessagesReceived: session.statsControlMessagesReceived,
  };
}
