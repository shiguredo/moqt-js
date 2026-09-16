/**
 * session/authTokenCache.ts のテスト
 *
 * draft-ietf-moq-transport-21 §8.9 / §9.1.3 / §9.1.4 / §9.20.3 が定める
 * 受信 Authorization Token キャッシュの登録・解決・退役と、SETUP 経路 /
 * メッセージパラメータ経路で異なる上限超過の扱いを検証する。
 */

import { test, assert } from "vite-plus/test";
import {
  AuthorizationTokenAliasType,
  encodeAuthorizationToken,
  type AuthorizationToken,
} from "../message/authorizationToken";
import { MessageParameterType, SetupOptionType } from "../message/types";
import { SessionError, SessionErrorCode } from "../error";
import {
  AuthTokenCache,
  processMessageAuthorizationTokens,
  processSetupAuthorizationTokens,
} from "./authTokenCache";

/** REGISTER 形式の Token を組み立てる */
function registerToken(tokenAlias: bigint, tokenType: bigint, tokenValue: Uint8Array) {
  return encodeAuthorizationToken({
    aliasType: AuthorizationTokenAliasType.REGISTER,
    tokenAlias,
    tokenType,
    tokenValue,
  });
}

/** AUTHORIZATION TOKEN パラメータを組み立てる */
function authorizationTokenParameter(token: AuthorizationToken) {
  return {
    type: MessageParameterType.AUTHORIZATION_TOKEN,
    value: encodeAuthorizationToken(token),
  };
}

// ============================================================================
// AuthTokenCache: 登録
// ============================================================================

test("AuthTokenCache: REGISTER で登録され、サイズは 16 バイト + Token Value 長になる", () => {
  const cache = new AuthTokenCache(1024);
  const result = cache.register(1n, 7n, new Uint8Array([1, 2, 3]));

  assert.deepEqual(result, { status: "registered" });
  // draft-ietf-moq-transport-21 §9.1.3: token size = 16 + Token Value 長
  assert.equal(cache.size, 16 + 3);
});

test("AuthTokenCache: 未登録の Alias はどの Alias でも登録できる", () => {
  const cache = new AuthTokenCache(1024);
  // Alias 空間は送信元ごとに独立するため、値そのものに制約はない
  assert.deepEqual(cache.register(0n, 1n, new Uint8Array(0)), { status: "registered" });
  assert.deepEqual(cache.register(1n, 1n, new Uint8Array(0)), { status: "registered" });
  assert.deepEqual(cache.register(2n ** 62n, 1n, new Uint8Array(0)), { status: "registered" });
  assert.equal(cache.size, (16 + 0) * 3);
});

test("AuthTokenCache: 同一 Alias の再 REGISTER は duplicate-alias になりサイズは変わらない", () => {
  const cache = new AuthTokenCache(1024);
  cache.register(5n, 1n, new Uint8Array([9]));
  const before = cache.size;

  // draft-ietf-moq-transport-21 §8.9: 一度登録した Alias は delete されるまで再登録できない
  const result = cache.register(5n, 2n, new Uint8Array([7, 7]));

  assert.deepEqual(result, { status: "duplicate-alias" });
  assert.equal(cache.size, before);
  // 元の Token Type / Value が保持されている (上書きされない)
  assert.deepEqual(cache.resolve(5n), {
    status: "resolved",
    tokenType: 1n,
    tokenValue: new Uint8Array([9]),
  });
});

test("AuthTokenCache: 上限ちょうどの REGISTER は成功し、上限を超える REGISTER は cache-overflow になる", () => {
  // 16 (固定) + 4 (Value) = 20 が 1 件分
  const cache = new AuthTokenCache(20);
  assert.deepEqual(cache.register(1n, 1n, new Uint8Array(4)), { status: "registered" });
  // 2 件目は 20 + 20 = 40 > 20 で超過 (attemptedSize は登録した場合の合計)
  assert.deepEqual(cache.register(2n, 1n, new Uint8Array(4)), {
    status: "cache-overflow",
    attemptedSize: 40,
  });
  // 超過した登録はキャッシュへ反映されない
  assert.deepEqual(cache.resolve(2n), { status: "unknown-alias" });
  assert.equal(cache.size, 20);
});

