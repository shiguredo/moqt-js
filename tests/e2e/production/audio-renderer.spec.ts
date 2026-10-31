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
