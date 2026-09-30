import { test, assert } from "vite-plus/test";
import { AuthorizationTokenAliasType, type AuthorizationToken, type CatalogTrack } from "moqt-js";
import {
  publishAuthorizationTokenOptions,
  subscribeAuthorizationTokenOptions,
} from "./trackAuthorization";

// テストで使う SETUP のトークン (draft-ietf-moq-transport-21 §8.9 の USE_VALUE)
const SETUP_TOKEN: AuthorizationToken = {
  aliasType: AuthorizationTokenAliasType.USE_VALUE,
  tokenType: 1n,
  tokenValue: new Uint8Array([1, 2, 3]),
};

// draft-ietf-moq-msf-01 §5.2.42 / §11.4.3: authInfo を持つ track の SUBSCRIBE には、
// SETUP に載せたトークンをそのまま付与する
test("subscribeAuthorizationTokenOptions: authInfo を持つ track には SETUP のトークンを返す", () => {
  const track: CatalogTrack = {
    name: "video",
    packaging: "loc",
    isLive: true,
    authInfo: { cat: {} },
  };

  assert.strictEqual(
    subscribeAuthorizationTokenOptions(track, SETUP_TOKEN).authorizationToken,
    SETUP_TOKEN,
  );
});

// authInfo が無い track は認可が不要なため付与しない (§5.2.42 の authInfo がシグナル)
test("subscribeAuthorizationTokenOptions: authInfo が無い track には付与しない", () => {
  const track: CatalogTrack = {
    name: "video",
    packaging: "loc",
    isLive: true,
  };

  assert.isUndefined(subscribeAuthorizationTokenOptions(track, SETUP_TOKEN).authorizationToken);
});

// 空の authInfo は「認可不要」として扱う (catalog の authInfo: {} と同じ規則)
test("subscribeAuthorizationTokenOptions: 空の authInfo には付与しない", () => {
  const track: CatalogTrack = {
    name: "video",
    packaging: "loc",
    isLive: true,
    authInfo: {},
  };

  assert.isUndefined(subscribeAuthorizationTokenOptions(track, SETUP_TOKEN).authorizationToken);
});

// SETUP にトークンを送っていない場合は、authInfo があっても付与するトークンが無い
test("subscribeAuthorizationTokenOptions: SETUP にトークンが無ければ付与しない", () => {
  const track: CatalogTrack = {
    name: "video",
    packaging: "loc",
    isLive: true,
    authInfo: { cat: {} },
  };

  assert.isUndefined(subscribeAuthorizationTokenOptions(track, undefined).authorizationToken);
});

// catalog に track が見つからない場合も付与しない (authInfo を確認できないため)
test("subscribeAuthorizationTokenOptions: track が無ければ付与しない", () => {
  assert.isUndefined(subscribeAuthorizationTokenOptions(undefined, SETUP_TOKEN).authorizationToken);
});

// draft-ietf-moq-msf-01 §11.4.3: publisher は PUBLISH / PUBLISH_NAMESPACE にトークンを
// MUST 付与する。SETUP に載せたトークンをそのまま使う
test("publishAuthorizationTokenOptions: SETUP のトークンを PUBLISH へ渡す", () => {
  assert.strictEqual(publishAuthorizationTokenOptions(SETUP_TOKEN).authorizationToken, SETUP_TOKEN);
});

// SETUP にトークンを送っていない場合は、PUBLISH のオプションにフィールドを載せない
test("publishAuthorizationTokenOptions: SETUP にトークンが無ければ空のオプションを返す", () => {
  const options = publishAuthorizationTokenOptions(undefined);

  assert.isFalse("authorizationToken" in options);
  assert.deepEqual(options, {});
});
