/**
 * Subscriber Unit Tests
 * draft-ietf-moq-transport-19 Section 5.1 (Subscriptions)
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "./subscriber";
import type { MoqtObject } from "./dataStream";
import { ObjectStatus } from "./message/types";
import type { Property } from "./properties";
import { encodeProperties } from "./properties";

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
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, (obj) =>
    delivered.push(obj),
  );

  subscriber.markClosed();
  subscriber.handleObject(createObject(0n, 0n));
  subscriber.handleObject(createObject(0n, 1n));

  assert.equal(delivered.length, 0);
});

test("closed 状態では handleDatagram は配信しない", () => {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(
    ["namespace"],
    "track",
    0n,
    0n,
    () => {},
    (obj) => delivered.push(obj),
  );

  subscriber.markClosed();
  subscriber.handleDatagram(createObject(0n, 0n));

  assert.equal(delivered.length, 0);
});

test("handleEnd は endCallback を呼んで closed にする", () => {
  let endCalled = false;
  const subscriber = new SubscriberImpl(
    ["namespace"],
    "track",
    0n,
    0n,
    () => {},
    undefined,
    () => {
      endCalled = true;
    },
  );

  assert.equal(subscriber.state, "active");
  subscriber.handleEnd();
  assert.isTrue(endCalled);
  assert.equal(subscriber.state, "closed");
});

test("handleEnd は closed 状態では endCallback を呼ばない", () => {
  let endCallCount = 0;
  const subscriber = new SubscriberImpl(
    ["namespace"],
    "track",
    0n,
    0n,
    () => {},
    undefined,
    () => {
      endCallCount++;
    },
  );

  subscriber.handleEnd();
  subscriber.handleEnd();

  assert.equal(endCallCount, 1);
});

test("update は closed 状態ではエラーになる", async () => {
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, () => {});

  subscriber.markClosed();

  try {
    await subscriber.update();
    assert.fail("closed 状態での update はエラーになるべき");
  } catch (e) {
    assert.match((e as Error).message, /closed/i);
  }
});

/**
 * draft-ietf-moq-transport-19 §10.9:
 * 非 async 化に伴い、closed 状態の update() が同期 throw に化けず rejected な
 * Promise を返すことを検証する。fire-and-forget 呼び出しの観測挙動を変えない
 * ための振る舞いであり、await する呼び出しには reject が伝播する。
 */
test("update は closed 状態でも同期 throw せず rejected な Promise を返す", () => {
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, () => {});

  subscriber.markClosed();

  // 同期 throw ではなく Promise が返る
  const promise = subscriber.update();
  assert.instanceOf(promise, Promise);
  return promise.then(
    () => {
      assert.fail("closed 状態での update は reject されるべき");
    },
    (error: unknown) => {
      assert.match((error as Error).message, /closed/i);
    },
  );
});

/**
 * draft-ietf-moq-transport-19 §10.9:
 * closed 状態の update() を fire-and-forget で呼んでも unhandled rejection に
 * ならないことを検証する (同一インスタンスに catch ハンドラを登録するため)。
 */
test("update は closed 状態の fire-and-forget でも unhandled rejection にならない", async () => {
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, () => {});

  subscriber.markClosed();

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    // fire-and-forget: 返り値の Promise を観測しない
    void subscriber.update();
    // unhandledRejection は reject 後のマイクロタスクで発火するため、50ms の
    // 壁時計待ちで確実に検出できる (CI 負荷を考慮した十分な余裕)
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    assert.equal(unhandled.length, 0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

/**
 * draft-ietf-moq-transport-19 §10.9:
 * onUpdate 未設定の update() は解決済み Promise を返すことを検証する
 * (現行の暗黙 resolve 挙動の維持)。
 */
test("update は onUpdate 未設定時は解決済み Promise を返す", async () => {
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, () => {});

  const promise = subscriber.update();
  assert.instanceOf(promise, Promise);
  await promise;
});

/**
 * draft-ietf-moq-transport-19 §10.9:
 * onUpdate が同期 throw しても update() は同期 throw せず rejected な
 * Promise を返すことを検証する (旧 async 実装と等価に吸収する)。
 */
test("update は onUpdate の同期 throw を rejected な Promise に変換する", async () => {
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, () => {});
  subscriber.onUpdate = () => {
    throw new Error("sync failure");
  };

  // 同期 throw ではなく Promise が返る
  const promise = subscriber.update();
  assert.instanceOf(promise, Promise);
  try {
    await promise;
    assert.fail("onUpdate の同期 throw は reject として伝播すべき");
  } catch (error) {
    assert.equal((error as Error).message, "sync failure");
  }
});

