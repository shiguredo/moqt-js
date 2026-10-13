/**
 * Web Crypto API を使う署名 / 検証実装の Property-Based Testing
 *
 * 署名と検証の往復、鍵や署名が不正なときの失敗が必ず `CryptoError` になること
 * (DOMException を漏らさないこと)、改ざんの拒否、曲線とアルゴリズムの対応、
 * 署名長の検査、ダイジェストを任意の入力で確認する。
 *
 * 鍵はテストファイルの読み込み時に `crypto.subtle.generateKey` で 1 度だけ生成し、
 * `exportKey("jwk")` の結果を `jwkToCoseKey` で `CoseKey` にして使い回す。鍵生成と
 * P-521 の署名は重いため、テストごとに生成しない。モックやスタブは使わず、Web
 * Crypto API の実物だけを使う。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import type { Algorithm } from "./cose";
import {
  type CoseKey,
  CryptoError,
  type DigestAlgorithm,
  type EcCurve,
  ec2Key,
  ec2KeyWithPrivateKey,
  ecCurveCoordinateLength,
  ed25519Key,
  ed25519KeyWithPrivateKey,
  symmetricKey,
} from "./crypto";
import { decodeJwk, jwkToCoseKey } from "./jwk";
import { unreachableValue } from "./unreachable";
import { WebCrypto } from "./webcrypto";

/** 検証対象の実装 (Web Crypto API の実物を使う) */
const cryptoImpl = new WebCrypto();

/** COSE の楕円曲線 (RFC 9053 Section 7) */
const EC_CURVES = ["P256", "P384", "P521"] as const;

/** 曲線と署名アルゴリズムの対応 (RFC 9053 Section 3.4 の ES256 / ES384 / ES512) */
const EC_ALGORITHMS: Readonly<Record<EcCurve, Algorithm>> = {
  P256: "Es256",
  P384: "Es384",
  P521: "Es512",
};

/** ダイジェストのアルゴリズム */
const DIGEST_ALGORITHMS: readonly DigestAlgorithm[] = ["Sha256", "Sha384", "Sha512"];

/** ダイジェストの出力長 (RFC 9053 Section 2 のハッシュ長) */
const DIGEST_LENGTHS: Readonly<Record<DigestAlgorithm, number>> = {
  Sha256: 32,
  Sha384: 48,
  Sha512: 64,
};

/** 例外を人が読める文字列にする (失敗メッセージ用) */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * 失敗した非同期処理の `CryptoError` を捕捉して返す
 *
 * 例外が送出されなかった場合はテストを失敗させる。`DOMException` などの生の
 * 例外が漏れた場合は `assert.ok` が失敗し、捕捉した値がメッセージに残る。
 */
async function captureCryptoError(run: () => Promise<unknown>): Promise<CryptoError> {
  let error: unknown;
  try {
    await run();
  } catch (caught) {
    error = caught;
  }
  assert.ok(
    error instanceof CryptoError,
    error === undefined
      ? "CryptoError を期待したが例外が送出されなかった"
      : `CryptoError を期待したが ${describeError(error)} が送出された`,
  );
  return error;
}

/** 曲線の Web Crypto API の名前 (RFC 7518 Section 6.2.1.1) */
function webCryptoCurveName(curve: EcCurve): string {
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
 * Web Crypto API で EC の鍵を生成して `CoseKey` にする
 *
 * 秘密鍵をエクスポートすると JWK に `d` が含まれるため、`jwkToCoseKey` は署名に
 * 使える鍵を返す。公開鍵だけをエクスポートした場合は検証専用の鍵になる。
 */
async function generateEcKey(curve: EcCurve, includePrivateKey: boolean): Promise<CoseKey> {
  const pair = await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: webCryptoCurveName(curve) },
    true,
    ["sign", "verify"],
  );
  const exported = await globalThis.crypto.subtle.exportKey(
    "jwk",
    includePrivateKey ? pair.privateKey : pair.publicKey,
  );
  return jwkToCoseKey(decodeJwk(JSON.stringify(exported)));
}

/** Web Crypto API で Ed25519 の鍵を生成して `CoseKey` にする */
async function generateEd25519Key(includePrivateKey: boolean): Promise<CoseKey> {
  const pair = await globalThis.crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  const exported = await globalThis.crypto.subtle.exportKey(
    "jwk",
    includePrivateKey ? pair.privateKey : pair.publicKey,
  );
  return jwkToCoseKey(decodeJwk(JSON.stringify(exported)));
}

