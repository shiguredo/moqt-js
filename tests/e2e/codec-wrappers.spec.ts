import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type {
  AudioDecoderTestResult,
  AudioEncoderTestResult,
  AudioSamplesTestResult,
  CodecTestName,
  CodecTestResultMap,
  DevtoolsDecoderCloseDuringConfigureTestResult,
  DevtoolsDecoderConcurrentConfigureTestResult,
  DevtoolsDecoderResetBudgetTestResult,
  DevtoolsDecoderUnsupportedCodecTestResult,
  DevtoolsEncoderCloseDuringConfigureTestResult,
  DevtoolsEncoderFailedWorkerConfigureTestResult,
  DevtoolsEncoderWorkerTestResult,
  VideoDecoderCloseDuringConfigureTestResult,
  VideoDecoderConcurrentResetTestResult,
  VideoDecoderResetBudgetTestResult,
  VideoDecoderRestoreTestResult,
  VideoDecoderTestResult,
  VideoDecoderUnsupportedCodecTestResult,
  VideoEncoderReconfigureTestResult,
  VideoEncoderTestResult,
} from "../../devtools/src/codec-test/types";
// 非対応 codec の候補順はテストページと共有する (選定結果の並びを突き合わせる)
import { VIDEO_CODEC_CANDIDATES } from "../../devtools/src/codec-test/support";

// codec Wrapper / Worker プロトコルの契約テスト
//
// devtools/src/codec-test のテストページを開き、実 Chromium の WebCodecs と
// 実 Worker で encode / decode を実行して契約を pin する。モックやスタブは使わない。
// ページ側のテストは結果を JSON で返し、失敗時は reject するため、
// page.evaluate の reject がそのままテストの失敗になる。
// dev サーバーは playwright.config.ts の webServer で起動される (port 5173)
const CODEC_TEST_URL = "http://localhost:5173/codec-test.html";

// テストページのパラメータ (devtools/src/codec-test/support.ts と一致させる)
const VIDEO_WIDTH = 320;
const VIDEO_HEIGHT = 240;
// 30fps のフレーム間隔 (マイクロ秒)
const VIDEO_FRAME_DURATION = 33333;
// 音声は 48kHz ステレオで 1 秒分を投入する
const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 2;

/**
 * テストページを開き、テスト実行関数が公開されるまで待つ
 *
 * @param page - 対象ページ
 * @param search - クエリ文字列 (先頭の `?` を含む)。テストページのパラメータを
 *   差し替えて実行条件を変える場合に指定する
 */
async function openCodecTestPage(page: Page, search = ""): Promise<void> {
  await page.goto(`${CODEC_TEST_URL}${search}`);
  await page.waitForFunction(() => {
    const runner = (window as unknown as { runCodecTest?: unknown }).runCodecTest;
    return typeof runner === "function";
  });
}

/**
 * テストページの window.runCodecTest を呼び出して結果を取得する
 */
async function runCodecTest<Name extends CodecTestName>(
  page: Page,
  name: Name,
): Promise<CodecTestResultMap[Name]> {
  const result = await page.evaluate(async (testName: string) => {
    const runner = (window as unknown as { runCodecTest: (name: string) => Promise<unknown> })
      .runCodecTest;
    if (typeof runner !== "function") {
      throw new Error("codec test page did not expose window.runCodecTest");
    }
    // runner が返す Promise をそのまま返し、Playwright 側で解決させる
    return runner(testName);
  }, name);
  return result as CodecTestResultMap[Name];
}

/**
 * 数値配列が狭義単調増加であることを検証する
 */
function expectMonotonicIncrease(values: number[]): void {
  for (let index = 1; index < values.length; index += 1) {
    expect(values[index]).toBeGreaterThan(values[index - 1]);
  }
}

// ============================================================================
// VideoEncoderWrapper
// ============================================================================

/**
 * VideoEncoderWrapper の実行モードに依存しない契約を検証する
 *
 * 状態遷移・未設定時の encode()・keyFrame 指定・chunk の形・close() 後の挙動は
 * 直接モードと Worker モードで同一であることを pin する。
 */
function expectVideoEncoderContract(result: VideoEncoderTestResult): void {
  // configure 前は unconfigured、configure 後は configured、close 後は unconfigured に戻る
  expect(result.stateHistory).toEqual([
    { step: "initial", state: "unconfigured" },
    { step: "afterUnconfiguredEncode", state: "unconfigured" },
    { step: "afterConfigure", state: "configured" },
    { step: "afterEncode", state: "configured" },
    { step: "afterClose", state: "unconfigured" },
  ]);

  // 未設定時の encode() は undefined を返し、chunk も error も出さない
  expect(result.unconfiguredEncode).toEqual({
    returnValueType: "undefined",
    state: "unconfigured",
    outputCount: 0,
    errorCount: 0,
  });
  expect(result.unconfiguredEncodeQueueSize).toBe(0);

  // 6 フレームを投入し、先頭と 4 番目だけ keyFrame: true を指定する
  expect(result.chunkCount).toBe(6);
  expect(result.keyChunkCount).toBe(2);
  expect(result.chunks.map((chunk) => chunk.type)).toEqual([
    "key",
    "delta",
    "delta",
    "key",
    "delta",
    "delta",
  ]);
  expect(result.forcedKeyFrameChunkType).toBe("key");

  // 投入した VideoFrame の timestamp がそのまま chunk に載る
  expect(result.outputTimestamps).toEqual([0, 33333, 66666, 99999, 133332, 166665]);

  // vp8 の chunk は実データと duration を持ち、description は持たない
  for (const chunk of result.chunks) {
    expect(chunk.byteLength).toBeGreaterThan(0);
    expect(chunk.duration).not.toBeNull();
    expect(chunk.descriptionByteLength).toBeNull();
  }

  // close() 後の encode() も何も起きない
  expect(result.encodeAfterClose).toEqual({
    returnValueType: "undefined",
    state: "unconfigured",
    outputCount: 6,
    errorCount: 0,
  });

  // error コールバックは一度も呼ばれない
  expect(result.errorMessages).toEqual([]);
}

test("VideoEncoderWrapper 直接モード: 状態遷移と keyFrame 指定と chunk 出力", async ({ page }) => {
  await openCodecTestPage(page);

  const result = await runCodecTest(page, "videoEncoderDirect");

  // 直接モードでは Worker を生成せず VideoEncoder を直接使う
  expect(result.test).toBe("videoEncoderDirect");
  expect(result.useWorker).toBe(false);
  expectVideoEncoderContract(result);

  // configure 直後のキューは空で、6 フレーム投入直後は 6 件が未処理で残る。
  // 出力を待つとキューは空に戻る
  expect(result.queueSizeAfterConfigure).toBe(0);
  expect(result.queueSizeIsNonNegativeInteger).toBe(true);
  expect(result.queueSizeAfterEncode).toBe(6);
  expect(result.queueSizeAfterOutputWait).toBe(0);
  // 未応答のフレームを残したまま close してもキューは 0 に戻る。
  // 直接モードの encodeQueueSize は実キュー長のため、待機中の正確な件数は実装依存
  expect(result.queueSizeBeforeClose).toBeGreaterThan(0);
  expect(result.queueSizeAfterClose).toBe(0);
});

test("VideoEncoderWrapper Worker モード: Worker 経由でも同じ契約が成立する", async ({ page }) => {
  await openCodecTestPage(page);

  const result = await runCodecTest(page, "videoEncoderWorker");

  // Worker モードでは init → configured → encoded の往復で同じ結果になる
  expect(result.test).toBe("videoEncoderWorker");
  expect(result.useWorker).toBe(true);
  expectVideoEncoderContract(result);

  // Worker モードの encodeQueueSize は Worker へ送信してまだ encoded 応答が返っていない
  // フレーム数 (Worker 内のキュー長は取得できないため上限側の近似)。
  // 出力待機前は投入した 6 件、出力を待つと 0 に戻る (直接モードと同じ契約で扱える)
  expect(result.queueSizeAfterConfigure).toBe(0);
  expect(result.queueSizeIsNonNegativeInteger).toBe(true);
  expect(result.queueSizeAfterEncode).toBe(6);
  expect(result.queueSizeAfterOutputWait).toBe(0);
  // 未応答のフレームを残したまま close してもキューは 0 に戻る (Worker の差し替えも同じ扱い)
  expect(result.queueSizeBeforeClose).toBe(6);
  expect(result.queueSizeAfterClose).toBe(0);
});

