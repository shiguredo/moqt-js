/**
 * session/publish.ts の Property-Based Tests
 *
 * draft-ietf-moq-transport-21 Section 11.2 (Object Datagrams) /
 * Section 11.3 (Subgroup Streams) / Section 11.3.2 (Closing Subgroup Streams) /
 * Section 3.1 (Forward State) を対象に、Publisher 送信系 free function の
 * 不変条件を検証する。
 *
 * 検証する性質:
 * - publishSendObjectInternal が書き出した Subgroup ストリームを、受信側の実装
 *   (decodeSubgroupHeader + processSubgroupObjects) で読み戻すと Object ID /
 *   payload / status / publisherPriority / Subgroup ID が入力と一致する
 * - 2 件目以降の Object ID Delta が「前 Object ID + delta + 1」で連鎖し、
 *   Group をまたぐと基準がリセットされる (先頭 Object は絶対値)
 * - Object ごとに Object Fields と payload が 1 回の write で送られる
 * - 先頭 Object の delivery timeout が Object Property としてラウンドトリップする
 * - END_OF_GROUP status がラウンドトリップし、FIN で Subgroup が確定する
 * - publishCloseSubgroupStream の FIN / RESET の選択が omittedObjects と整合し、
 *   二重呼び出しや対象外 track に対して安全である
 * - publishClosePublisherStream / publishResetPublisherStream が対象 track の
 *   状態だけを掃除し、二重呼び出しや対象外 track に対して安全である
 * - publishSendDatagram が書き出した datagram が Object ID / payload / priority /
 *   END_OF_GROUP ビットでラウンドトリップする
 * - publishSendObject の公開経路が、任意の Forward State 切替と Group 送信の列に
 *   対して省略の有無どおりに FIN / RESET を選ぶ
 *
 * 対応する単体テスト (src/session/publish.test.ts /
 * src/session/publishSubgroupClose.test.ts) から削除した固定値ケース:
 * - publishSendObjectInternal: Object Fields と payload は単一 write で送信される
 * - publishSendObjectInternal: 同一 Group の 2 件目は header なし単一 write になる
 * - publishSendObjectInternal: 空 payload 時は fields のみの単一 write になる
 * - publishSendObjectInternal: delivery timeout 付きも単一 write で送信される
 * - publishClosePublisherStream: 正常 close で登録を掃除する
 * - publishSendObject: 省略した Subgroup は Group 変更で RESET される
 * - publishSendObject: 省略のない Subgroup は Group 変更で FIN される
 * いずれも固定値 1 組で wire バイト列や状態遷移をなぞるだけのケースであり、
 * 本ファイルの任意入力に対するプロパティが同等以上を検証する。
 * エラーパス (不正 ID / priority / 閉じた publisher / write 失敗) と境界値、
 * タイムアウト打ち切り、write への close 割り込みは PBT の領分ではないため
 * 単体テストに残す。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  decodeObjectDatagram,
  decodeObjectFields,
  decodeSubgroupHeader,
  SubgroupHeaderType,
  type MoqtObject,
  type SubgroupHeader,
} from "../dataStream";
import { ObjectStatus } from "../message";
import { MAX_VARINT } from "../varint";
import { PublisherImpl, type SendDatagramParams, type SendObjectParams } from "../publisher";
import { SubscriberImpl } from "../subscriber";
import { readDeliveryTimeoutObjectProperties } from "../properties";
import { concatChunks, processSubgroupObjects } from "./stream";
import {
  publishClosePublisherStream,
  publishCloseSubgroupStream,
  publishResetPublisherStream,
  publishSendDatagram,
  publishSendObject,
  publishSendObjectInternal,
} from "./publish";
import type { SessionInternal } from "./types";

// ============================================================================
// 汎用ヘルパー
// ============================================================================

/**
 * 配列から要素を取り出す
 *
 * noUncheckedIndexedAccess では添字アクセスが undefined を含むため、テストの
 * 前提 (件数) が崩れていないことを確認してから値を返す。
 */
function elementAt<T>(values: T[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`missing element at index ${index}`);
  }
  return value;
}

// ============================================================================
// ハーネス
// ============================================================================

/**
 * 1 本の送信ストリームで観測した write / FIN / RESET
 */
interface StreamRecord {
  chunks: Uint8Array[];
  closeCount: number;
  abortCount: number;
  abortReasons: unknown[];
  /**
   * FIN / RESET が sink に到達したことを示す Promise
   *
   * RESET (abort) は完了を待たずに呼ばれるため、カウントを検証する前に
   * この Promise を待って観測を確定させる。終端操作が起きなければ解決しない。
   */
  termination: Promise<void>;
}

/**
 * 記録用の実 WritableStream を作る
 *
 * sink の close / abort を数えることで FIN と RESET を区別する。
 */
function createRecordedStream(): { stream: WritableStream<Uint8Array>; record: StreamRecord } {
  let resolveTermination!: () => void;
  const termination = new Promise<void>((resolve) => {
    resolveTermination = resolve;
  });
  const record: StreamRecord = {
    chunks: [],
    closeCount: 0,
    abortCount: 0,
    abortReasons: [],
    termination,
  };
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      record.chunks.push(chunk);
    },
    close() {
      record.closeCount += 1;
      resolveTermination();
    },
    abort(reason) {
      record.abortCount += 1;
      record.abortReasons.push(reason);
      resolveTermination();
    },
  });
  return { stream, record };
}

/**
 * 記録用の実 WritableStream と writer を作る
 *
 * publisherStreams へ直接登録する後始末系のテストで使う。
 */
function createRecordedWriter(): {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  record: StreamRecord;
} {
  const { stream, record } = createRecordedStream();
  return { writer: stream.getWriter(), record };
}

/**
 * publishSendObjectInternal を駆動するためのセッションを構築する
 *
 * createUnidirectionalStream は呼び出しごとに実 WritableStream を作り、
 * ストリーム単位で write / close / abort を記録する。SessionImpl と同じく
 * ストリーム機構は実物で構成し、モックは使わない。
 */
