/**
 * session/publish.ts の単体テスト: Subgroup ストリームの閉じ方 (FIN / RESET)
 *
 * draft-ietf-moq-transport-21 §11.3.2 (Closing Subgroup Streams):
 * "If a sender closes the stream before delivering all such objects to the QUIC
 *  stream, it MUST reset the stream.  This includes, but is not limited to:
 *  ... Omitting a Subgroup Object due to the subscriber's Forward State"
 * 省略 (Forward State 0 による見送り) がある Subgroup は RESET、無い Subgroup は FIN で
 * 閉じることを、実ストリームの sink で close / abort を区別して検証する。
 * モックは使わず、実 WritableStream と実 Map で検証する。
 */

import { test, assert } from "vite-plus/test";
import { PublisherImpl } from "../publisher";
import { ObjectStatus } from "../message";
import { ProtocolViolationError } from "../error";
import type { SessionInternal } from "./types";
import {
  publishClosePublisherStream,
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
  publisher.onSendObjectSkipped = () => {
    const streamState = session.publisherStreams.get(publisher.getTrackAlias());
    if (streamState) {
      streamState.omittedObjects = true;
    }
  };
  publisher.onDoneInternal = async () => {
    await publishClosePublisherStream(session, publisher.getTrackAlias());
  };
  return { session, publisher, records, errors };
}

/**
 * Forward State 0 で省略した後に Group を変更すると RESET で閉じられる。
 */
test("publishSendObject: 省略した Subgroup は Group 変更で RESET される", async () => {
  const { session, publisher, records } = createHarness();

  // Group 0 で 1 件送信してストリームを開く
  await publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });
  assert.equal(records.length, 1);

  // Forward State 0 に落として Group 0 の残りを送る (見送り = 省略)
  publisher.setForwardState(false);
  await publisher.sendObject({ groupId: 0, objectId: 1, payload: new Uint8Array([2]) });

  // Forward State 1 に戻して Group 1 を送る (前の Subgroup を閉じる)
  publisher.setForwardState(true);
  await publisher.sendObject({ groupId: 1, objectId: 0, payload: new Uint8Array([3]) });

  // 省略があるため RESET (abort) で閉じ、FIN (close) は呼ばれない
  assert.equal(records[0].abortCount, 1);
  assert.equal(records[0].closeCount, 0);
  assert.equal(records[0].abortReasons[0], "subgroup omitted objects");
  // RESET した Subgroup は closedSubgroups に登録しない (FIN 済みとして扱わない)
  assert.isFalse(session.closedSubgroups.has("1:0"));
  // 新しい Group のストリームは開かれている
  assert.equal(records.length, 2);
});

/**
 * 省略のない Subgroup は Group 変更で FIN され、closedSubgroups に登録される。
 */
test("publishSendObject: 省略のない Subgroup は Group 変更で FIN される", async () => {
  const { session, publisher, records } = createHarness();

  await publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });
  await publisher.sendObject({ groupId: 0, objectId: 1, payload: new Uint8Array([2]) });
  await publisher.sendObject({ groupId: 1, objectId: 0, payload: new Uint8Array([3]) });

  assert.equal(records[0].closeCount, 1);
  assert.equal(records[0].abortCount, 0);
  assert.isTrue(session.closedSubgroups.has("1:0"));
});

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
