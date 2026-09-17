/**
 * session/stream.ts の Property-Based Tests
 *
 * draft-ietf-moq-transport-21 §5.2 / §10.1 / §10.2 / §11.3.1 / §11.4.1 / §12.1:
 * 受信データストリーム処理の純粋関数が持つ不変条件を検証する。
 *
 * 検証する性質:
 * - concatChunks: 連結結果の長さが各チャンク長の総和と一致し、内容が入力順の連結と一致する
 *   (空配列・空チャンクを含む)
 * - processSubgroupObjects: 同一ワイヤの一括 feed と分割 feed で配送された MoqtObject 列と
 *   最終状態 (previousObjectId / resolvedSubgroupId / updatedEndOfGroupFinalObjectId) が一致する
 *   (subgroup 先頭判定がバッチ境界をまたいでも退行しないこと)
 * - processSubgroupObjects: Object ID の連鎖 (先頭は Object ID Delta そのもの、2 件目以降は
 *   直前の Object ID + Object ID Delta + 1) が配送結果と一致する
 * - processSubgroupObjects: previousObjectId が負数のときだけ最初の Object が subgroup 先頭扱いになる
 * - processSubgroupObjects: delivery timeout の抽出は subgroup 先頭 Object に限られる
 * - processSubgroupObjects: 不完全なワイヤでは当該 Object を配送せず、消費バイト + 残りが入力長と
 *   一致し、未消費バイトが remainingBuffer に残る
 * - processSubgroupObjects: resolvedSubgroupId は解決後に変化しない
 * - processSubgroupObjects: END_OF_GROUP で最終 Object ID が確定し、引き継ぎで後退しない
 * - processFetchObjects: 一括 feed と分割 feed で配送結果と引き継ぎ状態 (context / isFirst) が一致する
 *
 * 対応する単体テスト (src/session/stream.test.ts) から削除した固定値ケース:
 * - concatChunks: 空配列は空の Uint8Array を返す / 単一チャンクはそのまま返す /
 *   複数チャンクを結合する / 空チャンクが混ざっても正しく結合する
 * - processSubgroupObjects: バッチ内 2 件目以降の timeout は抽出しない
 * - processSubgroupObjects: バッチ途中開始では timeout を抽出しない
 * - processSubgroupObjects: バッチ跨ぎの 2 件目では timeout を抽出しない
 * - processSubgroupObjects: 分割 feed の先頭オブジェクト完成時に timeout を抽出する
 * - processSubgroupObjects: fields 切断の分割 feed 完成時に timeout を抽出する
 * - processSubgroupObjects: First-Object-ID 系はバッチ跨ぎで先頭 Object ID を引き継ぐ
 * - processSubgroupObjects: 明示型はバッチ跨ぎでもヘッダ値を維持する
 * - processSubgroupObjects: Subgroup ID = 0 系はバッチ跨ぎで 0 を維持する
 * - processSubgroupObjects: 未完成分割を挟んでも先頭 Object ID を維持する
 * - processSubgroupObjects: END_OF_GROUP の確定値を戻り値で返す
 * - processSubgroupObjects: END_OF_GROUP ステータス単独は配信する
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  concatChunks,
  processFetchObjects,
  processSubgroupObjects,
  type SubgroupDeliveryHooks,
} from "./stream";
import {
  createFetchObjectFlags,
  createFirstFetchObjectFlags,
  encodeFetchObjectFields,
  encodeObjectFields,
  SubgroupHeaderType,
  type FetchObjectContext,
  type FetchObjectFields,
  type MoqtObject,
  type SubgroupHeader,
} from "../dataStream";
import { FetcherImpl } from "../fetcher";
import { GroupOrder, ObjectStatus } from "../message/types";
import { mergeDeliveryTimeoutObjectProperties } from "../properties";
import { SubscriberImpl } from "../subscriber";

// ============================================================================
// テスト用の実オブジェクト (モック・スタブは使わない)
// ============================================================================

/**
 * エラー通知を捨てる配送フック
 *
 * 例外通知は単体テストの領分であり、ここでは配送結果と状態のみを検証する。
 */
const silentDelivery: SubgroupDeliveryHooks = {
  notifyError: () => {},
  recordCallbackError: () => {},
};

/**
 * 統計更新の受け皿
 *
 * processSubgroupObjects / processFetchObjects へ実引数として渡す手書きの実オブジェクト。
 * 計数の副作用だけを観測する。
 */
interface StreamStats {
  objectsReceived: number;
  bytesReceived: number;
  incrementObjectsReceived(subscribePath: boolean): void;
  incrementBytesReceived(subscribePath: boolean, bytes: number): void;
}

/** 計数用の統計オブジェクトを作る */
function createStreamStats(): StreamStats {
  const stats: StreamStats = {
    objectsReceived: 0,
    bytesReceived: 0,
    incrementObjectsReceived: (_subscribePath) => {
      stats.objectsReceived += 1;
    },
    incrementBytesReceived: (_subscribePath, bytes) => {
      stats.bytesReceived += bytes;
    },
  };
  return stats;
}

/**
 * 配送された MoqtObject を比較しやすい素の値へ落とす
 *
 * Uint8Array は配列へ、optional なフィールドは undefined を保ったまま取り出す。
 */
interface PlainObject {
  groupId: bigint;
  subgroupId: bigint | undefined;
  objectId: bigint;
  status: ObjectStatus;
  payload: number[];
  publisherPriority: number | undefined;
  properties: number[] | undefined;
  objectDeliveryTimeout: bigint | undefined;
  subgroupDeliveryTimeout: bigint | undefined;
}

/** MoqtObject を素の値へ落とす */
function toPlainObject(object: MoqtObject): PlainObject {
  return {
    groupId: object.groupId,
    subgroupId: object.subgroupId,
    objectId: object.objectId,
    status: object.status,
    payload: [...object.payload],
    publisherPriority: object.publisherPriority,
    properties: object.properties === undefined ? undefined : [...object.properties],
    objectDeliveryTimeout: object.objectDeliveryTimeout,
    subgroupDeliveryTimeout: object.subgroupDeliveryTimeout,
  };
}

// ============================================================================
// concatChunks
// ============================================================================

/** 空チャンクと非空チャンクの両方を生成する */
const chunkArb: fc.Arbitrary<Uint8Array> = fc.oneof(
  // 空チャンク (境界値)
  fc.constant(new Uint8Array(0)),
  fc.uint8Array({ minLength: 1, maxLength: 12 }).map((bytes) => new Uint8Array(bytes)),
);

