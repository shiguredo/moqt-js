/**
 * 受信データストリーム処理の free function 群
 *
 * SessionImpl の startIncomingStreamLoop / startDatagramLoop /
 * handleIncomingStream / handleFillFetchStream / handleSubgroupStream /
 * handleIncomingStreamError / handleMalformedFetchTrack /
 * handleMalformedSubgroupTrack / handlePeerFetchStreamReset /
 * processFetchObjects / processSubgroupObjects / createDataStreamTimeout
 * を free function として抽出する。
 *
 * draft-ietf-moq-transport-21 §11.3 (Subgroup Streams) / §11.4 (Fetch Streams) /
 * §3.4 (Fill Semantics) の受信経路を 1 か所にまとめる。
 * 受信 bidi ストリーム (受信 PUBLISH) の処理は incoming.ts と
 * 受信専用モジュールに残す。
 */

import {
  FetchHeaderType,
  decodeFetchHeader,
  decodeSubgroupHeader,
  type FetchHeader,
  type FetchObjectContext,
  type MoqtObject,
  type SubgroupHeader,
} from "../dataStream";
import {
  DataStreamErrorCode,
  IncompleteDataError,
  MalformedTrackError,
  SessionError,
  SessionErrorCode,
  peerStreamErrorCode,
} from "../error";
import { decodeVarint } from "../varint";
import type { FetcherImpl } from "../fetcher";
import type { SubscriberImpl } from "../subscriber";
import type { PendingSubgroupBuffer } from "../pendingSubgroupBuffer";
import * as bidi from "./bidi";
import { incomingProcessFetchObjects, incomingProcessSubgroupObjects } from "./incoming";
import { isPeerStreamError, isSessionClosedError, toSessionCloseError } from "./errors";
import { cancelStreamQuiet, concatChunks } from "./stream";
import type { SessionInternal } from "./types";
import type { ConnectCallbacks, SessionState, SubgroupStreamEnd } from "./publicTypes";
import type { PriorGapTracking } from "./priorGapTracking";
import type { FullTrackNameKey } from "../fullTrackName";

/**
 * 受信データストリーム処理が必要とする SessionImpl のビュー
 *
 * SessionImpl は `as unknown as DataStreamSessionInternal` で渡す。
 * private フィールドも実行時には存在するため、ここで宣言した形で読み書きできる。
 */
export interface DataStreamSessionInternal {
  readonly transport: WebTransport;
  sessionState: SessionState;
  readonly callbacks: ConnectCallbacks;

  // draft-ietf-moq-transport-21 §12.2: データストリームの受信タイムアウト
  dataStreamTimeoutMs: number;
  // draft-ietf-moq-transport-21 §12.5 (EXCESSIVE_LOAD 0x9):
  // 確立後の受信データストリームが保持してよいバッファの上限 (バイト)。
  // 0 以下は上限なし。
  dataStreamMaxBufferBytes: number;

  readonly fetchers: Map<bigint, FetcherImpl>;
  readonly fillFetchTargets: Map<bigint, bidi.FillFetchTarget>;
  readonly subscribersByAlias: Map<bigint, SubscriberImpl[]>;
  readonly pendingSubgroupBuffer: PendingSubgroupBuffer;
  readonly receivedEndOfGroupFinalObjectIds: Map<string, bigint>;
  readonly priorGapTrackingByTrack: Map<FullTrackNameKey, PriorGapTracking>;

  statsUnidirectionalStreamsReceived: number;
  statsSubscriberStreamsActive: number;
  statsSubgroupHeadersReceived: number;
  statsFetchHeadersReceived: number;

  // 他モジュールが実装する処理 (SessionImpl の wrapper 経由で呼ぶ)
  closeWithError(error: SessionError): void;
  notifyErrorIfActive(error: Error): void;
  emitCallbackErrorDebug(typeName: string, error: unknown): void;
  emitDataStreamErrorDebug(err: unknown, fetchHeader: FetchHeader | null): void;
  onRequestDrained(): void;
  handleIncomingDatagram(data: Uint8Array): void;
  waitForFetcher(requestId: bigint): Promise<FetcherImpl | null>;
}
export function dataStreamStartIncomingStreamLoop(session: DataStreamSessionInternal): void {
  void (async () => {
    const reader = session.transport.incomingUnidirectionalStreams.getReader();

    try {
      while (session.sessionState === "connected") {
        const { value: stream, done } = await reader.read();
        if (done) break;

        void dataStreamHandleIncomingStream(session, stream);
      }
    } catch (err) {
      // デバッグ: ストリームループエラー
      session.callbacks.debug?.({
        direction: "recv",
        type: 0,
        typeName: "STREAM_LOOP_ERROR",
        payload: new Uint8Array(0),
        decoded: {
          error: err instanceof Error ? err.message : String(err),
        },
        timestamp: Date.now(),
      });
      session.notifyErrorIfActive(err instanceof Error ? err : new Error(String(err)));
    } finally {
      reader.releaseLock();
    }
  })();
}

export function dataStreamStartDatagramLoop(session: DataStreamSessionInternal): void {
  void (async () => {
    const reader = session.transport.datagrams.readable.getReader();

    try {
      while (session.sessionState === "connected") {
        const { value, done } = await reader.read();
        if (done) break;

        if (value) {
          session.handleIncomingDatagram(value);
        }
      }
    } catch (err) {
      session.callbacks.debug?.({
        direction: "recv",
        type: 0,
        typeName: "DATAGRAM_LOOP_ERROR",
        payload: new Uint8Array(0),
        decoded: {
          error: err instanceof Error ? err.message : String(err),
        },
        timestamp: Date.now(),
      });
      session.notifyErrorIfActive(err instanceof Error ? err : new Error(String(err)));
    } finally {
      reader.releaseLock();
    }
  })();
}

