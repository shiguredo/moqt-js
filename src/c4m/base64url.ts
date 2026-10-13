/**
 * base64url (RFC 4648 Section 5) と標準 Base64 (Section 4) のエンコード / デコード
 *
 * CAT の compact 形式 (draft-ietf-moq-c4m-01 付録 A) と JWS compact (RFC 7515) は
 * パディング無しの base64url を使う。CAT トークンを URL に埋め込む場合は標準 Base64
 * (draft-ietf-moq-c4m-01 Section 2 / Section 4) が使われるため、トークン全体の
 * デコードでは両方のアルファベットを受理する。
 *
 * 実装は次の理由で自前で持つ (atob / btoa も Uint8Array.fromBase64 も使わない)。
 *
 * - atob / btoa は base64url のアルファベット (`-` / `_`) を受理しない
 *   (HTML Standard の forgiving-base64 が定めるのは `+` / `/` だけである)
 * - Uint8Array.fromBase64 / Uint8Array.prototype.toBase64
 *   (tc39/proposal-arraybuffer-base64) は Baseline 2025 で、Chrome 140 /
 *   Firefox 133 / Safari 18.2 / Node.js 25.0.0 からである。Node.js 22.22.2 以降で
 *   テストするため、テスト環境では動かない
 * - 受理規則が異なる。`lastChunkHandling: "loose"` (既定) はデコード時に余るビットが
 *   0 でない入力を捨てて受理し、ASCII の空白も無視する。ここでは RFC 4648
 *   Section 3.5 のとおり余るビットが 0 でない入力を非正規なエンコードとして拒否し、
 *   空白も不正な文字として拒否する。`"strict"` はパディングを必須とするため、
 *   パディングの有無を問わないここでの受理集合と一致しない
 * - 標準 Base64 と base64url を試行で判別し、失敗の詳細を Base64DecodeError として
 *   呼び出し側へ渡す必要がある
 *
 * この判断は将来変わり得る。Node.js 25 以降とネイティブ API を前提にできるように
 * なった時点で置き換えを再検討する。置き換えるときは、受理集合の差 (余るビット /
 * 空白 / パディングの有無) をテストで固定してから行うこと。
 */

/** 標準 Base64 のアルファベット (RFC 4648 Section 4) */
const BASE64_STANDARD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** base64url のアルファベット (RFC 4648 Section 5) */
const BASE64_URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** 1 文字あたりのビット数 (RFC 4648 Section 4) */
const BITS_PER_CHARACTER = 6;

/** パディング 1 文字で表現するビット数 (Base64 の 1 文字は 6 ビットだが、パディングは端数処理のみ) */
const PADDING_CHARACTER = "=";

/**
 * base64url / Base64 のデコードエラー
 *
 * 入力のどこが不正だったかをメッセージに含める。呼び出し側は形式ごとのエラー
 * (CatError など) へ変換する。
 */
export class Base64DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Base64DecodeError";
  }
}

/**
 * アルファベット文字から 6 ビット値への対応表を作る
 */
function buildLookupTable(alphabet: string): ReadonlyMap<string, number> {
  const table = new Map<string, number>();
  for (let index = 0; index < alphabet.length; index++) {
    table.set(alphabet.charAt(index), index);
  }
  return table;
}

const BASE64_STANDARD_LOOKUP = buildLookupTable(BASE64_STANDARD_ALPHABET);
const BASE64_URL_LOOKUP = buildLookupTable(BASE64_URL_ALPHABET);

/**
 * 6 ビット値からアルファベット文字への対応表を作る
 */
function buildEncodeTable(alphabet: string): string[] {
  const table: string[] = [];
  for (let index = 0; index < alphabet.length; index++) {
    table.push(alphabet.charAt(index));
  }
  return table;
}

const BASE64_URL_ENCODE_TABLE = buildEncodeTable(BASE64_URL_ALPHABET);

/**
 * パディング無しの base64url でエンコードする (RFC 4648 Section 5)
 *
 * @param bytes - エンコードするバイト列
 * @returns パディング無しの base64url 文字列
 */
export function encodeBase64Url(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const remaining = bytes.length - index;
    const chunk = (first << 16) | (second << 8) | third;
    // 3 バイトを 4 文字 (6 ビット x 4) に展開する。端数は 1 バイト = 2 文字、
    // 2 バイト = 3 文字になる (RFC 4648 Section 4)
    result += BASE64_URL_ENCODE_TABLE[(chunk >> 18) & 0x3f] ?? "";
    result += BASE64_URL_ENCODE_TABLE[(chunk >> 12) & 0x3f] ?? "";
    if (remaining > 1) {
      result += BASE64_URL_ENCODE_TABLE[(chunk >> 6) & 0x3f] ?? "";
    }
    if (remaining > 2) {
      result += BASE64_URL_ENCODE_TABLE[chunk & 0x3f] ?? "";
    }
  }
  return result;
}

