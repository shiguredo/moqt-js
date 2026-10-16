import { test, assert } from "vite-plus/test";
import {
  LOC,
  createCatalog,
  getVideoTracks,
  type CatalogTrack,
  type MoqtObject,
  type Property,
  PublishDoneStatusCode,
} from "moqt-js";
import {
  buildVideoChunkPlan,
  buildVideoDecoderConfig,
  checkAborted,
  createAttemptGuard,
  closeSubscriberResources,
  recordVideoReceived,
  rememberDecodeInput,
  resetSubscriberState,
  resetSubscriberStats,
  resolveAudioTrack,
  resolveCatalogMediaTracks,
  resolveEventTimelineTrack,
  applyCatchUpPending,
  applySubscribedStatus,
  applyTrackEnd,
  canApplyStatusUpdate,
  formatTrackEndText,
  handleTrackEnd,
  logPublishDoneEnd,
  refreshTrackEndStatus,
  resolveTrackEndState,
  subscribedStatusMessage,
  type DecodeInput,
  type ReceivedVideoObject,
} from "./useSubscriber";
import { AudioDecoderWrapper } from "../../../src/codec/AudioDecoder";
import { buildObjectSendPlan } from "./usePublisher";
import { EMPTY_PLAYOUT_TIMING, PlayoutTimingStats } from "../utils/playoutTimingStats";
import { EMPTY_AUDIO_PLAYOUT_TIMING } from "../../../src/playout/audioPlayoutTimingStats";
import { GroupSwitchGate } from "../../../src/groupSwitchGate";
import { CatchUpGate } from "../../../src/catchUpGate";
import { createSubscriberInstance, subscriberInstances } from "../signals/subscriber";
import { __resetLogStateForTest, getLogBuffer } from "../signals/debugLog";
import * as pub from "../signals/publisher";
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

// 購読を始めるたびに AbortController を作り直す。登録した回のコールバックは、その回の
// AbortController が今のものである間だけ今の購読のものである。停止した購読の session の
// close は、次の購読を始めた後に届くことがあり、次の購読を後始末してはならない
test("createAttemptGuard: 登録した回の AbortController が今のものである間だけ真を返す", () => {
  const first = new AbortController();
  const ref: { current: AbortController | null } = { current: first };
  const isFirstCurrent = createAttemptGuard(ref, first.signal);
  assert.isTrue(isFirstCurrent());

  // 次の購読を始めた (AbortController を作り直した)
  const second = new AbortController();
  ref.current = second;
  assert.isFalse(isFirstCurrent());
  assert.isTrue(createAttemptGuard(ref, second.signal)());

  // 後始末で null になった
  ref.current = null;
  assert.isFalse(isFirstCurrent());
});

// 中断しただけでは替わっていない。今の回の session が閉じたときは後始末する
test("createAttemptGuard: 中断した AbortController でも今のものなら真を返す", () => {
  const controller = new AbortController();
  const ref: { current: AbortController | null } = { current: controller };
  controller.abort();
  assert.isTrue(createAttemptGuard(ref, controller.signal)());
});

function resetTestEnvironment(): void {
  subscriberInstances.value = new Map();
  settingsDisabled.value = false;
  // resetSubscriberState は Publisher が接続設定を使っているか (pub.hasActivePublisher) も読む。
  // Publisher は配信していない状態から始める
  pub.pubSession.value = null;
  pub.isStarting.value = false;
}

/**
 * 検証用の CatalogTrack を作る
 *
 * CatalogTrack は name / packaging / isLive が必須のため既定値を置き、
 * 検証に必要なフィールドだけをテストから上書きする。role の既定は video
 * (購読側は getVideoTracks で role === "video" のトラックを取り出す)。
 *
 * `createCatalog` は生成の時点で track 単位の MUST を検証するため、role=video / audio の
 * §5.2.18 codec / §5.2.22 bitrate と、role=audio の §5.2.28 samplerate / §5.2.29
 * channelConfig を既定で補う。§5.2.28 / §5.2.29 の条件は role ではなく codec (audio codec) で
 * あるため、audio codec を持つ track を role=audio 以外で作る場合は samplerate と
 * channelConfig を overrides で明示すること。テストが必要とする値は overrides で上書きする。
 */
function makeCatalogTrack(overrides: Partial<CatalogTrack> = {}): CatalogTrack {
  const track: CatalogTrack = {
    name: "video",
    packaging: "loc",
    isLive: true,
    role: "video",
    ...overrides,
  };
  if (track.role === "video") {
    track.codec ??= "vp8";
    track.bitrate ??= 1_000_000;
  } else if (track.role === "audio") {
    track.codec ??= "opus";
    track.bitrate ??= 128_000;
    track.samplerate ??= 48_000;
    track.channelConfig ??= "2";
  }
  return track;
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
  // codec は makeCatalogTrack の既定値 (vp8) を使う
  const { catalog, track } = makeCatalogWithTrack(makeCatalogTrack());

  const config = buildVideoDecoderConfig(track, catalog);

  assert.equal("codedWidth" in config, false);
  assert.equal("codedHeight" in config, false);
});

// codec が無い Catalog では Decoder を設定できない。
// 空の codec 文字列で VideoDecoder.configure を呼ぶ前に失敗させる。
// role が video の track は §5.2.18 が codec を MUST とするため Catalog の生成時
// (`createCatalog`) に拒否される。ここでは生成を通った Catalog と、codec を持たない
// track を直接渡し、購読側の防御を固定する。
test("buildVideoDecoderConfig: codec が無いトラックは例外にする", () => {
  const { catalog, track } = makeCatalogWithTrack(makeCatalogTrack());
  const trackWithoutCodec: CatalogTrack = { ...track };
  delete trackWithoutCodec.codec;

  assert.throws(
    () => buildVideoDecoderConfig(trackWithoutCodec, catalog),
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
    buildVideoChunkPlan(undefined, makeVideoObject(BigInt(keyPlan.objectId), keyPlan.properties)),
    { type: "key", timestamp: 1_790_263_445_135_432, timestampKind: "wallClock" },
  );

  // Group 先頭 (Object ID 0) でも Frame Marking が delta と言えば delta
  const deltaPlan = buildObjectSendPlan(
    { groupId: 1, objectId: 0 },
    { data: new Uint8Array([0x02]), type: "delta", timestamp: 66_666, duration: 33_333 },
    1_790_263_445_168_765n,
  );
  assert.deepEqual(
    buildVideoChunkPlan(
      undefined,
      makeVideoObject(BigInt(deltaPlan.objectId), deltaPlan.properties),
    ),
    { type: "delta", timestamp: 1_790_263_445_168_765, timestampKind: "wallClock" },
  );
});

