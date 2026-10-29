/// <reference types="node" />
/** 実 AudioData と実 Web Audio で、圧縮と欠落が連続する場合の出力を検証する。 */
import { test } from "@playwright/test";
import assert from "node:assert/strict";
import { evaluatePlayout, openPlayoutPage } from "./playoutTestPage";

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

test("明示した 500 ms の A/V 目標は実 AudioContext の時計へ換算して予約する", async ({ page }) => {
  await openPlayoutPage(page);
  const result = await evaluatePlayout(page, async ({ moduleUrl, harnessUrl }) => {
    const { createMediaPlayout } = await import(moduleUrl);
    const harness = await import(harnessUrl);
    const audio = await harness.createSilentAudioOutput();
    const video = harness.createCanvasVideoOutput();
    const playout = createMediaPlayout({
      targetLatencyMs: 500,
      audio: { context: audio.context, destination: audio.destination },
      video: { output: video.output },
    });
    try {
      await harness.waitFor(
        () => audio.context.getOutputTimestamp().performanceTime > 0,
        2000,
        "出力時計の準備",
      );
      const timestamp = Math.round((performance.timeOrigin + performance.now()) * 1000);
      const frame = new VideoFrame(video.canvas, { timestamp });
      playout.trackVideoDecodeInput(timestamp, { timestampKind: "wallClock" });
      playout.pushVideo(frame);
      const data = harness.createAudioData(timestamp, { fill: 0.2 });
      playout.trackAudioDecodeInput(timestamp, { timestampKind: "wallClock" });
      const status = playout.pushAudio(data).status;
      data.close();
      const stats = playout.getStats().audio;
      const drain = await playout.drainAudio({ maxWaitMs: 800 });
      return { status, timing: stats.timing, drain };
    } finally {
      playout.clearAll();
      await harness.closeSilentAudioOutput(audio);
    }
  });
  assert.equal(result.status, "played");
  assert.equal(result.timing.arrivalPlannedFrames, 0, "映像と共有する目標で予約すること");
  assert.ok(
    result.timing.lastStartDelayMs > 480 && result.timing.lastStartDelayMs < 600,
    "大きな明示目標も実時計へ換算すること",
  );
  assert.equal(result.drain.cutMs, 0, "予約した音を実際に鳴らし切ること");
});

for (const missingMediaMicros of [8, 20000]) {
  test(`キューで吸収した ${missingMediaMicros} us の媒体時刻の跳びを区別する`, async ({ page }) => {
    await openPlayoutPage(page);
    const result = await evaluatePlayout(
      page,
      async ({ moduleUrl, missingMediaMicros }) => {
        const { AudioPlayoutSession } = await import(
          new URL("./playout/audioPlayoutSession.ts", moduleUrl).href
        );
        const { AudioPlayoutTimingStats } = await import(
          new URL("./playout/audioPlayoutTimingStats.ts", moduleUrl).href
        );
        const context = new AudioContext({ sampleRate: 48000 });
        await context.suspend();
        const chunks: Float32Array[] = [];
        const url = URL.createObjectURL(
          new Blob(
            [
              `class Capture extends AudioWorkletProcessor {
      process(inputs, outputs) {
        this.port.postMessage(inputs[0]?.[0]?.slice() ?? new Float32Array(outputs[0][0].length));
        return true;
      }
    } registerProcessor("media-jump-capture", Capture);`,
            ],
            { type: "text/javascript" },
          ),
        );
        await context.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        const tap = new AudioWorkletNode(context, "media-jump-capture");
        tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
          chunks.push(event.data);
        };
        const mute = context.createGain();
        mute.gain.value = 0;
        tap.connect(mute).connect(context.destination);
        const session = new AudioPlayoutSession({
          timing: new AudioPlayoutTimingStats(10000, performance.timeOrigin),
        }) as unknown as {
          playout: import("../../src/playout/audioPlayout").AudioPlayoutScheduler;
          playSound(
            output: { context: AudioContext; destination: AudioNode },
            decision: import("../../src/playout/audioPlayout").AudioPlayoutDecision,
            data: AudioData,
            channels: number,
            rate: number,
            frames: number,
          ): unknown;
        };
        try {
          const now = context.currentTime;
          const gaps: number[] = [];
          for (const [index, timestamp] of [
            0,
            20000 + missingMediaMicros,
            40000 + missingMediaMicros,
          ].entries()) {
            // 実再生の隙間がない場合も、小さな時計補正と 1 パケットの欠落を区別する。
            const decision = session.playout.schedule(now, timestamp, 0.02, {
              targetStartSeconds: now + 0.1 + index * 0.02,
              enforceTarget: true,
              arrivalSeconds: now,
              delaySeconds: 0.3,
              arrivalDelaySeconds: 0.05,
              presentationDelaySeconds: 0.05,
            });
            if (decision.kind !== "play") throw new Error("Expected a play decision");
            gaps.push(decision.totalGapSeconds);
            const data = new AudioData({
              format: "f32-planar",
              sampleRate: 48000,
              numberOfChannels: 1,
              numberOfFrames: 960,
              timestamp,
              data: new Float32Array(960).fill(index === 0 ? 0.3 : -0.3),
            });
            session.playSound({ context, destination: tap }, decision, data, 1, 48000, 960);
            data.close();
          }
          await context.resume();
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 350);
          });
          const samples = chunks.flatMap((chunk) => Array.from(chunk));
          let maximumStep = 0;
          for (let index = 1; index < samples.length; index++)
            maximumStep = Math.max(
              maximumStep,
              Math.abs((samples[index] ?? 0) - (samples[index - 1] ?? 0)),
            );
          return {
            gaps,
            maximumStep,
            minimum: Math.min(...samples),
            maximum: Math.max(...samples),
          };
        } finally {
          tap.disconnect();
          mute.disconnect();
          await context.close();
        }
      },
      { missingMediaMicros },
    );
    assert.deepEqual(result.gaps, [0, 0, 0], "実再生の穴がなくても媒体の欠落は存在すること");
    assert.ok(result.maximum > 0.29 && result.minimum < -0.29, "両方の音を実際に鳴らすこと");
    if (missingMediaMicros > 10000)
      assert.ok(
        result.maximumStep < 0.01,
        `媒体の欠落を段差にしないこと: ${JSON.stringify(result)}`,
      );
    else
      assert.ok(result.maximumStep > 0.59, "小さな時計の補正では元の PCM の変化を加工しないこと");
  });
}

