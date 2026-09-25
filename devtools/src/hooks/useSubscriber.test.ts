import { test, assert } from "vite-plus/test";
import { LOC, createCatalog, getVideoTracks, type CatalogTrack, type MoqtObject } from "moqt-js";
import {
  buildVideoChunkPlan,
  buildVideoDecoderConfig,
  checkAborted,
  closeSubscriberResources,
  recordVideoReceived,
  resetSubscriberState,
  resetSubscriberStats,
  resolveAudioTrack,
  resolveNewGroupRequestValue,
  type ReceivedVideoObject,
} from "./useSubscriber";
import { AudioDecoderWrapper } from "../../../src/codec/AudioDecoder";
import { buildObjectSendPlan } from "./usePublisher";
import { EMPTY_PLAYBACK_TIMING, PlaybackTimingStats } from "../utils/playbackTimingStats";
import { GroupSwitchGate } from "../../../src/groupSwitchGate";
import { createSubscriberInstance, subscriberInstances } from "../signals/subscriber";
import { settingsDisabled } from "../signals/connectionSettings";
import {
  FakeSession,
  FakeSubscriber,
  RecordingAudioDecoderWrapper,
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

/**
 * 検証用の受信 Object を作る
 */
function makeVideoObject(objectId: bigint, properties?: Uint8Array): MoqtObject {
  return {
    groupId: 1n,
    objectId,
    status: 0,
    payload: new Uint8Array([0x01]),
    ...(properties === undefined ? {} : { properties }),
  };
}

// publisher が付与した LOC Properties を購読側が解釈できることを、
// 送信側 (buildObjectSendPlan) の出力をそのまま入力にして固定する。
// timestamp が EncodedVideoChunk に、I ビットがキーフレーム判定に伝わる。
// VIDEO_FRAME_MARKING がある場合はそれを優先する (Group 先頭の Object ID 0 でも
// isIndependent が delta と言えば delta)。逆方向 (Object ID が 0 以外かつ
// isIndependent が true) はライブラリ側のテストで固定する。
test("buildVideoChunkPlan: publisher が付与した Properties から chunk の type と timestamp を決める", () => {
  // publisher はフレームの timestamp を壁時計 (Unix epoch マイクロ秒) に換算して送る。
  // 約 1.79e15 は安全整数 (2^53 - 1) の範囲に収まり、Number にしても誤差が出ない
  const keyPlan = buildObjectSendPlan(
    { groupId: 0, objectId: 0 },
    { data: new Uint8Array([0x01]), type: "key", timestamp: 33_333, duration: 33_333 },
    1_790_263_445_135_432n,
  );
  assert.deepEqual(
    buildVideoChunkPlan(makeVideoObject(BigInt(keyPlan.objectId), keyPlan.properties)),
    { type: "key", timestamp: 1_790_263_445_135_432, timestampKind: "wallClock" },
  );

  // Group 先頭 (Object ID 0) でも Frame Marking が delta と言えば delta
  const deltaPlan = buildObjectSendPlan(
    { groupId: 1, objectId: 0 },
    { data: new Uint8Array([0x02]), type: "delta", timestamp: 66_666, duration: 33_333 },
    1_790_263_445_168_765n,
  );
  assert.deepEqual(
    buildVideoChunkPlan(makeVideoObject(BigInt(deltaPlan.objectId), deltaPlan.properties)),
    { type: "delta", timestamp: 1_790_263_445_168_765, timestampKind: "wallClock" },
  );
});

// draft-ietf-moq-loc-04 §2.3.2.2 / §2.2:
// LOC の拡張 (VIDEO_FRAME_MARKING) は任意であるため、無い場合は Group 先頭
// (Object ID 0) をキーフレームとして扱う。それ以外はデルタ。
test("buildVideoChunkPlan: Properties が無い / 空の Object は Object ID 0 を key にする", () => {
  assert.deepEqual(buildVideoChunkPlan(makeVideoObject(0n)), {
    type: "key",
    timestamp: 0,
    timestampKind: "none",
  });
  assert.deepEqual(buildVideoChunkPlan(makeVideoObject(0n, new Uint8Array())), {
    type: "key",
    timestamp: 0,
    timestampKind: "none",
  });
  assert.deepEqual(buildVideoChunkPlan(makeVideoObject(1n)), {
    type: "delta",
    timestamp: 0,
    timestampKind: "none",
  });
});

// TIMESTAMP だけを持つ Object も同じ規則で判定し、timestamp は Properties から取る
test("buildVideoChunkPlan: TIMESTAMP だけの Object は Object ID で type を判定する", () => {
  const properties = LOC.encodeVideoProperties({ timestamp: 1_000n });

  assert.deepEqual(buildVideoChunkPlan(makeVideoObject(0n, properties)), {
    type: "key",
    timestamp: 1_000,
    timestampKind: "wallClock",
  });
  assert.deepEqual(buildVideoChunkPlan(makeVideoObject(1n, properties)), {
    type: "delta",
    timestamp: 1_000,
    timestampKind: "wallClock",
  });
});

// draft-ietf-moq-loc-04 §2.3.1.2: Timescale がある TIMESTAMP は壁時計ではなくメディア時刻
// であり、送信から受信までの遅延を求めるのに使えない。再生時間の統計はこの区別で
// 遅延を求めるかを決める
test("buildVideoChunkPlan: Timescale がある TIMESTAMP はメディア時刻として区別する", () => {
  const properties = LOC.encodeVideoProperties({ timestamp: 90_000n, timescale: 90_000n });

  assert.equal(buildVideoChunkPlan(makeVideoObject(0n, properties)).timestampKind, "mediaTime");
});

// draft-ietf-moq-loc-04 §2.3.1.2: Timescale は 1 秒あたりの TIMESTAMP の単位数である。
// EncodedVideoChunk の timestamp はマイクロ秒のため、Timescale があれば換算する
// (音声とライブラリの createMediaSubscriber と同じ LOC.toDecoderMicroseconds を使う)
test("buildVideoChunkPlan: Timescale のある TIMESTAMP をマイクロ秒に換算する", () => {
  // 90 kHz で 3003 (約 33.4 ms) は 33,366 マイクロ秒 (0 方向に丸める)
  const properties = LOC.encodeVideoProperties({ timestamp: 3_003n, timescale: 90_000n });

  assert.equal(buildVideoChunkPlan(makeVideoObject(1n, properties)).timestamp, 33_366);
});

// ============================================================================
// 映像 Object の到着の記録
// ============================================================================

/**
 * 壁時計の TIMESTAMP (Unix epoch マイクロ秒) を持つ、Subgroup の stream で届いた
 * 映像 Object を作る
 */
function makeTimedVideoObject(
  groupId: bigint,
  objectId: bigint,
  timestampMicros: number,
): MoqtObject {
  return {
    groupId,
    subgroupId: 0n,
    objectId,
    status: 0,
    payload: new Uint8Array([0x01]),
    properties: LOC.encodeVideoProperties({ timestamp: BigInt(timestampMicros) }),
  };
}

// 前の Group の stream が開いている間に届いた次の Group の Object は保留され
// (GroupSwitchGate)、前の Group の stream の終わりで処理へ渡る。保留は受信側の処理で
// あり、経路の到着の遅れではないため、到着は保留に渡す前に、コールバックで受け取った
// 時刻で記録する。保留を解いた時刻で記録すると、保留した時間が到着の揺らぎと遅延に入る
test("recordVideoReceived: 保留に渡す前に、受け取った時刻で到着を記録する", () => {
  const gate = new GroupSwitchGate<ReceivedVideoObject>();
  const stats = new PlaybackTimingStats();
  // performance.timeOrigin に相当する壁時計 (ミリ秒)。送信側は 40 ms 前に撮っている
  const timeOriginMs = 1_790_263_445_000;
  const firstTimestampMicros = (timeOriginMs - 40) * 1_000;

  // useSubscriber の object コールバックと同じく、受け取った Object を記録してから保留へ渡す
  const receive = (object: MoqtObject, receivedAtMs: number): ReceivedVideoObject[] => {
    const received: ReceivedVideoObject = { object, receivedAtMs };
    recordVideoReceived(stats, received, timeOriginMs);
    return gate.push(received, object.groupId, object.subgroupId, receivedAtMs);
  };

  // Group 0 の先頭は 0 ms に受け取り、そのまま処理へ渡る
  receive(makeTimedVideoObject(0n, 0n, firstTimestampMicros), 0);

  // Group 1 の先頭は 1 フレーム (40 ms) 後に撮られ、40 ms に受け取る。Group 0 の stream が
  // 開いているため保留され、まだ処理へ渡らない
  const held = receive(makeTimedVideoObject(1n, 0n, firstTimestampMicros + 40_000), 40);
  assert.deepEqual(held, [], "Group 0 の stream が開いている間は保留すること");

  // 90 ms に Group 0 の stream が終わり、保留していた Group 1 の先頭が処理へ渡る
  const released = gate.endSubgroup(0n, 0n, 90);
  assert.equal(released.length, 1, "Group 0 の stream の終わりで保留を解くこと");

  // 2 つの Object はどちらも撮ってから 40 ms 後に受け取っており、到着の揺らぎは無い。
  // 保留を解いた 90 ms で記録すると、遅延の最大は 90 ms、揺らぎの最大は 50 ms になる
  const snapshot = stats.snapshot(90);
  assert.deepEqual(
    snapshot.latencyMs,
    { p50: 40, p95: 40, max: 40 },
    "遅延は受け取った時刻で求めること",
  );
  assert.deepEqual(
    snapshot.arrivalJitterMs,
    { p50: 0, p95: 0, max: 0 },
    "保留した時間を到着の揺らぎに含めないこと",
  );
});

// TIMESTAMP の無い Object はメディア時刻が分からないため到着を記録しないが、位置は記録し、
// 受信の欠け (届かなかった Object) を数える
test("recordVideoReceived: TIMESTAMP の無い Object は到着を記録せず、位置だけを記録する", () => {
  const stats = new PlaybackTimingStats();

  // 同じ Group の Object 0 と Object 2 を受け取る (Object 1 が届いていない)
  recordVideoReceived(stats, { object: makeVideoObject(0n), receivedAtMs: 0 }, 0);
  recordVideoReceived(stats, { object: makeVideoObject(2n), receivedAtMs: 10 }, 0);

  const snapshot = stats.snapshot(10);
  assert.isNull(snapshot.arrivalJitterMs, "到着を記録しないこと");
  assert.equal(snapshot.missingObjects, 1, "Object ID の飛びを届かなかった Object に数えること");
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
  instance.staleFramesDropped.value = 3;
  instance.missingReferenceFramesDropped.value = 4;
  instance.decodeErrors.value = 1;
  instance.largestLocation.value = { group: 5n, object: 11n };
  instance.playbackTiming.value = {
    ...EMPTY_PLAYBACK_TIMING,
    displayStalls: 3,
    displayQueueDrops: 2,
  };

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
  assert.equal(instance.staleFramesDropped.value, 0);
  assert.equal(instance.missingReferenceFramesDropped.value, 0);
  assert.equal(instance.decodeErrors.value, 0);
  assert.equal(instance.largestLocation.value, null);
  // 受信から表示までの時間の統計も前の購読の値を持ち越さない
  assert.deepEqual(instance.playbackTiming.value, EMPTY_PLAYBACK_TIMING);
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
  // 購読の確立を待っている途中で後始末する場合
  instance.isStarting.value = true;

  const chainRef = { current: Promise.resolve().then(() => {}) };
  const previousChain = chainRef.current;

  resetSubscriberState(
    instance,
    { video: chainRef, audio: { current: Promise.resolve() } },
    () => false,
  );

  assert.equal(instance.subscriber.value, null);
  assert.equal(instance.catalogSubscriber.value, null);
  assert.equal(instance.catalog.value, null);
  assert.equal(instance.decoder.value, null);
  assert.equal(instance.decoderConfigured.value, false);
  assert.equal(instance.codec.value, "");
  assert.equal(instance.dynamicGroupsSupported.value, false);
  assert.equal(instance.largestLocation.value, null);
  // 確立を待っていた購読も終わり、Start Subscribing を押せる状態に戻る
  assert.equal(instance.isStarting.value, false);
  assert.notStrictEqual(chainRef.current, previousChain);
});

test("resetSubscriberState does not touch status / statusMessage / isStopping", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("reset-state-2");
  instance.status.value = "connected";
  instance.statusMessage.value = "Subscribed to foo/bar";
  instance.isStopping.value = true;
  const chainRef = { current: Promise.resolve() };
  resetSubscriberState(
    instance,
    { video: chainRef, audio: { current: Promise.resolve() } },
    () => false,
  );
  assert.equal(instance.status.value, "connected");
  assert.equal(instance.statusMessage.value, "Subscribed to foo/bar");
  assert.equal(instance.isStopping.value, true);
});

