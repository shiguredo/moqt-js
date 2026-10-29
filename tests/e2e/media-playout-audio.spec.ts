import { expect, test } from "@playwright/test";
import { evaluatePlayout, openPlayoutPage } from "./playoutTestPage";

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

/** 48 kHz の 20 ms の音のサンプル数 */
const AUDIO_FRAMES = 960;

/** 壁時計の TIMESTAMP でも時間軸へ記録しない入口で、実際に穴を作る条件 */
const GAP_CASES = [
  { timestampKind: "none" as const, label: "TIMESTAMP 無し", jitterBuffer: true },
  { timestampKind: "wallClock" as const, label: "壁時計", jitterBuffer: false },
];

/**
 * 再生の入口 (MediaPlayout) の音声の E2E
 *
 * 実ブラウザの WebCodecs (AudioData) と Web Audio (AudioContext) だけを使い、
 * 実リレーへは接続しない。時間軸・計器・再生の組み立て・復号へ渡した入力の対応表は
 * 入口が持つため、ここでは組み立てない。
 */
test("実 Web Audio で音声の入口、TIMESTAMP の種類、統計を検証する", async ({ page }) => {
  await test.step("テストページを開く", () => openPlayoutPage(page));

  const result = await test.step("実 AudioContext と再生の入口へ音を渡し、結果を集める", () =>
    evaluatePlayout(page, async ({ moduleUrl, harnessUrl }) => {
      const { createMediaPlayout } = (await import(moduleUrl)) as typeof import("../../src/index");
      const harness = (await import(harnessUrl)) as typeof import("./playoutBrowserHarness");
      const audio = await harness.createSilentAudioOutput();
      try {
        // 1. 鳴らす先が無い入口では鳴らさず、計器へも記録しない。復号の入力の記録も無いため
        //    種類は none になる。AudioData は入口が閉じない (所有権は呼び出し側に残る)。
        const silentPlayout = createMediaPlayout({ audio: {} });
        const silentData = harness.createAudioData(harness.wallClockNowMicros());
        const skipped = silentPlayout.pushAudio(silentData);
        const skippedStatus = skipped.status;
        const skippedKind = skipped.timestampKind;
        const skippedDataFrames = silentData.numberOfFrames;
        silentData.close();
        const skippedPlayedFrames = silentPlayout.getStats().audio?.timing.playedFrames ?? -1;

        // 2. 鳴らす先を付けた入口では、記録した TIMESTAMP の種類ごとに鳴らす。音声だけの
        //    入口は揃える相手がいないため、A/V 同期の推定 (avSync) を出さない。44.1 kHz の
        //    音も同じ入口で、コピーから Web Audio への予約まで通す。
        const statuses: string[] = [];
        const kinds: string[] = [];
        const playedDataFrames: number[] = [];
        const audioOnlyAvSync: boolean[] = [];
        for (const timestampKind of ["none", "mediaTime", "wallClock"] as const) {
          // 種類ごとに入口を作り直す (前の検証の時間軸を持ち越さない)
          const playout = createMediaPlayout({
            audio: { context: audio.context, destination: audio.destination },
          });
          const data = harness.createAudioData(harness.wallClockNowMicros());
          playout.trackAudioDecodeInput(data.timestamp, { timestampKind });
          const decision = playout.pushAudio(data);
          statuses.push(decision.status);
          kinds.push(decision.timestampKind);
          // 鳴らすと決めた音でも、入口は AudioData を閉じない
          playedDataFrames.push(data.numberOfFrames);
          audioOnlyAvSync.push(playout.getStats().avSync === null);
          data.close();
          await playout.drainAudio();
        }
        // 44.1 kHz の実 AudioData も、コピーから Web Audio への予約まで通す。
        const fractionalPlayout = createMediaPlayout({
          audio: { context: audio.context, destination: audio.destination },
        });
        const fractionalData = harness.createAudioData(harness.wallClockNowMicros(), {
          sampleRate: 44_100,
        });
        fractionalPlayout.trackAudioDecodeInput(fractionalData.timestamp, {
          timestampKind: "none",
        });
        const fractionalDecision = fractionalPlayout.pushAudio(fractionalData);
        statuses.push(fractionalDecision.status);
        kinds.push(fractionalDecision.timestampKind);
        const fractionalDataFrames = fractionalData.numberOfFrames;
        const stretchingUnavailable =
          fractionalPlayout.getStats().audio?.timing.stretchUnavailableFrames ?? -1;
        fractionalData.close();
        await fractionalPlayout.drainAudio();

        // 3. 音声を構成していても鳴らす先が無い入口では、選別 (admit) は呼ばれるが、結果は
        //    skipped が優先される (notAdmitted にしない)。選別を飛ばすと、呼び出し側が
        //    選別に持たせている追いつきの状態を進める副作用が落ちる。
        let unoutputAdmitCalls = 0;
        const unoutputPlayout = createMediaPlayout({
          audio: {
            admit: () => {
              unoutputAdmitCalls++;
              return false;
            },
          },
        });
        const unoutputData = harness.createAudioData(harness.wallClockNowMicros());
        unoutputPlayout.trackAudioDecodeInput(unoutputData.timestamp, {
          timestampKind: "wallClock",
        });
        const unoutputDecision = unoutputPlayout.pushAudio(unoutputData);
        const unoutputStatus = unoutputDecision.status;
        const unoutputKind = unoutputDecision.timestampKind;
        const unoutputDataFrames = unoutputData.numberOfFrames;
        const unoutputPlayedFrames = unoutputPlayout.getStats().audio?.timing.playedFrames ?? -1;
        unoutputData.close();

        // 4. 音声を構成していない入口 (映像だけ) へ復号した音を渡しても throw せず、skipped を
        //    返す。AudioData の所有権は呼び出し側に残るため、入口は閉じない。
        const videoOnlyPlayout = createMediaPlayout({
          video: { output: harness.createCanvasVideoOutput().output },
        });
        const videoOnlyData = harness.createAudioData(harness.wallClockNowMicros());
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
          skippedDataFrames,
          skippedPlayedFrames,
          statuses,
          kinds,
          playedDataFrames,
          audioOnlyAvSync,
          fractionalDataFrames,
          stretchingUnavailable,
          unoutputStatus,
          unoutputKind,
          unoutputAdmitCalls,
          unoutputDataFrames,
          unoutputPlayedFrames,
          videoOnlyStatus,
          videoOnlyKind,
          videoOnlyDataFrames,
          videoOnlyDataSampleRate,
          videoOnlyAudioStatsNull,
        };
      } finally {
        await harness.closeSilentAudioOutput(audio);
      }
    }));

  await test.step("音声の入口と TIMESTAMP の種類、統計を検証する", () => {
    // 1. 鳴らす先が無い入口は skipped を返し、計器へも記録しない
    expect(result.skippedStatus).toBe("skipped");
    // 復号の入力の記録が無いため、種類は none になる
    expect(result.skippedKind).toBe("none");
    expect(result.skippedDataFrames).toBe(AUDIO_FRAMES);
    expect(result.skippedPlayedFrames).toBe(0);
    // 2. 鳴らす先のある入口は、記録した種類ごとに鳴らす
    expect(result.statuses).toEqual(["played", "played", "played", "played"]);
    // 記録した種類がそのまま戻り、記録の無い出力は none になる
    expect(result.kinds).toEqual(["none", "mediaTime", "wallClock", "none"]);
    // 鳴らすと決めた音も、入口は AudioData を閉じない
    expect(result.playedDataFrames).toEqual([AUDIO_FRAMES, AUDIO_FRAMES, AUDIO_FRAMES]);
    // 44.1 kHz の音は 882 サンプル (20 ms) であり、入口は閉じない
    expect(result.fractionalDataFrames).toBe(882);
    // 音声だけの入口は A/V 同期の推定を出さない
    expect(result.audioOnlyAvSync).toEqual([true, true, true]);
    // 44.1 kHz は加工できるため、加工できない音として数えない
    expect(result.stretchingUnavailable).toBe(0);
    // 3. 鳴らす先が無くても選別は呼ばれるが、結果は skipped が優先される
    expect(result.unoutputStatus).toBe("skipped");
    expect(result.unoutputKind).toBe("wallClock");
    expect(result.unoutputAdmitCalls).toBe(1);
    expect(result.unoutputDataFrames).toBe(AUDIO_FRAMES);
    expect(result.unoutputPlayedFrames).toBe(0);
    // 4. 音声を構成していない入口は、音を閉じずに skipped を返す
    expect(result.videoOnlyStatus).toBe("skipped");
    expect(result.videoOnlyKind).toBe("none");
    expect(result.videoOnlyDataFrames).toBe(AUDIO_FRAMES);
    expect(result.videoOnlyDataSampleRate).toBe(48_000);
    expect(result.videoOnlyAudioStatsNull).toBe(true);
  });
});

