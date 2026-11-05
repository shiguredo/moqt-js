/**
 * CAT (Common Access Token) のクレームとトークン
 *
 * CTA-5007-B の CAT を CWT (RFC 8392) のクレームとして扱い、draft-ietf-moq-c4m-02
 * の `moqt` / `moqt-reval` を加えたトークンの発行と検証を提供する。
 *
 * 直列化は 2 種類を扱う。
 *
 * - COSE: CWT タグ 61 (任意) + COSE_Sign1 (タグ 18) / COSE_Mac0 (タグ 17)。
 *   RFC 8392 / RFC 9052 の形式で、署名対象は `Sig_structure` / `MAC_structure`
 *   である。draft-ietf-moq-c4m-02 の Token Type 1 (CAT) の一次ワイヤ形式は
 *   こちらであり、付録 A.3〜A.7 のベクタは COSE タグ 17 / 18 を持つ完全な
 *   COSE 構造を使う
 * - compact: `base64url(protected).base64url(claims).base64url(signature)`。
 *   旧 C4M 01 付録 A のベクタが使っていた汎用の旧形式 helper であり、C4M 02 の
 *   Token Type 1 のワイヤ形式ではない。署名対象は ASCII の `protected.claims` で
 *   ある。新規の発行には COSE を使う
 *
 * CTA-5007-B 本体は有償仕様のため、確定したクレームキーは IANA の CWT Claims
 * レジストリと IANA の CWT Confirmation Methods レジストリに従う。`moqt` /
 * `moqt-reval` の claim key は draft-ietf-moq-c4m-02 Section 8 でも TBD のため
 * 固定値も暗黙の既定値も持たず、呼び出し側が `C4mClaimLabels` で明示する。
 *
 * `cnf` は ckt (confirmation key 5) と jkt (confirmation key 323) の値を保持する。
 * DPoP proof の作成 / 送信 / 検証は行わないため、`cnf` を持つトークンを受理しても、
 * proof を検証して鍵の束縛を確認するまで DPoP の認証・検証が完了したとは扱わない。
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
  cborAsInteger,
  cborAsNumber,
  cborAsText,
  cborByteString,
  cborInteger,
  cborMap,
  cborTextString,
  decodeCbor,
  encodeCbor,
} from "./cbor";
import { findDuplicateMapKey, hasDuplicateMapKeys } from "./cborMapKeys";
import { resolveClaimLabels as resolveClaimLabelsResult } from "./claimLabels";
import {
  type Algorithm,
  type CoseEncodingOptions,
  CoseError,
  type CoseHeader,
  type CoseKeyId,
  type CoseMessage,
  DEFAULT_COSE_ENCODING_OPTIONS,
  algorithmIdentifier,
  algorithmIsMac,
  coseMessageHeader,
  coseMessagePayload,
  coseMessageSigningInput,
  createCoseHeader,
  decodeCoseMessage,
  decodeProtectedHeader,
  encodeCoseHeader,
  encodeCoseMessage,
} from "./cose";
import { type CoseCrypto, type CoseKey, CryptoError, defaultSigningAlgorithm } from "./crypto";
import {
  C4mError,
  type C4mClaimLabels,
  type CatDpop,
  type MoqtAction,
  type MoqtClaim,
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
 * 実装が型付きで解釈する claim key
 *
 * `raw` に置いた場合はエンコード時に拒否する対象でもある。`moqt` /
 * `moqt-reval` の label は設定可能なため、ここには含めない。
 */
const FIXED_TYPED_CLAIM_KEYS: ReadonlySet<number> = new Set([
  CLAIM_ISSUER,
  CLAIM_SUBJECT,
  CLAIM_AUDIENCE,
  CLAIM_EXPIRATION,
  CLAIM_NOT_BEFORE,
  CLAIM_ISSUED_AT,
  CLAIM_CWT_ID,
  CLAIM_CONFIRMATION,
  CLAIM_CAT_DPOP,
]);

/**
 * claim label 設定を検証し、呼び出し元から独立したコピーを返す
 *
 * 実際の検証は内部モジュール (`./claimLabels`) が行う。`./claimLabels` は
 * `CatError` に依存しない結果型を返すため、ここで CAT のエラーへ変換する。
 */
function resolveClaimLabels(claimLabels: C4mClaimLabels): C4mClaimLabels {
  const resolution = resolveClaimLabelsResult(claimLabels);
  if (!resolution.ok) {
    throw new CatError("invalidClaimLabels", resolution.message);
  }
  return resolution.labels;
}

/**
 * `cnf` の `ckt` (COSE Key Thumbprint) の confirmation key
 *
 * IANA の CWT Confirmation Methods レジストリに登録された値 (5)。
 * draft-ietf-moq-c4m-02 Section 4.1 は DPoP の鍵束縛に `ckt` を推奨し、relay は
 * MUST support とする。値は COSE Key Thumbprint (RFC 9679) である。
 */
export const CONFIRMATION_COSE_KEY_THUMBPRINT = 5;

/**
 * `cnf` の `jkt` (JWK SHA-256 Thumbprint) の confirmation key
 *
 * IANA の CWT Confirmation Methods レジストリに CTA が登録した値 (323)。
 * draft-ietf-moq-c4m-02 Section 4.1 は既存の CAT issuer との互換用に定義し、
 * relay は SHOULD support とする。
 */
export const CONFIRMATION_JWK_THUMBPRINT = 323;

/** MOQT の Auth Token Type (CAT) (draft-ietf-moq-c4m-02 Section 8.2.1) */
export const MOQT_AUTH_TOKEN_TYPE_CAT = 1n;

/**
 * CAT の COSE ヘッダの `typ` の値
 *
 * draft-ietf-moq-c4m-02 付録 A.3 のテストベクタが protected ヘッダに置く値。
 * `CatVerifyOptions.expectedType` に渡して検証できる。
 */
export const CAT_CONTENT_TYPE = "CAT";

