/**
 * MediaSubscriber の音声と映像の表示時刻の単体テスト
 *
 * targetLatency の解決と映像の時間軸を検証する。音声の出力と時計の結合は
 * tests/e2e/media-playout-audio.spec.ts / media-playout-quality.spec.ts の実 API で検証する。
 * 共通の fixture とヘルパーは src/testSupport/mediaSubscriberTestSupport.ts が持つ。
 */
import { test, assert } from "vite-plus/test";

import { MediaSubscriberImpl } from "./createMediaSubscriber";

import { playoutAudioSchedulerOf, playoutTimelineOf } from "./testSupport/mediaPlayoutInternals";

import type { MediaPlayout } from "./playout/mediaPlayout";

import type { MediaReceiverStats } from "./codec/types";

import { type Catalog, type CatalogTrack } from "./msf";

import {
  AUDIO_PLAYOUT_ARRIVAL_DELAY_SECONDS,
  AUDIO_PLAYOUT_DELAY_SECONDS,
} from "./playout/audioPlayout";

import { MAX_PLAYOUT_DELAY_MS } from "./playout/timeline";

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
  // 映像の表示時刻の検証で使う書き込み先 (実装は write だけを呼ぶ)
  videoWriter: WritableStreamDefaultWriter<VideoFrame> | null;
  audioWallClockSeen: boolean;
  videoWallClockSeen: boolean;
  // トラックを解決できているかを検証するため、extractTrackInfo が読む入力も制御口に含める
  receivedCatalog: Catalog | null;
  extractTrackInfo(): void;
  createOutputStream(): void;
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

/**
 * 音声の壁時計の TIMESTAMP を 1 つ観測させる
 *
 * 映像側の状態遷移を単体で検証するため、実際の時間軸へ観測を記録する。
 * 音声の出力と観測の結合は、実ブラウザの E2E で検証する。
 */