test("resetSubscriberState re-enables settingsDisabled when no active subscriber/publisher", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("reset-state-3");
  settingsDisabled.value = true;
  const chainRef = { current: Promise.resolve() };
  resetSubscriberState(
    instance,
    { video: chainRef, audio: { current: Promise.resolve() } },
    () => false,
  );
  assert.equal(settingsDisabled.value, false);
});

test("resetSubscriberState keeps settingsDisabled when other publisher is active", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("reset-state-4");
  settingsDisabled.value = true;
  const chainRef = { current: Promise.resolve() };
  resetSubscriberState(
    instance,
    { video: chainRef, audio: { current: Promise.resolve() } },
    () => true,
  );
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

// ============================================================================
// 音声トラックの購読
// ============================================================================

// 音声トラックを持たない catalog (映像だけを広告する publisher) では音声の購読を
// 開始しない。この分岐で throw すると映像の視聴まで止まるため、undefined を返す。
test("resolveAudioTrack: 音声トラックを持たない catalog では undefined を返す", () => {
  const catalog = createCatalog([makeCatalogTrack()]);
  assert.equal(resolveAudioTrack(catalog), undefined);
});

test("resolveAudioTrack: catalog の音声トラックを返す", () => {
  const catalog = createCatalog([
    makeCatalogTrack(),
    makeCatalogTrack({ name: "audio", role: "audio", codec: "opus" }),
  ]);

  const audioTrack = resolveAudioTrack(catalog);
  assert.equal(audioTrack?.name, "audio");
  assert.equal(audioTrack?.codec, "opus");
});

test("closeSubscriberResources: 音声デコーダを閉じ、音声トラックの購読を解除する", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("close-resources-audio-1");
  const calls: FakeCallLog = [];
  instance.decoder.value = new RecordingDecoderWrapper({ label: "decoder.close", calls });
  instance.session.value = new FakeSession({ label: "session.close", calls });
  instance.catalogSubscriber.value = new FakeSubscriber({ label: "catalog.unsubscribe", calls });
  const audioSubscriber = new FakeSubscriber({ label: "audio.unsubscribe", calls });
  instance.audioSubscriber.value = audioSubscriber;
  instance.audioDecoder.value = new RecordingAudioDecoderWrapper({
    label: "audioDecoder.close",
    calls,
  });
  instance.audioDecoderConfigured.value = true;

  closeSubscriberResources(instance, null);

  assert.equal(audioSubscriber.state, "closed");
  assert.equal(instance.audioSubscriber.value, null);
  assert.equal(instance.audioDecoder.value, null);
  assert.equal(instance.audioDecoderConfigured.value, false);
  // decoder → audioDecoder → catalog → audio → session の順で送出されること
  assert.deepEqual(calls, [
    "decoder.close",
    "audioDecoder.close",
    "catalog.unsubscribe",
    "audio.unsubscribe",
    "session.close",
  ]);
});

