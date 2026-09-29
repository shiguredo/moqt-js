/**
 * devtools の DecoderWrapper の実ブラウザテスト
 *
 * devtools の購読側が使う Wrapper (devtools/src/utils/DecoderWrapper.ts) を、実ブラウザの
 * WebCodecs と実 Worker で駆動する。ライブラリ側の VideoDecoderWrapper のケース (./video.ts)
 * とは別に、devtools 側の配線 (configure の事前確認と復帰の予算) だけを観測する。
 * モックやスタブは使わない。
 */

import { getVideoDecoderConfig, getVideoEncoderConfig } from "../../../src/codec/config.ts";
import { DecoderWrapper } from "../utils/DecoderWrapper.ts";
import { EncoderWrapper, type EncodedChunkData } from "../utils/EncoderWrapper.ts";
import {
  VIDEO_BITRATE,
  VIDEO_FRAMERATE,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
  createTestVideoFrame,
  waitForCondition,
  waitWithoutOutput,
} from "./support.ts";
import type {
  ConfigSupportObservation,
  DevtoolsDecoderCloseDuringConfigureTestResult,
  DevtoolsDecoderConcurrentConfigureTestResult,
  DevtoolsDecoderResetBudgetTestResult,
  DevtoolsDecoderUnsupportedCodecTestResult,
} from "./types.ts";

// 非対応 codec の codec 文字列。`VideoDecoder.isConfigSupported` が false を返すことを
// テスト内で実測してから駆動する (対応と判定された環境ではテストを失敗させ、検証が
// 空振りしないようにする)
const UNSUPPORTED_CODEC_STRING = "vp09.99.99.99";

// `VideoDecoder.isConfigSupported` が reject する codec 文字列。WebCodecs の仕様では
// 不正な codec 文字列は同期 throw せず reject した Promise を返すため、false を返す経路とは
// 別の分岐になる (空文字はどの codec にも一致しない)
const INVALID_CODEC_STRING = "";

// 対応 codec。参照 chunk の符号化と configure の両方に使う
const SUPPORTED_CODEC = "vp8";

// 復帰予算の上限 (同じ config で復号フレームを得ないまま再初期化できる回数)。
// 上限の正本は src/codec/decoderResetBudget.ts の非公開定数であり、DecoderResetBudget は
// 「上限を使う判定はクラスが持つ」契約のため値を外へ公開しない。値を持たないとテストが
// 上限まで駆動できないため、ここでは上限そのものを固定するライブラリ側の Node テスト
// (src/codec/decoderResetBudget.test.ts) と同じ値をテスト側の定数として持つ。上限が
// 変われば下の assert が固定する true / false の並びも変わるため、二重定義が黙って
// ずれることはない (ライブラリ側の codec-test も同じ形で持つ)
const RESET_BUDGET_LIMIT = 3;

// 予算を使い切って打ち切った後に decode() を呼ぶ回数。
// 打ち切り後は configured が false のため、実 chunk を投入しても復号しない
// (呼び出し回数そのものは結果に持たせず、復号フレーム数 0 件で確認する)
const DECODE_ATTEMPTS_AFTER_BUDGET_EXHAUSTED = 3;

// 予算が戻る条件 (参照の異なる config の configure) を見るときの 2 つ目の解像度。
// configure は毎回新しいオブジェクトを作るため同じ解像度でも参照は変わるが、
// 設定そのものが変わったことを結果から読み取れるように解像度も変える
const RESTORE_SECOND_WIDTH = 160;
const RESTORE_SECOND_HEIGHT = 120;

/**
 * 実ブラウザの対応確認をそのまま観測する
 *
 * devtools の DecoderWrapper は対応確認の判定規則を src/codec/configSupport.ts に委ねるため、
 * テスト側でも同じ API を直接呼び、駆動する設定が期待した分岐 (false / reject) に入ることを
 * 確かめる。reject は非対応として扱われる分岐である。
 */
async function observeConfigSupport(config: VideoDecoderConfig): Promise<ConfigSupportObservation> {
  try {
    const support = await VideoDecoder.isConfigSupported(config);
    // supported は省略され得るため、明示的に true のときだけ対応とみなす
    return { supported: support.supported === true, rejected: false };
  } catch {
    return { supported: null, rejected: true };
  }
}

