/**
 * Fetcher Unit Tests
 * draft-ietf-moq-transport-18 Section 5.2
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

// draft-ietf-moq-transport-18 Section 5.2:
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

// draft-ietf-moq-transport-18 Section 10.13:
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
