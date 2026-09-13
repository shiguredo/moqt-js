/**
 * VideoEncoderWrapper / VideoDecoderWrapper の実ブラウザテスト
 *
 * 実際の Chromium の WebCodecs と Worker を使い、状態遷移・Worker メッセージの
 * 往復・入出力の形を観測する。モックやスタブは使わない。
 */

import { VideoDecoderWrapper } from "../../../src/codec/VideoDecoder.ts";
import { VideoEncoderWrapper } from "../../../src/codec/VideoEncoder.ts";
import type { EncodedChunkData } from "../../../src/codec/types.ts";
import {
  VIDEO_BITRATE,
  VIDEO_FRAME_DURATION,
  VIDEO_FRAMERATE,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
  createTestVideoFrame,
  summarizeEncodedChunk,
  summarizeVideoFrame,
  waitForCondition,
  waitWithoutOutput,
} from "./support.ts";
import type {
  DecoderOperationResult,
  ObservedEncodedChunk,
  ObservedVideoFrame,
  StateTransition,
  UnconfiguredOperationResult,
  VideoDecoderTestResult,
  VideoEncoderTestResult,
} from "./types.ts";

// フレームごとに異なる色で塗り、符号化対象が単調にならないようにする
const FRAME_COLORS = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff"] as const;

// エンコードするフレーム数 (先頭と index 3 の 2 件を keyFrame: true にする)
const ENCODE_FRAME_COUNT = 6;

// keyFrame: true を明示する 2 つ目のフレームの位置 (0 始まり)
const FORCED_KEY_FRAME_INDEX = 3;

// デコーダーテストで使う参照 chunk の数 (key 1 件 + delta 2 件)
const REFERENCE_FRAME_COUNT = 3;

/**
 * VideoEncoderWrapper の状態遷移と chunk 出力を検証する
 *
 * useWorker が true の場合は Worker 経由の往復 (init → configured → encoded)、
 * false の場合は直接モードの VideoEncoder を対象にする。
 */