function createStreamRecordingSession(): {
  session: SessionInternal;
  streams: StreamRecord[];
} {
  const streams: StreamRecord[] = [];
  const transport = {
    createUnidirectionalStream: async (): Promise<WritableStream<Uint8Array>> => {
      const { stream, record } = createRecordedStream();
      streams.push(record);
      return stream;
    },
    datagrams: {
      writable: new WritableStream<Uint8Array>(),
    },
  } as unknown as WebTransport;
  const session = {
    transport,
    publisherStreams: new Map(),
    closedSubgroups: new Set<string>(),
    publisherSendQueues: new Map(),
    grease: false,
    sessionState: "connected",
    statsUnidirectionalStreamsOpened: 0,
    closeWithError: () => {},
  } as unknown as SessionInternal;
  return { session, streams };
}

/**
 * 後始末系 free function のテスト用に空のセッションを構築する
 */
function createLifecycleSession(): SessionInternal {
  return {
    transport: {
      datagrams: {
        writable: new WritableStream<Uint8Array>(),
      },
    },
    publisherStreams: new Map(),
    closedSubgroups: new Set<string>(),
    publisherSendQueues: new Map(),
    grease: false,
    sessionState: "connected",
    statsUnidirectionalStreamsOpened: 0,
    closeWithError: () => {},
  } as unknown as SessionInternal;
}

/**
 * publishSendObject の公開経路 (PublisherImpl) を実ストリームで駆動するハーネス
 *
 * SessionImpl.publish() と同じ配線 (onSendObject / onSendObjectSkipped /
 * onDoneInternal) を行い、FIN / RESET の選択を購読状態から観測する。
 */
function createPublisherHarness(): {
  session: SessionInternal;
  publisher: PublisherImpl;
  streams: StreamRecord[];
  errors: Error[];
} {
  const { session, streams } = createStreamRecordingSession();
  const errors: Error[] = [];
  const publisher = new PublisherImpl(["live"], "track", 0n, 1n, (error) => {
    errors.push(error);
  });
  publisher.onSendObject = (params) => publishSendObject(session, publisher, params);
  publisher.onSendObjectSkipped = () => {
    const streamState = session.publisherStreams.get(publisher.getTrackAlias());
    if (streamState) {
      streamState.omittedObjects = true;
    }
  };
  publisher.onDoneInternal = async () => {
    await publishClosePublisherStream(session, publisher.getTrackAlias());
  };
  return { session, publisher, streams, errors };
}

/**
 * publishSendDatagram の write を記録するセッションを構築する
 *
 * WebTransport の datagrams.writable は単一の WritableStream であるため、
 * 実物の WritableStream を 1 つ用意し、sink への write を到着順に記録する。
 * write の完了は同期ではないため、記録件数が揃うまで待つ関数も返す。
 */
function createDatagramRecordingSession(): {
  session: SessionInternal;
  datagrams: Uint8Array[];
  waitForDatagrams: (count: number) => Promise<void>;
} {
  const datagrams: Uint8Array[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      datagrams.push(chunk);
      for (const waiter of waiters.slice()) {
        if (datagrams.length >= waiter.count) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
    },
  });
  const session = {
    transport: { datagrams: { writable } } as unknown as WebTransport,
    publisherStreams: new Map(),
    closedSubgroups: new Set<string>(),
    publisherSendQueues: new Map(),
    grease: false,
    sessionState: "connected",
    statsUnidirectionalStreamsOpened: 0,
    closeWithError: () => {},
  } as unknown as SessionInternal;
  const waitForDatagrams = (count: number): Promise<void> => {
    if (datagrams.length >= count) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push({ count, resolve });
    });
  };
  return { session, datagrams, waitForDatagrams };
}

// ============================================================================
// デコードヘルパー
// ============================================================================

/**
 * 書き出された Object チャンクを Object Fields と payload にデコードした結果
 */
interface DecodedObjectChunk {
  objectIdDelta: bigint;
  payloadLength: bigint;
  status: ObjectStatus;
  properties: Uint8Array;
  payload: Uint8Array;
}

/**
 * Object チャンク列を Object Fields と payload にデコードする
 *
 * published Object のチャンクは「Object Fields + payload」の 1 回の write で
 * 送られるため、チャンク長はフィールド長 + 宣言 payload 長と一致しなければ
 * ならない。この不変条件もここで検証する。
 */
function decodeObjectChunks(chunks: Uint8Array[], headerType: number): DecodedObjectChunk[] {
  const decoded: DecodedObjectChunk[] = [];
  for (const chunk of chunks) {
    const [fields, fieldsConsumed] = decodeObjectFields(chunk, headerType, 0);
    const payloadLength = Number(fields.payloadLength);
    assert.equal(chunk.length, fieldsConsumed + payloadLength);
    decoded.push({
      objectIdDelta: fields.objectIdDelta,
      payloadLength: fields.payloadLength,
      status: fields.status,
      properties: fields.properties,
      payload: chunk.slice(fieldsConsumed, fieldsConsumed + payloadLength),
    });
  }
  return decoded;
}

/**
 * 受信側の実装 (processSubgroupObjects) で Object チャンク列を読み戻す
 *
 * 配信された Object を到着順に返す。チャンク列は 1 本の Subgroup ストリームに
 * 並ぶ Object のバイト列であり、先頭 Object から読み始める (previousObjectId
 * は -1n)。Subgroup ID は First Object ID から解決される。
 */
function receiveSubgroupObjects(
  header: SubgroupHeader,
  chunks: Uint8Array[],
): { objects: MoqtObject[]; previousObjectId: bigint } {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["test"], "track", 0n, header.trackAlias, (object) => {
    delivered.push(object);
  });
  // 計数用の統計 (配送可否に影響しないため、値は記録しない)
  const stats = {
    incrementObjectsReceived: (_subscribePath: boolean) => {},
    incrementBytesReceived: (_subscribePath: boolean, _bytes: number) => {},
  };
  const result = processSubgroupObjects(concatChunks(chunks), [subscriber], header, -1n, stats, {
    notifyError: () => {},
    recordCallbackError: () => {},
  });
  // 全チャンクが 1 つの Object 列として読み切られている
  assert.equal(result.remainingBuffer.byteLength, 0);
  return { objects: delivered, previousObjectId: result.previousObjectId };
}

/**
 * 記録したストリームのチャンク列を Subgroup Header と Object チャンク列に分ける
 */
function splitSubgroupChunks(stream: StreamRecord): {
  header: SubgroupHeader;
  objectChunks: Uint8Array[];
} {
  const headerChunk = elementAt(stream.chunks, 0);
  const [header, headerConsumed] = decodeSubgroupHeader(headerChunk);
  assert.equal(headerConsumed, headerChunk.length);
  return { header, objectChunks: stream.chunks.slice(1) };
}

