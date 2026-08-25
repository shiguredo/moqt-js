/**
 * src/session/params.ts の純粋関数テスト
 */

import { test, assert } from "vite-plus/test";
import {
  clampTimeoutMs,
  matchNamespacePrefix,
  namespacePrefixesOverlap,
  validateNamespacePrefixUpdate,
  buildSubscribeParameters,
  buildSubscribeTracksParameters,
  buildRangeFilterParameters,
  mergeRangeFilters,
  validateRangeFilterLimits,
  validateRangeFilterSpecs,
  buildFetchParameters,
  buildSubscribeNamespaceParameters,
  buildPublishTrackProperties,
  encodeAuthorizationTokenParameter,
  validateTrackNamespaceForSend,
  compareLocations,
  validateFetchOkEndLocation,
} from "./params";
import { encodeParameters, decodeParameters } from "../message/parameter";
import { MessageParameterType } from "../message/types";
import { TrackPropertyId } from "../properties";
import { isGreaseValue } from "../grease";
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
// namespacePrefixesOverlap / validateNamespacePrefixUpdate
// draft-ietf-moq-transport-19 §10.9.2 (Updating Namespace Subscriptions)
// ============================================================================

test("namespacePrefixesOverlap: 新 prefix が既存 prefix の sub-prefix なら true", () => {
  // 新 prefix ["a"] は既存 prefix ["a", "b"] の sub-prefix であり共通 prefix を持つ
  assert.isTrue(namespacePrefixesOverlap(["a"], ["a", "b"]));
});

test("namespacePrefixesOverlap: 既存 prefix が新 prefix の sub-prefix なら true", () => {
  // 既存 prefix ["a"] は新 prefix ["a", "b"] の sub-prefix であり共通 prefix を持つ
  assert.isTrue(namespacePrefixesOverlap(["a", "b"], ["a"]));
});

test("namespacePrefixesOverlap: 完全一致は true", () => {
  assert.isTrue(namespacePrefixesOverlap(["a", "b"], ["a", "b"]));
});

test("namespacePrefixesOverlap: 共通 prefix が無ければ false", () => {
  assert.isFalse(namespacePrefixesOverlap(["a"], ["b"]));
  assert.isFalse(namespacePrefixesOverlap(["a", "b"], ["a", "c"]));
});

test("namespacePrefixesOverlap: 空 prefix はすべてと共通 prefix を持つ", () => {
  // 空配列はあらゆる prefix の sub-prefix であるため true
  assert.isTrue(namespacePrefixesOverlap([], ["a"]));
  assert.isTrue(namespacePrefixesOverlap(["a"], []));
});

test("validateNamespacePrefixUpdate: 重複が無ければ throw しない", () => {
  // 新 prefix ["a", "b"] は既存 prefix ["a", "c"] と共通 prefix を持たない
  assert.doesNotThrow(() =>
    validateNamespacePrefixUpdate(["a", "b"], [["a", "c"]], "SUBSCRIBE_TRACKS"),
  );
});

test("validateNamespacePrefixUpdate: 新 prefix が既存 prefix の sub-prefix なら throw する", () => {
  assert.throws(
    () => validateNamespacePrefixUpdate(["a"], [["a", "b"]], "SUBSCRIBE_NAMESPACE"),
    /overlaps with active subscription prefix/,
  );
});

test("validateNamespacePrefixUpdate: 既存 prefix が新 prefix の sub-prefix なら throw する", () => {
  assert.throws(
    () => validateNamespacePrefixUpdate(["a", "b"], [["a"]], "SUBSCRIBE_TRACKS"),
    /overlaps with active subscription prefix/,
  );
});

test("validateNamespacePrefixUpdate: 複数既存 prefix のいずれかと重複すれば throw する", () => {
  assert.throws(
    () => validateNamespacePrefixUpdate(["a", "b"], [["x"], ["a"]], "SUBSCRIBE_NAMESPACE"),
    /overlaps with active subscription prefix/,
  );
});