test("実 Web Audio で音の選別、コールバックの失敗、記録の補いを検証する", async ({ page }) => {
  await test.step("テストページを開く", () => openPlayoutPage(page));

  const result = await test.step("実 AudioContext と再生の入口で検証し、結果を集める", () =>
    evaluatePlayout(page, async ({ moduleUrl, harnessUrl }) => {
      const { createMediaPlayout } = (await import(moduleUrl)) as typeof import("../../src/index");
      const harness = (await import(harnessUrl)) as typeof import("./playoutBrowserHarness");
      const audio = await harness.createSilentAudioOutput();
      try {
        // 1. 映像も設定した入口では、映像をまだ観測していないため共有の基準が作られない。
        //    共有していないことと、その理由 (未観測) を遅延の内訳から読める。
        const avPlayout = createMediaPlayout({
          audio: { context: audio.context, destination: audio.destination },
          video: { output: harness.createCanvasVideoOutput().output },
        });
        const avData = harness.createAudioData(harness.wallClockNowMicros());
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
            context: audio.context,
            destination: audio.destination,
            admit: (input) => {
              // null を "none" と混ぜると、種類が無い記録と引けなかった記録を区別できない
              admittedKinds.push(input === null ? "null" : input.timestampKind);
              return false;
            },
          },
        });
        const selectingData = harness.createAudioData(harness.wallClockNowMicros());
        selectingPlayout.trackAudioDecodeInput(selectingData.timestamp, {
          timestampKind: "wallClock",
        });
        const notAdmitted = selectingPlayout.pushAudio(selectingData);
        const notAdmittedStatus = notAdmitted.status;
        const notAdmittedKind = notAdmitted.timestampKind;
        // 鳴らさないと決めた音も、入口は AudioData を閉じない
        const notAdmittedDataFrames = selectingData.numberOfFrames;
        selectingData.close();
        // 記録が無い出力も選別へ渡す (入力は null)
        const unrecordedData = harness.createAudioData(harness.wallClockNowMicros());
        const notAdmittedUnrecorded = selectingPlayout.pushAudio(unrecordedData);
        const notAdmittedUnrecordedStatus = notAdmittedUnrecorded.status;
        const notAdmittedUnrecordedKind = notAdmittedUnrecorded.timestampKind;
        const notAdmittedUnrecordedDataFrames = unrecordedData.numberOfFrames;
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
            context: audio.context,
            destination: audio.destination,
            admit: (input) => {
              fallbackAdmitInputs.push(input === null ? "null" : input.timestampKind);
              return true;
            },
          },
        });
        const fallbackBaseData = harness.createAudioData(harness.wallClockNowMicros());
        const fallbackBaseTimestamp = fallbackBaseData.timestamp;
        fallbackPlayout.trackAudioDecodeInput(fallbackBaseTimestamp, {
          timestampKind: "wallClock",
        });
        // 許容 (10 ms) を超えて離し、記録との対応を引けなくする。出力を記録より前に
        // すると、resolve が古い記録を捨てる前に「直前に分かっている種類」で補う経路を通る
        const fallbackData = harness.createAudioData(fallbackBaseTimestamp - 40_000);
        const fallbackDecision = fallbackPlayout.pushAudio(fallbackData);
        const fallbackKind = fallbackDecision.timestampKind;
        const fallbackStatus = fallbackDecision.status;
        fallbackBaseData.close();
        fallbackData.close();
        await fallbackPlayout.drainAudio();

        // 4. 選別 (admit) が throw しても状態を壊さず error を返す。AudioData は入口が閉じない
        //    (所有権は呼び出し側に残る) ため、寸法を読んでから呼び出し側が閉じる。
        const throwingAdmitPlayout = createMediaPlayout({
          audio: {
            context: audio.context,
            destination: audio.destination,
            admit: () => {
              throw new Error("admit callback must not throw");
            },
          },
        });
        const throwingAdmitData = harness.createAudioData(harness.wallClockNowMicros());
        throwingAdmitPlayout.trackAudioDecodeInput(throwingAdmitData.timestamp, {
          timestampKind: "wallClock",
        });
        const throwingAdmitDecision = throwingAdmitPlayout.pushAudio(throwingAdmitData);
        const throwingAdmitStatus = throwingAdmitDecision.status;
        const throwingAdmitMessage =
          throwingAdmitDecision.status === "error" ? throwingAdmitDecision.error.message : null;
        const throwingAdmitDataFrames = throwingAdmitData.numberOfFrames;
        throwingAdmitData.close();
        // 鳴らす前の失敗なので、計器へ鳴った / 鳴らなかったとして記録しない
        const throwingAdmitTiming = throwingAdmitPlayout.getStats().audio?.timing ?? null;
        const throwingAdmitPlayedFrames = throwingAdmitTiming?.playedFrames ?? -1;
        const throwingAdmitMissedFrames = throwingAdmitTiming?.missedFrames ?? -1;

        // 5. 揃える相手 (hasCounterpart) が throw しても状態を壊さず error を返す
        const throwingCounterpartPlayout = createMediaPlayout({
          audio: {
            context: audio.context,
            destination: audio.destination,
            hasCounterpart: () => {
              throw new Error("hasCounterpart callback must not throw");
            },
          },
          video: { output: harness.createCanvasVideoOutput().output },
        });
        const throwingCounterpartData = harness.createAudioData(harness.wallClockNowMicros());
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
        //    なり、音声だけの下限 (50 ms) を足す。300 ms 古い壁時計の音を 1 つ渡し、
        //    基準の選択を計器で区別する。呼ばれた回数も数える (push ごとに 1 回)。
        /** 300 ms 古い壁時計の音を 1 つ渡して、その結果を返す */
        const pushOldAudio = (hasCounterpart: () => boolean) => {
          let counterpartCalls = 0;
          const playout = createMediaPlayout({
            audio: {
              context: audio.context,
              destination: audio.destination,
              hasCounterpart: () => {
                counterpartCalls++;
                return hasCounterpart();
              },
            },
            video: { output: harness.createCanvasVideoOutput().output },
          });
          const timestamp = harness.wallClockNowMicros(-300);
          const data = harness.createAudioData(timestamp);
          try {
            playout.trackAudioDecodeInput(timestamp, { timestampKind: "wallClock" });
            const decision = playout.pushAudio(data);
            const timing = playout.getStats().audio?.timing ?? null;
            return {
              status: decision.status,
              counterpartCalls,
              lastStartDelayMs: timing?.lastStartDelayMs ?? -1,
              arrivalPlannedFrames: timing?.arrivalPlannedFrames ?? -1,
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
          notAdmittedDataFrames,
          notAdmittedUnrecordedStatus,
          notAdmittedUnrecordedKind,
          notAdmittedUnrecordedDataFrames,
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
        await harness.closeSilentAudioOutput(audio);
      }
    }));

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
    expect(result.notAdmittedDataFrames).toBe(AUDIO_FRAMES);
    expect(result.notAdmittedUnrecordedStatus).toBe("notAdmitted");
    expect(result.notAdmittedUnrecordedKind).toBe("none");
    expect(result.notAdmittedUnrecordedDataFrames).toBe(AUDIO_FRAMES);
    expect(result.notAdmittedPlayedFrames).toBe(0);
    expect(result.notAdmittedMissedFrames).toBe(0);
    expect(result.notAdmittedRecentMisses).toEqual([]);
    // 3. 記録が対応しない出力は、直前に分かっている種類を引き継ぐ。選別へ null が渡ることで、
    //    対応を引けずに種類を補った経路を通ったと区別できる
    expect(result.fallbackKind).toBe("wallClock");
    expect(result.fallbackStatus).toBe("played");
    expect(result.fallbackAdmitInputs).toEqual(["null"]);
    // 4. 選別が throw しても error として返し、鳴った / 鳴らなかったとして記録しない。
    //    AudioData は入口が閉じていない
    expect(result.throwingAdmitStatus).toBe("error");
    expect(result.throwingAdmitMessage).toBe("admit callback must not throw");
    expect(result.throwingAdmitDataFrames).toBe(AUDIO_FRAMES);
    expect(result.throwingAdmitPlayedFrames).toBe(0);
    expect(result.throwingAdmitMissedFrames).toBe(0);
    // 5. 揃える相手の判定が throw しても error として返す
    expect(result.throwingCounterpartStatus).toBe("error");
    expect(result.throwingCounterpartMessage).toBe("hasCounterpart callback must not throw");
    // 6. 揃える相手がいないときだけ到着基準になる。判定は push ごとに 1 回
    expect(result.withoutCounterpart.status).toBe("played");
    expect(result.withoutCounterpart.counterpartCalls).toBe(1);
    expect(result.withoutCounterpart.lastStartDelayMs).toBeGreaterThanOrEqual(40);
    expect(result.withoutCounterpart.arrivalPlannedFrames).toBe(1);
    expect(result.withCounterpart.status).toBe("played");
    expect(result.withCounterpart.counterpartCalls).toBe(1);
    // 揃える相手がいれば目標の開始時刻を守る。
    expect(result.withCounterpart.arrivalPlannedFrames).toBe(0);
  });
});

