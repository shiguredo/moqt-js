/**
 * session/stream.ts の純粋関数の単体テスト
 */

import { test, assert } from "vite-plus/test";
import {
  concatChunks,
  processFetchObjects,
  processSubgroupObjects,
  type FetchGapSemantics,
  type SubgroupDeliveryHooks,
} from "./stream";
import { createCountingStreamStats, type CountingStreamStats } from "../testSupport/streamStats";
import {
  createFirstFetchObjectFlags,
  encodeFetchObjectFields,
  encodeObjectFields,
  FetchSerializationFlags,
  SubgroupHeaderType,
  type FetchObjectContext,
  type FetchObjectFields,
  type MoqtObject,
  type SubgroupHeader,
} from "../dataStream";
import { GroupOrder, ObjectStatus } from "../message/types";
import {
  encodeProperties,
  mergeDeliveryTimeoutObjectProperties,
  MOQTPropertyId,
  TrackPropertyId,
} from "../properties";
import { SubscriberImpl } from "../subscriber";
import { FetcherImpl } from "../fetcher";
import { MalformedTrackError, ProtocolViolationError } from "../error";
import { fullTrackNameKey } from "../fullTrackName";
import { MAX_VARINT } from "../varint";
import { recordFetchObjectEnd, type PriorGapTrackingTarget } from "./priorGapTracking";

// ============================================================================
// processSubgroupObjects の先頭オブジェクト判定
// draft-ietf-moq-transport-23 §5.2 / §10.1 / §10.2
// ============================================================================

/** delivery timeout 付きの Object Property バイト列を組み立てる */
function timeoutObjectProperties(objectTimeout: bigint, subgroupTimeout: bigint): Uint8Array {
  const encoded = mergeDeliveryTimeoutObjectProperties(undefined, objectTimeout, subgroupTimeout);
  if (encoded === undefined) {
    throw new Error("failed to build timeout properties for test");
  }
  return encoded;
}

/** timeout 付き単一オブジェクト 1 件分のワイヤ (fields + payload 1 バイト) を組み立てる */
function timeoutObjectWire(
  objectIdDelta: bigint,
  objectTimeout: bigint,
  subgroupTimeout: bigint,
): Uint8Array {
  const fields = encodeObjectFields(
    objectIdDelta,
    1n,
    SubgroupHeaderType.BASE_EXT,
    ObjectStatus.NORMAL,
    timeoutObjectProperties(objectTimeout, subgroupTimeout),
  );
  return concatChunks([fields, new Uint8Array([0xaa])]);
}

/** 配信先の実 Subscriber と観測用のヘッダ・統計を組み立てる */
function subgroupTestSetup(): {
  delivered: MoqtObject[];
  subscriber: SubscriberImpl;
  header: SubgroupHeader;
  stats: CountingStreamStats;
} {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 1n, (object) => {
    delivered.push(object);
  });
  const stats = createCountingStreamStats();
  return {
    delivered,
    subscriber,
    // BASE_EXT (Subgroup ID = 0) の実デコーダ出力と一致させる。
    // delivery timeout の上書きは FIRST_OBJECT ビットが立つ subgroup にのみ
    // 適用されるため、timeout 抽出を検証するテスト用に true を設定する。
    header: {
      type: SubgroupHeaderType.BASE_EXT,
      trackAlias: 1n,
      groupId: 0n,
      subgroupId: 0n,
      firstObject: true,
    },
    stats,
  };
}

/** 通知を捨てる配送フック (エラー非発生経路用) */
const silentDelivery: SubgroupDeliveryHooks = {
  notifyError: () => {},
  recordCallbackError: () => {},
};

/** 通知呼び出しを記録する配送フック (正規化は注入側の責務のため行わない) */
function createRecordingDelivery(): {
  hooks: SubgroupDeliveryHooks;
  notified: { subscriber: SubscriberImpl; error: unknown }[];
  records: { payload: Uint8Array; error: unknown }[];
} {
  const notified: { subscriber: SubscriberImpl; error: unknown }[] = [];
  const records: { payload: Uint8Array; error: unknown }[] = [];
  const hooks: SubgroupDeliveryHooks = {
    notifyError: (subscriber, error) => {
      notified.push({ subscriber, error });
    },
    recordCallbackError: (payload, error) => {
      records.push({ payload, error });
    },
  };
  return { hooks, notified, records };
}

/** 指定型の単一オブジェクト 1 件分のワイヤを組み立てる */
function subgroupObjectWire(
  headerType: number,
  objectIdDelta: bigint,
  payload: number,
): Uint8Array {
  const fields = encodeObjectFields(objectIdDelta, 1n, headerType, ObjectStatus.NORMAL);
  return concatChunks([fields, new Uint8Array([payload])]);
}

/** First-Object-ID 系の単一オブジェクト 1 件分のワイヤを組み立てる */
function firstObjectWire(objectIdDelta: bigint, payload: number): Uint8Array {
  return subgroupObjectWire(SubgroupHeaderType.FIRST_OBJ, objectIdDelta, payload);
}

// draft-ietf-moq-transport-23 §10.4 (DEFAULT PUBLISHER_PRIORITY) / §11.3.1:
// Subgroup Header で Priority が省略された場合 (DEFAULT_PRIORITY ビットが 1)、
// 購読の DEFAULT_PUBLISHER_PRIORITY を継承した値が配送されることを検証する。
test("processSubgroupObjects: Priority 省略時は購読の DEFAULT_PUBLISHER_PRIORITY を継承する", () => {
  const { delivered, subscriber, stats } = subgroupTestSetup();
  subscriber.setTrackProperties([{ id: TrackPropertyId.DEFAULT_PUBLISHER_PRIORITY, value: 42n }]);
  // BASE_NO_PRIORITY (0x30) は Priority Present なしの型
  const header: SubgroupHeader = {
    type: SubgroupHeaderType.BASE_NO_PRIORITY,
    trackAlias: 1n,
    groupId: 0n,
    subgroupId: 0n,
    // wire に FIRST_OBJECT ビットが無いヘッダ相当
    firstObject: false,
  };
  const result = processSubgroupObjects(
    subgroupObjectWire(SubgroupHeaderType.BASE_NO_PRIORITY, 0n, 0xaa),
    [subscriber],
    header,
    -1n,
    stats,
    silentDelivery,
  );

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].publisherPriority, 42);
  assert.equal(result.remainingBuffer.byteLength, 0);
});

// 同一 alias の複数購読への配送で 1 件目のアプリ例外を通知し、
// 残りの配送と同一ストリームの後続処理を継続することの検証。
// 層分離のため double は記録のみ行い、Error 正規化と handleError 配送は
// 注入側 (incoming 層) の責務としてここでは検証しない。
test("processSubgroupObjects: 1 件目のアプリ例外を通知して残りに配送を継続する", () => {
  const { stats } = subgroupTestSetup();
  const delivered2: MoqtObject[] = [];
  const appError = new Error("app failed");
  // 非 Error 値は変数経由で送出する (リテラル throw は lint 対象のため)
  const nonError: unknown = "boom2";
  const throwing1 = new SubscriberImpl(["test"], "track", 0n, 1n, () => {
    throw appError;
  });
  const throwing2 = new SubscriberImpl(["test"], "track", 0n, 1n, () => {
    throw nonError;
  });
  const second = new SubscriberImpl(["test"], "track", 0n, 1n, (object) => {
    delivered2.push(object);
  });
  const header: SubgroupHeader = {
    type: SubgroupHeaderType.FIRST_OBJ,
    trackAlias: 1n,
    groupId: 0n,
    firstObject: false,
  };
  const { hooks, notified, records } = createRecordingDelivery();

  // 1 バッチに 2 件載せて feed する
  const result = processSubgroupObjects(
    concatChunks([firstObjectWire(0n, 0xaa), firstObjectWire(0n, 0xbb)]),
    [throwing1, throwing2, second],
    header,
    -1n,
    stats,
    hooks,
  );

  // 層をそのまま素通しすること (正規化は注入側の責務)
  assert.equal(notified.length, 4);
  assert.strictEqual(notified[0].subscriber, throwing1);
  assert.strictEqual(notified[0].error, appError);
  assert.strictEqual(notified[1].subscriber, throwing2);
  assert.strictEqual(notified[1].error, "boom2");
  assert.equal(delivered2.length, 2);
  assert.equal(records.length, 0);
  assert.equal(result.resolvedSubgroupId, 0n);
  assert.equal(stats.objectsReceived, 2);
  assert.equal(stats.bytesReceived, 2);
  assert.equal(throwing1.state, "active");
  assert.equal(throwing2.state, "active");
  assert.equal(second.state, "active");
});