test("validateNamespacePrefixUpdate: アクティブな既存 prefix が無ければ throw しない", () => {
  assert.doesNotThrow(() => validateNamespacePrefixUpdate(["a", "b"], [], "SUBSCRIBE_NAMESPACE"));
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

// ============================================================================
// buildPublishTrackProperties (GREASE)
// draft-ietf-moq-transport-19 §14 (Grease) / §2.5.1 (Mandatory Track Properties)
// ============================================================================

test("buildPublishTrackProperties: grease 未指定は GREASE Property を含まない", () => {
  const properties = buildPublishTrackProperties({});
  assert.isUndefined(properties.find((p) => isGreaseValue(p.id)));
});

test("buildPublishTrackProperties: grease: false は GREASE Property を含まない", () => {
  const properties = buildPublishTrackProperties({}, false);
  assert.isUndefined(properties.find((p) => isGreaseValue(p.id)));
});

test("buildPublishTrackProperties: grease: true は GREASE Property を 1 つ含む", () => {
  // Property ID はランダム生成のため、複数回サンプリングして不変条件を検証する
  for (let i = 0; i < 100; i++) {
    const properties = buildPublishTrackProperties({}, true);
    const greaseProperties = properties.filter((p) => isGreaseValue(p.id));
    assert.equal(greaseProperties.length, 1);
    // §2.5.1 の Mandatory Track Property 範囲 0x4000-0x7FFF に落入しないこと
    assert.isTrue(greaseProperties[0].id < 0x4000n);
    // 奇数 ID（Length プレフィックス付きバイト列形式）であること
    assert.equal(greaseProperties[0].id % 2n, 1n);
  }
});

test("buildPublishTrackProperties: grease: true でも他の Track Property は保持される", () => {
  const properties = buildPublishTrackProperties(
    { deliveryTimeout: 1000n, dynamicGroups: true },
    true,
  );
  assert.isDefined(properties.find((p) => p.id === TrackPropertyId.OBJECT_DELIVERY_TIMEOUT));
  assert.isDefined(properties.find((p) => p.id === TrackPropertyId.DYNAMIC_GROUPS));
  assert.equal(properties.filter((p) => isGreaseValue(p.id)).length, 1);
});

// ============================================================================
// buildSubscribeTracksParameters (Range Filters)
// draft-ietf-moq-transport-19 §10.19.1 / §6.3 / §5.1.3
// ============================================================================

test("buildSubscribeTracksParameters: rangeFilters が SUBSCRIBE_TRACKS パラメータになる", () => {
  const parameters = buildSubscribeTracksParameters({
    groupOrder: "Ascending",
    forward: false,
    rangeFilters: [
      {
        type: "trackProperty",
        setId: 0,
        propertyType: 0x30n,
        ranges: [{ start: 1n, end: 1n }],
      },
      {
        type: "subgroup",
        setId: 0,
        ranges: [{ start: 0n, end: 2n }],
      },
    ],
  });

  const trackPropertyFilter = parameters.find(
    (p) => p.type === MessageParameterType.TRACK_PROPERTY_FILTER,
  );
  assert.isDefined(trackPropertyFilter);
  const subgroupFilter = parameters.find((p) => p.type === MessageParameterType.SUBGROUP_FILTER);
  assert.isDefined(subgroupFilter);

  // GROUP_ORDER / FORWARD も同時に送出される
  assert.isDefined(parameters.find((p) => p.type === MessageParameterType.GROUP_ORDER));
  assert.isDefined(parameters.find((p) => p.type === MessageParameterType.FORWARD));

  // encodeParameters / decodeParameters で round-trip しても再現する
  const [decoded] = decodeParameters(encodeParameters(parameters));
  const decodedTrackPropertyFilter = decoded.find(
    (p) => p.type === MessageParameterType.TRACK_PROPERTY_FILTER,
  );
  assert.isDefined(decodedTrackPropertyFilter);
});

test("buildSubscribeTracksParameters: rangeFilters 未指定は Range Filter を含まない", () => {
  const parameters = buildSubscribeTracksParameters({ groupOrder: "Descending" });
  assert.isUndefined(parameters.find((p) => p.type === MessageParameterType.TRACK_PROPERTY_FILTER));
  assert.isUndefined(parameters.find((p) => p.type === MessageParameterType.SUBGROUP_FILTER));
});

/**
 * draft-ietf-moq-transport-19 §5.1.3:
 * 削除 (Length=0) は REQUEST_UPDATE のみに定義されるため、
 * SUBSCRIBE_TRACKS で削除を指定すると throw することを検証する。
 */
test("buildSubscribeTracksParameters: 削除指定 (remove: true) で throw する", () => {
  assert.throws(
    () =>
      buildSubscribeTracksParameters({
        rangeFilters: [{ type: "objectId", remove: true }],
      }),
    /cannot remove range filters in SUBSCRIBE_TRACKS: remove is only allowed in REQUEST_UPDATE/,
  );
});

test("buildRangeFilterParameters: 追加と削除が混在してもパラメータ列に変換される", () => {
  const parameters = buildRangeFilterParameters([
    { type: "priority", setId: 1, ranges: [{ start: 128n }] },
    { type: "objectProperty", remove: true },
  ]);
  assert.equal(parameters.length, 2);
  assert.equal(parameters[0].type, MessageParameterType.PRIORITY_FILTER);
  assert.equal(parameters[1].type, MessageParameterType.OBJECT_PROPERTY_FILTER);
});

// ============================================================================
// buildSubscribeParameters / buildFetchParameters (送信ガード)
// draft-ietf-moq-transport-19 §5.1.3
// ============================================================================

test("buildSubscribeParameters: 削除指定で throw する", () => {
  assert.throws(
    () => buildSubscribeParameters({ rangeFilters: [{ type: "objectId", remove: true }] }),
    /cannot remove range filters in SUBSCRIBE/,
  );
});

test("buildSubscribeParameters: TRACK_PROPERTY_FILTER で throw する", () => {
  assert.throws(
    () =>
      buildSubscribeParameters({
        rangeFilters: [
          { type: "trackProperty", setId: 0, propertyType: 0x30n, ranges: [{ start: 1n }] },
        ],
      }),
    /cannot send TRACK_PROPERTY_FILTER in SUBSCRIBE/,
  );
});

test("buildSubscribeParameters: 正常な rangeFilters はエンコードされる", () => {
  const parameters = buildSubscribeParameters({
    rangeFilters: [{ type: "objectId", setId: 0, ranges: [{ start: 0n, end: 1n }] }],
  });
  assert.isDefined(parameters.find((p) => p.type === MessageParameterType.OBJECTID_FILTER));
});

test("buildFetchParameters: rangeFilters が FETCH パラメータになる", () => {
  const parameters = buildFetchParameters({
    startLocation: { group: 0n, object: 0n },
    endLocation: { group: 1n, object: 0n },
    rangeFilters: [{ type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 1n }] }],
  });
  assert.isDefined(parameters.find((p) => p.type === MessageParameterType.SUBGROUP_FILTER));
});

