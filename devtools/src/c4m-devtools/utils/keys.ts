/**
 * C4M DevTools の鍵生成と鍵入力の解釈
 *
 * 鍵ペアの生成は Web Crypto API の `generateKey` だけを使う。生成した鍵は
 * メモリ上だけで扱い、URL / OPFS / localStorage へ保存しない。
 */

import { C4M } from "moqt-js";

/** 生成できる鍵のアルゴリズム */
export type KeyGenerationAlgorithm = "Es256" | "Es384" | "Es512" | "EdDsa" | "HmacSha256";

/** 生成した非対称鍵 */
export interface GeneratedAsymmetricKey {
  kind: "asymmetric";
  algorithm: KeyGenerationAlgorithm;
  /** 公開鍵の JWK */
  publicJwk: C4M.Jwk;
  /** 秘密鍵の JWK (Ed25519 は seed、ECDSA はスカラーを含む) */
  privateJwk: C4M.Jwk;
  /** 検証に使う `CoseKey` */
  publicCoseKey: C4M.CoseKey;
  /** 署名に使う `CoseKey` */
  privateCoseKey: C4M.CoseKey;
}

/** 生成した対称鍵 */
export interface GeneratedSymmetricKey {
  kind: "symmetric";
  algorithm: "HmacSha256";
  secret: Uint8Array;
}

export type GeneratedKey = GeneratedAsymmetricKey | GeneratedSymmetricKey;

/** 対称鍵の入力形式 */
export type SecretInputFormat = "detect" | "hex" | "base64url" | "text";

/** 解釈した対称鍵 */
export interface ParsedSecret {
  secret: Uint8Array;
  /** `detect` を解決した実際の形式 */
  format: Exclude<SecretInputFormat, "detect">;
}

const TEXT_ENCODER = new TextEncoder();

/**
 * アルゴリズムに対応する Web Crypto API の楕円曲線名を返す
 */
