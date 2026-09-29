/**
 * COSE (CBOR Object Signing and Encryption) の構造
 *
 * RFC 9052 の COSE_Sign1 (タグ 18) / COSE_Mac0 (タグ 17) と、RFC 8392 の CWT
 * (タグ 61) を扱う。アルゴリズムの識別子は RFC 9053 の COSE Algorithms レジストリ
 * に従う。
 *
 * 署名 / 検証の実行は `./crypto.ts` のインターフェースに分離しており、このモジュール
 * は構造のエンコード / デコードと署名対象バイト列の組み立てだけを行う。
 */

import {
  CBOR_NULL,
  type CborValue,
  CborError,
  cborArray,
  cborAsArray,
  cborAsBytes,
  cborAsInteger,
  cborAsMap,
  cborByteString,
  cborEquals,
  cborInteger,
  cborMap,
  cborTag,
  cborTextString,
  decodeCbor,
  encodeCbor,
} from "./cbor";
import { unreachableValue } from "./unreachable";

/** CWT の CBOR タグ (RFC 8392 Section 6) */
export const TAG_CWT = 61n;

/** COSE_Mac0 の CBOR タグ (RFC 9052 Section 6.2) */
export const TAG_COSE_MAC0 = 17n;

/** COSE_Sign1 の CBOR タグ (RFC 9052 Section 4.2) */
export const TAG_COSE_SIGN1 = 18n;

/** ヘッダパラメータ `alg` (RFC 9052 Section 3.1) */
export const HEADER_ALGORITHM = 1n;

/** ヘッダパラメータ `crit` (RFC 9052 Section 3.1) */
export const HEADER_CRITICAL = 2n;

/** ヘッダパラメータ `content type` (RFC 9052 Section 3.1) */
export const HEADER_CONTENT_TYPE = 3n;

/** ヘッダパラメータ `kid` (RFC 9052 Section 3.1) */
export const HEADER_KEY_ID = 4n;

/** ヘッダパラメータ `typ` (RFC 9596 Section 2) */
export const HEADER_TYPE = 16n;

/**
 * ドラフトのテストベクタが HMAC-SHA256 に使うアルゴリズム ID
 *
 * draft-ietf-moq-c4m-01 付録 A のベクタは `alg = -4` を HMAC-SHA256 として扱う。
 * IANA の COSE Algorithms レジストリでは -4 は A192KW であり、HMAC 256/256 は 5
 * である。検証では両方を HMAC-SHA256 として扱い、発行は 5 を使う。
 */
export const C4M_DRAFT_HMAC_SHA256_ALGORITHM_ID = -4;

/**
 * COSE のアルゴリズム (RFC 9053 Section 2 / Section 3 のレジストリ値)
 */
export type Algorithm =
  | "HmacSha256"
  | "HmacSha384"
  | "HmacSha512"
  | "Es256"
  | "Es384"
  | "Es512"
  | "EdDsa";

/**
 * COSE のアルゴリズム識別子を返す
 */
export function algorithmIdentifier(algorithm: Algorithm): number {
  switch (algorithm) {
    case "HmacSha256":
      return 5;
    case "HmacSha384":
      return 6;
    case "HmacSha512":
      return 7;
    case "Es256":
      return -7;
    case "Es384":
      return -35;
    case "Es512":
      return -36;
    case "EdDsa":
      return -8;
    default:
      return unreachableValue(algorithm);
  }
}

/**
 * 識別子からアルゴリズムを返す
 *
 * C4M ドラフトの別名 (`-4` を HMAC-SHA256 とする) は含めない。別名を含めて解釈
 * する場合は `algorithmFromIdentifierWithC4mDraftAlias` を使う。
 */
export function algorithmFromIdentifier(identifier: bigint | number): Algorithm | undefined {
  const value = Number(identifier);
  switch (value) {
    case 5:
      return "HmacSha256";
    case 6:
      return "HmacSha384";
    case 7:
      return "HmacSha512";
    case -7:
      return "Es256";
    case -35:
      return "Es384";
    case -36:
      return "Es512";
    case -8:
      return "EdDsa";
    default:
      return undefined;
  }
}

