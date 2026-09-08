/**
 * session/stream.ts の純粋関数の単体テスト
 */

import { test, assert } from "vite-plus/test";
import { concatChunks, processSubgroupObjects, type SubgroupDeliveryHooks } from "./stream";
import {
  encodeObjectFields,
  SubgroupHeaderType,
  type MoqtObject,
  type SubgroupHeader,
} from "../dataStream";
import { ObjectStatus } from "../message/types";
import { mergeDeliveryTimeoutObjectProperties } from "../properties";
import { SubscriberImpl } from "../subscriber";

// ============================================================================
// concatChunks
// ============================================================================

test("concatChunks: 空配列は空の Uint8Array を返す", () => {
  const result = concatChunks([]);
  assert.equal(result.byteLength, 0);
});

test("concatChunks: 単一チャンクはそのまま返す", () => {
  const chunk = new Uint8Array([1, 2, 3]);
  const result = concatChunks([chunk]);
  assert.equal(result.byteLength, 3);
  assert.deepEqual([...result], [1, 2, 3]);
});

test("concatChunks: 複数チャンクを結合する", () => {
  const result = concatChunks([
    new Uint8Array([1, 2]),
    new Uint8Array([3, 4, 5]),
    new Uint8Array([6]),
  ]);
  assert.equal(result.byteLength, 6);
  assert.deepEqual([...result], [1, 2, 3, 4, 5, 6]);
});

test("concatChunks: 空チャンクが混ざっても正しく結合する", () => {
  const result = concatChunks([
    new Uint8Array([]),
    new Uint8Array([1, 2]),
    new Uint8Array([]),
    new Uint8Array([3]),
  ]);
  assert.equal(result.byteLength, 3);
  assert.deepEqual([...result], [1, 2, 3]);
});

