/**
 * 受信 PUBLISH (双方向ストリーム) 処理の free function 群
 *
 * SessionImpl の startIncomingBidirectionalStreamLoop /
 * handleIncomingBidirectionalStream / runPublishStreamSubLoop /
 * readFirstBidiMessage / cancelIfNotConnected /
 * processIncomingPublishAuthorizationTokens / applyIncomingPublishParameters /
 * matchPublishToSubscription / cleanupIncomingPublish を free function として
 * 抽出する。
 *
 * draft-ietf-moq-transport-21 §9.18 (SUBSCRIBE_TRACKS) のとおり、購読側が
 * PUBLISH を新規双方向ストリームで受信し、REQUEST_UPDATE の応答
 * (REQUEST_OK / REQUEST_ERROR) と PUBLISH_DONE を同じストリームで受信する
 * 経路をまとめる。受信データストリームは dataStreamIncoming.ts が担当する。
 */

import {
  MessageType,
  MessageParameterType,
  decodePublishPayload,
  decodeRequestErrorPayload,
  decodeGoawayPayload,
  encodeRequestOkPayload,
  decodeLocationFilterParameter,
  isRejectedReceiveNamespace,
  trackNamespaceToStrings,
  type Location,
  type Parameter,
  type LocationFilter,
} from "../message";
import type { RangeFilterSpec } from "../message/parameter";
import {
  MalformedTrackError,
  RequestError,
  RequestErrorCode,
  SessionError,
  SessionErrorCode,
} from "../error";
import { ControlStreamReader, ControlStreamWriter, type ControlMessage } from "../controlStream";
import { PUBLISH_ALLOWED_PARAMS, validateParameterScope } from "../message/parameterScope";
import { type RequestUpdateOptions, SubscriberImpl } from "../subscriber";
import { fullTrackNameKey } from "../fullTrackName";
import { trackPropertyFiltersMatch } from "../filter";
import * as bidi from "./bidi";
import { incomingHandleFirstBidiMessage, incomingSendRequestErrorAndClose } from "./incoming";
import { REQUEST_UPDATE_STREAM_CLOSED_MESSAGE } from "./namespaceLoops";
import {
  isPeerStreamError,
  isSessionClosedError,
  toProtocolViolationSessionError,
  toSessionCloseError,
} from "./errors";
import { extractForwardState, extractLargestLocation, matchNamespacePrefix } from "./params";
import type { SessionInternal, TracksSubscriptionState } from "./types";
import { type AuthTokenProcessResult, processMessageAuthorizationTokens } from "./authTokenCache";
import type {
  ConnectCallbacks,
  SessionState,
  SubscribeCallbacks,
  TracksSubscriptionCallbacks,
} from "./publicTypes";
import type { PendingSubgroupBuffer } from "../pendingSubgroupBuffer";
import type { AuthTokenCache } from "./authTokenCache";

/**
 * 受信 PUBLISH 処理が必要とする SessionImpl のビュー
 *
 * SessionImpl は `as unknown as IncomingPublishSessionInternal` で渡す。
 */
export interface IncomingPublishSessionInternal {
  sessionState: SessionState;
  readonly transport: WebTransport;
  readonly callbacks: ConnectCallbacks;

  incomingBidiStreamReader?:
    | ReadableStreamDefaultReader<WebTransportBidirectionalStream>
    | undefined;
  readonly requestStreams: Map<
    bigint,
    {
      stream: WebTransportBidirectionalStream;
      writer: WritableStreamDefaultWriter<Uint8Array>;
      controlReader: ControlStreamReader;
      reader?: ReadableStreamDefaultReader<Uint8Array>;
    }
  >;
  readonly subscribers: Map<bigint, SubscriberImpl>;
  readonly subscribersByAlias: Map<bigint, SubscriberImpl[]>;
  readonly tracksSubscriptions: Map<bigint, TracksSubscriptionState>;
  readonly pendingSubgroupBuffer: PendingSubgroupBuffer;
  readonly receivedAuthTokens: AuthTokenCache;
  readonly receivedRequestUpdateCounts: Map<bigint, number>;
  readonly goawayReceivedOnRequestStreams: Set<bigint>;

  closeWithError(error: SessionError): void;
  notifyErrorIfActive(error: Error): void;
  emitDebug(
    direction: "send" | "recv",
    type: number,
    payload: Uint8Array,
    decoded?: Record<string, unknown>,
  ): void;
  onRequestDrained(): void;
  validateIncomingRequestId(requestId: bigint): SessionError | null;
}
export function incomingPublishStartBidiStreamLoop(session: IncomingPublishSessionInternal): void {
  void (async () => {
    const reader = session.transport.incomingBidirectionalStreams.getReader();
    session.incomingBidiStreamReader = reader;

    try {
      while (session.sessionState === "connected") {
        const { value: stream, done } = await reader.read();
        if (done) break;

        void incomingPublishHandleBidirectionalStream(session, stream);
      }
    } catch (err) {
      session.notifyErrorIfActive(err instanceof Error ? err : new Error(String(err)));
    } finally {
      reader.releaseLock();
    }
  })();
}

/**
 * PUBLISH ストリームの後続メッセージ読み取りサブループ
 *
 * `initialMessages` は最初の read より前に処理する。順序を逆にすると、連結された
 * PUBLISH_DONE の直後に届いた FIN が先に FIN_WITHOUT_PUBLISH_DONE_MESSAGE の
 * 分岐へ入る。
 *
 * @param initialMessages - 先頭チャンクに連結されていたメッセージ (無ければ空)
 */
