/**
 * GREASE (Generate Random Extensions And Sustain Extensibility)
 * draft-ietf-moq-transport-20 Section 14 (Grease)
 *
 * 未知の値を正しくハンドリングすることを保証するために、
 * 各レジストリに GREASE 用の予約値が定義されている。
 *
 * GREASE 値のパターン: 0x7f * N + 0x9D (N は非負整数)
 * つまり: 0x9D, 0x11C, 0x19B, 0x21A, ...
 *
 * 対象レジストリ:
 * - Setup Options (Section 15.4)
 * - Properties (Section 15.8)
 * - Session Termination Error Codes (Section 15.11.1)
 * - REQUEST_ERROR Codes (Section 15.11.2)
 * - PUBLISH_DONE Codes (Section 15.11.3)
 * - Stream Reset Error Codes (Section 15.11.4)
 * - MOQT Auth Token Type
 */

/**
 * GREASE 値の基数
 */
const GREASE_BASE = 0x9dn;

/**
 * GREASE 値の間隔
 */
const GREASE_INTERVAL = 0x7fn;

/**
 * 値が GREASE 値かどうかを判定する
 *
 * GREASE 値は 0x7f * N + 0x9D のパターンに一致する。
 */
export function isGreaseValue(value: bigint): boolean {
  if (value < GREASE_BASE) {
    return false;
  }
  return (value - GREASE_BASE) % GREASE_INTERVAL === 0n;
}

/**
 * GREASE 値を生成する
 *
 * @param n - 非負整数のインデックス (0 以上)
 * @returns 0x7f * n + 0x9D
 */
export function generateGreaseValue(n: number): bigint {
  if (n < 0) {
    throw new Error(`GREASE index must be non-negative: ${n}`);
  }
  return GREASE_INTERVAL * BigInt(n) + GREASE_BASE;
}