test("VideoEncoderWrapper 未設定時: encode() は例外を投げず何もしない", async ({ page }) => {
  await openCodecTestPage(page);

  for (const name of ["videoEncoderDirect", "videoEncoderWorker"] as const) {
    const result = await runCodecTest(page, name);

    // configure 前も close 後も、encode() は undefined を返して chunk を出さない
    expect(result.unconfiguredEncode).toEqual({
      returnValueType: "undefined",
      state: "unconfigured",
      outputCount: 0,
      errorCount: 0,
    });
    expect(result.unconfiguredEncodeQueueSize).toBe(0);
    expect(result.encodeAfterClose).toEqual({
      returnValueType: "undefined",
      state: "unconfigured",
      outputCount: result.chunkCount,
      errorCount: 0,
    });
  }
});

// ============================================================================
// VideoDecoderWrapper
// ============================================================================

/**
 * VideoDecoderWrapper の実行モードに依存しない契約を検証する
 *
 * 参照 chunk はテストページ側で実 VideoEncoderWrapper (vp8 / 320x240) から
 * 生成した key 1 件 + delta 2 件である。
 */
function expectVideoDecoderContract(result: VideoDecoderTestResult): void {
  // 参照 chunk は vp8 のため description (コーデック初期化データ) を持たない
  expect(result.inputChunkCount).toBe(3);
  expect(result.descriptionByteLength).toBeNull();

  // 未設定時の decode() は実 chunk を渡しても undefined を返し、何も復号しない
  expect(result.unconfiguredDecode).toEqual({
    returnValueType: "undefined",
    outputCount: 0,
    errorCount: 0,
  });

  // configure 直後はキーフレーム待ちであり、delta chunk は出力を生まない
  expect(result.framesAfterDeltaBeforeKey).toBe(0);

  // key + delta 2 件で 3 フレームが復号される (frameCount は再開確認の 1 件を含む)
  expect(result.frames).toHaveLength(3);
  expect(result.frameCount).toBe(4);

  // codedWidth / codedHeight は configure に渡した値と一致する
  for (const frame of result.frames) {
    expect(frame.codedWidth).toBe(VIDEO_WIDTH);
    expect(frame.codedHeight).toBe(VIDEO_HEIGHT);
    expect(frame.displayWidth).toBe(VIDEO_WIDTH);
    expect(frame.displayHeight).toBe(VIDEO_HEIGHT);
    expect(frame.format).not.toBeNull();
    // RGBA で読み出した実データが入っている
    expect(frame.rgbaByteLength).toBe(VIDEO_WIDTH * VIDEO_HEIGHT * 4);
    expect(frame.rgbaNonZeroByteCount).toBeGreaterThan(0);
  }

  // 投入した chunk の timestamp がそのまま復号フレームに載る
  expect(result.frameTimestamps).toEqual([0, VIDEO_FRAME_DURATION, VIDEO_FRAME_DURATION * 2]);

  // 先頭フレームは赤で塗った canvas 由来のため、左上ピクセルは赤が支配的になる
  const firstFrame = result.frames[0];
  expect(firstFrame.firstPixel[0]).toBeGreaterThan(128);
  expect(firstFrame.firstPixel[1]).toBeLessThan(64);
  expect(firstFrame.firstPixel[2]).toBeLessThan(64);
  expect(firstFrame.firstPixel[3]).toBe(255);

  // resetKeyframeWait() 後は delta chunk が再びスキップされ、key chunk で復号が再開する
  expect(result.framesAfterResetKeyframeWaitDelta).toBe(3);
  expect(result.resumedAfterResetKeyframeWait).toBe(true);

  // close() 後の decode() も実 chunk を渡して何も復号しない
  expect(result.decodeAfterClose).toEqual({
    returnValueType: "undefined",
    outputCount: 4,
    errorCount: 0,
  });

  // error コールバックは一度も呼ばれない
  expect(result.errorMessages).toEqual([]);
}

test("VideoDecoderWrapper 直接モード: キーフレーム待ちと復号フレーム", async ({ page }) => {
  await openCodecTestPage(page);

  const result = await runCodecTest(page, "videoDecoderDirect");

  // 直接モードでは Worker を生成せず VideoDecoder を直接使う
  expect(result.test).toBe("videoDecoderDirect");
  expect(result.useWorker).toBe(false);
  expectVideoDecoderContract(result);
});

test("VideoDecoderWrapper Worker モード: Worker 経由の復号と resetKeyframeWait", async ({
  page,
}) => {
  await openCodecTestPage(page);

  const result = await runCodecTest(page, "videoDecoderWorker");

  // Worker モードでは init → configured → decoded / skipped の往復で同じ結果になる
  expect(result.test).toBe("videoDecoderWorker");
  expect(result.useWorker).toBe(true);
  expectVideoDecoderContract(result);
});

test("VideoDecoderWrapper 未設定時: decode() は例外を投げず何もしない", async ({ page }) => {
  await openCodecTestPage(page);

  for (const name of ["videoDecoderDirect", "videoDecoderWorker"] as const) {
    const result = await runCodecTest(page, name);

    // configure 前も close 後も、decode() は undefined を返して frame を出さない
    expect(result.unconfiguredDecode).toEqual({
      returnValueType: "undefined",
      outputCount: 0,
      errorCount: 0,
    });
    expect(result.decodeAfterClose).toEqual({
      returnValueType: "undefined",
      outputCount: result.frameCount,
      errorCount: 0,
    });
  }
});

// ============================================================================
// VideoDecoderWrapper の非対応 codec と復帰の予算
// ============================================================================

// 非対応 codec はテストページが実ブラウザで実測して選ぶ
// (devtools/src/codec-test/support.ts の VIDEO_CODEC_CANDIDATES を候補順に試す)。
// 事前確認は Worker の生成 / VideoDecoder の configure の直前にあるため、この経路では
// Worker も VideoDecoder も作られない。テストからは state とエラーメッセージで確認する。

/**
 * 非対応 codec の configure と reset の契約を検証する
 */
function expectVideoDecoderUnsupportedCodecContract(
  result: VideoDecoderUnsupportedCodecTestResult,
): void {
  // 選ばれたのは映像の候補 (VIDEO_CODEC_CANDIDATES) のいずれかであり、configure に
  // 載る codec 文字列 (非対応と判定された実物) が結果に載る
  expect(VIDEO_CODEC_CANDIDATES).toContain(result.codec);
  expect(result.codecString).not.toBe("");

  // 候補は先頭から順に試される。先頭の候補 (vp8) は参照 chunk を符号化する codec であり、
  // 対応と判定されて supportedCodecs に載る。空の場合は検証が空振りするため失敗させる
  expect(result.supportedCodecs.length).toBeGreaterThan(0);

  // 選んだ非対応 codec は supportedCodecs (対応と判定されて除外した候補) に含まれない
  expect(result.supportedCodecs).not.toContain(result.codec);

  // supportedCodecs は選んだ codec の直前までの候補と一致する (順序と対応判定の確認)
  expect([...result.supportedCodecs, result.codec]).toEqual(
    VIDEO_CODEC_CANDIDATES.slice(0, result.supportedCodecs.length + 1),
  );

  // configure 前は unconfigured
  expect(result.stateBeforeConfigure).toBe("unconfigured");

  // isConfigSupported が false の codec では Worker も VideoDecoder も作らず、
  // codec 文字列を含むエラーで configure が失敗する
  expect(result.configureErrorMessage).toBe(`Decoder codec not supported: ${result.codecString}`);
  expect(result.stateAfterFailedConfigure).toBe("unconfigured");

  // 同じ config で reset() を呼んでも再初期化せず false を返す。
  // 事前確認が reset() の再初期化経路でも効いていることの確認になる
  expect(result.resetReturned).toBe(false);
  expect(result.stateAfterReset).toBe("unconfigured");

  // configure の失敗も reset() の失敗も何も復号せず、error コールバックも呼ばない
  expect(result.outputCount).toBe(0);
  expect(result.errorMessages).toEqual([]);
}

for (const name of [
  "videoDecoderUnsupportedCodecDirect",
  "videoDecoderUnsupportedCodecWorker",
] as const) {
  test(`VideoDecoderWrapper 非対応 codec: configure と reset が失敗する (${name})`, async ({
    page,
  }) => {
    await openCodecTestPage(page);

    const result = await runCodecTest(page, name);

    expect(result.test).toBe(name);
    expect(result.useWorker).toBe(name === "videoDecoderUnsupportedCodecWorker");
    expectVideoDecoderUnsupportedCodecContract(result);
  });
}

/**
 * 復帰予算の上限と打ち切りの契約を検証する
 */
