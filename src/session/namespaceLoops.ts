/**
 * Namespace 系ストリームループ free function 群
 *
 * SessionImpl の startNamespaceStreamLoop / startTracksStreamLoop /
 * startNamespacePublicationStreamLoop / handleGoawayOnNamespaceStream
 * を free function として抽出する。
 *
 * draft-ietf-moq-transport-21 §9.15 (SUBSCRIBE_NAMESPACE)
 * draft-ietf-moq-transport-21 §9.18 (SUBSCRIBE_TRACKS)
 * draft-ietf-moq-transport-21 §9.14 (PUBLISH_NAMESPACE)
 */

import {
  MessageType,
  getMessageTypeName,
  decodeGoawayPayload,
  decodeNamespaceDonePayload,
  decodeNamespacePayload,
  decodePublishSkippedPayload,
  decodeRequestErrorPayload,
  decodeRequestOkPayload,
  trackNamespaceToStrings,
} from "../message";
import {
  NAMESPACE_OK_ALLOWED_PARAMS,
  REQUEST_UPDATE_OK_ALLOWED_PARAMS,
  validateParameterScope,
} from "../message/parameterScope";
import {
  ProtocolViolationError,
  RequestError,
  SessionError,
  SessionErrorCode,
  normalizeRequestErrorCode,
} from "../error";
import * as bidi from "./bidi";
import {
  REQUEST_UPDATE_STREAM_CLOSED_MESSAGE,
  isSessionClosedError,
  toSessionCloseError,
} from "./errors";
import type { NamespaceSubscription, TracksSubscription, NamespacePublication } from "../session";
import type { NamespaceSubscriptionState, TracksSubscriptionState } from "./types";
import type { SessionInternal } from "./types";

/**
 * namespace 系ストリーム上の GOAWAY を処理する共通ヘルパー
 *
 * draft-ietf-moq-transport-21 §9.2 (GOAWAY):
 * 重複 GOAWAY は PROTOCOL_VIOLATION。
 * 重複なし (初回) の場合は `callbacks.goaway` を通知し、New Session URI を
 * 返す。受信方向のクローズや state 遷移は行わない (読み取り継続は呼び出し側
 * のループが担う)。
 */
function namespaceHandleGoaway(
  session: SessionInternal,
  requestId: bigint,
  messagePayload: Uint8Array,
  callbacks: { goaway?: (uri: string) => void } | undefined,
): string | null {
  // 重複 GOAWAY チェック
  if (
    !bidi.validateNoDuplicateGoawayOnRequestStream(
      requestId,
      session.goawayReceivedOnRequestStreams,
      (error) => session.closeWithError(error),
    )
  ) {
    return null;
  }
  const decodedMsg = decodeGoawayPayload(messagePayload);
  // アプリのコールバック例外は握り潰す (後続の writer.close() など FIN 送信が
  // ライブラリの責務として実行されるようにする。bidi の closeOldRequestStreamOnGoaway と同方針)。
  try {
    callbacks?.goaway?.(decodedMsg.newSessionUri);
  } catch {
    // ignore
  }
  return decodedMsg.newSessionUri;
}

/**
 * namespace / tracks / publication ループで共通の GOAWAY ケース処理。
 *
 * `namespaceHandleGoaway` に加え、以下を担う:
 *
 * - 確立前 (resolved=false): §9.2 のリクエストストリーム GOAWAY マイグレーションに従い
 *   Promise を reject する。読み取りは継続し、同一ストリームの 2 通目 GOAWAY を
 *   PROTOCOL_VIOLATION として検出する (§9.2 MUST)。呼び出し側は requestMigrated を
 *   立て、以降 GOAWAY 以外のメッセージを無視する。
 * - 確立後 (resolved=true): §9.2 SHOULD「Upon receiving a GOAWAY on a request stream,
 *   the endpoint SHOULD ... close the old request stream using the appropriate mechanism
 *   (e.g. FIN, stream reset, or PUBLISH_DONE)」に従い送信方向を FIN (writer.close()) で閉じ
 *   ピアのストリームクローズを促す。受信方向は読み取り継続 (2 通目 GOAWAY 検出のため)。
 *
 * 呼び出し側は戻り値で以下を判別する:
 *
 * - "terminate": 重複 GOAWAY による PROTOCOL_VIOLATION。呼び出し側は case 節から return する。
 * - "goaway-received": GOAWAY を受理した (確立前は reject 済み)。呼び出し側は
 *   goawayReceived フラグを立てて読み取りを継続する。
 *
 * `goawayReceived` フラグ操作はループ側の関心 (state 遷移の遅延判断) なのでこの helper には
 * 持たせない。
 */
async function namespaceHandleGoawayMessage(
  session: SessionInternal,
  requestId: bigint,
  messagePayload: Uint8Array,
  callbacks: { goaway?: (uri: string) => void } | undefined,
  writer: WritableStreamDefaultWriter<Uint8Array> | undefined,
  reject: (err: Error) => void,
  resolved: boolean,
): Promise<"terminate" | "goaway-received"> {
  const newSessionUri = namespaceHandleGoaway(session, requestId, messagePayload, callbacks);
  if (newSessionUri === null) {
    // 重複 GOAWAY: セッションは PROTOCOL_VIOLATION で閉じられる
    return "terminate";
  }
  if (!resolved) {
    // REQUEST_OK 受信前 (resolved=false) の GOAWAY はマイグレーション扱いで
    // reject する。読み取りは継続して 2 通目 GOAWAY を検出する (§9.2 MUST)。
    // 送信方向・受信方向はここでは閉じない (アプリの再発行に委ねる)。
    reject(new Error(`request stream goaway: ${newSessionUri || "no redirect URI"}`));
    return "goaway-received";
  }
  // 確立後 (resolved=true) は §9.2 SHOULD に従い送信方向を FIN で閉じる。
  // 局所 try/catch で close() の reject を握り潰すことで、ループ全体の catch に
  // 落ちて読み取り継続が失われる (goawayReceived を立てても catch → finally で終了する)
  // のを防ぐ。二重 close (アプリ側のストリームクローズ (unsubscribe() / done()) との
  // 競合) も try/catch で黙殺する。
  // writer は namespace / tracks 側の state 型定義で optional (NamespaceSubscriptionState /
  // TracksSubscriptionState) だが、実行時はエントリ生成時 (subscribeNamespace / subscribeTracks) に
  // 必ず設定される。publication (NamespacePublicationState) は型定義上も必須。
  // undefined ガードは namespace / tracks 側の型 optional への防御であり、publication では常に taken される。
  if (writer !== undefined) {
    try {
      await writer.close();
    } catch {
      // 既に閉じている / エラー状態は無視
    }
  }
  return "goaway-received";
}

