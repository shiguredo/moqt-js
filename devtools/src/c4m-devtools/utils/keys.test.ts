/**
 * C4M DevTools の鍵生成と鍵入力の解釈のテスト
 */

import { test, assert } from "vite-plus/test";
import { C4M } from "moqt-js";
import { bytesToHex, generateKey, parseJwkInput, parseSecretInput, publicJwkOf } from "./keys";

const cryptoImpl = new C4M.WebCrypto();
const TEXT_ENCODER = new TextEncoder();

test("ES256 の鍵ペアを生成してトークンを発行 / 検証できる", async () => {
  const generated = await generateKey("Es256");
  assert.equal(generated.kind, "asymmetric");
  if (generated.kind !== "asymmetric") {
    return;
  }
  assert.equal(generated.algorithm, "Es256");
  // 秘密鍵の JWK にだけ d があり、公開鍵の JWK には無い
  assert.equal(generated.publicJwk.kty, "EC");
  assert.equal(generated.privateJwk.kty, "EC");
  if (generated.publicJwk.kty === "EC" && generated.privateJwk.kty === "EC") {
    assert.equal(generated.publicJwk.d, undefined);
    assert.notEqual(generated.privateJwk.d, undefined);
  }

  const claims = C4M.createCatClaims();
  claims.issuer = "https://auth.example.com";
  const tokenText = await new C4M.CatTokenBuilder({ claims }).buildCompact(
    cryptoImpl,
    generated.privateCoseKey,
  );
  const token = C4M.CatToken.decode(TEXT_ENCODER.encode(tokenText));
  await token.verify(cryptoImpl, generated.publicCoseKey);
  assert.equal(token.header().algorithm, "Es256");
});

test("EdDSA の鍵ペアを生成してトークンを発行 / 検証できる", async () => {
  const generated = await generateKey("EdDsa");
  assert.equal(generated.kind, "asymmetric");
  if (generated.kind !== "asymmetric") {
    return;
  }
  const claims = C4M.createCatClaims();
  claims.issuer = "https://auth.example.com";
  const tokenBytes = await new C4M.CatTokenBuilder({ claims }).buildCose(
    cryptoImpl,
    generated.privateCoseKey,
  );
  const token = C4M.CatToken.decode(tokenBytes);
  await token.verify(cryptoImpl, generated.publicCoseKey);
  assert.equal(token.header().algorithm, "EdDsa");
});

test("HMAC の対称鍵を生成できる", async () => {
  const generated = await generateKey("HmacSha256");
  assert.equal(generated.kind, "symmetric");
  if (generated.kind !== "symmetric") {
    return;
  }
  assert.equal(generated.secret.length, 32);
  assert.notEqual(bytesToHex(generated.secret), bytesToHex(new Uint8Array(32)));
});

test("対称鍵の入力を解釈できる", () => {
  // 16 進 (0x 付きも可)
  assert.deepEqual(parseSecretInput("000102", "auto"), {
    secret: new Uint8Array([0, 1, 2]),
    format: "hex",
  });
  assert.deepEqual(parseSecretInput("0x00ff", "hex"), {
    secret: new Uint8Array([0, 255]),
    format: "hex",
  });
  // base64url
  assert.deepEqual(parseSecretInput("Zm9v", "auto"), {
    secret: TEXT_ENCODER.encode("foo"),
    format: "base64url",
  });
  // テキスト
  assert.deepEqual(parseSecretInput("secret!", "auto"), {
    secret: TEXT_ENCODER.encode("secret!"),
    format: "text",
  });
  // 明示した形式の不正はエラー
  assert.throws(() => parseSecretInput("abc", "hex"), /invalid hex secret/);
  assert.throws(() => parseSecretInput("!!!", "base64url"), /invalid base64url secret/);
  // 空は undefined
  assert.equal(parseSecretInput("", "auto"), undefined);
  assert.equal(parseSecretInput("   ", "auto"), undefined);
});

test("JWK の入力を解釈できる", () => {
  const generatedJwk = '{"kty":"oct","k":"AQID"}';
  const parsed = parseJwkInput(generatedJwk);
  assert.equal(parsed.jwk.kty, "oct");
  assert.deepEqual(parsed.coseKey, C4M.symmetricKey(new Uint8Array([1, 2, 3])));
  // 不正な JWK はエラー
  assert.throws(() => parseJwkInput("not json"), /invalid JWK JSON/);
});

test("公開鍵の JWK から秘密鍵のメンバーを除ける", () => {
  const privateJwk = C4M.decodeJwk('{"kty":"EC","crv":"P-256","x":"AA","y":"AA","d":"AA"}');
  assert.deepEqual(publicJwkOf(privateJwk), {
    kty: "EC",
    crv: "P-256",
    x: "AA",
    y: "AA",
    d: undefined,
  });
});
