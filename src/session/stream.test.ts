/**
 * session/stream.ts の純粋関数の単体テスト
 */

import { test, assert } from "vite-plus/test";
import {
  concatChunks,
  processFetchObjects,
  processSubgroupObjects,
  type SubgroupDeliveryHooks,
} from "./stream";
import { createCountingStreamStats, type CountingStreamStats } from "../testSupport/streamStats";
import {
  encodeObjectFields,
  SubgroupHeaderType,
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
import { MalformedTrackError } from "../error";

// ============================================================================
// processSubgroupObjects の先頭オブジェクト判定
// draft-ietf-moq-transport-22 §5.2 / §10.1 / §10.2
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

// draft-ietf-moq-transport-22 §10.4 (DEFAULT PUBLISHER_PRIORITY) / §11.3.1:
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
// draft-ietf-moq-transport-22 §5.2 / §2.2
// ============================================================================

/**
 * draft-ietf-moq-transport-22 §2.2:
 * "When the Original Publisher opens a new subgroup, it MUST set the
 *  FIRST_OBJECT bit ... to indicate that the first object in the subgroup
 *  stream is the first object ever published in that subgroup."
 * draft-ietf-moq-transport-22 §5.2:
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
// draft-ietf-moq-transport-22 §10.8 / §10.9
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
 * draft-ietf-moq-transport-22 §10.8:
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
 * draft-ietf-moq-transport-22 §10.9:
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
 * draft-ietf-moq-transport-22 §10.8 / §10.9:
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
 * draft-ietf-moq-transport-22 §10.7 / §10.8:
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
// draft-ietf-moq-transport-22 §12.1
// ============================================================================

/**
 * draft-ietf-moq-transport-22 §12.1 条件 4:
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
 * draft-ietf-moq-transport-22 §12.1 条件 4 の Group 単位追跡:
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
 * draft-ietf-moq-transport-22 §12.1 条件 3 / 条件 4:
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
