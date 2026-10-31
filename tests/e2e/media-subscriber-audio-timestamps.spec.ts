/** Subscriber の LOC 解決から実 Opus decoder まで、時刻なし・0・TIMESCALE を通す。 */
import { test } from "@playwright/test";
import assert from "node:assert/strict";
import { evaluatePlayout, openPlayoutPage } from "./playoutTestPage";

for (const useWorker of [false, true]) {
  test(`購読者の時刻なしと媒体時刻 0 を区別し TIMESCALE を復号時刻へ変換する: worker=${useWorker}`, async ({
    page,
  }) => {
    await openPlayoutPage(page);
    const result = await evaluatePlayout(
      page,
      async ({ moduleUrl, harnessUrl, useWorker }) => {
        const { MediaSubscriberImpl } = await import(
          new URL("./createMediaSubscriber.ts", moduleUrl).href
        );
        const { AudioDecoderWrapper } = (await import(
          new URL("./codec/AudioDecoder.ts", moduleUrl).href
        )) as typeof import("../../src/codec/AudioDecoder");
        const loc = (await import(
          new URL("./loc.ts", moduleUrl).href
        )) as typeof import("../../src/loc");
        const { waitFor } = await import(harnessUrl);
        const packets: Uint8Array[] = [];
        const errors: string[] = [];
        const timestamps: number[] = [];
        const encoder = new AudioEncoder({
          output: (chunk) => {
            const bytes = new Uint8Array(chunk.byteLength);
            chunk.copyTo(bytes);
            packets.push(bytes);
          },
          error: (error) => errors.push(error.message),
        });
        const subscriber = new MediaSubscriberImpl(
          "https://localhost.invalid",
          { namespace: ["audio-timestamps"], audio: {} },
          { onError: (error: Error) => errors.push(error.message) },
        );
        const decoder = new AudioDecoderWrapper(useWorker, {
          output: ({ data }) => {
            timestamps.push(data.timestamp);
            data.close();
          },
          error: (error) => errors.push(error.message),
        });
        const control = subscriber as unknown as {
          audioDecoder: typeof decoder;
          audioDecoderConfigured: boolean;
          decodeAudioObject(obj: object, delivery: string, arrivalMs: number): void;
        };
        try {
          encoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1 });
          for (let index = 0; index < 6; index++) {
            const data = new AudioData({
              format: "f32",
              sampleRate: 48000,
              numberOfChannels: 1,
              numberOfFrames: 960,
              timestamp: index * 20000,
              data: Float32Array.from(
                { length: 960 },
                (_, sample) => 0.1 * Math.sin(((index * 960 + sample) * Math.PI) / 120),
              ),
            });
            encoder.encode(data);
            data.close();
          }
          await encoder.flush();
          if (packets.length < 4) throw new Error("Encoded Opus packets are missing");
          await decoder.configure("opus", 48000, 1);
          control.audioDecoder = decoder;
          control.audioDecoderConfigured = true;
          const properties = [
            undefined,
            undefined,
            loc.encodeAudioProperties({ timestamp: 0n, timescale: 1000n }),
            loc.encodeAudioProperties({ timestamp: 30n, timescale: 1000n }),
          ];
          for (let index = 0; index < 4; index++)
            control.decodeAudioObject(
              {
                groupId: 1n,
                objectId: BigInt(index),
                status: 0,
                payload: packets[index],
                properties: properties[index],
              },
              "datagram",
              performance.timeOrigin + performance.now(),
            );
          await waitFor(() => timestamps.length === 4, 2000, "実 Opus の出力");
          return { timestamps, errors };
        } finally {
          encoder.close();
          await subscriber.close();
        }
      },
      { useWorker },
    );
    assert.deepEqual(result, { timestamps: [0, 20000, 0, 30000], errors: [] });
  });
}
