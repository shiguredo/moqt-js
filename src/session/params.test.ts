/**
 * src/session/params.ts の純粋関数テスト
 */

import { test, assert } from "vite-plus/test";
import {
  buildSubscribeParameters,
  buildSubscribeTracksParameters,
  buildFetchParameters,
  buildTrackStatusParameters,
  buildPublishTrackProperties,
  encodeAuthorizationTokenParameter,
  validateFetchOkEndLocation,
  resolveFillGroupOrder,
} from "./params";
import { InvalidFilterError } from "../error";
import { MAX_VARINT } from "../varint";
import { MessageParameterType, GroupOrder } from "../message/types";
import { TrackPropertyId } from "../properties";
import { isGreaseValue } from "../grease";
import {
  AuthorizationTokenAliasType,
  decodeAuthorizationToken,
} from "../message/authorizationToken";
import { useValueToken } from "../testSupport/helpers";

// ============================================================================
// AUTHORIZATION_TOKEN 付与（draft-ietf-moq-msf-01 §11.4.3）
// ============================================================================

// USE_VALUE スキームのトークン（draft-ietf-moq-transport-21 §8.9 Alias Type 0x3）
test("encodeAuthorizationTokenParameter: 0x03 パラメータを構築し round-trip する", () => {
  const param = encodeAuthorizationTokenParameter(useValueToken());
  assert.equal(param.type, MessageParameterType.AUTHORIZATION_TOKEN);

  const decoded = decodeAuthorizationToken(param.value);
  assert.equal(decoded.aliasType, AuthorizationTokenAliasType.USE_VALUE);
  if (decoded.aliasType === AuthorizationTokenAliasType.USE_VALUE) {
    assert.equal(new TextDecoder().decode(decoded.tokenValue), "scheme-token");
  }
});

// ============================================================================
// 0478: リクエスト種別ごとの送信可能パラメータ
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.20.9 (SUBSCRIBER PRIORITY Parameter):
 * "It MAY appear in a SUBSCRIBE, PUBLISH, FETCH, or REQUEST_UPDATE"。
 * FETCH でも送信できることを検証する。
 */
/**
 * draft-ietf-moq-transport-21 §9.20.9 (GROUP ORDER Parameter):
 * "It MAY appear in a SUBSCRIBE, PUBLISH, SUBSCRIBE_TRACKS, or FETCH"。
 * FETCH の応答順序を要求できることを検証する。
 */
test("buildFetchParameters: groupOrder が GROUP_ORDER パラメータになる", () => {
  const ascending = buildFetchParameters({ groupOrder: "Ascending" });
  assert.deepEqual(
    ascending.find((p) => p.type === MessageParameterType.GROUP_ORDER)?.value,
    new Uint8Array([0x01]),
  );

  const descending = buildFetchParameters({ groupOrder: "Descending" });
  assert.deepEqual(
    descending.find((p) => p.type === MessageParameterType.GROUP_ORDER)?.value,
    new Uint8Array([0x02]),
  );
});

test("buildFetchParameters: 不正な groupOrder で throw する", () => {
  assert.throws(
    () => buildFetchParameters({ groupOrder: "ascending" as never }),
    /GROUP_ORDER must be/,
  );
});

/**
 * draft-ietf-moq-transport-21 §9.18.1:
 * "Any Parameter that can be specified on a Subscription (ie: in SUBSCRIBE) is
 *  valid in SUBSCRIBE_TRACKS, unless otherwise specified."
 * "To join Tracks initiated via the resulting PUBLISHes, the subscriber can
 *  specify a Location Filter and optionally include FILL_PARAMETERS"
 */
test("buildSubscribeTracksParameters: subscriberPriority が SUBSCRIBER_PRIORITY パラメータになる", () => {
  const parameters = buildSubscribeTracksParameters({ subscriberPriority: 7 });
  const priority = parameters.find((p) => p.type === MessageParameterType.SUBSCRIBER_PRIORITY);

  assert.isDefined(priority);
  assert.deepEqual(priority?.value, new Uint8Array([7]));
});

// ============================================================================
// buildPublishTrackProperties (GREASE)
// draft-ietf-moq-transport-21 §13 (Grease) / §3.6 (Mandatory Track Properties)
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
    // §3.6 の Mandatory Track Property 範囲 0x4000-0x7FFF に落入しないこと
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
// draft-ietf-moq-transport-21 §9.18.1 / §4.3 / §3.3.2
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §3.3.2:
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

// ============================================================================
// buildSubscribeParameters / buildFetchParameters (送信ガード)
// draft-ietf-moq-transport-21 §3.3.1 / §3.3.2
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

