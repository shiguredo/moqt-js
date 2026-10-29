/// <reference types="node" />
/** 映像の購読解除でも、既に予約した実音声と到着基準の音声を重ねない。 */
import { test } from "@playwright/test";
import assert from "node:assert/strict";
import { evaluatePlayout, openPlayoutPage } from "./playoutTestPage";

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

test("映像との同期から音声だけへ移っても予約順序と出力振幅を保つ", async ({ page }, testInfo) => {
  await openPlayoutPage(page);
  const result = await evaluatePlayout(page, async ({ moduleUrl, harnessUrl }) => {
    const { createMediaPlayout } = await import(moduleUrl);
    const harness = await import(harnessUrl);
    const output = await harness.createSilentAudioOutput();
    const video = harness.createCanvasVideoOutput();
    const chunks: Float32Array[] = [];
    const url = URL.createObjectURL(
      new Blob(
        [
          `class Capture extends AudioWorkletProcessor {
            process(inputs) {
              this.port.postMessage(inputs[0]?.[0]?.slice() ?? new Float32Array(128));
              return true;
            }
          } registerProcessor("transition-capture", Capture);`,
        ],
        { type: "text/javascript" },
      ),
    );
    await output.context.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const tap = new AudioWorkletNode(output.context, "transition-capture");
    tap.port.onmessage = (event: MessageEvent<Float32Array>) => chunks.push(event.data);
    tap.connect(output.destination);
    // 実際の購読の有無を公開コールバックへ渡し、途中で映像だけを解除する。
    let counterpartPresent = true;
    const playout = createMediaPlayout({
      targetLatencyMs: 100,
      audio: {
        context: output.context,
        destination: tap,
        hasCounterpart: () => counterpartPresent,
      },
      video: { output: video.output },
    });
    const starts: number[] = [];
    const durations: number[] = [];
    const statuses: string[] = [];
    let playedMs = 0;
    try {
      await harness.waitFor(
        () => output.context.getOutputTimestamp().performanceTime > 0,
        2000,
        "出力時計の準備",
      );
      await output.context.suspend();
      const epoch = Math.round((performance.timeOrigin + performance.now()) * 1000);
      for (let index = 0; index < 6; index++) {
        counterpartPresent = index === 0;
        const timestamp = epoch + index * 20000;
        if (index === 0) {
          playout.trackVideoDecodeInput(timestamp, { timestampKind: "wallClock" });
          playout.pushVideo(new VideoFrame(video.canvas, { timestamp }));
        }
        const data = harness.createAudioData(timestamp, { fill: 0.3 });
        playout.trackAudioDecodeInput(timestamp, { timestampKind: "wallClock" });
        statuses.push(playout.pushAudio(data).status);
        data.close();
        const timing = playout.getStats().audio.timing;
        starts.push(timing.lastStartMs);
        durations.push(timing.playedMs - playedMs);
        playedMs = timing.playedMs;
      }
      await output.context.resume();
      await playout.drainAudio();
      await harness.waitFor(
        () => chunks.some((chunk) => chunk.some((sample) => sample > 0.29)),
        2000,
        "音声の実出力",
      );
      let peak = 0;
      for (const chunk of chunks)
        for (const sample of chunk) peak = Math.max(peak, Math.abs(sample));
      return { statuses, starts, durations, peak };
    } finally {
      playout.clearAll();
      tap.port.close();
      tap.disconnect();
      await harness.closeSilentAudioOutput(output);
    }
  });
  await testInfo.attach("transition-metrics.json", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
  assert.ok(
    result.statuses.every((status) => status === "played"),
    "全入力を再生すること",
  );
  assert.ok(result.peak > 0.29 && result.peak < 0.301, `振幅を保つこと: ${JSON.stringify(result)}`);
  for (let index = 1; index < result.starts.length; index++) {
    const previous = result.starts[index - 1] ?? Infinity;
    assert.ok(
      (result.starts[index] ?? -Infinity) >=
        previous + (result.durations[index - 1] ?? Infinity) - 0.1,
      `前の音が終わってから次を鳴らすこと: ${JSON.stringify(result)}`,
    );
  }
});
