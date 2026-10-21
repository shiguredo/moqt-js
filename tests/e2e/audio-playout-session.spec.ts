import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { RELAY_PAGE_URL } from "./urls";

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

// AudioData、AudioBuffer、AudioBufferSourceNode はすべてブラウザの実物を使う。
// 以前の記録用出力の代わりに、Session が実際に記録した予約と失敗の計器を読む。
test("実 Web Audio で音声の入口、失敗、停止と時計の再開を検証する", async ({ page }) => {
  await page.goto(RELAY_PAGE_URL);
  const result = await page.evaluate(
    async (moduleUrl) => {
      const { AudioPlayoutSession, AudioPlayoutTimingStats, PlayoutTimeline } = (await import(
        moduleUrl
      )) as typeof import("../../src/index");
      const context = new AudioContext({ sampleRate: 48_000 });
      await context.resume();
      const gain = context.createGain();
      gain.gain.value = 0;
      gain.connect(context.destination);
      const timing = new AudioPlayoutTimingStats(10_000, performance.timeOrigin);
      const session = new AudioPlayoutSession({ timing });
      const timeline = new PlayoutTimeline({
        timeOriginMs: performance.timeOrigin,
        maxQueuedFrames: 24,
      });
      const createData = (sampleRate = 48_000): AudioData =>
        new AudioData({
          format: "f32",
          sampleRate,
          numberOfFrames: Math.round(sampleRate * 0.02),
          numberOfChannels: 1,
          timestamp: Math.round((performance.timeOrigin + performance.now()) * 1_000),
          data: new Float32Array(Math.round(sampleRate * 0.02)),
        });
      try {
        const skipped = createData();
        const skippedStatus = session.handleDecodedAudio({
          data: skipped,
          output: null,
          timeline,
          timestampKind: "wallClock",
          useTimeline: true,
          enforceTarget: true,
        }).status;
        skipped.close();
        const skippedFrames = timing.snapshot(performance.now()).playedFrames;
        const statuses: string[] = [];
        const sharing: boolean[] = [];
        for (const timestampKind of ["none", "mediaTime", "wallClock"] as const) {
          timeline.reset();
          session.reset();
          const data = createData();
          statuses.push(
            session.handleDecodedAudio({
              data,
              output: { context, destination: gain },
              timeline,
              timestampKind,
              useTimeline: true,
              enforceTarget: true,
            }).status,
          );
          sharing.push(timeline.sharingBases);
          data.close();
          await session.drainReserved();
        }
        // 44.1 kHz の実 AudioData もコピーと Web Audio への予約まで通す。
        const fractionalRate = createData(44_100);
        statuses.push(
          session.handleDecodedAudio({
            data: fractionalRate,
            output: { context, destination: gain },
            timeline,
            timestampKind: "none",
            useTimeline: true,
            enforceTarget: false,
          }).status,
        );
        fractionalRate.close();
        await session.drainReserved();
        const unavailable = timing.snapshot(performance.now()).stretchUnavailableFrames;
        // 閉じた AudioData は実 API が拒否する。createBuffer などのエラーを偽装しない。
        const closed = createData();
        closed.close();
        const failed = session.handleDecodedAudio({
          data: closed,
          output: { context, destination: gain },
          timeline,
          timestampKind: "none",
          useTimeline: true,
          enforceTarget: false,
        });
        const beforeFailedWallClock = timeline.delayBreakdown;
        const failedWallClock = session.handleDecodedAudio({
          data: closed,
          output: { context, destination: gain },
          timeline,
          timestampKind: "wallClock",
          useTimeline: true,
          enforceTarget: true,
        });
        const timelinePreserved =
          JSON.stringify(beforeFailedWallClock) === JSON.stringify(timeline.delayBreakdown);
        const errorFrames = timing.snapshot(performance.now()).missedByReason.error.count;
        const missedMs = timing.snapshot(performance.now()).missedMs;
        // 壊れた入力の後にも、予約の状態をリセットせず次の音を受け付ける。
        const recovered = createData();
        const recoveredStatus = session.handleDecodedAudio({
          data: recovered,
          output: { context, destination: gain },
          timeline,
          timestampKind: "none",
          useTimeline: true,
          enforceTarget: false,
        }).status;
        recovered.close();
        await session.drainReserved();
        // 一時停止と再開では Context の時計を実際に止める。
        await context.suspend();
        const suspendedTime = context.currentTime;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1_000);
        });
        const remainedSuspended = context.currentTime === suspendedTime;
        await context.resume();
        // 同じ Context の再開では Session をリセットしない。古い出力の対応を
        // 残したまま代用へ移ると、停止した 1 秒分が未来の予約になって破棄される。
        const resumed = createData();
        const resumedDecision = session.handleDecodedAudio({
          data: resumed,
          output: { context, destination: gain },
          timeline,
          timestampKind: "wallClock",
          useTimeline: true,
          enforceTarget: true,
        });
        const resumedStatus = resumedDecision.status;
        const resumedClock = {
          mapping: context.getOutputTimestamp(),
          currentTime: context.currentTime,
          nowMs: performance.now(),
          offsetMs: session.clock.currentOffsetMs,
          delays: timeline.delayBreakdown,
        };
        resumed.close();
        await session.drainReserved();
        return {
          skippedStatus,
          skippedFrames,
          statuses,
          sharing,
          unavailable,
          failedStatus: failed.status,
          failedWallClockStatus: failedWallClock.status,
          timelinePreserved,
          errorFrames,
          missedMs,
          recoveredStatus,
          remainedSuspended,
          resumedStatus,
          resumedClock,
        };
      } finally {
        await context.close();
      }
    },
    new URL(`/@fs${resolve("src/index.ts")}`, RELAY_PAGE_URL).href,
  );
  expect(result.skippedStatus).toBe("skipped");
  expect(result.skippedFrames).toBe(0);
  expect(result.statuses).toEqual(["played", "played", "played", "played"]);
  expect(result.sharing).toEqual([false, false, false]);
  expect(result.unavailable).toBe(0);
  expect(result.failedStatus).toBe("error");
  expect(result.failedWallClockStatus).toBe("error");
  expect(result.timelinePreserved).toBe(true);
  expect(result.errorFrames).toBe(2);
  expect(Number.isFinite(result.missedMs)).toBe(true);
  expect(result.recoveredStatus).toBe("played");
  expect(result.remainedSuspended).toBe(true);
  expect(result.resumedStatus, JSON.stringify(result.resumedClock)).toBe("played");
});

