// WebTransport 接続時・接続後設定の入力検証とクエリパラメータ変換を行う純粋関数群
//
// 仕様根拠: W3C WebTransport Candidate Recommendation (2026-07-30)
//   - §5.3 WebTransportDatagramDuplexStream の属性 setter 制約
//   - §6.2 WebTransport コンストラクタの throw 条件
//   - §6.4 WebTransport のメソッド (close() の reason の切り詰め)
//   - §6.9 WebTransportOptions 辞書
//   - §6.10 WebTransportCloseInfo 辞書
//   - §6.11 WebTransportSendOptions 辞書
//   - §6.12 WebTransportSendStreamOptions 辞書
//
// protocols は wt-available-protocols ヘッダーで構造化ヘッダー (RFC 8941) の
// string item として送られるため、文字種は RFC 8941 §3.3.3 の string の制約にも従う

import { base64ToArrayBuffer } from "../utils/base64";

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

// §6.4 step 6 により close reason は UTF-8 エンコード後の 1024 byte が上限である
const CLOSE_REASON_MAX_BYTES = 1024;

// §6.9 の WebTransportHash.value は DER 証明書の SHA-256 ハッシュ (32 byte) である
const CERTIFICATE_HASH_BYTES = 32;

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

// RFC 8941 §3.3.3 の string は DQUOTE で囲まれた ASCII 印字可能文字 (%x20-7E) の列である。
// protocols は wt-available-protocols ヘッダーで string item として送られるため、
// これ以外の文字 (タブ・制御文字・非 ASCII) を含む値は接続時の SyntaxError になる
function isPrintableAscii(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x20 || codeUnit > 0x7e) {
      return false;
    }
  }
  return true;
}

// protocols 入力（カンマ区切り）をパースして検証する
// §6.2 step 13 に基づき、重複・空要素・512 文字超過（isomorphic encoded length）を拒否する。
// 加えて、wt-available-protocols ヘッダーで構造化ヘッダー (RFC 8941) の string item として
// 送れる文字だけを受理する。ASCII 印字可能文字に限れば UTF-16 の code unit 数と
// isomorphic encoded length が一致するため、長さの判定はそのまま使える
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
    if (!isPrintableAscii(protocol)) {
      return {
        ok: false,
        error: `protocol name must consist of printable ASCII characters (0x20-0x7E): ${protocol}`,
      };
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
  // 空白だけの入力は未指定として扱う (接続時と同じ判定にする)
  if (settings.allowPooling && settings.certificateHash.trim()) {
    return "allowPooling and certificateHash cannot be specified together";
  }
  return null;
}

// §6.9 の serverCertificateHashes の value を検証する
// value は DER 証明書の SHA-256 ハッシュ (32 byte) を表す ArrayBuffer である。
// Base64 文字列を復号し、復号長が 32 byte でなければエラーにする。
// 空文字は呼び出し側で「未指定」として扱うため、ここではエラーにする
export function parseCertificateHash(value: string): ParseResult<ArrayBuffer> {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, error: "certificate hash is empty" };
  }
  let hash: ArrayBuffer;
  try {
    hash = base64ToArrayBuffer(trimmed);
  } catch {
    return { ok: false, error: `certificate hash is not valid base64: ${trimmed}` };
  }
  if (hash.byteLength !== CERTIFICATE_HASH_BYTES) {
    return {
      ok: false,
      error: `certificate hash must be 32 bytes (SHA-256) but was ${hash.byteLength} bytes`,
    };
  }
  return { ok: true, value: hash };
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
// 型は unsigned long であり、上限は 4294967295 である。上限を超える値を setter に渡すと
// WebIDL の変換で 2^32 を法として巡回し、入力した値と設定される値が一致しなくなるため拒否する。
// 1 未満は 1 にクランプする。空文字は未指定（undefined）として扱い、setter を呼ばない
export function parseMaxBufferedDatagrams(value: string): ParseResult<number | undefined> {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: undefined };
  const n = Number(trimmed);
  if (!Number.isInteger(n)) {
    return { ok: false, error: `datagram buffer count must be an integer: ${trimmed}` };
  }
  if (n > 0xffffffff) {
    return {
      ok: false,
      error: `datagram buffer count must not exceed 4294967295: ${trimmed}`,
    };
  }
  return { ok: true, value: Math.max(1, n) };
}

// §6.11 sendOrder の入力を検証する（long long）
// long long は 64 bit だが、JavaScript の Number が正確に表せる整数は 2^53-1 までである。
// 安全な整数でない値を setter に渡すと WebIDL の変換で丸められ、入力した値と実際の値が
// 一致しなくなるため拒否する。空文字は未指定（undefined）として扱い、オプションに含めない
export function parseSendOrder(value: string): ParseResult<number | undefined> {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: undefined };
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) {
    return { ok: false, error: `send order must be a safe integer: ${trimmed}` };
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

// §6.4 step 6 の close reason の切り詰めを行う
// close() は closeInfo.reason のうち、UTF-8 エンコード後の長さが 1024 byte を超えない
// 最大の code unit prefix を送信する。UTF-16 の code unit 単位で単純に切ると
// サロゲートペアを分断してしまうため、code point 単位で 1024 byte に収まる最大の
// prefix を求める。仕様の maximal code unit prefix はサロゲートの高位 code unit まで
// 含める場合があるが、本実装はサロゲートペアを分断しない code point 境界で切るため、
// 1024 byte 直前がサロゲートペアのときは仕様より短くなることがある (1024 byte 以下で
// あることは満たす)。truncated は切り詰めが起きたかどうかを呼び出し側へ伝える
export function truncateCloseReason(reason: string): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  let usedBytes = 0;
  let endIndex = 0;
  for (const codePoint of reason) {
    const byteLength = encoder.encode(codePoint).byteLength;
    if (usedBytes + byteLength > CLOSE_REASON_MAX_BYTES) {
      return { text: reason.slice(0, endIndex), truncated: true };
    }
    usedBytes += byteLength;
    endIndex += codePoint.length;
  }
  return { text: reason, truncated: false };
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