// ============================================================================
// Arbitrary 定義
// ============================================================================

/**
 * 0 以上 2^64-1 以下の Track Alias の任意構築
 */
const trackAliasArb = fc.bigInt({ min: 0n, max: MAX_VARINT });

/**
 * Group ID / Object ID の任意構築
 *
 * 公開 API は number のため、精度を保証できる安全整数の範囲で生成する
 * (draft-ietf-moq-transport-21 §11.3.1 の varint 全域は number では表現できない)。
 */
const objectIdArb = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });

/**
 * Publisher Priority の任意構築 (省略時はヘッダーの既定値 128 になる)
 */
const priorityArb = fc.option(fc.integer({ min: 0, max: 255 }), { nil: undefined });

/**
 * payload の任意構築
 *
 * 空 payload を必ず一定割合で生成し、fields のみの write (payload 長 0 では
 * Object Status が wire に載る経路) を検証対象に含める。
 */
const payloadArb = fc.oneof(
  fc.constant(new Uint8Array(0)),
  fc.uint8Array({ minLength: 0, maxLength: 64 }),
);

/**
 * Subgroup 内の Object 1 件分の入力
 */
interface SubgroupObjectInput {
  objectIdStep: number;
  payload: Uint8Array;
}

/**
 * Subgroup 内の Object 1 件分の任意構築
 *
 * objectIdStep は直前の Object ID からの増分である。delta が負になると varint で
 * 表現できないため、正の増分だけを生成して単調増加列を作る。
 */
const subgroupObjectArb: fc.Arbitrary<SubgroupObjectInput> = fc.record({
  objectIdStep: fc.integer({ min: 1, max: 4096 }),
  payload: payloadArb,
});

/**
 * 1 本の Subgroup ストリーム分の任意構築
 */
const subgroupCaseArb = fc.record({
  trackAlias: trackAliasArb,
  groupId: objectIdArb,
  priority: priorityArb,
  objects: fc.array(subgroupObjectArb, { minLength: 1, maxLength: 6 }),
});

/**
 * Subgroup 内の Object 列 (Object ID 付き)
 */
interface ExpandedSubgroupObject {
  objectId: number;
  payload: Uint8Array;
}

/**
 * Subgroup の Object 列を Object ID 付きの列に展開する
 *
 * 先頭の増分は「1 を引くと最初の Object ID になる値」として扱い、Object ID 0 を
 * 生成できるようにする (Object ID 0 は仕様上もっとも小さい有効値)。2 件目以降は
 * 直前の Object ID に増分を足した値になる。
 */
function expandSubgroupObjects(objects: SubgroupObjectInput[]): ExpandedSubgroupObject[] {
  const expanded: ExpandedSubgroupObject[] = [];
  let previousObjectId = -1;
  for (const object of objects) {
    const objectId =
      previousObjectId < 0 ? object.objectIdStep - 1 : previousObjectId + object.objectIdStep;
    previousObjectId = objectId;
    expanded.push({ objectId, payload: object.payload });
  }
  return expanded;
}

// ============================================================================
// PBT 1: Subgroup ストリームのラウンドトリップ
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §11.3.1:
 * publisher が書き出した Subgroup Header と Object 列を、受信側の実装
 * (decodeSubgroupHeader + processSubgroupObjects) で読み戻すと、Object ID /
 * payload / status / publisherPriority / Subgroup ID が入力と一致することを
 * 検証する。
 */
test("publishSendObjectInternal: 書き出した Subgroup が受信側の実装でラウンドトリップする", async () => {
  await fc.assert(
    fc.asyncProperty(subgroupCaseArb, async (testCase) => {
      const { session, streams } = createStreamRecordingSession();
      const publisher = new PublisherImpl(["test"], "track", 0n, testCase.trackAlias);
      const expected = expandSubgroupObjects(testCase.objects);

      for (const object of expected) {
        const sendParams: SendObjectParams = {
          groupId: testCase.groupId,
          objectId: object.objectId,
          payload: object.payload,
          // exactOptionalPropertyTypes のため、指定がある場合だけ priority を載せる
          ...(testCase.priority !== undefined ? { priority: testCase.priority } : {}),
        };
        await publishSendObjectInternal(session, publisher, sendParams);
      }

      // 1 Group = 1 Subgroup = 1 ストリームであり、統計も 1 本分だけ進む
      assert.equal(streams.length, 1);
      assert.equal(session.statsUnidirectionalStreamsOpened, 1);
      assert.equal(publisher.getDataStreamCount(), 1n);

      const stream = elementAt(streams, 0);
      const { header, objectChunks } = splitSubgroupChunks(stream);

      // ヘッダーは trackAlias / groupId / priority を保持し、First Object ID 形式である
      assert.equal(header.type, SubgroupHeaderType.FIRST_OBJ_EXT | 0x40);
      assert.equal(header.trackAlias, testCase.trackAlias);
      assert.equal(header.groupId, BigInt(testCase.groupId));
      assert.equal(header.publisherPriority, testCase.priority ?? 128);
      assert.isTrue(header.firstObject);

      const { objects, previousObjectId } = receiveSubgroupObjects(header, objectChunks);
      assert.equal(objects.length, expected.length);
      assert.equal(previousObjectId, BigInt(elementAt(expected, expected.length - 1).objectId));

      const firstObjectId = BigInt(elementAt(expected, 0).objectId);
      for (const [index, object] of objects.entries()) {
        const input = elementAt(expected, index);
        assert.equal(object.groupId, BigInt(testCase.groupId));
        assert.equal(object.objectId, BigInt(input.objectId));
        // Subgroup ID は先頭 Object ID で解決される (§11.3.1)
        assert.equal(object.subgroupId, firstObjectId);
        assert.deepEqual(object.payload, input.payload);
        assert.equal(object.status, ObjectStatus.NORMAL);
        assert.equal(object.publisherPriority, testCase.priority ?? 128);
      }

      // 送信側の状態は最後に送った Object を指す
      const streamState = session.publisherStreams.get(testCase.trackAlias);
      if (streamState === undefined) {
        throw new Error("publisher stream state was not registered");
      }
      assert.equal(streamState.groupId, BigInt(testCase.groupId));
      assert.equal(
        streamState.previousObjectId,
        BigInt(elementAt(expected, expected.length - 1).objectId),
      );
    }),
  );
});

