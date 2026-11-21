import { assert, test } from "vite-plus/test";
import {
  createFirstFetchObjectFlags,
  DatagramType,
  encodeObjectDatagram,
  encodeFetchHeader,
  encodeFetchObjectFields,
  encodeObjectFields,
  encodeSubgroupHeader,
  FetchHeaderType,
  SubgroupHeaderType,
} from "../dataStream";
import { SubscriberImpl } from "../subscriber";
import { createTestSessionInternal, waitForMacrotask, waitForCondition } from "../testSupport/bidi";
import { concatUint8Arrays } from "../testSupport/helpers";
import {
  bidiCancelSubscription,
  createInitialFillFetchTarget,
  registerSubscriberAlias,
} from "./bidi";
import {
  dataStreamHandleIncomingStream,
  type DataStreamSessionInternal,
} from "./dataStreamIncoming";
import { incomingHandleDatagram } from "./incoming";
import type { SessionInternal } from "./types";
import { encodeVarint } from "../varint";

const alias = 7n;
const subgroupHeader = encodeSubgroupHeader({
  type: SubgroupHeaderType.BASE,
  trackAlias: alias,
  groupId: 0n,
  publisherPriority: 128,
  firstObject: false,
});
const completeObject = concatUint8Arrays([
  encodeObjectFields(0n, 1n, SubgroupHeaderType.BASE),
  new Uint8Array([0x42]),
]);

function register(
  session: SessionInternal,
  requestId: bigint,
  track: string,
  object: () => void,
): SubscriberImpl {
  const subscriber = new SubscriberImpl(["live"], track, requestId, alias, object);
  session.subscribers.set(requestId, subscriber);
  registerSubscriberAlias(session, subscriber);
  return subscriber;
}

function openDataStream(session: SessionInternal) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancelReasons: unknown[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel(reason) {
      cancelReasons.push(reason);
    },
  });
  const reading = dataStreamHandleIncomingStream(
    session as unknown as DataStreamSessionInternal,
    stream,
  );
  return { controller, cancelReasons, reading };
}

test("購読解除後に初めて届いた Subgroup を保留せず、Alias の再利用先に渡さない", async () => {
  const { session } = createTestSessionInternal();
  const previous = register(session, 0n, "previous", () => {});
  await bidiCancelSubscription(session, previous);
  const stream = openDataStream(session);
  stream.controller.enqueue(concatUint8Arrays([subgroupHeader, completeObject]));
  try {
    await waitForMacrotask();
    assert.equal(session.pendingSubgroupBuffer.streamCount, 0);
    assert.lengthOf(stream.cancelReasons, 1);
  } finally {
    if (stream.cancelReasons.length === 0) stream.controller.close();
    await stream.reading;
  }

  // ピアが再利用を制御メッセージで確立した後は、その Track への配送を再開できる。
  let delivered = 0;
  register(session, 2n, "next", () => delivered++);
  const nextStream = openDataStream(session);
  nextStream.controller.enqueue(concatUint8Arrays([subgroupHeader, completeObject]));
  nextStream.controller.close();
  await nextStream.reading;
  assert.equal(delivered, 1);
});

test("共有 Alias の最後の購読が解除されたときだけ開いている Subgroup をキャンセルする", async () => {
  const { session } = createTestSessionInternal();
  let delivered = 0;
  const first = register(session, 0n, "video", () => {});
  const remaining = register(session, 2n, "video", () => delivered++);
  const stream = openDataStream(session);
  stream.controller.enqueue(concatUint8Arrays([subgroupHeader, completeObject]));
  try {
    await waitForCondition(
      () => delivered === 1,
      "共有 Alias の Subgroup が開き Object を配信する",
    );
    await bidiCancelSubscription(session, first);
    assert.isEmpty(stream.cancelReasons);
    await bidiCancelSubscription(session, remaining);
    assert.lengthOf(stream.cancelReasons, 1);
  } finally {
    if (stream.cancelReasons.length === 0) stream.controller.close();
    await stream.reading;
  }
});

test("合流通知の直後に Alias が解除と再登録されても、旧 Subgroup を再登録先に渡さない", async () => {
  const { session } = createTestSessionInternal();
  const stream = openDataStream(session);
  stream.controller.enqueue(concatUint8Arrays([subgroupHeader, completeObject]));
  await waitForCondition(
    () => session.pendingSubgroupBuffer.streamCount === 1,
    "Alias の確立前に Subgroup を保留する",
  );

  const previous = register(session, 0n, "previous", () => {});
  session.pendingSubgroupBuffer.notifyAlias(alias, "subscriber");
  const cancelled = bidiCancelSubscription(session, previous);
  let delivered = 0;
  register(session, 2n, "next", () => delivered++);
  session.pendingSubgroupBuffer.notifyAlias(alias, "subscriber");
  stream.controller.close();
  await Promise.all([cancelled, stream.reading]);
  assert.equal(delivered, 0);
});

