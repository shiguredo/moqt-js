/**
 * 符号化へ渡す音声の、棄却で飛んだ境目をフェードで繋ぐ
 *
 * 配信側は追いつきのために 8 ms のフレームを捨てる。Opus のパケットは 20 ms であり、
 * パケットの途中で捨てると符号化器へ渡る波形が飛ぶため、1 回ごとにクリックとして聞こえる
 * (実測: 負荷時に 18.5 秒で 218 回 = 毎秒約 12 回)。捨てる直前のフレームの末尾と、捨てた
 * 直後のフレームの先頭を 0 へ落とし、繋ぎ目を滑らかにする
 *
 * 呼び出し側は符号化へ渡すフレームを 1 つ保持し、次のフレームの判定が「捨てる」なら保持して
 * いるフレームの末尾を、判定が「捨てる」の直後なら先頭を、落としてから符号化へ渡す。
 * 先読みの分だけ符号化が 1 フレーム遅れる (8 ms)
 */

import type { AudioSamples } from "./playout/audioTimeStretch";

/** 落とす長さ (ミリ秒)。8 ms のフレームの半分より短くし、音を削りすぎない */
export const AUDIO_SPLICE_FADE_MS = 2;

/** 落とす端 */
export type AudioSpliceEdge = "head" | "tail";

/**
 * 短い隙間を、直前の末尾から次の先頭への直線で繋ぐ。
 * 周期性のない子音にも使える。長い欠落の復元には使わず、呼び出し側が長さを制限する。
 */
export function interpolateSpliceGap(
  previous: readonly AudioSamples[],
  next: readonly AudioSamples[],
  frames: number,
): AudioSamples[] {
  return next.map((channel, channelIndex) => {
    const from = previous[channelIndex]?.at(-1) ?? 0;
    const to = channel[0] ?? 0;
    return Float32Array.from(
      { length: frames },
      (_, index) => from + (to - from) * ((index + 1) / (frames + 1)),
    );
  });
}

/**
 * 補間の続きから実音の先頭へ移る。両方を 0 へ落とす方式と違い、同じ波形なら音量を保つ。
 * 補間の続きは実音の開始位置に対応するサンプル列であり、遅延や再生する長さは増やさない。
 * 入力配列の所有権は呼び出し側に残す。
 */
export function crossFadeHead(
  continuation: readonly AudioSamples[],
  channels: readonly AudioSamples[],
  sampleRate: number,
): AudioSamples[] {
  const fadeSamples = Math.min(
    channels[0]?.length ?? 0,
    continuation[0]?.length ?? 0,
    Math.max(1, Math.round((AUDIO_SPLICE_FADE_MS / 1000) * sampleRate)),
  );
  return channels.map((channel, channelIndex) => {
    const output = new Float32Array(channel);
    const previous = continuation[channelIndex];
    if (previous === undefined) return output;
    for (let index = 0; index < fadeSamples; index++) {
      const weight = index / fadeSamples;
      output[index] = (previous[index] ?? 0) * (1 - weight) + (channel[index] ?? 0) * weight;
    }
    return output;
  });
}

/**
 * 周期補間の先頭に、直前の音の変化幅を超える段差がある場合だけ接続を滑らかにする。
 * 通常の波形へ毎回フェードを掛けず、既存の 2 ms 以内で補間波形へ戻す。
 */
export function smoothSpliceHead(
  previous: readonly AudioSamples[],
  channels: readonly AudioSamples[],
  sampleRate: number,
): AudioSamples[] {
  return channels.map((channel, channelIndex) => {
    const history = previous[channelIndex];
    if (history === undefined || history.length === 0 || channel.length === 0) return channel;
    let naturalStep = 0;
    for (let index = 1; index < history.length; index++) {
      naturalStep = Math.max(
        naturalStep,
        Math.abs((history[index] ?? 0) - (history[index - 1] ?? 0)),
      );
    }
    const tail = history[history.length - 1] ?? 0;
    if (Math.abs((channel[0] ?? 0) - tail) <= naturalStep) return channel;
    const continuation = new Float32Array(channel.length).fill(tail);
    return crossFadeHead([continuation], [channel], sampleRate)[0] ?? channel;
  });
}

/**
 * 端を線形に 0 へ落とす (落とす長さの外は元のまま)
 *
 * 元の配列は変えず、新しい配列を返す。端のサンプルは 0 になり、落とす長さだけ離れた
 * サンプルは元の値のままである
 *
 * @param channels - チャンネルごとの音声 (すべて同じ長さ)
 * @param sampleRate - サンプルレート (Hz)
 * @param edge - 落とす端 (`head` は先頭、`tail` は末尾)
 * @returns フェードした音声 (チャンネルごと)
 */
export function fadeSpliceEdge(
  channels: readonly AudioSamples[],
  sampleRate: number,
  edge: AudioSpliceEdge,
): AudioSamples[] {
  const length = channels[0]?.length ?? 0;
  if (length === 0) {
    return [...channels];
  }
  const fadeSamples = Math.min(
    length,
    Math.max(1, Math.round((AUDIO_SPLICE_FADE_MS / 1_000) * sampleRate)),
  );
  const output: AudioSamples[] = [];
  for (const channel of channels) {
    const samples = new Float32Array(channel.length);
    samples.set(channel);
    for (let index = 0; index < fadeSamples; index++) {
      // 0 から 1 へ戻る係数。端は 0、落とす長さだけ離れた位置は元の値になる
      const gain = index / fadeSamples;
      const position = edge === "head" ? index : channel.length - 1 - index;
      samples[position] = (channel[position] ?? 0) * gain;
    }
    output.push(samples);
  }
  return output;
}

/**
 * チャンネルごとの音声をフェードしてから 1 つのバッファへ戻す
 *
 * `fadeSpliceEdge` はチャンネルごとの配列を扱うが、符号化へ渡す `AudioData` は
 * `f32-planar` の並び (チャンネルごとに連結した 1 つのバッファ) を取る。その変換と
 * フェードをまとめて行う
 *
 * @param planes - チャンネルごとの音声 (すべて同じ長さ)
 * @param sampleRate - サンプルレート (Hz)
 * @param edges - 落とす端 (`head` / `tail`)。省略した端は落とさない
 * @returns `f32-planar` の並びのバッファ (`AudioData` へ渡せる型)
 */
export function mergeFadedPlanes(
  planes: readonly AudioSamples[],
  sampleRate: number,
  edges: { head?: boolean; tail?: boolean },
): Float32Array<ArrayBuffer> {
  const length = planes[0]?.length ?? 0;
  let faded = [...planes];
  if (edges.head === true) {
    faded = fadeSpliceEdge(faded, sampleRate, "head");
  }
  if (edges.tail === true) {
    faded = fadeSpliceEdge(faded, sampleRate, "tail");
  }
  const merged = new Float32Array(length * faded.length);
  for (const [index, plane] of faded.entries()) {
    merged.set(plane, index * length);
  }
  return merged;
}
