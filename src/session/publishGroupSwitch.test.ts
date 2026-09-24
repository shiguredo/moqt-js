/**
 * session/publish.ts の単体テスト: Group の切り替えで前の Subgroup の stream の close を待たない
 *
 * WebTransport の `WritableStreamDefaultWriter.close()` は FIN が ACK されるまで解決しない
 * (Chrome)。Group を切り替えるたびにその完了を待つと、新しい Group の先頭の Object の送信が
 * 1 RTT 遅れる。draft-ietf-moq-transport-21 に Group の切り替えで前の stream の完了を待つ
 * 要件は無く、Section 9.9 は PUBLISH_DONE の前に全 stream を閉じることだけを求める。
 *
 * close の完了を呼び出し側が決められる実 WritableStream の sink で、close の完了前に
 * 次の Group の stream が開かれて Object が書かれること、PUBLISH_DONE の前の終了処理が
 * close の完了を待つことを検証する。モックは使わず、実 WritableStream と実 Map で検証する。
 */

import { test, assert } from "vite-plus/test";
import { PublisherImpl } from "../publisher";
import { ObjectStatus } from "../message";
import type { SessionInternal } from "./types";
import {
  publishClosePublisherStream,
  publishMarkStreamOmitted,
  publishSendObject,
} from "./publish";

/** 1 本の Subgroup ストリームの記録と、close の完了を決める口 */
interface StreamRecord {
  writes: Uint8Array[];
  closeStarted: boolean;
  closeFinished: boolean;
  abortCount: number;
  finishClose: () => void;
  failClose: (error: Error) => void;
}

/**
 * close の完了を呼び出し側が決められる Subgroup ストリームを返すハーネス
 *
 * sink の close() は finishClose / failClose が呼ばれるまで解決しない (FIN の ACK 待ちに
 * 相当する)。
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
      let resolveClose: () => void = () => {};
      let rejectClose: (error: Error) => void = () => {};
      const closed = new Promise<void>((resolve, reject) => {
        resolveClose = resolve;
        rejectClose = reject;
      });
      const record: StreamRecord = {
        writes: [],
        closeStarted: false,
        closeFinished: false,
        abortCount: 0,
        finishClose: () => resolveClose(),
        failClose: (error) => rejectClose(error),
      };
      records.push(record);
      return new WritableStream<Uint8Array>({
        write(chunk) {
          record.writes.push(chunk);
        },
        async close() {
          record.closeStarted = true;
          await closed;
          record.closeFinished = true;
        },
        abort() {
          record.abortCount += 1;
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
    publisherPendingCloses: new Map(),
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

/** waitMs ミリ秒待つ */
function sleep(waitMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, waitMs);
  });
}

/** Promise が waitMs 以内に解決したかを返す (解決しない Promise で待ち続けない) */
async function settlesWithin(promise: Promise<unknown>, waitMs: number): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await sleep(waitMs);
  return settled;
}

// 前の Group の stream の close (FIN) が完了していなくても、次の Group の stream を開いて
// 先頭の Object を書く。close の完了を待つと、Group の先頭の送信が FIN の ACK まで
// (1 RTT) 遅れる
test("publishSendObject: 前の Group の stream の close の完了を待たずに次の Group の Object を書く", async () => {
  const { session, publisher, records, errors } = createHarness();

  await publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });
  const next = publisher.sendObject({ groupId: 1, objectId: 0, payload: new Uint8Array([2]) });

  assert.isTrue(await settlesWithin(next, 50), "次の Group の送信が前の close の完了を待った");
  assert.equal(records.length, 2);
  // 前の stream は close (FIN) を始めているが、まだ完了していない
  assert.isTrue(records[0]?.closeStarted);
  assert.isFalse(records[0]?.closeFinished);
  assert.equal(records[0]?.abortCount, 0);
  // 次の stream には Subgroup Header と Object が書かれている
  assert.equal(records[1]?.writes.length, 2);
  // FIN で閉じる Subgroup は、その時点で閉じた Subgroup として扱う
  assert.isTrue(session.closedSubgroups.has(`${publisher.getTrackAlias()}:0`));
  assert.deepEqual(errors, []);
  records[0]?.finishClose();
});

// END_OF_GROUP の Object を送った後の close も完了を待たない
test("publishSendObject: END_OF_GROUP の後の close の完了を待たずに次の Group の Object を書く", async () => {
  const { publisher, records } = createHarness();

  await publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });
  // END_OF_GROUP は payload の無い status の Object である
  const last = publisher.sendObject({
    groupId: 0,
    objectId: 1,
    payload: new Uint8Array(0),
    status: ObjectStatus.END_OF_GROUP,
  });
  assert.isTrue(await settlesWithin(last, 50), "END_OF_GROUP の送信が close の完了を待った");
  assert.isTrue(records[0]?.closeStarted);
  assert.isFalse(records[0]?.closeFinished);

  const next = publisher.sendObject({ groupId: 1, objectId: 0, payload: new Uint8Array([2]) });
  assert.isTrue(await settlesWithin(next, 50));
  assert.equal(records[1]?.writes.length, 2);
  records[0]?.finishClose();
});

// draft-ietf-moq-transport-21 Section 9.9:
// "A sender MUST NOT send PUBLISH_DONE until it has closed all streams it will ever open"
// 購読の終了 (PUBLISH_DONE の前に呼ぶ publishClosePublisherStream) は、完了を待たずに
// 始めた close もすべて完了するまで解決しない
test("publishClosePublisherStream: 完了を待たずに始めた close の完了まで解決しない", async () => {
  const { publisher, records } = createHarness();

  await publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });
  await publisher.sendObject({ groupId: 1, objectId: 0, payload: new Uint8Array([2]) });

  const done = publisher.done();
  // 開いている Group 1 の stream の close は始まる
  await sleep(10);
  assert.isTrue(records[1]?.closeStarted);
  records[1]?.finishClose();
  // Group 0 の stream の close が終わるまで解決しない
  assert.isFalse(await settlesWithin(done, 50), "前の Group の close の完了前に終了した");

  records[0]?.finishClose();
  assert.isTrue(await settlesWithin(done, 50));
  assert.isTrue(records[0]?.closeFinished);
  assert.isTrue(records[1]?.closeFinished);
});

// 完了を待たずに始めた close が失敗したら RESET に切り替え、閉じた Subgroup の登録を外す
// (RESET で閉じた Subgroup は渡し切っていないため、再送を FIN 済みとして拒否しない)。
// 失敗はアプリへ通知せず、未処理の reject も出さない
test("publishSendObject: 完了を待たずに始めた close が失敗したら閉じた Subgroup の登録を外す", async () => {
  const { session, publisher, records, errors } = createHarness();

  await publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });
  await publisher.sendObject({ groupId: 1, objectId: 0, payload: new Uint8Array([2]) });
  assert.isTrue(session.closedSubgroups.has(`${publisher.getTrackAlias()}:0`));

  records[0]?.failClose(new Error("stream reset by peer"));
  await sleep(10);

  assert.isFalse(session.closedSubgroups.has(`${publisher.getTrackAlias()}:0`));
  assert.deepEqual(errors, []);
  // 終了処理は失敗した close を待ち続けない
  const done = publisher.done();
  records[1]?.finishClose();
  assert.isTrue(await settlesWithin(done, 50));
});
