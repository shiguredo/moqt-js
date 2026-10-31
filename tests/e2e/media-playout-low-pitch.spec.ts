/// <reference types="node" />
/** 過去の連続した音を使い、低い声の欠落を先読みなしで補間する。 */
import { test } from "@playwright/test";
import assert from "node:assert/strict";
import { evaluatePlayout, openPlayoutPage } from "./playoutTestPage";

for (const sampleRate of [44100, 48000]) {
  for (const frequency of [68, 80, 100, 170, 492]) {
    test(`${sampleRate} Hz / ${frequency} Hz の音の 20 ms 欠落を補間する`, async ({
      page,
    }, testInfo) => {
      await openPlayoutPage(page);
      const result = await evaluatePlayout(
        page,
        async ({ moduleUrl, sampleRate, frequency }) => {
          const { AudioPlayoutSession } = await import(
            new URL("./playout/audioPlayoutSession.ts", moduleUrl).href
          );
          const { AudioPlayoutTimingStats } = await import(
            new URL("./playout/audioPlayoutTimingStats.ts", moduleUrl).href
          );
          const context = new OfflineAudioContext(1, sampleRate, sampleRate);
          const session = new AudioPlayoutSession({
            timing: new AudioPlayoutTimingStats(10000, performance.timeOrigin),
          }) as unknown as {
            playout: import("../../src/playout/audioPlayout").AudioPlayoutScheduler;
            prepareOutput(output: {
              context: BaseAudioContext;
              destination: AudioNode;
            }): Promise<void>;
            copyChannels(data: AudioData): Float32Array[];
            playSound(
              output: { context: OfflineAudioContext; destination: AudioNode },
              decision: Extract<
                import("../../src/playout/audioPlayout").AudioPlayoutDecision,
                { kind: "play" }
              >,
              data: AudioData,
              channels: Float32Array[],
            ): { playedSeconds: number; startAtSeconds: number };
          };
          const frames = sampleRate / 50;
          const sampleAt = (position: number): number => {
            if (frequency === 492) {
              // この非定常音は 20 ms なら補間でき、30 ms の解析だけでは拒否される。
              // 長い履歴を追加しても、既に補間できていた音を無音へ戻さない。
              const time = position / sampleRate - 0.01;
              const phase = 2 * Math.PI * frequency * time;
              return (
                0.15 *
                (1 + 0.3 * Math.sin(2 * Math.PI * 25 * time)) *
                (Math.sin(phase) + 0.25 * Math.sin(phase * 2) + 0.1 * Math.sin(phase * 5))
              );
            }
            const phase = (2 * Math.PI * frequency * position) / sampleRate;
            // 倍音を含む有声音。基本周期より短い倍音を選ぶ補間も波形差で検出する。
            return 0.2 * Math.sin(phase) + 0.06 * Math.sin(phase * 2) + 0.03 * Math.sin(phase * 3);
          };
          await session.prepareOutput({ context, destination: context.destination });
          let lastStart = 0;
          for (const index of [0, 1, 3, 4]) {
            const samples = Float32Array.from({ length: frames }, (_, offset) =>
              sampleAt(index * frames + offset),
            );
            const timestamp = index * 20000;
            const data = new AudioData({
              format: "f32-planar",
              sampleRate,
              numberOfChannels: 1,
              numberOfFrames: frames,
              timestamp,
              data: samples,
            });
            try {
              const decision = session.playout.schedule(0, timestamp, 0.02, {
                targetStartSeconds: 0.12 + index * 0.02,
                enforceTarget: true,
                arrivalSeconds: 0,
                delaySeconds: 0.3,
                arrivalDelaySeconds: 0.05,
                presentationDelaySeconds: 0.05,
              });
              if (decision.kind !== "play") throw new Error("Audio was dropped before rendering");
              lastStart = session.playSound(
                { context, destination: context.destination },
                decision,
                data,
                session.copyChannels(data),
              ).startAtSeconds;
            } finally {
              data.close();
            }
          }
          await session.prepareOutput({ context, destination: context.destination });
          const buffer = await context.startRendering();
          const output = buffer.getChannelData(0);
          const gap = output.slice(Math.round(0.162 * sampleRate), Math.round(0.178 * sampleRate));
          let errorEnergy = 0;
          let referenceEnergy = 0;
          for (let index = 0; index < gap.length; index++) {
            const position = Math.round(0.162 * sampleRate) + index;
            const expected = sampleAt(position - 0.12 * sampleRate);
            errorEnergy += ((gap[index] ?? 0) - expected) ** 2;
            referenceEnergy += expected ** 2;
          }
          return {
            concealedMs: session.playout.concealed * 1000,
            silenceSamples: gap.filter((sample) => Math.abs(sample) < 1e-8).length,
            errorDb: 10 * Math.log10(errorEnergy / referenceEnergy),
            lastStart,
          };
        },
        { sampleRate, frequency },
      );
      await testInfo.attach("low-pitch-waveform.json", {
        body: JSON.stringify(result, null, 2),
        contentType: "application/json",
      });
      // 補間の成否は出力 PCM で判定する。出力スレッドからの統計通知は非同期である。
      assert.ok(result.silenceSamples < 4, "低い周期を解析できず無音へ落とさないこと");
      // 非定常音の内容の予測誤差を、定常の周期波と同じ基準で評価しない。
      if (frequency !== 492) {
        assert.ok(result.errorDb < -15, `補間が元の周期波に近いこと: ${result.errorDb} dB`);
      }
      assert.ok(Math.abs(result.lastStart - 0.2) < 1e-9, "補間のために後続の実音を遅らせないこと");
    });
  }
}
