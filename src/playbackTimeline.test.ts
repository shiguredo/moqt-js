/**
 * PlaybackTimeline の単体テスト
 *
 * 音声と映像で共有する表示時刻を 1 つの式で決める規則を固定する。
 * 表示時刻 = TIMESTAMP + 共有の基準の遅れ + max(targetLatency, 共有の再生遅延) であり、
 * 共有の基準の遅れはトラックごとの最小値の大きい方、共有の再生遅延はトラックごとの揺らぎの
 * 大きい方 (音声を購読しているときは下限 AUDIO_PLAYOUT_DELAY_FLOOR_MS あり) である。
 * 表示の遅れの上限は MAX_PLAYOUT_DELAY_MS とキューが吸収できる長さの小さい方で、max の側に
 * だけ掛ける。
 *
 * PBT (観測の順序と揺らぎの任意の列に対する不変条件) は playbackTimeline.prop.ts が固定する。
 */

import { test, assert } from "vite-plus/test";
import {
  AUDIO_PLAYOUT_DELAY_FLOOR_MS,
  MAX_PLAYOUT_DELAY_MS,
  PLAYBACK_DELAY_DECAY_MS_PER_SECOND,
  PLAYBACK_DISCONTINUITY_MS,
  PLAYOUT_BASE_MAX_DIFFERENCE_MIN_MS,
  PLAYOUT_QUEUE_HEADROOM_FRAMES,
  PlaybackTimeline,
} from "./playbackTimeline";
import { AUDIO_CLOCK_DEADBAND_MS } from "./audioPlayout";
import { MAX_PRESENTATION_LAG_MS } from "./playoutBuffer";

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
});

// 表示時刻 = TIMESTAMP + 基準の遅れ + max(targetLatency, 再生遅延)。1 枚目の観測では基準の
// 遅れが「観測の時刻 - TIMESTAMP」になり、再生遅延の観測が無いため音声の下限 (80 ms) だけが
// 加わる。performance.now() の軸では performance.timeOrigin を引いた同じ値になる
test("presentationWallClockMicros: 最初の観測で TIMESTAMP + 基準の遅れ + 再生遅延になる", () => {
  const timeline = createTimeline();
  // 音声を購読しているため共有の再生遅延に下限 (80 ms) が入る
  timeline.observe("audio", EPOCH_MS, timestampOf(0));
  timeline.observe("video", EPOCH_MS, timestampOf(0));

  // 基準の遅れ = 0 ms (受信側と送信側の時計が一致)、再生遅延 = 0 ms。音声の下限 80 ms を使う
  const delayMs = AUDIO_PLAYOUT_DELAY_FLOOR_MS;
  assert.closeTo(timeline.playoutDelayMs ?? 0, delayMs, TOLERANCE_MS);
  assert.closeTo(timeline.presentationDelayMs ?? 0, delayMs, TOLERANCE_MS);
  assert.closeTo(wallClockMsOf(timeline, "video", 0), EPOCH_MS + delayMs, TOLERANCE_MS);
  assert.closeTo(wallClockMsOf(timeline, "video", 1_000), EPOCH_MS + 1_000 + delayMs, TOLERANCE_MS);
  // performance.now() の軸では performance.timeOrigin (EPOCH_MS) を引いた値になる
  assert.closeTo(performanceMsOf(timeline, "video", 0), delayMs, TOLERANCE_MS);
  assert.closeTo(performanceMsOf(timeline, "video", 1_000), 1_000 + delayMs, TOLERANCE_MS);
});

