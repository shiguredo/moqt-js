/**
 * AudioContext と復号フレームのサンプルレート不一致の計器の E2E
 *
 * `docs/AUDIO_GLITCH_CAUSES.md` の A1「サンプルレート不一致による 20 ms ごとの 1 サンプル
 * 重なり」を見つけるため、`AudioReceiverStats.playoutTiming` に
 * `sampleRateMismatchFrames` / `contextSampleRate` / `decodedSampleRate` を追加した。
 * 単体テストは構造のフェイク (実物の AudioContext を持たない環境) で駆動しているため、
 * 実ブラウザの実 `AudioContext` と実 `AudioData` で、鳴らす前の 2 つのレートが計器へ
 * 記録されることをここで固定する。
 *
 * 実リレーへは接続しない。音は `createSilentAudioOutput` が作る gain 0 の出力へ鳴らすため
 * 実際には聞こえないが、Web Audio の出力のグラフと時計は実物を動かす。モック・スタブは
 * 使わない。
 */

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { PlayoutBrowserModules } from "./playoutTestPage";
import { evaluatePlayout, openPlayoutPage } from "./playoutTestPage";

// 自動再生ポリシーの待ちを挟まずに AudioContext を動かす (既存の再生の E2E と同じ)
test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

/** 復号フレームのサンプルレート (Hz)。Opus の復号は configure に関係なく 48 kHz を返す */
const DECODED_SAMPLE_RATE = 48_000;

/** 計器へ記録されることを確かめるために鳴らすフレーム数 */
const PUSHED_FRAME_COUNT = 3;

/** 1 フレームの長さ (マイクロ秒)。20 ms */
const FRAME_DURATION_MICROS = 20_000;

/** 44.1 kHz の AudioContext を作れるかを確かめるための、指定するサンプルレート (Hz) */
const FRACTIONAL_CONTEXT_SAMPLE_RATE = 44_100;

/**
 * 鳴らす音に埋める直流の値
 *
 * 予約するサンプル列の境界を段差の無い状態にするために使う。`boundaryStepCount` は
 * 予約したサンプルの末尾と次の音の先頭の差だけを見るため、隣り合う 20 ms のフレームを
 * 同じ値で埋めれば、AudioContext と復号フレームのレートが違っても段差を 1 件も数えない。
 * 実際にレンダリングされる音では、44.1 kHz の AudioContext に 48 kHz のバッファを並べると
 * 境界のサンプルが 2 倍 (+6 dB) になる (`docs/AUDIO_GLITCH_CAUSES.md` の A1 の実測) が、
 * それは予約したサンプル列には現れない。
 */
const CONTINUOUS_FRAME_VALUE = 0.5;

/** 実ブラウザで 3 フレーム鳴らし、計器を読んだ結果 */
interface RateMismatchCaseResult {
  /** 作った AudioContext が実際に使っているサンプルレート (Hz) */
  readonly audioContextSampleRate: number;
  /** 3 フレームそれぞれの `pushAudio` の結果 */
  readonly pushStatuses: readonly string[];
  /** 計器の `sampleRateMismatchFrames` (不一致として数えたフレーム数) */
  readonly sampleRateMismatchFrames: number;
  /** 計器の `contextSampleRate` (直近の AudioContext のレート)。まだ記録が無ければ null */
  readonly instrumentContextSampleRate: number | null;
  /** 計器の `decodedSampleRate` (直近の復号フレームのレート)。まだ記録が無ければ null */
  readonly instrumentDecodedSampleRate: number | null;
  /** 計器の `boundaryStepCount` (予約したサンプル列の段差の回数) */
  readonly boundaryStepCount: number;
  /** 計器の `playedFrames` (鳴らすと決めた音の数) */
  readonly playedFrames: number;
}