test("concatChunks: 連結結果の長さと内容が入力順の連結と一致する", () => {
  fc.assert(
    fc.property(fc.array(chunkArb, { maxLength: 8 }), (chunks) => {
      const result = concatChunks(chunks);

      // 長さは各チャンク長の総和と一致する (空配列は 0)
      const expectedLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      assert.equal(result.byteLength, expectedLength);

      // 内容は入力順の連結と一致する
      const expected: number[] = [];
      for (const chunk of chunks) {
        expected.push(...chunk);
      }
      assert.deepEqual([...result], expected);
    }),
  );
});

// ============================================================================
// processSubgroupObjects: 入力生成
// ============================================================================

/**
 * Subgroup Header の形
 *
 * draft-ietf-moq-transport-21 §11.3.1:
 * - subgroupIdSource: "zero" (Subgroup ID = 0) / "firstObject" (Subgroup ID = First Object ID) /
 *   "field" (明示的な Subgroup ID フィールド) の 3 形態
 * - hasPriority: Priority Present の有無 (0x10 系は Yes、0x30 系は No)
 * - hasProperties: Properties Present の有無 (奇数 Type は Yes)
 * - firstObject: FIRST_OBJECT ビット (0x40)
 */
interface SubgroupShape {
  type: number;
  subgroupIdSource: "zero" | "firstObject" | "field";
  hasPriority: boolean;
  hasProperties: boolean;
  firstObject: boolean;
}

const subgroupShapes: SubgroupShape[] = [
  {
    type: SubgroupHeaderType.BASE,
    subgroupIdSource: "zero",
    hasPriority: true,
    hasProperties: false,
    firstObject: false,
  },
  {
    type: SubgroupHeaderType.BASE_EXT,
    subgroupIdSource: "zero",
    hasPriority: true,
    hasProperties: true,
    firstObject: false,
  },
  {
    type: SubgroupHeaderType.FIRST_OBJ_EXT,
    subgroupIdSource: "firstObject",
    hasPriority: true,
    hasProperties: true,
    firstObject: false,
  },
  {
    type: SubgroupHeaderType.EXPLICIT_EXT,
    subgroupIdSource: "field",
    hasPriority: true,
    hasProperties: true,
    firstObject: false,
  },
  {
    type: SubgroupHeaderType.BASE_EXT_NO_PRIORITY,
    subgroupIdSource: "zero",
    hasPriority: false,
    hasProperties: true,
    firstObject: false,
  },
  {
    type: SubgroupHeaderType.FIRST_OBJ_EXT_NO_PRIORITY,
    subgroupIdSource: "firstObject",
    hasPriority: false,
    hasProperties: true,
    firstObject: false,
  },
  {
    type: SubgroupHeaderType.BASE_EXT_FIRST,
    subgroupIdSource: "zero",
    hasPriority: true,
    hasProperties: true,
    firstObject: true,
  },
  {
    type: SubgroupHeaderType.FIRST_OBJ_EXT_FIRST,
    subgroupIdSource: "firstObject",
    hasPriority: true,
    hasProperties: true,
    firstObject: true,
  },
];

/** encode 前に組み立てた 1 Object 分の仕様 */
interface SubgroupObjectSpec {
  objectIdDelta: bigint;
  payload: Uint8Array;
  status: ObjectStatus;
  objectDeliveryTimeout: bigint | undefined;
  subgroupDeliveryTimeout: bigint | undefined;
}

/** encode 後の 1 Object 分のワイヤと期待値 */
interface EncodedSubgroupObject {
  fields: Uint8Array;
  wire: Uint8Array;
  payload: Uint8Array;
  status: ObjectStatus;
  properties: Uint8Array;
}

/** 1 feed 分のワイヤと期待値をまとめたもの */
interface SubgroupFeed {
  shape: SubgroupShape;
  header: SubgroupHeader;
  specs: SubgroupObjectSpec[];
  objects: EncodedSubgroupObject[];
  /** 各 Object のワイヤ先頭位置 (不完全データの検証で使う) */
  startOffsets: number[];
  /** previousObjectId = -1 から採番した場合の Object ID 列 */
  objectIds: bigint[];
  lastIsEndOfGroup: boolean;
  wire: Uint8Array;
}

/**
 * delivery timeout の Object Property を組み立てる
 *
 * draft-ietf-moq-transport-21 §10.1 / §10.2 / §5.2:
 * subgroup 先頭 Object の Object Property としてのみ意味を持つ値。
 * Properties Present を持たない Type と非 NORMAL ステータスでは wire に載せない
 * (§11.1.3 は非 Normal ステータスの properties を禁止する)。
 */
function buildTimeoutProperties(shape: SubgroupShape, spec: SubgroupObjectSpec): Uint8Array {
  if (!shape.hasProperties || spec.status !== ObjectStatus.NORMAL) {
    return new Uint8Array(0);
  }
  const encoded = mergeDeliveryTimeoutObjectProperties(
    undefined,
    spec.objectDeliveryTimeout,
    spec.subgroupDeliveryTimeout,
  );
  return encoded ?? new Uint8Array(0);
}

/**
 * 1 Object 分のワイヤを組み立てる
 *
 * draft-ietf-moq-transport-21 §11.3.1 Figure 26:
 * Object ID Delta / [Properties] / Object Payload Length / [Object Status] / [Object Payload]
 */
function encodeSubgroupObject(
  shape: SubgroupShape,
  spec: SubgroupObjectSpec,
): EncodedSubgroupObject {
  const properties = buildTimeoutProperties(shape, spec);
  const fields = encodeObjectFields(
    spec.objectIdDelta,
    BigInt(spec.payload.byteLength),
    shape.type,
    spec.status,
    properties,
  );
  return {
    fields,
    wire: concatChunks([fields, spec.payload]),
    payload: spec.payload,
    status: spec.status,
    properties,
  };
}

/**
 * 最後の Object だけを END_OF_GROUP に差し替える
 *
 * draft-ietf-moq-transport-21 §11.1.2 / §11.1.3:
 * END_OF_GROUP は Object Payload Length 0 のときのみエンコードされ、
 * properties を持つ非 Normal ステータスは禁止される。
 * また §12.1 条件 4 により、Group 内で END_OF_GROUP より大きい Object ID は malformed
 * になるため、END_OF_GROUP は必ず最後の Object にする。
 */
