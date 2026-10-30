import assert from "node:assert/strict";
import { test } from "@playwright/test";
import { evaluatePlayout, openPlayoutPage } from "./playoutTestPage";

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

test("収録 Worklet の実例外をページ例外とは別に検出する", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await openPlayoutPage(page);
  const result = await evaluatePlayout(page, async ({ moduleUrl }) => {
    const guardUrl = new URL("../scripts/playout-measurement-guards.mjs", moduleUrl).href;
    const { watchProcessorErrors } = (await import(guardUrl)) as {
      watchProcessorErrors: (node: AudioWorkletNode) => string[];
    };
    const context = new AudioContext();
    const source = context.createOscillator();
    let tap: AudioWorkletNode | undefined;
    const workletUrl = URL.createObjectURL(
      new Blob(
        [
          `class FailedCapture extends AudioWorkletProcessor {
          process(inputs, outputs) {
            this.blocks = (this.blocks ?? 0) + 1;
            this.port.postMessage(this.blocks);
            if (this.blocks >= 10) throw new Error("Capture failure for measurement guard verification");
            return true;
          }
        } registerProcessor("failed-capture", FailedCapture);`,
        ],
        { type: "text/javascript" },
      ),
    );
    try {
      await context.audioWorklet.addModule(workletUrl);
      // イベントを合成せず、実 Worklet の process で例外を起こす。
      tap = new AudioWorkletNode(context, "failed-capture");
      const errors = watchProcessorErrors(tap);
      let capturedBlocks = 0;
      tap.port.onmessage = () => capturedBlocks++;
      tap.connect(context.destination);
      source.connect(tap);
      await context.resume();
      source.start();
      const deadline = performance.now() + 2000;
      while (errors.length === 0) {
        if (performance.now() >= deadline)
          throw new Error(
            `Capture error was not observed within 2000 ms: state=${context.state}, time=${context.currentTime}, blocks=${capturedBlocks}`,
          );
        await new Promise<void>((accept) => {
          setTimeout(accept, 10);
        });
      }
      return { errors: [...errors] };
    } finally {
      tap?.port.close();
      tap?.disconnect();
      source.disconnect();
      URL.revokeObjectURL(workletUrl);
      await context.close();
    }
  });
  assert.equal(pageErrors.length, 0, "ページ例外だけでは収録器の停止を検出できないこと");
  assert.equal(result.errors.length, 1, "収録器の例外を専用イベントで検出すること");
  assert.match(result.errors[0] ?? "", /Capture failure/, "実際の例外のメッセージを残すこと");
});
