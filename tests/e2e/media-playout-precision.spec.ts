/** 直接出力の実描画通知と canvas の表示を同じ媒体時刻で照合する。 */
import { test } from "@playwright/test";
import assert from "node:assert/strict";
import { evaluatePlayout, openPlayoutPage } from "./playoutTestPage";

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

for (const { minDelayMs, stallMs } of [
  { minDelayMs: 10, stallMs: 0 },
  { minDelayMs: 10, stallMs: 80 },
  { minDelayMs: 50, stallMs: 0 },
]) {
  test(`直接出力で待ち時間と A/V 誤差を同時に抑える ${minDelayMs} ms / 停滞 ${stallMs} ms`, async ({
    page,
  }, testInfo) => {
    await openPlayoutPage(page);
    const result = await evaluatePlayout(
      page,
      async ({ moduleUrl, harnessUrl, minDelayMs, stallMs }) => {
        const { createMediaPlayout } = await import(moduleUrl);
        const harness = await import(harnessUrl);
        const output = await harness.createSilentAudioOutput({
          sampleRate: 48000,
          latencyHint: "interactive",
        });
        const canvas = document.createElement("canvas");
        canvas.width = 16;
        canvas.height = 16;
        document.body.append(canvas);
        const drawing = canvas.getContext("2d");
        if (drawing === null) throw new Error("canvas を作成できない");
        const audio = new Map<number, number>();
        const video = new Map<number, number>();
        const leads: number[] = [];
        let played = 0;
        const playout = createMediaPlayout({
          audio: { context: output.context, destination: output.destination, minDelayMs },
          video: {
            output: {
              presentationLatencyTicks: 0,
              isAvailable: () => canvas.isConnected,
              present: (frame: VideoFrame) => {
                drawing.drawImage(frame, 0, 0);
                video.set(frame.timestamp, performance.now());
                frame.close();
                return true;
              },
            },
          },
        });
        try {
          await playout.prepareAudio();
          // 本番の MessagePort を観測するだけであり、予約や通知を置換しない。
          const port = (
            playout as unknown as { audio: { session: { renderer: { node: AudioWorkletNode } } } }
          ).audio.session.renderer.node.port;
          port.addEventListener(
            "message",
            (
              event: MessageEvent<{
                type: string;
                sample?: { timestampMicroseconds: number; contextTimeSeconds: number };
              }>,
            ) => {
              if (event.data.type !== "presentation" || event.data.sample === undefined) return;
              const mapping = output.context.getOutputTimestamp();
              if (mapping.performanceTime <= 0) return;
              const sample = event.data.sample;
              // scheduler の推定値を使い回さず、描画した位置をその時点の実出力時計で測る。
              audio.set(
                sample.timestampMicroseconds,
                mapping.performanceTime + (sample.contextTimeSeconds - mapping.contextTime) * 1000,
              );
              leads.push(
                (output.context.currentTime - mapping.contextTime) * 1000 -
                  (performance.now() - mapping.performanceTime),
              );
            },
          );
          const origin = performance.now() + 30;
          const epoch = Math.round((performance.timeOrigin + origin) * 1000);
          for (let index = 0; index < 400; index++) {
            const remaining = origin + index * 10 - performance.now();
            if (remaining > 0)
              await new Promise<void>((resolve) => {
                setTimeout(resolve, remaining);
              });
            if (index === 150 && stallMs > 0) {
              // 本物のメインスレッド停止を作り、停止後に低遅延と同期の両方へ戻るか測る。
              const until = performance.now() + stallMs;
              while (performance.now() < until) {}
            }
            const timestamp = epoch + index * 10000;
            const samples = Float32Array.from(
              { length: 480 },
              (_, frame) => Math.sin(((index * 480 + frame) * 2 * Math.PI * 200) / 48000) * 0.2,
            );
            const data = harness.createAudioData(timestamp, { data: samples });
            playout.trackAudioDecodeInput(timestamp, { timestampKind: "wallClock" });
            const status = playout.pushAudio(data);
            data.close();
            if (status.status === "error") throw status.error;
            if (status.status === "played") played++;
            if (index % 2 === 0) {
              playout.trackVideoDecodeInput(timestamp, {
                timestampKind: "wallClock",
                location: { group: BigInt(index), object: 0n },
              });
              playout.pushVideo(new VideoFrame(canvas, { timestamp }));
            }
          }
          await playout.drainAudio();
          const summary = (values: number[]) => {
            values.sort((left, right) => left - right);
            return {
              samples: values.length,
              p50: values[Math.floor(values.length * 0.5)] ?? Infinity,
              p95: values[Math.floor(values.length * 0.95)] ?? Infinity,
              max: values.at(-1) ?? Infinity,
            };
          };
          const steadyAudio = [...audio].filter(([timestamp]) => timestamp - epoch >= 2000000);
          const ages = steadyAudio.map(
            ([timestamp, atMs]) => atMs - origin - (timestamp - epoch) / 1000,
          );
          const skews = steadyAudio.flatMap(([timestamp, atMs]) => {
            const videoMs = video.get(timestamp);
            return videoMs === undefined ? [] : [Math.abs(videoMs - atMs)];
          });
          const timing = playout.getStats().audio;
          return {
            minDelayMs,
            stallMs,
            played,
            concealedMs: timing?.concealedMs,
            gapMs: timing?.timing.gapMs,
            audio: summary(ages),
            skew: summary(skews),
            outputLead: summary(leads),
            videoFrames: video.size,
            targetMs: playout.getStats().audio?.delay.targetMs,
          };
        } finally {
          playout.clearAll();
          canvas.remove();
          await harness.closeSilentAudioOutput(output);
        }
      },
      { minDelayMs, stallMs },
    );
    await testInfo.attach("直接出力の遅延と同期", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });
    console.log("直接出力の遅延と同期", JSON.stringify(result));
    assert.equal(result.played, 400, "音声を捨てて低遅延に見せないこと");
    assert.ok(
      result.audio.samples >= 70 && result.skew.samples >= 25,
      "実描画通知と一致する映像を十分に測ること",
    );
    assert.ok(result.videoFrames >= 180, "映像の破棄で同期誤差を隠さないこと");
    // 3 ms の投入余裕に、5 ms の制御不感帯、描画量子、到着タイマーの揺れを許す。
    // 停滞後もこの同じ予算で評価し、20 ms の余分な待ちを許さない。
    assert.ok(
      result.audio.p95 < Math.max(minDelayMs, result.outputLead.p95 + 3) + 10,
      JSON.stringify(result),
    );
    assert.ok(result.skew.p95 < 12, JSON.stringify(result));
    assert.ok((result.gapMs ?? Infinity) < 1, "未補間の無音を増やさないこと");
  });
}

