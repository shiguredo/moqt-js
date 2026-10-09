/**
 * 目標の基準が共有されなくなったときの、音声の再生と A/V 同期の受け入れ条件
 *
 * devtools の購読 (マイク + カメラ、`audioDelivery: subgroup`、jitter buffer 有効) の実測では、
 * 送る側の音声の LOC TIMESTAMP がセッションの途中で 40 ms から 623 ms へ段差でずれた。到着は
 * 乱れていないため、ずれているのは TIMESTAMP であり、音の内容が遅れているわけではない。
 * それでも受信側では次の 4 つが起きていた。
 *
 * - 到着から鳴り始めるまでが 316 ms (p50)、最大 598 ms になった。時間軸の基準が共有されなく
 *   なると到着基準で並べるが、その再生の遅れに、TIMESTAMP のずれを揺らぎとして学習した値
 *   (316〜500 ms) をそのまま使っていたためである
 * - 予定より 507 ms 遅く届いた音が `lateness` として捨てられ、語尾が切れた。予定 (TIMESTAMP
 *   から決まる時刻) の方が 500 ms 過去にずれているだけであり、音は遅れていない
 * - 予定を決められない音が `unplannedFrames` に数えられ、予定に対する余裕を読めなかった
 * - 段差を揺らぎとして学習した音声の遅延 (目標が 700 ms) へ映像を合わせて、映像の
 *   `syncExtraDelayMs` が 600.5 になり、`displayWait` が 496 ms になった。時計のずれの
 *   証拠 (差が動き続けていること) を見る前だったため、合わせる量の上限
 *   (`PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS` = 100 ms) が掛からず、全額を合わせていた。
 *   その後は毎秒 20 ms でしか戻らず、数十秒間映像が遅れたままになった
 * - 音声は到着基準へ並べ直すたびに余分な遅れが積み上がり、`playoutRebases` が 24 回に
 *   なった (17 秒のセッション)。並べ直すと媒体時刻が跳び、鳴っている音の続きが前へずれる
 *
 * 受け入れ条件を固定した後も、到着から鳴り始めるまでが目標 (100 ms) より 95.5 ms 長いまま
 * だった (音声 195.5 ms 対 映像 98.4 ms、A/V のずれ約 100 ms)。原因は到着基準の目標を
 * 「予約の軸」(`AudioContext.currentTime`) から数えていたことである。`AudioContext` の時計は
 * 既に出力のバッファへ積まれた分だけ実際に鳴る位置より先に進むため、実際に鳴るのは
 * 「到着 + 到着基準の遅れ + バッファの分」になる。実測の 195.5 ms は「100 ms + バッファの
 * 分 95.5 ms」そのものであり、`startDelayMs` は `AudioClockBridge` で実際に鳴る位置へ
 * 換算した値である (定義上この差がそのまま乗る)。この 95.5 ms は環境 (出力デバイスの
 * バッファ) で決まる値であり、確認用に測ると、このリポジトリの headless Chromium では
 * `AudioContext.currentTime` と `getOutputTimestamp().contextTime` の差が約 18 ms だった。
 *
 * このファイルは、実測と同じ入力 (TIMESTAMP が途中でずれる、到着は乱れない、映像は正常) を、
 * 時間軸 (`PlaybackTimeline`)、鳴らす時刻の決定 (`AudioPlayoutScheduler`)、観測
 * (`AudioPlayoutTimingStats`) を本物のまま繋いで再現し、次の受け入れ条件を固定する。
 *
 * - 到着から鳴り始めるまでの時間 (`startDelayMs`) の p50 が 130 ms 以下になる。目標は
 *   到着基準の遅れ (100 ms) であり、出力のバッファの分だけ先に進んでいる間は
 *   それでも早く鳴らせない (`AUDIO_PLAYOUT_MIN_LEAD_SECONDS` + バッファの分)
 * - 音声の表示時刻 (鳴り始める時刻) と映像の表示時刻のずれが ±50 ms 以内になる。基準を
 *   共有できないときも、映像を音声の到着基準の時刻へ合わせる
 * - 鳴り遅れで音を捨てない (`missedFrames` が 0 のまま)
 * - 到着基準で鳴らす音も計画に載せ、`unplannedFrames` が 0 になる
 * - 音声の並べ直し (`playoutRebases`) が 2 回以下に収まる。並べ直すのは音が本当に途切れた
 *   ときだけ
 * - 映像は音声の膨らんだ遅延に合わせない。`videoSyncExtraDelayMs` が上限 (100 ms) まで、
 *   `displayWait` が 150 ms 以下に留まる
 * - TIMESTAMP が正しいとき (正常時) の並べ方は変わらない
 *
 * 時刻は `performance.now()` と同じ軸の値で与える。鳴り始める時刻は `AudioContext` の時計へ
 * 予約した時刻を `AudioClockBridge` で同じ軸へ換算した値であり、音声出力デバイスの遅延は
 * `ScenarioOptions.outputLeadMs` としてモデルに入れる。
 */

