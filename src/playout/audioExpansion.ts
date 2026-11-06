/**
 * 実際の未着時に出力側で生成する、最大 100 ms の続き音。
 * NetEq Expand の有声 / 無声の分離を参考に、周期が確かな場合は既存の周期補間を使い、
 * それ以外は線形予測フィルターに非周期の励振を入れる。上流とビット一致する移植ではない。
 * 根拠: WebRTC NetEq Expand、031cc215615895d7ae039d4098c2716d7acf2dc3。
 * 上流の処理は変更され得るため、係数だけの一致を互換性の根拠にしない。
 */
import { concealSamples, type AudioSamples } from "./audioTimeStretch";
import { AUDIO_PLAYOUT_CONCEAL_END_GAIN, AUDIO_PLAYOUT_MAX_CONCEAL_SECONDS } from "./audioPlayout";

export const AUDIO_EXPANSION_SECONDS = AUDIO_PLAYOUT_MAX_CONCEAL_SECONDS;
const PREDICTOR_ORDER = 12;
const HISTORY_SIZE = 16;
const HISTORY_MASK = HISTORY_SIZE - 1;
/** [-1, 1] の一様雑音の RMS は 1 / √3 であるため、√3 を掛けて励振の RMS を残差に合わせる。 */
const UNIFORM_NOISE_GAIN = Math.sqrt(3);

/** コールバックや一時配列を使わず、元の順序で音量を集計する。 */
function signalLevel(samples: AudioSamples): { rms: number; peak: number } {
  let energy = 0;
  let peak = 0;
  for (let index = 0; index < samples.length; index++) {
    const value = samples[index] ?? 0;
    energy += value * value;
    peak = Math.max(peak, Math.abs(value));
  }
  return { rms: Math.sqrt(energy / samples.length), peak };
}

/** 自己相関から、安定性を制約した線形予測係数と残差の大きさを求める。 */
function predictor(samples: AudioSamples): {
  coefficients: Float64Array;
  innovation: number;
  rms: number;
} {
  const correlations = new Float64Array(PREDICTOR_ORDER + 1);
  for (let lag = 0; lag <= PREDICTOR_ORDER; lag++) {
    let sum = 0;
    for (let index = lag; index < samples.length; index++)
      sum += (samples[index] ?? 0) * (samples[index - lag] ?? 0);
    correlations[lag] = sum;
  }
  let error = (correlations[0] ?? 0) * 1.0001;
  const rms = Math.sqrt((correlations[0] ?? 0) / samples.length);
  const coefficients = new Float64Array(PREDICTOR_ORDER);
  for (let order = 0; order < PREDICTOR_ORDER && error > 1e-20; order++) {
    let residual = correlations[order + 1] ?? 0;
    for (let index = 0; index < order; index++)
      residual -= (coefficients[index] ?? 0) * (correlations[order - index] ?? 0);
    const reflection = Math.max(-0.98, Math.min(0.98, residual / error));
    const previous = coefficients.slice();
    for (let index = 0; index < order; index++)
      coefficients[index] =
        (previous[index] ?? 0) - reflection * (previous[order - index - 1] ?? 0);
    coefficients[order] = reflection;
    error *= 1 - reflection * reflection;
  }
  return { coefficients, innovation: Math.sqrt(Math.max(0, error) / samples.length), rms };
}

/**
 * 線形予測フィルターに非周期の励振を入れて、無声の続き音を合成する。
 *
 * 励振は線形合同法の一様雑音であり、RMS を残差の大きさ (`innovation`) に合わせる。
 * 各サンプルは励振に直前 `PREDICTOR_ORDER` 個の出力 (最初は実音の末尾 `tail`) の
 * 予測を足し、実音のピーク (`limit`) で打ち切る。予測の積和は係数の順に倍精度で足し、
 * 出力だけを Float32 へ丸める。音量の制約と減衰は呼び出し側で行う。
 *
 * @param coefficients - 線形予測係数 (`PREDICTOR_ORDER` 個)
 * @param tail - 直前の実音 (時系列順)。末尾 `PREDICTOR_ORDER` 個を予測の履歴にする
 * @param frames - 生成するサンプル数
 * @param options - 励振の種 (`state`)、残差の大きさ、ピークの上限、励振の極性
 */
