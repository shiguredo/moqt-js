/**
 * session/publish.ts の単体テスト: endOfSubgroup による Subgroup の終端
 *
 * draft-ietf-moq-transport-22 §11.3.2 (Closing Subgroup Streams):
 * "If a sender has delivered all objects in a Subgroup to the QUIC stream,
 *  except any Objects with Locations smaller than the subscription's Start
 *  Location, it MUST close the stream with a FIN."
 * Subgroup に載せる Object が残っていないことを送信側が知っている場合 (catalog は
 * 1 Group に 1 Object だけを載せるため常にこれに当たる) に、Object の書き込み完了直後へ
 * FIN を出す経路 (SendObjectParams.endOfSubgroup) を、実 WritableStream の sink で
 * close / abort を区別して検証する。
 * フレームワークのモックは使わず、実 WritableStream と実 Map で検証する。
 */

import { test, assert } from "vite-plus/test";
import { PublisherImpl } from "../publisher";
import type { SessionInternal } from "./types";
import { publishMarkStreamOmitted, publishSendObject } from "./publish";

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
 *
 * @param options closeRejects を真にすると、sink の close が失敗するストリームを返す
 *   (FIN を諦めて RESET に切り替わる経路のテスト用)
 */
function createHarness(options: { closeRejects?: boolean } = {}): {
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
        close(): Promise<void> | void {
          record.closeCount += 1;
          if (options.closeRejects === true) {
            // FIN が通らない状況を作る (publishCloseSubgroupStream の RESET 経路)
            return Promise.reject(new Error("close failed"));
          }
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
    publisherPendingCloses: new Map(),
    grease: false,
    sessionState: "connected",
    statsUnidirectionalStreamsOpened: 0,
    closeWithError: () => {},
  } as unknown as SessionInternal;

  const errors: Error[] = [];
  const publisher = new PublisherImpl(
    ["live"],
    "catalog",
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
  return { session, publisher, records, errors };
}

/**
 * sink の終端操作 (close / abort) が期待した状態になるまで待つ
 *
 * WebTransport の `WritableStreamDefaultWriter.close()` の完了は待たない契約
 * (closeSubgroupStreamWithoutWaiting を参照) のため、観測は非同期になる。
 * FIN を諦めて RESET に切り替わる経路では close の後に abort が来るため、
 * 待つ条件を呼び出し側が決められるようにする。
 *
 * @param isTerminated 観測が期待した状態になったかを返す
 */
async function waitForTermination(
  record: StreamRecord,
  isTerminated: (stream: StreamRecord) => boolean = hasTerminated,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (isTerminated(record)) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1);
    });
  }
}

/** close / abort のいずれかが sink に届いたかを返す */
function hasTerminated(record: StreamRecord): boolean {
  return record.closeCount > 0 || record.abortCount > 0;
}

/**
 * endOfSubgroup を付けた Object は、書き込み完了直後に FIN で閉じる
 *
 * catalog と同じ形 (Group 1 つに Object 1 つ、Object ID 0) を送り、次の Group を
 * 送らなくても閉じることを確認する。閉じない場合、購読側は次の送り直し (既定 30 秒後)
 * まで開いた Subgroup で次の Object を待ち、DATA_STREAM_TIMEOUT でセッションを閉じる
 * (draft-ietf-moq-transport-22 §12.2)。
 */
test("publishSendObject: endOfSubgroup の Object は書き込み完了直後に FIN で閉じる", async () => {
  const { session, publisher, records, errors } = createHarness();

  await publisher.sendObject({
    groupId: 0,
    objectId: 0,
    payload: new Uint8Array([1, 2, 3]),
    endOfSubgroup: true,
  });

  // ストリームは Map から外れる (書き込みの await の直後に閉じる)
  assert.isFalse(session.publisherStreams.has(publisher.getTrackAlias()));
  assert.equal(records.length, 1);
  await waitForTermination(records[0]);
  // 省略が無いため FIN (close) で閉じる。RESET (abort) にはならない
  assert.equal(records[0].closeCount, 1);
  assert.equal(records[0].abortCount, 0);
  assert.equal(errors.length, 0);
});

/**
 * endOfSubgroup を付けない場合は従来どおり開いたままにする
 *
 * 映像・音声のトラックは 1 つの Subgroup に複数の Object を載せるため、送信のたびに
 * 閉じてはならない。閉じる契機は呼び出し側の申告に限る。
 */
test("publishSendObject: endOfSubgroup を付けない Object では閉じない", async () => {
  const { session, publisher, records } = createHarness();

  await publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });

  // ストリームは開いたまま残り、次の Group の Object まで閉じない
  assert.isTrue(session.publisherStreams.has(publisher.getTrackAlias()));
  assert.equal(records.length, 1);
  assert.equal(records[0].closeCount, 0);
  assert.equal(records[0].abortCount, 0);

  // 次の Group の Object で前の Subgroup が閉じる (既存の Group 切り替えの経路)
  await publisher.sendObject({ groupId: 1, objectId: 0, payload: new Uint8Array([2]) });
  await waitForTermination(records[0]);
  assert.equal(records[0].closeCount, 1);
});

/**
 * 省略がある Subgroup を endOfSubgroup で閉じる場合は RESET になる
 *
 * draft-ietf-moq-transport-22 §11.3.2: "If a sender closes the stream before
 * delivering all such objects to the QUIC stream, it MUST reset the stream."
 * forwardState が 0 で見送った Object がある Subgroup は、Object を書き終えていても
 * FIN ではなく RESET で閉じる。
 */
