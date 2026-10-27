/**
 * 時間圧縮 (`compressSamples`) と欠落した区間の補間 (`concealSamples`) の単体テスト
 *
 * 波形が周期的な音ではピッチ周期 1 つ分だけ長さが変わり、切れ目の前後がクロスフェードで
 * 繋がること、波形が繰り返していない音 (相関が足りない音) では操作しないこと、
 * 無音では操作することを固定する。ピッチ周期は 4 kHz の格子に乗る音では整数周期のまま
 * 使い、格子に乗らない音ではピークの前後 1 格子の相関を放物線補間して端数まで求める
 * (時間圧縮と補間で対称)。補間は末尾の周期を端数まで求めて繰り返すため、4 kHz の
 * 格子に乗らない周期でも穴の終わりで位相がずれない。末尾で位相が飛ぶ音や、継ぎ目の段差が
 * 大きい音 (どのチャンネルでも) では操作せず、周期の推定が確かでない音では生成した音の
 * 末尾を短くフェードする。実際の使い方 (遅れて届いた音を目標へ戻す) は audioPlayout.test.ts
 * が、隙間の補間の予約は createMediaSubscriber.test.ts が固定する。
 */

import { test, assert } from "vite-plus/test";
import {
  compressSamples,
  concealSamples,
  TIME_STRETCH_CONCEAL_FADE_MS,
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

/** 周波数 `frequencyHz` の純音 (20 ms、48 kHz) */
function frequencyFrame(frequencyHz: number, amplitude = 0.5, phase = 0): AudioSamples {
  const samples = new Float32Array(FRAME_SAMPLES);
  for (let index = 0; index < FRAME_SAMPLES; index++) {
    samples[index] =
      amplitude * Math.sin((2 * Math.PI * frequencyHz * index) / SAMPLE_RATE + phase);
  }
  return samples;
}

/**
 * サンプルレート `sampleRate`、長さ `length` サンプルの有声 (倍音を 1 / 次数で重ねた周期波)
 *
 * 実際の声に近づけるため、整数次の倍音を 4 kHz (音声の帯域) まで重ねる。振幅は 0.5 に揃える。
 * 44.1 kHz では 20 ms のフレームが 882 サンプルになり、48 kHz の `FRAME_SAMPLES` と長さが
 * 違うため、レートと長さを指定できるようにしている
 */
function voicedSamples(frequencyHz: number, sampleRate: number, length: number): AudioSamples {
  const samples = new Float32Array(length);
  const maxHarmonicHz = 4_000;
  let norm = 0;
  for (let harmonic = 1; harmonic * frequencyHz < maxHarmonicHz; harmonic++) {
    norm += 1 / harmonic;
  }
  for (let index = 0; index < length; index++) {
    let value = 0;
    for (let harmonic = 1; harmonic * frequencyHz < maxHarmonicHz; harmonic++) {
      value +=
        (1 / harmonic) * Math.sin((2 * Math.PI * harmonic * frequencyHz * index) / sampleRate);
    }
    samples[index] = (0.5 * value) / norm;
  }
  return samples;
}

/** 基本周波数 `frequencyHz` の有声 (倍音を 1 / 次数で重ねた周期波) のフレーム (48 kHz) */
function voicedFrame(frequencyHz: number): AudioSamples {
  return voicedSamples(frequencyHz, SAMPLE_RATE, FRAME_SAMPLES);
}

/**
 * 1 極フィルタ (係数 `coefficient`) を通した有色雑音のフレーム
 *
 * 白色雑音を `y[n] = a * y[n-1] + (1 - a) * x[n]` でならしたもの。相関は `a` のラグ乗で
 * 減るため、周期の探索が短いラグを選ぶと 400 Hz のブザーになる
 */
function coloredNoiseFrame(coefficient: number, seed: number): AudioSamples {
  const samples = new Float32Array(FRAME_SAMPLES);
  let state = seed;
  let previous = 0;
  for (let index = 0; index < FRAME_SAMPLES; index++) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    const white = (state / 2_147_483_648) * 2 - 1;
    previous = coefficient * previous + (1 - coefficient) * white;
    samples[index] = previous;
  }
  return samples;
}

