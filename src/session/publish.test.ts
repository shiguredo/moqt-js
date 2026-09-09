/**
 * session/publish.ts の publishSendObject 系の単体テスト
 *
 * ID 値域の fail-fast 検証 (不正 Group / Object ID で通知 + reject / throw し、
 * ストリーム未生成・統計カウント不変のまま失敗する) と、単一 write 化の検証。
 */

import { test, assert } from "vite-plus/test";
import { PublisherImpl } from "../publisher";
import { SessionError } from "../error";
import {
  publishClosePublisherStream,
  publishSendDatagram,
  publishSendObject,
  publishSendObjectInternal,
} from "./publish";
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
  closedWithError: () => SessionError | undefined;
} {
  let unidirectionalStreamCreatedCount = 0;

  const transport = {
    createUnidirectionalStream: async (): Promise<WritableStream<Uint8Array>> => {
      unidirectionalStreamCreatedCount++;
      return new WritableStream<Uint8Array>();
    },
    datagrams: {
      writable: new WritableStream<Uint8Array>(),
    },
  } as unknown as WebTransport;

  let closedWithError: SessionError | undefined;
  const session = {
    transport,
    publisherStreams: new Map(),
    closedSubgroups: new Set<string>(),
    publisherSendQueues: new Map(),
    grease: false,
    statsUnidirectionalStreamsOpened: 0,
    closeWithError: (error: SessionError) => {
      closedWithError = error;
    },
  } as unknown as SessionInternal;

  return {
    session,
    unidirectionalStreamCreated: () => unidirectionalStreamCreatedCount,
    closedWithError: () => closedWithError,
  };
}

/**
 * draft-ietf-moq-transport-21 Section 11.3.1 (Subgroup Header):
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
  assert.isTrue(thrown!.message.includes("invalid group id"));
  // 方式 (b): ヘッダエンコードをストリーム生成前に移動したため、throw 時点で
  // ストリームが未生成であり、統計カウントも増えない
  assert.equal(unidirectionalStreamCreated(), 0);
  assert.equal(session.statsUnidirectionalStreamsOpened, 0);
  assert.equal(session.publisherStreams.size, 0);
});

/**
 * draft-ietf-moq-transport-21 Section 11.3.1 (Subgroup Header):
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

/**
 * draft-ietf-moq-transport-21 §11.3.1:
 * Object ID が 2^64 以上の場合、ストリーム生成前に throw し、
 * ストリームが生成されないことを検証する (groupId 検証と同位置)。
 */