/**
 * 識別子からアルゴリズムを返す (C4M ドラフトの別名を含む)
 *
 * draft-ietf-moq-c4m-01 付録 A のベクタが使う `-4` を HMAC-SHA256 として受理する。
 */
export function algorithmFromIdentifierWithC4mDraftAlias(
  identifier: bigint | number,
): Algorithm | undefined {
  if (Number(identifier) === C4M_DRAFT_HMAC_SHA256_ALGORITHM_ID) {
    return "HmacSha256";
  }
  return algorithmFromIdentifier(identifier);
}

/**
 * アルゴリズムの種別 (MAC か署名か) を返す
 */
export function algorithmClass(algorithm: Algorithm): "mac" | "signature" {
  switch (algorithm) {
    case "HmacSha256":
    case "HmacSha384":
    case "HmacSha512":
      return "mac";
    default:
      return "signature";
  }
}

/**
 * MAC アルゴリズムかどうかを返す
 */
export function algorithmIsMac(algorithm: Algorithm): boolean {
  return algorithmClass(algorithm) === "mac";
}

/**
 * JOSE の `alg` 名 (RFC 7518 Section 3.1 / RFC 8037 Section 3.1) からアルゴリズムを返す
 *
 * COSE と JOSE は同じ識別子体系を使うため、JWT の `alg` はこの対応で COSE の
 * アルゴリズムへ変換できる。
 */
export function algorithmFromJoseName(name: string): Algorithm | undefined {
  switch (name) {
    case "ES256":
      return "Es256";
    case "ES384":
      return "Es384";
    case "ES512":
      return "Es512";
    case "EdDSA":
      return "EdDsa";
    case "HS256":
      return "HmacSha256";
    case "HS384":
      return "HmacSha384";
    case "HS512":
      return "HmacSha512";
    default:
      return undefined;
  }
}

/**
 * JOSE の `alg` 名を返す
 */
export function algorithmJoseName(algorithm: Algorithm): string {
  switch (algorithm) {
    case "Es256":
      return "ES256";
    case "Es384":
      return "ES384";
    case "Es512":
      return "ES512";
    case "EdDsa":
      return "EdDSA";
    case "HmacSha256":
      return "HS256";
    case "HmacSha384":
      return "HS384";
    case "HmacSha512":
      return "HS512";
    default:
      return unreachableValue(algorithm);
  }
}

/**
 * 署名対象バイト列を組み立てるコンテキスト文字列を返す
 *
 * RFC 9052 Section 4.4 の `Sig_structure` は `"Signature1"`、Section 6.3 の
 * `MAC_structure` は `"MAC0"` を使う。
 */
export function algorithmClassContext(algorithmClassValue: "mac" | "signature"): string {
  return algorithmClassValue === "mac" ? "MAC0" : "Signature1";
}

/**
 * アルゴリズム種別に対応する構造の CBOR タグを返す
 */
export function algorithmClassTag(algorithmClassValue: "mac" | "signature"): bigint {
  return algorithmClassValue === "mac" ? TAG_COSE_MAC0 : TAG_COSE_SIGN1;
}

/**
 * COSE ヘッダの `kid`
 *
 * RFC 9052 Section 3.1 はバイト文字列とするが、CAT の実装にはテキスト文字列を
 * 使うものもあるため両方を保持する。
 */
export type CoseKeyId =
  | { readonly type: "bytes"; readonly value: Uint8Array }
  | { readonly type: "text"; readonly value: string };

/**
 * `kid` をバイト列として返す
 */
export function coseKeyIdAsBytes(keyId: CoseKeyId): Uint8Array {
  return keyId.type === "bytes" ? keyId.value : TEXT_ENCODER.encode(keyId.value);
}

/**
 * バイト文字列の `kid` を作る
 */
export function coseKeyIdBytes(value: Uint8Array): CoseKeyId {
  return { type: "bytes", value };
}

/**
 * テキスト文字列の `kid` を作る
 */
export function coseKeyIdText(value: string): CoseKeyId {
  return { type: "text", value };
}