function buildStatusedSpecs(
  specs: SubgroupObjectSpec[],
  lastIsEndOfGroup: boolean,
): SubgroupObjectSpec[] {
  return specs.map((spec, index) => {
    if (!lastIsEndOfGroup || index !== specs.length - 1) {
      return spec;
    }
    return {
      objectIdDelta: spec.objectIdDelta,
      payload: new Uint8Array(0),
      status: ObjectStatus.END_OF_GROUP,
      objectDeliveryTimeout: undefined,
      subgroupDeliveryTimeout: undefined,
    };
  });
}

/**
 * previousObjectId から Object ID の連鎖を計算する
 *
 * draft-ietf-moq-transport-21 §11.3.1:
 * - subgroup 先頭 Object (previousObjectId < 0) の Object ID は Object ID Delta そのもの
 * - 2 件目以降は直前の Object ID + Object ID Delta + 1
 */
function expectedObjectIds(deltas: bigint[], previousObjectId: bigint): bigint[] {
  const objectIds: bigint[] = [];
  let previous = previousObjectId;
  for (const delta of deltas) {
    const objectId = previous < 0n ? delta : previous + delta + 1n;
    objectIds.push(objectId);
    previous = objectId;
  }
  return objectIds;
}

/** 1 feed 分のワイヤと期待値を組み立てる */
function buildSubgroupFeed(
  shape: SubgroupShape,
  groupId: bigint,
  explicitSubgroupId: bigint,
  publisherPriority: number,
  specs: SubgroupObjectSpec[],
  lastIsEndOfGroup: boolean,
): SubgroupFeed {
  const objects = specs.map((spec) => encodeSubgroupObject(shape, spec));

  const startOffsets: number[] = [];
  let offset = 0;
  for (const object of objects) {
    startOffsets.push(offset);
    offset += object.wire.byteLength;
  }

  // exactOptionalPropertyTypes では optional なフィールドに undefined を渡せないため、
  // 値がある場合だけ載せる (実際のデコーダ出力と同じ形にする)
  const header: SubgroupHeader = {
    type: shape.type,
    trackAlias: 1n,
    groupId,
    ...(shape.subgroupIdSource === "zero" ? { subgroupId: 0n } : {}),
    ...(shape.subgroupIdSource === "field" ? { subgroupId: explicitSubgroupId } : {}),
    ...(shape.hasPriority ? { publisherPriority } : {}),
    firstObject: shape.firstObject,
  };

  return {
    shape,
    header,
    specs,
    objects,
    startOffsets,
    objectIds: expectedObjectIds(
      specs.map((spec) => spec.objectIdDelta),
      -1n,
    ),
    lastIsEndOfGroup,
    wire: concatChunks(objects.map((object) => object.wire)),
  };
}

/**
 * 1 Object 分の仕様の arbitrary (delivery timeout は常に載せる)
 *
 * Object ID Delta は 0 を高頻度で含める。先頭 Object の Object ID が 0 になる場合
 * (Subgroup ID = First Object ID が 0 に解決される場合) の引き継ぎを確実に生成するためである。
 */
const subgroupObjectSpecArb: fc.Arbitrary<SubgroupObjectSpec> = fc
  .record({
    objectIdDelta: fc.oneof(
      fc.constant(0n),
      fc.bigInt({ min: 0n, max: 4n }),
      fc.bigInt({ min: 0n, max: 1000n }),
    ),
    payload: fc.uint8Array({ maxLength: 8 }),
    objectDeliveryTimeout: fc.bigInt({ min: 0n, max: 100000n }),
    subgroupDeliveryTimeout: fc.bigInt({ min: 0n, max: 100000n }),
  })
  .map((entry) => ({
    objectIdDelta: entry.objectIdDelta,
    payload: new Uint8Array(entry.payload),
    status: ObjectStatus.NORMAL,
    objectDeliveryTimeout: entry.objectDeliveryTimeout,
    subgroupDeliveryTimeout: entry.subgroupDeliveryTimeout,
  }));

/** feed の構成要素 (Subgroup Header の形と Object 列) */
interface SubgroupFeedParts {
  shape: SubgroupShape;
  groupId: bigint;
  explicitSubgroupId: bigint;
  publisherPriority: number;
  rawSpecs: SubgroupObjectSpec[];
  lastIsEndOfGroup: boolean;
}

/** Subgroup Header の形を差し替えられる feed の構成要素の arbitrary */
function subgroupFeedPartsArb(
  shapeArb: fc.Arbitrary<SubgroupShape>,
  minObjectCount = 1,
): fc.Arbitrary<SubgroupFeedParts> {
  return fc.record({
    shape: shapeArb,
    groupId: fc.bigInt({ min: 0n, max: 1000n }),
    explicitSubgroupId: fc.bigInt({ min: 0n, max: 1000n }),
    publisherPriority: fc.integer({ min: 0, max: 255 }),
    rawSpecs: fc.array(subgroupObjectSpecArb, { minLength: minObjectCount, maxLength: 6 }),
    lastIsEndOfGroup: fc.boolean(),
  });
}

/** 構成要素から feed を組み立てる (forceLastEndOfGroup で末尾を必ず END_OF_GROUP にする) */
function toSubgroupFeedArb(
  partsArb: fc.Arbitrary<SubgroupFeedParts>,
  forceLastEndOfGroup: boolean,
): fc.Arbitrary<SubgroupFeed> {
  return partsArb.map((entry) => {
    const lastIsEndOfGroup = forceLastEndOfGroup || entry.lastIsEndOfGroup;
    return buildSubgroupFeed(
      entry.shape,
      entry.groupId,
      entry.explicitSubgroupId,
      entry.publisherPriority,
      buildStatusedSpecs(entry.rawSpecs, lastIsEndOfGroup),
      lastIsEndOfGroup,
    );
  });
}

/** 任意の Object 列 (最後が END_OF_GROUP の場合を含む) を持つ feed */
const subgroupFeedArb: fc.Arbitrary<SubgroupFeed> = toSubgroupFeedArb(
  subgroupFeedPartsArb(fc.constantFrom(...subgroupShapes)),
  false,
);

/** 最後の Object が必ず END_OF_GROUP になる feed */
const endOfGroupFeedArb: fc.Arbitrary<SubgroupFeed> = toSubgroupFeedArb(
  subgroupFeedPartsArb(fc.constantFrom(...subgroupShapes)),
  true,
);

