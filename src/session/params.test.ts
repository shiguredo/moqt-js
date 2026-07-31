/**
 * src/session/params.ts の純粋関数テスト
 */

import { test, assert } from "vite-plus/test";
import {
  clampTimeoutMs,
  matchNamespacePrefix,
  buildSubscribeParameters,
  buildFetchParameters,
  buildSubscribeNamespaceParameters,
  encodeAuthorizationTokenParameter,
} from "./params";
import { encodeParameters, decodeParameters } from "../message/parameter";
import { MessageParameterType } from "../message/types";
import {
  AuthorizationTokenAliasType,
  decodeAuthorizationToken,
  type AuthorizationToken,
} from "../message/authorizationToken";

// ============================================================================
// clampTimeoutMs
// ============================================================================

test("clampTimeoutMs: 通常値はそのまま number に変換される", () => {
  // 上限以下の通常のタイムアウト値は変化しないことを検証する
  assert.equal(clampTimeoutMs(1000n), 1000);
});

test("clampTimeoutMs: 1n はそのまま 1 になる", () => {
  assert.equal(clampTimeoutMs(1n), 1);
});

test("clampTimeoutMs: 上限ちょうど (2^31 - 1) はクランプされない", () => {
  // 2147483647 (2^31 - 1) は setTimeout の上限ちょうどなのでそのまま返す
  assert.equal(clampTimeoutMs(2147483647n), 2147483647);
});

test("clampTimeoutMs: 上限 +1 は 2^31 - 1 にクランプされる", () => {
  // 2147483648 (上限 +1) を超えると即発火するため上限でクランプする
  assert.equal(clampTimeoutMs(2147483648n), 2147483647);
});

test("clampTimeoutMs: varint 上限近傍の巨大値も 2^31 - 1 にクランプされる", () => {
  // 受信 GOAWAY のピア由来の巨大値 (2^62) でも上限で抑えられることを検証する
  assert.equal(clampTimeoutMs(2n ** 62n), 2147483647);
});

test("clampTimeoutMs: bigint の最大級の値でも 2^31 - 1 にクランプされる", () => {
  // varint の理論上限 (2^64 - 1) でも Number 変換が Infinity にならず上限でクランプされる
  assert.equal(clampTimeoutMs(18446744073709551615n), 2147483647);
});

// ============================================================================
// matchNamespacePrefix
// ============================================================================

test("matchNamespacePrefix: 完全一致する場合、空 suffix を返す", () => {
  // trackNamespace と namespacePrefix が完全に一致する場合、
  // suffix は空配列になることを検証する
  const result = matchNamespacePrefix(["a", "b"], ["a", "b"]);
  assert.deepEqual(result, []);
});

test("matchNamespacePrefix: 前方一致する場合、後続要素を suffix として返す", () => {
  // trackNamespace の先頭要素が namespacePrefix に一致する場合、
  // 残りの要素が suffix として返されることを検証する
  const result = matchNamespacePrefix(["ns", "sub", "trackId", "data"], ["ns", "sub"]);
  assert.deepEqual(result, ["trackId", "data"]);
});

test("matchNamespacePrefix: 空の namespacePrefix は常にマッチし全要素を suffix として返す", () => {
  // namespacePrefix が空配列の場合は常に前方一致する
  const result = matchNamespacePrefix(["any"], []);
  assert.deepEqual(result, ["any"]);
});

test("matchNamespacePrefix: namespacePrefix の方が長い場合はマッチしない", () => {
  // namespacePrefix が trackNamespace より長い場合、前方一致できない
  const result = matchNamespacePrefix(["a"], ["a", "b"]);
  assert.equal(result, null);
});

test("matchNamespacePrefix: 要素が一致しない場合は null を返す", () => {
  // trackNamespace の要素が namespacePrefix の要素と一致しない場合
  const result = matchNamespacePrefix(["a", "x"], ["a", "b"]);
  assert.equal(result, null);
});

test("matchNamespacePrefix: 先頭から不一致の場合は null を返す", () => {
  // 先頭要素から一致しない場合
  const result = matchNamespacePrefix(["x", "y"], ["a", "b"]);
  assert.equal(result, null);
});