/**
 * draft-ietf-moq-transport-21 §9.20.10 (LOCATION FILTER Parameter):
 * SUBSCRIBE 送信経路 (buildSubscribeParameters → encodeLocationFilterParameter)
 * でも End Group の 2^64-1 超過検証が効き、InvalidFilterError が throw される
 * ことを検証する。境界値 (ちょうど 2^64-1) は過剰拒否せず LOCATION_FILTER
 * パラメータとしてエンコードされる。
 */
test("buildSubscribeParameters: 3 フィールドの End Group が 2^64-1 を超えると InvalidFilterError", () => {
  assert.throws(
    () =>
      buildSubscribeParameters({
        filter: {
          startGroup: MAX_VARINT,
          startObject: 0n,
          endGroupDelta: 1n,
        },
      }),
    InvalidFilterError,
  );
});

test("buildSubscribeParameters: 3 フィールドの End Group がちょうど 2^64-1 は LOCATION_FILTER になる", () => {
  const parameters = buildSubscribeParameters({
    filter: {
      startGroup: MAX_VARINT - 1n,
      startObject: 0n,
      endGroupDelta: 1n,
    },
  });
  assert.isDefined(parameters.find((p) => p.type === MessageParameterType.LOCATION_FILTER));
});

test("buildFetchParameters: 3 フィールドの End Group が 2^64-1 を超えると InvalidFilterError", () => {
  assert.throws(
    () =>
      buildFetchParameters({
        filter: {
          startGroup: MAX_VARINT,
          startObject: 0n,
          endGroupDelta: 1n,
        },
      }),
    InvalidFilterError,
  );
});

test("buildFetchParameters: 削除指定で throw する", () => {
  assert.throws(
    () =>
      buildFetchParameters({
        rangeFilters: [{ type: "objectId", remove: true }],
      }),
    /cannot remove range filters in FETCH/,
  );
});

test("buildFetchParameters: TRACK_PROPERTY_FILTER で throw する", () => {
  assert.throws(
    () =>
      buildFetchParameters({
        rangeFilters: [
          { type: "trackProperty", setId: 0, propertyType: 0x30n, ranges: [{ start: 1n }] },
        ],
      }),
    /cannot send TRACK_PROPERTY_FILTER in FETCH/,
  );
});

// ============================================================================
// validateFetchOkEndLocation
// ============================================================================

test("validateFetchOkEndLocation: End が Start 未満ならエラーメッセージを返す", () => {
  const message = validateFetchOkEndLocation({ group: 2n, object: 0n }, { group: 1n, object: 0n });
  assert.isDefined(message);
  assert.isTrue(message!.includes("is smaller than start location"));
});

// ============================================================================
// buildFillParameters / FILL_PARAMETERS
// draft-ietf-moq-transport-21 §3.4 / §9.20.16
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §9.20.10 / §9.20.16:
 * fill 内の LOCATION_FILTER が End Group 超過の場合は送信前に throw する。
 */
