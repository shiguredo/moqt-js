/**
 * CAT (CTA-5007-B / draft-ietf-moq-c4m-02) のテスト
 *
 * 署名 / 検証は Web Crypto API を使う `WebCrypto` で実行する。
 */

import { test, assert } from "vite-plus/test";
import { encodeBase64Url } from "./base64url";
import {
  CAT_CONTENT_TYPE,
  CLAIM_CAT_URI,
  CLAIM_CAT_VERSION,
  CLAIM_CONFIRMATION,
  CLAIM_EXPIRATION,
  CLAIM_ISSUED_AT,
  CLAIM_ISSUER,
  CLAIM_NOT_BEFORE,
  CONFIRMATION_COSE_KEY_THUMBPRINT,
  CONFIRMATION_JWK_THUMBPRINT,
  CatError,
  CatToken,
  CatTokenBuilder,
  type CatTokenBuilderOptions,
  MOQT_AUTH_TOKEN_TYPE_CAT,
  authorizeCatClaims,
  confirmationCkt,
  confirmationJkt,
  createCatClaims,
  createConfirmation,
  decodeCatClaims,
  decodeConfirmation,
  encodeCatClaims,
  encodeConfirmation,
  getCatClaim,
  validateCatClaims,
} from "./cat";
import {
  type CborValue,
  CBOR_NULL,
  cborArray,
  cborByteString,
  cborFloat,
  cborInteger,
  cborMap,
  cborMapGet,
  cborSimple,
  cborTag,
  cborTextString,
  cborUnsigned,
  decodeCbor,
  encodeCbor,
} from "./cbor";
import { resolveClaimLabels } from "./claimLabels";
import { IANA_CWT_CLAIM_KEYS, MOQT_CLAIM_LABEL_KEYS } from "./cwtClaimKeys";
import { type Algorithm, type CoseKeyId, coseMessageSigningInput, decodeCoseMessage } from "./cose";
import {
  type CoseKey,
  CryptoError,
  ec2Key,
  ec2KeyWithPrivateKey,
  ed25519Key,
  ed25519KeyWithPrivateKey,
  okpCurveIdentifier,
  symmetricKey,
} from "./crypto";
import {
  C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS,
  type C4mClaimLabels,
  C4mError,
  MOQT_ACTIONS,
  createCatDpop,
  createMoqtScope,
  encodeMoqtClaim,
  exactMatch,
  moqtClaimAuthorize,
  namespaceMatchValue,
} from "./moqt";
import { WebCrypto } from "./webcrypto";
import {
  assertCatError,
  assertCborError,
  assertClaimValidationError,
  captureRejectedError,
  decodeHex,
  encodeBase64Standard,
  encodeHex,
} from "./testSupport";
import {
  CLAIM_VECTORS,
  COMPOSITE_VECTORS,
  DPOP_VECTORS,
  ES256_PRIVATE_KEY_HEX,
  ES256_PUBLIC_KEY_X_HEX,
  ES256_PUBLIC_KEY_Y_HEX,
  HMAC_KEY_HEX,
  SCOPE_VECTORS,
  TOKEN_VECTORS,
  VALIDATION_VECTORS,
  type ClaimVector,
} from "./testVectors";

const TEXT_ENCODER = new TextEncoder();
/** テストで明示する claim label 設定 (C4M 02 付録 A の検証用 preset) */
const CLAIM_LABELS = C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS;
const cryptoImpl = new WebCrypto();
const CLAIM_VECTOR_INDEX = new Map(CLAIM_VECTORS.map((vector) => [vector.id, vector]));

/** 付録 A.1 の HMAC-SHA256 鍵 */
function hmacKey(): CoseKey {
  return symmetricKey(decodeHex(HMAC_KEY_HEX));
}

/** 付録 A.1 の ES256 公開鍵 */
function es256PublicKey(): CoseKey {
  return ec2Key("P256", decodeHex(ES256_PUBLIC_KEY_X_HEX), decodeHex(ES256_PUBLIC_KEY_Y_HEX));
}

/** 付録 A.1 の ES256 秘密鍵 */
function es256PrivateKey(): CoseKey {
  return ec2KeyWithPrivateKey(
    "P256",
    decodeHex(ES256_PUBLIC_KEY_X_HEX),
    decodeHex(ES256_PUBLIC_KEY_Y_HEX),
    decodeHex(ES256_PRIVATE_KEY_HEX),
  );
}

/** claims の CBOR ベクタを引く */
function claimVector(id: string): ClaimVector {
  const vector = CLAIM_VECTOR_INDEX.get(id);
  assert.ok(vector !== undefined, `ベクタがある: ${id}`);
  return vector;
}

/**
 * 付録 A.7 の検証用ベクタのトークンを実 Web Crypto で検証する
 *
 * 改ざんベクタは改ざん前の原本を、誤鍵ベクタは正しい鍵を使って MAC が通ることを
 * 確認する。それ以外のベクタはトークン自身の MAC が正しい。A.7 のベクタはすべて
 * COSE_Mac0 (alg 5) であるため、デコード結果の形式と alg も併せて固定する。
 */
async function verifyValidationVectorTokens(): Promise<void> {
  for (const vector of VALIDATION_VECTORS) {
    const validation = vector.validation;
    const token = CatToken.decode(TEXT_ENCODER.encode(vector.token), CLAIM_LABELS);
    assert.equal(token.format(), "coseMac0", `ベクタ ${vector.id} の形式`);
    assert.equal(token.header().algorithmIdentifier, 5, `ベクタ ${vector.id} の alg`);
    if (vector.id === "invalid_tampered_signature") {
      // 改ざん前の原本は A.1 の鍵で MAC が通る。改ざん後のトークンは別のテストで
      // 失敗することを確認する
      assert.ok(vector.originalCoseHex !== undefined, "原本の COSE バイト列がある");
      const original = CatToken.decode(decodeHex(vector.originalCoseHex), CLAIM_LABELS);
      await original.verify(cryptoImpl, hmacKey());
      continue;
    }
    if (vector.id === "invalid_wrong_key") {
      // 誤鍵ベクタは正しい鍵では MAC が通る
      assert.ok(validation.correctKeyHex !== undefined, "正しい鍵がある");
      await token.verify(cryptoImpl, symmetricKey(decodeHex(validation.correctKeyHex)));
      continue;
    }
    // それ以外のベクタ (期限切れ、未到来、issuer / audience 不一致、形式不一致) は
    // トークン自身の MAC が正しい
    await token.verify(cryptoImpl, hmacKey());
  }
}

test("付録 A.3 の COSE トークンをデコードできる", () => {
  for (const vector of TOKEN_VECTORS) {
    // 一次資料の cose_hex と cose_b64 が同じ完全な COSE 構造を表すことを固定する
    const coseBytes = decodeHex(vector.coseHex);
    assert.equal(
      encodeBase64Url(coseBytes),
      vector.coseB64,
      `ベクタ ${vector.id} の cose_hex と cose_b64`,
    );
    // 完全な COSE 構造は COSE_Mac0 (17) / COSE_Sign1 (18) のタグと 4 要素の配列で始まる
    assert.deepEqual(
      [...coseBytes.subarray(0, 2)],
      vector.algorithmId === 5 ? [0xd1, 0x84] : [0xd2, 0x84],
      `ベクタ ${vector.id} の CBOR タグ`,
    );

    // 生の COSE バイト列からデコードする
    const token = CatToken.decode(coseBytes, CLAIM_LABELS);
    assert.equal(
      token.format(),
      vector.algorithmId === 5 ? "coseMac0" : "coseSign1",
      `ベクタ ${vector.id} の形式`,
    );
    assert.equal(
      encodeHex(token.protectedHeader()),
      vector.headerHex,
      `ベクタ ${vector.id} の protected ヘッダ`,
    );
    assert.equal(encodeHex(token.payload()), vector.payloadHex, `ベクタ ${vector.id} の claims`);
    assert.equal(encodeHex(token.signature()), vector.signatureHex, `ベクタ ${vector.id} の署名`);
    assert.equal(
      token.header().algorithmIdentifier,
      vector.algorithmId,
      `ベクタ ${vector.id} のアルゴリズム`,
    );
    assert.equal(
      token.header().algorithm,
      vector.algorithmId === 5 ? "HmacSha256" : "Es256",
      `ベクタ ${vector.id} のアルゴリズム名`,
    );
    assert.deepEqual(token.header().typ, cborTextString("CAT"), `ベクタ ${vector.id} の typ`);

    const claims = token.claims();
    assert.equal(claims.expiration, 1700086400, `ベクタ ${vector.id} の exp`);
    if (vector.id === "token_hmac_minimal") {
      assert.equal(claims.issuer, "https://auth.example.com");
      assert.deepEqual(claims.audience, ["https://relay.example.com"]);
      assert.equal(claims.notBefore, undefined);
    } else if (vector.id === "token_hmac_full") {
      assert.equal(claims.issuer, "https://issuer.moq.example");
      assert.equal(claims.subject, "user:alice@example.com");
      assert.deepEqual(claims.audience, [
        "https://relay1.example.com",
        "https://relay2.example.com",
      ]);
      assert.equal(claims.notBefore, 1700000000);
      assert.equal(claims.issuedAt, 1700000000);
      assert.deepEqual(claims.cwtId, decodeHex("766563746f722d303032"), "cti は bstr");
      // catv (310) と catnip (311) は型付きで解釈せず raw に保持する
      assert.deepEqual(getCatClaim(claims, CLAIM_CAT_VERSION), cborUnsigned(1n));
    } else {
      assert.equal(claims.issuer, "https://auth.example.com");
      assert.deepEqual(claims.audience, ["https://moq-relay.example.com"]);
      assert.equal(claims.notBefore, 1700000000);
    }

    // base64url のテキストからデコードしても同じ claims になる
    const fromText = CatToken.decode(TEXT_ENCODER.encode(vector.coseB64), CLAIM_LABELS);
    assert.deepEqual(fromText.claims(), claims, `ベクタ ${vector.id} の base64url 経路`);
  }
});

test("付録 A.3 の COSE トークンの MAC / 署名を実 Web Crypto で検証できる", async () => {
  for (const vector of TOKEN_VECTORS) {
    const token = CatToken.decode(decodeHex(vector.coseHex), CLAIM_LABELS);
    const key = vector.algorithmId === 5 ? hmacKey() : es256PublicKey();
    // 付録 A.1 の鍵で MAC / 署名を検証する
    await token.verify(cryptoImpl, key);
    // 期待する alg と typ を指定しても通る
    await token.verify(cryptoImpl, key, {
      expectedAlgorithm: vector.algorithmId === 5 ? "HmacSha256" : "Es256",
      expectedType: CAT_CONTENT_TYPE,
    });
  }
});

test("付録 A.4 の jkt を confirmation key 323 として解釈する", async () => {
  // 付録 A.4 のベクタは key 323 (`jkt`) を使う。draft-ietf-moq-c4m-02 Section 4.1
  // は、authorization server が DPoP の鍵束縛に `ckt` (key 5) を SHOULD、既存の
  // CAT issuer との互換用に `jkt` (key 323) を MAY とし、relay は `ckt` を MUST
  // support、`jkt` を SHOULD support とする。c4m-01 の key 3 (`kid`) とは別の
  // confirmation method であり、key 3 を jkt に読み替えない。
  for (const vector of DPOP_VECTORS) {
    assert.equal(
      encodeBase64Url(decodeHex(vector.coseHex)),
      vector.coseB64,
      `ベクタ ${vector.id} の cose_hex と cose_b64`,
    );
    const token = CatToken.decode(decodeHex(vector.coseHex), CLAIM_LABELS);
    assert.equal(
      token.format(),
      vector.algorithmId === 5 ? "coseMac0" : "coseSign1",
      `ベクタ ${vector.id} の形式`,
    );
    assert.equal(encodeHex(token.payload()), vector.payloadHex, `ベクタ ${vector.id} の claims`);
    await token.verify(cryptoImpl, vector.algorithmId === 5 ? hmacKey() : es256PublicKey());

    const confirmation = token.claims().confirmation;
    assert.ok(confirmation !== undefined, `ベクタ ${vector.id} に cnf がある`);
    assert.equal(confirmation.ckt, undefined, `ベクタ ${vector.id} に ckt は無い`);
    assert.deepEqual(
      confirmation.jkt,
      decodeHex(vector.cnfJktHex),
      `ベクタ ${vector.id} の key 323 の jkt`,
    );
    assert.deepEqual(confirmationJkt(confirmation), decodeHex(vector.cnfJktHex));
    assert.equal(confirmationCkt(confirmation), undefined);
    assert.equal(confirmation.raw.length, 0, `ベクタ ${vector.id} の key 323 は raw に残らない`);

    // 再エンコードしても key 323 の bstr として出る
    const encoded = encodeConfirmation(confirmation);
    assert.deepEqual(
      cborMapGet(encoded, cborInteger(CONFIRMATION_JWK_THUMBPRINT)),
      cborByteString(decodeHex(vector.cnfJktHex)),
    );
    assert.equal(cborMapGet(encoded, cborInteger(CONFIRMATION_COSE_KEY_THUMBPRINT)), undefined);

    const catdpop = token.claims().catdpop;
    assert.ok(catdpop !== undefined, `ベクタ ${vector.id} に catdpop がある`);
    assert.equal(catdpop.windowSeconds, vector.windowSeconds, `ベクタ ${vector.id} のウィンドウ`);
    assert.equal(catdpop.honorJti, vector.honorJti, `ベクタ ${vector.id} の honor_jti`);
  }
});

