/**
 * MOQLOG / MOQMETRICS の共通ヘルパー
 *
 * draft-ietf-moq-msf-01 §9 (MOQLOG) と §10 (MOQMETRICS) は、syslog severity と
 * 同じ 8 段階のレベル表、Track Namespace / Track Name の組み立て規約を共有する。
 * Track Namespace は moq-log-04 §5.1 / moq-metrics-03 §5.1 の 3 field、
 * Track Name はレベルを表す ASCII 数字とする。
 * MSF-01 §§9.2 / 10.2 は旧版を参照しており、本モジュールは最新 companion draft に従う。
 * これらの draft は Internet-Draft であり、改版で節番号・規則が変わる可能性がある。
 * 両モジュールで同型の実装が並立すると片方だけ直す修正漏れが起きるため、
 * 共有部分をここに集約する。
 *
 * エラー文言は MOQLOG / MOQMETRICS で別々の文字列がテストで固定されているため、
 * 呼び出し側からラベルを受け取って組み立てる。
 */

import { formatTrackNamespace } from "./fullTrackName";

/**
 * syslog severity / granularity level の文字列 ↔ 優先度（0-7）の対応
 *
 * moq-log-04 §5.1 / moq-metrics-03 §5.2 と [RFC5424] の規約に従う。
 * MOQLOG の severity と MOQMETRICS の granularity は同じ 8 段階を共有する
 * (MOQMETRICS は「syslog severity と同一規約」と定める)。
 * レベル名の正規形は "Informational"（"Info" ではない）。
 */
export const SYSLOG_LEVELS: Readonly<Record<string, number>> = Object.freeze({
  Emergency: 0,
  Alert: 1,
  Critical: 2,
  Error: 3,
  Warning: 4,
  Notice: 5,
  Informational: 6,
  Debug: 7,
});

/**
 * 0-7 のレベルを ASCII 数字 1 バイトの Track Name にする
 *
 * moq-log-04 §5.1 / moq-metrics-03 §5.1: Track Name はレベルを表す
 * ASCII の "0"〜"7" である（0=Emergency - 7=Debug）。
 *
 * @param level - 0-7 のレベル
 * @param label - エラー文言に使う対象名（例: "log priority"）
 * @throws Error level が 0-7 の整数でない場合
 */
export function observabilityTrackName(level: number, label: string): Uint8Array {
  if (!Number.isInteger(level) || level < 0 || level > 7) {
    throw new Error(`${label} level must be an integer 0-7: ${level}`);
  }
  return new Uint8Array([0x30 + level]);
}

/**
 * Track Namespace の prefix が 2 つの非空 field であることを確かめる
 *
 * 型は readonly [string, string] だが、JavaScript からは任意の配列が渡り得る。
 *
 * @param prefix - Track Namespace の固定 2 field
 * @param what - エラー文言に使う対象名（例: "moqlog"）
 * @throws Error prefix が 2 つの非空 field でない場合
 */
function assertNamespacePrefix(prefix: readonly [string, string], what: string): [string, string] {
  const fields: readonly string[] = prefix;
  const [domain, version] = fields;
  if (
    fields.length !== 2 ||
    domain === undefined ||
    domain === "" ||
    version === undefined ||
    version === ""
  ) {
    throw new Error(`${what} namespace prefix must have 2 non-empty fields`);
  }
  return [domain, version];
}

/**
 * Track Namespace の 3 タプル（prefix の 2 field + resourceID）を組み立てる
 *
 * moq-log-04 §4 / §5.1 と moq-metrics-03 §4.1 / §5.1: Track Namespace は
 * domain / v1 / resourceID の 3 field で、resourceID は 16 桁の小文字
 * hexadecimal ASCII である。
 *
 * @param prefix - Track Namespace の固定 2 field
 * @param resourceId - 16 桁小文字 hexadecimal の resource ID
 * @param what - エラー文言に使う対象名（例: "moqlog"）
 * @throws Error prefix が 2 つの非空 field でない場合
 * @throws Error resourceId が string でない場合
 * @throws Error resourceId が 16 桁小文字 hexadecimal でない場合
 */
export function observabilityTrackNamespace(
  prefix: readonly [string, string],
  resourceId: string,
  what: string,
): [string, string, string] {
  const [domain, version] = assertNamespacePrefix(prefix, what);
  const resourceIdValue: unknown = resourceId;
  if (typeof resourceIdValue !== "string") {
    throw new Error(`${what} resourceId must be a string: ${typeof resourceIdValue}`);
  }
  if (!/^[0-9a-f]{16}$/.test(resourceIdValue)) {
    throw new Error(
      `${what} resourceId must be 16 lowercase hexadecimal characters: ${resourceIdValue}`,
    );
  }
  return [domain, version, resourceIdValue];
}

/**
 * MSF publishTracks の namespace 文字列テンプレートを作る
 *
 * moq-log-04 §6 / moq-metrics-03 §6 は、Track Namespace を draft-ietf-moq-transport-23 §8.8 の
 * 形式で `%resourceId%` を placeholder として書く。固定の 2 field prefix だけを
 * formatTrackNamespace で直列化し、末尾へ `-%resourceId%` を連結する。
 * placeholder を含む 3 field tuple を formatTrackNamespace に渡すと `%` が
 * `.25` に変換され、resolveCatalogVariables で置換できなくなるため行わない。
 *
 * @param prefix - Track Namespace の固定 2 field
 * @throws Error prefix が 2 つの非空 field でない場合
 */
export function observabilityNamespaceTemplate(prefix: readonly [string, string]): string {
  const fields = assertNamespacePrefix(prefix, "observability");
  return `${formatTrackNamespace(fields)}-%resourceId%`;
}