/**
 * 確立前の検証失敗を呼び出し元へ返す共通ヘルパー。
 *
 * PUBLISH 応答経路と同一パターン (保留の reject 後に closeWithError する
 * 順序) で、reject する SessionError と同一オブジェクトを
 * closeWithError に渡す。先に close すると close 側の汎用 reject で
 * 具体エラーが上書きされるのを防ぐ。
 */
function namespaceRejectAndCloseWithError(
  session: SessionInternal,
  reject: (err: Error) => void,
  error: SessionError,
): void {
  reject(error);
  session.closeWithError(error);
}

/**
 * namespace 系ストリームの送信方向を FIN で閉じる (失敗は無視)
 *
 * draft-ietf-moq-transport-21 §6.4.2.2:
 * "A FIN sent by the responder after its response and any subsequent messages
 *  for the request signals that the request is complete; if it has not already
 *  done so, the requester SHOULD then send a FIN on its direction, gracefully
 *  closing the stream."
 * ピアの FIN を検出した際に呼ぶ。既に GOAWAY 処理や unsubscribe で閉じている
 * 場合の reject は黙殺する。
 */
async function namespaceCloseWriterQuiet(
  writer: WritableStreamDefaultWriter<Uint8Array> | undefined,
): Promise<void> {
  if (writer === undefined) {
    return;
  }
  try {
    await writer.close();
  } catch {
    // 既に閉じている / abort 済みの場合は無視
  }
}

/**
 * SUBSCRIBE_NAMESPACE の active namespace を追跡する
 *
 * draft-ietf-moq-transport-21 §9.15:
 * NAMESPACE 受信で active に追加し、NAMESPACE_DONE 受信で削除する。
 * ストリームの FIN / RESET 検出時に emitAll() で残りへ NAMESPACE_DONE を補完する。
 * 二重補完は emitted フラグで防ぐ。
 */
interface NamespaceActiveTracker {
  add(suffix: string[]): void;
  remove(suffix: string[]): void;
  emitAll(): void;
}

function createNamespaceActiveTracker(callbacks: {
  onNamespaceDone?: (suffix: string[]) => void;
}): NamespaceActiveTracker {
  const activeNamespaces = new Map<string, string[]>();
  let emitted = false;
  return {
    add(suffix: string[]): void {
      activeNamespaces.set(JSON.stringify(suffix), suffix);
    },
    remove(suffix: string[]): void {
      activeNamespaces.delete(JSON.stringify(suffix));
    },
    emitAll(): void {
      if (emitted) {
        return;
      }
      emitted = true;
      const remaining = Array.from(activeNamespaces.values());
      activeNamespaces.clear();
      for (const suffix of remaining) {
        try {
          callbacks.onNamespaceDone?.(suffix);
        } catch {
          // アプリのコールバック例外は握り潰す (後始末を止めない)
        }
      }
    },
  };
}

/**
 * 確立前 GOAWAY でマイグレーション扱いになったリクエストで、
 * 当該メッセージを処理せず読み飛ばすべきかを判定する
 *
 * draft-ietf-moq-transport-21 §9.2:
 * 2 通目 GOAWAY の検出のため読み取りは継続し、それ以外のメッセージは無視する。
 */
function namespaceShouldSkipAfterMigration(requestMigrated: boolean, messageType: number): boolean {
  return requestMigrated && messageType !== MessageType.GOAWAY;
}

/**
 * 初期 SUBSCRIBE_NAMESPACE_OK / SUBSCRIBE_TRACKS_OK を検証する
 *
 * draft-ietf-moq-transport-21 §9.20.1 (Parameter Scope):
 * 許可外パラメータは PROTOCOL_VIOLATION でセッションを閉じる。
 * §9.3 (REQUEST_OK): Track Properties が空であることが求められるのは
 * PUBLISH_OK / REQUEST_UPDATE_OK / SUBSCRIBE_NAMESPACE_OK / PUBLISH_NAMESPACE_OK
 * であり、SUBSCRIBE_TRACKS_OK は列挙されていない。checkTrackProperties で
 * 呼び出し側が対象メッセージに応じて切り替える。
 * 確立前の検証失敗は呼び出し元 Promise を reject してから閉じる
 * (PUBLISH 応答経路と同一パターン)。
 *
 * @returns 継続可なら true、違反で閉じたなら false (呼び出し側は return する)
 */
function namespaceValidateInitialOk(
  session: SessionInternal,
  reject: (err: Error) => void,
  requestOk: ReturnType<typeof decodeRequestOkPayload>,
  contextName: "SUBSCRIBE_NAMESPACE_OK" | "SUBSCRIBE_TRACKS_OK",
  checkTrackProperties: boolean,
): boolean {
  const scopeError = validateParameterScope(
    requestOk.parameters,
    NAMESPACE_OK_ALLOWED_PARAMS,
    contextName,
  );
  if (scopeError !== null) {
    namespaceRejectAndCloseWithError(session, reject, scopeError);
    return false;
  }
  if (checkTrackProperties) {
    const trackPropertiesError = bidi.validateRequestOkNoTrackProperties(
      requestOk.trackProperties,
      contextName,
    );
    if (trackPropertiesError !== null) {
      namespaceRejectAndCloseWithError(session, reject, trackPropertiesError);
      return false;
    }
  }
  return true;
}

/**
 * SUBSCRIBE_NAMESPACE ストリームの FIN / RESET 検出時の共通処理
 *
 * - 確立前: 応答未達の reject (確立前 GOAWAY 済みなら上書きしない)
 * - 確立後: 保留中の REQUEST_UPDATE を失敗させる
 * - active namespace への NAMESPACE_DONE 補完 (§9.15)
 * - 自方向の FIN (§6.4.2.2)
 */
async function namespaceHandleNamespaceStreamDone(
  session: SessionInternal,
  requestId: bigint,
  subscription: NamespaceSubscriptionState,
  resolved: boolean,
  requestMigrated: boolean,
  reject: (err: Error) => void,
  tracker: NamespaceActiveTracker,
): Promise<void> {
  if (!resolved) {
    // 確立前 GOAWAY でマイグレーション扱いになった場合は、既に
    // マイグレーション理由で reject 済みのため上書きしない。
    if (!requestMigrated) {
      reject(new Error("stream closed before receiving response"));
    }
  } else {
    // draft-ietf-moq-transport-21 §9.5:
    // 応答を待たずにストリームが閉じた場合は保留中の更新を暗黙の失敗とする
    handleNamespaceRequestUpdateStreamClosed(session, requestId, subscription);
  }
  // 自前の unsubscribe (state=closed) 経由の done では補完しない。
  if (subscription.state === "active") {
    tracker.emitAll();
    await namespaceCloseWriterQuiet(subscription.writer);
  }
}

