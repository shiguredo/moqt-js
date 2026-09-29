/**
 * COSE / JWT の署名と検証を抽象化する型
 *
 * このモジュールは鍵表現とインターフェース、エラーだけを提供し、暗号実装を
 * 一切持たない。実装は `./webcrypto.ts` の `WebCrypto` (Web Crypto API) を
 * 参照する。
 *
 * Sans-I/O の方針に合わせて、このモジュールは乱数も時計も持たない。署名に必要な
 * 乱数は実装側 (Web Crypto API) が内部で取得する。
 */

import type { Algorithm } from "./cose";
import { unreachableValue } from "./unreachable";

/**
 * 楕円曲線 (RFC 9053 Section 7 の COSE Elliptic Curves)
 */
export type EcCurve = "P256" | "P384" | "P521";

/**
 * 座標と秘密鍵のバイト長を返す
 */
export function ecCurveCoordinateLength(curve: EcCurve): number {
  switch (curve) {
    case "P256":
      return 32;
    case "P384":
      return 48;
    case "P521":
      return 66;
    default:
      return unreachableValue(curve);
  }
}

/**
 * COSE の `crv` 値 (RFC 9053 Section 7) を返す
 */
export function ecCurveIdentifier(curve: EcCurve): number {
  switch (curve) {
    case "P256":
      return 1;
    case "P384":
      return 2;
    case "P521":
      return 3;
    default:
      return unreachableValue(curve);
  }
}

/**
 * OKP (Octet Key Pair) の曲線 (RFC 9053 Section 7)
 */
export type OkpCurve = "Ed25519";

/**
 * COSE の `crv` 値 (RFC 9053 Section 7) を返す
 */
export function okpCurveIdentifier(curve: OkpCurve): number {
  switch (curve) {
    case "Ed25519":
      return 6;
    default:
      return unreachableValue(curve);
  }
}

/**
 * COSE Key (RFC 9052 Section 7) を表す鍵
 *
 * 秘密鍵は署名にだけ使い、検証では公開鍵の部分だけを参照する。
 */
export type CoseKey =
  | { readonly type: "symmetric"; readonly key: Uint8Array }
  | {
      readonly type: "ec2";
      readonly curve: EcCurve;
      readonly x: Uint8Array;
      readonly y: Uint8Array;
      readonly privateKey: Uint8Array | undefined;
    }
  | {
      readonly type: "okp";
      readonly curve: OkpCurve;
      readonly publicKey: Uint8Array;
      readonly privateKey: Uint8Array | undefined;
    };

/**
 * 対称鍵を作る
 */
export function symmetricKey(key: Uint8Array): CoseKey {
  return { type: "symmetric", key };
}

/**
 * 公開鍵だけの EC2 鍵を作る
 */
export function ec2Key(curve: EcCurve, x: Uint8Array, y: Uint8Array): CoseKey {
  return { type: "ec2", curve, x, y, privateKey: undefined };
}

/**
 * 秘密鍵付きの EC2 鍵を作る
 */
export function ec2KeyWithPrivateKey(
  curve: EcCurve,
  x: Uint8Array,
  y: Uint8Array,
  privateKey: Uint8Array,
): CoseKey {
  return { type: "ec2", curve, x, y, privateKey };
}

/**
 * 公開鍵だけの Ed25519 鍵を作る
 */
export function ed25519Key(publicKey: Uint8Array): CoseKey {
  return { type: "okp", curve: "Ed25519", publicKey, privateKey: undefined };
}

/**
 * 秘密鍵付きの Ed25519 鍵を作る
 *
 * `privateKey` は RFC 8032 の seed (32 バイト) を表す。
 */
export function ed25519KeyWithPrivateKey(publicKey: Uint8Array, privateKey: Uint8Array): CoseKey {
  return { type: "okp", curve: "Ed25519", publicKey, privateKey };
}

/**
 * ハッシュアルゴリズム
 *
 * 署名以外でハッシュが必要な処理 (JWK サムプリントなど) に使う。
 */
export type DigestAlgorithm = "Sha256" | "Sha384" | "Sha512";

/**
 * COSE / JWT の署名と検証を行うインターフェース
 *
 * 実装は Web Crypto API を使う `WebCrypto` を参照。すべて非同期である
 * (Web Crypto API が Promise を返すため)。
 */
export interface CoseCrypto {
  /**
   * メッセージに署名する
   *
   * 対称鍵の場合は MAC を返す。EC2 / OKP の場合は固定長形式 (COSE の署名形式)
   * の署名を返す。
   */
  sign(algorithm: Algorithm, key: CoseKey, message: Uint8Array): Promise<Uint8Array>;

  /**
   * 署名または MAC を検証する
   *
   * 検証に失敗した場合は `signatureVerificationFailed` を投げる。
   */
  verify(
    algorithm: Algorithm,
    key: CoseKey,
    message: Uint8Array,
    signature: Uint8Array,
  ): Promise<void>;

  /**
   * メッセージのハッシュを計算する
   */
  digest(algorithm: DigestAlgorithm, message: Uint8Array): Promise<Uint8Array>;
}

/**
 * 鍵の種別から既定の署名アルゴリズムを返す
 *
 * 対称鍵は HMAC-SHA256、EC2 は曲線に対応する ES256 / ES384 / ES512、OKP は
 * EdDSA を返す。
 */
export function defaultSigningAlgorithm(key: CoseKey): Algorithm {
  switch (key.type) {
    case "symmetric":
      return "HmacSha256";
    case "ec2": {
      const curve = key.curve;
      switch (curve) {
        case "P256":
          return "Es256";
        case "P384":
          return "Es384";
        case "P521":
          return "Es512";
        default:
          return unreachableValue(curve);
      }
    }
    case "okp":
      return "EdDsa";
    default:
      return unreachableValue(key);
  }
}

/**
 * 署名 / 検証のエラー
 */
export type CryptoErrorCode =
  | "unsupportedKey"
  | "missingPrivateKey"
  | "invalidKey"
  | "signatureVerificationFailed"
  | "signingFailed"
  | "invalidSignatureLength";

export class CryptoError extends Error {
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode, options?: ErrorOptions) {
    super(buildCryptoErrorMessage(code, options?.cause), options);
    this.name = "CryptoError";
    this.code = code;
  }
}

/**
 * エラーコードから英語のメッセージを組み立てる
 */
function buildCryptoErrorMessage(code: CryptoErrorCode, cause: unknown): string {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  switch (code) {
    case "unsupportedKey":
      return `key type does not match the algorithm${detail}`;
    case "missingPrivateKey":
      return "private key is required for signing";
    case "invalidKey":
      return `invalid key${detail}`;
    case "signatureVerificationFailed":
      return "signature verification failed";
    case "signingFailed":
      return `signing failed${detail}`;
    case "invalidSignatureLength":
      return "invalid signature length";
    default:
      return unreachableValue(code);
  }
}