for (const timestampKind of ["mediaTime", "wallClock"] as const) {
  test(`Datagram 相当の周期的な媒体欠落で音声の再生遅延を増やさない: ${timestampKind}`, async ({
    page,
  }) => {
    await openPlayoutPage(page);
    const result = await evaluatePlayout(
      page,
      async ({ moduleUrl, harnessUrl, timestampKind }) => {
        const { createMediaPlayout } = await import(moduleUrl);
        const harness = await import(harnessUrl);
        const output = await harness.createSilentAudioOutput();
        const playout = createMediaPlayout({
          audio: { context: output.context, destination: output.destination },
        });
        try {
          await harness.waitFor(
            () => output.context.getOutputTimestamp().performanceTime > 0,
            2000,
            "出力時計の準備",
          );
          const origin = performance.now() + 30;
          const epoch =
            timestampKind === "wallClock"
              ? Math.round((performance.timeOrigin + origin) * 1000)
              : 0;
          for (let index = 0; index < 150; index++) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, Math.max(0, origin + index * 20 - performance.now()));
            });
            if (index % 10 === 7) continue;
            let state = index + 123456;
            const samples = Float32Array.from({ length: 960 }, () => {
              state = (state * 1664525 + 1013904223) >>> 0;
              return (state / 4294967296 - 0.5) * 0.4;
            });
            const data = harness.createAudioData(epoch + index * 20000, { data: samples });
            playout.trackAudioDecodeInput(data.timestamp, { timestampKind });
            playout.pushAudio(data);
            data.close();
          }
          return playout.getStats().audio;
        } finally {
          playout.clearAll();
          await harness.closeSilentAudioOutput(output);
        }
      },
      { timestampKind },
    );
    // 欠落後の error / drop を少数の正常予約の統計で隠してはならない。
    assert.equal(result.timing.playedFrames, 135, "欠落させなかった全音声を再生すること");
    assert.equal(result.timing.missedFrames, 0, "受信済みの音声を失わないこと");
    assert.ok(result.timing.gapMs > 0, "復元できない媒体の欠落も計器には残すこと");
    assert.ok(
      (result.timing.startDelayMs?.p95 ?? Infinity) < 65,
      "正常到着の音を 65 ms 以内に再生すること",
    );
    assert.ok(
      result.delay.targetMs <= 50,
      `パケット欠落で目標遅延を増やさないこと: ${JSON.stringify(result)}`,
    );
  });
}

