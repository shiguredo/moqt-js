/**
 * セッションのライフサイクル free function 群
 *
 * SessionImpl の close / markRequestObjectsClosed / rejectPendingRequests /
 * hasOpenSubscriptionsOrFetches / closeIfGoawayDrained / onRequestDrained /
 * closeWithError / notifyErrorIfActive / emitDebug / emitCallbackErrorDebug /
 * emitDataStreamErrorDebug / goaway / handleGoaway /
 * closeControlStreamViolation / startControlMessageLoop / handleControlMessage
 * を free function として抽出する。
 *
 * draft-ietf-moq-transport-21 Section 6.6 (Termination) の後始末と、
 * §6.6.1 (Graceful Session Migration) の GOAWAY 処理を 1 か所にまとめる。
 * データストリーム / リクエストの個別処理はそれぞれの担当モジュールに残す。
 */

import type { ControlStreamReader } from "../controlStream";
import { SessionError, SessionErrorCode } from "../error";
import {
  MessageType,
  decodeGoawayPayload,
  encodeGoawayPayload,
  getMessageTypeName,
} from "../message";
import { clampTimeoutMs } from "./params";
import { isPeerStreamError, isSessionClosedError, toProtocolViolationSessionError } from "./errors";
import { publishCloseSubgroupStream } from "./publish";
import type { SessionInternal } from "./types";
import type { ConnectCallbacks, SessionState } from "../session";
import type { AuthTokenCache } from "./authTokenCache";
import type { PendingSubgroupBuffer } from "../pendingSubgroupBuffer";
import type { FetchHeader } from "../dataStream";
import type {
  NamespacePublicationState,
  NamespaceSubscriptionState,
  TracksSubscriptionState,
} from "./types";

/**
 * ライフサイクル処理が必要とする SessionImpl のビュー
 *
 * SessionImpl は `as unknown as SessionLifecycleInternal` で渡す。
 * private フィールドも実行時には存在するため、ここで宣言した形で読み書きできる。
 */
export interface SessionLifecycleInternal {
  sessionState: SessionState;
  readonly transport: WebTransport;
  readonly callbacks: ConnectCallbacks;

  readonly controlSendStream?: WritableStream<Uint8Array> | undefined;
  readonly controlReceiveStream?: ReadableStream<Uint8Array> | undefined;
  readonly controlReader?: ControlStreamReader | undefined;
  datagramWriter?: WritableStreamDefaultWriter<Uint8Array> | undefined;
  incomingBidiStreamReader?:
    | ReadableStreamDefaultReader<WebTransportBidirectionalStream>
    | undefined;

  // GOAWAY 状態
  receivedGoaway: boolean;
  sentGoaway: boolean;
  goawayTimeoutId: ReturnType<typeof setTimeout> | null;

  // 追跡 Map / Set (close() が全消しする)
  readonly closedSubgroups: Set<string>;
  readonly receivedEndOfGroupFinalObjectIds: Map<string, bigint>;
  readonly priorGapTrackingByTrack: Map<string, unknown>;
  readonly goawayReceivedOnRequestStreams: Set<bigint>;
  readonly unmatchedRequestOkAllowances: Map<bigint, number>;
  readonly fillFetchTargets: Map<bigint, unknown>;
  readonly receivedRequestIds: Set<bigint>;
  readonly receivedRequestUpdateCounts: Map<bigint, number>;
  readonly receivedAuthTokens: AuthTokenCache;

  // 保留中リクエスト (reject 対象)
  readonly pendingPublish: Map<bigint, { reject: (err: Error) => void }>;
  readonly pendingSubscribe: Map<bigint, { reject: (err: Error) => void }>;
  readonly pendingFetch: Map<bigint, { reject: (err: Error) => void }>;
  readonly pendingRequestUpdate: Map<bigint, { reject: (err: Error) => void }>;
  readonly pendingTrackStatus: Map<bigint, { reject: (err: Error) => void }>;

  // 確立済みリクエスト (state を閉じる対象)
  readonly publishers: Map<bigint, { markClosed(): void }>;
  readonly subscribers: Map<bigint, { markClosed(): void }>;
  readonly fetchers: Map<bigint, { markClosed(): void }>;

