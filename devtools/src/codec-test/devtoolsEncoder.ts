/**
 * devtools の EncoderWrapper の実ブラウザテスト
 *
 * devtools の配信が使う Wrapper (devtools/src/utils/EncoderWrapper.ts) を Worker モードで
 * 駆動し、encodeQueueSize が Worker へ送信してまだ encoded 応答が返っていないフレーム数を
 * 返すことを、実ブラウザの WebCodecs と実 Worker で観測する。あわせて、再 configure で
 * 旧 Worker を破棄して新しい Worker へ差し替えること、configure / close で数が 0 に
 * 戻ること、output が例外を投げても減算されること、Worker が error 応答を返した後に
 * 投入を止めることを同じ経路で確認する。モックやスタブは使わない。
 */

import { getVideoEncoderConfig } from "../../../src/codec/config.ts";
import { EncoderWrapper } from "../utils/EncoderWrapper.ts";
import {
  VIDEO_BITRATE,
  VIDEO_FRAME_DURATION,
  VIDEO_FRAMERATE,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
  createTestVideoFrame,
  pickFrameColor,
  summarizeEncodedChunk,
  waitForCondition,
  waitForDuration,
} from "./support.ts";
import type {
  DevtoolsEncoderCloseDuringConfigureTestResult,
  DevtoolsEncoderFailedWorkerConfigureTestResult,
  DevtoolsEncoderWorkerTestResult,
  ObservedEncodedChunk,
  StateTransition,
} from "./types.ts";

// 1 回の configure で投入するフレーム数。結果に含めて e2e (tests/e2e/codec-wrappers.spec.ts) が
// 同じ値を使えるようにする
const ENCODE_FRAME_COUNT = 6;

// 再 configure で変える解像度。再 configure テストで 2 回目に使う (1 回目は
// VIDEO_WIDTH / VIDEO_HEIGHT)
const RECONFIGURE_WIDTH = 160;
const RECONFIGURE_HEIGHT = 120;

// Worker に設定できない codec 文字列。実ブラウザ (Chromium) の VideoEncoder は configure では
// 拒否せず、最初の encode で NotSupportedError になり error コールバックを呼ぶ。この失敗で
// Worker が error 応答を返す状態を駆動する (テスト専用のメッセージは足さない)
const UNSETTABLE_CODEC = "no-such-codec";

// configure() の待機が中断で終わるかを観測するときに待つ時間 (ミリ秒)。中断は close() から
// 同期で届くため、Worker の初期化の速さには依存しない
const CONFIGURE_SETTLE_OBSERVE_MS = 500;

/**
 * devtools の EncoderWrapper を Worker モードで駆動し、送信中のフレーム数を観測する
 *
 * 観測の順序は次のとおりである。
 *
 * 1. configure の前後は送信中 0 件 (未設定、または送信中 0 件のため 0)
 * 2. フレームを投入した直後は投入数が残る (postMessage の成功後に数える)
 * 3. 出力を待つと encoded 応答ごとに減って 0 に戻る (output を呼ぶ前に減らす)
 * 4. 応答を待たずに投入したフレームを残したまま再 configure すると 0 に戻る
 *    (旧 Worker は破棄され encoded 応答が返らないため、戻さないと数が張り付く)
 * 5. 再 configure の後も新しい Worker で encode が続く
 * 6. 未応答のフレームを残したまま close しても 0 に戻る
 * 7. 1 件目の output が例外を投げても、そのフレームの数は戻る (減算は output の前)
 * 8. Worker が error 応答を返したら 0 に戻り、state が configured でなくなって投入が止まる
 * 9. 初期化に失敗する configure でも 0 に戻り、state が configured でなくなる
 * 10. 再 configure の応答を待つ間に新しい Worker へ送ったフレームの数は、完了後も消えない
 *
 * error コールバックへ通知が届く経路 (初期化の後に届いた失敗) はこの runner では駆動せず、
 * runWorkerErrorTest が担当する。正常系だけを並べるこの runner の観測では通知は空にしか
 * ならないため、通知の有無は結果に含めない。
 */
