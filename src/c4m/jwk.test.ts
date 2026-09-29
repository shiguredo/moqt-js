/**
 * JWK (RFC 7517) と JWK サムプリント (RFC 7638) のテスト
 */

import { test, assert } from "vite-plus/test";
import {
  type Jwk,
  canonicalJwkJson,
  coseKeyToJwk,
  decodeJwk,
  encodeJwk,
  jwkThumbprintSha256,
  jwkToCoseKey,
} from "./jwk";
import {
  ec2Key,
  ec2KeyWithPrivateKey,
  ed25519Key,
  ed25519KeyWithPrivateKey,
  symmetricKey,
} from "./crypto";
import { WebCrypto } from "./webcrypto";
import { encodeBase64Url } from "./base64url";
import { assertJwkError, decodeHex, encodeHex } from "./testSupport";
import {
  DPOP_VECTORS,
  ES256_PRIVATE_KEY_HEX,
  ES256_PUBLIC_KEY_X_HEX,
  ES256_PUBLIC_KEY_Y_HEX,
} from "./testVectors";

const cryptoImpl = new WebCrypto();

/** 付録 A.4 の dpop_es256_real_binding が使う JWK (draft 原文のまま) */
const DPOP_JWK_JSON =
  '{"crv":"P-256","kty":"EC","x":"YP7UuiVanTHJYet0xjVtaMBJuJI7Yfps5mliLmDyn7Y","y":"eQP-EAi4vJmkGunpVii8ZPLxsgwtfp9Rd6PClNRGIpk"}';

/** 付録 A.1 の ES256 公開鍵を JWK にする */
function es256PublicJwk(): Extract<Jwk, { kty: "EC" }> {
  return {
    kty: "EC",
    crv: "P-256",
    x: encodeBase64Url(decodeHex(ES256_PUBLIC_KEY_X_HEX)),
    y: encodeBase64Url(decodeHex(ES256_PUBLIC_KEY_Y_HEX)),
    d: undefined,
  };
}

/** RFC 8032 Section 7.1 のテストベクタ 1 の Ed25519 公開鍵 */
const ED25519_PUBLIC_KEY_HEX = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

/** RFC 8032 Section 7.1 のテストベクタ 1 の Ed25519 秘密鍵 (種) */
const ED25519_PRIVATE_KEY_HEX = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";

test("付録 A.4 の JWK をデコードし、正規化 JSON がベクタと一致する", () => {
  const jwk = decodeJwk(DPOP_JWK_JSON);
  assert.equal(jwk.kty, "EC");
  assert.equal(canonicalJwkJson(jwk), DPOP_JWK_JSON);
  // 公開鍵の x / y は付録 A.1 の ES256 公開鍵と一致する
  assert.deepEqual(jwkToCoseKey(jwk), es256PublicJwkToCoseKey());
});

/** 付録 A.1 の ES256 公開鍵の CoseKey */
function es256PublicJwkToCoseKey() {
  return ec2Key("P256", decodeHex(ES256_PUBLIC_KEY_X_HEX), decodeHex(ES256_PUBLIC_KEY_Y_HEX));
}

test("JWK サムプリントが付録 A.4 の cnf_jkt と一致する", async () => {
  const vector = DPOP_VECTORS.find((entry) => entry.id === "dpop_es256_real_binding");
  assert.ok(vector !== undefined);
  const thumbprint = await jwkThumbprintSha256(cryptoImpl, decodeJwk(DPOP_JWK_JSON));
  assert.equal(encodeHex(thumbprint), vector.cnfJktHex);
  // 秘密鍵のメンバーがあってもサムプリントは変わらない (RFC 7638 Section 3.2.1)
  const privateJwk: Jwk = {
    ...es256PublicJwk(),
    d: encodeBase64Url(decodeHex(ES256_PRIVATE_KEY_HEX)),
  };
  assert.deepEqual(canonicalJwkJson(privateJwk), DPOP_JWK_JSON);
  assert.equal(encodeHex(await jwkThumbprintSha256(cryptoImpl, privateJwk)), vector.cnfJktHex);
});

test("JWK のエンコードとデコードを往復できる", () => {
  const publicJwk = es256PublicJwk();
  assert.deepEqual(decodeJwk(encodeJwk(publicJwk)), publicJwk);
  const privateJwk: Jwk = {
    ...publicJwk,
    d: encodeBase64Url(decodeHex(ES256_PRIVATE_KEY_HEX)),
  };
  assert.deepEqual(decodeJwk(encodeJwk(privateJwk)), privateJwk);
  // 公開鍵だけのときは d を出力しない
  assert.equal(encodeJwk(publicJwk).includes('"d"'), false);
});

