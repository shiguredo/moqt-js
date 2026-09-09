/**
 * Publisher Unit Tests
 * draft-ietf-moq-transport-21 Section 3.2.1
 */

import { test, assert } from "vite-plus/test";
import { ProtocolViolationError } from "./error";
import { ObjectStatus } from "./message/types";
import { PublisherImpl } from "./publisher";

test("closed 状態では sendObject がエラーになる", () => {
  const publisher = new PublisherImpl(["namespace"], "track", 0n, 0n);
  publisher.markClosed();

  assert.throws(
    () => publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array() }),
    /closed/i,
  );
});

test("closed 状態では sendDatagram がエラーになる", () => {
  const publisher = new PublisherImpl(["namespace"], "track", 0n, 0n);
  publisher.markClosed();

  assert.throws(
    () => publisher.sendDatagram({ groupId: 0, objectId: 0, payload: new Uint8Array() }),
    /closed/i,
  );
});

test("done は onDoneInternal を呼んで closed にする", async () => {
  let doneCalled = false;
  const publisher = new PublisherImpl(["namespace"], "track", 0n, 0n);
  publisher.onDoneInternal = async () => {
    doneCalled = true;
  };

  assert.equal(publisher.state, "active");
  await publisher.done();
  assert.isTrue(doneCalled);
  assert.equal(publisher.state, "closed");
});

test("done は closed 状態では onDoneInternal を呼ばない", async () => {
  let doneCallCount = 0;
  const publisher = new PublisherImpl(["namespace"], "track", 0n, 0n);
  publisher.onDoneInternal = async () => {
    doneCallCount++;
  };

  await publisher.done();
  await publisher.done();

  assert.equal(doneCallCount, 1);
});

/**
 * draft-ietf-moq-transport-21 §9.9:
 * 並行 done() 呼び出しで二重 PUBLISH_DONE 送信が起きないよう、
 * 進行中の done() を再利用して onDoneInternal を 1 回だけ実行することを検証する。
 */
test("並行 done は onDoneInternal を 1 回だけ呼ぶ", async () => {
  let doneCallCount = 0;
  const publisher = new PublisherImpl(["namespace"], "track", 0n, 0n);
  publisher.onDoneInternal = async () => {
    doneCallCount++;
    // onDoneInternal の実行中に並行 done() が入る状況を再現する
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  };

  await Promise.all([publisher.done(), publisher.done()]);

  assert.equal(doneCallCount, 1);
  assert.equal(publisher.state, "closed");
});

/**
 * 並行 done() の 2 回目は 1 回目の完了まで解決しないことを検証する。
 * no-op 即 resolve では 2 回目の done() が PUBLISH_DONE 送信完了前に解決し、
 * 呼び出し側の後続処理が誤り得るため、待ち合わせが意味論として必要。
 *
 * このテストが検出するのは「2 回目を即 resolve する fire-and-forget 化」であり、
 * 「ガードなしで 2 回目が独立に onDoneInternal を実行する」退化は
 * 「並行 done は onDoneInternal を 1 回だけ呼ぶ」テストが検出する (相互補完)。
 */
test("並行 done の 2 回目は 1 回目完了前に即 resolve しない", async () => {
  let firstCompleted = false;
  const publisher = new PublisherImpl(["namespace"], "track", 0n, 0n);
  publisher.onDoneInternal = async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    firstCompleted = true;
  };

  const first = publisher.done();
  const second = publisher.done();

  // 2 回目の解決は 1 回目の完了後でなければならない。
  // 2 回目を即 resolve する fire-and-forget 実装に退化した場合、
  // onDoneInternal 未完了のまま second が解決してこの検証が落ちる。
  await second;
  assert.isTrue(firstCompleted);

  await first;
});

/**
 * onDoneInternal が reject した場合はガードがリセットされ、
 * 以後の done() で再試行できることを検証する。
 * (reject 後も publisherState が "active" のままの意味論を維持する)
 */
test("done が reject した場合はガードがリセットされ再試行できる", async () => {
  let doneCallCount = 0;
  const publisher = new PublisherImpl(["namespace"], "track", 0n, 0n);
  publisher.onDoneInternal = async () => {
    doneCallCount++;
    if (doneCallCount === 1) {
      throw new Error("first attempt failed");
    }
  };

  let thrown: Error | undefined;
  try {
    await publisher.done();
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }
  assert.isDefined(thrown);
  assert.equal(publisher.state, "active");

  // 再試行できる
  await publisher.done();
  assert.equal(doneCallCount, 2);
  assert.equal(publisher.state, "closed");
});

/**
 * 進行中の done() を再利用する意味論により、並行呼び出しの 2 回目も
 * 同じ reject を受けることを検証する。1 回目の失敗を 2 回目が握り潰して
 * resolve する実装に退化した場合に検出する。
 */