export async function runDevtoolsEncoderWorkerTest(): Promise<DevtoolsEncoderWorkerTestResult> {
  const observedChunks: ObservedEncodedChunk[] = [];
  const stateHistory: StateTransition[] = [];

  const encoder = new EncoderWrapper(true, {
    output: (chunk) => {
      observedChunks.push(summarizeEncodedChunk(chunk));
    },
    error: () => {
      // 正常系の観測では通知は届かない (通知の経路は runWorkerErrorTest が駆動する)
    },
  });

  const recordState = (step: string): void => {
    stateHistory.push({ step, state: encoder.state });
  };

  recordState("initial");
  // configure 前は未設定であり、送信中も 0 件のため 0 になる
  const queueSizeBeforeConfigure = encoder.encodeQueueSize;

  // Worker モードでは init メッセージの往復が完了するまで resolve しない
  await encoder.configure(
    getVideoEncoderConfig("vp8", VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_BITRATE, VIDEO_FRAMERATE),
  );
  recordState("afterConfigure");

  const queueSizeAfterConfigure = encoder.encodeQueueSize;

  /**
   * 指定した Wrapper へ、指定した timestamp から ENCODE_FRAME_COUNT 枚を投入する
   *
   * Worker モードでは frame を transfer するため、テスト側では閉じない (所有権が Worker に
   * 移り、Worker が encode の後に閉じる)。
   */
  const encodeFrames = (target: EncoderWrapper, timestampOffset: number): void => {
    for (let index = 0; index < ENCODE_FRAME_COUNT; index += 1) {
      const frame = createTestVideoFrame(
        VIDEO_WIDTH,
        VIDEO_HEIGHT,
        pickFrameColor(index),
        timestampOffset + index * VIDEO_FRAME_DURATION,
      );
      target.encode(frame, { keyFrame: index === 0 });
    }
  };

  encodeFrames(encoder, 0);

  // 出力待機の前なので、投入した ENCODE_FRAME_COUNT 件が送信中として残る
  const queueSizeAfterEncode = encoder.encodeQueueSize;

  await waitForCondition(
    () => observedChunks.length >= ENCODE_FRAME_COUNT,
    `${ENCODE_FRAME_COUNT} encoded video chunks`,
  );
  recordState("afterFirstEncode");

  // encoded 応答が返るたびに減り、出力を待つと 0 に戻る
  const queueSizeAfterOutputWait = encoder.encodeQueueSize;

  // 応答を待たずに投入したフレームを残したまま再 configure する
  encodeFrames(encoder, ENCODE_FRAME_COUNT * VIDEO_FRAME_DURATION);
  const queueSizeBeforeReconfigure = encoder.encodeQueueSize;

  await encoder.configure(
    getVideoEncoderConfig(
      "vp8",
      RECONFIGURE_WIDTH,
      RECONFIGURE_HEIGHT,
      VIDEO_BITRATE,
      VIDEO_FRAMERATE,
    ),
  );
  recordState("afterReconfigure");

  // 旧 Worker の破棄とカウンタのリセットにより、送信中は 0 件に戻る
  const queueSizeAfterReconfigure = encoder.encodeQueueSize;

  // 新しい Worker でも encode が続く (差し替えで Wrapper は壊れない)
  const chunkCountBeforeSecondEncode = observedChunks.length;
  encodeFrames(encoder, ENCODE_FRAME_COUNT * 2 * VIDEO_FRAME_DURATION);
  await waitForCondition(
    () => observedChunks.length >= ENCODE_FRAME_COUNT * 2,
    `${ENCODE_FRAME_COUNT * 2} encoded video chunks after the second configure`,
  );
  recordState("afterSecondEncode");

  const secondConfigChunkCount = observedChunks.length - chunkCountBeforeSecondEncode;

  // 応答を待たずに投入したフレームを残したまま close する。後続の判定がぶれないよう、
  // ここまでの観測を確定させる
  const chunksBeforeClose = observedChunks.slice();
  encodeFrames(encoder, ENCODE_FRAME_COUNT * 3 * VIDEO_FRAME_DURATION);
  const queueSizeBeforeClose = encoder.encodeQueueSize;

  encoder.close();
  recordState("afterClose");

  const queueSizeAfterClose = encoder.encodeQueueSize;

  // 1 件目の output だけを例外にして、減算が output の呼び出しより前であることを見る。
  // 減算が output の後だと、例外を投げたフレームの数が戻らず待機後も 1 件残る
  const throwingEncoder = await runOutputThrowsTest();

  // Worker が error 応答を返す状態を、実際のブラウザの VideoEncoder が設定できない config で
  // 駆動する (テスト専用のメッセージは足さない)
  const workerError = await runWorkerErrorTest();

  // 初期化に失敗する configure でも、送信中の数が残らないことを観測する
  const failedConfigure = await runFailedConfigureTest();

  // 再 configure の応答を待つ間に新しい Worker へ送ったフレームの数が消えないことを観測する
  const reconfigureWait = await runReconfigureWaitTest();

  return {
    test: "devtoolsEncoderWorker",
    useWorker: true,
    encodeFrameCount: ENCODE_FRAME_COUNT,
    stateHistory,
    queueSizeBeforeConfigure,
    queueSizeAfterConfigure,
    queueSizeAfterEncode,
    queueSizeAfterOutputWait,
    queueSizeBeforeReconfigure,
    queueSizeAfterReconfigure,
    secondConfigChunkCount,
    queueSizeBeforeClose,
    queueSizeAfterClose,
    chunkCount: chunksBeforeClose.length,
    keyChunkCount: chunksBeforeClose.filter((chunk) => chunk.type === "key").length,
    outputTimestamps: chunksBeforeClose.map((chunk) => chunk.timestamp),
    outputThrowsQueueSizeAfterEncode: throwingEncoder.queueSizeAfterEncode,
    outputThrowsQueueSizeAfterWait: throwingEncoder.queueSizeAfterWait,
    outputThrowsChunkCount: throwingEncoder.chunkCount,
    outputThrowsUncaughtMessages: throwingEncoder.uncaughtMessages,
    queueSizeBeforeWorkerError: workerError.queueSizeBeforeError,
    queueSizeAfterWorkerError: workerError.queueSizeAfterError,
    queueSizeAfterEncodePostError: workerError.queueSizeAfterEncodePostError,
    stateAfterWorkerError: workerError.stateAfterError,
    workerErrorNotifyMessages: workerError.notifyMessages,
    queueSizeBeforeFailedConfigure: failedConfigure.queueSizeBeforeFailedConfigure,
    queueSizeAfterFailedConfigure: failedConfigure.queueSizeAfterFailedConfigure,
    stateAfterFailedConfigure: failedConfigure.stateAfterFailedConfigure,
    failedConfigureMessage: failedConfigure.configureMessage,
    failedConfigureNotifyMessages: failedConfigure.notifyMessages,
    queueSizeBeforeReconfigureWait: reconfigureWait.queueSizeBeforeReconfigure,
    queueSizeDuringReconfigureWait: reconfigureWait.queueSizeDuringReconfigure,
    queueSizeAfterReconfigureWait: reconfigureWait.queueSizeAfterReconfigure,
    reconfigureWaitErrorMessages: reconfigureWait.errorMessages,
  };
}

