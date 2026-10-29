/// <reference types="node" />
import { test } from "@playwright/test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { DEVTOOLS_URL } from "./urls";

// 同じ timestamp の入力も WebCodecs は符号化する。送信前の管理が片方を失うと、
// Object ID は連続したまま参照フレームだけが欠け、次のキーフレームまで映像が止まる。
test("同じ timestamp の実 VP9 出力を落とさず、参照フレームを維持する", async ({ page }) => {
  await page.goto(DEVTOOLS_URL);
  const result = await page.evaluate(
    async (generationUrl) => {
      const { recordEncodeGeneration, shouldSendEncodedChunk } = await import(generationUrl);
      const records = new Map();
      const errors: string[] = [];
      const counts = { encoded: 0, sent: 0, control: 0, filtered: 0 };
      const config = { codec: "vp09.00.10.08", codedWidth: 1280, codedHeight: 720 };
      const control = new VideoDecoder({
        output: (frame) => {
          counts.control++;
          frame.close();
        },
        error: (error) => errors.push(`control: ${error.message}`),
      });
      const filtered = new VideoDecoder({
        output: (frame) => {
          counts.filtered++;
          frame.close();
        },
        error: (error) => errors.push(`filtered: ${error.message}`),
      });
      control.configure(config);
      filtered.configure(config);
      const encoder = new VideoEncoder({
        output: (chunk) => {
          counts.encoded++;
          control.decode(chunk);
          if (shouldSendEncodedChunk(records, 0, chunk.timestamp)) {
            counts.sent++;
            if (filtered.state === "configured") filtered.decode(chunk);
          }
        },
        error: (error) => errors.push(`encoder: ${error.message}`),
      });
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Video input canvas is unavailable");
      try {
        encoder.configure({
          codec: config.codec,
          width: 1280,
          height: 720,
          framerate: 30,
          bitrate: 2000000,
        });
        for (let index = 0; index < 120; index++) {
          // 2 枚ずつ同じ timestamp にし、内容は変えて参照関係のある実 bitstream を作る。
          const timestamp = Math.floor(index / 2) * 66666;
          context.fillStyle = `hsl(${index * 8},70%,50%)`;
          context.fillRect(0, 0, canvas.width, canvas.height);
          const frame = new VideoFrame(canvas, { timestamp });
          try {
            encoder.encode(frame, { keyFrame: index === 0 });
            recordEncodeGeneration(records, 0, timestamp);
          } finally {
            frame.close();
          }
          // 同じ timestamp の 2 枚を同じタスクで投入し、出力前の重なりを確実に作る。
          if (index % 2 === 1) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 5);
            });
          }
        }
        await encoder.flush();
        await control.flush();
        if (filtered.state === "configured") await filtered.flush();
        return { counts, errors };
      } finally {
        if (encoder.state !== "closed") encoder.close();
        if (control.state !== "closed") control.close();
        if (filtered.state !== "closed") filtered.close();
      }
    },
    new URL(`/@fs${resolve("src/encodeGeneration.ts")}`, DEVTOOLS_URL).href,
  );
  await test.info().attach("duplicate-timestamps.json", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
  assert.equal(result.counts.encoded, 120, "全入力を実際に符号化すること");
  assert.equal(result.counts.control, 120, "送信前処理を通さない対照の復号が成功すること");
  assert.deepEqual(result.errors, [], "送信前処理を通しても復号エラーがないこと");
  assert.equal(result.counts.sent, 120, "同じ timestamp の符号化出力もすべて送ること");
  assert.equal(result.counts.filtered, 120, "送信前処理を通した全フレームを復号すること");
});