test("buildFetchParameters: 削除指定で throw する", () => {
  assert.throws(
    () =>
      buildFetchParameters({
        startLocation: { group: 0n, object: 0n },
        endLocation: { group: 1n, object: 0n },
        rangeFilters: [{ type: "objectId", remove: true }],
      }),
    /cannot remove range filters in FETCH/,
  );
});

test("buildFetchParameters: TRACK_PROPERTY_FILTER で throw する", () => {
  assert.throws(
    () =>
      buildFetchParameters({
        startLocation: { group: 0n, object: 0n },
        endLocation: { group: 1n, object: 0n },
        rangeFilters: [
          { type: "trackProperty", setId: 0, propertyType: 0x30n, ranges: [{ start: 1n }] },
        ],
      }),
    /cannot send TRACK_PROPERTY_FILTER in FETCH/,
  );
});

// ============================================================================
// validateRangeFilterLimits
// draft-ietf-moq-transport-19 §10.3.1.6 (MAX FILTER RANGES)
// ============================================================================

test("validateRangeFilterLimits: undefined は throw しない", () => {
  assert.doesNotThrow(() => validateRangeFilterLimits(undefined, 0, "SUBSCRIBE_TRACKS"));
});

test("validateRangeFilterLimits: 空配列は throw しない", () => {
  assert.doesNotThrow(() => validateRangeFilterLimits([], 0, "SUBSCRIBE_TRACKS"));
});

test("validateRangeFilterLimits: ピアの MAX_FILTER_RANGES が 0 なら throw する", () => {
  assert.throws(
    () =>
      validateRangeFilterLimits(
        [{ type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 1n }] }],
        0,
        "SUBSCRIBE_TRACKS",
      ),
    /MAX_FILTER_RANGES is 0/,
  );
});

test("validateRangeFilterLimits: Ranges 数が上限を超えるなら throw する", () => {
  assert.throws(
    () =>
      validateRangeFilterLimits(
        [
          {
            type: "subgroup",
            setId: 0,
            ranges: [
              { start: 0n, end: 1n },
              { start: 3n, end: 4n },
            ],
          },
        ],
        1,
        "REQUEST_UPDATE",
      ),
    /exceeds peer MAX_FILTER_RANGES 1/,
  );
});

