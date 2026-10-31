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