/** 純音に白色雑音を混ぜたフレーム (周期の推定が確かでない音を作る) */
function noisySineFrame(frequencyHz: number, noiseAmplitude: number): AudioSamples {
  const samples = frequencyFrame(frequencyHz);
  let state = 987_654_321;
  for (let index = 0; index < FRAME_SAMPLES; index++) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    samples[index] = (samples[index] ?? 0) + ((state / 2_147_483_648) * 2 - 1) * noiseAmplitude;
  }
  return samples;
}

/**
 * 生成した音が `period` サンプルで繰り返しているか (端数の周期でも比べられる)
 *
 * 1 周期分を比べる。数サンプルだけを比べると、波形が滑らかな場所では周期がずれていても
 * 差が小さく出るためである
 */
function repeatsAtPeriod(generated: AudioSamples, period: number, tolerance: number): boolean {
  const count = Math.min(Math.round(period), generated.length - period);
  for (let index = 0; index < count; index++) {
    if (Math.abs((generated[index + period] ?? 0) - (generated[index] ?? 0)) > tolerance) {
      return false;
    }
  }
  return true;
}

/**
 * 穴の終わりの段差を、振幅で正規化して返す
 *
 * 穴の終わりでは、次に鳴る音が本来の続き (穴の分だけ進んだ音) であるとして、生成した音の
 * 最後のサンプルとの差を測る。段差が大きいとクリックとして聞こえる
 */
function endStepRatio(frequencyHz: number, gapSeconds: number, amplitude = 0.5): number {
  const frame = frequencyFrame(frequencyHz, amplitude);
  const target = Math.round(gapSeconds * SAMPLE_RATE);
  const result = concealSamples([frame], SAMPLE_RATE, gapSeconds);
  const generated = result.channels[0] ?? new Float32Array(0);
  const last = generated[generated.length - 1] ?? 0;
  const next =
    amplitude * Math.sin((2 * Math.PI * frequencyHz * (FRAME_SAMPLES + target)) / SAMPLE_RATE);
  return Math.abs(last - next) / amplitude;
}

// 削ってよい長さの上限より周期が長いときは操作しない。時間圧縮は周期を 1 つ削るため、
// 遅れ (上限) が周期より短い音で動かすと削りすぎて「早すぎる」側へ振れ、次の音でまた
// 遅れて詰める往復になる (実測: 55 秒の再生で 2727 ms を詰めていた。声では粗さとして
// 聞こえる)。実際の呼び出しは src/playout/audioPlayoutSession.ts が遅れの分を上限に渡す
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
 * 4 kHz の格子に乗る F0 では、ピッチの周期が元のサンプルレートで整数になる。このときは
 * 端数補間を掛けず、従来どおり真の周期ちょうどで削る (格子に乗る周期を放物線の頂点へ
 * ずらすと、有限窓の前後の相関の非対称で正しい整数周期の位相を壊すためである)。
 *
 * 実測 (48 kHz、20 ms のフレーム): 160 Hz は 300 サンプル (4 kHz のラグ 25)、200 Hz は
 * 240 サンプル (ラグ 20)。純音の位相を 0 から 2π まで変えても削る長さは変わらない
 */
test("compressSamples: 格子に乗る F0 は真の周期ちょうどで削る", () => {
  for (const [frequencyHz, period] of [
    [160, 300],
    [200, 240],
  ] as const) {
    const result = compressSamples([voicedFrame(frequencyHz)], SAMPLE_RATE);
    assert.equal(
      result.lengthChangeSamples,
      -period,
      `${frequencyHz} Hz の有声を真の周期 ${period} サンプルで削ること`,
    );
    // 完全相関のときは整数ラグを維持するため、波形の位相が変わっても周期は動かない
    for (const phase of [0, Math.PI / 3, (2 * Math.PI) / 3]) {
      const shifted = compressSamples([frequencyFrame(frequencyHz, 0.5, phase)], SAMPLE_RATE);
      assert.equal(
        shifted.lengthChangeSamples,
        -period,
        `${frequencyHz} Hz の位相 ${phase.toFixed(3)} でも真の周期 ${period} で削ること`,
      );
    }
  }
});