/**
 * 復号の入力にする key chunk を実ブラウザのエンコーダーで 1 枚だけ作る
 *
 * devtools の EncoderWrapper を直接モードで使い、実際に符号化された chunk を返す。
 * 復号フレームの出力が予算を戻すことの確認に使う。
 */
async function encodeOneKeyChunk(): Promise<EncodedChunkData> {
  const chunks: EncodedChunkData[] = [];
  const errorMessages: string[] = [];

  const encoder = new EncoderWrapper(false, {
    output: (chunk) => {
      chunks.push(chunk);
    },
    error: (error) => {
      errorMessages.push(error.message);
    },
  });

  await encoder.configure(
    getVideoEncoderConfig(
      SUPPORTED_CODEC,
      VIDEO_WIDTH,
      VIDEO_HEIGHT,
      VIDEO_BITRATE,
      VIDEO_FRAMERATE,
    ),
  );

  const frame = createTestVideoFrame(VIDEO_WIDTH, VIDEO_HEIGHT, "#ff0000", 0);
  try {
    encoder.encode(frame, { keyFrame: true });
  } finally {
    // 直接モードの encode() は frame を消費しないためテスト側で閉じる
    frame.close();
  }

  await waitForCondition(() => chunks.length > 0, "1 encoded video key chunk");
  encoder.close();

  if (errorMessages.length > 0) {
    throw new Error(`reference video encoding failed: ${errorMessages.join(", ")}`);
  }
  const [chunk] = chunks;
  if (chunk === undefined) {
    throw new Error("reference video encoding produced no chunk");
  }
  if (chunk.type !== "key") {
    throw new Error(
      `reference video encoding produced a ${chunk.type} chunk instead of a key chunk`,
    );
  }
  return chunk;
}

/**
 * 参照 chunk から復号へ投入する EncodedVideoChunk を作る
 *
 * devtools の DecoderWrapper.decode() は EncodedVideoChunk を受け取るため、テストページ側で
 * 変換する。同じ参照 chunk を繰り返し投入できるよう、呼び出しのたびに作る。
 */
function createEncodedKeyChunk(reference: EncodedChunkData): EncodedVideoChunk {
  return new EncodedVideoChunk({
    type: reference.type,
    timestamp: reference.timestamp,
    duration: reference.duration ?? 0,
    data: reference.data,
  });
}

/**
 * 復号フレーム数を数える devtools の DecoderWrapper を作る
 *
 * 復号フレームは使わないため、受け取った時点で閉じる (保持し続けない)。
 * フレーム数を数える必要が無い場合は countFrame を省略する (復号しないテストで
 * 何もしないコールバックを渡さない)。
 */
function createCountingDecoder(
  useWorker: boolean,
  handlers: {
    // 復号フレームを 1 枚出力するたびに呼ぶ (省略した場合は数えない)
    countFrame?: () => void;
    // error コールバックに届いたメッセージを受け取る
    recordError: (message: string) => void;
  },
): DecoderWrapper {
  return new DecoderWrapper(useWorker, {
    output: ({ frame }) => {
      handlers.countFrame?.();
      frame.close();
    },
    error: (error) => {
      handlers.recordError(error.message);
    },
  });
}

/**
 * devtools の DecoderWrapper が非対応 codec で失敗する経路を検証する
 *
 * (1) `VideoDecoder.isConfigSupported` が false を返す codec 文字列 (`vp09.99.99.99`) では、
 * configure が `Decoder codec not supported: <codec>` で失敗し、state は unconfigured の
 * ままになる。失敗した設定は lastConfig に残らないため、同じ config の reset() も
 * 再試行せず false を返す。
 * (2) `isConfigSupported` が reject する codec 文字列 (空文字) も同じ扱いになる。
 *
 * 対応確認は Worker の生成 / VideoDecoder の configure より前にあるため、この経路では
 * どちらのモードでも Worker も VideoDecoder も作られない (実ブラウザのテストからは state と
 * エラーメッセージで確認する)。
 */