  // ストリーム
  readonly namespaceSubscriptions: Map<bigint, NamespaceSubscriptionState>;
  readonly tracksSubscriptions: Map<bigint, TracksSubscriptionState>;
  readonly namespacePublications: Map<bigint, NamespacePublicationState>;
  readonly requestStreams: Map<
    bigint,
    {
      writer: WritableStreamDefaultWriter<Uint8Array>;
      controlReader: ControlStreamReader;
    }
  >;
  readonly publisherStreams: Map<bigint, unknown>;
  readonly fetcherReadyCallbacks: Map<bigint, Array<() => void>>;
  readonly pendingSubgroupBuffer: PendingSubgroupBuffer;

  // draft-ietf-moq-transport-21 §12.2: 制御メッセージの受信タイムアウト
  controlMessageTimeoutMs: number;
  statsControlMessagesReceived: number;

  /**
   * 制御ストリーム上で 1 メッセージを送信する
   *
   * GOAWAY の送信で使う。制御ストリーム未初期化時は throw する。
   */
  sendControlMessage(
    type: number,
    payload: Uint8Array,
    decoded?: Record<string, unknown>,
  ): Promise<void>;
}

/**
 * request 系オブジェクトの state を閉じる
 *
 * draft-ietf-moq-transport-21 Section 6.6:
 * セッション終了 (自前起点の close() とピア起点の transport.closed) で
 * 共通の後始末。ハンドラから close() を直接呼ぶことはできない
 * (sessionState が既に "closed" のため冒頭ガードで早期 return する) ので、
 * state 遷移だけを本ヘルパーに抽出して両方から呼ぶ。
 * 注意: セッションクローズはトラックレベルの PUBLISH_DONE ではなく
 * セッションレベルの終了 (Section 6.6 Termination) であるため handleEnd() ではなく
 * markClosed() を使用する。end コールバックは PUBLISH_DONE 専用。
 * request 系オブジェクトの handleEnd / handleError は呼ばない。
 * 通知 (ConnectCallbacks.close) や pending の reject は本ヘルパーの範囲外
 * (呼び出し元が担う。transport.closed 時の pending 掃除は現状は行わない)。
 */
export function sessionMarkRequestObjectsClosed(session: SessionLifecycleInternal): void {
  // すべてのパブリッシャー、サブスクライバー、フェッチャーを閉じる
  for (const pub of session.publishers.values()) {
    pub.markClosed();
  }
  for (const sub of session.subscribers.values()) {
    sub.markClosed();
  }
  for (const fetcher of session.fetchers.values()) {
    fetcher.markClosed();
  }
  // namespace 系の購読・配信の state を閉じる
  for (const subscription of session.namespaceSubscriptions.values()) {
    subscription.state = "closed";
  }
  for (const subscription of session.tracksSubscriptions.values()) {
    subscription.state = "closed";
  }
  for (const publication of session.namespacePublications.values()) {
    publication.state = "closed";
  }
}

/**
 * 保留中のリクエスト Promise をすべて reject してエントリを削除する
 *
 * draft-ietf-moq-transport-21 §6.6 (Termination):
 * セッション終了 (自前 close() / ピア起点の transport.closed) のいずれでも
 * アプリが未解決の Promise を待ち続けないようにする共通後始末。
 */
export function sessionRejectPendingRequests(
  session: SessionLifecycleInternal,
  error: Error,
): void {
  for (const [, pending] of session.pendingPublish) {
    pending.reject(error);
  }
  session.pendingPublish.clear();
  for (const [, pending] of session.pendingSubscribe) {
    pending.reject(error);
  }
  session.pendingSubscribe.clear();
  for (const [, pending] of session.pendingFetch) {
    pending.reject(error);
  }
  session.pendingFetch.clear();
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.reject(error);
  }
  session.pendingRequestUpdate.clear();
  for (const [, pending] of session.pendingTrackStatus) {
    pending.reject(error);
  }
  session.pendingTrackStatus.clear();
}