test("付録 A.6 の Composite Claims は claim key 0 のため CAT として拒否する", async () => {
  // A.6 の原本は、`or` / `nor` / `and` の claim key が未割当のためすべて 0 を
  // placeholder に使うと明記する。0 は RFC 8392 Section 9.1.2 が RESERVED として
  // 予約しており claim key として無効である。原本も「0 は有効な claim key では
  // ないため検証側はこれらの claim を parse できない」としている。
  for (const vector of COMPOSITE_VECTORS) {
    assert.equal(vector.claimKey, 0, `ベクタ ${vector.id} の claim key は未割当の 0`);
    assert.equal(
      encodeBase64Url(decodeHex(vector.coseHex)),
      vector.coseB64,
      `ベクタ ${vector.id} の cose_hex と cose_b64`,
    );
    // COSE 構造と MAC 自体は原本のバイト列のまま正しい
    const message = decodeCoseMessage(decodeHex(vector.coseHex));
    assert.equal(message.type, "mac0", `ベクタ ${vector.id} の形式`);
    if (message.type !== "mac0") {
      assert.fail(`ベクタ ${vector.id} は COSE_Mac0 としてデコードされるべき`);
    }
    const payload = message.mac0.payload;
    assert.ok(payload !== undefined, `ベクタ ${vector.id} に payload がある`);
    assert.equal(encodeHex(payload), vector.payloadHex, `ベクタ ${vector.id} の payload`);
    // 原本の payload バイト列を再エンコードせずに MAC_structure を組み立てて検証する
    await cryptoImpl.verify(
      "HmacSha256",
      hmacKey(),
      coseMessageSigningInput(message),
      message.mac0.tag,
    );

    // claim set のデコードもトークンのデコードも key 0 を受理しない
    assertCatError(() => decodeCatClaims(decodeCbor(payload), CLAIM_LABELS), "invalidClaimKey", 0n);
    assertCatError(
      () => CatToken.decode(decodeHex(vector.coseHex), CLAIM_LABELS),
      "invalidClaimKey",
      0n,
    );
  }
});

test("外側に moqt を置いても claim key 0 の claim set は受理しない", () => {
  // 外側の moqt だけで認可が通る claim set に key 0 を混ぜたトークンを合成する。
  // key 0 を未知の claim として無視すると、本来 parse できない claim set が外側の
  // moqt により認可される fail-open の経路になる。実装はデコードの時点で key 0 を
  // 拒否するため、この経路は成立しない。
  const claimsValue = cborMap([
    [cborInteger(CLAIM_LABELS.moqt), encodeMoqtClaim({ scopes: [createMoqtScope(["Publish"])] })],
    [cborInteger(0), cborArray([cborMap([])])],
  ]);
  const protectedBytes = encodeCbor(
    cborMap([
      [cborUnsigned(1n), cborInteger(5)],
      [cborUnsigned(16n), cborTextString(CAT_CONTENT_TYPE)],
    ]),
  );
  // COSE_Mac0 (タグ 17) の 4 要素を手組みする。デコードは MAC を検証しないため
  // タグの値は何でもよい (このテストは claim set の受理 / 拒否だけを固定する)
  const message = cborTag(
    17n,
    cborArray([
      cborByteString(protectedBytes),
      cborMap([]),
      cborByteString(encodeCbor(claimsValue)),
      cborByteString(new Uint8Array(32)),
    ]),
  );
  assertCatError(() => CatToken.decode(encodeCbor(message), CLAIM_LABELS), "invalidClaimKey", 0n);
});

test("claim key 0 は claim set にも raw にも置けない", () => {
  // RFC 8392 Section 9.1.2 は key 0 を RESERVED として予約しており、claim の key
  // として使えない。デコードとエンコードの両方で拒否する
  assertCatError(
    () => decodeCatClaims(cborMap([[cborInteger(0), cborArray([])]]), CLAIM_LABELS),
    "invalidClaimKey",
    0n,
  );
  const claims = createCatClaims();
  claims.raw.push([cborInteger(0), cborArray([])]);
  assertCatError(() => encodeCatClaims(claims, CLAIM_LABELS), "invalidClaimKey", 0n);
});

/**
 * 付録 A.7 の `expected_error` と実装のエラー型 / コードの対応表:
 *
 * - TokenExpired -> ClaimValidationError("expired")
 * - TokenNotYetValid -> ClaimValidationError("notYetValid")
 * - InvalidIssuer -> ClaimValidationError("issuerMismatch")
 * - InvalidAudience -> ClaimValidationError("audienceMismatch")
 * - SignatureVerificationFailed -> CatError("crypto") の cause が
 *   CryptoError("signatureVerificationFailed")
 * - InvalidTokenFormat -> CatError("algorithmMismatch")
 *   (検証側が ES256 を期待する COSE_Mac0 のため。形式そのものではなく、
 *   検証側の期待アルゴリズムとトークンの alg の不一致として扱う)
 */
function assertSignatureVerificationFailed(error: unknown, label: string): void {
  assert.ok(error instanceof CatError, `${label} で CatError を期待した`);
  assert.equal(error.code, "crypto", label);
  assert.ok(error.cause instanceof CryptoError, `${label} の cause は CryptoError`);
  assert.equal(error.cause.code, "signatureVerificationFailed", `${label} の CryptoError のコード`);
}

test("付録 A.7 の検証ベクタのクレームを検証できる", () => {
  for (const vector of VALIDATION_VECTORS) {
    const token = CatToken.decode(TEXT_ENCODER.encode(vector.token), CLAIM_LABELS);
    const validation = vector.validation;
    assert.equal(token.format(), "coseMac0", `ベクタ ${vector.id} の形式`);
    assert.equal(token.header().algorithmIdentifier, 5, `ベクタ ${vector.id} の alg`);
    const run = (): void => {
      validateCatClaims(token.claims(), {
        referenceTimeSeconds: validation.referenceTime ?? 0,
        clockToleranceSeconds: 0,
        expectedIssuers: validation.expectedIssuers,
        expectedAudiences: validation.expectedAudiences,
      });
    };
    switch (validation.expectedError) {
      case "TokenExpired":
        assertClaimValidationError(run, "expired");
        break;
      case "TokenNotYetValid":
        assertClaimValidationError(run, "notYetValid");
        break;
      case "InvalidIssuer":
        assertClaimValidationError(run, "issuerMismatch");
        break;
      case "InvalidAudience":
        assertClaimValidationError(run, "audienceMismatch");
        break;
      // 署名 / 形式のエラーはクレーム検証とは別の層なので、ここでは正常になる
      default:
        assert.doesNotThrow(run, `ベクタ ${vector.id}`);
        break;
    }
  }
});

test("exp は等値で期限切れになり、nbf は等値で有効になる", () => {
  // RFC 8392 Section 3.1.4 は exp の処理を RFC 7519 Section 4.1.4 に委ねる。
  // 同節は「expiration time の時点またはそれ以降は受理してはならない
  // (MUST NOT accept ... on or after)」と定めるため、referenceTime === exp は
  // 期限切れである
  const expiring = createCatClaims();
  expiring.expiration = 1000;
  validateCatClaims(expiring, { referenceTimeSeconds: 999 });
  assertClaimValidationError(
    () => validateCatClaims(expiring, { referenceTimeSeconds: 1000 }),
    "expired",
  );
  assertClaimValidationError(
    () => validateCatClaims(expiring, { referenceTimeSeconds: 1001 }),
    "expired",
  );

  // clockTolerance は exp に加算する。許容ずれの境界 (exp + tolerance) は期限切れで、
  // その 1 秒前は有効のままとする
  validateCatClaims(expiring, { referenceTimeSeconds: 1004, clockToleranceSeconds: 5 });
  assertClaimValidationError(
    () => validateCatClaims(expiring, { referenceTimeSeconds: 1005, clockToleranceSeconds: 5 }),
    "expired",
  );
  assertClaimValidationError(
    () => validateCatClaims(expiring, { referenceTimeSeconds: 1006, clockToleranceSeconds: 5 }),
    "expired",
  );
  // 許容ずれがあっても exp ちょうどは有効 (exp + tolerance より前であるため)
  validateCatClaims(expiring, { referenceTimeSeconds: 1000, clockToleranceSeconds: 5 });

  // RFC 8392 Section 3.1.5 が参照する RFC 7519 Section 4.1.5 は「not-before の
  // 時点またはそれ以降なら受理してよい (MUST be after or equal to)」と定めるため、
  // referenceTime === nbf は有効である
  const notYet = createCatClaims();
  notYet.notBefore = 1000;
  validateCatClaims(notYet, { referenceTimeSeconds: 1000 });
  assertClaimValidationError(
    () => validateCatClaims(notYet, { referenceTimeSeconds: 999 }),
    "notYetValid",
  );
  // clockTolerance は nbf との比較で referenceTime に加算する。nbf ちょうどになる
  // 境界 (referenceTime + tolerance === nbf) は有効、その 1 秒前は未到来である
  validateCatClaims(notYet, { referenceTimeSeconds: 995, clockToleranceSeconds: 5 });
  assertClaimValidationError(
    () => validateCatClaims(notYet, { referenceTimeSeconds: 994, clockToleranceSeconds: 5 }),
    "notYetValid",
  );
});

test("moqt-reval は 0 を受理し、正の間隔だけ再検証のサポートを要求する", () => {
  // draft-ietf-moq-c4m-02 Section 2.2: value が 0 のときトークンを再検証しては
  // ならず、claim が無い場合と同じ挙動になる。したがって再検証できない受信者も
  // 0 は受理する。正の値は再検証の間隔であり、再検証できない受信者は拒否する
  // (MUST reject)。本ライブラリは再検証を行わないため、既定では正の値を拒否する
  const claims = createCatClaims();
  claims.moqtReval = 0;
  validateCatClaims(claims, { referenceTimeSeconds: 0 });
  validateCatClaims(claims, { referenceTimeSeconds: 0, revalidationSupported: false });
  validateCatClaims(claims, { referenceTimeSeconds: 0, revalidationSupported: true });

  // 0 と正の値の境界を固定する。CBOR の 0 をデコードしても 0 のまま保持され、
  // 再検証をサポートしない受信者で受理される。1 秒でも再検証が必要になるため、
  // サポートが無ければ拒否する。受信者が対応できる最小 interval より moqt-reval が
  // 小さい場合に true を渡さないことは呼び出し側の責務であり、
  // CatClaimValidationOptions の JSDoc に明記している
  const decodedZero = decodeCatClaims(
    cborMap([[cborInteger(CLAIM_LABELS.moqtReval), cborInteger(0)]]),
    CLAIM_LABELS,
  );
  assert.equal(decodedZero.moqtReval, 0);
  validateCatClaims(decodedZero, { referenceTimeSeconds: 0 });
  claims.moqtReval = 1;
  assertClaimValidationError(
    () => validateCatClaims(claims, { referenceTimeSeconds: 0 }),
    "revalidationNotSupported",
  );
  assertClaimValidationError(
    () => validateCatClaims(claims, { referenceTimeSeconds: 0, revalidationSupported: false }),
    "revalidationNotSupported",
  );
  validateCatClaims(claims, { referenceTimeSeconds: 0, revalidationSupported: true });

  // 通常の再検証間隔 (300 秒) でも同じ規則になる
  claims.moqtReval = 300;
  assertClaimValidationError(
    () => validateCatClaims(claims, { referenceTimeSeconds: 0 }),
    "revalidationNotSupported",
  );
  // 継続ストリームで再検証する呼び出し側だけが true を渡せる
  validateCatClaims(claims, { referenceTimeSeconds: 0, revalidationSupported: true });

  // 負の再検証間隔は、再検証をサポートしていても意味を持たないため拒否する
  claims.moqtReval = -1;
  assertClaimValidationError(
    () => validateCatClaims(claims, { referenceTimeSeconds: 0, revalidationSupported: true }),
    "invalidMoqtReval",
  );
  assertClaimValidationError(
    () => validateCatClaims(claims, { referenceTimeSeconds: 0 }),
    "invalidMoqtReval",
  );

  // moqt-reval を持たない claims は再検証の有無に関係なく検証できる
  validateCatClaims(createCatClaims(), { referenceTimeSeconds: 0 });
});