test("validateRangeFilterLimits: Ranges 数が上限以下なら throw しない", () => {
  assert.doesNotThrow(() =>
    validateRangeFilterLimits(
      [
        {
          type: "subgroup",
          setId: 0,
          ranges: [
            { start: 0n, end: 1n },
            { start: 3n, end: 4n },
          ],
        },
      ],
      2,
      "SUBSCRIBE_TRACKS",
    ),
  );
});

test("validateRangeFilterLimits: 削除 (remove: true) は Ranges 数に数えられない", () => {
  // 削除のみは Ranges を持たないため、上限 1 でも超過しない
  assert.doesNotThrow(() =>
    validateRangeFilterLimits([{ type: "objectId", remove: true }], 1, "REQUEST_UPDATE"),
  );
  // 上限 0 は「any such filter parameters」を MUST NOT 送信のため、削除もブロックされる
  assert.throws(() =>
    validateRangeFilterLimits([{ type: "objectId", remove: true }], 0, "REQUEST_UPDATE"),
  );
});

// ============================================================================
// mergeRangeFilters
// draft-ietf-moq-transport-19 §5.1.3 (削除・置換・不変)
// ============================================================================

test("mergeRangeFilters: remove で当該パラメータ型全体が削除される", () => {
  const current = [
    { type: "subgroup" as const, setId: 0, ranges: [{ start: 0n, end: 1n }] },
    { type: "subgroup" as const, setId: 1, ranges: [{ start: 2n, end: 3n }] },
    { type: "objectId" as const, setId: 0, ranges: [{ start: 4n, end: 5n }] },
  ];
  const merged = mergeRangeFilters(current, [{ type: "subgroup", remove: true }]);
  assert.deepEqual(merged, [current[2]]);
});

test("mergeRangeFilters: 非 remove で当該パラメータ型全体が置換される", () => {
  const current = [
    { type: "subgroup" as const, setId: 0, ranges: [{ start: 0n, end: 1n }] },
    { type: "subgroup" as const, setId: 1, ranges: [{ start: 2n, end: 3n }] },
    { type: "objectId" as const, setId: 0, ranges: [{ start: 4n, end: 5n }] },
  ];
  const merged = mergeRangeFilters(current, [
    { type: "subgroup", setId: 0, ranges: [{ start: 10n, end: 11n }] },
  ]);
  // subgroup は全体置換 (SetID 1 も消え、置換後のエントリは末尾に移動)、
  // objectId は不変
  assert.deepEqual(merged, [
    { type: "objectId", setId: 0, ranges: [{ start: 4n, end: 5n }] },
    { type: "subgroup", setId: 0, ranges: [{ start: 10n, end: 11n }] },
  ]);
});

test("mergeRangeFilters: 同一型の複数エントリ (異なる SetID) は他型の追加で保持される", () => {
  const current = [
    { type: "subgroup" as const, setId: 0, ranges: [{ start: 0n, end: 1n }] },
    { type: "subgroup" as const, setId: 1, ranges: [{ start: 2n, end: 3n }] },
  ];
  const merged = mergeRangeFilters(current, [
    { type: "objectId", setId: 0, ranges: [{ start: 4n, end: 5n }] },
  ]);
  // update に現れない型 (subgroup) は不変のまま複数エントリが保持される
  assert.deepEqual(merged, [
    ...current,
    { type: "objectId", setId: 0, ranges: [{ start: 4n, end: 5n }] },
  ]);
});

test("mergeRangeFilters: update 内の同一型複数エントリ (異なる SetID) は置換として保持される", () => {
  const current = [{ type: "subgroup" as const, setId: 0, ranges: [{ start: 0n, end: 1n }] }];
  const merged = mergeRangeFilters(current, [
    { type: "subgroup", setId: 0, ranges: [{ start: 10n, end: 11n }] },
    { type: "subgroup", setId: 1, ranges: [{ start: 20n, end: 21n }] },
  ]);
  // 同一型の複数エントリ (異なる SetID) は置換後の状態として保持される
  assert.deepEqual(merged, [
    { type: "subgroup", setId: 0, ranges: [{ start: 10n, end: 11n }] },
    { type: "subgroup", setId: 1, ranges: [{ start: 20n, end: 21n }] },
  ]);
});

// ============================================================================
// validateRangeFilterSpecs
// draft-ietf-moq-transport-19 §5.1.3 (削除は REQUEST_UPDATE のみ / 0x29 のスコープ / 組み合わせ重複)
// ============================================================================