/**
 * namespace / tracks ストリームの先頭メッセージガード。
 *
 * draft-ietf-moq-transport-21:
 * - §9.15 / §9.18「If the subscriber receives any message other than a REQUEST_OK
 *   or a REQUEST_ERROR as the first message on the response half of the stream, then
 *   it MUST close the session with a PROTOCOL_VIOLATION.」
 * - §9.2「A GOAWAY MAY also be sent on a request stream to initiate migration of
 *   that individual request.」
 *
 * 前者の MUST に対し後者の GOAWAY マイグレーションを優先させ、確立前 (resolved=false) は
 * REQUEST_OK / REQUEST_ERROR / GOAWAY のいずれかのみを許可する。想定外メッセージは
 * PROTOCOL_VIOLATION の SessionError を返す。呼び出し側は返されたエラーで
 * reject してからセッションを閉じ、return する。
 * PUBLISH_NAMESPACE (§9.14) には先頭メッセージ MUST が draft に無いため対象外
 * (publication ループでは default ケースが unknown message type として PROTOCOL_VIOLATION で閉じる)。
 *
 * 仕様衝突の注記: §9.15 / §9.18 は「REQUEST_OK / REQUEST_ERROR 以外の先頭メッセージは
 * PROTOCOL_VIOLATION」と MUST する一方、§9.2 は「GOAWAY をリクエストストリームに送って
 * 個別リクエストをマイグレーションしてよい」と定める。両者を同時に満たす解釈は存在しない
 * ため、本実装は GOAWAY を例外として許可する現状維持の判断を採る (確立前 GOAWAY の後は
 * 読み取りを継続して 2 通目を検出し、それ以外のメッセージは無視する)。
 *
 * @returns 読み取りを継続してよい場合は null、セッションを閉じて中断する場合はそのエラー
 */
function namespaceValidateFirstMessage(
  resolved: boolean,
  messageType: number,
  streamKind: "namespace" | "tracks",
): SessionError | null {
  if (
    !resolved &&
    messageType !== MessageType.REQUEST_OK &&
    messageType !== MessageType.REQUEST_ERROR &&
    messageType !== MessageType.GOAWAY
  ) {
    return new SessionError(
      `expected REQUEST_OK, REQUEST_ERROR, or GOAWAY as first message on ${streamKind} stream, got 0x${messageType.toString(16)}`,
      SessionErrorCode.PROTOCOL_VIOLATION,
    );
  }
  return null;
}

/**
 * REQUEST_ERROR ペイロードを RequestError に変換する
 *
 * namespace 系ループの 3 箇所 (初期 REQUEST_ERROR / 更新失敗応答 /
 * GOAWAY 後の REQUEST_ERROR) で共通の構築ロジック。
 */
function decodeRequestErrorToRequestError(messagePayload: Uint8Array): RequestError {
  const decodedMsg = decodeRequestErrorPayload(messagePayload);
  // draft-ietf-moq-transport-21 §9.4.1:
  // namespace 系リクエスト (SUBSCRIBE_NAMESPACE / PUBLISH_NAMESPACE /
  // SUBSCRIBE_TRACKS) への Redirect は Track Name を空にしなければならず、
  // 非空の場合は PROTOCOL_VIOLATION でセッションを閉じる
  if (decodedMsg.redirect && decodedMsg.redirect.trackName.length > 0) {
    throw new ProtocolViolationError("namespace-scoped redirect must have an empty track name");
  }
  return new RequestError(
    decodedMsg.reasonPhrase,
    normalizeRequestErrorCode(Number(decodedMsg.errorCode)),
    decodedMsg.retryInterval,
    decodedMsg.redirect
      ? {
          connectUri: decodedMsg.redirect.connectUri,
          trackNamespace: decodedMsg.redirect.trackNamespace.tuple,
          trackName: decodedMsg.redirect.trackName,
        }
      : undefined,
  );
}

/**
 * 保留中の REQUEST_UPDATE をすべて失敗させ、pendingPrefix をクリアする
 *
 * REQUEST_ERROR 受信 (goawayReceived を含む) / ストリームクローズ /
 * セッションクローズ検出 / unsubscribe の各経路で共通の後始末。
 * 保留中の更新が無い場合は何もしない (pendingPrefix が残ることは無い。
 * pendingPrefix の設定と pending エントリの登録は同一 tick 内の対であり、
 * 失敗経路でも対で掃除されるため、pendingPrefix が undefined でない場合は
 * pending エントリが必ず存在する)。
 */
export function rejectPendingNamespaceUpdates(
  session: SessionInternal,
  requestId: bigint,
  subscription: NamespaceSubscriptionState | TracksSubscriptionState,
  error: Error,
): void {
  if (!bidi.hasPendingRequestUpdate(session, requestId)) {
    return;
  }
  bidi.rejectPendingRequestUpdates(session, requestId, error);
  subscription.pendingPrefix = undefined;
}

/**
 * ストリームクローズ / unsubscribe 時に保留中の更新を失敗させるときの
 * エラー文言。FIN 経路 (handleNamespaceRequestUpdateStreamClosed) と
 * unsubscribe 経路 (closeNamespaceSubscription / closeTracksSubscription) に
 * 加え、bidi 系・受信 PUBLISH 系の RESET_STREAM 経路でも使う共通文言。
 * 定義は循環参照を避けて errors.ts に置き、ここから再公開する。
 */
export { REQUEST_UPDATE_STREAM_CLOSED_MESSAGE } from "./errors";

