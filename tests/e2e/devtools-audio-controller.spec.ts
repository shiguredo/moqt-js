/// <reference types="node" />
import { test } from "@playwright/test";
import assert from "node:assert/strict";
import { evaluatePlayout, openPlayoutPage } from "./playoutTestPage";

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

test("購読前の再生有効化と入口の作り直しで、最初の実音から予約できる", async ({ page }) => {
  await openPlayoutPage(page);
  const result = await evaluatePlayout(page, async ({ harnessUrl }) => {
    const { createAudioControllerHarness } = await import(
      new URL("./audioPlaybackControllerHarness.ts", harnessUrl).href
    );
    const env = createAudioControllerHarness();
    try {
      await env.controller.toggleAudioPlayback();
      const statuses = [];
      for (let index = 0; index < 2; index++) {
        const playout = env.createPlayout();
        env.mediaPlayoutRef.current = playout;
        await env.controller.attachPlaybackToPlayout(playout);
        statuses.push(env.push(playout));
        await playout.drainAudio();
        playout.setAudioOutput(null);
      }
      return statuses;
    } finally {
      await env.close();
    }
  });
  assert.deepEqual(result, ["played", "played"], "入口ごとに実プロセッサーの準備を待つこと");
});

test("入口の準備中に次の入口へ移っても古い入口を接続しない", async ({ page }) => {
  await openPlayoutPage(page);
  const result = await evaluatePlayout(page, async ({ harnessUrl }) => {
    const { createAudioControllerHarness } = await import(
      new URL("./audioPlaybackControllerHarness.ts", harnessUrl).href
    );
    const env = createAudioControllerHarness();
    try {
      await env.controller.toggleAudioPlayback();
      const old = env.createPlayout();
      const current = env.createPlayout();
      env.mediaPlayoutRef.current = old;
      const pending = env.controller.attachPlaybackToPlayout(old);
      env.mediaPlayoutRef.current = current;
      await env.controller.attachPlaybackToPlayout(current);
      await pending;
      const result = [env.push(old), env.push(current)];
      old.clearAll();
      return result;
    } finally {
      await env.close();
    }
  });
  assert.deepEqual(result, ["skipped", "played"], "古い準備の完了で購読を巻き戻さないこと");
});

test("古い実出力機器の失敗で、後続の既定出力と再生を止めない", async ({ page }) => {
  await openPlayoutPage(page);
  const result = await evaluatePlayout(page, async ({ harnessUrl }) => {
    const { createAudioControllerHarness } = await import(
      new URL("./audioPlaybackControllerHarness.ts", harnessUrl).href
    );
    const env = createAudioControllerHarness();
    try {
      env.mediaPlayoutRef.current = env.createPlayout();
      await env.controller.toggleAudioPlayback();
      const first = env.select(`missing-device-${crypto.randomUUID()}`);
      // 先行要求を直列化キューから実 setSinkId へ渡し、ネイティブの結果を待つ間に更新する。
      await Promise.resolve();
      await Promise.resolve();
      const second = env.select("");
      const requests = await Promise.allSettled([first, second]);
      return {
        requests: requests.map((request) => request.status),
        enabled: env.instance.audioPlaybackEnabled.value,
        status: env.push(env.mediaPlayoutRef.current),
      };
    } finally {
      await env.close();
    }
  });
  assert.deepEqual(result, {
    requests: ["fulfilled", "fulfilled"],
    enabled: true,
    status: "played",
  });
});

test("入口の準備中に停止しても、閉じた Context を後から接続しない", async ({ page }) => {
  await openPlayoutPage(page);
  const result = await evaluatePlayout(page, async ({ harnessUrl }) => {
    const { createAudioControllerHarness } = await import(
      new URL("./audioPlaybackControllerHarness.ts", harnessUrl).href
    );
    const env = createAudioControllerHarness();
    try {
      await env.controller.toggleAudioPlayback();
      const playout = env.createPlayout();
      env.mediaPlayoutRef.current = playout;
      const pending = env.controller.attachPlaybackToPlayout(playout);
      await env.controller.stopAudioPlayback();
      await pending;
      return { status: env.push(playout), hasPlayback: env.controller.hasPlayback() };
    } finally {
      await env.close();
    }
  });
  assert.deepEqual(result, { status: "skipped", hasPlayback: false });
});