export async function dataStreamHandleIncomingStream(
  session: DataStreamSessionInternal,
  stream: ReadableStream<Uint8Array>,
): Promise<void> {
  // 統計カウンターを更新
  session.statsUnidirectionalStreamsReceived++;
  session.statsSubscriberStreamsActive++;

  const reader = stream.getReader();

  // ストリーミングパーサー状態
  let buffer: Uint8Array = new Uint8Array(0);
  let headerParsed = false;
  let isFetchStream = false;

  // Fetch ストリーム用の状態
  let fetchHeader: FetchHeader | null = null;
  let fetcher: FetcherImpl | null = null;
  let fetchContext: FetchObjectContext | null = null;
  let isFirstFetchObject = true;

  // draft-ietf-moq-transport-21 §12.2 (DATA_STREAM_TIMEOUT):
  // ヘッダーまたは Object の途中バイトを保持したまま待ち続けるピアを期限で
  // 打ち切る。バッファが空になった時点で期限を解除する。
  const timeout = dataStreamCreateDataStreamTimeout(session, reader, () => buffer.byteLength);
  const armTimeout = timeout.arm;
  const clearTimeoutHandle = timeout.clear;

  try {
    while (true) {
      // draft-ietf-moq-transport-21 §12.2 (DATA_STREAM_TIMEOUT):
      // 途中バイトを保持したまま次のチャンクを待つ間だけ期限を張る。
      // バッファを消費しきったら解除する。ループ先頭で行うのは、
      // データ不足で continue する経路 (半端なヘッダー / Object) でも
      // 必ず期限が張られるようにするためである。
      if (buffer.byteLength > 0) {
        armTimeout();
      } else {
        clearTimeoutHandle();
      }

      const { value, done } = await reader.read();

      if (value) {
        // 新しいチャンクをバッファに追加
        const newBuffer = new Uint8Array(buffer.length + value.length);
        newBuffer.set(buffer);
        newBuffer.set(value, buffer.length);
        buffer = newBuffer;
      }

      // ヘッダーがまだパースされていない場合
      if (!headerParsed && buffer.length > 0) {
        try {
          // 先頭のタイプを確認
          const [streamType] = decodeVarint(buffer, 0);

          const streamTypeNum = Number(streamType);

          if (streamTypeNum === FetchHeaderType) {
            // Fetch データストリーム
            isFetchStream = true;
            const [header, consumed] = decodeFetchHeader(buffer);
            fetchHeader = header;
            buffer = buffer.slice(consumed);
            headerParsed = true;

            // 統計カウンターを更新
            session.statsFetchHeadersReceived++;

            // Fetcher を検索
            // draft-ietf-moq-transport-21 Section 9.12 (FETCH_OK):
            // FETCH_OK より先にデータストリームが到着する可能性がある
            fetcher = session.fetchers.get(header.requestId) ?? null;
            if (!fetcher) {
              // draft-ietf-moq-transport-21 §3.4 (Fill Semantics):
              // fill fetch ストリームの FETCH_HEADER は fill を要求した
              // SUBSCRIBE / REQUEST_UPDATE の Request ID を運ぶ。購読に
              // 紐付けて受信する。どちらにも該当しない Request ID は
              // 不明な FETCH として従来どおり扱う。
              const fillTarget = session.fillFetchTargets.get(header.requestId);
              if (fillTarget) {
                await dataStreamHandleFillFetchStream(
                  session,
                  reader,
                  header.requestId,
                  fillTarget,
                  buffer,
                );
                return;
              }
              fetcher = await session.waitForFetcher(header.requestId);
              if (!fetcher) {
                // タイムアウトで Fetcher が登録されなかった場合は、
                // peer に STOP_SENDING (cancel) を送って受信を打ち切る。
                // draft-ietf-moq-transport-21 Section 3.2.1 (Fetch State Management) に倣ってストリームを reset する。
                void reader.cancel(`unknown fetcher: requestId=${header.requestId}`);
                break;
              }
            }
          } else if (
            (streamTypeNum >= 0x10 && streamTypeNum <= 0x1f) ||
            (streamTypeNum >= 0x30 && streamTypeNum <= 0x3f) ||
            (streamTypeNum >= 0x50 && streamTypeNum <= 0x5f) ||
            (streamTypeNum >= 0x70 && streamTypeNum <= 0x7f)
          ) {
            // draft-ietf-moq-transport-21 Section 11.3.1:
            // SUBGROUP_ID_MODE = 0b11 のタイプ値
            // (0x16, 0x17, 0x1E, 0x1F, 0x36, 0x37, 0x3E, 0x3F) は予約値であり、
            // 受信した場合は PROTOCOL_VIOLATION でセッションを閉じなければならない
            if ((streamTypeNum & 0x06) === 0x06) {
              session.closeWithError(
                new SessionError(
                  `reserved subgroup header type: 0x${streamTypeNum.toString(16)}`,
                  SessionErrorCode.PROTOCOL_VIOLATION,
                ),
              );
              break;
            }

            // Subgroup ストリーム
            isFetchStream = false;
            const [header, consumed] = decodeSubgroupHeader(buffer);
            const initialPayloadBuffer = buffer.slice(consumed);
            buffer = new Uint8Array(0);
            headerParsed = true;

            // 統計カウンターを更新
            session.statsSubgroupHeadersReceived++;

            // Subgroup ストリーム本体は専用ハンドラに委譲する
            // pending mode (subscriber 未登録) と subscriber mode を一貫して扱う
            // draft-ietf-moq-transport-21 §11.3.1 の buffer 経路はこのハンドラ内に集約
            await dataStreamHandleSubgroupStream(session, reader, header, initialPayloadBuffer);
            return;
          } else if (streamTypeNum === 0x132b3e28) {
            // draft-ietf-moq-transport-21 §11.5.1 (Padding Streams):
            // "The receiver MUST discard all data received on a padding stream."
            // PADDING stream のデータはすべて読み捨てる
            isFetchStream = false;
            headerParsed = true;
            buffer = new Uint8Array(0);
            // 残りのデータを drain してストリームを読み切る
            let streamDone = false;
            while (!streamDone) {
              const next = await reader.read();
              streamDone = next.done;
            }
            return;
          } else {
            // draft-ietf-moq-transport-21 Section 6.4.1 (Unidirectional Stream Types):
            // "An endpoint that receives an unknown stream type MUST close the session."
            session.closeWithError(
              new SessionError(
                `unknown unidirectional stream type: 0x${streamTypeNum.toString(16)}`,
                SessionErrorCode.PROTOCOL_VIOLATION,
              ),
            );
            break;
          }
        } catch (err) {
          if (err instanceof IncompleteDataError) {
            // データ不足: 次のチャンクを待つ
            // ヘッダー途中での FIN (done) は Object が開始する前のため、
            // §11.3 / §11.4 の未完成 Object 判定 (FIN 直後の残バッファ検査) の
            // 対象外として黙殺する
            if (done) break;
            continue;
          }
          // SessionError (KEY_VALUE_FORMATTING_ERROR 等) はそのコードのまま、
          // ProtocolViolationError / IncompleteDataError は PROTOCOL_VIOLATION で閉じる
          const sessionError = toSessionCloseError(err);
          if (sessionError !== null) {
            // 仕様違反: セッションを閉じる
            session.closeWithError(sessionError);
            break;
          }
          // 予期しないエラー: INTERNAL_ERROR でセッションを閉じる
          session.closeWithError(
            new SessionError(
              err instanceof Error ? err.message : String(err),
              SessionErrorCode.INTERNAL_ERROR,
            ),
          );
          break;
        }
      }

      // §12.5 (EXCESSIVE_LOAD): FETCH ストリームの上限検査 (Subgroup / fill は
      // 専用ハンドラ側で検査する)。ここへ到達する時点でヘッダーは解析済みであり
      // (未解析のストリームは委譲して return、未知型や fetcher 未解決は break する)、
      // fetchHeader と fetcher は必ず設定されている。
      if (
        await dataStreamAbortFetchOnBufferOverflow(
          session,
          reader,
          fetchHeader,
          fetcher,
          buffer.byteLength,
        )
      ) {
        return;
      }

      // オブジェクトをパースして配信
      if (headerParsed) {
        if (isFetchStream && fetcher && fetchHeader) {
          // Fetch オブジェクトをストリーミング処理
          // draft-ietf-moq-transport-21 Section 11.4.1.1 (Flags):
          // FETCH オブジェクトは prior context (前オブジェクトの groupId / subgroupId / publisherPriority)
          // を参照するシリアライゼーションフラグを持つため、複数チャンクに分割された場合に備えて
          // context と isFirst を caller 側で永続化する必要がある
          const fetchResult = dataStreamProcessFetchObjects(
            session,
            buffer,
            fetcher,
            fetchContext,
            isFirstFetchObject,
          );
          buffer = fetchResult.remainingBuffer;
          fetchContext = fetchResult.context;
          isFirstFetchObject = fetchResult.isFirst;
        }
      }

      if (done) break;
    }

    // ストリーム終了処理 (条件はループ内のオブジェクト解析部と対称)
    if (isFetchStream && fetcher && fetchHeader) {
      // ループ最終反復で buffer は remainingBuffer に更新済みであり、
      // ここに残る = FIN 時点で未完了 Object の途中バイト。
      // draft-ietf-moq-transport-21 Section 11.3 (Streams):
      // "If a stream ends gracefully (i.e., the stream terminates with a
      //  FIN) in the middle of a serialized Object, the session SHOULD be
      //  closed with a PROTOCOL_VIOLATION."
      // fetcher.handleEnd() も fetchers.delete も行わず、セッションを
      // PROTOCOL_VIOLATION で閉じる (fetcher の無効化はセッション終了側
      // に委ねる)。
      // close() を経ずに sessionState が closed へ遷移する経路では
      // fetcher の扱いが分かれる。transport.closed ハンドラでは
      // markRequestObjectsClosed により closed になるが、条件付きで遷移する
      // notifyErrorIfActive では active のまま残る。いずれの close 済み経路でも
      // end を通知せず return する
      // (未完成 Object を正常終了として扱わないため)。closeWithError は
      // セッション終了済みだと呼ばない (終了済みセッションへの
      // spurious な通知を防ぐため)
      if (buffer.byteLength > 0) {
        if (session.sessionState === "connected") {
          session.closeWithError(
            new SessionError(
              `fetch data stream ended with incomplete object: requestId=${fetchHeader.requestId}, remaining ${buffer.byteLength} bytes`,
              SessionErrorCode.PROTOCOL_VIOLATION,
            ),
          );
        }
        return;
      }
      fetcher.handleEnd();
      session.fetchers.delete(fetchHeader.requestId);
      // draft-ietf-moq-transport-21 §10.8 / §10.9:
      // FETCH の終了に伴い、購読も尽きた Track の Prior ID Gap 追跡を捨てる
      // (bidiCancelFetch と同じ後始末)。
      bidi.clearPriorGapTrackingIfUnused(
        session as unknown as SessionInternal,
        fetcher.getFullTrackNameKey(),
      );
      // draft-ietf-moq-transport-21 §6.6.1:
      // GOAWAY 受信後に Established fetch が無くなった時点で NO_ERROR で閉じる。
      session.onRequestDrained();
    }
  } catch (err) {
    await dataStreamHandleIncomingStreamError(session, err, reader, fetchHeader, fetcher);
  } finally {
    clearTimeoutHandle();
    session.statsSubscriberStreamsActive--;
    reader.releaseLock();
  }
}

