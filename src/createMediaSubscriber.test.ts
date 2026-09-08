/**
 * MediaSubscriber の単体テスト
 *
 * processCatalogPayload / filterPendingCatalogObjects / resolveAuthorizationToken の
 * 純関数ロジック、復号フレーム破棄の所有権 (handleVideoDecodedData /
 * handleAudioDecodedData)、Catalog 取得失敗後の hygiene、extractTrackInfo の
 * role なし解決と未解決通知を検証する。
 */

import { test, assert } from "vite-plus/test";
import { MediaSubscriberImpl } from "./createMediaSubscriber";
import type { Session } from "./session";
import type { Subscriber, RequestUpdateOptions } from "./subscriber";
import type { MediaSubscriberState } from "./codec/types";
import { TrackPropertyId } from "./properties";
import type { Fetcher } from "./fetcher";
import {
  encodeCatalog,
  encodeCatalogDelta,
  type Catalog,
  type CatalogDelta,
  type CatalogTrack,
} from "./msf";
import {
  filterPendingCatalogObjects,
  processCatalogPayload,
  resolveAuthorizationToken,
} from "./createMediaSubscriber";
import { type MoqtObject } from "./dataStream";
import type { Location } from "./message";
import { AuthorizationTokenAliasType, type AuthorizationToken } from "./message/authorizationToken";

/** テスト用の最小フルカタログ */
function makeCatalog(tracks: Catalog["tracks"] = []): Catalog {
  return {
    version: "draft-01",
    tracks,
  };
}

test("processCatalogPayload: フルカタログは current を置換する", () => {
  // 既存カタログがある状態で独立フルを受け取ると置換する
  const current = makeCatalog([{ name: "old", packaging: "loc", isLive: true }]);
  const next = makeCatalog([{ name: "video", packaging: "loc", isLive: true }]);
  const result = processCatalogPayload(current, encodeCatalog(next));

  assert.equal(result.kind, "full");
  assert.deepStrictEqual(result.catalog, next);
});

test("processCatalogPayload: null からのフルカタログは置換する", () => {
  // 初回受信は current=null からのフル置換
  const next = makeCatalog([{ name: "audio", packaging: "loc", isLive: true }]);
  const result = processCatalogPayload(null, encodeCatalog(next));

  assert.equal(result.kind, "full");
  assert.deepStrictEqual(result.catalog, next);
});

test("processCatalogPayload: delta を applyCatalogDelta で適用する", () => {
  // 既存フルに add operation の delta を適用する
  const current = makeCatalog([{ name: "video", packaging: "loc", isLive: true }]);
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "add", tracks: [{ name: "audio", packaging: "loc", isLive: true }] }],
  };
  const result = processCatalogPayload(current, encodeCatalogDelta(delta));

  assert.equal(result.kind, "delta");
  assert.deepStrictEqual(result.catalog, {
    version: "draft-01",
    tracks: [
      { name: "video", packaging: "loc", isLive: true },
      { name: "audio", packaging: "loc", isLive: true },
    ],
  });
});

test("processCatalogPayload: current=null の delta は ignored になる", () => {
  // フル未受信時の delta はサイレント無視（error にしない）
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "add", tracks: [{ name: "audio", packaging: "loc", isLive: true }] }],
  };
  const result = processCatalogPayload(null, encodeCatalogDelta(delta));

  assert.equal(result.kind, "ignored");
  assert.equal(result.catalog, null);
});

test("processCatalogPayload: apply 失敗時は current を維持して error を返す", () => {
  // isComplete=true 確定後の add は §5.1.3 で reject される
  const current: Catalog = {
    version: "draft-01",
    tracks: [{ name: "video", packaging: "loc", isLive: true }],
    isComplete: true,
  };
  const delta: CatalogDelta = {
    deltaUpdate: true,
    operations: [{ type: "add", tracks: [{ name: "audio", packaging: "loc", isLive: true }] }],
  };
  const result = processCatalogPayload(current, encodeCatalogDelta(delta));

  assert.equal(result.kind, "error");
  assert.deepStrictEqual(result.catalog, current);
  assert.ok(result.kind === "error" && result.error instanceof Error);
  if (result.kind === "error") {
    assert.match(result.error.message, /cannot add tracks after isComplete=true/);
  }
});