test("実 Web Audio で復号へ渡した入力の対応の許容を検証する", async ({ page }) => {
  await test.step("テストページを開く", () => openPlayoutPage(page));

  const result = await test.step("許容の内側と外側の timestamp で出力を渡す", () =>
    evaluatePlayout(page, async ({ moduleUrl, harnessUrl }) => {
      const { createMediaPlayout } = (await import(moduleUrl)) as typeof import("../../src/index");
      const harness = (await import(harnessUrl)) as typeof import("./playoutBrowserHarness");
      const audio = await harness.createSilentAudioOutput();
      try {
        // 選別へ渡った入力の遅れ (記録から引けた音だけ値が入る) を記録する
        const admittedInputLagMs: (number | null)[] = [];
        const playout = createMediaPlayout({
          audio: {
            context: audio.context,
            destination: audio.destination,
            admit: (input) => {
              admittedInputLagMs.push(input?.inputLagMs ?? null);
              return true;
            },
          },
        });

        // 1. 記録した TIMESTAMP から音 1 つの半分 (10 ms) 以内の出力は、その記録と対応する。
        //    出力は 5 ms だけ後ろにずらす (実ブラウザの復号の出力と同じ程度のずれ)。
        const matchedTimestamp = harness.wallClockNowMicros();
        playout.trackAudioDecodeInput(matchedTimestamp, {
          timestampKind: "wallClock",
          inputLagMs: 30,
        });
        const matchedData = harness.createAudioData(matchedTimestamp + 5_000);
        const matchedDecision = playout.pushAudio(matchedData);
        const matchedStatus = matchedDecision.status;
        const matchedKind = matchedDecision.timestampKind;
        const matchedDataFrames = matchedData.numberOfFrames;
        matchedData.close();

        // 2. 許容 (10 ms) を超えて離れた出力は、別の音と取り違えずに対応を引かない。
        //    記録は出力より許容以上に古いため捨てられ、直前の種類も引き継げない。
        //    種類は none になり、入力の遅れも使えない (null)。
        const unmatchedTimestamp = harness.wallClockNowMicros();
        playout.trackAudioDecodeInput(unmatchedTimestamp, {
          timestampKind: "wallClock",
          inputLagMs: 40,
        });
        const unmatchedData = harness.createAudioData(unmatchedTimestamp + 15_000);
        const unmatchedDecision = playout.pushAudio(unmatchedData);
        const unmatchedStatus = unmatchedDecision.status;
        const unmatchedKind = unmatchedDecision.timestampKind;
        const unmatchedDataFrames = unmatchedData.numberOfFrames;
        unmatchedData.close();

        return {
          admittedInputLagMs,
          matchedStatus,
          matchedKind,
          matchedDataFrames,
          unmatchedStatus,
          unmatchedKind,
          unmatchedDataFrames,
        };
      } finally {
        await harness.closeSilentAudioOutput(audio);
      }
    }));

  await test.step("許容の内側だけが記録と対応することを検証する", () => {
    // 許容の内側 (5 ms) は記録と対応し、記録した入力の遅れが選別へ渡る
    expect(result.admittedInputLagMs).toHaveLength(2);
    expect(result.admittedInputLagMs[0]).toBe(30);
    expect(result.matchedStatus).toBe("played");
    expect(result.matchedKind).toBe("wallClock");
    expect(result.matchedDataFrames).toBe(AUDIO_FRAMES);
    // 許容の外側 (15 ms) は対応を引かず、種類も引き継げず (none)、入力の遅れも
    // 選別へ渡さない (null)
    expect(result.unmatchedKind).toBe("none");
    expect(result.admittedInputLagMs[1]).toBeNull();
    expect(result.unmatchedStatus).toBe("played");
    expect(result.unmatchedDataFrames).toBe(AUDIO_FRAMES);
  });
});