/**
 * 未完了の購読・fetch が残っているかを返す
 *
 * draft-ietf-moq-transport-21 §6.6.1 (Graceful Session Migration):
 * "The sender SHOULD close the session with GOAWAY_TIMEOUT after the indicated
 *  timeout if there are still open subscriptions or fetches on a connection."
 * pending なリクエストも未完了として含める。
 */
export function sessionHasOpenSubscriptionsOrFetches(session: SessionLifecycleInternal): boolean {
  return (
    session.publishers.size > 0 ||
    session.subscribers.size > 0 ||
    session.fetchers.size > 0 ||
    session.pendingPublish.size > 0 ||
    session.pendingSubscribe.size > 0 ||
    session.pendingFetch.size > 0
  );
}

/**
 * GOAWAY 受信後に Established 購読・fetch が無くなっていれば NO_ERROR で閉じる
 *
 * draft-ietf-moq-transport-21 §6.6.1:
 * "After the client receives a GOAWAY, it's RECOMMENDED that the client waits
 *  until there are no more Established subscriptions before closing the
 *  session with NO_ERROR."
 * 購読・fetch の終了通知 (onRequestDrained) から呼ばれる。
 */
export function sessionCloseIfGoawayDrained(session: SessionLifecycleInternal): void {
  if (session.sessionState !== "connected") {
    return;
  }
  if (!session.receivedGoaway) {
    return;
  }
  if (sessionHasOpenSubscriptionsOrFetches(session)) {
    return;
  }
  void sessionClose(session);
}

/**
 * 確立済みの購読・fetch が 1 つ終了したことを受けて、
 * GOAWAY 後の NO_ERROR クローズ条件を満たすか確認する
 *
 * free function (bidi / publish 系) から `session.onRequestDrained?.()` で
 * 呼ばれる。
 */
export function sessionOnRequestDrained(session: SessionLifecycleInternal): void {
  sessionCloseIfGoawayDrained(session);
}

/**
 * セッションを閉じる
 *
 * draft-ietf-moq-transport-21 Section 6.6:
 * "When WebTransport is used, the session is closed using the
 *  CLOSE_WEBTRANSPORT_SESSION capsule."
 * 正常終了時もユーザー起点で WebTransport を閉じる必要がある。
 * 保持している双方向 / 単方向ストリームの writer を閉じてから transport を閉じることで、
 * QUIC ストリームの FIN 送信とセッション終了通知を行う。
 */