function namedCurveForAlgorithm(algorithm: KeyGenerationAlgorithm): string | undefined {
  switch (algorithm) {
    case "Es256":
      return "P-256";
    case "Es384":
      return "P-384";
    case "Es512":
      return "P-521";
    case "EdDsa":
      return "Ed25519";
    case "HmacSha256":
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Web Crypto API の鍵を JWK として取り出す
 */
async function exportJwk(key: CryptoKey): Promise<C4M.Jwk> {
  const jwk = await crypto.subtle.exportKey("jwk", key);
  return C4M.decodeJwk(JSON.stringify(jwk));
}

/**
 * 鍵ペアを生成する
 *
 * 対称鍵 (HMAC) はランダムな 32 バイトを返す。
 */
export async function generateKey(algorithm: KeyGenerationAlgorithm): Promise<GeneratedKey> {
  if (algorithm === "HmacSha256") {
    const secret = new Uint8Array(32);
    crypto.getRandomValues(secret);
    return { kind: "symmetric", algorithm, secret };
  }
  const namedCurve = namedCurveForAlgorithm(algorithm);
  if (namedCurve === undefined) {
    throw new Error(`unsupported algorithm: ${algorithm}`);
  }
  const keyPair =
    algorithm === "EdDsa"
      ? await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
      : await crypto.subtle.generateKey({ name: "ECDSA", namedCurve }, true, ["sign", "verify"]);
  const publicJwk = await exportJwk(keyPair.publicKey);
  const privateJwk = await exportJwk(keyPair.privateKey);
  return {
    kind: "asymmetric",
    algorithm,
    publicJwk,
    privateJwk,
    publicCoseKey: C4M.jwkToCoseKey(publicJwk),
    privateCoseKey: C4M.jwkToCoseKey(privateJwk),
  };
}

/**
 * バイト列を 16 進文字列へ変換する
 */
export function bytesToHex(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) {
    text += byte.toString(16).padStart(2, "0");
  }
  return text;
}

/**
 * 16 進文字列をバイト列へ変換する
 */
function hexToBytes(text: string): Uint8Array | undefined {
  const normalized = text.startsWith("0x") || text.startsWith("0X") ? text.slice(2) : text;
  if (
    normalized.length === 0 ||
    normalized.length % 2 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(normalized)
  ) {
    return undefined;
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * 対称鍵の入力を解釈する
 *
 * `detect` は 16 進表記らしい場合だけ 16 進として扱い、それ以外は base64url を
 * 試してから UTF-8 のテキストとして扱う。解釈結果は `format` で返すため、画面に
 * 表示して確認できる。
 */
export function parseSecretInput(
  text: string,
  format: SecretInputFormat = "detect",
): ParsedSecret | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (format === "hex") {
    const bytes = hexToBytes(trimmed);
    if (bytes === undefined) {
      throw new Error("invalid hex secret");
    }
    return { secret: bytes, format: "hex" };
  }
  if (format === "base64url") {
    const bytes = C4M.tryDecodeBase64OrUrl(trimmed);
    if (bytes === undefined) {
      throw new Error("invalid base64url secret");
    }
    return { secret: bytes, format: "base64url" };
  }
  if (format === "text") {
    return { secret: TEXT_ENCODER.encode(trimmed), format: "text" };
  }
  const hex = hexToBytes(trimmed);
  if (hex !== undefined) {
    return { secret: hex, format: "hex" };
  }
  const base64 = C4M.tryDecodeBase64OrUrl(trimmed);
  if (base64 !== undefined) {
    return { secret: base64, format: "base64url" };
  }
  return { secret: TEXT_ENCODER.encode(trimmed), format: "text" };
}

/**
 * JWK の入力から検証 / 署名に使う `CoseKey` を作る
 */
export function parseJwkInput(text: string): { jwk: C4M.Jwk; coseKey: C4M.CoseKey } {
  const jwk = C4M.decodeJwk(text.trim());
  return { jwk, coseKey: C4M.jwkToCoseKey(jwk) };
}

/**
 * 鍵入力の解釈結果
 *
 * `inspectKeyInput` が返し、画面表示と実際の鍵解決の両方で使う。
 */
export type KeyInputInspection =
  | { type: "empty" }
  | {
      type: "jwk";
      jwk: C4M.Jwk;
      coseKey: C4M.CoseKey;
      /** 署名に使える秘密鍵を持っているかどうか */
      hasPrivateKey: boolean;
    }
  | {
      type: "secret";
      secret: Uint8Array;
      format: Exclude<SecretInputFormat, "detect">;
    }
  | { type: "error"; message: string };

/**
 * JWK が秘密鍵のメンバーを持っているかどうかを返す
 *
 * `oct` は鍵そのものが共通鍵であり、常に署名に使える。
 */
export function hasPrivateKey(jwk: C4M.Jwk): boolean {
  switch (jwk.kty) {
    case "EC":
    case "OKP":
      return jwk.d !== undefined;
    case "oct":
      return true;
    default:
      return false;
  }
}

/**
 * JWK の種類を画面表示用に説明する
 */
export function describeJwk(jwk: C4M.Jwk): string {
  switch (jwk.kty) {
    case "EC":
      return `EC ${jwk.crv} (${jwk.d !== undefined ? "private key" : "public key"})`;
    case "OKP":
      return `OKP ${jwk.crv} (${jwk.d !== undefined ? "private key" : "public key"})`;
    case "oct":
      return "oct (symmetric secret)";
    default:
      return "unsupported key";
  }
}

/**
 * 鍵の入力を解釈する
 *
 * 値が `{` で始まる場合は JWK として解釈し、形式の指定は使わない。それ以外は
 * `parseSecretInput` と同じ規則で解釈する。エラーは例外ではなく値で返し、入力の
 * たびに画面表示できるようにする。
 */
export function inspectKeyInput(text: string, format: SecretInputFormat): KeyInputInspection {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { type: "empty" };
  }
  if (trimmed.startsWith("{")) {
    try {
      const { jwk, coseKey } = parseJwkInput(trimmed);
      return { type: "jwk", jwk, coseKey, hasPrivateKey: hasPrivateKey(jwk) };
    } catch (error) {
      return { type: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }
  try {
    const parsed = parseSecretInput(trimmed, format);
    if (parsed === undefined) {
      return { type: "empty" };
    }
    return { type: "secret", secret: parsed.secret, format: parsed.format };
  } catch (error) {
    return { type: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * JWK から秘密鍵のメンバーを除いた公開鍵の JWK を返す
 */
export function publicJwkOf(jwk: C4M.Jwk): C4M.Jwk {
  switch (jwk.kty) {
    case "EC":
      return { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y, d: undefined };
    case "OKP":
      return { kty: "OKP", crv: jwk.crv, x: jwk.x, d: undefined };
    case "oct":
      return jwk;
    default:
      throw new Error("unsupported JWK key type");
  }
}
