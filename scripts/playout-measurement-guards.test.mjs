/** 実測の採否を決める条件を、不完全な入力で検査する。 */
import { test, assert } from "vite-plus/test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireAudioFrame, hasAvCoverage } from "./playout-measurement-guards.mjs";

test("欠落、順序ずれ、短い復号出力、非有限のサンプルを拒否する", () => {
  for (const frame of [
    undefined,
    { packetIndex: 2, samples: new Float32Array(960) },
    { packetIndex: 1, samples: new Float32Array(120) },
    { packetIndex: 1, samples: new Float32Array(960).fill(Number.NaN) },
  ]) {
    assert.throws(() => requireAudioFrame(frame, 1, 960));
  }
  const samples = new Float32Array(960).fill(0.3);
  assert.equal(requireAudioFrame({ packetIndex: 1, samples }, 1, 960), samples);
});

test("収録時間と実再生、実表示、対応する A/V の組をすべて要求する", () => {
  const complete = {
    seconds: 10,
    capturedSamples: 480000,
    audioCount: 450,
    videoCount: 270,
    pairCount: 270,
  };
  assert.equal(hasAvCoverage(complete), true);
  for (const field of ["capturedSamples", "audioCount", "videoCount", "pairCount"])
    assert.equal(hasAvCoverage({ ...complete, [field]: 0 }), false, field);
  assert.equal(hasAvCoverage({ ...complete, seconds: Number.NaN }), false);
  assert.equal(hasAvCoverage({ ...complete, pairCount: Infinity }), false);
  // 同一時刻だけで照合する 50 fps / 30 fps の測定は、共通する 10 fps の半分を必要とする。
  assert.equal(hasAvCoverage({ ...complete, pairCount: 90 }, 5), true);
  assert.equal(hasAvCoverage({ ...complete, pairCount: 0 }, 5), false);
});

test("最短の 2 秒でも初期 1 秒を除いた実再生と実表示を採用する", () => {
  // 50 fps の音声と 30 fps の映像は、初期区間を除くと同時刻の組が 10 組になる。
  const shortest = {
    seconds: 2,
    capturedSamples: 96000,
    audioCount: 50,
    videoCount: 30,
    pairCount: 10,
  };
  assert.isTrue(hasAvCoverage(shortest, 5));
  assert.isTrue(hasAvCoverage({ ...shortest, pairCount: 30 }));
  // 初期区間の除外によって、空の観測まで採用してはならない。
  assert.isFalse(hasAvCoverage({ ...shortest, pairCount: 0 }, 5));
  assert.isFalse(hasAvCoverage({ ...shortest, seconds: 1 }, 5));
});

test("対象が 0 件なら測定環境も結果も保存する前に失敗する", () => {
  // 実プロセスを空の作業場所で起動し、古い測定記録に触れずに早期拒否を確かめる。
  const directory = mkdtempSync(join(tmpdir(), "playout-empty-selection-"));
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./investigate-playout-audio.mjs", import.meta.url)), "av"],
      {
        cwd: directory,
        env: { ...process.env, PLAYOUT_CASE_FILTER: "no-matching-measurement-case" },
        encoding: "utf8",
        timeout: 8000,
      },
    );
    assert.isUndefined(result.error);
    assert.notEqual(result.status, 0);
    assert.include(result.stderr, "No measurement cases selected");
    assert.isFalse(existsSync(join(directory, "investigation-logs")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("端数秒や対応範囲外の時間は測定を開始する前に拒否する", () => {
  // 音源のフレーム数とイベント数が異なる端数秒を受け付けず、古い記録も変更しない。
  const directory = mkdtempSync(join(tmpdir(), "playout-invalid-duration-"));
  try {
    for (const seconds of ["1", "121", "2.001", "NaN"]) {
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL("./investigate-playout-audio.mjs", import.meta.url)), "av"],
        {
          cwd: directory,
          env: { ...process.env, PLAYOUT_CASE_FILTER: "tone", PLAYOUT_AV_SECONDS: seconds },
          encoding: "utf8",
          timeout: 8000,
        },
      );
      assert.isUndefined(result.error);
      assert.notEqual(result.status, 0);
      assert.include(result.stderr, "PLAYOUT_AV_SECONDS must be an integer between 2 and 120");
      assert.isFalse(existsSync(join(directory, "investigation-logs")));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
