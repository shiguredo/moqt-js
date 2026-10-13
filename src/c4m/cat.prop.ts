/**
 * CAT (CTA-5007-B / draft-ietf-moq-c4m-01) の Property-Based Testing
 *
 * claims の往復とバイト安定、発行したトークンのデコードと検証、改竄の検出、
 * 有効期間の検証を任意の入力で確認する。署名には実物の Web Crypto API
 * (`WebCrypto`) を使い、モックは使わない。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  type CatClaims,
  CatError,
  type CatErrorCode,
  CatToken,
  CatTokenBuilder,
  type ClaimValidationError,
  createCatClaims,
  decodeCatClaims,
  encodeCatClaims,
  validateCatClaims,
} from "./cat";
import {
  type CborValue,
  cborInteger,
  cborTextString,
  cborUnsigned,
  decodeCbor,
  encodeCbor,
} from "./cbor";
import {
  type CoseMessage,
  coseMessageHeader,
  decodeCoseMessage,
  encodeCoseHeader,
  encodeCoseMessage,
} from "./cose";
import {
  type CatDpop,
  type Match,
  type MoqtClaim,
  type MoqtScope,
  exactMatch,
  namespaceMatchEnd,
  namespaceMatchValue,
  prefixMatch,
  suffixMatch,
} from "./moqt";
import { type CoseKey, ec2Key, ec2KeyWithPrivateKey, symmetricKey } from "./crypto";
import { WebCrypto } from "./webcrypto";
import { assertClaimValidationError, cborValueArbitrary, decodeHex } from "./testSupport";
import {
  ES256_PRIVATE_KEY_HEX,
  ES256_PUBLIC_KEY_X_HEX,
  ES256_PUBLIC_KEY_Y_HEX,
  HMAC_KEY_HEX,
} from "./testVectors";

const cryptoImpl = new WebCrypto();
const TEXT_ENCODER = new TextEncoder();
const BASE64_URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** CatError が取り得るエラーコード */
const CAT_ERROR_CODES: readonly CatErrorCode[] = [
  "cbor",
  "cose",
  "c4m",
  "crypto",
  "invalidBase64",
  "invalidTokenFormat",
  "unexpectedType",
  "duplicateClaim",
  "missingAlgorithm",
  "typeMismatch",
  "algorithmMismatch",
  "invalidAuthTokenType",
  "detachedPayload",
  "nonFiniteNumber",
];

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

// =============================================================================
// Arbitrary 定義
// =============================================================================

/**
 * クレームの数値 (UNIX 秒)
 *
 * 整数と浮動小数点の両方を含める。`-0` は符号が失われて往復の比較が値の違いと
 * なるため除外する (エンコードは `-0` を 0 にする)。
 */
const claimNumberArbitrary: fc.Arbitrary<number> = fc
  .oneof(
    fc.integer({ min: 0, max: 2_000_000_000 }),
    fc.double({ min: 0, max: 2_000_000_000, noNaN: true, noDefaultInfinity: true }),
    fc.double({ min: -1_000_000, max: 0, noNaN: true, noDefaultInfinity: true }),
  )
  .filter((value) => !Object.is(value, -0));

/** 短いテキスト (grapheme 単位で UTF-8 として妥当な文字列だけを作る) */
const textArbitrary = fc.string({ unit: "grapheme", maxLength: 16, size: "max" });

/** `bin-match` (draft-ietf-moq-c4m-01 Section 2.1) */
const matchArbitrary: fc.Arbitrary<Match> = fc
  .tuple(
    fc.constantFrom<"exact" | "prefix" | "suffix">("exact", "prefix", "suffix"),
    fc.uint8Array({ maxLength: 8, size: "max" }),
  )
  .map(([type, pattern]) => {
    switch (type) {
      case "exact":
        return exactMatch(pattern);
      case "prefix":
        return prefixMatch(pattern);
      default:
        return suffixMatch(pattern);
    }
  });

/**
 * `moqt-scope`
 *
 * `end` (nil) は末尾にだけ置き、名前空間マッチが無い場合はトラックマッチを
 * 持たせない (実装が `trackWithoutNamespace` で拒否する入力を作らない)。
 */
const moqtScopeArbitrary: fc.Arbitrary<MoqtScope> = fc
  .record({
    actions: fc.uniqueArray(fc.integer({ min: 0, max: 8 }), {
      minLength: 1,
      maxLength: 4,
      size: "max",
    }),
    matches: fc.array(matchArbitrary, { maxLength: 3, size: "max" }),
    withEnd: fc.boolean(),
    track: fc.option(matchArbitrary, { nil: undefined }),
  })
  .map(({ actions, matches, withEnd, track }) => {
    const namespace = matches.map((match) => namespaceMatchValue(match));
    if (withEnd && namespace.length > 0) {
      namespace.push(namespaceMatchEnd());
    }
    return { actions, namespace, track: namespace.length === 0 ? undefined : track };
  });

