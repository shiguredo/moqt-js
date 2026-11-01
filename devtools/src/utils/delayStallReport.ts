/**
 * 実リレー経由の配信・購読で観測した「遅延」と「停止」を、経路と受信側に分けて 1 つの
 * レポートにする
 *
 * 目的は、sora-moq (relay) や経路、moqt-js の受信・復号、playout のどこで音声や映像が
 * 遅れたり止まったりしたのかを、実リレーの試験のログから確認できるようにすることである。
 * 値の判定 (しきい値) には使わない。しきい値は runner の速さで変わるため、判定は
 * それぞれの試験の不変条件に任せ、ここでは「どこで遅れたか」を読める形にだけする。
 *
 * 遅延の分け方:
 * - 経路: 映像は `latencyBreakdown.arrival` (TIMESTAMP から受信まで。publisher の符号化と
 *   送信、経路、relay を含む)、音声は `receiveDelayMs` (受信した壁時計 - LOC TIMESTAMP)
 * - 受信側: 映像は到着から表示まで (hold / decodeWait / decode / displayWait)、音声は
 *   予定への遅れ (`latenessMs`) と到着から鳴り始めまで (`startDelayMs`)
 * - 停止: 映像は表示間隔がフレーム間隔の 1.5 倍を超えた回数と原因 (`stallCauses`)、
 *   音声は鳴らさなかった音 (`missedFrames` / `missedMs`) と補間で埋まらない無音 (`gapMs`)
 *
 * ブラウザ API に依存しない純関数だけを置く。入力は devtools の `SubscriberStats` の
 * うち、このレポートに必要なフィールドだけを要求する (余分なフィールドがあってよい)。
 */

import type { StallCause } from "./stallAnalysis";
import type { StallCauseTotal } from "./playoutTimingStats";
import type { TimingSummary } from "../../../src/playout/timingSummary.ts";

/** 停止の原因の表示名 (devtools/src/utils/stallAnalysis.ts の StallCause に対応) */
const STALL_CAUSE_LABELS: Readonly<Record<string, string>> = {
  source: "配信側",
  loss: "欠落",
  discarded: "破棄",
  arrival: "到着",
  groupSwitchHold: "Group 切り替え待ち",
  decode: "復号",
  playout: "再生",
  render: "描画",
  unknown: "不明",
};

/** 原因ごとの止まり (回数と時間) */
export type DelayStallCauseTotal = StallCauseTotal;

/** レポートに必要な統計 (devtools の SubscriberStats から構造的に渡せる) */
export interface DelayStallStatsInput {
  /** 復号した映像フレーム数 (累積) */
  readonly framesDecoded: number;
  /** 映像の表示と遅延の計器 (devtools/src/utils/playoutTimingStats.ts) */
  readonly playoutTiming: {
    readonly latencyBreakdown: {
      readonly arrival: TimingSummary | null;
      readonly hold: TimingSummary | null;
      readonly decodeWait: TimingSummary | null;
      readonly decode: TimingSummary | null;
      readonly displayWait: TimingSummary | null;
      readonly displayLatency: TimingSummary | null;
    };
    /** 表示間隔がフレーム間隔の 1.5 倍を超えた回数 (累積) */
    readonly displayStalls: number;
    /** 止まりとみなした表示間隔の合計 (ミリ秒、累積) */
    readonly displayStallMs: number;
    /** 原因ごとの止まりの回数と時間 (累積) */
    readonly stallCauses: Readonly<Record<StallCause, DelayStallCauseTotal>>;
    /** 表示時刻を過ぎて捨てたフレーム数 (累積) */
    readonly lateFramesDropped: number;
    /** Group / Object の飛びで届かなかった数 (累積) */
    readonly missingObjects: number;
    readonly missingGroups: number;
    /** RESET_STREAM で終わった Subgroup の stream の数 (累積) */
    readonly subgroupStreamResets: number;
    /** 直近の止まり (古い順)。最大の停止時間を読む */
    readonly recentStalls: readonly { readonly cause: string; readonly durationMs: number }[];
  };
  /** 音声の統計 (音声を購読していなければ null) */
  readonly audio: {
    /** 直近に受信した音声 Object の到着の遅れ (ミリ秒) */
    readonly receiveDelayMs: number | null;
    /** 受信した音声 Object の到着の遅れの最大 (ミリ秒) */
    readonly maxReceiveDelayMs: number | null;
    readonly playoutTiming: {
      readonly playedMs: number;
      readonly slackMs: TimingSummary | null;
      readonly latenessMs: TimingSummary | null;
      readonly startDelayMs: TimingSummary | null;
      readonly missedFrames: number;
      readonly missedMs: number;
      /** 補間で埋まらなかった無音の穴 (ミリ秒、累積) */
      readonly gapMs: number;
      /** 補間で埋まらなかった無音の穴のうち、回復できなかったもの (ミリ秒、累積) */
      readonly unrecoverableGapMs: number;
    };
    readonly playoutCatchUp: {
      readonly catchUpStarts: number;
      readonly skippedMs: number;
      readonly catchingUp: boolean;
    };
    readonly playoutRebases: number;
    readonly playoutCompressedMs: number;
    readonly playoutConcealedMs: number;
  } | null;
  readonly avSync: {
    readonly skewMs: number | null;
    readonly presentationDelayMs: number | null;
    readonly delays: {
      readonly sharingBases: boolean;
      readonly unsharedReason: string;
      /** 音声の再生予算の内訳 (jitter buffer の目標・揺らぎ・出力の先行量) */
      readonly audioDelay: {
        readonly jitterMs: number | null;
        readonly targetMs: number;
        readonly outputLeadMs: number | null;
      };
    };
  };
}

