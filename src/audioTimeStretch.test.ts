/**
 * 時間圧縮 (`compressSamples`) と時間伸長 (`expandSamples`)、欠落した区間の補間
 * (`concealSamples`) の単体テスト
 *
 * 波形が周期的な音ではピッチ周期 1 つ分だけ長さが変わり、切れ目の前後がクロスフェードで
 * 繋がること、波形が繰り返していない音 (相関が足りない音) では操作しないこと、
 * 無音では操作することを固定する。補間は末尾の周期を繰り返し、末尾で位相が飛ぶ音や
 * 継ぎ目の段差が大きい音では操作しない。実際の使い方 (遅れて届いた音を目標へ戻す) は
 * audioPlayout.test.ts が、隙間の補間の予約は createMediaSubscriber.test.ts が固定する。
 */

import { test, assert } from "vite-plus/test";
import {
  compressSamples,
  concealSamples,
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

// 削ってよい長さの上限より周期が長いときは操作しない。時間圧縮は周期を 1 つ削るため、
// 遅れ (上限) が周期より短い音で動かすと削りすぎて「早すぎる」側へ振れ、次の音でまた
// 遅れて詰める往復になる (実測: 55 秒の再生で 2727 ms を詰めていた。声では粗さとして
// 聞こえる)。実際の呼び出しは src/audioPlayoutSession.ts が遅れの分を上限に渡す
test("compressSamples: 周期が上限より長いときは操作しない", () => {
  const frame = sineFrame(5);
  // 上限 120 サンプル (2.5 ms) は周期 240 サンプル (5 ms) より短い
  const limited = compressSamples([frame], SAMPLE_RATE, 120);
  assert.equal(limited.lengthChangeSamples, 0, "削らないこと");
  assert.equal(limited.channels[0]?.length, FRAME_SAMPLES, "長さが変わらないこと");
  assert.isTrue(limited.channels[0] === frame, "元の配列をそのまま返すこと");
  // 上限が周期ちょうどなら削る
  const fitted = compressSamples([frame], SAMPLE_RATE, 240);
  assert.equal(fitted.lengthChangeSamples, -240, "周期ちょうどなら削ること");
});

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

// 相関の下限 (TIME_STRETCH_CORRELATION_THRESHOLD = 0.9) は内部定数のため、
// 値そのものを写すテストは置かない。相関が足りない音を操作しないことは上のテストが担う。

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

/**
 * 周波数 `frequencyHz` の正弦波 (20 ms、48 kHz) から 20 ms の穴を補間した長さ
 *
 * 実リレーの E2E が使う音は正弦波であるため、補間の可否を周波数ごとに見るために使う
 */
function concealForFrequency(frequencyHz: number): number {
  const samples = new Float32Array(FRAME_SAMPLES);
  for (let index = 0; index < FRAME_SAMPLES; index++) {
    samples[index] = 0.5 * Math.sin((2 * Math.PI * frequencyHz * index) / SAMPLE_RATE);
  }
  return concealSamples([samples], SAMPLE_RATE, 0.02).generatedSamples;
}

/**
 * 完了条件: 補間の可否は、末尾の周期が 4 kHz へ間引いたときの格子に乗るかで決まる。格子に
 * 乗らない純音では補間しない (周期 1 つ分を繰り返すと継ぎ目で波形が飛び、クリックとして
 * 聞こえるため)。
 *
 * 実測 (48 kHz、20 ms のフレーム、振幅 0.5、20 ms の穴): 1000 Hz と 440 Hz は 960 サンプルを
 * 生成し、300 / 220 / 150 / 100 Hz は生成しない。1000 Hz は 4 kHz で 4 サンプル (格子に乗る)、
 * 440 Hz は 9.09 サンプル (乗らない) であるが、位数の 18 が探索範囲 (10〜60) に入り、継ぎ目の
 * 段差が許容に収まるため通る
 *
 * 実リレーの E2E では補間の量が小さいが、これは実装の欠陥ではなく、E2E の音が正弦波で
 * あるためである (会話や音楽では周期が格子に乗りやすく、補間が働く)
 */
test("concealSamples: 補間の可否は周期が 4 kHz の格子に乗るかで決まる", () => {
  assert.equal(concealForFrequency(1_000), 960, "格子に乗る純音は補間すること");
  assert.equal(concealForFrequency(220), 0, "格子に乗らない純音は補間しないこと");
});

// 欠落した区間の補間: 周期的な音では、末尾のピッチ周期を必要な長さまで繰り返す
test("concealSamples: 周期的な音では必要な長さだけ生成する", () => {
  const frame = sineFrame(5);
  const result = concealSamples([frame], SAMPLE_RATE, 0.04);
  assert.equal(result.generatedSamples, 1920);
  assert.equal(result.channels[0]?.length, 1920);
  const generated = result.channels[0] ?? new Float32Array(0);
  // 生成の先頭は、直前の音の末尾のピッチ周期 1 つ分から始まる
  assert.equal(generated[0], frame[FRAME_SAMPLES - 240]);
  // 繰り返しの継ぎ目で波形が飛ばない
  assert.isAtMost(maxStep(generated), maxStep(frame) * 1.2, "波形が飛ばないこと");
});

// 波形が繰り返していない音 (相関が足りない音) では補間しない
test("concealSamples: 相関が足りない音では生成しない", () => {
  const frame = noiseFrame(7);
  const result = concealSamples([frame], SAMPLE_RATE, 0.04);
  assert.equal(result.generatedSamples, 0);
  assert.equal(result.channels.length, 0);
});

// 末尾で位相が飛んでいる音では補間しない (継ぎ目がクリックになるため)
test("concealSamples: 末尾で位相が飛んでいる音では生成しない", () => {
  const frame = sineFrame(5);
  // 最後の 1 周期 (240 サンプル) だけ位相を反転する
  for (let index = FRAME_SAMPLES - 240; index < FRAME_SAMPLES; index++) {
    frame[index] = -(frame[index] ?? 0);
  }
  const result = concealSamples([frame], SAMPLE_RATE, 0.04);
  assert.equal(result.generatedSamples, 0);
});

// 継ぎ目の段差が周期の中の自然な段差より大きい音 (ランプ) では補間しない
test("concealSamples: 継ぎ目の段差が大きい音では生成しない", () => {
  const ramp = new Float32Array(FRAME_SAMPLES);
  for (let index = 0; index < FRAME_SAMPLES; index++) {
    ramp[index] = (index / FRAME_SAMPLES) * 0.9 - 0.45;
  }
  const result = concealSamples([ramp], SAMPLE_RATE, 0.04);
  assert.equal(result.generatedSamples, 0);
});

// 前半と後半で周期が違っても、末尾の周期 (後半) で繰り返す
test("concealSamples: 周期が途中で変わっても末尾の周期で繰り返す", () => {
  const frame = sineFrame(5);
  // 前半 (480 サンプル) だけ周期を 260 サンプルへ変える (前半の中では位相を連続に進める)
  for (let index = 0; index < 480; index++) {
    frame[index] = 0.5 * Math.sin((2 * Math.PI * index) / 260);
  }
  const result = concealSamples([frame], SAMPLE_RATE, 0.04);
  assert.isAbove(result.generatedSamples, 0, "末尾の周期で補間すること");
  // 継ぎ目は末尾の周期 (240 サンプル) の自然な段差と同程度になる
  const generated = result.channels[0] ?? new Float32Array(0);
  const tail = frame.subarray(FRAME_SAMPLES - 240);
  assert.isAtMost(maxStep(generated), maxStep(tail) * 1.2, "波形が飛ばないこと");
});

// 無音は補間してよい (聞こえないため)
test("concealSamples: 無音では生成する", () => {
  const silence = new Float32Array(FRAME_SAMPLES);
  const result = concealSamples([silence], SAMPLE_RATE, 0.02);
  assert.equal(result.generatedSamples, 960);
});

// 長い補間では末尾の振幅を下げる (繰り返しの音を目立たなくする)
test("concealSamples: 長い補間では末尾の振幅を下げる", () => {
  const frame = sineFrame(5);
  const result = concealSamples([frame], SAMPLE_RATE, 0.04, 0.5);
  const generated = result.channels[0] ?? new Float32Array(0);
  const peakOf = (samples: AudioSamples, from: number, to: number): number => {
    let peak = 0;
    for (let index = from; index < to; index++) {
      peak = Math.max(peak, Math.abs(samples[index] ?? 0));
    }
    return peak;
  };
  const first = peakOf(generated, 0, 100);
  const last = peakOf(generated, generated.length - 100, generated.length);
  assert.isBelow(last, first * 0.6, "末尾の振幅が下がること");
});

// ステレオでは両方のチャンネルを同じ長さだけ生成する
test("concealSamples: すべてのチャンネルを同じ長さだけ生成する", () => {
  const left = sineFrame(5);
  const right = sineFrame(5, 0.25, Math.PI / 2);
  const result = concealSamples([left, right], SAMPLE_RATE, 0.03);
  assert.equal(result.channels.length, 2);
  assert.equal(result.channels[0]?.length, 1440);
  assert.equal(result.channels[1]?.length, 1440);
});

// 空の音と 0 秒では生成しない (境界)
test("concealSamples: 空の音と 0 秒では生成しない", () => {
  assert.equal(concealSamples([new Float32Array(0)], SAMPLE_RATE, 0.04).generatedSamples, 0);
  assert.equal(concealSamples([sineFrame(5)], SAMPLE_RATE, 0).generatedSamples, 0);
});

// 16 kHz でも末尾の周期は元のサンプルレートで求まる (レートごとの換算の確認)
test("concealSamples: 16 kHz でも末尾の周期で生成する", () => {
  const samples = new Float32Array(320);
  for (let index = 0; index < samples.length; index++) {
    // 周期 5 ms (16 kHz で 80 サンプル)
    samples[index] = 0.5 * Math.sin((2 * Math.PI * index) / 80);
  }
  const result = concealSamples([samples], 16_000, 0.02);
  assert.equal(result.generatedSamples, 320);
  const generated = result.channels[0] ?? new Float32Array(0);
  assert.equal(generated[0], samples[320 - 80]);
  assert.isAtMost(maxStep(generated), maxStep(samples) * 1.2, "波形が飛ばないこと");
});

// 継ぎ目の段差の倍率 (TIME_STRETCH_MAX_SEAM_STEP_RATIO = 2) は内部定数のため、
// 値そのものを写すテストは置かない。波形が飛ばないことは上のテストが担う。
