/**
 * Fetcher Unit Tests
 * draft-ietf-moq-transport-23 §3.2 (Fetch) / §3.2.4 (Fetch State Management) /
 * §9.3 (REQUEST_OK)
 */

import { test, assert } from "vite-plus/test";
import { FetcherImpl } from "./fetcher";
import type { MoqtObject } from "./dataStream";
import type { Property } from "./properties";
import { createObject } from "./testSupport/helpers";

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

// draft-ietf-moq-transport-22 Section 3.2.4:
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

// draft-ietf-moq-transport-23 §3.2 / §9.3:
// 成功応答 (REQUEST_OK / FETCH_OK) の受理で Track Properties と、要求範囲と
// LARGEST_OBJECT から確定した endLocation が設定される。
test("setFetchOkInfo で Track Properties と endLocation が設定される", () => {
  const fetcher = new FetcherImpl(["namespace"], "track", 0n, () => {});

  assert.equal(fetcher.trackProperties.length, 0);
  // 応答受理前の endLocation は既定値 {0, 0} のまま
  assert.deepEqual(fetcher.endLocation, { group: 0n, object: 0n });

  const properties: Property[] = [
    { id: 0x02n, value: 5000n },
    { id: 0x04n, value: 10000n },
  ];
  fetcher.setFetchOkInfo({ group: 5n, object: 3n }, properties);

  assert.deepEqual(fetcher.endLocation, { group: 5n, object: 3n });
  assert.equal(fetcher.trackProperties.length, 2);
  assert.equal(fetcher.trackProperties[0].id, 0x02n);
});

/**
 * draft-ietf-moq-transport-23 §9.3 / Appendix A.1:
 * 旧 FETCH_OK の End Of Track フィールドは削除された。応答の受理では
 * endOfTrack を変更せず、false のままにする (FETCH データの End of Track
 * indicator を受信したときに true になる)。
 */
test("setFetchOkInfo は endOfTrack を変更しない", () => {
  const fetcher = new FetcherImpl(["namespace"], "track", 0n, () => {});

  assert.isFalse(fetcher.endOfTrack);
  fetcher.setFetchOkInfo({ group: 10n, object: 0n }, []);

  // 応答には終端の情報が無いため、Track 終端を確認済みにはしない
  assert.isFalse(fetcher.endOfTrack);
});

/**
 * draft-ietf-moq-transport-23 §3.2.4 (Fetch State Management) /
 * §11.4.1 (Fetch Header) Table 8:
 * FETCH データストリームの単なる FIN では endOfTrack を変更しない。
 * Track の終端の確認は End of Track indicator (0x81) の受信で行う。
 * FIN はこれまでどおり endCallback を呼ぶ。
 */
test("handleEnd (FETCH FIN) では endOfTrack を変更しない", () => {
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
  fetcher.setFetchOkInfo({ group: 5n, object: 2n }, []);

  fetcher.handleEnd();

  assert.isTrue(endCalled);
  assert.equal(fetcher.state, "closed");
  assert.isFalse(fetcher.endOfTrack);
  assert.deepEqual(fetcher.endLocation, { group: 5n, object: 2n });
});

/**
 * draft-ietf-moq-transport-23 §11.4.1 (Fetch Header) Table 8 / §11.4.2.2:
 * End of Track indicator (0x81) の受理で endOfTrack が true になる。indicator は
 * Object ではないため objectCallback は呼ばれず、endLocation (応答がカバーする範囲の
 * 上限) も書き換えない。その後に FIN で handleEnd が呼ばれても true のままである。
 */
test("handleEndOfTrack は endOfTrack を true にし、その後の FIN でも維持する", () => {
  const delivered: MoqtObject[] = [];
  let endCalled = false;
  const fetcher = new FetcherImpl(
    ["namespace"],
    "track",
    0n,
    (object) => {
      delivered.push(object);
    },
    () => {
      endCalled = true;
    },
  );
  // 応答受理時に確定した範囲上限 (実 Object の終端とは別)
  fetcher.setFetchOkInfo({ group: 5n, object: 9n }, []);

  fetcher.handleEndOfTrack();

  assert.isTrue(fetcher.endOfTrack);
  // indicator は Object ではないため配送されない
  assert.equal(delivered.length, 0);
  // 応答受理時に確定した endLocation は書き換えない
  assert.deepEqual(fetcher.endLocation, { group: 5n, object: 9n });
  // End of Track はデータストリームの終了通知 (endCallback) を呼ばない
  assert.isFalse(endCalled);
  assert.equal(fetcher.state, "active");

  // その後の FIN では endCallback が呼ばれ、endOfTrack は true のまま
  fetcher.handleEnd();
  assert.isTrue(endCalled);
  assert.equal(fetcher.state, "closed");
  assert.isTrue(fetcher.endOfTrack);
});

// draft-ietf-moq-transport-22 Section 3.2.4:
// キャンセル済みの fetcher では End of Track indicator も記録しない
test("handleEndOfTrack は closed 状態では endOfTrack を変更しない", () => {
  const fetcher = new FetcherImpl(["namespace"], "track", 0n, () => {});

  fetcher.markClosed();
  fetcher.handleEndOfTrack();

  assert.isFalse(fetcher.endOfTrack);
});

/**
 * draft-ietf-moq-transport-23 §3.2 (Fetch) / §9.19.9 (Table 6):
 * 応答の終端を確定するための要求範囲を保持する。未設定時はフィルタなしの
 * 要求と同じ {0, 0} から Largest Object までとして扱う。
 */
test("setFetchRequestRange / getFetchRequestRange で要求範囲を保持する", () => {
  const fetcher = new FetcherImpl(["namespace"], "track", 0n, () => {});

  // フィルタなしの要求を表す既定値
  assert.deepEqual(fetcher.getFetchRequestRange(), {
    startLocation: { group: 0n, object: 0n },
    endLocation: undefined,
  });

  fetcher.setFetchRequestRange({
    startLocation: { group: 3n, object: 1n },
    endLocation: { group: 7n, object: 9n },
  });
  assert.deepEqual(fetcher.getFetchRequestRange(), {
    startLocation: { group: 3n, object: 1n },
    endLocation: { group: 7n, object: 9n },
  });

  // 開端の要求へ戻すときは End Location を undefined にする
  fetcher.setFetchRequestRange({
    startLocation: { group: 3n, object: 1n },
    endLocation: undefined,
  });
  assert.isUndefined(fetcher.getFetchRequestRange().endLocation);
});

// draft-ietf-moq-transport-22 Section 3.2.4 / Section 12.1:
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

// draft-ietf-moq-transport-22 Section 3.2.4:
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