/**
 * devtools の EncoderWrapper が configure() の待機中に close() された場合の契約を検証する
 *
 * Worker モードの configure() は Worker を生成し、初期化の応答を待つ。その間に close() が
 * 始まる経路は到達し得る (配信の停止操作と、WebTransport の close / error から
 * cleanupPublisher() が close() を呼ぶ)。close() は Worker の配送口を外して terminate する
 * ため、中断を届けないと待機中の configure() の Promise が未解決のまま残り、呼び出し側
 * (映像配信の開始処理) が永久に待ち続ける。追い越しとして失敗することをイベント順と state で
 * 観測し、あわせて close() のあとにやり直した configure() が成功して実フレームを符号化できる
 * ことを確認する (解放で Wrapper は壊れない)。
 */
export async function runDevtoolsEncoderCloseDuringConfigureTest(): Promise<DevtoolsEncoderCloseDuringConfigureTestResult> {
  const events: string[] = [];
  const observedChunks: ObservedEncodedChunk[] = [];
  const errorMessages: string[] = [];

  const encoder = new EncoderWrapper(true, {
    output: (chunk) => {
      observedChunks.push(summarizeEncodedChunk(chunk));
    },
    error: (error) => {
      errorMessages.push(error.message);
    },
  });

  const config = getVideoEncoderConfig(
    "vp8",
    VIDEO_WIDTH,
    VIDEO_HEIGHT,
    VIDEO_BITRATE,
    VIDEO_FRAMERATE,
  );

  // await を挟まずに configure() と close() を呼ぶ。configure() は Worker を同期で生成して
  // 初期化の応答を待つため、解放が先に走る
  events.push("configure started");
  const pending = encoder.configure(config);
  events.push("close called");
  encoder.close();

  const settle = await observeConfigureSettle(pending);
  events.push(settle.event);

  const stateAfterAbortedConfigure = encoder.state;
  const queueSizeAfterAbortedConfigure = encoder.encodeQueueSize;

  // 解放のあとは configured でないため、encode しても Worker へ送らない (数が増えない)。
  // Worker へ送っていないため所有権は移らない。テスト側で閉じる
  const afterAbortFrame = createTestVideoFrame(VIDEO_WIDTH, VIDEO_HEIGHT, pickFrameColor(0), 0);
  encoder.encode(afterAbortFrame, { keyFrame: true });
  afterAbortFrame.close();
  const queueSizeAfterEncodePostAbort = encoder.encodeQueueSize;

  // 解放のあとにやり直した configure() は成功し、実フレームを符号化できる
  await encoder.configure(config);
  const stateAfterReconfigure = encoder.state;

  // 中断した configure() の Worker からは chunk が届かないため、やり直しの分だけを数える
  const chunkCountBeforeReconfigureEncode = observedChunks.length;
  for (let index = 0; index < ENCODE_FRAME_COUNT; index += 1) {
    const frame = createTestVideoFrame(
      VIDEO_WIDTH,
      VIDEO_HEIGHT,
      pickFrameColor(index),
      index * VIDEO_FRAME_DURATION,
    );
    encoder.encode(frame, { keyFrame: index === 0 });
  }
  const queueSizeAfterReconfigureEncode = encoder.encodeQueueSize;
  await waitForCondition(
    () => observedChunks.length - chunkCountBeforeReconfigureEncode >= ENCODE_FRAME_COUNT,
    `${ENCODE_FRAME_COUNT} encoded video chunks after the configure following the aborted configure`,
  );
  const queueSizeAfterReconfigureWait = encoder.encodeQueueSize;
  const chunkCountAfterReconfigure = observedChunks.length - chunkCountBeforeReconfigureEncode;

  encoder.close();

  return {
    test: "devtoolsEncoderCloseDuringConfigure",
    useWorker: true,
    encodeFrameCount: ENCODE_FRAME_COUNT,
    events,
    configureErrorMessage: settle.errorMessage,
    stateAfterAbortedConfigure,
    queueSizeAfterAbortedConfigure,
    queueSizeAfterEncodePostAbort,
    stateAfterReconfigure,
    chunkCountAfterReconfigure,
    queueSizeAfterReconfigureEncode,
    queueSizeAfterReconfigureWait,
    errorMessages,
  };
}

