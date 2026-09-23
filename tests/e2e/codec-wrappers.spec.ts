import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type {
  AudioDecoderTestResult,
  AudioEncoderTestResult,
  AudioSamplesTestResult,
  CodecTestName,
  CodecTestResultMap,
  VideoDecoderTestResult,
  VideoEncoderReconfigureTestResult,
  VideoEncoderTestResult,
} from "../../devtools/src/codec-test/types";

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

  // configure 直後のキューは空で、6 フレーム投入直後は 6 件が未処理で残る
  expect(result.queueSizeAfterConfigure).toBe(0);
  expect(result.queueSizeIsNonNegativeInteger).toBe(true);
  expect(result.queueSizeAfterEncode).toBe(6);
});

test("VideoEncoderWrapper Worker モード: Worker 経由でも同じ契約が成立する", async ({ page }) => {
  await openCodecTestPage(page);

  const result = await runCodecTest(page, "videoEncoderWorker");

  // Worker モードでは init → configured → encoded の往復で同じ結果になる
  expect(result.test).toBe("videoEncoderWorker");
  expect(result.useWorker).toBe(true);
  expectVideoEncoderContract(result);

  // Worker モードの encodeQueueSize は取得できないため常に 0 を返す契約
  expect(result.queueSizeAfterConfigure).toBe(0);
  expect(result.queueSizeIsNonNegativeInteger).toBe(true);
  expect(result.queueSizeAfterEncode).toBe(0);
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
