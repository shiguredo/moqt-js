/**
 * session/publish.ts の publishSendObjectInternal の単体テスト
 *
 * Subgroup Header のエンコードをストリーム生成前に移動した方式 (b) の検証。
 * trackAlias / groupId が 2^64-1 を超える場合、エンコードが throw し、
 * ストリーム未生成・統計カウント不変のまま失敗することを検証する。
 */

import { test, assert } from "vite-plus/test";
import { PublisherImpl } from "../publisher";
import { publishSendObject, publishSendObjectInternal } from "./publish";
import type { SessionInternal } from "./types";
import { encodeObjectFields, encodeSubgroupHeader, SubgroupHeaderType } from "../dataStream";
import { ObjectStatus } from "../message";
import { calculateObjectIdDelta } from "./params";
import { mergeDeliveryTimeoutObjectProperties } from "../properties";

/**
 * publishSendObjectInternal を駆動するための session を構築する。
 *
 * createUnidirectionalStream は呼び出し回数を記録してから実ストリームを返す。
 * ストリーム機構は実物 (ReadableStream / WritableStream) で構成する。
 */
function createSessionForPublish(): {
  session: SessionInternal;
  unidirectionalStreamCreated: () => number;
} {
  let unidirectionalStreamCreatedCount = 0;

  const transport = {
    createUnidirectionalStream: async (): Promise<WritableStream<Uint8Array>> => {
      unidirectionalStreamCreatedCount++;
      return new WritableStream<Uint8Array>();
    },
  } as unknown as WebTransport;

  const session = {
    transport,
    publisherStreams: new Map(),
    closedSubgroups: new Set<string>(),
    publisherSendQueues: new Map(),
    grease: false,
    statsUnidirectionalStreamsOpened: 0,
  } as unknown as SessionInternal;

  return {
    session,
    unidirectionalStreamCreated: () => unidirectionalStreamCreatedCount,
  };
}

/**
 * draft-ietf-moq-transport-20 Section 11.4.2 (Subgroup Header):
 * Subgroup Header の trackAlias / groupId は varint (最大 2^64-1) でエンコードされる。
 * 2^64 以上の値はエンコードできないため、ストリーム生成前に throw し、
 * ストリームが生成されないことを検証する。
 */