/**
 * 確立後の REQUEST_OK (REQUEST_UPDATE 応答) を処理する
 *
 * draft-ietf-moq-transport-21 §9.5.2 (Updating Namespace Subscriptions):
 * 確立後の REQUEST_OK は REQUEST_UPDATE への応答 (REQUEST_UPDATE_OK) であり、
 * 保留中の更新を解決して新 prefix をサブスクリプション状態へ反映する。
 *
 * - 保留中の更新が無い 2 通目以降の REQUEST_OK は PROTOCOL_VIOLATION
 * - 更新応答は REQUEST_UPDATE_OK_ALLOWED_PARAMS でスコープ検証する
 *   (初期 REQUEST_OK が NAMESPACE_OK_ALLOWED_PARAMS を使うのとは区別する)
 * - Track Properties は REQUEST_UPDATE_OK では空であること (§9.3)
 * - 検証失敗時はセッションが PROTOCOL_VIOLATION で閉じられるため、保留中の
 *   更新も失敗として reject して掃除する (update() のハング防止)
 *
 * @param onPrefixApplied - 新 prefix を反映した直後に呼ばれるコールバック。
 *   draft-ietf-moq-transport-21 §9.5.2:
 *   "NAMESPACE and NAMESPACE_DONE messages following the REQUEST_OK will contain
 *    Track Namespace suffixes relative to the updated prefix."
 *   SUBSCRIBE_NAMESPACE ループは NAMESPACE_DONE の重複検証キーを新 prefix 基準に
 *   リセットするために使う。
 * @returns 読み取りを継続してよい場合は true、セッションが閉じられ中断する場合は false
 */
function handleNamespaceRequestUpdateOk(
  session: SessionInternal,
  requestId: bigint,
  requestOk: ReturnType<typeof decodeRequestOkPayload>,
  subscription: NamespaceSubscriptionState | TracksSubscriptionState,
  streamKind: "namespace" | "tracks",
  onPrefixApplied?: () => void,
): boolean {
  if (!bidi.hasPendingRequestUpdate(session, requestId)) {
    session.closeWithError(
      new SessionError(
        `received second REQUEST_OK on ${streamKind} stream`,
        SessionErrorCode.PROTOCOL_VIOLATION,
      ),
    );
    return false;
  }
  const scopeError = validateParameterScope(
    requestOk.parameters,
    REQUEST_UPDATE_OK_ALLOWED_PARAMS,
    "REQUEST_UPDATE_OK",
  );
  if (scopeError !== null) {
    session.closeWithError(scopeError);
    rejectPendingNamespaceUpdates(
      session,
      requestId,
      subscription,
      new Error("update failed: session closed with PROTOCOL_VIOLATION in REQUEST_UPDATE_OK"),
    );
    return false;
  }
  const trackPropertiesError = bidi.validateRequestOkNoTrackProperties(
    requestOk.trackProperties,
    "REQUEST_UPDATE_OK",
  );
  if (trackPropertiesError !== null) {
    session.closeWithError(trackPropertiesError);
    rejectPendingNamespaceUpdates(
      session,
      requestId,
      subscription,
      new Error("update failed: session closed with PROTOCOL_VIOLATION in REQUEST_UPDATE_OK"),
    );
    return false;
  }
  // 更新応答を解決し、保留中の新 prefix を反映する
  bidi.resolvePendingRequestUpdate(session, requestId);
  if (subscription.pendingPrefix !== undefined) {
    subscription.namespacePrefix = subscription.pendingPrefix;
    subscription.pendingPrefix = undefined;
    onPrefixApplied?.();
  }
  return true;
}

/**
 * 確立後の REQUEST_ERROR (REQUEST_UPDATE の失敗応答) を処理する
 *
 * draft-ietf-moq-transport-21 §9.5.2:
 * 確立後の REQUEST_ERROR は REQUEST_UPDATE の失敗応答 (例: PREFIX_OVERLAP) であり、
 * 保留中の更新をすべて reject する (coalescing 対応)。prefix は反映せず
 * pendingPrefix をクリアする。
 *
 * draft-ietf-moq-transport-21 §9.5.1:
 * "When a REQUEST_UPDATE fails for a SUBSCRIBE_NAMESPACE, SUBSCRIBE_TRACKS or
 *  PUBLISH_NAMESPACE, the responder MUST close the bidi stream"
 * に従い、ピアがストリームを閉じるまで読み取りを継続する (done 検出でループが
 * 終了する)。保留中の更新が無い REQUEST_ERROR は PROTOCOL_VIOLATION。
 *
 * @returns 読み取りを継続してよい場合は true、セッションが閉じられ中断する場合は false
 */
function handleNamespaceRequestUpdateError(
  session: SessionInternal,
  requestId: bigint,
  messagePayload: Uint8Array,
  subscription: NamespaceSubscriptionState | TracksSubscriptionState,
  streamKind: "namespace" | "tracks",
): boolean {
  if (!bidi.hasPendingRequestUpdate(session, requestId)) {
    session.closeWithError(
      new SessionError(
        `received REQUEST_ERROR after REQUEST_OK on ${streamKind} stream`,
        SessionErrorCode.PROTOCOL_VIOLATION,
      ),
    );
    return false;
  }
  rejectPendingNamespaceUpdates(
    session,
    requestId,
    subscription,
    decodeRequestErrorToRequestError(messagePayload),
  );
  return true;
}

/**
 * ストリームクローズ (done) 時の保留中 REQUEST_UPDATE を処理する
 *
 * draft-ietf-moq-transport-21 §9.5.1:
 * REQUEST_UPDATE 失敗時はピアが bidi ストリームを閉じるため、応答
 * (REQUEST_OK / REQUEST_ERROR) を待たずに閉じた場合は保留中の更新を
 * 暗黙の失敗として reject する。
 */
function handleNamespaceRequestUpdateStreamClosed(
  session: SessionInternal,
  requestId: bigint,
  subscription: NamespaceSubscriptionState | TracksSubscriptionState,
): void {
  rejectPendingNamespaceUpdates(
    session,
    requestId,
    subscription,
    new Error(REQUEST_UPDATE_STREAM_CLOSED_MESSAGE),
  );
}

/**
 * SUBSCRIBE_NAMESPACE 専用ストリームの受信ループ
 *
 * draft-ietf-moq-transport-21 §9.15 (SUBSCRIBE_NAMESPACE):
 * REQUEST_OK / REQUEST_ERROR、NAMESPACE、NAMESPACE_DONE のみを処理する。
 */
