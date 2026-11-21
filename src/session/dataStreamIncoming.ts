/**
 * 受信データストリーム処理の free function 群
 *
 * SessionImpl の startIncomingStreamLoop / startDatagramLoop /
 * handleIncomingStream / handleFillFetchStream / dataStreamHandleSubgroupStream /
 * handleIncomingStreamError / handleMalformedFetchTrack /
 * handleMalformedSubgroupTrack / handlePeerFetchStreamReset /
 * processFetchObjects / processSubgroupObjects / createDataStreamTimeout
 * を free function として抽出する。
 *
 * draft-ietf-moq-transport-23 §11.3 (Subgroup Streams) / §11.4 (Fetch Streams) /
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
import { ReceiveBuffer } from "../bytes";
import { decodeVarint } from "../varint";
import type { FetcherImpl } from "../fetcher";
import type { PendingObjectProperties } from "../dataStream/moqtObject";
import type { SubscriberImpl } from "../subscriber";
import type { PendingSubgroupBuffer } from "../pendingSubgroupBuffer";
import * as bidi from "./bidi";
import { incomingProcessFetchObjects, incomingProcessSubgroupObjects } from "./incoming";
import { isPeerStreamError, isSessionClosedError, toSessionCloseError } from "./errors";
import { cancelStreamQuiet, type FetchGapSemantics } from "./stream";
import type { SessionInternal } from "./types";
import type { ConnectCallbacks, SessionState, SubgroupStreamEnd } from "./publicTypes";
import {
  assertAndRecordFetchTrailingGap,
  recordReceivedSubgroupFin,
  type PriorGapTracking,
} from "./priorGapTracking";
import { recordEndOfGroupFinalObjectId, type EndOfGroupTracking } from "./endOfGroupTracking";
import type { FullTrackNameKey } from "../fullTrackName";
import { receivedPriority, type ReceivedPriority } from "./receivedPriority";

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

  // draft-ietf-moq-transport-23 §12.2: データストリームの受信タイムアウト
  dataStreamTimeoutMs: number;
  // draft-ietf-moq-transport-23 §12.5 (EXCESSIVE_LOAD 0x9):
  // 確立後の受信データストリームが保持してよいバッファの上限 (バイト)。
  // 0 以下は上限なし。
  dataStreamMaxBufferBytes: number;
  // draft-ietf-moq-transport-23 §12.5 (EXCESSIVE_LOAD 0x9):
  // 確立後の受信データストリームがセッション全体で保持してよいバッファの合計上限
  // (バイト)。0 以下は上限なし。
  dataStreamMaxTotalBufferBytes: number;
  // 確立後の受信データストリームがセッション全体で保持しているバッファの合計 (バイト)。
  // 増減は dataStreamBufferBytesAdd / dataStreamBufferBytesRelease に閉じる。
  dataStreamBufferedBytesTotal: number;

  readonly pendingFetch: ReadonlyMap<bigint, { readonly impl: FetcherImpl }>;
  readonly fetchers: Map<bigint, FetcherImpl>;
  readonly fillFetchTargets: Map<bigint, bidi.FillFetchTarget>;
  readonly subscribersByAlias: Map<bigint, SubscriberImpl[]>;
  readonly pendingSubgroupBuffer: PendingSubgroupBuffer;
  readonly receivedEndOfGroupFinalObjectIds: EndOfGroupTracking;
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
  waitForPublishFillTarget(requestId: bigint): Promise<bidi.FillFetchTarget | null>;
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
  const buffer = new ReceiveBuffer();
  let headerParsed = false;
  let isFetchStream = false;

  // Fetch ストリーム用の状態
  let fetchHeader: FetchHeader | null = null;
  let fetcher: FetcherImpl | null = null;
  let fetchContext: FetchObjectContext | null = null;
  let isFirstFetchObject = true;
  let minimumBytes = 1;
  let pendingProperties: PendingObjectProperties | undefined;

  // draft-ietf-moq-transport-23 §12.2 (DATA_STREAM_TIMEOUT):
  // ヘッダーまたは Object の途中バイトを保持したまま待ち続けるピアを期限で
  // 打ち切る。バッファが空になった時点で期限を解除する。
  const timeout = dataStreamCreateDataStreamTimeout(session, reader, () => buffer.byteLength);
  const armTimeout = timeout.arm;
  const clearTimeoutHandle = timeout.clear;

  try {
    while (true) {
      // draft-ietf-moq-transport-23 §12.2 (DATA_STREAM_TIMEOUT):
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
        // 新しいチャンクをバッファに追加し、§12.5 で計上する
        dataStreamAppendChunk(session, buffer, value);
      }

      // ヘッダーがまだパースされていない場合
      if (!headerParsed && buffer.byteLength > 0) {
        try {
          const data = buffer.view();
          // 先頭のタイプを確認
          const [streamType] = decodeVarint(data, 0);

          const streamTypeNum = Number(streamType);

          if (streamTypeNum === FetchHeaderType) {
            // Fetch データストリーム
            isFetchStream = true;
            const [header, consumed] = decodeFetchHeader(data);
            fetchHeader = header;
            dataStreamConsumeBytes(session, buffer, consumed);
            clearTimeoutHandle();
            headerParsed = true;

            // ヘッダー解析後の処理 (統計の更新 / Fetcher の解決 / fill fetch への
            // 委譲 / 上限超過の判定と打ち切り) は専用のヘルパーへまとめる。上限判定を
            // FETCH_OK 待ちの await より前に置けるようにするためでもある
            // (dataStreamHandleParsedFetchHeader の JSDoc を参照)
            fetcher = await dataStreamHandleParsedFetchHeader(session, reader, header, buffer);
            if (fetcher === null) return;
          } else if (
            (streamTypeNum >= 0x10 && streamTypeNum <= 0x1f) ||
            (streamTypeNum >= 0x30 && streamTypeNum <= 0x3f) ||
            (streamTypeNum >= 0x50 && streamTypeNum <= 0x5f) ||
            (streamTypeNum >= 0x70 && streamTypeNum <= 0x7f)
          ) {
            // draft-ietf-moq-transport-23 §11.3.1:
            // SUBGROUP_ID_MODE = 0b11 のタイプ値
            // (0x16, 0x17, 0x1E, 0x1F, 0x36, 0x37, 0x3E, 0x3F) は予約値であり、
            // 受信した場合は INVALID_STREAM_HEADER でセッションを閉じなければならない
            if ((streamTypeNum & 0x06) === 0x06) {
              session.closeWithError(
                new SessionError(
                  `reserved subgroup header type: 0x${streamTypeNum.toString(16)}`,
                  SessionErrorCode.INVALID_STREAM_HEADER,
                ),
              );
              break;
            }

            // Subgroup ストリーム
            isFetchStream = false;
            const [header, consumed] = decodeSubgroupHeader(data);
            dataStreamConsumeBytes(session, buffer, consumed);
            clearTimeoutHandle();
            headerParsed = true;

            // 統計カウンターを更新
            session.statsSubgroupHeadersReceived++;

            // Subgroup ストリーム本体は専用ハンドラに委譲する
            // pending mode (subscriber 未登録) と subscriber mode を一貫して扱う
            // draft-ietf-moq-transport-23 §11.3.1 の buffer 経路はこのハンドラ内に集約
            await dataStreamHandleSubgroupStream(session, reader, header, buffer);
            return;
          } else if (streamTypeNum === 0x132b3e28) {
            // draft-ietf-moq-transport-23 §11.5.1 (Padding Streams):
            // "The receiver MUST discard all data received on a padding stream."
            // PADDING stream のデータはすべて読み捨てる。§12.5: 保持しないため、
            // 計上したバイトはここで解放する (drain は FIN まで続きうるため、
            // 解放を finally まで待つと合計が上限超過のまま固定され、その間に
            // 追記した他のストリームが巻き添えで打ち切られる)
            isFetchStream = false;
            headerParsed = true;
            dataStreamClearBuffer(session, buffer);
            await dataStreamDrainPaddingStream(reader);
            return;
          } else {
            // draft-ietf-moq-transport-23 §6.4.1 (Unidirectional Stream Types):
            // "An endpoint that receives an unknown stream type MUST close the session."
            // §12.2 の INVALID_STREAM_HEADER は「データストリーム / datagram の
            // Type が未知」にこのコードを割り当てている。
            session.closeWithError(
              new SessionError(
                `unknown unidirectional stream type: 0x${streamTypeNum.toString(16)}`,
                SessionErrorCode.INVALID_STREAM_HEADER,
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
          // SessionError (MALFORMED_KEY_VALUE 等) はそのコードのまま、
          // ProtocolViolationError は自身の code、IncompleteDataError は Object の
          // 構造破損として MALFORMED_OBJECT で閉じる
          const sessionError = toSessionCloseError(err, SessionErrorCode.MALFORMED_OBJECT);
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
      // (未解析のストリームは委譲して return、未知型や Fetcher 未解決は打ち切って
      // return する)、fetchHeader と fetcher は必ず設定されている。
      if (isDataStreamBufferOverLimit(session, buffer.byteLength)) {
        // 判定時のバッファ長を打ち切りの診断に載せる (解放後は超過を示さない)
        const overflow = dataStreamCaptureBufferOverflow(session, buffer.byteLength);
        // 打ち切りの await の前にこのストリームの計上分を解放する
        // (理由は dataStreamClearBuffer の JSDoc)
        dataStreamClearBuffer(session, buffer);
        await dataStreamAbortFetchOnBufferOverflow(session, reader, fetchHeader, fetcher, overflow);
        return;
      }

      // オブジェクトをパースして配信
      if (headerParsed && buffer.byteLength >= minimumBytes) {
        if (isFetchStream && fetcher && fetchHeader) {
          // Fetch オブジェクトをストリーミング処理
          // draft-ietf-moq-transport-23 Section 11.4.1.1 (Flags):
          // FETCH オブジェクトは prior context (前オブジェクトの groupId / subgroupId / publisherPriority)
          // を参照するシリアライゼーションフラグを持つため、複数チャンクに分割された場合に備えて
          // context と isFirst を caller 側で永続化する必要がある
          const fetchResult = dataStreamProcessFetchObjects(
            session,
            buffer.view(),
            fetcher,
            fetchContext,
            isFirstFetchObject,
          );
          dataStreamConsumeBytes(
            session,
            buffer,
            buffer.byteLength - fetchResult.remainingBuffer.byteLength,
          );
          fetchContext = fetchResult.context;
          isFirstFetchObject = fetchResult.isFirst;
          minimumBytes = fetchResult.minimumBytes;
          pendingProperties = fetchResult.pendingProperties;
        }
      } else if (
        pendingProperties !== undefined &&
        session.sessionState === "connected" &&
        fetcher?.state === "active"
      ) {
        pendingProperties.check(buffer.view());
      }

      if (done) break;
    }

    // ストリーム終了処理 (条件はループ内のオブジェクト解析部と対称)
    if (isFetchStream && fetcher && fetchHeader) {
      dataStreamFinishFetchStream(session, fetchHeader, fetcher, buffer.byteLength, fetchContext);
    }
  } catch (err) {
    await dataStreamHandleIncomingStreamError(session, err, reader, fetchHeader, fetcher);
  } finally {
    clearTimeoutHandle();
    // §12.5: ストリームが保持していた残りのバイトを合計から必ず解放する
    // (FIN / peer reset / cancel / 例外のすべての経路を通る)
    dataStreamClearBuffer(session, buffer);
    session.statsSubscriberStreamsActive--;
    reader.releaseLock();
  }
}

/**
 * FETCH ヘッダー解析後の受信処理
 *
 * draft-ietf-moq-transport-23 §3.2 (Fetch) / §3.4 (Fill Semantics) /
 * §12.5 (EXCESSIVE_LOAD 0x9):
 * 統計の更新、Fetcher の解決 (FETCH_OK 待ちを含む)、fill fetch への委譲、
 * 上限超過の判定と打ち切りを 1 か所にまとめる。
 *
 * ローカルのバッファ上限判定 (超過時は §12.5 の EXCESSIVE_LOAD で打ち切る) は
 * FETCH_OK を待つ await より前に同期区間で行う。追記した
 * チャンクの計上を await をまたいで残すと、待っている間に別のストリームが追記した
 * ときに、そちらが超過の原因と誤判定されて巻き添えで打ち切られる (超過の原因は
 * 待っているこのストリームである)。
 *
 * @returns 呼び出し元が return するか、解決済みの Fetcher と、このストリームの
 *   計上バイト数の更新値 (fill への委譲・上限超過の打ち切りでは 0。Fetcher が
 *   解決できなかった場合は残りをそのまま返し、呼び出し元の finally が解放する)
 */