/**
 * 待機中の configure() が settle したかを一定時間だけ待って観測する
 *
 * 中断が届かない実装では configure() の Promise が未解決のまま残る。これを await すると
 * e2e のタイムアウト (30 秒) まで原因が分からないため、一定時間だけ待って結果に残す。
 * 正しい実装では中断が close() から同期で届くため、Worker の初期化の速さには依存しない。
 */
async function observeConfigureSettle(
  pending: Promise<void>,
): Promise<{ event: string; errorMessage: string | null }> {
  let event = "configure not settled";
  let errorMessage: string | null = null;
  // reject も受ける (握らないと未処理の rejection になる)。中断が届かない実装では
  // どちらの処理も走らない
  void pending.then(
    () => {
      event = "configure resolved";
    },
    (error: unknown) => {
      event = "configure rejected";
      errorMessage = error instanceof Error ? error.message : String(error);
    },
  );
  await waitForDuration(CONFIGURE_SETTLE_OBSERVE_MS);
  return { event, errorMessage };
}

/**
 * 1 件目の output が例外を投げても、待機後に送信中の数が 0 に戻ることを観測する
 *
 * output コールバックは呼び出し側 (テスト) が用意する実物であり、モックは使わない。
 * 例外が実際に外へ出たことは、ブラウザが報告する未処理のエラーから確認する
 * (例外が起きていなければ、この観測は何も固定しない)。
 */
async function runOutputThrowsTest(): Promise<{
  queueSizeAfterEncode: number;
  queueSizeAfterWait: number;
  chunkCount: number;
  uncaughtMessages: string[];
}> {
  const uncaughtMessages: string[] = [];
  const recordUncaughtError = (event: ErrorEvent): void => {
    uncaughtMessages.push(event.message);
  };
  window.addEventListener("error", recordUncaughtError);

  let chunkCount = 0;
  const encoder = new EncoderWrapper(true, {
    output: () => {
      chunkCount += 1;
      if (chunkCount === 1) {
        // 1 件目だけ例外にする。output の後に減算する実装だと、このフレームの数が戻らない
        throw new Error("output callback failed on purpose");
      }
    },
    error: () => {
      // output の例外は error コールバックには届かない (ここへ来たら観測の前提が崩れる)
    },
  });

  try {
    await encoder.configure(
      getVideoEncoderConfig("vp8", VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_BITRATE, VIDEO_FRAMERATE),
    );

    for (let index = 0; index < ENCODE_FRAME_COUNT; index += 1) {
      const frame = createTestVideoFrame(
        VIDEO_WIDTH,
        VIDEO_HEIGHT,
        pickFrameColor(index),
        index * VIDEO_FRAME_DURATION,
      );
      encoder.encode(frame, { keyFrame: index === 0 });
    }
    const queueSizeAfterEncode = encoder.encodeQueueSize;

    await waitForCondition(
      () => chunkCount >= ENCODE_FRAME_COUNT,
      `${ENCODE_FRAME_COUNT} encoded video chunks while the output callback throws`,
    );
    // 例外を投げた 1 件目も含めて、すべてのフレームの数が戻っている
    const queueSizeAfterWait = encoder.encodeQueueSize;

    // 例外が実際に外へ出たことを確認する (event.message は "Uncaught Error: ..." になる)
    await waitForCondition(
      () => uncaughtMessages.length > 0,
      "the uncaught error reported by the output callback",
    );

    return { queueSizeAfterEncode, queueSizeAfterWait, chunkCount, uncaughtMessages };
  } finally {
    encoder.close();
    window.removeEventListener("error", recordUncaughtError);
  }
}

