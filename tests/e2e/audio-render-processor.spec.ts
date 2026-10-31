/** 出力側の補間は通常音を変えず、メインスレッドの停止中にも動くことを実 API で検証する。 */
import { test } from "@playwright/test";
import assert from "node:assert/strict";
import { evaluatePlayout, openPlayoutPage } from "./playoutTestPage";

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

for (const sampleRate of [44100, 48000]) {
  test(`出力側の補間は通常の PCM を変更せず、停止後の予測音を出さない ${sampleRate} Hz`, async ({
    page,
  }) => {
    await openPlayoutPage(page);
    const result = await evaluatePlayout(
      page,
      async ({ moduleUrl, sampleRate }) => {
        const context = new OfflineAudioContext(2, sampleRate * 10, sampleRate);
        await context.audioWorklet.addModule(
          new URL("./playout/audioRenderProcessor.ts", moduleUrl).href,
        );
        const start = Math.round(sampleRate * 0.1);
        const end = Math.round(sampleRate * 9.8);
        const node = new AudioWorkletNode(context, "moqt-audio-renderer", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: { ranges: [{ start, end }], stopFrame: end },
        });
        const merger = context.createChannelMerger(2);
        const source = context.createBufferSource();
        const buffer = context.createBuffer(1, 465600, 48000);
        buffer.copyToChannel(
          Float32Array.from(
            { length: 465600 },
            (_, i) => Math.sin((i * 2 * Math.PI * 173) / 48000) * 0.1,
          ),
          0,
        );
        source.buffer = buffer;
        source.connect(merger, 0, 0);
        source.connect(node);
        node.connect(merger, 0, 1);
        merger.connect(context.destination);
        source.start(start / sampleRate);
        source.stop(end / sampleRate);
        const rendered = await context.startRendering();
        const reference = rendered.getChannelData(0);
        const actual = rendered.getChannelData(1);
        let maximumError = 0;
        let tailPeak = 0;
        for (
          let i = start + Math.ceil(sampleRate * 0.005);
          i < end - Math.ceil(sampleRate * 0.005);
          i++
        )
          maximumError = Math.max(maximumError, Math.abs((reference[i] ?? 0) - (actual[i] ?? 0)));
        for (let i = end + 128; i < actual.length; i++)
          tailPeak = Math.max(tailPeak, Math.abs(actual[i] ?? 0));
        return { maximumError, tailPeak };
      },
      { sampleRate },
    );
    assert.equal(result.maximumError, 0, "正常区間の全 PCM サンプルが実入力と一致すること");
    assert.equal(result.tailPeak, 0, "停止後に予測音を残さないこと");
  });

  test(`出力側は 60 ms の実メインスレッド停止を補間する ${sampleRate} Hz`, async ({ page }) => {
    await openPlayoutPage(page);
    const result = await evaluatePlayout(
      page,
      async ({ moduleUrl, sampleRate }) => {
        const context = new AudioContext({ sampleRate, latencyHint: "interactive" });
        const blocks: { frame: number; samples: Float32Array }[] = [];
        const captureUrl = URL.createObjectURL(
          new Blob(
            [
              `class Capture extends AudioWorkletProcessor { process(inputs){this.port.postMessage({frame:currentFrame,samples:inputs[0][0]?.slice()??new Float32Array(128)});return true;} } registerProcessor('render-capture',Capture);`,
            ],
            { type: "text/javascript" },
          ),
        );
        try {
          await context.audioWorklet.addModule(
            new URL("./playout/audioRenderProcessor.ts", moduleUrl).href,
          );
          await context.audioWorklet.addModule(captureUrl);
          const errors: string[] = [];
          const renderer = new AudioWorkletNode(context, "moqt-audio-renderer");
          renderer.onprocessorerror = () => errors.push("processor error");
          const capture = new AudioWorkletNode(context, "render-capture");
          capture.port.onmessage = (event) => blocks.push(event.data);
          renderer.connect(capture);
          capture.connect(context.destination);
          await context.resume();
          const start = context.currentTime + 0.05;
          const push = (at: number, index: number): void => {
            const buffer = context.createBuffer(1, 960, 48000);
            buffer.copyToChannel(
              Float32Array.from(
                { length: 960 },
                (_, i) => Math.sin(((index * 960 + i) * 2 * Math.PI * 200) / 48000) * 0.1,
              ),
              0,
            );
            const source = context.createBufferSource();
            source.buffer = buffer;
            source.connect(renderer);
            renderer.port.postMessage({
              type: "range",
              start: Math.round(at * sampleRate),
              end: Math.round((at + 0.02) * sampleRate),
            });
            source.start(at);
            source.stop(at + 0.02);
            source.onended = () => source.disconnect();
          };
          for (let i = 0; i < 6; i++) push(start + i * 0.02, i);
          const wait = async (at: number): Promise<void> => {
            const deadline = performance.now() + 3000;
            while (context.currentTime < at) {
              if (performance.now() > deadline)
                throw new Error("音声の出力時計が停止したため試験を継続できません");
              await new Promise((resolve) => {
                setTimeout(resolve, 1);
              });
            }
          };
          await wait(start + 0.11);
          const blockedUntil = performance.now() + 60;
          while (performance.now() < blockedUntil) {
            /* メインスレッドだけを実際に停止する。 */
          }
          const resumed = context.currentTime + 0.01;
          for (let i = 0; i < 6; i++) push(resumed + i * 0.02, 6 + i);
          const end = resumed + 0.12;
          renderer.port.postMessage({ type: "stop", frame: Math.round(end * sampleRate) });
          await wait(end + 0.1);
          await context.suspend();
          await new Promise((resolve) => {
            setTimeout(resolve, 20);
          });
          let maximumZero = 0;
          let run = 0;
          let peak = 0;
          let tailPeak = 0;
          for (const block of blocks)
            for (let i = 0; i < block.samples.length; i++) {
              const frame = block.frame + i,
                value = block.samples[i] ?? 0;
              if (
                frame >= Math.ceil((start + 0.005) * sampleRate) &&
                frame < Math.floor((end - 0.005) * sampleRate)
              ) {
                run = Math.abs(value) < 1e-7 ? run + 1 : 0;
                maximumZero = Math.max(maximumZero, run);
                peak = Math.max(peak, Math.abs(value));
              }
              if (frame > Math.ceil((end + 0.03) * sampleRate))
                tailPeak = Math.max(tailPeak, Math.abs(value));
            }
          return {
            errors,
            maximumZeroMs: (maximumZero * 1000) / sampleRate,
            peak,
            tailPeak,
            blocks: blocks.length,
          };
        } finally {
          URL.revokeObjectURL(captureUrl);
          await context.close();
        }
      },
      { sampleRate },
    );
    assert.deepEqual(result.errors, [], "出力処理で例外がないこと");
    assert.ok(result.blocks > 100, "実出力を必要な長さだけ収録すること");
    assert.ok(result.maximumZeroMs < 0.5, `欠落を出力側で埋めること: ${result.maximumZeroMs}`);
    assert.ok(result.peak > 0.08 && result.peak < 0.13, "音量を重ねて増やさないこと");
    assert.equal(result.tailPeak, 0, "停止後に予測音を残さないこと");
  });
}