// draft-ietf-moq-loc-04 §2.3.2.2 / §2.2:
// LOC の拡張 (VIDEO_FRAME_MARKING) は任意であるため、無い場合は Group 先頭
// (Object ID 0) をキーフレームとして扱う。それ以外はデルタ。
test("buildVideoChunkPlan: Properties が無い / 空の Object は Object ID 0 を key にする", () => {
  assert.deepEqual(buildVideoChunkPlan(undefined, makeVideoObject(0n)), {
    type: "key",
    timestamp: 0,
    timestampKind: "none",
  });
  assert.deepEqual(buildVideoChunkPlan(undefined, makeVideoObject(0n, new Uint8Array())), {
    type: "key",
    timestamp: 0,
    timestampKind: "none",
  });
  assert.deepEqual(buildVideoChunkPlan(undefined, makeVideoObject(1n)), {
    type: "delta",
    timestamp: 0,
    timestampKind: "none",
  });
});

// TIMESTAMP だけを持つ Object も同じ規則で判定し、timestamp は Properties から取る
test("buildVideoChunkPlan: TIMESTAMP だけの Object は Object ID で type を判定する", () => {
  const properties = LOC.encodeVideoProperties({ timestamp: 1_000n });

  assert.deepEqual(buildVideoChunkPlan(undefined, makeVideoObject(0n, properties)), {
    type: "key",
    timestamp: 1_000,
    timestampKind: "wallClock",
  });
  assert.deepEqual(buildVideoChunkPlan(undefined, makeVideoObject(1n, properties)), {
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

  assert.equal(
    buildVideoChunkPlan(undefined, makeVideoObject(0n, properties)).timestampKind,
    "mediaTime",
  );
});

// draft-ietf-moq-loc-04 §2.3.1.2: Timescale は 1 秒あたりの TIMESTAMP の単位数である。
// EncodedVideoChunk の timestamp はマイクロ秒のため、Timescale があれば換算する
// (音声とライブラリの createMediaSubscriber と同じ LOC.toDecoderMicroseconds を使う)
test("buildVideoChunkPlan: Timescale のある TIMESTAMP をマイクロ秒に換算する", () => {
  // 90 kHz で 3003 (約 33.4 ms) は 33,366 マイクロ秒 (0 方向に丸める)
  const properties = LOC.encodeVideoProperties({ timestamp: 3_003n, timescale: 90_000n });

  assert.equal(buildVideoChunkPlan(undefined, makeVideoObject(1n, properties)).timestamp, 33_366);
});

// draft-ietf-moq-loc-04 §2.3.1.2 / Table 1: TIMESCALE は Track と Object の両方に置ける。
// Track に TIMESCALE を載せる publisher では、Object の TIMESTAMP もメディア時刻である。
// Track を見ずに壁時計と判定すると、送信から受信までの遅延と表示時刻が無効な値になる
test("buildVideoChunkPlan: Track の TIMESCALE があるときはメディア時刻として扱う", () => {
  const trackProperties: Property[] = [{ id: LOC.LOCPropertyId.TIMESCALE, value: 90_000n }];
  // Object は TIMESTAMP だけを持ち、TIMESCALE を持たない
  const objectProperties = LOC.encodeVideoProperties({ timestamp: 3_003n });

  const plan = buildVideoChunkPlan(trackProperties, makeVideoObject(1n, objectProperties));

  // 種類はメディア時刻になり、Track の TIMESCALE でマイクロ秒へ換算する
  assert.equal(plan.timestampKind, "mediaTime");
  assert.equal(plan.timestamp, 33_366);

  // Object も TIMESCALE を持つときは Object を優先する (resolveVideoProperties と同じ規則)
  const bothProperties = LOC.encodeVideoProperties({ timestamp: 48_000n, timescale: 48_000n });
  const withObjectTimescale = buildVideoChunkPlan(
    trackProperties,
    makeVideoObject(1n, bothProperties),
  );
  assert.equal(withObjectTimescale.timestampKind, "mediaTime");
  assert.equal(withObjectTimescale.timestamp, 1_000_000);
});

// ============================================================================
// 復号へ渡した Object の情報 (位置と TIMESTAMP の種類、入力の遅れ)
// ============================================================================

test("rememberDecodeInput: TIMESTAMP の種類と位置と入力の遅れを覚える", () => {
  // 復号の出力では Object の位置が分からないため、decoder へ渡した TIMESTAMP で引く。
  // 入力の遅れ (Object の到着 - LOC TIMESTAMP) も一緒に覚え、復号の出力で引いて
  // 受信側の追いつきへ渡す (src/playout/audioReceiveCatchUp.ts)
  const inputs = new Map<number, DecodeInput>();
  rememberDecodeInput(inputs, 1_000, {
    timestampKind: "wallClock",
    location: { group: 5n, object: 3n },
    inputLagMs: 25,
  });
  assert.deepEqual(inputs.get(1_000), {
    timestampKind: "wallClock",
    location: { group: 5n, object: 3n },
    inputLagMs: 25,
  });
});

test("rememberDecodeInput: 入力の遅れが測れないときは null で覚える", () => {
  // Timescale がある TIMESTAMP はメディア時刻であり、壁時計と対応しないため測れない。
  // 復号の出力では入力の遅れが無いものとして扱い、出力の遅れだけを使う
  const inputs = new Map<number, DecodeInput>();
  rememberDecodeInput(inputs, 1_000, {
    timestampKind: "mediaTime",
    location: { group: 5n, object: 3n },
    inputLagMs: null,
  });
  assert.deepEqual(inputs.get(1_000), {
    timestampKind: "mediaTime",
    location: { group: 5n, object: 3n },
    inputLagMs: null,
  });
});

test("rememberDecodeInput: TIMESTAMP を持たない Object は覚えない", () => {
  // TIMESTAMP が無い Object はすべて同じ TIMESTAMP (0) を共有するため、位置を一意に引けない。
  // 復号の出力では位置が分からないものとして扱い、境界の判定をせずに描く・鳴らす
  const inputs = new Map<number, DecodeInput>();
  rememberDecodeInput(inputs, 0, {
    timestampKind: "none",
    location: { group: 5n, object: 3n },
    inputLagMs: null,
  });
  assert.isFalse(inputs.has(0), "TIMESTAMP を持たない Object の位置を覚えた");
});

test("rememberDecodeInput: 同じ TIMESTAMP の Object が重なったら、その TIMESTAMP の分を忘れる", () => {
  // 同じ TIMESTAMP の Object が 2 つあるとき、復号の出力がどちらの位置かは決められない。
  // 先に覚えていた分も忘れ、どちらも位置が分からないものとして扱う。入力の遅れも同じ理由で
  // 一緒に忘れる (別の音の遅れを引かない)
  const inputs = new Map<number, DecodeInput>();
  rememberDecodeInput(inputs, 1_000, {
    timestampKind: "mediaTime",
    location: { group: 1n, object: 1n },
    inputLagMs: 25,
  });
  rememberDecodeInput(inputs, 1_000, {
    timestampKind: "mediaTime",
    location: { group: 1n, object: 2n },
    inputLagMs: 30,
  });
  assert.isFalse(inputs.has(1_000), "同じ TIMESTAMP の位置を覚えたままにした");
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
  const stats = new PlayoutTimingStats();
  // performance.timeOrigin に相当する壁時計 (ミリ秒)。送信側は 40 ms 前に撮っている
  const timeOriginMs = 1_790_263_445_000;
  const firstTimestampMicros = (timeOriginMs - 40) * 1_000;

  // useSubscriber の object コールバックと同じく、受け取った Object を記録してから保留へ渡す
  const receive = (object: MoqtObject, receivedAtMs: number): ReceivedVideoObject[] => {
    const received: ReceivedVideoObject = { object, receivedAtMs };
    recordVideoReceived(stats, received, timeOriginMs, undefined);
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
  const stats = new PlayoutTimingStats();

  // 同じ Group の Object 0 と Object 2 を受け取る (Object 1 が届いていない)
  recordVideoReceived(stats, { object: makeVideoObject(0n), receivedAtMs: 0 }, 0, undefined);
  recordVideoReceived(stats, { object: makeVideoObject(2n), receivedAtMs: 10 }, 0, undefined);

  const snapshot = stats.snapshot(10);
  assert.isNull(snapshot.arrivalJitterMs, "到着を記録しないこと");
  assert.equal(snapshot.missingObjects, 1, "Object ID の飛びを届かなかった Object に数えること");
});

// REQUEST_UPDATE に載せる NEW_GROUP_REQUEST の値 (購読で受信した最大 Location と
// LARGEST_OBJECT の大きい方 + 1) は、ライブラリの resolveNewGroupRequestValue に
// 委譲する。判定は src/createMediaSubscriber.test.ts の resolveNewGroupRequestValue が
// 固定し、devtools 側は Subscriber.largestReceivedLocation をそのまま渡す。
// largestReceivedLocation が受信で進むことは src/subscriber.test.ts が固定する

// ============================================================================
// 購読開始時の統計リセット
// ============================================================================

// startSubscribing は購読開始時に前回の統計を初期化する。
// リセット漏れがあると再接続後に古い値が表示され続ける。受信数・デコード数・最終レベル・
// 鳴らし方の数も購読のたびに 0 / null へ戻す (前回の値が残ると E2E が「増えた」ことを
// 判定できない)。映像系と音声系を 1 つのテストでまとめて確かめる
test("resetSubscriberStats: 映像と音声の統計を初期値へ戻す", () => {
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
  instance.catchUpFramesSkipped.value = 4;
  instance.staleFramesDropped.value = 3;
  instance.missingReferenceFramesDropped.value = 4;
  instance.decodeErrors.value = 1;
  instance.largestLocation.value = { group: 5n, object: 11n };
  instance.playoutTiming.value = {
    ...EMPTY_PLAYOUT_TIMING,
    displayStalls: 3,
    displayQueueDrops: 2,
  };
  instance.audioObjectsReceived.value = 10;
  instance.audioDatagramObjectsReceived.value = 4;
  instance.audioChunksDecoded.value = 10;
  instance.audioLastLevel.value = { level: 14, voiceActivity: true };
  instance.audioPeakDbfsLeft.value = -6;
  instance.audioRmsDbfsLeft.value = -9;
  instance.audioPeakDbfsRight.value = -7;
  instance.audioRmsDbfsRight.value = -10;
  instance.audioWaveformLeft.value = new Float32Array([1, 2, 3]);
  instance.audioWaveformRight.value = new Float32Array([4, 5, 6]);
  instance.audioPlayoutRebases.value = 2;
  instance.audioPlayoutDrops.value = 3;
  // 鳴らすと決めた音の観測値も、前の購読の値を持ち越さない
  instance.audioPlayoutTiming.value = {
    ...EMPTY_AUDIO_PLAYOUT_TIMING,
    lastArrivalMs: 100,
    playedFrames: 5,
    playedMs: 100,
    missedFrames: 1,
    missedMs: 20,
  };
  instance.audioCatchUpObjectsSkipped.value = 5;

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
  assert.equal(instance.catchUpFramesSkipped.value, 0);
  assert.equal(instance.staleFramesDropped.value, 0);
  assert.equal(instance.missingReferenceFramesDropped.value, 0);
  assert.equal(instance.decodeErrors.value, 0);
  assert.equal(instance.largestLocation.value, null);
  // 受信から表示までの時間の統計も前の購読の値を持ち越さない
  assert.deepEqual(instance.playoutTiming.value, EMPTY_PLAYOUT_TIMING);
  assert.equal(instance.audioObjectsReceived.value, 0);
  assert.equal(instance.audioDatagramObjectsReceived.value, 0);
  assert.equal(instance.audioChunksDecoded.value, 0);
  assert.equal(instance.audioLastLevel.value, null);
  assert.equal(instance.audioPeakDbfsLeft.value, null);
  assert.equal(instance.audioRmsDbfsLeft.value, null);
  assert.equal(instance.audioPeakDbfsRight.value, null);
  assert.equal(instance.audioRmsDbfsRight.value, null);
  assert.equal(instance.audioWaveformLeft.value, null);
  assert.equal(instance.audioWaveformRight.value, null);
  assert.equal(instance.audioPlayoutRebases.value, 0);
  assert.equal(instance.audioPlayoutDrops.value, 0);
  assert.deepEqual(instance.audioPlayoutTiming.value, EMPTY_AUDIO_PLAYOUT_TIMING);
  assert.equal(instance.audioCatchUpObjectsSkipped.value, 0);
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
  instance.httpVersion.value = "H3";
  instance.largestLocation.value = { group: 1n, object: 1n };
  // relay の cache から追いつく途中の表示
  instance.catchUpPending.value = true;
  // 購読の確立を待っている途中で後始末する場合
  instance.isStarting.value = true;
  // 接続設定を使っているのは、この Subscriber だけ
  subscriberInstances.value = new Map([[instance.id, instance]]);
  settingsDisabled.value = true;

  const chainRef = { current: Promise.resolve().then(() => {}) };
  const previousChain = chainRef.current;
  instance.videoTrackEnd.value = {
    isError: false,
    statusLabel: "TRACK_ENDED (0x2)",
    reasonPhrase: "",
  };
  instance.audioTrackEnd.value = {
    isError: true,
    statusLabel: "INTERNAL_ERROR (0x0)",
    reasonPhrase: "",
  };
  const trackEndWasSet =
    instance.videoTrackEnd.value !== null && instance.audioTrackEnd.value !== null;

  resetSubscriberState(instance, { video: chainRef, audio: { current: Promise.resolve() } });

  assert.equal(instance.subscriber.value, null);
  assert.equal(instance.catalogSubscriber.value, null);
  assert.equal(instance.catalog.value, null);
  assert.equal(instance.decoder.value, null);
  assert.equal(instance.decoderConfigured.value, false);
  assert.equal(instance.codec.value, "");
  assert.equal(instance.dynamicGroupsSupported.value, false);
  assert.equal(instance.httpVersion.value, null);
  assert.equal(instance.largestLocation.value, null);
  // 確立を待っていた購読も終わり、Start Subscribing を押せる状態に戻る
  assert.equal(instance.isStarting.value, false);
  assert.equal(instance.catchUpPending.value, false);
  // トラックの終了状態も購読が無い状態に戻す (次の購読へ持ち越さない)
  assert.equal(instance.videoTrackEnd.value, null);
  assert.equal(instance.audioTrackEnd.value, null);
  // 初期値から始めるとリセットを消しても通るため、終了した状態から戻すことを確かめる
  assert.isTrue(trackEndWasSet);
  assert.notStrictEqual(chainRef.current, previousChain);
  // subscriber と isStarting を下ろしてから判定するため、止めたインスタンス自身は数えない。
  // 他に接続設定を使っているものが無いので、入力を有効に戻す
  assert.equal(settingsDisabled.value, false);
});

test("resetSubscriberState does not touch status / statusMessage / isStopping", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("reset-state-2");
  instance.status.value = "connected";
  instance.statusMessage.value = "Subscribed to foo/bar";
  instance.isStopping.value = true;
  const chainRef = { current: Promise.resolve() };
  resetSubscriberState(instance, { video: chainRef, audio: { current: Promise.resolve() } });
  assert.equal(instance.status.value, "connected");
  assert.equal(instance.statusMessage.value, "Subscribed to foo/bar");
  assert.equal(instance.isStopping.value, true);
});

// 接続設定の入力を有効に戻すかの判定 (settingsDisabled) は resetSubscriberState の PBT が、
// 止めるインスタンス、他の Subscriber、Publisher がそれぞれ開始の途中かどうかの組み合わせで固定する

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

// catalog から購読する映像トラックと音声トラックを取り出す。MSF の catalog は映像トラックを
// 必須としないため、音声だけの catalog も購読できる。どちらも無い catalog は購読できない
test("resolveCatalogMediaTracks: 映像と音声の両方を持つ catalog では両方を返す", () => {
  const catalog = createCatalog([
    makeCatalogTrack(),
    makeCatalogTrack({ name: "audio", role: "audio", codec: "opus" }),
  ]);

  const tracks = resolveCatalogMediaTracks(catalog);
  assert.equal(tracks.video?.name, "video");
  assert.equal(tracks.audio?.name, "audio");
});

test("resolveCatalogMediaTracks: 映像だけの catalog では音声を undefined にする", () => {
  const catalog = createCatalog([makeCatalogTrack()]);

  const tracks = resolveCatalogMediaTracks(catalog);
  assert.equal(tracks.video?.name, "video");
  assert.equal(tracks.audio, undefined);
});

test("resolveCatalogMediaTracks: 音声だけの catalog では映像を undefined にし、音声を返す", () => {
  const catalog = createCatalog([
    makeCatalogTrack({ name: "audio", role: "audio", codec: "opus" }),
  ]);

  const tracks = resolveCatalogMediaTracks(catalog);
  assert.equal(tracks.video, undefined);
  assert.equal(tracks.audio?.name, "audio");
});

test("resolveCatalogMediaTracks: 映像も音声も無い catalog では throw する", () => {
  const catalog = createCatalog([]);

  assert.throws(() => resolveCatalogMediaTracks(catalog), /no video or audio track in catalog/);
});

// ============================================================================
// Catalog からの event timeline トラックの解決
// ============================================================================

// devtools は audio / video 以外のデータを流す例として、packaging が eventtimeline の
// トラックを購読する (draft-ietf-moq-msf-01 §5.2.4)。event timeline を広告しない
// publisher では購読しない
test("resolveEventTimelineTrack: eventtimeline のトラックを返す", () => {
  const catalog = createCatalog([
    makeCatalogTrack(),
    makeCatalogTrack({
      name: "events",
      packaging: "eventtimeline",
      role: "eventtimeline",
      eventType: "com.example.chat",
      mimeType: "application/json",
      depends: ["video"],
    }),
  ]);

  const eventTrack = resolveEventTimelineTrack(catalog);
  assert.equal(eventTrack?.name, "events");
  assert.equal(eventTrack?.eventType, "com.example.chat");
});

test("resolveEventTimelineTrack: eventtimeline のトラックが無ければ undefined を返す", () => {
  const catalog = createCatalog([makeCatalogTrack()]);

  assert.equal(resolveEventTimelineTrack(catalog), undefined);
});

test("resolveEventTimelineTrack: 最初の eventtimeline のトラックだけを返す", () => {
  const catalog = createCatalog([
    makeCatalogTrack({
      name: "events-1",
      packaging: "eventtimeline",
      role: "eventtimeline",
      eventType: "com.example.first",
      mimeType: "application/json",
      depends: ["video"],
    }),
    makeCatalogTrack({
      name: "events-2",
      packaging: "eventtimeline",
      role: "eventtimeline",
      eventType: "com.example.second",
      mimeType: "application/json",
      depends: ["video"],
    }),
  ]);

  assert.equal(resolveEventTimelineTrack(catalog)?.name, "events-1");
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
  const eventSubscriber = new FakeSubscriber({ label: "event.unsubscribe", calls });
  instance.eventSubscriber.value = eventSubscriber;

  closeSubscriberResources(instance, null);

  assert.equal(audioSubscriber.state, "closed");
  assert.equal(instance.audioSubscriber.value, null);
  assert.equal(instance.audioDecoder.value, null);
  assert.equal(instance.audioDecoderConfigured.value, false);
  assert.equal(eventSubscriber.state, "closed");
  assert.equal(instance.eventSubscriber.value, null);
  // decoder → audioDecoder → catalog → audio → event → session の順で送出されること
  assert.deepEqual(calls, [
    "decoder.close",
    "audioDecoder.close",
    "catalog.unsubscribe",
    "audio.unsubscribe",
    "event.unsubscribe",
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
  instance.audioPeakDbfsLeft.value = -6;
  instance.audioRmsDbfsLeft.value = -9;
  instance.audioPeakDbfsRight.value = -7;
  instance.audioRmsDbfsRight.value = -10;
  instance.audioWaveformLeft.value = new Float32Array([1, 2, 3]);
  instance.audioWaveformRight.value = new Float32Array([4, 5, 6]);
  instance.eventSubscriber.value = new FakeSubscriber();
  instance.eventObjectsReceived.value = 3;
  instance.eventMessages.value = [{ t: 1000, data: { text: "hello" } }];

  resetSubscriberState(instance, {
    video: { current: Promise.resolve() },
    audio: { current: Promise.resolve() },
  });

  assert.equal(instance.audioSubscriber.value, null);
  assert.equal(instance.audioDecoder.value, null);
  assert.equal(instance.audioDecoderConfigured.value, false);
  assert.equal(instance.audioLastLevel.value, null);
  assert.equal(instance.audioPlaybackEnabled.value, false);
  assert.equal(instance.audioPeakDbfsLeft.value, null);
  assert.equal(instance.audioRmsDbfsLeft.value, null);
  assert.equal(instance.audioPeakDbfsRight.value, null);
  assert.equal(instance.audioRmsDbfsRight.value, null);
  assert.equal(instance.audioWaveformLeft.value, null);
  assert.equal(instance.audioWaveformRight.value, null);
  // event timeline の購読とメッセージも初期化する
  assert.equal(instance.eventSubscriber.value, null);
  assert.equal(instance.eventObjectsReceived.value, 0);
  assert.deepEqual(instance.eventMessages.value, []);
});

// 停止後に前のセッションの音声 object 処理が残ると、signal を書き戻したり
// 閉じた decoder を再生成したりするため、チェーンも巻き戻す
test("resetSubscriberState: 音声 object の処理チェーンを巻き戻す", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("reset-state-audio-2");
  const chainRef = { current: Promise.resolve() };
  const audioChainRef = { current: Promise.resolve().then(() => {}) };
  const previousAudioChain = audioChainRef.current;

  resetSubscriberState(instance, { video: chainRef, audio: audioChainRef });

  assert.notStrictEqual(audioChainRef.current, previousAudioChain);
});

// 音声の再生を止めたとき (stopAudioPlayback) に共有の時間軸から音声の状態を消すことは、
// ここでは固定できない。stopAudioPlayback は useSubscriber の中の閉じた関数であり、
// AudioContext を作るため、ブラウザ API を持たないこのテスト環境からは呼べない (実物の
// 代わりになるものを置くこともできない)。時間軸側の規則は src/playout/timeline.test.ts の
// resetStream のテストが、再生の遅れの下限の適用は src/createMediaSubscriber.test.ts の
// 「音声を観測していなくても再生の遅れが下限を下回らない」が固定する

// ============================================================================
// logPublishDoneEnd
// ============================================================================

/**
 * draft-ietf-moq-transport-22 §9.9 (PUBLISH_DONE) / §12.4 (Publish Done Codes):
 * 終了の記録はエラー status かどうかでレベルを分ける。判定は表示
 * (applySubscribedStatus) と同じ resolveTrackEndState を使い、判定源を増やさない。
 */
test("logPublishDoneEnd: 正常な終わりは info、エラー status は error で理由を記録する", () => {
  __resetLogStateForTest();
  logPublishDoneEnd("sub-1", "video stream ended", {
    statusCode: PublishDoneStatusCode.TRACK_ENDED,
    reasonPhrase: "",
  });
  logPublishDoneEnd("sub-1", "video stream ended", {
    statusCode: PublishDoneStatusCode.MALFORMED_TRACK,
    reasonPhrase: "bad track",
  });

  const entries = getLogBuffer();
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.level, "info");
  assert.equal(entries[0]?.message, "[sub-1] video stream ended");
  assert.deepEqual(entries[0]?.data, { statusCode: "TRACK_ENDED (0x2)", reasonPhrase: "" });
  assert.equal(entries[1]?.level, "error");
  assert.deepEqual(entries[1]?.data, {
    statusCode: "MALFORMED_TRACK (0x12)",
    reasonPhrase: "bad track",
  });
});

// ============================================================================
// トラックの終了 (PUBLISH_DONE)
// ============================================================================

/**
 * draft-ietf-moq-transport-22 §9.9 (PUBLISH_DONE) / §12.4 (Publish Done Codes):
 * 終了の理由 (Status Code と Reason Phrase) をトラックごとの状態にする。
 */
test("resolveTrackEndState: Status Code と Reason Phrase を終了状態にする", () => {
  assert.deepEqual(
    resolveTrackEndState({ statusCode: PublishDoneStatusCode.TRACK_ENDED, reasonPhrase: "bye" }),
    { isError: false, statusLabel: "TRACK_ENDED (0x2)", reasonPhrase: "bye" },
  );
  assert.deepEqual(
    resolveTrackEndState({ statusCode: PublishDoneStatusCode.MALFORMED_TRACK, reasonPhrase: "" }),
    { isError: true, statusLabel: "MALFORMED_TRACK (0x12)", reasonPhrase: "" },
  );
});

/**
 * 完了条件: トラック 1 本の終了で、他のトラックの状態は変わらない。
 * draft-ietf-moq-transport-22 §3.1 / §9.9: PUBLISH_DONE はトラック単位の購読の終了であり、
 * 他のトラックの購読とセッションは維持する。
 */
test("applyTrackEnd: 終わったトラックだけを終了にし、他のトラックの状態は変えない", () => {
  const instance = createSubscriberInstance("track-end-1");
  assert.isNull(instance.videoTrackEnd.value);
  assert.isNull(instance.audioTrackEnd.value);

  applyTrackEnd(instance, "video", {
    statusCode: PublishDoneStatusCode.TRACK_ENDED,
    reasonPhrase: "",
  });

  assert.deepEqual(instance.videoTrackEnd.value, {
    isError: false,
    statusLabel: "TRACK_ENDED (0x2)",
    reasonPhrase: "",
  });
  // 映像が終わっても、音声は生きている扱いのままにする
  assert.isNull(instance.audioTrackEnd.value);

  applyTrackEnd(instance, "audio", {
    statusCode: PublishDoneStatusCode.MALFORMED_TRACK,
    reasonPhrase: "bad track",
  });

  assert.deepEqual(instance.audioTrackEnd.value, {
    isError: true,
    statusLabel: "MALFORMED_TRACK (0x12)",
    reasonPhrase: "bad track",
  });
  // 後から終わったトラックが、先に終わったトラックの状態を書き換えない
  assert.deepEqual(instance.videoTrackEnd.value, {
    isError: false,
    statusLabel: "TRACK_ENDED (0x2)",
    reasonPhrase: "",
  });
});

test("formatTrackEndText: 終了したトラックと理由を並べる", () => {
  // 終わったトラックが無ければ文言に足さない
  assert.equal(formatTrackEndText(null, null), "");
  assert.equal(
    formatTrackEndText(null, {
      isError: false,
      statusLabel: "TRACK_ENDED (0x2)",
      reasonPhrase: "",
    }),
    "video ended: TRACK_ENDED (0x2)",
  );
  assert.equal(
    formatTrackEndText(
      { isError: true, statusLabel: "MALFORMED_TRACK (0x12)", reasonPhrase: "bad track" },
      { isError: false, statusLabel: "TRACK_ENDED (0x2)", reasonPhrase: "" },
    ),
    "audio ended with error: MALFORMED_TRACK (0x12): bad track, video ended: TRACK_ENDED (0x2)",
  );
});

/**
 * 完了条件: 終わったトラックの状態が表示され、購読とセッションは維持される。
 * status は connected のままとし (購読は生きている)、文言で終了したトラックと理由を示す。
 * 後始末をしないため、最後のフレームと再生はそのまま残る。
 */
test("refreshTrackEndStatus: 購読を維持したまま、終了したトラックと理由を表示する", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("track-end-2");
  instance.session.value = new FakeSession();
  instance.status.value = "connected";
  instance.statusMessage.value = "Subscribed";

  applyTrackEnd(instance, "video", {
    statusCode: PublishDoneStatusCode.TRACK_ENDED,
    reasonPhrase: "",
  });
  refreshTrackEndStatus(instance);

  assert.equal(instance.status.value, "connected");
  assert.equal(instance.statusMessage.value, "video ended: TRACK_ENDED (0x2)");
  // 後始末をしていない (session が残る)
  assert.isNotNull(instance.session.value);
});

test("refreshTrackEndStatus: エラーを示す Status Code で終わったトラックがあれば error の表示にする", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("track-end-3");
  instance.session.value = new FakeSession();
  instance.status.value = "connected";

  applyTrackEnd(instance, "audio", {
    statusCode: PublishDoneStatusCode.INTERNAL_ERROR,
    reasonPhrase: "internal",
  });
  refreshTrackEndStatus(instance);

  assert.equal(instance.status.value, "error");
  assert.equal(
    instance.statusMessage.value,
    "audio ended with error: INTERNAL_ERROR (0x0): internal",
  );
});