/**
 * FIRST_OBJECT ビットが立ち、Properties Present を持つ形だけの feed
 *
 * delivery timeout の抽出条件 (subgroup 先頭 + FIRST_OBJECT ビット) を満たす形に固定し、
 * 抽出が先頭 Object に限られることを検証する。
 */
const timeoutExtractionFeedArb: fc.Arbitrary<SubgroupFeed> = toSubgroupFeedArb(
  subgroupFeedPartsArb(
    fc.constantFrom(...subgroupShapes.filter((shape) => shape.firstObject && shape.hasProperties)),
  ),
  false,
);

/**
 * 先頭 Object の Object ID を 0 に固定した Subgroup ID = First Object ID の feed
 *
 * Subgroup ID が 0 に解決される場合の引き継ぎ (0 を未解決として扱わないこと) を
 * 確実に生成するために使う。
 */
const zeroFirstObjectIdFeedArb: fc.Arbitrary<SubgroupFeed> = toSubgroupFeedArb(
  subgroupFeedPartsArb(
    fc.constantFrom(...subgroupShapes.filter((shape) => shape.subgroupIdSource === "firstObject")),
    2,
  ),
  false,
).map((feed) => {
  const specs = feed.specs.map((spec, index) =>
    index === 0 ? { ...spec, objectIdDelta: 0n } : spec,
  );
  return buildSubgroupFeed(
    feed.shape,
    feed.header.groupId,
    feed.header.subgroupId ?? 0n,
    feed.header.publisherPriority ?? 0,
    specs,
    feed.lastIsEndOfGroup,
  );
});

// ============================================================================
// processSubgroupObjects: 実行ヘルパー
// ============================================================================

/** feed をまたいで引き継ぐ processSubgroupObjects の状態 */
interface SubgroupState {
  previousObjectId: bigint;
  resolvedSubgroupId: bigint | undefined;
  endOfGroupFinalObjectId: bigint | undefined;
}

/** 1 回の feed 実行結果 */
interface SubgroupRun {
  delivered: PlainObject[];
  state: SubgroupState;
  /** 未消費バイト数 (全バイトを feed した場合は 0) */
  pendingBytes: number;
  stats: { objectsReceived: number; bytesReceived: number };
}

/**
 * 与えられたチャンク列を順に feed し、配送結果と最終状態を返す
 *
 * 実呼び出し側 (SessionImpl の購読ストリーム読み取りループ) と同じ配線にする:
 * 未消費バイトは次のチャンクの先頭に連結して 1 つのバッファとして feed し、
 * previousObjectId / resolvedSubgroupId / endOfGroupFinalObjectId は
 * 実装の戻り値をそのまま次の feed へ引き継ぐ。
 */
function runSubgroupFeed(
  chunks: Uint8Array[],
  feed: SubgroupFeed,
  startPreviousObjectId: bigint,
  startResolvedSubgroupId: bigint | undefined,
  inheritedEndOfGroupFinalObjectId?: bigint,
): SubgroupRun {
  const delivered: MoqtObject[] = [];
  // 実クラスの購読を配送先にする (filter 未設定のため全件配送される)
  const subscriber = new SubscriberImpl(["test"], "track", 0n, 1n, (object) => {
    delivered.push(object);
  });
  const stats = createStreamStats();
  let state: SubgroupState = {
    previousObjectId: startPreviousObjectId,
    resolvedSubgroupId: startResolvedSubgroupId,
    endOfGroupFinalObjectId: inheritedEndOfGroupFinalObjectId,
  };
  let pending: Uint8Array = new Uint8Array(0);

  for (const chunk of chunks) {
    const buffer = pending.byteLength === 0 ? chunk : concatChunks([pending, chunk]);
    const result = processSubgroupObjects(
      buffer,
      [subscriber],
      feed.header,
      state.previousObjectId,
      stats,
      silentDelivery,
      state.resolvedSubgroupId,
      state.endOfGroupFinalObjectId === undefined
        ? undefined
        : { finalObjectId: state.endOfGroupFinalObjectId },
    );
    pending = result.remainingBuffer;
    state = {
      previousObjectId: result.previousObjectId,
      resolvedSubgroupId: result.resolvedSubgroupId,
      endOfGroupFinalObjectId: result.updatedEndOfGroupFinalObjectId,
    };
  }

  return {
    delivered: delivered.map((object) => toPlainObject(object)),
    state,
    pendingBytes: pending.byteLength,
    stats: { objectsReceived: stats.objectsReceived, bytesReceived: stats.bytesReceived },
  };
}

/**
 * ワイヤを先頭チャンク長と追加チャンク長の列で分割する
 *
 * 合計がワイヤ長に満たない場合は残りを最後のチャンクにする (全バイトを必ず feed する)。
 * 長さ 0 のチャンクは空チャンクとしてそのまま残す。
 */
function splitWire(
  wire: Uint8Array,
  firstChunkLength: number,
  extraChunkLengths: number[],
): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const length of [firstChunkLength, ...extraChunkLengths]) {
    if (offset >= wire.byteLength) {
      break;
    }
    const end = Math.min(offset + length, wire.byteLength);
    chunks.push(wire.slice(offset, end));
    offset = end;
  }
  if (offset < wire.byteLength) {
    chunks.push(wire.slice(offset));
  }
  return chunks;
}

/** ワイヤの内部で分割する先頭チャンク長を決める (必ず 1 バイト以上・末尾未満) */
function interiorChunkLength(wire: Uint8Array, seed: number): number {
  const candidates = wire.byteLength - 1;
  if (candidates <= 1) {
    return 1;
  }
  return 1 + (seed % candidates);
}

/**
 * delivery timeout が subgroup 先頭 Object のみから抽出されていることを表明する
 *
 * draft-ietf-moq-transport-21 §5.2:
 * "If either timeout is set as an Object Property on any object other than the first
 *  in a subgroup, it is ignored."
 */
function assertTimeoutExtraction(delivered: PlainObject[], firstSpec: SubgroupObjectSpec): void {
  delivered.forEach((object, index) => {
    if (index === 0) {
      // subgroup 先頭 Object のときだけ抽出される
      assert.equal(object.objectDeliveryTimeout, firstSpec.objectDeliveryTimeout);
      assert.equal(object.subgroupDeliveryTimeout, firstSpec.subgroupDeliveryTimeout);
    } else {
      assert.isUndefined(object.objectDeliveryTimeout);
      assert.isUndefined(object.subgroupDeliveryTimeout);
    }
  });
}

