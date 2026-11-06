/** 定常値だけでは検出できない、フレーム境界での位相と波形の破損を実出力で調べる。 */
import { test } from "@playwright/test";
import assert from "node:assert/strict";
import { evaluatePlayout, openPlayoutPage } from "./playoutTestPage";

for (const [contextRate, decodedRate] of [
  [48000, 48000],
  [44100, 48000],
  [48000, 16000],
  [44100, 16000],
  [48000, 44100],
] as const) {
  test(`連続波形をフレームに分割しても変形しない ${decodedRate} → ${contextRate} Hz`, async ({
    page,
  }, testInfo) => {
    await openPlayoutPage(page);
    const result = await evaluatePlayout(
      page,
      async ({ moduleUrl, harnessUrl, contextRate, decodedRate }) => {
        const { AudioPlayoutSession } = await import(
          new URL("./playout/audioPlayoutSession.ts", moduleUrl).href
        );
        const { AudioPlayoutTimingStats } = await import(
          new URL("./playout/audioPlayoutTimingStats.ts", moduleUrl).href
        );
        const { compareContinuousWaveform } = await import(
          new URL("./playoutWaveformProbe.ts", harnessUrl).href
        );
        const session = new AudioPlayoutSession({
          timing: new AudioPlayoutTimingStats(10000, performance.timeOrigin),
        });
        return compareContinuousWaveform(session, contextRate, decodedRate);
      },
      { contextRate, decodedRate },
    );
    await testInfo.attach("continuous-waveform.json", {
      body: JSON.stringify(result),
      contentType: "application/json",
    });
    assert.ok(result.signalToErrorDb > 100, `分割前の波形を保つこと: ${JSON.stringify(result)}`);
    assert.ok(
      result.maximumError < 1e-6,
      `境界に大きな誤差を作らないこと: ${JSON.stringify(result)}`,
    );
  });
}