// ============================================================================
// PBT 2: Object ID Delta の連鎖
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §11.3.1:
 * Object ID Delta は先頭 Object では絶対値、2 件目以降では
 * 「現在の Object ID - 前の Object ID - 1」であることを wire の値で検証する。
 */
test("publishSendObjectInternal: Object ID Delta が前 Object との差分 - 1 で連鎖する", async () => {
  await fc.assert(
    fc.asyncProperty(subgroupCaseArb, async (testCase) => {
      const { session, streams } = createStreamRecordingSession();
      const publisher = new PublisherImpl(["test"], "track", 0n, testCase.trackAlias);
      const expected = expandSubgroupObjects(testCase.objects);

      for (const object of expected) {
        await publishSendObjectInternal(session, publisher, {
          groupId: testCase.groupId,
          objectId: object.objectId,
          payload: object.payload,
        });
      }

      const { header, objectChunks } = splitSubgroupChunks(elementAt(streams, 0));
      const decoded = decodeObjectChunks(objectChunks, header.type);
      assert.equal(decoded.length, expected.length);

      // 送信側と同じ規則で Object ID を再構成しながら delta を照合する
      let previousObjectId = -1n;
      for (const [index, chunk] of decoded.entries()) {
        const currentObjectId = BigInt(elementAt(expected, index).objectId);
        const expectedDelta =
          previousObjectId < 0n ? currentObjectId : currentObjectId - previousObjectId - 1n;
        assert.equal(chunk.objectIdDelta, expectedDelta);
        previousObjectId = currentObjectId;
      }
    }),
  );
});

// ============================================================================
// PBT 3: Object ごとの単一 write
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §11.3 / §11.3.2:
 * Object Fields と payload は 1 回の write で送られる (宣言 payloadLength 未達の
 * FIN を送出し得る 2 回の write の窓を作らない)。チャンク数が
 * 「Subgroup Header 1 + Object 数」と一致し、各チャンクが fields と payload の
 * 連結に一致することを検証する。
 */
test("publishSendObjectInternal: Object ごとに fields と payload を 1 回の write で送る", async () => {
  await fc.assert(
    fc.asyncProperty(subgroupCaseArb, async (testCase) => {
      const { session, streams } = createStreamRecordingSession();
      const publisher = new PublisherImpl(["test"], "track", 0n, testCase.trackAlias);
      const expected = expandSubgroupObjects(testCase.objects);

      for (const object of expected) {
        await publishSendObjectInternal(session, publisher, {
          groupId: testCase.groupId,
          objectId: object.objectId,
          payload: object.payload,
        });
      }

      const stream = elementAt(streams, 0);
      // ヘッダー 1 回 + Object 数分の write のみ (空 payload でも fields のみを 1 回書く)
      assert.equal(stream.chunks.length, 1 + expected.length);

      const { header, objectChunks } = splitSubgroupChunks(stream);
      const decoded = decodeObjectChunks(objectChunks, header.type);
      for (const [index, chunk] of decoded.entries()) {
        const input = elementAt(expected, index);
        assert.equal(chunk.payloadLength, BigInt(input.payload.length));
        assert.deepEqual(chunk.payload, input.payload);
      }
    }),
  );
});

// ============================================================================
// PBT 4: Group 切替と Object ID Delta の基準リセット
// ============================================================================

/**
 * Group ごとの送信内容の任意構築
 *
 * Group ID は単調増加させ、Group をまたぐたびに新しい Subgroup ストリームが
 * 開かれる状況を作る (Group の再訪は Closed Subgroup のエラーパスであり、
 * 単体テストの領分とする)。
 */
const groupSequenceArb = fc.array(
  fc.record({
    groupIdStep: fc.integer({ min: 1, max: 1000 }),
    objects: fc.array(subgroupObjectArb, { minLength: 1, maxLength: 4 }),
  }),
  { minLength: 1, maxLength: 4 },
);

/**
 * draft-ietf-moq-transport-21 §11.3.1:
 * Group を切り替えると新しい Subgroup ストリームが開き、Object ID Delta の基準が
 * リセットされる (新しい Subgroup の先頭 Object は絶対値) ことを検証する。
 * 省略のない Subgroup は FIN で閉じられ、closedSubgroups に登録される。
 */
test("publishSendObjectInternal: Group 切替で新しいストリームが開き delta の基準がリセットされる", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({ trackAlias: trackAliasArb, groups: groupSequenceArb }),
      async ({ trackAlias, groups }) => {
        const { session, streams } = createStreamRecordingSession();
        const publisher = new PublisherImpl(["test"], "track", 0n, trackAlias);

        // Group ID の列を作る (最初の増分は 1 を引いて Group ID 0 を生成できる)
        const groupIds: number[] = [];
        let currentGroupId = -1;
        for (const group of groups) {
          currentGroupId =
            currentGroupId < 0 ? group.groupIdStep - 1 : currentGroupId + group.groupIdStep;
          groupIds.push(currentGroupId);
        }

        for (const [index, group] of groups.entries()) {
          const groupId = elementAt(groupIds, index);
          for (const object of expandSubgroupObjects(group.objects)) {
            await publishSendObjectInternal(session, publisher, {
              groupId,
              objectId: object.objectId,
              payload: object.payload,
            });
          }
        }

        // Group ごとに 1 本のストリームが開く
        assert.equal(streams.length, groups.length);
        assert.equal(session.statsUnidirectionalStreamsOpened, groups.length);
        assert.equal(publisher.getDataStreamCount(), BigInt(groups.length));

        for (const [index, stream] of streams.entries()) {
          const group = elementAt(groups, index);
          const groupId = elementAt(groupIds, index);
          const { header, objectChunks } = splitSubgroupChunks(stream);
          assert.equal(header.groupId, BigInt(groupId));

          // 受信側で読み戻すと Group ごとの Object ID 列と payload が再現される
          const expected = expandSubgroupObjects(group.objects);
          const { objects } = receiveSubgroupObjects(header, objectChunks);
          assert.equal(objects.length, expected.length);
          for (const [objectIndex, object] of objects.entries()) {
            const input = elementAt(expected, objectIndex);
            assert.equal(object.objectId, BigInt(input.objectId));
            assert.deepEqual(object.payload, input.payload);
          }

          // 先頭 Object の delta は絶対値 (前の Group の Object ID を引き継がない)
          const decoded = decodeObjectChunks(objectChunks, header.type);
          assert.equal(
            elementAt(decoded, 0).objectIdDelta,
            BigInt(elementAt(expected, 0).objectId),
          );

          const isLastStream = index === streams.length - 1;
          if (isLastStream) {
            // 最後の Subgroup は Group 切替も END_OF_GROUP もなく開いたまま
            assert.equal(stream.closeCount, 0);
            assert.equal(stream.abortCount, 0);
            assert.isFalse(session.closedSubgroups.has(`${trackAlias}:${groupId}`));
          } else {
            // 省略がないため FIN で閉じられ、再送の拒否対象として登録される
            assert.equal(stream.closeCount, 1);
            assert.equal(stream.abortCount, 0);
            assert.isTrue(session.closedSubgroups.has(`${trackAlias}:${groupId}`));
          }
        }
      },
    ),
  );
});

