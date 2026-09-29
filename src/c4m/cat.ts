/**
 * CAT (Common Access Token) のクレームとトークン
 *
 * CTA-5007-B の CAT を CWT (RFC 8392) のクレームとして扱い、draft-ietf-moq-c4m-01
 * の `moqt` / `moqt-reval` を加えたトークンの発行と検証を提供する。
 *
 * 直列化は 2 種類を扱う。
 *
 * - compact: `base64url(protected).base64url(claims).base64url(signature)`。
 *   draft-ietf-moq-c4m-01 付録 A のテストベクタの形式で、署名対象は ASCII の
 *   `protected.claims` である
 * - COSE: CWT タグ 61 + COSE_Sign1 (タグ 18) / COSE_Mac0 (タグ 17)。RFC 8392 /
 *   RFC 9052 の形式で、署名対象は `Sig_structure` / `MAC_structure` である
 *
 * CTA-5007-B 本体は有償仕様のため、クレームキーは IANA の CWT Claims レジストリと
 * IANA の CWT Confirmation Methods レジストリ、および draft-ietf-moq-c4m-01 の
 * テストベクタに従う。
 *
 * 署名 / 検証は `CoseCrypto` インターフェース越しに行う (Web Crypto API を使う
 * 実装は `./webcrypto.ts` を参照)。
 */

import {
  Base64DecodeError,
  decodeBase64Url,
  encodeBase64Url,
  tryDecodeBase64OrUrl,
} from "./base64url";
import {
  type CborValue,
  CborError,
  cborArray,
  cborAsBytes,
  cborAsInt64,
  cborAsNumber,
  cborAsText,
  cborByteString,
  cborInteger,
  cborMap,
  cborTextString,
  decodeCbor,
  encodeCbor,
} from "./cbor";
import {
  type Algorithm,
  type CoseEncodingOptions,
  CoseError,
  type CoseHeader,
  type CoseKeyId,
  type CoseMessage,
  DEFAULT_COSE_ENCODING_OPTIONS,
  HEADER_ALGORITHM,
  HEADER_KEY_ID,
  HEADER_TYPE,
  algorithmIdentifier,
  algorithmIsMac,
  coseMessageHeader,
  coseMessagePayload,
  coseMessageSigningInput,
  decodeCoseMessage,
  decodeProtectedHeader,
  encodeCoseMessage,
} from "./cose";
import { type CoseCrypto, type CoseKey, CryptoError, defaultSigningAlgorithm } from "./crypto";
import {
  C4mError,
  type CatDpop,
  type MoqtAction,
  type MoqtClaim,
  CLAIM_MOQT,
  CLAIM_MOQT_REVAL,
  cborNumberValue,
  createCatDpop,
  decodeCatDpop,
  decodeMoqtClaim,
  encodeCatDpop,
  encodeMoqtClaim,
  moqtClaimAuthorize,
} from "./moqt";
import { unreachableValue } from "./unreachable";

/** CWT の `iss` (RFC 8392 Section 3.1.1) */
export const CLAIM_ISSUER = 1;

/** CWT の `sub` (RFC 8392 Section 3.1.2) */
export const CLAIM_SUBJECT = 2;

/** CWT の `aud` (RFC 8392 Section 3.1.3) */
export const CLAIM_AUDIENCE = 3;

/** CWT の `exp` (RFC 8392 Section 3.1.4) */
export const CLAIM_EXPIRATION = 4;

/** CWT の `nbf` (RFC 8392 Section 3.1.5) */
export const CLAIM_NOT_BEFORE = 5;

/** CWT の `iat` (RFC 8392 Section 3.1.6) */
export const CLAIM_ISSUED_AT = 6;

/** CWT の `cti` (RFC 8392 Section 3.1.7) */
export const CLAIM_CWT_ID = 7;

/** CWT の `cnf` (RFC 8747) */
export const CLAIM_CONFIRMATION = 8;

/** CAT の `catreplay` (IANA CWT Claims レジストリ、CTA-5007) */
export const CLAIM_CAT_REPLAY = 308;

/** CAT の `catpor` (IANA CWT Claims レジストリ、CTA-5007) */
export const CLAIM_CAT_PROBABILITY_OF_REJECTION = 309;

/** CAT の `catv` (IANA CWT Claims レジストリ、CTA-5007) */
export const CLAIM_CAT_VERSION = 310;

/** CAT の `catnip` (IANA CWT Claims レジストリ、CTA-5007) */
export const CLAIM_CAT_NETWORK_IP = 311;

/** CAT の `catu` (IANA CWT Claims レジストリ、CTA-5007) */
export const CLAIM_CAT_URI = 312;

/** CAT の `catm` (IANA CWT Claims レジストリ、CTA-5007) */
export const CLAIM_CAT_METHOD = 313;

/** CAT の `catalpn` (IANA CWT Claims レジストリ、CTA-5007) */
export const CLAIM_CAT_ALPN = 314;

/** CAT の `cath` (IANA CWT Claims レジストリ、CTA-5007) */
export const CLAIM_CAT_HEADER = 315;

/** CAT の `catgeoiso3166` (IANA CWT Claims レジストリ、CTA-5007) */
export const CLAIM_CAT_GEO_ISO3166 = 316;

/** CAT の `catgeocoord` (IANA CWT Claims レジストリ、CTA-5007) */
export const CLAIM_CAT_GEO_COORD = 317;

/** CAT の `catgeoalt` (IANA CWT Claims レジストリ、CTA-5007) */
export const CLAIM_CAT_GEO_ALT = 318;

/** CAT の `cattpk` (IANA CWT Claims レジストリ、CTA-5007) */
export const CLAIM_CAT_TLS_PUBLIC_KEY = 319;

/** CAT の `catifdata` (IANA CWT Claims レジストリ、CTA-5007) */
export const CLAIM_CAT_IF_DATA = 320;