/** 署名と検証の組 */
interface SigningCase {
  /** 署名アルゴリズム */
  readonly algorithm: Algorithm;
  /** 署名に使う鍵 */
  readonly key: CoseKey;
  /** 「別の鍵」での検証に使う鍵 (同じアルゴリズムで使える別の鍵) */
  readonly otherKey: CoseKey;
  /** 正しい署名の長さ (バイト) */
  readonly signatureLength: number;
}

/** 曲線ごとの署名と検証の組 */
interface EcSigningCase extends SigningCase {
  readonly curve: EcCurve;
}

/** HMAC の鍵 (HMAC は鍵長を問わないため固定の 32 バイトを使う) */
const HMAC_KEY = symmetricKey(new Uint8Array(32).fill(0x01));

/** 「別の鍵」での検証に使う HMAC の鍵 (値だけが異なる同じ長さの鍵) */
const HMAC_OTHER_KEY = symmetricKey(new Uint8Array(32).fill(0x02));

/** HMAC の署名 (MAC) の長さ (RFC 9053 Section 2 のハッシュ長) */
const HMAC_CASE_SPECS = [
  { algorithm: "HmacSha256", signatureLength: 32 },
  { algorithm: "HmacSha384", signatureLength: 48 },
  { algorithm: "HmacSha512", signatureLength: 64 },
] as const;

/** HMAC の署名と検証の組 */
const HMAC_SIGNING_CASES: readonly SigningCase[] = HMAC_CASE_SPECS.map((spec) => ({
  algorithm: spec.algorithm,
  key: HMAC_KEY,
  otherKey: HMAC_OTHER_KEY,
  signatureLength: spec.signatureLength,
}));

/** 曲線ごとの署名と検証の組を作る (鍵は 1 度だけ生成する) */
async function generateEcSigningCase(curve: EcCurve): Promise<EcSigningCase> {
  return {
    curve,
    algorithm: EC_ALGORITHMS[curve],
    key: await generateEcKey(curve, true),
    otherKey: await generateEcKey(curve, false),
    signatureLength: ecCurveCoordinateLength(curve) * 2,
  };
}

/** 曲線ごとの署名と検証の組 */
const EC_SIGNING_CASES: Readonly<Record<EcCurve, EcSigningCase>> = {
  P256: await generateEcSigningCase("P256"),
  P384: await generateEcSigningCase("P384"),
  P521: await generateEcSigningCase("P521"),
};

/** Ed25519 の署名と検証の組 */
const ED25519_SIGNING_CASE: SigningCase = {
  algorithm: "EdDsa",
  key: await generateEd25519Key(true),
  otherKey: await generateEd25519Key(false),
  signatureLength: 64,
};

/** 全 7 アルゴリズムの署名と検証の組 */
const SIGNING_CASES: readonly SigningCase[] = [
  ...HMAC_SIGNING_CASES,
  EC_SIGNING_CASES.P256,
  EC_SIGNING_CASES.P384,
  EC_SIGNING_CASES.P521,
  ED25519_SIGNING_CASE,
];

/** 全 7 アルゴリズム (RFC 9053 Section 2 / Section 3) */
const ALGORITHMS: readonly Algorithm[] = SIGNING_CASES.map((testCase) => testCase.algorithm);

/**
 * 曲線長や公開鍵長に合わせない任意のバイト列
 *
 * P-256 の座標は 32 バイト、P-384 は 48 バイト、P-521 は 66 バイト、Ed25519 の
 * 公開鍵と秘密鍵は 32 バイトである。長さの検証が実装側にあることを確かめるため、
 * 0〜70 バイトを生成する。
 */
const keyBytesArbitrary = fc.uint8Array({ maxLength: 70, size: "max" });

/** 曲線長の境界を含む任意のバイト列 */
const boundaryKeyBytesArbitrary = fc
  .constantFrom(0, 1, 31, 32, 33, 47, 48, 49, 63, 64, 65, 66, 67, 69, 70)
  .chain((length) => fc.uint8Array({ minLength: length, maxLength: length, size: "max" }));

