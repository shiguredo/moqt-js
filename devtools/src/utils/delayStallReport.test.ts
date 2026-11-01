import { test, assert } from "vite-plus/test";
import { STALL_CAUSES, type StallCause } from "./stallAnalysis";
import type { TimingSummary } from "../../../src/playout/timingSummary.ts";
import {
  formatDelayStallSampleLine,
  readDelayStallSample,
  summarizeDelayStall,
  type DelayStallCauseTotal,
  type DelayStallStatsInput,
} from "./delayStallReport";

/** 分布 (p50 / p95 / max が同じ値) を作る */
function summary(value: number): TimingSummary {
  return { p50: value, p95: value, max: value };
}

/** 原因ごとの止まりを作る (指定しない原因は 0 回 0 ms) */
function createStallCauses(
  init: Partial<Record<StallCause, DelayStallCauseTotal>> = {},
): Record<StallCause, DelayStallCauseTotal> {
  const causes = {} as Record<StallCause, DelayStallCauseTotal>;
  for (const cause of STALL_CAUSES) {
    causes[cause] = init[cause] ?? { count: 0, ms: 0 };
  }
  return causes;
}

/** 統計の既定値 (止まりも遅れも無い状態) */
const EMPTY_TIMING: DelayStallStatsInput["playoutTiming"] = {
  latencyBreakdown: {
    arrival: null,
    hold: null,
    decodeWait: null,
    decode: null,
    displayWait: null,
    displayLatency: null,
  },
  displayStalls: 0,
  displayStallMs: 0,
  stallCauses: createStallCauses(),
  lateFramesDropped: 0,
  missingObjects: 0,
  missingGroups: 0,
  subgroupStreamResets: 0,
  displayIntervalMs: null,
  recentStalls: [],
};

const EMPTY_AUDIO: NonNullable<DelayStallStatsInput["audio"]> = {
  receiveDelayMs: null,
  maxReceiveDelayMs: null,
  playoutTiming: {
    playedMs: 0,
    slackMs: null,
    latenessMs: null,
    startDelayMs: null,
    missedFrames: 0,
    missedMs: 0,
    gapMs: 0,
    unrecoverableGapMs: 0,
  },
  playoutCatchUp: { catchUpStarts: 0, skippedMs: 0, catchingUp: false },
  playoutRebases: 0,
  playoutCompressedMs: 0,
  playoutConcealedMs: 0,
};

const EMPTY_AV_SYNC: DelayStallStatsInput["avSync"] = {
  skewMs: null,
  presentationDelayMs: null,
  delays: {
    sharingBases: true,
    unsharedReason: "",
    audioDelay: { jitterMs: null, targetMs: 100, outputLeadMs: null },
  },
};

/** 統計を作る (必要なフィールドだけ上書きする) */
function createStats(overrides: {
  framesDecoded?: number;
  playoutTiming?: DelayStallStatsInput["playoutTiming"];
  audio?: DelayStallStatsInput["audio"];
  avSync?: DelayStallStatsInput["avSync"];
}): DelayStallStatsInput {
  return {
    framesDecoded: overrides.framesDecoded ?? 0,
    playoutTiming: overrides.playoutTiming ?? EMPTY_TIMING,
    audio: overrides.audio === undefined ? EMPTY_AUDIO : overrides.audio,
    avSync: overrides.avSync ?? EMPTY_AV_SYNC,
  };
}

