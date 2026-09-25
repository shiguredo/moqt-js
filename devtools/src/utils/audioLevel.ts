import type { LOC } from "moqt-js";

/**
 * 復号信号の下限 (dBFS)
 *
 * 無音の peak / RMS は数学上 `-Infinity` (振幅 0) や `NaN` (空のサンプル列) になる。
 * そのまま表示や統計に流すと壊れるため、有限の下限に丸める。
 */
export const MIN_DBFS = -100;

/** 波形として保持する長さ (ミリ秒) */
const WAVEFORM_WINDOW_MS = 100;

/** 復号信号の上限 (dBFS)。振幅 1.0 が 0 dBFS */
export const MAX_DBFS = 0;

/**
 * 値が無いときの表示
 *
 * 無音 (-100 dBFS) や 0 (0 dBov) と区別する。メーターの見出し行は値の幅を文字数で
 * 固定しており、値が無いときも同じ幅の欄にこの文字列を出す。
 */
export const INACTIVE_TEXT = "-";

/** 復号信号のレベル (dBFS) */
interface DecodedAudioLevel {
  /** 最大振幅を dBFS にしたもの */
  peakDbfs: number;
  /** 二乗平均平方根を dBFS にしたもの */
  rmsDbfs: number;
}

/**
 * 復号した `AudioData` から第 1 チャンネルのサンプル列を読み出す
 *
 * `devtools/src/codec-test/support.ts` の `summarizeAudioData` と同じ手順
 * (`allocationSize` + `copyTo` の `format: "f32-planar"`) で読み出す。
 * `AudioData` はブラウザ専用 API であり Node の vitest では生成できないため、
 * この関数の検証は実ブラウザ (codec-test ページ) で行う。
 *
 * `AudioData` の所有者は呼び出し側のままであり、本関数は `close()` しない。
 */
export function readAudioSamples(audioData: AudioData): Float32Array {
  const byteLength = audioData.allocationSize({ planeIndex: 0, format: "f32-planar" });
  const samples = new Float32Array(byteLength / Float32Array.BYTES_PER_ELEMENT);
  audioData.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
  return samples;
}

/**
 * `AudioData` の全チャンネルのサンプルを f32-planar で読み出す
 *
 * LOC Audio Level は符号化するサンプル全体の RMS で求める (RFC 6464 Section 3)。
 * `readAudioSamples` は波形の表示のために第 1 チャンネルだけを読むため、別に用意する。
 * `AudioData` の所有者は呼び出し側のままであり、本関数は `close()` しない。
 */
export function readAllAudioSamples(audioData: AudioData): Float32Array {
  const frames = audioData.numberOfFrames;
  const samples = new Float32Array(frames * audioData.numberOfChannels);
  for (let channel = 0; channel < audioData.numberOfChannels; channel++) {
    audioData.copyTo(samples.subarray(channel * frames, (channel + 1) * frames), {
      planeIndex: channel,
      format: "f32-planar",
    });
  }
  return samples;
}

/**
 * サンプル列から peak と RMS を dBFS で求める純関数
 *
 * 0 dBFS が最大 (振幅 1.0) で、値が小さいほど静かである。無音と空のサンプル列は
 * 下限 `MIN_DBFS` に丸める。
 */
export function summarizeAudioLevel(samples: Float32Array): DecodedAudioLevel {
  if (samples.length === 0) {
    return { peakDbfs: MIN_DBFS, rmsDbfs: MIN_DBFS };
  }

  let peak = 0;
  let sumOfSquares = 0;
  for (const value of samples) {
    const magnitude = Math.abs(value);
    if (magnitude > peak) {
      peak = magnitude;
    }
    sumOfSquares += value * value;
  }

  return {
    peakDbfs: toDbfs(peak),
    rmsDbfs: toDbfs(Math.sqrt(sumOfSquares / samples.length)),
  };
}

/**
 * 波形として保持するサンプル数を求める
 *
 * @param sampleRate - サンプルレート (Hz)
 */
export function waveformSampleCount(sampleRate: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    // NaN をそのまま返すと appendWaveform の上限判定が常に false になり、
    // 波形の配列が際限なく伸びる
    return 1;
  }
  return Math.max(1, Math.round((sampleRate * WAVEFORM_WINDOW_MS) / 1000));
}

