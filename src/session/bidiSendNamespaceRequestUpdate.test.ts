/**
 * session/bidi.ts の単体テスト: bidiSendNamespaceRequestUpdate
 *
 * namespace / tracks 購読の REQUEST_UPDATE 送信と、重なる prefix の許可・
 * 予約 namespace・in-flight 制限の検証を扱う。
 * 実 SessionImpl・実 W3C ストリーム・実 Map でセッションを構築し、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { SubscriberImpl } from "../subscriber";
import {
  AuthorizationTokenAliasType,
  type AuthorizationToken,
  decodeAuthorizationToken,
} from "../message/authorizationToken";
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
// draft-ietf-moq-transport-23 §9.5.2 (Updating Namespace Subscriptions)
// ============================================================================

/**
 * namespaceSubscriptions / tracksSubscriptions にエントリを持つ実 SessionImpl を
 * createBidiSession の上に構築する。
 *
 * @param kind - 登録するサブスクリプションの種別
 * @param namespacePrefix - 既存の Track Namespace Prefix
 */
function createNamespaceUpdateSession(
  kind: "namespace" | "tracks",
  namespacePrefix: string[],
  authorizationToken?: AuthorizationToken,
): {
  session: BidiSessionInternal;
  written: Uint8Array[];
  subscription: {
    state: "active" | "closed";
    namespacePrefix: string[];
    pendingPrefix?: string[];
    authorizationToken?: AuthorizationToken | undefined;
  };
} {
  const { session, written } = createBidiSession();
  const subscription = {
    callbacks: {},
    state: "active" as const,
    namespacePrefix,
    authorizationToken,
  };
  if (kind === "namespace") {
    session.namespaceSubscriptions.set(0n, subscription);
  } else {
    session.tracksSubscriptions.set(0n, subscription);
  }
  return { session, written, subscription };
}

/**
 * 実 SessionImpl のリクエストストリーム writer を返す
 *
 * bidiSendNamespaceRequestUpdate は writer を引数に取るため、テストが
 * WritableStreamDefaultWriter を偽装せず、createBidiSession が実 WebTransport から
 * 生成した実ストリームの writer をそのまま渡す。
 */
function requestStreamWriter(
  session: BidiSessionInternal,
): WritableStreamDefaultWriter<Uint8Array> {
  const streamInfo = session.requestStreams.get(0n);
  assert.isDefined(streamInfo);
  return streamInfo!.writer;
}

/**
 * write 失敗を注入できる実 SessionImpl で namespace / tracks 更新用の状態を作る
 *
 * 登録するエントリと返す subscription は同一オブジェクトであり、更新中の
 * pendingPrefix の遷移をそのまま検証できる。
 */
function createNamespaceUpdateSessionWithBidiSink(
  kind: "namespace" | "tracks",
  namespacePrefix: string[],
  sink: UnderlyingSink<Uint8Array>,
): {
  session: BidiSessionInternal;
  subscription: { state: "active" | "closed"; namespacePrefix: string[]; pendingPrefix?: string[] };
} {
  const { session } = createBidiSession({ bidiSink: () => sink });
  const subscription: {
    callbacks: Record<string, never>;
    state: "active" | "closed";
    namespacePrefix: string[];
    pendingPrefix?: string[];
  } = {
    callbacks: {},
    state: "active",
    namespacePrefix,
  };
  if (kind === "namespace") {
    session.namespaceSubscriptions.set(0n, subscription);
  } else {
    session.tracksSubscriptions.set(0n, subscription);
  }
  return { session, subscription };
}

