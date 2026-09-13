/**
 * MOQT Key-Value-Pair
 * draft-ietf-moq-transport-21 Section 8.3 (Key-Value-Pair Structure)
 *
 * https://www.ietf.org/archive/id/draft-ietf-moq-transport-21.html#section-8.3
 *
 * Key-Value-Pair {
 *   Type (i),
 *   [Length (i),]
 *   Value (..),
 * }
 *
 * 偶数型: varint 値 / 奇数型: Length プレフィックス付きバイト列という規則に従う。
 * Message Parameter (§9.20) は型ごとに Value のエンコーディングが異なるため
 * ./messageParameter が扱う (本モジュールの規則は適用されない)。
 */

import { ProtocolViolationError } from "../../error";
import { decodeVarint, encodeVarint, MAX_VARINT } from "../../varint";
import { assertLengthWithinData } from "../../length";
import { concatUint8Arrays } from "../../bytes";
import { MAX_KVP_VALUE_LENGTH, type Parameter } from "./common";

/**
 * 単一のパラメータを delta encoding でエンコードする
 *
 * draft-ietf-moq-transport-21 Section 8.3 (Key-Value-Pair Structure):
 * https://www.ietf.org/archive/id/draft-ietf-moq-transport-21.html#section-8.3
 * Key-Value-Pairs encode a Type value as a delta from the previous Type value,
 * or from 0 if there is no previous Type value.
 *
 * @param param - エンコードするパラメータ
 * @param previousType - 前のパラメータの Type 値（最初のパラメータの場合は 0）
 * @returns エンコードされたバイト列
 */
function encodeKeyValuePair(param: Parameter, previousType: number): Uint8Array {
  const deltaType = param.type - previousType;
  if (deltaType < 0) {
    throw new Error(
      `delta type must be non-negative: current type=${param.type}, previous type=${previousType}`,
    );
  }

  const deltaBytes = encodeVarint(deltaType);

  if (param.type % 2 === 1) {
    // 奇数型: Length プレフィックス付き
    const lengthBytes = encodeVarint(param.value.length);
    return concatUint8Arrays([deltaBytes, lengthBytes, param.value]);
  }

  // 偶数型: 値のみ
  return concatUint8Arrays([deltaBytes, param.value]);
}

/**
 * Key-Value-Pair を 1 つデコードする
 *
 * @param data - デコード対象データ
 * @param offset - 開始オフセット
 * @param previousType - 前のパラメータの Type 値（最初のパラメータの場合は 0）
 * @returns [parameter, consumed bytes, paramType (bigint)]
 *          paramType は次のパラメータの previousType に使う。
 *          Parameter.type (number) への変換は丸めが発生するため、
 *          連続デコードのアキュムレータには bigint の paramType を使うこと。
 */
function decodeKeyValuePair(
  data: Uint8Array,
  offset: number,
  previousType: bigint,
): [Parameter, number, bigint] {
  const [deltaType, deltaConsumed] = decodeVarint(data, offset);
  const paramType = previousType + deltaType;

  // draft-ietf-moq-transport-21 Section 8.3:
  // "The previous Type value plus the Delta Type MUST NOT be greater than
  //  2^64 - 1. If a Delta Type is received that would be too large, the
  //  Session MUST be closed with a PROTOCOL_VIOLATION."
  if (paramType > MAX_VARINT) {
    throw new ProtocolViolationError(
      `delta type addition exceeds maximum: ${paramType} > ${MAX_VARINT}`,
    );
  }

  let totalConsumed = deltaConsumed;

  let value: Uint8Array;

  if (paramType % 2n === 1n) {
    // 奇数型: Length プレフィックス付き
    const [length, lengthConsumed] = decodeVarint(data, offset + totalConsumed);
    totalConsumed += lengthConsumed;
    if (Number(length) > MAX_KVP_VALUE_LENGTH) {
      throw new ProtocolViolationError(
        `parameter value length exceeds maximum: ${length} > ${MAX_KVP_VALUE_LENGTH}`,
      );
    }
    assertLengthWithinData("parameter value", length, offset + totalConsumed, data.length);
    value = data.slice(offset + totalConsumed, offset + totalConsumed + Number(length));
    totalConsumed += Number(length);
  } else {
    // 偶数型: varint 値
    const [val, valConsumed] = decodeVarint(data, offset + totalConsumed);
    value = encodeVarint(val);
    totalConsumed += valConsumed;
  }

  return [{ type: Number(paramType), value }, totalConsumed, paramType];
}

/**
 * Key-Value-Pairs をカウントプレフィックスなしでエンコードする
 *
 * draft-ietf-moq-transport-21 Section 9.1 (SETUP):
 * Setup Options は Key-Value-Pairs (Figure 2) としてシリアライズされ、
 * カウントプレフィックスを持たない。Length フィールドで終端が決まる。
 *
 * パラメータは Type の昇順でなければならない。
 */
export function encodeKeyValuePairs(params: Parameter[]): Uint8Array {
  const paramBytes: Uint8Array[] = [];
  let previousType = 0;

  for (const param of params) {
    paramBytes.push(encodeKeyValuePair(param, previousType));
    previousType = param.type;
  }

  return concatUint8Arrays(paramBytes);
}

/**
 * Key-Value-Pairs をカウントプレフィックスなしでデコードする
 *
 * draft-ietf-moq-transport-21 Section 9.1 (SETUP):
 * Setup Options は Key-Value-Pairs (Figure 2) としてシリアライズされ、
 * カウントプレフィックスを持たない。データ末尾まで KVP を読む。
 *
 * @returns [parameters, consumed bytes]
 */
export function decodeKeyValuePairs(data: Uint8Array, offset = 0): [Parameter[], number] {
  const parameters: Parameter[] = [];
  let totalConsumed = 0;
  let previousType = 0n;

  while (offset + totalConsumed < data.length) {
    const [param, paramConsumed, paramType] = decodeKeyValuePair(
      data,
      offset + totalConsumed,
      previousType,
    );
    parameters.push(param);
    totalConsumed += paramConsumed;
    previousType = paramType;
  }

  return [parameters, totalConsumed];
}
