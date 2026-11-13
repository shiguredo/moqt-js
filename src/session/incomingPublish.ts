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
 * draft-ietf-moq-transport-23 §3.6 (Subscribing to Tracks by Prefix) のとおり、購読側が
 * PUBLISH を新規双方向ストリームで受信し、REQUEST_UPDATE の応答
 * (REQUEST_OK / REQUEST_ERROR) と PUBLISH_DONE を同じストリームで受信する
 * 経路をまとめる。受信データストリームは dataStreamIncoming.ts が担当する。
 */

import {
  MessageType,
  MessageParameterType,
  decodePublishPayload,
  decodeRequestErrorPayload,
  decodeTrackNamespace,
  encodeRequestOkPayload,
  decodeLocationFilterParameter,
  isRejectedReceiveNamespace,
  trackNamespaceToStrings,
  type Location,
  type Parameter,
  type LocationFilter,
} from "../message";
import { decodeFillParameters, decodeParameters, type RangeFilterSpec } from "../message/parameter";
import { MalformedTrackError, RequestErrorCode, SessionError, SessionErrorCode } from "../error";
import { ControlStreamReader, ControlStreamWriter, type ControlMessage } from "../controlStream";
import { decodeVarint } from "../varint";
import { assertLengthWithinData } from "../length";
import { PUBLISH_ALLOWED_PARAMS, validateParameterScope } from "../message/parameterScope";
import { type RequestUpdateOptions, SubscriberImpl } from "../subscriber";
import { fullTrackNameKey, type FullTrackNameKey } from "../fullTrackName";
import { trackPropertyFiltersMatch } from "../filter";
import * as bidi from "./bidi";
import {
  incomingHandleFirstBidiMessage,
  incomingSendRequestErrorAndClose,
  incomingSettlePublishFillWaiters,
} from "./incoming";
import { REQUEST_UPDATE_STREAM_CLOSED_MESSAGE } from "./namespaceLoops";
import {
  isPeerStreamError,
  isSessionClosedError,
  toProtocolViolationSessionError,
  toSessionCloseError,
} from "./errors";
import { sessionHandleFieldLengthExceeded } from "./lifecycle";
import {
  extractLargestLocation,
  extractPaused,
  matchNamespacePrefix,
  resolveFillGroupOrderFromParameters,
} from "./params";
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
  /** PUBLISH 初期 fill の受信先 (PUBLISH の Request ID をキーとする) */
  readonly fillFetchTargets: Map<bigint, bidi.FillFetchTarget>;
  /** 処理中の受信 PUBLISH の Request ID */
  readonly publishingRequestIds: Set<bigint>;
  readonly pendingSubgroupBuffer: PendingSubgroupBuffer;
  readonly receivedAuthTokens: AuthTokenCache;
  readonly receivedRequestUpdateCounts: Map<bigint, number>;
  /**
   * 自 endpoint が SETUP で広告した MAX_CONTROL_MESSAGE_SIZE
   * (draft-ietf-moq-transport-23 §9.1.8)。受信 PUBLISH ストリームの受信上限に使う。
   */
  readonly localMaxControlMessageSize: number;
  /**
   * ピアが SETUP で広告した MAX_CONTROL_MESSAGE_SIZE
   * (draft-ietf-moq-transport-23 §9.1.8)。受信 PUBLISH ストリームの送信上限に使う。
   */
  readonly peerMaxControlMessageSize: number;

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
  /**
   * 1 チャンク分のメッセージ列を処理する
   *
   * draft-ietf-moq-transport-23 §9.1.7 (MAX_REQUEST_UPDATES):
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
          // draft-ietf-moq-transport-23 §6.4.2.2 / §9.9:
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
          // draft-ietf-moq-transport-23 §9.10:
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
          // draft-ietf-moq-transport-23 §9.2:
          // "Only the receiver of a request can send GOAWAY on its request stream.
          //  If the receiver of a request receives a GOAWAY on that request stream,
          //  it MUST close the session with a PROTOCOL_VIOLATION."
          // 受信 PUBLISH では自側が要求 (PUBLISH) の受信者であり、publisher /
          // subscriber やクライアント / サーバーの区別ではなく「元の要求の送信者か
          // 受信者か」で判定する。このストリームへの GOAWAY は移行要求として受理せず、
          // 移行 callback も呼ばず、送信方向の FIN / pending 更新の reject も行わずに
          // セッションを閉じる (重複 GOAWAY の検出より先に方向違反が確定する)。
          session.closeWithError(
            new SessionError(
              "received goaway on a request stream where this endpoint is the request receiver",
              SessionErrorCode.PROTOCOL_VIOLATION,
            ),
          );
          return false;
        }
        if (msg.type === MessageType.REQUEST_UPDATE) {
          // draft-ietf-moq-transport-23 §9.5 ケース 1:
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
          // draft-ietf-moq-transport-23 §9.3: REQUEST_UPDATE_OK の Track Properties は
          // 空が必須であり、未知 Mandatory Track Property を含む場合は
          // INVALID_FIELD でセッションを閉じる。MalformedTrackError を
          // Session エラーへ変換する共通経路を使う。
          bidi.handleRequestUpdateOkMessage(
            session as unknown as bidi.BidiSessionInternal,
            msg.payload,
            publishRequestId,
          );
          // draft-ietf-moq-transport-23 §9.5:
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
          // draft-ietf-moq-transport-23 §9.5: coalescing により単一 REQUEST_ERROR で
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
        // 未知のメッセージタイプは UNEXPECTED_MESSAGE (§9 / §12.2)
        session.closeWithError(
          new SessionError(
            `unknown message type on publish stream: 0x${msg.type.toString(16)}`,
            SessionErrorCode.UNEXPECTED_MESSAGE,
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
        // draft-ietf-moq-transport-23 §6.4.2.2:
        // ピアが FIN で方向を閉じた後は将来の REQUEST_UPDATE が到着し得ないため、
        // 送るものが無い応答方向も FIN で閉じる (SHOULD)。通知より先に呼び、
        // アプリのコールバックに FIN の発行を遅らせない。
        void bidi.closeRequestStreamWriter(
          session as unknown as bidi.BidiSessionInternal,
          publishRequestId,
        );
        // draft-ietf-moq-transport-23 §9.5.1:
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
        // draft-ietf-moq-transport-23 §6.4.2.2:
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
    // draft-ietf-moq-transport-23 §6.4.2.2:
    // 購読が終了済み (state が active でない) でセッションが生きている場合、応答方向に
    // 送るものは無く将来の REQUEST_UPDATE に応答する必要も無いため FIN で閉じる。
    // 主な経路は PUBLISH_DONE を処理する途中でアプリのコールバックが throw した場合で、
    // 購読は handleEnd の中で closed になるが (下の通知は active のときだけ行う)、
    // 応答方向を開いたまま残すと peer が request の完了を判定できない。GOAWAY 分岐と
    // 同じく、アプリのコールバック例外を理由に後始末を止めない。
    // ピアの RESET_STREAM、ピア起点のセッション終了、セッションエラーは、いずれも
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

    if (impl.state === "active") {
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
        // draft-ietf-moq-transport-23 §6.4.2.3:
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
        // draft-ietf-moq-transport-23 §6.4.2.2 / §9.5.1:
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
    // draft-ietf-moq-transport-23 §9:
    // FIELD_LENGTH_EXCEEDED は共通ヘルパーで 1 回だけ閉じる (既に閉じていれば何もしない)。
    // それ以外の SessionError はそのコードのまま、ProtocolViolationError は
    // 自身の code、IncompleteDataError は MALFORMED_MESSAGE で閉じる。
    const handledFieldLengthExceeded = sessionHandleFieldLengthExceeded(
      session,
      (sessionError) => {
        session.closeWithError(sessionError);
      },
      err,
    );
    if (!handledFieldLengthExceeded) {
      const sessionError = toSessionCloseError(err);
      if (sessionError !== null) {
        session.closeWithError(sessionError);
      }
    }
  }
}

/**
 * 受信 PUBLISH の AUTHORIZATION TOKEN パラメータを処理する
 *
 * draft-ietf-moq-transport-23 §9.19.2 / §8.9:
 * §8.9 の MUST により REGISTER はメッセージが他の理由 (UNINTERESTED 等) で
 * 失敗しても登録を維持するため、購読マッチング判定より前に処理する。
 * デコード不能 (MALFORMED_KEY_VALUE)・登録済み Alias の再 REGISTER
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
    // MALFORMED_KEY_VALUE がここに来る。
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

/**
 * 応答コードを伴わない要求の取消し
 *
 * draft-ietf-moq-transport-23 §6.4.2.3 (Request Cancellation and Rejection):
 * 受信側は要求に応答しないことを選べる。この場合は送信方向を RESET_STREAM、
 * 受信方向を STOP_SENDING で abruptly 終了する (WebTransport API では
 * writable.abort() / readable.cancel() が対応する)。
 *
 * PUBLISH への応答には、未知 Mandatory Track Property 以外の malformed track を
 * 表せる Error Code が無い (§12.3)。そのため UNSUPPORTED_EXTENSION に置き換えず、
 * 要求の取消しとして扱う。
 */