/** `moqt` クレーム */
const moqtClaimArbitrary: fc.Arbitrary<MoqtClaim> = fc
  .array(moqtScopeArbitrary, { minLength: 1, maxLength: 3, size: "max" })
  .map((scopes) => ({ scopes }));

/** claim の生のエントリ (整数キーまたはテキストキー) */
const rawEntryArbitrary: fc.Arbitrary<[CborValue, CborValue]> = fc.tuple(
  fc.oneof(
    // 型付きのクレームキー (1 〜 8 / 321 / 327 / 328) を避ける
    fc.integer({ min: 1000, max: 2000 }).map((key) => cborInteger(key)),
    fc.stringMatching(/^[a-z][a-z0-9-]{0,7}$/).map((key) => cborTextString(key)),
  ),
  cborValueArbitrary(2),
);

/** claim の生のエントリ (整数キーのみ) */
const integerRawEntryArbitrary: fc.Arbitrary<[CborValue, CborValue]> = fc.tuple(
  fc.integer({ min: 1000, max: 2000 }).map((key) => cborInteger(key)),
  cborValueArbitrary(2),
);

/** 生のエントリのキーを識別する文字列 */
function rawKeyIdentity([key]: [CborValue, CborValue]): string {
  switch (key.type) {
    case "textString":
      return `t:${key.value}`;
    case "unsigned":
    case "negative":
      return `i:${String(key.value)}`;
    default:
      return `o:${key.type}`;
  }
}

/** `cnf` (confirmation) */
const confirmationArbitrary = fc
  .record({
    jwkThumbprint: fc.option(fc.uint8Array({ minLength: 1, maxLength: 32, size: "max" }), {
      nil: undefined,
    }),
    c4mDraftJwkThumbprint: fc.option(fc.uint8Array({ minLength: 1, maxLength: 32, size: "max" }), {
      nil: undefined,
    }),
    // jkt のラベル (3 / 323) は型付きで解釈するため raw からは除く
    raw: fc.uniqueArray(rawEntryArbitrary, { selector: rawKeyIdentity, maxLength: 2, size: "max" }),
  })
  .map(({ jwkThumbprint, c4mDraftJwkThumbprint, raw }) => ({
    jwkThumbprint,
    c4mDraftJwkThumbprint,
    raw: sortRawEntries(raw),
  }));

/** `catdpop` */
const catDpopArbitrary: fc.Arbitrary<CatDpop> = fc
  .record({
    windowSeconds: fc.option(claimNumberArbitrary, { nil: undefined }),
    honorJti: fc.option(fc.boolean(), { nil: undefined }),
    // ラベル 0 / 1 は型付きで解釈するため raw からは除く。デコード側はラベルを
    // i64 の整数に限るため、テキストキーも使わない
    raw: fc.uniqueArray(integerRawEntryArbitrary, {
      selector: rawKeyIdentity,
      maxLength: 2,
      size: "max",
    }),
  })
  .map(({ windowSeconds, honorJti, raw }) => ({
    windowSeconds,
    honorJti,
    raw: sortRawEntries(raw),
  }));

/** claims 全体 */
const claimsArbitrary: fc.Arbitrary<CatClaims> = fc
  .record({
    issuer: fc.option(textArbitrary, { nil: undefined }),
    subject: fc.option(textArbitrary, { nil: undefined }),
    audience: fc.array(textArbitrary, { maxLength: 3, size: "max" }),
    expiration: fc.option(claimNumberArbitrary, { nil: undefined }),
    notBefore: fc.option(claimNumberArbitrary, { nil: undefined }),
    issuedAt: fc.option(claimNumberArbitrary, { nil: undefined }),
    cwtId: fc.option(fc.uint8Array({ maxLength: 16, size: "max" }), { nil: undefined }),
    confirmation: fc.option(confirmationArbitrary, { nil: undefined }),
    moqt: fc.option(moqtClaimArbitrary, { nil: undefined }),
    moqtReval: fc.option(claimNumberArbitrary, { nil: undefined }),
    catdpop: fc.option(catDpopArbitrary, { nil: undefined }),
    raw: fc.uniqueArray(rawEntryArbitrary, { selector: rawKeyIdentity, maxLength: 3, size: "max" }),
  })
  .map((values) => {
    const claims = createCatClaims();
    claims.issuer = values.issuer;
    claims.subject = values.subject;
    claims.audience.push(...values.audience);
    claims.expiration = values.expiration;
    claims.notBefore = values.notBefore;
    claims.issuedAt = values.issuedAt;
    claims.cwtId = values.cwtId;
    claims.confirmation = values.confirmation;
    claims.moqt = values.moqt;
    claims.moqtReval = values.moqtReval;
    claims.catdpop = values.catdpop;
    claims.raw.push(...sortRawEntries(values.raw));
    return claims;
  });

