/**
 * 接続 (SETUP) 処理の free function 群
 *
 * SessionImpl の initialize / decodeAndValidateSetupClosingOnViolation /
 * readSetupMessages / startPostSetupLoops / applyTimeoutOptions /
 * sendControlMessage を free function として抽出する。
 *
 * draft-ietf-moq-transport-21 Section 6.2 (Session establishment) /
 * Section 6.3 (Session initialization) / Section 9.1 (SETUP) の接続確立、
 * 制御ストリームの開設、SETUP の送受信と検証、SETUP 後の受信ループ起動を
 * 1 か所にまとめる。接続後のライフサイクルは lifecycle.ts が担当する。
 */

import { ControlStreamReader, ControlStreamWriter, type ControlMessage } from "../controlStream";
import { IncompleteDataError, SessionError, SessionErrorCode } from "../error";
import {
  MessageType,
  createSetup,
  decodeSetupPayload,
  encodeSetupPayload,
  getSetupAuthority,
  getSetupMaxAuthTokenCacheSize,
  getSetupMaxFilterRanges,
  getSetupMaxRequestUpdates,
  getSetupPath,
  type AuthorizationToken,
} from "../message";
import { decodeVarint, encodeVarint } from "../varint";
import { AuthTokenCache, processSetupAuthorizationTokens } from "./authTokenCache";
import { toSessionCloseError } from "./errors";
import { concatChunks } from "./stream";
import type { SessionState } from "./publicTypes";

/**
 * draft-ietf-moq-transport-21 §12.2:
 * 半端な制御メッセージ / データストリームを保持し続けるピアを打ち切る既定の期限。
 */
export const DEFAULT_CONTROL_MESSAGE_TIMEOUT_MS = 10_000;
export const DEFAULT_DATA_STREAM_TIMEOUT_MS = 30_000;

/**
 * draft-ietf-moq-transport-21 §12.5 (EXCESSIVE_LOAD 0x9):
 * 確立後の受信データストリームが保持してよいバッファの既定上限。
 *
 * 媒体フレームは通常 1 MiB 未満であり、16 MiB の Object を受ける余裕を持たせた値。
 * Track Alias 未確立の並べ替え窓 (pendingSubgroupBuffer の 1 MiB) とは用途が違う。
 * 0 以下を指定すると上限を設けない。
 */
export const DEFAULT_DATA_STREAM_MAX_BUFFER_BYTES = 32 << 20;

/**
 * initialize() のオプション
 *
 * 公開 API ではないが、connect.ts から SessionImpl.initialize() に渡される。
 */
export interface ConnectionInitializeOptions {
  authorizationToken?: AuthorizationToken;
  moqtImplementation?: string | false;
  grease?: boolean;
  /**
   * SETUP で広告する MAX_AUTH_TOKEN_CACHE_SIZE (§9.1.3)。
   * 省略時は送信しない (既定値 0)。
   */
  maxAuthTokenCacheSize?: number;
  /**
   * SETUP で広告する MAX_REQUEST_UPDATES (§9.1.7)。
   * 省略時は送信しない (既定値 0 = 無制限)。
   */
  maxRequestUpdates?: number;
  /**
   * SETUP で広告する MAX_FILTER_RANGES (§9.1.6)。
   * 省略時は送信しない (既定値 0 = Range Filter 受信拒否)。
   */
  maxFilterRanges?: number;
  /**
   * 制御メッセージの受信タイムアウト (§12.2 CONTROL_MESSAGE_TIMEOUT)。
   * 0 以下でタイムアウトしない。
   */
  controlMessageTimeoutMs?: number;
  /**
   * データストリームの受信タイムアウト (§12.2 DATA_STREAM_TIMEOUT)。
   * 0 以下でタイムアウトしない。
   */
  dataStreamTimeoutMs?: number;
  /**
   * 確立後の受信データストリームが保持してよいバッファの上限 (バイト)
   *
   * draft-ietf-moq-transport-21 §12.5 (EXCESSIVE_LOAD 0x9)。
   * 既定は DEFAULT_DATA_STREAM_MAX_BUFFER_BYTES (32 MiB)。0 以下で上限なし。
   * 詳細は ConnectOptions.dataStreamMaxBufferBytes を参照。
   */
  dataStreamMaxBufferBytes?: number;
}

