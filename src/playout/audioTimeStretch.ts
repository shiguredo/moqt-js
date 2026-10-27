/**
 * 復号した音声を、波形の周期性を使って時間圧縮・補間する
 *
 * NetEq (`modules/audio_coding/neteq/time_stretch.cc` と `accelerate.cc`) の時間圧縮を
 * 移植したものである。遅れて届いた音を捨てると音が途切れるため、届いた音を目標の時刻に
 * 間に合わせるために、音の長さをわずかに詰める (時間圧縮) ために使う。
 *
 * NetEq の時間伸長 (`preemptive_expand.cc`) は移植していない。この再生は音を伸ばす場面を
 * 持たないためである (目標より早く届いた音は、前の音の終わりより後ろに置けばよく、足りない
 * 区間は補間 (`concealSamples`) が埋める)。
 *
 * 規則 (NetEq と同じ):
 *
 * - 音声の 1 つのチャンネル (第 1 チャンネル) を 4 kHz へ間引き、その自己相関から
 *   最も強いピーク (ピッチの周期) を探す。ピークの位置が、波形が 1 周期前と一致する
 *   長さである
 * - ピークは 4 kHz の格子に乗るため、そのままだと周期が 48 kHz で 12 サンプル単位に
 *   量子化される。ピークの前後 1 格子の相関を放物線で補間し、端数まで周期を求める
 *   (補間側の `findTailPeriod` は元のサンプルレートで同じことをしており、圧縮側と
 *   対になる)
 * - その長さだけ離れた 2 つの区間の相関が `TIME_STRETCH_CORRELATION_THRESHOLD` (0.9)
 *   より大きいときだけ操作する。波形が繰り返していない場所で切ると、耳につく
 * - 操作は切れ目の前後 `ピッチ周期` サンプルをクロスフェードして繋ぐ。時間圧縮は
 *   ピッチ周期 1 つ分を削る
 * - 操作する位置は音の中央にする (NetEq は 30 ms の入力の 15 ms の位置 = 中央で行う。
 *   ここへ渡す音は Opus の 1 フレーム = 20 ms であるため、中央は 10 ms になる)
 * - 欠落した区間の補間 (`concealSamples`) は末尾の周期を求め、その周期を繰り返す。周期は
 *   4 kHz へ間引いた信号で粗く探し、その周辺を元のサンプルレートの相関で評価して端数まで
 *   求める (4 kHz の格子では 48 kHz で 12 サンプル単位に量子化され、格子に乗らない音で
 *   穴が長いほど位相がずれるため)。相関の窓は候補ラグに比例させず固定長にする (比例させる
 *   と短いラグほど相関が高く出て、有色雑音で最短のラグを選ぶ)。相関が足りない音と、
 *   繰り返しの継ぎ目の段差が大きい音では操作しない (無音は操作する)。継ぎ目の段差は
 *   全チャンネルで確かめる (周期は第 1 チャンネルだけで決める)。周期の推定が確かでない
 *   音では、生成した音の末尾を短くフェードして穴の終わりの段差を消す (この向きの解析は
 *   先頭の窓で周期を求める時間圧縮・時間伸長とは異なる)
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
 * 時間圧縮と補間を使えるサンプルレートか
 *
 * ピッチの周期は 4 kHz へ間引いた信号から求めるため、間引きのフィルタの表 (8 / 16 / 32 /
 * 48 kHz。NetEq と同じ) に加え、44.1 kHz は解析用の信号だけを 48 kHz へ換算する。
 * 元の音声はリサンプルせず、求めた周期を元のレートへ戻して操作する。それ以外の
 * レートでは操作しないため、先にこの関数で確かめて計器へ出す
 * (src/playout/audioPlayoutTimingStats.ts の `stretchUnavailableFrames`)
 */
export function isTimeStretchAvailable(sampleRate: number): boolean {
  if (!(sampleRate > 0)) {
    return false;
  }
  return sampleRate === 44_100 || DOWNSAMPLE_FILTERS.has(Math.round(sampleRate / 4_000) * 4_000);
}

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
  /** 切れ目の前後で波形がどれだけ一致しているか (-1 から 1。操作するのは 0.9 以上のとき) */
  readonly correlation: number;
}