export async function incomingPublishRunStreamSubLoop(
  session: IncomingPublishSessionInternal,
  impl: SubscriberImpl,
  publishRequestId: bigint,
  subReader: ReadableStreamDefaultReader<Uint8Array>,
  subControlReader: ControlStreamReader,
  initialMessages: ControlMessage[] = [],
): Promise<void> {
  // draft-ietf-moq-transport-21 §9.2:
  // GOAWAY 受信後も読み取りを継続して 2 通目以降の GOAWAY を検出するための
  // フラグ。GOAWAY 受信時は state 遷移を行わないため、catch での spurious
  // error 通知を抑止する判定に使う。
  let goawayReceived = false;

  /**
   * 1 チャンク分のメッセージ列を処理する
   *
   * draft-ietf-moq-transport-21 §9.1.7 (MAX_REQUEST_UPDATES):
   * このチャンクの先頭の未応答数を記録し、メッセージ列の処理を終えた時点で
   * 記録した値へ戻す (チャンク単位の減算。加算は受信 1 通ごとに
   * bidiHandlePublishRequestUpdate が行う)。1 通ごとに減算すると、応答の
   * 書き込みを await してから次のメッセージへ進む構造のため未応答数が
   * 常に 0 か 1 にしかならず、同じチャンクに含まれる N+1 通目を検出できない。
   *
   * @returns 読み取りを続けるなら true、終えるなら false
   */
  const processMessages = async (messages: ControlMessage[]): Promise<boolean> => {
    const requestUpdateCountBeforeChunk =
      session.receivedRequestUpdateCounts.get(publishRequestId) ?? 0;
    try {
      for (const msg of messages) {
        session.emitDebug("recv", msg.type, msg.payload);

        if (msg.type === MessageType.PUBLISH_DONE) {
          bidi.bidiHandlePublishDone(
            session as unknown as bidi.BidiSessionInternal,
            msg.payload,
            publishRequestId,
          );
          // draft-ietf-moq-transport-21 §6.4.2.2 / §9.9:
          // PUBLISH_DONE は publisher が方向を閉じる前の最終メッセージであり、受信後は
          // 将来の REQUEST_UPDATE に応答する必要が無い。送るものが無いため応答方向を
          // FIN で閉じる (SHOULD。await の扱いは closeRequestStreamWriter を参照)。
          // bidiHandlePublishDone が throw した場合はここへ到達しない (アプリの
          // コールバック例外の場合は catch 節が FIN を送る)。
          void bidi.closeRequestStreamWriter(
            session as unknown as bidi.BidiSessionInternal,
            publishRequestId,
          );
          continue;
        }
        if (msg.type === MessageType.PUBLISH_STATE_NOTIFY) {
          // draft-ietf-moq-transport-21 §9.10:
          // 受信 PUBLISH で確立した購読への publisher 発の状態通知を受理する。
          // 応答は送信しない。受信 PUBLISH 経路は subscriber 側のため
          // ロールは subscribe として扱う。閉鎖後は打ち切る。
          if (
            !bidi.bidiHandlePublishStateNotify(
              session as unknown as bidi.BidiSessionInternal,
              msg.payload,
              publishRequestId,
              "subscribe",
            )
          ) {
            return false;
          }
          if (session.sessionState !== "connected") {
            return false;
          }
          continue;
        }
        if (msg.type === MessageType.GOAWAY) {
          const goawayError = bidi.validateNoDuplicateGoawayOnRequestStream(
            publishRequestId,
            session.goawayReceivedOnRequestStreams,
          );
          if (goawayError !== null) {
            session.closeWithError(goawayError);
            return false;
          }
          const decodedMsg = decodeGoawayPayload(msg.payload);
          try {
            impl.goawayCallback?.(decodedMsg.newSessionUri);
          } catch {
            // アプリのコールバック例外はプロトコル違反ではないため黙殺する。
            // 黙殺しないと後続の pendingRequestUpdate 掃除や close() が
            // 実行されず、update() の Promise が未解決のまま残る。
          }
          goawayReceived = true;
          // draft-ietf-moq-transport-21 §9.2:
          // GOAWAY 受信時点で旧ストリーム上の未応答 REQUEST_UPDATE は失敗
          // として扱う (受信 PUBLISH の subscriber として送信済みの update()
          // の Promise を未解決のまま残さない)。GOAWAY 後の読み取り継続中に
          // REQUEST_OK / REQUEST_ERROR が届いても、エントリ削除済みのため
          // 二重解決しない。
          // 失敗が確定した更新の fill 関連付けも消す (確定済みの fill は残す)。
          bidi.deleteFillTargetsForPendingUpdates(
            session as unknown as bidi.BidiSessionInternal,
            publishRequestId,
          );
          bidi.rejectPendingRequestUpdates(
            session as unknown as bidi.BidiSessionInternal,
            publishRequestId,
            new RequestError(bidi.REQUEST_GOING_AWAY_REASON, RequestErrorCode.GOING_AWAY),
          );
          // GOAWAY 受信後も読み取りを継続して 2 通目以降の GOAWAY を検出する
          // (§9.2 MUST)。受信 PUBLISH の subscriber (impl) は送信方向を
          // FIN (writer.close()) で閉じ、受信方向は読み取りを継続する。
          await bidi.closeRequestStreamWriter(
            session as unknown as bidi.BidiSessionInternal,
            publishRequestId,
          );
          continue;
        }
        if (msg.type === MessageType.REQUEST_UPDATE) {
          // draft-ietf-moq-transport-21 §9.5 ケース 1:
          // 「The sender of a request (SUBSCRIBE, PUBLISH, FETCH,
          // PUBLISH_NAMESPACE, SUBSCRIBE_NAMESPACE, SUBSCRIBE_TRACKS) can
          // later send a REQUEST_UPDATE on the same bidi stream as the
          // request to modify it.」
          // 受信 PUBLISH の publisher (ピア) による REQUEST_UPDATE を処理し、
          // REQUEST_OK / REQUEST_ERROR を 1 通応答する (§9.5 MUST)。
          // GOAWAY 受信後 / ID 検証 / パラメータスコープ検証 /
          // 文脈限定パラメータの判定は free function 内で行う (GOING_AWAY
          // 応答も同関数の判定順序 (2) が担う)。スコープ違反等でセッションが
          // 閉じた場合は、同一チャンクの残りメッセージの処理を打ち切る。
          await bidi.bidiHandlePublishRequestUpdate(
            session as unknown as bidi.BidiSessionInternal,
            publishRequestId,
            msg.payload,
          );
          if (session.sessionState !== "connected") {
            return false;
          }
          continue;
        }
        if (msg.type === MessageType.REQUEST_OK) {
          bidi.bidiHandleRequestUpdateOk(
            session as unknown as bidi.BidiSessionInternal,
            msg.payload,
            publishRequestId,
          );
          // draft-ietf-moq-transport-21 §9.5:
          // bidiHandleRequestUpdateOk は REQUEST_UPDATE_OK のパラメータスコープ違反、
          // 未知の Mandatory Track Property、未応答の REQUEST_UPDATE が無い
          // REQUEST_OK の 3 箇所でセッションを閉じ得る。
          // 同一チャンクの残りメッセージを処理し続けると、後続メッセージが
          // 別のセッション終了を検出して error コールバックが二重に通知されるため、
          // 閉じた場合は読み取りループを終える
          // (PUBLISH_STATE_NOTIFY / REQUEST_UPDATE 分岐と同じ判定)。
          if (session.sessionState !== "connected") {
            return false;
          }
          continue;
        }
        if (msg.type === MessageType.REQUEST_ERROR) {
          const error = bidi.buildRequestErrorFromDecoded(decodeRequestErrorPayload(msg.payload));
          // draft-ietf-moq-transport-21 §9.5: coalescing により単一 REQUEST_ERROR で
          // 複数の REQUEST_UPDATE が失敗し得る。該当 pending をすべて reject する。
          // 失敗が確定した更新の fill 関連付けも消す (確定済みの fill は残す)。
          bidi.deleteFillTargetsForPendingUpdates(
            session as unknown as bidi.BidiSessionInternal,
            publishRequestId,
          );
          // §9.5.1: coalescing は失敗分をまとめるだけであり、in-flight だった
          // 成功分の更新への REQUEST_OK は別途届く。消した件数分を許容枠に積む。
          bidi.allowUnmatchedRequestOks(
            session as unknown as bidi.BidiSessionInternal,
            publishRequestId,
            bidi.rejectPendingRequestUpdates(
              session as unknown as bidi.BidiSessionInternal,
              publishRequestId,
              error,
            ),
          );
          continue;
        }
        // 未知のメッセージタイプは PROTOCOL_VIOLATION
        session.closeWithError(
          new SessionError(
            `unknown message type on publish stream: 0x${msg.type.toString(16)}`,
            SessionErrorCode.PROTOCOL_VIOLATION,
          ),
        );
        return false;
      }
    } finally {
      bidi.restoreIncomingRequestUpdateCount(
        session as unknown as bidi.BidiSessionInternal,
        publishRequestId,
        requestUpdateCountBeforeChunk,
      );
    }
    return true;
  };

  try {
    // 先頭の PUBLISH と同一チャンクに連結されていたメッセージを、最初の read より
    // 先に処理する (ControlStreamReader は取り出したメッセージをバッファから
    // 削除するため、ここで処理しないと復元できない)。ループ本体と同じく、
    // 購読が active の間だけ処理する (PUBLISH_OK の書き込み中に unsubscribe
    // された場合は処理しない)
    if (
      impl.state === "active" &&
      initialMessages.length > 0 &&
      !(await processMessages(initialMessages))
    ) {
      return;
    }

    while (impl.state === "active") {
      const { value, done } = await subReader.read();
      if (done) {
        // draft-ietf-moq-transport-21 §6.4.2.2:
        // ピアが FIN で方向を閉じた後は将来の REQUEST_UPDATE が到着し得ないため、
        // 送るものが無い応答方向も FIN で閉じる (SHOULD)。通知より先に呼び、
        // アプリのコールバックに FIN の発行を遅らせない。
        void bidi.closeRequestStreamWriter(
          session as unknown as bidi.BidiSessionInternal,
          publishRequestId,
        );
        // draft-ietf-moq-transport-21 §9.5.1:
        // 応答を待たずにストリームが閉じた場合は保留中の更新の失敗として、
        // アプリの update() の Promise を reject する (bidiReadRequestStreamMessages
        // の FIN ケースと同じ。GOAWAY 掃除と二重 reject にならないよう、
        // エントリ削除済みなら no-op になる)。reject はアプリの error
        // コールバック例外の影響を受けないよう、通知の前に置く。
        bidi.rejectPendingRequestUpdates(
          session as unknown as bidi.BidiSessionInternal,
          publishRequestId,
          new Error(REQUEST_UPDATE_STREAM_CLOSED_MESSAGE),
        );
        // draft-ietf-moq-transport-21 §6.4.2.2:
        // 受信 PUBLISH の subscriber (impl) が、ピア (publisher) の
        // PUBLISH_DONE を送らない FIN を受けた場合は失敗扱いであり、
        // subscriber に通知する (通知のガードは free function 内で行う)。
        bidi.notifySubscriberFailure(
          session as unknown as bidi.BidiSessionInternal,
          publishRequestId,
          new Error(bidi.FIN_WITHOUT_PUBLISH_DONE_MESSAGE),
        );
        return;
      }

      if (!(await processMessages(subControlReader.feed(value)))) {
        return;
      }
    }
  } catch (err) {
    // draft-ietf-moq-transport-21 §6.4.2.2:
    // 購読が終了済み (state が active でない) でセッションが生きている場合、応答方向に
    // 送るものは無く将来の REQUEST_UPDATE に応答する必要も無いため FIN で閉じる。
    // 主な経路は PUBLISH_DONE を処理する途中でアプリのコールバックが throw した場合で、
    // 購読は handleEnd の中で closed になるが (下の通知は active のときだけ行う)、
    // 応答方向を開いたまま残すと peer が request の完了を判定できない。GOAWAY 分岐と
    // 同じく、アプリのコールバック例外を理由に後始末を止めない。
    // ピアの RESET_STREAM、ピア起点のセッション終了、PROTOCOL_VIOLATION は、いずれも
    // catch の時点で state が active のためここへ入らない。sessionState の判定は、
    // transport.closed がストリームのエラーより先に処理される順序 (state も closed に
    // なる) への防御である。unsubscribe 経由は writer を abort 済みで requestStreams からも
    // 削除されており no-op になる。
    if (impl.state !== "active" && session.sessionState === "connected") {
      void bidi.closeRequestStreamWriter(
        session as unknown as bidi.BidiSessionInternal,
        publishRequestId,
      );
    }

    // draft-ietf-moq-transport-21 §9.2:
    // GOAWAY 受信後 (goawayReceived) は state が active のままのため、
    // spurious error 通知を抑止する (namespace ループと同様)
    if (impl.state === "active" && !goawayReceived) {
      const normalizedError = err instanceof Error ? err : new Error(String(err));
      // 応答待ちの更新は失敗として reject する (source を問わない。兄弟分岐・
      // namespace ループと同順。通知より先に実行することで、アプリの error
      // コールバックが throw しても reject が実行される。reject しないと
      // update() が永続ハングするため)。
      bidi.rejectPendingRequestUpdates(
        session as unknown as bidi.BidiSessionInternal,
        publishRequestId,
        new Error(REQUEST_UPDATE_STREAM_CLOSED_MESSAGE),
      );
      if (isSessionClosedError(normalizedError)) {
        // WebTransport セッション終了起因のエラーは購読者へ通知しないが、
        // state は closed にする (namespace ループと同規則。仕様はセッション
        // 終了時の購読単位の扱いを定めていないため、namespace ループと同じ
        // 実装上の判断として揃える。セッション終了は ConnectCallbacks.close
        // で検知されるが、request 単位の state を active に残す理由はない。
        // ConnectCallbacks.close と購読通知は別チャネルのため二重の失敗通知
        // にはならない)。
        impl.markClosed();
      } else if (isPeerStreamError(err)) {
        // draft-ietf-moq-transport-21 §6.4.2.3:
        // ピアの RESET_STREAM で readable がエラー終了した場合 (source: "stream") は、
        // subscribe ロール側と同じく error 通知 + state closed にする。仕様は
        // ピアの RESET_STREAM を受けた側のアプリへの通知内容も subscription state
        // の扱いも規定していない (§6.4.2.3 は RESET_STREAM / STOP_SENDING の手段と
        // rejection 時の応答を定めるのみ) ため、subscribe ロール側と同じ実装上の
        // 判断として揃える。
        // 通知と markClosed は notifySubscriberFailure の内部契約 (try/finally) に
        // 委ねるため、impl 直結の通知は行わない (二重通知になる)。
        // notifySubscriberFailure は subscribers から引くため、unsubscribe 済みで
        // エントリが削除された窓では通知しない (subscribe ロール側と同じ)。
        // 通知メッセージは subscribe ロール側と同一の組み立てを使う
        // (ピアのエラーコード付き、取得不可時は固定文言)。
        // draft-ietf-moq-transport-21 §6.4.2.2 / §9.5.1:
        // RESET_STREAM は FIN よりも強い終了であり、応答未達の REQUEST_UPDATE は
        // FIN 経路と同様に失敗として扱う (上記の先行 reject)。
        // 内側に try/catch が必要なのは、catch ブロック内で throw すると戻り値の
        // Promise が reject し、呼び出し元の requestStreams / subscribers の
        // クリーンアップがスキップされるためである。ここが守るのはこの通知経路
        // だけである (セッションレベルの error コールバック例外が伝播する経路は
        // 別途対応)。
        try {
          bidi.notifySubscriberFailure(
            session as unknown as bidi.BidiSessionInternal,
            publishRequestId,
            bidi.createResetStreamError(err),
          );
        } catch {
          // アプリの error コールバック例外は吸収する (markClosed は
          // notifySubscriberFailure 内の finally で実行済み)。
        }
      } else {
        // source を持たない内部例外は、namespace ループと同規則で error 通知
        // + state closed にする (従来は通知のみで state が active のまま残った。
        // 仕様は内部エラー時の購読単位の扱いを定めていないため、namespace
        // ループと同じ実装上の判断として揃える)。
        // 通知と markClosed は stream 分岐と同じく notifySubscriberFailure の
        // 内部契約に委ねる (応答待ちの更新は上記で先行 reject 済み)。
        try {
          bidi.notifySubscriberFailure(
            session as unknown as bidi.BidiSessionInternal,
            publishRequestId,
            normalizedError,
          );
        } catch {
          // アプリの error コールバック例外は吸収する (markClosed は
          // notifySubscriberFailure 内の finally で実行済み)。
        }
      }
    }
    // SessionError はそのコードのまま、ProtocolViolationError / IncompleteDataError は PROTOCOL_VIOLATION で閉じる
    const sessionError = toSessionCloseError(err);
    if (sessionError !== null) {
      session.closeWithError(sessionError);
    }
  }
}