test("setIntentionalDelayMs が受信側の追いつきの判定を変える", async ({ page }) => {
  await test.step("テストページを開く", () => openPlayoutPage(page));

  const result = await test.step("意図した遅延の設定ごとに、遅れた未対応出力を渡す", () =>
    evaluatePlayout(page, async ({ moduleUrl, harnessUrl }) => {
      const { createMediaPlayout } = (await import(moduleUrl)) as typeof import("../../src/index");
      const harness = (await import(harnessUrl)) as typeof import("./playoutBrowserHarness");
      const audio = await harness.createSilentAudioOutput();
      /**
       * 意図した遅延の設定で 1 回検証する
       *
       * 健常な音を 1 つ通して床 (健全時の遅れ) を作り、記録から 300 ms 後に、記録と
       * 対応しない 275 ms 遅れの出力を渡す。275 ms の遅れから意図した遅延を引いた値が
       * 追いつきの判定に使われる。
       */
      const runCase = async (intentionalDelayMs: number) => {
        const playout = createMediaPlayout({
          audio: { context: audio.context, destination: audio.destination },
        });
        playout.setIntentionalDelayMs(intentionalDelayMs);
        // 1. 20 ms 前の壁時計の音を 1 つ通して、健全時の遅れ (床) を作る
        const warmupTimestamp = harness.wallClockNowMicros(-20);
        playout.trackAudioDecodeInput(warmupTimestamp, {
          timestampKind: "wallClock",
          inputLagMs: 20,
        });
        const warmupData = harness.createAudioData(warmupTimestamp);
        const warmupStatus = playout.pushAudio(warmupData).status;
        warmupData.close();
        // 2. 復号の出力がまだ届いていない入力の記録を残す (後で未対応の出力を渡すため)
        const recordedTimestamp = harness.wallClockNowMicros();
        playout.trackAudioDecodeInput(recordedTimestamp, { timestampKind: "wallClock" });
        playout.trackAudioDecodeInput(recordedTimestamp + 40_000, {
          timestampKind: "wallClock",
        });
        // 3. 記録から 300 ms 後に、記録と対応しない出力を渡す。timestamp はその時点の
        //    275 ms 前にする (遅れ 275 ms の音として届かせる)
        const recordedAtMs = performance.now();
        await harness.waitFor(
          () => performance.now() - recordedAtMs >= 300,
          2_000,
          "記録から 300 ms 後の未対応の音の到着",
        );
        const outputTimestamp = harness.wallClockNowMicros(-275);
        const data = harness.createAudioData(outputTimestamp);
        const decision = playout.pushAudio(data);
        data.close();
        const catchUp = playout.getStats().audio?.catchUp ?? null;
        return {
          warmupStatus,
          status: decision.status,
          catchUpStarted: "catchUpStarted" in decision && decision.catchUpStarted,
          decodeLagMs: catchUp?.decodeLagMs ?? -1,
          floorMs: catchUp?.floorMs ?? -1,
        };
      };
      try {
        const withoutIntentionalDelay = await runCase(0);
        const withIntentionalDelay = await runCase(180);
        return { withoutIntentionalDelay, withIntentionalDelay };
      } finally {
        await harness.closeSilentAudioOutput(audio);
      }
    }));

  await test.step("意図した遅延の分だけ「復号が足した遅れ」が小さくなることを検証する", () => {
    // どちらの入口も、健常な音は鳴る
    expect(result.withoutIntentionalDelay.warmupStatus).toBe("played");
    expect(result.withIntentionalDelay.warmupStatus).toBe("played");
    expect(result.withoutIntentionalDelay.status).toBe("played");
    expect(result.withIntentionalDelay.status).toBe("played");
    // 床 (健常な音の「復号が足した遅れ」) は 0 ms 付近 (計測の丸めを含む)
    expect(result.withoutIntentionalDelay.floorMs).toBeGreaterThanOrEqual(0);
    expect(result.withoutIntentionalDelay.floorMs).toBeLessThan(50);
    expect(result.withIntentionalDelay.floorMs).toBeGreaterThanOrEqual(0);
    expect(result.withIntentionalDelay.floorMs).toBeLessThan(50);
    // 275 ms 遅れた音は、意図した遅延 0 では音声を映像へ合わせられない遅れとして追いつきを始める
    expect(result.withoutIntentionalDelay.decodeLagMs).toBeGreaterThan(200);
    expect(result.withoutIntentionalDelay.decodeLagMs).toBeLessThan(350);
    expect(result.withoutIntentionalDelay.catchUpStarted).toBe(true);
    // 意図した遅延 180 ms を引くと、追いつきを始めない遅れ (100 ms 以下) になる
    expect(result.withIntentionalDelay.decodeLagMs).toBeGreaterThanOrEqual(80);
    expect(result.withIntentionalDelay.decodeLagMs).toBeLessThanOrEqual(100);
    expect(result.withIntentionalDelay.catchUpStarted).toBe(false);
    // 2 つの「復号が足した遅れ」の差は、設定した意図した遅延 (180 ms) と一致する
    expect(
      Math.abs(
        result.withoutIntentionalDelay.decodeLagMs - result.withIntentionalDelay.decodeLagMs - 180,
      ),
    ).toBeLessThanOrEqual(10);
  });
});

