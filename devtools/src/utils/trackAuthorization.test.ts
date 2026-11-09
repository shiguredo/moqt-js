import { test, assert } from "vite-plus/test";
import { AuthorizationTokenAliasType, type AuthorizationToken } from "moqt-js";
import { publishAuthorizationTokenOptions } from "./trackAuthorization";

// テストで使う SETUP のトークン (draft-ietf-moq-transport-23 §8.9 の USE_VALUE)
const SETUP_TOKEN: AuthorizationToken = {
  aliasType: AuthorizationTokenAliasType.USE_VALUE,
  tokenType: 1n,
  tokenValue: new Uint8Array([1, 2, 3]),
};

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
