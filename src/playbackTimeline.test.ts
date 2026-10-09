/**
 * PlaybackTimeline の単体テスト
 *
 * 音声と映像の表示時刻を 1 つの式で決める規則を固定する。
 * 表示時刻 = TIMESTAMP + 基準の遅れ + 表示の遅れ であり、基準の遅れはトラックごとの
 * 「復号の出力の時刻 - TIMESTAMP」の窓の最小値、表示の遅れはトラックごとの jitter buffer の
 * 遅延 (音声は NetEq と同じ 0.95 分位、映像は揺らぎの百分位) である。
 *
 * A/V 同期は 2 つのトラックの表示時刻の差が SYNC_MIN_DELTA_MS を超えたときだけ、先行する
 * 側の表示の遅れを上げる。不感帯の中では 2 つの遅延は独立であり、映像は音声の jitter
 * buffer の遅延に引きずられない。下げるのは毎秒 PLAYBACK_DELAY_DECAY_MS_PER_SECOND まで。
 *
 * PBT (観測の順序と揺らぎの任意の列に対する不変条件) は playbackTimeline.prop.ts が固定する。
 */

import { test, assert } from "vite-plus/test";
import {
  AUDIO_PLAYOUT_ARRIVAL_DELAY_MS,
  AUDIO_PLAYOUT_DELAY_FLOOR_MS,
  MAX_PLAYOUT_DELAY_MS,
  PLAYBACK_DELAY_DECAY_MS_PER_SECOND,
  PLAYBACK_DISCONTINUITY_MS,
  PLAYOUT_BASE_DRIFT_MS,
  PLAYOUT_BASE_MAX_DIFFERENCE_MIN_MS,
  PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS,
  PLAYOUT_QUEUE_HEADROOM_FRAMES,
  PlaybackTimeline,
  SYNC_MIN_DELTA_MS,
} from "./playbackTimeline";
import { AUDIO_CLOCK_DEADBAND_MS } from "./audioPlayout";
import { MAX_PRESENTATION_LAG_MS, PlayoutBuffer } from "./playoutBuffer";

// 送信側の壁時計 (Unix epoch ミリ秒)。メディア時刻 0 の TIMESTAMP にする
const EPOCH_MS = 1_790_263_445_000;
// 30 fps のフレーム間隔 (ミリ秒)
const FRAME_MS = 1_000 / 30;
// 120 fps のフレーム間隔 (ミリ秒)。キューが吸収できる長さが上限 (500 ms) を下回る
const FAST_FRAME_MS = 1_000 / 120;
// 表示待ちのキューの上限 (枚)。createMediaSubscriber と同じ値にする
const MAX_QUEUED_FRAMES = 24;
// TIMESTAMP (約 1.79e15 マイクロ秒) とミリ秒の変換で生じる誤差を許す幅 (ミリ秒)
const TOLERANCE_MS = 0.01;
// 音声の TIMESTAMP が壁時計から遅れる速さ (毎秒ミリ秒)。0754 の実測 (336 秒で 16027 ms) に合わせる
const DRIFT_TEST_MS_PER_SECOND = 48;

/** メディア時刻 (ミリ秒) のフレームの TIMESTAMP (Unix epoch マイクロ秒) */
function timestampOf(mediaMs: number): number {
  return Math.round((EPOCH_MS + mediaMs) * 1_000);
}

/** 表示時刻を求める時間軸を作る */
function createTimeline(): PlaybackTimeline {
  return new PlaybackTimeline({ timeOriginMs: EPOCH_MS, maxQueuedFrames: MAX_QUEUED_FRAMES });
}

/** 表示時刻 (Unix epoch マイクロ秒) をミリ秒にする */
function wallClockMsOf(
  timeline: PlaybackTimeline,
  stream: "audio" | "video",
  mediaMs: number,
): number {
  const wallClockMicros = timeline.presentationWallClockMicros(stream, timestampOf(mediaMs));
  assert.isNotNull(wallClockMicros, "表示時刻が決まること");
  return Number(wallClockMicros) / 1_000;
}

/** 表示時刻 (performance.now() のミリ秒) を返す */
function performanceMsOf(
  timeline: PlaybackTimeline,
  stream: "audio" | "video",
  mediaMs: number,
): number {
  const performanceMs = timeline.presentationPerformanceMs(stream, timestampOf(mediaMs));
  assert.isNotNull(performanceMs, "表示時刻が決まること");
  return performanceMs ?? 0;
}

/**
 * 音声と映像の到着列 (どちらも揺らぎ 0) を与え、2 つのトラックの表示時刻を決めさせる
 *
 * 音声は 20 ms ごと (Opus)、映像は 30 fps。`durationMs` の間、実時間どおりに届く
 */
function observeBothStreams(timeline: PlaybackTimeline, durationMs: number): void {
  const arrivals: { stream: "audio" | "video"; atMs: number; mediaMs: number }[] = [];
  for (let index = 0; index * 20 < durationMs; index++) {
    const mediaMs = index * 20;
    // 音声は 5 個に 1 個が 40 ms 遅れて届く。NetEq の目標遅延は 60 ms になる
    arrivals.push({
      stream: "audio",
      atMs: EPOCH_MS + mediaMs + (index % 5 === 4 ? 40 : 0),
      mediaMs,
    });
  }
  for (let index = 0; index * FRAME_MS < durationMs; index++) {
    const mediaMs = index * FRAME_MS;
    arrivals.push({ stream: "video", atMs: EPOCH_MS + mediaMs, mediaMs });
  }
  arrivals.sort((left, right) => left.atMs - right.atMs);
  for (const arrival of arrivals) {
    timeline.observe(arrival.stream, arrival.atMs, timestampOf(arrival.mediaMs));
  }
}

// 音声の TIMESTAMP だけが壁時計から遅れる到着列を作るときの長さ (ミリ秒)
const DRIFT_TEST_DURATION_MS = 120_000;

/**
 * 音声の TIMESTAMP だけが壁時計から遅れていく到着列を与える (0754 の実測)
 *
 * 音声と映像はどちらも揺らぎ 0 で同じ時刻に届く。音声の TIMESTAMP だけが毎秒
 * `DRIFT_TEST_MS_PER_SECOND` ずつ壁時計から遅れる。
 *
 * @returns 最後に観測したメディア時刻 (ミリ秒)
 */
function observeDriftedStreams(
  timeline: PlaybackTimeline,
  frameRate: number,
  durationMs: number,
): number {
  const frameMs = 1_000 / frameRate;
  const driftPerMs = DRIFT_TEST_MS_PER_SECOND / 1_000;
  let mediaMs = 0;
  for (let index = 0; index * frameMs < durationMs; index++) {
    mediaMs = index * frameMs;
    const observedAtMs = EPOCH_MS + mediaMs;
    timeline.observe("video", observedAtMs, timestampOf(mediaMs));
    timeline.observe("audio", observedAtMs, timestampOf(mediaMs - driftPerMs * mediaMs));
  }
  return mediaMs;
}

// ============================================================================
// 表示時刻の式
// ============================================================================
// 基準が無い間は表示時刻を決めない。呼び出し側は到着基準の再生 (映像は届いた順に 1 枚ずつ)
// へフォールバックする
test("presentationWallClockMicros: まだ観測していなければ表示時刻を決めない", () => {
  const timeline = createTimeline();
  assert.isNull(timeline.presentationWallClockMicros("video", timestampOf(0)));
  assert.isNull(timeline.presentationWallClockMicros("audio", timestampOf(0)));
  assert.isNull(timeline.presentationPerformanceMs("video", timestampOf(0)));
  assert.isNull(timeline.presentationDelayMs);
  assert.isNull(timeline.playoutDelayMs);
  assert.isNull(timeline.videoDelayMs);
});

