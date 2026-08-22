/**
 * Namespace 系ストリームループ free function 群
 *
 * SessionImpl の startNamespaceStreamLoop / startTracksStreamLoop /
 * startNamespacePublicationStreamLoop / handleGoawayOnNamespaceStream
 * を free function として抽出する。
 *
 * draft-ietf-moq-transport-19 §10.18 (SUBSCRIBE_NAMESPACE)
 * draft-ietf-moq-transport-19 §10.19 (SUBSCRIBE_TRACKS)
 * draft-ietf-moq-transport-19 §10.15 (PUBLISH_NAMESPACE)
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
import { RequestError, SessionError, SessionErrorCode, normalizeRequestErrorCode } from "../error";
import * as bidi from "./bidi";
import { isSessionClosedError, toProtocolViolationSessionError } from "./errors";
import type { NamespaceSubscription, TracksSubscription, NamespacePublication } from "../session";
import type { NamespaceSubscriptionState, TracksSubscriptionState } from "./types";
import type { SessionInternal } from "./types";

/**
 * 確立前 (resolved=false) に許される namespace / tracks ストリームの先頭メッセージ判定
 *
 * draft-ietf-moq-transport-19 §10.18 / §10.19 は先頭メッセージを REQUEST_OK /
 * REQUEST_ERROR に限定する MUST を定めるが、§10.4 の GOAWAY マイグレーション
 * を優先し GOAWAY も許可する (相互運用緩和)。
 */
function isNamespaceFirstMessageAllowed(messageType: number): boolean {
  return (
    messageType === MessageType.REQUEST_OK ||
    messageType === MessageType.REQUEST_ERROR ||
    messageType === MessageType.GOAWAY
  );
}

/**
 * 確立前 (resolved=false) の GOAWAY を受信したリクエストの後始末を行う
 *
 * draft-ietf-moq-transport-19 §10.4:
 * callbacks.goaway 通知 (namespaceHandleGoaway が実施済み) 後、送信方向を
 * FIN で閉じ (SHOULD「close the old request stream … e.g. FIN」)、Promise を
 * reject してループを終了する。reject 済みリクエストに後続メッセージが発火
 * しないようにするためである。
 *
 * @param writer - FIN で閉じる送信ストリーム
 * @param streamReader - cancel する受信ストリーム
 * @param reject - Promise を reject するコールバック
 * @param newSessionUri - namespaceHandleGoaway が通知した New Session URI
 *   (呼び出し側で重複 GOAWAY の null は排除済み)
 */
async function rejectNamespaceGoaway(
  writer: WritableStreamDefaultWriter<Uint8Array> | undefined,
  streamReader: ReadableStreamDefaultReader<Uint8Array>,
  reject: (err: Error) => void,
  newSessionUri: string | null,
): Promise<void> {
  // 送信方向を FIN で閉じる。アプリの done() / unsubscribe() との二重 close が
  // reject し得るため、局所 try/catch で黙殺する (await しないと reject が
  // ループ全体の catch に落ちるため、監視漏れを避ける)。
  try {
    await writer?.close();
  } catch {
    // ストリームが既に閉じている場合は無視
  }
  // §10.4 では New Session URI のゼロ長は「同じセッションで再発行」を意味するため、
  // 空文字列は有効な値であり null のみフォールバックする
  reject(new Error(`request stream goaway: ${newSessionUri ?? "no redirect URI"}`));
  // 受信方向を cancel して閉じる。ストリームがエラー状態の場合に
  // reject し得るため握り潰す。publication ループの GOAWAY 処理と同じ流儀。
  void streamReader.cancel().catch(() => {});
}

/**
 * namespace 系ストリーム上の GOAWAY を処理する共通ヘルパー
 *
 * draft-ietf-moq-transport-19 §10.4 (GOAWAY):
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
  callbacks?.goaway?.(decodedMsg.newSessionUri);
  return decodedMsg.newSessionUri;
}

/**
 * REQUEST_ERROR ペイロードを RequestError に変換する
 *
 * namespace 系ループの 3 箇所 (初期 REQUEST_ERROR / 更新失敗応答 /
 * GOAWAY 後の REQUEST_ERROR) で共通の構築ロジック。
 */
