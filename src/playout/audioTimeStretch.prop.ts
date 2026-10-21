import { assert, test } from "vite-plus/test";
import * as fc from "fast-check";
import { compressSamples, concealSamples, isTimeStretchAvailable } from "./audioTimeStretch";

// 細探索の範囲を広げても、既存レートの完全一致する整数周期をずらしてはならない。
// 有限窓の隣接相関は非対称になり得るため、完全相関に放物線補間を掛けると位相が崩れる。
test("整数周期の補間は既存レートと任意の位相で元の波形を保つ", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(8_000, 16_000, 32_000, 48_000),
      fc.integer({ min: 0, max: 99 }),
      (sampleRate, phase) => {
        const sample = (index: number) =>
          0.5 * Math.sin(2 * Math.PI * ((400 * index) / sampleRate + phase / 100));
        const length = sampleRate / 50;
        const reference = Float32Array.from({ length }, (_, index) => sample(index));
        const output = concealSamples([reference], sampleRate, 0.1).channels[0];
        assert.isDefined(output);
        if (output === undefined) return;
        assert.equal(output.length, sampleRate / 10);
        const maximumError = output.reduce(
          (maximum, value, index) => Math.max(maximum, Math.abs(value - sample(length + index))),
          0,
        );
        assert.isBelow(maximumError, 1e-5, "完全な整数周期に不要な位相誤差を加えないこと");
      },
    ),
    { numRuns: 100, examples: [[8_000, 10]] },
  );
});

// 4 kHz の探索下限付近では元のレートの周期が整数にならない。長い穴の末尾まで
// 位相を保ち、細探索の境界への丸めで周波数が変わらないことを、元の連続波形と比較する。
test("44.1 kHz の補間は探索下限付近の端数周期も保つ", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 395, max: 400 }),
      fc.integer({ min: 0, max: 99 }),
      fc.integer({ min: 20, max: 100 }),
      (frequency, phase, gapMs) => {
        const sample = (index: number) =>
          0.5 * Math.sin(2 * Math.PI * ((frequency * index) / 44_100 + phase / 100));
        const reference = Float32Array.from({ length: 882 }, (_, index) => sample(index));
        const concealed = concealSamples([reference], 44_100, gapMs / 1_000);
        const output = concealed.channels[0];
        assert.isDefined(output);
        if (output === undefined) return;
        assert.equal(output.length, Math.round(gapMs * 44.1));
        const maximumError = output.reduce(
          (maximum, value, index) => Math.max(maximum, Math.abs(value - sample(882 + index))),
          0,
        );
        assert.isBelow(maximumError, 0.04, "長い補間でも元の周期の位相を保つこと");
      },
    ),
    { numRuns: 100, examples: [[399, 71, 100]] },
  );
});

// 44.1 kHz の非整数の周期でも、音声本体のレートを変えずに同じ波形の周期を詰める。
// 圧縮可能な有声音を生成し、チャンネルの長さと、削る量の上限も検証する。
test("44.1 kHz の有声音を圧縮・補間できる", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 200, max: 300 }),
      fc.integer({ min: 0, max: 100 }),
      (frequency, phase) => {
        const sampleRate = 44_100;
        const samples = Float32Array.from(
          { length: 882 },
          (_, index) =>
            0.3 * Math.sin(2 * Math.PI * ((frequency * index) / sampleRate + phase / 100)),
        );
        assert.isTrue(isTimeStretchAvailable(sampleRate));
        const compressed = compressSamples([samples, samples], sampleRate, 441);
        assert.isBelow(compressed.lengthChangeSamples, 0, "周期的な音声は時間圧縮できること");
        assert.isAtLeast(compressed.lengthChangeSamples, -441, "指定より多く削らないこと");
        assert.equal(compressed.channels[0]?.length, 882 + compressed.lengthChangeSamples);
        assert.equal(compressed.channels[0]?.length, compressed.channels[1]?.length);
        const concealed = concealSamples([samples], sampleRate, 0.02);
        assert.equal(concealed.generatedSamples, 882, "欠落を元のサンプルレートで埋めること");
        assert.isTrue(
          concealed.channels.every((channel) => channel.every((sample) => Number.isFinite(sample))),
        );
      },
    ),
    { numRuns: 50 },
  );
});
