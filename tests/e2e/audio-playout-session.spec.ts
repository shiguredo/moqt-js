import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { RELAY_PAGE_URL } from "./urls";

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

/** 公開 API (src/index.ts) のモジュール URL。dev サーバーが配信するソースを直接読む */
const MODULE_URL = new URL(`/@fs${resolve("src/index.ts")}`, RELAY_PAGE_URL).href;

/** 音声の TIMESTAMP の種類の表示名 (テスト名と失敗メッセージを読者向けにする) */
const AUDIO_TIMESTAMP_KIND_LABELS = {
  none: "TIMESTAMP 無し",
  mediaTime: "メディア時刻",
  wallClock: "壁時計",
} as const;

// 実ブラウザの WebCodecs (AudioData) と Web Audio (AudioContext) だけを使い、再生の入口
// (createMediaPlayout) 経由で音声の入口と統計を検証する。時間軸・計器・再生の組み立て・
// 復号へ渡した入力の対応表は入口が持つため、ここでは組み立てない。
test("実 Web Audio で音声の入口、TIMESTAMP の種類、統計を検証する", async ({ page }) => {
  await test.step("テストページを開く", async () => {
    await page.goto(RELAY_PAGE_URL);
  });

  const result = await test.step("実 AudioContext と再生の入口へ音を渡し、結果を集める", () =>
    page.evaluate(async (moduleUrl) => {
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
        if (drawing === null) throw new Error("failed to create the canvas 2D context");
        return {
          isAvailable: () => canvas.isConnected,
          present: (frame: VideoFrame) => {
            drawing.drawImage(frame, 0, 0);
            frame.close();
            return true;
          },
        };
      };

      try {
        // 1. 鳴らす先が無い入口では鳴らさず、計器へも記録しない。復号の入力の記録も無いため
        //    種類は none になる。
        const silentPlayout = createMediaPlayout({ audio: {} });
        const silentData = createData();
        const skipped = silentPlayout.pushAudio(silentData);
        const skippedStatus = skipped.status;
        const skippedKind = skipped.timestampKind;
        const skippedPlayedFrames = silentPlayout.getStats().audio?.timing.playedFrames ?? -1;
        silentData.close();

        // 2. 鳴らす先を付けた入口では、記録した TIMESTAMP の種類ごとに鳴らす。音声だけの入口は
        //    揃える相手がいないため、A/V 同期の推定 (avSync) を出さない。44.1 kHz の音も
        //    同じ入口で、コピーから Web Audio への予約まで通す。
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
        fractionalPlayout.trackAudioDecodeInput(fractionalData.timestamp, {
          timestampKind: "none",
        });
        const fractionalDecision = fractionalPlayout.pushAudio(fractionalData);
        statuses.push(fractionalDecision.status);
        kinds.push(fractionalDecision.timestampKind);
        const stretchingUnavailable =
          fractionalPlayout.getStats().audio?.timing.stretchUnavailableFrames ?? -1;
        fractionalData.close();
        await fractionalPlayout.drainAudio();

        // 3. 音声を構成していても鳴らす先が無い入口では、選別 (admit) は呼ばれるが、結果は
        //    skipped が優先される (notAdmitted にしない)。選別を飛ばすと、呼び出し側が選別に
        //    持たせている追いつきの状態を進める副作用が落ちる。
        let unoutputAdmitCalls = 0;
        const unoutputPlayout = createMediaPlayout({
          audio: {
            admit: () => {
              unoutputAdmitCalls++;
              return false;
            },
          },
        });
        const unoutputData = createData();
        unoutputPlayout.trackAudioDecodeInput(unoutputData.timestamp, {
          timestampKind: "wallClock",
        });
        const unoutputDecision = unoutputPlayout.pushAudio(unoutputData);
        const unoutputStatus = unoutputDecision.status;
        const unoutputKind = unoutputDecision.timestampKind;
        const unoutputPlayedFrames = unoutputPlayout.getStats().audio?.timing.playedFrames ?? -1;
        unoutputData.close();

        // 4. 音声を構成していない入口 (映像だけ) へ復号した音を渡しても throw せず、skipped を
        //    返す。AudioData の所有権は呼び出し側に残るため、入口は閉じない。
        const videoOnlyPlayout = createMediaPlayout({ video: { output: createCanvasOutput() } });
        const videoOnlyData = createData();
        const videoOnlyDecision = videoOnlyPlayout.pushAudio(videoOnlyData);
        const videoOnlyStatus = videoOnlyDecision.status;
        const videoOnlyKind = videoOnlyDecision.timestampKind;
        // 閉じていれば寸法が 0 になる (実ブラウザの AudioData.close())。読めることを確かめる
        const videoOnlyDataFrames = videoOnlyData.numberOfFrames;
        const videoOnlyDataSampleRate = videoOnlyData.sampleRate;
        videoOnlyData.close();
        const videoOnlyAudioStatsNull = videoOnlyPlayout.getStats().audio === null;

        return {
          skippedStatus,
          skippedKind,
          skippedPlayedFrames,
          statuses,
          kinds,
          audioOnlyAvSync,
          stretchingUnavailable,
          unoutputStatus,
          unoutputKind,
          unoutputAdmitCalls,
          unoutputPlayedFrames,
          videoOnlyStatus,
          videoOnlyKind,
          videoOnlyDataFrames,
          videoOnlyDataSampleRate,
          videoOnlyAudioStatsNull,
        };
      } finally {
        // 実ブラウザのリソースはテストの終わりに必ず閉じる
        await context.close();
      }
    }, MODULE_URL));

  await test.step("音声の入口と TIMESTAMP の種類、統計を検証する", () => {
    // 1. 鳴らす先が無い入口は skipped を返し、計器へも記録しない
    expect(result.skippedStatus).toBe("skipped");
    // 復号の入力の記録が無いため、種類は none になる
    expect(result.skippedKind).toBe("none");
    expect(result.skippedPlayedFrames).toBe(0);
    // 2. 鳴らす先のある入口は、記録した種類ごとに鳴らす
    expect(result.statuses).toEqual(["played", "played", "played", "played"]);
    // 記録した種類がそのまま戻り、記録の無い出力は none になる
    expect(result.kinds).toEqual(["none", "mediaTime", "wallClock", "none"]);
    // 音声だけの入口は A/V 同期の推定を出さない
    expect(result.audioOnlyAvSync).toEqual([true, true, true]);
    // 44.1 kHz は加工できるため、加工できない音として数えない
    expect(result.stretchingUnavailable).toBe(0);
    // 3. 鳴らす先が無くても選別は呼ばれるが、結果は skipped が優先される
    expect(result.unoutputStatus).toBe("skipped");
    expect(result.unoutputKind).toBe("wallClock");
    expect(result.unoutputAdmitCalls).toBe(1);
    expect(result.unoutputPlayedFrames).toBe(0);
    // 4. 音声を構成していない入口は、音を閉じずに skipped を返す
    expect(result.videoOnlyStatus).toBe("skipped");
    expect(result.videoOnlyKind).toBe("none");
    expect(result.videoOnlyDataFrames).toBe(960);
    expect(result.videoOnlyDataSampleRate).toBe(48_000);
    expect(result.videoOnlyAudioStatsNull).toBe(true);
  });
});