test("負の moqt-reval は encodeCatClaims とビルダーが invalidMoqtReval で拒否する", async () => {
  // draft-ietf-moq-c4m-02 Section 2.2 の moqt-reval-value は再検証の間隔 (秒)
  // であり、負の値は意味を持たない。decode は値域を検証せず validateCatClaims が
  // 拒否するが、発行側は負の値を CBOR にせず encode の時点で拒否する
  const claims = createCatClaims();
  claims.moqtReval = -1;
  assertCatError(() => encodeCatClaims(claims, CLAIM_LABELS), "invalidMoqtReval", -1);

  // ビルダー経由でも encodeCatClaims の同じ規則で発行を拒否する
  const build = async (): Promise<unknown> =>
    new CatTokenBuilder({ claimLabels: CLAIM_LABELS })
      .moqtReval(-1)
      .buildCose(cryptoImpl, hmacKey());
  const error = await captureRejectedError(build);
  assert.ok(error instanceof CatError);
  assert.equal(error.code, "invalidMoqtReval");
  assert.equal(error.detail, -1);

  // 0 (再検証しない) と正の値は発行できる
  for (const seconds of [0, 300]) {
    const tokenBytes = await new CatTokenBuilder({ claimLabels: CLAIM_LABELS })
      .moqtReval(seconds)
      .buildCose(cryptoImpl, hmacKey());
    assert.equal(
      CatToken.decode(tokenBytes, CLAIM_LABELS).claims().moqtReval,
      seconds,
      `moqt-reval ${seconds} が往復しない`,
    );
  }
});

test("authorizeCatClaims を単独で使うと claims の検証を迂回して認可する (現時点の契約)", () => {
  // これは現時点の契約を明示する回帰テストである。authorizeCatClaims は署名 / MAC
  // も exp / nbf / iss / aud / moqt-reval / catdpop の値域も検証しない。呼び出し側が
  // CatToken.verify -> validateCatClaims -> authorizeCatClaims の順で使わない場合、
  // 次の状態でも moqt クレームが許可する action は true になる。将来この契約を
  // 変える場合は、このテストと JSDoc / README / docs を同時に更新すること
  const namespace = [TEXT_ENCODER.encode("example.com")];
  const trackName = TEXT_ENCODER.encode("video-hd");

  // 期限切れ + cnf を持つ claims でも、proof を検証済みと明示すれば認可する
  const expired = createCatClaims();
  expired.moqt = { scopes: [createMoqtScope(["Publish"])] };
  expired.expiration = 1000;
  const confirmation = createConfirmation();
  confirmation.jkt = new Uint8Array(32).fill(0x17);
  expired.confirmation = confirmation;
  assertClaimValidationError(
    () => validateCatClaims(expired, { referenceTimeSeconds: 1001 }),
    "expired",
  );
  assert.equal(
    authorizeCatClaims(expired, "Publish", namespace, trackName, { dpopProofVerified: true }),
    true,
    "期限切れでも authorizeCatClaims 単独では認可される",
  );

  // 正の moqt-reval (再検証が必要) も validateCatClaims は拒否するが、
  // authorizeCatClaims 単独では認可される
  const positiveReval = createCatClaims();
  positiveReval.moqt = { scopes: [createMoqtScope(["Publish"])] };
  positiveReval.moqtReval = 300;
  assertClaimValidationError(
    () => validateCatClaims(positiveReval, { referenceTimeSeconds: 0 }),
    "revalidationNotSupported",
  );
  assert.equal(
    authorizeCatClaims(positiveReval, "Publish", namespace, trackName),
    true,
    "正の moqt-reval でも authorizeCatClaims 単独では認可される",
  );

  // 負の moqt-reval も validateCatClaims は拒否するが、authorizeCatClaims 単独では
  // 認可される (encodeCatClaims は負値を発行しないが、手組みの claims では入り得る)
  const negativeReval = createCatClaims();
  negativeReval.moqt = { scopes: [createMoqtScope(["Publish"])] };
  negativeReval.moqtReval = -1;
  assertClaimValidationError(
    () => validateCatClaims(negativeReval, { referenceTimeSeconds: 0 }),
    "invalidMoqtReval",
  );
  assert.equal(
    authorizeCatClaims(negativeReval, "Publish", namespace, trackName),
    true,
    "負の moqt-reval でも authorizeCatClaims 単独では認可される",
  );
});

test("CatToken.verify は署名 / MAC を検証し、claims の値は検証しない", async () => {
  // verify の契約: 署名 / MAC を検証する。alg / typ は expectedAlgorithm /
  // expectedType を指定した場合にだけ検証する。claims の値 (exp / nbf /
  // iss / aud) の検証は validateCatClaims が行う。そのため、期限切れの exp を持つ
  // トークンでも署名が正しければ verify は成功する
  const expired = await new CatTokenBuilder({ claimLabels: CLAIM_LABELS })
    .issuer("https://auth.example.com")
    .expiration(1000)
    .buildCose(cryptoImpl, hmacKey());
  const token = CatToken.decode(expired, CLAIM_LABELS);

  // 署名の検証は成功する
  await token.verify(cryptoImpl, hmacKey());

  // claims の値の検証は validateCatClaims が別途行う
  assertClaimValidationError(
    () => validateCatClaims(token.claims(), { referenceTimeSeconds: 1000 }),
    "expired",
  );
});

test("付録 A.7 のトークンの MAC を実 Web Crypto で検証できる", async () => {
  await verifyValidationVectorTokens();
});

test("付録 A.7 の改ざんと誤った鍵を実 Web Crypto で拒否する", async () => {
  for (const vector of VALIDATION_VECTORS) {
    const validation = vector.validation;
    if (validation.expectedError !== "SignatureVerificationFailed") {
      continue;
    }
    const token = CatToken.decode(TEXT_ENCODER.encode(vector.token), CLAIM_LABELS);
    let keyHex: string;
    if (validation.keyHex !== undefined) {
      // 改ざんベクタ: 原本の鍵で検証しても失敗する
      keyHex = validation.keyHex;
    } else {
      // 誤鍵ベクタ: 誤った鍵で検証すると失敗する
      assert.ok(validation.wrongKeyHex !== undefined, `ベクタ ${vector.id} の誤った鍵`);
      keyHex = validation.wrongKeyHex;
    }
    const error = await captureRejectedError(() =>
      token.verify(cryptoImpl, symmetricKey(decodeHex(keyHex))),
    );
    assertSignatureVerificationFailed(error, vector.id);
  }
});

test("付録 A.7 の形式と algorithm の不一致を実 Web Crypto で拒否する", async () => {
  const vector = VALIDATION_VECTORS.find((entry) => entry.id === "invalid_algorithm_mismatch");
  assert.ok(vector !== undefined);
  const validation = vector.validation;
  assert.equal(validation.expectedError, "InvalidTokenFormat");
  assert.equal(validation.tokenAlgorithmId, 5);
  assert.equal(validation.verifierAlgorithmId, -7);

  const token = CatToken.decode(TEXT_ENCODER.encode(vector.token), CLAIM_LABELS);
  assert.equal(token.header().algorithmIdentifier, 5);
  // トークン自身は COSE_Mac0 で、HMAC の MAC は正しい
  await token.verify(cryptoImpl, hmacKey());
  // 検証側が ES256 を期待すると、形式と algorithm の不一致として拒否する
  const error = await captureRejectedError(() =>
    token.verify(cryptoImpl, hmacKey(), { expectedAlgorithm: "Es256" }),
  );
  assert.ok(error instanceof CatError);
  assert.equal(error.code, "algorithmMismatch");
});

test("COSE 形式は HMAC では COSE_Mac0 になる", async () => {
  const tokenBytes = await new CatTokenBuilder({ claimLabels: CLAIM_LABELS })
    .issuer("https://auth.example.com")
    .audience("https://relay.example.com")
    .expiration(1700086400)
    .buildCose(cryptoImpl, hmacKey());
  const token = CatToken.decode(tokenBytes, CLAIM_LABELS);
  assert.equal(token.format(), "coseMac0");
  assert.equal(token.header().algorithmIdentifier, 5);
  await token.verify(cryptoImpl, hmacKey());
  // CWT タグ (61) と COSE タグ (17) が付いている
  assert.equal(tokenBytes[0], 0xd8);
  assert.equal(tokenBytes[1], 0x3d);
  assert.equal(tokenBytes[2], 0xd1);
});

test("COSE 形式は ES256 では COSE_Sign1 になる", async () => {
  const tokenBytes = await new CatTokenBuilder({ claimLabels: CLAIM_LABELS })
    .issuer("https://auth.example.com")
    .audience("https://moq-relay.example.com")
    .expiration(1700086400)
    .notBefore(1700000000)
    .keyId({ type: "text", value: "key-1" })
    .buildCose(cryptoImpl, es256PrivateKey());
  const token = CatToken.decode(tokenBytes, CLAIM_LABELS);
  assert.equal(token.format(), "coseSign1");
  assert.equal(token.header().algorithm, "Es256");
  assert.deepEqual(token.header().keyId, { type: "text", value: "key-1" });
  await token.verify(cryptoImpl, es256PublicKey());
});

test("COSE 形式は Ed25519 でも往復できる", async () => {
  // Ed25519 の鍵はテストベクタに無いため、RFC 8032 Section 7.1 のテストベクタ 1 を使う
  const publicKey = ed25519Key(
    decodeHex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"),
  );
  const privateKey = ed25519KeyWithPrivateKey(
    decodeHex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"),
    decodeHex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"),
  );
  const tokenBytes = await new CatTokenBuilder({ claimLabels: CLAIM_LABELS })
    .issuer("https://auth.example.com")
    .buildCose(cryptoImpl, privateKey);
  const token = CatToken.decode(tokenBytes, CLAIM_LABELS);
  assert.equal(token.header().algorithm, "EdDsa");
  await token.verify(cryptoImpl, publicKey);
  // 曲線の識別子を確認する
  assert.equal(okpCurveIdentifier("Ed25519"), 6);
});

test("base64url で包んだ COSE トークンをデコードできる", async () => {
  const tokenBytes = await new CatTokenBuilder({ claimLabels: CLAIM_LABELS })
    .issuer("https://auth.example.com")
    .buildCose(cryptoImpl, hmacKey());
  const text = encodeBase64Url(tokenBytes);
  const token = CatToken.decode(TEXT_ENCODER.encode(text), CLAIM_LABELS);
  assert.equal(token.format(), "coseMac0");
  await token.verify(cryptoImpl, hmacKey());
});

test("MOQT の Auth Token Type を検証する", () => {
  const vector = TOKEN_VECTORS[0];
  assert.ok(vector !== undefined);
  const tokenBytes = decodeHex(vector.coseHex);
  assert.equal(
    CatToken.decodeMoqtAuthToken(MOQT_AUTH_TOKEN_TYPE_CAT, tokenBytes, CLAIM_LABELS).format(),
    "coseMac0",
  );
  assertCatError(
    () => CatToken.decodeMoqtAuthToken(2n, tokenBytes, CLAIM_LABELS),
    "invalidAuthTokenType",
    2n,
  );
});

test("MOQT の Token Type 1 の Token Value としてテキストを受理しない", async () => {
  // draft-ietf-moq-c4m-02 Section 8.2.1 は Token Type 0x01 の Token Payload を
  // 「CBOR でエンコードされた CWT」に限定している。Base64 / base64url のテキストと
  // ピリオドで区切ったテキストは Token Value の CBOR ではないため、decode の
  // 自動判別を経由せず拒否する
  for (const text of ["ogEjEGNDQVQ.aaaa.aaaa", "ogEjEGNDQVQ"]) {
    assertCatError(
      () =>
        CatToken.decodeMoqtAuthToken(
          MOQT_AUTH_TOKEN_TYPE_CAT,
          TEXT_ENCODER.encode(text),
          CLAIM_LABELS,
        ),
      "cose",
    );
  }

  const coseBytes = await new CatTokenBuilder({ claimLabels: CLAIM_LABELS })
    .issuer("https://auth.example.com")
    .buildCose(cryptoImpl, hmacKey());
  // base64url と標準 Base64 のどちらも、COSE 構造ではなくテキストであるため
  // COSE のエラーとして拒否する
  for (const text of [
    encodeBase64Url(coseBytes),
    encodeBase64Standard(coseBytes, true),
    encodeBase64Standard(coseBytes, false),
  ]) {
    assertCatError(
      () =>
        CatToken.decodeMoqtAuthToken(
          MOQT_AUTH_TOKEN_TYPE_CAT,
          TEXT_ENCODER.encode(text),
          CLAIM_LABELS,
        ),
      "cose",
    );
  }

  // 生の COSE バイト列は引き続き受理する
  assert.equal(
    CatToken.decodeMoqtAuthToken(MOQT_AUTH_TOKEN_TYPE_CAT, coseBytes, CLAIM_LABELS).format(),
    "coseMac0",
  );
});

test("不正なトークンを拒否する", () => {
  // CBOR / base64url のどちらとしても解釈できない入力は COSE のエラーになる
  assertCatError(() => CatToken.decode(TEXT_ENCODER.encode("not a token"), CLAIM_LABELS), "cose");
  assertCatError(() => CatToken.decode(TEXT_ENCODER.encode("aaaa.bbbb"), CLAIM_LABELS), "cose");
  // ピリオドで区切ったテキストも COSE のテキストとして扱う。base64url として
  // 不正な文字を含む場合は COSE のエラー、base64url としては復号できるが CBOR では
  // ない場合も COSE のエラーになる
  assertCatError(() => CatToken.decode(TEXT_ENCODER.encode("***.@@@.$$$"), CLAIM_LABELS), "cose");
  assertCatError(
    () => CatToken.decode(TEXT_ENCODER.encode("ogEFEGNDQVQ.aaaa.aaaa"), CLAIM_LABELS),
    "cose",
  );
});

