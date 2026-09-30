/**
 * 復号した音声を、波形の周期性を使って時間圧縮・時間伸長する
 *
 * NetEq (`modules/audio_coding/neteq/time_stretch.cc` と `accelerate.cc` /
 * `preemptive_expand.cc`) の時間伸縮を移植したものである。遅れて届いた音を捨てると
 * 音が途切れるため、届いた音を目標の時刻に間に合わせるために、音の長さをわずかに
 * 詰める (時間圧縮) または伸ばす (時間伸長) ために使う。
 *
 * 規則 (NetEq と同じ):
 *
 * - 音声の 1 つのチャンネル (第 1 チャンネル) を 4 kHz へ間引き、その自己相関から
 *   最も強いピーク (ピッチの周期) を探す。ピークの位置が、波形が 1 周期前と一致する
 *   長さである
 * - その長さだけ離れた 2 つの区間の相関が `TIME_STRETCH_CORRELATION_THRESHOLD` (0.9)
 *   より大きいときだけ操作する。波形が繰り返していない場所で切ると、耳につく
 * - 操作は切れ目の前後 `ピッチ周期` サンプルをクロスフェードして繋ぐ。時間圧縮は
 *   ピッチ周期 1 つ分を削り、時間伸長は 1 つ分を挿す
 * - 操作する位置は音の中央にする (NetEq は 30 ms の入力の 15 ms の位置 = 中央で行う。
 *   ここへ渡す音は Opus の 1 フレーム = 20 ms であるため、中央は 10 ms になる)
 *
 * 単位はサンプル数、時刻は呼び出し側が引数で渡す。ブラウザ API に依存しない。
 */

/**
 * 相関を測る長さ (4 kHz のサンプル数)
 *
 * NetEq の `TimeStretch::kCorrelationLen` と同じ値 (12.5 ms)
 */
export const TIME_STRETCH_CORRELATION_LEN = 50;

/** ピッチの周期の下限 (4 kHz のサンプル数)。NetEq の `kMinLag` と同じ値 (2.5 ms) */
export const TIME_STRETCH_MIN_LAG = 10;

/** ピッチの周期の上限 (4 kHz のサンプル数)。NetEq の `kMaxLag` と同じ値 (15 ms) */
export const TIME_STRETCH_MAX_LAG = 60;

/**
 * 操作を行う相関の下限
 *
 * NetEq の `kCorrelationThreshold` (Q14 の 14746 = 0.9) と同じ値
 */
export const TIME_STRETCH_CORRELATION_THRESHOLD = 0.9;

/**
 * 無音とみなす振幅 (dBFS)
 *
 * NetEq は「有効な音声でない」と判定したとき、相関が無くても操作する (無音を詰めても
 * 聞こえないため)。ここでは単純に、この値より小さい信号を無音として同じ扱いにする
 */
export const TIME_STRETCH_SILENCE_DBFS = -60;

/** 4 kHz へ間引くときのフィルタ。NetEq の `DspHelper::DownsampleTo4kHz` と同じ係数 */
interface DownsampleFilter {
  /** Q15 の係数 (和で正規化して使う) */
  readonly coefficients: readonly number[];
  /** 間引きの間隔 (入力のサンプル数) */
  readonly factor: number;
  /** フィルタの遅延 (入力のサンプル数) */
  readonly delay: number;
}

/**
 * サンプルレートごとのフィルタ
 *
 * NetEq の `kDownsample8kHzTbl` / `kDownsample16kHzTbl` / `kDownsample32kHzTbl` /
 * `kDownsample48kHzTbl` と同じ係数である。`delay` は NetEq の `filter_delay`
 * (フィルタ長の半分 + 1) であり、間引きで生じる遅れを補正する
 */
const DOWNSAMPLE_FILTERS: ReadonlyMap<number, DownsampleFilter> = new Map([
  [8_000, { coefficients: [1229, 1638, 1229], factor: 2, delay: 2 }],
  [16_000, { coefficients: [614, 819, 1229, 819, 614], factor: 4, delay: 3 }],
  [32_000, { coefficients: [584, 512, 625, 667, 625, 512, 584], factor: 8, delay: 4 }],
  [48_000, { coefficients: [1019, 390, 427, 440, 427, 390, 1019], factor: 12, delay: 4 }],
]);

/**
 * 音声のサンプル列 (1 チャンネル分)
 *
 * バッファーの型まで固定する (`Float32Array<ArrayBuffer>`)。Web Audio の
 * `AudioBuffer.copyToChannel` がこの型を要求するためである
 */
export type AudioSamples = Float32Array<ArrayBuffer>;

/** 時間伸縮の結果 */
export interface TimeStretchResult {
  /** 時間伸縮した音声 (チャンネルごと)。操作しなかったときは元の配列 */
  readonly channels: AudioSamples[];
  /**
   * 長さの変化 (サンプル数)。正が時間伸長、負が時間圧縮、0 が操作なし
   */
  readonly lengthChangeSamples: number;
}