// 通知フック自体の throw は記録フックで受けて継続することの検証。
test("processSubgroupObjects: 通知フックの throw を記録して継続する", () => {
  const { stats } = subgroupTestSetup();
  const delivered2: MoqtObject[] = [];
  const throwing = new SubscriberImpl(["test"], "track", 0n, 1n, () => {
    throw new Error("app failed");
  });
  const second = new SubscriberImpl(["test"], "track", 0n, 1n, (object) => {
    delivered2.push(object);
  });
  const header: SubgroupHeader = {
    type: SubgroupHeaderType.FIRST_OBJ,
    trackAlias: 1n,
    groupId: 0n,
    firstObject: false,
  };
  const records: { payload: Uint8Array; error: unknown }[] = [];
  const hooks: SubgroupDeliveryHooks = {
    notifyError: () => {
      throw new Error("notify failed");
    },
    recordCallbackError: (payload, error) => {
      records.push({ payload, error });
    },
  };

  processSubgroupObjects(
    concatChunks([firstObjectWire(0n, 0xaa), firstObjectWire(0n, 0xbb)]),
    [throwing, second],
    header,
    -1n,
    stats,
    hooks,
  );

  assert.equal(delivered2.length, 2);
  assert.equal(records.length, 2);
  assert.deepEqual([...records[0].payload], [0xaa]);
  assert.deepEqual([...records[1].payload], [0xbb]);
});

// 通知中の unsubscribe (配列の破壊的変更) でも後続に配送されることの検証。
// 反復前の slice() 複製の回帰網である。
test("processSubgroupObjects: 通知中の除去でも後続に配送される", () => {
  const { stats } = subgroupTestSetup();
  const delivered: MoqtObject[] = [];
  const list: SubscriberImpl[] = [];
  const first = new SubscriberImpl(["test"], "track", 0n, 1n, () => {
    throw new Error("app failed");
  });
  const second = new SubscriberImpl(["test"], "track", 0n, 1n, (object) => {
    delivered.push(object);
  });
  const third = new SubscriberImpl(["test"], "track", 0n, 1n, (object) => {
    delivered.push(object);
  });
  list.push(first, second, third);
  const header: SubgroupHeader = {
    type: SubgroupHeaderType.FIRST_OBJ,
    trackAlias: 1n,
    groupId: 0n,
    firstObject: false,
  };
  const hooks: SubgroupDeliveryHooks = {
    notifyError: () => {
      list.splice(0, 1);
    },
    recordCallbackError: () => {},
  };

  processSubgroupObjects(firstObjectWire(0n, 0xaa), list, header, -1n, stats, hooks);

  assert.equal(delivered.length, 2);
});

// ============================================================================
// draft-22 適合監査 D-9: delivery timeout 上書きは FIRST_OBJECT ビット時のみ
// draft-ietf-moq-transport-23 §5.2 / §2.2
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §2.2:
 * "When the Original Publisher opens a new subgroup, it MUST set the
 *  FIRST_OBJECT bit ... to indicate that the first object in the subgroup
 *  stream is the first object ever published in that subgroup."
 * draft-ietf-moq-transport-23 §5.2:
 * "Either timeout value can also be set as an Object Property on the first
 *  object in a subgroup ... If either timeout is set as an Object Property on
 *  any object other than the first in a subgroup, it is ignored."
 * FIRST_OBJECT ビットが立たないストリーム (中継が subgroup 途中から転送した
 * 場合) では、ストリーム先頭 Object であっても Object Property による
 * delivery timeout の上書きを適用しないことを検証する。
 */
test("processSubgroupObjects: FIRST_OBJECT ビットなしでは timeout を抽出しない", () => {
  const { delivered, subscriber, stats } = subgroupTestSetup();
  // subgroupTestSetup の header の firstObject を false にし、中継転送相当にする
  const header: SubgroupHeader = {
    type: SubgroupHeaderType.BASE_EXT,
    trackAlias: 1n,
    groupId: 0n,
    subgroupId: 0n,
    firstObject: false,
  };
  processSubgroupObjects(
    timeoutObjectWire(0n, 100n, 200n),
    [subscriber],
    header,
    -1n,
    stats,
    silentDelivery,
  );

  // ストリーム先頭でも上書きは適用されない (Track Property が使われる)
  assert.equal(delivered.length, 1);
  assert.isUndefined(delivered[0].objectDeliveryTimeout);
  assert.isUndefined(delivered[0].subgroupDeliveryTimeout);
});

// ============================================================================
// draft-22 適合監査 D-7: Prior Group ID Gap / Prior Object ID Gap
// draft-ietf-moq-transport-23 §10.8 / §10.9
// ============================================================================

/** 単一 Object の fields + payload 1 バイトを組み立てる */
function objectWireWithProperties(objectIdDelta: bigint, properties: Uint8Array): Uint8Array {
  const fields = encodeObjectFields(
    objectIdDelta,
    1n,
    SubgroupHeaderType.BASE_EXT,
    ObjectStatus.NORMAL,
    properties,
  );
  return concatChunks([fields, new Uint8Array([0xaa])]);
}

/**
 * draft-ietf-moq-transport-23 §10.8:
 * "An Object has a Prior Group ID Gap larger than the Group ID."
 * Group 0 の Object に Prior Group ID Gap = 1 を付けると malformed となる。
 */
test("processSubgroupObjects: Prior Group ID Gap が Group ID より大きいと MalformedTrackError", () => {
  const { subscriber, header, stats } = subgroupTestSetup();
  const properties = encodeProperties([{ id: MOQTPropertyId.PRIOR_GROUP_ID_GAP, value: 1n }]);

  assert.throws(
    () =>
      processSubgroupObjects(
        objectWireWithProperties(0n, properties),
        [subscriber],
        header,
        -1n,
        stats,
        silentDelivery,
      ),
    MalformedTrackError,
    /prior group id gap exceeds group id/,
  );
});

/**
 * draft-ietf-moq-transport-23 §10.9:
 * "An Object has a Prior Object ID Gap larger than the Object ID."
 * Object 0 に Prior Object ID Gap = 1 を付けると malformed となる。
 */
test("processSubgroupObjects: Prior Object ID Gap が Object ID より大きいと MalformedTrackError", () => {
  const { subscriber, header, stats } = subgroupTestSetup();
  const properties = encodeProperties([{ id: MOQTPropertyId.PRIOR_OBJECT_ID_GAP, value: 1n }]);

  assert.throws(
    () =>
      processSubgroupObjects(
        objectWireWithProperties(0n, properties),
        [subscriber],
        header,
        -1n,
        stats,
        silentDelivery,
      ),
    MalformedTrackError,
    /prior object id gap exceeds object id/,
  );
});

/**
 * draft-ietf-moq-transport-23 §10.8 / §10.9:
 * gap が Group ID / Object ID 以下なら malformed ではない (誤検出しない)。
 */
test("processSubgroupObjects: gap が Group ID / Object ID 以下なら配信する", () => {
  const { delivered, subscriber, header, stats } = subgroupTestSetup();
  // Group 0 / Object 0 に対して gap 0 は許容される
  const properties = encodeProperties([
    { id: MOQTPropertyId.PRIOR_GROUP_ID_GAP, value: 0n },
    { id: MOQTPropertyId.PRIOR_OBJECT_ID_GAP, value: 0n },
  ]);
  processSubgroupObjects(
    objectWireWithProperties(0n, properties),
    [subscriber],
    header,
    -1n,
    stats,
    silentDelivery,
  );

  assert.equal(delivered.length, 1);
});

/**
 * draft-ietf-moq-transport-23 §10.7 / §10.8:
 * "When looking for the value of a property, processors MUST search both the
 *  mutable properties and the contents of Immutable Properties."
 * mutable list と IMMUTABLE_PROPERTIES 配下を合わせて 2 回現れる場合も
 * malformed として扱う。
 */
