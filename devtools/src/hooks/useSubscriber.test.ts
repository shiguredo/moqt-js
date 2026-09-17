import { test, assert } from "vite-plus/test";
import { LOC, createCatalog, getVideoTracks, type CatalogTrack } from "moqt-js";
import {
  buildVideoDecoderConfig,
  checkAborted,
  closeSubscriberResources,
  parseLocFrameMetadata,
  resetSubscriberState,
  resetSubscriberStats,
  resolveNewGroupRequestValue,
} from "./useSubscriber";
import { buildObjectSendPlan } from "./usePublisher";
import { createSubscriberInstance, subscriberInstances } from "../signals/subscriber";
import { settingsDisabled } from "../signals/connectionSettings";
import {
  FakeSession,
  FakeSubscriber,
  RecordingDecoderWrapper,
  type FakeCallLog,
} from "../testSupport/fakes";

test("checkAborted returns false and does not run cleanup when not aborted", () => {
  const controller = new AbortController();
  let cleanupCalls = 0;
  const result = checkAborted(controller.signal, () => {
    cleanupCalls += 1;
  });
  assert.equal(result, false);
  assert.equal(cleanupCalls, 0);
});

test("checkAborted returns true and runs cleanup once when aborted", () => {
  const controller = new AbortController();
  controller.abort();
  let cleanupCalls = 0;
  const result = checkAborted(controller.signal, () => {
    cleanupCalls += 1;
  });
  assert.equal(result, true);
  assert.equal(cleanupCalls, 1);
});

test("checkAborted swallows exceptions from cleanup but still returns true", () => {
  const controller = new AbortController();
  controller.abort();
  const result = checkAborted(controller.signal, () => {
    throw new Error("cleanup error");
  });
  assert.equal(result, true);
});

function resetTestEnvironment(): void {
  subscriberInstances.value = new Map();
  settingsDisabled.value = false;
}

/**
 * 検証用の CatalogTrack を作る
 *
 * CatalogTrack は name / packaging / isLive が必須のため既定値を置き、
 * 検証に必要なフィールドだけをテストから上書きする。role は video 固定
 * (購読側は getVideoTracks で role === "video" のトラックを取り出す)。
 */
function makeCatalogTrack(overrides: Partial<CatalogTrack> = {}): CatalogTrack {
  return { name: "video", packaging: "loc", isLive: true, role: "video", ...overrides };
}

/**
 * 検証用の Catalog を作り、購読側と同じ経路で video トラックを取り出す
 *
 * `buildVideoDecoderConfig` は catalog を initData の解決にだけ使い、
 * codec / 解像度 / initRef は引数で渡されたトラックから読む。実装側
 * (`startSubscribing`) も `getVideoTracks` で取り出したトラックを渡すため、
 * テストでも同じ経路でトラックを取り出す。
 */
function makeCatalogWithTrack(
  track: CatalogTrack,
  initDataList?: { id: string; type: string; data: string }[],
): { catalog: ReturnType<typeof createCatalog>; track: CatalogTrack } {
  const catalog = createCatalog([track], initDataList !== undefined ? { initDataList } : undefined);
  const [videoTrack] = getVideoTracks(catalog);
  if (videoTrack === undefined) {
    // 上の createCatalog で video トラックを 1 件渡しているため到達しない
    throw new Error("expected a video track in catalog");
  }
  return { catalog, track: videoTrack };
}

// ============================================================================
// Catalog からの codec 解決 (VideoDecoderConfig の組み立て)
// ============================================================================

// 購読側は Catalog の videoTrack から VideoDecoderConfig を組み立てる。
// codec / 解像度が取り違えられると復号できないため、対応を固定する。
test("buildVideoDecoderConfig: Catalog の codec と解像度を VideoDecoderConfig に反映する", () => {
  const { catalog, track } = makeCatalogWithTrack(
    makeCatalogTrack({ codec: "vp8", width: 640, height: 480 }),
  );

  const config = buildVideoDecoderConfig(track, catalog);

  assert.equal(config.codec, "vp8");
  assert.equal(config.codedWidth, 640);
  assert.equal(config.codedHeight, 480);
  // vp8 は WebCodecs の description を持たない
  assert.equal(config.description, undefined);
});

