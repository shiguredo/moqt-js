/**
 * JWK (JSON Web Key, RFC 7517) と JWK サムプリント (RFC 7638)
 *
 * C4M の鍵は JWK で受け渡しされることが多い (issuer の鍵配布、`cnf` の
 * `jkt`)。署名 / 検証に使う鍵は `jwkToCoseKey` で `CoseKey` へ変換する。
 *
 * - EC (`kty` = "EC") / OKP (`kty` = "OKP") / oct (`kty` = "oct") を扱う
 * - RSA は `CoseKey` に表現が無いため扱わない
 * - 秘密鍵のメンバー (`d` / `k`) は保持する。DPoP proof のように公開鍵だけを
 *   受け取る用途では、呼び出し側が `d` の有無を確認する
 * - メンバー名が重複した JSON は `JSON.parse` が字句的に最後のメンバーを返す。
 *   RFC 7517 Section 4 は重複したメンバー名を拒否するか、最後の重複だけを使う
 *   ことを求めているため、`JSON.parse` の挙動をそのまま使う
 */

import { Base64DecodeError, decodeBase64Url, encodeBase64Url } from "./base64url";
import {
  type CoseCrypto,
  type CoseKey,
  type EcCurve,
  ec2Key,
  ec2KeyWithPrivateKey,
  ed25519Key,
  ed25519KeyWithPrivateKey,
  symmetricKey,
} from "./crypto";
import { unreachableValue } from "./unreachable";

/**
 * JWK (RFC 7517 Section 4)
 *
 * `x` / `y` / `d` / `k` は base64url (パディング無し) の文字列として保持する。
 */
export type Jwk =
  | {
      readonly kty: "EC";
      /** 曲線名 (`crv`)。"P-256" / "P-384" / "P-521" */
      readonly crv: string;
      readonly x: string;
      readonly y: string;
      /** 秘密鍵 (スカラー)。公開鍵だけの場合は undefined */
      readonly d: string | undefined;
    }
  | {
      readonly kty: "OKP";
      /** 曲線名 (`crv`)。"Ed25519" */
      readonly crv: string;
      readonly x: string;
      /** 秘密鍵 (種)。公開鍵だけの場合は undefined */
      readonly d: string | undefined;
    }
  | {
      readonly kty: "oct";
      /** 対称鍵の値 */
      readonly k: string;
    };

/**
 * JWK の操作エラー
 */
export type JwkErrorCode =
  | "invalidJson"
  | "unexpectedType"
  | "unsupportedKeyType"
  | "unsupportedCurve"
  | "invalidBase64";

export class JwkError extends Error {
  readonly code: JwkErrorCode;
  readonly detail: string | undefined;

  constructor(code: JwkErrorCode, detail?: string) {
    super(buildJwkErrorMessage(code, detail));
    this.name = "JwkError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * エラーコードから英語のメッセージを組み立てる
 */
function buildJwkErrorMessage(code: JwkErrorCode, detail: string | undefined): string {
  switch (code) {
    case "invalidJson":
      return `invalid JWK JSON: ${String(detail)}`;
    case "unexpectedType":
      return `expected ${String(detail)}`;
    case "unsupportedKeyType":
      return `unsupported JWK key type: ${String(detail)}`;
    case "unsupportedCurve":
      return `unsupported JWK curve: ${String(detail)}`;
    case "invalidBase64":
      return `invalid base64url in JWK: ${String(detail)}`;
    default:
      return unreachableValue(code);
  }
}

/**
 * JSON オブジェクトかどうかを判定する
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 必須の文字列メンバーを取り出す
 */
function requiredString(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== "string") {
    throw new JwkError("unexpectedType", name);
  }
  return value;
}

/**
 * 任意の文字列メンバーを取り出す
 */
function optionalString(record: Record<string, unknown>, name: string): string | undefined {
  const value = record[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new JwkError("unexpectedType", name);
  }
  return value;
}

/**
 * JWK の JSON をデコードする
 *
 * @param text - JWK の JSON 文字列
 */
export function decodeJwk(text: string): Jwk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new JwkError("invalidJson", error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(parsed)) {
    throw new JwkError("unexpectedType", "JWK object");
  }
  const kty = requiredString(parsed, "kty");
  if (kty === "EC") {
    return {
      kty: "EC",
      crv: requiredString(parsed, "crv"),
      x: requiredString(parsed, "x"),
      y: requiredString(parsed, "y"),
      d: optionalString(parsed, "d"),
    };
  }
  if (kty === "OKP") {
    return {
      kty: "OKP",
      crv: requiredString(parsed, "crv"),
      x: requiredString(parsed, "x"),
      d: optionalString(parsed, "d"),
    };
  }
  if (kty === "oct") {
    return { kty: "oct", k: requiredString(parsed, "k") };
  }
  throw new JwkError("unsupportedKeyType", kty);
}

/**
 * JWK を JSON 文字列へエンコードする
 *
 * `kty` を先頭にした読みやすい順序で出力する。正規化が必要な用途
 * (サムプリント) では `canonicalJwkJson` を使う。
 */
