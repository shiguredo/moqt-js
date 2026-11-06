/** 入力の分割位置や描画量子によって、レート変換の位相を変えない。 */
import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { AudioRenderQueue } from "./audioRenderQueue";

test("任意の分割とサンプルレートで単一の PCM と同じ波形を出す", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(8000, 16000, 44100, 48000, 96000),
      fc.constantFrom(44100, 48000),
      fc.integer({ min: 1, max: 300 }),
      fc.integer({ min: 16, max: 256 }),
      fc.double({ min: 0, max: 1, noNaN: true }),
      fc.array(fc.float({ min: -0.25, max: 0.25, noNaN: true, noDefaultInfinity: true }), {
        minLength: 2000,
        maxLength: 2000,
      }),
      (inputRate, outputRate, blockLength, quantum, fraction, values) => {
        // 周期性のない PCM も生成し、定常トーンだけでは隠れる境界誤差を調べる。
        const input = Float32Array.from(values);
        const whole = new AudioRenderQueue(outputRate);
        const divided = new AudioRenderQueue(outputRate);
        whole.enqueue({ start: fraction, sampleRate: inputRate, channels: [input] });
        for (let offset = 0; offset < input.length; offset += blockLength)
          divided.enqueue({
            start: fraction + (offset * outputRate) / inputRate,
            sampleRate: inputRate,
            channels: [input.slice(offset, offset + blockLength)],
          });
        for (
          let start = 0;
          start < (input.length * outputRate) / inputRate + quantum;
          start += quantum
        ) {
          const expected = [new Float32Array(quantum)];
          const actual = [new Float32Array(quantum)];
          whole.process(expected, start);
          divided.process(actual, start);
          for (let index = 0; index < quantum; index++)
            assert.closeTo(
              actual[0]?.[index] ?? 0,
              expected[0]?.[index] ?? 0,
              1e-6,
              "分割によって穴、重なり、位相の変化を作らないこと",
            );
        }
        assert.deepEqual(input, Float32Array.from(values), "投入した PCM の所有権を変えないこと");
      },
    ),
    { numRuns: 100 },
  );
});