function observeWallClockAudio(control: SubscriberAvSyncControl): void {
  const nowMs = performance.timeOrigin + performance.now();
  playoutTimelineOf(control.playout).observe("audio", nowMs, wallClockTimestampMicrosOf(nowMs));
  control.audioWallClockSeen = true;
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
 * ゲートが開くこと。音声側は共有の時間軸を観測済みにし、ここでは映像側の遷移を検証する。
 */
test("handleVideoDecodedData: 壁時計の TIMESTAMP を持つフレームで avSync のゲートが開く", () => {
  const { subscriber, control, errors } = createAvSyncSubscriber();
  // 音声と映像の track を catalog から解決する (avSync を出せる条件の 1 つ)
  resolveAvSyncTracks(control);
  assert.equal(errors.length, 0);

  // 音声側の時間軸を観測済みにする。実音声の観測の配線は実ブラウザの E2E が検証する。
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

// ============================================================================
// AudioContext と復号フレームのサンプルレートの整合 (docs/AUDIO_GLITCH_CAUSES.md の A1)
//
// AudioContext のレートと復号フレームのレートが食い違うと、AudioBufferSourceNode が
// バッファごとにリサンプルする。ここでは変換を避ける設定だけを検証し、実出力の
// クリックの有無とは区別する。Opus の復号は configure の sampleRate に関係なく常に
// 48 kHz を返すため、AudioContext も復号器の configure も復号のレートへ揃える。
// ============================================================================

/**
 * `createOutputStream` が作った AudioContext のオプションを記録する
 *
 * AudioContext / MediaStream は node 環境に実物が無いブラウザ専用 API であり、
 * `createOutputStream` はグローバルから作る。この 2 つだけを差し替えて (モジュール置換は
 * 行わない) 駆動し、同期の `createOutputStream` の実行中に限定して元に戻す。
 *
 * @param control - 駆動する MediaSubscriber (createOutputStream を呼べる状態)
 * @returns 作られた AudioContext のオプション (作られた順)
 */
function createOutputStreamRecordingAudioContext(control: {
  createOutputStream(): void;
}): AudioContextOptions[] {
  const createdOptions: AudioContextOptions[] = [];
  const target = globalThis as unknown as { AudioContext: unknown; MediaStream: unknown };
  const originalAudioContext = target.AudioContext;
  const originalMediaStream = target.MediaStream;
  target.AudioContext = class {
    readonly state = "running";
    constructor(options: AudioContextOptions) {
      createdOptions.push(options);
    }
    createMediaStreamDestination(): MediaStreamAudioDestinationNode {
      return {
        stream: { getAudioTracks: () => [] },
      } as unknown as MediaStreamAudioDestinationNode;
    }
  };
  target.MediaStream = class {
    addTrack(): void {}
  };
  try {
    control.createOutputStream();
  } finally {
    target.AudioContext = originalAudioContext;
    target.MediaStream = originalMediaStream;
  }
  return createdOptions;
}

/**
 * 完了条件: opus を購読するとき、AudioContext を Catalog の samplerate ではなく復号が
 * 実際に返す 48 kHz で作る。Catalog が 44100 の Opus でも復号は 48 kHz を返すため、
 * Catalog の値で作ると不要なリサンプルが入るため、復号出力へ揃える。
 */
test("createOutputStream: opus は Catalog のレートではなく 48 kHz で AudioContext を作る", () => {
  const subscriber = createTestSubscriber({ audio: {} }).subscriber;
  const control = subscriber as unknown as SubscriberAvSyncControl;
  control.audioTrackInfo = makeAudioTrackInfo({
    codec: "opus",
    samplerate: 44_100,
    channelConfig: "2",
  });
  const createdOptions = createOutputStreamRecordingAudioContext(control);
  assert.equal(createdOptions.length, 1, "AudioContext を 1 つ作ること");
  assert.equal(createdOptions[0]?.sampleRate, 48_000, "復号のレート (48 kHz) で作ること");
});

/**
 * 完了条件: aac を購読するとき、AudioContext を Catalog の samplerate で作る。aac の復号は
 * configure の sampleRate に従うため、Catalog の値で AudioContext と復号フレームのレートが
 * 一致する
 */
test("createOutputStream: aac は Catalog のサンプルレートで AudioContext を作る", () => {
  const subscriber = createTestSubscriber({ audio: {} }).subscriber;
  const control = subscriber as unknown as SubscriberAvSyncControl;
  // Catalog の codec は WebCodecs 形式 (aac は mp4a.40.2)
  control.audioTrackInfo = makeAudioTrackInfo({
    codec: "mp4a.40.2",
    samplerate: 44_100,
    channelConfig: "2",
  });
  const createdOptions = createOutputStreamRecordingAudioContext(control);
  assert.equal(createdOptions.length, 1, "AudioContext を 1 つ作ること");
  assert.equal(createdOptions[0]?.sampleRate, 44_100, "Catalog のレートで作ること");
});

/**
 * 完了条件: codec を解決できない (options にも Catalog にも無い) ときも、AudioContext は
 * 既定の 48 kHz で作り、購読の開始をここで失敗させない。復号器の configure の失敗は
 * setupDecoders が従来どおり通知する
 */
test("createOutputStream: codec を解決できなければ既定の 48 kHz で AudioContext を作る", () => {
  const subscriber = createTestSubscriber({ audio: {} }).subscriber;
  const control = subscriber as unknown as SubscriberAvSyncControl;
  // codec を持たない catalog の track (setupDecoders がエラーにする状態)
  control.audioTrackInfo = { name: "audio", packaging: "loc", isLive: true };
  const createdOptions = createOutputStreamRecordingAudioContext(control);
  assert.equal(createdOptions.length, 1, "AudioContext を 1 つ作ること");
  assert.equal(createdOptions[0]?.sampleRate, 48_000, "既定のレートで作ること");
});

/**
 * 完了条件: opus を購読するとき、AudioDecoder の configure にも Catalog の samplerate では
 * なく復号が実際に返す 48 kHz を渡す。AudioContext の生成と同じ解決値へ揃える
 * (docs/AUDIO_GLITCH_CAUSES.md の A1)
 *
 * AudioDecoderWrapper は WebCodecs の AudioDecoder を作る。node には無いため、その境界
 * だけを置き換えて configure まで到達させる (useWorker: false にして worker を使わない
 * 直接実行にする)。
 */
test("setupDecoders: opus の configure は Catalog のレートではなく 48 kHz にする", async () => {
  const subscriber = createTestSubscriber({
    audio: { codec: "opus" },
    useWorker: false,
  }).subscriber;
  const control = subscriber as unknown as {
    audioTrackInfo: CatalogTrack | null;
    sessionGeneration: number;
    setupDecoders(startGeneration: number): Promise<void>;
  };
  control.audioTrackInfo = makeAudioTrackInfo({
    codec: "opus",
    samplerate: 44_100,
    channelConfig: "2",
  });

  // 差し替えた WebCodecs の AudioDecoder (configure に渡った設定を記録する)
  const target = globalThis as unknown as { AudioDecoder: unknown };
  const originalAudioDecoder = target.AudioDecoder;
  const configured: AudioDecoderConfig[] = [];
  target.AudioDecoder = class {
    readonly state = "configured";
    configure(config: AudioDecoderConfig): void {
      configured.push(config);
    }
    decode(): void {}
    close(): void {}
  };
  try {
    await control.setupDecoders(control.sessionGeneration);
  } finally {
    target.AudioDecoder = originalAudioDecoder;
  }
  assert.equal(configured.length, 1, "configure を 1 回呼ぶこと");
  assert.equal(configured[0]?.codec, "opus");
  assert.equal(configured[0]?.sampleRate, 48_000, "復号のレート (48 kHz) で configure すること");
});