test("AuthTokenCache: 上限を 1 バイト超える REGISTER は cache-overflow になる", () => {
  // 16 (固定) + 4 (Value) = 20 で上限ちょうど、さらに 1 バイト増やすと 21 > 20
  const cache = new AuthTokenCache(20);
  assert.deepEqual(cache.register(1n, 1n, new Uint8Array(4)), { status: "registered" });
  cache.delete(1n);

  assert.deepEqual(cache.register(2n, 1n, new Uint8Array(5)), {
    status: "cache-overflow",
    attemptedSize: 21,
  });
  assert.equal(cache.size, 0);
});

test("AuthTokenCache: Value が空でも 16 バイトを占めるため上限 0 では登録できない", () => {
  // §9.1.3: 未広告時の既定は 0 であり Alias を使用できない
  const cache = new AuthTokenCache(0);
  assert.deepEqual(cache.register(1n, 1n, new Uint8Array(0)), {
    status: "cache-overflow",
    attemptedSize: 16,
  });
  assert.equal(cache.size, 0);
});

// ============================================================================
// AuthTokenCache: 解決と退役
// ============================================================================

test("AuthTokenCache: USE_ALIAS は登録済みの Token Type / Value を解決する", () => {
  const cache = new AuthTokenCache(1024);
  cache.register(3n, 42n, new Uint8Array([0xaa, 0xbb]));

  const result = cache.resolve(3n);

  assert.equal(result.status, "resolved");
  assert.deepEqual(result, {
    status: "resolved",
    tokenType: 42n,
    tokenValue: new Uint8Array([0xaa, 0xbb]),
  });
});

test("AuthTokenCache: 未登録 Alias の解決は unknown-alias になる", () => {
  const cache = new AuthTokenCache(1024);
  assert.deepEqual(cache.resolve(1n), { status: "unknown-alias" });
});

test("AuthTokenCache: DELETE で退役し、サイズが減り、解決できなくなる", () => {
  const cache = new AuthTokenCache(1024);
  cache.register(4n, 1n, new Uint8Array(6));
  assert.equal(cache.size, 22);

  cache.delete(4n);

  assert.equal(cache.size, 0);
  assert.deepEqual(cache.resolve(4n), { status: "unknown-alias" });
});

test("AuthTokenCache: DELETE 後は同じ Alias を再 REGISTER できる", () => {
  const cache = new AuthTokenCache(1024);
  cache.register(4n, 1n, new Uint8Array(2));
  cache.delete(4n);

  // §8.9: delete を挟めば同一 Alias を再登録できる
  assert.deepEqual(cache.register(4n, 2n, new Uint8Array(3)), { status: "registered" });
  assert.deepEqual(cache.resolve(4n), {
    status: "resolved",
    tokenType: 2n,
    tokenValue: new Uint8Array(3),
  });
  assert.equal(cache.size, 16 + 3);
});

test("AuthTokenCache: 未登録 Alias の DELETE はサイズを変えない", () => {
  const cache = new AuthTokenCache(1024);
  cache.register(1n, 1n, new Uint8Array(4));

  cache.delete(99n);

  assert.equal(cache.size, 20);
});

test("AuthTokenCache: DELETE で空いた分は次の REGISTER に再利用できる", () => {
  const cache = new AuthTokenCache(20);
  cache.register(1n, 1n, new Uint8Array(4));
  // 退役前は上限に達していて登録できない
  assert.deepEqual(cache.register(2n, 1n, new Uint8Array(4)), {
    status: "cache-overflow",
    attemptedSize: 40,
  });

  cache.delete(1n);

  // §9.1.3: 合計は REGISTER の総和 − DELETE の総和で計算する
  assert.deepEqual(cache.register(2n, 1n, new Uint8Array(4)), { status: "registered" });
  assert.equal(cache.size, 20);
});