test("refreshTrackEndStatus: 停止中と後始末の後では表示を上書きしない", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("track-end-4");
  instance.session.value = new FakeSession();
  instance.status.value = "connected";
  instance.statusMessage.value = "Subscribed";

  // 停止処理中 (stopSubscribing 進行中) は上書きしない
  instance.isStopping.value = true;
  applyTrackEnd(instance, "video", {
    statusCode: PublishDoneStatusCode.TRACK_ENDED,
    reasonPhrase: "",
  });
  refreshTrackEndStatus(instance);
  assert.equal(instance.statusMessage.value, "Subscribed");
  assert.isFalse(canApplyStatusUpdate(instance));

  // 後始末を通った後 (session が null) も上書きしない
  instance.isStopping.value = false;
  instance.session.value = null;
  refreshTrackEndStatus(instance);
  assert.equal(instance.statusMessage.value, "Subscribed");
  assert.isFalse(canApplyStatusUpdate(instance));

  // 表示を戻せる状態では上書きする
  instance.session.value = new FakeSession();
  assert.isTrue(canApplyStatusUpdate(instance));
  refreshTrackEndStatus(instance);
  assert.equal(instance.statusMessage.value, "video ended: TRACK_ENDED (0x2)");
});

/**
 * 完了条件: 購読の確立とトラックの終了が前後しても、終了の表示が消えない。
 * 確立時の文言を「Subscribed」に固定すると、先に終わったトラックの表示を上書きしてしまう。
 */
