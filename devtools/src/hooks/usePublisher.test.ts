import { test, assert } from "vite-plus/test";
import { LOC, decodeCatalogMessage, encodeCatalog } from "moqt-js";
import {
  buildObjectSendPlan,
  buildPublisherCatalog,
  buildPublisherCatalogOptions,
  buildPublisherCatalogOptionsFromSettings,
  resolveAudioConfigToSend,
  resolveAudioPublishable,
  shouldRequestKeyFrame,
  decideKeyFrame,
  usePublisher,
} from "./usePublisher";
import type { PublisherAudioCatalogOptions, PublisherVideoCatalogOptions } from "./usePublisher";
import { getAudioEncoderConfig } from "../../../src/codec/config";
import { getEncoderConfig } from "../utils/codec";
import type { EncodedChunkData } from "../utils/EncoderWrapper";
import type { CodecType } from "../types";
import * as pub from "../signals/publisher";
import * as settings from "../signals/connectionSettings";
import { createSubscriberInstance, subscriberInstances } from "../signals/subscriber";

// 映像設定の既定値 (devtools/src/signals/connectionSettings.ts) に合わせた検証用の値。
// 実際の UI から渡る値と同じ組み合わせで Catalog を組み立てる。
const VIDEO_WIDTH = 1280;
const VIDEO_HEIGHT = 720;
const VIDEO_FRAMERATE = 30;
const VIDEO_BITRATE = 2_000_000;

// キーフレーム間隔の既定値 (devtools/src/signals/publisher.ts の keyframeInterval)
const DEFAULT_KEYFRAME_INTERVAL = 60;

// 検証対象の全 codec。catalog の codec 文字列は getEncoderConfig と一致していなければ
// 購読側が Decoder を設定できない (Catalog 誤記がそのまま配信不能になる)。
const ALL_CODECS: CodecType[] = ["vp8", "vp9", "av1", "h264", "h265"];

// 壁時計に換算した TIMESTAMP (2026-09-25 付近、Unix epoch マイクロ秒)。換算は呼び出し側
// (src/mediaClock.ts の WallClockMapper) が行い、buildObjectSendPlan はそのまま載せる
const TEST_WALL_CLOCK_MICROS = 1_790_263_445_102_099n;

/**
 * 検証用のエンコード済み chunk を作る
 *
 * WebCodecs の EncodedVideoChunk は Node の vitest では生成できないため、
 * EncoderWrapper の output コールバックが受け取る形 (EncodedChunkData) を直接組み立てる。
 */
function makeChunk(options: {
  type: "key" | "delta";
  timestamp: number;
  description?: Uint8Array;
}): EncodedChunkData {
  return {
    data: new Uint8Array([0x10, 0x20, 0x30]),
    type: options.type,
    timestamp: options.timestamp,
    duration: 33_333,
    ...(options.description !== undefined ? { description: options.description } : {}),
  };
}

/**
 * Publisher の signal をテスト開始時の状態に戻す
 *
 * signal はモジュールスコープで共有されるため、テスト間で状態が持ち越されないよう
 * 各テストの先頭でリセットする。
 */
function resetPublisherSignals(): void {
  pub.pubSession.value = null;
  pub.publisher.value = null;
  pub.catalogPublisher.value = null;
  pub.catalog.value = null;
  pub.encoder.value = null;
  pub.mediaStream.value = null;
  pub.isPreviewActive.value = false;
  pub.isStopping.value = false;
  pub.isStarting.value = false;
  pub.forwardState.value = null;
  pub.httpVersion.value = null;
  pub.pubStatus.value = "disconnected";
  pub.pubStatusMessage.value = "Ready to publish";
  pub.pubCodec.value = "";
  pub.framesEncoded.value = 0;
  pub.keyFramesEncoded.value = 0;
  pub.objectsSent.value = 0;
  pub.pubCurrentGroup.value = Date.now();
  pub.bytesSent.value = 0;
  pub.chunksEncoded.value = 0;
  pub.encodeErrors.value = 0;
  pub.encoderState.value = "unconfigured";
  pub.objectsWithExtensions.value = 0;
  pub.frameReader.value = null;
  pub.videoStreamCleanup.value = null;
  pub.keyframeInterval.value = DEFAULT_KEYFRAME_INTERVAL;
  pub.pubCurrentObjectId.value = 0;
  // 音声の signal も初期化する (テスト間で状態を持ち越さない)
  pub.audioPublisher.value = null;
  pub.audioEncoder.value = null;
  pub.audioStream.value = null;
  pub.audioStreamCleanup.value = null;
  pub.audioFrameReader.value = null;
  pub.pubCurrentAudioGroup.value = 0;
  pub.pubAudioGroupStarted.value = false;
  pub.lastSentAudioConfig.value = null;
  pub.audioConfigResendRequested.value = false;
}

// ============================================================================
// Catalog 生成
// ============================================================================

// Catalog は購読側が Decoder を設定する唯一の情報源であるため、
// 設定値がトラックの各フィールドに反映されることを固定する。
test("buildPublisherCatalog: 設定値が video トラックのフィールドに反映される", () => {
  const catalog = buildPublisherCatalog({
    video: {
      trackName: "video",
      codec: "vp8",
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      framerate: VIDEO_FRAMERATE,
      bitrate: VIDEO_BITRATE,
    },
  });

  // 映像トラック 1 件だけを持つ full catalog になる
  assert.equal(catalog.tracks.length, 1);
  const [track] = catalog.tracks;
  if (track === undefined) {
    // 上の length 検証により到達しない (型を絞るためのガード)
    throw new Error("expected exactly one track");
  }

  // LOC パッケージングの live な映像トラックとして宣言する (draft-ietf-moq-msf-01 §5.2)
  assert.equal(track.name, "video");
  assert.equal(track.packaging, "loc");
  assert.equal(track.isLive, true);
  assert.equal(track.role, "video");

  // 解像度・フレームレート・ビットレートは設定値がそのまま載る
  assert.equal(track.codec, "vp8");
  assert.equal(track.width, VIDEO_WIDTH);
  assert.equal(track.height, VIDEO_HEIGHT);
  assert.equal(track.framerate, VIDEO_FRAMERATE);
  assert.equal(track.bitrate, VIDEO_BITRATE);
});

