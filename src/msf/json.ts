/**
 * JSON wire format と bigint の相互変換 helper
 *
 * MOQT Location (Group ID / Object ID) は vi64 (unsigned 64bit) だが、MSF の
 * JSON wire format では number として表現される。precision loss / 負数を検出して
 * reject する共通処理をまとめる。
 *
 * 参照: draft-ietf-moq-msf-01 §7.4.1 / draft-ietf-moq-transport-21 §8
 */

/**
 * MOQT Location 由来の JSON number を bigint に変換する共通 helper。
 *
 * draft-ietf-moq-transport-21 §8 で Group ID / Object ID は vi64 (unsigned 64bit) と
 * 規定される。JSON wire format で値を載せる場合、`Number.MAX_SAFE_INTEGER` を超える領域は
 * `JSON.parse` の段階で既に丸められているため、安全側に倒して reject する。負数も unsigned
 * 値域違反として reject する。
 *
 * - 非 number → reject
 * - 非整数 → reject
 * - 負数 → reject (MOQT Location は unsigned)
 * - safe integer 範囲外 → precision loss として reject
 */
export function toMsfLocationBigInt(value: unknown, label: string, context: string): bigint {
  if (typeof value !== "number") {
    throw new Error(
      `invalid ${context}: ${label} must be a number per §7.4.1, got ${typeof value}`,
    );
  }
  if (!Number.isInteger(value)) {
    throw new Error(`invalid ${context}: ${label} must be an integer per §7.4.1, got ${value}`);
  }
  if (value < 0) {
    throw new Error(
      `invalid ${context}: ${label} must be non-negative (MOQT Location is unsigned), got ${value}`,
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `invalid ${context}: ${label} precision loss converting ${value} to bigint (outside safe integer range)`,
    );
  }
  return BigInt(value);
}

/**
 * bigint Location 値が JSON 安全範囲内に収まることを確認し、収まらなければ throw する。
 *
 * MOQT Location は vi64 (unsigned 64bit) で `Number.MAX_SAFE_INTEGER` を超える可能性が
 * あるが、JSON wire 上は number として表現されるため超えると precision loss が発生する。
 * encode 時点で検出することで「自分の出力を自分で decode できない」状態を防ぐ。
 */
export function assertJsonSafeBigInt(value: bigint, label: string, context: string): void {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (value < 0n) {
    throw new Error(
      `invalid ${context}: ${label} must be non-negative (MOQT Location is unsigned), got ${value}`,
    );
  }
  if (value > max) {
    throw new Error(
      `invalid ${context}: ${label} exceeds JSON safe integer range (max ${max}), got ${value}`,
    );
  }
}