function decodeRequestErrorToRequestError(messagePayload: Uint8Array): RequestError {
  const decodedMsg = decodeRequestErrorPayload(messagePayload);
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
 * セッションクローズ検出の各経路で共通の後始末。
 * 保留中の更新が無い場合は何もしない。
 */
function rejectPendingNamespaceUpdates(
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
 * 確立後の REQUEST_OK (REQUEST_UPDATE 応答) を処理する
 *
 * draft-ietf-moq-transport-19 §10.9.2 (Updating Namespace Subscriptions):
 * 確立後の REQUEST_OK は REQUEST_UPDATE への応答 (REQUEST_UPDATE_OK) であり、
 * 保留中の更新を解決して新 prefix をサブスクリプション状態へ反映する。
 *
 * - 保留中の更新が無い 2 通目以降の REQUEST_OK は PROTOCOL_VIOLATION
 * - 更新応答は REQUEST_UPDATE_OK_ALLOWED_PARAMS でスコープ検証する
 *   (初期 REQUEST_OK が NAMESPACE_OK_ALLOWED_PARAMS を使うのとは区別する)
 * - Track Properties は REQUEST_UPDATE_OK では空であること (§10.5)
 * - 検証失敗時はセッションが PROTOCOL_VIOLATION で閉じられるため、保留中の
 *   更新も失敗として reject して掃除する (update() のハング防止)
 *
 * @param onPrefixApplied - 新 prefix を反映した直後に呼ばれるコールバック。
 *   draft-ietf-moq-transport-19 §10.9.2:
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
  if (
    !validateParameterScope(
      requestOk.parameters,
      REQUEST_UPDATE_OK_ALLOWED_PARAMS,
      "REQUEST_UPDATE_OK",
      (error) => session.closeWithError(error),
    )
  ) {
    rejectPendingNamespaceUpdates(
      session,
      requestId,
      subscription,
      new Error("update failed: session closed with PROTOCOL_VIOLATION in REQUEST_UPDATE_OK"),
    );
    return false;
  }
  if (
    !bidi.validateRequestOkNoTrackProperties(
      requestOk.trackProperties,
      "REQUEST_UPDATE_OK",
      (error) => session.closeWithError(error),
    )
  ) {
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
 * draft-ietf-moq-transport-19 §10.9.2:
 * 確立後の REQUEST_ERROR は REQUEST_UPDATE の失敗応答 (例: PREFIX_OVERLAP) であり、
 * 保留中の更新をすべて reject する (coalescing 対応)。prefix は反映せず
 * pendingPrefix をクリアする。
 *
 * draft-ietf-moq-transport-19 §10.9.1:
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
 * draft-ietf-moq-transport-19 §10.9.1:
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
    new Error("stream closed before receiving update response"),
  );
}

/**
 * SUBSCRIBE_NAMESPACE 専用ストリームの受信ループ
 *
 * draft-ietf-moq-transport-19 §10.18 (SUBSCRIBE_NAMESPACE):
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
  // draft-ietf-moq-transport-19 §10.4:
  // GOAWAY 受信後も読み取りを継続して 2 通目以降の GOAWAY を検出するための
  // フラグ。GOAWAY 受信時は state 遷移をピアの FIN 検出時 (ループ自然終了時)
  // まで遅延するため、メッセージ処理判断専用に使う。
  let goawayReceived = false;
  const seenNamespaceSuffixes = new Set<string>();
  const namespaceSuffixKey = (suffix: string[]): string => JSON.stringify(suffix);

  try {
    while (subscription.state === "active") {
      const { value, done } = await streamReader.read();
      if (done) {
        if (!resolved) {
          reject(new Error("stream closed before receiving response"));
        } else {
          // draft-ietf-moq-transport-19 §10.9:
          // 応答を待たずにストリームが閉じた場合は保留中の更新を暗黙の失敗とする
          handleNamespaceRequestUpdateStreamClosed(session, requestId, subscription);
        }
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

        if (!resolved && !isNamespaceFirstMessageAllowed(messageType)) {
          session.closeWithError(
            new SessionError(
              `expected REQUEST_OK, REQUEST_ERROR, or GOAWAY as first message on namespace stream, got 0x${messageType.toString(16)}`,
              SessionErrorCode.PROTOCOL_VIOLATION,
            ),
          );
          return;
        }

        switch (messageType) {
          case MessageType.REQUEST_OK: {
            const requestOk = decodeRequestOkPayload(messagePayload);
            if (resolved) {
              // draft-ietf-moq-transport-19 §10.9.2 (Updating Namespace Subscriptions):
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
            if (
              !validateParameterScope(
                requestOk.parameters,
                NAMESPACE_OK_ALLOWED_PARAMS,
                "SUBSCRIBE_NAMESPACE_OK",
                (error) => session.closeWithError(error),
              )
            ) {
              return;
            }
            if (
              !bidi.validateRequestOkNoTrackProperties(
                requestOk.trackProperties,
                "SUBSCRIBE_NAMESPACE_OK",
                (error) => session.closeWithError(error),
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
            // draft-ietf-moq-transport-19 §10.4:
            // GOAWAY 受信後の REQUEST_ERROR は無視して読み取りを継続する
            // (spurious PROTOCOL_VIOLATION「received REQUEST_ERROR after
            // REQUEST_OK」を防ぐ)
            if (resolved && !goawayReceived) {
              // draft-ietf-moq-transport-19 §10.9.2:
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
            // draft-ietf-moq-transport-19 §10.4:
            // GOAWAY 受信後も読み取りを継続して 2 通目以降の GOAWAY を検出する
            // (§10.4 MUST)。callbacks.goaway 通知は namespaceHandleGoaway が行い、
            // 確立後 (resolved=true) の state 遷移 (closeState) はピアの FIN
            // 検出時 (ループ自然終了時) に遅延する。
            const newSessionUri = namespaceHandleGoaway(
              session,
              requestId,
              messagePayload,
              callbacks,
            );
            if (newSessionUri === null) {
              // 重複 GOAWAY: セッションは PROTOCOL_VIOLATION で閉じられる
              return;
            }
            if (!resolved) {
              // 確立前 (resolved=false) の GOAWAY は送信方向の FIN + reject + cancel
              // でループを終了する (reject 済みリクエストに後続メッセージが発火
              // しないようにする。2 通目以降の GOAWAY が検出されないのは確立前
              // 経路では許容する)
              await rejectNamespaceGoaway(subscription.writer, streamReader, reject, newSessionUri);
              return;
            }
            goawayReceived = true;
            break;
          }

          case MessageType.NAMESPACE: {
            const decodedMsg = decodeNamespacePayload(messagePayload);
            const suffixStrings = trackNamespaceToStrings(decodedMsg.trackNamespaceSuffix);
            seenNamespaceSuffixes.add(namespaceSuffixKey(suffixStrings));
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
    // draft-ietf-moq-transport-19 §10.4:
    // GOAWAY 受信後 (goawayReceived) は state が active のままのため、
    // spurious error 通知を抑止する
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    if (subscription.state === "active" && !goawayReceived) {
      subscription.state = "closed";
      if (!isSessionClosedError(normalizedError)) {
        callbacks.error?.(normalizedError);
      }
      if (!resolved) {
        reject(normalizedError);
      }
    }
    // draft-ietf-moq-transport-19 §10.9.1:
    // RESET_STREAM 等で read が失敗した場合も、ピアによるストリームクローズの
    // 一種として保留中の更新を暗黙の失敗として reject する。
    // goawayReceived の有無に関わらず実行する (reject しないと update() が
    // 永不解決になる。done 検出経路と同じ扱い)。
    if (resolved) {
      handleNamespaceRequestUpdateStreamClosed(session, requestId, subscription);
    }
    const sessionError = toProtocolViolationSessionError(error);
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
 * draft-ietf-moq-transport-19 §10.19 (SUBSCRIBE_TRACKS):
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
  // draft-ietf-moq-transport-19 §10.4:
  // GOAWAY 受信後も読み取りを継続して 2 通目以降の GOAWAY を検出するための
  // フラグ。GOAWAY 受信時は state 遷移をピアの FIN 検出時 (ループ自然終了時)
  // まで遅延するため、メッセージ処理判断専用に使う。
  let goawayReceived = false;

  try {
    while (subscription.state === "active") {
      const { value, done } = await streamReader.read();
      if (done) {
        if (!resolved) {
          reject(new Error("stream closed before receiving response"));
        } else {
          // draft-ietf-moq-transport-19 §10.9:
          // 応答を待たずにストリームが閉じた場合は保留中の更新を暗黙の失敗とする
          handleNamespaceRequestUpdateStreamClosed(session, requestId, subscription);
        }
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

        if (!resolved && !isNamespaceFirstMessageAllowed(messageType)) {
          session.closeWithError(
            new SessionError(
              `expected REQUEST_OK, REQUEST_ERROR, or GOAWAY as first message on tracks stream, got 0x${messageType.toString(16)}`,
              SessionErrorCode.PROTOCOL_VIOLATION,
            ),
          );
          return;
        }

        switch (messageType) {
          case MessageType.REQUEST_OK: {
            const requestOk = decodeRequestOkPayload(messagePayload);
            if (resolved) {
              // draft-ietf-moq-transport-19 §10.9.2 (Updating Namespace Subscriptions):
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
            if (
              !validateParameterScope(
                requestOk.parameters,
                NAMESPACE_OK_ALLOWED_PARAMS,
                "SUBSCRIBE_TRACKS_OK",
                (error) => session.closeWithError(error),
              )
            ) {
              return;
            }
            resolved = true;
            const tracksSubscription = session.createTracksSubscription(requestId);
            resolve(tracksSubscription);
            break;
          }

          case MessageType.REQUEST_ERROR: {
            // draft-ietf-moq-transport-19 §10.4:
            // GOAWAY 受信後の REQUEST_ERROR は無視して読み取りを継続する
            // (spurious PROTOCOL_VIOLATION「received REQUEST_ERROR after
            // REQUEST_OK」を防ぐ)
            if (resolved && !goawayReceived) {
              // draft-ietf-moq-transport-19 §10.9.2:
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
            // draft-ietf-moq-transport-19 §10.4:
            // GOAWAY 受信後も読み取りを継続して 2 通目以降の GOAWAY を検出する
            // (§10.4 MUST)。callbacks.goaway 通知は namespaceHandleGoaway が行い、
            // 確立後 (resolved=true) の state 遷移 (closeState) はピアの FIN
            // 検出時 (ループ自然終了時) に遅延する。
            const newSessionUri = namespaceHandleGoaway(
              session,
              requestId,
              messagePayload,
              callbacks,
            );
            if (newSessionUri === null) {
              // 重複 GOAWAY: セッションは PROTOCOL_VIOLATION で閉じられる
              return;
            }
            if (!resolved) {
              // 確立前 (resolved=false) の GOAWAY は送信方向の FIN + reject + cancel
              // でループを終了する (reject 済みリクエストに後続メッセージが発火
              // しないようにする。2 通目以降の GOAWAY が検出されないのは確立前
              // 経路では許容する)
              await rejectNamespaceGoaway(subscription.writer, streamReader, reject, newSessionUri);
              return;
            }
            goawayReceived = true;
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
    // draft-ietf-moq-transport-19 §10.4:
    // GOAWAY 受信後 (goawayReceived) は state が active のままのため、
    // spurious error 通知を抑止する
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    if (subscription.state === "active" && !goawayReceived) {
      subscription.state = "closed";
      if (!isSessionClosedError(normalizedError)) {
        callbacks.error?.(normalizedError);
      }
      if (!resolved) {
        reject(normalizedError);
      }
    }
    // draft-ietf-moq-transport-19 §10.9.1:
    // RESET_STREAM 等で read が失敗した場合も、ピアによるストリームクローズの
    // 一種として保留中の更新を暗黙の失敗として reject する。
    // goawayReceived の有無に関わらず実行する (reject しないと update() が
    // 永不解決になる。done 検出経路と同じ扱い)。
    if (resolved) {
      handleNamespaceRequestUpdateStreamClosed(session, requestId, subscription);
    }
    const sessionError = toProtocolViolationSessionError(error);
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
 * draft-ietf-moq-transport-19 Section 10.15 (PUBLISH_NAMESPACE):
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
  // draft-ietf-moq-transport-19 §10.4:
  // GOAWAY 受信後も読み取りを継続して 2 通目以降の GOAWAY を検出するための
  // フラグ。GOAWAY 受信時は state 遷移をピアの FIN 検出時 (ループ自然終了時)
  // まで遅延するため、メッセージ処理判断専用に使う。
  let goawayReceived = false;

  try {
    while (publication.state !== "closed") {
      const { value, done } = await streamReader.read();
      if (done) {
        if (!resolved) {
          reject(new Error("stream closed before receiving response"));
        }
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

        switch (messageType) {
          case MessageType.REQUEST_OK: {
            const requestOk = decodeRequestOkPayload(messagePayload);
            if (
              !validateParameterScope(
                requestOk.parameters,
                NAMESPACE_OK_ALLOWED_PARAMS,
                "PUBLISH_NAMESPACE_OK",
                (error) => session.closeWithError(error),
              )
            ) {
              return;
            }
            if (
              !bidi.validateRequestOkNoTrackProperties(
                requestOk.trackProperties,
                "PUBLISH_NAMESPACE_OK",
                (error) => session.closeWithError(error),
              )
            ) {
              return;
            }
            if (resolved) {
              session.closeWithError(
                new SessionError(
                  "received duplicate REQUEST_OK on PUBLISH_NAMESPACE stream",
                  SessionErrorCode.PROTOCOL_VIOLATION,
                ),
              );
              return;
            }
            publication.state = "active";
            resolved = true;
            resolve(session.createNamespacePublication(requestId));
            break;
          }

          case MessageType.REQUEST_ERROR: {
            // draft-ietf-moq-transport-19 §10.4:
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
            // draft-ietf-moq-transport-19 §10.4:
            // GOAWAY 受信後も読み取りを継続して 2 通目以降の GOAWAY を検出する
            // (§10.4 MUST)。callbacks.goaway 通知は namespaceHandleGoaway が行い、
            // state 遷移 (closeState) はピアの FIN 検出時 (ループ自然終了時) に
            // 遅延する。
            const newSessionUri = namespaceHandleGoaway(
              session,
              requestId,
              messagePayload,
              callbacks,
            );
            if (newSessionUri === null) {
              // 重複 GOAWAY: セッションは PROTOCOL_VIOLATION で閉じられる
              return;
            }
            if (!resolved) {
              // REQUEST_OK 受信前 (resolved=false) の GOAWAY は reject 後に
              // ループを終了する (reject 済みリクエストに後続メッセージが
              // 発火しないようにする)。受信方向は cancel して閉じる
              // (旧実装の STOP_SENDING 相当。ストリームが半開きで残らないようにする)。
              reject(new Error(`request stream goaway: ${newSessionUri || "no redirect URI"}`));
              // 受信方向を cancel して閉じる。ストリームがエラー状態の場合に
              // reject し得るため握り潰す。
              void streamReader.cancel().catch(() => {});
              return;
            }
            goawayReceived = true;
            break;
          }

          default:
            session.closeWithError(
              new SessionError(
                `unknown publish namespace stream message type: 0x${messageType.toString(16)}`,
                SessionErrorCode.PROTOCOL_VIOLATION,
              ),
            );
            return;
        }
      }
    }
  } catch (error) {
    // draft-ietf-moq-transport-19 §10.4:
    // GOAWAY 受信後 (goawayReceived) は state が active のままのため、
    // spurious error 通知を抑止する
    if (publication.state !== "closed" && !goawayReceived) {
      publication.state = "closed";
      const wrapped = error instanceof Error ? error : new Error(String(error));
      callbacks?.error?.(wrapped);
      if (!resolved) {
        reject(wrapped);
      }
    }
    const sessionError = toProtocolViolationSessionError(error);
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
