/**
 * src/session/params.ts の純粋関数テスト
 */

import { test, assert } from "vite-plus/test";
import {
  buildSubscribeParameters,
  buildSubscribeTracksParameters,
  buildFetchParameters,
  buildFillParameters,
  buildPublishParameters,
  buildTrackStatusParameters,
  buildPublishTrackProperties,
  encodeAuthorizationTokenParameter,
  resolveFetchRequestRange,
  resolveFetchResponseEndLocation,
  resolveFillGroupOrder,
  resolveFillGroupOrderFromParameters,
  extractNewGroupRequest,
  matchNamespacePrefix,
  validateTrackNamespaceForSend,
} from "./params";
import { InvalidFilterError, ProtocolViolationError } from "../error";
import { decodeFillParameters, encodeLocationFilterParameter } from "../message/parameter";
import { MAX_VARINT, encodeVarint } from "../varint";
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

// USE_VALUE スキームのトークン（draft-ietf-moq-transport-23 §8.9 Alias Type 0x3）
test("encodeAuthorizationTokenParameter: 0x03 パラメータを構築し round-trip する", () => {
  const param = encodeAuthorizationTokenParameter(useValueToken());
  assert.equal(param.type, MessageParameterType.AUTHORIZATION_TOKEN);

  const decoded = decodeAuthorizationToken(param.value);
  assert.equal(decoded.aliasType, AuthorizationTokenAliasType.USE_VALUE);
  if (decoded.aliasType === AuthorizationTokenAliasType.USE_VALUE) {
    assert.equal(new TextDecoder().decode(decoded.tokenValue), "scheme-token");
  }
});

// draft-ietf-moq-msf-01 §11.4.3: publisher は track に紐づくトークンを PUBLISH へ MUST 付与する。
// draft-ietf-moq-transport-23 §9.19.2: AUTHORIZATION TOKEN は PUBLISH に出現できる。
test("buildPublishParameters: authorizationToken が AUTHORIZATION_TOKEN パラメータになる", () => {
  const token = useValueToken();
  const parameters = buildPublishParameters({ authorizationToken: token });

  const param = parameters.find((p) => p.type === MessageParameterType.AUTHORIZATION_TOKEN);
  assert.isDefined(param);
  assert.deepEqual(decodeAuthorizationToken(param?.value ?? new Uint8Array()), token);
});

// トークンを渡していない場合は AUTHORIZATION TOKEN パラメータを送らない
test("buildPublishParameters: authorizationToken 省略時は AUTHORIZATION_TOKEN を送らない", () => {
  const parameters = buildPublishParameters({});

  assert.isUndefined(parameters.find((p) => p.type === MessageParameterType.AUTHORIZATION_TOKEN));
});

// ============================================================================
// 0478: リクエスト種別ごとの送信可能パラメータ
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §9.19.7 (SUBSCRIBER PRIORITY Parameter):
 * "It MAY appear in a SUBSCRIBE, PUBLISH, SUBSCRIBE_TRACKS, FETCH, or
 *  REQUEST_UPDATE (for a subscription or FETCH)"。
 * FETCH でも送信できることを検証する。
 */
/**
 * draft-ietf-moq-transport-23 §9.19.8 (GROUP ORDER Parameter):
 * "It MAY appear in a SUBSCRIBE, PUBLISH, SUBSCRIBE_TRACKS, or FETCH, or
 *  inside a FILL_PARAMETERS parameter (see Section 9.19.15)"。
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
 * draft-ietf-moq-transport-23 §9.17 (SUBSCRIBE_TRACKS) / §3.6.2:
 * SUBSCRIBE_TRACKS の許可一覧のうち、単一 Track 専用の RENDEZVOUS_TIMEOUT /
 * NEW_GROUP_REQUEST を除く初期購読条件をすべて送る。未指定時は既定値を変えない
 * (空の Parameters を送る)。
 */
