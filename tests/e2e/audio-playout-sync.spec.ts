import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { RELAY_PAGE_URL } from "./urls";

// Web Audio と WebCodecs の実物を使い、出力時計、予約、canvas への表示までを通す。
// ネットワークの到着の揺れは別の実リレーの検証で測り、ここでは出力との同期を固定する。
// 時間軸・音声の再生・映像の表示・計器は再生の入口 (createMediaPlayout) が持つ。
test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

test("実際の音声再生経路と canvas の表示を同期し、音声の停止と再開で状態を取り直す", async ({
  page,
}) => {
  await page.goto(RELAY_PAGE_URL);
  const result = await page.evaluate(
    async (moduleUrl) => {
      const { createMediaPlayout } = (await import(moduleUrl)) as typeof import("../../src/index");
      let context = new AudioContext({ sampleRate: 48_000, latencyHint: "interactive" });
      await context.resume();
      // テスト中の音は無音にするが、実際の出力グラフと時計は動かす。
      let gain = context.createGain();
      gain.gain.value = 0;
      // 利用側と同じ MediaStream → HTMLAudioElement の経路を通す。
      // 同期の計器が測るのは AudioContext の予約までであり、その後のデバイス遅延ではない。
      let destination = context.createMediaStreamDestination();
      gain.connect(destination);
      const element = document.createElement("audio");
      element.srcObject = destination.stream;
      document.body.append(element);
      await element.play();
      const canvas = document.createElement("canvas");
      canvas.width = 16;
      canvas.height = 16;
      document.body.append(canvas);
      const drawing = canvas.getContext("2d");
      if (drawing === null) throw new Error("canvas の 2D コンテキストを作成できませんでした");
      // 音声と映像で 1 つの時間軸を共有する入口を作る。映像は canvas へ直接描くため、
      // 表示周期に 1 枚だけ出す。
      const playout = createMediaPlayout({
        audio: { context, destination: gain },
        video: {
          output: {
            isAvailable: () => canvas.isConnected,
            present: (frame) => {
              drawing.drawImage(frame, 0, 0);
              frame.close();
              return true;
            },
          },
          pacing: { drainImmediately: false, framesPerDrain: 1 },
        },
        maxQueuedFrames: 24,
        decodeInputs: { maxTracked: 24, forgetOnDuplicate: true },
        timeOriginMs: performance.timeOrigin,
      });
      const skews: number[] = [];
      let played = 0;
      let outputClockSamples = 0;
      let stoppedExtraMs = -1;
      let restartedTargetMs = -1;
      let mediaTimeSeconds = 0;
      let recreatedContexts = 0;
      // 音声を止める前の同期の推定値 (表示の遅れと、音声・映像それぞれの遅延の内訳)
      let observedPresentationDelayMs: number | null = null;
      let observedTargetLatencyMs: number | null = null;
      let observedAudioDelayMs: number | null = null;
      let observedVideoDelayMs: number | null = null;
      try {
        for (let phase = 0; phase < 2; phase++) {
          const startMs = performance.now();
          for (let index = 0; index < 100; index++) {
            // 20 ms の連続した音声を実時間で供給する。遅れたタイマーの分を TIMESTAMP で隠さない。
            const timestamp = Math.round((performance.timeOrigin + startMs + index * 20) * 1_000);
            const samples = new Float32Array(960);
            for (let frame = 0; frame < samples.length; frame++) {
              samples[frame] = Math.sin(((index * 960 + frame) * 2 * Math.PI * 440) / 48_000) * 0.2;
            }
            const data = new AudioData({
              format: "f32",
              sampleRate: 48_000,
              numberOfFrames: 960,
              numberOfChannels: 1,
              timestamp,
              data: samples,
            });
            try {
              // 復号へ渡した時点の情報を記録してから、復号の出力を渡す
              playout.trackAudioDecodeInput(timestamp, { timestampKind: "wallClock" });
              const decision = playout.pushAudio(data);
              if (decision.status === "error") throw decision.error;
              if (decision.status === "played") played++;
              const stats = playout.getStats().avSync;
              if (stats !== null && !stats.audioClockFallback) outputClockSamples++;
            } finally {
              data.close();
            }
            // 映像も同じ入口へ渡す。復号へ渡した時点の情報を記録してから、実ブラウザの
            // VideoFrame を渡す。
            playout.trackVideoDecodeInput(timestamp, {
              timestampKind: "wallClock",
              location: { group: 0n, object: BigInt(index) },
            });
            playout.pushVideo(new VideoFrame(canvas, { timestamp }));
            if (index > 25) {
              const stats = playout.getStats().avSync;
              const skew = stats?.skewMs ?? null;
              if (skew !== null) skews.push(Math.abs(skew));
            }
            await new Promise<void>((resolve) => {
              setTimeout(resolve, Math.max(0, startMs + (index + 1) * 20 - performance.now()));
            });
          }
          // 音声を止める前の同期の推定値を控える
          const phaseAvSync = playout.getStats().avSync;
          observedPresentationDelayMs = phaseAvSync?.presentationDelayMs ?? null;
          observedTargetLatencyMs = phaseAvSync?.targetLatencyMs ?? null;
          observedAudioDelayMs = phaseAvSync?.delays.audio.presentationDelayMs ?? null;
          observedVideoDelayMs = phaseAvSync?.delays.video.presentationDelayMs ?? null;
          await playout.drainAudio();
          // 音声の再生を止める。映像の時間軸は残し、停止中も映像を進める
          playout.resetAudioStream();
          playout.resetAudio();
          const delayStats = playout.getStats().avSync;
          stoppedExtraMs = delayStats?.delays.video.syncExtraDelayMs ?? -1;
          restartedTargetMs = playout.getAudioDelayFeedback().targetMs;
          mediaTimeSeconds += element.currentTime;
          if (phase === 0) {
            // 実際のトグルと同じく Context を閉じ、別の時計原点で作り直す。
            // 停止中も映像を進め、古い音声の補償が戻らないことを確かめる。
            element.pause();
            element.srcObject = null;
            for (const track of destination.stream.getTracks()) track.stop();
            await context.close();
            for (let index = 0; index < 5; index++) {
              const timestamp = Math.round((performance.timeOrigin + performance.now()) * 1_000);
              playout.trackVideoDecodeInput(timestamp, {
                timestampKind: "wallClock",
                location: { group: 1n, object: BigInt(index) },
              });
              playout.pushVideo(new VideoFrame(canvas, { timestamp }));
              await new Promise<void>((resolve) => {
                setTimeout(resolve, 20);
              });
            }
            context = new AudioContext({ sampleRate: 48_000, latencyHint: "interactive" });
            await context.resume();
            gain = context.createGain();
            gain.gain.value = 0;
            destination = context.createMediaStreamDestination();
            gain.connect(destination);
            element.srcObject = destination.stream;
            await element.play();
            // 作った Context の出力へ差し替えてから、音声の再生の状態を作り直す
            playout.setAudioOutput({ context, destination: gain });
            playout.resetAudio();
            recreatedContexts++;
          }
        }
        skews.sort((left, right) => left - right);
        return {
          played,
          outputClockSamples,
          samples: skews.length,
          p95SkewMs: skews[Math.floor(skews.length * 0.95)],
          stoppedExtraMs,
          restartedTargetMs,
          mediaTimeSeconds,
          recreatedContexts,
          presentationDelayMs: observedPresentationDelayMs,
          targetLatencyMs: observedTargetLatencyMs,
          audioPresentationDelayMs: observedAudioDelayMs,
          videoPresentationDelayMs: observedVideoDelayMs,
        };
      } finally {
        playout.clearVideo();
        element.pause();
        element.srcObject = null;
        for (const track of destination.stream.getTracks()) track.stop();
        if (context.state !== "closed") await context.close();
      }
    },
    new URL(`/@fs${resolve("src/index.ts")}`, RELAY_PAGE_URL).href,
  );
  expect(result.played).toBe(200);
  expect(result.outputClockSamples).toBeGreaterThan(100);
  expect(result.samples).toBeGreaterThan(100);
  expect(result.mediaTimeSeconds).toBeGreaterThan(3);
  expect(result.recreatedContexts).toBe(1);
  // 5 ms の同期不感帯に、表示周期と出力時計の推定の揺れの余裕を足す。
  expect(result.p95SkewMs).toBeLessThanOrEqual(50);
  expect(result.stoppedExtraMs).toBe(0);
  expect(result.restartedTargetMs).toBe(50);
  // 同期の推定値から表示の遅れと、音声・映像それぞれの遅延の内訳を読める
  expect(result.presentationDelayMs).not.toBeNull();
  expect(typeof result.presentationDelayMs).toBe("number");
  expect(result.targetLatencyMs).toBeNull();
  expect(typeof result.audioPresentationDelayMs).toBe("number");
  expect(typeof result.videoPresentationDelayMs).toBe("number");
});

