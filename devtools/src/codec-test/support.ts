/**
 * codec テストページの共通ヘルパー
 *
 * 実ブラウザの WebCodecs と Worker を使うため、モックやスタブは一切使わない。
 * テスト用の入力 (canvas 由来の VideoFrame、無音の AudioData) を実際に生成し、
 * 出力 (chunk / frame / AudioData) を実データから要約する。
 */

import type { AudioCodecType } from "../../../src/codec/types.ts";
import { getAudioDecoderConfig, getAudioEncoderConfig } from "../../../src/codec/config.ts";
import type { ObservedAudioData, ObservedEncodedChunk, ObservedVideoFrame } from "./types.ts";

// 映像テストの共通パラメータ
export const VIDEO_WIDTH = 320;
export const VIDEO_HEIGHT = 240;
export const VIDEO_FRAMERATE = 30;
export const VIDEO_BITRATE = 500_000;
// 30fps のフレーム間隔 (マイクロ秒)
export const VIDEO_FRAME_DURATION = Math.round(1_000_000 / VIDEO_FRAMERATE);

// オーディオテストの共通パラメータ
export const AUDIO_SAMPLE_RATE = 48_000;
export const AUDIO_CHANNELS = 2;
export const AUDIO_BITRATE = 64_000;
// Opus の 1 パケットは 20ms のため、100ms 単位で投入する
export const AUDIO_CHUNK_FRAMES = 4_800;
export const AUDIO_CHUNK_COUNT = 10;
// 1 回に投入する AudioData の長さ (マイクロ秒)
export const AUDIO_CHUNK_DURATION = Math.round(
  (AUDIO_CHUNK_FRAMES / AUDIO_SAMPLE_RATE) * 1_000_000,
);

/**
 * 条件が満たされるまでポーリングで待機する
 *
 * WebCodecs の出力は非同期コールバックで届くため、到着をポーリングで待つ。
 * タイムアウト時は観測対象を含む Error を投げ、Playwright 側で失敗として
 * 見えるようにする (テストを skip させない)。
 */
export async function waitForCondition(
  condition: () => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
    }
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 10);
    });
  }
}

/**
 * 出力が到着しないことを一定時間確認する
 *
 * skip されるべき入力 (キーフレーム待ちの delta chunk) のように
 * 「何も起きない」ことを検証する場合に使う。
 */
export async function waitWithoutOutput(durationMs = 200): Promise<void> {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, durationMs);
  });
}

/**
 * 出力が打ち止めになるまで待つ
 *
 * エンコーダーは入力を投入した後に非同期で複数の chunk を出力するため、
 * 「一定時間カウントが増えないこと」を出力完了の条件にする。
 * 1 件も出力されないままの場合はタイムアウトさせる。
 */