// ============================================================================
// processSubgroupObjects の先頭オブジェクト判定
// draft-ietf-moq-transport-20 §8 / §12.1 / §12.2
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
  stats: {
    objectsReceived: number;
    bytesReceived: number;
    incrementObjectsReceived: (subscribePath: boolean) => void;
    incrementBytesReceived: (subscribePath: boolean, bytes: number) => void;
  };
} {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 1n, (object) => {
    delivered.push(object);
  });
  // 配信可否に影響しない計数用の統計 (副作用を無視する null object)
  const stats = {
    objectsReceived: 0,
    bytesReceived: 0,
    incrementObjectsReceived: (_subscribePath: boolean) => {
      stats.objectsReceived++;
    },
    incrementBytesReceived: (_subscribePath: boolean, bytes: number) => {
      stats.bytesReceived += bytes;
    },
  };
  return {
    delivered,
    subscriber,
    // BASE_EXT (Subgroup ID = 0) の実デコーダ出力と一致させる
    header: { type: SubgroupHeaderType.BASE_EXT, trackAlias: 1n, groupId: 0n, subgroupId: 0n },
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

/** 明示型の単一オブジェクト 1 件分のワイヤを組み立てる */
function explicitObjectWire(objectIdDelta: bigint, payload: number): Uint8Array {
  return subgroupObjectWire(SubgroupHeaderType.EXPLICIT, objectIdDelta, payload);
}

// 1 回の feed で複数オブジェクトが届いた場合、先頭のみ timeout を抽出し、
// 2 件目以降は無視することを検証する。
test("processSubgroupObjects: バッチ内 2 件目以降の timeout は抽出しない", () => {
  // 先頭と 2 件目の両方に timeout を載せた 2 件バッチを 1 回で feed する
  const { delivered, subscriber, header, stats } = subgroupTestSetup();
  const buffer = concatChunks([
    timeoutObjectWire(0n, 100n, 200n),
    timeoutObjectWire(0n, 300n, 400n),
  ]);
  const result = processSubgroupObjects(buffer, [subscriber], header, -1n, stats, silentDelivery);

  // 先頭のみ抽出され、2 件目は無視される
  assert.equal(delivered.length, 2);
  assert.equal(delivered[0].objectDeliveryTimeout, 100n);
  assert.equal(delivered[0].subgroupDeliveryTimeout, 200n);
  assert.isUndefined(delivered[1].objectDeliveryTimeout);
  assert.isUndefined(delivered[1].subgroupDeliveryTimeout);
  // Object ID は 0, 1 と逐次採番され、subgroupId は先頭 Object ID で解決される
  assert.equal(delivered[0].objectId, 0n);
  assert.equal(delivered[1].objectId, 1n);
  assert.equal(delivered[0].subgroupId, 0n);
  assert.equal(delivered[1].subgroupId, 0n);
  assert.equal(result.previousObjectId, 1n);
  assert.equal(result.remainingBuffer.byteLength, 0);
  // 統計は配信件数・ペイロード合計 (1 バイトずつ) と一致する
  assert.equal(stats.objectsReceived, 2);
  assert.equal(stats.bytesReceived, 2);
});

// previousObjectId 引き継ぎで開始した場合は先頭扱いしないことを検証する。
test("processSubgroupObjects: バッチ途中開始では timeout を抽出しない", () => {
  // 前回までの末尾 Object ID を引き継いで開始する
  const { delivered, subscriber, header, stats } = subgroupTestSetup();
  const result = processSubgroupObjects(
    timeoutObjectWire(0n, 100n, 200n),
    [subscriber],
    header,
    5n,
    stats,
    silentDelivery,
  );

  // timeout 付きでも抽出されず、Object ID は継続採番される
  assert.equal(delivered.length, 1);
  assert.isUndefined(delivered[0].objectDeliveryTimeout);
  assert.isUndefined(delivered[0].subgroupDeliveryTimeout);
  assert.equal(delivered[0].objectId, 6n);
  assert.equal(delivered[0].subgroupId, 0n);
  assert.equal(result.previousObjectId, 6n);
  assert.equal(result.remainingBuffer.byteLength, 0);
  assert.equal(stats.objectsReceived, 1);
  assert.equal(stats.bytesReceived, 1);
});

// バッチ跨ぎで先頭判定が引き継がれることを検証する。
test("processSubgroupObjects: バッチ跨ぎの 2 件目では timeout を抽出しない", () => {
  // 1 件目 feed で先頭の timeout は抽出される
  const { delivered, subscriber, header, stats } = subgroupTestSetup();
  const first = processSubgroupObjects(
    timeoutObjectWire(0n, 100n, 200n),
    [subscriber],
    header,
    -1n,
    stats,
    silentDelivery,
  );
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].objectDeliveryTimeout, 100n);
  assert.equal(delivered[0].subgroupDeliveryTimeout, 200n);

  // 引き継いだ previousObjectId で 2 件目を feed すると抽出されない
  const second = processSubgroupObjects(
    timeoutObjectWire(0n, 300n, 400n),
    [subscriber],
    header,
    first.previousObjectId,
    stats,
    silentDelivery,
  );
  assert.equal(delivered.length, 2);
  assert.isUndefined(delivered[1].objectDeliveryTimeout);
  assert.isUndefined(delivered[1].subgroupDeliveryTimeout);
  assert.equal(delivered[1].objectId, 1n);
  assert.equal(delivered[1].subgroupId, 0n);
  assert.equal(second.previousObjectId, 1n);
  assert.equal(second.remainingBuffer.byteLength, 0);
  assert.equal(stats.objectsReceived, 2);
  assert.equal(stats.bytesReceived, 2);
});