export async function namespaceStartNamespaceStreamLoop(
  session: SessionInternal,
  requestId: bigint,
  resolve: (subscription: NamespaceSubscription) => void,
  reject: (err: Error) => void,
): Promise<void> {
  const subscription = session.namespaceSubscriptions.get(requestId);
  if (!subscription || !subscription.streamReader || !subscription.controlReader) {
    reject(new Error("namespace subscription not found"));
    return;
  }

  const { streamReader, controlReader, callbacks } = subscription;
  let resolved = false;
  // draft-ietf-moq-transport-21 §9.2:
  // GOAWAY 受信後も読み取りを継続して 2 通目以降の GOAWAY を検出するための
  // フラグ。GOAWAY 受信時は state 遷移をピアの FIN 検出時 (ループ自然終了時)
  // まで遅延するため、メッセージ処理判断専用に使う。
  let goawayReceived = false;
  // 確立前 GOAWAY でマイグレーション扱いになったかどうか。
  // reject 済みのリクエストで後続メッセージを処理しないためのフラグ。
  let requestMigrated = false;
  const seenNamespaceSuffixes = new Set<string>();
  const namespaceSuffixKey = (suffix: string[]): string => JSON.stringify(suffix);
  // 有効な名前空間 (NAMESPACE 受信済みで NAMESPACE_DONE 未受信) を追跡する。
  // draft-ietf-moq-transport-21 §9.15:
  // "When a subscriber receives a stream reset or FIN on a SUBSCRIBE_NAMESPACE
  //  response stream, it SHOULD treat this as though each active namespace
  //  received a NAMESPACE_DONE."
  const activeTracker = createNamespaceActiveTracker(callbacks);

  try {
    while (subscription.state === "active") {
      const { value, done } = await streamReader.read();
      if (done) {
        // draft-ietf-moq-transport-21 §9.15 / §6.4.2.2:
        // ピアの FIN を検出したら active namespace に NAMESPACE_DONE を補完し、
        // 自方向も FIN で閉じて graceful closure を完了する。
        await namespaceHandleNamespaceStreamDone(
          session,
          requestId,
          subscription,
          resolved,
          requestMigrated,
          reject,
          activeTracker,
        );
        break;
      }

      const messages = controlReader.feed(value);
      for (const msg of messages) {
        // unsubscribe() (closeNamespaceSubscription) により state が "closed" に
        // なった後の遅延応答 (REQUEST_OK / REQUEST_ERROR / NAMESPACE /
        // NAMESPACE_DONE / GOAWAY) は処理しない。unsubscribe 側で保留中の更新を
        // reject し掃除済みのため、遅延 REQUEST_OK は「保留中の更新が無い 2 通目
        // REQUEST_OK」として PROTOCOL_VIOLATION で誤って閉じる (ピアは §9.5 の
        // 応答必須規約に従い応答しただけであり、誤検知である)。同様に
        // callbacks.onNamespace / goaway の spurious 発火も防ぐ。
        if (subscription.state !== "active") {
          break;
        }
        const messageType = msg.type;
        const messagePayload = msg.payload;

        session.callbacks.debug?.({
          direction: "recv",
          type: messageType,
          typeName: getMessageTypeName(messageType),
          payload: messagePayload,
          timestamp: Date.now(),
        });

        // 確立前 GOAWAY で reject 済みのリクエストは、2 通目 GOAWAY の検出のため
        // 読み取りだけ継続し、他のメッセージは処理しない (§9.2 MUST)。
        if (namespaceShouldSkipAfterMigration(requestMigrated, messageType)) {
          continue;
        }

        const firstMessageError = namespaceValidateFirstMessage(resolved, messageType, "namespace");
        if (firstMessageError !== null) {
          namespaceRejectAndCloseWithError(session, reject, firstMessageError);
          return;
        }

        switch (messageType) {
          case MessageType.REQUEST_OK: {
            const requestOk = decodeRequestOkPayload(messagePayload);
            if (resolved) {
              // draft-ietf-moq-transport-21 §9.5.2 (Updating Namespace Subscriptions):
              // 確立後の REQUEST_OK は REQUEST_UPDATE への応答 (REQUEST_UPDATE_OK)
              if (
                !handleNamespaceRequestUpdateOk(
                  session,
                  requestId,
                  requestOk,
                  subscription,
                  "namespace",
                  () => seenNamespaceSuffixes.clear(),
                )
              ) {
                return;
              }
              break;
            }
            // 初期 SUBSCRIBE_NAMESPACE_OK のパラメータスコープ / Track Properties
            // 検証 (draft-ietf-moq-transport-21 §9.20.1 / §9.3)。
            if (
              !namespaceValidateInitialOk(
                session,
                reject,
                requestOk,
                "SUBSCRIBE_NAMESPACE_OK",
                true,
              )
            ) {
              return;
            }
            resolved = true;
            const namespaceSubscription = session.createNamespaceSubscription(requestId);
            resolve(namespaceSubscription);
            break;
          }

          case MessageType.REQUEST_ERROR: {
            // draft-ietf-moq-transport-21 §9.2:
            // GOAWAY 受信後の REQUEST_ERROR は無視して読み取りを継続する
            // (spurious PROTOCOL_VIOLATION「received REQUEST_ERROR after
            // REQUEST_OK」を防ぐ)
            if (resolved && !goawayReceived) {
              // draft-ietf-moq-transport-21 §9.5.2:
              // 確立後の REQUEST_ERROR は REQUEST_UPDATE の失敗応答
              if (
                !handleNamespaceRequestUpdateError(
                  session,
                  requestId,
                  messagePayload,
                  subscription,
                  "namespace",
                )
              ) {
                return;
              }
              break;
            }
            if (goawayReceived) {
              // GOAWAY 受信後の REQUEST_ERROR は spurious PROTOCOL_VIOLATION を
              // 防ぐためセッションは閉じないが、GOAWAY 前に送信済みの保留中
              // 更新は失敗として reject する (update() のハング防止)
              rejectPendingNamespaceUpdates(
                session,
                requestId,
                subscription,
                decodeRequestErrorToRequestError(messagePayload),
              );
              break;
            }
            const error = decodeRequestErrorToRequestError(messagePayload);
            subscription.state = "closed";
            callbacks.error?.(error);
            reject(error);
            return;
          }

          case MessageType.GOAWAY: {
            // draft-ietf-moq-transport-21 §9.2:
            // resolved=true (確立後) は goawayReceived を立てて読み取りを継続し
            // 2 通目 GOAWAY を検出する。resolved=false (確立前) は §9.2 の
            // マイグレーション扱いで reject し、読み取りだけ継続する (helper 参照)。
            const wasResolved = resolved;
            const action = await namespaceHandleGoawayMessage(
              session,
              requestId,
              messagePayload,
              callbacks,
              subscription.writer,
              reject,
              resolved,
            );
            if (action === "terminate") {
              return;
            }
            goawayReceived = true;
            if (!wasResolved) {
              // 確立前 GOAWAY は reject 済み。以降は 2 通目 GOAWAY の検出のみ行う。
              requestMigrated = true;
            }
            break;
          }

          case MessageType.NAMESPACE: {
            const decodedMsg = decodeNamespacePayload(messagePayload);
            const suffixStrings = trackNamespaceToStrings(decodedMsg.trackNamespaceSuffix);
            const suffixKey = namespaceSuffixKey(suffixStrings);
            seenNamespaceSuffixes.add(suffixKey);
            activeTracker.add(suffixStrings);
            callbacks.onNamespace?.(suffixStrings);
            break;
          }

          case MessageType.NAMESPACE_DONE: {
            const decodedMsg = decodeNamespaceDonePayload(messagePayload);
            const suffixStrings = trackNamespaceToStrings(decodedMsg.trackNamespaceSuffix);
            if (!seenNamespaceSuffixes.has(namespaceSuffixKey(suffixStrings))) {
              session.closeWithError(
                new SessionError(
                  `received NAMESPACE_DONE before corresponding NAMESPACE: suffix=${JSON.stringify(suffixStrings)}`,
                  SessionErrorCode.PROTOCOL_VIOLATION,
                ),
              );
              return;
            }
            callbacks.onNamespaceDone?.(suffixStrings);
            // NAMESPACE_DONE 済みは FIN / RESET 時の補完対象から外す。
            activeTracker.remove(suffixStrings);
            break;
          }

          default:
            session.closeWithError(
              new SessionError(
                `unknown namespace stream message type: 0x${messageType.toString(16)}`,
                SessionErrorCode.PROTOCOL_VIOLATION,
              ),
            );
            return;
        }
      }
    }
  } catch (error) {
    // draft-ietf-moq-transport-21 §9.15:
    // RESET_STREAM 等の読み取り失敗も FIN と同様に、active namespace に
    // NAMESPACE_DONE を補完したものとして扱う。
    if (subscription.state === "active") {
      activeTracker.emitAll();
    }
    // draft-ietf-moq-transport-21 §9.2:
    // GOAWAY 受信後 (goawayReceived) は state が active のままのため、
    // spurious error 通知を抑止する
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    if (subscription.state === "active" && !goawayReceived) {
      subscription.state = "closed";
      if (!isSessionClosedError(normalizedError)) {
        callbacks.error?.(normalizedError);
      }
      // 確立前 GOAWAY の reject を読み取り失敗で上書きしない。
      if (!resolved && !requestMigrated) {
        reject(normalizedError);
      }
    }
    // draft-ietf-moq-transport-21 §9.5.1:
    // RESET_STREAM 等で read が失敗した場合も、ピアによるストリームクローズの
    // 一種として保留中の更新を暗黙の失敗として reject する。
    // goawayReceived の有無に関わらず実行する (reject しないと update() が
    // 永不解決になる。done 検出経路と同じ扱い)。
    if (resolved) {
      handleNamespaceRequestUpdateStreamClosed(session, requestId, subscription);
    }
    // SessionError はそのコードのまま、ProtocolViolationError / IncompleteDataError は PROTOCOL_VIOLATION で閉じる
    const sessionError = toSessionCloseError(error);
    if (sessionError !== null) {
      session.closeWithError(sessionError);
    }
  } finally {
    subscription.state = "closed";
    streamReader.releaseLock();
    session.namespaceSubscriptions.delete(requestId);
  }
}