async function incomingPublishCancelRequestStream(
  stream: WebTransportBidirectionalStream,
): Promise<void> {
  try {
    await stream.readable.cancel("malformed PUBLISH request");
  } catch {
    // 既に閉じているストリームの操作失敗は無視する
  }
  try {
    await stream.writable.abort("malformed PUBLISH request");
  } catch {
    // 既に閉じているストリームの操作失敗は無視する
  }
}

/**
 * PUBLISH ペイロードの Parameters までを読み出す
 *
 * draft-ietf-moq-transport-23 §9.8: PUBLISH は Request ID / Track Namespace /
 * Track Name / Track Alias / Parameters / Track Properties の順に並ぶ。
 * Track Properties の意味検証が失敗しても Parameters は復元できるため、
 * §8.9 の AUTHORIZATION TOKEN の REGISTER をセッションエラーにならない拒否でも
 * キャッシュへ登録するために使う。
 *
 * @returns Parameters。Parameters までの構造が壊れている場合は undefined
 */
function incomingPublishPeekParameters(payload: Uint8Array): Parameter[] | undefined {
  try {
    const [, requestIdLength] = decodeVarint(payload, 0);
    const [, namespaceLength] = decodeTrackNamespace(payload, requestIdLength);
    let offset = requestIdLength + namespaceLength;
    const [nameLength, nameLengthConsumed] = decodeVarint(payload, offset);
    offset += nameLengthConsumed;
    assertLengthWithinData("publish track name", nameLength, offset, payload.length);
    offset += Number(nameLength);
    const [, trackAliasLength] = decodeVarint(payload, offset);
    offset += trackAliasLength;
    const [parameters] = decodeParameters(payload, offset);
    return parameters;
  } catch {
    return undefined;
  }
}

/**
 * PUBLISH ペイロードの先頭から Full Track Name を復元する
 *
 * PUBLISH の先頭は Request ID / Track Namespace / Track Name の順に並ぶため、
 * 後続の Parameters や Track Properties の検証が失敗しても Track を特定できる。
 * malformed track の検出時に同じ Track の購読 / FETCH を cancel するために使う。
 *
 * @returns Track の比較キー。先頭が不完全な場合は undefined
 */
function incomingPublishPeekTrackKey(payload: Uint8Array): FullTrackNameKey | undefined {
  try {
    const [, requestIdLength] = decodeVarint(payload, 0);
    const [trackNamespace, namespaceLength] = decodeTrackNamespace(payload, requestIdLength);
    const nameOffset = requestIdLength + namespaceLength;
    const [nameLength, nameLengthConsumed] = decodeVarint(payload, nameOffset);
    const nameStart = nameOffset + nameLengthConsumed;
    const trackName = new TextDecoder().decode(
      payload.slice(nameStart, nameStart + Number(nameLength)),
    );
    return fullTrackNameKey(trackNamespaceToStrings(trackNamespace), trackName);
  } catch {
    return undefined;
  }
}

/**
 * PUBLISH ペイロードの先頭から Request ID だけを読む
 *
 * PUBLISH の先頭フィールドは Request ID (vi64) であり、デコード全体が失敗しても
 * 先頭が揃っていれば復元できる。初期 fill の待機者を失敗させるために使う。
 *
 * @returns Request ID。先頭が不完全な場合は undefined
 */
function incomingPublishPeekRequestId(payload: Uint8Array): bigint | undefined {
  try {
    const [requestId] = decodeVarint(payload, 0);
    return requestId;
  } catch {
    return undefined;
  }
}

