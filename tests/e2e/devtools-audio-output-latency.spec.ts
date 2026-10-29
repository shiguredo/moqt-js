/// <reference types="node" />
import { test } from "@playwright/test";
import assert from "node:assert/strict";
import { DEVTOOLS_URL } from "./urls";

test("実出力先の切り替えに失敗したら再生を無効にして Context を閉じる", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);
  const session = await page.context().newCDPSession(page);
  const states = new Map<string, string>();
  const observe = ({ context }: { context: { contextId: string; contextState: string } }): void => {
    states.set(context.contextId, context.contextState);
  };
  session.on("WebAudio.contextCreated", observe);
  session.on("WebAudio.contextChanged", observe);
  await session.send("WebAudio.enable");
  try {
    const toggle = page.getByTestId("subscriber-audio-playback-toggle");
    await toggle.click();
    // 存在しない実デバイス ID を選び、ブラウザ本体の setSinkId の拒否を通す。
    // API の置換や偽の AudioContext は使わない。
    await page.evaluate(async () => {
      const moduleUrl = "/src/signals/connectionSettings.ts";
      const settings = await import(moduleUrl);
      settings.selectedAudioOutputDeviceId.value = `missing-output-${crypto.randomUUID()}`;
    });
    await page
      .getByRole("button", { name: "Play Audio", exact: true })
      .waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await toggle.getAttribute("aria-pressed"), "false");
    const deadline = Date.now() + 2000;
    while ([...states.values()].some((state) => state !== "closed") && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    assert.ok(states.size > 0, "実 Context を生成して検査すること");
    assert.ok(
      [...states.values()].every((state) => state === "closed"),
      "失敗した Context を閉じること",
    );
  } finally {
    await session.detach();
  }
});

test("音声再生の出力時計を直接出力より余分に先行させない", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);
  await page.getByTestId("subscriber-audio-playback-toggle").click();
  const session = await page.context().newCDPSession(page);
  try {
    // 実アプリが作った Context をブラウザ本体から列挙する。生成や時計の API は置き換えない。
    const prototype = await session.send("Runtime.evaluate", {
      expression: "AudioContext.prototype",
      objectGroup: "audio-output-measurement",
    });
    assert.ok(prototype.result.objectId, "実ブラウザの AudioContext が存在すること");
    const contexts = await session.send("Runtime.queryObjects", {
      prototypeObjectId: prototype.result.objectId,
      objectGroup: "audio-output-measurement",
    });
    const measured = await session.send("Runtime.callFunctionOn", {
      objectId: contexts.objects.objectId,
      awaitPromise: true,
      returnByValue: true,
      functionDeclaration: async function measureAudioOutput(this: AudioContext[]) {
        const running = this.filter((context) => context.state === "running");
        const application = running[0];
        if (application === undefined) throw new Error("Running audio output is unavailable");
        // 同じブラウザ・同じ機器の直接出力を対照にし、機器固有の遅延を失敗扱いしない。
        const direct = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
        const source = direct.createConstantSource();
        source.offset.value = 0;
        source.connect(direct.destination);
        source.start();
        const applicationLeads: number[] = [];
        const directLeads: number[] = [];
        try {
          await direct.resume();
          for (let index = 0; index < 125; index++) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 20);
            });
            if (index < 25) continue;
            for (const [context, leads] of [
              [application, applicationLeads],
              [direct, directLeads],
            ] as const) {
              const mapping = context.getOutputTimestamp();
              const contextTime = mapping.contextTime ?? 0;
              const performanceTime = mapping.performanceTime ?? 0;
              if (!(performanceTime > 0)) continue;
              leads.push(
                (context.currentTime - contextTime) * 1000 -
                  (performance.now() - performanceTime) +
                  10,
              );
            }
          }
          const summary = (values: number[]) => {
            values.sort((left, right) => left - right);
            return {
              count: values.length,
              p50: values[Math.floor(values.length * 0.5)] ?? null,
              p95: values[Math.floor(values.length * 0.95)] ?? null,
            };
          };
          return {
            runningContexts: running.length,
            application: summary(applicationLeads),
            direct: summary(directLeads),
          };
        } finally {
          source.stop();
          source.disconnect();
          await direct.close();
        }
      }.toString(),
    });
    assert.equal(measured.exceptionDetails, undefined, "実時計の計測を完了すること");
    const result = measured.result.value as {
      runningContexts: number;
      application: { count: number; p50: number; p95: number };
      direct: { count: number; p50: number; p95: number };
    };
    await test.info().attach("audio-output-clock.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });
    assert.equal(result.runningContexts, 1, "アプリの再生 Context を計測すること");
    assert.ok(result.application.count >= 80 && result.direct.count >= 80);
    const elements = await page.getByTestId("subscriber-audio-element").count();
    assert.equal(
      elements,
      0,
      `既定の音声出力に別の再生バッファを挟まないこと: ${JSON.stringify(result)}`,
    );
    assert.ok(
      result.application.p95 < result.direct.p95 + 40,
      `直接出力に対して余分な待ちを作らないこと: ${JSON.stringify(result)}`,
    );
  } finally {
    await session.send("Runtime.releaseObjectGroup", { objectGroup: "audio-output-measurement" });
    await session.detach();
    await page.getByTestId("subscriber-audio-playback-toggle").click();
  }
});
