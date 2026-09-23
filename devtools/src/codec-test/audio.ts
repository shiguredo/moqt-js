/**
 * AudioEncoderWrapper / AudioDecoderWrapper の実ブラウザテスト
 *
 * 実際の Chromium の WebCodecs と Worker を使い、状態遷移・Worker メッセージの
 * 往復・入出力の形を観測する。モックやスタブは使わない。
 * コーデックは AudioEncoder.isConfigSupported / AudioDecoder.isConfigSupported の
 * 対応確認に加えて実符号化を 1 件試して選ぶ (符号化できない候補は除外理由つきで
 * 結果に残し、候補が尽きた場合は skip せず Error にする)。
 */

import { AudioDecoderWrapper } from "../../../src/codec/AudioDecoder.ts";
import { AudioEncoderWrapper } from "../../../src/codec/AudioEncoder.ts";
import type { AudioCodecType, EncodedChunkData } from "../../../src/codec/types.ts";
import {
  AUDIO_BITRATE,
  AUDIO_CHANNELS,
  AUDIO_CHUNK_COUNT,
  AUDIO_CHUNK_DURATION,
  AUDIO_CHUNK_FRAMES,
  AUDIO_SAMPLE_RATE,
  createSilentAudioData,
  selectSupportedAudioCodec,
  summarizeAudioData,
  summarizeEncodedChunk,
  waitForCondition,
  waitForQuiet,
} from "./support.ts";
import { readAudioSamples, summarizeAudioLevel } from "../utils/audioLevel.ts";
import { createToneSamples } from "../webcodecs-devtools/utils/dummyAudio.ts";
import type {
  AudioDecoderTestResult,
  AudioEncoderTestResult,
  AudioSamplesTestResult,
  DecoderOperationResult,
  ObservedAudioData,
  ObservedEncodedChunk,
  StateTransition,
  UnconfiguredOperationResult,
} from "./types.ts";

/**
 * 無音の AudioData を 1 秒分 (100ms x 10) 投入する
 *
 * 直接モードでは encode() が AudioData を消費しないためテスト側で閉じる。
 * Worker モードでは transfer で所有権が Worker に移り Worker が閉じる。
 */
function feedSilentAudio(encoder: AudioEncoderWrapper, useWorker: boolean): void {
  for (let index = 0; index < AUDIO_CHUNK_COUNT; index += 1) {
    const audioData = createSilentAudioData(
      AUDIO_SAMPLE_RATE,
      AUDIO_CHANNELS,
      AUDIO_CHUNK_FRAMES,
      index * AUDIO_CHUNK_DURATION,
    );
    encoder.encode(audioData);
    if (!useWorker) {
      audioData.close();
    }
  }
}

/**
 * デコーダーテスト用の参照 chunk を実ブラウザの AudioEncoderWrapper で作る
 *
 * エンコーダーテストと同じ入力 (無音 1 秒) を使い、テストごとに自己完結させる。
 */
async function encodeReferenceAudioChunks(
  useWorker: boolean,
  codec: AudioCodecType,
): Promise<EncodedChunkData[]> {
  const chunks: EncodedChunkData[] = [];
  const errorMessages: string[] = [];

  const encoder = new AudioEncoderWrapper(useWorker, {
    output: (chunk) => {
      chunks.push(chunk);
    },
    error: (error) => {
      errorMessages.push(error.message);
    },
  });

  await encoder.configure(codec, AUDIO_BITRATE, AUDIO_SAMPLE_RATE, AUDIO_CHANNELS);
  feedSilentAudio(encoder, useWorker);

  // 1 秒分の入力に対して複数の chunk が非同期で出力されるため、打ち止めまで待つ
  await waitForQuiet(() => chunks.length, "encoded audio chunks");

  encoder.close();

  if (errorMessages.length > 0) {
    throw new Error(`reference audio encoding failed: ${errorMessages.join(", ")}`);
  }

  return chunks;
}

/**
 * AudioEncoderWrapper の状態遷移と chunk 出力を検証する
 */