/**
 * draft-ietf-moq-transport-19 §10.9:
 * onUpdate の同期 throw を fire-and-forget で呼んでも unhandled rejection に
 * ならないことを検証する。
 */
test("update は onUpdate の同期 throw の fire-and-forget でも unhandled rejection にならない", async () => {
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, () => {});
  subscriber.onUpdate = () => {
    throw new Error("sync failure");
  };

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    // fire-and-forget: 返り値の Promise を観測しない
    void subscriber.update();
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    assert.equal(unhandled.length, 0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

/**
 * draft-ietf-moq-transport-19 §10.9:
 * update() が onUpdate の返り値と同一インスタンスを返すことを検証する。
 * 別インスタンス (catch 派生) を返すと await 側に reject が伝播しなくなるため、
 * 同一性が抑制と伝播の両立の核になる。
 */
test("update は onUpdate の返り値と同一インスタンスを返す", async () => {
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, () => {});
  const inner = Promise.reject(new Error("inner failure"));
  // 生成直後の未処理 reject による誤検出を避けるための事前ハンドラであり、
  // 抑制自体は update() 内の登録と別テストで担保する
  inner.catch(() => {});
  subscriber.onUpdate = () => inner;

  const returned = subscriber.update();
  assert.strictEqual(returned, inner);
  try {
    await returned;
    assert.fail("inner の reject が伝播すべき");
  } catch (error) {
    assert.equal((error as Error).message, "inner failure");
  }
});

// draft-ietf-moq-transport-19 Section 10.11 (PUBLISH_DONE):
// UPDATE_FAILED (0x8) 等のエラー・ステータスでは errorCallback を呼ぶ
test("handleEnd は statusCode がエラーの場合 errorCallback を呼ぶ", () => {
  let endCalled = false;
  let errorMessage = "";
  const subscriber = new SubscriberImpl(
    ["namespace"],
    "track",
    0n,
    0n,
    () => {},
    undefined,
    () => {
      endCalled = true;
    },
    (error: Error) => {
      errorMessage = error.message;
    },
  );

  // UPDATE_FAILED (0x8) でエラー通知
  subscriber.handleEnd(0x8n, "update failed");
  assert.isTrue(endCalled);
  assert.include(errorMessage, "0x8");
  assert.include(errorMessage, "update failed");
  assert.equal(subscriber.state, "closed");
});

// draft-ietf-moq-transport-19 Section 10.11 (PUBLISH_DONE):
// TRACK_ENDED (0x2) は正常終了。errorCallback は呼ばない
test("handleEnd は statusCode が TRACK_ENDED の場合 errorCallback を呼ばない", () => {
  let endCalled = false;
  let errorCalled = false;
  const subscriber = new SubscriberImpl(
    ["namespace"],
    "track",
    0n,
    0n,
    () => {},
    undefined,
    () => {
      endCalled = true;
    },
    () => {
      errorCalled = true;
    },
  );

  subscriber.handleEnd(0x2n, "");
  assert.isTrue(endCalled);
  assert.isFalse(errorCalled);
});

// draft-ietf-moq-transport-19 Section 10.11 (PUBLISH_DONE):
// INTERNAL_ERROR (0x0) はエラー。errorCallback を呼ぶ
test("handleEnd は statusCode が INTERNAL_ERROR の場合 errorCallback を呼ぶ", () => {
  let endCalled = false;
  let errorCalled = false;
  const subscriber = new SubscriberImpl(
    ["namespace"],
    "track",
    0n,
    0n,
    () => {},
    undefined,
    () => {
      endCalled = true;
    },
    () => {
      errorCalled = true;
    },
  );

  subscriber.handleEnd(0x0n, "internal");
  assert.isTrue(endCalled);
  assert.isTrue(errorCalled);
  assert.equal(subscriber.state, "closed");
});

// draft-ietf-moq-transport-19 Section 10.8 (SUBSCRIBE_OK):
// SUBSCRIBE_OK の Track Properties が Subscriber に設定される
test("setTrackProperties で Track Properties が設定される", () => {
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, () => {});

  assert.equal(subscriber.trackProperties.length, 0);

  const properties: Property[] = [
    { id: 0x02n, value: 5000n },
    { id: 0x04n, value: 10000n },
  ];
  subscriber.setTrackProperties(properties);

  assert.equal(subscriber.trackProperties.length, 2);
  assert.equal(subscriber.trackProperties[0].id, 0x02n);
  assert.equal(subscriber.trackProperties[1].id, 0x04n);
});