test("processSubgroupObjects: mutable と IMMUTABLE_PROPERTIES の合算 2 回の Prior Group ID Gap で MalformedTrackError", () => {
  const { subscriber, header, stats } = subgroupTestSetup();
  const inner = encodeProperties([{ id: MOQTPropertyId.PRIOR_GROUP_ID_GAP, value: 0n }]);
  const properties = encodeProperties([
    { id: MOQTPropertyId.IMMUTABLE_PROPERTIES, data: inner },
    { id: MOQTPropertyId.PRIOR_GROUP_ID_GAP, value: 0n },
  ]);

  assert.throws(
    () =>
      processSubgroupObjects(
        objectWireWithProperties(0n, properties),
        [subscriber],
        header,
        -1n,
        stats,
        silentDelivery,
      ),
    MalformedTrackError,
    /more than one instance of PRIOR_GROUP_ID_GAP/,
  );
});

// ============================================================================
// draft-22 適合監査 D-8: END_OF_GROUP による Group 最終 Object の検出
// draft-ietf-moq-transport-23 §12.1
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §12.1 条件 4:
 * "An Object is received in a Group whose Object ID is larger than the final
 *  Object in the Group. The final Object in a Group is the Object with Status
 *  END_OF_GROUP ..."
 * END_OF_GROUP ステータスの Object の後に同一 Subgroup の Object が続くと
 * malformed となる。
 */
test("processSubgroupObjects: END_OF_GROUP ステータス後の Object は MalformedTrackError", () => {
  const { subscriber, header, stats } = subgroupTestSetup();
  const endOfGroupFields = encodeObjectFields(
    0n,
    0n,
    SubgroupHeaderType.BASE_EXT,
    ObjectStatus.END_OF_GROUP,
  );
  const nextFields = encodeObjectFields(0n, 1n, SubgroupHeaderType.BASE_EXT, ObjectStatus.NORMAL);
  const wire = concatChunks([endOfGroupFields, nextFields, new Uint8Array([0xbb])]);

  assert.throws(
    () => processSubgroupObjects(wire, [subscriber], header, -1n, stats, silentDelivery),
    MalformedTrackError,
    /exceeds final object/,
  );
});

/**
 * END_OF_GROUP ステータスの Object 自体は配信され、後続が無ければ
 * malformed にならないことを検証する (誤検出防止)。
 */
/**
 * draft-ietf-moq-transport-23 §12.1 条件 4 の Group 単位追跡:
 * 既知の最終 Object (他 Subgroup で確定済み) を `endOfGroup.finalObjectId` で
 * 受け取り、それより大きい Object ID を持つ Object を malformed として検出する。
 * Subgroup ストリーム (呼び出し) をまたいだ検出を検証する。
 */
test("processSubgroupObjects: 既知の Group 最終 Object を超える Object は MalformedTrackError", () => {
  const { subscriber, header, stats } = subgroupTestSetup();
  // 別 Subgroup でこの Group の最終 Object が Object ID 1 として確定済みとする。
  // この Subgroup の先頭 Object ID delta を 5 にすると Object ID 5 になり、
  // 既知の最終 Object 1 を超えるため malformed になる。
  const fields = encodeObjectFields(5n, 1n, SubgroupHeaderType.BASE_EXT, ObjectStatus.NORMAL);
  const wire = concatChunks([fields, new Uint8Array([0x01])]);

  assert.throws(
    () =>
      processSubgroupObjects(wire, [subscriber], header, -1n, stats, silentDelivery, undefined, {
        finalObjectId: 1n,
      }),
    MalformedTrackError,
    /exceeds final object 1/,
  );
});

/**
 * 既知の最終 Object と同じ Object ID までは malformed にしない (誤検出防止)。
 */
test("processSubgroupObjects: 既知の Group 最終 Object ちょうどまでは配信する", () => {
  const { delivered, subscriber, header, stats } = subgroupTestSetup();
  const nextFields = encodeObjectFields(0n, 1n, SubgroupHeaderType.BASE_EXT, ObjectStatus.NORMAL);
  const wire = concatChunks([nextFields, new Uint8Array([0x01])]);

  processSubgroupObjects(wire, [subscriber], header, -1n, stats, silentDelivery, undefined, {
    finalObjectId: 0n,
  });

  assert.equal(delivered.length, 1);
});

/**
 * draft-ietf-moq-transport-23 §12.1 条件 3 / 条件 4:
 * 同じ Group について既知の最終 Object より小さい Object が END_OF_GROUP を
 * 主張したら malformed とする。Group の最終 Object が二者に分かれる矛盾である。
 */
test("processSubgroupObjects: 既知の最終 Object より小さい END_OF_GROUP は MalformedTrackError", () => {
  const { subscriber, header, stats } = subgroupTestSetup();
  const endOfGroupFields = encodeObjectFields(
    0n,
    0n,
    SubgroupHeaderType.BASE_EXT,
    ObjectStatus.END_OF_GROUP,
  );

  assert.throws(
    () =>
      processSubgroupObjects(
        endOfGroupFields,
        [subscriber],
        header,
        -1n,
        stats,
        silentDelivery,
        undefined,
        { finalObjectId: 5n },
      ),
    MalformedTrackError,
    /smaller than known final object 5/,
  );
});

// ============================================================================
// processFetchObjects: End of Range indicator の受理
// draft-ietf-moq-transport-23 §11.4.2 / §11.4.2.1 / §2.1.2
// ============================================================================

/** processFetchObjects 用の実 Fetcher と統計の受け皿を組み立てる */
function fetchTestSetup(): {
  delivered: MoqtObject[];
  fetcher: FetcherImpl;
  stats: CountingStreamStats;
} {
  const delivered: MoqtObject[] = [];
  const fetcher = new FetcherImpl(["test"], "track", 0n, (object) => {
    delivered.push(object);
  });
  const stats = createCountingStreamStats();
  return { delivered, fetcher, stats };
}

/**
 * draft-ietf-moq-transport-23 §11.4.2:
 * End of Range indicator は Object ではないため配送も統計も行わず、復号した
 * Location だけを文脈として後続 Object に引き継ぐ (§11.4.2.1 / §11.4.2.2)。
 */
test("processFetchObjects: End of Range indicator は配送せず後続 Object の ID を復元する", () => {
  const { delivered, fetcher, stats } = fetchTestSetup();

  // 先頭 Object の固定ワイヤ: Flags 0x1F (GROUP_ID_PRESENT | OBJECT_ID_PRESENT |
  // PRIORITY_PRESENT | SUBGROUP_PRESENT)、Group 10、Subgroup 1、Object 5、
  // Priority 100、Object Payload Length 2、Payload [0xAA, 0xBB]
  const firstData = new Uint8Array([0x1f, 0x0a, 0x01, 0x05, 0x64, 0x02, 0xaa, 0xbb]);
  // End of Unknown Range: Group ID Delta 0 / Object ID Delta 3
  // → Group 10、Object 5 + 3 + 1 = 9
  const eorData = new Uint8Array([0x81, 0x0c, 0x00, 0x03]);
  // indicator 後の通常 Object: Flags 0x05 (SUBGROUP_SAME | OBJECT_ID_PRESENT)、
  // Object ID Delta 0 → 9 + 0 + 2 = 11、Payload Length 1、Payload [0xCC]
  const afterData = new Uint8Array([0x05, 0x00, 0x01, 0xcc]);

  const wire = new Uint8Array([...firstData, ...eorData, ...afterData]);
  const result = processFetchObjects(wire, fetcher, null, true, stats, GroupOrder.ASCENDING);

  // indicator は配送されず、実 Object 2 件だけが配送される
  assert.deepEqual(
    delivered.map((object) => object.objectId),
    [5n, 11n],
  );
  assert.deepEqual(
    delivered.map((object) => object.groupId),
    [10n, 10n],
  );
  // Subgroup ID / Priority は indicator より前の最後の実 Object から引き継ぐ
  assert.deepEqual(
    delivered.map((object) => object.subgroupId),
    [1n, 1n],
  );
  assert.deepEqual(
    delivered.map((object) => object.publisherPriority),
    [100, 100],
  );
  assert.deepEqual(
    delivered.map((object) => [...object.payload]),
    [[0xaa, 0xbb], [0xcc]],
  );
  // indicator は Object ではなくペイロードを持たないため、Object 数 / ペイロード
  // バイト数を増やさない
  assert.equal(stats.objectsReceived, 2);
  assert.equal(stats.bytesReceived, 3);
  assert.equal(result.remainingBuffer.byteLength, 0);
  assert.isFalse(result.isFirst);
  // 文脈は最後に配送した実 Object を指す
  assert.equal(result.context?.groupId, 10n);
  assert.equal(result.context?.objectId, 11n);
});