export async function runDevtoolsDecoderUnsupportedCodecTest(
  useWorker: boolean,
): Promise<DevtoolsDecoderUnsupportedCodecTestResult> {
  const unsupportedConfig: VideoDecoderConfig = {
    codec: UNSUPPORTED_CODEC_STRING,
    codedWidth: VIDEO_WIDTH,
    codedHeight: VIDEO_HEIGHT,
  };
  const invalidConfig: VideoDecoderConfig = {
    codec: INVALID_CODEC_STRING,
    codedWidth: VIDEO_WIDTH,
    codedHeight: VIDEO_HEIGHT,
  };

  // 駆動する前に、codec 文字列が期待した分岐に入ることを実ブラウザで確かめる
  const unsupportedCodecSupport = await observeConfigSupport(unsupportedConfig);
  if (unsupportedCodecSupport.rejected || unsupportedCodecSupport.supported !== false) {
    throw new Error(
      `expected an unsupported video decoder config: codec=${UNSUPPORTED_CODEC_STRING}`,
    );
  }
  const invalidCodecSupport = await observeConfigSupport(invalidConfig);
  if (!invalidCodecSupport.rejected) {
    throw new Error(
      `expected a rejected video decoder config: codec=${JSON.stringify(INVALID_CODEC_STRING)}`,
    );
  }

  let outputCount = 0;
  const errorMessages: string[] = [];
  const decoder = createCountingDecoder(useWorker, {
    countFrame: () => {
      outputCount += 1;
    },
    recordError: (message) => {
      errorMessages.push(message);
    },
  });

  // false を返す codec の configure は Worker も VideoDecoder も作らずに失敗する
  let configureErrorMessage: string | null = null;
  try {
    await decoder.configure(unsupportedConfig);
  } catch (error) {
    configureErrorMessage = error instanceof Error ? error.message : String(error);
  }
  const stateAfterFailedConfigure = decoder.state;

  // 失敗した設定は lastConfig に残らないため、reset() は同じ config を再試行せず false を返す
  const resetReturned = await decoder.reset();
  const stateAfterReset = decoder.state;

  // reject する codec も同じ経路になる
  let invalidCodecConfigureErrorMessage: string | null = null;
  try {
    await decoder.configure(invalidConfig);
  } catch (error) {
    invalidCodecConfigureErrorMessage = error instanceof Error ? error.message : String(error);
  }
  const stateAfterInvalidCodecConfigure = decoder.state;
  const invalidCodecResetReturned = await decoder.reset();

  // どちらの経路でも Worker も VideoDecoder も作られないため、復号も起きない
  await waitWithoutOutput(200);
  // 作られていないため閉じるものは無い (close は冪等)
  decoder.close();

  return {
    test: useWorker
      ? "devtoolsDecoderUnsupportedCodecWorker"
      : "devtoolsDecoderUnsupportedCodecDirect",
    useWorker,
    unsupportedCodecString: UNSUPPORTED_CODEC_STRING,
    unsupportedCodecSupport,
    configureErrorMessage,
    stateAfterFailedConfigure,
    resetReturned,
    stateAfterReset,
    invalidCodecString: INVALID_CODEC_STRING,
    invalidCodecSupport,
    invalidCodecConfigureErrorMessage,
    stateAfterInvalidCodecConfigure,
    invalidCodecResetReturned,
    outputCount,
    errorMessages,
  };
}

/**
 * devtools の DecoderWrapper の復帰予算を検証する
 *
 * configure の事前確認があるため、この経路は対応 codec (vp8) だけを通る。
 *
 * (a) 復号フレームを 1 枚も出さないまま同じ config で reset() を繰り返すと、上限の 3 回が
 * 成功して 4 回目が false になり、打ち切り後は state が unconfigured になる (Worker も
 * VideoDecoder も作り直さない)。打ち切り後は実 chunk を投入しても復号しない。
 * (b) 予算を使い切った状態で復号フレームを 1 枚出力すると予算が戻り、reset() が再び true を
 * 返す (戻らなければ false になる)。
 * (c) 予算を使い切った状態で参照の異なる config の configure でも予算が戻り、reset() が
 * 再び true を返す。
 * (d) 予算を使い切った状態で参照の異なる config の configure() を始めても、その await 中に
 * reset() で追い越されて失敗する場合は予算が戻らない (戻すと、呼び出し側が毎回新しい設定を
 * 渡すだけで上限が無効になる)。
 *
 * 予算は reset() の再入では戻らない。3 回の reset() がすべて true であることは、configure へ
 * 同じ参照の lastConfig を渡していることの確認でもある。
 */