test("秘密鍵付き EC JWK を CoseKey へ変換できる", () => {
  const privateJwk: Jwk = {
    ...es256PublicJwk(),
    d: encodeBase64Url(decodeHex(ES256_PRIVATE_KEY_HEX)),
  };
  const key = jwkToCoseKey(privateJwk);
  assert.deepEqual(
    key,
    ec2KeyWithPrivateKey(
      "P256",
      decodeHex(ES256_PUBLIC_KEY_X_HEX),
      decodeHex(ES256_PUBLIC_KEY_Y_HEX),
      decodeHex(ES256_PRIVATE_KEY_HEX),
    ),
  );
  // CoseKey から JWK へ戻せる
  assert.deepEqual(coseKeyToJwk(key), privateJwk);
});

test("Ed25519 の JWK を往復できる", () => {
  const publicJwk: Extract<Jwk, { kty: "OKP" }> = {
    kty: "OKP",
    crv: "Ed25519",
    x: encodeBase64Url(decodeHex(ED25519_PUBLIC_KEY_HEX)),
    d: undefined,
  };
  assert.deepEqual(jwkToCoseKey(publicJwk), ed25519Key(decodeHex(ED25519_PUBLIC_KEY_HEX)));
  assert.deepEqual(coseKeyToJwk(jwkToCoseKey(publicJwk)), publicJwk);
  assert.equal(canonicalJwkJson(publicJwk), `{"crv":"Ed25519","kty":"OKP","x":"${publicJwk.x}"}`);

  const privateJwk: Jwk = {
    ...publicJwk,
    d: encodeBase64Url(decodeHex(ED25519_PRIVATE_KEY_HEX)),
  };
  assert.deepEqual(
    jwkToCoseKey(privateJwk),
    ed25519KeyWithPrivateKey(decodeHex(ED25519_PUBLIC_KEY_HEX), decodeHex(ED25519_PRIVATE_KEY_HEX)),
  );
  assert.deepEqual(coseKeyToJwk(jwkToCoseKey(privateJwk)), privateJwk);
});

test("oct の JWK を往復できる", () => {
  const jwk: Jwk = { kty: "oct", k: encodeBase64Url(new Uint8Array([1, 2, 3])) };
  assert.deepEqual(jwkToCoseKey(jwk), symmetricKey(new Uint8Array([1, 2, 3])));
  assert.deepEqual(coseKeyToJwk(symmetricKey(new Uint8Array([1, 2, 3]))), jwk);
  assert.equal(canonicalJwkJson(jwk), `{"k":"${jwk.k}","kty":"oct"}`);
});

test("正規化 JSON はパディングを除去する", () => {
  // "Zm9v" はパディング不要だが、"Zg==" は "Zg" に正規化される
  const jwk: Jwk = {
    kty: "oct",
    k: "Zg==",
  };
  assert.equal(canonicalJwkJson(jwk), '{"k":"Zg","kty":"oct"}');
  // パディング付きでも CoseKey へ変換できる
  assert.deepEqual(jwkToCoseKey(jwk), symmetricKey(new TextEncoder().encode("f")));
});

test("不正な JWK を拒否する", () => {
  assertJwkError(() => decodeJwk("not json"), "invalidJson");
  assertJwkError(() => decodeJwk("[1,2,3]"), "unexpectedType");
  assertJwkError(() => decodeJwk('{"crv":"P-256"}'), "unexpectedType");
  assertJwkError(() => decodeJwk('{"kty":"RSA","n":"AQAB","e":"AQAB"}'), "unsupportedKeyType");
  // 曲線と base64url の検証は CoseKey への変換時に行う
  assertJwkError(
    () => jwkToCoseKey(decodeJwk('{"kty":"EC","crv":"secp256k1","x":"AA","y":"AA"}')),
    "unsupportedCurve",
  );
  assertJwkError(
    () => jwkToCoseKey(decodeJwk('{"kty":"EC","crv":"P-256","x":"***","y":"AA"}')),
    "invalidBase64",
  );
  assertJwkError(
    () => jwkToCoseKey(decodeJwk('{"kty":"OKP","crv":"X25519","x":"AA"}')),
    "unsupportedCurve",
  );
});

test("型が文字列でない JWK のメンバーを拒否する", () => {
  assertJwkError(() => decodeJwk('{"kty":1}'), "unexpectedType");
  assertJwkError(() => decodeJwk('{"kty":"EC","crv":"P-256","x":1,"y":"AA"}'), "unexpectedType");
  assertJwkError(
    () => decodeJwk('{"kty":"EC","crv":"P-256","x":"AA","y":"AA","d":1}'),
    "unexpectedType",
  );
});