// 実ブラウザの音と映像の実物を使い、選別 (admit) と、揃える相手 (hasCounterpart) の扱い、
// 復号へ渡した入力の対応の補いを検証する。コールバックは throw しない契約であり、
// throw した場合は入口が状態を壊さず結果 (status: "error") として返す。
test("実 Web Audio で音の選別、コールバックの失敗、記録の補いを検証する", async ({ page }) => {
  await test.step("テストページを開く", async () => {
    await page.goto(RELAY_PAGE_URL);
  });

  const result = await test.step("実 AudioContext と再生の入口で検証し、結果を集める", () =>
    page.evaluate(async (moduleUrl) => {
      const { createMediaPlayout } = (await import(moduleUrl)) as typeof import("../../src/index");
      const context = new AudioContext({ sampleRate: 48_000 });
      await context.resume();
      const gain = context.createGain();
      gain.gain.value = 0;
      gain.connect(context.destination);

      /** 実ブラウザの AudioData を作る (timestamp は Unix epoch マイクロ秒) */
      const createData = (): AudioData =>
        new AudioData({
          format: "f32",
          sampleRate: 48_000,
          numberOfFrames: 960,
          numberOfChannels: 1,
          timestamp: Math.round((performance.timeOrigin + performance.now()) * 1_000),
          data: new Float32Array(960),
        });

      /** 実 canvas への映像の出し先を作る (present は実フレームを描いて閉じる) */
      const createCanvasOutput = () => {
        const canvas = document.createElement("canvas");
        canvas.width = 16;
        canvas.height = 16;
        document.body.append(canvas);
        const drawing = canvas.getContext("2d");
        if (drawing === null) throw new Error("failed to create the canvas 2D context");
        return {
          isAvailable: () => canvas.isConnected,
          present: (frame: VideoFrame) => {
            drawing.drawImage(frame, 0, 0);
            frame.close();
            return true;
          },
        };
      };

      try {
        // 1. 映像も設定した入口では、映像をまだ観測していないため共有の基準が作られない。
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

        // 2. 選別 (admit) が false を返した音は鳴らさず notAdmitted を返し、時間軸へも計器へも
        //    記録しない。記録から引けた入力の情報が選別へ渡り、引けない出力は「記録から
        //    引けなかった」ことを確かめられるよう null として記録する。
        const admittedKinds: string[] = [];
        const selectingPlayout = createMediaPlayout({
          audio: {
            context,
            destination: gain,
            admit: (input) => {
              // null を "none" と混ぜると、種類が無い記録と引けなかった記録を区別できない
              admittedKinds.push(input === null ? "null" : input.timestampKind);
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
        // 時間軸へも計器へも記録していないことを、鳴った量だけでなく鳴らなかった量と
        // 直近の欠落の一覧からも確かめる
        const notAdmittedTiming = selectingPlayout.getStats().audio?.timing ?? null;
        const notAdmittedPlayedFrames = notAdmittedTiming?.playedFrames ?? -1;
        const notAdmittedMissedFrames = notAdmittedTiming?.missedFrames ?? -1;
        const notAdmittedRecentMisses = notAdmittedTiming?.recentMisses ?? null;

        // 3. 記録が対応しない出力でも、直前に分かっている種類 (LastTimestampKind) を補う。
        //    記録した TIMESTAMP から許容 (音 1 つの半分) より離れた出力は、記録を引かずに
        //    種類だけを引き継ぐ。選別へ null が渡ることで、対応を引けずに種類を補った
        //    経路を実際に通ったと区別できる (種類が戻るだけでは、対応を引けた場合と
        //    区別できない)。
        const fallbackAdmitInputs: string[] = [];
        const fallbackPlayout = createMediaPlayout({
          audio: {
            context,
            destination: gain,
            admit: (input) => {
              fallbackAdmitInputs.push(input === null ? "null" : input.timestampKind);
              return true;
            },
          },
        });
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
        const fallbackStatus = fallbackDecision.status;
        fallbackBaseData.close();
        fallbackData.close();
        await fallbackPlayout.drainAudio();

        // 4. 選別 (admit) が throw しても状態を壊さず error を返す。AudioData は入口が閉じない
        //    (所有権は呼び出し側に残る) ため、呼び出し側が finally で閉じる。
        const throwingAdmitPlayout = createMediaPlayout({
          audio: {
            context,
            destination: gain,
            admit: () => {
              throw new Error("admit callback must not throw");
            },
          },
        });
        const throwingAdmitData = createData();
        throwingAdmitPlayout.trackAudioDecodeInput(throwingAdmitData.timestamp, {
          timestampKind: "wallClock",
        });
        const throwingAdmitDecision = throwingAdmitPlayout.pushAudio(throwingAdmitData);
        const throwingAdmitStatus = throwingAdmitDecision.status;
        const throwingAdmitMessage =
          throwingAdmitDecision.status === "error" ? throwingAdmitDecision.error.message : null;
        // 入口が閉じていないことを、実ブラウザで読める寸法で確かめる
        // (閉じていれば 0 になるため、0 でないことを見る)
        const throwingAdmitDataFrames = throwingAdmitData.numberOfFrames;
        throwingAdmitData.close();
        // 鳴らす前の失敗なので、計器へ鳴った / 鳴らなかったとして記録しない
        const throwingAdmitTiming = throwingAdmitPlayout.getStats().audio?.timing ?? null;
        const throwingAdmitPlayedFrames = throwingAdmitTiming?.playedFrames ?? -1;
        const throwingAdmitMissedFrames = throwingAdmitTiming?.missedFrames ?? -1;

        // 5. 揃える相手 (hasCounterpart) が throw しても状態を壊さず error を返す
        const throwingCounterpartPlayout = createMediaPlayout({
          audio: {
            context,
            destination: gain,
            hasCounterpart: () => {
              throw new Error("hasCounterpart callback must not throw");
            },
          },
          video: { output: createCanvasOutput() },
        });
        const throwingCounterpartData = createData();
        throwingCounterpartPlayout.trackAudioDecodeInput(throwingCounterpartData.timestamp, {
          timestampKind: "wallClock",
        });
        const throwingCounterpartDecision =
          throwingCounterpartPlayout.pushAudio(throwingCounterpartData);
        const throwingCounterpartStatus = throwingCounterpartDecision.status;
        const throwingCounterpartMessage =
          throwingCounterpartDecision.status === "error"
            ? throwingCounterpartDecision.error.message
            : null;
        throwingCounterpartData.close();

        // 6. 揃える相手 (映像) の有無で、音の並べ方が変わる。揃える相手がいないときは到着基準に
        //    なり、音声だけの下限 (140 ms) を足す。300 ms 古い壁時計の音を 1 つ渡し、
        //    到着から鳴り始めるまでの遅れで区別する。呼ばれた回数も数える (push ごとに 1 回)。
        /** 300 ms 古い壁時計の音を 1 つ渡して、その結果を返す */
        const pushOldAudio = (hasCounterpart: () => boolean) => {
          let counterpartCalls = 0;
          const playout = createMediaPlayout({
            audio: {
              context,
              destination: gain,
              hasCounterpart: () => {
                counterpartCalls++;
                return hasCounterpart();
              },
            },
            video: { output: createCanvasOutput() },
          });
          const timestamp = Math.round((performance.timeOrigin + performance.now() - 300) * 1_000);
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
            const decision = playout.pushAudio(data);
            const timing = playout.getStats().audio?.timing ?? null;
            return {
              status: decision.status,
              counterpartCalls,
              lastStartDelayMs: timing?.lastStartDelayMs ?? -1,
            };
          } finally {
            data.close();
          }
        };
        const withoutCounterpart = pushOldAudio(() => false);
        const withCounterpart = pushOldAudio(() => true);

        return {
          avDecisionStatus: avDecision.status,
          avSharing,
          admittedKinds,
          notAdmittedStatus,
          notAdmittedKind,
          notAdmittedUnrecordedStatus,
          notAdmittedUnrecordedKind,
          notAdmittedPlayedFrames,
          notAdmittedMissedFrames,
          notAdmittedRecentMisses,
          fallbackKind,
          fallbackStatus,
          fallbackAdmitInputs,
          throwingAdmitStatus,
          throwingAdmitMessage,
          throwingAdmitDataFrames,
          throwingAdmitPlayedFrames,
          throwingAdmitMissedFrames,
          throwingCounterpartStatus,
          throwingCounterpartMessage,
          withoutCounterpart,
          withCounterpart,
        };
      } finally {
        // 実ブラウザのリソースはテストの終わりに必ず閉じる
        await context.close();
      }
    }, MODULE_URL));

  await test.step("選別とコールバックの失敗、記録の補いを検証する", () => {
    // 1. 映像を観測していないため、共有の基準は作られない
    expect(result.avDecisionStatus).toBe("played");
    expect(result.avSharing?.sharingBases).toBe(false);
    expect(result.avSharing?.unsharedReason).toBe("unobserved");
    // 2. 選別が false を返した音は鳴らさず、時間軸へも計器へも記録しない。
    //    記録から引けなかった音は、種類を none と混ぜず null として渡る
    expect(result.admittedKinds).toEqual(["wallClock", "null"]);
    expect(result.notAdmittedStatus).toBe("notAdmitted");
    expect(result.notAdmittedKind).toBe("wallClock");
    expect(result.notAdmittedUnrecordedStatus).toBe("notAdmitted");
    expect(result.notAdmittedUnrecordedKind).toBe("none");
    expect(result.notAdmittedPlayedFrames).toBe(0);
    expect(result.notAdmittedMissedFrames).toBe(0);
    expect(result.notAdmittedRecentMisses).toEqual([]);
    // 3. 記録が対応しない出力は、直前に分かっている種類を引き継ぐ。選別へ null が渡ることで、
    //    対応を引けずに種類を補った経路を通ったと区別できる
    expect(result.fallbackKind).toBe("wallClock");
    expect(result.fallbackStatus).toBe("played");
    expect(result.fallbackAdmitInputs).toEqual(["null"]);
    // 4. 選別が throw しても error として返し、鳴った / 鳴らなかったとして記録しない
    expect(result.throwingAdmitStatus).toBe("error");
    expect(result.throwingAdmitMessage).toBe("admit callback must not throw");
    expect(result.throwingAdmitPlayedFrames).toBe(0);
    expect(result.throwingAdmitMissedFrames).toBe(0);
    // 5. 揃える相手の判定が throw しても error として返す
    expect(result.throwingCounterpartStatus).toBe("error");
    expect(result.throwingCounterpartMessage).toBe("hasCounterpart callback must not throw");
    // 6. 揃える相手がいないときだけ、到着基準の下限 (140 ms) を足す。判定は push ごとに 1 回
    expect(result.withoutCounterpart.status).toBe("played");
    expect(result.withoutCounterpart.counterpartCalls).toBe(1);
    expect(result.withoutCounterpart.lastStartDelayMs).toBeGreaterThanOrEqual(120);
    expect(result.withCounterpart.status).toBe("played");
    expect(result.withCounterpart.counterpartCalls).toBe(1);
    // 揃える相手がいれば目標の開始時刻を守るため、到着基準の下限は足されない
    expect(result.withCounterpart.lastStartDelayMs).toBeLessThan(
      result.withoutCounterpart.lastStartDelayMs,
    );
  });
});

// 実 web Audio の一時停止と再開、そして close 済みの AudioData を使い、壊れた入力が
// 時間軸の観測を変えずに error として返ること、その後も次の音を受け付けることを検証する。
test("実 Web Audio で壊れた音の入力、停止と時計の再開を検証する", async ({ page }) => {
  await test.step("テストページを開く", async () => {
    await page.goto(RELAY_PAGE_URL);
  });

  const result = await test.step("実 AudioContext と再生の入口で検証し、結果を集める", () =>
    page.evaluate(async (moduleUrl) => {
      const { createMediaPlayout } = (await import(moduleUrl)) as typeof import("../../src/index");
      const context = new AudioContext({ sampleRate: 48_000 });
      await context.resume();
      const gain = context.createGain();
      gain.gain.value = 0;
      gain.connect(context.destination);

      /** 実ブラウザの AudioData を作る (timestamp は Unix epoch マイクロ秒) */
      const createData = (): AudioData =>
        new AudioData({
          format: "f32",
          sampleRate: 48_000,
          numberOfFrames: 960,
          numberOfChannels: 1,
          timestamp: Math.round((performance.timeOrigin + performance.now()) * 1_000),
          data: new Float32Array(960),
        });

      /** 実 canvas への映像の出し先を作る (present は実フレームを描いて閉じる) */
      const createCanvasOutput = () => {
        const canvas = document.createElement("canvas");
        canvas.width = 16;
        canvas.height = 16;
        document.body.append(canvas);
        const drawing = canvas.getContext("2d");
        if (drawing === null) throw new Error("failed to create the canvas 2D context");
        return {
          isAvailable: () => canvas.isConnected,
          present: (frame: VideoFrame) => {
            drawing.drawImage(frame, 0, 0);
            frame.close();
            return true;
          },
        };
      };

      // 音声の目標の開始時刻を守る経路 (揃える相手がいる) を通すため、映像も設定する
      const playback = createMediaPlayout({
        audio: { context, destination: gain },
        video: { output: createCanvasOutput() },
      });

      try {
        // 1. 壁時計の観測を 1 つ作り、時間軸の遅延の内訳に観測値が入った状態にする。
        //    この状態を「壊れた入力の前後で変わらない」ことの比較元にする。
        const warmup = createData();
        playback.trackAudioDecodeInput(warmup.timestamp, { timestampKind: "wallClock" });
        const warmupStatus = playback.pushAudio(warmup).status;
        warmup.close();
        await playback.drainAudio();
        const delaysBeforeFailure = playback.getStats().avSync?.delays ?? null;
        // 実質的な観測 (音声の基準の遅れ) が入っていることを、単なる非 null ではなく値で確かめる
        const audioBaseDelayObserved = delaysBeforeFailure?.audio.baseDelayMs ?? null;

        // 2. 壊れた入力 (close 済み AudioData) は throw せず error を返し、時間軸の観測
        //    (遅延の内訳) を変えない。閉じた AudioData でも timestamp だけは読める (実測:
        //    Chromium)。その timestamp を壁時計として先に記録しておくと、失敗は「時間軸へ
        //    記録する種類 (壁時計)」の経路で起きる。
        const closed = createData();
        const closedTimestamp = closed.timestamp;
        playback.trackAudioDecodeInput(closedTimestamp, { timestampKind: "wallClock" });
        closed.close();
        const failed = playback.pushAudio(closed);
        const failedStatus = failed.status;
        const failedKind = failed.timestampKind;
        const closedAgain = createData();
        const closedAgainTimestamp = closedAgain.timestamp;
        playback.trackAudioDecodeInput(closedAgainTimestamp, { timestampKind: "wallClock" });
        closedAgain.close();
        const failedAgain = playback.pushAudio(closedAgain);
        const failedAgainStatus = failedAgain.status;
        const failedAgainKind = failedAgain.timestampKind;
        const failedStats = playback.getStats();
        const delaysAfterFailure = failedStats.avSync?.delays ?? null;
        const timelinePreserved =
          delaysBeforeFailure !== null &&
          JSON.stringify(delaysBeforeFailure) === JSON.stringify(delaysAfterFailure);
        // 失敗した 2 つの音は、長さが読めないため 0 ms として「鳴らなかった」に数える
        const missedFrames = failedStats.audio?.timing.missedFrames ?? -1;
        const errorFrames = failedStats.audio?.timing.missedByReason.error.count ?? -1;
        const missedMs = failedStats.audio?.timing.missedMs ?? -1;

        // 3. 壊れた入力の後にも、予約の状態をリセットせず次の音を受け付ける
        const recovered = createData();
        playback.trackAudioDecodeInput(recovered.timestamp, { timestampKind: "none" });
        const recoveredStatus = playback.pushAudio(recovered).status;
        recovered.close();
        await playback.drainAudio();

        // 4. 一時停止と再開では Context の時計を実際に止める
        await context.suspend();
        const suspendedTime = context.currentTime;
        // 停止中に時計が進まないことを、期限付きの待ちで確かめる。実時間を空ける必要が
        // ある待ちであり、条件 (経過した時間) は実時間でしか満たせない
        const suspendStartedMs = performance.now();
        const suspendedForMs = 1_000;
        while (performance.now() - suspendStartedMs < suspendedForMs) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 10);
          });
        }
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
          delayFeedback: resumedStats.audio?.delayFeedback ?? null,
        };
        resumed.close();
        await playback.drainAudio();

        return {
          warmupStatus,
          audioBaseDelayObserved,
          failedStatus,
          failedKind,
          failedAgainStatus,
          failedAgainKind,
          timelinePreserved,
          missedFrames,
          errorFrames,
          missedMs,
          recoveredStatus,
          remainedSuspended,
          resumedStatus,
          resumedClock,
        };
      } finally {
        // 実ブラウザのリソースはテストの終わりに必ず閉じる
        await context.close();
      }
    }, MODULE_URL));

  await test.step("壊れた入力と停止・時計の再開を検証する", () => {
    expect(result.warmupStatus).toBe("played");
    // 比較元に、実際の観測値 (音声の基準の遅れ) が入っている (単なる非 null では弱い)
    expect(result.audioBaseDelayObserved).not.toBeNull();
    // close 済みの AudioData は error で返り、時間軸の観測は変わらない
    expect(result.failedStatus).toBe("error");
    // 閉じた AudioData でも timestamp は読めるため、記録した壁時計の種類で失敗する
    expect(result.failedKind).toBe("wallClock");
    expect(result.failedAgainStatus).toBe("error");
    expect(result.failedAgainKind).toBe("wallClock");
    expect(result.timelinePreserved).toBe(true);
    // 鳴らなかった 2 つの音は件数で数え、長さは読めないため 0 ms になる
    expect(result.missedFrames).toBe(2);
    expect(result.errorFrames).toBe(2);
    expect(result.missedMs).toBe(0);
    // 壊れた入力の後にも次の音を受け付ける
    expect(result.recoveredStatus).toBe("played");
    // 一時停止中は時計が進まず、再開後は同じ入口のまま鳴らせる
    expect(result.remainedSuspended).toBe(true);
    expect(result.resumedStatus, JSON.stringify(result.resumedClock)).toBe("played");
  });
});

