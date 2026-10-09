/**
 * 統計のセクションの (?) から開く説明
 *
 * 画面の文言のため英語で書く。区間と止まりの原因は Record で持ち、区間や原因を足したときに
 * 説明の書き忘れを型で検出する。窓の長さや閾値は統計の実装の定数から埋め込み、説明と
 * 実装がずれないようにする。
 */

import type { SectionHelp } from "./StatsView";
import { LATENCY_SEGMENTS, type LatencySegment } from "../utils/latencyBreakdown";
import { PLAYOUT_BASE_DRIFT_MS } from "../../../src/playbackTimeline";
import {
  AUDIO_MISS_REASONS,
  MAX_RECENT_AUDIO_MISSES,
  type AudioMissReason,
} from "../../../src/audioPlayoutTimingStats.ts";
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

/**
 * subscriber の A/V Sync
 *
 * 遅延の内訳は「表示の遅れがどこで生じているか」を分けて見るためのものである。
 * 音声と映像で同じ項目を出し、比べて改善できるようにする。
 */
export const AV_SYNC_HELP: SectionHelp = {
  summary:
    "How the presentation time of each track is decided, and whether the two tracks are treated as one clock. The presentation time is TIMESTAMP + baseDelayMs + jitterDelayMs (at least targetLatencyMs), and the leading track is delayed further by syncExtraDelayMs to keep the two presentation times within the deadband.",
  formula:
    "presentationDelayMs = baseDelayMs + max(jitterDelayMs, targetLatencyMs) + syncExtraDelayMs",
  items: [
    {
      term: "skewMs",
      description:
        "Measured A/V skew (ms). Positive when the video is presented later than the audio. Uses the recorded presentation times, so it does not include the output latency of the audio device nor the render cycle of the display.",
    },
    {
      term: "baseDelayMs",
      description:
        "Minimum of (decoder output wall clock - TIMESTAMP) over the window, per track (ms). Includes the clock offset between the publisher and this machine, and the minimum path and decode delay.",
    },
    {
      term: "jitterDelayMs",
      description:
        "Jitter buffer delay of the track (ms). The audio uses the NetEq rule (0.95 quantile of arrival delay), the video the percentile of the jitter that keeps late frames within the budget.",
    },
    {
      term: "syncExtraDelayMs",
      description:
        "Extra delay the A/V sync added to this track (ms). The leading track gets the extra so that both presentation times stay within the deadband; it is released at the decay rate.",
    },
    {
      term: "presentationDelayMs",
      description:
        "TIMESTAMP to presentation (ms). - while the track is not using its TIMESTAMP (not observed yet, or its clock is out of range), in which case it is played by arrival instead.",
    },
    {
      term: "baseDifferenceMs",
      description:
        "baseDelayMs of the audio minus that of the video (ms). The A/V sync is driven by this difference, so it is the amount one track has to be delayed for the other.",
    },
    {
      term: "sharingBases",
      description:
        "Whether both tracks are treated as one clock. false while one of them is not observed yet, when the difference cannot be compensated within the delay cap, or when the difference keeps moving.",
    },
    {
      term: "unsharedReason",
      description:
        "unobserved: a base or a delay is not decided yet. difference: the base difference is larger than the delay cap. drift: the base difference keeps moving, which is a TIMESTAMP clock offset (e.g. the audio drift in issue 0754) rather than a path delay. hold: the decision to stop sharing is kept for a while so that the threshold (which moves with the jitter buffer delay) cannot make it flap.",
    },
    {
      term: "baseDriftMsPerSecond",
      description: `Movement of baseDifferenceMs over the recent window (ms/s). The tracks are unshared when the movement exceeds the drift limit (${PLAYOUT_BASE_DRIFT_MS} ms).`,
    },
    {
      term: "targetLatencyMs",
      description:
        "targetLatency resolved from the catalog (ms). Unset or unusable when -. The jitter buffer delay of both tracks never goes below it.",
    },
    {
      term: "targetLatencyLimitedMs",
      description:
        "Amount of targetLatency that did not fit in the delay cap (ms). The effective lower bound is targetLatencyMs - targetLatencyLimitedMs.",
    },
    {
      term: "audioClockFallback",
      description:
        "Whether the audio playout falls back to AudioContext.currentTime because getOutputTimestamp() is not available. The audio is then scheduled without the output latency, so it plays later than the target.",
    },
  ],
  notes: [
    `baseDelayMs: ${CLOCK_OFFSET_NOTE}`,
    "The two tracks are delayed independently while sharingBases is true. Within the deadband neither track follows the jitter buffer delay of the other.",
    "Both tracks are played by arrival while unsharedReason is drift or difference, which keeps the A/V skew at the difference of the two delays instead of the base difference.",
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

/** 鳴らさなかった理由ごとの説明 (src/audioPlayoutTimingStats.ts の理由の定義) */
const AUDIO_MISS_REASON_DESCRIPTIONS: Record<AudioMissReason, string> = {
  backlog:
    "The sound was dropped because the playout was too far behind (the queued sounds exceeded the delay plus the backlog limit).",
  catchUp:
    "The sound was not played because it was received from the relay cache before the subscription caught up. Decoded but skipped on purpose.",
  error: "Playing the sound failed (stretch, concealment or scheduling threw).",
  stopped:
    "The sound was already scheduled but had not started when the playback stopped (toggle off, unsubscribe, panel removal). Closing the AudioContext cut it.",
};

/** subscriber の Audio Playback の Timing */
export const AUDIO_PLAYBACK_TIMING_HELP: SectionHelp = {
  summary: `Timing of received audio. The playout time comes from the LOC TIMESTAMP, the arrival is when the decoded AudioData reached the subscriber, and the start is when the sound was scheduled on the AudioContext clock. Distributions are p50 / p95 / max over the last ${PLAYBACK_WINDOW_SECONDS} s (ms).`,
  formula: "lateness = start - target, slack = target - arrival, startDelay = start - arrival",
  items: [
    {
      term: "slack",
      description:
        "target - arrival (ms). How much earlier the sound arrived than its playout time; negative means it arrived after its playout time (it could not make it).",
    },
    {
      term: "startDelay",
      description: "start - arrival (ms). How long after the arrival the sound starts.",
    },
    {
      term: "lateness",
      description:
        "start - target (ms). How much later than the playout time the sound starts; 0 means on time. The sound is never dropped for being late. While the sound is still playing, it keeps playing late (the media time is not skipped); only a sound that arrives more than the lateness limit (500 ms) late with nothing playing is re-planned by arrival, which jumps the media time.",
    },
    {
      term: "lastTargetMs / lastArrivalMs / lastStartMs",
      description:
        "The three times of the last sound that was played, on the performance.now() axis (ms). lastTargetMs is - while the playout time cannot be decided.",
    },
    {
      term: "playedFrames / playedMs",
      description:
        "Sounds scheduled to play, and their total length after the stretch (cumulative). Includes the sounds played by arrival.",
    },
    {
      term: "arrivalPlannedFrames",
      description:
        "Sounds played by arrival because their playout time could not be used (no wall-clock TIMESTAMP, the jitter buffer is off, or the track clock is not shared with the video). They are planned to start a small fixed delay after the arrival, so startDelay stays small. With slackMs / latenessMs showing -, the timeline is not deciding the playout time.",
    },
    {
      term: "unplannedFrames",
      description:
        "Sounds played without any plan (neither the playout time nor the arrival plan). Normally 0; a value above 0 means the caller did not pass a plan.",
    },
  ],
  notes: [
    "The start is the time reserved on the AudioContext clock, so the output latency of the device is not included. Use the A/V Sync audioClockFallback to see whether the clock is mapped by getOutputTimestamp() or by currentTime.",
    "Only the subscriber's own pipeline is measured. A sound that never arrives or never gets decoded does not appear here (compare audio.objectsReceived / chunksDecoded with audio.playoutTiming.playedFrames).",
  ],
};

/** subscriber の Audio Playback の Missed */
export const AUDIO_PLAYBACK_MISSED_HELP: SectionHelp = {
  summary: `Sounds that should have been played but were not, with their total length. Cumulative since subscribing started. The counts and the ms add up to the total.`,
  items: [
    ...AUDIO_MISS_REASONS.map((reason) => ({
      term: reason,
      description: AUDIO_MISS_REASON_DESCRIPTIONS[reason],
    })),
    {
      term: "recentMisses",
      description: `Last ${MAX_RECENT_AUDIO_MISSES} missed sounds, newest first: time (UTC), reason, length and the slack at that time.`,
    },
  ],
  notes: [
    "While playback is off (playbackEnabled false) no sound is expected, so nothing is counted.",
    "backlog is the sound that could not make its playout time (the queue ran ahead). Being late never drops a sound; catchUp and stopped are sounds that were dropped on purpose or by stopping.",
    "backlog equals the playoutDrops counter above; this one also carries the length in ms and the reason.",
  ],
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
        "subgroupStreamResets per RESET_STREAM error code (draft-ietf-moq-transport-22 Section 12.5).",
    },
    {
      term: "recentLossEvents",
      description: `Last ${MAX_RECENT_LOSS_EVENTS} stream resets and loss stalls, newest first (UTC). Kept apart from recentStalls, so arrival stalls do not push them out.`,
    },
  ],
};