/**
 * バイト列を辞書順で比較する
 */
function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

/**
 * 生のエントリを決定論的エンコードのキー順に並べる
 *
 * CBOR のマップは順序を持たない。トークンの往復ではキーが決定論的エンコードの
 * 順序に並ぶため、生成時点でも同じ順序にしておく (順序の違いを値の違いとして
 * 検出しないため)。
 */
function sortRawEntries(entries: Array<[CborValue, CborValue]>): Array<[CborValue, CborValue]> {
  return entries
    .slice()
    .sort(([left], [right]) => compareBytes(encodeCbor(left), encodeCbor(right)));
}

/**
 * バイト列の指定したビットを反転した複製を返す
 */
function flipBit(bytes: Uint8Array, bitIndex: number): Uint8Array {
  const result = bytes.slice();
  if (result.length === 0) {
    return result;
  }
  const index = bitIndex % (result.length * 8);
  const byteIndex = Math.floor(index / 8);
  result[byteIndex] = (result[byteIndex] ?? 0) ^ (1 << (index % 8));
  return result;
}

/**
 * メッセージの payload を 1 ビット反転した複製を返す
 */
function withMutatedPayload(message: CoseMessage, bitIndex: number): CoseMessage {
  if (message.type === "sign1") {
    return {
      type: "sign1",
      sign1: {
        ...message.sign1,
        payload: flipBit(message.sign1.payload ?? new Uint8Array(0), bitIndex),
      },
    };
  }
  return {
    type: "mac0",
    mac0: {
      ...message.mac0,
      payload: flipBit(message.mac0.payload ?? new Uint8Array(0), bitIndex),
    },
  };
}

/**
 * メッセージの署名 (MAC) を 1 ビット反転した複製を返す
 */
function withMutatedSignature(message: CoseMessage, bitIndex: number): CoseMessage {
  if (message.type === "sign1") {
    return {
      type: "sign1",
      sign1: { ...message.sign1, signature: flipBit(message.sign1.signature, bitIndex) },
    };
  }
  return { type: "mac0", mac0: { ...message.mac0, tag: flipBit(message.mac0.tag, bitIndex) } };
}

/**
 * protected ヘッダに解釈しないパラメータを足した複製を返す
 */
function withExtraProtectedParameter(message: CoseMessage): CoseMessage {
  const header = coseMessageHeader(message);
  header.raw.push([cborUnsigned(99n), cborTextString("x")]);
  const protectedBytes = encodeCbor(encodeCoseHeader(header));
  if (message.type === "sign1") {
    return { type: "sign1", sign1: { ...message.sign1, protected: protectedBytes } };
  }
  return { type: "mac0", mac0: { ...message.mac0, protected: protectedBytes } };
}

// =============================================================================
// claims のコーデック
// =============================================================================

test("claims はエンコードとデコードで往復し、再エンコードが安定する", () => {
  fc.assert(
    fc.property(claimsArbitrary, (claims) => {
      const encoded = encodeCbor(encodeCatClaims(claims));
      const decoded = decodeCatClaims(decodeCbor(encoded));
      // 値として往復する (raw の順序も保たれる)
      assert.deepEqual(decoded, claims);
      // バイト列として安定する
      assert.deepEqual(encodeCbor(encodeCatClaims(decoded)), encoded);
    }),
  );
});

test("任意のデータ項目の claims デコードは成功するか CatError になる", () => {
  fc.assert(
    fc.property(cborValueArbitrary(3), (value) => {
      try {
        decodeCatClaims(value);
      } catch (error) {
        assert.ok(error instanceof CatError, `CatError を期待したが ${String(error)} が送出された`);
        assert.include(CAT_ERROR_CODES, error.code);
      }
    }),
  );
});

// =============================================================================
// トークンの発行と検証
// =============================================================================