// 基準の遅れは到着ではなく復号の出力の時刻で測る。窓の p95 が揺らぎより大きくなると、
// 下限より大きい再生遅延が表示の遅れになる
test("presentationWallClockMicros: 揺らぎの観測で再生遅延が表示の遅れになる", () => {
  const timeline = createTimeline();
  timeline.observe("audio", EPOCH_MS, timestampOf(0));
  // 追いつき中の学習を終えるため、揺らぎ 0 のフレームで CATCH_UP_CHECK_INTERVAL_MS を超える
  for (let index = 0; index < 30; index++) {
    timeline.observe("video", EPOCH_MS + index * FRAME_MS, timestampOf(index * FRAME_MS));
  }
  assert.closeTo(timeline.playoutDelayMs ?? 0, AUDIO_PLAYOUT_DELAY_FLOOR_MS, TOLERANCE_MS);
  // 100 ms 遅れて届いたフレームが 2 枚あり、窓の p95 が 100 ms になる
  timeline.observe("video", EPOCH_MS + 30 * FRAME_MS + 100, timestampOf(30 * FRAME_MS));
  timeline.observe("video", EPOCH_MS + 31 * FRAME_MS + 100, timestampOf(31 * FRAME_MS));
  assert.closeTo(timeline.playoutDelayMs ?? 0, 100, TOLERANCE_MS);
  assert.closeTo(wallClockMsOf(timeline, "video", 0), EPOCH_MS + 100, TOLERANCE_MS);
});

// 同じ render group のトラックは同時に描画する (draft-ietf-moq-msf-01 §5.2.11) ため、基準は
// 音声と映像で 1 つにする。同じ TIMESTAMP のフレームは同じ表示時刻になる
test("presentationWallClockMicros: 同じ TIMESTAMP の音声と映像は同じ表示時刻になる", () => {
  const timeline = createTimeline();
  // 別々の時刻に観測しても、共有の基準 (大きい方) と共有の再生遅延を使う
  timeline.observe("audio", EPOCH_MS, timestampOf(0));
  timeline.observe("video", EPOCH_MS + 40, timestampOf(0));
  assert.isTrue(timeline.sharingBases);
  assert.equal(
    wallClockMsOf(timeline, "audio", 1_000),
    wallClockMsOf(timeline, "video", 1_000),
    "同じ TIMESTAMP の表示時刻が一致すること",
  );
  assert.equal(
    performanceMsOf(timeline, "audio", 1_000),
    performanceMsOf(timeline, "video", 1_000),
    "performance.now() の軸でも一致すること",
  );
});

// 音声と映像で基準が違うときは復号の遅い側 (大きい方) に合わせる。表示が期限より前に
// ならない安全側であり、両方に同じ値を与えるため同期する
test("presentationWallClockMicros: 音声と映像で基準が違うときは大きい方を使う", () => {
  const timeline = createTimeline();
  timeline.observe("audio", EPOCH_MS, timestampOf(0));
  timeline.observe("video", EPOCH_MS + 40, timestampOf(0));
  assert.isTrue(timeline.sharingBases);
  // 共有の基準の遅れは映像の 40 ms、再生遅延は音声の下限 80 ms
  assert.closeTo(
    timeline.presentationDelayMs ?? 0,
    40 + AUDIO_PLAYOUT_DELAY_FLOOR_MS,
    TOLERANCE_MS,
  );
  assert.closeTo(
    wallClockMsOf(timeline, "audio", 0),
    EPOCH_MS + 40 + AUDIO_PLAYOUT_DELAY_FLOOR_MS,
    TOLERANCE_MS,
  );
  assert.closeTo(
    wallClockMsOf(timeline, "video", 0),
    EPOCH_MS + 40 + AUDIO_PLAYOUT_DELAY_FLOOR_MS,
    TOLERANCE_MS,
  );
});

// 音声を購読していないときは再生遅延の下限を置かない (揃える相手がいない)。下限は音声の
// 途切れを防ぐための値であり、音声の窓が無いときに映像の表示時刻を遅らせる理由は無い
test("playoutDelayMs: 音声を観測していなければ音声の下限を置かない", () => {
  const timeline = createTimeline();
  timeline.observe("video", EPOCH_MS, timestampOf(0));
  assert.closeTo(timeline.playoutDelayMs ?? -1, 0, TOLERANCE_MS);
  // 音声を観測すると下限が入る
  timeline.observe("audio", EPOCH_MS + FRAME_MS, timestampOf(FRAME_MS));
  assert.closeTo(timeline.playoutDelayMs ?? 0, AUDIO_PLAYOUT_DELAY_FLOOR_MS, TOLERANCE_MS);
});

