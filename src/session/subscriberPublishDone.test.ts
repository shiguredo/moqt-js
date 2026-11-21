import { assert, test } from "vite-plus/test";
import { ControlStreamWriter } from "../controlStream";
import {
  DatagramType,
  encodeObjectDatagram,
  encodeObjectFields,
  SubgroupHeaderType,
} from "../dataStream";
import { encodePublishDonePayload } from "../message/publish";
import { MessageType, ObjectStatus, PublishDoneStatusCode } from "../message/types";
import { encodeProperties, TrackPropertyId } from "../properties";
import { SubscriberImpl } from "../subscriber";
import {
  createPublishReadTestContext,
  asSessionInternal,
  forceSessionClosed,
  waitForCondition,
} from "../testSupport/bidi";
import {
  bidiReadRequestStreamMessages,
  createInitialFillFetchTarget,
  registerSubscriberAlias,
} from "./bidi";
import {
  dataStreamHandleFillFetchStream,
  dataStreamHandleSubgroupStream,
  type DataStreamSessionInternal,
} from "./dataStreamIncoming";
import { incomingHandleDatagram } from "./incoming";
import { ReceiveBuffer } from "../bytes";
import { concatUint8Arrays } from "../testSupport/helpers";
import { MAX_VARINT } from "../varint";
import { SessionErrorCode } from "../error";

function createSubscriberContext(
  delivery: "stream-only" | "datagram-callback" | "object-callback" = "stream-only",
) {
  const context = createPublishReadTestContext({});
  const dataSession = context.session as unknown as DataStreamSessionInternal;
  const events: string[] = [];
  const subscriber = new SubscriberImpl(
    ["test"],
    "track",
    context.requestId,
    1n,
    () => events.push("Object"),
    delivery === "datagram-callback" ? () => events.push("Datagram") : undefined,
    () => events.push("終了"),
    () => events.push("エラー"),
  );
  if (delivery === "stream-only") {
    subscriber.setRangeFilters([{ type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 0n }] }]);
  }
  context.session.subscribers.set(context.requestId, subscriber);
  registerSubscriberAlias(context.session, subscriber);
  const reading = bidiReadRequestStreamMessages(
    context.session,
    context.requestId,
    context.stream,
    context.controlReader,
    "subscribe",
  );

  async function finishControl(streamCount: bigint, trailing?: Uint8Array): Promise<void> {
    const payload = encodePublishDonePayload({
      type: MessageType.PUBLISH_DONE,
      statusCode: BigInt(PublishDoneStatusCode.TRACK_ENDED),
      streamCount,
      reasonPhrase: "",
    });
    context.readableController.enqueue(
      new ControlStreamWriter().encode(MessageType.PUBLISH_DONE, payload),
    );
    if (trailing !== undefined) {
      context.readableController.enqueue(trailing);
    }
    context.readableController.close();
    await reading;
  }

  return { context, dataSession, subscriber, events, finishControl };
}

const subgroupHeader = {
  type: SubgroupHeaderType.BASE_EXT,
  trackAlias: 1n,
  groupId: 0n,
  subgroupId: 0n,
  publisherPriority: 128,
  firstObject: false,
};

test("PUBLISH_DONE: 制御ストリームの FIN 後に到着した Subgroup を配信する", async () => {
  const { context, dataSession, subscriber, events, finishControl } = createSubscriberContext();
  await finishControl(1n);
  assert.deepEqual(events, [], "制御ストリームの FIN で購読を破棄しない");
  assert.isTrue(context.session.subscribers.has(context.requestId));

  // §9.9 に従い、PUBLISH_DONE より後に開始したストリームの Object と FIN を処理する。
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        concatUint8Arrays([
          encodeObjectFields(0n, 1n, SubgroupHeaderType.BASE_EXT),
          new Uint8Array([7]),
        ]),
      );
      controller.close();
    },
  });
  const reader = stream.getReader();
  try {
    await dataStreamHandleSubgroupStream(dataSession, reader, subgroupHeader, new ReceiveBuffer());
  } finally {
    reader.releaseLock();
  }

  assert.deepEqual(events, ["Object", "終了"]);
  assert.equal(subscriber.state, "closed");
  assert.isFalse(context.session.subscribers.has(context.requestId));
  assert.isFalse(context.session.subscribersByAlias.has(1n));
});