/** 対称鍵に使う任意のバイト列 (空の対称鍵と長さ違いの対称鍵) */
const symmetricKeyBytesArbitrary = fc.oneof(
  { weight: 3, arbitrary: fc.uint8Array({ maxLength: 80, size: "max" }) },
  { weight: 1, arbitrary: boundaryKeyBytesArbitrary },
);

/** 座標・公開鍵・秘密鍵に使う任意のバイト列 (長さの境界を混ぜる) */
const coordinateBytesArbitrary = fc.oneof(
  { weight: 3, arbitrary: keyBytesArbitrary },
  { weight: 1, arbitrary: boundaryKeyBytesArbitrary },
);

/** 秘密鍵の有無を作るための任意のバイト列 */
const optionalCoordinateBytesArbitrary = fc.option(coordinateBytesArbitrary, { nil: undefined });

/** 鍵の形を網羅する任意の `CoseKey` */
const malformedKeyArbitrary: fc.Arbitrary<CoseKey> = fc.oneof(
  // 空の対称鍵と長さ違いの対称鍵
  symmetricKeyBytesArbitrary.map((key) => symmetricKey(key)),
  // 曲線長に合わせない EC2 鍵 (x / y / privateKey の長さを独立に変える)
  fc
    .tuple(
      fc.constantFrom(...EC_CURVES),
      coordinateBytesArbitrary,
      coordinateBytesArbitrary,
      optionalCoordinateBytesArbitrary,
    )
    .map(([curve, x, y, privateKey]) =>
      privateKey === undefined
        ? ec2Key(curve, x, y)
        : ec2KeyWithPrivateKey(curve, x, y, privateKey),
    ),
  // 公開鍵長に合わせない OKP 鍵
  fc
    .tuple(coordinateBytesArbitrary, optionalCoordinateBytesArbitrary)
    .map(([publicKey, privateKey]) =>
      privateKey === undefined
        ? ed25519Key(publicKey)
        : ed25519KeyWithPrivateKey(publicKey, privateKey),
    ),
);

/** 署名 / 検証に渡すアルゴリズムと鍵の組 */
interface AlgorithmAndKey {
  readonly algorithm: Algorithm;
  readonly key: CoseKey;
}

/**
 * 長さは正しいが秘密鍵を持たない鍵の組
 *
 * 鍵の型と曲線はアルゴリズムに対応するため、署名では `missingPrivateKey`、
 * 検証では通常の検証失敗になる。
 */
const publicOnlyKeyArbitrary: fc.Arbitrary<AlgorithmAndKey> = fc
  .constantFrom(...SIGNING_CASES)
  .map((testCase) => ({ algorithm: testCase.algorithm, key: testCase.otherKey }));

/** 壊れた鍵を含むアルゴリズムと鍵の組 (正常な形の鍵も 1/4 の重みで混ぜる) */
const algorithmAndKeyArbitrary: fc.Arbitrary<AlgorithmAndKey> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc
      .tuple(fc.constantFrom(...ALGORITHMS), malformedKeyArbitrary)
      .map(([algorithm, key]) => ({ algorithm, key })),
  },
  { weight: 1, arbitrary: publicOnlyKeyArbitrary },
);

/** 署名長の境界 (HMAC / ECDSA / Ed25519 が取り得る長さとその前後) */
const SIGNATURE_LENGTH_BOUNDARIES = [
  0, 1, 31, 32, 33, 47, 48, 49, 63, 64, 65, 95, 96, 97, 131, 132, 133,
];

/** 境界の長さを持つ任意の署名 */
const boundarySignatureArbitrary = fc
  .constantFrom(...SIGNATURE_LENGTH_BOUNDARIES)
  .chain((length) => fc.uint8Array({ minLength: length, maxLength: length, size: "max" }));

/** 任意の署名 (長さも内容も任意) */
const signatureArbitrary = fc.oneof(
  { weight: 1, arbitrary: fc.uint8Array({ maxLength: 200, size: "max" }) },
  { weight: 1, arbitrary: boundarySignatureArbitrary },
);

/**
 * `expectedLength` とは必ず異なる長さの署名を作る
 *
 * `fc.pre` やフィルタで除外するのではなく、正しい長さから必ずずらすため、
 * 生成した入力がすべて検査対象になる。
 */