export async function runAudioEncoderTest(useWorker: boolean): Promise<AudioEncoderTestResult> {
  const selection = await selectSupportedAudioCodec();
  const codec = selection.codec;
  const observedChunks: ObservedEncodedChunk[] = [];
  const errorMessages: string[] = [];
  const stateHistory: StateTransition[] = [];

  const wrapper = new AudioEncoderWrapper(useWorker, {
    output: (chunk) => {
      observedChunks.push(summarizeEncodedChunk(chunk));
    },
    error: (error) => {
      errorMessages.push(error.message);
    },
  });

  const recordState = (step: string): void => {
    stateHistory.push({ step, state: wrapper.state });
  };

  recordState("initial");

  // 未設定時の encode() は例外を投げず、chunk も error も出さない契約
  const unconfiguredAudioData = createSilentAudioData(
    AUDIO_SAMPLE_RATE,
    AUDIO_CHANNELS,
    AUDIO_CHUNK_FRAMES,
    0,
  );
  const unconfiguredReturnValue = wrapper.encode(unconfiguredAudioData);
  // 未設定時は Wrapper が AudioData を消費しないためテスト側で閉じる
  unconfiguredAudioData.close();
  const unconfiguredEncode: UnconfiguredOperationResult = {
    returnValueType: typeof unconfiguredReturnValue,
    state: wrapper.state,
    outputCount: observedChunks.length,
    errorCount: errorMessages.length,
  };

  recordState("afterUnconfiguredEncode");

  await wrapper.configure(codec, AUDIO_BITRATE, AUDIO_SAMPLE_RATE, AUDIO_CHANNELS);

  recordState("afterConfigure");

  feedSilentAudio(wrapper, useWorker);

  // 1 秒分の入力に対して複数の chunk が非同期で出力されるため、打ち止めまで待つ
  await waitForQuiet(() => observedChunks.length, "encoded audio chunks");

  recordState("afterEncode");

  wrapper.close();

  recordState("afterClose");

  // close() 後の encode() も例外を投げず、chunk も error も出さない契約
  const afterCloseAudioData = createSilentAudioData(
    AUDIO_SAMPLE_RATE,
    AUDIO_CHANNELS,
    AUDIO_CHUNK_FRAMES,
    0,
  );
  const afterCloseReturnValue = wrapper.encode(afterCloseAudioData);
  afterCloseAudioData.close();
  const encodeAfterClose: UnconfiguredOperationResult = {
    returnValueType: typeof afterCloseReturnValue,
    state: wrapper.state,
    outputCount: observedChunks.length,
    errorCount: errorMessages.length,
  };

  return {
    test: useWorker ? "audioEncoderWorker" : "audioEncoderDirect",
    useWorker,
    codec,
    rejectedCodecs: selection.rejectedCodecs,
    sampleRate: AUDIO_SAMPLE_RATE,
    channels: AUDIO_CHANNELS,
    stateHistory,
    unconfiguredEncode,
    chunkCount: observedChunks.length,
    keyChunkCount: observedChunks.filter((chunk) => chunk.type === "key").length,
    chunks: observedChunks,
    totalByteLength: observedChunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    outputTimestamps: observedChunks.map((chunk) => chunk.timestamp),
    encodeAfterClose,
    errorMessages,
  };
}

/**
 * AudioDecoderWrapper の状態遷移と AudioData 出力を検証する
 *
 * 実ブラウザの AudioEncoderWrapper が出した chunk を投入し、
 * 復号された AudioData の形式と実データを確認する。
 */
export async function runAudioDecoderTest(useWorker: boolean): Promise<AudioDecoderTestResult> {
  const selection = await selectSupportedAudioCodec();
  const codec = selection.codec;
  const referenceChunks = await encodeReferenceAudioChunks(useWorker, codec);

  const pendingAudioData: AudioData[] = [];
  const errorMessages: string[] = [];
  let decodedCount = 0;

  const decoder = new AudioDecoderWrapper(useWorker, {
    output: (data) => {
      pendingAudioData.push(data.data);
      decodedCount += 1;
    },
    error: (error) => {
      errorMessages.push(error.message);
    },
  });

  // 読み出しと close をまとめて行う (AudioData を保持し続けない)
  const drainAudioData = (): ObservedAudioData[] => {
    const drained: ObservedAudioData[] = [];
    // 第 2 引数を省略すると start 以降の全要素を削除する
    const audioDataList = pendingAudioData.splice(0);
    for (const audioData of audioDataList) {
      drained.push(summarizeAudioData(audioData));
      audioData.close();
    }
    return drained;
  };

  // 未設定時の decode() は例外を投げず、AudioData も error も出さない契約。
  // 設定済みなら復号される実 chunk を投入し、本当に何も起きないことを見る
  const firstChunk = referenceChunks[0];
  if (firstChunk === undefined) {
    // 参照 chunk は 1 秒分の入力から 1 件以上生成されるため到達しない防御
    throw new Error("reference audio encoding produced no chunk");
  }
  const unconfiguredReturnValue = decoder.decode(
    firstChunk.data,
    firstChunk.type,
    firstChunk.timestamp,
    firstChunk.duration ?? 0,
  );
  const unconfiguredDecode: DecoderOperationResult = {
    returnValueType: typeof unconfiguredReturnValue,
    outputCount: decodedCount,
    errorCount: errorMessages.length,
  };

  // opus は description を必要としないため渡さない (渡すと復号 timestamp が変わる)。
  // AAC の AudioSpecificConfig 経路は Chromium の AAC 符号化が EncodingError になるため
  // e2e では作れない。
  await decoder.configure(codec, AUDIO_SAMPLE_RATE, AUDIO_CHANNELS);

  for (const chunk of referenceChunks) {
    decoder.decode(chunk.data, chunk.type, chunk.timestamp, chunk.duration ?? 0);
  }

  // opus は 1 パケット 1 AudioData で復号されるため、投入数と同数を待つ
  await waitForCondition(
    () => decodedCount >= referenceChunks.length,
    `${referenceChunks.length} decoded audio data`,
  );

  const decoded = drainAudioData();

  decoder.close();

  // close() 後の decode() も例外を投げず、AudioData も error も出さない契約。
  // ここでも設定済みなら復号される実 chunk を投入する
  const afterCloseReturnValue = decoder.decode(
    firstChunk.data,
    firstChunk.type,
    firstChunk.timestamp,
    firstChunk.duration ?? 0,
  );
  const decodeAfterClose: DecoderOperationResult = {
    returnValueType: typeof afterCloseReturnValue,
    outputCount: decodedCount,
    errorCount: errorMessages.length,
  };

  return {
    test: useWorker ? "audioDecoderWorker" : "audioDecoderDirect",
    useWorker,
    codec,
    rejectedCodecs: selection.rejectedCodecs,
    sampleRate: AUDIO_SAMPLE_RATE,
    channels: AUDIO_CHANNELS,
    unconfiguredDecode,
    inputChunkCount: referenceChunks.length,
    decodedCount,
    decoded,
    inputTimestamps: referenceChunks.map((chunk) => chunk.timestamp),
    outputTimestamps: decoded.map((audioData) => audioData.timestamp),
    decodeAfterClose,
    errorMessages,
  };
}