// ============================================================================
// PBT 5: END_OF_GROUP status
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §11.1.2 / §11.3.2:
 * Object Status が END_OF_GROUP の Object はラウンドトリップし (空 payload 必須)、
 * 送信後に Subgroup が FIN で確定して closedSubgroups に登録されることを検証する。
 */
test("publishSendObjectInternal: END_OF_GROUP status がラウンドトリップし FIN で確定する", async () => {
  await fc.assert(
    fc.asyncProperty(subgroupCaseArb, async (testCase) => {
      const { session, streams } = createStreamRecordingSession();
      const publisher = new PublisherImpl(["test"], "track", 0n, testCase.trackAlias);
      const expected = expandSubgroupObjects(testCase.objects);

      for (const [index, object] of expected.entries()) {
        const isLast = index === expected.length - 1;
        const sendParams: SendObjectParams = {
          groupId: testCase.groupId,
          objectId: object.objectId,
          // §11.1.2: 非 NORMAL status は空 payload のみ許容される
          payload: isLast ? new Uint8Array(0) : object.payload,
          ...(isLast ? { status: ObjectStatus.END_OF_GROUP } : {}),
        };
        await publishSendObjectInternal(session, publisher, sendParams);
      }

      const stream = elementAt(streams, 0);
      const { header, objectChunks } = splitSubgroupChunks(stream);
      const decoded = decodeObjectChunks(objectChunks, header.type);
      assert.equal(decoded.length, expected.length);
      for (const [index, chunk] of decoded.entries()) {
        const isLast = index === decoded.length - 1;
        assert.equal(chunk.status, isLast ? ObjectStatus.END_OF_GROUP : ObjectStatus.NORMAL);
      }

      // END_OF_GROUP の送信で FIN が確定し、ストリーム状態は削除される
      assert.equal(elementAt(decoded, decoded.length - 1).payloadLength, 0n);
      assert.equal(stream.closeCount, 1);
      assert.equal(stream.abortCount, 0);
      assert.isFalse(session.publisherStreams.has(testCase.trackAlias));
      assert.isTrue(
        session.closedSubgroups.has(`${testCase.trackAlias}:${BigInt(testCase.groupId)}`),
      );

      // 受信側でも status が END_OF_GROUP として配送される
      const { objects } = receiveSubgroupObjects(header, objectChunks);
      assert.equal(objects.length, expected.length);
      assert.equal(elementAt(objects, objects.length - 1).status, ObjectStatus.END_OF_GROUP);
    }),
  );
});

// ============================================================================
// PBT 6: delivery timeout の Object Property
// ============================================================================

/**
 * 先頭 Object の delivery timeout の任意構築
 *
 * どちらか一方は必ず指定し、Object Property が空にならない状況を作る。
 */
const deliveryTimeoutArb = fc
  .record({
    deliveryTimeout: fc.option(fc.bigInt({ min: 0n, max: 2n ** 40n }), { nil: undefined }),
    subgroupDeliveryTimeout: fc.option(fc.bigInt({ min: 0n, max: 2n ** 40n }), { nil: undefined }),
  })
  .filter(
    (value) => value.deliveryTimeout !== undefined || value.subgroupDeliveryTimeout !== undefined,
  );

/**
 * draft-ietf-moq-transport-21 §5.2 (Object Delivery Timeout) / §11.3.1:
 * delivery timeout は Subgroup 先頭 Object の Object Property として送られ、
 * 受信側の読み取り (readDeliveryTimeoutObjectProperties) で同じ値に戻ることを
 * 検証する。2 件目以降の Object には載らない。
 */
test("publishSendObjectInternal: 先頭 Object の delivery timeout がラウンドトリップする", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        trackAlias: trackAliasArb,
        groupId: objectIdArb,
        timeouts: deliveryTimeoutArb,
        secondPayload: payloadArb,
      }),
      async ({ trackAlias, groupId, timeouts, secondPayload }) => {
        const { session, streams } = createStreamRecordingSession();
        const publisher = new PublisherImpl(["test"], "track", 0n, trackAlias);

        const firstParams: SendObjectParams = {
          groupId,
          objectId: 0,
          payload: new Uint8Array([1, 2, 3]),
          ...(timeouts.deliveryTimeout !== undefined
            ? { deliveryTimeout: timeouts.deliveryTimeout }
            : {}),
          ...(timeouts.subgroupDeliveryTimeout !== undefined
            ? { subgroupDeliveryTimeout: timeouts.subgroupDeliveryTimeout }
            : {}),
        };
        await publishSendObjectInternal(session, publisher, firstParams);
        await publishSendObjectInternal(session, publisher, {
          groupId,
          objectId: 1,
          payload: secondPayload,
        });

        const { header, objectChunks } = splitSubgroupChunks(elementAt(streams, 0));
        const decoded = decodeObjectChunks(objectChunks, header.type);
        const firstObject = elementAt(decoded, 0);
        const secondObject = elementAt(decoded, 1);

        // 期待する Object Property の値 (未指定の型は載せない)
        const expectedTimeouts: {
          objectDeliveryTimeout?: bigint;
          subgroupDeliveryTimeout?: bigint;
        } = {};
        if (timeouts.deliveryTimeout !== undefined) {
          expectedTimeouts.objectDeliveryTimeout = timeouts.deliveryTimeout;
        }
        if (timeouts.subgroupDeliveryTimeout !== undefined) {
          expectedTimeouts.subgroupDeliveryTimeout = timeouts.subgroupDeliveryTimeout;
        }
        assert.deepEqual(
          readDeliveryTimeoutObjectProperties(firstObject.properties),
          expectedTimeouts,
        );

        // delivery timeout は先頭 Object のみに載る
        assert.deepEqual(readDeliveryTimeoutObjectProperties(secondObject.properties), {});
        assert.deepEqual(secondObject.payload, secondPayload);
        assert.equal(secondObject.objectIdDelta, 0n);
      },
    ),
  );
});