async function dataStreamHandleParsedFetchHeader(
  session: DataStreamSessionInternal,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  header: FetchHeader,
  buffer: ReceiveBuffer,
): Promise<FetcherImpl | null> {
  // 統計カウンターを更新
  session.statsFetchHeadersReceived++;

  // Fetcher を検索
  // draft-ietf-moq-transport-23 §3.2 (Fetch):
  // FETCH_OK より先にデータストリームが到着する可能性がある
  const registered = session.fetchers.get(header.requestId) ?? null;

  // draft-ietf-moq-transport-23 §3.4 (Fill Semantics):
  // fill fetch ストリームの FETCH_HEADER は fill を要求した
  // SUBSCRIBE / REQUEST_UPDATE の Request ID を運ぶ。購読に
  // 紐付けて受信する。どちらにも該当しない Request ID は
  // 不明な FETCH として従来どおり扱う。
  const fillTarget = session.fillFetchTargets.get(header.requestId);
  if (fillTarget) {
    // §12.5: fill fetch ハンドラは同じバッファを引き継ぎ、終了時に解放する。
    await dataStreamHandleFillFetchStream(session, reader, header.requestId, fillTarget, buffer);
    return null;
  }

  const pending = registered === null ? session.pendingFetch.get(header.requestId) : undefined;
  const owner = registered ?? pending?.impl;
  if (owner !== undefined && !owner.claimDataStream()) {
    // §3.2.1: 重複ストリームの上限超過やリセットを最初のストリームに波及させない。
    dataStreamClearBuffer(session, buffer);
    void cancelStreamQuiet(reader, `duplicate fetch stream: requestId=${header.requestId}`);
    return null;
  }

  // ローカルのバッファ上限判定は Fetcher の解決 (FETCH_OK 待ち) を含むどの
  // await よりも前に同期区間で行う (超過時は §12.5 の EXCESSIVE_LOAD で
  // リセットする)。追記したチャンクの計上を await をまたいで残すと、待っている間に
  // 別のストリームが追記したときに、そちらが超過の原因と誤判定されて巻き添えで
  // 打ち切られる (超過の原因はこのストリームである)
  if (isDataStreamBufferOverLimit(session, buffer.byteLength)) {
    // 判定時のバッファ長を打ち切りの診断に載せる (解放後は超過を示さない)
    const overflow = dataStreamCaptureBufferOverflow(session, buffer.byteLength);
    // 打ち切りの await の前にこのストリームの計上分を解放する
    // (理由は dataStreamClearBuffer の JSDoc)
    dataStreamClearBuffer(session, buffer);
    // 確立済みなら Fetcher に通知し、応答待ちなら fetch() の Promise を reject する。
    await dataStreamAbortFetchOnBufferOverflow(session, reader, header, registered, overflow);
    return null;
  }

  if (registered) {
    return registered;
  }

  // draft-ietf-moq-transport-23 §3.4 / §3.4.1:
  // サーバー起点 PUBLISH の初期 fill fetch は PUBLISH の Request ID (サーバー発の
  // 奇数) を運ぶ。通常 FETCH (クライアント発の偶数 Request ID) とは待機先が
  // 異なるため、pendingFetch に無い奇数 ID は PUBLISH 初期 fill として待つ。
  if (pending === undefined && header.requestId % 2n === 1n) {
    let waitingForPublish = true;
    if (buffer.byteLength > 0) {
      // §3.4.1: リセットされたら Object は破棄する。PUBLISH が後から受理された場合に
      // 同じエラーを fillError で伝えるため、受信先の待機は既存の期限まで継続する。
      // FIN では、確立後に配送する Object のバイトを保持する。
      void reader.closed.catch(() => {
        if (waitingForPublish) dataStreamClearBuffer(session, buffer);
      });
    }
    const waitedTarget = await session.waitForPublishFillTarget(header.requestId);
    waitingForPublish = false;
    // 待機解除後は fillFetchTargets を再検索する (登録と data stream の順序は
    // 保証されない。通常 Fetcher だけを検索して打ち切らない)
    const lateFillTarget = session.fillFetchTargets.get(header.requestId);
    if (lateFillTarget !== undefined) {
      await dataStreamHandleFillFetchStream(
        session,
        reader,
        header.requestId,
        lateFillTarget,
        buffer,
      );
      return null;
    }
    if (waitedTarget === null) {
      void cancelStreamQuiet(reader, `unknown publish fill: requestId=${header.requestId}`);
      return null;
    }
    await dataStreamHandleFillFetchStream(session, reader, header.requestId, waitedTarget, buffer);
    return null;
  }

  if (pending !== undefined) {
    // §3.2.4: FETCH_OK を待って read() が止まっていても、データストリームの
    // RESET_STREAM を検出して要求を終える。FIN では応答後に保留分を処理する。
    void reader.closed.catch((error: unknown) => {
      if (
        isPeerStreamError(error) &&
        bidi.bidiFailPendingFetch(
          session as unknown as SessionInternal,
          header.requestId,
          bidi.createFetchDataStreamResetError(error),
        )
      ) {
        dataStreamClearBuffer(session, buffer);
      }
    });
  }
  const fetcher = await session.waitForFetcher(header.requestId);
  if (!fetcher) {
    // 未知の Request ID または要求の終了時は STOP_SENDING で受信を打ち切る (§3.2.4)。
    void cancelStreamQuiet(reader, `unknown fetcher: requestId=${header.requestId}`);
    return null;
  }
  return fetcher;
}