/**
 * SUBSCRIBE_TRACKS 専用ストリームの受信ループ
 *
 * draft-ietf-moq-transport-21 §9.18 (SUBSCRIBE_TRACKS):
 * REQUEST_OK / REQUEST_ERROR、PUBLISH_SKIPPED のみを処理する。
 */
export async function namespaceStartTracksStreamLoop(
  session: SessionInternal,
  requestId: bigint,
  resolve: (subscription: TracksSubscription) => void,
  reject: (err: Error) => void,
): Promise<void> {
  const subscription = session.tracksSubscriptions.get(requestId);
  if (!subscription || !subscription.streamReader || !subscription.controlReader) {
    reject(new Error("tracks subscription not found"));
    return;
  }

  const { streamReader, controlReader, callbacks } = subscription;
  let resolved = false;
  // draft-ietf-moq-transport-21 §9.2:
  // GOAWAY 受信後も読み取りを継続して 2 通目以降の GOAWAY を検出するための
  // フラグ。GOAWAY 受信時は state 遷移をピアの FIN 検出時 (ループ自然終了時)
  // まで遅延するため、メッセージ処理判断専用に使う。
  let goawayReceived = false;
  // 確立前 GOAWAY でマイグレーション扱いになったかどうか (namespace 側と同様)。
  let requestMigrated = false;

  try {
    while (subscription.state === "active") {
      const { value, done } = await streamReader.read();
      if (done) {
        if (!resolved) {
          // 確立前 GOAWAY でマイグレーション扱いになった場合は、既に
          // マイグレーション理由で reject 済みのため上書きしない。
          if (!requestMigrated) {
            reject(new Error("stream closed before receiving response"));
          }
        } else {
          // draft-ietf-moq-transport-21 §9.5:
          // 応答を待たずにストリームが閉じた場合は保留中の更新を暗黙の失敗とする
          handleNamespaceRequestUpdateStreamClosed(session, requestId, subscription);
        }
        // draft-ietf-moq-transport-21 §6.4.2.2:
        // ピアの FIN を検出したら自方向も FIN で閉じて graceful closure を完了する。
        if (subscription.state === "active") {
          await namespaceCloseWriterQuiet(subscription.writer);
        }
        break;
      }

      const messages = controlReader.feed(value);
      for (const msg of messages) {
        // namespaceStartNamespaceStreamLoop のガードと同様
        // (unsubscribe 後の遅延応答 (REQUEST_OK / REQUEST_ERROR / PUBLISH_SKIPPED /
        // GOAWAY) は無視し、PROTOCOL_VIOLATION で誤って閉じるのと
        // callbacks.onPublishSkipped / goaway の spurious 発火を防ぐ)。
        if (subscription.state !== "active") {
          break;
        }
        const messageType = msg.type;
        const messagePayload = msg.payload;

        session.callbacks.debug?.({
          direction: "recv",
          type: messageType,
          typeName: getMessageTypeName(messageType),
          payload: messagePayload,
          timestamp: Date.now(),
        });

        // 確立前 GOAWAY で reject 済みのリクエストは、2 通目 GOAWAY の検出のため
        // 読み取りだけ継続し、他のメッセージは処理しない (§9.2 MUST)。
        if (namespaceShouldSkipAfterMigration(requestMigrated, messageType)) {
          continue;
        }

        const firstMessageError = namespaceValidateFirstMessage(resolved, messageType, "tracks");
        if (firstMessageError !== null) {
          namespaceRejectAndCloseWithError(session, reject, firstMessageError);
          return;
        }

        switch (messageType) {
          case MessageType.REQUEST_OK: {
            const requestOk = decodeRequestOkPayload(messagePayload);
            if (resolved) {
              // draft-ietf-moq-transport-21 §9.5.2 (Updating Namespace Subscriptions):
              // 確立後の REQUEST_OK は REQUEST_UPDATE への応答 (REQUEST_UPDATE_OK)
              if (
                !handleNamespaceRequestUpdateOk(
                  session,
                  requestId,
                  requestOk,
                  subscription,
                  "tracks",
                )
              ) {
                return;
              }
              break;
            }
            // 初期 SUBSCRIBE_TRACKS_OK のパラメータスコープ検証
            // (draft-ietf-moq-transport-21 §9.20.1)。§9.3 の空 Track Properties
            // 必須一覧に SUBSCRIBE_TRACKS_OK は含まれないため検証しない。
            if (
              !namespaceValidateInitialOk(session, reject, requestOk, "SUBSCRIBE_TRACKS_OK", false)
            ) {
              return;
            }
            resolved = true;
            const tracksSubscription = session.createTracksSubscription(requestId);
            resolve(tracksSubscription);
            break;
          }

          case MessageType.REQUEST_ERROR: {
            // draft-ietf-moq-transport-21 §9.2:
            // GOAWAY 受信後の REQUEST_ERROR は無視して読み取りを継続する
            // (spurious PROTOCOL_VIOLATION「received REQUEST_ERROR after
            // REQUEST_OK」を防ぐ)
            if (resolved && !goawayReceived) {
              // draft-ietf-moq-transport-21 §9.5.2:
              // 確立後の REQUEST_ERROR は REQUEST_UPDATE の失敗応答
              if (
                !handleNamespaceRequestUpdateError(
                  session,
                  requestId,
                  messagePayload,
                  subscription,
                  "tracks",
                )
              ) {
                return;
              }
              break;
            }
            if (goawayReceived) {
              // GOAWAY 受信後の REQUEST_ERROR は spurious PROTOCOL_VIOLATION を
              // 防ぐためセッションは閉じないが、GOAWAY 前に送信済みの保留中
              // 更新は失敗として reject する (update() のハング防止)
              rejectPendingNamespaceUpdates(
                session,
                requestId,
                subscription,
                decodeRequestErrorToRequestError(messagePayload),
              );
              break;
            }
            const error = decodeRequestErrorToRequestError(messagePayload);
            subscription.state = "closed";
            callbacks.error?.(error);
            reject(error);
            return;
          }

          case MessageType.GOAWAY: {
            // draft-ietf-moq-transport-21 §9.2:
            // resolved=true (確立後) は goawayReceived を立てて読み取りを継続し
            // 2 通目 GOAWAY を検出する。resolved=false (確立前) は §9.2 の
            // マイグレーション扱いで reject し、読み取りだけ継続する (helper 参照)。
            const wasResolved = resolved;
            const action = await namespaceHandleGoawayMessage(
              session,
              requestId,
              messagePayload,
              callbacks,
              subscription.writer,
              reject,
              resolved,
            );
            if (action === "terminate") {
              return;
            }
            goawayReceived = true;
            if (!wasResolved) {
              requestMigrated = true;
            }
            break;
          }

          case MessageType.PUBLISH_SKIPPED: {
            const decodedMsg = decodePublishSkippedPayload(messagePayload);
            const suffixStrings = trackNamespaceToStrings(decodedMsg.trackNamespaceSuffix);
            const trackName = new TextDecoder().decode(decodedMsg.trackName);
            callbacks.onPublishSkipped?.(suffixStrings, trackName);
            break;
          }

          default:
            session.closeWithError(
              new SessionError(
                `unknown tracks stream message type: 0x${messageType.toString(16)}`,
                SessionErrorCode.PROTOCOL_VIOLATION,
              ),
            );
            return;
        }
      }
    }
  } catch (error) {
    // draft-ietf-moq-transport-21 §9.2:
    // GOAWAY 受信後 (goawayReceived) は state が active のままのため、
    // spurious error 通知を抑止する
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    if (subscription.state === "active" && !goawayReceived) {
      subscription.state = "closed";
      if (!isSessionClosedError(normalizedError)) {
        callbacks.error?.(normalizedError);
      }
      // 確立前 GOAWAY の reject を読み取り失敗で上書きしない。
      if (!resolved && !requestMigrated) {
        reject(normalizedError);
      }
    }
    // draft-ietf-moq-transport-21 §9.5.1:
    // RESET_STREAM 等で read が失敗した場合も、ピアによるストリームクローズの
    // 一種として保留中の更新を暗黙の失敗として reject する。
    // goawayReceived の有無に関わらず実行する (reject しないと update() が
    // 永不解決になる。done 検出経路と同じ扱い)。
    if (resolved) {
      handleNamespaceRequestUpdateStreamClosed(session, requestId, subscription);
    }
    // SessionError はそのコードのまま、ProtocolViolationError / IncompleteDataError は PROTOCOL_VIOLATION で閉じる
    const sessionError = toSessionCloseError(error);
    if (sessionError !== null) {
      session.closeWithError(sessionError);
    }
  } finally {
    subscription.state = "closed";
    streamReader.releaseLock();
    session.tracksSubscriptions.delete(requestId);
  }
}