/**
 * 4 kHz の格子に乗らない F0 では、周期が 48 kHz で 12 サンプル単位に丸められていた。
 * ピークの前後 1 格子の相関を放物線補間して端数まで求めることで、削る長さが真の周期へ
 * 近づく。
 *
 * 実測 (48 kHz、20 ms のフレーム、有声): 180 Hz は修正前 264 サンプル (真 266.667、
 * 誤差 -2.667) だったが修正後 267 (誤差 +0.333)、220 Hz は 216 (真 218.182、-2.182) が
 * 218 (-0.182)、260 Hz は 180 (真 184.615、-4.615) が 185 (+0.385) になる
 */
test("compressSamples: 格子に乗らない F0 も真の周期の ±1 サンプルで削る", () => {
  for (const frequencyHz of [180, 220, 260]) {
    const truePeriod = SAMPLE_RATE / frequencyHz;
    const result = compressSamples([voicedFrame(frequencyHz)], SAMPLE_RATE);
    const removed = -result.lengthChangeSamples;
    assert.isBelow(result.lengthChangeSamples, 0, `${frequencyHz} Hz を圧縮すること`);
    assert.isAtMost(
      Math.abs(removed - truePeriod),
      1,
      `${frequencyHz} Hz の削る長さ ${removed} が真の周期 ${truePeriod.toFixed(3)} の ±1 サンプルに入ること`,
    );
    // 格子の丸め (12 サンプル単位) のままなら、端数補間が効いていない
    assert.notEqual(
      removed % 12,
      0,
      `${frequencyHz} Hz が 4 kHz の格子の周期のまま削られていないこと`,
    );
    // 端数補間は真の周期に近づく向きに働く (格子へ丸めた周期より誤差が小さい)
    const gridRounded = Math.round(truePeriod / 12) * 12;
    assert.isBelow(
      Math.abs(removed - truePeriod),
      Math.abs(gridRounded - truePeriod),
      `${frequencyHz} Hz が格子へ丸めた周期 ${gridRounded} より真の周期に近いこと`,
    );
  }
});

/**
 * 44.1 kHz は解析用の信号だけを 48 kHz へ換算し、求めたラグに 11.025 を掛けて元のサンプル
 * レートへ戻す。300 Hz の真の周期は 147 サンプルで、4 kHz の格子では 13.333 ラグになる
 * (格子のラグ 13 = 143.325 サンプルのままでは 3.7 サンプルずれる)。
 *
 * 20 ms (882 サンプル) のフレームでは 2 周期の相関ピーク (26.67 ラグ) も探索範囲に入り、
 * 300 Hz は既存の高 F0 と同じく 2 周期を削る場合がある。300 Hz の 1 周期の端数推定を
 * 確かめるため、2 周期が探索範囲に入らない 800 サンプル (18.1 ms) のフレームを使う。
 *
 * 実測 (44.1 kHz、800 サンプル、有声): 300 Hz は 147 サンプルちょうど。200 Hz は 4 kHz の
 * 格子に乗るため、真の周期 220.5 サンプルを丸めた 221 サンプルになる
 */
test("compressSamples: 44.1 kHz の 4 kHz 格子に乗らない周期も ±1 サンプルで削る", () => {
  const result = compressSamples([voicedSamples(300, 44_100, 800)], 44_100, 400);
  const removed = -result.lengthChangeSamples;
  assert.isBelow(result.lengthChangeSamples, 0, "300 Hz を圧縮すること");
  assert.isAtMost(
    Math.abs(removed - 147),
    1,
    `削る長さ ${removed} が真の周期 147 の ±1 サンプルに入ること`,
  );
  // 4 kHz の格子のラグ 13 のままなら 143 サンプル (誤差 -4) になる
  assert.notEqual(removed, 143, "格子へ丸めた 143 サンプルのまま削られていないこと");
  // 4 kHz の格子に乗る 200 Hz は、元のサンプルレートの端数 (220.5) を丸めた 221 になる
  const gridResult = compressSamples([voicedSamples(200, 44_100, 882)], 44_100, 441);
  assert.equal(
    -gridResult.lengthChangeSamples,
    221,
    "200 Hz は真の周期 220.5 サンプルを丸めた 221 サンプルで削ること",
  );
});