// 受信から表示までの遅延の内訳と、原因ごとの止まりを、そのまま読める値として取り出す
test("readDelayStallSample: 映像と音声の遅延と停止の値を取り出す", () => {
  const stats = createStats({
    framesDecoded: 240,
    playoutTiming: {
      ...EMPTY_TIMING,
      latencyBreakdown: {
        arrival: summary(40),
        hold: summary(5),
        decodeWait: summary(6),
        decode: summary(8),
        displayWait: summary(10),
        displayLatency: summary(64),
      },
      displayStalls: 2,
      displayStallMs: 950,
      stallCauses: createStallCauses({
        arrival: { count: 1, ms: 300 },
        decode: { count: 1, ms: 200 },
        // 0 回の原因はレポートに含めない (読み手が「その原因で止まった」と誤読しない)
        loss: { count: 0, ms: 0 },
      }),
      lateFramesDropped: 1,
      missingObjects: 2,
      missingGroups: 1,
      subgroupStreamResets: 3,
      displayIntervalMs: { p50: 32.6, p95: 50.4, max: 51.2 },
      recentStalls: [
        {
          cause: "arrival",
          durationMs: 280,
          mediaStepMs: 33.3,
          groupId: "12",
          objectId: "3",
          wallClockMs: Date.UTC(2026, 10, 1, 12, 0, 0),
        },
        {
          cause: "decode",
          durationMs: 150,
          mediaStepMs: 66.7,
          groupId: null,
          objectId: null,
          wallClockMs: Date.UTC(2026, 10, 1, 12, 0, 1),
        },
      ],
    },
    audio: {
      ...EMPTY_AUDIO,
      receiveDelayMs: 55,
      maxReceiveDelayMs: 80,
      playoutRebases: 1,
      playoutCompressedMs: 15,
      playoutConcealedMs: 25,
      playoutTiming: {
        playedMs: 12_000,
        slackMs: summary(18),
        latenessMs: summary(3),
        startDelayMs: summary(110),
        missedFrames: 2,
        missedMs: 40,
        gapMs: 20,
        unrecoverableGapMs: 10,
      },
      playoutCatchUp: { catchUpStarts: 1, skippedMs: 60, catchingUp: false },
    },
    avSync: {
      ...EMPTY_AV_SYNC,
      skewMs: -12,
      presentationDelayMs: 70,
      delays: {
        ...EMPTY_AV_SYNC.delays,
        audioDelay: { jitterMs: 20, targetMs: 100, outputLeadMs: 30 },
      },
    },
  });

  const sample = readDelayStallSample(stats, 1_500);

  assert.equal(sample.tMs, 1_500);
  assert.equal(sample.video.framesDecoded, 240);
  assert.equal(sample.video.arrivalP95Ms, 40);
  assert.equal(sample.video.holdP95Ms, 5);
  assert.equal(sample.video.decodeWaitP95Ms, 6);
  assert.equal(sample.video.decodeP95Ms, 8);
  assert.equal(sample.video.displayWaitP95Ms, 10);
  assert.equal(sample.video.displayLatencyP95Ms, 64);
  assert.equal(sample.video.displayStalls, 2);
  assert.equal(sample.video.displayStallMs, 950);
  assert.equal(sample.video.maxRecentStallMs, 280);
  assert.equal(sample.video.displayIntervalP50Ms, 32.6);
  assert.equal(sample.video.displayIntervalP95Ms, 50.4);
  assert.equal(sample.video.displayIntervalMaxMs, 51.2);
  assert.equal(sample.video.recentStalls[0]?.mediaStepMs, 33.3);
  assert.equal(sample.video.recentStalls[0]?.groupId, "12");
  assert.deepEqual(sample.video.stallCauses, {
    arrival: { count: 1, ms: 300 },
    decode: { count: 1, ms: 200 },
  });
  assert.equal(sample.video.lateFramesDropped, 1);
  assert.equal(sample.video.missingObjects, 2);
  assert.equal(sample.video.missingGroups, 1);
  assert.equal(sample.video.subgroupStreamResets, 3);
  assert.equal(sample.audio?.receiveDelayMs, 55);
  assert.equal(sample.audio?.maxReceiveDelayMs, 80);
  assert.equal(sample.audio?.latenessP95Ms, 3);
  assert.equal(sample.audio?.startDelayP95Ms, 110);
  assert.equal(sample.audio?.missedFrames, 2);
  assert.equal(sample.audio?.gapMs, 20);
  assert.equal(sample.audio?.catchUpStarts, 1);
  assert.equal(sample.audio?.skippedMs, 60);
  assert.equal(sample.audio?.rebases, 1);
  assert.equal(sample.audio?.targetDelayMs, 100);
  assert.equal(sample.avSync.skewMs, -12);
  assert.equal(sample.avSync.presentationDelayMs, 70);
  assert.isTrue(sample.avSync.sharingBases);
});

// 音声を購読していない場合も、映像の値だけで 1 点を作れる (音声の項目は null になる)
test("readDelayStallSample: 音声を購読していなければ audio を null にする", () => {
  const sample = readDelayStallSample(createStats({ framesDecoded: 10, audio: null }), 0);
  assert.isNull(sample.audio);
  assert.equal(sample.video.framesDecoded, 10);
});

