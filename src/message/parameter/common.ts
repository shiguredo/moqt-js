/**
 * MOQT Parameter モジュール群の共通定義
 * draft-ietf-moq-transport-21 Section 9.20 (Message Parameter)
 *
 * Key-Value-Pair (Section 8.3) / Message Parameter (Section 9.20) /
 * Location Filter (§9.20.10) / Range Filter (§3.3.2, §9.20.11-9.20.15) /
 * Track Namespace (§8.7) の各モジュールが共有する型と上限値を置く。
 */

/**
 * MOQT Parameter (Message Parameter)
 *
 * draft-ietf-moq-transport-21 §9.20:
 * Value のエンコーディングはパラメータ型ごとの定義で決まる
 * (MESSAGE_PARAMETER_VALUE_ENCODING を参照)。偶数型 / 奇数型で一律には決まらない。
 * 例えば 0x09 (location) / 0x21 (self-length-prefixed) / 0x34 (track-namespace) は
 * 偶数・奇数規則に当てはまらない。
 */
export interface Parameter {
  type: number;
  value: Uint8Array;
}

/**
 * Key-Value-Pair の Value 最大長（バイト）
 *
 * draft-ietf-moq-transport-21 §8.3:
 * 「The maximum length of a value is 2^16-1 bytes. If an endpoint receives
 *  a length larger than the maximum, it MUST close the session with a
 *  PROTOCOL_VIOLATION.」
 */
export const MAX_KVP_VALUE_LENGTH = 65535;

/**
 * Reason Phrase の最大長 (バイト)
 *
 * draft-ietf-moq-transport-21 Section 8.5:
 * "The reason phrase length has a maximum value of 1024 bytes.
 *  If an endpoint receives a length exceeding the maximum,
 *  it MUST close the session with a PROTOCOL_VIOLATION"
 *
 * Reason Phrase は Parameter ではないが、分割前から本モジュール
 * (src/message/parameter.ts) が公開していたため、共通定義に置いて
 * 従来の import パスを維持する。
 */
export const MAX_REASON_PHRASE_LENGTH = 1024;
