/// <reference types="node" />
import { test, type Page } from "@playwright/test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluatePlayout, openPlayoutPage } from "./playoutTestPage";

// Node 側で使う採否の処理を、そのまま実ブラウザの測定にも通す。
const { measurePage } = (await import(
  pathToFileURL(resolve("scripts/playout-measurement-guards.mjs")).href
)) as {
  measurePage: <T extends { valid: boolean }>(
    page: Page,
    evaluate: () => Promise<T> | T,
  ) => Promise<T & { pageErrors: string[] }>;
};

test("音声を収録できても未処理のページ例外があれば測定を不採用にする", async ({ page }) => {
  // 実ブラウザと実 OfflineAudioContext を使い、別タスクの例外が正常値に混ざる経路を通す。
  const failed = await measurePage(page, async () => {
    const context = new OfflineAudioContext(1, 4800, 48000);
    const buffer = context.createBuffer(1, 4800, 48000);
    buffer.copyToChannel(new Float32Array(4800).fill(0.3), 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start();
    const rendered = await context.startRendering();
    setTimeout(() => {
      throw new Error("Intentional asynchronous measurement failure");
    }, 0);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    return { valid: true, peak: rendered.getChannelData(0)[100] };
  });
  assert.ok((failed.peak ?? 0) > 0.299, "実際の音声出力があること");
  assert.equal(failed.valid, false);
  assert.deepEqual(failed.pageErrors, ["Intentional asynchronous measurement failure"]);
  // 前ケースの例外を持ち越さず、計測器自身の不採用判定も上書きしない。
  assert.deepEqual(await measurePage(page, () => ({ valid: true })), {
    valid: true,
    pageErrors: [],
  });
  const rejected = await measurePage(page, () => ({ valid: false }));
  assert.equal(rejected.valid, false);
});

for (const stage of ["live", "relay", "avRelay", "av"] as const) {
  test(`${stage}: 初期化に失敗しても音声 Context を残さない`, async ({ page }) => {
    await openPlayoutPage(page);
    const session = await page.context().newCDPSession(page);
    const contexts = new Map<string, string>();
    // ブラウザ本体の状態通知を観測する。AudioContext の生成やメソッドは置き換えない。
    const observe = ({
      context,
    }: {
      context: { contextId: string; contextType: string; contextState: string };
    }): void => {
      if (context.contextType === "realtime") contexts.set(context.contextId, context.contextState);
    };
    session.on("WebAudio.contextCreated", observe);
    session.on("WebAudio.contextChanged", observe);
    await session.send("WebAudio.enable");
    try {
      if (stage === "av") {
        // 実 CSP で Blob の Worklet を拒否する。API の代役やネットワークの置換は使わない。
        await page.evaluate(() => {
          const policy = document.createElement("meta");
          policy.httpEquiv = "Content-Security-Policy";
          policy.content = "script-src 'self'; worker-src 'none'";
          document.head.append(policy);
        });
      }
      const message = await evaluatePlayout(
        page,
        async ({ moduleUrl, stage }) => {
          const file =
            stage === "av"
              ? "playout-av-latency.mjs"
              : stage === "avRelay"
                ? "playout-av-relay.mjs"
                : "playout-audio-quality.mjs";
          const harness = await import(new URL(`../scripts/${file}`, moduleUrl).href);
          try {
            // 実ファイルが無い入力を読み込み、HTTP の失敗経路を通す。リレーには接続しない。
            if (stage === "av")
              await harness.measure("av|tone|clean", {
                moduleUrl: new URL("./playout/mediaPlayout.ts", moduleUrl).href,
                variant: "current",
                seconds: 2,
              });
            else if (stage === "live") await harness.live("datagram|missing-speech-input|clean|1");
            else if (stage === "relay")
              await harness.relay("relay|missing-speech-input|clean|1", "moq://example.invalid");
            else
              await harness.measure("avRelay|missing-speech-input|clean|1", {
                moduleUrl: new URL("./playout/mediaPlayout.ts", moduleUrl).href,
                variant: "current",
                seconds: 2,
                relayUrl: "moq://example.invalid",
              });
            return "";
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        },
        { stage },
      );
      assert.match(
        message,
        stage === "av"
          ? /worklet.*module/i
          : /Japanese speech source is unavailable|Unable to decode audio data/,
      );
      // close のブラウザ通知が届くまでだけ待ち、失敗後も開いた Context を検出する。
      const deadline = Date.now() + 2000;
      while ([...contexts.values()].some((state) => state !== "closed") && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
      }
      if (stage === "live" || stage === "av")
        assert.ok(contexts.size > 0, "実 Context を生成して検査すること");
      assert.ok(
        [...contexts.values()].every((state) => state === "closed"),
        `初期化に失敗した Context を閉じること: ${JSON.stringify([...contexts])}`,
      );
    } finally {
      await session.detach();
    }
  });
}