/**
 * PADDING ストリームの残りのデータを読み捨てる
 *
 * draft-ietf-moq-transport-23 §11.5.1 (Padding Streams):
 * "The receiver MUST discard all data received on a padding stream."
 * FIN まで読み切ってから呼び出し元が終了する。§12.5 で計上したバイトは保持しない
 * ため、呼び出し元が drain の前に解放する (FIN しないピアに合計を占有させない)。
 */
async function dataStreamDrainPaddingStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  let streamDone = false;
  while (!streamDone) {
    const next = await reader.read();
    streamDone = next.done;
  }
}

/**
 * FETCH データストリームが FIN したときの終了処理
 *
 * ループ最終反復で buffer は remainingBuffer に更新済みであり、ここに残る =
 * FIN 時点で未完了 Object の途中バイト。
 * draft-ietf-moq-transport-23 §11.3 (Streams):
 * "If a stream ends gracefully (i.e., the stream terminates with a
 *  FIN) in the middle of a serialized Object, the receiver SHOULD close the
 *  session with TRUNCATED_OBJECT."
 * fetcher.handleEnd() も fetchers.delete も行わず、セッションを
 * TRUNCATED_OBJECT で閉じる (fetcher の無効化はセッション終了側に委ねる)。
 * close() を経ずに sessionState が closed へ遷移する経路でも、fetcher の扱いは
 * 同じである。transport.closed の処理と、受信ループがセッション終了を先に検出した
 * sessionNotifyErrorIfActive の分岐は、どちらも sessionFinishTermination で
 * request 系オブジェクトを closed にする。いずれの close 済み経路でも end を通知せず
 * return する (未完成 Object を正常終了として扱わないため)。closeWithError は
 * セッション終了済みだと呼ばない (終了済みセッションへの spurious な通知を防ぐため)。
 *
 * 残バッファが無ければ正常終了として handleEnd を通知し、fetchers からの削除、
 * 購読も尽きた Track の Prior ID Gap 追跡の掃除、onRequestDrained まで行う。
 */
function dataStreamFinishFetchStream(
  session: DataStreamSessionInternal,
  fetchHeader: FetchHeader,
  fetcher: FetcherImpl,
  remainingBytes: number,
  finalContext: FetchObjectContext | null,
): void {
  if (remainingBytes > 0) {
    if (session.sessionState === "connected") {
      session.closeWithError(
        new SessionError(
          `fetch data stream ended with incomplete object: requestId=${fetchHeader.requestId}, remaining ${remainingBytes} bytes`,
          SessionErrorCode.TRUNCATED_OBJECT,
        ),
      );
    }
    return;
  }
  // draft-ietf-moq-transport-23 §3.2.2 (Gaps in a Fetch Stream):
  // "Gaps at the end of a stream are only detectable when the stream is
  //  terminated by a FIN."
  // FIN 時点で、最後にシリアライズされた位置から End Location までの無印の範囲を
  // 非存在として扱う。Range Filter を含む要求では無印の gap は Unknown であるため
  // 記録しない (assertAndRecordFetchTrailingGap が判定する)。要求範囲が確定した
  // 通常の FETCH だけを対象とし、fill fetch は範囲を保持していないため行わない。
  // malformed track と判定した場合、この関数を呼ぶ dataStreamHandleIncomingStream の
  // catch (dataStreamHandleIncomingStreamError) が同一 Track の購読 / FETCH を
  // cancel する。
  // セッション終了後は追跡状態が解放済みであり、再作成しない
  // (終了後に追跡状態を残さない)。閉じたセッションへの spurious な判定も避ける。
  if (session.sessionState === "connected" && fetcher.hasFetchRequestRange()) {
    const requestRange = fetcher.getFetchRequestRange();
    assertAndRecordFetchTrailingGap(
      { trackingByTrack: session.priorGapTrackingByTrack, trackKey: fetcher.getFullTrackNameKey() },
      {
        groupOrder: fetcher.getGroupOrder(),
        startLocation: requestRange.startLocation,
        endLocation: fetcher.endLocation,
        ...(finalContext?.lastSerializedLocation !== undefined
          ? {
              lastSerializedLocation: {
                group: finalContext.lastSerializedLocation.groupId,
                object: finalContext.lastSerializedLocation.objectId,
              },
            }
          : {}),
        rangeFiltersPresent: fetcher.getFetchRequestRangeFiltersPresent(),
      },
    );
  }
  fetcher.handleEnd();
  session.fetchers.delete(fetchHeader.requestId);
  // draft-ietf-moq-transport-23 §10.8 / §10.9:
  // FETCH の終了に伴い、購読も尽きた Track の Prior ID Gap 追跡を捨てる
  // (bidiCancelFetch と同じ後始末)。
  bidi.clearPriorGapTrackingIfUnused(
    session as unknown as SessionInternal,
    fetcher.getFullTrackNameKey(),
  );
  // draft-ietf-moq-transport-23 §6.6.1:
  // GOAWAY 受信後に Established fetch が無くなった時点で NO_ERROR で閉じる。
  session.onRequestDrained();
}

/**
 * fill fetch ストリームを受信する
 *
 * draft-ietf-moq-transport-23 §3.4 (Fill Semantics) / §3.4.1:
 * fill fetch ストリームは FETCH と同じオブジェクト framing で届き、
 * FIN は fill 完了 (関連付けを消す)、reset は fill 失敗として扱う。
 * オブジェクトは fillDelivered を true にして購読の object コールバックに
 * 渡す (handleFillObject 経由。subscription のフィルタ再適用は通さない)。
 * fill ストリームの reset / STOP_SENDING による通常の失敗は購読に波及しない
 * (§3.4.1)。ただし malformed track の検出は §12.1 が優先し、同一 Track の
 * 全購読と全 FETCH を cancel する。
 *
 * draft-ietf-moq-transport-23 §9.19.8 / §10.5:
 * Group Order が SUBSCRIBE_OK 待ちで未確定の場合は、Object をデコードする前に
 * 確定を待つ。確定値はストリーム開始時にローカルへ固定し、デコード中に
 * target の値が変わることはない。
 */