function expectVideoDecoderResetBudgetContract(result: VideoDecoderResetBudgetTestResult): void {
  // configure 前 (lastConfig が無い) の reset() は false を返し、何も作り直さない
  expect(result.resetWithoutConfig).toBe(false);
  expect(result.stateAfterResetWithoutConfig).toBe("unconfigured");

  // 対応 codec の configure 後は configured
  expect(result.stateAfterConfigure).toBe("configured");

  // 復号フレームを 1 枚も出さないまま同じ config で reset() を呼ぶと、
  // 上限の 3 回が成功し、4 回目で打ち切られる
  expect(result.resetResults).toEqual([true, true, true, false]);

  // 打ち切り後は Worker も VideoDecoder も破棄され、state は unconfigured になる
  expect(result.stateAfterBudgetExhausted).toBe("unconfigured");

  // 以降の decode() は configured = false のため、実 chunk を投入しても復号しない
  // (呼び出しは複数回行い、未構成の警告が 1 回だけであることを別途数える)
  expect(result.decodeAttemptsAfterBudgetExhausted).toBeGreaterThan(1);
  expect(result.framesDecodedAfterBudgetExhausted).toBe(0);

  // reset() の失敗は error コールバックを呼ばない (恒久エラーで通知が増えない)
  expect(result.errorMessages).toEqual([]);
}

/**
 * ページのコンソール出力 (warning) を集める配列を返す
 *
 * テスト本体を実行する前に登録する。ブラウザ側のコードへ手を入れず、
 * 実際に出た警告だけを数える。
 */
function collectConsoleWarnings(page: Page): string[] {
  const warnings: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning") {
      warnings.push(message.text());
    }
  });
  return warnings;
}

/**
 * 未構成のまま decode() が呼ばれたときの警告の件数を数える
 */
function countNotConfiguredWarnings(warnings: readonly string[]): number {
  return warnings.filter((text) => text.includes("VideoDecoderWrapper: not configured")).length;
}

/**
 * devtools の DecoderWrapper が未構成のまま decode() を呼ばれたときの警告の件数を数える
 *
 * ライブラリ側の VideoDecoderWrapper と同じく、未構成の警告は 1 回だけにする。
 * 文言は devtools 側も "DecoderWrapper: not configured" である。
 */
function countDevtoolsDecoderNotConfiguredWarnings(warnings: readonly string[]): number {
  // ライブラリ側は "VideoDecoderWrapper: not configured" と出力するため、
  // 先頭一致で devtools 側だけを数える (includes だとライブラリ側の警告も混ざる)
  return warnings.filter((text) => text.startsWith("DecoderWrapper: not configured")).length;
}

for (const name of ["videoDecoderResetBudgetDirect", "videoDecoderResetBudgetWorker"] as const) {
  test(`VideoDecoderWrapper 予算: 同じ config の reset() は 3 回で打ち切られる (${name})`, async ({
    page,
  }) => {
    await openCodecTestPage(page);
    const warnings = collectConsoleWarnings(page);

    const result = await runCodecTest(page, name);

    expect(result.test).toBe(name);
    expect(result.useWorker).toBe(name === "videoDecoderResetBudgetWorker");
    expectVideoDecoderResetBudgetContract(result);

    // 打ち切り後は未構成のまま decode() が呼ばれ続ける (受信のたびに呼ばれる)。
    // 警告は呼び出しのたびではなく、未構成になった最初の 1 回だけにする
    // (毎回出すと 30 fps の受信で毎秒 30 件の警告になる)
    expect(countNotConfiguredWarnings(warnings)).toBe(1);
  });
}

/**
 * 予算が戻る 2 条件 (復号フレームの出力 / 参照の異なる config) の契約を検証する
 */
function expectVideoDecoderRestoreContract(result: VideoDecoderRestoreTestResult): void {
  // 復号フレームを出さないまま上限まで reset() が成功する
  expect(result.resetResultsBeforeDecodedFrame).toEqual([true, true, true]);

  // 復号フレームを 1 枚出力すると予算が戻るため、次の reset() も成功する
  // (戻らなければ、この reset() は false になる)
  expect(result.frameCount).toBeGreaterThan(0);
  expect(result.resetAfterDecodedFrame).toBe(true);

  // ここまでの reset() で 1 回消費しているため、残り 2 回が成功し 3 回目で打ち切られる
  expect(result.resetResultsBeforeDifferentConfig).toEqual([true, true, false]);

  // 参照の異なる config の configure で予算が戻るため、reset() が再び成功する
  expect(result.resetAfterDifferentConfig).toBe(true);
  expect(result.stateAfterDifferentConfigReset).toBe("configured");

  expect(result.errorMessages).toEqual([]);
}

for (const name of ["videoDecoderResetRestoreDirect", "videoDecoderResetRestoreWorker"] as const) {
  test(`VideoDecoderWrapper 予算: 復号フレームと異なる config で予算が戻る (${name})`, async ({
    page,
  }) => {
    await openCodecTestPage(page);

    const result = await runCodecTest(page, name);

    expect(result.test).toBe(name);
    expect(result.useWorker).toBe(name === "videoDecoderResetRestoreWorker");
    expectVideoDecoderRestoreContract(result);
  });
}

/**
 * 並行する reset() / configure() の交錯の契約を検証する
 */
function expectVideoDecoderConcurrentResetContract(
  result: VideoDecoderConcurrentResetTestResult,
): void {
  // 2 つの reset() が同時に走っても、後発世代まで破棄して両方を失敗させない。
  // 先に作り直した方だけが true を返し、他方は破棄で進んだ世代を検出して false になる
  // (両方 false になると Worker も VideoDecoder も残らず、以降の decode() が何もしない
  //  状態になる。true が 1 件であることがそれを含む。直接モードも破棄が世代を進める)
  expect(result.concurrentResetResults.filter(Boolean)).toHaveLength(1);

  // 後発世代のデコーダーが公開されたまま残り、実 chunk を復号できる
  expect(result.stateAfterConcurrentReset).toBe("configured");
  expect(result.framesDecodedAfterConcurrentReset).toBeGreaterThan(0);

  // reset() の対応確認の await 中に参照の異なる config の configure() が始まった場合、
  // reset() は追い越されて何もせず false を返し、configure() は失敗しない
  expect(result.resetReturnedDuringConfigure).toBe(false);
  expect(result.configureErrorMessage).toBeNull();

  // configure() の構成が公開されたまま残り、実 chunk を復号できる
  expect(result.stateAfterConcurrentConfigure).toBe("configured");
  expect(result.framesDecodedAfterConcurrentConfigure).toBeGreaterThan(0);

  // 交錯の失敗は error コールバックを呼ばない
  expect(result.errorMessages).toEqual([]);
}

for (const name of [
  "videoDecoderConcurrentResetDirect",
  "videoDecoderConcurrentResetWorker",
] as const) {
  test(`VideoDecoderWrapper 交錯: 並行する reset() と configure() が互いを壊さない (${name})`, async ({
    page,
  }) => {
    await openCodecTestPage(page);

    const result = await runCodecTest(page, name);

    expect(result.test).toBe(name);
    expect(result.useWorker).toBe(name === "videoDecoderConcurrentResetWorker");
    expectVideoDecoderConcurrentResetContract(result);
  });
}

/**
 * configure() の対応確認中に close() が先行したときの契約を検証する
 *
 * テストページは await を挟まずに configure() と close() を呼ぶ。configure() は対応確認の
 * await を持つため、対応確認の解決より解放が先に走る。解放のあとに Worker や VideoDecoder を
 * 作ると誰も破棄せず、state も configured へ戻る (解放のあとに作られたものは呼び出し側の
 * 参照から外れている)。イベント順と state で固定する。実ブラウザのテストからは生成の実体を
 * 観測できないため、作られていれば state が configured になる性質で確認する (直接モードの
 * 生成数は Node の単体テストが数える)。
 */
function expectVideoDecoderCloseDuringConfigureContract(
  result: VideoDecoderCloseDuringConfigureTestResult,
): void {
  // 解放が先に走り、configure() は構成せずに失敗する。
  // イベント名はテストページ (devtools/src/codec-test/video.ts) が記録する
  expect(result.events).toEqual(["configure started", "close called", "configure rejected"]);
  expect(result.configureErrorMessage).toBe(
    "video decoder configure superseded by newer generation",
  );

  // 解放のあとに Worker も VideoDecoder も作らないため、state は unconfigured のままになる
  expect(result.stateAfterAbortedConfigure).toBe("unconfigured");
  expect(result.framesDecodedAfterAbortedConfigure).toBe(0);

  // やり直した configure() は成功し、実 chunk を復号できる (解放で Wrapper は壊れない)
  expect(result.stateAfterReconfigure).toBe("configured");
  expect(result.framesDecodedAfterReconfigure).toBeGreaterThan(0);

  // configure() の失敗は error コールバックを呼ばない
  expect(result.errorMessages).toEqual([]);
}

