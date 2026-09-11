/**
 * MOQT Session - エラー判定・変換ヘルパーと共有文言定数
 *
 * SessionImpl の read loop catch から利用する純関数群と、各ループで共通に
 * 使う文言定数。
 * - isSessionClosedError: WebTransport セッション終了起源のエラーかどうかを判定する
 * - isPeerStreamError: ピア起因のストリームエラー (source: "stream") かどうかを判定する
 * - toProtocolViolationSessionError: ProtocolViolationError / IncompleteDataError を
 *   PROTOCOL_VIOLATION の SessionError に変換する
 * - toSessionCloseError: SessionError はそのまま、ProtocolViolationError /
 *   IncompleteDataError は PROTOCOL_VIOLATION の SessionError として返す
 * - REQUEST_UPDATE_STREAM_CLOSED_MESSAGE: 応答未達で閉じた保留中の更新を
 *   reject する際の共通文言
 */

import {
  IncompleteDataError,
  ProtocolViolationError,
  SessionError,
  SessionErrorCode,
} from "../error";

/**
 * WebTransport セッション終了に伴って発生した read エラーかどうかを判定する
 *
 * draft-ietf-moq-transport-21 Section 6.6:
 * peer 起点で WebTransport セッションが閉じた場合、各ストリームの read() は
 * reject するが、これは正常な終了通知であり onError には流さない。
 *
 * Chromium 実装では WebTransportError の source プロパティが "session" になる。
 * 環境差異 (テスト環境で WebTransportError が未定義) に備え、グローバルの
 * WebTransportError が利用できない場合はメッセージ文字列でフォールバック判定する。
 */
export function isSessionClosedError(error: Error): boolean {
  const globalWebTransportError = (globalThis as { WebTransportError?: unknown }).WebTransportError;
  if (
    typeof globalWebTransportError === "function" &&
    error instanceof (globalWebTransportError as new (...args: unknown[]) => Error)
  ) {
    const source = (error as unknown as { source?: string }).source;
    return source === "session";
  }
  const message = error.message ?? "";
  return message.includes("session is closed") || message.includes("session closed");
}

/**
 * ピア起因のストリームエラーかどうかを判定する
 *
 * draft-ietf-moq-transport-21 Section 6.4.2.3 (Request Cancellation and Rejection):
 * ピアは STOP_SENDING / RESET_STREAM で当方の送信方向をキャンセルできる。
 * キャンセルされた writable の write / close は WebTransportError
 * (source: "stream") で reject する (W3C WebTransport の実装挙動)。
 * 逆方向 (ピアの送信方向 = 当方の readable) をピアが RESET_STREAM した場合も、
 * reader.read() は source: "stream" の WebTransportError で reject する。
 * これらはいずれもピア起因のキャンセルであり、セッション終了
 * (PROTOCOL_VIOLATION) には昇格させない。受信 READ_FAILURE 検出 (subscriber
 * エラー通知) の判定にも使用する。
 * 例外: 制御ストリームの RESET_STREAM は §6.3 の MUST (「A control stream
 * MUST NOT be closed at the underlying transport layer during the session's
 * lifetime.」) により PROTOCOL_VIOLATION でセッションを閉じる。この判定は
 * 呼び出し側の startControlMessageLoop が行う。
 *
 * source プロパティは WebTransportError の instanceof 成否に関わらず直接読む
 * (テスト環境の Node には WebTransportError グローバルが存在しないため)。
 * 失敗値が null / undefined 等の非オブジェクトの場合は source 非該当として
 * 昇格側に落とす。
 */
export function isPeerStreamError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  return (error as { source?: unknown }).source === "stream";
}

