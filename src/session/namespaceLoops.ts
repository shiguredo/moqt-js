/**
 * Namespace 系ストリームループ free function 群
 *
 * SessionImpl の startNamespaceStreamLoop / startTracksStreamLoop /
 * startNamespacePublicationStreamLoop / handleGoawayOnNamespaceStream
 * を free function として抽出する。
 *
 * 3 ループは runNamespaceStreamLoop の共通骨格 (読み取り / done 節 /
 * REQUEST_OK / REQUEST_ERROR / GOAWAY / catch / finally) を共有し、ループごとの
 * 差 (ループ条件・追加メッセージ・先頭メッセージガード・done 時の後始末・
 * 読み取り失敗時の後始末) だけを create*StreamHandlers から注入する。
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
  MalformedTrackError,
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
  toTrackPropertiesViolationSessionError,
} from "./errors";
import { cancelStreamQuiet } from "./stream";
import type { ControlStreamReader } from "../controlStream";
import type { NamespaceSubscription, TracksSubscription, NamespacePublication } from "../session";
import type {
  NamespacePublicationState,
  NamespaceSubscriptionState,
  TracksSubscriptionState,
} from "./types";
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
  const goawayError = bidi.validateNoDuplicateGoawayOnRequestStream(
    requestId,
    session.goawayReceivedOnRequestStreams,
  );
  if (goawayError !== null) {
    session.closeWithError(goawayError);
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
    // 受信方向を開けたままにするのは 2 通目 GOAWAY の検出に読み取り継続が
    // 必要なためであり、確立前に REQUEST_ERROR を受けた経路 (両方向を閉じる)
    // とは意図的に非対称である (namespaceCloseRequestStreamQuiet 参照)。
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
 * リクエスト (購読 / 公開) 単位の error コールバックを通知する
 *
 * アプリのコールバック例外は握り潰す (後始末を止めない)。
 * createNamespaceActiveTracker.emitAll / namespaceHandleGoaway と同じ方針で、
 * 確立前の失敗も含めて同じ callbacks へ通知する。
 * 通知先は NamespaceSubscriptionCallbacks / TracksSubscriptionCallbacks /
 * NamespacePublicationCallbacks の callbacks.error であり、
 * SessionImpl.closeWithError が debug 記録に残すセッション単位の
 * ConnectCallbacks.error とは別系統である。
 *
 * 握り潰した throw は SessionImpl.closeWithError と同じくデバッグ記録に残す。
 * 記録しないとアプリのコールバックが例外を投げ続けても開発者が気づけない。
 * typeName は incomingHandleDatagram の DATAGRAM_CALLBACK_ERROR に倣い、
 * リクエスト単位の error コールバック由来であることを示す
 * REQUEST_CALLBACK_ERROR を使う。正常な通知では記録を増やさない。
 *
 * @param session - デバッグ記録の出力先を持つセッション
 * @param requestId - 失敗したリクエストの ID (デバッグ記録の追跡用)
 * @param callbacks - リクエスト単位のコールバック
 * @param error - 通知するエラー
 */
function namespaceNotifyError(
  session: SessionInternal,
  requestId: bigint,
  callbacks: { error?: (error: Error) => void } | undefined,
  error: Error,
): void {
  try {
    callbacks?.error?.(error);
  } catch (callbackError) {
    // アプリの error コールバックの throw はデバッグ記録に残す。
    // 受信メッセージに対応しない記録のため payload は空にする。
    // 記録自体の throw (debug コールバックの throw) は後始末を止めない。
    try {
      session.callbacks.debug?.({
        direction: "recv",
        type: 0,
        typeName: "REQUEST_CALLBACK_ERROR",
        payload: new Uint8Array(0),
        decoded: {
          error: callbackError instanceof Error ? callbackError.message : String(callbackError),
          requestId: requestId.toString(),
        },
        timestamp: Date.now(),
      });
    } catch {
      // デバッグ記録の失敗は無視する
    }
  }
}

/**
 * 通知系コールバックの例外を握り潰して呼び出す
 *
 * draft-ietf-moq-transport-21 §9.16 (NAMESPACE) / §9.17 (NAMESPACE_DONE) /
 * §9.19 (PUBLISH_SKIPPED) の通知はアプリへの配信である。仕様はアプリ
 * コールバックの例外を規定しないため、ライブラリの方針として
 * namespaceNotifyError と同じく「アプリのコールバック例外で後始末を止めない」
 * 扱いにし、createNamespaceActiveTracker.emitAll の補完通知とも揃える。
 * 握り潰した例外は再 throw もデバッグ記録も行わない。
 *
 * @param invoke - コールバック呼び出し (レシーバを保つため呼び出し側で組み立てる)
 */
