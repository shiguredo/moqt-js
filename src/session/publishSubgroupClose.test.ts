/**
 * session/publish.ts の単体テスト: Subgroup ストリームの閉じ方 (FIN / RESET)
 *
 * draft-ietf-moq-transport-21 §11.3.2 (Closing Subgroup Streams):
 * "If a sender closes the stream before delivering all such objects to the QUIC
 *  stream, it MUST reset the stream.  This includes, but is not limited to:
 *  ... Omitting a Subgroup Object due to the subscriber's Forward State"
 * 省略 (Forward State 0、または購読の Location Filter の範囲外による見送り) がある
 * Subgroup は RESET、無い Subgroup は FIN で閉じることを、実ストリームの sink で
 * close / abort を区別して検証する。
 * モックは使わず、実 WritableStream と実 Map で検証する。
 */

import { test, assert } from "vite-plus/test";
import { PublisherImpl } from "../publisher";
import { ObjectStatus } from "../message";
import { ProtocolViolationError } from "../error";
import type { SessionInternal } from "./types";
import {
  publishClosePublisherStream,
  publishMarkStreamOmitted,
  publishResetPublisherStream,
  publishSendObject,
} from "./publish";

/** 1 本の Subgroup ストリームで観測した終端操作 */
interface StreamRecord {
  closeCount: number;
  abortCount: number;
  abortReasons: unknown[];
}

/**
 * publishSendObject を公開経路 (PublisherImpl.sendObject) から駆動するハーネス
 *
 * `createUnidirectionalStream` は close / abort を記録する実 WritableStream を返す。
 * onSendObjectSkipped の配線は SessionImpl.publish() と同じ形にする。
 */
function createHarness(): {
  session: SessionInternal;
  publisher: PublisherImpl;
  records: StreamRecord[];
  errors: Error[];
} {
  const records: StreamRecord[] = [];
  const transport = {
    createUnidirectionalStream: async (): Promise<WritableStream<Uint8Array>> => {
      const record: StreamRecord = { closeCount: 0, abortCount: 0, abortReasons: [] };
      records.push(record);
      return new WritableStream<Uint8Array>({
        write() {},
        close() {
          record.closeCount += 1;
        },
        abort(reason) {
          record.abortCount += 1;
          record.abortReasons.push(reason);
        },
      });
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

  const errors: Error[] = [];
  const publisher = new PublisherImpl(
    ["live"],
    "track",
    0n,
    1n,
    (error) => {
      errors.push(error);
    },
    undefined,
  );
  publisher.onSendObject = (params) => publishSendObject(session, publisher, params);
  publisher.onSendObjectSkipped = (groupId) => {
    publishMarkStreamOmitted(session, publisher.getTrackAlias(), groupId);
  };
  publisher.onDoneInternal = async () => {
    await publishClosePublisherStream(session, publisher.getTrackAlias());
  };
  return { session, publisher, records, errors };
}

/**
 * 省略した Subgroup は done() でも RESET で閉じられる。
 */
test("publishSendObject: 省略した Subgroup は done() で RESET される", async () => {
  const { publisher, records } = createHarness();

  await publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });
  publisher.setForwardState(false);
  await publisher.sendObject({ groupId: 0, objectId: 1, payload: new Uint8Array([2]) });

  await publisher.done();

  assert.equal(records[0].abortCount, 1);
  assert.equal(records[0].closeCount, 0);
  assert.equal(records[0].abortReasons[0], "subgroup omitted objects");
});

/**
 * draft-ietf-moq-transport-21 §3.3.1 / §11.3.2:
 * 購読の Location Filter の範囲外として送らなかった Object がある Subgroup は、
 * Forward State 0 の見送りと同じく省略として記録され、閉じる時に RESET される。
 */