// draft-ietf-moq-transport-19 Section 10.2.16 (LARGEST OBJECT Parameter):
// setLargestLocation で largestLocation が更新される
test("setLargestLocation で largestLocation が更新される", () => {
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, () => {});

  assert.isNull(subscriber.largestLocation);

  subscriber.setLargestLocation({ group: 5n, object: 3n });
  assert.deepEqual(subscriber.largestLocation, { group: 5n, object: 3n });

  // REQUEST_OK からの更新
  subscriber.setLargestLocation({ group: 10n, object: 7n });
  assert.deepEqual(subscriber.largestLocation, { group: 10n, object: 7n });
});

// draft-ietf-moq-transport-19 §10.4 (GOAWAY):
// "A GOAWAY MAY also be sent on a request stream to initiate migration
//  of that individual request."
// goawayCallback が設定され、GOAWAY 受信時に呼び出されることを検証する。
test("goawayCallback が設定できる", () => {
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, () => {});

  let calledUri = "";
  subscriber.goawayCallback = (uri: string) => {
    calledUri = uri;
  };

  assert.isDefined(subscriber.goawayCallback);
  subscriber.goawayCallback!("moqt://new.example.com");
  assert.equal(calledUri, "moqt://new.example.com");
});

// draft-ietf-moq-transport-19 §10.2.17 (FORWARD Parameter):
// setForwardState で Forward State が更新され、forwardState で取得できることを検証する。
test("setForwardState で Forward State が更新される", () => {
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, () => {});

  // 初期値はデフォルト 1 (§10.2.17)
  assert.equal(subscriber.forwardState, true);

  subscriber.setForwardState(false);
  assert.equal(subscriber.forwardState, false);

  subscriber.setForwardState(true);
  assert.equal(subscriber.forwardState, true);
});

// ============================================================================
// Range Filters の再適用テスト
// draft-ietf-moq-transport-19 Section 5.1.3 (Range Filters)
// ============================================================================

/**
 * OBJECTID_FILTER で不通過のオブジェクトは handleObject で破棄される。
 */
test("handleObject: OBJECTID_FILTER 不通過のオブジェクトは配信しない", () => {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, (obj) =>
    delivered.push(obj),
  );
  subscriber.setRangeFilters([{ type: "objectId", setId: 0, ranges: [{ start: 5n, end: 7n }] }]);

  subscriber.handleObject(createObject(0n, 6n));
  subscriber.handleObject(createObject(0n, 10n));

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].objectId, 6n);
});

/**
 * SUBGROUP_FILTER で subgroupId 未指定 (datagram 経路等) のオブジェクトは
 * handleObject で不通過になる。
 */
test("handleObject: SUBGROUP_FILTER で subgroupId 未指定は配信しない", () => {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, (obj) =>
    delivered.push(obj),
  );
  subscriber.setRangeFilters([{ type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 10n }] }]);

  // subgroupId 未指定 (undefined)
  subscriber.handleObject(createObject(0n, 0n));
  assert.equal(delivered.length, 0);

  // subgroupId 指定
  subscriber.handleObject({ ...createObject(0n, 0n), subgroupId: 5n });
  assert.equal(delivered.length, 1);
});

/**
 * PRIORITY_FILTER で publisherPriority 未指定のオブジェクトは handleDatagram で
 * 不通過になる (0 のダミー値は評価値として使わない)。
 */