test("processCatalogPayload: decode 失敗時は current を維持して error を返す", () => {
  // 不正 JSON は decode 失敗として error になる
  const current = makeCatalog([{ name: "video", packaging: "loc", isLive: true }]);
  const result = processCatalogPayload(current, new TextEncoder().encode("not-json"));

  assert.equal(result.kind, "error");
  assert.deepStrictEqual(result.catalog, current);
  assert.ok(result.kind === "error" && result.error instanceof Error);
  if (result.kind === "error") {
    // JSON.parse 由来の SyntaxError が伝播する
    assert.ok(result.error instanceof SyntaxError || /JSON|Unexpected/i.test(result.error.message));
  }
});

test("processCatalogPayload: current=null の decode 失敗も error を返す", () => {
  // catalog 未受信時の不正 payload も error（catalog は null 維持）
  const result = processCatalogPayload(null, new TextEncoder().encode("not-json"));

  assert.equal(result.kind, "error");
  assert.equal(result.catalog, null);
  assert.ok(result.kind === "error" && result.error instanceof Error);
});

// ============================================================================
// filterPendingCatalogObjects（FETCH と live の二重配信除去）
// ============================================================================

/** テスト用の Catalog オブジェクトを構築する */
function makeCatalogObject(groupId: bigint, objectId: bigint): MoqtObject {
  return {
    groupId,
    objectId,
    status: 0,
    payload: new Uint8Array(),
  };
}

test("filterPendingCatalogObjects: 空配列は空を返す", () => {
  assert.deepEqual(filterPendingCatalogObjects([], { group: 0n, object: 0n }), []);
});

test("filterPendingCatalogObjects: FETCH で配信済みと同一 Location を除去する", () => {
  // FETCH 側で既に適用済みのオブジェクトが live でも届いた場合 (二重配信) は除外する
  const pending = [makeCatalogObject(0n, 0n)];
  const result = filterPendingCatalogObjects(pending, { group: 0n, object: 0n });
  assert.deepEqual(result, []);
});

test("filterPendingCatalogObjects: より古い Group のオブジェクトを除去し新しい Group は残す", () => {
  const pending = [makeCatalogObject(0n, 5n), makeCatalogObject(2n, 0n)];
  const result = filterPendingCatalogObjects(pending, { group: 1n, object: 0n });
  assert.deepEqual(result, [makeCatalogObject(2n, 0n)]);
});

test("filterPendingCatalogObjects: 同一 Group で FETCH 配信済み以下の Object を除去する", () => {
  const pending = [makeCatalogObject(1n, 0n), makeCatalogObject(1n, 2n)];
  const result = filterPendingCatalogObjects(pending, { group: 1n, object: 2n });
  assert.deepEqual(result, []);
});

test("filterPendingCatalogObjects: より新しい Group のオブジェクトは残す", () => {
  const pending = [makeCatalogObject(2n, 0n)];
  const result = filterPendingCatalogObjects(pending, { group: 1n, object: 0n });
  assert.deepEqual(result, [makeCatalogObject(2n, 0n)]);
});

test("filterPendingCatalogObjects: 同一 Group で FETCH 配信済みより新しい Object は残す", () => {
  const pending = [makeCatalogObject(1n, 3n)];
  const result = filterPendingCatalogObjects(pending, { group: 1n, object: 2n });
  assert.deepEqual(result, [makeCatalogObject(1n, 3n)]);
});

// ============================================================================
// resolveAuthorizationToken（draft-ietf-moq-msf-01 §5.2.42 / §11.4.2 / §11.4.4）
// ============================================================================

function useValueToken(): AuthorizationToken {
  return {
    aliasType: AuthorizationTokenAliasType.USE_VALUE,
    tokenType: 0n,
    tokenValue: new TextEncoder().encode("token"),
  };
}