// ============================================================================
// SETUP 経路
// ============================================================================

test("processSetupAuthorizationTokens: REGISTER がキャッシュへ登録される", () => {
  const cache = new AuthTokenCache(1024);

  processSetupAuthorizationTokens(cache, [
    {
      type: MessageParameterType.AUTHORIZATION_TOKEN,
      value: registerToken(7n, 3n, new Uint8Array([1])),
    },
  ]);

  assert.deepEqual(cache.resolve(7n), {
    status: "resolved",
    tokenType: 3n,
    tokenValue: new Uint8Array([1]),
  });
});

test("processSetupAuthorizationTokens: AUTHORIZATION TOKEN 以外の Setup Option は無視する", () => {
  const cache = new AuthTokenCache(1024);

  // 未知の Setup Option は MUST ignore (§9.1) であり、キャッシュ処理の対象外
  processSetupAuthorizationTokens(cache, [
    { type: 0x05, value: new Uint8Array([0xff]) },
    { type: 0x7f9d, value: new Uint8Array(0) },
  ]);

  assert.equal(cache.size, 0);
});

test("processSetupAuthorizationTokens: 上限超過の REGISTER は USE_VALUE 扱いで登録されない", () => {
  // §9.1.4: SETUP の REGISTER が上限を超えても AUTH_TOKEN_CACHE_OVERFLOW で
  // セッションを失敗させず、USE_VALUE として扱う MUST
  const cache = new AuthTokenCache(0);

  processSetupAuthorizationTokens(cache, [
    {
      type: MessageParameterType.AUTHORIZATION_TOKEN,
      value: registerToken(1n, 1n, new Uint8Array([1])),
    },
  ]);

  assert.deepEqual(cache.resolve(1n), { status: "unknown-alias" });
  assert.equal(cache.size, 0);
});

test("processSetupAuthorizationTokens: 登録済み Alias の再 REGISTER は DUPLICATE_AUTH_TOKEN_ALIAS になる", () => {
  const cache = new AuthTokenCache(1024);
  cache.register(2n, 1n, new Uint8Array([1]));

  // §8.9: 登録済み Alias の再 REGISTER はセッションを閉じる
  const error = assert.throws(() =>
    processSetupAuthorizationTokens(cache, [
      {
        type: MessageParameterType.AUTHORIZATION_TOKEN,
        value: registerToken(2n, 1n, new Uint8Array([2])),
      },
    ]),
  );

  assert.instanceOf(error, SessionError);
  assert.equal((error as SessionError).code, SessionErrorCode.DUPLICATE_AUTH_TOKEN_ALIAS);
});

test("processSetupAuthorizationTokens: DELETE は PROTOCOL_VIOLATION の SessionError になる", () => {
  const cache = new AuthTokenCache(1024);
  cache.register(1n, 1n, new Uint8Array([1]));

  // §9.1.4: SETUP の DELETE は PROTOCOL_VIOLATION
  const error = assert.throws(() =>
    processSetupAuthorizationTokens(cache, [
      authorizationTokenParameter({
        aliasType: AuthorizationTokenAliasType.DELETE,
        tokenAlias: 1n,
      }),
    ]),
  );

  assert.instanceOf(error, SessionError);
  assert.equal((error as SessionError).code, SessionErrorCode.PROTOCOL_VIOLATION);
  // 違反時点で退役させない (検査のみ)
  assert.equal(cache.size, 17);
});

