/**
 * MSF URI fragment 解析 (draft-ietf-moq-msf-01 §11.1)
 *
 * 参照: draft-ietf-moq-msf-01
 */

// =============================================================================
// MSF URI fragment 解析 (draft-ietf-moq-msf-01 §11.1)
// =============================================================================

/**
 * MSF URI fragment value (`msf:` の後) のパース結果
 * (draft-ietf-moq-msf-01 §11.1)
 */
export interface MsfFragmentValue {
  /** 名前空間 tuple (`-` 単一ハイフン区切り、`--` の左側) */
  trackNamespace: string[];
  /** トラック名 (`--` の右側) */
  trackName: string;
  /**
   * key-value parameter 列 (順序保持)
   *
   * §11.1.1: 同一 key の複数出現が許可される (`MUST process the union of those ranges`)。
   */
  parameters: ReadonlyArray<readonly [string, string]>;
}

/**
 * MSF URI fragment value をパースする (draft-ietf-moq-msf-01 §11.1)
 *
 * 入力: `msf:` を除去した後の値 (例: `customer-livestream-123--catalog&connection=q`)。
 *
 * - `&` で parameter 列を分離 (track-identifier 内に `&` は MUST NOT)
 * - `--` で namespace tuple / track name を分離
 * - 名前空間 tuple は `-` で要素分解
 * - 各 byte の percent-encoding は `.HH` (lowercase 2 hex digits)
 * - literal 文字は `[A-Za-z0-9_]` のみ (§11.1.2)
 */
export function parseMsfFragmentValue(value: string): MsfFragmentValue {
  if (value.length === 0) {
    throw new Error("invalid msf fragment value: empty");
  }
  // `?` は track-identifier 内 MUST NOT (出現時 `%3F` percent-encode)
  if (value.includes("?")) {
    throw new Error("invalid msf fragment value: '?' must be percent-encoded as %3F per §11.1");
  }

  // `&` で track-identifier と parameter list を分離
  const segments = value.split("&");
  const trackIdentifier = segments[0];
  const parameterSegments = segments.slice(1);

  if (trackIdentifier.length === 0) {
    throw new Error("invalid msf fragment value: track identifier is empty");
  }

  // `--` で namespace / track name を分離
  const doubleHyphenIndex = trackIdentifier.indexOf("--");
  if (doubleHyphenIndex === -1) {
    throw new Error(
      "invalid msf fragment value: missing '--' delimiter between namespace and track name per §11.1.2",
    );
  }
  const namespacePart = trackIdentifier.slice(0, doubleHyphenIndex);
  const trackNamePart = trackIdentifier.slice(doubleHyphenIndex + 2);

  if (trackNamePart.length === 0) {
    throw new Error("invalid msf fragment value: track name is empty per §11.1.2");
  }

  // namespace tuple を `-` で分解。namespace 部が空でも tuple は空配列で許容する
  // (catalog track はトップレベル namespace 無しでも parseable)。
  const trackNamespace =
    namespacePart.length === 0
      ? []
      : namespacePart.split("-").map((s) => decodeMsfSegment(s, "namespace"));
  const trackName = decodeMsfSegment(trackNamePart, "track name");

  // parameters の `key=value` 列を順序保持でパース
  const parameters: Array<readonly [string, string]> = [];
  for (const seg of parameterSegments) {
    const eqIndex = seg.indexOf("=");
    if (eqIndex === -1) {
      throw new Error(
        `invalid msf fragment value: parameter '${seg}' must be in key=value format per §11.1`,
      );
    }
    const key = seg.slice(0, eqIndex);
    const v = seg.slice(eqIndex + 1);
    if (key.length === 0) {
      throw new Error("invalid msf fragment value: parameter key is empty per §11.1");
    }
    parameters.push([key, v] as const);
  }

  return { trackNamespace, trackName, parameters };
}