// ============================================================================
// targetLatency の適用と上限
// ============================================================================

// targetLatency が無いとき、または isLive が false で使えないときは再生遅延だけを使う。
// 再生遅延は音声の下限 (80 ms) を下回らない
test("setTargetLatencyMs: targetLatency が無いときは再生遅延だけを使う", () => {
  const timeline = createTimeline();
  timeline.observe("audio", EPOCH_MS, timestampOf(0));
  for (let index = 0; index < 30; index++) {
    timeline.observe("video", EPOCH_MS + index * FRAME_MS, timestampOf(index * FRAME_MS));
  }
  assert.isNull(timeline.targetLatencyMs);
  assert.closeTo(timeline.presentationDelayMs ?? 0, AUDIO_PLAYOUT_DELAY_FLOOR_MS, TOLERANCE_MS);
  // 再生遅延より小さい targetLatency を渡しても、遅い方 (再生遅延) を使う
  timeline.setTargetLatencyMs(10);
  assert.equal(timeline.targetLatencyMs, 10);
  assert.closeTo(timeline.presentationDelayMs ?? 0, AUDIO_PLAYOUT_DELAY_FLOOR_MS, TOLERANCE_MS);
  // 使わない (isLive が false など) ときは null にする
  timeline.setTargetLatencyMs(null);
  assert.isNull(timeline.targetLatencyMs);
  assert.closeTo(timeline.presentationDelayMs ?? 0, AUDIO_PLAYOUT_DELAY_FLOOR_MS, TOLERANCE_MS);
});

// targetLatency があるときは max(targetLatency, 再生遅延) を使う。小さい方を選ぶと
// 表示時刻が期限より前になり、フレームを捨て続けることになる
test("setTargetLatencyMs: targetLatency と再生遅延の大きい方を使う", () => {
  const timeline = createTimeline();
  timeline.observe("audio", EPOCH_MS, timestampOf(0));
  for (let index = 0; index < 30; index++) {
    timeline.observe("video", EPOCH_MS + index * FRAME_MS, timestampOf(index * FRAME_MS));
  }
  timeline.setTargetLatencyMs(300);
  assert.closeTo(timeline.playoutDelayMs ?? 0, AUDIO_PLAYOUT_DELAY_FLOOR_MS, TOLERANCE_MS);
  assert.closeTo(timeline.presentationDelayMs ?? 0, 300, TOLERANCE_MS);
  assert.closeTo(wallClockMsOf(timeline, "video", 0), EPOCH_MS + 300, TOLERANCE_MS);
  assert.equal(timeline.targetLatencyLimitedMs, 0, "上限に収まるため切り下げないこと");
});

// 表示の遅れの上限は MAX_PLAYOUT_DELAY_MS と、キューが吸収できる長さの小さい方である。
// 上限は基準の遅れではなく max(targetLatency, 再生遅延) の側にだけ掛ける (基準の遅れは
// 送受信の時計のずれであり、切り下げるとすべてのフレームが期限切れになる)
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
  const timeline = createTimeline();
  timeline.observe("audio", EPOCH_MS, timestampOf(5_000));
  // 受信側の壁時計では EPOCH_MS のときに、TIMESTAMP が 5 秒先のフレームが届く
  timeline.observe("video", EPOCH_MS, timestampOf(5_000));
  assert.closeTo(
    timeline.presentationDelayMs ?? 0,
    -5_000 + AUDIO_PLAYOUT_DELAY_FLOOR_MS,
    TOLERANCE_MS,
  );
  // 表示時刻は TIMESTAMP + 負の遅れ = 受信側の壁時計 + 再生遅延になる
  assert.closeTo(
    wallClockMsOf(timeline, "video", 5_000),
    EPOCH_MS + AUDIO_PLAYOUT_DELAY_FLOOR_MS,
    TOLERANCE_MS,
  );
  assert.closeTo(
    performanceMsOf(timeline, "video", 5_000),
    AUDIO_PLAYOUT_DELAY_FLOOR_MS,
    TOLERANCE_MS,
  );
});