/**
 * 受信 PUBLISH の AUTHORIZATION TOKEN パラメータを処理する
 *
 * draft-ietf-moq-transport-21 §9.20.3 / §8.9:
 * §8.9 の MUST により REGISTER はメッセージが他の理由 (UNINTERESTED 等) で
 * 失敗しても登録を維持するため、購読マッチング判定より前に処理する。
 * デコード不能 (KEY_VALUE_FORMATTING_ERROR)・登録済み Alias の再 REGISTER
 * (DUPLICATE_AUTH_TOKEN_ALIAS)・上限超過 (AUTH_TOKEN_CACHE_OVERFLOW) は
 * セッションを閉じる。
 *
 * 未登録 Alias の参照も Session Termination の UNKNOWN_AUTH_TOKEN_ALIAS (0x17) で
 * セッションを閉じる。REQUEST_ERROR ではなく Session Termination を選ぶ理由、
 * §6.6 の留保の判断、§9.1.4 の MUST NOT に抵触しないことは
 * `processIncomingRequestUpdateAuthorizationTokens` の JSDoc に集約している
 * (同じ規範判断をこのファイルと bidi.ts で二重に保守しないため)。
 *
 * §9.5.1 の PUBLISH_DONE (UPDATE_FAILED) は REQUEST_UPDATE に対する publisher の
 * MUST であり、受信 PUBLISH の拒否には適用しない。
 *
 * @returns 処理を継続してよい場合は true、セッション終了または当該 PUBLISH の
 *   打ち切りで中断すべき場合は false
 */