/** 配送された payload の合計バイト数 */
function totalPayloadBytes(specs: SubgroupObjectSpec[]): number {
  return specs.reduce((total, spec) => total + spec.payload.byteLength, 0);
}

// ============================================================================
// processSubgroupObjects: 一括 feed と分割 feed の等価性
// ============================================================================

test("processSubgroupObjects: 一括 feed と分割 feed で配送結果と最終状態が一致する", () => {
  fc.assert(
    fc.property(
      subgroupFeedArb,
      fc.nat({ max: 100000 }),
      fc.array(fc.nat({ max: 12 }), { maxLength: 5 }),
      (feed, firstChunkSeed, extraChunkLengths) => {
        // 一括 feed (基準)
        const oneShot = runSubgroupFeed([feed.wire], feed, -1n, undefined);
        // バッチ境界をまたぐ分割 feed (空チャンクを含み得る)
        const chunks = splitWire(
          feed.wire,
          interiorChunkLength(feed.wire, firstChunkSeed),
          extraChunkLengths,
        );
        const chunked = runSubgroupFeed(chunks, feed, -1n, undefined);

        // 配送された MoqtObject 列が一致する
        assert.deepEqual(chunked.delivered, oneShot.delivered);
        // 引き継いだ最終状態が一致する
        assert.deepEqual(chunked.state, oneShot.state);
        assert.deepEqual(chunked.stats, oneShot.stats);

        // 全 Object が配送され、未消費バイトは残らない
        assert.equal(oneShot.delivered.length, feed.specs.length);
        assert.equal(oneShot.pendingBytes, 0);
        assert.equal(chunked.pendingBytes, 0);
        assert.equal(oneShot.state.previousObjectId, feed.objectIds[feed.objectIds.length - 1]);
        assert.equal(chunked.state.previousObjectId, feed.objectIds[feed.objectIds.length - 1]);

        // 統計は配信件数と payload の合計バイト数に一致する
        assert.equal(oneShot.stats.objectsReceived, feed.specs.length);
        assert.equal(oneShot.stats.bytesReceived, totalPayloadBytes(feed.specs));
      },
    ),
  );
});

// ============================================================================
// processSubgroupObjects: Object ID の連鎖と状態遷移
// ============================================================================

test("processSubgroupObjects: Object ID の連鎖と解決済み Subgroup ID が期待値と一致する", () => {
  fc.assert(
    fc.property(
      subgroupFeedArb,
      fc.option(fc.bigInt({ min: 0n, max: 1000n }), { nil: undefined }),
      (feed, inheritedPreviousObjectId) => {
        // 負数 (subgroup 先頭から) と、引き継ぎ開始 (0 以上) の両方を検証する
        const startPreviousObjectId = inheritedPreviousObjectId ?? -1n;
        const run = runSubgroupFeed([feed.wire], feed, startPreviousObjectId, undefined);

        const deltas = feed.specs.map((spec) => spec.objectIdDelta);
        const expectedIds = expectedObjectIds(deltas, startPreviousObjectId);

        assert.equal(run.delivered.length, feed.specs.length);
        // 配送された Object 列から再構成した Object ID が期待値と一致する
        assert.deepEqual(
          run.delivered.map((object) => object.objectId),
          expectedIds,
        );
        // Group ID / Object Status / payload はワイヤに載せた値と一致する
        assert.deepEqual(
          run.delivered.map((object) => object.groupId),
          feed.specs.map(() => feed.header.groupId),
        );
        assert.deepEqual(
          run.delivered.map((object) => object.status),
          feed.specs.map((spec) => spec.status),
        );
        assert.deepEqual(
          run.delivered.map((object) => object.payload),
          feed.specs.map((spec) => [...spec.payload]),
        );

        // draft-ietf-moq-transport-21 §11.3.1:
        // Subgroup ID = 0 / 明示フィールドはヘッダ値で確定し、
        // Subgroup ID = First Object ID は最初の Object ID で確定する
        const firstObjectId = expectedIds[0];
        const expectedSubgroupId =
          feed.shape.subgroupIdSource === "firstObject"
            ? firstObjectId
            : feed.shape.subgroupIdSource === "zero"
              ? 0n
              : (feed.header.subgroupId ?? 0n);
        assert.deepEqual(
          run.delivered.map((object) => object.subgroupId),
          feed.specs.map(() => expectedSubgroupId),
        );
        // resolvedSubgroupId は解決後に変化しない (引き継ぎ値と一致する)
        assert.equal(run.state.resolvedSubgroupId, expectedSubgroupId);
        assert.equal(run.state.previousObjectId, expectedIds[expectedIds.length - 1]);
        assert.equal(
          run.state.endOfGroupFinalObjectId,
          feed.lastIsEndOfGroup ? expectedIds[expectedIds.length - 1] : undefined,
        );

        // previousObjectId が負数のときだけ最初の Object が subgroup 先頭扱いになる
        if (startPreviousObjectId < 0n) {
          assert.equal(expectedIds[0], deltas[0]);
        } else {
          assert.equal(expectedIds[0], startPreviousObjectId + deltas[0] + 1n);
          assert.notEqual(expectedIds[0], deltas[0]);
        }
      },
    ),
  );
});

// ============================================================================
// processSubgroupObjects: 解決済み Subgroup ID の引き継ぎ
// ============================================================================

test("processSubgroupObjects: 解決済み Subgroup ID は 0 でも feed をまたいで維持される", () => {
  fc.assert(
    fc.property(
      zeroFirstObjectIdFeedArb,
      fc.nat({ max: 100000 }),
      fc.array(fc.nat({ max: 8 }), { maxLength: 4 }),
      (feed, firstChunkSeed, extraChunkLengths) => {
        const firstObjectWire = feed.objects[0].wire;

        // 1) 先頭 Object を単独で feed し、Subgroup ID が先頭 Object ID の 0 に解決される
        const first = runSubgroupFeed([firstObjectWire], feed, -1n, undefined);
        assert.equal(first.delivered.length, 1);
        assert.equal(first.delivered[0].subgroupId, 0n);
        assert.equal(first.state.resolvedSubgroupId, 0n);
        assert.equal(first.pendingBytes, 0);

        // 2) 解決済みの 0 を引き継いで残りを分割 feed しても 0 のまま
        // (0 を未解決 (undefined) と取り違えると 2 件目以降が別の Subgroup ID になる)
        const restWire = feed.wire.slice(firstObjectWire.byteLength);
        const restChunks = splitWire(
          restWire,
          interiorChunkLength(restWire, firstChunkSeed),
          extraChunkLengths,
        );
        const rest = runSubgroupFeed(
          restChunks,
          feed,
          first.state.previousObjectId,
          first.state.resolvedSubgroupId,
          first.state.endOfGroupFinalObjectId,
        );

        assert.equal(rest.delivered.length, feed.specs.length - 1);
        for (const object of rest.delivered) {
          assert.equal(object.subgroupId, 0n);
        }
        assert.equal(rest.state.resolvedSubgroupId, 0n);
        assert.equal(rest.pendingBytes, 0);
        assert.equal(rest.state.previousObjectId, feed.objectIds[feed.objectIds.length - 1]);
      },
    ),
  );
});