/**
 * draft-ietf-moq-transport-23 §11.4.2.1:
 * Descending では End of Range の Group ID が prior - Group Delta になり、
 * 後続 Object はその復号位置を prior に +2 で復元される。groupOrder を
 * processFetchObjects まで引き回す配線を Descending でも検証する。
 */
test("processFetchObjects: Descending の End of Range と後続 Object を復元する", () => {
  const { delivered, fetcher, stats } = fetchTestSetup();

  // 先頭 Object: Flags 0x1F、Group 10、Subgroup 1、Object 5、Priority 100、Payload 2
  const firstData = new Uint8Array([0x1f, 0x0a, 0x01, 0x05, 0x64, 0x02, 0xaa, 0xbb]);
  // End of Unknown Range (0x10C): Group ID Delta 2 → 10 - 2 = 8。
  // Group が変わるため Object ID Delta 1 は新しい Group の絶対 Object ID になり、
  // EOR の位置は {8, 1} になる。
  const eorData = new Uint8Array([0x81, 0x0c, 0x02, 0x01]);
  // indicator 後の通常 Object: Flags 0x05 (SUBGROUP_SAME | OBJECT_ID_PRESENT)、
  // Object ID Delta 0 → 1 + 0 + 2 = 3、Payload Length 0
  const afterData = new Uint8Array([0x05, 0x00, 0x00]);

  const wire = new Uint8Array([...firstData, ...eorData, ...afterData]);
  const result = processFetchObjects(wire, fetcher, null, true, stats, GroupOrder.DESCENDING);

  assert.deepEqual(
    delivered.map((object) => object.objectId),
    [5n, 3n],
  );
  assert.deepEqual(
    delivered.map((object) => object.groupId),
    [10n, 8n],
  );
  // Subgroup ID / Priority は EOR より前の実 Object から引き継ぐ
  assert.deepEqual(
    delivered.map((object) => object.subgroupId),
    [1n, 1n],
  );
  assert.deepEqual(
    delivered.map((object) => object.publisherPriority),
    [100, 100],
  );
  assert.equal(stats.objectsReceived, 2);
  assert.equal(result.remainingBuffer.byteLength, 0);
});

/**
 * draft-ietf-moq-transport-23 §11.4.2:
 * End of Range indicator の途中でチャンクが切れても、未消費バイトと context /
 * isFirst を保持して次の feed で復号を継続する。
 */
test("processFetchObjects: indicator を跨ぐ分割 feed で後続 Object を復元する", () => {
  const { delivered, fetcher, stats } = fetchTestSetup();

  // 先頭 Object の固定ワイヤ (Group 10 / Subgroup 1 / Object 5 / Priority 100)
  const firstData = new Uint8Array([0x1f, 0x0a, 0x01, 0x05, 0x64, 0x02, 0xaa, 0xbb]);
  // End of Unknown Range の Flags と Group ID Delta まで (Object ID Delta が欠ける)
  const partialEor = new Uint8Array([0x81, 0x0c, 0x00]);
  // Object ID Delta 3 → Object 9、その後の通常 Object は Delta 0 → 11
  const restEor = new Uint8Array([0x03]);
  const afterData = new Uint8Array([0x05, 0x00, 0x01, 0xcc]);

  const first = processFetchObjects(
    concatChunks([firstData, partialEor]),
    fetcher,
    null,
    true,
    stats,
    GroupOrder.ASCENDING,
  );
  // 先頭 Object だけが配送され、indicator の未消費バイトが残る
  assert.deepEqual(
    delivered.map((object) => object.objectId),
    [5n],
  );
  assert.deepEqual(first.remainingBuffer, partialEor);
  assert.isFalse(first.isFirst);
  assert.equal(first.context?.objectId, 5n);

  const second = processFetchObjects(
    concatChunks([first.remainingBuffer, restEor, afterData]),
    fetcher,
    first.context,
    first.isFirst,
    stats,
    GroupOrder.ASCENDING,
  );
  // indicator は配送されず、後続 Object が 9 + 0 + 2 = 11 で復元される
  assert.deepEqual(
    delivered.map((object) => object.objectId),
    [5n, 11n],
  );
  assert.equal(second.remainingBuffer.byteLength, 0);
  assert.equal(second.context?.objectId, 11n);
});

/**
 * draft-ietf-moq-transport-23 §2.1.2:
 * "receiving an Object that was recorded as Gone or Unknown is not an error."
 * End of Gone Range の直後に実 Object が届いても拒否せず配送する。
 */
test("processFetchObjects: End of Gone Range の後の実 Object を配送する", () => {
  const { delivered, fetcher, stats } = fetchTestSetup();

  // FETCH_HEADER 直後の End of Gone Range: Group 10 / Object 5 の絶対値
  const eorData = new Uint8Array([0x84, 0x0c, 0x0a, 0x05]);
  // 同じ Group の実 Object: Flags 0x17
  // (SUBGROUP_PRESENT | OBJECT_ID_PRESENT | PRIORITY_PRESENT)、Subgroup 1、
  // Object ID Delta 0 → 5 + 0 + 2 = 7、Priority 70、Payload Length 0
  const objectData = new Uint8Array([0x17, 0x01, 0x00, 0x46, 0x00]);

  const wire = new Uint8Array([...eorData, ...objectData]);
  processFetchObjects(wire, fetcher, null, true, stats, GroupOrder.ASCENDING);

  assert.equal(delivered.length, 1);
  assert.deepEqual(
    delivered.map((object) => object.groupId),
    [10n],
  );
  assert.deepEqual(
    delivered.map((object) => object.subgroupId),
    [1n],
  );
  assert.deepEqual(
    delivered.map((object) => object.objectId),
    [7n],
  );
  assert.deepEqual(
    delivered.map((object) => object.publisherPriority),
    [70],
  );
  assert.equal(stats.objectsReceived, 1);
});

/**
 * draft-ietf-moq-transport-23 §11.4.2:
 * End of Range indicator は Group ID Delta / Object ID Delta を常に持つ。
 * 途中で切れた場合は配送せず、そのまま次のチャンクを待つ (未消費バイトを残す)。
 */
test("processFetchObjects: 不完全な End of Range indicator は未消費バイトとして残す", () => {
  const { delivered, fetcher, stats } = fetchTestSetup();

  // Flags 0x40C と Group ID Delta までで、Object ID Delta が欠けている
  const wire = new Uint8Array([0x84, 0x0c, 0x0a]);
  const result = processFetchObjects(wire, fetcher, null, true, stats, GroupOrder.ASCENDING);

  assert.equal(delivered.length, 0);
  assert.equal(stats.objectsReceived, 0);
  assert.equal(stats.bytesReceived, 0);
  // 復号できなかった先頭バイトからそのまま残す
  assert.deepEqual(result.remainingBuffer, wire);
  // 先頭エントリーのままなので isFirst は変わらない
  assert.isTrue(result.isFirst);
  assert.isNull(result.context);
});

// ============================================================================
// processFetchObjects: End of Group / End of Track indicator の受理
// draft-ietf-moq-transport-23 §11.4.2.2 / §12.1
// ============================================================================

/** 実 Object 1 件分の Fetch Object ワイヤを組み立てる (先頭 Object として絶対 ID) */
function fetchObjectWire(
  groupId: bigint,
  subgroupId: bigint,
  objectId: bigint,
  publisherPriority: number,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const fields: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(false),
    groupId,
    subgroupId,
    objectId,
    publisherPriority,
    payloadLength: BigInt(payload.byteLength),
  };
  return concatChunks([encodeFetchObjectFields(fields, true), payload]);
}