// fresh timeline のまま穴を観測させる。壁時計の音声観測を事前に足すと、TIMESTAMP が
// 無い経路で閉ループの適用値が消えていた回帰を見落とす。
for (const timestampKind of ["none", "mediaTime", "wallClock"] as const) {
  test(`壁時計の観測がない ${timestampKind} 音声にも穴で広げた深さを適用する`, async ({ page }) => {
    await page.goto(RELAY_PAGE_URL);
    const result = await page.evaluate(
      async ({ moduleUrl, timestampKind }) => {
        const { AudioPlayoutSession, AudioPlayoutTimingStats, PlayoutTimeline } = (await import(
          moduleUrl
        )) as typeof import("../../src/index");
        const context = new AudioContext({ sampleRate: 48_000 });
        await context.resume();
        const gain = context.createGain();
        gain.gain.value = 0;
        gain.connect(context.destination);
        const timing = new AudioPlayoutTimingStats(10_000, performance.timeOrigin);
        const session = new AudioPlayoutSession({ timing });
        const timeline = new PlayoutTimeline({
          timeOriginMs: performance.timeOrigin,
          maxQueuedFrames: 24,
        });
        const nowMs = performance.now();
        for (let index = 0; index < 2; index++)
          timeline.observeAudioPlayout({
            atMs: nowMs - 1_000 + index * 1_000,
            latenessMs: null,
            startDelayMs: null,
            slackMs: null,
            backlogMisses: 0,
            backlogMs: 0,
            gapCount: index,
            gapMs: index * 20,
            arrivalDelayFloorMs: 140,
          });
        const data = new AudioData({
          format: "f32",
          sampleRate: 48_000,
          numberOfFrames: 960,
          numberOfChannels: 1,
          timestamp: 0,
          data: new Float32Array(960),
        });
        try {
          const decision = session.handleDecodedAudio({
            data,
            output: { context, destination: gain },
            timeline,
            timestampKind,
            useTimeline: timestampKind !== "wallClock",
            enforceTarget: false,
            arrivalDelayFloorMs: 140,
          });
          const snapshot = timing.snapshot(performance.now());
          return {
            status: decision.status,
            startDelayMs: snapshot.lastStartDelayMs,
            baseMs: timeline.delayBreakdown.audio.baseDelayMs,
            appliedMs: timeline.playoutDelayMs,
          };
        } finally {
          data.close();
          await context.close();
        }
      },
      { moduleUrl: new URL(`/@fs${resolve("src/index.ts")}`, RELAY_PAGE_URL).href, timestampKind },
    );
    expect(result.status).toBe("played");
    expect(result.baseMs).toBeNull();
    expect(result.appliedMs).toBe(160);
    expect(result.startDelayMs).toBeGreaterThanOrEqual(155);
    expect(result.startDelayMs).toBeLessThan(250);
  });
}