export function incomingPublishProcessAuthorizationTokens(
  session: IncomingPublishSessionInternal,
  requestId: bigint,
  parameters: Array<{ type: number; value: Uint8Array }>,
): boolean {
  let result: AuthTokenProcessResult;
  try {
    result = processMessageAuthorizationTokens(session.receivedAuthTokens, parameters);
  } catch (err) {
    // SessionError はそのコードのままセッションを閉じる。§8.9 が定める
    // DUPLICATE_AUTH_TOKEN_ALIAS / AUTH_TOKEN_CACHE_OVERFLOW /
    // KEY_VALUE_FORMATTING_ERROR がここに来る。
    const sessionError = toSessionCloseError(err);
    if (sessionError === null) {
      // SessionError 以外の例外はセッション終了を意味しない。本メソッドは
      // fire-and-forget で呼ばれる handleIncomingBidirectionalStream の
      // 「throw しない」契約の下にあるため再 throw せず、当該 PUBLISH の
      // 処理だけを打ち切る。processMessageAuthorizationTokens は
      // SessionError しか投げないため、この分岐は防御的である。
      return false;
    }
    session.closeWithError(sessionError);
    return false;
  }
  if (result.status === "unknown-alias") {
    session.closeWithError(
      new SessionError(
        `unknown authorization token alias in PUBLISH: streamRequestId=${requestId} alias=${result.tokenAlias}`,
        SessionErrorCode.UNKNOWN_AUTH_TOKEN_ALIAS,
      ),
    );
    return false;
  }
  return true;
}