test("resolveAuthorizationToken: authInfo 未指定は認可不要で undefined", async () => {
  assert.equal(await resolveAuthorizationToken(undefined), undefined);
});

test("resolveAuthorizationToken: 空の authInfo は認可不要で undefined", async () => {
  assert.equal(await resolveAuthorizationToken({}), undefined);
});

test("resolveAuthorizationToken: authInfo あり・コールバック未提供は throw（§11.4.4）", async () => {
  // トークン欠落時のエラーが呼び出し元に伝わることを検証する
  let error: unknown;
  try {
    await resolveAuthorizationToken({ "privacy-pass": {} });
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof Error);
  assert.ok(error.message.includes("no getAuthorizationToken callback was provided"));
});

test("resolveAuthorizationToken: コールバックが undefined を返すと throw（§11.4.4）", async () => {
  let error: unknown;
  try {
    await resolveAuthorizationToken({ cat: {} }, () => undefined);
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof Error);
  assert.ok(error.message.includes("getAuthorizationToken returned no token"));
});

test("resolveAuthorizationToken: コールバックが返したトークンを解決する", async () => {
  const token = useValueToken();
  const resolved = await resolveAuthorizationToken({ "privacy-pass": {} }, () => token);
  assert.equal(resolved, token);
});

test("resolveAuthorizationToken: 非同期コールバックにも対応する", async () => {
  const token = useValueToken();
  const resolved = await resolveAuthorizationToken({ cat: {} }, async () => token);
  assert.equal(resolved, token);
});

/**
 * 復号フレーム破棄の検証用の制御口
 *
 * 復号ハンドラを直接駆動し、所有権方針どおりに閉じられることを検証する。
 * VideoFrame / AudioData / AudioContext はブラウザ専用 API であり
 * node 環境に実物がないため、記録用の最小オブジェクトを注入する
 * (モジュール置換は行わない)。
 */
interface SubscriberFrameControl {
  videoWriter: { write: (frame: unknown) => Promise<void> } | null;
  audioContext: AudioContext | null;
  audioDestination: MediaStreamAudioDestinationNode | null;
  handleVideoDecodedData(data: { frame: VideoFrame }): void;
  handleAudioDecodedData(data: { data: AudioData }): void;
}

/**
 * 破棄記録付きのテスト用フレーム
 */
function createRecordingFrame(): { frame: VideoFrame; isClosed: () => boolean } {
  let closed = false;
  const frame = {
    close: () => {
      closed = true;
    },
  } as unknown as VideoFrame;
  return { frame, isClosed: () => closed };
}

test("handleVideoDecodedData: 書き込み失敗時に VideoFrame を閉じる", async () => {
  // 書き込み失敗でリークしないことの検証。失敗の通知はしない
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberFrameControl;
  control.videoWriter = {
    write: async () => {
      throw new Error("write failed");
    },
  };
  const { frame, isClosed } = createRecordingFrame();

  control.handleVideoDecodedData({ frame });
  // 非同期 catch の完了を microtask の flush で待つ (タイマー不使用)
  await Promise.resolve();
  await Promise.resolve();

  assert.isTrue(isClosed());
  assert.equal(errors.length, 0);
});

test("handleVideoDecodedData: 書き込み成功時は VideoFrame を閉じない", async () => {
  // 成功時は Generator 所有のため閉じない方針の検証。失敗の通知はしない
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberFrameControl;
  control.videoWriter = {
    write: async () => {},
  };
  const { frame, isClosed } = createRecordingFrame();

  control.handleVideoDecodedData({ frame });
  // 非同期 catch の完了を microtask の flush で待つ (タイマー不使用)
  await Promise.resolve();
  await Promise.resolve();

  assert.isFalse(isClosed());
  assert.equal(errors.length, 0);
});

