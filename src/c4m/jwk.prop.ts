/**
 * JWK (RFC 7517) と JWK サムプリント (RFC 7638) の Property-Based Testing
 *
 * `CoseKey` との往復、正規化 JSON (RFC 7638 Section 3.2) の決定論、サムプリントの
 * 表現不変性、`encodeJwk` / `decodeJwk` の往復、不正な JWK の拒否を任意の入力で
 * 確認する。
 *
 * 生成するバイト列は曲線長 (P-256: 32 / P-384: 48 / P-521: 66) に合わせない。
 * `jwk.ts` は鍵材の長さを検証せず、長さの検証は Web Crypto API に任せる方針で
 * あるため、任意長のバイト列で往復することを固定する。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { encodeBase64Url } from "./base64url";
import {
  type CoseKey,
  ec2Key,
  ec2KeyWithPrivateKey,
  ed25519Key,
  ed25519KeyWithPrivateKey,
  symmetricKey,
} from "./crypto";
import {
  type Jwk,
  canonicalJwkJson,
  coseKeyToJwk,
  decodeJwk,
  encodeJwk,
  jwkThumbprintSha256,
  jwkToCoseKey,
} from "./jwk";
import { assertJwkError } from "./testSupport";
import { unreachableValue } from "./unreachable";
import { WebCrypto } from "./webcrypto";

/** サムプリントの計算に使う実装 (Web Crypto API の実物を使う) */
const cryptoImpl = new WebCrypto();

/** 曲線長に合わせない任意のバイト列 (空のバイト列を含む) */
const bytesArbitrary = fc.uint8Array({ maxLength: 80, size: "max" });

/** 秘密鍵のメンバーの有無を作るための任意のバイト列 */
const optionalBytesArbitrary = fc.option(bytesArbitrary, { nil: undefined });

/** COSE の楕円曲線 (RFC 9053 Section 7) */
const EC_CURVES = ["P256", "P384", "P521"] as const;

/**
 * 任意の `CoseKey`
 *
 * 鍵の型 (symmetric / ec2 / okp)、曲線、各バイト列の長さ、秘密鍵の有無を網羅する。
 */
const coseKeyArbitrary: fc.Arbitrary<CoseKey> = fc.oneof(
  bytesArbitrary.map((key) => symmetricKey(key)),
  fc
    .tuple(fc.constantFrom(...EC_CURVES), bytesArbitrary, bytesArbitrary, optionalBytesArbitrary)
    .map(([curve, x, y, privateKey]) =>
      privateKey === undefined
        ? ec2Key(curve, x, y)
        : ec2KeyWithPrivateKey(curve, x, y, privateKey),
    ),
  fc
    .tuple(bytesArbitrary, optionalBytesArbitrary)
    .map(([publicKey, privateKey]) =>
      privateKey === undefined
        ? ed25519Key(publicKey)
        : ed25519KeyWithPrivateKey(publicKey, privateKey),
    ),
);

/**
 * base64url のメンバーにパディングを付ける
 *
 * 正規の base64url は長さが 4 で割って 1 余ることはないため、付くパディングは
 * 0〜2 文字になる (RFC 4648 Section 4)。
 */
function padBase64Url(value: string): string {
  return value + "=".repeat((4 - (value.length % 4)) % 4);
}

/**
 * JWK の base64url のメンバーだけを変換する
 *
 * `kty` / `crv` は base64url ではないため変換しない。
 */
function mapBase64UrlFields(jwk: Jwk, transform: (value: string) => string): Jwk {
  switch (jwk.kty) {
    case "EC":
      return {
        kty: "EC",
        crv: jwk.crv,
        x: transform(jwk.x),
        y: transform(jwk.y),
        d: jwk.d === undefined ? undefined : transform(jwk.d),
      };
    case "OKP":
      return {
        kty: "OKP",
        crv: jwk.crv,
        x: transform(jwk.x),
        d: jwk.d === undefined ? undefined : transform(jwk.d),
      };
    case "oct":
      return { kty: "oct", k: transform(jwk.k) };
    default:
      return unreachableValue(jwk);
  }
}

/**
 * 秘密鍵のメンバーを落とした JWK を返す
 *
 * `oct` は秘密鍵のメンバーを持たないため、そのまま返す。
 */
function withoutPrivateKey(jwk: Jwk): Jwk {
  switch (jwk.kty) {
    case "EC":
      return { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y, d: undefined };
    case "OKP":
      return { kty: "OKP", crv: jwk.crv, x: jwk.x, d: undefined };
    case "oct":
      return jwk;
    default:
      return unreachableValue(jwk);
  }
}

/**
 * 秘密鍵のメンバーを付けた JWK を返す
 *
 * `oct` は秘密鍵のメンバーを持たないため、そのまま返す。
 */