test("subscribedStatusMessage: 終了したトラックがあれば理由も足す", () => {
  const instance = createSubscriberInstance("track-end-6");
  assert.equal(subscribedStatusMessage(instance), "Subscribed");

  applyTrackEnd(instance, "video", {
    statusCode: PublishDoneStatusCode.TRACK_ENDED,
    reasonPhrase: "bye",
  });

  assert.equal(subscribedStatusMessage(instance), "video ended: TRACK_ENDED (0x2): bye");
});

/**
 * 完了条件: 購読中のトラックが PUBLISH_DONE で正常に終わっても、他のトラックの購読と subscriber
 * のセッションが維持される。
 * draft-ietf-moq-transport-22 §9.9 (PUBLISH_DONE) の終了はトラック単位であり、セッションは
 * 明示的に閉じるまで維持する (§6.6 Termination)。後始末をすると、無関係な購読とセッションまで
 * 道連れになり、relay の切り分けで誤った結論を導く。
 */
test("handleTrackEnd: 映像の終了でセッションも他のトラックの購読も後始末しない", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("track-end-7");
  const session = new FakeSession();
  const subscriber = new FakeSubscriber();
  const catalogSubscriber = new FakeSubscriber();
  const audioSubscriber = new FakeSubscriber();
  instance.session.value = session;
  instance.subscriber.value = subscriber;
  instance.catalogSubscriber.value = catalogSubscriber;
  instance.audioSubscriber.value = audioSubscriber;
  instance.status.value = "connected";
  instance.statusMessage.value = "Subscribed";

  // 映像は relay の cache に追いつく途中、音声は購読の時点で Object が無く追いつき済み
  const gates = { video: new CatchUpGate(), audio: new CatchUpGate() };
  gates.video.setBoundary({ group: 5n, object: 0n });
  gates.audio.setBoundary(null);
  instance.catchUpPending.value = true;

  __resetLogStateForTest();
  const handled = handleTrackEnd(
    instance,
    "video",
    { statusCode: PublishDoneStatusCode.TRACK_ENDED, reasonPhrase: "" },
    gates,
    () => true,
  );

  assert.isTrue(handled);
  // セッションと他のトラックの購読は維持する (後始末をしない)
  assert.equal(instance.session.value, session);
  assert.equal(instance.subscriber.value, subscriber);
  assert.equal(instance.catalogSubscriber.value, catalogSubscriber);
  assert.equal(instance.audioSubscriber.value, audioSubscriber);
  assert.isFalse(instance.isStopping.value);
  // 終わったトラックだけが「終了」になり、表示に理由が出る
  assert.equal(instance.videoTrackEnd.value?.statusLabel, "TRACK_ENDED (0x2)");
  assert.isNull(instance.audioTrackEnd.value);
  assert.equal(instance.status.value, "connected");
  assert.equal(instance.statusMessage.value, "video ended: TRACK_ENDED (0x2)");
  // 終わったトラックには境界を越える Object が来ないため、追いつきの表示を残さない
  assert.isTrue(gates.video.catchUpCompleted);
  assert.isFalse(instance.catchUpPending.value);
  // Debug パネルにも理由を残す
  const [entry] = getLogBuffer();
  assert.equal(entry?.level, "info");
  assert.equal(entry?.message, "[track-end-7] video stream ended");
  assert.deepEqual(entry?.data, { statusCode: "TRACK_ENDED (0x2)", reasonPhrase: "" });
});