/**
 * 端数補間を足しても、既存の拒否条件は変わらない。周期が削ってよい長さの上限を超えるときは
 * 操作せず、切れ目の前後の相関が足りない音でも操作しない (無音の扱いと短すぎる音の扱いは
 * 上のテストが担う)。
 *
 * 実測 (48 kHz、20 ms のフレーム、180 Hz の有声 = 周期 267 サンプル): 上限なしで 267 サンプル
 * 削れ、上限を 266 にすると操作せず、267 にすると 267 サンプル削る。後半の位相を反転して
 * 相関を壊した音は相関が 0.9 未満になり操作しない
 */
test("compressSamples: 格子に乗らない音でも既存の拒否条件は変わらない", () => {
  const frame = voicedFrame(180);
  // 上限の判定は `samples > maxLengthChangeSamples` である。削る長さを決め打ちせず、上限
  // なしで求めた長さの前後で確かめる (周期の推定値が変わっても境界の意味は変わらない)
  const removed = -compressSamples([frame], SAMPLE_RATE).lengthChangeSamples;
  assert.isAbove(removed, 0, "上限なしでは削ること");
  assert.equal(
    compressSamples([frame], SAMPLE_RATE, removed - 1).lengthChangeSamples,
    0,
    "上限が周期より 1 サンプル短いときは削らないこと",
  );
  assert.equal(
    compressSamples([frame], SAMPLE_RATE, removed).lengthChangeSamples,
    -removed,
    "上限が周期ちょうどのときは削ること",
  );
  // 後半の位相を反転すると、切れ目の前後で波形が一致しない (相関が足りない)
  const inverted = Float32Array.from(frame);
  for (let index = FRAME_SAMPLES / 2; index < FRAME_SAMPLES; index++) {
    inverted[index] = -(inverted[index] ?? 0);
  }
  assert.equal(
    compressSamples([inverted], SAMPLE_RATE).lengthChangeSamples,
    0,
    "相関が足りない音は操作しないこと",
  );
});

/**
 * 補間の周期を端数まで求めるため、4 kHz の格子 (48 kHz で 12 サンプル) に乗らない純音でも
 * 穴の終わりで位相がずれない。
 *
 * 実測 (48 kHz、20 ms のフレーム、振幅 0.5、440 Hz。穴の終わりの段差 / 振幅): 格子の周期
 * 108 サンプルで繰り返していたときは 20 ms で 34.4 %、40 ms で 101.8 %、100 ms で 195.1 %
 * だった。端数周期 (109.09 サンプル) にすると 4.7 % / 4.5 % / 1.6 % になる。4 kHz の格子に
 * 乗る 200 Hz (周期 240 サンプル) は 2.6 % のままである
 */
test("concealSamples: 格子に乗らない純音でも穴の終わりで段差が出ない", () => {
  for (const gapSeconds of [0.02, 0.04, 0.1]) {
    assert.isAtMost(
      endStepRatio(440, gapSeconds),
      0.1,
      `440 Hz の段差が振幅の 10 % 以下であること (穴 ${gapSeconds} 秒)`,
    );
  }
  assert.isAtMost(
    endStepRatio(200, 0.1),
    0.1,
    "格子に乗る 200 Hz の段差が振幅の 10 % 以下であること",
  );
});

/**
 * 探索の下限 (400 Hz) ちょうどの周期でも、穴の終わりで段差が出ない。
 *
 * 端数の周期は、細探索した 3 点 (前後と最大) から放物線の頂点として求める。ところが最大が
 * 細探索の端にあるときは両隣の相関が無い。それでも外挿すると、評価していないラグ (探索の
 * 下限の外側) を返し、周期が 0.5 サンプルずれる。実測 (48 kHz、20 ms のフレーム、振幅 0.5、
 * 400 Hz = 周期 120 サンプル。穴の終わりの段差 / 振幅): 外挿していたときは穴 100 ms で
 * 85.2 % だった。端では頂点を求めないようにして 5.2 % になる
 */
test("concealSamples: 探索の下限ちょうどの周期でも穴の終わりで段差が出ない", () => {
  for (const gapSeconds of [0.02, 0.04, 0.1]) {
    assert.isAtMost(
      endStepRatio(400, gapSeconds),
      0.1,
      `400 Hz の段差が振幅の 10 % 以下であること (穴 ${gapSeconds} 秒)`,
    );
  }
});