/** 4 kHz へ間引く (NetEq の `DspHelper::DownsampleTo4kHz` と同じ係数と遅延補正) */
function downsampleTo4kHz(signal: AudioSamples, samplesPer4kHzSample: number): AudioSamples {
  if (samplesPer4kHzSample === 44_100 / 4_000) {
    // 非整数比の入力は解析用だけ 48 kHz の格子へ移す。その後も既存の低域フィルタを
    // 通す。再生する音のサンプルは変更せず、周期の推定だけを共通化する。
    const resampled = Float32Array.from(
      { length: Math.floor((signal.length * 48_000) / 44_100) },
      (_, index) => sampleAt(signal, (index * 44_100) / 48_000),
    );
    return downsampleTo4kHz(resampled, 12);
  }
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
 * 4 kHz の信号の、ラグ `lag` だけずらした 2 区間の生の相関 (正規化しない内積)
 *
 * 窓長は `TIME_STRETCH_CORRELATION_LEN` で固定する。窓長をラグに比例させると、窓が
 * 短い (= ラグが短い) 候補ほど相関が高く出て、有色雑音で最短のラグを選んでしまう。
 * 粗い探索も放物線補間も同じ固定長の窓を使うため、3 点の相関を同じ前提で比べられる
 */
function lagCorrelation(downsampled: AudioSamples, lag: number): number {
  let correlation = 0;
  for (let index = 0; index < TIME_STRETCH_CORRELATION_LEN; index++) {
    correlation += (downsampled[index] ?? 0) * (downsampled[index + lag] ?? 0);
  }
  return correlation;
}

/**
 * 窓のエネルギー (2 乗和)
 *
 * 生の相関は正規化していないため、値だけでは完全相関かどうか分からない。ピークの相関を
 * 前後の窓のエネルギーと比べて正規化し、完全相関の判定に使う
 */
function windowEnergy(downsampled: AudioSamples, offset: number): number {
  let energy = 0;
  for (let index = 0; index < TIME_STRETCH_CORRELATION_LEN; index++) {
    const value = downsampled[offset + index] ?? 0;
    energy += value * value;
  }
  return energy;
}

/** 4 kHz の粗い探索の結果 */
interface CoarseLag {
  /** 相関が最も強いラグ (4 kHz のサンプル数) */
  readonly lag: number;
  /** そのラグの生の相関 (正規化しない内積) */
  readonly correlation: number;
}

/**
 * ピッチの周期 (4 kHz のサンプル数) を粗く探す
 *
 * 自分自身との相関が最も強いずらし幅を `TIME_STRETCH_MIN_LAG` から `maxLag` までで探す。
 * ずらし幅 0 は必ず最大になるため探索に入れない (NetEq も下限 `kMinLag` から探す)。
 * 生の相関の最大値と、そのときのラグを返す
 */
function findLag(downsampled: AudioSamples, maxLag: number): CoarseLag {
  let bestLag = TIME_STRETCH_MIN_LAG;
  let bestCorrelation = -Infinity;
  for (let lag = TIME_STRETCH_MIN_LAG; lag <= maxLag; lag++) {
    const correlation = lagCorrelation(downsampled, lag);
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }
  return { lag: bestLag, correlation: bestCorrelation };
}

/**
 * 4 kHz の粗いラグを、ピークの前後 1 格子の相関による放物線補間で端数まで求める
 *
 * 4 kHz の格子では 48 kHz の周期が 12 サンプル単位に量子化されるため、格子に乗らない
 * ピッチの音では位相のずれた 2 区間をクロスフェードすることになり、非調和成分と
 * 50 Hz の側波帯 (声では粗さ) が増える。補間側の `findTailPeriod` が元のサンプルレートで
 * 端数まで周期を求めているのに対し、圧縮側は整数ラグのままで非対称だった。
 *
 * 放物線には、粗い探索と同じ固定長の窓 (`TIME_STRETCH_CORRELATION_LEN`) の生の相関を
 * 使う。窓長が固定なので 3 点は同じ前提で比べられ、上に凸なピークなら頂点が端数ラグに
 * なる。次のときは端数にせず整数ラグを返す (補間しない)。
 *
 * - 前後 1 格子を評価できない (探索の上限に高峰が張り付き、窓が信号の外へ出る) とき。
 *   外挿すると評価していないラグへ頂点が飛ぶため、`findTailPeriod` と同じく格子のままにする
 * - 上に凸でない (曲率が 0 以上) とき。頂点を求められない
 * - 丸め誤差の範囲で完全相関のとき。格子に乗る周期まで放物線の頂点へずらすと、有限窓の
 *   前後の相関の非対称で正しい整数周期の位相を壊す (`findTailPeriod` と同じガード)
 *
 * @param downsampled - 4 kHz へ間引いた第 1 チャンネル
 * @param coarse - 粗い探索の結果
 */
function refineLag(downsampled: AudioSamples, coarse: CoarseLag): number {
  const lag = coarse.lag;
  // 前後 1 格子のうち、後ろ側が窓ごと信号に収まるか。前側は lag >= TIME_STRETCH_MIN_LAG
  // なので必ず評価できる (ラグ 0 は相関 1 になるため評価しない)
  if (lag + 1 + TIME_STRETCH_CORRELATION_LEN > downsampled.length) {
    return lag;
  }
  // 完全相関なら整数ラグを保つ。生の相関は正規化していないため、窓のエネルギーで割って
  // 正規化した値で判定する (厳密な整数周期では窓のエネルギーが等しく、値はちょうど 1 になる)
  const baseEnergy = windowEnergy(downsampled, 0);
  const peakEnergy = windowEnergy(downsampled, lag);
  const denominator = Math.sqrt(baseEnergy * peakEnergy);
  const exactPeriod = denominator > 0 && coarse.correlation >= denominator * (1 - 1e-12);
  if (exactPeriod) {
    return lag;
  }
  const before = lagCorrelation(downsampled, lag - 1);
  const after = lagCorrelation(downsampled, lag + 1);
  // f(-1), f(0), f(+1) を通る放物線の頂点の位置 (ラグの端数)
  const curvature = before - 2 * coarse.correlation + after;
  if (!(curvature < 0)) {
    // 上に凸でない (曲率が 0 以上、または NaN) ため頂点を求められない
    return lag;
  }
  const offset = (0.5 * (before - after)) / curvature;
  // 隣接点より外側に頂点を作らない (外挿しない)
  return lag + Math.max(-0.5, Math.min(0.5, offset));
}

/**
 * ピッチの周期と、切れ目の前後での波形の一致の度合いを求める
 *
 * 周期は 4 kHz の粗い探索のあと、ピークの前後 1 格子の相関による放物線補間で端数まで
 * 求める (`refineLag`)。端数の周期は元のサンプルレートへ戻し、整数サンプルへ丸めた値を
 * 削る長さにする (クロスフェードは整数サンプルのまま行う)。
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
  const samplesPer4kHzSample =
    sampleRate === 44_100 ? sampleRate / 4_000 : Math.round(sampleRate / 4_000);
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
  const coarse = findLag(downsampled, maxLag);
  // 4 kHz の格子に乗らない周期を端数まで求める。44.1 kHz はこのラグに 11.025 を掛けると
  // 元のサンプルレートのサブ格子の周期になる
  const lag = refineLag(downsampled, coarse);
  // ピッチの周期を元のサンプルレートへ戻す
  const samples = Math.round(lag * samplesPer4kHzSample);
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
 * 重みは NetEq と同じで 1 サンプルずつ `1 / (fade + 1)` ずつ動かす (最初のサンプルで既に
 * `1 / (fade + 1)` だけ `source` へ寄り、最後はほぼ `source` になる。`target` のままなのは
 * 重みが 0 の位置までであり、この関数はそこを書かない)
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
 * 削る長さはピッチの周期で決まり、要求では選べない (周期は `TIME_STRETCH_MIN_LAG` の
 * 2.5 ms から `TIME_STRETCH_MAX_LAG` の 15 ms)。遅れより長い周期を削ると、削りすぎた分は
 * 「早すぎる」側へ振れ、次の音でまた遅れて詰める往復になる。往復のたびに周期が 1 つ消える
 * ため、声では粗さ・ざらつきとして聞こえる。削ってよい長さの上限を渡し、周期がそれを
 * 超えるときは操作しない
 *
 * @param channels - チャンネルごとの音声 (すべて同じ長さ)
 * @param sampleRate - サンプルレート (Hz)
 * @param maxLengthChangeSamples - 削ってよいサンプル数の上限 (省略時は無制限)
 * @returns 圧縮した音声と、削ったサンプル数 (負)。操作しなかったときは変化なし
 */
export function compressSamples(
  channels: readonly AudioSamples[],
  sampleRate: number,
  maxLengthChangeSamples: number = Number.POSITIVE_INFINITY,
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
  if (removed > maxLengthChangeSamples) {
    // 遅れより長い周期しか無い。削ると行き過ぎるため、この音では詰めない
    return { channels: [...channels], lengthChangeSamples: 0 };
  }
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
 * 継ぎ目の段差を許す、末尾の周期の自然な段差に対する倍率
 *
 * 周期どおりに繰り返せていれば、繰り返しの先頭は末尾の続きになるため段差は自然な段差と
 * 同程度になる。周期がずれている音では段差が大きくなる (クリックとして聞こえる) ため、
 * この倍率を超える音では補間しない
 */
export const TIME_STRETCH_MAX_SEAM_STEP_RATIO = 2;

/**
 * 補間で使う相関窓の長さ (4 kHz のサンプル数)
 *
 * 候補ラグに比例させない固定長であることが要点である。窓長をラグに比例させると、窓が
 * 短い (= ラグが短い) 候補ほど相関が高く出て、有色雑音で最短のラグを選んでしまう。
 *
 * 窓長は「窓長 + 最大ラグ <= フレーム長」を満たす必要がある。20 ms のフレームは 48 kHz
 * では 4 kHz へ間引くと 79 サンプルであり、100 Hz (40 サンプル) まで探すには窓長 39 が
 * 上限である (39 + 40 = 79)。100 Hz より低いピッチは 20 ms のフレームでは探せない
 * (窓を短くすれば探せるが、相関の推定が不安定になるため伸ばさない)
 */
export const TIME_STRETCH_TAIL_CORRELATION_LEN = 39;

/**
 * 生成した音の末尾を無音へ落とす長さ (ミリ秒)
 *
 * 穴の終わりで次に鳴る音の位相はこの関数からは分からない。末尾の周期の相関が高ければ、
 * 繰り返しの位相が次の音と揃うため段差は波形の自然な段差に収まるが (実測: 440 Hz・
 * 100 ms の穴で振幅の 3 %)、相関が低い音では位相がずれて段差が大きくなる。そのときは
 * 末尾をこの長さで 0 へ落とし、段差を「無音からの立ち上がり」に変える (穴の残りは
 * 無音でよい)。長さは src/audioSpliceFade.ts の `AUDIO_SPLICE_FADE_MS` と同じ 2 ms に
 * する (短くても段差を消せて、音を削りすぎない)
 */
export const TIME_STRETCH_CONCEAL_FADE_MS = 2;

/**
 * 生成した音の末尾を無音へ落とし始める相関
 *
 * 末尾の周期の相関がこれ未満のときは、繰り返す周期が本当の周期とずれている可能性があり、
 * 穴の終わりで次の音と位相が合わない (段差が出る)。補間をやめる下限
 * (`TIME_STRETCH_CORRELATION_THRESHOLD` の 0.9) は超えていても、位相のずれは残る
 */
export const TIME_STRETCH_CONCEAL_FADE_CORRELATION = 0.95;

/** 末尾で繰り返しているピッチ周期の探索の結果 */
interface TailPeriod {
  /** 末尾で繰り返している周期 (元のサンプルレートのサンプル数)。端数を含む */
  readonly samples: number;
  /** 末尾で繰り返しているか (-1 から 1)。穴の終わりの段差の大きさの目安でもある */
  readonly correlation: number;
}

/** 補間した音 (直前の音の末尾を伸ばした分だけ) */
export interface ConcealResult {
  /** 生成した音 (チャンネルごと)。補間できなかったときは長さ 0 */
  readonly channels: AudioSamples[];
  /** 生成した長さ (サンプル数)。0 のときは補間なし */
  readonly generatedSamples: number;
}

/**
 * 直前の音の末尾を、ピッチ周期を繰り返して伸ばす (欠落した区間の補間)
 *
 * 周期は末尾の相関から求める (先頭の相関窓で求める `findLag` とは別。繰り返しの継ぎ目は
 * 末尾にあるため、末尾の周期を直接評価する)。相関が `TIME_STRETCH_CORRELATION_THRESHOLD`
 * より低い音 (繰り返していない音) と、継ぎ目の段差が `TIME_STRETCH_MAX_SEAM_STEP_RATIO`
 * を超える音では補間しない (無音のまま残す)。継ぎ目の段差は全チャンネルで確かめる。
 * 無音は聞こえないため、相関が足りなくても補間する (時間圧縮・時間伸長と同じ扱い)。
 * 周期どおりに繰り返せているときは、繰り返しの先頭が末尾の続きになるため継ぎ目は
 * 波形が連続する。
 *
 * 生成した音の末尾の振幅は `endGain` まで徐々に下げる (長い欠落を無音へ近づける)。
 * 周期の推定が確かでない (`TIME_STRETCH_CONCEAL_FADE_CORRELATION` 未満) ときは、さらに
 * 末尾を `TIME_STRETCH_CONCEAL_FADE_MS` で 0 へ落とす (穴の終わりで次に鳴る音の位相が
 * 分からず、段差がクリックになるため)。
 *
 * @param channels - 直前の音のチャンネルごとのサンプル (すべて同じ長さ)
 * @param sampleRate - サンプルレート (Hz)
 * @param seconds - 伸ばす長さ (秒)
 * @param endGain - 生成した音の末尾の振幅 (1 で減衰なし。省略時は 1)
 * @returns 生成した音と、生成した長さ。補間できないときは長さ 0
 */
export function concealSamples(
  channels: readonly AudioSamples[],
  sampleRate: number,
  seconds: number,
  endGain = 1,
): ConcealResult {
  const reference = channels[0];
  const length = reference?.length ?? 0;
  const target = Math.max(0, Math.round(seconds * sampleRate));
  if (reference === undefined || length === 0 || !Number.isFinite(target) || target <= 0) {
    return { channels: [], generatedSamples: 0 };
  }
  // 末尾で繰り返している周期を、4 kHz の粗い探索と元のサンプルレートの端数補間で求める
  const samplesPer4kHzSample =
    sampleRate === 44_100 ? sampleRate / 4_000 : Math.round(sampleRate / 4_000);
  const tail = findTailPeriod(reference, samplesPer4kHzSample);
  if (tail === null || tail.samples <= 0 || tail.samples > length) {
    // 末尾に周期が無い (音が短すぎる、対応していないサンプルレート)
    return { channels: [], generatedSamples: 0 };
  }
  if (tail.correlation < TIME_STRETCH_CORRELATION_THRESHOLD && !isSilent(channels)) {
    return { channels: [], generatedSamples: 0 };
  }
  // 継ぎ目の段差の検査は全チャンネルで行う (周期は第 1 チャンネルだけで決める)
  if (!isSeamSmooth(channels, tail.samples)) {
    return { channels: [], generatedSamples: 0 };
  }
  const clampedEndGain = Math.min(1, Math.max(0, endGain));
  // 周期の推定が確かでないときは、穴の終わりで次の音と位相が合わない。補間をやめるのでは
  // なく、生成した音の末尾を短くフェードして段差を消す (穴の残りは無音でよい)
  const fade =
    tail.correlation < TIME_STRETCH_CONCEAL_FADE_CORRELATION
      ? Math.min(
          target,
          Math.max(1, Math.round((TIME_STRETCH_CONCEAL_FADE_MS / 1_000) * sampleRate)),
        )
      : 0;
  const output: AudioSamples[] = [];
  for (const channel of channels) {
    // 末尾のピッチ周期 1 つ分を、端数周期の位相を保ったまま必要な長さまで繰り返す
    const start = length - tail.samples;
    const generated = new Float32Array(target);
    for (let index = 0; index < target; index++) {
      const phase = index - Math.floor(index / tail.samples) * tail.samples;
      generated[index] = readRepeated(channel, start, phase);
    }
    if (clampedEndGain < 1) {
      // 長い補間ほど末尾の振幅を下げる (繰り返しの音を目立たなくする)
      for (let index = 0; index < target; index++) {
        const gain = 1 - (1 - clampedEndGain) * ((index + 1) / target);
        generated[index] = (generated[index] ?? 0) * gain;
      }
    }
    if (fade > 0) {
      // 末尾を 0 へ落とす (最後のサンプルが 0 になる)
      for (let index = 0; index < fade; index++) {
        const gain = 1 - (index + 1) / fade;
        const position = target - fade + index;
        generated[position] = (generated[position] ?? 0) * gain;
      }
    }
    output.push(generated);
  }
  return { channels: output, generatedSamples: target };
}

/**
 * 端数の位置のサンプルを線形補間で読む
 *
 * 周期は 4 kHz の格子 (48 kHz で 12 サンプル) に乗らない端数になるため、繰り返しの生成
 * では 2 つのサンプルの間を読む。末尾をまたぐときは最後のサンプルをそのまま返す
 */
function sampleAt(signal: AudioSamples, position: number): number {
  const lower = Math.floor(position);
  const fraction = position - lower;
  const before = signal[lower] ?? 0;
  const after = signal[lower + 1] ?? before;
  return before + (after - before) * fraction;
}

/**
 * 末尾の周期 1 つ分を繰り返して読む
 *
 * 端数の位置は線形補間で読む。参照の末尾をまたぐときは、1 周期前 (周期の先頭) を続きと
 * して読む。周期が繰り返しているため、参照の末尾の次のサンプルは周期の先頭になる
 *
 * @param signal - 音声
 * @param start - 末尾の周期 1 つ分の先頭 (端数を含む)
 * @param phase - 周期の中の位置 (0 から 1 周期未満)
 */
function readRepeated(signal: AudioSamples, start: number, phase: number): number {
  const position = start + phase;
  const lower = Math.floor(position);
  const fraction = position - lower;
  const before = signal[lower] ?? 0;
  const after = lower + 1 < signal.length ? (signal[lower + 1] ?? before) : sampleAt(signal, start);
  return before + (after - before) * fraction;
}

/**
 * 2 つの区間の正規化した相関 (-1 から 1) を求める
 *
 * `end` を末尾とする長さ `window` の区間と、そこから `lag` だけ前の同じ長さの区間を比べる。
 * 窓の長さは呼び出し側が決める (候補ラグに比例させない)
 */
function normalizedCorrelation(
  signal: AudioSamples,
  end: number,
  window: number,
  lag: number,
): number {
  let dot = 0;
  let energyBefore = 0;
  let energyAfter = 0;
  for (let index = 0; index < window; index++) {
    const before = signal[end - lag - window + index] ?? 0;
    const after = signal[end - window + index] ?? 0;
    dot += before * after;
    energyBefore += before * before;
    energyAfter += after * after;
  }
  const denominator = Math.sqrt(energyBefore * energyAfter);
  return denominator === 0 ? 0 : dot / denominator;
}

/**
 * 末尾で繰り返しているピッチ周期を求める
 *
 * 1. 4 kHz へ間引いた信号で、固定長の窓どうしの相関が最も高いラグを粗く探す
 * 2. その周辺 (±1 格子) を元のサンプルレートの正規化相関で評価し、ピークを放物線補間して
 *    端数まで求める
 *
 * 2 段にするのは、4 kHz の格子に周期が乗らない音で位相がずれるためである。4 kHz だけでは
 * 440 Hz の周期 109.09 サンプルを 108 としか求められず、100 ms の穴で 0.44 周期ずれて
 * 次の音との段差が振幅の 195 % になる (端数まで求めると 3 % になる)。
 *
 * 放物線の頂点には実際の隣接 3 点の相関を使う。探索範囲の外側も 1 サンプルずつ評価し、
 * 44.1 kHz のように下限が整数でないレートでも、周期を範囲の内側へ丸めない。
 * 入力の長さの制約で隣接点を評価できないときは、外挿せず格子のままにする
 *
 * 音が短すぎる、対応していないサンプルレートのときは null
 */
function findTailPeriod(reference: AudioSamples, samplesPer4kHzSample: number): TailPeriod | null {
  const downsampled = downsampleTo4kHz(reference, samplesPer4kHzSample);
  const end = downsampled.length;
  // 窓長は固定にする。窓長 + ラグがフレーム長に収まる範囲でラグの上限を最大化する
  const window = Math.min(TIME_STRETCH_TAIL_CORRELATION_LEN, end - TIME_STRETCH_MIN_LAG);
  if (window <= 0) {
    return null;
  }
  const maxLag = Math.min(TIME_STRETCH_MAX_LAG, end - window);
  if (maxLag < TIME_STRETCH_MIN_LAG) {
    return null;
  }
  let coarseLag = TIME_STRETCH_MIN_LAG;
  let coarseCorrelation = -Infinity;
  for (let lag = TIME_STRETCH_MIN_LAG; lag <= maxLag; lag++) {
    const correlation = normalizedCorrelation(downsampled, end, window, lag);
    if (correlation > coarseCorrelation) {
      coarseCorrelation = correlation;
      coarseLag = lag;
    }
  }
  // 粗いラグの周辺 (±1 格子) を元のサンプルレートで評価する
  const length = reference.length;
  const fullWindow = Math.floor(
    Math.min(window * samplesPer4kHzSample, length - TIME_STRETCH_MIN_LAG * samplesPer4kHzSample),
  );
  const center = coarseLag * samplesPer4kHzSample;
  // 端数の下限を ceil すると 44.1 kHz / 399 Hz の真の周期 110.526 サンプルが
  // 探索の外になり、111 サンプルへ丸めた位相誤差が長い補間で蓄積する。外側へ丸め、
  // 放物線補間に必要な隣接 1 サンプルも実際に評価する。
  const firstLag = Math.max(
    1,
    Math.floor(
      Math.max(TIME_STRETCH_MIN_LAG * samplesPer4kHzSample, center - samplesPer4kHzSample),
    ) - 1,
  );
  const lastLag = Math.min(length - fullWindow, Math.ceil(center + samplesPer4kHzSample) + 1);
  if (fullWindow <= 0 || lastLag < firstLag) {
    // 元のサンプルレートで評価できない (音が短すぎる) ときは粗い格子のまま使う
    return { samples: center, correlation: coarseCorrelation };
  }
  const correlations: number[] = [];
  let bestLag = firstLag;
  let bestCorrelation = -Infinity;
  for (let lag = firstLag; lag <= lastLag; lag++) {
    const correlation = normalizedCorrelation(reference, length, fullWindow, lag);
    correlations.push(correlation);
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }
  // ピークを放物線で補間して端数まで求める。最大値を欠けた隣接点の代用にすると
  // 架空の頂点を作るため、実際に前後を評価できたときだけ補間する。上に凸でない
  // (曲率が 0 以上) ときも頂点を求められないため、格子のままにする
  const peak = bestLag - firstLag;
  const hasBothNeighbors = peak > 0 && peak + 1 < correlations.length;
  const before = hasBothNeighbors ? (correlations[peak - 1] ?? bestCorrelation) : bestCorrelation;
  const after = hasBothNeighbors ? (correlations[peak + 1] ?? bestCorrelation) : bestCorrelation;
  const curvature = before - 2 * bestCorrelation + after;
  // 整数ラグが丸め誤差の範囲で完全相関なら、その周期を維持する。有限窓の前後の
  // 相関は非対称になり得るため、正しい整数周期まで放物線の頂点へずらすと位相を壊す。
  const exactPeriod = bestCorrelation >= 1 - 1e-12;
  const offset =
    !exactPeriod && hasBothNeighbors && curvature < 0 ? (0.5 * (before - after)) / curvature : 0;
  const samples = bestLag + Math.max(-0.5, Math.min(0.5, offset));
  return { samples, correlation: bestCorrelation };
}

/**
 * 繰り返しの継ぎ目の段差が、末尾の周期の自然な段差と比べて大きすぎないかを確かめる
 *
 * 段差は、末尾の最後のサンプルと、繰り返しの先頭になる 1 周期前のサンプルの差である。
 * 周期がずれている音ではここが大きくなり、クリックとして聞こえる。周期は端数を含むため、
 * 1 周期前のサンプルは線形補間で読む。周期は第 1 チャンネルだけで決めるが、段差はどの
 * チャンネルでもクリックになるため、全チャンネルで確かめる
 */
function isSeamSmooth(channels: readonly AudioSamples[], period: number): boolean {
  for (const channel of channels) {
    if (!isChannelSeamSmooth(channel, period)) {
      return false;
    }
  }
  return true;
}

/** 1 つのチャンネルの継ぎ目の段差を確かめる */
function isChannelSeamSmooth(channel: AudioSamples, period: number): boolean {
  const length = channel.length;
  let naturalStep = 0;
  for (let index = Math.max(1, Math.ceil(length - period)); index < length; index++) {
    naturalStep = Math.max(
      naturalStep,
      Math.abs((channel[index] ?? 0) - (channel[index - 1] ?? 0)),
    );
  }
  const seamStep = Math.abs(sampleAt(channel, length - period) - (channel[length - 1] ?? 0));
  return seamStep <= naturalStep * TIME_STRETCH_MAX_SEAM_STEP_RATIO;
}
