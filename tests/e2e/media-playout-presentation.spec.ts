/**
 * 映像の表示が、時間軸が決めた表示時刻に最も近い vsync で行われることを実ブラウザで確かめる
 *
 * 単体テストは注入した tick の列で規則を固定する。ここでは実ブラウザの rAF と、
 * `MediaStreamTrackGenerator` の実際の表示 (`requestVideoFrameCallback`)、canvas への
 * 実際の描画時刻を使い、規則が実物の上でも成り立つことを確かめる。
 *
 * 表示周期の計測のため `requestAnimationFrame` をラップする。テストのページは他の用途と
 * 共有しないため、ラップはこのテストの中だけで元に戻す。
 */
import { test, expect } from "@playwright/test";
import { evaluatePlayout, openPlayoutPage } from "./playoutTestPage";

// MediaStreamTrackGenerator と requestVideoFrameCallback は headless shell ではなく
// 通常の Chromium で動く (Playwright 1.64.1 / Chromium 156 で確認)
test.use({
  launchOptions: {
    channel: "chromium",
    args: ["--autoplay-policy=no-user-gesture-required"],
  },
});

test("MediaStreamTrackGenerator は書き込み tick の次の vsync で表示する", async ({ page }) => {
  await openPlayoutPage(page);
  const measurement = await evaluatePlayout(page, async ({ moduleUrl, harnessUrl }) => {
    const { createMediaPlayout } = (await import(moduleUrl)) as typeof import("../../src/index");
    const harness = (await import(harnessUrl)) as typeof import("./playoutBrowserHarness");

    const originalRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    const ticks: number[] = [];
    let lastTick = performance.now();
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      return originalRequestAnimationFrame((timestampMs) => {
        ticks.push(timestampMs);
        lastTick = timestampMs;
        callback(timestampMs);
      });
    };

    const generator = new (
      window as unknown as {
        MediaStreamTrackGenerator: new (init: { kind: "video" }) => MediaStreamTrack;
      }
    ).MediaStreamTrackGenerator({ kind: "video" });
    const writer = (
      generator as unknown as { writable: WritableStream<VideoFrame> }
    ).writable.getWriter();
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([generator]);
    video.width = 16;
    video.height = 16;
    video.style.width = "16px";
    video.style.height = "16px";
    document.body.append(video);
    // フレームが届く前の play() は解決しないことがあるため、待たない
    void video.play().catch(() => undefined);

    const writes: { tickMs: number; presentationMs: number | null }[] = [];
    const displays: number[] = [];
    let lastPresentedFrames = -1;
    const recordVideoFrame = (
      _nowMs: number,
      metadata: { presentedFrames: number; expectedDisplayTime: number },
    ): void => {
      if (metadata.presentedFrames !== lastPresentedFrames) {
        lastPresentedFrames = metadata.presentedFrames;
        // rVFC のコールバックは表示された vsync で呼ばれる。expectedDisplayTime は
        // 次の合成の予定時刻であり、実際の表示より 1 tick 遅い値になるため使わない
        displays.push(performance.now());
      }
      requestVideoFrameCallback();
    };
    const requestVideoFrameCallback = (): void => {
      (
        video as HTMLVideoElement & {
          requestVideoFrameCallback: (
            callback: (
              nowMs: number,
              metadata: { presentedFrames: number; expectedDisplayTime: number },
            ) => void,
          ) => number;
        }
      ).requestVideoFrameCallback(recordVideoFrame);
    };
    requestVideoFrameCallback();

    const output: import("../../src/index").VideoPlayoutOutput = {
      presentationLatencyTicks: 1,
      isAvailable: () => true,
      present: (frame, presentationMs) => {
        writes.push({ tickMs: lastTick, presentationMs });
        void writer.write(frame).catch(() => {
          frame.close();
        });
        return true;
      },
    };
    const playout = createMediaPlayout({
      targetLatencyMs: 120,
      video: {
        output,
      },
    });
    await playout.prepareAudio();
    const startMs = performance.now();
    for (let index = 0; performance.now() - startMs < 4_000; index++) {
      // targetLatency を下限にすると、観測した直後のフレームの表示時刻も未来に残る
      const timestamp = harness.wallClockNowMicros();
      playout.trackVideoDecodeInput(timestamp, {
        timestampKind: "wallClock",
        location: { group: 0n, object: BigInt(index) },
      });
      const result = playout.pushVideo(harness.createI420Frame(timestamp));
      if (result.status !== "queued") {
        throw new Error(`unexpected push status: ${result.status}`);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 1_000 / 30);
      });
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    window.requestAnimationFrame = originalRequestAnimationFrame;
    writer.close().catch(() => undefined);
    video.pause();
    video.srcObject = null;
    playout.clearAll();

    const intervals = ticks
      .slice(1)
      .map((tick, index) => tick - (ticks[index] ?? tick))
      .filter((interval) => interval > 0.5 && interval < 100)
      .sort((left, right) => left - right);
    const middle = Math.floor(intervals.length / 2);
    const refreshMs =
      intervals.length === 0
        ? 1_000 / 60
        : intervals.length % 2 === 0
          ? ((intervals[middle - 1] ?? 0) + (intervals[middle] ?? 0)) / 2
          : (intervals[middle] ?? 0);

    const warmup = 20;
    // generator は書き込み tick の次の vsync で表示される。presentationLatencyTicks = 1 を
    // 使って、書き込み tick + 1 表示周期を期待値にする
    const expectedDisplays = writes.slice(warmup).map((write) => write.tickMs + refreshMs);
    const measuredDisplays = displays.slice(warmup);
    const count = Math.min(expectedDisplays.length, measuredDisplays.length);
    // フレームの対応は、書き込みと表示の順序をそのまま使う (30 fps で 60 Hz 表示のため
    // 1 書き込みにつき 1 表示になる)
    const signedErrors = measuredDisplays
      .slice(0, count)
      .map((displayMs, index) => displayMs - (expectedDisplays[index] ?? displayMs));
    // 書き込み tick が、present に渡された表示時刻の 1 tick 前になっていること
    const compensationErrors = writes
      .slice(warmup)
      .filter((write) => write.presentationMs !== null)
      .map((write) => (write.presentationMs ?? 0) - (write.tickMs + refreshMs));
    return {
      refreshMs,
      writes: writes.length,
      displays: displays.length,
      displayErrorMs: signedErrors.map((error) => Math.abs(error)),
      meanSignedErrorMs:
        signedErrors.reduce((sum, error) => sum + error, 0) / Math.max(1, signedErrors.length),
      compensationErrors: compensationErrors.map((error) => Math.abs(error)),
    };
  });

  expect(measurement.refreshMs).toBeGreaterThan(5);
  expect(measurement.writes).toBeGreaterThan(60);
  expect(measurement.displays).toBeGreaterThan(60);
  expect(Math.abs(measurement.writes - measurement.displays)).toBeLessThanOrEqual(2);
  const sortedErrors = [...measurement.displayErrorMs].sort((left, right) => left - right);
  const p95 = sortedErrors[Math.floor(sortedErrors.length * 0.95)] ?? Number.NaN;
  // rAF の tick の時刻と expectedDisplayTime の軸差、および位相の揺れを含む
  expect(p95).toBeLessThanOrEqual(3);
  // 系統的な遅れ (期待値より遅い側への偏り) がない
  expect(Math.abs(measurement.meanSignedErrorMs)).toBeLessThanOrEqual(2);
  // 映像の表示時刻の 1 tick 前に書き込んでいる (session の提示遅延の補償)
  const sortedCompensation = [...measurement.compensationErrors].sort(
    (left, right) => left - right,
  );
  const compensationP95 =
    sortedCompensation[Math.floor(sortedCompensation.length * 0.95)] ?? Number.NaN;
  expect(compensationP95).toBeLessThanOrEqual(measurement.refreshMs / 2 + 2);
});

