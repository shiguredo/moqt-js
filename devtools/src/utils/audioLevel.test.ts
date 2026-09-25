import { test, assert } from "vite-plus/test";
import {
  INACTIVE_TEXT,
  MIN_DBFS,
  appendWaveform,
  formatAudioLevel,
  formatDbfs,
  formatVoiceActivity,
  summarizeAudioLevel,
  waveformSampleCount,
} from "./audioLevel";

// readAudioSamples は AudioData (ブラウザ専用 API) を受けるため Node では検証できない。
// 実ブラウザでの検証は codec-test ページ (tests/e2e/codec-wrappers.spec.ts) が行う。

// dBFS の期待値は 20 * log10(振幅) で求まる。丸めの揺れを許容して比較する
function closeTo(actual: number, expected: number, delta = 0.05): void {
  assert.isAtLeast(actual, expected - delta);
  assert.isAtMost(actual, expected + delta);
}

test("summarizeAudioLevel: 無音は下限に丸める", () => {
  const silent = summarizeAudioLevel(new Float32Array(480));
  assert.equal(silent.peakDbfs, MIN_DBFS);
  assert.equal(silent.rmsDbfs, MIN_DBFS);
});

test("summarizeAudioLevel: 空のサンプル列は下限に丸める", () => {
  const empty = summarizeAudioLevel(new Float32Array(0));
  assert.equal(empty.peakDbfs, MIN_DBFS);
  assert.equal(empty.rmsDbfs, MIN_DBFS);
});

test("summarizeAudioLevel: 最大振幅は 0 dBFS になる", () => {
  // 振幅 1.0 が 0 dBFS (最大)。1 を超える値も 0 にクランプする
  const full = new Float32Array([1, -1, 1, -1]);
  const level = summarizeAudioLevel(full);
  assert.equal(level.peakDbfs, 0);
  assert.equal(level.rmsDbfs, 0);

  const over = summarizeAudioLevel(new Float32Array([2, -2]));
  assert.equal(over.peakDbfs, 0);
});

test("summarizeAudioLevel: 振幅 0.5 は約 -6 dBFS になる", () => {
  // 1 秒分 (440 Hz が整数周期) にして RMS が振幅の 1/sqrt(2) に一致するようにする
  const samples = new Float32Array(48000);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000);
  }
  const level = summarizeAudioLevel(samples);

  closeTo(level.peakDbfs, -6.02);
  // 正弦波の RMS は振幅の 1/sqrt(2) = 0.3536 → -9.03 dBFS
  closeTo(level.rmsDbfs, -9.03);
});

test("summarizeAudioLevel: NaN や Infinity を有限の値に丸める", () => {
  const broken = new Float32Array([Number.NaN, Number.POSITIVE_INFINITY, 0.5]);
  const level = summarizeAudioLevel(broken);

  // NaN / 負の無限大は無音 (下限)、正の無限大は 0 dBFS に丸める
  assert.isTrue(Number.isFinite(level.peakDbfs));
  assert.isTrue(Number.isFinite(level.rmsDbfs));
  assert.equal(level.peakDbfs, 0);

  const onlyNaN = summarizeAudioLevel(new Float32Array([Number.NaN]));
  assert.equal(onlyNaN.peakDbfs, MIN_DBFS);
  assert.equal(onlyNaN.rmsDbfs, MIN_DBFS);
});

test("waveformSampleCount: 100 ms 分のサンプル数を返す", () => {
  assert.equal(waveformSampleCount(48000), 4800);
  assert.equal(waveformSampleCount(8000), 800);
  // 極端な値でも 0 にしない (描画側で 0 除算を起こさない)
  assert.equal(waveformSampleCount(0), 1);
});

test("appendWaveform: 上限まで追加する", () => {
  const first = appendWaveform(null, new Float32Array([1, 2]), 4);
  assert.deepEqual(Array.from(first), [1, 2]);

  const second = appendWaveform(first, new Float32Array([3, 4]), 4);
  assert.deepEqual(Array.from(second), [1, 2, 3, 4]);
});

test("appendWaveform: 上限を超えたら古いサンプルから捨てる", () => {
  const previous = new Float32Array([1, 2, 3, 4]);
  const merged = appendWaveform(previous, new Float32Array([5, 6]), 4);

  assert.deepEqual(Array.from(merged), [3, 4, 5, 6]);
});

test("appendWaveform: 今回のサンプルだけで上限を超える場合は直近だけを残す", () => {
  const merged = appendWaveform(new Float32Array([1, 2]), new Float32Array([3, 4, 5, 6, 7]), 3);

  assert.deepEqual(Array.from(merged), [5, 6, 7]);
});

test("appendWaveform: 上限が 0 以下なら空を返す", () => {
  assert.equal(appendWaveform(null, new Float32Array([1]), 0).length, 0);
  assert.equal(appendWaveform(null, new Float32Array([1]), -1).length, 0);
});

// level と voice activity は別の要素に出す (同じ値を 2 度表示しない)
test("formatAudioLevel: 未報告と値を区別する", () => {
  assert.equal(formatAudioLevel(null), "not reported");
  assert.equal(formatAudioLevel({ level: 42, voiceActivity: true }), " -42 dBov");
  assert.equal(formatAudioLevel({ level: 42, voiceActivity: false }), " -42 dBov");
  // 0 は最大音量 (0 dBov)。"-0" にしない。桁は -127 に揃える
  assert.equal(formatAudioLevel({ level: 0, voiceActivity: false }), "   0 dBov");
  // 127 はデジタル無音 (-127 dBov)
  assert.equal(formatAudioLevel({ level: 127, voiceActivity: false }), "-127 dBov");
});

// voice の値はラベル ("voice") を別に出すため、値だけを返す。
// on は末尾空白で off と同じ 3 文字にする
test("formatVoiceActivity: 値だけを返し、Audio Level が無いときは「-」にする", () => {
  assert.equal(formatVoiceActivity({ level: 0, voiceActivity: true }), "on ");
  assert.equal(formatVoiceActivity({ level: 0, voiceActivity: false }), "off");
  // Audio Level が載っていない object には V ビットも無い。同じ「未報告」を
  // LOC Audio Level の欄と 2 度出さないため、ここは「-」にする
  assert.equal(formatVoiceActivity(null), INACTIVE_TEXT);
});

// 見出し行は小数点の位置を固定する。桁が減っても単位が左へ寄らない
test("formatDbfs: 値が無いときは「-」にし、小数点の位置は桁で変わらない", () => {
  assert.equal(formatDbfs(null), INACTIVE_TEXT);
  assert.equal(formatDbfs(0), "   0.0 dBFS");
  assert.equal(formatDbfs(-6.02), "  -6.0 dBFS");
  assert.equal(formatDbfs(-53.6), " -53.6 dBFS");
  assert.equal(formatDbfs(MIN_DBFS), "-100.0 dBFS");
  const samples = [formatDbfs(0), formatDbfs(-6.02), formatDbfs(-53.6), formatDbfs(MIN_DBFS)];
  const dotIndex = samples[0]?.indexOf(".") ?? -1;
  for (const text of samples) {
    assert.equal(text.length, "-100.0 dBFS".length);
    assert.equal(text.indexOf("."), dotIndex);
    assert.equal(text.endsWith(" dBFS"), true);
  }
});