/**
 * fill fetch ストリームを受信する
 *
 * draft-ietf-moq-transport-21 §3.4 (Fill Semantics) / §3.4.1:
 * fill fetch ストリームは FETCH と同じオブジェクト framing で届き、
 * FIN は fill 完了 (関連付けを消す)、reset は fill 失敗として扱う。
 * オブジェクトは fillDelivered を true にして購読の object コールバックに
 * 渡す (handleFillObject 経由。subscription のフィルタ再適用は通さない)。
 * fill ストリームの reset / STOP_SENDING による通常の失敗は購読に波及しない
 * (§3.4.1)。ただし malformed track の検出は §12.1 が優先し、同一 Track の
 * 全購読と全 FETCH を cancel する。
 */
export async function dataStreamHandleFillFetchStream(
  session: DataStreamSessionInternal,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  fillRequestId: bigint,
  target: bidi.FillFetchTarget,
  initialBuffer: Uint8Array,
): Promise<void> {
  let buffer = initialBuffer;
  let context: FetchObjectContext | null = null;
  let isFirst = true;
  // アプリの object コールバックの throw を fill ストリーム自体の失敗と
  // 誤認しないよう、ここで受けてデバッグ記録に残す。subgroup 経路が
  // SUBGROUP_CALLBACK_ERROR として記録しつつ配送を継続するのと同じ扱いで、
  // fill の受信も継続する。ここで受けなければ下の catch がストリームの
  // エラーとして扱い、fill 失敗の通知 (fillError) まで誤って発火する。
  const sink = {
    handleObject: (object: MoqtObject): void => {
      try {
        target.subscriber.handleFillObject(object);
      } catch (callbackError) {
        session.emitCallbackErrorDebug("FILL_CALLBACK_ERROR", callbackError);
      }
    },
  };
  try {
    while (true) {
      // §12.5: ヘッダー解析後の残バッファ (初回) とチャンク追記直後に検査する
      if (
        await dataStreamAbortFillOnBufferOverflow(
          session,
          reader,
          fillRequestId,
          target,
          buffer.byteLength,
        )
      ) {
        return;
      }

      const { value, done } = await reader.read();

      if (value) {
        const next = new Uint8Array(buffer.length + value.length);
        next.set(buffer);
        next.set(value, buffer.length);
        buffer = next;
        // §12.5: チャンク追記直後の検査 (残バッファを処理する前に判定する)
        if (
          await dataStreamAbortFillOnBufferOverflow(
            session,
            reader,
            fillRequestId,
            target,
            buffer.byteLength,
          )
        ) {
          return;
        }
      }

      if (buffer.length > 0) {
        const result = incomingProcessFetchObjects(
          session as unknown as SessionInternal,
          buffer,
          sink,
          context,
          isFirst,
          target.groupOrder,
          // fill fetch ストリーム経由のため fill 側統計に計上する
          true,
          // fill fetch の追跡対象 Track は関連付けられた購読が持つ比較キーで決まる
          target.subscriber.getFullTrackNameKey(),
        );
        buffer = result.remainingBuffer;
        context = result.context;
        isFirst = result.isFirst;
      }

      if (done) break;
    }

    // FIN 時に未完了 Object の途中バイトが残る場合は FETCH と同様に
    // PROTOCOL_VIOLATION でセッションを閉じる (§11.3)。
    if (buffer.byteLength > 0) {
      if (session.sessionState === "connected") {
        session.closeWithError(
          new SessionError(
            `fill fetch data stream ended with incomplete object: requestId=${fillRequestId}, remaining ${buffer.byteLength} bytes`,
            SessionErrorCode.PROTOCOL_VIOLATION,
          ),
        );
      }
      return;
    }
    // FIN は fill 完了であり、関連付けを消す。購読自体は継続する (§3.4.1)。
    session.fillFetchTargets.delete(fillRequestId);
  } catch (err) {
    session.emitDataStreamErrorDebug(err, { type: FetchHeaderType, requestId: fillRequestId });
    // エラー時は fill ストリームを使えない (reset / 失敗) ため関連付けを消す。
    // 購読自体は継続する (§3.4.1)。
    session.fillFetchTargets.delete(fillRequestId);
    // draft-ietf-moq-transport-21 §8.3:
    // 既知 Type の serialization 不一致は SessionError (KEY_VALUE_FORMATTING_ERROR)
    // として届くため、エラーコードを保持したまま閉じる (他の受信経路と同じ)。
    const sessionError = toSessionCloseError(err);
    const normalizedError = err instanceof Error ? err : new Error(String(err));
    if (sessionError !== null) {
      session.closeWithError(sessionError);
    } else if (err instanceof MalformedTrackError) {
      // draft-ietf-moq-transport-21 §12.1:
      // malformed track の検出は §3.4.1 の「fill 失敗は購読に波及しない」
      // より優先し、同一 Track の全購読と全 FETCH を cancel する。
      // アプリへの通知は cancelMalformedTrackPeers が購読の error
      // コールバック経由で行うため、fillError は呼ばない (二重通知を防ぐ)。
      bidi.cancelMalformedTrackPeers(
        session as unknown as SessionInternal,
        target.subscriber.getFullTrackNameKey(),
        err,
      );
      await cancelStreamQuiet(
        reader,
        `malformed fill track: requestId=${fillRequestId}, reason=${err instanceof Error ? err.message : String(err)}`,
      );
    } else if (!isSessionClosedError(normalizedError)) {
      // draft-ietf-moq-transport-21 §3.4.1:
      // "Because there is no REQUEST_ERROR associated with a fill fetch
      //  stream, the publisher signals a fill failure by resetting the
      //  stream" および "Resetting or cancelling a fill fetch stream, by
      //  either endpoint, does not affect the subscription, which continues
      //  to deliver objects using subscribe subgroups and datagrams."
      // 購読は継続するため終了通知 (error) は出さず、fill 専用の
      // fillError でアプリに失敗を伝える。アプリはこれで再取得を判断できる。
      // セッション終了起源の失敗 (isSessionClosedError) はセッション単位の
      // error コールバックが通知するため、ここでは通知しない。
      try {
        target.subscriber.handleFillError(normalizedError);
      } catch (callbackError) {
        // アプリの fillError コールバックの throw は握り潰す
        // (fill の後始末を止めない)。
        session.emitCallbackErrorDebug("FILL_ERROR_CALLBACK_ERROR", callbackError);
      }
    }
  }
  // 統計と reader ロックの後始末は呼び出し元の handleIncomingStream の
  // finally に委ねる (Subgroup 経路と同パターン)。
}

