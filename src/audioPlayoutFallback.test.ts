/**
 * 目標の基準が共有されなくなったときの、音声の再生の受け入れ条件
 *
 * devtools の購読 (マイク + カメラ、`audioDelivery: subgroup`、jitter buffer 有効) の実測では、
 * 送る側の音声の LOC TIMESTAMP がセッションの途中で 40 ms から 623 ms へ段差でずれた。到着は
 * 乱れていないため、ずれているのは TIMESTAMP であり、音の内容が遅れているわけではない。
 * それでも受信側では次の 3 つが起きていた。
 *
 * - 到着から鳴り始めるまでが 316 ms (p50)、最大 598 ms になった。時間軸の基準が共有されなく
 *   なると到着基準で並べるが、その再生の遅れに、TIMESTAMP のずれを揺らぎとして学習した値
 *   (316〜500 ms) をそのまま使っていたためである
 * - 予定より 507 ms 遅く届いた音が `lateness` として捨てられ、語尾が切れた。予定 (TIMESTAMP
 *   から決まる時刻) の方が 500 ms 過去にずれているだけであり、音は遅れていない
 * - 予定を決められない音が `unplannedFrames` に数えられ、予定に対する余裕を読めなかった
 *
 * このファイルは、実測と同じ入力 (TIMESTAMP が途中で 600 ms 段差でずれる、到着は乱れない) を、
 * 時間軸 (`PlaybackTimeline`)、鳴らす時刻の決定 (`AudioPlayoutScheduler`)、観測
 * (`AudioPlayoutTimingStats`) を本物のまま繋いで再現し、次の受け入れ条件を固定する。
 *
 * - 到着から鳴り始めるまでの時間 (`startDelayMs`) の p50 が 100 ms 程度に収まる
 * - 鳴り遅れ (`missedByReason.lateness`) が増えない (遅れて届いても鳴らす)
 * - 到着基準で鳴らす音も計画に載せ、`unplannedFrames` が 0 になる
 * - TIMESTAMP が正しいとき (正常時) の並べ方は変わらない
 *
 * 時刻は `performance.now()` と同じ軸の値で与える。鳴り始める時刻は `AudioContext` の時計へ
 * 予約した時刻を `AudioClockBridge` で同じ軸へ換算した値であり、音声出力の遅延は含まない。
 */

import { test, assert } from "vite-plus/test";
import {
  arrivalPlayoutDelaySeconds,
  AudioClockBridge,
  AudioPlayoutScheduler,
} from "./audioPlayout";
import { AudioPlayoutTimingStats } from "./audioPlayoutTimingStats";
import { AUDIO_PLAYOUT_DELAY_FLOOR_MS, PlaybackTimeline } from "./playbackTimeline";

/** Opus の 1 フレーム (20 ms) */
const AUDIO_FRAME_MS = 20;
/** 映像のフレーム間隔 (30 fps、ミリ秒) */
const VIDEO_FRAME_MS = 1_000 / 30;
/** 音声の基準 (到着 - TIMESTAMP) の、ずれる前の値 (ミリ秒)。実測の 40 ms に合わせる */
const AUDIO_BASE_MS = 40;
/** 映像の基準 (到着 - TIMESTAMP) の値 (ミリ秒)。実測の 12.5 ms に合わせる */
const VIDEO_BASE_MS = 12.5;
/** 段差の後の、音声の基準 (到着 - TIMESTAMP)。実測の 623.2 ms に合わせる */
const AUDIO_BASE_AFTER_STEP_MS = 623.2;
/** TIMESTAMP の段差 (ミリ秒)。実測の 40 ms → 623.2 ms に合わせる */
const TIMESTAMP_STEP_MS = AUDIO_BASE_AFTER_STEP_MS - AUDIO_BASE_MS;
/** 段差が入る時刻 (ミリ秒)。セッションの途中にする */
const STEP_AT_MS = 5_000;
/** 模擬する長さ (ミリ秒)。分布の窓もこの長さにして、全体を 1 つの窓で見る */
const SCENARIO_MS = 25_000;
/** catalog の targetLatency (ミリ秒)。表示の遅れの下限である */
const TARGET_LATENCY_MS = 100;
/** 表示待ちのキューの上限 (枚)。devtools の jitter buffer と同じ値 */
const MAX_QUEUED_FRAMES = 24;

