import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { RELAY_PAGE_URL } from "./urls";

// Web Audio と WebCodecs の実物を使い、出力時計、予約、canvas への表示までを通す。
// ネットワークの到着の揺れは別の実リレーの検証で測り、ここでは出力との同期を固定する。
test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

test("実際の音声再生経路と canvas の表示を同期し、音声の停止と再開で状態を取り直す", async ({
  page,
}) => {
  await page.goto(RELAY_PAGE_URL);
  const result = await page.evaluate(
    async (moduleUrl) => {
      const {
        AudioPlayoutSession,
        AudioPlayoutTimingStats,
        PlayoutTimeline,
        VideoPlayoutSession,
        VideoDecodeInputs,
      } = (await import(moduleUrl)) as typeof import("../../src/index");
      let context = new AudioContext({ sampleRate: 48_000, latencyHint: "interactive" });
      await context.resume();
      // テスト中の音は無音にするが、実際の出力グラフと時計は動かす。
      let gain = context.createGain();
      gain.gain.value = 0;
      // 利用側と同じ MediaStream → HTMLAudioElement の経路を通す。
      // 同期の計器が測るのは AudioContext の予約までであり、その後のデバイス遅延ではない。
      let destination = context.createMediaStreamDestination();
      gain.connect(destination);
      const element = document.createElement("audio");
      element.srcObject = destination.stream;
      document.body.append(element);
      await element.play();
      const timing = new AudioPlayoutTimingStats(10_000, performance.timeOrigin);
      const audio = new AudioPlayoutSession({ timing });
      const timeline = new PlayoutTimeline({
        timeOriginMs: performance.timeOrigin,
        maxQueuedFrames: 24,
      });
      const canvas = document.createElement("canvas");
      canvas.width = 16;
      canvas.height = 16;
      document.body.append(canvas);
      const drawing = canvas.getContext("2d");
      if (drawing === null) throw new Error("Failed to create canvas context");
      const video = new VideoPlayoutSession({
        timeline,
        decodeInputs: new VideoDecodeInputs({ maxTracked: 24, forgetOnDuplicate: true }),
        pacing: { drainImmediately: false, framesPerDrain: 1 },
        output: {
          isAvailable: () => canvas.isConnected,
          present: (frame) => {
            drawing.drawImage(frame, 0, 0);
            frame.close();
            return true;
          },
        },
      });
      const skews: number[] = [];
      let played = 0;
      let outputClockSamples = 0;
      let stoppedExtraMs = -1;
      let restartedTargetMs = -1;
      let mediaTimeSeconds = 0;
      let recreatedContexts = 0;
      try {
        for (let phase = 0; phase < 2; phase++) {
          const startMs = performance.now();
          for (let index = 0; index < 100; index++) {
            // 20 ms の連続した音声を実時間で供給する。遅れたタイマーの分を TIMESTAMP で隠さない。
            const timestamp = Math.round((performance.timeOrigin + startMs + index * 20) * 1_000);
            const samples = new Float32Array(960);
            for (let frame = 0; frame < samples.length; frame++) {
              samples[frame] = Math.sin(((index * 960 + frame) * 2 * Math.PI * 440) / 48_000) * 0.2;
            }
            const data = new AudioData({
              format: "f32",
              sampleRate: 48_000,
              numberOfFrames: 960,
              numberOfChannels: 1,
              timestamp,
              data: samples,
            });
            try {
              const decision = audio.handleDecodedAudio({
                data,
                timestampKind: "wallClock",
                timeline,
                useTimeline: true,
                enforceTarget: true,
                output: { context, destination: gain },
              });
              if (decision.status === "error") throw decision.error;
              if (decision.status === "played") played++;
              if (!audio.clock.usingFallback) outputClockSamples++;
            } finally {
              data.close();
            }
            video.handleDecodedFrame({
              frame: new VideoFrame(canvas, { timestamp }),
              timestampKind: "wallClock",
              useTimeline: true,
            });
            if (index > 25) {
              const skew = timeline.skewMs();
              if (skew !== null) skews.push(Math.abs(skew));
            }
            await new Promise((resolve) => {
              setTimeout(resolve, Math.max(0, startMs + (index + 1) * 20 - performance.now()));
            });
          }
          await audio.drainReserved();
          timeline.resetStream("audio");
          audio.reset();
          stoppedExtraMs = timeline.delayBreakdown.video.syncExtraDelayMs;
          restartedTargetMs = timeline.audioDelayFeedbackStats().targetMs;
          mediaTimeSeconds += element.currentTime;
          if (phase === 0) {
            // 実際のトグルと同じく Context を閉じ、別の時計原点で作り直す。
            // 停止中も映像を進め、古い音声の補償が戻らないことを確かめる。
            element.pause();
            element.srcObject = null;
            for (const track of destination.stream.getTracks()) track.stop();
            await context.close();
            for (let index = 0; index < 5; index++) {
              video.handleDecodedFrame({
                frame: new VideoFrame(canvas, {
                  timestamp: Math.round((performance.timeOrigin + performance.now()) * 1_000),
                }),
                timestampKind: "wallClock",
                useTimeline: true,
              });
              await new Promise<void>((resolve) => {
                setTimeout(resolve, 20);
              });
            }
            context = new AudioContext({ sampleRate: 48_000, latencyHint: "interactive" });
            await context.resume();
            gain = context.createGain();
            gain.gain.value = 0;
            destination = context.createMediaStreamDestination();
            gain.connect(destination);
            element.srcObject = destination.stream;
            await element.play();
            audio.reset();
            recreatedContexts++;
          }
        }
        skews.sort((left, right) => left - right);
        return {
          played,
          outputClockSamples,
          samples: skews.length,
          p95SkewMs: skews[Math.floor(skews.length * 0.95)],
          stoppedExtraMs,
          restartedTargetMs,
          mediaTimeSeconds,
          recreatedContexts,
        };
      } finally {
        video.clear();
        element.pause();
        element.srcObject = null;
        for (const track of destination.stream.getTracks()) track.stop();
        if (context.state !== "closed") await context.close();
      }
    },
    new URL(`/@fs${resolve("src/index.ts")}`, RELAY_PAGE_URL).href,
  );
  expect(result.played).toBe(200);
  expect(result.outputClockSamples).toBeGreaterThan(100);
  expect(result.samples).toBeGreaterThan(100);
  expect(result.mediaTimeSeconds).toBeGreaterThan(3);
  expect(result.recreatedContexts).toBe(1);
  // 5 ms の同期不感帯に、表示周期と出力時計の推定の揺れの余裕を足す。
  expect(result.p95SkewMs).toBeLessThanOrEqual(50);
  expect(result.stoppedExtraMs).toBe(0);
  expect(result.restartedTargetMs).toBe(50);
});