/** `pushRateMismatchFramesInBrowser` へ渡す引数 */
interface RateMismatchCaseArg {
  /** 作る AudioContext のサンプルレート (Hz) */
  readonly audioContextSampleRate: number;
  /** 復号フレーム (`AudioData`) のサンプルレート (Hz) */
  readonly decodedSampleRate: number;
  /** 鳴らすフレーム数 */
  readonly frameCount: number;
  /** 1 フレームの長さ (マイクロ秒) */
  readonly frameDurationMicros: number;
  /** フレームの全サンプルへ埋める値 */
  readonly fillValue: number;
}

/**
 * 実ブラウザで 48 kHz の復号フレームを 3 つ鳴らし、計器を読む
 *
 * `page.evaluate` の本体である。Playwright は関数を文字列としてブラウザへ渡すため、
 * モジュールの定数を参照せず、値はすべて引数で受け取る。
 *
 * モック・スタブは使わない。AudioContext は実物 (`createSilentAudioOutput`) を、
 * 復号フレームは実物の `AudioData` を使う。
 */
const pushRateMismatchFramesInBrowser = async ({
  moduleUrl,
  harnessUrl,
  audioContextSampleRate,
  decodedSampleRate,
  frameCount,
  frameDurationMicros,
  fillValue,
}: RateMismatchCaseArg & PlayoutBrowserModules): Promise<RateMismatchCaseResult> => {
  const { createMediaPlayout } = (await import(moduleUrl)) as typeof import("../../src/index");
  const harness = (await import(harnessUrl)) as typeof import("./playoutBrowserHarness");
  // gain 0 の実 Web Audio の出力。音は聞こえないが、AudioContext の時計と出力のグラフは動く
  const audio = await harness.createSilentAudioOutput({ sampleRate: audioContextSampleRate });
  try {
    // 鳴らす先を付けた再生の入口。映像は構成しないため、音声だけを到着基準で並べる
    const playout = createMediaPlayout({
      audio: { context: audio.context, destination: audio.destination },
    });
    // 復号の出力と同じ形 (48 kHz / 20 ms / f32) の実 AudioData を 3 つ作って鳴らす。
    // TIMESTAMP は 20 ms ずつ進め、時刻の種類は none (時間軸を使わない) にする
    const baseTimestampMicros = harness.wallClockNowMicros();
    const pushStatuses: string[] = [];
    for (let index = 0; index < frameCount; index++) {
      // 予約するサンプル列の境界に段差を作らないため、全サンプルを同じ直流の値で埋める
      const data = harness.createAudioData(baseTimestampMicros + index * frameDurationMicros, {
        sampleRate: decodedSampleRate,
        fill: fillValue,
      });
      playout.trackAudioDecodeInput(data.timestamp, { timestampKind: "none" });
      pushStatuses.push(playout.pushAudio(data).status);
      // 所有権は呼び出し側に残るため、鳴らすと決めた後で閉じる
      data.close();
    }
    // 統計の形は再生の入口 (`createMediaPlayout`) では `audio.timing` である。ライブラリの
    // 購読 (`createMediaSubscriber`) は同じスナップショットを `audio.playoutTiming` として返す
    const timing = playout.getStats().audio?.timing ?? null;
    return {
      audioContextSampleRate: audio.context.sampleRate,
      pushStatuses,
      sampleRateMismatchFrames: timing?.sampleRateMismatchFrames ?? -1,
      instrumentContextSampleRate: timing?.contextSampleRate ?? null,
      instrumentDecodedSampleRate: timing?.decodedSampleRate ?? null,
      boundaryStepCount: timing?.boundaryStepCount ?? -1,
      playedFrames: timing?.playedFrames ?? -1,
    };
  } finally {
    // AudioContext を閉じる (後続のテストへ出力のグラフと時計を持ち越さない)
    await harness.closeSilentAudioOutput(audio);
  }
};