test("buildSubscribeTracksParameters: §9.17 の初期購読条件をすべて送る", () => {
  const parameters = buildSubscribeTracksParameters({
    filter: { startGroup: 10n, startObject: 2n },
    deliveryTimeout: 5000n,
    subgroupDeliveryTimeout: 3000n,
    subscriberPriority: 7,
    groupOrder: "Descending",
    paused: true,
    rangeFilters: [
      {
        type: "trackProperty",
        setId: 0,
        propertyType: 0x20n,
        ranges: [{ start: 100n, end: 100n }],
      },
    ],
    fill: {
      filter: { startGroup: 1n },
      rangeFilters: [{ type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 1n }] }],
    },
    includeProperties: true,
    authorizationToken: useValueToken(),
  });

  const types = parameters.map((parameter) => parameter.type);
  for (const type of [
    MessageParameterType.OBJECT_DELIVERY_TIMEOUT,
    MessageParameterType.SUBGROUP_DELIVERY_TIMEOUT,
    MessageParameterType.SUBSCRIBER_PRIORITY,
    MessageParameterType.LOCATION_FILTER,
    MessageParameterType.GROUP_ORDER,
    MessageParameterType.PAUSED,
    MessageParameterType.TRACK_PROPERTY_FILTER,
    MessageParameterType.FILL_PARAMETERS,
    MessageParameterType.INCLUDE_PROPERTIES,
    MessageParameterType.AUTHORIZATION_TOKEN,
  ]) {
    assert.include(types, type);
  }
  // 単一 Track 専用の RENDEZVOUS_TIMEOUT / NEW_GROUP_REQUEST は送らない
  assert.notInclude(types, MessageParameterType.RENDEZVOUS_TIMEOUT);
  assert.notInclude(types, MessageParameterType.NEW_GROUP_REQUEST);

  // 各初期条件の値をワイヤで確認する
  const valueOf = (type: number): Uint8Array | undefined =>
    parameters.find((parameter) => parameter.type === type)?.value;
  assert.deepEqual(valueOf(MessageParameterType.OBJECT_DELIVERY_TIMEOUT), encodeVarint(5000n));
  assert.deepEqual(valueOf(MessageParameterType.SUBGROUP_DELIVERY_TIMEOUT), encodeVarint(3000n));
  assert.deepEqual(valueOf(MessageParameterType.SUBSCRIBER_PRIORITY), new Uint8Array([7]));
  assert.deepEqual(valueOf(MessageParameterType.GROUP_ORDER), new Uint8Array([0x02]));
  assert.deepEqual(valueOf(MessageParameterType.PAUSED), new Uint8Array([1]));
  assert.deepEqual(valueOf(MessageParameterType.INCLUDE_PROPERTIES), new Uint8Array([1]));
  assert.deepEqual(
    valueOf(MessageParameterType.LOCATION_FILTER),
    encodeLocationFilterParameter({ startGroup: 10n, startObject: 2n }).value,
  );

  // FILL_PARAMETERS の内側に fill の LOCATION_FILTER と Range Filter が載る
  const fillValue = valueOf(MessageParameterType.FILL_PARAMETERS);
  assert.isDefined(fillValue);
  const innerTypes = decodeFillParameters({
    type: MessageParameterType.FILL_PARAMETERS,
    value: fillValue!,
  }).map((parameter) => parameter.type);
  assert.deepEqual(innerTypes, [
    MessageParameterType.LOCATION_FILTER,
    MessageParameterType.SUBGROUP_FILTER,
  ]);

  // 未指定時は既定値を変えない (パラメータを送らない)
  assert.deepEqual(buildSubscribeTracksParameters({}), []);
  assert.deepEqual(buildSubscribeTracksParameters({ paused: false }), []);
});

// ============================================================================
// buildPublishTrackProperties (GREASE)
// draft-ietf-moq-transport-23 §13 (Grease) / §3.7 (Mandatory to Understand Track Properties)
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
// draft-ietf-moq-transport-23 §3.6.2 / §3.6.1 / §3.3.2
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §3.3.2:
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
// draft-ietf-moq-transport-23 §3.3.1 / §3.3.2
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
 * draft-ietf-moq-transport-23 §9.19.9 (LOCATION FILTER Parameter):
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

