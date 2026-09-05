/**
 * MOQT Session 純粋関数の Property-Based Tests
 * draft-ietf-moq-transport-20 Section 10.2, Section 11.4, Section 12
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  buildPublishParameters,
  buildPublishTrackProperties,
  buildSubscribeParameters,
  extractLargestLocation,
  validateFetchOkEndLocation,
  classifyIncomingStreamType,
  calculateObjectIdDelta,
} from "./session/params";
import { extractForwardState } from "./session/params";
import { type PublishOptions, type SubscribeOptions } from "./session";
import {
  encodeParameters,
  decodeParameters,
  encodeLocation,
  encodeUint8ParameterValue,
  type Parameter,
  type LocationFilter,
} from "./message/parameter";
import { MessageParameterType, type Location } from "./message/types";
import { AuthorizationTokenAliasType, type AuthorizationToken } from "./message/authorizationToken";
import { encodeVarint } from "./varint";
import { encodeProperties, decodeProperties } from "./properties";
import { ProtocolViolationError } from "./error";

// ============================================================================
// Arbitrary 定義
// ============================================================================

/**
 * Location の raw arbitrary
 */
const locationArb: fc.Arbitrary<Location> = fc.record({
  group: fc.bigInt({ min: 0n, max: 1000000n }),
  object: fc.bigInt({ min: 0n, max: 1000000n }),
});

/**
 * LocationFilter の任意構築
 */
const locationFilterArb: fc.Arbitrary<LocationFilter> = fc.oneof(
  fc.constant({ reset: true } as const),
  fc.bigInt({ min: 0n, max: 1000000n }).map((startGroup) => ({ startGroup })),
  fc.record({
    startGroup: fc.bigInt({ min: 0n, max: 1000000n }),
    startObject: fc.bigInt({ min: 0n, max: 1000000n }),
  }),
  fc.record({
    startGroup: fc.bigInt({ min: 0n, max: 1000000n }),
    startObject: fc.bigInt({ min: 0n, max: 1000000n }),
    endGroupDelta: fc.bigInt({ min: 0n, max: 1000000n }),
  }),
  fc.record({
    startGroup: fc.bigInt({ min: 0n, max: 1000000n }),
    startObject: fc.bigInt({ min: 0n, max: 1000000n }),
    endGroupDelta: fc.bigInt({ min: 0n, max: 1000000n }),
    endObject: fc.bigInt({ min: 0n, max: 1000000n }),
  }),
);

/**
 * PublishOptions の任意構築
 */
const publishOptionsArb: fc.Arbitrary<PublishOptions> = fc.record({
  expires: fc.option(fc.bigInt({ min: 0n, max: 1000000n }), { nil: undefined }),
  deliveryTimeout: fc.option(fc.bigInt({ min: 0n, max: 1000000n }), { nil: undefined }),
  maxCacheDuration: fc.option(fc.bigInt({ min: 0n, max: 1000000n }), { nil: undefined }),
  publisherPriority: fc.option(fc.integer({ min: 0, max: 255 }), { nil: undefined }),
  groupOrder: fc.option(fc.constantFrom("Ascending" as const, "Descending" as const), {
    nil: undefined,
  }),
  dynamicGroups: fc.option(fc.boolean(), { nil: undefined }),
  forward: fc.option(fc.boolean(), { nil: undefined }),
});

/**
 * Authorization Token の任意構築（USE_VALUE。Message Parameter では 4 種全て許可されるが、
 * round-trip 検証には値を持つ USE_VALUE が代表的）
 * draft-ietf-moq-transport-20 Section 10.2.2
 */
const authorizationTokenArb: fc.Arbitrary<AuthorizationToken> = fc.record({
  aliasType: fc.constant(AuthorizationTokenAliasType.USE_VALUE),
  tokenType: fc.bigInt({ min: 0n, max: 1000n }),
  tokenValue: fc.uint8Array({ maxLength: 64 }).map((arr) => new Uint8Array(arr)),
});

/**
 * SubscribeOptions の任意構築
 */
const subscribeOptionsArb: fc.Arbitrary<SubscribeOptions> = fc.record({
  filter: fc.option(locationFilterArb, { nil: undefined }),
  deliveryTimeout: fc.option(fc.bigInt({ min: 0n, max: 1000000n }), { nil: undefined }),
  subscriberPriority: fc.option(fc.integer({ min: 0, max: 255 }), { nil: undefined }),
  groupOrder: fc.option(fc.constantFrom("Ascending" as const, "Descending" as const), {
    nil: undefined,
  }),
  newGroupRequest: fc.option(fc.bigInt({ min: 0n, max: 1000000n }), { nil: undefined }),
  rendezvousTimeout: fc.option(fc.bigInt({ min: 0n, max: 1000000n }), { nil: undefined }),
  forward: fc.option(fc.boolean(), { nil: undefined }),
  authorizationToken: fc.option(authorizationTokenArb, { nil: undefined }),
});

// ============================================================================
// PBT 1: buildPublishParameters + buildPublishTrackProperties
// ============================================================================