// 壁時計の観測がない音声でも、無音の穴を観測して閉ループが広げた深さ (上限 160 ms) を
// 到着基準の再生の遅れへ適用する。穴は実時間を空けて音を届けることで実ブラウザに作らせる。
// 待ちは固定の時間ではなく、再生の進みと閉ループの制御間隔という条件を期限付きで待つ。
for (const timestampKind of ["none", "mediaTime", "wallClock"] as const) {
  const timestampKindLabel = AUDIO_TIMESTAMP_KIND_LABELS[timestampKind];
  test(`壁時計の観測がない (${timestampKindLabel}) 音声にも穴で広げた深さを適用する`, async ({
    page,
  }) => {
    await test.step("テストページを開く", async () => {
      await page.goto(RELAY_PAGE_URL);
    });

    const result = await test.step("実時間を空けて音を届け、閉ループの結果を集める", () =>
      page.evaluate(
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
          /**
           * 条件が満たされるまで実時間で待つ
           *
           * 固定の時間で眠らず、期限を決めて条件を待つ。期限を過ぎたら false を返し、
           * 呼び出し側が失敗として扱えるようにする。
           */
          const waitUntil = async (
            condition: () => boolean,
            timeoutMs: number,
          ): Promise<boolean> => {
            const deadlineMs = performance.now() + timeoutMs;
            while (performance.now() < deadlineMs) {
              if (condition()) return true;
              await new Promise<void>((resolve) => {
                setTimeout(resolve, 10);
              });
            }
            return condition();
          };
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
            // 実時間を空けて届ける。届かなかった区間は補間で埋まらず、無音の穴として
            // 観測される。最初の音が鳴り終わるまでを、AudioContext の時計の進みで待つ
            const first = push(firstTimestamp);
            const firstContextSeconds = context.currentTime;
            const firstPlayedOut = await waitUntil(
              () => context.currentTime - firstContextSeconds >= 1,
              5_000,
            );
            const second = push(firstTimestamp + 20_000);
            // 閉ループは目標を 1 秒に 1 回まで動かす。次の制御が可能になるまで待つ
            const secondPushedAtMs = performance.now();
            const controlIntervalElapsed = await waitUntil(
              () => performance.now() - secondPushedAtMs >= 1_050,
              3_000,
            );
            const third = push(firstTimestamp + 40_000);
            const stats = playout.getStats();
            const timing = stats.audio?.timing ?? null;
            // 音声だけの入口でも、計器から目標遅延の閉ループの内訳を読める
            const delayFeedback = stats.audio?.delayFeedback ?? null;
            return {
              firstPlayedOut,
              controlIntervalElapsed,
              first: first.status,
              second: second.status,
              third: third.status,
              appliedMs: delayFeedback?.appliedMs ?? -1,
              appliedCeilingMs: delayFeedback?.appliedCeilingMs ?? -1,
              jitterTargetMs: delayFeedback?.jitterTargetMs ?? -1,
              reason: delayFeedback?.reason ?? null,
              gapCount: timing?.gapCount ?? -1,
              lastStartDelayMs: timing?.lastStartDelayMs ?? -1,
              audioOnly: stats.avSync === null,
            };
          } finally {
            // 実ブラウザのリソースはテストの終わりに必ず閉じる
            await context.close();
          }
        },
        { moduleUrl: MODULE_URL, timestampKind },
      ));

    await test.step("穴で広げた深さが到着基準の再生の遅れへ適用されることを検証する", () => {
      // 実時間の待ちが期限の中で満たされた (穴を作るための再生の進み)
      expect(result.firstPlayedOut).toBe(true);
      expect(result.controlIntervalElapsed).toBe(true);
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
  });
}

