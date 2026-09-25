/**
 * 統計のセクションの (?) から開く説明
 *
 * 画面の文言のため英語で書く。区間と止まりの原因は Record で持ち、区間や原因を足したときに
 * 説明の書き忘れを型で検出する。窓の長さや閾値は統計の実装の定数から埋め込み、説明と
 * 実装がずれないようにする。
 */

import type { SectionHelp } from "./StatsView";
import { LATENCY_SEGMENTS, type LatencySegment } from "../utils/latencyBreakdown";
import {
  DISPLAY_FPS_WINDOW_MS,
  DISPLAY_STALL_FACTOR,
  MAX_RECENT_LOSS_EVENTS,
  MAX_RECENT_STALLS,
  PLAYBACK_TIMING_WINDOW_MS,
} from "../utils/playbackTimingStats";
import { PUBLISH_TIMING_WINDOW_MS } from "../utils/publishTimingStats";
import { STALL_CAUSES, type StallCause } from "../utils/stallAnalysis";

// 分布を求める窓 (秒)
const PLAYBACK_WINDOW_SECONDS = PLAYBACK_TIMING_WINDOW_MS / 1_000;
const PUBLISH_WINDOW_SECONDS = PUBLISH_TIMING_WINDOW_MS / 1_000;

/** 分布の表の左上に出す窓の長さと単位 */
export const PLAYBACK_TIMING_CAPTION = `last ${PLAYBACK_WINDOW_SECONDS} s, ms`;
export const PUBLISH_TIMING_CAPTION = `last ${PUBLISH_WINDOW_SECONDS} s, ms`;

/** 別のマシンで時計のずれを含むことの注意 */
const CLOCK_OFFSET_NOTE =
  "Uses the publisher's wall-clock TIMESTAMP (LOC), so the value includes the clock offset when the publisher runs on another machine.";

// subscriber の区間ごとの説明 (latencyBreakdown.ts の区間の定義)
const LATENCY_SEGMENT_DESCRIPTIONS: Record<LatencySegment, string> = {
  arrival:
    "TIMESTAMP to received. Includes publisher encoding and sending, the network path and the relay.",
  hold: "Received to released from the group switch hold.",
  decodeWait: "Released to passed to the decoder (e.g. waiting for decode order).",
  decode: "Passed to the decoder to decoder output.",
  displayWait: "Decoder output to rendered (jitter buffer wait and render cycle).",
  displayLatency: "TIMESTAMP to rendered. The sum of the stages above.",
};

/** 表示の遅延は、それ以外の区間の和になる (表では合計の行にする) */
export const TOTAL_LATENCY_SEGMENT: LatencySegment = "displayLatency";
const LATENCY_STAGE_SEGMENTS = LATENCY_SEGMENTS.filter(
  (segment) => segment !== TOTAL_LATENCY_SEGMENT,
);

/** subscriber の Latency Breakdown */
export const SUBSCRIBER_LATENCY_BREAKDOWN_HELP: SectionHelp = {
  summary: `Latency of each rendered frame, split into stages. p50 / p95 / max over the last ${PLAYBACK_WINDOW_SECONDS} s (ms).`,
  formula: `${LATENCY_STAGE_SEGMENTS.join(" + ")} = ${TOTAL_LATENCY_SEGMENT}`,
  items: LATENCY_SEGMENTS.map((segment) => ({
    term: segment,
    description: LATENCY_SEGMENT_DESCRIPTIONS[segment],
  })),
  notes: [
    "The sum holds for each frame. Percentiles of the stages do not add up.",
    `arrival and displayLatency: ${CLOCK_OFFSET_NOTE}`,
    "For delays inside the publisher, see the publisher's Latency Breakdown.",
  ],
};

/** publisher の Latency Breakdown */
export const PUBLISHER_LATENCY_BREAKDOWN_HELP: SectionHelp = {
  summary: `Delay inside the publisher. p50 / p95 / max over the last ${PUBLISH_WINDOW_SECONDS} s (ms).`,
  items: [
    {
      term: "encode",
      description: "Frame read to encoder output. Includes waiting in the encoder queue.",
    },
    {
      term: "send",
      description:
        "Encoder output to sendObject completion (written to the WebTransport stream). Includes moqt-js send queueing and WebTransport backpressure.",
    },
    {
      term: "encodeQueueDrops",
      description:
        "Frames dropped without encoding because the encoder queue exceeded its limit. Cumulative since publishing started.",
    },
  ],
  notes: ["The subscriber's arrival is encode + send + the network path and the relay."],
};

