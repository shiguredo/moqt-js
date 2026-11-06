/** 実 decoder の再構成・復旧で購読位置を保持し、待機中に入力を通さない。 */
import { test } from "@playwright/test";
import assert from "node:assert/strict";
import { evaluatePlayout, openPlayoutPage } from "./playoutTestPage";

for (const useWorker of [false, true]) {
  for (const operation of ["error", "configure"] as const) {
    test(`同じ購読の映像復旧で位置を保持する: ${operation}, worker=${useWorker}`, async ({
      page,
    }) => {
      await openPlayoutPage(page);
      const result = await evaluatePlayout(
        page,
        async ({ moduleUrl, useWorker, operation }) => {
          const { MediaSubscriberImpl } = await import(
            new URL("./createMediaSubscriber.ts", moduleUrl).href
          );
          const { VideoDecoderWrapper } = (await import(
            new URL("./codec/VideoDecoder.ts", moduleUrl).href
          )) as typeof import("../../src/codec/VideoDecoder");
          const { playoutVideoInputsOf } = (await import(
            new URL("./testSupport/mediaPlayoutInternals.ts", moduleUrl).href
          )) as typeof import("../../src/testSupport/mediaPlayoutInternals");
          const errors: string[] = [];
          const frames: number[] = [];
          const subscriber = new MediaSubscriberImpl(
            "https://localhost.invalid",
            { namespace: ["video-recovery"], video: {} },
            {
              onError: (error: Error) => {
                errors.push(error.message);
                throw new Error("通知の失敗");
              },
            },
          );
          const decoder = new VideoDecoderWrapper(useWorker, {
            output: ({ frame }: { frame: VideoFrame }) => {
              frames.push(frame.timestamp);
              frame.close();
            },
            error: (error: Error) => errors.push(error.message),
          });
          await decoder.configure("vp8", 64, 64);
          const control = subscriber as unknown as {
            videoDecoder: typeof decoder;
            videoDecoderConfigured: boolean;
            videoTrackInfo: object;
            playout: import("../../src/playout/mediaPlayout").MediaPlayout;
            videoDecodeOrder: import("../../src/videoDecodeOrder").VideoDecodeOrder;
            handleVideoDecoderError(error: Error): Promise<void>;
            reconfigureVideoDecoder(description: Uint8Array): Promise<void>;
          };
          control.videoDecoder = decoder;
          control.videoDecoderConfigured = true;
          control.videoTrackInfo = { name: "video", codec: "vp8", width: 64, height: 64 };
          const key = (groupId: bigint, objectId: bigint) => ({
            groupId,
            objectId,
            isKeyFrame: true,
            priorObjectIdGap: 0n,
          });
          control.videoDecodeOrder.admit(key(5n, 10n));
          // 復旧で出力されなくなった旧入力を残すと、同じ timestamp の新しい出力が旧位置を引く。
          control.playout.trackVideoDecodeInput(1000000, {
            timestampKind: "wallClock",
            location: { group: 5n, object: 10n },
          });
          try {
            const pending =
              operation === "error"
                ? control.handleVideoDecoderError(new Error("Decoder failure"))
                : control.reconfigureVideoDecoder(new Uint8Array());
            const configuredDuring = control.videoDecoderConfigured;
            await pending;
            return {
              configuredDuring,
              configuredAfter: control.videoDecoderConfigured,
              pendingInputsAfter: playoutVideoInputsOf(control.playout).size,
              old: control.videoDecodeOrder.admit(key(1n, 0n)),
              repeated: control.videoDecodeOrder.admit(key(5n, 10n)),
              next: control.videoDecodeOrder.admit(key(5n, 11n)),
              errors,
              frames,
            };
          } finally {
            await subscriber.close();
          }
        },
        { useWorker, operation },
      );
      assert.equal(result.configuredDuring, false, "復旧中は旧 decoder へ入力を通さないこと");
      assert.equal(result.configuredAfter, true, "実 decoder の復旧後に入力を再開すること");
      assert.equal(result.pendingInputsAfter, 0, "復旧前の未出力の入力情報を残さないこと");
      assert.deepEqual(result.old, { decode: false, reason: "stale" });
      assert.deepEqual(result.repeated, { decode: false, reason: "stale" });
      assert.deepEqual(result.next, { decode: true });
      assert.deepEqual(result.errors, operation === "error" ? ["Decoder failure"] : []);
    });
  }
}