/**
 * 到着の揺らぎ (ミリ秒)
 *
 * 到着は乱れていない (音の内容は遅れていない) ことを表すため、フレーム間隔に載る程度の
 * 小さな揺らぎだけを与える。乱数を避け、同じ入力で同じ結果になるようにする。
 */
function arrivalJitterMs(index: number): number {
  return (((index * 7919) % 13) / 13) * 0.5 - 0.25;
}

/** 模擬した結果の観測値と、そのときの内訳 */
interface ScenarioResult {
  readonly startDelayP50: number;
  readonly startDelayMax: number;
  readonly arrivalPlannedFrames: number;
  readonly unplannedFrames: number;
  readonly missedFrames: number;
  readonly latenessMisses: number;
  readonly playedFrames: number;
  /** 基準を共有できていた時間の割合 (正常時の並べ方かを確かめる) */
  readonly sharedBaseFrames: number;
}

/**
 * 音声と映像を 1 つの時間軸へ流し、音声だけを `AudioPlayoutScheduler` で並べる
 *
 * devtools と `src/createMediaSubscriber.ts` の音声の経路と同じ順で呼ぶ。TIMESTAMP の段差は
 * `stepAtMs` 以降に加える (null なら段差なし = 正常時)。
 *
 * @param stepAtMs - TIMESTAMP に段差を入れる時刻 (ミリ秒)。入れないときは null
 */
function runScenario(stepAtMs: number | null): ScenarioResult {
  const timeline = new PlaybackTimeline({ timeOriginMs: 0, maxQueuedFrames: MAX_QUEUED_FRAMES });
  timeline.setTargetLatencyMs(TARGET_LATENCY_MS);
  const playout = new AudioPlayoutScheduler();
  const clock = new AudioClockBridge();
  const stats = new AudioPlayoutTimingStats(SCENARIO_MS, 0);

  // 段差が入った後は、音声の基準 (到着 - TIMESTAMP) が広がったままになる
  const audioBaseMsAt = (wallMs: number): number =>
    stepAtMs !== null && wallMs >= stepAtMs ? AUDIO_BASE_MS + TIMESTAMP_STEP_MS : AUDIO_BASE_MS;

  let sharedBaseFrames = 0;
  let nextVideoMs = 0;
  const audioFrames = Math.floor(SCENARIO_MS / AUDIO_FRAME_MS);
  for (let index = 0; index < audioFrames; index++) {
    const wallMs = index * AUDIO_FRAME_MS;
    // 映像も同じ時間軸へ記録する (共有の基準が決まる条件)
    while (nextVideoMs <= wallMs) {
      timeline.observe("video", nextVideoMs, (nextVideoMs - VIDEO_BASE_MS) * 1_000);
      nextVideoMs += VIDEO_FRAME_MS;
    }

    const arrivalMs = wallMs + arrivalJitterMs(index);
    // 送る側が付ける LOC TIMESTAMP は「到着 - 基準」である
    const timestampMicros = Math.round((wallMs - audioBaseMsAt(wallMs)) * 1_000);
    timeline.observe("audio", arrivalMs, timestampMicros);

    // AudioContext の時計。鳴り始める時刻は予約した時刻を対応で performance 軸へ換算する
    const contextNowSeconds = arrivalMs / 1_000;
    clock.update(null, contextNowSeconds, arrivalMs);

    const targetMs = timeline.presentationPerformanceMs("audio", timestampMicros);
    const targetStartSeconds = targetMs === null ? null : clock.toAudioSeconds(targetMs);
    const playoutDelaySeconds =
      Math.max(
        timeline.playoutDelayMs ?? AUDIO_PLAYOUT_DELAY_FLOOR_MS,
        AUDIO_PLAYOUT_DELAY_FLOOR_MS,
      ) / 1_000;
    const decision = playout.schedule(contextNowSeconds, timestampMicros, AUDIO_FRAME_MS / 1_000, {
      targetStartSeconds,
      // 映像も購読しているため目標を守る (実測と同じ条件)
      enforceTarget: true,
      delaySeconds: playoutDelaySeconds,
      arrivalDelaySeconds: arrivalPlayoutDelaySeconds(playoutDelaySeconds),
      presentationDelaySeconds:
        (timeline.presentationExtraDelayMs ?? AUDIO_PLAYOUT_DELAY_FLOOR_MS) / 1_000,
    });
    if (decision.kind === "drop") {
      stats.recordMiss({
        atMs: arrivalMs,
        reason: decision.reason,
        durationMs: AUDIO_FRAME_MS,
        targetMs,
        arrivalMs,
      });
      continue;
    }
    if (timeline.sharingBases) {
      sharedBaseFrames++;
    }
    const startMs =
      clock.toPerformanceMs(decision.startAt) ??
      arrivalMs + (decision.startAt - contextNowSeconds) * 1_000;
    // 実際の再生と同じ順で結果を返す (詰めた分だけ長さが縮む)
    playout.confirmStretch(decision.compressSeconds);
    playout.confirmConcealment(0);
    stats.recordPlay(
      arrivalMs,
      targetMs,
      startMs,
      AUDIO_FRAME_MS - decision.compressSeconds * 1_000,
      decision.basis,
    );
  }

  const snapshot = stats.snapshot(SCENARIO_MS);
  if (snapshot.startDelayMs === null) {
    throw new Error("expected a startDelay distribution");
  }
  return {
    startDelayP50: snapshot.startDelayMs.p50,
    startDelayMax: snapshot.startDelayMs.max,
    arrivalPlannedFrames: snapshot.arrivalPlannedFrames,
    unplannedFrames: snapshot.unplannedFrames,
    missedFrames: snapshot.missedFrames,
    latenessMisses: snapshot.missedByReason.lateness.count,
    playedFrames: snapshot.playedFrames,
    sharedBaseFrames,
  };
}

