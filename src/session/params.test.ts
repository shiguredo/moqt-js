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
  validateFetchOkEndLocation,
  resolveFetchStartLocation,
  resolveFillGroupOrder,
  extractNewGroupRequest,
  matchNamespacePrefix,
  namespacePrefixesOverlap,
} from "./params";
import { InvalidFilterError, ProtocolViolationError } from "../error";
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

// draft-ietf-moq-msf-01 §11.4.3: publisher は track に紐づくトークンを PUBLISH へ MUST 付与する。
// draft-ietf-moq-transport-22 §9.20.2: AUTHORIZATION TOKEN は PUBLISH に出現できる。
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
 * draft-ietf-moq-transport-22 §9.20.7 (SUBSCRIBER PRIORITY Parameter):
 * "It MAY appear in a SUBSCRIBE, PUBLISH, FETCH, or REQUEST_UPDATE"。
 * FETCH でも送信できることを検証する。
 */
/**
 * draft-ietf-moq-transport-22 §9.20.8 (GROUP ORDER Parameter):
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
 * draft-ietf-moq-transport-22 §9.18 (SUBSCRIBE_TRACKS) / §9.20.1 (Parameter Scope):
 * SUBSCRIBE_TRACKS が運べるパラメータは §9.18 の列挙が正であり、
 * SUBSCRIBER_PRIORITY / LOCATION_FILTER / FILL_PARAMETERS は送らない。
 *
 * §3.6.2 には「SUBSCRIBE に指定できるパラメータは SUBSCRIBE_TRACKS でも有効」と
 * Location Filter / FILL_PARAMETERS に触れる記述が残り矛盾するが、§9.18 の列挙と
 * §9.20.1 の MUST (許可外メッセージへの出現は受信側で PROTOCOL_VIOLATION) を正とする。
 */
test("buildSubscribeTracksParameters: §9.18 の一覧に無いパラメータを送らない", () => {
  const parameters = buildSubscribeTracksParameters({
    groupOrder: "Ascending",
    forward: false,
    includeProperties: true,
  });

  // 一覧にある型だけが現れる
  assert.deepEqual(
    parameters.map((p) => p.type).sort((a, b) => a - b),
    [
      MessageParameterType.FORWARD,
      MessageParameterType.GROUP_ORDER,
      MessageParameterType.INCLUDE_PROPERTIES,
    ].sort((a, b) => a - b),
  );
  // §9.18 の一覧に無い 3 つは、型の上でも指定できない (空オブジェクトで確認)
  assert.deepEqual(buildSubscribeTracksParameters({}), []);
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
// draft-ietf-moq-transport-22 §3.6.2 / §3.6.1 / §3.3.2
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
 * draft-ietf-moq-transport-22 §9.20.9 (LOCATION FILTER Parameter):
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
// draft-ietf-moq-transport-22 §3.4 / §9.20.15
// ============================================================================

/**
 * draft-ietf-moq-transport-22 §9.20.9 / §9.20.15:
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
 * draft-ietf-moq-transport-22 §9.20.8:
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
 * draft-ietf-moq-transport-22 §3.4 / §9.20.15:
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
 * draft-ietf-moq-transport-22 §9.20.21:
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
 * draft-ietf-moq-transport-22 §9.20.21:
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
 * draft-ietf-moq-transport-22 §9.20.21:
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
 * draft-ietf-moq-transport-22 §9.20.21:
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
 * draft-ietf-moq-transport-22 §9.20.19 (NEW GROUP REQUEST Parameter):
 * "The NEW_GROUP_REQUEST parameter (Parameter Type 0x32) is a varint."
 * 値は varint 1 つである。パラメータが無ければ undefined、値 0 はそのまま 0 を返す。
 * 読み切れない値と、varint の後ろに余りのある値は PROTOCOL_VIOLATION にする。
 * 読み取りの往復は params.prop.ts が任意の値で確かめる
 */
test("extractNewGroupRequest: varint の値を返し、無ければ undefined、不正な値は ProtocolViolationError", () => {
  assert.isUndefined(extractNewGroupRequest([]));
  assert.isUndefined(
    extractNewGroupRequest([{ type: MessageParameterType.FORWARD, value: new Uint8Array([1]) }]),
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

/**
 * draft-ietf-moq-transport-22 §9.20.9:
 * 2 フィールドの 0:0 (Location Filter Type 0x02) は絶対位置 {0, 0} の指定であり、
 * Largest Object に依存せず Start Location を確定できる (v21 の「2 フィールド 0:0 は
 * Next Object」という特例は廃止された)。
 */
test("resolveFetchStartLocation: 2 フィールド 0:0 は絶対位置 {0, 0} として確定する", () => {
  assert.deepEqual(resolveFetchStartLocation({ startGroup: 0n, startObject: 0n }), {
    group: 0n,
    object: 0n,
  });
  // Next Object (0x05) は Largest Object 依存のため確定できない
  assert.isUndefined(resolveFetchStartLocation({ nextObject: true }));
});

/**
 * draft-ietf-moq-transport-22 §9.20.9 / §3.4:
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
// matchNamespacePrefix / namespacePrefixesOverlap
// draft-ietf-moq-transport-22 §2.4.2 (Namespace Prefix Matching) / §3.6 (PREFIX_OVERLAP)
// / §9.5.2 (Updating Namespace Subscriptions)
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

// 共通 prefix を持つとは、一方が他方の sub-prefix であることである (§9.5.2)。
// SUBSCRIBE_TRACKS では §3.6 が PREFIX_OVERLAP の応答を MUST とする
test("namespacePrefixesOverlap: §2.4.2 の例で sub-prefix の関係を判定する", () => {
  // (foo) と (foo, bar) は共通 prefix を持つ
  assert.isTrue(namespacePrefixesOverlap(["foo"], ["foo", "bar"]));
  assert.isTrue(namespacePrefixesOverlap(["foo", "bar"], ["foo"]));
  // 同じ prefix は共通 prefix を持つ
  assert.isTrue(namespacePrefixesOverlap(["foo", "bar"], ["foo", "bar"]));
  // foobar は (foo, bar) と sub-prefix の関係にない (フィールド単位の一致)
  assert.isFalse(namespacePrefixesOverlap(["foo", "bar"], ["foobar"]));
  // 先頭フィールドが異なれば共通 prefix を持たない
  assert.isFalse(namespacePrefixesOverlap(["example.com", "123"], ["example.net", "123"]));
  // 空の prefix はすべての名前空間と共通 prefix を持つ
  assert.isTrue(namespacePrefixesOverlap([], ["foo", "bar"]));
});