// ============================================================================
// PBT 7: publishCloseSubgroupStream の FIN / RESET
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §11.3.2 (Closing Subgroup Streams):
 * "If a sender closes the stream before delivering all such objects to the QUIC
 *  stream, it MUST reset the stream.  This includes, but is not limited to: ...
 *  Omitting a Subgroup Object due to the subscriber's Forward State"
 * omittedObjects が真の Subgroup は RESET、偽の Subgroup は FIN で閉じ、
 * ストリームが無い場合は何もせず "fin" を返すことを検証する。二重呼び出しは
 * 対象が無いため追加の終端操作を行わない。
 */
test("publishCloseSubgroupStream: 省略の有無に応じて RESET / FIN を選び二重呼び出しに耐える", async () => {
  await fc.assert(
    fc.asyncProperty(
      trackAliasArb,
      objectIdArb,
      fc.boolean(),
      fc.boolean(),
      async (trackAlias, groupId, hasStream, omittedObjects) => {
        const session = createLifecycleSession();
        const { writer, record } = createRecordedWriter();
        if (hasStream) {
          session.publisherStreams.set(trackAlias, {
            groupId: BigInt(groupId),
            writer,
            previousObjectId: 0n,
            omittedObjects,
          });
        }

        const outcome = await publishCloseSubgroupStream(session, trackAlias);

        if (!hasStream) {
          // 閉じる対象が無い場合は side effect なしで "fin" を返す
          assert.equal(outcome, "fin");
          assert.equal(record.closeCount, 0);
          assert.equal(record.abortCount, 0);
          return;
        }

        // RESET は完了を待たずに呼ばれるため、sink への到達を待ってから数える
        await record.termination;
        assert.isFalse(session.publisherStreams.has(trackAlias));
        if (omittedObjects) {
          assert.equal(outcome, "reset");
          assert.equal(record.abortCount, 1);
          assert.equal(record.closeCount, 0);
          assert.deepEqual(record.abortReasons, ["subgroup omitted objects"]);
        } else {
          assert.equal(outcome, "fin");
          assert.equal(record.closeCount, 1);
          assert.equal(record.abortCount, 0);
        }

        // 二重呼び出し: ストリーム状態は既に無いため追加の終端操作は起きない
        const second = await publishCloseSubgroupStream(session, trackAlias);
        assert.equal(second, "fin");
        assert.equal(record.closeCount, omittedObjects ? 0 : 1);
        assert.equal(record.abortCount, omittedObjects ? 1 : 0);
      },
    ),
  );
});

// ============================================================================
// PBT 8 / 9: 後始末系 free function の不変条件
// ============================================================================

/**
 * 後始末テスト用の入力
 */
interface LifecycleCase {
  targetAlias: bigint;
  targetGroups: bigint[];
  otherTracks: { aliasOffset: number; groupId: bigint }[];
  hasStream: boolean;
  omittedObjects: boolean;
}

/**
 * 後始末テスト用の入力の任意構築
 *
 * otherTracks の alias は「targetAlias の 10 倍 + 1..9」とし、10 進表記では
 * targetAlias を接頭辞に含むが `${targetAlias}:` には一致しない値を作る
 * (接頭辞の判定が separator を無視していないことの検証)。
 */
const lifecycleCaseArb: fc.Arbitrary<LifecycleCase> = fc.record({
  targetAlias: fc.bigInt({ min: 0n, max: 100n }),
  targetGroups: fc.array(fc.bigInt({ min: 0n, max: 1000n }), { maxLength: 4 }),
  otherTracks: fc.array(
    fc.record({
      aliasOffset: fc.integer({ min: 1, max: 9 }),
      groupId: fc.bigInt({ min: 0n, max: 1000n }),
    }),
    { maxLength: 4 },
  ),
  hasStream: fc.boolean(),
  omittedObjects: fc.boolean(),
});

/**
 * 後始末テスト用のセッションを構築する
 *
 * targetAlias の track に closedSubgroups エントリ (と、hasStream なら
 * Subgroup ストリーム)、衝突しない他 track のエントリとストリームを登録する。
 */
function createLifecycleSetup(testCase: LifecycleCase): {
  session: SessionInternal;
  targetStream: StreamRecord;
  otherStream: StreamRecord;
  otherAlias: bigint;
  otherKeys: string[];
} {
  const session = createLifecycleSession();
  const target = createRecordedWriter();
  if (testCase.hasStream) {
    session.publisherStreams.set(testCase.targetAlias, {
      groupId: 0n,
      writer: target.writer,
      previousObjectId: 0n,
      omittedObjects: testCase.omittedObjects,
    });
  }
  for (const groupId of testCase.targetGroups) {
    session.closedSubgroups.add(`${testCase.targetAlias}:${groupId}`);
  }

  // 10 進表記で targetAlias を接頭辞に含むが、別 track である鍵
  const otherKeys = new Set<string>();
  for (const other of testCase.otherTracks) {
    const alias = testCase.targetAlias * 10n + BigInt(other.aliasOffset);
    const key = `${alias}:${other.groupId}`;
    session.closedSubgroups.add(key);
    otherKeys.add(key);
  }

  // 対象外 track のストリームと終了済み記録は呼び出しの影響を受けない
  const otherAlias = testCase.targetAlias + 1000n;
  const other = createRecordedWriter();
  session.publisherStreams.set(otherAlias, {
    groupId: 0n,
    writer: other.writer,
    previousObjectId: 0n,
    omittedObjects: false,
  });
  session.closedSubgroups.add(`${otherAlias}:0`);
  otherKeys.add(`${otherAlias}:0`);

  return {
    session,
    targetStream: target.record,
    otherStream: other.record,
    otherAlias,
    otherKeys: [...otherKeys],
  };
}

