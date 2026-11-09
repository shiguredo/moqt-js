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
        const { AudioOutputRenderer } = await import(
          new URL("./playout/audioOutputRenderer.ts", moduleUrl).href
        );
        const start = Math.round(sampleRate * 0.1);
        const end = Math.round(sampleRate * 9.8);
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
        const destination = context.createGain();
        destination.connect(merger, 0, 1);
        const renderer = new AudioOutputRenderer({ context, destination }, () => {});
        await renderer.prepare();
        renderer.enqueue(start / sampleRate, [buffer.getChannelData(0)], 48000, false);
        renderer.stop(end / sampleRate);
        await renderer.prepare();
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
          // ダウンサンプリングではブラウザーの線形補間を正解にせず、元の信号と比べる。
          maximumError = Math.max(
            maximumError,
            Math.abs(
              (sampleRate < 48000
                ? Math.sin(((i - start) * 2 * Math.PI * 173) / sampleRate) * 0.1
                : (reference[i] ?? 0)) - (actual[i] ?? 0),
            ),
          );
        for (let i = end + 128; i < actual.length; i++)
          tailPeak = Math.max(tailPeak, Math.abs(actual[i] ?? 0));
        return { maximumError, tailPeak };
      },
      { sampleRate },
    );
    assert.ok(result.maximumError < 1e-6, "正常区間の PCM が連続した実入力と一致すること");
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
          const { AudioOutputRenderer } = await import(
            new URL("./playout/audioOutputRenderer.ts", moduleUrl).href
          );
          await context.audioWorklet.addModule(captureUrl);
          const errors: string[] = [];
          const capture = new AudioWorkletNode(context, "render-capture");
          capture.port.onmessage = (event) => blocks.push(event.data);
          const renderer = new AudioOutputRenderer({ context, destination: capture }, () => {});
          await renderer.prepare();
          capture.connect(context.destination);
          await context.resume();
          const start = context.currentTime + 0.05;
          const push = (at: number, index: number): void => {
            const samples = Float32Array.from(
              { length: 960 },
              (_, i) => Math.sin(((index * 960 + i) * 2 * Math.PI * 200) / 48000) * 0.1,
            );
            renderer.enqueue(at, [samples], 48000, false);
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
          renderer.stop(end);
          await wait(end + 0.1);
          await context.suspend();
          await renderer.prepare().catch((error: unknown) => errors.push(String(error)));
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
      const samples = Array.from({ length: channels }, (_, channel) =>
        new Float32Array(4800).fill(channels === 1 ? 0.1 : channel === 0 ? 0.2 : -0.2),
      );
      renderer.enqueue(start, samples, 48000, false);
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

test("欠落補間中にステレオを先行予約しても、実出力の予測音を切らない", async ({ page }) => {
  await openPlayoutPage(page);
  // Firefox は OfflineAudioContext の途中停止を実装していない。実時計の試験でも検査する。
  test.skip(
    await page.evaluate(() => typeof OfflineAudioContext.prototype.suspend !== "function"),
    "OfflineAudioContext の途中停止が未対応",
  );
  const result = await evaluatePlayout(page, async ({ moduleUrl }) => {
    const { AudioOutputRenderer } = await import(
      new URL("./playout/audioOutputRenderer.ts", moduleUrl).href
    );
    const context = new OfflineAudioContext(2, 24000, 48000);
    const renderer = new AudioOutputRenderer(
      { context, destination: context.destination },
      () => {},
    );
    await renderer.prepare();
    renderer.enqueue(0.1, [new Float32Array(1440).fill(0.3)], 48000, false);
    await renderer.prepare();
    // 実際の描画を欠落補間の途中で止め、次の入力が届いたときに出力幅を変更する。
    // すべてを描画前に予約する試験では、この途中の状態消失を検出できない。
    const suspension = context.suspend(0.15);
    const rendering = context.startRendering();
    await suspension;
    renderer.enqueue(
      0.18,
      [new Float32Array(2400).fill(0.1), new Float32Array(2400).fill(-0.1)],
      48000,
      false,
    );
    renderer.stop(0.23);
    await renderer.prepare();
    await context.resume();
    const rendered = await rendering;
    let minimum = 1;
    let maximumStep = 0;
    for (const channel of [rendered.getChannelData(0), rendered.getChannelData(1)]) {
      for (let index = Math.round(0.14 * 48000); index < Math.round(0.17 * 48000); index++) {
        minimum = Math.min(minimum, channel[index] ?? 0);
        maximumStep = Math.max(
          maximumStep,
          Math.abs((channel[index] ?? 0) - (channel[index - 1] ?? 0)),
        );
      }
    }
    return {
      minimum,
      maximumStep,
      left: rendered.getChannelData(0)[9600],
      right: rendered.getChannelData(1)[9600],
    };
  });
  assert.ok(
    result.minimum > 0.22,
    `チャンネル拡張の前後も補間を続けること: ${JSON.stringify(result)}`,
  );
  assert.ok(result.maximumStep < 0.01, `拡張時にクリックを作らないこと: ${JSON.stringify(result)}`);
  assert.ok(
    (result.left ?? 0) > 0.099 && (result.right ?? 0) < -0.099,
    "後続のステレオも実際に出力すること",
  );
});

test("欠落中のチャンネル拡張を実時計で繰り返しても予測音を切らない", async ({ page }) => {
  await openPlayoutPage(page);
  const result = await evaluatePlayout(page, async ({ moduleUrl, harnessUrl }) => {
    const { AudioOutputRenderer } = await import(
      new URL("./playout/audioOutputRenderer.ts", moduleUrl).href
    );
    const { waitFor } = await import(harnessUrl);
    const context = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    const blocks: { frame: number; left: Float32Array; right: Float32Array }[] = [];
    const windows: { start: number; end: number }[] = [];
    const stereoWindows: { start: number; end: number }[] = [];
    const url = URL.createObjectURL(
      new Blob(
        [
          `class Capture extends AudioWorkletProcessor {
        process(inputs, outputs) {
          const left = inputs[0][0] ?? new Float32Array(outputs[0][0].length);
          this.port.postMessage({frame: currentFrame, left: left.slice(), right: (inputs[0][1] ?? left).slice()});
          return true;
        }
      } registerProcessor('channel-growth-capture', Capture);`,
        ],
        { type: "text/javascript" },
      ),
    );
    let renderer: InstanceType<typeof AudioOutputRenderer> | null = null;
    try {
      await context.audioWorklet.addModule(url);
      const capture = new AudioWorkletNode(context, "channel-growth-capture", {
        channelCount: 2,
        channelCountMode: "explicit",
      });
      capture.port.onmessage = (event: MessageEvent<(typeof blocks)[number]>) =>
        blocks.push(event.data);
      capture.connect(context.destination);
      await context.resume();
      for (let cycle = 0; cycle < 20; cycle++) {
        renderer = new AudioOutputRenderer({ context, destination: capture }, () => {});
        await renderer.prepare();
        const start = context.currentTime + 0.03;
        renderer.enqueue(start, [new Float32Array(1440).fill(0.3)], 48000, false);
        await waitFor(() => context.currentTime >= start + 0.036, 2000, "欠落補間の開始");
        const growth = context.currentTime;
        const stereoStart = growth + 0.015;
        windows.push({
          start: Math.ceil(growth * 48000) - 128,
          end: Math.floor((stereoStart - 0.002) * 48000),
        });
        stereoWindows.push({
          start: Math.ceil((stereoStart + 0.004) * 48000),
          end: Math.floor((stereoStart + 0.016) * 48000),
        });
        renderer.enqueue(
          stereoStart,
          [new Float32Array(960).fill(0.1), new Float32Array(960).fill(-0.1)],
          48000,
          false,
        );
        renderer.stop(stereoStart + 0.02);
        await waitFor(
          () => context.currentTime >= stereoStart + 0.028,
          2000,
          "予約したステレオの描画完了",
        );
        renderer.dispose(context.currentTime);
        renderer = null;
      }
      const captureUntil = Math.ceil(context.currentTime * 48000);
      await waitFor(
        () => (blocks.at(-1)?.frame ?? 0) + 128 >= captureUntil,
        2000,
        "全チャンネル拡張の収録完了",
      );
      await context.suspend();
      const samplesPerWindow = windows.map(() => 0);
      const stereoSamplesPerWindow = stereoWindows.map(() => 0);
      let maximumStep = 0,
        minimum = 1;
      let stereoError = 0;
      let previousLeft = 0,
        previousRight = 0;
      for (const block of blocks)
        for (let index = 0; index < block.left.length; index++) {
          const left = block.left[index] ?? 0,
            right = block.right[index] ?? 0;
          const frame = block.frame + index;
          const window = windows.findIndex(
            (candidate) => frame >= candidate.start && frame < candidate.end,
          );
          if (window !== -1) {
            samplesPerWindow[window] = (samplesPerWindow[window] ?? 0) + 1;
            minimum = Math.min(minimum, left, right);
            maximumStep = Math.max(
              maximumStep,
              Math.abs(left - previousLeft),
              Math.abs(right - previousRight),
            );
          }
          const stereoWindow = stereoWindows.findIndex(
            (candidate) => frame >= candidate.start && frame < candidate.end,
          );
          if (stereoWindow !== -1) {
            stereoSamplesPerWindow[stereoWindow] = (stereoSamplesPerWindow[stereoWindow] ?? 0) + 1;
            stereoError = Math.max(stereoError, Math.abs(left - 0.1), Math.abs(right + 0.1));
          }
          previousLeft = left;
          previousRight = right;
        }
      return { minimum, maximumStep, samplesPerWindow, stereoError, stereoSamplesPerWindow };
    } finally {
      renderer?.dispose(context.currentTime);
      URL.revokeObjectURL(url);
      await context.close();
    }
  });
  assert.ok(
    result.minimum > 0.22,
    `実時間のチャンネル変更でも無音化しないこと: ${JSON.stringify(result)}`,
  );
  assert.ok(
    result.maximumStep < 0.005,
    `実時間のチャンネル変更でも段差を作らないこと: ${JSON.stringify(result)}`,
  );
  assert.ok(
    result.samplesPerWindow.length === 20 && result.samplesPerWindow.every((count) => count > 200),
    "全 20 回の拡張を実際に収録すること",
  );
  assert.ok(result.stereoError < 1e-6, `左右を独立して出力すること: ${result.stereoError}`);
  assert.ok(
    result.stereoSamplesPerWindow.length === 20 &&
      result.stereoSamplesPerWindow.every((count) => count > 200),
    "全 20 回の後続ステレオも実際に収録すること",
  );
});