/**
 * Worker が error 応答を返した後は送信中の数が 0 に戻り、投入を止めることを観測する
 *
 * 設定できない codec の config を渡すと、Worker 内の VideoEncoder は configure を受け付けて
 * 最初の encode で失敗し、error コールバックから error 応答が届く (実ブラウザの挙動)。
 * このとき未応答のフレームが残っていても、数が 0 に戻らないと閾値を超えたまま張り付いて
 * 以後すべてのフレームが破棄される。
 */
async function runWorkerErrorTest(): Promise<{
  queueSizeBeforeError: number;
  queueSizeAfterError: number;
  queueSizeAfterEncodePostError: number;
  stateAfterError: string;
  notifyMessages: string[];
}> {
  const notifyMessages: string[] = [];
  let chunkCount = 0;
  const encoder = new EncoderWrapper(true, {
    output: () => {
      chunkCount += 1;
    },
    error: (error) => {
      notifyMessages.push(error.message);
    },
  });

  try {
    await encoder.configure(
      getVideoEncoderConfig("vp8", VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_BITRATE, VIDEO_FRAMERATE),
    );

    // 設定できていることと出力を確かめる (以降の失敗が codec によるものだと分かる)
    for (let index = 0; index < ENCODE_FRAME_COUNT; index += 1) {
      const frame = createTestVideoFrame(
        VIDEO_WIDTH,
        VIDEO_HEIGHT,
        pickFrameColor(index),
        index * VIDEO_FRAME_DURATION,
      );
      encoder.encode(frame, { keyFrame: index === 0 });
    }
    await waitForCondition(
      () => chunkCount >= ENCODE_FRAME_COUNT,
      `${ENCODE_FRAME_COUNT} encoded video chunks before the worker error`,
    );

    // 設定できない codec で再 configure する。ブラウザは configure を受け付けて encode で
    // 初めて失敗するため、configure が reject した場合は初期化の失敗になり、初期化後の
    // error 応答を駆動できない。その場で失敗させ、失敗した config を見直せるようにする
    try {
      await encoder.configure({
        codec: UNSETTABLE_CODEC,
        width: VIDEO_WIDTH,
        height: VIDEO_HEIGHT,
      });
    } catch (error) {
      throw new Error("the browser rejected the unsupported codec at configure", { cause: error });
    }

    // 応答を待たないフレームを投入する (1 件目が encode で失敗して error 応答が届く)。
    // 同期的に投入するため、error 応答が届くのはこの処理が終わった後になる
    for (let index = 0; index < ENCODE_FRAME_COUNT; index += 1) {
      const frame = createTestVideoFrame(
        VIDEO_WIDTH,
        VIDEO_HEIGHT,
        pickFrameColor(index),
        (ENCODE_FRAME_COUNT + index) * VIDEO_FRAME_DURATION,
      );
      encoder.encode(frame, { keyFrame: index === 0 });
    }
    const queueSizeBeforeError = encoder.encodeQueueSize;

    // error 応答が届くまで待つ (encode で初めて失敗するため、configure の応答では分からない)
    await waitForCondition(
      () => notifyMessages.length > 0,
      "the error response from the worker encoder",
    );
    const stateAfterError = encoder.state;
    const queueSizeAfterError = encoder.encodeQueueSize;

    // 失敗後は configured でないため、encode しても Worker へ送らない (数が増えない)
    const afterErrorFrame = createTestVideoFrame(VIDEO_WIDTH, VIDEO_HEIGHT, pickFrameColor(0), 0);
    encoder.encode(afterErrorFrame, { keyFrame: true });
    // Worker へ送っていないため所有権は移らない。テスト側で閉じる
    afterErrorFrame.close();
    const queueSizeAfterEncodePostError = encoder.encodeQueueSize;

    return {
      queueSizeBeforeError,
      queueSizeAfterError,
      queueSizeAfterEncodePostError,
      stateAfterError,
      notifyMessages,
    };
  } finally {
    encoder.close();
  }
}

/**
 * 初期化に失敗する configure でも送信中の数が残らないことを観測する
 *
 * 再 configure では旧 Worker を先に破棄するため、未応答のフレームに encoded 応答は返らない。
 * 数のリセットが configure の成功後だけだと、失敗した configure の後に数が閾値を超えたまま
 * 張り付いて、以後すべてのフレームが破棄される。設定できない config (幅 0) は実ブラウザの
 * VideoEncoder が configure で例外を投げるため、Worker の初期化失敗を駆動できる。
 */