/**
 * Malformed Track 検出時の FETCH キャンセル処理
 *
 * draft-ietf-moq-transport-21 §12.1 (Malformed Tracks):
 * Malformed Track 検出時は「cancel any corresponding subscription or fetches
 * for that Track from that publisher」であり、セッションを閉じない。
 * まず受信データストリームを STOP_SENDING 相当 (cancelStreamQuiet) で打ち切る。
 * fetcher が存在する場合 (FETCH データストリーム)、fetcher の error コールバックで
 * アプリへ通知し (§12.1 SHOULD)、FetcherImpl.cancel() 経由で
 * draft-ietf-moq-transport-21 §3.2.1 の MUST「It MUST send STOP_SENDING for
 * the bidi request stream.」に従い bidi リクエストストリームへ STOP_SENDING
 * を送り、fetchers Map から削除する。
 *
 * §12.1 の「fetches for that Track」に従い、同一 Full Track Name の全購読と
 * 全 FETCH を cancel する (cancelMalformedTrackPeers)。fetch() は
 * bidiSendRequestOnBidiStream で新規 bidi ストリームを開いて requestStreams に
 * 登録するため (§9.11「A subscriber sends FETCH as the first message on a new
 * bidi stream」)、同じく STOP_SENDING が送られる。
 *
 * アプリの error コールバックが throw した場合は握り潰してキャンセルを継続する。
 * 呼び出し元の handleIncomingStream は fire-and-forget で起動されるため、throw を
 * 伝搬させると unhandled rejection になる。
 */
export async function dataStreamHandleMalformedFetchTrack(
  session: DataStreamSessionInternal,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  error: MalformedTrackError,
  fetcher: FetcherImpl | null,
): Promise<void> {
  await cancelStreamQuiet(
    reader,
    `malformed track: code=${DataStreamErrorCode.MALFORMED_TRACK}, reason=${error.message}`,
  );
  if (fetcher) {
    // draft-ietf-moq-transport-21 §12.1:
    // 同一 Track の全購読と全 FETCH を cancel する (該当 requestId の FETCH の
    // みではない)。比較キー (fullTrackNameKey の戻り値) で引く。
    bidi.cancelMalformedTrackPeers(
      session as unknown as SessionInternal,
      fetcher.getFullTrackNameKey(),
      error,
    );
  }
}

/**
 * 受信データストリームの読み取りループで発生したエラーの処理
 *
 * - ProtocolViolationError は PROTOCOL_VIOLATION でセッションを閉じる
 * - MalformedTrackError は同一 Track の全購読と全 FETCH をキャンセルする
 * - FETCH データストリームの peer RESET_STREAM は fetcher state を破棄する
 */
export async function dataStreamHandleIncomingStreamError(
  session: DataStreamSessionInternal,
  err: unknown,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  fetchHeader: FetchHeader | null,
  fetcher: FetcherImpl | null,
): Promise<void> {
  // デバッグ: ストリームエラーをログ
  session.emitDataStreamErrorDebug(err, fetchHeader);
  // SessionError (KEY_VALUE_FORMATTING_ERROR 等) はそのコードのまま、
  // ProtocolViolationError / IncompleteDataError は PROTOCOL_VIOLATION で閉じる
  const sessionError = toSessionCloseError(err);
  if (sessionError !== null) {
    session.closeWithError(sessionError);
    return;
  }
  if (err instanceof MalformedTrackError) {
    await dataStreamHandleMalformedFetchTrack(session, reader, err, fetcher);
    return;
  }
  if (fetchHeader !== null && isPeerStreamError(err)) {
    // draft-ietf-moq-transport-21 §3.2.1:
    // FETCH データストリームの reset で subscriber は FETCH state を破棄する。
    // fetchHeader が無い場合 (FETCH_HEADER 読取前の reset) は fetcher を
    // 特定できないため何もしない。
    dataStreamHandlePeerFetchStreamReset(session, err, fetchHeader, fetcher);
  }
}