test("実 Web Audio で壊れた音の入力、停止と時計の再開を検証する", async ({ page }) => {
  await test.step("テストページを開く", () => openPlayoutPage(page));

  const result = await test.step("実 AudioContext と再生の入口で検証し、結果を集める", () =>
    evaluatePlayout(page, async ({ moduleUrl, harnessUrl }) => {
      const { createMediaPlayout } = (await import(moduleUrl)) as typeof import("../../src/index");
      const harness = (await import(harnessUrl)) as typeof import("./playoutBrowserHarness");
      const audio = await harness.createSilentAudioOutput();
      // 音声の目標の開始時刻を守る経路 (揃える相手がいる) を通すため、映像も設定する
      const videoOutput = harness.createCanvasVideoOutput();
      const playback = createMediaPlayout({
        audio: { context: audio.context, destination: audio.destination },
        video: { output: videoOutput.output },
      });

      try {
        // 1. 壁時計の観測を 1 つ作り、時間軸の遅延の内訳に観測値が入った状態にする。
        //    この状態を「壊れた入力の前後で変わらない」ことの比較元にする。
        const warmup = harness.createAudioData(harness.wallClockNowMicros());
        playback.trackAudioDecodeInput(warmup.timestamp, { timestampKind: "wallClock" });
        const warmupStatus = playback.pushAudio(warmup).status;
        warmup.close();
        await playback.drainAudio();
        const delaysBeforeFailure = playback.getStats().avSync?.delays ?? null;
        // 比較元に、音声の基準の遅れの観測値が入っている (null でも NaN でもない)
        const audioBaseDelayObserved = delaysBeforeFailure?.audio.baseDelayMs ?? null;

        // 2. 壊れた入力 (close 済み AudioData) は throw せず error を返し、時間軸の観測
        //    (遅延の内訳) を変えない。閉じた AudioData でも timestamp だけは読める (実測:
        //    Chromium)。その timestamp を壁時計として先に記録しておくと、失敗は「時間軸へ
        //    記録する種類 (壁時計)」の経路で起きる。
        const closed = harness.createAudioData(harness.wallClockNowMicros());
        const closedTimestamp = closed.timestamp;
        playback.trackAudioDecodeInput(closedTimestamp, { timestampKind: "wallClock" });
        closed.close();
        const failed = playback.pushAudio(closed);
        const failedStatus = failed.status;
        const failedKind = failed.timestampKind;
        const closedAgain = harness.createAudioData(harness.wallClockNowMicros());
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
        const recovered = harness.createAudioData(harness.wallClockNowMicros());
        playback.trackAudioDecodeInput(recovered.timestamp, { timestampKind: "none" });
        const recoveredStatus = playback.pushAudio(recovered).status;
        recovered.close();
        await playback.drainAudio();

        // 4. 一時停止と再開では Context の時計を実際に止める
        await audio.context.suspend();
        const suspendedTime = audio.context.currentTime;
        // 停止中に時計が進まないことを、期限付きの待ちで確かめる。実時間を空ける必要が
        // ある待ちであり、条件 (経過した時間) は実時間でしか満たせない
        const suspendStartedMs = performance.now();
        const suspendedForMs = 1_000;
        while (performance.now() - suspendStartedMs < suspendedForMs) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 10);
          });
        }
        const currentTimeAfterWait = audio.context.currentTime;
        await audio.context.resume();
        // 同じ Context の再開では入口を作り直さない。古い出力の対応を残したまま代用へ移ると、
        // 停止した 1 秒分が未来の予約になって破棄される。
        const resumed = harness.createAudioData(harness.wallClockNowMicros());
        playback.trackAudioDecodeInput(resumed.timestamp, { timestampKind: "wallClock" });
        const resumedDecision = playback.pushAudio(resumed);
        const resumedStatus = resumedDecision.status;
        const resumedStats = playback.getStats();
        const resumedClock = {
          mapping: audio.context.getOutputTimestamp(),
          currentTime: audio.context.currentTime,
          nowMs: performance.now(),
          lastStartDelayMs: resumedStats.audio?.timing.lastStartDelayMs ?? null,
          playedMs: resumedStats.audio?.timing.playedMs ?? null,
          delay: resumedStats.audio?.delay ?? null,
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
          suspendedTime,
          currentTimeAfterWait,
          resumedStatus,
          resumedClock,
        };
      } finally {
        await harness.closeSilentAudioOutput(audio);
      }
    }));

  await test.step("壊れた入力と停止・時計の再開を検証する", () => {
    expect(result.warmupStatus).toBe("played");
    // 比較元に、音声の基準の遅れの観測値が入っている (実ブラウザの時計の範囲に収まる)
    expect(result.audioBaseDelayObserved).not.toBeNull();
    expect(Math.abs(result.audioBaseDelayObserved ?? Number.NaN)).toBeLessThan(1_000);
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
    expect(result.currentTimeAfterWait).toBeCloseTo(result.suspendedTime, 6);
    expect(result.resumedStatus, JSON.stringify(result.resumedClock)).toBe("played");
    // 再開した音は、鳴り始めるまでの遅れと鳴った長さを計器に残す
    expect(
      result.resumedClock.lastStartDelayMs,
      JSON.stringify(result.resumedClock),
    ).toBeGreaterThanOrEqual(0);
    expect(result.resumedClock.lastStartDelayMs).toBeLessThan(1_000);
    expect(result.resumedClock.playedMs, JSON.stringify(result.resumedClock)).toBeGreaterThan(0);
  });
});