function withPrivateKey(jwk: Jwk, value: string): Jwk {
  switch (jwk.kty) {
    case "EC":
      return { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y, d: value };
    case "OKP":
      return { kty: "OKP", crv: jwk.crv, x: jwk.x, d: value };
    case "oct":
      return jwk;
    default:
      return unreachableValue(jwk);
  }
}

/** JWK の JSON に現れるメンバー名 (並び順の生成に使う) */
const JWK_MEMBER_NAMES = ["crv", "kty", "x", "y", "d", "k"] as const;

/**
 * JSON のメンバーの並び順を表す任意のリスト
 *
 * `fc.shuffledSubarray` は部分集合を任意の順序で返す。リストに現れないメンバーは
 * `reorderJwkJson` が元の順序のまま末尾に残すため、任意のメンバー順が作れる。
 */
const memberOrderArbitrary = fc.shuffledSubarray([...JWK_MEMBER_NAMES], {
  minLength: 1,
  maxLength: JWK_MEMBER_NAMES.length,
});

/**
 * JSON のメンバーを `order` の順に並べ替える
 *
 * `order` に現れないメンバーは元の順序を保つ (安定ソート)。
 */
function reorderJwkJson(text: string, order: readonly string[]): string {
  const parsed = JSON.parse(text) as Record<string, string>;
  const entries = Object.entries(parsed).sort(
    ([left], [right]) => order.indexOf(left) - order.indexOf(right),
  );
  return JSON.stringify(Object.fromEntries(entries));
}

/** RFC 7638 Section 3.2 が定める必須メンバー (辞書順) */
const REQUIRED_MEMBERS: Record<Jwk["kty"], readonly string[]> = {
  EC: ["crv", "kty", "x", "y"],
  OKP: ["crv", "kty", "x"],
  oct: ["k", "kty"],
};

test("CoseKey は JWK を経由して往復する", () => {
  fc.assert(
    fc.property(coseKeyArbitrary, (key) => {
      // 曲線長に合わせない任意長のバイト列でも、鍵の型・曲線・各バイト列・秘密鍵の
      // 有無がそのまま復元される
      assert.deepEqual(
        jwkToCoseKey(coseKeyToJwk(key)),
        key,
        `鍵の往復に失敗した: ${JSON.stringify(key)}`,
      );
    }),
  );
});

test("正規化 JSON は RFC 7638 の決定論的な表現になる", () => {
  fc.assert(
    fc.property(
      coseKeyArbitrary,
      memberOrderArbitrary,
      fc.string({ unit: "grapheme", maxLength: 12, size: "max" }),
      (key, order, privateKeyValue) => {
        const jwk = coseKeyToJwk(key);
        const canonical = canonicalJwkJson(jwk);

        // 冪等性: 正規化した JSON をデコードして再度正規化しても同じ文字列になる
        assert.equal(
          canonicalJwkJson(decodeJwk(canonical)),
          canonical,
          `正規化 JSON が冪等でない: ${canonical}`,
        );

        // パディング非依存: パディングを付けても正規化で除去される
        assert.equal(
          canonicalJwkJson(mapBase64UrlFields(jwk, padBase64Url)),
          canonical,
          `パディング付きの表現で正規化 JSON が変化した: ${canonical}`,
        );

        // 秘密鍵非依存: d の有無と内容は必須メンバーではないため出力に影響しない
        assert.equal(
          canonicalJwkJson(withoutPrivateKey(jwk)),
          canonical,
          `秘密鍵を落とした表現で正規化 JSON が変化した: ${canonical}`,
        );
        assert.equal(
          canonicalJwkJson(withPrivateKey(jwk, privateKeyValue)),
          canonical,
          `秘密鍵を付けた表現で正規化 JSON が変化した: ${canonical}`,
        );

        // メンバー順非依存: 並べ替えた JSON をデコードしても同じ正規化 JSON になる
        assert.equal(
          canonicalJwkJson(decodeJwk(reorderJwkJson(encodeJwk(jwk), order))),
          canonical,
          `メンバー順を変えた表現で正規化 JSON が変化した: ${canonical}`,
        );

        // 空白を含まない (RFC 7638 Section 3.2)
        assert.notMatch(canonical, /\s/, `正規化 JSON に空白が含まれる: ${canonical}`);

        // 必須メンバーだけが辞書順に並ぶ
        assert.deepEqual(
          Object.keys(JSON.parse(canonical) as Record<string, string>),
          REQUIRED_MEMBERS[jwk.kty],
          `必須メンバーの並びが RFC 7638 Section 3.2 と異なる: ${canonical}`,
        );
      },
    ),
  );
});

