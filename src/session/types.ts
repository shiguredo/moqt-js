/**
 * MOQT Session プロトコル層の型定義
 * draft-ietf-moq-transport-17 Section 3, 5, 6, 9
 *
 * draft 由来の実装のため、将来のバージョンで変更される可能性がある。
 */

import type { SessionError } from "../error";
import type {
  Fetch,
  Location,
  Parameter,
  Publish,
  PublishNamespace,
  Subscribe,
  SubscribeNamespace,
  TrackNamespace,
  TrackStatus,
} from "../message";
import type { ControlMessage } from "../message/control";

/**
 * エンドポイントの役割
 * draft-ietf-moq-transport-17 Section 3.1 (Endpoints)
 */
export type Role = "client" | "server";

/**
 * 下位トランスポート種別
 * draft-ietf-moq-transport-17 Section 3.1 (Endpoints)
 */
export type Transport = "quic" | "webTransport";

/**
 * セッション状態
 * draft-ietf-moq-transport-17 Section 3.3 (Session Establishment)
 *
 * - setup: 自側の SETUP 送信済み、相手側 SETUP 未受信
 * - established: 両側 SETUP 完了、通常運用中
 * - closing: close() 呼び出し済み、closeSession イベント発行済みで未 poll の状態
 * - closed: セッション完全終了
 */
export type SessionState = "setup" | "established" | "closing" | "closed";

// ─── Subscription 状態管理 ──────────────────────────────
// draft-ietf-moq-transport-17 Section 5.1, 5.1.1

/**
 * Subscription を開始した側
 * draft-ietf-moq-transport-17 Section 5.1 (Subscriptions)
 */
export type SubscriptionInitiator = "subscriber" | "publisher";

/**
 * 自エンドポイントが担う Track 上の役割
 */
export type TrackRole = "publisher" | "subscriber";

/**
 * Subscription 状態機械
 * draft-ietf-moq-transport-17 Section 5.1 (Subscriptions)
 *
 * - pendingSubscriber: SUBSCRIBE 送信直後、SUBSCRIBE_OK / REQUEST_ERROR 待ち
 * - pendingPublisher:  PUBLISH 送信直後、PUBLISH_OK / REQUEST_ERROR 待ち
 * - established:       応答 OK 受信済み、Object 転送可能
 * - terminated:        REQUEST_ERROR / PUBLISH_DONE / STOP_SENDING で終了
 */
export type SubscriptionState =
  | "pendingSubscriber"
  | "pendingPublisher"
  | "established"
  | "terminated";

/**
 * Subscription 単位の状態エントリ
 */
export interface SubscriptionEntry {
  /** Request ID */
  requestId: bigint;
  /** Subscription を開始した側 */
  initiator: SubscriptionInitiator;
  /** 自端点の役割 */
  myRole: TrackRole;
  /** Track Namespace */
  trackNamespace: TrackNamespace;
  /** Track Name */
  trackName: Uint8Array;
  /** Track Alias (PUBLISH 送信時または SUBSCRIBE_OK 受信時に確定) */
  trackAlias: bigint | null;
  /** 現在の状態 */
  state: SubscriptionState;
  /**
   * Forward State
   * draft-ietf-moq-transport-17 Section 9.3.10 (FORWARD Parameter)
   * 0 = 送らない / 1 = 送る
   */
  forwardState: 0 | 1;
  /**
   * Largest Location
   * draft-ietf-moq-transport-17 Section 5.1, 9.3.9 (LARGEST_OBJECT Parameter):
   * SUBSCRIBE_OK / PUBLISH / REQUEST_OK の LARGEST_OBJECT から保存する
   */
  largestLocation: Location | null;
}

/**
 * Publisher 向け read-only view
 * draft-ietf-moq-transport-17 Section 5.1 (Subscriptions)
 *
 * SessionMachine が publisher role (myRole === "publisher") の SubscriptionEntry を
 * Publisher facade 用に射影する型。Publisher 自身に local state を持たせず、
 * SessionMachine が単一の source of truth になるための経路。
 * - state: "terminated" を "closed" に、その他を "active" に射影
 * - isEstablished: state === "established" (PUBLISH_OK 受信済み)
 * - forwardState: FORWARD パラメータを boolean に射影
 */
export interface PublicationView {
  requestId: bigint;
  trackNamespace: TrackNamespace;
  trackName: Uint8Array;
  trackAlias: bigint | null;
  state: "active" | "closed";
  isEstablished: boolean;
  forwardState: boolean;
}

// ─── Fetch 状態管理 ─────────────────────────────────────
// draft-ietf-moq-transport-17 Section 5.2, 9.14, 9.15

/**
 * Fetch の種別
 * draft-ietf-moq-transport-17 Section 9.14 (FETCH)
 */
export type FetchKind = "standalone" | "relativeJoining" | "absoluteJoining";

/**
 * Fetch の状態機械
 * draft-ietf-moq-transport-17 Section 5.2 (Fetches)
 *
 * - pending:     FETCH 送受信直後、FETCH_OK / REQUEST_ERROR 未処理
 * - established: FETCH_OK 送信または受信済み
 * - terminated:  REQUEST_ERROR / STOP_SENDING / FIN / RESET_STREAM で終了
 */
export type FetchState = "pending" | "established" | "terminated";

/** Standalone Fetch の範囲情報 */
export interface StandaloneRange {
  start: Location;
  end: Location;
}

/** Joining Fetch の参照情報 */
export interface JoiningInfo {
  joiningRequestId: bigint;
  joiningStart: bigint;
}

