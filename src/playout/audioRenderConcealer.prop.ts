/** 波形と描画単位を変えても、補間でチャンネルの関係と振幅を壊さない。 */
import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { AudioRenderConcealer } from "./audioRenderConcealer";

test("任意の有限 PCM の欠落と復帰で、入力を変更せず有限な逆相の出力を保つ", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(44100, 48000),
      fc.integer({ min: 32, max: 256 }),
      fc.array(fc.float({ min: -0.25, max: 0.25, noNaN: true, noDefaultInfinity: true }), {
        minLength: 1440,
        maxLength: 1440,
      }),
      (sampleRate, quantum, values) => {
        const frameLength = Math.round(sampleRate * 0.03);
        const input = Float32Array.from(
          { length: frameLength * 2 },
          (_, index) => values[index % values.length] ?? 0,
        );
        const previous = input.slice();
        const renderer = new AudioRenderConcealer(sampleRate, {
          ranges: [
            { start: 0, end: frameLength },
            { start: frameLength * 2, end: frameLength * 3 },
          ],
          stopFrame: frameLength * 3,
        });
        for (let start = 0; start < frameLength * 4; start += quantum) {
          const left = input.slice(start % frameLength, (start % frameLength) + quantum);
          const a = new Float32Array(quantum);
          a.set(left);
          const b = a.map((value) => -value);
          const output = [new Float32Array(quantum), new Float32Array(quantum)];
          renderer.process([a, b], output, start);
          for (let index = 0; index < quantum; index++) {
            const first = output[0]?.[index] ?? 0,
              second = output[1]?.[index] ?? 0;
            assert.isTrue(Number.isFinite(first) && Number.isFinite(second));
            assert.isAtMost(Math.abs(first), 0.250001);
            assert.closeTo(first, -second, 1e-6, "両チャンネルを同じ位相と重みで扱うこと");
          }
        }
        assert.deepEqual(input, previous);
      },
    ),
    { numRuns: 50 },
  );
});

test("出力幅を広げる時刻によらず、同じチャンネル配置の連続描画と同じ音になる", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(44100, 48000),
      fc.constantFrom(32, 64, 128, 256),
      fc.integer({ min: 1, max: 100 }),
      fc.integer({ min: 68, max: 500 }),
      (sampleRate, quantum, switchPosition, frequency) => {
        const warmupEnd = Math.round(sampleRate * 0.04);
        const resumeStart = Math.round(sampleRate * 0.05);
        const resumeEnd = Math.round(sampleRate * 0.09);
        const switchFrame = quantum * (1 + (switchPosition % Math.floor(resumeStart / quantum)));
        const options = {
          ranges: [
            { start: 0, end: warmupEnd, channels: 1 },
            { start: resumeStart, end: resumeEnd, channels: 2 },
          ],
          stopFrame: Math.round(sampleRate * 0.105),
        };
        const reference = new AudioRenderConcealer(sampleRate, options);
        const expanded = new AudioRenderConcealer(sampleRate, options);
        for (let start = 0; start < sampleRate * 0.11; start += quantum) {
          const frameStart = start;
          const left = Float32Array.from(
            { length: quantum },
            (_, index) =>
              0.2 * Math.sin(((frameStart + index) * 2 * Math.PI * frequency) / sampleRate),
          );
          const right = left.map((value, index) =>
            frameStart + index >= resumeStart ? -value : value,
          );
          const expected = [new Float32Array(quantum), new Float32Array(quantum)];
          const width = start >= switchFrame ? 2 : 1;
          const actual = Array.from({ length: width }, () => new Float32Array(quantum));
          reference.process([left, right], expected, start);
          expanded.process(width === 1 ? [left] : [left, right], actual, start);
          for (let channel = 0; channel < width; channel++)
            for (let index = 0; index < quantum; index++)
              assert.closeTo(
                actual[channel]?.[index] ?? 0,
                expected[channel]?.[index] ?? 0,
                1e-6,
                "履歴、予測、復帰、停止のどの途中で広げても、状態を失わないこと",
              );
        }
        assert.equal(expanded.concealedFrames, reference.concealedFrames);
        assert.equal(expanded.gaps, reference.gaps);
      },
    ),
    { numRuns: 50 },
  );
});
