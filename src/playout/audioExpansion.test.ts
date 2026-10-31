/** 未着時の補間を先に用意し、有声音だけでなく非周期音でも有限の続き音を作る。 */
import { test, assert } from "vite-plus/test";
import { expandAudio } from "./audioExpansion";
import { concealSamples } from "./audioTimeStretch";

function noise(length: number): Float32Array<ArrayBuffer> {
  let state = 731;
  let previous = 0;
  return Float32Array.from({ length }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    previous = previous * 0.6 + (state / 0xffffffff - 0.5) * 0.1;
    return previous;
  });
}
const rms = (samples: Float32Array): number =>
  Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);

test("80 Hz の低い有声音を、連続する 30 ms の履歴から補間する", () => {
  for (const sampleRate of [44100, 48000]) {
    const history = Float32Array.from(
      { length: Math.round(sampleRate * 0.03) },
      (_, index) => Math.sin((index * 2 * Math.PI * 80) / sampleRate) * 0.2,
    );
    const result = expandAudio([history], sampleRate);
    assert.equal(result[0]?.length, Math.round(sampleRate * 0.1));
    assert.isAbove(rms(result[0] ?? new Float32Array(0)), 0.04);
    assert.isBelow(
      Math.abs((result[0]?.[0] ?? 0) - (history.at(-1) ?? 0)),
      0.01,
      "補間の先頭が急に跳ばないこと",
    );
  }
});

test("周期を推定できない音でも、元のスペクトルと振幅を使う非周期の補間を生成する", () => {
  const input = noise(1440);
  assert.equal(
    concealSamples([input], 48000, 0.1).generatedSamples,
    0,
    "周期反復では補間できない入力を使うこと",
  );
  const result = expandAudio([input], 48000)[0];
  assert.isDefined(result);
  if (result === undefined) return;
  assert.equal(result.length, 4800);
  assert.isTrue(result.every((value) => Number.isFinite(value)));
  assert.isAbove(rms(result), rms(input) * 0.2);
  assert.isBelow(rms(result), rms(input) * 1.2);
  assert.isAtMost(
    Math.max(...result.map((value) => Math.abs(value))),
    Math.max(...input.map((value) => Math.abs(value))) + 1e-6,
    "予測音で過去のピークを超えないこと",
  );
  // 最後の 20 ms で元の 20 ms を周期的に繰り返していないことを確かめる。
  let product = 0;
  let energy = 0;
  for (let index = 960; index < result.length; index++) {
    product += (result[index] ?? 0) * (result[index - 960] ?? 0);
    energy += (result[index] ?? 0) ** 2;
  }
  assert.isBelow(Math.abs(product / energy), 0.2);
});

test("同一と逆相のチャンネルを、異なる雑音へばらさない", () => {
  const input = noise(1440);
  const result = expandAudio([input, input.slice(), input.map((value) => -value)], 48000);
  assert.deepEqual(result[0], result[1]);
  const left = result[0];
  const opposite = result[2];
  assert.isDefined(left);
  assert.isDefined(opposite);
  if (left === undefined || opposite === undefined) return;
  for (let index = 0; index < left.length; index++)
    assert.closeTo(left[index] ?? 0, -(opposite[index] ?? 0), 1e-6);
});

test("過去が大きな音でも、静かになった末尾の音量を再び持ち上げない", () => {
  const older = noise(480).map((value) => value * 5);
  const current = noise(960).map((value) => value * 0.1);
  const history = new Float32Array(1440);
  history.set(older);
  history.set(current, 480);
  const output = expandAudio([current], 48000, [history])[0];
  assert.isDefined(output);
  if (output === undefined) return;
  assert.isBelow(rms(output), rms(current) * 1.1, "過去の強い発声を補間へ戻さないこと");
  assert.isAtMost(
    Math.max(...output.map((value) => Math.abs(value))),
    Math.max(...current.map((value) => Math.abs(value))) + 1e-6,
  );
});

test("無音から勝手に音を作らず、壊れた入力を拒否する", () => {
  const silent = expandAudio([new Float32Array(1440)], 48000)[0];
  assert.isTrue(silent?.every((value) => value === 0));
  assert.deepEqual(expandAudio([], 48000), []);
  assert.throws(() => expandAudio([noise(1440).map(() => Number.NaN)], 48000));
});

test("補間に未対応の有効なレートは、実音を再生できるよう補間だけを省く", () => {
  for (const sampleRate of [3000, 192000])
    assert.deepEqual(expandAudio([noise(960)], sampleRate), []);
});