// ============================================================================
// 基準を共有しないフォールバック
// ============================================================================

// 2 つのトラックの基準の差が、キューが吸収できる長さから max(targetLatency, 再生遅延) を
// 引いた閾値を超えたら基準を共有しない。大きい方のトラックは TIMESTAMP が壁時計から
// ずれているとみなして表示時刻を返さず (到着基準の再生へ落とす)、もう片方は自分の基準で
// 表示時刻を返す。共有を続けると、ずれた側の基準が窓の最小値として単調に増え、もう片方の
// 表示時刻が未来へ伸びて 1 枚も描かれなくなる
test("sharingBases: 基準の差が閾値を超えたら共有せず、大きい側は表示時刻を返さない", () => {
  const timeline = createTimeline();
  // 映像の基準 0 ms、音声の基準 1 秒 (TIMESTAMP が壁時計から遅れている)。
  // 差 1 秒は閾値 (キューが吸収できる 500 ms - 再生遅延 80 ms = 420 ms) を超える
  timeline.observe("video", EPOCH_MS, timestampOf(0));
  timeline.observe("audio", EPOCH_MS + 1_000, timestampOf(0));
  assert.isFalse(timeline.sharingBases);
  // ずれた側 (大きい方) の音声は表示時刻を返さない
  assert.isNull(timeline.presentationWallClockMicros("audio", timestampOf(0)));
  assert.isNull(timeline.presentationPerformanceMs("audio", timestampOf(0)));
  // もう片方の映像は自分の基準 (0 ms) と共有の再生遅延で表示時刻を返す
  assert.closeTo(
    wallClockMsOf(timeline, "video", 0),
    EPOCH_MS + AUDIO_PLAYOUT_DELAY_FLOOR_MS,
    TOLERANCE_MS,
  );
});

