/**
 * Web Crypto API を使う署名 / 検証実装のテスト
 *
 * 成功系の大半は cat.test.ts のベクタ検証で覆う。ここではダイジェストと、
 * 鍵の種別・長さ・署名長のエラーパスを固定する。
 */

import { test, assert } from "vite-plus/test";
import {
  CryptoError,
  ec2Key,
  ec2KeyWithPrivateKey,
  ed25519Key,
  ed25519KeyWithPrivateKey,
  symmetricKey,
} from "./crypto";
import { WebCrypto } from "./webcrypto";
import { captureRejectedError, decodeHex, encodeHex } from "./testSupport";

const cryptoImpl = new WebCrypto();

/** 非同期処理の CryptoError を捕捉する */
async function captureCryptoError(run: () => Promise<unknown>): Promise<CryptoError> {
  const error = await captureRejectedError(run);
  assert.ok(error instanceof CryptoError, `CryptoError を期待したが ${String(error)} が送出された`);
  return error;
}

test("SHA-256 / SHA-384 / SHA-512 のダイジェストを計算できる", async () => {
  const message = new TextEncoder().encode("abc");
  assert.equal(
    encodeHex(await cryptoImpl.digest("Sha256", message)),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    encodeHex(await cryptoImpl.digest("Sha384", message)),
    "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7",
  );
  assert.equal(
    encodeHex(await cryptoImpl.digest("Sha512", message)),
    "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
  );
});

test("HMAC-SHA256 / 384 / 512 の署名と検証を往復できる", async () => {
  const message = new TextEncoder().encode("message");
  const cases: Array<["HmacSha256" | "HmacSha384" | "HmacSha512", number]> = [
    ["HmacSha256", 32],
    ["HmacSha384", 48],
    ["HmacSha512", 64],
  ];
  for (const [algorithm, keyLength] of cases) {
    const key = symmetricKey(new Uint8Array(keyLength).fill(0x01));
    const signature = await cryptoImpl.sign(algorithm, key, message);
    assert.equal(signature.length, keyLength);
    await cryptoImpl.verify(algorithm, key, message, signature);
  }
});

test("HMAC は改ざんと誤った鍵を拒否する", async () => {
  const key = symmetricKey(new Uint8Array(32).fill(0x01));
  const otherKey = symmetricKey(new Uint8Array(32).fill(0x02));
  const message = new TextEncoder().encode("message");
  const signature = await cryptoImpl.sign("HmacSha256", key, message);
  const wrongMessage = new TextEncoder().encode("messagE");
  const tampered = await captureCryptoError(() =>
    cryptoImpl.verify("HmacSha256", key, wrongMessage, signature),
  );
  assert.equal(tampered.code, "signatureVerificationFailed");
  const wrongKey = await captureCryptoError(() =>
    cryptoImpl.verify("HmacSha256", otherKey, message, signature),
  );
  assert.equal(wrongKey.code, "signatureVerificationFailed");
});

test("Ed25519 は RFC 8032 Section 7.1 のテストベクタ 1 と一致する署名を生成する", async () => {
  const publicKeyBytes = decodeHex(
    "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  );
  const privateKeyBytes = decodeHex(
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
  );
  // メッセージが空のときの署名 (RFC 8032 Section 7.1)
  const expectedSignature = decodeHex(
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  );
  const privateKey = ed25519KeyWithPrivateKey(publicKeyBytes, privateKeyBytes);
  const signature = await cryptoImpl.sign("EdDsa", privateKey, new Uint8Array(0));
  assert.deepEqual(signature, expectedSignature);
  await cryptoImpl.verify("EdDsa", ed25519Key(publicKeyBytes), new Uint8Array(0), signature);
});

test("鍵の種別とアルゴリズムの不一致を拒否する", async () => {
  const message = new TextEncoder().encode("message");
  const symmetric = symmetricKey(new Uint8Array(32).fill(0x01));
  const ecPublic = ec2Key("P256", new Uint8Array(32), new Uint8Array(32));
  // 対称鍵で ECDSA は署名できない
  const symmetricWithEcdsa = await captureCryptoError(() =>
    cryptoImpl.sign("Es256", symmetric, message),
  );
  assert.equal(symmetricWithEcdsa.code, "unsupportedKey");
  // EC2 鍵で HMAC は署名できない
  const ecWithHmac = await captureCryptoError(() =>
    cryptoImpl.sign("HmacSha256", ecPublic, message),
  );
  assert.equal(ecWithHmac.code, "unsupportedKey");
  // 曲線の不一致
  const p256Private = ec2KeyWithPrivateKey(
    "P256",
    new Uint8Array(32).fill(0x01),
    new Uint8Array(32).fill(0x02),
    new Uint8Array(32).fill(0x03),
  );
  const curveMismatch = await captureCryptoError(() =>
    cryptoImpl.sign("Es384", p256Private, message),
  );
  assert.equal(curveMismatch.code, "unsupportedKey");
});

test("秘密鍵の無い署名を拒否する", async () => {
  const message = new TextEncoder().encode("message");
  const ecPublic = ec2Key("P256", new Uint8Array(32), new Uint8Array(32));
  const missingEcPrivateKey = await captureCryptoError(() =>
    cryptoImpl.sign("Es256", ecPublic, message),
  );
  assert.equal(missingEcPrivateKey.code, "missingPrivateKey");
  const ed25519Public = ed25519Key(new Uint8Array(32));
  const missingEd25519PrivateKey = await captureCryptoError(() =>
    cryptoImpl.sign("EdDsa", ed25519Public, message),
  );
  assert.equal(missingEd25519PrivateKey.code, "missingPrivateKey");
});

test("不正な鍵の長さを拒否する", async () => {
  const message = new TextEncoder().encode("message");
  // 空の対称鍵
  const emptySymmetricKey = await captureCryptoError(() =>
    cryptoImpl.sign("HmacSha256", symmetricKey(new Uint8Array(0)), message),
  );
  assert.equal(emptySymmetricKey.code, "invalidKey");
  // 座標長が足りない EC2 鍵
  const shortEcKey = await captureCryptoError(() =>
    cryptoImpl.sign("Es256", ec2Key("P256", new Uint8Array(31), new Uint8Array(32)), message),
  );
  assert.equal(shortEcKey.code, "invalidKey");
  // 公開鍵が 32 バイトでない Ed25519 鍵
  const shortEd25519Key = await captureCryptoError(() =>
    cryptoImpl.sign(
      "EdDsa",
      ed25519KeyWithPrivateKey(new Uint8Array(31), new Uint8Array(32)),
      message,
    ),
  );
  assert.equal(shortEd25519Key.code, "invalidKey");
});

test("署名長がアルゴリズムと一致しない場合は拒否する", async () => {
  const message = new TextEncoder().encode("message");
  const ecPublic = ec2Key("P256", new Uint8Array(32), new Uint8Array(32));
  const shortEcSignature = await captureCryptoError(() =>
    cryptoImpl.verify("Es256", ecPublic, message, new Uint8Array(63)),
  );
  assert.equal(shortEcSignature.code, "invalidSignatureLength");
  const shortEd25519Signature = await captureCryptoError(() =>
    cryptoImpl.verify("EdDsa", ed25519Key(new Uint8Array(32)), message, new Uint8Array(63)),
  );
  assert.equal(shortEd25519Signature.code, "invalidSignatureLength");
});
