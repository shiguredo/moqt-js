import { test, assert } from "vite-plus/test";
import {
  AUDIO_LEVEL_SILENCE,
  TONE_ENVELOPE_PERIOD_SECONDS,
  TONE_FREQUENCY_HZ,
  createToneSamples,
  summarizeToneLevel,
} from "./dummyAudio";

// 単体テストは Node 環境で動くため、AudioContext / MediaStream を使う
// createDummyAudioStream は対象外にする (ブラウザ側で確認する)。

const SAMPLE_RATE = 48000;
const CHANNELS = 2;

test("createToneSamples は f32-planar のサンプル列を作る", () => {
  const frameCount = 4800;
  const samples = createToneSamples(SAMPLE_RATE, CHANNELS, frameCount);

  // チャンネルごとに連続した並び (AudioBuffer.copyToChannel へそのまま渡せる形)
  assert.equal(samples.length, frameCount * CHANNELS);

  // 全チャンネルが同じ信号であること (モノラルのトーンを全チャンネルへ配る)
  for (let frame = 0; frame < frameCount; frame++) {
    assert.equal(samples[frame], samples[frameCount + frame]);
  }
});

test("createToneSamples の振幅は 0 より大きく 1 未満に収まる", () => {
  const samples = createToneSamples(SAMPLE_RATE, CHANNELS, SAMPLE_RATE);

  let peak = 0;
  for (const value of samples) {
    const magnitude = Math.abs(value);
    if (magnitude > peak) {
      peak = magnitude;
    }
  }

  // 振幅は 0.2〜0.3 の範囲でゆっくり変化する。無音 (0) でも飽和 (1 以上) でもない
  assert.isAbove(peak, 0.2);
  assert.isBelow(peak, 0.3);
});

test("createToneSamples は 440 Hz の周期性を持つ", () => {
  // 1 秒分のゼロ交差回数は 2 * 440 回になる。
  // エンベロープは振幅のみを変え符号は変えないため、符号の反転回数で周期を確認できる
  const samples = createToneSamples(SAMPLE_RATE, 1, SAMPLE_RATE);

  let zeroCrossings = 0;
  for (let i = 1; i < samples.length; i++) {
    const previous = samples[i - 1] ?? 0;
    const current = samples[i] ?? 0;
    if ((previous < 0 && current >= 0) || (previous >= 0 && current < 0)) {
      zeroCrossings++;
    }
  }

  // 端数のずれを許容し、期待値の前後 2 回に収まることを確認する
  const expected = 2 * TONE_FREQUENCY_HZ;
  assert.isAtLeast(zeroCrossings, expected - 2);
  assert.isAtMost(zeroCrossings, expected + 2);
});

test("createToneSamples は startFrame から連続したサンプル列を返す", () => {
  const first = createToneSamples(SAMPLE_RATE, 1, 100);
  const second = createToneSamples(SAMPLE_RATE, 1, 100, 100);

  // startFrame を進めた続きは、1 回で作った列の後半と一致する
  const combined = createToneSamples(SAMPLE_RATE, 1, 200);
  for (let i = 0; i < 100; i++) {
    assert.equal(first[i], combined[i]);
    assert.equal(second[i], combined[100 + i]);
  }
});

test("createToneSamples のエンベロープはループの継ぎ目で連続する", () => {
  // AudioBuffer は TONE_ENVELOPE_PERIOD_SECONDS 秒で作ってループ再生するため、
  // 末尾と先頭で振幅が飛ばないことを確認する
  const frameCount = SAMPLE_RATE * TONE_ENVELOPE_PERIOD_SECONDS;
  const samples = createToneSamples(SAMPLE_RATE, 1, frameCount + 1);

  // 1 サンプル分の差は 440 Hz の波形としては最大でも振幅程度だが、
  // エンベロープの周期が一致していれば「次のサンプル」は先頭とほぼ同じ値になる
  const first = samples[0] ?? 0;
  const wrapped = samples[frameCount] ?? 0;
  assert.isBelow(Math.abs(first - wrapped), 0.05);
});

test("summarizeToneLevel はトーンから -dBov と voiceActivity を求める", () => {
  const samples = createToneSamples(SAMPLE_RATE, CHANNELS, SAMPLE_RATE);
  const level = summarizeToneLevel(samples);

  // RFC 6464 §3 の level は 0〜127 (0 が最大音量)。正弦波の RMS は振幅の 1/sqrt(2)、
  // 振幅は 0.2〜0.3 でゆっくり変わるため、1 秒分の RMS は約 0.178 となり
  // -20*log10(0.178) = 約 15 dBov になる
  assert.isAtLeast(level.level, 0);
  assert.isAtMost(level.level, 127);
  assert.isAtLeast(level.level, 9);
  assert.isAtMost(level.level, 15);
  assert.equal(level.voiceActivity, true);
});

test("summarizeToneLevel は無音と空のサンプル列をデジタル無音として扱う", () => {
  const empty = summarizeToneLevel(new Float32Array(0));
  assert.equal(empty.level, AUDIO_LEVEL_SILENCE);
  assert.equal(empty.voiceActivity, false);

  const silence = summarizeToneLevel(new Float32Array(480));
  assert.equal(silence.level, AUDIO_LEVEL_SILENCE);
  assert.equal(silence.voiceActivity, false);
});

test("summarizeToneLevel は小さい振幅を voice activity なしとする", () => {
  // ピークのしきい値 (0.05) を下回る信号は無音扱いにせず、level だけを返す
  const quiet = new Float32Array(480).fill(0.01);
  const level = summarizeToneLevel(quiet);

  assert.equal(level.voiceActivity, false);
  assert.equal(level.level, 40);
});

// RFC 6464 §3 の level は 0〜127 に収まる。0 dBov を超える信号は 0 にクランプし、
// 測定不能な入力 (NaN) で NaN を wire に載せない。
test("summarizeToneLevel は 0 dBov を超える信号を 0 にクランプする", () => {
  const loud = new Float32Array(480).fill(2);
  assert.equal(summarizeToneLevel(loud).level, 0);
});

test("summarizeToneLevel は NaN を含むサンプル列を無音として扱う", () => {
  const broken = new Float32Array([Number.NaN, 0.5, 0.5]);
  const level = summarizeToneLevel(broken);
  assert.equal(level.level, AUDIO_LEVEL_SILENCE);
  assert.equal(level.voiceActivity, false);
});