export async function sessionClose(
  session: SessionLifecycleInternal,
  closeCode: number = SessionErrorCode.NO_ERROR,
  reason = "",
): Promise<void> {
  if (session.sessionState === "closed") {
    return;
  }

  session.sessionState = "closed";

  // GOAWAY タイムアウトタイマーをクリア
  if (session.goawayTimeoutId !== null) {
    clearTimeout(session.goawayTimeoutId);
    session.goawayTimeoutId = null;
  }

  // request 系オブジェクトの state を閉じる (自前起点・ピア起点で共通)
  sessionMarkRequestObjectsClosed(session);

  // Pending リクエストの Promise を reject する
  sessionRejectPendingRequests(session, new Error("session closed"));

  // 閉じた Subgroup の追跡をクリア
  session.closedSubgroups.clear();

  // END_OF_GROUP の Group 単位追跡をクリア
  session.receivedEndOfGroupFinalObjectIds.clear();

  // Prior Group ID Gap / Prior Object ID Gap の Track 単位追跡をクリア
  session.priorGapTrackingByTrack.clear();

  // GOAWAY 受信追跡をクリア
  session.goawayReceivedOnRequestStreams.clear();

  // pending の無い REQUEST_OK の許容枠をクリア
  session.unmatchedRequestOkAllowances.clear();

  // fill 関連付けをクリア
  session.fillFetchTargets.clear();

  // 受信済み Request ID の追跡をクリア
  session.receivedRequestIds.clear();

  // ストリームごとの未応答 REQUEST_UPDATE 数をクリア
  // (draft-ietf-moq-transport-21 §9.1.7。セッションが終了すると
  //  リクエストストリームも消えるため、以後の判定に使う値は残さない)
  session.receivedRequestUpdateCounts.clear();

  // draft-ietf-moq-transport-21 §8.9:
  // 受信 Authorization Token キャッシュは Session に紐付くため、終了時に破棄する。
  // 上限値は広告値であり Session の構成を表すため維持する。
  session.receivedAuthTokens.clear();

  // Pending Subgroup ストリームの buffer を解放
  // 各 entry の所有者 (handleIncomingStream) が remove で実体を削除する
  session.pendingSubgroupBuffer.notifyAll("session-close");

  // Fetcher の登録待ちコールバックを解放する。
  // incomingWaitForFetcher の doResolve が自己登録解除 (splice) するため、
  // 欠落しないよう複製して反復する。
  for (const callbacks of session.fetcherReadyCallbacks.values()) {
    for (const cb of callbacks.slice()) {
      cb();
    }
  }
  session.fetcherReadyCallbacks.clear();

  // 保持している双方向 / 単方向ストリームの writer / reader を閉じる。
  // peer 側に FIN / RESET_STREAM を送って受信ループを解除させる。
  // 既に閉じている等の理由で例外が出ても無視する。
  //
  // draft-ietf-moq-transport-21 §6.4.2.2: セッション解体は graceful request completion
  // ではないため、リクエストストリームには FIN ではなく abort（RESET 相当）を使う。
  // PUBLISH_DONE 無しの FIN は MUST 違反になり得る。
  const abortWriterSafely = async (
    writer: WritableStreamDefaultWriter<Uint8Array>,
  ): Promise<void> => {
    try {
      await writer.abort();
    } catch {
      // ストリームが既に閉じている / abort されている場合は無視
    }
  };
  const cancelReaderSafely = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<void> => {
    try {
      await reader.cancel();
    } catch {
      // 既に解放されている場合は無視
    }
  };

  // SUBSCRIBE_NAMESPACE 用の双方向ストリーム
  // (state の closed 化は markRequestObjectsClosed() 済み)
  for (const subscription of session.namespaceSubscriptions.values()) {
    if (subscription.writer) {
      void abortWriterSafely(subscription.writer);
    }
    if (subscription.streamReader) {
      void cancelReaderSafely(subscription.streamReader);
    }
  }
  session.namespaceSubscriptions.clear();

  // SUBSCRIBE_TRACKS 用の双方向ストリーム
  // draft-ietf-moq-transport-21 §9.18 (SUBSCRIBE_TRACKS)
  // (state の closed 化は markRequestObjectsClosed() 済み)
  for (const subscription of session.tracksSubscriptions.values()) {
    if (subscription.writer) {
      void abortWriterSafely(subscription.writer);
    }
    if (subscription.streamReader) {
      void cancelReaderSafely(subscription.streamReader);
    }
  }
  session.tracksSubscriptions.clear();

  // PUBLISH_NAMESPACE 用の双方向ストリーム
  // (state の closed 化は markRequestObjectsClosed() 済み)
  for (const publication of session.namespacePublications.values()) {
    void abortWriterSafely(publication.writer);
    void cancelReaderSafely(publication.streamReader);
  }
  session.namespacePublications.clear();

  // SUBSCRIBE / PUBLISH / FETCH 等のリクエスト用双方向ストリーム
  for (const entry of session.requestStreams.values()) {
    void abortWriterSafely(entry.writer);
  }
  session.requestStreams.clear();

  // Publisher 用の単方向ストリーム (Subgroup ストリーム)
  // draft-ietf-moq-transport-21 §11.3.2 (Closing Subgroup Streams):
  // 省略した Object がある Subgroup は FIN ではなく RESET で閉じる必要があるため、
  // 判定を publishCloseSubgroupStream に任せる。終了処理を遅延させないため完了は待たない
  // (判定結果はセッション終了時には使わない)。
  // Map の反復中に publishCloseSubgroupStream が現在のエントリを削除するが、
  // Map の反復は削除されたエントリを再訪しないため安全である。
  for (const trackAlias of session.publisherStreams.keys()) {
    void publishCloseSubgroupStream(session as unknown as SessionInternal, trackAlias);
  }
  session.publisherStreams.clear();

  // 制御用送信ストリーム (単方向) を閉じる。
  // writer は SETUP 送信時に releaseLock しているため、ここでは underlying stream を閉じる。
  if (session.controlSendStream) {
    try {
      await session.controlSendStream.close();
    } catch {
      // ストリームが既に閉じている場合は無視
    }
  }

  // 保持している datagram writer を解放する。
  // 一度も sendDatagram していない場合は未取得 (undefined) なので何もしない。
  if (session.datagramWriter !== undefined) {
    try {
      session.datagramWriter.releaseLock();
    } catch {
      // 既に解放されている場合は無視
    }
    session.datagramWriter = undefined;
  }

  // 受信双方向ストリームの reader を解放する
  if (session.incomingBidiStreamReader) {
    try {
      await session.incomingBidiStreamReader.cancel();
    } catch {
      // 既にキャンセル済みの場合は無視
    }
    try {
      session.incomingBidiStreamReader.releaseLock();
    } catch {
      // 既に解放されている場合は無視
    }
    session.incomingBidiStreamReader = undefined;
  }

  // WebTransport セッションを閉じて peer に終了を通知する
  try {
    session.transport.close({ closeCode, reason });
  } catch {
    // 既に閉じている場合は無視
  }

  // close コールバックはコンストラクタの transport.closed 監視で呼ばれる
}