/** Fetch 単位の状態エントリ */
export interface FetchEntry {
  requestId: bigint;
  kind: FetchKind;
  myRole: TrackRole;
  /** Standalone のみ */
  trackNamespace: TrackNamespace | null;
  /** Standalone のみ */
  trackName: Uint8Array | null;
  /** Standalone のみ */
  standaloneRange: StandaloneRange | null;
  /** Joining のみ */
  joining: JoiningInfo | null;
  state: FetchState;
  /** FETCH_OK で確定した End Location */
  endLocation: Location | null;
  /** FETCH_OK で確定した end_of_track */
  endOfTrack: boolean;
}

// ─── Namespace 系 / TRACK_STATUS 状態管理 ───────────────
// draft-ietf-moq-transport-17 Section 6, 9.16-9.21

/**
 * PUBLISH_NAMESPACE の状態
 * draft-ietf-moq-transport-17 Section 9.17 (PUBLISH_NAMESPACE)
 */
export type NamespacePublicationState = "pending" | "established" | "terminated";

export interface NamespacePublicationEntry {
  requestId: bigint;
  myRole: TrackRole;
  trackNamespace: TrackNamespace;
  state: NamespacePublicationState;
}

/**
 * SUBSCRIBE_NAMESPACE の状態
 * draft-ietf-moq-transport-17 Section 9.20 (SUBSCRIBE_NAMESPACE)
 */
export type NamespaceSubscriptionState = "pending" | "established" | "terminated";

/**
 * SUBSCRIBE_NAMESPACE の Subscribe Options
 * draft-ietf-moq-transport-17 Section 9.20 (SUBSCRIBE_NAMESPACE)
 *
 * - publishOnly:   0x00 PUBLISH のみ
 * - namespaceOnly: 0x01 NAMESPACE のみ
 * - both:          0x02 両方
 */
export type NamespaceSubscribeOptions = "publishOnly" | "namespaceOnly" | "both";

export interface NamespaceSubscriptionEntry {
  requestId: bigint;
  myRole: TrackRole;
  prefix: TrackNamespace;
  options: NamespaceSubscribeOptions;
  state: NamespaceSubscriptionState;
}

/**
 * TRACK_STATUS の状態
 * draft-ietf-moq-transport-17 Section 9.16 (TRACK_STATUS)
 */
export type TrackStatusState = "pending" | "completed" | "failed";

export interface TrackStatusEntry {
  requestId: bigint;
  myRole: TrackRole;
  trackNamespace: TrackNamespace;
  trackName: Uint8Array;
  state: TrackStatusState;
}

// ─── GOAWAY / Migration ─────────────────────────────────
// draft-ietf-moq-transport-17 Section 3.5, 3.6, 9.5

/**
 * New Session URI の最大長
 * draft-ietf-moq-transport-17 Section 9.5 (GOAWAY)
 */
export const MAX_NEW_SESSION_URI_LENGTH = 8192;

/** peer から受信した GOAWAY の情報 */
export interface PeerGoawayInfo {
  /** New Session URI (Server 送信のみ non-empty、最大 8192 バイト) */
  newSessionUri: Uint8Array;
  /** 待ち時間 (ミリ秒) */
  timeout: bigint;
}

// ─── セッションイベント ────────────────────────────────

/**
 * セッション層が生成するイベント
 *
 * I/O 層は `nextEvent()` で取り出し、以下のルールで I/O 実行に翻訳する。
 *
 * - sendControl: 制御ストリーム (SETUP / GOAWAY) に書く
 * - sendRequest: 新規 bidi request stream を開き、requestId と紐付けて書く
 * - sendOnStream: 既存 bidi request stream に書く (requestId で引く)
 * - established: セッション確立 (両側 SETUP 完了)
 * - closeSession: I/O 層は transport を close する
 * - *Received: 受信イベント (SessionImpl がコールバックに変換)
 */
export type SessionEvent =
  | { type: "sendControl"; message: ControlMessage }
  | { type: "sendRequest"; requestId: bigint; message: ControlMessage }
  | { type: "sendOnStream"; requestId: bigint; message: ControlMessage }
  | { type: "established" }
  | { type: "closeSession"; error: SessionError }
  | {
      type: "requestUpdateReceived";
      requestId: bigint;
      parameters: Parameter[];
    }
  | {
      type: "publishDoneReceived";
      requestId: bigint;
      statusCode: bigint;
      streamCount: bigint;
      reasonPhrase: string;
    }
  | {
      type: "namespaceReceived";
      requestId: bigint;
      suffix: TrackNamespace;
    }
  | {
      type: "namespaceDoneReceived";
      requestId: bigint;
      suffix: TrackNamespace;
    }
  | {
      type: "publishBlockedReceived";
      requestId: bigint;
      suffix: TrackNamespace;
      trackName: Uint8Array;
    }
  | {
      type: "goawayReceived";
      newSessionUri: Uint8Array;
      timeout: bigint;
    }
  | {
      type: "peerSubscribeReceived";
      requestId: bigint;
      message: Subscribe;
    }
  | {
      type: "peerPublishReceived";
      requestId: bigint;
      message: Publish;
    }
  | {
      type: "peerFetchReceived";
      requestId: bigint;
      message: Fetch;
    }
  | {
      type: "peerTrackStatusReceived";
      requestId: bigint;
      message: TrackStatus;
    }
  | {
      type: "peerSubscribeNamespaceReceived";
      requestId: bigint;
      message: SubscribeNamespace;
    }
  | {
      type: "peerPublishNamespaceReceived";
      requestId: bigint;
      message: PublishNamespace;
    };