// 受け入れ条件: TIMESTAMP が途中で 600 ms 段差でずれても、到着から鳴り始めるまでの時間が
// 100 ms 程度に収まり、鳴り遅れで音を捨てず、すべての音が計画に載る。修正前は、基準が共有
// されなくなった後も TIMESTAMP のずれを揺らぎとして学習した値 (316〜500 ms) で並べ、
// 予定より 507 ms 遅く届いた音を lateness として捨てていた
test("TIMESTAMP が段差でずれても、到着基準の小さな目標で鳴らし、鳴り遅れで捨てない", () => {
  const result = runScenario(STEP_AT_MS);

  // 到着から鳴り始めるまでの時間は、到着基準の小さな目標 (100 ms 程度) に収まる
  assert.isAtLeast(result.startDelayP50, AUDIO_PLAYOUT_DELAY_FLOOR_MS, "下限を下回らないこと");
  assert.isAtMost(result.startDelayP50, 150, "実測の 316 ms のような遅れを作らないこと");
  assert.isAtMost(result.startDelayMax, 150, "大きな遅れを残さないこと");

  // 鳴り遅れで音を捨てない (遅れて届いても鳴らす)
  assert.equal(result.latenessMisses, 0, "lateness で捨てないこと");
  assert.equal(result.missedFrames, 0, "鳴らさなかった音が無いこと");

  // 予定を時間軸から決められない音も、到着基準の計画で鳴らす
  assert.isAbove(result.arrivalPlannedFrames, 0, "到着基準へ並べ直すこと");
  assert.equal(result.unplannedFrames, 0, "計画に載っていない音が無いこと");
  assert.equal(result.playedFrames, SCENARIO_MS / AUDIO_FRAME_MS, "すべての音を鳴らすこと");

  // 段差の後は基準を共有できない (到着基準で鳴らす状態になること)
  assert.isBelow(result.sharedBaseFrames, result.playedFrames / 2);
});

// 受け入れ条件: TIMESTAMP が正しいとき (正常時) の並べ方は変えない。目標の時刻に従って
// 鳴らし、到着基準へ並べ直さない。遅れて届いた音も今 + 余裕で鳴らして詰める (既存の挙動)
test("TIMESTAMP が正しいときは、目標の時刻に従って鳴らし、到着基準へ並べ直さない", () => {
  const result = runScenario(null);

  // 目標を守るときの遅れは、表示の遅れ (targetLatency 100 ms + 基準の遅れ 40 ms) と
  // 到着のずれで決まる。到着基準へ並べ直した音は無い
  assert.equal(result.arrivalPlannedFrames, 0, "到着基準へ並べ直さないこと");
  assert.isAtMost(result.startDelayP50, TARGET_LATENCY_MS, "表示の遅れを超えないこと");
  assert.isAtLeast(result.startDelayP50, AUDIO_PLAYOUT_DELAY_FLOOR_MS, "下限を下回らないこと");
  assert.equal(result.missedFrames, 0);
  assert.equal(result.latenessMisses, 0);
  assert.equal(result.unplannedFrames, 0);
  assert.equal(result.sharedBaseFrames, result.playedFrames, "基準を共有したままであること");
});
