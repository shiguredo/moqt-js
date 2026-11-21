import { ProtocolViolationError, SessionErrorCode } from "../error";
import { assertLengthWithinData } from "../length";
import { decodeVarint } from "../varint";
import { MAX_REASON_PHRASE_LENGTH } from "./parameter/types";

/** draft-ietf-moq-transport-23 §8.5: UTF-8 の Reason Phrase は最大 1,024 バイト。 */
export function encodeReasonPhraseValue(reasonPhrase: string): Uint8Array {
  const encoder = new TextEncoder();
  // UTF-16 のコード単位あたり最大 3 バイト (サロゲートペアは 2 単位で 4 バイト)。
  if (reasonPhrase.length * 3 <= MAX_REASON_PHRASE_LENGTH) {
    return encoder.encode(reasonPhrase);
  }
  // encodeInto は上限をまたぐ文字を書かないため、収まる接頭辞を送信できる。
  const target = new Uint8Array(MAX_REASON_PHRASE_LENGTH);
  const { written } = encoder.encodeInto(reasonPhrase, target);
  return target.subarray(0, written);
}

/** draft-ietf-moq-transport-23 §8.5: 宣言長が上限を超えた時点で拒否する。 */
export function decodeReasonPhrase(data: Uint8Array, offset: number): [string, number] {
  const [length, lengthSize] = decodeVarint(data, offset);
  if (Number(length) > MAX_REASON_PHRASE_LENGTH) {
    throw new ProtocolViolationError(
      `reason phrase length exceeds maximum: ${length} > ${MAX_REASON_PHRASE_LENGTH}`,
      SessionErrorCode.FIELD_LENGTH_EXCEEDED,
    );
  }
  const start = offset + lengthSize;
  assertLengthWithinData("reason phrase", length, start, data.length);
  const size = Number(length);
  const reasonPhrase = new TextDecoder().decode(data.subarray(start, start + size));
  return [reasonPhrase, lengthSize + size];
}