// 実ブラウザの VideoFrame (I420) を作り、trackVideoDecodeInput → pushVideo → output.present の
// 経路を jitter buffer の有無それぞれで検証する。present へ渡る表示時刻は、壁時計の
// TIMESTAMP を記録し、かつ時間軸を使うときだけ決まる。
for (const jitterBuffer of [false, true]) {
  test(`実 VideoFrame の表示経路を jitterBuffer: ${jitterBuffer} で検証する`, async ({ page }) => {
    await page.goto(RELAY_PAGE_URL);
    const result = await page.evaluate(
      async ({ moduleUrl, jitterBuffer }) => {
        const { createMediaPlayout } = (await import(
          moduleUrl
        )) as typeof import("../../src/index");
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 64;
        document.body.append(canvas);
        const drawing = canvas.getContext("2d");
        if (drawing === null) throw new Error("canvas の 2D コンテキストを作成できませんでした");
        // 表示したフレームの表示時刻 (時間軸を使わないときは null) を記録する
        const presentations: (number | null)[] = [];
        const playout = createMediaPlayout({
          video: {
            output: {
              isAvailable: () => canvas.isConnected,
              present: (frame, presentationMs) => {
                drawing.drawImage(frame, 0, 0);
                presentations.push(presentationMs);
                frame.close();
                return true;
              },
            },
          },
          jitterBuffer,
          timeOriginMs: performance.timeOrigin,
        });
        /** 実際の復号の出力と同じ形の I420 のフレームを作る */
        const createFrame = (timestamp: number): VideoFrame => {
          const width = 64;
          const height = 64;
          const luma = new Uint8Array(width * height).fill(128);
          const chroma = new Uint8Array((width / 2) * (height / 2)).fill(128);
          const data = new Uint8Array(luma.length + chroma.length + chroma.length);
          data.set(luma, 0);
          data.set(chroma, luma.length);
          data.set(chroma, luma.length + chroma.length);
          return new VideoFrame(data, {
            format: "I420",
            codedWidth: width,
            codedHeight: height,
            timestamp,
          });
        };
        /** 表示が現れるまで実時間で待つ (表示周期は requestAnimationFrame) */
        const waitForPresentations = async (count: number): Promise<void> => {
          const deadlineMs = performance.now() + 3_000;
          while (presentations.length < count && performance.now() < deadlineMs) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 10);
            });
          }
        };
        const now = Math.round((performance.timeOrigin + performance.now()) * 1_000);
        // 1 枚目: 復号へ渡した時点の情報を記録してから渡す
        playout.trackVideoDecodeInput(now, {
          timestampKind: "wallClock",
          location: { group: 0n, object: 0n },
        });
        const trackedResult = playout.pushVideo(createFrame(now));
        await waitForPresentations(1);
        const trackedPresentation = presentations[0] ?? null;
        // 2 枚目: 記録せずに渡す。種類が none になるため表示時刻を決めない
        const untrackedTimestamp = now + 20_000;
        const untrackedResult = playout.pushVideo(createFrame(untrackedTimestamp));
        await waitForPresentations(2);
        const untrackedPresentation = presentations[1] ?? null;
        const stats = playout.getStats();
        const presentedCount = presentations.length;
        // 表示待ちに残ったフレームがあれば閉じる
        playout.clearVideo();
        return {
          trackedStatus: trackedResult.status,
          untrackedStatus: untrackedResult.status,
          trackedPresentation,
          untrackedPresentation,
          presentedCount,
          queuedFrames: stats.video?.queuedFrames ?? -1,
          avSyncIsNull: stats.avSync === null,
        };
      },
      { moduleUrl: new URL(`/@fs${resolve("src/index.ts")}`, RELAY_PAGE_URL).href, jitterBuffer },
    );
    expect(result.trackedStatus).toBe("queued");
    expect(result.untrackedStatus).toBe("queued");
    expect(result.presentedCount).toBe(2);
    // 映像だけの入口は A/V 同期の推定を出さない
    expect(result.avSyncIsNull).toBe(true);
    expect(result.queuedFrames).toBe(0);
    if (jitterBuffer) {
      // 時間軸を使うときは、記録した壁時計の TIMESTAMP から表示時刻が決まる
      expect(typeof result.trackedPresentation).toBe("number");
    } else {
      // 時間軸を使わないときは、記録があっても届いた順に表示する (表示時刻は決めない)
      expect(result.trackedPresentation).toBeNull();
    }
    // 記録が無いフレームは、時間軸の有無に関わらず表示時刻を決めない
    expect(result.untrackedPresentation).toBeNull();
  });
}