export async function dataStreamHandleFillFetchStream(
  session: DataStreamSessionInternal,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  fillRequestId: bigint,
  target: bidi.FillFetchTarget,
  buffer: ReceiveBuffer,
): Promise<void> {
  if (target.reader !== undefined || target.subscriber.state === "closed") {
    dataStreamClearBuffer(session, buffer);
    await cancelStreamQuiet(reader, "fill stream already opened or subscription ended");
    return;
  }
  target.reader = reader;
  target.subscriber.startDataStreams();
  const timeout = dataStreamCreateDataStreamTimeout(session, reader, () => buffer.byteLength);
  let context: FetchObjectContext | null = null;
  let isFirst = true;
  let minimumBytes = 1;
  let pendingProperties: PendingObjectProperties | undefined;
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
    // draft-ietf-moq-transport-23 §11.4.1 Table 8 / §11.4.2.2:
    // fill fetch ストリームには対応する Fetcher が無いため、End of Track
    // indicator を通知する先が無い。Track 単位の終端位置は processFetchObjects が
    // priorGap の追跡へ記録する。
    handleEndOfTrack: (): void => {},
    isReceiving: () => target.reader === reader,
  };
  let finished = false;
  try {
    // §12.5: ヘッダーの残りはすでに計上済み。確立の await より先に上限を適用する。
    if (isDataStreamBufferOverLimit(session, buffer.byteLength)) {
      await dataStreamAbortFillOnBufferOverflow(session, reader, fillRequestId, target, buffer);
      return;
    }
    // §9.19.8 / §10.5: GROUP_ORDER が省略されていれば、SUBSCRIBE_OK の
    // Track Properties を待つ。読み取り中は同じ Group Order で復号する (§11.4.1.1)。
    const groupOrderSettled = await bidi.waitForFillFetchTargetGroupOrder(target, reader.closed);
    if (!groupOrderSettled || target.reader !== reader) {
      // 購読が成立せず Group Order を確定できないときは、fill を打ち切る (§3.4.1)。
      dataStreamClearBuffer(session, buffer);
      await cancelStreamQuiet(reader, `unresolved fill group order: requestId=${fillRequestId}`);
      bidi.deleteFillFetchTarget(session, fillRequestId);
      return;
    }
    const groupOrder = target.groupOrder;
    while (true) {
      // FETCH_HEADER と同じチャンクにある Object も、次の read を待つ前に配送する。
      if (buffer.byteLength >= minimumBytes) {
        const result = incomingProcessFetchObjects(
          session as unknown as SessionInternal,
          buffer.view(),
          sink,
          context,
          isFirst,
          groupOrder,
          // fill fetch ストリーム経由のため fill 側統計に計上する
          true,
          // fill fetch の追跡対象 Track は関連付けられた購読が持つ比較キーで決まる
          target.subscriber.getFullTrackNameKey(),
        );
        dataStreamConsumeBytes(
          session,
          buffer,
          buffer.byteLength - result.remainingBuffer.byteLength,
        );
        context = result.context;
        isFirst = result.isFirst;
        minimumBytes = result.minimumBytes;
        pendingProperties = result.pendingProperties;
      } else if (pendingProperties !== undefined && session.sessionState === "connected") {
        pendingProperties.check(buffer.view());
      }

      if (target.reader !== reader) return;
      if (finished) break;

      // §12.2: Object の途中バイトを保持して次の read を待つ間だけ期限を張る。
      if (buffer.byteLength > 0) timeout.arm();
      const { value, done } = await reader.read();
      timeout.clear();
      if (target.reader !== reader) return;
      if (value) {
        // §12.5: チャンクの追記と上限判定は同じターンで行う。
        dataStreamAppendChunk(session, buffer, value);
        if (isDataStreamBufferOverLimit(session, buffer.byteLength)) {
          await dataStreamAbortFillOnBufferOverflow(session, reader, fillRequestId, target, buffer);
          return;
        }
      }
      finished = done;
    }

    // FIN 時に未完了 Object の途中バイトが残る場合は FETCH と同様に
    // TRUNCATED_OBJECT でセッションを閉じる (§11.3)。
    if (buffer.byteLength > 0) {
      if (session.sessionState === "connected") {
        session.closeWithError(
          new SessionError(
            `fill fetch data stream ended with incomplete object: requestId=${fillRequestId}, remaining ${buffer.byteLength} bytes`,
            SessionErrorCode.TRUNCATED_OBJECT,
          ),
        );
      }
      return;
    }
    // FIN は fill 完了であり、関連付けを消す。購読自体は継続する (§3.4.1)。
    bidi.deleteFillFetchTarget(session, fillRequestId);
  } catch (err) {
    timeout.clear();
    session.emitDataStreamErrorDebug(err, { type: FetchHeaderType, requestId: fillRequestId });
    // エラー時は fill ストリームを使えない (reset / 失敗) ため関連付けを消す。
    // 購読自体は継続する (§3.4.1)。
    bidi.deleteFillFetchTarget(session, fillRequestId);
    // draft-ietf-moq-transport-23 §8.3:
    // 既知 Type の serialization 不一致は SessionError (MALFORMED_KEY_VALUE)
    // として届くため、エラーコードを保持したまま閉じる (他の受信経路と同じ)。
    const sessionError = toSessionCloseError(err, SessionErrorCode.MALFORMED_OBJECT);
    const normalizedError = err instanceof Error ? err : new Error(String(err));
    if (sessionError !== null) {
      session.closeWithError(sessionError);
    } else if (err instanceof MalformedTrackError) {
      // draft-ietf-moq-transport-23 §12.1:
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
      // draft-ietf-moq-transport-23 §3.4.1:
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
  } finally {
    timeout.clear();
    // §12.5: ストリームが保持していた残りのバイトを合計から必ず解放する
    // (正常終了 / 未完成 Object の FIN / 上限超過 / 例外のすべての経路を通る)
    dataStreamClearBuffer(session, buffer);
    target.reader = undefined;
    target.subscriber.finishDataStream();
  }
  // 統計と reader ロックの後始末は呼び出し元の handleIncomingStream の
  // finally に委ねる (Subgroup 経路と同パターン)。
}

/**
 * Malformed Track 検出時の FETCH キャンセル処理
 *
 * draft-ietf-moq-transport-23 §12.1 (Malformed Tracks):
 * Malformed Track 検出時は「cancel any corresponding subscription or fetches
 * for that Track from that publisher」であり、セッションを閉じない。
 * まず受信データストリームを STOP_SENDING 相当 (cancelStreamQuiet) で打ち切る。
 * fetcher が存在する場合 (FETCH データストリーム)、fetcher の error コールバックで
 * アプリへ通知し (§12.1 SHOULD)、FetcherImpl.cancel() 経由で
 * draft-ietf-moq-transport-23 §3.2.4 の MUST「It MUST send STOP_SENDING for
 * the bidi request stream.」に従い bidi リクエストストリームへ STOP_SENDING
 * を送り、fetchers Map から削除する。
 *
 * §12.1 の「fetches for that Track」に従い、同一 Full Track Name の全購読と
 * 全 FETCH を cancel する (cancelMalformedTrackPeers)。fetch() は
 * requestsSendRequest で新規 bidi ストリームを開き、送信の完了後に requestStreams に
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
    // draft-ietf-moq-transport-23 §12.1:
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
 * - ProtocolViolationError は自身の code でセッションを閉じる
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
  // SessionError (MALFORMED_KEY_VALUE 等) はそのコードのまま、
  // ProtocolViolationError は自身の code、IncompleteDataError は Object の
  // 構造破損として MALFORMED_OBJECT で閉じる
  const sessionError = toSessionCloseError(err, SessionErrorCode.MALFORMED_OBJECT);
  if (sessionError !== null) {
    session.closeWithError(sessionError);
    return;
  }
  if (err instanceof MalformedTrackError) {
    await dataStreamHandleMalformedFetchTrack(session, reader, err, fetcher);
    return;
  }
  if (fetchHeader !== null && isPeerStreamError(err)) {
    // draft-ietf-moq-transport-23 §3.2.4:
    // FETCH データストリームの reset で subscriber は FETCH state を破棄する。
    // fetchHeader が無い場合 (FETCH_HEADER 読取前の reset) は fetcher を
    // 特定できないため何もしない。
    dataStreamHandlePeerFetchStreamReset(session, err, fetchHeader, fetcher);
  }
}

/**
 * FETCH データストリームを上限超過として打ち切る
 *
 * ピアの RESET_STREAM と同じくアプリへ error を通知してから fetcher を closed にし、
 * fetchers から削除、Prior ID Gap 追跡の掃除、onRequestDrained まで行う (正常終了の
 * handleEnd は通知しない)。セッションは閉じない。
 *
 * draft-ietf-moq-transport-23 §3.2.4:
 * 「If the data stream is already open, the subscriber wishing to cancel the FETCH
 *  MAY send STOP_SENDING for the data stream as well as the bidi request stream.
 *  It MUST send STOP_SENDING for the bidi request stream.」
 * データストリームへの STOP_SENDING は MAY であり、この経路は cancelStreamQuiet で
 * 既にデータストリームを打ち切っているため、重ねて送らない。
 * ローカル判断で FETCH state を破棄する本経路は cancel に当たるため、fetcher.cancel()
 * で bidi リクエストストリームへ STOP_SENDING を送る (markClosed だけでは state が
 * 先に closed になり、アプリからの cancel() が no-op になって MUST を満たせない)。
 * cancel() が fetchers / requestStreams の削除と Prior ID Gap 追跡の掃除、
 * onRequestDrained まで行う。
 *
 * draft-ietf-moq-transport-23 §12.5 (EXCESSIVE_LOAD 0x9):
 * 呼び出し元が上限超過を判定し、打ち切りの await の前にこのストリームの計上分を
 * 解放してから呼ぶ (dataStreamClearBuffer を参照)。FETCH_OK より
 * 先にデータストリームが届いた場合は、対応する fetch() の失敗を先に確定する。
 */