test("alg の無いトークンを拒否する", () => {
  // COSE 形式で alg が無い
  const emptyMap = encodeCbor(cborMap([]));
  const value = cborTag(
    18n,
    cborArray([
      cborByteString(new Uint8Array(0)),
      cborMap([]),
      cborByteString(emptyMap),
      cborByteString(TEXT_ENCODER.encode("signature")),
    ]),
  );
  assertCatError(() => CatToken.decode(encodeCbor(value), CLAIM_LABELS), "missingAlgorithm");
});

test("detached payload の COSE トークンを拒否する", () => {
  // CAT のクレームは payload に載るため、payload が null のトークンは受理しない
  const protectedBytes = encodeCbor(cborMap([[cborUnsigned(1n), cborInteger(-7)]]));
  const value = cborTag(
    18n,
    cborArray([
      cborByteString(protectedBytes),
      cborMap([]),
      CBOR_NULL,
      cborByteString(TEXT_ENCODER.encode("signature")),
    ]),
  );
  assertCatError(() => CatToken.decode(encodeCbor(value), CLAIM_LABELS), "detachedPayload");
});

test("型付きクレームの raw への重複を拒否する", () => {
  const claims = createCatClaims();
  claims.issuer = "https://auth.example.com";
  claims.raw.push([cborInteger(CLAIM_ISSUER), cborTextString("other")]);
  assertCatError(
    () => encodeCatClaims(claims, CLAIM_LABELS),
    "duplicateClaim",
    BigInt(CLAIM_ISSUER),
  );
});

test("encodeCatClaims は raw 同士の claim key の重複を拒否する", () => {
  // encodeCatClaims は CborValue を直接受ける公開 API のため、cborMap の構築では
  // 重複を検出しない。デコード側と同じ判定を使い、encodeCbor の duplicateMapKey
  // ではなく CAT の duplicateClaim として拒否する
  const duplicateKeys: ReadonlyArray<readonly [CborValue, string | bigint]> = [
    [cborInteger(1000), 1000n],
    [cborTextString("custom"), "custom"],
  ];
  for (const [key, detail] of duplicateKeys) {
    const claims = createCatClaims();
    claims.raw.push([key, cborTextString("first")]);
    claims.raw.push([key, cborTextString("second")]);
    assertCatError(() => encodeCatClaims(claims, CLAIM_LABELS), "duplicateClaim", detail);
  }
});

test("raw のクレームは往復して取得できる", () => {
  // 付録 A.2 の catv (uint 1) と catu は型付きで解釈せず raw に保持する
  const vector = claimVector("cbor_cat_version_uri");
  const value = decodeCbor(decodeHex(vector.payloadHex));
  const claims = decodeCatClaims(value, CLAIM_LABELS);
  assert.deepEqual(getCatClaim(claims, CLAIM_CAT_VERSION), cborUnsigned(1n));
  assert.deepEqual(encodeCatClaims(claims, CLAIM_LABELS), value);
});

test("付録 A.2 の cbor_catu_with_moqt は catu を raw、moqt を型付きで解釈する", () => {
  // 312 (catu) は CTA-5007 の URI クレームであり、CAT の型付きフィールドではない。
  // 一方 -65537 は付録 A の検証用 preset の moqt label である。同じ claim set に
  // 両方が載る場合、catu は raw に保持し、moqt だけを型付きで解釈する
  const vector = claimVector("cbor_catu_with_moqt");
  const value = decodeCbor(decodeHex(vector.payloadHex));
  const claims = decodeCatClaims(value, CLAIM_LABELS);

  // catu は raw にそのまま残る
  assert.deepEqual(
    getCatClaim(claims, CLAIM_CAT_URI),
    cborMapGet(value, cborInteger(CLAIM_CAT_URI)),
    "catu は raw に保持される",
  );

  // moqt は型付きで解釈される。付録 A.2 の EDN は
  // {0: [[[4, 7], [h'6578616d706c652e636f6d', h'766f64']]]} である
  const moqt = claims.moqt;
  assert.ok(moqt !== undefined, "moqt が型付きで解釈される");
  assert.equal(moqt.scopes.length, 1);
  const scope = moqt.scopes[0];
  assert.ok(scope !== undefined);
  assert.deepEqual(scope.actions, [4, 7]);
  assert.deepEqual(scope.namespace, [
    namespaceMatchValue(exactMatch(TEXT_ENCODER.encode("example.com"))),
    namespaceMatchValue(exactMatch(TEXT_ENCODER.encode("vod"))),
  ]);
  assert.equal(scope.track, undefined);

  // 再エンコードは決定論的な CBOR のバイト列として原本と一致する
  assert.deepEqual(
    encodeCbor(encodeCatClaims(claims, CLAIM_LABELS)),
    encodeCbor(value),
    "再エンコードが原本と一致する",
  );
});

test("2^63 以上の整数 claim key は未知の claim として raw に保持する", async () => {
  // CWT の claim key は CBOR の整数 (major type 0 / 1) であり、i64 に限らない。
  // 2^63 以上を unexpectedType にすると、将来の整数 key を未知の claim として
  // 無視できなくなる
  const bigKey = 9_223_372_036_854_775_808n;
  const value = cborTextString("future-claim");
  const decoded = decodeCatClaims(cborMap([[cborUnsigned(bigKey), value]]), CLAIM_LABELS);
  assert.deepEqual(getCatClaim(decoded, bigKey), value);

  // encode でも同じ値を raw として受理し、往復する
  const claims = createCatClaims();
  claims.raw.push([cborUnsigned(bigKey), value]);
  const encoded = encodeCatClaims(claims, CLAIM_LABELS);
  assert.deepEqual(cborMapGet(encoded, cborUnsigned(bigKey)), value);
  assert.deepEqual(decodeCatClaims(encoded, CLAIM_LABELS), claims);

  // builder も number では表せない key を bigint で受け付け、発行したトークンの
  // デコード後も raw に残る
  const tokenBytes = await new CatTokenBuilder({ claimLabels: CLAIM_LABELS })
    .claim(bigKey, value)
    .buildCose(cryptoImpl, hmacKey());
  const token = CatToken.decode(tokenBytes, CLAIM_LABELS);
  assert.deepEqual(getCatClaim(token.claims(), bigKey), value);
});

test("2^63 以上の confirmation label は未知の method として raw に保持する", () => {
  // decodeConfirmation の label も i64 に限らない。2^63 以上は ckt / jkt ではない
  // 未知の confirmation method として raw に残し、型付きフィールドへ読み替えない
  const bigLabel = cborUnsigned(9_223_372_036_854_775_808n);
  const value = cborTextString("future-method");
  const confirmation = decodeConfirmation(cborMap([[bigLabel, value]]));
  assert.deepEqual(confirmation.raw, [[bigLabel, value]]);
  assert.equal(confirmation.ckt, undefined);
  assert.equal(confirmation.jkt, undefined);
  assert.deepEqual(decodeConfirmation(encodeConfirmation(confirmation)), confirmation);
});

test("claims のデコードエラーは CatError に揃い、キー種別はエンコードでも拒否する", () => {
  // moqt クレームの不正は下位モジュールでは C4mError だが、decodeCatClaims は CatError で返す。
  // C4M 02 §2.1 の claim は CBOR map で、key 0 が scope 配列になる。
  const emptyScopes = cborMap([
    [cborInteger(CLAIM_LABELS.moqt), cborMap([[cborInteger(0), cborArray([])]])],
  ]);
  const wrapped = assertCatError(() => decodeCatClaims(emptyScopes, CLAIM_LABELS), "c4m");
  assert.ok(wrapped.cause instanceof C4mError, "C4mError が cause に入っている");
  assert.equal(
    (wrapped.cause as C4mError).code,
    "emptyScopes",
    "emptyScopes は CAT 層でも C4mError のまま伝わる",
  );

  // draft-ietf-moq-c4m-02 §2.1.1: 未知の map key を持つ claim は claim set 全体の拒否になる
  const unknownKey = cborMap([
    [
      cborInteger(CLAIM_LABELS.moqt),
      cborMap([
        [cborInteger(0), cborArray([cborArray([cborArray([cborInteger(4)])])])],
        [cborInteger(1), cborUnsigned(0n)],
      ]),
    ],
  ]);
  const rejected = assertCatError(() => decodeCatClaims(unknownKey, CLAIM_LABELS), "c4m");
  assert.ok(rejected.cause instanceof C4mError, "C4mError が cause に入っている");
  assert.equal(
    (rejected.cause as C4mError).code,
    "unknownClaimKey",
    "未知の key は claim set 全体の拒否になる",
  );

  // 整数でもテキスト文字列でもない claim key はエンコードでも拒否する
  const invalidKey = createCatClaims();
  invalidKey.raw.push([cborFloat(1.5), cborTextString("x")]);
  assertCatError(() => encodeCatClaims(invalidKey, CLAIM_LABELS), "unexpectedType", "claim key");

  // 未知の整数キーとテキスト文字列キーは往復する
  const raw = createCatClaims();
  raw.raw.push([cborInteger(1000), cborTextString("x")]);
  raw.raw.push([cborTextString("custom"), cborUnsigned(1n)]);
  assert.deepEqual(decodeCatClaims(encodeCatClaims(raw, CLAIM_LABELS), CLAIM_LABELS), raw);
});

test("旧 claim label 327 / 328 は moqt / moqt-reval として解釈しない", async () => {
  // C4M 01 では 327 / 328 が moqt / moqt-reval だった。C4M 02 の検証用 preset
  // (-65537 / -65538) を使う場合も、旧 label を型付きクレームへ読み替えない。
  // 327 には旧形式 (scope 配列を直接持つ) の moqt claim を載せる。
  const oldMoqt = cborArray([cborArray([cborArray([cborInteger(4)])])]);
  const oldReval = cborInteger(300);
  const claims = decodeCatClaims(
    cborMap([
      [cborInteger(327), oldMoqt],
      [cborInteger(328), oldReval],
    ]),
    CLAIM_LABELS,
  );
  assert.equal(claims.moqt, undefined, "327 は moqt として解釈しない");
  assert.equal(claims.moqtReval, undefined, "328 は moqt-reval として解釈しない");
  assert.deepEqual(getCatClaim(claims, 327), oldMoqt, "327 の値は raw に残る");
  assert.deepEqual(getCatClaim(claims, 328), oldReval, "328 の値は raw に残る");

  const namespace = [TEXT_ENCODER.encode("example.com")];
  const trackName = TEXT_ENCODER.encode("video-hd");
  for (const action of MOQT_ACTIONS) {
    assert.equal(
      authorizeCatClaims(claims, action, namespace, trackName),
      false,
      `旧 label の claim set が ${action} を許可した`,
    );
  }

  // トークン経路でも同じであることを固定する。旧 label はビルダーの raw クレームと
  // してだけ載り、decode 後も型付きフィールドへ昇格しない。
  const tokenBytes = await new CatTokenBuilder({ claimLabels: CLAIM_LABELS })
    .claim(327, oldMoqt)
    .claim(328, oldReval)
    .buildCose(cryptoImpl, hmacKey());
  const token = CatToken.decode(tokenBytes, CLAIM_LABELS);
  const tokenClaims = token.claims();
  assert.equal(tokenClaims.moqt, undefined, "トークンの 327 は moqt として解釈しない");
  assert.equal(tokenClaims.moqtReval, undefined, "トークンの 328 は moqt-reval として解釈しない");
  assert.deepEqual(getCatClaim(tokenClaims, 327), oldMoqt, "トークンの 327 の値は raw に残る");
  assert.deepEqual(getCatClaim(tokenClaims, 328), oldReval, "トークンの 328 の値は raw に残る");
  for (const action of MOQT_ACTIONS) {
    assert.equal(
      authorizeCatClaims(tokenClaims, action, namespace, trackName),
      false,
      `旧 label のトークンが ${action} を許可した`,
    );
  }
});

test("未知の raw claim は認可判断に使わず moqt だけで判定する", () => {
  // RFC 8392 Section 3: 理解できない claim は無視する。authorizeCatClaims は
  // claims.moqt だけを見るため、未知 key 0 以外の raw claim は認可を広げも狭めもしない。
  // 将来 Composite Claims (or / and / nor) に key が割り当てられた場合は、
  // この挙動が過剰認可になり得るため fail-closed へ変更する必要がある。crit は
  // draft-lemmons-cose-composite-claims で複合クレーム自体ではないと定義される
  // 関連クレームであり、同じく fail-closed の対象にする必要がある
  const claims = createCatClaims();
  // 外側の moqt は Subscribe をすべての namespace / track に対して許可する
  claims.moqt = { scopes: [createMoqtScope(["Subscribe"])] };
  // 未知の claim に「何も許可しない」ように見える値を置いても、認可には影響しない
  const unknownValue = cborMap([[cborInteger(0), cborArray([])]]);
  claims.raw.push([cborInteger(1000), unknownValue]);
  const namespace = [TEXT_ENCODER.encode("example.com")];
  const trackName = TEXT_ENCODER.encode("video");

  // moqt が許可するアクションは raw に関係なく許可する
  assert.equal(authorizeCatClaims(claims, "Subscribe", namespace, trackName), true);
  // moqt が許可しないアクションは、raw に許可に見える値があっても許可しない
  assert.equal(authorizeCatClaims(claims, "Publish", namespace, trackName), false);

  // トークンのデコード経路でも未知の key は raw に残り、同じ判定になる
  const decoded = decodeCatClaims(encodeCatClaims(claims, CLAIM_LABELS), CLAIM_LABELS);
  assert.deepEqual(getCatClaim(decoded, 1000), unknownValue);
  assert.equal(authorizeCatClaims(decoded, "Subscribe", namespace, trackName), true);
  assert.equal(authorizeCatClaims(decoded, "Publish", namespace, trackName), false);
});