/**
 * publishClosePublisherStream が対象 track のストリームと closedSubgroups だけを
 * 掃除し、対象外 track の状態を変えないことを検証する。二重呼び出しでも追加の
 * 終端操作は起きない。
 */
test("publishClosePublisherStream: 対象 track の登録だけを掃除し二重呼び出しに耐える", async () => {
  await fc.assert(
    fc.asyncProperty(lifecycleCaseArb, async (testCase) => {
      const { session, targetStream, otherStream, otherAlias, otherKeys } =
        createLifecycleSetup(testCase);

      await publishClosePublisherStream(session, testCase.targetAlias, 30);

      // RESET は完了を待たずに呼ばれるため、sink への到達を待ってから数える
      if (testCase.hasStream) {
        await targetStream.termination;
      }
      assert.isFalse(session.publisherStreams.has(testCase.targetAlias));
      // 対象 track の終了済み記録だけが消え、別 track の記録は残る
      assert.deepEqual([...session.closedSubgroups].sort(), [...otherKeys].sort());
      // 対象外 track のストリームは閉じない
      assert.isTrue(session.publisherStreams.has(otherAlias));
      assert.equal(otherStream.closeCount, 0);
      assert.equal(otherStream.abortCount, 0);

      if (!testCase.hasStream) {
        assert.equal(targetStream.closeCount, 0);
        assert.equal(targetStream.abortCount, 0);
      } else if (testCase.omittedObjects) {
        // §11.3.2: 省略がある Subgroup は FIN ではなく RESET
        assert.equal(targetStream.abortCount, 1);
        assert.equal(targetStream.closeCount, 0);
        assert.deepEqual(targetStream.abortReasons, ["subgroup omitted objects"]);
      } else {
        assert.equal(targetStream.closeCount, 1);
        assert.equal(targetStream.abortCount, 0);
      }

      // 二重呼び出し: ストリーム状態は既に無く、追加の終端操作も状態変化も起きない
      const closeCountAfterFirst = targetStream.closeCount;
      const abortCountAfterFirst = targetStream.abortCount;
      await publishClosePublisherStream(session, testCase.targetAlias, 30);
      assert.equal(targetStream.closeCount, closeCountAfterFirst);
      assert.equal(targetStream.abortCount, abortCountAfterFirst);
      assert.deepEqual([...session.closedSubgroups].sort(), [...otherKeys].sort());
    }),
  );
});

/**
 * draft-ietf-moq-transport-21 §3.1.1:
 * "The Publisher ... MUST reset any open streams associated with the SUBSCRIBE."
 * publishResetPublisherStream が対象 track のストリームを RESET し、送信キューと
 * closedSubgroups を破棄し、対象外 track の状態を変えないことを検証する。
 * 二重呼び出しでも追加の終端操作は起きない。
 */
test("publishResetPublisherStream: 対象 track のストリームと送信キューだけを破棄する", async () => {
  await fc.assert(
    fc.asyncProperty(lifecycleCaseArb, async (testCase) => {
      const { session, targetStream, otherStream, otherAlias, otherKeys } =
        createLifecycleSetup(testCase);
      session.publisherSendQueues.set(testCase.targetAlias, Promise.resolve());
      session.publisherSendQueues.set(otherAlias, Promise.resolve());

      publishResetPublisherStream(session, testCase.targetAlias);

      // RESET は完了を待たずに呼ばれるため、sink への到達を待ってから数える
      if (testCase.hasStream) {
        await targetStream.termination;
      }
      assert.isFalse(session.publisherStreams.has(testCase.targetAlias));
      assert.isFalse(session.publisherSendQueues.has(testCase.targetAlias));
      // 対象外 track のストリーム・送信キュー・終了済み記録は残る
      assert.isTrue(session.publisherStreams.has(otherAlias));
      assert.isTrue(session.publisherSendQueues.has(otherAlias));
      assert.deepEqual([...session.closedSubgroups].sort(), [...otherKeys].sort());
      assert.equal(otherStream.closeCount, 0);
      assert.equal(otherStream.abortCount, 0);

      if (!testCase.hasStream) {
        assert.equal(targetStream.closeCount, 0);
        assert.equal(targetStream.abortCount, 0);
      } else {
        // peer キャンセルの後始末は FIN ではなく RESET
        assert.equal(targetStream.abortCount, 1);
        assert.equal(targetStream.closeCount, 0);
        assert.deepEqual(targetStream.abortReasons, ["peer cancelled subscription"]);
      }

      // 二重呼び出し: ストリーム状態は既に無く、追加の終端操作も起きない
      const abortCountAfterFirst = targetStream.abortCount;
      publishResetPublisherStream(session, testCase.targetAlias);
      assert.equal(targetStream.abortCount, abortCountAfterFirst);
      assert.isFalse(session.publisherStreams.has(testCase.targetAlias));
      assert.deepEqual([...session.closedSubgroups].sort(), [...otherKeys].sort());
    }),
  );
});

// ============================================================================
// PBT 10: Object Datagram のラウンドトリップ
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §11.2.1 (Object Datagram):
 * publishSendDatagram が書き出した datagram を decodeObjectDatagram で読み戻すと、
 * Track Alias / Group ID / Object ID / payload / Publisher Priority が入力と一致し、
 * END_OF_GROUP ビットが endOfGroup と整合することを検証する。Priority 未指定時は
 * Priority フィールドを持たない型になるため、読み戻しでも undefined になる。
 */