test("handleAudioDecodedData: 音声変換失敗時に onError 通知し AudioData を閉じる", () => {
  // 変換全体の throw でリークせず通知することの検証
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberFrameControl;
  control.audioContext = {
    createBuffer: () => {
      throw new Error("createBuffer failed");
    },
  } as unknown as AudioContext;
  control.audioDestination = {} as MediaStreamAudioDestinationNode;
  let closed = false;
  const audioData = {
    numberOfChannels: 1,
    sampleRate: 48000,
    numberOfFrames: 0,
    close: () => {
      closed = true;
    },
  } as unknown as AudioData;

  control.handleAudioDecodedData({ data: audioData });

  assert.equal(errors.length, 1);
  assert.isTrue(closed);
});

test("handleVideoDecodedData: 出力先不在時はフレームを閉じる", () => {
  // writer 不在の既存正常系が維持されることの検証。
  // 早期 return 経路のため onError 通知はなく、write も呼ばれない
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberFrameControl;
  const { frame, isClosed } = createRecordingFrame();

  control.handleVideoDecodedData({ frame });

  assert.isTrue(isClosed());
  assert.equal(errors.length, 0);
});

test("handleAudioDecodedData: 出力先不在時はフレームを閉じる", () => {
  // context 不在の既存正常系が維持されることの検証。
  // 早期 return 経路のため onError 通知はない
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberFrameControl;
  let audioClosed = false;
  const audioData = {
    close: () => {
      audioClosed = true;
    },
  } as unknown as AudioData;

  control.handleAudioDecodedData({ data: audioData });

  assert.isTrue(audioClosed);
  assert.equal(errors.length, 0);
});

test("handleVideoDecodedData: 書き込みの同期 throw 時も VideoFrame を閉じる", () => {
  // write 自体の同期 throw では catch 節に届かないため、外側 try/catch で閉じる
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberFrameControl;
  control.videoWriter = {
    write: () => {
      throw new Error("sync write failed");
    },
  } as unknown as { write: (frame: unknown) => Promise<void> };
  const { frame, isClosed } = createRecordingFrame();

  control.handleVideoDecodedData({ frame });

  assert.isTrue(isClosed());
  assert.equal(errors.length, 0);
});

test("handleAudioDecodedData: 音声変換成功時は AudioData を閉じて通知しない", () => {
  // 成功時も finally でちょうど 1 回閉じ、onError しないことの検証
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberFrameControl;
  control.audioContext = {
    createBuffer: () => ({
      copyToChannel: () => {},
    }),
    createBufferSource: () => ({
      buffer: null,
      connect: () => {},
      start: () => {},
    }),
  } as unknown as AudioContext;
  control.audioDestination = {} as MediaStreamAudioDestinationNode;
  let closeCount = 0;
  const audioData = {
    numberOfChannels: 1,
    sampleRate: 48000,
    numberOfFrames: 1,
    copyTo: () => {},
    close: () => {
      closeCount++;
    },
  } as unknown as AudioData;

  control.handleAudioDecodedData({ data: audioData });

  assert.equal(closeCount, 1);
  assert.equal(errors.length, 0);
});

test("handleAudioDecodedData: 音声再生開始の失敗時も onError 通知し AudioData を閉じる", () => {
  // 変換全体 (createBuffer〜start) の裏付けとして start 失敗経路を検証する
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberFrameControl;
  control.audioContext = {
    createBuffer: () => ({
      copyToChannel: () => {},
    }),
    createBufferSource: () => ({
      buffer: null,
      connect: () => {},
      start: () => {
        throw new Error("start failed");
      },
    }),
  } as unknown as AudioContext;
  control.audioDestination = {} as MediaStreamAudioDestinationNode;
  let closed = false;
  const audioData = {
    numberOfChannels: 1,
    sampleRate: 48000,
    numberOfFrames: 1,
    copyTo: () => {},
    close: () => {
      closed = true;
    },
  } as unknown as AudioData;

  control.handleAudioDecodedData({ data: audioData });

  assert.equal(errors.length, 1);
  assert.isTrue(closed);
});