/**
 * 上限超過で FETCH データストリームを打ち切るときの後始末
 *
 * ピアの RESET_STREAM と同じくアプリへ error を通知してから fetcher を closed にし、
 * fetchers から削除、Prior ID Gap 追跡の掃除、onRequestDrained まで行う (正常終了の
 * handleEnd は通知しない)。セッションは閉じない。
 *
 * draft-ietf-moq-transport-21 §3.2.1:
 * 「If the data stream is already open, the subscriber wishing to cancel the FETCH
 *  MAY send STOP_SENDING for the data stream as well as the bidi request stream.
 *  It MUST send STOP_SENDING for the bidi request stream.」
 * ローカル判断で FETCH state を破棄する本経路は cancel に当たるため、fetcher.cancel()
 * で bidi リクエストストリームへ STOP_SENDING を送る (markClosed だけでは state が
 * 先に closed になり、アプリからの cancel() が no-op になって MUST を満たせない)。
 * cancel() が fetchers / requestStreams の削除と Prior ID Gap 追跡の掃除、
 * onRequestDrained まで行う。
 *
 * @returns 打ち切ったなら true (呼び出し元は return する)
 */
async function dataStreamAbortFetchOnBufferOverflow(
  session: DataStreamSessionInternal,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  fetchHeader: FetchHeader | null,
  fetcher: FetcherImpl | null,
  bufferedBytes: number,
): Promise<boolean> {
  if (!isDataStreamBufferOverLimit(session, bufferedBytes)) {
    return false;
  }
  if (fetchHeader === null || fetcher === null) {
    // 上限判定が成立する時点ではヘッダー解析済みの FETCH ストリームに限られるため
    // 通常は到達しない (型を締めるための防御)。対象を特定できない場合はストリームを
    // 打ち切るだけにする (残バッファは捨てる)。
    await cancelStreamQuiet(
      reader,
      dataStreamBufferOverflowReason(session, `buffered=${bufferedBytes}`),
    );
    return true;
  }
  const detail = `requestId=${fetchHeader.requestId}, buffered=${bufferedBytes}`;
  await cancelStreamQuiet(reader, dataStreamBufferOverflowReason(session, detail));
  const error = createDataStreamBufferOverflowError(session, detail);
  try {
    fetcher.handleError(error);
  } catch {
    // アプリの error コールバックの throw は握り潰す (後始末は継続する)
  }
  await fetcher.cancel().catch(() => {});
  return true;
}

/**
 * peer の RESET_STREAM で FETCH データストリームが終了したときの後始末
 *
 * draft-ietf-moq-transport-21 §3.2.1:
 * 「A subscriber keeps FETCH state until it cancels the request (see
 *  Section 6.4.2.3), receives REQUEST_ERROR, or the FETCH data stream
 *  receives a FIN or is reset.」
 * アプリへ error を通知してから fetcher を closed にし、fetchers から削除する
 * (handleMalformedFetchTrack と同じ順序。handleError を markClosed より先に
 * 呼ばないと通知が握り潰される)。FIN 経路 (handleEnd + fetchers.delete) と
 * state 破棄の集合を揃える。エラーには正規化済みの streamErrorCode を載せる。
 * bidi リクエストストリーム (requestStreams) は FIN 経路と同じく削除しない
 * (セッション終了時にまとめて解放される)。
 */
export function dataStreamHandlePeerFetchStreamReset(
  session: DataStreamSessionInternal,
  err: unknown,
  fetchHeader: FetchHeader | null,
  fetcher: FetcherImpl | null,
): void {
  if (fetcher) {
    try {
      fetcher.handleError(bidi.createFetchDataStreamResetError(err));
    } catch {
      // アプリの error コールバックの throw は握り潰す (後始末は継続する)
    } finally {
      fetcher.markClosed();
    }
  }
  if (fetchHeader !== null) {
    session.fetchers.delete(fetchHeader.requestId);
    // draft-ietf-moq-transport-21 §10.8 / §10.9:
    // peer の RESET_STREAM による FETCH の終了でも、購読も尽きた Track の
    // Prior ID Gap 追跡を捨てる (FIN 経路と同じ後始末)。
    if (fetcher) {
      bidi.clearPriorGapTrackingIfUnused(
        session as unknown as SessionInternal,
        fetcher.getFullTrackNameKey(),
      );
    }
    // draft-ietf-moq-transport-21 §6.6.1:
    // GOAWAY 受信後に Established fetch が無くなった時点で NO_ERROR で閉じる。
    session.onRequestDrained();
  }
}

/**
 * Fetch オブジェクトをストリーミング処理
 * パース可能なオブジェクトを全て処理し、残りのバッファを返す
 */
export function dataStreamProcessFetchObjects(
  session: DataStreamSessionInternal,
  buffer: Uint8Array,
  fetcher: FetcherImpl,
  context: FetchObjectContext | null,
  isFirst: boolean,
): {
  remainingBuffer: Uint8Array;
  context: FetchObjectContext | null;
  isFirst: boolean;
} {
  return incomingProcessFetchObjects(
    session as unknown as SessionInternal,
    buffer,
    fetcher,
    context,
    isFirst,
    fetcher.getGroupOrder(),
    // 通常 FETCH のため fetch 側統計に計上する
    false,
    // 追跡対象 Track は FETCH を発行した Fetcher が持つ比較キーで決まる
    fetcher.getFullTrackNameKey(),
  );
}

/**
 * Subgroup オブジェクトをストリーミング処理
 * パース可能なオブジェクトを全て処理し、残りのバッファと状態を返す。
 * resolvedSubgroupId を透過し、feed 間の解決値を引き継ぐ
 * (明示型・0 系はヘッダ値のため透過しても no-op になる)。
 */
export function dataStreamProcessSubgroupObjects(
  session: DataStreamSessionInternal,
  buffer: Uint8Array,
  subscribers: SubscriberImpl[],
  header: SubgroupHeader,
  previousObjectId: bigint,
  resolvedSubgroupId?: bigint,
): {
  remainingBuffer: Uint8Array;
  previousObjectId: bigint;
  resolvedSubgroupId: bigint | undefined;
  updatedEndOfGroupFinalObjectId: bigint | undefined;
} {
  return incomingProcessSubgroupObjects(
    session as unknown as SessionInternal,
    buffer,
    subscribers,
    header,
    previousObjectId,
    resolvedSubgroupId,
  );
}

/**
 * Malformed Track (Object Property の Mandatory Track Property) を検出した
 * 同一 Track の全購読と全 FETCH を §12.1 に従って cancel する
 *
 * draft-ietf-moq-transport-21 §12.1:
 * "it MUST cancel any corresponding subscription or fetches for that Track
 *  from that publisher"
 * データストリームを打ち切り、同一 Full Track Name の購読 / FETCH を cancel する。
 * セッションは閉じない (Track 単位の失敗として扱う)。
 */
export async function dataStreamHandleMalformedSubgroupTrack(
  session: DataStreamSessionInternal,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  header: SubgroupHeader,
  subscribers: SubscriberImpl[],
  error: MalformedTrackError,
): Promise<void> {
  // draft-ietf-moq-transport-21 §12.1:
  // 同一 Track の全購読と全 FETCH を cancel する。比較キーは
  // trackAlias から購読を特定して得る (購読が未特定なら cancel 対象が無い)。
  const trackKey = subscribers[0]?.getFullTrackNameKey();
  if (trackKey !== undefined) {
    bidi.cancelMalformedTrackPeers(session as unknown as SessionInternal, trackKey, error);
  }
  await cancelStreamQuiet(
    reader,
    `malformed track: trackAlias=${header.trackAlias}, reason=${error.message}`,
  );
}