for (const name of [
  "videoDecoderCloseDuringConfigureDirect",
  "videoDecoderCloseDuringConfigureWorker",
] as const) {
  test(`VideoDecoderWrapper 解放: configure() 中に close() したら Worker も VideoDecoder も作らない (${name})`, async ({
    page,
  }) => {
    await openCodecTestPage(page);

    const result = await runCodecTest(page, name);

    expect(result.test).toBe(name);
    expect(result.useWorker).toBe(name === "videoDecoderCloseDuringConfigureWorker");
    expectVideoDecoderCloseDuringConfigureContract(result);
  });
}

// ============================================================================
// devtools の DecoderWrapper の非対応 codec と復帰の予算
// ============================================================================

// devtools の購読側が使う Wrapper (devtools/src/utils/DecoderWrapper.ts) の配線を実ブラウザで
// 固定する。ライブラリ側の VideoDecoderWrapper のケース (videoDecoderUnsupportedCodec* /
// videoDecoderResetBudget*) とは別のテストとして駆動する。
//
// 事前確認は Worker の生成 / VideoDecoder の configure の直前にあるため、非対応 codec の
// 経路では Worker も VideoDecoder も作られない。テストからは state とエラーメッセージで
// 確認する。

/**
 * devtools の DecoderWrapper の非対応 codec の契約を検証する
 */
function expectDevtoolsDecoderUnsupportedCodecContract(
  result: DevtoolsDecoderUnsupportedCodecTestResult,
): void {
  // テスト内で観測した対応確認の分岐を固定する。codec 文字列はテストページの定数と一致する
  expect(result.unsupportedCodecString).toBe("vp09.99.99.99");
  expect(result.unsupportedCodecSupport.supported).toBe(false);
  expect(result.unsupportedCodecSupport.rejected).toBe(false);
  // 空の codec は reject する (false を返す経路とは別の分岐)
  expect(result.invalidCodecString).toBe("");
  expect(result.invalidCodecSupport.supported).toBeNull();
  expect(result.invalidCodecSupport.rejected).toBe(true);

  // false を返す codec では Worker も VideoDecoder も作らず、codec 文字列を含むエラーで
  // configure が失敗する
  expect(result.configureErrorMessage).toBe(
    `Decoder codec not supported: ${result.unsupportedCodecString}`,
  );
  expect(result.stateAfterFailedConfigure).toBe("unconfigured");

  // 失敗した設定は lastConfig に残らないため、同じ config の reset() は再試行せず false を
  // 返し、state も unconfigured のままになる
  expect(result.resetReturned).toBe(false);
  expect(result.stateAfterReset).toBe("unconfigured");

  // reject する codec も同じ扱いになる。codec が空のため末尾の codec 文字列も空になり、
  // 完全一致で固定すると実装の文言を変えるだけで理由と無関係に落ちる。判定の文言だけを
  // 確認する (codec 文字列が載ることは上の false を返す codec の assert が固定する)
  expect(result.invalidCodecConfigureErrorMessage).toContain("Decoder codec not supported");
  expect(result.stateAfterInvalidCodecConfigure).toBe("unconfigured");
  expect(result.invalidCodecResetReturned).toBe(false);

  // どちらの経路でも復号せず、error コールバックも呼ばない
  expect(result.outputCount).toBe(0);
  expect(result.errorMessages).toEqual([]);
}

for (const name of [
  "devtoolsDecoderUnsupportedCodecDirect",
  "devtoolsDecoderUnsupportedCodecWorker",
] as const) {
  test(`devtools の DecoderWrapper 非対応 codec: configure と reset が失敗する (${name})`, async ({
    page,
  }) => {
    await openCodecTestPage(page);

    const result = await runCodecTest(page, name);

    expect(result.test).toBe(name);
    expect(result.useWorker).toBe(name === "devtoolsDecoderUnsupportedCodecWorker");
    expectDevtoolsDecoderUnsupportedCodecContract(result);
  });
}

/**
 * devtools の DecoderWrapper の復帰予算の契約を検証する
 */
function expectDevtoolsDecoderResetBudgetContract(
  result: DevtoolsDecoderResetBudgetTestResult,
): void {
  // 対応 codec (vp8) で駆動している
  expect(result.supportedCodecString).toBe("vp8");

  // configure 前 (lastConfig が無い) の reset() は false を返し、何も作り直さない
  expect(result.resetWithoutConfig).toBe(false);

  // (a) 復号フレームを 1 枚も出さないまま同じ config の reset() を繰り返すと、
  // 上限の 3 回が成功し、4 回目で打ち切られる
  expect(result.stateAfterConfigure).toBe("configured");
  expect(result.resetResults).toEqual([true, true, true, false]);

  // 打ち切り後は Worker も VideoDecoder も破棄され、state は unconfigured になる。
  // 以降の decode() は configured = false のため、実 chunk を投入しても復号しない
  expect(result.stateAfterBudgetExhausted).toBe("unconfigured");
  expect(result.framesDecodedAfterBudgetExhausted).toBe(0);

  // (b) 予算を使い切った状態でも、復号フレームを 1 枚出力すると予算が戻る
  // (戻らなければ resetAfterDecodedFrame が false になる)
  expect(result.resetResultsBeforeDecodedFrame).toEqual([true, true, true]);
  expect(result.framesDecodedBeforeRestore).toBeGreaterThan(0);
  expect(result.resetAfterDecodedFrame).toBe(true);

  // (c) 予算を使い切った状態でも、参照の異なる config の configure で予算が戻る
  expect(result.resetResultsBeforeDifferentConfig).toEqual([true, true, true]);
  expect(result.resetAfterDifferentConfig).toBe(true);
  expect(result.stateAfterDifferentConfigReset).toBe("configured");

  // (d) 追い越されて失敗した configure() では予算が戻らない。戻すと、呼び出し側が毎回
  // 新しい設定を渡すだけで上限が無効になり、恒久エラーで再生成が止まらない
  expect(result.resetResultsBeforeSupersededConfigure).toEqual([true, true, true]);
  expect(result.resetAfterSupersededConfigure).toBe(false);
  expect(result.supersededConfigureErrorMessage).toBe(
    "decoder configure superseded by newer generation",
  );
  expect(result.stateAfterSupersededConfigure).toBe("unconfigured");

  // reset() の打ち切りも configure の失敗も error コールバックを呼ばない
  expect(result.errorMessages).toEqual([]);
}

for (const name of [
  "devtoolsDecoderResetBudgetDirect",
  "devtoolsDecoderResetBudgetWorker",
] as const) {
  test(`devtools の DecoderWrapper 予算: 同じ config の reset() は 3 回で打ち切られ、復号フレームと異なる config で戻る (${name})`, async ({
    page,
  }) => {
    await openCodecTestPage(page);
    const warnings = collectConsoleWarnings(page);

    const result = await runCodecTest(page, name);

    expect(result.test).toBe(name);
    expect(result.useWorker).toBe(name === "devtoolsDecoderResetBudgetWorker");
    expectDevtoolsDecoderResetBudgetContract(result);

    // 打ち切り後は未構成のまま decode() が呼ばれ続ける (受信のたびに呼ばれる)。
    // 警告は呼び出しのたびではなく、未構成になった最初の 1 回だけにする
    // (毎回出すと 30 fps の受信で毎秒 30 件の警告になる)
    expect(countDevtoolsDecoderNotConfiguredWarnings(warnings)).toBe(1);
  });
}

// ============================================================================
// devtools の DecoderWrapper の解放 (configure 中の close)
// ============================================================================

// devtools の DecoderWrapper でも、configure() の対応確認を await している間に close() が
// 先行したら Worker も VideoDecoder も作らない。作ると誰も破棄せず、停止した購読の
// デコーダーが残る (reset() も作り直して true を返す)。あわせて close() が終端として
// 働き、以降の reset() が作り直さずに false を返すことを固定する。

/**
 * devtools の DecoderWrapper の configure() 中に close() が先行したときの契約を検証する
 */