/**
 * Catalog 取得失敗後の hygiene 検証用の制御口
 *
 * subscribeCatalog を短い実時間 timeout で駆動し、失敗後の扱いを検証する。
 */
interface SubscriberCatalogControl {
  session: Session | null;
  catalogFetchInProgress: boolean;
  pendingCatalogObjects: MoqtObject[];
  catalogFetchLastLocation: Location | null;
  catalogResolve: ((catalog: Catalog) => void) | null;
  catalogTimer: ReturnType<typeof setTimeout> | null;
  catalogReceiveFailed: boolean;
  subscribeCatalog(timeoutMs?: number): Promise<void>;
}

/**
 * Catalog 取得用の最小セッション
 *
 * live / FETCH の object コールバックを捕捉し、遅延オブジェクトを注入できる。
 * subscribe / fetch の引数は実シグネチャで拘束し、返値のみ最小形状にする。
 */
function createCatalogTestSession(hooks: { subscribeError?: Error } = {}): {
  session: Session;
  liveObject: (obj: MoqtObject) => void;
  fetchObject: (obj: MoqtObject) => void;
  fetchEnd: () => void;
  calls: string[];
} {
  const calls: string[] = [];
  let liveObject: (obj: MoqtObject) => void = () => {};
  let fetchObject: (obj: MoqtObject) => void = () => {};
  let fetchEnd: () => void = () => {};
  const session = {
    subscribe: async (...args: Parameters<Session["subscribe"]>): Promise<Subscriber> => {
      calls.push("subscribe");
      if (hooks.subscribeError) {
        throw hooks.subscribeError;
      }
      liveObject = args[2].object;
      return {} as Subscriber;
    },
    fetch: (...args: Parameters<Session["fetch"]>): Promise<Fetcher> => {
      calls.push("fetch");
      fetchObject = args[3].object;
      const end = args[3].end;
      if (end) {
        fetchEnd = end;
      }
      // 未決着のままにして FETCH 終了競合を起こさない (意図的な放置)
      return new Promise<never>(() => {});
    },
  } as unknown as Session;
  return {
    session,
    liveObject: (obj) => liveObject(obj),
    fetchObject: (obj) => fetchObject(obj),
    fetchEnd: () => fetchEnd(),
    calls,
  };
}

/**
 * 遅延注入テストと成功テストで共用する非空 catalog
 */
function makeVideoCatalog(): Catalog {
  return makeCatalog([{ name: "video", packaging: "loc", isLive: true }]);
}

/**
 * 実時間待機用のヘルパー (タイマー副作用待ち)
 */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

test("タイムアウト reject 後に遅延オブジェクトが届いても catalog は更新されない", async () => {
  // 失敗後の遅延 catalog が receivedCatalog 更新と onCatalog 発火を起こさないこと。
  // 10 ms は短い実時間 timeout (fake timers 禁止のため実時間で駆動する)
  const catalogs: Catalog[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onCatalog: (catalog) => {
        catalogs.push(catalog);
      },
    },
  );
  const control = subscriber as unknown as SubscriberCatalogControl;
  const { session, liveObject, fetchObject, calls } = createCatalogTestSession({});
  control.session = session;

  let thrown: unknown = null;
  try {
    await control.subscribeCatalog(10);
  } catch (error) {
    thrown = error;
  }
  assert.isTrue(thrown instanceof Error);
  assert.match((thrown as Error).message, /catalog receive timeout/);
  // SUBSCRIBE 後に FETCH の順序で呼ばれていること
  assert.deepEqual(calls, ["subscribe", "fetch"]);
  // フェーズ状態が掃除されていること
  assert.isFalse(control.catalogFetchInProgress);
  assert.equal(control.pendingCatalogObjects.length, 0);
  assert.isNull(control.catalogFetchLastLocation);
  assert.isNull(control.catalogResolve);
  assert.isNull(control.catalogTimer);
  assert.isTrue(control.catalogReceiveFailed);

  // 遅延オブジェクトが届いても更新・発火しないこと
  const lateObject = { ...makeCatalogObject(0n, 0n), payload: encodeCatalog(makeVideoCatalog()) };
  liveObject(lateObject);
  fetchObject(lateObject);
  assert.isNull(subscriber.catalog);
  assert.equal(catalogs.length, 0);
  // FETCH 側の Location 記録も復活しないこと
  assert.isNull(control.catalogFetchLastLocation);
});

