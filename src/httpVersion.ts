/**
 * WebTransport.reliability から HTTP バージョンラベルへの変換
 *
 * W3C WebTransport 仕様:
 * https://www.w3.org/TR/webtransport/#dom-webtransport-reliability
 *
 * - `"supports-unreliable"` → `"HTTP/3"` (draft-ietf-webtrans-http3、datagram 可)
 * - `"reliable-only"` → `"HTTP/2"` (draft-ietf-webtrans-http2、datagram 不可)
 * - 上記以外 (`"pending"` / undefined) → `"--"` (未確立)
 */
export type HttpVersionLabel = "HTTP/2" | "HTTP/3" | "--";

export function toHttpVersionLabel(reliability: string | undefined): HttpVersionLabel {
  if (reliability === "supports-unreliable") return "HTTP/3";
  if (reliability === "reliable-only") return "HTTP/2";
  return "--";
}