test("HMAC で発行した compact / COSE トークンはデコードして検証でき、claims が保たれる", async () => {
  const key = hmacKey();
  await fc.assert(
    fc.asyncProperty(claimsArbitrary, async (claims) => {
      const compactText = await new CatTokenBuilder({ claims }).buildCompact(cryptoImpl, key);
      const compact = CatToken.decode(TEXT_ENCODER.encode(compactText));
      assert.equal(compact.format(), "compact");
      await compact.verify(cryptoImpl, key, { expectedType: "CAT" });
      assert.deepEqual(compact.claims(), claims);

      const coseBytes = await new CatTokenBuilder({ claims }).buildCose(cryptoImpl, key);
      const cose = CatToken.decode(coseBytes);
      assert.equal(cose.format(), "coseMac0");
      await cose.verify(cryptoImpl, key, { expectedType: "CAT" });
      assert.deepEqual(cose.claims(), claims);
    }),
    { numRuns: 50 },
  );
});

test("ES256 で発行したトークンは公開鍵で検証でき、claims が保たれる", async () => {
  const privateKey = es256PrivateKey();
  const publicKey = es256PublicKey();
  await fc.assert(
    fc.asyncProperty(claimsArbitrary, async (claims) => {
      const coseBytes = await new CatTokenBuilder({ claims }).buildCose(cryptoImpl, privateKey);
      const cose = CatToken.decode(coseBytes);
      assert.equal(cose.format(), "coseSign1");
      assert.equal(cose.header().algorithm, "Es256");
      await cose.verify(cryptoImpl, publicKey, { expectedAlgorithm: "Es256", expectedType: "CAT" });
      assert.deepEqual(cose.claims(), claims);

      const compactText = await new CatTokenBuilder({ claims }).buildCompact(
        cryptoImpl,
        privateKey,
      );
      const compact = CatToken.decode(TEXT_ENCODER.encode(compactText));
      await compact.verify(cryptoImpl, publicKey, { expectedAlgorithm: "Es256" });
      assert.deepEqual(compact.claims(), claims);
    }),
    { numRuns: 50 },
  );
});

// =============================================================================
// 改竄の検出
// =============================================================================

test("compact トークンの 1 文字を変えると検証は成功しない", async () => {
  const key = hmacKey();
  await fc.assert(
    fc.asyncProperty(
      claimsArbitrary,
      fc.nat(),
      fc.integer({ min: 0, max: 63 }),
      async (claims, positionSeed, characterSeed) => {
        const text = await new CatTokenBuilder({ claims }).buildCompact(cryptoImpl, key);
        const position = positionSeed % text.length;
        const replacement = BASE64_URL_ALPHABET.charAt(characterSeed);
        fc.pre(replacement !== text.charAt(position));
        const mutated = text.slice(0, position) + replacement + text.slice(position + 1);

        let verified = false;
        try {
          await CatToken.decode(TEXT_ENCODER.encode(mutated)).verify(cryptoImpl, key);
          verified = true;
        } catch (error) {
          assert.ok(error instanceof CatError, `CatError を期待したが ${String(error)}`);
        }
        assert.equal(verified, false, `改竄した compact トークンが検証に成功した: ${mutated}`);
      },
    ),
    { numRuns: 50 },
  );
});

test("COSE トークンの payload / 署名 / protected を変えると検証は成功しない", async () => {
  const key = hmacKey();
  await fc.assert(
    fc.asyncProperty(claimsArbitrary, fc.nat(), async (claims, bitSeed) => {
      const bytes = await new CatTokenBuilder({ claims }).buildCose(cryptoImpl, key);
      const message = decodeCoseMessage(bytes);
      const mutations: Array<[string, CoseMessage]> = [
        ["payload", withMutatedPayload(message, bitSeed)],
        ["signature", withMutatedSignature(message, bitSeed)],
        ["protected", withExtraProtectedParameter(message)],
      ];
      for (const [name, mutated] of mutations) {
        const mutatedBytes = encodeCoseMessage(mutated, { coseTag: true, cwtTag: true });
        let verified = false;
        try {
          await CatToken.decode(mutatedBytes).verify(cryptoImpl, key);
          verified = true;
        } catch (error) {
          assert.ok(error instanceof CatError, `CatError を期待したが ${String(error)}`);
        }
        assert.equal(verified, false, `${name} を改竄したトークンが検証に成功した`);
      }
    }),
    { numRuns: 25 },
  );
});

// =============================================================================
// デコードの全域性
// =============================================================================

