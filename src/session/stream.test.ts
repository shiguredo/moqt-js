/**
 * session/stream.ts の純粋関数の単体テスト
 */

import { test, assert } from "vite-plus/test";
import { concatChunks, processSubgroupObjects } from "./stream";
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
  const result = processSubgroupObjects(buffer, [subscriber], header, -1n, stats);

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
  const first = processSubgroupObjects(head, [subscriber], header, -1n, stats);
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
  const first = processSubgroupObjects(head, [subscriber], header, -1n, stats);
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
  );
  const secondResult = processSubgroupObjects(
    firstObjectWire(0n, 0xbb),
    [subscriber],
    header,
    firstResult.previousObjectId,
    stats,
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
  );
  const secondResult = processSubgroupObjects(
    explicitObjectWire(0n, 0xbb),
    [subscriber],
    header,
    firstResult.previousObjectId,
    stats,
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
  );
  const secondResult = processSubgroupObjects(
    subgroupObjectWire(SubgroupHeaderType.BASE_EXT, 0n, 0xbb),
    [subscriber],
    header,
    firstResult.previousObjectId,
    stats,
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
  );

  assert.equal(delivered.length, 1);
  assert.equal(firstResult.resolvedSubgroupId, 5n);

  const secondResult = processSubgroupObjects(
    concatChunks([firstResult.remainingBuffer, new Uint8Array([0xbb])]),
    [subscriber],
    header,
    firstResult.previousObjectId,
    stats,
    firstResult.resolvedSubgroupId,
  );

  assert.equal(delivered.length, 2);
  assert.equal(delivered[1].objectId, 6n);
  assert.equal(delivered[1].subgroupId, 5n);
  assert.equal(secondResult.resolvedSubgroupId, 5n);
});