/**
 * 接続処理が必要とする SessionImpl のビュー
 *
 * SessionImpl は `as unknown as ConnectionSessionInternal` で渡す。
 */
export interface ConnectionSessionInternal {
  sessionState: SessionState;
  readonly transport: WebTransport;

  controlSendStream?: WritableStream<Uint8Array> | undefined;
  controlReceiveStream?: ReadableStream<Uint8Array> | undefined;
  controlReader?: ControlStreamReader | undefined;
  controlWriter?: ControlStreamWriter | undefined;

  // draft-ietf-moq-transport-21 §13 (Grease): Track / Object Properties への注入
  grease: boolean;
  // draft-ietf-moq-transport-21 §9.1.6 / §9.1.7 / §9.1.3: SETUP で広告する上限
  localMaxFilterRanges: number;
  localMaxRequestUpdates: number;
  localMaxAuthTokenCacheSize: number;
  // draft-ietf-moq-transport-21 §9.1.6 / §9.1.7: ピアが広告した上限
  peerMaxFilterRanges: number;
  peerMaxRequestUpdates: number;
  receivedAuthTokens: AuthTokenCache;

  // draft-ietf-moq-transport-21 §12.2: 受信タイムアウト
  controlMessageTimeoutMs: number;
  dataStreamTimeoutMs: number;
  // draft-ietf-moq-transport-21 §12.5: データストリーム単位の受信バッファ上限
  dataStreamMaxBufferBytes: number;
  statsControlMessagesSent: number;

  closeWithError(error: SessionError): void;
  emitDebug(
    direction: "send" | "recv",
    type: number,
    payload: Uint8Array,
    decoded?: Record<string, unknown>,
  ): void;
  handleControlMessage(type: number, payload: Uint8Array): void;
  handleIncomingStream(stream: ReadableStream<Uint8Array>): Promise<void>;
  startControlMessageLoop(): void;
  startDatagramLoop(): void;
  startIncomingBidirectionalStreamLoop(): void;
  startIncomingStreamLoop(): void;
}

/**
 * 読み取り済みの先頭バイト列をストリームの先頭に戻す
 *
 * initialize() が制御ストリームを探すためにデータストリームの先頭
 * (ストリームタイプ varint を含む) を消費する。SETUP 完了後に
 * handleIncomingStream が通常のストリームとして処理できるよう、
 * 消費済みバイトを先頭に持つ ReadableStream を作り直す
 * (draft-ietf-moq-transport-21 §6.3 のデータストリーム先着バッファリング)。
 */