// 閾値は「キューが吸収できる長さ - max(targetLatency, 再生遅延)」である。フレーム間隔を
// 覚えていない間はキューが吸収できる長さが上限 (500 ms) であり、再生遅延 (音声の下限 80 ms)
// を引いた 420 ms が閾値になる。基準の遅れそのものはキューを消費しないため、引かない
test("sharingBases: 閾値の内側なら共有し、max が上がると共有しなくなる", () => {
  const timeline = createTimeline();
  timeline.observe("video", EPOCH_MS, timestampOf(0));
  timeline.observe("audio", EPOCH_MS + 400, timestampOf(0));
  const differenceMs = 400;
  const queueCapMs = MAX_PLAYOUT_DELAY_MS;
  const limitMs = queueCapMs - AUDIO_PLAYOUT_DELAY_FLOOR_MS;
  assert.isAtMost(differenceMs, limitMs, "差が閾値の内側であること");
  assert.isTrue(timeline.sharingBases);
  // 共有の基準は大きい方 (音声の 400 ms) を使う
  assert.closeTo(
    wallClockMsOf(timeline, "video", 0),
    EPOCH_MS + 400 + AUDIO_PLAYOUT_DELAY_FLOOR_MS,
    TOLERANCE_MS,
  );
  // max(targetLatency, 再生遅延) が上がると閾値が下がり、同じ差でも共有しなくなる
  timeline.setTargetLatencyMs(400);
  assert.isBelow(limitMs - 400 + AUDIO_PLAYOUT_DELAY_FLOOR_MS, differenceMs);
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
// 経路の揺らぎではないため、再生遅延の目標に使わない。使うと再生遅延が数百ミリ秒になり、
// 窓 (10 秒) から抜けた後も毎秒 20 ms でしか下がらない
test("observe: まとまって届いたフレームを再生遅延の目標に使わない", () => {
  // 30 fps のフレームが 2 ms 間隔で 90 枚 (メディア時刻で 3 秒分) 届く
  const timeline = createTimeline();
  timeline.observe("audio", EPOCH_MS, timestampOf(0));
  for (let index = 0; index < 90; index++) {
    timeline.observe("video", EPOCH_MS + index * 2, timestampOf(index * FRAME_MS));
  }
  assert.closeTo(timeline.playoutDelayMs ?? 0, AUDIO_PLAYOUT_DELAY_FLOOR_MS, TOLERANCE_MS);
});

// 揺らぎ 0 のフレームが続いても、追いつき中 (CATCH_UP_CHECK_INTERVAL_MS の間) は学習しない。
// 追いついた後の経路の遅れは学習する
test("observe: 追いつき中の揺らぎを再生遅延の目標に使わない", () => {
  const timeline = createTimeline();
  timeline.observe("audio", EPOCH_MS, timestampOf(0));
  // 実時間より速く届く (追いつき中)。この間の遅れは経路の揺らぎではない
  timeline.observe("video", EPOCH_MS, timestampOf(0));
  timeline.observe("video", EPOCH_MS + 40, timestampOf(FRAME_MS));
  assert.closeTo(timeline.playoutDelayMs ?? 0, AUDIO_PLAYOUT_DELAY_FLOOR_MS, TOLERANCE_MS);
  // 追いついた後の 100 ms の遅れは学習する
  for (let index = 2; index < 32; index++) {
    timeline.observe("video", EPOCH_MS + index * FRAME_MS, timestampOf(index * FRAME_MS));
  }
  timeline.observe("video", EPOCH_MS + 32 * FRAME_MS + 100, timestampOf(32 * FRAME_MS));
  timeline.observe("video", EPOCH_MS + 33 * FRAME_MS + 100, timestampOf(33 * FRAME_MS));
  assert.closeTo(timeline.playoutDelayMs ?? 0, 100, TOLERANCE_MS);
});

// TIMESTAMP が大きく動くと (publisher の時計の変更や別の publisher への切り替え)、以降の
// フレームがすべて遅れて見え、再生遅延が上限に張り付く。PLAYBACK_DISCONTINUITY_MS 以上
// 動いたら共有の時間軸ごと基準を取り直す (両方のトラックが同じだけ動くため同期は保たれる)
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
  // 取り直しの後も audio と video は同じ TIMESTAMP で同じ表示時刻になる
  timeline.observe("audio", atMs, timestampOf(jumpedMediaMs));
  assert.equal(
    wallClockMsOf(timeline, "audio", jumpedMediaMs + 1_000),
    wallClockMsOf(timeline, "video", jumpedMediaMs + 1_000),
    "取り直した後も同じ表示時刻になること",
  );
});