import { test, assert } from "vite-plus/test";
import {
  AUDIO_PLAYOUT_MIN_LEAD_SECONDS,
  arrivalPlayoutDelaySeconds,
  AudioClockBridge,
  AudioPlayoutScheduler,
} from "./audioPlayout";
import { AudioPlayoutTimingStats } from "./audioPlayoutTimingStats";
import {
  AUDIO_PLAYOUT_DELAY_FLOOR_MS,
  PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS,
  PlaybackTimeline,
} from "./playbackTimeline";
import { summarizeTimings } from "./timingSummary";

/** Opus の 1 フレーム (20 ms) */
const AUDIO_FRAME_MS = 20;
/** 映像のフレーム間隔 (30 fps、ミリ秒) */
const VIDEO_FRAME_MS = 1_000 / 30;
/** 音声の基準 (到着 - TIMESTAMP) の、ずれる前の値 (ミリ秒)。実測の 40 ms に合わせる */
const AUDIO_BASE_MS = 40;
/** 映像の基準 (到着 - TIMESTAMP) の値 (ミリ秒)。実測の 13.4 ms に合わせる */
const VIDEO_BASE_MS = 13.4;
/** 段差の後の、音声の基準 (到着 - TIMESTAMP)。実測の 484.9 ms に合わせる */
const AUDIO_BASE_AFTER_STEP_MS = 484.9;
/** TIMESTAMP の段差 (ミリ秒)。実測の 40 ms → 484.9 ms に合わせる */
const TIMESTAMP_STEP_MS = AUDIO_BASE_AFTER_STEP_MS - AUDIO_BASE_MS;
/** 段差が入る時刻 (ミリ秒)。セッションの途中にする */
const STEP_AT_MS = 5_000;
/** 模擬する長さ (ミリ秒)。分布の窓もこの長さにして、全体を 1 つの窓で見る */
const SCENARIO_MS = 25_000;
/** 落ち着いた後の A/V のずれを見る窓 (ミリ秒)。音声の再生の観測と同じ長さにする */
const AV_STEADY_WINDOW_MS = 10_000;
/** catalog の targetLatency (ミリ秒)。表示の遅れの下限である */
const TARGET_LATENCY_MS = 100;
/** 表示待ちのキューの上限 (枚)。devtools の jitter buffer と同じ値 */
const MAX_QUEUED_FRAMES = 24;

/**
 * `AudioContext` の時計が、実際に鳴る位置より先に進んでいる分 (ミリ秒)
 *
 * 実測の `startDelayMs` の p50 は 195.5 ms、到着基準の目標は 100 ms である。この差の
 * 95.5 ms が、既に出力のバッファへ積まれている分である (`startDelayMs` は
 * `AudioClockBridge` で実際に鳴る位置へ換算した値であり、定義上この差がそのまま乗る)。
 * 値は環境 (出力デバイスとブラウザのバッファ) で決まる
 */
const MEASURED_OUTPUT_LEAD_MS = 95.5;

/**
 * このリポジトリの headless Chromium で測った、同じ差 (ミリ秒)
 *
 * `AudioContext.currentTime` と `getOutputTimestamp().contextTime` の差である。実測の環境
 * (95.5 ms) とは別の値であり、環境で決まることを確かめるために使う
 */
const LOCAL_CHROMIUM_OUTPUT_LEAD_MS = 18;

/**
 * 映像の揺らぎ (ミリ秒) と、その揺らぎが乗る間隔 (枚)
 *
 * 実測の映像は `jitterDelayMs` が 85 ms であり (表示待ち p50 87.4 ms)、揺らぎ 0 ではない。
 * 30 fps の p95 (約 96.7 分位) をこの値にするため、20 枚に 1 枚だけ遅らせる。小さい値の
 * 場合は、音声の到着基準の時刻 (100 ms) へ映像を合わせる必要が出る (A/V のずれ)
 */