test("JWK サムプリントは同じ鍵材を表す表現に依存しない", async () => {
  await fc.assert(
    fc.asyncProperty(
      coseKeyArbitrary,
      memberOrderArbitrary,
      fc.string({ unit: "grapheme", maxLength: 12, size: "max" }),
      async (key, order, privateKeyValue) => {
        const jwk = coseKeyToJwk(key);
        const thumbprint = await jwkThumbprintSha256(cryptoImpl, jwk);

        // SHA-256 の出力長は 32 バイト (RFC 7638 Section 3.1)
        assert.equal(thumbprint.length, 32, `サムプリントの長さが 32 でない: ${thumbprint.length}`);

        // 同じ入力に対する 2 回目の呼び出しは同じ値を返す
        assert.deepEqual(
          await jwkThumbprintSha256(cryptoImpl, jwk),
          thumbprint,
          "同じ入力のサムプリントが一致しない",
        );

        // パディングの有無
        assert.deepEqual(
          await jwkThumbprintSha256(cryptoImpl, mapBase64UrlFields(jwk, padBase64Url)),
          thumbprint,
          "パディング付きの表現でサムプリントが変化した",
        );

        // 秘密鍵のメンバーの有無と内容。`canonicalJwkJson` は d を検証しないため、
        // base64url として不正な文字列の d でもサムプリントは変わらない
        assert.deepEqual(
          await jwkThumbprintSha256(cryptoImpl, withoutPrivateKey(jwk)),
          thumbprint,
          "秘密鍵を落とした表現でサムプリントが変化した",
        );
        assert.deepEqual(
          await jwkThumbprintSha256(cryptoImpl, withPrivateKey(jwk, privateKeyValue)),
          thumbprint,
          "秘密鍵を付けた表現でサムプリントが変化した",
        );

        // encodeJwk → decodeJwk の往復
        assert.deepEqual(
          await jwkThumbprintSha256(cryptoImpl, decodeJwk(encodeJwk(jwk))),
          thumbprint,
          "エンコードとデコードを経由するとサムプリントが変化した",
        );

        // JSON のメンバー順の変更
        assert.deepEqual(
          await jwkThumbprintSha256(cryptoImpl, decodeJwk(reorderJwkJson(encodeJwk(jwk), order))),
          thumbprint,
          "メンバー順を変えた表現でサムプリントが変化した",
        );
      },
    ),
  );
});

/**
 * 空文字・制御文字・JSON でエスケープが必要な文字を含む任意の文字列
 *
 * `binary` は孤立サロゲートも生成する。`JSON.stringify` (ES2019 の well-formed
 * JSON.stringify) は孤立サロゲートを `\udXXX` としてエスケープするため、
 * `decodeJwk` の往復で復元される。
 */
const textArbitrary = fc.oneof(
  fc.string({ unit: "grapheme", maxLength: 24, size: "max" }),
  fc.string({ unit: "binary", maxLength: 24, size: "max" }),
  fc.constantFrom("", "=", "==", "====", "\u0000", "\n", "\t", "\u001F", "\u007F", '"', "\\"),
);

/** kty ごとの任意の JWK (秘密鍵のメンバーを持たない場合も含む) */
const arbitraryJwkArbitrary: fc.Arbitrary<Jwk> = fc.oneof(
  fc.record({
    kty: fc.constant("EC" as const),
    crv: textArbitrary,
    x: textArbitrary,
    y: textArbitrary,
    d: fc.option(textArbitrary, { nil: undefined }),
  }),
  fc.record({
    kty: fc.constant("OKP" as const),
    crv: textArbitrary,
    x: textArbitrary,
    d: fc.option(textArbitrary, { nil: undefined }),
  }),
  fc.record({ kty: fc.constant("oct" as const), k: textArbitrary }),
);

test("encodeJwk と decodeJwk は任意の JWK で往復する", () => {
  fc.assert(
    fc.property(arbitraryJwkArbitrary, (jwk) => {
      const encoded = encodeJwk(jwk);
      // decodeJwk は base64url を検証しないため、任意の文字列で往復する。
      // 検証は jwkToCoseKey が行う
      assert.deepEqual(decodeJwk(encoded), jwk, `JWK の往復に失敗した: ${encoded}`);

      if (jwk.kty === "oct" || jwk.d === undefined) {
        // 秘密鍵が無いときは d のメンバーを出力しない。文字列の検索では値を
        // 誤検出するため、パースしたオブジェクトのメンバーで確認する
        const members = JSON.parse(encoded) as Record<string, unknown>;
        assert.equal("d" in members, false, `秘密鍵が無いのに d を出力した: ${encoded}`);
      }
    }),
  );
});

