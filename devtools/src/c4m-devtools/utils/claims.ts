/**
 * C4M DevTools のクレーム入力の解釈と整形
 *
 * `moqt` クレームのスコープ入力を、テキストから `Match` / `NamespaceMatch` へ
 * 変換する。書式は次のとおり。
 *
 * - `example.com` は完全一致、`prefix:live` は前方一致、`suffix:.example.com` は
 *   後方一致 (draft-ietf-moq-c4m-01 Section 2.1 の `bin-match`)
 * - 名前空間マッチは `,` 区切り。`end` は名前空間の末尾を固定する `nil`
 */

import { C4M } from "moqt-js";

const TEXT_ENCODER = new TextEncoder();

/**
 * マッチの入力 1 件を解釈する
 */
export function parseMatch(text: string): C4M.Match {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("empty match");
  }
  if (trimmed.startsWith("prefix:")) {
    return C4M.prefixMatch(TEXT_ENCODER.encode(trimmed.slice("prefix:".length)));
  }
  if (trimmed.startsWith("suffix:")) {
    return C4M.suffixMatch(TEXT_ENCODER.encode(trimmed.slice("suffix:".length)));
  }
  return C4M.exactMatch(TEXT_ENCODER.encode(trimmed));
}

/**
 * 名前空間マッチの入力を解釈する
 *
 * `end` は名前空間の末尾にだけ置ける。
 */
export function parseNamespaceMatches(text: string): C4M.NamespaceMatch[] {
  const entries = text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.map((entry, index) => {
    if (entry === "end") {
      if (index !== entries.length - 1) {
        throw new Error("end must be the last namespace match");
      }
      return C4M.namespaceMatchEnd();
    }
    return C4M.namespaceMatchValue(parseMatch(entry));
  });
}

/**
 * トラック名マッチの入力を解釈する (空の場合は undefined)
 */
export function parseTrackMatch(text: string): C4M.Match | undefined {
  const trimmed = text.trim();
  return trimmed.length === 0 ? undefined : parseMatch(trimmed);
}

/**
 * マッチを入力の書式へ戻す
 */
export function formatMatch(match: C4M.Match): string {
  const pattern = new TextDecoder().decode(match.pattern);
  switch (match.type) {
    case "prefix":
      return `prefix:${pattern}`;
    case "suffix":
      return `suffix:${pattern}`;
    case "exact":
      return pattern;
    default:
      throw new Error("unsupported match type");
  }
}

/**
 * 名前空間マッチを入力の書式へ戻す
 */
export function formatNamespaceMatches(matches: C4M.NamespaceMatch[]): string {
  return matches
    .map((namespaceMatch) =>
      namespaceMatch.type === "end" ? "end" : formatMatch(namespaceMatch.match),
    )
    .join(", ");
}

/**
 * `,` 区切りの入力を一覧にする (空要素は除く)
 */
export function parseList(text: string): string[] {
  return text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * 省略可能な数値の入力を解釈する (空の場合は undefined)
 */
export function parseOptionalNumber(text: string, name: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

/**
 * UNIX 秒を ISO 8601 と秒の併記へ整形する
 */
export function formatUnixTime(seconds: number): string {
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) {
    return String(seconds);
  }
  return `${date.toISOString()} (${seconds})`;
}

/**
 * バイト列を 16 進文字列へ整形する
 */
export function formatBytes(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) {
    text += byte.toString(16).padStart(2, "0");
  }
  return text;
}