function expectDevtoolsDecoderCloseDuringConfigureContract(
  result: DevtoolsDecoderCloseDuringConfigureTestResult,
): void {
  // 解放が先に走り、configure() は構成せずに失敗する。
  // イベント名はテストページ (devtools/src/codec-test/devtoolsDecoder.ts) が記録する
  expect(result.events).toEqual(["configure started", "close called", "configure rejected"]);
  expect(result.configureErrorMessage).toBe("decoder configure superseded by newer generation");

  // 解放のあとに Worker も VideoDecoder も作らないため、state は unconfigured のままになる。
  // 解放のあとに作られていれば、実 chunk を投入した時点で復号してしまう
  expect(result.stateAfterAbortedConfigure).toBe("unconfigured");
  expect(result.framesDecodedAfterAbortedConfigure).toBe(0);

  // 解放の後の reset() は作り直さない (作り直すと誰も破棄しない Worker と VideoDecoder が
  // 残り、state と Promise の契約も崩れる)
  expect(result.resetAfterAbortedConfigure).toBe(false);

  // やり直した configure() は成功し、実 chunk を復号できる (解放で Wrapper は壊れない)
  expect(result.stateAfterReconfigure).toBe("configured");
  expect(result.framesDecodedAfterReconfigure).toBeGreaterThan(0);

  // close() は終端であり、その後の reset() は作り直さず false を返す
  expect(result.resetAfterClose).toBe(false);
  expect(result.stateAfterCloseReset).toBe("unconfigured");

  // configure() の失敗は error コールバックを呼ばない
  expect(result.errorMessages).toEqual([]);
}

for (const name of [
  "devtoolsDecoderCloseDuringConfigureDirect",
  "devtoolsDecoderCloseDuringConfigureWorker",
] as const) {
  test(`devtools の DecoderWrapper 解放: configure() 中に close() したら Worker も VideoDecoder も作らない (${name})`, async ({
    page,
  }) => {
    await openCodecTestPage(page);

    const result = await runCodecTest(page, name);

    expect(result.test).toBe(name);
    expect(result.useWorker).toBe(name === "devtoolsDecoderCloseDuringConfigureWorker");
    expectDevtoolsDecoderCloseDuringConfigureContract(result);
  });
}

// ============================================================================
// devtools の DecoderWrapper の並行する configure
// ============================================================================

// devtools の DecoderWrapper でも、configure() の対応確認を await している間に別の
// configure() が始まったら、先発はデコーダーの所有権を失って作らずに失敗する。
// 先発が作ってしまうと、後発の公開で先発が破棄されずに残り、先発の設定の
// Worker / VideoDecoder を誰も破棄しない。

/**
 * devtools の DecoderWrapper の並行する configure() の契約を検証する
 */
function expectDevtoolsDecoderConcurrentConfigureContract(
  result: DevtoolsDecoderConcurrentConfigureTestResult,
): void {
  // 先発は後発に追い越されて失敗し、後発は成功する
  expect(result.firstConfigureErrorMessage).toBe(
    "decoder configure superseded by newer generation",
  );
  expect(result.secondConfigureErrorMessage).toBeNull();

  // 後発の構成が残り、実 chunk を復号できる (先発は何も作っていない)
  expect(result.stateAfterConcurrentConfigure).toBe("configured");
  expect(result.framesDecodedAfterConcurrentConfigure).toBeGreaterThan(0);

  // configure() の失敗は error コールバックを呼ばない
  expect(result.errorMessages).toEqual([]);
}

for (const name of [
  "devtoolsDecoderConcurrentConfigureDirect",
  "devtoolsDecoderConcurrentConfigureWorker",
] as const) {
  test(`devtools の DecoderWrapper 並行 configure: 先発は作らずに失敗し、後発の構成が残る (${name})`, async ({
    page,
  }) => {
    await openCodecTestPage(page);

    const result = await runCodecTest(page, name);

    expect(result.test).toBe(name);
    expect(result.useWorker).toBe(name === "devtoolsDecoderConcurrentConfigureWorker");
    expectDevtoolsDecoderConcurrentConfigureContract(result);
  });
}

// ============================================================================
// AudioEncoderWrapper
// ============================================================================

/**
 * AudioEncoderWrapper の実行モードに依存しない契約を検証する
 *
 * 無音 1 秒分 (100ms x 10) を投入し、テストページが選んだコーデックで
 * chunk が出力されることを pin する。
 */
function expectAudioEncoderContract(result: AudioEncoderTestResult): void {
  // opus / aac のうち、実ブラウザが encoder と decoder の双方で対応と報告し、
  // 実際に符号化できることを確認して採用されたもの
  expect(["opus", "aac"]).toContain(result.codec);
  expect(result.sampleRate).toBe(AUDIO_SAMPLE_RATE);
  expect(result.channels).toBe(AUDIO_CHANNELS);

  // configure 前は unconfigured、configure 後は configured、close 後は unconfigured に戻る
  expect(result.stateHistory).toEqual([
    { step: "initial", state: "unconfigured" },
    { step: "afterUnconfiguredEncode", state: "unconfigured" },
    { step: "afterConfigure", state: "configured" },
    { step: "afterEncode", state: "configured" },
    { step: "afterClose", state: "unconfigured" },
  ]);

  // 未設定時の encode() は undefined を返し、chunk も error も出さない
  expect(result.unconfiguredEncode).toEqual({
    returnValueType: "undefined",
    state: "unconfigured",
    outputCount: 0,
    errorCount: 0,
  });

  // 1 秒分の入力に対して複数の chunk が出力される
  expect(result.chunkCount).toBeGreaterThan(0);
  expect(result.keyChunkCount).toBe(result.chunkCount);
  expect(result.totalByteLength).toBeGreaterThan(0);

  // 各 chunk は実データと duration を持ち、timestamp は単調増加する
  for (const chunk of result.chunks) {
    expect(chunk.type).toBe("key");
    expect(chunk.byteLength).toBeGreaterThan(0);
    expect(chunk.duration).not.toBeNull();
    expect(chunk.firstByte).toBeGreaterThanOrEqual(0);
    // opus は AudioSpecificConfig を運ばない (Chromium の opus encoder は OpusHead を
    // 返すが、Wrapper が運ばない判断をする)。AAC の description 経路は Chromium が
    // isConfigSupported で対応と報告しても実際の符号化が EncodingError になるため
    // e2e では検証できない (単体テストで検証する)
    expect(chunk.descriptionByteLength).toBeNull();
  }
  expect(result.outputTimestamps[0]).toBe(0);
  expectMonotonicIncrease(result.outputTimestamps);

  // 末尾の chunk まで届き、1 秒分の入力がおおむね符号化されている
  const lastChunk = result.chunks[result.chunkCount - 1];
  expect(lastChunk.timestamp + (lastChunk.duration ?? 0)).toBeGreaterThanOrEqual(900_000);

  // close() 後の encode() も何も起きない
  expect(result.encodeAfterClose).toEqual({
    returnValueType: "undefined",
    state: "unconfigured",
    outputCount: result.chunkCount,
    errorCount: 0,
  });

  // error コールバックは一度も呼ばれない
  expect(result.errorMessages).toEqual([]);
}

test("AudioEncoderWrapper 直接モード: 対応コーデックで chunk が出力される", async ({ page }) => {
  await openCodecTestPage(page);

  const result = await runCodecTest(page, "audioEncoderDirect");

  // 直接モードでは Worker を生成せず AudioEncoder を直接使う
  expect(result.test).toBe("audioEncoderDirect");
  expect(result.useWorker).toBe(false);
  expectAudioEncoderContract(result);
});

test("AudioEncoderWrapper Worker モード: Worker 経由でも chunk が出力される", async ({ page }) => {
  await openCodecTestPage(page);

  const result = await runCodecTest(page, "audioEncoderWorker");

  // Worker モードでは init → configured → encoded の往復で同じ結果になる
  expect(result.test).toBe("audioEncoderWorker");
  expect(result.useWorker).toBe(true);
  expectAudioEncoderContract(result);
});

// ============================================================================
// AudioDecoderWrapper
// ============================================================================

/**
 * AudioDecoderWrapper の実行モードに依存しない契約を検証する
 *
 * テストページ側で実 AudioEncoderWrapper が出力した chunk を投入し、
 * 復号された AudioData の形を pin する。
 */
