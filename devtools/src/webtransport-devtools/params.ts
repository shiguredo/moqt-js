// WebTransport 接続時・接続後設定の入力検証とクエリパラメータ変換を行う純粋関数群
//
// 仕様根拠: W3C WebTransport Candidate Recommendation (2026-07-30)
//   - §5.3 WebTransportDatagramDuplexStream の属性 setter 制約
//   - §6.2 WebTransport コンストラクタの throw 条件
//   - §6.9 WebTransportOptions 辞書
//   - §6.10 WebTransportCloseInfo 辞書
//   - §6.11 WebTransportSendOptions 辞書
//   - §6.12 WebTransportSendStreamOptions 辞書

export type CongestionControl = "default" | "throughput" | "low-latency";

export type DatagramsReadableType = "bytes" | "";

// 接続時設定の UI 入力値（クエリパラメータの入出力と共有する）
export interface ConnectionSettings {
  url: string;
  certificateHash: string;
  allowPooling: boolean;
  requireUnreliable: boolean;
  congestionControl: CongestionControl;
  headersText: string;
  protocolsText: string;
  datagramsReadableType: DatagramsReadableType;
  anticipatedConcurrentIncomingUnidirectionalStreams: string;
  anticipatedConcurrentIncomingBidirectionalStreams: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

// 既定の接続先 URL（クエリパラメータが無いときの初期値）
export const DEFAULT_URL = "https://127.0.0.1:4443/wt";

// Fetch 仕様の forbidden request-header
// https://fetch.spec.whatwg.org/#forbidden-request-header
const FORBIDDEN_HEADER_NAMES = new Set([
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
]);

// Fetch 仕様の forbidden request-header のプレフィックス
// https://fetch.spec.whatwg.org/#forbidden-request-header
const FORBIDDEN_HEADER_PREFIXES = ["proxy-", "sec-"];

// §6.2 で wt-available-protocols ヘッダーは TypeError になる
const WT_AVAILABLE_PROTOCOLS_HEADER = "wt-available-protocols";

// headers 入力（1 行 1 ヘッダーの "key: value"）をパースして検証する
// §6.2 に基づき、forbidden request-header と wt-available-protocols を拒否する
export function parseHeadersText(text: string): ParseResult<Record<string, string>> {
  const headers: Record<string, string> = {};
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex <= 0) {
      return { ok: false, error: `invalid header line: ${trimmed}` };
    }
    const name = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();
    const lowerName = name.toLowerCase();
    const hasForbiddenPrefix = FORBIDDEN_HEADER_PREFIXES.some((prefix) =>
      lowerName.startsWith(prefix),
    );
    if (
      FORBIDDEN_HEADER_NAMES.has(lowerName) ||
      hasForbiddenPrefix ||
      lowerName === WT_AVAILABLE_PROTOCOLS_HEADER
    ) {
      return { ok: false, error: `forbidden header name: ${name}` };
    }
    headers[name] = value;
  }
  return { ok: true, value: headers };
}

// protocols 入力（カンマ区切り）をパースして検証する
// §6.2 に基づき、重複・空要素・512 文字超過（isomorphic encoded length）を拒否する
export function parseProtocolsText(text: string): ParseResult<string[]> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: [] };
  const protocols = trimmed.split(",").map((p) => p.trim());
  if (protocols.some((p) => p.length === 0)) {
    return { ok: false, error: "empty protocol name" };
  }
  if (new Set(protocols).size !== protocols.length) {
    return { ok: false, error: "duplicate protocol name" };
  }
  for (const protocol of protocols) {
    if (protocol.length > 512) {
      return { ok: false, error: `protocol name exceeds 512 characters: ${protocol}` };
    }
  }
  return { ok: true, value: protocols };
}

// anticipatedConcurrentIncoming*Streams 入力（§6.9 の unsigned short）を検証する
// 空文字は未指定（null）として扱う
export function parseAnticipatedStreams(value: string): ParseResult<number | null> {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    return {
      ok: false,
      error: `anticipated stream count must be an integer in 0-65535: ${trimmed}`,
    };
  }
  return { ok: true, value: n };
}

// §6.9 に基づき、allowPooling と serverCertificateHashes の同時指定を検証する
// 両方指定された場合はエラーメッセージを返す（問題が無ければ null）
export function validateConnectionSettings(settings: ConnectionSettings): string | null {
  if (settings.allowPooling && settings.certificateHash) {
    return "allowPooling and certificateHash cannot be specified together";
  }
  return null;
}