/** CAT の `catdpop` (IANA CWT Claims レジストリ、CTA-5007) */
export const CLAIM_CAT_DPOP = 321;

/** CAT の `catif` (IANA CWT Claims レジストリ、CTA-5007) */
export const CLAIM_CAT_IF = 322;

/** CAT の `catr` (IANA CWT Claims レジストリ、CTA-5007) */
export const CLAIM_CAT_RENEWAL = 323;

/**
 * `cnf` の `jkt` (JWK サムプリント) の confirmation key
 *
 * IANA の CWT Confirmation Methods レジストリに CTA が登録した値 (323)。
 */
export const CONFIRMATION_JWK_THUMBPRINT = 323;

/**
 * draft-ietf-moq-c4m-01 のベクタが `jkt` に使う confirmation key
 *
 * 付録 A.4 のベクタは 3 を使うが、IANA の CWT Confirmation Methods レジストリでは
 * 3 は `kid` (RFC 8747 Section 3.4) である。検証では両方を受け、発行は
 * `CONFIRMATION_JWK_THUMBPRINT` を既定とする。
 */
export const CONFIRMATION_C4M_DRAFT_JWK_THUMBPRINT = 3;

/** MOQT の Auth Token Type (CAT) (draft-ietf-moq-c4m-01 Section 7.1) */
export const MOQT_AUTH_TOKEN_TYPE_CAT = 1n;

/**
 * CAT の COSE ヘッダの `typ` の値
 *
 * draft-ietf-moq-c4m-01 付録 A のテストベクタが protected ヘッダに置く値。
 * `CatVerifyOptions.expectedType` に渡して検証できる。
 */
export const CAT_CONTENT_TYPE = "CAT";

/**
 * CAT のトークン直列化
 */
export type TokenFormat = "compact" | "coseSign1" | "coseMac0";

/**
 * `cnf` (confirmation) クレーム (RFC 8747 / CTA-5007-B)
 */
export interface Confirmation {
  /** IANA 登録の `jkt` (confirmation key 323) の値 */
  jwkThumbprint: Uint8Array | undefined;
  /**
   * draft-ietf-moq-c4m-01 のベクタが使う `jkt` (confirmation key 3) の値
   *
   * IANA のレジストリでは 3 は `kid` であり、値の意味が確定していないため
   * `raw` とは分けて保持する。
   */
  c4mDraftJwkThumbprint: Uint8Array | undefined;
  /** 解釈しなかった confirmation の値 */
  raw: Array<[CborValue, CborValue]>;
}

/**
 * 空の `cnf` を作る
 */
export function createConfirmation(): Confirmation {
  return { jwkThumbprint: undefined, c4mDraftJwkThumbprint: undefined, raw: [] };
}

/**
 * `cnf` をデコードする
 */
export function decodeConfirmation(value: CborValue): Confirmation {
  const entries = cborMapEntries(value, "cnf");
  const confirmation = createConfirmation();
  for (const [key, entry] of entries) {
    const label = cborAsInt64(key);
    if (label === BigInt(CONFIRMATION_JWK_THUMBPRINT)) {
      const bytes = cborAsBytes(entry);
      if (bytes === undefined) {
        throw new CatError("unexpectedType", "jkt");
      }
      confirmation.jwkThumbprint = bytes;
      continue;
    }
    if (label === BigInt(CONFIRMATION_C4M_DRAFT_JWK_THUMBPRINT)) {
      const bytes = cborAsBytes(entry);
      if (bytes === undefined) {
        throw new CatError("unexpectedType", "jkt");
      }
      confirmation.c4mDraftJwkThumbprint = bytes;
      continue;
    }
    confirmation.raw.push([key, entry]);
  }
  return confirmation;
}

/**
 * `cnf` をエンコードする
 */
export function encodeConfirmation(confirmation: Confirmation): CborValue {
  const entries: Array<[CborValue, CborValue]> = [];
  if (confirmation.jwkThumbprint !== undefined) {
    entries.push([
      cborInteger(CONFIRMATION_JWK_THUMBPRINT),
      cborByteString(confirmation.jwkThumbprint),
    ]);
  }
  if (confirmation.c4mDraftJwkThumbprint !== undefined) {
    entries.push([
      cborInteger(CONFIRMATION_C4M_DRAFT_JWK_THUMBPRINT),
      cborByteString(confirmation.c4mDraftJwkThumbprint),
    ]);
  }
  entries.push(...confirmation.raw.map((entry): [CborValue, CborValue] => [entry[0], entry[1]]));
  return cborMap(entries);
}

/**
 * JWK サムプリントを返す
 *
 * IANA 登録の 323 を優先し、無ければドラフトのベクタが使う 3 を返す。
 */
export function confirmationJkt(confirmation: Confirmation): Uint8Array | undefined {
  return confirmation.jwkThumbprint ?? confirmation.c4mDraftJwkThumbprint;
}

/**
 * CAT のクレームセット (CWT のクレーム + CAT / C4M のクレーム)
 *
 * 型付きで解釈しないクレームは `raw` にそのまま保持する。CAT のクレームは IANA の
 * 登録と draft-ietf-moq-c4m-01 のベクタで値型が一致しないもの (catv / catu など)
 * があるため、意味論を定める C4M のクレームだけを型付きにする。
 */
export interface CatClaims {
  /** `iss` */
  issuer: string | undefined;
  /** `sub` */
  subject: string | undefined;
  /** `aud`。単一のテキストと配列の両方を受ける */
  audience: string[];
  /** `exp` (UNIX 秒) */
  expiration: number | undefined;
  /** `nbf` (UNIX 秒) */
  notBefore: number | undefined;
  /** `iat` (UNIX 秒) */
  issuedAt: number | undefined;
  /** `cti`。バイト文字列とテキスト文字列の両方を受ける */
  cwtId: Uint8Array | undefined;
  /** `cnf` */
  confirmation: Confirmation | undefined;
  /** `moqt` (draft-ietf-moq-c4m-01 Section 2.1) */
  moqt: MoqtClaim | undefined;
  /**
   * `moqt-reval` (draft-ietf-moq-c4m-01 Section 2.2) の再検証間隔 (秒)
   *
   * 再検証の実行は行わず、この値の解釈と拒否の判断は利用側が行う。
   */
  moqtReval: number | undefined;
  /** `catdpop` (draft-ietf-moq-c4m-01 Section 3.1.1) */
  catdpop: CatDpop | undefined;
  /** 型付きで解釈しなかったクレーム */
  raw: Array<[CborValue, CborValue]>;
}

