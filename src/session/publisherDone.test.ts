import { assert, test } from "vite-plus/test";
import { ControlStreamReader, ControlStreamWriter } from "../controlStream";
import { encodeLocationFilterParameter } from "../message/parameter";
import { decodePublishDonePayload } from "../message/publish";
import { encodeRequestUpdatePayload } from "../message/subscribe";
import { MessageType } from "../message/types";
import {
  createPublishReadTestContext,
  forceSessionClosed,
  waitForCondition,
  waitForMacrotask,
} from "../testSupport/bidi";
import { concatUint8Arrays } from "../testSupport/helpers";
import { bidiReadRequestStreamMessages } from "./bidi";

/** 書き込みの到達と再開を制御する一度限りの通知。 */
function deferredSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const firstObject = { groupId: 0, objectId: 0, payload: new Uint8Array([1]) };
const nextObject = { groupId: 1, objectId: 0, payload: new Uint8Array([2]) };

test("Largest Object: 保留中または失敗した書き込みは最大位置を進めない", async () => {
  const objectStarted = deferredSignal();
  const releaseObject = deferredSignal();
  const { publisher } = createPublishReadTestContext({}, 0, {
    unidirectionalStream: () => {
      let writes = 0;
      return new WritableStream<Uint8Array>({
        async write() {
          if (++writes === 2) {
            objectStarted.resolve();
            await releaseObject.promise;
          } else if (writes === 3) {
            throw new Error("object write failed");
          }
        },
      });
    },
  });
  const first = publisher.sendObject(firstObject);
  try {
    await objectStarted.promise;
    // ヘッダーを書き終えても、保留中の Object は通知の基準にならない。
    assert.isNull(publisher.getLargestLocation());
    releaseObject.resolve();
    await first;
    await publisher.sendObject({ ...firstObject, objectId: 9 });
    assert.deepEqual(publisher.getLargestLocation(), { group: 0n, object: 0n });
  } finally {
    releaseObject.resolve();
    await first;
    await publisher.done();
  }
});

test("done(): 受理済みの Object を書いて Subgroup を閉じ、新しい送信を拒否する", async () => {
  const started = deferredSignal();
  const release = deferredSignal();
  const context = createPublishReadTestContext({
    write() {
      started.resolve();
      return release.promise;
    },
  });
  const { publisher } = context;
  const sent = publisher.sendObject(firstObject);
  const done = publisher.done();
  try {
    await started.promise;
    await sent;
    // §9.9: PUBLISH_DONE が書き込まれる時点で、受理済みの Subgroup は FIN 済み。
    assert.lengthOf(context.subgroupStreams, 1);
    assert.equal(context.subgroupStreams[0]?.closeCount, 1);
    assert.throws(() => publisher.sendObject(nextObject), "Publisher is closing");
    assert.throws(() => publisher.sendDatagram(nextObject), "Publisher is closing");
    await publisher.closeSubgroup();
    await publisher.notifyStateChange({ paused: true });
    assert.isFalse(publisher.paused);
  } finally {
    release.resolve();
    await done;
  }
  assert.lengthOf(context.subgroupStreams, 1);
  assert.isEmpty(context.datagramChunks);
  assert.deepEqual(context.events, ["write", "close"]);
});

test("done(): 終了済み購読の送信キューを保持しない", async () => {
  const { publisher, session } = createPublishReadTestContext({});
  await publisher.sendObject(firstObject);
  await publisher.done();
  assert.isFalse(session.publisherSendQueues.has(publisher.getTrackAlias()));
});

test.each([false, true])(
  "STOP_SENDING を受けた Subgroup は FIN の成否に関わらず再度開かない (FIN 開始前: %s)",
  async (stopBeforeFin) => {
    let streamController!: WritableStreamDefaultController;
    const stopped = Object.assign(new Error("peer stopped the subgroup"), {
      source: "stream",
      streamErrorCode: 1,
    });
    const context = createPublishReadTestContext({}, 0, {
      unidirectionalStream: () =>
        new WritableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
          },
          close() {
            throw stopped;
          },
        }),
    });
    await context.publisher.sendObject(firstObject);
    if (stopBeforeFin) streamController.error(stopped);
    await context.publisher.closeSubgroup();
    await waitForMacrotask();

    try {
      // §11.3.2: ピアが受信を止めた Subgroup は閉じた状態を維持する。
      await context.publisher.sendObject({ ...firstObject, objectId: 1 });
      assert.lengthOf(context.subgroupStreams, 1);
      assert.equal(context.publisher.getDataStreamCount(), 1n);
    } finally {
      await context.publisher.done();
    }
  },
);

