/**
 * WebTransport.reliability から HTTP バージョンラベルへの変換
 *
 * W3C WebTransport 仕様:
 * https://www.w3.org/TR/webtransport/#dom-webtransport-reliability
 *
 * - `"supports-unreliable"` → `"HTTP/3"` (draft-ietf-webtrans-http3、datagram 可)
 * - `"reliable-only"` → `"HTTP/2"` (draft-ietf-webtrans-http2、datagram 不可)
 * - `"pending"` / 空文字 / undefined → `"--"` (セッション未確立)
 * - 上記以外 (`"N/A"` や未知の値) → `"N/A"` (reliability が使えず判定不能)
 *
 * `"--"` (未確立) と `"N/A"` (判定不能) を区別するのは、Chrome 156 のように
 * `reliability` が未実装のブラウザで接続済みでも `"--"` と表示され、
 * 未確立と誤読されるのを防ぐためである。
 */
export type HttpVersionLabel = "HTTP/2" | "HTTP/3" | "--" | "N/A";

export function toHttpVersionLabel(reliability: string | undefined): HttpVersionLabel {
  if (reliability === "supports-unreliable") return "HTTP/3";
  if (reliability === "reliable-only") return "HTTP/2";
  if (reliability === undefined || reliability === "" || reliability === "pending") return "--";
  return "N/A";
}