/** ピッチの周期の探索の結果 */
interface PitchPeriod {
  /** ピッチの周期 (元のサンプルレートのサンプル数) */
  readonly samples: number;
  /** 切れ目の前後で波形がどれだけ一致しているか (0 から 1) */
  readonly correlation: number;
}

/** 4 kHz へ間引く (NetEq の `DspHelper::DownsampleTo4kHz` と同じ係数と遅延補正) */
function downsampleTo4kHz(signal: AudioSamples, samplesPer4kHzSample: number): AudioSamples {
  const filter = DOWNSAMPLE_FILTERS.get(samplesPer4kHzSample * 4_000);
  if (filter === undefined) {
    return new Float32Array(0);
  }
  const length = filter.coefficients.length;
  const coefficientSum = filter.coefficients.reduce((sum, value) => sum + value, 0);
  // NetEq と同じく、フィルタ長 - 1 + 遅延の分だけ後ろから始める
  const start = length - 1 + filter.delay;
  const count = Math.max(0, Math.floor((signal.length - start) / filter.factor));
  const output = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    let sum = 0;
    for (let tap = 0; tap < length; tap++) {
      const position = start + index * filter.factor - tap;
      sum += (filter.coefficients[tap] ?? 0) * (signal[position] ?? 0);
    }
    output[index] = sum / coefficientSum;
  }
  return output;
}

/**
 * ピッチの周期 (4 kHz のサンプル数) を探す
 *
 * 自分自身との相関が最も強いずらし幅を `TIME_STRETCH_MIN_LAG` から `maxLag` までで探す。
 * ずらし幅 0 は必ず最大になるため探索に入れない (NetEq も下限 `kMinLag` から探す)
 */
function findLag(downsampled: AudioSamples, maxLag: number): number {
  let bestLag = TIME_STRETCH_MIN_LAG;
  let bestValue = -Infinity;
  for (let lag = TIME_STRETCH_MIN_LAG; lag <= maxLag; lag++) {
    let correlation = 0;
    for (let index = 0; index < TIME_STRETCH_CORRELATION_LEN; index++) {
      correlation += (downsampled[index] ?? 0) * (downsampled[index + lag] ?? 0);
    }
    if (correlation > bestValue) {
      bestValue = correlation;
      bestLag = lag;
    }
  }
  return bestLag;
}

/**
 * ピッチの周期と、切れ目の前後での波形の一致の度合いを求める
 *
 * @param reference - 第 1 チャンネルの音声
 * @param sampleRate - サンプルレート (Hz)
 * @param spliceSamples - 操作する位置 (サンプル数)
 */
function analyze(
  reference: AudioSamples,
  sampleRate: number,
  spliceSamples: number,
): PitchPeriod | null {
  const samplesPer4kHzSample = Math.round(sampleRate / 4_000);
  if (samplesPer4kHzSample <= 0) {
    return null;
  }
  const downsampled = downsampleTo4kHz(reference, samplesPer4kHzSample);
  if (downsampled.length < TIME_STRETCH_CORRELATION_LEN + TIME_STRETCH_MIN_LAG + 1) {
    return null;
  }
  // 自己相関の窓とピッチの周期が 4 kHz の信号に収まる範囲で探す
  const maxLag = Math.min(TIME_STRETCH_MAX_LAG, downsampled.length - TIME_STRETCH_CORRELATION_LEN);
  if (maxLag < TIME_STRETCH_MIN_LAG) {
    return null;
  }
  const lag = findLag(downsampled, maxLag);
  // ピッチの周期を元のサンプルレートへ戻す
  const samples = lag * samplesPer4kHzSample;
  if (samples <= 0 || samples > spliceSamples || spliceSamples + samples > reference.length) {
    // 切れ目の前後が音に収まらない (音が短すぎる)
    return null;
  }
  // 切れ目の前後で波形がどれだけ一致しているか
  let dot = 0;
  let energyBefore = 0;
  let energyAfter = 0;
  for (let index = 0; index < samples; index++) {
    const before = reference[spliceSamples - samples + index] ?? 0;
    const after = reference[spliceSamples + index] ?? 0;
    dot += before * after;
    energyBefore += before * before;
    energyAfter += after * after;
  }
  const denominator = Math.sqrt(energyBefore * energyAfter);
  const correlation = denominator === 0 ? 0 : dot / denominator;
  return { samples, correlation };
}

/** 信号が無音に近いか (NetEq の「有効な音声でない」判定の代わり) */
function isSilent(channels: readonly AudioSamples[]): boolean {
  let peak = 0;
  for (const channel of channels) {
    for (const sample of channel) {
      peak = Math.max(peak, Math.abs(sample));
    }
  }
  return 20 * Math.log10(Math.max(peak, 1e-10)) < TIME_STRETCH_SILENCE_DBFS;
}

