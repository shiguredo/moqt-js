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

for (const { directAudio, directVideo } of [
  { directAudio: true, directVideo: false },
  { directAudio: false, directVideo: true },
  { directAudio: true, directVideo: true },
]) {
  test(`SDK の直接出力と MediaStream 出力を組み合わせる 音声 ${directAudio} / 映像 ${directVideo}`, async ({
    page,
  }) => {
    await openPlayoutPage(page);
    const result = await evaluatePlayout(
      page,
      async ({ moduleUrl, harnessUrl, directAudio, directVideo }) => {
        const { MediaSubscriberImpl } = (await import(
          new URL("./createMediaSubscriber.ts", moduleUrl).href
        )) as typeof import("../../src/createMediaSubscriber");
        const { waitFor } = (await import(harnessUrl)) as typeof import("./playoutBrowserHarness");
        const context = new AudioContext({ latencyHint: "interactive" });
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        const mute = context.createGain();
        mute.gain.value = 0;
        analyser.connect(mute).connect(context.destination);
        const canvas = document.createElement("canvas");
        canvas.width = 16;
        canvas.height = 16;
        document.body.append(canvas);
        const drawing = canvas.getContext("2d");
        if (drawing === null) throw new Error("canvas を作成できない");
        let presented = 0;
        let inputFrame: VideoFrame | null = null;
        const subscriber = new MediaSubscriberImpl(
          "https://localhost.invalid",
          {
            namespace: ["direct-output"],
            audio: {
              minDelayMs: 10,
              ...(directAudio ? { output: { context, destination: analyser } } : {}),
            },
            video: directVideo
              ? {
                  output: {
                    presentationLatencyTicks: 0,
                    isAvailable: () => canvas.isConnected,
                    present: (frame: VideoFrame) => {
                      try {
                        drawing.drawImage(frame, 0, 0);
                        presented++;
                        return true;
                      } finally {
                        frame.close();
                      }
                    },
                  },
                }
              : {},
          },
          {},
        );
        const control = subscriber as unknown as {
          createOutputStream(): Promise<void>;
          audioTrackInfo: object;
          videoTrackInfo: object;
          audioOutput: { context: AudioContext };
          videoWriter: unknown;
          videoOutputTrack: unknown;
          playout: import("../../src/playout/mediaPlayout").MediaPlayout;
        };
        control.audioTrackInfo = {
          name: "audio",
          packaging: "loc",
          isLive: true,
          codec: "opus",
          samplerate: 48000,
        };
        control.videoTrackInfo = { name: "video", packaging: "loc", isLive: true, codec: "vp8" };
        try {
          await context.resume();
          await control.createOutputStream();
          const outputContext = control.audioOutput.context;
          const audioTracks = subscriber.mediaStream?.getAudioTracks() ?? [];
          const videoTracks = subscriber.mediaStream?.getVideoTracks() ?? [];
          const bypassedVideoTrack =
            control.videoWriter === null && control.videoOutputTrack === null;
          const data = new AudioData({
            format: "f32",
            sampleRate: 48000,
            numberOfChannels: 1,
            numberOfFrames: 4800,
            timestamp: 0,
            data: new Float32Array(4800).fill(0.2),
          });
          control.playout.trackAudioDecodeInput(0, { timestampKind: "mediaTime" });
          const audioStatus = control.playout.pushAudio(data).status;
          data.close();
          // 出力ノードへ音が実際に届くことを確認する。予約成功の統計だけでは判定しない。
          if (directAudio) {
            const samples = new Float32Array(analyser.fftSize);
            await waitFor(
              () => {
                analyser.getFloatTimeDomainData(samples);
                return samples.some((sample) => Math.abs(sample) > 0.1);
              },
              2000,
              "直接音声出力の信号",
            );
          }
          if (directVideo) {
            const source = document.createElement("canvas");
            source.width = 16;
            source.height = 16;
            const sourceDrawing = source.getContext("2d");
            if (sourceDrawing === null) throw new Error("入力 canvas を作成できない");
            sourceDrawing.fillStyle = "rgb(255, 0, 0)";
            sourceDrawing.fillRect(0, 0, 16, 16);
            inputFrame = new VideoFrame(source, { timestamp: 0 });
            control.playout.trackVideoDecodeInput(0, {
              timestampKind: "mediaTime",
              location: { group: 0n, object: 0n },
            });
            control.playout.pushVideo(inputFrame);
            await waitFor(() => presented === 1, 2000, "直接映像出力の描画");
          }
          const pixel = Array.from(drawing.getImageData(0, 0, 1, 1).data);
          const frameClosed = inputFrame === null || inputFrame.codedWidth === 0;
          await subscriber.close();
          // 終了後にも利用者のグラフを実際に駆動し、SDK が共有ノードを切り離していないか確かめる。
          const source = context.createConstantSource();
          source.offset.value = 0.3;
          source.connect(analyser);
          source.start();
          const samples = new Float32Array(analyser.fftSize);
          await waitFor(
            () => {
              analyser.getFloatTimeDomainData(samples);
              return samples.some((sample) => sample > 0.25);
            },
            2000,
            "終了後の共有音声出力",
          );
          source.stop();
          source.disconnect();
          return {
            audioStatus,
            audioTracks: audioTracks.length,
            videoTracks: videoTracks.length,
            bypassedVideoTrack,
            presented,
            pixel,
            frameClosed,
            contextState: context.state,
            outputState: outputContext.state,
            connected: canvas.isConnected,
            tracksEnded: [...audioTracks, ...videoTracks].every(
              (track) => track.readyState === "ended",
            ),
          };
        } finally {
          await subscriber.close();
          await context.close();
          canvas.remove();
        }
      },
      { directAudio, directVideo },
    );
    assert.equal(result.audioStatus, "played");
    assert.equal(result.audioTracks, directAudio ? 0 : 1);
    assert.equal(result.videoTracks, directVideo ? 0 : 1);
    assert.equal(
      result.bypassedVideoTrack,
      directVideo,
      "直接表示では映像トラックを生成しないこと",
    );
    assert.equal(result.contextState, "running", "利用者の Context を閉じないこと");
    assert.equal(result.outputState, directAudio ? "running" : "closed");
    assert.equal(result.tracksEnded, true, "SDK が所有するトラックだけを止めること");
    if (directVideo) {
      assert.equal(result.presented, 1);
      assert.equal(result.frameClosed, true);
      assert.deepEqual(result.pixel, [255, 0, 0, 255]);
      assert.equal(result.connected, true);
    }
  });
}
