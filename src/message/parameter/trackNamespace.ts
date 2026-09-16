/**
 * MOQT Track Namespace / Track Name
 * draft-ietf-moq-transport-21 Section 8.7 (Track Namespace and Full Track Name)
 *
 * Track Namespace (Section 2.4.1 / §8.7) と Track Name のエンコード・デコード、
 * およびサイズ・予約名前空間の検証を扱う。
 * TRACK_NAMESPACE_PREFIX Parameter (§9.20.21) の Value もここで組み立てる。
 */

import { ProtocolViolationError } from "../../error";
import { decodeVarint, encodeVarint } from "../../varint";
import { assertLengthWithinData } from "../../length";
import { concatUint8Arrays } from "../../bytes";
import { type Parameter } from "./common";

/**
 * Track Namespace / Full Track Name の最大サイズ（バイト）
 *
 * draft-ietf-moq-transport-21:
 * Track Namespace と Full Track Name は最大 4,096 バイト。
 * 超過時は PROTOCOL_VIOLATION でセッションを終了する。
 * draft-ietf-moq-transport-21 Section 8.7
 */
export const MAX_TRACK_NAMESPACE_SIZE = 4096;
export const MAX_TRACK_NAME_SIZE = 4096;
export const MAX_FULL_TRACK_NAME_SIZE = 4096;

/**
 * Full Track Name の合計長を検証する
 *
 * draft-ietf-moq-transport-21 §8.7:
 * Namespace 全フィールド長 + Track Name 長の合計が 4096 バイトを
 * 超えてはならない (MUST NOT)。
 *
 * @param namespace - TrackNamespace
 * @param trackName - Track Name (UTF-8 文字列)
 * @throws ProtocolViolationError 合計長が 4096 バイトを超える場合
 */
export function validateFullTrackName(namespace: TrackNamespace, trackName: string): void {
  let totalSize = new TextEncoder().encode(trackName).length;
  for (const field of namespace.tuple) {
    totalSize += field.length;
  }
  if (totalSize > MAX_FULL_TRACK_NAME_SIZE) {
    throw new ProtocolViolationError(
      `full track name exceeds maximum size: ${totalSize} > ${MAX_FULL_TRACK_NAME_SIZE}`,
    );
  }
}

/**
 * Full Track Name の合計長をワイヤバイト長で検証する
 *
 * draft-ietf-moq-transport-21 §8.7:
 * 「The length of a Full Track Name is computed as the sum of the Track
 *  Namespace Field Length fields and the Track Name Length field.」
 * Length フィールドの値のみを加算し、varint エンコードサイズは含まない。
 * 4,096 バイトちょうどは許容される。
 *
 * string ベースの validateFullTrackName は TextEncoder による再エンコードで
 * 長さを計測するため、不正な UTF-8 バイト列は TextDecoder の置換 (U+FFFD) で
 * 長さが水増しされ、誤って超過判定されたり、BOM 除去で短く計測されたりする。
 * デコード経路ではワイヤバイト長を直接加算する本関数を使用する。
 *
 * @param namespace - TrackNamespace
 * @param trackNameBytes - Track Name のワイヤバイト列
 * @throws ProtocolViolationError 合計長が 4096 バイトを超える場合
 */
export function validateFullTrackNameBytes(
  namespace: TrackNamespace,
  trackNameBytes: Uint8Array,
): void {
  let totalSize = trackNameBytes.length;
  for (const field of namespace.tuple) {
    totalSize += field.length;
  }
  if (totalSize > MAX_FULL_TRACK_NAME_SIZE) {
    throw new ProtocolViolationError(
      `full track name exceeds maximum size: ${totalSize} > ${MAX_FULL_TRACK_NAME_SIZE}`,
    );
  }
}

/**
 * Track Namespace の最大フィールド数
 *
 * draft-ietf-moq-transport-21 §8.7 (Track Namespace Structure):
 * "If an endpoint receives a Track Namespace consisting of greater than
 *  32 Track Namespace Fields, it MUST close the session with a
 *  PROTOCOL_VIOLATION."
 */
export const MAX_TRACK_NAMESPACE_FIELDS = 32;

/**
 * Track Namespace (Section 2.4.1)
 */
export interface TrackNamespace {
  tuple: Uint8Array[];
}

/**
 * Track Namespace をエンコードする
 *
 * draft-ietf-moq-transport-21:
 * Track Namespace は最大 4,096 バイト。
 * draft-ietf-moq-transport-21 Section 8.7
 */
