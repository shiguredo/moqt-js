/**
 * C4M DevTools の鍵入力の解釈の Property-Based Testing
 *
 * 対称鍵の入力 (16 進 / base64url / テキスト) が元のバイト列へ戻ること、形式の自動
 * 判別が仕様どおりの優先順で決まること、任意の入力に対して例外を漏らさないこと
 * (画面が入力のたびに壊れないこと) を確かめる。あわせて JWK の公開鍵化が署名に
 * 使える秘密鍵のメンバーだけを落とすことを確かめる。
 *
 * 鍵の生成 (`generateKey`) は乱数を使うため対象にしない (鍵の一意性などは単体テストの
 * 領分)。ここでは生成した入力の解釈だけを扱う。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { C4M } from "moqt-js";
import {
  type SecretInputFormat,
  bytesToHex,
  describeJwk,
  hasPrivateKey,
  inspectKeyInput,
  parseSecretInput,
  publicJwkOf,
} from "./keys";

const TEXT_ENCODER = new TextEncoder();

/** 解析の往復に使うバイト列 (長い入力を含める) */
const bytesArbitrary = fc.uint8Array({ maxLength: 48, size: "max" });

/** 表示用の 16 進の書き方 */
type HexStyle = "plain" | "prefix" | "upper";

const hexStyleArbitrary = fc.constantFrom<HexStyle>("plain", "prefix", "upper");

/**
 * 生成したバイト列を指定の書き方の 16 進文字列にする
 *
 * `0x` 接頭辞と大文字はどちらも 16 進として解釈できる (実装の JSDoc は 0x 付きを
 * 認めており、桁の判定は大文字小文字を問わない)。
 */
function toHexInput(bytes: Uint8Array, style: HexStyle): string {
  const hex = bytesToHex(bytes);
  switch (style) {
    case "plain":
      return hex;
    case "prefix":
      return `0x${hex}`;
    default:
      return hex.toUpperCase();
  }
}

/**
 * 16 進として解釈できない入力
 *
 * 16 進のアルファベットに無い文字 (g 〜 z) を必ず 1 つ含む。ただし `0x` 接頭辞は 16 進として
 * 解釈できる (`hexToBytes` は接頭辞を外した残りが空でなく、偶数桁の 16 進なら受け付ける)。
 * `0x` の後ろがその形になる入力は「16 進として解釈できない入力」ではないため除く
 * (実測: `0xab` は `x` を含むが 16 進として解釈され、生成器がまれに作ってこのテストが落ちた)
 */
const nonHexTextArbitrary = fc.stringMatching(/^[0-9a-f]*[g-z][0-9a-f]*$/).filter((text) => {
  const normalized = text.startsWith("0x") || text.startsWith("0X") ? text.slice(2) : text;
  return (
    normalized.length === 0 || normalized.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(normalized)
  );
});

/** 形式の指定 (detect は自動判別) */
const formatArbitrary = fc.constantFrom<SecretInputFormat>("detect", "hex", "base64url", "text");

/** 任意の文字列 (制御文字やサロゲートを含み得る) */
const textArbitrary = fc.string({ unit: "binary", maxLength: 32, size: "max" });

/** UTF-8 として妥当な全 Unicode の文字列 */
const graphemeArbitrary = fc.string({ unit: "grapheme", maxLength: 16, size: "max" });

// 16 進の往復。表示用の 16 進 (小文字 2 桁ゼロ埋め) と、接頭辞 / 大文字の表記を
// 含めて同じバイト列へ戻ることを確かめる。trim 後に空になる入力だけは undefined。
test("parseSecretInput: 16 進の入力は元のバイト列へ戻る", () => {
  fc.assert(
    fc.property(bytesArbitrary, hexStyleArbitrary, (bytes, style) => {
      const text = toHexInput(bytes, style);

      // 表示用の 16 進 (bytesToHex) は 1 バイトあたり 2 桁の小文字で、ゼロ埋めされる。
      // 大文字の表記は 16 進として解釈できる別の入力として作る
      const digits = style === "prefix" ? text.slice(2) : text;
      assert.match(digits, style === "upper" ? /^[0-9A-F]*$/ : /^[0-9a-f]*$/);
      assert.equal(digits.length, bytes.length * 2);

      if (bytes.length === 0) {
        // 接頭辞だけの `0x` は trim 後も空にならないため、空文字ではなく不正な 16 進になる
        if (style === "prefix") {
          assert.throws(() => parseSecretInput(text, "hex"), /invalid hex secret/);
          return;
        }
        assert.equal(parseSecretInput(text, "hex"), undefined);
        return;
      }
      const parsed = parseSecretInput(text, "hex");

      assert.equal(parsed?.format, "hex");
      assert.deepEqual(parsed?.secret, bytes);
    }),
  );
});