test("buildSubscribeParameters: fill 内の LOCATION_FILTER が End Group 超過の場合は throw する", () => {
  let thrown: Error | undefined;
  try {
    buildSubscribeParameters({
      fill: {
        filter: { startGroup: MAX_VARINT, startObject: 0n, endGroupDelta: 1n },
      },
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.instanceOf(thrown, InvalidFilterError);
});

/**
 * draft-ietf-moq-transport-21 §9.20.9:
 * fill 内の GROUP_ORDER が不正値の場合は送信前に throw する。
 */
test("buildSubscribeParameters: fill 内の GROUP_ORDER が不正値の場合は throw する", () => {
  let thrown: Error | undefined;
  try {
    buildSubscribeParameters({
      fill: {
        groupOrder: "Sideways" as unknown as "Ascending",
      },
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("GROUP_ORDER"));
});

/**
 * draft-ietf-moq-transport-21 §3.4 / §9.20.16:
 * fill の Group Order 解決は FILL 内の指定を優先し、無ければ subscription の
 * 値を継承し、どちらも無ければ Ascending になることを検証する。
 */
test("resolveFillGroupOrder: fill・subscription・既定値の優先順位で解決する", () => {
  // FILL 内の指定が最優先
  assert.equal(resolveFillGroupOrder("Descending", "Ascending"), GroupOrder.DESCENDING);
  assert.equal(resolveFillGroupOrder("Ascending", "Descending"), GroupOrder.ASCENDING);
  // FILL 省略時は subscription の値を継承する
  assert.equal(resolveFillGroupOrder(undefined, "Descending"), GroupOrder.DESCENDING);
  assert.equal(resolveFillGroupOrder(undefined, "Ascending"), GroupOrder.ASCENDING);
  // どちらも省略時は Ascending (対向既定は不明のため FETCH 既定と同一)
  assert.equal(resolveFillGroupOrder(undefined, undefined), GroupOrder.ASCENDING);
});

/**
 * draft-ietf-moq-transport-21 §9.20.22:
 * SUBSCRIBE / TRACK_STATUS / FETCH / SUBSCRIBE_TRACKS から
 * INCLUDE_PROPERTIES を送れることを検証する。true は 1、false は 0 になる。
 */
test("buildSubscribeParameters: includeProperties が INCLUDE_PROPERTIES になる", () => {
  const truthy = buildSubscribeParameters({ includeProperties: true });
  const truthyParam = truthy.find((p) => p.type === MessageParameterType.INCLUDE_PROPERTIES);
  assert.isDefined(truthyParam);
  assert.deepEqual(truthyParam!.value, new Uint8Array([1]));

  const falsy = buildSubscribeParameters({ includeProperties: false });
  const falsyParam = falsy.find((p) => p.type === MessageParameterType.INCLUDE_PROPERTIES);
  assert.isDefined(falsyParam);
  assert.deepEqual(falsyParam!.value, new Uint8Array([0]));
});

/**
 * draft-ietf-moq-transport-21 §9.20.22:
 * FETCH から INCLUDE_PROPERTIES を送れることを検証する。
 * true / false / 省略の 3 状態を網羅する。
 */
test("buildFetchParameters: includeProperties が INCLUDE_PROPERTIES になる", () => {
  const falsy = buildFetchParameters({
    filter: { startGroup: 0n, startObject: 0n },
    includeProperties: false,
  });
  const falsyParam = falsy.find((p) => p.type === MessageParameterType.INCLUDE_PROPERTIES);
  assert.isDefined(falsyParam);
  assert.deepEqual(falsyParam!.value, new Uint8Array([0]));

  const truthy = buildFetchParameters({
    filter: { startGroup: 0n, startObject: 0n },
    includeProperties: true,
  });
  const truthyParam = truthy.find((p) => p.type === MessageParameterType.INCLUDE_PROPERTIES);
  assert.isDefined(truthyParam);
  assert.deepEqual(truthyParam!.value, new Uint8Array([1]));

  const omitted = buildFetchParameters({ filter: { startGroup: 0n, startObject: 0n } });
  assert.isUndefined(omitted.find((p) => p.type === MessageParameterType.INCLUDE_PROPERTIES));
});

/**
 * draft-ietf-moq-transport-21 §9.20.22:
 * SUBSCRIBE_TRACKS から INCLUDE_PROPERTIES を送れることを検証する。
 * true / false / 省略の 3 状態を網羅する。
 */
test("buildSubscribeTracksParameters: includeProperties が INCLUDE_PROPERTIES になる", () => {
  const truthy = buildSubscribeTracksParameters({ includeProperties: true });
  const truthyParam = truthy.find((p) => p.type === MessageParameterType.INCLUDE_PROPERTIES);
  assert.isDefined(truthyParam);
  assert.deepEqual(truthyParam!.value, new Uint8Array([1]));

  const falsy = buildSubscribeTracksParameters({ includeProperties: false });
  const falsyParam = falsy.find((p) => p.type === MessageParameterType.INCLUDE_PROPERTIES);
  assert.isDefined(falsyParam);
  assert.deepEqual(falsyParam!.value, new Uint8Array([0]));

  const omitted = buildSubscribeTracksParameters({});
  assert.isUndefined(omitted.find((p) => p.type === MessageParameterType.INCLUDE_PROPERTIES));
});

/**
 * draft-ietf-moq-transport-21 §9.20.22:
 * TRACK_STATUS から INCLUDE_PROPERTIES を送れることを検証する。
 * true / false / 省略の 3 状態を網羅する。
 */
test("buildTrackStatusParameters: includeProperties が INCLUDE_PROPERTIES になる", () => {
  const truthy = buildTrackStatusParameters({ includeProperties: true });
  assert.deepEqual(
    truthy.find((p) => p.type === MessageParameterType.INCLUDE_PROPERTIES)?.value,
    new Uint8Array([1]),
  );
  const falsy = buildTrackStatusParameters({ includeProperties: false });
  assert.deepEqual(
    falsy.find((p) => p.type === MessageParameterType.INCLUDE_PROPERTIES)?.value,
    new Uint8Array([0]),
  );
  const omitted = buildTrackStatusParameters({});
  assert.isUndefined(omitted.find((p) => p.type === MessageParameterType.INCLUDE_PROPERTIES));
});