// 表示時刻 = TIMESTAMP + 基準の遅れ + 表示の遅れ。1 つ目の観測では基準の遅れが
// 「観測の時刻 - TIMESTAMP」になる。音声の表示の遅れは NetEq と同じ規則で、観測が無い間は
// 80 ms (AUDIO_DELAY_START_MS) から始まる。映像はまだ揺らぎを学習していないため 0 ms だが、
// 音声との差が不感帯 (30 ms) を超えるため、同期の制御が 50 ms を足して合わせる
test("presentationWallClockMicros: 最初の観測で TIMESTAMP + 基準の遅れ + 表示の遅れになる", () => {
  const timeline = createTimeline();
  timeline.observe("audio", EPOCH_MS, timestampOf(0));
  timeline.observe("video", EPOCH_MS, timestampOf(0));

  // 基準の遅れ = 0 ms (受信側と送信側の時計が一致)
  assert.closeTo(timeline.playoutDelayMs ?? 0, AUDIO_PLAYOUT_DELAY_FLOOR_MS, TOLERANCE_MS);
  assert.closeTo(
    timeline.videoDelayMs ?? -1,
    AUDIO_PLAYOUT_DELAY_FLOOR_MS - SYNC_MIN_DELTA_MS,
    TOLERANCE_MS,
    "映像は音声の不感帯の手前まで遅れること",
  );
  assert.closeTo(
    wallClockMsOf(timeline, "video", 0),
    EPOCH_MS + AUDIO_PLAYOUT_DELAY_FLOOR_MS - SYNC_MIN_DELTA_MS,
    TOLERANCE_MS,
    "映像は音声の不感帯の手前まで遅れること",
  );
  assert.closeTo(
    wallClockMsOf(timeline, "audio", 0),
    EPOCH_MS + AUDIO_PLAYOUT_DELAY_FLOOR_MS,
    TOLERANCE_MS,
  );
  // performance.now() の軸では performance.timeOrigin (EPOCH_MS) を引いた値になる
  assert.closeTo(performanceMsOf(timeline, "audio", 0), AUDIO_PLAYOUT_DELAY_FLOOR_MS, TOLERANCE_MS);
  assert.closeTo(
    performanceMsOf(timeline, "video", 0),
    AUDIO_PLAYOUT_DELAY_FLOOR_MS - SYNC_MIN_DELTA_MS,
    TOLERANCE_MS,
  );
});

// 映像の遅れは「遅れ - 基準の遅れ」の百分位から求める。窓の p95 が揺らぎより大きくなると
// 映像の表示の遅れになる
test("presentationWallClockMicros: 揺らぎの観測で映像の表示の遅れが決まる", () => {
  // 音声は観測しない (同期の制御を働かせない)
  const timeline = createTimeline();
  // 追いつき中の学習を終えるため、揺らぎ 0 のフレームで CATCH_UP_CHECK_INTERVAL_MS を超える
  for (let index = 0; index < 30; index++) {
    timeline.observe("video", EPOCH_MS + index * FRAME_MS, timestampOf(index * FRAME_MS));
  }
  assert.closeTo(timeline.videoDelayMs ?? -1, 0, TOLERANCE_MS);
  // 100 ms 遅れて届いたフレームが 2 枚あり、窓の p95 が 100 ms になる
  timeline.observe("video", EPOCH_MS + 30 * FRAME_MS + 100, timestampOf(30 * FRAME_MS));
  timeline.observe("video", EPOCH_MS + 31 * FRAME_MS + 100, timestampOf(31 * FRAME_MS));
  assert.closeTo(timeline.videoDelayMs ?? 0, 100, TOLERANCE_MS);
  assert.closeTo(wallClockMsOf(timeline, "video", 0), EPOCH_MS + 100, TOLERANCE_MS);
});

// 音声の jitter buffer の遅延は NetEq と同じ規則で、500 ms ごとの到着の遅れの最大を
// 20 ms バケットのヒストグラムへ入れ、0.95 分位から (1 + バケット) * 20 ms とする。
// 揺らぎが 40 ms の音が続くと 60 ms になる (開始値の 80 ms より下がる)
test("observe: 音声の表示の遅れは NetEq と同じ規則で決まる", () => {
  // 20 ms ごとに届き、5 個に 1 個が 40 ms 遅れて届く (経路の最小の遅れを基準にした揺らぎが
  // 40 ms)。500 ms ごとの最大が 40 ms になり、0.95 分位のバケット 2 から (1 + 2) * 20 = 60 ms
  const timeline = createTimeline();
  for (let index = 0; index < 200; index++) {
    const jitterMs = index % 5 === 4 ? 40 : 0;
    timeline.observe("audio", EPOCH_MS + index * 20 + jitterMs, timestampOf(index * 20));
  }
  assert.closeTo(timeline.playoutDelayMs ?? 0, 60, TOLERANCE_MS);
  // 一定の遅れは揺らぎではないため、目標遅延は上がらない (NetEq と同じで、基準は窓の
  // 最小の遅れのパケットである)
  const steady = createTimeline();
  for (let index = 0; index < 200; index++) {
    steady.observe("audio", EPOCH_MS + index * 20 + 40, timestampOf(index * 20));
  }
  assert.closeTo(steady.playoutDelayMs ?? 0, 20, TOLERANCE_MS);
});

// ============================================================================
// A/V 同期 (表示時刻の差を不感帯に収める)
// ============================================================================

// 2 つのトラックのずれが不感帯 (SYNC_MIN_DELTA_MS) の中にある間は、遅延を変えない。
// 映像は音声の jitter buffer の遅延に引きずられない
test("同期: ずれが不感帯の中なら映像の遅延を音声に合わせない", () => {
  // 音声を揺らぎ 0 で先に観測し、NetEq の目標遅延を開始値の 80 ms から 20 ms へ下げる。
  // その後に映像を観測すると、ずれは 20 ms で不感帯の中に入るため制御は動かない
  const timeline = createTimeline();
  for (let index = 0; index < 200; index++) {
    timeline.observe("audio", EPOCH_MS + index * 20, timestampOf(index * 20));
  }
  assert.closeTo(timeline.playoutDelayMs ?? 0, 20, TOLERANCE_MS);
  timeline.observe("video", EPOCH_MS + 200 * 20, timestampOf(200 * 20));
  assert.closeTo(timeline.videoDelayMs ?? -1, 0, TOLERANCE_MS, "映像は 0 ms のままであること");
});

// ずれが不感帯を超えたら、先行する側 (ここでは映像) の遅延を「音声の遅延 - 不感帯」まで
// 即座に上げる (映像が音声より先行してよい)
test("同期: ずれが不感帯を超えたら映像の遅延を不感帯の手前まで上げる", () => {
  const timeline = createTimeline();
  observeBothStreams(timeline, 12_000);
  const audioDelayMs = timeline.playoutDelayMs ?? 0;
  const videoDelayMs = timeline.videoDelayMs ?? 0;
  // 音声の遅延は NetEq の規則で 60 ms、映像は 0 ms から始まる。ずれ 60 ms が不感帯を
  // 超えるため、映像の遅延が音声の不感帯の手前 (30 ms) まで上がる
  assert.closeTo(audioDelayMs, 60, TOLERANCE_MS);
  assert.isAbove(videoDelayMs, 0, "映像の遅延が上がること");
  assert.isBelow(videoDelayMs, audioDelayMs, "映像が音声の遅延を超えないこと (映像が先行してよい)");
  // 同時刻の表示時刻の差は不感帯ちょうどになる
  const differenceMs = Math.abs(
    wallClockMsOf(timeline, "audio", 11_000) - wallClockMsOf(timeline, "video", 11_000),
  );
  assert.closeTo(differenceMs, SYNC_MIN_DELTA_MS, TOLERANCE_MS);
});

// 同じ TIMESTAMP の音声と映像の表示時刻の差は、同期の制御が働いた後は不感帯に収まる。
// 旧実装は 2 つの遅延の大きい方を共有して差を 0 にしていた (映像が音声の jitter buffer の
// 遅延に引きずられた)。libwebrtc と同じ不感帯を許すことで、映像の遅延を上げずに済ませる
test("presentationWallClockMicros: 同時刻の表示時刻の差が不感帯に収まる", () => {
  const timeline = createTimeline();
  observeBothStreams(timeline, 30_000);
  const differenceMs =
    wallClockMsOf(timeline, "audio", 29_000) - wallClockMsOf(timeline, "video", 29_000);
  assert.isAtMost(Math.abs(differenceMs), SYNC_MIN_DELTA_MS + 5, "差が不感帯に収まること");
  assert.isAbove(differenceMs, 0, "映像の方が先に出ること (音声の方が遅れること)");
});

// ============================================================================
// targetLatency の適用と上限
// ============================================================================