test("周期のない子音に 1 ms の隙間が空いても無音と周期フェードを作らない", async ({ page }) => {
  await openPlayoutPage(page);
  const result = await evaluatePlayout(page, async ({ moduleUrl, harnessUrl }) => {
    const { createMediaPlayout } = await import(moduleUrl);
    const harness = await import(harnessUrl);
    const output = await harness.createSilentAudioOutput();
    const playout = createMediaPlayout({
      audio: { context: output.context, destination: output.destination },
    });
    try {
      await output.context.suspend();
      for (const timestamp of [0, 21000]) {
        let state = 123456;
        const samples = Float32Array.from({ length: 960 }, () => {
          state = (state * 1664525 + 1013904223) >>> 0;
          return (state / 4294967296 - 0.5) * 0.4;
        });
        const data = harness.createAudioData(timestamp, { data: samples });
        playout.trackAudioDecodeInput(timestamp, { timestampKind: "mediaTime" });
        playout.pushAudio(data);
        data.close();
      }
      return playout.getStats().audio;
    } finally {
      playout.clearAll();
      await harness.closeSilentAudioOutput(output);
    }
  });
  assert.ok(result.concealedMs > 0.9, "周期のない 1 ms も繋ぐこと");
  assert.equal(result.timing.gapCount, 0, "短い目標移動で無音を繰り返さないこと");
});