/**
 * draft-ietf-moq-transport-23 §3.2 (Fetch):
 * 相対指定 (0x01) と Next Object (0x05) は FETCH の範囲を表さないため、
 * buildFetchParameters でも送信前に InvalidFilterError で拒否する
 * (公開送信 API の検証に加えた多層防御)。
 */
test("buildFetchParameters: 相対指定と Next Object の filter で InvalidFilterError", () => {
  assert.throws(() => buildFetchParameters({ filter: { startGroup: 1n } }), InvalidFilterError);
  assert.throws(() => buildFetchParameters({ filter: { nextObject: true } }), InvalidFilterError);
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
// resolveFetchRequestRange / resolveFetchResponseEndLocation
// draft-ietf-moq-transport-23 §3.2 (Fetch) / §9.19.9 (LOCATION FILTER)
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §3.2 / §9.19.9:
 * 同一 Group で End Object が Start Object より小さい空範囲は、応答の終端が
 * 要求 Start より前になり得るため送信前に拒否する。
 */
test("resolveFetchRequestRange: 同一 Group で End < Start の範囲は拒否する", () => {
  assert.throws(
    () =>
      resolveFetchRequestRange({
        startGroup: 3n,
        startObject: 5n,
        endGroupDelta: 0n,
        endObject: 4n,
      }),
    InvalidFilterError,
  );
  // Group が異なる場合は End Object が Start Object より小さくても有効
  const acrossGroups = resolveFetchRequestRange({
    startGroup: 3n,
    startObject: 5n,
    endGroupDelta: 1n,
    endObject: 4n,
  });
  assert.deepEqual(acrossGroups.endLocation, { group: 4n, object: 4n });
});

/**
 * draft-ietf-moq-transport-23 §9.19.9 (Table 6):
 * フィルタ省略と 0x00 (None) は {0, 0} から Largest Object までの要求になり、
 * 要求 End Location は応答の LARGEST_OBJECT で決まるため要求側では確定しない。
 */
test("resolveFetchRequestRange: フィルタ省略と 0x00 は開端の範囲になる", () => {
  const expected = {
    startLocation: { group: 0n, object: 0n },
    endLocation: undefined,
  };
  assert.deepEqual(resolveFetchRequestRange(undefined), expected);
  assert.deepEqual(resolveFetchRequestRange({ reset: true }), expected);
});

/**
 * draft-ietf-moq-transport-23 §9.19.9 (Table 6):
 * 0x02 (Absolute Start) は開始だけが絶対で終端は Largest Object、
 * 0x03 (Absolute Start, Group End) は End Group 全体、
 * 0x04 (Absolute Range) は EndObject までを範囲にする。
 */
test("resolveFetchRequestRange: 絶対指定の Start / End を確定する", () => {
  assert.deepEqual(resolveFetchRequestRange({ startGroup: 5n, startObject: 3n }), {
    startLocation: { group: 5n, object: 3n },
    endLocation: undefined,
  });
  // 0x03: End Object は End Group の最終 Object を表す 2^64-1 に正規化する
  assert.deepEqual(
    resolveFetchRequestRange({ startGroup: 5n, startObject: 3n, endGroupDelta: 2n }),
    {
      startLocation: { group: 5n, object: 3n },
      endLocation: { group: 7n, object: MAX_VARINT },
    },
  );
  assert.deepEqual(
    resolveFetchRequestRange({
      startGroup: 5n,
      startObject: 3n,
      endGroupDelta: 2n,
      endObject: 9n,
    }),
    {
      startLocation: { group: 5n, object: 3n },
      endLocation: { group: 7n, object: 9n },
    },
  );
});

/**
 * draft-ietf-moq-transport-23 §3.2 (Fetch):
 * "If the Location filter is relative (see Section 9.19.9), the publisher MUST
 *  return REQUEST_ERROR with error code INVALID_RANGE."
 * 公開送信 API は応答を待たずに送信前で拒否する。Next Object (0x05) も既存
 * Object の範囲を指さないため拒否する。
 */
test("resolveFetchRequestRange: 相対指定と Next Object は InvalidFilterError", () => {
  assert.throws(() => resolveFetchRequestRange({ startGroup: 1n }), InvalidFilterError);
  assert.throws(() => resolveFetchRequestRange({ nextObject: true }), InvalidFilterError);
});

/**
 * draft-ietf-moq-transport-23 §9.19.9:
 * StartGroup + EndGroupDelta が 2^64-1 を超えるフィルタはエンコード前に
 * 拒否する (送信側のローカル検証)。
 */
test("resolveFetchRequestRange: End Group が 2^64-1 を超えると InvalidFilterError", () => {
  assert.throws(
    () => resolveFetchRequestRange({ startGroup: MAX_VARINT, startObject: 0n, endGroupDelta: 1n }),
    InvalidFilterError,
  );
});

/**
 * draft-ietf-moq-transport-23 §3.2 (Fetch):
 * "If Largest Object is within the requested range, the FETCH response ends at
 *  Largest Object ... Otherwise, the response ends at the requested End Location."
 */
test("resolveFetchResponseEndLocation: Largest Object が要求範囲内ならその位置で終わる", () => {
  const requestRange = resolveFetchRequestRange({
    startGroup: 2n,
    startObject: 0n,
    endGroupDelta: 3n,
    endObject: 4n,
  });
  const result = resolveFetchResponseEndLocation(requestRange, { group: 3n, object: 1n });
  assert.equal(result.status, "resolved");
  if (result.status === "resolved") {
    assert.deepEqual(result.endLocation, { group: 3n, object: 1n });
  }
});

test("resolveFetchResponseEndLocation: Largest Object が要求範囲外なら要求 End で終わる", () => {
  const requestRange = resolveFetchRequestRange({
    startGroup: 2n,
    startObject: 0n,
    endGroupDelta: 3n,
    endObject: 4n,
  });
  // 要求 End より後にある Largest Object
  const beyond = resolveFetchResponseEndLocation(requestRange, { group: 6n, object: 0n });
  assert.equal(beyond.status, "resolved");
  if (beyond.status === "resolved") {
    assert.deepEqual(beyond.endLocation, { group: 5n, object: 4n });
  }
  // 要求 Start より前にある Largest Object は §3.2 の INVALID_RANGE 対象であり、
  // 成功応答としては受理しない
  const before = resolveFetchResponseEndLocation(requestRange, { group: 1n, object: 9n });
  assert.equal(before.status, "protocol-violation");
});

test("resolveFetchResponseEndLocation: 1 Object の範囲は Start == End == Largest Object になる", () => {
  const requestRange = resolveFetchRequestRange({
    startGroup: 5n,
    startObject: 3n,
    endGroupDelta: 0n,
    endObject: 3n,
  });
  const result = resolveFetchResponseEndLocation(requestRange, { group: 5n, object: 3n });
  assert.equal(result.status, "resolved");
  if (result.status === "resolved") {
    assert.deepEqual(result.endLocation, { group: 5n, object: 3n });
  }
});

/**
 * draft-ietf-moq-transport-23 §9.19.17 (LARGEST_OBJECT):
 * 開端の要求では要求 End Location が Largest Object そのものであるため、
 * LARGEST_OBJECT を欠く成功応答は終端を確定できずプロトコル違反になる。
 */
test("resolveFetchResponseEndLocation: 開端の要求で LARGEST_OBJECT が無ければ protocol-violation", () => {
  const openEnded = resolveFetchRequestRange({ startGroup: 0n, startObject: 0n });
  const result = resolveFetchResponseEndLocation(openEnded, undefined);
  assert.equal(result.status, "protocol-violation");
  if (result.status === "protocol-violation") {
    assert.isTrue(result.reason.includes("LARGEST_OBJECT"));
  }
  // 開端の要求では Largest Object をそのまま終端にする
  const resolved = resolveFetchResponseEndLocation(openEnded, { group: 9n, object: 2n });
  assert.equal(resolved.status, "resolved");
  if (resolved.status === "resolved") {
    assert.deepEqual(resolved.endLocation, { group: 9n, object: 2n });
  }
});

/**
 * draft-ietf-moq-transport-23 §3.2 (Fetch):
 * 閉端の要求 (0x03 / 0x04) で LARGEST_OBJECT が無い成功応答は、応答が要求 End で
 * 終わる (otherwise) ものとして要求 End を採用する。0x03 の要求 End は
 * {StartGroup + EndGroupDelta, 2^64-1} であり、Group 全体を含む境界値である。
 */
test("resolveFetchResponseEndLocation: 閉端の要求で LARGEST_OBJECT が無ければ要求 End を採用する", () => {
  const groupEnd = resolveFetchRequestRange({
    startGroup: 2n,
    startObject: 0n,
    endGroupDelta: 2n,
  });
  const fromGroupEnd = resolveFetchResponseEndLocation(groupEnd, undefined);
  assert.equal(fromGroupEnd.status, "resolved");
  if (fromGroupEnd.status === "resolved") {
    assert.deepEqual(fromGroupEnd.endLocation, { group: 4n, object: MAX_VARINT });
  }

  const absoluteRange = resolveFetchRequestRange({
    startGroup: 2n,
    startObject: 0n,
    endGroupDelta: 1n,
    endObject: 7n,
  });
  const fromRange = resolveFetchResponseEndLocation(absoluteRange, undefined);
  assert.equal(fromRange.status, "resolved");
  if (fromRange.status === "resolved") {
    assert.deepEqual(fromRange.endLocation, { group: 3n, object: 7n });
  }
});

// ============================================================================
// buildFillParameters / FILL_PARAMETERS
// draft-ietf-moq-transport-23 §3.4 / §9.19.15
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §9.19.9 / §9.19.15:
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
 * draft-ietf-moq-transport-23 §9.19.8:
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
 * draft-ietf-moq-transport-23 §3.4 / §9.19.8 / §9.19.15 / §10.5:
 * fill の Group Order 解決は FILL 内側の指定を最優先し、無ければメッセージの
 * GROUP_ORDER、無ければ Track Properties の DEFAULT_PUBLISHER_GROUP_ORDER を
 * 使い、すべて無ければ Ascending になることを検証する。
 */
test("resolveFillGroupOrder: fill・メッセージ・Track Property・既定値の優先順位で解決する", () => {
  const descendingTrackProperties = [
    { id: TrackPropertyId.DEFAULT_PUBLISHER_GROUP_ORDER, value: 0x02n },
  ];
  const ascendingTrackProperties = [
    { id: TrackPropertyId.DEFAULT_PUBLISHER_GROUP_ORDER, value: 0x01n },
  ];

  // FILL 内の指定が最優先 (Track Property が Ascending でも FILL の Descending)
  assert.equal(
    resolveFillGroupOrder("Descending", "Ascending", ascendingTrackProperties),
    GroupOrder.DESCENDING,
  );
  assert.equal(
    resolveFillGroupOrder("Ascending", "Descending", descendingTrackProperties),
    GroupOrder.ASCENDING,
  );
  // FILL 省略時はメッセージの GROUP_ORDER (Track Property より優先)
  assert.equal(
    resolveFillGroupOrder(undefined, "Descending", ascendingTrackProperties),
    GroupOrder.DESCENDING,
  );
  assert.equal(
    resolveFillGroupOrder(undefined, "Ascending", descendingTrackProperties),
    GroupOrder.ASCENDING,
  );
  // メッセージも省略時は Track Property の DEFAULT_PUBLISHER_GROUP_ORDER
  assert.equal(
    resolveFillGroupOrder(undefined, undefined, descendingTrackProperties),
    GroupOrder.DESCENDING,
  );
  assert.equal(
    resolveFillGroupOrder(undefined, undefined, ascendingTrackProperties),
    GroupOrder.ASCENDING,
  );
  // Track Properties も無い場合は Ascending (§10.5 の省略時)
  assert.equal(resolveFillGroupOrder(undefined, undefined, undefined), GroupOrder.ASCENDING);
  assert.equal(resolveFillGroupOrder(undefined, undefined, []), GroupOrder.ASCENDING);
});

/**
 * draft-ietf-moq-transport-23 §9.19.8 / §9.19.15 / §10.5:
 * FILL_PARAMETERS の内側 Parameters 列から解決する経路も、内側の GROUP_ORDER を
 * 最優先し、無ければ購読の GROUP_ORDER、Track Properties、
 * Ascending の順で解決する。受信 PUBLISH と REQUEST_UPDATE がこの経路を使う。
 */
test("resolveFillGroupOrderFromParameters: 内側の GROUP_ORDER と Track Property を優先順位どおり解決する", () => {
  const descendingFillParameter = {
    type: MessageParameterType.GROUP_ORDER,
    value: new Uint8Array([0x02]),
  };
  const descendingTrackProperties = [
    { id: TrackPropertyId.DEFAULT_PUBLISHER_GROUP_ORDER, value: 0x02n },
  ];

  // 内側の GROUP_ORDER が最優先 (購読と Track Property が Ascending でも Descending)
  assert.equal(
    resolveFillGroupOrderFromParameters([descendingFillParameter], "Ascending", [
      { id: TrackPropertyId.DEFAULT_PUBLISHER_GROUP_ORDER, value: 0x01n },
    ]),
    GroupOrder.DESCENDING,
  );
  // 内側が無ければ購読の GROUP_ORDER (Track Property より優先)
  assert.equal(
    resolveFillGroupOrderFromParameters([], "Ascending", descendingTrackProperties),
    GroupOrder.ASCENDING,
  );
  // 購読の GROUP_ORDER も無ければ Track Property
  assert.equal(
    resolveFillGroupOrderFromParameters([], undefined, descendingTrackProperties),
    GroupOrder.DESCENDING,
  );
  // すべて無ければ Ascending
  assert.equal(resolveFillGroupOrderFromParameters([], undefined, undefined), GroupOrder.ASCENDING);
});

/**
 * draft-ietf-moq-transport-23 §9.19.22:
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
 * draft-ietf-moq-transport-23 §9.19.22:
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
 * draft-ietf-moq-transport-23 §9.19.22:
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
 * draft-ietf-moq-transport-23 §9.19.22:
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

/**
 * draft-ietf-moq-transport-23 §9.19.19 (NEW GROUP REQUEST Parameter):
 * "The NEW_GROUP_REQUEST parameter (Parameter Type 0x32) is a varint."
 * 値は varint 1 つである。パラメータが無ければ undefined、値 0 はそのまま 0 を返す。
 * 読み切れない値と、varint の後ろに余りのある値は MALFORMED_MESSAGE にする。
 * 読み取りの往復は params.prop.ts が任意の値で確かめる
 */
test("extractNewGroupRequest: varint の値を返し、無ければ undefined、不正な値は ProtocolViolationError", () => {
  assert.isUndefined(extractNewGroupRequest([]));
  assert.isUndefined(
    extractNewGroupRequest([{ type: MessageParameterType.PAUSED, value: new Uint8Array([1]) }]),
  );
  assert.equal(
    extractNewGroupRequest([
      { type: MessageParameterType.NEW_GROUP_REQUEST, value: encodeVarint(0n) },
    ]),
    0n,
  );
  assert.equal(
    extractNewGroupRequest([
      { type: MessageParameterType.NEW_GROUP_REQUEST, value: encodeVarint(1_790_294_740_225n) },
    ]),
    1_790_294_740_225n,
  );
  // 空の値は varint として読めない
  assert.throws(
    () =>
      extractNewGroupRequest([
        { type: MessageParameterType.NEW_GROUP_REQUEST, value: new Uint8Array() },
      ]),
    ProtocolViolationError,
  );
  // varint の後ろに余りがある
  const trailing = new Uint8Array([...encodeVarint(5n), 0x00]);
  assert.throws(
    () =>
      extractNewGroupRequest([{ type: MessageParameterType.NEW_GROUP_REQUEST, value: trailing }]),
    ProtocolViolationError,
  );
});

// ============================================================================
// PAUSED (draft-ietf-moq-transport-23 §9.19.18)
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §9.19.18:
 * PAUSED は 0 = unpaused / 1 = paused で、省略時の既定値は 0。
 * SUBSCRIBE / PUBLISH / SUBSCRIBE_TRACKS の builder は paused 指定時のみ
 * PAUSED=1 を載せ、false の明示と省略では載せない。
 */
test("buildSubscribeParameters / buildPublishParameters / buildSubscribeTracksParameters: PAUSED のワイヤ値", () => {
  const builders = [
    buildSubscribeParameters,
    buildPublishParameters,
    buildSubscribeTracksParameters,
  ];
  for (const build of builders) {
    const pausedValueOf = (options: { paused?: boolean }): Uint8Array | undefined =>
      build(options).find((parameter) => parameter.type === MessageParameterType.PAUSED)?.value;

    assert.deepEqual(pausedValueOf({ paused: true }), new Uint8Array([1]));
    assert.isUndefined(pausedValueOf({ paused: false }));
    assert.isUndefined(pausedValueOf({}));
  }
});

/**
 * draft-ietf-moq-transport-23 §9.19.9 / §3.4:
 * FILL_PARAMETERS の内側には Type 0x00 (None) と Type 0x05 (Next Object) の
 * どちらも載せられる。ワイヤ上は Type のみの 1 バイトになる。
 */
test("buildFillParameters: reset (0x00) と Next Object (0x05) を内側に載せる", () => {
  const resetInner = buildFillParameters({ filter: { reset: true } }, "SUBSCRIBE");
  assert.deepEqual(
    resetInner.map((param) => param.type),
    [MessageParameterType.LOCATION_FILTER],
  );
  assert.deepEqual(resetInner[0]!.value, new Uint8Array([0x00]));

  const nextObjectInner = buildFillParameters({ filter: { nextObject: true } }, "SUBSCRIBE");
  assert.deepEqual(
    nextObjectInner.map((param) => param.type),
    [MessageParameterType.LOCATION_FILTER],
  );
  assert.deepEqual(nextObjectInner[0]!.value, new Uint8Array([0x05]));
});

// ============================================================================
// matchNamespacePrefix
// draft-ietf-moq-transport-23 §2.4.2 (Namespace Prefix Matching) / §3.6
// ============================================================================

// §2.4.2 の例をそのまま固定する。直列化した名前は §8.8 の形式であり、
// "foo-bar--x" は名前空間 (foo, bar) と Track 名 x、"example.2ecom-123" は
// 名前空間 (example.com, 123) を表す (.2e は "." の 16 進表記)
test("matchNamespacePrefix: §2.4.2 の例どおりフィールド単位で前方一致する", () => {
  // Full Track Name foo-bar--x の名前空間 (foo, bar) は prefix (foo) と (foo, bar) に一致する
  assert.deepEqual(matchNamespacePrefix(["foo", "bar"], ["foo"]), ["bar"]);
  assert.deepEqual(matchNamespacePrefix(["foo", "bar"], ["foo", "bar"]), []);
  // フィールド単位の完全一致であるため、文字列の前方一致ではない。foobar には一致しない
  assert.isNull(matchNamespacePrefix(["foo", "bar"], ["foobar"]));
  // prefix (example.com, 123) は (example.com, 123, 100) と (example.com, 123, 200) に一致する
  assert.deepEqual(matchNamespacePrefix(["example.com", "123", "100"], ["example.com", "123"]), [
    "100",
  ]);
  assert.deepEqual(matchNamespacePrefix(["example.com", "123", "200"], ["example.com", "123"]), [
    "200",
  ]);
  // 先頭フィールドが異なれば一致しない
  assert.isNull(matchNamespacePrefix(["example.com", "123", "100"], ["example.net", "123"]));
  // prefix の方が長ければ一致しない
  assert.isNull(matchNamespacePrefix(["foo", "bar"], ["foo", "bar", "x"]));
  // 空の prefix はすべての名前空間に一致する (§3.6: 0 フィールドの prefix は全 Track)
  assert.deepEqual(matchNamespacePrefix(["foo", "bar"], []), ["foo", "bar"]);
});

// ============================================================================
// Track Namespace 送信検証（draft-ietf-moq-transport-23 §8.7 / §2.4.3 / §6.5）
// ============================================================================

// §8.7 の構造の制約は送信時のエンコードと同じ実装で判定する。境界値 (32/33 フィールド、
// 4,096/4,097 バイト) の throw する / しないは PBT (params.prop.ts) が担うため、ここでは
// メッセージまで固定する error path と、公開 API の契約を確かめる
test("validateTrackNamespaceForSend: §8.7 の構造の制約を送信前のメッセージで拒否する", () => {
  // 0 フィールドと 32 フィールドは §2.4.1 が許す
  validateTrackNamespaceForSend([]);
  validateTrackNamespaceForSend(Array.from({ length: 32 }, () => "n"));

  // 33 フィールド以上
  assert.throws(
    () => validateTrackNamespaceForSend(Array.from({ length: 33 }, () => "n")),
    /track namespace fields exceeds maximum: 33 > 32/,
  );
  // 空のフィールド ("Each Track Namespace Field Value MUST contain at least one byte")
  assert.throws(
    () => validateTrackNamespaceForSend(["live", ""]),
    /track namespace field length is zero/,
  );
  // 合計 4,096 バイト超 (namespace 単体の上限)
  assert.throws(
    () => validateTrackNamespaceForSend(["a".repeat(4097)]),
    /track namespace exceeds maximum size: 4097 > 4096/,
  );
  // 4,096 バイトちょうどは許容される
  validateTrackNamespaceForSend(["a".repeat(4096)]);
});

// §2.4.3 / §6.5 の予約 namespace は、先頭フィールドだけを見て拒否する。判定は
// 先頭フィールドが "." で始まる値、"." 単体、".session" で分かれる
test("validateTrackNamespaceForSend: 予約 namespace を理由ごとのメッセージで拒否する", () => {
  assert.throws(
    () => validateTrackNamespaceForSend([".session"]),
    /session-level namespace \.session is reserved for the MOQT implementation/,
  );
  // §6.5: .session と空 Track Name の組み合わせは DOES_NOT_EXIST
  assert.throws(
    () => validateTrackNamespaceForSend([".session"], ""),
    /track with \.session namespace and empty track name does not exist \(DOES_NOT_EXIST\)/,
  );
  // §2.4.3: 先頭フィールドが "." 単体の namespace は IANA 登録でも使えない
  assert.throws(
    () => validateTrackNamespaceForSend(["."]),
    /track namespace "\." must not be used for any purpose \(DOES_NOT_EXIST\)/,
  );
  // 先頭フィールドが "." で始まる他の値は IANA 登録がない限り使えない
  assert.throws(
    () => validateTrackNamespaceForSend([".other"]),
    /reserved namespace prefix \.other is not allowed \(MUST NOT be used without IANA registration\)/,
  );
  // 予約の判定は先頭フィールドだけを見る (§2.4.3)
  validateTrackNamespaceForSend(["live", ".session"]);
});