function signatureWithLengthOtherThan(expectedLength: number): fc.Arbitrary<Uint8Array> {
  return fc.tuple(fc.integer({ min: 1, max: 64 }), fc.boolean()).chain(([offset, longer]) => {
    const length = longer ? expectedLength + offset : Math.max(0, expectedLength - offset);
    return fc.uint8Array({ minLength: length, maxLength: length, size: "max" });
  });
}

test("全 7 アルゴリズムで署名と検証を往復でき、署名長が一致する", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(...SIGNING_CASES),
      fc.uint8Array({ maxLength: 256, size: "max" }),
      async (testCase, message) => {
        const signature = await cryptoImpl.sign(testCase.algorithm, testCase.key, message);
        assert.equal(
          signature.length,
          testCase.signatureLength,
          `${testCase.algorithm} の署名長が一致しない: ${signature.length}`,
        );
        // ECDSA は署名のたびに乱数を取るため「2 回の署名が同じ」ことは検査しない
        await cryptoImpl.verify(testCase.algorithm, testCase.key, message, signature);
      },
    ),
  );
});

test("任意の鍵とアルゴリズムの組で sign の失敗は CryptoError だけになる", async () => {
  await fc.assert(
    fc.asyncProperty(
      algorithmAndKeyArbitrary,
      fc.uint8Array({ maxLength: 256, size: "max" }),
      async ({ algorithm, key }, message) => {
        // 鍵の形がどう壊れていても、DOMException などの生の例外を漏らさず、
        // 解決するか CryptoError を投げるかのいずれかになる
        try {
          await cryptoImpl.sign(algorithm, key, message);
        } catch (error) {
          assert.ok(
            error instanceof CryptoError,
            `CryptoError を期待したが ${describeError(error)} が送出された (algorithm=${algorithm})`,
          );
        }
      },
    ),
  );
});

test("任意の鍵とアルゴリズムの組で verify の失敗も CryptoError だけになる", async () => {
  await fc.assert(
    fc.asyncProperty(
      algorithmAndKeyArbitrary,
      fc.uint8Array({ maxLength: 256, size: "max" }),
      signatureArbitrary,
      async ({ algorithm, key }, message, signature) => {
        // 鍵や署名がどう壊れていても、DOMException などの生の例外を漏らさない
        try {
          await cryptoImpl.verify(algorithm, key, message, signature);
        } catch (error) {
          assert.ok(
            error instanceof CryptoError,
            `CryptoError を期待したが ${describeError(error)} が送出された (algorithm=${algorithm})`,
          );
        }
      },
    ),
  );
});

test("改ざんされたメッセージ・署名・鍵を拒否する", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(...SIGNING_CASES),
      // 空でないメッセージに限定する (1 バイト変える位置が必要なため)
      fc.uint8Array({ minLength: 1, maxLength: 128, size: "max" }),
      fc.nat(),
      fc.nat(),
      async (testCase, message, messageIndexSeed, signatureIndexSeed) => {
        const signature = await cryptoImpl.sign(testCase.algorithm, testCase.key, message);

        // (a) メッセージを 1 バイト変えた場合は検証に失敗する
        const mutatedMessage = message.slice();
        const messageIndex = messageIndexSeed % message.length;
        mutatedMessage[messageIndex] = (mutatedMessage[messageIndex] ?? 0) ^ 0xff;
        const messageError = await captureCryptoError(() =>
          cryptoImpl.verify(testCase.algorithm, testCase.key, mutatedMessage, signature),
        );
        assert.equal(messageError.code, "signatureVerificationFailed");

        // (b) 署名の 1 ビットを反転した場合は検証に失敗する。ECDSA の可塑性
        //     ((r, n - s) を作る改変) を避けるため、ランダムな 1 ビットだけを反転する
        const mutatedSignature = signature.slice();
        const signatureIndex = signatureIndexSeed % signature.length;
        mutatedSignature[signatureIndex] = (mutatedSignature[signatureIndex] ?? 0) ^ 0x01;
        const signatureError = await captureCryptoError(() =>
          cryptoImpl.verify(testCase.algorithm, testCase.key, message, mutatedSignature),
        );
        assert.equal(signatureError.code, "signatureVerificationFailed");

        // (c) 同じアルゴリズムの別の鍵で検証した場合は失敗する
        const keyError = await captureCryptoError(() =>
          cryptoImpl.verify(testCase.algorithm, testCase.otherKey, message, signature),
        );
        assert.equal(keyError.code, "signatureVerificationFailed");
      },
    ),
  );
});

