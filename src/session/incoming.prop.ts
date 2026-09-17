/**
 * session/incoming.ts の Property-Based Tests
 *
 * draft-ietf-moq-transport-21 §6.3 (Session initialization) / §6.4.2.1 (Request ID) /
 * §9.12 (FETCH_OK) / §10.8 (Prior Group ID Gap) / §10.9 (Prior Object ID Gap) /
 * §11.2.1 (Object Datagram) / §11.3 (Subgroup Streams) / §11.4.1 (Fetch Streams) /
 * §11.5.2 (Padding Datagrams) / §12.1 (Malformed Track)
 *
 * 対象とする性質:
 * - incomingClassifyFirstBidiMessage: 任意の型値の分類が仕様の 7 種対応表と一致し、
 *   対応表に無い値はすべて protocol-violation に落ちること
 * - incomingValidateRequestId: 受理条件 (LSB が奇数かつ未登録) と Set への記録・
 *   非記録が、任意の bigint と任意の既登録集合で一致すること
 * - incomingProcessSubgroupObjects: stream.ts への委譲 (previousObjectId /
 *   resolvedSubgroupId / 統計 / 購読が持つ比較キー) が保たれ、一括 feed と
 *   1 バイトずつ feed で配送結果・統計・最終状態が一致すること
 * - incomingProcessFetchObjects: stream.ts への委譲 (context / isFirst / groupOrder /
 *   統計 / 呼び出し側が渡す比較キー) が保たれ、一括 feed と 1 バイトずつ feed で
 *   配送結果・統計・最終 context が一致すること
 * - incomingHandleDatagram: 配送が入力順で、Object の内容と全購読への fan-out が
 *   保たれること。malformed 検出で当該 Track を打ち切り、以降の datagram を
 *   配送しないこと (入力順に依存してセッション状態が決まること)
 * - incomingWaitForFetcher: fetcher の有無による解決条件 (登録済みは即時解決、
 *   未知は即時 null、pending のみはタイムアウトで null) と、解決後に待機登録が
 *   残らないこと
 *
 * 対象外:
 * - incomingSendRequestErrorAndClose / incomingHandleFirstBidiMessage は実 W3C
 *   ストリームの I/O と非同期応答の検証が主であり、任意入力に対して意味のある
 *   不変条件を作れないため単体テスト (src/session/incoming.test.ts) の領分とする。
 *   REQUEST_ERROR の応答内容・FIN の順序・INVALID_REQUEST_ID での close は
 *   すべて固定値のエラーパスである。
 *
 * 対応する単体テストから削除した固定値ケース:
 * - incomingClassifyFirstBidiMessage: PUBLISH は publish / 未対応の 6 種は
 *   unsupported-request / 7 種以外は protocol-violation (3 ケース)。
 *   本ファイルが 7 種の対応表と任意の型値の分類で完全に覆う
 * - incomingValidateRequestId: 偶数 Request ID で INVALID_REQUEST_ID / 奇数
 *   Request ID は通過して Set に記録される / 重複 Request ID で
 *   INVALID_REQUEST_ID / 検証通過後に Set へ add され再送が検出される /
 *   異なる奇数 Request ID は通過する (5 ケース)。
 *   本ファイルが受理条件・Set の変化・再送検出を任意入力で覆う
 * - incomingWaitForFetcher: タイムアウト発火で登録を解除して null を返す /
 *   早期解決で登録を解除する / 複数待機者は全員解決し登録が残らない /
 *   セッション close 相当の発火で全員解決し登録が残らない / 不明なリクエストは
 *   即座に null を返す (5 ケース)。
 *   本ファイルが 3 つの解決経路と待機者数・fetcher 有無の組合せを覆う
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  incomingClassifyFirstBidiMessage,
  incomingHandleDatagram,
  incomingProcessFetchObjects,
  incomingProcessSubgroupObjects,
  incomingValidateRequestId,
  incomingWaitForFetcher,
} from "./incoming";
import { MalformedTrackError, SessionError, SessionErrorCode } from "../error";
import { MessageType, ObjectStatus } from "../message";
import { GroupOrder } from "../message/types";
import { SubscriberImpl } from "../subscriber";
import { FetcherImpl } from "../fetcher";
import { fullTrackNameKey, type FullTrackNameKey } from "../fullTrackName";
import {
  createFetchObjectFlags,
  createFirstFetchObjectFlags,
  DatagramType,
  encodeFetchObjectFields,
  encodeObjectDatagram,
  encodeObjectFields,
  SubgroupHeaderType,
  type FetchObjectContext,
  type FetchObjectFields,
  type MoqtObject,
  type SubgroupHeader,
} from "../dataStream";
import { priorGroupIdGapProperties, priorObjectIdGapProperties } from "../testSupport/helpers";
import { concatChunks, type FetchObjectSink } from "./stream";
import type { PriorGapTracking } from "./priorGapTracking";
import type { SessionInternal } from "./types";
import { encodeVarint } from "../varint";

// ============================================================================
// 共通ヘルパー
// ============================================================================

/**
 * 配送された Object を比較しやすい形に落とした要約
 *
 * assert.deepEqual で Uint8Array を比較すると差分の読み取りが難しいため、
 * payload は number 配列にする。
 */
interface DeliveredObjectSummary {
  groupId: bigint;
  subgroupId: bigint | undefined;
  objectId: bigint;
  status: number;
  payload: number[];
  publisherPriority: number | undefined;
}

/** 配送された Object を要約する */
function describeDeliveredObject(object: MoqtObject): DeliveredObjectSummary {
  return {
    groupId: object.groupId,
    subgroupId: object.subgroupId,
    objectId: object.objectId,
    status: object.status,
    payload: [...object.payload],
    publisherPriority: object.publisherPriority,
  };
}

/** fast-check が生成した Uint8Array を独立した配列に複製する */
function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

// ============================================================================
// 受信 bidi ストリーム先頭メッセージの 3 分類
// draft-ietf-moq-transport-21 §6.3 (Session initialization) / §1.5 (Extensibility)
// ============================================================================

/**
 * 仕様が受信 bidi ストリームの先頭として許可する 7 種と分類の対応表
 *
 * draft-ietf-moq-transport-21 §6.3:
 * 「Bidirectional streams MUST NOT begin with any other message type unless
 *  negotiated. If they do, the peer MUST close the Session with a
 *  PROTOCOL_VIOLATION.」
 * 7 種のうち moqt-js (クライアント) が処理するのは受信 PUBLISH だけであり、
 * 残る 6 種は §1.5 (Extensibility) の NOT_SUPPORTED 応答対象になる。
 */
const firstBidiMessageClassification = new Map<number, "publish" | "unsupported-request">([
  [MessageType.PUBLISH, "publish"],
  [MessageType.TRACK_STATUS, "unsupported-request"],
  [MessageType.SUBSCRIBE, "unsupported-request"],
  [MessageType.FETCH, "unsupported-request"],
  [MessageType.PUBLISH_NAMESPACE, "unsupported-request"],
  [MessageType.SUBSCRIBE_NAMESPACE, "unsupported-request"],
  [MessageType.SUBSCRIBE_TRACKS, "unsupported-request"],
]);