function namespaceInvokeCallbackQuiet(invoke: () => void): void {
  try {
    invoke();
  } catch {
    // 通知の失敗で後始末を止めない
  }
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
 * 確立前に要求が失敗したとき、専用ストリームの両方向を閉じる
 *
 * draft-ietf-moq-transport-21 §6.4.2.2 (Graceful Request Stream Closure):
 * "An endpoint SHOULD send a FIN promptly after a message when it has nothing
 *  further to send on that direction and will not need to respond to a future
 *  REQUEST_UPDATE."
 * draft-ietf-moq-transport-21 §6.4.2.3 (Request Cancellation and Rejection):
 * "Implementations cancel a request by abruptly terminating any directions of
 *  the stream that are still open, using RESET_STREAM for a direction they are
 *  sending and STOP_SENDING for a direction they are receiving."
 *
 * §6.4.2.3 の「アプリケーション処理なしで要求を拒否する側は REQUEST_ERROR と FIN を
 * 送る」SHOULD は responder 側のものである。requester 側の FIN は §6.4.2.2 の
 * 一般則 (送るものが無く将来の REQUEST_UPDATE にも応答しない) に従う。
 *
 * 確立前は subscription / publication をアプリへ渡さないため、アプリからは
 * 閉じられない。送信方向を FIN し、受信方向を cancel (STOP_SENDING 相当) する。
 * どちらの失敗も無視し、reader の releaseLock は finally に委ねる。
 *
 * @param writer - 送信方向の writer (未指定なら FIN しない)
 * @param reader - 受信方向の reader
 */
async function namespaceCloseRequestStreamQuiet(
  writer: WritableStreamDefaultWriter<Uint8Array> | undefined,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  await namespaceCloseWriterQuiet(writer);
  await cancelStreamQuiet(reader, "REQUEST_ERROR received before establishment");
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
 * PUBLISH_NAMESPACE (§9.14) には応答側の先頭メッセージ MUST が draft に無いため対象外
 * (要求側の先頭メッセージは Table 5 の "First" と §6.3 が MUST で定める。publication
 *  ループでは default ケースが unknown message type として PROTOCOL_VIOLATION で閉じる)。
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
 * セッションクローズ検出 / unsubscribe / REQUEST_UPDATE_OK 検証失敗の
 * 各経路で共通の後始末。
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
 * namespace 系ループの REQUEST_OK を処理する
 *
 * draft-ietf-moq-transport-21 §9.3 (REQUEST_OK):
 * Track Properties が空必須のメッセージ (PUBLISH_OK / REQUEST_UPDATE_OK /
 * SUBSCRIBE_NAMESPACE_OK / PUBLISH_NAMESPACE_OK) で Track Properties を受信したら
 * PROTOCOL_VIOLATION でセッションを閉じる MUST。未知 Mandatory Track Property
 * (0x4000-0x7FFF) は decodeRequestOkPayload が MalformedTrackError を throw するため、
 * その違反をここで処理する。
 * 確立後 (requestUpdate) は §9.5.2 の REQUEST_UPDATE_OK として
 * handleNamespaceRequestUpdateOk に委譲する。
 *
 * @param streamKind namespace / tracks のどちらのループか。初期 OK が Track Properties を
 *   運べるのは SUBSCRIBE_TRACKS_OK (tracks) だけで、§9.3 の空必須一覧に含まれない。
 *   確立後 REQUEST_UPDATE_OK はどちらも空必須であり、確立前の違反は従来どおり
 *   ループの catch に委ねる。
 * @returns "closed" = 違反で閉じた (呼び出し側は return)、"established" = 初期 OK を
 *   受理した (呼び出し側は resolved を立てて購読を確立する)、"continue" = 確立後の
 *   REQUEST_UPDATE_OK を処理した (呼び出し側は読み取りを継続する)
 */
function namespaceHandleRequestOkMessage(
  session: SessionInternal,
  requestId: bigint,
  payload: Uint8Array,
  subscription: NamespaceSubscriptionState | TracksSubscriptionState,
  resolved: boolean,
  reject: (err: Error) => void,
  streamKind: "namespace" | "tracks",
  onPrefixApplied?: () => void,
): "closed" | "established" | "continue" {
  // 初期 OK が Track Properties を運べるのは SUBSCRIBE_TRACKS_OK だけである
  // (§9.3 の空必須一覧に含まれない)。
  const initialAllowsTrackProperties = streamKind === "tracks";
  let requestOk: ReturnType<typeof decodeRequestOkPayload>;
  try {
    requestOk = decodeRequestOkPayload(payload);
  } catch (err) {
    if (!(err instanceof MalformedTrackError) || (initialAllowsTrackProperties && !resolved)) {
      throw err;
    }
    // 確立後は保留中の更新を reject してから閉じる (既知 Type の非空を検出する
    // handleNamespaceRequestUpdateOk と同じ順序)。確立前は呼び出し元の Promise を
    // reject してから閉じる。
    const sessionError = toTrackPropertiesViolationSessionError(err);
    if (resolved) {
      rejectPendingNamespaceUpdates(session, requestId, subscription, sessionError);
      session.closeWithError(sessionError);
    } else {
      namespaceRejectAndCloseWithError(session, reject, sessionError);
    }
    return "closed";
  }
  if (resolved) {
    // draft-ietf-moq-transport-21 §9.5.2 (Updating Namespace Subscriptions):
    // 確立後の REQUEST_OK は REQUEST_UPDATE への応答 (REQUEST_UPDATE_OK)
    if (
      !handleNamespaceRequestUpdateOk(
        session,
        requestId,
        requestOk,
        subscription,
        streamKind,
        onPrefixApplied,
      )
    ) {
      return "closed";
    }
    return "continue";
  }
  // 初期 OK のパラメータスコープ / Track Properties 検証
  // (draft-ietf-moq-transport-21 §9.20.1 / §9.3)。SUBSCRIBE_TRACKS_OK は §9.3 の
  // 空必須一覧に含まれないため Track Properties を検証しない。
  const contextName = streamKind === "namespace" ? "SUBSCRIBE_NAMESPACE_OK" : "SUBSCRIBE_TRACKS_OK";
  if (
    !namespaceValidateInitialOk(
      session,
      reject,
      requestOk,
      contextName,
      !initialAllowsTrackProperties,
    )
  ) {
    return "closed";
  }
  return "established";
}

/**
 * Track Properties が空必須の REQUEST_OK をデコードする (確立前の経路用)
 *
 * draft-ietf-moq-transport-21 §9.3 (REQUEST_OK):
 * Track Properties が空必須のメッセージで Track Properties を受信したら
 * PROTOCOL_VIOLATION でセッションを閉じる MUST。未知 Mandatory Track Property
 * (0x4000-0x7FFF) は decodeRequestOkPayload が MalformedTrackError を throw するため、
 * 違反 SessionError へ変換し、呼び出し元の Promise を reject してから閉じる。
 * 確立後の REQUEST_UPDATE_OK も扱うループは namespaceHandleRequestOkMessage を使う。
 *
 * @returns デコード結果。違反で閉じた場合は null (呼び出し側は return する)
 */
function namespaceDecodeRequestOkWithoutTrackProperties(
  session: SessionInternal,
  payload: Uint8Array,
  reject: (err: Error) => void,
): ReturnType<typeof decodeRequestOkPayload> | null {
  try {
    return decodeRequestOkPayload(payload);
  } catch (err) {
    if (!(err instanceof MalformedTrackError)) {
      throw err;
    }
    namespaceRejectAndCloseWithError(session, reject, toTrackPropertiesViolationSessionError(err));
    return null;
  }
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
 * - 検証失敗時は違反 SessionError 自体で保留中の更新を reject してから
 *   セッションを閉じる (update() のハング防止。先に閉じると close 側の
 *   汎用 reject で違反エラーが上書きされる)
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
    // draft-ietf-moq-transport-21 §9.20.1 (Parameter Scope):
    // 許可外パラメータは PROTOCOL_VIOLATION で接続を閉じる MUST。
    // 先に closeWithError すると close 側の汎用 reject で違反エラーが
    // 上書きされ update() が汎用エラーで失敗するため、reject を先に行い、
    // 違反 SessionError 自体を保留中の更新へ渡す。
    rejectPendingNamespaceUpdates(session, requestId, subscription, scopeError);
    session.closeWithError(scopeError);
    return false;
  }
  const trackPropertiesError = bidi.validateRequestOkNoTrackProperties(
    requestOk.trackProperties,
    "REQUEST_UPDATE_OK",
  );
  if (trackPropertiesError !== null) {
    // draft-ietf-moq-transport-21 §9.3 (REQUEST_OK):
    // REQUEST_UPDATE_OK の Track Properties は空が必須であり、非空は
    // PROTOCOL_VIOLATION でセッションを閉じる MUST。スコープ違反と同じ順序に揃える。
    rejectPendingNamespaceUpdates(session, requestId, subscription, trackPropertiesError);
    session.closeWithError(trackPropertiesError);
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

// ============================================================
// namespace 系 3 ループの共通骨格
// ============================================================

/**
 * namespace 系 3 ループで共有する進行状態
 *
 * ループ本体とハンドラの双方が読み書きするため 1 つのオブジェクトにまとめる。
 * ループ側のローカル変数のままだとハンドラから更新できない。
 */
interface NamespaceLoopProgress {
  /** 初期 REQUEST_OK を受理して購読 / 公開を確立したか */
  resolved: boolean;
  /**
   * draft-ietf-moq-transport-21 §9.2:
   * GOAWAY 受信後も読み取りを継続して 2 通目以降の GOAWAY を検出するための
   * フラグ。GOAWAY 受信時は state 遷移をピアの FIN 検出時 (ループ自然終了時)
   * まで遅延するため、メッセージ処理判断専用に使う。
   */
  goawayReceived: boolean;
  /** 確立前 GOAWAY でマイグレーション扱いになったかどうか */
  requestMigrated: boolean;
}

/** 共通ループがリクエスト単位で必要とするコールバック */
interface NamespaceLoopCallbacks {
  error?: (error: Error) => void;
  goaway?: (uri: string) => void;
}

/** 共通ループが扱う対象 (購読 / 公開) と関連ストリーム */
interface NamespaceLoopTarget<S> {
  target: S;
  streamReader: ReadableStreamDefaultReader<Uint8Array>;
  controlReader: ControlStreamReader;
  writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  callbacks: NamespaceLoopCallbacks | undefined;
  /** finally でセッションの Map からエントリを削除する */
  cleanup(): void;
}

/** 共通ループがハンドラへ渡す文脈 */
interface NamespaceLoopContext<S> extends NamespaceLoopTarget<S> {
  session: SessionInternal;
  requestId: bigint;
  reject: (err: Error) => void;
  progress: NamespaceLoopProgress;
}

/** メッセージ 1 件を処理した後の継続方法 */
type NamespaceLoopStep = "continue" | "return";

/**
 * 3 ループの差分を注入するハンドラ群
 *
 * 共通ループが状態宣言・done 節・REQUEST_OK / REQUEST_ERROR / GOAWAY の骨格・
 * catch / finally を持ち、ループ条件・追加メッセージ・先頭メッセージガード・
 * done 時の後始末・読み取り失敗時の後始末をここから注入する。
 */
interface NamespaceLoopHandlers<S> {
  /**
   * ループ継続条件。
   * namespace / tracks は "active" の間だけ継続し、publication は初期状態
   * "pending" の間も読み続けるため "closed" 以外で継続する。
   */
  isActive(target: S): boolean;
  /** ループ終了時に state を閉じる */
  closeTarget(target: S): void;
  /**
   * unsubscribe 後に届いた遅延応答を無視するか。
   * namespace / tracks は true。unsubscribe 側で保留中の更新を reject し掃除済みの
   * ため、遅延 REQUEST_OK を「保留中の更新が無い 2 通目 REQUEST_OK」として
   * PROTOCOL_VIOLATION で誤って閉じるのを防ぐ。
   */
  skipMessagesWhenInactive: boolean;
  /** 先頭メッセージガード (publication は §9.14 に応答側の先頭メッセージ MUST が無いため未指定) */
  validateFirstMessage?(ctx: NamespaceLoopContext<S>, messageType: number): SessionError | null;
  /** ピアの FIN 検出時の後始末 */
  onStreamDone(ctx: NamespaceLoopContext<S>): Promise<void>;
  /** REQUEST_OK の処理 */
  onRequestOk(ctx: NamespaceLoopContext<S>, payload: Uint8Array): Promise<NamespaceLoopStep>;
  /** REQUEST_ERROR の処理 */
  onRequestError(ctx: NamespaceLoopContext<S>, payload: Uint8Array): Promise<NamespaceLoopStep>;
  /** REQUEST_OK / REQUEST_ERROR / GOAWAY 以外のメッセージの処理 */
  onMessage(
    ctx: NamespaceLoopContext<S>,
    messageType: number,
    payload: Uint8Array,
  ): Promise<NamespaceLoopStep>;
  /** 読み取り失敗時の後始末 (state を閉じ、通知し、確立前なら reject する) */
  onReadError(ctx: NamespaceLoopContext<S>, error: Error): void;
}

/**
 * namespace 系 3 ループ共通の受信ループ
 *
 * draft-ietf-moq-transport-21 §9.2:
 * GOAWAY は 3 ループで完全に同一の処理 (確立前はマイグレーション扱いで reject し
 * 読み取りを継続、確立後は送信方向を FIN して読み取りを継続、重複は
 * PROTOCOL_VIOLATION) のため共通ループが受け持つ。REQUEST_OK / REQUEST_ERROR と
 * 追加メッセージはループごとに異なるためハンドラへ委譲する。
 */
async function runNamespaceStreamLoop<S>(
  session: SessionInternal,
  requestId: bigint,
  loaded: NamespaceLoopTarget<S>,
  reject: (err: Error) => void,
  handlers: NamespaceLoopHandlers<S>,
): Promise<void> {
  const { target, streamReader, controlReader } = loaded;
  const progress: NamespaceLoopProgress = {
    resolved: false,
    goawayReceived: false,
    requestMigrated: false,
  };
  const ctx: NamespaceLoopContext<S> = { ...loaded, session, requestId, reject, progress };

  try {
    while (handlers.isActive(target)) {
      const { value, done } = await streamReader.read();
      if (done) {
        await handlers.onStreamDone(ctx);
        break;
      }

      const messages = controlReader.feed(value);
      for (const msg of messages) {
        // unsubscribe 後の遅延応答 (REQUEST_OK / REQUEST_ERROR / 追加メッセージ /
        // GOAWAY) は処理しない。unsubscribe 側で保留中の更新を reject し掃除済みの
        // ため、遅延 REQUEST_OK は「保留中の更新が無い 2 通目 REQUEST_OK」として
        // PROTOCOL_VIOLATION で誤って閉じる (ピアは §9.5 の応答必須規約に従い
        // 応答しただけであり、誤検知である)。callbacks の spurious 発火も防ぐ。
        if (handlers.skipMessagesWhenInactive && !handlers.isActive(target)) {
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
        if (namespaceShouldSkipAfterMigration(progress.requestMigrated, messageType)) {
          continue;
        }

        const firstMessageError = handlers.validateFirstMessage?.(ctx, messageType) ?? null;
        if (firstMessageError !== null) {
          namespaceRejectAndCloseWithError(session, reject, firstMessageError);
          return;
        }

        let step: NamespaceLoopStep;
        if (messageType === MessageType.GOAWAY) {
          step = await namespaceHandleGoawayStep(ctx, messagePayload);
        } else if (messageType === MessageType.REQUEST_OK) {
          step = await handlers.onRequestOk(ctx, messagePayload);
        } else if (messageType === MessageType.REQUEST_ERROR) {
          step = await handlers.onRequestError(ctx, messagePayload);
        } else {
          step = await handlers.onMessage(ctx, messageType, messagePayload);
        }
        if (step === "return") {
          return;
        }
      }
    }
  } catch (error) {
    handlers.onReadError(ctx, error instanceof Error ? error : new Error(String(error)));
    // SessionError はそのコードのまま、ProtocolViolationError / IncompleteDataError は
    // PROTOCOL_VIOLATION で閉じる
    const sessionError = toSessionCloseError(error);
    if (sessionError !== null) {
      session.closeWithError(sessionError);
    }
  } finally {
    handlers.closeTarget(target);
    try {
      streamReader.releaseLock();
    } catch {
      // 既に解放済みの場合は無視
    }
    loaded.cleanup();
  }
}

/**
 * 共通ループの GOAWAY ケース
 *
 * 3 ループで完全に同一の処理。受理したら goawayReceived を立て、確立前だった
 * 場合は requestMigrated を立てて以降 GOAWAY 以外のメッセージを無視させる。
 */
async function namespaceHandleGoawayStep<S>(
  ctx: NamespaceLoopContext<S>,
  messagePayload: Uint8Array,
): Promise<NamespaceLoopStep> {
  const wasResolved = ctx.progress.resolved;
  const action = await namespaceHandleGoawayMessage(
    ctx.session,
    ctx.requestId,
    messagePayload,
    ctx.callbacks,
    ctx.writer,
    ctx.reject,
    ctx.progress.resolved,
  );
  if (action === "terminate") {
    // 重複 GOAWAY による PROTOCOL_VIOLATION
    return "return";
  }
  ctx.progress.goawayReceived = true;
  if (!wasResolved) {
    // 確立前 GOAWAY は reject 済み。以降は 2 通目 GOAWAY の検出のみ行う。
    ctx.progress.requestMigrated = true;
  }
  return "continue";
}

/**
 * namespace / tracks 共通の REQUEST_ERROR ケース
 *
 * draft-ietf-moq-transport-21 §9.2:
 * GOAWAY 受信後の REQUEST_ERROR は無視して読み取りを継続する (spurious
 * PROTOCOL_VIOLATION「received REQUEST_ERROR after REQUEST_OK」を防ぐ)。
 * §9.5.2: 確立後の REQUEST_ERROR は REQUEST_UPDATE の失敗応答。
 */
async function namespaceHandleSubscriptionRequestError<
  S extends NamespaceSubscriptionState | TracksSubscriptionState,
>(
  ctx: NamespaceLoopContext<S>,
  messagePayload: Uint8Array,
  streamKind: "namespace" | "tracks",
): Promise<NamespaceLoopStep> {
  if (ctx.progress.resolved && !ctx.progress.goawayReceived) {
    if (
      !handleNamespaceRequestUpdateError(
        ctx.session,
        ctx.requestId,
        messagePayload,
        ctx.target,
        streamKind,
      )
    ) {
      return "return";
    }
    return "continue";
  }
  if (ctx.progress.goawayReceived) {
    // GOAWAY 前に送信済みの保留中更新は失敗として reject する
    // (update() のハング防止)
    rejectPendingNamespaceUpdates(
      ctx.session,
      ctx.requestId,
      ctx.target,
      decodeRequestErrorToRequestError(messagePayload),
    );
    return "continue";
  }
  const error = decodeRequestErrorToRequestError(messagePayload);
  ctx.target.state = "closed";
  namespaceNotifyError(ctx.session, ctx.requestId, ctx.callbacks, error);
  ctx.reject(error);
  // 確立前の失敗はアプリから閉じられないため、ライブラリ側で両方向を閉じる
  await namespaceCloseRequestStreamQuiet(ctx.writer, ctx.streamReader);
  return "return";
}

/**
 * namespace / tracks 共通の読み取り失敗時の後始末
 *
 * draft-ietf-moq-transport-21 §9.2:
 * GOAWAY 受信後 (goawayReceived) は state が active のままのため、
 * spurious error 通知を抑止する。
 *
 * draft-ietf-moq-transport-21 §9.5.1:
 * RESET_STREAM 等で read が失敗した場合も、ピアによるストリームクローズの
 * 一種として保留中の更新を暗黙の失敗として reject する。goawayReceived の
 * 有無に関わらず実行する (reject しないと update() が永不解決になる。
 * done 検出経路と同じ扱い)。
 */
function namespaceHandleSubscriptionReadError<
  S extends NamespaceSubscriptionState | TracksSubscriptionState,
>(ctx: NamespaceLoopContext<S>, error: Error): void {
  if (ctx.target.state === "active" && !ctx.progress.goawayReceived) {
    ctx.target.state = "closed";
    if (!isSessionClosedError(error)) {
      namespaceNotifyError(ctx.session, ctx.requestId, ctx.callbacks, error);
    }
    // 確立前 GOAWAY の reject を読み取り失敗で上書きしない。
    if (!ctx.progress.resolved && !ctx.progress.requestMigrated) {
      ctx.reject(error);
    }
  }
  if (ctx.progress.resolved) {
    handleNamespaceRequestUpdateStreamClosed(ctx.session, ctx.requestId, ctx.target);
  }
}

/**
 * FIN 検出時に、確立前なら応答未達として reject する
 *
 * 確立前 GOAWAY でマイグレーション扱いになった場合は、既にマイグレーション
 * 理由で reject 済みのため上書きしない。
 */
function namespaceRejectUnestablishedOnStreamDone<S>(ctx: NamespaceLoopContext<S>): void {
  if (!ctx.progress.resolved && !ctx.progress.requestMigrated) {
    ctx.reject(new Error("stream closed before receiving response"));
  }
}

/**
 * SUBSCRIBE_NAMESPACE 専用ストリームの受信ループ
 *
 * draft-ietf-moq-transport-21 §9.15 (SUBSCRIBE_NAMESPACE):
 * REQUEST_OK / REQUEST_ERROR、NAMESPACE、NAMESPACE_DONE のみを処理する。
 */
/**
 * SUBSCRIBE_NAMESPACE 専用ストリームのハンドラ群
 *
 * NAMESPACE / NAMESPACE_DONE の追加メッセージと、active namespace の追跡
 * (NAMESPACE_DONE 補完) を担う。
 */
function createNamespaceStreamHandlers(
  subscription: NamespaceSubscriptionState,
  resolve: (subscription: NamespaceSubscription) => void,
): NamespaceLoopHandlers<NamespaceSubscriptionState> {
  const seenNamespaceSuffixes = new Set<string>();
  const namespaceSuffixKey = (suffix: string[]): string => JSON.stringify(suffix);
  // 有効な名前空間 (NAMESPACE 受信済みで NAMESPACE_DONE 未受信) を追跡する。
  // draft-ietf-moq-transport-21 §9.15:
  // "When a subscriber receives a stream reset or FIN on a SUBSCRIBE_NAMESPACE
  //  response stream, it SHOULD treat this as though each active namespace
  //  received a NAMESPACE_DONE."
  const activeTracker = createNamespaceActiveTracker(subscription.callbacks);

  return {
    isActive: (target) => target.state === "active",
    closeTarget: (target) => {
      target.state = "closed";
    },
    skipMessagesWhenInactive: true,
    validateFirstMessage: (ctx, messageType) =>
      namespaceValidateFirstMessage(ctx.progress.resolved, messageType, "namespace"),
    onStreamDone: async (ctx) => {
      // draft-ietf-moq-transport-21 §9.15 / §6.4.2.2:
      // ピアの FIN を検出したら active namespace に NAMESPACE_DONE を補完し、
      // 自方向も FIN で閉じて graceful closure を完了する。
      await namespaceHandleNamespaceStreamDone(
        ctx.session,
        ctx.requestId,
        ctx.target,
        ctx.progress.resolved,
        ctx.progress.requestMigrated,
        ctx.reject,
        activeTracker,
      );
    },
    onRequestOk: async (ctx, payload) => {
      // draft-ietf-moq-transport-21 §9.3 (REQUEST_OK) / §9.5.2:
      // SUBSCRIBE_NAMESPACE_OK と確立後の REQUEST_UPDATE_OK は Track Properties が
      // 空必須であり、未知 Mandatory Track Property を受信したら PROTOCOL_VIOLATION で
      // セッションを閉じる MUST (処理はヘルパーに集約する)。
      const result = namespaceHandleRequestOkMessage(
        ctx.session,
        ctx.requestId,
        payload,
        ctx.target,
        ctx.progress.resolved,
        ctx.reject,
        "namespace",
        () => seenNamespaceSuffixes.clear(),
      );
      if (result === "closed") {
        return "return";
      }
      if (result === "established") {
        ctx.progress.resolved = true;
        resolve(ctx.session.createNamespaceSubscription(ctx.requestId));
      }
      return "continue";
    },
    onRequestError: (ctx, payload) =>
      namespaceHandleSubscriptionRequestError(ctx, payload, "namespace"),
    onMessage: async (ctx, messageType, payload) => {
      switch (messageType) {
        case MessageType.NAMESPACE: {
          const decodedMsg = decodeNamespacePayload(payload);
          const suffixStrings = trackNamespaceToStrings(decodedMsg.trackNamespaceSuffix);
          seenNamespaceSuffixes.add(namespaceSuffixKey(suffixStrings));
          activeTracker.add(suffixStrings);
          // 通知の throw を握り潰しても追跡状態は更新済みのため、
          // 対応する NAMESPACE_DONE は onNamespaceDone として届き得る
          namespaceInvokeCallbackQuiet(() => ctx.target.callbacks.onNamespace?.(suffixStrings));
          return "continue";
        }

        case MessageType.NAMESPACE_DONE: {
          const decodedMsg = decodeNamespaceDonePayload(payload);
          const suffixStrings = trackNamespaceToStrings(decodedMsg.trackNamespaceSuffix);
          if (!seenNamespaceSuffixes.has(namespaceSuffixKey(suffixStrings))) {
            ctx.session.closeWithError(
              new SessionError(
                `received NAMESPACE_DONE before corresponding NAMESPACE: suffix=${JSON.stringify(suffixStrings)}`,
                SessionErrorCode.PROTOCOL_VIOLATION,
              ),
            );
            return "return";
          }
          namespaceInvokeCallbackQuiet(() => ctx.target.callbacks.onNamespaceDone?.(suffixStrings));
          // NAMESPACE_DONE 済みは FIN / RESET 時の補完対象から外す。
          activeTracker.remove(suffixStrings);
          return "continue";
        }

        default:
          // draft-ietf-moq-transport-21 §9.5 (REQUEST_UPDATE):
          // "The sender of a request (SUBSCRIBE, PUBLISH, FETCH, PUBLISH_NAMESPACE,
          //  SUBSCRIBE_NAMESPACE, SUBSCRIBE_TRACKS) can later send REQUEST_UPDATE on
          //  the same bidi stream as the request to modify it. ... An endpoint that
          //  receives a REQUEST_UPDATE other than in the two cases above MUST close
          //  the session with a PROTOCOL_VIOLATION."
          // 自側が SUBSCRIBE_NAMESPACE の送信者であるため、このストリームで
          // ピアから REQUEST_UPDATE を受信することは 2 ケースのいずれにも該当しない。
          // §9.5.2 (Updating Namespace Subscriptions) の TRACK_NAMESPACE_PREFIX 更新も
          // subscriber (要求の送信者) が送るものであり、受信側の処理は不要である
          // (自側送信は bidiSendNamespaceRequestUpdate が担う)。
          // REQUEST_UPDATE を受理してトークン処理や応答を行う実装にしないこと。
          ctx.session.closeWithError(
            new SessionError(
              `unknown namespace stream message type: 0x${messageType.toString(16)}`,
              SessionErrorCode.PROTOCOL_VIOLATION,
            ),
          );
          return "return";
      }
    },
    onReadError: (ctx, error) => {
      // draft-ietf-moq-transport-21 §9.15:
      // RESET_STREAM 等の読み取り失敗も FIN と同様に、active namespace に
      // NAMESPACE_DONE を補完したものとして扱う。
      if (ctx.target.state === "active") {
        activeTracker.emitAll();
      }
      namespaceHandleSubscriptionReadError(ctx, error);
    },
  };
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

  await runNamespaceStreamLoop(
    session,
    requestId,
    {
      target: subscription,
      streamReader: subscription.streamReader,
      controlReader: subscription.controlReader,
      writer: subscription.writer,
      callbacks: subscription.callbacks,
      cleanup: () => {
        session.namespaceSubscriptions.delete(requestId);
      },
    },
    reject,
    createNamespaceStreamHandlers(subscription, resolve),
  );
}

/**
 * SUBSCRIBE_TRACKS 専用ストリームのハンドラ群
 *
 * 追加メッセージは PUBLISH_SKIPPED のみ。
 */
function createTracksStreamHandlers(
  resolve: (subscription: TracksSubscription) => void,
): NamespaceLoopHandlers<TracksSubscriptionState> {
  return {
    isActive: (target) => target.state === "active",
    closeTarget: (target) => {
      target.state = "closed";
    },
    skipMessagesWhenInactive: true,
    validateFirstMessage: (ctx, messageType) =>
      namespaceValidateFirstMessage(ctx.progress.resolved, messageType, "tracks"),
    onStreamDone: async (ctx) => {
      if (ctx.progress.resolved) {
        // draft-ietf-moq-transport-21 §9.5:
        // 応答を待たずにストリームが閉じた場合は保留中の更新を暗黙の失敗とする
        handleNamespaceRequestUpdateStreamClosed(ctx.session, ctx.requestId, ctx.target);
      } else {
        namespaceRejectUnestablishedOnStreamDone(ctx);
      }
      // draft-ietf-moq-transport-21 §6.4.2.2:
      // ピアの FIN を検出したら自方向も FIN で閉じて graceful closure を完了する。
      if (ctx.target.state === "active") {
        await namespaceCloseWriterQuiet(ctx.writer);
      }
    },
    onRequestOk: async (ctx, payload) => {
      // 初期 SUBSCRIBE_TRACKS_OK は §9.3 の空必須一覧に含まれず Track Properties を
      // 運べる。確立後の REQUEST_UPDATE_OK は空必須であり、未知 Mandatory Track
      // Property を受信したら PROTOCOL_VIOLATION でセッションを閉じる MUST
      // (処理はヘルパーに集約する)。
      const result = namespaceHandleRequestOkMessage(
        ctx.session,
        ctx.requestId,
        payload,
        ctx.target,
        ctx.progress.resolved,
        ctx.reject,
        "tracks",
      );
      if (result === "closed") {
        return "return";
      }
      if (result === "established") {
        ctx.progress.resolved = true;
        resolve(ctx.session.createTracksSubscription(ctx.requestId));
      }
      return "continue";
    },
    onRequestError: (ctx, payload) =>
      namespaceHandleSubscriptionRequestError(ctx, payload, "tracks"),
    onMessage: async (ctx, messageType, payload) => {
      switch (messageType) {
        case MessageType.PUBLISH_SKIPPED: {
          const decodedMsg = decodePublishSkippedPayload(payload);
          const suffixStrings = trackNamespaceToStrings(decodedMsg.trackNamespaceSuffix);
          const trackName = new TextDecoder().decode(decodedMsg.trackName);
          namespaceInvokeCallbackQuiet(() =>
            ctx.target.callbacks.onPublishSkipped?.(suffixStrings, trackName),
          );
          return "continue";
        }

        default:
          // SUBSCRIBE_TRACKS も自側が送信者であり、ピアからの REQUEST_UPDATE は
          // §9.5 の 2 ケースに該当しない (PROTOCOL_VIOLATION で閉じる MUST)。
          // 理由は namespace ループの同名分岐のコメントを参照する。
          ctx.session.closeWithError(
            new SessionError(
              `unknown tracks stream message type: 0x${messageType.toString(16)}`,
              SessionErrorCode.PROTOCOL_VIOLATION,
            ),
          );
          return "return";
      }
    },
    onReadError: (ctx, error) => {
      namespaceHandleSubscriptionReadError(ctx, error);
    },
  };
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

  await runNamespaceStreamLoop(
    session,
    requestId,
    {
      target: subscription,
      streamReader: subscription.streamReader,
      controlReader: subscription.controlReader,
      writer: subscription.writer,
      callbacks: subscription.callbacks,
      cleanup: () => {
        session.tracksSubscriptions.delete(requestId);
      },
    },
    reject,
    createTracksStreamHandlers(resolve),
  );
}

/**
 * PUBLISH_NAMESPACE 専用ストリームのハンドラ群
 *
 * 追加メッセージは無く、PUBLISH_NAMESPACE_OK / REQUEST_ERROR のみを扱う。
 * 確立後も読み取りを継続する (ループ条件は "closed" 以外)。
 */
function createPublicationStreamHandlers(
  resolve: (publication: NamespacePublication) => void,
): NamespaceLoopHandlers<NamespacePublicationState> {
  return {
    // 初期状態は "pending" であり、確立前も応答を読む必要がある。
    isActive: (target) => target.state !== "closed",
    closeTarget: (target) => {
      target.state = "closed";
    },
    // PUBLISH_NAMESPACE は §9.14 に応答側の先頭メッセージ MUST が無いため先頭メッセージ
    // ガードを注入しない (unknown message type として default で閉じる)。
    skipMessagesWhenInactive: false,
    onStreamDone: async (ctx) => {
      namespaceRejectUnestablishedOnStreamDone(ctx);
      // draft-ietf-moq-transport-21 §6.4.2.2:
      // ピアの FIN を検出したら自方向も FIN で閉じて graceful closure を完了する。
      await namespaceCloseWriterQuiet(ctx.writer);
    },
    onRequestOk: async (ctx, payload) => {
      // draft-ietf-moq-transport-21 §9.3 (REQUEST_OK):
      // PUBLISH_NAMESPACE_OK は Track Properties が空必須であり、未知 Mandatory
      // Track Property を受信したら PROTOCOL_VIOLATION でセッションを閉じる MUST
      // (publication ストリームは REQUEST_UPDATE を扱わないため確立前のみ)。
      const requestOk = namespaceDecodeRequestOkWithoutTrackProperties(
        ctx.session,
        payload,
        ctx.reject,
      );
      if (requestOk === null) {
        return "return";
      }
      // 確立後の 2 通目 REQUEST_OK は重複として閉じる
      // (namespace / tracks ループと同形で scope 検証より先に判定する)。
      if (ctx.progress.resolved) {
        ctx.session.closeWithError(
          new SessionError(
            "received duplicate REQUEST_OK on PUBLISH_NAMESPACE stream",
            SessionErrorCode.PROTOCOL_VIOLATION,
          ),
        );
        return "return";
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
        namespaceRejectAndCloseWithError(ctx.session, ctx.reject, scopeError);
        return "return";
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
        namespaceRejectAndCloseWithError(ctx.session, ctx.reject, trackPropertiesError);
        return "return";
      }
      ctx.target.state = "active";
      ctx.progress.resolved = true;
      resolve(ctx.session.createNamespacePublication(ctx.requestId));
      return "continue";
    },
    onRequestError: async (ctx, payload) => {
      // draft-ietf-moq-transport-21 §9.2:
      // GOAWAY 受信後の REQUEST_ERROR は無視して読み取りを継続する
      if (ctx.progress.goawayReceived) {
        return "continue";
      }
      const decodedMsg = decodeRequestErrorPayload(payload);
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
      ctx.target.state = "closed";
      namespaceNotifyError(ctx.session, ctx.requestId, ctx.callbacks, error);
      if (!ctx.progress.resolved) {
        ctx.reject(error);
        // 確立前の失敗はアプリから閉じられないため、ライブラリ側で両方向を閉じる
        await namespaceCloseRequestStreamQuiet(ctx.writer, ctx.streamReader);
      }
      return "return";
    },
    onMessage: async (ctx, messageType) => {
      // 想定外メッセージは PROTOCOL_VIOLATION でセッションを閉じる。
      // 確立前の検証失敗は呼び出し元の Promise を reject してから閉じる
      // (確立後は Promise 解決済みのため閉じるのみにする)。
      const error = new SessionError(
        `unknown publish namespace stream message type: 0x${messageType.toString(16)}`,
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
      if (!ctx.progress.resolved) {
        namespaceRejectAndCloseWithError(ctx.session, ctx.reject, error);
      } else {
        ctx.session.closeWithError(error);
      }
      return "return";
    },
    onReadError: (ctx, error) => {
      // draft-ietf-moq-transport-21 §9.2:
      // GOAWAY 受信後 (goawayReceived) は state が active のままのため、
      // spurious error 通知を抑止する
      if (ctx.target.state !== "closed" && !ctx.progress.goawayReceived) {
        ctx.target.state = "closed";
        namespaceNotifyError(ctx.session, ctx.requestId, ctx.callbacks, error);
        // 確立前 GOAWAY の reject を読み取り失敗で上書きしない。
        if (!ctx.progress.resolved && !ctx.progress.requestMigrated) {
          ctx.reject(error);
        }
      }
    },
  };
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

  await runNamespaceStreamLoop(
    session,
    requestId,
    {
      target: publication,
      streamReader: publication.streamReader,
      controlReader: publication.controlReader,
      writer: publication.writer,
      callbacks: publication.callbacks,
      cleanup: () => {
        session.namespacePublications.delete(requestId);
      },
    },
    reject,
    createPublicationStreamHandlers(resolve),
  );
}