const VIDEO_JITTER_MS = 85;
const VIDEO_JITTER_EVERY = 20;
/**
 * 映像の揺らぎを与え始める枚数
 *
 * 購読の開始直後の 1 枚だけを遅らせると、映像の基準 (窓の最小値) が 1 度だけ動き、時間軸が
 * それを「基準の差が動き続けている」と判定してしまう (実測の入力ではない)。2 秒後から
 * 与える
 */
const VIDEO_JITTER_START_INDEX = 60;

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
  /** 到着から鳴り始めるまでの時間の p50 / p95 / 最大 (ミリ秒) */
  readonly startDelayP50: number;
  readonly startDelayP95: number;
  readonly startDelayMax: number;
  readonly arrivalPlannedFrames: number;
  readonly unplannedFrames: number;
  readonly missedFrames: number;
  readonly playedFrames: number;
  /** 基準を共有できていた音の数 (正常時の並べ方かを確かめる) */
  readonly sharedBaseFrames: number;
  /** 音声の基準を取り直した回数 (目標から離れすぎた音の並べ直し) */
  readonly playoutRebases: number;
  /** 映像へ同期の制御が足した分の最大値 (ミリ秒)。上限 (100 ms) を超えない */
  readonly videoSyncExtraMaxMs: number;
  /** 映像の表示待ち (キューが保持する長さ) の p50 / 最大 (ミリ秒) */
  readonly videoDelayP50Ms: number;
  readonly videoDelayMaxMs: number;
  /** 音声の到着基準の再生の遅れ (ミリ秒) */
  readonly audioArrivalDelayMs: number;
  /**
   * A/V のずれ (ミリ秒) の p50 / p95 / 最大
   *
   * 同じメディア時刻の音声の表示時刻 (鳴り始める時刻) と映像の表示時刻の差である。音声と
   * 映像は同じ時刻に到着する (同じ publisher・同じ経路) ため、到着からの遅れの差が
   * そのままずれになる
   */
  readonly avDifferenceP50Ms: number;
  readonly avDifferenceP95Ms: number;
  readonly avDifferenceMaxMs: number;
  /**
   * 直近の窓 (`AV_STEADY_WINDOW_MS`) だけの A/V のずれの p50 / p95 / 最大 (ミリ秒)
   *
   * TIMESTAMP の段差の直後は、時間軸がずれを検出するまで (2 秒ほど) 音声が予定を過ぎた
   * 時刻へ並ぶ。その過渡を除いた、落ち着いた後のずれである
   */
  readonly steadyAvDifferenceP50Ms: number;
  readonly steadyAvDifferenceP95Ms: number;
  readonly steadyAvDifferenceMaxMs: number;
}

/** 模擬の入力 */
interface ScenarioOptions {
  /** `AudioContext` の時計が実際に鳴る位置より先に進んでいる分 (ミリ秒) */
  readonly outputLeadMs: number;
  /** 映像の揺らぎ (ミリ秒)。20 枚に 1 枚だけ遅らせる */
  readonly videoJitterMs?: number;
  /** catalog の `targetLatency` (ミリ秒)。2 つのトラックの表示の遅れの下限 */
  readonly targetLatencyMs?: number;
}

/**
 * 音声と映像を 1 つの時間軸へ流し、音声だけを `AudioPlayoutScheduler` で並べる
 *
 * devtools と `src/createMediaSubscriber.ts` の音声の経路と同じ順で呼ぶ。TIMESTAMP の段差は
 * `stepAtMs` 以降に加える (null なら段差なし = 正常時)。
 *
 * @param stepAtMs - TIMESTAMP に段差を入れる時刻 (ミリ秒)。入れないときは null
 * @param options - 模擬の入力 (出力のバッファの分、映像の揺らぎ、`targetLatency`)
 */