export async function runDevtoolsDecoderResetBudgetTest(
  useWorker: boolean,
): Promise<DevtoolsDecoderResetBudgetTestResult> {
  // 参照 chunk (key 1 枚) を実エンコーダーで作る
  const keyChunk = await encodeOneKeyChunk();

  const errorMessages: string[] = [];

  // (a) 同じ config の reset() を連続して呼び、上限で打ち切られることを見る
  let budgetFrameCount = 0;
  const budgetDecoder = createCountingDecoder(useWorker, {
    countFrame: () => {
      budgetFrameCount += 1;
    },
    recordError: (message) => {
      errorMessages.push(message);
    },
  });

  // configure 前は lastConfig が無いため、reset() は false を返して何も作り直さない
  const resetWithoutConfig = await budgetDecoder.reset();

  const budgetConfig = getVideoDecoderConfig(SUPPORTED_CODEC, VIDEO_WIDTH, VIDEO_HEIGHT);
  await budgetDecoder.configure(budgetConfig);
  const stateAfterConfigure = budgetDecoder.state;

  const resetResults: boolean[] = [];
  for (let index = 0; index < RESET_BUDGET_LIMIT + 1; index += 1) {
    resetResults.push(await budgetDecoder.reset());
  }
  const stateAfterBudgetExhausted = budgetDecoder.state;

  // 打ち切り後は configured が false のため、実 chunk を投入しても復号しない
  const frameCountBeforeExhaustedDecode = budgetFrameCount;
  for (let index = 0; index < DECODE_ATTEMPTS_AFTER_BUDGET_EXHAUSTED; index += 1) {
    budgetDecoder.decode(createEncodedKeyChunk(keyChunk));
  }
  await waitWithoutOutput(200);
  const framesDecodedAfterBudgetExhausted = budgetFrameCount - frameCountBeforeExhaustedDecode;
  budgetDecoder.close();

  // (b) 予算を使い切った状態から復号フレームを 1 枚出力し、予算が戻ることを見る
  let restoreFrameCount = 0;
  const restoreDecoder = createCountingDecoder(useWorker, {
    countFrame: () => {
      restoreFrameCount += 1;
    },
    recordError: (message) => {
      errorMessages.push(message);
    },
  });

  await restoreDecoder.configure(getVideoDecoderConfig(SUPPORTED_CODEC, VIDEO_WIDTH, VIDEO_HEIGHT));

  // 復号フレームを出さないまま予算を使い切る (上限の 3 回が成功する)
  const resetResultsBeforeDecodedFrame: boolean[] = [];
  for (let index = 0; index < RESET_BUDGET_LIMIT; index += 1) {
    resetResultsBeforeDecodedFrame.push(await restoreDecoder.reset());
  }

  // 予算を使い切った状態で key chunk を 1 枚復号する。reset() の後のデコーダーは
  // キーフレーム待ちのため、key chunk で復号が再開する
  const frameCountBeforeDecode = restoreFrameCount;
  restoreDecoder.decode(createEncodedKeyChunk(keyChunk));
  await waitForCondition(
    () => restoreFrameCount > frameCountBeforeDecode,
    "decoded video frame before the reset budget is restored",
  );
  const framesDecodedBeforeRestore = restoreFrameCount - frameCountBeforeDecode;

  // 復号フレームを出力した時点で予算が戻っているため、reset() は再び true を返す
  const resetAfterDecodedFrame = await restoreDecoder.reset();
  restoreDecoder.close();

  // (c) 予算を使い切った状態から参照の異なる config で configure し、予算が戻ることを見る。
  // フレームは数えない (この経路では復号結果を使わない)
  const differentConfigDecoder = createCountingDecoder(useWorker, {
    recordError: (message) => {
      errorMessages.push(message);
    },
  });

  await differentConfigDecoder.configure(
    getVideoDecoderConfig(SUPPORTED_CODEC, VIDEO_WIDTH, VIDEO_HEIGHT),
  );

  const resetResultsBeforeDifferentConfig: boolean[] = [];
  for (let index = 0; index < RESET_BUDGET_LIMIT; index += 1) {
    resetResultsBeforeDifferentConfig.push(await differentConfigDecoder.reset());
  }

  // configure は呼び出しのたびに新しいオブジェクトを作るため、参照が異なる config になる
  await differentConfigDecoder.configure(
    getVideoDecoderConfig(SUPPORTED_CODEC, RESTORE_SECOND_WIDTH, RESTORE_SECOND_HEIGHT),
  );
  const resetAfterDifferentConfig = await differentConfigDecoder.reset();
  const stateAfterDifferentConfigReset = differentConfigDecoder.state;
  differentConfigDecoder.close();

  // (d) 予算を使い切った状態で参照の異なる config の configure() を始め、その await 中に
  // reset() で追い越す。configure() が受け取った設定で予算を戻すと、呼び出し側が毎回
  // 新しい設定を渡すだけで上限が無効になり、恒久エラーで再生成が止まらない。
  // 追い越されて失敗した configure() は何も構成しないため、戻してはならない
  const supersededDecoder = createCountingDecoder(useWorker, {
    recordError: (message) => {
      errorMessages.push(message);
    },
  });

  await supersededDecoder.configure(
    getVideoDecoderConfig(SUPPORTED_CODEC, VIDEO_WIDTH, VIDEO_HEIGHT),
  );

  const resetResultsBeforeSupersededConfigure: boolean[] = [];
  for (let index = 0; index < RESET_BUDGET_LIMIT; index += 1) {
    resetResultsBeforeSupersededConfigure.push(await supersededDecoder.reset());
  }

  // reset() は同期で世代を無効化するため、先に始めた configure() は対応確認の await 明けに
  // 世代の判定で失敗する。reset() 自身は予算を使い切っているため打ち切る
  const supersededConfigure = supersededDecoder.configure(
    getVideoDecoderConfig(SUPPORTED_CODEC, RESTORE_SECOND_WIDTH, RESTORE_SECOND_HEIGHT),
  );
  const resetAfterSupersededConfigure = await supersededDecoder.reset();

  let supersededConfigureErrorMessage: string | null = null;
  try {
    await supersededConfigure;
  } catch (error) {
    supersededConfigureErrorMessage = error instanceof Error ? error.message : String(error);
  }
  const stateAfterSupersededConfigure = supersededDecoder.state;
  supersededDecoder.close();

  return {
    test: useWorker ? "devtoolsDecoderResetBudgetWorker" : "devtoolsDecoderResetBudgetDirect",
    useWorker,
    supportedCodecString: budgetConfig.codec,
    resetWithoutConfig,
    stateAfterConfigure,
    resetResults,
    stateAfterBudgetExhausted,
    framesDecodedAfterBudgetExhausted,
    resetResultsBeforeDecodedFrame,
    framesDecodedBeforeRestore,
    resetAfterDecodedFrame,
    resetResultsBeforeDifferentConfig,
    resetAfterDifferentConfig,
    stateAfterDifferentConfigReset,
    resetResultsBeforeSupersededConfigure,
    resetAfterSupersededConfigure,
    supersededConfigureErrorMessage,
    stateAfterSupersededConfigure,
    errorMessages,
  };
}

