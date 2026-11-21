/**
 * MOQT Key-Value-Pair
 * draft-ietf-moq-transport-23 Section 8.3 (Key-Value-Pair Structure)
 *
 * https://www.ietf.org/archive/id/draft-ietf-moq-transport-23.html#section-8.3
 *
 * Key-Value-Pair {
 *   Delta Type (vi64),
 *   [Length (vi64),]
 *   Value (..)
 * }
 *
 * 偶数型: varint 値 / 奇数型: Length プレフィックス付きバイト列という規則に従う。
 * Message Parameter (§9.19) は型ごとに Value のエンコーディングが異なるため
 * ./messageParameter が扱う (本モジュールの規則は適用されない)。
 */

import {
  IncompleteDataError,
  ProtocolViolationError,
  SessionError,
  SessionErrorCode,
} from "../../error";
import { decodeVarint, encodeVarint, MAX_VARINT } from "../../varint";
import { concatUint8Arrays } from "../../bytes";
import { MAX_KVP_VALUE_LENGTH, type Parameter } from "./types";

interface KeyValuePairDecodeOptions {
  knownTypes: ReadonlySet<bigint>;
  ignoreUnknown?: boolean;
}

/**
 * 単一のパラメータを delta encoding でエンコードする
 *
 * draft-ietf-moq-transport-23 Section 8.3 (Key-Value-Pair Structure):
 * https://www.ietf.org/archive/id/draft-ietf-moq-transport-23.html#section-8.3
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
    // draft-ietf-moq-transport-23 §8.3:
    // Value の最大長は 2^16-1 バイトであり、超過する値は送信できない。
    // 受信側は FIELD_LENGTH_EXCEEDED でセッションを閉じる。
    if (param.value.length > MAX_KVP_VALUE_LENGTH) {
      throw new Error(
        `key-value-pair value length ${param.value.length} exceeds maximum ${MAX_KVP_VALUE_LENGTH}`,
      );
    }
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
  options: KeyValuePairDecodeOptions | undefined,
): [Parameter | undefined, number, bigint] {
  const [deltaType, deltaConsumed] = decodeVarint(data, offset);
  const paramType = previousType + deltaType;

  // draft-ietf-moq-transport-23 §8.3:
  // "The previous Type value plus the Delta Type MUST NOT be greater than
  //  2^64 - 1. If a Delta Type is received that would be too large, the
  //  Session MUST be closed with DELTA_ENCODING_OVERFLOW."
  if (paramType > MAX_VARINT) {
    throw new ProtocolViolationError(
      `delta type addition exceeds maximum: ${paramType} > ${MAX_VARINT}`,
      SessionErrorCode.DELTA_ENCODING_OVERFLOW,
    );
  }

  const known = options?.knownTypes.has(paramType);
  const retain = known !== false || options?.ignoreUnknown !== true;
  const fieldOffset = offset + deltaConsumed;
  let field: bigint;
  let fieldConsumed: number;
  try {
    [field, fieldConsumed] = decodeVarint(data, fieldOffset);
  } catch (error) {
    // §8.3: 既知 Type の Length または Value が未完なら KVP 固有の形式違反。
    if (known === true && error instanceof IncompleteDataError) {
      throw new SessionError(
        `incomplete key-value-pair field for type 0x${paramType.toString(16)}: ${error.message}`,
        SessionErrorCode.MALFORMED_KEY_VALUE,
      );
    }
    throw error;
  }
  let totalConsumed = deltaConsumed + fieldConsumed;
  let value: Uint8Array | undefined;

  if (paramType % 2n === 1n) {
    // 奇数型では先に宣言 Length を検査し、未知型でも上限は適用する。
    const length = Number(field);
    if (length > MAX_KVP_VALUE_LENGTH) {
      // draft-ietf-moq-transport-23 §8.3:
      // "The maximum length of a value is 2^16-1 bytes. If an endpoint receives
      //  a length larger than the maximum, it MUST close the session with
      //  FIELD_LENGTH_EXCEEDED."
      throw new ProtocolViolationError(
        `parameter value length exceeds maximum: ${field} > ${MAX_KVP_VALUE_LENGTH}`,
        SessionErrorCode.FIELD_LENGTH_EXCEEDED,
      );
    }
    const valueStart = offset + totalConsumed;
    const valueEnd = valueStart + length;
    if (valueEnd > data.length) {
      const message = `parameter value length exceeds remaining data: ${length} > ${data.length - valueStart}`;
      if (known === true) {
        throw new SessionError(message, SessionErrorCode.MALFORMED_KEY_VALUE);
      }
      throw new ProtocolViolationError(message, SessionErrorCode.MALFORMED_MESSAGE);
    }
    if (retain) value = data.slice(valueStart, valueEnd);
    totalConsumed += length;
  } else if (retain) {
    // 偶数型: varint 値
    value = encodeVarint(field);
  }

  const parameter = value === undefined ? undefined : { type: Number(paramType), value };
  return [parameter, totalConsumed, paramType];
}

/**
 * Key-Value-Pairs をカウントプレフィックスなしでエンコードする
 *
 * draft-ietf-moq-transport-23 §9.1 (SETUP):
 * Setup Options は Key-Value-Pairs (Figure 4) としてシリアライズされ、
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
 * draft-ietf-moq-transport-23 §9.1 (SETUP):
 * Setup Options は Key-Value-Pairs (Figure 4) としてシリアライズされ、
 * カウントプレフィックスを持たない。データ末尾まで KVP を読む。
 *
 * @returns [parameters, consumed bytes]
 */
export function decodeKeyValuePairs(
  data: Uint8Array,
  offset = 0,
  options?: KeyValuePairDecodeOptions,
): [Parameter[], number] {
  const parameters: Parameter[] = [];
  let totalConsumed = 0;
  let previousType = 0n;

  while (offset + totalConsumed < data.length) {
    const [param, paramConsumed, paramType] = decodeKeyValuePair(
      data,
      offset + totalConsumed,
      previousType,
      options,
    );
    if (param !== undefined) parameters.push(param);
    totalConsumed += paramConsumed;
    previousType = paramType;
  }

  return [parameters, totalConsumed];
}