/** End of Group / End of Track の Flags だけのワイヤを組み立てる */
function fetchStreamEndWire(flags: number): Uint8Array {
  return encodeFetchObjectFields({ serializationFlags: flags, payloadLength: 0n });
}

/** 追跡対象 Track のターゲットを作る */
function fetchTrackingTarget(trackName = "track"): PriorGapTrackingTarget {
  return { trackingByTrack: new Map(), trackKey: fullTrackNameKey(["test"], trackName) };
}

/**
 * draft-ietf-moq-transport-23 §11.4.2.2:
 * End of Group (0x80) / End of Track (0x81) は Object ではないため配送も統計計上も
 * 行わない。直前の実 Object を終端として復号文脈に保持し、0x81 の受理で
 * Fetcher.endOfTrack が true になる (0x80 だけでは変化しない)。
 */
test("processFetchObjects: End of Group は配送も統計も増やさず endOfTrack を変えず、End of Track の受理で true になる", () => {
  const { delivered, fetcher, stats } = fetchTestSetup();

  // 実 Object (Group 10 / Subgroup 1 / Object 5 / Priority 100 / Payload 2 バイト)
  const objectWire = fetchObjectWire(10n, 1n, 5n, 100, new Uint8Array([0xaa, 0xbb]));
  // End of Group までを 1 回の feed で処理する
  const result = processFetchObjects(
    concatChunks([objectWire, fetchStreamEndWire(FetchSerializationFlags.END_OF_GROUP)]),
    fetcher,
    null,
    true,
    stats,
    GroupOrder.ASCENDING,
  );

  // indicator は配送されず、統計も増えない
  assert.equal(delivered.length, 1);
  assert.equal(stats.objectsReceived, 1);
  assert.equal(stats.bytesReceived, 2);
  // End of Group だけでは Track の終端確認にならない
  assert.isFalse(fetcher.endOfTrack);
  // prior Object ID は 2^64-1、最後の実 Object の位置は保持される
  assert.equal(result.context?.objectId, MAX_VARINT);
  assert.deepEqual(result.context?.lastActualObject, { groupId: 10n, objectId: 5n });
  assert.equal(result.remainingBuffer.byteLength, 0);

  // End of Track を続けて受理すると endOfTrack が true になる
  const endResult = processFetchObjects(
    fetchStreamEndWire(FetchSerializationFlags.END_OF_TRACK),
    fetcher,
    result.context,
    result.isFirst,
    stats,
    GroupOrder.ASCENDING,
  );
  assert.isTrue(fetcher.endOfTrack);
  assert.equal(delivered.length, 1);
  assert.equal(stats.objectsReceived, 1);
  assert.equal(stats.bytesReceived, 2);
  assert.equal(endResult.context?.objectId, MAX_VARINT);
  assert.deepEqual(endResult.context?.lastActualObject, { groupId: 10n, objectId: 5n });
});

/**
 * draft-ietf-moq-transport-23 §11.4.2.2:
 * indicator の Flags (vi64) がチャンク末尾で切れても、未消費バイトと復号文脈を
 * 保持して次のチャンクで処理を継続する。後続の Group 変更 Object も復号できる。
 */
test("processFetchObjects: チャンク末尾の indicator を次のチャンクで処理する", () => {
  const { delivered, fetcher, stats } = fetchTestSetup();

  const objectWire = fetchObjectWire(10n, 1n, 5n, 100);
  const endOfGroupWire = fetchStreamEndWire(FetchSerializationFlags.END_OF_GROUP);
  const endOfTrackWire = fetchStreamEndWire(FetchSerializationFlags.END_OF_TRACK);

  // 1 回目: 実 Object と End of Group の 1 バイト目だけで終わる
  const first = processFetchObjects(
    concatChunks([objectWire, endOfGroupWire.slice(0, 1)]),
    fetcher,
    null,
    true,
    stats,
    GroupOrder.ASCENDING,
  );
  // 実 Object だけが配送され、Flags の未消費バイトが残る
  assert.equal(delivered.length, 1);
  assert.deepEqual(first.remainingBuffer, endOfGroupWire.slice(0, 1));
  assert.equal(first.context?.objectId, 5n);
  assert.isFalse(fetcher.endOfTrack);

  // 2 回目: 未消費バイト + End of Group の残り + End of Track
  const second = processFetchObjects(
    concatChunks([first.remainingBuffer, endOfGroupWire.slice(1), endOfTrackWire]),
    fetcher,
    first.context,
    first.isFirst,
    stats,
    GroupOrder.ASCENDING,
  );
  assert.equal(second.remainingBuffer.byteLength, 0);
  assert.isTrue(fetcher.endOfTrack);
  assert.equal(delivered.length, 1);
  assert.equal(stats.objectsReceived, 1);
  assert.equal(second.context?.objectId, MAX_VARINT);
  assert.deepEqual(second.context?.lastActualObject, { groupId: 10n, objectId: 5n });
});

/**
 * draft-ietf-moq-transport-23 §11.4.2.2:
 * 前提となる実 Object を受信していない End of Group / End of Track は、存在しない
 * prior Object への参照として拒否する (エラー分類の移行までは PROTOCOL_VIOLATION)。
 */
test("processFetchObjects: 実 Object の無い End of Group / End of Track は ProtocolViolationError", () => {
  const { delivered, fetcher, stats } = fetchTestSetup();

  assert.throws(
    () =>
      processFetchObjects(
        fetchStreamEndWire(FetchSerializationFlags.END_OF_GROUP),
        fetcher,
        null,
        true,
        stats,
        GroupOrder.ASCENDING,
      ),
    ProtocolViolationError,
    /requires a prior actual object/,
  );
  assert.equal(delivered.length, 0);
  assert.equal(stats.objectsReceived, 0);
});

/**
 * draft-ietf-moq-transport-23 §12.1 条件 4:
 * "An Object is received in a Group whose Object ID is larger than the final
 *  Object in the Group."
 * FETCH の End of Group が確定した Group の最終 Object より大きい Object は、
 * 同じ Track の後続 FETCH でも malformed である。End of Group は Track の終端では
 * ないため、別 Group の Object は拒否しない。
 */
test("processFetchObjects: 後続 FETCH の Object が確定済み Group 終端を超えると MalformedTrackError", () => {
  const target = fetchTrackingTarget();
  const first = fetchTestSetup();

  // 1 本目の FETCH: Group 10 / Object 5 を最終 Object とする End of Group
  processFetchObjects(
    concatChunks([
      fetchObjectWire(10n, 1n, 5n, 100),
      fetchStreamEndWire(FetchSerializationFlags.END_OF_GROUP),
    ]),
    first.fetcher,
    null,
    true,
    first.stats,
    GroupOrder.ASCENDING,
    target,
  );

  // 2 本目の FETCH: 同じ Group 10 の Object 6 は確定済み最終 Object を超える
  const second = fetchTestSetup();
  assert.throws(
    () =>
      processFetchObjects(
        fetchObjectWire(10n, 1n, 6n, 100),
        second.fetcher,
        null,
        true,
        second.stats,
        GroupOrder.ASCENDING,
        target,
      ),
    MalformedTrackError,
    /exceeds final object 5 in group 10/,
  );
  assert.equal(second.delivered.length, 0);
  // 拒否した Object は Track の受信状態に登録されない (登録は検証通過後)
  const received = target.trackingByTrack.get(target.trackKey)?.receivedObjectIdsByGroup.get(10n);
  assert.isFalse(received?.has(6n) ?? false);

  // 別 Group 11 の Object は End of Group の制約を受けない
  const third = fetchTestSetup();
  processFetchObjects(
    fetchObjectWire(11n, 1n, 0n, 100),
    third.fetcher,
    null,
    true,
    third.stats,
    GroupOrder.ASCENDING,
    target,
  );
  assert.equal(third.delivered.length, 1);
});

/**
 * draft-ietf-moq-transport-23 §12.1 条件 5:
 * "An Object is received whose Group and Object ID are larger than the final
 *  Object in the Track."
 * FETCH の End of Track が確定した Track の最終 Object より後の Object は、同じ
 * Track の後続 FETCH でも malformed である。
 */