export async function waitForQuiet(
  getCount: () => number,
  description: string,
  quietMs = 300,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let lastCount = getCount();
  let lastChangeAt = performance.now();
  while (performance.now() < deadline) {
    await waitWithoutOutput(50);
    const count = getCount();
    if (count !== lastCount) {
      lastCount = count;
      lastChangeAt = performance.now();
      continue;
    }
    if (lastCount > 0 && performance.now() - lastChangeAt >= quietMs) {
      return;
    }
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${description} to settle`);
}

/**
 * テスト用の VideoFrame を生成する
 *
 * 実際にラスタライズされた絵を符号化させるため、単色で塗りつぶした canvas から
 * VideoFrame を作る。timestamp はマイクロ秒で指定する。
 */
export function createTestVideoFrame(
  width: number,
  height: number,
  color: string,
  timestamp: number,
): VideoFrame {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("failed to obtain 2d context for codec test frame");
  }
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  const videoFrame = new VideoFrame(canvas, { timestamp });
  // VideoFrame 生成時にピクセルは取り込まれるため、canvas は使い回さない
  canvas.width = 0;
  canvas.height = 0;
  return videoFrame;
}

/**
 * テスト用の無音 AudioData を生成する
 *
 * opus は可逆圧縮ではないため無音でも非ゼロのサンプルが復号され得る。
 * ここでは実データを持つ入力を作ることだけを目的とする。
 */
export function createSilentAudioData(
  sampleRate: number,
  channels: number,
  numberOfFrames: number,
  timestamp: number,
): AudioData {
  const samples = new Float32Array(numberOfFrames * channels);
  return new AudioData({
    format: "f32-planar",
    sampleRate,
    numberOfFrames,
    numberOfChannels: channels,
    timestamp,
    data: samples,
  });
}

/**
 * エンコーダーの出力 chunk を要約する
 */
export function summarizeEncodedChunk(chunk: {
  data: Uint8Array;
  type: "key" | "delta";
  timestamp: number;
  duration: number | null;
  description?: Uint8Array;
}): ObservedEncodedChunk {
  return {
    type: chunk.type,
    byteLength: chunk.data.byteLength,
    firstByte: chunk.data.byteLength > 0 ? chunk.data[0] : -1,
    timestamp: chunk.timestamp,
    duration: chunk.duration,
    descriptionByteLength: chunk.description ? chunk.description.byteLength : null,
  };
}

/**
 * デコードされた VideoFrame を要約する
 *
 * 読み出し後に frame を閉じるのは呼び出し側の責務とする。
 */
export async function summarizeVideoFrame(frame: VideoFrame): Promise<ObservedVideoFrame> {
  // RGBA へ変換して読み出し、実際に絵が入っていることまで確認する
  const rgba = new Uint8Array(frame.allocationSize({ format: "RGBA" }));
  await frame.copyTo(rgba, { format: "RGBA" });
  let rgbaNonZeroByteCount = 0;
  for (const value of rgba) {
    if (value !== 0) {
      rgbaNonZeroByteCount += 1;
    }
  }
  return {
    codedWidth: frame.codedWidth,
    codedHeight: frame.codedHeight,
    displayWidth: frame.displayWidth,
    displayHeight: frame.displayHeight,
    format: frame.format,
    timestamp: frame.timestamp,
    duration: frame.duration,
    rgbaByteLength: rgba.byteLength,
    rgbaNonZeroByteCount,
    firstPixel: [rgba[0], rgba[1], rgba[2], rgba[3]],
  };
}

/**
 * デコードされた AudioData を要約する
 *
 * 読み出し後に audioData を閉じるのは呼び出し側の責務とする。
 */
export function summarizeAudioData(audioData: AudioData): ObservedAudioData {
  // 第 1 チャンネルを f32-planar で読み出し、実データの有無を確認する
  const sampleByteLength = audioData.allocationSize({ planeIndex: 0, format: "f32-planar" });
  const samples = new Float32Array(sampleByteLength / Float32Array.BYTES_PER_ELEMENT);
  audioData.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
  let nonZeroSampleCount = 0;
  for (const value of samples) {
    if (value !== 0) {
      nonZeroSampleCount += 1;
    }
  }
  return {
    sampleRate: audioData.sampleRate,
    numberOfChannels: audioData.numberOfChannels,
    numberOfFrames: audioData.numberOfFrames,
    format: audioData.format,
    timestamp: audioData.timestamp,
    duration: audioData.duration,
    sampleByteLength,
    nonZeroSampleCount,
  };
}

// 候補はブラウザのビルド依存を避けるため、対応状況を実行時に判定する
const AUDIO_CODEC_CANDIDATES: readonly AudioCodecType[] = ["opus", "aac"];

/**
 * 実ブラウザが encode と decode の双方に対応するオーディオコーデックを選ぶ
 *
 * Chromium のビルドによっては opus / aac の対応状況が異なるため、
 * AudioEncoder.isConfigSupported と AudioDecoder.isConfigSupported の両方で
 * 確認する。どちらも非対応の場合はテストを skip せず Error を投げる。
 */
export async function selectSupportedAudioCodec(): Promise<AudioCodecType> {
  const rejected: string[] = [];
  for (const codec of AUDIO_CODEC_CANDIDATES) {
    const encoderSupport = await AudioEncoder.isConfigSupported(
      getAudioEncoderConfig(codec, AUDIO_BITRATE, AUDIO_SAMPLE_RATE, AUDIO_CHANNELS),
    );
    const decoderSupport = await AudioDecoder.isConfigSupported(
      getAudioDecoderConfig(codec, AUDIO_SAMPLE_RATE, AUDIO_CHANNELS),
    );
    if (encoderSupport.supported && decoderSupport.supported) {
      return codec;
    }
    rejected.push(
      `${codec} (encoder=${String(encoderSupport.supported)}, decoder=${String(decoderSupport.supported)})`,
    );
  }
  throw new Error(`no supported audio codec in this browser: ${rejected.join(", ")}`);
}