/**
 * セッションエラーを通知してセッションを閉じる
 *
 * draft-ietf-moq-transport-21 Section 6.6:
 * プロトコル違反等のエラーが発生した場合、セッションを閉じる必要がある。
 * アプリ登録の error コールバックが throw しても close() は必ず実行する
 * (通知の成否で終了手順が止まると、違反を検出しながらセッションが開いた
 * ままになる)。後続処理を継続する点はリクエストストリーム上の GOAWAY
 * ハンドラや fetcher error 通知と同様だが、握り潰しっぱなしにせずデバッグ
 * 記録に残す点は本関数固有の配慮である。コールバックの throw は再
 * throw しない (呼び出し元 catch への再流入による誤変換・二重通知を避けるため)。
 */
export function sessionCloseWithError(
  session: SessionLifecycleInternal,
  error: SessionError,
): void {
  try {
    session.callbacks.error?.(error);
  } catch (callbackError) {
    // アプリの error コールバックの throw はデバッグ記録に残す。
    // Fetch ヘッダを持たないため emitDataStreamErrorDebug(callbackError, null)
    // で記録する (typeName は "DATA_STREAM_ERROR" になる)。
    // 記録自体の throw (debug コールバックの throw) は呼び出し元へ伝播させない。
    try {
      sessionEmitDataStreamErrorDebug(session, callbackError, null);
    } catch {
      // デバッグ記録の失敗は無視する
    }
  } finally {
    void sessionClose(session, error.code, error.message);
  }
}

/**
 * read loop で発生したエラーを必要なときだけ callbacks.error に通知する
 *
 * draft-ietf-moq-transport-21 Section 6.6:
 * peer 起点で WebTransport セッションが閉じた場合、各ストリームの read() は
 * reject するが、これは正常な終了通知であり onError には流さない。
 * sessionState がすでに connected でない、または error が WebTransport セッション
 * 終了起源の場合はスキップし、それ以外のみ通知する。
 */
export function sessionNotifyErrorIfActive(session: SessionLifecycleInternal, error: Error): void {
  if (session.sessionState !== "connected") {
    return;
  }
  if (isSessionClosedError(error)) {
    session.sessionState = "closed";
    return;
  }
  session.callbacks.error?.(error);
}

/**
 * デバッグメッセージを通知する
 */