/** 実装が返し得る分類の全域 */
const firstBidiClassificationValues = new Set<string>([
  "publish",
  "unsupported-request",
  "protocol-violation",
]);

test("incomingClassifyFirstBidiMessage: 仕様が先頭に許可する 7 種の分類を固定する", () => {
  // 回帰アンカー: 仕様の 7 種と分類の対応表そのものを固定する (§6.3 の MUST 検証)
  for (const [type, expected] of firstBidiMessageClassification) {
    assert.equal(incomingClassifyFirstBidiMessage(type), expected, `type=0x${type.toString(16)}`);
  }
});

test("incomingClassifyFirstBidiMessage: 7 種以外の全 MessageType は protocol-violation に分類される", () => {
  // 未知タイプの網羅: 対応表に無い MessageType はすべて protocol-violation に落ちる
  let listedCount = 0;
  for (const type of Object.values(MessageType)) {
    if (firstBidiMessageClassification.has(type)) {
      listedCount++;
      continue;
    }
    assert.equal(
      incomingClassifyFirstBidiMessage(type),
      "protocol-violation",
      `type=0x${type.toString(16)}`,
    );
  }
  // 列挙した MessageType が対応表の 7 種をすべて含むこと (表の取りこぼし検出)
  assert.equal(listedCount, firstBidiMessageClassification.size);
});

test("incomingClassifyFirstBidiMessage: 任意の型値の分類が 7 種対応表と一致し決定的である", () => {
  fc.assert(
    fc.property(fc.oneof(fc.constantFrom(...Object.values(MessageType)), fc.integer()), (type) => {
      // 対応表に無い値は「先頭として許可されない型」であり protocol-violation になる
      const expected = firstBidiMessageClassification.get(type) ?? "protocol-violation";
      const classification = incomingClassifyFirstBidiMessage(type);

      assert.equal(classification, expected, `type=0x${type.toString(16)}`);
      // 決定性: 同一入力に対して常に同じ分類を返す
      assert.equal(incomingClassifyFirstBidiMessage(type), classification);
      // 分類は 3 値のいずれかであり、未定義値へは落ちない
      assert.isTrue(
        firstBidiClassificationValues.has(classification),
        `type=0x${type.toString(16)}, classification=${classification}`,
      );
    }),
  );
});

// ============================================================================
// 受信 Request ID のパリティ・重複検証
// draft-ietf-moq-transport-21 §6.4.2.1 (Request ID)
// ============================================================================

/**
 * 検証対象の Request ID の任意構築
 *
 * 境界 (0n, 1n とその近傍) を必ず生成に混ぜたうえで bigint 全域からも生成する。
 * 実装の受理条件は LSB のパリティと Set への登録有無だけであり、非負・varint
 * 範囲の検査は行わない (受理と拒否の境界は LSB にある)。
 */
const requestIdArb: fc.Arbitrary<bigint> = fc.oneof(
  fc.bigInt({ min: -8n, max: 8n }),
  fc.constantFrom(0n, 1n, 2n, -1n, -2n),
  fc.bigInt({ min: -(2n ** 64n), max: 2n ** 64n }),
);

/** 検証関数に渡す「既登録 ID の集合」と「検証対象 ID」の組 */
interface ValidateRequestIdCase {
  readonly received: bigint[];
  readonly requestId: bigint;
}

/**
 * 既登録 ID と検証対象 ID の組を生成する
 *
 * 検証対象は「既に登録済み」と「未登録」の双方を必ず生成する。重複検査の境界
 * (登録済みの ID が拒否されること) を確実に踏むためである。
 */
const validateRequestIdCaseArb: fc.Arbitrary<ValidateRequestIdCase> = fc
  .tuple(fc.array(requestIdArb, { maxLength: 4 }), fc.boolean(), requestIdArb)
  .map(([received, useRegisteredId, candidate]) => {
    const registered = received[0];
    return {
      received,
      requestId: useRegisteredId && registered !== undefined ? registered : candidate,
    };
  });

test("incomingValidateRequestId: 受理と拒否の境界 (偶数 / 奇数 / 重複) を固定する", () => {
  // 回帰アンカー: 境界値そのものを固定する
  const received = new Set<bigint>();

  // 偶数 (LSB = 0) はパリティ違反で拒否し、Set には記録しない
  const evenResult = incomingValidateRequestId(0n, received);
  assert.equal(evenResult?.code, SessionErrorCode.INVALID_REQUEST_ID);
  assert.isTrue(evenResult?.message.includes("parity") ?? false);
  assert.equal(received.size, 0);

  // 奇数 (LSB = 1) は受理して消費済みとして記録する
  assert.isNull(incomingValidateRequestId(1n, received));
  assert.isTrue(received.has(1n));

  // 記録済みの ID の再出現は重複として拒否する
  const duplicateResult = incomingValidateRequestId(1n, received);
  assert.equal(duplicateResult?.code, SessionErrorCode.INVALID_REQUEST_ID);
  assert.isTrue(duplicateResult?.message.includes("duplicate") ?? false);
  assert.equal(received.size, 1);
});

test("incomingValidateRequestId: 受理は「LSB が奇数かつ未登録」と一致し拒否コードは常に INVALID_REQUEST_ID", () => {
  fc.assert(
    fc.property(validateRequestIdCaseArb, ({ received, requestId }) => {
      const result = incomingValidateRequestId(requestId, new Set(received));

      // 受理条件: LSB が奇数 (サーバー発) かつ Set に未登録であること
      const odd = requestId % 2n !== 0n;
      const registered = received.includes(requestId);
      const accepted = odd && !registered;

      assert.equal(
        result === null,
        accepted,
        `requestId=${requestId}, received=[${received.join(",")}]`,
      );
      if (result !== null) {
        assert.instanceOf(result, SessionError);
        assert.equal(result.code, SessionErrorCode.INVALID_REQUEST_ID);
        // 拒否理由の文言はパリティ違反と重複で異なる
        assert.isTrue(
          result.message.includes(odd ? "duplicate" : "parity"),
          `requestId=${requestId}, message=${result.message}`,
        );
      }
    }),
  );
});

test("incomingValidateRequestId: 受理時だけ Set に追加し拒否時は Set を変更しない", () => {
  fc.assert(
    fc.property(validateRequestIdCaseArb, ({ received, requestId }) => {
      const actual = new Set(received);
      const result = incomingValidateRequestId(requestId, actual);

      // 期待する Set: 受理された場合だけ検証対象 ID が増える
      const expected = new Set(received);
      if (result === null) {
        expected.add(requestId);
      }

      assert.equal(actual.size, expected.size, `requestId=${requestId}`);
      for (const id of expected) {
        assert.isTrue(actual.has(id), `requestId=${requestId}, missing=${id}`);
      }
    }),
  );
});