// Catalog の codec 文字列と Encoder に渡す codec 文字列がずれると、
// 購読側は自分の Encoder 出力を復号できなくなる。
// 対応表を二重管理せず getEncoderConfig と一致することを固定する。
test("buildPublisherCatalog: codec は getEncoderConfig と同じ対応表から解決する", () => {
  for (const codec of ALL_CODECS) {
    const catalog = buildPublisherCatalog({
      video: {
        trackName: "video",
        codec,
        width: 640,
        height: 480,
        framerate: VIDEO_FRAMERATE,
        bitrate: 1_000_000,
      },
    });

    const [track] = catalog.tracks;
    if (track === undefined) {
      throw new Error("expected exactly one track");
    }

    // getEncoderConfig の codec 文字列 (vp8 / vp09.00.10.08 / av01.0.04M.08 /
    // avc1.42001f / hvc1.1.6.L93.B0) と一致する
    assert.equal(track.codec, getEncoderConfig(codec, 640, 480, 1_000_000, 30).codec);
  }
});

// publisher は生成した Catalog を encodeCatalog で送るため、
// 送信したバイト列を購読側が decodeCatalogMessage で読み戻せることを固定する
// (draft-ietf-moq-msf-01 §5.1 の wire format との往復)。
test("buildPublisherCatalog: encodeCatalog で送信した Catalog を decodeCatalogMessage で読み戻せる", () => {
  const catalog = buildPublisherCatalog({
    video: {
      trackName: "video",
      codec: "h264",
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      framerate: VIDEO_FRAMERATE,
      bitrate: VIDEO_BITRATE,
    },
  });

  const encoded = encodeCatalog(catalog);
  assert.ok(encoded.length > 0);

  const decoded = decodeCatalogMessage(encoded);
  // delta update ではなく full catalog が返る
  if (!("version" in decoded)) {
    throw new Error("expected a full catalog, got a delta update");
  }
  assert.deepEqual(decoded, catalog);
});

// ============================================================================
// Object の送信計画 (Group / Object ID の採番)
// ============================================================================

// キーフレームは新しい Group の先頭 Object になる (draft-ietf-moq-msf-01 §6.1)。
// ここが崩れると購読側が Group の切れ目を検出できない。
test("buildObjectSendPlan: キーフレームは新しい Group を開始し Object ID を 0 に戻す", () => {
  const plan = buildObjectSendPlan(
    { groupId: 1000, objectId: 5 },
    makeChunk({ type: "key", timestamp: 0 }),
    TEST_WALL_CLOCK_MICROS + 0n,
  );

  assert.equal(plan.isKeyFrame, true);
  assert.equal(plan.groupId, 1001);
  assert.equal(plan.objectId, 0);
  // 次に送る Object は同じ Group の Object ID 1
  assert.equal(plan.nextGroupId, 1001);
  assert.equal(plan.nextObjectId, 1);
});

// デルタフレームは直前のキーフレームと同じ Group の続きになる。
// Object ID は Group 内で単調増加する。
test("buildObjectSendPlan: デルタフレームは同じ Group の続きとして Object ID を進める", () => {
  const first = buildObjectSendPlan(
    { groupId: 1001, objectId: 0 },
    makeChunk({ type: "delta", timestamp: 33_333 }),
    TEST_WALL_CLOCK_MICROS + 33_333n,
  );
  assert.equal(first.isKeyFrame, false);
  assert.equal(first.groupId, 1001);
  assert.equal(first.objectId, 0);
  assert.equal(first.nextGroupId, 1001);
  assert.equal(first.nextObjectId, 1);

  // 返された次の位置をそのまま渡すと連番になる (handleEncodedChunk と同じ使い方)
  const second = buildObjectSendPlan(
    { groupId: first.nextGroupId, objectId: first.nextObjectId },
    makeChunk({ type: "delta", timestamp: 66_666 }),
    TEST_WALL_CLOCK_MICROS + 66_666n,
  );
  assert.equal(second.groupId, 1001);
  assert.equal(second.objectId, 1);
  assert.equal(second.nextObjectId, 2);
});

// キーフレームは即時配送を優先し、デルタフレームは既定優先度にする。
// draft-ietf-moq-transport-21 §5.1.1: 数値が小さいほど高優先であるため、
// 優先度を入れ替えると滞留時にキーフレームが捨てられる。
test("buildObjectSendPlan: キーフレームは優先度 0、デルタフレームは 128 にする", () => {
  const keyPlan = buildObjectSendPlan(
    { groupId: 0, objectId: 0 },
    makeChunk({ type: "key", timestamp: 0 }),
    TEST_WALL_CLOCK_MICROS + 0n,
  );
  assert.equal(keyPlan.priority, 0);

  const deltaPlan = buildObjectSendPlan(
    { groupId: 1, objectId: 0 },
    makeChunk({ type: "delta", timestamp: 33_333 }),
    TEST_WALL_CLOCK_MICROS + 33_333n,
  );
  assert.equal(deltaPlan.priority, 128);
});

// ============================================================================
// LOC Properties (draft-ietf-moq-loc-04 §2.3.2)
// ============================================================================

// 購読側は TIMESTAMP を EncodedVideoChunk の timestamp に、VIDEO_FRAME_MARKING が
// あればその I ビットを、無ければ Group 先頭 (Object ID 0) をキーフレーム判定に使う。
// 送信した Properties がそのまま読み戻せることを固定する。
// draft-ietf-moq-loc-04 §2.3.1.1: Timescale を載せない TIMESTAMP は Unix epoch の
// マイクロ秒 (壁時計) であるため、壁時計に換算した値をそのまま載せる
test("buildObjectSendPlan: LOC Properties に timestamp とキーフレーム判定を載せる", () => {
  const keyPlan = buildObjectSendPlan(
    { groupId: 0, objectId: 0 },
    makeChunk({ type: "key", timestamp: 33_333 }),
    TEST_WALL_CLOCK_MICROS + 33_333n,
  );
  const keyProperties = LOC.decodeVideoProperties(keyPlan.properties);

  assert.equal(keyProperties.timestamp, TEST_WALL_CLOCK_MICROS + 33_333n);
  assert.ok(keyProperties.frameMarking);
  assert.equal(keyProperties.frameMarking.isIndependent, true);
  // isDiscardable は WebCodecs が破棄可能性を提供しないため false 固定 (RFC 9626 §3.1 D)
  assert.equal(keyProperties.frameMarking.isDiscardable, false);
  // temporalLayerId=0 では B (isBaseLayerSync) がワイヤ上 0 に抑圧される (RFC 9626 §3.1)
  assert.equal(keyProperties.frameMarking.isBaseLayerSync, false);
  assert.equal(keyProperties.frameMarking.temporalLayerId, 0);
  assert.equal(keyProperties.frameMarking.spatialLayerId, 0);

  const deltaPlan = buildObjectSendPlan(
    { groupId: 1, objectId: 0 },
    makeChunk({ type: "delta", timestamp: 66_666 }),
    TEST_WALL_CLOCK_MICROS + 66_666n,
  );
  const deltaProperties = LOC.decodeVideoProperties(deltaPlan.properties);

  assert.equal(deltaProperties.timestamp, TEST_WALL_CLOCK_MICROS + 66_666n);
  assert.ok(deltaProperties.frameMarking);
  assert.equal(deltaProperties.frameMarking.isIndependent, false);
});

