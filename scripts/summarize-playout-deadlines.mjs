/** 元の入力記録と照合し、欠けた測定を除外せずに再生期限の結果を集計する。 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { createHash } from "node:crypto";
import { audioReplayFrames } from "./playout-reservation-analysis.mjs";

const [inputFile, runDirectory] = process.argv.slice(2);
if (inputFile === undefined || runDirectory === undefined)
  throw new Error("Expected an input recording and a measurement run directory");
const inputContent = readFileSync(inputFile);
const input = JSON.parse(inputContent.toString("utf8"));
const frames = audioReplayFrames(input);
const environment = JSON.parse(readFileSync(resolve(runDirectory, "environment.json"), "utf8"));
const inputSha256 = createHash("sha256").update(inputContent).digest("hex");
if (environment.audioTraceSha256 !== inputSha256)
  throw new Error("Measurement input hash does not match the supplied recording");
const files = readdirSync(runDirectory)
  .filter((name) => name.startsWith("deadlines|") && name.endsWith(".json"))
  .sort();
if (files.length !== environment.selectedCases.length)
  throw new Error(`Expected ${environment.selectedCases.length} results, found ${files.length}`);

const rms = (index) => {
  const samples = frames[Math.max(0, index)].samples;
  return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
};
const rows = files.map((name) => {
  const measurement = JSON.parse(readFileSync(resolve(runDirectory, name), "utf8"));
  if (measurement.trace.events.length !== frames.length)
    throw new Error(`Decoded frame count does not match: ${name}`);
  const gaps = measurement.coverage.gaps.map((gap) => {
    const next = measurement.trace.reservations.find(
      (reservation) => Math.abs(reservation.startSeconds - gap.endSeconds) < 1e-9,
    );
    if (next === undefined)
      throw new Error(`Cannot identify the reservation following a gap: ${name}`);
    const frameIndex = next.eventIndex;
    const event = measurement.trace.events[frameIndex];
    const neighborRms = Math.max(rms(frameIndex - 1), rms(frameIndex));
    const pastAtDecisionMs =
      Math.max(0, Math.min(gap.endSeconds, event.now) - gap.startSeconds) * 1000;
    return {
      ...gap,
      frameIndex,
      neighborRms,
      pastAtDecisionMs,
      becamePastWhileProcessingMs: gap.pastMs - pastAtDecisionMs,
      decision: event.decision,
      attempts: measurement.trace.attempts.filter((attempt) => attempt.eventIndex === frameIndex),
    };
  });
  const sum = (field) => gaps.reduce((total, gap) => total + gap[field], 0);
  return {
    name,
    valid: measurement.valid,
    rate: measurement.rate,
    frames: frames.length,
    gapMs: measurement.coverage.observedGapMs,
    expectedGapMs: measurement.coverage.expectedGapMs,
    statGapMs: measurement.stats.timing.gapMs,
    pastMs: sum("pastMs"),
    safetyLeadMs: sum("safetyLeadMs"),
    laterMs: sum("laterMs"),
    activeNeighborGapMs: gaps
      .filter((gap) => gap.neighborRms > 0.001)
      .reduce((total, gap) => total + gap.durationMs, 0),
    nonzeroGapSamples: sum("nonzeroInteriorSamples"),
    waveform: measurement.waveformComparison,
    reference: measurement.referenceComparison,
    marker: measurement.markerComparison,
    coverageMismatches: measurement.coverage.coverageMismatchSamples,
    schedulerMismatches: measurement.schedulerMismatches,
    attempts: measurement.trace.attempts.length,
    generated: measurement.trace.attempts.filter((attempt) => attempt.generatedSamples > 0).length,
    delay: measurement.stats.timing.startDelayMs,
    configuredTargetMs: measurement.stats.delay.targetMs,
    delivery: measurement.deliveryLatenessMs,
    processing: measurement.processingMs,
    videoCoverage: measurement.videoCoverage ?? null,
    gaps,
  };
});
console.log(
  JSON.stringify(
    {
      run: basename(runDirectory),
      browser: environment.browser,
      inputSha256,
      sourceSha256: environment.sourceTree.sha256,
      rows,
    },
    null,
    2,
  ),
);