export function connectionPrependBytesToStream(
  prefix: Uint8Array,
  source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let prefixSent = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!prefixSent) {
        prefixSent = true;
        if (prefix.byteLength > 0) {
          controller.enqueue(prefix);
        }
        return;
      }
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      if (value) {
        controller.enqueue(value);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * SETUP で広告する MAX_REQUEST_UPDATES の保持値を解決する
 *
 * draft-ietf-moq-transport-21 §9.1.7:
 * 未広告 (undefined) は 0 (無制限) として扱う。§9.1.6 の MAX_FILTER_RANGES の
 * 0 が「Range Filter 受信拒否」なのとは意味が逆である。
 */
export function connectionResolveLocalMaxRequestUpdates(options?: {
  maxRequestUpdates?: number;
}): number {
  return options?.maxRequestUpdates ?? 0;
}
export async function connectionInitialize(
  session: ConnectionSessionInternal,
  options?: {
    authorizationToken?: AuthorizationToken;
    moqtImplementation?: string | false;
    grease?: boolean;
    /**
     * SETUP で広告する MAX_AUTH_TOKEN_CACHE_SIZE (§9.1.3)。
     * 省略時は送信しない (既定値 0)。
     */
    maxAuthTokenCacheSize?: number;
    /**
     * SETUP で広告する MAX_REQUEST_UPDATES (§9.1.7)。
     * 省略時は送信しない (既定値 0 = 無制限)。
     */
    maxRequestUpdates?: number;
    /**
     * SETUP で広告する MAX_FILTER_RANGES (§9.1.6)。
     * 省略時は送信しない (既定値 0 = Range Filter 受信拒否)。
     */
    maxFilterRanges?: number;
    /**
     * 制御メッセージの受信タイムアウト (§12.2 CONTROL_MESSAGE_TIMEOUT)。
     * 0 以下でタイムアウトしない。
     */
    controlMessageTimeoutMs?: number;
    /**
     * データストリームの受信タイムアウト (§12.2 DATA_STREAM_TIMEOUT)。
     * 0 以下でタイムアウトしない。
     */
    dataStreamTimeoutMs?: number;
    /**
     * 確立後の受信データストリームが保持してよいバッファの上限 (バイト)
     *
     * draft-ietf-moq-transport-21 §12.5 (EXCESSIVE_LOAD 0x9)。
     * 既定は DEFAULT_DATA_STREAM_MAX_BUFFER_BYTES (32 MiB)。0 以下で上限なし。
     */
    dataStreamMaxBufferBytes?: number;
  },
): Promise<void> {
  // draft-ietf-moq-transport-21 Section 1.5 (Extensibility):
  // 制御ストリームは単方向ストリームのペアに変更された。
  // クライアントは送信用単方向ストリームを開き、サーバーの単方向ストリームを受信する。
  // draft-ietf-moq-transport-21 Section 1.5

  session.controlReader = new ControlStreamReader();
  session.controlWriter = new ControlStreamWriter();

  // 送信用単方向ストリームを開く
  session.controlSendStream = await session.transport.createUnidirectionalStream();

  // draft-ietf-moq-transport-21 Section 6.4.1:
  // All unidirectional MOQT streams start with a variable-length integer
  // indicating the type of the stream.
  // 制御ストリームのストリームタイプは 0x2F00 (Table 2)
  const streamTypeBytes = encodeVarint(MessageType.SETUP);

  // SETUP を送信
  // draft-ietf-moq-transport-21 §9.1.1 / §9.1.2:
  // AUTHORITY (0x05) / PATH (0x01) は WebTransport 使用時には MUST NOT 送信。
  // moqt-js は WebTransport 専用クライアントのため `createSetup` には渡さない。
  // grease は SETUP 送信だけでなく、Track / Object Properties への注入にも使うため
  // セッション状態として保持する。
  session.grease = options?.grease === true;
  // draft-ietf-moq-transport-21 §9.1.6 (MAX FILTER RANGES):
  // 自 endpoint が広告する上限を保持し、受信 Range Filter の検証に使う。
  // 未広告 (undefined) の既定値は 0（Range Filter 受信拒否）。
  session.localMaxFilterRanges = options?.maxFilterRanges ?? 0;
  // draft-ietf-moq-transport-21 §12.2:
  // 半端な制御メッセージ / データストリームを保持し続けるピアを打ち切る期限。
  connectionApplyTimeoutOptions(session, options);
  // draft-ietf-moq-transport-21 §9.1.3 (MAX_AUTH_TOKEN_CACHE_SIZE):
  // 自 endpoint が広告する上限を保持し、受信 REGISTER の上限判定に使う。
  // 未広告 (undefined) の既定値は 0（Alias の使用禁止）。
  session.localMaxAuthTokenCacheSize = options?.maxAuthTokenCacheSize ?? 0;
  session.receivedAuthTokens = new AuthTokenCache(session.localMaxAuthTokenCacheSize);
  // draft-ietf-moq-transport-21 §9.1.7 (MAX_REQUEST_UPDATES):
  // 自 endpoint が広告する上限を保持し、受信 REQUEST_UPDATE の未応答数の
  // 上限判定に使う。未広告 (undefined) の既定値は 0（無制限）。
  // §9.1.6 の MAX_FILTER_RANGES の 0 = 受信拒否とは意味が逆であるため、
  // 受信側のガードでも 0 を拒否として扱わない。
  session.localMaxRequestUpdates = connectionResolveLocalMaxRequestUpdates(options);
  // exactOptionalPropertyTypes では optional なフィールドに undefined を渡せないため、
  // 値がある場合だけ載せた object を組み立てる (createSetup の型は公開 API のため広げない)
  const setup = createSetup({
    ...(options?.authorizationToken !== undefined
      ? { authorizationToken: options.authorizationToken }
      : {}),
    ...(options?.moqtImplementation !== undefined
      ? { moqtImplementation: options.moqtImplementation }
      : {}),
    ...(options?.grease !== undefined ? { grease: options.grease } : {}),
    ...(options?.maxAuthTokenCacheSize !== undefined
      ? { maxAuthTokenCacheSize: options.maxAuthTokenCacheSize }
      : {}),
    ...(options?.maxRequestUpdates !== undefined
      ? { maxRequestUpdates: options.maxRequestUpdates }
      : {}),
    ...(options?.maxFilterRanges !== undefined ? { maxFilterRanges: options.maxFilterRanges } : {}),
  });
  const setupPayload = encodeSetupPayload(setup);
  const setupMessage = session.controlWriter.encode(MessageType.SETUP, setupPayload);

  session.emitDebug("send", MessageType.SETUP, setupPayload, {});

  const writer = session.controlSendStream.getWriter();
  await writer.write(streamTypeBytes);
  await writer.write(setupMessage);
  writer.releaseLock();

  // サーバーからの単方向ストリームを受信する
  // draft-ietf-moq-transport-21 §6.3 (Session initialization):
  // "Unidirectional streams containing Objects or bidirectional stream(s)
  //  beginning with a request message could arrive prior to the control
  //  streams, in which case the data SHOULD be buffered until both control
  //  streams arrive and setup is complete."
  // 先頭のストリームタイプを確認し、0x2F00 (SETUP) でなければデータストリーム
  // としてバッファリングし、制御ストリームが到着するまで読み進める。
  const incomingReader = session.transport.incomingUnidirectionalStreams.getReader();
  let controlStream: ReadableStream<Uint8Array> | undefined;
  let controlBuffer: Uint8Array = new Uint8Array(0);
  const bufferedDataStreams: ReadableStream<Uint8Array>[] = [];
  try {
    while (controlStream === undefined) {
      const { value: incomingStream, done: streamDone } = await incomingReader.read();
      if (streamDone || !incomingStream) {
        throw new SessionError(
          "Connection closed before receiving control stream",
          SessionErrorCode.NO_ERROR,
        );
      }

      // draft-ietf-moq-transport-21 Section 6.4.1:
      // 単方向ストリームの先頭にストリームタイプ varint が含まれる。
      // WebTransport の read() はチャンク境界を保証しないため、
      // タイプ varint が揃うまで read + 連結を繰り返す。
      const dataReader = incomingStream.getReader();
      let buffer: Uint8Array = new Uint8Array(0);
      let streamType: bigint | undefined;
      let streamTypeConsumed = 0;
      try {
        for (;;) {
          const { value, done } = await dataReader.read();
          if (done || !value) {
            // タイプが揃う前に FIN した空ストリームは読み飛ばす
            break;
          }
          buffer = concatChunks([buffer, value]);
          try {
            [streamType, streamTypeConsumed] = decodeVarint(buffer, 0);
            break;
          } catch (error) {
            // varint がまだ揃っていない場合は次の read() で続きを読む。
            // それ以外のエラーは再 throw する。
            if (!(error instanceof IncompleteDataError)) {
              throw error;
            }
          }
        }
      } finally {
        dataReader.releaseLock();
      }

      if (streamType === undefined) {
        continue;
      }
      if (Number(streamType) === MessageType.SETUP) {
        controlStream = incomingStream;
        controlBuffer = buffer.slice(streamTypeConsumed);
        break;
      }
      // データストリーム先着: 読み取り済みバイト列 (タイプ varint を含む) を
      // 先頭に戻したストリームを作り、SETUP 完了後に handleIncomingStream へ渡す。
      bufferedDataStreams.push(connectionPrependBytesToStream(buffer, incomingStream));
    }
  } finally {
    incomingReader.releaseLock();
  }

  if (controlStream === undefined) {
    throw new SessionError(
      "Connection closed before receiving control stream",
      SessionErrorCode.NO_ERROR,
    );
  }
  session.controlReceiveStream = controlStream;

  // draft-ietf-moq-transport-21 Section 9.1 (SETUP):
  // SETUP は制御ストリーム上で最初に送られる制御メッセージである。
  // SETUP メッセージが揃うまで read + feed を繰り返す。
  // ControlStreamReader.feed は部分データを内部バッファに蓄積し、
  // 揃ったメッセージだけを返す。
  const messages = await connectionReadSetupMessages(session, controlStream, controlBuffer);

  // 先頭メッセージ種別の検証・SETUP のデコードと検証・AUTHORIZATION TOKEN の処理で
  // 検出した違反は「セッションを閉じる」MUST の対象である。詳細は
  // decodeAndValidateSetupClosingOnViolation を参照する。
  const { message: msg, decoded: decodedSetup } = connectionDecodeAndValidateSetup(
    session,
    messages,
  );

  // draft-ietf-moq-transport-21 §9.1.3:
  // ピアの MAX_AUTH_TOKEN_CACHE_SIZE を取得（デフォルト 0 = Alias 使用禁止）
  const peerMaxAuthTokenCacheSize = getSetupMaxAuthTokenCacheSize(decodedSetup);

  // draft-ietf-moq-transport-21 §9.1.7:
  // ピアの MAX_REQUEST_UPDATES を取得（デフォルト 0 = 無制限）
  session.peerMaxRequestUpdates = getSetupMaxRequestUpdates(decodedSetup);

  // draft-ietf-moq-transport-21 §9.1.6:
  // ピアの MAX_FILTER_RANGES を取得（デフォルト 0 = Range Filter 送信禁止）
  session.peerMaxFilterRanges = getSetupMaxFilterRanges(decodedSetup);

  session.emitDebug("recv", MessageType.SETUP, msg.payload, {
    peerMaxAuthTokenCacheSize: peerMaxAuthTokenCacheSize.toString(),
    peerMaxRequestUpdates: session.peerMaxRequestUpdates.toString(),
    peerMaxFilterRanges: session.peerMaxFilterRanges.toString(),
  });

  // SETUP 確立後の受信ループを開始する
  connectionStartPostSetupLoops(session, messages, bufferedDataStreams);
}

/**
 * 受信 SETUP の先頭メッセージ検証・デコード・検証を行い、違反時はセッションを閉じる
 *
 * draft-ietf-moq-transport-21 §9 (Control Messages) は Length と Body 長の不一致に
 * PROTOCOL_VIOLATION でのセッションクローズを MUST とし、§9.1.1 (AUTHORITY) /
 * §9.1.2 (PATH) は WebTransport 使用中の受信に INVALID_AUTHORITY / INVALID_PATH での
 * クローズを MUST、§9.1.4 (AUTHORIZATION TOKEN) は AUTHORIZATION TOKEN の処理失敗に
 * クローズを MUST とする。また §9.1 (SETUP) は制御ストリームの先頭が SETUP であることを
 * 要求する。
 *
 * initialize() を失敗させるだけではピアに終了コードが伝わらず、connect() は例外を
 * 伝播するだけでトランスポートを閉じないため、セッションが開いたまま残る。
 * toSessionCloseError で正規化した SessionError で closeWithError してから元の例外を
 * 再送出する (initialize() は失敗を reject で伝える契約であり、ここで握ると初期化に
 * 失敗したセッションを成功として返してしまう)。
 * 正規化できない例外 (ピア起因の終了など) は閉じずにそのまま伝播させる。
 *
 * @param messages - readSetupMessages が返した制御メッセージ列 (先頭が SETUP)
 * @returns 検証済みの先頭メッセージとデコード結果
 */
export function connectionDecodeAndValidateSetup(
  session: ConnectionSessionInternal,
  messages: ControlMessage[],
): {
  message: ControlMessage;
  decoded: ReturnType<typeof decodeSetupPayload>;
} {
  try {
    const msg = messages[0];
    if (msg === undefined) {
      // readSetupMessages は 1 件以上を返す契約だが、noUncheckedIndexedAccess で
      // 型上 undefined を含むため到達しない防御を置く
      throw new SessionError("No SETUP message received", SessionErrorCode.PROTOCOL_VIOLATION);
    }
    if (msg.type !== MessageType.SETUP) {
      throw new SessionError(
        `Expected SETUP, got ${msg.type}`,
        SessionErrorCode.PROTOCOL_VIOLATION,
      );
    }

    // SETUP をデコードしてバリデーションする (Length と Body 長の不一致は
    // ProtocolViolationError / IncompleteDataError になり、下の catch で
    // PROTOCOL_VIOLATION へ正規化される)
    const decoded = decodeSetupPayload(msg.payload);

    // draft-ietf-moq-transport-21 §9.1.1 / §9.1.2:
    // AUTHORITY (0x05) / PATH (0x01) は server から送信されてはならない。
    // また WebTransport 使用時には MUST NOT 送信されるため、moqt-js は受信したら
    // INVALID_AUTHORITY / INVALID_PATH でセッションを閉じなければならない。
    if (getSetupAuthority(decoded) !== undefined) {
      throw new SessionError(
        "received AUTHORITY in SETUP from server (forbidden under WebTransport)",
        SessionErrorCode.INVALID_AUTHORITY,
      );
    }
    if (getSetupPath(decoded) !== undefined) {
      throw new SessionError(
        "received PATH in SETUP from server (forbidden under WebTransport)",
        SessionErrorCode.INVALID_PATH,
      );
    }

    // draft-ietf-moq-transport-21 §9.1.4 / §8.9:
    // 受信 SETUP の AUTHORIZATION TOKEN オプションを処理する。DELETE / USE_ALIAS は
    // §9.1.4 の MUST に基づく防御的検査として PROTOCOL_VIOLATION、登録済み Alias の
    // 再 REGISTER は DUPLICATE_AUTH_TOKEN_ALIAS でセッションを閉じる。上限超過の
    // REGISTER は §9.1.4 の MUST により USE_VALUE として扱いセッションを閉じない。
    // Token 構造がデコードできない場合は KEY_VALUE_FORMATTING_ERROR になる。
    processSetupAuthorizationTokens(session.receivedAuthTokens, decoded.parameters);

    return { message: msg, decoded };
  } catch (error) {
    const sessionError = toSessionCloseError(error);
    if (sessionError !== null) {
      session.closeWithError(sessionError);
    }
    throw error;
  }
}

/**
 * 制御ストリームから SETUP を含む制御メッセージ列を読み取る
 *
 * reader は 1 つだけ保持し、後続の制御ストリーム読み取り (startControlMessageLoop)
 * が getReader() で再取得できるよう finally で必ず releaseLock する。
 *
 * @param controlStream - サーバーが開いた制御ストリーム (単方向)
 * @param controlBuffer - ストリームタイプ varint を読み飛ばした後の残りバイト列
 * @returns 1 件以上の制御メッセージ列 (先頭が SETUP)
 */
export async function connectionReadSetupMessages(
  session: ConnectionSessionInternal,
  controlStream: ReadableStream<Uint8Array>,
  controlBuffer: Uint8Array,
): Promise<ControlMessage[]> {
  const controlReader = session.controlReader;
  if (controlReader === undefined) {
    // initialize() が SETUP 送信前に session.controlReader を生成しているため到達しない
    // (このメソッドは initialize() からのみ呼ばれる)
    throw new SessionError("Control reader not initialized", SessionErrorCode.PROTOCOL_VIOLATION);
  }
  const reader = controlStream.getReader();
  try {
    let messages = controlReader.feed(controlBuffer);
    while (messages.length === 0) {
      const { value: chunk, done } = await reader.read();
      if (done || !chunk) {
        throw new SessionError("Connection closed before SETUP", SessionErrorCode.NO_ERROR);
      }
      messages = controlReader.feed(chunk);
    }
    return messages;
  } finally {
    reader.releaseLock();
  }
}

/**
 * SETUP 確立後に受信ループを開始する
 *
 * draft-ietf-moq-transport-21 Section 9.1 (SETUP) / Section 6.3 (Session initialization):
 * SETUP は制御ストリーム上の最初の制御メッセージであり、後続メッセージが同一 read
 * チャンクに相乗りして届くことがある。ControlStreamReader.feed は揃った全メッセージを
 * 返し内部バッファから削除するため、messages[0] (SETUP) 以外を処理しないと、後続の
 * startControlMessageLoop は新規 read 分しか処理せず相乗りメッセージが恒久的に失われる。
 * SETUP 確立後に messages[1..] を通常の制御メッセージ処理経路へ順次流す。
 *
 * @param messages - SETUP 受信時の read で揃った制御メッセージ列 (先頭が SETUP)
 * @param bufferedDataStreams - SETUP 完了前に到着しバッファリングしたデータストリーム
 */
export function connectionStartPostSetupLoops(
  session: ConnectionSessionInternal,
  messages: ControlMessage[],
  bufferedDataStreams: ReadableStream<Uint8Array>[],
): void {
  // 先頭 (SETUP) 以外を index access せずに走査する
  for (const trailingMessage of messages.slice(1)) {
    session.handleControlMessage(trailingMessage.type, trailingMessage.payload);
  }

  // バックグラウンドで制御メッセージの読み取りを開始
  session.startControlMessageLoop();

  // 受信データストリームの受け入れを開始
  session.startIncomingStreamLoop();

  // SETUP 完了前に到着したデータストリームを処理する
  // draft-ietf-moq-transport-21 §6.3:
  // 制御ストリーム確立までバッファリングした Object ストリームを、
  // 読み取り済みバイト列 (ストリームタイプ varint を含む) ごと渡す。
  for (const buffered of bufferedDataStreams) {
    void session.handleIncomingStream(buffered);
  }

  // データグラムの受信を開始
  session.startDatagramLoop();

  // 受信双方向ストリームの監視を開始
  // draft-ietf-moq-transport-21 §9.18: SUBSCRIBE_TRACKS への応答として
  // サーバーが新規双方向ストリームを開き PUBLISH を送信する
  session.startIncomingBidirectionalStreamLoop();
}

/**
 * 受信タイムアウトの設定を反映する
 *
 * draft-ietf-moq-transport-21 §12.2:
 * CONTROL_MESSAGE_TIMEOUT (0x11) / DATA_STREAM_TIMEOUT (0x12) は、ピアが
 * 制御メッセージへの応答・データストリームの送信に時間をかけすぎたことを
 * 示すコードである。半端なメッセージや Object を保持したまま待ち続ける
 * ピアにメモリとコネクションを占有され続けないよう、期限を設ける。
 * 0 以下を指定するとタイムアウトしない。
 *
 * draft-ietf-moq-transport-21 §12.5 (EXCESSIVE_LOAD 0x9):
 * あわせて受信データストリーム 1 本が保持してよいバッファの上限も反映する。
 * 0 以下を指定すると上限を設けない。
 */
export function connectionApplyTimeoutOptions(
  session: ConnectionSessionInternal,
  options?: {
    controlMessageTimeoutMs?: number;
    dataStreamTimeoutMs?: number;
    dataStreamMaxBufferBytes?: number;
  },
): void {
  session.controlMessageTimeoutMs =
    options?.controlMessageTimeoutMs ?? DEFAULT_CONTROL_MESSAGE_TIMEOUT_MS;
  session.dataStreamTimeoutMs = options?.dataStreamTimeoutMs ?? DEFAULT_DATA_STREAM_TIMEOUT_MS;
  // draft-ietf-moq-transport-21 §12.5 (EXCESSIVE_LOAD 0x9):
  // 確立後の受信データストリームが無制限にメモリを消費しないようにする上限。
  session.dataStreamMaxBufferBytes =
    options?.dataStreamMaxBufferBytes ?? DEFAULT_DATA_STREAM_MAX_BUFFER_BYTES;
}

export async function connectionSendControlMessage(
  session: ConnectionSessionInternal,
  type: number,
  payload: Uint8Array,
  decoded?: Record<string, unknown>,
): Promise<void> {
  if (!session.controlSendStream || !session.controlWriter) {
    throw new Error("Control stream not initialized");
  }

  session.statsControlMessagesSent++;
  session.emitDebug("send", type, payload, decoded);

  const message = session.controlWriter.encode(type, payload);
  const writer = session.controlSendStream.getWriter();
  await writer.write(message);
  writer.releaseLock();
}