// ============================================================================
// processSubgroupObjects: delivery timeout の抽出範囲
// ============================================================================

test("processSubgroupObjects: delivery timeout の抽出は subgroup 先頭 Object に限られる", () => {
  fc.assert(
    fc.property(
      timeoutExtractionFeedArb,
      fc.bigInt({ min: 0n, max: 1000n }),
      fc.nat({ max: 100000 }),
      fc.array(fc.nat({ max: 8 }), { maxLength: 4 }),
      (feed, inheritedPreviousObjectId, firstChunkSeed, extraChunkLengths) => {
        // すべての Object が delivery timeout の Object Property を運ぶワイヤを 1 回で feed する
        const oneShot = runSubgroupFeed([feed.wire], feed, -1n, undefined);
        assert.equal(oneShot.delivered.length, feed.specs.length);
        assertTimeoutExtraction(oneShot.delivered, feed.specs[0]);

        // バッチ境界をまたいで先頭 Object が完成しても抽出結果は変わらない
        const chunks = splitWire(
          feed.wire,
          interiorChunkLength(feed.wire, firstChunkSeed),
          extraChunkLengths,
        );
        const chunked = runSubgroupFeed(chunks, feed, -1n, undefined);
        assert.deepEqual(chunked.delivered, oneShot.delivered);
        assertTimeoutExtraction(chunked.delivered, feed.specs[0]);

        // previousObjectId が負数でない (subgroup 途中から引き継いだ) 場合は
        // ストリーム先頭の Object でも subgroup 先頭扱いにならない
        const restarted = runSubgroupFeed([feed.wire], feed, inheritedPreviousObjectId, undefined);
        assert.equal(restarted.delivered.length, feed.specs.length);
        for (const object of restarted.delivered) {
          assert.isUndefined(object.objectDeliveryTimeout);
          assert.isUndefined(object.subgroupDeliveryTimeout);
        }
      },
    ),
  );
});

// ============================================================================
// processSubgroupObjects: 不完全データ
// ============================================================================

test("processSubgroupObjects: 不完全な Object は配送せず未消費バイトを残す", () => {
  fc.assert(
    fc.property(
      subgroupFeedArb,
      fc.nat({ max: 100000 }),
      fc.nat({ max: 100000 }),
      (feed, boundarySeed, cutSeed) => {
        // 途中で切る Object とその内部位置を選ぶ (位置は Object 先頭以上・末尾未満)
        const boundary = boundarySeed % feed.objects.length;
        const start = feed.startOffsets[boundary];
        const cutPosition = start + (cutSeed % feed.objects[boundary].wire.byteLength);
        const prefix = feed.wire.slice(0, cutPosition);

        const delivered: MoqtObject[] = [];
        const subscriber = new SubscriberImpl(["test"], "track", 0n, 1n, (object) => {
          delivered.push(object);
        });
        const stats = createStreamStats();

        const first = processSubgroupObjects(
          prefix,
          [subscriber],
          feed.header,
          -1n,
          stats,
          silentDelivery,
        );

        // 完全に含まれる Object だけが配送される
        assert.equal(delivered.length, boundary);
        assert.deepEqual(
          delivered.map((object) => object.objectId),
          feed.objectIds.slice(0, boundary),
        );
        // 消費バイト + 残り = 入力長であり、残りは Object の先頭からの未消費バイトと一致する
        const expectedRemaining: Uint8Array = feed.wire.slice(start, cutPosition);
        assert.equal(start + first.remainingBuffer.byteLength, prefix.byteLength);
        assert.deepEqual(first.remainingBuffer, expectedRemaining);
        // 未完成の Object は Object ID を進めない
        assert.equal(first.previousObjectId, boundary === 0 ? -1n : feed.objectIds[boundary - 1]);

        // 残ったバイトに残り全バイトを連結して feed すると全 Object が配送される
        const second = processSubgroupObjects(
          concatChunks([first.remainingBuffer, feed.wire.slice(cutPosition)]),
          [subscriber],
          feed.header,
          first.previousObjectId,
          stats,
          silentDelivery,
          first.resolvedSubgroupId,
        );
        assert.equal(delivered.length, feed.specs.length);
        assert.deepEqual(
          delivered.map((object) => object.objectId),
          feed.objectIds,
        );
        assert.equal(second.remainingBuffer.byteLength, 0);
        assert.equal(second.previousObjectId, feed.objectIds[feed.objectIds.length - 1]);
      },
    ),
  );
});

// ============================================================================
// processSubgroupObjects: END_OF_GROUP による最終 Object ID の追跡
// ============================================================================

test("processSubgroupObjects: END_OF_GROUP は最終 Object ID を確定し引き継ぎで後退しない", () => {
  fc.assert(
    fc.property(endOfGroupFeedArb, (feed) => {
      const lastObjectId = feed.objectIds[feed.objectIds.length - 1];

      // 1) 一括 feed で END_OF_GROUP の Object ID が最終 Object ID として確定する
      const confirmed = runSubgroupFeed([feed.wire], feed, -1n, undefined);
      assert.equal(confirmed.state.endOfGroupFinalObjectId, lastObjectId);
      assert.equal(
        confirmed.delivered[confirmed.delivered.length - 1].status,
        ObjectStatus.END_OF_GROUP,
      );

      // 2) 確定値を引き継いで同じワイヤを再 feed しても後退しない (同一値のまま)
      const replayed = runSubgroupFeed([feed.wire], feed, -1n, undefined, lastObjectId);
      assert.equal(replayed.state.endOfGroupFinalObjectId, lastObjectId);

      // 3) 後続 Object が不完全で 1 件も配送されない feed でも引き継ぎ値は保持される
      const incompleteFields = encodeObjectFields(0n, 1n, feed.shape.type, ObjectStatus.NORMAL);
      const incomplete = runSubgroupFeed(
        [incompleteFields],
        feed,
        lastObjectId,
        undefined,
        lastObjectId,
      );
      assert.equal(incomplete.delivered.length, 0);
      assert.equal(incomplete.state.endOfGroupFinalObjectId, lastObjectId);
      const carriedFinalObjectId = incomplete.state.endOfGroupFinalObjectId;
      assert.isTrue(carriedFinalObjectId !== undefined && carriedFinalObjectId >= lastObjectId);
    }),
  );
});