test("書き込み中に STOP_SENDING を受けた Group は、次の Group を送った後も再度開かない", async () => {
  const stopped = Object.assign(new Error("peer stopped the subgroup"), {
    source: "stream",
    streamErrorCode: 1,
  });
  const context = createPublishReadTestContext({}, 0, {
    unidirectionalStream() {
      let writes = 0;
      return new WritableStream<Uint8Array>({
        write() {
          // 先頭のヘッダーと Object を通し、次の Object でピアの停止を観測する。
          if (++writes === 3) throw stopped;
        },
      });
    },
  });
  const { publisher, session } = context;
  try {
    await publisher.sendObject(firstObject);
    await publisher.sendObject({ ...firstObject, objectId: 1 });
    assert.isFalse(session.publisherStreams.has(publisher.getTrackAlias()));
    await publisher.sendObject(nextObject);
    await publisher.sendObject({ ...firstObject, objectId: 2 });
    // 閉じた writer を Group 切替時に再処理すると、STOP_SENDING の記録を失い得る。
    assert.lengthOf(context.subgroupStreams, 2);
    assert.equal(publisher.getDataStreamCount(), 2n);
  } finally {
    await publisher.done();
  }
});

test("省略により RESET する予定の Subgroup も STOP_SENDING を受けた後は再度開かない", async () => {
  let streamController!: WritableStreamDefaultController;
  const stopped = Object.assign(new Error("peer stopped the subgroup"), {
    source: "stream",
    streamErrorCode: 1,
  });
  const { publisher, subgroupStreams } = createPublishReadTestContext({}, 0, {
    unidirectionalStream: () =>
      new WritableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
      }),
  });
  try {
    await publisher.sendObject(firstObject);
    publisher.setPaused(true);
    await publisher.sendObject({ ...firstObject, objectId: 1 });
    publisher.setPaused(false);

    // Object が残っている間にピアが受信を止めた場合も、同じ Subgroup は開かない。
    streamController.error(stopped);
    await publisher.closeSubgroup();
    await waitForMacrotask();
    await publisher.sendObject({ ...firstObject, objectId: 2 });
    assert.lengthOf(subgroupStreams, 1);
    assert.equal(publisher.getDataStreamCount(), 1n);
  } finally {
    await publisher.done();
  }
});

test("done(): ヘッダー送信前の RESET を待ち、開いたストリームを Stream Count に含める", async () => {
  const opening = deferredSignal();
  const releaseOpen = deferredSignal();
  const resetting = deferredSignal();
  const releaseReset = deferredSignal();
  const chunks: Uint8Array[] = [];
  const context = createPublishReadTestContext({}, 0, {
    async unidirectionalStream() {
      opening.resolve();
      await releaseOpen.promise;
      return new WritableStream<Uint8Array>({
        write(chunk) {
          chunks.push(chunk);
        },
        abort() {
          resetting.resolve();
          return releaseReset.promise;
        },
      });
    },
  });
  const sent = context.publisher.sendObject(firstObject);
  await opening.promise;
  context.publisher.setPaused(true);
  const done = context.publisher.done();
  try {
    releaseOpen.resolve();
    await resetting.promise;
    await waitForMacrotask();
    // §9.9: ヘッダーが無くても、開いたストリームの RESET が済むまで終了通知を出さない。
    assert.isEmpty(chunks);
    assert.isEmpty(context.written);
  } finally {
    releaseOpen.resolve();
    releaseReset.resolve();
    await Promise.all([sent, done]);
  }
  const [message] = new ControlStreamReader().feed(concatUint8Arrays(context.written));
  assert.equal(message?.type, MessageType.PUBLISH_DONE);
  assert.equal(decodePublishDonePayload(message!.payload).streamCount, 1n);
});