/**
 * devtools の DecoderWrapper が configure() の await 中に close() された場合の契約を検証する
 *
 * await を挟まずに configure() と close() を呼ぶ。configure() は対応確認の await を持つため、
 * 対応確認の解決より解放が先に走る。解放のあとに Worker や VideoDecoder を作ると誰も
 * 破棄せず、state も configured へ戻る (configure の Promise も解決してしまう)。
 * ライブラリ側のケース (videoDecoderCloseDuringConfigure*) と同じ手順を devtools の
 * Wrapper で駆動し、あわせて close() が終端として働くこと (close() の後の reset() が
 * 作り直さず false を返すこと) を観測する。
 */
export async function runDevtoolsDecoderCloseDuringConfigureTest(
  useWorker: boolean,
): Promise<DevtoolsDecoderCloseDuringConfigureTestResult> {
  // 解放のあとに作られていないことを、実 chunk の復号で確かめるために使う
  const keyChunk = await encodeOneKeyChunk();
  const config = getVideoDecoderConfig(SUPPORTED_CODEC, VIDEO_WIDTH, VIDEO_HEIGHT);

  const events: string[] = [];
  let frameCount = 0;
  const errorMessages: string[] = [];
  const decoder = createCountingDecoder(useWorker, {
    countFrame: () => {
      frameCount += 1;
    },
    recordError: (message) => {
      errorMessages.push(message);
    },
  });

  events.push("configure started");
  const pending = decoder.configure(config);
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

  // 解放のあとに Worker や VideoDecoder を作っていれば、実 chunk を投入した時点で復号する
  // (state が configured に戻っていれば decode() は投入し、作られていなければ何もしない)
  decoder.decode(createEncodedKeyChunk(keyChunk));
  await waitWithoutOutput(200);
  const framesDecodedAfterAbortedConfigure = frameCount;

  // 解放の後に reset() が作り直すと、停止した購読の Worker と VideoDecoder が残る
  const resetAfterAbortedConfigure = await decoder.reset();

  // やり直した configure() は成功し (解放で Wrapper は壊れない)、実 chunk を復号できる
  await decoder.configure(config);
  const stateAfterReconfigure = decoder.state;
  const frameCountBeforeDecode = frameCount;
  decoder.decode(createEncodedKeyChunk(keyChunk));
  await waitForCondition(
    () => frameCount > frameCountBeforeDecode,
    "decoded video frame after the configure() following the aborted configure",
  );
  const framesDecodedAfterReconfigure = frameCount - frameCountBeforeDecode;

  // close() は終端であり、その後の reset() は作り直さない
  decoder.close();
  const resetAfterClose = await decoder.reset();
  const stateAfterCloseReset = decoder.state;

  return {
    test: useWorker
      ? "devtoolsDecoderCloseDuringConfigureWorker"
      : "devtoolsDecoderCloseDuringConfigureDirect",
    useWorker,
    events,
    configureErrorMessage,
    stateAfterAbortedConfigure,
    framesDecodedAfterAbortedConfigure,
    stateAfterReconfigure,
    framesDecodedAfterReconfigure,
    resetAfterAbortedConfigure,
    resetAfterClose,
    stateAfterCloseReset,
    errorMessages,
  };
}