/**
 * 実ブラウザの本体を、指定した AudioContext のサンプルレートで呼び出す
 *
 * ブラウザ側の本体はモジュールの定数を参照できないため、定数はすべてここから渡す。
 *
 * @param page - 実行する Playwright のページ
 * @param audioContextSampleRate - 作る AudioContext のサンプルレート (Hz)
 * @returns 計器と、鳴らした結果
 */
function pushRateMismatchFrames(
  page: Page,
  audioContextSampleRate: number,
): Promise<RateMismatchCaseResult> {
  return evaluatePlayout<RateMismatchCaseArg, RateMismatchCaseResult>(
    page,
    pushRateMismatchFramesInBrowser,
    {
      audioContextSampleRate,
      decodedSampleRate: DECODED_SAMPLE_RATE,
      frameCount: PUSHED_FRAME_COUNT,
      frameDurationMicros: FRAME_DURATION_MICROS,
      fillValue: CONTINUOUS_FRAME_VALUE,
    },
  );
}

/**
 * 3 フレームがすべて鳴り、計器が復号フレームのレートを記録したことを確かめる
 *
 * レートが一致していても食い違っていても、鳴らす前の 2 つのレートは毎回記録される。
 * ここが崩れると `sampleRateMismatchFrames` が 0 のときに「記録していない」のか
 * 「一致していた」のかを区別できなくなる。
 *
 * @param result - 実ブラウザで鳴らした結果
 */
function expectAllFramesPlayed(result: RateMismatchCaseResult): void {
  expect(result.pushStatuses, "3 フレームすべてが鳴ること").toEqual(["played", "played", "played"]);
  expect(result.playedFrames, "鳴らすと決めた音が 3 つであること").toBe(PUSHED_FRAME_COUNT);
  expect(result.instrumentDecodedSampleRate, "計器が復号フレームのレートを記録すること").toBe(
    DECODED_SAMPLE_RATE,
  );
}

test("実 Web Audio で 48 kHz の AudioContext と 48 kHz の復号フレームのレート一致を数えない", async ({
  page,
}) => {
  await test.step("テストページを開く", () => openPlayoutPage(page));

  const result = await test.step("48 kHz の実 AudioContext で 3 フレーム鳴らし、計器を読む", () =>
    pushRateMismatchFrames(page, DECODED_SAMPLE_RATE));

  await test.step("レートが一致しているときの計器を検証する", () => {
    // 前提: 実 AudioContext が指定どおり 48 kHz で作られている
    expect(result.audioContextSampleRate, "AudioContext が 48 kHz で作られること").toBe(
      DECODED_SAMPLE_RATE,
    );
    // 鳴らした 3 フレームが計器へ届いていること (0 件の不一致が「空振り」ではないこと) を確かめる
    expectAllFramesPlayed(result);
    // レートが一致しているため、不一致のフレームとして数えない
    expect(result.sampleRateMismatchFrames, "一致しているフレームを数えないこと").toBe(0);
    // 直近の 2 つのレートは、一致していても毎回更新される
    expect(result.instrumentContextSampleRate, "直近の AudioContext のレートを返すこと").toBe(
      DECODED_SAMPLE_RATE,
    );
    // 予約したサンプル列も連続しているため、段差を数えない
    expect(result.boundaryStepCount, "サンプル列が連続しているため段差を数えないこと").toBe(0);
  });
});