test("cnf を持つ claims は DPoP proof を検証済みと明示しない限り認可しない", () => {
  // draft-ietf-moq-c4m-02 Section 4.1: 有効な DPoP proof が伴わない限り、MOQT
  // アクションに対して cnf クレームを含むトークンを受け入れてはならない (MUST NOT)。
  // 本ライブラリは proof を検証しないため、既定では拒否する (fail-closed)
  const namespace = [TEXT_ENCODER.encode("example.com")];
  const trackName = TEXT_ENCODER.encode("video-hd");
  const claims = createCatClaims();
  claims.moqt = { scopes: [createMoqtScope(["Publish"])] };

  // cnf が無ければ従来どおり認可する
  assert.equal(authorizeCatClaims(claims, "Publish", namespace, trackName), true);

  // jkt (confirmation key 323) を持つ cnf を加えると、既定では認可しない
  const confirmation = createConfirmation();
  confirmation.jkt = new Uint8Array(32).fill(0x17);
  claims.confirmation = confirmation;
  assert.equal(authorizeCatClaims(claims, "Publish", namespace, trackName), false);
  assert.equal(
    authorizeCatClaims(claims, "Publish", namespace, trackName, { dpopProofVerified: false }),
    false,
  );
  // proof を検証済みと明示した場合だけ、moqt クレームの判定結果を返す。
  // draft-ietf-moq-c4m-02 Section 4.4 の「proof はちょうど 1 つの MOQT action を
  // 認可する」に従い、同じ claims でも moqt の scope 外の action は認可しない
  assert.equal(
    authorizeCatClaims(claims, "Publish", namespace, trackName, { dpopProofVerified: true }),
    true,
  );
  assert.equal(
    authorizeCatClaims(claims, "Subscribe", namespace, trackName, { dpopProofVerified: true }),
    false,
  );

  // トークンのデコード経路でも同じである。cnf.jkt を持つトークンは proof 未検証の
  // 既定では認可されず、検証済みと明示した場合だけ認可される
  const encoded = encodeCatClaims(claims, CLAIM_LABELS);
  const decoded = decodeCatClaims(encoded, CLAIM_LABELS);
  assert.deepEqual(decoded.confirmation?.jkt, confirmation.jkt);
  assert.equal(authorizeCatClaims(decoded, "Publish", namespace, trackName), false);
  assert.equal(
    authorizeCatClaims(decoded, "Publish", namespace, trackName, { dpopProofVerified: true }),
    true,
  );
});

test("moqtClaimAuthorize は cnf を考慮せず scope だけで判定する", () => {
  // moqtClaimAuthorize はスコープレベルの述語であり、cnf / DPoP proof / 期限 /
  // audience / moqt-reval を検証しない。認可判断には authorizeCatClaims を使う。
  // その注意書きがコードと一致することを、cnf 付き claims で固定する
  const claims = createCatClaims();
  claims.moqt = { scopes: [createMoqtScope(["Publish"])] };
  const confirmation = createConfirmation();
  confirmation.jkt = new Uint8Array(32).fill(0x17);
  claims.confirmation = confirmation;
  const namespace = [TEXT_ENCODER.encode("example.com")];
  const trackName = TEXT_ENCODER.encode("video-hd");

  assert.ok(claims.moqt !== undefined);
  assert.equal(
    moqtClaimAuthorize(claims.moqt, "Publish", namespace, trackName),
    true,
    "moqtClaimAuthorize は cnf があっても scope だけで true を返す",
  );
  // authorizeCatClaims は proof を検証済みと明示しない cnf 付き claims を拒否する
  assert.equal(authorizeCatClaims(claims, "Publish", namespace, trackName), false);
});

test("cnf が ckt / jkt を持たない場合は dpopProofVerified が true でも認可しない", () => {
  // draft-ietf-moq-c4m-02 Section 4.3 は、proof の kccs の鍵がトークンの cnf と
  // 一致することを認可の条件にしている (条件 4)。cnf が ckt / jkt を持たなければ
  // 鍵の一致を確認できないため、呼び出し側が proof を検証済みと表明しても
  // 認可しない (fail-closed)
  const namespace = [TEXT_ENCODER.encode("example.com")];
  const trackName = TEXT_ENCODER.encode("video-hd");

  // 空の cnf を持つ claims
  const emptyConfirmation = createCatClaims();
  emptyConfirmation.moqt = { scopes: [createMoqtScope(["Publish"])] };
  emptyConfirmation.confirmation = createConfirmation();
  assert.equal(authorizeCatClaims(emptyConfirmation, "Publish", namespace, trackName), false);
  assert.equal(
    authorizeCatClaims(emptyConfirmation, "Publish", namespace, trackName, {
      dpopProofVerified: true,
    }),
    false,
  );

  // ckt / jkt ではない未知の confirmation method だけを持つ cnf も同じである。
  // key 3 は IANA で kid であり、ckt / jkt として読み替えない
  const unknownConfirmation = createCatClaims();
  unknownConfirmation.moqt = { scopes: [createMoqtScope(["Publish"])] };
  const confirmation = createConfirmation();
  confirmation.raw.push([cborInteger(3), cborByteString(new Uint8Array(32).fill(0x03))]);
  unknownConfirmation.confirmation = confirmation;
  assert.equal(authorizeCatClaims(unknownConfirmation, "Publish", namespace, trackName), false);
  assert.equal(
    authorizeCatClaims(unknownConfirmation, "Publish", namespace, trackName, {
      dpopProofVerified: true,
    }),
    false,
  );

  // ckt だけを持つ cnf は鍵の一致を確認できるため、これまでどおり認可する
  const cktConfirmation = createCatClaims();
  cktConfirmation.moqt = { scopes: [createMoqtScope(["Publish"])] };
  const ckt = createConfirmation();
  ckt.ckt = new Uint8Array(32).fill(0x05);
  cktConfirmation.confirmation = ckt;
  assert.equal(
    authorizeCatClaims(cktConfirmation, "Publish", namespace, trackName, {
      dpopProofVerified: true,
    }),
    true,
  );

  // デコード経路でも空の cnf は true では認可されない
  const decoded = decodeCatClaims(encodeCatClaims(emptyConfirmation, CLAIM_LABELS), CLAIM_LABELS);
  assert.equal(
    authorizeCatClaims(decoded, "Publish", namespace, trackName, { dpopProofVerified: true }),
    false,
  );
});

test("cnf の ckt (key 5) と jkt (key 323) を独立に往復する", () => {
  const ckt = new Uint8Array(32).fill(0x05);
  const jkt = new Uint8Array(32).fill(0x17);

  // ckt だけを持つ cnf
  const cktOnly = createConfirmation();
  cktOnly.ckt = ckt;
  const cktRoundTripped = decodeConfirmation(encodeConfirmation(cktOnly));
  assert.deepEqual(cktRoundTripped, cktOnly);
  assert.deepEqual(confirmationCkt(cktRoundTripped), ckt);
  assert.equal(confirmationJkt(cktRoundTripped), undefined, "ckt を jkt へ読み替えない");
  assert.deepEqual(
    cborMapGet(encodeConfirmation(cktOnly), cborInteger(CONFIRMATION_COSE_KEY_THUMBPRINT)),
    cborByteString(ckt),
  );
  assert.equal(
    cborMapGet(encodeConfirmation(cktOnly), cborInteger(CONFIRMATION_JWK_THUMBPRINT)),
    undefined,
  );

  // jkt だけを持つ cnf
  const jktOnly = createConfirmation();
  jktOnly.jkt = jkt;
  const jktRoundTripped = decodeConfirmation(encodeConfirmation(jktOnly));
  assert.deepEqual(jktRoundTripped, jktOnly);
  assert.deepEqual(confirmationJkt(jktRoundTripped), jkt);
  assert.equal(confirmationCkt(jktRoundTripped), undefined, "jkt を ckt へ読み替えない");
  assert.deepEqual(
    cborMapGet(encodeConfirmation(jktOnly), cborInteger(CONFIRMATION_JWK_THUMBPRINT)),
    cborByteString(jkt),
  );
  assert.equal(
    cborMapGet(encodeConfirmation(jktOnly), cborInteger(CONFIRMATION_COSE_KEY_THUMBPRINT)),
    undefined,
  );
});

test("cnf の key 3 (kid) は jkt に読み替えず raw に保持する", () => {
  // IANA の CWT Confirmation Methods レジストリで 3 は kid であり、C4M 02 の
  // jkt (323) ではない。旧互換としてサムプリントを返さないことを固定する。
  const key3Value = new Uint8Array(32).fill(0x03);
  const value = cborMap([[cborInteger(3), cborByteString(key3Value)]]);
  const confirmation = decodeConfirmation(value);
  assert.equal(confirmation.ckt, undefined);
  assert.equal(confirmation.jkt, undefined);
  assert.equal(confirmationCkt(confirmation), undefined);
  assert.equal(
    confirmationJkt(confirmation),
    undefined,
    "key 3 が confirmationJkt の結果にならない",
  );
  assert.deepEqual(confirmation.raw, [[cborInteger(3), cborByteString(key3Value)]]);

  // raw として往復し、key 323 へ書き換わらない
  assert.deepEqual(encodeConfirmation(confirmation), value);
  assert.equal(
    cborMapGet(encodeConfirmation(confirmation), cborInteger(CONFIRMATION_JWK_THUMBPRINT)),
    undefined,
  );
});

test("cnf の不正な Value 型を拒否する", () => {
  // cnf 自体が map でない
  assertCatError(() => decodeConfirmation(cborTextString("cnf")), "unexpectedType", "cnf");
  assertCatError(() => decodeConfirmation(cborArray([])), "unexpectedType", "cnf");
  assertCatError(() => decodeConfirmation(cborInteger(1)), "unexpectedType", "cnf");

  // ckt / jkt の値がバイト文字列でない
  const typedKeys = [
    [CONFIRMATION_COSE_KEY_THUMBPRINT, "ckt"],
    [CONFIRMATION_JWK_THUMBPRINT, "jkt"],
  ] as const;
  const invalidValues = [cborTextString("x"), cborInteger(1), cborArray([]), cborMap([])];
  for (const [key, name] of typedKeys) {
    for (const value of invalidValues) {
      assertCatError(
        () => decodeConfirmation(cborMap([[cborInteger(key), value]])),
        "unexpectedType",
        name,
      );
    }
  }
});

test("cnf の未知の key は意味を変えずに raw へ保持する", () => {
  // 未知の整数 key、テキスト key、および任意の Value 型を raw に保持する
  const entries: Array<[CborValue, CborValue]> = [
    [cborInteger(1000), cborTextString("unknown")],
    [cborTextString("custom"), cborArray([cborInteger(1)])],
    [cborInteger(1001), cborMap([[cborInteger(0), cborByteString(new Uint8Array([1, 2, 3]))]])],
  ];
  const confirmation = decodeConfirmation(cborMap(entries));
  assert.equal(confirmation.ckt, undefined);
  assert.equal(confirmation.jkt, undefined);
  assert.deepEqual(confirmation.raw, entries);
  assert.deepEqual(encodeConfirmation(confirmation), cborMap(entries));
});

test("cnf の複数の confirmation を優先順位なしで保持する", () => {
  // ckt と jkt と未知 key (key 3 を含む) が同居しても、どちらかを他方へ読み替えたり
  // 上書きしたりしない
  const ckt = new Uint8Array(32).fill(0x05);
  const jkt = new Uint8Array(32).fill(0x17);
  const key3Value = new Uint8Array(32).fill(0x03);
  const unknown = cborTextString("unknown");
  const entries: Array<[CborValue, CborValue]> = [
    [cborInteger(CONFIRMATION_COSE_KEY_THUMBPRINT), cborByteString(ckt)],
    [cborInteger(CONFIRMATION_JWK_THUMBPRINT), cborByteString(jkt)],
    [cborInteger(3), cborByteString(key3Value)],
    [cborInteger(1000), unknown],
  ];
  const confirmation = decodeConfirmation(cborMap(entries));
  assert.deepEqual(confirmation.ckt, ckt);
  assert.deepEqual(confirmation.jkt, jkt);
  assert.deepEqual(confirmation.raw, [
    [cborInteger(3), cborByteString(key3Value)],
    [cborInteger(1000), unknown],
  ]);
  assert.deepEqual(confirmationCkt(confirmation), ckt);
  assert.deepEqual(confirmationJkt(confirmation), jkt);
  assert.deepEqual(decodeConfirmation(encodeConfirmation(confirmation)), confirmation);
});

