import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { RELAY_PAGE_URL } from "./urls";

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

// 実ブラウザの WebCodecs (AudioData) と Web Audio (AudioContext) だけを使い、再生の入口
// (createMediaPlayout) 経由で音声の入口・失敗・停止と時計の再開を検証する。時間軸・計器・
// 再生の組み立て・復号へ渡した入力の対応表は入口が持つため、ここでは組み立てない。
test("実 Web Audio で音声の入口、失敗、停止と時計の再開を検証する", async ({ page }) => {
  await page.goto(RELAY_PAGE_URL);
  const result = await page.evaluate(
    async (moduleUrl) => {
      const { createMediaPlayout } = (await import(moduleUrl)) as typeof import("../../src/index");
      const context = new AudioContext({ sampleRate: 48_000 });
      await context.resume();
      const gain = context.createGain();
      gain.gain.value = 0;
      gain.connect(context.destination);

      /** 実ブラウザの AudioData を作る (timestamp は Unix epoch マイクロ秒) */
      const createData = (sampleRate = 48_000): AudioData =>
        new AudioData({
          format: "f32",
          sampleRate,
          numberOfFrames: Math.round(sampleRate * 0.02),
          numberOfChannels: 1,
          timestamp: Math.round((performance.timeOrigin + performance.now()) * 1_000),
          data: new Float32Array(Math.round(sampleRate * 0.02)),
        });

      /** 実 canvas への映像の出し先を作る (present は実フレームを描いて閉じる) */
      const createCanvasOutput = () => {
        const canvas = document.createElement("canvas");
        canvas.width = 16;
        canvas.height = 16;
        document.body.append(canvas);
        const drawing = canvas.getContext("2d");
        if (drawing === null) throw new Error("canvas の 2D コンテキストを作成できませんでした");
        return {
          isAvailable: () => canvas.isConnected,
          present: (frame: VideoFrame) => {
            drawing.drawImage(frame, 0, 0);
            frame.close();
            return true;
          },
        };
      };

      /** 映像を設定した入口の共有状態と、選別・記録の対応の補いを検証する */
      const checkAudioEntrySelection = async () => {
        // 3. 映像も設定した入口では、映像をまだ観測していないため共有の基準が作られない。
        //    共有していないことと、その理由 (未観測) を遅延の内訳から読める。
        const avPlayout = createMediaPlayout({
          audio: { context, destination: gain },
          video: { output: createCanvasOutput() },
        });
        const avData = createData();
        avPlayout.trackAudioDecodeInput(avData.timestamp, { timestampKind: "wallClock" });
        const avDecision = avPlayout.pushAudio(avData);
        avData.close();
        const avSync = avPlayout.getStats().avSync;
        const avSharing =
          avSync === null
            ? null
            : {
                sharingBases: avSync.delays.sharingBases,
                unsharedReason: avSync.delays.unsharedReason,
              };
        await avPlayout.drainAudio();

        // 4. 選別 (admit) が false を返した音は鳴らさず notAdmitted を返し、時間軸へも計器へも
        //    記録しない。記録から引けた入力の情報が選別へ渡り、引けない出力は null が渡る。
        const admittedKinds: string[] = [];
        const selectingPlayout = createMediaPlayout({
          audio: {
            context,
            destination: gain,
            admit: (input) => {
              admittedKinds.push(input?.timestampKind ?? "none");
              return false;
            },
          },
        });
        const selectingData = createData();
        selectingPlayout.trackAudioDecodeInput(selectingData.timestamp, {
          timestampKind: "wallClock",
        });
        const notAdmitted = selectingPlayout.pushAudio(selectingData);
        const notAdmittedStatus = notAdmitted.status;
        const notAdmittedKind = notAdmitted.timestampKind;
        selectingData.close();
        // 記録が無い出力も選別へ渡す (入力は null)
        const unrecordedData = createData();
        const notAdmittedUnrecorded = selectingPlayout.pushAudio(unrecordedData);
        const notAdmittedUnrecordedStatus = notAdmittedUnrecorded.status;
        const notAdmittedUnrecordedKind = notAdmittedUnrecorded.timestampKind;
        unrecordedData.close();
        const notAdmittedPlayedFrames =
          selectingPlayout.getStats().audio?.timing.playedFrames ?? -1;

        // 5. 記録が対応しない出力でも、直前に分かっている種類 (LastTimestampKind) を補う。
        //    記録した TIMESTAMP から許容 (音 1 つの半分) より離れた出力は、記録を引かずに
        //    種類だけを引き継ぐ。
        const fallbackPlayout = createMediaPlayout({ audio: { context, destination: gain } });
        const fallbackBaseData = createData();
        const fallbackBaseTimestamp = fallbackBaseData.timestamp;
        fallbackPlayout.trackAudioDecodeInput(fallbackBaseTimestamp, {
          timestampKind: "wallClock",
        });
        const fallbackData = new AudioData({
          format: "f32",
          sampleRate: 48_000,
          numberOfFrames: 960,
          numberOfChannels: 1,
          // 許容 (10 ms) を超えて離し、記録との対応を引けなくする。出力を記録より前に
          // すると、resolve が古い記録を捨てる前に「直前に分かっている種類」で補う経路を通る
          timestamp: fallbackBaseTimestamp - 40_000,
          data: new Float32Array(960),
        });
        const fallbackDecision = fallbackPlayout.pushAudio(fallbackData);
        const fallbackKind = fallbackDecision.timestampKind;
        fallbackBaseData.close();
        fallbackData.close();
        await fallbackPlayout.drainAudio();

        return {
          avDecisionStatus: avDecision.status,
          avSharing,
          admittedKinds,
          notAdmittedStatus,
          notAdmittedKind,
          notAdmittedUnrecordedStatus,
          notAdmittedUnrecordedKind,
          notAdmittedPlayedFrames,
          fallbackKind,
        };
      };

      // 1. 鳴らす先が無い入口では鳴らさず、計器へも記録しない。復号の入力の記録も無いため
      //    種類は none になる。
      const silentPlayout = createMediaPlayout({ audio: {} });
      const silentData = createData();
      const skipped = silentPlayout.pushAudio(silentData);
      const skippedStatus = skipped.status;
      const skippedKind = skipped.timestampKind;
      const skippedFrames = silentPlayout.getStats().audio?.timing.playedFrames ?? -1;
      silentData.close();

      // 2. 鳴らす先を付けた入口では、記録した TIMESTAMP の種類ごとに鳴らす。音声だけの入口は
      //    揃える相手がいないため、A/V 同期の推定 (avSync) を出さない。
      const statuses: string[] = [];
      const kinds: string[] = [];
      const audioOnlyAvSync: boolean[] = [];
      for (const timestampKind of ["none", "mediaTime", "wallClock"] as const) {
        // 種類ごとに入口を作り直す (前の検証の時間軸を持ち越さない)
        const playout = createMediaPlayout({ audio: { context, destination: gain } });
        const data = createData();
        // 復号へ渡した時点の情報を記録してから、復号の出力を渡す
        playout.trackAudioDecodeInput(data.timestamp, { timestampKind });
        const decision = playout.pushAudio(data);
        statuses.push(decision.status);
        kinds.push(decision.timestampKind);
        audioOnlyAvSync.push(playout.getStats().avSync === null);
        data.close();
        await playout.drainAudio();
      }
      // 44.1 kHz の実 AudioData も、コピーから Web Audio への予約まで通す。
      const fractionalPlayout = createMediaPlayout({ audio: { context, destination: gain } });
      const fractionalData = createData(44_100);
      fractionalPlayout.trackAudioDecodeInput(fractionalData.timestamp, { timestampKind: "none" });
      const fractionalDecision = fractionalPlayout.pushAudio(fractionalData);
      statuses.push(fractionalDecision.status);
      kinds.push(fractionalDecision.timestampKind);
      const stretchingUnavailable =
        fractionalPlayout.getStats().audio?.timing.stretchUnavailableFrames ?? -1;
      fractionalData.close();
      await fractionalPlayout.drainAudio();

      // 3. 映像を設定した入口の共有状態、選別が false を返した音の扱い、記録が対応しない
      //    出力の種類の補い (LastTimestampKind) を検証する。
      const selection = await checkAudioEntrySelection();

      // 6. 壊れた入力 (close 済み AudioData) は throw せず error を返し、時間軸の観測を
      //    変えない。壊れた入力の後にも、予約の状態をリセットせず次の音を受け付ける。
      //    音声の目標の開始時刻を守る経路 (enforceTarget) を通すため、映像の相手を設定する。
      const playback = createMediaPlayout({
        audio: { context, destination: gain },
        video: { output: createCanvasOutput() },
      });
      const warmup = createData();
      playback.trackAudioDecodeInput(warmup.timestamp, { timestampKind: "none" });
      const warmupStatus = playback.pushAudio(warmup).status;
      warmup.close();
      await playback.drainAudio();
      const feedbackBefore = playback.getAudioDelayFeedback();
      const closed = createData();
      closed.close();
      const failed = playback.pushAudio(closed);
      const failedStatus = failed.status;
      const failedKind = failed.timestampKind;
      const feedbackAfterFailure = playback.getAudioDelayFeedback();
      const timelinePreserved =
        JSON.stringify(feedbackBefore) === JSON.stringify(feedbackAfterFailure);
      const closedAgain = createData();
      closedAgain.close();
      const failedAgain = playback.pushAudio(closedAgain);
      const failedAgainStatus = failedAgain.status;
      const failedAgainKind = failedAgain.timestampKind;
      const failedStats = playback.getStats();
      const errorFrames = failedStats.audio?.timing.missedByReason.error.count ?? -1;
      const missedMs = failedStats.audio?.timing.missedMs ?? -1;
      const recovered = createData();
      playback.trackAudioDecodeInput(recovered.timestamp, { timestampKind: "none" });
      const recoveredStatus = playback.pushAudio(recovered).status;
      recovered.close();
      await playback.drainAudio();

      // 7. 一時停止と再開では Context の時計を実際に止める。
      await context.suspend();
      const suspendedTime = context.currentTime;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1_000);
      });
      const remainedSuspended = context.currentTime === suspendedTime;
      await context.resume();
      // 同じ Context の再開では入口を作り直さない。古い出力の対応を残したまま代用へ移ると、
      // 停止した 1 秒分が未来の予約になって破棄される。
      const resumed = createData();
      playback.trackAudioDecodeInput(resumed.timestamp, { timestampKind: "wallClock" });
      const resumedDecision = playback.pushAudio(resumed);
      const resumedStatus = resumedDecision.status;
      const resumedStats = playback.getStats();
      const resumedClock = {
        mapping: context.getOutputTimestamp(),
        currentTime: context.currentTime,
        nowMs: performance.now(),
        lastStartDelayMs: resumedStats.audio?.timing.lastStartDelayMs ?? null,
        playedMs: resumedStats.audio?.timing.playedMs ?? null,
        feedback: playback.getAudioDelayFeedback(),
      };
      resumed.close();
      await playback.drainAudio();

      return {
        skippedStatus,
        skippedKind,
        skippedFrames,
        statuses,
        kinds,
        audioOnlyAvSync,
        ...selection,
        warmupStatus,
        failedStatus,
        failedKind,
        failedAgainStatus,
        failedAgainKind,
        timelinePreserved,
        errorFrames,
        missedMs,
        recoveredStatus,
        remainedSuspended,
        resumedStatus,
        resumedClock,
        stretchingUnavailable,
      };
    },
    new URL(`/@fs${resolve("src/index.ts")}`, RELAY_PAGE_URL).href,
  );
  expect(result.skippedStatus).toBe("skipped");
  // 復号の入力の記録が無いため、種類は none になる
  expect(result.skippedKind).toBe("none");
  expect(result.skippedFrames).toBe(0);
  expect(result.statuses).toEqual(["played", "played", "played", "played"]);
  // 記録した種類がそのまま戻り、記録の無い出力は none になる
  expect(result.kinds).toEqual(["none", "mediaTime", "wallClock", "none"]);
  // 音声だけの入口は A/V 同期の推定を出さない
  expect(result.audioOnlyAvSync).toEqual([true, true, true]);
  expect(result.avDecisionStatus).toBe("played");
  // 映像を観測していないため、共有の基準は作られない
  expect(result.avSharing?.sharingBases).toBe(false);
  expect(result.avSharing?.unsharedReason).toBe("unobserved");
  // 選別が false を返した音は鳴らさず、時間軸へも計器へも記録しない
  expect(result.admittedKinds).toEqual(["wallClock", "none"]);
  expect(result.notAdmittedStatus).toBe("notAdmitted");
  expect(result.notAdmittedKind).toBe("wallClock");
  expect(result.notAdmittedUnrecordedStatus).toBe("notAdmitted");
  expect(result.notAdmittedUnrecordedKind).toBe("none");
  expect(result.notAdmittedPlayedFrames).toBe(0);
  // 記録が対応しない出力は、直前に分かっている種類を引き継ぐ
  expect(result.fallbackKind).toBe("wallClock");
  expect(result.warmupStatus).toBe("played");
  // close 済みの AudioData は error で返り、時間軸の観測は変わらない
  expect(result.failedStatus).toBe("error");
  expect(result.failedKind).toBe("none");
  expect(result.failedAgainStatus).toBe("error");
  expect(result.failedAgainKind).toBe("none");
  expect(result.timelinePreserved).toBe(true);
  expect(result.errorFrames).toBe(2);
  expect(Number.isFinite(result.missedMs)).toBe(true);
  expect(result.recoveredStatus).toBe("played");
  expect(result.remainedSuspended).toBe(true);
  expect(result.resumedStatus, JSON.stringify(result.resumedClock)).toBe("played");
  // 44.1 kHz は加工できるため、加工できない音として数えない
  expect(result.stretchingUnavailable).toBe(0);
});