test("incomingValidateRequestId: 受理した Request ID は再出現で必ず拒否される", () => {
  fc.assert(
    fc.property(validateRequestIdCaseArb, ({ received, requestId }) => {
      const ids = new Set(received);
      const first = incomingValidateRequestId(requestId, ids);
      const second = incomingValidateRequestId(requestId, ids);

      if (first === null) {
        // 消費した Request ID は Set に残り、同一 ID の再出現は重複として拒否される
        assert.isFalse(second === null, `duplicate request id must be rejected: ${requestId}`);
        if (second !== null) {
          assert.equal(second.code, SessionErrorCode.INVALID_REQUEST_ID);
          assert.isTrue(second.message.includes("duplicate"));
        }
        return;
      }

      // 拒否された ID は記録されないため、判定は 1 回目と変わらない
      assert.equal(second?.code, first.code);
      assert.equal(ids.has(requestId), received.includes(requestId));
    }),
  );
});

// ============================================================================
// Subgroup オブジェクト処理の委譲
// draft-ietf-moq-transport-21 §11.3 (Subgroup Streams) / §10.8 / §10.9
// ============================================================================

/** Subgroup 経路で観測するセッション状態 */
interface SubgroupSessionState {
  statsObjectsReceivedViaSubscribe: number;
  statsBytesReceivedViaSubscribe: number;
}

/**
 * Subgroup 配送用のテストコンテキストを構築する
 *
 * 受信に必要な最小面 (debug コールバック・統計カウンタ・追跡マップ) だけを持つ
 * オブジェクトであり、購読は実物 (SubscriberImpl) を使う。
 */
function createSubgroupSession(): SessionInternal & SubgroupSessionState {
  return {
    callbacks: { debug: () => {} },
    statsObjectsReceivedViaSubscribe: 0,
    statsBytesReceivedViaSubscribe: 0,
    // draft-ietf-moq-transport-21 §12.1 条件 4: Group 単位の最終 Object 追跡
    receivedEndOfGroupFinalObjectIds: new Map<string, bigint>(),
    // draft-ietf-moq-transport-21 §10.8 / §10.9: Track 単位の Prior ID Gap 追跡
    priorGapTrackingByTrack: new Map(),
  } as unknown as SessionInternal & SubgroupSessionState;
}

/** Subgroup ストリームに載せる Object 1 件分の指定 (Object ID は昇順) */
interface SubgroupObjectSpec {
  readonly objectId: bigint;
  readonly payload: Uint8Array;
}

/** Subgroup ストリーム 1 本分の指定 */
interface SubgroupStreamSpec {
  readonly groupId: bigint;
  readonly objects: SubgroupObjectSpec[];
}

/**
 * Subgroup ストリームの任意構築
 *
 * 先頭 Object の Object ID Delta は絶対値、2 件目以降は「前の Object ID + delta + 1」
 * として解決する (§11.3.1 の delta エンコーディング)。
 */
const subgroupStreamArb: fc.Arbitrary<SubgroupStreamSpec> = fc
  .tuple(
    fc.bigInt({ min: 0n, max: 500n }),
    fc.array(
      fc.record({
        idDelta: fc.bigInt({ min: 0n, max: 4n }),
        payload: fc.uint8Array({ minLength: 1, maxLength: 4 }).map((bytes) => copyBytes(bytes)),
      }),
      { minLength: 1, maxLength: 4 },
    ),
  )
  .map(([groupId, entries]) => {
    const objects: SubgroupObjectSpec[] = [];
    let objectId = 0n;
    for (const [index, entry] of entries.entries()) {
      objectId = index === 0 ? entry.idDelta : objectId + entry.idDelta + 1n;
      objects.push({ objectId, payload: entry.payload });
    }
    return { groupId, objects };
  });

/** 配送観測用の Subgroup ヘッダ (Subgroup ID = 先頭 Object ID 型) */
function subgroupHeader(groupId: bigint): SubgroupHeader {
  return { type: SubgroupHeaderType.FIRST_OBJ, trackAlias: 7n, groupId, firstObject: false };
}

/** Properties を持つ Subgroup ヘッダ (Object Property を載せる型) */
function subgroupPropertiesHeader(groupId: bigint): SubgroupHeader {
  return { type: SubgroupHeaderType.FIRST_OBJ_EXT, trackAlias: 7n, groupId, firstObject: false };
}

/** Subgroup の Object 1 件分のフィールドと payload を連結する */
function buildSubgroupObject(
  objectIdDelta: bigint,
  payload: Uint8Array,
  headerType: number,
  properties?: Uint8Array,
): Uint8Array {
  return concatChunks([
    encodeObjectFields(
      objectIdDelta,
      BigInt(payload.byteLength),
      headerType,
      ObjectStatus.NORMAL,
      properties,
    ),
    payload,
  ]);
}

/**
 * Subgroup ストリームのオブジェクト列をワイヤに組み立てる
 *
 * 先頭 Object の Object ID Delta は絶対値、2 件目以降は前の Object ID との差分
 * (delta + 1) としてエンコードする (§11.3.1)。
 */
function buildSubgroupWire(stream: SubgroupStreamSpec, headerType: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let previousObjectId = -1n;
  for (const object of stream.objects) {
    const delta = previousObjectId < 0n ? object.objectId : object.objectId - previousObjectId - 1n;
    chunks.push(buildSubgroupObject(delta, object.payload, headerType));
    previousObjectId = object.objectId;
  }
  return concatChunks(chunks);
}

/**
 * Subgroup の feed を 1 バイトずつに分割して実行する
 *
 * 本番 (SessionImpl.handleSubgroupStream) と同形に、前回の残りバッファと新しい
 * チャンクを連結してから feed し、返り値で previousObjectId / resolvedSubgroupId /
 * 確定した Group 最終 Object ID を引き継ぐ。
 */
function feedSubgroupByteWise(
  session: SessionInternal & SubgroupSessionState,
  wire: Uint8Array,
  subscribers: SubscriberImpl[],
  header: SubgroupHeader,
): { previousObjectId: bigint; resolvedSubgroupId: bigint | undefined; remainingBytes: number } {
  let remaining: Uint8Array = new Uint8Array(0);
  let previousObjectId = -1n;
  let resolvedSubgroupId: bigint | undefined = undefined;

  for (const byte of wire) {
    const buffer = concatChunks([remaining, new Uint8Array([byte])]);
    const result = incomingProcessSubgroupObjects(
      session,
      buffer,
      subscribers,
      header,
      previousObjectId,
      resolvedSubgroupId,
    );
    remaining = result.remainingBuffer;
    previousObjectId = result.previousObjectId;
    resolvedSubgroupId = result.resolvedSubgroupId;
    if (result.updatedEndOfGroupFinalObjectId !== undefined) {
      session.receivedEndOfGroupFinalObjectIds.set(
        `${header.trackAlias}:${header.groupId}`,
        result.updatedEndOfGroupFinalObjectId,
      );
    }
  }

  return { previousObjectId, resolvedSubgroupId, remainingBytes: remaining.byteLength };
}