// canonical 形式 (avc1 / hvc1) では WebCodecs が返す description (Video Config) が
// 復号に必須になる。annexB 形式では description が無いため何も載せない。
test("buildObjectSendPlan: description があるときだけ Video Config を載せる", () => {
  // avcC を模した 4 バイトの description
  const description = new Uint8Array([0x01, 0x64, 0x00, 0x1f]);

  const withConfig = buildObjectSendPlan(
    { groupId: 0, objectId: 0 },
    makeChunk({ type: "key", timestamp: 0, description }),
    TEST_WALL_CLOCK_MICROS + 0n,
  );
  const withConfigProperties = LOC.decodeVideoProperties(withConfig.properties);
  assert.ok(withConfigProperties.config !== undefined);
  assert.deepEqual(Array.from(withConfigProperties.config), Array.from(description));

  const withoutConfig = buildObjectSendPlan(
    { groupId: 1, objectId: 0 },
    makeChunk({ type: "delta", timestamp: 33_333 }),
    TEST_WALL_CLOCK_MICROS + 33_333n,
  );
  assert.equal(LOC.decodeVideoProperties(withoutConfig.properties).config, undefined);
});

// payload は WebCodecs の internal data をコピーせずそのまま送る
// (コピーするとフレームあたりのメモリ帯域が増える)。
test("buildObjectSendPlan: payload は chunk の data をそのまま使う", () => {
  const chunk = makeChunk({ type: "key", timestamp: 0 });
  const plan = buildObjectSendPlan({ groupId: 0, objectId: 0 }, chunk, TEST_WALL_CLOCK_MICROS);

  assert.strictEqual(plan.payload, chunk.data);
});

// ============================================================================
// キーフレーム要求の間隔
// ============================================================================

// 先頭フレームと keyframeInterval フレームごとにキーフレームを要求する。
// 間隔を無視して全フレームをキーフレームにすると帯域を浪費し、
// 要求が一度も出ないと購読開始時に復号を始められない。
// NEW_GROUP_REQUEST (draft-ietf-moq-transport-21 §9.20.20) を受けたら、次に符号化するフレームを
// キーフレームにして新しい Group を始め、そこから keyframeInterval を数え直す。
// 次のフレームまでに複数の要求が届いても、キーフレームは 1 枚にまとまる
test("decideKeyFrame: 要求を受けると次のフレームをキーフレームにし、そこから間隔を数え直す", () => {
  const interval = 5;
  // 3 枚目の符号化の前に要求を受けたとする (要求は次のキーフレームで消える)
  const requestedBefore = new Set([3]);
  const keyFrames: boolean[] = [];
  let framesSinceKeyFrame = 0;
  let requested = false;
  for (let frame = 0; frame < 12; frame++) {
    if (requestedBefore.has(frame)) {
      requested = true;
    }
    const decision = decideKeyFrame(framesSinceKeyFrame, interval, requested);
    keyFrames.push(decision.keyFrame);
    framesSinceKeyFrame = decision.nextFramesSinceKeyFrame;
    if (decision.keyFrame) {
      requested = false;
    }
  }
  // 0 枚目 (先頭)、3 枚目 (要求)、そこから 5 枚ごと (8 枚目) がキーフレーム
  assert.deepEqual(
    keyFrames.map((keyFrame, frame) => (keyFrame ? frame : -1)).filter((frame) => frame >= 0),
    [0, 3, 8],
  );
});

test("decideKeyFrame: 要求が無ければ keyframeInterval ごとにキーフレームにする", () => {
  assert.deepEqual(decideKeyFrame(0, 60, false), { keyFrame: true, nextFramesSinceKeyFrame: 1 });
  assert.deepEqual(decideKeyFrame(1, 60, false), { keyFrame: false, nextFramesSinceKeyFrame: 2 });
  assert.deepEqual(decideKeyFrame(60, 60, false), { keyFrame: true, nextFramesSinceKeyFrame: 1 });
  // 要求があれば間隔の途中でもキーフレームにする
  assert.deepEqual(decideKeyFrame(7, 60, true), { keyFrame: true, nextFramesSinceKeyFrame: 1 });
});

test("shouldRequestKeyFrame: 先頭フレームと keyframeInterval ごとに true になる", () => {
  assert.equal(shouldRequestKeyFrame(0, DEFAULT_KEYFRAME_INTERVAL), true);
  assert.equal(shouldRequestKeyFrame(DEFAULT_KEYFRAME_INTERVAL, DEFAULT_KEYFRAME_INTERVAL), true);
  assert.equal(
    shouldRequestKeyFrame(DEFAULT_KEYFRAME_INTERVAL * 2, DEFAULT_KEYFRAME_INTERVAL),
    true,
  );

  // 間隔の途中はキーフレームを要求しない
  assert.equal(shouldRequestKeyFrame(1, DEFAULT_KEYFRAME_INTERVAL), false);
  assert.equal(shouldRequestKeyFrame(2, DEFAULT_KEYFRAME_INTERVAL), false);
  assert.equal(
    shouldRequestKeyFrame(DEFAULT_KEYFRAME_INTERVAL - 1, DEFAULT_KEYFRAME_INTERVAL),
    false,
  );
  assert.equal(
    shouldRequestKeyFrame(DEFAULT_KEYFRAME_INTERVAL + 1, DEFAULT_KEYFRAME_INTERVAL),
    false,
  );
  assert.equal(
    shouldRequestKeyFrame(DEFAULT_KEYFRAME_INTERVAL * 2 - 1, DEFAULT_KEYFRAME_INTERVAL),
    false,
  );
});

