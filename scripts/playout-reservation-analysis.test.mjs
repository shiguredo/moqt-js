/** 自然な無音と予約の欠落を区別し、計測器の異常も検出する。 */
import { test, assert } from "vite-plus/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  analyseReservationCoverage,
  audioReplayFrames,
  comparePcmSamples,
} from "./playout-reservation-analysis.mjs";

test("集計器は別の音源との照合と未完了の測定を拒否する", () => {
  // 実ファイルと実プロセスを使い、誤った入力で活動区間を分類しないことを検査する。
  const directory = mkdtempSync(join(tmpdir(), "playout-deadline-summary-"));
  try {
    const inputFile = join(directory, "input.json");
    const input = JSON.stringify({
      valid: true,
      audio: [{ atMs: 0 }, { atMs: 20 }],
      decodedFrames: [0, 20000].map((timestamp) => ({
        timestamp,
        sampleRate: 48000,
        channels: 1,
        samples: Array.from({ length: 960 }, () => 0.2),
      })),
    });
    writeFileSync(inputFile, input);
    for (const inputHash of ["wrong", createHash("sha256").update(input).digest("hex")]) {
      writeFileSync(
        join(directory, "environment.json"),
        JSON.stringify({ audioTraceSha256: inputHash, selectedCases: [{}] }),
      );
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("./summarize-playout-deadlines.mjs", import.meta.url)),
          inputFile,
          directory,
        ],
        {
          encoding: "utf8",
          timeout: 8000,
        },
      );
      assert.isUndefined(result.error);
      assert.notEqual(result.status, 0);
      assert.include(
        result.stderr,
        inputHash === "wrong" ? "input hash does not match" : "Expected 1 results, found 0",
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("PCM 照合は途中の欠落、長さ違いと非有限値を正常一致にしない", () => {
  const expected = Float32Array.from({ length: 1024 }, (_, index) => Math.sin(index / 7) * 0.2);
  assert.equal(comparePcmSamples(expected, expected).maximumError, 0);
  const corrupt = expected.slice();
  corrupt.fill(0, 384, 512);
  assert.isAbove(comparePcmSamples(corrupt, expected).differingSamples, 100);
  for (const invalid of [
    new Float32Array(0),
    expected.slice(128),
    expected.map(() => Number.NaN),
  ]) {
    assert.throws(() => comparePcmSamples(invalid, expected));
    assert.throws(() => comparePcmSamples(expected, invalid));
  }
});

test("保存した到着列の順序と PCM の形式を検査してから時刻の原点を移す", () => {
  const frame = (timestamp) => ({
    timestamp,
    sampleRate: 48000,
    channels: 1,
    samples: new Float32Array(960).fill(0.2),
  });
  const trace = {
    valid: true,
    decodedFrames: [frame(0), frame(20000)],
    audio: [{ atMs: 100 }, { atMs: 120 }],
  };
  assert.deepEqual(
    audioReplayFrames(trace).map((entry) => entry.atMs),
    [0, 20],
  );
  for (const invalid of [
    { ...trace, valid: false },
    { ...trace, audio: [] },
    { ...trace, audio: [{ atMs: 100 }, { atMs: 99 }] },
    { ...trace, audio: [{ atMs: 100 }, { atMs: Number.NaN }] },
    { ...trace, decodedFrames: [frame(0), { ...frame(20000), sampleRate: 44100 }] },
    {
      ...trace,
      decodedFrames: [frame(0), { ...frame(20000), samples: new Float32Array([Infinity]) }],
    },
  ])
    assert.throws(() => audioReplayFrames(invalid));
});

test("発話が無音でも予約が続く区間を音切れに数えない", () => {
  const result = analyseReservationCoverage({
    reservations: [
      { startSeconds: 0, endSeconds: 0.02, observedAtSeconds: 0 },
      { startSeconds: 0.02, endSeconds: 0.04, observedAtSeconds: 0.01 },
    ],
    samples: new Float32Array(1920),
    coverage: new Float32Array(1920).fill(1),
    sampleRate: 48000,
    firstFrame: 0,
  });
  assert.equal(result.expectedGapMs, 0);
  assert.equal(result.observedGapMs, 0);
  assert.equal(result.coverageMismatchSamples, 0);
});

test("同じ 20 ms の穴を過去と予約余裕とその先に分解する", () => {
  // 20〜40 ms に予約がなく、次の予約処理は 25 ms に呼ばれた。
  // 25 ms より前の 5 ms と、余裕 10 ms と、その先の 5 ms を混同しない。
  const coverage = new Float32Array(2880).fill(1);
  coverage.fill(0, 960, 1920);
  const result = analyseReservationCoverage({
    reservations: [
      { startSeconds: 0, endSeconds: 0.02, observedAtSeconds: 0 },
      { startSeconds: 0.04, endSeconds: 0.06, observedAtSeconds: 0.025 },
    ],
    samples: coverage.map((value) => value * 0.2),
    coverage,
    sampleRate: 48000,
    firstFrame: 0,
  });
  assert.closeTo(result.expectedGapMs, 20, 1e-9);
  assert.closeTo(result.observedGapMs, 20, 1e-9);
  assert.closeTo(result.gaps[0].pastMs, 5, 1e-9);
  assert.closeTo(result.gaps[0].safetyLeadMs, 10, 1e-9);
  assert.closeTo(result.gaps[0].laterMs, 5, 1e-9);
  assert.equal(result.gaps[0].nonzeroInteriorSamples, 0);
});

test("予約済みの区間に現れた計測用信号の欠落を検出する", () => {
  const coverage = new Float32Array(1920).fill(1);
  coverage.fill(0, 800, 900);
  const result = analyseReservationCoverage({
    reservations: [{ startSeconds: 0, endSeconds: 0.04, observedAtSeconds: 0 }],
    samples: new Float32Array(1920).fill(0.2),
    coverage,
    sampleRate: 48000,
    firstFrame: 0,
  });
  assert.equal(result.coverageMismatchSamples, 100);
  assert.closeTo(result.observedGapMs, 100 / 48, 1e-9);
});

test("予約が重なった信号と収録範囲外の予約を検出する", () => {
  const result = analyseReservationCoverage({
    reservations: [
      { startSeconds: 0, endSeconds: 0.02, observedAtSeconds: 0 },
      { startSeconds: 0.01, endSeconds: 0.04, observedAtSeconds: 0.005 },
    ],
    samples: new Float32Array(1440),
    coverage: new Float32Array(1440).fill(1),
    sampleRate: 48000,
    firstFrame: 0,
  });
  assert.equal(result.truncatedReservationSamples, 480);
  assert.isAbove(result.coverageMismatchSamples, 400);
});
