/**
 * AudioMeterAccumulator の単体テスト
 *
 * 配信側の音声メーターは、取っている音の AudioData (マイクでは 10 ms ごと) を受けるたびに
 * サンプルを溜め、間隔ごとに peak / RMS (dBFS) と直近の波形を出す。値の求め方は受信側の
 * メーターと同じ関数 (utils/audioLevel.ts) を使う。
 */

import { test, assert } from "vite-plus/test";
import { AudioMeterAccumulator } from "./audioMeterAccumulator";
import { summarizeAudioLevel, waveformSampleCount } from "./audioLevel";

/** 振幅 amplitude の方形波を count サンプル作る */
function square(amplitude: number, count: number): Float32Array {
  return Float32Array.from({ length: count }, (_value, index) =>
    index % 2 === 0 ? amplitude : -amplitude,
  );
}

// 最初の AudioData ではすぐに値を出す (メーターが動き始めるまで待たせない)
test("push: 最初の AudioData ですぐに値を出す", () => {
  const accumulator = new AudioMeterAccumulator(50);
  const samples = square(0.5, 480);
  const snapshot = accumulator.push(samples, 48_000, 0);
  assert.isNotNull(snapshot);
  assert.deepEqual(
    { peakDbfs: snapshot?.peakDbfs, rmsDbfs: snapshot?.rmsDbfs },
    summarizeAudioLevel(samples),
  );
});

// 間隔の間は値を出さず、間隔を過ぎたら溜めた分をまとめて求める
test("push: 間隔の間は値を出さず、過ぎたら溜めた分から求める", () => {
  const accumulator = new AudioMeterAccumulator(50);
  accumulator.push(square(0.1, 480), 48_000, 0);
  assert.isNull(accumulator.push(square(0.9, 480), 48_000, 10));
  const quiet = square(0.1, 480);
  const snapshot = accumulator.push(quiet, 48_000, 60);
  assert.isNotNull(snapshot);
  // 間隔の間に来た大きな音 (0.9) も peak に入る
  assert.deepEqual(
    { peakDbfs: snapshot?.peakDbfs, rmsDbfs: snapshot?.rmsDbfs },
    summarizeAudioLevel(new Float32Array([...square(0.9, 480), ...quiet])),
  );
});

// 波形は受信側と同じ長さ (waveformSampleCount) の直近のサンプルを持つ
test("push: 波形は直近のサンプルを waveformSampleCount 個まで持つ", () => {
  const accumulator = new AudioMeterAccumulator(0);
  let snapshot = null;
  for (let index = 0; index < 100; index++) {
    snapshot = accumulator.push(square(0.5, 480), 48_000, index * 10);
  }
  assert.equal(snapshot?.waveform.length, waveformSampleCount(48_000));
});