/**
 * 空のクレームセットを作る
 */
export function createCatClaims(): CatClaims {
  return {
    issuer: undefined,
    subject: undefined,
    audience: [],
    expiration: undefined,
    notBefore: undefined,
    issuedAt: undefined,
    cwtId: undefined,
    confirmation: undefined,
    moqt: undefined,
    moqtReval: undefined,
    catdpop: undefined,
    raw: [],
  };
}

/**
 * 型付きフィールドを持つ claim key かどうかを返す
 */
function isTypedClaimKey(key: number): boolean {
  return (
    key === CLAIM_ISSUER ||
    key === CLAIM_SUBJECT ||
    key === CLAIM_AUDIENCE ||
    key === CLAIM_EXPIRATION ||
    key === CLAIM_NOT_BEFORE ||
    key === CLAIM_ISSUED_AT ||
    key === CLAIM_CWT_ID ||
    key === CLAIM_CONFIRMATION ||
    key === CLAIM_MOQT ||
    key === CLAIM_MOQT_REVAL ||
    key === CLAIM_CAT_DPOP
  );
}

/**
 * 数値クレームを有限値として CBOR のデータ項目へエンコードする
 */
function finiteNumberValue(number: number, name: string): CborValue {
  if (!Number.isFinite(number)) {
    throw new CatError("nonFiniteNumber", name);
  }
  return cborNumberValue(number);
}

/**
 * 数値クレームを有限の number として取り出す
 *
 * NaN / 無限大は期限判定を素通りさせるため、デコードの時点で拒否する。
 */
function finiteClaimNumber(entry: CborValue, name: string): number {
  const number = cborAsNumber(entry);
  if (number === undefined) {
    throw new CatError("unexpectedType", name);
  }
  if (!Number.isFinite(number)) {
    throw new CatError("nonFiniteNumber", name);
  }
  return number;
}

/**
 * `cnf` などのマップを取得する
 */
function cborMapEntries(value: CborValue, name: string): Array<[CborValue, CborValue]> {
  if (value.type !== "map") {
    throw new CatError("unexpectedType", name);
  }
  return value.value;
}

/**
 * クレームセットをデコードする
 */
export function decodeCatClaims(value: CborValue): CatClaims {
  const entries = cborMapEntries(value, "claims");
  const claims = createCatClaims();
  for (const [key, entry] of entries) {
    // CWT の claim key は整数またはテキスト文字列 (RFC 8392 Section 3)。
    // それ以外の型は意味を解釈できないため拒否する
    const keyInt = cborAsInt64(key);
    if (keyInt === undefined) {
      if (key.type === "textString") {
        claims.raw.push([key, entry]);
        continue;
      }
      throw new CatError("unexpectedType", "claim key");
    }
    switch (Number(keyInt)) {
      case CLAIM_ISSUER: {
        const text = cborAsText(entry);
        if (text === undefined) {
          throw new CatError("unexpectedType", "iss");
        }
        claims.issuer = text;
        break;
      }
      case CLAIM_SUBJECT: {
        const text = cborAsText(entry);
        if (text === undefined) {
          throw new CatError("unexpectedType", "sub");
        }
        claims.subject = text;
        break;
      }
      case CLAIM_AUDIENCE:
        if (entry.type === "textString") {
          claims.audience.push(entry.value);
        } else if (entry.type === "array") {
          for (const audience of entry.value) {
            const text = cborAsText(audience);
            if (text === undefined) {
              throw new CatError("unexpectedType", "aud");
            }
            claims.audience.push(text);
          }
        } else {
          throw new CatError("unexpectedType", "aud");
        }
        break;
      case CLAIM_EXPIRATION:
        claims.expiration = finiteClaimNumber(entry, "exp");
        break;
      case CLAIM_NOT_BEFORE:
        claims.notBefore = finiteClaimNumber(entry, "nbf");
        break;
      case CLAIM_ISSUED_AT:
        claims.issuedAt = finiteClaimNumber(entry, "iat");
        break;
      case CLAIM_CWT_ID:
        if (entry.type === "byteString") {
          claims.cwtId = entry.value;
        } else if (entry.type === "textString") {
          // 付録 A.2 / A.3 のベクタはテキスト文字列を使う
          claims.cwtId = TEXT_ENCODER.encode(entry.value);
        } else {
          throw new CatError("unexpectedType", "cti");
        }
        break;
      case CLAIM_CONFIRMATION:
        claims.confirmation = decodeConfirmation(entry);
        break;
      case CLAIM_MOQT:
        claims.moqt = decodeMoqtClaim(entry);
        break;
      case CLAIM_MOQT_REVAL:
        claims.moqtReval = finiteClaimNumber(entry, "moqt-reval");
        break;
      case CLAIM_CAT_DPOP:
        claims.catdpop = decodeCatDpop(entry);
        break;
      default:
        claims.raw.push([key, entry]);
        break;
    }
  }
  return claims;
}

/**
 * クレームセットをエンコードする
 *
 * 型付きフィールドを持つ claim key を `raw` に置いた場合は、型付きフィールドが
 * 未設定でもエラーを返す。非有限値の数値クレームもエラーを返す。
 *
 * デコードしたクレームを再エンコードすると表現が正規化される (`aud` の単一テキスト
 * は配列になり、`cti` のテキストはバイト文字列になり、整数値の浮動小数点数は整数に
 * なる)。
 */