/** 1 秒ごとの観測値 (JSON Lines として添付する) */
export interface DelayStallSample {
  /** 観測を始めてからの経過 (ミリ秒) */
  readonly tMs: number;
  readonly video: {
    readonly framesDecoded: number;
    readonly arrivalP95Ms: number | null;
    readonly holdP95Ms: number | null;
    readonly decodeWaitP95Ms: number | null;
    readonly decodeP95Ms: number | null;
    readonly displayWaitP95Ms: number | null;
    readonly displayLatencyP95Ms: number | null;
    readonly displayStalls: number;
    readonly displayStallMs: number;
    readonly lateFramesDropped: number;
    readonly missingObjects: number;
    readonly missingGroups: number;
    readonly subgroupStreamResets: number;
    /** 原因ごとの止まり (0 回の原因は含めない) */
    readonly stallCauses: Readonly<Record<string, DelayStallCauseTotal>>;
    /** 直近の止まりの最大時間 (ミリ秒) */
    readonly maxRecentStallMs: number | null;
  };
  readonly audio: {
    readonly receiveDelayMs: number | null;
    readonly maxReceiveDelayMs: number | null;
    readonly playedMs: number;
    readonly slackP95Ms: number | null;
    readonly latenessP95Ms: number | null;
    readonly startDelayP95Ms: number | null;
    readonly missedFrames: number;
    readonly missedMs: number;
    readonly gapMs: number;
    readonly unrecoverableGapMs: number;
    readonly catchUpStarts: number;
    readonly skippedMs: number;
    readonly rebases: number;
    readonly compressedMs: number;
    readonly concealedMs: number;
    readonly targetDelayMs: number;
    readonly jitterMs: number | null;
    readonly outputLeadMs: number | null;
  } | null;
  readonly avSync: {
    readonly skewMs: number | null;
    readonly presentationDelayMs: number | null;
    readonly sharingBases: boolean;
    readonly unsharedReason: string;
  };
}

/** 観測した値の 1 行レポート (1 秒ごとのログ用) */
export function formatDelayStallSampleLine(sample: DelayStallSample): string {
  const video = sample.video;
  const videoLine =
    `video(arrival/p95=${formatMs(video.arrivalP95Ms)}` +
    `, displayWait/p95=${formatMs(video.displayWaitP95Ms)}` +
    `, displayLatency/p95=${formatMs(video.displayLatencyP95Ms)}` +
    `, stalls=${video.displayStalls}/${formatMs(video.displayStallMs)}ms)`;
  if (sample.audio === null) {
    return `t=${formatSeconds(sample.tMs)}s ${videoLine}`;
  }
  const audio = sample.audio;
  const audioLine =
    `audio(receive=${formatMs(audio.receiveDelayMs)}` +
    `, lateness/p95=${formatMs(audio.latenessP95Ms)}` +
    `, missed=${audio.missedFrames}` +
    `, gap=${formatMs(audio.gapMs)}ms)`;
  return `t=${formatSeconds(sample.tMs)}s ${videoLine} ${audioLine}`;
}