test("session.subscribe throw 後に即時掃除されタイマー副作用がない", async () => {
  // throw 直後にフェーズ状態が掃除され、後続のタイマー発火で副作用がないこと
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", { namespace: ["live"] });
  const control = subscriber as unknown as SubscriberCatalogControl;
  const subscribeError = new Error("subscribe failed");
  const { session } = createCatalogTestSession({ subscribeError });
  control.session = session;

  let thrown: unknown = null;
  try {
    await control.subscribeCatalog(10);
  } catch (error) {
    thrown = error;
  }
  assert.strictEqual(thrown, subscribeError);
  // 即時掃除されていること
  assert.isFalse(control.catalogFetchInProgress);
  assert.equal(control.pendingCatalogObjects.length, 0);
  assert.isNull(control.catalogFetchLastLocation);
  assert.isNull(control.catalogResolve);
  assert.isNull(control.catalogTimer);

  // タイマー発火待ち後も副作用がないこと。
  // 30 ms は timeout (10 ms) を上回る実時間待機 (fake timers 禁止のため実時間で駆動する)
  await sleep(30);
  assert.isFalse(control.catalogFetchInProgress);
  assert.isFalse(control.catalogReceiveFailed);
  assert.isNull(subscriber.catalog);
});

test("成功時は catalog が解決されタイマーが解除される", async () => {
  // 成功パスで timer が残らないことと、非空 catalog 適用の陽性対照。
  // 遅延注入テストのペイロードが適用可能であることの裏付けにもなる
  const catalogs: Catalog[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"] },
    {
      onCatalog: (catalog) => {
        catalogs.push(catalog);
      },
    },
  );
  const control = subscriber as unknown as SubscriberCatalogControl;
  const { session, liveObject, fetchEnd } = createCatalogTestSession({});
  control.session = session;

  const pending = control.subscribeCatalog(1000);
  // subscribe / fetch 登録の完了を microtask の flush で待つ (タイマー不使用)
  for (let index = 0; index < 10; index++) {
    await Promise.resolve();
  }
  liveObject({
    ...makeCatalogObject(0n, 0n),
    payload: encodeCatalog(makeVideoCatalog()),
  });
  fetchEnd();
  await pending;

  assert.isNotNull(subscriber.catalog);
  assert.equal(subscriber.catalog?.tracks.length, 1);
  assert.equal(catalogs.length, 1);
  assert.isFalse(control.catalogFetchInProgress);
  assert.equal(control.pendingCatalogObjects.length, 0);
  assert.isNull(control.catalogResolve);
  assert.isNull(control.catalogTimer);
  assert.isFalse(control.catalogReceiveFailed);
});

/**
 * requestKeyframe の値検証用の制御口
 */
interface SubscriberKeyframeControl {
  currentState: MediaSubscriberState;
  videoSubscriber: Subscriber | null;
  requestKeyframe(): Promise<void>;
}

test("requestKeyframe は最新 Group ID + 1 を送信する", async () => {
  // 固定値でなく largestLocation の live 値を参照することの検証。
  // 送信間に値を書き換えて 2 回送り、snapshot でなく都度参照と分かるようにする
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", { namespace: ["live"] });
  const control = subscriber as unknown as SubscriberKeyframeControl;
  control.currentState = "active";
  const sent: (RequestUpdateOptions | undefined)[] = [];
  const videoSubscriber = {
    state: "active",
    trackProperties: [{ id: TrackPropertyId.DYNAMIC_GROUPS, value: 1n }],
    largestLocation: { group: 41n, object: 3n },
    update: async (...args: Parameters<Subscriber["update"]>) => {
      sent.push(args[0]);
    },
  };
  control.videoSubscriber = videoSubscriber as unknown as Subscriber;

  await control.requestKeyframe();
  videoSubscriber.largestLocation = { group: 100n, object: 0n };
  await control.requestKeyframe();

  assert.equal(sent[0]?.newGroupRequest, 42n);
  assert.equal(sent[1]?.newGroupRequest, 101n);
});