/**
 * MSF namespace-name 文字列の 1 セグメントを decode する。
 *
 * - 大文字 hex (`.HH` の H が大文字) は受信 MUST 拒否 (§11.1.2)
 * - literal 文字集合は `[A-Za-z0-9_]` のみ (§11.1.2)
 *   それ以外 (`-` / `.` / `~` や 非 ASCII byte 等) は literal として禁止、
 *   `.HH` percent-encoded sequence でのみ表現可能。
 * - 既知 `.HH` は percent-decode する。連続する `.HH` byte は UTF-8 シーケンス
 *   として一旦バッファし、最後に TextDecoder で UTF-8 文字列化する (§11.1.2:
 *   「All other byte values ... MUST be percent-encoded」は byte values への
 *   制約であり、復元側はバイト列を UTF-8 として解釈する責務がある)。
 */
function decodeMsfSegment(segment: string, role: "namespace" | "track name"): string {
  // バイト列ベースで decode する: literal ASCII は code point < 128 で 1 byte、
  // `.HH` percent-encoded は対応する byte 値 を Uint8Array に積み、最後にまとめて UTF-8 化する。
  const bytes: number[] = [];
  let i = 0;
  while (i < segment.length) {
    const ch = segment[i];
    if (ch === ".") {
      // .HH percent-encoding
      if (i + 2 >= segment.length) {
        throw new Error(
          `invalid msf fragment value: incomplete percent-encoded sequence in ${role} per §11.1.2`,
        );
      }
      const hex = segment.slice(i + 1, i + 3);
      if (!/^[0-9a-f]{2}$/.test(hex)) {
        throw new Error(
          `invalid msf fragment value: percent-encoding must use lowercase hex digits in ${role} per §11.1.2, got '.${hex}'`,
        );
      }
      bytes.push(Number.parseInt(hex, 16));
      i += 3;
    } else if (/[A-Za-z0-9_]/.test(ch)) {
      bytes.push(ch.charCodeAt(0));
      i += 1;
    } else {
      throw new Error(
        `invalid msf fragment value: unreserved character set in ${role} is [A-Za-z0-9_] per §11.1.2, got '${ch}'`,
      );
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    throw new Error(
      `invalid msf fragment value: percent-encoded bytes in ${role} are not valid UTF-8 per §11.1.2`,
    );
  }
}

/**
 * `connection` パラメータの値を取得する (draft-ietf-moq-msf-01 §11.1.1)
 *
 * 戻り値: `"q"` (Native QUIC MUST) / `"wt"` (WebTransport MUST) / `undefined`
 */
export function getConnectionParameter(
  parameters: ReadonlyArray<readonly [string, string]>,
): "q" | "wt" | undefined {
  for (const [key, value] of parameters) {
    if (key === "connection") {
      if (value === "q" || value === "wt") return value;
      return undefined;
    }
  }
  return undefined;
}

/**
 * msf fragment の connection パラメータがサポートされる transport か検証する
 * (draft-ietf-moq-msf-01 §11.1.1)
 *
 * connection=q は Native QUIC MUST だが未実装のため reject する。
 * connection=wt / 欠如 / 不正値（undefined）は WebTransport（現行）を許可する。
 * msf 以外の fragment type は対象外（何もしない）。
 *
 * @param fragment moqt URI fragment（type / value の組、指定なしは null）
 * @throws Error connection=q のとき（Native QUIC 未実装）。msf fragment value が不正な場合は
 *   parseMsfFragmentValue のエラーが伝播する。
 */
export function assertMsfConnectionSupported(
  fragment: {
    readonly type: string;
    readonly value: string;
  } | null,
): void {
  if (fragment?.type !== "msf") {
    return;
  }
  const connection = getConnectionParameter(parseMsfFragmentValue(fragment.value).parameters);
  if (connection === "q") {
    throw new Error(
      "msf fragment connection='q' requires Native QUIC, which is not implemented (only 'wt' WebTransport is supported)",
    );
  }
}
