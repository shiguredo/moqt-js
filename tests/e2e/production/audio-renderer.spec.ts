/** ソースの alias ではなく、配布物から読み込む AudioWorklet の実出力を確認する。 */
import { test } from "@playwright/test";
import assert from "node:assert/strict";
import { openProductionPage } from "./support";

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });
for (const sampleRate of [44100, 48000]) {
  test(`production の AudioWorklet が実音を再生する ${sampleRate} Hz`, async ({ page }) => {
    await openProductionPage(page);
    const result = await page.evaluate(
      (rate) => window.__moqtProduction.probeAudioOutput(rate),
      sampleRate,
    );
    assert.equal(result.played, 5, "全フレームを実際の出力へ予約すること");
    assert.ok(
      result.peak > 0.199 && result.peak < 0.201,
      `配布した出力処理で振幅を保つこと: ${result.peak}`,
    );
  });
}

for (const [contextRate, decodedRate] of [
  [48000, 48000],
  [44100, 48000],
  [48000, 16000],
  [44100, 16000],
  [48000, 44100],
] as const) {
  test(`production の連続波形もフレーム境界で変形しない ${decodedRate} → ${contextRate} Hz`, async ({
    page,
  }, testInfo) => {
    await openProductionPage(page);
    const result = await page.evaluate(
      ({ contextRate, decodedRate }) =>
        window.__moqtProduction.probeAudioWaveform(contextRate, decodedRate),
      { contextRate, decodedRate },
    );
    await testInfo.attach("production-waveform.json", {
      body: JSON.stringify(result),
      contentType: "application/json",
    });
    assert.ok(
      result.signalToErrorDb > 100,
      `配布物も連続した入力と一致すること: ${JSON.stringify(result)}`,
    );
    assert.ok(
      result.maximumError < 1e-6,
      `配布物の境界で位相を変えないこと: ${JSON.stringify(result)}`,
    );
  });
}