function expectAudioDecoderContract(result: AudioDecoderTestResult): void {
  // opus / aac のうち、実ブラウザが encoder と decoder の双方で対応と報告し、
  // 実際に符号化できることを確認して採用されたもの
  expect(["opus", "aac"]).toContain(result.codec);
  expect(result.sampleRate).toBe(AUDIO_SAMPLE_RATE);
  expect(result.channels).toBe(AUDIO_CHANNELS);

  // 未設定時の decode() は実 chunk を渡しても undefined を返し、何も復号しない
  expect(result.unconfiguredDecode).toEqual({
    returnValueType: "undefined",
    outputCount: 0,
    errorCount: 0,
  });

  // 投入した chunk と同数の AudioData が復号される
  expect(result.inputChunkCount).toBeGreaterThan(0);
  expect(result.decodedCount).toBe(result.inputChunkCount);
  expect(result.decoded.length).toBe(result.decodedCount);

  // AudioData は configure に渡した形式で、f32-planar の実サンプルを読み出せる
  for (const audioData of result.decoded) {
    expect(audioData.sampleRate).toBe(AUDIO_SAMPLE_RATE);
    expect(audioData.numberOfChannels).toBe(AUDIO_CHANNELS);
    expect(audioData.numberOfFrames).toBeGreaterThan(0);
    expect(audioData.format).not.toBeNull();
    expect(audioData.sampleByteLength).toBe(audioData.numberOfFrames * 4);
    expect(audioData.duration).not.toBeNull();
  }

  // 復号された AudioData の timestamp は投入した chunk の timestamp を引き継ぐ
  expect(result.outputTimestamps).toEqual(result.inputTimestamps);

  // close() 後の decode() も実 chunk を渡して何も復号しない
  expect(result.decodeAfterClose).toEqual({
    returnValueType: "undefined",
    outputCount: result.decodedCount,
    errorCount: 0,
  });

  // error コールバックは一度も呼ばれない
  expect(result.errorMessages).toEqual([]);
}

test("AudioDecoderWrapper 直接モード: encode した chunk から AudioData が得られる", async ({
  page,
}) => {
  await openCodecTestPage(page);

  const result = await runCodecTest(page, "audioDecoderDirect");

  // 直接モードでは Worker を生成せず AudioDecoder を直接使う
  expect(result.test).toBe("audioDecoderDirect");
  expect(result.useWorker).toBe(false);
  expectAudioDecoderContract(result);
});

test("AudioDecoderWrapper Worker モード: Worker 経由でも AudioData が得られる", async ({
  page,
}) => {
  await openCodecTestPage(page);

  const result = await runCodecTest(page, "audioDecoderWorker");

  // Worker モードでは init → configured → decoded の往復で同じ結果になる
  expect(result.test).toBe("audioDecoderWorker");
  expect(result.useWorker).toBe(true);
  expectAudioDecoderContract(result);
});

test("AudioEncoderWrapper / AudioDecoderWrapper 未設定時: encode() / decode() は何もしない", async ({
  page,
}) => {
  await openCodecTestPage(page);

  for (const name of ["audioEncoderDirect", "audioEncoderWorker"] as const) {
    const result = await runCodecTest(page, name);

    // configure 前も close 後も、encode() は undefined を返して chunk を出さない
    expect(result.unconfiguredEncode).toEqual({
      returnValueType: "undefined",
      state: "unconfigured",
      outputCount: 0,
      errorCount: 0,
    });
    expect(result.encodeAfterClose).toEqual({
      returnValueType: "undefined",
      state: "unconfigured",
      outputCount: result.chunkCount,
      errorCount: 0,
    });
  }

  for (const name of ["audioDecoderDirect", "audioDecoderWorker"] as const) {
    const result = await runCodecTest(page, name);

    // configure 前も close 後も、decode() は undefined を返して AudioData を出さない
    expect(result.unconfiguredDecode).toEqual({
      returnValueType: "undefined",
      outputCount: 0,
      errorCount: 0,
    });
    expect(result.decodeAfterClose).toEqual({
      returnValueType: "undefined",
      outputCount: result.decodedCount,
      errorCount: 0,
    });
  }
});

/**
 * VideoEncoderWrapper の再 configure テスト
 *
 * 同じ Wrapper に解像度を変えて configure() を 2 回呼び、旧コーデック /
 * 旧 Worker を破棄したうえで encode が継続することを検証する。
 * 直接モードは旧 VideoEncoder の close()、Worker モードは旧 Worker の破棄と
 * 新しい Worker の init を通る。
 */
for (const name of ["videoEncoderReconfigureDirect", "videoEncoderReconfigureWorker"] as const) {
  test(`VideoEncoderWrapper 再 configure: 解像度を変えても encode が継続する (${name})`, async ({
    page,
  }) => {
    await openCodecTestPage(page);

    const result: VideoEncoderReconfigureTestResult = await runCodecTest(page, name);

    // 1 回目と 2 回目でそれぞれ chunk が出力される
    expect(result.firstConfigChunkCount).toBe(2);
    expect(result.secondConfigChunkCount).toBe(2);

    // 1 回目は 0 から、2 回目は続きの timestamp で出力される
    expect(result.outputTimestamps).toEqual([0, 33333, 66666, 99999]);

    // 状態は configure 済みのまま、encodeQueueSize は 0 以上の整数
    expect(result.stateHistory.map((entry) => entry.state)).toEqual([
      "unconfigured",
      "configured",
      "configured",
      "unconfigured",
    ]);
    expect(result.queueSizeIsNonNegativeInteger).toBe(true);

    // 旧コーデック / 旧 Worker の破棄で error は発生しない
    expect(result.errorMessages).toEqual([]);
  });
}

// ============================================================================
// devtools の EncoderWrapper の Worker モードの送信中のフレーム数
// ============================================================================

// devtools の配信 (devtools/src/hooks/usePublisher.ts) は devtools の EncoderWrapper の
// encodeQueueSize が閾値以下かを判定してフレームを投入する。Worker モードでは Worker 内の
// キュー長を取得できないため、Worker へ送信してまだ encoded 応答が返っていないフレーム数を
// 返す契約を pin する。0 固定のままだと判定が常に真になり、破棄の経路が働かない。
//
// 駆動するのは devtools/src/codec-test/devtoolsEncoder.ts の runner である。1 回の configure で
// 投入するフレーム数は結果の encodeFrameCount を使う (runner と期待値を二重に持たない)
//
// 観測する契約は次の 5 つである。
//
// 1. 投入の直後は送信中の数が投入数になり、出力を待つと 0 に戻る
// 2. 再 configure と close で 0 に戻る (戻らないと閾値に張り付いて全フレームが破棄される)
// 3. 1 件目の output が例外を投げても減算され、待機後に 0 に戻る (減算は output の前)
// 4. Worker が error 応答を返したら 0 に戻り、configured でなくなって投入が止まる
// 5. 再 configure の応答を待つ間に新しい Worker へ送ったフレームの数は、完了後も消えない

/**
 * devtools の EncoderWrapper の Worker モードの送信中のフレーム数の契約を検証する
 */
function expectDevtoolsEncoderWorkerContract(result: DevtoolsEncoderWorkerTestResult): void {
  const encodeFrameCount = result.encodeFrameCount;
  expect(encodeFrameCount).toBeGreaterThan(0);

  // configure 前 (未設定) は 0、configure 直後 (送信中 0 件) も 0
  expect(result.queueSizeBeforeConfigure).toBe(0);
  expect(result.queueSizeAfterConfigure).toBe(0);

  // フレームを投入した直後は投入数がそのまま残り、出力を待つと encoded 応答ごとに減って 0 に戻る
  expect(result.queueSizeAfterEncode).toBe(encodeFrameCount);
  expect(result.queueSizeAfterOutputWait).toBe(0);

  // 応答を待たずに投入したフレームを残したまま再 configure しても 0 に戻る。
  // 戻らないと、閾値 (2) を超えたまま張り付いて以後のフレームがすべて破棄される
  expect(result.queueSizeBeforeReconfigure).toBe(encodeFrameCount);
  expect(result.queueSizeAfterReconfigure).toBe(0);

  // 差し替えた新しい Worker でも encode が続く (破棄で Wrapper は壊れない)
  expect(result.secondConfigChunkCount).toBe(encodeFrameCount);

  // 未応答のフレームを残したまま close しても 0 に戻る
  expect(result.queueSizeBeforeClose).toBe(encodeFrameCount);
  expect(result.queueSizeAfterClose).toBe(0);

  // configure 前は unconfigured、configure 後は configured、close 後は unconfigured に戻る
  expect(result.stateHistory.map((entry) => entry.state)).toEqual([
    "unconfigured",
    "configured",
    "configured",
    "configured",
    "configured",
    "unconfigured",
  ]);

  // 1 回目と 2 回目の configure でそれぞれ投入したフレームが出力される
  // (各回の先頭を keyFrame: true にしてあるため key chunk は 2 件になる)
  expect(result.chunkCount).toBe(encodeFrameCount * 2);
  expect(result.keyChunkCount).toBe(2);
  expect(result.outputTimestamps[0]).toBe(0);
  expectMonotonicIncrease(result.outputTimestamps);

  // error コールバックへ届く経路 (初期化の後に届いた失敗の通知) は
  // expectDevtoolsEncoderWorkerErrorContract が固定する。正常系の観測だけを並べるこの runner の
  // 結果では通知は空にしかならないため、ここでは主張しない
}