// 分割 feed でも先頭判定が保持され、完成時に timeout が抽出されることを検証する。
test("processSubgroupObjects: 分割 feed の先頭オブジェクト完成時に timeout を抽出する", () => {
  // 先頭オブジェクトのワイヤをペイロード直前で切断して feed する
  const { delivered, subscriber, header, stats } = subgroupTestSetup();
  const wire = timeoutObjectWire(0n, 100n, 200n);
  const head = wire.slice(0, -1);
  const first = processSubgroupObjects(head, [subscriber], header, -1n, stats, silentDelivery);
  // 未完成のため配信されず、先頭判定が保持される
  assert.equal(delivered.length, 0);
  assert.equal(first.previousObjectId, -1n);
  assert.equal(first.remainingBuffer.byteLength, head.byteLength);

  // 残りと結合して feed すると先頭として抽出される
  const second = processSubgroupObjects(
    concatChunks([first.remainingBuffer, wire.slice(-1)]),
    [subscriber],
    header,
    first.previousObjectId,
    stats,
    silentDelivery,
  );
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].objectDeliveryTimeout, 100n);
  assert.equal(delivered[0].subgroupDeliveryTimeout, 200n);
  assert.equal(delivered[0].objectId, 0n);
  assert.equal(delivered[0].subgroupId, 0n);
  assert.equal(second.previousObjectId, 0n);
  assert.equal(second.remainingBuffer.byteLength, 0);
  assert.equal(stats.objectsReceived, 1);
  assert.equal(stats.bytesReceived, 1);
});

// fields 内切断の分割 feed でも先頭判定が保持されることを検証する。
test("processSubgroupObjects: fields 切断の分割 feed 完成時に timeout を抽出する", () => {
  // properties 途中で切断した fields を feed する (IncompleteDataError 経路)
  const { delivered, subscriber, header, stats } = subgroupTestSetup();
  const wire = timeoutObjectWire(0n, 100n, 200n);
  const head = wire.slice(0, 2);
  const first = processSubgroupObjects(head, [subscriber], header, -1n, stats, silentDelivery);
  // 未完成のため配信されず、先頭判定が保持される
  assert.equal(delivered.length, 0);
  assert.equal(first.previousObjectId, -1n);
  assert.equal(first.remainingBuffer.byteLength, head.byteLength);

  // 残りと結合して feed すると先頭として抽出される
  const second = processSubgroupObjects(
    concatChunks([first.remainingBuffer, wire.slice(2)]),
    [subscriber],
    header,
    first.previousObjectId,
    stats,
    silentDelivery,
  );
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].objectDeliveryTimeout, 100n);
  assert.equal(delivered[0].subgroupDeliveryTimeout, 200n);
  assert.equal(delivered[0].objectId, 0n);
  assert.equal(delivered[0].subgroupId, 0n);
  assert.equal(second.previousObjectId, 0n);
  assert.equal(second.remainingBuffer.byteLength, 0);
  assert.equal(stats.objectsReceived, 1);
  assert.equal(stats.bytesReceived, 1);
});

// First-Object-ID 系ヘッダで feed が分割されても、2 回目以降のオブジェクトに
// 先頭 Object の ID が付くことを検証する。初回は非ゼロ値にして 0 既定との混同を避ける。
test("processSubgroupObjects: First-Object-ID 系はバッチ跨ぎで先頭 Object ID を引き継ぐ", () => {
  const { delivered, subscriber, stats } = subgroupTestSetup();
  const header: SubgroupHeader = {
    type: SubgroupHeaderType.FIRST_OBJ,
    trackAlias: 1n,
    groupId: 0n,
    subgroupId: undefined,
  };
  const firstResult = processSubgroupObjects(
    firstObjectWire(5n, 0xaa),
    [subscriber],
    header,
    -1n,
    stats,
    silentDelivery,
  );
  const secondResult = processSubgroupObjects(
    firstObjectWire(0n, 0xbb),
    [subscriber],
    header,
    firstResult.previousObjectId,
    stats,
    silentDelivery,
    firstResult.resolvedSubgroupId,
  );

  assert.equal(delivered.length, 2);
  assert.equal(delivered[0].objectId, 5n);
  assert.equal(delivered[1].objectId, 6n);
  assert.equal(delivered[0].subgroupId, 5n);
  assert.equal(delivered[1].subgroupId, 5n);
  assert.equal(secondResult.resolvedSubgroupId, 5n);
  assert.equal(secondResult.remainingBuffer.byteLength, 0);
  assert.equal(stats.objectsReceived, 2);
  assert.equal(stats.bytesReceived, 2);
});