test("publishSendObject: 見送った Object がある Subgroup を endOfSubgroup で閉じると RESET になる", async () => {
  const { publisher, records, errors } = createHarness();

  await publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1, 2, 3]) });
  // forwardState 0 の Object は送信されず、省略として記録される
  publisher.setForwardState(false);
  await publisher.sendObject({ groupId: 0, objectId: 1, payload: new Uint8Array([4]) });
  // 全 Object を渡し切っていないため、endOfSubgroup で閉じても FIN ではなく RESET
  publisher.setForwardState(true);
  await publisher.sendObject({
    groupId: 0,
    objectId: 2,
    payload: new Uint8Array([5]),
    endOfSubgroup: true,
  });

  await waitForTermination(records[0]);
  assert.equal(records[0].abortCount, 1);
  assert.equal(records[0].closeCount, 0);
  assert.equal(records[0].abortReasons[0], "subgroup omitted objects");
  assert.equal(errors.length, 0);
});

/**
 * endOfSubgroup で閉じた Group への後続送信は error 通知として拒否される
 *
 * ClosedSubgroupError は publishSendObject の catch が publisher.handleError に渡すため、
 * 返値の Promise は reject しない (status: END_OF_GROUP 済み Group への送信が
 * fail-fast の reject になるのとは扱いが異なる)。
 */
test("publishSendObject: endOfSubgroup で閉じた Group への後続送信は error 通知になる", async () => {
  const { publisher, records, errors } = createHarness();

  await publisher.sendObject({
    groupId: 0,
    objectId: 0,
    payload: new Uint8Array([1]),
    endOfSubgroup: true,
  });
  // 閉じた Group への送信は error 通知だけが届き、返値は解決する
  await publisher.sendObject({ groupId: 0, objectId: 1, payload: new Uint8Array([2]) });

  assert.equal(errors.length, 1);
  assert.isTrue(errors[0]?.message.includes("subgroup is closed"));
  // 新しいストリームは開かない
  assert.equal(records.length, 1);
});

/**
 * 見送られた Object に endOfSubgroup を付けても閉じない
 *
 * draft-ietf-moq-transport-22 §11.3.2: FIN で閉じてよいのは「Subgroup の全 Object を
 * QUIC stream へ渡し切った」場合に限る。見送られた Object は書き込み自体が行われないため、
 * 閉じる契機は Group の切り替えか done() になる。
 * catalog の初期送信が forwardState 0 で見送られた場合、この経路に入る。
 */
test("publishSendObject: 見送られた endOfSubgroup の Object では閉じない", async () => {
  const { session, publisher, records, errors } = createHarness();

  publisher.setForwardState(false);
  await publisher.sendObject({
    groupId: 0,
    objectId: 0,
    payload: new Uint8Array([1, 2, 3]),
    endOfSubgroup: true,
  });

  // ストリームを開かない (閉じる対象が無い)
  assert.isFalse(session.publisherStreams.has(publisher.getTrackAlias()));
  assert.equal(records.length, 0);
  assert.equal(errors.length, 0);
});

/**
 * Location Filter の範囲外へ endOfSubgroup を付けても閉じない
 *
 * §3.3.1: 購読の Location Filter の範囲外 Object は送信しない。見送った Subgroup を
 * FIN で閉じることはできない (§11.3.2。渡し切っていないため)。
 */
test("publishSendObject: Location Filter の範囲外の endOfSubgroup では閉じない", async () => {
  const { session, publisher, records, errors } = createHarness();

  // Group 0 の Object 0 までに狭める (Object 1 以降は範囲外)
  publisher.setLocationFilter({
    startGroup: 0n,
    startObject: 0n,
    endGroupDelta: 0n,
    endObject: 0n,
  });
  await publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array([1]) });
  await publisher.sendObject({
    groupId: 0,
    objectId: 1,
    payload: new Uint8Array([2]),
    endOfSubgroup: true,
  });

  // 範囲外の送信では閉じず、ストリームは開いたまま残る (省略として記録されている)
  assert.isTrue(session.publisherStreams.has(publisher.getTrackAlias()));
  assert.equal(records.length, 1);
  assert.equal(records[0].closeCount, 0);
  assert.equal(records[0].abortCount, 0);
  assert.equal(errors.length, 0);
});

/**
 * FIN の完了が失敗して RESET に切り替わると、同じ Group へ再び送信できる
 *
 * draft-ietf-moq-transport-22 §11.3.2: 渡し切っていない Subgroup は reset であり、
 * 購読者からの再送を FIN 済みとして拒否してはならない。FIN を諦めて RESET に切り替わった
 * 場合は closedSubgroups の登録を取り消す (省略がある場合と同じ扱い)。
 * close の失敗は sink の close を reject させて作る (実時間を待たない)。
 * close が失敗した stream は既に errored であり sink の abort は呼ばれないため、
 * ここでは「登録が取り消され、同じ Group へ再送できる」事実を固定する。
 */
test("publishSendObject: FIN が失敗して RESET になると同じ Group へ再び送信できる", async () => {
  const { session, publisher, records, errors } = createHarness({ closeRejects: true });

  await publisher.sendObject({
    groupId: 0,
    objectId: 0,
    payload: new Uint8Array([1]),
    endOfSubgroup: true,
  });
  assert.isTrue(session.closedSubgroups.has(`${publisher.getTrackAlias()}:0`));

  // close の失敗後、closedSubgroups の登録が取り消される
  await waitForTermination(records[0], () => {
    return !session.closedSubgroups.has(`${publisher.getTrackAlias()}:0`);
  });
  assert.equal(records[0].closeCount, 1);
  assert.isFalse(session.closedSubgroups.has(`${publisher.getTrackAlias()}:0`));

  // 渡し切っていないため、同じ Group へ再び送信できる
  await publisher.sendObject({ groupId: 0, objectId: 1, payload: new Uint8Array([2]) });
  assert.equal(errors.length, 0);
});