// 探索の範囲を 100 Hz まで広げたため、格子に乗らない純音も補間する (以前は 300 / 220 /
// 150 / 100 Hz は補間しなかった)
test("concealSamples: 格子に乗らない純音も補間する", () => {
  for (const frequencyHz of [1_000, 440, 300, 220, 150, 100]) {
    assert.equal(
      concealSamples([frequencyFrame(frequencyHz)], SAMPLE_RATE, 0.02).generatedSamples,
      960,
      `${frequencyHz} Hz を補間すること`,
    );
  }
});

/**
 * 有声の低いピッチでは、探索の上限 (窓長 + ラグがフレーム長に収まる範囲) まで広げ、周期を
 * 端数まで求める。
 *
 * 実測 (48 kHz、20 ms のフレーム、40 ms の穴): 100 Hz の有声は生成に使う周期が 480.02
 * サンプル (真 480)、120 Hz は 400.00 サンプル (真 400) になる。格子だけで探していたときは
 * 120 Hz が 396 であり、100 Hz は探索の上限 (137.9 Hz) に届かず補間そのものをしなかった
 */
test("concealSamples: 有声の低いピッチでも正しい周期で繰り返す", () => {
  for (const [frequencyHz, period] of [
    [100, 480],
    [120, 400],
  ] as const) {
    const result = concealSamples([voicedFrame(frequencyHz)], SAMPLE_RATE, 0.04);
    assert.equal(result.generatedSamples, 1920, `${frequencyHz} Hz を補間すること`);
    const generated = result.channels[0] ?? new Float32Array(0);
    assert.isTrue(
      repeatsAtPeriod(generated, period, 0.02),
      `${frequencyHz} Hz が本当の周期 ${period} サンプルで繰り返すこと`,
    );
    assert.isFalse(
      repeatsAtPeriod(generated, 396, 0.02),
      `${frequencyHz} Hz が格子の周期 396 サンプルで繰り返さないこと`,
    );
  }
});

/**
 * 相関の窓を候補ラグに比例させると、窓が短い (= ラグが短い) 候補ほど相関が高く出て、有色
 * 雑音で最短のラグ (120 サンプル = 400 Hz) のブザーを出す。窓を固定長にすると誤検出が消える。
 *
 * 実測 (400 フレーム、40 ms の穴): 補間が働いた割合は係数 0.99 が 5.5 % → 0.5 %、0.999 が
 * 19.5 % → 9.0 %。最短のラグ (120 サンプル) を選んだ回は 6 回 / 17 回 → 0 回
 */
test("concealSamples: 有色雑音で最短のラグのブザーを出さない", () => {
  for (const coefficient of [0.99, 0.999]) {
    for (let frame = 0; frame < 40; frame++) {
      const samples = coloredNoiseFrame(coefficient, 12_345 + frame * 7_919);
      const result = concealSamples([samples], SAMPLE_RATE, 0.04);
      if (result.generatedSamples === 0) {
        continue;
      }
      const generated = result.channels[0] ?? new Float32Array(0);
      assert.isFalse(repeatsAtPeriod(generated, 120, 1e-6), "最短のラグで繰り返さないこと");
    }
  }
});