test("解除済み Alias の Datagram はヘッダーの照合で破棄する", async () => {
  const { session } = createTestSessionInternal();
  const subscriber = register(session, 0n, "video", () => {});
  await bidiCancelSubscription(session, subscriber);
  const wire = encodeObjectDatagram({
    type: DatagramType.PAYLOAD_OBJ,
    trackAlias: alias,
    groupId: 0n,
    objectId: 0n,
    publisherPriority: 128,
    payload: new Uint8Array([1]),
  });
  // Type と Alias までを用意し、その先が読まれてしまうとエラーになる位置で切る。
  incomingHandleDatagram(session, wire.subarray(0, 2));
  assert.equal(session.sessionState, "connected");
});

test("購読解除で処理中の fill fetch ストリームにも STOP_SENDING を送る", async () => {
  const { session } = createTestSessionInternal();
  const subscriber = register(session, 0n, "video", () => {});
  const target = createInitialFillFetchTarget(subscriber, "Ascending", undefined);
  session.fillFetchTargets.set(0n, target);
  const stream = openDataStream(session);
  stream.controller.enqueue(encodeFetchHeader({ type: FetchHeaderType, requestId: 0n }));
  try {
    await waitForCondition(() => target.reader !== undefined, "fill の読み取りが始まる");
    await bidiCancelSubscription(session, subscriber);
    assert.lengthOf(stream.cancelReasons, 1);
  } finally {
    if (stream.cancelReasons.length === 0) stream.controller.close();
    await stream.reading;
  }
  assert.isFalse(session.fillFetchTargets.has(0n));
  assert.equal(session.sessionState, "connected");
});

test("fill Object のコールバック内で解除したら同一チャンクの残りを復号しない", async () => {
  const { session } = createTestSessionInternal();
  let delivered = 0;
  const subscriber = register(session, 0n, "video", () => {
    delivered++;
    void bidiCancelSubscription(session, subscriber);
  });
  session.fillFetchTargets.set(
    0n,
    createInitialFillFetchTarget(subscriber, "Ascending", undefined),
  );
  const stream = openDataStream(session);
  stream.controller.enqueue(
    concatUint8Arrays([
      encodeFetchHeader({ type: FetchHeaderType, requestId: 0n }),
      encodeFetchObjectFields({
        serializationFlags: createFirstFetchObjectFlags(),
        groupId: 0n,
        subgroupId: 0n,
        objectId: 0n,
        publisherPriority: 128,
        payloadLength: 0n,
      }),
      // 解除の後に残った未定義の Indicator は、このセッションの復号エラーにならない。
      encodeVarint(0x82n),
    ]),
  );
  await stream.reading;
  assert.equal(delivered, 1);
  assert.equal(session.sessionState, "connected");
  assert.lengthOf(stream.cancelReasons, 1);
});

test("確立前に FIN した Subgroup は登録だけでは配送せず、確立通知で 1 回配送する", async () => {
  const { session } = createTestSessionInternal();
  const stream = openDataStream(session);
  stream.controller.enqueue(concatUint8Arrays([subgroupHeader, completeObject]));
  await waitForCondition(
    () => session.pendingSubgroupBuffer.streamCount === 1,
    "確立前の Subgroup を保留する",
  );

  // 受信 PUBLISH の PUBLISH_OK 書き込み待ちでは、Alias の登録と確立通知の間に FIN が届き得る。
  let delivered = 0;
  const subscriber = register(session, 0n, "video", () => delivered++);
  const ends: string[] = [];
  subscriber.subgroupEndCallback = ({ reason }) => ends.push(reason);
  stream.controller.close();
  try {
    await waitForMacrotask();
    assert.equal(delivered, 0);
    assert.isEmpty(ends);
    assert.equal(session.pendingSubgroupBuffer.streamCount, 1);
    assert.equal(session.pendingSubgroupBuffer.totalBytes, completeObject.byteLength);
    session.pendingSubgroupBuffer.notifyAlias(alias, "subscriber");
    await stream.reading;
    assert.equal(delivered, 1);
    assert.deepEqual(ends, ["fin"]);
  } finally {
    session.pendingSubgroupBuffer.close();
    await stream.reading;
  }
  assert.equal(session.pendingSubgroupBuffer.streamCount, 0);
  assert.equal(session.pendingSubgroupBuffer.totalBytes, 0);
});
