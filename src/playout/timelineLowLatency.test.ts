/** 到着の分布と実出力の先行量から、余分な待ちを保持せずに A/V の予算を決める。 */
import { assert, test } from "vite-plus/test";
import { PlayoutTimeline, type PlayoutStream } from "./timeline";

const TIME_ORIGIN_MS = 1_790_000_000_000;

function timelineOf(): PlayoutTimeline {
  return new PlayoutTimeline({ timeOriginMs: TIME_ORIGIN_MS, maxQueuedFrames: 24 });
}

/**
 * 実クラスへ時刻を渡す。復号済みの入力はトラック内の媒体順を守り、
 * 停滞からの復帰だけは複数のフレームがまとめて届く条件を作る。
 */
function drive(
  timeline: PlayoutTimeline,
  extraDelay: (stream: PlayoutStream, mediaMs: number, index: number) => number,
): void {
  const events: { stream: PlayoutStream; mediaMs: number; arrivalMs: number }[] = [];
  for (const stream of ["audio", "video"] as const) {
    const frequency = stream === "audio" ? 50 : 30;
    let previousArrivalMs = -Infinity;
    for (let index = 0; index < frequency * 10; index++) {
      const mediaMs = 1000 + (index * 1000) / frequency;
      const arrivalMs = Math.max(
        previousArrivalMs + 0.1,
        mediaMs + 20 + extraDelay(stream, mediaMs, index),
      );
      previousArrivalMs = arrivalMs;
      events.push({ stream, mediaMs, arrivalMs });
    }
  }
  events.sort((left, right) => left.arrivalMs - right.arrivalMs);
  for (const event of events) {
    const wallClockMs = TIME_ORIGIN_MS + event.arrivalMs;
    timeline.observe(
      event.stream,
      wallClockMs,
      Math.round((TIME_ORIGIN_MS + event.mediaMs) * 1000),
    );
    if (event.stream === "audio") timeline.observeAudioOutputLead(43, wallClockMs);
  }
}

test("正常到着では音声 50 ms と映像の同期だけを確保する", () => {
  const timeline = timelineOf();
  drive(timeline, () => 0);
  assert.closeTo(timeline.playoutDelayMs ?? 0, 50, 0.01);
  assert.closeTo(timeline.videoDelayMs ?? 0, 45, 0.01);
  assert.closeTo(timeline.audioDelayStats().outputLeadMs ?? -1, 43, 0.01);
});

test("出力の先行量と到着の揺らぎを足し、出力の都合で予約できない位置を目標にしない", () => {
  const timeline = timelineOf();
  drive(timeline, (stream, _mediaMs, index) => (stream === "audio" && index % 5 === 1 ? 30 : 0));
  const delay = timeline.audioDelayStats();
  assert.closeTo(delay.jitterMs ?? -1, 30, 0.01, "媒体時刻からの到着の幅を測ること");
  assert.closeTo(delay.targetMs, 73, 0.01, "出力 43 ms と揺らぎ 30 ms の両方を予約に確保すること");
  const { audio, video } = timeline.delayBreakdown;
  assert.isAtMost(
    Math.abs((audio.presentationDelayMs ?? 0) - (video.presentationDelayMs ?? 0)),
    5.01,
    "音声の予算を映像にも反映すること",
  );
});

test("一度の 180 ms の到着停滞を、回復後の恒常的な待ちへ移さない", () => {
  const timeline = timelineOf();
  drive(timeline, (_stream, mediaMs) => (mediaMs >= 3000 && mediaMs < 3180 ? 3180 - mediaMs : 0));
  assert.isAtMost(timeline.audioDelayStats().targetMs, 50.01, "停滞前後の正常な到着へ戻ること");
  assert.isAtMost(
    timeline.videoDelayMs ?? Infinity,
    50.01,
    "解消済みの停滞を同期の待ちへ残さないこと",
  );
});

test("映像が 3 秒間遅れた後も、10 秒の基準窓や同期の保持で音声を遅らせ続けない", () => {
  const timeline = timelineOf();
  drive(timeline, (stream, mediaMs) =>
    stream === "video" && mediaMs >= 3000 && mediaMs < 6000 ? 120 : 0,
  );
  const { audio, video } = timeline.delayBreakdown;
  assert.isAtMost(audio.syncExtraDelayMs, 0.01, "元に戻った映像のために音声を待たせないこと");
  assert.isAtMost(
    video.presentationDelayMs ?? Infinity,
    70.01,
    "最小経路 20 ms と通常の予算へ戻ること",
  );
});

test("音声の再開では旧 Context の出力先行量を捨てる", () => {
  const timeline = timelineOf();
  drive(timeline, () => 0);
  timeline.resetStream("audio");
  assert.isNull(
    timeline.audioDelayStats().outputLeadMs,
    "新しい出力時計が来るまでは未観測であること",
  );
  assert.equal(timeline.audioDelayStats().targetMs, 50);
});

test("起動直後の不規則な遅着の最中に追いつきを完了して待ちを学習しない", () => {
  const timeline = timelineOf();
  // Chrome の起動時に観測した、短い正常到着、停止、古い出力、まとめた復帰を相対化する。
  // 最小経路は 20 ms のままなので、最小値だけを比較すると停止の最中に完了してしまう。
  const arrivals: [mediaMs: number, arrivalMs: number][] = [
    [0, 20],
    [20, 40],
    [40, 60],
    [60, 80],
    [80, 100],
    [100, 340],
    [120, 342],
    [140, 390],
    [300, 392],
    [320, 394],
    [340, 396],
    [360, 398],
    [380, 400],
  ];
  for (let mediaMs = 400; mediaMs <= 700; mediaMs += 20) arrivals.push([mediaMs, mediaMs + 20]);
  for (const [mediaMs, arrivalMs] of arrivals) {
    const wallClockMs = TIME_ORIGIN_MS + arrivalMs;
    timeline.observe("audio", wallClockMs, (TIME_ORIGIN_MS + mediaMs) * 1000);
    timeline.observeAudioOutputLead(43, wallClockMs);
  }
  assert.closeTo(
    timeline.audioDelayStats().targetMs,
    50,
    0.01,
    "解消した起動時の停滞を予算に残さないこと",
  );
});

test("起動中に経路が遅くなっても、媒体の周期で届く状態は通常の揺らぎとして学習する", () => {
  const timeline = timelineOf();
  // 大きな遅れだけを見て初期学習を止め続けると、定常化した新しい経路も学べなくなる。
  for (let mediaMs = 0; mediaMs <= 1000; mediaMs += 20) {
    const arrivalMs = mediaMs + (mediaMs < 100 ? 20 : 240);
    timeline.observe("audio", TIME_ORIGIN_MS + arrivalMs, (TIME_ORIGIN_MS + mediaMs) * 1000);
    timeline.observeAudioOutputLead(43, TIME_ORIGIN_MS + arrivalMs);
  }
  assert.closeTo(timeline.audioDelayStats().jitterMs ?? 0, 220, 0.01, "持続する遅れを学習すること");
  assert.equal(timeline.audioDelayStats().targetMs, 100);
});