test("publishSendObject: Location Filter の範囲外で見送った Object がある Subgroup は RESET される", async () => {
  const { publisher, records } = createHarness();

  // REQUEST_UPDATE で狭められた範囲 (Group 0 の Object 0 まで) を反映した状態
  publisher.setLocationFilter({
    startGroup: 0n,
    startObject: 0n,
    endGroupDelta: 0n,
    endObject: 0n,
  });

  await publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });
  // 範囲外は送信されないが、省略として記録される (戻り値は解決済みの Promise)
  await publisher.sendObject({ groupId: 0, objectId: 1, payload: new Uint8Array([2]) });

  await publisher.done();

  assert.equal(records.length, 1);
  assert.equal(records[0].abortCount, 1);
  assert.equal(records[0].closeCount, 0);
  assert.equal(records[0].abortReasons[0], "subgroup omitted objects");
});

/**
 * フィルタによる見送りが無い Subgroup は従来どおり FIN で閉じる。
 */
test("publishSendObject: フィルタの範囲内だけを送った Subgroup は FIN で閉じる", async () => {
  const { publisher, records } = createHarness();

  publisher.setLocationFilter({
    startGroup: 0n,
    startObject: 0n,
    endGroupDelta: 1n,
    endObject: 0n,
  });
  await publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });
  await publisher.sendObject({ groupId: 0, objectId: 1, payload: new Uint8Array([2]) });

  await publisher.done();

  assert.equal(records.length, 1);
  assert.equal(records[0].closeCount, 1);
  assert.equal(records[0].abortCount, 0);
});

/**
 * Group ID として解釈できない値 (非整数・負値・非有限) では省略を記録しない。
 * Forward State 0 の防御分岐は Group ID の検証より前にこの関数を呼ぶため、
 * BigInt 変換で throw しないことが必要になる。
 */
test("publishMarkStreamOmitted: 非整数・負値の Group ID では記録しない", async () => {
  const { session, publisher } = createHarness();
  const trackAlias = publisher.getTrackAlias();
  const stream = await session.transport.createUnidirectionalStream();
  session.publisherStreams.set(trackAlias, {
    groupId: 0n,
    writer: stream.getWriter(),
    previousObjectId: 0n,
    omittedObjects: false,
  });

  for (const groupId of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    publishMarkStreamOmitted(session, trackAlias, groupId);
    assert.isFalse(session.publisherStreams.get(trackAlias)?.omittedObjects);
  }

  // 同じ Group なら記録する
  publishMarkStreamOmitted(session, trackAlias, 0n);
  assert.isTrue(session.publisherStreams.get(trackAlias)?.omittedObjects);
});

/**
 * Forward State 0 の見送りは Group ID の検証より前に記録経路へ入るため、
 * 非整数の Group ID でも throw しない (公開経路から到達する)。
 */
test("publishSendObject: Forward State 0 で非整数の Group ID を送っても throw しない", async () => {
  const { publisher, records, errors } = createHarness();
  await publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });

  publisher.setForwardState(false);
  // 範囲外として見送られる前に guardSend が skip を返す経路
  await publisher.sendObject({ groupId: 1.5, objectId: 0, payload: new Uint8Array([2]) });

  assert.equal(errors.length, 0);
  await publisher.done();

  // 非整数は記録されない (送信済みの Subgroup は省略なしで FIN)
  assert.equal(records.length, 1);
  assert.equal(records[0].closeCount, 1);
  assert.equal(records[0].abortCount, 0);
});

/**
 * 別 Group の Object を範囲外として見送っても、開いている Subgroup が範囲内の
 * Object をすべて渡していれば FIN で閉じる。省略の記録先は同じ Group の Subgroup に
 * 限る (別 Group の見送りで RESET にすると、購読者が Subgroup の完了を判定できない)。
 */