/** まとめたレポート (行と、判定に使える主要値) */
export interface DelayStallReport {
  /** 画面やログに出す行 (日本語) */
  readonly lines: readonly string[];
  readonly video: {
    readonly maxArrivalP95Ms: number | null;
    readonly maxHoldP95Ms: number | null;
    readonly maxDecodeWaitP95Ms: number | null;
    readonly maxDecodeP95Ms: number | null;
    readonly maxDisplayWaitP95Ms: number | null;
    readonly maxDisplayLatencyP95Ms: number | null;
    /** 観測の間の止まりの回数と時間 (最後 − 最初) */
    readonly stallCount: number;
    readonly stallMs: number;
    /** 直近の止まりの最大時間 (ミリ秒)。止まりが無ければ null */
    readonly maxSingleStallMs: number | null;
    /** 原因ごとの止まり (観測の間の増分、時間の降順) */
    readonly stallCauses: readonly {
      readonly cause: string;
      readonly count: number;
      readonly ms: number;
    }[];
    readonly lateFramesDropped: number;
    readonly missingObjects: number;
    readonly missingGroups: number;
    readonly streamResets: number;
    readonly framesDecodedGrowth: number;
  };
  readonly audio: {
    readonly maxReceiveDelayMs: number | null;
    readonly maxLatenessP95Ms: number | null;
    readonly maxStartDelayP95Ms: number | null;
    readonly missedFrames: number;
    readonly missedMs: number;
    readonly gapMs: number;
    readonly unrecoverableGapMs: number;
    readonly catchUpStarts: number;
    readonly skippedMs: number;
    readonly rebases: number;
    readonly compressedMs: number;
    readonly concealedMs: number;
  } | null;
  readonly avSync: {
    readonly minSkewMs: number | null;
    readonly maxSkewMs: number | null;
    readonly lastPresentationDelayMs: number | null;
    readonly sharingBases: boolean;
    readonly unsharedReason: string;
  };
}

/**
 * 統計から 1 点分の観測値を取り出す
 *
 * @param stats - devtools の SubscriberStats (必要なフィールドだけ使う)
 * @param tMs - 観測を始めてからの経過 (ミリ秒)
 */
export function readDelayStallSample(stats: DelayStallStatsInput, tMs: number): DelayStallSample {
  const timing = stats.playoutTiming;
  const stallCauses: Record<string, DelayStallCauseTotal> = {};
  for (const [cause, total] of Object.entries(timing.stallCauses)) {
    if (total.count > 0 || total.ms > 0) {
      stallCauses[cause] = { count: total.count, ms: total.ms };
    }
  }
  let maxRecentStallMs: number | null = null;
  for (const stall of timing.recentStalls) {
    maxRecentStallMs =
      maxRecentStallMs === null ? stall.durationMs : Math.max(maxRecentStallMs, stall.durationMs);
  }
  return {
    tMs,
    video: {
      framesDecoded: stats.framesDecoded,
      arrivalP95Ms: p95Of(timing.latencyBreakdown.arrival),
      holdP95Ms: p95Of(timing.latencyBreakdown.hold),
      decodeWaitP95Ms: p95Of(timing.latencyBreakdown.decodeWait),
      decodeP95Ms: p95Of(timing.latencyBreakdown.decode),
      displayWaitP95Ms: p95Of(timing.latencyBreakdown.displayWait),
      displayLatencyP95Ms: p95Of(timing.latencyBreakdown.displayLatency),
      displayStalls: timing.displayStalls,
      displayStallMs: timing.displayStallMs,
      lateFramesDropped: timing.lateFramesDropped,
      missingObjects: timing.missingObjects,
      missingGroups: timing.missingGroups,
      subgroupStreamResets: timing.subgroupStreamResets,
      stallCauses,
      maxRecentStallMs,
    },
    audio:
      stats.audio === null
        ? null
        : {
            receiveDelayMs: stats.audio.receiveDelayMs,
            maxReceiveDelayMs: stats.audio.maxReceiveDelayMs,
            playedMs: stats.audio.playoutTiming.playedMs,
            slackP95Ms: p95Of(stats.audio.playoutTiming.slackMs),
            latenessP95Ms: p95Of(stats.audio.playoutTiming.latenessMs),
            startDelayP95Ms: p95Of(stats.audio.playoutTiming.startDelayMs),
            missedFrames: stats.audio.playoutTiming.missedFrames,
            missedMs: stats.audio.playoutTiming.missedMs,
            gapMs: stats.audio.playoutTiming.gapMs,
            unrecoverableGapMs: stats.audio.playoutTiming.unrecoverableGapMs,
            catchUpStarts: stats.audio.playoutCatchUp.catchUpStarts,
            skippedMs: stats.audio.playoutCatchUp.skippedMs,
            rebases: stats.audio.playoutRebases,
            compressedMs: stats.audio.playoutCompressedMs,
            concealedMs: stats.audio.playoutConcealedMs,
            targetDelayMs: stats.avSync.delays.audioDelay.targetMs,
            jitterMs: stats.avSync.delays.audioDelay.jitterMs,
            outputLeadMs: stats.avSync.delays.audioDelay.outputLeadMs,
          },
    avSync: {
      skewMs: stats.avSync.skewMs,
      presentationDelayMs: stats.avSync.presentationDelayMs,
      sharingBases: stats.avSync.delays.sharingBases,
      unsharedReason: stats.avSync.delays.unsharedReason,
    },
  };
}