/**
 * セッションが connected でなければ受信 bidi ストリームを cancel する
 *
 * 接続確立前に届いた受信ストリームは処理せず、読み取りを打ち切る。
 *
 * @param stream - 受信した双方向ストリーム
 * @returns cancel した (呼び出し側は即 return すべき) なら true
 */
export async function incomingPublishCancelIfNotConnected(
  session: IncomingPublishSessionInternal,
  stream: WebTransportBidirectionalStream,
): Promise<boolean> {
  if (session.sessionState === "connected") {
    return false;
  }
  try {
    await stream.readable.cancel();
  } catch {
    /* ignore */
  }
  return true;
}

export async function incomingPublishHandleBidirectionalStream(
  session: IncomingPublishSessionInternal,
  stream: WebTransportBidirectionalStream,
): Promise<void> {
  if (await incomingPublishCancelIfNotConnected(session, stream)) {
    return;
  }
  // 先頭読み取りに使う reader をサブループと共有する (PUBLISH 以外のメッセージ
  // だった場合はこのまま破棄される)
  const subControlReader = new ControlStreamReader();
  const firstBidiMessage = await incomingPublishReadFirstBidiMessage(
    session,
    stream,
    subControlReader,
  );
  if (firstBidiMessage === null) return;
  const firstMsg = firstBidiMessage.firstMessage;

  // 先頭メッセージを 3 分類して処理する
  // draft-ietf-moq-transport-21 §6.3 (Session initialization):
  // 先頭が 7 種以外のメッセージタイプの場合は PROTOCOL_VIOLATION でセッションを閉じる。
  // 7 種のうち未対応のリクエストには NOT_SUPPORTED を応答する (§1.5 SHOULD)。
  // true が返れば先頭メッセージの処理が完了しているため return する。
  if (
    await incomingHandleFirstBidiMessage(session as unknown as SessionInternal, stream, firstMsg)
  ) {
    return;
  }

  // PUBLISH ペイロードをデコード
  // draft-ietf-moq-transport-21 §9.8
  let decodedPublish: ReturnType<typeof decodePublishPayload>;
  try {
    decodedPublish = decodePublishPayload(firstMsg.payload);
  } catch (err) {
    // draft-ietf-moq-transport-21 §3.6:
    // 未知の Mandatory Track Property を含む PUBLISH には
    // REQUEST_ERROR(UNSUPPORTED_EXTENSION) を返す
    if (err instanceof MalformedTrackError) {
      await incomingSendRequestErrorAndClose(
        stream,
        RequestErrorCode.UNSUPPORTED_EXTENSION,
        err.message,
      );
      return;
    }
    // SessionError はそのコードのまま、ProtocolViolationError / IncompleteDataError は PROTOCOL_VIOLATION で閉じる
    const sessionError = toSessionCloseError(err);
    if (sessionError !== null) {
      session.closeWithError(sessionError);
    }
    return;
  }

  const publishRequestId = decodedPublish.requestId;
  const publishTrackAlias = decodedPublish.trackAlias;
  const publishTrackNamespace = trackNamespaceToStrings(decodedPublish.trackNamespace);
  const publishTrackName = new TextDecoder().decode(decodedPublish.trackName);

  session.emitDebug("recv", MessageType.PUBLISH, firstMsg.payload, {
    requestId: publishRequestId.toString(),
    trackAlias: publishTrackAlias.toString(),
    trackNamespace: publishTrackNamespace,
    trackName: publishTrackName,
  });

  // draft-ietf-moq-transport-21 §6.4.2.1 (Request ID):
  // 受信 PUBLISH の Request ID のパリティ (奇数) と重複を検証する。
  // 違反時は INVALID_REQUEST_ID でセッションを閉じる。
  const requestIdError = session.validateIncomingRequestId(publishRequestId);
  if (requestIdError !== null) {
    session.closeWithError(requestIdError);
    return;
  }

  // draft-ietf-moq-transport-21 §9.20.3 / §8.9:
  // PUBLISH の AUTHORIZATION TOKEN パラメータを処理する。§8.9 の MUST は
  // 「セッションエラーにならない限り REGISTER した Alias をキャッシュへ登録する」
  // であるため、セッションエラーにならない拒否 (予約 namespace による
  // DOES_NOT_EXIST 応答等) より前に処理する。
  if (
    !incomingPublishProcessAuthorizationTokens(session, publishRequestId, decodedPublish.parameters)
  ) {
    return;
  }

  // draft-ietf-moq-transport-21 §2.4.2 / §6.5:
  // 受信 PUBLISH の Track Namespace 先頭フィールドが "." 単体または
  // ".session" の場合、REQUEST_ERROR (DOES_NOT_EXIST) で拒否してアプリへ
  // 渡さない (§2.4.2 / §6.5 の MUST)。それ以外の予約名前空間
  // (例: ".foo") は §2.4.2 によりアプリへ渡す。
  // 拒否時は §6.4.2.3 の SHOULD に従い REQUEST_ERROR 送信後に送信方向を
  // FIN で閉じ、受信方向を cancel する。パラメータスコープ検証より
  // 先に判定し、両方違反の場合は DOES_NOT_EXIST 拒否を優先する。
  // なお、デコード失敗 (MalformedTrackError 等) はデコード時に先に
  // 検出されるため、この判定に到達するのはデコード成功時のみ。
  if (isRejectedReceiveNamespace(decodedPublish.trackNamespace.tuple)) {
    await incomingSendRequestErrorAndClose(
      stream,
      RequestErrorCode.DOES_NOT_EXIST,
      "request references reserved namespace",
    );
    return;
  }

  // draft-ietf-moq-transport-21 §9.20.1 (Parameter Scope):
  // PUBLISH に許可されていないパラメータは PROTOCOL_VIOLATION
  const scopeError = validateParameterScope(
    decodedPublish.parameters,
    PUBLISH_ALLOWED_PARAMS,
    "PUBLISH",
  );
  if (scopeError !== null) {
    session.closeWithError(scopeError);
    return;
  }

  // trackNamespace がアクティブな tracksSubscriptions の namespacePrefix に前方一致するか検証
  const match = incomingPublishMatchToSubscription(session, publishTrackNamespace);
  if (match === null) {
    // draft-ietf-moq-transport-21 §9.8 (SHOULD): マッチしない PUBLISH は UNINTERESTED
    await incomingSendRequestErrorAndClose(stream, RequestErrorCode.UNINTERESTED, "uninterested");
    return;
  }

  // draft-ietf-moq-transport-21 §3.1.2 (Track Alias):
  // 同一 Track Alias が異なる Track に使われている場合は DUPLICATE_TRACK_ALIAS でセッション終了。
  // 同一 Track への複数 PUBLISH は draft-21 §3.1 で許可される。
  // TRACK_PROPERTY_FILTER 評価より先に検証する (フィルタ不通過で UNINTERESTED 応答すると
  // alias 重複というセッション違反が検出されず隠れるため)。
  const existingSubscribers = session.subscribersByAlias.get(publishTrackAlias);
  if (existingSubscribers !== undefined && existingSubscribers.length > 0) {
    // 比較キーは SubscriberImpl.getFullTrackNameKey と同じ生成規則
    // (fullTrackNameKey) に揃える。受信 PUBLISH 側だけ別形式で組み立てると
    // 同一 Track への複数 PUBLISH が不一致になり、DUPLICATE_TRACK_ALIAS で
    // 誤ってセッションを閉じる。
    const trackKey = fullTrackNameKey(publishTrackNamespace, publishTrackName);
    const firstSubscriber = existingSubscribers[0];
    if (firstSubscriber === undefined) {
      // 上の existingSubscribers.length > 0 により到達しない (型を絞るためのガード)
      throw new SessionError(
        `track alias 0x${publishTrackAlias.toString(16)} has no subscriber entry`,
        SessionErrorCode.DUPLICATE_TRACK_ALIAS,
      );
    }
    if (firstSubscriber.getFullTrackNameKey() !== trackKey) {
      session.closeWithError(
        new SessionError(
          `track alias 0x${publishTrackAlias.toString(16)} used for different tracks`,
          SessionErrorCode.DUPLICATE_TRACK_ALIAS,
        ),
      );
      return;
    }
  }

  // draft-ietf-moq-transport-21 §3.3.2:
  // TRACK_PROPERTY_FILTER の評価 (受信 PUBLISH の Track Properties に対する検索)。
  // 通過しない PUBLISH は onPublish を呼ばず、§9.8 の SHOULD に従い
  // REQUEST_ERROR (UNINTERESTED) で応答してストリームの読み取りを放棄する。
  if (
    match.rangeFilters !== undefined &&
    !trackPropertyFiltersMatch(match.rangeFilters, decodedPublish.trackProperties)
  ) {
    await incomingSendRequestErrorAndClose(stream, RequestErrorCode.UNINTERESTED, "uninterested");
    return;
  }

  // onPublish コールバックから SubscribeCallbacks を取得
  let subscribeCallbacks: SubscribeCallbacks;
  try {
    const result = match.callbacks.onPublish?.(match.suffix, publishTrackName);
    if (result === undefined) {
      subscribeCallbacks = { object: () => {} };
    } else {
      const resolved = await result;
      subscribeCallbacks = resolved ?? { object: () => {} };
    }
  } catch {
    // アプリケーションのエラーはプロトコル違反ではない
    try {
      await stream.readable.cancel();
    } catch {
      /* ignore */
    }
    return;
  }

  // SubscriberImpl を生成して登録
  const impl = new SubscriberImpl(
    publishTrackNamespace,
    publishTrackName,
    publishRequestId,
    publishTrackAlias,
    subscribeCallbacks.object,
    subscribeCallbacks.datagram,
    subscribeCallbacks.end,
    subscribeCallbacks.error,
  );
  impl.goawayCallback = subscribeCallbacks.goaway;
  impl.fillErrorCallback = subscribeCallbacks.fillError;

  // draft-ietf-moq-transport-21 §10.4:
  // 受信 PUBLISH の Track Properties から DEFAULT_PUBLISHER_PRIORITY を解決し、
  // Priority 省略時の Subgroup / Datagram に継承させる
  impl.setTrackProperties(decodedPublish.trackProperties);

  // 受信 PUBLISH の初期パラメータを反映する。違反時はセッションを閉じ false を返す。
  if (!incomingPublishApplyParameters(session, impl, decodedPublish.parameters)) {
    return;
  }

  // draft-ietf-moq-transport-21 §3.3.2:
  // SUBSCRIBE_TRACKS 由来のオブジェクトレベル Range Filter (0x25-0x28) を
  // SubscriberImpl に設定し、handleObject / handleDatagram で評価する。
  // TRACK_PROPERTY_FILTER (0x29) は track 単位の評価として既に通過しており、
  // オブジェクト受信経路では評価しないため除外する。
  if (match.rangeFilters !== undefined) {
    const objectLevelFilters = match.rangeFilters.filter(
      (spec) => !("remove" in spec) && spec.type !== "trackProperty",
    );
    impl.setRangeFilters(objectLevelFilters);
  }

  let subReader: ReadableStreamDefaultReader<Uint8Array>;
  let subWriter: WritableStreamDefaultWriter<Uint8Array>;
  try {
    subReader = stream.readable.getReader();
    subWriter = stream.writable.getWriter();
  } catch {
    // ストリームのロックが取得できない場合
    impl.markClosed();
    return;
  }

  session.subscribers.set(publishRequestId, impl);
  const aliasList = session.subscribersByAlias.get(publishTrackAlias);
  if (aliasList !== undefined) {
    aliasList.push(impl);
  } else {
    session.subscribersByAlias.set(publishTrackAlias, [impl]);
  }
  session.requestStreams.set(publishRequestId, {
    stream,
    writer: subWriter,
    controlReader: subControlReader,
    // 読み取りループ (runPublishStreamSubLoop) が保持する reader を登録し、
    // 解除 (unsubscribe) 時に保持者経由で cancel できるようにする。
    reader: subReader,
  });

  impl.onUnsubscribe = () => {
    return bidi.bidiCancelSubscription(session as unknown as bidi.BidiSessionInternal, impl);
  };
  impl.onUpdate = (options: RequestUpdateOptions) => {
    return bidi.bidiSendRequestUpdate(
      session as unknown as bidi.BidiSessionInternal,
      impl,
      options,
    );
  };

  session.pendingSubgroupBuffer.notifyAlias(publishTrackAlias, "subscriber");

  // PUBLISH_OK を送信 (draft-ietf-moq-transport-21 §3.1 MUST) して
  // 後続メッセージのサブループを回す。
  // 登録以後の一連の処理は try/finally で守り、PUBLISH_OK 書き込み失敗・
  // サブループ脱出のいずれの exit 経路でも後始末 (3 マップの削除 + fill
  // 関連付けの掃除 + ロック解放) を必ず行う。通知は Map 削除より前に行う
  // (notifySubscriberFailure は subscribers.get で対象を引くため)。
  // 本関数は throw しない (fire-and-forget 呼び出しのため。
  // runPublishStreamSubLoop の catch と同形)。
  try {
    const publishOkPayload = encodeRequestOkPayload({
      type: MessageType.REQUEST_OK,
      parameters: [],
      trackProperties: [],
    });
    const controlWriter = new ControlStreamWriter();
    const framed = controlWriter.encode(MessageType.REQUEST_OK, publishOkPayload);
    await subWriter.write(framed);

    // 後続メッセージのサブループ
    await incomingPublishRunStreamSubLoop(
      session,
      impl,
      publishRequestId,
      subReader,
      subControlReader,
      firstBidiMessage.remainingMessages,
    );
  } catch (error) {
    // PUBLISH_OK 書き込み失敗時は失敗として扱う (§3.1 MUST の PUBLISH_OK を
    // 送れていないため subscription を残さない)。いずれの source でも
    // markClosed し、通知の有無は source で分ける。
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    if (error instanceof Error && isSessionClosedError(error)) {
      // source が "session" の場合: 通知せず state closed とする
      // (runPublishStreamSubLoop のセッション終了起因と同方針)
      impl.markClosed();
    } else {
      // source が "stream" または source なしの場合:
      // error 通知 + state closed とする。ピア起因 (source: "stream") の
      // 場合は subloop 内の RESET 経路と同じ正規化文言で通知する。
      // createResetStreamError は非 Error も吸収するため条件は source のみでよい。
      const notifyError = isPeerStreamError(error)
        ? bidi.createResetStreamError(error)
        : normalizedError;
      try {
        bidi.notifySubscriberFailure(
          session as unknown as bidi.BidiSessionInternal,
          publishRequestId,
          notifyError,
        );
      } catch {
        // アプリの error コールバック例外は吸収する (markClosed は
        // notifySubscriberFailure 内の finally で実行済み)。
      }
    }
  } finally {
    incomingPublishCleanupIncomingPublish(
      session,
      publishRequestId,
      publishTrackAlias,
      impl,
      subReader,
      subWriter,
    );
  }
}

