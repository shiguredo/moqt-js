/**
 * MediaSubscriber の音声と映像の表示時刻の単体テスト
 *
 * targetLatency の解決、共有の時間軸への記録、AudioContext の時計との換算を検証する。
 * 共通の fixture とヘルパーは src/testSupport/mediaSubscriberTestSupport.ts が持つ。
 */
import { test, assert } from "vite-plus/test";

import { MediaSubscriberImpl } from "./createMediaSubscriber";

import {
  playoutAudioClockOf,
  playoutAudioInputMapOf,
  playoutAudioOf,
  playoutAudioSchedulerOf,
  playoutTimelineOf,
} from "./testSupport/mediaPlayoutInternals";

import {
  installAudioOutput,
  type SubscriberAudioOutput,
} from "./testSupport/mediaSubscriberInternals";

import type { MediaPlayout } from "./playout/mediaPlayout";

import { AUDIO_RECEIVE_CATCH_UP_MIN_MS } from "./playout/audioReceiveCatchUp";

import type { MediaReceiverStats } from "./codec/types";

import { type Catalog, type CatalogTrack } from "./msf";

import * as LOC from "./loc";
import { type MoqtObject } from "./dataStream";

import {
  AUDIO_CLOCK_DEADBAND_MS,
  AUDIO_PLAYOUT_ARRIVAL_DELAY_SECONDS,
  AUDIO_PLAYOUT_DELAY_SECONDS,
  AUDIO_PLAYOUT_MIN_LEAD_SECONDS,
  type AudioClockMapping,
} from "./playout/audioPlayout";

import { AUDIO_DELAY_START_MS } from "./playout/audioDelayEstimator";

import {
  AUDIO_ONLY_ARRIVAL_DELAY_FLOOR_MS,
  AUDIO_PLAYOUT_ARRIVAL_DELAY_MS,
  AUDIO_PLAYOUT_DELAY_FLOOR_MS,
  MAX_PLAYOUT_DELAY_MS,
  audioArrivalPlayoutDelayMs,
} from "./playout/timeline";

import {
  createTestSubscriber,
  makeCatalog,
  AV_SYNC_TARGET_LATENCY_MS,
  wallClockTimestampMicrosOf,
  createTimestampedRecordingFrame,
  animationFrameCount,
  installAnimationFrameRecorder,
  restoreAnimationFrame,
  runPendingAnimationFrame,
  clearPendingAnimationFrame,
  makeAudioTrackInfo,
  makeVideoTrackInfo,
  installTimestampRecordingAudioDecoder,
} from "./testSupport/mediaSubscriberTestSupport";

// ============================================================================
// 音声と映像の表示時刻（draft-ietf-moq-msf-01 §5.2.8 / §5.2.11、
// draft-ietf-moq-loc-04 §2.3.1.1 / §2.3.1.2、src/playout/timeline.ts）
// ============================================================================

/**
 * 音声と映像の同期の検証用の制御口
 *
 * 表示時刻の計算と共有の時間軸への記録は再生の入口 (src/playout/mediaPlayout.ts) と
 * src/playout/timeline.ts が持ち、createMediaSubscriber 側は catalog の targetLatency の
 * 解決と AudioContext の作成・注入を担う。
 * AudioContext / AudioData / VideoFrame はブラウザ専用 API であり node 環境に実物がないため、
 * 既存の検証と同じく記録用の最小オブジェクトを注入する (モジュール置換は行わない)。
 */
interface SubscriberAvSyncControl {
  // 再生の入口 (MediaPlayout)。時間軸・音声の再生の組み立て・復号へ渡した入力の対応表は
  // その中が持つ (検証は playoutInternalsOf で内部形状へキャストして読む)
  readonly playout: MediaPlayout;
  audioTrackInfo: CatalogTrack | null;
  videoTrackInfo: CatalogTrack | null;
  audioOutput: SubscriberAudioOutput | null;
  // 映像の表示時刻の検証で使う書き込み先 (実装は write だけを呼ぶ)
  videoWriter: WritableStreamDefaultWriter<VideoFrame> | null;
  // Object から復号へ渡す時刻を確かめるため、デコーダも制御口に含める
  audioDecoder: {
    decode(payload: Uint8Array, type: "key" | "delta", timestamp: number, duration: number): void;
  } | null;
  audioDecoderConfigured: boolean;
  audioWallClockSeen: boolean;
  videoWallClockSeen: boolean;
  // トラックを解決できているかを検証するため、extractTrackInfo が読む入力も制御口に含める
  receivedCatalog: Catalog | null;
  extractTrackInfo(): void;
  createOutputStream(): void;
  handleAudioObject(obj: MoqtObject): void;
  handleAudioDecodedData(data: { data: AudioData }): void;
  handleVideoDecodedData(data: { frame: VideoFrame }): void;
}

// 上限 (MAX_PLAYOUT_DELAY_MS) を超える targetLatency (切り下げの検証用)
const AV_SYNC_TOO_LARGE_TARGET_LATENCY_MS = MAX_PLAYOUT_DELAY_MS + 100;

// ミリ秒の換算の丸め (Number の倍精度はミリ秒で 0.25 ms 程度) と実時間の進行を吸収する幅
const AV_SYNC_TOLERANCE_MS = 5;

/**
 * 表示時刻の到来を待つ上限 (ミリ秒)
 *
 * 表示時刻は `performance.now()` の軸で決まるため実時間を待つ必要がある。待ち続けて
 * テストが止まらないように上限を置く
 */
const AV_SYNC_WAIT_TIMEOUT_MS = 2_000;

/**
 * 対応の `contextTime` を時刻の基準にした、壁時計の TIMESTAMP (Unix epoch マイクロ秒)
 *
 * この TIMESTAMP を対応と同じ時刻で観測すると、基準の遅れ (受信側と送信側の時計のずれ) が
 * 音声の出力遅延の分だけ負になり、表示時刻が「TIMESTAMP + 表示の遅れ」として読める。
 *
 * @param mapping - `getOutputTimestamp()` が返す対応
 */
function wallClockTimestampMicrosFor(mapping: AudioClockMapping): number {
  return Math.round(mapping.contextTime * 1_000_000);
}

/**
 * 音声の時計の基準にする時刻 (`performance.now()` のミリ秒)
 *
 * `getOutputTimestamp()` の `performanceTime` は `performance.now()` と同じ原点の時刻である
 * (https://webaudio.github.io/web-audio-api/#dom-audiocontext-getoutputtimestamp)。
 * テストはこの 1 点を基準に、対応の値と `AudioContext.currentTime` を組み立てる。
 */
function avSyncReferenceMs(): number {
  return performance.now();
}

/**
 * `getOutputTimestamp()` が返す対応が持つ、音声の出力遅延 (ミリ秒)
 *
 * 実物は数十 ms である (https://webaudio.github.io/web-audio-api/#dom-audiocontext-getoutputtimestamp)。
 * テストではこの値の対応を作り、`AudioContext.currentTime` と組み合わせて目標の表示時刻を
 * AudioContext の秒へ換算させる
 */
const AV_SYNC_AUDIO_DEVICE_DELAY_MS = 100;

/**
 * `getOutputTimestamp()` が返す対応 (基準の時刻から作る)
 *
 * 差 (`contextTime` - `performanceTime` / 1000) は音声の出力遅延であり、数十 ms である。
 *
 * @param referenceMs - 基準の時刻 (`performance.now()` のミリ秒)
 */
function audioClockMappingAt(referenceMs: number): AudioClockMapping {
  return {
    // 差 (contextTime * 1000 - performanceTime) がそのまま音声の出力遅延になる
    contextTime: referenceMs / 1_000 + AV_SYNC_AUDIO_DEVICE_DELAY_MS / 1_000,
    performanceTime: referenceMs,
  };
}

/** 音声の壁時計の TIMESTAMP を観測済みにする (avSync を出せる条件を満たす) */
function markWallClockObserved(control: SubscriberAvSyncControl): void {
  control.audioWallClockSeen = true;
  control.videoWallClockSeen = true;
}

/**
 * catalog を解決して共有の targetLatency を決める
 *
 * extractTrackInfo が音声と映像の track info を解決し、その値から targetLatency を
 * 1 つ決めて時間軸へ渡す経路をそのまま駆動する。
 */
function resolveSharedTargetLatency(
  control: SubscriberAvSyncControl,
  catalog: Catalog,
): MediaReceiverStats {
  control.receivedCatalog = catalog;
  control.extractTrackInfo();
  return (control as unknown as { getStats(): MediaReceiverStats }).getStats();
}

/** targetLatency の検証に使う track の宣言 */
interface TargetLatencyTrackOptions {
  isLive: boolean;
  targetLatency?: number;
  renderGroup?: number;
  altGroup?: number;
}

/** 宣言どおりの CatalogTrack を作る (exactOptionalPropertyTypes のため値がある場合だけ載せる) */
function makeTargetLatencyTrack(name: string, options: TargetLatencyTrackOptions): CatalogTrack {
  return {
    name,
    packaging: "loc",
    isLive: options.isLive,
    ...(options.targetLatency === undefined ? {} : { targetLatency: options.targetLatency }),
    ...(options.renderGroup === undefined ? {} : { renderGroup: options.renderGroup }),
    ...(options.altGroup === undefined ? {} : { altGroup: options.altGroup }),
  };
}

/** 音声と映像の track を持つ最小カタログ (role は省略し、名前一致で解決させる) */
function makeAudioVideoCatalog(
  audio: TargetLatencyTrackOptions,
  video: TargetLatencyTrackOptions,
): Catalog {
  return makeCatalog([
    makeTargetLatencyTrack("audio", audio),
    makeTargetLatencyTrack("video", video),
  ]);
}

/**
 * 音声と映像の両方を購読している MediaSubscriber を作る
 *
 * 目標の表示時刻は「音声と映像の両方を購読している」ときだけ使うため、
 * 同期の検証はこの購読で行う。
 */
function createAvSyncSubscriber(): {
  subscriber: MediaSubscriberImpl;
  control: SubscriberAvSyncControl;
  errors: Error[];
} {
  const { subscriber, errors } = createTestSubscriber({ audio: {}, video: {} });
  return { subscriber, control: subscriber as unknown as SubscriberAvSyncControl, errors };
}

/**
 * draft-ietf-moq-msf-01 §5.2.8:
 * 両方のトラックに `targetLatency` があり、同じ `renderGroup` で値も同じなら、
 * その値をそのまま使う。
 */
test("targetLatency: 両方にあって同じ値ならその値を使う", () => {
  const { control, errors } = createAvSyncSubscriber();
  markWallClockObserved(control);
  const stats = resolveSharedTargetLatency(
    control,
    makeAudioVideoCatalog(
      { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS, renderGroup: 1 },
      { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS, renderGroup: 1 },
    ),
  );

  assert.equal(errors.length, 0);
  assert.equal(stats.avSync?.targetLatencyMs, AV_SYNC_TARGET_LATENCY_MS);
  assert.equal(stats.avSync?.targetLatencyLimitedMs, 0);
  // 解決の経路が 1 つの値を使うことの陽性対照 (時間軸へ渡っていることを読む)
  assert.equal(playoutTimelineOf(control.playout).targetLatencyMs, AV_SYNC_TARGET_LATENCY_MS);
  assert.equal(stats.avSync?.skewMs, null);
});

/**
 * draft-ietf-moq-msf-01 §5.2.8:
 * 同じ `renderGroup` のトラックが異なる `targetLatency` を持つのは MUST 違反であり、
 * `onError` で通知する。使う値は大きい方にする (小さい方の要求より早く出さない)。
 */