export async function runVideoEncoderTest(useWorker: boolean): Promise<VideoEncoderTestResult> {
  const observedChunks: ObservedEncodedChunk[] = [];
  const errorMessages: string[] = [];
  const stateHistory: StateTransition[] = [];

  const wrapper = new VideoEncoderWrapper(useWorker, {
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
  const unconfiguredEncodeQueueSize = wrapper.encodeQueueSize;
  const unconfiguredFrame = createTestVideoFrame(VIDEO_WIDTH, VIDEO_HEIGHT, "#ff0000", 0);
  const unconfiguredReturnValue = wrapper.encode(unconfiguredFrame, { keyFrame: true });
  // 未設定時は Wrapper が frame を消費しないためテスト側で閉じる
  unconfiguredFrame.close();
  const unconfiguredEncode: UnconfiguredOperationResult = {
    returnValueType: typeof unconfiguredReturnValue,
    state: wrapper.state,
    outputCount: observedChunks.length,
    errorCount: errorMessages.length,
  };

  recordState("afterUnconfiguredEncode");

  // Worker モードでは init メッセージの往復が完了するまで resolve しない
  await wrapper.configure("vp8", VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_BITRATE, VIDEO_FRAMERATE);

  recordState("afterConfigure");

  const queueSizeAfterConfigure = wrapper.encodeQueueSize;

  for (let index = 0; index < ENCODE_FRAME_COUNT; index += 1) {
    const keyFrame = index === 0 || index === FORCED_KEY_FRAME_INDEX;
    const frame = createTestVideoFrame(
      VIDEO_WIDTH,
      VIDEO_HEIGHT,
      FRAME_COLORS[index % FRAME_COLORS.length],
      index * VIDEO_FRAME_DURATION,
    );
    wrapper.encode(frame, { keyFrame });
    if (!useWorker) {
      // 直接モードでは encode() が frame を消費しないためテスト側で閉じる。
      // Worker モードでは transfer で所有権が Worker に移り Worker が閉じる
      frame.close();
    }
  }

  // 出力待機の前なので、直接モードでは投入したフレーム数がそのまま残る
  const queueSizeAfterEncode = wrapper.encodeQueueSize;

  await waitForCondition(
    () => observedChunks.length >= ENCODE_FRAME_COUNT,
    `${ENCODE_FRAME_COUNT} encoded video chunks`,
  );

  recordState("afterEncode");

  const forcedKeyFrameChunk = observedChunks[FORCED_KEY_FRAME_INDEX];

  wrapper.close();

  recordState("afterClose");

  // close() 後の encode() も例外を投げず、chunk も error も出さない契約
  const afterCloseFrame = createTestVideoFrame(VIDEO_WIDTH, VIDEO_HEIGHT, "#000000", 0);
  const afterCloseReturnValue = wrapper.encode(afterCloseFrame, { keyFrame: true });
  afterCloseFrame.close();
  const encodeAfterClose: UnconfiguredOperationResult = {
    returnValueType: typeof afterCloseReturnValue,
    state: wrapper.state,
    outputCount: observedChunks.length,
    errorCount: errorMessages.length,
  };

  return {
    test: useWorker ? "videoEncoderWorker" : "videoEncoderDirect",
    useWorker,
    stateHistory,
    unconfiguredEncode,
    unconfiguredEncodeQueueSize,
    queueSizeAfterConfigure,
    queueSizeAfterEncode,
    queueSizeIsNonNegativeInteger:
      Number.isInteger(queueSizeAfterEncode) && queueSizeAfterEncode >= 0,
    chunkCount: observedChunks.length,
    keyChunkCount: observedChunks.filter((chunk) => chunk.type === "key").length,
    chunks: observedChunks,
    forcedKeyFrameChunkType: forcedKeyFrameChunk ? forcedKeyFrameChunk.type : null,
    outputTimestamps: observedChunks.map((chunk) => chunk.timestamp),
    encodeAfterClose,
    errorMessages,
  };
}

/**
 * デコーダーテスト用の参照 chunk を直接モードの VideoEncoderWrapper で作る
 *
 * 実ブラウザの encoder が出した key chunk と delta chunk をそのまま
 * デコーダーへ投入するため、テストごとに自己完結して生成する。
 */
async function encodeReferenceChunks(): Promise<EncodedChunkData[]> {
  const chunks: EncodedChunkData[] = [];
  const errorMessages: string[] = [];

  const encoder = new VideoEncoderWrapper(false, {
    output: (chunk) => {
      chunks.push(chunk);
    },
    error: (error) => {
      errorMessages.push(error.message);
    },
  });

  await encoder.configure("vp8", VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_BITRATE, VIDEO_FRAMERATE);

  for (let index = 0; index < REFERENCE_FRAME_COUNT; index += 1) {
    const frame = createTestVideoFrame(
      VIDEO_WIDTH,
      VIDEO_HEIGHT,
      FRAME_COLORS[index % FRAME_COLORS.length],
      index * VIDEO_FRAME_DURATION,
    );
    encoder.encode(frame, { keyFrame: index === 0 });
    frame.close();
  }

  await waitForCondition(
    () => chunks.length >= REFERENCE_FRAME_COUNT,
    `${REFERENCE_FRAME_COUNT} reference video chunks`,
  );

  encoder.close();

  if (errorMessages.length > 0) {
    throw new Error(`reference video encoding failed: ${errorMessages.join(", ")}`);
  }

  return chunks;
}

/**
 * VideoDecoderWrapper のキーフレーム待ち・復号結果・resetKeyframeWait を検証する
 *
 * useWorker が true の場合は Worker 経由の往復 (init → configured → decoded)、
 * false の場合は直接モードの VideoDecoder を対象にする。
 */
export async function runVideoDecoderTest(useWorker: boolean): Promise<VideoDecoderTestResult> {
  const referenceChunks = await encodeReferenceChunks();
  const keyChunk = referenceChunks[0];
  const deltaChunks = referenceChunks.slice(1);
  if (!keyChunk) {
    throw new Error("reference video encoding produced no key chunk");
  }

  const pendingFrames: VideoFrame[] = [];
  const errorMessages: string[] = [];
  let frameCount = 0;

  const decoder = new VideoDecoderWrapper(useWorker, {
    output: (data) => {
      pendingFrames.push(data.frame);
      frameCount += 1;
    },
    error: (error) => {
      errorMessages.push(error.message);
    },
  });

  // 読み出しと close をまとめて行う (VideoFrame を保持し続けない)
  const drainFrames = async (): Promise<ObservedVideoFrame[]> => {
    const drained: ObservedVideoFrame[] = [];
    const frames = pendingFrames.splice(0, pendingFrames.length);
    for (const frame of frames) {
      drained.push(await summarizeVideoFrame(frame));
      frame.close();
    }
    return drained;
  };

  // 未設定時の decode() は例外を投げず、frame も error も出さない契約。
  // 設定済みなら復号される実 chunk を投入し、本当に何も起きないことを見る
  const unconfiguredReturnValue = decoder.decode(
    keyChunk.data,
    keyChunk.type,
    keyChunk.timestamp,
    VIDEO_FRAME_DURATION,
  );
  const unconfiguredDecode: DecoderOperationResult = {
    returnValueType: typeof unconfiguredReturnValue,
    outputCount: frameCount,
    errorCount: errorMessages.length,
  };

  // vp8 は description を持たないため undefined になり得る
  await decoder.configure("vp8", VIDEO_WIDTH, VIDEO_HEIGHT, keyChunk.description);

  // configure 直後はキーフレーム待ちであり、delta chunk は出力を生まない
  decoder.decode(
    deltaChunks[0].data,
    deltaChunks[0].type,
    deltaChunks[0].timestamp,
    VIDEO_FRAME_DURATION,
  );
  await waitWithoutOutput(200);
  const framesAfterDeltaBeforeKey = frameCount;

  // キーフレームを投入すると復号が始まる
  decoder.decode(keyChunk.data, keyChunk.type, keyChunk.timestamp, VIDEO_FRAME_DURATION);
  for (const deltaChunk of deltaChunks) {
    decoder.decode(deltaChunk.data, deltaChunk.type, deltaChunk.timestamp, VIDEO_FRAME_DURATION);
  }

  await waitForCondition(
    () => frameCount >= referenceChunks.length,
    `${referenceChunks.length} decoded video frames`,
  );

  const frames = await drainFrames();

  // resetKeyframeWait() はキーフレーム待ちへ戻す契約。
  // Worker モードでは resetKeyframeWait メッセージの往復になる
  decoder.resetKeyframeWait();
  decoder.decode(
    deltaChunks[0].data,
    deltaChunks[0].type,
    deltaChunks[0].timestamp,
    VIDEO_FRAME_DURATION,
  );
  await waitWithoutOutput(200);
  const framesAfterResetKeyframeWaitDelta = frameCount;

  // キーフレームを再投入すると復号が再開する
  decoder.decode(keyChunk.data, keyChunk.type, keyChunk.timestamp, VIDEO_FRAME_DURATION);
  await waitForCondition(
    () => frameCount > framesAfterResetKeyframeWaitDelta,
    "decoded video frame after resetKeyframeWait",
  );
  const resumedFrames = await drainFrames();

  decoder.close();

  // close() 後の decode() も例外を投げず、frame も error も出さない契約。
  // ここでも設定済みなら復号される実 chunk を投入する
  const afterCloseReturnValue = decoder.decode(
    keyChunk.data,
    keyChunk.type,
    keyChunk.timestamp,
    VIDEO_FRAME_DURATION,
  );
  const decodeAfterClose: DecoderOperationResult = {
    returnValueType: typeof afterCloseReturnValue,
    outputCount: frameCount,
    errorCount: errorMessages.length,
  };

  return {
    test: useWorker ? "videoDecoderWorker" : "videoDecoderDirect",
    useWorker,
    unconfiguredDecode,
    descriptionByteLength: keyChunk.description ? keyChunk.description.byteLength : null,
    inputChunkCount: referenceChunks.length,
    framesAfterDeltaBeforeKey,
    frameCount,
    frames,
    frameTimestamps: frames.map((frame) => frame.timestamp),
    framesAfterResetKeyframeWaitDelta,
    resumedAfterResetKeyframeWait: resumedFrames.length > 0,
    decodeAfterClose,
    errorMessages,
  };
}