// 壁時計の観測がない音声でも、無音の穴を観測して閉ループが広げた深さ (上限 160 ms) を
// 到着基準の再生の遅れへ適用する。穴は実時間を空けて音を届けることで実ブラウザに作らせる。
for (const timestampKind of ["none", "mediaTime", "wallClock"] as const) {
  test(`壁時計の観測がない ${timestampKind} 音声にも穴で広げた深さを適用する`, async ({ page }) => {
    await page.goto(RELAY_PAGE_URL);
    const result = await page.evaluate(
      async ({ moduleUrl, timestampKind }) => {
        const { createMediaPlayout } = (await import(
          moduleUrl
        )) as typeof import("../../src/index");
        const context = new AudioContext({ sampleRate: 48_000 });
        await context.resume();
        const gain = context.createGain();
        gain.gain.value = 0;
        gain.connect(context.destination);
        // 壁時計の TIMESTAMP でも時間軸へ記録しない入口にする (壁時計の観測が無い状態)。
        // それ以外の種類はそもそも時間軸へ記録されない。
        const playout = createMediaPlayout({
          audio: { context, destination: gain },
          jitterBuffer: timestampKind !== "wallClock",
        });
        // 音の TIMESTAMP。none は decoder へ 0 を渡す経路と同じく 0 のままにする。
        const firstTimestamp =
          timestampKind === "wallClock"
            ? Math.round((performance.timeOrigin + performance.now()) * 1_000)
            : 0;
        /** 復号の入力の記録を作り、復号の出力として渡す */
        const push = (timestamp: number) => {
          const data = new AudioData({
            format: "f32",
            sampleRate: 48_000,
            numberOfFrames: 960,
            numberOfChannels: 1,
            timestamp,
            data: new Float32Array(960),
          });
          try {
            playout.trackAudioDecodeInput(timestamp, { timestampKind });
            return playout.pushAudio(data);
          } finally {
            data.close();
          }
        };
        try {
          // 実時間を空けて届ける。届かなかった区間は補間で埋まらず、無音の穴として観測される
          const first = push(firstTimestamp);
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 1_100);
          });
          const second = push(firstTimestamp + 20_000);
          // 閉ループは目標を 1 秒に 1 回まで動かす。次の制御で穴を反映させる
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 1_200);
          });
          const third = push(firstTimestamp + 40_000);
          const stats = playout.getStats();
          const timing = stats.audio?.timing ?? null;
          const feedback = playout.getAudioDelayFeedback();
          return {
            first: first.status,
            second: second.status,
            third: third.status,
            appliedMs: feedback.appliedMs,
            appliedCeilingMs: feedback.appliedCeilingMs,
            jitterTargetMs: feedback.jitterTargetMs,
            reason: feedback.reason,
            gapCount: timing?.gapCount ?? -1,
            lastStartDelayMs: timing?.lastStartDelayMs ?? -1,
            audioOnly: stats.avSync === null,
          };
        } finally {
          await context.close();
        }
      },
      { moduleUrl: new URL(`/@fs${resolve("src/index.ts")}`, RELAY_PAGE_URL).href, timestampKind },
    );
    expect(result.first).toBe("played");
    expect(result.second).toBe("played");
    expect(result.third).toBe("played");
    // 壁時計の音声を観測していないため、揺らぎの学習した目標は使われない
    expect(result.jitterTargetMs).toBe(0);
    // 音声だけの入口は A/V 同期の推定を出さない
    expect(result.audioOnly).toBe(true);
    // 無音の穴を観測し、閉ループが適用する上限を 160 ms へ広げている
    expect(result.gapCount).toBeGreaterThanOrEqual(1);
    expect(result.reason).toBe("gap");
    expect(result.appliedCeilingMs).toBe(160);
    expect(result.appliedMs).toBe(160);
    // 到着から鳴り始めるまでの遅れにも、広げた深さが使われる
    expect(result.lastStartDelayMs).toBeGreaterThanOrEqual(155);
    expect(result.lastStartDelayMs).toBeLessThan(250);
  });
}

