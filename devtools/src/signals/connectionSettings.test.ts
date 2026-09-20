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

// MSF URL の c4m を読み込むと、Token Value をクリアして Base64 トークンと USE_VALUE / Token Type 0 が設定される。
test("applyC4mFromUrl: c4m から Base64 トークンと USE_VALUE 設定を反映する", () => {
  resetAuthorizationTokenSettings();
  authorizationTokenValue.value = "manual-token";

  const applied = applyC4mFromUrl("moqt://example.com/moqt#msf:room-123--catalog&c4m=QUFB");

  assert.equal(applied, true);
  assert.equal(authorizationTokenBase64.value, "QUFB");
  assert.equal(authorizationTokenValue.value, "");
  assert.equal(authorizationTokenAliasType.value, "useValue");
  assert.equal(authorizationTokenType.value, "0");
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

// c4m から読み込んだトークンは Base64 を復号した生バイト列として SETUP に載る。
test("buildAuthorizationToken: c4m の Base64 トークンを生バイト列に復号する", () => {
  resetAuthorizationTokenSettings();
  authorizationTokenBase64.value = toBase64([0x83, 0x68, 0x61, 0x00, 0xff]);

  const token = buildAuthorizationToken();
  assert.equal(token?.aliasType, AuthorizationTokenAliasType.USE_VALUE);
  if (token?.aliasType === AuthorizationTokenAliasType.USE_VALUE) {
    assert.equal(token.tokenType, 0n);
    assert.deepEqual(token.tokenValue, new Uint8Array([0x83, 0x68, 0x61, 0x00, 0xff]));
  }
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
