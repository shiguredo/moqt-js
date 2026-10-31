/// <reference types="node" />
/** 実 Web Audio のリサンプリング後も、連続した音の境界で振幅を重ねない。 */
import { test } from "@playwright/test";
import assert from "node:assert/strict";
import { evaluatePlayout, openPlayoutPage } from "./playoutTestPage";

for (const [contextRate, decodedRate] of [
  [48000, 48000],
  [44100, 48000],
  [48000, 16000],
  [44100, 16000],
  [48000, 44100],
] as const) {
  for (const irregular of [false, true]) {
    test(`${decodedRate} Hz の連続音を ${contextRate} Hz で重ねずに鳴らす: 可変長 ${irregular}`, async ({
      page,
    }, testInfo) => {
      await openPlayoutPage(page);
      const result = await evaluatePlayout(
        page,
        async ({ moduleUrl, contextRate, decodedRate, irregular }) => {
          const { AudioPlayoutSession } = await import(
            new URL("./playout/audioPlayoutSession.ts", moduleUrl).href
          );
          const { AudioPlayoutTimingStats } = await import(
            new URL("./playout/audioPlayoutTimingStats.ts", moduleUrl).href
          );
          const results = [];
          for (const fractionalStart of [0, 0.1, 0.5, 0.9]) {
            const context = new OfflineAudioContext(1, contextRate * 3, contextRate);
            // 時計の推定とネットワークの揺らぎを分離し、本番のバッファ予約と envelope を
            // 実 OfflineAudioContext で駆動する。音声 API の代用品は使わない。
            const session = new AudioPlayoutSession({
              timing: new AudioPlayoutTimingStats(10000, performance.timeOrigin),
            }) as unknown as {
              playSound(
                output: { context: OfflineAudioContext; destination: AudioNode },
                decision: Extract<
                  import("../../src/playout/audioPlayout").AudioPlayoutDecision,
                  { kind: "play" }
                >,
                data: AudioData,
                channels: number,
                rate: number,
                frames: number,
              ): { playedSeconds: number; startAtSeconds: number };
            };
            const firstStart = 0.12 + fractionalStart / contextRate;
            let startAt = firstStart;
            let timestamp = 0;
            for (let index = 0; index < 100; index++) {
              // DC は元波形に変化がないため、境界の重なりと穴を直接検出できる。
              // 可変長は時間圧縮後と同様に、次の開始が出力のサンプル格子から外れる条件。
              const frames = decodedRate / 50 - (irregular ? (index % 7) * 13 : 0);
              const data = new AudioData({
                format: "f32-planar",
                sampleRate: decodedRate,
                numberOfChannels: 1,
                numberOfFrames: frames,
                timestamp: Math.round(timestamp),
                data: new Float32Array(frames).fill(0.25),
              });
              try {
                const played = session.playSound(
                  { context, destination: context.destination },
                  {
                    kind: "play",
                    startAt,
                    basis: "timestamp",
                    compressSeconds: 0,
                    gapStartSeconds: 0,
                    gapSeconds: 0,
                    totalGapSeconds: 0,
                    unrecoverableGapSeconds: 0,
                  },
                  data,
                  1,
                  decodedRate,
                  frames,
                );
                startAt = played.startAtSeconds + played.playedSeconds;
                timestamp += (frames / decodedRate) * 1000000;
              } finally {
                data.close();
              }
            }
            const buffer = await context.startRendering();
            // 開始と途絶の正当なフェードを除き、連続する 99 境界を含めて検査する。
            const samples = buffer
              .getChannelData(0)
              .slice(
                Math.ceil((firstStart + 0.01) * contextRate),
                Math.floor((startAt - 0.01) * contextRate),
              );
            results.push({
              fractionalStart,
              activeSamples: samples.length,
              minimum: Math.min(...samples),
              maximum: Math.max(...samples),
              anomalousSamples: samples.filter((sample) => Math.abs(sample - 0.25) > 0.001).length,
              endSeconds: startAt,
            });
          }
          return results;
        },
        { contextRate, decodedRate, irregular },
      );
      await testInfo.attach("resampling-waveform.json", {
        body: JSON.stringify(result, null, 2),
        contentType: "application/json",
      });
      for (const metrics of result) {
        assert.ok(metrics.activeSamples > contextRate * 1.5, "有効な音を 1.5 秒以上収録すること");
        assert.ok(metrics.minimum > 0.249, "境界に無音の穴を作らないこと");
        assert.ok(
          metrics.maximum < 0.251,
          `境界で振幅を加算しないこと: ${JSON.stringify(metrics)}`,
        );
        assert.equal(metrics.anomalousSamples, 0, "連続区間の振幅を保つこと");
      }
    });
  }
}