// 観測の最初と最後の差で、観測の間の停止と欠落を数える
test("summarizeDelayStall: 累積値の差から、観測の間の停止と欠落をまとめる", () => {
  const samples = [
    readDelayStallSample(
      createStats({
        framesDecoded: 0,
        playoutTiming: {
          ...EMPTY_TIMING,
          displayIntervalMs: { p50: 32.6, p95: 33.3, max: 33.3 },
        },
      }),
      0,
    ),
    readDelayStallSample(
      createStats({
        framesDecoded: 120,
        playoutTiming: {
          ...EMPTY_TIMING,
          latencyBreakdown: {
            ...EMPTY_TIMING.latencyBreakdown,
            arrival: summary(40),
            displayLatency: summary(64),
          },
          displayStalls: 1,
          displayStallMs: 300,
          stallCauses: createStallCauses({ arrival: { count: 1, ms: 300 } }),
          displayIntervalMs: { p50: 32.6, p95: 50.4, max: 50.4 },
          recentStalls: [
            {
              cause: "arrival",
              durationMs: 280,
              mediaStepMs: 33.3,
              groupId: "12",
              objectId: "3",
              wallClockMs: Date.UTC(2026, 10, 1, 12, 0, 0),
            },
          ],
        },
        audio: {
          ...EMPTY_AUDIO,
          receiveDelayMs: 55,
          maxReceiveDelayMs: 55,
          playoutTiming: {
            ...EMPTY_AUDIO.playoutTiming,
            latenessMs: summary(3),
            startDelayMs: summary(110),
            missedFrames: 1,
          },
        },
        avSync: { ...EMPTY_AV_SYNC, skewMs: -12 },
      }),
      1_000,
    ),
    readDelayStallSample(
      createStats({
        framesDecoded: 240,
        playoutTiming: {
          ...EMPTY_TIMING,
          latencyBreakdown: {
            ...EMPTY_TIMING.latencyBreakdown,
            arrival: summary(30),
            displayLatency: summary(60),
          },
          displayStalls: 2,
          displayStallMs: 950,
          stallCauses: createStallCauses({
            arrival: { count: 1, ms: 300 },
            decode: { count: 1, ms: 200 },
          }),
          lateFramesDropped: 1,
          missingObjects: 2,
          missingGroups: 1,
          subgroupStreamResets: 3,
          displayIntervalMs: { p50: 32.6, p95: 51.2, max: 51.2 },
          recentStalls: [
            {
              cause: "decode",
              durationMs: 150,
              mediaStepMs: 50.1,
              groupId: "13",
              objectId: "7",
              wallClockMs: Date.UTC(2026, 10, 1, 12, 0, 1),
            },
          ],
        },
        audio: {
          ...EMPTY_AUDIO,
          receiveDelayMs: 80,
          maxReceiveDelayMs: 80,
          playoutRebases: 1,
          playoutCompressedMs: 15,
          playoutConcealedMs: 25,
          playoutTiming: {
            ...EMPTY_AUDIO.playoutTiming,
            latenessMs: summary(3),
            startDelayMs: summary(110),
            missedFrames: 2,
            missedMs: 40,
            gapMs: 20,
            unrecoverableGapMs: 10,
          },
          playoutCatchUp: { catchUpStarts: 1, skippedMs: 60, catchingUp: false },
        },
        avSync: {
          ...EMPTY_AV_SYNC,
          skewMs: -8,
          presentationDelayMs: 70,
        },
      }),
      2_000,
    ),
  ];

  const report = summarizeDelayStall(samples);

  assert.equal(report.video.maxArrivalP95Ms, 40);
  assert.equal(report.video.maxDisplayLatencyP95Ms, 64);
  assert.equal(report.video.maxDisplayWaitP95Ms, null);
  assert.equal(report.video.stallCount, 2);
  assert.equal(report.video.stallMs, 950);
  assert.equal(report.video.maxSingleStallMs, 280);
  assert.deepEqual(report.video.stallCauses, [
    { cause: "arrival", count: 1, ms: 300 },
    { cause: "decode", count: 1, ms: 200 },
  ]);
  assert.equal(report.video.lateFramesDropped, 1);
  assert.equal(report.video.missingObjects, 2);
  assert.equal(report.video.missingGroups, 1);
  assert.equal(report.video.streamResets, 3);
  assert.equal(report.video.framesDecodedGrowth, 240);
  assert.equal(report.video.displayIntervalP50Ms, 32.6);
  assert.equal(report.video.maxDisplayIntervalP95Ms, 51.2);
  assert.equal(report.video.maxDisplayIntervalMs, 51.2);
  assert.equal(report.video.recentStalls.length, 1);
  assert.equal(report.video.recentStalls[0]?.mediaStepMs, 50.1);
  assert.equal(report.audio?.maxReceiveDelayMs, 80);
  assert.equal(report.audio?.maxLatenessP95Ms, 3);
  assert.equal(report.audio?.maxStartDelayP95Ms, 110);
  assert.equal(report.audio?.missedFrames, 2);
  assert.equal(report.audio?.missedMs, 40);
  assert.equal(report.audio?.gapMs, 20);
  assert.equal(report.audio?.unrecoverableGapMs, 10);
  assert.equal(report.audio?.catchUpStarts, 1);
  assert.equal(report.audio?.skippedMs, 60);
  assert.equal(report.audio?.rebases, 1);
  assert.equal(report.audio?.compressedMs, 15);
  assert.equal(report.audio?.concealedMs, 25);
  assert.equal(report.avSync.minSkewMs, -12);
  assert.equal(report.avSync.maxSkewMs, -8);
  assert.equal(report.avSync.lastPresentationDelayMs, 70);

  // 読み手が経路と再生のどちらで遅れたかをログだけで判断できること
  const lines = report.lines.join("\n");
  assert.include(lines, "遅延と停止の内訳 (2 秒の観測)");
  assert.include(lines, "映像の停止: 2 回 950.0 ms");
  assert.include(lines, "映像の表示間隔: p50 32.6 ms");
  assert.include(lines, "直近の停止 (古い順、最大 10 件)");
  assert.include(lines, "media step 50.1 ms");
  assert.include(lines, "Group 13 / Object 7");
  assert.include(lines, "到着 1 回 300.0 ms");
  assert.include(lines, "復号 1 回 200.0 ms");
  assert.include(lines, "音声の欠落: 鳴らさなかった 2 件 40.0 ms");
  assert.include(lines, "映像=経路 (到着 40.0 ms、受信側 24.0 ms)");
  assert.include(lines, "音声=経路 (到着 80.0 ms、予定への遅れ 3.0 ms)");
});

