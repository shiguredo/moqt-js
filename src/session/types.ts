/**
 * SessionInternal インターフェースと共有型
 *
 * bidi.ts の BidiSessionInternal を継承し、抽出先モジュール
 * (namespaceLoops.ts / publish.ts / incoming.ts) が必要とする追加フィールドを宣言する。
 *
 * session.ts → types.ts → bidi.ts → session.ts のチェーンは型レベルの循環を形成するが、
 * すべての辺が import type であるため TypeScript コンパイラは受理する。
 * 値レベル（実行時）での循環依存は発生しない。
 */

import type { BidiSessionInternal } from "./bidi";
import type { ControlStreamReader } from "../controlStream";
import type { RangeFilterSpec } from "../message/parameter";
import type {
  ConnectCallbacks,
  NamespaceSubscriptionCallbacks,
  TracksSubscriptionCallbacks,
  NamespacePublicationCallbacks,
  NamespaceSubscription,
  TracksSubscription,
  NamespacePublication,
} from "../session";

// namespaceLoops.ts / incoming.ts / publish.ts から参照される状態型

export interface NamespaceSubscriptionState {
  callbacks: NamespaceSubscriptionCallbacks;
  state: "active" | "closed";
  namespacePrefix: string[];
  /**
   * REQUEST_UPDATE で送信中 (REQUEST_OK 未受信) の新 Track Namespace Prefix。
   * draft-ietf-moq-transport-20 §10.9.2:
   * REQUEST_OK 受信時に namespacePrefix へ反映し、REQUEST_ERROR 時は反映せずクリアする。
   */
  pendingPrefix?: string[];
  stream?: WebTransportBidirectionalStream;
  streamReader?: ReadableStreamDefaultReader<Uint8Array>;
  controlReader?: ControlStreamReader;
  writer?: WritableStreamDefaultWriter<Uint8Array>;
}

export interface TracksSubscriptionState {
  callbacks: TracksSubscriptionCallbacks;
  state: "active" | "closed";
  namespacePrefix: string[];
  /**
   * SUBSCRIBE_TRACKS 送信時に指定された Range Filters。
   * draft-ietf-moq-transport-20 §5.1.4:
   * TRACK_PROPERTY_FILTER は受信 PUBLISH の評価に使用する。
   */
  rangeFilters?: RangeFilterSpec[];
  /**
   * REQUEST_UPDATE で送信中 (REQUEST_OK 未受信) の新 Track Namespace Prefix。
   * draft-ietf-moq-transport-20 §10.9.2:
   * REQUEST_OK 受信時に namespacePrefix へ反映し、REQUEST_ERROR 時は反映せずクリアする。
   */
  pendingPrefix?: string[];
  stream?: WebTransportBidirectionalStream;
  streamReader?: ReadableStreamDefaultReader<Uint8Array>;
  controlReader?: ControlStreamReader;
  writer?: WritableStreamDefaultWriter<Uint8Array>;
}

interface NamespacePublicationState {
  callbacks?: NamespacePublicationCallbacks;
  state: "pending" | "active" | "closed";
  namespace: string[];
  stream: WebTransportBidirectionalStream;
  streamReader: ReadableStreamDefaultReader<Uint8Array>;
  controlReader: ControlStreamReader;
  writer: WritableStreamDefaultWriter<Uint8Array>;
}

interface PublisherStreamState {
  groupId: bigint;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  previousObjectId: bigint;
}

/**
 * SessionInternal = BidiSessionInternal の全フィールド + 抽出先が必要とする追加フィールド
 *
 * SessionImpl が implements する。抽出先 free function はこのインターフェースを引数に受け取る。
 */
export interface SessionInternal extends BidiSessionInternal {
  // ============================================================
  // namespaceLoops.ts 用
  // ============================================================
  readonly namespacePublications: Map<bigint, NamespacePublicationState>;

  createNamespaceSubscription(requestId: bigint): NamespaceSubscription;
  createTracksSubscription(requestId: bigint): TracksSubscription;
  createNamespacePublication(requestId: bigint): NamespacePublication;

  // ============================================================
  // publish.ts 用
  // ============================================================
  readonly publisherStreams: Map<bigint, PublisherStreamState>;
  readonly publisherSendQueues: Map<bigint, Promise<void>>;
  readonly closedSubgroups: Set<string>;
  // Writable である必要あり: getDatagramWriter が ??= で遅延代入するため
  datagramWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
  // 抽出先 free function からインクリメントされるため readonly 不可
  statsUnidirectionalStreamsOpened: number;

  // ============================================================
  // incoming.ts 用
  // ============================================================
  // handleIncomingDatagram が statsUnidirectionalStreamsReceived をインクリメントする。
  statsUnidirectionalStreamsReceived: number;

  // ============================================================
  // publish.ts 用（追加分）
  // ============================================================
  // draft-ietf-moq-transport-20 §10.3.1.6: ピアの MAX_FILTER_RANGES（0 = Range Filter 送信禁止）
  peerMaxFilterRanges: number;

  // draft-ietf-moq-transport-20 §14 (Grease): true のとき Track / Object Properties に
  // GREASE Property を 1 つ注入する。ConnectOptions.grease を initialize() で受け渡す。
  readonly grease: boolean;

  readonly callbacks: ConnectCallbacks;
}