/**
 * 受信 PUBLISH の後始末を行う
 *
 * subscribers / subscribersByAlias / requestStreams の削除と fill 関連付けの
 * 掃除、ストリームのロック解放を、exit 経路に依らず必ず実行する。
 *
 * @param publishRequestId - 受信 PUBLISH の Request ID (3 マップの削除キー)
 * @param publishTrackAlias - 受信 PUBLISH の Track Alias (alias 側の特定削除用)
 * @param impl - 生成した SubscriberImpl (alias 側の特定要素削除用)
 * @param subReader - 受信ストリームの reader (ロック解放用)
 * @param subWriter - 応答ストリームの writer (ロック解放用)
 */
export function incomingPublishCleanupIncomingPublish(
  session: IncomingPublishSessionInternal,
  publishRequestId: bigint,
  publishTrackAlias: bigint,
  impl: SubscriberImpl,
  subReader: ReadableStreamDefaultReader<Uint8Array>,
  subWriter: WritableStreamDefaultWriter<Uint8Array>,
): void {
  session.requestStreams.delete(publishRequestId);
  session.subscribers.delete(publishRequestId);
  // draft-ietf-moq-transport-21 §9.1.7:
  // ストリーム終了時にストリーム単位の未応答 REQUEST_UPDATE 数を破棄する。
  // 残すと、以後に同じ Request ID のストリームが張られた場合 (および
  // 同一ストリームの残りメッセージ) に古い件数で超過と誤判定する。
  session.receivedRequestUpdateCounts.delete(publishRequestId);
  // 購読の終了に伴い fill 関連付けも不要になるため掃除する。
  bidi.deleteFillTargetsForSubscriber(session as unknown as bidi.BidiSessionInternal, impl);
  // requestId 単位で削除し、alias に他 subscription が無ければエントリ削除
  const aliasSubscribers = session.subscribersByAlias.get(publishTrackAlias);
  if (aliasSubscribers !== undefined) {
    const idx = aliasSubscribers.indexOf(impl);
    if (idx !== -1) {
      aliasSubscribers.splice(idx, 1);
    }
    if (aliasSubscribers.length === 0) {
      session.subscribersByAlias.delete(publishTrackAlias);
    }
  }
  subReader.releaseLock();
  try {
    subWriter.releaseLock();
  } catch {
    /* ignore */
  }
  // draft-ietf-moq-transport-21 §6.6.1:
  // GOAWAY 受信後に受信 PUBLISH の購読が無くなった時点で NO_ERROR で閉じる。
  session.onRequestDrained();
}