async function runFailedConfigureTest(): Promise<{
  queueSizeBeforeFailedConfigure: number;
  queueSizeAfterFailedConfigure: number;
  stateAfterFailedConfigure: string;
  configureMessage: string | null;
  notifyMessages: string[];
}> {
  const notifyMessages: string[] = [];
  const encoder = new EncoderWrapper(true, {
    output: () => {
      // 出力は使わない
    },
    error: (error) => {
      notifyMessages.push(error.message);
    },
  });

  try {
    await encoder.configure(
      getVideoEncoderConfig("vp8", VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_BITRATE, VIDEO_FRAMERATE),
    );

    // 応答を待たずに投入し、未応答のフレームを残す
    for (let index = 0; index < ENCODE_FRAME_COUNT; index += 1) {
      const frame = createTestVideoFrame(
        VIDEO_WIDTH,
        VIDEO_HEIGHT,
        pickFrameColor(index),
        index * VIDEO_FRAME_DURATION,
      );
      encoder.encode(frame, { keyFrame: index === 0 });
    }
    const queueSizeBeforeFailedConfigure = encoder.encodeQueueSize;

    // 幅 0 の config は Worker 内の VideoEncoder の configure が例外になり、初期化が失敗する
    let configureMessage: string | null = null;
    try {
      await encoder.configure({ codec: "vp8", width: 0, height: 0 });
    } catch (error) {
      configureMessage = error instanceof Error ? error.message : String(error);
    }
    const stateAfterFailedConfigure = encoder.state;
    const queueSizeAfterFailedConfigure = encoder.encodeQueueSize;

    return {
      queueSizeBeforeFailedConfigure,
      queueSizeAfterFailedConfigure,
      stateAfterFailedConfigure,
      configureMessage,
      notifyMessages,
    };
  } finally {
    encoder.close();
  }
}

/**
 * 再 configure の応答を待つ間に新しい Worker へ送ったフレームの数が消えないことを観測する
 *
 * configure() は Worker を作った後に初期化の応答を待つ。その間も configured は true のため、
 * 投入したフレームは新しい Worker へ送られて数えられる。数のリセットが configure の完了後だと、
 * 待機中に送ったフレームの数まで消えて実際より少なく見える (過少カウント)。
 */
async function runReconfigureWaitTest(): Promise<{
  queueSizeBeforeReconfigure: number;
  queueSizeDuringReconfigure: number;
  queueSizeAfterReconfigure: number;
  errorMessages: string[];
}> {
  const errorMessages: string[] = [];
  const encoder = new EncoderWrapper(true, {
    output: () => {
      // 出力は使わない (送信中の数だけを観測する)
    },
    error: (error) => {
      errorMessages.push(error.message);
    },
  });

  try {
    await encoder.configure(
      getVideoEncoderConfig("vp8", VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_BITRATE, VIDEO_FRAMERATE),
    );

    // 応答を待たずに投入し、旧 Worker の未応答の数を残す
    for (let index = 0; index < ENCODE_FRAME_COUNT; index += 1) {
      const frame = createTestVideoFrame(
        VIDEO_WIDTH,
        VIDEO_HEIGHT,
        pickFrameColor(index),
        index * VIDEO_FRAME_DURATION,
      );
      encoder.encode(frame, { keyFrame: index === 0 });
    }
    const queueSizeBeforeReconfigure = encoder.encodeQueueSize;

    // configure を待たずに呼び出し、初期化の応答を待つ間に投入する。Worker は configure() の
    // 呼び出しの中で作られるため、この投入は新しい Worker へ送られて数えられる
    const pending = encoder.configure(
      getVideoEncoderConfig(
        "vp8",
        RECONFIGURE_WIDTH,
        RECONFIGURE_HEIGHT,
        VIDEO_BITRATE,
        VIDEO_FRAMERATE,
      ),
    );
    for (let index = 0; index < ENCODE_FRAME_COUNT; index += 1) {
      const frame = createTestVideoFrame(
        VIDEO_WIDTH,
        VIDEO_HEIGHT,
        pickFrameColor(index),
        (ENCODE_FRAME_COUNT + index) * VIDEO_FRAME_DURATION,
      );
      encoder.encode(frame, { keyFrame: index === 0 });
    }
    const queueSizeDuringReconfigure = encoder.encodeQueueSize;

    await pending;
    // 待機中に送った分が reset で消えていなければ、応答が返る前の数がそのまま残る
    const queueSizeAfterReconfigure = encoder.encodeQueueSize;

    return {
      queueSizeBeforeReconfigure,
      queueSizeDuringReconfigure,
      queueSizeAfterReconfigure,
      errorMessages,
    };
  } finally {
    encoder.close();
  }
}