/**
 * 受信 PUBLISH のペイロードをデコードし、失敗時の拒否・取消しまで行う
 *
 * draft-ietf-moq-transport-23 §3.7 / §9.4.2.2:
 * 未知の Mandatory Track Property を含む PUBLISH には
 * REQUEST_ERROR(UNSUPPORTED_EXTENSION) を返し、理解できなかった各 Type を
 * UNSUPPORTED_PROPERTY Error Detail に載せる (SHOULD)。Type 一覧は
 * MalformedTrackError の構造情報から取り出し、理由文字列は解析しない。
 *
 * 未知 Mandatory Track Property 以外の理由で malformed になった PUBLISH は、
 * UNSUPPORTED_PROPERTY を載せられず、PUBLISH への応答に使えるエラーコードも無い。
 * 既知 KVP の不整合を UNSUPPORTED_EXTENSION に置き換えず、要求の取消しとして
 * 送受信の方向を abruptly 終了する (§6.4.2.3 / §12.1)。
 *
 * デコードに失敗した場合は §12.2 の分類に従ってセッションを閉じるか要求を
 * 取り消し、初期 fill の待機者を解放する。malformed track の場合は同じ
 * Full Track Name の既存購読 / FETCH も cancel する (§12.1)。
 *
 * @returns デコードに成功した PUBLISH。拒否・取消しを行った場合は null
 */