test("buildPublishParameters の戻り値がエンコード・デコードでラウンドトリップする", () => {
  fc.assert(
    fc.property(publishOptionsArb, (options) => {
      const parameters = buildPublishParameters(options);
      const encoded = encodeParameters(parameters);
      const [decoded, _] = decodeParameters(encoded);

      // encodeParameters が type 昇順でソートするため、元の配列もソートして比較
      const sorted = [...parameters].sort((a, b) => a.type - b.type);
      assert.deepEqual(decoded, sorted);
    }),
  );
});

test("buildPublishTrackProperties の戻り値がエンコード・デコードでラウンドトリップする", () => {
  fc.assert(
    fc.property(publishOptionsArb, (options) => {
      const properties = buildPublishTrackProperties(options);
      const encoded = encodeProperties(properties);
      const decoded = decodeProperties(encoded);

      // encodeProperties が id 昇順でソートするため、元の配列もソートして比較
      const sorted = [...properties].sort((a, b) => Number(a.id - b.id));
      assert.deepEqual(decoded, sorted);
    }),
  );
});

// ============================================================================
// PBT 2: buildSubscribeParameters
// ============================================================================

test("buildSubscribeParameters の戻り値がエンコード・デコードでラウンドトリップする", () => {
  fc.assert(
    fc.property(subscribeOptionsArb, (options) => {
      const parameters = buildSubscribeParameters(options);
      const encoded = encodeParameters(parameters);
      const [decoded, _] = decodeParameters(encoded);

      // encodeParameters が type 昇順でソートするため、元の配列もソートして比較
      const sorted = [...parameters].sort((a, b) => a.type - b.type);
      assert.deepEqual(decoded, sorted);
    }),
  );
});

// ============================================================================
// PBT 3: extractLargestLocation
// ============================================================================

test("extractLargestLocation: LARGEST_OBJECT を含む場合、元の Location と一致する", () => {
  fc.assert(
    fc.property(locationArb, (location) => {
      const parameters: Parameter[] = [
        {
          type: MessageParameterType.LARGEST_OBJECT,
          value: encodeLocation(location),
        },
      ];

      const result = extractLargestLocation(parameters);
      assert.isDefined(result);
      assert.deepEqual(result, location);
    }),
  );
});

test("extractLargestLocation: LARGEST_OBJECT を含まない場合、undefined を返す", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.oneof(
          fc.record({
            type: fc.constant(MessageParameterType.OBJECT_DELIVERY_TIMEOUT),
            value: fc.bigInt({ min: 0n, max: 1000000n }).map((v) => encodeVarint(v)),
          }),
          fc.record({
            type: fc.constant(MessageParameterType.EXPIRES),
            value: fc.bigInt({ min: 0n, max: 1000000n }).map((v) => encodeVarint(v)),
          }),
          fc.record({
            type: fc.constant(MessageParameterType.FORWARD),
            value: fc
              .integer({ min: 0, max: 1 })
              .map((v) => encodeUint8ParameterValue(v, "FORWARD")),
          }),
        ),
        { minLength: 0, maxLength: 10 },
      ),
      (parameters) => {
        // LARGEST_OBJECT がないことの確認
        for (const param of parameters) {
          assert.notEqual(param.type, MessageParameterType.LARGEST_OBJECT);
        }

        const result = extractLargestLocation(parameters);
        assert.isUndefined(result);
      },
    ),
  );
});

test("extractLargestLocation: 複数の LARGEST_OBJECT を含む場合、最初のものを抽出する", () => {
  fc.assert(
    fc.property(locationArb, locationArb, (first, second) => {
      const parameters: Parameter[] = [
        {
          type: MessageParameterType.LARGEST_OBJECT,
          value: encodeLocation(first),
        },
        {
          type: MessageParameterType.LARGEST_OBJECT,
          value: encodeLocation(second),
        },
      ];

      const result = extractLargestLocation(parameters);
      assert.isDefined(result);
      assert.deepEqual(result, first);
    }),
  );
});

// ============================================================================
// PBT 4: extractForwardState
// ============================================================================

test("extractForwardState: forwardValue が 0 の場合 false を返す", () => {
  const parameters: Parameter[] = [
    {
      type: MessageParameterType.FORWARD,
      value: encodeUint8ParameterValue(0, "FORWARD"),
    },
  ];

  const result = extractForwardState(parameters);
  assert.equal(result, false);
});

test("extractForwardState: forwardValue が 1 の場合 true を返す", () => {
  const parameters: Parameter[] = [
    {
      type: MessageParameterType.FORWARD,
      value: encodeUint8ParameterValue(1, "FORWARD"),
    },
  ];

  const result = extractForwardState(parameters);
  assert.equal(result, true);
});

test("extractForwardState: forwardValue が 2-255 の場合 ProtocolViolationError を throw する", () => {
  fc.assert(
    fc.property(fc.integer({ min: 2, max: 255 }), (forwardValue) => {
      const parameters: Parameter[] = [
        {
          type: MessageParameterType.FORWARD,
          value: encodeUint8ParameterValue(forwardValue, "FORWARD"),
        },
      ];

      assert.throws(() => extractForwardState(parameters), ProtocolViolationError);
    }),
  );
});

