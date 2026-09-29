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
  selectUnsupportedVideoCodec,
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
  VideoDecoderCloseDuringConfigureTestResult,
  VideoDecoderConcurrentResetTestResult,
  VideoDecoderResetBudgetTestResult,
  VideoDecoderRestoreTestResult,
  VideoDecoderTestResult,
  VideoDecoderUnsupportedCodecTestResult,
  VideoEncoderReconfigureTestResult,
  VideoEncoderTestResult,
} from "./types.ts";

// フレームごとに異なる色で塗り、符号化対象が単調にならないようにする
const FRAME_COLORS = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff"] as const;

/**
 * フレーム番号に対応する塗りつぶし色を返す
 *
 * FRAME_COLORS を使い切ったら先頭へ戻る。noUncheckedIndexedAccess により
 * 添字アクセスの結果は undefined になり得るため、値を取り出す箇所をここに集約する。
 */
function pickFrameColor(frameIndex: number): string {
  const color = FRAME_COLORS[frameIndex % FRAME_COLORS.length];
  if (color === undefined) {
    // frameIndex は 0 以上でのみ呼ばれるため、ここでのガードは到達しない防御
    throw new Error(`no frame color for index ${String(frameIndex)}`);
  }
  return color;
}

// エンコードするフレーム数 (先頭と index 3 の 2 件を keyFrame: true にする)
const ENCODE_FRAME_COUNT = 6;

// keyFrame: true を明示する 2 つ目のフレームの位置 (0 始まり)
const FORCED_KEY_FRAME_INDEX = 3;

// デコーダーテストで使う参照 chunk の数 (key 1 件 + delta 2 件)
const REFERENCE_FRAME_COUNT = 3;

// 再 configure テストで 1 つの設定あたりに投入するフレーム数
const RECONFIGURE_FRAME_COUNT = 2;

// 再 configure テストで 1 回目に使う解像度 (2 回目は VIDEO_WIDTH / VIDEO_HEIGHT)
const RECONFIGURE_FIRST_WIDTH = 160;
const RECONFIGURE_FIRST_HEIGHT = 120;

// 復帰予算の上限 (同じ config で復号フレームを得ないまま再初期化できる回数)。
// 値は DecoderResetBudget の契約であり、Node の単体テストが上限そのものを固定する。
// ここでは実ブラウザの配線がその上限で打ち切られることを固定する
const RESET_BUDGET_LIMIT = 3;

// 予算の復帰条件のテストで 2 回目に configure する解像度。
// configure は毎回新しい config オブジェクトを作るため同じ解像度でも参照は変わるが、
// 設定そのものが変わったことを結果から読み取れるように解像度も変える
const RESTORE_SECOND_WIDTH = 160;
const RESTORE_SECOND_HEIGHT = 120;

// 予算を使い切って打ち切った後に decode() を呼ぶ回数。
// 未構成の警告が呼び出しのたびに出ないことを e2e が数えるために複数回呼ぶ
const DECODE_ATTEMPTS_AFTER_BUDGET_EXHAUSTED = 3;

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
      pickFrameColor(index),
      index * VIDEO_FRAME_DURATION,
    );
    wrapper.encode(frame, { keyFrame });
    if (!useWorker) {
      // 直接モードでは encode() が frame を消費しないためテスト側で閉じる。
      // Worker モードでは transfer で所有権が Worker に移り Worker が閉じる
      frame.close();
    }
  }

  // 出力待機の前なので、両モードとも投入したフレーム数が残る
  // (直接モードは実キュー長、Worker モードは未応答の送信数)
  const queueSizeAfterEncode = wrapper.encodeQueueSize;

  await waitForCondition(
    () => observedChunks.length >= ENCODE_FRAME_COUNT,
    `${ENCODE_FRAME_COUNT} encoded video chunks`,
  );

  recordState("afterEncode");

  // 出力を待った後のキューは空になる (Worker モードは encoded 応答ごとに減る)
  const queueSizeAfterOutputWait = wrapper.encodeQueueSize;

  const forcedKeyFrameChunk = observedChunks[FORCED_KEY_FRAME_INDEX];

  // close() 時点で送信中のフレームが残っていても 0 に戻ることを観測する。
  // 出力を待たずに encode してから close する (Worker モードでは encoded 応答が返らない分が残る)。
  // 後続の chunk 数の判定がぶれないよう、ここまでの観測を確定させる
  const chunkCountBeforeClose = observedChunks.length;
  const chunksBeforeClose = observedChunks.slice();
  for (let index = 0; index < ENCODE_FRAME_COUNT; index += 1) {
    const frame = createTestVideoFrame(
      VIDEO_WIDTH,
      VIDEO_HEIGHT,
      pickFrameColor(index),
      index * VIDEO_FRAME_DURATION,
    );
    wrapper.encode(frame, { keyFrame: false });
    if (!useWorker) {
      frame.close();
    }
  }
  const queueSizeBeforeClose = wrapper.encodeQueueSize;

  wrapper.close();

  const queueSizeAfterClose = wrapper.encodeQueueSize;

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
    queueSizeAfterOutputWait,
    queueSizeBeforeClose,
    queueSizeAfterClose,
    queueSizeIsNonNegativeInteger:
      Number.isInteger(queueSizeAfterEncode) &&
      queueSizeAfterEncode >= 0 &&
      Number.isInteger(queueSizeAfterOutputWait) &&
      queueSizeAfterOutputWait >= 0,
    chunkCount: chunkCountBeforeClose,
    keyChunkCount: chunksBeforeClose.filter((chunk) => chunk.type === "key").length,
    chunks: chunksBeforeClose,
    forcedKeyFrameChunkType: forcedKeyFrameChunk ? forcedKeyFrameChunk.type : null,
    outputTimestamps: chunksBeforeClose.map((chunk) => chunk.timestamp),
    encodeAfterClose,
    errorMessages,
  };
}