/**
 * ProtocolViolationError / IncompleteDataError を PROTOCOL_VIOLATION の
 * SessionError に変換する
 *
 * draft-ietf-moq-transport-21 Section 12.2 (Session Termination Codes):
 * "PROTOCOL_VIOLATION (0x3): The remote endpoint performed an action that was
 *  disallowed by the specification."
 * 受信メッセージの妥当性検証で違反を検出した場合、各 decode 関数は
 * ProtocolViolationError を throw する。受信ループの catch はこの関数で
 * SessionError へ変換し、PROTOCOL_VIOLATION でセッションを閉じる。
 *
 * IncompleteDataError も変換の対象に含める。リポジトリ共通の解釈として
 * 「Length が揃った後のメッセージ構造の破損はプロトコル違反であり
 * PROTOCOL_VIOLATION で閉じる」を、制御メッセージや datagram を含む受信
 * 経路に均一に適用するためである。ControlStreamReader 等のメッセージ
 * レイヤーでは宣言 Length 分の完全なバッファを読み切ってから decode する
 * ため、IncompleteDataError はこの構造破損を意味する (draft-ietf-moq-
 *  transport-21 Section 9 の MUST「If the length does not match the
 *  length of the Message Body, the receiver MUST close the session with a
 *  PROTOCOL_VIOLATION.」)。datagram 経路 (incomingHandleDatagram) は
 * Length フレーミングを持たないが、decodeObjectDatagram のデコード失敗は
 * 不完全なフィールド構造のみであり、同様に構造破損として扱う。
 * 一方 data stream (Section 11) では IncompleteDataError は「データ不足 =
 * 次チャンク待ち」の通常シグナルとして使われる (processFetchObjects /
 * processSubgroupObjects 等)。そこでは処理関数内または同一 catch 内で
 * IncompleteDataError を本関数に到達させずに処理するため、変換は適用され
 * ない。
 *
 * 上記以外（ストリームの正常終了・キャンセル等）は null を返し、catch 側で
 * 握り潰させる。SessionError もそのコードのまま閉じたい受信経路の catch では、
 * SessionError をそのまま返す toSessionCloseError を使う。
 *
 * 本関数を使い続ける経路は、SessionError を送出しないデコードのみを行うもの
 * である (データストリーム / datagram の寛容デコード
 * decodeObjectPropertiesTolerant、GOAWAY、パラメータ抽出等)。これらの経路に
 * SessionError を送出し得るデコードを持ち込む場合は toSessionCloseError への
 * 切り替えが必要になる。
 *
 * https://www.ietf.org/archive/id/draft-ietf-moq-transport-21.html#section-12.2
 */
export function toProtocolViolationSessionError(error: unknown): SessionError | null {
  if (error instanceof ProtocolViolationError || error instanceof IncompleteDataError) {
    return new SessionError(error.message, SessionErrorCode.PROTOCOL_VIOLATION);
  }
  return null;
}

/**
 * 受信経路の catch からセッションを閉じるための SessionError を取り出す
 *
 * SessionError はエラーコードを保持したまま同一オブジェクトをそのまま返す。
 * 既知 Type の Value / Length が仕様の serialization に一致しない場合、
 * decode 関数は KEY_VALUE_FORMATTING_ERROR の SessionError を throw する
 * (draft-ietf-moq-transport-21 §8.3)。受信経路の catch は本関数でそれを
 * 取り出し、そのコードでセッションを閉じる。
 *
 * ProtocolViolationError / IncompleteDataError は toProtocolViolationSessionError
 * と同じく PROTOCOL_VIOLATION の SessionError に変換する。それ以外
 * (ストリームの正常終了・ピア起因のキャンセル等) は null を返し、catch 側で
 * 従来どおり握り潰させる。
 *
 * 同一オブジェクトを返す点は、pending を具体エラーで reject してから
 * セッションを閉じる経路で「reject される値 = closeWithError に渡す値」の
 * 契約を守るために必要である。
 */
export function toSessionCloseError(error: unknown): SessionError | null {
  if (error instanceof SessionError) {
    return error;
  }
  return toProtocolViolationSessionError(error);
}

/**
 * ストリームクローズ / RESET_STREAM 時に保留中の更新を失敗させるときの
 * エラー文言
 *
 * draft-ietf-moq-transport-21 §9.5.1 / §6.4.2.2:
 * 応答を待たずにストリームが閉じた場合、保留中の更新は失敗として reject
 * する。FIN 経路と RESET_STREAM 経路で共通の文言を使う。GOAWAY 掃除の
 * RequestError (GOING_AWAY) とは失敗種別が異なるため使い分ける。
 * bidi 系・受信 PUBLISH 系・namespace 系の各ループから参照されるため、
 * 循環参照を避けてこのリーフモジュールに置く。
 */
export const REQUEST_UPDATE_STREAM_CLOSED_MESSAGE =
  "stream closed before receiving update response";