// targetLatency が無いときは 2 つのトラックそれぞれの再生遅延だけを使う
test("setTargetLatencyMs: targetLatency が無いときはトラックごとの再生遅延を使う", () => {
  const timeline = createTimeline();
  timeline.observe("audio", EPOCH_MS, timestampOf(0));
  for (let index = 0; index < 30; index++) {
    timeline.observe("video", EPOCH_MS + index * FRAME_MS, timestampOf(index * FRAME_MS));
  }
  assert.isNull(timeline.targetLatencyMs);
  assert.closeTo(timeline.playoutDelayMs ?? 0, AUDIO_PLAYOUT_DELAY_FLOOR_MS, TOLERANCE_MS);
  // 映像は音声の遅延に同期を合わせて不感帯の手前まで遅れる (自分の揺らぎは 0 ms)
  assert.closeTo(
    timeline.videoDelayMs ?? -1,
    AUDIO_PLAYOUT_DELAY_FLOOR_MS - SYNC_MIN_DELTA_MS,
    TOLERANCE_MS,
  );
  // 再生遅延より小さい targetLatency を渡しても、遅い方 (再生遅延) を使う
  timeline.setTargetLatencyMs(10);
  assert.equal(timeline.targetLatencyMs, 10);
  assert.closeTo(timeline.playoutDelayMs ?? 0, AUDIO_PLAYOUT_DELAY_FLOOR_MS, TOLERANCE_MS);
  // 使わない (isLive が false など) ときは null にする
  timeline.setTargetLatencyMs(null);
  assert.isNull(timeline.targetLatencyMs);
  assert.closeTo(timeline.playoutDelayMs ?? 0, AUDIO_PLAYOUT_DELAY_FLOOR_MS, TOLERANCE_MS);
});

// targetLatency は 2 つのトラックの表示の遅れの下限になる (libwebrtc の
// SetTargetBufferingDelay と同じ)。小さい方を選ぶと表示時刻が期限より前になり、フレームを
// 捨て続けることになる
test("setTargetLatencyMs: targetLatency と再生遅延の大きい方を使う", () => {
  // targetLatency を先に決めてから観測する。両方のトラックが同じ下限になるため、
  // 同期の制御は何も足さない
  const timeline = createTimeline();
  timeline.setTargetLatencyMs(300);
  timeline.observe("audio", EPOCH_MS, timestampOf(0));
  for (let index = 0; index < 30; index++) {
    timeline.observe("video", EPOCH_MS + index * FRAME_MS, timestampOf(index * FRAME_MS));
  }
  // 自分の揺らぎ (80 ms) より targetLatency (300 ms) が大きいため、そちらを使う
  assert.closeTo(timeline.presentationExtraDelayMs ?? 0, 300, TOLERANCE_MS);
  assert.closeTo(timeline.audioDelayMs ?? 0, 300, TOLERANCE_MS);
  assert.closeTo(timeline.videoDelayMs ?? 0, 300, TOLERANCE_MS);
  assert.closeTo(timeline.presentationDelayMs ?? 0, 300, TOLERANCE_MS);
  assert.closeTo(wallClockMsOf(timeline, "video", 0), EPOCH_MS + 300, TOLERANCE_MS);
  assert.closeTo(wallClockMsOf(timeline, "audio", 0), EPOCH_MS + 300, TOLERANCE_MS);
  assert.equal(timeline.targetLatencyLimitedMs, 0, "上限に収まるため切り下げないこと");
});

// targetLatency を上げると片方だけがその下限に当たることがあり、2 つのトラックの表示の
// 遅れの差が変わる。下限を変えた時点で合わせ直す (次の観測を待つと、その間だけ差が開く)
test("setTargetLatencyMs: 下限が変わったらその場で表示時刻を合わせ直す", () => {
  const timeline = createTimeline();
  // 音声の下限 (80 ms) との差で、映像に不感帯の手前までの 50 ms が足されている
  timeline.observe("audio", EPOCH_MS, timestampOf(0));
  timeline.observe("video", EPOCH_MS, timestampOf(0));
  const differenceBeforeMs = Math.abs(
    wallClockMsOf(timeline, "audio", 0) - wallClockMsOf(timeline, "video", 0),
  );
  assert.closeTo(differenceBeforeMs, SYNC_MIN_DELTA_MS, TOLERANCE_MS);

  // 音声の下限より大きい targetLatency を渡すと、両方の下限が 300 ms になる。映像に
  // 足していた分はそのままでは差になるため、その場で音声側へ足して不感帯に収める
  timeline.setTargetLatencyMs(300);
  const differenceAfterMs = Math.abs(
    wallClockMsOf(timeline, "audio", 0) - wallClockMsOf(timeline, "video", 0),
  );
  assert.closeTo(differenceAfterMs, SYNC_MIN_DELTA_MS, TOLERANCE_MS);
  // 2 つのトラックの表示の遅れは、新しい下限 (300 ms) を下回らない
  assert.isAtLeast(timeline.audioDelayMs ?? 0, 300);
  assert.isAtLeast(timeline.videoDelayMs ?? 0, 300);
});

// 基準の差の閾値は、キューが吸収できる長さではなく表示の遅れの上限から引く。30 fps では
// キューが吸収できる長さが 666 ms でも上限は 500 ms であり、上限で切られる分は合わせられない
test("sharingBases: 基準の差が表示の遅れの上限を超えたら共有しない", () => {
  const timeline = createTimeline();
  // 30 fps のフレーム間隔を覚えさせる (キューが吸収できる長さが上限の 500 ms を超える)
  for (let index = 0; index < 30; index++) {
    timeline.observe("video", EPOCH_MS + index * FRAME_MS, timestampOf(index * FRAME_MS));
  }
  // 音声の下限 (80 ms) を引いた 420 ms が閾値になる。421 ms ずらすと共有しない
  timeline.observe(
    "audio",
    EPOCH_MS + (MAX_PLAYOUT_DELAY_MS - AUDIO_PLAYOUT_DELAY_FLOOR_MS + 1),
    timestampOf(0),
  );
  assert.isFalse(timeline.sharingBases);
});

// 表示の遅れの上限は MAX_PLAYOUT_DELAY_MS と、キューが吸収できる長さの小さい方である。
// 上限は基準の遅れではなく表示の遅れの側にだけ掛ける (基準の遅れは送受信の時計のずれであり、
// 切り下げるとすべてのフレームが期限切れになる)
test("setTargetLatencyMs: キュー由来の上限で切り下げ、切り下げた分を統計に出す", () => {
  const timeline = createTimeline();
  // 120 fps のフレーム間隔を覚えさせる。キューが吸収できる長さは
  // (キューの上限 - 余裕) 枚分のフレーム間隔になる
  for (let index = 0; index < 60; index++) {
    timeline.observe("video", EPOCH_MS + index * FAST_FRAME_MS, timestampOf(index * FAST_FRAME_MS));
  }
  const queueCapMs = (MAX_QUEUED_FRAMES - PLAYOUT_QUEUE_HEADROOM_FRAMES) * FAST_FRAME_MS;
  assert.isBelow(queueCapMs, MAX_PLAYOUT_DELAY_MS);
  timeline.setTargetLatencyMs(4_000);
  assert.closeTo(timeline.presentationDelayMs ?? 0, queueCapMs, TOLERANCE_MS);
  assert.closeTo(timeline.targetLatencyLimitedMs, 4_000 - queueCapMs, TOLERANCE_MS);
  // 基準の遅れには上限を掛けない。上限に収まらない targetLatency でも、音声と映像は
  // 同じ値に切り下げられるため同じ表示時刻になる
  timeline.observe("audio", EPOCH_MS, timestampOf(0));
  assert.equal(
    wallClockMsOf(timeline, "audio", 1_000),
    wallClockMsOf(timeline, "video", 1_000),
    "切り下げても同じ表示時刻になること",
  );
});

// 上限が MAX_PLAYOUT_DELAY_MS のときはその値で切り下げる (フレーム間隔を覚えていない間は
// キュー由来の上限が MAX_PLAYOUT_DELAY_MS になる)
test("setTargetLatencyMs: 上限が MAX_PLAYOUT_DELAY_MS のときはその値で切り下げる", () => {
  const timeline = createTimeline();
  timeline.observe("video", EPOCH_MS, timestampOf(0));
  timeline.setTargetLatencyMs(5_000);
  assert.closeTo(timeline.presentationDelayMs ?? 0, MAX_PLAYOUT_DELAY_MS, TOLERANCE_MS);
  assert.closeTo(timeline.targetLatencyLimitedMs, 5_000 - MAX_PLAYOUT_DELAY_MS, TOLERANCE_MS);
});

