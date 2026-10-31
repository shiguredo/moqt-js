/** 局所的な時間合わせが、既知の遅延、自然な無音、欠落を混同しないことを確かめる。 */
import { test, assert } from "vite-plus/test";
import { compareOutputPcm, readFloat32Pcm } from "./playout-output-comparison.mjs";

function speechLike(rate, seconds = 1.4) {
  // 周期波だけでは遅延を一意に決められない。周波数と振幅が時間で変わる信号を使う。
  return Float32Array.from({ length: Math.round(rate * seconds) }, (_, index) => {
    const time = index / rate;
    if (time < 0.2 || time > 1.05 || (time > 0.5 && time < 0.58)) return 0;
    return (
      0.15 *
      (0.6 + 0.4 * Math.sin(time * 37)) *
      (Math.sin(2 * Math.PI * (153 * time + 360 * time ** 2)) +
        0.3 * Math.sin(2 * Math.PI * (431 * time + 173 * time ** 3)))
    );
  });
}

function shifted(reference, samples, gain = 1) {
  const result = new Float32Array(reference.length);
  for (let index = 0; index < reference.length; index++) {
    const source = index - samples;
    if (source >= 0 && source < reference.length) result[index] = reference[source] * gain;
  }
  return result;
}

test("44.1 / 48 kHz の既知の遅延と音量比を、自然な無音から分離する", () => {
  for (const sampleRate of [44100, 48000]) {
    const reference = speechLike(sampleRate);
    const delay = Math.round(sampleRate * 0.073);
    const result = compareOutputPcm({
      reference,
      output: shifted(reference, delay, 0.4),
      sampleRate,
      maximumDelayMs: 120,
    });
    assert.isAbove(result.acceptedWindows, 5, "一意に整合できる区間があること");
    assert.closeTo(result.delayMs.p50, (delay / sampleRate) * 1000, 1000 / sampleRate);
    assert.closeTo(result.gain.p50, 0.4, 1e-5);
    for (const window of result.windows.filter((entry) => entry.accepted))
      assert.closeTo(window.delaySamples, delay, 1, "採用した各窓の遅延も既知の値と一致すること");
    assert.equal(result.activeZeroMs, 0, "原音にもある無音を欠落に数えないこと");
    assert.isAbove(result.correlation.p50, 0.9999);
  }
});

test("途中で遅延が変わっても、全体に 1 個の遅延を当てはめない", () => {
  const sampleRate = 8000;
  const reference = speechLike(sampleRate);
  const output = shifted(reference, 160);
  output.set(shifted(reference, 480).subarray(5600), 5600);
  const result = compareOutputPcm({ reference, output, sampleRate, maximumDelayMs: 100 });
  assert.closeTo(result.delayMs.p10, 20, 0.2);
  assert.closeTo(result.delayMs.p90, 60, 0.2);
});

test("原音が活動している場所の完全無音を検出し、整合できない区間も件数に残す", () => {
  const sampleRate = 8000;
  const reference = speechLike(sampleRate);
  const output = shifted(reference, 400);
  output.fill(0, 6000, 6160);
  const result = compareOutputPcm({ reference, output, sampleRate, maximumDelayMs: 100 });
  assert.closeTo(result.activeZeroMs, 20, 0.5);
  assert.isAbove(result.windows.length, result.acceptedWindows);
  assert.equal(result.rejectedWindows, result.activeWindows - result.acceptedWindows);
  // 窓全体が欠けた場合も、その窓を集計の分母から消して高相関に見せない。
  output.fill(0, 4800, 9200);
  const longer = compareOutputPcm({ reference, output, sampleRate, maximumDelayMs: 100 });
  assert.equal(longer.activeWindows, result.activeWindows);
  assert.isTrue(longer.windows.some((window) => !window.accepted && window.correlation < 0.1));
});

test("余裕を持って予約した復号参照より早い出力の負の遅延も測れる", () => {
  const sampleRate = 8000;
  const reference = speechLike(sampleRate);
  const result = compareOutputPcm({
    reference,
    output: shifted(reference, -360),
    sampleRate,
    minimumDelayMs: -100,
    maximumDelayMs: 20,
  });
  assert.closeTo(result.delayMs.p50, -45, 0.2);
  for (const window of result.windows.filter((entry) => entry.accepted))
    assert.closeTo(window.delaySamples, -360, 1);
});

test("無音と単一周期波を、一意に測れた音声の遅延として採用しない", () => {
  const sampleRate = 8000;
  const silence = new Float32Array(8000);
  assert.equal(
    compareOutputPcm({ reference: silence, output: silence, sampleRate }).acceptedWindows,
    0,
  );
  const tone = Float32Array.from({ length: 8000 }, (_, index) => Math.sin((index * Math.PI) / 20));
  const result = compareOutputPcm({ reference: tone, output: tone, sampleRate });
  assert.equal(result.acceptedWindows, 0, "複数の周期で同じ相関になる遅延を確定しないこと");
});

test("収録長の不一致と非有限値を、良い比較結果として返さない", () => {
  const reference = speechLike(8000);
  for (const output of [reference.slice(1), reference.map(() => Number.NaN)])
    assert.throws(() => compareOutputPcm({ reference, output, sampleRate: 8000 }));
  assert.throws(() => compareOutputPcm({ reference, output: reference, sampleRate: Number.NaN }));
});

test("保存した Float32 の長さ、エンディアンと非有限値を検査する", () => {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setFloat32(0, 0.125, true);
  view.setFloat32(4, -0.25, true);
  assert.deepEqual(Array.from(readFloat32Pcm(bytes, 2)), [0.125, -0.25]);
  assert.throws(() => readFloat32Pcm(bytes.subarray(1), 2));
  assert.throws(() => readFloat32Pcm(bytes, 3));
  view.setFloat32(4, Number.POSITIVE_INFINITY, true);
  assert.throws(() => readFloat32Pcm(bytes, 2));
});
