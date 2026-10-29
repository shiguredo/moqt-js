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