test("ステレオからモノラルへ変わっても、先行音声を相殺せず滑らかに接続する", async ({ page }) => {
  await openPlayoutPage(page);
  const result = await evaluatePlayout(page, async ({ moduleUrl }) => {
    const { AudioOutputRenderer } = await import(
      new URL("./playout/audioOutputRenderer.ts", moduleUrl).href
    );
    const context = new OfflineAudioContext(2, 24000, 48000);
    const notices: unknown[] = [];
    const renderer = new AudioOutputRenderer(
      { context, destination: context.destination },
      (statistics: unknown) => notices.push(statistics),
    );
    await renderer.prepare();
    for (const [start, channels] of [
      [0.1, 2],
      [0.2, 1],
    ] as const) {
      const buffer = context.createBuffer(channels, 4864, 48000);
      for (let channel = 0; channel < channels; channel++)
        buffer.getChannelData(channel).fill(channels === 1 ? 0.1 : channel === 0 ? 0.2 : -0.2);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(renderer.input);
      renderer.reserve(start, start + 0.1, channels, false);
      source.start(start);
      source.stop(start + 0.1);
    }
    renderer.stop(0.3);
    // Offline の描画は実時間より速いため、予約メッセージの受理を明示的に待つ。
    await renderer.prepare();
    const buffer = await context.startRendering();
    const left = buffer.getChannelData(0),
      right = buffer.getChannelData(1);
    let maximumStep = 0,
      monoError = 0,
      stereoMinimum = 1;
    for (let index = 5760; index < 8640; index++)
      stereoMinimum = Math.min(stereoMinimum, left[index] ?? 0, -(right[index] ?? 0));
    for (let index = 10560; index < 13440; index++)
      monoError = Math.max(
        monoError,
        Math.abs((left[index] ?? 0) - 0.1),
        Math.abs((right[index] ?? 0) - 0.1),
      );
    for (let index = 9400; index < 9900; index++)
      maximumStep = Math.max(
        maximumStep,
        Math.abs((left[index] ?? 0) - (left[index - 1] ?? 0)),
        Math.abs((right[index] ?? 0) - (right[index - 1] ?? 0)),
      );
    return { stereoMinimum, monoError, maximumStep, notices: notices.length };
  });
  assert.ok(
    result.stereoMinimum > 0.199,
    `モノラルの後続で先行する逆相ステレオを消さないこと: ${result.stereoMinimum}`,
  );
  assert.ok(
    result.monoError < 1e-6,
    `後続のモノラルを同じレベルで出力すること: ${JSON.stringify(result)}`,
  );
  assert.ok(result.maximumStep < 0.01, `チャンネル変更の境界を接続すること: ${result.maximumStep}`);
});
