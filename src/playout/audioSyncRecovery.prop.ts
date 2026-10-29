import { assert, test } from "vite-plus/test";
import * as fc from "fast-check";
import { AudioPlayoutScheduler, arrivalPlayoutDelaySeconds } from "./audioPlayout";
import { AudioReceiveCatchUp } from "./audioReceiveCatchUp";
import { AudioPlayoutTimingStats } from "./audioPlayoutTimingStats";
import { compressSamples } from "./audioTimeStretch";
import { PlayoutTimeline } from "./timeline";

// 実 PCM と各制御クラスを Session と同じ順で結ぶ。圧縮要求が成功したことにはせず、
// 波形処理が実際に削った長さだけを返す。ネットワークだけの停滞は decoder の再作成で
// 救済されないため、正常入力へ戻った後に再生の予約そのものが追いつく必要がある。
test("44.1 kHz でも通信停滞後に音声と映像が通常の遅延へ戻る", () => {
  fc.assert(
    fc.property(fc.integer({ min: 10, max: 50 }), (burstFrames) => {
      const timeline = new PlayoutTimeline({ timeOriginMs: 0, maxQueuedFrames: 24 });
      const scheduler = new AudioPlayoutScheduler();
      const timing = new AudioPlayoutTimingStats(1_000, 0);
      const catchUp = new AudioReceiveCatchUp();
      const sampleRate = 44_100;
      let lastAudioLagMs = 0;
      let dropped = 0;
      const feed = (atMs: number, mediaMs: number): void => {
        timeline.observe("video", atMs, (atMs - 20) * 1_000);
        timeline.observe("audio", atMs, mediaMs * 1_000);
        catchUp.observe({
          nowMs: atMs,
          lagMs: atMs - mediaMs,
          inputLagMs: atMs - mediaMs,
          durationMs: 20,
          timestampMicros: mediaMs * 1_000,
        });
        timeline.observeAudioOutputLead(10, atMs);
        const targetMs = timeline.presentationPerformanceMs("audio", mediaMs * 1_000);
        const delaySeconds = (timeline.playoutDelayMs ?? 50) / 1_000;
        const decision = scheduler.schedule(atMs / 1_000, mediaMs * 1_000, 0.02, {
          targetStartSeconds: targetMs === null ? null : targetMs / 1_000,
          enforceTarget: true,
          stretchMinSeconds: timeline.compressionDeadbandSeconds(0.02),
          arrivalSeconds: atMs / 1_000,
          delaySeconds,
          arrivalDelaySeconds: arrivalPlayoutDelaySeconds(delaySeconds),
          presentationDelaySeconds: (timeline.presentationExtraDelayMs ?? 50) / 1_000,
        });
        if (decision.kind === "drop") {
          dropped++;
          return;
        }
        const samples = Float32Array.from(
          { length: 882 },
          (_, index) => 0.3 * Math.sin(2 * Math.PI * 200 * (mediaMs / 1_000 + index / sampleRate)),
        );
        const compressed = compressSamples(
          [samples],
          sampleRate,
          Math.round(decision.compressSeconds * sampleRate),
        );
        scheduler.confirmStretch(-compressed.lengthChangeSamples / sampleRate);
        scheduler.confirmConcealment(0);
        const startMs = decision.startAt * 1_000;
        timing.recordPlay(
          atMs,
          targetMs,
          startMs,
          20 + (compressed.lengthChangeSamples * 1_000) / sampleRate,
          decision.basis,
        );
        if (targetMs !== null)
          timeline.recordPresentation(
            "audio",
            mediaMs * 1_000,
            BigInt(Math.round(startMs * 1_000)),
            BigInt(Math.round(targetMs * 1_000)),
          );
        lastAudioLagMs = startMs - mediaMs;
      };
      for (let atMs = 1_000; atMs < 3_000; atMs += 20) feed(atMs, atMs - 20);
      const resumedAtMs = 3_000 + burstFrames * 20;
      for (let index = 0; index <= burstFrames; index++) feed(resumedAtMs, 2_980 + index * 20);
      // 既存の減衰速度 20 ms/秒も通し、レビューで不収束だった 60 秒後を比較する。
      for (let elapsed = 20; elapsed <= 10_000; elapsed += 20)
        feed(resumedAtMs + elapsed, resumedAtMs + elapsed - 20);
      assert.equal(dropped, 0, "音声を破棄して追いついたことにしないこと");
      assert.equal(
        catchUp.snapshot().catchUpStarts,
        0,
        "ネットワークの停滞で decoder を作り直さないこと",
      );
      assert.isAbove(scheduler.compressed, 0, "実際に音声を時間圧縮したこと");
      assert.isBelow(lastAudioLagMs, 100, "正常復帰後は通常の深さへ戻ること");
      assert.isBelow(
        Math.abs(lastAudioLagMs - (timeline.delayBreakdown.video.presentationDelayMs ?? 0)),
        30,
        "既存予約の遅れを解消し、映像と揃うこと",
      );
    }),
    { numRuns: 8 },
  );
});
