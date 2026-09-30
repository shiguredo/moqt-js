/**
 * 時間圧縮 (`compressSamples`) と時間伸長 (`expandSamples`) の単体テスト
 *
 * 波形が周期的な音ではピッチ周期 1 つ分だけ長さが変わり、切れ目の前後がクロスフェードで
 * 繋がること、波形が繰り返していない音 (相関が足りない音) では操作しないこと、
 * 無音では操作することを固定する。実際の使い方 (遅れて届いた音を目標へ戻す) は
 * audioPlayout.test.ts が固定する。
 */

import { test, assert } from "vite-plus/test";
import {
  TIME_STRETCH_CORRELATION_THRESHOLD,
  compressSamples,
  expandSamples,
  type AudioSamples,
} from "./audioTimeStretch";

/** Opus の 1 フレーム (20 ms、48 kHz) */
const SAMPLE_RATE = 48_000;
const FRAME_SAMPLES = 960;

/** 周期 `periodMs` の正弦波を作る (20 ms のフレーム) */
function sineFrame(periodMs: number, amplitude = 0.5, phase = 0): AudioSamples {
  const samples = new Float32Array(FRAME_SAMPLES);
  for (let index = 0; index < FRAME_SAMPLES; index++) {
    samples[index] = amplitude * Math.sin((2 * Math.PI * index) / (periodMs * 48) + phase);
  }
  return samples;
}

/** 0 から 1 の一様乱数 (決定論的) */
function noiseFrame(seed: number): AudioSamples {
  const samples = new Float32Array(FRAME_SAMPLES);
  let state = seed;
  for (let index = 0; index < FRAME_SAMPLES; index++) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    samples[index] = (state / 2_147_483_648) * 2 - 1;
  }
  return samples;
}

/** 隣り合うサンプルの差の最大値 (波形の連続性) */
function maxStep(samples: AudioSamples): number {
  let maximum = 0;
  for (let index = 1; index < samples.length; index++) {
    maximum = Math.max(maximum, Math.abs((samples[index] ?? 0) - (samples[index - 1] ?? 0)));
  }
  return maximum;
}

// 周期 5 ms の正弦波は、ピッチ周期 1 つ分 (5 ms = 240 サンプル) だけ短くなる
test("compressSamples: 周期的な音はピッチ周期 1 つ分だけ短くなる", () => {
  const frame = sineFrame(5);
  const result = compressSamples([frame], SAMPLE_RATE);
  assert.equal(result.lengthChangeSamples, -240);
  assert.equal(result.channels[0]?.length, FRAME_SAMPLES - 240);
  // 切れ目の前後がクロスフェードで繋がっている (サンプルの飛びが元より大きくならない)
  const compressed = result.channels[0] ?? new Float32Array(0);
  assert.isAtMost(maxStep(compressed), maxStep(frame) * 1.2, "波形が飛ばないこと");
});

// 波形が繰り返していない音 (相関が足りない音) では操作しない。切ると耳につくためである
test("compressSamples: 相関が足りない音は操作しない", () => {
  const frame = noiseFrame(7);
  const result = compressSamples([frame], SAMPLE_RATE);
  assert.equal(result.lengthChangeSamples, 0);
  assert.equal(result.channels[0], frame, "元の音をそのまま返すこと");
});

// 無音は詰めても聞こえないため操作する (NetEq の「有効な音声でない」ときの扱いと同じ)
test("compressSamples: 無音は操作する", () => {
  const silence = new Float32Array(FRAME_SAMPLES);
  const result = compressSamples([silence], SAMPLE_RATE);
  assert.isBelow(result.lengthChangeSamples, 0, "無音は詰めること");
});

// ステレオでは両方のチャンネルが同じ長さだけ変わる
test("compressSamples: すべてのチャンネルを同じ長さだけ詰める", () => {
  const left = sineFrame(5);
  const right = sineFrame(5, 0.25, Math.PI / 2);
  const result = compressSamples([left, right], SAMPLE_RATE);
  assert.equal(result.channels.length, 2);
  assert.equal(result.channels[0]?.length, result.channels[1]?.length);
  assert.equal(result.channels[0]?.length, FRAME_SAMPLES + result.lengthChangeSamples);
});

// 時間伸長はピッチ周期 1 つ分だけ長くなる
test("expandSamples: 周期的な音はピッチ周期 1 つ分だけ長くなる", () => {
  const frame = sineFrame(5);
  const result = expandSamples([frame], SAMPLE_RATE);
  assert.equal(result.lengthChangeSamples, 240);
  assert.equal(result.channels[0]?.length, FRAME_SAMPLES + 240);
  const expanded = result.channels[0] ?? new Float32Array(0);
  assert.isAtMost(maxStep(expanded), maxStep(frame) * 1.2, "波形が飛ばないこと");
});

// 相関が足りない音では伸長もしない
test("expandSamples: 相関が足りない音は操作しない", () => {
  const frame = noiseFrame(11);
  const result = expandSamples([frame], SAMPLE_RATE);
  assert.equal(result.lengthChangeSamples, 0);
  assert.equal(result.channels[0], frame, "元の音をそのまま返すこと");
});

// 空の音では何もしない (境界)
test("compressSamples: 空の音では何もしない", () => {
  const result = compressSamples([new Float32Array(0)], SAMPLE_RATE);
  assert.equal(result.lengthChangeSamples, 0);
});

// 相関の下限は NetEq と同じ 0.9 である (値そのものを固定する)
test("TIME_STRETCH_CORRELATION_THRESHOLD: NetEq と同じ 0.9", () => {
  assert.equal(TIME_STRETCH_CORRELATION_THRESHOLD, 0.9);
});

// 16 kHz でもピッチ周期は元のサンプルレートで求まる (レートごとの換算の確認)
test("compressSamples: 16 kHz でもピッチ周期 1 つ分だけ短くなる", () => {
  const samples = new Float32Array(320);
  for (let index = 0; index < samples.length; index++) {
    // 周期 5 ms (16 kHz で 80 サンプル)
    samples[index] = 0.5 * Math.sin((2 * Math.PI * index) / 80);
  }
  const result = compressSamples([samples], 16_000);
  assert.equal(result.lengthChangeSamples, -80);
  assert.equal(result.channels[0]?.length, 320 - 80);
});
