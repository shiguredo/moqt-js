/** 製品コードを変更せず、遅延推定だけが異なる実測用のソースを保存する。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const directory = resolve(process.argv[2] ?? `investigation-logs/delay-variants-${Date.now()}`);
if (!directory.startsWith(`${resolve("investigation-logs")}/`))
  throw new Error("Measurement variants must be written under investigation-logs");
if (existsSync(directory)) throw new Error("Measurement variant directory already exists");
// 製品側へ採用した後も、同じ対照と不採用候補を再現できるよう基準を固定する。
const requestedRevision =
  process.env.PLAYOUT_BASE_REVISION ?? "a011728e8c01563b35ecf5c345535d0a6c209e1e";
const baseRevision = execFileSync(
  "git",
  ["rev-parse", "--verify", "--end-of-options", `${requestedRevision}^{commit}`],
  { encoding: "utf8", timeout: 10000 },
).trim();
const archive = execFileSync("git", ["archive", baseRevision, "src"], {
  timeout: 10000,
  maxBuffer: 16 * 1024 * 1024,
});
mkdirSync(directory, { recursive: true });
writeFileSync(`${directory}/baseline.json`, JSON.stringify({ baseRevision }, null, 2));

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2)
    throw new Error(`Expected exactly one source marker: ${before}`);
  return source.replace(before, after);
}

for (const variant of [
  "baseline",
  "window500",
  "intervalPeak",
  "spikeGate",
  "instantCorrection",
  "upwardCorrection",
  "spikeInstant",
  "startupAware",
  "videoStartup",
  "startup60",
  "startup70",
]) {
  const root = `${directory}/${variant}`;
  mkdirSync(root);
  execFileSync("tar", ["-x", "--strip-components=1", "-C", root], {
    input: archive,
    timeout: 10000,
  });
  const path = `${root}/playout/timeline.ts`;
  let source = readFileSync(path, "utf8");
  if (variant === "window500")
    source = replaceOnce(
      source,
      "PLAYOUT_JITTER_WINDOW_MS = 2_000",
      "PLAYOUT_JITTER_WINDOW_MS = 500",
    );
  if (variant === "intervalPeak") {
    writeFileSync(
      `${root}/playout/labIntervalPeakDelay.mjs`,
      readFileSync("scripts/playout-delay-estimators.mjs"),
    );
    source = `import { IntervalPeakDelay } from "./labIntervalPeakDelay.mjs";\n${source}`;
    source = replaceOnce(
      source,
      "readonly learningOffsets: TimedValues;",
      "readonly learningOffsets: TimedValues;\n  readonly intervalPeak: IntervalPeakDelay;",
    );
    source = replaceOnce(
      source,
      "learningOffsets: new TimedValues(),",
      "learningOffsets: new TimedValues(),\n      intervalPeak: new IntervalPeakDelay(),",
    );
    source = replaceOnce(
      source,
      "state.learningOffsets.push(wallClockMs, offsetMs);",
      "state.learningOffsets.push(wallClockMs, offsetMs);\n      state.intervalPeak.observe(wallClockMs, Math.max(0, offsetMs - baseMs));",
    );
    source = replaceOnce(
      source,
      "const jitterMs = percentile(jitters, playoutDelayPercentile(this.frameIntervalMs(state)));",
      'const jitterMs = stream === "audio"\n      ? (state.intervalPeak.delayMs ?? 0)\n      : percentile(jitters, playoutDelayPercentile(this.frameIntervalMs(state)));',
    );
  }
  if (variant === "spikeGate" || variant === "spikeInstant") {
    writeFileSync(
      `${root}/playout/labSpikeDelayGate.mjs`,
      readFileSync("scripts/playout-delay-estimators.mjs"),
    );
    source = `import { SpikeDelayGate } from "./labSpikeDelayGate.mjs";\n${source}`;
    source = replaceOnce(
      source,
      "readonly learningOffsets: TimedValues;",
      "readonly learningOffsets: TimedValues;\n  readonly spikeGate: SpikeDelayGate;",
    );
    source = replaceOnce(
      source,
      "learningOffsets: new TimedValues(),",
      "learningOffsets: new TimedValues(),\n      spikeGate: new SpikeDelayGate(),",
    );
    source = replaceOnce(
      source,
      "state.learningOffsets.push(wallClockMs, offsetMs);",
      `if (state.spikeGate.observe(\n        Math.max(0, offsetMs - baseMs),\n        stream === "audio" ? (this.audioJitterMs ?? 0) : (state.delayMs ?? 0),\n        this.frameIntervalMs(state) ?? 20,\n      )) state.learningOffsets.push(wallClockMs, offsetMs);`,
    );
    source = replaceOnce(
      source,
      "const jitterMs = percentile(jitters, playoutDelayPercentile(this.frameIntervalMs(state)));",
      `const learnedJitterMs = percentile(jitters, playoutDelayPercentile(this.frameIntervalMs(state)));\n    const jitterMs = state.spikeGate.active\n      ? Math.max(learnedJitterMs, Math.max(0, offsetMs - baseMs))\n      : learnedJitterMs;`,
    );
    source = replaceOnce(
      source,
      "this.audioJitterMs = jitters.length === 0 ? null : jitterMs;",
      "this.audioJitterMs = jitters.length === 0 && !state.spikeGate.active ? null : jitterMs;",
    );
  }
  if (variant === "instantCorrection" || variant === "spikeInstant")
    source = replaceOnce(
      source,
      "this.audioPlayoutCorrectionMs += weight * (residualMs - this.audioPlayoutCorrectionMs);",
      "this.audioPlayoutCorrectionMs = residualMs;",
    );
  if (variant === "upwardCorrection")
    source = replaceOnce(
      source,
      "this.audioPlayoutCorrectionMs += weight * (residualMs - this.audioPlayoutCorrectionMs);",
      "this.audioPlayoutCorrectionMs += (residualMs > this.audioPlayoutCorrectionMs ? 1 : weight) * (residualMs - this.audioPlayoutCorrectionMs);",
    );
  if (["startupAware", "videoStartup", "startup60", "startup70"].includes(variant)) {
    source = replaceOnce(
      source,
      "let learns = false;",
      "let learns = false;\n    let regularArrival = false;",
    );
    source = replaceOnce(
      source,
      "learns = wallClockMs - state.lastArrivalMs >= intervalMs / 2;",
      "learns = wallClockMs - state.lastArrivalMs >= intervalMs / 2;\n      regularArrival = intervalMs > 0 && learns && wallClockMs - state.lastArrivalMs <= intervalMs * 2;",
    );
    source = replaceOnce(
      source,
      "!this.isCatchingUp(state, wallClockMs, baseMs)",
      "!this.isCatchingUp(state, wallClockMs, baseMs, offsetMs, regularArrival)",
    );
    source = replaceOnce(
      source,
      "private isCatchingUp(state: StreamState, nowMs: number, baseMs: number): boolean",
      "private isCatchingUp(state: StreamState, nowMs: number, baseMs: number, offsetMs: number, regularArrival: boolean): boolean",
    );
    source = replaceOnce(
      source,
      "catchUpCheckpoint: { atMs: number; baseMs: number } | null;",
      "catchUpCheckpoint: { atMs: number; baseMs: number; rechecked: boolean } | null;",
    );
    const checkpointMarker = "state.catchUpCheckpoint = { atMs: nowMs, baseMs };";
    if (source.split(checkpointMarker).length !== 3)
      throw new Error("Expected exactly two checkpoint assignments");
    source = source.replaceAll(
      checkpointMarker,
      "state.catchUpCheckpoint = { atMs: nowMs, baseMs, rechecked: false };",
    );
    source = replaceOnce(
      source,
      "state.catchingUp = false;",
      `const delayedArrival = !regularArrival && offsetMs - baseMs > Math.max(CATCH_UP_MIN_BASE_DROP_MS, this.frameIntervalMs(state) ?? 0);\n    if (delayedArrival && !checkpoint.rechecked) {\n      state.catchUpCheckpoint = { atMs: nowMs, baseMs, rechecked: true };\n      return true;\n    }\n    state.catchingUp = false;`,
    );
    if (variant === "videoStartup")
      source = replaceOnce(
        source,
        "!this.isCatchingUp(state, wallClockMs, baseMs, offsetMs, regularArrival)",
        '!this.isCatchingUp(state, wallClockMs, baseMs, offsetMs, regularArrival || stream === "audio")',
      );
  }
  if (variant === "startup60" || variant === "startup70")
    source = replaceOnce(
      source,
      "AUDIO_PLAYOUT_DELAY_FLOOR_MS = 50",
      `AUDIO_PLAYOUT_DELAY_FLOOR_MS = ${variant === "startup60" ? 60 : 70}`,
    );
  writeFileSync(path, source);
}
console.log(directory);