test("実 Web Audio で 44.1 kHz の AudioContext と 48 kHz の復号フレームのレート不一致を毎フレーム数える", async ({
  page,
}) => {
  await test.step("テストページを開く", () => openPlayoutPage(page));

  const result = await test.step("44.1 kHz の実 AudioContext で 3 フレーム鳴らし、計器を読む", () =>
    pushRateMismatchFrames(page, FRACTIONAL_CONTEXT_SAMPLE_RATE));

  // ブラウザが AudioContext の sampleRate の指定を無視して既定のレートで作る環境では、
  // 「44.1 kHz の AudioContext に 48 kHz のバッファ」という前提を作れない。Chromium 156 は
  // 指定を尊重する (対照のテストで確かめる)。前提を作れない環境では、期待値を緩めずに skip する
  test.skip(
    result.audioContextSampleRate !== FRACTIONAL_CONTEXT_SAMPLE_RATE,
    `このブラウザは AudioContext の sampleRate の指定を無視するため (実際: ${result.audioContextSampleRate} Hz)`,
  );

  await test.step("レートが食い違っているときの計器を検証する", () => {
    // 前提: 実 AudioContext が指定どおり 44.1 kHz で作られている
    expect(result.audioContextSampleRate, "AudioContext が 44.1 kHz で作られること").toBe(
      FRACTIONAL_CONTEXT_SAMPLE_RATE,
    );
    // 鳴らした 3 フレームが計器へ届いていること (3 件の不一致が「空振り」ではないこと) を確かめる
    expectAllFramesPlayed(result);
    // 3 フレームすべてを、鳴らす前のレートの食い違いとして数える
    expect(result.sampleRateMismatchFrames, "食い違った 3 フレームを数えること").toBe(
      PUSHED_FRAME_COUNT,
    );
    // 直近の 2 つのレートは、食い違った値のまま記録される
    expect(result.instrumentContextSampleRate, "直近の AudioContext のレートを返すこと").toBe(
      FRACTIONAL_CONTEXT_SAMPLE_RATE,
    );
    // 段差の計器が見るのは予約したサンプル列だけであり、この現象を数えない
    // (数えるようになったら計器の意味が変わる。docs/AUDIO_GLITCH_CAUSES.md の A1)
    expect(result.boundaryStepCount, "予約したサンプル列が連続しているため段差を数えないこと").toBe(
      0,
    );
  });
});

/** `readContextSampleRateInBrowser` へ渡す引数 */
interface ContextSampleRateArg {
  /** 作る AudioContext のサンプルレート (Hz) */
  readonly sampleRate: number;
}

/**
 * 実 AudioContext が指定したサンプルレートをそのまま使うかを確かめる (対照)
 *
 * `page.evaluate` の本体である。再生には使わず、AudioContext を作って実際のレートを
 * 読んでから閉じる。値は引数で受け取る (Playwright は関数を文字列として渡すため、
 * モジュールの定数を参照できない)。
 */
const readContextSampleRateInBrowser = async ({
  sampleRate,
}: ContextSampleRateArg & PlayoutBrowserModules): Promise<number> => {
  const context = new AudioContext({ sampleRate });
  try {
    return context.sampleRate;
  } finally {
    await context.close();
  }
};

test("実 AudioContext は指定した 44100 Hz のサンプルレートのまま作られる", async ({ page }) => {
  await test.step("テストページを開く", () => openPlayoutPage(page));

  const actualSampleRate =
    await test.step("44100 Hz を指定して実 AudioContext を作り、レートを読む", () =>
      evaluatePlayout<ContextSampleRateArg, number>(page, readContextSampleRateInBrowser, {
        sampleRate: FRACTIONAL_CONTEXT_SAMPLE_RATE,
      }));

  // ブラウザが sampleRate の指定を無視して既定のレートで作る環境では、この対照を確かめられない。
  // その場合、44.1 kHz のテストも前提を作れないため、expect を緩めずに skip する
  test.skip(
    actualSampleRate !== FRACTIONAL_CONTEXT_SAMPLE_RATE,
    `このブラウザは AudioContext の sampleRate の指定を無視するため (実際: ${actualSampleRate} Hz)`,
  );

  // 指定したレートがそのまま使われる。この対照が通ることで、44.1 kHz のテストが確かめている
  // 「44.1 kHz の AudioContext」が実物のレートであると言える
  expect(actualSampleRate, "指定した 44100 Hz のまま作られること").toBe(
    FRACTIONAL_CONTEXT_SAMPLE_RATE,
  );
});