test("直接出力は短い欠落で補間を報告し、長い欠落で位置を失い、実音へ復帰する", async ({
  page,
}, testInfo) => {
  await openPlayoutPage(page);
  const result = await evaluatePlayout(page, async ({ moduleUrl, harnessUrl }) => {
    const { createMediaPlayout } = await import(moduleUrl);
    const harness = await import(harnessUrl);
    const output = await harness.createSilentAudioOutput({ latencyHint: "interactive" });
    const video = harness.createCanvasVideoOutput();
    const playout = createMediaPlayout({
      audio: { context: output.context, destination: output.destination, minDelayMs: 30 },
      video: { output: video.output, syncToAudioOutput: true },
    });
    const observations = {
      beforeReal: 0,
      shortConcealed: 0,
      longUnknown: 0,
      longKnown: 0,
      recoveredReal: 0,
      paired: 0,
    };
    try {
      await playout.prepareAudio();
      const samples = Float32Array.from(
        { length: 480 },
        (_, frame) => Math.sin((frame * 2 * Math.PI * 200) / 48_000) * 0.2,
      );
      const startMs = performance.now() + 30;
      const startTimestamp = Math.round((performance.timeOrigin + startMs) * 1000);
      for (let index = 0; index < 290; index++) {
        const wait = startMs + index * 10 - performance.now();
        if (wait > 0)
          await new Promise<void>((resolve) => {
            setTimeout(resolve, wait);
          });
        const timestamp = startTimestamp + index * 10_000;
        // 欠けた音だけ投入しない。映像は届き続け、Worklet と機器の時計は実物を使う。
        const lost = (index >= 80 && index < 86) || (index >= 155 && index < 205);
        if (!lost) {
          const data = harness.createAudioData(timestamp, { data: samples });
          playout.trackAudioDecodeInput(timestamp, { timestampKind: "wallClock" });
          const status = playout.pushAudio(data);
          data.close();
          if (status.status === "error") throw status.error;
        }
        if (index % 2 === 0) {
          playout.trackVideoDecodeInput(timestamp, {
            timestampKind: "wallClock",
            location: { group: BigInt(index), object: 0n },
          });
          playout.pushVideo(new VideoFrame(video.canvas, { timestamp }));
        }
        const stats = playout.getStats().avSync;
        const position = stats?.audioOutputPosition;
        const mediaMs =
          position === null || position === undefined
            ? null
            : (position.timestampMicroseconds - startTimestamp) / 1000;
        if (position?.kind === "real" && mediaMs !== null && mediaMs >= 300 && mediaMs < 800)
          observations.beforeReal++;
        if (position?.kind === "concealed" && mediaMs !== null && mediaMs >= 800 && mediaMs < 860)
          observations.shortConcealed++;
        // 長い欠落の終盤では、予測音の上限と出力時計の鮮度の両方が切れている。
        if (index >= 192 && index < 205) {
          if (position === null || position === undefined) observations.longUnknown++;
          else observations.longKnown++;
        }
        if (position?.kind === "real" && mediaMs !== null && mediaMs >= 2200)
          observations.recoveredReal++;
        if (stats !== null && stats !== undefined && stats.audioOutputSkew !== null)
          observations.paired++;
      }
      const videoFrames = video.presentCalls();
      playout.resetPlayout();
      const reset = playout.getStats().avSync;
      return {
        ...observations,
        videoFrames,
        resetPosition: reset?.audioOutputPosition,
        resetSkew: reset?.audioOutputSkew,
      };
    } finally {
      playout.clearAll();
      video.canvas.remove();
      await harness.closeSilentAudioOutput(output);
    }
  });
  await testInfo.attach("欠落時の出力位置", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
  assert.ok(result.beforeReal > 0 && result.recoveredReal > 0, "欠落の前後で実音を観測すること");
  assert.ok(result.shortConcealed > 0, "短い欠落に対応する推定位置を返すこと");
  assert.ok(
    result.longUnknown > 0 && result.longKnown === 0,
    "予測が尽きた後は媒体位置を返さないこと",
  );
  assert.ok(
    result.paired > 0 && result.videoFrames >= 100,
    "映像を再生して同時刻の音声と照合すること",
  );
  assert.equal(result.resetPosition, null);
  assert.equal(result.resetSkew, null);
});