test("handleTrackEnd: 停止した購読の終了では何もしない", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("track-end-8");
  instance.session.value = new FakeSession();
  instance.status.value = "connected";
  instance.statusMessage.value = "Subscribed";
  const gates = { video: new CatchUpGate(), audio: new CatchUpGate() };
  gates.video.setBoundary({ group: 5n, object: 0n });

  // 停止した購読のコールバックは、次の購読の signal に触らない
  __resetLogStateForTest();
  const handled = handleTrackEnd(
    instance,
    "video",
    { statusCode: PublishDoneStatusCode.TRACK_ENDED, reasonPhrase: "" },
    gates,
    () => false,
  );

  assert.isFalse(handled);
  assert.isNull(instance.videoTrackEnd.value);
  assert.equal(instance.statusMessage.value, "Subscribed");
  // 停止した購読に遅れて届いた終了も Debug パネルのイベントとしては残す
  const [entry] = getLogBuffer();
  assert.equal(entry?.message, "[track-end-8] video stream ended");
  // 次の購読の追いつきの境界も触らない
  assert.isFalse(gates.video.catchUpCompleted);
});

test("handleTrackEnd: 両方のトラックが終わったら両方の理由を表示する", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("track-end-9");
  instance.session.value = new FakeSession();
  const gates = { video: new CatchUpGate(), audio: new CatchUpGate() };
  gates.video.setBoundary(null);
  gates.audio.setBoundary(null);

  __resetLogStateForTest();
  handleTrackEnd(
    instance,
    "video",
    { statusCode: PublishDoneStatusCode.TRACK_ENDED, reasonPhrase: "" },
    gates,
    () => true,
  );
  handleTrackEnd(
    instance,
    "audio",
    { statusCode: PublishDoneStatusCode.MALFORMED_TRACK, reasonPhrase: "bad track" },
    gates,
    () => true,
  );

  assert.equal(
    instance.statusMessage.value,
    "audio ended with error: MALFORMED_TRACK (0x12): bad track, video ended: TRACK_ENDED (0x2)",
  );
  // エラーを示す Status Code のトラックがあるため、パネルもエラーの表示にする
  assert.equal(instance.status.value, "error");
});