/**
 * 受信 PUBLISH の初期パラメータを購読に反映する
 *
 * draft-ietf-moq-transport-21 §9.8 (PUBLISH) / §9.20.19:
 * FORWARD (省略時はデフォルト 1) を Forward State として保持する。
 * 値域外は PROTOCOL_VIOLATION でセッションを閉じる。
 * OBJECT_DELIVERY_TIMEOUT / SUBGROUP_DELIVERY_TIMEOUT /
 * SUBSCRIBER_PRIORITY / GROUP_ORDER は publisher の初期値の通知であり
 * 受理のみで状態反映はしない。この関数では再検証しない
 * (FORWARD / GROUP_ORDER の uint8 値域は decode 時に検証済み。
 * varint 系 timeouts / PRIORITY は範囲外で閉じる規定がないため検証しない)。
 * draft-ietf-moq-transport-21 §9.8 / §9.20.10 / §9.18.1:
 * LOCATION_FILTER は購読の初期フィルタとして反映する
 * (省略時は既定値 = 無制限)。End Group 超過は PROTOCOL_VIOLATION で閉じる。
 * draft-ietf-moq-transport-21 §9.20.18 / §3.3.1:
 * LARGEST_OBJECT は LOCATION_FILTER より先に設定する。相対 Location Filter は
 * 「フィルタ適用時点の LARGEST_OBJECT」で解決されるため、この順序で
 * 受信 PUBLISH が運ぶ LARGEST_OBJECT 基準の開始位置に一度だけ確定する。
 * 反映前にすべての値をデコード・検証し、検証通過後にまとめて設定する
 * (違反確定後の部分反映を防ぐ)。
 *
 * @returns 反映できた場合は true、違反でセッションを閉じた場合は false
 */