test("publishSendObjectInternal: objectId が 2^64 以上の場合はストリーム未生成で throw する", async () => {
  const { session, unidirectionalStreamCreated } = createSessionForPublish();
  const publisher = new PublisherImpl(["test"], "track", 0n, 1n);

  let thrown: Error | undefined;
  try {
    await publishSendObjectInternal(session, publisher, {
      groupId: 0,
      objectId: 2 ** 64,
      payload: new Uint8Array([1, 2, 3]),
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("invalid object id"));
  // 検証はストリーム生成より前のため、副作用が残らない
  assert.equal(unidirectionalStreamCreated(), 0);
  assert.equal(session.statsUnidirectionalStreamsOpened, 0);
  assert.equal(session.publisherStreams.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §11.3.1:
 * Object ID が負の場合もストリーム生成前に throw することを検証する。
 */
test("publishSendObjectInternal: objectId が負の場合はストリーム未生成で throw する", async () => {
  const { session, unidirectionalStreamCreated } = createSessionForPublish();
  const publisher = new PublisherImpl(["test"], "track", 0n, 1n);

  let thrown: Error | undefined;
  try {
    await publishSendObjectInternal(session, publisher, {
      groupId: 0,
      objectId: -1,
      payload: new Uint8Array([1, 2, 3]),
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("invalid object id"));
  assert.equal(unidirectionalStreamCreated(), 0);
  assert.equal(session.statsUnidirectionalStreamsOpened, 0);
  assert.equal(session.publisherStreams.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §11.3.1:
 * 公開 sendObject に不正 objectId を渡すと、返値 Promise が reject し、
 * セッションを閉じないことを検証する。通知契約のため error 通知も行う。
 */
test("publishSendObject: 不正 objectId (-1) で reject しセッションを閉じない", async () => {
  // 不正値は fail-fast で呼び出し元へ返し、セッション全体は閉じない
  const { session, unidirectionalStreamCreated, closedWithError } = createSessionForPublish();
  const errors: Error[] = [];
  const publisher = new PublisherImpl(["test"], "track", 0n, 1n, (error) => {
    errors.push(error);
  });

  let rejected: Error | undefined;
  try {
    await publishSendObject(session, publisher, {
      groupId: 0,
      objectId: -1,
      payload: new Uint8Array([1, 2, 3]),
    });
  } catch (error) {
    rejected = error instanceof Error ? error : new Error(String(error));
  }

  // 返値 Promise が reject し、通知契約のため error 通知も行う (同一オブジェクト)
  assert.isDefined(rejected);
  assert.isTrue(rejected!.message.includes("invalid object id"));
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], rejected);
  // セッションは閉じない
  assert.isUndefined(closedWithError());
  // 新規 Group でもストリームが生成されず、統計も進まない
  assert.equal(unidirectionalStreamCreated(), 0);
  assert.equal(session.statsUnidirectionalStreamsOpened, 0);
  assert.equal(session.publisherStreams.size, 0);
  assert.equal(session.publisherSendQueues.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §11.3.1:
 * 公開 sendObject に 2^64 以上の objectId を渡すと、返値 Promise が reject し、
 * セッションを閉じないことを検証する。
 */
test("publishSendObject: objectId が 2^64 以上の場合に reject しセッションを閉じない", async () => {
  // 上限超過も fail-fast で呼び出し元へ返す
  const { session, unidirectionalStreamCreated, closedWithError } = createSessionForPublish();
  const errors: Error[] = [];
  const publisher = new PublisherImpl(["test"], "track", 0n, 1n, (error) => {
    errors.push(error);
  });

  let rejected: Error | undefined;
  try {
    await publishSendObject(session, publisher, {
      groupId: 0,
      objectId: 2 ** 64,
      payload: new Uint8Array([1, 2, 3]),
    });
  } catch (error) {
    rejected = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(rejected);
  assert.isTrue(rejected!.message.includes("invalid object id"));
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], rejected);
  assert.isUndefined(closedWithError());
  assert.equal(unidirectionalStreamCreated(), 0);
  assert.equal(session.statsUnidirectionalStreamsOpened, 0);
  assert.equal(session.publisherStreams.size, 0);
  assert.equal(session.publisherSendQueues.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §11.3.1:
 * 公開 sendObject に 2^64 以上の groupId を渡すと、返値 Promise が reject し、
 * セッションを閉じないことを検証する (objectId と同一契約)。
 */
test("publishSendObject: groupId が 2^64 以上の場合に reject しセッションを閉じない", async () => {
  // groupId の範囲外も objectId と同じ fail-fast 契約に揃える
  const { session, unidirectionalStreamCreated, closedWithError } = createSessionForPublish();
  const errors: Error[] = [];
  const publisher = new PublisherImpl(["test"], "track", 0n, 1n, (error) => {
    errors.push(error);
  });

  let rejected: Error | undefined;
  try {
    await publishSendObject(session, publisher, {
      groupId: 2 ** 64,
      objectId: 0,
      payload: new Uint8Array([1, 2, 3]),
    });
  } catch (error) {
    rejected = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(rejected);
  assert.isTrue(rejected!.message.includes("invalid group id"));
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], rejected);
  assert.isUndefined(closedWithError());
  assert.equal(unidirectionalStreamCreated(), 0);
  assert.equal(session.statsUnidirectionalStreamsOpened, 0);
  assert.equal(session.publisherStreams.size, 0);
  assert.equal(session.publisherSendQueues.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §11.3.1:
 * 公開 sendObject に範囲外 priority を渡すと、返値 Promise が reject し、
 * FIN 等の副作用なしに失敗することを検証する。
 */
test("publishSendObject: 範囲外 priority (300) で reject し副作用を残さない", async () => {
  // 丸め送信せず fail-fast で呼び出し元へ返す
  const { session, unidirectionalStreamCreated, closedWithError } = createSessionForPublish();
  const errors: Error[] = [];
  const publisher = new PublisherImpl(["test"], "track", 0n, 1n, (error) => {
    errors.push(error);
  });

  let rejected: Error | undefined;
  try {
    await publishSendObject(session, publisher, {
      groupId: 0,
      objectId: 0,
      payload: new Uint8Array([1, 2, 3]),
      priority: 300,
    });
  } catch (error) {
    rejected = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(rejected);
  assert.isTrue(rejected!.message.includes("invalid publisher priority"));
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], rejected);
  assert.isUndefined(closedWithError());
  assert.equal(unidirectionalStreamCreated(), 0);
  assert.equal(session.statsUnidirectionalStreamsOpened, 0);
  assert.equal(session.publisherStreams.size, 0);
  assert.equal(session.publisherSendQueues.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §11.3.1:
 * 内部実装に直接不正 priority を渡すと、既存ストリームの FIN なしに
 * throw することを検証する (ID 検証と同位置のため副作用なし)。
 */
test("publishSendObjectInternal: 不正 priority で既存ストリームを FIN せず throw する", async () => {
  // Group 切替で旧ストリームの FIN が走る配置にし、不正 priority で呼ぶ
  const { session, unidirectionalStreamCreated } = createSessionForPublish();
  const publisher = new PublisherImpl(["test"], "track", 0n, 1n);
  let finCalled = false;
  const oldWritable = new WritableStream<Uint8Array>({
    close() {
      finCalled = true;
    },
  });
  session.publisherStreams.set(1n, {
    groupId: 0n,
    writer: oldWritable.getWriter(),
    previousObjectId: 5n,
  });

  let thrown: Error | undefined;
  try {
    await publishSendObjectInternal(session, publisher, {
      groupId: 1,
      objectId: 0,
      payload: new Uint8Array([1, 2, 3]),
      priority: 300,
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  // 検証は lookup・FIN より前のため、旧ストリームは閉じず新規も作らない
  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("invalid publisher priority"));
  assert.isFalse(finCalled);
  assert.equal(unidirectionalStreamCreated(), 0);
  assert.isTrue(session.publisherStreams.has(1n));
  assert.equal(session.publisherStreams.get(1n)?.groupId, 0n);
  assert.equal(session.publisherStreams.get(1n)?.previousObjectId, 5n);
});

/**
 * draft-ietf-moq-transport-21 §11.3.1:
 * 公開 sendObject の境界値 0 / 255 は従来どおり送信できることを検証する。
 */
test("publishSendObject: 境界値 0 / 255 の priority は送信できる", async () => {
  // 有効範囲の両端は fail-fast に掛からない
  for (const priority of [0, 255]) {
    const { session, unidirectionalStreamCreated } = createSessionForPublish();
    const errors: Error[] = [];
    const publisher = new PublisherImpl(["test"], "track", 0n, 1n, (error) => {
      errors.push(error);
    });

    await publishSendObject(session, publisher, {
      groupId: 0,
      objectId: 0,
      payload: new Uint8Array([1, 2, 3]),
      priority,
    });

    assert.equal(errors.length, 0);
    assert.equal(unidirectionalStreamCreated(), 1);
  }
});

/**
 * draft-ietf-moq-transport-21 §11.3.1:
 * 公開 sendObject に -1 / 非整数の priority を渡すと reject することを検証する。
 */
test("publishSendObject: -1 / 非整数の priority で reject する", async () => {
  // 代表値 300 以外の不正値も同一経路で拒否する
  for (const priority of [-1, 1.5]) {
    const { session, unidirectionalStreamCreated, closedWithError } = createSessionForPublish();
    const errors: Error[] = [];
    const publisher = new PublisherImpl(["test"], "track", 0n, 1n, (error) => {
      errors.push(error);
    });

    let rejected: Error | undefined;
    try {
      await publishSendObject(session, publisher, {
        groupId: 0,
        objectId: 0,
        payload: new Uint8Array([1, 2, 3]),
        priority,
      });
    } catch (error) {
      rejected = error instanceof Error ? error : new Error(String(error));
    }

    assert.isDefined(rejected);
    assert.isTrue(rejected!.message.includes("invalid publisher priority"));
    assert.equal(errors.length, 1);
    assert.isUndefined(closedWithError());
    assert.equal(unidirectionalStreamCreated(), 0);
  }
});

/**
 * draft-ietf-moq-transport-21 §11.2:
 * datagram 送信に不正 objectId を渡すと、通知して throw することを検証する
 * (戻り値が void のため throw 維持。sendObject の通知 + reject と対称)。
 */
test("publishSendDatagram: 不正 objectId で通知して throw する", () => {
  // 送信前に検証し、通知してから throw する
  const { session, closedWithError } = createSessionForPublish();
  const errors: Error[] = [];
  const publisher = new PublisherImpl(["test"], "track", 0n, 1n, (error) => {
    errors.push(error);
  });

  let thrown: Error | undefined;
  try {
    publishSendDatagram(session, publisher, {
      groupId: 0,
      objectId: -1,
      payload: new Uint8Array([1, 2, 3]),
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("invalid object id"));
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], thrown);
  assert.isUndefined(closedWithError());
});

/**
 * draft-ietf-moq-transport-21 §11.2:
 * datagram 送信に範囲外 priority を渡すと、通知して throw することを検証する。
 */
test("publishSendDatagram: 範囲外 priority (300) で通知して throw する", () => {
  // 丸め送信せず fail-fast で呼び出し元へ返す
  const { session, closedWithError } = createSessionForPublish();
  const errors: Error[] = [];
  const publisher = new PublisherImpl(["test"], "track", 0n, 1n, (error) => {
    errors.push(error);
  });

  let thrown: Error | undefined;
  try {
    publishSendDatagram(session, publisher, {
      groupId: 0,
      objectId: 0,
      payload: new Uint8Array([1, 2, 3]),
      priority: 300,
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("invalid publisher priority"));
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], thrown);
  assert.isUndefined(closedWithError());
  // 検証は writer 取得より前のため、datagram writer は生成されない
  assert.isUndefined(session.datagramWriter);
});

/**
 * draft-ietf-moq-transport-21 §11.2:
 * datagram 送信の境界値 0 / 255 は従来どおり送信できることを検証する。
 */
test("publishSendDatagram: 境界値 0 / 255 の priority は送信できる", () => {
  // 有効範囲の両端は fail-fast に掛からず writer を取得する
  for (const priority of [0, 255]) {
    const { session, closedWithError } = createSessionForPublish();
    const errors: Error[] = [];
    const publisher = new PublisherImpl(["test"], "track", 0n, 1n, (error) => {
      errors.push(error);
    });

    publishSendDatagram(session, publisher, {
      groupId: 0,
      objectId: 0,
      payload: new Uint8Array([1, 2, 3]),
      priority,
    });

    assert.equal(errors.length, 0);
    assert.isUndefined(closedWithError());
    assert.isDefined(session.datagramWriter);
  }
});

/**
 * draft-ietf-moq-transport-21 §11.2:
 * datagram 送信に -1 / 非整数の priority を渡すと通知して throw することを検証する。
 */
test("publishSendDatagram: -1 / 非整数の priority で通知して throw する", () => {
  // 代表値 300 以外の不正値も同一経路で拒否する
  for (const priority of [-1, 1.5]) {
    const { session, closedWithError } = createSessionForPublish();
    const errors: Error[] = [];
    const publisher = new PublisherImpl(["test"], "track", 0n, 1n, (error) => {
      errors.push(error);
    });

    let thrown: Error | undefined;
    try {
      publishSendDatagram(session, publisher, {
        groupId: 0,
        objectId: 0,
        payload: new Uint8Array([1, 2, 3]),
        priority,
      });
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    }

    assert.isDefined(thrown);
    assert.isTrue(thrown!.message.includes("invalid publisher priority"));
    assert.equal(errors.length, 1);
    assert.isUndefined(closedWithError());
    assert.isUndefined(session.datagramWriter);
  }
});

/**
 * draft-ietf-moq-transport-21 §11.3.1:
 * 公開 sendObject に負の groupId を渡すと、返値 Promise が reject することを検証する。
 */
test("publishSendObject: groupId が負の場合に reject しセッションを閉じない", async () => {
  // 上限超過と同様に fail-fast で呼び出し元へ返す
  const { session, unidirectionalStreamCreated, closedWithError } = createSessionForPublish();
  const errors: Error[] = [];
  const publisher = new PublisherImpl(["test"], "track", 0n, 1n, (error) => {
    errors.push(error);
  });

  let rejected: Error | undefined;
  try {
    await publishSendObject(session, publisher, {
      groupId: -1,
      objectId: 0,
      payload: new Uint8Array([1, 2, 3]),
    });
  } catch (error) {
    rejected = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(rejected);
  assert.isTrue(rejected!.message.includes("invalid group id"));
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], rejected);
  assert.isUndefined(closedWithError());
  assert.equal(unidirectionalStreamCreated(), 0);
  assert.equal(session.publisherStreams.size, 0);
  assert.equal(session.publisherSendQueues.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §11.3.1:
 * 公開 sendObject に非整数の objectId を渡すと、返値 Promise が reject することを検証する。
 */
test("publishSendObject: 非整数の objectId で reject しセッションを閉じない", async () => {
  // 非整数は整数チェックで弾き、同一の通知 + reject 経路で返す
  const { session, unidirectionalStreamCreated, closedWithError } = createSessionForPublish();
  const errors: Error[] = [];
  const publisher = new PublisherImpl(["test"], "track", 0n, 1n, (error) => {
    errors.push(error);
  });

  let rejected: Error | undefined;
  try {
    await publishSendObject(session, publisher, {
      groupId: 0,
      objectId: 1.5,
      payload: new Uint8Array([1, 2, 3]),
    });
  } catch (error) {
    rejected = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(rejected);
  assert.isTrue(rejected!.message.includes("invalid object id"));
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], rejected);
  assert.isUndefined(closedWithError());
  assert.equal(unidirectionalStreamCreated(), 0);
  assert.equal(session.publisherStreams.size, 0);
  assert.equal(session.publisherSendQueues.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §11.3.1:
 * 公開 sendObject に非整数の groupId を渡すと、返値 Promise が reject することを検証する。
 */
test("publishSendObject: 非整数の groupId で reject しセッションを閉じない", async () => {
  // objectId と同じ整数チェックで弾く
  const { session, unidirectionalStreamCreated, closedWithError } = createSessionForPublish();
  const errors: Error[] = [];
  const publisher = new PublisherImpl(["test"], "track", 0n, 1n, (error) => {
    errors.push(error);
  });

  let rejected: Error | undefined;
  try {
    await publishSendObject(session, publisher, {
      groupId: 1.5,
      objectId: 0,
      payload: new Uint8Array([1, 2, 3]),
    });
  } catch (error) {
    rejected = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(rejected);
  assert.isTrue(rejected!.message.includes("invalid group id"));
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], rejected);
  assert.isUndefined(closedWithError());
  assert.equal(unidirectionalStreamCreated(), 0);
  assert.equal(session.publisherStreams.size, 0);
  assert.equal(session.publisherSendQueues.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §11.2:
 * datagram 送信に不正 groupId を渡すと、通知して throw することを検証する。
 */
test("publishSendDatagram: 不正 groupId で通知して throw する", () => {
  // objectId と同様に送信前に検証する
  const { session, closedWithError } = createSessionForPublish();
  const errors: Error[] = [];
  const publisher = new PublisherImpl(["test"], "track", 0n, 1n, (error) => {
    errors.push(error);
  });

  let thrown: Error | undefined;
  try {
    publishSendDatagram(session, publisher, {
      groupId: 2 ** 64,
      objectId: 0,
      payload: new Uint8Array([1, 2, 3]),
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("invalid group id"));
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], thrown);
  assert.isUndefined(closedWithError());
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
 * draft-ietf-moq-transport-21 §11.3 / §11.3.2 (Closing Subgroup Streams):
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
 * draft-ietf-moq-transport-21 §11.3 / §11.3.2:
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

// ============================================================================
// publishClosePublisherStream のタイマー解放
// writer.close のタイムアウトは確定時に解放する
// ============================================================================

test("publishClosePublisherStream: 詰まった close は短い timeout で打ち切り掃除する", async () => {
  // 終わらない close でも短い timeout で打ち切り、登録を掃除する
  const { session } = createSessionForPublish();
  // 実ストリームに書き込みを詰まらせ、close が終わらない状態を作る
  const stuck = new WritableStream<Uint8Array>({
    write: () => new Promise<void>(() => {}),
  });
  const stuckWriter = stuck.getWriter();
  const aborted: unknown[] = [];
  const originalAbort = stuckWriter.abort.bind(stuckWriter);
  stuckWriter.abort = async (reason?: unknown) => {
    aborted.push(reason);
    return originalAbort(reason);
  };
  const payload = new Uint8Array([1, 2, 3]);
  // 書き込みを詰まらせる (完了を待たず、close を終わらなくする)
  void stuckWriter.write(payload).catch(() => {});
  session.publisherStreams.set(1n, {
    groupId: 0n,
    writer: stuckWriter,
    previousObjectId: 0n,
  });
  session.closedSubgroups.add("1:0");

  const started = Date.now();
  await publishClosePublisherStream(session, 1n, 30);
  const elapsed = Date.now() - started;

  // 短い timeout で打ち切られ、登録と終了済み記録が掃除される
  assert.isBelow(elapsed, 2000);
  // 打ち切り時は RESET のため abort を試みる (完了は待たない)
  assert.deepEqual(aborted, ["publisher stream cleanup"]);
  assert.isFalse(session.publisherStreams.has(1n));
  assert.isFalse(session.closedSubgroups.has("1:0"));
  stuckWriter.releaseLock();
});

test("publishClosePublisherStream: 正常 close で登録を掃除する", async () => {
  // 成功時は待たずに掃除する
  const { session } = createSessionForPublish();
  const writable = new WritableStream<Uint8Array>();
  session.publisherStreams.set(1n, {
    groupId: 0n,
    writer: writable.getWriter(),
    previousObjectId: 0n,
  });
  session.closedSubgroups.add("1:0");

  await publishClosePublisherStream(session, 1n, 30);

  assert.isFalse(session.publisherStreams.has(1n));
  assert.isFalse(session.closedSubgroups.has("1:0"));
});

// ============================================================================
// draft-21 適合監査 D-10: 送信関数の forward state 参照
// draft-ietf-moq-transport-21 §3.1
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §3.1:
 * "The publisher does not send Objects if the Forward State is 0"
 * 内部送信関数を直接呼んでも Forward State = 0 ではストリームを生成しない。
 */
test("publishSendObject: forwardState=false ではストリームを生成しない", async () => {
  const { session, unidirectionalStreamCreated } = createSessionForPublish();
  const publisher = new PublisherImpl(["test"], "track", 0n, 1n);
  publisher.setForwardState(false);

  await publishSendObject(session, publisher, {
    groupId: 0,
    objectId: 0,
    payload: new Uint8Array([1]),
  });

  assert.equal(unidirectionalStreamCreated(), 0);
  assert.equal(session.publisherStreams.size, 0);
});

/**
 * draft-ietf-moq-transport-21 §3.1:
 * Datagram も Object であるため、Forward State = 0 では送信経路に入らない。
 */
test("publishSendDatagram: forwardState=false では datagram writer を取得しない", () => {
  const { session } = createSessionForPublish();
  const publisher = new PublisherImpl(["test"], "track", 0n, 1n);
  publisher.setForwardState(false);

  publishSendDatagram(session, publisher, {
    groupId: 0,
    objectId: 0,
    payload: new Uint8Array([1]),
  });

  // 送信経路に入っていれば datagramWriter が取得されるため、未取得を検証する
  assert.isUndefined(session.datagramWriter);
});