test("applyTrackEnd: 同じトラックを 2 回終わらせたら後の状態にする", () => {
  const instance = createSubscriberInstance("track-end-10");

  applyTrackEnd(instance, "video", {
    statusCode: PublishDoneStatusCode.TRACK_ENDED,
    reasonPhrase: "",
  });
  applyTrackEnd(instance, "video", {
    statusCode: PublishDoneStatusCode.INTERNAL_ERROR,
    reasonPhrase: "internal",
  });

  assert.deepEqual(instance.videoTrackEnd.value, {
    isError: true,
    statusLabel: "INTERNAL_ERROR (0x0)",
    reasonPhrase: "internal",
  });
});

/**
 * 完了条件: 購読の確立とトラックの終了が前後しても、終了の表示が消えない。
 * 確立時に status を connected に固定すると、先にエラーで終わったトラックの表示を消してしまう。
 */
test("applySubscribedStatus: エラーで終わったトラックがあれば error の表示を保つ", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("track-end-11");
  instance.session.value = new FakeSession();

  applyTrackEnd(instance, "audio", {
    statusCode: PublishDoneStatusCode.EXCESSIVE_LOAD,
    reasonPhrase: "loaded",
  });
  applySubscribedStatus(instance);

  assert.equal(instance.status.value, "error");
  assert.equal(
    instance.statusMessage.value,
    "audio ended with error: EXCESSIVE_LOAD (0x9): loaded",
  );
});