// 基準の遅れは受信側と送信側の時計のずれを含むため負にもなる。TIMESTAMP が受信側の壁時計より
// 進んでいると、表示の遅れ (TIMESTAMP から表示時刻までの差) は負になる
test("presentationDelayMs: 時計のずれの分だけ負になりうる", () => {
  // 音声は観測しない (同期の制御を働かせない)
  const timeline = createTimeline();
  // 受信側の壁時計では EPOCH_MS のときに、TIMESTAMP が 5 秒先のフレームが届く
  timeline.observe("video", EPOCH_MS, timestampOf(5_000));
  assert.closeTo(timeline.presentationDelayMs ?? 0, -5_000, TOLERANCE_MS);
  // 表示時刻は TIMESTAMP + 負の遅れ = 受信側の壁時計 + 表示の遅れになる
  assert.closeTo(wallClockMsOf(timeline, "video", 5_000), EPOCH_MS, TOLERANCE_MS);
  assert.closeTo(performanceMsOf(timeline, "video", 5_000), 0, TOLERANCE_MS);
});

// ============================================================================
// 基準を共有しないフォールバック
// ============================================================================

// 2 つのトラックの基準の差が、キューが吸収できる長さから表示の遅れを引いた閾値を超えたら
// 同期しない。大きい方のトラックは TIMESTAMP が壁時計からずれているとみなして表示時刻を
// 返さず (到着基準の再生へ落とす)、もう片方は自分の基準で表示時刻を返す。同期を続けると、
// ずれた側の基準が窓の最小値として単調に増え、もう片方の表示時刻が未来へ伸びて 1 枚も
// 描かれなくなる
test("sharingBases: 基準の差が閾値を超えたら共有せず、大きい側は表示時刻を返さない", () => {
  const timeline = createTimeline();
  // 映像の基準 0 ms、音声の基準 1 秒 (TIMESTAMP が壁時計から遅れている)。
  // 差 1 秒は閾値 (キューが吸収できる 500 ms - 表示の遅れ) を超える
  timeline.observe("video", EPOCH_MS, timestampOf(0));
  timeline.observe("audio", EPOCH_MS + 1_000, timestampOf(0));
  assert.isFalse(timeline.sharingBases);
  // ずれた側 (大きい方) の音声は表示時刻を返さない
  assert.isNull(timeline.presentationWallClockMicros("audio", timestampOf(0)));
  assert.isNull(timeline.presentationPerformanceMs("audio", timestampOf(0)));
  // もう片方の映像は自分の基準 (0 ms) と自分の表示の遅れで表示時刻を返す。基準が共有できない
  // ときは、映像を音声の到着基準の時刻 (今の遅れは下限の 80 ms) へ不感帯の手前まで合わせる
  // ため、表示の遅れは 50 ms (80 - 30) になる。ずれた側の基準 (1 秒) は使わない
  const expectedVideoDelayMs = AUDIO_PLAYOUT_DELAY_FLOOR_MS - SYNC_MIN_DELTA_MS;
  assert.closeTo(
    wallClockMsOf(timeline, "video", 0),
    EPOCH_MS + expectedVideoDelayMs,
    TOLERANCE_MS,
  );
});

// 閾値は「キューが吸収できる長さ - 表示の遅れ」である。フレーム間隔を覚えていない間は
// キューが吸収できる長さが上限 (500 ms) であり、表示の遅れ (音声の下限 80 ms) を引いた
// 420 ms が閾値になる。基準の遅れそのものはキューを消費しないため、引かない
test("sharingBases: 閾値の内側なら共有し、表示の遅れが上がると共有しなくなる", () => {
  const timeline = createTimeline();
  timeline.observe("video", EPOCH_MS, timestampOf(0));
  timeline.observe("audio", EPOCH_MS + 400, timestampOf(0));
  const differenceMs = 400;
  const limitMs = MAX_PLAYOUT_DELAY_MS - AUDIO_PLAYOUT_DELAY_FLOOR_MS;
  assert.isAtMost(differenceMs, limitMs, "差が閾値の内側であること");
  assert.isTrue(timeline.sharingBases);
  // max(targetLatency, 再生遅延) が上がると閾値が下がり、同じ差でも共有しなくなる
  timeline.setTargetLatencyMs(400);
  assert.isFalse(timeline.sharingBases);
});

// 閾値は 0 に近いと共有とフォールバックを往復するため、下限
// (PLAYOUT_BASE_MAX_DIFFERENCE_MIN_MS) を置く
test("sharingBases: 閾値の下限を下回る差でも共有しない", () => {
  const timeline = createTimeline();
  timeline.observe("video", EPOCH_MS, timestampOf(0));
  timeline.observe("audio", EPOCH_MS + 150, timestampOf(0));
  // キューが吸収できる 500 ms から targetLatency の 450 ms を引くと 50 ms になり、
  // 下限の 100 ms を使う。差 150 ms は閾値を超える
  timeline.setTargetLatencyMs(MAX_PLAYOUT_DELAY_MS - 50);
  const limitMs = PLAYOUT_BASE_MAX_DIFFERENCE_MIN_MS;
  assert.isAbove(150, limitMs, "差が下限の閾値を超えること");
  assert.isFalse(timeline.sharingBases);
  // 差が下限の内側なら共有する
  const shared = createTimeline();
  shared.observe("video", EPOCH_MS, timestampOf(0));
  shared.observe("audio", EPOCH_MS + limitMs, timestampOf(0));
  shared.setTargetLatencyMs(MAX_PLAYOUT_DELAY_MS - 50);
  assert.isTrue(shared.sharingBases);
});

// ============================================================================
// 観測の窓の学習
// ============================================================================

// 購読の開始では relay の cache から古いフレームがまとまって届く (cache replay)。これは
// 経路の揺らぎではないため、映像の表示の遅れの目標に使わない。使うと表示の遅れが数百
// ミリ秒になり、窓 (10 秒) から抜けた後も毎秒 20 ms でしか下がらない
test("observe: まとまって届いたフレームを表示の遅れの目標に使わない", () => {
  // 30 fps のフレームが 2 ms 間隔で 90 枚 (メディア時刻で 3 秒分) 届く
  // 音声は観測しない (同期の制御を働かせない)
  const timeline = createTimeline();
  for (let index = 0; index < 90; index++) {
    timeline.observe("video", EPOCH_MS + index * 2, timestampOf(index * FRAME_MS));
  }
  assert.closeTo(timeline.videoDelayMs ?? -1, 0, TOLERANCE_MS);
});

// 揺らぎ 0 のフレームが続いても、追いつき中 (CATCH_UP_CHECK_INTERVAL_MS の間) は学習しない。
// 追いついた後の経路の遅れは学習する
test("observe: 追いつき中の揺らぎを表示の遅れの目標に使わない", () => {
  const timeline = createTimeline();
  // 実時間より速く届く (追いつき中)。この間の遅れは経路の揺らぎではない
  timeline.observe("video", EPOCH_MS, timestampOf(0));
  timeline.observe("video", EPOCH_MS + 40, timestampOf(FRAME_MS));
  assert.closeTo(timeline.videoDelayMs ?? -1, 0, TOLERANCE_MS);
  // 追いついた後の 100 ms の遅れは学習する
  for (let index = 2; index < 32; index++) {
    timeline.observe("video", EPOCH_MS + index * FRAME_MS, timestampOf(index * FRAME_MS));
  }
  timeline.observe("video", EPOCH_MS + 32 * FRAME_MS + 100, timestampOf(32 * FRAME_MS));
  timeline.observe("video", EPOCH_MS + 33 * FRAME_MS + 100, timestampOf(33 * FRAME_MS));
  assert.closeTo(timeline.videoDelayMs ?? 0, 100, TOLERANCE_MS);
});

