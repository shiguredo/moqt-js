/** 実 Chrome の同時収録を保存済みの Float32 から照合する。収録中に解析しない。 */
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import assert from "node:assert/strict";
import { compareOutputPcm, readFloat32Pcm } from "./playout-output-comparison.mjs";
import {
  encodedOpusReplayPackets,
  matchReceivedOpusPackets,
} from "./playout-encoded-opus-trace.mjs";
import { fingerprintFiles } from "./playout-source-fingerprint.mjs";

const directory = process.argv[2];
if (!directory) throw new Error("Usage: summarize-webrtc-playout.mjs <run-directory>");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const environmentBytes = readFileSync(join(directory, "environment.json"));
const environment = JSON.parse(environmentBytes);
const cases = environment.selectedCases;
if (!Array.isArray(cases) || cases.length === 0 || cases.some((entry) => entry.stage !== "webrtc"))
  throw new Error("Expected a completed WebRTC comparison run");
const actual = readdirSync(directory).filter(
  (name) => name.startsWith("webrtc|") && name.endsWith(".json"),
);
assert.equal(actual.length, cases.length, "全条件の収録が終了していること");
const rows = [];
for (const { caseName } of cases) {
  if (!/^webrtc\|(julius|kyoko)\|(clean|recurring60|jitter30)\|(44100|48000)$/.test(caseName))
    throw new Error(`Unexpected comparison case: ${caseName}`);
  const bytes = readFileSync(join(directory, `${caseName}.json`));
  const result = JSON.parse(bytes);
  assert.equal(result.valid, true, "有効な収録だけを比較すること");
  assert.equal(result.sourcesUnchanged, true, "収録中にソースが変わっていないこと");
  assert.equal(result.arrivalStage, "receiver-transform", "同じ受信境界で複製した入力であること");
  const packets = encodedOpusReplayPackets(result);
  assert.equal(result.encodedReplay?.maximumError, 0, "保存したパケットの再復号が一致すること");
  assert.equal(result.encodedReplay?.mismatchedFrames, 0, "全復号フレームが一致すること");
  assert.equal(result.encodedReplay?.decodedCount, packets.length, "再復号の件数が一致すること");
  assert.deepEqual(result.encodedReplay?.errors, [], "再復号でエラーがないこと");
  const outputBranches = [
    "webrtc",
    "current",
    ...(result.branchNames?.includes("comparison") ? ["comparison"] : []),
  ];
  assert.deepEqual(
    result.branchNames,
    [
      "input",
      "webrtc",
      "current",
      "decoded",
      ...outputBranches.filter((branch) => branch === "comparison"),
    ],
    "同じ収録経路があること",
  );
  const identity = matchReceivedOpusPackets(result.sentPackets, result.packets);
  const rawHashes = {};
  const recordings = Object.fromEntries(
    result.branchNames.map((branch) => {
      const raw = readFileSync(join(directory, `${caseName}-${branch}.f32`));
      rawHashes[branch] = digest(raw);
      return [branch, readFloat32Pcm(raw, result.captureSamples)];
    }),
  );
  const { input, decoded } = recordings;
  const sampleRate = result.contextRate;
  const inputAlignment = Object.fromEntries(
    [...outputBranches, "decoded"].map((branch) => [
      branch,
      compareOutputPcm({ reference: input, output: recordings[branch], sampleRate }),
    ]),
  );
  const decodedAlignment = Object.fromEntries(
    outputBranches.map((branch) => [
      branch,
      compareOutputPcm({
        reference: decoded,
        output: recordings[branch],
        sampleRate,
        minimumDelayMs: -400,
        maximumDelayMs: 200,
      }),
    ]),
  );
  // 加工しない復号参照は連続した時刻で予約されるため、全体に一定の遅延を持つ。
  // 原音との推定の中央 80 % が 2 ms に収まる場合だけ、その原点へ局所遅延を換算する。
  const calibration = inputAlignment.decoded.delayMs;
  const stableCalibration =
    calibration !== null &&
    inputAlignment.decoded.acceptedWindows >= 10 &&
    calibration.p90 - calibration.p10 <= 2;
  const calibratedLatency = Object.fromEntries(
    Object.entries(decodedAlignment).map(([branch, measurement]) => {
      const values = stableCalibration
        ? measurement.windows
            .filter((window) => window.accepted)
            .map((window) => window.delayMs + calibration.p50)
            .sort((left, right) => left - right)
        : [];
      const at = (fraction) =>
        values[Math.min(values.length - 1, Math.floor(values.length * fraction))];
      return [
        branch,
        values.length === 0 ? null : { p10: at(0.1), p50: at(0.5), p90: at(0.9), p95: at(0.95) },
      ];
    }),
  );
  rows.push({
    caseName,
    jsonSha256: digest(bytes),
    rawHashes,
    sampleRate,
    captureSamples: result.captureSamples,
    packetCount: packets.length,
    identity,
    inputAlignment,
    decodedAlignment,
    referenceCalibration: { stable: stableCalibration, delayMs: calibration },
    calibratedLatency,
    nativeStats: result.inbound,
    commonClockReplay: result.commonClockReplay ?? null,
    contextPlayback: result.contextPlayback ?? null,
    sdkStats: result.playout,
    comparisonStats: result.comparisonPlayout,
  });
}
process.stdout.write(
  JSON.stringify(
    {
      environmentSha256: digest(environmentBytes),
      browser: environment.browser,
      sourceSha256: environment.sourceTree.sha256,
      speechSha256: environment.speechInputs.sha256,
      analysisFiles: fingerprintFiles([
        "scripts/summarize-webrtc-playout.mjs",
        "scripts/playout-output-comparison.mjs",
        "scripts/playout-encoded-opus-trace.mjs",
      ]),
      cases: rows.length,
      rows,
    },
    null,
    2,
  ) + "\n",
);
