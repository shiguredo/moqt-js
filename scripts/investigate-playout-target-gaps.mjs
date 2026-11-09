/** 音声が欠落しない条件で、映像の到着変動が音声の補間へ伝わる経路を実クラスで調べる。 */
import assert from "node:assert/strict";
import { createServer } from "vite-plus";

/** 実行環境の配置は保存せず、調査するソースモジュールを環境変数で指定する。 */
function moduleId(variable) {
  const value = process.env[variable];
  if (!value) throw new Error(`Missing module configuration: ${variable}`);
  return value;
}
const modules = {
  timeline: moduleId("PLAYOUT_TIMELINE_MODULE"),
  scheduler: moduleId("AUDIO_PLAYOUT_MODULE"),
  queue: moduleId("AUDIO_RENDER_QUEUE_MODULE"),
  concealer: moduleId("AUDIO_RENDER_CONCEALER_MODULE"),
};

const timeout = setTimeout(() => {
  process.stderr.write("Playout investigation exceeded 10 seconds\n");
  process.exit(1);
}, 10_000);
const server = await createServer({
  root: process.cwd(),
  configFile: false,
  server: { middlewareMode: true, watch: null, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
});

try {
  const { PlayoutTimeline } = await server.ssrLoadModule(modules.timeline);
  const { AudioPlayoutScheduler } = await server.ssrLoadModule(modules.scheduler);
  const { AudioRenderQueue, audioRenderFrameAtOrAfter } = await server.ssrLoadModule(modules.queue);
  const { AudioRenderConcealer } = await server.ssrLoadModule(modules.concealer);

  const investigate = (varyVideoArrival) => {
    const timeline = new PlayoutTimeline({ timeOriginMs: 0, maxQueuedFrames: 24 });
    const scheduler = new AudioPlayoutScheduler({ minLeadSeconds: 0.003 });
    const queue = new AudioRenderQueue(48_000);
    const concealer = new AudioRenderConcealer(48_000);
    const events = [];
    // 音声は 20 ms、映像は 40 ms 間隔。音声の timestamp と到着間隔は全期間で一定にする。
    for (let index = 0; index < 150; index++) {
      const timestamp = index * 20;
      events.push({ stream: "audio", timestamp, arrival: timestamp + 20 });
      if (index % 2 === 0) {
        const additionalDelay = varyVideoArrival ? Math.min(100, Math.max(0, index - 60) * 2) : 0;
        events.push({ stream: "video", timestamp, arrival: timestamp + 20 + additionalDelay });
      }
    }
    events.sort((left, right) => left.arrival - right.arrival);
    const gaps = [];
    let endSeconds = 0;
    let state = 731;
    let filtered = 0;
    const nextSample = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      filtered = filtered * 0.6 + (state / 0xffffffff - 0.5) * 0.1;
      return filtered;
    };
    for (const event of events) {
      timeline.observe(event.stream, event.arrival, event.timestamp * 1_000);
      if (event.stream === "video") continue;
      timeline.observeAudioOutputLead(3, event.arrival);
      const targetMs = timeline.presentationPerformanceMs("audio", event.timestamp * 1_000);
      const decision = scheduler.schedule(event.arrival / 1_000, event.timestamp * 1_000, 0.02, {
        targetStartSeconds: targetMs === null ? null : targetMs / 1_000,
        arrivalSeconds: event.arrival / 1_000,
        enforceTarget: true,
        delaySeconds: (timeline.playoutDelayMs ?? 50) / 1_000,
        arrivalDelaySeconds: 0.05,
        presentationDelaySeconds: (timeline.presentationExtraDelayMs ?? 50) / 1_000,
      });
      assert.equal(decision.kind, "play");
      assert.equal(decision.compressSeconds, 0);
      assert.equal(decision.expandSeconds, 0);
      if (decision.totalGapSeconds > 1e-7) {
        gaps.push({
          timestampMs: event.timestamp,
          targetMs,
          gapMs: decision.totalGapSeconds * 1_000,
          audio: timeline.delayBreakdown.audio,
          video: timeline.delayBreakdown.video,
        });
      }
      // 非周期の連続 PCM を使う。ネットワークやブラウザー API の代用品は作らない。
      const channels = [Float32Array.from({ length: 960 }, nextSample)];
      queue.enqueue({ start: decision.startAt * 48_000, sampleRate: 48_000, channels });
      endSeconds = decision.startAt + 0.02;
      concealer.control({
        type: "range",
        start: audioRenderFrameAtOrAfter(decision.startAt * 48_000),
        end: audioRenderFrameAtOrAfter(endSeconds * 48_000),
      });
      scheduler.commit(decision, { startAt: decision.startAt, playedSeconds: 0.02 });
    }
    const endFrame = audioRenderFrameAtOrAfter(endSeconds * 48_000);
    concealer.control({ type: "stop", frame: endFrame });
    const input = [new Float32Array(128)];
    const output = [new Float32Array(128)];
    // 全 PCM を描画前に投入する。配送の遅れを排除し、予約の隙間だけの影響を確認する。
    // ブラウザーの実時間動作や出力実績のフィードバックは、この検証には含めない。
    for (let frame = 0; frame < endFrame; frame += 128) {
      queue.process(input, frame);
      concealer.process(input, output, frame);
    }
    return {
      gapCount: gaps.length,
      scheduledGapMs: gaps.reduce((total, gap) => total + gap.gapMs, 0),
      concealments: concealer.concealments,
      concealedMs: concealer.concealedFrames / 48,
      uncoveredMs: concealer.uncoveredFrames / 48,
      drops: scheduler.drops,
      firstGap: gaps[0] ?? null,
      lastGap: gaps.at(-1) ?? null,
    };
  };

  const steady = investigate(false);
  const delayedVideo = investigate(true);
  assert.equal(steady.gapCount, 0);
  assert.equal(steady.concealedMs, 0);
  assert.equal(delayedVideo.gapCount, 13);
  assert.equal(delayedVideo.concealments, 13);
  assert.equal(delayedVideo.concealedMs, 50);
  assert.equal(delayedVideo.uncoveredMs, 0);
  assert.equal(delayedVideo.drops, 0);
  process.stdout.write(`${JSON.stringify({ steady, delayedVideo }, null, 2)}\n`);
} finally {
  await server.close();
  clearTimeout(timeout);
}
