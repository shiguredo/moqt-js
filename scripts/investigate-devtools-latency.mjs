/** 実 DevTools の出力経路を、実 QUIC と日本語音声で計測する。接続先は保存しない。 */
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { measureOutputPath } from "./playout-output-path.mjs";
import { installTimingTrace, summarizeTimingTrace } from "./devtools-latency-trace.mjs";
import { fingerprintTree, fingerprintFiles } from "./playout-source-fingerprint.mjs";

const relayUri = process.env.PLAYOUT_RELAY_URI;
if (!relayUri) throw new Error("PLAYOUT_RELAY_URI is required");
const seconds = Number(process.env.PLAYOUT_AV_SECONDS ?? 20);
if (!Number.isInteger(seconds) || seconds < 10 || seconds > 120)
  throw new Error("PLAYOUT_AV_SECONDS must be an integer between 10 and 120");
const speechName = process.env.PLAYOUT_SPEECH_SOURCE ?? "tone";
if (!["tone", "julius", "kyoko", "eddy", "grandpa"].includes(speechName))
  throw new Error(`Unsupported speech source: ${speechName}`);
const browserChannel = process.env.PLAYOUT_BROWSER_CHANNEL ?? "chromium";
if (!["chromium", "chrome"].includes(browserChannel))
  throw new Error(`Unsupported browser channel: ${browserChannel}`);
const sourceRoot = resolve(process.env.PLAYOUT_SOURCE_ROOT ?? "src");
const stallMs = Number(process.env.PLAYOUT_STARTUP_STALL_MS ?? 0);
if (!Number.isInteger(stallMs) || stallMs < 0 || stallMs > 500)
  throw new Error("PLAYOUT_STARTUP_STALL_MS must be an integer between 0 and 500");
const measurementFiles = [
  "package.json",
  "pnpm-lock.yaml",
  "devtools/vite.config.ts",
  "scripts/investigate-devtools-latency.mjs",
  "scripts/playout-output-path.mjs",
  "scripts/playout-av-relay.mjs",
  "scripts/playout-audio-input.mjs",
  "scripts/devtools-latency-trace.mjs",
  "scripts/playout-source-fingerprint.mjs",
];
const hashes = fingerprintFiles(measurementFiles);
const sourceTree = fingerprintTree(sourceRoot);
const devtoolsSourceTree = fingerprintTree("devtools/src");
const inputSourceTree = sourceRoot === resolve("src") ? null : fingerprintTree("src");
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
  timeout: 5000,
}).trim();
const speechFile =
  speechName === "tone"
    ? null
    : `investigation-logs/playout-quality-2026-10-28/speech-input/${speechName}.wav`;
const speechSha256 =
  speechFile === null ? null : createHash("sha256").update(readFileSync(speechFile)).digest("hex");
