/**
 * c4m のテスト専用ヘルパー
 *
 * devtools のテストで c4m の URL を組み立てるときに、moqt クレームを持つ実際の CAT を
 * 発行する。テストファイルの間で共有する。テストのファイル名 (`*.test.ts`) に一致しない
 * ためテストとして収集されず、devtools の出荷コードからも参照しない。
 *
 * トークンの発行にはブラウザと同じ Web Crypto API を使う (モックやスタブを使わない)。
 */

import { C4M } from "moqt-js";

const cryptoImpl = new C4M.WebCrypto();
const HMAC_KEY = C4M.symmetricKey(new Uint8Array(32).fill(0x0b));

/**
 * moqt クレームを持つ CAT を発行して base64url で返す
 *
 * URL に載る表現に合わせて base64url (パディング省略) にする。
 */
export async function buildCat(scopes: readonly C4M.MoqtScope[]): Promise<string> {
  const claims = C4M.createCatClaims();
  claims.moqt = { scopes: [...scopes] };
  return buildCatWithClaims(claims);
}

/**
 * 指定したクレームを持つ CAT を発行して base64url で返す
 */
export async function buildCatWithClaims(claims: C4M.CatClaims): Promise<string> {
  const tokenBytes = await new C4M.CatTokenBuilder({ claims }).buildCose(cryptoImpl, HMAC_KEY);
  return C4M.encodeBase64Url(tokenBytes);
}

/**
 * exact な track name のスコープを持つ CAT を発行して base64url で返す
 *
 * namespace は `15551` / `spam` に固定する。
 */
export async function buildCatWithTrackNames(trackNames: readonly string[]): Promise<string> {
  const encoder = new TextEncoder();
  const scopes = trackNames.map((trackName) => {
    const scope = C4M.createMoqtScope(["Subscribe", "Publish"]);
    scope.namespace.push(C4M.namespaceMatchValue(C4M.exactMatch(encoder.encode("15551"))));
    scope.namespace.push(C4M.namespaceMatchValue(C4M.exactMatch(encoder.encode("spam"))));
    scope.namespace.push(C4M.namespaceMatchEnd());
    scope.track = C4M.exactMatch(encoder.encode(trackName));
    return scope;
  });
  return buildCat(scopes);
}

/**
 * moqt クレームを持たない (iss だけの) CAT を発行して base64url で返す
 *
 * track name の取り出しが moqt クレーム頼みであることを確かめるテストの入力。
 */
export async function buildCatWithoutMoqtClaim(): Promise<string> {
  const tokenBytes = await new C4M.CatTokenBuilder()
    .issuer("https://auth.example.com")
    .buildCose(cryptoImpl, HMAC_KEY);
  return C4M.encodeBase64Url(tokenBytes);
}