export function encodeCatClaims(claims: CatClaims): CborValue {
  const entries: Array<[CborValue, CborValue]> = [];
  if (claims.issuer !== undefined) {
    entries.push([cborInteger(CLAIM_ISSUER), cborTextString(claims.issuer)]);
  }
  if (claims.subject !== undefined) {
    entries.push([cborInteger(CLAIM_SUBJECT), cborTextString(claims.subject)]);
  }
  if (claims.audience.length > 0) {
    entries.push([
      cborInteger(CLAIM_AUDIENCE),
      cborArray(claims.audience.map((audience) => cborTextString(audience))),
    ]);
  }
  if (claims.expiration !== undefined) {
    entries.push([cborInteger(CLAIM_EXPIRATION), finiteNumberValue(claims.expiration, "exp")]);
  }
  if (claims.notBefore !== undefined) {
    entries.push([cborInteger(CLAIM_NOT_BEFORE), finiteNumberValue(claims.notBefore, "nbf")]);
  }
  if (claims.issuedAt !== undefined) {
    entries.push([cborInteger(CLAIM_ISSUED_AT), finiteNumberValue(claims.issuedAt, "iat")]);
  }
  if (claims.cwtId !== undefined) {
    entries.push([cborInteger(CLAIM_CWT_ID), cborByteString(claims.cwtId)]);
  }
  if (claims.confirmation !== undefined) {
    entries.push([cborInteger(CLAIM_CONFIRMATION), encodeConfirmation(claims.confirmation)]);
  }
  if (claims.moqt !== undefined) {
    entries.push([cborInteger(CLAIM_MOQT), encodeMoqtClaim(claims.moqt)]);
  }
  if (claims.moqtReval !== undefined) {
    entries.push([
      cborInteger(CLAIM_MOQT_REVAL),
      finiteNumberValue(claims.moqtReval, "moqt-reval"),
    ]);
  }
  if (claims.catdpop !== undefined) {
    entries.push([cborInteger(CLAIM_CAT_DPOP), encodeCatDpop(claims.catdpop)]);
  }
  for (const [key, value] of claims.raw) {
    // 型付きフィールドを持つ claim key を raw に置くと、デコード時に型付き
    // フィールドと raw のどちらが使われるかが曖昧になる。値の型も検証できない
    // ため、設定の有無にかかわらず拒否する
    const keyInt = cborAsInt64(key);
    if (keyInt !== undefined && isTypedClaimKey(Number(keyInt))) {
      throw new CatError("duplicateClaim", Number(keyInt));
    }
    entries.push([key, value]);
  }
  return cborMap(entries);
}

/**
 * 整数キーのクレームを取り出す
 *
 * 型付きフィールドとして解釈しなかったクレーム、および整数キーの未知のクレームを
 * 対象とする。
 */
export function getCatClaim(claims: CatClaims, key: number): CborValue | undefined {
  return claims.raw.find(([entryKey]) => cborAsInt64(entryKey) === BigInt(key))?.[1];
}

/**
 * `moqt` クレームによりアクションが認可されるかどうかを返す
 *
 * `moqt` クレームが無い場合は常に false を返す (Section 2 の「明示的に許可された
 * アクション以外はブロックする」)。
 */
export function authorizeCatClaims(
  claims: CatClaims,
  action: MoqtAction,
  namespace: Uint8Array[],
  trackName: Uint8Array,
): boolean {
  if (claims.moqt === undefined) {
    return false;
  }
  return moqtClaimAuthorize(claims.moqt, action, namespace, trackName);
}

/**
 * クレームの検証オプション
 *
 * 未指定の値は既定値 (現在時刻 0 秒、許容ずれ 0 秒、期待する発行者 / 宛先なし)
 * を使う。
 */
export interface CatClaimValidationOptions {
  /** 検証に使う現在時刻 (UNIX 秒) */
  referenceTimeSeconds?: number;
  /** `exp` / `nbf` に許容するずれ (秒) */
  clockToleranceSeconds?: number;
  /** 期待する `iss` の一覧。空の場合は検証しない */
  expectedIssuers?: string[];
  /** 期待する `aud` の一覧。空の場合は検証しない */
  expectedAudiences?: string[];
}

/**
 * クレームの検証エラー
 */
export type ClaimValidationErrorCode =
  | "expired"
  | "notYetValid"
  | "issuerMismatch"
  | "audienceMismatch"
  | "invalidReferenceTime"
  | "nonFiniteClaim";

export class ClaimValidationError extends Error {
  readonly code: ClaimValidationErrorCode;

  constructor(code: ClaimValidationErrorCode, detail?: string) {
    super(buildClaimValidationErrorMessage(code, detail));
    this.name = "ClaimValidationError";
    this.code = code;
  }
}

/**
 * エラーコードから英語のメッセージを組み立てる
 */
function buildClaimValidationErrorMessage(
  code: ClaimValidationErrorCode,
  detail: string | undefined,
): string {
  switch (code) {
    case "expired":
      return "token is expired";
    case "notYetValid":
      return "token is not yet valid";
    case "issuerMismatch":
      return "token issuer does not match";
    case "audienceMismatch":
      return "token audience does not match";
    case "invalidReferenceTime":
      return "reference time must be finite and clock tolerance must be finite and non-negative";
    case "nonFiniteClaim":
      return `${String(detail)} must be finite`;
    default:
      return unreachableValue(code);
  }
}

/**
 * 時刻と期待値に対するクレームの検証を行う
 *
 * 署名の検証は `CatToken.verify` が行う。ここでは `exp` / `nbf` / `iss` / `aud` を
 * 検証し、加えて現在時刻 / 許容ずれの有限性と、手組みで入り得る非有限の数値クレーム
 * を拒否する。
 */