/**
 * CAT のトークン直列化
 */
export type TokenFormat = "compact" | "coseSign1" | "coseMac0";

/**
 * `cnf` (confirmation) クレーム (RFC 8747 / CTA-5007-B / draft-ietf-moq-c4m-02 Section 4.1)
 *
 * draft-ietf-moq-c4m-02 Section 4.1 は、DPoP で鍵を束縛するときに COSE Key
 * Thumbprint を使う `ckt` (confirmation key 5) を推奨し、既存の CAT issuer との
 * 互換用に JWK SHA-256 Thumbprint を使う `jkt` (confirmation key 323) も定義する。
 * この型は両者を別のフィールドとして保持し、どちらかを他方へ読み替えない。
 *
 * IANA の CWT Confirmation Methods レジストリでは 3 が `kid` (RFC 8747 Section
 * 3.4) である。C4M 02 の `jkt` ではないため、key 3 は `raw` に保持し、`jkt` や
 * サムプリントとして解釈しない。
 *
 * この型は `cnf` の値を保持するだけで、DPoP proof の作成 / 送信 / 検証は行わない。
 * `cnf` を持つトークンを受理しても、proof を検証して鍵の束縛を確認するまで
 * DPoP の認証・検証が完了したとは扱わないこと。`authorizeCatClaims` は
 * `dpopProofVerified: true` を明示されない限り、`cnf` を持つトークンを認可しない。
 */
export interface Confirmation {
  /**
   * `ckt` (confirmation key 5) の値。COSE Key Thumbprint (RFC 9679)
   *
   * C4M 02 Section 4.1 が推奨する confirmation method である。このライブラリは
   * `ckt` を算出しない。COSE Key Thumbprint は JWK サムプリント (RFC 7638) とは
   * 異なる計算であり、`jwkThumbprintSha256` で代用してはならない。算出を公開する
   * 場合は RFC 9679 の一次資料と固定ベクタで別途検証すること。
   */
  ckt: Uint8Array | undefined;
  /**
   * `jkt` (confirmation key 323) の値。JWK SHA-256 Thumbprint (RFC 7638)
   *
   * 既存の CAT issuer との互換用の confirmation method である。key 3
   * (`kid`) をこのフィールドへ読み替えない。
   */
  jkt: Uint8Array | undefined;
  /** 型付きで解釈しなかった confirmation の値 */
  raw: Array<[CborValue, CborValue]>;
}

/**
 * 空の `cnf` を作る
 */
export function createConfirmation(): Confirmation {
  return { ckt: undefined, jkt: undefined, raw: [] };
}

/**
 * `cnf` をデコードする
 *
 * `ckt` (confirmation key 5) と `jkt` (confirmation key 323) だけを型付きで解釈し、
 * それ以外の key は意味を捏造せず `raw` に保持する。IANA で `kid` である key 3 も
 * `raw` に残る。
 *
 * 同じ key を持つマップは CBOR のマップとして不正である (RFC 8949 Section 5.6)。
 * この関数は `CborValue` を直接受ける公開 API のため、CBOR 層を通らない手組みの
 * マップでも重複を拒否する。判定はワイヤ経路と同じく、キーを正規化して決定論的に
 * エンコードしたバイト列の比較で行う (O(n log n))。
 *
 * キーが予約済みの simple value や深さ上限の超過などでエンコードできない場合も、
 * `CborError` として拒否する (fail-closed)。そのようなキーを重複判定から黙って
 * 除外すると、同じキーの重複が検査をすり抜けて `raw` に残るためである。
 */
export function decodeConfirmation(value: CborValue): Confirmation {
  const entries = cborMapEntries(value, "cnf");
  if (hasDuplicateMapKeys(entries, encodeCbor)) {
    throw new CatError("duplicateConfirmation");
  }
  const confirmation = createConfirmation();
  for (const [key, entry] of entries) {
    // 2^63 以上も CBOR の整数ではあるため、cborAsInt64 ではなく cborAsInteger で
    // 整数判定する。i64 の範囲外の label は未知の confirmation method として raw に残す
    const label = cborAsInteger(key);
    if (label === BigInt(CONFIRMATION_COSE_KEY_THUMBPRINT)) {
      const bytes = cborAsBytes(entry);
      if (bytes === undefined) {
        throw new CatError("unexpectedType", "ckt");
      }
      confirmation.ckt = bytes;
      continue;
    }
    if (label === BigInt(CONFIRMATION_JWK_THUMBPRINT)) {
      const bytes = cborAsBytes(entry);
      if (bytes === undefined) {
        throw new CatError("unexpectedType", "jkt");
      }
      confirmation.jkt = bytes;
      continue;
    }
    confirmation.raw.push([key, entry]);
  }
  return confirmation;
}

/**
 * `cnf` をエンコードする
 *
 * `ckt` / `jkt` と `raw` のエントリをそのまま並べる。`raw` に型付きの key (5 / 323)
 * を置いた場合は、デコード時に型付きフィールドと raw のどちらが使われるかが
 * 曖昧になるため拒否する。`raw` 同士で同じ key が重複する場合も、デコード側と
 * 同じ判定で拒否する。
 */
export function encodeConfirmation(confirmation: Confirmation): CborValue {
  const entries: Array<[CborValue, CborValue]> = [];
  if (confirmation.ckt !== undefined) {
    entries.push([cborInteger(CONFIRMATION_COSE_KEY_THUMBPRINT), cborByteString(confirmation.ckt)]);
  }
  if (confirmation.jkt !== undefined) {
    entries.push([cborInteger(CONFIRMATION_JWK_THUMBPRINT), cborByteString(confirmation.jkt)]);
  }
  for (const [key, value] of confirmation.raw) {
    const label = cborAsInteger(key);
    if (
      label === BigInt(CONFIRMATION_COSE_KEY_THUMBPRINT) ||
      label === BigInt(CONFIRMATION_JWK_THUMBPRINT)
    ) {
      throw new CatError("duplicateConfirmation");
    }
    entries.push([key, value]);
  }
  // raw 同士の重複は CBOR のマップとして不正である (RFC 8949 Section 5.6)。デコード
  // 側と同じ判定を使い、encodeCbor の duplicateMapKey ではなく CAT のエラーにする
  const duplicateKey = findDuplicateMapKey(entries, encodeCbor);
  if (duplicateKey !== undefined) {
    throw new CatError("duplicateConfirmation");
  }
  return cborMap(entries);
}