test("processSetupAuthorizationTokens: USE_ALIAS は PROTOCOL_VIOLATION の SessionError になる", () => {
  const cache = new AuthTokenCache(1024);
  cache.register(1n, 1n, new Uint8Array([1]));

  // §9.1.4: SETUP の USE_ALIAS は PROTOCOL_VIOLATION
  const error = assert.throws(() =>
    processSetupAuthorizationTokens(cache, [
      authorizationTokenParameter({
        aliasType: AuthorizationTokenAliasType.USE_ALIAS,
        tokenAlias: 1n,
      }),
    ]),
  );

  assert.instanceOf(error, SessionError);
  assert.equal((error as SessionError).code, SessionErrorCode.PROTOCOL_VIOLATION);
});

test("processSetupAuthorizationTokens: USE_VALUE はキャッシュへ登録しない", () => {
  const cache = new AuthTokenCache(1024);

  processSetupAuthorizationTokens(cache, [
    authorizationTokenParameter({
      aliasType: AuthorizationTokenAliasType.USE_VALUE,
      tokenType: 9n,
      tokenValue: new Uint8Array([1, 2]),
    }),
  ]);

  // §8.9: USE_VALUE は Alias を持たず、値は処理後に破棄してよい
  assert.equal(cache.size, 0);
});