// width / height は Catalog の任意フィールドである (draft-ietf-moq-msf-01 §5.2.26 / §5.2.27)。
// 未指定のときに codedWidth / codedHeight へ undefined を載せないことを固定する。
test("buildVideoDecoderConfig: width / height が無いトラックでは codedWidth / codedHeight を載せない", () => {
  const { catalog, track } = makeCatalogWithTrack(makeCatalogTrack({ codec: "vp8" }));

  const config = buildVideoDecoderConfig(track, catalog);

  assert.equal("codedWidth" in config, false);
  assert.equal("codedHeight" in config, false);
});

// codec が無い Catalog では Decoder を設定できない。
// 空の codec 文字列で VideoDecoder.configure を呼ぶ前に失敗させる。
test("buildVideoDecoderConfig: codec が無いトラックは例外にする", () => {
  const { catalog, track } = makeCatalogWithTrack(makeCatalogTrack());

  assert.throws(
    () => buildVideoDecoderConfig(track, catalog),
    /video track codec is not specified/,
  );
});

// canonical 形式 (avc1 / hvc1) は Catalog の Initialization Data (Base64) を
// description に復元しないと復号できない (draft-ietf-moq-msf-01 §5.1.7 + §5.2.13)。
test("buildVideoDecoderConfig: initRef から Initialization Data を description に復元する", () => {
  // avcC を模した 4 バイトの初期化データ
  const initDataBytes = new Uint8Array([0x01, 0x64, 0x00, 0x1f]);
  const initDataBase64 = btoa(String.fromCharCode(...initDataBytes));
  const { catalog, track } = makeCatalogWithTrack(
    makeCatalogTrack({ codec: "avc1.42001f", width: 1280, height: 720, initRef: "init-1" }),
    [{ id: "init-1", type: "inline", data: initDataBase64 }],
  );

  const config = buildVideoDecoderConfig(track, catalog);

  const description = config.description;
  assert.ok(description instanceof ArrayBuffer);
  assert.deepEqual(Array.from(new Uint8Array(description)), Array.from(initDataBytes));
});

// initRef が initDataList に無い / inline 以外の場合は description を載せない
// (Base64 として解釈できないデータを VideoDecoder へ渡さない)。
test("buildVideoDecoderConfig: initRef が解決できないときは description を載せない", () => {
  const missingEntry = makeCatalogWithTrack(makeCatalogTrack({ codec: "avc1.42001f" }), [
    { id: "other", type: "inline", data: "AQ==" },
  ]);
  assert.equal(
    buildVideoDecoderConfig(missingEntry.track, missingEntry.catalog).description,
    undefined,
  );

  const notInline = makeCatalogWithTrack(
    makeCatalogTrack({ codec: "avc1.42001f", initRef: "init-1" }),
    [{ id: "init-1", type: "uri", data: "https://example.com/init" }],
  );
  assert.equal(buildVideoDecoderConfig(notInline.track, notInline.catalog).description, undefined);
});

// ============================================================================
// LOC Properties の復号 (受信 Object のメタデータ)
// ============================================================================

// publisher が付与した LOC Properties を購読側が解釈できることを、
// 送信側 (buildObjectSendPlan) の出力をそのまま入力にして固定する。
// timestamp が EncodedVideoChunk に、I ビットがキーフレーム判定に伝わる。
test("parseLocFrameMetadata: publisher が付与した Properties からキーフレームと timestamp を取り出す", () => {
  const keyPlan = buildObjectSendPlan(
    { groupId: 0, objectId: 0 },
    { data: new Uint8Array([0x01]), type: "key", timestamp: 33_333, duration: 33_333 },
  );
  assert.deepEqual(parseLocFrameMetadata(keyPlan.properties), {
    isKeyFrame: true,
    timestamp: 33_333,
  });

  const deltaPlan = buildObjectSendPlan(
    { groupId: 1, objectId: 0 },
    { data: new Uint8Array([0x02]), type: "delta", timestamp: 66_666, duration: 33_333 },
  );
  assert.deepEqual(parseLocFrameMetadata(deltaPlan.properties), {
    isKeyFrame: false,
    timestamp: 66_666,
  });
});

// LOC の拡張は任意であるため、Properties が無い / 空の Object は
// 非キーフレーム・timestamp 0 として扱う (復号を止めない)。
test("parseLocFrameMetadata: Properties が無い / 空の Object はデルタ扱いにする", () => {
  assert.deepEqual(parseLocFrameMetadata(undefined), { isKeyFrame: false, timestamp: 0 });
  assert.deepEqual(parseLocFrameMetadata(new Uint8Array()), { isKeyFrame: false, timestamp: 0 });
});