/**
 * COSE の protected / unprotected ヘッダ
 *
 * 解釈しないパラメータは `raw` に保持し、再エンコード時に決定論的な順序で復元する。
 */
export interface CoseHeader {
  /** アルゴリズム (`alg`)。エイリアスを解決した結果 */
  algorithm: Algorithm | undefined;
  /** ヘッダに書かれていたアルゴリズム識別子の生値 */
  algorithmIdentifier: number | undefined;
  /** 鍵識別子 (`kid`) */
  keyId: CoseKeyId | undefined;
  /** 完全な COSE オブジェクトのコンテンツタイプ (`typ`、ラベル 16) */
  typ: CborValue | undefined;
  /** ペイロードのコンテンツタイプ (`content type`、ラベル 3) */
  contentType: CborValue | undefined;
  /** 必ず理解しなければならないヘッダパラメータ (`crit`) */
  critical: CborValue[];
  /** 解釈しなかったヘッダパラメータ */
  raw: Array<[CborValue, CborValue]>;
}

/**
 * 空のヘッダを作る
 */
export function createCoseHeader(): CoseHeader {
  return {
    algorithm: undefined,
    algorithmIdentifier: undefined,
    keyId: undefined,
    typ: undefined,
    contentType: undefined,
    critical: [],
    raw: [],
  };
}

/**
 * ヘッダのバケット (RFC 9052 Section 3)
 */
type HeaderBucket = "protected" | "unprotected";

/**
 * 理解できるヘッダパラメータのラベルかどうかを返す
 *
 * `crit` のラベル検証 (RFC 9052 Section 3.1) に使う。
 */
function isUnderstoodHeaderLabel(label: CborValue): boolean {
  const value = cborAsInteger(label);
  return (
    value === HEADER_ALGORITHM ||
    value === HEADER_CRITICAL ||
    value === HEADER_CONTENT_TYPE ||
    value === HEADER_KEY_ID ||
    value === HEADER_TYPE
  );
}

/**
 * protected ヘッダのマップからデコードする
 *
 * `crit` の各ラベルが同じ protected ヘッダに存在し、かつ理解できることを検証する
 * (RFC 9052 Section 3.1 は「protected ヘッダに無いラベルを `crit` が指す場合は
 * 致命的エラー」と定める)。解釈できない `alg` もエラーにする。
 *
 * @param value - protected ヘッダの CBOR データ項目
 */
export function decodeProtectedHeader(value: CborValue): CoseHeader {
  const entries = cborAsMap(value);
  if (entries === undefined) {
    throw new CoseError("unexpectedType", "header map");
  }
  return decodeHeaderEntries(entries, "protected");
}

/**
 * unprotected ヘッダのマップからデコードする
 *
 * RFC 9052 Section 3.1 は `crit` を protected ヘッダに置くことを MUST、RFC 9596
 * Section 2 は `typ` (ラベル 16) を unprotected ヘッダに置かないことを MUST と
 * するため、どちらもエラーにする。
 *
 * @param value - unprotected ヘッダの CBOR データ項目
 */
export function decodeUnprotectedHeader(value: CborValue): CoseHeader {
  const entries = cborAsMap(value);
  if (entries === undefined) {
    throw new CoseError("unexpectedType", "unprotected header map");
  }
  return decodeHeaderEntries(entries, "unprotected");
}

/**
 * ヘッダのエントリーをデコードする
 */