// Context の実際の一時停止を使って、予約中に時計が進まない条件を作る。
// AudioBuffer へのコピー、補間、フェードと計器への配線を同時に通す。
test("実バッファの補間、通常の境界、並べすぎと停止の記録を検証する", async ({ page }) => {
  await page.goto(RELAY_PAGE_URL);
  const result = await page.evaluate(
    async (moduleUrl) => {
      const { AudioPlayoutSession, AudioPlayoutTimingStats, PlayoutTimeline } = (await import(
        moduleUrl
      )) as typeof import("../../src/index");
      const context = new AudioContext({ sampleRate: 48_000 });
      const gain = context.createGain();
      gain.gain.value = 0;
      gain.connect(context.destination);
      const timing = new AudioPlayoutTimingStats(10_000, performance.timeOrigin);
      const session = new AudioPlayoutSession({ timing });
      const timeline = new PlayoutTimeline({
        timeOriginMs: performance.timeOrigin,
        maxQueuedFrames: 24,
      });
      const play = (timestamp: number, sampleRate = 48_000) => {
        const data = new AudioData({
          format: "f32",
          sampleRate,
          numberOfFrames: sampleRate / 50,
          numberOfChannels: 1,
          timestamp,
          data: new Float32Array(sampleRate / 50).fill(0.5),
        });
        try {
          return session.handleDecodedAudio({
            data,
            output: { context, destination: gain },
            timeline,
            timestampKind: "mediaTime",
            useTimeline: true,
            enforceTarget: false,
            arrivalDelayFloorMs: 140,
          });
        } finally {
          data.close();
        }
      };
      try {
        await context.suspend();
        const first = play(0);
        const continuous = play(20_000);
        const normalBoundary = timing.snapshot(performance.now()).boundaryStepMax;
        const gap = play(60_000);
        const concealed = session.concealedSeconds;
        const gapCount = timing.snapshot(performance.now()).gapCount;
        const fadedBoundary = timing.snapshot(performance.now()).boundaryStepMax;
        // 再開時に補間の材料を取り直しても、補間量の累積は引き継ぐ。
        session.reset();
        timeline.reset();
        play(0);
        play(40_000);
        const afterResetConcealed = session.concealedSeconds;
        const statuses = Array.from(
          { length: 40 },
          (_, index) => play(60_000 + index * 20_000).status,
        );
        const backlog = timing.snapshot(performance.now()).missedByReason.backlog.count;
        session.recordStopped();
        const stopped = timing.snapshot(performance.now()).missedByReason.stopped.ms;
        session.reset();
        timeline.reset();
        const unsupported = play(0, 96_000);
        return {
          first: first.status,
          continuous: continuous.status,
          gap: gap.status,
          normalBoundary,
          concealed,
          gapCount,
          fadedBoundary,
          afterResetConcealed,
          statuses,
          backlog,
          stopped,
          unsupported: unsupported.status,
          unavailable: timing.snapshot(performance.now()).stretchUnavailableFrames,
        };
      } finally {
        await context.close();
      }
    },
    new URL(`/@fs${resolve("src/index.ts")}`, RELAY_PAGE_URL).href,
  );
  expect(result.first).toBe("played");
  expect(result.continuous).toBe("played");
  expect(result.gap).toBe("played");
  expect(result.normalBoundary).toBe(0);
  expect(result.concealed).toBeCloseTo(0.02, 5);
  expect(result.gapCount).toBe(0);
  // 補間全体の緩い減衰による 1 サンプル分の差だけを許す。継ぎ目の段差は作らない。
  expect(result.fadedBoundary).toBeLessThan(0.0001);
  expect(result.afterResetConcealed).toBeCloseTo(0.04, 5);
  expect(result.statuses).toContain("dropped");
  expect(result.backlog).toBeGreaterThan(0);
  expect(result.stopped).toBeGreaterThan(0);
  expect(result.unsupported).toBe("played");
  expect(result.unavailable).toBe(1);
});