// base64url の往復。実装は base64url を優先して復号するため、自分が出力した正規形は
// 必ず元のバイト列へ戻る (パディング無し・アルファベットは RFC 4648 Section 5)。
test("parseSecretInput: base64url の入力は元のバイト列へ戻る", () => {
  fc.assert(
    fc.property(bytesArbitrary, (bytes) => {
      const text = C4M.encodeBase64Url(bytes);

      if (bytes.length === 0) {
        assert.equal(parseSecretInput(text, "base64url"), undefined);
        return;
      }
      const parsed = parseSecretInput(text, "base64url");

      assert.equal(parsed?.format, "base64url");
      assert.deepEqual(parsed?.secret, bytes);
    }),
  );
});

// detect の優先順は 16 進 → base64url → テキストである。16 進として解釈できる入力は
// base64url としても復号できることがあるため、優先順が入れ替わるとここで落ちる。
test("parseSecretInput: detect は 16 進として解釈できる入力を最優先で hex にする", () => {
  fc.assert(
    fc.property(
      fc.uint8Array({ minLength: 1, maxLength: 48, size: "max" }),
      hexStyleArbitrary,
      (bytes, style) => {
        const parsed = parseSecretInput(toHexInput(bytes, style), "detect");

        assert.equal(parsed?.format, "hex");
        assert.deepEqual(parsed?.secret, bytes);
      },
    ),
  );
});

// 16 進として解釈できない入力 (16 進のアルファベット外の文字を含む、桁数が奇数) は
// hex にならず、base64url かテキストのどちらかになる。テキストの場合は UTF-8 の
// バイト列になる。
test("parseSecretInput: detect は 16 進として解釈できない入力を base64url かテキストにする", () => {
  const assertNotHex = (text: string): void => {
    const parsed = parseSecretInput(text, "detect");

    assert.isDefined(parsed, `detect が入力を解釈しなかった: ${JSON.stringify(text)}`);
    if (parsed === undefined) {
      return;
    }
    assert.notEqual(parsed.format, "hex");
    assert.include(["base64url", "text"], parsed.format);
    if (parsed.format === "text") {
      assert.deepEqual(parsed.secret, TEXT_ENCODER.encode(text.trim()));
    }
  };

  // 16 進のアルファベットに無い文字を含む入力
  fc.assert(fc.property(nonHexTextArbitrary, assertNotHex));
  // 桁数が奇数 (trim 後) の入力は 16 進のバイト列にならない
  fc.assert(
    fc.property(
      fc.stringMatching(/^[0-9a-f]{1,7}$/).filter((text) => text.length % 2 === 1),
      assertNotHex,
    ),
  );
});

// 任意の入力でも detect は例外を投げず (画面が入力のたびに壊れず)、trim 後に空なら
// undefined、それ以外は 3 種類の形式のどれかに決まる。
test("parseSecretInput: detect は任意の入力で例外を投げず形式が決まる", () => {
  fc.assert(
    fc.property(textArbitrary, (text) => {
      const parsed = parseSecretInput(text, "detect");

      if (text.trim().length === 0) {
        assert.equal(parsed, undefined);
        return;
      }
      assert.isDefined(parsed, `detect が入力を解釈しなかった: ${JSON.stringify(text)}`);
      assert.include(["hex", "base64url", "text"], parsed?.format);
    }),
  );
});

// 形式に text を指定した場合は、trim した文字列の UTF-8 バイト列を返す。
test("parseSecretInput: text を指定すると UTF-8 のバイト列を返す", () => {
  fc.assert(
    fc.property(graphemeArbitrary, (text) => {
      const trimmed = text.trim();
      const parsed = parseSecretInput(text, "text");

      if (trimmed.length === 0) {
        assert.equal(parsed, undefined);
        return;
      }
      assert.equal(parsed?.format, "text");
      assert.deepEqual(parsed?.secret, TEXT_ENCODER.encode(trimmed));
    }),
  );
});

// inspectKeyInput は任意の入力と形式の組み合わせで例外を投げず、結果を 4 種類の値で
// 返す (画面が入力のたびに表示を更新できる)。`{` で始まる入力は JWK として解釈し、
// それ以外は parseSecretInput と同じ規則になる。例外は error の値として返す。
test("inspectKeyInput: 任意の入力と形式で例外を投げず parseSecretInput と一致する", () => {
  fc.assert(
    fc.property(textArbitrary, formatArbitrary, (text, format) => {
      const inspection = inspectKeyInput(text, format);

      assert.include(["empty", "jwk", "secret", "error"], inspection.type);
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        assert.equal(inspection.type, "empty");
        assert.equal(parseSecretInput(trimmed, format), undefined);
        return;
      }
      if (trimmed.startsWith("{")) {
        // JWK として解釈する入力では形式の指定を使わない
        assert.include(["jwk", "error"], inspection.type);
        return;
      }
      if (inspection.type === "secret") {
        const parsed = parseSecretInput(trimmed, format);

        assert.deepEqual(parsed?.secret, inspection.secret);
        assert.equal(parsed?.format, inspection.format);
        return;
      }
      // 解釈できない入力は例外ではなく error の値で返す
      assert.equal(inspection.type, "error");
      assert.throws(() => parseSecretInput(trimmed, format));
    }),
  );
});