test("handleDatagram: PRIORITY_FILTER で publisherPriority 未指定は配信しない", () => {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(
    ["namespace"],
    "track",
    0n,
    0n,
    () => {},
    (obj) => delivered.push(obj),
  );
  subscriber.setRangeFilters([{ type: "priority", setId: 0, ranges: [{ start: 0n, end: 255n }] }]);

  // publisherPriority 未指定 (undefined) は不通過
  subscriber.handleDatagram(createObject(0n, 0n));
  assert.equal(delivered.length, 0);

  // publisherPriority 明示 (0) は通過 (明示された 0 は評価値として有効)
  subscriber.handleDatagram({ ...createObject(0n, 0n), publisherPriority: 0 });
  assert.equal(delivered.length, 1);
});

/**
 * setRangeFilters の削除 (Length=0) は当該パラメータ型全体を削除する。
 */
test("setRangeFilters: 削除エントリは当該型全体を削除する", () => {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, (obj) =>
    delivered.push(obj),
  );
  subscriber.setRangeFilters([
    { type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 2n }] },
    { type: "objectId", setId: 0, ranges: [{ start: 5n, end: 7n }] },
  ]);
  // objectId の削除エントリ (SetID なし) で objectId 型全体を削除する
  subscriber.setRangeFilters([{ type: "objectId", remove: true }]);

  // objectId フィルタが消えているため、objectId はどの値でも通過する。
  // subgroup フィルタは不変のため、subgroupId は評価される。
  subscriber.handleObject({ ...createObject(0n, 150n), subgroupId: 1n });
  subscriber.handleObject({ ...createObject(0n, 150n), subgroupId: 3n });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].objectId, 150n);
});

/**
 * setRangeFilters: 同型の異なる SetID が共存することを検証する。
 * (§5.1.3「The final result is SetID=0 OR SetID=1 OR ... SetID=255」)
 */
test("setRangeFilters: 同型の異なる SetID は共存する", () => {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, (obj) =>
    delivered.push(obj),
  );
  subscriber.setRangeFilters([
    { type: "objectId", setId: 0, ranges: [{ start: 1n, end: 2n }] },
    { type: "objectId", setId: 1, ranges: [{ start: 10n, end: 11n }] },
  ]);

  // SetID 0 (objectId 1-2) と SetID 1 (objectId 10-11) が OR で共存する
  subscriber.handleObject(createObject(0n, 1n));
  subscriber.handleObject(createObject(0n, 10n));
  subscriber.handleObject(createObject(0n, 5n));
  assert.equal(delivered.length, 2);
});

/**
 * setRangeFilters: REQUEST_UPDATE で他種のフィルタが不変であることを検証する。
 * (「If a filter parameter is omitted from REQUEST_UPDATE, the value is
 *  unchanged」§5.1.3)
 */
test("setRangeFilters: REQUEST_UPDATE で省略された型は不変", () => {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, (obj) =>
    delivered.push(obj),
  );
  // SUBSCRIBE 時に subgroup + objectId を設定
  subscriber.setRangeFilters([
    { type: "subgroup", setId: 0, ranges: [{ start: 0n, end: 2n }] },
    { type: "objectId", setId: 0, ranges: [{ start: 5n, end: 7n }] },
  ]);
  // REQUEST_UPDATE で objectId のみ置換 (subgroup は省略 = 不変)
  subscriber.setRangeFilters([{ type: "objectId", setId: 0, ranges: [{ start: 8n, end: 9n }] }]);

  // subgroup フィルタは維持されている (subgroupId 1 は通過、3 は不通過)。
  // objectId は新フィルタ [8-9] で評価されるため 6n は不通過
  subscriber.handleObject({ ...createObject(0n, 8n), subgroupId: 1n });
  subscriber.handleObject({ ...createObject(0n, 8n), subgroupId: 3n });
  assert.equal(delivered.length, 1);
});

/**
 * setRangeFilters: 同一 SetID・異なる Property Type の共存を検証する。
 */