// TIMESTAMP が大きく動くと (publisher の時計の変更や別の publisher への切り替え)、以降の
// フレームがすべて遅れて見え、表示の遅れが上限に張り付く。PLAYBACK_DISCONTINUITY_MS 以上
// 動いたら時間軸ごと基準を取り直す
test("observe: TIMESTAMP が飛んだら基準を取り直す", () => {
  const timeline = createTimeline();
  timeline.observe("audio", EPOCH_MS, timestampOf(0));
  timeline.observe("video", EPOCH_MS, timestampOf(0));
  timeline.observe("video", EPOCH_MS + FRAME_MS, timestampOf(FRAME_MS));
  assert.closeTo(timeline.playoutDelayMs ?? 0, AUDIO_PLAYOUT_DELAY_FLOOR_MS, TOLERANCE_MS);

  // TIMESTAMP が 3 秒進んだフレームが届く (1 時間前の TIMESTAMP が届く場合も同じ扱い)
  const jumpMs = 3_000;
  assert.isAtLeast(jumpMs, PLAYBACK_DISCONTINUITY_MS);
  const atMs = EPOCH_MS + 2 * FRAME_MS;
  timeline.observe("video", atMs, timestampOf(2 * FRAME_MS + jumpMs));
  // 取り直した後は、新しいフレームの基準の遅れで表示時刻を決める。古い基準は残らない
  const jumpedMediaMs = 2 * FRAME_MS + jumpMs;
  assert.closeTo(
    timeline.presentationDelayMs ?? 0,
    atMs - (EPOCH_MS + jumpedMediaMs),
    TOLERANCE_MS,
  );
  assert.closeTo(wallClockMsOf(timeline, "video", jumpedMediaMs), atMs, TOLERANCE_MS);
  // 取り直しの後も音声と映像の遅延はトラックごとに決まるため、ずれは不感帯に収まる
  timeline.observe("audio", atMs, timestampOf(jumpedMediaMs));
  const differenceMs = Math.abs(
    wallClockMsOf(timeline, "audio", jumpedMediaMs + 1_000) -
      wallClockMsOf(timeline, "video", jumpedMediaMs + 1_000),
  );
  assert.isAtMost(differenceMs, MAX_PLAYOUT_DELAY_MS, "取り直した後のずれが上限を超えないこと");
});

// 映像の目標が下がったときは毎秒 PLAYBACK_DELAY_DECAY_MS_PER_SECOND ずつ下げる。急に
// 戻すと表示時刻が前へ飛び、フレームを捨てることになる
test("observe: 映像の表示の遅れを毎秒 PLAYBACK_DELAY_DECAY_MS_PER_SECOND ずつ下げる", () => {
  const timeline = createTimeline();
  let available = 0;
  const delays: { atMs: number; delayMs: number }[] = [];
  for (let index = 0; index < 600; index++) {
    // 200 ms 遅れたフレームが窓の p95 に入り、表示の遅れが 200 ms になる
    const late = index % 100 === 17 || index % 100 === 67;
    available = Math.max(available, index * FRAME_MS + (late ? 200 : 0));
    timeline.observe("video", EPOCH_MS + available, timestampOf(index * FRAME_MS));
    delays.push({ atMs: available, delayMs: timeline.videoDelayMs ?? 0 });
  }
  const last = delays[delays.length - 1];
  assert.isDefined(last);
  // 200 ms から 0 まで一気には下げない (下げる速さは毎秒 20 ms まで)
  assert.isAbove(last?.delayMs ?? 0, 0);
  // どの 1 枚の間でも、下げ幅は経過時間 × 毎秒の速さを超えない
  for (let position = 1; position < delays.length; position++) {
    const previous = delays[position - 1];
    const current = delays[position];
    if (previous === undefined || current === undefined || current.delayMs >= previous.delayMs) {
      continue;
    }
    const allowedMs = (PLAYBACK_DELAY_DECAY_MS_PER_SECOND * (current.atMs - previous.atMs)) / 1_000;
    assert.isAtMost(
      previous.delayMs - current.delayMs,
      allowedMs + TOLERANCE_MS,
      "下げる速さが毎秒 PLAYBACK_DELAY_DECAY_MS_PER_SECOND 以下であること",
    );
  }
});

// ============================================================================
// 実績と同期ずれ
// ============================================================================

// 実績から求める同期ずれは「映像の表示時刻 - 映像の TIMESTAMP」と
// 「音声の表示時刻 - 音声の TIMESTAMP」の差である。両方に同じ差を与えると 0 になる
test("skewMs: 同じ差の実績を記録すると 0 になる", () => {
  const timeline = createTimeline();
  timeline.observe("audio", EPOCH_MS, timestampOf(0));
  timeline.observe("video", EPOCH_MS, timestampOf(0));
  const timestampMicros = timestampOf(1_000);
  timeline.recordPresentation("audio", timestampMicros, BigInt(timestampMicros + 100_000));
  timeline.recordPresentation("video", timestampMicros, BigInt(timestampMicros + 100_000));
  assert.closeTo(timeline.skewMs() ?? -1, 0, TOLERANCE_MS);
});

// 映像の表示が音声より遅れていれば正の値になる。ずれの定義は
// (映像の表示時刻 - 映像の TIMESTAMP) - (音声の表示時刻 - 音声の TIMESTAMP)
test("skewMs: 映像の表示が遅れていれば正になる", () => {
  const timeline = createTimeline();
  timeline.observe("audio", EPOCH_MS, timestampOf(0));
  timeline.observe("video", EPOCH_MS, timestampOf(0));
  const timestampMicros = timestampOf(1_000);
  const delayMs = timeline.presentationDelayMs ?? 0;
  timeline.recordPresentation(
    "audio",
    timestampMicros,
    BigInt(timestampMicros + Math.round(delayMs * 1_000)),
  );
  timeline.recordPresentation(
    "video",
    timestampMicros,
    BigInt(timestampMicros + Math.round((delayMs + 30) * 1_000)),
  );
  assert.closeTo(timeline.skewMs() ?? 0, 30, TOLERANCE_MS);
});

// 片方だけでは同期ずれを推定できない。捨てた音と write しなかったフレームは実績に
// 含めないため、捨てが 1 秒を超えて続くと実績が古くなり null になる
test("skewMs: 片方だけ、または 1 秒より古い実績では値を返さない", () => {
  const timeline = createTimeline();
  timeline.observe("audio", EPOCH_MS, timestampOf(0));
  timeline.observe("video", EPOCH_MS, timestampOf(0));
  const timestampMicros = timestampOf(1_000);
  const delayMs = timeline.presentationDelayMs ?? 0;
  const presentedWallClockMicros = BigInt(timestampMicros + Math.round(delayMs * 1_000));

  // 片方だけでは推定しない
  timeline.recordPresentation("audio", timestampMicros, presentedWallClockMicros);
  assert.isNull(timeline.skewMs());
  timeline.recordPresentation("video", timestampMicros, presentedWallClockMicros);
  assert.closeTo(timeline.skewMs() ?? -1, 0, TOLERANCE_MS);

  // 映像の実績だけが 2 秒後になると、音声の実績が 1 秒より古くなり推定しない
  const laterTimestampMicros = timestampOf(3_000);
  timeline.recordPresentation("video", laterTimestampMicros, presentedWallClockMicros + 2_000_000n);
  assert.isNull(timeline.skewMs());
});

// reset は基準と学習と実績をすべて消し、次の観測で作り直す (購読のやり直し、
// AudioContext の作り直し)
test("reset: 基準と学習と実績を消す", () => {
  const timeline = createTimeline();
  timeline.observe("audio", EPOCH_MS, timestampOf(0));
  timeline.observe("video", EPOCH_MS, timestampOf(0));
  timeline.setTargetLatencyMs(300);
  const timestampMicros = timestampOf(1_000);
  const presentedWallClockMicros = timeline.presentationWallClockMicros("audio", timestampMicros);
  assert.isNotNull(presentedWallClockMicros);
  timeline.recordPresentation("audio", timestampMicros, presentedWallClockMicros ?? 0n);
  timeline.recordPresentation("video", timestampMicros, presentedWallClockMicros ?? 0n);
  assert.closeTo(timeline.skewMs() ?? -1, 0, TOLERANCE_MS);

  timeline.reset();
  assert.isNull(timeline.presentationDelayMs);
  assert.isNull(timeline.playoutDelayMs);
  assert.isNull(timeline.skewMs());
  assert.isNull(timeline.presentationWallClockMicros("video", timestampOf(0)));
  // targetLatency は呼び出し側が決めた値であり、reset では消さない
  assert.equal(timeline.targetLatencyMs, 300);
  // 次の観測で作り直す
  timeline.observe("video", EPOCH_MS, timestampOf(0));
  assert.closeTo(timeline.presentationDelayMs ?? 0, 300, TOLERANCE_MS);
});

