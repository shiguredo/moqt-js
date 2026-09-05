/**
 * session/publish.ts の publishSendObjectInternal の単体テスト
 *
 * Subgroup Header のエンコードをストリーム生成前に移動した方式 (b) の検証。
 * trackAlias / groupId が 2^64-1 を超える場合、エンコードが throw し、
 * ストリーム未生成・統計カウント不変のまま失敗することを検証する。
 */

import { test, assert } from "vite-plus/test";
import { PublisherImpl } from "../publisher";
import { publishSendObjectInternal } from "./publish";
import type { SessionInternal } from "./types";

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