test("targetLatency: 同じ renderGroup で異なる値なら onError を通知して大きい方を使う", () => {
  const { control, errors } = createAvSyncSubscriber();
  markWallClockObserved(control);
  const largerMs = AV_SYNC_TARGET_LATENCY_MS + 80;
  const stats = resolveSharedTargetLatency(
    control,
    makeAudioVideoCatalog(
      { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS, renderGroup: 1 },
      { isLive: true, targetLatency: largerMs, renderGroup: 1 },
    ),
  );

  // 違反の通知は 1 回だけ
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /targetLatency differs between tracks in the same render group/);
  assert.equal(stats.avSync?.targetLatencyMs, largerMs);
  assert.equal(playoutTimelineOf(control.playout).targetLatencyMs, largerMs);
});

/**
 * draft-ietf-moq-msf-01 §5.2.8:
 * 異なる `renderGroup` のトラックは同じ値でなければならない MUST の対象ではないため、
 * 通知しない。値が 1 つに決まることは同じなので大きい方を使う。
 */
test("targetLatency: renderGroup も altGroup も無いか異なるときは通知しない", () => {
  const { control, errors } = createAvSyncSubscriber();
  markWallClockObserved(control);
  const largerMs = AV_SYNC_TARGET_LATENCY_MS + 80;
  const stats = resolveSharedTargetLatency(
    control,
    makeAudioVideoCatalog(
      { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS, renderGroup: 1 },
      { isLive: true, targetLatency: largerMs, renderGroup: 2 },
    ),
  );

  assert.equal(errors.length, 0);
  assert.equal(stats.avSync?.targetLatencyMs, largerMs);
});

/**
 * draft-ietf-moq-msf-01 §5.2.8:
 * 異なる `renderGroup` でも `altGroup` が同じなら同じ値でなければならない MUST の
 * 対象であるため、通知する。
 */
test("targetLatency: altGroup が同じで異なる値なら onError を通知する", () => {
  const { control, errors } = createAvSyncSubscriber();
  markWallClockObserved(control);
  const largerMs = AV_SYNC_TARGET_LATENCY_MS + 80;
  const stats = resolveSharedTargetLatency(
    control,
    makeAudioVideoCatalog(
      { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS, altGroup: 3 },
      { isLive: true, targetLatency: largerMs, altGroup: 3 },
    ),
  );

  assert.equal(errors.length, 1);
  assert.equal(stats.avSync?.targetLatencyMs, largerMs);
});

/**
 * draft-ietf-moq-msf-01 §5.2.8:
 * 片方にしか `targetLatency` が無いときは、もう片方は遅延を選んでよい (MAY) ため、
 * あるほうの値を使って揃える。
 */
