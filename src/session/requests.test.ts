/**
 * src/session/requests.ts のデバッグログ用ヘルパのテスト
 */

import { test, assert } from "vite-plus/test";
import { AuthorizationTokenAliasType } from "../message/authorizationToken";
import {
  requestsDescribeLocationFilter,
  requestsTokenForRequestUpdate,
  requestsTokenUnlessDelete,
} from "./requests";

/**
 * draft-ietf-moq-transport-22 §9.20.9 Table 6:
 * Location Filter Type ごとの表現をデバッグログ用の文字列に要約する。
 * 0x00 (None) は reset、0x05 (Next Object) はフィールドを持たないため種別名だけ、
 * それ以外は Type に続くフィールドを列挙する。
 */
test("requestsDescribeLocationFilter: Location Filter Type ごとに要約する", () => {
  assert.isUndefined(requestsDescribeLocationFilter(undefined));
  assert.equal(requestsDescribeLocationFilter({ reset: true }), "reset");
  assert.equal(requestsDescribeLocationFilter({ nextObject: true }), "nextObject");
  assert.equal(requestsDescribeLocationFilter({ startGroup: 3n }), "startGroup=3");
  assert.equal(
    requestsDescribeLocationFilter({ startGroup: 1n, startObject: 2n }),
    "startGroup=1, startObject=2",
  );
  assert.equal(
    requestsDescribeLocationFilter({ startGroup: 1n, startObject: 2n, endGroupDelta: 3n }),
    "startGroup=1, startObject=2, endGroupDelta=3",
  );
  assert.equal(
    requestsDescribeLocationFilter({
      startGroup: 1n,
      startObject: 2n,
      endGroupDelta: 3n,
      endObject: 4n,
    }),
    "startGroup=1, startObject=2, endGroupDelta=3, endObject=4",
  );
});

/**
 * draft-ietf-moq-transport-22 §8.9:
 * DELETE (Alias Type 0x00) は Alias の退役を指示するもので、後続の制御メッセージで
 * 繰り返すと UNKNOWN_AUTH_TOKEN_ALIAS と解され得る。購読状態に保持して
 * REQUEST_UPDATE へ引き継ぐ対象からは外す。
 */
test("requestsTokenUnlessDelete: DELETE のトークンは引き継がない", () => {
  const register = {
    aliasType: AuthorizationTokenAliasType.REGISTER,
    tokenAlias: 1n,
    tokenType: 1n,
    tokenValue: new Uint8Array([0x01]),
  } as const;
  const useAlias = { aliasType: AuthorizationTokenAliasType.USE_ALIAS, tokenAlias: 1n } as const;
  const useValue = {
    aliasType: AuthorizationTokenAliasType.USE_VALUE,
    tokenType: 1n,
    tokenValue: new Uint8Array([0x01]),
  } as const;
  const del = { aliasType: AuthorizationTokenAliasType.DELETE, tokenAlias: 1n } as const;

  assert.deepEqual(requestsTokenUnlessDelete(register), register);
  assert.deepEqual(requestsTokenUnlessDelete(useAlias), useAlias);
  assert.deepEqual(requestsTokenUnlessDelete(useValue), useValue);
  assert.isUndefined(requestsTokenUnlessDelete(del));
  assert.isUndefined(requestsTokenUnlessDelete(undefined));
});

/**
 * REGISTER は初回要求で送信済みのため、REQUEST_UPDATE では USE_ALIAS に変換する
 * (再 REGISTER は DUPLICATE_AUTH_TOKEN_ALIAS でセッションを閉じる)。
 */
test("requestsTokenForRequestUpdate: REGISTER は USE_ALIAS に変換する", () => {
  const register = {
    aliasType: AuthorizationTokenAliasType.REGISTER,
    tokenAlias: 3n,
    tokenType: 1n,
    tokenValue: new Uint8Array([0x01]),
  } as const;
  assert.deepEqual(requestsTokenForRequestUpdate(register), {
    aliasType: AuthorizationTokenAliasType.USE_ALIAS,
    tokenAlias: 3n,
  });
  const useValue = {
    aliasType: AuthorizationTokenAliasType.USE_VALUE,
    tokenType: 1n,
    tokenValue: new Uint8Array([0x01]),
  } as const;
  assert.deepEqual(requestsTokenForRequestUpdate(useValue), useValue);
  assert.isUndefined(requestsTokenForRequestUpdate(undefined));
});