// 間隔 1 は「全フレームをキーフレームにする」設定として扱われる。
test("shouldRequestKeyFrame: 間隔 1 では全フレームで true になる", () => {
  for (const framesEncoded of [0, 1, 2, 3]) {
    assert.equal(shouldRequestKeyFrame(framesEncoded, 1), true);
  }
});

// ============================================================================
// プレビューの停止 (ブラウザ API を必要としない経路)
// ============================================================================

// stopPreview は映像ストリームの解放と signal の巻き戻しだけを行う。
// MediaStream の実体は Node では生成できないが、解放処理が呼ばれることと
// 表示状態が初期値へ戻ることは検証できる。
test("stopPreview: 映像ストリームを解放して待機状態に戻す", () => {
  resetPublisherSignals();
  const publisher = usePublisher();

  let cleanupCalls = 0;
  pub.videoStreamCleanup.value = () => {
    cleanupCalls += 1;
  };
  // MediaStream の実体は生成できないため null のままにし、解放処理の呼び出しだけを見る
  pub.isPreviewActive.value = true;
  pub.pubStatus.value = "connected";
  pub.pubStatusMessage.value = "Preview: Dummy (Canvas) 1280x720 @ 30fps";

  publisher.stopPreview();

  assert.equal(cleanupCalls, 1);
  assert.equal(pub.videoStreamCleanup.value, null);
  assert.equal(pub.mediaStream.value, null);
  assert.equal(pub.isPreviewActive.value, false);
  assert.equal(pub.pubStatus.value, "disconnected");
  assert.equal(pub.pubStatusMessage.value, "Ready to publish");
});

// 解放処理が無い状態でも stopPreview は例外を投げない
// (プレビュー開始前のトグル操作で呼ばれる)。
test("stopPreview: 解放処理が未登録でも例外を投げない", () => {
  resetPublisherSignals();
  const publisher = usePublisher();

  publisher.stopPreview();

  assert.equal(pub.videoStreamCleanup.value, null);
  assert.equal(pub.isPreviewActive.value, false);
});

// プレビュー中の togglePreview は停止として動く
// (開始側はダミー映像の生成に canvas が要るため、ブラウザ実行の E2E で扱う)。
test("togglePreview: プレビュー中は停止する", () => {
  resetPublisherSignals();
  const publisher = usePublisher();

  let cleanupCalls = 0;
  pub.videoStreamCleanup.value = () => {
    cleanupCalls += 1;
  };
  pub.isPreviewActive.value = true;

  publisher.togglePreview();

  assert.equal(cleanupCalls, 1);
  assert.equal(pub.isPreviewActive.value, false);
  assert.equal(pub.pubStatusMessage.value, "Ready to publish");
});

// 解像度の検証は映像ストリームの取得より先に行われる。
// URL クエリ由来の不正値で getUserMedia まで進まないことを固定する。
test("startPreview: 解像度が不正なときは映像ストリームを取得せずエラー表示にする", async () => {
  resetPublisherSignals();
  const publisher = usePublisher();

  const previousResolution = settings.resolution.value;
  settings.resolution.value = "1280";
  try {
    await publisher.startPreview();
  } finally {
    settings.resolution.value = previousResolution;
  }

  assert.equal(pub.pubStatus.value, "error");
  assert.match(pub.pubStatusMessage.value, /^Preview failed: invalid resolution/);
  // 映像ストリームは取得されていない
  assert.equal(pub.mediaStream.value, null);
  assert.equal(pub.videoStreamCleanup.value, null);
  assert.equal(pub.isPreviewActive.value, false);
});

// ============================================================================
// 接続設定の入力の無効化 (settingsDisabled)
// ============================================================================

/**
 * 接続設定の入力の状態と Subscriber の一覧をテスト開始時の状態に戻す
 */
function resetSettingsUsage(): void {
  subscriberInstances.value = new Map();
  settings.settingsDisabled.value = false;
}

/**
 * Subscriber の一覧を、購読の確立を待っている Subscriber 1 つだけに置き換える
 *
 * 確立を待っている間は subscriber.value が null のまま isStarting だけが立つ
 * (startSubscribing が映像トラックの購読の確立を待っている状態)。
 */
function setOnlyStartingSubscriber(id: string): void {
  const instance = createSubscriberInstance(id);
  instance.isStarting.value = true;
  subscriberInstances.value = new Map([[id, instance]]);
}

// 配信の開始に失敗しても、確立を待っている Subscriber はまだ接続設定を読む。
// 不正な解像度は最初の await (connect) より前に例外になり、catch と後始末まで
// 呼び出しの中で終わる (relay は要らない)
test("startPublishing: 開始に失敗しても、確立を待っている Subscriber が居れば settingsDisabled を保つ", async () => {
  resetPublisherSignals();
  resetSettingsUsage();
  setOnlyStartingSubscriber("starting-subscriber-1");
  const publisher = usePublisher();

  const previousResolution = settings.resolution.value;
  settings.resolution.value = "1280";
  try {
    await publisher.startPublishing();

    assert.equal(pub.pubStatus.value, "error");
    assert.match(pub.pubStatusMessage.value, /^Failed: invalid resolution/);
    // 配信を始めている途中ではなくなるが、Subscriber が使っているため入力は無効のまま
    assert.isFalse(pub.isStarting.value);
    assert.isTrue(settings.settingsDisabled.value);
  } finally {
    settings.resolution.value = previousResolution;
    resetSettingsUsage();
  }
});

// 誰も接続設定を使っていなければ、開始の失敗で入力を有効に戻す
test("startPublishing: 開始に失敗し、Subscriber が居なければ settingsDisabled を戻す", async () => {
  resetPublisherSignals();
  resetSettingsUsage();
  const publisher = usePublisher();

  const previousResolution = settings.resolution.value;
  settings.resolution.value = "1280";
  try {
    await publisher.startPublishing();

    assert.equal(pub.pubStatus.value, "error");
    assert.isFalse(pub.isStarting.value);
    assert.isFalse(settings.settingsDisabled.value);
  } finally {
    settings.resolution.value = previousResolution;
    resetSettingsUsage();
  }
});