test("targetLatency: 片方にだけあるときはその値を使う", () => {
  const { control, errors } = createAvSyncSubscriber();
  markWallClockObserved(control);
  const stats = resolveSharedTargetLatency(
    control,
    makeAudioVideoCatalog(
      { isLive: true },
      { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
    ),
  );

  assert.equal(errors.length, 0);
  assert.equal(stats.avSync?.targetLatencyMs, AV_SYNC_TARGET_LATENCY_MS);
  assert.equal(playoutTimelineOf(control.playout).targetLatencyMs, AV_SYNC_TARGET_LATENCY_MS);
});

/**
 * draft-ietf-moq-msf-01 §5.2.8:
 * `renderGroup` が異なっても `altGroup` が同じなら同じ値でなければならない MUST の
 * 対象であるため、通知する。`renderGroup` が同じで `altGroup` が異なる場合も同じである。
 */
test("targetLatency: 片方の group だけが同じで異なる値なら onError を通知する", () => {
  const { subscriber, errors } = createTestSubscriber({ audio: {}, video: {} });
  const control = subscriber as unknown as SubscriberAvSyncControl;
  markWallClockObserved(control);
  const largerMs = AV_SYNC_TARGET_LATENCY_MS + 80;

  // renderGroup が異なり altGroup が同じ (altGroup の MUST に触れる)
  const statsViaAltGroup = resolveSharedTargetLatency(
    control,
    makeAudioVideoCatalog(
      { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS, renderGroup: 1, altGroup: 3 },
      { isLive: true, targetLatency: largerMs, renderGroup: 2, altGroup: 3 },
    ),
  );
  assert.equal(errors.length, 1);
  assert.equal(statsViaAltGroup.avSync?.targetLatencyMs, largerMs);

  // renderGroup が同じで altGroup が異なる (renderGroup の MUST に触れる)
  const statsViaRenderGroup = resolveSharedTargetLatency(
    control,
    makeAudioVideoCatalog(
      { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS, renderGroup: 1, altGroup: 3 },
      { isLive: true, targetLatency: largerMs, renderGroup: 1, altGroup: 4 },
    ),
  );
  assert.equal(errors.length, 2);
  assert.equal(statsViaRenderGroup.avSync?.targetLatencyMs, largerMs);
});

/** 上のテストの逆 (音声にだけある場合) も同じ扱いになる */
test("targetLatency: 音声にだけあるときもその値を使う", () => {
  const { control, errors } = createAvSyncSubscriber();
  markWallClockObserved(control);
  const stats = resolveSharedTargetLatency(
    control,
    makeAudioVideoCatalog(
      { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
      { isLive: true },
    ),
  );

  assert.equal(errors.length, 0);
  assert.equal(stats.avSync?.targetLatencyMs, AV_SYNC_TARGET_LATENCY_MS);
  assert.equal(playoutTimelineOf(control.playout).targetLatencyMs, AV_SYNC_TARGET_LATENCY_MS);
});

/**
 * draft-ietf-moq-msf-01 §5.2.8:
 * `isLive` が false のトラックの `targetLatency` は無視する MUST。片方が false なら
 * 使える値はもう片方だけになり、両方が false なら `targetLatency` を使わない。
 */
test("targetLatency: isLive が false のトラックの値は無視する", () => {
  const { control, errors } = createAvSyncSubscriber();
  markWallClockObserved(control);
  // 映像だけ isLive が false のため、音声の値が使われる (無視しなければ大きい方を選ぶ)
  const largerMs = AV_SYNC_TARGET_LATENCY_MS + 80;
  const stats = resolveSharedTargetLatency(
    control,
    makeAudioVideoCatalog(
      { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
      { isLive: false, targetLatency: largerMs },
    ),
  );

  assert.equal(errors.length, 0);
  assert.equal(stats.avSync?.targetLatencyMs, AV_SYNC_TARGET_LATENCY_MS);
});

test("targetLatency: 両方 isLive が false なら targetLatency を使わない", () => {
  const { control, errors } = createAvSyncSubscriber();
  markWallClockObserved(control);
  const stats = resolveSharedTargetLatency(
    control,
    makeAudioVideoCatalog(
      { isLive: false, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
      { isLive: false, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
    ),
  );

  assert.equal(errors.length, 0);
  assert.isNull(stats.avSync?.targetLatencyMs);
  assert.isNull(playoutTimelineOf(control.playout).targetLatencyMs);
});

/**
 * 完了条件: 表示の遅れの上限 (`MAX_PLAYOUT_DELAY_MS` とキューが吸収できる長さの小さい方) を
 * 超える `targetLatency` は切り下げ、切り下げた分を統計に出す (同期は保たれる)。
 * 上限は基準の遅れではなく「表示の遅れ - 基準の遅れ」に掛かるため、ここでは学習が無い
 * (フレーム間隔が不明な) 状態の `MAX_PLAYOUT_DELAY_MS` が上限になる。
 */
test("targetLatency: 上限を超える値は切り下げて切り下げた分を統計に出す", () => {
  const { control, errors } = createAvSyncSubscriber();
  markWallClockObserved(control);
  const stats = resolveSharedTargetLatency(
    control,
    makeAudioVideoCatalog(
      {
        isLive: true,
        targetLatency: AV_SYNC_TOO_LARGE_TARGET_LATENCY_MS,
        renderGroup: 1,
      },
      {
        isLive: true,
        targetLatency: AV_SYNC_TOO_LARGE_TARGET_LATENCY_MS,
        renderGroup: 1,
      },
    ),
  );

  assert.equal(errors.length, 0);
  // 使っている値は宣言のままで、表示の遅れに掛ける分だけが切り下がる
  assert.equal(stats.avSync?.targetLatencyMs, AV_SYNC_TOO_LARGE_TARGET_LATENCY_MS);
  assert.equal(
    stats.avSync?.targetLatencyLimitedMs,
    AV_SYNC_TOO_LARGE_TARGET_LATENCY_MS - MAX_PLAYOUT_DELAY_MS,
  );
});

/**
 * `avSync` を出せない条件を固定する。片方だけの購読では揃える相手がいないため出さず、
 * トラックがカタログで解決できていないときも出さない。
 */
test("avSync: 音声だけの購読では null になる", () => {
  const { subscriber, errors } = createTestSubscriber({ audio: {} });
  const control = subscriber as unknown as SubscriberAvSyncControl;
  markWallClockObserved(control);
  const stats = resolveSharedTargetLatency(
    control,
    makeCatalog([
      makeTargetLatencyTrack("audio", {
        isLive: true,
        targetLatency: AV_SYNC_TARGET_LATENCY_MS,
      }),
    ]),
  );

  assert.equal(errors.length, 0);
  assert.isNull(stats.avSync);
});

test("avSync: トラックがカタログで解決できていないときは null になる", () => {
  const { control, errors } = createAvSyncSubscriber();
  markWallClockObserved(control);
  // 映像のトラックがカタログに無い
  const stats = resolveSharedTargetLatency(
    control,
    makeCatalog([
      makeTargetLatencyTrack("audio", {
        isLive: true,
        targetLatency: AV_SYNC_TARGET_LATENCY_MS,
      }),
    ]),
  );

  // 解決できなかったことは onError で通知される (null は値の型で表す)
  assert.equal(errors.length, 1);
  assert.isNull(control.videoTrackInfo);
  assert.isNull(stats.avSync);
});

/**
 * 壁時計の TIMESTAMP を観測していないトラックがあると、表示時刻を決められない
 * (音声の timestamp がメディア時刻になる) ため `avSync` を出さない。トラックの解決と
 * 片方の観測だけでは出ないことを固定する。
 */
test("avSync: 壁時計の TIMESTAMP を観測していないときは null になる", () => {
  const { control, errors } = createAvSyncSubscriber();
  // 映像だけ観測済みにする
  control.videoWallClockSeen = true;
  const stats = resolveSharedTargetLatency(
    control,
    makeAudioVideoCatalog(
      { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
      { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
    ),
  );

  assert.equal(errors.length, 0);
  assert.isNull(stats.avSync);
});

/**
 * avSync の壁時計の観測の検証用に、音声と映像の track を catalog から解決する
 *
 * avSync を出すには、両方の track が解決できていることに加えて、両方で壁時計の
 * TIMESTAMP を観測していることが要る。ここでは track の解決だけを揃える。
 */
function resolveAvSyncTracks(control: SubscriberAvSyncControl): void {
  control.receivedCatalog = makeAudioVideoCatalog(
    { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
    { isLive: true, targetLatency: AV_SYNC_TARGET_LATENCY_MS },
  );
  control.extractTrackInfo();
}

/** 音声の復号の出力を 1 つ入口へ渡す (出し先が無いときは入口が skipped を返す) */
function feedAudioDecodedData(control: SubscriberAvSyncControl, timestampMicros: number): void {
  control.handleAudioDecodedData({
    data: {
      numberOfChannels: 1,
      sampleRate: 48_000,
      numberOfFrames: 960,
      timestamp: timestampMicros,
      copyTo: () => {},
      close: () => {},
    } as unknown as AudioData,
  });
}

/**
 * 音声の壁時計の TIMESTAMP を 1 つ観測させる
 *
 * 復号へ渡した入力の記録と、入口への復号の出力の push を実装の経路で行う。
 * `playAudioFrame` が出し先 (AudioContext と出力先) を注入する。
 */
function observeWallClockAudio(control: SubscriberAvSyncControl): void {
  const mapping = audioClockMappingAt(avSyncReferenceMs());
  const timestampMicros = wallClockTimestampMicrosFor(mapping);
  control.playout.trackAudioDecodeInput(timestampMicros, { timestampKind: "wallClock" });
  playAudioFrame(control, timestampMicros, mapping);
}

/** 映像の復号の出力を 1 つ入口へ渡す (表示周期は node 環境に無いため差し替えて受ける) */
function pushVideoFrame(control: SubscriberAvSyncControl, timestampMicros: number): void {
  installAnimationFrameRecorder();
  try {
    control.handleVideoDecodedData({
      frame: createTimestampedRecordingFrame(timestampMicros).frame,
    });
  } finally {
    clearPendingAnimationFrame();
    restoreAnimationFrame();
  }
}

/**
 * 壁時計の TIMESTAMP を持つ映像フレームを 1 枚、入口の表示待ちへ積む
 *
 * 表示できる出し先を用意してから push する (出し先が無いと skipped になる)。
 */
function observeWallClockVideo(control: SubscriberAvSyncControl): void {
  const timestampMicros = wallClockTimestampMicrosOf(performance.timeOrigin + performance.now());
  control.playout.trackVideoDecodeInput(timestampMicros, {
    timestampKind: "wallClock",
    location: { group: 0n, object: 0n },
  });
  control.videoWriter = createRecordingVideoWriter().writer;
  pushVideoFrame(control, timestampMicros);
}

/**
 * 完了条件: 復号した映像フレームが壁時計の TIMESTAMP を持つとき、handleVideoDecodedData が
 * 入口の結果 (`wallClockTimestamp`) から videoWallClockSeen を立て、avSync の壁時計の
 * ゲートが開くこと。音声の側も実装の経路 (handleAudioDecodedData) で壁時計の TIMESTAMP を
 * 観測させ、markWallClockObserved のようなフラグの直接設定は使わない。
 */
test("handleVideoDecodedData: 壁時計の TIMESTAMP を持つフレームで avSync のゲートが開く", () => {
  const { subscriber, control, errors } = createAvSyncSubscriber();
  // 音声と映像の track を catalog から解決する (avSync を出せる条件の 1 つ)
  resolveAvSyncTracks(control);
  assert.equal(errors.length, 0);

  // 音声の側は復号の出力を入口へ渡して壁時計の TIMESTAMP を観測済みにする
  observeWallClockAudio(control);
  assert.isTrue(control.audioWallClockSeen, "音声の壁時計の TIMESTAMP を観測すること");
  assert.isFalse(control.videoWallClockSeen, "映像はまだ観測していないこと");
  // 音声だけでは avSync を出さない
  assert.isNull(subscriber.getStats().avSync);

  // 壁時計の TIMESTAMP を持つフレームを handleVideoDecodedData へ通す
  observeWallClockVideo(control);

  // 入口が返した壁時計の TIMESTAMP から videoWallClockSeen が立ち、avSync を出せるようになる
  assert.isTrue(control.videoWallClockSeen, "映像の壁時計の TIMESTAMP を観測すること");
  assert.isNotNull(subscriber.getStats().avSync, "両方で壁時計を観測したら avSync を出すこと");
});

/**
 * 完了条件: 音声の壁時計の TIMESTAMP の観測は、入口が音を鳴らした (skipped ではない) ときだけ
 * 反映する。skipped は直前の値を残すため、未観測からの skipped の壁時計の音 (true にしない)
 * と、観測済みからの skipped のメディア時刻の音 (false にしない) の両方で固定する。
 * 鳴らしたメディア時刻の音では観測済みの状態を落とす。
 */
test("handleAudioDecodedData: skipped は壁時計の観測を変えず、mediaTime は観測済みを落とす", () => {
  const { subscriber, control, errors } = createAvSyncSubscriber();
  resolveAvSyncTracks(control);
  // 映像の側は観測済みにし、音声の側の判定だけを見る
  control.videoWallClockSeen = true;
  assert.isFalse(control.audioWallClockSeen);

  // 未観測のまま、出し先を外した壁時計の音 (skipped) を渡しても観測済みにしない
  control.playout.setAudioOutput(null);
  const skippedWallClockTimestamp = wallClockTimestampMicrosOf(
    performance.timeOrigin + performance.now(),
  );
  control.playout.trackAudioDecodeInput(skippedWallClockTimestamp, { timestampKind: "wallClock" });
  feedAudioDecodedData(control, skippedWallClockTimestamp);
  assert.isFalse(
    control.audioWallClockSeen,
    "未観測のままなら skipped の壁時計の音で true にしないこと",
  );
  assert.isNull(
    subscriber.getStats().avSync,
    "音声の壁時計を観測していないため avSync を出さないこと",
  );

  // 壁時計の音を 1 つ鳴らすと観測済みになる
  observeWallClockAudio(control);
  assert.isTrue(control.audioWallClockSeen, "鳴らした壁時計の音で観測済みになること");
  assert.isNotNull(subscriber.getStats().avSync, "両方で観測したら avSync を出すこと");

  // 観測済みのまま、出し先を外したメディア時刻の音 (skipped) を渡しても true のまま残す
  control.playout.setAudioOutput(null);
  const skippedMediaTimeTimestamp =
    wallClockTimestampMicrosOf(performance.timeOrigin + performance.now()) + 20_000;
  control.playout.trackAudioDecodeInput(skippedMediaTimeTimestamp, {
    timestampKind: "mediaTime",
  });
  feedAudioDecodedData(control, skippedMediaTimeTimestamp);
  assert.isTrue(
    control.audioWallClockSeen,
    "観測済みなら skipped のメディア時刻の音で落とさないこと",
  );
  assert.isNotNull(subscriber.getStats().avSync, "観測済みのまま avSync を出すこと");

  // メディア時刻の音を鳴らすと壁時計の観測ではなくなり、avSync を出さない
  const mediaTimeTimestamp =
    wallClockTimestampMicrosOf(performance.timeOrigin + performance.now()) + 40_000;
  control.playout.trackAudioDecodeInput(mediaTimeTimestamp, { timestampKind: "mediaTime" });
  playAudioFrame(control, mediaTimeTimestamp, audioClockMappingAt(avSyncReferenceMs()));
  assert.isFalse(control.audioWallClockSeen, "鳴らしたメディア時刻の音では観測済みにしないこと");
  assert.isNull(
    subscriber.getStats().avSync,
    "音声の壁時計を観測していないため avSync を出さないこと",
  );
  assert.equal(errors.length, 0);
});

/**
 * 完了条件: 映像の壁時計の TIMESTAMP の観測は、入口が表示待ちに積んだ (queued) ときだけ
 * 反映する。skipped は直前の値を残すため、未観測からの skipped の壁時計のフレーム
 * (true にしない) と、観測済みからの skipped のメディア時刻のフレーム (false にしない) の
 * 両方で固定する。queued になったメディア時刻のフレームでは観測済みの状態を落とす。
 */
test("handleVideoDecodedData: skipped は壁時計の観測を変えず、mediaTime は観測済みを落とす", () => {
  const { subscriber, control, errors } = createAvSyncSubscriber();
  resolveAvSyncTracks(control);
  // 音声の側は観測済みにし、映像の側の判定だけを見る
  control.audioWallClockSeen = true;
  assert.isFalse(control.videoWallClockSeen);

  // 未観測のまま、出し先を外した壁時計のフレーム (skipped) を渡しても観測済みにしない
  control.videoWriter = null;
  const skippedWallClockTimestamp = wallClockTimestampMicrosOf(
    performance.timeOrigin + performance.now(),
  );
  control.playout.trackVideoDecodeInput(skippedWallClockTimestamp, {
    timestampKind: "wallClock",
    location: { group: 0n, object: 0n },
  });
  control.handleVideoDecodedData({
    frame: createTimestampedRecordingFrame(skippedWallClockTimestamp).frame,
  });
  assert.isFalse(
    control.videoWallClockSeen,
    "未観測のままなら skipped の壁時計のフレームで true にしないこと",
  );
  assert.isNull(
    subscriber.getStats().avSync,
    "映像の壁時計を観測していないため avSync を出さないこと",
  );

  // 出し先を戻し、壁時計のフレームを 1 枚積むと観測済みになる
  observeWallClockVideo(control);
  assert.isTrue(control.videoWallClockSeen, "積んだ壁時計のフレームで観測済みになること");
  assert.isNotNull(subscriber.getStats().avSync, "両方で観測したら avSync を出すこと");

  // 観測済みのまま、出し先を外したメディア時刻のフレーム (skipped) を渡しても true のまま
  control.videoWriter = null;
  const skippedMediaTimeTimestamp =
    wallClockTimestampMicrosOf(performance.timeOrigin + performance.now()) + 1_000_000;
  control.playout.trackVideoDecodeInput(skippedMediaTimeTimestamp, {
    timestampKind: "mediaTime",
    location: { group: 0n, object: 1n },
  });
  control.handleVideoDecodedData({
    frame: createTimestampedRecordingFrame(skippedMediaTimeTimestamp).frame,
  });
  assert.isTrue(
    control.videoWallClockSeen,
    "観測済みなら skipped のメディア時刻のフレームで落とさないこと",
  );

  // メディア時刻のフレームを積んだ (queued) ときは観測済みではなくなる
  control.videoWriter = createRecordingVideoWriter().writer;
  const mediaTimeTimestamp = 5_000_000;
  control.playout.trackVideoDecodeInput(mediaTimeTimestamp, {
    timestampKind: "mediaTime",
    location: { group: 0n, object: 2n },
  });
  pushVideoFrame(control, mediaTimeTimestamp);
  assert.isFalse(
    control.videoWallClockSeen,
    "queued のメディア時刻のフレームでは観測済みにしないこと",
  );
  assert.isNull(
    subscriber.getStats().avSync,
    "映像の壁時計を観測していないため avSync を出さないこと",
  );
  assert.equal(errors.length, 0);
});

/**
 * 音声の予約のときに測った値
 *
 * 実装は `getOutputTimestamp()` を読んだ時点の `performance.now()` で目標の表示時刻を
 * 求める (src/playout/audioPlayoutSession.ts の handleDecodedAudio)。テスト側でも
 * `getOutputTimestamp()` の中で同じ時点の値を測るため、実時間の進行に依存しない。
 */
interface AudioReservation {
  /** `getOutputTimestamp()` を読んだ時点の `performance.now()` (ミリ秒) */
  readAtMs: number;
  /** その時点で実装が使う目標の表示時刻 (`performance.now()` のミリ秒) */
  presentationMs: number;
  /** その時点の `AudioContext.currentTime` (秒) */
  currentTimeSeconds: number;
  /** `start(when)` に渡った値 (秒)。目標を過ぎて捨てられた音では空になる */
  startedAtSeconds: number[];
  /** `createBuffer` へ渡った長さ (サンプル数)。隙間の補間を含む */
  bufferFrames: number[];
  /** 音声の出力遅延 (ミリ秒)。`getOutputTimestamp()` の対応から求める */
  deviceDelayMs: number;
}

/**
 * 予約時刻の期待値 (ミリ秒)。目標の表示時刻と音声の出力遅延の和になる
 *
 * @param reservation - 予約のときに測った値
 */
function expectedStartMs(reservation: AudioReservation): number {
  return reservation.presentationMs + reservation.deviceDelayMs;
}

/**
 * 「目標の表示時刻 + 音声の出力遅延」と予約時刻の許容幅 (ミリ秒)
 *
 * 目標の表示時刻は `performance.now()` の軸で決まるため、実装が目標を求めてから
 * `start(when)` を呼ぶまでの実時間の進行 (数ミリ秒から数十ミリ秒) だけ予約時刻が先になる。
 * 目標の表示時刻を測る位置をずらしても変わらない値で確かめるため、この幅を持たせる
 */
const AV_SYNC_START_TOLERANCE_MS = 50;

/**
 * 音声を 1 つ鳴らし、予約のときに測った値と `start(when)` を記録する
 *
 * 音声の出力 (AudioContext / MediaStreamAudioDestinationNode) と track info は
 * ブラウザ専用 API であり node 環境に実物がないため、既存の検証と同じく記録用の
 * 最小オブジェクトを注入する (モジュール置換は行わない)。
 *
 * `currentTime` は予約の間ずっと同じ値を返す (実装は 1 つの音につき 1 回だけ読む)。値は
 * 目標の表示時刻より少し前になるようにする。目標の表示時刻は `performance.now()` の軸で
 * 決まるため、実時間の進行に任せると目標を過ぎて音が捨てられ得るためである。
 *
 * @param control - 駆動する MediaSubscriber
 * @param timestampMicros - AudioData の timestamp
 * @param mapping - この予約のときの `getOutputTimestamp()`。null なら未開始 (0/0)
 * @param currentTimeSeconds - この予約のときの `AudioContext.currentTime` (秒)。
 *   省略時は目標の表示時刻から組み立てる
 */
function playAudioFrame(
  control: SubscriberAvSyncControl,
  timestampMicros: number,
  mapping: AudioClockMapping | null,
  currentTimeSeconds?: number,
): AudioReservation {
  // 音声のトラックが解決できている状態にする (購読が揃っていることの条件)
  control.audioTrackInfo = makeAudioTrackInfo({
    codec: "opus",
    samplerate: 48_000,
    channelConfig: "2",
  });
  // 未開始の対応は 0/0 を返す (実物と同じ)
  const effectiveMapping: AudioClockMapping = mapping ?? { contextTime: 0, performanceTime: 0 };
  // 到着の時刻は実装が測る。テスト側でも「到着より前」の時点を測り、実装が測った値の
  // 下限として使う
  const nowMs = performance.now();
  const reservation: AudioReservation = {
    readAtMs: nowMs,
    presentationMs: 0,
    // `currentTime` は対応の `contextTime` と同じ座標であり、対応を取った後も進む。
    // 明示されないときは下で組み立てる
    currentTimeSeconds: currentTimeSeconds ?? 0,
    startedAtSeconds: [],
    bufferFrames: [],
    // 対応が無い (未開始) ときは音声の出力遅延も無い
    deviceDelayMs:
      mapping === null
        ? 0
        : effectiveMapping.contextTime * 1_000 - effectiveMapping.performanceTime,
  };
  // 目標の表示時刻を使うのは、実装がその音を壁時計の TIMESTAMP として扱うときだけである
  // (src/playout/audioPlayoutSession.ts の handleDecodedAudio と同じ判定)。そのときは目標の
  // 少し前 (不感帯の半分) を「今」にする。目標の時刻を過ぎず、並べすぎの上限にも届かない
  // 位置になる。到着基準の予約の「今」は下の `getOutputTimestamp()` で測る (実装が到着の
  // 時刻を測った直後に呼ぶためである)
  const usesWallClockTarget =
    currentTimeSeconds === undefined &&
    playoutAudioInputMapOf(control.playout).get(timestampMicros)?.timestampKind === "wallClock";
  const targetSeconds = usesWallClockTarget
    ? playoutTimelineOf(control.playout).presentationPerformanceMs("audio", timestampMicros)
    : null;
  if (usesWallClockTarget && targetSeconds !== null) {
    reservation.currentTimeSeconds = targetSeconds / 1_000 - AUDIO_CLOCK_DEADBAND_MS / 2_000;
  }
  const audioContext = {
    get currentTime() {
      return reservation.currentTimeSeconds;
    },
    getOutputTimestamp: () => {
      reservation.presentationMs =
        playoutTimelineOf(control.playout).presentationPerformanceMs("audio", timestampMicros) ?? 0;
      if (targetSeconds === null && currentTimeSeconds === undefined) {
        // 到着基準の予約では、「今」もこの時点で測る。実装は到着の時刻を測った直後にここを
        // 呼ぶため、同じ時点の値になる。テストが予約の前に測った値を使うと、実装が到着を
        // 測るまでの実時間の進行 (負荷の高い runner では数百 ms 止まり得る) の分だけ「今」が
        // 過去になり、到着した音が到着基準の遅れより前として捨てられる
        const readAtMs = performance.now();
        const readContextTimeSeconds =
          effectiveMapping.contextTime + (readAtMs - effectiveMapping.performanceTime) / 1_000;
        reservation.currentTimeSeconds =
          Math.max(readContextTimeSeconds, readAtMs / 1_000) + AUDIO_PLAYOUT_DELAY_SECONDS;
      }
      return effectiveMapping;
    },
    createBuffer: (_channels: number, frames: number) => {
      reservation.bufferFrames.push(frames);
      return { copyToChannel: () => {} };
    },
    createBufferSource: () => ({
      buffer: null,
      connect: () => {},
      start: (when: number) => {
        reservation.startedAtSeconds.push(when);
      },
    }),
  } as unknown as AudioContext;
  const audioDestination = {} as MediaStreamAudioDestinationNode;
  installAudioOutput(control, audioContext, audioDestination);

  control.handleAudioDecodedData({
    data: {
      numberOfChannels: 1,
      sampleRate: 48_000,
      numberOfFrames: 960,
      timestamp: timestampMicros,
      copyTo: () => {},
      close: () => {},
    } as unknown as AudioData,
  });
  return reservation;
}

// 完了条件: 音が 1 つ抜けたときは、前の音の終わりから次の音の開始までの隙間を
// 直前の音の時間伸長で埋めて予約する (無音のまま残さない)
test("handleAudioDecodedData: 音が抜けた分の隙間を補間して予約する", () => {
  const { control, errors } = createAvSyncSubscriber();
  // 映像も購読している (音声だけの下限を足さない) 状態にする
  control.receivedCatalog = makeAudioVideoCatalog({ isLive: true }, { isLive: true });
  control.extractTrackInfo();
  // 目標を使わない (壁時計の TIMESTAMP を持たない) 到着基準の並べ方にする
  const first = playAudioFrame(control, 0, null, 10);
  assert.equal(first.bufferFrames.length, 1, "最初の音だけを予約すること");
  // 40 ms 後の timestamp の音が届く (20 ms の音が 1 つ抜けている)
  const second = playAudioFrame(control, 40_000, null, 10.02);
  // 1 つ目は隙間の補間、2 つ目は届いた音である
  assert.equal(second.bufferFrames.length, 2, "補間と音の 2 つを予約すること");
  assert.equal(second.startedAtSeconds.length, 2);
  // 補間は 20 ms 分 (48 kHz で 960 サンプル) を作る
  assert.equal(second.bufferFrames[0], 960, "補間の長さが隙間と同じであること");
  // 補間は前の音の終わり (10.07) から、届いた音の開始 (10.09) までを埋める。前の音は
  // 到着 (10 s) と再生の遅れ (50 ms) で 10.05 に鳴り始め、20 ms の長さで 10.07 に終わる
  assert.closeTo(second.startedAtSeconds[0] ?? 0, 10.07, 1e-9);
  assert.closeTo(second.startedAtSeconds[1] ?? 0, 10.09, 1e-9);
  assert.equal(errors.length, 0);
});

// 完了条件 (欠陥 4): Object を復号へ渡す時点で入力の遅れ (Object の到着 - LOC TIMESTAMP) を
// 測り、復号の出力で同じ TIMESTAMP から引いて、受信側の追いつきへ渡す。経路が遅いだけの
// 状態 (入力の遅れも出力の遅れも同じだけ大きい) では作り直しを求めない
test("handleAudioDecodedData: 復号へ渡す時点の入力の遅れを、復号の出力で引いて渡す", () => {
  const { control, errors } = createAvSyncSubscriber();
  const decodedTimestamps = installTimestampRecordingAudioDecoder(control);
  control.receivedCatalog = makeAudioVideoCatalog({ isLive: true }, { isLive: true });
  control.extractTrackInfo();

  // 復号の出力の遅れ (到着 - TIMESTAMP) が 200 ms 前後になる Object を復号へ渡す
  const wallClockTimestamp = Math.round((performance.timeOrigin + performance.now() - 200) * 1_000);
  control.handleAudioObject({
    groupId: 1n,
    objectId: 0n,
    status: 0,
    payload: new Uint8Array([0xaa]),
    properties: LOC.encodeAudioProperties({ timestamp: BigInt(wallClockTimestamp) }),
  });
  assert.deepEqual(decodedTimestamps, [wallClockTimestamp], "復号へ渡すこと");
  assert.closeTo(
    playoutAudioInputMapOf(control.playout).get(wallClockTimestamp)?.inputLagMs ?? 0,
    200,
    20,
    "復号へ渡す時点の入力の遅れを覚えること",
  );

  // 復号の出力 (同じ TIMESTAMP) を鳴らす。入力の遅れを引いた「復号が足している遅れ」は小さい
  playAudioFrame(control, wallClockTimestamp, null, 10);

  const snapshot = playoutAudioOf(control.playout).catchUp.snapshot();
  assert.closeTo(snapshot.inputLagMs ?? 0, 200, 20, "入力の遅れを復号の出力で引くこと");
  assert.isBelow(
    snapshot.decodeLagMs ?? Number.NaN,
    AUDIO_RECEIVE_CATCH_UP_MIN_MS,
    "復号が足している遅れは小さいこと",
  );
  assert.equal(snapshot.catchUpStarts, 0, "経路が遅いだけの状態では作り直さないこと");
  // 引いた記録は残さない (出力されなかった分が溜まらない)
  assert.equal(playoutAudioInputMapOf(control.playout).size, 0, "引いた分は忘れること");
  assert.equal(errors.length, 0);
});

// 完了条件: TIMESCALE がある TIMESTAMP (メディア時刻) は壁時計と対応しないため、入力の遅れを
// 測らない。復号の出力では入力の遅れが無いものとして扱い、出力の遅れだけを使う
test("handleAudioDecodedData: メディア時刻の Object では入力の遅れを測らない", () => {
  const { control, errors } = createAvSyncSubscriber();
  const decodedTimestamps = installTimestampRecordingAudioDecoder(control);
  control.receivedCatalog = makeAudioVideoCatalog({ isLive: true }, { isLive: true });
  control.extractTrackInfo();

  // TIMESCALE がある TIMESTAMP はメディア時刻である (1 秒 = 1000 の目盛り)。
  // デコーダへはマイクロ秒へ換算して渡す
  control.handleAudioObject({
    groupId: 1n,
    objectId: 0n,
    status: 0,
    payload: new Uint8Array([0xaa]),
    properties: LOC.encodeAudioProperties({ timestamp: 1_000n, timescale: 1_000n }),
  });
  const decodedTimestamp = 1_000_000;
  assert.deepEqual(decodedTimestamps, [decodedTimestamp], "マイクロ秒へ換算して渡すこと");
  // メディア時刻でも TIMESTAMP の種類と実際に保持した時間は記録するが、入力の遅れは測らない
  const mediaTimeRecord = playoutAudioInputMapOf(control.playout).get(decodedTimestamp);
  assert.equal(mediaTimeRecord?.timestampKind, "mediaTime", "メディア時刻として記録すること");
  assert.isNull(mediaTimeRecord?.inputLagMs, "メディア時刻では入力の遅れを測らないこと");

  playAudioFrame(control, decodedTimestamp, null, 10);

  // 壁時計ではないため、追いつきの観測そのものを行わない
  assert.isNull(playoutAudioOf(control.playout).catchUp.snapshot().inputLagMs);
  assert.equal(errors.length, 0);
});

// 完了条件: 音声の再生の統計が getStats から読める。時間はミリ秒で返る
test("getStats: 音声の再生の統計を返す", () => {
  const { control } = createAvSyncSubscriber();
  // 最初の音と、40 ms 後の音 (20 ms の音が 1 つ抜けている) を鳴らす
  playAudioFrame(control, 0, null, 10);
  const second = playAudioFrame(control, 40_000, null, 10.02);
  assert.equal(second.startedAtSeconds.length, 2);
  const stats = (control as unknown as { getStats(): MediaReceiverStats }).getStats().audio;
  assert.isNotNull(stats);
  // 補間を 1 回 (20 ms) 行い、取り直しも捨てもしていない
  assert.equal(stats?.playoutRebases, 0);
  assert.equal(stats?.playoutDrops, 0);
  assert.equal(stats?.playoutConcealments, 1);
  assert.closeTo(stats?.playoutConcealedMs ?? 0, 20, 1e-6);
  assert.closeTo(stats?.playoutCompressedMs ?? 0, 0, 1e-6);
  // 到着基準の並べ方では遅れ (詰めの対象) を持たない
  assert.equal(stats?.playoutLatenessMs, 0);
});

// 完了条件: 詰めと遅れの統計もミリ秒換算で返る (非 0 の値で固定する)
test("getStats: 詰めと遅れの統計をミリ秒で返す", () => {
  const { control } = createAvSyncSubscriber();
  // 詰めるにはキューの余裕 (直前の音の終わり - (今 + 余裕)) が要る。まっさらな scheduler には
  // 直前の音が無く (余裕が 0)、いまは余裕の分しか詰めないため、目標が未来の音を 1 つ先に
  // 並べて余裕を作る (直前の音の終わりは 10.22 になる。旧挙動ではキューが空でも詰めていた)
  playoutAudioSchedulerOf(control.playout).schedule(10, 0, 0.02, {
    targetStartSeconds: 10.2,
    arrivalSeconds: 10,
    enforceTarget: true,
    delaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
    arrivalDelaySeconds: AUDIO_PLAYOUT_ARRIVAL_DELAY_SECONDS,
    presentationDelaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
  });
  // 目標を過ぎて届き、今 + 余裕からしか鳴らせない音を作る (遅れ 40 ms を詰める)
  const decision = playoutAudioSchedulerOf(control.playout).schedule(10, 0, 0.02, {
    // 目標を 30 ms 前に置く。今 + 余裕 (10 ms) からしか鳴らせないため、遅れは 40 ms になり、
    // 不感帯 (`AUDIO_PLAYOUT_STRETCH_MIN_SECONDS` = 20 ms) を超える
    targetStartSeconds: 10 - 0.03,
    arrivalSeconds: 10,
    enforceTarget: true,
    delaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
    arrivalDelaySeconds: AUDIO_PLAYOUT_ARRIVAL_DELAY_SECONDS,
    presentationDelaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
  });
  assert.equal(decision.kind, "play");
  if (decision.kind !== "play") {
    return;
  }
  playoutAudioSchedulerOf(control.playout).confirmStretch(decision.compressSeconds);
  assert.isAbove(decision.compressSeconds, 0);
  assert.isAbove(playoutAudioSchedulerOf(control.playout).lateness, 0);
  const stats = (control as unknown as { getStats(): MediaReceiverStats }).getStats().audio;
  assert.closeTo(stats?.playoutCompressedMs ?? 0, decision.compressSeconds * 1_000, 1e-6);
  assert.closeTo(
    stats?.playoutLatenessMs ?? 0,
    playoutAudioSchedulerOf(control.playout).lateness * 1_000,
    1e-6,
  );
  // 基準の取り直しと捨てを 1 回ずつ作り、写像も非 0 で固定する
  // 到着した音がまだ鳴っていない位置は到着の時刻そのもの (対応の無い環境)
  const arrival = {
    targetStartSeconds: null,
    arrivalSeconds: 100,
    enforceTarget: false,
    delaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
    arrivalDelaySeconds: AUDIO_PLAYOUT_ARRIVAL_DELAY_SECONDS,
    presentationDelaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
  };
  playoutAudioSchedulerOf(control.playout).schedule(100, 0, 0.02, arrival);
  playoutAudioSchedulerOf(control.playout).schedule(200, 20_000, 0.02, {
    ...arrival,
    arrivalSeconds: 200,
  });
  playoutAudioSchedulerOf(control.playout).schedule(300, 0, 0.02, {
    targetStartSeconds: 300.5,
    arrivalSeconds: 300,
    enforceTarget: true,
    delaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
    arrivalDelaySeconds: AUDIO_PLAYOUT_ARRIVAL_DELAY_SECONDS,
    presentationDelaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
  });
  const updated = (control as unknown as { getStats(): MediaReceiverStats }).getStats().audio;
  assert.isAbove(updated?.playoutRebases ?? 0, 0);
  assert.equal(updated?.playoutRebases, playoutAudioSchedulerOf(control.playout).rebases);
  assert.isAbove(updated?.playoutDrops ?? 0, 0);
  assert.equal(updated?.playoutDrops, playoutAudioSchedulerOf(control.playout).drops);
});

// 完了条件: 音声の再生の観測値 (再生予定時刻・到着時刻・鳴り始める時刻・予定に対する余裕)
// が getStats から読める。音声の語尾が聞こえないとき、再生予定に間に合っていたのかを
// この値で切り分ける。累積のカウンタ (playoutDrops) は件数しか持たないため、長さも出す
test("getStats: 音声の再生の観測値を返す", () => {
  const { control, errors } = createAvSyncSubscriber();
  const mapping = audioClockMappingAt(avSyncReferenceMs());
  const wallClockTimestamp = wallClockTimestampMicrosFor(mapping);
  // 対応と、その対応を基準にした TIMESTAMP を同じ時刻で観測する
  const observedWallClockMs = performance.timeOrigin + performance.now();
  playoutTimelineOf(control.playout).observe("audio", observedWallClockMs, wallClockTimestamp);
  playoutTimelineOf(control.playout).observe("video", observedWallClockMs, wallClockTimestamp);
  control.playout.trackAudioDecodeInput(wallClockTimestamp, { timestampKind: "wallClock" });

  const reservation = playAudioFrame(control, wallClockTimestamp, mapping);
  assert.equal(reservation.startedAtSeconds.length, 1, "音を 1 つ予約すること");

  const timing = (control as unknown as { getStats(): MediaReceiverStats }).getStats().audio
    ?.playoutTiming;
  assert.isNotNull(timing);
  // 鳴らすと決めた音を 1 つ数え、実際に鳴る長さ (960 サンプル / 48 kHz = 20 ms) を足す
  assert.equal(timing?.playedFrames, 1);
  assert.closeTo(timing?.playedMs ?? 0, 20, 1e-6);
  assert.equal(timing?.unplannedFrames, 0, "予定を決められた音として数えること");
  assert.equal(timing?.missedFrames, 0);
  assert.equal(timing?.missedMs, 0);
  // 到着時刻は復号の出力を受け取った時刻であり、予約より前である
  const arrivalMs = timing?.lastArrivalMs ?? 0;
  assert.isAbove(arrivalMs, 0);
  assert.isNotNull(timing?.lastTargetMs, "LOC TIMESTAMP から再生予定時刻を決めること");
  // 鳴り始める時刻は、予約した時刻 (AudioContext の秒) を対応で performance 軸へ
  // 換算した値である
  const expectedStartMs =
    (reservation.startedAtSeconds[0] ?? 0) * 1_000 -
    (mapping.contextTime * 1_000 - mapping.performanceTime);
  assert.closeTo(timing?.lastStartMs ?? 0, expectedStartMs, 1e-6);
  assert.closeTo(
    timing?.lastStartDelayMs ?? 0,
    (timing?.lastStartMs ?? 0) - arrivalMs,
    1e-6,
    "鳴るまでの時間は到着から鳴り始めるまでであること",
  );
  assert.closeTo(
    timing?.lastLatenessMs ?? 0,
    (timing?.lastStartMs ?? 0) - (timing?.lastTargetMs ?? 0),
    1e-6,
    "予定からの遅れは鳴り始める時刻と予定の差であること",
  );
  // 予定より前に届いている (余裕がある) ため、間に合わなかったわけではない
  assert.closeTo(timing?.lastSlackMs ?? 0, (timing?.lastTargetMs ?? 0) - arrivalMs, 1e-6);
  assert.isAbove(timing?.lastSlackMs ?? 0, 0);
  // 分布も同じ値から求める (1 件なので 3 つとも同じ値)
  assert.isNotNull(timing?.slackMs);
  assert.equal(timing?.slackMs?.p50, timing?.slackMs?.max);
  assert.equal(errors.length, 0);
});

/**
 * 完了条件: 音声の予約時刻は、共有の時間軸が決めた目標の表示時刻
 * (`Timestamp + 基準の遅れ + max(targetLatency, 再生遅延)`) を
 * `getOutputTimestamp` の `{ contextTime, performanceTime }` で `AudioContext.currentTime` の
 * 秒へ換算した値になる。実物と同じく `contextTime` と `performanceTime` を一致させ、
 * 予約のたびに取り直しても対応が変わらない状態で確かめる。
 */
test("handleAudioDecodedData: 対応が無いときは目標の表示時刻を換算できない", () => {
  const { control, errors } = createAvSyncSubscriber();
  resolveAvSyncTracks(control);
  // 対応と、その対応を基準にした TIMESTAMP を同じ時刻で観測する
  const mapping = audioClockMappingAt(avSyncReferenceMs());
  const wallClockTimestamp = wallClockTimestampMicrosFor(mapping);
  const observedWallClockMs = performance.timeOrigin + performance.now();
  playoutTimelineOf(control.playout).observe("audio", observedWallClockMs, wallClockTimestamp);
  playoutTimelineOf(control.playout).observe("video", observedWallClockMs, wallClockTimestamp);
  control.playout.trackAudioDecodeInput(wallClockTimestamp, { timestampKind: "wallClock" });

  // getOutputTimestamp が未開始 (0/0) のときは対応が無いため、目標の表示時刻を
  // AudioContext の秒へ換算できない (音声の出力遅延も無い)
  const reservation = playAudioFrame(control, wallClockTimestamp, null);

  assert.equal(reservation.deviceDelayMs, 0);
  assert.isAbove(reservation.presentationMs, 0);
  // 対応が無いので、この音は到着基準 (今 + 再生の遅れ) で予約される
  assert.equal(reservation.startedAtSeconds.length, 1);
  const startedAtMs = (reservation.startedAtSeconds[0] ?? 0) * 1_000;
  // 予約には明示された targetLatency の下限も入る。閉ループの内部目標だけではない。
  const playoutDelayMs =
    playoutTimelineOf(control.playout).presentationExtraDelayMs ?? AUDIO_PLAYOUT_DELAY_FLOOR_MS;
  assert.isAbove(startedAtMs, reservation.currentTimeSeconds * 1_000);
  assert.isAtMost(
    startedAtMs,
    reservation.currentTimeSeconds * 1_000 + playoutDelayMs + AV_SYNC_START_TOLERANCE_MS,
  );
  assert.equal(errors.length, 0);
});

/**
 * 完了条件: 音声の予約時刻は、共有の時間軸が決めた目標の表示時刻
 * (`Timestamp + 基準の遅れ + max(targetLatency, 再生遅延)`) を
 * `getOutputTimestamp` の `{ contextTime, performanceTime }` で `AudioContext.currentTime` の
 * 秒へ換算した値になる。
 */
test("handleAudioDecodedData: 目標の表示時刻を getOutputTimestamp で換算して予約する", () => {
  const { control, errors } = createAvSyncSubscriber();
  resolveAvSyncTracks(control);
  // 対応と、その対応を基準にした TIMESTAMP を同じ時刻で観測する
  const mapping = audioClockMappingAt(avSyncReferenceMs());
  const wallClockTimestamp = wallClockTimestampMicrosFor(mapping);
  const observedWallClockMs = performance.timeOrigin + performance.now();
  playoutTimelineOf(control.playout).observe("audio", observedWallClockMs, wallClockTimestamp);
  playoutTimelineOf(control.playout).observe("video", observedWallClockMs, wallClockTimestamp);
  control.playout.trackAudioDecodeInput(wallClockTimestamp, { timestampKind: "wallClock" });

  const reservation = playAudioFrame(control, wallClockTimestamp, mapping);

  assert.equal(reservation.startedAtSeconds.length, 1);
  // 予約時刻は「目標の表示時刻 + 音声の出力遅延」を AudioContext の秒にした値になる
  assert.closeTo(
    (reservation.startedAtSeconds[0] ?? 0) * 1_000,
    expectedStartMs(reservation),
    AV_SYNC_START_TOLERANCE_MS,
  );
  // 目標の表示時刻には共有の時間軸の式 (max(targetLatency, 再生遅延)) が効いていること
  assert.equal(playoutTimelineOf(control.playout).targetLatencyMs, AV_SYNC_TARGET_LATENCY_MS);
  // 再生の観測後も、到着推定の開始値 80 ms と閉ループの開始値 50 ms の大きい方を使う。
  // 最初の観測だけで 100 ms へ跳ね上げない
  assert.equal(
    playoutTimelineOf(control.playout).playoutDelayMs,
    AUDIO_DELAY_START_MS,
    "到着の分布が揃うまでは初期の余裕を保つこと",
  );
  assert.equal(errors.length, 0);
});

/**
 * 完了条件: `targetLatency` が上限 (`MAX_PLAYOUT_DELAY_MS` = 500 ms) に近いときも音を捨てない。
 *
 * 並べすぎの上限は「表示に使う遅れ (`max(targetLatency, 再生遅延)`) + 余裕」から決まる。
 * 揺らぎから求めた再生遅延 (NetEq の開始値 80 ms) だけを上限にすると、目標が 300 ms より
 * 先にある音をすべて捨てて無音になる。
 */
test("handleAudioDecodedData: targetLatency が 500 ms でも目標の時刻に予約する", () => {
  const { control, errors } = createAvSyncSubscriber();
  control.receivedCatalog = makeAudioVideoCatalog(
    { isLive: true, targetLatency: MAX_PLAYOUT_DELAY_MS },
    { isLive: true, targetLatency: MAX_PLAYOUT_DELAY_MS },
  );
  control.extractTrackInfo();
  // 対応と、その対応を基準にした TIMESTAMP を同じ時刻で観測する
  const mapping = audioClockMappingAt(avSyncReferenceMs());
  const wallClockTimestamp = wallClockTimestampMicrosFor(mapping);
  const observedWallClockMs = performance.timeOrigin + performance.now();
  playoutTimelineOf(control.playout).observe("audio", observedWallClockMs, wallClockTimestamp);
  playoutTimelineOf(control.playout).observe("video", observedWallClockMs, wallClockTimestamp);
  control.playout.trackAudioDecodeInput(wallClockTimestamp, { timestampKind: "wallClock" });

  // 「今」を目標の表示時刻の 500 ms 前にする (目標との距離が表示に使う遅れと等しい)
  const targetPerfMs =
    playoutTimelineOf(control.playout).presentationPerformanceMs("audio", wallClockTimestamp) ?? 0;
  const targetSeconds = (targetPerfMs + AV_SYNC_AUDIO_DEVICE_DELAY_MS) / 1_000;
  const reservation = playAudioFrame(
    control,
    wallClockTimestamp,
    mapping,
    targetSeconds - MAX_PLAYOUT_DELAY_MS / 1_000,
  );

  assert.equal(errors.length, 0);
  assert.equal(reservation.startedAtSeconds.length, 1, "音を捨てないこと");
  assert.closeTo(
    (reservation.startedAtSeconds[0] ?? 0) * 1_000,
    expectedStartMs(reservation),
    AV_SYNC_START_TOLERANCE_MS,
  );
});

/**
 * 完了条件: `getOutputTimestamp()` の対応が予約のたびに変わっても、差が
 * `AUDIO_CLOCK_DEADBAND_MS` 未満なら前の対応を使い、予約時刻が跳ねない。
 */
test("handleAudioDecodedData: 対応の差が不感帯未満なら前の対応を使う", () => {
  const { control, errors } = createAvSyncSubscriber();
  resolveAvSyncTracks(control);
  // 対応と、その対応を基準にした TIMESTAMP を同じ時刻で観測する
  const firstMapping = audioClockMappingAt(avSyncReferenceMs());
  const wallClockTimestamp = wallClockTimestampMicrosFor(firstMapping);
  const observedWallClockMs = performance.timeOrigin + performance.now();
  playoutTimelineOf(control.playout).observe("audio", observedWallClockMs, wallClockTimestamp);
  playoutTimelineOf(control.playout).observe("video", observedWallClockMs, wallClockTimestamp);
  control.playout.trackAudioDecodeInput(wallClockTimestamp, { timestampKind: "wallClock" });

  // 1 つ目の予約で時計の対応を作る (復号の出力の種類は 1 つの音につき 1 回だけ引かれる)
  playAudioFrame(control, wallClockTimestamp, firstMapping);
  control.playout.trackAudioDecodeInput(wallClockTimestamp, { timestampKind: "wallClock" });

  // 2 つ目の対応は、1 つ目と同じ出力遅延で `AUDIO_CLOCK_DEADBAND_MS` の 3 分の 1 だけ
  // ずらす (実物の読み取りの揺れに相当する)。予約の直前に取り直す
  const jitterMs = AUDIO_CLOCK_DEADBAND_MS / 3;
  const secondReferenceMs = avSyncReferenceMs();
  const jitteredMapping: AudioClockMapping = {
    contextTime: secondReferenceMs / 1_000 + (AV_SYNC_AUDIO_DEVICE_DELAY_MS + jitterMs) / 1_000,
    performanceTime: secondReferenceMs,
  };
  // 1 つ目と同じ装置の遅延であること (差は `AUDIO_CLOCK_DEADBAND_MS` の内側)
  const firstDeviceDelayMs = firstMapping.contextTime * 1_000 - firstMapping.performanceTime;
  const jitteredDeviceDelayMs =
    jitteredMapping.contextTime * 1_000 - jitteredMapping.performanceTime;
  playAudioFrame(control, wallClockTimestamp, jitteredMapping);

  // 差が不感帯の内側であること (取り直しても対応を動かさない条件)
  assert.isBelow(Math.abs(jitteredDeviceDelayMs - firstDeviceDelayMs), AUDIO_CLOCK_DEADBAND_MS);
  // 前の対応のまま (揺れた分は換算に乗らない)
  const bridgeOffsetMs = playoutAudioClockOf(control.playout).currentOffsetMs;
  assert.isNotNull(bridgeOffsetMs);
  assert.closeTo(bridgeOffsetMs ?? 0, firstDeviceDelayMs, AV_SYNC_TOLERANCE_MS);
  assert.isBelow(Math.abs((bridgeOffsetMs ?? 0) - jitteredDeviceDelayMs), AUDIO_CLOCK_DEADBAND_MS);
  assert.equal(errors.length, 0);
});

/**
 * 完了条件: `getOutputTimestamp()` が未開始 (contextTime と performanceTime が 0) のときは
 * `currentTime` と `performance.now()` の差で代用する。代用は `onError` を通知せず、
 * 統計の `audioClockFallback` に出る。
 */
test("handleAudioDecodedData: getOutputTimestamp が 0/0 でもエラーにせず代用中を統計に出す", () => {
  const { subscriber, control, errors } = createAvSyncSubscriber();
  resolveAvSyncTracks(control);
  const mapping = audioClockMappingAt(avSyncReferenceMs());
  const wallClockTimestamp = wallClockTimestampMicrosFor(mapping);
  const wallClockMs = performance.timeOrigin + performance.now();
  playoutTimelineOf(control.playout).observe("audio", wallClockMs, wallClockTimestamp);
  playoutTimelineOf(control.playout).observe("video", wallClockMs, wallClockTimestamp);
  control.playout.trackAudioDecodeInput(wallClockTimestamp, { timestampKind: "wallClock" });

  // AudioContext は動いている (currentTime が 0 より大きい) が、getOutputTimestamp は
  // まだ 0/0 を返す状態にする。代用の対応は「currentTime - performance.now()」である
  const fallbackCurrentTimeSeconds = performance.now() / 1_000;
  const reservation = playAudioFrame(control, wallClockTimestamp, null, fallbackCurrentTimeSeconds);

  assert.equal(errors.length, 0);
  assert.equal(reservation.startedAtSeconds.length, 1);
  // 代用の対応 (currentTime - performance.now()) で換算した目標の時刻に鳴る
  const fallbackOffsetMs = reservation.currentTimeSeconds * 1_000 - reservation.readAtMs;
  assert.closeTo(
    (reservation.startedAtSeconds[0] ?? 0) * 1_000,
    reservation.presentationMs + fallbackOffsetMs,
    AV_SYNC_TOLERANCE_MS,
  );
  // 代用中は統計に出る (購読が揃っていれば読める)
  markWallClockObserved(control);
  assert.isTrue(subscriber.getStats().avSync?.audioClockFallback);
  assert.equal(errors.length, 0);
});

/**
 * draft-ietf-moq-loc-04 §2.3.1.2:
 * TIMESCALE がある TIMESTAMP はメディア時刻であり壁時計ではないため、目標の表示時刻を
 * 使わず到着基準の並べ方にフォールバックする (`start(when)` は今 + 再生の遅れになる)。
 *
 * 到着の時刻は実装が音を受け取った時点で測るため、テストが測った時刻より必ず後になる。
 * その差は負荷に依存し、CI の遅いランナーでは音声 1 つ分 (20 ms) を超える。したがって
 * 絶対時刻を許容幅で比べず、実装が保証する関係 (どの値からどう決まるか、順序、下限・上限)
 * を確かめる。到着の測定の前後で挟むと、環境に依存しない下限と上限になる。
 */
test("handleAudioDecodedData: TIMESCALE がある TIMESTAMP は到着基準になる", () => {
  const { subscriber, control, errors } = createAvSyncSubscriber();
  // 復号の出力は decoder に渡した timestamp で届く。Object から駆動して対応を確かめる
  const decodedTimestamps = installTimestampRecordingAudioDecoder(control);
  resolveAvSyncTracks(control);
  const mapping = audioClockMappingAt(avSyncReferenceMs());
  const wallClockTimestamp = wallClockTimestampMicrosFor(mapping);
  const observedWallClockMs = performance.timeOrigin + performance.now();
  playoutTimelineOf(control.playout).observe("audio", observedWallClockMs, wallClockTimestamp);
  playoutTimelineOf(control.playout).observe("video", observedWallClockMs, wallClockTimestamp);

  // TIMESCALE がある TIMESTAMP はメディア時刻 (1 秒 = 1000 の目盛り)
  const timescale = 1_000n;
  const mediaTimestamp = 1_500n;
  control.handleAudioObject({
    groupId: 1n,
    objectId: 0n,
    status: 0,
    payload: new Uint8Array([0xaa]),
    properties: LOC.encodeAudioProperties({ timestamp: mediaTimestamp, timescale }),
  });

  // decoder にはマイクロ秒へ換算した値が渡る (§2.3.1.2)
  const decodedTimestamp = Number(LOC.toDecoderMicroseconds(mediaTimestamp, timescale));
  assert.deepEqual(decodedTimestamps, [decodedTimestamp]);

  // 到着基準で鳴らすときの再生の遅れは、共有の時間軸が学習した値 (この予約ではまだ音を
  // 鳴らしていないため NetEq の開始値 80 ms) を下限 (50 ms) と上限 (100 ms) で切った値で
  // ある (src/playout/timeline.ts の `audioArrivalPlayoutDelayMs`)。鳴らした後は閉ループ
  // (observeAudioPlayout) が動かすため、予約の前に読む
  const arrivalDelayMs = audioArrivalPlayoutDelayMs(
    playoutTimelineOf(control.playout).playoutDelayMs ?? AUDIO_PLAYOUT_DELAY_FLOOR_MS,
  );
  const reservation = playAudioFrame(control, decodedTimestamp, mapping);
  // 実装が到着を測る時刻は、テストが測った `readAtMs` と、呼び出しが戻った時刻の間にある
  const returnedAtMs = performance.now();

  // 目標を使わないため、基準は「到着した音がまだ鳴っていない位置 + 再生の遅れ」になる
  assert.equal(reservation.startedAtSeconds.length, 1);
  // 到着基準の再生の遅れは下限 (50 ms) と上限 (100 ms) の間にある
  assert.isAtLeast(arrivalDelayMs, AUDIO_PLAYOUT_DELAY_FLOOR_MS);
  assert.isAtMost(arrivalDelayMs, AUDIO_PLAYOUT_ARRIVAL_DELAY_MS);
  // 予約時刻は「到着の位置 + 到着基準の遅れ」と「今 + 余裕」の遅い方になる。到着の位置は、
  // 予約のときに測った時刻を getOutputTimestamp の対応で AudioContext の秒へ換算した値
  // (予約のたびに AudioClockBridge が取り直す)
  const startMs = (reservation.startedAtSeconds[0] ?? 0) * 1_000;
  const earliestMs = (reservation.currentTimeSeconds + AUDIO_PLAYOUT_MIN_LEAD_SECONDS) * 1_000;
  const arrivalLowerMs = reservation.readAtMs + reservation.deviceDelayMs;
  const arrivalUpperMs = returnedAtMs + reservation.deviceDelayMs;
  assert.isAtLeast(
    startMs,
    Math.max(arrivalLowerMs + arrivalDelayMs, earliestMs),
    "予約時刻が「到着の下限 + 到着基準の遅れ」と「今 + 余裕」の遅い方より前にならない",
  );
  assert.isAtMost(
    startMs,
    Math.max(arrivalUpperMs + arrivalDelayMs, earliestMs),
    "予約時刻が「到着の上限 + 到着基準の遅れ」と「今 + 余裕」の遅い方より後にならない",
  );
  // 壁時計の TIMESTAMP を観測していないため同期の推定は出さない
  assert.isNull(subscriber.getStats().avSync);
  assert.equal(errors.length, 0);
});

/**
 * 完了条件: 共有の時間軸が音声を観測していない (壁時計の TIMESTAMP を持たない) ときも、
 * 到着基準の再生の遅れは下限 `AUDIO_PLAYOUT_DELAY_FLOOR_MS` を下回らない。
 *
 * 共有の再生遅延は音声を観測したときにだけ下限が入る (src/playout/timeline.ts)。音声を
 * 観測していないと揺らぎから求めた小さい値になり、そのまま並べると到着の揺らぎを吸収
 * できずに音が途切れる。
 */
test("handleAudioDecodedData: 音声を観測していなくても再生の遅れが下限を下回らない", () => {
  const { control, errors } = createAvSyncSubscriber();
  control.audioDecoderConfigured = true;
  resolveAvSyncTracks(control);
  const mapping = audioClockMappingAt(avSyncReferenceMs());
  // 映像だけを観測する (音声の復号の出力は観測しない)。共有の再生遅延には音声の下限が
  // 入らず、揺らぎ 0 の映像の値になる
  playoutTimelineOf(control.playout).observe(
    "video",
    performance.timeOrigin + performance.now(),
    wallClockTimestampMicrosFor(mapping),
  );
  // 音声を観測していないため、音声の jitter buffer の遅延は決まらない (映像の遅れは音声へ
  // 影響しない。src/playout/timeline.ts)
  assert.isNull(
    playoutTimelineOf(control.playout).playoutDelayMs,
    "音声を観測していないため音声の遅れは決まらないこと",
  );

  // 目標の表示時刻を使わない音 (Timescale のある TIMESTAMP) として鳴らす
  const decodedTimestamp = 1_500_000;
  control.playout.trackAudioDecodeInput(decodedTimestamp, { timestampKind: "mediaTime" });
  const reservation = playAudioFrame(control, decodedTimestamp, mapping, 1_000);

  assert.equal(errors.length, 0);
  assert.equal(reservation.startedAtSeconds.length, 1);
  // 到着基準の再生の遅れは下限 (50 ms) になる。予約時刻は「到着の位置 + 50 ms」と
  // 「今 + 余裕」の遅い方になる (後者が勝つときは、出力のバッファの分だけ遅れて鳴る)
  const arrivalSeconds = (reservation.readAtMs + reservation.deviceDelayMs) / 1_000;
  assert.closeTo(
    (reservation.startedAtSeconds[0] ?? 0) * 1_000,
    Math.max(
      (arrivalSeconds + AUDIO_PLAYOUT_DELAY_SECONDS) * 1_000,
      (reservation.currentTimeSeconds + AUDIO_PLAYOUT_MIN_LEAD_SECONDS) * 1_000,
    ),
    AV_SYNC_TOLERANCE_MS,
  );
});

/**
 * 完了条件: 音声だけの購読 (映像に合わせる相手がいない) では、到着基準の再生の遅れに
 * 下限 `AUDIO_ONLY_ARRIVAL_DELAY_FLOOR_MS` を足す。Wi-Fi の周期的な停滞は揺らぎの推定に
 * 届かず、上限 100 ms では足りないためである。映像を購読しているときは足さない
 * (前のテストが 50 ms のままであることを固定する)。
 */
test("handleAudioDecodedData: 音声だけの購読では到着基準の再生の遅れに下限を足す", () => {
  const { subscriber, errors } = createTestSubscriber({ audio: {} });
  const control = subscriber as unknown as SubscriberAvSyncControl;
  const mapping = audioClockMappingAt(avSyncReferenceMs());
  // 目標の表示時刻を使わない音 (Timescale のある TIMESTAMP) として鳴らす
  const decodedTimestamp = 1_500_000;
  control.playout.trackAudioDecodeInput(decodedTimestamp, { timestampKind: "mediaTime" });
  const reservation = playAudioFrame(control, decodedTimestamp, mapping, 1_000);

  assert.equal(errors.length, 0);
  assert.equal(reservation.startedAtSeconds.length, 1);
  // 到着基準の再生の遅れは、床 (50 ms) ではなく音声だけの購読の下限 (140 ms) になる
  const arrivalSeconds = (reservation.readAtMs + reservation.deviceDelayMs) / 1_000;
  const arrivalDelayMs = Math.max(
    AUDIO_ONLY_ARRIVAL_DELAY_FLOOR_MS,
    audioArrivalPlayoutDelayMs(
      playoutTimelineOf(control.playout).playoutDelayMs ?? AUDIO_PLAYOUT_DELAY_FLOOR_MS,
    ),
  );
  assert.closeTo(
    (reservation.startedAtSeconds[0] ?? 0) * 1_000,
    Math.max(
      (arrivalSeconds + arrivalDelayMs / 1_000) * 1_000,
      (reservation.currentTimeSeconds + AUDIO_PLAYOUT_MIN_LEAD_SECONDS) * 1_000,
    ),
    AV_SYNC_TOLERANCE_MS,
  );
});

/**
 * 完了条件: 映像を購読する設定でも、catalog で映像トラックを解決できていなければ、音声は
 * 音声だけの購読と同じ並べ方 (目標の開始時刻を守らず、到着基準の遅れに下限を足す) になる。
 *
 * 揃える相手がいるかの判定は、映像の出力を構成したかではなく、catalog で映像トラックを
 * 解決できたか (`videoTrackInfo`) で行う (従来の判定を維持する)。
 */
test("handleAudioDecodedData: 映像トラックが解決できていなければ音声だけの並べ方になる", () => {
  const { subscriber, errors } = createTestSubscriber({ audio: {}, video: {} });
  const control = subscriber as unknown as SubscriberAvSyncControl;
  // catalog を解決していない (映像トラックが無い) 状態のまま駆動する
  assert.isNull(control.videoTrackInfo, "映像トラックを解決できていないこと");
  const mapping = audioClockMappingAt(avSyncReferenceMs());
  // 目標の表示時刻を使わない音 (Timescale のある TIMESTAMP) として鳴らす
  const decodedTimestamp = 1_500_000;
  control.playout.trackAudioDecodeInput(decodedTimestamp, { timestampKind: "mediaTime" });
  // 「今」を到着と同じ軸の時刻にする。到着基準の遅れの項が予約時刻を決めるようにして、
  // 揃える相手の有無で遅れの下限が変わることを読めるようにする (固定の小さい値を渡すと、
  // 経過時間の進み具合によって並べすぎとして捨てられる)
  const reservation = playAudioFrame(control, decodedTimestamp, mapping, performance.now() / 1_000);

  assert.equal(errors.length, 0);
  assert.equal(reservation.startedAtSeconds.length, 1);
  // 音声だけの購読と同じく、到着基準の再生の遅れに下限 (140 ms) を足す
  const arrivalSeconds = (reservation.readAtMs + reservation.deviceDelayMs) / 1_000;
  const arrivalDelayMs = Math.max(
    AUDIO_ONLY_ARRIVAL_DELAY_FLOOR_MS,
    audioArrivalPlayoutDelayMs(
      playoutTimelineOf(control.playout).playoutDelayMs ?? AUDIO_PLAYOUT_DELAY_FLOOR_MS,
    ),
  );
  assert.closeTo(
    (reservation.startedAtSeconds[0] ?? 0) * 1_000,
    Math.max(
      (arrivalSeconds + arrivalDelayMs / 1_000) * 1_000,
      (reservation.currentTimeSeconds + AUDIO_PLAYOUT_MIN_LEAD_SECONDS) * 1_000,
    ),
    AV_SYNC_TOLERANCE_MS,
  );
});

/**
 * draft-ietf-moq-loc-04 §2.3.1.1:
 * TIMESCALE が無い TIMESTAMP は Unix epoch マイクロ秒の壁時計であるため、目標の表示時刻を
 * 使う。TIMESCALE の有無で扱いが変わることを上のテストと対にして固定する。
 */
test("handleAudioDecodedData: TIMESCALE が無い TIMESTAMP は目標の表示時刻を使う", () => {
  const { subscriber, control, errors } = createAvSyncSubscriber();
  const decodedTimestamps = installTimestampRecordingAudioDecoder(control);
  resolveAvSyncTracks(control);
  // TIMESTAMP は観測の時刻そのものにする (基準の遅れが 0 になり、目標の表示時刻が
  // 「観測の時刻 + 表示の遅れ」になる)
  const mapping = audioClockMappingAt(avSyncReferenceMs());
  const observedWallClockMs = performance.timeOrigin + performance.now();
  const wallClockTimestamp = Math.round(observedWallClockMs * 1_000);
  playoutTimelineOf(control.playout).observe("audio", observedWallClockMs, wallClockTimestamp);
  playoutTimelineOf(control.playout).observe("video", observedWallClockMs, wallClockTimestamp);

  // TIMESCALE を付けない TIMESTAMP は壁時計として扱われる
  control.handleAudioObject({
    groupId: 1n,
    objectId: 0n,
    status: 0,
    payload: new Uint8Array([0xaa]),
    properties: LOC.encodeAudioProperties({ timestamp: BigInt(wallClockTimestamp) }),
  });

  const decodedTimestamp = wallClockTimestamp;
  assert.deepEqual(decodedTimestamps, [decodedTimestamp]);

  // 復号の出力の種類は 1 つの音につき 1 回だけ引かれる (予約のたびに登録し直す)
  control.playout.trackAudioDecodeInput(decodedTimestamp, { timestampKind: "wallClock" });
  const reservation = playAudioFrame(control, decodedTimestamp, mapping);
  // 壁時計の TIMESTAMP を観測済みになる (同期の推定を出せる条件)
  assert.isTrue(control.audioWallClockSeen);

  // 壁時計の TIMESTAMP を使っている (同期の推定を出せる条件が立つ)
  // 壁時計の TIMESTAMP なので、目標の表示時刻を AudioContext の秒へ換算して予約する
  // (到着基準との差は予約時刻が再生の遅れの下限より先かどうかで分かる)
  assert.equal(reservation.startedAtSeconds.length, 1);
  assert.closeTo(
    (reservation.startedAtSeconds[0] ?? 0) * 1_000,
    expectedStartMs(reservation),
    AV_SYNC_START_TOLERANCE_MS,
  );
  // 壁時計の TIMESTAMP を使っているため、時計の代用はしていない
  assert.isNotNull(subscriber.getStats());
  assert.isTrue(control.audioWallClockSeen);
  assert.equal(errors.length, 0);
});

/**
 * 映像の表示時刻の検証用の制御口
 */

/** 映像の表示時刻の検証で使う制御口 (書き込み先は基底の videoWriter を使う) */
type SubscriberVideoTimelineControl = SubscriberAvSyncControl;

/**
 * write に渡ったフレームを記録する書き込み先
 *
 * MediaStreamTrackGenerator はブラウザ専用 API であり node 環境に実物がないため、
 * 既存の検証と同じく記録用の最小オブジェクトを注入する (モジュール置換は行わない)。
 */
function createRecordingVideoWriter(): {
  writer: WritableStreamDefaultWriter<VideoFrame>;
  written: VideoFrame[];
} {
  const written: VideoFrame[] = [];
  const writer = {
    write: async (frame: VideoFrame) => {
      written.push(frame);
    },
  } as unknown as WritableStreamDefaultWriter<VideoFrame>;
  return { writer, written };
}

/**
 * 復号したフレームを 1 つ積み、表示時刻に応じた選択を駆動する
 *
 * @param control - 駆動する MediaSubscriber
 * @param timestampMicros - 復号したフレームの TIMESTAMP (壁時計、Unix epoch マイクロ秒)
 * @param videoWriter - 書いたフレームを記録する書き込み先
 */
function driveVideoTimeline(
  control: SubscriberAvSyncControl,
  timestampMicros: number,
  videoWriter: WritableStreamDefaultWriter<VideoFrame>,
): void {
  // 映像のトラックが解決できている状態にする (購読が揃っていることの条件)
  control.videoTrackInfo = makeVideoTrackInfo({ codec: "av01.0.04M.08" });
  control.videoWriter = videoWriter;
  control.playout.trackVideoDecodeInput(timestampMicros, {
    timestampKind: "wallClock",
    location: { group: 0n, object: 0n },
  });
  const frame = createTimestampedRecordingFrame(timestampMicros);
  control.handleVideoDecodedData({ frame: frame.frame });
}

/**
 * 実時間を待つ (表示時刻の到来待ち)
 *
 * 表示時刻は `performance.now()` の軸で決まるため、表示時刻を過ぎたフレームが
 * `write` されることを確かめるには実時間を進める必要がある。上限を付けて待ち、
 * 進まなかったことをテストの失敗として返す (停止しない)。
 */
async function waitForDueMs(targetMs: number): Promise<number> {
  let elapsedMs = 0;
  while (elapsedMs < AV_SYNC_WAIT_TIMEOUT_MS) {
    if (performance.now() >= targetMs) {
      return elapsedMs;
    }
    const stepMs = Math.min(5, AV_SYNC_WAIT_TIMEOUT_MS - elapsedMs);
    await new Promise((resolve) => {
      setTimeout(resolve, stepMs);
    });
    elapsedMs += stepMs;
  }
  return elapsedMs;
}

/**
 * 完了条件: 映像の表示時刻は `Timestamp + 表示の遅れ` の式で決まり、表示時刻を過ぎた
 * フレームだけが `videoWriter.write` に渡る。表示時刻が来ていないフレームは書かない。
 *
 * 表示時刻は `performance.now()` の軸で決まるため、書き込みは表示時刻の到来を実時間で
 * 待って確かめる。値そのものは時間軸の式 (表示時刻 - TIMESTAMP = 表示の遅れ) と突き合わせる。
 */
test("handleVideoDecodedData: 表示時刻を過ぎたフレームだけを書く", async () => {
  const { control, errors } = createAvSyncSubscriber();
  resolveAvSyncTracks(control);
  // 基準の遅れを 0 にして、表示時刻を「観測時刻 + 表示の遅れ」にする
  const observedWallClockMs = performance.timeOrigin + performance.now();
  const timestampMicros = wallClockTimestampMicrosOf(observedWallClockMs);
  playoutTimelineOf(control.playout).observe("audio", observedWallClockMs, timestampMicros);
  playoutTimelineOf(control.playout).observe("video", observedWallClockMs, timestampMicros);

  const presentationMs = playoutTimelineOf(control.playout).presentationPerformanceMs(
    "video",
    timestampMicros,
  );
  const presentationDelayMs = playoutTimelineOf(control.playout).presentationDelayMs;
  assert.isNotNull(presentationMs);
  assert.isNotNull(presentationDelayMs);
  // 表示の遅れが targetLatency になること (基準の遅れは 0)
  assert.closeTo(presentationDelayMs ?? 0, AV_SYNC_TARGET_LATENCY_MS, AV_SYNC_TOLERANCE_MS);

  const { writer, written } = createRecordingVideoWriter();
  clearPendingAnimationFrame();
  installAnimationFrameRecorder();
  try {
    // 表示時刻がまだ来ていないため、この選択では書かず、表示周期に次の選択を予約する
    driveVideoTimeline(control, timestampMicros, writer);
    assert.equal(written.length, 0);
    assert.equal(animationFrameCount, 1);

    // 表示時刻が来たら、予約された表示周期の選択が書く
    await waitForDueMs(presentationMs ?? 0);
    assert.isAtLeast(performance.now(), presentationMs ?? 0);
    runPendingAnimationFrame();
    assert.equal(written.length, 1);
    assert.equal(written[0]?.timestamp, timestampMicros);
  } finally {
    clearPendingAnimationFrame();
    restoreAnimationFrame();
  }
  assert.equal(errors.length, 0);
});

/**
 * 完了条件: 同じ TIMESTAMP の音声と映像が同じ表示時刻から予約されること。音声の
 * `start(when)` は `getOutputTimestamp()` の対応で `AudioContext` の秒へ換算され、映像の
 * 表示時刻は `performance.now()` のミリ秒で決まる。同じ時間軸に同じ TIMESTAMP を
 * 同じ時刻で観測させ、2 つの式が同じ表示の遅れ (TIMESTAMP からの差) を導くことを確かめる。
 *
 * TIMESTAMP は「まだ表示時刻を過ぎていない」値にする。上限で切り下げても表示時刻が
 * 未来に残るため、音声は捨てられず、映像も `write` されずにキューに残る。
 */
test("handleAudioDecodedData と handleVideoDecodedData: 同じ TIMESTAMP は同じ表示の遅れになる", () => {
  const subscriber = createTestSubscriber({ audio: {}, video: {} }, {}).subscriber;
  const control = subscriber as unknown as SubscriberVideoTimelineControl;
  resolveAvSyncTracks(control);
  // 同じ TIMESTAMP を同じ時刻で観測する (基準の遅れと再生遅延が 1 つに決まる)
  const mapping = audioClockMappingAt(avSyncReferenceMs());
  const sharedTimestampMicros = wallClockTimestampMicrosFor(mapping);
  const observedWallClockMs = performance.timeOrigin + performance.now();
  playoutTimelineOf(control.playout).observe("audio", observedWallClockMs, sharedTimestampMicros);
  playoutTimelineOf(control.playout).observe("video", observedWallClockMs, sharedTimestampMicros);
  markWallClockObserved(control);

  // 音声: 目標の表示時刻を AudioContext の秒へ換算する
  control.playout.trackAudioDecodeInput(sharedTimestampMicros, { timestampKind: "wallClock" });
  const recording = playAudioFrame(control, sharedTimestampMicros, mapping);
  assert.equal(recording.startedAtSeconds.length, 1);
  const audioPresentationMs =
    (recording.startedAtSeconds[0] ?? 0) * 1_000 -
    (mapping.contextTime * 1_000 - mapping.performanceTime);

  // 映像: 同じ TIMESTAMP のフレームの表示時刻を式から求める
  const videoPresentationMs = playoutTimelineOf(control.playout).presentationPerformanceMs(
    "video",
    sharedTimestampMicros,
  );
  assert.isNotNull(videoPresentationMs);

  // 表示時刻がまだ来ていないフレームは書かない (キューに残る)
  const { writer: videoWriter, written: videoWritten } = createRecordingVideoWriter();
  clearPendingAnimationFrame();
  installAnimationFrameRecorder();
  try {
    driveVideoTimeline(control, sharedTimestampMicros, videoWriter);
    assert.equal(videoWritten.length, 0);
  } finally {
    clearPendingAnimationFrame();
    restoreAnimationFrame();
  }

  // 2 つの式が導く表示の遅れ (TIMESTAMP からの差) が一致する。表示時刻は
  // 「TIMESTAMP + 基準の遅れ + 表示の遅れ」であり、基準の遅れは観測の時刻で決まる
  const audioDelayMs = audioPresentationMs - sharedTimestampMicros / 1_000;
  const videoDelayMs = (videoPresentationMs ?? 0) - sharedTimestampMicros / 1_000;
  assert.closeTo(audioDelayMs, videoDelayMs, AV_SYNC_TOLERANCE_MS);
  // 予約時刻は「目標の表示時刻 + 音声の出力遅延」になっている
  assert.closeTo(
    (recording.startedAtSeconds[0] ?? 0) * 1_000,
    recording.presentationMs + recording.deviceDelayMs,
    AV_SYNC_START_TOLERANCE_MS,
  );
});