// 欠落した区間の補間: 周期的な音では、末尾のピッチ周期を必要な長さまで繰り返す
test("concealSamples: 周期的な音では必要な長さだけ生成する", () => {
  const frame = sineFrame(5);
  const result = concealSamples([frame], SAMPLE_RATE, 0.04);
  assert.equal(result.generatedSamples, 1920);
  assert.equal(result.channels[0]?.length, 1920);
  const generated = result.channels[0] ?? new Float32Array(0);
  // 生成の先頭は、直前の音の末尾のピッチ周期 1 つ分から始まる。周期は端数 (5 ms の正弦では
  // 240.0000x サンプル) になるため、末尾 1 周期前のサンプルは線形補間で読み、厳密一致は
  // しない (実測のずれは 1e-4 未満)
  assert.isAtMost(
    Math.abs(generated[0] - (frame[FRAME_SAMPLES - 240] ?? 0)),
    1e-4,
    "先頭が末尾の 1 周期前から始まること",
  );
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

// 周期は第 1 チャンネルだけで決めるが、繰り返しの継ぎ目の段差はどのチャンネルでもクリックに
// なるため、第 2 チャンネル以降の段差も確かめる。実測 (48 kHz、40 ms の穴): 第 1 チャンネルが
// 5 ms の正弦で第 2 チャンネルがランプのとき、第 1 チャンネルだけを見ていたときは 1920
// サンプル生成し、全チャンネルを見ると生成しない
test("concealSamples: 第 2 チャンネルの継ぎ目の段差が大きいときは生成しない", () => {
  const ramp = new Float32Array(FRAME_SAMPLES);
  for (let index = 0; index < FRAME_SAMPLES; index++) {
    ramp[index] = (index / FRAME_SAMPLES) * 0.9 - 0.45;
  }
  const result = concealSamples([sineFrame(5), ramp], SAMPLE_RATE, 0.04);
  assert.equal(result.generatedSamples, 0, "第 2 チャンネルの段差で補間しないこと");
});

/**
 * 周期の推定が確かでない音では、穴の終わりで次に鳴る音の位相が分からず段差が残る。補間を
 * やめるのではなく、生成した音の末尾を `TIME_STRETCH_CONCEAL_FADE_MS` (2 ms) で 0 へ落とす。
 *
 * 実測 (48 kHz、40 ms の穴、振幅 0.5 の 440 Hz に振幅 0.15 の白色雑音を混ぜた音): 末尾の
 * サンプルは 0 になる。きれいな 440 Hz では相関が 1.0 のためフェードせず、末尾は次の音の
 * 続き (-0.484) になる
 */
test("concealSamples: 周期の推定が確かでない音は末尾をフェードする", () => {
  const frame = noisySineFrame(440, 0.15);
  const result = concealSamples([frame], SAMPLE_RATE, 0.04);
  assert.equal(result.generatedSamples, 1920, "補間すること");
  const generated = result.channels[0] ?? new Float32Array(0);
  assert.equal(generated[generated.length - 1], 0, "末尾のサンプルが 0 になること");
  // フェードは末尾の 2 ms だけに掛ける (その前は振幅が残る)
  const fade = Math.round((TIME_STRETCH_CONCEAL_FADE_MS / 1_000) * SAMPLE_RATE);
  let fadedPeak = 0;
  for (let index = generated.length - fade / 4; index < generated.length; index++) {
    fadedPeak = Math.max(fadedPeak, Math.abs(generated[index] ?? 0));
  }
  let fullPeak = 0;
  for (let index = 0; index < 100; index++) {
    fullPeak = Math.max(fullPeak, Math.abs(generated[index] ?? 0));
  }
  assert.isBelow(fadedPeak, fullPeak * 0.3, "フェードした末尾の振幅が下がること");
  // きれいな純音ではフェードしない (末尾が次の音の続きのまま)
  const clean = concealSamples([frequencyFrame(440)], SAMPLE_RATE, 0.1);
  const cleanGenerated = clean.channels[0] ?? new Float32Array(0);
  const target = Math.round(0.1 * SAMPLE_RATE);
  const next = 0.5 * Math.sin((2 * Math.PI * 440 * (FRAME_SAMPLES + target - 1)) / SAMPLE_RATE);
  assert.isAtMost(
    Math.abs((cleanGenerated[cleanGenerated.length - 1] ?? 0) - next),
    1e-3,
    "相関が高い音ではフェードしないこと",
  );
});

// 前半と後半で周期が違っても、末尾の周期 (後半) で繰り返す。ただし周期の変わる位置が
// 末尾から「相関の窓長 (9.75 ms) + 周期」より近いと、末尾が繰り返しているかを確かめられない
// ため補間しない (実測: 末尾から 720 サンプル目で変わる音は 240 サンプルの周期で補間し、
// 480 サンプル目で変わる音は補間しない)
test("concealSamples: 周期が途中で変わっても末尾の周期で繰り返す", () => {
  const frame = sineFrame(5);
  // 前半 (240 サンプル) だけ周期を 260 サンプルへ変える (前半の中では位相を連続に進める)
  for (let index = 0; index < 240; index++) {
    frame[index] = 0.5 * Math.sin((2 * Math.PI * index) / 260);
  }
  const result = concealSamples([frame], SAMPLE_RATE, 0.04);
  assert.isAbove(result.generatedSamples, 0, "末尾の周期で補間すること");
  // 継ぎ目は末尾の周期 (240 サンプル) の自然な段差と同程度になる
  const generated = result.channels[0] ?? new Float32Array(0);
  const tail = frame.subarray(FRAME_SAMPLES - 240);
  assert.isAtMost(maxStep(generated), maxStep(tail) * 1.2, "波形が飛ばないこと");
  // 周期の変わる位置が末尾に近すぎると、末尾が繰り返しているかを確かめられない
  const late = sineFrame(5);
  for (let index = 0; index < 480; index++) {
    late[index] = 0.5 * Math.sin((2 * Math.PI * index) / 260);
  }
  assert.equal(
    concealSamples([late], SAMPLE_RATE, 0.04).generatedSamples,
    0,
    "繰り返しを確かめられない音では補間しないこと",
  );
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
  // 周期は端数 (5 ms の正弦では 80.0000x サンプル) になるため、末尾 1 周期前のサンプルは
  // 線形補間で読む (実測のずれは 1e-4 未満)
  assert.isAtMost(
    Math.abs(generated[0] - (samples[320 - 80] ?? 0)),
    1e-4,
    "先頭が末尾の 1 周期前から始まること",
  );
  assert.isAtMost(maxStep(generated), maxStep(samples) * 1.2, "波形が飛ばないこと");
});

// 継ぎ目の段差の倍率 (TIME_STRETCH_MAX_SEAM_STEP_RATIO = 2) は内部定数のため、
// 値そのものを写すテストは置かない。波形が飛ばないことは上のテストが担う。

/**
 * 操作できない入力では、音を変えずに「操作しなかった」を返す
 *
 * 4 kHz への間引きはサンプルレートごとのフィルタ表 (8 / 16 / 32 / 48 kHz) を使うため、
 * 44.1 kHz は解析用の変換を持つが、96 kHz には対応していない。非対応のレートでは
 * 音を変更せずに返し、呼び出し側が計器で区別する。
 */
test("操作できない入力では音を変えない", () => {
  const frame = sineFrame(5);
  const silent = new Float32Array(FRAME_SAMPLES);

  // 対応表にも解析用の変換にも無いサンプルレートは操作しない
  assert.equal(
    compressSamples([frame], 96_000).lengthChangeSamples,
    0,
    "非対応のレートでは時間圧縮しないこと",
  );
  assert.deepEqual(
    concealSamples([frame], 96_000, 0.02).channels,
    [],
    "非対応のレートでは補間しないこと",
  );
  // サンプルレートが 0 以下 (壊れた入力)
  assert.equal(compressSamples([frame], 0).lengthChangeSamples, 0, "0 Hz では圧縮しないこと");
  assert.equal(compressSamples([frame], -1).lengthChangeSamples, 0, "負のレートでは圧縮しないこと");
  assert.deepEqual(concealSamples([frame], 0, 0.02).channels, [], "0 Hz では補間しないこと");
  // チャンネルが無い (空の配列)
  assert.equal(compressSamples([], SAMPLE_RATE).lengthChangeSamples, 0, "空では圧縮しないこと");
  assert.deepEqual(concealSamples([], SAMPLE_RATE, 0.02).channels, [], "空では補間しないこと");
  // 相関の窓 (4 kHz で 50 サンプル = 12.5 ms) より短い音
  const veryShort = new Float32Array(16);
  assert.equal(compressSamples([veryShort], SAMPLE_RATE).lengthChangeSamples, 0, "短い音");
  assert.deepEqual(
    concealSamples([veryShort], SAMPLE_RATE, 0.02).channels,
    [],
    "短い音では補間しないこと",
  );
  // 長さ 1 の音
  assert.equal(
    compressSamples([new Float32Array(1)], SAMPLE_RATE).lengthChangeSamples,
    0,
    "1 サンプルでは圧縮しないこと",
  );
  // 無音でも、対応表に無いサンプルレートでは操作しない (無音の扱いより前に入力の検証がある)
  assert.equal(
    compressSamples([silent], 96_000).lengthChangeSamples,
    0,
    "無音でも非対応のレートでは圧縮しないこと",
  );
});
