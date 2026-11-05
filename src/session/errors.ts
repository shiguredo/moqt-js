/**
 * MOQT Session - エラー判定・変換ヘルパーと共有文言定数
 *
 * SessionImpl の read loop catch から利用する純関数群と、各ループで共通に
 * 使う文言定数。
 * - isSessionClosedError: WebTransport セッション終了起源のエラーかどうかを判定する
 * - isPeerStreamError: ピア起因のストリームエラー (source: "stream") かどうかを判定する
 * - toProtocolViolationSessionError: ProtocolViolationError / IncompleteDataError を
 *   §12.2 の SessionError に変換する
 * - toSessionCloseError: SessionError はそのまま、ProtocolViolationError /
 *   IncompleteDataError は §12.2 の SessionError として返す
 * - REQUEST_UPDATE_STREAM_CLOSED_MESSAGE: 応答未達で閉じた保留中の更新を
 *   reject する際の共通文言
 */

import {
  IncompleteDataError,
  MalformedTrackError,
  ProtocolViolationError,
  SessionError,
  SessionErrorCode,
} from "../error";

/**
 * WebTransport セッション終了に伴って発生した read エラーかどうかを判定する
 *
 * draft-ietf-moq-transport-23 §6.6:
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
 * draft-ietf-moq-transport-23 §6.4.2.3 (Request Cancellation and Rejection):
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
 * lifetime.」) により CLOSED_CONTROL_STREAM でセッションを閉じる。この判定は
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
 * 受信ループの catch へ渡す、IncompleteDataError の分類
 *
 * draft-ietf-moq-transport-23 §9 / §11:
 * 制御メッセージは Message Length 分の完全な Body を読み切ってから decode する。
 * そのため decode 中に必要なバイトが足りない IncompleteDataError は
 * 「Message Length が Body の実際の長さと一致しない」ことを意味し、
 * §9 の MUST により MALFORMED_MESSAGE でセッションを閉じる。
 * 一方 datagram / データストリームの Object は長さの揃った Object として
 * decode されるため、完結した Object バイト列に対する不足は Object の
 * serialization 破損であり、§12.2 の MALFORMED_OBJECT で閉じる。
 *
 * 注意: データストリームの受信途中では、decode 関数の IncompleteDataError は
 * 呼び出し側が「次のチャンク待ち」として処理する。ここに到達するのは
 * バッファに完全な Object が揃った後の構造破損だけである。
 */
export type IncompleteDataClassification =
  | typeof SessionErrorCode.MALFORMED_MESSAGE
  | typeof SessionErrorCode.MALFORMED_OBJECT;

/**
 * ProtocolViolationError / IncompleteDataError を §12.2 の SessionError に変換する
 *
 * draft-ietf-moq-transport-23 §12.2 (Session Termination Codes):
 * 各 decode 関数は、仕様の MUST に違反する受信データを検出すると
 * ProtocolViolationError (対応する code 付き) を throw する。受信ループの catch は
 * この関数で SessionError へ変換し、そのコードでセッションを閉じる。
 *
 * IncompleteDataError は、受信経路の文脈に応じて incompleteDataCode のコードへ
 * 変換する (既定は MALFORMED_MESSAGE)。制御メッセージの Body decode 不足は
 * §9 の MALFORMED_MESSAGE、datagram やデータストリームの Object decode 不足は
 * MALFORMED_OBJECT を指定する。
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
 */
export function toProtocolViolationSessionError(
  error: unknown,
  incompleteDataCode: IncompleteDataClassification = SessionErrorCode.MALFORMED_MESSAGE,
): SessionError | null {
  if (error instanceof ProtocolViolationError) {
    return new SessionError(error.message, error.code);
  }
  if (error instanceof IncompleteDataError) {
    return new SessionError(error.message, incompleteDataCode);
  }
  return null;
}

/**
 * 受信経路の catch からセッションを閉じるための SessionError を取り出す
 *
 * SessionError はエラーコードを保持したまま同一オブジェクトをそのまま返す。
 * 既知 Type の Value / Length が仕様の serialization に一致しない場合、
 * decode 関数は MALFORMED_KEY_VALUE の SessionError を throw する
 * (draft-ietf-moq-transport-23 §8.3)。受信経路の catch は本関数でそれを
 * 取り出し、そのコードでセッションを閉じる。
 *
 * ProtocolViolationError / IncompleteDataError は toProtocolViolationSessionError
 * と同じ変換を行う。IncompleteDataError の分類は経路に応じて
 * incompleteDataCode で指定する (既定 MALFORMED_MESSAGE)。それ以外
 * (ストリームの正常終了・ピア起因のキャンセル等) は null を返し、catch 側で
 * 従来どおり握り潰させる。
 *
 * 同一オブジェクトを返す点は、pending を具体エラーで reject してから
 * セッションを閉じる経路で「reject される値 = closeWithError に渡す値」の
 * 契約を守るために必要である。
 */
export function toSessionCloseError(
  error: unknown,
  incompleteDataCode: IncompleteDataClassification = SessionErrorCode.MALFORMED_MESSAGE,
): SessionError | null {
  if (error instanceof SessionError) {
    return error;
  }
  return toProtocolViolationSessionError(error, incompleteDataCode);
}

/**
 * 空必須メッセージの Track Properties 違反を INVALID_FIELD の SessionError に変換する
 *
 * draft-ietf-moq-transport-23 §9.3 (REQUEST_OK):
 * 「Track Properties are populated in TRACK_STATUS_OK and FETCH_OK; they are empty in
 *  PUBLISH_OK, REQUEST_UPDATE_OK, SUBSCRIBE_NAMESPACE_OK and PUBLISH_NAMESPACE_OK.
 *  If an endpoint receives Track Properties in one of these messages it MUST close
 *  the session with INVALID_FIELD.」
 * 未知 Mandatory Track Property (0x4000-0x7FFF) は decodeProperties が
 * MalformedTrackError を throw する。MalformedTrackError は SessionError ではなく
 * code を持たないため、closeWithError が要求する SessionError へ変換する。
 * Track Properties が非空であること自体が §9.3 の INVALID_FIELD に当たるため、
 * ここでは MalformedTrackError の内容ではなく「空必須メッセージで Track
 * Properties を受信した」という違反のコードを指定する。
 *
 * MalformedTrackError は SUBSCRIBE_OK / FETCH_OK / データストリームでは
 * §3.6 / §12.1 の cancel (セッションは閉じない) を意味するため、共有の
 * toSessionCloseError / toProtocolViolationSessionError は変更せず、空必須
 * メッセージの経路だけが本関数を使う。
 */
export function toTrackPropertiesViolationSessionError(error: MalformedTrackError): SessionError {
  return new SessionError(error.message, SessionErrorCode.INVALID_FIELD);
}

/**
 * ストリームクローズ / RESET_STREAM 時に保留中の更新を失敗させるときの
 * エラー文言
 *
 * draft-ietf-moq-transport-23 §9.5.1 / §6.4.2.2:
 * 応答を待たずにストリームが閉じた場合、保留中の更新は失敗として reject
 * する。FIN 経路と RESET_STREAM 経路で共通の文言を使う。GOAWAY 掃除の
 * RequestError (GOING_AWAY) とは失敗種別が異なるため使い分ける。
 * bidi 系・受信 PUBLISH 系・namespace 系の各ループから参照されるため、
 * 循環参照を避けてこのリーフモジュールに置く。
 */
export const REQUEST_UPDATE_STREAM_CLOSED_MESSAGE =
  "stream closed before receiving update response";