/**
 * 完了条件: 終わったトラックで「Catching up」が残らない。
 * SUBSCRIBE_OK と PUBLISH_DONE が同じチャンクで届くと、終了の後に境界が設定される
 * (src/session/bidi.ts)。終了の時点で畳むだけでは足りないため、表示の判定でも終わった
 * トラックを完了として扱う。
 */
test("applyCatchUpPending: 終了したトラックは境界が後から来ても追いつき中にしない", () => {
  const instance = createSubscriberInstance("track-end-12");
  const gates = { video: new CatchUpGate(), audio: new CatchUpGate() };
  gates.audio.setBoundary(null);
  // 追いつき中から始め、終了を考慮しない実装でも通らないようにする
  instance.catchUpPending.value = true;
  applyTrackEnd(instance, "video", {
    statusCode: PublishDoneStatusCode.TRACK_ENDED,
    reasonPhrase: "",
  });

  // 終了の後に映像の境界が設定される (購読の確立の継続で setBoundary が走る)
  gates.video.setBoundary({ group: 5n, object: 0n });
  applyCatchUpPending(instance, gates);

  assert.isFalse(gates.video.catchUpCompleted);
  assert.isFalse(instance.catchUpPending.value);
});

/**
 * 映像だけの購読 (catalog に音声が無い) では音声の境界を設定しない。境界の無いトラックは
 * 完了として扱う (CatchUpGate.reset) ため、購読しないトラックが「Catching up」を残さない。
 */
