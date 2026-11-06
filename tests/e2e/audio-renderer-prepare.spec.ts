/// <reference types="node" />
import { test } from "@playwright/test";
import assert from "node:assert/strict";
import { evaluatePlayout, openPlayoutPage, PLAYOUT_MODULE_URL } from "./playoutTestPage";
import { DEVTOOLS_URL } from "./urls";

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

for (const sampleRate of [16000, 44100, 48000]) {
  test(`${sampleRate} Hz の実出力を準備して再作成できる`, async ({ page }) => {
    await openPlayoutPage(page);
    const result = await evaluatePlayout(
      page,
      async ({ moduleUrl, sampleRate }) => {
        const { createMediaPlayout } = await import(moduleUrl);
        const context = new AudioContext({ sampleRate });
        const playout = createMediaPlayout({
          audio: { context, destination: context.destination },
        });
        try {
          await context.resume();
          await playout.prepareAudio();
          playout.resetAudioPlayback();
          await playout.prepareAudio();
          return { state: context.state, sampleRate: context.sampleRate };
        } finally {
          playout.clearAll();
          await context.close();
        }
      },
      { sampleRate },
    );
    assert.equal(result.state, "running", "実出力を準備すること");
    assert.equal(result.sampleRate, sampleRate, "要求したレートを検査すること");
  });
}

// DevTools の UI 変換を通るサーバーでも、SDK の Worklet を独立して実行する。
// 最小ページだけでは Prefresh の混入による登録失敗を検出できない。
test("DevTools でも再生の入口を準備できる", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);
  const result = await page.evaluate(async (modulePath) => {
    const { createMediaPlayout } = await import(modulePath);
    const context = new AudioContext({ sampleRate: 48000 });
    const playout = createMediaPlayout({ audio: { context, destination: context.destination } });
    try {
      await context.resume();
      await playout.prepareAudio();
      return context.state;
    } finally {
      playout.clearAll();
      await context.close();
    }
  }, new URL(PLAYOUT_MODULE_URL).pathname);
  assert.equal(result, "running", "DevTools から実プロセッサーを登録すること");
});

test("閉じた出力への投入を再生成功として報告しない", async ({ page }) => {
  await openPlayoutPage(page);
  const result = await evaluatePlayout(page, async ({ moduleUrl }) => {
    const { createMediaPlayout } = await import(moduleUrl);
    const context = new AudioContext({ sampleRate: 48000 });
    const playout = createMediaPlayout({ audio: { context, destination: context.destination } });
    await playout.prepareAudio();
    await context.close();
    const data = new AudioData({
      format: "f32-planar",
      sampleRate: 48000,
      numberOfChannels: 1,
      numberOfFrames: 960,
      timestamp: 0,
      data: new Float32Array(960),
    });
    try {
      const decision = playout.pushAudio(data);
      return {
        status: decision.status,
        errors: playout.getStats().audio?.timing.missedByReason.error.count,
      };
    } finally {
      data.close();
      playout.clearAll();
    }
  });
  assert.equal(result.status, "error", "出力できない予約を成功に数えないこと");
  assert.equal(result.errors, 1, "投入できなかった音を計器へ記録すること");
});