/**
 * 観測値をまとめて、遅延と停止の内訳を作る
 *
 * 停止の回数と時間、鳴らさなかった音、捨てたフレームなどは累積値のため、観測の最初と
 * 最後の差を「観測の間の増分」として出す。到着と表示の遅れは直近 10 秒の分布のため、
 * 観測した各点の p95 の最大を出す。
 */
export function summarizeDelayStall(samples: readonly DelayStallSample[]): DelayStallReport {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error("遅延と停止のレポートには 1 点以上の観測が必要");
  }

  let maxArrivalP95Ms: number | null = null;
  let maxHoldP95Ms: number | null = null;
  let maxDecodeWaitP95Ms: number | null = null;
  let maxDecodeP95Ms: number | null = null;
  let maxDisplayWaitP95Ms: number | null = null;
  let maxDisplayLatencyP95Ms: number | null = null;
  let maxSingleStallMs: number | null = null;
  let maxSkewMs: number | null = null;
  let minSkewMs: number | null = null;
  for (const sample of samples) {
    maxArrivalP95Ms = maxNullable(maxArrivalP95Ms, sample.video.arrivalP95Ms);
    maxHoldP95Ms = maxNullable(maxHoldP95Ms, sample.video.holdP95Ms);
    maxDecodeWaitP95Ms = maxNullable(maxDecodeWaitP95Ms, sample.video.decodeWaitP95Ms);
    maxDecodeP95Ms = maxNullable(maxDecodeP95Ms, sample.video.decodeP95Ms);
    maxDisplayWaitP95Ms = maxNullable(maxDisplayWaitP95Ms, sample.video.displayWaitP95Ms);
    maxDisplayLatencyP95Ms = maxNullable(maxDisplayLatencyP95Ms, sample.video.displayLatencyP95Ms);
    maxSingleStallMs = maxNullable(maxSingleStallMs, sample.video.maxRecentStallMs);
    maxSkewMs = maxNullable(maxSkewMs, sample.avSync.skewMs);
    minSkewMs = minNullable(minSkewMs, sample.avSync.skewMs);
  }

  const causeKeys = new Set([
    ...Object.keys(first.video.stallCauses),
    ...Object.keys(last.video.stallCauses),
  ]);
  const stallCauses: { cause: string; count: number; ms: number }[] = [];
  for (const cause of causeKeys) {
    const count =
      (last.video.stallCauses[cause]?.count ?? 0) - (first.video.stallCauses[cause]?.count ?? 0);
    const ms = (last.video.stallCauses[cause]?.ms ?? 0) - (first.video.stallCauses[cause]?.ms ?? 0);
    if (count > 0 || ms > 0) {
      stallCauses.push({ cause, count, ms });
    }
  }
  stallCauses.sort((a, b) => b.ms - a.ms || b.count - a.count);

  const audio =
    last.audio === null
      ? null
      : {
          maxReceiveDelayMs: maxOfNullable(last.audio.maxReceiveDelayMs, last.audio.receiveDelayMs),
          maxLatenessP95Ms: maxLatenessP95(samples),
          maxStartDelayP95Ms: maxStartDelayP95(samples),
          missedFrames: last.audio.missedFrames - (first.audio?.missedFrames ?? 0),
          missedMs: last.audio.missedMs - (first.audio?.missedMs ?? 0),
          gapMs: last.audio.gapMs - (first.audio?.gapMs ?? 0),
          unrecoverableGapMs:
            last.audio.unrecoverableGapMs - (first.audio?.unrecoverableGapMs ?? 0),
          catchUpStarts: last.audio.catchUpStarts - (first.audio?.catchUpStarts ?? 0),
          skippedMs: last.audio.skippedMs - (first.audio?.skippedMs ?? 0),
          rebases: last.audio.rebases - (first.audio?.rebases ?? 0),
          compressedMs: last.audio.compressedMs - (first.audio?.compressedMs ?? 0),
          concealedMs: last.audio.concealedMs - (first.audio?.concealedMs ?? 0),
        };

  const report: DelayStallReport = {
    lines: [],
    video: {
      maxArrivalP95Ms,
      maxHoldP95Ms,
      maxDecodeWaitP95Ms,
      maxDecodeP95Ms,
      maxDisplayWaitP95Ms,
      maxDisplayLatencyP95Ms,
      stallCount: last.video.displayStalls - first.video.displayStalls,
      stallMs: last.video.displayStallMs - first.video.displayStallMs,
      maxSingleStallMs,
      stallCauses,
      lateFramesDropped: last.video.lateFramesDropped - first.video.lateFramesDropped,
      missingObjects: last.video.missingObjects - first.video.missingObjects,
      missingGroups: last.video.missingGroups - first.video.missingGroups,
      streamResets: last.video.subgroupStreamResets - first.video.subgroupStreamResets,
      framesDecodedGrowth: last.video.framesDecoded - first.video.framesDecoded,
    },
    audio,
    avSync: {
      minSkewMs,
      maxSkewMs,
      lastPresentationDelayMs: last.avSync.presentationDelayMs,
      sharingBases: last.avSync.sharingBases,
      unsharedReason: last.avSync.unsharedReason,
    },
  };
  return { ...report, lines: formatDelayStallReportLines(report, last.tMs - first.tMs) };
}