/**
 * output が例外を投げても減算される契約を検証する
 */
function expectDevtoolsEncoderOutputThrowsContract(result: DevtoolsEncoderWorkerTestResult): void {
  const encodeFrameCount = result.encodeFrameCount;

  // 投入の直後は投入数が残る (どのフレームも送信されている)
  expect(result.outputThrowsQueueSizeAfterEncode).toBe(encodeFrameCount);
  // 例外になった 1 件目も含めて output が呼ばれ、その数も戻る。
  // 減算が output の後だと、例外を投げたフレームの数が残って 0 にならない
  expect(result.outputThrowsChunkCount).toBe(encodeFrameCount);
  expect(result.outputThrowsQueueSizeAfterWait).toBe(0);
  // 例外はブラウザが未処理のエラーとして報告する (output が実際に throw したことの確認)
  expect(result.outputThrowsUncaughtMessages).toEqual([
    expect.stringContaining("output callback failed on purpose"),
  ]);
}

/**
 * Worker が error 応答を返した後の契約を検証する
 */
function expectDevtoolsEncoderWorkerErrorContract(result: DevtoolsEncoderWorkerTestResult): void {
  const encodeFrameCount = result.encodeFrameCount;

  // 失敗する codec で再 configure する前に、未応答のフレームが送信中として残っている
  expect(result.queueSizeBeforeWorkerError).toBe(encodeFrameCount);

  // 設定できない codec は configure では失敗せず、encode で初めて失敗するため、
  // error は初期化後 (configure の応答の後) の通知として届く
  expect(result.workerErrorNotifyMessages).toHaveLength(1);

  // Worker が error 応答を返したら送信中の数は 0 に戻る。
  // 戻らないと閾値 (2) を超えたまま張り付いて、以後のフレームがすべて破棄される
  expect(result.queueSizeAfterWorkerError).toBe(0);

  // configured でなくなるため、その後の encode は Worker へ送られない (数が増えない)
  expect(result.stateAfterWorkerError).toBe("unconfigured");
  expect(result.queueSizeAfterEncodePostError).toBe(0);
}

/**
 * 初期化に失敗する configure の契約を検証する
 */
function expectDevtoolsEncoderFailedConfigureContract(
  result: DevtoolsEncoderWorkerTestResult,
): void {
  // 失敗する configure の前に、未応答のフレームが送信中として残っている
  expect(result.queueSizeBeforeFailedConfigure).toBe(result.encodeFrameCount);

  // 初期化の失敗は configure の reject で伝わり、error コールバックは呼ばない
  expect(result.failedConfigureMessage).toEqual(expect.any(String));
  expect(result.failedConfigureNotifyMessages).toEqual([]);

  // 失敗した configure でも送信中の数は 0 に戻る。戻さないと、応答が返らないフレームの数が
  // 閾値 (2) を超えたまま残り、以後すべてのフレームが破棄される
  expect(result.queueSizeAfterFailedConfigure).toBe(0);
  expect(result.stateAfterFailedConfigure).toBe("unconfigured");
}

/**
 * 再 configure の応答を待つ間の契約を検証する
 */
function expectDevtoolsEncoderReconfigureWaitContract(
  result: DevtoolsEncoderWorkerTestResult,
): void {
  const encodeFrameCount = result.encodeFrameCount;

  // 再 configure の前に、旧 Worker の未応答のフレームが送信中として残っている
  expect(result.queueSizeBeforeReconfigureWait).toBe(encodeFrameCount);

  // 応答を待つ間に投入したフレームは新しい Worker へ送られて数えられる
  expect(result.queueSizeDuringReconfigureWait).toBe(encodeFrameCount);

  // 待機中の投入の数は configure の完了で消えない。消えると、実際より少なく見える
  // (数のリセットが configure の完了後だと、待機中に送ったフレームの数まで戻ってしまう)
  expect(result.queueSizeAfterReconfigureWait).toBe(encodeFrameCount);
  expect(result.reconfigureWaitErrorMessages).toEqual([]);
}

test("devtools の EncoderWrapper Worker モード: encodeQueueSize が送信中のフレーム数になる", async ({
  page,
}) => {
  await openCodecTestPage(page);

  const result = await runCodecTest(page, "devtoolsEncoderWorker");

  // Worker モードの devtools EncoderWrapper を実 Chromium の Worker で駆動している
  expect(result.test).toBe("devtoolsEncoderWorker");
  expect(result.useWorker).toBe(true);
  expectDevtoolsEncoderWorkerContract(result);
  expectDevtoolsEncoderOutputThrowsContract(result);
  expectDevtoolsEncoderWorkerErrorContract(result);
  expectDevtoolsEncoderFailedConfigureContract(result);
  expectDevtoolsEncoderReconfigureWaitContract(result);
});

// ============================================================================
// devtools の EncoderWrapper の解放 (configure 中の close)
// ============================================================================

// devtools の配信 (devtools/src/hooks/usePublisher.ts) は WebTransport の close / error で
// cleanupPublisher() を呼ぶため、映像配信の開始処理が await している configure() の最中でも
// EncoderWrapper.close() が走り得る。close() は Worker の配送口を外して terminate するため、
// 中断を届けないと configure() の Promise が未解決のまま残り、開始処理が永久に待ち続ける。
// 追い越しとして失敗することを固定する (DecoderWrapper の
// devtoolsDecoderCloseDuringConfigure* と同じ観点)。

/**
 * devtools の EncoderWrapper の configure() 中に close() が先行したときの契約を検証する
 */
function expectDevtoolsEncoderCloseDuringConfigureContract(
  result: DevtoolsEncoderCloseDuringConfigureTestResult,
): void {
  // 解放が先に走り、configure() は Worker を公開せずに失敗する。
  // イベント名はテストページ (devtools/src/codec-test/devtoolsEncoder.ts) が記録する。
  // 中断が届かない実装では configure() が settle せず "configure not settled" になる
  expect(result.events).toEqual(["configure started", "close called", "configure rejected"]);
  expect(result.configureErrorMessage).toBe("encoder configure superseded by newer generation");

  // 解放のあとは unconfigured に戻り、送信中のフレーム数も 0 になる
  expect(result.stateAfterAbortedConfigure).toBe("unconfigured");
  expect(result.queueSizeAfterAbortedConfigure).toBe(0);

  // 解放のあとに encode しても Worker へ送らない (数が増えない)
  expect(result.queueSizeAfterEncodePostAbort).toBe(0);

  // やり直した configure() は成功し、実フレームを符号化できる (解放で Wrapper は壊れない)
  expect(result.stateAfterReconfigure).toBe("configured");
  expect(result.chunkCountAfterReconfigure).toBe(result.encodeFrameCount);
  expect(result.queueSizeAfterReconfigureEncode).toBe(result.encodeFrameCount);
  expect(result.queueSizeAfterReconfigureWait).toBe(0);

  // configure() の失敗は error コールバックを呼ばない
  expect(result.errorMessages).toEqual([]);
}

test("devtools の EncoderWrapper 解放: configure() 中に close() したら追い越しとして失敗する", async ({
  page,
}) => {
  await openCodecTestPage(page);

  const result = await runCodecTest(page, "devtoolsEncoderCloseDuringConfigure");

  // Worker モードの devtools EncoderWrapper を実 Chromium の Worker で駆動している
  expect(result.test).toBe("devtoolsEncoderCloseDuringConfigure");
  expect(result.useWorker).toBe(true);
  expectDevtoolsEncoderCloseDuringConfigureContract(result);
});

// ============================================================================
// devtools の EncoderWrapper の Worker の初期化の失敗と configure のやり直し
// ============================================================================

// 初期化に失敗した configure は reject し、失敗した Worker を破棄して configured を false に
// 戻す。この後始末が今の Worker や後発の configure の待機を巻き込むと、解決するはずの
// configure が失敗したり、未解決のまま残ったりする。初期化の失敗と後発の configure の
// 順序を 2 つ固定する (旧世代の Worker の応答を待たずに後発を呼ぶ順序と、旧世代の失敗を
// 待ってからやり直す順序)。