/**
 * Subgroup ストリームを処理する
 *
 * draft-ietf-moq-transport-21 §11.3.1:
 * "If an endpoint receives a subgroup with an unknown Track Alias, it MAY abandon
 *  the stream, or choose to buffer it for a brief period to handle reordering with
 *  the control message that establishes the Track Alias."
 *
 * subscriber が登録済みであれば即座に通常 mode で読み出す。
 * 未登録なら pending mode に入り、Promise.race で chunk 受信と subscriber 通知を並走させる。
 * subscriber 登録後は累積 chunks を flush して通常 mode に合流する。
 * timeout / overflow / session-close / end-of-stream のいずれかで abandon する。
 */
/**
 * pending mode の Subgroup ストリームが読み取りエラーで終わったときの後始末
 *
 * ピアの RESET_STREAM 以外 (セッション終了など) は呼び出し元へ投げ直す。
 *
 * draft-ietf-moq-transport-21 §11.3.2 (Closing Subgroup Streams): 送信側は Subgroup の
 * 残りを配らずに閉じるとき MUST で RESET_STREAM する。購読が未登録の間は Object を
 * decode しておらず配る相手も居ないため、溜めた chunk を捨ててこの stream の処理を
 * 終える (セッションは閉じない)。この仕様はドラフトであり将来変更されうる。
 */
async function dataStreamHandlePendingSubgroupReadError(
  session: DataStreamSessionInternal,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  header: SubgroupHeader,
  entry: ReturnType<PendingSubgroupBuffer["add"]>,
  error: unknown,
): Promise<void> {
  if (!isPeerStreamError(error)) {
    throw error;
  }
  entry.notify("end-of-stream");
  session.pendingSubgroupBuffer.remove(entry);
  await cancelStreamQuiet(reader, `pending subgroup reset: trackAlias=${header.trackAlias}`);
}

/**
 * Subgroup ストリームの読み取りがエラーで終わったときの判定
 *
 * draft-ietf-moq-transport-21 §11.3.2 (Closing Subgroup Streams): 送信側は Subgroup の
 * 残りを配らずに閉じるとき MUST で RESET_STREAM する。受信済みの Object は配信済みで
 * あり、続きは別の Subgroup / Group の stream で届く。セッションは閉じず、途中まで
 * 受けた Object の残りバイトだけを捨ててこの stream の処理を終える (未完成 Object で
 * FIN されたときの PROTOCOL_VIOLATION とは異なる)。この仕様はドラフトであり将来
 * 変更されうる。ピア起因でないエラーは呼び出し元へ投げ直す。
 */
function dataStreamHandleSubgroupReadError(error: unknown): void {
  if (!isPeerStreamError(error)) {
    throw error;
  }
}