// 壁時計の観測がない音声でも、既に遅れた音をさらに待たせない。
// 穴は実時間を空けて音を届けることで実ブラウザに作らせ、学習した深さと予約を分ける。
// AudioContext の実時計が進むことと、後続の音が予約されることを期限付きで確認する。
for (const gapCase of GAP_CASES) {
  test(`壁時計の観測がない (${gapCase.label}) 音声も到着停滞の後にすぐ再開する`, async ({
    page,
  }) => {
    await test.step("テストページを開く", () => openPlayoutPage(page));

    const result = await test.step("実時間を空けて音を届け、予約と欠落の結果を集める", () =>
      evaluatePlayout(
        page,
        async ({ moduleUrl, harnessUrl, timestampKind, jitterBuffer }) => {
          const { createMediaPlayout } = (await import(
            moduleUrl
          )) as typeof import("../../src/index");
          const harness = (await import(harnessUrl)) as typeof import("./playoutBrowserHarness");
          const audio = await harness.createSilentAudioOutput();
          // 壁時計の TIMESTAMP でも時間軸へ記録しない入口にする (壁時計の観測が無い状態)。
          // それ以外の種類はそもそも時間軸へ記録されない。
          const playout = createMediaPlayout({
            audio: { context: audio.context, destination: audio.destination },
            jitterBuffer,
          });
          // 音の TIMESTAMP。none は decoder へ 0 を渡す経路と同じく 0 のままにする。
          const firstTimestamp = timestampKind === "wallClock" ? harness.wallClockNowMicros() : 0;
          /** 復号の入力の記録を作り、復号の出力として渡す */
          const push = (timestamp: number) => {
            const data = harness.createAudioData(timestamp);
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
            const firstContextSeconds = audio.context.currentTime;
            const firstPlayedOut = await harness.waitUntil(
              () => audio.context.currentTime - firstContextSeconds >= 1,
              5_000,
            );
            const second = push(firstTimestamp + 20_000);
            // 次の音を出力した後にも、新たな音を予約できることを確認する
            const secondPushedAtMs = performance.now();
            const secondPlayedOut = await harness.waitUntil(
              () => performance.now() - secondPushedAtMs >= 100,
              3_000,
            );
            const appliedBeforeThird = playout.getStats().audio?.delay.targetMs ?? -1;
            const third = push(firstTimestamp + 40_000);
            const stats = playout.getStats();
            const timing = stats.audio?.timing ?? null;
            // 音声だけの入口でも、計器から再生予算の内訳を読める
            const delay = stats.audio?.delay ?? null;
            return {
              firstPlayedOut,
              secondPlayedOut,
              first: first.status,
              second: second.status,
              third: third.status,
              appliedMs: delay?.targetMs ?? -1,
              appliedBeforeThird,
              jitterMs: delay?.jitterMs ?? null,
              gapCount: timing?.gapCount ?? -1,
              lastStartDelayMs: timing?.lastStartDelayMs ?? -1,
              audioOnly: stats.avSync === null,
            };
          } finally {
            await harness.closeSilentAudioOutput(audio);
          }
        },
        { timestampKind: gapCase.timestampKind, jitterBuffer: gapCase.jitterBuffer },
      ));

    await test.step("欠落を記録しつつ、遅れて届いた音を再び待たせないことを検証する", () => {
      // 実時間の待ちが期限の中で満たされた (穴を作るための再生の進み)
      expect(result.firstPlayedOut).toBe(true);
      expect(result.secondPlayedOut).toBe(true);
      expect(result.first).toBe("played");
      expect(result.second).toBe("played");
      expect(result.third).toBe("played");
      // 壁時計の音声を観測していないため、揺らぎの学習した目標は使われない
      expect(result.jitterMs).toBeNull();
      // 音声だけの入口は A/V 同期の推定を出さない
      expect(result.audioOnly).toBe(true);
      // 届かなかった区間の穴は記録し、過去の途絶で常時の予算を増やさない
      expect(result.gapCount).toBeGreaterThanOrEqual(1);
      // 予算は 50 ms のまま保つ。既に遅れた音は、Web Audio が予約できる位置へ置く。
      expect(result.appliedMs).toBe(50);
      expect(result.appliedBeforeThird).toBe(50);
      expect(result.lastStartDelayMs).toBeGreaterThanOrEqual(0);
      expect(result.lastStartDelayMs).toBeLessThan(65);
    });
  });
}

