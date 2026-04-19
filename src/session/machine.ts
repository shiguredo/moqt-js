/**
 * MOQT Session プロトコル状態機械 (sans-I/O)
 * draft-ietf-moq-transport-17 Section 3 (Sessions)
 *
 * I/O を持たない純粋な状態機械。
 *
 * - 入力: handleControl / handleRequest / handleStreamMessage / tick / close
 * - 出力: nextEvent で SessionEvent を取り出す
 * - I/O 層は sendControl / sendRequest / sendOnStream イベントを
 *   WebTransport への書き込みに翻訳する
 *
 * 現在 Phase 2 時点では SETUP ハンドシェイクのみを実装する。
 * 他のメッセージは後続 Phase で段階的に追加する。
 */

import { SessionError, SessionErrorCode } from "../error";
import {
  type Fetch,
  type FetchOk,
  getParameterVarintValue,
  type Goaway,
  MessageParameterType,
  MessageType,
  type Namespace,
  type NamespaceDone,
  type Parameter,
  type Publish,
  type PublishBlocked,
  type PublishDone,
  type PublishNamespace,
  type PublishOk,
  type RequestError,
  type RequestOk,
  type RequestUpdate,
  type Setup,
  SetupOptionType,
  type Subscribe,
  type SubscribeNamespace,
  type SubscribeOk,
  type TrackStatus,
} from "../message";
import { type AuthToken, decodeAuthToken } from "../message/authToken";
import type { ControlMessage } from "../message/control";
import type { Property } from "../properties";
import { RequestIdGenerator, RequestIdTracker } from "./requestId";
import { AuthTokenCache } from "./authTokenCache";
import { createFetchEntry } from "./fetch";
import {
  createNamespacePublicationEntry,
  createNamespaceSubscriptionEntry,
  createTrackStatusEntry,
  namespaceSubscribeOptionsFromMode,
} from "./namespace";
import { createSubscriptionEntry, extractForwardState, subscriptionKey } from "./subscription";
import {
  MAX_NEW_SESSION_URI_LENGTH,
  type FetchEntry,
  type NamespacePublicationEntry,
  type NamespaceSubscriptionEntry,
  type PeerGoawayInfo,
  type Role,
  type SessionEvent,
  type SessionState,
  type SubscriptionEntry,
  type Transport,
  type TrackStatusEntry,
} from "./types";

/**
 * MOQT Session プロトコル状態機械
 */
export class SessionMachine {
  private readonly _role: Role;
  private readonly _transport: Transport;
  private _state: SessionState;
  private readonly _localSetup: Setup;
  private _peerSetup: Setup | null;
  private readonly _events: SessionEvent[];
  private readonly _requestIdGen: RequestIdGenerator;
  private readonly _peerRequestIds: RequestIdTracker;
  private readonly _subscriptions: Map<bigint, SubscriptionEntry> = new Map();
  private readonly _subscriptionsByTrack: Map<string, bigint> = new Map();
  private readonly _myPublisherAliases: Map<bigint, bigint> = new Map();
  private readonly _peerPublisherAliases: Map<bigint, bigint> = new Map();
  private readonly _fetches: Map<bigint, FetchEntry> = new Map();
  private readonly _namespacePublications: Map<bigint, NamespacePublicationEntry> = new Map();
  private readonly _namespaceSubscriptions: Map<bigint, NamespaceSubscriptionEntry> = new Map();
  private readonly _trackStatusRequests: Map<bigint, TrackStatusEntry> = new Map();
  private _localAuthTokenCache: AuthTokenCache;
  private _peerAuthTokenCache: AuthTokenCache = new AuthTokenCache(0n);
  private _localGoawaySent = false;
  private _peerGoaway: PeerGoawayInfo | null = null;
  private _lastTickMs: number | null = null;
  private _localGoawayDeadlineMs: number | null = null;
  private _localGoawayPendingTimeoutMs: number | null = null;

  private constructor(role: Role, transport: Transport, setup: Setup) {
    this._role = role;
    this._transport = transport;
    this._state = "setup";
    this._localSetup = setup;
    this._peerSetup = null;
    this._events = [{ type: "sendControl", message: setup }];
    this._requestIdGen = new RequestIdGenerator(role);
    this._peerRequestIds = new RequestIdTracker(role === "client" ? "server" : "client");
    this._localAuthTokenCache = new AuthTokenCache(readMaxAuthTokenCacheSize(setup));
  }

  /**
   * Client セッションを作成する
   * draft-ietf-moq-transport-17 Section 9.4 (SETUP)
   *
   * 作成時点で自側 SETUP の sendControl イベントを積み、"setup" 状態にする。
   */
  static createClient(transport: Transport, setup: Setup): SessionMachine {
    return new SessionMachine("client", transport, setup);
  }

  /** 現在のセッション状態 */
  get state(): SessionState {
    return this._state;
  }

  /** エンドポイントの役割 */
  get role(): Role {
    return this._role;
  }

  /** 下位トランスポート種別 */
  get transport(): Transport {
    return this._transport;
  }

  /** 自側 SETUP (診断用、改変禁止) */
  get localSetup(): Setup {
    return this._localSetup;
  }

  /** 相手側 SETUP (受信済みの場合) */
  get peerSetup(): Setup | null {
    return this._peerSetup;
  }

  /**
   * 次の SessionEvent を取り出す
   *
   * 呼び出し側は undefined が返るまで繰り返し呼び出して I/O 層と同期する。
   * closeSession を取り出したタイミングで "closing" → "closed" に遷移する。
   */
  nextEvent(): SessionEvent | undefined {
    const event = this._events.shift();
    if (event !== undefined && event.type === "closeSession" && this._state === "closing") {
      this._state = "closed";
    }
    return event;
  }

  /**
   * 制御ストリーム (SETUP / GOAWAY) 上のメッセージを受信する
   * draft-ietf-moq-transport-17 Section 9.4, 9.5
   *
   * SETUP / GOAWAY 以外は PROTOCOL_VIOLATION でクローズする。
   * クローズ処理中 / クローズ済みでは何もしない (no-op)。
   * GOAWAY の処理は Phase 8 で実装する。
   */
  handleControl(msg: ControlMessage): void {
    if (this._state === "closing" || this._state === "closed") {
      return;
    }
    if (msg.type === MessageType.SETUP) {
      this.handlePeerSetup(msg);
      return;
    }
    if (msg.type === MessageType.GOAWAY) {
      this.handlePeerGoaway(msg);
      return;
    }
    this.fail(
      new SessionError("unsupported control stream message", SessionErrorCode.PROTOCOL_VIOLATION),
    );
  }