// TIMESTAMP だけを持つ Object は非キーフレームとして扱う
// (Frame Marking が無い = キーフレームの主張が無い)。
test("parseLocFrameMetadata: TIMESTAMP だけの Object は非キーフレームにする", () => {
  const properties = LOC.encodeVideoProperties({ timestamp: 1_000n });

  assert.deepEqual(parseLocFrameMetadata(properties), { isKeyFrame: false, timestamp: 1_000 });
});

// ============================================================================
// REQUEST_UPDATE の NEW_GROUP_REQUEST の値
// ============================================================================

// draft-ietf-moq-transport-21 §9.20.20: 送信時点で知る最大 Group ID + 1 を送る。
// SUBSCRIBE 直後の snapshot ではなく現在の largestLocation を使う。
test("resolveNewGroupRequestValue: 最大 Location の次の Group を要求する", () => {
  assert.equal(resolveNewGroupRequestValue({ group: 41n, object: 7n }), 42n);
  assert.equal(resolveNewGroupRequestValue({ group: 0n, object: 0n }), 1n);
});

// 最大 Location が未知 (SUBSCRIBE_OK 未受信) のときは 0 を送り、
// Group 情報なしで新規 Group の開始を要求する。
test("resolveNewGroupRequestValue: 最大 Location が無いときは 0 を要求する", () => {
  assert.equal(resolveNewGroupRequestValue(null), 0n);
});

// ============================================================================
// 購読開始時の統計リセット
// ============================================================================

// startSubscribing は購読開始時に前回の統計を初期化する。
// リセット漏れがあると再接続後に古い値が表示され続ける。
test("resetSubscriberStats: 統計値を初期値へ戻す", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("reset-stats-1");
  instance.framesDecoded.value = 10;
  instance.keyFramesDecoded.value = 2;
  instance.objectsReceived.value = 12;
  instance.currentGroup.value = 5;
  instance.currentSubGroup.value = 1;
  instance.bytesReceived.value = 1024;
  instance.objectsWithExtensions.value = 12;
  instance.chunksCreated.value = 12;
  instance.chunksDecoded.value = 10;
  instance.chunksSkipped.value = 2;
  instance.decodeErrors.value = 1;
  instance.largestLocation.value = { group: 5n, object: 11n };

  resetSubscriberStats(instance);

  assert.equal(instance.framesDecoded.value, 0);
  assert.equal(instance.keyFramesDecoded.value, 0);
  assert.equal(instance.objectsReceived.value, 0);
  assert.equal(instance.currentGroup.value, 0);
  assert.equal(instance.currentSubGroup.value, 0);
  assert.equal(instance.bytesReceived.value, 0);
  assert.equal(instance.objectsWithExtensions.value, 0);
  assert.equal(instance.chunksCreated.value, 0);
  assert.equal(instance.chunksDecoded.value, 0);
  assert.equal(instance.chunksSkipped.value, 0);
  assert.equal(instance.decodeErrors.value, 0);
  assert.equal(instance.largestLocation.value, null);
});

// ============================================================================
// 後始末フロー (decoder.close → catalog 購読の unsubscribe → session.close)
// ============================================================================

test("closeSubscriberResources does not throw when decoder/session are null", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("close-resources-1");
  assert.equal(instance.decoder.value, null);
  assert.equal(instance.session.value, null);
  closeSubscriberResources(instance, null);
  assert.equal(instance.session.value, null);
});

test("closeSubscriberResources resets session.value to null", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("close-resources-2");
  const calls: FakeCallLog = [];
  instance.session.value = new FakeSession({ label: "session.close", calls });

  closeSubscriberResources(instance, null);

  assert.equal(instance.session.value, null);
  assert.deepEqual(calls, ["session.close"]);
});

