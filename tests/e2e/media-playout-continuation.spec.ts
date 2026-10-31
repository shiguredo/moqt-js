import { test } from "@playwright/test";
import assert from "node:assert/strict";
import { evaluatePlayout, openPlayoutPage } from "./playoutTestPage";

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

for (const sampleRate of [44100, 48000]) {
  for (const mainThreadStall of [false, true]) {
    test(`未着の間も補間し、実音への復帰と drain で余分な音を残さない ${sampleRate} Hz ${mainThreadStall ? "メインスレッド停止" : "到着の遅れ"}`, async ({
      page,
    }) => {
      await openPlayoutPage(page);
      const result = await evaluatePlayout(
        page,
        async ({ moduleUrl, sampleRate, mainThreadStall }) => {
          const { createMediaPlayout } = (await import(
            moduleUrl
          )) as typeof import("../../src/index");
          const context = new AudioContext({ sampleRate, latencyHint: "interactive" });
          const captured: Float32Array[] = [];
          let firstFrame: number | null = null;
          const url = URL.createObjectURL(
            new Blob(
              [
                `class Capture extends AudioWorkletProcessor {
        process(inputs) { this.port.postMessage({frame:currentFrame,samples:inputs[0][0]?.slice() ?? new Float32Array(128)}); return true; }
      } registerProcessor('continuation-capture',Capture);`,
              ],
              { type: "text/javascript" },
            ),
          );
          let playout: ReturnType<typeof createMediaPlayout> | undefined;
          const waitUntil = async (target: number): Promise<void> => {
            const deadline = performance.now() + 3000;
            while (context.currentTime < target) {
              if (performance.now() > deadline)
                throw new Error("音声の時計が停止したため、補間の試験を続けられません");
              await new Promise((resolve) => {
                setTimeout(resolve, 1);
              });
            }
          };
          try {
            await context.audioWorklet.addModule(url);
            const tap = new AudioWorkletNode(context, "continuation-capture");
            tap.port.onmessage = (
              event: MessageEvent<{ frame: number; samples: Float32Array }>,
            ) => {
              firstFrame ??= event.data.frame;
              captured.push(event.data.samples);
            };
            tap.connect(context.destination);
            playout = createMediaPlayout({ audio: { context, destination: tap } });
            await context.resume();
            await playout.prepareAudio();
            const push = (frame: number): void => {
              const samples = Float32Array.from(
                { length: 960 },
                (_, index) => 0.1 * Math.sin(((frame * 960 + index) * 2 * Math.PI * 200) / 48000),
              );
              const data = new AudioData({
                format: "f32",
                sampleRate: 48000,
                numberOfFrames: 960,
                numberOfChannels: 1,
                timestamp: frame * 20000,
                data: samples,
              });
              try {
                playout?.trackAudioDecodeInput(data.timestamp, { timestampKind: "mediaTime" });
                playout?.pushAudio(data);
              } finally {
                data.close();
              }
            };
            push(0);
            // 出力時計の実予約から終端を得る。currentTime に壁時計上の遅延を足すと、
            // デバイスの先行バッファ分を二重に足して試験する欠落長まで変えてしまう。
            const firstEnd = (
              playout as unknown as {
                audio: { session: { lastRenderEndSeconds: number } };
              }
            ).audio.session.lastRenderEndSeconds;
            // 次の到着を実出力の終わりより遅らせる。後から予約しても戻せない空白を作る。
            if (mainThreadStall) {
              await waitUntil(firstEnd - 0.01);
              // 実際にメインスレッドを止める。出力の処理がこのスレッドに依存しないことを検査する。
              const blockedUntil = performance.now() + 60;
              while (performance.now() < blockedUntil) {
                /* 音声の出力スレッドだけを進める。 */
              }
            } else await waitUntil(firstEnd + 0.025);
            push(1);
            const afterGap = playout.getStats().audio;
            const nextEnd = context.currentTime + 0.08;
            await playout.drainAudio();
            const drained = context.currentTime;
            await waitUntil(Math.max(nextEnd, drained + 0.12));
            await context.suspend();
            await new Promise((resolve) => {
              setTimeout(resolve, 20);
            });
            const samples = new Float32Array(captured.length * 128);
            captured.forEach((block, index) => samples.set(block, index * 128));
            // 収録の先頭は初期化を含むため、最初と最後の活動サンプル間だけを調べる。
            const first = samples.findIndex((value) => Math.abs(value) > 0.02);
            let last = samples.length - 1;
            while (last >= 0 && Math.abs(samples[last] ?? 0) <= 0.02) last--;
            let longest = 0;
            let run = 0;
            let peak = 0;
            for (let index = first; index <= last; index++) {
              const value = samples[index] ?? 0;
              peak = Math.max(peak, Math.abs(value));
              run = Math.abs(value) < 1e-7 ? run + 1 : 0;
              longest = Math.max(longest, run);
            }
            const afterDrain = samples.subarray(
              Math.ceil((drained + 0.03) * sampleRate - (firstFrame ?? 0)),
            );
            const tailRms = Math.sqrt(
              afterDrain.reduce((sum, value) => sum + value * value, 0) / afterDrain.length,
            );
            return {
              longestZeroMs: (longest / sampleRate) * 1000,
              peak,
              first,
              last,
              afterGap,
              drained,
              tailRms,
            };
          } finally {
            playout?.clearAll();
            await context.close();
            URL.revokeObjectURL(url);
          }
        },
        { sampleRate, mainThreadStall },
      );
      assert.ok(result.first >= 0 && result.last > result.first, "実際の音声を収録できること");
      assert.ok(
        result.longestZeroMs < 0.5,
        `未着中に長い無音を残さないこと: ${result.longestZeroMs} ms`,
      );
      assert.ok(result.peak < 0.13, "補間と実音を重ねて音量を増やさないこと");
      assert.ok(result.tailRms < 1e-7, "停止後に予測した続き音を残さないこと");
    });
  }
}

test("192 kHz の復号入力もネイティブの出力レートへ変換して再生する", async ({ page }) => {
  await openPlayoutPage(page);
  const result = await evaluatePlayout(page, async ({ moduleUrl, harnessUrl }) => {
    const { createMediaPlayout } = (await import(moduleUrl)) as typeof import("../../src/index");
    const harness = (await import(harnessUrl)) as typeof import("./playoutBrowserHarness");
    const output = await harness.createSilentAudioOutput();
    const playout = createMediaPlayout({
      audio: { context: output.context, destination: output.destination },
    });
    await playout.prepareAudio();
    const data = harness.createAudioData(0, {
      sampleRate: 192000,
      numberOfFrames: 3840,
      fill: 0.1,
    });
    try {
      const result = playout.pushAudio(data);
      await playout.drainAudio();
      return result.status;
    } finally {
      data.close();
      playout.clearAll();
      await harness.closeSilentAudioOutput(output);
    }
  });
  assert.equal(result, "played", "復号レートに依存せず、受信済みの実音を再生すること");
});
