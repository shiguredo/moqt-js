/**
 * session/bidi.ts の単体テスト: bidiSendNamespaceRequestUpdate
 *
 * namespace / tracks 購読の REQUEST_UPDATE 送信と、overlap 制約・
 * 予約 namespace・in-flight 制限の検証を扱う。
 * 実ストリームと実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import { encodeGoawayPayload } from "../message/session";
import { MessageType, MessageParameterType } from "../message/types";
import { trackNamespaceToStrings } from "../message";
import { decodeRequestUpdatePayload } from "../message/subscribe";
import { decodeTrackNamespace } from "../message/parameter";
import { createBidiSession, createPublishReadTestContext } from "../testSupport/bidi";
import { concatUint8Arrays } from "../testSupport/helpers";
import { ControlStreamReader } from "../controlStream";
import {
  bidiReadRequestStreamMessages,
  bidiSendNamespaceRequestUpdate,
  bidiSendRequestUpdate,
  type BidiSessionInternal,
} from "./bidi";

// ============================================================================
// bidiSendNamespaceRequestUpdate のテスト
// draft-ietf-moq-transport-21 §9.5.2 (Updating Namespace Subscriptions)
// ============================================================================

/**
 * namespaceSubscriptions / tracksSubscriptions にエントリを持つ
 * BidiSessionInternal のモックを構築する。
 *
 * @param kind - 登録するサブスクリプションの種別
 * @param namespacePrefix - 既存の Track Namespace Prefix
 */
function createNamespaceUpdateSession(
  kind: "namespace" | "tracks",
  namespacePrefix: string[],
): {
  session: BidiSessionInternal;
  written: Uint8Array[];
  subscription: {
    state: "active" | "closed";
    namespacePrefix: string[];
    pendingPrefix?: string[];
  };
} {
  const { session, written } = createBidiSession();
  const subscription = {
    callbacks: {},
    state: "active" as const,
    namespacePrefix,
  };
  if (kind === "namespace") {
    session.namespaceSubscriptions.set(0n, subscription);
  } else {
    session.tracksSubscriptions.set(0n, subscription);
  }
  return { session, written, subscription };
}