// §5.3 incomingMaxAge / outgoingMaxAge の入力を検証する
// 負値・NaN は拒否し、0 は null（実装定義のデフォルト期限を適用）として扱う
// 空文字は未指定（undefined）として扱い、setter を呼ばない
export function parseDatagramMaxAge(value: string): ParseResult<number | null | undefined> {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: undefined };
  const n = Number(trimmed);
  if (Number.isNaN(n)) {
    return { ok: false, error: `datagram max age must be a number: ${trimmed}` };
  }
  if (n < 0) {
    return { ok: false, error: `datagram max age must not be negative: ${trimmed}` };
  }
  return { ok: true, value: n === 0 ? null : n };
}

// §5.3 incomingMaxBufferedDatagrams / outgoingMaxBufferedDatagrams の入力を検証する
// 1 未満は 1 にクランプする。空文字は未指定（undefined）として扱い、setter を呼ばない
export function parseMaxBufferedDatagrams(value: string): ParseResult<number | undefined> {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: undefined };
  const n = Number(trimmed);
  if (!Number.isInteger(n)) {
    return { ok: false, error: `datagram buffer count must be an integer: ${trimmed}` };
  }
  return { ok: true, value: Math.max(1, n) };
}

// §6.11 sendOrder の入力を検証する（long long）
// 空文字は未指定（undefined）として扱い、オプションに含めない
export function parseSendOrder(value: string): ParseResult<number | undefined> {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: undefined };
  const n = Number(trimmed);
  if (!Number.isInteger(n)) {
    return { ok: false, error: `send order must be an integer: ${trimmed}` };
  }
  return { ok: true, value: n };
}

// §6.10 closeCode の入力を検証する（unsigned long）
// 空文字は未指定（undefined）として扱い、close() に渡さない
export function parseCloseCode(value: string): ParseResult<number | undefined> {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: undefined };
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    return { ok: false, error: `close code must be an integer in 0-4294967295: ${trimmed}` };
  }
  return { ok: true, value: n };
}

// 接続時設定をクエリパラメータへ変換する
// デフォルト値の項目は含めない（既存の certificateHash 省略パターンに合わせる）
// headers は 1 行 1 ヘッダーの "key: value" をそのまま 1 パラメータに載せる
export function buildSettingsQueryString(settings: ConnectionSettings): string {
  const params = new URLSearchParams();
  params.set("url", settings.url);
  if (settings.certificateHash) {
    params.set("certificateHash", settings.certificateHash);
  }
  if (settings.allowPooling) {
    params.set("allowPooling", "true");
  }
  if (settings.requireUnreliable) {
    params.set("requireUnreliable", "true");
  }
  if (settings.congestionControl !== "default") {
    params.set("congestionControl", settings.congestionControl);
  }
  if (settings.headersText.trim()) {
    params.set("headers", settings.headersText);
  }
  if (settings.protocolsText.trim()) {
    params.set("protocols", settings.protocolsText);
  }
  if (settings.datagramsReadableType === "bytes") {
    params.set("datagramsReadableType", "bytes");
  }
  if (settings.anticipatedConcurrentIncomingUnidirectionalStreams.trim()) {
    params.set(
      "anticipatedConcurrentIncomingUnidirectionalStreams",
      settings.anticipatedConcurrentIncomingUnidirectionalStreams,
    );
  }
  if (settings.anticipatedConcurrentIncomingBidirectionalStreams.trim()) {
    params.set(
      "anticipatedConcurrentIncomingBidirectionalStreams",
      settings.anticipatedConcurrentIncomingBidirectionalStreams,
    );
  }
  return params.toString();
}

// クエリパラメータから接続時設定を復元する
// allowPooling と certificateHash が共存する場合は §6.9 の排他検証に従い
// allowPooling を優先して certificateHash を無効化する
export function parseSettingsQueryString(search: string): ConnectionSettings {
  const params = new URLSearchParams(search);
  const allowPooling = params.get("allowPooling") === "true";
  const certificateHash = allowPooling ? "" : (params.get("certificateHash") ?? "");
  const congestionControl = params.get("congestionControl");
  const datagramsReadableType = params.get("datagramsReadableType");
  return {
    url: params.get("url") ?? DEFAULT_URL,
    certificateHash,
    allowPooling,
    requireUnreliable: params.get("requireUnreliable") === "true",
    congestionControl:
      congestionControl === "throughput" || congestionControl === "low-latency"
        ? congestionControl
        : "default",
    headersText: params.get("headers") ?? "",
    protocolsText: params.get("protocols") ?? "",
    datagramsReadableType: datagramsReadableType === "bytes" ? "bytes" : "",
    anticipatedConcurrentIncomingUnidirectionalStreams:
      params.get("anticipatedConcurrentIncomingUnidirectionalStreams") ?? "",
    anticipatedConcurrentIncomingBidirectionalStreams:
      params.get("anticipatedConcurrentIncomingBidirectionalStreams") ?? "",
  };
}