// Context の実際の一時停止を使って、予約中に時計が進まない条件を作る。
// AudioBuffer へのコピー、補間、フェードと計器への配線を同時に通す。
test("実バッファの補間、通常の境界、並べすぎと停止の記録を検証する", async ({ page }) => {
  await test.step("テストページを開く", async () => {
    await page.goto(RELAY_PAGE_URL);
  });

  const result = await test.step("Context を止めたまま実バッファへ予約し、結果を集める", () =>
    page.evaluate(async (moduleUrl) => {
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
        playout.resetAudioPlayback();
        playout.resetPlayout();
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
        playout.resetAudioPlayback();
        playout.resetPlayout();
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
        // 実ブラウザのリソースはテストの終わりに必ず閉じる
        await context.close();
      }
    }, MODULE_URL));

  await test.step("補間・境界・並べすぎ・停止の記録を検証する", () => {
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
});

// 実 Web Audio の予約へ時間圧縮を反映する。時間軸の目標を守る並べ方 (enforceTarget) を
// 通すため、映像の相手を設定する (音声だけの入口は到着基準で並び、目標へ詰めない)。
for (const sampleRate of [44_100, 48_000]) {
  test(`実 Web Audio の ${sampleRate} Hz の予約へ時間圧縮を反映する`, async ({ page }) => {
    await test.step("テストページを開く", async () => {
      await page.goto(RELAY_PAGE_URL);
    });

    const result = await test.step("実 AudioContext の予約で時間圧縮を通し、結果を集める", () =>
      page.evaluate(
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
          if (drawing === null) throw new Error("failed to create the canvas 2D context");
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
            // 出力の時計の対応ができるまで、期限付きで待つ
            const mappingDeadlineMs = performance.now() + 2_000;
            while (
              context.getOutputTimestamp().performanceTime === 0 &&
              performance.now() < mappingDeadlineMs
            ) {
              await new Promise<void>((resolve) => {
                setTimeout(resolve, 10);
              });
            }
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
            // 実ブラウザのリソースはテストの終わりに必ず閉じる
            await context.close();
          }
        },
        { moduleUrl: MODULE_URL, sampleRate },
      ));

    await test.step("鳴った長さが詰めた分だけ減っていることを検証する", () => {
      expect(result.statuses.every((status) => status === "played")).toBe(true);
      expect(result.compressedMs).toBeGreaterThan(0);
      // 鳴った長さは、詰めた分だけ減っている
      expect(result.playedMs).toBeCloseTo(240 - result.compressedMs, 4);
      expect(result.catchUp).toBe(0);
    });
  });
}