export function sessionEmitDebug(
  session: SessionLifecycleInternal,
  direction: "send" | "recv",
  type: number,
  payload: Uint8Array,
  decoded?: Record<string, unknown>,
): void {
  if (!session.callbacks.debug) return;

  // exactOptionalPropertyTypes では optional な decoded に undefined を渡せないため、
  // 値がある場合だけ載せる
  const debugMessage = {
    direction,
    type,
    typeName: getMessageTypeName(type),
    payload,
    timestamp: Date.now(),
  };
  session.callbacks.debug(decoded === undefined ? debugMessage : { ...debugMessage, decoded });
}

/**
 * アプリのコールバック例外をデバッグ記録に残す
 *
 * 握り潰した例外を無音にしないための記録である。受信メッセージに対応しない
 * 記録のため payload は空にし、typeName でどのコールバックかを示す。
 * 記録自体の throw (debug コールバックの throw) は呼び出し元へ伝播させない。
 */
export function sessionEmitCallbackErrorDebug(
  session: SessionLifecycleInternal,
  typeName: string,
  error: unknown,
): void {
  try {
    session.callbacks.debug?.({
      direction: "recv",
      type: 0,
      typeName,
      payload: new Uint8Array(0),
      decoded: {
        error: error instanceof Error ? error.message : String(error),
      },
      timestamp: Date.now(),
    });
  } catch {
    // デバッグ記録の失敗は無視する
  }
}

/**
 * DATA_STREAM_ERROR のデバッグログを出力する
 *
 * FETCH データストリームの場合は対象の requestId を含めて追跡できるようにする。
 * fetchHeader は Fetch ヘッダーパース時にのみ設定されるため、非 null なら
 * FETCH データストリームと判定できる。
 */
export function sessionEmitDataStreamErrorDebug(
  session: SessionLifecycleInternal,
  err: unknown,
  fetchHeader: FetchHeader | null,
): void {
  session.callbacks.debug?.({
    direction: "recv",
    type: 0,
    typeName: "DATA_STREAM_ERROR",
    payload: new Uint8Array(0),
    decoded: {
      error: err instanceof Error ? err.message : String(err),
      ...(fetchHeader ? { requestId: fetchHeader.requestId.toString() } : {}),
    },
    timestamp: Date.now(),
  });
}

/**
 * GOAWAY を送信する
 *
 * draft-ietf-moq-transport-21 Section 9.2 (GOAWAY):
 * "A client MUST send a zero-length New Session URI in any GOAWAY."
 * moqt-js はクライアント実装のため、newSessionUri は常に空文字列を送る。
 */
export async function sessionGoaway(
  session: SessionLifecycleInternal,
  newSessionUri?: string,
  timeout?: bigint,
): Promise<void> {
  if (session.sentGoaway) {
    throw new Error("GOAWAY already sent");
  }

  // draft-ietf-moq-transport-21 Section 9.2 (GOAWAY):
  // "A client MUST send a zero-length New Session URI in any GOAWAY."
  // moqt-js はクライアント実装のため、newSessionUri は常に空文字列
  if (newSessionUri !== undefined && newSessionUri !== "") {
    throw new Error("client MUST send GOAWAY with empty New Session URI");
  }

  session.sentGoaway = true;

  const goawayTimeout = timeout ?? 0n;
  const payload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "",
    timeout: goawayTimeout,
  });

  await session.sendControlMessage(MessageType.GOAWAY, payload, {
    newSessionUri: newSessionUri ?? "",
    timeout: goawayTimeout.toString(),
  });

  // draft-ietf-moq-transport-21 Section 6.6.1:
  // "The sender SHOULD close the session with GOAWAY_TIMEOUT after
  // the indicated timeout if there are still open subscriptions or
  // fetches on a connection."
  // 未完了の購読・fetch が無い場合は期限を待たずに閉じる必要がないため
  // タイマーを張らない。
  if (goawayTimeout > 0n && sessionHasOpenSubscriptionsOrFetches(session)) {
    session.goawayTimeoutId = setTimeout(() => {
      if (session.sessionState === "connected") {
        sessionCloseWithError(
          session,
          new SessionError("GOAWAY timeout expired", SessionErrorCode.GOAWAY_TIMEOUT),
        );
      }
    }, clampTimeoutMs(goawayTimeout));
  }
}