test("done(): セッション終了で開いていた Subgroup の RESET 待ちを解除する", async () => {
  const resetting = deferredSignal();
  const releaseReset = deferredSignal();
  const context = createPublishReadTestContext({}, 0, {
    unidirectionalStream: () =>
      new WritableStream<Uint8Array>({
        abort() {
          resetting.resolve();
          return releaseReset.promise;
        },
      }),
  });
  const { publisher, session } = context;
  await publisher.sendObject(firstObject);
  publisher.setPaused(true);
  // §11.3.2: 続く Object を見送ったストリームは RESET で閉じる。
  await publisher.sendObject({ ...firstObject, objectId: 1 });
  let finished = false;
  const done = publisher.done().then(() => {
    finished = true;
  });
  try {
    await resetting.promise;
    await waitForMacrotask();
    assert.isFalse(finished);
    assert.isEmpty(context.written);
    forceSessionClosed(session);
    await waitForCondition(() => finished, "セッション終了時に RESET 待ちを解除する");
    assert.isEmpty(context.written);
    assert.equal(session.publisherPendingCloses.size, 0);
  } finally {
    releaseReset.resolve();
    await done;
  }
});

test("done(): 購読の末尾の Datagram が writer を通過してから PUBLISH_DONE を書く", async () => {
  const firstStarted = deferredSignal();
  const releaseFirst = deferredSignal();
  const lastStarted = deferredSignal();
  const releaseLast = deferredSignal();
  let writtenDatagrams = 0;
  const context = createPublishReadTestContext({}, 0, {
    datagramWritable: new WritableStream<Uint8Array>({
      write() {
        writtenDatagrams++;
        if (writtenDatagrams === 1) {
          firstStarted.resolve();
          return releaseFirst.promise;
        }
        lastStarted.resolve();
        return releaseLast.promise;
      },
    }),
  });
  const first = context.publisher.sendDatagram(firstObject);
  const last = context.publisher.sendDatagram(nextObject);
  const done = context.publisher.done();
  try {
    await firstStarted.promise;
    await waitForMacrotask();
    assert.isEmpty(context.written);
    releaseFirst.resolve();
    await lastStarted.promise;
    await waitForMacrotask();
    assert.isEmpty(context.written);
  } finally {
    releaseFirst.resolve();
    releaseLast.resolve();
    await Promise.all([first, last, done]);
  }
  assert.deepEqual(context.events, ["write", "close"]);
});

test("done(): セッションが終了すれば共有 Datagram writer を待ち続けない", async () => {
  const started = deferredSignal();
  const release = deferredSignal();
  const context = createPublishReadTestContext({}, 0, {
    datagramWritable: new WritableStream<Uint8Array>({
      write() {
        started.resolve();
        return release.promise;
      },
    }),
  });
  const sent = context.publisher.sendDatagram(firstObject);
  await started.promise;
  let finished = false;
  const done = context.publisher.done().then(() => {
    finished = true;
  });
  try {
    await waitForMacrotask();
    assert.isFalse(finished);
    forceSessionClosed(context.session);
    await waitForCondition(() => finished, "セッション終了後に done() が解決する");
    assert.isEmpty(context.written);
  } finally {
    release.resolve();
    await Promise.all([sent, done]);
  }
});

test("done(): 書き込み中の PUBLISH_DONE の後に REQUEST_OK を追加しない", async () => {
  const started = deferredSignal();
  const release = deferredSignal();
  const context = createPublishReadTestContext({
    write() {
      started.resolve();
      return release.promise;
    },
  });
  const reading = bidiReadRequestStreamMessages(
    context.session,
    context.requestId,
    context.stream,
    context.controlReader,
    "publish",
  );
  const done = context.publisher.done();
  try {
    await started.promise;
    // PUBLISH_DONE の write が完了する前にピアの購読更新が届く。
    const payload = encodeRequestUpdatePayload({
      type: MessageType.REQUEST_UPDATE,
      requestId: 101n,
      parameters: [encodeLocationFilterParameter({ startGroup: 2n, startObject: 0n })],
    });
    context.readableController.enqueue(
      new ControlStreamWriter().encode(MessageType.REQUEST_UPDATE, payload),
    );
    await waitForCondition(
      () => context.session.receivedRequestIds.has(101n),
      "REQUEST_UPDATE が読み取られる",
    );
  } finally {
    release.resolve();
    context.readableController.close();
    await Promise.all([done, reading]);
  }
  const messages = new ControlStreamReader().feed(concatUint8Arrays(context.written));
  assert.deepEqual(
    messages.map((message) => message.type),
    [MessageType.PUBLISH_DONE],
  );
  assert.deepEqual(context.events, ["write", "close"]);
  assert.isUndefined(context.publisher.getResolvedLocationFilter());
});