test("bidiSendNamespaceRequestUpdate: TRACK_NAMESPACE_PREFIX が REQUEST_UPDATE にエンコードされる", async () => {
  const { session, written, subscription } = createNamespaceUpdateSession("namespace", ["live"]);

  const writer = {
    write: async (data: Uint8Array): Promise<void> => {
      written.push(data);
    },
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  // bidiSendRequestUpdate と同様に REQUEST_OK 受信まで resolve しない Promise を返すため、
  // 送信完了後に pendingRequestUpdate の Promise を解決してから await する
  const updatePromise = bidiSendNamespaceRequestUpdate(session, 0n, writer, {
    trackNamespacePrefix: ["live", "sports"],
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  // writer.write されたバイト列を ControlStreamReader でフレームに分解する
  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_UPDATE);

  // TRACK_NAMESPACE_PREFIX (0x34) パラメータが新 prefix でエンコードされる
  const decoded = decodeRequestUpdatePayload(messages[0].payload);
  const trackNamespaceParam = decoded.parameters.find(
    (p) => p.type === MessageParameterType.TRACK_NAMESPACE_PREFIX,
  );
  assert.isDefined(trackNamespaceParam);
  const [trackNamespace] = decodeTrackNamespace(trackNamespaceParam!.value, 0);
  assert.deepEqual(trackNamespaceToStrings(trackNamespace), ["live", "sports"]);

  // 送信後、REQUEST_OK 受信待ちの間は pendingPrefix に新 prefix が保持される
  assert.deepEqual(subscription.pendingPrefix, ["live", "sports"]);
  // 既存の namespacePrefix は REQUEST_OK 受信まで更新されない
  assert.deepEqual(subscription.namespacePrefix, ["live"]);
});

/**
 * draft-ietf-moq-transport-21 §9.20.19:
 * SUBSCRIBE_TRACKS の REQUEST_UPDATE で FORWARD=0 / FORWARD=1 の両方が
 * ワイヤに載ることを検証する。将来の購読向けであり既存購読には影響しない。
 */
test("bidiSendNamespaceRequestUpdate: Tracks 更新の FORWARD がワイヤに載る", async () => {
  for (const forward of [false, true]) {
    const { session, written } = createNamespaceUpdateSession("tracks", ["live"]);
    const writer = {
      write: async (data: Uint8Array): Promise<void> => {
        written.push(data);
      },
    } as unknown as WritableStreamDefaultWriter<Uint8Array>;

    const updatePromise = bidiSendNamespaceRequestUpdate(session, 0n, writer, {
      trackNamespacePrefix: ["live", "sports"],
      forward,
    });
    for (const [, pending] of session.pendingRequestUpdate) {
      pending.resolve();
    }
    await updatePromise;

    // FORWARD パラメータが指定値どおりにエンコードされる
    // 直前で isDefined を検証済みのため非 null アサーションで参照する
    const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
    assert.equal(messages.length, 1, `forward=${forward}`);
    const decoded = decodeRequestUpdatePayload(messages[0].payload);
    const forwardParam = decoded.parameters.find((p) => p.type === MessageParameterType.FORWARD);
    assert.isDefined(forwardParam, `forward=${forward}`);
    assert.deepEqual(forwardParam!.value, new Uint8Array([forward ? 1 : 0]), `forward=${forward}`);
    // 同梱の TRACK_NAMESPACE_PREFIX も新 prefix で存在する
    const prefixParam = decoded.parameters.find(
      (p) => p.type === MessageParameterType.TRACK_NAMESPACE_PREFIX,
    );
    assert.isDefined(prefixParam, `forward=${forward}`);
  }
});

/**
 * draft-ietf-moq-transport-21 §9.20.19:
 * FORWARD 省略時は不変のため送らないことを検証する。
 */
test("bidiSendNamespaceRequestUpdate: Tracks 更新の FORWARD 省略時は送らない", async () => {
  const { session, written } = createNamespaceUpdateSession("tracks", ["live"]);
  const writer = {
    write: async (data: Uint8Array): Promise<void> => {
      written.push(data);
    },
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  const updatePromise = bidiSendNamespaceRequestUpdate(session, 0n, writer, {
    trackNamespacePrefix: ["live", "sports"],
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  const decoded = decodeRequestUpdatePayload(messages[0].payload);
  assert.isUndefined(decoded.parameters.find((p) => p.type === MessageParameterType.FORWARD));
});

/**
 * draft-ietf-moq-transport-21 §9.20.19:
 * SUBSCRIBE_NAMESPACE 向け REQUEST_UPDATE では FORWARD が許可されないため、
 * Namespace 更新では実行時に混入しても送らないことを検証する。
 */
test("bidiSendNamespaceRequestUpdate: Namespace 更新では FORWARD を送らない", async () => {
  const { session, written } = createNamespaceUpdateSession("namespace", ["live"]);
  const writer = {
    write: async (data: Uint8Array): Promise<void> => {
      written.push(data);
    },
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  // 型上は露出させないが、実行時に混入しても黙って落とす
  const updatePromise = bidiSendNamespaceRequestUpdate(session, 0n, writer, {
    trackNamespacePrefix: ["live", "sports"],
    forward: true,
  } as unknown as { trackNamespacePrefix: string[] });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  const decoded = decodeRequestUpdatePayload(messages[0].payload);
  assert.isUndefined(decoded.parameters.find((p) => p.type === MessageParameterType.FORWARD));
  // FORWARD のみ落とし、TRACK_NAMESPACE_PREFIX は新 prefix で残る
  const prefixParam = decoded.parameters.find(
    (p) => p.type === MessageParameterType.TRACK_NAMESPACE_PREFIX,
  );
  assert.isDefined(prefixParam);
});

test("bidiSendNamespaceRequestUpdate: MAX_REQUEST_UPDATES を超える更新は throw する", async () => {
  const { session, subscription } = createNamespaceUpdateSession("namespace", ["live"]);
  // ピアの MAX_REQUEST_UPDATES を 1 に設定し、既に 1 件 outstanding の状態を作る。
  // このテストは throw で終わるため、既存 pending の resolve は不要 (無意味な
  // Promise を作らない)。
  (session as unknown as { peerMaxRequestUpdates: number }).peerMaxRequestUpdates = 1;
  session.pendingRequestUpdate.set(90n, {
    resolve: () => {},
    reject: () => {},
    targetRequestId: 0n,
  });

  const writer = {
    write: async () => {},
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  let thrown: Error | undefined;
  try {
    await bidiSendNamespaceRequestUpdate(session, 0n, writer, {
      trackNamespacePrefix: ["live", "sports"],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("exceeds peer MAX_REQUEST_UPDATES 1"));
  assert.isUndefined(subscription.pendingPrefix);
});

test("bidiSendNamespaceRequestUpdate: 同一型のアクティブなサブスクリプションと共通 prefix を持つ更新は throw する", async () => {
  const { session, subscription } = createNamespaceUpdateSession("namespace", ["live", "sports"]);
  // 別のアクティブな SUBSCRIBE_NAMESPACE (prefix ["live"]) が存在する
  session.namespaceSubscriptions.set(2n, {
    callbacks: {},
    state: "active",
    namespacePrefix: ["live"],
  });

  const writer = {
    write: async () => {},
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  let thrown: Error | undefined;
  try {
    await bidiSendNamespaceRequestUpdate(session, 0n, writer, {
      trackNamespacePrefix: ["live", "news"],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("overlaps with active subscription prefix"));
  assert.isUndefined(subscription.pendingPrefix);
});

test("bidiSendNamespaceRequestUpdate: overlap 制約は型ごとに独立して適用される", async () => {
  // SUBSCRIBE_NAMESPACE の更新では SUBSCRIBE_TRACKS の prefix は比較対象にならない
  const { session, subscription } = createNamespaceUpdateSession("namespace", ["live"]);
  session.tracksSubscriptions.set(2n, {
    callbacks: {},
    state: "active",
    namespacePrefix: ["live", "sports"],
  });

  const writer = {
    write: async () => {},
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  let thrown: Error | undefined;
  try {
    const updatePromise = bidiSendNamespaceRequestUpdate(session, 0n, writer, {
      trackNamespacePrefix: ["live", "sports"],
    });
    for (const [, pending] of session.pendingRequestUpdate) {
      pending.resolve();
    }
    await updatePromise;
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isUndefined(thrown);
  assert.deepEqual(subscription.pendingPrefix, ["live", "sports"]);
});

test("bidiSendNamespaceRequestUpdate: 更新対象自身は比較対象から除外される (prefix 拡大更新を許可)", async () => {
  const { session, subscription } = createNamespaceUpdateSession("namespace", ["live"]);

  const writer = {
    write: async () => {},
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  let thrown: Error | undefined;
  try {
    const updatePromise = bidiSendNamespaceRequestUpdate(session, 0n, writer, {
      trackNamespacePrefix: ["live", "sports"],
    });
    for (const [, pending] of session.pendingRequestUpdate) {
      pending.resolve();
    }
    await updatePromise;
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isUndefined(thrown);
  assert.deepEqual(subscription.pendingPrefix, ["live", "sports"]);
});

test("bidiSendNamespaceRequestUpdate: GOAWAY 受信後は throw する", async () => {
  const { session } = createNamespaceUpdateSession("namespace", ["live"]);
  session.goawayReceivedOnRequestStreams.add(0n);

  const writer = {
    write: async () => {},
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  let thrown: Error | undefined;
  try {
    await bidiSendNamespaceRequestUpdate(session, 0n, writer, {
      trackNamespacePrefix: ["live", "sports"],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("request stream is being migrated"));
});

test("bidiSendNamespaceRequestUpdate: closed 状態のサブスクリプションには送信できない", async () => {
  const { session, subscription } = createNamespaceUpdateSession("namespace", ["live"]);
  subscription.state = "closed";

  const writer = {
    write: async () => {},
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  let thrown: Error | undefined;
  try {
    await bidiSendNamespaceRequestUpdate(session, 0n, writer, {
      trackNamespacePrefix: ["live", "sports"],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("subscription is closed"));
});

test("bidiSendNamespaceRequestUpdate: SUBSCRIBE_TRACKS の更新でも TRACK_NAMESPACE_PREFIX がエンコードされる", async () => {
  const { session, written, subscription } = createNamespaceUpdateSession("tracks", ["live"]);

  const writer = {
    write: async (data: Uint8Array): Promise<void> => {
      written.push(data);
    },
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  const updatePromise = bidiSendNamespaceRequestUpdate(session, 0n, writer, {
    trackNamespacePrefix: ["live", "news"],
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  // writer.write されたバイト列を ControlStreamReader でフレームに分解する
  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, MessageType.REQUEST_UPDATE);

  const decoded = decodeRequestUpdatePayload(messages[0].payload);
  const trackNamespaceParam = decoded.parameters.find(
    (p) => p.type === MessageParameterType.TRACK_NAMESPACE_PREFIX,
  );
  assert.isDefined(trackNamespaceParam);
  const [trackNamespace] = decodeTrackNamespace(trackNamespaceParam!.value, 0);
  assert.deepEqual(trackNamespaceToStrings(trackNamespace), ["live", "news"]);
  assert.deepEqual(subscription.pendingPrefix, ["live", "news"]);
});

test("bidiSendNamespaceRequestUpdate: 予約 namespace への更新は throw する", async () => {
  const { session, subscription } = createNamespaceUpdateSession("namespace", ["live"]);
  const writer = {
    write: async () => {},
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  let thrown: Error | undefined;
  try {
    await bidiSendNamespaceRequestUpdate(session, 0n, writer, {
      trackNamespacePrefix: [".session"],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("reserved"));
  assert.isUndefined(subscription.pendingPrefix);
});

test("bidiSendNamespaceRequestUpdate: 更新が in-flight のうちに 2 件目を送ると throw する", async () => {
  const { session, subscription } = createNamespaceUpdateSession("namespace", ["live"]);
  // 1 件目の更新が送信中 (REQUEST_OK 未受信) の状態を作る
  subscription.pendingPrefix = ["live", "sports"];

  const writer = {
    write: async () => {},
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  let thrown: Error | undefined;
  try {
    await bidiSendNamespaceRequestUpdate(session, 0n, writer, {
      trackNamespacePrefix: ["live", "news"],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("another update is already in flight"));
  // 1 件目の in-flight 状態は維持される
  assert.deepEqual(subscription.pendingPrefix, ["live", "sports"]);
});

test("bidiSendNamespaceRequestUpdate: 送信失敗時は pending と pendingPrefix が掃除される", async () => {
  const { session, subscription } = createNamespaceUpdateSession("namespace", ["live"]);

  // write が失敗する writer を注入する (ピアがストリームを閉じた等を再現)
  const writer = {
    write: async (): Promise<void> => {
      throw new Error("stream closed by peer");
    },
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  let thrown: Error | undefined;
  try {
    await bidiSendNamespaceRequestUpdate(session, 0n, writer, {
      trackNamespacePrefix: ["live", "sports"],
    });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  // 失敗は呼び出し元へ伝播し、pending エントリと pendingPrefix が残留しない
  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("stream closed by peer"));
  assert.equal(session.pendingRequestUpdate.size, 0);
  assert.isUndefined(subscription.pendingPrefix);
  assert.deepEqual(subscription.namespacePrefix, ["live"]);
});

/**
 * bidiSendRequestUpdate の write 失敗時に pendingRequestUpdate エントリが
 * 削除されることを検証する。削除しないと、後続の GOAWAY 処理やセッション
 * close が登録済みの reject を呼び、呼び出し元に返されていない Promise の
 * unhandled rejection を生む。
 */
test("bidiSendRequestUpdate: write 失敗時に pendingRequestUpdate エントリが削除される", async () => {
  const ctx = createPublishReadTestContext({
    write() {
      throw new Error("stream closed by peer");
    },
  });
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});

  let thrown: Error | undefined;
  try {
    await bidiSendRequestUpdate(ctx.session, subscriber, {});
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  // 失敗は呼び出し元へ伝播し、pending エントリが残留しない
  assert.isDefined(thrown);
  assert.isTrue(thrown!.message.includes("stream closed by peer"));
  assert.equal(ctx.session.pendingRequestUpdate.size, 0);
});

/**
 * GOAWAY 受信時にアプリの goawayCallback が throw しても、後続の
 * pendingRequestUpdate の掃除と writer.close() が実行されることを検証する。
 * try/catch で黙殺しないと、コールバック例外で掃除が中断され update() の
 * Promise が未解決のまま残る。
 */
test("bidiReadRequestStreamMessages: goawayCallback が throw しても pendingRequestUpdate の掃除と close() が実行される", async () => {
  const ctx = createPublishReadTestContext({});
  const subscriber = new SubscriberImpl(["test"], "track", ctx.requestId, 1n, () => {});
  subscriber.goawayCallback = () => {
    throw new Error("goaway callback failed");
  };
  ctx.session.subscribers.set(ctx.requestId, subscriber);

  // GOAWAY 前に送信済みで応答待ちの REQUEST_UPDATE を注入する
  let rejected: Error | undefined;
  ctx.session.pendingRequestUpdate.set(90n, {
    resolve: () => {},
    reject: (err: Error) => {
      rejected = err;
    },
    targetRequestId: ctx.requestId,
  });

  const readPromise = bidiReadRequestStreamMessages(
    ctx.session,
    ctx.requestId,
    ctx.stream,
    ctx.controlReader,
    "subscribe",
  );
  const goawayPayload = encodeGoawayPayload({
    type: MessageType.GOAWAY,
    newSessionUri: "moqt://new.example.com",
    timeout: 0n,
  });
  // controlWriter は createPublishReadTestContext で設定済みのため安全
  const goawayMessage = ctx.session.controlWriter!.encode(MessageType.GOAWAY, goawayPayload);
  ctx.readableController.enqueue(goawayMessage);
  ctx.readableController.close();
  await readPromise;

  // コールバック例外が黙殺されても、掃除と自方向 FIN は実行される
  assert.isDefined(rejected);
  assert.equal(ctx.session.pendingRequestUpdate.size, 0);
  assert.deepEqual(ctx.events, ["close"]);
});