test("matchNamespacePrefix: 両方空配列の場合は空 suffix を返す", () => {
  const result = matchNamespacePrefix([], []);
  assert.deepEqual(result, []);
});

// ============================================================================
// AUTHORIZATION_TOKEN 付与（draft-ietf-moq-msf-01 §11.4.3）
// ============================================================================

// USE_VALUE スキームのトークン（draft-ietf-moq-transport-19 §10.2.2 Alias Type 0x3）
function useValueToken(): AuthorizationToken {
  return {
    aliasType: AuthorizationTokenAliasType.USE_VALUE,
    tokenType: 0n,
    tokenValue: new TextEncoder().encode("scheme-token"),
  };
}

test("encodeAuthorizationTokenParameter: 0x03 パラメータを構築し round-trip する", () => {
  const param = encodeAuthorizationTokenParameter(useValueToken());
  assert.equal(param.type, MessageParameterType.AUTHORIZATION_TOKEN);

  const decoded = decodeAuthorizationToken(param.value);
  assert.equal(decoded.aliasType, AuthorizationTokenAliasType.USE_VALUE);
  if (decoded.aliasType === AuthorizationTokenAliasType.USE_VALUE) {
    assert.equal(new TextDecoder().decode(decoded.tokenValue), "scheme-token");
  }
});

test("buildSubscribeParameters: authorizationToken が AUTHORIZATION_TOKEN パラメータになる", () => {
  const parameters = buildSubscribeParameters({ authorizationToken: useValueToken() });
  const authParams = parameters.filter((p) => p.type === MessageParameterType.AUTHORIZATION_TOKEN);
  assert.equal(authParams.length, 1);

  // encodeParameters / decodeParameters で round-trip してもトークンが再現する
  const [decoded] = decodeParameters(encodeParameters(parameters));
  const decodedAuth = decoded.find((p) => p.type === MessageParameterType.AUTHORIZATION_TOKEN);
  assert.isDefined(decodedAuth);
  const token = decodeAuthorizationToken(decodedAuth!.value);
  assert.equal(token.aliasType, AuthorizationTokenAliasType.USE_VALUE);
});

test("buildSubscribeParameters: authorizationToken 未指定は AUTHORIZATION_TOKEN を含まない", () => {
  const parameters = buildSubscribeParameters({});
  assert.isUndefined(parameters.find((p) => p.type === MessageParameterType.AUTHORIZATION_TOKEN));
});

test("buildFetchParameters: authorizationToken が AUTHORIZATION_TOKEN パラメータになる", () => {
  const parameters = buildFetchParameters({
    fillTimeout: 1000n,
    startLocation: { group: 0n, object: 0n },
    endLocation: { group: 1n, object: 0n },
    authorizationToken: useValueToken(),
  });
  const authParams = parameters.filter((p) => p.type === MessageParameterType.AUTHORIZATION_TOKEN);
  assert.equal(authParams.length, 1);
  // FILL_TIMEOUT も同時に送出される
  assert.isDefined(parameters.find((p) => p.type === MessageParameterType.FILL_TIMEOUT));
});

test("buildFetchParameters: authorizationToken 未指定は AUTHORIZATION_TOKEN を含まない", () => {
  const parameters = buildFetchParameters({
    fillTimeout: 1000n,
    startLocation: { group: 0n, object: 0n },
    endLocation: { group: 1n, object: 0n },
  });
  assert.isUndefined(parameters.find((p) => p.type === MessageParameterType.AUTHORIZATION_TOKEN));
});

test("buildSubscribeNamespaceParameters: authorizationToken が AUTHORIZATION_TOKEN パラメータになる", () => {
  const parameters = buildSubscribeNamespaceParameters({ authorizationToken: useValueToken() });
  const authParams = parameters.filter((p) => p.type === MessageParameterType.AUTHORIZATION_TOKEN);
  assert.equal(authParams.length, 1);
});

test("buildSubscribeNamespaceParameters: authorizationToken 未指定は空", () => {
  const parameters = buildSubscribeNamespaceParameters({});
  assert.equal(parameters.length, 0);
});
