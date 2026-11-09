/** 高レベル API が返す映像を実 video 要素で再生し、表示と終了を検証する。 */
import { test } from "@playwright/test";
import assert from "node:assert/strict";
import { evaluatePlayout, openPlayoutPage } from "./playoutTestPage";

// Chromium の headless shell は Generator の video 表示を駆動しないため通常版を使う。
test.use({
  launchOptions: async ({ browserName }, provide) => {
    await provide(
      browserName === "chromium"
        ? { channel: "chromium", args: ["--autoplay-policy=no-user-gesture-required"] }
        : {},
    );
  },
});

test("SDK の映像を video 要素で再生し、終了時にトラックを止める", async ({ page }) => {
  await openPlayoutPage(page);
  const result = await evaluatePlayout(page, async ({ moduleUrl, harnessUrl }) => {
    const { MediaSubscriberImpl } = await import(
      new URL("./createMediaSubscriber.ts", moduleUrl).href
    );
    const { waitFor } = await import(harnessUrl);
    const source = document.createElement("canvas");
    source.width = 16;
    source.height = 16;
    const drawing = source.getContext("2d");
    if (drawing === null) throw new Error("canvas を作成できない");
    drawing.fillStyle = "rgb(255, 0, 0)";
    drawing.fillRect(0, 0, 16, 16);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.controls = true;
    document.body.append(video);
    const subscriber = new MediaSubscriberImpl(
      "https://localhost.invalid",
      {
        namespace: ["video-output"],
        video: {},
      },
      {},
    );
    const control = subscriber as unknown as {
      videoTrackInfo: object;
      createOutputStream(): Promise<void>;
      playout: import("../../src/playout/mediaPlayout").MediaPlayout;
    };
    control.videoTrackInfo = { name: "video", packaging: "loc", isLive: true, codec: "vp8" };
    let callback = 0;
    try {
      await control.createOutputStream();
      video.srcObject = subscriber.mediaStream;
      let displayed = false;
      callback = video.requestVideoFrameCallback(() => {
        displayed = true;
      });
      // play() は最初のフレームが届くまで解決しないため、投入後に待つ。
      const playing = video.play();
      const frame = new VideoFrame(source, { timestamp: 0 });
      control.playout.trackVideoDecodeInput(0, {
        timestampKind: "mediaTime",
        location: { group: 0n, object: 0n },
      });
      control.playout.pushVideo(frame);
      await waitFor(() => displayed, 2000, "video 要素への表示");
      await playing;
      // Canvas は表示先ではなく、video 要素が実際に受け取った画素を読む測定器として使う。
      drawing.drawImage(video, 0, 0, 16, 16);
      const pixel = Array.from(drawing.getImageData(0, 0, 1, 1).data);
      const tracks: MediaStreamTrack[] = subscriber.mediaStream?.getVideoTracks() ?? [];
      const width = video.videoWidth;
      await subscriber.close();
      return {
        pixel,
        width,
        tracks: tracks.length,
        ended: tracks.every((track) => track.readyState === "ended"),
        connected: video.isConnected,
      };
    } finally {
      video.cancelVideoFrameCallback(callback);
      video.pause();
      video.srcObject = null;
      await subscriber.close();
      video.remove();
    }
  });
  assert.equal(result.tracks, 1, "MediaStream に映像を含めること");
  assert.equal(result.width, 16, "video 要素で実フレームを表示すること");
  // メディア要素の色変換による 8 bit の丸めだけを許す。
  assert.ok(
    result.pixel.every((value, index) => Math.abs(value - ([255, 0, 0, 255][index] ?? 0)) <= 2),
  );
  assert.equal(result.ended, true);
  assert.equal(result.connected, true, "利用者の video 要素を削除しないこと");
});