// 同じ実時間の停止でも、入力経路または利用者が指定した遅延なら復号器を作り直さない。
// TIMESTAMP の順序を保ったまま実時計を待ち、入口から判定器への配線を検証する。
test("受信側の追いつきは復号だけが足した遅延で決める", async ({ page }) => {
  await test.step("テストページを開く", async () => {
    await page.goto(RELAY_PAGE_URL);
  });

  const result = await test.step("遅延の種類ごとに入口を作り、追いつきの判定を集める", () =>
    page.evaluate(async (moduleUrl) => {
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
          if (playout === undefined) throw new Error("the playout for the case must exist");
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
        // 2 回目の音を実時間で遅らせる。固定の待ちではなく、期限付きで経過を待つ
        const secondPushedAtMs = performance.now();
        const delayDeadlineMs = secondPushedAtMs + 2_000;
        while (performance.now() - secondPushedAtMs < 200 && performance.now() < delayDeadlineMs) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 10);
          });
        }
        const second = play(origin + 20_000, true);
        return { first, second };
      } finally {
        // 実ブラウザのリソースはテストの終わりに必ず閉じる
        await context.close();
      }
    }, MODULE_URL));

  await test.step("復号だけが足した遅延で復号器を作り直すと判断することを検証する", () => {
    expect(result.first).toEqual([false, false, false, false, false]);
    expect(result.second).toEqual([true, false, false, false, false]);
  });
});