// 配信を止めても、確立を待っている Subscriber が居れば入力は無効のまま残す。
// catalog / 映像 / 音声の publisher がどれも無いため、stopPublishing は done を待たずに
// 後始末まで進む
test("stopPublishing: 確立を待っている Subscriber が居れば settingsDisabled を保つ", async () => {
  resetPublisherSignals();
  resetSettingsUsage();
  setOnlyStartingSubscriber("starting-subscriber-2");
  settings.settingsDisabled.value = true;
  const publisher = usePublisher();

  try {
    await publisher.stopPublishing();

    assert.isTrue(settings.settingsDisabled.value);
  } finally {
    resetSettingsUsage();
  }
});

// connect を待っている間 (session はまだ無い) は配信を始めている途中として扱う。
// moqt:// で始まらない URL は async 関数の connect の中で例外になり、呼び出しは reject する。
// startPublishing は最初の await (connect) で一度止まり、await の後の catch で途中の状態が
// 終わる。実行環境の WebTransport の有無や relay に依存しない
test("startPublishing: connect を待っている間は isStarting が立ち、失敗の後始末で下りる", async () => {
  resetPublisherSignals();
  resetSettingsUsage();
  const publisher = usePublisher();

  const previousUrl = settings.url.value;
  settings.url.value = "invalid-url";
  try {
    const starting = publisher.startPublishing();
    // 最初の await (connect) で止まっている。session はまだ無い
    assert.isTrue(pub.isStarting.value);
    assert.equal(pub.pubSession.value, null);
    assert.isTrue(pub.hasActivePublisher.value);
    assert.isTrue(settings.settingsDisabled.value);

    await starting;

    // connect の失敗 (URL の検証) で catch に入った
    assert.equal(pub.pubStatus.value, "error");
    assert.match(pub.pubStatusMessage.value, /^Failed: url must start with moqt:\/\//);
    assert.isFalse(pub.isStarting.value);
    assert.isFalse(pub.hasActivePublisher.value);
    assert.isFalse(settings.settingsDisabled.value);
  } finally {
    settings.url.value = previousUrl;
    resetSettingsUsage();
  }
});

// 空名のトラックは接続の前に拒否する (draft-ietf-moq-msf-01 §5.2.3)。
// connect まで進むと relay に publish だけを作って止まるため、URL の検証より先に止める。
// 同名の検証は広告する 2 トラックが揃っているときだけ効く。Node には
// MediaStreamTrackProcessor が無く音声を広告しないため、ここでは映像の空名を固定する
// (同名は utils/publishTracks.test.ts と buildPublisherCatalog のテストで固定する)
test("startPublishing: 空のトラック名は接続の前に拒否する", async () => {
  resetPublisherSignals();
  resetSettingsUsage();
  resetCatalogSettings();
  const publisher = usePublisher();

  settings.videoTrackName.value = "";
  try {
    await publisher.startPublishing();

    assert.equal(pub.pubStatus.value, "error");
    assert.match(pub.pubStatusMessage.value, /^Failed: track name must not be empty/);
    assert.isFalse(pub.isStarting.value);
    // 接続していない (接続の前に検証している)
    assert.equal(pub.pubSession.value, null);
    assert.isFalse(settings.settingsDisabled.value);
  } finally {
    resetCatalogSettings();
    resetSettingsUsage();
  }
});

// ============================================================================
// 音声トラックの Catalog 生成
// ============================================================================
// 音声トラックは MSF §5.2.18 (codec) / §5.2.22 (bitrate) / §5.2.28 (samplerate) /
// §5.2.29 (channelConfig) が audio codec を指定する track に MUST で要求する。
// 購読側はこの 4 つから Decoder を構成するため、すべて載ることを固定する。
test("buildPublisherCatalog: 音声を有効にすると audio トラックが増える", () => {
  const catalog = buildPublisherCatalog({
    video: {
      trackName: "video",
      codec: "vp8",
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      framerate: VIDEO_FRAMERATE,
      bitrate: VIDEO_BITRATE,
    },
    audio: {
      trackName: "audio",
      codec: "opus",
      bitrate: 64000,
      sampleRate: 48000,
      channels: 2,
    },
  });

  assert.equal(catalog.tracks.length, 2);
  const audioTrack = catalog.tracks.find((track) => track.role === "audio");
  if (audioTrack === undefined) {
    throw new Error("expected an audio track");
  }

  // 音声トラック名は映像と同じく設定から渡した値がそのまま載る (MSF §5.2.3)
  assert.equal(audioTrack.name, "audio");
  assert.equal(audioTrack.packaging, "loc");
  assert.equal(audioTrack.isLive, true);

  // codec 文字列は Encoder に渡す設定と同じ対応表から解決する
  assert.equal(audioTrack.codec, getAudioEncoderConfig("opus", 64000, 48000, 2).codec);
  assert.equal(audioTrack.bitrate, 64000);
  assert.equal(audioTrack.samplerate, 48000);
  // channelConfig は文字列で載せる (MSF §5.2.29)
  assert.equal(audioTrack.channelConfig, "2");
});

test("buildPublisherCatalog: 音声を省略すると映像トラックだけになる", () => {
  const catalog = buildPublisherCatalog({
    video: {
      trackName: "video",
      codec: "vp8",
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      framerate: VIDEO_FRAMERATE,
      bitrate: VIDEO_BITRATE,
    },
  });

  assert.equal(catalog.tracks.length, 1);
  assert.equal(catalog.tracks[0]?.role, "video");
});

// 映像の入力が None のときは、音声トラックだけを載せる (MSF の catalog は映像トラックを
// 必須としない)。購読側は映像トラックの無い catalog を音声だけで購読する
test("buildPublisherCatalog: 映像を省略すると音声トラックだけになる", () => {
  const catalog = buildPublisherCatalog({
    audio: {
      trackName: "audio",
      codec: "opus",
      bitrate: 64000,
      sampleRate: 48000,
      channels: 2,
    },
  });

  assert.equal(catalog.tracks.length, 1);
  assert.equal(catalog.tracks[0]?.role, "audio");
  assert.equal(catalog.tracks[0]?.name, "audio");
});

// 映像も音声も無い catalog は購読できる対象が無いため、作らずに throw する
test("buildPublisherCatalog: 映像も音声も省略すると throw する", () => {
  assert.throws(() => buildPublisherCatalog({}), /no track to publish/);
});

test("buildPublisherCatalog: AAC の codec 文字列も Encoder 設定と一致する", () => {
  const catalog = buildPublisherCatalog({
    video: {
      trackName: "video",
      codec: "vp8",
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      framerate: VIDEO_FRAMERATE,
      bitrate: VIDEO_BITRATE,
    },
    audio: {
      trackName: "audio",
      codec: "aac",
      bitrate: 128000,
      sampleRate: 48000,
      channels: 1,
    },
  });

  const audioTrack = catalog.tracks.find((track) => track.role === "audio");
  assert.equal(audioTrack?.codec, getAudioEncoderConfig("aac", 128000, 48000, 1).codec);
  assert.equal(audioTrack?.channelConfig, "1");
});

// トラック名は設定から渡す。相手の実装に合わせて変えられるようにし、既定は
// ライブラリの DEFAULT_VIDEO_TRACK_NAME / DEFAULT_AUDIO_TRACK_NAME と同じにする
test("buildPublisherCatalog: トラック名は設定の値がそのまま載る", () => {
  const catalog = buildPublisherCatalog({
    video: { ...makeVideoCatalogOptions(), trackName: "cam" },
    audio: { ...makeAudioCatalogOptions(), trackName: "mic" },
  });

  // 並びは Audio → Video (画面の Tracks カードと同じ)
  assert.deepEqual(
    catalog.tracks.map((track) => track.name),
    ["mic", "cam"],
  );
});

// draft-ietf-moq-msf-01 §5.2.3: name は Required で、catalog の中で namespace ごとに
// 一意でなければならない MUST。空名と同名は購読側の復号 (decodeCatalogMessage) で
// 初めて分かるため、catalog を作る時点で拒否する
test("buildPublisherCatalog: 空名と同名のトラック名を拒否する", () => {
  assert.throws(
    () =>
      buildPublisherCatalog({
        video: makeVideoCatalogOptions(),
        audio: { ...makeAudioCatalogOptions(), trackName: "" },
      }),
    /track name must not be empty per draft-ietf-moq-msf-01 §5\.2\.3/,
  );

  assert.throws(
    () =>
      buildPublisherCatalog({
        video: { ...makeVideoCatalogOptions(), trackName: "same" },
        audio: { ...makeAudioCatalogOptions(), trackName: "same" },
      }),
    /track names must be unique per namespace per draft-ietf-moq-msf-01 §5\.2\.3/,
  );

  // 1 トラックだけの catalog は同名の問題が起きない
  const audioOnly = buildPublisherCatalog({ audio: makeAudioCatalogOptions() });
  assert.equal(audioOnly.tracks.length, 1);
});

// ============================================================================
// Catalog の targetLatency / renderGroup (draft-ietf-moq-msf-01 §5.2.8 / §5.2.11)
// ============================================================================

/**
 * 検証用の映像トラックの設定 (画面の既定値と同じ組み合わせ)
 */
function makeVideoCatalogOptions(): PublisherVideoCatalogOptions {
  return {
    trackName: "video",
    codec: "vp8",
    width: VIDEO_WIDTH,
    height: VIDEO_HEIGHT,
    framerate: VIDEO_FRAMERATE,
    bitrate: VIDEO_BITRATE,
  };
}

/**
 * 検証用の音声トラックの設定 (画面の既定値と同じ組み合わせ)
 */
function makeAudioCatalogOptions(): PublisherAudioCatalogOptions {
  return { trackName: "audio", codec: "opus", bitrate: 64000, sampleRate: 48000, channels: 2 };
}

// draft-ietf-moq-msf-01 §5.2.8: 同じ render group と alternate group の track は同一の
// targetLatency でなければならない MUST。publisher は値 1 つから音声と映像の両方の track に
// 同じ値を載せる。§5.2.11: 同じ renderGroup の track は同時に描画する SHOULD。
// 受信側の検証 (src/msf/catalogTrackValidation.ts) を通ることも wire format の往復で固定する
test("buildPublisherCatalog: targetLatency と renderGroup を音声と映像の両方の track に載せる", () => {
  const catalog = buildPublisherCatalog({
    video: makeVideoCatalogOptions(),
    audio: makeAudioCatalogOptions(),
    targetLatency: 100,
    renderGroup: 1,
  });

  assert.deepEqual(
    catalog.tracks.map((track) => track.role),
    // 画面 (Tracks カード) が Audio → Video の順に並べるため、catalog も同じ順に積む
    ["audio", "video"],
  );
  for (const track of catalog.tracks) {
    assert.equal(track.targetLatency, 100);
    assert.equal(track.renderGroup, 1);
  }

  // 送信したバイト列を購読側が読み戻しても値が残る
  const decoded = decodeCatalogMessage(encodeCatalog(catalog));
  if (!("version" in decoded)) {
    throw new Error("expected a full catalog, got a delta update");
  }
  assert.deepEqual(decoded, catalog);
});

// draft-ietf-moq-msf-01 §5.2.8: 宣言が無く isLive が true のときは購読側が表示の遅れを
// 選んでよい MAY。未指定のときはキーを載せず、購読側のフォールバックの経路にする
test("buildPublisherCatalog: 未指定のときは targetLatency と renderGroup を載せない", () => {
  const catalog = buildPublisherCatalog({
    video: makeVideoCatalogOptions(),
    audio: makeAudioCatalogOptions(),
  });

  for (const track of catalog.tracks) {
    assert.isFalse("targetLatency" in track);
    assert.isFalse("renderGroup" in track);
    assert.isUndefined(track.targetLatency);
    assert.isUndefined(track.renderGroup);
  }
});

// 非有限値は JSON.stringify が null に落ち、購読側の検証
// (src/msf/catalogTrackValidation.ts) が typeof null !== "number" で例外にする。
// 画面と URL の設定は許可リストで到達しないが、この純関数は直接呼べるため、
// 符号化の前に拒否する。どのフィールドが原因かはメッセージから読み取れる
test("buildPublisherCatalog: targetLatency の非有限値を拒否する", () => {
  for (const targetLatency of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(
      () => buildPublisherCatalog({ video: makeVideoCatalogOptions(), targetLatency }),
      /targetLatency must be finite/,
    );
  }
});

// renderGroup の整数性は decode 側で見ないため、encode 側が整数性を守る唯一の防波堤になる。
// 0 は有効値であり、検証を偽値で書くと落ちるため、0 が通ることもあわせて固定する
test("buildPublisherCatalog: renderGroup の非有限値と非整数を拒否し、0 は通す", () => {
  assert.throws(
    () => buildPublisherCatalog({ video: makeVideoCatalogOptions(), renderGroup: Number.NaN }),
    /renderGroup must be finite/,
  );
  assert.throws(
    () => buildPublisherCatalog({ video: makeVideoCatalogOptions(), renderGroup: 1.5 }),
    /renderGroup must be an integer/,
  );

  const catalog = buildPublisherCatalog({ video: makeVideoCatalogOptions(), renderGroup: 0 });
  assert.equal(catalog.tracks.length, 1);
  for (const track of catalog.tracks) {
    assert.equal(track.renderGroup, 0);
  }
});

// buildPublisherCatalog への配線は接続を要する startPublishing を経由するため単体テストで
// 観測できない (モックは使えない)。画面と URL の設定 (未指定は null) を
// PublisherCatalogOptions へ写す純関数を検証する
test("buildPublisherCatalogOptions: 未指定 (null) の項目はキーを落とす", () => {
  assert.deepEqual(
    buildPublisherCatalogOptions({
      video: null,
      audio: null,
      targetLatency: null,
      renderGroup: null,
    }),
    {},
  );

  // 映像だけを配信するときは audio のキーを載せない (exactOptionalPropertyTypes)、
  // targetLatency / renderGroup の未指定もキーを載せない
  const videoOnly = buildPublisherCatalogOptions({
    video: makeVideoCatalogOptions(),
    audio: null,
    targetLatency: null,
    renderGroup: null,
  });
  assert.isFalse("audio" in videoOnly);
  assert.isFalse("targetLatency" in videoOnly);
  assert.isFalse("renderGroup" in videoOnly);
  assert.deepEqual(videoOnly.video, makeVideoCatalogOptions());
});

// 0 ms と renderGroup の 0 はどちらも有効な指定であるため、null (未指定) と区別して残す
test("buildPublisherCatalogOptions: targetLatency と renderGroup の 0 は未指定と区別して残す", () => {
  const options = buildPublisherCatalogOptions({
    video: makeVideoCatalogOptions(),
    audio: makeAudioCatalogOptions(),
    targetLatency: 0,
    renderGroup: 0,
  });

  assert.equal(options.targetLatency, 0);
  assert.equal(options.renderGroup, 0);

  // 残した値がそのまま両方の track に載る
  const catalog = buildPublisherCatalog(options);
  for (const track of catalog.tracks) {
    assert.equal(track.targetLatency, 0);
    assert.equal(track.renderGroup, 0);
  }
});

// トラックを 1 つも配信しない設定でも、この純関数はトラックを増やさない。
// targetLatency / renderGroup は宣言であり、載せる相手の track を勝手に作らない
// (トラックが無い catalog を buildPublisherCatalog が throw する既存の挙動は
// 「buildPublisherCatalog: 映像も音声も省略すると throw する」で確認している)
test("buildPublisherCatalogOptions: トラックの無い設定ではトラックのキーを足さない", () => {
  const options = buildPublisherCatalogOptions({
    video: null,
    audio: null,
    targetLatency: 100,
    renderGroup: 1,
  });

  assert.isFalse("video" in options);
  assert.isFalse("audio" in options);
  // 指定した宣言だけが残る
  assert.deepEqual(options, { targetLatency: 100, renderGroup: 1 });
});

// ============================================================================
// 設定から Catalog の入力を組み立てる配線
// ============================================================================

/**
 * Catalog の入力の組み立てが読む設定の signal を既定値へ戻す
 *
 * 設定の signal もモジュールスコープで共有されるため、テストの前後で
 * devtools/src/signals/connectionSettings.ts の初期値へ戻し、他のテストへ持ち越さない。
 */
function resetCatalogSettings(): void {
  settings.videoSource.value = "dummy";
  settings.videoTrackName.value = "video";
  settings.audioTrackName.value = "audio";
  settings.codec.value = "vp8";
  settings.resolution.value = "1280x720";
  settings.framerate.value = 30;
  settings.bitrate.value = 2_000_000;
  settings.audioSource.value = "dummy";
  settings.audioCodec.value = "opus";
  settings.audioBitrate.value = 64_000;
  settings.audioSampleRate.value = 48_000;
  settings.audioChannels.value = 2;
  settings.targetLatency.value = null;
  settings.renderGroup.value = null;
}

// draft-ietf-moq-msf-01 §5.2.8: 宣言が無く isLive が true のときは購読側が表示の遅れを
// 選んでよい MAY。未指定 (null) のときにキーを作ると、この MAY の経路が消えて購読側が
// 0 ms の宣言として扱う。signal を直接書き換えて実際の設定を読ませる
test("buildPublisherCatalogOptionsFromSettings: 未指定 (null) のときは targetLatency と renderGroup のキーを作らない", () => {
  resetCatalogSettings();
  try {
    settings.targetLatency.value = null;
    settings.renderGroup.value = null;

    const options = buildPublisherCatalogOptionsFromSettings({ sampleRate: 48000, channels: 2 });

    assert.isFalse("targetLatency" in options);
    assert.isFalse("renderGroup" in options);
    // トラックの設定は既定値のまま載る (未指定でも映像と音声のトラックは落とさない)
    assert.deepEqual(options.video, makeVideoCatalogOptions());
    assert.deepEqual(options.audio, makeAudioCatalogOptions());
  } finally {
    resetCatalogSettings();
  }
});

// 0 ms と renderGroup の 0 はどちらも有効な指定である。未指定と同じ扱いにすると、購読側が
// 表示の遅れを選ぶ §5.2.8 の MAY の経路に落ちて宣言が消えるため、0 は 0 のまま残す
test("buildPublisherCatalogOptionsFromSettings: 0 のときは未指定と区別して 0 を載せる", () => {
  resetCatalogSettings();
  try {
    settings.targetLatency.value = 0;
    settings.renderGroup.value = 0;

    const options = buildPublisherCatalogOptionsFromSettings({ sampleRate: 48000, channels: 2 });

    assert.isTrue("targetLatency" in options);
    assert.isTrue("renderGroup" in options);
    assert.equal(options.targetLatency, 0);
    assert.equal(options.renderGroup, 0);

    // 残した値がそのまま音声と映像の両方の track に載る
    const catalog = buildPublisherCatalog(options);
    assert.equal(catalog.tracks.length, 2);
    for (const track of catalog.tracks) {
      assert.equal(track.targetLatency, 0);
      assert.equal(track.renderGroup, 0);
    }
  } finally {
    resetCatalogSettings();
  }
});

// 指定した値は音声と映像の両方の track に同じ値で載る (draft-ietf-moq-msf-01 §5.2.8 の
// MUST / §5.2.11)。値 1 つから両方の track を作るため、track ごとに値がずれない
test("buildPublisherCatalogOptionsFromSettings: 指定した 100 ms と renderGroup 1 を載せる", () => {
  resetCatalogSettings();
  try {
    settings.targetLatency.value = 100;
    settings.renderGroup.value = 1;

    const options = buildPublisherCatalogOptionsFromSettings({ sampleRate: 48000, channels: 2 });

    assert.equal(options.targetLatency, 100);
    assert.equal(options.renderGroup, 1);

    const catalog = buildPublisherCatalog(options);
    assert.equal(catalog.tracks.length, 2);
    for (const track of catalog.tracks) {
      assert.equal(track.targetLatency, 100);
      assert.equal(track.renderGroup, 1);
    }
  } finally {
    resetCatalogSettings();
  }
});

// 画面と URL の設定がそのまま Catalog の入力になる。解像度は "WIDTHxHEIGHT" の文字列から
// 数値へ、音声のサンプルレートとチャンネル数は設定ではなく実際に取れた音の形式を使う
// (マイクではデバイスが決めるため)。配信しないトラックのキーは作らない
test("buildPublisherCatalogOptionsFromSettings: 映像と音声の設定と、取れた音の形式を反映する", () => {
  resetCatalogSettings();
  try {
    settings.videoTrackName.value = "main";
    settings.audioTrackName.value = "mic";
    settings.resolution.value = "640x360";
    settings.framerate.value = 15;
    settings.bitrate.value = 1_000_000;
    settings.audioCodec.value = "aac";
    settings.audioBitrate.value = 128_000;
    settings.audioSource.value = "microphone";

    // 映像の入力が None のときは映像トラックを載せない (音声だけの配信)
    settings.videoSource.value = "none";
    const audioOnly = buildPublisherCatalogOptionsFromSettings({ sampleRate: 16000, channels: 1 });
    assert.isFalse("video" in audioOnly);
    assert.deepEqual(audioOnly.audio, {
      trackName: "mic",
      codec: "aac",
      bitrate: 128_000,
      sampleRate: 16000,
      channels: 1,
    });

    // 音声を用意できなかったときは音声トラックを載せない (映像の設定はそのまま載る)
    settings.videoSource.value = "camera";
    const videoOnly = buildPublisherCatalogOptionsFromSettings(null);
    assert.isFalse("audio" in videoOnly);
    assert.deepEqual(videoOnly.video, {
      trackName: "main",
      codec: "vp8",
      width: 640,
      height: 360,
      framerate: 15,
      bitrate: 1_000_000,
    });
  } finally {
    resetCatalogSettings();
  }
});

// ============================================================================
// 音声の Audio Config
// ============================================================================

// draft-ietf-moq-loc-04 §2.3.3.1 (Audio Config): AAC の AudioSpecificConfig は
// 同じ値を毎 Object 送らない。opus は description を持たないため何も載らない
test("resolveAudioConfigToSend: 初回と変更時だけ Audio Config を載せる", () => {
  const description = new Uint8Array([0x11, 0x90]);

  const first = resolveAudioConfigToSend(null, description, false);
  assert.deepEqual(first.config, description);
  assert.deepEqual(first.next, description);
  // 保持値は複製する (呼び出し側が元の配列を書き換えても影響しない)
  assert.notStrictEqual(first.next, description);
  assert.equal(first.resendNext, false);

  // 同じ値は載せず、保持値も変えない
  const same = resolveAudioConfigToSend(first.next, new Uint8Array([0x11, 0x90]), false);
  assert.equal(same.config, undefined);
  assert.deepEqual(same.next, first.next);
  assert.equal(same.resendNext, false);

  // 変化したら載せて保持値を更新する
  const changed = resolveAudioConfigToSend(first.next, new Uint8Array([0x12, 0x08]), false);
  assert.deepEqual(changed.config, new Uint8Array([0x12, 0x08]));
  assert.deepEqual(changed.next, new Uint8Array([0x12, 0x08]));

  // description が無い (opus) ときは載せず、保持値もそのままにする
  const opus = resolveAudioConfigToSend(first.next, undefined, false);
  assert.equal(opus.config, undefined);
  assert.deepEqual(opus.next, first.next);
  assert.equal(opus.resendNext, false);
});

// WebCodecs は description を configure 後の最初の chunk にしか付けないため、
// 後から接続した購読者へは保持している値を送り直す (音声には keyframe が無い)
test("resolveAudioConfigToSend: 送り直し要求で保持している Audio Config を載せ直す", () => {
  const description = new Uint8Array([0x11, 0x90]);
  const sent = resolveAudioConfigToSend(null, description, false);

  // 通常の chunk (description なし) では載らない
  const next = resolveAudioConfigToSend(sent.next, undefined, false);
  assert.equal(next.config, undefined);

  // 送り直し要求があると保持値を載せ直し、要求は解消する
  const resend = resolveAudioConfigToSend(next.next, undefined, true);
  assert.deepEqual(resend.config, new Uint8Array([0x11, 0x90]));
  assert.deepEqual(resend.next, new Uint8Array([0x11, 0x90]));
  assert.equal(resend.resendNext, false);

  // 保持する値が無いまま要求された場合は、次に description が現れるまで要求を残す
  const pending = resolveAudioConfigToSend(null, undefined, true);
  assert.equal(pending.config, undefined);
  assert.equal(pending.next, null);
  assert.equal(pending.resendNext, true);

  // 新しい description が現れればそれを載せ、要求は解消する
  const arrived = resolveAudioConfigToSend(pending.next, new Uint8Array([0x12, 0x08]), true);
  assert.deepEqual(arrived.config, new Uint8Array([0x12, 0x08]));
  assert.equal(arrived.resendNext, false);
});

// 音声の配信可否は Catalog を作る前に判定する。MediaStreamTrackProcessor は音声の
// 取り出しに必須で、未実装の環境で配信開始後に throw すると映像の配信まで止まる。
// Node には MediaStreamTrackProcessor が無いため、未対応環境の結果をここで固定できる
test("resolveAudioPublishable: 非対応環境と無効設定では false を返す", () => {
  assert.equal(resolveAudioPublishable("none"), false);
  assert.equal(resolveAudioPublishable("dummy"), false);
  assert.equal(resolveAudioPublishable("microphone"), false);
});