test("resetSubscriberState resets every state signal to initial value", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("reset-state-1");
  // 値を書き換えて初期値からずらしておく。
  // 外部リソースは実体 (Catalog は createCatalog、decoder は実 DecoderWrapper の
  // サブクラス) と Fake (WebTransport / 購読) で埋める。
  instance.subscriber.value = new FakeSubscriber();
  instance.catalogSubscriber.value = new FakeSubscriber();
  instance.catalog.value = createCatalog([makeCatalogTrack({ codec: "h264" })]);
  instance.decoder.value = new RecordingDecoderWrapper();
  instance.decoderConfigured.value = true;
  instance.codec.value = "h264";
  instance.dynamicGroupsSupported.value = true;
  instance.largestLocation.value = { group: 1n, object: 1n };

  const chainRef = { current: Promise.resolve().then(() => {}) };
  const previousChain = chainRef.current;

  resetSubscriberState(instance, chainRef, () => false);

  assert.equal(instance.subscriber.value, null);
  assert.equal(instance.catalogSubscriber.value, null);
  assert.equal(instance.catalog.value, null);
  assert.equal(instance.decoder.value, null);
  assert.equal(instance.decoderConfigured.value, false);
  assert.equal(instance.codec.value, "");
  assert.equal(instance.dynamicGroupsSupported.value, false);
  assert.equal(instance.largestLocation.value, null);
  assert.notStrictEqual(chainRef.current, previousChain);
});

test("resetSubscriberState does not touch status / statusMessage / isStopping", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("reset-state-2");
  instance.status.value = "connected";
  instance.statusMessage.value = "Subscribed to foo/bar";
  instance.isStopping.value = true;
  const chainRef = { current: Promise.resolve() };
  resetSubscriberState(instance, chainRef, () => false);
  assert.equal(instance.status.value, "connected");
  assert.equal(instance.statusMessage.value, "Subscribed to foo/bar");
  assert.equal(instance.isStopping.value, true);
});

test("resetSubscriberState re-enables settingsDisabled when no active subscriber/publisher", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("reset-state-3");
  settingsDisabled.value = true;
  const chainRef = { current: Promise.resolve() };
  resetSubscriberState(instance, chainRef, () => false);
  assert.equal(settingsDisabled.value, false);
});

test("resetSubscriberState keeps settingsDisabled when other publisher is active", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("reset-state-4");
  settingsDisabled.value = true;
  const chainRef = { current: Promise.resolve() };
  resetSubscriberState(instance, chainRef, () => true);
  assert.equal(settingsDisabled.value, true);
});

test("closeSubscriberResources sends catalog unsubscribe and clears the signal", () => {
  // 停止時に catalog 購読へ unsubscribe が送出されることの検証
  resetTestEnvironment();
  const instance = createSubscriberInstance("close-resources-catalog-1");
  const calls: FakeCallLog = [];
  instance.decoder.value = new RecordingDecoderWrapper({ label: "decoder.close", calls });
  instance.session.value = new FakeSession({ label: "session.close", calls });
  const catalogSubscriber = new FakeSubscriber({ label: "catalog.unsubscribe", calls });
  instance.catalogSubscriber.value = catalogSubscriber;

  closeSubscriberResources(instance, null);

  // unsubscribe が 1 回だけ呼ばれ、state が closed になる
  assert.equal(catalogSubscriber.state, "closed");
  assert.equal(instance.catalogSubscriber.value, null);
  // decoder → catalog → session の順で送出されること
  assert.deepEqual(calls, ["decoder.close", "catalog.unsubscribe", "session.close"]);
});

test("closeSubscriberResources tolerates repeated catalog cleanup", () => {
  // 二重停止でも例外なく終わることの検証
  resetTestEnvironment();
  const instance = createSubscriberInstance("close-resources-catalog-2");
  const calls: FakeCallLog = [];
  const catalogSubscriber = new FakeSubscriber({ label: "catalog.unsubscribe", calls });
  instance.catalogSubscriber.value = catalogSubscriber;

  closeSubscriberResources(instance, null);
  closeSubscriberResources(instance, null);

  // 2 回目は signal が null 化済みのため送出されない
  assert.deepEqual(calls, ["catalog.unsubscribe"]);
  assert.equal(instance.catalogSubscriber.value, null);
});

test("closeSubscriberResources swallows catalog unsubscribe failure", async () => {
  // unsubscribe 失敗を握り潰すことの検証 (session.close と同形)。
  // 失敗後も session.close が継続すること。
  // 拒否の捕捉を microtask の flush で待ってから検証する
  resetTestEnvironment();
  const instance = createSubscriberInstance("close-resources-catalog-3");
  const calls: FakeCallLog = [];
  instance.session.value = new FakeSession({ label: "session.close", calls });
  instance.catalogSubscriber.value = new FakeSubscriber({
    label: "catalog.unsubscribe",
    calls,
    unsubscribeError: new Error("unsubscribe failed"),
  });

  closeSubscriberResources(instance, null);
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(calls, ["catalog.unsubscribe", "session.close"]);
  assert.equal(instance.catalogSubscriber.value, null);
});