export function generateUnvoiced(
  coefficients: Float64Array,
  tail: ArrayLike<number>,
  frames: number,
  options: { state: number; innovation: number; limit: number; polarity: number },
): Float32Array<ArrayBuffer> {
  if (coefficients.length !== PREDICTOR_ORDER)
    throw new Error(
      `Expected ${PREDICTOR_ORDER} predictor coefficients, got ${coefficients.length}`,
    );
  if (!Number.isInteger(frames) || frames < 0)
    throw new Error(`Expected a non-negative integer frame count, got ${frames}`);
  // 直前の出力をリングで持ち、各サンプルで履歴をコピーしない。最初は実音の末尾で埋める
  const history = new Float64Array(HISTORY_SIZE);
  for (let index = 0; index < PREDICTOR_ORDER; index++)
    history[(-1 - index) & HISTORY_MASK] = tail[tail.length - 1 - index] ?? 0;
  let head = 0;
  let state = options.state >>> 0;
  const { innovation, limit, polarity } = options;
  const samples = new Float32Array(frames);
  for (let index = 0; index < frames; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    let value = ((state / 4294967295) * 2 - 1) * UNIFORM_NOISE_GAIN * innovation * polarity;
    for (let order = 0; order < PREDICTOR_ORDER; order++)
      value += (coefficients[order] ?? 0) * (history[(head - 1 - order) & HISTORY_MASK] ?? 0);
    if (value > limit) value = limit;
    if (value < -limit) value = -limit;
    history[head] = value;
    head = (head + 1) & HISTORY_MASK;
    samples[index] = value;
  }
  return samples;
}

/** 無声成分を周期的に繰り返さず、過去のスペクトルを使って合成する。 */
function unvoiced(samples: AudioSamples, frames: number, current: AudioSamples): AudioSamples {
  const { coefficients, innovation: referenceInnovation, rms: referenceRms } = predictor(samples);
  const { rms, peak: limit } = signalLevel(current);
  const innovation = referenceRms > 0 ? (referenceInnovation * rms) / referenceRms : 0;
  if (rms < 1e-8) return new Float32Array(frames);
  // 同一チャンネルは同じ励振、逆相チャンネルは逆の励振にして定位を変えない。
  const polarity = (samples.find((value) => Math.abs(value) > 1e-8) ?? 1) < 0 ? -1 : 1;
  let state = 2166136261;
  for (const value of samples)
    state = Math.imul(state ^ Math.round(Math.abs(value) * 1e7), 16777619) >>> 0;
  const result = generateUnvoiced(coefficients, samples, frames, {
    state,
    innovation,
    limit,
    polarity,
  });
  const { rms: generatedRms } = signalLevel(result);
  // フィルターの有限区間の過渡で音量を増やさない。長い欠落ほど徐々に減衰する。
  const scale = generatedRms > rms ? rms / generatedRms : 1;
  for (let index = 0; index < frames; index++)
    result[index] = (result[index] ?? 0) * scale * (1 - (0.5 * (index + 1)) / frames);
  return result;
}

/** 解析に使う過去が大きな音でも、最新の実音より音量やピークを増やさない。 */
function constrainLevel(
  expansion: AudioSamples[],
  channels: readonly AudioSamples[],
): AudioSamples[] {
  return expansion.map((samples, index) => {
    const current = channels[index];
    if (current === undefined) return new Float32Array(samples.length);
    const { rms: currentRms, peak: currentPeak } = signalLevel(current);
    const { rms: expandedRms, peak: expandedPeak } = signalLevel(samples);
    const scale = Math.min(
      1,
      expandedRms > 0 ? currentRms / expandedRms : 1,
      expandedPeak > 0 ? currentPeak / expandedPeak : 1,
    );
    if (scale >= 1) return samples;
    const result = new Float32Array(samples.length);
    for (let index = 0; index < samples.length; index++)
      result[index] = (samples[index] ?? 0) * scale;
    return result;
  });
}

export function expandAudio(
  channels: readonly AudioSamples[],
  sampleRate: number,
  history: readonly AudioSamples[] = channels,
): AudioSamples[] {
  if (channels.length === 0 || (channels[0]?.length ?? 0) === 0) return [];
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate <= 0 ||
    channels.some(
      (channel) =>
        channel.length !== channels[0]?.length || !channel.every((value) => Number.isFinite(value)),
    )
  )
    throw new Error(
      `Expected finite matching audio channels and a positive sample rate: sampleRate=${sampleRate}, channels=${channels.length}`,
    );
  // 実音の再生は補間の対応範囲で制限しない。範囲外は従来どおり素の PCM を鳴らす。
  if (sampleRate < 8000 || sampleRate > 96000) return [];
  if ((channels[0]?.length ?? 0) < sampleRate * 0.01) return [];
  // 末尾の振幅は予約側と同じ定数まで下げる。出力側だけ別の値を持たない
  let periodic = concealSamples(
    channels,
    sampleRate,
    AUDIO_EXPANSION_SECONDS,
    AUDIO_PLAYOUT_CONCEAL_END_GAIN,
  );
  const reference =
    history.length === channels.length && (history[0]?.length ?? 0) > (channels[0]?.length ?? 0)
      ? history
      : channels;
  if (periodic.generatedSamples === 0 && reference !== channels)
    periodic = concealSamples(
      reference,
      sampleRate,
      AUDIO_EXPANSION_SECONDS,
      AUDIO_PLAYOUT_CONCEAL_END_GAIN,
    );
  if (periodic.generatedSamples > 0) return constrainLevel(periodic.channels, channels);
  const frames = Math.round(sampleRate * AUDIO_EXPANSION_SECONDS);
  return constrainLevel(
    reference.map((channel, index) => unvoiced(channel, frames, channels[index] ?? channel)),
    channels,
  );
}
