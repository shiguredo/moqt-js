/**
 * CAT (CTA-5007-B / draft-ietf-moq-c4m-02) のテスト
 *
 * 署名 / 検証は Web Crypto API を使う `WebCrypto` で実行する。
 */

import { test, assert } from "vite-plus/test";
import { encodeBase64Url } from "./base64url";
import {
  CAT_CONTENT_TYPE,
  CLAIM_CAT_VERSION,
  CLAIM_CONFIRMATION,
  CLAIM_EXPIRATION,
  CLAIM_ISSUED_AT,
  CLAIM_ISSUER,
  CLAIM_NOT_BEFORE,
  CatError,
  CatToken,
  CatTokenBuilder,
  MOQT_AUTH_TOKEN_TYPE_CAT,
  authorizeCatClaims,
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
  CBOR_NULL,
  cborArray,
  cborByteString,
  cborFloat,
  cborInteger,
  cborMap,
  cborMapGet,
  cborTag,
  cborTextString,
  cborUnsigned,
  decodeCbor,
  encodeCbor,
} from "./cbor";
import type { Algorithm, CoseKeyId } from "./cose";
import {
  type CoseKey,
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
  exactMatch,
  namespaceMatchValue,
} from "./moqt";
import { WebCrypto } from "./webcrypto";
import {
  assertCatError,
  assertClaimValidationError,
  captureRejectedError,
  decodeHex,
  encodeBase64Standard,
  encodeHex,
} from "./testSupport";
import {
  CLAIM_VECTORS,
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

test("付録 A.3 のトークンをデコードできる", () => {
  for (const vector of TOKEN_VECTORS) {
    const token = CatToken.decode(TEXT_ENCODER.encode(vector.token), CLAIM_LABELS);
    assert.equal(token.format(), "compact", `ベクタ ${vector.id}`);
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
    assert.deepEqual(token.header().typ, cborTextString("CAT"), `ベクタ ${vector.id} の typ`);
    const claims = token.claims();
    assert.equal(claims.issuer, vector.issuer, `ベクタ ${vector.id}`);
    assert.equal(claims.subject, vector.subject, `ベクタ ${vector.id}`);
    assert.deepEqual(claims.audience, vector.audience, `ベクタ ${vector.id}`);
    assert.equal(claims.expiration, vector.expiration, `ベクタ ${vector.id}`);
    assert.equal(claims.notBefore, vector.notBefore, `ベクタ ${vector.id}`);
    assert.equal(claims.issuedAt, vector.issuedAt, `ベクタ ${vector.id}`);
    assert.deepEqual(
      claims.cwtId,
      vector.cwtId !== undefined ? TEXT_ENCODER.encode(vector.cwtId) : undefined,
      `ベクタ ${vector.id} の cti`,
    );
  }
});

test("付録 A.3 のトークンの署名を検証できる", async () => {
  for (const vector of TOKEN_VECTORS) {
    const token = CatToken.decode(TEXT_ENCODER.encode(vector.token), CLAIM_LABELS);
    const key = vector.algorithmId === -7 ? es256PublicKey() : hmacKey();
    await token.verify(cryptoImpl, key);
    // 期待する alg と typ を指定しても通る
    await token.verify(cryptoImpl, key, {
      expectedAlgorithm: vector.algorithmId === -7 ? "Es256" : "HmacSha256",
      expectedType: CAT_CONTENT_TYPE,
    });
  }
});

test("付録 A.4 の DPoP バインディングのクレームをデコードできる", () => {
  for (const vector of DPOP_VECTORS) {
    const token = CatToken.decode(TEXT_ENCODER.encode(vector.token), CLAIM_LABELS);
    assert.equal(encodeHex(token.payload()), vector.payloadHex, `ベクタ ${vector.id} の claims`);
    const confirmation = token.claims().confirmation;
    assert.ok(confirmation !== undefined, `ベクタ ${vector.id} に cnf がある`);
    assert.deepEqual(
      confirmation.c4mDraftJwkThumbprint,
      decodeHex(vector.cnfJktHex),
      `ベクタ ${vector.id} の jkt (confirmation key 3)`,
    );
    assert.deepEqual(
      confirmationJkt(confirmation),
      decodeHex(vector.cnfJktHex),
      `ベクタ ${vector.id} の jkt`,
    );
    const catdpop = token.claims().catdpop;
    if (catdpop !== undefined) {
      assert.equal(
        catdpop.windowSeconds,
        vector.windowSeconds,
        `ベクタ ${vector.id} の catdpop ウィンドウ`,
      );
      assert.equal(catdpop.honorJti, vector.honorJti, `ベクタ ${vector.id} の catdpop honor_jti`);
    } else {
      assert.equal(vector.windowSeconds, undefined, `ベクタ ${vector.id} に catdpop が無い`);
    }
  }
});

test("付録 A.6 の検証ベクタのクレームを検証できる", () => {
  for (const vector of VALIDATION_VECTORS) {
    const token = CatToken.decode(TEXT_ENCODER.encode(vector.token), CLAIM_LABELS);
    const run = (): void => {
      validateCatClaims(token.claims(), {
        referenceTimeSeconds: vector.referenceTime ?? 0,
        clockToleranceSeconds: 0,
        expectedIssuers: vector.expectedIssuers,
        expectedAudiences: vector.expectedAudiences,
      });
    };
    switch (vector.expectedError) {
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
      // 署名エラーのベクタはクレーム検証では正常になる
      default:
        assert.doesNotThrow(run, `ベクタ ${vector.id}`);
        break;
    }
  }
});

test("改ざんと誤った鍵の署名を拒否する", async () => {
  for (const vector of VALIDATION_VECTORS) {
    if (vector.keyHex === undefined) {
      continue;
    }
    const token = CatToken.decode(TEXT_ENCODER.encode(vector.token), CLAIM_LABELS);
    const error = await captureRejectedError(() =>
      token.verify(cryptoImpl, symmetricKey(decodeHex(vector.keyHex ?? ""))),
    );
    assert.ok(error instanceof CatError, `ベクタ ${vector.id} で CatError を期待した`);
    assert.equal(error.code, "crypto", `ベクタ ${vector.id}`);
    assert.ok(error.cause !== undefined, `ベクタ ${vector.id} に cause がある`);
    assert.equal(
      (error.cause as { code?: string }).code,
      "signatureVerificationFailed",
      `ベクタ ${vector.id}`,
    );
  }
});

test("期待アルゴリズムの不一致を拒否する", async () => {
  const vector = VALIDATION_VECTORS.find((entry) => entry.id === "invalid_algorithm_mismatch");
  assert.ok(vector !== undefined);
  assert.equal(vector.verifierAlgorithmId, -7);
  const token = CatToken.decode(TEXT_ENCODER.encode(vector.token), CLAIM_LABELS);
  // 期待アルゴリズムを指定しなければ署名は検証できる
  await token.verify(cryptoImpl, hmacKey());
  // 期待アルゴリズムが違えば algorithmMismatch
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
  const tokenText = TOKEN_VECTORS[0]?.token ?? "";
  assert.equal(
    CatToken.decodeMoqtAuthToken(
      MOQT_AUTH_TOKEN_TYPE_CAT,
      TEXT_ENCODER.encode(tokenText),
      CLAIM_LABELS,
    ).format(),
    "compact",
  );
  assertCatError(
    () => CatToken.decodeMoqtAuthToken(2n, TEXT_ENCODER.encode(tokenText), CLAIM_LABELS),
    "invalidAuthTokenType",
    2n,
  );
});

test("不正なトークンを拒否する", () => {
  // CBOR / base64url のどちらとしても解釈できない入力は COSE のエラーになる
  assertCatError(() => CatToken.decode(TEXT_ENCODER.encode("not a token"), CLAIM_LABELS), "cose");
  assertCatError(() => CatToken.decode(TEXT_ENCODER.encode("aaaa.bbbb"), CLAIM_LABELS), "cose");
  // compact 形式のデコードを明示的に呼んだ場合は形式エラー
  assertCatError(
    () => CatToken.decodeCompact("ogEjEGNDQVQ.aaaa", CLAIM_LABELS),
    "invalidTokenFormat",
  );
  // 自動判別では 3 分割でない入力は COSE 形式として解釈する
  assertCatError(
    () => CatToken.decode(TEXT_ENCODER.encode("ogEjEGNDQVQ.aaaa"), CLAIM_LABELS),
    "cose",
  );
  // base64url として不正な 3 分割
  assertCatError(
    () => CatToken.decode(TEXT_ENCODER.encode("***.@@@.$$$"), CLAIM_LABELS),
    "invalidBase64",
  );
  // 3 分割だが claims が CBOR ではない
  assertCatError(
    () => CatToken.decode(TEXT_ENCODER.encode("ogEjEGNDQVQ.aaaa.aaaa"), CLAIM_LABELS),
    "cbor",
  );
});

test("alg の無いトークンを拒否する", () => {
  // compact 形式で alg が無い
  const emptyMap = encodeCbor(cborMap([]));
  const text = `${encodeBase64Url(emptyMap)}.${encodeBase64Url(emptyMap)}.${encodeBase64Url(TEXT_ENCODER.encode("signature"))}`;
  assertCatError(
    () => CatToken.decode(TEXT_ENCODER.encode(text), CLAIM_LABELS),
    "missingAlgorithm",
  );

  // COSE 形式で alg が無い
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
  assertCatError(() => encodeCatClaims(claims, CLAIM_LABELS), "duplicateClaim", CLAIM_ISSUER);
});

test("raw のクレームは往復して取得できる", () => {
  // 付録 A.2 の catv / catu は型付きで解釈せず raw に保持する
  const vector = claimVector("cbor_cat_version_usage");
  const value = decodeCbor(decodeHex(vector.payloadHex));
  const claims = decodeCatClaims(value, CLAIM_LABELS);
  assert.deepEqual(getCatClaim(claims, CLAIM_CAT_VERSION), cborTextString("CAT-v1"));
  assert.deepEqual(encodeCatClaims(claims, CLAIM_LABELS), value);
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

test("cnf の jkt は IANA 登録のキーを優先する", () => {
  const confirmation = createConfirmation();
  confirmation.jwkThumbprint = new Uint8Array(32).fill(1);
  confirmation.c4mDraftJwkThumbprint = new Uint8Array(32).fill(2);
  assert.deepEqual(confirmationJkt(confirmation), new Uint8Array(32).fill(1));
  // エンコードとデコードで往復できる
  assert.deepEqual(decodeConfirmation(encodeConfirmation(confirmation)), confirmation);

  // 空の cnf は空のマップになる
  const claims = createCatClaims();
  claims.confirmation = createConfirmation();
  const encoded = encodeCatClaims(claims, CLAIM_LABELS);
  assert.deepEqual(cborMapGet(encoded, cborInteger(CLAIM_CONFIRMATION)), cborMap([]));
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

test("付録 A の全ベクタトークンの署名を検証できる", async () => {
  for (const vector of DPOP_VECTORS) {
    const token = CatToken.decode(TEXT_ENCODER.encode(vector.token), CLAIM_LABELS);
    const key = vector.id === "dpop_es256_real_binding" ? es256PublicKey() : hmacKey();
    await token.verify(cryptoImpl, key);
  }
  for (const vector of SCOPE_VECTORS) {
    const token = CatToken.decode(TEXT_ENCODER.encode(vector.token), CLAIM_LABELS);
    await token.verify(cryptoImpl, hmacKey());
  }
  for (const vector of VALIDATION_VECTORS) {
    const token = CatToken.decode(TEXT_ENCODER.encode(vector.token), CLAIM_LABELS);
    // 改ざん・誤鍵のベクタは失敗することが期待値
    if (vector.id === "invalid_tampered_signature" || vector.id === "invalid_wrong_key") {
      continue;
    }
    await token.verify(cryptoImpl, hmacKey());
  }
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
  assertCatError(() => encodeCatClaims(claims, CLAIM_LABELS), "duplicateClaim", CLAIM_EXPIRATION);
});

test("ビルダーは非有限のタイムスタンプを拒否する", async () => {
  const runCompact = async (): Promise<unknown> =>
    new CatTokenBuilder({ claimLabels: CLAIM_LABELS })
      .expiration(Number.NaN)
      .buildCompact(cryptoImpl, hmacKey());
  const error = await captureRejectedError(runCompact);
  assert.ok(error instanceof CatError);
  assert.equal(error.code, "nonFiniteNumber");

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
    .c4mDraftJwkThumbprint(new Uint8Array(32).fill(0x01))
    .typ("CAT")
    .keyId(keyId)
    .claim(CLAIM_CAT_VERSION, cborTextString("CAT-v1"))
    .buildCose(cryptoImpl, hmacKey());
  const token = CatToken.decode(tokenBytes, CLAIM_LABELS);
  const decoded = token.claims();
  assert.equal(decoded.subject, "user:alice");
  assert.equal(decoded.issuedAt, 1700000000);
  assert.deepEqual(decoded.cwtId, TEXT_ENCODER.encode("id-1"));
  assert.deepEqual(decoded.confirmation?.c4mDraftJwkThumbprint, new Uint8Array(32).fill(0x01));
  assert.deepEqual(getCatClaim(decoded, CLAIM_CAT_VERSION), cborTextString("CAT-v1"));
  await token.verify(cryptoImpl, hmacKey());
  assert.deepEqual(token.header().typ, cborTextString("CAT"));
});

test("Token Value の CBOR を直接デコードできる", () => {
  const tokenText = TOKEN_VECTORS[0]?.token ?? "";
  const compact = CatToken.decode(TEXT_ENCODER.encode(tokenText), CLAIM_LABELS);
  // compact 形式の payload を COSE として渡すと形式エラーになる
  assertCatError(
    () => CatToken.decodeMoqtAuthToken(MOQT_AUTH_TOKEN_TYPE_CAT, compact.payload(), CLAIM_LABELS),
    "cose",
  );
  assert.deepEqual(CatToken.decode(compact.rawToken(), CLAIM_LABELS).claims(), compact.claims());
});

test("生トークンと署名は JSON 化で漏れない", () => {
  const vector = TOKEN_VECTORS[0];
  assert.ok(vector !== undefined);
  const token = CatToken.decode(TEXT_ENCODER.encode(vector.token), CLAIM_LABELS);
  const serialized = JSON.stringify(token);
  assert.notInclude(serialized, vector.token);
  assert.notInclude(serialized, vector.signatureHex);
});

/**
 * draft-ietf-moq-c4m-02 Section 2:
 * "When it must be cast to a string for inclusion in a URL, it is Base64 encoded"
 * `CatToken.decode` は compact テキスト / 生の COSE / Base64 で包んだ COSE を判別する。
 * Base64 で包んだ compact テキストは判別の対象外であり、COSE として解釈できないため
 * 拒否する。受理する表現と拒否する表現を明示的に固定する。
 */
test("URL 埋め込みの compact トークンは Base64 で包むと受理しない", () => {
  const vector = TOKEN_VECTORS[0];
  assert.ok(vector !== undefined);
  const token = CatToken.decode(TEXT_ENCODER.encode(vector.token), CLAIM_LABELS);

  // compact テキストそのものは受理する
  assert.equal(CatToken.decode(token.rawToken(), CLAIM_LABELS).format(), "compact");

  // 標準 Base64 で包んだ compact テキストは COSE 形式として解釈できず拒否する
  for (const text of [
    encodeBase64Standard(token.rawToken(), true),
    encodeBase64Standard(token.rawToken(), false),
  ]) {
    assertCatError(() => CatToken.decode(TEXT_ENCODER.encode(text), CLAIM_LABELS), "cose");
  }
});

test("typ は指定したときだけ検証する", () => {
  const vector = TOKEN_VECTORS[0];
  assert.ok(vector !== undefined);
  const token = CatToken.decode(TEXT_ENCODER.encode(vector.token), CLAIM_LABELS);
  assert.deepEqual(token.header().typ, cborTextString(CAT_CONTENT_TYPE));
  assert.equal(CAT_CONTENT_TYPE, "CAT");
});

test("typ の不一致を拒否する", async () => {
  const tokenText = await new CatTokenBuilder({ claimLabels: CLAIM_LABELS })
    .issuer("https://auth.example.com")
    .typ("OTHER")
    .buildCompact(cryptoImpl, hmacKey());
  const token = CatToken.decode(TEXT_ENCODER.encode(tokenText), CLAIM_LABELS);
  const error = await captureRejectedError(() =>
    token.verify(cryptoImpl, hmacKey(), { expectedType: CAT_CONTENT_TYPE }),
  );
  assert.ok(error instanceof CatError);
  assert.equal(error.code, "typeMismatch");
  // "OTHER" を期待すれば通る
  await token.verify(cryptoImpl, hmacKey(), { expectedType: "OTHER" });
});

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
// claim label 設定 (0918)
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

test("compact / COSE / MOQT Auth Token と builder に claim label 設定が伝搬する", async () => {
  const claims = createCatClaims();
  claims.issuer = "https://auth.example.com";
  claims.moqt = { scopes: [createMoqtScope(["Setup", "Publish"])] };
  claims.moqtReval = 60;

  // builder は設定を保持し、compact 形式の発行に使う
  const builder = new CatTokenBuilder({ claims, claimLabels: CLAIM_LABELS });
  assert.deepEqual(builder.claimLabels, C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS);
  const compactText = await builder.buildCompact(cryptoImpl, hmacKey());
  const compact = CatToken.decodeCompact(compactText, CLAIM_LABELS);
  assert.deepEqual(compact.claims(), claims);
  await compact.verify(cryptoImpl, hmacKey());

  // COSE 形式でも同じ設定で往復し、署名を検証できる
  const coseBytes = await new CatTokenBuilder({ claims, claimLabels: CLAIM_LABELS }).buildCose(
    cryptoImpl,
    hmacKey(),
  );
  const cose = CatToken.decodeCose(coseBytes, CLAIM_LABELS);
  assert.deepEqual(cose.claims(), claims);
  await cose.verify(cryptoImpl, hmacKey());

  // MOQT Auth Token の入口と自動判別の入口にも同じ設定を渡す
  const authToken = CatToken.decodeMoqtAuthToken(MOQT_AUTH_TOKEN_TYPE_CAT, coseBytes, CLAIM_LABELS);
  assert.deepEqual(authToken.claims(), claims);
  const autoDetected = CatToken.decode(TEXT_ENCODER.encode(compactText), CLAIM_LABELS);
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
  const tokenText = await builder.buildCompact(cryptoImpl, hmacKey());

  // Token もデコード時に設定をコピーする
  const decodeSource = { moqt: -65537, moqtReval: -65538 };
  const token = CatToken.decode(TEXT_ENCODER.encode(tokenText), decodeSource);
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

test("claim label 設定を省略した呼び出しはコンパイルエラーになり、実行時も拒否する", () => {
  // claimLabels はすべての入口で必須引数である。型検査では以下の呼び出しが
  // エラーになり、JavaScript から未指定のまま呼ばれても invalidClaimLabels になる
  // @ts-expect-error claimLabels は必須引数
  const decodeWithoutLabels = (): unknown => decodeCatClaims(cborMap([]));
  // @ts-expect-error claimLabels は必須引数
  const decodeTokenWithoutLabels = (): unknown => CatToken.decode(new Uint8Array(0));
  // @ts-expect-error claimLabels は必須引数
  const buildWithoutLabels = (): unknown => new CatTokenBuilder({});
  assertCatError(decodeWithoutLabels, "invalidClaimLabels");
  assertCatError(decodeTokenWithoutLabels, "invalidClaimLabels");
  assertCatError(buildWithoutLabels, "invalidClaimLabels");
});

test("未指定・不正型・範囲外の claim label 設定を処理開始時に拒否する", () => {
  const claims = createCatClaims();
  const tokenText = TOKEN_VECTORS[0]?.token ?? "";
  const tokenBytes = TEXT_ENCODER.encode(tokenText);
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
    assertCatError(() => CatToken.decodeCompact(tokenText, broken), "invalidClaimLabels");
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

test("既知 claim との衝突と、同じ値の二重指定を拒否する", () => {
  // CWT の 1〜8 と CAT の 308〜323 は実装が意味を持つ claim key である
  const knownClaimKeys = [
    1, 2, 3, 4, 5, 6, 7, 8, 308, 309, 310, 311, 312, 313, 314, 315, 316, 317, 318, 319, 320, 321,
    322, 323,
  ];
  for (const key of knownClaimKeys) {
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
  // 既知 claim と衝突しない label (正の値でもよい) は受理し、その key だけを
  // moqt / moqt-reval として解釈する
  const positiveLabels: C4mClaimLabels = { moqt: 1000, moqtReval: 1001 };
  const positiveClaims = createCatClaims();
  positiveClaims.moqt = { scopes: [createMoqtScope(["Setup"])] };
  positiveClaims.moqtReval = 60;
  const positiveEncoded = encodeCatClaims(positiveClaims, positiveLabels);
  assert.notEqual(cborMapGet(positiveEncoded, cborInteger(1000)), undefined);
  assert.notEqual(cborMapGet(positiveEncoded, cborInteger(1001)), undefined);
  assert.deepEqual(decodeCatClaims(positiveEncoded, positiveLabels), positiveClaims);
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
    C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS.moqt,
  );

  const revalRaw = createCatClaims();
  revalRaw.raw.push([cborInteger(C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS.moqtReval), cborUnsigned(1n)]);
  assertCatError(
    () => encodeCatClaims(revalRaw, C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS),
    "duplicateClaim",
    C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS.moqtReval,
  );
});