// 音声の再生を止めたときは、音声の基準と学習と実績だけを消す。消さないと音声の jitter
// buffer の遅延が映像との同期に残り、音声を一度も再生していない購読より映像の表示が
// 遅れたまま固定される。消した後は残った映像の値だけで表示時刻を決める
test("resetStream: 音声だけを消すと映像だけの値になる", () => {
  const timeline = createTimeline();
  timeline.observe("audio", EPOCH_MS, timestampOf(0));
  for (let index = 0; index < 30; index++) {
    timeline.observe("video", EPOCH_MS + index * FRAME_MS, timestampOf(index * FRAME_MS));
  }
  assert.closeTo(timeline.playoutDelayMs ?? 0, AUDIO_PLAYOUT_DELAY_FLOOR_MS, TOLERANCE_MS);
  // 音声の実績 (同期ずれの推定に使う) も作っておく
  const timestampMicros = timestampOf(1_000);
  const presentedWallClockMicros = timeline.presentationWallClockMicros("video", timestampMicros);
  assert.isNotNull(presentedWallClockMicros);
  timeline.recordPresentation("audio", timestampMicros, presentedWallClockMicros ?? 0n);
  timeline.recordPresentation("video", timestampMicros, presentedWallClockMicros ?? 0n);
  assert.closeTo(timeline.skewMs() ?? -1, 0, TOLERANCE_MS);

  timeline.resetStream("audio");

  // 音声の値は消える
  assert.isNull(timeline.playoutDelayMs);
  // 映像の表示の遅れは揺らぎ 0 のまま (音声の遅延を含まない)
  assert.closeTo(timeline.videoDelayMs ?? -1, 0, TOLERANCE_MS);
  assert.closeTo(wallClockMsOf(timeline, "video", 0), EPOCH_MS, TOLERANCE_MS);
  assert.closeTo(wallClockMsOf(timeline, "video", 1_000), EPOCH_MS + 1_000, TOLERANCE_MS);
  // 消したトラックの実績は残らない
  assert.isNull(timeline.skewMs(), "音声の実績を消すこと");
});

// 世代は「積んでいる映像フレームの表示時刻を決められるか」の目印である (src/playoutBuffer.ts)。
// 音声だけを消すときに世代を進めると、積んでいるフレームが到着順に落ち、表示時刻を待たずに
// 描かれる。音声の再生を止めても映像の表示の規則は変えない
test("resetStream: 世代を進めず、映像の積んだフレームの扱いを変えない", () => {
  const timeline = createTimeline();
  timeline.observe("audio", EPOCH_MS, timestampOf(0));
  timeline.observe("video", EPOCH_MS, timestampOf(0));
  const buffer = new PlayoutBuffer<string>(MAX_QUEUED_FRAMES, timeline);
  const timestampMicros = timestampOf(1_000);
  assert.deepEqual(buffer.enqueue("frame", timestampMicros), [], "あふれずに積めること");
  const presentationMs = buffer.presentationTimeMs(timestampMicros);
  assert.isNotNull(presentationMs, "積んだ時点で表示時刻が決まること");
  const generationBefore = timeline.generation;

  timeline.resetStream("audio");

  assert.equal(timeline.generation, generationBefore, "世代を進めないこと");
  // 表示時刻を過ぎたフレームは、表示時刻どおりに描かれる (到着順に落ちない)。音声を消すと
  // 同期が足していた分も消えるため、表示時刻は映像だけの値 (メディア時刻 + 0 ms) になる
  const selection = buffer.select((presentationMs ?? 0) + 1);
  assert.equal(selection.draw, "frame");
  assert.isNotNull(selection.drawPresentationMs, "表示時刻を使い続けること");
  assert.closeTo(selection.drawPresentationMs ?? -1, 1_000, TOLERANCE_MS);
});

// ============================================================================
// 到着列のシミュレーション
// ============================================================================

/** メディア時刻ごとの揺らぎ (ミリ秒) の列を作る決定論的な擬似乱数 */
function jitterSequence(count: number, seed: number): number[] {
  const values: number[] = [];
  let state = seed;
  for (let index = 0; index < count; index++) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    const roll = state / 2_147_483_648;
    // 2% が 40 ms 遅れ、まれに 200 ms 遅れる。経路の遅延は負にならない
    if (roll < 0.02) {
      values.push(40);
    } else if (roll > 0.999) {
      values.push(200);
    } else {
      values.push(0);
    }
  }
  return values;
}

/**
 * 120 秒の到着列を作る。音声は 20 ms ごと (Opus)、映像は 30 fps で、どちらも自分のメディア
 * 時刻に揺らぎを足した時刻に復号の出力へ出る。返り値は観測の時刻の順に並べた列
 */
function buildArrivals(): { stream: "audio" | "video"; atMs: number; mediaMs: number }[] {
  const durationMs = 120_000;
  const audioFrameMs = 20;
  const audioJitter = jitterSequence(Math.ceil(durationMs / audioFrameMs), 7);
  const videoJitter = jitterSequence(Math.ceil(durationMs / FRAME_MS), 11);
  const arrivals: { stream: "audio" | "video"; atMs: number; mediaMs: number }[] = [];
  for (let index = 0; index * audioFrameMs < durationMs; index++) {
    const mediaMs = index * audioFrameMs;
    arrivals.push({
      stream: "audio",
      atMs: EPOCH_MS + mediaMs + (audioJitter[index] ?? 0),
      mediaMs,
    });
  }
  for (let index = 0; index * FRAME_MS < durationMs; index++) {
    const mediaMs = index * FRAME_MS;
    arrivals.push({
      stream: "video",
      atMs: EPOCH_MS + mediaMs + (videoJitter[index] ?? 0),
      mediaMs,
    });
  }
  arrivals.sort((left, right) => left.atMs - right.atMs);
  return arrivals;
}

// 120 秒の到着列 (揺らぎの p95 が 40 ms 程度、数十秒に 1 回 200 ms 程度の遅れ) を与えても、
// 同じ TIMESTAMP の音声と映像の表示時刻の差は ±50 ms 以内に収まる。ずれの予算は映像の
// write の遅れ (MAX_PRESENTATION_LAG_MS = 20 ms) と不感帯 (30 ms) である
test("presentationWallClockMicros: 120 秒の到着列でも同時刻の表示時刻の差が予算に収まる", () => {
  const timeline = createTimeline();
  for (const arrival of buildArrivals()) {
    timeline.observe(arrival.stream, arrival.atMs, timestampOf(arrival.mediaMs));
  }
  assert.isTrue(timeline.sharingBases, "基準を共有し続けること");
  assert.equal(timeline.targetLatencyLimitedMs, 0, "上限に切り下げられないこと");

  let maxDifferenceMs = 0;
  for (let mediaMs = 110_000; mediaMs < 120_000; mediaMs += FRAME_MS) {
    const audioWallClockMicros = timeline.presentationWallClockMicros(
      "audio",
      timestampOf(mediaMs),
    );
    const videoWallClockMicros = timeline.presentationWallClockMicros(
      "video",
      timestampOf(mediaMs),
    );
    assert.isNotNull(audioWallClockMicros);
    assert.isNotNull(videoWallClockMicros);
    maxDifferenceMs = Math.max(
      maxDifferenceMs,
      Math.abs(Number(audioWallClockMicros) - Number(videoWallClockMicros)) / 1_000,
    );
  }
  assert.isAtMost(maxDifferenceMs, 50, "同時刻の表示時刻の差が 50 ms 以内であること");
});

// 完了条件: 音声の TIMESTAMP が壁時計からドリフトする入力 (0754 の実測と同じ毎秒 48 ms) で、
// 2 つのトラックの基準の差が閾値を超えたら同期しない。同期を続けると、ずれた側の基準が
// 窓の最小値として単調に増え、映像の表示時刻が未来へ伸びて 1 枚も描かれなくなる
test("observe: 音声の TIMESTAMP がドリフトしたら共有せず、映像の表示時刻が伸びない", () => {
  for (const frameRate of [30, 60]) {
    const timeline = createTimeline();
    const mediaMs = observeDriftedStreams(timeline, frameRate, DRIFT_TEST_DURATION_MS);
    // 差が閾値 (キューが吸収できる長さ - 表示の遅れ) を超えるため、基準を共有しない
    assert.isFalse(timeline.sharingBases, `${frameRate} fps: 基準を共有しないこと`);
    // ずれた側 (音声) は表示時刻を返さず、到着基準の再生へ落ちる
    assert.isNull(
      timeline.presentationPerformanceMs("audio", timestampOf(mediaMs)),
      `${frameRate} fps: ずれた側の表示時刻を返さないこと`,
    );
    // 映像は自分の基準を使い、表示時刻が「観測の時刻 + 表示の遅れ」に収まる (未来へ伸びない)
    const videoPresentationMs = performanceMsOf(timeline, "video", mediaMs);
    assert.isAtMost(
      videoPresentationMs,
      mediaMs + MAX_PLAYOUT_DELAY_MS + TOLERANCE_MS,
      `${frameRate} fps: 映像の表示時刻が上限を超えないこと`,
    );
  }
});