test("requestKeyframe は情報なし時は 0 を送信する", async () => {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", { namespace: ["live"] });
  const control = subscriber as unknown as SubscriberKeyframeControl;
  control.currentState = "active";
  let sent: RequestUpdateOptions | undefined;
  control.videoSubscriber = {
    state: "active",
    trackProperties: [{ id: TrackPropertyId.DYNAMIC_GROUPS, value: 1n }],
    largestLocation: null,
    update: async (...args: Parameters<Subscriber["update"]>) => {
      sent = args[0];
    },
  } as unknown as Subscriber;

  await control.requestKeyframe();

  assert.equal(sent?.newGroupRequest, 0n);
});

/**
 * role なしトラック解決の検証用の制御口
 */
interface SubscriberTrackControl {
  receivedCatalog: Catalog | null;
  audioTrackInfo: CatalogTrack | null;
  videoTrackInfo: CatalogTrack | null;
  extractTrackInfo(): void;
}

function makeRoleLessCatalog(): Catalog {
  return makeCatalog([
    { name: "audio", packaging: "loc", isLive: true },
    { name: "video", packaging: "loc", isLive: true },
  ]);
}

test("extractTrackInfo: role 省略カタログで名前一致のトラックが特定される", () => {
  // role 絞り込みが空でもカタログ全体の名前一致で解決することの検証
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    {
      namespace: ["live"],
      audio: { trackName: "audio" },
      video: { trackName: "video" },
    },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberTrackControl;
  control.receivedCatalog = makeRoleLessCatalog();

  control.extractTrackInfo();

  assert.strictEqual(control.audioTrackInfo?.name, "audio");
  assert.strictEqual(control.videoTrackInfo?.name, "video");
  assert.equal(errors.length, 0);
});

test("extractTrackInfo: role 省略カタログでデフォルト名のトラックが特定される", () => {
  // trackName 省略時はデフォルト名で探すことの検証
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], audio: {}, video: {} },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberTrackControl;
  control.receivedCatalog = makeRoleLessCatalog();

  control.extractTrackInfo();

  assert.strictEqual(control.audioTrackInfo?.name, "audio");
  assert.strictEqual(control.videoTrackInfo?.name, "video");
  assert.equal(errors.length, 0);
});

test("extractTrackInfo: 未解決時は onError が呼ばれ他方メディアは継続する", () => {
  // 名前不一致で null のまま残り、throw せず通知することの検証
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], audio: { trackName: "missing-audio" }, video: { trackName: "video" } },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberTrackControl;
  control.receivedCatalog = makeRoleLessCatalog();

  control.extractTrackInfo();

  assert.isNull(control.audioTrackInfo);
  assert.strictEqual(control.videoTrackInfo?.name, "video");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /audio track 'missing-audio' not found in catalog/);
});

test("extractTrackInfo: role ありカタログの名前不一致は先頭を採用する", () => {
  // 非空時の先頭採用残置 (後方互換) の明示的な pin
  const errors: Error[] = [];
  const subscriber = new MediaSubscriberImpl(
    "moqt://example.com/live",
    { namespace: ["live"], audio: { trackName: "missing" } },
    {
      onError: (error) => {
        errors.push(error);
      },
    },
  );
  const control = subscriber as unknown as SubscriberTrackControl;
  control.receivedCatalog = makeCatalog([
    { name: "audio", packaging: "loc", isLive: true, role: "audio" },
  ]);

  control.extractTrackInfo();

  assert.strictEqual(control.audioTrackInfo?.name, "audio");
  assert.equal(errors.length, 0);
});