async function incomingPublishDecodeOrReject(
  session: IncomingPublishSessionInternal,
  stream: WebTransportBidirectionalStream,
  payload: Uint8Array,
): Promise<ReturnType<typeof decodePublishPayload> | null> {
  try {
    return decodePublishPayload(payload);
  } catch (err) {
    if (err instanceof MalformedTrackError && err.unsupportedPropertyTypes.length > 0) {
      // draft-ietf-moq-transport-23 §8.5: Reason Phrase の長さには上限があり、
      // 上限超過は受信側が FIELD_LENGTH_EXCEEDED でセッションを閉じる。
      // 未対応 Type の一覧は Reason に埋めず UNSUPPORTED_PROPERTY Detail だけに
      // 載せ、Reason は固定の短い文言にする (1 件でも 1024 バイトを超えない)。
      // draft-ietf-moq-transport-23 §8.9: REGISTER した Alias は、メッセージが
      // セッションエラー以外の理由で失敗してもキャッシュへ登録する MUST。
      // 未知 Mandatory Track Property による拒否でも Parameters からトークンを
      // 処理する。malformed Token 構造の検出もこの経路で行う。
      const earlyParameters = incomingPublishPeekParameters(payload);
      if (earlyParameters !== undefined) {
        incomingPublishProcessAuthorizationTokens(
          session,
          incomingPublishPeekRequestId(payload) ?? 0n,
          earlyParameters,
        );
        if (session.sessionState !== "connected") {
          return null;
        }
      }
      await incomingSendRequestErrorAndClose(
        stream,
        RequestErrorCode.UNSUPPORTED_EXTENSION,
        "unsupported mandatory track properties",
        session.peerMaxControlMessageSize,
        { unsupportedPropertyTypes: err.unsupportedPropertyTypes },
      );
      return null;
    }
    // SessionError はそのコードのまま、ProtocolViolationError は自身の code、
    // IncompleteDataError は MALFORMED_MESSAGE で閉じる
    const sessionError = toSessionCloseError(err);
    if (sessionError !== null) {
      session.closeWithError(sessionError);
      return null;
    }
    if (err instanceof MalformedTrackError) {
      // draft-ietf-moq-transport-23 §8.9:
      // "The receiver of a message carrying an Authorization Token with Alias
      //  Type REGISTER that does not result in a Session error MUST register
      //  the Token Alias in the token cache, even if the message fails for
      //  other reasons, including Unauthorized."
      // Track Properties の意味検証で拒否する場合も、Parameters が
      // 復元できれば AUTHORIZATION TOKEN を処理してから取り消す。
      const earlyParameters = incomingPublishPeekParameters(payload);
      if (earlyParameters !== undefined) {
        incomingPublishProcessAuthorizationTokens(
          session,
          incomingPublishPeekRequestId(payload) ?? 0n,
          earlyParameters,
        );
        if (session.sessionState !== "connected") {
          return null;
        }
      }
      await incomingPublishCancelRequestStream(stream);
      // draft-ietf-moq-transport-23 §12.1 (Malformed Tracks):
      // 同じ Full Track Name の既存購読 / FETCH も cancel する MUST。
      // デコードは失敗しているが、先頭の Track Namespace / Track Name は
      // 復元できるため、そこから Track を特定する。
      const trackKey = incomingPublishPeekTrackKey(payload);
      if (trackKey !== undefined) {
        bidi.cancelMalformedTrackPeers(
          session as unknown as Parameters<typeof bidi.cancelMalformedTrackPeers>[0],
          trackKey,
          err,
        );
      }
    }
    return null;
  }
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
  const subControlReader = new ControlStreamReader(session.localMaxControlMessageSize);
  const firstBidiMessage = await incomingPublishReadFirstBidiMessage(
    session,
    stream,
    subControlReader,
  );
  if (firstBidiMessage === null) return;
  const firstMsg = firstBidiMessage.firstMessage;

  // 先頭メッセージを 3 分類して処理する
  // draft-ietf-moq-transport-23 §6.3 (Session initialization):
  // 先頭が 7 種以外のメッセージタイプの場合は UNEXPECTED_MESSAGE でセッションを閉じる。
  // 7 種のうち未対応のリクエストには NOT_SUPPORTED を応答する (§1.6 (Modularity) SHOULD)。
  // true が返れば先頭メッセージの処理が完了しているため return する。
  if (
    await incomingHandleFirstBidiMessage(session as unknown as SessionInternal, stream, firstMsg)
  ) {
    return;
  }

  // PUBLISH ペイロードのデコードと検証 (失敗時は拒否・取消しまで済ませて null)
  const validated = await incomingPublishDecodeAndValidate(session, stream, firstMsg.payload);
  if (validated === null) {
    return;
  }
  const {
    decodedPublish,
    publishRequestId,
    publishTrackAlias,
    publishTrackNamespace,
    publishTrackName,
    fill,
    settleFillWaiters,
  } = validated;

  // trackNamespace が PUBLISH の指定先 (SUBSCRIBE_TRACKS_ID) または興味のある
  // active な tracksSubscriptions に一致するか検証する
  // (draft-ietf-moq-transport-23 §3.6 / §9.19.21)
  const match = incomingPublishMatchToSubscription(
    session,
    publishTrackNamespace,
    decodedPublish.parameters,
  );
  if (match === null) {
    // draft-ietf-moq-transport-23 §9.8 (SHOULD): マッチしない PUBLISH は UNINTERESTED
    await incomingSendRequestErrorAndClose(
      stream,
      RequestErrorCode.UNINTERESTED,
      "uninterested",
      session.peerMaxControlMessageSize,
    );
    settleFillWaiters();
    return;
  }

  // draft-ietf-moq-transport-23 §3.1.3 (Track Alias):
  // 同一 Track Alias が異なる Track に使われている場合は DUPLICATE_TRACK_ALIAS でセッション終了。
  // 同一 Track への複数 PUBLISH は draft-ietf-moq-transport-23 §3.1 で許可される。
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
      settleFillWaiters();
      return;
    }
  }

  // draft-ietf-moq-transport-23 §3.3.2:
  // TRACK_PROPERTY_FILTER の評価 (受信 PUBLISH の Track Properties に対する検索)。
  // 通過しない PUBLISH は onPublish を呼ばず、§9.8 の SHOULD に従い
  // REQUEST_ERROR (UNINTERESTED) で応答してストリームの読み取りを放棄する。
  if (
    await incomingPublishRejectByTrackPropertyFilter(
      session,
      stream,
      match,
      decodedPublish.trackProperties,
    )
  ) {
    settleFillWaiters();
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
    settleFillWaiters();
    return;
  }

  // draft-ietf-moq-transport-23 §3.6 / §9.19.21:
  // onPublish の await 中に元の SUBSCRIBE_TRACKS が取消し・prefix 更新・
  // フィルタ変更されることがある。callback の返した設定を使って Subscriber を
  // 登録する前に、指定先要求が現在も active で、現在の prefix と
  // TRACK_PROPERTY_FILTER に一致することを再確認する。不一致なら callback の
  // 設定は使わず、通常の興味なし経路 (UNINTERESTED + FIN + 受信方向 cancel) へ進む
  // (Subscriber / Alias / request stream を残さない)。
  const revalidatedMatch = incomingPublishMatchToSubscription(
    session,
    publishTrackNamespace,
    decodedPublish.parameters,
  );
  if (
    await incomingPublishRejectIfMatchInvalidated(
      session,
      stream,
      revalidatedMatch,
      match,
      decodedPublish.trackProperties,
    )
  ) {
    settleFillWaiters();
    return;
  }
  if (revalidatedMatch === null) {
    // 上の helper が false を返した時点で non-null だが、型を絞るための防御
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
  impl.setSessionCallbacks(subscribeCallbacks);

  // draft-ietf-moq-transport-23 §3.6.2 は、SUBSCRIBE_TRACKS の AUTHORIZATION_TOKEN を
  // 「SUBSCRIBE_TRACKS 自体に適用される」ものとし、PUBLISH から始まる購読の初期
  // パラメータとしては扱わない (「The publisher uses the others as the initial
  // Subscription parameters」の "others" に含めていない)。
  // 一方 draft-ietf-moq-msf-01 §11.4.3 は、track に関連するトークンを、その Track に
  // 関係し AUTHORIZATION TOKEN パラメータを受け付けるすべての制御メッセージへ
  // MUST 付与すると定める。REQUEST_UPDATE もその対象である。
  // 両者は読みが分かれるため、認可で拒否されない安全側を取り、SUBSCRIBE_TRACKS
  // 送信時のトークンを購読に引き継ぐ。値は requestsTokenForRequestUpdate で
  // REQUEST_UPDATE 用に正規化済み (REGISTER 済みの Alias は USE_ALIAS) であり、
  // ここで再変換しない。PUBLISH が運ぶトークンは publisher 側の値であり、
  // subscriber が REQUEST_UPDATE に載せる値ではない。
  impl.setAuthorizationToken(match.subscription.authorizationToken);

  // draft-ietf-moq-transport-23 §10.4:
  // 受信 PUBLISH の Track Properties から DEFAULT_PUBLISHER_PRIORITY を解決し、
  // Priority 省略時の Subgroup / Datagram に継承させる
  impl.setTrackProperties(decodedPublish.trackProperties);

  // draft-ietf-moq-transport-23 §9.19.8 (GROUP ORDER Parameter):
  // PUBLISH の GROUP_ORDER はこの購読の GROUP_ORDER である。後続の
  // REQUEST_UPDATE が運ぶ fill は、FILL_PARAMETERS 内で上書きされない限り
  // この値を継承する (§9.19.15)。省略時は Track Properties の
  // DEFAULT_PUBLISHER_GROUP_ORDER を使う (§10.5)。
  impl.setGroupOrder(incomingPublishExtractGroupOrder(decodedPublish.parameters));

  // 受信 PUBLISH の初期パラメータを反映する。違反時はセッションを閉じ false を返す。
  if (!incomingPublishApplyParameters(session, impl, decodedPublish.parameters)) {
    settleFillWaiters();
    return;
  }

  // draft-ietf-moq-transport-23 §3.3.2:
  // SUBSCRIBE_TRACKS 由来のオブジェクトレベル Range Filter (0x25-0x28) を
  // SubscriberImpl に設定し、handleObject / handleDatagram で評価する。
  // TRACK_PROPERTY_FILTER (0x29) は track 単位の評価として既に通過しており、
  // オブジェクト受信経路では評価しないため除外する。
  // 最終確認後の現在の購読 (revalidatedMatch) のフィルタを使う。
  if (revalidatedMatch.rangeFilters !== undefined) {
    const objectLevelFilters = revalidatedMatch.rangeFilters.filter(
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
    settleFillWaiters();
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

  // draft-ietf-moq-transport-23 §3.4 / §3.4.1:
  // FILL_PARAMETERS が載り、subscriber が paused でない PUBLISH は初期 fill fetch
  // ストリームを開く。FETCH_HEADER は PUBLISH の Request ID を運ぶため、その ID で
  // 受信先を登録して待機中の fill stream を起こす。fill 内側の GROUP_ORDER が
  // 無ければ PUBLISH の GROUP_ORDER (購読の初期値)、PUBLISH の GROUP_ORDER も
  // 無ければ Track Properties の DEFAULT_PUBLISHER_GROUP_ORDER を継承する。
  // paused / FILL_PARAMETERS 無しでは登録せず、待機者を失敗させる。
  // 登録は PUBLISH_OK の write より前に置く。待機側 (waitForPublishFillTarget) は
  // 登録を待って再検索するため取りこぼしは無いが、write を待つ間 (既定の待機上限は
  // PUBLISH_FILL_WAIT_TIMEOUT_MS) に関連付けを遅らせないためである。
  incomingPublishRegisterFillTarget(session, publishRequestId, impl, fill, validated.paused);
  settleFillWaiters();

  // PUBLISH_OK を送信 (draft-ietf-moq-transport-23 §3.1 MUST) して
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
    const controlWriter = new ControlStreamWriter(session.peerMaxControlMessageSize);
    const framed = controlWriter.encode(MessageType.REQUEST_OK, publishOkPayload);
    await subWriter.write(framed);

    // draft-ietf-moq-transport-23 §3.1 (Subscriptions):
    // "A subscriber MUST send exactly one PUBLISH_OK (Section 9.3) or PUBLISH_ERROR
    //  in response to a PUBLISH."
    // PUBLISH_OK を送ってはじめて購読は Established になり、§9.5 の
    // REQUEST_UPDATE (a subscription established with PUBLISH) と
    // §3.6.2 の "in a REQUEST_UPDATE following PUBLISH_OK" が使えるようになる。
    // アプリへ購読ハンドルを渡すのはこの後にする。購読が確立する前に
    // update() / unsubscribe() を呼べる状態で渡すと、ピアから見れば PUBLISH_OK の
    // 前の REQUEST_UPDATE になり、§9.5 の 2 ケース外として UNEXPECTED_MESSAGE で
    // セッションを閉じる余地が残る。
    // また unsubscribe() は writer を abort するため、write より前に呼ばれると
    // §3.1 MUST の PUBLISH_OK を送れないまま購読が消える。
    incomingPublishNotifyEstablished(session, impl, match, publishTrackName, subscribeCallbacks);

    // 保留していた Subgroup ストリームを解放する。§3.1.3.1 の "buffer it briefly"
    // の待ちを解く。確立通知より後ろに置くのは、保留 Object の配送を確立通知より
    // 後に始めるためである (送信の待ちの間に FIN で合流した分は先に届き得る)。
    // この位置へ移したことで、write の完了後にサブループが同一チャンクの
    // PUBLISH_DONE を処理する場合は、保留 Object の合流より先に end が購読を閉じ、
    // 保留 Object が配送されずに捨てられる。§9.8 は PUBLISH_OK の前に Object が
    // 届き得ると定めるため、購読の終了後に届いた Object を捨てるのは許容する。
    session.pendingSubgroupBuffer.notifyAlias(publishTrackAlias, "subscriber");

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
 * TRACK_PROPERTY_FILTER の不通過を UNINTERESTED で拒否する
 *
 * draft-ietf-moq-transport-23 §3.6.1 / §9.8: 受信 PUBLISH の Track Properties が
 * 指定フィルタに合致しない場合は onPublish を呼ばず、REQUEST_ERROR
 * (UNINTERESTED) で応答して受信方向を cancel する。
 *
 * @returns 拒否した場合は true (呼び出し側は return する)
 */
async function incomingPublishRejectByTrackPropertyFilter(
  session: IncomingPublishSessionInternal,
  stream: WebTransportBidirectionalStream,
  match: IncomingPublishSubscriptionMatch,
  trackProperties: ReturnType<typeof decodePublishPayload>["trackProperties"],
): Promise<boolean> {
  if (
    match.rangeFilters === undefined ||
    trackPropertyFiltersMatch(match.rangeFilters, trackProperties)
  ) {
    return false;
  }
  await incomingSendRequestErrorAndClose(
    stream,
    RequestErrorCode.UNINTERESTED,
    "uninterested",
    session.peerMaxControlMessageSize,
  );
  return true;
}

/**
 * onPublish 待機後の再検証で不一致になった PUBLISH を UNINTERESTED で拒否する
 *
 * draft-ietf-moq-transport-23 §3.6 / §9.19.21:
 * 待機中に元の要求が取消・prefix 更新・フィルタ変更された場合は、callback の
 * 設定を使わず通常の興味なし経路へ進む (Subscriber を残さない)。
 *
 * @returns 拒否した場合は true (呼び出し側は return する)
 */
async function incomingPublishRejectIfMatchInvalidated(
  session: IncomingPublishSessionInternal,
  stream: WebTransportBidirectionalStream,
  revalidatedMatch: IncomingPublishSubscriptionMatch | null,
  match: IncomingPublishSubscriptionMatch,
  trackProperties: ReturnType<typeof decodePublishPayload>["trackProperties"],
): Promise<boolean> {
  const stillMatches =
    revalidatedMatch !== null &&
    revalidatedMatch.subscription === match.subscription &&
    (revalidatedMatch.rangeFilters === undefined ||
      trackPropertyFiltersMatch(revalidatedMatch.rangeFilters, trackProperties));
  if (stillMatches) {
    return false;
  }
  await incomingSendRequestErrorAndClose(
    stream,
    RequestErrorCode.UNINTERESTED,
    "uninterested",
    session.peerMaxControlMessageSize,
  );
  return true;
}

/** 受信 PUBLISH のデコードと検証結果 */
interface IncomingPublishValidated {
  decodedPublish: ReturnType<typeof decodePublishPayload>;
  publishRequestId: bigint;
  publishTrackAlias: bigint;
  publishTrackNamespace: string[];
  publishTrackName: string;
  fill: IncomingPublishFill | undefined;
  paused: boolean;
  settleFillWaiters: () => void;
}

/**
 * 受信 PUBLISH のペイロードをデコードして検証する
 *
 * draft-ietf-moq-transport-23 §6.4.2.1 / §8.9 / §2.4.3 / §6.5 / §9.19.1 /
 * §3.4: デコード、Request ID 検証、認証トークン処理、予約 namespace 拒否、
 * パラメータスコープ検証、FILL_PARAMETERS の解析と paused 解決を行う。
 * 拒否・セッション終了の経路では、初期 fill の待機者を失敗させる。
 *
 * @returns 検証済みの情報。拒否・セッション終了で処理を打ち切る場合は null
 */
async function incomingPublishDecodeAndValidate(
  session: IncomingPublishSessionInternal,
  stream: WebTransportBidirectionalStream,
  payload: Uint8Array,
): Promise<IncomingPublishValidated | null> {
  // draft-ietf-moq-transport-23 §3.4.1: PUBLISH が拒否された場合、同じ Request ID の
  // 初期 fill 待機者を失敗させる必要がある。デコードが失敗すると Request ID を
  // 復元できないため、先頭の Request ID だけを先に読む (失敗時は従来どおり
  // デコード経路でセッションを閉じる)。
  const earlyRequestId = incomingPublishPeekRequestId(payload);

  // draft-ietf-moq-transport-23 §6.4.2.1 (Request ID):
  // 受信 PUBLISH の Request ID のパリティ (奇数) と重複は、Track Properties の
  // 検証 (未知 Mandatory / scope / 重複) より先に検証する。両方に違反する
  // PUBLISH で INVALID_REQUEST_ID が失われ、ID が重複検出から漏れるのを防ぐ。
  if (earlyRequestId !== undefined) {
    const earlyRequestIdError = session.validateIncomingRequestId(earlyRequestId);
    if (earlyRequestIdError !== null) {
      session.closeWithError(earlyRequestIdError);
      return null;
    }
    // draft-ietf-moq-transport-23 §3.4.1: 同一 Request ID の初期 fill fetch が
    // 先着しても「未処理の PUBLISH」として待機できるよう、検証直後の同一同期
    // ブロックで処理中として登録する。await を挟むと、その間に届いた
    // FETCH_HEADER が「受信済みかつ処理中でない」と誤判定して待機せず cancel される。
    session.publishingRequestIds.add(earlyRequestId);
  }

  // PUBLISH ペイロードをデコードする。失敗時は拒否・取消しまで済ませて null を返す
  const decodedPublish = await incomingPublishDecodeOrReject(session, stream, payload);
  if (decodedPublish === null) {
    if (earlyRequestId !== undefined) {
      incomingSettlePublishFillWaiters(session as unknown as SessionInternal, earlyRequestId);
    }
    return null;
  }

  const publishRequestId = decodedPublish.requestId;
  const publishTrackAlias = decodedPublish.trackAlias;
  const publishTrackNamespace = trackNamespaceToStrings(decodedPublish.trackNamespace);
  const publishTrackName = new TextDecoder().decode(decodedPublish.trackName);

  session.emitDebug("recv", MessageType.PUBLISH, payload, {
    requestId: publishRequestId.toString(),
    trackAlias: publishTrackAlias.toString(),
    trackNamespace: publishTrackNamespace,
    trackName: publishTrackName,
  });

  // Request ID の検証はデコード前に済ませている (上の earlyRequestId)。
  // ここで再度呼ぶと受信済み ID の二重登録になるため行わない。

  // draft-ietf-moq-transport-23 §3.4.1: PUBLISH の受理・拒否が確定するまで、
  // 同じ Request ID の初期 fill fetch ストリームを待機させる。処理中フラグは
  // Request ID 検証直後に立てている (上の earlyRequestId)。
  const settlePublishFillWaiters = (): void => {
    incomingSettlePublishFillWaiters(session as unknown as SessionInternal, publishRequestId);
  };

  // draft-ietf-moq-transport-23 §9.19.2 / §8.9:
  // PUBLISH の AUTHORIZATION TOKEN パラメータを処理する。§8.9 の MUST は
  // 「セッションエラーにならない限り REGISTER した Alias をキャッシュへ登録する」
  // であるため、セッションエラーにならない拒否 (予約 namespace による
  // DOES_NOT_EXIST 応答等) より前に処理する。
  if (
    !incomingPublishProcessAuthorizationTokens(session, publishRequestId, decodedPublish.parameters)
  ) {
    return null;
  }

  // draft-ietf-moq-transport-23 §2.4.3 / §6.5:
  // 受信 PUBLISH の Track Namespace 先頭フィールドが "." 単体または
  // ".session" の場合、REQUEST_ERROR (DOES_NOT_EXIST) で拒否してアプリへ
  // 渡さない (§2.4.3 / §6.5 の MUST)。それ以外の予約名前空間
  // (例: ".foo") は §2.4.3 によりアプリへ渡す。
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
      session.peerMaxControlMessageSize,
    );
    settlePublishFillWaiters();
    return null;
  }

  // draft-ietf-moq-transport-23 §9.19.1 (Parameter Scope):
  // PUBLISH に許可されていないパラメータは INVALID_PARAMETER
  const scopeError = validateParameterScope(
    decodedPublish.parameters,
    PUBLISH_ALLOWED_PARAMS,
    "PUBLISH",
  );
  if (scopeError !== null) {
    session.closeWithError(scopeError);
    settlePublishFillWaiters();
    return null;
  }

  // draft-ietf-moq-transport-23 §3.4 / §9.19.15:
  // PUBLISH の FILL_PARAMETERS は初期 fill fetch を要求する。解析と
  // paused の解決は helper にまとめ、違反時は INVALID_PARAMETER で閉じる。
  const fillResolution = incomingPublishResolveFillParameters(
    session,
    decodedPublish.parameters,
    settlePublishFillWaiters,
  );
  if (fillResolution === null) {
    return null;
  }
  const fill = fillResolution.fill;

  return {
    decodedPublish,
    publishRequestId,
    publishTrackAlias,
    publishTrackNamespace,
    publishTrackName,
    fill,
    paused: fillResolution.paused,
    settleFillWaiters: settlePublishFillWaiters,
  };
}

/** PUBLISH の FILL_PARAMETERS の解析結果 */
interface IncomingPublishFill {
  parameter: Parameter;
  innerParameters: Parameter[];
}

/**
 * 受信 PUBLISH の FILL_PARAMETERS を解析する
 *
 * draft-ietf-moq-transport-23 §9.19.15:
 * 内側の Parameter は decode 時に Table 7 / 重複を検証済みだが、Range Filter の
 * 組合せや remove 指定などの意味検証を decodeFillParameters で行う。違反は
 * INVALID_PARAMETER としてセッションを閉じる。
 *
 * @param settleWaiters - セッションを閉じる前に fill 待機者を失敗させる処理
 * @returns fill の解析結果と paused 状態。違反でセッションを閉じた場合は null
 */
function incomingPublishResolveFillParameters(
  session: IncomingPublishSessionInternal,
  parameters: Parameter[],
  settleWaiters: () => void,
): { fill: IncomingPublishFill | undefined; paused: boolean } | null {
  // draft-ietf-moq-transport-23 §3.4.1: paused 中の PUBLISH は fill fetch を開かない
  const paused = extractPaused(parameters);
  const parameter = parameters.find(
    (candidate) => candidate.type === MessageParameterType.FILL_PARAMETERS,
  );
  if (parameter === undefined) {
    return { fill: undefined, paused };
  }
  try {
    return { fill: { parameter, innerParameters: decodeFillParameters(parameter) }, paused };
  } catch (error) {
    const sessionError =
      toSessionCloseError(error) ??
      new SessionError(
        `invalid FILL_PARAMETERS in PUBLISH: ${error instanceof Error ? error.message : String(error)}`,
        SessionErrorCode.INVALID_PARAMETER,
      );
    session.closeWithError(sessionError);
    settleWaiters();
    return null;
  }
}

/**
 * PUBLISH の初期 fill の受信先を登録する
 *
 * draft-ietf-moq-transport-23 §3.4 / §3.4.1 / §9.19.8 / §9.19.15 / §10.5:
 * FILL_PARAMETERS が載り、subscriber が paused でない PUBLISH は初期 fill fetch
 * ストリームを開く。FETCH_HEADER は PUBLISH の Request ID を運ぶため、その ID で
 * 受信先を登録する。Group Order は FILL_PARAMETERS 内側、PUBLISH の GROUP_ORDER、
 * Track Properties の DEFAULT_PUBLISHER_GROUP_ORDER、Ascending の順で解決する。
 * PUBLISH の GROUP_ORDER と Track Properties は購読に既に反映済みのため、
 * ここで SubscriberImpl から読む。paused / FILL_PARAMETERS 無しでは登録しない。
 */
function incomingPublishRegisterFillTarget(
  session: IncomingPublishSessionInternal,
  publishRequestId: bigint,
  impl: SubscriberImpl,
  fill: IncomingPublishFill | undefined,
  paused: boolean,
): void {
  if (fill === undefined || paused) {
    return;
  }
  session.fillFetchTargets.set(publishRequestId, {
    subscriber: impl,
    groupOrder: resolveFillGroupOrderFromParameters(
      fill.innerParameters,
      impl.getGroupOrder(),
      impl.trackProperties,
    ),
  });
}

/**
 * 受信 PUBLISH の GROUP_ORDER (uint8) を解決する
 *
 * draft-ietf-moq-transport-23 §9.19.8:
 * 値域 (0x01 / 0x02) は decode 時に検証済みであるため、ここでは解釈だけ行う。
 *
 * @returns Ascending / Descending。省略時は undefined
 */
function incomingPublishExtractGroupOrder(
  parameters: Parameter[],
): "Ascending" | "Descending" | undefined {
  const parameter = parameters.find(
    (candidate) => candidate.type === MessageParameterType.GROUP_ORDER,
  );
  if (parameter === undefined) {
    return undefined;
  }
  return parameter.value[0] === 0x02 ? "Descending" : "Ascending";
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
  // 購読の終了で初期 fill の受信先も不要になる (§3.4.1: 購読の取消し時は
  // publisher が fill fetch ストリームを reset する)。
  bidi.deleteFillFetchTarget(session, publishRequestId);
  session.publishingRequestIds.delete(publishRequestId);
  // draft-ietf-moq-transport-23 §9.1.7:
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
  // draft-ietf-moq-transport-23 §3.1.3 (Unknown Track Alias) / §3.1.3.1:
  // "Objects can arrive after a subscription has been cancelled. Subscribers
  //  SHOULD retain sufficient state to quickly discard these unwanted Objects,
  //  rather than treating them as belonging to an unknown Track Alias."
  // 購読を alias 索引から外した後に保留エントリを起こす。PUBLISH_OK の write に
  // 失敗した場合、この購読の保留 Subgroup は notifyAlias が呼ばれないまま残る。
  // そのままにすると、同じ alias を再利用した別 Track の PUBLISH が確立した際の
  // notifyAlias でこのエントリが合流し、旧 Track の Object を新しい購読へ
  // 配送してしまう。ここで起こせば、alias に購読が残っていなければ abandon 経路で
  // 破棄され、残っていれば (同一 alias の別購読) 正しく合流する。
  // 正常終了経路では既に notifyAlias 済みで、PendingSubgroupEntry.notify は
  // 冪等 (最初の resolve のみ反映) なため no-op になる。
  session.pendingSubgroupBuffer.notifyAlias(publishTrackAlias, "subscriber");
  subReader.releaseLock();
  try {
    subWriter.releaseLock();
  } catch {
    /* ignore */
  }
  // draft-ietf-moq-transport-23 §12.1:
  // この Track の購読と FETCH が尽きたら Track 単位の追跡状態を解放する。
  // 正常終了経路でも解放しないと、上限 1024 Track を圧迫して活動中 Track の
  // 検出漏れを招く。
  bidi.clearPriorGapTrackingIfUnused(
    session as unknown as bidi.BidiSessionInternal,
    impl.getFullTrackNameKey(),
  );
  // draft-ietf-moq-transport-23 §6.6.1:
  // GOAWAY 受信後に受信 PUBLISH の購読が無くなった時点で NO_ERROR で閉じる。
  session.onRequestDrained();
}

/**
 * 受信 PUBLISH の初期パラメータを購読に反映する
 *
 * draft-ietf-moq-transport-23 §9.8 (PUBLISH) / §9.19.18:
 * PAUSED (省略時は既定値 0 = unpaused) を paused 状態として保持する。
 * 値域外はセッションを閉じる (PAUSED の値域違反は INVALID_PARAMETER)。
 * OBJECT_DELIVERY_TIMEOUT / SUBGROUP_DELIVERY_TIMEOUT /
 * SUBSCRIBER_PRIORITY / GROUP_ORDER は publisher の初期値の通知であり
 * 受理のみで状態反映はしない。この関数では再検証しない
 * (PAUSED / GROUP_ORDER の uint8 値域は decode 時に検証済み。
 * varint 系 timeouts / PRIORITY は範囲外で閉じる規定がないため検証しない)。
 * draft-ietf-moq-transport-23 §9.8 / §9.19.9 / §3.6.2:
 * LOCATION_FILTER は購読の初期フィルタとして反映する
 * (省略時は既定値 = 無制限)。End Group 超過は DELTA_ENCODING_OVERFLOW で閉じる。
 * draft-ietf-moq-transport-23 §9.19.17 / §3.3.1:
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
  let paused: boolean;
  try {
    paused = extractPaused(parameters);
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

  impl.setPaused(paused);
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
 * PUBLISH の SUBSCRIBE_TRACKS_ID パラメータ値を取り出す
 *
 * draft-ietf-moq-transport-23 §9.19.21:
 * "It appears only in a PUBLISH sent as a result of a SUBSCRIBE_TRACKS, and
 *  contains that SUBSCRIBE_TRACKS's Request ID."
 *
 * @returns パラメータが無ければ undefined (unsolicited PUBLISH として扱う)
 */
function incomingPublishExtractSubscribeTracksId(parameters: Parameter[]): bigint | undefined {
  const parameter = parameters.find(
    (candidate) => candidate.type === MessageParameterType.SUBSCRIBE_TRACKS_ID,
  );
  if (parameter === undefined) {
    return undefined;
  }
  // decodeParameters が varint を encodeVarint で正規化した値を保持しているため、
  // 先頭から読み直しても同じ値になる
  const [value] = decodeVarint(parameter.value, 0);
  return value;
}

/**
 * PUBLISH と一致した SUBSCRIBE_TRACKS
 *
 * `subscription` は非同期 onPublish の完了後に同一の要求かを再確認するために保持する。
 */
interface IncomingPublishSubscriptionMatch {
  callbacks: TracksSubscriptionCallbacks;
  suffix: string[];
  subscription: TracksSubscriptionState;
  rangeFilters?: RangeFilterSpec[];
}

/**
 * 1 件の SUBSCRIBE_TRACKS が PUBLISH の Track Namespace に一致するか判定する
 *
 * @returns 一致した場合は callbacks / suffix / 購読状態、しなければ null
 */
function incomingPublishMatchSubscription(
  publishTrackNamespace: string[],
  subscription: TracksSubscriptionState,
): IncomingPublishSubscriptionMatch | null {
  const suffix = matchNamespacePrefix(publishTrackNamespace, subscription.namespacePrefix);
  if (suffix === null) {
    return null;
  }
  // exactOptionalPropertyTypes では optional な rangeFilters に undefined を渡せないため、
  // 値がある場合だけ載せる
  const matched = { callbacks: subscription.callbacks, suffix, subscription };
  return subscription.rangeFilters === undefined
    ? matched
    : { ...matched, rangeFilters: subscription.rangeFilters };
}

/**
 * PUBLISH を SUBSCRIBE_TRACKS の要求にマッチさせる
 *
 * draft-ietf-moq-transport-23 §3.6 / §9.19.21:
 * - SUBSCRIBE_TRACKS_ID を持つ PUBLISH は、その Request ID の要求だけを参照する。
 *   未知 / 取消し済み / 現在の prefix に一致しない場合は、他の要求の prefix 検索で
 *   救済せず null (UNINTERESTED 応答) にする。
 * - ID を持たない unsolicited PUBLISH は従来どおり、prefix が最初に一致した active な
 *   要求へ結び付ける (ID が無いこと自体は形式違反ではない)。
 *
 * @returns 一致した要求、しなければ null
 */
function incomingPublishMatchToSubscription(
  session: IncomingPublishSessionInternal,
  publishTrackNamespace: string[],
  parameters: Parameter[],
): IncomingPublishSubscriptionMatch | null {
  const subscribeTracksId = incomingPublishExtractSubscribeTracksId(parameters);
  if (subscribeTracksId !== undefined) {
    const subscription = session.tracksSubscriptions.get(subscribeTracksId);
    if (subscription === undefined || subscription.state !== "active") {
      return null;
    }
    return incomingPublishMatchSubscription(publishTrackNamespace, subscription);
  }
  for (const [, subscription] of session.tracksSubscriptions) {
    if (subscription.state !== "active") {
      continue;
    }
    const matched = incomingPublishMatchSubscription(publishTrackNamespace, subscription);
    if (matched !== null) {
      return matched;
    }
  }
  return null;
}

/**
 * PUBLISH から確立した購読をアプリへ通知する
 *
 * 契約は `TracksSubscriptionCallbacks.onPublishEstablished` の JSDoc を正本とする。
 * ここでは呼ぶ条件だけを扱う。
 *
 * 購読が closed の場合と、セッションが connected でない場合は呼ばない。
 * PUBLISH_OK の write は小さく、書き込みの待ちは通常 1 度で終わるが、待つ間に
 * 購読やセッションが閉じられる経路はある。bidiCancelSubscriptionWithError は
 * write 中の writer を abort するため write 自体が失敗するが、write の解決直後に
 * 状態だけ閉じる経路は残る。セッションの終了は sessionNotifyErrorIfActive が
 * sessionState だけを closed にし、購読は markClosed されない (transport.closed の
 * ハンドラは非同期のため)。両方の getter は同期であり、確認と呼び出しの間に
 * await は挟まらない。
 *
 * アプリの例外は握り潰す。アプリケーションのエラーはプロトコル違反ではなく、
 * §3.1 MUST の PUBLISH_OK は既に送信済みであるため、購読の確立を止める理由が無い
 * (`namespaceInvokeCallbackQuiet` と同じ方針)。
 *
 * @param session - セッションの内部状態 (セッション終了の判定用)
 * @param impl - 確立した購読
 * @param match - 一致した SUBSCRIBE_TRACKS 要求 (callback と suffix の出典)
 * @param trackName - PUBLISH に含まれる Track Name
 * @param callbacks - onPublish が返した SubscribeCallbacks (購読の対応付け用)
 */
function incomingPublishNotifyEstablished(
  session: IncomingPublishSessionInternal,
  impl: SubscriberImpl,
  match: IncomingPublishSubscriptionMatch,
  trackName: string,
  callbacks: SubscribeCallbacks,
): void {
  if (impl.state !== "active" || session.sessionState !== "connected") {
    return;
  }
  try {
    match.callbacks.onPublishEstablished?.(match.suffix, trackName, impl, callbacks);
  } catch {
    // アプリのコールバック例外は購読の確立を止めない
  }
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
    // draft-ietf-moq-transport-23 §9:
    // 制御メッセージの Message Length がローカル上限を超えた場合は
    // FIELD_LENGTH_EXCEEDED でセッションを閉じる。それ以外の読み取り失敗
    // (RESET_STREAM / セッション終了) は従来どおり通知に留める。
    sessionHandleFieldLengthExceeded(
      session,
      (sessionError) => {
        session.closeWithError(sessionError);
      },
      err,
    );
    session.notifyErrorIfActive(err instanceof Error ? err : new Error(String(err)));
    return null;
  }
}
