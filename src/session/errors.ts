/**
 * MOQT Session - エラー判定ヘルパー（純関数）
 *
 * SessionImpl の read loop catch から利用する純関数。
 * WebTransport セッション終了起源のエラーかどうかを判定する。
 */

/**
 * WebTransport セッション終了に伴って発生した read エラーかどうかを判定する
 *
 * draft-ietf-moq-transport-18 Section 3.5:
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