test("applyCatchUpPending: 境界を設定しないトラックは追いつき中にしない", () => {
  const instance = createSubscriberInstance("track-end-15");
  const gates = { video: new CatchUpGate(), audio: new CatchUpGate() };
  gates.video.setBoundary({ group: 5n, object: 0n });

  // 映像が境界を越えて追いつく
  gates.video.evaluate({ group: 6n, object: 0n });
  applyCatchUpPending(instance, gates);

  assert.isTrue(gates.video.catchUpCompleted);
  assert.isFalse(instance.catchUpPending.value);
});

test("applyCatchUpPending: 生きているトラックが追いつき中なら追いつき中にする", () => {
  const instance = createSubscriberInstance("track-end-13");
  const gates = { video: new CatchUpGate(), audio: new CatchUpGate() };
  // 音声の境界を越えた後に映像の境界を設定する (映像だけが追いつき中)
  gates.audio.setBoundary({ group: 5n, object: 0n });
  gates.audio.evaluate({ group: 6n, object: 0n });
  gates.video.setBoundary({ group: 5n, object: 0n });

  applyCatchUpPending(instance, gates);

  assert.isTrue(gates.audio.catchUpCompleted);
  assert.isFalse(gates.video.catchUpCompleted);
  assert.isTrue(instance.catchUpPending.value);
});

test("handleTrackEnd: 停止処理中は表示を変えず、終了状態とログを残す", () => {
  resetTestEnvironment();
  const instance = createSubscriberInstance("track-end-14");
  instance.session.value = new FakeSession();
  instance.status.value = "connected";
  instance.statusMessage.value = "Subscribed";
  instance.isStopping.value = true;
  const gates = { video: new CatchUpGate(), audio: new CatchUpGate() };
  gates.video.setBoundary(null);
  __resetLogStateForTest();

  const handled = handleTrackEnd(
    instance,
    "video",
    { statusCode: PublishDoneStatusCode.TRACK_ENDED, reasonPhrase: "" },
    gates,
    () => true,
  );

  assert.isTrue(handled);
  // 表示は stopSubscribing 側の責務のため、終了では上書きしない
  assert.equal(instance.statusMessage.value, "Subscribed");
  // 状態とログは残す
  assert.equal(instance.videoTrackEnd.value?.statusLabel, "TRACK_ENDED (0x2)");
  assert.equal(getLogBuffer()[0]?.message, "[track-end-14] video stream ended");
});
