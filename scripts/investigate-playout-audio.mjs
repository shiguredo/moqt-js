/**
 * 合成信号と日本語音声による playout の測定。実ブラウザで出力を保存する。
 * 実行: vp exec node scripts/investigate-playout-audio.mjs [dsp|render|speech|live|long|datagram|datagramLive|relay|replay|av|avRelay|all]
 * 生データと試聴用 WAV は investigation-logs/playout-quality-2026-10-28/ に置く。
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
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
    "live",
    "speech",
    "long",
    "datagram",
    "datagramLive",
    "relay",
    "replay",
    "av",
    "avRelay",
  ].includes(mode)
) {
  throw new Error(`Invalid investigation mode: ${mode}`);
}
const directory = resolve("investigation-logs/playout-quality-2026-10-28");
mkdirSync(directory, { recursive: true });
// 比較中の再実行で前の観測を失わないよう、JSON は実行ごとの場所にも保存する。
const runDirectory = `${directory}/runs/${new Date().toISOString().replaceAll(":", "-")}-${process.pid}-${mode}`;
mkdirSync(runDirectory, { recursive: true });
// ソース切り替えに対応する A/V モード以外では、実装と記録の食い違いを拒否する。
const sourceRoot = process.env.PLAYOUT_SOURCE_ROOT ?? "src";
if (resolve(sourceRoot) !== resolve("src") && !["av", "avRelay"].includes(mode))
  throw new Error("PLAYOUT_SOURCE_ROOT is supported only by av and avRelay");
if (["all", "dsp", "render", "speech", "datagram"].includes(mode)) {
  for (const [label, revision] of [
    ["before", "d0b944dd"],
    ["baseline", "d6893cb2"],
  ])
    writeFileSync(
      `${directory}/audioTimeStretch.${label}.ts`,
      execFileSync("git", ["show", `${revision}:src/playout/audioTimeStretch.ts`]),
    );
}

/** 相対パスと内容を一緒に記録し、依存先を含むソース全体を識別する。 */
function fingerprintTree(root) {
  const files = {};
  const visit = (prefix) => {
    for (const entry of readdirSync(resolve(root, prefix), { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile())
        files[name] = createHash("sha256")
          .update(readFileSync(resolve(root, name)))
          .digest("hex");
      else throw new Error(`Unsupported measurement input: ${name}`);
    }
  };
  visit("");
  return { sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"), files };
}

/** ブラウザの起動や解放が失敗しても、測定用サーバーのプロセス群を停止する。 */
function stopServer(server) {
  if (server?.pid === undefined) return;
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

let server;
let browser;
try {
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
  server = spawn("vp", ["dev", "tests/e2e", "--host", "127.0.0.1", "--port", String(port)], {
    stdio: "ignore",
    detached: true,
  });
  let serverFailure;
  server.on("error", (error) => {
    serverFailure = error;
  });
  browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (serverFailure) throw new Error("Vite failed to spawn", { cause: serverFailure });
    if (server.exitCode !== null) throw new Error("Vite exited before startup");
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
    runtime: process.version,
    sourceRoot,
    variant: process.env.PLAYOUT_VARIANT ?? "current",
    sourceTree: fingerprintTree(sourceRoot),
    inputSourceTree: resolve(sourceRoot) === resolve("src") ? null : fingerprintTree("src"),
    speechInputs: existsSync(`${directory}/speech-input`)
      ? fingerprintTree(`${directory}/speech-input`)
      : null,
    harnessFiles: Object.fromEntries(
      [
        "scripts/investigate-playout-audio.mjs",
        "scripts/playout-audio-quality.mjs",
        "scripts/playout-av-latency.mjs",
        "scripts/playout-av-relay.mjs",
        "scripts/playout-audio-input.mjs",
        "scripts/playout-measurement-guards.mjs",
        "scripts/prepare-playout-japanese.mjs",
      ].map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]),
    ),
  };
  writeFileSync(`${directory}/environment-${mode}.json`, JSON.stringify(environment, null, 2));
  writeFileSync(`${runDirectory}/environment.json`, JSON.stringify(environment, null, 2));
  for (const stage of [
    "dsp",
    "render",
    "speech",
    "live",
    "long",
    "datagram",
    "datagramLive",
    "relay",
    "replay",
    "av",
    "avRelay",
  ]) {
    if (["relay", "replay", "av", "avRelay"].includes(stage) && mode === "all") continue;
    if (mode !== "all" && mode !== stage) continue;
    // 実時間とオフラインの条件を分け、ケースごとに結果を確定させる。
    const cases =
      stage === "avRelay"
        ? ["avRelay|kyoko|clean|1", "avRelay|kyoko|random5|2", "avRelay|julius|burst3|1"]
        : stage === "av"
          ? [
              "av|tone|clean",
              "av|julius|clean",
              "av|kyoko|audio-stall",
              "av|julius|both-stall",
              "av|kyoko|jitter",
              "av|eddy|loss5",
              "av|grandpa|video-step",
            ]
          : stage === "live"
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
      const seconds = Number(process.env.PLAYOUT_AV_SECONDS ?? (stage === "avRelay" ? 20 : 10));
      if (!Number.isFinite(seconds) || seconds < 2 || seconds > 120)
        throw new Error("PLAYOUT_AV_SECONDS must be between 2 and 120");
      let watchdog;
      let result;
      try {
        result = await Promise.race([
          page.evaluate(
            async ({ harnessUrl, stage, caseName, relayUrl, arrivalTrace, avOptions }) => {
              if (stage === "av" || stage === "avRelay") {
                const file = stage === "av" ? "./playout-av-latency.mjs" : "./playout-av-relay.mjs";
                const harness = await import(new URL(file, harnessUrl).href);
                return harness.measure(caseName, { ...avOptions, relayUrl });
              }
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
              avOptions: {
                moduleUrl: `${origin}/@fs${resolve(process.env.PLAYOUT_SOURCE_ROOT ?? "src")}/playout/mediaPlayout.ts`,
                variant: process.env.PLAYOUT_VARIANT ?? "current",
                seconds,
                certificateHash: process.env.PLAYOUT_SERVER_CERTIFICATE_HASH,
              },
            },
          ),
          new Promise((_, reject) => {
            watchdog = setTimeout(
              () => reject(new Error(`Measurement timed out: ${caseName}`)),
              30000 + (stage === "long" ? 60000 : seconds * 1000) * 2,
            );
          }),
        ]);
      } finally {
        clearTimeout(watchdog);
      }
      if (stage === "av" || stage === "avRelay")
        assert.ok(result.valid, "配信中にエラーが無く、十分な音声と映像を収録できたこと");
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
        writeFileSync(`${runDirectory}/${recording.name}.wav`, buffer);
      }
      console.log(`測定完了: ${caseName}`);
    }
  }
  console.log(`測定結果: ${directory}`);
} finally {
  try {
    await browser?.close();
  } finally {
    stopServer(server);
  }
}