  /**
   * 外部時計からの時刻更新を受け取る (sans-I/O)
   * draft-ietf-moq-transport-17 Section 9.5 (GOAWAY)
   *
   * sans-I/O 制約のため session はタイマーを持たず、外部時計だけが時刻源となる。
   * 呼び出し側は単調増加ミリ秒時刻を渡し、GOAWAY deadline 超過時に
   * SESSION_GOAWAY_TIMEOUT の closeSession イベントを積む。
   */
  tick(nowMs: number): void {
    this._lastTickMs = nowMs;
    if (this._localGoawayDeadlineMs === null && this._localGoawayPendingTimeoutMs !== null) {
      this._localGoawayDeadlineMs = nowMs + this._localGoawayPendingTimeoutMs;
      this._localGoawayPendingTimeoutMs = null;
    }
    if (this._state === "closing" || this._state === "closed") {
      return;
    }
    if (this._localGoawayDeadlineMs !== null && nowMs >= this._localGoawayDeadlineMs) {
      this.fail(new SessionError("goaway timeout expired", SessionErrorCode.GOAWAY_TIMEOUT));
    }
  }

  /**
   * GOAWAY を送信する
   * draft-ietf-moq-transport-17 Section 9.5 (GOAWAY)
   *
   * - `Role::Client` は `new_session_uri` を空にする必要がある
   * - `new_session_uri` は UTF-8 換算で 8192 バイト以下
   * - 各エンドポイントから 1 回のみ
   */
  sendGoaway(goaway: Goaway): void {
    this.requireEstablished();
    if (this._localGoawaySent) {
      throw new SessionError("GOAWAY already sent", SessionErrorCode.PROTOCOL_VIOLATION);
    }
    const uriBytes = new TextEncoder().encode(goaway.newSessionUri);
    if (uriBytes.byteLength > MAX_NEW_SESSION_URI_LENGTH) {
      throw new SessionError(
        "new_session_uri exceeds 8192 bytes",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    if (this._role === "client" && uriBytes.byteLength > 0) {
      throw new SessionError(
        "client MUST send zero-length new_session_uri",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    this._events.push({ type: "sendControl", message: goaway });
    this._localGoawaySent = true;
    // draft §9.5 L3321-3326: timeout==0 は specific timeout なし
    if (goaway.timeout > 0n) {
      const timeoutMs = Number(goaway.timeout);
      if (this._lastTickMs !== null) {
        this._localGoawayDeadlineMs = this._lastTickMs + timeoutMs;
      } else {
        // tick 未経験。最初の tick で deadline を確定する
        this._localGoawayPendingTimeoutMs = timeoutMs;
      }
    }
  }

  /** 自側 GOAWAY 送信済みか */
  get localGoawaySent(): boolean {
    return this._localGoawaySent;
  }

  /** peer から受信した GOAWAY 情報 */
  get peerGoaway(): PeerGoawayInfo | null {
    return this._peerGoaway;
  }

  /** 最後に tick で受け取った時刻 (ms、診断用) */
  get lastTickMs(): number | null {
    return this._lastTickMs;
  }

  /** 自側 GOAWAY の絶対 deadline (ms、未送信 / timeout=0 / tick 未実施では null) */
  get localGoawayDeadlineMs(): number | null {
    return this._localGoawayDeadlineMs;
  }

  private handlePeerGoaway(goaway: Goaway): void {
    if (this._peerGoaway !== null) {
      this.fail(new SessionError("duplicate GOAWAY received", SessionErrorCode.PROTOCOL_VIOLATION));
      return;
    }
    const uriBytes = new TextEncoder().encode(goaway.newSessionUri);
    if (uriBytes.byteLength > MAX_NEW_SESSION_URI_LENGTH) {
      this.fail(
        new SessionError(
          "received GOAWAY new_session_uri exceeds 8192 bytes",
          SessionErrorCode.PROTOCOL_VIOLATION,
        ),
      );
      return;
    }
    // draft §9.5: server (自側) は client (peer) からの non-zero URI を拒否
    if (this._role === "server" && uriBytes.byteLength > 0) {
      this.fail(
        new SessionError(
          "client sent non-zero new_session_uri",
          SessionErrorCode.PROTOCOL_VIOLATION,
        ),
      );
      return;
    }
    this._peerGoaway = {
      newSessionUri: uriBytes,
      timeout: goaway.timeout,
    };
    this._events.push({
      type: "goawayReceived",
      newSessionUri: uriBytes,
      timeout: goaway.timeout,
    });
  }

  /**
   * セッションを明示的にクローズする
   * draft-ietf-moq-transport-17 Section 14.5.1 (Session Termination Error Codes)
   *
   * 既に "closing" / "closed" の場合は何もしない。
   */
  close(code: SessionErrorCode, reason: string): void {
    this.fail(new SessionError(reason, code));
  }

  private handlePeerSetup(setup: Setup): void {
    // draft §9.4: SETUP は各エンドポイントから 1 回のみ
    if (this._peerSetup !== null) {
      this.fail(new SessionError("duplicate SETUP received", SessionErrorCode.PROTOCOL_VIOLATION));
      return;
    }
    this._peerSetup = setup;
    this._peerAuthTokenCache = new AuthTokenCache(readMaxAuthTokenCacheSize(setup));
    this._state = "established";
    this._events.push({ type: "established" });
  }

  /** 自側 AuthTokenCache (相手がトラッキングすべきエントリ) */
  get localAuthTokenCache(): AuthTokenCache {
    return this._localAuthTokenCache;
  }

  /** 相手側 AuthTokenCache (自側がトラッキングすべきエントリ) */
  get peerAuthTokenCache(): AuthTokenCache {
    return this._peerAuthTokenCache;
  }

  /**
   * 自側の次の Request ID を発行する
   * draft-ietf-moq-transport-17 Section 9.1 (Request ID)
   *
   * "established" 状態でのみ呼び出し可能。それ以外で呼ぶと SessionError を throw する。
   */
  nextLocalRequestId(): bigint {
    if (this._state !== "established") {
      throw new SessionError(
        "nextLocalRequestId called before session established",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    return this._requestIdGen.nextId();
  }

  /**
   * 受信した Request ID と Required Request ID Delta を検証する
   * draft-ietf-moq-transport-17 Section 9.1, 9.2
   *
   * 検証失敗時は closeSession イベントを積み、false を返す。
   * 成功時は内部テーブルに記録し、true を返す。
   */
  validatePeerRequest(requestId: bigint, requiredDelta: bigint): boolean {
    if (this._state !== "established") {
      this.fail(
        new SessionError(
          "peer request received before session established",
          SessionErrorCode.PROTOCOL_VIOLATION,
        ),
      );
      return false;
    }
    const parityErr = this._peerRequestIds.accept(requestId);
    if (parityErr !== null) {
      this.fail(parityErr);
      return false;
    }
    const deltaErr = RequestIdTracker.validateRequiredDelta(requestId, requiredDelta);
    if (deltaErr !== null) {
      this.fail(deltaErr);
      return false;
    }
    return true;
  }

  /**
   * SUBSCRIBE を送信する (自側が subscriber)
   * draft-ietf-moq-transport-17 Section 5.1, 9.8 (SUBSCRIBE)
   *
   * - pendingSubscriber 状態の SubscriptionEntry を登録する
   * - sendRequest イベントを積む
   * - 同じ track namespace / name / role の重複は PROTOCOL_VIOLATION で throw する
   */
  sendSubscribe(subscribe: Subscribe): void {
    this.requireEstablished();
    this.processOutgoingAuthTokens(subscribe.parameters);
    const key = subscriptionKey(subscribe.trackNamespace, subscribe.trackName, "subscriber");
    if (this._subscriptionsByTrack.has(key)) {
      throw new SessionError(
        "duplicate local subscription in subscriber role",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    const entry = createSubscriptionEntry({
      requestId: subscribe.requestId,
      initiator: "subscriber",
      myRole: "subscriber",
      trackNamespace: subscribe.trackNamespace,
      trackName: subscribe.trackName,
      trackAlias: null,
      forwardState: extractForwardState(subscribe.parameters),
    });
    this._subscriptions.set(subscribe.requestId, entry);
    this._subscriptionsByTrack.set(key, subscribe.requestId);
    this._events.push({
      type: "sendRequest",
      requestId: subscribe.requestId,
      message: subscribe,
    });
  }

  /**
   * PUBLISH を送信する (自側が publisher)
   * draft-ietf-moq-transport-17 Section 5.1, 9.11 (PUBLISH)
   *
   * - pendingPublisher 状態の SubscriptionEntry を登録する
   * - sendRequest イベントを積む
   * - 同じ Track Alias の二重採番は DUPLICATE_TRACK_ALIAS で throw する
   * - 同じ track の重複は PROTOCOL_VIOLATION で throw する
   */
  sendPublish(publish: Publish): void {
    this.requireEstablished();
    this.processOutgoingAuthTokens(publish.parameters);
    if (this._myPublisherAliases.has(publish.trackAlias)) {
      throw new SessionError(
        "local publisher reused track alias",
        SessionErrorCode.DUPLICATE_TRACK_ALIAS,
      );
    }
    const key = subscriptionKey(publish.trackNamespace, publish.trackName, "publisher");
    if (this._subscriptionsByTrack.has(key)) {
      throw new SessionError(
        "duplicate local subscription in publisher role",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    const entry = createSubscriptionEntry({
      requestId: publish.requestId,
      initiator: "publisher",
      myRole: "publisher",
      trackNamespace: publish.trackNamespace,
      trackName: publish.trackName,
      trackAlias: publish.trackAlias,
      forwardState: extractForwardState(publish.parameters),
    });
    this._subscriptions.set(publish.requestId, entry);
    this._subscriptionsByTrack.set(key, publish.requestId);
    this._myPublisherAliases.set(publish.trackAlias, publish.requestId);
    this._events.push({
      type: "sendRequest",
      requestId: publish.requestId,
      message: publish,
    });
  }

  /**
   * peer が新規 bidi stream で送信してきた SUBSCRIBE を受信する
   * draft-ietf-moq-transport-17 Section 9.8 (SUBSCRIBE)
   *
   * - peer は subscriber、自側は publisher として登録する
   * - Request ID の parity と Required Delta を検証する
   * - AUTHORIZATION_TOKEN パラメータをキャッシュに反映する
   * - 同一 track を publisher role で二重受理した場合は PROTOCOL_VIOLATION でクローズ
   * - 成功時は peerSubscribeReceived イベントを積む
   *
   * 検証で失敗した場合は closeSession イベントを積み、false を返す。
   */
  handlePeerSubscribe(subscribe: Subscribe): boolean {
    if (!this.validatePeerRequest(subscribe.requestId, subscribe.requiredRequestIdDelta)) {
      return false;
    }
    const key = subscriptionKey(subscribe.trackNamespace, subscribe.trackName, "publisher");
    if (this._subscriptionsByTrack.has(key)) {
      this.fail(
        new SessionError(
          "duplicate peer subscription in publisher role",
          SessionErrorCode.PROTOCOL_VIOLATION,
        ),
      );
      return false;
    }
    this.processIncomingAuthTokens(subscribe.parameters);
    if (this._state !== "established") {
      return false;
    }
    const entry = createSubscriptionEntry({
      requestId: subscribe.requestId,
      initiator: "subscriber",
      myRole: "publisher",
      trackNamespace: subscribe.trackNamespace,
      trackName: subscribe.trackName,
      trackAlias: null,
      forwardState: extractForwardState(subscribe.parameters),
    });
    this._subscriptions.set(subscribe.requestId, entry);
    this._subscriptionsByTrack.set(key, subscribe.requestId);
    this._events.push({
      type: "peerSubscribeReceived",
      requestId: subscribe.requestId,
      message: subscribe,
    });
    return true;
  }

  /**
   * peer が新規 bidi stream で送信してきた PUBLISH を受信する
   * draft-ietf-moq-transport-17 Section 9.11 (PUBLISH)
   *
   * - peer は publisher、自側は subscriber として登録する
   * - Request ID の parity と Required Delta を検証する
   * - AUTHORIZATION_TOKEN パラメータをキャッシュに反映する
   * - 同一 track を subscriber role で二重受理した場合は PROTOCOL_VIOLATION でクローズ
   * - Track Alias が peer publisher 空間で重複していたら DUPLICATE_TRACK_ALIAS でクローズ
   *   (SUBSCRIBE_OK 経由で確定した peer publisher の Track Alias と同じ空間を共有する)
   * - 成功時は peerPublishReceived イベントを積む
   *
   * 検証で失敗した場合は closeSession イベントを積み、false を返す。
   */
  handlePeerPublish(publish: Publish): boolean {
    if (!this.validatePeerRequest(publish.requestId, publish.requiredRequestIdDelta)) {
      return false;
    }
    if (this._peerPublisherAliases.has(publish.trackAlias)) {
      this.fail(
        new SessionError(
          "peer publisher reused track alias",
          SessionErrorCode.DUPLICATE_TRACK_ALIAS,
        ),
      );
      return false;
    }
    const key = subscriptionKey(publish.trackNamespace, publish.trackName, "subscriber");
    if (this._subscriptionsByTrack.has(key)) {
      this.fail(
        new SessionError(
          "duplicate peer subscription in subscriber role",
          SessionErrorCode.PROTOCOL_VIOLATION,
        ),
      );
      return false;
    }
    this.processIncomingAuthTokens(publish.parameters);
    if (this._state !== "established") {
      return false;
    }
    const entry = createSubscriptionEntry({
      requestId: publish.requestId,
      initiator: "publisher",
      myRole: "subscriber",
      trackNamespace: publish.trackNamespace,
      trackName: publish.trackName,
      trackAlias: publish.trackAlias,
      forwardState: extractForwardState(publish.parameters),
    });
    this._subscriptions.set(publish.requestId, entry);
    this._subscriptionsByTrack.set(key, publish.requestId);
    this._peerPublisherAliases.set(publish.trackAlias, publish.requestId);
    this._events.push({
      type: "peerPublishReceived",
      requestId: publish.requestId,
      message: publish,
    });
    return true;
  }

  /**
   * peer が新規 bidi stream で送信してきた FETCH を受信する
   * draft-ietf-moq-transport-17 Section 9.14 (FETCH)
   *
   * - peer は subscriber、自側は publisher として登録する
   * - Request ID の parity と Required Delta を検証する
   * - AUTHORIZATION_TOKEN パラメータをキャッシュに反映する
   * - 成功時は peerFetchReceived イベントを積む
   *
   * 検証で失敗した場合は closeSession イベントを積み、false を返す。
   *
   * 注意: Joining FETCH の joiningRequestId 先 subscription の存在検証は
   * respond API (Phase 5) で行う。ここでは FetchEntry の登録までにとどめる。
   */
  handlePeerFetch(fetch: Fetch): boolean {
    if (!this.validatePeerRequest(fetch.requestId, fetch.requiredRequestIdDelta)) {
      return false;
    }
    this.processIncomingAuthTokens(fetch.parameters);
    if (this._state !== "established") {
      return false;
    }
    const entry = createFetchEntry(fetch, "publisher");
    this._fetches.set(fetch.requestId, entry);
    this._events.push({
      type: "peerFetchReceived",
      requestId: fetch.requestId,
      message: fetch,
    });
    return true;
  }

  /**
   * peer が新規 bidi stream で送信してきた TRACK_STATUS を受信する
   * draft-ietf-moq-transport-17 Section 9.16 (TRACK_STATUS)
   *
   * - peer は subscriber、自側は publisher として登録する
   * - Request ID の parity と Required Delta を検証する
   * - AUTHORIZATION_TOKEN パラメータをキャッシュに反映する
   * - 成功時は peerTrackStatusReceived イベントを積む
   *
   * 検証で失敗した場合は closeSession イベントを積み、false を返す。
   */
  handlePeerTrackStatus(trackStatus: TrackStatus): boolean {
    if (!this.validatePeerRequest(trackStatus.requestId, trackStatus.requiredRequestIdDelta)) {
      return false;
    }
    this.processIncomingAuthTokens(trackStatus.parameters);
    if (this._state !== "established") {
      return false;
    }
    const entry = createTrackStatusEntry({
      requestId: trackStatus.requestId,
      myRole: "publisher",
      trackNamespace: trackStatus.trackNamespace,
      trackName: trackStatus.trackName,
    });
    this._trackStatusRequests.set(trackStatus.requestId, entry);
    this._events.push({
      type: "peerTrackStatusReceived",
      requestId: trackStatus.requestId,
      message: trackStatus,
    });
    return true;
  }

  /**
   * peer が新規 bidi stream で送信してきた SUBSCRIBE_NAMESPACE を受信する
   * draft-ietf-moq-transport-17 Section 9.20 (SUBSCRIBE_NAMESPACE)
   *
   * - peer は subscriber、自側は publisher として登録する
   * - Request ID の parity と Required Delta を検証する
   * - AUTHORIZATION_TOKEN パラメータをキャッシュに反映する
   * - 成功時は peerSubscribeNamespaceReceived イベントを積む
   *
   * 検証で失敗した場合は closeSession イベントを積み、false を返す。
   */
  handlePeerSubscribeNamespace(msg: SubscribeNamespace): boolean {
    if (!this.validatePeerRequest(msg.requestId, msg.requiredRequestIdDelta)) {
      return false;
    }
    this.processIncomingAuthTokens(msg.parameters);
    if (this._state !== "established") {
      return false;
    }
    const entry = createNamespaceSubscriptionEntry({
      requestId: msg.requestId,
      myRole: "publisher",
      prefix: msg.trackNamespacePrefix,
      options: namespaceSubscribeOptionsFromMode(msg.subscribeOptions),
    });
    this._namespaceSubscriptions.set(msg.requestId, entry);
    this._events.push({
      type: "peerSubscribeNamespaceReceived",
      requestId: msg.requestId,
      message: msg,
    });
    return true;
  }

  /**
   * peer が新規 bidi stream で送信してきた PUBLISH_NAMESPACE を受信する
   * draft-ietf-moq-transport-17 Section 9.17 (PUBLISH_NAMESPACE)
   *
   * - peer は publisher、自側は subscriber として登録する
   * - Request ID の parity と Required Delta を検証する
   * - AUTHORIZATION_TOKEN パラメータをキャッシュに反映する
   * - 成功時は peerPublishNamespaceReceived イベントを積む
   *
   * 検証で失敗した場合は closeSession イベントを積み、false を返す。
   */
  handlePeerPublishNamespace(msg: PublishNamespace): boolean {
    if (!this.validatePeerRequest(msg.requestId, msg.requiredRequestIdDelta)) {
      return false;
    }
    this.processIncomingAuthTokens(msg.parameters);
    if (this._state !== "established") {
      return false;
    }
    const entry = createNamespacePublicationEntry({
      requestId: msg.requestId,
      myRole: "subscriber",
      trackNamespace: msg.trackNamespace,
    });
    this._namespacePublications.set(msg.requestId, entry);
    this._events.push({
      type: "peerPublishNamespaceReceived",
      requestId: msg.requestId,
      message: msg,
    });
    return true;
  }

  /**
   * peer SUBSCRIBE を受理して SUBSCRIBE_OK を送信する
   * draft-ietf-moq-transport-17 Section 9.9 (SUBSCRIBE_OK)
   *
   * - SubscriptionEntry (peer-initiated, myRole="publisher") を established に遷移させる
   * - 自側 publisher 空間に trackAlias を登録する
   * - AUTHORIZATION_TOKEN を local キャッシュに反映する
   * - sendOnStream イベントに SUBSCRIBE_OK を積む
   *
   * 状態違反 / TrackAlias 重複 / session 非 established 時は SessionError を throw する。
   */
  acceptPeerSubscribe(
    requestId: bigint,
    trackAlias: bigint,
    parameters: Parameter[] = [],
    trackProperties: Property[] = [],
  ): void {
    this.requireEstablished();
    const entry = this._subscriptions.get(requestId);
    if (entry === undefined) {
      throw new SessionError(
        "no peer subscription for acceptPeerSubscribe",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    if (entry.initiator !== "subscriber" || entry.myRole !== "publisher") {
      throw new SessionError(
        "acceptPeerSubscribe called for non peer-initiated subscription",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    if (entry.state !== "pendingSubscriber") {
      throw new SessionError(
        "acceptPeerSubscribe called in invalid subscription state",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    if (this._myPublisherAliases.has(trackAlias)) {
      throw new SessionError(
        "local publisher reused track alias",
        SessionErrorCode.DUPLICATE_TRACK_ALIAS,
      );
    }
    this.processOutgoingAuthTokens(parameters);
    entry.trackAlias = trackAlias;
    entry.state = "established";
    this._myPublisherAliases.set(trackAlias, requestId);
    const ok: SubscribeOk = {
      type: MessageType.SUBSCRIBE_OK,
      trackAlias,
      parameters,
      trackProperties,
    };
    this._events.push({
      type: "sendOnStream",
      requestId,
      message: ok,
    });
  }

  /**
   * peer PUBLISH を受理して PUBLISH_OK を送信する
   * draft-ietf-moq-transport-17 Section 9.12 (PUBLISH_OK)
   */
  acceptPeerPublish(requestId: bigint, parameters: Parameter[] = []): void {
    this.requireEstablished();
    const entry = this._subscriptions.get(requestId);
    if (entry === undefined) {
      throw new SessionError(
        "no peer subscription for acceptPeerPublish",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    if (entry.initiator !== "publisher" || entry.myRole !== "subscriber") {
      throw new SessionError(
        "acceptPeerPublish called for non peer-initiated publication",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    if (entry.state !== "pendingPublisher") {
      throw new SessionError(
        "acceptPeerPublish called in invalid subscription state",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    this.processOutgoingAuthTokens(parameters);
    entry.state = "established";
    const ok: PublishOk = {
      type: MessageType.PUBLISH_OK,
      parameters,
    };
    this._events.push({
      type: "sendOnStream",
      requestId,
      message: ok,
    });
  }

  /**
   * peer FETCH を受理して FETCH_OK を送信する
   * draft-ietf-moq-transport-17 Section 9.15 (FETCH_OK)
   */
  acceptPeerFetch(
    requestId: bigint,
    endOfTrack: boolean,
    endLocation: import("../message").Location,
    parameters: Parameter[] = [],
    trackProperties: Property[] = [],
  ): void {
    this.requireEstablished();
    const entry = this._fetches.get(requestId);
    if (entry === undefined) {
      throw new SessionError(
        "no peer fetch for acceptPeerFetch",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    if (entry.myRole !== "publisher") {
      throw new SessionError(
        "acceptPeerFetch called for non peer-initiated fetch",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    if (entry.state !== "pending") {
      throw new SessionError(
        "acceptPeerFetch called in invalid fetch state",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    this.processOutgoingAuthTokens(parameters);
    entry.state = "established";
    entry.endLocation = endLocation;
    entry.endOfTrack = endOfTrack;
    const ok: FetchOk = {
      type: MessageType.FETCH_OK,
      endOfTrack,
      endLocation,
      parameters,
      trackProperties,
    };
    this._events.push({
      type: "sendOnStream",
      requestId,
      message: ok,
    });
  }

  /**
   * peer TRACK_STATUS に REQUEST_OK で応答する
   * draft-ietf-moq-transport-17 Section 9.16 (TRACK_STATUS), 9.6 (REQUEST_OK)
   */
  acceptPeerTrackStatus(requestId: bigint, parameters: Parameter[] = []): void {
    this.requireEstablished();
    const entry = this._trackStatusRequests.get(requestId);
    if (entry === undefined) {
      throw new SessionError(
        "no peer track status request for acceptPeerTrackStatus",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    if (entry.myRole !== "publisher") {
      throw new SessionError(
        "acceptPeerTrackStatus called for non peer-initiated track status",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    if (entry.state !== "pending") {
      throw new SessionError(
        "acceptPeerTrackStatus called in invalid track status state",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    this.processOutgoingAuthTokens(parameters);
    entry.state = "completed";
    const ok: RequestOk = {
      type: MessageType.REQUEST_OK,
      parameters,
    };
    this._events.push({
      type: "sendOnStream",
      requestId,
      message: ok,
    });
  }

  /**
   * peer SUBSCRIBE_NAMESPACE を受理して REQUEST_OK で応答する
   * draft-ietf-moq-transport-17 Section 9.20 (SUBSCRIBE_NAMESPACE), 9.6 (REQUEST_OK)
   */
  acceptPeerSubscribeNamespace(requestId: bigint, parameters: Parameter[] = []): void {
    this.requireEstablished();
    const entry = this._namespaceSubscriptions.get(requestId);
    if (entry === undefined) {
      throw new SessionError(
        "no peer namespace subscription for acceptPeerSubscribeNamespace",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    if (entry.myRole !== "publisher") {
      throw new SessionError(
        "acceptPeerSubscribeNamespace called for non peer-initiated namespace subscription",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    if (entry.state !== "pending") {
      throw new SessionError(
        "acceptPeerSubscribeNamespace called in invalid state",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    this.processOutgoingAuthTokens(parameters);
    entry.state = "established";
    const ok: RequestOk = {
      type: MessageType.REQUEST_OK,
      parameters,
    };
    this._events.push({
      type: "sendOnStream",
      requestId,
      message: ok,
    });
  }

  /**
   * peer PUBLISH_NAMESPACE を受理して REQUEST_OK で応答する
   * draft-ietf-moq-transport-17 Section 9.17 (PUBLISH_NAMESPACE), 9.6 (REQUEST_OK)
   */
  acceptPeerPublishNamespace(requestId: bigint, parameters: Parameter[] = []): void {
    this.requireEstablished();
    const entry = this._namespacePublications.get(requestId);
    if (entry === undefined) {
      throw new SessionError(
        "no peer namespace publication for acceptPeerPublishNamespace",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    if (entry.myRole !== "subscriber") {
      throw new SessionError(
        "acceptPeerPublishNamespace called for non peer-initiated namespace publication",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    if (entry.state !== "pending") {
      throw new SessionError(
        "acceptPeerPublishNamespace called in invalid state",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    this.processOutgoingAuthTokens(parameters);
    entry.state = "established";
    const ok: RequestOk = {
      type: MessageType.REQUEST_OK,
      parameters,
    };
    this._events.push({
      type: "sendOnStream",
      requestId,
      message: ok,
    });
  }

  /**
   * peer-initiated request を REQUEST_ERROR で拒否する
   * draft-ietf-moq-transport-17 Section 9.7 (REQUEST_ERROR)
   *
   * SUBSCRIBE / PUBLISH / FETCH / TRACK_STATUS / SUBSCRIBE_NAMESPACE /
   * PUBLISH_NAMESPACE のいずれでも利用できる。該当する peer-initiated エントリを
   * terminated (TrackStatus は failed) に遷移させ、sendOnStream に REQUEST_ERROR を積む。
   */
  rejectPeerRequest(
    requestId: bigint,
    errorCode: bigint,
    retryInterval: bigint,
    reasonPhrase: string,
  ): void {
    this.requireEstablished();
    const subscription = this._subscriptions.get(requestId);
    if (subscription !== undefined) {
      if (subscription.state !== "pendingSubscriber" && subscription.state !== "pendingPublisher") {
        throw new SessionError(
          "rejectPeerRequest called in invalid subscription state",
          SessionErrorCode.PROTOCOL_VIOLATION,
        );
      }
      subscription.state = "terminated";
    } else if (this._fetches.get(requestId) !== undefined) {
      const fetch = this._fetches.get(requestId);
      if (fetch && fetch.myRole !== "publisher") {
        throw new SessionError(
          "rejectPeerRequest called for non peer-initiated fetch",
          SessionErrorCode.PROTOCOL_VIOLATION,
        );
      }
      if (fetch) fetch.state = "terminated";
    } else if (this._trackStatusRequests.get(requestId) !== undefined) {
      const ts = this._trackStatusRequests.get(requestId);
      if (ts && ts.myRole !== "publisher") {
        throw new SessionError(
          "rejectPeerRequest called for non peer-initiated track status",
          SessionErrorCode.PROTOCOL_VIOLATION,
        );
      }
      if (ts) ts.state = "failed";
    } else if (this._namespaceSubscriptions.get(requestId) !== undefined) {
      const ns = this._namespaceSubscriptions.get(requestId);
      if (ns && ns.myRole !== "publisher") {
        throw new SessionError(
          "rejectPeerRequest called for non peer-initiated namespace subscription",
          SessionErrorCode.PROTOCOL_VIOLATION,
        );
      }
      if (ns) ns.state = "terminated";
    } else if (this._namespacePublications.get(requestId) !== undefined) {
      const np = this._namespacePublications.get(requestId);
      if (np && np.myRole !== "subscriber") {
        throw new SessionError(
          "rejectPeerRequest called for non peer-initiated namespace publication",
          SessionErrorCode.PROTOCOL_VIOLATION,
        );
      }
      if (np) np.state = "terminated";
    } else {
      throw new SessionError(
        "no peer-initiated request for rejectPeerRequest",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    const err: RequestError = {
      type: MessageType.REQUEST_ERROR,
      errorCode,
      retryInterval,
      reasonPhrase,
    };
    this._events.push({
      type: "sendOnStream",
      requestId,
      message: err,
    });
  }

  /**
   * 既存 bidi request stream 上の応答メッセージを処理する
   * draft-ietf-moq-transport-17 Section 9.7, 9.10, 9.12 ほか
   *
   * Phase 4a では SUBSCRIBE_OK / PUBLISH_OK / REQUEST_ERROR のみ対応する。
   * 他のメッセージ (FETCH_OK / REQUEST_OK / NAMESPACE 等) は後続 Phase で追加する。
   */
  handleStreamMessage(requestId: bigint, msg: ControlMessage): void {
    if (this._state !== "established") {
      this.fail(
        new SessionError(
          "response received before session established",
          SessionErrorCode.PROTOCOL_VIOLATION,
        ),
      );
      return;
    }
    switch (msg.type) {
      case MessageType.SUBSCRIBE_OK:
        this.handlePeerSubscribeOk(requestId, msg);
        return;
      case MessageType.PUBLISH_OK:
        this.handlePeerPublishOk(requestId, msg);
        return;
      case MessageType.REQUEST_ERROR:
        this.handlePeerRequestError(requestId, msg);
        return;
      case MessageType.REQUEST_UPDATE:
        this.handlePeerRequestUpdate(requestId, msg);
        return;
      case MessageType.PUBLISH_DONE:
        this.handlePeerPublishDone(requestId, msg);
        return;
      case MessageType.FETCH_OK:
        this.handlePeerFetchOk(requestId, msg);
        return;
      case MessageType.NAMESPACE:
        this.handlePeerNamespace(requestId, msg);
        return;
      case MessageType.NAMESPACE_DONE:
        this.handlePeerNamespaceDone(requestId, msg);
        return;
      case MessageType.PUBLISH_BLOCKED:
        this.handlePeerPublishBlocked(requestId, msg);
        return;
      case MessageType.REQUEST_OK:
        this.handlePeerRequestOk(requestId, msg);
        return;
      default:
        this.fail(
          new SessionError(
            "unsupported stream message in current phase",
            SessionErrorCode.PROTOCOL_VIOLATION,
          ),
        );
    }
  }

  /** 指定 Request ID の SubscriptionEntry を取得する */
  subscription(requestId: bigint): SubscriptionEntry | undefined {
    return this._subscriptions.get(requestId);
  }

  /** すべての SubscriptionEntry をイテレートする */
  subscriptions(): IterableIterator<SubscriptionEntry> {
    return this._subscriptions.values();
  }

  /**
   * Terminated 状態の subscription を忘れる
   * draft-ietf-moq-transport-17 Section 5.1.1
   *
   * Terminated 以外の状態では何もせず undefined を返す。
   */
  forgetSubscription(requestId: bigint): SubscriptionEntry | undefined {
    const entry = this._subscriptions.get(requestId);
    if (entry === undefined || entry.state !== "terminated") {
      return undefined;
    }
    this._subscriptions.delete(requestId);
    const key = subscriptionKey(entry.trackNamespace, entry.trackName, entry.myRole);
    this._subscriptionsByTrack.delete(key);
    if (entry.trackAlias !== null) {
      if (entry.myRole === "publisher") {
        this._myPublisherAliases.delete(entry.trackAlias);
      } else {
        this._peerPublisherAliases.delete(entry.trackAlias);
      }
    }
    return entry;
  }

  private requireEstablished(): void {
    if (this._state !== "established") {
      throw new SessionError(
        "operation requires session in established state",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
  }

  private handlePeerSubscribeOk(requestId: bigint, ok: SubscribeOk): void {
    const entry = this._subscriptions.get(requestId);
    if (entry === undefined) {
      this.fail(
        new SessionError(
          "SUBSCRIBE_OK received for unknown request id",
          SessionErrorCode.PROTOCOL_VIOLATION,
        ),
      );
      return;
    }
    if (entry.state !== "pendingSubscriber") {
      this.fail(
        new SessionError(
          "SUBSCRIBE_OK received in invalid subscription state",
          SessionErrorCode.PROTOCOL_VIOLATION,
        ),
      );
      return;
    }
    if (this._peerPublisherAliases.has(ok.trackAlias)) {
      this.fail(
        new SessionError(
          "peer publisher reused track alias",
          SessionErrorCode.DUPLICATE_TRACK_ALIAS,
        ),
      );
      return;
    }
    entry.trackAlias = ok.trackAlias;
    entry.state = "established";
    this._peerPublisherAliases.set(ok.trackAlias, requestId);
  }

  private handlePeerPublishOk(requestId: bigint, _ok: PublishOk): void {
    const entry = this._subscriptions.get(requestId);
    if (entry === undefined) {
      this.fail(
        new SessionError(
          "PUBLISH_OK received for unknown request id",
          SessionErrorCode.PROTOCOL_VIOLATION,
        ),
      );
      return;
    }
    if (entry.state !== "pendingPublisher") {
      this.fail(
        new SessionError(
          "PUBLISH_OK received in invalid subscription state",
          SessionErrorCode.PROTOCOL_VIOLATION,
        ),
      );
      return;
    }
    entry.state = "established";
  }

  /**
   * REQUEST_UPDATE を送信する
   * draft-ietf-moq-transport-17 Section 9.10 (REQUEST_UPDATE)
   *
   * 既存 bidi request stream (targetRequestId) 上に REQUEST_UPDATE を流す。
   * REQUEST_UPDATE 自体は独自の request_id を持ち、peer からの REQUEST_OK /
   * REQUEST_ERROR で応答される。
   */
  sendRequestUpdate(targetRequestId: bigint, update: RequestUpdate): void {
    this.requireEstablished();
    this.processOutgoingAuthTokens(update.parameters);
    if (!this._subscriptions.has(targetRequestId)) {
      throw new SessionError(
        "no subscription for REQUEST_UPDATE",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    this._events.push({
      type: "sendOnStream",
      requestId: targetRequestId,
      message: update,
    });
  }

  /**
   * PUBLISH_DONE を送信する (自側が publisher)
   * draft-ietf-moq-transport-17 Section 9.13 (PUBLISH_DONE)
   *
   * subscription を terminated に遷移させ、既存 bidi request stream (requestId) に
   * PUBLISH_DONE を流す。publisher 側以外から呼ぶと PROTOCOL_VIOLATION を throw する。
   */
  sendPublishDone(requestId: bigint, publishDone: PublishDone): void {
    this.requireEstablished();
    const entry = this._subscriptions.get(requestId);
    if (entry === undefined) {
      throw new SessionError(
        "no subscription for PUBLISH_DONE",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    if (entry.myRole !== "publisher") {
      throw new SessionError(
        "PUBLISH_DONE can be sent only by publisher side",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    entry.state = "terminated";
    this._events.push({
      type: "sendOnStream",
      requestId,
      message: publishDone,
    });
  }

  private handlePeerRequestUpdate(targetRequestId: bigint, update: RequestUpdate): void {
    if (!this._subscriptions.has(targetRequestId)) {
      this.fail(
        new SessionError(
          "REQUEST_UPDATE received for unknown subscription",
          SessionErrorCode.PROTOCOL_VIOLATION,
        ),
      );
      return;
    }
    this._events.push({
      type: "requestUpdateReceived",
      requestId: update.requestId,
      parameters: update.parameters,
    });
  }

  private handlePeerPublishDone(requestId: bigint, done: PublishDone): void {
    const entry = this._subscriptions.get(requestId);
    if (entry === undefined) {
      this.fail(
        new SessionError(
          "PUBLISH_DONE received for unknown request id",
          SessionErrorCode.PROTOCOL_VIOLATION,
        ),
      );
      return;
    }
    entry.state = "terminated";
    this._events.push({
      type: "publishDoneReceived",
      requestId,
      statusCode: done.statusCode,
      streamCount: done.streamCount,
      reasonPhrase: done.reasonPhrase,
    });
  }

  private handlePeerRequestError(requestId: bigint, _err: RequestError): void {
    const subscription = this._subscriptions.get(requestId);
    if (subscription !== undefined) {
      subscription.state = "terminated";
      return;
    }
    const fetch = this._fetches.get(requestId);
    if (fetch !== undefined) {
      fetch.state = "terminated";
      return;
    }
    const pub = this._namespacePublications.get(requestId);
    if (pub !== undefined) {
      pub.state = "terminated";
      return;
    }
    const sub = this._namespaceSubscriptions.get(requestId);
    if (sub !== undefined) {
      sub.state = "terminated";
      return;
    }
    const ts = this._trackStatusRequests.get(requestId);
    if (ts !== undefined) {
      ts.state = "failed";
      return;
    }
    this.fail(
      new SessionError(
        "REQUEST_ERROR received for unknown request id",
        SessionErrorCode.PROTOCOL_VIOLATION,
      ),
    );
  }

  /**
   * PUBLISH_NAMESPACE を送信する (自側が publisher)
   * draft-ietf-moq-transport-17 Section 9.17 (PUBLISH_NAMESPACE)
   *
   * pending 状態の NamespacePublicationEntry を登録し、sendRequest イベントを積む。
   */
  sendPublishNamespace(msg: PublishNamespace): void {
    this.requireEstablished();
    this.processOutgoingAuthTokens(msg.parameters);
    if (this._namespacePublications.has(msg.requestId)) {
      throw new SessionError(
        "duplicate request id for PUBLISH_NAMESPACE",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    const entry = createNamespacePublicationEntry({
      requestId: msg.requestId,
      myRole: "publisher",
      trackNamespace: msg.trackNamespace,
    });
    this._namespacePublications.set(msg.requestId, entry);
    this._events.push({
      type: "sendRequest",
      requestId: msg.requestId,
      message: msg,
    });
  }

  /**
   * SUBSCRIBE_NAMESPACE を送信する (自側が subscriber)
   * draft-ietf-moq-transport-17 Section 9.20 (SUBSCRIBE_NAMESPACE)
   *
   * pending 状態の NamespaceSubscriptionEntry を登録し、sendRequest イベントを積む。
   */
  sendSubscribeNamespace(msg: SubscribeNamespace): void {
    this.requireEstablished();
    this.processOutgoingAuthTokens(msg.parameters);
    if (this._namespaceSubscriptions.has(msg.requestId)) {
      throw new SessionError(
        "duplicate request id for SUBSCRIBE_NAMESPACE",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    const entry = createNamespaceSubscriptionEntry({
      requestId: msg.requestId,
      myRole: "subscriber",
      prefix: msg.trackNamespacePrefix,
      options: namespaceSubscribeOptionsFromMode(msg.subscribeOptions),
    });
    this._namespaceSubscriptions.set(msg.requestId, entry);
    this._events.push({
      type: "sendRequest",
      requestId: msg.requestId,
      message: msg,
    });
  }

  /**
   * TRACK_STATUS を送信する (自側が subscriber)
   * draft-ietf-moq-transport-17 Section 9.16 (TRACK_STATUS)
   *
   * pending 状態の TrackStatusEntry を登録し、sendRequest イベントを積む。
   */
  sendTrackStatus(msg: TrackStatus): void {
    this.requireEstablished();
    this.processOutgoingAuthTokens(msg.parameters);
    if (this._trackStatusRequests.has(msg.requestId)) {
      throw new SessionError(
        "duplicate request id for TRACK_STATUS",
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }
    const entry = createTrackStatusEntry({
      requestId: msg.requestId,
      myRole: "subscriber",
      trackNamespace: msg.trackNamespace,
      trackName: msg.trackName,
    });
    this._trackStatusRequests.set(msg.requestId, entry);
    this._events.push({
      type: "sendRequest",
      requestId: msg.requestId,
      message: msg,
    });
  }

  /** 指定 Request ID の NamespacePublicationEntry を取得する */
  namespacePublication(requestId: bigint): NamespacePublicationEntry | undefined {
    return this._namespacePublications.get(requestId);
  }

  /** 指定 Request ID の NamespaceSubscriptionEntry を取得する */
  namespaceSubscription(requestId: bigint): NamespaceSubscriptionEntry | undefined {
    return this._namespaceSubscriptions.get(requestId);
  }

  /** 指定 Request ID の TrackStatusEntry を取得する */
  trackStatusRequest(requestId: bigint): TrackStatusEntry | undefined {
    return this._trackStatusRequests.get(requestId);
  }

  private handlePeerNamespace(requestId: bigint, msg: Namespace): void {
    if (!this._namespaceSubscriptions.has(requestId)) {
      this.fail(
        new SessionError(
          "NAMESPACE received for unknown namespace subscription",
          SessionErrorCode.PROTOCOL_VIOLATION,
        ),
      );
      return;
    }
    this._events.push({
      type: "namespaceReceived",
      requestId,
      suffix: msg.trackNamespaceSuffix,
    });
  }

  private handlePeerNamespaceDone(requestId: bigint, msg: NamespaceDone): void {
    if (!this._namespaceSubscriptions.has(requestId)) {
      this.fail(
        new SessionError(
          "NAMESPACE_DONE received for unknown namespace subscription",
          SessionErrorCode.PROTOCOL_VIOLATION,
        ),
      );
      return;
    }
    this._events.push({
      type: "namespaceDoneReceived",
      requestId,
      suffix: msg.trackNamespaceSuffix,
    });
  }

  private handlePeerPublishBlocked(requestId: bigint, msg: PublishBlocked): void {
    if (!this._namespaceSubscriptions.has(requestId)) {
      this.fail(
        new SessionError(
          "PUBLISH_BLOCKED received for unknown namespace subscription",
          SessionErrorCode.PROTOCOL_VIOLATION,
        ),
      );
      return;
    }
    this._events.push({
      type: "publishBlockedReceived",
      requestId,
      suffix: msg.trackNamespaceSuffix,
      trackName: msg.trackName,
    });
  }

  private handlePeerRequestOk(requestId: bigint, _ok: RequestOk): void {
    const pub = this._namespacePublications.get(requestId);
    if (pub !== undefined) {
      if (pub.state === "pending") {
        pub.state = "established";
      }
      return;
    }
    const sub = this._namespaceSubscriptions.get(requestId);
    if (sub !== undefined) {
      if (sub.state === "pending") {
        sub.state = "established";
      }
      return;
    }
    const ts = this._trackStatusRequests.get(requestId);
    if (ts !== undefined) {
      if (ts.state === "pending") {
        ts.state = "completed";
      }
      return;
    }
    // REQUEST_UPDATE の応答に対しても REQUEST_OK が来るが、subscription 種別は
    // REQUEST_OK を受け取らない (SUBSCRIBE_OK / PUBLISH_OK がある)。REQUEST_UPDATE は
    // 別の request_id を持つので subscription Map には無い。Phase 4b では管理していない
    // ため、ここでは no-op として扱う (仕様違反ではない)。
  }

  /**
   * FETCH を送信する (自側が subscriber)
   * draft-ietf-moq-transport-17 Section 9.14 (FETCH)
   *
   * pending 状態の FetchEntry を登録し、sendRequest イベントを積む。
   */
  sendFetch(fetch: Fetch): void {
    this.requireEstablished();
    this.processOutgoingAuthTokens(fetch.parameters);
    if (this._fetches.has(fetch.requestId)) {
      throw new SessionError("duplicate request id for FETCH", SessionErrorCode.PROTOCOL_VIOLATION);
    }
    const entry = createFetchEntry(fetch, "subscriber");
    this._fetches.set(fetch.requestId, entry);
    this._events.push({
      type: "sendRequest",
      requestId: fetch.requestId,
      message: fetch,
    });
  }

  /** 指定 Request ID の FetchEntry を取得する */
  fetch(requestId: bigint): FetchEntry | undefined {
    return this._fetches.get(requestId);
  }

  /** すべての FetchEntry をイテレートする */
  fetches(): IterableIterator<FetchEntry> {
    return this._fetches.values();
  }

  /**
   * Terminated 状態の fetch を忘れる
   * Terminated 以外の状態では何もせず undefined を返す。
   */
  forgetFetch(requestId: bigint): FetchEntry | undefined {
    const entry = this._fetches.get(requestId);
    if (entry === undefined || entry.state !== "terminated") {
      return undefined;
    }
    this._fetches.delete(requestId);
    return entry;
  }

  private handlePeerFetchOk(requestId: bigint, ok: FetchOk): void {
    const entry = this._fetches.get(requestId);
    if (entry === undefined) {
      this.fail(
        new SessionError(
          "FETCH_OK received for unknown request id",
          SessionErrorCode.PROTOCOL_VIOLATION,
        ),
      );
      return;
    }
    if (entry.state !== "pending") {
      this.fail(
        new SessionError(
          "FETCH_OK received in invalid fetch state",
          SessionErrorCode.PROTOCOL_VIOLATION,
        ),
      );
      return;
    }
    entry.state = "established";
    entry.endLocation = ok.endLocation;
    entry.endOfTrack = ok.endOfTrack;
  }

  /**
   * 自側が送信するメッセージに含まれる AUTHORIZATION_TOKEN を処理する
   * draft-ietf-moq-transport-17 Section 9.3.2
   *
   * REGISTER は `_localAuthTokenCache` に登録し、DELETE は除去する。
   * USE_ALIAS / USE_VALUE はキャッシュを変えない。
   *
   * 失敗時はいずれも SessionError を throw する。
   *
   * - デコード失敗 → KEY_VALUE_FORMATTING_ERROR
   * - 重複 alias → DUPLICATE_AUTH_TOKEN_ALIAS
   * - cache 超過 → AUTH_TOKEN_CACHE_OVERFLOW
   */
  processOutgoingAuthTokens(parameters: readonly Parameter[]): void {
    for (const token of iterateAuthTokens(parameters)) {
      applyAuthTokenToCache(token, this._localAuthTokenCache);
    }
  }

  /**
   * 相手から受け取ったメッセージに含まれる AUTHORIZATION_TOKEN を処理する
   * draft-ietf-moq-transport-17 Section 9.3.2
   *
   * REGISTER は `_peerAuthTokenCache` に登録し、DELETE は除去する。
   * 失敗時は `closeSession` イベントを積み throw しない。
   */
  processIncomingAuthTokens(parameters: readonly Parameter[]): void {
    try {
      for (const token of iterateAuthTokens(parameters)) {
        applyAuthTokenToCache(token, this._peerAuthTokenCache);
      }
    } catch (e) {
      if (e instanceof SessionError) {
        this.fail(e);
        return;
      }
      throw e;
    }
  }

  private fail(error: SessionError): void {
    if (this._state === "closing" || this._state === "closed") {
      return;
    }
    this._state = "closing";
    this._events.push({ type: "closeSession", error });
  }
}

/**
 * Parameters から AUTHORIZATION_TOKEN (type 0x03) のみを取り出し
 * Token 構造をデコードして yield する
 */
function* iterateAuthTokens(parameters: readonly Parameter[]): Iterable<AuthToken> {
  for (const param of parameters) {
    if (param.type !== MessageParameterType.AUTHORIZATION_TOKEN) continue;
    yield decodeAuthToken(param.value);
  }
}

/**
 * Token を対応する AuthTokenCache に反映する
 *
 * - REGISTER: tryRegister (duplicate は AuthTokenCache が throw、overflow は false)
 * - DELETE: delete (未登録は no-op)
 * - USE_ALIAS / USE_VALUE: キャッシュは触らない
 */
function applyAuthTokenToCache(token: AuthToken, cache: AuthTokenCache): void {
  switch (token.kind) {
    case "register": {
      const ok = cache.tryRegister(token.alias, token.tokenType, token.tokenValue);
      if (!ok) {
        throw new SessionError(
          "AUTHORIZATION_TOKEN cache overflow",
          SessionErrorCode.AUTH_TOKEN_CACHE_OVERFLOW,
        );
      }
      return;
    }
    case "delete":
      cache.delete(token.alias);
      return;
    case "useAlias":
    case "useValue":
      return;
  }
}

/**
 * Setup パラメータから MAX_AUTH_TOKEN_CACHE_SIZE を読み取る
 * draft-ietf-moq-transport-17 Section 9.4.1.3 (MAX_AUTH_TOKEN_CACHE_SIZE)
 *
 * 省略時は 0 (cache 無効)。
 */
function readMaxAuthTokenCacheSize(setup: Setup): bigint {
  const param = setup.parameters.find((p) => p.type === SetupOptionType.MAX_AUTH_TOKEN_CACHE_SIZE);
  if (param === undefined) return 0n;
  return getParameterVarintValue(param);
}