/**
 * 復号済み AudioData から devtools がサンプル列を読み出せることを確認する
 *
 * devtools の可視化は復号結果を直接読んで peak / RMS を求める。`AudioData` は
 * ブラウザ専用 API であり Node の vitest では生成できないため、実ブラウザで
 * 読み出したサンプル数と値域を固定する。
 */
export async function runAudioSamplesTest(): Promise<AudioSamplesTestResult> {
  // ダミー音声と同じトーン (440 Hz、振幅 0.2〜0.3) を使い、値域まで確認できるようにする
  // createToneSamples の戻り値の型は ArrayBufferLike 裏付けの Float32Array であり、
  // AudioDataInit が要求する BufferSource にそのままは渡せないため複製する
  const tone = createToneSamples(AUDIO_SAMPLE_RATE, AUDIO_CHANNELS, AUDIO_CHUNK_FRAMES);
  const samples = new Float32Array(tone.length);
  samples.set(tone);
  // 第 1 チャンネルだけを読む契約を検証できるよう、第 2 チャンネルは無音にする。
  // 全チャンネルが同じ値だと、別のチャンネルを読む実装でも結果が一致してしまう
  for (let frame = 0; frame < AUDIO_CHUNK_FRAMES; frame++) {
    samples[AUDIO_CHUNK_FRAMES + frame] = 0;
  }
  const audioData = new AudioData({
    format: "f32-planar",
    sampleRate: AUDIO_SAMPLE_RATE,
    numberOfFrames: AUDIO_CHUNK_FRAMES,
    numberOfChannels: AUDIO_CHANNELS,
    timestamp: 0,
    data: samples,
  });

  try {
    const read = readAudioSamples(audioData);
    const level = summarizeAudioLevel(read);
    // 防御的な初期化 (現在の入力は常に正負の値を含むため、0 始まりでも結果は同じ)
    let minSample = Number.POSITIVE_INFINITY;
    let maxSample = Number.NEGATIVE_INFINITY;
    for (const value of read) {
      if (value < minSample) {
        minSample = value;
      }
      if (value > maxSample) {
        maxSample = value;
      }
    }
    // 第 2 チャンネルは無音にしてあるため、読み出しが第 1 チャンネルに限定されて
    // いれば 0 になる
    const secondChannel = new Float32Array(AUDIO_CHUNK_FRAMES);
    audioData.copyTo(secondChannel, { planeIndex: 1, format: "f32-planar" });
    let secondChannelPeak = 0;
    for (const value of secondChannel) {
      const magnitude = Math.abs(value);
      if (magnitude > secondChannelPeak) {
        secondChannelPeak = magnitude;
      }
    }

    return {
      test: "audioSamples",
      sampleRate: audioData.sampleRate,
      numberOfChannels: audioData.numberOfChannels,
      numberOfFrames: audioData.numberOfFrames,
      sampleCount: read.length,
      peakDbfs: level.peakDbfs,
      rmsDbfs: level.rmsDbfs,
      minSample,
      maxSample,
      secondChannelPeak,
    };
  } finally {
    // 読み出し後に閉じるのは呼び出し側の責務 (readAudioSamples は閉じない)
    audioData.close();
  }
}