/** レポートの行を作る (テストと、レポートの再利用のため分ける) */
function formatDelayStallReportLines(report: DelayStallReport, observedMs: number): string[] {
  const lines: string[] = [];
  const seconds = observedMs / 1_000;
  lines.push(`遅延と停止の内訳 (${seconds.toFixed(0)} 秒の観測)`);
  lines.push(
    `映像: 到着 p95 最大 ${formatMs(report.video.maxArrivalP95Ms)} ms` +
      ` / 表示待ち p95 最大 ${formatMs(report.video.maxDisplayWaitP95Ms)} ms` +
      ` / 表示遅延 p95 最大 ${formatMs(report.video.maxDisplayLatencyP95Ms)} ms`,
  );
  const causes =
    report.video.stallCauses.length === 0
      ? "原因なし"
      : report.video.stallCauses
          .map(
            (cause) =>
              `${STALL_CAUSE_LABELS[cause.cause] ?? cause.cause} ${cause.count} 回 ` +
              `${formatMs(cause.ms)} ms`,
          )
          .join(" / ");
  lines.push(
    `映像の停止: ${report.video.stallCount} 回 ${formatMs(report.video.stallMs)} ms` +
      ` (${causes})、最大 ${formatMs(report.video.maxSingleStallMs)} ms` +
      `、遅着で捨て ${report.video.lateFramesDropped}` +
      `、欠落 Object ${report.video.missingObjects} / Group ${report.video.missingGroups}` +
      `、reset ${report.video.streamResets}`,
  );
  if (report.audio === null) {
    lines.push("音声: 購読していない");
  } else {
    lines.push(
      `音声: 到着の遅れ 最大 ${formatMs(report.audio.maxReceiveDelayMs)} ms` +
        ` / 予定への遅れ p95 最大 ${formatMs(report.audio.maxLatenessP95Ms)} ms` +
        ` / 鳴り始め p95 最大 ${formatMs(report.audio.maxStartDelayP95Ms)} ms`,
    );
    lines.push(
      `音声の欠落: 鳴らさなかった ${report.audio.missedFrames} 件 ` +
        `${formatMs(report.audio.missedMs)} ms` +
        `、補間で埋まらない無音 ${formatMs(report.audio.gapMs)} ms` +
        `、回復できない無音 ${formatMs(report.audio.unrecoverableGapMs)} ms` +
        `、追いつき ${report.audio.catchUpStarts} 回 ${formatMs(report.audio.skippedMs)} ms` +
        `、基準の取り直し ${report.audio.rebases} 回`,
    );
    lines.push(
      `音声の補間と圧縮: 補間 ${formatMs(report.audio.concealedMs)} ms` +
        ` / 時間圧縮 ${formatMs(report.audio.compressedMs)} ms`,
    );
  }
  lines.push(
    `A/V: skew ${formatRange(report.avSync.minSkewMs, report.avSync.maxSkewMs)} ms` +
      `、表示の遅れ ${formatMs(report.avSync.lastPresentationDelayMs)} ms` +
      `、基準の共有 ${
        report.avSync.sharingBases ? "あり" : `なし (${report.avSync.unsharedReason})`
      }`,
  );
  lines.push(formatAttribution(report));
  return lines;
}

