/**
 * Web Crypto API を使う署名 / 検証の実装
 *
 * ブラウザ標準の `crypto.subtle` (Web Crypto API) だけを使い、外部の暗号
 * ライブラリには依存しない。COSE の署名形式 (ECDSA は r || s の固定長、Ed25519 は
 * 64 バイト) は Web Crypto API の形式と一致するため変換は不要である。
 *
 * 署名鍵は JWK / raw のどちらかで import する。鍵の形式・長さの検証は
 * Web Crypto API の import に加えて、この実装でも行う。
 */

import { encodeBase64Url } from "./base64url";
import type { Algorithm } from "./cose";
import { unreachableValue } from "./unreachable";
import {
  type CoseCrypto,
  type CoseKey,
  CryptoError,
  type DigestAlgorithm,
  type EcCurve,
  ecCurveCoordinateLength,
} from "./crypto";

/**
 * Web Crypto API を使う `CoseCrypto` 実装
 */
export class WebCrypto implements CoseCrypto {
  /**
   * メッセージに署名する
   *
   * 対称鍵の場合は HMAC、EC2 / OKP の場合はデジタル署名を返す。
   */
  async sign(algorithm: Algorithm, key: CoseKey, message: Uint8Array): Promise<Uint8Array> {
    switch (algorithm) {
      case "HmacSha256":
      case "HmacSha384":
      case "HmacSha512":
        return hmacSign(algorithm, key, message);
      case "Es256":
      case "Es384":
      case "Es512":
        return ecdsaSign(algorithm, key, message);
      case "EdDsa":
        return ed25519Sign(key, message);
      default:
        return unreachableValue(algorithm);
    }
  }

  /**
   * 署名または MAC を検証する
   *
   * 失敗時は `signatureVerificationFailed` を投げる。
   */
  async verify(
    algorithm: Algorithm,
    key: CoseKey,
    message: Uint8Array,
    signature: Uint8Array,
  ): Promise<void> {
    switch (algorithm) {
      case "HmacSha256":
      case "HmacSha384":
      case "HmacSha512":
        return hmacVerify(algorithm, key, message, signature);
      case "Es256":
      case "Es384":
      case "Es512":
        return ecdsaVerify(algorithm, key, message, signature);
      case "EdDsa":
        return ed25519Verify(key, message, signature);
      default:
        return unreachableValue(algorithm);
    }
  }

  /**
   * メッセージのハッシュを計算する
   */
  async digest(algorithm: DigestAlgorithm, message: Uint8Array): Promise<Uint8Array> {
    const digest = await getSubtle().digest(
      digestAlgorithmName(algorithm),
      toWebCryptoBytes(message),
    );
    return new Uint8Array(digest);
  }
}

/**
 * Web Crypto API を取り出す
 *
 * モジュール読み込み時ではなく呼び出し時に参照する (SSR など `crypto` が無い
 * 環境でこのモジュールを読み込めるようにするため)。
 */
function getSubtle(): SubtleCrypto {
  return globalThis.crypto.subtle;
}

/**
 * Web Crypto API へ渡すバイト列を作る
 *
 * Web Crypto API の型は ArrayBuffer 裏付けのビューを要求する。Uint8Array は
 * SharedArrayBuffer を裏付けに持つこともあるため、内容をコピーして
 * ArrayBuffer 裏付けのビューにする。
 */
function toWebCryptoBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

/**
 * ハッシュアルゴリズムの Web Crypto API の名前を返す
 */
function digestAlgorithmName(algorithm: DigestAlgorithm): string {
  switch (algorithm) {
    case "Sha256":
      return "SHA-256";
    case "Sha384":
      return "SHA-384";
    case "Sha512":
      return "SHA-512";
    default:
      return unreachableValue(algorithm);
  }
}

/**
 * COSE のアルゴリズムに対応するハッシュアルゴリズムの名前を返す
 *
 * HMAC は鍵導出に、ECDSA は署名対象のハッシュに同じ対応を使う
 * (RFC 9053 Section 2 / Section 3)。
 */
function hashNameForAlgorithm(algorithm: Algorithm): string {
  switch (algorithm) {
    case "HmacSha256":
    case "Es256":
      return "SHA-256";
    case "HmacSha384":
    case "Es384":
      return "SHA-384";
    case "HmacSha512":
    case "Es512":
      return "SHA-512";
    case "EdDsa":
      // EdDSA は署名アルゴリズム内部でハッシュするため、この関数は使わない
      throw new CryptoError("unsupportedKey");
    default:
      return unreachableValue(algorithm);
  }
}

