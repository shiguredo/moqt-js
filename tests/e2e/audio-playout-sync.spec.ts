import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { RELAY_PAGE_URL } from "./urls";

/** 公開 API (src/index.ts) のモジュール URL。dev サーバーが配信するソースを直接読む */
const MODULE_URL = new URL(`/@fs${resolve("src/index.ts")}`, RELAY_PAGE_URL).href;

/** 実ブラウザの I420 フレームを作る共通ヘルパーの URL (この E2E アプリが配信する) */
const FRAME_FACTORY_URL = new URL("./playoutFrameFactory.ts", RELAY_PAGE_URL).href;

/** 期限付きで条件を待つ関数の型 (各 `page.evaluate` の中で定義して使う) */
type WaitUntil = (condition: () => boolean, timeoutMs: number) => Promise<boolean>;

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

// Web Audio と WebCodecs の実物を使い、出力時計、予約、canvas への表示までを通す。
// ネットワークの到着の揺れは別の実リレーの検証で測り、ここでは出力との同期を固定する。
// 時間軸・音声の再生・映像の表示・計器は再生の入口 (createMediaPlayout) が持つ。
test("実際の音声再生経路と canvas の表示を同期し、音声の停止と再開で状態を取り直す", async ({
  page,
}) => {
  await test.step("テストページを開く", async () => {
    await page.goto(RELAY_PAGE_URL);
  });

  const result = await test.step("実 AudioContext と実 VideoFrame で再生し、結果を集める", () =>
    page.evaluate(async (moduleUrl) => {
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
      if (drawing === null) throw new Error("failed to create the canvas 2D context");
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
      });
      const skews: number[] = [];
      let played = 0;
      let outputClockSamples = 0;
      let stoppedExtraMs = -1;
      let restartedTargetMs = -1;
      let mediaTimeSeconds = 0;
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
          // フェーズの終わり (停止の直前) に、共有している間の同期の推定値を控える
          const phaseAvSync = playout.getStats().avSync;
          observedPresentationDelayMs = phaseAvSync?.presentationDelayMs ?? null;
          observedTargetLatencyMs = phaseAvSync?.targetLatencyMs ?? null;
          observedAudioDelayMs = phaseAvSync?.delays.audio.presentationDelayMs ?? null;
          observedVideoDelayMs = phaseAvSync?.delays.video.presentationDelayMs ?? null;
          await playout.drainAudio();
          // 音声の再生を止める。映像の時間軸は残し、停止中も映像を進める
          playout.resetAudioTimeline();
          playout.resetAudioPlayback();
          const delayStats = playout.getStats().avSync;
          stoppedExtraMs = delayStats?.delays.video.syncExtraDelayMs ?? -1;
          restartedTargetMs = playout.getStats().audio?.delayFeedback.targetMs ?? -1;
          mediaTimeSeconds += element.currentTime;
          if (phase === 0) {
            // 実際のトグルと同じく Context を閉じ、別の時計原点で作り直す。古い音声の
            // 補償 (映像へ足した表示の遅れ) が戻らないことを、停止中の映像の経過と
            // 合わせて確かめる。
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
            // Context を作り直したので、新しい出力を差し替えてから音声の再生の状態を
            // 取り直す (この順でないと、旧 Context の秒で残った予約の基準が混ざる)
            playout.setAudioOutput({ context, destination: gain });
            playout.resetAudioPlayback();
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
          presentationDelayMs: observedPresentationDelayMs,
          targetLatencyMs: observedTargetLatencyMs,
          audioPresentationDelayMs: observedAudioDelayMs,
          videoPresentationDelayMs: observedVideoDelayMs,
        };
      } finally {
        playout.clearVideoQueue();
        element.pause();
        element.srcObject = null;
        for (const track of destination.stream.getTracks()) track.stop();
        if (context.state !== "closed") await context.close();
      }
    }, MODULE_URL));

  await test.step("音声と映像の同期、停止と再開の状態を検証する", () => {
    expect(result.played).toBe(200);
    expect(result.outputClockSamples).toBeGreaterThan(100);
    expect(result.samples).toBeGreaterThan(100);
    expect(result.mediaTimeSeconds).toBeGreaterThan(3);
    // 5 ms の同期不感帯に、表示周期と出力時計の推定の揺れの余裕を足す。
    expect(result.p95SkewMs).toBeLessThanOrEqual(50);
    expect(result.stoppedExtraMs).toBe(0);
    expect(result.restartedTargetMs).toBe(50);
    // 同期の推定値から表示の遅れと、音声・映像それぞれの遅延の内訳を読める
    expect(result.presentationDelayMs).toEqual(expect.any(Number));
    expect(result.audioPresentationDelayMs, "音声の表示の遅れを読めない").toBeGreaterThan(0);
    expect(result.videoPresentationDelayMs, "映像の表示の遅れを読めない").toBeGreaterThan(0);
    // catalog に targetLatency が無い購読では、既定 (null) のまま使う
    expect(result.targetLatencyMs).toBeNull();
  });
});