test.each(["datagram-callback", "object-callback"] as const)(
  "PUBLISH_DONE: 遅着 Datagram を受け取ってから購読を終える (%s)",
  async (delivery) => {
    const { context, subscriber, events, finishControl } = createSubscriberContext(delivery);
    subscriber.noteDeliveryTimeout(20n);
    await finishControl(0n);
    assert.isEmpty(events);
    await subscriber.update().then(
      () => assert.fail("PUBLISH_DONE 後に REQUEST_UPDATE を送信できた"),
      (error: unknown) => assert.instanceOf(error, Error),
    );

    incomingHandleDatagram(
      asSessionInternal(context.session),
      encodeObjectDatagram({
        type: DatagramType.PAYLOAD_OBJ_NO_PRI,
        trackAlias: 1n,
        groupId: 0n,
        objectId: 0n,
        payload: new Uint8Array([1]),
      }),
    );

    await waitForCondition(() => subscriber.state === "closed", "Datagram の終了待機が完了する");
    assert.deepEqual(events, [delivery === "object-callback" ? "Object" : "Datagram", "終了"]);
    assert.isFalse(context.session.subscribers.has(context.requestId));
  },
);

test("PUBLISH_DONE: 不明な本数で待機時間が過ぎても処理中の Subgroup は終端まで残す", async () => {
  const { dataSession, subscriber, events, finishControl } = createSubscriberContext();
  subscriber.noteDeliveryTimeout(1n);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const reader = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  }).getReader();
  const receiving = dataStreamHandleSubgroupStream(
    dataSession,
    reader,
    subgroupHeader,
    new ReceiveBuffer(),
  );
  try {
    await finishControl(MAX_VARINT);
    // 合流済みの空 Subgroup でも、タイマーの後に FIN を待つ。
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    assert.isEmpty(events);
    assert.equal(subscriber.state, "active");
  } finally {
    controller.close();
    await receiving;
    reader.releaseLock();
  }
  assert.deepEqual(events, ["終了"]);
});

test("PUBLISH_DONE: 遅着 Subgroup の配信タイムアウトが判明したら終了期限を延ばす", async () => {
  const { context, dataSession, subscriber, events, finishControl } = createSubscriberContext();
  subscriber.noteDeliveryTimeout(1n);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const reader = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  }).getReader();
  const receiving = dataStreamHandleSubgroupStream(
    dataSession,
    reader,
    { ...subgroupHeader, type: SubgroupHeaderType.BASE_EXT_FIRST, firstObject: true },
    new ReceiveBuffer(),
  );
  try {
    await finishControl(MAX_VARINT);
    // 当初の期限が過ぎても、処理中の Subgroup の最初の Object はまだ到着し得る。
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    const properties = encodeProperties([
      { id: TrackPropertyId.SUBGROUP_DELIVERY_TIMEOUT, value: 10_000n },
    ]);
    controller.enqueue(
      concatUint8Arrays([
        encodeObjectFields(
          0n,
          1n,
          SubgroupHeaderType.BASE_EXT_FIRST,
          ObjectStatus.NORMAL,
          properties,
        ),
        Uint8Array.of(7),
      ]),
    );
    controller.close();
    await receiving;
    // §9.9: 長い配信タイムアウトが判明したので、別の遅着ストリームも受けられる。
    assert.deepEqual(events, ["Object"]);
    assert.equal(subscriber.state, "active");
    assert.isTrue(context.session.subscribers.has(context.requestId));
  } finally {
    forceSessionClosed(context.session);
    await reader.cancel();
    await receiving;
    reader.releaseLock();
  }
});

test("PUBLISH_DONE: 後着の fill ストリームを Stream Count に数える", async () => {
  const { context, dataSession, subscriber, events, finishControl } = createSubscriberContext();
  const target = createInitialFillFetchTarget(subscriber, "Ascending", undefined);
  context.session.fillFetchTargets.set(context.requestId, target);
  await finishControl(1n);
  assert.equal(context.session.fillFetchTargets.get(context.requestId), target);

  // 空の fill もストリームとして閉じる。この FIN で購読の処理本数が揃う。
  const reader = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  }).getReader();
  try {
    await dataStreamHandleFillFetchStream(
      dataSession,
      reader,
      context.requestId,
      target,
      new ReceiveBuffer(),
    );
  } finally {
    reader.releaseLock();
  }
  assert.deepEqual(events, ["終了"]);
  assert.isFalse(context.session.fillFetchTargets.has(context.requestId));
});

test("PUBLISH_DONE: 待機中にセッションが終了したら購読と Alias を解放する", async () => {
  const { context, subscriber, events, finishControl } = createSubscriberContext();
  await finishControl(1n);
  forceSessionClosed(context.session);
  assert.equal(subscriber.state, "closed");
  assert.isEmpty(events);
  assert.isFalse(context.session.subscribers.has(context.requestId));
  assert.isFalse(context.session.subscribersByAlias.has(1n));
});

test("PUBLISH_DONE: 後続の制御メッセージを適用しない", async () => {
  const { context, finishControl } = createSubscriberContext();
  // 別チャンクの二重 PUBLISH_DONE も、最終メッセージの後に届いた時点で違反になる。
  const trailing = new ControlStreamWriter().encode(MessageType.PUBLISH_DONE, new Uint8Array());
  await finishControl(0n, trailing);
  assert.equal(context.closedWithError?.code, SessionErrorCode.UNEXPECTED_MESSAGE);
});