// 完了条件: ドリフトは「差が閾値 (表示の遅れの上限) を超えたとき」ではなく「差が動き続けて
// いるとき」に検出する。閾値だけを見ると、検出するまで相手へ足し続けて上限まで遅らせて
// しまい、その分がそのまま A/V のずれになる (0754 の実測では毎秒 48 ms なので、閾値の
// 500 ms に達するのは 10 秒以上先である)
test("observe: ドリフトは差が動き続けた時点で検出する", () => {
  const timeline = createTimeline();
  // 閾値に達する前に検出できていれば、映像へ足した分は動きの幅の中に留まる
  observeDriftedStreams(timeline, 30, 20_000);
  assert.isFalse(timeline.sharingBases, "基準を共有しないこと");
  // 検出した後は、映像へ足す先が音声の到着基準の遅れ (上限 100 ms) に変わる。足した分は
  // 「上限 - 不感帯」の 70 ms までであり、ドリフトで膨らんだ音声の遅延には合わせない
  assert.isAtMost(
    timeline.videoDelayMs ?? 0,
    AUDIO_PLAYOUT_ARRIVAL_DELAY_MS - SYNC_MIN_DELTA_MS + TOLERANCE_MS,
    "映像へ足した分が到着基準の上限の中に収まること",
  );
});

// 完了条件: 基準を共有できないと判定したら、ずれた側 (音声) の膨らんだ遅延ではなく、音声の
// 「到着 + 到着基準の再生の遅れ」(上限 100 ms) へ映像を合わせる。合わせないと相対関係を
// 見る相手がいなくなり、同じ時刻の音声と映像が離れたままになる。合わせる量は上限 (100 ms)
// から不感帯 (30 ms) を引いた分までであり、ドリフトで膨らんだ音声の学習値には合わせない
test("observe: ドリフトで基準を共有しなくなったら映像を音声の到着基準の時刻へ合わせる", () => {
  for (const frameRate of [30, 60]) {
    const timeline = createTimeline();
    const mediaMs = observeDriftedStreams(timeline, frameRate, DRIFT_TEST_DURATION_MS);
    assert.isFalse(timeline.sharingBases, `${frameRate} fps: 基準を共有しないこと`);

    // 映像の表示の遅れは、音声の到着基準の遅れから不感帯を引いた値までになる (この到着列は
    // 揺らぎ 0 であるため、自分の遅延は 0 で、足した分だけが乗る)
    const videoDelayMs = timeline.videoDelayMs;
    assert.isNotNull(videoDelayMs, `${frameRate} fps: 映像の表示の遅れが決まること`);
    const arrivalDelayMs = timeline.audioArrivalDelayMs;
    assert.isNotNull(arrivalDelayMs, `${frameRate} fps: 音声の到着基準の遅れが決まること`);
    assert.closeTo(
      videoDelayMs ?? 0,
      (arrivalDelayMs ?? 0) - SYNC_MIN_DELTA_MS,
      TOLERANCE_MS,
      `${frameRate} fps: 映像を音声の到着基準の時刻へ合わせること`,
    );

    // 音声は到着基準の再生へ落ちるため、実際に鳴るのは「到着 + 到着基準の遅れ」である
    // (src/audioPlayout.ts)。映像の表示時刻と比べて、映像が音声より遅れていないこと
    const playoutDelayMs = timeline.playoutDelayMs ?? AUDIO_PLAYOUT_DELAY_FLOOR_MS;
    assert.isAtLeast(playoutDelayMs, arrivalDelayMs ?? 0, "音声の遅れが上限を超えないこと");
    const audioPlaysAtMs = EPOCH_MS + mediaMs + (arrivalDelayMs ?? 0);
    const videoShowsAtMs = EPOCH_MS + performanceMsOf(timeline, "video", mediaMs);
    assert.isAtMost(
      videoShowsAtMs - audioPlaysAtMs,
      SYNC_MIN_DELTA_MS,
      `${frameRate} fps: 映像が音声より遅れて表示されないこと`,
    );
  }
});

// 完了条件: 同期ずれの予算は、時計の対応付けの不感帯 (30 ms) と映像の write の遅れ
// (MAX_PRESENTATION_LAG_MS = 20 ms) の合計である。120 秒の到着列で、音声は対応付けの
// 不感帯まで、映像は write の遅れまでずらして実績を記録し、skewMs が ±50 ms に収まる
test("recordPresentation: 不感帯と write の遅れを含めても skewMs が ±50 ms に収まる", () => {
  const timeline = createTimeline();
  const arrivals = buildArrivals();
  let maxSkewMs = 0;
  let lastSkewMs: number | null = null;
  for (const [index, arrival] of arrivals.entries()) {
    const wallClockMs = arrival.atMs;
    const timestampMicros = timestampOf(arrival.mediaMs);
    timeline.observe(arrival.stream, wallClockMs, timestampMicros);
    const presentationMs = timeline.presentationPerformanceMs(arrival.stream, timestampMicros);
    assert.isNotNull(presentationMs, "表示時刻が決まること");
    // 音声は時計の対応付けの不感帯 (30 ms) まで、映像は write の遅れ (20 ms) までずらす
    const deviationMs =
      arrival.stream === "audio"
        ? AUDIO_CLOCK_DEADBAND_MS * (index % 2)
        : MAX_PRESENTATION_LAG_MS * ((index % 3) / 2);
    const presentedMicros = Math.round((EPOCH_MS + (presentationMs ?? 0) + deviationMs) * 1_000);
    timeline.recordPresentation(arrival.stream, timestampMicros, BigInt(presentedMicros));
    const skewMs = timeline.skewMs();
    if (skewMs !== null) {
      maxSkewMs = Math.max(maxSkewMs, Math.abs(skewMs));
      lastSkewMs = skewMs;
    }
  }
  // 音声の目標遅延が段差で上がった直後は、次の観測で同期の制御が合わせるまで映像が
  // 先行する。定常状態では不感帯と write の遅れの予算に収まる
  assert.isNotNull(lastSkewMs, "最後の同期ずれが求められること");
  assert.isAtMost(
    Math.abs(lastSkewMs ?? 0),
    MAX_PRESENTATION_LAG_MS + AUDIO_CLOCK_DEADBAND_MS + SYNC_MIN_DELTA_MS,
    "定常状態のずれの予算 (write の遅れ + 不感帯)",
  );
  assert.isAtMost(maxSkewMs, MAX_PLAYOUT_DELAY_MS, "推移中のずれも上限を超えないこと");
});

// ============================================================================
// 遅延の内訳 (解析)
// ============================================================================

