/** 予約と描画を分離し、実 Worklet から返る媒体時刻だけを観測する。 */
import { test } from "@playwright/test";
import assert from "node:assert/strict";
import { evaluatePlayout, openPlayoutPage } from "./playoutTestPage";

test("音声の同期実績は AudioWorklet が実音を描画するまで通知されない", async ({ page }) => {
  await openPlayoutPage(page);
  const result = await evaluatePlayout(page, async ({ moduleUrl, harnessUrl }) => {
    const { AudioOutputRenderer } = await import(
      new URL("./playout/audioOutputRenderer.ts", moduleUrl).href
    );
    const { waitFor } = await import(harnessUrl);
    const context = new OfflineAudioContext(1, 24000, 48000);
    const presentations: {
      contextTimeSeconds: number;
      timestampMicroseconds: number;
      targetPerformanceMs: number;
    }[] = [];
    const renderer = new AudioOutputRenderer(
      { context, destination: context.destination },
      () => {},
      (sample: (typeof presentations)[number]) => presentations.push(sample),
    );
    await renderer.prepare();
    renderer.enqueue(0.1, [new Float32Array(960).fill(0.2)], 48000, false, {
      epoch: 0,
      timestampMicroseconds: 1000000,
      targetPerformanceMs: 80,
    });
    await renderer.prepare();
    const before = presentations.length;
    renderer.stop(0.12);
    const buffer = await context.startRendering();
    await waitFor(() => presentations.length > 0, 1000, "描画した媒体時刻の通知");
    return { before, presentations, peak: Math.max(...buffer.getChannelData(0)) };
  });
  assert.equal(result.before, 0);
  assert.equal(result.presentations.length, 1);
  assert.deepEqual(result.presentations[0], {
    contextTimeSeconds: 0.1,
    epoch: 0,
    timestampMicroseconds: 1000000,
    targetPerformanceMs: 80,
  });
  assert.ok(result.peak > 0.19, "通知だけでなく実音が出力されること");
});

for (const resetMethod of ["resetPlayout", "resetAudioTimeline"] as const) {
  test(`初期化前の音の通知で同期実績を復活させない ${resetMethod}`, async ({ page }) => {
    await openPlayoutPage(page);
    const result = await evaluatePlayout(
      page,
      async ({ moduleUrl, harnessUrl, resetMethod }) => {
        const { createMediaPlayout } = await import(moduleUrl);
        const { waitFor } = await import(harnessUrl);
        const context = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
        const playout = createMediaPlayout({
          audio: { context, destination: context.destination, minDelayMs: 100 },
        });
        const timeline = (playout as unknown as { timeline: { audioPresentation: unknown } })
          .timeline;
        try {
          await context.resume();
          await playout.prepareAudio();
          const timestamp = Math.round((performance.timeOrigin + performance.now()) * 1000);
          const data = new AudioData({
            format: "f32-planar",
            sampleRate: 48000,
            numberOfChannels: 1,
            numberOfFrames: 960,
            timestamp,
            data: new Float32Array(960).fill(0.2),
          });
          playout.trackAudioDecodeInput(timestamp, { timestampKind: "wallClock" });
          const status = playout.pushAudio(data).status;
          data.close();
          const until = context.currentTime + 0.25;
          playout[resetMethod]();
          // 実時計が予約位置を通り過ぎ、Worklet の通知も到着した後に確認する。
          await waitFor(() => context.currentTime > until, 2000, "予約音の描画と通知");
          return { status, presentation: timeline.audioPresentation };
        } finally {
          playout.clearAll();
          await context.close();
        }
      },
      { resetMethod },
    );
    assert.equal(result.status, "played");
    assert.equal(result.presentation, null);
  });
}