test("incomingProcessSubgroupObjects: 一括 feed と 1 バイトずつ feed で配送結果と統計が一致する", () => {
  fc.assert(
    fc.property(subgroupStreamArb, (stream) => {
      const header = subgroupHeader(stream.groupId);
      const wire = buildSubgroupWire(stream, header.type);
      const firstObjectId = stream.objects[0]?.objectId;

      // 一括 feed
      const bulkSession = createSubgroupSession();
      const bulkDelivered: MoqtObject[] = [];
      const bulkSubscriber = new SubscriberImpl(["test"], "track", 0n, 7n, (object) =>
        bulkDelivered.push(object),
      );
      const bulkResult = incomingProcessSubgroupObjects(
        bulkSession,
        wire,
        [bulkSubscriber],
        header,
        -1n,
      );

      // 1 バイトずつ feed (本番と同じく返り値で状態を引き継ぐ)
      const splitSession = createSubgroupSession();
      const splitDelivered: MoqtObject[] = [];
      const splitSubscriber = new SubscriberImpl(["test"], "track", 0n, 7n, (object) =>
        splitDelivered.push(object),
      );
      const splitResult = feedSubgroupByteWise(splitSession, wire, [splitSubscriber], header);

      // 期待値: 生成した Object ID / payload が入力順に配送される。
      // draft-ietf-moq-transport-21 §10.4: Subgroup Header で Priority が省略された
      // Object は購読の既定値 (Track Property 未受信時の 128) を継承する。継承は
      // 配送前 (SubscriberImpl) に行われるため、観測値は 128 になる
      const expected: DeliveredObjectSummary[] = stream.objects.map((object) => ({
        groupId: stream.groupId,
        subgroupId: firstObjectId,
        objectId: object.objectId,
        status: ObjectStatus.NORMAL,
        payload: [...object.payload],
        publisherPriority: 128,
      }));

      assert.deepEqual(
        bulkDelivered.map((object) => describeDeliveredObject(object)),
        expected,
      );
      assert.deepEqual(
        splitDelivered.map((object) => describeDeliveredObject(object)),
        expected,
      );

      // 残りバッファと feed 間で引き継ぐ状態も一致する
      assert.equal(bulkResult.remainingBuffer.byteLength, 0);
      assert.equal(splitResult.remainingBytes, 0);
      assert.equal(bulkResult.previousObjectId, splitResult.previousObjectId);
      assert.equal(bulkResult.resolvedSubgroupId, splitResult.resolvedSubgroupId);
      assert.equal(bulkResult.previousObjectId, stream.objects.at(-1)?.objectId);
      assert.equal(bulkResult.resolvedSubgroupId, firstObjectId);

      // 統計は配送した Object 数と payload 長の合計に一致する (経路で変わらない)
      const totalBytes = stream.objects.reduce((sum, object) => sum + object.payload.byteLength, 0);
      assert.equal(bulkSession.statsObjectsReceivedViaSubscribe, stream.objects.length);
      assert.equal(splitSession.statsObjectsReceivedViaSubscribe, stream.objects.length);
      assert.equal(bulkSession.statsBytesReceivedViaSubscribe, totalBytes);
      assert.equal(splitSession.statsBytesReceivedViaSubscribe, totalBytes);
    }),
  );
});

test("incomingProcessSubgroupObjects: 購読の比較キーで Track 単位の追跡状態を作り通知済み gap 内の Group を拒否する", () => {
  fc.assert(
    fc.property(
      // gap: 通知する不在 Group の数 (1 以上)
      fc.bigInt({ min: 1n, max: 100n }),
      // 覆われる Group を gap の内側に置くための余裕
      fc.bigInt({ min: 0n, max: 50n }),
      // Object ID を gap 以上にするための余裕
      fc.bigInt({ min: 0n, max: 50n }),
      (gap, groupExtra, objectExtra) => {
        const session = createSubgroupSession();
        const delivered: MoqtObject[] = [];
        const subscriber = new SubscriberImpl(["test"], "track", 0n, 7n, (object) =>
          delivered.push(object),
        );

        // gap が覆う Group は [groupId - gap, groupId - 1] であり、
        // groupId = gap + 1 + groupExtra とすると覆われる Group は groupExtra + 1 になる
        const groupId = gap + 1n + groupExtra;
        const coveredGroupId = groupId - gap;
        const objectId = gap + objectExtra;

        // 1 本目: 不在 Group を通知する Object を配送する
        const firstHeader = subgroupPropertiesHeader(groupId);
        incomingProcessSubgroupObjects(
          session,
          buildSubgroupObject(
            objectId,
            new Uint8Array([0xaa]),
            firstHeader.type,
            priorGroupIdGapProperties(gap),
          ),
          [subscriber],
          firstHeader,
          -1n,
        );
        assert.equal(delivered.length, 1);

        // 追跡状態は購読が持つ比較キーで引かれ、受信位置と通知済み gap を記録する
        const trackKey = subscriber.getFullTrackNameKey();
        assert.isTrue(session.priorGapTrackingByTrack.has(trackKey));
        const tracking = session.priorGapTrackingByTrack.get(trackKey);
        assert.isTrue(tracking?.receivedGroupIds.has(groupId) ?? false);
        assert.isTrue(tracking?.receivedObjectIdsByGroup.get(groupId)?.has(objectId) ?? false);
        assert.deepEqual(tracking?.priorGroupIdGapRanges, [
          { start: coveredGroupId, end: groupId - 1n },
        ]);

        // 2 本目 (別 Subgroup ストリーム): 通知済み gap 内の Group は malformed になる
        const coveredHeader = subgroupPropertiesHeader(coveredGroupId);
        assert.throws(
          () =>
            incomingProcessSubgroupObjects(
              session,
              buildSubgroupObject(0n, new Uint8Array([0xbb]), coveredHeader.type),
              [subscriber],
              coveredHeader,
              -1n,
            ),
          MalformedTrackError,
        );
        // malformed の Object は配送しない
        assert.equal(delivered.length, 1);
      },
    ),
  );
});

// ============================================================================
// Fetch オブジェクト処理の委譲
// draft-ietf-moq-transport-21 §11.4.1 (Fetch Streams) / §10.8 / §10.9
// ============================================================================

/** Fetch 経路で観測するセッション状態 */
interface FetchSessionState {
  statsObjectsReceivedViaFetch: number;
  statsObjectsReceivedViaFill: number;
  statsBytesReceivedViaFetch: number;
  statsBytesReceivedViaFill: number;
}

/**
 * Fetch 配送用のテストコンテキストを構築する
 *
 * 統計と追跡マップだけを持つオブジェクトであり、配送先は FetchObjectSink 契約を
 * 実装した実オブジェクトを使う。
 */
function createFetchSession(): SessionInternal & FetchSessionState {
  return {
    statsObjectsReceivedViaFetch: 0,
    statsObjectsReceivedViaFill: 0,
    statsBytesReceivedViaFetch: 0,
    statsBytesReceivedViaFill: 0,
    // draft-ietf-moq-transport-21 §10.8 / §10.9: Track 単位の Prior ID Gap 追跡
    priorGapTrackingByTrack: new Map(),
  } as unknown as SessionInternal & FetchSessionState;
}

/**
 * Fetch ストリームで使う定数
 *
 * §12.1 は同一 Subgroup 内で Publisher Priority が変わる Object を malformed と
 * するため、1 本のストリーム内では Subgroup ID と Priority を固定する。
 */
const FETCH_STREAM_SUBGROUP_ID = 1n;
const FETCH_STREAM_PUBLISHER_PRIORITY = 100;

/** Fetch ストリームに載せる Object 1 件分の指定 (Object ID は Group 内で昇順) */
interface FetchObjectSpec {
  readonly objectId: bigint;
  readonly payload: Uint8Array;
}