test("購読者の実音声出力で所有権、入力時刻、停止時の drain を検証する", async ({ page }) => {
  await openPlayoutPage(page);
  const result = await evaluatePlayout(page, async ({ moduleUrl }) => {
    const { MediaSubscriberImpl } = await import(
      new URL("./createMediaSubscriber.ts", moduleUrl).href
    );
    const errors: string[] = [];
    const subscriber = new MediaSubscriberImpl(
      "https://localhost.invalid",
      { namespace: ["quality"], audio: {} },
      {
        onError: (error: Error) => {
          errors.push(error.message);
        },
      },
    );
    const control = subscriber as unknown as {
      playout: import("../../src/playout/mediaPlayout").MediaPlayout;
      audioOutput: { context: AudioContext; destination: MediaStreamAudioDestinationNode };
      currentState: string;
      audioWallClockSeen: boolean;
      audioDecodeStopped: boolean;
      handleAudioDecodedData(data: { data: AudioData }): void;
    };
    const context = new AudioContext({ sampleRate: 48000 });
    await context.resume();
    const destination = context.createMediaStreamDestination();
    control.audioOutput = { context, destination };
    control.playout.setAudioOutput(control.audioOutput);
    control.currentState = "active";
    const timestamp = Math.round((performance.timeOrigin + performance.now()) * 1000);
    const deliverFrame = (frameTimestamp: number, timestampKind: "wallClock" | "mediaTime") => {
      const frame = new AudioData({
        format: "f32-planar",
        sampleRate: 48000,
        numberOfChannels: 1,
        numberOfFrames: 960,
        timestamp: frameTimestamp,
        data: new Float32Array(960).fill(0.2),
      });
      control.playout.trackAudioDecodeInput(frameTimestamp, { timestampKind });
      control.handleAudioDecodedData({ data: frame });
      return frame.numberOfFrames;
    };
    control.playout.setAudioOutput(null);
    const skippedWallClosedFrames = deliverFrame(timestamp - 20000, "wallClock");
    const seenAfterSkippedWall = control.audioWallClockSeen;
    control.playout.setAudioOutput(control.audioOutput);
    const data = new AudioData({
      format: "f32-planar",
      sampleRate: 48000,
      numberOfChannels: 1,
      numberOfFrames: 960,
      timestamp,
      data: new Float32Array(960).fill(0.2),
    });
    control.playout.trackAudioDecodeInput(timestamp, {
      timestampKind: "wallClock",
      inputLagMs: 27,
    });
    control.handleAudioDecodedData({ data });
    const closedFrames = data.numberOfFrames;
    const seen = control.audioWallClockSeen;
    const stats = control.playout.getStats();
    control.playout.setAudioOutput(null);
    const skippedMediaClosedFrames = deliverFrame(timestamp + 20000, "mediaTime");
    const seenAfterSkippedMedia = control.audioWallClockSeen;
    control.playout.setAudioOutput(control.audioOutput);
    deliverFrame(timestamp + 40000, "mediaTime");
    const seenAfterPlayedMedia = control.audioWallClockSeen;
    await subscriber.stop();
    const afterStop = subscriber.getStats().audio?.playoutTiming;
    const lateData = new AudioData({
      format: "f32-planar",
      sampleRate: 48000,
      numberOfChannels: 1,
      numberOfFrames: 960,
      timestamp: timestamp + 20000,
      data: new Float32Array(960),
    });
    control.handleAudioDecodedData({ data: lateData });
    return {
      closedFrames,
      seen,
      skippedWallClosedFrames,
      skippedMediaClosedFrames,
      seenAfterSkippedWall,
      seenAfterSkippedMedia,
      seenAfterPlayedMedia,
      stats,
      afterStop,
      lateClosedFrames: lateData.numberOfFrames,
      finalPlayedFrames: control.playout.getStats().audio?.timing.playedFrames,
      contextState: context.state,
      errors,
    };
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.closedFrames, 0, "再生へ渡した AudioData を購読者が閉じること");
  assert.equal(result.seen, true, "壁時計の観測を引き継ぐこと");
  assert.equal(result.skippedWallClosedFrames, 0);
  assert.equal(result.skippedMediaClosedFrames, 0);
  assert.equal(result.seenAfterSkippedWall, false, "鳴らさない壁時計では未観測のままになること");
  assert.equal(
    result.seenAfterSkippedMedia,
    true,
    "鳴らさないメディア時刻では壁時計の観測を残すこと",
  );
  assert.equal(
    result.seenAfterPlayedMedia,
    false,
    "実際に鳴らしたメディア時刻では壁時計の観測を落とすこと",
  );
  assert.equal(result.stats.audio?.timing.playedFrames, 1);
  assert.equal(result.stats.audio?.catchUp.inputLagMs, 27);
  assert.equal(result.stats.audio?.timing.sampleRateMismatchFrames, 0);
  assert.equal(result.afterStop?.lastDrain?.cutMs, 0);
  assert.ok((result.afterStop?.lastDrain?.playedMs ?? 0) > 0);
  assert.equal(result.contextState, "closed");
  assert.equal(result.lateClosedFrames, 0, "停止後に届いた AudioData も閉じること");
  assert.equal(result.finalPlayedFrames, 2, "停止後の音声を新しく予約しないこと");
});

for (const { frames, gapMicros } of [
  { frames: 1, gapMicros: 0 },
  { frames: 8, gapMicros: 0 },
  { frames: 3, gapMicros: 20008 },
  { frames: 3, gapMicros: 200000 },
]) {
  test(`音声 ${frames} フレームと ${gapMicros} us の穴で開始、接続、途絶の段差を作らない`, async ({
    page,
  }) => {
    await openPlayoutPage(page);
    const result = await evaluatePlayout(
      page,
      async ({ moduleUrl, frames, gapMicros }) => {
        const { createMediaPlayout } = await import(moduleUrl);
        const context = new AudioContext({ sampleRate: 48000 });
        const chunks: Float32Array[] = [];
        const module = URL.createObjectURL(
          new Blob(
            [
              `class Capture extends AudioWorkletProcessor {
        process(inputs, outputs) {
          this.port.postMessage(inputs[0]?.[0]?.slice() ?? new Float32Array(outputs[0][0].length));
          return true;
        }
      } registerProcessor("quality-capture", Capture);`,
            ],
            { type: "text/javascript" },
          ),
        );
        await context.audioWorklet.addModule(module);
        URL.revokeObjectURL(module);
        const tap = new AudioWorkletNode(context, "quality-capture");
        tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
          chunks.push(event.data);
        };
        const mute = context.createGain();
        mute.gain.value = 0;
        tap.connect(mute).connect(context.destination);
        const playout = createMediaPlayout({ audio: { context, destination: tap } });
        try {
          await context.resume();
          let status = "";
          for (let index = 0; index < frames; index++) {
            const timestamp = index * 20000 + (index > 0 ? gapMicros : 0);
            const data = new AudioData({
              format: "f32-planar",
              sampleRate: 48000,
              numberOfChannels: 1,
              numberOfFrames: 960,
              timestamp,
              data: new Float32Array(960).fill(0.3),
            });
            playout.trackAudioDecodeInput(timestamp, { timestampKind: "mediaTime" });
            status = playout.pushAudio(data).status;
            data.close();
          }
          await playout.drainAudio({ maxWaitMs: 500 });
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 100);
          });
          const samples = chunks.flatMap((chunk) => Array.from(chunk));
          let previous = 0;
          let maximumStep = 0;
          let maximumStepIndex = 0;
          let peak = 0;
          for (const [index, sample] of samples.entries()) {
            if (Math.abs(sample - previous) > maximumStep) {
              maximumStep = Math.abs(sample - previous);
              maximumStepIndex = index;
            }
            peak = Math.max(peak, Math.abs(sample));
            previous = sample;
          }
          const firstActive = samples.findIndex((sample) => sample > 0.001);
          let lastActive = samples.length - 1;
          while (lastActive > firstActive && (samples[lastActive] ?? 0) < 0.001) lastActive--;
          const interior = samples.slice(firstActive + 100, lastActive - 100);
          const interiorMinimum = interior.reduce(
            (minimum, sample) => Math.min(minimum, sample),
            1,
          );
          return {
            status,
            maximumStep,
            peak,
            maximumStepIndex,
            neighbors: samples.slice(Math.max(0, maximumStepIndex - 3), maximumStepIndex + 4),
            interiorMinimum,
          };
        } finally {
          playout.clearAll();
          tap.disconnect();
          mute.disconnect();
          await context.close();
        }
      },
      { frames, gapMicros },
    );
    assert.equal(result.status, "played");
    assert.ok(result.peak > 0.29, "無音にしてテストを通さず、元の振幅まで鳴らすこと");
    assert.ok(
      result.maximumStep < 0.01,
      `開始と途絶で段差を作らないこと: ${JSON.stringify(result)}`,
    );
    if (gapMicros === 0)
      assert.ok(result.interiorMinimum > 0.299, "通常のフレーム境界では末尾フェードを取り消すこと");
    else if (gapMicros < 100000)
      assert.ok(result.interiorMinimum > 0.2, "補間の丸めによる 1 サンプルの無音も残さないこと");
  });
}