// Context の実際の一時停止を使って、予約中に時計が進まない条件を作る。
// AudioBuffer へのコピー、補間、フェードと計器への配線を同時に通す。
test("実バッファの補間、通常の境界、並べすぎと停止の記録を検証する", async ({ page }) => {
  await test.step("テストページを開く", () => openPlayoutPage(page));

  const result = await test.step("Context を止めたまま実バッファへ予約し、結果を集める", () =>
    evaluatePlayout(page, async ({ moduleUrl, harnessUrl }) => {
      const { createMediaPlayout } = (await import(moduleUrl)) as typeof import("../../src/index");
      const harness = (await import(harnessUrl)) as typeof import("./playoutBrowserHarness");
      const audio = await harness.createSilentAudioOutput();
      const playout = createMediaPlayout({
        audio: { context: audio.context, destination: audio.destination },
      });
      const play = (timestamp: number, sampleRate = 48_000) => {
        const data = harness.createAudioData(timestamp, {
          sampleRate,
          numberOfFrames: sampleRate / 50,
          fill: 0.5,
        });
        try {
          playout.trackAudioDecodeInput(timestamp, { timestampKind: "mediaTime" });
          return playout.pushAudio(data);
        } finally {
          data.close();
        }
      };
      try {
        await audio.context.suspend();
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
        await harness.closeSilentAudioOutput(audio);
      }
    }));

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

// 実 Web Audio の予約へ時間圧縮を反映する。時間軸の目標を守る並べ方を通すため、映像の
// 相手を設定する (音声だけの入口は到着基準で並び、目標へ詰めない)。
for (const sampleRate of [44_100, 48_000]) {
  test(`実 Web Audio の ${sampleRate} Hz の予約へ時間圧縮を反映する`, async ({ page }) => {
    await test.step("テストページを開く", () => openPlayoutPage(page));

    const result = await test.step("実 AudioContext の予約で時間圧縮を通し、結果を集める", () =>
      evaluatePlayout(
        page,
        async ({ moduleUrl, harnessUrl, sampleRate }) => {
          const { createMediaPlayout } = (await import(
            moduleUrl
          )) as typeof import("../../src/index");
          const harness = (await import(harnessUrl)) as typeof import("./playoutBrowserHarness");
          const audio = await harness.createSilentAudioOutput({ sampleRate });
          const videoOutput = harness.createCanvasVideoOutput();
          const playout = createMediaPlayout({
            audio: { context: audio.context, destination: audio.destination },
            video: { output: videoOutput.output },
          });
          try {
            // 出力の時計の対応ができるまで待つ (対応が無いと予約の基準が決まらない)
            await harness.waitFor(
              () => audio.context.getOutputTimestamp().performanceTime !== 0,
              2_000,
              "音声の出力時計の対応",
            );
            await audio.context.suspend();
            const origin = harness.wallClockNowMicros(-240);
            const samples = Float32Array.from(
              { length: sampleRate / 50 },
              (_, index) => 0.3 * Math.sin((2 * Math.PI * 200 * index) / sampleRate),
            );
            const statuses: string[] = [];
            for (let index = 0; index < 12; index++) {
              const timestamp = origin + index * 20_000;
              const data = harness.createAudioData(timestamp, {
                sampleRate,
                numberOfFrames: samples.length,
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
            await harness.closeSilentAudioOutput(audio);
          }
        },
        { sampleRate },
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
  await test.step("テストページを開く", () => openPlayoutPage(page));

  const result = await test.step("遅延の種類ごとに入口を作り、追いつきの判定を集める", () =>
    evaluatePlayout(page, async ({ moduleUrl, harnessUrl }) => {
      const { createMediaPlayout } = (await import(moduleUrl)) as typeof import("../../src/index");
      const harness = (await import(harnessUrl)) as typeof import("./playoutBrowserHarness");
      const audio = await harness.createSilentAudioOutput();
      const cases = ["decoder", "network", "intentional", "mediaTime", "disabled"] as const;
      // 入口 (時間軸・音声の再生・計器) は購読ごとに 1 つ作る。disabled だけ時間軸を使わない
      const playouts = cases.map((kind) =>
        createMediaPlayout({
          audio: { context: audio.context, destination: audio.destination },
          jitterBuffer: kind !== "disabled",
        }),
      );
      const origin = harness.wallClockNowMicros(-20);
      const play = (timestamp: number, second: boolean) =>
        cases.map((kind, index) => {
          const playout = playouts[index];
          if (playout === undefined) throw new Error("the playout for the case must exist");
          const nowMs = performance.timeOrigin + performance.now();
          const inputLagMs = second && kind === "network" ? nowMs - timestamp / 1_000 : 20;
          const intentionalDelayMs =
            second && kind === "intentional" ? nowMs - timestamp / 1_000 - 20 : 0;
          const data = harness.createAudioData(timestamp);
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
        await audio.context.suspend();
        const first = play(origin, false);
        // 2 回目の音を実時間で遅らせる。固定の待ちではなく、期限付きで経過を待つ
        const secondPushedAtMs = performance.now();
        await harness.waitUntil(() => performance.now() - secondPushedAtMs >= 200, 2_000);
        const second = play(origin + 20_000, true);
        return { first, second };
      } finally {
        await harness.closeSilentAudioOutput(audio);
      }
    }));

  await test.step("復号だけが足した遅延で復号器を作り直すと判断することを検証する", () => {
    expect(result.first).toEqual([false, false, false, false, false]);
    expect(result.second).toEqual([true, false, false, false, false]);
  });
});