test("任意のバイト列のデコードは成功するか CatError になり、生トークンは入力のまま保たれる", () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 96, size: "max" }), (bytes) => {
      try {
        const token = CatToken.decode(bytes);
        // bearer クレデンシャルをそのまま転送できること (再直列化しない)
        assert.deepEqual(token.rawToken(), bytes);
        assert.deepEqual(CatToken.decode(token.rawToken()).claims(), token.claims());
      } catch (error) {
        assert.ok(error instanceof CatError, `CatError を期待したが ${String(error)} が送出された`);
        assert.include(CAT_ERROR_CODES, error.code);
      }
    }),
  );
});

// =============================================================================
// クレームの検証
// =============================================================================

test("有効期間の検証は区間 [nbf - ずれ, exp + ずれ] と一致する", () => {
  fc.assert(
    fc.property(
      fc.option(fc.integer({ min: 0, max: 2_000_000_000 }), { nil: undefined }),
      fc.option(fc.integer({ min: 0, max: 2_000_000_000 }), { nil: undefined }),
      fc.integer({ min: 0, max: 1000 }),
      fc.integer({ min: 0, max: 2_000_000_000 }),
      (expiration, notBefore, tolerance, reference) => {
        const claims = createCatClaims();
        claims.expiration = expiration;
        claims.notBefore = notBefore;
        const expired = expiration !== undefined && reference > expiration + tolerance;
        const notYetValid = notBefore !== undefined && reference + tolerance < notBefore;
        const expected = !expired && !notYetValid;

        try {
          validateCatClaims(claims, {
            referenceTimeSeconds: reference,
            clockToleranceSeconds: tolerance,
          });
          assert.equal(expected, true, "拒否されるはずのクレームが受理された");
        } catch (error) {
          assert.ok(error instanceof Error);
          const failure = error as ClaimValidationError;
          assert.equal(expected, false, `受理されるはずのクレームが拒否された: ${failure.code}`);
          // 期限切れを先に判定する
          assert.equal(failure.code, expired ? "expired" : "notYetValid");
        }
      },
    ),
  );
});

test("非有限の数値クレームと非有限・負の許容ずれは拒否される", () => {
  const nonFiniteArbitrary = fc.constantFrom(
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  );
  for (const field of ["expiration", "notBefore", "issuedAt", "moqtReval"] as const) {
    fc.assert(
      fc.property(nonFiniteArbitrary, (value) => {
        const claims = createCatClaims();
        claims[field] = value;
        assertClaimValidationError(
          () => validateCatClaims(claims, { referenceTimeSeconds: 0 }),
          "nonFiniteClaim",
        );
      }),
    );
  }
  fc.assert(
    fc.property(nonFiniteArbitrary, (value) => {
      const claims = createCatClaims();
      claims.catdpop = { windowSeconds: value, honorJti: undefined, raw: [] };
      assertClaimValidationError(
        () => validateCatClaims(claims, { referenceTimeSeconds: 0 }),
        "nonFiniteClaim",
      );
    }),
  );
  // 現在時刻と許容ずれも有限でなければならない
  fc.assert(
    fc.property(nonFiniteArbitrary, (value) => {
      assertClaimValidationError(
        () => validateCatClaims(createCatClaims(), { referenceTimeSeconds: value }),
        "invalidReferenceTime",
      );
      assertClaimValidationError(
        () => validateCatClaims(createCatClaims(), { clockToleranceSeconds: value }),
        "invalidReferenceTime",
      );
    }),
  );
  assertClaimValidationError(
    () => validateCatClaims(createCatClaims(), { clockToleranceSeconds: -1 }),
    "invalidReferenceTime",
  );
});

test("発行者と宛先の検証は期待値を指定したときだけ行われる", () => {
  fc.assert(
    fc.property(
      textArbitrary,
      textArbitrary,
      fc.array(textArbitrary, { maxLength: 3, size: "max" }),
      (issuer, other, audiences) => {
        const claims = createCatClaims();
        claims.issuer = issuer;
        claims.audience.push(...audiences);
        // 期待値を指定しなければ通る
        validateCatClaims(claims, { referenceTimeSeconds: 0 });
        // 発行者が一致すれば通る
        validateCatClaims(claims, { referenceTimeSeconds: 0, expectedIssuers: [issuer] });
        if (other !== issuer) {
          assertClaimValidationError(
            () => validateCatClaims(claims, { referenceTimeSeconds: 0, expectedIssuers: [other] }),
            "issuerMismatch",
          );
        }
        if (!audiences.includes(other)) {
          assertClaimValidationError(
            () =>
              validateCatClaims(claims, { referenceTimeSeconds: 0, expectedAudiences: [other] }),
            "audienceMismatch",
          );
        }
      },
    ),
  );
});