test("cnf の confirmation key の重複を拒否する", () => {
  // decodeConfirmation は CborValue を直接受ける公開 API のため、CBOR 層を通らない
  // 手組みの map でも重複を拒否する。後から来た値で先の値を黙って上書きしない。
  for (const key of [CONFIRMATION_COSE_KEY_THUMBPRINT, CONFIRMATION_JWK_THUMBPRINT, 3, 1000]) {
    const duplicated = cborMap([
      [cborInteger(key), cborByteString(new Uint8Array([1]))],
      [cborInteger(key), cborByteString(new Uint8Array([2]))],
    ]);
    assertCatError(() => decodeConfirmation(duplicated), "duplicateConfirmation");
  }

  // 手組みの map でも、ワイヤ経路 (CBOR 層) と同じキーの等価判定を使う。
  // -0.0 と 0.0、NaN 同士、キーの順序だけが違う map は同じキーになる
  // (RFC 8949 Section 5.6.1 / Section 4.2.1)
  const equivalentKeyPairs: ReadonlyArray<readonly [CborValue, CborValue]> = [
    [cborFloat(0), cborFloat(-0)],
    [cborFloat(Number.NaN), cborFloat(Number.NaN)],
    [
      cborMap([
        [cborInteger(1), cborInteger(2)],
        [cborInteger(3), cborInteger(4)],
      ]),
      cborMap([
        [cborInteger(3), cborInteger(4)],
        [cborInteger(1), cborInteger(2)],
      ]),
    ],
  ];
  for (const [left, right] of equivalentKeyPairs) {
    const duplicated = cborMap([
      [left, cborInteger(1)],
      [right, cborInteger(2)],
    ]);
    assertCatError(() => decodeConfirmation(duplicated), "duplicateConfirmation");
  }

  // 型付きの key を raw に置いても、デコード時の解釈が曖昧になるため拒否する
  for (const key of [CONFIRMATION_COSE_KEY_THUMBPRINT, CONFIRMATION_JWK_THUMBPRINT]) {
    const confirmation = createConfirmation();
    confirmation.raw.push([cborInteger(key), cborByteString(new Uint8Array([1]))]);
    assertCatError(() => encodeConfirmation(confirmation), "duplicateConfirmation");
  }

  // raw 同士の重複も、デコード側と同じ判定で拒否する。cborMap の構築では重複を
  // 検出しないため、encodeConfirmation が明示的に検査する
  for (const key of [3, 1000]) {
    const confirmation = createConfirmation();
    confirmation.raw.push([cborInteger(key), cborByteString(new Uint8Array([1]))]);
    confirmation.raw.push([cborInteger(key), cborByteString(new Uint8Array([2]))]);
    assertCatError(() => encodeConfirmation(confirmation), "duplicateConfirmation");
  }

  // 空の cnf は空のマップとして往復する
  assert.deepEqual(encodeConfirmation(createConfirmation()), cborMap([]));
  const claims = createCatClaims();
  claims.confirmation = createConfirmation();
  const encoded = encodeCatClaims(claims, CLAIM_LABELS);
  assert.deepEqual(cborMapGet(encoded, cborInteger(CLAIM_CONFIRMATION)), cborMap([]));
});

test("cnf のエンコードできない key は重複判定から除外せず拒否する", () => {
  // 手組みの CborValue では、ワイヤ上に現れないエンコード不能な key を作れる。
  // 重複判定がその key を黙って除外すると、同じ key の重複が検査をすり抜けて
  // raw に残る。fail-open を避けるため CborError を伝播する
  assertCborError(
    () => decodeConfirmation(cborMap([[cborSimple(20), cborByteString(new Uint8Array([1]))]])),
    "invalidSimpleValue",
  );
  assertCborError(
    () =>
      decodeConfirmation(
        cborMap([
          [cborSimple(20), cborByteString(new Uint8Array([1]))],
          [cborSimple(20), cborByteString(new Uint8Array([2]))],
        ]),
      ),
    "invalidSimpleValue",
  );

  // claim set の経路でも、CborError が CatError("cbor") に揃って拒否される
  const error = assertCatError(
    () =>
      decodeCatClaims(
        cborMap([
          [
            cborInteger(CLAIM_CONFIRMATION),
            cborMap([[cborSimple(20), cborByteString(new Uint8Array([1]))]]),
          ],
        ]),
        CLAIM_LABELS,
      ),
    "cbor",
  );
  assert.ok(error.cause instanceof Error, "CborError が cause に入っている");
  assert.equal((error.cause as { code?: string }).code, "invalidSimpleValue");

  // encodeConfirmation の raw に置いた場合も同じく拒否する
  const confirmation = createConfirmation();
  confirmation.raw.push([cborSimple(20), cborByteString(new Uint8Array([1]))]);
  assertCborError(() => encodeConfirmation(confirmation), "invalidSimpleValue");
});

test("既定のクレームセットは空である", () => {
  const claims = createCatClaims();
  assert.equal(claims.issuer, undefined);
  assert.deepEqual(claims.audience, []);
  assert.deepEqual(encodeCatClaims(claims, CLAIM_LABELS), cborMap([]));
  assert.equal(claims.moqt, undefined);
  assert.equal(getCatClaim(claims, CLAIM_ISSUER), undefined);
});

test("タグの付与オプションを尊重する", async () => {
  // 既定では CWT タグ (61) と COSE タグ (17) が付く
  const taggedBytes = await new CatTokenBuilder({ claimLabels: CLAIM_LABELS })
    .issuer("https://auth.example.com")
    .buildCose(cryptoImpl, hmacKey());
  assert.equal(taggedBytes[0], 0xd8);
  assert.equal(taggedBytes[1], 0x3d);
  assert.equal(taggedBytes[2], 0xd1);

  // coseTag / cwtTag に false を指定するとタグが付かない。
  // HMAC は決定的なので、タグ以外のバイト列は既定の出力と一致する。
  const untaggedBytes = await new CatTokenBuilder({ claimLabels: CLAIM_LABELS })
    .issuer("https://auth.example.com")
    .buildCoseWith(cryptoImpl, hmacKey(), { coseTag: false, cwtTag: false });
  assert.deepEqual(untaggedBytes, taggedBytes.subarray(3));

  // タグが無くても COSE_Mac0 としてデコードして検証できる
  const token = CatToken.decode(untaggedBytes, CLAIM_LABELS);
  assert.equal(token.format(), "coseMac0");
  await token.verify(cryptoImpl, hmacKey());
});

test("すべてのアルゴリズムで署名と検証を往復できる", async () => {
  // HMAC 384 / 512
  const hmacCases: Array<[Algorithm, CoseKey]> = [
    ["HmacSha384", symmetricKey(new Uint8Array(48).fill(0xcd))],
    ["HmacSha512", symmetricKey(new Uint8Array(64).fill(0xef))],
  ];
  for (const [algorithm, key] of hmacCases) {
    const tokenBytes = await new CatTokenBuilder({ claimLabels: CLAIM_LABELS })
      .issuer("https://auth.example.com")
      .algorithm(algorithm)
      .buildCose(cryptoImpl, key);
    const token = CatToken.decode(tokenBytes, CLAIM_LABELS);
    assert.equal(token.header().algorithm, algorithm);
    await token.verify(cryptoImpl, key);
  }

  // ES384 / ES512 (鍵はテスト専用に生成した固定値)
  const ecdsaCases: Array<["Es384" | "Es512", "P384" | "P521", string, string, string]> = [
    [
      "Es384",
      "P384",
      "ce7de2ef769603fc91f4682efeedc9e415b221a79067153a31d8f2f62d14044e18be87058146596041b2148233ed4073",
      "8a69f5b6b5bdb0200d39bf760420a3da5bf091b8e81557f5cb4d37f7ce36f7a07fb1119a736e2385d75e4c3f5ca604e7",
      "e3129db6c869a183e6ed6abc233723f7339b94e38c38bdde7c19d4674c5c2730eca7680ac6afa8d660810a8adead31e2",
    ],
    [
      "Es512",
      "P521",
      "00518dbde5592773706f05f885b3c70b5b55c8d5fb00ed301714176827b36464b3fa5547e2e5b39abb7addb9648f556ef5319d866a927de7cf9d127f0040a98601b9",
      "010ddbdde03abcbad3ea82185af075133e30babc436411af7cdb4503127df46d82f828d4e91692a821886e7ddc614e476dd467d907691e0c2e7910660725f9999876",
      "01d1498cdca88097c4f581b05475494b5676aeb926a07dbd26093f99f8136cc572fe9fc8d03238d42b2af0a5b9dce17e615534029fd358a848873aff02bb9a470f76",
    ],
  ];
  for (const [algorithm, curve, x, y, d] of ecdsaCases) {
    const privateKey = ec2KeyWithPrivateKey(curve, decodeHex(x), decodeHex(y), decodeHex(d));
    const publicKey = ec2Key(curve, decodeHex(x), decodeHex(y));
    const tokenBytes = await new CatTokenBuilder({ claimLabels: CLAIM_LABELS })
      .issuer("https://auth.example.com")
      .buildCose(cryptoImpl, privateKey);
    const token = CatToken.decode(tokenBytes, CLAIM_LABELS);
    assert.equal(token.header().algorithm, algorithm);
    await token.verify(cryptoImpl, publicKey);
  }
});

test("付録 A の全ベクタトークンの MAC / 署名を検証できる", async () => {
  for (const vector of DPOP_VECTORS) {
    const token = CatToken.decode(decodeHex(vector.coseHex), CLAIM_LABELS);
    const key = vector.algorithmId === 5 ? hmacKey() : es256PublicKey();
    await token.verify(cryptoImpl, key);
  }
  for (const vector of SCOPE_VECTORS) {
    const token = CatToken.decode(decodeHex(vector.coseHex), CLAIM_LABELS);
    await token.verify(cryptoImpl, hmacKey());
  }
  await verifyValidationVectorTokens();
});

test("非有限の数値クレームを拒否する", () => {
  const cases: Array<[number, ReturnType<typeof cborFloat>, string]> = [
    [CLAIM_EXPIRATION, cborFloat(Number.NaN), "exp"],
    [CLAIM_NOT_BEFORE, cborFloat(Infinity), "nbf"],
    [CLAIM_ISSUED_AT, cborFloat(-Infinity), "iat"],
    [CLAIM_LABELS.moqtReval, cborFloat(Number.NaN), "moqt-reval"],
  ];
  for (const [claim, value, name] of cases) {
    assertCatError(
      () => decodeCatClaims(cborMap([[cborInteger(claim), value]]), CLAIM_LABELS),
      "nonFiniteNumber",
      name,
    );
  }
});

test("型付きキーは未設定でも raw に置くと拒否する", () => {
  // 型付きフィールドが未設定でも raw に置くと decode と encode で解釈が曖昧になる
  const claims = createCatClaims();
  claims.raw.push([cborInteger(CLAIM_EXPIRATION), cborTextString("x")]);
  assertCatError(
    () => encodeCatClaims(claims, CLAIM_LABELS),
    "duplicateClaim",
    BigInt(CLAIM_EXPIRATION),
  );
});

test("catdpop の負のウィンドウと boolean 以外の honorJti を拒否する", () => {
  // CatDpop のフィールドは公開のため、デコード以外の経路で値域外の値が入り得る。
  // decodeCatDpop / encodeCatDpop と同じ規則で validateCatClaims も拒否する
  const negativeWindow = createCatClaims();
  negativeWindow.catdpop = createCatDpop(-1, false);
  assertClaimValidationError(
    () => validateCatClaims(negativeWindow, { referenceTimeSeconds: 0 }),
    "invalidCatDpopWindow",
  );

  const invalidHonorJti = createCatClaims();
  invalidHonorJti.catdpop = {
    windowSeconds: 60,
    // TypeScript の型では boolean だが、JavaScript からは任意の値が入り得るため
    // 実行時の検証を固定する
    honorJti: 2 as unknown as boolean,
    raw: [],
  };
  assertClaimValidationError(
    () => validateCatClaims(invalidHonorJti, { referenceTimeSeconds: 0 }),
    "invalidCatDpopHonorJti",
  );

  // 0 秒のウィンドウと true / false は有効である
  const valid = createCatClaims();
  valid.catdpop = createCatDpop(0, true);
  validateCatClaims(valid, { referenceTimeSeconds: 0 });
  valid.catdpop = createCatDpop(60, false);
  validateCatClaims(valid, { referenceTimeSeconds: 0 });
});

test("ビルダーは非有限のタイムスタンプを拒否する", async () => {
  const runCose = async (): Promise<unknown> =>
    new CatTokenBuilder({ claimLabels: CLAIM_LABELS })
      .notBefore(Infinity)
      .buildCose(cryptoImpl, hmacKey());
  const coseError = await captureRejectedError(runCose);
  assert.ok(coseError instanceof CatError);
  assert.equal(coseError.code, "nonFiniteNumber");

  const runReval = async (): Promise<unknown> =>
    new CatTokenBuilder({ claimLabels: CLAIM_LABELS })
      .moqtReval(Number.NaN)
      .buildCose(cryptoImpl, hmacKey());
  const revalError = await captureRejectedError(runReval);
  assert.ok(revalError instanceof CatError);
  assert.equal(revalError.code, "nonFiniteNumber");

  const runDpop = async (): Promise<unknown> =>
    new CatTokenBuilder({ claimLabels: CLAIM_LABELS })
      .catdpop(Number.NaN, true)
      .buildCose(cryptoImpl, hmacKey());
  const dpopError = await captureRejectedError(runDpop);
  assert.ok(dpopError instanceof CatError);
  assert.equal(dpopError.code, "c4m");
});