export function encodeTrackNamespace(namespace: TrackNamespace): Uint8Array {
  assertTrackNamespaceTuple(namespace.tuple);

  const parts: Uint8Array[] = [encodeVarint(namespace.tuple.length)];

  for (const element of namespace.tuple) {
    parts.push(encodeVarint(element.length));
    parts.push(element);
  }

  // 結合
  return concatUint8Arrays(parts);
}

/**
 * Track Namespace の tuple が構造の制約を満たすか検証する (送信側)
 *
 * draft-ietf-moq-transport-21 §8.7 (Track Namespace Structure):
 * - "If an endpoint receives a Track Namespace consisting of greater than 32 Track
 *    Namespace Fields, it MUST close the session with a PROTOCOL_VIOLATION."
 * - "Each Track Namespace Field Value MUST contain at least one byte."
 * - 合計サイズの上限 (MAX_TRACK_NAMESPACE_SIZE = 4,096) も併せて検証する。
 *
 * 0 フィールドの Track Namespace は §2.4.1 (Track Naming) の
 * "between 0 and 32 Track Namespace Fields" により正当なため拒否しない。
 *
 * 受信したワイヤの違反ではないため ProtocolViolationError は使わない
 * (`createTrackNamespace` と同じ契約)。検証順は
 * フィールド数 → フィールド長 0 → 合計サイズとし、既存の期待文言を保つ。
 *
 * @throws Error 制約に違反する場合
 */
export function assertTrackNamespaceTuple(tuple: readonly Uint8Array[]): void {
  if (tuple.length > MAX_TRACK_NAMESPACE_FIELDS) {
    throw new Error(
      `track namespace fields exceeds maximum: ${tuple.length} > ${MAX_TRACK_NAMESPACE_FIELDS}`,
    );
  }

  let dataSize = 0;
  for (const element of tuple) {
    if (element.length === 0) {
      throw new Error("track namespace field length is zero");
    }
    dataSize += element.length;
  }
  if (dataSize > MAX_TRACK_NAMESPACE_SIZE) {
    throw new Error(
      `track namespace exceeds maximum size: ${dataSize} > ${MAX_TRACK_NAMESPACE_SIZE}`,
    );
  }
}

/**
 * Track Namespace をデコードする
 *
 * draft-ietf-moq-transport-21:
 * Track Namespace は最大 4,096 バイト。
 * draft-ietf-moq-transport-21 Section 8.7
 *
 * @returns [namespace, consumed bytes]
 */
export function decodeTrackNamespace(data: Uint8Array, offset = 0): [TrackNamespace, number] {
  const [numElements, consumed] = decodeVarint(data, offset);
  let totalConsumed = consumed;

  // draft-ietf-moq-transport-21 §8.7 (Track Namespace Structure):
  // フィールド数が 32 を超える場合は PROTOCOL_VIOLATION
  if (Number(numElements) > MAX_TRACK_NAMESPACE_FIELDS) {
    throw new ProtocolViolationError(
      `track namespace fields exceeds maximum: ${numElements} > ${MAX_TRACK_NAMESPACE_FIELDS}`,
    );
  }

  const elements: Uint8Array[] = [];
  let dataSize = 0;

  for (let i = 0; i < Number(numElements); i++) {
    const [elemLen, lenConsumed] = decodeVarint(data, offset + totalConsumed);
    totalConsumed += lenConsumed;
    // draft-ietf-moq-transport-21 Section 2.4.1:
    // "Each Track Namespace Field Value MUST contain at least one byte.
    //  If an endpoint receives a Track Namespace Field with a Track
    //  Namespace Field Length of 0, it MUST close the session with a
    //  PROTOCOL_VIOLATION."
    if (elemLen === 0n) {
      throw new ProtocolViolationError("track namespace field length is zero");
    }
    assertLengthWithinData("track namespace field", elemLen, offset + totalConsumed, data.length);
    const element = data.slice(offset + totalConsumed, offset + totalConsumed + Number(elemLen));
    elements.push(element);
    totalConsumed += Number(elemLen);
    dataSize += Number(elemLen);
  }

  if (dataSize > MAX_TRACK_NAMESPACE_SIZE) {
    throw new ProtocolViolationError(
      `track namespace exceeds maximum size: ${dataSize} > ${MAX_TRACK_NAMESPACE_SIZE}`,
    );
  }

  return [{ tuple: elements }, totalConsumed];
}