export function incomingPublishApplyParameters(
  session: IncomingPublishSessionInternal,
  impl: SubscriberImpl,
  parameters: Parameter[],
): boolean {
  let forwardState: boolean;
  try {
    forwardState = extractForwardState(parameters);
  } catch (error) {
    const sessionError = toProtocolViolationSessionError(error);
    if (sessionError !== null) {
      session.closeWithError(sessionError);
      return false;
    }
    throw error;
  }

  let largestLocation: Location | undefined;
  try {
    largestLocation = extractLargestLocation(parameters);
  } catch (error) {
    const sessionError = toProtocolViolationSessionError(error);
    if (sessionError !== null) {
      session.closeWithError(sessionError);
      return false;
    }
    throw error;
  }

  const locationParam = parameters.find(
    (param) => param.type === MessageParameterType.LOCATION_FILTER,
  );
  let locationFilter: LocationFilter | undefined;
  if (locationParam !== undefined) {
    try {
      locationFilter = decodeLocationFilterParameter(locationParam);
    } catch (error) {
      const sessionError = toProtocolViolationSessionError(error);
      if (sessionError !== null) {
        session.closeWithError(sessionError);
        return false;
      }
      throw error;
    }
  }

  impl.setForwardState(forwardState);
  // LARGEST_OBJECT を先に設定し、setLocationFilter 内の解決に反映させる
  if (largestLocation !== undefined) {
    impl.setLargestLocation(largestLocation);
  }
  if (locationFilter !== undefined) {
    impl.setLocationFilter(locationFilter);
  }
  return true;
}

/**
 * PUBLISH の trackNamespace をアクティブな tracksSubscriptions にマッチさせる
 *
 * @returns マッチした subscription の callbacks と suffix、マッチしなければ null
 */
export function incomingPublishMatchToSubscription(
  session: IncomingPublishSessionInternal,
  publishTrackNamespace: string[],
): {
  callbacks: TracksSubscriptionCallbacks;
  suffix: string[];
  rangeFilters?: RangeFilterSpec[];
} | null {
  for (const [, subscription] of session.tracksSubscriptions) {
    if (subscription.state !== "active") {
      continue;
    }
    const suffix = matchNamespacePrefix(publishTrackNamespace, subscription.namespacePrefix);
    if (suffix !== null) {
      // exactOptionalPropertyTypes では optional な rangeFilters に undefined を渡せないため、
      // 値がある場合だけ載せる
      const matched = { callbacks: subscription.callbacks, suffix };
      return subscription.rangeFilters === undefined
        ? matched
        : { ...matched, rangeFilters: subscription.rangeFilters };
    }
  }
  return null;
}

/**
 * 受信 bidi ストリームの先頭読み取りの結果
 *
 * 先頭メッセージと、それと同一チャンクに連結されていた残りメッセージを持つ。
 */
export interface IncomingPublishFirstBidiMessage {
  firstMessage: ControlMessage;
  remainingMessages: ControlMessage[];
}

/**
 * 受信 bidi ストリームの先頭メッセージと、同一チャンクに連結されていた残りを読み取る
 *
 * `ControlStreamReader` は取り出したメッセージをバッファから削除するため、
 * 先頭読み取りに使う reader は呼び出し側が用意してサブループへ引き継ぐ。
 * reader を作り直すと、最初の read で生じた半端なバイト (メッセージの途中で
 * チャンクが切れた分) を復元できない。
 *
 * @param controlReader - 先頭読み取りに使う reader (サブループと共有する)
 * @returns 先頭メッセージと、同一チャンクに連結されていた残りメッセージ。
 *   FIN 検出時・読み取り失敗時は null
 */
export async function incomingPublishReadFirstBidiMessage(
  session: IncomingPublishSessionInternal,
  stream: WebTransportBidirectionalStream,
  controlReader: ControlStreamReader,
): Promise<IncomingPublishFirstBidiMessage | null> {
  try {
    const firstMsgReader = stream.readable.getReader();
    try {
      while (true) {
        const { value, done } = await firstMsgReader.read();
        if (done) return null;
        const messages = controlReader.feed(value);
        if (messages.length > 0) {
          const [firstMessage, ...remainingMessages] = messages;
          if (firstMessage === undefined) {
            // 上の messages.length > 0 により到達しない (型を絞るためのガード)
            return null;
          }
          return { firstMessage, remainingMessages };
        }
      }
    } finally {
      firstMsgReader.releaseLock();
    }
  } catch (err) {
    session.notifyErrorIfActive(err instanceof Error ? err : new Error(String(err)));
    return null;
  }
}