export function validateCatClaims(
  claims: CatClaims,
  options: CatClaimValidationOptions = {},
): void {
  const referenceTimeSeconds = options.referenceTimeSeconds ?? 0;
  const clockToleranceSeconds = options.clockToleranceSeconds ?? 0;
  const expectedIssuers = options.expectedIssuers ?? [];
  const expectedAudiences = options.expectedAudiences ?? [];
  if (
    !Number.isFinite(referenceTimeSeconds) ||
    !Number.isFinite(clockToleranceSeconds) ||
    clockToleranceSeconds < 0
  ) {
    throw new ClaimValidationError("invalidReferenceTime");
  }
  // フィールドは公開のため、デコード以外の経路で非有限値が入り得る
  const numericClaims: Array<[number | undefined, string]> = [
    [claims.expiration, "exp"],
    [claims.notBefore, "nbf"],
    [claims.issuedAt, "iat"],
    [claims.moqtReval, "moqt-reval"],
  ];
  for (const [number, name] of numericClaims) {
    if (number !== undefined && !Number.isFinite(number)) {
      throw new ClaimValidationError("nonFiniteClaim", name);
    }
  }
  if (
    claims.catdpop !== undefined &&
    claims.catdpop.windowSeconds !== undefined &&
    !Number.isFinite(claims.catdpop.windowSeconds)
  ) {
    throw new ClaimValidationError("nonFiniteClaim", "catdpop window");
  }
  if (
    claims.expiration !== undefined &&
    referenceTimeSeconds > claims.expiration + clockToleranceSeconds
  ) {
    throw new ClaimValidationError("expired");
  }
  if (
    claims.notBefore !== undefined &&
    referenceTimeSeconds + clockToleranceSeconds < claims.notBefore
  ) {
    throw new ClaimValidationError("notYetValid");
  }
  if (expectedIssuers.length > 0) {
    if (claims.issuer === undefined || !expectedIssuers.includes(claims.issuer)) {
      throw new ClaimValidationError("issuerMismatch");
    }
  }
  if (expectedAudiences.length > 0) {
    if (!claims.audience.some((audience) => expectedAudiences.includes(audience))) {
      throw new ClaimValidationError("audienceMismatch");
    }
  }
}

/**
 * 署名検証のオプション
 */
export interface CatVerifyOptions {
  /** トークンの `alg` に期待するアルゴリズム */
  expectedAlgorithm?: Algorithm;
  /**
   * トークンの `typ` に期待する値
   *
   * CAT では `CAT_CONTENT_TYPE` (`"CAT"`) を指定する。未指定の場合は `typ` を
   * 検証しない。`typ` がテキスト文字列でない場合と一致しない場合は `typeMismatch`
   * で失敗する。
   */
  expectedType?: string;
}

/**
 * CAT のトークン
 *
 * 生トークン (bearer クレデンシャル) と署名は非公開フィールドとして保持し、
 * `format` / `rawToken` などのアクセサー越しに扱う。
 */
export class CatToken {
  readonly #tokenFormat: TokenFormat;
  readonly #raw: Uint8Array;
  readonly #protectedBytes: Uint8Array;
  readonly #unprotected: Array<[CborValue, CborValue]>;
  readonly #payloadBytes: Uint8Array;
  readonly #signatureBytes: Uint8Array;
  readonly #input: Uint8Array;
  readonly #tokenHeader: CoseHeader;
  readonly #tokenClaims: CatClaims;

  private constructor(
    tokenFormat: TokenFormat,
    raw: Uint8Array,
    protectedBytes: Uint8Array,
    unprotected: Array<[CborValue, CborValue]>,
    payloadBytes: Uint8Array,
    signatureBytes: Uint8Array,
    input: Uint8Array,
    tokenHeader: CoseHeader,
    tokenClaims: CatClaims,
  ) {
    this.#tokenFormat = tokenFormat;
    // 呼び出し側が渡した配列を後から変更してもトークンの内容が変わらないようにコピーする
    this.#raw = raw.slice();
    this.#protectedBytes = protectedBytes;
    this.#unprotected = unprotected;
    this.#payloadBytes = payloadBytes;
    this.#signatureBytes = signatureBytes;
    this.#input = input;
    this.#tokenHeader = tokenHeader;
    this.#tokenClaims = tokenClaims;
  }

  /**
   * トークンをデコードする
   *
   * `.` で区切られた 3 分割の compact 形式、COSE 形式の CBOR、COSE 形式を
   * base64url または標準 Base64 で包んだテキストの順に判別する。標準 Base64 は
   * URL に埋め込む場合の表現 (draft-ietf-moq-c4m-01 Section 2 / Section 4) である。
   */
  static decode(input: Uint8Array): CatToken {
    try {
      const text = decodeUtf8OrUndefined(input);
      if (text !== undefined && countOccurrences(text, ".") === 2) {
        return CatToken.decodeCompact(text).withRaw(input);
      }
      let firstError: CatError | undefined;
      try {
        return CatToken.decodeCose(input).withRaw(input);
      } catch (error) {
        firstError = toCatError(error);
      }
      if (text !== undefined) {
        const bytes = tryDecodeBase64OrUrl(text.trim());
        if (bytes !== undefined) {
          return CatToken.decodeCose(bytes).withRaw(input);
        }
      }
      throw firstError ?? new CatError("invalidTokenFormat");
    } catch (error) {
      throw toCatError(error);
    }
  }