/**
 * 旧世代の Worker が初期化に失敗した後でも configure が解決することを観測する
 *
 * 初期化に失敗した configure は reject し、失敗した Worker を破棄して configured を false に
 * 戻す。この後始末が今の Worker や後発の configure の待機を巻き込むと、解決するはずの
 * configure が失敗したり、未解決のまま残ったりする。次の 2 つの順序を同じ runner で確認する。
 *
 * 1. 旧世代 (初期化に失敗する設定) の configure を待たずに後発 (成功する設定) の configure を
 *    呼ぶ。後発は旧世代を破棄してから Worker を作るため、旧世代の初期化の失敗は届かない。
 *    旧世代は追い越しで失敗し、後発が構成を持つ
 * 2. 旧世代の configure の reject を待ってから configure し直す。失敗した Worker は
 *    破棄済みのためやり直しは成功する
 */
export async function runDevtoolsEncoderFailedWorkerConfigureTest(): Promise<DevtoolsEncoderFailedWorkerConfigureTestResult> {
  const superseded = await runSupersededFailingConfigureTest();
  const retry = await runRetryAfterFailedConfigureTest();

  return {
    test: "devtoolsEncoderFailedWorkerConfigure",
    useWorker: true,
    encodeFrameCount: ENCODE_FRAME_COUNT,
    firstConfigureErrorMessage: superseded.firstConfigureErrorMessage,
    secondConfigureErrorMessage: superseded.secondConfigureErrorMessage,
    stateAfterSecondConfigure: superseded.stateAfterSecondConfigure,
    secondChunkCount: superseded.secondChunkCount,
    queueSizeAfterSecondEncode: superseded.queueSizeAfterSecondEncode,
    queueSizeAfterSecondWait: superseded.queueSizeAfterSecondWait,
    secondErrorMessages: superseded.errorMessages,
    failedConfigureMessage: retry.failedConfigureMessage,
    stateAfterFailedConfigure: retry.stateAfterFailedConfigure,
    queueSizeAfterFailedConfigure: retry.queueSizeAfterFailedConfigure,
    retryConfigureErrorMessage: retry.retryConfigureErrorMessage,
    stateAfterRetry: retry.stateAfterRetry,
    retryChunkCount: retry.retryChunkCount,
    queueSizeAfterRetryEncode: retry.queueSizeAfterRetryEncode,
    queueSizeAfterRetryWait: retry.queueSizeAfterRetryWait,
    errorMessages: retry.errorMessages,
  };
}

/**
 * 旧世代の Worker の応答を待たずに後発の configure を呼んだ場合を観測する
 *
 * await を挟まずに呼ぶため、後発の configure が旧世代を破棄してから新しい Worker を作る。
 * 旧世代の Worker は配送口を外して terminate されるため、旧世代の初期化の失敗は後発の
 * 待機中に届かない (届けば、後発の待機を中断させてしまう)。
 */