/** 対応する EC の曲線名 (RFC 7518 Section 6.2.1.1) */
const EC_CURVE_NAMES = new Set(["P-256", "P-384", "P-521"]);

/** 非対応の EC 曲線名 */
const unsupportedEcCurveArbitrary = fc
  .oneof(
    fc.constantFrom("P-224", "P-2560", "p-256", "secp256k1", ""),
    fc.string({ unit: "grapheme", maxLength: 12, size: "max" }),
  )
  .filter((crv) => !EC_CURVE_NAMES.has(crv));

/** 非対応の OKP 曲線名 */
const unsupportedOkpCurveArbitrary = fc
  .oneof(
    fc.constantFrom("X25519", "Ed448", "ed25519", ""),
    fc.string({ unit: "grapheme", maxLength: 12, size: "max" }),
  )
  .filter((crv) => crv !== "Ed25519");

test("非対応の曲線を持つ JWK を拒否する", () => {
  fc.assert(
    fc.property(
      unsupportedEcCurveArbitrary,
      textArbitrary,
      textArbitrary,
      fc.option(textArbitrary, { nil: undefined }),
      (crv, x, y, d) => {
        // 曲線の判定は base64url の検証より先に行うため、x / y / d が不正でも
        // unsupportedCurve になる
        assertJwkError(() => jwkToCoseKey({ kty: "EC", crv, x, y, d }), "unsupportedCurve");
      },
    ),
  );

  fc.assert(
    fc.property(
      unsupportedOkpCurveArbitrary,
      textArbitrary,
      fc.option(textArbitrary, { nil: undefined }),
      (crv, x, d) => {
        assertJwkError(() => jwkToCoseKey({ kty: "OKP", crv, x, d }), "unsupportedCurve");
      },
    ),
  );
});

/** base64url のアルファベット (RFC 4648 Section 5) に含まれない文字 */
const INVALID_BASE64_URL_CHARACTERS = ["*", "+", "/", " ", "!", "\u0000", "\u007F", "é", "あ"];

/**
 * base64url として必ず不正になる文字列
 *
 * アルファベット外の文字を 1 文字以上含むため、パディング有り / 無しのどちらの
 * 解釈でも `decodeBase64Url` は失敗する。
 */
const invalidBase64UrlArbitrary = fc
  .tuple(
    fc.string({ unit: "binary", maxLength: 8, size: "max" }),
    fc.constantFrom(...INVALID_BASE64_URL_CHARACTERS),
    fc.string({ unit: "binary", maxLength: 8, size: "max" }),
  )
  .map(([prefix, invalid, suffix]) => prefix + invalid + suffix);

/** base64url として正しい値 (不正な値と対比させるために使う) */
const VALID_BASE64_URL = encodeBase64Url(new Uint8Array(32));

/** 不正な base64url を入れるメンバー */
const INVALID_MEMBER_POSITIONS = ["EC.x", "EC.y", "EC.d", "OKP.x", "OKP.d", "oct.k"] as const;

type InvalidMemberPosition = (typeof INVALID_MEMBER_POSITIONS)[number];

/**
 * 指定したメンバーだけを不正な base64url にした JWK を作る
 *
 * それ以外のメンバーは正しい曲線名と base64url にする。
 */
function jwkWithInvalidMember(position: InvalidMemberPosition, invalid: string): Jwk {
  switch (position) {
    case "EC.x":
      return { kty: "EC", crv: "P-256", x: invalid, y: VALID_BASE64_URL, d: undefined };
    case "EC.y":
      return { kty: "EC", crv: "P-256", x: VALID_BASE64_URL, y: invalid, d: undefined };
    case "EC.d":
      return { kty: "EC", crv: "P-256", x: VALID_BASE64_URL, y: VALID_BASE64_URL, d: invalid };
    case "OKP.x":
      return { kty: "OKP", crv: "Ed25519", x: invalid, d: undefined };
    case "OKP.d":
      return { kty: "OKP", crv: "Ed25519", x: VALID_BASE64_URL, d: invalid };
    case "oct.k":
      return { kty: "oct", k: invalid };
    default:
      return unreachableValue(position);
  }
}

test("base64url として不正なメンバーを持つ JWK を拒否する", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...INVALID_MEMBER_POSITIONS),
      invalidBase64UrlArbitrary,
      (position, invalid) => {
        const jwk = jwkWithInvalidMember(position, invalid);
        // 不正なメンバーは CoseKey への変換時に検出する
        assertJwkError(() => jwkToCoseKey(jwk), "invalidBase64");
        // decodeJwk は base64url を検証しないため、エンコードを経由しても
        // 変換時に同じエラーになる
        assertJwkError(() => jwkToCoseKey(decodeJwk(encodeJwk(jwk))), "invalidBase64");
      },
    ),
  );
});
