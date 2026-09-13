/**
 * MOQLOG / MOQMETRICS の共通ヘルパー
 *
 * draft-ietf-moq-msf-01 §9 (MOQLOG) と §10 (MOQMETRICS) は、syslog severity と
 * 同じ 8 段階のレベル表、62-bit Group ID への truncate、Track Namespace /
 * Track Name の組み立て規約を共有する。両モジュールで同型の実装が並立すると
 * 片方だけ直す修正漏れが起きるため、共有部分をここに集約する。
 *
 * エラー文言は MOQLOG / MOQMETRICS で別々の文字列がテストで固定されているため、
 * 呼び出し側からラベルを受け取って組み立てる。
 */

import { ProtocolViolationError } from "./error";

/**
 * Group ID の 62-bit truncate マスク（draft-ietf-moq-msf-01 §9.3 / §10.3）
 *
 * Group ID は時刻を 62-bit バイナリ整数に truncate した値とし、時間順の
 * 自然な並びを実現する。
 */
const GROUP_ID_MASK_62 = (1n << 62n) - 1n;

/**
 * syslog severity / granularity level の文字列 ↔ 優先度（0-7）の対応
 *
 * draft-ietf-moq-msf-01 §9.2 / §10.2 と [RFC5424] の規約に従う。
 * MOQLOG の severity と MOQMETRICS の granularity は同じ 8 段階を共有する
 * (MOQMETRICS は「syslog severity と同一規約」と定める)。
 *
 * 注意: [MOQLOG] §7 の例は "Info" という短縮形を使うが、§4 本文の正規形は
 * "Informational" である。本表は §4 本文の正規形（フルスペル）を正とする。
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
 * 時刻値を 62-bit Group ID へ truncate する
 *
 * @param value - Unix epoch からの時刻（非負）
 * @param label - エラー文言に使う対象名（例: "log group"）
 * @throws Error value が負の場合
 */
export function observabilityGroupId(value: bigint, label: string): bigint {
  if (value < 0n) {
    throw new Error(`${label} timestamp must be non-negative: ${value}`);
  }
  return value & GROUP_ID_MASK_62;
}

/**
 * 0-7 のレベルを 1 バイトの Track Name にする
 *
 * Track Name はレベルをバイナリで持つ 1 バイト（0=Emergency - 7=Debug）。
 *
 * @param level - 0-7 のレベル
 * @param label - エラー文言に使う対象名（例: "log priority"）
 * @throws Error level が 0-7 の整数でない場合
 */
export function observabilityTrackName(level: number, label: string): Uint8Array {
  if (!Number.isInteger(level) || level < 0 || level > 7) {
    throw new Error(`${label} level must be an integer 0-7: ${level}`);
  }
  return new Uint8Array([level]);
}

/**
 * Track Namespace の 2 タプル（prefix, resourceID）を組み立てる
 *
 * resourceID は非空であること。draft-ietf-moq-transport-21 §2.4.1 は各 namespace
 * 要素に 1 バイト以上を MUST とし、空要素は下流の Track Namespace エンコードで
 * 拒否される。
 *
 * @param prefix - Track Namespace の prefix
 * @param resourceId - resource ID
 * @param what - エラー文言に使う対象名（例: "moqlog"）
 * @throws Error resourceId が空の場合
 */
export function observabilityTrackNamespace(
  prefix: string,
  resourceId: string,
  what: string,
): [string, string] {
  if (resourceId === "") {
    throw new Error(`${what} resourceId must not be empty`);
  }
  return [prefix, resourceId];
}

/**
 * payload バイト列を JSON object にデコードする共通処理
 *
 * @param data - Object Payload のバイト列
 * @param what - エラー文言に使う対象名（例: "moqlog" / "moqmetrics capture object"）
 * @throws ProtocolViolationError JSON が不正、または object でない場合
 */
export function decodeObservabilityJson(data: Uint8Array, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    // 不正 UTF-8 を U+FFFD に置換せず throw させ、ProtocolViolationError 経路に載せる
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProtocolViolationError(`invalid ${what} payload JSON: ${message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProtocolViolationError(`${what} payload must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}