function decodeHeaderEntries(
  entries: Array<[CborValue, CborValue]>,
  bucket: HeaderBucket,
): CoseHeader {
  const header = createCoseHeader();
  for (const [key, entry] of entries) {
    const label = cborAsInteger(key);
    if (label === HEADER_ALGORITHM) {
      const identifier = cborAsInteger(entry);
      if (identifier === undefined) {
        throw new CoseError("unexpectedType", "alg");
      }
      const algorithm = algorithmFromIdentifierWithC4mDraftAlias(identifier);
      if (algorithm === undefined) {
        throw new CoseError("unsupportedAlgorithm", identifier);
      }
      header.algorithm = algorithm;
      header.algorithmIdentifier = Number(identifier);
      continue;
    }
    if (label === HEADER_CRITICAL) {
      if (bucket === "unprotected") {
        throw new CoseError("unprotectedCriticalHeader");
      }
      const labels = cborAsArray(entry);
      if (labels === undefined) {
        throw new CoseError("unexpectedType", "crit");
      }
      if (labels.length === 0) {
        throw new CoseError("emptyCriticalHeader");
      }
      header.critical = [...labels];
      continue;
    }
    if (label === HEADER_KEY_ID) {
      if (entry.type === "byteString") {
        header.keyId = coseKeyIdBytes(entry.value);
      } else if (entry.type === "textString") {
        header.keyId = coseKeyIdText(entry.value);
      } else {
        throw new CoseError("unexpectedType", "kid");
      }
      continue;
    }
    if (label === HEADER_TYPE) {
      if (bucket === "unprotected") {
        throw new CoseError("unprotectedTypeHeader");
      }
      header.typ = entry;
      continue;
    }
    if (label === HEADER_CONTENT_TYPE) {
      header.contentType = entry;
      continue;
    }
    header.raw.push([key, entry]);
  }
  // `crit` のラベルは protected ヘッダに実在し、理解できる必要がある
  for (const label of header.critical) {
    if (!isUnderstoodHeaderLabel(label)) {
      // counter signature (ラベル 7) は RFC 9052 Section 3.1 が新実装の理解を求めるが、
      // 本実装は検証しないため fail-closed として拒否する
      throw new CoseError("unsupportedCriticalHeader");
    }
    if (!entries.some(([key]) => cborEquals(key, label))) {
      throw new CoseError("criticalHeaderNotPresent");
    }
  }
  return header;
}

/**
 * ヘッダを CBOR のマップへエンコードする
 */
export function encodeCoseHeader(header: CoseHeader): CborValue {
  const entries: Array<[CborValue, CborValue]> = [];
  if (header.algorithm !== undefined) {
    entries.push([
      cborInteger(HEADER_ALGORITHM),
      cborInteger(header.algorithmIdentifier ?? algorithmIdentifier(header.algorithm)),
    ]);
  }
  if (header.keyId !== undefined) {
    const value =
      header.keyId.type === "bytes"
        ? cborByteString(header.keyId.value)
        : cborTextString(header.keyId.value);
    entries.push([cborInteger(HEADER_KEY_ID), value]);
  }
  if (header.typ !== undefined) {
    entries.push([cborInteger(HEADER_TYPE), header.typ]);
  }
  if (header.contentType !== undefined) {
    entries.push([cborInteger(HEADER_CONTENT_TYPE), header.contentType]);
  }
  entries.push(...header.raw.map((entry): [CborValue, CborValue] => [entry[0], entry[1]]));
  if (header.critical.length > 0) {
    // デコード側と同じ規則: crit のラベルは理解でき、保護されるマップに実在
    // すること (RFC 9052 Section 3.1)
    for (const label of header.critical) {
      if (!isUnderstoodHeaderLabel(label)) {
        throw new CoseError("unsupportedCriticalHeader");
      }
      // crit 自身 (ラベル 2) はこの直後に追加される
      if (
        cborAsInteger(label) !== HEADER_CRITICAL &&
        !entries.some(([key]) => cborEquals(key, label))
      ) {
        throw new CoseError("criticalHeaderNotPresent");
      }
    }
    entries.push([cborInteger(HEADER_CRITICAL), cborArray([...header.critical])]);
  }
  return cborMap(entries);
}

/**
 * COSE_Sign1 (RFC 9052 Section 4.2)
 */
export interface CoseSign1 {
  /** protected ヘッダの CBOR バイト列 (bstr の中身) */
  protected: Uint8Array;
  /** unprotected ヘッダのマップ */
  unprotected: Array<[CborValue, CborValue]>;
  /** ペイロード。undefined は detached payload を表す */
  payload: Uint8Array | undefined;
  /** 署名 */
  signature: Uint8Array;
  /** COSE タグ (18) が付いていたか */
  coseTagged: boolean;
  /** CWT タグ (61) が付いていたか */
  cwtTagged: boolean;
}