test("publishSendObject: 別 Group の範囲外見送りでは開いている Subgroup は FIN で閉じる", async () => {
  const { publisher, records } = createHarness();

  // Group 0 の Object 0 までに狭める (End Group も 0)
  publisher.setLocationFilter({
    startGroup: 0n,
    startObject: 0n,
    endGroupDelta: 0n,
    endObject: 0n,
  });
  await publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });
  // 範囲外の別 Group の Object は送信されないが、Group 0 の Subgroup の省略ではない
  await publisher.sendObject({ groupId: 1, objectId: 0, payload: new Uint8Array([2]) });

  await publisher.done();

  assert.equal(records.length, 1);
  assert.equal(records[0].closeCount, 1);
  assert.equal(records[0].abortCount, 0);
});

/**
 * datagram の範囲外見送りは Subgroup の省略ではないため、
 * 送信中の Subgroup は FIN のまま閉じる (§11.3.2 の対象は Subgroup Object)。
 */
test("sendDatagram: 範囲外 Datagram の見送りでは Subgroup は FIN で閉じる", async () => {
  const { publisher, records } = createHarness();

  publisher.setLocationFilter({
    startGroup: 0n,
    startObject: 0n,
    endGroupDelta: 0n,
    endObject: 0n,
  });
  await publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });
  // 範囲外の Datagram は送信されないが、Subgroup の省略としては記録しない
  publisher.sendDatagram({ groupId: 0, objectId: 1, payload: new Uint8Array([2]) });

  await publisher.done();

  assert.equal(records.length, 1);
  assert.equal(records[0].closeCount, 1);
  assert.equal(records[0].abortCount, 0);
});

/**
 * END_OF_GROUP status の送信で FIN され、同一 Group への後続送信は拒否される。
 */
test("publishSendObject: END_OF_GROUP で FIN され同一 Group への後続送信が拒否される", async () => {
  const { publisher, records, errors } = createHarness();

  await publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });
  await publisher.sendObject({
    groupId: 0,
    objectId: 1,
    payload: new Uint8Array(0),
    status: ObjectStatus.END_OF_GROUP,
  });

  // 省略がないため FIN
  assert.equal(records[0].closeCount, 1);
  assert.equal(records[0].abortCount, 0);

  // 同一 Group への後続 sendObject は ProtocolViolationError で拒否される
  let rejected: unknown;
  try {
    await publisher.sendObject({ groupId: 0, objectId: 2, payload: new Uint8Array([4]) });
  } catch (error) {
    rejected = error;
  }
  assert.instanceOf(rejected, ProtocolViolationError);
  assert.isTrue(
    (rejected as Error).message.includes(
      "cannot send object after END_OF_GROUP was sent for group 0",
    ),
  );
  assert.equal(errors.length, 1);

  // 別の Group への送信は妨げない
  await publisher.sendObject({ groupId: 1, objectId: 0, payload: new Uint8Array([5]) });
  assert.equal(records.length, 2);
});

/**
 * 省略がある Subgroup を END_OF_GROUP status で閉じる場合は RESET になる。
 */
test("publishSendObject: 省略がある END_OF_GROUP は RESET で閉じる", async () => {
  const { publisher, records } = createHarness();

  await publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });
  publisher.setForwardState(false);
  await publisher.sendObject({ groupId: 0, objectId: 1, payload: new Uint8Array([2]) });
  publisher.setForwardState(true);
  await publisher.sendObject({
    groupId: 0,
    objectId: 2,
    payload: new Uint8Array(0),
    status: ObjectStatus.END_OF_GROUP,
  });

  assert.equal(records[0].abortCount, 1);
  assert.equal(records[0].closeCount, 0);
});

/**
 * peer cancel (STOP_SENDING / RESET_STREAM) 経路の RESET は変わらない。
 */
test("publishResetPublisherStream: peer cancel の RESET は従来どおり", async () => {
  const { session, publisher, records } = createHarness();

  await publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });
  publishResetPublisherStream(session, publisher.getTrackAlias());

  assert.equal(records[0].abortCount, 1);
  assert.equal(records[0].closeCount, 0);
  assert.equal(records[0].abortReasons[0], "peer cancelled subscription");
  // ストリーム状態は削除される
  assert.isFalse(session.publisherStreams.has(publisher.getTrackAlias()));
});