  /**
   * compact 形式
   * (`base64url(protected).base64url(claims).base64url(signature)`) をデコードする
   */
  static decodeCompact(text: string): CatToken {
    try {
      const parts = text.split(".");
      if (parts.length !== 3) {
        throw new CatError("invalidTokenFormat");
      }
      const protectedText = parts[0] ?? "";
      const payloadText = parts[1] ?? "";
      const protectedBytes = decodeBase64Url(protectedText);
      const payloadBytes = decodeBase64Url(payloadText);
      const signatureBytes = decodeBase64Url(parts[2] ?? "");
      const header = decodeProtectedHeader(decodeCbor(protectedBytes));
      if (header.algorithm === undefined) {
        throw new CatError("missingAlgorithm");
      }
      const claims = decodeCatClaims(decodeCbor(payloadBytes));
      // 署名対象は base64url のままの protected と claims (付録 A のベクタ)
      const signingInput = TEXT_ENCODER.encode(`${protectedText}.${payloadText}`);
      return new CatToken(
        "compact",
        TEXT_ENCODER.encode(text),
        protectedBytes,
        [],
        payloadBytes,
        signatureBytes,
        signingInput,
        header,
        claims,
      );
    } catch (error) {
      throw toCatError(error);
    }
  }

  /**
   * COSE 形式 (CBOR) をデコードする
   */
  static decodeCose(bytes: Uint8Array): CatToken {
    try {
      const message = decodeCoseMessage(bytes);
      const header = coseMessageHeader(message);
      if (header.algorithm === undefined) {
        throw new CatError("missingAlgorithm");
      }
      const payload = coseMessagePayload(message);
      if (payload === undefined) {
        throw new CatError("detachedPayload");
      }
      const claims = decodeCatClaims(decodeCbor(payload));
      const signingInput = coseMessageSigningInput(message);
      if (message.type === "sign1") {
        return new CatToken(
          "coseSign1",
          bytes,
          message.sign1.protected,
          message.sign1.unprotected,
          payload,
          message.sign1.signature,
          signingInput,
          header,
          claims,
        );
      }
      return new CatToken(
        "coseMac0",
        bytes,
        message.mac0.protected,
        message.mac0.unprotected,
        payload,
        message.mac0.tag,
        signingInput,
        header,
        claims,
      );
    } catch (error) {
      throw toCatError(error);
    }
  }

  /**
   * MOQT の Auth Token Type と Token Value からデコードする
   *
   * draft-ietf-moq-c4m-01 Section 7.1 の Token Type が 0x01 (CAT) 以外の場合は
   * エラーを返す。
   */
  static decodeMoqtAuthToken(tokenType: bigint, value: Uint8Array): CatToken {
    if (tokenType !== MOQT_AUTH_TOKEN_TYPE_CAT) {
      throw new CatError("invalidAuthTokenType", tokenType);
    }
    return CatToken.decode(value);
  }

  /**
   * 生トークンを差し替えた複製を作る
   *
   * `decode` は呼び出し側が渡した表現 (compact の ASCII / CBOR / Base64 テキスト) を
   * `rawToken` として保持する。
   */
  private withRaw(raw: Uint8Array): CatToken {
    return new CatToken(
      this.#tokenFormat,
      raw,
      this.#protectedBytes,
      this.#unprotected,
      this.#payloadBytes,
      this.#signatureBytes,
      this.#input,
      this.#tokenHeader,
      this.#tokenClaims,
    );
  }

  /**
   * 直列化の形式を返す
   */
  format(): TokenFormat {
    return this.#tokenFormat;
  }

  /**
   * `decode` に渡された生バイトを返す
   *
   * compact 形式では ASCII のトークン文字列、COSE 形式では CBOR のバイト列、
   * base64url で包んだ入力を渡した場合はそのテキストである。
   */
  rawToken(): Uint8Array {
    return this.#raw;
  }

  /**
   * protected / unprotected を統合したヘッダを返す
   */
  header(): CoseHeader {
    return this.#tokenHeader;
  }

  /**
   * クレームを返す
   */
  claims(): CatClaims {
    return this.#tokenClaims;
  }

  /**
   * 署名対象のバイト列を返す
   */
  signingInput(): Uint8Array {
    return this.#input;
  }

  /**
   * 署名または MAC を返す
   */
  signature(): Uint8Array {
    return this.#signatureBytes;
  }

  /**
   * protected ヘッダの CBOR バイト列を返す
   */
  protectedHeader(): Uint8Array {
    return this.#protectedBytes;
  }

  /**
   * クレームセットの CBOR バイト列を返す
   */
  payload(): Uint8Array {
    return this.#payloadBytes;
  }

  /**
   * COSE 形式の場合の unprotected ヘッダを返す
   */
  unprotectedHeader(): Array<[CborValue, CborValue]> {
    return this.#unprotected;
  }

  /**
   * トークンの署名 / MAC を検証する
   *
   * `options.expectedAlgorithm` が指定され、トークンの `alg` と一致しない場合は
   * `algorithmMismatch` で失敗する。
   */
  async verify(crypto: CoseCrypto, key: CoseKey, options: CatVerifyOptions = {}): Promise<void> {
    try {
      const algorithm = this.#tokenHeader.algorithm;
      if (algorithm === undefined) {
        throw new CatError("missingAlgorithm");
      }
      if (options.expectedAlgorithm !== undefined && options.expectedAlgorithm !== algorithm) {
        throw new CatError(
          "algorithmMismatch",
          `token algorithm ${algorithm} does not match expected ${options.expectedAlgorithm}`,
        );
      }
      if (options.expectedType !== undefined) {
        const actual =
          this.#tokenHeader.typ?.type === "textString" ? this.#tokenHeader.typ.value : undefined;
        if (actual !== options.expectedType) {
          throw new CatError("typeMismatch");
        }
      }
      await crypto.verify(algorithm, key, this.#input, this.#signatureBytes);
    } catch (error) {
      throw toCatError(error);
    }
  }
}

/**
 * CAT のトークンを作るビルダー
 *
 * 発行 (署名) には `CoseCrypto` の実装と秘密鍵が必要である。
 */
export interface CatTokenBuilderOptions {
  /** 発行するクレームセット */
  claims?: CatClaims;
  /** protected ヘッダに置く鍵識別子 (`kid`) */
  keyId?: CoseKeyId;
  /** COSE ヘッダの `typ`。未指定の場合は `"CAT"` を使う */
  typ?: string;
  /** 署名アルゴリズム。未指定の場合は鍵の種別から決める */
  algorithm?: Algorithm;
}

export class CatTokenBuilder {
  /** 発行するクレームセット */
  claims: CatClaims;
  /** protected ヘッダに置く鍵識別子 (`kid`)。未指定の場合は置かない */
  keyIdentifier: CoseKeyId | undefined;
  /** COSE ヘッダの `typ`。未指定の場合は `"CAT"` を使う */
  typeHeader: string | undefined;
  /** 署名アルゴリズム。未指定の場合は鍵の種別から決める */
  signingAlgorithm: Algorithm | undefined;