test("setRangeFilters: 異なる Property Type は共存する", () => {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, (obj) =>
    delivered.push(obj),
  );
  // 異なる SetID に分けて OR 結合で検証する (同一 SetID では AND 結合のため
  // 片方の Property のみ持つオブジェクトは通過しない)
  subscriber.setRangeFilters([
    { type: "objectProperty", setId: 0, propertyType: 0x02n, ranges: [{ start: 1n, end: 100n }] },
    { type: "objectProperty", setId: 1, propertyType: 0x04n, ranges: [{ start: 1n, end: 100n }] },
  ]);

  // 0x02 のみ持つオブジェクトは SetID 0 で通過する (0x02 フィルタが保持されている)
  const objectWith02 = { ...createObject(0n, 0n) };
  objectWith02.properties = encodeProperties([{ id: 0x02n, value: 50n }]);
  subscriber.handleObject(objectWith02);
  assert.equal(delivered.length, 1);

  // 0x04 のみ持つオブジェクトは SetID 1 で通過する (0x04 フィルタが保持されている)
  const objectWith04 = { ...createObject(0n, 0n) };
  objectWith04.properties = encodeProperties([{ id: 0x04n, value: 50n }]);
  subscriber.handleObject(objectWith04);
  assert.equal(delivered.length, 2);
});

// ============================================================================
// Location Filter 再適用のテスト
// draft-ietf-moq-transport-20 Section 5.1.2 (Location Filters)
// ============================================================================

/**
 * 実フローと同じ順序 (SUBSCRIBE 送信時の setLocationFilter → SUBSCRIBE_OK 受信時の
 * setLargestLocation) で、Next Object 形式 ({ startGroup: 0n, startObject: 0n })
 * フィルタの Start が {Largest Object.Group, Largest Object.Object + 1} になる
 * ことを検証する。
 * LARGEST_OBJECT と同一 Location のオブジェクトがフィルタを通過して配信される
 * のは誤り (§5.1.2)。
 */
test("Location Filter 再適用: setLargestLocation 後に LARGEST_OBJECT と同一 Location は配信しない", () => {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, (obj) =>
    delivered.push(obj),
  );

  // SUBSCRIBE 送信時に Location Filter を設定
  subscriber.setLocationFilter({ startGroup: 0n, startObject: 0n });
  // SUBSCRIBE_OK 受信時に LARGEST_OBJECT = {7, 2} を設定
  subscriber.setLargestLocation({ group: 7n, object: 2n });

  // LARGEST_OBJECT と同一 Location のオブジェクトはブロックされる
  subscriber.handleObject(createObject(7n, 2n));
  assert.equal(delivered.length, 0);

  // {7, 3} 以降のオブジェクトは配信される
  subscriber.handleObject(createObject(7n, 3n));
  assert.equal(delivered.length, 1);
});

/**
 * setLocationFilter の再適用時に resolvedFilterCache が再計算されることを検証する。
 * 実フロー (SUBSCRIBE 送信時 setLocationFilter → SUBSCRIBE_OK 受信時 setLargestLocation)
 * とは逆順に設定する防御的組合せであり、setLocationFilter が後から来ても
 * LARGEST_OBJECT と同一 Location はブロックされ、{Object + 1} から配信される。
 */
test("Location Filter 再適用: setLocationFilter 再適用後も LARGEST_OBJECT と同一 Location は配信しない", () => {
  const delivered: MoqtObject[] = [];
  const datagrams: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(
    ["namespace"],
    "track",
    0n,
    0n,
    (obj) => delivered.push(obj),
    (obj) => datagrams.push(obj),
  );

  // setLargestLocation を先に設定してから、setLocationFilter を再適用する
  subscriber.setLargestLocation({ group: 7n, object: 2n });
  subscriber.setLocationFilter({ startGroup: 0n, startObject: 0n });

  subscriber.handleObject(createObject(7n, 2n));
  assert.equal(delivered.length, 0);

  subscriber.handleObject(createObject(7n, 3n));
  assert.equal(delivered.length, 1);

  // handleDatagram 経路も同一の resolvedFilterCache を共有するため、
  // 同一 Location はブロックされ、{Object + 1} から配信される
  subscriber.handleDatagram(createObject(7n, 2n));
  assert.equal(datagrams.length, 0);

  subscriber.handleDatagram(createObject(7n, 3n));
  // handleDatagram は objectCallback (delivered) へは渡らないことも同時に確認する
  assert.equal(delivered.length, 1);
  assert.equal(datagrams.length, 1);
});

/**
 * 1 フィールド (startGroup=0 のみ) の相対フィルタの再適用: LARGEST_OBJECT の
 * 次の Group ({Group + 1, 0}) から配信されることを検証する。
 */