/**
 * COSE のアルゴリズムに対応する楕円曲線を返す
 */
function curveForAlgorithm(algorithm: Algorithm): EcCurve {
  switch (algorithm) {
    case "Es256":
      return "P256";
    case "Es384":
      return "P384";
    case "Es512":
      return "P521";
    default:
      throw new CryptoError("unsupportedKey");
  }
}

/**
 * 楕円曲線の Web Crypto API の名前を返す
 */
function curveName(curve: EcCurve): string {
  switch (curve) {
    case "P256":
      return "P-256";
    case "P384":
      return "P-384";
    case "P521":
      return "P-521";
    default:
      return unreachableValue(curve);
  }
}

/**
 * 対称鍵を取り出す
 */
function symmetricKeyValue(key: CoseKey): Uint8Array {
  if (key.type !== "symmetric") {
    throw new CryptoError("unsupportedKey");
  }
  if (key.key.length === 0) {
    throw new CryptoError("invalidKey");
  }
  return key.key;
}

/**
 * EC2 鍵の公開鍵部分を検証して取り出す
 */
function ec2PublicKeyValue(
  curve: EcCurve,
  key: CoseKey,
): { x: Uint8Array; y: Uint8Array; privateKey: Uint8Array | undefined } {
  if (key.type !== "ec2") {
    throw new CryptoError("unsupportedKey");
  }
  if (key.curve !== curve) {
    throw new CryptoError("unsupportedKey");
  }
  const length = ecCurveCoordinateLength(curve);
  if (key.x.length !== length || key.y.length !== length) {
    throw new CryptoError("invalidKey");
  }
  if (key.privateKey !== undefined && key.privateKey.length !== length) {
    throw new CryptoError("invalidKey");
  }
  return { x: key.x, y: key.y, privateKey: key.privateKey };
}

/**
 * HMAC の鍵を import する
 */
async function importHmacKey(
  algorithm: Algorithm,
  key: CoseKey,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const keyBytes = symmetricKeyValue(key);
  try {
    return await getSubtle().importKey(
      "raw",
      toWebCryptoBytes(keyBytes),
      { name: "HMAC", hash: hashNameForAlgorithm(algorithm) },
      false,
      usages,
    );
  } catch (error) {
    throw new CryptoError("invalidKey", { cause: error });
  }
}

/**
 * HMAC を計算して返す
 */
async function hmacSign(
  algorithm: Algorithm,
  key: CoseKey,
  message: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await importHmacKey(algorithm, key, ["sign"]);
  try {
    const signature = await getSubtle().sign("HMAC", cryptoKey, toWebCryptoBytes(message));
    return new Uint8Array(signature);
  } catch (error) {
    throw new CryptoError("signingFailed", { cause: error });
  }
}

/**
 * HMAC を検証する
 */
async function hmacVerify(
  algorithm: Algorithm,
  key: CoseKey,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<void> {
  const cryptoKey = await importHmacKey(algorithm, key, ["verify"]);
  let verified: boolean;
  try {
    verified = await getSubtle().verify(
      "HMAC",
      cryptoKey,
      toWebCryptoBytes(signature),
      toWebCryptoBytes(message),
    );
  } catch (error) {
    throw new CryptoError("signatureVerificationFailed", { cause: error });
  }
  if (!verified) {
    throw new CryptoError("signatureVerificationFailed");
  }
}

/**
 * EC2 の鍵を JWK として import する
 *
 * Web Crypto API の ECDSA は `r || s` の固定長署名を返すため、COSE の署名形式
 * (RFC 9052 Section 8.1) と一致する。
 */
async function importEc2Key(
  curve: EcCurve,
  x: Uint8Array,
  y: Uint8Array,
  privateKey: Uint8Array | undefined,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: curveName(curve),
    x: encodeBase64Url(x),
    y: encodeBase64Url(y),
    ext: true,
  };
  if (privateKey !== undefined) {
    jwk.d = encodeBase64Url(privateKey);
  }
  try {
    return await getSubtle().importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: curveName(curve) },
      false,
      usages,
    );
  } catch (error) {
    throw new CryptoError("invalidKey", { cause: error });
  }
}

/**
 * ECDSA で署名する
 */