/**
 * `cnf` の `ckt` (confirmation key 5) の値を返す
 *
 * C4M 02 Section 4.1 の `ckt` は COSE Key Thumbprint (RFC 9679) である。値の算出は
 * 行わない。JWK サムプリント (RFC 7638) の helper で代用してはならない。
 */
export function confirmationCkt(confirmation: Confirmation): Uint8Array | undefined {
  return confirmation.ckt;
}

/**
 * `cnf` の `jkt` (confirmation key 323) の値を返す
 *
 * C4M 02 Section 4.1 の `jkt` は JWK SHA-256 Thumbprint (RFC 7638) である。
 * IANA で `kid` である key 3 は `jkt` ではないため、`raw` に保持した key 3 を
 * この関数の結果へ読み替えない。
 */
export function confirmationJkt(confirmation: Confirmation): Uint8Array | undefined {
  return confirmation.jkt;
}

/**
 * CAT のクレームセット (CWT のクレーム + CAT / C4M のクレーム)
 *
 * 型付きで解釈しないクレームは `raw` にそのまま保持する。`catv` / `catu` などの
 * CAT クレームは、このライブラリが C4M の認可に使う意味論を実装していないため、
 * 型付きで解釈せず raw に保持する。CWT のコア claim と、C4M の認可に必要な
 * `moqt` / `moqt-reval` / `catdpop`、DPoP の鍵束縛に使う `cnf` だけを型付きで
 * 解釈する。
 */