test("Location Filter 再適用: startGroup=0 は LARGEST_OBJECT の次のグループから配信する", () => {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, (obj) =>
    delivered.push(obj),
  );

  subscriber.setLocationFilter({ startGroup: 0n });
  subscriber.setLargestLocation({ group: 7n, object: 2n });

  // 同一 Group で LARGEST_OBJECT 以下の Object、および前 Group のオブジェクトはブロックされる
  subscriber.handleObject(createObject(7n, 2n));
  assert.equal(delivered.length, 0);

  // 次の Group ({8, 0}) 以降は配信される
  subscriber.handleObject(createObject(8n, 0n));
  assert.equal(delivered.length, 1);
});

/**
 * draft-ietf-moq-transport-20 §10.2.8:
 * SUBSCRIBE 送信時の Group Order の保持と取得を検証する
 * (fill 要求時の Group Order 解決に使う)。
 */
test("setGroupOrder / getGroupOrder: SUBSCRIBE 送信時の Group Order を保持する", () => {
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, () => {});

  // 初期値は未設定
  assert.isUndefined(subscriber.getGroupOrder());

  subscriber.setGroupOrder("Descending");
  assert.equal(subscriber.getGroupOrder(), "Descending");
});

/**
 * draft-ietf-moq-transport-20 §5.1.2 / §5.1.3:
 * 同一 Location が fill 経由と subscription 経由の両方で届く場合に、
 * アプリが両者を区別して受け取れることを検証する。
 * fill 経由は subscription の Location Filter 再適用を通さないため、
 * subscription では落とされる Location も fill では届く。
 */
test("handleFillObject: 同一 Location の fill 経由と subscription 経由を区別して受け取れる", () => {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, (obj) =>
    delivered.push(obj),
  );

  // subscription を Next Group 以降に絞る
  // (Largest {7, 2} に対して {8, 0} 以降が通過する)
  subscriber.setLocationFilter({ startGroup: 0n });
  subscriber.setLargestLocation({ group: 7n, object: 2n });

  // subscription 経由では Location Filter 再適用で落とされる
  subscriber.handleObject(createObject(7n, 2n));
  assert.equal(delivered.length, 0);

  // fill 経由では再適用を通さず fillDelivered を付けて届く
  subscriber.handleFillObject(createObject(7n, 2n));
  assert.equal(delivered.length, 1);
  assert.isTrue(delivered[0]?.fillDelivered);
  assert.equal(delivered[0]?.groupId, 7n);
  assert.equal(delivered[0]?.objectId, 2n);

  // subscription 経由で届くものには fillDelivered が付かない
  subscriber.handleObject(createObject(8n, 0n));
  assert.equal(delivered.length, 2);
  assert.isUndefined(delivered[1]?.fillDelivered);

  // 同一 Location が両経路で届いても区別できる
  subscriber.handleFillObject(createObject(8n, 0n));
  assert.equal(delivered.length, 3);
  assert.isTrue(delivered[2]?.fillDelivered);
  assert.equal(delivered[1]?.groupId, delivered[2]?.groupId);
  assert.equal(delivered[1]?.objectId, delivered[2]?.objectId);

  // Range Filter を設定しても fill 経由は再適用を通さず届く
  // (OBJECTID_FILTER 5-7: objectId 10 は subscription では不通過)
  subscriber.setRangeFilters([{ type: "objectId", setId: 0, ranges: [{ start: 5n, end: 7n }] }]);
  subscriber.handleObject(createObject(8n, 10n));
  assert.equal(delivered.length, 3);
  subscriber.handleFillObject(createObject(8n, 10n));
  assert.equal(delivered.length, 4);
  assert.isTrue(delivered[3]?.fillDelivered);
  assert.equal(delivered[3]?.objectId, 10n);
});

/**
 * handleObject と同様に、closed 状態の handleFillObject は配信しない。
 */
test("closed 状態では handleFillObject は配信しない", () => {
  const delivered: MoqtObject[] = [];
  const subscriber = new SubscriberImpl(["namespace"], "track", 0n, 0n, (obj) =>
    delivered.push(obj),
  );

  subscriber.markClosed();
  subscriber.handleFillObject(createObject(0n, 0n));

  assert.equal(delivered.length, 0);
});