/**
 * devtools の DecoderWrapper が並行する configure() に追い越された場合の契約を検証する
 *
 * await を挟まずに 2 つの configure() を始める。configure() は対応確認を await するため、
 * 先発の await 中に後発が世代を採番する。先発は所有権を失って失敗し、Worker も VideoDecoder も
 * 作らない。後発の構成が残り、実 chunk を復号できることまで確認する。
 */
export async function runDevtoolsDecoderConcurrentConfigureTest(
  useWorker: boolean,
): Promise<DevtoolsDecoderConcurrentConfigureTestResult> {
  const keyChunk = await encodeOneKeyChunk();
  // 2 つ目の config は解像度を変えて参照も値も変える (どちらが構成されたかを結果から読める)
  const firstConfig = getVideoDecoderConfig(SUPPORTED_CODEC, VIDEO_WIDTH, VIDEO_HEIGHT);
  const secondConfig = getVideoDecoderConfig(
    SUPPORTED_CODEC,
    RESTORE_SECOND_WIDTH,
    RESTORE_SECOND_HEIGHT,
  );

  let frameCount = 0;
  const errorMessages: string[] = [];
  const decoder = createCountingDecoder(useWorker, {
    countFrame: () => {
      frameCount += 1;
    },
    recordError: (message) => {
      errorMessages.push(message);
    },
  });

  // await を挟まずに呼び出す。先発の対応確認の await 中に後発が世代を採番する
  const first = decoder.configure(firstConfig);
  const second = decoder.configure(secondConfig);

  let firstConfigureErrorMessage: string | null = null;
  try {
    await first;
  } catch (error) {
    firstConfigureErrorMessage = error instanceof Error ? error.message : String(error);
  }
  let secondConfigureErrorMessage: string | null = null;
  try {
    await second;
  } catch (error) {
    secondConfigureErrorMessage = error instanceof Error ? error.message : String(error);
  }
  const stateAfterConcurrentConfigure = decoder.state;

  // 後発の構成が残っていれば実 chunk が復号できる (先発は作っていないため、先発の設定で
  // 構成されたデコーダーは存在しない)
  const frameCountBeforeDecode = frameCount;
  decoder.decode(createEncodedKeyChunk(keyChunk));
  await waitForCondition(
    () => frameCount > frameCountBeforeDecode,
    "decoded video frame after the concurrent configure()",
  );
  const framesDecodedAfterConcurrentConfigure = frameCount - frameCountBeforeDecode;
  decoder.close();

  return {
    test: useWorker
      ? "devtoolsDecoderConcurrentConfigureWorker"
      : "devtoolsDecoderConcurrentConfigureDirect",
    useWorker,
    firstConfigureErrorMessage,
    secondConfigureErrorMessage,
    stateAfterConcurrentConfigure,
    framesDecodedAfterConcurrentConfigure,
    errorMessages,
  };
}