// ============================================================================
// processFetchObjects: 入力生成
// ============================================================================

/**
 * Fetch Object 1 件分の仕様
 *
 * draft-ietf-moq-transport-21 §11.4.1:
 * Fetch Object は Object Status を持たず、Group ID / Subgroup ID / Object ID /
 * Publisher Priority / Object Payload Length / Object Payload を運ぶ。
 */
interface FetchObjectSpec {
  groupId: bigint;
  subgroupId: bigint;
  objectId: bigint;
  publisherPriority: number;
  payload: Uint8Array;
}

/** Fetch の 1 feed 分のワイヤと期待値 */
interface FetchFeed {
  groupOrder: GroupOrder;
  specs: FetchObjectSpec[];
  /** 各 Object のワイヤ先頭位置 (不完全データの検証で使う) */
  startOffsets: number[];
  wire: Uint8Array;
}

/** Fetch Object 列の arbitrary */
const fetchFeedArb: fc.Arbitrary<FetchFeed> = fc
  .record({
    groupOrder: fc.constantFrom(GroupOrder.ASCENDING, GroupOrder.DESCENDING),
    baseGroupId: fc.bigInt({ min: 100n, max: 1000n }),
    baseObjectId: fc.bigInt({ min: 0n, max: 1000n }),
    publisherPriority: fc.integer({ min: 0, max: 255 }),
    steps: fc.array(
      fc.record({
        groupStep: fc.bigInt({ min: 0n, max: 2n }),
        objectStep: fc.bigInt({ min: 0n, max: 3n }),
        subgroupId: fc.constantFrom(0n, 1n, 2n),
        payload: fc.uint8Array({ maxLength: 6 }),
      }),
      { minLength: 1, maxLength: 5 },
    ),
  })
  .map((entry) => {
    // Group ID は Group Order の方向へ単調に動かす (Ascending は増加、Descending は減少)。
    // Object ID は 1 件目から単調増加させ、Delta 省略 (+1) と明示 Delta の両方を生成する。
    // Publisher Priority は同一 Subgroup で変えない (§12.1 の malformed 条件を避ける)。
    const specs: FetchObjectSpec[] = [];
    let groupId = entry.baseGroupId;
    let objectId = entry.baseObjectId;
    entry.steps.forEach((step, index) => {
      if (index > 0) {
        groupId += entry.groupOrder === GroupOrder.DESCENDING ? -step.groupStep : step.groupStep;
        objectId += step.objectStep + 1n;
      }
      specs.push({
        groupId,
        subgroupId: step.subgroupId,
        objectId,
        publisherPriority: entry.publisherPriority,
        payload: new Uint8Array(step.payload),
      });
    });

    const parts: Uint8Array[] = [];
    const startOffsets: number[] = [];
    let context: FetchObjectContext | null = null;
    let offset = 0;
    for (const spec of specs) {
      const flags =
        context === null
          ? createFirstFetchObjectFlags(false)
          : createFetchObjectFlags(
              {
                groupId: spec.groupId,
                subgroupId: spec.subgroupId,
                objectId: spec.objectId,
                publisherPriority: spec.publisherPriority,
              },
              context,
              false,
            );
      const fields: FetchObjectFields = {
        serializationFlags: flags,
        groupId: spec.groupId,
        subgroupId: spec.subgroupId,
        objectId: spec.objectId,
        publisherPriority: spec.publisherPriority,
        payload: spec.payload,
        payloadLength: BigInt(spec.payload.byteLength),
      };
      const wire = encodeFetchObjectFields(fields, true, context, entry.groupOrder);
      startOffsets.push(offset);
      offset += wire.byteLength;
      parts.push(wire);
      context = {
        groupId: spec.groupId,
        subgroupId: spec.subgroupId,
        objectId: spec.objectId,
        publisherPriority: spec.publisherPriority,
      };
    }

    return {
      groupOrder: entry.groupOrder,
      specs,
      startOffsets,
      wire: concatChunks(parts),
    };
  });

// ============================================================================
// processFetchObjects: 実行ヘルパー
// ============================================================================

/** 引き継ぎ状態を比較しやすい素の値へ落とした FetchObjectContext */
interface PlainFetchContext {
  groupId: bigint | null;
  subgroupId: bigint | null;
  objectId: bigint | null;
  publisherPriority: number | null;
  subgroupPublisherPriority: number | null;
  hasPriorSubgroup: boolean | null;
  hasPriorActualObject: boolean | null;
  subgroupPriorities: string[] | null;
}

/** 1 回の feed 実行結果 */
interface FetchRun {
  delivered: PlainObject[];
  isFirst: boolean;
  /** 未消費バイト数 (全バイトを feed した場合は 0) */
  pendingBytes: number;
  context: PlainFetchContext;
  stats: { objectsReceived: number; bytesReceived: number };
}

/** FetchObjectContext を素の値へ落とす */
function toPlainFetchContext(context: FetchObjectContext | null): PlainFetchContext {
  if (context === null) {
    return {
      groupId: null,
      subgroupId: null,
      objectId: null,
      publisherPriority: null,
      subgroupPublisherPriority: null,
      hasPriorSubgroup: null,
      hasPriorActualObject: null,
      subgroupPriorities: null,
    };
  }
  return {
    groupId: context.groupId,
    subgroupId: context.subgroupId,
    objectId: context.objectId,
    publisherPriority: context.publisherPriority,
    subgroupPublisherPriority: context.subgroupPublisherPriority ?? null,
    hasPriorSubgroup: context.hasPriorSubgroup ?? null,
    hasPriorActualObject: context.hasPriorActualObject ?? null,
    // Map は挿入順に依存するため、決定的な文字列列に落として比較する
    subgroupPriorities:
      context.subgroupPriorities === undefined
        ? null
        : [...context.subgroupPriorities.entries()]
            .map(([subgroupId, priority]) => `${subgroupId}:${priority}`)
            .sort(),
  };
}