/** Fetch ストリーム 1 本分の指定 */
interface FetchStreamSpec {
  readonly groupOrder: GroupOrder;
  readonly groups: { readonly groupId: bigint; readonly objects: FetchObjectSpec[] }[];
}

/**
 * Fetch ストリームの任意構築
 *
 * Group Order が Ascending なら Group ID 昇順、Descending なら降順に並べる
 * (§11.4.1.1 Table 9 の delta はこの順序で初めて非負になる)。
 */
const fetchStreamArb: fc.Arbitrary<FetchStreamSpec> = fc
  .tuple(
    fc.constantFrom(GroupOrder.ASCENDING, GroupOrder.DESCENDING),
    fc.uniqueArray(fc.bigInt({ min: 0n, max: 500n }), { minLength: 1, maxLength: 3 }),
    fc.array(
      fc.array(
        fc.record({
          idDelta: fc.bigInt({ min: 0n, max: 3n }),
          payload: fc.uint8Array({ minLength: 0, maxLength: 4 }).map((bytes) => copyBytes(bytes)),
        }),
        { minLength: 1, maxLength: 3 },
      ),
      { minLength: 3, maxLength: 3 },
    ),
  )
  .map(([groupOrder, groupIds, objectEntries]) => {
    const ordered =
      groupOrder === GroupOrder.DESCENDING
        ? [...groupIds].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
        : [...groupIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const groups = ordered.map((groupId, groupIndex) => {
      const entries = objectEntries[groupIndex] ?? [];
      const objects: FetchObjectSpec[] = [];
      let objectId = 0n;
      for (const [index, entry] of entries.entries()) {
        objectId = index === 0 ? entry.idDelta : objectId + entry.idDelta + 1n;
        objects.push({ objectId, payload: entry.payload });
      }
      return { groupId, objects };
    });

    return { groupOrder, groups };
  });

/**
 * Fetch ストリームのオブジェクト列をワイヤに組み立てる
 *
 * 出版側と同形に、直前の Object を context として delta を計算する。Group Order は
 * delta の符号を決めるため、生成時と復号時で同じ値を渡す必要がある (§11.4.1.1)。
 */
function buildFetchWire(stream: FetchStreamSpec): Uint8Array {
  const chunks: Uint8Array[] = [];
  let context: FetchObjectContext | null = null;

  for (const group of stream.groups) {
    for (const object of group.objects) {
      const serializationFlags =
        context === null
          ? createFirstFetchObjectFlags(false)
          : createFetchObjectFlags(
              {
                groupId: group.groupId,
                subgroupId: FETCH_STREAM_SUBGROUP_ID,
                objectId: object.objectId,
                publisherPriority: FETCH_STREAM_PUBLISHER_PRIORITY,
              },
              context,
              false,
            );

      const fields: FetchObjectFields = {
        serializationFlags,
        groupId: group.groupId,
        subgroupId: FETCH_STREAM_SUBGROUP_ID,
        objectId: object.objectId,
        publisherPriority: FETCH_STREAM_PUBLISHER_PRIORITY,
        payloadLength: BigInt(object.payload.byteLength),
        payload: object.payload,
      };
      chunks.push(encodeFetchObjectFields(fields, true, context, stream.groupOrder));

      context = {
        groupId: group.groupId,
        subgroupId: FETCH_STREAM_SUBGROUP_ID,
        objectId: object.objectId,
        publisherPriority: FETCH_STREAM_PUBLISHER_PRIORITY,
      };
    }
  }

  return concatChunks(chunks);
}

/** Fetch の先頭 Object 1 件分のワイヤを組み立てる (Properties 省略は gap 無し) */
function buildFetchObjectWire(
  groupId: bigint,
  objectId: bigint,
  properties?: Uint8Array,
): Uint8Array {
  const payload = new Uint8Array([0xaa]);
  const fields: FetchObjectFields = {
    serializationFlags: createFirstFetchObjectFlags(properties !== undefined),
    groupId,
    subgroupId: FETCH_STREAM_SUBGROUP_ID,
    objectId,
    publisherPriority: FETCH_STREAM_PUBLISHER_PRIORITY,
    ...(properties === undefined ? {} : { properties }),
    payloadLength: BigInt(payload.byteLength),
    payload,
  };
  return encodeFetchObjectFields(fields, true);
}

/**
 * Fetch の feed を 1 バイトずつに分割して実行する
 *
 * 本番 (SessionImpl.handleFetchStream) と同形に、前回の残りバッファと新しい
 * チャンクを連結してから feed し、返り値で context / isFirst を引き継ぐ。
 */
function feedFetchByteWise(
  session: SessionInternal & FetchSessionState,
  wire: Uint8Array,
  sink: FetchObjectSink,
  groupOrder: GroupOrder,
  trackKey: FullTrackNameKey,
): { remainingBytes: number; context: FetchObjectContext | null; isFirst: boolean } {
  let remaining: Uint8Array = new Uint8Array(0);
  let context: FetchObjectContext | null = null;
  let isFirst = true;

  for (const byte of wire) {
    const buffer = concatChunks([remaining, new Uint8Array([byte])]);
    const result = incomingProcessFetchObjects(
      session,
      buffer,
      sink,
      context,
      isFirst,
      groupOrder,
      false,
      trackKey,
    );
    remaining = result.remainingBuffer;
    context = result.context;
    isFirst = result.isFirst;
  }

  return { remainingBytes: remaining.byteLength, context, isFirst };
}

test("incomingProcessFetchObjects: groupOrder に従った配送結果が一括 feed と 1 バイトずつ feed で一致する", () => {
  fc.assert(
    fc.property(fetchStreamArb, (stream) => {
      const trackKey = fullTrackNameKey(["test"], "track");
      const wire = buildFetchWire(stream);

      // 一括 feed
      const bulkSession = createFetchSession();
      const bulkDelivered: MoqtObject[] = [];
      const bulkSink: FetchObjectSink = {
        handleObject: (object) => bulkDelivered.push(object),
      };
      const bulkResult = incomingProcessFetchObjects(
        bulkSession,
        wire,
        bulkSink,
        null,
        true,
        stream.groupOrder,
        false,
        trackKey,
      );

      // 1 バイトずつ feed
      const splitSession = createFetchSession();
      const splitDelivered: MoqtObject[] = [];
      const splitSink: FetchObjectSink = {
        handleObject: (object) => splitDelivered.push(object),
      };
      const splitResult = feedFetchByteWise(
        splitSession,
        wire,
        splitSink,
        stream.groupOrder,
        trackKey,
      );

      // 期待値: groupOrder に従って生成した Group ID / Object ID / payload が入力順に届く
      const expected: DeliveredObjectSummary[] = stream.groups.flatMap((group) =>
        group.objects.map((object) => ({
          groupId: group.groupId,
          subgroupId: FETCH_STREAM_SUBGROUP_ID,
          objectId: object.objectId,
          status: ObjectStatus.NORMAL,
          payload: [...object.payload],
          publisherPriority: FETCH_STREAM_PUBLISHER_PRIORITY,
        })),
      );
      assert.deepEqual(
        bulkDelivered.map((object) => describeDeliveredObject(object)),
        expected,
      );
      assert.deepEqual(
        splitDelivered.map((object) => describeDeliveredObject(object)),
        expected,
      );

      // 残りバッファと復号コンテキストも一致し、最終 Object の位置を指す
      const lastGroup = stream.groups.at(-1);
      const lastObject = lastGroup?.objects.at(-1);
      assert.equal(bulkResult.remainingBuffer.byteLength, 0);
      assert.equal(splitResult.remainingBytes, 0);
      assert.equal(bulkResult.isFirst, false);
      assert.equal(splitResult.isFirst, false);
      assert.equal(bulkResult.context?.groupId, lastGroup?.groupId);
      assert.equal(bulkResult.context?.objectId, lastObject?.objectId);
      assert.equal(splitResult.context?.groupId, lastGroup?.groupId);
      assert.equal(splitResult.context?.objectId, lastObject?.objectId);
      assert.equal(bulkResult.context?.publisherPriority, FETCH_STREAM_PUBLISHER_PRIORITY);

      // 統計は fetch 経路 (viaFill = false) に計上される
      const totalBytes = expected.reduce((sum, object) => sum + object.payload.length, 0);
      assert.equal(bulkSession.statsObjectsReceivedViaFetch, expected.length);
      assert.equal(bulkSession.statsObjectsReceivedViaFill, 0);
      assert.equal(bulkSession.statsBytesReceivedViaFetch, totalBytes);
      assert.equal(bulkSession.statsBytesReceivedViaFill, 0);
      assert.equal(splitSession.statsObjectsReceivedViaFetch, expected.length);
      assert.equal(splitSession.statsObjectsReceivedViaFill, 0);
      assert.equal(splitSession.statsBytesReceivedViaFetch, totalBytes);
    }),
  );
});

test("incomingProcessFetchObjects: viaFill は統計の計上先だけを切り替え配送結果を変えない", () => {
  fc.assert(
    fc.property(fetchStreamArb, fc.boolean(), (stream, viaFill) => {
      const trackKey = fullTrackNameKey(["test"], "track");
      const session = createFetchSession();
      const delivered: MoqtObject[] = [];
      const sink: FetchObjectSink = { handleObject: (object) => delivered.push(object) };

      incomingProcessFetchObjects(
        session,
        buildFetchWire(stream),
        sink,
        null,
        true,
        stream.groupOrder,
        viaFill,
        trackKey,
      );

      const count = stream.groups.reduce((sum, group) => sum + group.objects.length, 0);
      const bytes = stream.groups.reduce(
        (sum, group) =>
          sum + group.objects.reduce((groupSum, object) => groupSum + object.payload.byteLength, 0),
        0,
      );

      // 配送結果は経路によらず同じであり、計上先だけが viaFill で分かれる
      assert.equal(delivered.length, count);
      assert.equal(session.statsObjectsReceivedViaFetch, viaFill ? 0 : count);
      assert.equal(session.statsObjectsReceivedViaFill, viaFill ? count : 0);
      assert.equal(session.statsBytesReceivedViaFetch, viaFill ? 0 : bytes);
      assert.equal(session.statsBytesReceivedViaFill, viaFill ? bytes : 0);
    }),
  );
});

test("incomingProcessFetchObjects: 呼び出し側が渡す比較キーごとに追跡状態を分け gap 内の Object を拒否する", () => {
  fc.assert(
    fc.property(
      // gap: 通知する不在 Object の数 (1 以上)
      fc.bigInt({ min: 1n, max: 100n }),
      // Object ID を gap 以上にするための余裕
      fc.bigInt({ min: 0n, max: 50n }),
      (gap, objectExtra) => {
        const trackKey = fullTrackNameKey(["test"], "track");
        const otherTrackKey = fullTrackNameKey(["test"], "other");
        const session = createFetchSession();
        const delivered: MoqtObject[] = [];
        const sink: FetchObjectSink = { handleObject: (object) => delivered.push(object) };

        const groupId = 3n;
        const objectId = gap + objectExtra;
        const coveredObjectId = objectId - gap;

        // 1 件目: 不在 Object を通知する Object を配送する
        incomingProcessFetchObjects(
          session,
          buildFetchObjectWire(groupId, objectId, priorObjectIdGapProperties(gap)),
          sink,
          null,
          true,
          GroupOrder.ASCENDING,
          false,
          trackKey,
        );
        assert.equal(delivered.length, 1);
        // 追跡状態は呼び出し側が渡した比較キーで作られる
        assert.isTrue(session.priorGapTrackingByTrack.has(trackKey));
        assert.isFalse(session.priorGapTrackingByTrack.has(otherTrackKey));

        // 2 件目: 通知済み gap 内の Object ID は malformed になる
        assert.throws(
          () =>
            incomingProcessFetchObjects(
              session,
              buildFetchObjectWire(groupId, coveredObjectId),
              sink,
              null,
              true,
              GroupOrder.ASCENDING,
              false,
              trackKey,
            ),
          MalformedTrackError,
        );
        assert.equal(delivered.length, 1);

        // 別 Track のキーでは追跡状態を共有しないため、同じ Object も配送される
        incomingProcessFetchObjects(
          session,
          buildFetchObjectWire(groupId, coveredObjectId),
          sink,
          null,
          true,
          GroupOrder.ASCENDING,
          false,
          otherTrackKey,
        );
        assert.equal(delivered.length, 2);
      },
    ),
  );
});

// ============================================================================
// Object Datagram の配送
// draft-ietf-moq-transport-21 §11.2.1 (Object Datagram) / §11.5.2 (Padding) /
// §10.8 / §10.9 / §12.1
// ============================================================================

/** PADDING datagram の Type (draft-ietf-moq-transport-21 §11.5.2) */
const PADDING_DATAGRAM_TYPE = 0x132b3e29n;

/** datagram 経路で観測するセッション状態 */
interface DatagramSessionState {
  subscribersByAlias: Map<bigint, SubscriberImpl[]>;
  subscribers: Map<bigint, SubscriberImpl>;
  fetchers: Map<bigint, FetcherImpl>;
  requestStreams: Map<bigint, unknown>;
  pendingSubscribe: Map<bigint, unknown>;
  pendingFetch: Map<bigint, unknown>;
  pendingRequestUpdate: Map<bigint, unknown>;
  fillFetchTargets: Map<bigint, unknown>;
  priorGapTrackingByTrack: Map<FullTrackNameKey, PriorGapTracking>;
}

/**
 * datagram 配送用のテストコンテキストを構築する
 *
 * session は受信に必要な最小面 (コールバック・購読 Map・close 記録) の
 * オブジェクトであり、購読は実物 (SubscriberImpl) を使う。close は複数回を
 * 記録できるよう配列にする (閉じないことの検証が主目的のため)。
 */
function createDatagramSession(): {
  session: SessionInternal & DatagramSessionState;
  closedErrors: SessionError[];
} {
  const closedErrors: SessionError[] = [];
  const session = {
    callbacks: { debug: () => {} },
    subscribersByAlias: new Map(),
    subscribers: new Map(),
    fetchers: new Map(),
    requestStreams: new Map(),
    pendingSubscribe: new Map(),
    pendingFetch: new Map(),
    pendingRequestUpdate: new Map(),
    fillFetchTargets: new Map(),
    // draft-ietf-moq-transport-21 §12.1 条件 4: Group 単位の最終 Object 追跡
    receivedEndOfGroupFinalObjectIds: new Map<string, bigint>(),
    // draft-ietf-moq-transport-21 §10.8 / §10.9: Track 単位の Prior ID Gap 追跡
    priorGapTrackingByTrack: new Map(),
    closeWithError: (error: SessionError) => {
      closedErrors.push(error);
    },
  } as unknown as SessionInternal & DatagramSessionState;

  return { session, closedErrors };
}

/** datagram 1 通分の指定 */
interface DatagramSpec {
  readonly groupId: bigint;
  readonly objectId: bigint;
  readonly publisherPriority: number;
  readonly payload: Uint8Array;
}

/** 配送観測用の datagram の任意構築 */
const datagramSpecArb: fc.Arbitrary<DatagramSpec> = fc.record({
  groupId: fc.bigInt({ min: 0n, max: 200n }),
  objectId: fc.bigInt({ min: 0n, max: 200n }),
  publisherPriority: fc.integer({ min: 0, max: 255 }),
  payload: fc.uint8Array({ minLength: 1, maxLength: 4 }).map((bytes) => copyBytes(bytes)),
});

/** 配送観測用の Object Datagram ワイヤを組み立てる (Object ID あり・Priority あり) */
function buildObjectDatagramWire(spec: DatagramSpec, trackAlias: bigint): Uint8Array {
  return encodeObjectDatagram({
    type: DatagramType.PAYLOAD_OBJ,
    trackAlias,
    groupId: spec.groupId,
    objectId: spec.objectId,
    publisherPriority: spec.publisherPriority,
    payload: spec.payload,
  });
}

test("incomingHandleDatagram: 配送は入力順で Object の内容と全購読への fan-out が保たれる", () => {
  fc.assert(
    fc.property(
      fc.array(datagramSpecArb, { minLength: 1, maxLength: 4 }),
      fc.integer({ min: 1, max: 3 }),
      (specs, subscriberCount) => {
        const { session, closedErrors } = createDatagramSession();
        const trackAlias = 7n;

        // 同一 alias に複数購読をぶら下げる。datagram コールバックを持つ購読と
        // 持たない購読を混ぜ、どちらの配送経路でも同じ Object が届くことを見る
        const deliveries: MoqtObject[][] = [];
        const subscribers: SubscriberImpl[] = [];
        for (let index = 0; index < subscriberCount; index++) {
          const received: MoqtObject[] = [];
          deliveries.push(received);
          const onObject = (object: MoqtObject): void => {
            received.push(object);
          };
          const onDatagram =
            index % 2 === 0
              ? (object: MoqtObject): void => {
                  received.push(object);
                }
              : undefined;
          subscribers.push(
            new SubscriberImpl(["test"], "track", BigInt(index), trackAlias, onObject, onDatagram),
          );
        }
        session.subscribersByAlias.set(trackAlias, subscribers);

        // 入力順に処理する (datagram は原子配信であり、順序は受信順で決まる)
        for (const spec of specs) {
          incomingHandleDatagram(session, buildObjectDatagramWire(spec, trackAlias));
        }

        const expected: DeliveredObjectSummary[] = specs.map((spec) => ({
          groupId: spec.groupId,
          subgroupId: undefined,
          objectId: spec.objectId,
          status: ObjectStatus.NORMAL,
          payload: [...spec.payload],
          publisherPriority: spec.publisherPriority,
        }));
        for (const [index, received] of deliveries.entries()) {
          assert.deepEqual(
            received.map((object) => describeDeliveredObject(object)),
            expected,
            `subscriber=${index}`,
          );
        }

        // Track 単位の追跡状態は、配送した位置の集合と一致する
        const firstSubscriber = subscribers[0];
        const trackKey = firstSubscriber?.getFullTrackNameKey();
        const tracking =
          trackKey === undefined ? undefined : session.priorGapTrackingByTrack.get(trackKey);
        assert.isDefined(tracking);

        const expectedGroupIds = new Set(specs.map((spec) => spec.groupId));
        assert.equal(tracking?.receivedGroupIds.size, expectedGroupIds.size);
        for (const groupId of expectedGroupIds) {
          assert.isTrue(tracking?.receivedGroupIds.has(groupId) ?? false, `group=${groupId}`);
        }

        const expectedObjectIdsByGroup = new Map<bigint, Set<bigint>>();
        for (const spec of specs) {
          const objectIds = expectedObjectIdsByGroup.get(spec.groupId) ?? new Set<bigint>();
          objectIds.add(spec.objectId);
          expectedObjectIdsByGroup.set(spec.groupId, objectIds);
        }
        assert.equal(tracking?.receivedObjectIdsByGroup.size, expectedObjectIdsByGroup.size);
        for (const [groupId, objectIds] of expectedObjectIdsByGroup) {
          const actualObjectIds = tracking?.receivedObjectIdsByGroup.get(groupId);
          assert.equal(actualObjectIds?.size, objectIds.size, `group=${groupId}`);
          for (const objectId of objectIds) {
            assert.isTrue(
              actualObjectIds?.has(objectId) ?? false,
              `group=${groupId}, object=${objectId}`,
            );
          }
        }

        // 購読の登録は維持され、セッションも閉じない
        assert.equal(session.subscribersByAlias.get(trackAlias)?.length, subscriberCount);
        assert.equal(closedErrors.length, 0);
      },
    ),
  );
});

test("incomingHandleDatagram: 通知済み gap 内の datagram で購読を cancel し以降の配送を止める", () => {
  fc.assert(
    fc.property(
      // gap: 通知する不在 Group の数 (1 以上)
      fc.bigInt({ min: 1n, max: 100n }),
      // 覆われる Group を gap の内側に置くための余裕
      fc.bigInt({ min: 0n, max: 50n }),
      // Object ID を gap 以上にするための余裕
      fc.bigInt({ min: 0n, max: 50n }),
      (gap, groupExtra, objectExtra) => {
        const { session, closedErrors } = createDatagramSession();
        const trackAlias = 7n;
        const delivered: MoqtObject[] = [];
        let notified: Error | undefined;

        const subscriber = new SubscriberImpl(
          ["test"],
          "track",
          0n,
          trackAlias,
          (object) => delivered.push(object),
          undefined,
          undefined,
          (error) => {
            notified = error;
          },
        );
        session.subscribersByAlias.set(trackAlias, [subscriber]);
        session.subscribers.set(0n, subscriber);

        // gap が覆う Group は [groupId - gap, groupId - 1] であり、
        // groupId = gap + 1 + groupExtra とすると覆われる Group は groupExtra + 1 になる
        const groupId = gap + 1n + groupExtra;
        const coveredGroupId = groupId - gap;
        const objectId = gap + objectExtra;

        // 1 通目: 不在 Group を通知する datagram は配送される
        incomingHandleDatagram(
          session,
          encodeObjectDatagram({
            type: DatagramType.PAYLOAD_OBJ_EXT,
            trackAlias,
            groupId,
            objectId,
            publisherPriority: 128,
            properties: priorGroupIdGapProperties(gap),
            payload: new Uint8Array([0xaa]),
          }),
        );
        assert.equal(delivered.length, 1);

        // 2 通目: 通知済み gap 内の Group は malformed になり、配送せず購読を cancel する
        incomingHandleDatagram(
          session,
          buildObjectDatagramWire(
            {
              groupId: coveredGroupId,
              objectId: 0n,
              publisherPriority: 128,
              payload: new Uint8Array([0xbb]),
            },
            trackAlias,
          ),
        );
        assert.equal(delivered.length, 1);
        assert.instanceOf(notified, MalformedTrackError);
        assert.equal(subscriber.state, "closed");
        assert.equal((session.subscribersByAlias.get(trackAlias) ?? []).length, 0);
        // draft-ietf-moq-transport-21 §12.1: malformed track は Track 単位の失敗であり
        // セッションは閉じない
        assert.equal(closedErrors.length, 0);

        // 3 通目: cancel 済みの Track の datagram は配送されない (打ち切りは入力順に依存する)
        incomingHandleDatagram(
          session,
          buildObjectDatagramWire(
            {
              groupId,
              objectId: objectId + 1n,
              publisherPriority: 128,
              payload: new Uint8Array([0xcc]),
            },
            trackAlias,
          ),
        );
        assert.equal(delivered.length, 1);
        assert.equal(closedErrors.length, 0);
      },
    ),
  );
});

test("incomingHandleDatagram: Padding datagram は配送も追跡更新もせず破棄する", () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 8 }), (paddingTail) => {
      const { session, closedErrors } = createDatagramSession();
      const trackAlias = 7n;
      const delivered: MoqtObject[] = [];
      const subscriber = new SubscriberImpl(["test"], "track", 0n, trackAlias, (object) =>
        delivered.push(object),
      );
      session.subscribersByAlias.set(trackAlias, [subscriber]);

      // draft-ietf-moq-transport-21 §11.5.2:
      // "The receiver MUST discard all data received in a padding datagram."
      // 後続バイトが何であっても配送も追跡更新もしない
      incomingHandleDatagram(
        session,
        concatChunks([encodeVarint(PADDING_DATAGRAM_TYPE), paddingTail]),
      );

      assert.equal(delivered.length, 0);
      assert.equal(session.priorGapTrackingByTrack.size, 0);
      assert.equal(closedErrors.length, 0);
    }),
  );
});