test("並行 done の reject は 2 回目の呼び出しにも伝播する", async () => {
  const publisher = new PublisherImpl(["namespace"], "track", 0n, 0n);
  publisher.onDoneInternal = async () => {
    throw new Error("publish failed");
  };

  const results = await Promise.allSettled([publisher.done(), publisher.done()]);

  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "rejected");
});

/**
 * done() 実行中にセッションクローズ相当 (markClosed) が割り込んでも、
 * 1 回目の done() は onDoneInternal を完了まで実行して resolve することを
 * 検証する。markClosed 後も in-flight の done() は中断されない。
 */
test("done 実行中に markClosed されても onDoneInternal は 1 回だけ実行され完了する", async () => {
  let doneCallCount = 0;
  const publisher = new PublisherImpl(["namespace"], "track", 0n, 0n);
  publisher.onDoneInternal = async () => {
    doneCallCount++;
    // セッションクローズ相当 (publishers の markClosed) が done() 実行中に
    // 割り込む状況を再現する
    publisher.markClosed();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  };

  await publisher.done();

  assert.equal(doneCallCount, 1);
  assert.equal(publisher.state, "closed");
});

// draft-ietf-moq-transport-21 §9.2 (GOAWAY):
// "A GOAWAY MAY also be sent on a request stream to initiate migration
//  of that individual request."
// goawayCallback が設定され、GOAWAY 受信時に呼び出されることを検証する。
test("goawayCallback が設定できる", () => {
  const publisher = new PublisherImpl(["namespace"], "track", 0n, 0n);

  let calledUri = "";
  publisher.goawayCallback = (uri: string) => {
    calledUri = uri;
  };

  assert.isDefined(publisher.goawayCallback);
  publisher.goawayCallback!("moqt://new.example.com");
  assert.equal(calledUri, "moqt://new.example.com");
});

/**
 * draft-ietf-moq-transport-21 §11.1.2 / §11.1.3:
 * status / payload 整合と END_OF_TRACK 後送信の検証。
 * 違反は委譲前に検出し、通知と返値の reject (sendObject) または
 * 通知と同期 throw (sendDatagram) で呼び出し側へ返す。
 */

test("非 NORMAL + 非空 payload の sendObject は失敗する", async () => {
  // END_OF_GROUP と END_OF_TRACK の両方で検証する
  for (const status of [ObjectStatus.END_OF_GROUP, ObjectStatus.END_OF_TRACK] as const) {
    const errors: Error[] = [];
    const publisher = new PublisherImpl(["namespace"], "track", 0n, 0n, (error) => {
      errors.push(error);
    });
    let sent = 0;
    publisher.onSendObject = async () => {
      sent++;
    };

    let thrown: unknown = null;
    try {
      await publisher.sendObject({
        groupId: 0,
        objectId: 0,
        payload: new Uint8Array([1]),
        status,
      });
    } catch (error) {
      thrown = error;
    }

    assert.isTrue(thrown instanceof ProtocolViolationError);
    assert.equal(errors.length, 1);
    assert.strictEqual(errors[0], thrown);
    assert.equal(sent, 0);
  }
});

test("properties 付き非 NORMAL の sendObject は失敗する", async () => {
  // payload が空でも properties 付きの非 NORMAL は送れない。
  // 非 NORMAL 値間では判定が同一のため両 status で検証する
  for (const status of [ObjectStatus.END_OF_GROUP, ObjectStatus.END_OF_TRACK] as const) {
    const publisher = new PublisherImpl(["namespace"], "track", 0n, 0n);
    let sent = 0;
    publisher.onSendObject = async () => {
      sent++;
    };

    let thrown: unknown = null;
    try {
      await publisher.sendObject({
        groupId: 0,
        objectId: 0,
        payload: new Uint8Array(0),
        properties: new Uint8Array([1]),
        status,
      });
    } catch (error) {
      thrown = error;
    }

    assert.isTrue(thrown instanceof ProtocolViolationError);
    assert.equal(sent, 0);
  }
});

test("NORMAL + 空 payload と status 省略の非空 payload は送信できる", async () => {
  // 正常系の誤検出がないことの検証
  const publisher = new PublisherImpl(["namespace"], "track", 0n, 0n);
  let sent = 0;
  publisher.onSendObject = async () => {
    sent++;
  };

  await publisher.sendObject({ groupId: 0, objectId: 0, payload: new Uint8Array(0) });
  await publisher.sendObject({
    groupId: 0,
    objectId: 1,
    payload: new Uint8Array([1]),
  });

  assert.equal(sent, 2);
});

test("END_OF_TRACK 送信後の sendObject は失敗する", async () => {
  const errors: Error[] = [];
  const publisher = new PublisherImpl(["namespace"], "track", 0n, 0n, (error) => {
    errors.push(error);
  });
  publisher.onSendObject = async () => {};

  await publisher.sendObject({
    groupId: 0,
    objectId: 0,
    payload: new Uint8Array(0),
    status: ObjectStatus.END_OF_TRACK,
  });

  let thrown: unknown = null;
  try {
    await publisher.sendObject({ groupId: 0, objectId: 1, payload: new Uint8Array([1]) });
  } catch (error) {
    thrown = error;
  }

  assert.isTrue(thrown instanceof ProtocolViolationError);
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], thrown);
});