test("publishSendDatagram: 書き出した datagram がラウンドトリップする", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        trackAlias: trackAliasArb,
        requests: fc.array(
          fc.record({
            groupId: objectIdArb,
            objectId: objectIdArb,
            // 空 payload の datagram も生成し、payload バイト列なしの型を検証する
            payload: fc.oneof(
              fc.constant(new Uint8Array(0)),
              fc.uint8Array({ minLength: 0, maxLength: 32 }),
            ),
            priority: priorityArb,
            endOfGroup: fc.boolean(),
          }),
          { minLength: 1, maxLength: 4 },
        ),
      }),
      async ({ trackAlias, requests }) => {
        const { session, datagrams, waitForDatagrams } = createDatagramRecordingSession();
        const errors: Error[] = [];
        const publisher = new PublisherImpl(["test"], "track", 0n, trackAlias, (error) => {
          errors.push(error);
        });

        for (const request of requests) {
          const sendParams: SendDatagramParams = {
            groupId: request.groupId,
            objectId: request.objectId,
            payload: request.payload,
            endOfGroup: request.endOfGroup,
            // exactOptionalPropertyTypes のため、指定がある場合だけ priority を載せる
            ...(request.priority !== undefined ? { priority: request.priority } : {}),
          };
          publishSendDatagram(session, publisher, sendParams);
        }
        await waitForDatagrams(requests.length);

        assert.equal(errors.length, 0);
        assert.equal(datagrams.length, requests.length);
        for (const [index, request] of requests.entries()) {
          const encoded = elementAt(datagrams, index);
          const [decoded, consumed] = decodeObjectDatagram(encoded);
          assert.equal(consumed, encoded.length);
          assert.equal(decoded.trackAlias, trackAlias);
          assert.equal(decoded.groupId, BigInt(request.groupId));
          assert.equal(decoded.objectId, BigInt(request.objectId));
          assert.deepEqual(decoded.payload, request.payload);
          assert.equal(decoded.publisherPriority, request.priority);
          // Payload 型の datagram であり、Status は載らない
          assert.isUndefined(decoded.status);
          assert.equal((decoded.type & 0x02) !== 0, request.endOfGroup);
        }
      },
    ),
  );
});

// ============================================================================
// PBT 11: 公開経路の FIN / RESET 選択 (Forward State と Group 送信の任意列)
// ============================================================================

/**
 * 公開経路 (publishSendObject) の操作の任意構築
 *
 * forward は購読の Forward State 切替、send は次の Object の送信である。
 * advanceGroup が真のときは Group ID を進めるため、Group の再訪
 * (Closed Subgroup のエラーパス) は生成しない。
 */
const publisherOperationArb = fc.oneof(
  fc.record({ kind: fc.constant("forward" as const), forward: fc.boolean() }),
  fc.record({ kind: fc.constant("send" as const), advanceGroup: fc.boolean() }),
);

/**
 * draft-ietf-moq-transport-21 §3.1 / §11.3.2:
 * 任意の Forward State 切替と Group 送信の列に対して、閉じる Subgroup が
 * 「Forward State 0 による見送り (省略) があるなら RESET、なければ FIN」に
 * 従うことを検証する。見送りはそのとき開いている Subgroup に記録されるため、
 * 省略の有無は送信順序から決まる。done() も同じ判定で開いている Subgroup を
 * 閉じ、当該 track の closedSubgroups を掃除する。
 */
test("publishSendObject: 任意の操作列で省略の有無に応じて FIN / RESET を選ぶ", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(publisherOperationArb, { minLength: 1, maxLength: 12 }),
      async (operations) => {
        const { session, publisher, streams, errors } = createPublisherHarness();
        const trackAlias = publisher.getTrackAlias();

        // 期待する Subgroup ストリームのモデル。omitted は Forward State 0 の
        // 見送りが「現在開いているストリーム」へ記録された事実を表し、closed は
        // 後続の Group 送信で閉じられた事実を表す。
        const expected: { groupId: number; omitted: boolean; closed: boolean }[] = [];
        let currentGroupId = -1;
        let nextObjectId = 0;

        for (const operation of operations) {
          if (operation.kind === "forward") {
            publisher.setForwardState(operation.forward);
            continue;
          }
          if (operation.advanceGroup) {
            currentGroupId += 1;
            nextObjectId = 0;
          }
          const groupId = Math.max(currentGroupId, 0);
          currentGroupId = groupId;
          const objectId = nextObjectId;
          nextObjectId += 1;

          const opened: { groupId: number; omitted: boolean; closed: boolean } | undefined =
            expected[expected.length - 1];
          if (publisher.forwardState) {
            // 新しい Group の送信は前の Subgroup を閉じて新しいストリームを開く
            if (opened === undefined || opened.groupId !== groupId) {
              if (opened !== undefined) {
                opened.closed = true;
              }
              expected.push({ groupId, omitted: false, closed: false });
            }
          } else if (opened !== undefined) {
            // 見送りは、そのとき開いている Subgroup の省略として記録される
            opened.omitted = true;
          }

          await publisher.sendObject({ groupId, objectId, payload: new Uint8Array([1, 2, 3]) });
        }

        // 生成した操作はすべて有効であり、error 通知は発生しない
        assert.equal(errors.length, 0);
        assert.equal(streams.length, expected.length);

        for (const [index, model] of expected.entries()) {
          const stream = elementAt(streams, index);
          if (!model.closed) {
            // 最後に開いた Subgroup は done() まで開いたまま
            assert.equal(stream.closeCount, 0);
            assert.equal(stream.abortCount, 0);
            continue;
          }
          // RESET は完了を待たずに呼ばれるため、sink への到達を待ってから数える
          await stream.termination;
          if (model.omitted) {
            assert.equal(stream.abortCount, 1);
            assert.equal(stream.closeCount, 0);
            assert.deepEqual(stream.abortReasons, ["subgroup omitted objects"]);
            // RESET した Subgroup は FIN 済みとして登録しない
            assert.isFalse(session.closedSubgroups.has(`${trackAlias}:${model.groupId}`));
          } else {
            assert.equal(stream.closeCount, 1);
            assert.equal(stream.abortCount, 0);
            assert.isTrue(session.closedSubgroups.has(`${trackAlias}:${model.groupId}`));
          }
        }

        // done() は開いている Subgroup を同じ判定で閉じ、当該 track の記録を掃除する
        const lastModel = expected[expected.length - 1];
        const lastStream = streams[streams.length - 1];
        await publisher.done();
        if (lastModel !== undefined && lastStream !== undefined) {
          // done() の RESET も完了を待たずに呼ばれる
          await lastStream.termination;
          if (lastModel.omitted) {
            assert.equal(lastStream.abortCount, 1);
            assert.equal(lastStream.closeCount, 0);
          } else {
            assert.equal(lastStream.closeCount, 1);
            assert.equal(lastStream.abortCount, 0);
          }
        }
        for (const key of session.closedSubgroups) {
          assert.isFalse(key.startsWith(`${trackAlias}:`));
        }
        assert.equal(publisher.state, "closed");
      },
    ),
  );
});