test("processSetupAuthorizationTokens: デコード不能な Token は KEY_VALUE_FORMATTING_ERROR になる", () => {
  const cache = new AuthTokenCache(1024);

  // 未知の Alias Type (0x04) は Token 構造としてデコードできない
  const error = assert.throws(() =>
    processSetupAuthorizationTokens(cache, [
      { type: MessageParameterType.AUTHORIZATION_TOKEN, value: new Uint8Array([0x04]) },
    ]),
  );

  assert.instanceOf(error, SessionError);
  assert.equal((error as SessionError).code, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
});

test("processSetupAuthorizationTokens: REGISTER は Token Value が空でも登録できる", () => {
  const cache = new AuthTokenCache(1024);

  // §8.9: Token Value は残りバイト列であり、0 バイトでも構造として成立する
  processSetupAuthorizationTokens(cache, [
    {
      type: SetupOptionType.AUTHORIZATION_TOKEN,
      value: encodeAuthorizationToken({
        aliasType: AuthorizationTokenAliasType.REGISTER,
        tokenAlias: 0n,
        tokenType: 0n,
        tokenValue: new Uint8Array(0),
      }),
    },
  ]);

  assert.equal(cache.size, 16);
  assert.deepEqual(cache.resolve(0n), {
    status: "resolved",
    tokenType: 0n,
    tokenValue: new Uint8Array(0),
  });
});

// ============================================================================
// メッセージパラメータ経路
// ============================================================================

test("processMessageAuthorizationTokens: REGISTER がキャッシュへ登録される", () => {
  const cache = new AuthTokenCache(1024);

  const result = processMessageAuthorizationTokens(cache, [
    {
      type: MessageParameterType.AUTHORIZATION_TOKEN,
      value: registerToken(1n, 5n, new Uint8Array([2, 3])),
    },
  ]);

  assert.deepEqual(result, { status: "ok" });
  assert.deepEqual(cache.resolve(1n), {
    status: "resolved",
    tokenType: 5n,
    tokenValue: new Uint8Array([2, 3]),
  });
});

test("processMessageAuthorizationTokens: 上限超過の REGISTER は AUTH_TOKEN_CACHE_OVERFLOW の SessionError になる", () => {
  // §9.1.3: 上限超過は AUTH_TOKEN_CACHE_OVERFLOW でセッションを終了する
  const cache = new AuthTokenCache(16);

  const error = assert.throws(() =>
    processMessageAuthorizationTokens(cache, [
      {
        type: MessageParameterType.AUTHORIZATION_TOKEN,
        value: registerToken(1n, 1n, new Uint8Array([1])),
      },
    ]),
  );

  assert.instanceOf(error, SessionError);
  assert.equal((error as SessionError).code, SessionErrorCode.AUTH_TOKEN_CACHE_OVERFLOW);
});

test("processMessageAuthorizationTokens: 登録済み Alias の再 REGISTER は DUPLICATE_AUTH_TOKEN_ALIAS になる", () => {
  const cache = new AuthTokenCache(1024);
  cache.register(1n, 1n, new Uint8Array([1]));

  const error = assert.throws(() =>
    processMessageAuthorizationTokens(cache, [
      {
        type: MessageParameterType.AUTHORIZATION_TOKEN,
        value: registerToken(1n, 1n, new Uint8Array([1])),
      },
    ]),
  );

  assert.instanceOf(error, SessionError);
  assert.equal((error as SessionError).code, SessionErrorCode.DUPLICATE_AUTH_TOKEN_ALIAS);
});

test("processMessageAuthorizationTokens: 未登録 Alias の USE_ALIAS は unknown-alias を返す (セッションを閉じるのは呼び出し元)", () => {
  // §8.9: 未登録 Alias の参照は UNKNOWN_AUTH_TOKEN_ALIAS で拒否する MUST。
  // 本関数はセッションを閉じず、呼び出し元が Session Termination にする。
  const cache = new AuthTokenCache(1024);

  const result = processMessageAuthorizationTokens(cache, [
    authorizationTokenParameter({
      aliasType: AuthorizationTokenAliasType.USE_ALIAS,
      tokenAlias: 42n,
    }),
  ]);

  assert.deepEqual(result, { status: "unknown-alias", tokenAlias: 42n });
});

test("processMessageAuthorizationTokens: 登録済み Alias の USE_ALIAS は ok になる", () => {
  const cache = new AuthTokenCache(1024);
  cache.register(42n, 1n, new Uint8Array([7]));

  const result = processMessageAuthorizationTokens(cache, [
    authorizationTokenParameter({
      aliasType: AuthorizationTokenAliasType.USE_ALIAS,
      tokenAlias: 42n,
    }),
  ]);

  assert.deepEqual(result, { status: "ok" });
});

test("processMessageAuthorizationTokens: 同一メッセージ内の DELETE で退役し、続く USE_ALIAS は unknown-alias になる", () => {
  const cache = new AuthTokenCache(1024);
  cache.register(1n, 1n, new Uint8Array([1]));

  // 1 通のメッセージ内で DELETE → USE_ALIAS の順に現れる。
  // §8.9 は同一メッセージ内の Authorization Token の繰り返しを許容する。
  const result = processMessageAuthorizationTokens(cache, [
    authorizationTokenParameter({ aliasType: AuthorizationTokenAliasType.DELETE, tokenAlias: 1n }),
    authorizationTokenParameter({
      aliasType: AuthorizationTokenAliasType.USE_ALIAS,
      tokenAlias: 1n,
    }),
  ]);

  assert.deepEqual(result, { status: "unknown-alias", tokenAlias: 1n });
  assert.equal(cache.size, 0);
});

test("processMessageAuthorizationTokens: USE_VALUE はキャッシュを変更しない", () => {
  const cache = new AuthTokenCache(1024);

  const result = processMessageAuthorizationTokens(cache, [
    authorizationTokenParameter({
      aliasType: AuthorizationTokenAliasType.USE_VALUE,
      tokenType: 1n,
      tokenValue: new Uint8Array([1, 2, 3]),
    }),
  ]);

  assert.deepEqual(result, { status: "ok" });
  assert.equal(cache.size, 0);
});

test("processMessageAuthorizationTokens: 複数の AUTHORIZATION TOKEN を順に処理する", () => {
  const cache = new AuthTokenCache(1024);

  // §8.9: 解決後の Token Type / Value の組が一意なら同じメッセージ内で繰り返せる
  const result = processMessageAuthorizationTokens(cache, [
    {
      type: MessageParameterType.AUTHORIZATION_TOKEN,
      value: registerToken(1n, 1n, new Uint8Array([1])),
    },
    {
      type: MessageParameterType.AUTHORIZATION_TOKEN,
      value: encodeAuthorizationToken({
        aliasType: AuthorizationTokenAliasType.USE_ALIAS,
        tokenAlias: 1n,
      }),
    },
    {
      type: MessageParameterType.AUTHORIZATION_TOKEN,
      value: registerToken(2n, 2n, new Uint8Array([2])),
    },
  ]);

  assert.deepEqual(result, { status: "ok" });
  // Token Value はどちらも 1 バイトのため 1 件あたり 16 + 1 = 17
  assert.equal(cache.size, 17 + 17);
});

test("processMessageAuthorizationTokens: 複数 Token のうち 1 つでも未登録 Alias なら unknown-alias を返す", () => {
  const cache = new AuthTokenCache(1024);

  const result = processMessageAuthorizationTokens(cache, [
    {
      type: MessageParameterType.AUTHORIZATION_TOKEN,
      value: registerToken(1n, 1n, new Uint8Array([1])),
    },
    authorizationTokenParameter({
      aliasType: AuthorizationTokenAliasType.USE_ALIAS,
      tokenAlias: 99n,
    }),
  ]);

  assert.deepEqual(result, { status: "unknown-alias", tokenAlias: 99n });
  // 先に処理した REGISTER は §8.9 の MUST により維持する
  assert.deepEqual(cache.resolve(1n), {
    status: "resolved",
    tokenType: 1n,
    tokenValue: new Uint8Array([1]),
  });
});

test("processMessageAuthorizationTokens: AUTHORIZATION TOKEN 以外のパラメータは無視する", () => {
  const cache = new AuthTokenCache(1024);

  const result = processMessageAuthorizationTokens(cache, [
    { type: MessageParameterType.EXPIRES, value: new Uint8Array([0x01]) },
    { type: MessageParameterType.FORWARD, value: new Uint8Array([0x01]) },
  ]);

  assert.deepEqual(result, { status: "ok" });
  assert.equal(cache.size, 0);
});

test("processMessageAuthorizationTokens: デコード不能な Token は KEY_VALUE_FORMATTING_ERROR になる", () => {
  const cache = new AuthTokenCache(1024);

  // DELETE 形式で末尾に余分なバイトがある構造は不正
  const error = assert.throws(() =>
    processMessageAuthorizationTokens(cache, [
      { type: MessageParameterType.AUTHORIZATION_TOKEN, value: new Uint8Array([0x00, 0x01, 0xff]) },
    ]),
  );

  assert.instanceOf(error, SessionError);
  assert.equal((error as SessionError).code, SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
});

test("processMessageAuthorizationTokens: REGISTER は Token Value の長さでサイズが決まる", () => {
  const cache = new AuthTokenCache(4096);

  const result = processMessageAuthorizationTokens(cache, [
    {
      type: MessageParameterType.AUTHORIZATION_TOKEN,
      value: registerToken(1n, 1n, new Uint8Array(100)),
    },
  ]);

  assert.deepEqual(result, { status: "ok" });
  assert.equal(cache.size, 116);
});

test("processMessageAuthorizationTokens: 未登録 Alias の参照を検出した時点で打ち切り、後続の違反で終了コードを上書きしない", () => {
  const cache = new AuthTokenCache(1024);
  // 先に Alias 1 を登録しておき、後続の REGISTER を重複違反にする
  cache.register(1n, 1n, new Uint8Array([1]));

  const result = processMessageAuthorizationTokens(cache, [
    authorizationTokenParameter({
      aliasType: AuthorizationTokenAliasType.USE_ALIAS,
      tokenAlias: 99n,
    }),
    {
      type: MessageParameterType.AUTHORIZATION_TOKEN,
      value: registerToken(1n, 1n, new Uint8Array([1])),
    },
  ]);

  // 最初の違反である未登録 Alias が報告される。後続を処理すると
  // DUPLICATE_AUTH_TOKEN_ALIAS が送出されて診断コードがパラメータ順に依存する
  assert.deepEqual(result, { status: "unknown-alias", tokenAlias: 99n });
});
