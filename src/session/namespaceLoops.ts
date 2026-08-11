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
import { NAMESPACE_OK_ALLOWED_PARAMS, validateParameterScope } from "../message/parameterScope";
import { RequestError, SessionError, SessionErrorCode, normalizeRequestErrorCode } from "../error";
import * as bidi from "./bidi";
import { isSessionClosedError, toProtocolViolationSessionError } from "./errors";
import type { NamespaceSubscription, TracksSubscription, NamespacePublication } from "../session";
import type { SessionInternal } from "./types";

/**
 * namespace 系ストリーム上の GOAWAY を処理する共通ヘルパー
 *
 * draft-ietf-moq-transport-19 §10.4 (GOAWAY):
 * 重複 GOAWAY は PROTOCOL_VIOLATION。
 * 重複なし (初回) の場合は `callbacks.goaway` を通知し、New Session URI を
 * 返す。受信方向のクローズや state 遷移は行わない (読み取り継続は呼び出し側
 * のループが担う)。
 */
export function namespaceHandleGoaway(
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

        if (
          !resolved &&
          messageType !== MessageType.REQUEST_OK &&
          messageType !== MessageType.REQUEST_ERROR
        ) {
          session.closeWithError(
            new SessionError(
              `expected REQUEST_OK or REQUEST_ERROR as first message on namespace stream, got 0x${messageType.toString(16)}`,
              SessionErrorCode.PROTOCOL_VIOLATION,
            ),
          );
          return;
        }

        switch (messageType) {
          case MessageType.REQUEST_OK: {
            if (resolved) {
              session.closeWithError(
                new SessionError(
                  "received second REQUEST_OK on namespace stream",
                  SessionErrorCode.PROTOCOL_VIOLATION,
                ),
              );
              return;
            }
            const requestOk = decodeRequestOkPayload(messagePayload);
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
              session.closeWithError(
                new SessionError(
                  "received REQUEST_ERROR after REQUEST_OK on namespace stream",
                  SessionErrorCode.PROTOCOL_VIOLATION,
                ),
              );
              return;
            }
            if (goawayReceived) {
              break;
            }
            const decodedMsg = decodeRequestErrorPayload(messagePayload);
            const error = new RequestError(
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
            subscription.state = "closed";
            callbacks.error?.(error);
            reject(error);
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
    if (subscription.state === "active" && !goawayReceived) {
      subscription.state = "closed";
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      if (!isSessionClosedError(normalizedError)) {
        callbacks.error?.(normalizedError);
      }
      if (!resolved) {
        reject(normalizedError);
      }
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

        if (
          !resolved &&
          messageType !== MessageType.REQUEST_OK &&
          messageType !== MessageType.REQUEST_ERROR
        ) {
          session.closeWithError(
            new SessionError(
              `expected REQUEST_OK or REQUEST_ERROR as first message on tracks stream, got 0x${messageType.toString(16)}`,
              SessionErrorCode.PROTOCOL_VIOLATION,
            ),
          );
          return;
        }

        switch (messageType) {
          case MessageType.REQUEST_OK: {
            if (resolved) {
              session.closeWithError(
                new SessionError(
                  "received second REQUEST_OK on tracks stream",
                  SessionErrorCode.PROTOCOL_VIOLATION,
                ),
              );
              return;
            }
            const requestOk = decodeRequestOkPayload(messagePayload);
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
              session.closeWithError(
                new SessionError(
                  "received REQUEST_ERROR after REQUEST_OK on tracks stream",
                  SessionErrorCode.PROTOCOL_VIOLATION,
                ),
              );
              return;
            }
            if (goawayReceived) {
              break;
            }
            const decodedMsg = decodeRequestErrorPayload(messagePayload);
            const error = new RequestError(
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
            subscription.state = "closed";
            callbacks.error?.(error);
            reject(error);
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
    if (subscription.state === "active" && !goawayReceived) {
      subscription.state = "closed";
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      if (!isSessionClosedError(normalizedError)) {
        callbacks.error?.(normalizedError);
      }
      if (!resolved) {
        reject(normalizedError);
      }
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