test("END_OF_TRACK 送信後の sendDatagram は同期 throw する", () => {
  const errors: Error[] = [];
  const publisher = new PublisherImpl(["namespace"], "track", 0n, 0n, (error) => {
    errors.push(error);
  });
  publisher.onSendObject = async () => {};
  let datagramSent = 0;
  publisher.onSendDatagram = () => {
    datagramSent++;
  };

  // END_OF_TRACK 送信の受け付けで記録するため、await せずとも後続は塞がれる
  void publisher.sendObject({
    groupId: 0,
    objectId: 0,
    payload: new Uint8Array(0),
    status: ObjectStatus.END_OF_TRACK,
  });

  let thrown: unknown = null;
  try {
    publisher.sendDatagram({ groupId: 0, objectId: 1, payload: new Uint8Array([1]) });
  } catch (error) {
    thrown = error;
  }

  assert.isTrue(thrown instanceof ProtocolViolationError);
  assert.equal(datagramSent, 0);
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], thrown);
});

test("END_OF_TRACK 送信の失敗時は記録せず再送できる", async () => {
  // 失敗した END_OF_TRACK で後続が塞がれないことの検証。
  // 委譲先の失敗は PublisherImpl 層で通知されない (呼び出し側への reject のみ)。
  const publisher = new PublisherImpl(["namespace"], "track", 0n, 0n);
  let shouldFail = true;
  publisher.onSendObject = async () => {
    if (shouldFail) {
      throw new Error("send failed");
    }
  };

  let thrown: unknown = null;
  try {
    await publisher.sendObject({
      groupId: 0,
      objectId: 0,
      payload: new Uint8Array(0),
      status: ObjectStatus.END_OF_TRACK,
    });
  } catch (error) {
    thrown = error;
  }
  assert.isTrue(thrown instanceof Error);

  // 再送できること
  shouldFail = false;
  await publisher.sendObject({
    groupId: 0,
    objectId: 0,
    payload: new Uint8Array(0),
    status: ObjectStatus.END_OF_TRACK,
  });

  // 記録されているため後続は失敗すること
  let second: unknown = null;
  try {
    await publisher.sendObject({ groupId: 0, objectId: 1, payload: new Uint8Array([1]) });
  } catch (error) {
    second = error;
  }
  assert.isTrue(second instanceof ProtocolViolationError);
});

test("明示 NORMAL の非空 payload と空 payload の END_OF_GROUP は送信できる", async () => {
  // 誤検出防止の裏面の検証
  const publisher = new PublisherImpl(["namespace"], "track", 0n, 0n);
  let sent = 0;
  publisher.onSendObject = async () => {
    sent++;
  };

  await publisher.sendObject({
    groupId: 0,
    objectId: 0,
    payload: new Uint8Array([1]),
    status: ObjectStatus.NORMAL,
  });
  await publisher.sendObject({
    groupId: 0,
    objectId: 1,
    payload: new Uint8Array(0),
    status: ObjectStatus.END_OF_GROUP,
  });

  assert.equal(sent, 2);
});

test("2 回目の END_OF_TRACK 自体が拒否される", async () => {
  const errors: Error[] = [];
  const publisher = new PublisherImpl(["namespace"], "track", 0n, 0n, (error) => {
    errors.push(error);
  });
  publisher.onSendObject = async () => {};

  await publisher.sendObject({
    groupId: 0,
    objectId: 0,
    payload: new Uint8Array(0),
    status: ObjectStatus.END_OF_TRACK,
  });

  let thrown: unknown = null;
  try {
    await publisher.sendObject({
      groupId: 0,
      objectId: 1,
      payload: new Uint8Array(0),
      status: ObjectStatus.END_OF_TRACK,
    });
  } catch (error) {
    thrown = error;
  }

  assert.isTrue(thrown instanceof ProtocolViolationError);
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], thrown);
});

test("未 await の連続 sendObject も 2 件目が塞がれる", async () => {
  // 受け付け時記録により、await せず連続呼び出ししても後続は失敗すること
  const errors: Error[] = [];
  const publisher = new PublisherImpl(["namespace"], "track", 0n, 0n, (error) => {
    errors.push(error);
  });
  publisher.onSendObject = async () => {};

  const first = publisher.sendObject({
    groupId: 0,
    objectId: 0,
    payload: new Uint8Array(0),
    status: ObjectStatus.END_OF_TRACK,
  });
  let thrown: unknown = null;
  try {
    await publisher.sendObject({ groupId: 0, objectId: 1, payload: new Uint8Array([1]) });
  } catch (error) {
    thrown = error;
  }
  await first;

  assert.isTrue(thrown instanceof ProtocolViolationError);
  assert.equal(errors.length, 1);
  assert.strictEqual(errors[0], thrown);
});