async function dataStreamAbortFetchOnBufferOverflow(
  session: DataStreamSessionInternal,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  fetchHeader: FetchHeader | null,
  fetcher: FetcherImpl | null,
  overflow: DataStreamBufferOverflow,
): Promise<void> {
  const target = fetchHeader === null ? "requestId=unknown" : `requestId=${fetchHeader.requestId}`;
  if (fetchHeader !== null && fetcher === null && session.pendingFetch.has(fetchHeader.requestId)) {
    bidi.bidiFailPendingFetch(
      session as unknown as SessionInternal,
      fetchHeader.requestId,
      createDataStreamBufferOverflowError(session, overflow, target),
    );
  }
  await cancelStreamQuiet(reader, dataStreamBufferOverflowReason(session, overflow, target));
  if (fetcher === null) return;
  const error = createDataStreamBufferOverflowError(session, overflow, target);
  try {
    fetcher.handleError(error);
  } catch {
    // アプリの error コールバックの throw は握り潰す (後始末は継続する)
  }
  await fetcher.cancel().catch(() => {});
}

/**
 * peer の RESET_STREAM で FETCH データストリームが終了したときの後始末
 *
 * draft-ietf-moq-transport-23 §3.2.4:
 * 「A subscriber keeps FETCH state until it cancels the request (see
 *  Section 6.4.2.3), receives FETCH_ERROR, or the FETCH data stream
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
    // draft-ietf-moq-transport-23 §10.8 / §10.9:
    // peer の RESET_STREAM による FETCH の終了でも、購読も尽きた Track の
    // Prior ID Gap 追跡を捨てる (FIN 経路と同じ後始末)。
    if (fetcher) {
      bidi.clearPriorGapTrackingIfUnused(
        session as unknown as SessionInternal,
        fetcher.getFullTrackNameKey(),
      );
    }
    // draft-ietf-moq-transport-23 §6.6.1:
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
): ReturnType<typeof incomingProcessFetchObjects> {
  // draft-ietf-moq-transport-23 §3.2.2 (Gaps in a Fetch Stream):
  // 暗黙 gap を非存在として扱うには要求範囲 (Start / End Location) と Range
  // Filter の有無が必要である。要求範囲が確定している通常の FETCH だけがこれらを
  // 持ち、直接生成した FetcherImpl や fill fetch では渡さない。
  let fetchGap: FetchGapSemantics | undefined;
  if (fetcher.hasFetchRequestRange()) {
    const requestRange = fetcher.getFetchRequestRange();
    fetchGap = {
      startLocation: requestRange.startLocation,
      endLocation: fetcher.endLocation,
      rangeFiltersPresent: fetcher.getFetchRequestRangeFiltersPresent(),
    };
  }
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
    fetchGap,
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
  priority?: ReceivedPriority,
): ReturnType<typeof incomingProcessSubgroupObjects> {
  return incomingProcessSubgroupObjects(
    session as unknown as SessionInternal,
    buffer,
    subscribers,
    header,
    previousObjectId,
    resolvedSubgroupId,
    priority,
  );
}

/**
 * Malformed Track (Object Property の Mandatory Track Property) を検出した
 * 同一 Track の全購読と全 FETCH を §12.1 に従って cancel する
 *
 * draft-ietf-moq-transport-23 §12.1:
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
  // draft-ietf-moq-transport-23 §12.1:
  // 同一 Track の全購読と全 FETCH を cancel する。比較キーは
  // trackAlias から購読を特定して得る (購読が未特定なら cancel 対象が無い)。
  const trackKey = subscribers[0]?.getFullTrackNameKey();
  const cancelled = cancelStreamQuiet(
    reader,
    `malformed track: trackAlias=${header.trackAlias}, reason=${error.message}`,
  );
  if (trackKey !== undefined) {
    bidi.cancelMalformedTrackPeers(session as unknown as SessionInternal, trackKey, error);
  }
  await cancelled;
}

/**
 * pending mode の Subgroup ストリームが読み取りエラーで終わったときの後始末
 *
 * ピアの RESET_STREAM 以外 (セッション終了など) は呼び出し元へ投げ直す。
 *
 * draft-ietf-moq-transport-23 §11.3.2 (Closing Subgroup Streams): 送信側は Subgroup の
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
  entry.notify("reset");
  session.pendingSubgroupBuffer.remove(entry);
  entry.clearBytes();
  await cancelStreamQuiet(reader, `pending subgroup reset: trackAlias=${header.trackAlias}`);
}

/**
 * Subgroup ストリームの読み取りがエラーで終わったときの判定
 *
 * draft-ietf-moq-transport-23 §11.3.2 (Closing Subgroup Streams): 送信側は Subgroup の
 * 残りを配らずに閉じるとき MUST で RESET_STREAM する。受信済みの Object は配信済みで
 * あり、続きは別の Subgroup / Group の stream で届く。セッションは閉じず、途中まで
 * 受けた Object の残りバイトだけを捨ててこの stream の処理を終える (未完成 Object で
 * FIN されたときの TRUNCATED_OBJECT とは異なる)。この仕様はドラフトであり将来
 * 変更されうる。ピア起因でないエラーは呼び出し元へ投げ直す。
 */
function dataStreamHandleSubgroupReadError(error: unknown): void {
  if (!isPeerStreamError(error)) {
    throw error;
  }
}

/**
 * pending mode (Track Alias 未確立) の Subgroup ストリームを購読が登録されるまで読む
 *
 * draft-ietf-moq-transport-23 §3.1.3.1 (Unknown Track Alias):
 * "When an endpoint receives a datagram or a new stream with a Track Alias that is
 *  not yet associated with an Established subscription, it MAY drop the data or
 *  buffer it briefly to handle reordering with the control message that
 *  establishes the Track Alias."
 * FIN 後も元の期限まで確立通知を待ち、保持したバイト列と FIN を subscriber mode に渡す。
 * timeout / overflow / Alias の解除 / セッション終了 / ピアの reset では
 * 破棄して null を返す (呼び出し元はそのストリームの処理を終える)。
 *
 * draft-ietf-moq-transport-23 §12.5 (EXCESSIVE_LOAD 0x9):
 * pending mode のバイトは pendingSubgroupBuffer の per-session 上限が管理するため
 * セッションの合計には載せない。呼び出し元が計上済みのヘッダー解析後の payload を
 * ここで解放し、subscriber mode へ合流した時点で改めて計上する。
 */
async function dataStreamHandlePendingSubgroupStream(
  session: DataStreamSessionInternal,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  header: SubgroupHeader,
  initialBuffer: ReceiveBuffer,
): Promise<{
  buffer: ReceiveBuffer;
  subscribers: SubscriberImpl[];
  pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null;
  finished: boolean;
} | null> {
  const entry = session.pendingSubgroupBuffer.add(header.trackAlias);
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  let finished = false;

  try {
    {
      // 未消費分だけを保留側へ渡す。ビューは読み取りや確立通知を待つ間は保持しない。
      const initialBytes = initialBuffer.view();
      dataStreamClearBuffer(session, initialBuffer);
      session.pendingSubgroupBuffer.appendChunk(entry, initialBytes);
    }
    while (entry.reason === null) {
      pendingRead = reader.read();
      const result = await entry.waitForRead(pendingRead);
      if (result === undefined || entry.reason !== null) {
        // 通知と同時に届いたチャンクは read ごと確立済み側へ渡す。二重に追加しない。
        break;
      }
      pendingRead = null;
      if (result.done) {
        // 制御メッセージが遅れても、受信済み Object と空の Subgroup の FIN を引き継ぐ。
        // read を繰り返さず、Alias の確立または保留の終了だけを待つ。
        finished = true;
        await entry.notified;
        break;
      }
      if (result.value.byteLength > 0) {
        session.pendingSubgroupBuffer.appendChunk(entry, result.value);
      }
    }
  } catch (error) {
    await dataStreamHandlePendingSubgroupReadError(session, reader, header, entry, error);
    return null;
  } finally {
    session.pendingSubgroupBuffer.remove(entry);
  }

  if (entry.reason === "subscriber") {
    const subscribers = session.subscribersByAlias.get(header.trackAlias);
    if (subscribers !== undefined && subscribers.length > 0) {
      const buffer = await dataStreamTakePendingSubgroupBuffer(
        session,
        reader,
        header,
        subscribers,
        entry,
      );
      return buffer === null ? null : { buffer, subscribers, pendingRead, finished };
    }
  }

  entry.clearBytes();
  await cancelStreamQuiet(
    reader,
    `pending subgroup ${entry.reason}: trackAlias=${header.trackAlias}`,
  );
  return null;
}