export async function dataStreamHandleSubgroupStream(
  session: DataStreamSessionInternal,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  header: SubgroupHeader,
  initialBuffer: Uint8Array,
): Promise<void> {
  let buffer = initialBuffer;
  let previousObjectId = -1n;
  let resolvedSubgroupId: bigint | undefined;
  let subscribers: SubscriberImpl[] = session.subscribersByAlias.get(header.trackAlias) ?? [];

  // pending mode で発火された read Promise を subscriber mode に持ち越すための変数
  // ReadableStreamDefaultReader.read() は中断不能なため、Promise.race で別経路が
  // 勝ったときに pendingRead を破棄せず保持し、subscriber mode の最初の read として消費する
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;

  if (subscribers.length === 0) {
    const entry = session.pendingSubgroupBuffer.add(header.trackAlias);
    let entryRemoved = false;

    try {
      // ヘッダパース直後に余っていた payload を pending entry に移し、ローカル buffer は空にする
      // subscriber mode 復帰時に entry.chunks の concat 結果で buffer を作り直す
      if (initialBuffer.byteLength > 0) {
        session.pendingSubgroupBuffer.appendChunk(entry, initialBuffer);
        buffer = new Uint8Array(0);
      }

      while (subscribers.length === 0) {
        pendingRead ??= reader.read();
        const event = await Promise.race([
          pendingRead.then(
            (result) => ({ kind: "chunk" as const, result }),
            (error: unknown) => ({ kind: "read-error" as const, error }),
          ),
          entry.notified.then((reason) => ({ kind: "notify" as const, reason })),
        ]);

        if (event.kind === "read-error") {
          await dataStreamHandlePendingSubgroupReadError(
            session,
            reader,
            header,
            entry,
            event.error,
          );
          return;
        }

        if (event.kind === "chunk") {
          pendingRead = null;
          const chunk = event.result.value;
          if (chunk && chunk.byteLength > 0) {
            session.pendingSubgroupBuffer.appendChunk(entry, chunk);
          }
          if (event.result.done) {
            // FIN 検出時はその場で完結させる (race の再登録を待たない)。
            // FIN 済み read() は以後も即解決の done を返すため、再 race すると
            // chunk 分岐が常に勝って notified が発火せず無限ループになる。
            // FIN と subscriber 登録の同時解決は合流を優先し、空の場合のみ
            // abandon する (notified 側が先に勝つ既存経路は変えない)。
            subscribers = session.subscribersByAlias.get(header.trackAlias) ?? [];
            if (subscribers.length > 0) {
              // pending chunks を 1 本に concat して subscriber mode へ合流する
              buffer = concatChunks(entry.chunks);
              session.pendingSubgroupBuffer.remove(entry);
              entryRemoved = true;
              break;
            }
            entry.notify("end-of-stream");
            session.pendingSubgroupBuffer.remove(entry);
            entryRemoved = true;
            await cancelStreamQuiet(
              reader,
              `pending subgroup end-of-stream: trackAlias=${header.trackAlias}`,
            );
            return;
          }
          continue;
        }

        // event.kind === "notify"
        if (event.reason === "subscriber") {
          subscribers = session.subscribersByAlias.get(header.trackAlias) ?? [];
          if (subscribers.length === 0) {
            // 通知発火と subscribers 解放が race した稀なケース: abandon
            session.pendingSubgroupBuffer.remove(entry);
            entryRemoved = true;
            await cancelStreamQuiet(
              reader,
              `inconsistent subscriber state: trackAlias=${header.trackAlias}`,
            );
            return;
          }
          // pending chunks を 1 本に concat して buffer に格納し subscriber mode へ遷移する
          buffer = concatChunks(entry.chunks);
          session.pendingSubgroupBuffer.remove(entry);
          entryRemoved = true;
          break;
        }

        // abandon (timeout / overflow-per-stream / overflow-per-session / session-close / end-of-stream)
        session.pendingSubgroupBuffer.remove(entry);
        entryRemoved = true;
        await cancelStreamQuiet(
          reader,
          `pending subgroup ${event.reason}: trackAlias=${header.trackAlias}`,
        );
        return;
      }
    } finally {
      if (!entryRemoved) {
        // 例外脱出時の救済 cleanup (二重 remove は no-op で安全)
        session.pendingSubgroupBuffer.remove(entry);
      }
    }
  }

  // subscriber mode: 通常の Subgroup ストリーム処理ループ
  // pendingRead が pending mode から持ち越されている場合はそれを最初の read として消費する
  // draft-ietf-moq-transport-21 §12.2 (DATA_STREAM_TIMEOUT):
  // 途中バイトを保持したまま次のチャンクを待つ間だけ期限を張る。
  const timeout = dataStreamCreateDataStreamTimeout(session, reader, () => buffer.byteLength);
  // ピアの FIN を検出したか。残バッファを処理し終えてからループを抜ける
  let finished = false;
  try {
    while (true) {
      // 溜まっているバイトを先に処理する。
      //
      // 呼び出し元は SUBGROUP_HEADER をデコードした残りを initialBuffer として
      // 渡すため、header と Object が同じ chunk で届くとここで buffer に Object が
      // 入っている。read を先に待つと、その Object は次の chunk か FIN まで
      // 配信されない。進まなくなった時点で「Object の途中」と判断して read へ進む。
      // §12.5 (EXCESSIVE_LOAD): Subgroup ストリームの上限検査
      if (isDataStreamBufferOverLimit(session, buffer.byteLength)) {
        const detail = `trackAlias=${header.trackAlias}, buffered=${buffer.byteLength}`;
        await cancelStreamQuiet(reader, dataStreamBufferOverflowReason(session, detail));
        const error = createDataStreamBufferOverflowError(session, detail);
        // 該当 Track Alias に登録された購読を失敗させる。アプリへの error 通知と closed 化に加え、
        // bidi リクエストストリームの cancel (STOP_SENDING 相当) と Map の掃除、
        // onRequestDrained まで行う (markClosed だけでは state が先に closed になり、
        // アプリからの unsubscribe が no-op になって publisher 側の購読が残る)。
        // bidiCancelSubscriptionWithError は同期区間で subscribersByAlias の配列から
        // 購読を splice するため、走査前に複製して取りこぼしを防ぐ
        // (cancelMalformedTrackPeers と同じ)。
        for (const subscriber of subscribers.slice()) {
          void bidi.bidiCancelSubscriptionWithError(
            session as unknown as bidi.BidiSessionInternal,
            subscriber,
            error,
          );
        }
        return;
      }

      while (buffer.byteLength > 0) {
        const before = buffer.byteLength;
        try {
          const processResult = dataStreamProcessSubgroupObjects(
            session,
            buffer,
            subscribers,
            header,
            previousObjectId,
            resolvedSubgroupId,
          );
          buffer = processResult.remainingBuffer;
          previousObjectId = processResult.previousObjectId;
          resolvedSubgroupId = processResult.resolvedSubgroupId;
          // draft-ietf-moq-transport-21 §12.1 条件 4:
          // 確定した Group 最終 Object を Group 単位で記録する。Subgroup ストリームを
          // またいだ後続 Object の malformed 検出に使う。
          if (processResult.updatedEndOfGroupFinalObjectId !== undefined) {
            session.receivedEndOfGroupFinalObjectIds.set(
              `${header.trackAlias}:${header.groupId}`,
              processResult.updatedEndOfGroupFinalObjectId,
            );
          }
        } catch (err) {
          if (err instanceof MalformedTrackError) {
            // draft-ietf-moq-transport-21 §12.1:
            // malformed track を検出した購読を cancel し、セッションは閉じない
            await dataStreamHandleMalformedSubgroupTrack(session, reader, header, subscribers, err);
            return;
          }
          throw err;
        }
        if (buffer.byteLength >= before) break;
      }

      // FIN 済みなら、残バッファを処理し終えた時点で抜ける
      if (finished) break;

      // draft-ietf-moq-transport-21 §12.2 (DATA_STREAM_TIMEOUT):
      // 途中バイトを保持したまま次のチャンクを待つ間だけ期限を張る。
      if (buffer.byteLength > 0) {
        timeout.arm();
      } else {
        timeout.clear();
      }

      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        if (pendingRead !== null) {
          result = await pendingRead;
          pendingRead = null;
        } else {
          result = await reader.read();
        }
      } catch (err) {
        dataStreamHandleSubgroupReadError(err);
        // ピアの RESET_STREAM。配信済みの Object を保ち、この stream だけを終える
        dataStreamNotifySubgroupEnd(
          subscribers,
          header,
          resolvedSubgroupId,
          "reset",
          peerStreamErrorCode(err),
        );
        return;
      }

      if (result.value && result.value.byteLength > 0) {
        const next = new Uint8Array(buffer.byteLength + result.value.byteLength);
        next.set(buffer);
        next.set(result.value, buffer.byteLength);
        buffer = next;
      }

      if (result.done) finished = true;
    }
  } finally {
    timeout.clear();
  }

  // ここに到達した時点でピアの FIN を検出している (上記ループは
  // result.done でしか抜けない)。
  dataStreamFinishSubgroupStream(session, subscribers, header, buffer, resolvedSubgroupId);
}

/**
 * ピアの FIN で終わった Subgroup の stream を締めくくる
 *
 * draft-ietf-moq-transport-21 Section 11.3 (Streams):
 * "If a stream ends gracefully (i.e., the stream terminates with a
 *  FIN) in the middle of a serialized Object, the session SHOULD be
 *  closed with a PROTOCOL_VIOLATION."
 * §11.3.2 (Closing Subgroup Streams) は全 Object を配信せずに閉じる場合
 * の reset を MUST としており、残バッファ非空の FIN は違反ワイヤである。
 * 黙殺して関数を抜けるとアプリはオブジェクト欠落を検知できないため、
 * PROTOCOL_VIOLATION でセッションを閉じる (Fetch 側の判定は
 * handleIncomingStream の終了処理にある)。
 * pending mode (subscribers 未登録) は payload を decode しておらず
 * 未完成 Object を機械的に判定できないため、subscriber mode だけの
 * 対象とする。closeWithError はセッション終了済みだと呼ばない
 * (終了済みセッションへの spurious な通知を防ぐため)
 *
 * 未完成 Object を残さずに終わった stream は、購読へ stream の終わりを知らせる
 * (dataStreamNotifySubgroupEnd)。
 */
function dataStreamFinishSubgroupStream(
  session: DataStreamSessionInternal,
  subscribers: SubscriberImpl[],
  header: SubgroupHeader,
  buffer: Uint8Array,
  resolvedSubgroupId: bigint | undefined,
): void {
  if (session.sessionState === "connected" && buffer.byteLength > 0) {
    session.closeWithError(
      new SessionError(
        `subgroup data stream ended with incomplete object: trackAlias=${header.trackAlias}, groupId=${header.groupId}, remaining ${buffer.byteLength} bytes`,
        SessionErrorCode.PROTOCOL_VIOLATION,
      ),
    );
    return;
  }
  dataStreamNotifySubgroupEnd(subscribers, header, resolvedSubgroupId, "fin");
}