/**
 * VideoEncoderWrapper の再 configure テスト
 *
 * 同じ Wrapper に対して解像度を変えて configure() を 2 回呼び、
 * 旧コーデックを閉じて差し替えたうえで encode が継続することを確認する。
 * 直接モードは旧 VideoEncoder の close() を通り、Worker モードは
 * 旧 Worker の破棄と新しい Worker の init を通る。
 */
export async function runVideoEncoderReconfigureTest(
  useWorker: boolean,
): Promise<VideoEncoderReconfigureTestResult> {
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

  const encodeFrames = (width: number, height: number, timestampOffset: number): void => {
    for (let index = 0; index < RECONFIGURE_FRAME_COUNT; index += 1) {
      const frame = createTestVideoFrame(
        width,
        height,
        pickFrameColor(index),
        timestampOffset + index * VIDEO_FRAME_DURATION,
      );
      wrapper.encode(frame, { keyFrame: index === 0 });
      if (!useWorker) {
        // 直接モードでは encode() が frame を消費しないためテスト側で閉じる
        frame.close();
      }
    }
  };

  recordState("initial");

  await wrapper.configure(
    "vp8",
    RECONFIGURE_FIRST_WIDTH,
    RECONFIGURE_FIRST_HEIGHT,
    VIDEO_BITRATE,
    VIDEO_FRAMERATE,
  );
  recordState("afterFirstConfigure");

  encodeFrames(RECONFIGURE_FIRST_WIDTH, RECONFIGURE_FIRST_HEIGHT, 0);
  await waitForCondition(
    () => observedChunks.length >= RECONFIGURE_FRAME_COUNT,
    `${RECONFIGURE_FRAME_COUNT} encoded video chunks for the first configure`,
  );
  const firstConfigChunkCount = observedChunks.length;

  // 解像度を変えて再 configure する (旧コーデック / 旧 Worker は破棄される)
  await wrapper.configure("vp8", VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_BITRATE, VIDEO_FRAMERATE);
  recordState("afterSecondConfigure");

  encodeFrames(VIDEO_WIDTH, VIDEO_HEIGHT, RECONFIGURE_FRAME_COUNT * VIDEO_FRAME_DURATION);
  await waitForCondition(
    () => observedChunks.length >= RECONFIGURE_FRAME_COUNT * 2,
    `${RECONFIGURE_FRAME_COUNT * 2} encoded video chunks after the second configure`,
  );

  const queueSize = wrapper.encodeQueueSize;
  wrapper.close();
  recordState("afterClose");

  return {
    test: useWorker ? "videoEncoderReconfigureWorker" : "videoEncoderReconfigureDirect",
    useWorker,
    stateHistory,
    firstConfigChunkCount,
    secondConfigChunkCount: observedChunks.length - firstConfigChunkCount,
    outputTimestamps: observedChunks.map((chunk) => chunk.timestamp),
    queueSizeIsNonNegativeInteger: Number.isInteger(queueSize) && queueSize >= 0,
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
      pickFrameColor(index),
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
  // 参照 chunk は key 1 件 + delta 2 件を待ってから返るため delta も必ず存在する。
  // ここでのガードは到達しない防御 (添字アクセスの結果を 1 度だけ検証して使い回す)
  const firstDeltaChunk = deltaChunks[0];
  if (firstDeltaChunk === undefined) {
    throw new Error("reference video encoding produced no delta chunk");
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
    // 第 2 引数を省略すると start 以降の全要素を削除する
    const frames = pendingFrames.splice(0);
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
    firstDeltaChunk.data,
    firstDeltaChunk.type,
    firstDeltaChunk.timestamp,
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
    firstDeltaChunk.data,
    firstDeltaChunk.type,
    firstDeltaChunk.timestamp,
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

/**
 * 参照 chunk を復号するための VideoDecoderWrapper を作る
 *
 * 予算のテストで共有する。output は復号フレーム数を数えて閉じるだけにする
 * (フレームを使わないため保持し続けない)。error はメッセージを記録する。
 */
function createCountingVideoDecoder(
  useWorker: boolean,
  countFrame: () => void,
  recordError: (message: string) => void,
): VideoDecoderWrapper {
  return new VideoDecoderWrapper(useWorker, {
    output: (data) => {
      countFrame();
      // 復号フレームは使わないため、受けたら閉じる
      data.frame.close();
    },
    error: (error) => {
      recordError(error.message);
    },
  });
}

/**
 * VideoDecoderWrapper が非対応 codec で失敗する経路を検証する
 *
 * 実ブラウザで `VideoDecoder.isConfigSupported` が false を返すコーデックを実測で選び、
 * configure() が `Decoder codec not supported: <codec>` で失敗すること、state が
 * unconfigured のままであること、同じ config の reset() も再初期化せずに false を
 * 返すことを観測する。事前確認は configureWorker / configureDirect の直前にあるため、
 * この経路では Worker も VideoDecoder も作られない (実ブラウザのテストからは state と
 * エラーメッセージで確認する)。
 */
export async function runVideoDecoderUnsupportedCodecTest(
  useWorker: boolean,
): Promise<VideoDecoderUnsupportedCodecTestResult> {
  const selection = await selectUnsupportedVideoCodec();
  const errorMessages: string[] = [];
  let outputCount = 0;

  const decoder = createCountingVideoDecoder(
    useWorker,
    () => {
      outputCount += 1;
    },
    (message) => {
      errorMessages.push(message);
    },
  );

  const stateBeforeConfigure = decoder.state;

  // 非対応 codec の configure は Worker も VideoDecoder も作らずに失敗する
  let configureErrorMessage: string | null = null;
  try {
    await decoder.configure(selection.codec, VIDEO_WIDTH, VIDEO_HEIGHT);
  } catch (error) {
    configureErrorMessage = error instanceof Error ? error.message : String(error);
  }
  const stateAfterFailedConfigure = decoder.state;

  // 事前確認は reset() の再初期化経路でも効く。同じ config で reset() しても
  // Worker も VideoDecoder も作らず false を返す
  const resetReturned = await decoder.reset();
  const stateAfterReset = decoder.state;

  return {
    test: useWorker ? "videoDecoderUnsupportedCodecWorker" : "videoDecoderUnsupportedCodecDirect",
    useWorker,
    codec: selection.codec,
    codecString: selection.codecString,
    supportedCodecs: selection.supportedCodecs,
    stateBeforeConfigure,
    configureErrorMessage,
    stateAfterFailedConfigure,
    resetReturned,
    stateAfterReset,
    outputCount,
    errorMessages,
  };
}

/**
 * VideoDecoderWrapper の復帰予算の上限を検証する
 *
 * 復号フレームを 1 枚も出さないまま同じ config で reset() を繰り返し、上限の 3 回が
 * 成功して 4 回目が false になることを観測する。打ち切り後は state が unconfigured に
 * なり、実 chunk を投入しても復号しない (decode() は configured = false のため警告して
 * 何もしない)。configure 前の reset() (lastConfig が無い) も false を返す。
 */
export async function runVideoDecoderResetBudgetTest(
  useWorker: boolean,
): Promise<VideoDecoderResetBudgetTestResult> {
  const referenceChunks = await encodeReferenceChunks();
  const keyChunk = referenceChunks[0];
  if (!keyChunk) {
    throw new Error("reference video encoding produced no key chunk");
  }

  let frameCount = 0;
  const errorMessages: string[] = [];
  const decoder = createCountingVideoDecoder(
    useWorker,
    () => {
      frameCount += 1;
    },
    (message) => {
      errorMessages.push(message);
    },
  );

  // configure 前は lastConfig が無いため、reset() は false を返して何も作り直さない
  const resetWithoutConfig = await decoder.reset();
  const stateAfterResetWithoutConfig = decoder.state;

  await decoder.configure("vp8", VIDEO_WIDTH, VIDEO_HEIGHT, keyChunk.description);
  const stateAfterConfigure = decoder.state;

  // 復号フレームを 1 枚も出さないまま同じ config で reset() を呼ぶ。
  // 予算は再初期化の試行で消費するため、上限の 3 回で打ち切られる
  const resetResults: boolean[] = [];
  for (let index = 0; index < RESET_BUDGET_LIMIT + 1; index += 1) {
    resetResults.push(await decoder.reset());
  }
  const stateAfterBudgetExhausted = decoder.state;

  // 打ち切り後は configured が false のため、実 chunk を投入しても復号しない。
  // decode() は同じ状態で繰り返し呼ばれうる (受信のたびに呼ばれる) ため、
  // 複数回呼んで未構成の警告が 1 回だけであることを e2e がブラウザのコンソールから
  // 数えられるようにする
  const frameCountBeforeExhaustedDecode = frameCount;
  for (let index = 0; index < DECODE_ATTEMPTS_AFTER_BUDGET_EXHAUSTED; index += 1) {
    decoder.decode(keyChunk.data, keyChunk.type, keyChunk.timestamp, VIDEO_FRAME_DURATION);
  }
  await waitWithoutOutput(200);

  return {
    test: useWorker ? "videoDecoderResetBudgetWorker" : "videoDecoderResetBudgetDirect",
    useWorker,
    resetWithoutConfig,
    stateAfterResetWithoutConfig,
    stateAfterConfigure,
    resetResults,
    stateAfterBudgetExhausted,
    decodeAttemptsAfterBudgetExhausted: DECODE_ATTEMPTS_AFTER_BUDGET_EXHAUSTED,
    framesDecodedAfterBudgetExhausted: frameCount - frameCountBeforeExhaustedDecode,
    errorMessages,
  };
}

/**
 * VideoDecoderWrapper の復帰予算が戻る 2 条件を検証する
 *
 * 予算を使い切った状態から、(1) 復号フレームを 1 枚出力すると予算が戻ること、
 * (2) 参照の異なる config で configure すると予算が戻ることを観測する。
 * reset() の再入 (同じ config) では戻らないため、使い切った後の reset() は false になる。
 */
export async function runVideoDecoderResetRestoreTest(
  useWorker: boolean,
): Promise<VideoDecoderRestoreTestResult> {
  const referenceChunks = await encodeReferenceChunks();
  const keyChunk = referenceChunks[0];
  if (!keyChunk) {
    throw new Error("reference video encoding produced no key chunk");
  }

  let frameCount = 0;
  const errorMessages: string[] = [];
  const decoder = createCountingVideoDecoder(
    useWorker,
    () => {
      frameCount += 1;
    },
    (message) => {
      errorMessages.push(message);
    },
  );

  await decoder.configure("vp8", VIDEO_WIDTH, VIDEO_HEIGHT, keyChunk.description);

  // 復号フレームを出さないまま予算を使い切る (上限の 3 回が成功する)
  const resetResultsBeforeDecodedFrame: boolean[] = [];
  for (let index = 0; index < RESET_BUDGET_LIMIT; index += 1) {
    resetResultsBeforeDecodedFrame.push(await decoder.reset());
  }

  // 予算を使い切った状態で復号フレームを 1 枚出力する。reset() 後のデコーダーは
  // キーフレーム待ちのため、key chunk を投入して復号を再開する
  const frameCountBeforeDecode = frameCount;
  decoder.decode(keyChunk.data, keyChunk.type, keyChunk.timestamp, VIDEO_FRAME_DURATION);
  await waitForCondition(
    () => frameCount > frameCountBeforeDecode,
    "decoded video frame before the reset budget is restored",
  );

  // 復号フレームの出力で予算が戻っているため、reset() は再び true を返す
  // (戻らなければ、この reset() が false になる)
  const resetAfterDecodedFrame = await decoder.reset();

  // ここまでの reset() で 1 回消費しているため、残り 2 回の成功と 3 回目の false を
  // 観測してから、参照の異なる config の configure で予算が戻ることを確かめる
  const resetResultsBeforeDifferentConfig: boolean[] = [];
  for (let index = 0; index < RESET_BUDGET_LIMIT; index += 1) {
    resetResultsBeforeDifferentConfig.push(await decoder.reset());
  }

  // configure は毎回新しい config オブジェクトを作るため、予算が戻る
  await decoder.configure("vp8", RESTORE_SECOND_WIDTH, RESTORE_SECOND_HEIGHT, keyChunk.description);
  const resetAfterDifferentConfig = await decoder.reset();
  const stateAfterDifferentConfigReset = decoder.state;

  // ここまで構成したままにしてあるため、観測を終えたら閉じる
  // (他のテストと同じく、Worker も VideoDecoder も残さない)
  decoder.close();

  return {
    test: useWorker ? "videoDecoderResetRestoreWorker" : "videoDecoderResetRestoreDirect",
    useWorker,
    resetResultsBeforeDecodedFrame,
    resetAfterDecodedFrame,
    resetResultsBeforeDifferentConfig,
    resetAfterDifferentConfig,
    stateAfterDifferentConfigReset,
    frameCount,
    errorMessages,
  };
}

/**
 * VideoDecoderWrapper の並行する reset() / configure() の交錯を検証する
 *
 * (1) 同じ設定で `Promise.all([reset(), reset()])` を実行し、先に作り直した方だけが true を
 * 返して他方は破棄で進んだ世代を検出して false になる (両方 false にはならない) ことと、
 * デコーダーが構成されたまま残り実 chunk を復号できることを観測する。
 * (2) reset() の対応確認の await 中に参照の異なる config で configure() を呼び、
 * configure() が失敗せず、reset() が後発の configure() に追い越されて false を返す
 * (作り直しを行わない) ことを観測する。(2) は reset() と configure() を await を挟まずに
 * 続けて呼ぶ。configure() が lastConfig を同期で差し替えるため、reset() の対応確認が
 * 解決した時点では追い越しが確定している (どちらの対応確認が先に解決しても結果は同じ)。
 *
 * どちらも交錯の後に実 chunk を投入して復号できることまで確認する (構成が壊れた
 * 状態で success を返していないことの確認になる)。
 */
export async function runVideoDecoderConcurrentResetTest(
  useWorker: boolean,
): Promise<VideoDecoderConcurrentResetTestResult> {
  const referenceChunks = await encodeReferenceChunks();
  const keyChunk = referenceChunks[0];
  if (!keyChunk) {
    throw new Error("reference video encoding produced no key chunk");
  }

  const errorMessages: string[] = [];

  // (1) 同じ設定で 2 つの reset() を同時に実行する
  let concurrentResetFrameCount = 0;
  const concurrentDecoder = createCountingVideoDecoder(
    useWorker,
    () => {
      concurrentResetFrameCount += 1;
    },
    (message) => {
      errorMessages.push(message);
    },
  );

  await concurrentDecoder.configure("vp8", VIDEO_WIDTH, VIDEO_HEIGHT, keyChunk.description);
  const concurrentResetResults = await Promise.all([
    concurrentDecoder.reset(),
    concurrentDecoder.reset(),
  ]);
  const stateAfterConcurrentReset = concurrentDecoder.state;

  // 構成が残っていれば実 chunk が復号できる (後発世代のデコーダーが公開されている)
  const concurrentResetFrameCountBeforeDecode = concurrentResetFrameCount;
  concurrentDecoder.decode(keyChunk.data, keyChunk.type, keyChunk.timestamp, VIDEO_FRAME_DURATION);
  await waitForCondition(
    () => concurrentResetFrameCount > concurrentResetFrameCountBeforeDecode,
    "decoded video frame after concurrent reset()",
  );
  const framesDecodedAfterConcurrentReset =
    concurrentResetFrameCount - concurrentResetFrameCountBeforeDecode;
  concurrentDecoder.close();

  // (2) reset() の対応確認の await 中に、参照の異なる config で configure() する
  let configureFrameCount = 0;
  const interleavedDecoder = createCountingVideoDecoder(
    useWorker,
    () => {
      configureFrameCount += 1;
    },
    (message) => {
      errorMessages.push(message);
    },
  );

  await interleavedDecoder.configure("vp8", VIDEO_WIDTH, VIDEO_HEIGHT, keyChunk.description);
  // await を挟まずに呼び出す (configure() が lastConfig を同期で差し替えるため、
  // reset() の対応確認が解決する時点では追い越しが確定している)
  const resetDuringConfigure = interleavedDecoder.reset();
  let configureErrorMessage: string | null = null;
  const configureDuringReset = interleavedDecoder
    .configure("vp8", RESTORE_SECOND_WIDTH, RESTORE_SECOND_HEIGHT, keyChunk.description)
    .catch((error: unknown) => {
      configureErrorMessage = error instanceof Error ? error.message : String(error);
    });
  const resetReturnedDuringConfigure = await resetDuringConfigure;
  await configureDuringReset;
  const stateAfterConcurrentConfigure = interleavedDecoder.state;

  const configureFrameCountBeforeDecode = configureFrameCount;
  interleavedDecoder.decode(keyChunk.data, keyChunk.type, keyChunk.timestamp, VIDEO_FRAME_DURATION);
  await waitForCondition(
    () => configureFrameCount > configureFrameCountBeforeDecode,
    "decoded video frame after configure() during reset()",
  );
  const framesDecodedAfterConcurrentConfigure =
    configureFrameCount - configureFrameCountBeforeDecode;
  interleavedDecoder.close();

  return {
    test: useWorker ? "videoDecoderConcurrentResetWorker" : "videoDecoderConcurrentResetDirect",
    useWorker,
    concurrentResetResults,
    stateAfterConcurrentReset,
    framesDecodedAfterConcurrentReset,
    configureErrorMessage,
    resetReturnedDuringConfigure,
    stateAfterConcurrentConfigure,
    framesDecodedAfterConcurrentConfigure,
    errorMessages,
  };
}

/**
 * VideoDecoderWrapper の configure() の対応確認中に close() が先行する経路を検証する
 *
 * configure() は対応確認を await するため、その解決までの間に close() を呼ぶと、解放の
 * あとに Worker や VideoDecoder を作ってはならない。作ると誰も破棄せず (呼び出し側は
 * 解放時に参照を切ってから閉じる)、state も configured へ戻って close() の終端契約に
 * 反する。await を挟まずに configure() と close() を続けて呼び、イベント順と state で
 * 固定する (configure() は対応確認の await で止まるため、解放が必ず先行する)。
 * その後に configure() をやり直して実 chunk を復号できることまで確認する (解放で
 * Wrapper が使えなくなっていないことの確認になる)。
 */
export async function runVideoDecoderCloseDuringConfigureTest(
  useWorker: boolean,
): Promise<VideoDecoderCloseDuringConfigureTestResult> {
  const referenceChunks = await encodeReferenceChunks();
  const keyChunk = referenceChunks[0];
  if (!keyChunk) {
    throw new Error("reference video encoding produced no key chunk");
  }

  // await を挟まずに configure() と close() を続けて呼び、その間に起きたことを順に記録する
  const events: string[] = [];
  let frameCount = 0;
  const errorMessages: string[] = [];
  const decoder = createCountingVideoDecoder(
    useWorker,
    () => {
      frameCount += 1;
    },
    (message) => {
      errorMessages.push(message);
    },
  );

  events.push("configure started");
  const pending = decoder.configure("vp8", VIDEO_WIDTH, VIDEO_HEIGHT, keyChunk.description);
  events.push("close called");
  decoder.close();

  let configureErrorMessage: string | null = null;
  try {
    await pending;
    events.push("configure resolved");
  } catch (error) {
    events.push("configure rejected");
    configureErrorMessage = error instanceof Error ? error.message : String(error);
  }
  const stateAfterAbortedConfigure = decoder.state;
  const framesDecodedAfterAbortedConfigure = frameCount;

  // やり直した configure() は成功し、実 chunk を復号できる
  await decoder.configure("vp8", VIDEO_WIDTH, VIDEO_HEIGHT, keyChunk.description);
  const stateAfterReconfigure = decoder.state;
  const frameCountBeforeDecode = frameCount;
  decoder.decode(keyChunk.data, keyChunk.type, keyChunk.timestamp, VIDEO_FRAME_DURATION);
  await waitForCondition(
    () => frameCount > frameCountBeforeDecode,
    "decoded video frame after the configure() following the aborted configure",
  );
  const framesDecodedAfterReconfigure = frameCount - frameCountBeforeDecode;
  decoder.close();

  return {
    test: useWorker
      ? "videoDecoderCloseDuringConfigureWorker"
      : "videoDecoderCloseDuringConfigureDirect",
    useWorker,
    events,
    configureErrorMessage,
    stateAfterAbortedConfigure,
    framesDecodedAfterAbortedConfigure,
    stateAfterReconfigure,
    framesDecodedAfterReconfigure,
    errorMessages,
  };
}
