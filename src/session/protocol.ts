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
  MessageType,
  type Namespace,
  type NamespaceDone,
  type Publish,
  type PublishBlocked,
  type PublishDone,
  type PublishNamespace,
  type PublishOk,
  type RequestError,
  type RequestOk,
  type RequestUpdate,
  type Setup,
  type Subscribe,
  type SubscribeNamespace,
  type SubscribeOk,
  type TrackStatus,
} from "../message";
import type { ControlMessage } from "../message/control";
import { RequestIdGenerator, RequestIdTracker } from "./requestId";
import { createFetchEntry } from "./fetch";
import {
  createNamespacePublicationEntry,
  createNamespaceSubscriptionEntry,
  createTrackStatusEntry,
  namespaceSubscribeOptionsFromMode,
} from "./namespace";
import { createSubscriptionEntry, extractForwardState, subscriptionKey } from "./subscription";
import type {
  FetchEntry,
  NamespacePublicationEntry,
  NamespaceSubscriptionEntry,
  Role,
  SessionEvent,
  SessionState,
  SubscriptionEntry,
  Transport,
  TrackStatusEntry,
} from "./types";

/**
 * MOQT Session プロトコル状態機械
 */
export class SessionProtocol {
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

  private constructor(role: Role, transport: Transport, setup: Setup) {
    this._role = role;
    this._transport = transport;
    this._state = "setup";
    this._localSetup = setup;
    this._peerSetup = null;
    this._events = [{ type: "sendControl", message: setup }];
    this._requestIdGen = new RequestIdGenerator(role);
    this._peerRequestIds = new RequestIdTracker(role === "client" ? "server" : "client");
  }

  /**
   * Client セッションを作成する
   * draft-ietf-moq-transport-17 Section 9.4 (SETUP)
   *
   * 作成時点で自側 SETUP の sendControl イベントを積み、"setup" 状態にする。
   */
  static createClient(transport: Transport, setup: Setup): SessionProtocol {
    return new SessionProtocol("client", transport, setup);
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
    this.fail(
      new SessionError("unsupported control stream message", SessionErrorCode.PROTOCOL_VIOLATION),
    );
  }

  /**
   * 外部時計からの時刻更新を受け取る (sans-I/O)
   *
   * sans-I/O 制約のため session はタイマーを持たず、外部時計だけが時刻源となる。
   * Phase 2 時点では何も行わない。Phase 8 で GOAWAY deadline 判定を実装する。
   */
  // biome-ignore lint/suspicious/noEmptyBlockStatements: Phase 8 で実装する
  tick(_nowMs: number): void {}

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
    this._state = "established";
    this._events.push({ type: "established" });
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

  private fail(error: SessionError): void {
    if (this._state === "closing" || this._state === "closed") {
      return;
    }
    this._state = "closing";
    this._events.push({ type: "closeSession", error });
  }
}