/**
 * 購読の Subgroup の stream の終わりを、その stream の Object を受け取っていた購読へ知らせる
 *
 * draft-ietf-moq-transport-21 Section 2.1: Object は順不同で届きうる。Group ごとに別の
 * stream で届くため、アプリは stream の終わりで、それ以上その Subgroup の Object が
 * 届かないと判断できる (SubscribeCallbacks.subgroupEnd)。Subgroup ID は Object から
 * 確定した値を優先し、無ければ Subgroup Header の値を使う。RESET_STREAM で終わった場合は、
 * その error code (Section 12.5) を添える。
 * アプリ例外は Object の配送と同じく当該購読の error コールバックへ通知し、残りの購読への
 * 通知を続ける。反復前に複製する (error コールバック内の unsubscribe() が配列を変更
 * しても後続の購読への通知が欠けないようにする)。
 */
function dataStreamNotifySubgroupEnd(
  subscribers: SubscriberImpl[],
  header: SubgroupHeader,
  resolvedSubgroupId: bigint | undefined,
  reason: "fin" | "reset",
  errorCode?: DataStreamErrorCode,
): void {
  const subgroupId = resolvedSubgroupId ?? header.subgroupId;
  const end: SubgroupStreamEnd = {
    groupId: header.groupId,
    reason,
    ...(subgroupId !== undefined ? { subgroupId } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
  };
  for (const subscriber of subscribers.slice()) {
    try {
      subscriber.handleSubgroupEnd(end);
    } catch (err) {
      try {
        subscriber.handleError(err instanceof Error ? err : new Error(String(err)));
      } catch {
        // error コールバック自体の throw は、残りの購読への通知を止めない
      }
    }
  }
}

/**
 * fill fetch ストリームが上限を超えていたら打ち切る
 *
 * draft-ietf-moq-transport-21 §12.5 (EXCESSIVE_LOAD 0x9) / §3.4.1:
 * 残バッファを破棄し、関連付けを消してアプリへ fillError で失敗を伝える
 * (購読は継続する)。FIN 時の未完成 Object 判定や正常終了の後始末へは到達させない。
 *
 * @returns 打ち切ったなら true (呼び出し元は return する)
 */
async function dataStreamAbortFillOnBufferOverflow(
  session: DataStreamSessionInternal,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  fillRequestId: bigint,
  target: bidi.FillFetchTarget,
  bufferedBytes: number,
): Promise<boolean> {
  if (!isDataStreamBufferOverLimit(session, bufferedBytes)) {
    return false;
  }
  const detail = `requestId=${fillRequestId}, buffered=${bufferedBytes}`;
  await cancelStreamQuiet(reader, dataStreamBufferOverflowReason(session, detail));
  session.fillFetchTargets.delete(fillRequestId);
  try {
    target.subscriber.handleFillError(createDataStreamBufferOverflowError(session, detail));
  } catch (callbackError) {
    // アプリの fillError コールバックの throw は握り潰す (後始末を止めない)
    session.emitCallbackErrorDebug("FILL_ERROR_CALLBACK_ERROR", callbackError);
  }
  return true;
}

/**
 * 受信バッファが上限を超えたかを判定する
 *
 * draft-ietf-moq-transport-21 §12.5 (EXCESSIVE_LOAD 0x9):
 * 壊れた / 悪意あるピアが 1 本のデータストリームで無制限にメモリを消費するのを防ぐ。
 * 上限 0 以下は無制限を意味する。各受信ループはチャンクを追記した直後 (初回は
 * ヘッダー解析後の残バッファ) にこの判定を行い、打ち切りの手順は経路ごとの
 * abort ヘルパー (dataStreamAbortFetchOnBufferOverflow /
 * dataStreamAbortFillOnBufferOverflow / Subgroup ループ内) が担う。
 */
function isDataStreamBufferOverLimit(
  session: DataStreamSessionInternal,
  bufferedBytes: number,
): boolean {
  return session.dataStreamMaxBufferBytes > 0 && bufferedBytes > session.dataStreamMaxBufferBytes;
}

/**
 * 上限超過による打ち切りの reason 文字列
 *
 * cancelStreamQuiet は文字列 reason しか受け取れず wire のエラーコードを送れないため、
 * 既存の malformed 打ち切りと同じ書式で EXCESSIVE_LOAD のコードを含める。
 */
function dataStreamBufferOverflowReason(
  session: DataStreamSessionInternal,
  detail: string,
): string {
  return `data stream buffer limit exceeded: code=${DataStreamErrorCode.EXCESSIVE_LOAD}, limit=${session.dataStreamMaxBufferBytes}, ${detail}`;
}

/**
 * 上限超過をアプリへ伝えるエラー
 *
 * ピアの RESET_STREAM 経路 (createFetchDataStreamResetError) と同じ形にし、
 * 読み取り失敗値の streamErrorCode とコード名・値をメッセージの両方に載せて、
 * アプリが理由 (EXCESSIVE_LOAD) を判別できるようにする。
 */
function createDataStreamBufferOverflowError(
  session: DataStreamSessionInternal,
  detail: string,
): Error & { streamErrorCode: DataStreamErrorCode } {
  const error = new Error(
    `data stream buffer limit exceeded: limit=${session.dataStreamMaxBufferBytes}, ${detail}: EXCESSIVE_LOAD(0x${DataStreamErrorCode.EXCESSIVE_LOAD.toString(16)})`,
  ) as Error & { streamErrorCode: DataStreamErrorCode };
  error.streamErrorCode = DataStreamErrorCode.EXCESSIVE_LOAD;
  return error;
}

/**
 * データストリームの受信待ちタイマーを作る
 *
 * draft-ietf-moq-transport-21 §12.2:
 * DATA_STREAM_TIMEOUT (0x12) は「ピアが開いたデータストリームで送るべき
 * データを送るのに時間をかけすぎた」ことを示す。半端なヘッダー / Object を
 * 保持したまま待ち続けるピアにメモリとコネクションを占有され続けないよう、
 * 途中バイトが残っている間だけ期限を張る。
 *
 * 期限切れではセッションを閉じたうえで reader を cancel する。セッション終了で
 * ストリームの読み取りが終わらない実装でも読み取りループが終わるようにするため
 * である。
 *
 * @param reader - 対象ストリームの reader
 * @param bufferedBytes - エラーメッセージに載せる残バッファ長
 */
export function dataStreamCreateDataStreamTimeout(
  session: DataStreamSessionInternal,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  bufferedBytes: () => number,
): { arm: () => void; clear: () => void } {
  let handle: ReturnType<typeof setTimeout> | null = null;
  const clear = (): void => {
    if (handle !== null) {
      clearTimeout(handle);
      handle = null;
    }
  };
  const arm = (): void => {
    clear();
    if (session.dataStreamTimeoutMs <= 0) {
      return;
    }
    handle = setTimeout(() => {
      handle = null;
      if (session.sessionState === "connected") {
        session.closeWithError(
          new SessionError(
            `data stream timed out waiting for the rest of a header or object: ${bufferedBytes()} bytes buffered`,
            SessionErrorCode.DATA_STREAM_TIMEOUT,
          ),
        );
      }
      void reader.cancel("data stream timeout").catch(() => {});
    }, session.dataStreamTimeoutMs);
  };
  return { arm, clear };
}