/** subscriber の Decoding Pipeline */
export const DECODING_PIPELINE_HELP: SectionHelp = {
  summary: "How received video Objects reach the decoder. Cumulative since subscribing started.",
  items: [
    { term: "chunksCreated", description: "EncodedVideoChunks created from received Objects." },
    { term: "chunksDecoded", description: "Chunks passed to the decoder." },
    {
      term: "chunksSkipped",
      description: "Chunks not decoded because the decoder was not configured.",
    },
    {
      term: "staleFramesDropped",
      description:
        "Frames not decoded because they belong to a Group older than the one being decoded, or are duplicate or late.",
    },
    {
      term: "missingReferenceFramesDropped",
      description:
        "Frames not decoded while waiting for a keyframe, because a frame they reference is missing.",
    },
    { term: "decodeErrors", description: "Errors from the video and audio decoders." },
  ],
};

/** subscriber の Playback Timing */
export const PLAYBACK_TIMING_HELP: SectionHelp = {
  summary: `Timing of received video frames. Distributions are p50 / p95 / max over the last ${PLAYBACK_WINDOW_SECONDS} s (ms). Counters are cumulative since subscribing started.`,
  items: [
    {
      term: "arrivalJitter",
      description:
        "Arrival time minus TIMESTAMP, relative to the minimum in the window. Not affected by clock offset.",
    },
    {
      term: "latency",
      description: "Arrival wall clock minus TIMESTAMP, for every received frame.",
    },
    {
      term: "decodeTime",
      description: "Passed to the decoder to decoder output.",
    },
    { term: "displayInterval", description: "Interval between rendered frames." },
    {
      term: "displayFps",
      description: `Frames rendered in the last ${DISPLAY_FPS_WINDOW_MS / 1_000} s.`,
    },
    {
      term: "displayStalls",
      description: `Display intervals longer than ${DISPLAY_STALL_FACTOR}x the frame interval.`,
    },
    { term: "displayStallMs", description: "Total duration of those display intervals (ms)." },
    {
      term: "displayQueueDrops",
      description: "Frames dropped because the display queue overflowed.",
    },
    {
      term: "playoutDelayMs",
      description:
        "Current playout delay of the jitter buffer (ms). - while the jitter buffer is not active.",
    },
    {
      term: "lateFramesDropped",
      description:
        "Frames the jitter buffer dropped because they missed their display time. When 3 or more frames are past due, all but the newest 2 are dropped.",
    },
  ],
  notes: [`latency: ${CLOCK_OFFSET_NOTE}`],
};

// 止まりの原因ごとの説明 (stallAnalysis.ts の判定)
const STALL_CAUSE_DESCRIPTIONS: Record<StallCause, string> = {
  source:
    "The publisher did not capture frames. The TIMESTAMP jumps while the Object positions are consecutive.",
  loss: "Objects between the two frames had not arrived when they were needed.",
  discarded: "The next frame was received but discarded without being decoded.",
  arrival: "The next frame arrived too late to be decoded in time (network path or relay).",
  groupSwitchHold: "The next frame was held too long by the group switch hold.",
  decode: "The decoder output the next frame after its display time.",
  playout:
    "The frame was ready, but the jitter buffer's display time was late (the playout delay increased).",
  render: "The frame was ready at its display time, but rendering was late.",
  unknown:
    "Not enough records to decide (older than the window), or the frame took an unexpected path.",
};

/** subscriber の Stall Causes */
export const STALL_CAUSES_HELP: SectionHelp = {
  summary: `A stall is a display interval longer than ${DISPLAY_STALL_FACTOR}x the frame interval. Each stall is attributed to one cause, based on what happened to the frame that should have been rendered next. Count and total time since subscribing started.`,
  items: [
    ...STALL_CAUSES.map((cause) => ({
      term: cause,
      description: STALL_CAUSE_DESCRIPTIONS[cause],
    })),
    {
      term: "recentStalls",
      description: `Last ${MAX_RECENT_STALLS} stalls, newest first: time (UTC), cause, duration, Group / Object of the frame rendered after the stall, and TIMESTAMP step.`,
    },
  ],
};

/** subscriber の Loss */
export const LOSS_HELP: SectionHelp = {
  summary: "Objects and streams that did not arrive. Cumulative since subscribing started.",
  items: [
    { term: "missingObjects", description: "Objects skipped within a Group (Object ID gap)." },
    { term: "missingGroups", description: "Groups skipped (Group ID gap)." },
    { term: "subgroupStreamResets", description: "Subgroup streams ended by RESET_STREAM." },
    {
      term: "groupSwitchHoldExpirations",
      description:
        "Group switch holds released by the time limit, before the previous Group's stream ended.",
    },
    {
      term: "subgroupStreamResetsByCode",
      description:
        "subgroupStreamResets per RESET_STREAM error code (draft-ietf-moq-transport-21 Section 12.5).",
    },
    {
      term: "recentLossEvents",
      description: `Last ${MAX_RECENT_LOSS_EVENTS} stream resets and loss stalls, newest first (UTC). Kept apart from recentStalls, so arrival stalls do not push them out.`,
    },
  ],
};