test("同じ失敗した映像設定を繰り返さず、異なる設定なら実 decoder を再構成できる", async ({
  page,
}) => {
  await openPlayoutPage(page);
  const result = await evaluatePlayout(page, async ({ moduleUrl }) => {
    const { MediaSubscriberImpl } = await import(
      new URL("./createMediaSubscriber.ts", moduleUrl).href
    );
    const { VideoDecoderWrapper } = (await import(
      new URL("./codec/VideoDecoder.ts", moduleUrl).href
    )) as typeof import("../../src/codec/VideoDecoder");
    const errors: string[] = [];
    const frames: number[] = [];
    const subscriber = new MediaSubscriberImpl(
      "https://localhost.invalid",
      { namespace: ["video-config"], video: {} },
      { onError: (error: Error) => errors.push(error.message) },
    );
    const decoder = new VideoDecoderWrapper(false, {
      output: ({ frame }: { frame: VideoFrame }) => {
        frames.push(frame.timestamp);
        frame.close();
      },
      error: (error: Error) => errors.push(error.message),
    });
    await decoder.configure("vp8", 64, 64);
    const control = subscriber as unknown as {
      videoDecoder: typeof decoder;
      videoDecoderConfigured: boolean;
      videoTrackInfo: { codec: string; width: number; height: number };
      reconfigureVideoDecoder(description: Uint8Array): Promise<void>;
    };
    control.videoDecoder = decoder;
    control.videoDecoderConfigured = true;
    control.videoTrackInfo = { codec: "unsupported-video-codec", width: 64, height: 64 };
    try {
      await control.reconfigureVideoDecoder(new Uint8Array());
      await control.reconfigureVideoDecoder(new Uint8Array());
      const repeatedErrors = errors.length;
      control.videoTrackInfo = { codec: "vp8", width: 64, height: 64 };
      await control.reconfigureVideoDecoder(new Uint8Array());
      return { repeatedErrors, configured: control.videoDecoderConfigured, state: decoder.state };
    } finally {
      await subscriber.close();
    }
  });
  assert.equal(result.repeatedErrors, 1, "同一の恒久エラーを Object ごとに再通知しないこと");
  assert.equal(result.configured, true, "異なる構成では再試行すること");
  assert.equal(result.state, "configured");
});

test("新しい config の最初の実キーフレームを捨てず、旧 Group の config は適用しない", async ({
  page,
}) => {
  await openPlayoutPage(page);
  const result = await evaluatePlayout(page, async ({ moduleUrl, harnessUrl }) => {
    const { MediaSubscriberImpl } = await import(
      new URL("./createMediaSubscriber.ts", moduleUrl).href
    );
    const { VideoDecoderWrapper } = (await import(
      new URL("./codec/VideoDecoder.ts", moduleUrl).href
    )) as typeof import("../../src/codec/VideoDecoder");
    const loc = await import(new URL("./loc.ts", moduleUrl).href);
    const { waitFor } = await import(harnessUrl);
    const errors: string[] = [],
      frames: number[] = [];
    let payload: Uint8Array | null = null;
    const encoder = new VideoEncoder({
      output: (chunk) => {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        payload = bytes;
      },
      error: (error) => errors.push(error.message),
    });
    const subscriber = new MediaSubscriberImpl(
      "https://localhost.invalid",
      { namespace: ["video-config-key"], video: {} },
      { onError: (error: Error) => errors.push(error.message) },
    );
    const decoder = new VideoDecoderWrapper(false, {
      output: ({ frame }: { frame: VideoFrame }) => {
        frames.push(frame.timestamp);
        frame.close();
      },
      error: (error: Error) => errors.push(error.message),
    });
    const control = subscriber as unknown as {
      videoDecoder: typeof decoder;
      videoDecoderConfigured: boolean;
      videoTrackInfo: object;
      videoDecoderGeneration: number;
      decodeVideoObject(obj: object): void;
    };
    try {
      encoder.configure({ codec: "vp8", width: 64, height: 64 });
      const canvas = new OffscreenCanvas(64, 64);
      canvas.getContext("2d")?.fillRect(0, 0, 64, 64);
      const frame = new VideoFrame(canvas, { timestamp: 1000000 });
      encoder.encode(frame, { keyFrame: true });
      frame.close();
      await encoder.flush();
      await decoder.configure("vp8", 64, 64);
      control.videoDecoder = decoder;
      control.videoDecoderConfigured = true;
      control.videoTrackInfo = { name: "video", codec: "vp8", width: 64, height: 64 };
      const obj = {
        groupId: 1n,
        objectId: 0n,
        status: 0,
        payload,
        properties: loc.encodeVideoProperties({ timestamp: 1000000n, config: new Uint8Array() }),
      };
      control.decodeVideoObject(obj);
      await waitFor(() => frames.length === 1, 2000, "再構成を開始したキーフレームの出力");
      const generation = control.videoDecoderGeneration;
      control.decodeVideoObject({
        ...obj,
        groupId: 0n,
        properties: loc.encodeVideoProperties({ timestamp: 0n, config: new Uint8Array([1]) }),
      });
      return { frames, errors, staleChangedConfig: control.videoDecoderGeneration !== generation };
    } finally {
      encoder.close();
      await subscriber.close();
    }
  });
  assert.deepEqual(result, { frames: [1000000], errors: [], staleChangedConfig: false });
});