// 内訳は「表示の遅れがどこで生じているか」を基準の遅れ・jitter buffer の遅延・同期の制御が
// 足した分に分けて出す。音声と映像の遅れを比べて改善するための値であり、合計は表示の遅れと
// 一致する (上限で切られていないとき)
test("delayBreakdown: 表示の遅れを基準と jitter buffer と同期の制御に分けて出す", () => {
  const timeline = createTimeline();
  observeBothStreams(timeline, 20_000);
  const breakdown = timeline.delayBreakdown;
  assert.isTrue(breakdown.sharingBases, "基準を共有していること");
  assert.equal(breakdown.unsharedReason, "none");
  assert.equal(breakdown.baseDriftLimitMs, PLAYOUT_BASE_DRIFT_MS);
  assert.equal(breakdown.presentationDelayCapMs, MAX_PLAYOUT_DELAY_MS);
  for (const [name, track] of [
    ["audio", breakdown.audio],
    ["video", breakdown.video],
  ] as const) {
    const baseDelayMs = track.baseDelayMs;
    const jitterDelayMs = track.jitterDelayMs;
    assert.isNotNull(baseDelayMs, `${name}: 基準の遅れが決まること`);
    assert.isNotNull(jitterDelayMs, `${name}: jitter buffer の遅延が決まること`);
    // 表示の遅れ = 基準の遅れ + max(jitter buffer の遅延, targetLatency) + 同期の制御が足した分
    assert.closeTo(
      track.presentationDelayMs ?? 0,
      (baseDelayMs ?? 0) +
        Math.max(jitterDelayMs ?? 0, timeline.targetLatencyMs ?? 0) +
        track.syncExtraDelayMs,
      TOLERANCE_MS,
      `${name}: 表示の遅れが内訳の合計と一致すること`,
    );
    assert.equal(
      track.presentationDelayMs,
      timeline.presentationDelayFor(name),
      `${name}: presentationDelayFor と同じ値であること`,
    );
  }
  // 2 つのトラックの基準の差は「音声 - 映像」である
  assert.closeTo(
    breakdown.baseDifferenceMs ?? 0,
    (breakdown.audio.baseDelayMs ?? 0) - (breakdown.video.baseDelayMs ?? 0),
    TOLERANCE_MS,
  );
});

// まだ観測していないときは、差や動きの判定は基準がそろってから意味を持つため、
// 理由を unobserved にする (差が 0 であるとも、動きが無いとも言えない)
test("delayBreakdown: 未観測のときは理由を unobserved にする", () => {
  const breakdown = createTimeline().delayBreakdown;
  assert.isFalse(breakdown.sharingBases);
  assert.equal(breakdown.unsharedReason, "unobserved");
  assert.isNull(breakdown.baseDifferenceMs);
  assert.isNull(breakdown.audio.baseDelayMs);
  assert.isNull(breakdown.audio.jitterDelayMs);
  assert.isNull(breakdown.audio.presentationDelayMs);
  assert.isNull(breakdown.baseDriftMsPerSecond);
});

// 音声の TIMESTAMP がドリフトしているときは、理由を drift にして動きの速さを出す。
// 時計のずれであることが分かれば、合わせるのをやめて到着基準へ落とす判断ができる
// (ずれた側の表示時刻は決めないため presentationDelayMs は null になる)
test("delayBreakdown: ドリフトでは理由と動きの速さを出し、ずれた側の表示時刻を決めない", () => {
  const timeline = createTimeline();
  observeDriftedStreams(timeline, 30, 20_000);
  const breakdown = timeline.delayBreakdown;
  assert.isFalse(breakdown.sharingBases);
  assert.equal(breakdown.unsharedReason, "drift");
  // 毎秒 48 ms で遅れる入力であるため、動きの速さもその値になる
  assert.closeTo(
    breakdown.baseDriftMsPerSecond ?? 0,
    DRIFT_TEST_MS_PER_SECOND,
    1,
    "動きの速さが入力と同じであること",
  );
  assert.isNull(breakdown.audio.presentationDelayMs, "ずれた側 (音声) は到着基準へ落ちること");
  assert.isNotNull(breakdown.video.presentationDelayMs, "映像は自分の基準で表示できること");
});

// 完了条件: 基準の差が経路差として説明できる上限 (PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS) を
// 超えたら、超えた分は合わせない。合わせても実際のずれは減らないまま相手側の表示の遅れが
// 伸びるためである (実測では音声の基準 313 ms・映像 13 ms で映像へ 378 ms を足し、
// 表示の遅延が 483 ms になっていた)。上限は時計のずれの証拠を見たかどうかに関わらず掛ける
test("observe: 基準の差が大きくても相手側へ足す分は上限までにする", () => {
  const timeline = createTimeline();
  // 音声だけが TIMESTAMP より 300 ms 遅れて届く (定常)。段差 (150 ms) も入れて、差が
  // 動き続けている場合 (ドリフト) と同じ条件にする
  const offsetMs = 300;
  for (let mediaMs = 0; mediaMs < 20_000; mediaMs += FRAME_MS) {
    const stepMs = mediaMs < 5_000 ? 0 : 150;
    timeline.observe("video", EPOCH_MS + mediaMs, timestampOf(mediaMs));
    timeline.observe("audio", EPOCH_MS + mediaMs + offsetMs, timestampOf(mediaMs - stepMs));
  }
  assert.closeTo(timeline.delayBreakdown.baseDifferenceMs ?? 0, 450, 1, "差が開いていること");
  // 映像へ足すのは上限まで。残りの差は A/V のずれとして残す
  assert.isAtMost(
    timeline.delayBreakdown.video.syncExtraDelayMs,
    PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS,
    "映像へ足す分が上限を超えないこと",
  );
  // 映像の表示の遅れは、上限までの分だけ (相手の 450 ms に引きずられない)
  assert.isAtMost(
    timeline.videoDelayMs ?? Infinity,
    PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS + 1,
    "映像の表示の遅れが上限を超えないこと",
  );
});

// 完了条件 (実測): 音声の TIMESTAMP が 600 ms 段差でずれても、映像を音声の膨らんだ遅延に
// 合わせない。段差は「到着 - TIMESTAMP」に現れるため、音声の jitter buffer の遅延 (NetEq の
// 目標) が 600 ms へ育つ。基準 (窓の最小値) は 10 秒間動かないため、2 つのトラックは
// 共有されたまま差だけが開く。修正前は、時計のずれの証拠を見る前に上限が掛からず、この差の
// 全額 (497 ms) を映像へ足して表示待ちが 512 ms になった (実測では syncExtraDelayMs 600.5、
// displayWait 496 ms、そこから毎秒 20 ms でしか戻らなかった)
test("observe: 音声の TIMESTAMP が段差でずれても、映像へ足す遅延は上限までにする", () => {
  const timeline = createTimeline();
  // 音声は 20 ms ごと (Opus)、映像は 30 fps で、どちらも揺らぎ 0 で届く
  const audioFrameMs = 20;
  const stepAtMs = 5_000;
  const stepMs = 600;
  let nextVideoMs = 0;
  for (let wallMs = 0; wallMs < 10_000; wallMs += audioFrameMs) {
    while (nextVideoMs <= wallMs) {
      timeline.observe("video", EPOCH_MS + nextVideoMs, timestampOf(nextVideoMs));
      nextVideoMs += FRAME_MS;
    }
    // 段差の後は、音声の TIMESTAMP だけが 600 ms 古くなる (到着は変わらない)
    const timestampMs = wallMs < stepAtMs ? wallMs : wallMs - stepMs;
    timeline.observe("audio", EPOCH_MS + wallMs, timestampOf(timestampMs));
  }
  // 入力が実測と同じ機構になっていること (音声の遅延が段差の分だけ育つ)
  assert.isAbove(
    timeline.playoutDelayMs ?? 0,
    AUDIO_PLAYOUT_DELAY_FLOOR_MS,
    "音声の jitter buffer の遅延が段差で育つこと",
  );
  // 映像へ足す分は上限までである (段差の全額ではない)
  assert.isAtMost(
    timeline.delayBreakdown.video.syncExtraDelayMs,
    PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS,
    "映像へ足す分が上限を超えないこと",
  );
  assert.isAtMost(
    timeline.videoDelayMs ?? Infinity,
    PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS + 1,
    "映像の表示待ち (displayWait) が上限に留まること",
  );
});

// 完了条件: 閾値は jitter buffer の目標遅延で動くため、差が変わらなくても共有と解除を
// 往復し得る。往復のたびに、足した分を戻して (フレームを捨てる) すぐ足し直す (表示が
// 止まる) ことになるため、一度やめたら保持の間は戻さない
test("observe: 一度共有をやめたら保持の間は戻さない", () => {
  const timeline = createTimeline();
  // 5 秒目に音声の TIMESTAMP が 150 ms 古くなる (段差)。以後は動かない
  for (let mediaMs = 0; mediaMs < 15_000; mediaMs += FRAME_MS) {
    const offsetMs = mediaMs < 5_000 ? 0 : 150;
    timeline.observe("video", EPOCH_MS + mediaMs, timestampOf(mediaMs));
    timeline.observe("audio", EPOCH_MS + mediaMs, timestampOf(mediaMs - offsetMs));
  }
  // 段差のあとは動きが無くなる (動きだけを見ていると判定が解ける) が、保持の間は戻さない
  assert.isFalse(timeline.sharingBases, "保持の間は基準を共有しないこと");
});