// 実ブラウザの VideoFrame (I420) を作り、trackVideoDecodeInput → pushVideo → output.present の
// 経路を検証する。表示の有無・後始末・表示待ちの上限は、映像だけの入口で確かめる。
test.describe("実 VideoFrame の表示経路", () => {
  // jitter buffer の有無で、present へ渡る表示時刻が変わることを確かめる。present へ渡る
  // 表示時刻は、壁時計の TIMESTAMP を記録し、かつ時間軸を使うときだけ決まる。
  for (const jitterBuffer of [false, true]) {
    const jitterBufferLabel = jitterBuffer ? "時間軸あり" : "時間軸なし";
    test(`${jitterBufferLabel}の入口で実フレームを表示する`, async ({ page }) => {
      await test.step("テストページを開く", async () => {
        await page.goto(RELAY_PAGE_URL);
      });

      const result = await test.step("実フレームを入口へ渡し、表示を待つ", () =>
        page.evaluate(
          async ({ moduleUrl, helperUrl, jitterBuffer }) => {
            const { createMediaPlayout } = (await import(
              moduleUrl
            )) as typeof import("../../src/index");
            const frameFactory = (await import(
              helperUrl
            )) as typeof import("./playoutFrameFactory");
            const canvas = document.createElement("canvas");
            canvas.width = 64;
            canvas.height = 64;
            document.body.append(canvas);
            const drawing = canvas.getContext("2d");
            if (drawing === null) throw new Error("failed to create the canvas 2D context");
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
            });
            /** 表示が現れるまで期限付きで待つ (表示周期は requestAnimationFrame) */
            const waitForPresentations = async (count: number): Promise<boolean> => {
              const deadlineMs = performance.now() + 3_000;
              while (presentations.length < count && performance.now() < deadlineMs) {
                await new Promise<void>((resolve) => {
                  setTimeout(resolve, 10);
                });
              }
              return presentations.length >= count;
            };
            const now = Math.round((performance.timeOrigin + performance.now()) * 1_000);
            // 1 枚目: 復号へ渡した時点の情報を記録してから渡す
            playout.trackVideoDecodeInput(now, {
              timestampKind: "wallClock",
              location: { group: 0n, object: 0n },
            });
            const trackedResult = playout.pushVideo(frameFactory.createI420Frame(now));
            const trackedPresented = await waitForPresentations(1);
            const trackedPresentation = presentations[0] ?? null;
            // 2 枚目: 記録せずに渡す。種類が none になるため表示時刻を決めない
            const untrackedTimestamp = now + 20_000;
            const untrackedResult = playout.pushVideo(
              frameFactory.createI420Frame(untrackedTimestamp),
            );
            const untrackedPresented = await waitForPresentations(2);
            const untrackedPresentation = presentations[1] ?? null;
            const stats = playout.getStats();
            const presentedCount = presentations.length;
            // 表示待ちに残ったフレームがあれば閉じる
            playout.clearVideoQueue();
            return {
              trackedStatus: trackedResult.status,
              untrackedStatus: untrackedResult.status,
              trackedPresented,
              untrackedPresented,
              trackedPresentation,
              untrackedPresentation,
              presentedCount,
              queuedFrames: stats.video?.queuedFrames ?? -1,
              avSyncIsNull: stats.avSync === null,
            };
          },
          { moduleUrl: MODULE_URL, helperUrl: FRAME_FACTORY_URL, jitterBuffer },
        ));

      await test.step("表示の時刻と A/V 同期の推定の有無を検証する", () => {
        expect(result.trackedStatus).toBe("queued");
        expect(result.untrackedStatus).toBe("queued");
        expect(result.trackedPresented).toBe(true);
        expect(result.untrackedPresented).toBe(true);
        expect(result.presentedCount).toBe(2);
        // 映像だけの入口は A/V 同期の推定を出さない
        expect(result.avSyncIsNull).toBe(true);
        expect(result.queuedFrames).toBe(0);
        if (jitterBuffer) {
          // 時間軸を使うときは、記録した壁時計の TIMESTAMP から表示時刻が決まる
          expect(result.trackedPresentation).toEqual(expect.any(Number));
        } else {
          // 時間軸を使わないときは、記録があっても届いた順に表示する (表示時刻は決めない)
          expect(result.trackedPresentation).toBeNull();
        }
        // 記録が無いフレームは、時間軸の有無に関わらず表示時刻を決めない
        expect(result.untrackedPresentation).toBeNull();
      });
    });
  }

  test("映像を構成していない入口は実フレームを閉じて skipped を返す", async ({ page }) => {
    await test.step("テストページを開く", async () => {
      await page.goto(RELAY_PAGE_URL);
    });

    const result = await test.step("音声だけを構成した入口へ実フレームを渡す", () =>
      page.evaluate(
        async ({ moduleUrl, helperUrl }) => {
          const { createMediaPlayout } = (await import(
            moduleUrl
          )) as typeof import("../../src/index");
          const frameFactory = (await import(helperUrl)) as typeof import("./playoutFrameFactory");
          const playout = createMediaPlayout({ audio: {} });
          const timestamp = Math.round((performance.timeOrigin + performance.now()) * 1_000);
          const frame = frameFactory.createI420Frame(timestamp);
          const decision = playout.pushVideo(frame);
          const stats = playout.getStats();
          return {
            status: decision.status,
            frameClosed: frameFactory.isFrameClosed(frame),
            videoStatsNull: stats.video === null,
            audioStatsNull: stats.audio === null,
          };
        },
        { moduleUrl: MODULE_URL, helperUrl: FRAME_FACTORY_URL },
      ));

    await test.step("フレームを閉じて skipped を返すことを検証する", () => {
      // 映像を構成していない入口は、フレームの所有権を入口が引き取って閉じる
      expect(result.status).toBe("skipped");
      expect(result.frameClosed).toBe(true);
      expect(result.videoStatsNull).toBe(true);
      // 音声は構成しているため、統計は非 null のまま
      expect(result.audioStatsNull).toBe(false);
    });
  });

  test("表示しないと決めた実フレームは閉じる", async ({ page }) => {
    await test.step("テストページを開く", async () => {
      await page.goto(RELAY_PAGE_URL);
    });

    const result = await test.step("選別と出し先を失敗させて実フレームを渡す", () =>
      page.evaluate(
        async ({ moduleUrl, helperUrl }) => {
          const { createMediaPlayout } = (await import(
            moduleUrl
          )) as typeof import("../../src/index");
          const frameFactory = (await import(helperUrl)) as typeof import("./playoutFrameFactory");
          const canvas = document.createElement("canvas");
          canvas.width = 64;
          canvas.height = 64;
          document.body.append(canvas);
          const drawing = canvas.getContext("2d");
          if (drawing === null) throw new Error("failed to create the canvas 2D context");
          const timestamp = Math.round((performance.timeOrigin + performance.now()) * 1_000);
          /** 選別 (admit) が false を返す入口 */
          const runAdmitFalse = () => {
            let presentCalls = 0;
            const admittedKinds: string[] = [];
            const playout = createMediaPlayout({
              video: {
                output: {
                  isAvailable: () => canvas.isConnected,
                  present: (frame) => {
                    presentCalls++;
                    drawing.drawImage(frame, 0, 0);
                    frame.close();
                    return true;
                  },
                },
                admit: (input) => {
                  // 記録から引けた入力は種類が、引けなかった入力は null が渡る
                  admittedKinds.push(input === null ? "null" : input.timestampKind);
                  return false;
                },
              },
            });
            playout.trackVideoDecodeInput(timestamp, {
              timestampKind: "wallClock",
              location: { group: 0n, object: 0n },
            });
            const frame = frameFactory.createI420Frame(timestamp);
            const decision = playout.pushVideo(frame);
            const result = {
              status: decision.status,
              admittedKinds,
              presentCalls,
              frameClosed: frameFactory.isFrameClosed(frame),
              queuedFrames: playout.getStats().video?.queuedFrames ?? -1,
            };
            playout.clearVideoQueue();
            return result;
          };
          /** 選別 (admit) が throw する入口 */
          const runAdmitThrow = () => {
            let presentCalls = 0;
            const playout = createMediaPlayout({
              video: {
                output: {
                  isAvailable: () => canvas.isConnected,
                  present: (frame) => {
                    presentCalls++;
                    drawing.drawImage(frame, 0, 0);
                    frame.close();
                    return true;
                  },
                },
                admit: () => {
                  throw new Error("admit callback must not throw");
                },
              },
            });
            playout.trackVideoDecodeInput(timestamp + 20_000, {
              timestampKind: "wallClock",
              location: { group: 0n, object: 1n },
            });
            const frame = frameFactory.createI420Frame(timestamp + 20_000);
            const decision = playout.pushVideo(frame);
            const result = {
              status: decision.status,
              presentCalls,
              frameClosed: frameFactory.isFrameClosed(frame),
              queuedFrames: playout.getStats().video?.queuedFrames ?? -1,
            };
            playout.clearVideoQueue();
            return result;
          };
          /** 出し先 (output.isAvailable) が throw する入口 */
          const runUnavailable = () => {
            let presentCalls = 0;
            const playout = createMediaPlayout({
              video: {
                output: {
                  isAvailable: () => {
                    throw new Error("isAvailable callback must not throw");
                  },
                  present: (frame) => {
                    presentCalls++;
                    frame.close();
                    return true;
                  },
                },
              },
            });
            playout.trackVideoDecodeInput(timestamp + 40_000, {
              timestampKind: "wallClock",
              location: { group: 0n, object: 2n },
            });
            const frame = frameFactory.createI420Frame(timestamp + 40_000);
            const decision = playout.pushVideo(frame);
            return {
              status: decision.status,
              presentCalls,
              frameClosed: frameFactory.isFrameClosed(frame),
              queuedFrames: playout.getStats().video?.queuedFrames ?? -1,
            };
          };
          return {
            admitFalse: runAdmitFalse(),
            admitThrow: runAdmitThrow(),
            unavailable: runUnavailable(),
          };
        },
        { moduleUrl: MODULE_URL, helperUrl: FRAME_FACTORY_URL },
      ));

    await test.step("表示しないフレームを閉じ、表示待ちに積まないことを検証する", () => {
      // 選別が false を返したフレームは表示せずに閉じ、表示待ちに積まない
      expect(result.admitFalse.status).toBe("notAdmitted");
      expect(result.admitFalse.admittedKinds).toEqual(["wallClock"]);
      expect(result.admitFalse.presentCalls).toBe(0);
      expect(result.admitFalse.frameClosed).toBe(true);
      expect(result.admitFalse.queuedFrames).toBe(0);
      // 選別が throw したフレームも、表示せずに閉じて skipped として返す
      expect(result.admitThrow.status).toBe("skipped");
      expect(result.admitThrow.presentCalls).toBe(0);
      expect(result.admitThrow.frameClosed).toBe(true);
      expect(result.admitThrow.queuedFrames).toBe(0);
      // 出し先が使えるかを返すコールバックが throw しても、skipped として閉じて進む
      expect(result.unavailable.status).toBe("skipped");
      expect(result.unavailable.presentCalls).toBe(0);
      expect(result.unavailable.frameClosed).toBe(true);
      expect(result.unavailable.queuedFrames).toBe(0);
    });
  });

  test("出し先が使えないときは表示待ちの実フレームを捨てる", async ({ page }) => {
    await test.step("テストページを開く", async () => {
      await page.goto(RELAY_PAGE_URL);
    });

    const result =
      await test.step("表示周期に 1 枚だけ出す設定でフレームを積み、出し先を止める", () =>
        page.evaluate(
          async ({ moduleUrl, helperUrl }) => {
            const { createMediaPlayout } = (await import(
              moduleUrl
            )) as typeof import("../../src/index");
            const frameFactory = (await import(
              helperUrl
            )) as typeof import("./playoutFrameFactory");
            let available = true;
            let presentCalls = 0;
            const playout = createMediaPlayout({
              video: {
                output: {
                  // 出し先は throw しない契約。それでも表示が止まらないよう、表示周期の中の
                  // 判定 (rAF) が throw を「出せない」として扱うことを確かめる
                  isAvailable: () => {
                    if (!available) {
                      throw new Error("isAvailable callback must not throw");
                    }
                    return true;
                  },
                  present: (frame) => {
                    presentCalls++;
                    frame.close();
                    return true;
                  },
                },
                // 表示周期に 1 枚だけ出す。積んだ時点では出さず、表示周期 (rAF) で出す
                pacing: { drainImmediately: false, framesPerDrain: 1 },
              },
            });
            const now = Math.round((performance.timeOrigin + performance.now()) * 1_000);
            // 2 枚をまとめて (表示周期が来る前に) 積む。1 枚目で基準が決まり、2 枚目は
            // 20 ms 先の表示時刻になるため、表示周期が来るまで表示待ちに残る
            const first = frameFactory.createI420Frame(now);
            const second = frameFactory.createI420Frame(now + 20_000);
            const firstDecision = playout.pushVideo(first);
            const secondDecision = playout.pushVideo(second);
            const queuedBefore = playout.getStats().video?.queuedFrames ?? -1;
            // 出し先を使えない状態にする。次の表示周期でキューが捨てられる
            available = false;
            /** 表示待ちが捨てられるまで期限付きで待つ */
            const waitUntil: WaitUntil = async (condition, timeoutMs) => {
              const deadlineMs = performance.now() + timeoutMs;
              while (performance.now() < deadlineMs) {
                if (condition()) return true;
                await new Promise<void>((resolve) => {
                  setTimeout(resolve, 10);
                });
              }
              return condition();
            };
            const queueCleared = await waitUntil(
              () => (playout.getStats().video?.queuedFrames ?? 0) === 0,
              2_000,
            );
            return {
              firstStatus: firstDecision.status,
              secondStatus: secondDecision.status,
              queuedBefore,
              queueCleared,
              queuedAfter: playout.getStats().video?.queuedFrames ?? -1,
              firstClosed: frameFactory.isFrameClosed(first),
              secondClosed: frameFactory.isFrameClosed(second),
              presentCalls,
            };
          },
          { moduleUrl: MODULE_URL, helperUrl: FRAME_FACTORY_URL },
        ));

    await test.step("表示周期の中でキューを捨てることを検証する", () => {
      expect(result.firstStatus).toBe("queued");
      expect(result.secondStatus).toBe("queued");
      expect(result.queuedBefore).toBe(2);
      expect(result.queueCleared).toBe(true);
      expect(result.queuedAfter).toBe(0);
      // 捨てたフレームは閉じる (decoder のメモリを占め続けない)
      expect(result.firstClosed).toBe(true);
      expect(result.secondClosed).toBe(true);
      // 出せないため、出し先は 1 度も呼ばない
      expect(result.presentCalls).toBe(0);
    });
  });

  test("表示待ちのキューの上限 (maxQueuedFrames) を守る", async ({ page }) => {
    await test.step("テストページを開く", async () => {
      await page.goto(RELAY_PAGE_URL);
    });

    const result = await test.step("表示周期が来る前に実フレームを上限より多く積む", () =>
      page.evaluate(
        async ({ moduleUrl, helperUrl }) => {
          const { createMediaPlayout } = (await import(
            moduleUrl
          )) as typeof import("../../src/index");
          const frameFactory = (await import(helperUrl)) as typeof import("./playoutFrameFactory");
          const maxQueuedFrames = 3;
          const playout = createMediaPlayout({
            maxQueuedFrames,
            video: {
              output: {
                isAvailable: () => true,
                present: (frame) => {
                  frame.close();
                  return true;
                },
              },
              // 表示周期が来るまで表示待ちに残すため、積んだ時点では出さない設定にする
              pacing: { drainImmediately: false, framesPerDrain: 1 },
            },
          });
          const now = Math.round((performance.timeOrigin + performance.now()) * 1_000);
          // 表示周期が来る前にまとめて積む。1 枚目で基準が決まり、2 枚目以降は 20 ms ずつ
          // 先の表示時刻になるため、表示待ちに積まれたままになる
          const frames = Array.from({ length: maxQueuedFrames + 2 }, (_, index) =>
            frameFactory.createI420Frame(now + index * 20_000),
          );
          const statuses = frames.map((frame) => playout.pushVideo(frame).status);
          const queuedFrames = playout.getStats().video?.queuedFrames ?? -1;
          const closedCount = frames.filter((frame) => frameFactory.isFrameClosed(frame)).length;
          playout.clearVideoQueue();
          return { maxQueuedFrames, statuses, queuedFrames, closedCount };
        },
        { moduleUrl: MODULE_URL, helperUrl: FRAME_FACTORY_URL },
      ));

    await test.step("上限を超えて保持せず、あふれたフレームを閉じることを検証する", () => {
      // 積むこと自体は受け付ける (あふれた分は静かに捨てる)
      expect(result.statuses.every((status) => status === "queued")).toBe(true);
      // 表示待ちは上限を超えない
      expect(result.queuedFrames).toBeLessThanOrEqual(result.maxQueuedFrames);
      expect(result.queuedFrames).toBeGreaterThan(0);
      // あふれて捨てたフレームは閉じる
      expect(result.closedCount).toBe(result.statuses.length - result.queuedFrames);
    });
  });
});

