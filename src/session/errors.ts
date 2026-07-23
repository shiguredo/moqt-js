/**
 * MOQT Session - エラー判定・変換ヘルパー（純関数）
 *
 * SessionImpl の read loop catch から利用する純関数群。
 * - isSessionClosedError: WebTransport セッション終了起源のエラーかどうかを判定する
 * - toProtocolViolationSessionError: ProtocolViolationError を PROTOCOL_VIOLATION の
 *   SessionError に変換する
 */

import { ProtocolViolationError, SessionError, SessionErrorCode } from "../error";

/**
 * WebTransport セッション終了に伴って発生した read エラーかどうかを判定する
 *
 * draft-ietf-moq-transport-19 Section 3.5:
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
 * ProtocolViolationError を PROTOCOL_VIOLATION の SessionError に変換する
 *
 * draft-ietf-moq-transport-19 Section 3.5 (Termination):
 * "PROTOCOL_VIOLATION (0x3): The remote endpoint performed an action that was
 *  disallowed by the specification."
 * 受信メッセージの妥当性検証で違反を検出した場合、各 decode 関数は
 * ProtocolViolationError を throw する。受信ループの catch はこの関数で
 * SessionError へ変換し、PROTOCOL_VIOLATION でセッションを閉じる。
 *
 * ProtocolViolationError 以外（ストリームの正常終了・キャンセル等）は
 * null を返し、catch 側で握り潰させる。
 *
 * https://www.ietf.org/archive/id/draft-ietf-moq-transport-19.html#section-3.5
 */
export function toProtocolViolationSessionError(error: unknown): SessionError | null {
  if (error instanceof ProtocolViolationError) {
    return new SessionError(error.message, SessionErrorCode.PROTOCOL_VIOLATION);
  }
  return null;
}