test("曲線とアルゴリズムが一致するときだけ署名と検証に成功する", async () => {
  const message = new TextEncoder().encode("curve and algorithm cross product");
  for (const curve of EC_CURVES) {
    for (const otherCurve of EC_CURVES) {
      const testCase = EC_SIGNING_CASES[curve];
      if (curve === otherCurve) {
        // 対応が一致する組は署名と検証に成功する
        const signature = await cryptoImpl.sign(testCase.algorithm, testCase.key, message);
        assert.equal(signature.length, testCase.signatureLength);
        await cryptoImpl.verify(testCase.algorithm, testCase.key, message, signature);
        continue;
      }
      // 曲線が一致しない組は、鍵の種別が同じでも署名と検証のどちらも拒否する
      const signError = await captureCryptoError(() =>
        cryptoImpl.sign(EC_ALGORITHMS[otherCurve], testCase.key, message),
      );
      assert.equal(
        signError.code,
        "unsupportedKey",
        `${curve} の鍵を ${EC_ALGORITHMS[otherCurve]} で署名できてしまった`,
      );
      const verifyError = await captureCryptoError(() =>
        cryptoImpl.verify(
          EC_ALGORITHMS[otherCurve],
          testCase.key,
          message,
          new Uint8Array(EC_SIGNING_CASES[otherCurve].signatureLength),
        ),
      );
      assert.equal(
        verifyError.code,
        "unsupportedKey",
        `${curve} の鍵を ${EC_ALGORITHMS[otherCurve]} で検証できてしまった`,
      );
    }
  }
});

test("曲線長と一致しない長さの ECDSA 署名を拒否する", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(...EC_CURVES).chain((curve) => {
        const testCase = EC_SIGNING_CASES[curve];
        return signatureWithLengthOtherThan(testCase.signatureLength).map((signature) => ({
          testCase,
          signature,
        }));
      }),
      fc.uint8Array({ maxLength: 64, size: "max" }),
      async ({ testCase, signature }, message) => {
        const error = await captureCryptoError(() =>
          cryptoImpl.verify(testCase.algorithm, testCase.key, message, signature),
        );
        assert.equal(
          error.code,
          "invalidSignatureLength",
          `${testCase.algorithm} が長さ ${signature.length} の署名を拒否しなかった`,
        );
      },
    ),
  );
});

test("64 バイトでない長さの Ed25519 署名を拒否する", async () => {
  await fc.assert(
    fc.asyncProperty(
      signatureWithLengthOtherThan(ED25519_SIGNING_CASE.signatureLength),
      fc.uint8Array({ maxLength: 64, size: "max" }),
      async (signature, message) => {
        const error = await captureCryptoError(() =>
          cryptoImpl.verify("EdDsa", ED25519_SIGNING_CASE.key, message, signature),
        );
        assert.equal(
          error.code,
          "invalidSignatureLength",
          `EdDsa が長さ ${signature.length} の署名を拒否しなかった`,
        );
      },
    ),
  );
});

test("HMAC は署名長を見ずに検証失敗にする", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(...HMAC_SIGNING_CASES),
      fc.uint8Array({ maxLength: 128, size: "max" }),
      signatureArbitrary,
      async (testCase, message, signature) => {
        // HMAC は署名長を検査しないため、長さがハッシュ長と異なっても
        // invalidSignatureLength ではなく signatureVerificationFailed になる
        const error = await captureCryptoError(() =>
          cryptoImpl.verify(testCase.algorithm, testCase.key, message, signature),
        );
        assert.equal(
          error.code,
          "signatureVerificationFailed",
          `${testCase.algorithm} が長さ ${signature.length} の署名で別のエラーを返した`,
        );
      },
    ),
  );
});

test("ダイジェストの長さがアルゴリズムと一致し、同じ入力で同じ出力になる", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(...DIGEST_ALGORITHMS),
      fc.uint8Array({ maxLength: 256, size: "max" }),
      async (algorithm, message) => {
        const first = await cryptoImpl.digest(algorithm, message);
        const second = await cryptoImpl.digest(algorithm, message);
        assert.equal(first.length, DIGEST_LENGTHS[algorithm]);
        assert.deepEqual(second, first, `${algorithm} の同じ入力に対する出力が一致しない`);
      },
    ),
  );
});