export function encodeJwk(jwk: Jwk): string {
  switch (jwk.kty) {
    case "EC": {
      const members: Record<string, string> = { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y };
      if (jwk.d !== undefined) {
        members["d"] = jwk.d;
      }
      return JSON.stringify(members);
    }
    case "OKP": {
      const members: Record<string, string> = { kty: "OKP", crv: jwk.crv, x: jwk.x };
      if (jwk.d !== undefined) {
        members["d"] = jwk.d;
      }
      return JSON.stringify(members);
    }
    case "oct":
      return JSON.stringify({ kty: "oct", k: jwk.k });
    default:
      return unreachableValue(jwk);
  }
}

/**
 * base64url をパディング無しに正規化する
 */
function normalizeBase64Url(value: string): string {
  try {
    return encodeBase64Url(decodeBase64Url(value));
  } catch (error) {
    if (error instanceof Base64DecodeError) {
      throw new JwkError("invalidBase64", error.message);
    }
    throw error;
  }
}

/**
 * RFC 7638 Section 3.2 の正規化 JSON を返す
 *
 * 必須メンバーを辞書順に並べ、空白を入れない。base64url の値はパディング無しに
 * 正規化し、秘密鍵のメンバーは含めない。
 */
export function canonicalJwkJson(jwk: Jwk): string {
  switch (jwk.kty) {
    case "EC": {
      // 辞書順 (crv, kty, x, y) に並べる。JS のオブジェクトは挿入順を保つ
      const members: Record<string, string> = {
        crv: jwk.crv,
        kty: "EC",
        x: normalizeBase64Url(jwk.x),
        y: normalizeBase64Url(jwk.y),
      };
      return JSON.stringify(members);
    }
    case "OKP": {
      const members: Record<string, string> = {
        crv: jwk.crv,
        kty: "OKP",
        x: normalizeBase64Url(jwk.x),
      };
      return JSON.stringify(members);
    }
    case "oct": {
      const members: Record<string, string> = { k: normalizeBase64Url(jwk.k), kty: "oct" };
      return JSON.stringify(members);
    }
    default:
      return unreachableValue(jwk);
  }
}

/**
 * JWK サムプリント (RFC 7638) の SHA-256 を計算する
 */
export async function jwkThumbprintSha256(crypto: CoseCrypto, jwk: Jwk): Promise<Uint8Array> {
  const canonical = canonicalJwkJson(jwk);
  return crypto.digest("Sha256", TEXT_ENCODER.encode(canonical));
}

/**
 * JWK の曲線名から COSE の曲線を返す
 */
function curveFromJwkName(name: string): EcCurve | undefined {
  switch (name) {
    case "P-256":
      return "P256";
    case "P-384":
      return "P384";
    case "P-521":
      return "P521";
    default:
      return undefined;
  }
}

/**
 * COSE の曲線から JWK の曲線名を返す
 */
function jwkNameFromCurve(curve: EcCurve): string {
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
 * base64url のメンバーをデコードする
 */
function decodeField(name: string, value: string): Uint8Array {
  try {
    return decodeBase64Url(value);
  } catch (error) {
    if (error instanceof Base64DecodeError) {
      throw new JwkError("invalidBase64", `${name}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * JWK を `CoseKey` へ変換する
 *
 * 秘密鍵のメンバー (`d` / `k`) がある場合は署名に使える鍵を返す。
 */
export function jwkToCoseKey(jwk: Jwk): CoseKey {
  switch (jwk.kty) {
    case "EC": {
      const curve = curveFromJwkName(jwk.crv);
      if (curve === undefined) {
        throw new JwkError("unsupportedCurve", jwk.crv);
      }
      const x = decodeField("x", jwk.x);
      const y = decodeField("y", jwk.y);
      if (jwk.d === undefined) {
        return ec2Key(curve, x, y);
      }
      return ec2KeyWithPrivateKey(curve, x, y, decodeField("d", jwk.d));
    }
    case "OKP": {
      if (jwk.crv !== "Ed25519") {
        throw new JwkError("unsupportedCurve", jwk.crv);
      }
      const publicKey = decodeField("x", jwk.x);
      if (jwk.d === undefined) {
        return ed25519Key(publicKey);
      }
      return ed25519KeyWithPrivateKey(publicKey, decodeField("d", jwk.d));
    }
    case "oct":
      return symmetricKey(decodeField("k", jwk.k));
    default:
      return unreachableValue(jwk);
  }
}

/**
 * `CoseKey` を JWK へ変換する
 *
 * 秘密鍵を持つ `CoseKey` は `d` を含む JWK を返す。
 */
export function coseKeyToJwk(key: CoseKey): Jwk {
  switch (key.type) {
    case "symmetric":
      return { kty: "oct", k: encodeBase64Url(key.key) };
    case "ec2":
      return {
        kty: "EC",
        crv: jwkNameFromCurve(key.curve),
        x: encodeBase64Url(key.x),
        y: encodeBase64Url(key.y),
        d: key.privateKey !== undefined ? encodeBase64Url(key.privateKey) : undefined,
      };
    case "okp":
      return {
        kty: "OKP",
        crv: "Ed25519",
        x: encodeBase64Url(key.publicKey),
        d: key.privateKey !== undefined ? encodeBase64Url(key.privateKey) : undefined,
      };
    default:
      return unreachableValue(key);
  }
}

const TEXT_ENCODER = new TextEncoder();