for (const sampleRate of [44_100, 48_000]) {
  test(`実 Web Audio の ${sampleRate} Hz の予約へ時間圧縮を反映する`, async ({ page }) => {
    await page.goto(RELAY_PAGE_URL);
    const result = await page.evaluate(
      async ({ moduleUrl, sampleRate }) => {
        const { AudioPlayoutSession, AudioPlayoutTimingStats, PlayoutTimeline } = (await import(
          moduleUrl
        )) as typeof import("../../src/index");
        const context = new AudioContext({ sampleRate });
        await context.resume();
        const gain = context.createGain();
        gain.gain.value = 0;
        gain.connect(context.destination);
        const timing = new AudioPlayoutTimingStats(10_000, performance.timeOrigin);
        const session = new AudioPlayoutSession({ timing });
        const timeline = new PlayoutTimeline({
          timeOriginMs: performance.timeOrigin,
          maxQueuedFrames: 24,
        });
        try {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 40);
          });
          await context.suspend();
          const origin = Math.round((performance.timeOrigin + performance.now() - 240) * 1_000);
          const samples = Float32Array.from(
            { length: sampleRate / 50 },
            (_, index) => 0.3 * Math.sin((2 * Math.PI * 200 * index) / sampleRate),
          );
          const statuses: string[] = [];
          for (let index = 0; index < 12; index++) {
            const data = new AudioData({
              format: "f32",
              sampleRate,
              numberOfFrames: samples.length,
              numberOfChannels: 1,
              timestamp: origin + index * 20_000,
              data: samples,
            });
            try {
              statuses.push(
                session.handleDecodedAudio({
                  data,
                  output: { context, destination: gain },
                  timeline,
                  timestampKind: "wallClock",
                  useTimeline: true,
                  enforceTarget: true,
                  inputLagMs: 240 - index * 20,
                }).status,
              );
            } finally {
              data.close();
            }
          }
          return {
            statuses,
            compressed: session.compressedSeconds,
            playedMs: timing.snapshot(performance.now()).playedMs,
            catchUp: session.catchUp.snapshot().catchUpStarts,
          };
        } finally {
          await context.close();
        }
      },
      { moduleUrl: new URL(`/@fs${resolve("src/index.ts")}`, RELAY_PAGE_URL).href, sampleRate },
    );
    expect(result.statuses.every((status) => status === "played")).toBe(true);
    expect(result.compressed).toBeGreaterThan(0);
    expect(result.playedMs).toBeCloseTo(240 - result.compressed * 1_000, 4);
    expect(result.catchUp).toBe(0);
  });
}

// 同じ実時間の停止でも、入力経路または利用者が指定した遅延なら復号器を作り直さない。
// TIMESTAMP の順序を保ったまま実時計を待ち、Session から判定器への引数の配線を検証する。
test("受信側の追いつきは復号だけが足した遅延で決める", async ({ page }) => {
  await page.goto(RELAY_PAGE_URL);
  const result = await page.evaluate(
    async (moduleUrl) => {
      const { AudioPlayoutSession, AudioPlayoutTimingStats, PlayoutTimeline } = (await import(
        moduleUrl
      )) as typeof import("../../src/index");
      const context = new AudioContext({ sampleRate: 48_000 });
      const gain = context.createGain();
      gain.gain.value = 0;
      gain.connect(context.destination);
      const cases = ["decoder", "network", "intentional", "mediaTime", "disabled"] as const;
      const sessions = cases.map(
        () =>
          new AudioPlayoutSession({
            timing: new AudioPlayoutTimingStats(10_000, performance.timeOrigin),
          }),
      );
      const timelines = cases.map(
        () => new PlayoutTimeline({ timeOriginMs: performance.timeOrigin, maxQueuedFrames: 24 }),
      );
      const origin = Math.round((performance.timeOrigin + performance.now() - 20) * 1_000);
      const play = (timestamp: number, second: boolean) =>
        cases.map((kind, index) => {
          const session = sessions[index];
          const timeline = timelines[index];
          if (session === undefined || timeline === undefined)
            throw new Error("再生セッションが存在すること");
          const inputLagMs =
            second && kind === "network"
              ? performance.timeOrigin + performance.now() - timestamp / 1_000
              : 20;
          const intentionalDelayMs =
            second && kind === "intentional"
              ? performance.timeOrigin + performance.now() - timestamp / 1_000 - 20
              : 0;
          const data = new AudioData({
            format: "f32",
            sampleRate: 48_000,
            numberOfFrames: 960,
            numberOfChannels: 1,
            timestamp,
            data: new Float32Array(960),
          });
          let started = false;
          try {
            const decision = session.handleDecodedAudio({
              data,
              output: { context, destination: gain },
              timeline,
              timestampKind: kind === "mediaTime" ? "mediaTime" : "wallClock",
              useTimeline: kind !== "disabled",
              enforceTarget: true,
              inputLagMs,
              intentionalDelayMs,
            });
            started = "catchUpStarted" in decision && decision.catchUpStarted;
          } finally {
            data.close();
          }
          return started;
        });
      try {
        await context.suspend();
        const first = play(origin, false);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 200);
        });
        const second = play(origin + 20_000, true);
        return { first, second };
      } finally {
        await context.close();
      }
    },
    new URL(`/@fs${resolve("src/index.ts")}`, RELAY_PAGE_URL).href,
  );
  expect(result.first).toEqual([false, false, false, false, false]);
  expect(result.second).toEqual([true, false, false, false, false]);
});