test("ビルダーの設定メソッドを確認する", async () => {
  const keyId: CoseKeyId = { type: "text", value: "key-1" };
  const tokenBytes = await new CatTokenBuilder({ claimLabels: CLAIM_LABELS })
    .issuer("https://auth.example.com")
    .subject("user:alice")
    .audience("https://relay.example.com")
    .issuedAt(1700000000)
    .cwtId(TEXT_ENCODER.encode("id-1"))
    .ckt(new Uint8Array(32).fill(0x01))
    .jkt(new Uint8Array(32).fill(0x03))
    .typ("CAT")
    .keyId(keyId)
    .claim(CLAIM_CAT_VERSION, cborTextString("CAT-v1"))
    .buildCose(cryptoImpl, hmacKey());
  const token = CatToken.decode(tokenBytes, CLAIM_LABELS);
  const decoded = token.claims();
  assert.equal(decoded.subject, "user:alice");
  assert.equal(decoded.issuedAt, 1700000000);
  assert.deepEqual(decoded.cwtId, TEXT_ENCODER.encode("id-1"));
  assert.deepEqual(decoded.confirmation?.ckt, new Uint8Array(32).fill(0x01));
  assert.deepEqual(decoded.confirmation?.jkt, new Uint8Array(32).fill(0x03));
  assert.deepEqual(getCatClaim(decoded, CLAIM_CAT_VERSION), cborTextString("CAT-v1"));
  await token.verify(cryptoImpl, hmacKey());
  assert.deepEqual(token.header().typ, cborTextString("CAT"));
});

test("ビルダーの options は配列と関数を claimLabels の設定エラーとして拒否する", () => {
  // typeof [] === "object" のため、配列を options として受理すると claimLabels を
  // 配列のプロパティから読むことになる。関数も object ではないため拒否する
  const arrayOptions = Object.assign([], { claimLabels: CLAIM_LABELS });
  const functionOptions = Object.assign(() => undefined, { claimLabels: CLAIM_LABELS });
  assertCatError(
    () => new CatTokenBuilder(arrayOptions as unknown as CatTokenBuilderOptions),
    "invalidClaimLabels",
  );
  assertCatError(
    () => new CatTokenBuilder(functionOptions as unknown as CatTokenBuilderOptions),
    "invalidClaimLabels",
  );
});

test("claim key 0 を raw に置いた builder は buildCose で invalidClaimKey になる", async () => {
  // claim key 0 は RFC 8392 Section 9.1.2 が RESERVED として予約している。ビルダー
  // の設定では受け付け、発行時に encodeCatClaims が invalidClaimKey で拒否する
  const builder = new CatTokenBuilder({ claimLabels: CLAIM_LABELS }).claim(0, cborTextString("x"));
  const coseError = await captureRejectedError(() => builder.buildCose(cryptoImpl, hmacKey()));
  assert.ok(coseError instanceof CatError);
  assert.equal(coseError.code, "invalidClaimKey");
  assert.equal(coseError.detail, 0n);
});

test("Token Value の CBOR を直接デコードできる", () => {
  const vector = TOKEN_VECTORS[0];
  assert.ok(vector !== undefined);
  const cose = CatToken.decode(decodeHex(vector.coseHex), CLAIM_LABELS);
  // COSE の payload (claims の CBOR map) を Token Type 1 の Token Value として
  // 渡すと、COSE 構造ではないため形式エラーになる
  assertCatError(
    () => CatToken.decodeMoqtAuthToken(MOQT_AUTH_TOKEN_TYPE_CAT, cose.payload(), CLAIM_LABELS),
    "cose",
  );
  assert.deepEqual(CatToken.decode(cose.rawToken(), CLAIM_LABELS).claims(), cose.claims());
});

test("生トークンと署名は JSON 化で漏れない", () => {
  const vector = TOKEN_VECTORS[0];
  assert.ok(vector !== undefined);
  const token = CatToken.decode(decodeHex(vector.coseHex), CLAIM_LABELS);
  const serialized = JSON.stringify(token);
  assert.notInclude(serialized, vector.coseB64);
  assert.notInclude(serialized, vector.signatureHex);
});

test("typ は指定したときだけ検証する", () => {
  const vector = TOKEN_VECTORS[0];
  assert.ok(vector !== undefined);
  const token = CatToken.decode(decodeHex(vector.coseHex), CLAIM_LABELS);
  assert.deepEqual(token.header().typ, cborTextString(CAT_CONTENT_TYPE));
  assert.equal(CAT_CONTENT_TYPE, "CAT");
});

test("typ の不一致を拒否する", async () => {
  const tokenBytes = await new CatTokenBuilder({ claimLabels: CLAIM_LABELS })
    .issuer("https://auth.example.com")
    .typ("OTHER")
    .buildCose(cryptoImpl, hmacKey());
  const token = CatToken.decode(tokenBytes, CLAIM_LABELS);
  const error = await captureRejectedError(() =>
    token.verify(cryptoImpl, hmacKey(), { expectedType: CAT_CONTENT_TYPE }),
  );
  assert.ok(error instanceof CatError);
  assert.equal(error.code, "typeMismatch");
  // "OTHER" を期待すれば通る
  await token.verify(cryptoImpl, hmacKey(), { expectedType: "OTHER" });
});

/**
 * draft-ietf-moq-c4m-02 Section 2:
 * "When it must be cast to a string for inclusion in a URL, it is Base64 encoded"
 * `CatToken.decode` は生の COSE と Base64 / base64url で包んだ COSE を受理する。
 * 受理する表現を明示的に固定する。
 */
test("URL 埋め込みの COSE トークンは標準 Base64 も受理する", async () => {
  const tokenBytes = await new CatTokenBuilder({ claimLabels: CLAIM_LABELS })
    .issuer("https://auth.example.com")
    .buildCose(cryptoImpl, hmacKey());
  for (const text of [
    encodeBase64Standard(tokenBytes, true),
    encodeBase64Standard(tokenBytes, false),
  ]) {
    const token = CatToken.decode(TEXT_ENCODER.encode(text), CLAIM_LABELS);
    assert.equal(token.format(), "coseMac0");
    await token.verify(cryptoImpl, hmacKey());
  }
  // base64url も従来どおり受理する
  const urlText = encodeBase64Url(tokenBytes);
  assert.equal(CatToken.decode(TEXT_ENCODER.encode(urlText), CLAIM_LABELS).format(), "coseMac0");
});

// =============================================================================
// claim label 設定
// =============================================================================

test("付録 A の preset は Private Use の label を明示した読み取り専用の設定である", () => {
  // draft-ietf-moq-c4m-02 付録 A は IANA 未割当の moqt / moqt-reval の代わりに
  // Private Use (RFC 8392 Section 9.1.1 の -65536 未満) の値を placeholder に使う
  assert.equal(C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS.moqt, -65537);
  assert.equal(C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS.moqtReval, -65538);
  // 共有の preset を書き換えて暗黙の既定値にしない
  assert.equal(Object.isFrozen(C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS), true);
});

test("Private Use の label は signed CBOR integer として往復する", () => {
  // RFC 8949 Section 3.1: 負の整数は major type 1 で -1 - n を表す。
  // -65537 は n=65536 (0x00010000)、-65538 は n=65537 (0x00010001) を
  // 4 バイトの引数 (additional information 26) で持つ
  assert.equal(
    encodeHex(encodeCbor(cborInteger(C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS.moqt))),
    "3a00010000",
  );
  assert.equal(
    encodeHex(encodeCbor(cborInteger(C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS.moqtReval))),
    "3a00010001",
  );

  const scope = createMoqtScope(["Publish"]);
  scope.namespace.push(namespaceMatchValue(exactMatch(TEXT_ENCODER.encode("example.com"))));
  const claims = createCatClaims();
  claims.moqt = { scopes: [scope] };
  claims.moqtReval = 300;
  const encoded = encodeCatClaims(claims, C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS);
  const bytes = encodeCbor(encoded);
  const hex = encodeHex(bytes);
  // claim key が 4 バイトの負数として書かれている (別の表現に丸められていない)
  assert.include(hex, "3a00010000");
  assert.include(hex, "3a00010001");
  // 負数の key は cborMapGet でも型付きの key として一致する
  assert.notEqual(cborMapGet(encoded, cborInteger(-65537)), undefined);
  assert.notEqual(cborMapGet(encoded, cborInteger(-65538)), undefined);
  // CBOR のバイト列を経由しても同じ claims に戻る
  assert.deepEqual(decodeCatClaims(decodeCbor(bytes), C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS), claims);
});

test("COSE / MOQT Auth Token と builder に claim label 設定が伝搬する", async () => {
  const claims = createCatClaims();
  claims.issuer = "https://auth.example.com";
  claims.moqt = { scopes: [createMoqtScope(["Setup", "Publish"])] };
  claims.moqtReval = 60;

  // builder は設定を保持し、COSE 形式の発行に使う
  const builder = new CatTokenBuilder({ claims, claimLabels: CLAIM_LABELS });
  assert.deepEqual(builder.claimLabels, C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS);
  const coseBytes = await builder.buildCose(cryptoImpl, hmacKey());
  const cose = CatToken.decodeCose(coseBytes, CLAIM_LABELS);
  assert.deepEqual(cose.claims(), claims);
  await cose.verify(cryptoImpl, hmacKey());

  // MOQT Auth Token の入口と自動判別の入口にも同じ設定を渡す
  const authToken = CatToken.decodeMoqtAuthToken(MOQT_AUTH_TOKEN_TYPE_CAT, coseBytes, CLAIM_LABELS);
  assert.deepEqual(authToken.claims(), claims);
  const autoDetected = CatToken.decode(
    TEXT_ENCODER.encode(encodeBase64Url(coseBytes)),
    CLAIM_LABELS,
  );
  assert.deepEqual(autoDetected.claims(), claims);
});

test("claim label 設定はコピーされ、後から変更しても解釈が変わらない", async () => {
  const claims = createCatClaims();
  claims.moqt = { scopes: [createMoqtScope(["Setup"])] };
  claims.moqtReval = 60;

  // builder は設定元のオブジェクトを参照しない
  const builderSource = { moqt: -65537, moqtReval: -65538 };
  const builder = new CatTokenBuilder({ claims, claimLabels: builderSource });
  builderSource.moqt = -1000;
  builderSource.moqtReval = -1001;
  assert.deepEqual(builder.claimLabels, { moqt: -65537, moqtReval: -65538 });
  const tokenBytes = await builder.buildCose(cryptoImpl, hmacKey());

  // Token もデコード時に設定をコピーする
  const decodeSource = { moqt: -65537, moqtReval: -65538 };
  const token = CatToken.decode(tokenBytes, decodeSource);
  decodeSource.moqt = -1000;
  decodeSource.moqtReval = -1001;
  assert.deepEqual(token.claimLabels(), { moqt: -65537, moqtReval: -65538 });
  // コピーであること (設定元と同じオブジェクトではない)
  assert.notStrictEqual(token.claimLabels(), decodeSource);
  // 解釈済みの claims と署名検証は変更の影響を受けない
  assert.ok(token.claims().moqt !== undefined);
  assert.equal(token.claims().moqtReval, 60);
  await token.verify(cryptoImpl, hmacKey());
});

test("claim label 設定を省略した呼び出しは型の上で不正であり、実行時も拒否する", () => {
  // claimLabels はすべての入口で宣言上必須引数である。ただし tsconfig はテストを
  // 型検査の対象外にしているため、このテストの目的は型エラーの確認ではなく、
  // JavaScript から未指定のまま呼ばれた場合に invalidClaimLabels で拒否することの
  // 確認である。@ts-expect-error は将来テストを型検査へ含めたときの型エラーを表す
  // @ts-expect-error claimLabels は必須引数
  const decodeWithoutLabels = (): unknown => decodeCatClaims(cborMap([]));
  // @ts-expect-error claimLabels は必須引数
  const decodeTokenWithoutLabels = (): unknown => CatToken.decode(new Uint8Array(0));
  // @ts-expect-error claimLabels は必須引数
  const buildWithoutLabels = (): unknown => new CatTokenBuilder({});
  // builder の options 自体が無い / null の場合も、claims の読み出しで TypeError に
  // ならず、claimLabels の設定エラーとして拒否する
  // @ts-expect-error options は必須引数
  const buildWithoutOptions = (): unknown => new CatTokenBuilder();
  // @ts-expect-error options に null は渡せない
  const buildWithNullOptions = (): unknown => new CatTokenBuilder(null);
  assertCatError(decodeWithoutLabels, "invalidClaimLabels");
  assertCatError(decodeTokenWithoutLabels, "invalidClaimLabels");
  assertCatError(buildWithoutLabels, "invalidClaimLabels");
  assertCatError(buildWithoutOptions, "invalidClaimLabels");
  assertCatError(buildWithNullOptions, "invalidClaimLabels");
});