test("processFetchObjects: 後続 FETCH の Object が確定済み Track 終端より後だと MalformedTrackError", () => {
  const target = fetchTrackingTarget();
  const first = fetchTestSetup();

  // 1 本目の FETCH: Group 10 / Object 5 を Track の最終 Object とする End of Track
  processFetchObjects(
    concatChunks([
      fetchObjectWire(10n, 1n, 5n, 100),
      fetchStreamEndWire(FetchSerializationFlags.END_OF_TRACK),
    ]),
    first.fetcher,
    null,
    true,
    first.stats,
    GroupOrder.ASCENDING,
    target,
  );

  // 2 本目の FETCH: 最終 Object より後の Group 11 の Object は malformed
  const second = fetchTestSetup();
  assert.throws(
    () =>
      processFetchObjects(
        fetchObjectWire(11n, 1n, 0n, 100),
        second.fetcher,
        null,
        true,
        second.stats,
        GroupOrder.ASCENDING,
        target,
      ),
    MalformedTrackError,
    /is after final object 10:5 in track/,
  );
  assert.equal(second.delivered.length, 0);
});

/**
 * draft-ietf-moq-transport-23 §11.4.2.2 / §12.1 条件 4:
 * FETCH の End of Group で確定した終端は、同じ Track の Subgroup ストリームにも
 * 適用する。Group の最終 Object を超える Subgroup Object は malformed である。
 */
test("processSubgroupObjects: FETCH の Group 終端を超える Subgroup Object は MalformedTrackError", () => {
  const { delivered, subscriber, header, stats } = subgroupTestSetup();
  const target = fetchTrackingTarget();

  // 同じ Track の FETCH が Group 10 / Object 5 を最終 Object として確定した状態
  recordFetchObjectEnd(target, { kind: "end_of_group", groupId: 10n, objectId: 5n });

  // Subgroup ストリーム (Group 10) の先頭 Object 6 は確定済み最終 Object を超える
  const beyondFinalWire = encodeObjectFields(
    6n,
    0n,
    SubgroupHeaderType.BASE_EXT,
    ObjectStatus.NORMAL,
  );
  assert.throws(
    () =>
      processSubgroupObjects(
        beyondFinalWire,
        [subscriber],
        { ...header, groupId: 10n },
        -1n,
        stats,
        silentDelivery,
        undefined,
        {},
        target,
      ),
    MalformedTrackError,
    /exceeds final object 5 in group 10/,
  );
  assert.equal(delivered.length, 0);

  // 最終 Object ちょうどまでは配送する
  const finalWire = encodeObjectFields(5n, 0n, SubgroupHeaderType.BASE_EXT, ObjectStatus.NORMAL);
  processSubgroupObjects(
    finalWire,
    [subscriber],
    { ...header, groupId: 10n },
    -1n,
    stats,
    silentDelivery,
    undefined,
    {},
    target,
  );
  assert.equal(delivered.length, 1);
});

// ============================================================================
// processFetchObjects: FETCH 応答の非存在 gap の追跡
// draft-ietf-moq-transport-23 §3.2.2 (Gaps in a Fetch Stream) / §12.1 条件 10
// ============================================================================

/** FETCH 要求の範囲と Range Filter の有無 (末尾 gap は FIN 処理が担当する) */
function fetchGapSemantics(
  startGroup: bigint,
  startObject: bigint,
  endGroup: bigint,
  endObject: bigint,
  rangeFiltersPresent = false,
): FetchGapSemantics {
  return {
    startLocation: { group: startGroup, object: startObject },
    endLocation: { group: endGroup, object: endObject },
    rangeFiltersPresent,
  };
}

/** End of Range indicator のワイヤを組み立てる (先頭エントリーは絶対 ID) */
function endOfRangeWire(
  flags: number,
  groupId: bigint,
  objectId: bigint,
  context: FetchObjectContext | null,
  groupOrder: GroupOrder = GroupOrder.ASCENDING,
): Uint8Array {
  return encodeFetchObjectFields(
    { serializationFlags: flags, groupId, objectId, payloadLength: 0n },
    false,
    context,
    groupOrder,
  );
}

/**
 * draft-ietf-moq-transport-23 §3.2.2:
 * End of Non-Existent Range が明示した範囲を非存在として記録し、その範囲内の
 * Object を後続の受信経路 (FETCH) で受信したら malformed Track とする。
 * 同じ Track の別 FETCH をまたいだ矛盾検出である。
 */
test("processFetchObjects: End of Non-Existent Range 内の Object を後続 FETCH で拒否する", () => {
  const target = fetchTrackingTarget();
  const first = fetchTestSetup();
  const gap = fetchGapSemantics(10n, 0n, 10n, 9n);

  // 1 本目: Object (10:5) の後に End of Non-Existent Range (10:9)。
  // 範囲は直前の Object の次から 10:9 までである。End of Range の ID は直前の
  // Object を基準にした delta で符号化する (§11.4.2.1) ため、1 件目を処理して
  // 得た context を使ってワイヤを組み立てる
  const objectResult = processFetchObjects(
    fetchObjectWire(10n, 1n, 5n, 100),
    first.fetcher,
    null,
    true,
    first.stats,
    GroupOrder.ASCENDING,
    target,
    gap,
  );
  assert.equal(first.delivered.length, 1);
  const eor = endOfRangeWire(
    FetchSerializationFlags.END_OF_NON_EXISTENT_RANGE,
    10n,
    9n,
    objectResult.context,
  );
  processFetchObjects(
    eor,
    first.fetcher,
    objectResult.context,
    objectResult.isFirst,
    first.stats,
    GroupOrder.ASCENDING,
    target,
    gap,
  );
  assert.equal(first.delivered.length, 1);

  // 2 本目: 非存在範囲内の Object (10:7) は malformed
  const second = fetchTestSetup();
  assert.throws(
    () =>
      processFetchObjects(
        fetchObjectWire(10n, 1n, 7n, 100),
        second.fetcher,
        null,
        true,
        second.stats,
        GroupOrder.ASCENDING,
        target,
        fetchGapSemantics(10n, 7n, 10n, 9n),
      ),
    MalformedTrackError,
    /signalled as not existing/,
  );
  assert.equal(second.delivered.length, 0);

  // 非存在範囲の手前の Object (10:5) は受理する
  const third = fetchTestSetup();
  processFetchObjects(
    fetchObjectWire(10n, 1n, 5n, 100),
    third.fetcher,
    null,
    true,
    third.stats,
    GroupOrder.ASCENDING,
    target,
    fetchGapSemantics(10n, 5n, 10n, 9n),
  );
  assert.equal(third.delivered.length, 1);
});

/**
 * draft-ietf-moq-transport-23 §3.2.2 / §11.4.2:
 * End of Non-Existent Range は「マークされた」非存在通知であり、Range Filter を
 * 含む要求でも非存在として記録する ("unmarked gaps" の既定則はマークされて
 * いない gap にだけ適用される)。範囲内の Object を後続 FETCH で拒否する。
 */
test("processFetchObjects: Range Filter 付きの End of Non-Existent Range も非存在として記録する", () => {
  const target = fetchTrackingTarget();
  const first = fetchTestSetup();
  // Range Filter を含む要求 (rangeFiltersPresent = true)
  const gap = fetchGapSemantics(10n, 0n, 10n, 9n, true);

  const objectResult = processFetchObjects(
    fetchObjectWire(10n, 1n, 5n, 100),
    first.fetcher,
    null,
    true,
    first.stats,
    GroupOrder.ASCENDING,
    target,
    gap,
  );
  assert.equal(first.delivered.length, 1);
  processFetchObjects(
    endOfRangeWire(
      FetchSerializationFlags.END_OF_NON_EXISTENT_RANGE,
      10n,
      9n,
      objectResult.context,
    ),
    first.fetcher,
    objectResult.context,
    objectResult.isFirst,
    first.stats,
    GroupOrder.ASCENDING,
    target,
    gap,
  );

  // 非存在範囲内の Object (10:7) は、Range Filter の有無に関わらず malformed
  const second = fetchTestSetup();
  assert.throws(
    () =>
      processFetchObjects(
        fetchObjectWire(10n, 1n, 7n, 100),
        second.fetcher,
        null,
        true,
        second.stats,
        GroupOrder.ASCENDING,
        target,
        fetchGapSemantics(10n, 7n, 10n, 9n, true),
      ),
    MalformedTrackError,
    /signalled as not existing/,
  );
});

