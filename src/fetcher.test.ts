/**
 * Fetcher Unit Tests
 * draft-ietf-moq-transport-21 Section 3.2.1
 */

import { test, assert } from "vite-plus/test";
import { FetcherImpl } from "./fetcher";
import type { MoqtObject } from "./dataStream";
import { ObjectStatus } from "./message/types";
import type { Property } from "./properties";

function createObject(groupId: bigint, objectId: bigint): MoqtObject {
  return {
    groupId,
    objectId,
    status: ObjectStatus.NORMAL,
    payload: new Uint8Array([1, 2, 3]),
  };
}

test("closed 状態では handleObject は配信しない", () => {
  const delivered: MoqtObject[] = [];
  const fetcher = new FetcherImpl(["namespace"], "track", 0n, (obj) => delivered.push(obj));

  fetcher.markClosed();
  fetcher.handleObject(createObject(0n, 0n));

  assert.equal(delivered.length, 0);
});

test("handleEnd は endCallback を呼んで closed にする", () => {
  let endCalled = false;
  const fetcher = new FetcherImpl(
    ["namespace"],
    "track",
    0n,
    () => {},
    () => {
      endCalled = true;
    },
  );

  assert.equal(fetcher.state, "active");
  fetcher.handleEnd();
  assert.isTrue(endCalled);
  assert.equal(fetcher.state, "closed");
});

// draft-ietf-moq-transport-21 Section 3.2.1:
// cancel() は onCancel コールバックを呼ぶ
test("cancel は onCancel コールバックを呼んで closed にする", async () => {
  let cancelCalled = false;
  const fetcher = new FetcherImpl(["namespace"], "track", 0n, () => {});
  fetcher.onCancel = async () => {
    cancelCalled = true;
  };

  await fetcher.cancel();
  assert.isTrue(cancelCalled);
  assert.equal(fetcher.state, "closed");
});

test("cancel は closed 状態では onCancel を呼ばない", async () => {
  let cancelCallCount = 0;
  const fetcher = new FetcherImpl(["namespace"], "track", 0n, () => {});
  fetcher.onCancel = async () => {
    cancelCallCount++;
  };

  await fetcher.cancel();
  await fetcher.cancel();

  assert.equal(cancelCallCount, 1);
});

// draft-ietf-moq-transport-21 Section 9.12:
// setFetchOkInfo で Track Properties が設定される
test("setFetchOkInfo で Track Properties が設定される", () => {
  const fetcher = new FetcherImpl(["namespace"], "track", 0n, () => {});

  assert.equal(fetcher.trackProperties.length, 0);

  const properties: Property[] = [
    { id: 0x02n, value: 5000n },
    { id: 0x04n, value: 10000n },
  ];
  fetcher.setFetchOkInfo(false, { group: 5n, object: 3n }, properties);

  assert.equal(fetcher.endOfTrack, false);
  assert.deepEqual(fetcher.endLocation, { group: 5n, object: 3n });
  assert.equal(fetcher.trackProperties.length, 2);
  assert.equal(fetcher.trackProperties[0].id, 0x02n);
});

test("setFetchOkInfo で endOfTrack が設定される", () => {
  const fetcher = new FetcherImpl(["namespace"], "track", 0n, () => {});

  fetcher.setFetchOkInfo(true, { group: 10n, object: 0n }, []);

  assert.isTrue(fetcher.endOfTrack);
  assert.deepEqual(fetcher.endLocation, { group: 10n, object: 0n });
});

// draft-ietf-moq-transport-21 Section 3.2.1 / Section 12.1:
// cancel() は onCancel の完了を待たずに state を closed にし、Object の配信と
// end / error の通知を止める。キャンセル中の重複した malformed 検出で error
// コールバックが二重に呼ばれないための前提である。
test("cancel 開始後は onCancel の完了を待たずに closed になり通知と配信を止める", async () => {
  const delivered: MoqtObject[] = [];
  let endCalled = false;
  const errors: Error[] = [];
  const fetcher = new FetcherImpl(
    ["namespace"],
    "track",
    0n,
    (obj) => delivered.push(obj),
    () => {
      endCalled = true;
    },
    (error) => {
      errors.push(error);
    },
  );
  // 完了しない onCancel でキャンセル中の状態を作る
  fetcher.onCancel = () => new Promise<void>(() => {});
  const cancelPromise = fetcher.cancel();

  assert.equal(fetcher.state, "closed");
  fetcher.handleObject(createObject(0n, 0n));
  fetcher.handleEnd();
  fetcher.handleError(new Error("malformed track"));

  assert.equal(delivered.length, 0);
  assert.isFalse(endCalled);
  assert.equal(errors.length, 0);
  // onCancel は完了しないため cancel() の Promise は未解決のまま破棄される
  void cancelPromise;
});

// draft-ietf-moq-transport-21 Section 3.2.1:
// onCancel (実運用は bidiCancelFetch) の後始末が失敗しても state は closed のまま
// とし、失敗は呼び出し元へ伝播させる。cancelMalformedTrackPeers は .catch で
// 握り潰し、キャンセルを再試行しない (bidiCancelFetch は内部でストリームの
// エラーを握り潰し、Map の削除まで完了する)。
test("onCancel が reject しても state は closed で reject が伝播する", async () => {
  const fetcher = new FetcherImpl(["namespace"], "track", 0n, () => {});
  const failure = new Error("cancel failed");
  fetcher.onCancel = async () => {
    throw failure;
  };

  let rejected: unknown;
  try {
    await fetcher.cancel();
  } catch (error) {
    rejected = error;
  }

  assert.strictEqual(rejected, failure);
  assert.equal(fetcher.state, "closed");
});