test("closeSubscriberResources: 音声の後始末を二重に呼んでも例外にならない", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("close-resources-audio-2");
  const calls: FakeCallLog = [];
  instance.audioSubscriber.value = new FakeSubscriber({ label: "audio.unsubscribe", calls });

  closeSubscriberResources(instance, null);
  closeSubscriberResources(instance, null);

  assert.deepEqual(calls, ["audio.unsubscribe"]);
  assert.equal(instance.audioSubscriber.value, null);
});

// 受信数・デコード数・最終レベルは購読のたびに 0 / null へ戻す。
// 前回の値が残ると E2E が「増えた」ことを判定できない。
test("resetSubscriberStats: 音声の統計と最終レベルを初期化する", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("reset-stats-audio-1");
  instance.audioObjectsReceived.value = 10;
  instance.audioChunksDecoded.value = 10;
  instance.audioLastLevel.value = { level: 14, voiceActivity: true };
  instance.audioPeakDbfs.value = -6;
  instance.audioRmsDbfs.value = -9;
  instance.audioWaveform.value = new Float32Array([1, 2, 3]);

  resetSubscriberStats(instance);

  assert.equal(instance.audioObjectsReceived.value, 0);
  assert.equal(instance.audioChunksDecoded.value, 0);
  assert.equal(instance.audioLastLevel.value, null);
  assert.equal(instance.audioPeakDbfs.value, null);
  assert.equal(instance.audioRmsDbfs.value, null);
  assert.equal(instance.audioWaveform.value, null);
});