/**
 * string[] から TrackNamespace を作成
 *
 * draft-ietf-moq-transport-21 §8.7 (Track Namespace Structure):
 * Track Namespace は最大 32 フィールド・最大 4,096 バイト。
 * 各フィールドは 1 バイト以上。
 */
export function createTrackNamespace(parts: string[]): TrackNamespace {
  const encoder = new TextEncoder();
  const tuple = parts.map((p) => encoder.encode(p));
  assertTrackNamespaceTuple(tuple);

  return { tuple };
}

/**
 * TrackNamespace を string[] に変換
 */
export function trackNamespaceToStrings(namespace: TrackNamespace): string[] {
  const decoder = new TextDecoder();
  return namespace.tuple.map((t) => decoder.decode(t));
}

/**
 * Track Namespace が session-level かを判定する
 *
 * draft-ietf-moq-transport-21 §6.5 (Session-Level Tracks):
 * "MOQT defines the .session namespace ... in the first position of
 *  the Track Namespace for session-level tracks and namespaces."
 */
function isSessionLevelNamespace(tuple: Uint8Array[]): boolean {
  const [firstField] = tuple;
  if (firstField === undefined) return false;
  const [firstByte] = firstField;
  if (firstByte !== 0x2e) return false;
  const decoder = new TextDecoder();
  return decoder.decode(firstField) === ".session";
}

/**
 * 受信した Track Namespace を DOES_NOT_EXIST で拒否すべきかを判定する
 *
 * draft-ietf-moq-transport-21 §2.4.2 (Reserved Namespaces):
 * "A Track Namespace whose first field is exactly . (a single period,
 *  0x2e) is reserved and MUST NOT be used for any purpose; endpoints
 *  MUST NOT publish tracks or namespaces under it and MUST reject
 *  requests referencing it with DOES_NOT_EXIST."
 * draft-ietf-moq-transport-21 §6.5 (Session-Level Tracks and Namespaces):
 * "An endpoint that receives a request for an unrecognized session-level
 *  track or namespace MUST reject it with REQUEST_ERROR using error code
 *  DOES_NOT_EXIST rather than passing it to the Application."
 *
 * 拒否対象は "." 単体と ".session" のみに限定する。それ以外の予約
 * 名前空間 (例: ".foo") は §2.4.2 の "an endpoint that receives a
 * request for an unrecognized reserved namespace MUST pass it to the
 * Application" により拒否せずアプリへ渡す (送信側の ". で始まる
 * すべてを拒否する方針 (validateTrackNamespaceForSend) は受信側には
 * 持ち込まない)。
 *
 * 将来 .session 配下の既知の track を実装する場合、§6.5 の拒否 MUST
 * は "unrecognized" な session-level track / namespace に限定される
 * ため、本関数を namespace 単位の全拒否から track 単位の認識判定へ
 * 緩和すること。
 */
export function isRejectedReceiveNamespace(tuple: Uint8Array[]): boolean {
  const [firstField] = tuple;
  if (firstField === undefined) return false;
  // "." 単体 (0x2e 1 バイトのみ) は §2.4.2 により MUST 拒否
  const [firstByte] = firstField;
  if (firstField.length === 1 && firstByte === 0x2e) return true;
  // 先頭フィールドが .session なら §6.5 により MUST 拒否。
  // 本関数は namespace のみで判定し、Track Name は判定に使わないため、
  // Track Name が空でも非空でも拒否対象になる (空 Track Name の MUST 拒否を包含)。
  return isSessionLevelNamespace(tuple);
}

/**
 * Track Name をエンコードする（サイズ検証付き）
 *
 * draft-ietf-moq-transport-21:
 * Full Track Name は最大 4,096 バイト。
 * draft-ietf-moq-transport-21 Section 8.7
 */
export function encodeTrackName(trackName: string): Uint8Array {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(trackName);

  if (bytes.length > MAX_TRACK_NAME_SIZE) {
    throw new Error(`track name exceeds maximum size: ${bytes.length} > ${MAX_TRACK_NAME_SIZE}`);
  }

  return bytes;
}

/**
 * TRACK_NAMESPACE_PREFIX パラメータをエンコードする
 *
 * draft-ietf-moq-transport-21 §9.20.21:
 * "The TRACK_NAMESPACE_PREFIX parameter (Parameter Type 0x34) uses the
 *  Track Namespace encoding described in Section 8.7."
 * Track Namespace は自己区切りのため、外側 Length は付加しない。
 */
export function encodeParameterTrackNamespace(namespace: TrackNamespace): Parameter {
  const value = encodeTrackNamespace(namespace);
  return { type: 0x34, value };
}
