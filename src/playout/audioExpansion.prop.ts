/** 補間は入力を変更せず、有限で振幅の制約を満たす音を返す。 */
import { test, assert } from "vite-plus/test";
import { fc } from "@fast-check/vitest";
import { expandAudio } from "./audioExpansion";

test("任意の有限 PCM の補間は、入力の所有権とピークを保つ", () => {
  fc.assert(
    fc.property(
      fc.array(fc.float({ min: -1, max: 1, noNaN: true, noDefaultInfinity: true }), {
        minLength: 960,
        maxLength: 960,
      }),
      (values) => {
        const input = Float32Array.from(values);
        const saved = input.slice();
        const output = expandAudio([input], 48000)[0];
        assert.isDefined(output);
        if (output === undefined) return;
        assert.equal(output.length, 4800);
        assert.isTrue(output.every((value) => Number.isFinite(value)));
        assert.isAtMost(
          Math.max(...output.map((value) => Math.abs(value))),
          Math.max(...input.map((value) => Math.abs(value))) + 1e-6,
        );
        assert.deepEqual(input, saved);
      },
    ),
    { numRuns: 50 },
  );
});
