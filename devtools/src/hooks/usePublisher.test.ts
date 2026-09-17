import { test, assert } from "vite-plus/test";
import { LOC, decodeCatalogMessage, encodeCatalog } from "moqt-js";
import {
  buildObjectSendPlan,
  buildPublisherCatalog,
  shouldRequestKeyFrame,
  usePublisher,
} from "./usePublisher";
import { getEncoderConfig } from "../utils/codec";
import type { EncodedChunkData } from "../utils/EncoderWrapper";
import type { CodecType } from "../types";
import * as pub from "../signals/publisher";
import * as settings from "../signals/connectionSettings";

// 映像設定の既定値 (devtools/src/signals/connectionSettings.ts) に合わせた検証用の値。
// 実際の UI から渡る値と同じ組み合わせで Catalog を組み立てる。
const VIDEO_WIDTH = 1280;
const VIDEO_HEIGHT = 720;
const VIDEO_FRAMERATE = 30;
const VIDEO_BITRATE = 2_000_000;

// キーフレーム間隔の既定値 (devtools/src/signals/publisher.ts の keyframeInterval)
const DEFAULT_KEYFRAME_INTERVAL = 3600;

// 検証対象の全 codec。catalog の codec 文字列は getEncoderConfig と一致していなければ
// 購読側が Decoder を設定できない (Catalog 誤記がそのまま配信不能になる)。
const ALL_CODECS: CodecType[] = ["vp8", "vp9", "av1", "h264", "h265"];

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
  pub.forwardState.value = null;
  pub.pubStatus.value = "disconnected";
  pub.pubStatusMessage.value = "配信開始待ち";
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
}

// ============================================================================
// Catalog 生成
// ============================================================================

// Catalog は購読側が Decoder を設定する唯一の情報源であるため、
// 設定値がトラックの各フィールドに反映されることを固定する。
test("buildPublisherCatalog: 設定値が video トラックのフィールドに反映される", () => {
  const catalog = buildPublisherCatalog({
    trackName: "video",
    codec: "vp8",
    width: VIDEO_WIDTH,
    height: VIDEO_HEIGHT,
    framerate: VIDEO_FRAMERATE,
    bitrate: VIDEO_BITRATE,
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
      trackName: "video",
      codec,
      width: 640,
      height: 480,
      framerate: VIDEO_FRAMERATE,
      bitrate: 1_000_000,
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
    trackName: "video",
    codec: "h264",
    width: VIDEO_WIDTH,
    height: VIDEO_HEIGHT,
    framerate: VIDEO_FRAMERATE,
    bitrate: VIDEO_BITRATE,
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
  );
  assert.equal(second.groupId, 1001);
  assert.equal(second.objectId, 1);
  assert.equal(second.nextObjectId, 2);
});

// キーフレームは即時配送を優先し、デルタフレームは既定優先度にする。
// 優先度を入れ替えると滞留時にキーフレームが捨てられる。
test("buildObjectSendPlan: キーフレームは優先度 255、デルタフレームは 128 にする", () => {
  const keyPlan = buildObjectSendPlan(
    { groupId: 0, objectId: 0 },
    makeChunk({ type: "key", timestamp: 0 }),
  );
  assert.equal(keyPlan.priority, 255);

  const deltaPlan = buildObjectSendPlan(
    { groupId: 1, objectId: 0 },
    makeChunk({ type: "delta", timestamp: 33_333 }),
  );
  assert.equal(deltaPlan.priority, 128);
});

// ============================================================================
// LOC Properties (draft-ietf-moq-loc-04 §2.3.2)
// ============================================================================

// 購読側は TIMESTAMP を EncodedVideoChunk の timestamp に、VIDEO_FRAME_MARKING の
// I ビットをキーフレーム判定に使う。送信した Properties がそのまま読み戻せることを固定する。
test("buildObjectSendPlan: LOC Properties に timestamp とキーフレーム判定を載せる", () => {
  const keyPlan = buildObjectSendPlan(
    { groupId: 0, objectId: 0 },
    makeChunk({ type: "key", timestamp: 33_333 }),
  );
  const keyProperties = LOC.decodeVideoProperties(keyPlan.properties);

  assert.equal(keyProperties.timestamp, 33_333n);
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
  );
  const deltaProperties = LOC.decodeVideoProperties(deltaPlan.properties);

  assert.equal(deltaProperties.timestamp, 66_666n);
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
  );
  const withConfigProperties = LOC.decodeVideoProperties(withConfig.properties);
  assert.ok(withConfigProperties.config !== undefined);
  assert.deepEqual(Array.from(withConfigProperties.config), Array.from(description));

  const withoutConfig = buildObjectSendPlan(
    { groupId: 1, objectId: 0 },
    makeChunk({ type: "delta", timestamp: 33_333 }),
  );
  assert.equal(LOC.decodeVideoProperties(withoutConfig.properties).config, undefined);
});

// payload は WebCodecs の internal data をコピーせずそのまま送る
// (コピーするとフレームあたりのメモリ帯域が増える)。
test("buildObjectSendPlan: payload は chunk の data をそのまま使う", () => {
  const chunk = makeChunk({ type: "key", timestamp: 0 });
  const plan = buildObjectSendPlan({ groupId: 0, objectId: 0 }, chunk);

  assert.strictEqual(plan.payload, chunk.data);
});

// ============================================================================
// キーフレーム要求の間隔
// ============================================================================

// 先頭フレームと keyframeInterval フレームごとにキーフレームを要求する。
// 間隔を無視して全フレームをキーフレームにすると帯域を浪費し、
// 要求が一度も出ないと購読開始時に復号を始められない。
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
  pub.pubStatusMessage.value = "プレビュー中";

  publisher.stopPreview();

  assert.equal(cleanupCalls, 1);
  assert.equal(pub.videoStreamCleanup.value, null);
  assert.equal(pub.mediaStream.value, null);
  assert.equal(pub.isPreviewActive.value, false);
  assert.equal(pub.pubStatus.value, "disconnected");
  assert.equal(pub.pubStatusMessage.value, "配信開始待ち");
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
  assert.equal(pub.pubStatusMessage.value, "配信開始待ち");
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
  assert.match(pub.pubStatusMessage.value, /^プレビュー失敗: invalid resolution/);
  // 映像ストリームは取得されていない
  assert.equal(pub.mediaStream.value, null);
  assert.equal(pub.videoStreamCleanup.value, null);
  assert.equal(pub.isPreviewActive.value, false);
});
