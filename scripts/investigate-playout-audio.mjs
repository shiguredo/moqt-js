/**
 * 合成信号と日本語音声による playout の測定。実ブラウザで出力を保存する。
 * 実行: vp exec node scripts/investigate-playout-audio.mjs [dsp|render|control|speech|live|long|datagram|datagramLive|relay|replay|all]
 * 生データと試聴用 WAV は investigation-logs/playout-quality-2026-10-28/ に置く。
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const mode = process.argv[2] ?? "all";
if (
  ![
    "all",
    "dsp",
    "render",
    "control",
    "live",
    "speech",
    "long",
    "datagram",
    "datagramLive",
    "relay",
    "replay",
  ].includes(mode)
) {
  throw new Error(`Invalid investigation mode: ${mode}`);
}
const directory = resolve("investigation-logs/playout-quality-2026-10-28");
mkdirSync(directory, { recursive: true });
// 比較中の再実行で前の観測を失わないよう、JSON は実行ごとの場所にも保存する。
const runDirectory = `${directory}/runs/${new Date().toISOString().replaceAll(":", "-")}-${mode}`;
mkdirSync(runDirectory, { recursive: true });
// 直前の修正を取り消さずに旧実装を読み、同じ入力で改善と回帰を比較する。
writeFileSync(
  `${directory}/audioTimeStretch.before.ts`,
  execFileSync("git", ["show", "d0b944dd:src/playout/audioTimeStretch.ts"]),
);
writeFileSync(
  `${directory}/audioTimeStretch.baseline.ts`,
  execFileSync("git", ["show", "d6893cb2:src/playout/audioTimeStretch.ts"]),
);
const port = await new Promise((accept, reject) => {
  const reservation = createServer();
  reservation.on("error", reject);
  reservation.listen(0, "127.0.0.1", () => {
    const address = reservation.address();
    if (address === null || typeof address === "string") {
      reject(new Error("Failed to reserve a TCP port"));
      return;
    }
    reservation.close(() => accept(address.port));
  });
});
const server = spawn("vp", ["dev", "tests/e2e", "--host", "127.0.0.1", "--port", String(port)], {
  stdio: "ignore",
  detached: true,
});
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
try {
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const response = await fetch(origin);
      if (response.ok) break;
    } catch {
      // 起動待ちだけを再試行し、期限を超えたら測定を始めない。
    }
    if (Date.now() > deadline) throw new Error("Vite startup exceeded 10000 ms");
    await new Promise((accept) => {
      setTimeout(accept, 100);
    });
  }
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => console.error(error.message));
  await page.goto(origin);
  const harnessUrl = `${origin}/@fs${resolve("scripts/playout-audio-quality.mjs")}`;
  const environment = {
    sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    baselineRevision: "d6893cb2",
    coarseRevision: "d0b944dd",
    browser: browser.version(),
    platform: process.platform,
    architecture: process.arch,
    capturedAt: new Date().toISOString(),
    mode,
    sourceFiles: Object.fromEntries(
      [
        "src/audioSpliceFade.ts",
        "src/codec/opusDecoderTimestamps.ts",
        "src/codec/AudioDecoder.ts",
        "src/codec/workers/audioDecoder.worker.ts",
        "src/playout/audioPlayout.ts",
        "src/playout/audioPlayoutSession.ts",
        "src/playout/audioPlayoutTimingStats.ts",
        "src/playout/audioTimeStretch.ts",
        "src/playout/audioDelayEstimator.ts",
        "src/playout/timeline.ts",
      ].map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]),
    ),
  };
  writeFileSync(`${directory}/environment-${mode}.json`, JSON.stringify(environment, null, 2));
  writeFileSync(`${runDirectory}/environment.json`, JSON.stringify(environment, null, 2));
  for (const stage of [
    "dsp",
    "render",
    "control",
    "speech",
    "live",
    "long",
    "datagram",
    "datagramLive",
    "relay",
    "replay",
  ]) {
    if ((stage === "relay" || stage === "replay") && mode === "all") continue;
    if (mode !== "all" && mode !== stage) continue;
    // 実時間とオフラインの条件を分け、ケースごとに結果を確定させる。
    const cases =
      stage === "live"
        ? [
            "tone-clean",
            "voice-clean",
            "voice-stall",
            "tone-gap",
            "rate-mismatch",
            "av-clean",
            "av-stall",
            "japanese-julius-clean",
            "japanese-kyoko-clean",
            "japanese-kyoko-stall",
            "japanese-eddy-stall",
          ]
        : stage === "long"
          ? ["japanese-julius-long-clean", "japanese-kyoko-long-stall"]
          : stage === "relay" || stage === "replay"
            ? [
                "relay|julius|clean|1",
                "relay|julius|random5|1",
                "relay|eddy|burst3|1",
                "relay|kyoko|random5|2",
              ]
            : stage === "datagramLive"
              ? [
                  "datagram|julius|clean|1",
                  "datagram|julius|random5|1",
                  "datagram|eddy|random5|1",
                  "datagram|eddy|burst3|1",
                  "datagram|kyoko|burst5|1",
                  "datagram|kyoko|random5|2",
                ]
              : stage === "speech" || stage === "datagram"
                ? JSON.parse(readFileSync(`${directory}/speech-input/manifest.json`, "utf8"))
                    .flatMap((entry) =>
                      Array.from(
                        { length: Math.ceil(entry.durationSeconds / 6) },
                        (_, index) => `${String(entry.name)}:${String(index)}`,
                      ),
                    )
                    .flatMap((name) =>
                      stage === "speech"
                        ? [name]
                        : [
                            "clean|1",
                            "random1|1",
                            "random5|1",
                            "random10|1",
                            "burst2|1",
                            "burst3|1",
                            "burst5|1",
                            "random5|2",
                            "burst3|2",
                          ].map((pattern) => `${name}|${pattern}`),
                    )
                : [stage];
    for (const caseName of cases) {
      if (process.env.PLAYOUT_CASE_FILTER && !caseName.includes(process.env.PLAYOUT_CASE_FILTER))
        continue;
      // 保存した到着列を使う再投入では、実回線へ再接続せずに同じ PCM と時刻を渡す。
      const traceInput =
        stage === "replay" ? readFileSync(`${directory}/${caseName}.json`, "utf8") : null;
      const result = await page.evaluate(
        async ({ harnessUrl, stage, caseName, relayUrl, arrivalTrace }) => {
          const harness = await import(harnessUrl);
          if (stage === "render") return harness.render();
          if (stage === "replay") return harness.replay(arrivalTrace);
          return harness[stage](caseName, relayUrl);
        },
        {
          harnessUrl,
          stage,
          caseName,
          relayUrl: process.env.PLAYOUT_RELAY_URI,
          arrivalTrace: traceInput === null ? null : JSON.parse(traceInput).arrivalTrace,
        },
      );
      // 空の収録や、別の失敗で音が処理されなかった結果を正常値として残さない。
      if (stage === "live" || stage === "long" || stage === "datagramLive") {
        assert.ok(
          result.activeSamples > result.contextRate * 5,
          "有効な音声区間が 5 秒を超えること",
        );
        assert.ok(
          result.results.every((status) => status === "played"),
          "渡した音声がすべて再生されること",
        );
      }
      if (stage === "render") {
        assert.ok(result.opusFrames >= 150, "Opus の復号出力が必要な長さを満たすこと");
        assert.ok(
          result.cases
            .filter((entry) => entry.pattern === "clean")
            .every((entry) => entry.totalGapMs === 0),
          "正常入力で予約の隙間が無いこと",
        );
      }
      const { recordings = [], ...metrics } = result;
      const resultName =
        stage === "speech" || stage === "datagram" || stage === "replay"
          ? `${stage}-${caseName}`
          : caseName;
      if (traceInput !== null) {
        metrics.inputFile = `${caseName}.json`;
        metrics.inputSha256 = createHash("sha256").update(traceInput).digest("hex");
      }
      writeFileSync(`${directory}/${resultName}.json`, JSON.stringify(metrics, null, 2));
      writeFileSync(`${runDirectory}/${resultName}.json`, JSON.stringify(metrics, null, 2));
      for (const recording of recordings) {
        const samples = recording.samples;
        // mono の PCM16 WAV。解析は量子化前の Float32 で行ってから保存する。
        const buffer = Buffer.alloc(44 + samples.length * 2);
        buffer.write("RIFF", 0);
        buffer.writeUInt32LE(buffer.length - 8, 4);
        buffer.write("WAVEfmt ", 8);
        buffer.writeUInt32LE(16, 16);
        buffer.writeUInt16LE(1, 20);
        buffer.writeUInt16LE(1, 22);
        buffer.writeUInt32LE(recording.sampleRate, 24);
        buffer.writeUInt32LE(recording.sampleRate * 2, 28);
        buffer.writeUInt16LE(2, 32);
        buffer.writeUInt16LE(16, 34);
        buffer.write("data", 36);
        buffer.writeUInt32LE(samples.length * 2, 40);
        samples.forEach((sample, index) => {
          buffer.writeInt16LE(
            Math.round(Math.max(-1, Math.min(1, sample)) * 32767),
            44 + index * 2,
          );
        });
        writeFileSync(`${directory}/${recording.name}.wav`, buffer);
      }
      console.log(`測定完了: ${caseName}`);
    }
  }
  console.log(`測定結果: ${directory}`);
} finally {
  await browser.close();
  if (server.pid !== undefined) process.kill(-server.pid, "SIGTERM");
}