// Context の実際の一時停止を使って、予約中に時計が進まない条件を作る。
// AudioBuffer へのコピー、補間、フェードと計器への配線を同時に通す。
test("実バッファの補間、通常の境界、並べすぎと停止の記録を検証する", async ({ page }) => {
  await page.goto(RELAY_PAGE_URL);
  const result = await page.evaluate(
    async (moduleUrl) => {
      const { createMediaPlayout } = (await import(moduleUrl)) as typeof import("../../src/index");
      const context = new AudioContext({ sampleRate: 48_000 });
      const gain = context.createGain();
      gain.gain.value = 0;
      gain.connect(context.destination);
      const playout = createMediaPlayout({ audio: { context, destination: gain } });
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
          playout.trackAudioDecodeInput(timestamp, { timestampKind: "mediaTime" });
          return playout.pushAudio(data);
        } finally {
          data.close();
        }
      };
      try {
        await context.suspend();
        const first = play(0);
        const continuous = play(20_000);
        const normalBoundary = playout.getStats().audio?.timing.boundaryStepMax ?? -1;
        const gap = play(60_000);
        const concealed = (playout.getStats().audio?.concealedMs ?? -1) / 1_000;
        const gapCount = playout.getStats().audio?.timing.gapCount ?? -1;
        const fadedBoundary = playout.getStats().audio?.timing.boundaryStepMax ?? -1;
        // 再開時に補間の材料を取り直しても、補間量の累積は引き継ぐ
        playout.resetAudio();
        playout.reset();
        play(0);
        play(40_000);
        const afterResetConcealed = (playout.getStats().audio?.concealedMs ?? -1) / 1_000;
        const statuses = Array.from(
          { length: 40 },
          (_, index) => play(60_000 + index * 20_000).status,
        );
        const backlog = playout.getStats().audio?.timing.missedByReason.backlog.count ?? -1;
        playout.recordAudioStopped();
        const stopped = playout.getStats().audio?.timing.missedByReason.stopped.ms ?? -1;
        playout.resetAudio();
        playout.reset();
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
          unavailable: playout.getStats().audio?.timing.stretchUnavailableFrames ?? -1,
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

// 実 Web Audio の予約へ時間圧縮を反映する。時間軸の目標を守る並べ方 (enforceTarget) を
// 通すため、映像の相手を設定する (音声だけの入口は到着基準で並び、目標へ詰めない)。
for (const sampleRate of [44_100, 48_000]) {
  test(`実 Web Audio の ${sampleRate} Hz の予約へ時間圧縮を反映する`, async ({ page }) => {
    await page.goto(RELAY_PAGE_URL);
    const result = await page.evaluate(
      async ({ moduleUrl, sampleRate }) => {
        const { createMediaPlayout } = (await import(
          moduleUrl
        )) as typeof import("../../src/index");
        const context = new AudioContext({ sampleRate });
        await context.resume();
        const gain = context.createGain();
        gain.gain.value = 0;
        gain.connect(context.destination);
        const canvas = document.createElement("canvas");
        canvas.width = 16;
        canvas.height = 16;
        document.body.append(canvas);
        const drawing = canvas.getContext("2d");
        if (drawing === null) throw new Error("canvas の 2D コンテキストを作成できませんでした");
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
          },
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
            const timestamp = origin + index * 20_000;
            const data = new AudioData({
              format: "f32",
              sampleRate,
              numberOfFrames: samples.length,
              numberOfChannels: 1,
              timestamp,
              data: samples,
            });
            try {
              // 受信の入口で測った入力の遅れを記録し、復号の出力として渡す
              playout.trackAudioDecodeInput(timestamp, {
                timestampKind: "wallClock",
                inputLagMs: 240 - index * 20,
              });
              statuses.push(playout.pushAudio(data).status);
            } finally {
              data.close();
            }
          }
          const stats = playout.getStats();
          return {
            statuses,
            compressedMs: stats.audio?.compressedMs ?? -1,
            playedMs: stats.audio?.timing.playedMs ?? -1,
            catchUp: stats.audio?.catchUp.catchUpStarts ?? -1,
          };
        } finally {
          await context.close();
        }
      },
      { moduleUrl: new URL(`/@fs${resolve("src/index.ts")}`, RELAY_PAGE_URL).href, sampleRate },
    );
    expect(result.statuses.every((status) => status === "played")).toBe(true);
    expect(result.compressedMs).toBeGreaterThan(0);
    // 鳴った長さは、詰めた分だけ減っている
    expect(result.playedMs).toBeCloseTo(240 - result.compressedMs, 4);
    expect(result.catchUp).toBe(0);
  });
}