test("publishSendObjectInternal: groupId が 2^64 以上の場合はストリーム未生成で throw する", async () => {
  const { session, unidirectionalStreamCreated } = createSessionForPublish();
  const publisher = new PublisherImpl(["test"], "track", 0n, 1n);

  let thrown: Error | undefined;
  try {
    await publishSendObjectInternal(session, publisher, {
      // 2^64 は double で正確に表現できるため number のまま渡し、
      // publishSendObjectInternal 内の BigInt 変換で 2^64n になる
      groupId: 2 ** 64,
      objectId: 0,
      payload: new Uint8Array([1, 2, 3]),
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  // 方式 (b): ヘッダエンコードをストリーム生成前に移動したため、throw 時点で
  // ストリームが未生成であり、統計カウントも増えない
  assert.equal(unidirectionalStreamCreated(), 0);
  assert.equal(session.statsUnidirectionalStreamsOpened, 0);
  assert.equal(session.publisherStreams.size, 0);
});

/**
 * draft-ietf-moq-transport-20 Section 11.4.2 (Subgroup Header):
 * 正常範囲の groupId は従来どおりストリームを生成してヘッダを書き込むことを検証する。
 */
test("publishSendObjectInternal: 正常範囲の groupId はストリームを生成する", async () => {
  const { session, unidirectionalStreamCreated } = createSessionForPublish();
  const publisher = new PublisherImpl(["test"], "track", 0n, 1n);

  let thrown: Error | undefined;
  try {
    await publishSendObjectInternal(session, publisher, {
      groupId: 0,
      objectId: 0,
      payload: new Uint8Array([1, 2, 3]),
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isUndefined(thrown);
  assert.equal(unidirectionalStreamCreated(), 1);
  assert.equal(session.statsUnidirectionalStreamsOpened, 1);
  assert.equal(session.publisherStreams.size, 1);
});

/** Uint8Array 配列を連結するヘルパー */
function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * 書き込まれたチャンクを記録するセッションを構築する。
 *
 * ストリーム機構は実物 (WritableStream) で構成し、write 完了した
 * チャンクのみを記録する (保留中の書き込みは完了扱いにしない)。
 */
function createChunkRecordingSession(): {
  session: SessionInternal;
  written: Uint8Array[];
} {
  const written: Uint8Array[] = [];
  const transport = {
    createUnidirectionalStream: async (): Promise<WritableStream<Uint8Array>> => {
      return new WritableStream<Uint8Array>({
        write(chunk) {
          written.push(chunk);
        },
      });
    },
  } as unknown as WebTransport;
  const session = {
    transport,
    publisherStreams: new Map(),
    closedSubgroups: new Set<string>(),
    publisherSendQueues: new Map(),
    grease: false,
    statsUnidirectionalStreamsOpened: 0,
  } as unknown as SessionInternal;
  return { session, written };
}

/**
 * draft-ietf-moq-transport-20 §11.4 / §11.4.3 (Closing Subgroup Streams):
 * Object Fields と payload は 1 回の write() で送信する。
 * 従来の 2 write (fields / payload) とワイヤバイト列が同一であり、
 * オブジェクト送出の write 回数がヘッダーとは別に 1 回であることを検証する。
 */
test("publishSendObjectInternal: Object Fields と payload は単一 write で送信される", async () => {
  const { session, written } = createChunkRecordingSession();
  const publisher = new PublisherImpl(["test"], "track", 0n, 1n);
  const payload = new Uint8Array([1, 2, 3, 4]);

  await publishSendObjectInternal(session, publisher, { groupId: 0, objectId: 0, payload });

  // ヘッダー write + オブジェクト write の 2 回 (従来は 3 回)
  assert.equal(written.length, 2);
  // ワイヤバイト列は従来の 2 write 連結と同一である
  const expectedHeader = encodeSubgroupHeader({
    type: SubgroupHeaderType.FIRST_OBJ_EXT,
    trackAlias: 1n,
    groupId: 0n,
    publisherPriority: 128,
    firstObject: true,
  });
  const objectProperties = mergeDeliveryTimeoutObjectProperties(undefined, undefined, undefined);
  const expectedFields = encodeObjectFields(
    calculateObjectIdDelta(-1n, 0n),
    BigInt(payload.length),
    SubgroupHeaderType.FIRST_OBJ_EXT,
    ObjectStatus.NORMAL,
    objectProperties,
  );
  assert.deepEqual(
    concatUint8Arrays(written),
    concatUint8Arrays([expectedHeader, expectedFields, payload]),
  );
  // 連結順序の構造 check: オブジェクト write の末尾は payload そのもの
  // (encoder 関数に依存しない独立した検証)
  assert.deepEqual(written[1].slice(-payload.length), payload);
});

/**
 * 同一 Group の 2 件目はヘッダーなしの単一 write になることを検証する。
 * 単一 write 化が初回オブジェクト以外にも適用される一般性を裏付ける。
 */
test("publishSendObjectInternal: 同一 Group の 2 件目は header なし単一 write になる", async () => {
  const { session, written } = createChunkRecordingSession();
  const publisher = new PublisherImpl(["test"], "track", 0n, 1n);

  await publishSendObjectInternal(session, publisher, {
    groupId: 0,
    objectId: 0,
    payload: new Uint8Array([1, 2]),
  });
  await publishSendObjectInternal(session, publisher, {
    groupId: 0,
    objectId: 1,
    payload: new Uint8Array([3, 4, 5]),
  });

  // ヘッダー write + オブジェクト write 2 回の計 3 回
  assert.equal(written.length, 3);
  const objectProperties = mergeDeliveryTimeoutObjectProperties(undefined, undefined, undefined);
  const expectedFields = encodeObjectFields(
    calculateObjectIdDelta(0n, 1n),
    3n,
    SubgroupHeaderType.FIRST_OBJ_EXT,
    ObjectStatus.NORMAL,
    objectProperties,
  );
  assert.deepEqual(written[2], concatUint8Arrays([expectedFields, new Uint8Array([3, 4, 5])]));
});

/**
 * 空 payload 時は fields のみの単一 write になる (従来どおり)。
 */
test("publishSendObjectInternal: 空 payload 時は fields のみの単一 write になる", async () => {
  const { session, written } = createChunkRecordingSession();
  const publisher = new PublisherImpl(["test"], "track", 0n, 1n);

  await publishSendObjectInternal(session, publisher, {
    groupId: 0,
    objectId: 0,
    payload: new Uint8Array(0),
  });

  // ヘッダー write + fields write の 2 回
  assert.equal(written.length, 2);
  const objectProperties = mergeDeliveryTimeoutObjectProperties(undefined, undefined, undefined);
  const expectedFields = encodeObjectFields(
    calculateObjectIdDelta(-1n, 0n),
    0n,
    SubgroupHeaderType.FIRST_OBJ_EXT,
    ObjectStatus.NORMAL,
    objectProperties,
  );
  assert.deepEqual(written[1], expectedFields);
});

/**
 * delivery timeout 付きでも properties 合成後の fields と payload が
 * 単一 write で送信されることを検証する (連結は data を不透明に扱う)。
 */
test("publishSendObjectInternal: delivery timeout 付きも単一 write で送信される", async () => {
  const { session, written } = createChunkRecordingSession();
  const publisher = new PublisherImpl(["test"], "track", 0n, 1n);
  const payload = new Uint8Array([9, 8, 7]);

  await publishSendObjectInternal(session, publisher, {
    groupId: 0,
    objectId: 0,
    payload,
    deliveryTimeout: 100n,
  });

  // ヘッダー write + オブジェクト write の 2 回
  assert.equal(written.length, 2);
  const objectProperties = mergeDeliveryTimeoutObjectProperties(undefined, 100n, undefined);
  const expectedFields = encodeObjectFields(
    calculateObjectIdDelta(-1n, 0n),
    BigInt(payload.length),
    SubgroupHeaderType.FIRST_OBJ_EXT,
    ObjectStatus.NORMAL,
    objectProperties,
  );
  assert.deepEqual(written[1], concatUint8Arrays([expectedFields, payload]));
});

/**
 * オブジェクトバイト列の write を遅延させるセッションを構築する。
 *
 * ヘッダー write は即完了し、オブジェクトバイト列 write の完了は呼び出し側が
 * releaseObjectWrite() で解放するまで保留される。完了したチャンクのみを
 * 記録するため、割り込みで失敗した書き込みはワイヤに残らない。
 */
function createCloseInterleavingSession(): {
  session: SessionInternal;
  completed: Uint8Array[];
  objectWriteStarted: Promise<void>;
  releaseObjectWrite: () => void;
} {
  const completed: Uint8Array[] = [];
  let resolveObjectStarted!: () => void;
  const objectWriteStarted = new Promise<void>((resolve) => {
    resolveObjectStarted = resolve;
  });
  let releaseObjectWrite!: () => void;
  let writeCount = 0;
  const transport = {
    createUnidirectionalStream: async (): Promise<WritableStream<Uint8Array>> => {
      return new WritableStream<Uint8Array>({
        write(chunk): Promise<void> {
          writeCount++;
          if (writeCount === 1) {
            // ヘッダー write は即完了する
            completed.push(chunk);
            return Promise.resolve();
          }
          if (writeCount === 2) {
            // オブジェクトバイト列 write は解放まで保留する
            resolveObjectStarted();
            return new Promise<void>((resolve) => {
              releaseObjectWrite = () => {
                completed.push(chunk);
                resolve();
              };
            });
          }
          completed.push(chunk);
          return Promise.resolve();
        },
      });
    },
  } as unknown as WebTransport;
  const session = {
    transport,
    publisherStreams: new Map(),
    closedSubgroups: new Set<string>(),
    publisherSendQueues: new Map(),
    grease: false,
    statsUnidirectionalStreamsOpened: 0,
  } as unknown as SessionInternal;
  return {
    session,
    completed,
    objectWriteStarted,
    releaseObjectWrite: () => releaseObjectWrite(),
  };
}

/**
 * draft-ietf-moq-transport-20 §11.4 / §11.4.3:
 * オブジェクトバイト列の write 待ちに close (FIN) が割り込んでも、宣言
 * payloadLength 未達の partial ワイヤが生成されず、完全なバイト列の後に FIN
 * が出ることを検証する。実 WritableStream 注入で確定的に駆動し、モックは
 * 使わない。
 */
test("publishSendObject: 書き込み待ちへの close 割り込みで完全なバイト列の後に FIN が出る", async () => {
  const { session, completed, objectWriteStarted, releaseObjectWrite } =
    createCloseInterleavingSession();
  const errors: Error[] = [];
  const publisher = new PublisherImpl(["test"], "track", 0n, 1n, (error) => {
    errors.push(error);
  });
  const payload = new Uint8Array([1, 2, 3, 4]);

  const promise = publishSendObject(session, publisher, { groupId: 0, objectId: 0, payload });
  // オブジェクトバイト列 write が保留されるまで待ってから close を割り込ませる
  // (SessionImpl.close() の closeWriterSafely 相当の FIN)
  await objectWriteStarted;
  const internalWriter = session.publisherStreams.get(1n)?.writer;
  assert.isDefined(internalWriter);
  const closePromise = internalWriter!.close();
  releaseObjectWrite();
  await promise;
  await closePromise;

  // 完了したのはヘッダーと完全なバイト列のみで、部分バイトは残らない
  assert.equal(completed.length, 2);
  const objectProperties = mergeDeliveryTimeoutObjectProperties(undefined, undefined, undefined);
  const expectedFields = encodeObjectFields(
    calculateObjectIdDelta(-1n, 0n),
    BigInt(payload.length),
    SubgroupHeaderType.FIRST_OBJ_EXT,
    ObjectStatus.NORMAL,
    objectProperties,
  );
  assert.deepEqual(completed[1], concatUint8Arrays([expectedFields, payload]));
  // 失敗していないため error 通知はなく、closedSubgroups にも登録されない
  assert.equal(errors.length, 0);
  assert.isFalse(session.closedSubgroups.has("1:0"));
});

/**
 * 閉じたストリームへの送信は write 失敗として closedSubgroups へ登録後に
 * publisher の error コールバックへ通知され、sendObject の返却 Promise は
 * reject しないことを検証する。
 */
test("publishSendObject: 閉じたストリームへの送信は error 通知し reject しない", async () => {
  const { session, written } = createChunkRecordingSession();
  const errors: Error[] = [];
  const publisher = new PublisherImpl(["test"], "track", 0n, 1n, (error) => {
    errors.push(error);
  });
  const payload = new Uint8Array([1, 2, 3, 4]);

  await publishSendObject(session, publisher, { groupId: 0, objectId: 0, payload });
  const countAfterFirst = written.length;
  // SessionImpl.close() 相当: 送信ストリームを FIN で閉じる
  const internalWriter = session.publisherStreams.get(1n)?.writer;
  assert.isDefined(internalWriter);
  await internalWriter!.close();
  // 同一 Group への送信は閉じた writer への write で失敗する
  await publishSendObject(session, publisher, { groupId: 0, objectId: 1, payload });

  // 返却 Promise は reject せず、error コールバックで通知される
  assert.equal(errors.length, 1);
  // FIN 済みストリームへの再送禁止のため closedSubgroups に登録される
  assert.isTrue(session.closedSubgroups.has("1:0"));
  // 新しいバイトはワイヤに出ない
  assert.equal(written.length, countAfterFirst);
});
