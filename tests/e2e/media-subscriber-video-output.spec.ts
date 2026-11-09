/** SDK の直接表示を実 VideoFrame、canvas、rAF で検証する。 */
import { test } from "@playwright/test";
import assert from "node:assert/strict";
import { evaluatePlayout, openPlayoutPage } from "./playoutTestPage";

test("SDK は映像も直接表示し、MediaStream の追加バッファーを通さない", async ({ page }) => {
  await openPlayoutPage(page);
  const result = await evaluatePlayout(page, async ({ moduleUrl, harnessUrl }) => {
    const { MediaSubscriberImpl } = await import(
      new URL("./createMediaSubscriber.ts", moduleUrl).href
    );
    const { waitFor } = await import(harnessUrl);
    const source = document.createElement("canvas");
    const canvas = document.createElement("canvas");
    source.width = 16;
    canvas.width = 16;
    source.height = 16;
    canvas.height = 16;
    document.body.append(canvas);
    const sourceDrawing = source.getContext("2d");
    const drawing = canvas.getContext("2d");
    if (sourceDrawing === null || drawing === null) throw new Error("canvas を作成できない");
    sourceDrawing.fillStyle = "rgb(255, 0, 0)";
    sourceDrawing.fillRect(0, 0, 16, 16);
    let presented = 0;
    const subscriber = new MediaSubscriberImpl(
      "https://localhost.invalid",
      {
        namespace: ["direct-video"],
        video: {
          output: {
            presentationLatencyTicks: 0,
            isAvailable: () => canvas.isConnected,
            present: (frame: VideoFrame) => {
              drawing.drawImage(frame, 0, 0);
              frame.close();
              presented++;
              return true;
            },
          },
        },
      },
      {},
    );
    const control = subscriber as unknown as {
      videoTrackInfo: object;
      createOutputStream(): Promise<void>;
      outputStream: MediaStream;
      videoWriter: unknown;
      playout: import("../../src/playout/mediaPlayout").MediaPlayout;
    };
    control.videoTrackInfo = { name: "video", packaging: "loc", isLive: true, codec: "vp8" };
    try {
      await control.createOutputStream();
      const frame = new VideoFrame(source, { timestamp: 0 });
      control.playout.trackVideoDecodeInput(0, {
        timestampKind: "mediaTime",
        location: { group: 0n, object: 0n },
      });
      control.playout.pushVideo(frame);
      await waitFor(() => presented === 1, 1000, "直接出力の表示");
      const closed = frame.codedWidth === 0;
      const tracks = control.outputStream.getVideoTracks().length;
      const writerAbsent = control.videoWriter === null;
      await subscriber.close();
      return {
        closed,
        tracks,
        writerAbsent,
        connected: canvas.isConnected,
        pixel: Array.from(drawing.getImageData(0, 0, 1, 1).data),
      };
    } finally {
      await subscriber.close();
      canvas.remove();
    }
  });
  assert.equal(result.tracks, 0);
  assert.equal(result.writerAbsent, true);
  assert.equal(result.closed, true, "直接出力側がフレームを解放すること");
  assert.equal(result.connected, true, "SDK の終了で利用者の表示先を破棄しないこと");
  assert.deepEqual(result.pixel, [255, 0, 0, 255]);
});