function runScenario(stepAtMs: number | null, options: ScenarioOptions): ScenarioResult {
  const timeline = new PlaybackTimeline({ timeOriginMs: 0, maxQueuedFrames: MAX_QUEUED_FRAMES });
  timeline.setTargetLatencyMs(options.targetLatencyMs ?? TARGET_LATENCY_MS);
  const playout = new AudioPlayoutScheduler();
  const clock = new AudioClockBridge();
  const stats = new AudioPlayoutTimingStats(SCENARIO_MS, 0);
  const videoJitterMs = options.videoJitterMs ?? VIDEO_JITTER_MS;

  // 段差が入った後は、音声の基準 (到着 - TIMESTAMP) が広がったままになる
  const audioBaseMsAt = (wallMs: number): number =>
    stepAtMs !== null && wallMs >= stepAtMs ? AUDIO_BASE_MS + TIMESTAMP_STEP_MS : AUDIO_BASE_MS;

  let sharedBaseFrames = 0;
  let nextVideoMs = 0;
  let videoFrameIndex = 0;
  // 映像の表示待ち (キューが保持する長さ) と、同期の制御が足した分の記録
  const videoDelaysMs: number[] = [];
  let videoSyncExtraMaxMs = 0;
  // A/V のずれ (音声の表示時刻 - 映像の表示時刻)。音声を 1 つ並べるたびに記録する。
  // 落ち着いた後 (直近の窓) だけの値も別に求める (段差の直後は過渡である)
  const avDifferences: { atMs: number; differenceMs: number }[] = [];
  const audioFrames = Math.floor(SCENARIO_MS / AUDIO_FRAME_MS);
  for (let index = 0; index < audioFrames; index++) {
    const wallMs = index * AUDIO_FRAME_MS;
    // 映像も同じ時間軸へ記録する (共有の基準が決まる条件)。実測と同じく揺らぎも与える
    // (遅れる向きだけ。音声と同じく、早く届くことはない)
    while (nextVideoMs <= wallMs) {
      const jitterMs =
        videoFrameIndex >= VIDEO_JITTER_START_INDEX && videoFrameIndex % VIDEO_JITTER_EVERY === 0
          ? videoJitterMs
          : 0;
      videoFrameIndex++;
      timeline.observe("video", nextVideoMs + jitterMs, (nextVideoMs - VIDEO_BASE_MS) * 1_000);
      nextVideoMs += VIDEO_FRAME_MS;
    }
    // 映像の表示待ちは「復号の出力から表示時刻まで」であり、時間軸が決めた映像の遅れ
    // (`videoDelayMs`) と同じ値になる (devtools の displayWait と同じ求め方)
    const videoDelayMs = timeline.videoDelayMs;
    if (videoDelayMs !== null) {
      videoDelaysMs.push(videoDelayMs);
    }
    videoSyncExtraMaxMs = Math.max(
      videoSyncExtraMaxMs,
      timeline.delayBreakdown.video.syncExtraDelayMs,
    );

    const arrivalMs = wallMs + arrivalJitterMs(index);
    // 送る側が付ける LOC TIMESTAMP は「到着 - 基準」である
    const timestampMicros = Math.round((wallMs - audioBaseMsAt(wallMs)) * 1_000);
    timeline.observe("audio", arrivalMs, timestampMicros);

    // 実測と同じく、AudioContext の時計は実際に鳴る位置より outputLeadMs だけ先に進む。
    // 対応 (`getOutputTimestamp`) は「その位置がいつ鳴るか」を表すため、鳴っている位置は
    // 到着の時刻と同じにし、原点のずれも 0 にする
    const contextNowSeconds = arrivalMs / 1_000 + options.outputLeadMs / 1_000;
    clock.update(
      { contextTime: arrivalMs / 1_000, performanceTime: arrivalMs },
      contextNowSeconds,
      arrivalMs,
    );
    // 到着した音がまだ鳴っていない位置。到着の時刻を AudioContext の秒へ換算した値である
    const arrivalSeconds = clock.toAudioSeconds(arrivalMs) ?? contextNowSeconds;

    const targetMs = timeline.presentationPerformanceMs("audio", timestampMicros);
    const targetStartSeconds = targetMs === null ? null : clock.toAudioSeconds(targetMs);
    const playoutDelaySeconds =
      Math.max(
        timeline.playoutDelayMs ?? AUDIO_PLAYOUT_DELAY_FLOOR_MS,
        AUDIO_PLAYOUT_DELAY_FLOOR_MS,
      ) / 1_000;
    const decision = playout.schedule(contextNowSeconds, timestampMicros, AUDIO_FRAME_MS / 1_000, {
      targetStartSeconds,
      arrivalSeconds,
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
    if (videoDelayMs !== null) {
      avDifferences.push({
        atMs: arrivalMs,
        differenceMs: Math.abs(startMs - arrivalMs - videoDelayMs),
      });
    }
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
  const videoDelays = summarizeTimings(videoDelaysMs);
  if (videoDelays === null) {
    throw new Error("expected a video delay distribution");
  }
  const avDifferenceSummary = summarizeTimings(avDifferences.map((entry) => entry.differenceMs));
  if (avDifferenceSummary === null) {
    throw new Error("expected an A/V difference distribution");
  }
  const steadyAvDifferences = summarizeTimings(
    avDifferences
      .filter((entry) => entry.atMs >= SCENARIO_MS - AV_STEADY_WINDOW_MS)
      .map((entry) => entry.differenceMs),
  );
  if (steadyAvDifferences === null) {
    throw new Error("expected a steady A/V difference distribution");
  }
  // 音声の到着基準の再生の遅れ。呼び出し側 (と時間軸) が使うのと同じ規則で求める
  const audioArrivalDelayMs =
    arrivalPlayoutDelaySeconds(
      Math.max(
        timeline.playoutDelayMs ?? AUDIO_PLAYOUT_DELAY_FLOOR_MS,
        AUDIO_PLAYOUT_DELAY_FLOOR_MS,
      ),
    ) * 1_000;
  return {
    startDelayP50: snapshot.startDelayMs.p50,
    startDelayP95: snapshot.startDelayMs.p95,
    startDelayMax: snapshot.startDelayMs.max,
    arrivalPlannedFrames: snapshot.arrivalPlannedFrames,
    unplannedFrames: snapshot.unplannedFrames,
    missedFrames: snapshot.missedFrames,
    playedFrames: snapshot.playedFrames,
    sharedBaseFrames,
    playoutRebases: playout.rebases,
    videoSyncExtraMaxMs,
    videoDelayP50Ms: videoDelays.p50,
    videoDelayMaxMs: videoDelays.max,
    audioArrivalDelayMs,
    avDifferenceP50Ms: avDifferenceSummary.p50,
    avDifferenceP95Ms: avDifferenceSummary.p95,
    avDifferenceMaxMs: avDifferenceSummary.max,
    steadyAvDifferenceP50Ms: steadyAvDifferences.p50,
    steadyAvDifferenceP95Ms: steadyAvDifferences.p95,
    steadyAvDifferenceMaxMs: steadyAvDifferences.max,
  };
}

/** 実測の入力 (段差あり、映像の揺らぎは実測の 85 ms) */
function runMeasuredScenario(): ScenarioResult {
  return runScenario(STEP_AT_MS, { outputLeadMs: MEASURED_OUTPUT_LEAD_MS });
}

// 受け入れ条件 (1): TIMESTAMP が途中で 600 ms 段差でずれても、映像を音声の膨らんだ遅延に
// 合わせない。修正前は、時計のずれの証拠を見る前に上限が掛からず、映像へ 497 ms を足して
// 表示待ちが上限の 500 ms に張り付いた (実測では syncExtraDelayMs 600.5、displayWait
// 496.2 ms)。修正後は合わせる量が上限 (PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS = 100 ms)
// までになり、映像の表示待ちは 150 ms 以下に留まる
test("TIMESTAMP が段差でずれても、映像へ足す遅延は上限までにする", () => {
  const result = runMeasuredScenario();

  // 映像へ足す分は上限までである (時計のずれの証拠を見る前でも掛ける)
  assert.isAtMost(
    result.videoSyncExtraMaxMs,
    PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS,
    "映像へ足す分が上限を超えないこと",
  );
  // 映像の表示待ちは、本来の表示の遅れ (映像の揺らぎ) と足した分の合計に留まる。実測の
  // 496 ms のような待ちを作らない
  assert.isAtMost(result.videoDelayMaxMs, 100 + PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS + 1);
  assert.isAtMost(result.videoDelayP50Ms, 150, "表示待ちの p50 が 150 ms 以下であること");
});

// 受け入れ条件 (2): TIMESTAMP が途中で段差でずれても、到着から鳴り始めるまでの時間が
// 130 ms 以下に収まり、鳴り遅れで音を捨てず、すべての音が計画に載る。修正前は、基準が
// 共有されなくなった後も TIMESTAMP のずれを揺らぎとして学習した値 (316〜500 ms) で並べ、
// 予定より 507 ms 遅く届いた音を lateness として捨てていた
test("TIMESTAMP が段差でずれても、到着基準の小さな目標で鳴らし、鳴り遅れで捨てない", () => {
  const result = runMeasuredScenario();

  // 到着から鳴り始めるまでの時間は、到着基準の小さな目標 (100 ms 程度) に収まる
  assert.isAtLeast(result.startDelayP50, AUDIO_PLAYOUT_DELAY_FLOOR_MS, "下限を下回らないこと");
  assert.isAtMost(result.startDelayP50, 130, "実測の 195.5 ms のような遅れを残さないこと");
  assert.isAtMost(result.startDelayMax, 130, "大きな遅れを残さないこと");

  // 鳴り遅れで音を捨てない (遅れて届いても鳴らす)
  assert.equal(result.missedFrames, 0, "鳴らさなかった音が無いこと");

  // 予定を時間軸から決められない音も、到着基準の計画で鳴らす
  assert.isAbove(result.arrivalPlannedFrames, 0, "到着基準の計画で鳴らすこと");
  assert.equal(result.unplannedFrames, 0, "計画に載っていない音が無いこと");
  assert.equal(result.playedFrames, SCENARIO_MS / AUDIO_FRAME_MS, "すべての音を鳴らすこと");

  // 並べ直し (媒体時刻を跳ばすこと) は、音が本当に途切れたときだけである。段差の直後は
  // 音が連続しているため、並べ直さずに遅れたまま鳴らす。実測では 24 回起きていた
  assert.isAtMost(result.playoutRebases, 2, "音が連続している間は並べ直さないこと");

  // 段差の後は基準を共有できない (到着基準で鳴らす状態になること)
  assert.isBelow(result.sharedBaseFrames, result.playedFrames / 2);
});

// 受け入れ条件 (3): 到着から鳴り始めるまでの時間は、到着基準の遅れそのものである。修正前は、
// 到着基準の目標を予約の軸 (`AudioContext.currentTime`) から数えていたため、実際に鳴るのは
// 「到着 + 到着基準の遅れ + 出力のバッファの分」になり、実測では 195.5 ms だった
// (100 ms + 95.5 ms)。AudioContext の時計が先に進んでいる分は、予約できる最も早い時刻
// (今 + AUDIO_PLAYOUT_MIN_LEAD_SECONDS) までしか取り戻せない
test("TIMESTAMP が段差でずれても、到着から鳴り始めるまでが到着基準の遅れになる", () => {
  for (const outputLeadMs of [0, LOCAL_CHROMIUM_OUTPUT_LEAD_MS, MEASURED_OUTPUT_LEAD_MS]) {
    const result = runScenario(STEP_AT_MS, { outputLeadMs });
    // 到着基準の遅れは、学習した値 (段差を揺らぎとして学習して膨らむ) を上限 100 ms で切った値
    assert.isAtMost(result.audioArrivalDelayMs, 100, "到着基準の遅れが上限を超えないこと");
    // 鳴り始めるまで = max(到着基準の遅れ, 今 + 余裕 + 出力のバッファの分)。予約できる最も
    // 早い時刻より前には鳴らせない
    const expectedMs = Math.max(
      result.audioArrivalDelayMs,
      AUDIO_PLAYOUT_MIN_LEAD_SECONDS * 1_000 + outputLeadMs,
    );
    assert.closeTo(
      result.startDelayP50,
      expectedMs,
      1,
      `出力のバッファ ${outputLeadMs} ms: バッファの分を二重に数えないこと`,
    );
    // 実測の環境 (バッファ 95.5 ms) でも 130 ms 以下になる
    assert.isAtMost(result.startDelayP50, 130, "実測の 195.5 ms のような遅れを残さないこと");
  }
});

// 受け入れ条件 (4): 基準を共有できない状態でも、音声の表示時刻 (鳴り始める時刻) と映像の
// 表示時刻のずれが ±50 ms 以内になる。修正前は、音声が到着基準の遅れ + 出力のバッファの分
// (実測で 195.5 ms) だけ遅れて鳴り、映像は自分の表示の遅れのままだったため、ずれが
// 100 ms 前後になっていた
test("TIMESTAMP が段差でずれても、A/V のずれが ±50 ms 以内になる", () => {
  // 実測の入力 (映像の揺らぎ 85 ms、catalog の targetLatency 100 ms)
  const measured = runMeasuredScenario();
  assert.isAtMost(measured.avDifferenceP50Ms, 50, "A/V のずれの p50 が 50 ms 以内であること");
  // 落ち着いた後 (直近の 10 秒) は 50 ms 以内になる。段差の直後の 2 秒ほどは、時間軸が
  // ずれを検出するまで音声が予定を過ぎた時刻へ並ぶため、その分 (最大 100 ms 程度) が残る
  assert.isAtMost(measured.steadyAvDifferenceP50Ms, 50, "A/V のずれの p50 が 50 ms 以内であること");
  assert.isAtMost(measured.steadyAvDifferenceP95Ms, 50, "A/V のずれの p95 が 50 ms 以内であること");
  assert.isAtMost(measured.steadyAvDifferenceMaxMs, 50, "A/V のずれが 50 ms を超えないこと");

  // 映像の表示の遅れが音声の到着基準の遅れより小さいときは、映像をその時刻へ合わせる。
  // targetLatency を 50 ms、映像の揺らぎを 0 にすると、映像の表示の遅れは 50 ms であり、
  // 音声の到着基準の遅れ (100 ms) から不感帯 (30 ms) を引いた 70 ms まで上げる
  const ahead = runScenario(STEP_AT_MS, {
    outputLeadMs: MEASURED_OUTPUT_LEAD_MS,
    videoJitterMs: 0,
    targetLatencyMs: 50,
  });
  assert.closeTo(
    ahead.videoDelayP50Ms,
    ahead.audioArrivalDelayMs - 30,
    1,
    "映像を音声の到着基準の時刻へ合わせること",
  );
  assert.isAtMost(ahead.steadyAvDifferenceP50Ms, 50, "A/V のずれの p50 が 50 ms 以内であること");
  assert.isAtMost(ahead.steadyAvDifferenceP95Ms, 50, "A/V のずれの p95 が 50 ms 以内であること");
  assert.isAtMost(ahead.steadyAvDifferenceMaxMs, 50, "A/V のずれが 50 ms を超えないこと");
  assert.isAtMost(ahead.videoDelayP50Ms, 150, "映像の表示待ちも増やさないこと");
});

// 受け入れ条件 (5): TIMESTAMP が正しいとき (正常時) の並べ方は変えない。目標の時刻に従って
// 鳴らし、到着基準へ並べ直さない。遅れて届いた音も今 + 余裕で鳴らして詰める (既存の挙動)。
// 映像へ足す遅延も 0 のままである。出力のバッファの分があっても、目標の時刻は
// AudioClockBridge で実際に鳴る位置へ換算するため、鳴り始める時刻は変わらない
test("TIMESTAMP が正しいときは、目標の時刻に従って鳴らし、到着基準へ並べ直さない", () => {
  for (const outputLeadMs of [0, LOCAL_CHROMIUM_OUTPUT_LEAD_MS, MEASURED_OUTPUT_LEAD_MS]) {
    const result = runScenario(null, { outputLeadMs, videoJitterMs: 0 });

    // 目標を守るときの遅れは、表示の遅れ (targetLatency 100 ms) と到着のずれで決まる。
    // 到着基準へ並べ直した音は無い
    assert.equal(
      result.arrivalPlannedFrames,
      0,
      `出力のバッファ ${outputLeadMs} ms: 並べ直さないこと`,
    );
    // 目標の時刻は AudioClockBridge で実際に鳴る位置へ換算するため、出力のバッファの分は
    // 到着からの時間に乗らない (予約できる最も早い時刻より前には鳴らせない)
    assert.closeTo(
      result.startDelayP50,
      Math.max(TARGET_LATENCY_MS, AUDIO_PLAYOUT_MIN_LEAD_SECONDS * 1_000 + outputLeadMs),
      1.5,
      "表示の遅れどおりに鳴ること",
    );
    assert.isAtLeast(result.startDelayP50, AUDIO_PLAYOUT_DELAY_FLOOR_MS, "下限を下回らないこと");
    assert.equal(result.missedFrames, 0);
    assert.equal(result.unplannedFrames, 0);
    assert.equal(result.playoutRebases, 0, "並べ直さないこと");
    assert.equal(result.sharedBaseFrames, result.playedFrames, "基準を共有したままであること");
    // 2 つのトラックの差が上限の中にあるため、同期の制御は足さない (0 のまま)
    assert.equal(result.videoSyncExtraMaxMs, 0, "映像へ遅延を足さないこと");
    assert.isAtMost(result.steadyAvDifferenceP50Ms, 50, "A/V のずれが 50 ms 以内であること");
  }
});