/**
 * 遅延の主因を 1 行にする
 *
 * 経路 (到着) と受信側 (到着から表示まで / 予定への遅れ) の大きい方を書く。
 * どちらも小さい場合でも、値そのものを読めるようにする。
 */
function formatAttribution(report: DelayStallReport): string {
  const parts: string[] = [];
  const videoArrival = report.video.maxArrivalP95Ms;
  const videoSubscriberSide =
    report.video.maxDisplayLatencyP95Ms !== null && videoArrival !== null
      ? Math.max(0, report.video.maxDisplayLatencyP95Ms - videoArrival)
      : null;
  if (videoArrival !== null || videoSubscriberSide !== null) {
    const side =
      videoSubscriberSide !== null && (videoArrival === null || videoSubscriberSide > videoArrival)
        ? "受信側"
        : "経路";
    parts.push(
      `映像=${side} (到着 ${formatMs(videoArrival)} ms、受信側 ${formatMs(videoSubscriberSide)} ms)`,
    );
  }
  if (report.audio !== null) {
    const audioArrival = report.audio.maxReceiveDelayMs;
    const audioPlayout = report.audio.maxLatenessP95Ms;
    if (audioArrival !== null || audioPlayout !== null) {
      const side =
        audioArrival !== null && (audioPlayout === null || audioArrival > audioPlayout)
          ? "経路"
          : "再生";
      parts.push(
        `音声=${side} (到着 ${formatMs(audioArrival)} ms、予定への遅れ ${formatMs(audioPlayout)} ms)`,
      );
    }
  }
  return `遅延の主因: ${parts.length === 0 ? "値なし" : parts.join("、")}`;
}

/** 分布の p95 (値が無ければ null) */
function p95Of(summary: TimingSummary | null): number | null {
  return summary === null ? null : summary.p95;
}

/** 数値をミリ秒の表示にする (null は "-") */
function formatMs(value: number | null): string {
  return value === null ? "-" : value.toFixed(1);
}

/** 経過 (ミリ秒) を秒の表示にする */
function formatSeconds(tMs: number): string {
  return (tMs / 1_000).toFixed(0);
}

/** 2 つの値の範囲の表示にする (どちらかが null なら "-") */
function formatRange(min: number | null, max: number | null): string {
  return min === null || max === null ? "-" : `${min.toFixed(1)}..${max.toFixed(1)}`;
}

/** null を無視した最大値 */
function maxNullable(current: number | null, value: number | null): number | null {
  if (value === null) return current;
  return current === null ? value : Math.max(current, value);
}

/** null を無視した最小値 */
function minNullable(current: number | null, value: number | null): number | null {
  if (value === null) return current;
  return current === null ? value : Math.min(current, value);
}

/** null を無視した最大値 (2 引数版) */
function maxOfNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/** 観測した各点の audio.latenessMs.p95 の最大 */
function maxLatenessP95(samples: readonly DelayStallSample[]): number | null {
  let max: number | null = null;
  for (const sample of samples) {
    if (sample.audio !== null) {
      max = maxNullable(max, sample.audio.latenessP95Ms);
    }
  }
  return max;
}

/** 観測した各点の audio.startDelayMs.p95 の最大 */
function maxStartDelayP95(samples: readonly DelayStallSample[]): number | null {
  let max: number | null = null;
  for (const sample of samples) {
    if (sample.audio !== null) {
      max = maxNullable(max, sample.audio.startDelayP95Ms);
    }
  }
  return max;
}