// ============================================================================
// Fetcher 登録待ち
// draft-ietf-moq-transport-21 §9.12 (FETCH_OK)
// ============================================================================

/** fetcher 待機で観測するセッション状態 */
interface FetcherWaitState {
  fetchers: Map<bigint, FetcherImpl>;
  pendingFetch: Map<bigint, unknown>;
  fetcherReadyCallbacks: Map<bigint, Array<() => void>>;
}

/** fetcher 待機用の最小セッションを構築する */
function createFetcherWaitSession(): SessionInternal & FetcherWaitState {
  return {
    fetchers: new Map(),
    pendingFetch: new Map(),
    fetcherReadyCallbacks: new Map(),
  } as unknown as SessionInternal & FetcherWaitState;
}

/**
 * 登録済みの待機コールバックをすべて発火させる
 *
 * 本番の broadcast (FETCH_OK 到着・セッション close) と同形に、登録解除しながら
 * 発火しても欠落しないよう複製して反復する。
 */
function fireAllFetcherCallbacks(session: SessionInternal): void {
  for (const callbacks of session.fetcherReadyCallbacks.values()) {
    for (const callback of callbacks.slice()) {
      callback();
    }
  }
}

test("incomingWaitForFetcher: 登録済みの fetcher は待機せずに返し登録を残さない", async () => {
  await fc.assert(
    fc.asyncProperty(fc.bigInt({ min: 0n, max: 1000n }), async (requestId) => {
      const session = createFetcherWaitSession();
      const fetcher = new FetcherImpl(["test"], "track", requestId, () => {});
      session.fetchers.set(requestId, fetcher);

      const result = await incomingWaitForFetcher(session, requestId, 30);

      // FETCH_OK 到着済み (fetcher 登録済み) の場合は即座に同じ fetcher を返す
      assert.strictEqual(result, fetcher);
      assert.equal(session.fetcherReadyCallbacks.size, 0);
    }),
  );
});