export interface CatClaims {
  /** `iss` */
  issuer: string | undefined;
  /** `sub` */
  subject: string | undefined;
  /** `aud`。単一のテキストと配列の両方を受ける */
  audience: string[];
  /** `exp` (UNIX 秒)。時刻がこの値以上になると期限切れである (RFC 7519 Section 4.1.4) */
  expiration: number | undefined;
  /** `nbf` (UNIX 秒)。時刻がこの値以上になると有効である (RFC 7519 Section 4.1.5) */
  notBefore: number | undefined;
  /** `iat` (UNIX 秒) */
  issuedAt: number | undefined;
  /** `cti`。バイト文字列とテキスト文字列の両方を受ける */
  cwtId: Uint8Array | undefined;
  /**
   * `cnf`。ckt (confirmation key 5) と jkt (confirmation key 323) を別々に保持する
   */
  confirmation: Confirmation | undefined;
  /** `moqt` (draft-ietf-moq-c4m-02 Section 2.1) */
  moqt: MoqtClaim | undefined;
  /**
   * `moqt-reval` (draft-ietf-moq-c4m-02 Section 2.2) の再検証間隔 (秒)
   *
   * このライブラリは再検証を行わない。`validateCatClaims` は既定
   * (`revalidationSupported: false`) で `moqt-reval` を持つトークンを拒否する。
   * 負の値も拒否する。
   */
  moqtReval: number | undefined;
  /** `catdpop` (CTA-5007-B Section 4.8 / draft-ietf-moq-c4m-02 Section 4.1) */
  catdpop: CatDpop | undefined;
  /**
   * 型付きで解釈しなかったクレーム
   *
   * 認可判断 (`authorizeCatClaims`) には使わない。RFC 8392 Section 3 の
   * 「理解できない claim は無視する」に従う。将来 Composite Claims
   * (`and` / `nor` / `crit`) に key が割り当てられた場合の扱いは
   * `authorizeCatClaims` の JSDoc を参照すること。
   */
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
 *
 * `moqt` / `moqt-reval` の key は claim label 設定で決まるため、固定 key の
 * 一覧に加えて設定値も照合する。
 */
function isTypedClaimKey(key: number, claimLabels: C4mClaimLabels): boolean {
  return (
    FIXED_TYPED_CLAIM_KEYS.has(key) || key === claimLabels.moqt || key === claimLabels.moqtReval
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
 * claim key のエラー詳細に載せる値を返す
 *
 * 整数キーはその値、テキストキーはその文字列を返す。呼び出し側は重複判定の前に
 * キーが整数かテキストであることを検証しているため、それ以外のキーは通常ここへ
 * 来ない。事前条件が破られた場合のフォールバックとしてキーの型名を返す。
 */
function claimKeyErrorDetail(key: CborValue): string | bigint {
  // 2^63 以上の整数 key も raw として受理するため、i64 に限定しない
  const keyInt = cborAsInteger(key);
  if (keyInt !== undefined) {
    return keyInt;
  }
  return key.type === "textString" ? key.value : key.type;
}

/**
 * クレームセットをデコードする
 *
 * `claimLabels` は `moqt` / `moqt-reval` の claim key である。暗黙の既定値は
 * 無く、未指定・不正型・範囲外・IANA 登録済み claim との衝突はデコードを始める
 * 前に `invalidClaimLabels` で拒否する (draft-ietf-moq-c4m-02 Section 8 は両
 * claim の key を TBD のままにしており、IANA に割り当てられていない)。
 *
 * claim key 0 は RFC 8392 Section 9.1.2 が RESERVED として予約しており、claim の
 * key として無効である。draft-ietf-moq-c4m-02 付録 A.6 も、未割当の複合クレームの
 * key をすべて 0 にしたベクタについて「0 は有効な claim key ではないため検証側は
 * これらの claim を parse できない」としている。そのため key 0 を持つ claim set は
 * `invalidClaimKey` で拒否する。
 *
 * 失敗は `CatError` で返す。`moqt` / `catdpop` クレームのデコードは C4M のエラー
 * (`C4mError`) を投げるため、ここで CAT のエラーへ揃える。
 */
export function decodeCatClaims(value: CborValue, claimLabels: C4mClaimLabels): CatClaims {
  const labels = resolveClaimLabels(claimLabels);
  try {
    return decodeCatClaimsCore(value, labels);
  } catch (error) {
    throw toCatError(error);
  }
}

/**
 * クレームセットをデコードする本体
 */
function decodeCatClaimsCore(value: CborValue, claimLabels: C4mClaimLabels): CatClaims {
  const entries = cborMapEntries(value, "claims");
  // CWT の claim key は整数またはテキスト文字列 (RFC 8392 Section 3)。
  // それ以外の型は意味を解釈できないため、重複判定より先に拒否する。重複判定は
  // キーを決定論的にエンコードして比較するため、キーが整数とテキストだけである
  // ことを確認した後に行う。整数は i64 に限らず CBOR の major type 0 / 1 全体を
  // 受理する (2^63 以上は未知の整数 key として raw に残す)
  for (const [key] of entries) {
    if (cborAsInteger(key) === undefined && key.type !== "textString") {
      throw new CatError("unexpectedType", "claim key");
    }
  }
  // 同じ key を持つマップは CBOR のマップとして不正である (RFC 8949 Section 5.6)。
  // この関数は `CborValue` を直接受ける公開 API のため、CBOR 層を通らない手組みの
  // マップでも重複を拒否する。後から来た値で先の値を黙って上書きしない。判定は
  // ワイヤ経路と同じく、キーを正規化して決定論的にエンコードしたバイト列の
  // 比較で行う (O(n log n))
  const duplicateKey = findDuplicateMapKey(entries, encodeCbor);
  if (duplicateKey !== undefined) {
    throw new CatError("duplicateClaim", claimKeyErrorDetail(duplicateKey));
  }
  const claims = createCatClaims();
  for (const [key, entry] of entries) {
    const keyInt = cborAsInteger(key);
    if (keyInt === undefined) {
      // 直前の検証で整数以外はテキスト文字列だけに絞られている
      claims.raw.push([key, entry]);
      continue;
    }
    // RFC 8392 Section 9.1.2 は claim key 0 を RESERVED として予約しており、
    // claim の key として使えない。draft-ietf-moq-c4m-02 付録 A.6 も、0 を
    // placeholder に使う複合クレームを検証側が parse できないとしている。
    // 未知の key として raw に退避すると、外側の moqt だけで認可が通る
    // fail-open の経路になるため、ここで明示的に拒否する
    if (keyInt === 0n) {
      throw new CatError("invalidClaimKey", keyInt);
    }
    // claim label は設定値で決まるため、固定 key の switch より先に判定する。
    // 設定値は検証済みの安全な整数なので BigInt で厳密に比較する
    if (keyInt === BigInt(claimLabels.moqt)) {
      claims.moqt = decodeMoqtClaim(entry);
      continue;
    }
    if (keyInt === BigInt(claimLabels.moqtReval)) {
      claims.moqtReval = finiteClaimNumber(entry, "moqt-reval");
      continue;
    }
    // 型付きの key は小さな正の整数だけであり、2^53 を超える key が型付きの
    // key へ丸められることはない。Number への変換は switch の照合だけに使う
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
          // CWT の cti はバイト文字列である (RFC 8392 Section 3.1.7)。テキスト
          // 文字列で書かれた値も、互換のために UTF-8 のバイト列として受ける
          claims.cwtId = TEXT_ENCODER.encode(entry.value);
        } else {
          throw new CatError("unexpectedType", "cti");
        }
        break;
      case CLAIM_CONFIRMATION:
        claims.confirmation = decodeConfirmation(entry);
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
 * `claimLabels` は `moqt` / `moqt-reval` の claim key である。デコードと同じ
 * 設定を使わないと、書いた claim を自分で読み戻せない。暗黙の既定値は無く、
 * 未指定・不正型・範囲外・IANA 登録済み claim との衝突はエンコードを始める前に
 * `invalidClaimLabels` で拒否する。
 *
 * 型付きフィールドを持つ claim key を `raw` に置いた場合は、型付きフィールドが
 * 未設定でもエラーを返す。整数でもテキスト文字列でもない claim key と、非有限値の
 * 数値クレームもエラーを返す (どちらもデコード側が拒否する入力である)。claim key
 * 0 は RFC 8392 Section 9.1.2 が RESERVED として予約しており claim の key として
 * 無効なので、`raw` に置いた場合も `invalidClaimKey` で拒否する。`raw` 同士で
 * 同じ claim key が重複する場合も、デコード側と同じ判定で `duplicateClaim` にする。
 *
 * デコードしたクレームを再エンコードすると表現が正規化される (`aud` の単一テキスト
 * は配列になり、`cti` のテキストはバイト文字列になり、整数値の浮動小数点数は整数に
 * なる)。
 */
export function encodeCatClaims(claims: CatClaims, claimLabels: C4mClaimLabels): CborValue {
  const labels = resolveClaimLabels(claimLabels);
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
    entries.push([cborInteger(labels.moqt), encodeMoqtClaim(claims.moqt)]);
  }
  if (claims.moqtReval !== undefined) {
    entries.push([
      cborInteger(labels.moqtReval),
      finiteNumberValue(claims.moqtReval, "moqt-reval"),
    ]);
  }
  if (claims.catdpop !== undefined) {
    entries.push([cborInteger(CLAIM_CAT_DPOP), encodeCatDpop(claims.catdpop)]);
  }
  for (const [key, value] of claims.raw) {
    // CWT の claim key は整数またはテキスト文字列 (RFC 8392 Section 3)。デコード側も
    // それ以外の型を拒否するため、エンコード側でも同じ規則で拒否する。整数は
    // i64 に限らず CBOR の major type 0 / 1 全体を受理する
    const keyInt = cborAsInteger(key);
    if (keyInt === undefined && key.type !== "textString") {
      throw new CatError("unexpectedType", "claim key");
    }
    // 0 は RFC 8392 Section 9.1.2 が RESERVED として予約しており、claim の key
    // として無効である。デコード側も拒否するため、エンコード側でも拒否する
    if (keyInt === 0n) {
      throw new CatError("invalidClaimKey", keyInt);
    }
    // 型付きフィールドを持つ claim key を raw に置くと、デコード時に型付き
    // フィールドと raw のどちらが使われるかが曖昧になる。値の型も検証できない
    // ため、設定の有無にかかわらず拒否する。型付きの key は小さい整数だけなので、
    // Number への変換で 2^53 を超える key が型付きの key と一致することはない
    if (keyInt !== undefined && isTypedClaimKey(Number(keyInt), labels)) {
      throw new CatError("duplicateClaim", claimKeyErrorDetail(key));
    }
    entries.push([key, value]);
  }
  // raw 同士の重複は CBOR のマップとして不正である (RFC 8949 Section 5.6)。デコード
  // 側と同じ判定を使い、encodeCbor の duplicateMapKey ではなく CAT のエラーにする
  const duplicateKey = findDuplicateMapKey(entries, encodeCbor);
  if (duplicateKey !== undefined) {
    throw new CatError("duplicateClaim", claimKeyErrorDetail(duplicateKey));
  }
  return cborMap(entries);
}

/**
 * 整数キーのクレームを取り出す
 *
 * 型付きフィールドとして解釈しなかったクレーム、および整数キーの未知のクレームを
 * 対象とする。トップレベルの claim key は i64 に限らないため、2^63 以上の key は
 * `bigint` で指定する。
 */
export function getCatClaim(claims: CatClaims, key: number | bigint): CborValue | undefined {
  const expectedKey = typeof key === "bigint" ? key : BigInt(key);
  return claims.raw.find(([entryKey]) => cborAsInteger(entryKey) === expectedKey)?.[1];
}

/**
 * `authorizeCatClaims` のオプション
 */
export interface CatAuthorizationOptions {
  /**
   * DPoP proof を検証済みかどうか
   *
   * 既定は false である。`cnf` (confirmation) を持つトークンは、この値が true の
   * 場合だけ認可する。draft-ietf-moq-c4m-02 Section 4.1 は「有効な DPoP proof が
   * 伴わない限り、MOQT アクションに対して cnf クレームを含むトークンを受け入れては
   * ならない (MUST NOT)」と定めている。
   *
   * このライブラリは DPoP proof の作成・送信・検証を行わない。呼び出し側が proof を
   * 検証し、`cnf` の鍵との束縛を確認した場合だけ true を渡すこと。true は呼び出し
   * 側の表明であり、この関数自身は何も検証しない。
   */
  dpopProofVerified?: boolean;
}

/**
 * `moqt` クレームによりアクションが認可されるかどうかを返す
 *
 * 判定に使うのは `claims.moqt` だけで、`claims.raw` に保持した未知のクレームは
 * 認可判断に使わない。RFC 8392 Section 3 は「理解できない claim は無視する」と
 * 定めており、この挙動はそれに従う。`moqt` クレームの map 内の未知 key は
 * draft-ietf-moq-c4m-02 Section 2.1.1 が fail-closed を求めており、
 * `decodeMoqtClaim` が `C4mError` で拒否する。
 *
 * `cnf` (confirmation) を持つトークンは、`options.dpopProofVerified` が true の
 * 場合だけ認可する。draft-ietf-moq-c4m-02 Section 4.1 は「有効な DPoP proof が
 * 伴わない限り、MOQT アクションに対して cnf クレームを含むトークンを受け入れては
 * ならない (MUST NOT)」と定めている。既定は false であり、このライブラリは DPoP
 * proof の作成・送信・検証を行わない。呼び出し側が proof を検証して鍵の束縛を
 * 確認した場合だけ true を渡すこと。`cnf` が ckt / jkt を持たない場合も同じく
 * 拒否する (fail-closed)。
 *
 * ただし、将来 Composite Claims (`and` / `nor` / `crit`) に claim key が割り当て
 * られた場合、未知の raw claim を無視すると `and` / `nor` / `crit` の制約を
 * 迂回して外側の `moqt` だけで認可が通る過剰認可になり得る。key が割り当てられた
 * 時点で、それらの key を持つ claim を拒否する fail-closed へ変更する必要がある。
 *
 * `moqt` クレームが無い場合は常に false を返す (Section 2 の「明示的に許可された
 * アクション以外はブロックする」)。
 */
export function authorizeCatClaims(
  claims: CatClaims,
  action: MoqtAction,
  namespace: Uint8Array[],
  trackName: Uint8Array,
  options: CatAuthorizationOptions = {},
): boolean {
  // cnf を持つトークンは DPoP proof の検証が完了するまで認可しない。proof の
  // 検証はこのライブラリの外で行われるため、呼び出し側の明示的な表明だけを受け付ける
  if (claims.confirmation !== undefined && options.dpopProofVerified !== true) {
    return false;
  }
  if (claims.moqt === undefined) {
    return false;
  }
  return moqtClaimAuthorize(claims.moqt, action, namespace, trackName);
}

/**
 * クレームの検証オプション
 *
 * 未指定の値は既定値 (現在時刻 0 秒、許容ずれ 0 秒、期待する発行者 / 宛先なし、
 * 再検証なし) を使う。
 */
export interface CatClaimValidationOptions {
  /**
   * 検証に使う現在時刻 (UNIX 秒)
   *
   * 省略すると 0 (1970-01-01T00:00:00Z) 基準になる。`exp` だけを持つトークンは
   * 1970 年時点では期限切れでないため、省略すると期限切れトークンを通してしまう。
   * 呼び出し側で現在時刻を明示して渡すこと。
   */
  referenceTimeSeconds?: number;
  /** `exp` / `nbf` に許容するずれ (秒) */
  clockToleranceSeconds?: number;
  /** 期待する `iss` の一覧。空の場合は検証しない */
  expectedIssuers?: string[];
  /** 期待する `aud` の一覧。空の場合は検証しない */
  expectedAudiences?: string[];
  /**
   * 継続中のストリームでトークンを再検証できるかどうか
   *
   * 既定は false である。このライブラリは再検証を行わないため、false の場合は
   * `moqt-reval` を持つトークンを拒否する (draft-ietf-moq-c4m-02 Section 2.2 の
   * 「再検証できない受信者は moqt-reval 付きトークンをすべて拒否しなければならない
   * (MUST reject)」)。呼び出し側が `moqt-reval` の間隔でトークンを再検証する
   * 仕組みを持っている場合だけ true を渡す。
   */
  revalidationSupported?: boolean;
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
  | "nonFiniteClaim"
  | "invalidCatDpopWindow"
  | "invalidCatDpopHonorJti"
  | "invalidMoqtReval"
  | "revalidationNotSupported";

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
    case "invalidCatDpopWindow":
      return `catdpop window must be non-negative: ${String(detail)}`;
    case "invalidCatDpopHonorJti":
      return `catdpop honor jti must be a boolean: ${String(detail)}`;
    case "invalidMoqtReval":
      return `moqt-reval must be a non-negative number: ${String(detail)}`;
    case "revalidationNotSupported":
      return "token has a moqt-reval claim but revalidation is not supported";
    default:
      return unreachableValue(code);
  }
}

/**
 * 時刻と期待値に対するクレームの検証を行う
 *
 * 署名の検証は `CatToken.verify` が行う。ここでは `exp` / `nbf` / `iss` / `aud` を
 * 検証し、加えて現在時刻 / 許容ずれの有限性、手組みで入り得る非有限の数値
 * クレーム、`catdpop` の値域を拒否する。
 *
 * `exp` の処理は RFC 8392 Section 3.1.4 が RFC 7519 Section 4.1.4 に委ねており、
 * 同節は「expiration time の時点またはそれ以降は受理してはならない (MUST NOT
 * accept ... on or after)」と定める。そのため `referenceTimeSeconds` が `exp` と
 * 等しい場合も期限切れである。`clockToleranceSeconds` は `exp` に加算し、許容
 * ずれの分だけ有効期間を延ばす。
 *
 * `nbf` は RFC 7519 Section 4.1.5 の「not-before の時点またはそれ以降なら受理
 * してよい (MUST be after or equal to)」に従い、`referenceTimeSeconds` が `nbf`
 * と等しい場合は有効である。
 *
 * `moqt-reval` は draft-ietf-moq-c4m-02 Section 2.2 に従う。再検証できない受信者は
 * `moqt-reval` 付きトークンをすべて拒否しなければならない (MUST reject)。この
 * ライブラリは再検証を行わないため、`options.revalidationSupported` が true の
 * 場合だけ受理する。負の再検証間隔は、再検証をサポートしていても拒否する。
 *
 * `options.referenceTimeSeconds` を省略すると 0 (1970 年) 基準になり、期限切れ
 * トークンを通すため、現在時刻を明示して渡すこと。
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
  // draft-ietf-moq-c4m-02 Section 2.2: moqt-reval-value は再検証の間隔 (秒) であり、
  // 再検証できない受信者は moqt-reval 付きトークンをすべて拒否しなければならない
  // (MUST reject)。このライブラリは再検証を行わないため、既定では拒否する。
  // 負の間隔は再検証をサポートしていても意味を持たないため拒否する
  if (claims.moqtReval !== undefined) {
    if (claims.moqtReval < 0) {
      throw new ClaimValidationError("invalidMoqtReval", String(claims.moqtReval));
    }
    if (options.revalidationSupported !== true) {
      throw new ClaimValidationError("revalidationNotSupported");
    }
  }
  // catdpop の値域は decodeCatDpop / encodeCatDpop と同じ規則で検証する。
  // CatDpop のフィールドは公開のため、デコード以外の経路で負のウィンドウや
  // boolean 以外の honorJti が入り得る
  if (claims.catdpop !== undefined) {
    if (claims.catdpop.windowSeconds !== undefined && claims.catdpop.windowSeconds < 0) {
      throw new ClaimValidationError("invalidCatDpopWindow", String(claims.catdpop.windowSeconds));
    }
    // honorJti は型の上では boolean | undefined だが、JavaScript からは任意の値が
    // 入り得る。unknown へ広げて実行時の型を検証する。エラー詳細には実際の値を
    // 残す (String だけではオブジェクトが [object Object] になる)
    const honorJti: unknown = claims.catdpop.honorJti;
    if (honorJti !== undefined && typeof honorJti !== "boolean") {
      const detail =
        typeof honorJti === "string" || typeof honorJti === "number"
          ? String(honorJti)
          : typeof honorJti;
      throw new ClaimValidationError("invalidCatDpopHonorJti", detail);
    }
  }
  if (
    claims.expiration !== undefined &&
    referenceTimeSeconds >= claims.expiration + clockToleranceSeconds
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
  readonly #payloadBytes: Uint8Array;
  readonly #signatureBytes: Uint8Array;
  readonly #input: Uint8Array;
  readonly #tokenHeader: CoseHeader;
  readonly #tokenClaims: CatClaims;
  readonly #claimLabels: C4mClaimLabels;

  private constructor(
    tokenFormat: TokenFormat,
    raw: Uint8Array,
    protectedBytes: Uint8Array,
    payloadBytes: Uint8Array,
    signatureBytes: Uint8Array,
    input: Uint8Array,
    tokenHeader: CoseHeader,
    tokenClaims: CatClaims,
    claimLabels: C4mClaimLabels,
  ) {
    this.#tokenFormat = tokenFormat;
    // 呼び出し側が渡した配列を後から変更してもトークンの内容が変わらないようにコピーする
    this.#raw = raw.slice();
    this.#protectedBytes = protectedBytes;
    this.#payloadBytes = payloadBytes;
    this.#signatureBytes = signatureBytes;
    this.#input = input;
    this.#tokenHeader = tokenHeader;
    this.#tokenClaims = tokenClaims;
    // claims を解釈した claim label 設定もコピーして保持する。呼び出し元が設定元の
    // オブジェクトを後から変更しても、このトークンの解釈は変わらない
    this.#claimLabels = claimLabels;
  }

  /**
   * トークンをデコードする
   *
   * `.` で区切られた 3 分割の compact 形式 (旧 C4M 01 付録 A の汎用 helper)、
   * CWT / COSE 形式の CBOR、COSE 形式を base64url または標準 Base64 で包んだ
   * テキストの順に判別する。C4M 02 の Token Type 1 の一次ワイヤ形式は COSE で
   * あり、compact はその形式ではない。標準 Base64 は URL に埋め込む場合の表現
   * (draft-ietf-moq-c4m-02 Section 2 / Section 5) である。
   *
   * `claimLabels` は `moqt` / `moqt-reval` の claim key である。暗黙の既定値は
   * 無く、未指定・不正型・範囲外・IANA 登録済み claim との衝突は入力の判別より先に
   * `invalidClaimLabels` で拒否する。
   */
  static decode(input: Uint8Array, claimLabels: C4mClaimLabels): CatToken {
    const labels = resolveClaimLabels(claimLabels);
    try {
      const text = decodeUtf8OrUndefined(input);
      if (text !== undefined && countOccurrences(text, ".") === 2) {
        return CatToken.decodeCompact(text, labels).withRaw(input);
      }
      let firstError: CatError;
      try {
        return CatToken.decodeCose(input, labels).withRaw(input);
      } catch (error) {
        firstError = toCatError(error);
      }
      if (text !== undefined) {
        const bytes = tryDecodeBase64OrUrl(text.trim());
        if (bytes !== undefined) {
          return CatToken.decodeCose(bytes, labels).withRaw(input);
        }
      }
      throw firstError;
    } catch (error) {
      throw toCatError(error);
    }
  }

  /**
   * compact 形式
   * (`base64url(protected).base64url(claims).base64url(signature)`) をデコードする
   *
   * `claimLabels` は `moqt` / `moqt-reval` の claim key であり、`decodeCatClaims`
   * と同じ検証を入口で行う。
   */
  static decodeCompact(text: string, claimLabels: C4mClaimLabels): CatToken {
    const labels = resolveClaimLabels(claimLabels);
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
      const claims = decodeCatClaims(decodeCbor(payloadBytes), labels);
      // 署名対象は base64url のままの protected と claims (付録 A のベクタ)
      const signingInput = TEXT_ENCODER.encode(`${protectedText}.${payloadText}`);
      return new CatToken(
        "compact",
        TEXT_ENCODER.encode(text),
        protectedBytes,
        payloadBytes,
        signatureBytes,
        signingInput,
        header,
        claims,
        labels,
      );
    } catch (error) {
      throw toCatError(error);
    }
  }