test("圧縮した音の直後に欠落しても補間の材料が不足しない", async ({ page }) => {
  await openPlayoutPage(page);
  const result = await evaluatePlayout(page, async ({ moduleUrl, harnessUrl }) => {
    const harness = await import(harnessUrl);
    const output = await harness.createSilentAudioOutput();
    const { AudioPlayoutSession } = await import(
      new URL("./playout/audioPlayoutSession.ts", moduleUrl).href
    );
    const { AudioPlayoutTimingStats } = await import(
      new URL("./playout/audioPlayoutTimingStats.ts", moduleUrl).href
    );
    const timing = new AudioPlayoutTimingStats(10000, performance.timeOrigin);
    const session = new AudioPlayoutSession({ timing }) as unknown as {
      playout: import("../../src/playout/audioPlayout").AudioPlayoutScheduler;
      playSound(
        output: { context: AudioContext; destination: AudioNode },
        decision: import("../../src/playout/audioPlayout").AudioPlayoutDecision,
        data: AudioData,
        channels: number,
        rate: number,
        frames: number,
      ): unknown;
    };
    try {
      await output.context.suspend();
      // 予約の時刻は実クラスへ明示して固定する。performance.now() と停止中の
      // 出力時計の差によって、圧縮の不感帯 20 ms を偶然下回るテストにしない。
      const now = output.context.currentTime;
      // まとめて届いた先行フレームを実際に圧縮し、その直後の 20 ms を欠落させる。
      // 170 Hz は圧縮前の 20 ms なら補間でき、圧縮後の約 14 ms では解析窓が不足する。
      for (const index of [0, 1, 3]) {
        const data = harness.createAudioData(index * 20000, {
          data: Float32Array.from(
            { length: 960 },
            (_, sample) => 0.3 * Math.sin((2 * Math.PI * 170 * (index * 960 + sample)) / 48000),
          ),
        });
        const decision = session.playout.schedule(now, data.timestamp, 0.02, {
          targetStartSeconds: null,
          arrivalSeconds: now - 0.03,
          enforceTarget: false,
          arrivalDelaySeconds: 0.05,
          delaySeconds: 0.05,
          presentationDelaySeconds: 0.05,
        });
        if (decision.kind !== "play") throw new Error("Expected a play decision");
        session.playSound(output, decision, data, 1, 48000, 960);
        data.close();
      }
      await output.context.resume();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 200);
      });
      return {
        audio: {
          compressedMs: session.playout.compressed * 1000,
          concealedMs: session.playout.concealed * 1000,
          timing: timing.snapshot(performance.now()),
        },
      };
    } finally {
      await harness.closeSilentAudioOutput(output);
    }
  });
  assert.ok(result.audio.compressedMs > 0, "圧縮を実際に適用していること");
  assert.ok(result.audio.concealedMs > 0, "欠落を実際に補間していること");
  assert.equal(result.audio.timing.gapCount, 0, "圧縮後の材料不足で無音の穴を作らないこと");
});
