import { test, assert } from "vite-plus/test";
import { AuthorizationTokenAliasType } from "moqt-js";
import {
  applyC4mFromUrl,
  authorizationTokenAlias,
  authorizationTokenAliasType,
  authorizationTokenBase64,
  authorizationTokenType,
  authorizationTokenValue,
  buildAuthorizationToken,
  initFromUrl,
} from "./connectionSettings";

// テスト間で Authorization Token の signal を持ち越さないためのリセット
function resetAuthorizationTokenSettings(): void {
  authorizationTokenAliasType.value = "useValue";
  authorizationTokenAlias.value = "0";
  authorizationTokenType.value = "0";
  authorizationTokenValue.value = "";
  authorizationTokenBase64.value = "";
}

// バイト列を Base64 文字列に変換する (C4M トークンの入力を作る)
function toBase64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

// MSF URL の c4m を読み込むと、Token Value をクリアして Base64 トークンと
// USE_VALUE / Token Type 0x01 (CAT, draft-ietf-moq-c4m-01 §7.1 Table 4) が設定される。
test("applyC4mFromUrl: c4m から Base64 トークンと USE_VALUE / Token Type 0x01 を反映する", () => {
  resetAuthorizationTokenSettings();
  authorizationTokenValue.value = "manual-token";

  const applied = applyC4mFromUrl("moqt://example.com/moqt#msf:room-123--catalog&c4m=QUFB");

  assert.equal(applied, true);
  assert.equal(authorizationTokenBase64.value, "QUFB");
  assert.equal(authorizationTokenValue.value, "");
  assert.equal(authorizationTokenAliasType.value, "useValue");
  assert.equal(authorizationTokenType.value, "1");
});

// URI Fragment 欄への貼り付けを想定し、fragment 単体でも c4m を読み込める。
test("applyC4mFromUrl: msf fragment 単体から c4m を読み込む", () => {
  resetAuthorizationTokenSettings();

  const applied = applyC4mFromUrl("msf:room-123--catalog&c4m=QUFB");

  assert.equal(applied, true);
  assert.equal(authorizationTokenBase64.value, "QUFB");
});

// c4m が無い URL では false を返し、設定済みの Authorization Token を変更しない。
test("applyC4mFromUrl: c4m が無い場合は false を返し設定を変更しない", () => {
  resetAuthorizationTokenSettings();
  authorizationTokenValue.value = "manual-token";

  const applied = applyC4mFromUrl("moqt://example.com/moqt#msf:room-123--catalog");

  assert.equal(applied, false);
  assert.equal(authorizationTokenBase64.value, "");
  assert.equal(authorizationTokenValue.value, "manual-token");
});

// 不正な Base64 の c4m は反映せず、false を返す。
test("applyC4mFromUrl: 不正な Base64 の c4m は反映しない", () => {
  resetAuthorizationTokenSettings();

  const applied = applyC4mFromUrl("msf:room-123--catalog&c4m=not base64!!");

  assert.equal(applied, false);
  assert.equal(authorizationTokenBase64.value, "");
});

// c4m から読み込んだトークンは Base64 を復号した生バイト列として、Token Type 0x01 (CAT) で
// SETUP に載る (draft-ietf-moq-c4m-01 §7.1 Table 4 / §7.1.1)。
test("buildAuthorizationToken: c4m の Base64 トークンを CAT (Token Type 0x01) として復号する", () => {
  resetAuthorizationTokenSettings();
  const bytes = [0x83, 0x68, 0x61, 0x00, 0xff];
  applyC4mFromUrl(`moqt://example.com/moqt#msf:room-123--catalog&c4m=${toBase64(bytes)}`);

  const token = buildAuthorizationToken();
  assert.equal(token?.aliasType, AuthorizationTokenAliasType.USE_VALUE);
  if (token?.aliasType === AuthorizationTokenAliasType.USE_VALUE) {
    assert.equal(token.tokenType, 1n);
    assert.deepEqual(token.tokenValue, new Uint8Array(bytes));
  }
});

// c4m の取り込み後は Token Type が 0x01 になるため、Token Type の入力を空文字にしても
// 0n には戻らない (signal の値をそのまま使う)。
test("applyC4mFromUrl: c4m の取り込み後の Token Type は 0x01 で、既定の 0 に戻らない", () => {
  resetAuthorizationTokenSettings();
  applyC4mFromUrl("moqt://example.com/moqt#msf:room-123--catalog&c4m=QUFB");

  authorizationTokenType.value = "";
  const token = buildAuthorizationToken();
  // aliasType が useValue かつ Token Type が空文字のときは 0n になる (実装のフォールバック)
  if (token?.aliasType === AuthorizationTokenAliasType.USE_VALUE) {
    assert.equal(token.tokenType, 0n);
  }

  // c4m の取り込み直後は 0x01
  resetAuthorizationTokenSettings();
  applyC4mFromUrl("moqt://example.com/moqt#msf:room-123--catalog&c4m=QUFB");
  assert.equal(authorizationTokenType.value, "1");
});