/**
 * GOAWAY メッセージを処理する
 *
 * draft-ietf-moq-transport-21 Section 9.2 (GOAWAY):
 * GOAWAY を受信したエンドポイントは SUBSCRIBE, PUBLISH, FETCH, PUBLISH_NAMESPACE,
 * SUBSCRIBE_NAMESPACE, TRACK_STATUS を含む新規リクエストを peer に対して
 * 開始すべきでない。
 *
 * 複数の GOAWAY メッセージを受信した場合、エンドポイントは PROTOCOL_VIOLATION で
 * セッションを終了しなければならない。
 */
export function sessionHandleGoaway(
  session: SessionLifecycleInternal,
  payload: Uint8Array,
): Record<string, unknown> {
  // 複数回の GOAWAY 受信は PROTOCOL_VIOLATION
  if (session.receivedGoaway) {
    sessionCloseWithError(
      session,
      new SessionError("received multiple GOAWAY messages", SessionErrorCode.PROTOCOL_VIOLATION),
    );
    return { error: "Multiple GOAWAY messages received" };
  }

  // デコードに失敗した場合（trailing data 等）は PROTOCOL_VIOLATION でセッションを閉じる。
  // receivedGoaway はデコード成功後に立てることで、半端状態を避ける
  let msg: ReturnType<typeof decodeGoawayPayload>;
  try {
    msg = decodeGoawayPayload(payload);
  } catch (error) {
    const sessionError = toProtocolViolationSessionError(error);
    if (sessionError) {
      sessionCloseWithError(session, sessionError);
      return { error: "GOAWAY decode failed" };
    }
    throw error;
  }

  session.receivedGoaway = true;

  // GOAWAY コールバックを呼び出す
  session.callbacks.goaway?.(msg.newSessionUri);

  // draft-ietf-moq-transport-21 Section 6.6.1:
  // "After the client receives a GOAWAY, it's RECOMMENDED that the client
  //  waits until there are no more Established subscriptions before closing
  //  the session with NO_ERROR."
  // 期限到達時に Established 購読・fetch が残っていれば閉じず、購読終了時の
  // onRequestDrained に NO_ERROR クローズを委ねる。残っていなければ閉じる。
  if (msg.timeout > 0n) {
    session.goawayTimeoutId = setTimeout(() => {
      sessionCloseIfGoawayDrained(session);
    }, clampTimeoutMs(msg.timeout));
  }

  return {
    newSessionUri: msg.newSessionUri,
    timeout: msg.timeout.toString(),
  };
}

/**
 * 制御ストリームの閉鎖を PROTOCOL_VIOLATION として扱う
 *
 * draft-ietf-moq-transport-21 §6.3:
 * 「A control stream MUST NOT be closed at the underlying transport layer
 *  during the session's lifetime.  Doing so results in the session being
 *  closed as a PROTOCOL_VIOLATION.」
 * FIN 経路 (done) と RESET_STREAM 経路 (isPeerStreamError) で
 * sessionState === "connected" のガードを共通化し、片方だけの修正漏れと
 * 既に閉じたセッションへの誤通知を防ぐ。
 */
export function sessionCloseControlStreamViolation(
  session: SessionLifecycleInternal,
  message: string,
): void {
  if (session.sessionState !== "connected") {
    return;
  }
  sessionCloseWithError(session, new SessionError(message, SessionErrorCode.PROTOCOL_VIOLATION));
}

/**
 * 制御ストリーム上のメッセージを処理する
 *
 * draft-ietf-moq-transport-21 Section 6.3:
 * リクエスト/レスポンス (SUBSCRIBE_OK, PUBLISH_OK, FETCH_OK, REQUEST_OK,
 * REQUEST_ERROR) は双方向ストリームに移動した。
 * 制御ストリームに残るのは GOAWAY のみ。
 * draft-ietf-moq-transport-21 Section 6.3
 *
 * draft-ietf-moq-transport-21 Section 9.14 (PUBLISH_NAMESPACE):
 * PUBLISH_NAMESPACE は新しい双方向ストリームの先頭メッセージとして送信される。
 * 制御ストリーム上で受信した場合は PROTOCOL_VIOLATION でセッションを閉じる。
 */