  /**
   * COSE 形式 (CBOR) をデコードする
   *
   * `claimLabels` は `moqt` / `moqt-reval` の claim key であり、`decodeCatClaims`
   * と同じ検証を入口で行う。
   */
  static decodeCose(bytes: Uint8Array, claimLabels: C4mClaimLabels): CatToken {
    const labels = resolveClaimLabels(claimLabels);
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
      const claims = decodeCatClaims(decodeCbor(payload), labels);
      const signingInput = coseMessageSigningInput(message);
      if (message.type === "sign1") {
        return new CatToken(
          "coseSign1",
          bytes,
          message.sign1.protected,
          payload,
          message.sign1.signature,
          signingInput,
          header,
          claims,
          labels,
        );
      }
      return new CatToken(
        "coseMac0",
        bytes,
        message.mac0.protected,
        payload,
        message.mac0.tag,
        signingInput,
        header,
        claims,
        labels,
      );
    } catch (error) {
      throw toCatError(error);
    }
  }

  /**
   * MOQT の Auth Token Type と Token Value からデコードする
   *
   * draft-ietf-moq-c4m-02 Section 8.2.1 の Token Type が 0x01 (CAT) 以外の場合は
   * エラーを返す。Token Type 0x01 の Token Value は CBOR でエンコードされた CWT
   * (COSE_Mac0 / COSE_Sign1) だけであり、compact 形式や Base64 テキストは受理しない。
   * そのため `decode` の自動判別を経由せず、`decodeCose` で直接デコードする。
   *
   * `claimLabels` は `moqt` / `moqt-reval` の claim key であり、Token Type の判定より
   * 先に検証する。
   */
  static decodeMoqtAuthToken(
    tokenType: bigint,
    value: Uint8Array,
    claimLabels: C4mClaimLabels,
  ): CatToken {
    const labels = resolveClaimLabels(claimLabels);
    if (tokenType !== MOQT_AUTH_TOKEN_TYPE_CAT) {
      throw new CatError("invalidAuthTokenType", tokenType);
    }
    return CatToken.decodeCose(value, labels);
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
      this.#payloadBytes,
      this.#signatureBytes,
      this.#input,
      this.#tokenHeader,
      this.#tokenClaims,
      this.#claimLabels,
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
   * クレームの解釈に使った claim label 設定を返す
   *
   * デコード時に検証してコピーした値である。呼び出し元が `decode` などに渡した
   * オブジェクトを後から変更しても、この値と `claims` の解釈は変わらない。
   */
  claimLabels(): C4mClaimLabels {
    return this.#claimLabels;
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
   * トークンの署名 / MAC を検証する
   *
   * `options.expectedAlgorithm` が指定され、トークンの `alg` と一致しない場合は
   * `algorithmMismatch` で失敗する。
   *
   * 検証する claims はデコード時に `claimLabels` で解釈したものである。ここで
   * 別の label 設定を受け取って解釈し直すことは無い (`decode` に渡した設定と
   * 同じ内容が `claimLabels()` に残る)。
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
  /**
   * `moqt` / `moqt-reval` の claim key
   *
   * 必須。暗黙の既定値は無く、未指定・不正型・範囲外・IANA 登録済み claim との衝突は
   * builder の生成時に `invalidClaimLabels` で拒否する。draft-ietf-moq-c4m-02
   * Section 8 は両 claim の key を TBD のままにしており、IANA に割り当てられて
   * いないため、相互接続する peer と事前に合意した値を渡す。
   */
  claimLabels: C4mClaimLabels;
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
  /**
   * `moqt` / `moqt-reval` の claim key
   *
   * コンストラクターで検証してコピーした値である。呼び出し元が設定元の
   * オブジェクトを後から変更しても、発行するトークンの解釈は変わらない。
   */
  readonly claimLabels: C4mClaimLabels;
  /** protected ヘッダに置く鍵識別子 (`kid`)。未指定の場合は置かない */
  keyIdentifier: CoseKeyId | undefined;
  /** COSE ヘッダの `typ`。未指定の場合は `"CAT"` を使う */
  typeHeader: string | undefined;
  /** 署名アルゴリズム。未指定の場合は鍵の種別から決める */
  signingAlgorithm: Algorithm | undefined;

  constructor(options: CatTokenBuilderOptions) {
    // TypeScript の型は実行時の値ではないため、未指定や null も受け取り得る。
    // claimLabels を読む前に options 自体を検証し、設定のエラーとして拒否する
    const candidate: unknown = options;
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new CatError("invalidClaimLabels", "options must be an object with claimLabels");
    }
    const validOptions = candidate as CatTokenBuilderOptions;
    this.claims = validOptions.claims ?? createCatClaims();
    this.claimLabels = resolveClaimLabels(validOptions.claimLabels);
    this.keyIdentifier = validOptions.keyId;
    this.typeHeader = validOptions.typ;
    this.signingAlgorithm = validOptions.algorithm;
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

  /** `moqt-reval` (再検証間隔、秒) を設定する */
  moqtReval(seconds: number): this {
    this.claims.moqtReval = seconds;
    return this;
  }

  /**
   * `cnf` の `ckt` (confirmation key 5) を設定する
   *
   * 値は COSE Key Thumbprint (RFC 9679) を呼び出し側で算出して渡す。この
   * ライブラリは `ckt` を算出しない。JWK サムプリント (RFC 7638) とは異なる
   * 計算であるため、`jwkThumbprintSha256` の結果を流用してはならない。
   */
  ckt(thumbprint: Uint8Array): this {
    this.ensureConfirmation().ckt = thumbprint;
    return this;
  }

  /**
   * `cnf` の `jkt` (confirmation key 323) を設定する
   *
   * 値は JWK SHA-256 Thumbprint (RFC 7638) である。IANA で `kid` である key 3
   * として設定する API は持たない。
   */
  jkt(thumbprint: Uint8Array): this {
    this.ensureConfirmation().jkt = thumbprint;
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
   *
   * claim key は CBOR の整数 (major type 0 / 1) 全体を受理する。2^63 以上の key は
   * `number` では正確に表せないため `bigint` で渡す。
   */
  claim(key: number | bigint, value: CborValue): this {
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
   * compact 形式 (旧 C4M 01 付録 A) のトークンを発行する
   *
   * compact は汎用の旧形式 helper であり、draft-ietf-moq-c4m-02 の Token Type 1
   * (CAT) の一次ワイヤ形式ではない。新規の発行には `buildCose` を使う。
   *
   * HMAC-SHA256 のアルゴリズム識別子は RFC 9053 の HMAC 256/256 (5) を使う。
   * 旧 C4M 01 付録 A のベクタは -4 を使っていたが、IANA の COSE Algorithms
   * レジストリでは -4 は A192KW であり、HMAC-SHA256 として受理しない。
   */
  async buildCompact(crypto: CoseCrypto, key: CoseKey): Promise<string> {
    try {
      const algorithm = this.signingAlgorithm ?? defaultSigningAlgorithm(key);
      const protectedBytes = this.encodeProtectedHeaderBytes(algorithm);
      const payloadBytes = encodeCbor(encodeCatClaims(this.claims, this.claimLabels));
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
      const protectedBytes = this.encodeProtectedHeaderBytes(algorithm);
      const payloadBytes = encodeCbor(encodeCatClaims(this.claims, this.claimLabels));
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
   *
   * COSE のヘッダのエンコードは `encodeCoseHeader` に任せる (同じ規則が 2 箇所に
   * 分かれると、crit の扱いなどが片方だけ変わる)。
   */
  private encodeProtectedHeaderBytes(algorithm: Algorithm): Uint8Array {
    const header = createCoseHeader();
    header.algorithm = algorithm;
    header.algorithmIdentifier = algorithmIdentifier(algorithm);
    header.typ = cborTextString(this.typeHeader ?? CAT_CONTENT_TYPE);
    header.keyId = this.keyIdentifier;
    return encodeCbor(encodeCoseHeader(header));
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
  | "invalidClaimKey"
  | "duplicateConfirmation"
  | "missingAlgorithm"
  | "typeMismatch"
  | "algorithmMismatch"
  | "invalidAuthTokenType"
  | "detachedPayload"
  | "nonFiniteNumber"
  | "invalidClaimLabels";

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
    case "invalidClaimKey":
      return `invalid claim key: ${String(detail)}`;
    case "duplicateConfirmation":
      return "duplicate confirmation method";
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
    case "invalidClaimLabels":
      return `invalid claim labels: ${String(detail)}`;
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