  constructor(options: CatTokenBuilderOptions = {}) {
    this.claims = options.claims ?? createCatClaims();
    this.keyIdentifier = options.keyId;
    this.typeHeader = options.typ;
    this.signingAlgorithm = options.algorithm;
  }

  /** `iss` を設定する */
  issuer(issuer: string): this {
    this.claims.issuer = issuer;
    return this;
  }

  /** `sub` を設定する */
  subject(subject: string): this {
    this.claims.subject = subject;
    return this;
  }

  /** `aud` を追加する */
  audience(audience: string): this {
    this.claims.audience.push(audience);
    return this;
  }

  /** `exp` (UNIX 秒) を設定する */
  expiration(expiration: number): this {
    this.claims.expiration = expiration;
    return this;
  }

  /** `nbf` (UNIX 秒) を設定する */
  notBefore(notBefore: number): this {
    this.claims.notBefore = notBefore;
    return this;
  }

  /** `iat` (UNIX 秒) を設定する */
  issuedAt(issuedAt: number): this {
    this.claims.issuedAt = issuedAt;
    return this;
  }

  /** `cti` をバイト文字列として設定する */
  cwtId(cwtId: Uint8Array): this {
    this.claims.cwtId = cwtId;
    return this;
  }

  /** `moqt` クレームを設定する */
  moqt(moqt: MoqtClaim): this {
    this.claims.moqt = moqt;
    return this;
  }

  /** `moqt-reval` (再検証間隔、秒) を設定する */
  moqtReval(seconds: number): this {
    this.claims.moqtReval = seconds;
    return this;
  }

  /** `cnf` の `jkt` を IANA 登録の confirmation key 323 で設定する */
  jwkThumbprint(thumbprint: Uint8Array): this {
    this.ensureConfirmation().jwkThumbprint = thumbprint;
    return this;
  }

  /** `cnf` の `jkt` を draft-ietf-moq-c4m-01 のベクタが使う key 3 で設定する */
  c4mDraftJwkThumbprint(thumbprint: Uint8Array): this {
    this.ensureConfirmation().c4mDraftJwkThumbprint = thumbprint;
    return this;
  }

  /** `catdpop` を設定する */
  catdpop(windowSeconds: number, honorJti: boolean): this {
    this.claims.catdpop = createCatDpop(windowSeconds, honorJti);
    return this;
  }

  /**
   * 任意のクレームを追加する
   *
   * 型付きフィールドを持つ claim key (`iss` / `moqt` / `catdpop` など) には専用の
   * 設定メソッドを使うこと。ここに型付きキーを渡した場合は、型付きフィールドの
   * 設定有無にかかわらずエンコード時に `duplicateClaim` で失敗する。
   */
  claim(key: number, value: CborValue): this {
    this.claims.raw.push([cborInteger(key), value]);
    return this;
  }

  /** `kid` を設定する */
  keyId(keyId: CoseKeyId): this {
    this.keyIdentifier = keyId;
    return this;
  }

  /** `typ` を設定する */
  typ(typ: string): this {
    this.typeHeader = typ;
    return this;
  }

  /** 署名アルゴリズムを設定する */
  algorithm(algorithm: Algorithm): this {
    this.signingAlgorithm = algorithm;
    return this;
  }

  /**
   * compact 形式 (draft-ietf-moq-c4m-01 付録 A) のトークンを発行する
   *
   * HMAC-SHA256 のアルゴリズム識別子は RFC 9053 の HMAC 256/256 (5) を使う。
   * ドラフト付録 A のベクタは -4 を使うが、IANA の COSE Algorithms レジストリでは
   * -4 は A192KW であり発行には使わない (検証は `C4M_DRAFT_HMAC_SHA256_ALGORITHM_ID`
   * も HMAC-SHA256 として受理する)。
   */
  async buildCompact(crypto: CoseCrypto, key: CoseKey): Promise<string> {
    try {
      const algorithm = this.signingAlgorithm ?? defaultSigningAlgorithm(key);
      const protectedBytes = this.encodeProtectedHeaderBytes(algorithmIdentifier(algorithm));
      const payloadBytes = encodeCbor(encodeCatClaims(this.claims));
      const protectedText = encodeBase64Url(protectedBytes);
      const payloadText = encodeBase64Url(payloadBytes);
      const signingInput = `${protectedText}.${payloadText}`;
      const signature = await crypto.sign(algorithm, key, TEXT_ENCODER.encode(signingInput));
      return `${signingInput}.${encodeBase64Url(signature)}`;
    } catch (error) {
      throw toCatError(error);
    }
  }

  /**
   * COSE 形式 (CWT + COSE_Sign1 / COSE_Mac0) のトークンを発行する
   *
   * CWT タグ (61) と COSE タグ (17 / 18) を付与する。
   */
  async buildCose(crypto: CoseCrypto, key: CoseKey): Promise<Uint8Array> {
    return this.buildCoseWith(crypto, key, DEFAULT_COSE_ENCODING_OPTIONS);
  }