/**
 * pending mode のバッファを引き継ぎ、セッションの合計へ計上する
 *
 * draft-ietf-moq-transport-23 §3.1.3.1 (Unknown Track Alias) /
 * §12.5 (EXCESSIVE_LOAD 0x9):
 * 合流した直後の同期区間で上限を判定し、超過していれば計上分を解放して
 * Subgroup の打ち切り手順を行う。判定を呼び出し元の Subgroup ループ先頭まで
 * 遅らせると、async 関数の解決を待つ間に別のストリームが追記した場合に、
 * その追記が超過の原因と誤判定されて巻き添えで打ち切られる。合流で合計を
 * 押し上げたこのストリームが超過の原因である。
 *
 * @returns 合流したバッファ。上限を超えた場合は null (解放と打ち切りは済んでいる)
 */
async function dataStreamTakePendingSubgroupBuffer(
  session: DataStreamSessionInternal,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  header: SubgroupHeader,
  subscribers: SubscriberImpl[],
  entry: ReturnType<PendingSubgroupBuffer["add"]>,
): Promise<ReceiveBuffer | null> {
  const byteLength = entry.totalBytes;
  dataStreamBufferBytesAdd(session, byteLength);
  if (!isDataStreamBufferOverLimit(session, byteLength)) {
    return entry.takeBuffer();
  }
  // 判定時のバッファ長を打ち切りの診断に載せる (解放後は超過を示さない)
  const overflow = dataStreamCaptureBufferOverflow(session, byteLength);
  // 打ち切りの await の前にこのストリームの計上分を解放する
  // (理由は dataStreamClearBuffer の JSDoc)。
  dataStreamBufferBytesRelease(session, byteLength);
  entry.clearBytes();
  await dataStreamAbortSubgroupStreamOnOverflow(session, reader, header, subscribers, overflow);
  return null;
}

/**
 * Subgroup ストリームを処理する
 *
 * draft-ietf-moq-transport-23 §3.1.3.1 (Unknown Track Alias):
 * "When an endpoint receives a datagram or a new stream with a Track Alias that is
 *  not yet associated with an Established subscription, it MAY drop the data or
 *  buffer it briefly to handle reordering with the control message that
 *  establishes the Track Alias."
 *
 * subscriber が登録済みであれば即座に通常 mode で読み出す。
 * 未登録なら pending mode に入り、chunk 受信と subscriber 通知を並走させる。
 * 確立通知後は保留バッファを通常 mode に引き継ぐ。
 * 保留中に FIN した場合は、元の期限まで確立通知を待つ。
 * pending mode の読み取りは dataStreamHandlePendingSubgroupStream が担う。
 *
 * draft-ietf-moq-transport-23 §12.5 (EXCESSIVE_LOAD 0x9):
 * 呼び出し元の handleIncomingStream がヘッダー解析後の残バッファを計上済みである。
 * この関数はその計上を引き継ぎ、subscriber mode のループで増減する。
 */
export async function dataStreamHandleSubgroupStream(
  session: DataStreamSessionInternal,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  header: SubgroupHeader,
  initialBuffer: ReceiveBuffer,
): Promise<void> {
  let buffer = initialBuffer;
  let previousObjectId = -1n;
  let resolvedSubgroupId: bigint | undefined;
  let minimumBytes = 1;
  let pendingProperties: PendingObjectProperties | undefined;
  let subscribers: SubscriberImpl[] = session.subscribersByAlias.get(header.trackAlias) ?? [];
  // ピアの FIN 後は残バッファを処理し終えてからループを抜ける。
  let finished = false;

  // pending mode から持ち越された read Promise を最初の read として消費する
  // (ReadableStreamDefaultReader.read() は中断不能なため、pending mode が発火した
  //  read を破棄せず、subscriber mode の最初の read として使い切る)
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;

  if (subscribers.length === 0) {
    if (session.pendingSubgroupBuffer.isRetiredAlias(header.trackAlias)) {
      dataStreamClearBuffer(session, buffer);
      await cancelStreamQuiet(reader, `track alias retired: trackAlias=${header.trackAlias}`);
      return;
    }
    // pending mode (Track Alias 未確立) は購読が登録されるまで buffer it briefly する。
    const merged = await dataStreamHandlePendingSubgroupStream(session, reader, header, buffer);
    if (merged === null) return;

    // 合流時に引き継いだバイトがセッションの合計へ計上されている。
    buffer = merged.buffer;
    subscribers = merged.subscribers;
    pendingRead = merged.pendingRead;
    finished = merged.finished;
  }

  // subscriber mode: 通常の Subgroup ストリーム処理ループ
  // pendingRead が pending mode から持ち越されている場合はそれを最初の read として消費する
  // draft-ietf-moq-transport-23 §12.2 (DATA_STREAM_TIMEOUT):
  // 途中バイトを保持したまま次のチャンクを待つ間だけ期限を張る。
  const timeout = dataStreamCreateDataStreamTimeout(session, reader, () => buffer.byteLength);
  // 受信済みヘッダーの解釈は、同じ Alias の購読構成が途中で変わっても固定する。
  const priority = receivedPriority(header.publisherPriority, subscribers);
  const finishSubscriptionStreams = bidi.trackSubscriberSubgroupStream(subscribers, reader);
  try {
    while (subscribers.length > 0) {
      // 溜まっているバイトを先に処理する。
      //
      // 呼び出し元は SUBGROUP_HEADER をデコードした残りを initialBuffer として
      // 渡すため、header と Object が同じ chunk で届くとここで buffer に Object が
      // 入っている。read を先に待つと、その Object は次の chunk か FIN まで
      // 配信されない。進まなくなった時点で「Object の途中」と判断して read へ進む。
      // §12.5 (EXCESSIVE_LOAD): Subgroup ストリームの上限検査
      if (isDataStreamBufferOverLimit(session, buffer.byteLength)) {
        // 判定時のバッファ長を打ち切りの診断に載せる (解放後は超過を示さない)
        const overflow = dataStreamCaptureBufferOverflow(session, buffer.byteLength);
        // 打ち切りの await の前にこのストリームの計上分を解放する
        // (理由は dataStreamClearBuffer の JSDoc)
        dataStreamClearBuffer(session, buffer);
        await dataStreamAbortSubgroupStreamOnOverflow(
          session,
          reader,
          header,
          subscribers,
          overflow,
        );
        return;
      }

      if (
        pendingProperties !== undefined &&
        buffer.byteLength < minimumBytes &&
        session.sessionState === "connected"
      ) {
        pendingProperties.check(buffer.view());
      }
      while (buffer.byteLength >= minimumBytes && subscribers.length > 0) {
        const before = buffer.byteLength;
        try {
          const processResult = dataStreamProcessSubgroupObjects(
            session,
            buffer.view(),
            subscribers,
            header,
            previousObjectId,
            resolvedSubgroupId,
            priority,
          );
          dataStreamConsumeBytes(
            session,
            buffer,
            before - processResult.remainingBuffer.byteLength,
          );
          previousObjectId = processResult.previousObjectId;
          resolvedSubgroupId = processResult.resolvedSubgroupId;
          minimumBytes = processResult.minimumBytes;
          pendingProperties = processResult.pendingProperties;
          // draft-ietf-moq-transport-23 §12.1 条件 4:
          // 確定した Group 最終 Object を Group 単位で記録する。Subgroup ストリームを
          // またいだ後続 Object の malformed 検出に使う。上限を超えた分は追跡から
          // 外れるため、外れた Track Alias / Group では超過を検出できない
          // (検出漏れのみで誤検出は生まない)。
          if (
            subscribers.length > 0 &&
            processResult.updatedEndOfGroupFinalObjectId !== undefined
          ) {
            recordEndOfGroupFinalObjectId(
              session.receivedEndOfGroupFinalObjectIds,
              header.trackAlias,
              header.groupId,
              processResult.updatedEndOfGroupFinalObjectId,
            );
          }
        } catch (err) {
          if (err instanceof MalformedTrackError) {
            // draft-ietf-moq-transport-23 §12.1:
            // malformed track を検出した購読を cancel し、セッションは閉じない
            await dataStreamHandleMalformedSubgroupTrack(session, reader, header, subscribers, err);
            return;
          }
          throw err;
        }
        if (buffer.byteLength >= before) break;
      }

      if (subscribers.length === 0) return;

      // FIN 済みなら、残バッファを処理し終えた時点で抜ける
      if (finished) break;

      // draft-ietf-moq-transport-23 §12.2 (DATA_STREAM_TIMEOUT):
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

      // reader.cancel() は FIN と同じ done を返す。購読解除後は終端として登録しない。
      if (subscribers.length === 0) return;

      if (result.value && result.value.byteLength > 0) {
        // §12.5: 追記と、追記したバイト数のセッションの合計への計上
        dataStreamAppendChunk(session, buffer, result.value);
      }

      if (result.done) finished = true;
    }

    if (subscribers.length === 0) return;

    // 終了処理より先に計上分を解放する。FIN で未完成の Object が残っていたかは
    // 処理済みのバッファ本体を保持せず、残りバイト数だけで判定する。
    const remainingBytes = buffer.byteLength;
    dataStreamClearBuffer(session, buffer);
    await dataStreamFinishSubgroupStream(
      session,
      reader,
      subscribers,
      header,
      remainingBytes,
      resolvedSubgroupId,
      previousObjectId,
      priority,
    );
  } finally {
    timeout.clear();
    // §12.5: ストリームが保持していた残りのバイトを合計から必ず解放する
    // (FIN / peer reset / cancel / 例外のすべての経路を通る)
    dataStreamClearBuffer(session, buffer);
    finishSubscriptionStreams();
  }
}

