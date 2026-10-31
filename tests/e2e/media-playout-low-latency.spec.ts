/// <reference types="node" />
/** 実出力の予約と実 canvas の表示を照合し、停滞後の遅延回復を検証する。 */
import { test } from "@playwright/test";
import assert from "node:assert/strict";
import { evaluatePlayout, openPlayoutPage } from "./playoutTestPage";

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

test("A/V の到着が 180 ms 停滞しても、回復後に待ちを保持せず 100 ms 未満へ戻る", async ({
  page,
}) => {
  await openPlayoutPage(page);
  const result = await evaluatePlayout(page, async ({ moduleUrl, harnessUrl }) => {
    const { createMediaPlayout } = await import(moduleUrl);
    const harness = await import(harnessUrl);
    const output = await harness.createSilentAudioOutput({ latencyHint: "interactive" });
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    document.body.append(canvas);
    const drawing = canvas.getContext("2d");
    if (drawing === null) throw new Error("Canvas output is unavailable");
    const audio = new Map<number, number>();
    const video: { timestamp: number; atMs: number }[] = [];
    const ages: number[] = [];
    let played = 0;
    let dropped = 0;
    const playout = createMediaPlayout({
      audio: { context: output.context, destination: output.destination },
      video: {
        pacing: { drainImmediately: false, framesPerDrain: 1 },
        output: {
          isAvailable: () => canvas.isConnected,
          present: (frame: VideoFrame) => {
            drawing.drawImage(frame, 0, 0);
            video.push({ timestamp: frame.timestamp, atMs: performance.now() });
            frame.close();
            return true;
          },
        },
      },
    });
    await playout.prepareAudio();
    try {
      await harness.waitFor(
        () => output.context.getOutputTimestamp().performanceTime > 0,
        2000,
        "出力時計の準備",
      );
      const originMs = performance.now() + 50;
      const epoch = Math.round((performance.timeOrigin + originMs) * 1000);
      for (let index = 0; index < 350; index++) {
        const mediaMs = index * 20;
        const dueMs =
          originMs + Math.max(mediaMs, mediaMs >= 2500 && mediaMs < 2680 ? 2680 : 0) + 20;
        const remaining = dueMs - performance.now();
        if (remaining > 0)
          await new Promise<void>((resolve) => {
            setTimeout(resolve, remaining);
          });
        const timestamp = epoch + index * 20000;
        const samples = Float32Array.from(
          { length: 960 },
          (_, frame) => 0.3 * Math.sin((2 * Math.PI * 170 * (index * 960 + frame)) / 48000),
        );
        const data = harness.createAudioData(timestamp, { data: samples });
        playout.trackAudioDecodeInput(timestamp, {
          timestampKind: "wallClock",
          inputLagMs: performance.now() - originMs - mediaMs,
        });
        const status = playout.pushAudio(data);
        data.close();
        if (status.status === "error") throw status.error;
        if (status.status === "played") {
          played++;
          const startMs = playout.getStats().audio?.timing.lastStartMs;
          if (startMs !== null && startMs !== undefined) {
            audio.set(timestamp, startMs);
            if (mediaMs >= 5000) ages.push(startMs - originMs - mediaMs);
          }
        }
        if (status.status === "dropped") dropped++;
        if (index % 2 === 0) {
          playout.trackVideoDecodeInput(timestamp, {
            timestampKind: "wallClock",
            location: { group: BigInt(index), object: 0n },
          });
          playout.pushVideo(new VideoFrame(canvas, { timestamp }));
        }
      }
      await playout.drainAudio();
      const skews = video
        .filter((row) => row.timestamp - epoch >= 5000000)
        .flatMap((row) => {
          const matching = audio.get(row.timestamp);
          return matching === undefined ? [] : [Math.abs(row.atMs - matching)];
        });
      const summary = (values: number[]) => {
        values.sort((left, right) => left - right);
        return {
          samples: values.length,
          p95: values[Math.floor(values.length * 0.95)] ?? Infinity,
        };
      };
      return {
        played,
        dropped,
        ages: summary(ages),
        videoAges: summary(
          video
            .filter((row) => row.timestamp - epoch >= 5000000)
            .map((row) => row.atMs - originMs - (row.timestamp - epoch) / 1000),
        ),
        skews: summary(skews),
        videoFrames: video.length,
      };
    } finally {
      playout.clearAll();
      canvas.remove();
      await harness.closeSilentAudioOutput(output);
    }
  });
  assert.equal(result.played, 350, "音声を捨てて低遅延に見せないこと");
  assert.equal(result.dropped, 0);
  assert.ok(result.videoFrames > 150, "映像も実際に表示すること");
  assert.ok(
    result.ages.samples >= 100 && result.ages.p95 < 100,
    `停滞後に通常の予算へ戻ること: ${JSON.stringify(result)}`,
  );
  assert.ok(
    result.skews.samples >= 40 && result.skews.p95 < 30,
    `同じ媒体時刻の実表示と音声予約が揃うこと: ${JSON.stringify(result)}`,
  );
  assert.ok(
    result.videoAges.samples >= 40 && result.videoAges.p95 < 100,
    `映像の表示遅延も 100 ms 未満へ戻ること: ${JSON.stringify(result)}`,
  );
});