test("validateRangeFilterSpecs: undefined / 空配列は throw しない", () => {
  assert.doesNotThrow(() =>
    validateRangeFilterSpecs(undefined, "SUBSCRIBE", {
      allowRemove: false,
      allowTrackProperty: false,
    }),
  );
  assert.doesNotThrow(() =>
    validateRangeFilterSpecs([], "SUBSCRIBE", {
      allowRemove: false,
      allowTrackProperty: false,
    }),
  );
});

test("validateRangeFilterSpecs: allowRemove=false で削除を指定すると throw する", () => {
  assert.throws(
    () =>
      validateRangeFilterSpecs([{ type: "objectId", remove: true }], "SUBSCRIBE", {
        allowRemove: false,
        allowTrackProperty: false,
      }),
    /cannot remove range filters in SUBSCRIBE: remove is only allowed in REQUEST_UPDATE/,
  );
});

test("validateRangeFilterSpecs: allowRemove=true なら削除は許可される", () => {
  assert.doesNotThrow(() =>
    validateRangeFilterSpecs([{ type: "objectId", remove: true }], "REQUEST_UPDATE", {
      allowRemove: true,
      allowTrackProperty: false,
    }),
  );
});

test("validateRangeFilterSpecs: allowTrackProperty=false で 0x29 を指定すると throw する", () => {
  assert.throws(
    () =>
      validateRangeFilterSpecs(
        [{ type: "trackProperty", setId: 0, propertyType: 0x30n, ranges: [{ start: 1n }] }],
        "FETCH",
        { allowRemove: false, allowTrackProperty: false },
      ),
    /cannot send TRACK_PROPERTY_FILTER in FETCH: only allowed in SUBSCRIBE_TRACKS/,
  );
  // 削除エントリでも 0x29 は throw する
  assert.throws(
    () =>
      validateRangeFilterSpecs([{ type: "trackProperty", remove: true }], "FETCH", {
        allowRemove: false,
        allowTrackProperty: false,
      }),
    /cannot send TRACK_PROPERTY_FILTER in FETCH: only allowed in SUBSCRIBE_TRACKS/,
  );
});

test("validateRangeFilterSpecs: allowTrackProperty=true なら 0x29 は許可される", () => {
  assert.doesNotThrow(() =>
    validateRangeFilterSpecs(
      [{ type: "trackProperty", setId: 0, propertyType: 0x30n, ranges: [{ start: 1n }] }],
      "SUBSCRIBE_TRACKS",
      { allowRemove: false, allowTrackProperty: true },
    ),
  );
});

test("validateRangeFilterSpecs: 同一組み合わせの重複で throw する", () => {
  assert.throws(
    () =>
      validateRangeFilterSpecs(
        [
          { type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 1n }] },
          { type: "subgroup", setId: 0, ranges: [{ start: 2n, end: 3n }] },
        ],
        "SUBSCRIBE",
        { allowRemove: false, allowTrackProperty: false },
      ),
    /duplicate range filter combination in SUBSCRIBE: subgroup:0:/,
  );
});

test("validateRangeFilterSpecs: SetID 違いは重複にならない", () => {
  assert.doesNotThrow(() =>
    validateRangeFilterSpecs(
      [
        { type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 1n }] },
        { type: "subgroup", setId: 1, ranges: [{ start: 2n, end: 3n }] },
      ],
      "SUBSCRIBE",
      { allowRemove: false, allowTrackProperty: false },
    ),
  );
});

test("validateRangeFilterSpecs: Property Type 違いは重複にならない", () => {
  assert.doesNotThrow(() =>
    validateRangeFilterSpecs(
      [
        {
          type: "objectProperty",
          setId: 0,
          propertyType: 0x02n,
          ranges: [{ start: 1n }],
        },
        {
          type: "objectProperty",
          setId: 0,
          propertyType: 0x04n,
          ranges: [{ start: 1n }],
        },
      ],
      "SUBSCRIBE",
      { allowRemove: false, allowTrackProperty: false },
    ),
  );
});

test("validateRangeFilterSpecs: 同一 Property Type の重複で throw する", () => {
  assert.throws(
    () =>
      validateRangeFilterSpecs(
        [
          {
            type: "objectProperty",
            setId: 0,
            propertyType: 0x02n,
            ranges: [{ start: 1n }],
          },
          {
            type: "objectProperty",
            setId: 0,
            propertyType: 0x02n,
            ranges: [{ start: 2n }],
          },
        ],
        "SUBSCRIBE",
        { allowRemove: false, allowTrackProperty: false },
      ),
    /duplicate range filter combination in SUBSCRIBE: objectProperty:0:2/,
  );
});