test("extractForwardState: FORWARD を含まない場合デフォルト値 true を返す", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.oneof(
          fc.record({
            type: fc.constant(MessageParameterType.OBJECT_DELIVERY_TIMEOUT),
            value: fc.bigInt({ min: 0n, max: 1000000n }).map((v) => encodeVarint(v)),
          }),
          fc.record({
            type: fc.constant(MessageParameterType.EXPIRES),
            value: fc.bigInt({ min: 0n, max: 1000000n }).map((v) => encodeVarint(v)),
          }),
          fc.record({
            type: fc.constant(MessageParameterType.RENDEZVOUS_TIMEOUT),
            value: fc.bigInt({ min: 0n, max: 1000000n }).map((v) => encodeVarint(v)),
          }),
        ),
        { minLength: 0, maxLength: 10 },
      ),
      (parameters) => {
        // FORWARD がないことの確認
        for (const param of parameters) {
          assert.notEqual(param.type, MessageParameterType.FORWARD);
        }

        const result = extractForwardState(parameters);
        assert.equal(result, true);
      },
    ),
  );
});

// ============================================================================
// PBT 5: validateFetchOkEndLocation
// ============================================================================

test("validateFetchOkEndLocation: Start <= End の場合は undefined を返す", () => {
  fc.assert(
    fc.property(
      fc
        .record({
          startLocation: locationArb,
          endLocation: locationArb,
        })
        .filter(
          ({ startLocation, endLocation }) =>
            endLocation.group > startLocation.group ||
            (endLocation.group === startLocation.group &&
              endLocation.object >= startLocation.object),
        ),
      ({ startLocation, endLocation }) => {
        const result = validateFetchOkEndLocation(startLocation, endLocation);
        assert.isUndefined(result);
      },
    ),
  );
});

test("validateFetchOkEndLocation: End < Start の場合はエラー文字列を返す", () => {
  fc.assert(
    fc.property(
      fc
        .record({
          startLocation: locationArb,
          endLocation: locationArb,
        })
        .filter(
          ({ startLocation, endLocation }) =>
            endLocation.group < startLocation.group ||
            (endLocation.group === startLocation.group &&
              endLocation.object < startLocation.object),
        ),
      ({ startLocation, endLocation }) => {
        const result = validateFetchOkEndLocation(startLocation, endLocation);
        assert.isString(result);
        assert.isTrue(result!.length > 0);
      },
    ),
  );
});

// ============================================================================
// PBT 6: classifyIncomingStreamType
// ============================================================================

test("classifyIncomingStreamType: 0x05 は fetch を返す", () => {
  const result = classifyIncomingStreamType(0x05n);
  assert.equal(result, "fetch");
});

test("classifyIncomingStreamType: サブグループ範囲は subgroup を返す", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.integer({ min: 0x10, max: 0x1f }),
        fc.integer({ min: 0x30, max: 0x3f }),
        fc.integer({ min: 0x50, max: 0x5f }),
        fc.integer({ min: 0x70, max: 0x7f }),
      ),
      (streamType) => {
        const result = classifyIncomingStreamType(BigInt(streamType));
        assert.equal(result, "subgroup");
      },
    ),
  );
});

test("classifyIncomingStreamType: 上記以外の全値は unknown を返す", () => {
  fc.assert(
    fc.property(
      fc
        .integer({ min: 0x00, max: 0xff })
        .filter(
          (n) =>
            n !== 0x05 &&
            !(n >= 0x10 && n <= 0x1f) &&
            !(n >= 0x30 && n <= 0x3f) &&
            !(n >= 0x50 && n <= 0x5f) &&
            !(n >= 0x70 && n <= 0x7f),
        ),
      (streamType) => {
        const result = classifyIncomingStreamType(BigInt(streamType));
        assert.equal(result, "unknown");
      },
    ),
  );
});

// ============================================================================
// PBT 7: calculateObjectIdDelta
// ============================================================================

test("calculateObjectIdDelta: previousObjectId < 0 の場合、currentObjectId をそのまま返す", () => {
  fc.assert(
    fc.property(
      fc.tuple(fc.bigInt({ min: -1n, max: -1n }), fc.bigInt({ min: 0n, max: 1000000n })),
      ([previousObjectId, currentObjectId]) => {
        const delta = calculateObjectIdDelta(previousObjectId, currentObjectId);
        assert.equal(delta, currentObjectId);
      },
    ),
  );
});

test("calculateObjectIdDelta: previousObjectId >= 0 かつ currentObjectId > previousObjectId の場合、previousObjectId + delta + 1 === currentObjectId", () => {
  fc.assert(
    fc.property(
      fc
        .tuple(fc.bigInt({ min: 0n, max: 500000n }), fc.bigInt({ min: 0n, max: 1000000n }))
        .filter(([previous, current]) => current > previous),
      ([previousObjectId, currentObjectId]) => {
        const delta = calculateObjectIdDelta(previousObjectId, currentObjectId);
        assert.equal(previousObjectId + delta + 1n, currentObjectId);
      },
    ),
  );
});