// 明示型はヘッダ由来値が優先され、引き継ぎで挙動が変わらないことの検証。
test("processSubgroupObjects: 明示型はバッチ跨ぎでもヘッダ値を維持する", () => {
  const { delivered, subscriber, stats } = subgroupTestSetup();
  const header: SubgroupHeader = {
    type: SubgroupHeaderType.EXPLICIT,
    trackAlias: 1n,
    groupId: 0n,
    subgroupId: 5n,
  };
  const firstResult = processSubgroupObjects(
    explicitObjectWire(0n, 0xaa),
    [subscriber],
    header,
    -1n,
    stats,
    silentDelivery,
  );
  const secondResult = processSubgroupObjects(
    explicitObjectWire(0n, 0xbb),
    [subscriber],
    header,
    firstResult.previousObjectId,
    stats,
    silentDelivery,
    firstResult.resolvedSubgroupId,
  );

  assert.equal(delivered.length, 2);
  assert.equal(delivered[0].subgroupId, 5n);
  assert.equal(delivered[1].subgroupId, 5n);
  assert.equal(secondResult.resolvedSubgroupId, 5n);
  assert.equal(secondResult.remainingBuffer.byteLength, 0);
  assert.equal(stats.objectsReceived, 2);
  assert.equal(stats.bytesReceived, 2);
});

// Subgroup ID = 0 系は引き継ぎでも 0 を維持することの検証。
// ?? と || の取り違えで 0 が消える回帰を検出する
test("processSubgroupObjects: Subgroup ID = 0 系はバッチ跨ぎで 0 を維持する", () => {
  const { delivered, subscriber, stats } = subgroupTestSetup();
  const header: SubgroupHeader = {
    type: SubgroupHeaderType.BASE_EXT,
    trackAlias: 1n,
    groupId: 0n,
    subgroupId: 0n,
  };
  const firstResult = processSubgroupObjects(
    subgroupObjectWire(SubgroupHeaderType.BASE_EXT, 0n, 0xaa),
    [subscriber],
    header,
    -1n,
    stats,
    silentDelivery,
  );
  const secondResult = processSubgroupObjects(
    subgroupObjectWire(SubgroupHeaderType.BASE_EXT, 0n, 0xbb),
    [subscriber],
    header,
    firstResult.previousObjectId,
    stats,
    silentDelivery,
    firstResult.resolvedSubgroupId,
  );

  assert.equal(delivered.length, 2);
  assert.equal(delivered[0].subgroupId, 0n);
  assert.equal(delivered[1].subgroupId, 0n);
  assert.equal(secondResult.resolvedSubgroupId, 0n);
});

// 先頭オブジェクトが未完成の feed では未解決のまま引き継がれ、
// 完成時に先頭 Object ID で解決されることの検証。
test("processSubgroupObjects: 未完成分割を挟んでも先頭 Object ID を維持する", () => {
  const { delivered, subscriber, stats } = subgroupTestSetup();
  const header: SubgroupHeader = {
    type: SubgroupHeaderType.FIRST_OBJ,
    trackAlias: 1n,
    groupId: 0n,
    subgroupId: undefined,
  };
  const fieldsOnly = encodeObjectFields(0n, 1n, SubgroupHeaderType.FIRST_OBJ, ObjectStatus.NORMAL);
  const firstResult = processSubgroupObjects(
    concatChunks([firstObjectWire(5n, 0xaa), fieldsOnly]),
    [subscriber],
    header,
    -1n,
    stats,
    silentDelivery,
  );

  assert.equal(delivered.length, 1);
  assert.equal(firstResult.resolvedSubgroupId, 5n);

  const secondResult = processSubgroupObjects(
    concatChunks([firstResult.remainingBuffer, new Uint8Array([0xbb])]),
    [subscriber],
    header,
    firstResult.previousObjectId,
    stats,
    silentDelivery,
    firstResult.resolvedSubgroupId,
  );

  assert.equal(delivered.length, 2);
  assert.equal(delivered[1].objectId, 6n);
  assert.equal(delivered[1].subgroupId, 5n);
  assert.equal(secondResult.resolvedSubgroupId, 5n);
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
    subgroupId: undefined,
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
    subgroupId: undefined,
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
    subgroupId: undefined,
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