/**
 * 切れ目の前後をクロスフェードする (NetEq の `AudioVector::CrossFade` と同じ重み)
 *
 * `target` の `fade` サンプルを、`source` の先頭 `fade` サンプルへ少しずつ寄せる。
 * 重みは NetEq と同じで 1 サンプルずつ `1 / (fade + 1)` ずつ動かす (最初は `target` の
 * まま、最後はほぼ `source` になる)
 */
function crossFade(
  target: AudioSamples,
  targetOffset: number,
  source: AudioSamples,
  sourceOffset: number,
  fade: number,
): void {
  const step = 1 / (fade + 1);
  for (let index = 0; index < fade; index++) {
    const weight = (index + 1) * step;
    const mixed =
      (1 - weight) * (target[targetOffset + index] ?? 0) +
      weight * (source[sourceOffset + index] ?? 0);
    target[targetOffset + index] = mixed;
  }
}

/** 伸縮の対象になるピッチの周期を求める (操作しないときは null) */
function pitchPeriodOf(
  channels: readonly AudioSamples[],
  sampleRate: number,
  spliceSamples: number,
): PitchPeriod | null {
  const reference = channels[0];
  if (reference === undefined) {
    return null;
  }
  const pitch = analyze(reference, sampleRate, spliceSamples);
  if (pitch === null) {
    return null;
  }
  // 波形が繰り返していない場所で切ると耳につくため、相関が足りないときは操作しない。
  // 無音は詰めても伸ばしても聞こえないため、そのまま操作する (NetEq と同じ扱い)
  if (pitch.correlation < TIME_STRETCH_CORRELATION_THRESHOLD && !isSilent(channels)) {
    return null;
  }
  return pitch;
}

/**
 * 音声を時間圧縮する (ピッチ周期 1 つ分を削る)
 *
 * @param channels - チャンネルごとの音声 (すべて同じ長さ)
 * @param sampleRate - サンプルレート (Hz)
 * @returns 圧縮した音声と、削ったサンプル数 (負)。操作しなかったときは変化なし
 */
export function compressSamples(
  channels: readonly AudioSamples[],
  sampleRate: number,
): TimeStretchResult {
  const length = channels[0]?.length ?? 0;
  if (length === 0) {
    return { channels: [...channels], lengthChangeSamples: 0 };
  }
  // 操作する位置は音の中央 (NetEq は 30 ms の入力の 15 ms で行う)
  const splice = length >> 1;
  const pitch = pitchPeriodOf(channels, sampleRate, splice);
  if (pitch === null) {
    return { channels: [...channels], lengthChangeSamples: 0 };
  }
  const removed = pitch.samples;
  const output: AudioSamples[] = [];
  for (const channel of channels) {
    const compressed = new Float32Array(length - removed);
    // 切れ目より前 (クロスフェードの分を除く)
    compressed.set(channel.subarray(0, splice - removed), 0);
    // 切れ目の前後をクロスフェードして繋ぐ
    compressed.set(channel.subarray(splice - removed, splice), splice - removed);
    crossFade(compressed, splice - removed, channel, splice, removed);
    // 切れ目より後
    compressed.set(channel.subarray(splice + removed), splice);
    output.push(compressed);
  }
  return { channels: output, lengthChangeSamples: -removed };
}

/**
 * 音声を時間伸長する (ピッチ周期 1 つ分を挿す)
 *
 * @param channels - チャンネルごとの音声 (すべて同じ長さ)
 * @param sampleRate - サンプルレート (Hz)
 * @returns 伸長した音声と、挿したサンプル数 (正)。操作しなかったときは変化なし
 */
export function expandSamples(
  channels: readonly AudioSamples[],
  sampleRate: number,
): TimeStretchResult {
  const length = channels[0]?.length ?? 0;
  if (length === 0) {
    return { channels: [...channels], lengthChangeSamples: 0 };
  }
  const splice = length >> 1;
  const pitch = pitchPeriodOf(channels, sampleRate, splice);
  if (pitch === null) {
    return { channels: [...channels], lengthChangeSamples: 0 };
  }
  const added = pitch.samples;
  const output: AudioSamples[] = [];
  for (const channel of channels) {
    const expanded = new Float32Array(length + added);
    // 切れ目までと、挿す分 (切れ目の直前のピッチ周期 1 つ分)
    expanded.set(channel.subarray(0, splice + added), 0);
    // 挿した分の先頭を、切れ目の直前の音とクロスフェードする
    crossFade(expanded, splice, channel, splice - added, added);
    // 切れ目より後
    expanded.set(channel.subarray(splice), splice + added);
    output.push(expanded);
  }
  return { channels: output, lengthChangeSamples: added };
}