/**
 * PUBLISH_NAMESPACE 専用ストリームの受信ループ
 *
 * draft-ietf-moq-transport-21 Section 9.14 (PUBLISH_NAMESPACE):
 * 応答は REQUEST_OK / REQUEST_ERROR のみが想定される。
 */
export async function namespaceStartPublicationStreamLoop(
  session: SessionInternal,
  requestId: bigint,
  resolve: (publication: NamespacePublication) => void,
  reject: (err: Error) => void,
): Promise<void> {
  const publication = session.namespacePublications.get(requestId);
  if (!publication) {
    reject(new Error("namespace publication not found"));
    return;
  }

  const { streamReader, controlReader, callbacks } = publication;
  let resolved = false;
  // draft-ietf-moq-transport-21 §9.2:
  // GOAWAY 受信後も読み取りを継続して 2 通目以降の GOAWAY を検出するための
  // フラグ。GOAWAY 受信時は state 遷移をピアの FIN 検出時 (ループ自然終了時)
  // まで遅延するため、メッセージ処理判断専用に使う。
  let goawayReceived = false;
  // 確立前 GOAWAY でマイグレーション扱いになったかどうか (namespace / tracks 側と同様)。
  let requestMigrated = false;

  try {
    while (publication.state !== "closed") {
      const { value, done } = await streamReader.read();
      if (done) {
        if (!resolved) {
          // 確立前 GOAWAY でマイグレーション扱いになった場合は、既に
          // マイグレーション理由で reject 済みのため上書きしない。
          if (!requestMigrated) {
            reject(new Error("stream closed before receiving response"));
          }
        }
        // draft-ietf-moq-transport-21 §6.4.2.2:
        // ピアの FIN を検出したら自方向も FIN で閉じて graceful closure を完了する。
        await namespaceCloseWriterQuiet(publication.writer);
        break;
      }

      const messages = controlReader.feed(value);
      for (const msg of messages) {
        const messageType = msg.type;
        const messagePayload = msg.payload;

        session.callbacks.debug?.({
          direction: "recv",
          type: messageType,
          typeName: getMessageTypeName(messageType),
          payload: messagePayload,
          timestamp: Date.now(),
        });

        // 確立前 GOAWAY で reject 済みのリクエストは、2 通目 GOAWAY の検出のため
        // 読み取りだけ継続し、他のメッセージは処理しない (§9.2 MUST)。
        if (namespaceShouldSkipAfterMigration(requestMigrated, messageType)) {
          continue;
        }

        switch (messageType) {
          case MessageType.REQUEST_OK: {
            const requestOk = decodeRequestOkPayload(messagePayload);
            // 確立後の 2 通目 REQUEST_OK は重複として閉じる
            // (namespace / tracks ループと同形で scope 検証より先に判定する)。
            if (resolved) {
              session.closeWithError(
                new SessionError(
                  "received duplicate REQUEST_OK on PUBLISH_NAMESPACE stream",
                  SessionErrorCode.PROTOCOL_VIOLATION,
                ),
              );
              return;
            }
            // draft-ietf-moq-transport-21 §9.20.1 (Parameter Scope):
            // 初期 PUBLISH_NAMESPACE_OK に出現できるパラメータ以外は
            // PROTOCOL_VIOLATION でセッションを閉じる。確立前の検証失敗は
            // 呼び出し元の Promise を reject してから閉じる
            // (PUBLISH 応答経路と同一パターン)。
            const scopeError = validateParameterScope(
              requestOk.parameters,
              NAMESPACE_OK_ALLOWED_PARAMS,
              "PUBLISH_NAMESPACE_OK",
            );
            if (scopeError !== null) {
              namespaceRejectAndCloseWithError(session, reject, scopeError);
              return;
            }
            // draft-ietf-moq-transport-21 §9.3 (REQUEST_OK):
            // Track Properties は PUBLISH_NAMESPACE_OK では空が必須であり、
            // 非空は PROTOCOL_VIOLATION でセッションを閉じる。確立前の検証失敗は
            // 呼び出し元の Promise を reject してから閉じる。
            const trackPropertiesError = bidi.validateRequestOkNoTrackProperties(
              requestOk.trackProperties,
              "PUBLISH_NAMESPACE_OK",
            );
            if (trackPropertiesError !== null) {
              namespaceRejectAndCloseWithError(session, reject, trackPropertiesError);
              return;
            }
            publication.state = "active";
            resolved = true;
            resolve(session.createNamespacePublication(requestId));
            break;
          }

          case MessageType.REQUEST_ERROR: {
            // draft-ietf-moq-transport-21 §9.2:
            // GOAWAY 受信後の REQUEST_ERROR は無視して読み取りを継続する
            if (goawayReceived) {
              break;
            }
            const decodedMsg = decodeRequestErrorPayload(messagePayload);
            const error = new RequestError(
              decodedMsg.reasonPhrase || `Request failed with code ${decodedMsg.errorCode}`,
              normalizeRequestErrorCode(Number(decodedMsg.errorCode)),
              decodedMsg.retryInterval,
              decodedMsg.redirect
                ? {
                    connectUri: decodedMsg.redirect.connectUri,
                    trackNamespace: decodedMsg.redirect.trackNamespace.tuple,
                    trackName: decodedMsg.redirect.trackName,
                  }
                : undefined,
            );
            publication.state = "closed";
            callbacks?.error?.(error);
            if (!resolved) {
              reject(error);
            }
            return;
          }

          case MessageType.GOAWAY: {
            // draft-ietf-moq-transport-21 §9.2:
            // resolved=true (確立後) は goawayReceived を立てて読み取りを継続し
            // 2 通目 GOAWAY を検出する。resolved=false (確立前) は §9.2 の
            // マイグレーション扱いで reject し、読み取りだけ継続する (helper 参照)。
            const wasResolved = resolved;
            const action = await namespaceHandleGoawayMessage(
              session,
              requestId,
              messagePayload,
              callbacks,
              publication.writer,
              reject,
              resolved,
            );
            if (action === "terminate") {
              return;
            }
            goawayReceived = true;
            if (!wasResolved) {
              requestMigrated = true;
            }
            break;
          }

          default: {
            // 想定外メッセージは PROTOCOL_VIOLATION でセッションを閉じる。
            // 確立前の検証失敗は呼び出し元の Promise を reject してから閉じる
            // (確立後は Promise 解決済みのため閉じるのみにする)。
            const error = new SessionError(
              `unknown publish namespace stream message type: 0x${messageType.toString(16)}`,
              SessionErrorCode.PROTOCOL_VIOLATION,
            );
            if (!resolved) {
              namespaceRejectAndCloseWithError(session, reject, error);
            } else {
              session.closeWithError(error);
            }
            return;
          }
        }
      }
    }
  } catch (error) {
    // draft-ietf-moq-transport-21 §9.2:
    // GOAWAY 受信後 (goawayReceived) は state が active のままのため、
    // spurious error 通知を抑止する
    if (publication.state !== "closed" && !goawayReceived) {
      publication.state = "closed";
      const wrapped = error instanceof Error ? error : new Error(String(error));
      callbacks?.error?.(wrapped);
      // 確立前 GOAWAY の reject を読み取り失敗で上書きしない。
      if (!resolved && !requestMigrated) {
        reject(wrapped);
      }
    }
    // SessionError はそのコードのまま、ProtocolViolationError / IncompleteDataError は PROTOCOL_VIOLATION で閉じる
    const sessionError = toSessionCloseError(error);
    if (sessionError !== null) {
      session.closeWithError(sessionError);
    }
  } finally {
    publication.state = "closed";
    try {
      streamReader.releaseLock();
    } catch {
      // 既に解放済みの場合は無視
    }
    session.namespacePublications.delete(requestId);
  }
}