/**
 * COSE_Mac0 (RFC 9052 Section 6.2)
 */
export interface CoseMac0 {
  /** protected ヘッダの CBOR バイト列 (bstr の中身) */
  protected: Uint8Array;
  /** unprotected ヘッダのマップ */
  unprotected: Array<[CborValue, CborValue]>;
  /** ペイロード。undefined は detached payload を表す */
  payload: Uint8Array | undefined;
  /** MAC */
  tag: Uint8Array;
  /** COSE タグ (17) が付いていたか */
  coseTagged: boolean;
  /** CWT タグ (61) が付いていたか */
  cwtTagged: boolean;
}

/**
 * COSE のメッセージ (COSE_Sign1 / COSE_Mac0)
 */
export type CoseMessage =
  | { readonly type: "sign1"; readonly sign1: CoseSign1 }
  | { readonly type: "mac0"; readonly mac0: CoseMac0 };

/**
 * COSE の構造のエンコード / デコードエラー
 */
export type CoseErrorCode =
  | "cbor"
  | "unexpectedType"
  | "invalidStructure"
  | "missingAlgorithm"
  | "unsupportedAlgorithm"
  | "unsupportedCriticalHeader"
  | "criticalHeaderNotPresent"
  | "emptyCriticalHeader"
  | "unprotectedCriticalHeader"
  | "unprotectedTypeHeader"
  | "unprotectedAlgorithm"
  | "duplicateHeaderParameter"
  | "algorithmClassMismatch"
  | "detachedPayloadUnsupported";

export class CoseError extends Error {
  readonly code: CoseErrorCode;
  readonly detail: string | number | bigint | undefined;