test("未指定・不正型・範囲外の claim label 設定を処理開始時に拒否する", () => {
  const claims = createCatClaims();
  const vector = TOKEN_VECTORS[0];
  assert.ok(vector !== undefined);
  const tokenBytes = decodeHex(vector.coseHex);
  // 型の上では必須引数だが、JavaScript からは未指定や不正な型が渡り得る
  const invalidLabels: unknown[] = [
    undefined,
    null,
    "moqt",
    1,
    [],
    {},
    { moqt: -65537 },
    { moqt: "-65537", moqtReval: -65538 },
    { moqt: -65537, moqtReval: "-65538" },
    { moqt: Number.NaN, moqtReval: -65538 },
    { moqt: -65537, moqtReval: Number.POSITIVE_INFINITY },
    { moqt: 1.5, moqtReval: -65538 },
    // 安全な整数でない値は CBOR の整数として正確に往復できない
    { moqt: 2 ** 53, moqtReval: -65538 },
    { moqt: -65537, moqtReval: -(2 ** 53) },
  ];
  for (const labels of invalidLabels) {
    const broken = labels as C4mClaimLabels;
    assertCatError(() => decodeCatClaims(cborMap([]), broken), "invalidClaimLabels");
    assertCatError(() => encodeCatClaims(claims, broken), "invalidClaimLabels");
    assertCatError(() => new CatTokenBuilder({ claimLabels: broken }), "invalidClaimLabels");
    assertCatError(() => CatToken.decode(tokenBytes, broken), "invalidClaimLabels");
    assertCatError(() => CatToken.decodeCose(tokenBytes, broken), "invalidClaimLabels");
    assertCatError(
      () => CatToken.decodeMoqtAuthToken(MOQT_AUTH_TOKEN_TYPE_CAT, tokenBytes, broken),
      "invalidClaimLabels",
    );
  }

  // 設定の検証は入力の解釈より先に行う。トークンとして不正な入力でも、
  // 設定が不正なら形式のエラーではなく設定のエラーを返す
  assertCatError(
    () =>
      CatToken.decode(TEXT_ENCODER.encode("not a token"), undefined as unknown as C4mClaimLabels),
    "invalidClaimLabels",
  );
});

test("IANA CWT Claims レジストリの登録済み整数 key 76 件と一覧が完全一致する", () => {
  // 出典: IANA CWT Claims registry、2026-11-05 確認、XML より
  // https://www.iana.org/assignments/cwt/cwt.xml
  //
  // 一覧は実装側と独立したリテラルで持つ。実装の一覧から 1 件抜けても、余分な
  // key が入っても落ちるようにするためである。XML の <record> のうち整数 key を
  // 持つ 76 件を昇順に列挙する。
  const registeredClaimKeys = [
    -261, -260, -259, -258, -257, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 38, 39, 40, 169, 256, 257,
    258, 259, 260, 261, 262, 263, 264, 265, 266, 267, 268, 269, 270, 271, 272, 273, 274, 275, 282,
    299, 300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312, 313, 314, 315, 316, 317,
    318, 319, 320, 321, 322, 323, 2394, 2395, 2396, 2398, 2399, 2400, 65533, 65534, 65535,
  ];
  assert.equal(registeredClaimKeys.length, 76);
  assert.deepEqual(IANA_CWT_CLAIM_KEYS, registeredClaimKeys);
  // 2397 は Unassigned である。RFC 9783 の PSA claims は 2394〜2396 と
  // 2398〜2400 に登録されており、2397 を間に挟んでいる
  assert.notInclude(IANA_CWT_CLAIM_KEYS, 2397);
});

test("IANA が moqt / moqt-reval に割り当てた key だけを label として許可する", () => {
  // 現時点では公式の割当が無いため、対応表は空である。全登録 key を拒否することは
  // decodeCatClaims を使う次のテストで固定する (割当マッピングはここで確認する)
  assert.deepEqual(MOQT_CLAIM_LABEL_KEYS, {});
  // IANA が 282 を moqt、323 を moqt-reval に割り当てた場合を模擬する。割当は
  // claim ごとに別々に判定するため、他方の claim に割り当てられた key を
  // 取り違えて許可しない
  const assigned = { moqt: 282, moqtReval: 323 };
  const allowed = resolveClaimLabels({ moqt: 282, moqtReval: 323 }, assigned);
  assert.equal(allowed.ok, true);
  if (allowed.ok) {
    assert.deepEqual(allowed.labels, { moqt: 282, moqtReval: 323 });
  }
  // 入れ替えると、それぞれ他方の claim の公式値になるため拒否する
  assert.equal(resolveClaimLabels({ moqt: 323, moqtReval: 282 }, assigned).ok, false);
  // 片方だけの割当は、その claim の位置でだけ許可する
  const moqtOnly = { moqt: 282 };
  assert.equal(resolveClaimLabels({ moqt: 282, moqtReval: -65538 }, moqtOnly).ok, true);
  assert.equal(resolveClaimLabels({ moqt: -65537, moqtReval: 282 }, moqtOnly).ok, false);
  const moqtRevalOnly = { moqtReval: 282 };
  assert.equal(resolveClaimLabels({ moqt: -65537, moqtReval: 282 }, moqtRevalOnly).ok, true);
  assert.equal(resolveClaimLabels({ moqt: 282, moqtReval: -65538 }, moqtRevalOnly).ok, false);
  // 公式値でも moqt と moqtReval に同じ値を割り当てることはできない
  assert.equal(
    resolveClaimLabels({ moqt: 282, moqtReval: 282 }, { moqt: 282, moqtReval: 282 }).ok,
    false,
  );
});

test("IANA 登録済みの claim key との衝突と、同じ値の二重指定を拒否する", () => {
  // 代表値をリテラルで固定する。定数の一覧だけを根拠にすると、一覧から値が
  // 抜けたときにテストも一緒に通ってしまう
  const representativeClaimKeys = [0, 9, 282, -257, 323, 2394, 65535];
  for (const key of representativeClaimKeys) {
    assert.include(IANA_CWT_CLAIM_KEYS, key, `IANA 登録済み key ${key} が一覧にある`);
    assertCatError(
      () => decodeCatClaims(cborMap([]), { moqt: key, moqtReval: -65538 }),
      "invalidClaimLabels",
    );
    assertCatError(
      () => decodeCatClaims(cborMap([]), { moqt: -65537, moqtReval: key }),
      "invalidClaimLabels",
    );
  }
  // IANA に登録済みの key は、moqt / moqt-reval のどちらに割り当てても拒否する
  for (const key of IANA_CWT_CLAIM_KEYS) {
    assertCatError(
      () => decodeCatClaims(cborMap([]), { moqt: key, moqtReval: -65538 }),
      "invalidClaimLabels",
    );
    assertCatError(
      () => decodeCatClaims(cborMap([]), { moqt: -65537, moqtReval: key }),
      "invalidClaimLabels",
    );
  }
  // moqt と moqt-reval に同じ key を割り当てると、1 つの key が 2 つの意味を持つ
  assertCatError(
    () => decodeCatClaims(cborMap([]), { moqt: -65537, moqtReval: -65537 }),
    "invalidClaimLabels",
  );
  // IANA 登録済みの claim key と衝突しない label (正の値でもよい) は受理し、
  // その key だけを moqt / moqt-reval として解釈する
  const positiveLabels: C4mClaimLabels = { moqt: 1000, moqtReval: 1001 };
  const positiveClaims = createCatClaims();
  positiveClaims.moqt = { scopes: [createMoqtScope(["Setup"])] };
  positiveClaims.moqtReval = 60;
  const positiveEncoded = encodeCatClaims(positiveClaims, positiveLabels);
  assert.notEqual(cborMapGet(positiveEncoded, cborInteger(1000)), undefined);
  assert.notEqual(cborMapGet(positiveEncoded, cborInteger(1001)), undefined);
  assert.deepEqual(decodeCatClaims(positiveEncoded, positiveLabels), positiveClaims);
});

test("IANA 登録済みの 282 (geohash) を label に使う設定は地理クレームの解釈前に拒否する", () => {
  // 付録 A.2 の cbor_geographic_claims は 282 (CTA-5009 の geohash) を claim key に
  // 使う。282 を moqt の label に割り当てると、正しい geohash の claim が
  // moqt として解釈されて C4M のエラーになり、設定の誤りを検出できなかった
  const vector = claimVector("cbor_geographic_claims");
  const value = decodeCbor(decodeHex(vector.payloadHex));
  // 正しい設定では 282 を型付きで解釈せず raw に保持する
  const claims = decodeCatClaims(value, CLAIM_LABELS);
  assert.deepEqual(getCatClaim(claims, 282), cborMapGet(value, cborInteger(282)));
  // 282 を label に使う設定は、claim の解釈を始める前に invalidClaimLabels で拒否する
  assertCatError(
    () => decodeCatClaims(value, { moqt: 282, moqtReval: -65538 }),
    "invalidClaimLabels",
  );
});

test("decodeCatClaims は手組みの map でも claim key の重複を拒否する", () => {
  // decodeCatClaims は CborValue を直接受ける公開 API のため、CBOR 層を通らない
  // 手組みの map でも重複を拒否する。後から来た値で先の値を黙って上書きしない。
  // エラーの詳細はエンコード側と同じく、整数 key は bigint、テキスト key は文字列
  const duplicateKeys: Array<[CborValue, string | bigint]> = [
    [cborInteger(CLAIM_ISSUER), BigInt(CLAIM_ISSUER)],
    [cborInteger(1000), 1000n],
    [cborTextString("custom"), "custom"],
  ];
  for (const [key, detail] of duplicateKeys) {
    const duplicated = cborMap([
      [key, cborTextString("first")],
      [key, cborTextString("second")],
    ]);
    assertCatError(() => decodeCatClaims(duplicated, CLAIM_LABELS), "duplicateClaim", detail);
  }
});

test("未知の整数 claim 50,000 件をデコードできる", () => {
  // 大量の未知 claim を持っていても、claim の解釈と重複判定が破綻しないことを
  // 確認する。計算量そのものは壁時計に依存する形では検証しない
  // (cborMapKeys.test.ts がキーのエンコード回数で決定的に検証する)
  const claimCount = 50_000;
  const entries: Array<[CborValue, CborValue]> = [];
  for (let index = 0; index < claimCount; index++) {
    entries.push([cborInteger(10_000 + index), cborUnsigned(0n)]);
  }
  const claims = decodeCatClaims(cborMap(entries), CLAIM_LABELS);
  assert.equal(claims.raw.length, claimCount);
});

test("claim label 設定が違えば同じ CBOR を別の claim として解釈する", () => {
  const scope = createMoqtScope(["Setup"]);
  const claims = createCatClaims();
  claims.moqt = { scopes: [scope] };
  claims.moqtReval = 300;
  // 他の claim (catdpop / exp) と同居しても取り違えない
  claims.catdpop = createCatDpop(60, true);
  claims.expiration = 1700086400;
  const encoded = encodeCatClaims(claims, C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS);

  // 同じ設定なら typed な claim として戻る
  const sameLabels: C4mClaimLabels = { moqt: -65537, moqtReval: -65538 };
  assert.deepEqual(decodeCatClaims(encoded, sameLabels), claims);

  // 別の設定では moqt / moqt-reval として解釈せず raw に残す
  const otherLabels: C4mClaimLabels = { moqt: 1000, moqtReval: 1001 };
  const other = decodeCatClaims(encoded, otherLabels);
  assert.equal(other.moqt, undefined);
  assert.equal(other.moqtReval, undefined);
  assert.deepEqual(getCatClaim(other, -65537), cborMapGet(encoded, cborInteger(-65537)));
  assert.deepEqual(getCatClaim(other, -65538), cborMapGet(encoded, cborInteger(-65538)));
  // 他の claim は設定に関係なく同じように解釈する
  assert.deepEqual(other.catdpop, claims.catdpop);
  assert.equal(other.expiration, claims.expiration);
  // moqt として解釈していないため、いかなるアクションも認可しない
  for (const action of MOQT_ACTIONS) {
    assert.equal(
      authorizeCatClaims(
        other,
        action,
        [TEXT_ENCODER.encode("example.com")],
        TEXT_ENCODER.encode("video"),
      ),
      false,
      `別の label 設定で ${action} が許可された`,
    );
  }

  // 逆方向 (別の label で発行し、preset でデコード) でも同じである
  const otherEncoded = encodeCatClaims(claims, otherLabels);
  const presetDecoded = decodeCatClaims(otherEncoded, C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS);
  assert.equal(presetDecoded.moqt, undefined);
  assert.equal(presetDecoded.moqtReval, undefined);
  assert.deepEqual(getCatClaim(presetDecoded, 1000), cborMapGet(otherEncoded, cborInteger(1000)));
});

test("設定した claim label を raw に置くと二重指定として拒否する", () => {
  const moqtRaw = createCatClaims();
  moqtRaw.raw.push([cborInteger(C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS.moqt), cborTextString("x")]);
  assertCatError(
    () => encodeCatClaims(moqtRaw, C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS),
    "duplicateClaim",
    BigInt(C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS.moqt),
  );

  const revalRaw = createCatClaims();
  revalRaw.raw.push([cborInteger(C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS.moqtReval), cborUnsigned(1n)]);
  assertCatError(
    () => encodeCatClaims(revalRaw, C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS),
    "duplicateClaim",
    BigInt(C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS.moqtReval),
  );
});
