/**
 * MSF URI fragment 解析 (draft-ietf-moq-msf-01 §11.1)
 *
 * 参照: draft-ietf-moq-msf-01
 *
 * track-identifier の namespace-name 文字列 (§11.1.2) の復号規則は §8.8 が normatively
 * 定めるため、セグメントの解析は fullTrackName.ts の parseFullTrackNameSegment を使う。
 */

import { parseFullTrackNameSegment } from "../fullTrackName";

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
 *
 * 各セグメントの復号は §11.1.2 が normatively 採用する §8.8 の規則を実装した
 * `parseFullTrackNameSegment` に任せる (literal で書ける byte の hex 表現は拒否する)。
 *
 * @throws Error 空文字列 / 空の track-identifier / 空の track name / `?` の混入 / `--` 区切りの欠落 /
 *   key=value 形式でない parameter / 空の parameter key / MSF namespace-name 文字列の違反 (§11.1.2 の
 *   文字集合、小文字 hex の percent-encoding、不完全な `.HH`、literal で書ける byte の hex 表現) /
 *   空の Track Namespace Field (§8.7 違反) / percent-encoded byte が UTF-8 でないとき
 */
export function parseMsfFragmentValue(value: string): MsfFragmentValue {
  if (value.length === 0) {
    throw new Error("invalid msf fragment value: empty");
  }
  // `?` は track-identifier 内 MUST NOT (出現時 `%3F` percent-encode)
  if (value.includes("?")) {
    throw new Error("invalid msf fragment value: '?' must be percent-encoded as %3F per §11.1");
  }

  // `&` で track-identifier と parameter list を分離する。
  // value.length > 0 のため split の結果は必ず 1 件以上になるが、
  // noUncheckedIndexedAccess で型上 undefined を含むためガードを置く。
  const segments = value.split("&");
  const trackIdentifier = segments[0];
  if (trackIdentifier === undefined) {
    // 上の value.length === 0 の検証により到達しない (型を絞るためのガード)
    throw new Error("invalid msf fragment value: track identifier is missing");
  }
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
  // (catalog track はトップレベル namespace 無しでも parseable)。空のフィールドは
  // §8.7 が 1 バイト以上を MUST とするため、区切りと区別できず拒否する (§8.8 の表記にも
  // 空のフィールドを書く方法が無い)。
  const trackNamespace =
    namespacePart.length === 0
      ? []
      : namespacePart.split("-").map((field, index) => {
          if (field.length === 0) {
            throw new Error(
              `invalid msf fragment value: track namespace field at index ${index} must not be empty per draft-ietf-moq-transport-22 §8.7`,
            );
          }
          return parseFullTrackNameSegment(field, `msf fragment namespace field at index ${index}`);
        });
  const trackName = parseFullTrackNameSegment(trackNamePart, "msf fragment track name");

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
