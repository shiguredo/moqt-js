import { assert, test } from "vite-plus/test";
import { fc } from "@fast-check/vitest";
import {
  compressSamples,
  concealSamples,
  isTimeStretchAvailable,
  type AudioSamples,
} from "./audioTimeStretch";

/** 48 kHz、20 ms のフレームのサンプル数 */
const FRAME_SAMPLES = 960;

// 中央をまたぐ音量変化を、先に受信済みの一定振幅の区間へ圧縮位置を移して保つ。
// 位相・音量・発声位置を変え、音量の小さい第 2 チャンネルも同時に検証する。
test("時間圧縮は音量が強まる区間を保ち、長さやフレームの端を変えない", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(8000, 16000, 32000, 48000),
      fc.integer({ min: 55, max: 70 }),
      fc.integer({ min: 0, max: 99 }),
      fc.integer({ min: 10, max: 40 }),
      (sampleRate, attackPercent, phase, amplitudePercent) => {
        const period = sampleRate / 200;
        const length = sampleRate / 50;
        const attack = Math.round((length * attackPercent) / 100);
        const samples = Float32Array.from({ length }, (_, index) => {
          const amplitude = (amplitudePercent / 100) * (index < attack ? 1 : 1.2);
          return amplitude * Math.sin(2 * Math.PI * (index / period + phase / 100));
        });
        const quiet = samples.map((sample) => sample / 10);
        const original = [samples.slice(), quiet.slice()];
        const result = compressSamples([samples, quiet], sampleRate, period);
        assert.equal(result.lengthChangeSamples, -period, "同じ 1 周期だけ削ること");
        for (const [index, channel] of result.channels.entries()) {
          const input = original[index];
          assert.isDefined(input);
          if (input === undefined) return;
          assert.equal(channel.length, length - period);
          assert.equal(channel[0], input[0], "隣接フレームへ繋がる先頭を保つこと");
          assert.equal(channel.at(-1), input.at(-1), "隣接フレームへ繋がる末尾を保つこと");
          const error = channel
            .subarray(attack - period)
            .reduce(
              (maximum, value, offset) =>
                Math.max(maximum, Math.abs(value - (input[attack + offset] ?? 0))),
              0,
            );
          assert.isBelow(error, 1e-7, "強まりを弱い音との混合で潰さないこと");
        }
        assert.deepEqual([samples, quiet], original, "入力を変更しないこと");
      },
    ),
    { numRuns: 100 },
  );
});

/**
 * 基本周波数 `frequencyHz` の有声 (倍音を 1 / 次数で重ねた周期波) のフレーム
 *
 * 実際の声に近づけるため、整数次の倍音を 4 kHz (音声の帯域) まで重ねる。振幅は 0.5 に揃える
 */
function voicedFrame(frequencyHz: number): AudioSamples {
  const samples = new Float32Array(FRAME_SAMPLES);
  const maxHarmonicHz = 4_000;
  let norm = 0;
  for (let harmonic = 1; harmonic * frequencyHz < maxHarmonicHz; harmonic++) {
    norm += 1 / harmonic;
  }
  for (let index = 0; index < FRAME_SAMPLES; index++) {
    let value = 0;
    for (let harmonic = 1; harmonic * frequencyHz < maxHarmonicHz; harmonic++) {
      value += (1 / harmonic) * Math.sin((2 * Math.PI * harmonic * frequencyHz * index) / 48_000);
    }
    samples[index] = (0.5 * value) / norm;
  }
  return samples;
}

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

/**
 * 格子に乗らない F0 では、4 kHz の格子への丸めで周期が 48 kHz の 12 サンプル単位に
 * 量子化されていた。ピークの前後 1 格子の相関を放物線補間して端数まで求めることで、
 * 削る長さが真の周期に近づく。高 F0 では既存どおり周期の整数倍 (2 周期以上) を削る
 * 場合があるため、削った周期数 k に対して誤差が k サンプル以内であることを確かめる。
 *
 * 実測 (48 kHz、20 ms のフレーム、有声): 160 Hz は 300、180 Hz は 267 (真 266.667)、
 * 200 Hz は 240、220 Hz は 218 (真 218.182)、260 Hz は 185 (真 184.615)、300 Hz は
 * 322 (真 160 の 2 周期 = 320 に対する誤差 +2)。修正前は 180 / 220 / 260 Hz が
 * 264 / 216 / 180 で ±1 サンプルを外れていた。
 *
 * 失敗例を再現できるよう、修正前の誤差が大きかった F0 と、2 周期を削る F0 を `examples`
 * に入れる
 */
test("圧縮の削る長さは真の周期の ±1 サンプル (±2 周期なら ±2) に入る", () => {
  fc.assert(
    fc.property(fc.constantFrom(160, 180, 200, 220, 260, 300), (frequencyHz) => {
      const result = compressSamples([voicedFrame(frequencyHz)], 48_000, FRAME_SAMPLES / 2);
      assert.isBelow(result.lengthChangeSamples, 0, `${frequencyHz} Hz を圧縮すること`);
      const removed = -result.lengthChangeSamples;
      const truePeriod = 48_000 / frequencyHz;
      const periods = Math.round(removed / truePeriod);
      assert.isAtLeast(periods, 1, `${frequencyHz} Hz で 1 周期以上を削ること`);
      assert.isAtMost(
        Math.abs(removed - periods * truePeriod),
        periods,
        `${frequencyHz} Hz の削る長さ ${removed} が真の周期 ${truePeriod.toFixed(3)} の ${periods} 周期の ±${periods} サンプルに入ること`,
      );
    }),
    { numRuns: 60, examples: [[180], [220], [260], [300]] },
  );
});