/**
 * 指定したアルファベットでデコードする
 *
 * @param text - デコードする文字列
 * @param lookup - アルファベット文字から 6 ビット値への対応表
 * @param allowPadding - 末尾のパディング (`=`) を受理するかどうか
 * @returns デコードしたバイト列
 * @throws Base64DecodeError 文字種・長さ・パディング・端数ビットが不正な場合
 */
function decodeWithAlphabet(
  text: string,
  lookup: ReadonlyMap<string, number>,
  allowPadding: boolean,
): Uint8Array {
  let dataLength = text.length;
  if (allowPadding) {
    while (dataLength > 0 && text.charAt(dataLength - 1) === PADDING_CHARACTER) {
      dataLength -= 1;
    }
  } else if (text.includes(PADDING_CHARACTER)) {
    throw new Base64DecodeError("padding is not allowed here");
  }
  const paddingLength = text.length - dataLength;
  if (paddingLength > 2) {
    throw new Base64DecodeError(`invalid base64 padding length: ${paddingLength}`);
  }
  if (dataLength % 4 === 1) {
    throw new Base64DecodeError(`invalid base64 length: ${text.length}`);
  }
  if (paddingLength > 0 && (dataLength + paddingLength) % 4 !== 0) {
    throw new Base64DecodeError(`invalid base64 padding position: ${text.length}`);
  }
  const output = new Uint8Array(Math.floor((dataLength * BITS_PER_CHARACTER) / 8));
  let buffer = 0;
  let bits = 0;
  let outputIndex = 0;
  for (let index = 0; index < dataLength; index++) {
    const character = text.charAt(index);
    const value = lookup.get(character);
    if (value === undefined) {
      throw new Base64DecodeError(`invalid base64 character: ${character}`);
    }
    buffer = (buffer << BITS_PER_CHARACTER) | value;
    bits += BITS_PER_CHARACTER;
    if (bits >= 8) {
      bits -= 8;
      output[outputIndex] = (buffer >>> bits) & 0xff;
      outputIndex += 1;
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) {
    throw new Base64DecodeError("non-zero trailing bits in base64");
  }
  return output;
}

/**
 * base64url をデコードする (RFC 4648 Section 5)
 *
 * パディング無しを優先し、失敗した場合はパディング付きとして再試行する。
 * JWK (RFC 7517) と JWS compact (RFC 7515 Section 2) はパディング無しが仕様だが、
 * パディング付きの入力も受理する。
 *
 * @param text - デコードする base64url 文字列
 * @returns デコードしたバイト列
 * @throws Base64DecodeError どちらの表現としても不正な場合
 */
export function decodeBase64Url(text: string): Uint8Array {
  try {
    return decodeWithAlphabet(text, BASE64_URL_LOOKUP, false);
  } catch (error) {
    if (!(error instanceof Base64DecodeError)) {
      throw error;
    }
    return decodeWithAlphabet(text, BASE64_URL_LOOKUP, true);
  }
}

/**
 * base64url または標準 Base64 (RFC 4648 Section 4) をデコードする
 *
 * CAT トークンを URL に埋め込む場合は標準 Base64 が使われるため
 * (draft-ietf-moq-c4m-01 Section 2 / Section 4)、トークン全体のデコードでは両方を
 * 受理する。base64url を優先し、パディングの有無も両方を受ける。
 *
 * 標準 Base64 のパディング無しは試さない。受理の差はパディングの扱いだけであり、
 * パディング有りの受理集合がパディング無しの上位集合になるためである
 * (標準 Base64 のパディング無しで成功する入力は、パディング有りでも成功する)。
 *
 * @param text - デコードする文字列
 * @returns デコードしたバイト列
 * @throws Base64DecodeError どの表現としても不正な場合
 */
export function decodeBase64OrUrl(text: string): Uint8Array {
  let error: Base64DecodeError;
  try {
    return decodeWithAlphabet(text, BASE64_URL_LOOKUP, false);
  } catch (caught) {
    error = toBase64DecodeError(caught);
  }
  try {
    return decodeWithAlphabet(text, BASE64_URL_LOOKUP, true);
  } catch (caught) {
    error = toBase64DecodeError(caught);
  }
  try {
    return decodeWithAlphabet(text, BASE64_STANDARD_LOOKUP, true);
  } catch (caught) {
    error = toBase64DecodeError(caught);
  }
  throw error;
}

/**
 * Base64DecodeError 以外は呼び出し元へそのまま伝播させる
 */
function toBase64DecodeError(error: unknown): Base64DecodeError {
  if (error instanceof Base64DecodeError) {
    return error;
  }
  throw error;
}

/**
 * base64url または標準 Base64 のデコードを試みる
 *
 * 形式の自動判別 (CatToken.decode) で、失敗を例外ではなく値で扱いたい場合に使う。
 *
 * @param text - デコードする文字列
 * @returns デコードしたバイト列。どの表現としても不正な場合は undefined
 */
export function tryDecodeBase64OrUrl(text: string): Uint8Array | undefined {
  try {
    return decodeBase64OrUrl(text);
  } catch (error) {
    if (error instanceof Base64DecodeError) {
      return undefined;
    }
    throw error;
  }
}