/**
 * ピアの FIN で終わった Subgroup の stream を締めくくる
 *
 * draft-ietf-moq-transport-23 §11.3 (Streams):
 * "If a stream ends gracefully (i.e., the stream terminates with a
 *  FIN) in the middle of a serialized Object, the receiver SHOULD close the
 *  session with TRUNCATED_OBJECT."
 * §11.3.2 (Closing Subgroup Streams) は全 Object を配信せずに閉じる場合
 * の reset を MUST としており、残バッファ非空の FIN は違反ワイヤである。
 * 黙殺して関数を抜けるとアプリはオブジェクト欠落を検知できないため、
 * TRUNCATED_OBJECT でセッションを閉じる (Fetch 側の判定は
 * handleIncomingStream の終了処理にある)。
 * pending mode (subscribers 未登録) は payload を decode しておらず
 * 未完成 Object を機械的に判定できないため、subscriber mode だけの
 * 対象とする。closeWithError はセッション終了済みだと呼ばない
 * (終了済みセッションへの spurious な通知を防ぐため)
 *
 * 未完成 Object を残さずに終わった stream は、確定した Subgroup の最終 Object を
 * 記録する。END_OF_GROUP ビットがあれば Group の終端も記録する。
 */
async function dataStreamFinishSubgroupStream(
  session: DataStreamSessionInternal,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  subscribers: SubscriberImpl[],
  header: SubgroupHeader,
  remainingBytes: number,
  resolvedSubgroupId: bigint | undefined,
  lastObjectId: bigint | undefined,
  priority: ReceivedPriority,
): Promise<void> {
  if (session.sessionState === "connected" && remainingBytes > 0) {
    session.closeWithError(
      new SessionError(
        `subgroup data stream ended with incomplete object: trackAlias=${header.trackAlias}, groupId=${header.groupId}, remaining ${remainingBytes} bytes`,
        SessionErrorCode.TRUNCATED_OBJECT,
      ),
    );
    return;
  }
  // セッション終了後は追跡状態が解放済みであり、再作成しない
  // (終了後に追跡状態を残さない)。
  if (session.sessionState === "connected") {
    try {
      const subscriber = subscribers[0];
      if (
        subscriber !== undefined &&
        resolvedSubgroupId !== undefined &&
        lastObjectId !== undefined &&
        lastObjectId >= 0n
      ) {
        recordReceivedSubgroupFin(
          {
            trackingByTrack: session.priorGapTrackingByTrack,
            trackKey: subscriber.getFullTrackNameKey(),
          },
          {
            groupId: header.groupId,
            subgroupId: resolvedSubgroupId,
            objectId: lastObjectId,
            priority,
            endsGroup: header.endOfGroup === true,
          },
        );
      }
    } catch (err) {
      if (err instanceof MalformedTrackError) {
        // FIN の終端が既知の終端や受信済み Object と矛盾した。§12.1 に従い
        // 同一 Track の購読 / FETCH を cancel する。このストリームは FIN 済みで、
        // 取り消した購読には Subgroup の終了を通知しない。
        await dataStreamHandleMalformedSubgroupTrack(session, reader, header, subscribers, err);
        return;
      }
      throw err;
    }
  }
  dataStreamNotifySubgroupEnd(subscribers, header, resolvedSubgroupId, "fin");
}

/**
 * 購読の Subgroup の stream の終わりを、その stream の Object を受け取っていた購読へ知らせる
 *
 * draft-ietf-moq-transport-23 Section 2.1: Object は順不同で届きうる。Group ごとに別の
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
 * Subgroup ストリームを上限超過として打ち切る
 *
 * draft-ietf-moq-transport-23 §12.5 (EXCESSIVE_LOAD 0x9):
 * 残バッファを破棄し、該当 Track Alias に登録された購読を失敗させる。セッションは
 * 閉じない。呼び出し元が上限超過を判定し、打ち切りの await の前にこのストリームの
 * 計上分を解放してから呼ぶ (dataStreamClearBuffer を参照)。
 * subscriber mode のループ先頭と、pending mode からの合流直後の両方から使う。
 */
async function dataStreamAbortSubgroupStreamOnOverflow(
  session: DataStreamSessionInternal,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  header: SubgroupHeader,
  subscribers: SubscriberImpl[],
  overflow: DataStreamBufferOverflow,
): Promise<void> {
  const target = `trackAlias=${header.trackAlias}`;
  await cancelStreamQuiet(reader, dataStreamBufferOverflowReason(session, overflow, target));
  const error = createDataStreamBufferOverflowError(session, overflow, target);
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
}

/**
 * fill fetch ストリームを上限超過として打ち切る
 *
 * draft-ietf-moq-transport-23 §12.5 (EXCESSIVE_LOAD 0x9) / §3.4.1:
 * 残バッファを破棄し、関連付けを消してアプリへ fillError で失敗を伝える
 * (購読は継続する)。FIN 時の未完成 Object 判定や正常終了の後始末へは到達させない。
 * 呼び出し元が上限超過を判定する。この関数は判定時の容量を記録し、await の前に
 * このストリームの計上分を解放する (dataStreamClearBuffer を参照)。
 */
async function dataStreamAbortFillOnBufferOverflow(
  session: DataStreamSessionInternal,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  fillRequestId: bigint,
  target: bidi.FillFetchTarget,
  buffer: ReceiveBuffer,
): Promise<void> {
  const overflow = dataStreamCaptureBufferOverflow(session, buffer.byteLength);
  dataStreamClearBuffer(session, buffer);
  const detail = `requestId=${fillRequestId}`;
  await cancelStreamQuiet(reader, dataStreamBufferOverflowReason(session, overflow, detail));
  bidi.deleteFillFetchTarget(session, fillRequestId);
  try {
    target.subscriber.handleFillError(
      createDataStreamBufferOverflowError(session, overflow, detail),
    );
  } catch (callbackError) {
    // アプリの fillError コールバックの throw は握り潰す (後始末を止めない)
    session.emitCallbackErrorDebug("FILL_ERROR_CALLBACK_ERROR", callbackError);
  }
}

/**
 * チャンクを追記し、未消費のバイトをセッションの合計へ計上する。
 *
 * draft-ietf-moq-transport-23 §12.5 (EXCESSIVE_LOAD 0x9):
 * 上限の判定には未消費のバイト数を使う。再利用する配列の容量は計上しない。
 * 仕様の節番号と要件は将来の版で変わり得る。
 */
function dataStreamAppendChunk(
  session: DataStreamSessionInternal,
  buffer: ReceiveBuffer,
  chunk: Uint8Array,
): void {
  buffer.append(chunk);
  dataStreamBufferBytesAdd(session, chunk.byteLength);
}