/**
 * 与えられたチャンク列を順に feed し、配送結果と引き継ぎ状態を返す
 *
 * 実呼び出し側と同じ配線にする: 未消費バイトは次のチャンクの先頭に連結して 1 つの
 * バッファとして feed し、context / isFirst は実装の戻り値をそのまま引き継ぐ。
 * 配送先は実クラスの FetcherImpl にする。
 */
function runFetchFeed(
  chunks: Uint8Array[],
  groupOrder: GroupOrder,
  startContext: FetchObjectContext | null = null,
  startIsFirst = true,
): FetchRun {
  const delivered: MoqtObject[] = [];
  const fetcher = new FetcherImpl(["test"], "track", 0n, (object) => {
    delivered.push(object);
  });
  const stats = createStreamStats();
  let context = startContext;
  let isFirst = startIsFirst;
  let pending: Uint8Array = new Uint8Array(0);

  for (const chunk of chunks) {
    const buffer = pending.byteLength === 0 ? chunk : concatChunks([pending, chunk]);
    const result = processFetchObjects(buffer, fetcher, context, isFirst, stats, groupOrder);
    pending = result.remainingBuffer;
    context = result.context;
    isFirst = result.isFirst;
  }

  return {
    delivered: delivered.map((object) => toPlainObject(object)),
    isFirst,
    pendingBytes: pending.byteLength,
    context: toPlainFetchContext(context),
    stats: { objectsReceived: stats.objectsReceived, bytesReceived: stats.bytesReceived },
  };
}

// ============================================================================
// processFetchObjects: 一括 feed と分割 feed の等価性
// ============================================================================

test("processFetchObjects: 一括 feed と分割 feed で配送結果と引き継ぎ状態が一致する", () => {
  fc.assert(
    fc.property(
      fetchFeedArb,
      fc.nat({ max: 100000 }),
      fc.array(fc.nat({ max: 12 }), { maxLength: 5 }),
      (feed, firstChunkSeed, extraChunkLengths) => {
        // 一括 feed (基準)
        const oneShot = runFetchFeed([feed.wire], feed.groupOrder);
        // バッチ境界をまたぐ分割 feed (空チャンクを含み得る)
        const chunks = splitWire(
          feed.wire,
          interiorChunkLength(feed.wire, firstChunkSeed),
          extraChunkLengths,
        );
        const chunked = runFetchFeed(chunks, feed.groupOrder);

        // 配送された MoqtObject 列と引き継ぎ状態 (context / isFirst) が一致する
        assert.deepEqual(chunked.delivered, oneShot.delivered);
        assert.deepEqual(chunked.context, oneShot.context);
        assert.equal(chunked.isFirst, oneShot.isFirst);
        assert.deepEqual(chunked.stats, oneShot.stats);

        // 全 Object が配送され、先頭 Object を処理した後は isFirst が false になる
        assert.equal(oneShot.delivered.length, feed.specs.length);
        assert.equal(oneShot.pendingBytes, 0);
        assert.equal(chunked.pendingBytes, 0);
        assert.isFalse(oneShot.isFirst);
        // 配送された Location と payload が仕様と一致する
        assert.deepEqual(
          oneShot.delivered.map((object) => object.objectId),
          feed.specs.map((spec) => spec.objectId),
        );
        assert.deepEqual(
          oneShot.delivered.map((object) => object.groupId),
          feed.specs.map((spec) => spec.groupId),
        );
        assert.deepEqual(
          oneShot.delivered.map((object) => object.subgroupId),
          feed.specs.map((spec) => spec.subgroupId),
        );
        assert.deepEqual(
          oneShot.delivered.map((object) => object.payload),
          feed.specs.map((spec) => [...spec.payload]),
        );
        assert.equal(oneShot.stats.objectsReceived, feed.specs.length);
        assert.equal(
          oneShot.stats.bytesReceived,
          feed.specs.reduce((total, spec) => total + spec.payload.byteLength, 0),
        );
      },
    ),
  );
});

test("processFetchObjects: 不完全な Object は配送せず未消費バイトを残す", () => {
  fc.assert(
    fc.property(
      fetchFeedArb,
      fc.nat({ max: 100000 }),
      fc.nat({ max: 100000 }),
      (feed, boundarySeed, cutSeed) => {
        // 途中で切る Object とその内部位置を選ぶ (位置は Object 先頭以上・末尾未満)
        const boundary = boundarySeed % feed.specs.length;
        const start = feed.startOffsets[boundary];
        // 次 Object の先頭 (末尾の Object はワイヤ末尾) までがこの Object の範囲
        const end =
          boundary + 1 < feed.startOffsets.length
            ? feed.startOffsets[boundary + 1]
            : feed.wire.byteLength;
        const cutPosition = start + (cutSeed % (end - start));
        const prefix = feed.wire.slice(0, cutPosition);

        const delivered: MoqtObject[] = [];
        const fetcher = new FetcherImpl(["test"], "track", 0n, (object) => {
          delivered.push(object);
        });
        const stats = createStreamStats();

        const first = processFetchObjects(prefix, fetcher, null, true, stats, feed.groupOrder);

        // 完全に含まれる Object だけが配送される
        assert.equal(delivered.length, boundary);
        assert.deepEqual(
          delivered.map((object) => object.objectId),
          feed.specs.slice(0, boundary).map((spec) => spec.objectId),
        );
        // 消費バイト + 残り = 入力長であり、残りは Object の先頭からの未消費バイトと一致する
        const expectedRemaining: Uint8Array = feed.wire.slice(start, cutPosition);
        assert.equal(start + first.remainingBuffer.byteLength, prefix.byteLength);
        assert.deepEqual(first.remainingBuffer, expectedRemaining);
        assert.equal(first.isFirst, boundary === 0);

        // 残ったバイトに残り全バイトを連結して feed すると全 Object が配送される
        const second = processFetchObjects(
          concatChunks([first.remainingBuffer, feed.wire.slice(cutPosition)]),
          fetcher,
          first.context,
          first.isFirst,
          stats,
          feed.groupOrder,
        );
        assert.equal(delivered.length, feed.specs.length);
        assert.deepEqual(
          delivered.map((object) => object.objectId),
          feed.specs.map((spec) => spec.objectId),
        );
        assert.equal(second.remainingBuffer.byteLength, 0);
        assert.isFalse(second.isFirst);
        assert.equal(second.context?.objectId, feed.specs[feed.specs.length - 1].objectId);
      },
    ),
  );
});