test("validateRangeFilterSpecs: 削除エントリは重複判定の対象外", () => {
  assert.doesNotThrow(() =>
    validateRangeFilterSpecs(
      [
        { type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 1n }] },
        { type: "subgroup", remove: true },
      ],
      "REQUEST_UPDATE",
      { allowRemove: true, allowTrackProperty: false },
    ),
  );
});

// ============================================================================
// validateTrackNamespaceForSend
// draft-ietf-moq-transport-19 §3.2.1 (Reserved Namespaces) / §3.2.2 (.session)
// ============================================================================

test("validateTrackNamespaceForSend: 通常の namespace は throw しない", () => {
  assert.doesNotThrow(() => validateTrackNamespaceForSend(["live", "team"], "video"));
  assert.doesNotThrow(() => validateTrackNamespaceForSend(["example.com"]));
});

test("validateTrackNamespaceForSend: 空 namespace は throw しない", () => {
  // ゼロ要素 namespace は SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS で全対象を意味する
  assert.doesNotThrow(() => validateTrackNamespaceForSend([]));
});

test("validateTrackNamespaceForSend: .session namespace は throw する", () => {
  assert.throws(
    () => validateTrackNamespaceForSend([".session"], "track"),
    /session-level namespace \.session is reserved/,
  );
});

test("validateTrackNamespaceForSend: 予約 namespace の判定は先頭フィールドのみ", () => {
  // draft-ietf-moq-transport-19 §3.2.1: 判定は先頭フィールドのみ
  assert.doesNotThrow(() => validateTrackNamespaceForSend(["live", ".session"], "track"));
});

test("validateTrackNamespaceForSend: .session + 空 Track Name は DOES_NOT_EXIST で throw する", () => {
  assert.throws(
    () => validateTrackNamespaceForSend([".session"], ""),
    /does not exist \(DOES_NOT_EXIST\)/,
  );
});

test("validateTrackNamespaceForSend: . で始まる予約 namespace は throw する", () => {
  assert.throws(
    () => validateTrackNamespaceForSend([".foo"], "track"),
    /reserved namespace prefix \.foo is not allowed/,
  );
});

test("validateTrackNamespaceForSend: . 単体の namespace は throw する", () => {
  // draft-ietf-moq-transport-19 §3.2.1: "." 単体は MUST NOT be used for any purpose
  assert.throws(
    () => validateTrackNamespaceForSend(["."], "track"),
    /reserved namespace prefix \. is not allowed/,
  );
});

// ============================================================================
// compareLocations
// draft-ietf-moq-transport-19 §1.4.2 (Location Structure)
// ============================================================================

test("compareLocations: 同一 Location は 0 を返す", () => {
  assert.equal(compareLocations({ group: 1n, object: 2n }, { group: 1n, object: 2n }), 0);
});

test("compareLocations: Group が小さい方が負を返す", () => {
  assert.equal(compareLocations({ group: 1n, object: 9n }, { group: 2n, object: 0n }), -1);
  assert.equal(compareLocations({ group: 2n, object: 0n }, { group: 1n, object: 9n }), 1);
});

test("compareLocations: 同一 Group 内では Object で比較する", () => {
  assert.equal(compareLocations({ group: 1n, object: 1n }, { group: 1n, object: 2n }), -1);
  assert.equal(compareLocations({ group: 1n, object: 2n }, { group: 1n, object: 1n }), 1);
});

// ============================================================================
// validateFetchOkEndLocation
// ============================================================================

test("validateFetchOkEndLocation: End が Start 以上なら undefined", () => {
  assert.isUndefined(
    validateFetchOkEndLocation({ group: 0n, object: 0n }, { group: 0n, object: 0n }),
  );
  assert.isUndefined(
    validateFetchOkEndLocation({ group: 0n, object: 0n }, { group: 1n, object: 0n }),
  );
});

test("validateFetchOkEndLocation: End が Start 未満ならエラーメッセージを返す", () => {
  const message = validateFetchOkEndLocation({ group: 2n, object: 0n }, { group: 1n, object: 0n });
  assert.isDefined(message);
  assert.isTrue(message!.includes("is smaller than start location"));
});