test("bidiSendNamespaceRequestUpdate: TRACK_NAMESPACE_PREFIX が REQUEST_UPDATE にエンコードされる", async () => {
  const { session, written, subscription } = createNamespaceUpdateSession("namespace", ["live"]);

  const writer = requestStreamWriter(session);

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
 * draft-ietf-moq-transport-23 §9.19.18:
 * SUBSCRIBE_TRACKS の REQUEST_UPDATE で PAUSED=0 (unpaused) / PAUSED=1 (paused) の
 * 両方がワイヤに載ることを検証する。将来の購読向けであり既存購読には影響しない。
 */
test("bidiSendNamespaceRequestUpdate: Tracks 更新の PAUSED がワイヤに載る", async () => {
  for (const paused of [false, true]) {
    const { session, written } = createNamespaceUpdateSession("tracks", ["live"]);
    const writer = requestStreamWriter(session);

    const updatePromise = bidiSendNamespaceRequestUpdate(session, 0n, writer, {
      trackNamespacePrefix: ["live", "sports"],
      paused,
    });
    for (const [, pending] of session.pendingRequestUpdate) {
      pending.resolve();
    }
    await updatePromise;

    // PAUSED パラメータが指定値どおりにエンコードされる
    // 直前で isDefined を検証済みのため非 null アサーションで参照する
    const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
    assert.equal(messages.length, 1, `paused=${paused}`);
    const decoded = decodeRequestUpdatePayload(messages[0].payload);
    const pausedParam = decoded.parameters.find((p) => p.type === MessageParameterType.PAUSED);
    assert.isDefined(pausedParam, `paused=${paused}`);
    assert.deepEqual(pausedParam!.value, new Uint8Array([paused ? 1 : 0]), `paused=${paused}`);
    // 同梱の TRACK_NAMESPACE_PREFIX も新 prefix で存在する
    const prefixParam = decoded.parameters.find(
      (p) => p.type === MessageParameterType.TRACK_NAMESPACE_PREFIX,
    );
    assert.isDefined(prefixParam, `paused=${paused}`);
  }
});

/**
 * draft-ietf-moq-transport-23 §9.19.18:
 * PAUSED 省略時は不変のため送らないことを検証する。
 */
test("bidiSendNamespaceRequestUpdate: Tracks 更新の PAUSED 省略時は送らない", async () => {
  const { session, written } = createNamespaceUpdateSession("tracks", ["live"]);
  const writer = requestStreamWriter(session);

  const updatePromise = bidiSendNamespaceRequestUpdate(session, 0n, writer, {
    trackNamespacePrefix: ["live", "sports"],
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  const decoded = decodeRequestUpdatePayload(messages[0].payload);
  assert.isUndefined(decoded.parameters.find((p) => p.type === MessageParameterType.PAUSED));
});

/**
 * draft-ietf-moq-transport-23 §9.19.18:
 * SUBSCRIBE_NAMESPACE 向け REQUEST_UPDATE では PAUSED が許可されないため、
 * Namespace 更新では実行時に混入しても送らないことを検証する。
 */
test("bidiSendNamespaceRequestUpdate: Namespace 更新では PAUSED を送らない", async () => {
  const { session, written } = createNamespaceUpdateSession("namespace", ["live"]);
  const writer = requestStreamWriter(session);

  // 型上は露出させないが、実行時に混入しても黙って落とす
  const updatePromise = bidiSendNamespaceRequestUpdate(session, 0n, writer, {
    trackNamespacePrefix: ["live", "sports"],
    paused: false,
  } as unknown as { trackNamespacePrefix: string[] });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  const decoded = decodeRequestUpdatePayload(messages[0].payload);
  assert.isUndefined(decoded.parameters.find((p) => p.type === MessageParameterType.PAUSED));
  // PAUSED のみ落とし、TRACK_NAMESPACE_PREFIX は新 prefix で残る
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

  const writer = requestStreamWriter(session);

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

test("bidiSendNamespaceRequestUpdate: 同一型のアクティブな購読と prefix が重なる更新も送信できる", async () => {
  // draft-ietf-moq-transport-23 §9.5.2 で draft-22 の overlap 制約は削除された。
  // 別のアクティブな SUBSCRIBE_NAMESPACE (prefix ["live"]) と重なる
  // (包含関係にある) 更新を、ローカルで拒否せずに送信できることを検証する。
  const { session, subscription } = createNamespaceUpdateSession("namespace", ["live", "sports"]);
  session.namespaceSubscriptions.set(2n, {
    callbacks: {},
    state: "active",
    namespacePrefix: ["live"],
  });

  const writer = requestStreamWriter(session);

  let thrown: Error | undefined;
  try {
    const updatePromise = bidiSendNamespaceRequestUpdate(session, 0n, writer, {
      trackNamespacePrefix: ["live", "news"],
    });
    // REQUEST_UPDATE が送信された (pending が登録された) ことを確認してから解決する
    assert.equal(session.pendingRequestUpdate.size, 1);
    for (const [, pending] of session.pendingRequestUpdate) {
      pending.resolve();
    }
    await updatePromise;
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  assert.isUndefined(thrown);
  assert.deepEqual(subscription.pendingPrefix, ["live", "news"]);
});

test("bidiSendNamespaceRequestUpdate: 別型の購読と prefix が重なっても送信できる", async () => {
  // 型をまたぐ比較は行わない。SUBSCRIBE_NAMESPACE の更新で SUBSCRIBE_TRACKS の
  // prefix を参照せず、そのまま送信する。
  const { session, subscription } = createNamespaceUpdateSession("namespace", ["live"]);
  session.tracksSubscriptions.set(2n, {
    callbacks: {},
    state: "active",
    namespacePrefix: ["live", "sports"],
  });

  const writer = requestStreamWriter(session);

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

  const writer = requestStreamWriter(session);

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

  const writer = requestStreamWriter(session);

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

  const writer = requestStreamWriter(session);

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

  const writer = requestStreamWriter(session);

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
  const writer = requestStreamWriter(session);

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

  const writer = requestStreamWriter(session);

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
  // write が失敗する実 WritableStream の sink を持つ実 SessionImpl を使う
  // (ピアがストリームを閉じた等を再現)
  const { session, subscription } = createNamespaceUpdateSessionWithBidiSink(
    "namespace",
    ["live"],
    {
      write() {
        throw new Error("ピアがストリームを閉じた");
      },
    },
  );
  const writer = requestStreamWriter(session);

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
  assert.isTrue(thrown!.message.includes("ピアがストリームを閉じた"));
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
      throw new Error("ピアがストリームを閉じた");
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
  assert.isTrue(thrown!.message.includes("ピアがストリームを閉じた"));
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
    throw new Error("goaway コールバックが失敗した");
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

/**
 * draft-ietf-moq-msf-01 §11.4.3:
 * "When a token is associated with a track, it MUST be included in ALL control
 *  messages that accept the AUTHORIZATION TOKEN parameter and are associated with
 *  that track. For end subscribers, this includes SUBSCRIBE, SUBSCRIBE_NAMESPACE,
 *  FETCH, and REQUEST_UPDATE messages."
 * 初回要求で使ったトークンを namespace / tracks の REQUEST_UPDATE にも載せる。
 */
test("bidiSendNamespaceRequestUpdate: 購読の AUTHORIZATION_TOKEN が REQUEST_UPDATE に載る", async () => {
  for (const kind of ["namespace", "tracks"] as const) {
    // REGISTER は初回要求で送信済みのため USE_ALIAS に変換した値を保持している
    const token = { aliasType: AuthorizationTokenAliasType.USE_ALIAS, tokenAlias: 7n } as const;
    const { session, written } = createNamespaceUpdateSession(kind, ["live"], token);
    const writer = requestStreamWriter(session);

    const updatePromise = bidiSendNamespaceRequestUpdate(session, 0n, writer, {
      trackNamespacePrefix: ["live", "sports"],
    });
    for (const [, pending] of session.pendingRequestUpdate) {
      pending.resolve();
    }
    await updatePromise;

    const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
    assert.equal(messages.length, 1, kind);
    const decoded = decodeRequestUpdatePayload(messages[0]!.payload);
    const tokenParam = decoded.parameters.find(
      (p) => p.type === MessageParameterType.AUTHORIZATION_TOKEN,
    );
    assert.isDefined(tokenParam, kind);
    assert.deepEqual(decodeAuthorizationToken(tokenParam!.value), token, kind);
  }
});

/**
 * トークンを伴わない購読では AUTHORIZATION_TOKEN を載せない
 * (draft-ietf-moq-msf-01 §11.4.3 の MUST はトークンが紐づく場合だけ適用される)。
 */
test("bidiSendNamespaceRequestUpdate: トークンの無い購読では AUTHORIZATION_TOKEN を載せない", async () => {
  const { session, written } = createNamespaceUpdateSession("namespace", ["live"]);
  const writer = requestStreamWriter(session);

  const updatePromise = bidiSendNamespaceRequestUpdate(session, 0n, writer, {
    trackNamespacePrefix: ["live", "sports"],
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  const decoded = decodeRequestUpdatePayload(messages[0]!.payload);
  assert.equal(
    decoded.parameters.some((p) => p.type === MessageParameterType.AUTHORIZATION_TOKEN),
    false,
  );
});

/**
 * draft-ietf-moq-transport-23 §9.19.18:
 * SUBSCRIBE_TRACKS の REQUEST_UPDATE の PAUSED は将来の購読に作用するものであり、
 * 既存の Subscriber の paused を変えない。
 */
test("bidiSendNamespaceRequestUpdate: Tracks 更新の PAUSED は既存購読を変えない", async () => {
  const { session, written } = createNamespaceUpdateSession("tracks", ["live"]);
  const subscriber = new SubscriberImpl(["live"], "video", 10n, 1n, () => {});
  session.subscribers.set(10n, subscriber);
  const writer = requestStreamWriter(session);

  const updatePromise = bidiSendNamespaceRequestUpdate(session, 0n, writer, {
    trackNamespacePrefix: ["live", "sports"],
    paused: true,
  });
  for (const [, pending] of session.pendingRequestUpdate) {
    pending.resolve();
  }
  await updatePromise;

  // ワイヤには PAUSED=1 が載るが、既存購読の paused は変わらない
  const messages = new ControlStreamReader().feed(concatUint8Arrays(written));
  const decoded = decodeRequestUpdatePayload(messages[0]!.payload);
  const pausedParam = decoded.parameters.find(
    (param) => param.type === MessageParameterType.PAUSED,
  );
  assert.deepEqual(pausedParam?.value, new Uint8Array([1]));
  assert.isFalse(subscriber.paused);
});
