/// <reference types="node" />
/** 短いバッファでも先頭のフェードを消さず、公開 API の実出力で接続を確かめる。 */
import { test } from "@playwright/test";
import assert from "node:assert/strict";
import { evaluatePlayout, openPlayoutPage } from "./playoutTestPage";

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

for (const frames of [120, 192, 240, 960]) {
  for (const scenario of ["initial", "reset", "conceal"] as const) {
    test(`${frames} サンプルの連続予約でも開始と接続を滑らかにする: ${scenario}`, async ({
      page,
    }, testInfo) => {
      await openPlayoutPage(page);
      const result = await evaluatePlayout(
        page,
        async ({ moduleUrl, harnessUrl, frames, scenario }) => {
          const { createMediaPlayout } = await import(moduleUrl);
          const { waitFor } = await import(harnessUrl);
          const context = new AudioContext({ sampleRate: 48000 });
          const chunks: Float32Array[] = [];
          const url = URL.createObjectURL(
            new Blob(
              [
                `class Capture extends AudioWorkletProcessor {
                  process(inputs) {
                    this.port.postMessage(inputs[0]?.[0]?.slice() ?? new Float32Array(128));
                    return true;
                  }
                } registerProcessor("short-frame-capture", Capture);`,
              ],
              { type: "text/javascript" },
            ),
          );
          await context.audioWorklet.addModule(url);
          URL.revokeObjectURL(url);
          const tap = new AudioWorkletNode(context, "short-frame-capture");
          tap.port.onmessage = (event: MessageEvent<Float32Array>) => chunks.push(event.data);
          const mute = context.createGain();
          mute.gain.value = 0;
          tap.connect(mute).connect(context.destination);
          const playout = createMediaPlayout({ audio: { context, destination: tap } });
          const statuses: string[] = [];
          const push = (timestamp: number, count: number, amplitude = 0.3) => {
            const data = new AudioData({
              format: "f32-planar",
              sampleRate: 48000,
              numberOfChannels: 1,
              numberOfFrames: count,
              timestamp,
              data: new Float32Array(count).fill(amplitude),
            });
            playout.trackAudioDecodeInput(timestamp, { timestampKind: "mediaTime" });
            statuses.push(playout.pushAudio(data).status);
            data.close();
          };
          try {
            await context.resume();
            await waitFor(
              () => (context.getOutputTimestamp().performanceTime ?? 0) > 0,
              2000,
              "出力時計の準備",
            );
            if (scenario === "reset") {
              push(0, frames, 0.1);
              await playout.drainAudio();
              // 再開前に旧予約の末尾まで収録し、同じ出力への重なりを検査に混ぜない。
              await waitFor(
                () =>
                  chunks.some((chunk) => chunk.some((sample) => sample > 0.001)) &&
                  chunks.length >= 3 &&
                  chunks.slice(-3).every((chunk) => chunk.every((sample) => sample === 0)),
                2000,
                "旧予約の出力完了",
              );
              playout.resetAudioPlayback();
            }
            // 2 件目を先行予約し、末尾を取り消す時点で先頭の ramp が残るかを検査する。
            await context.suspend();
            let timestamp = 0;
            if (scenario === "conceal") {
              // PLC の材料には 20 ms を渡し、その先の短い穴と実音も同じ出力で検査する。
              push(0, 960, 0.1);
              timestamp = 21000;
            }
            push(timestamp, frames);
            push(timestamp + (frames / 48000) * 1000000, frames);
            await context.resume();
            await playout.drainAudio();
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 50);
            });
            let previous = 0;
            let maximumStep = 0;
            let peak = 0;
            let targetActiveSamples = 0;
            for (const chunk of chunks) {
              for (const sample of chunk) {
                maximumStep = Math.max(maximumStep, Math.abs(sample - previous));
                peak = Math.max(peak, Math.abs(sample));
                // 準備音とその PLC は振幅 0.1 なので、検査対象の短い実音だけを数える。
                if (sample > 0.2) targetActiveSamples++;
                previous = sample;
              }
            }
            return { statuses, maximumStep, peak, targetActiveSamples };
          } finally {
            playout.clearAll();
            tap.disconnect();
            mute.disconnect();
            await context.close();
          }
        },
        { frames, scenario },
      );
      await testInfo.attach("waveform-metrics.json", {
        body: JSON.stringify(result),
        contentType: "application/json",
      });
      assert.ok(
        result.statuses.every((status) => status === "played"),
        "全入力を再生すること",
      );
      assert.ok(
        result.peak > 0.299 && result.targetActiveSamples >= frames,
        "無音化して成功させないこと",
      );
      assert.ok(result.maximumStep < 0.006, `先頭 ramp を保つこと: ${JSON.stringify(result)}`);
    });
  }
}