/**
 * draft-ietf-moq-transport-23 §11.4.2:
 * fill fetch は要求範囲を保持しないため暗黙 gap は推論しないが、明示された
 * End of Non-Existent Range は通知そのものであり、直前のエントリーから復号位置
 * までを非存在として記録する。範囲内の Object を後続経路で拒否する。
 */
test("processFetchObjects: fill fetch (要求範囲なし) でも End of Non-Existent Range を記録する", () => {
  const target = fetchTrackingTarget();
  const first = fetchTestSetup();

  // fetchGap を渡さない (fill fetch 相当)
  const objectResult = processFetchObjects(
    fetchObjectWire(10n, 1n, 5n, 100),
    first.fetcher,
    null,
    true,
    first.stats,
    GroupOrder.ASCENDING,
    target,
  );
  assert.equal(first.delivered.length, 1);
  processFetchObjects(
    endOfRangeWire(
      FetchSerializationFlags.END_OF_NON_EXISTENT_RANGE,
      10n,
      9n,
      objectResult.context,
    ),
    first.fetcher,
    objectResult.context,
    objectResult.isFirst,
    first.stats,
    GroupOrder.ASCENDING,
    target,
  );

  // 非存在範囲内の Object (10:7) は malformed
  const second = fetchTestSetup();
  assert.throws(
    () =>
      processFetchObjects(
        fetchObjectWire(10n, 1n, 7n, 100),
        second.fetcher,
        null,
        true,
        second.stats,
        GroupOrder.ASCENDING,
        target,
      ),
    MalformedTrackError,
    /signalled as not existing/,
  );
});

/**
 * draft-ietf-moq-transport-23 §3.2.2:
 * "Unless the request included Range Filters ... any gaps in the Group and
 *  Object IDs in the response stream that are not otherwise marked indicate
 *  objects that do not exist."
 * Range Filter を含まない FETCH の暗黙 gap を非存在として記録し、別経路でその
 * 位置を受信したら malformed Track とする。
 */
test("processFetchObjects: Range Filter が無い FETCH の暗黙 gap を非存在として記録する", () => {
  const target = fetchTrackingTarget();
  const { delivered, fetcher, stats } = fetchTestSetup();
  const gap = fetchGapSemantics(10n, 0n, 10n, 9n);

  // Group 10 の Object 0 の後に Object 3 が届き、その間 (0:1-0:2) が暗黙 gap になる
  const firstResult = processFetchObjects(
    fetchObjectWire(10n, 1n, 0n, 100),
    fetcher,
    null,
    true,
    stats,
    GroupOrder.ASCENDING,
    target,
    gap,
  );
  processFetchObjects(
    encodeFetchObjectFields(
      {
        serializationFlags:
          FetchSerializationFlags.SUBGROUP_SAME | FetchSerializationFlags.OBJECT_ID_PRESENT,
        objectId: 3n,
        payloadLength: 0n,
      },
      false,
      firstResult.context,
      GroupOrder.ASCENDING,
    ),
    fetcher,
    firstResult.context,
    firstResult.isFirst,
    stats,
    GroupOrder.ASCENDING,
    target,
    gap,
  );
  assert.equal(delivered.length, 2);

  // 別経路 (subgroup) で暗黙 gap 内の Object を受信すると malformed
  const subgroup = subgroupTestSetup();
  const gapObjectWire = encodeObjectFields(
    2n,
    0n,
    SubgroupHeaderType.BASE_EXT,
    ObjectStatus.NORMAL,
  );
  assert.throws(
    () =>
      processSubgroupObjects(
        gapObjectWire,
        [subgroup.subscriber],
        { ...subgroup.header, groupId: 10n },
        -1n,
        subgroup.stats,
        silentDelivery,
        undefined,
        {},
        target,
      ),
    MalformedTrackError,
    /signalled as not existing/,
  );
  assert.equal(subgroup.delivered.length, 0);

  // gap の外 (10:4) は受理する
  const allowedWire = encodeObjectFields(4n, 0n, SubgroupHeaderType.BASE_EXT, ObjectStatus.NORMAL);
  processSubgroupObjects(
    allowedWire,
    [subgroup.subscriber],
    { ...subgroup.header, groupId: 10n },
    -1n,
    subgroup.stats,
    silentDelivery,
    undefined,
    {},
    target,
  );
  assert.equal(subgroup.delivered.length, 1);
});

/**
 * draft-ietf-moq-transport-23 §3.2.2:
 * "When one or more Range Filters are present, unmarked gaps indicate objects in
 *  the Unknown state."
 * Range Filter を含む FETCH の暗黙 gap は非存在ではないため、その位置の Object を
 * 後から受信しても拒否しない。
 */
test("processFetchObjects: Range Filter を含む FETCH の暗黙 gap は非存在と誤認しない", () => {
  const target = fetchTrackingTarget();
  const { delivered, fetcher, stats } = fetchTestSetup();
  const gap = fetchGapSemantics(10n, 0n, 10n, 9n, true);

  // Object 0 の後に Object 3 が届く (間に 0:1-0:2 の無印 gap)
  const firstResult = processFetchObjects(
    fetchObjectWire(10n, 1n, 0n, 100),
    fetcher,
    null,
    true,
    stats,
    GroupOrder.ASCENDING,
    target,
    gap,
  );
  processFetchObjects(
    encodeFetchObjectFields(
      {
        serializationFlags:
          FetchSerializationFlags.SUBGROUP_SAME | FetchSerializationFlags.OBJECT_ID_PRESENT,
        objectId: 3n,
        payloadLength: 0n,
      },
      false,
      firstResult.context,
      GroupOrder.ASCENDING,
    ),
    fetcher,
    firstResult.context,
    firstResult.isFirst,
    stats,
    GroupOrder.ASCENDING,
    target,
    gap,
  );
  assert.equal(delivered.length, 2);

  // Range Filter があるため gap は Unknown であり、subgroup で 10:2 を受信しても
  // malformed にしない
  const subgroup = subgroupTestSetup();
  const unknownObjectWire = encodeObjectFields(
    2n,
    0n,
    SubgroupHeaderType.BASE_EXT,
    ObjectStatus.NORMAL,
  );
  processSubgroupObjects(
    unknownObjectWire,
    [subgroup.subscriber],
    { ...subgroup.header, groupId: 10n },
    -1n,
    subgroup.stats,
    silentDelivery,
    undefined,
    {},
    target,
  );
  assert.equal(subgroup.delivered.length, 1);
});

/**
 * draft-ietf-moq-transport-23 §3.2.2:
 * gap は "ranges between the Start Location and the first object in the stream"
 * も含む。先頭 Object より前の暗黙 gap も非存在として記録する。
 */
test("processFetchObjects: 先頭 Object より前の暗黙 gap を非存在として記録する", () => {
  const target = fetchTrackingTarget();
  const { delivered, fetcher, stats } = fetchTestSetup();

  // Start Location (10:0) から最初の Object (10:5) の前までが gap になる
  processFetchObjects(
    fetchObjectWire(10n, 1n, 5n, 100),
    fetcher,
    null,
    true,
    stats,
    GroupOrder.ASCENDING,
    target,
    fetchGapSemantics(10n, 0n, 10n, 9n),
  );
  assert.equal(delivered.length, 1);

  // gap 内の Object を別経路で受信すると malformed
  const subgroup = subgroupTestSetup();
  const gapObjectWire = encodeObjectFields(
    3n,
    0n,
    SubgroupHeaderType.BASE_EXT,
    ObjectStatus.NORMAL,
  );
  assert.throws(
    () =>
      processSubgroupObjects(
        gapObjectWire,
        [subgroup.subscriber],
        { ...subgroup.header, groupId: 10n },
        -1n,
        subgroup.stats,
        silentDelivery,
        undefined,
        {},
        target,
      ),
    MalformedTrackError,
    /signalled as not existing/,
  );

  // 先頭 Object より後は受理する
  const afterWire = encodeObjectFields(6n, 0n, SubgroupHeaderType.BASE_EXT, ObjectStatus.NORMAL);
  processSubgroupObjects(
    afterWire,
    [subgroup.subscriber],
    { ...subgroup.header, groupId: 10n },
    -1n,
    subgroup.stats,
    silentDelivery,
    undefined,
    {},
    target,
  );
  assert.equal(subgroup.delivered.length, 1);
});