  /**
   * タグの付与を指定して COSE 形式のトークンを発行する
   */
  async buildCoseWith(
    crypto: CoseCrypto,
    key: CoseKey,
    options: CoseEncodingOptions,
  ): Promise<Uint8Array> {
    try {
      const algorithm = this.signingAlgorithm ?? defaultSigningAlgorithm(key);
      const protectedBytes = this.encodeProtectedHeaderBytes(algorithmIdentifier(algorithm));
      const payloadBytes = encodeCbor(encodeCatClaims(this.claims));
      let message: CoseMessage;
      if (algorithmIsMac(algorithm)) {
        message = {
          type: "mac0",
          mac0: {
            protected: protectedBytes,
            unprotected: [],
            payload: payloadBytes,
            tag: new Uint8Array(0),
            coseTagged: options.coseTag,
            cwtTagged: options.cwtTag,
          },
        };
      } else {
        message = {
          type: "sign1",
          sign1: {
            protected: protectedBytes,
            unprotected: [],
            payload: payloadBytes,
            signature: new Uint8Array(0),
            coseTagged: options.coseTag,
            cwtTagged: options.cwtTag,
          },
        };
      }
      const signingInput = coseMessageSigningInput(message);
      const signature = await crypto.sign(algorithm, key, signingInput);
      if (message.type === "mac0") {
        message.mac0.tag = signature;
      } else {
        message.sign1.signature = signature;
      }
      return encodeCoseMessage(message, options);
    } catch (error) {
      throw toCatError(error);
    }
  }

  /**
   * `cnf` を取得する (無ければ作る)
   */
  private ensureConfirmation(): Confirmation {
    const existing = this.claims.confirmation;
    if (existing !== undefined) {
      return existing;
    }
    const confirmation = createConfirmation();
    this.claims.confirmation = confirmation;
    return confirmation;
  }

  /**
   * protected ヘッダをエンコードする
   */
  private encodeProtectedHeaderBytes(algorithmIdentifierValue: number): Uint8Array {
    const entries: Array<[CborValue, CborValue]> = [
      [cborInteger(HEADER_ALGORITHM), cborInteger(algorithmIdentifierValue)],
      [cborInteger(HEADER_TYPE), cborTextString(this.typeHeader ?? CAT_CONTENT_TYPE)],
    ];
    if (this.keyIdentifier !== undefined) {
      const value =
        this.keyIdentifier.type === "bytes"
          ? cborByteString(this.keyIdentifier.value)
          : cborTextString(this.keyIdentifier.value);
      entries.push([cborInteger(HEADER_KEY_ID), value]);
    }
    return encodeCbor(cborMap(entries));
  }
}

/**
 * CAT のエラー
 */
export type CatErrorCode =
  | "cbor"
  | "cose"
  | "c4m"
  | "crypto"
  | "invalidBase64"
  | "invalidTokenFormat"
  | "unexpectedType"
  | "duplicateClaim"
  | "missingAlgorithm"
  | "typeMismatch"
  | "algorithmMismatch"
  | "invalidAuthTokenType"
  | "detachedPayload"
  | "nonFiniteNumber";

export class CatError extends Error {
  readonly code: CatErrorCode;
  readonly detail: string | number | bigint | undefined;

  constructor(code: CatErrorCode, detail?: string | number | bigint, options?: ErrorOptions) {
    super(buildCatErrorMessage(code, detail, options?.cause), options);
    this.name = "CatError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * エラーコードから英語のメッセージを組み立てる
 */
function buildCatErrorMessage(
  code: CatErrorCode,
  detail: string | number | bigint | undefined,
  cause: unknown,
): string {
  const causeMessage = cause instanceof Error ? cause.message : undefined;
  switch (code) {
    case "cbor":
      return `CBOR error: ${String(causeMessage ?? detail ?? "")}`;
    case "cose":
      return `COSE error: ${String(causeMessage ?? detail ?? "")}`;
    case "c4m":
      return `C4M claim error: ${String(causeMessage ?? detail ?? "")}`;
    case "crypto":
      return `crypto error: ${String(causeMessage ?? detail ?? "")}`;
    case "invalidBase64":
      return `invalid base64url encoding: ${String(causeMessage ?? detail ?? "")}`;
    case "invalidTokenFormat":
      return `invalid CAT token format: ${String(detail ?? "")}`;
    case "unexpectedType":
      return `expected ${String(detail)}`;
    case "duplicateClaim":
      return `duplicate claim key: ${String(detail)}`;
    case "missingAlgorithm":
      return "COSE header has no alg parameter";
    case "typeMismatch":
      return "token typ does not match the expected type";
    case "algorithmMismatch":
      return String(detail);
    case "invalidAuthTokenType":
      return `unsupported MOQT auth token type: ${String(detail)}`;
    case "detachedPayload":
      return "detached payload is not supported";
    case "nonFiniteNumber":
      return `${String(detail)} must be finite`;
    default:
      return unreachableValue(code);
  }
}

/**
 * 下位モジュールのエラーを CAT のエラーへ変換する
 *
 * すでに `CatError` の場合はそのまま返す。
 */
function toCatError(error: unknown): CatError {
  if (error instanceof CatError) {
    return error;
  }
  if (error instanceof CborError) {
    return new CatError("cbor", undefined, { cause: error });
  }
  if (error instanceof CoseError) {
    return new CatError("cose", undefined, { cause: error });
  }
  if (error instanceof C4mError) {
    return new CatError("c4m", undefined, { cause: error });
  }
  if (error instanceof CryptoError) {
    return new CatError("crypto", undefined, { cause: error });
  }
  if (error instanceof Base64DecodeError) {
    return new CatError("invalidBase64", undefined, { cause: error });
  }
  return new CatError("invalidTokenFormat", error instanceof Error ? error.message : String(error));
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * UTF-8 として読める場合だけテキストを返す
 */
function decodeUtf8OrUndefined(bytes: Uint8Array): string | undefined {
  try {
    return TEXT_DECODER.decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * 文字列中に指定した文字が現れる回数を返す
 */
function countOccurrences(text: string, character: string): number {
  let count = 0;
  for (const value of text) {
    if (value === character) {
      count += 1;
    }
  }
  return count;
}