/**
 * devtools の EncoderWrapper の Worker の初期化の失敗後の契約を検証する
 */
function expectDevtoolsEncoderFailedWorkerConfigureContract(
  result: DevtoolsEncoderFailedWorkerConfigureTestResult,
): void {
  const encodeFrameCount = result.encodeFrameCount;
  expect(encodeFrameCount).toBeGreaterThan(0);

  // 旧世代 (初期化に失敗する設定) の応答を待たずに後発 (成功する設定) の configure を呼ぶと、
  // 旧世代は追い越されて失敗し、後発が構成を持つ。旧世代の Worker の初期化の失敗は
  // 後発の待機中に届かない (届けば、後発の configure が失敗したり待機が壊れたりする)
  expect(result.firstConfigureErrorMessage).toBe(
    "encoder configure superseded by newer generation",
  );
  expect(result.secondConfigureErrorMessage).toBeNull();

  // 後発の構成が残り、実フレームを符号化できる
  expect(result.stateAfterSecondConfigure).toBe("configured");
  expect(result.secondChunkCount).toBe(encodeFrameCount);
  expect(result.queueSizeAfterSecondEncode).toBe(encodeFrameCount);
  expect(result.queueSizeAfterSecondWait).toBe(0);
  expect(result.secondErrorMessages).toEqual([]);

  // 初期化に失敗した configure はブラウザが返した理由で reject し、state と送信中の数が戻る
  expect(result.failedConfigureMessage).toEqual(expect.any(String));
  expect(result.stateAfterFailedConfigure).toBe("unconfigured");
  expect(result.queueSizeAfterFailedConfigure).toBe(0);

  // 失敗した Worker を破棄した後にやり直した configure は解決し、実フレームを符号化できる
  expect(result.retryConfigureErrorMessage).toBeNull();
  expect(result.stateAfterRetry).toBe("configured");
  expect(result.retryChunkCount).toBe(encodeFrameCount);
  expect(result.queueSizeAfterRetryEncode).toBe(encodeFrameCount);
  expect(result.queueSizeAfterRetryWait).toBe(0);

  // 初期化の失敗は reject で伝わり、error コールバックは呼ばない
  expect(result.errorMessages).toEqual([]);
}

test("devtools の EncoderWrapper 初期化失敗: 旧 Worker が初期化に失敗した後も configure が解決する", async ({
  page,
}) => {
  await openCodecTestPage(page);

  const result = await runCodecTest(page, "devtoolsEncoderFailedWorkerConfigure");

  // Worker モードの devtools EncoderWrapper を実 Chromium の Worker で駆動している
  expect(result.test).toBe("devtoolsEncoderFailedWorkerConfigure");
  expect(result.useWorker).toBe(true);
  expectDevtoolsEncoderFailedWorkerConfigureContract(result);
});

// ============================================================================
// devtools の可視化が使う AudioData の読み出し
// ============================================================================

/**
 * readAudioSamples の契約を検証する
 *
 * AudioData はブラウザ専用 API のため Node の単体テストでは検証できない。
 * 実ブラウザで生成した AudioData から読み出したサンプル数と値域を固定する。
 */
function expectAudioSamplesContract(result: AudioSamplesTestResult): void {
  expect(result.test).toBe("audioSamples");
  expect(result.sampleRate).toBe(AUDIO_SAMPLE_RATE);
  expect(result.numberOfChannels).toBe(AUDIO_CHANNELS);
  // 第 1 チャンネルのサンプル数は AudioData のフレーム数と一致する
  expect(result.sampleCount).toBe(result.numberOfFrames);

  // 第 1 チャンネルだけを読んでいる (第 2 チャンネルは無音にしてある)
  expect(result.secondChannelPeak).toBe(0);

  // 生成したトーン (振幅 0.2〜0.3) がそのまま読み出せる。
  // 0 dBFS が振幅 1.0 なので、peak は約 -14〜-10 dBFS になる
  expect(result.peakDbfs).toBeGreaterThan(-20);
  expect(result.peakDbfs).toBeLessThan(-5);
  // RMS は peak より小さい (正弦波の RMS は振幅の 1/sqrt(2))
  expect(result.rmsDbfs).toBeLessThan(result.peakDbfs);
  expect(result.maxSample).toBeGreaterThan(0.2);
  expect(result.minSample).toBeLessThan(-0.2);
}

test("readAudioSamples: 実 AudioData から第 1 チャンネルのサンプル列を読み出す", async ({
  page,
}) => {
  await openCodecTestPage(page);

  const result = await runCodecTest(page, "audioSamples");

  expectAudioSamplesContract(result);
});

// ============================================================================
// オーディオコーデックの選定
// ============================================================================

// 符号化できないコーデックが候補に残る状況を再現するための候補順。
// テストページは `?audioCodecs=<カンマ区切りの候補>` で候補順を差し替える
// (devtools/src/codec-test/support.ts と一致させる)。
//
// 前提: Chromium は AAC を符号化できない。どの段階で除外されるかは環境で変わる。
// - AudioEncoder.isConfigSupported が false の環境 (CI の Linux Chromium) では
//   `encoder unsupported` として除外される
// - true と報告する環境 (手元の macOS Chromium 153 で実測) では実符号化プローブが
//   EncodingError で失敗し `encode probe failed` として除外される
// どちらでも「AAC が除外されて opus が採用される」ことが本質なので、段階は固定しない。
// なお実符号化プローブまで進んだ場合は AAC の符号化失敗 1 回につき Chromium の
// GPU プロセスが 1 回落ちる (exit_code=5 で自動再初期化される既知の事象)
const AUDIO_CODECS_AAC_FIRST = "?audioCodecs=aac,opus";
const AUDIO_CODECS_AAC_ONLY = "?audioCodecs=aac";
const AUDIO_CODECS_UNKNOWN_ONLY = "?audioCodecs=unknown";

/**
 * 除外理由が codec 名と理由の組で読めることを検証する
 *
 * 除外される段階は環境で変わるため (上記の前提を参照)、段階は固定せず
 * 「codec 名 (理由)」の形で理由が読めることだけを固定する。
 */
function expectRejectedCodec(rejectedCodecs: string[], codec: string): void {
  expect(rejectedCodecs).toHaveLength(1);
  const [rejected] = rejectedCodecs;
  expect(rejected).toMatch(new RegExp(`^${codec} \\(.+\\)$`));
}

test("AudioEncoderWrapper: 符号化できない AAC を除外して opus を選ぶ", async ({ page }) => {
  // 候補順を AAC 先頭に差し替えても、符号化できない AAC は採用されない
  await openCodecTestPage(page, AUDIO_CODECS_AAC_FIRST);

  const result = await runCodecTest(page, "audioEncoderDirect");

  expect(result.codec).toBe("opus");
  expectRejectedCodec(result.rejectedCodecs, "aac");
  expectAudioEncoderContract(result);
});

test("AudioDecoderWrapper: 符号化できない AAC を除外した結果から参照 chunk を作れる", async ({
  page,
}) => {
  // 参照 chunk を作る encode も同じ選定を通るため、除外結果が decoder 側の結果にも載る
  await openCodecTestPage(page, AUDIO_CODECS_AAC_FIRST);

  const result = await runCodecTest(page, "audioDecoderDirect");

  expect(result.codec).toBe("opus");
  expectRejectedCodec(result.rejectedCodecs, "aac");
  expectAudioDecoderContract(result);
});

test("オーディオコーデックの選定: 符号化できる候補が無ければ選択時点で Error になる", async ({
  page,
}) => {
  // 符号化できない AAC だけを候補にすると、タイムアウトではなく選定時点の
  // 明示的な Error で失敗する (テストを skip させない契約)。
  // 候補の列挙と除外理由が載ることも確認する
  await openCodecTestPage(page, AUDIO_CODECS_AAC_ONLY);

  await expect(runCodecTest(page, "audioEncoderDirect")).rejects.toThrow(
    /no encodable audio codec in this browser \(candidates: aac\): aac \(.+/,
  );
});

test("オーディオコーデックの選定: 有効な候補が 1 つも無い場合も選択時点で Error になる", async ({
  page,
}) => {
  // 未知の名前だけを渡すと候補が 0 件になる。ブラウザの対応状況に依存しないため、
  // 「候補が無い」ことを示すメッセージを安定して固定できる
  await openCodecTestPage(page, AUDIO_CODECS_UNKNOWN_ONLY);

  await expect(runCodecTest(page, "audioEncoderDirect")).rejects.toThrow(
    /no encodable audio codec in this browser \(candidates: none\)/,
  );
});