test("canvas は表示時刻に最も近い vsync で描く", async ({ page }) => {
  await openPlayoutPage(page);
  const measurement = await evaluatePlayout(page, async ({ moduleUrl, harnessUrl }) => {
    const { createMediaPlayout } = (await import(moduleUrl)) as typeof import("../../src/index");
    const harness = (await import(harnessUrl)) as typeof import("./playoutBrowserHarness");

    const originalRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    const ticks: number[] = [];
    let lastTick = performance.now();
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      return originalRequestAnimationFrame((timestampMs) => {
        ticks.push(timestampMs);
        lastTick = timestampMs;
        callback(timestampMs);
      });
    };

    const draws: { tickMs: number; presentationMs: number | null }[] = [];
    const output: import("../../src/index").VideoPlayoutOutput = {
      presentationLatencyTicks: 0,
      isAvailable: () => true,
      present: (frame, presentationMs) => {
        draws.push({ tickMs: lastTick, presentationMs });
        frame.close();
        return true;
      },
    };
    const playout = createMediaPlayout({ targetLatencyMs: 120, video: { output } });
    await playout.prepareAudio();
    const startMs = performance.now();
    for (let index = 0; performance.now() - startMs < 4_000; index++) {
      // targetLatency を下限にすると、観測した直後のフレームの表示時刻も未来に残る
      const timestamp = harness.wallClockNowMicros();
      playout.trackVideoDecodeInput(timestamp, {
        timestampKind: "wallClock",
        location: { group: 0n, object: BigInt(index) },
      });
      const result = playout.pushVideo(harness.createI420Frame(timestamp));
      if (result.status !== "queued") {
        throw new Error(`unexpected push status: ${result.status}`);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 1_000 / 30);
      });
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    window.requestAnimationFrame = originalRequestAnimationFrame;
    playout.clearAll();

    const warmup = 20;
    const measured = draws.slice(warmup);
    const canvasErrorMs = measured
      .filter((draw) => draw.presentationMs !== null)
      .map((draw) => Math.abs(draw.tickMs - (draw.presentationMs ?? draw.tickMs)));
    const canvasIntervalsMs = measured
      .slice(1)
      .map((draw, index) => draw.tickMs - (measured[index]?.tickMs ?? draw.tickMs));
    return {
      writes: draws.length,
      canvasErrorMs,
      canvasIntervalsMs,
    };
  });

  expect(measurement.writes).toBeGreaterThan(60);
  const sortedErrors = [...measurement.canvasErrorMs].sort((left, right) => left - right);
  const p95 = sortedErrors[Math.floor(sortedErrors.length * 0.95)] ?? Number.NaN;
  // 表示周期の半分 (60 Hz で 8.33 ms) と、計測の刻みの余裕
  expect(p95).toBeLessThanOrEqual(10.5);
  const sortedIntervals = [...measurement.canvasIntervalsMs].sort((left, right) => left - right);
  const p50Interval = sortedIntervals[Math.floor(sortedIntervals.length * 0.5)] ?? Number.NaN;
  expect(p50Interval).toBeGreaterThanOrEqual(31);
  expect(p50Interval).toBeLessThanOrEqual(36);
});