async function runSupersededFailingConfigureTest(): Promise<{
  firstConfigureErrorMessage: string | null;
  secondConfigureErrorMessage: string | null;
  stateAfterSecondConfigure: string;
  secondChunkCount: number;
  queueSizeAfterSecondEncode: number;
  queueSizeAfterSecondWait: number;
  errorMessages: string[];
}> {
  const errorMessages: string[] = [];
  let chunkCount = 0;
  const encoder = new EncoderWrapper(true, {
    output: () => {
      chunkCount += 1;
    },
    error: (error) => {
      errorMessages.push(error.message);
    },
  });

  /**
   * configure の結果 (失敗理由) を取り出す
   *
   * 成功した場合は null になる。
   */
  const observeConfigure = async (pending: Promise<void>): Promise<string | null> => {
    try {
      await pending;
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  try {
    // await を挟まずに呼ぶ (旧世代の初期化の応答を待たない)
    const first = observeConfigure(encoder.configure({ codec: "vp8", width: 0, height: 0 }));
    const second = observeConfigure(
      encoder.configure(
        getVideoEncoderConfig("vp8", VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_BITRATE, VIDEO_FRAMERATE),
      ),
    );
    const firstConfigureErrorMessage = await first;
    const secondConfigureErrorMessage = await second;
    const stateAfterSecondConfigure = encoder.state;

    // 後発の configure が解決しなかった場合は、この後の待機がタイムアウトするだけで
    // 原因が分かりにくい。ここまでの観測をそのまま返し、e2e の assert に失敗させる
    if (secondConfigureErrorMessage !== null || stateAfterSecondConfigure !== "configured") {
      return {
        firstConfigureErrorMessage,
        secondConfigureErrorMessage,
        stateAfterSecondConfigure,
        secondChunkCount: chunkCount,
        queueSizeAfterSecondEncode: encoder.encodeQueueSize,
        queueSizeAfterSecondWait: encoder.encodeQueueSize,
        errorMessages,
      };
    }

    // 差し替えた Worker で実フレームを符号化できる (破棄で Wrapper は壊れない)
    for (let index = 0; index < ENCODE_FRAME_COUNT; index += 1) {
      const frame = createTestVideoFrame(
        VIDEO_WIDTH,
        VIDEO_HEIGHT,
        pickFrameColor(index),
        index * VIDEO_FRAME_DURATION,
      );
      encoder.encode(frame, { keyFrame: index === 0 });
    }
    const queueSizeAfterSecondEncode = encoder.encodeQueueSize;
    await waitForCondition(
      () => chunkCount >= ENCODE_FRAME_COUNT,
      `${ENCODE_FRAME_COUNT} encoded video chunks after the configure that superseded a failing worker`,
    );
    const queueSizeAfterSecondWait = encoder.encodeQueueSize;

    return {
      firstConfigureErrorMessage,
      secondConfigureErrorMessage,
      stateAfterSecondConfigure,
      secondChunkCount: chunkCount,
      queueSizeAfterSecondEncode,
      queueSizeAfterSecondWait,
      errorMessages,
    };
  } finally {
    encoder.close();
  }
}

/**
 * 初期化に失敗した configure の後に configure し直した場合を観測する
 *
 * 失敗した configure は Worker を破棄し、送信中の数を 0 に戻して configured を false にする。
 * ここで今の Worker を消し漏らしたり、待機の中断を残したりすると、やり直しの configure が
 * 解決しない (または解決しても投入が止まったままになる)。
 */
async function runRetryAfterFailedConfigureTest(): Promise<{
  failedConfigureMessage: string | null;
  stateAfterFailedConfigure: string;
  queueSizeAfterFailedConfigure: number;
  retryConfigureErrorMessage: string | null;
  stateAfterRetry: string;
  retryChunkCount: number;
  queueSizeAfterRetryEncode: number;
  queueSizeAfterRetryWait: number;
  errorMessages: string[];
}> {
  const errorMessages: string[] = [];
  let chunkCount = 0;
  const encoder = new EncoderWrapper(true, {
    output: () => {
      chunkCount += 1;
    },
    error: (error) => {
      errorMessages.push(error.message);
    },
  });

  try {
    // 幅 0 の config は Worker 内の VideoEncoder の configure が例外になり、初期化が失敗する。
    // 失敗の処理が済んだ状態にするため、reject を待つ
    let failedConfigureMessage: string | null = null;
    try {
      await encoder.configure({ codec: "vp8", width: 0, height: 0 });
    } catch (error) {
      failedConfigureMessage = error instanceof Error ? error.message : String(error);
    }
    const stateAfterFailedConfigure = encoder.state;
    const queueSizeAfterFailedConfigure = encoder.encodeQueueSize;

    // やり直しの configure は成功し、実フレームを符号化できる
    let retryConfigureErrorMessage: string | null = null;
    try {
      await encoder.configure(
        getVideoEncoderConfig("vp8", VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_BITRATE, VIDEO_FRAMERATE),
      );
    } catch (error) {
      retryConfigureErrorMessage = error instanceof Error ? error.message : String(error);
    }
    const stateAfterRetry = encoder.state;

    // やり直しが失敗した場合は、この後の待機がタイムアウトするだけで原因が分かりにくい。
    // ここまでの観測をそのまま返し、e2e の assert に失敗させる
    if (retryConfigureErrorMessage !== null || stateAfterRetry !== "configured") {
      return {
        failedConfigureMessage,
        stateAfterFailedConfigure,
        queueSizeAfterFailedConfigure,
        retryConfigureErrorMessage,
        stateAfterRetry,
        retryChunkCount: chunkCount,
        queueSizeAfterRetryEncode: encoder.encodeQueueSize,
        queueSizeAfterRetryWait: encoder.encodeQueueSize,
        errorMessages,
      };
    }

    for (let index = 0; index < ENCODE_FRAME_COUNT; index += 1) {
      const frame = createTestVideoFrame(
        VIDEO_WIDTH,
        VIDEO_HEIGHT,
        pickFrameColor(index),
        index * VIDEO_FRAME_DURATION,
      );
      encoder.encode(frame, { keyFrame: index === 0 });
    }
    const queueSizeAfterRetryEncode = encoder.encodeQueueSize;
    await waitForCondition(
      () => chunkCount >= ENCODE_FRAME_COUNT,
      `${ENCODE_FRAME_COUNT} encoded video chunks after the configure that follows a failed configure`,
    );
    const queueSizeAfterRetryWait = encoder.encodeQueueSize;

    return {
      failedConfigureMessage,
      stateAfterFailedConfigure,
      queueSizeAfterFailedConfigure,
      retryConfigureErrorMessage,
      stateAfterRetry,
      retryChunkCount: chunkCount,
      queueSizeAfterRetryEncode,
      queueSizeAfterRetryWait,
      errorMessages,
    };
  } finally {
    encoder.close();
  }
}