export function sessionHandleControlMessage(
  session: SessionLifecycleInternal,
  type: number,
  payload: Uint8Array,
): void {
  session.statsControlMessagesReceived++;
  let decoded: Record<string, unknown> | undefined;

  switch (type) {
    case MessageType.PUBLISH_DONE:
      // draft-ietf-moq-transport-21 Section 9.9 (PUBLISH_DONE):
      // PUBLISH_DONE は双方向ストリーム上でのみ送信される。
      // 制御ストリーム上で受信した場合は仕様違反。
      sessionCloseWithError(
        session,
        new SessionError(
          "received PUBLISH_DONE on control stream, expected on bidirectional stream",
          SessionErrorCode.PROTOCOL_VIOLATION,
        ),
      );
      return;
    case MessageType.GOAWAY:
      decoded = sessionHandleGoaway(session, payload);
      break;
    default:
      // draft-ietf-moq-transport-21 Section 9 (Control Messages):
      // "An endpoint that receives an unknown message type MUST close the session."
      sessionCloseWithError(
        session,
        new SessionError(
          `unknown control message type: 0x${type.toString(16)}`,
          SessionErrorCode.PROTOCOL_VIOLATION,
        ),
      );
      return;
  }

  sessionEmitDebug(session, "recv", type, payload, decoded);
}

/**
 * 制御ストリームの受信ループを開始する
 *
 * draft-ietf-moq-transport-21 §12.2 (CONTROL_MESSAGE_TIMEOUT):
 * 半端な制御メッセージを保持したまま待ち続けるピアを期限で打ち切る。
 */
export function sessionStartControlMessageLoop(session: SessionLifecycleInternal): void {
  void (async () => {
    if (!session.controlReceiveStream || !session.controlReader) return;

    const reader = session.controlReceiveStream.getReader();

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const clearTimeoutHandle = (): void => {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    };
    const armTimeout = (): void => {
      clearTimeoutHandle();
      if (session.controlMessageTimeoutMs <= 0) {
        return;
      }
      timeoutHandle = setTimeout(() => {
        timeoutHandle = null;
        if (session.sessionState === "connected") {
          sessionCloseWithError(
            session,
            new SessionError(
              `control message timed out: ${session.controlReader?.bufferedBytes ?? 0} bytes buffered`,
              SessionErrorCode.CONTROL_MESSAGE_TIMEOUT,
            ),
          );
        }
        // セッション終了でストリームの読み取りが終わらない実装でもループを終わらせる
        void reader.cancel("control message timeout").catch(() => {});
      }, session.controlMessageTimeoutMs);
    };

    try {
      while (session.sessionState === "connected") {
        const { value, done } = await reader.read();
        if (done) {
          sessionCloseControlStreamViolation(session, "control stream closed unexpectedly");
          break;
        }

        const messages = session.controlReader.feed(value);
        for (const msg of messages) {
          sessionHandleControlMessage(session, msg.type, msg.payload);
        }
        // 半端なメッセージが残っている間だけ期限を張る
        if (session.controlReader.hasBufferedBytes) {
          armTimeout();
        } else {
          clearTimeoutHandle();
        }
      }
    } catch (err) {
      // draft-ietf-moq-transport-21 §6.3:
      // 制御ストリームの RESET_STREAM (ピア起因の stream error) は
      // PROTOCOL_VIOLATION でセッションを閉じる。セッション終了起源
      // (source: "session") の read 失敗は正常な終了通知であり通知しない。
      // それ以外 (アプリコールバックの throw 等) は notifyErrorIfActive に
      // 委ね、セッションを閉じない。
      if (isPeerStreamError(err)) {
        sessionCloseControlStreamViolation(
          session,
          `control stream reset by peer: ${err instanceof Error ? err.message : String(err)}`,
        );
      } else if ((err as { source?: unknown } | null)?.source !== "session") {
        sessionNotifyErrorIfActive(session, err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      clearTimeoutHandle();
      reader.releaseLock();
    }
  })();
}