/**
 * draft-ietf-moq-transport-23 §2.1.2:
 * "receiving an Object that was recorded as Gone or Unknown is not an error."
 * Gone / Unknown / Timed-Out の End of Range は非存在の断定ではないため、
 * その範囲の内側 / 外側を問わず、後の実 Object を拒否しない。
 */
test("processFetchObjects: Gone / Unknown / Timed-Out の後の実 Object を受理する", () => {
  const flagsList = [
    FetchSerializationFlags.END_OF_UNKNOWN_RANGE,
    FetchSerializationFlags.END_OF_TIMED_OUT_RANGE,
    FetchSerializationFlags.END_OF_GONE_RANGE,
  ] as const;

  for (const flags of flagsList) {
    const target = fetchTrackingTarget();
    const { delivered, fetcher, stats } = fetchTestSetup();
    const gap = fetchGapSemantics(10n, 0n, 10n, 9n);

    // 先頭エントリーの End of Range (絶対 ID) を受理する。直前のエントリーが
    // 無いため、この indicator が覆う範囲は要求範囲の先頭 (10:0) から 10:5 まで
    // である。Gone / Unknown / Timed-Out はその範囲を非存在として記録しない。
    const eorResult = processFetchObjects(
      endOfRangeWire(flags, 10n, 5n, null),
      fetcher,
      null,
      true,
      stats,
      GroupOrder.ASCENDING,
      target,
      gap,
    );
    assert.equal(delivered.length, 0, `End of Range flags=0x${flags.toString(16)} は配送しない`);

    // End of Range が覆う範囲の内側 (10:3) の Object を別経路 (subgroup) で受信して
    // も、Gone / Unknown / Timed-Out は非存在の断定ではないため受理する
    const subgroup = subgroupTestSetup();
    const insideWire = encodeObjectFields(3n, 0n, SubgroupHeaderType.BASE_EXT, ObjectStatus.NORMAL);
    processSubgroupObjects(
      insideWire,
      [subgroup.subscriber],
      { ...subgroup.header, groupId: 10n },
      -1n,
      subgroup.stats,
      silentDelivery,
      undefined,
      {},
      target,
    );
    assert.equal(
      subgroup.delivered.length,
      1,
      `End of Range flags=0x${flags.toString(16)} の範囲内の Object は受理する`,
    );

    // End of Range の後の実 Object も拒否しない (Gone / Unknown / Timed-Out は
    // 非存在ではない)
    processFetchObjects(
      encodeFetchObjectFields(
        {
          serializationFlags:
            FetchSerializationFlags.SUBGROUP_PRESENT |
            FetchSerializationFlags.OBJECT_ID_PRESENT |
            FetchSerializationFlags.PRIORITY_PRESENT,
          subgroupId: 1n,
          objectId: 7n,
          publisherPriority: 100,
          payloadLength: 0n,
        },
        false,
        eorResult.context,
        GroupOrder.ASCENDING,
      ),
      fetcher,
      eorResult.context,
      eorResult.isFirst,
      stats,
      GroupOrder.ASCENDING,
      target,
      gap,
    );
    assert.equal(
      delivered.length,
      1,
      `End of Range flags=0x${flags.toString(16)} の後の Object は受理する`,
    );
  }
});

/**
 * draft-ietf-moq-transport-23 §11.1.1 (Object Status) / §12.1 条件 10:
 * 通常購読の Object Status END_OF_GROUP は Group の残りが存在しないことを
 * 通知する。同じ Track の別 Subgroup ストリームで後続 Object を受信したら
 * malformed Track である。
 */
test("processSubgroupObjects: Object Status END_OF_GROUP の後の Object を別 Subgroup で拒否する", () => {
  const target = fetchTrackingTarget();
  const { delivered, subscriber, header, stats } = subgroupTestSetup();
  const groupHeader = { ...header, groupId: 10n };

  // Group 10 の Object 5 を最終 Object とする END_OF_GROUP
  const endOfGroupWire = encodeObjectFields(
    5n,
    0n,
    SubgroupHeaderType.BASE_EXT,
    ObjectStatus.END_OF_GROUP,
  );
  processSubgroupObjects(
    endOfGroupWire,
    [subscriber],
    groupHeader,
    -1n,
    stats,
    silentDelivery,
    undefined,
    {},
    target,
  );
  assert.equal(delivered.length, 1);

  // 別 Subgroup ストリームで後続 Object 6 を受信すると malformed
  const beyondWire = encodeObjectFields(6n, 0n, SubgroupHeaderType.BASE_EXT, ObjectStatus.NORMAL);
  assert.throws(
    () =>
      processSubgroupObjects(
        beyondWire,
        [subscriber],
        { ...groupHeader, subgroupId: 1n, type: SubgroupHeaderType.BASE_EXT },
        -1n,
        stats,
        silentDelivery,
        undefined,
        {},
        target,
      ),
    MalformedTrackError,
    /signalled as not existing/,
  );
  assert.equal(delivered.length, 1);

  // 通知より前の Object 4 は受理する
  const beforeWire = encodeObjectFields(4n, 0n, SubgroupHeaderType.BASE_EXT, ObjectStatus.NORMAL);
  processSubgroupObjects(
    beforeWire,
    [subscriber],
    { ...groupHeader, subgroupId: 2n },
    -1n,
    stats,
    silentDelivery,
    undefined,
    {},
    target,
  );
  assert.equal(delivered.length, 2);
});

/**
 * draft-ietf-moq-transport-23 §3.2.2 / §12.1 条件 10:
 * Range Filter を含まない FETCH の暗黙 gap は、別経路で先に受信済みの Object を
 * 覆う場合に malformed Track とする ("... or is signalled as not existing after
 * it was received" の方向)。FETCH 応答の 2 件目の Object を処理した時点で、
 * その間の gap が受信済み位置と突き合わされる。
 */
test("processFetchObjects: 受信済み Object を覆う暗黙 gap は MalformedTrackError", () => {
  const target = fetchTrackingTarget();

  // 別経路 (subgroup) で Group 10 の Object 2 を先に受信しておく
  const subgroup = subgroupTestSetup();
  const receivedWire = encodeObjectFields(2n, 0n, SubgroupHeaderType.BASE_EXT, ObjectStatus.NORMAL);
  processSubgroupObjects(
    receivedWire,
    [subgroup.subscriber],
    { ...subgroup.header, groupId: 10n },
    -1n,
    subgroup.stats,
    silentDelivery,
    undefined,
    {},
    target,
  );
  assert.equal(subgroup.delivered.length, 1);

  // FETCH 応答: Object 0 の後に Object 3 が届き、間の 10:1-10:2 が暗黙 gap になる。
  // 受信済みの 10:2 を覆うため malformed である
  const { delivered, fetcher, stats } = fetchTestSetup();
  const gap = fetchGapSemantics(10n, 0n, 10n, 9n);
  const firstResult = processFetchObjects(
    fetchObjectWire(10n, 1n, 0n, 100),
    fetcher,
    null,
    true,
    stats,
    GroupOrder.ASCENDING,
    target,
    gap,
  );
  assert.throws(
    () =>
      processFetchObjects(
        encodeFetchObjectFields(
          {
            serializationFlags:
              FetchSerializationFlags.SUBGROUP_SAME | FetchSerializationFlags.OBJECT_ID_PRESENT,
            objectId: 3n,
            payloadLength: 0n,
          },
          false,
          firstResult.context,
          GroupOrder.ASCENDING,
        ),
        fetcher,
        firstResult.context,
        firstResult.isFirst,
        stats,
        GroupOrder.ASCENDING,
        target,
        gap,
      ),
    MalformedTrackError,
    /includes already received object/,
  );
  assert.equal(delivered.length, 1);
});
