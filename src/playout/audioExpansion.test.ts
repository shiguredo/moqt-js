/** 未着時の補間を先に用意し、有声音だけでなく非周期音でも有限の続き音を作る。 */
import { test, assert } from "vite-plus/test";
import { AUDIO_EXPANSION_SECONDS, expandAudio, generateUnvoiced } from "./audioExpansion";
import { AUDIO_PLAYOUT_CONCEAL_END_GAIN } from "./audioPlayout";
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

test("周期補間の末尾の振幅は、予約側と同じ定数 (AUDIO_PLAYOUT_CONCEAL_END_GAIN) まで下げる", () => {
  // 200 Hz (周期 5 ms) の 30 ms の履歴。末尾の周期の相関が高く、周期補間の経路を通る
  const sampleRate = 48000;
  const history = Float32Array.from(
    { length: Math.round(sampleRate * 0.03) },
    (_, index) => Math.sin((index * 2 * Math.PI * 200) / sampleRate) * 0.2,
  );
  const expanded = expandAudio([history], sampleRate)[0];
  // 末尾の振幅の規則は予約側の定数 1 つで決める。出力側で別の値を持つと、補間した音の
  // 減衰が経路ごとに食い違い、計器の `concealedMs` と聞こえ方の対応が取れなくなる
  const expected = concealSamples(
    [history],
    sampleRate,
    AUDIO_EXPANSION_SECONDS,
    AUDIO_PLAYOUT_CONCEAL_END_GAIN,
  ).channels[0];
  assert.isDefined(expanded);
  assert.isDefined(expected);
  if (expanded === undefined || expected === undefined) return;
  assert.deepEqual(expanded, expected, "周期補間は共有の末尾振幅で生成すること");
  // 先頭の 1 周期に対する末尾の 1 周期のピークの比が、末尾振幅の定数に近いこと
  // (振幅は 1 から定数まで直線で下がるため、端の 1 周期分だけ定数からずれる)
  const periodFrames = Math.round(sampleRate / 200);
  const peakOf = (samples: Float32Array): number =>
    Math.max(...samples.map((value) => Math.abs(value)));
  const ratio =
    peakOf(expanded.subarray(-periodFrames)) / peakOf(expanded.subarray(0, periodFrames));
  assert.closeTo(ratio, AUDIO_PLAYOUT_CONCEAL_END_GAIN, 0.06, "末尾の振幅が定数まで下がること");
});

test("予測器は 1 次の減衰の解析解と一致し、呼び出しごとに新しい配列を返す", () => {
  // 係数が 1 つ (0.5) だけで励振が 0 なら、出力は直前の値を 0.5 倍し続ける等比数列になる
  const coefficients = new Float64Array(12);
  coefficients[0] = 0.5;
  const options = { state: 731, innovation: 0, limit: 1, polarity: 1 };
  const output = generateUnvoiced(coefficients, [0.25], 64, options);
  const expected = Float32Array.from({ length: 64 }, (_, index) => 0.25 * 0.5 ** (index + 1));
  assert.deepEqual(output, expected, "単一係数の減衰を解析解で確かめること");
  const second = generateUnvoiced(coefficients, [0.5], 64, options);
  assert.deepEqual(
    second,
    expected.map((value) => value * 2),
  );
  assert.deepEqual(output, expected, "前の結果を次の呼び出しで上書きしないこと");
});

test("予測器は実音のピークで打ち切り、係数の数と生成数の誤りを拒否する", () => {
  const coefficients = new Float64Array(12);
  const options = { state: 731, innovation: 0.1, limit: 0.3, polarity: 1 };
  const output = generateUnvoiced(coefficients, new Float32Array(16), 128, options);
  assert.isTrue(output.every((value) => Number.isFinite(value) && Math.abs(value) <= 0.3));
  assert.isTrue(
    output.some((value) => value !== 0),
    "励振があるのに無音を返さないこと",
  );
  // 逆相チャンネルは励振の極性だけが反転し、同じ種から同じ大きさの音になる
  const opposite = generateUnvoiced(coefficients, new Float32Array(16), 128, {
    ...options,
    polarity: -1,
  });
  for (let index = 0; index < output.length; index++)
    assert.closeTo(output[index] ?? 0, -(opposite[index] ?? 0), 1e-9);
  assert.throws(() => generateUnvoiced(coefficients.subarray(1), [], 128, options));
  assert.throws(() => generateUnvoiced(coefficients, [], -1, options));
  assert.throws(() => generateUnvoiced(coefficients, [], 1.5, options));
  assert.equal(generateUnvoiced(coefficients, [], 0, options).length, 0);
});