  constructor(code: CoseErrorCode, detail?: string | number | bigint, options?: ErrorOptions) {
    super(buildCoseErrorMessage(code, detail, options?.cause), options);
    this.name = "CoseError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * エラーコードから英語のメッセージを組み立てる
 */
function buildCoseErrorMessage(
  code: CoseErrorCode,
  detail: string | number | bigint | undefined,
  cause: unknown,
): string {
  switch (code) {
    case "cbor":
      return `CBOR error: ${cause instanceof Error ? cause.message : String(cause)}`;
    case "unexpectedType":
      return `expected ${String(detail)}`;
    case "invalidStructure":
      return `invalid COSE structure: ${String(detail)}`;
    case "missingAlgorithm":
      return "COSE header has no alg parameter";
    case "unsupportedAlgorithm":
      return `unsupported COSE algorithm: ${String(detail)}`;
    case "unsupportedCriticalHeader":
      return "crit lists a header parameter that is not understood (RFC 9052 Section 3.1)";
    case "criticalHeaderNotPresent":
      return "crit lists a header parameter that is not in the protected header";
    case "emptyCriticalHeader":
      return "crit array must not be empty";
    case "unprotectedCriticalHeader":
      return "crit must be in the protected header (RFC 9052 Section 3.1)";
    case "unprotectedTypeHeader":
      return "typ must not be in the unprotected header (RFC 9596 Section 2)";
    case "unprotectedAlgorithm":
      return "alg must be in the protected header (RFC 9052 Section 3.1)";
    case "duplicateHeaderParameter":
      return `header parameter ${String(detail)} is present in both buckets`;
    case "algorithmClassMismatch":
      return "COSE tag and algorithm class do not match";
    case "detachedPayloadUnsupported":
      return "detached payload is not supported";
    default:
      return unreachableValue(code);
  }
}

/**
 * COSE メッセージのエンコードオプション
 */
export interface CoseEncodingOptions {
  /** COSE タグ (17 / 18) を付与する */
  coseTag: boolean;
  /** CWT タグ (61) を付与する */
  cwtTag: boolean;
}

/**
 * CWT タグと COSE タグの両方を付与する既定のオプション
 */
export const DEFAULT_COSE_ENCODING_OPTIONS: CoseEncodingOptions = {
  coseTag: true,
  cwtTag: true,
};

/**
 * CBOR のバイト列から COSE メッセージをデコードする
 *
 * CWT タグ (61) と COSE タグ (17 / 18) を許容する。タグが無い場合は protected
 * ヘッダのアルゴリズム種別から COSE_Sign1 / COSE_Mac0 を判別する。
 *
 * @param bytes - デコードする CBOR バイト列
 */
export function decodeCoseMessage(bytes: Uint8Array): CoseMessage {
  return decodeCoseMessageValue(decodeCborAsCoseError(bytes));
}

/**
 * CBOR のデータ項目から COSE メッセージをデコードする
 *
 * @param value - デコードする CBOR データ項目
 */
export function decodeCoseMessageValue(value: CborValue): CoseMessage {
  let current = value;
  if (current.type === "tag" && current.tag === TAG_CWT) {
    // RFC 8392 Section 6: CWT タグは COSE のタグ付きオブジェクトにだけ前置できる
    const inner = current.value;
    if (!(inner.type === "tag" && (inner.tag === TAG_COSE_SIGN1 || inner.tag === TAG_COSE_MAC0))) {
      throw new CoseError(
        "invalidStructure",
        "CWT tag must prefix a COSE tagged message (RFC 8392 Section 6)",
      );
    }
    current = inner;
  }
  if (current.type === "tag" && current.tag === TAG_COSE_SIGN1) {
    const parts = decodeCoseArray(current.value);
    const header = coseArrayHeader(parts);
    if (header.algorithm !== undefined && algorithmIsMac(header.algorithm)) {
      throw new CoseError("algorithmClassMismatch");
    }
    return { type: "sign1", sign1: toCoseSign1(parts, true, value) };
  }
  if (current.type === "tag" && current.tag === TAG_COSE_MAC0) {
    const parts = decodeCoseArray(current.value);
    const header = coseArrayHeader(parts);
    if (header.algorithm !== undefined && !algorithmIsMac(header.algorithm)) {
      throw new CoseError("algorithmClassMismatch");
    }
    return { type: "mac0", mac0: toCoseMac0(parts, true, value) };
  }
  if (current.type === "array") {
    const parts = decodeCoseArray(current);
    const header = coseArrayHeader(parts);
    const algorithm = header.algorithm;
    if (algorithm === undefined) {
      throw new CoseError("missingAlgorithm");
    }
    if (algorithmIsMac(algorithm)) {
      return { type: "mac0", mac0: toCoseMac0(parts, false, value) };
    }
    return { type: "sign1", sign1: toCoseSign1(parts, false, value) };
  }
  throw new CoseError("unexpectedType", "COSE message");
}

/**
 * CWT タグが付いていたかどうかを、元のデータ項目のタグ構造から判定する
 */
function hasTag(value: CborValue, expected: bigint): boolean {
  if (value.type !== "tag") {
    return false;
  }
  if (value.tag === expected) {
    return true;
  }
  // CWT タグが付いている場合は内側の COSE タグを調べる
  return value.tag === TAG_CWT && hasTag(value.value, expected);
}

/**
 * protected / unprotected を統合したヘッダを返す
 *
 * protected ヘッダが空の場合は unprotected だけを返す。`alg` は protected に必須で、
 * 同じラベルが両方のバケットにある場合は `duplicateHeaderParameter` で拒否する
 * (RFC 9052 Section 3 は「同じラベルが両方に現れないことを検証すること」を SHOULD
 * とし、拒否しない場合は protected を優先する MUST を定める)。
 */
export function coseMessageHeader(message: CoseMessage): CoseHeader {
  const protectedBytes =
    message.type === "sign1" ? message.sign1.protected : message.mac0.protected;
  const unprotected =
    message.type === "sign1" ? message.sign1.unprotected : message.mac0.unprotected;
  return decodeMergedHeader(protectedBytes, unprotected);
}

/**
 * ペイロードを返す
 */
export function coseMessagePayload(message: CoseMessage): Uint8Array | undefined {
  return message.type === "sign1" ? message.sign1.payload : message.mac0.payload;
}

/**
 * 署名または MAC を返す
 */
export function coseMessageSignature(message: CoseMessage): Uint8Array {
  return message.type === "sign1" ? message.sign1.signature : message.mac0.tag;
}

/**
 * 署名 / MAC の対象バイト列を組み立てる
 *
 * COSE_Sign1 は `Sig_structure`、COSE_Mac0 は `MAC_structure` を返す
 * (RFC 9052 Section 4.4 / Section 6.3)。external_aad は空のバイト文字列とする。
 * detached payload は扱わないためエラーを返す。
 */
export function coseMessageSigningInput(message: CoseMessage): Uint8Array {
  const protectedBytes =
    message.type === "sign1" ? message.sign1.protected : message.mac0.protected;
  const payload =
    (message.type === "sign1" ? message.sign1.payload : message.mac0.payload) ?? undefined;
  if (payload === undefined) {
    throw new CoseError("detachedPayloadUnsupported");
  }
  const context =
    message.type === "sign1" ? algorithmClassContext("signature") : algorithmClassContext("mac");
  return encodeCbor(
    cborArray([
      cborTextString(context),
      cborByteString(protectedBytes),
      cborByteString(new Uint8Array(0)),
      cborByteString(payload),
    ]),
  );
}

/**
 * COSE メッセージをエンコードする
 *
 * タグの付与は「メッセージがデコード時に持っていたタグ」と `options` の OR で決まる。
 * 例えばタグ無しでデコードしたメッセージに既定のオプションを渡すと CWT タグ (61) と
 * COSE タグ (17 / 18) が付与される。CWT タグを付ける場合は COSE タグも必要になる
 * (RFC 8392 Section 6)。
 */
export function encodeCoseMessage(
  message: CoseMessage,
  options: CoseEncodingOptions = DEFAULT_COSE_ENCODING_OPTIONS,
): Uint8Array {
  const tagged =
    (message.type === "sign1" ? message.sign1.coseTagged : message.mac0.coseTagged) ||
    options.coseTag;
  const cwt =
    (message.type === "sign1" ? message.sign1.cwtTagged : message.mac0.cwtTagged) || options.cwtTag;
  // RFC 8392 Section 6: CWT タグは COSE のタグ付きオブジェクトにだけ前置できる
  if (cwt && !tagged) {
    throw new CoseError("invalidStructure", "CWT tag requires the COSE tag (RFC 8392 Section 6)");
  }
  let value: CborValue =
    message.type === "sign1" ? coseArrayValue(message.sign1) : coseArrayValue(message.mac0);
  if (tagged) {
    const tag = message.type === "sign1" ? TAG_COSE_SIGN1 : TAG_COSE_MAC0;
    value = cborTag(tag, value);
  }
  if (cwt) {
    value = cborTag(TAG_CWT, value);
  }
  return encodeCbor(value);
}

/**
 * CBOR のバイト列をデコードし、失敗を COSE のエラーとして返す
 */
function decodeCborAsCoseError(bytes: Uint8Array): CborValue {
  try {
    return decodeCbor(bytes);
  } catch (error) {
    if (error instanceof CborError) {
      throw new CoseError("cbor", undefined, { cause: error });
    }
    throw error;
  }
}

/**
 * protected ヘッダと unprotected ヘッダを統合してデコードする
 */
function decodeMergedHeader(
  protectedBytes: Uint8Array,
  unprotected: Array<[CborValue, CborValue]>,
): CoseHeader {
  let protectedValue: CborValue | undefined;
  if (protectedBytes.length > 0) {
    protectedValue = decodeCborAsCoseError(protectedBytes);
  }
  const header =
    protectedValue !== undefined ? decodeProtectedHeader(protectedValue) : createCoseHeader();
  const protectedEntries = protectedValue !== undefined ? (cborAsMap(protectedValue) ?? []) : [];
  for (const [key] of unprotected) {
    if (protectedEntries.some(([protectedKey]) => cborEquals(protectedKey, key))) {
      const label = cborAsInteger(key);
      if (label !== undefined) {
        throw new CoseError("duplicateHeaderParameter", label);
      }
      throw new CoseError(
        "invalidStructure",
        "the same header parameter label is present in both buckets",
      );
    }
  }
  const unprotectedHeader = decodeUnprotectedHeader(cborMap(unprotected));
  // `alg` は protected ヘッダで認証されなければならない (RFC 9052 Section 3.1)
  if (unprotectedHeader.algorithm !== undefined) {
    throw new CoseError("unprotectedAlgorithm");
  }
  header.keyId ??= unprotectedHeader.keyId;
  header.contentType ??= unprotectedHeader.contentType;
  header.raw.push(...unprotectedHeader.raw);
  return header;
}

/**
 * COSE_Sign1 / COSE_Mac0 の共通の配列構造
 *
 * RFC 9052 Section 4.2 / Section 6.2 の `[protected, unprotected, payload, signature]`
 * を表す。
 */
interface CoseArray {
  protected: Uint8Array;
  unprotected: Array<[CborValue, CborValue]>;
  payload: Uint8Array | undefined;
  signature: Uint8Array;
}

/**
 * COSE の配列をデコードする
 */
function decodeCoseArray(value: CborValue): CoseArray {
  const items = cborAsArray(value);
  if (items === undefined) {
    throw new CoseError("unexpectedType", "COSE array");
  }
  if (items.length !== 4) {
    throw new CoseError("invalidStructure", "COSE array must have 4 elements");
  }
  const protectedBytes = cborAsBytes(items[0] ?? CBOR_NULL);
  if (protectedBytes === undefined) {
    throw new CoseError("unexpectedType", "protected header");
  }
  const unprotected = cborAsMap(items[1] ?? CBOR_NULL);
  if (unprotected === undefined) {
    throw new CoseError("unexpectedType", "unprotected header");
  }
  const payloadItem = items[2] ?? CBOR_NULL;
  let payload: Uint8Array | undefined;
  if (payloadItem.type === "byteString") {
    payload = payloadItem.value;
  } else if (payloadItem.type !== "null") {
    throw new CoseError("unexpectedType", "payload");
  }
  const signature = cborAsBytes(items[3] ?? CBOR_NULL);
  if (signature === undefined) {
    throw new CoseError("unexpectedType", "signature");
  }
  return {
    protected: protectedBytes,
    unprotected: [...unprotected],
    payload,
    signature,
  };
}

/**
 * 配列構造から統合ヘッダをデコードする
 */
function coseArrayHeader(parts: CoseArray): CoseHeader {
  return decodeMergedHeader(parts.protected, parts.unprotected);
}

/**
 * 配列構造を COSE_Sign1 へ変換する
 */
function toCoseSign1(parts: CoseArray, coseTagged: boolean, value: CborValue): CoseSign1 {
  return {
    protected: parts.protected,
    unprotected: parts.unprotected,
    payload: parts.payload,
    signature: parts.signature,
    coseTagged: coseTagged || hasTag(value, TAG_COSE_SIGN1),
    cwtTagged: hasTag(value, TAG_CWT),
  };
}

/**
 * 配列構造を COSE_Mac0 へ変換する
 */
function toCoseMac0(parts: CoseArray, coseTagged: boolean, value: CborValue): CoseMac0 {
  return {
    protected: parts.protected,
    unprotected: parts.unprotected,
    payload: parts.payload,
    tag: parts.signature,
    coseTagged: coseTagged || hasTag(value, TAG_COSE_MAC0),
    cwtTagged: hasTag(value, TAG_CWT),
  };
}

/**
 * COSE_Sign1 / COSE_Mac0 の共通部分から配列のデータ項目を組み立てる
 */
function coseArrayValue(
  message:
    | {
        protected: Uint8Array;
        unprotected: Array<[CborValue, CborValue]>;
        payload: Uint8Array | undefined;
        signature: Uint8Array;
      }
    | {
        protected: Uint8Array;
        unprotected: Array<[CborValue, CborValue]>;
        payload: Uint8Array | undefined;
        tag: Uint8Array;
      },
): CborValue {
  const signature = "signature" in message ? message.signature : message.tag;
  return cborArray([
    cborByteString(message.protected),
    cborMap([...message.unprotected]),
    message.payload !== undefined ? cborByteString(message.payload) : CBOR_NULL,
    cborByteString(signature),
  ]);
}

const TEXT_ENCODER = new TextEncoder();
