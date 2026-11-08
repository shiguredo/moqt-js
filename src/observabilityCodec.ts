/**
 * MOQ Log / MOQ Metrics のバイナリ codec 共通 helper
 *
 * log-04 §5.3 と metrics-03 §5.3 は、どちらも vi64 の長さ付き ASCII / UTF-8
 * フィールドを持つ Object Payload である。切り詰め・長さ超過・文字コードの検査を
 * ここに集約し、各モジュールの差分がフィールド構成だけになるようにする。
 *
 * draft-jennings-moq-log-04 / draft-jennings-moq-metrics-03 は Internet-Draft であり、
 * 改版で節番号・規則が変わる可能性がある。
 */

import { concatUint8Arrays } from "./bytes";
import { IncompleteDataError, ProtocolViolationError, SessionErrorCode } from "./error";
import { isLengthWithinData } from "./length";
import { decodeVarint, encodeVarint } from "./varint";

const textEncoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * デコードの読み取り位置
 */
export interface DecodeCursor {
  offset: number;
}

/**
 * 孤立サロゲートの位置を返す
 *
 * TextEncoder は孤立サロゲートを U+FFFD に置換するため、round-trip を保つには
 * 送信前に拒否する必要がある。
 *
 * @returns 孤立サロゲートの位置。存在しなければ -1
 */
function findUnpairedSurrogateIndex(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return index;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return index;
    }
  }
  return -1;
}

/**
 * 値の型をエラー文言用に表す
 *
 * typeof null は "object" になるため、null をそのまま表示しない。
 */
export function describeType(value: unknown): string {
  return value === null ? "null" : typeof value;
}

/**
 * UTF-8 文字列をバイト列にする
 *
 * @param value - 変換する文字列
 * @param label - エラー文言に使う対象名（例: "moqlog"）
 * @param field - エラー文言に使うフィールド名
 * @throws Error 文字列でない場合、孤立サロゲートを含む場合
 */
export function encodeUtf8(value: string, label: string, field: string): Uint8Array {
  if (typeof value !== "string") {
    throw new Error(`${label} ${field} must be a string: ${describeType(value)}`);
  }
  const unpairedIndex = findUnpairedSurrogateIndex(value);
  if (unpairedIndex !== -1) {
    throw new Error(
      `${label} ${field} contains an unpaired surrogate at index ${unpairedIndex}: 0x${value.charCodeAt(unpairedIndex).toString(16)}`,
    );
  }
  return textEncoder.encode(value);
}

/**
 * UTF-8 バイト列を文字列にする
 *
 * TextDecoder の既定は先頭 BOM を除去するため、フィールドの一部として保持する
 * `ignoreBOM: true` を使う。
 *
 * @throws ProtocolViolationError 不正な UTF-8 の場合
 */
export function decodeUtf8(data: Uint8Array, label: string, field: string): string {
  try {
    return utf8Decoder.decode(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProtocolViolationError(
      `invalid ${label} ${field} UTF-8: ${message}`,
      SessionErrorCode.MALFORMED_OBJECT,
    );
  }
}

/**
 * ASCII 文字列をバイト列にする
 *
 * @throws Error 文字列でない場合、ASCII の範囲外の文字を含む場合
 */
export function encodeAscii(value: string, label: string, field: string): Uint8Array {
  if (typeof value !== "string") {
    throw new Error(`${label} ${field} must be a string: ${describeType(value)}`);
  }
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) > 0x7f) {
      throw new Error(`${label} ${field} must be ASCII: ${JSON.stringify(value)}`);
    }
  }
  return textEncoder.encode(value);
}

/**
 * ASCII バイト列を文字列にする
 *
 * @throws ProtocolViolationError 0x80 以上のバイトを含む場合
 */
export function decodeAscii(data: Uint8Array, label: string, field: string): string {
  for (const byte of data) {
    if (byte > 0x7f) {
      throw new ProtocolViolationError(
        `invalid ${label} ${field}: non-ASCII byte ${byte}`,
        SessionErrorCode.MALFORMED_OBJECT,
      );
    }
  }
  return utf8Decoder.decode(data);
}

/**
 * vi64 の長さフィールドとバイト列を連結する
 */
export function encodeLengthPrefixed(bytes: Uint8Array): Uint8Array {
  return concatUint8Arrays([encodeVarint(bytes.length), bytes]);
}

/**
 * vi64 を 1 つ読み取る
 *
 * @throws IncompleteDataError データが切り詰められている場合
 */
export function readVarint(
  data: Uint8Array,
  cursor: DecodeCursor,
  label: string,
  field: string,
): bigint {
  if (cursor.offset >= data.length) {
    throw new IncompleteDataError(`incomplete ${label} ${field}: no bytes remaining`);
  }
  try {
    const [value, length] = decodeVarint(data, cursor.offset);
    cursor.offset += length;
    return value;
  } catch (error) {
    if (error instanceof IncompleteDataError) {
      throw new IncompleteDataError(`incomplete ${label} ${field}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * 指定長のバイト列を読み取る
 *
 * @throws ProtocolViolationError 宣言長が残りバイトを超える場合
 */
export function readBytes(
  data: Uint8Array,
  cursor: DecodeCursor,
  length: bigint,
  label: string,
  field: string,
): Uint8Array {
  if (!isLengthWithinData(length, cursor.offset, data.length)) {
    throw new ProtocolViolationError(
      `${label} ${field} length exceeds remaining data: ${length} > ${data.length - cursor.offset}`,
      SessionErrorCode.MALFORMED_OBJECT,
    );
  }
  const start = cursor.offset;
  cursor.offset += Number(length);
  return data.subarray(start, cursor.offset);
}