test("resetSubscriberState: 音声の signal を初期化し再生を無効にする", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("reset-state-audio-1");
  instance.audioSubscriber.value = new FakeSubscriber();
  instance.audioDecoder.value = new AudioDecoderWrapper(false, {
    output: () => {},
    error: () => {},
  });
  instance.audioDecoderConfigured.value = true;
  instance.audioLastLevel.value = { level: 14, voiceActivity: true };
  instance.audioPlaybackEnabled.value = true;
  instance.audioPeakDbfs.value = -6;
  instance.audioRmsDbfs.value = -9;
  instance.audioWaveform.value = new Float32Array([1, 2, 3]);

  resetSubscriberState(
    instance,
    { video: { current: Promise.resolve() }, audio: { current: Promise.resolve() } },
    () => false,
  );

  assert.equal(instance.audioSubscriber.value, null);
  assert.equal(instance.audioDecoder.value, null);
  assert.equal(instance.audioDecoderConfigured.value, false);
  assert.equal(instance.audioLastLevel.value, null);
  assert.equal(instance.audioPlaybackEnabled.value, false);
  assert.equal(instance.audioPeakDbfs.value, null);
  assert.equal(instance.audioRmsDbfs.value, null);
  assert.equal(instance.audioWaveform.value, null);
});

// 停止後に前のセッションの音声 object 処理が残ると、signal を書き戻したり
// 閉じた decoder を再生成したりするため、チェーンも巻き戻す
test("resetSubscriberState: 音声 object の処理チェーンを巻き戻す", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("reset-state-audio-2");
  const chainRef = { current: Promise.resolve() };
  const audioChainRef = { current: Promise.resolve().then(() => {}) };
  const previousAudioChain = audioChainRef.current;

  resetSubscriberState(instance, { video: chainRef, audio: audioChainRef }, () => false);

  assert.notStrictEqual(audioChainRef.current, previousAudioChain);
});