test("incomingWaitForFetcher: 未知の Request ID は timeout を待たずに null を返す", async () => {
  await fc.assert(
    fc.asyncProperty(fc.bigInt({ min: 0n, max: 1000n }), async (requestId) => {
      const session = createFetcherWaitSession();

      // pendingFetch にも fetchers にも無い場合は待機もタイマーも作らない。
      // timeout を 60 秒にして「待たずに解決する」ことを検証する (待機を作る実装に
      // 退行するとテスト自体が timeout で失敗する)
      const result = await incomingWaitForFetcher(session, requestId, 60_000);

      assert.isNull(result);
      assert.equal(session.fetcherReadyCallbacks.size, 0);
    }),
  );
});

test("incomingWaitForFetcher: fetcher 未登録の pending はタイムアウトで null になり登録が残らない", async () => {
  await fc.assert(
    fc.asyncProperty(fc.bigInt({ min: 0n, max: 1000n }), async (requestId) => {
      const session = createFetcherWaitSession();
      session.pendingFetch.set(requestId, {});

      const waiting = incomingWaitForFetcher(session, requestId, 1);

      // 待機中はコールバックが同期的に登録される
      assert.equal(session.fetcherReadyCallbacks.get(requestId)?.length, 1);

      const result = await waiting;

      // FETCH_OK が来ない場合は null で確定し、待機登録もタイマーも残さない
      assert.isNull(result);
      assert.equal(session.fetcherReadyCallbacks.size, 0);
    }),
  );
});