let configurationDirectory;
const serverArguments = ["dev", "devtools", "--host", "127.0.0.1"];
if (sourceRoot !== resolve("src")) {
  // 比較用の別ソースを選んだ場合も、購読 UI と配信、時間軸を同じ実装で揃える。
  mkdirSync("investigation-logs", { recursive: true });
  configurationDirectory = mkdtempSync(resolve("investigation-logs/devtools-config-"));
  const configurationPath = `${configurationDirectory}/vite.config.ts`;
  writeFileSync(
    configurationPath,
    `import base from ${JSON.stringify(resolve("devtools/vite.config.ts"))};\nexport default { ...base, resolve: { ...base.resolve, alias: { "moqt-js": ${JSON.stringify(`${sourceRoot}/index.ts`)} } } };\n`,
  );
  serverArguments.push("--config", configurationPath);
}
const port = await new Promise((accept, reject) => {
  const server = createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => accept(address.port));
  });
});
const server = spawn("vp", [...serverArguments, "--port", String(port)], {
  stdio: "ignore",
  detached: true,
});
const origin = `http://127.0.0.1:${port}`;
let browser;
let measurementTimeout;
try {
  let serverError;
  server.on("error", (error) => {
    serverError = error;
  });
  const deadline = Date.now() + 10000;
  for (;;) {
    if (serverError) throw new Error("DevTools server failed to start", { cause: serverError });
    if (server.exitCode !== null) throw new Error("DevTools server exited before startup");
    try {
      const response = await fetch(origin, {
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      if (response.ok) break;
    } catch {
      /* 起動待ちだけを再試行する。 */
    }
    if (Date.now() >= deadline) throw new Error("DevTools startup exceeded 10000 ms");
    await new Promise((accept) => {
      setTimeout(accept, 100);
    });
  }
  browser = await chromium.launch({
    ...(browserChannel === "chrome" ? { channel: "chrome" } : {}),
    timeout: 10000,
    headless: process.env.PLAYOUT_HEADED !== "1",
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  measurementTimeout = setTimeout(
    () => {
      void browser.close().catch(() => {
        // 本体の中断処理が閉じ終えた場合は何もしない。
      });
    },
    (seconds + 60) * 1000,
  );
  measurementTimeout.unref();
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const namespace = `latency${crypto.randomUUID().replaceAll("-", "")}`;
  const pageErrors = [];
  page.on("pageerror", (error) =>
    pageErrors.push(error.message.replaceAll(/(?:https?|moqt):\/\/\S+/g, "<URL>")),
  );
  await page.goto(
    `${origin}/?namespace=${namespace}&mode=${speechName === "tone" ? "both" : "subscriber"}`,
  );
  const outputPath = await page.evaluate(measureOutputPath);
  await page.evaluate(installTimingTrace, {
    moduleUrl: `${origin}/@fs${sourceRoot}/playout/timeline.ts`,
    stallMs,
  });
  await page.getByTestId("moqt-uri").click();
  await page.getByTestId("server-url-candidates-input").fill(relayUri);
  await page.getByTestId("server-url-candidates-add").click();
  await page.getByTestId("server-url-candidates-close-footer").click();
  await page.getByTestId("subscriber-audio-playback-toggle").click();
  if (speechName === "tone") {
    await page.getByTestId("publisher-publish-button").click();
  } else {
    // 日本語は実 AudioBuffer と canvas の MediaStream を公開 API で配信する。
    await page.evaluate(
      async ({ moduleUrl, sourceUrl, relayUri, namespace, speechName }) => {
        const { createMediaPublisher } = await import(moduleUrl);
        const { prepareSource } = await import(sourceUrl);
        const source = await prepareSource(speechName);
        let publisher;
        try {
          publisher = await createMediaPublisher(relayUri, {
            namespace: [namespace],
            useWorker: true,
            audio: {
              codec: "opus",
              bitrate: 64000,
              channels: 1,
              delivery: "datagram",
              redundancy: 2,
            },
            video: { codec: "vp8", bitrate: 300000, width: 320, height: 180, framerate: 30 },
          });
          await source.context.resume();
          source.source.start();
          await publisher.start(source.stream);
          window.devtoolsMeasurement = { publisher, source };
        } catch (error) {
          await publisher?.close();
          clearInterval(source.paintTimer);
          for (const track of source.stream.getTracks()) track.stop();
          await source.context.close();
          source.inputCanvas.remove();
          source.outputCanvas.remove();
          throw error;
        }
      },
      {
        moduleUrl: `${origin}/@fs${sourceRoot}/index.ts`,
        sourceUrl: `${origin}/@fs${resolve("scripts/playout-av-relay.mjs")}`,
        relayUri,
        namespace,
        speechName,
      },
    );
  }
  const read = () =>
    page.evaluate(() => {
      const subscriber = window.moqtDevTools.getSubscribers()[0];
      return {
        atMs: performance.now(),
        status: subscriber.status,
        statusMessage: subscriber.statusMessage,
        video: subscriber.playoutTiming.latencyBreakdown,
        audio: subscriber.audio.playoutTiming,
        avSync: subscriber.avSync,
        audioOutput: subscriber.audioOutput,
        audioQuality: {
          compressedMs: subscriber.audio.playoutCompressedMs,
          concealedMs: subscriber.audio.playoutConcealedMs,
          rebases: subscriber.audio.playoutRebases,
          drops: subscriber.audio.playoutDrops,
        },
        audioReceiveDelayMs: subscriber.audio.receiveDelayMs,
        framesDecoded: subscriber.framesDecoded,
        decodeErrors: subscriber.decodeErrors,
        audioDecoded: subscriber.audio.chunksDecoded,
        visible: document.visibilityState,
      };
    });
  const rows = [];
  let timingTrace;
  try {
    await page.evaluate(() => window.devtoolsTimingTrace.start());
    await page.getByTestId("subscriber-subscribe-button").click();
    const deadline = Date.now() + 20000;
    for (;;) {
      const current = await read();
      if (current.status === "error") {
        throw new Error(`Subscriber failed during measurement: ${current.statusMessage}`);
      }
      if (current.audio.playedFrames > 50) break;
      if (Date.now() >= deadline) throw new Error("Audio playback did not start within 20000 ms");
      await new Promise((accept) => {
        setTimeout(accept, 100);
      });
    }
    rows.push(await read());
    for (let index = 0; index < seconds * 2; index++) {
      await new Promise((accept) => {
        setTimeout(accept, 500);
      });
      rows.push(await read());
    }
  } finally {
    timingTrace = await page.evaluate(() => window.devtoolsTimingTrace.stop());
    // 開始に失敗して Stop が無効な場合、終了操作の timeout で元の失敗を隠さない。
    const stopSubscriber = page.getByTestId("subscriber-stop-button");
    if (await stopSubscriber.isEnabled()) await stopSubscriber.click();
    if (speechName === "tone") {
      const stopPublisher = page.getByTestId("publisher-stop-button");
      if (await stopPublisher.isEnabled()) await stopPublisher.click();
    } else
      await page.evaluate(async () => {
        const { publisher, source } = window.devtoolsMeasurement;
        await publisher.close();
        clearInterval(source.paintTimer);
        source.source.stop();
        for (const track of source.stream.getTracks()) track.stop();
        await source.context.close();
        source.inputCanvas.remove();
        source.outputCanvas.remove();
        delete window.devtoolsMeasurement;
      });
  }
  const first = rows[0];
  const last = rows.at(-1);
  const elapsedSeconds = (last.atMs - first.atMs) / 1000;
  const traceSummary = summarizeTimingTrace(timingTrace);
  // 起動中の累積値で成功させず、計測中の増分と各区間の進行を確かめる。
  // 表示が止まると遅延分布に新しい標本が入らないため、遅延値だけでは判定しない。
  const intervals = rows.slice(1).map((current, index) => {
    const previous = rows[index];
    return {
      elapsedMs: current.atMs - previous.atMs,
      audioFrames: current.audio.playedFrames - previous.audio.playedFrames,
      videoFrames: current.framesDecoded - previous.framesDecoded,
    };
  });
  const sourcesUnchanged =
    JSON.stringify(hashes) === JSON.stringify(fingerprintFiles(measurementFiles)) &&
    sourceTree.sha256 === fingerprintTree(sourceRoot).sha256 &&
    devtoolsSourceTree.sha256 === fingerprintTree("devtools/src").sha256 &&
    (inputSourceTree === null || inputSourceTree.sha256 === fingerprintTree("src").sha256) &&
    (speechFile === null ||
      speechSha256 === createHash("sha256").update(readFileSync(speechFile)).digest("hex"));
  const valid =
    sourcesUnchanged &&
    traceSummary.valid &&
    (stallMs === 0 || timingTrace.stall?.requestedMs === stallMs) &&
    traceSummary.audio.whole.count >= last.audio.playedFrames * 0.95 &&
    traceSummary.video.whole.count >= last.framesDecoded * 0.95 &&
    pageErrors.length === 0 &&
    rows.every((row) => row.visible === "visible" && row.decodeErrors === 0) &&
    intervals.every(
      (interval) =>
        interval.elapsedMs > 0 &&
        interval.elapsedMs < 1500 &&
        interval.audioFrames > 0 &&
        interval.videoFrames > 0,
    ) &&
    last.audio.playedFrames - first.audio.playedFrames >= elapsedSeconds * 30 &&
    last.framesDecoded - first.framesDecoded >= elapsedSeconds * 15;
  mkdirSync("investigation-logs/devtools-audio-latency", { recursive: true });
  const file = `investigation-logs/devtools-audio-latency/${Date.now()}-${speechName}.json`;
  writeFileSync(
    file,
    JSON.stringify(
      {
        valid,
        browser: browser.version(),
        browserChannel,
        variant: process.env.PLAYOUT_VARIANT ?? "current",
        sourceTree,
        devtoolsSourceTree,
        inputSourceTree,
        sourcesUnchanged,
        stallMs,
        runtime: process.version,
        platform: process.platform,
        source: speechName,
        seconds,
        sourceRevision,
        speechSha256,
        hashes,
        pageErrors,
        outputPath,
        intervals,
        rows,
        timingTrace,
        traceSummary,
      },
      null,
      2,
    ),
  );
  assert.ok(valid, "実音声と実映像の再生が継続し、未処理の例外が無いこと");
  console.log(
    JSON.stringify({
      valid,
      source: speechName,
      audio: last.audio.startDelayMs,
      video: last.video.displayLatency,
      skewMs: last.avSync.skewMs,
      audioOutput: last.audioOutput,
      file,
      traceSummary: {
        audio: traceSummary.audio,
        video: traceSummary.video,
        absoluteSkew: traceSummary.absoluteSkew,
      },
    }),
  );
} finally {
  clearTimeout(measurementTimeout);
  try {
    await browser?.close();
  } finally {
    try {
      if (server.pid) {
        try {
          process.kill(-server.pid, "SIGTERM");
        } catch {
          /* 既に終了している。 */
        }
      }
    } finally {
      if (configurationDirectory !== undefined) rmSync(configurationDirectory, { recursive: true });
    }
  }
}