/**
 * 直近のサンプル列を保持する純関数
 *
 * 古いサンプルから捨て、`maxSamples` を超えない配列を返す。戻り値は常に新しい配列
 * であり、呼び出し元が渡した配列とは共有しない。
 *
 * @param previous - 直前まで保持していたサンプル列 (無ければ null)
 * @param samples - 今回追加するサンプル列
 * @param maxSamples - 保持する最大サンプル数
 */
export function appendWaveform(
  previous: Float32Array | null,
  samples: Float32Array,
  maxSamples: number,
): Float32Array {
  if (maxSamples <= 0) {
    return new Float32Array(0);
  }

  // 今回のサンプルだけで上限を超える場合は、直近の maxSamples だけを残す
  const appended =
    samples.length > maxSamples ? samples.subarray(samples.length - maxSamples) : samples;
  const kept = previous ?? new Float32Array(0);
  const keepPrevious = Math.max(0, maxSamples - appended.length);
  const previousPart =
    kept.length > keepPrevious ? kept.subarray(kept.length - keepPrevious) : kept;

  const merged = new Float32Array(previousPart.length + appended.length);
  merged.set(previousPart, 0);
  merged.set(appended, previousPart.length);
  return merged;
}

/**
 * LOC Audio Level (dBov) を表示用の文字列にする
 *
 * draft-ietf-moq-loc-04 §2.3.3.2 の値は RFC 6464 §3 の -dBov であり、0 が最大音量、
 * 127 がデジタル無音を表す。載っていない object では `null` が渡る。
 * voice activity は `formatVoiceActivity` で別に表示する (同じ値を 2 度出さない)。
 *
 * Audio Level が載っていない object を受けた状態は `not reported` (12 文字) と出す。
 * 値が無い状態 (まだ購読していない、音声を送っていない) は `INACTIVE_TEXT` と区別する。
 * 数値は `-127` の幅に左を空白で埋め、`dBov` の位置を固定する。
 */
const LEVEL_NUMBER_WIDTH = 4;

export function formatAudioLevel(level: LOC.AudioLevel | null): string {
  if (level === null) {
    return "not reported";
  }
  return `${String(-level.level).padStart(LEVEL_NUMBER_WIDTH)} dBov`;
}

/**
 * LOC Audio Level の voice activity (RFC 6464 §3 の V ビット) を表示用にする
 *
 * `voice` のラベルは呼び出し側が別に出すため、値だけを返す。
 * `on` は末尾を空白にして `off` と同じ 3 文字にし、切り替わっても幅が変わらないようにする。
 * Audio Level が載っていない object には V ビットも無いため、同じ状態を 2 度出さないよう
 * `formatAudioLevel` の `not reported` ではなく `INACTIVE_TEXT` にする。
 */
export function formatVoiceActivity(level: LOC.AudioLevel | null): string {
  if (level === null) {
    return INACTIVE_TEXT;
  }
  return level.voiceActivity ? "on " : "off";
}

/**
 * dBFS の数値を表示用の文字列にする
 *
 * 値が無い間 (音を受けているが、まだ復号していないなど) は `INACTIVE_TEXT` にする。
 * 数値があるときは `-100.0` の幅に左を空白で埋め、小数点と `dBFS` の位置を固定する。
 * 左揃えのまま桁が減ると、単位ごと右の項目が動いて見える。
 */
const DBFS_NUMBER_WIDTH = 6;

export function formatDbfs(value: number | null): string {
  if (value === null) {
    return INACTIVE_TEXT;
  }
  return `${value.toFixed(1).padStart(DBFS_NUMBER_WIDTH)} dBFS`;
}

// 振幅を dBFS へ換算する。0 と負の値は下限 (無音)、正の無限大は 0 dBFS に丸める
// (-Infinity / NaN をそのまま流さない)
function toDbfs(value: number): number {
  if (value === Number.POSITIVE_INFINITY) {
    return MAX_DBFS;
  }
  if (!Number.isFinite(value) || value <= 0) {
    return MIN_DBFS;
  }
  const dbfs = 20 * Math.log10(value);
  return Math.max(MIN_DBFS, Math.min(MAX_DBFS, dbfs));
}