test("incomingWaitForFetcher: 複数待機者は broadcast で全員同じ値に解決し登録が残らない", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 4 }),
      fc.boolean(),
      async (waiterCount, fetcherRegistered) => {
        const requestId = 7n;
        const session = createFetcherWaitSession();
        session.pendingFetch.set(requestId, {});
        // fetcherRegistered は FETCH_OK 到着 (登録あり)、false はセッション close
        // (登録なし) 相当の broadcast を表す
        const fetcher = fetcherRegistered
          ? new FetcherImpl(["test"], "track", requestId, () => {})
          : null;

        // timeout は broadcast より十分長くし、タイマー由来の解決と区別する
        const waitings: Promise<FetcherImpl | null>[] = [];
        for (let index = 0; index < waiterCount; index++) {
          waitings.push(incomingWaitForFetcher(session, requestId, 5000));
        }
        assert.equal(session.fetcherReadyCallbacks.get(requestId)?.length, waiterCount);

        if (fetcher !== null) {
          session.fetchers.set(requestId, fetcher);
        }
        fireAllFetcherCallbacks(session);

        // 1 件目の解決による登録解除で後続の待機者が欠落しない
        for (const waiting of waitings) {
          assert.strictEqual(await waiting, fetcher);
        }
        assert.equal(session.fetcherReadyCallbacks.size, 0);
      },
    ),
  );
});