// 目標が下がったときは毎秒 PLAYBACK_DELAY_DECAY_MS_PER_SECOND ずつ下げる。急に戻すと
// 表示時刻が前へ飛び、フレームを捨てることになる
test("observe: 再生遅延を毎秒 PLAYBACK_DELAY_DECAY_MS_PER_SECOND ずつ下げる", () => {
  const timeline = createTimeline();
  timeline.observe("audio", EPOCH_MS, timestampOf(0));
  let available = 0;
  const delays: { atMs: number; delayMs: number }[] = [];
  for (let index = 0; index < 600; index++) {
    // 200 ms 遅れたフレームが窓の p95 に入り、再生遅延が 200 ms になる
    const late = index % 100 === 17 || index % 100 === 67;
    available = Math.max(available, index * FRAME_MS + (late ? 200 : 0));
    timeline.observe("video", EPOCH_MS + available, timestampOf(index * FRAME_MS));
    delays.push({ atMs: available, delayMs: timeline.playoutDelayMs ?? 0 });
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

// 同じ式で決めた音声と映像の実績は同じ「表示時刻 - TIMESTAMP」になり、同期ずれは 0 になる
test("skewMs: 同じ式で決めた音声と映像の実績は 0 になる", () => {
  const timeline = createTimeline();
  timeline.observe("audio", EPOCH_MS, timestampOf(0));
  timeline.observe("video", EPOCH_MS, timestampOf(0));
  const timestampMicros = timestampOf(1_000);
  const audioWallClockMicros = timeline.presentationWallClockMicros("audio", timestampMicros);
  const videoWallClockMicros = timeline.presentationWallClockMicros("video", timestampMicros);
  assert.isNotNull(audioWallClockMicros);
  assert.isNotNull(videoWallClockMicros);
  timeline.recordPresentation("audio", timestampMicros, audioWallClockMicros ?? 0n);
  timeline.recordPresentation("video", timestampMicros, videoWallClockMicros ?? 0n);
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
// write の遅れ (MAX_PRESENTATION_LAG_MS = 20 ms) と時計の対応付けの不感帯 (30 ms) である
test("presentationWallClockMicros: 120 秒の到着列でも同時刻の音声と映像の表示時刻が揃う", () => {
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
// 2 つのトラックの基準の差が閾値を超えたら基準を共有しない。共有を続けると、ずれた側の基準が
// 窓の最小値として単調に増え、映像の表示時刻が未来へ伸びて 1 枚も描かれなくなる
test("observe: 音声の TIMESTAMP がドリフトしたら基準を共有せず、映像の表示時刻が伸びない", () => {
  for (const frameRate of [30, 60]) {
    const frameMs = 1_000 / frameRate;
    const timeline = createTimeline();
    // 毎秒 48 ms ずつ音声の TIMESTAMP が壁時計から遅れる (0754 の実測)
    const driftPerMs = 48 / 1_000;
    const durationMs = 120_000;
    let mediaMs = 0;
    for (let index = 0; index * frameMs < durationMs; index++) {
      mediaMs = index * frameMs;
      const observedAtMs = EPOCH_MS + mediaMs;
      timeline.observe("video", observedAtMs, timestampOf(mediaMs));
      timeline.observe("audio", observedAtMs, timestampOf(mediaMs - driftPerMs * mediaMs));
    }
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

// 完了条件: 同期ずれの予算は、時計の対応付けの不感帯 (30 ms) と映像の write の遅れ
// (MAX_PRESENTATION_LAG_MS = 20 ms) の合計である。120 秒の到着列で、音声は対応付けの
// 不感帯まで、映像は write の遅れまでずらして実績を記録し、skewMs が ±50 ms に収まる
test("recordPresentation: 不感帯と write の遅れを含めても skewMs が ±50 ms に収まる", () => {
  const timeline = createTimeline();
  const arrivals = buildArrivals();
  let audioTimestampMicros = 0;
  let videoTimestampMicros = 0;
  let audioPresentedMicros = 0;
  let videoPresentedMicros = 0;
  let maxSkewMs = 0;
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
    if (arrival.stream === "audio") {
      audioTimestampMicros = timestampMicros;
      audioPresentedMicros = presentedMicros;
    } else {
      videoTimestampMicros = timestampMicros;
      videoPresentedMicros = presentedMicros;
    }
    const skewMs = timeline.skewMs();
    if (skewMs !== null) {
      maxSkewMs = Math.max(maxSkewMs, Math.abs(skewMs));
    }
    assert.isNotNull(audioPresentedMicros, "音声の実績があること");
    assert.isNotNull(videoPresentedMicros, "映像の実績があること");
    assert.isNotNull(audioTimestampMicros, "音声の timestamp があること");
    assert.isNotNull(videoTimestampMicros, "映像の timestamp があること");
  }
  assert.isAtMost(maxSkewMs, MAX_PRESENTATION_LAG_MS + AUDIO_CLOCK_DEADBAND_MS, "ずれの予算");
  assert.isAtMost(maxSkewMs, 50, "±50 ms 以内であること");
});
