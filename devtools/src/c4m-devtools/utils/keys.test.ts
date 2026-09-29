/**
 * C4M DevTools の鍵生成と鍵入力の解釈のテスト
 */

import { test, assert } from "vite-plus/test";
import { C4M } from "moqt-js";
import {
  bytesToHex,
  describeJwk,
  generateKey,
  hasPrivateKey,
  inspectKeyInput,
  parseJwkInput,
  parseSecretInput,
  publicJwkOf,
} from "./keys";

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
  assert.deepEqual(parseSecretInput("000102", "detect"), {
    secret: new Uint8Array([0, 1, 2]),
    format: "hex",
  });
  assert.deepEqual(parseSecretInput("0x00ff", "hex"), {
    secret: new Uint8Array([0, 255]),
    format: "hex",
  });
  // base64url
  assert.deepEqual(parseSecretInput("Zm9v", "detect"), {
    secret: TEXT_ENCODER.encode("foo"),
    format: "base64url",
  });
  // テキスト
  assert.deepEqual(parseSecretInput("secret!", "detect"), {
    secret: TEXT_ENCODER.encode("secret!"),
    format: "text",
  });
  // detect は base64url として読める文字列を base64url として扱う
  assert.deepEqual(parseSecretInput("password", "detect"), {
    secret: C4M.tryDecodeBase64OrUrl("password"),
    format: "base64url",
  });
  // 明示した形式の不正はエラー
  assert.throws(() => parseSecretInput("abc", "hex"), /invalid hex secret/);
  assert.throws(() => parseSecretInput("!!!", "base64url"), /invalid base64url secret/);
  // 空は undefined
  assert.equal(parseSecretInput("", "detect"), undefined);
  assert.equal(parseSecretInput("   ", "detect"), undefined);
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

test("鍵入力の解釈結果を返す", () => {
  // 空
  assert.deepEqual(inspectKeyInput("", "detect"), { type: "empty" });
  // secret は形式とバイト数を返す
  assert.deepEqual(inspectKeyInput("000102", "detect"), {
    type: "secret",
    secret: new Uint8Array([0, 1, 2]),
    format: "hex",
  });
  assert.deepEqual(inspectKeyInput("secret!", "detect"), {
    type: "secret",
    secret: TEXT_ENCODER.encode("secret!"),
    format: "text",
  });
  // 形式を明示した不正はエラーとして返す
  const error = inspectKeyInput("abc", "hex");
  assert.equal(error.type, "error");
  if (error.type === "error") {
    assert.match(error.message, /invalid hex secret/);
  }
  // 不正な JWK もエラーとして返す
  assert.equal(inspectKeyInput("{not json}", "detect").type, "error");
});

test("JWK の解釈結果は公開鍵 / 秘密鍵を区別する", () => {
  const publicInspection = inspectKeyInput(
    '{"kty":"EC","crv":"P-256","x":"AA","y":"AA"}',
    "detect",
  );
  assert.equal(publicInspection.type, "jwk");
  if (publicInspection.type === "jwk") {
    assert.equal(publicInspection.hasPrivateKey, false);
    assert.equal(describeJwk(publicInspection.jwk), "EC P-256 (public key)");
  }
  const privateInspection = inspectKeyInput(
    '{"kty":"EC","crv":"P-256","x":"AA","y":"AA","d":"AA"}',
    "detect",
  );
  assert.equal(privateInspection.type, "jwk");
  if (privateInspection.type === "jwk") {
    assert.equal(privateInspection.hasPrivateKey, true);
    assert.equal(describeJwk(privateInspection.jwk), "EC P-256 (private key)");
  }
  // oct は常に署名に使える
  assert.equal(hasPrivateKey(C4M.decodeJwk('{"kty":"oct","k":"AQID"}')), true);
  assert.equal(describeJwk(C4M.decodeJwk('{"kty":"oct","k":"AQID"}')), "oct (symmetric secret)");
  assert.equal(
    describeJwk(C4M.decodeJwk('{"kty":"OKP","crv":"Ed25519","x":"AA"}')),
    "OKP Ed25519 (public key)",
  );
});