// 音声を購読していない観測でも、映像の遅延と停止だけのレポートを作れる
test("summarizeDelayStall: 音声が無い観測でも映像のレポートを作る", () => {
  const samples = [
    readDelayStallSample(createStats({ framesDecoded: 0 }), 0),
    readDelayStallSample(
      createStats({
        framesDecoded: 60,
        playoutTiming: {
          ...EMPTY_TIMING,
          latencyBreakdown: { ...EMPTY_TIMING.latencyBreakdown, arrival: summary(50) },
          displayStalls: 1,
          displayStallMs: 400,
          stallCauses: createStallCauses({ arrival: { count: 1, ms: 400 } }),
        },
        audio: null,
      }),
      1_000,
    ),
  ];
  const report = summarizeDelayStall(samples);
  assert.isNull(report.audio);
  const lines = report.lines.join("\n");
  assert.include(lines, "音声: 購読していない");
  assert.include(lines, "映像=経路");
});

// 分布がまだ無い (観測が短い) 場合は "-" にして、0 ms と誤読させない
test("summarizeDelayStall: 分布が無い値を 0 として扱わない", () => {
  const report = summarizeDelayStall([readDelayStallSample(createStats({}), 0)]);
  assert.isNull(report.video.maxArrivalP95Ms);
  assert.isNull(report.video.maxDisplayLatencyP95Ms);
  assert.isNull(report.audio?.maxLatenessP95Ms);
  const lines = report.lines.join("\n");
  assert.include(lines, "映像: 到着 p95 最大 - ms");
  assert.include(lines, "予定への遅れ p95 最大 - ms");
});

// 観測が 1 点も無ければ、空のレポートを返さずにエラーにする (呼び出し側の取り違えを止める)
test("summarizeDelayStall: 観測が無ければエラーにする", () => {
  assert.throws(() => summarizeDelayStall([]), "遅延と停止のレポートには 1 点以上の観測が必要");
});

// 1 秒ごとのログは、その時点の遅延と停止を 1 行で読めること
test("formatDelayStallSampleLine: その時点の遅延と停止を 1 行にする", () => {
  const sample = readDelayStallSample(
    createStats({
      framesDecoded: 120,
      playoutTiming: {
        ...EMPTY_TIMING,
        latencyBreakdown: {
          ...EMPTY_TIMING.latencyBreakdown,
          arrival: summary(40),
          displayWait: summary(10),
          displayLatency: summary(64),
        },
        displayStalls: 2,
        displayStallMs: 950,
      },
      audio: {
        ...EMPTY_AUDIO,
        receiveDelayMs: 55,
        playoutTiming: { ...EMPTY_AUDIO.playoutTiming, latenessMs: summary(3), missedFrames: 2 },
      },
    }),
    12_000,
  );
  const line = formatDelayStallSampleLine(sample);
  assert.include(line, "t=12s");
  assert.include(line, "video(arrival/p95=40.0");
  assert.include(line, "displayLatency/p95=64.0");
  assert.include(line, "stalls=2/950.0ms");
  assert.include(line, "audio(receive=55.0");
  assert.include(line, "lateness/p95=3.0");
  assert.include(line, "missed=2");
});