async function ecdsaSign(
  algorithm: Algorithm,
  key: CoseKey,
  message: Uint8Array,
): Promise<Uint8Array> {
  const curve = curveForAlgorithm(algorithm);
  const { x, y, privateKey } = ec2PublicKeyValue(curve, key);
  if (privateKey === undefined) {
    throw new CryptoError("missingPrivateKey");
  }
  const cryptoKey = await importEc2Key(curve, x, y, privateKey, ["sign"]);
  try {
    const signature = await getSubtle().sign(
      { name: "ECDSA", hash: hashNameForAlgorithm(algorithm) },
      cryptoKey,
      toWebCryptoBytes(message),
    );
    return new Uint8Array(signature);
  } catch (error) {
    throw new CryptoError("signingFailed", { cause: error });
  }
}

/**
 * ECDSA の署名を検証する
 */
async function ecdsaVerify(
  algorithm: Algorithm,
  key: CoseKey,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<void> {
  const curve = curveForAlgorithm(algorithm);
  const { x, y } = ec2PublicKeyValue(curve, key);
  if (signature.length !== ecCurveCoordinateLength(curve) * 2) {
    throw new CryptoError("invalidSignatureLength");
  }
  const cryptoKey = await importEc2Key(curve, x, y, undefined, ["verify"]);
  let verified: boolean;
  try {
    verified = await getSubtle().verify(
      { name: "ECDSA", hash: hashNameForAlgorithm(algorithm) },
      cryptoKey,
      toWebCryptoBytes(signature),
      toWebCryptoBytes(message),
    );
  } catch (error) {
    throw new CryptoError("signatureVerificationFailed", { cause: error });
  }
  if (!verified) {
    throw new CryptoError("signatureVerificationFailed");
  }
}

/**
 * Ed25519 の鍵 (公開鍵と秘密鍵の種) を検証して取り出す
 */
function ed25519KeyValues(key: CoseKey): {
  publicKey: Uint8Array;
  privateKey: Uint8Array | undefined;
} {
  if (key.type !== "okp") {
    throw new CryptoError("unsupportedKey");
  }
  if (key.publicKey.length !== 32) {
    throw new CryptoError("invalidKey");
  }
  if (key.privateKey !== undefined && key.privateKey.length !== 32) {
    throw new CryptoError("invalidKey");
  }
  return { publicKey: key.publicKey, privateKey: key.privateKey };
}

/**
 * Ed25519 で署名する
 */
async function ed25519Sign(key: CoseKey, message: Uint8Array): Promise<Uint8Array> {
  const { publicKey, privateKey } = ed25519KeyValues(key);
  if (privateKey === undefined) {
    throw new CryptoError("missingPrivateKey");
  }
  // Web Crypto API は Ed25519 の秘密鍵を JWK (x と d) としてだけ受理する
  // (raw import は公開鍵用であり、秘密鍵を渡すと key usage が拒否される)
  const jwk: JsonWebKey = {
    kty: "OKP",
    crv: "Ed25519",
    x: encodeBase64Url(publicKey),
    d: encodeBase64Url(privateKey),
    ext: true,
  };
  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await getSubtle().importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  } catch (error) {
    throw new CryptoError("invalidKey", { cause: error });
  }
  try {
    const signature = await getSubtle().sign(
      { name: "Ed25519" },
      cryptoKey,
      toWebCryptoBytes(message),
    );
    return new Uint8Array(signature);
  } catch (error) {
    throw new CryptoError("signingFailed", { cause: error });
  }
}

/**
 * Ed25519 の署名を検証する
 */
async function ed25519Verify(
  key: CoseKey,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<void> {
  const { publicKey } = ed25519KeyValues(key);
  if (signature.length !== 64) {
    throw new CryptoError("invalidSignatureLength");
  }
  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await getSubtle().importKey(
      "raw",
      toWebCryptoBytes(publicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch (error) {
    throw new CryptoError("invalidKey", { cause: error });
  }
  let verified: boolean;
  try {
    verified = await getSubtle().verify(
      { name: "Ed25519" },
      cryptoKey,
      toWebCryptoBytes(signature),
      toWebCryptoBytes(message),
    );
  } catch (error) {
    throw new CryptoError("signatureVerificationFailed", { cause: error });
  }
  if (!verified) {
    throw new CryptoError("signatureVerificationFailed");
  }
}