// 出し先 (output.present) は throw しない契約だが、throw したフレームを「表示した」実績として
// 同期の推定へ記録しない。音声の実績がある状態で確かめるため、このテストだけ音声も構成する。
test("出し先が throw した実フレームは表示の実績に記録しない", async ({ page }) => {
  await test.step("テストページを開く", async () => {
    await page.goto(RELAY_PAGE_URL);
  });

  const result = await test.step("音声を鳴らしてから、throw する出し先へ実フレームを渡す", () =>
    page.evaluate(
      async ({ moduleUrl, helperUrl }) => {
        const { createMediaPlayout } = (await import(
          moduleUrl
        )) as typeof import("../../src/index");
        const frameFactory = (await import(helperUrl)) as typeof import("./playoutFrameFactory");
        const context = new AudioContext({ sampleRate: 48_000 });
        await context.resume();
        const gain = context.createGain();
        gain.gain.value = 0;
        gain.connect(context.destination);
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 64;
        document.body.append(canvas);
        const drawing = canvas.getContext("2d");
        if (drawing === null) throw new Error("failed to create the canvas 2D context");
        let throwOnPresent = true;
        let presentCalls = 0;
        let presentThrows = 0;
        const playout = createMediaPlayout({
          audio: { context, destination: gain },
          video: {
            output: {
              isAvailable: () => canvas.isConnected,
              present: (frame) => {
                presentCalls++;
                if (throwOnPresent) {
                  presentThrows++;
                  throw new Error("present callback must not throw");
                }
                drawing.drawImage(frame, 0, 0);
                frame.close();
                return true;
              },
            },
          },
        });
        /** 条件が満たされるまで期限付きで待つ */
        const waitUntil: WaitUntil = async (condition, timeoutMs) => {
          const deadlineMs = performance.now() + timeoutMs;
          while (performance.now() < deadlineMs) {
            if (condition()) return true;
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 10);
            });
          }
          return condition();
        };
        /** 壁時計の音を 1 つ鳴らし、音声の表示の実績を作る */
        const playAudio = () => {
          const timestamp = Math.round((performance.timeOrigin + performance.now()) * 1_000);
          const data = new AudioData({
            format: "f32",
            sampleRate: 48_000,
            numberOfFrames: 960,
            numberOfChannels: 1,
            timestamp,
            data: new Float32Array(960),
          });
          try {
            playout.trackAudioDecodeInput(timestamp, { timestampKind: "wallClock" });
            return { status: playout.pushAudio(data).status, timestamp };
          } finally {
            data.close();
          }
        };
        try {
          const audio = playAudio();
          // 出し先が throw する状態でフレームを渡す。表示周期が来て出し先が呼ばれるまで待つ
          const badTimestamp = audio.timestamp + 20_000;
          playout.trackVideoDecodeInput(badTimestamp, {
            timestampKind: "wallClock",
            location: { group: 0n, object: 0n },
          });
          const badFrame = frameFactory.createI420Frame(badTimestamp);
          const badDecision = playout.pushVideo(badFrame);
          const badPresented = await waitUntil(
            () => presentThrows > 0 && (playout.getStats().video?.queuedFrames ?? 0) === 0,
            3_000,
          );
          const badFrameClosed = frameFactory.isFrameClosed(badFrame);
          // 音声の実績はあるが、映像の実績は作られていないため、同期の推定は出ない
          const skewAfterThrow = playout.getStats().avSync?.skewMs ?? null;
          // 対照: throw しない出し先なら、表示の実績が作られて同期の推定が出る
          throwOnPresent = false;
          const audioAgain = playAudio();
          const goodTimestamp = audioAgain.timestamp + 20_000;
          playout.trackVideoDecodeInput(goodTimestamp, {
            timestampKind: "wallClock",
            location: { group: 0n, object: 1n },
          });
          const goodFrame = frameFactory.createI420Frame(goodTimestamp);
          const goodDecision = playout.pushVideo(goodFrame);
          const skewObserved = await waitUntil(
            () => (playout.getStats().avSync?.skewMs ?? null) !== null,
            3_000,
          );
          const skewAfterGoodFrame = playout.getStats().avSync?.skewMs ?? null;
          return {
            audioStatus: audio.status,
            badStatus: badDecision.status,
            badPresented,
            badFrameClosed,
            skewAfterThrow,
            goodStatus: goodDecision.status,
            skewObserved,
            skewAfterGoodFrame,
            presentCalls,
            presentThrows,
          };
        } finally {
          // 実ブラウザのリソースはテストの終わりに必ず閉じる
          await context.close();
        }
      },
      { moduleUrl: MODULE_URL, helperUrl: FRAME_FACTORY_URL },
    ));

  await test.step("throw したフレームを表示の実績に残さないことを検証する", () => {
    expect(result.audioStatus).toBe("played");
    expect(result.badStatus).toBe("queued");
    // 出し先は呼ばれたが throw した
    expect(result.badPresented).toBe(true);
    expect(result.presentThrows).toBe(1);
    // フレームは入口が閉じる
    expect(result.badFrameClosed).toBe(true);
    // 表示の実績を作らないため、音声の実績だけでは同期の推定を出さない
    expect(result.skewAfterThrow).toBeNull();
    // 対照: 表示できたフレームは実績が作られ、同期の推定が出る
    expect(result.goodStatus).toBe("queued");
    expect(result.skewObserved).toBe(true);
    expect(result.skewAfterGoodFrame).toEqual(expect.any(Number));
    // 表示の実績は直近の 1 件だけを持つ。throw したフレームの分で上書きしない
    expect(result.presentCalls).toBe(2);
  });
});