// 同じ実時間の停止でも、入力経路または利用者が指定した遅延なら復号器を作り直さない。
// TIMESTAMP の順序を保ったまま実時計を待ち、入口から判定器への配線を検証する。
test("受信側の追いつきは復号だけが足した遅延で決める", async ({ page }) => {
  await page.goto(RELAY_PAGE_URL);
  const result = await page.evaluate(
    async (moduleUrl) => {
      const { createMediaPlayout } = (await import(moduleUrl)) as typeof import("../../src/index");
      const context = new AudioContext({ sampleRate: 48_000 });
      await context.resume();
      const gain = context.createGain();
      gain.gain.value = 0;
      gain.connect(context.destination);
      const cases = ["decoder", "network", "intentional", "mediaTime", "disabled"] as const;
      // 入口 (時間軸・音声の再生・計器) は購読ごとに 1 つ作る。disabled だけ時間軸を使わない
      const playouts = cases.map((kind) =>
        createMediaPlayout({
          audio: { context, destination: gain },
          jitterBuffer: kind !== "disabled",
        }),
      );
      const origin = Math.round((performance.timeOrigin + performance.now() - 20) * 1_000);
      const play = (timestamp: number, second: boolean) =>
        cases.map((kind, index) => {
          const playout = playouts[index];
          if (playout === undefined) throw new Error("再生の入口が存在すること");
          const nowMs = performance.timeOrigin + performance.now();
          const inputLagMs = second && kind === "network" ? nowMs - timestamp / 1_000 : 20;
          const intentionalDelayMs =
            second && kind === "intentional" ? nowMs - timestamp / 1_000 - 20 : 0;
          const data = new AudioData({
            format: "f32",
            sampleRate: 48_000,
            numberOfFrames: 960,
            numberOfChannels: 1,
            timestamp,
            data: new Float32Array(960),
          });
          let catchUpStarted = false;
          try {
            // 復号へ渡した時点の情報 (入力の遅れと意図した遅延) を記録し、出力として渡す
            playout.trackAudioDecodeInput(timestamp, {
              timestampKind: kind === "mediaTime" ? "mediaTime" : "wallClock",
              inputLagMs,
              intentionalDelayMs,
            });
            const decision = playout.pushAudio(data);
            catchUpStarted = "catchUpStarted" in decision && decision.catchUpStarted;
          } finally {
            data.close();
          }
          return catchUpStarted;
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