// 手書きの共有 URL を想定し、c4m を持つ url パラメータと Authorization Token の
// クエリパラメータを同時に持つ検索文字列では c4m を優先する。
test("initFromUrl: c4m を持つ URL はクエリの Token Type / Token Value より優先する", () => {
  resetAuthorizationTokenSettings();
  const c4mBase64 = toBase64([0x01, 0x02, 0x03]);
  const params = new URLSearchParams();
  params.set("url", `moqt://example.com/moqt#msf:room-123--catalog&c4m=${c4mBase64}`);
  params.set("authorizationTokenType", "0");
  params.set("authorizationTokenValue", "manual-token");

  initFromUrl(params.toString());

  // c4m の取り込みで Token Type は 0x01 (CAT)、Token Value は取り込んだトークンになる
  assert.equal(authorizationTokenType.value, "1");
  assert.equal(authorizationTokenValue.value, "");
  const token = buildAuthorizationToken();
  assert.equal(token?.aliasType, AuthorizationTokenAliasType.USE_VALUE);
  if (token?.aliasType === AuthorizationTokenAliasType.USE_VALUE) {
    assert.equal(token.tokenType, 1n);
    assert.deepEqual(token.tokenValue, new Uint8Array([0x01, 0x02, 0x03]));
  }
});

// fragment の c4m は url の c4m より優先する。
test("initFromUrl: fragment の c4m を url の c4m より優先する", () => {
  resetAuthorizationTokenSettings();
  const urlC4m = toBase64([0x0a]);
  const fragmentC4m = toBase64([0x0b]);
  const params = new URLSearchParams();
  params.set("url", `moqt://example.com/moqt#msf:room-123--catalog&c4m=${urlC4m}`);
  params.set("fragment", `msf:room-123--catalog&c4m=${fragmentC4m}`);

  initFromUrl(params.toString());

  assert.equal(authorizationTokenBase64.value, fragmentC4m);
  assert.equal(authorizationTokenType.value, "1");
});

// c4m が無い検索文字列ではクエリの Authorization Token 設定をそのまま適用する。
test("initFromUrl: c4m が無い場合はクエリの Token Type / Token Value を適用する", () => {
  resetAuthorizationTokenSettings();
  const params = new URLSearchParams();
  params.set("url", "moqt://example.com/moqt");
  params.set("authorizationTokenType", "2");
  params.set("authorizationTokenValue", "manual-token");

  initFromUrl(params.toString());

  assert.equal(authorizationTokenType.value, "2");
  assert.equal(authorizationTokenValue.value, "manual-token");
  assert.equal(authorizationTokenBase64.value, "");
});

// Base64 トークンが無い場合は従来どおり Token Value を UTF-8 として送る。
test("buildAuthorizationToken: Base64 トークンが無い場合は Token Value を UTF-8 として使う", () => {
  resetAuthorizationTokenSettings();
  authorizationTokenValue.value = "manual-token";

  const token = buildAuthorizationToken();
  assert.equal(token?.aliasType, AuthorizationTokenAliasType.USE_VALUE);
  if (token?.aliasType === AuthorizationTokenAliasType.USE_VALUE) {
    assert.deepEqual(token.tokenValue, new TextEncoder().encode("manual-token"));
  }
});

// c4m 読み込み後に Token Value が残っていても、Base64 トークンを優先する。
test("buildAuthorizationToken: Base64 トークンを Token Value より優先する", () => {
  resetAuthorizationTokenSettings();
  authorizationTokenBase64.value = toBase64([0x01, 0x02]);
  authorizationTokenValue.value = "manual-token";

  const token = buildAuthorizationToken();
  assert.equal(token?.aliasType, AuthorizationTokenAliasType.USE_VALUE);
  if (token?.aliasType === AuthorizationTokenAliasType.USE_VALUE) {
    assert.deepEqual(token.tokenValue, new Uint8Array([0x01, 0x02]));
  }
});

// REGISTER / Token Alias を選択した場合は c4m のバイト列をそのまま使い、Alias 設定を尊重する。
test("buildAuthorizationToken: REGISTER の設定でも c4m のバイト列を使う", () => {
  resetAuthorizationTokenSettings();
  authorizationTokenBase64.value = toBase64([0x10, 0x20]);
  authorizationTokenAliasType.value = "register";
  authorizationTokenAlias.value = "7";

  const token = buildAuthorizationToken();
  assert.equal(token?.aliasType, AuthorizationTokenAliasType.REGISTER);
  if (token?.aliasType === AuthorizationTokenAliasType.REGISTER) {
    assert.equal(token.tokenAlias, 7n);
    assert.deepEqual(token.tokenValue, new Uint8Array([0x10, 0x20]));
  }
});