/** C4M の鍵から作り、正規の JWK として読み直したもの */
function jwkFromCoseKey(key: C4M.CoseKey): C4M.Jwk {
  return C4M.decodeJwk(C4M.encodeJwk(C4M.coseKeyToJwk(key)));
}

/**
 * EC の JWK
 *
 * 曲線は実装が扱う 3 種類すべて、秘密鍵のメンバー (`d`) の有無は任意にする。
 * 鍵の長さを曲線に合わせないのは、公開鍵化がメンバーの有無だけで決まることを
 * 確かめるため (長さの検証は JWK のデコードの領分)。
 */
const ecJwkArbitrary: fc.Arbitrary<C4M.Jwk> = fc
  .record({
    curve: fc.constantFrom<C4M.EcCurve>("P256", "P384", "P521"),
    x: fc.uint8Array({ minLength: 1, maxLength: 66, size: "max" }),
    y: fc.uint8Array({ minLength: 1, maxLength: 66, size: "max" }),
    privateKey: fc.option(fc.uint8Array({ minLength: 1, maxLength: 66, size: "max" }), {
      nil: undefined,
    }),
  })
  .map(({ curve, x, y, privateKey }) =>
    jwkFromCoseKey(
      privateKey === undefined
        ? C4M.ec2Key(curve, x, y)
        : C4M.ec2KeyWithPrivateKey(curve, x, y, privateKey),
    ),
  );

/** OKP (Ed25519) の JWK */
const okpJwkArbitrary: fc.Arbitrary<C4M.Jwk> = fc
  .record({
    publicKey: fc.uint8Array({ minLength: 1, maxLength: 32, size: "max" }),
    privateKey: fc.option(fc.uint8Array({ minLength: 1, maxLength: 32, size: "max" }), {
      nil: undefined,
    }),
  })
  .map(({ publicKey, privateKey }) =>
    jwkFromCoseKey(
      privateKey === undefined
        ? C4M.ed25519Key(publicKey)
        : C4M.ed25519KeyWithPrivateKey(publicKey, privateKey),
    ),
  );

/** oct (共通鍵) の JWK */
const octJwkArbitrary: fc.Arbitrary<C4M.Jwk> = fc
  .uint8Array({ minLength: 1, maxLength: 48, size: "max" })
  .map((secret) => jwkFromCoseKey(C4M.symmetricKey(secret)));

// 公開鍵の JWK は元の JWK から秘密鍵のメンバー (`d`) だけを除いたものである。
// EC / OKP では残るメンバーが同じで、署名に使える秘密鍵が無くなる。
test("publicJwkOf: EC と OKP の JWK から秘密鍵のメンバーだけを除く", () => {
  fc.assert(
    fc.property(fc.oneof(ecJwkArbitrary, okpJwkArbitrary), (jwk) => {
      if (jwk.kty === "oct") {
        return;
      }
      const publicJwk = publicJwkOf(jwk);

      // 秘密鍵のメンバーを除いた JWK と等しい (他のメンバーは残る)
      assert.deepEqual(publicJwk, { ...jwk, d: undefined });
      // hasPrivateKey は d の有無と一致し、公開鍵化した後は false になる
      assert.equal(hasPrivateKey(jwk), jwk.d !== undefined);
      assert.isFalse(hasPrivateKey(publicJwk));
      // describeJwk の private / public の表示も d の有無と一致し、曲線名を含む
      assert.equal(describeJwk(jwk).includes("private key"), jwk.d !== undefined);
      assert.include(describeJwk(jwk), jwk.crv);
    }),
  );
});

// oct は鍵そのものが共通鍵であり、除く秘密鍵のメンバーが無い。公開鍵化しても値は
// 変わらず、署名に使えるままである (describeJwk も公開鍵として扱わない)。
test("publicJwkOf: oct の JWK は共通鍵のまま変えない", () => {
  fc.assert(
    fc.property(octJwkArbitrary, (jwk) => {
      const publicJwk = publicJwkOf(jwk);

      assert.deepEqual(publicJwk, jwk);
      assert.isTrue(hasPrivateKey(jwk));
      assert.isTrue(hasPrivateKey(publicJwk));
      assert.notInclude(describeJwk(publicJwk), "public key");
    }),
  );
});
