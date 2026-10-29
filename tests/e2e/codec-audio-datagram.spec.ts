/** 復号前の Datagram 欠落でも、実 Opus の出力が媒体の時刻を保つことを検証する。 */
import { test, expect } from "@playwright/test";
import { evaluatePlayout, openPlayoutPage } from "./playoutTestPage";

test("Opus の timestamp の復元はステレオの PCM と所有権を保ち、時刻なしの連続時計を変えない", async ({
  page,
}) => {
  await openPlayoutPage(page);
  const result = await evaluatePlayout(page, async ({ moduleUrl }) => {
    const { OpusDecoderTimestamps } = await import(
      new URL("./codec/opusDecoderTimestamps.ts", moduleUrl).href
    );
    const timestamps = new OpusDecoderTimestamps(true);
    const original = Float32Array.from(
      { length: 1920 },
      (_, index) => Math.sin(index * 0.01) * 0.3,
    );
    const data = new AudioData({
      format: "f32-planar",
      sampleRate: 48000,
      numberOfChannels: 2,
      numberOfFrames: 960,
      timestamp: 20000,
      data: original,
    });
    timestamps.submit(60000);
    const restored = timestamps.restore(data);
    const actual = new Float32Array(1920);
    for (let planeIndex = 0; planeIndex < 2; planeIndex++)
      restored.copyTo(actual.subarray(planeIndex * 960, (planeIndex + 1) * 960), {
        planeIndex,
        format: "f32-planar",
      });
    const timestamp = restored.timestamp;
    const framesAfterRestore = data.numberOfFrames;
    timestamps.submit(null);
    const withoutTimestamp = timestamps.restore(restored);
    const unchangedTimestamp = withoutTimestamp.timestamp;
    timestamps.submit(0);
    const zeroTimestamp = timestamps.restore(withoutTimestamp);
    const restoredZero = zeroTimestamp.timestamp;
    zeroTimestamp.close();
    return {
      timestamp,
      unchangedTimestamp,
      restoredZero,
      framesAfterRestore,
      maxError: actual.reduce(
        (maximum, value, index) => Math.max(maximum, Math.abs(value - (original[index] ?? 0))),
        0,
      ),
    };
  });
  expect(result.timestamp).toBe(60000);
  expect(result.unchangedTimestamp).toBe(60000);
  expect(result.restoredZero).toBe(0);
  expect(result.framesAfterRestore).toBe(0);
  expect(result.maxError).toBe(0);
});

for (const useWorker of [false, true]) {
  for (const frameDuration of [2500, 5000, 10000, 20000, 40000, 60000]) {
    test(`Opus の Datagram 欠落後と時刻 0 への復帰で timestamp を保つ: Worker=${String(useWorker)}, ${String(frameDuration)} us`, async ({
      page,
    }) => {
      await openPlayoutPage(page);
      const result = await evaluatePlayout(
        page,
        async ({ moduleUrl, useWorker, frameDuration }) => {
          const { AudioDecoderWrapper } = await import(
            new URL("./codec/AudioDecoder.ts", moduleUrl).href
          );
          const { encodeObjectDatagram, decodeObjectDatagram } = await import(
            new URL("./dataStream/datagram.ts", moduleUrl).href
          );
          const chunks: EncodedAudioChunk[] = [];
          const errors: Error[] = [];
          const encoder = new AudioEncoder({
            output: (chunk) => chunks.push(chunk),
            error: (error) => {
              errors.push(error);
            },
          });
          encoder.configure({
            codec: "opus",
            sampleRate: 48000,
            numberOfChannels: 1,
            opus: { frameDuration },
          });
          const frames = (frameDuration * 48000) / 1000000;
          for (let index = 0; index < 20; index++) {
            const data = new AudioData({
              format: "f32-planar",
              sampleRate: 48000,
              numberOfChannels: 1,
              numberOfFrames: frames,
              timestamp: index * frameDuration,
              data: Float32Array.from(
                { length: frames },
                (_, offset) =>
                  0.3 * Math.sin((2 * Math.PI * 170 * (index * frames + offset)) / 48000),
              ),
            });
            encoder.encode(data);
            data.close();
          }
          await encoder.flush();
          encoder.close();
          // 複数の連続欠落を含める。欠落分を詰めた timestamp なら 5 番目以降で失敗する。
          const received = chunks.filter((_, index) => ![4, 5, 6, 13].includes(index));
          const timestamps: number[] = [];
          const lengths: number[] = [];
          const decoder = new AudioDecoderWrapper(useWorker, {
            output: ({ data }: { data: AudioData }) => {
              timestamps.push(data.timestamp);
              lengths.push(data.numberOfFrames);
              data.close();
            },
            error: (error: Error) => {
              errors.push(error);
            },
          });
          try {
            await decoder.configure("opus", 48000, 1);
            for (const [index, chunk] of received.entries()) {
              const payload = new Uint8Array(chunk.byteLength);
              chunk.copyTo(payload);
              const wire = encodeObjectDatagram({
                type: 0x0c,
                trackAlias: 1n,
                groupId: BigInt(index),
                objectId: 0n,
                payload,
              });
              const [object] = decodeObjectDatagram(wire);
              if (object.payload === undefined) throw new Error("Decoded audio payload is missing");
              // 途中で媒体時刻が 0 に戻っても、復号器の連続時計と区別して保つ。
              decoder.decode(object.payload, "key", index === 3 ? 0 : chunk.timestamp, 0);
            }
            const deadline = performance.now() + 3000;
            while (timestamps.length < received.length && performance.now() < deadline) {
              const error = errors[0];
              if (error !== undefined) throw error;
              await new Promise<void>((resolve) => {
                setTimeout(resolve, 10);
              });
            }
            const error = errors[0];
            if (error !== undefined) throw error;
            return {
              timestamps,
              expected: received.map((chunk, index) => (index === 3 ? 0 : chunk.timestamp)),
              lengths,
              frames,
            };
          } finally {
            decoder.close();
          }
        },
        { useWorker, frameDuration },
      );
      expect(result.timestamps).toEqual(result.expected);
      expect(result.lengths.every((length) => length === result.frames)).toBe(true);
    });
  }
}