/** ヘッダーや Object を消費した分だけ、バッファとセッションの合計を進める。 */
function dataStreamConsumeBytes(
  session: DataStreamSessionInternal,
  buffer: ReceiveBuffer,
  count: number,
): void {
  buffer.consume(count);
  dataStreamBufferBytesRelease(session, count);
}

/**
 * 受信データストリームが保持するバイト数をセッションの合計へ加算する
 *
 * draft-ietf-moq-transport-23 §12.5 (EXCESSIVE_LOAD 0x9):
 * 受信ループがチャンクをバッファへ追記した直後に、追記したバイト数だけ呼ぶ。
 * pending mode から subscriber mode へ合流するときは、pending に溜めていたバイトを
 * 合計へ載せるため、追記せずに呼ぶ (dataStreamTakePendingSubgroupBuffer)。
 * 合計の増減をこの関数と dataStreamBufferBytesRelease の 2 つに閉じることで、
 * バッファの持ち方 (連結した配列か offset 方式か) を変えても、呼び出し側の
 * 「追記したバイト数」「消費したバイト数」をそのまま使い続けられる。
 */
function dataStreamBufferBytesAdd(session: DataStreamSessionInternal, bytes: number): void {
  session.dataStreamBufferedBytesTotal += bytes;
}

/**
 * 受信データストリームがバッファから消費したバイト数をセッションの合計から減算する
 *
 * draft-ietf-moq-transport-23 §12.5 (EXCESSIVE_LOAD 0x9):
 * Object の配信とヘッダーの解析で消費した分に加え、ストリームの終了
 * (FIN / peer reset / cancel / 例外) ではそのストリームが保持していた残りを
 * finally で必ずこの関数へ渡す。減算漏れがあると合計が単調増加し、無関係な
 * ストリームが EXCESSIVE_LOAD で打ち切られる。
 */
function dataStreamBufferBytesRelease(session: DataStreamSessionInternal, bytes: number): void {
  session.dataStreamBufferedBytesTotal -= bytes;
}

/**
 * 受信バッファが上限を超えたかを判定する
 *
 * draft-ietf-moq-transport-23 §12.5 (EXCESSIVE_LOAD 0x9):
 * 壊れた / 悪意あるピアがデータストリームで無制限にメモリを消費するのを防ぐ。
 * ストリーム単位の上限 (bufferedBytes) に加え、セッション全体の合計
 * (session.dataStreamBufferedBytesTotal) も見る。ストリーム単位の上限だけでは、
 * 上限近くまで溜めたストリームを同時に何本も開けば合計が上限 × 本数まで増える。
 * 上限 0 以下は無制限を意味する。各受信ループはチャンクを追記した直後 (初回は
 * ヘッダー解析後の残バッファ) にこの判定を行い、打ち切りの手順は経路ごとの
 * abort ヘルパー (dataStreamAbortFetchOnBufferOverflow /
 * dataStreamAbortFillOnBufferOverflow / dataStreamAbortSubgroupStreamOnOverflow)
 * が担う。
 * 合計は追記の直後に判定するため、超過していればその追記をしたストリームが
 * 超過の原因である。判定は await をまたがない同期区間で行う (await をまたぐと、
 * その間に追記した別のストリームが超過の原因と誤判定される)。FETCH は FETCH_OK
 * 待ちの前に、pending mode から合流したストリームはバッファを引き継ぐ直前に判定する。
 * 打ち切られたストリームの計上分は打ち切りの await の前に解放される
 * (dataStreamClearBuffer) ため、await 中に別のストリームが追記しても
 * 巻き添えで打ち切られることはない。
 */
function isDataStreamBufferOverLimit(
  session: DataStreamSessionInternal,
  bufferedBytes: number,
): boolean {
  // このストリームが何も保持していない場合は、合計が上限を超えていても
  // このストリームを原因として打ち切らない (合計を超えさせたストリームが
  // 自分の追記の直後に打ち切られる。打ち切りの await の前にその計上分は
  // dataStreamClearBuffer が解放する)
  if (bufferedBytes <= 0) {
    return false;
  }
  if (session.dataStreamMaxBufferBytes > 0 && bufferedBytes > session.dataStreamMaxBufferBytes) {
    return true;
  }
  return (
    session.dataStreamMaxTotalBufferBytes > 0 &&
    session.dataStreamBufferedBytesTotal > session.dataStreamMaxTotalBufferBytes
  );
}

/**
 * 未消費のバイトを解放する。委譲先で解放済みなら呼び出し元では計上分が残っていない。
 *
 * 打ち切りの await より前に解放し、その間に別のストリームが追記しても上限超過に巻き込まれないようにする。
 */
function dataStreamClearBuffer(session: DataStreamSessionInternal, buffer: ReceiveBuffer): void {
  dataStreamBufferBytesRelease(session, buffer.byteLength);
  buffer.clear();
}

/**
 * 上限超過の判定時点のバッファ長
 *
 * totalBufferedBytes は打ち切りを決めたストリームの計上分を解放する前の合計である。
 * 解放後は上限以下に戻るため、解放後の値を診断に載せると超過の事実がメッセージから
 * 読み取れなくなる。
 */
interface DataStreamBufferOverflow {
  /** 超過したストリームが保持していたバイト数 */
  bufferedBytes: number;
  /** 判定した時点のセッションの合計 */
  totalBufferedBytes: number;
}

/**
 * 上限超過の判定時点のバッファ長を控える
 *
 * 判定した直後 (このストリームの計上分を解放する前) に呼ぶ。
 */
function dataStreamCaptureBufferOverflow(
  session: DataStreamSessionInternal,
  bufferedBytes: number,
): DataStreamBufferOverflow {
  return { bufferedBytes, totalBufferedBytes: session.dataStreamBufferedBytesTotal };
}

/**
 * 上限超過の診断に載せる上限と、判定時点の合計
 *
 * ストリーム単位の上限とセッションの合計上限のどちらで超過したかを切り分けられる
 * よう、両方の上限と、判定時点の合計を含める。
 */
function dataStreamBufferLimitDetail(
  session: DataStreamSessionInternal,
  overflow: DataStreamBufferOverflow,
): string {
  return `limit=${session.dataStreamMaxBufferBytes}, totalLimit=${session.dataStreamMaxTotalBufferBytes}, total=${overflow.totalBufferedBytes}`;
}

/**
 * 上限超過による打ち切りの reason 文字列
 *
 * cancelStreamQuiet は文字列 reason しか受け取れず wire のエラーコードを送れないため、
 * 既存の malformed 打ち切りと同じ書式で EXCESSIVE_LOAD のコードを含める。
 * target は打ち切ったストリームの識別子 (trackAlias / requestId)、実測値は
 * 判定時点の overflow.bufferedBytes を載せる。
 */
function dataStreamBufferOverflowReason(
  session: DataStreamSessionInternal,
  overflow: DataStreamBufferOverflow,
  target: string,
): string {
  return `data stream buffer limit exceeded: code=${DataStreamErrorCode.EXCESSIVE_LOAD}, ${dataStreamBufferLimitDetail(session, overflow)}, ${target}, buffered=${overflow.bufferedBytes}`;
}

/**
 * 上限超過をアプリへ伝えるエラー
 *
 * ピアの RESET_STREAM 経路 (createFetchDataStreamResetError) と同じ形にし、
 * 読み取り失敗値の streamErrorCode とコード名・値をメッセージの両方に載せて、
 * アプリが理由 (EXCESSIVE_LOAD) を判別できるようにする。target と実測値の書式は
 * reason 文字列 (dataStreamBufferOverflowReason) と揃える。
 */
function createDataStreamBufferOverflowError(
  session: DataStreamSessionInternal,
  overflow: DataStreamBufferOverflow,
  target: string,
): Error & { streamErrorCode: DataStreamErrorCode } {
  const error = new Error(
    `data stream buffer limit exceeded: ${dataStreamBufferLimitDetail(session, overflow)}, ${target}, buffered=${overflow.bufferedBytes}: EXCESSIVE_LOAD(0x${DataStreamErrorCode.EXCESSIVE_LOAD.toString(16)})`,
  ) as Error & { streamErrorCode: DataStreamErrorCode };
  error.streamErrorCode = DataStreamErrorCode.EXCESSIVE_LOAD;
  return error;
}

/**
 * データストリームの受信待ちタイマーを作る
 *
 * draft-ietf-moq-transport-23 §12.2:
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
