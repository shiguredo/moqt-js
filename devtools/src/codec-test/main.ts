/**
 * codec Wrapper / Worker プロトコルの E2E テストページ
 *
 * ライブラリのソース (src/codec) を直接 import し、実ブラウザの WebCodecs と
 * 実 Worker を使って Wrapper の契約を観測する。テストページは dev サーバー
 * 専用であり、ビルド対象 (rollupOptions.input) には含めない。
 *
 * 各テストは結果を JSON へ要約して返し、失敗時は reject する。
 * Playwright 側は window.runCodecTest を page.evaluate で呼び出し、
 * reject をそのままテスト失敗として受け取る。
 */

import { runAudioDecoderTest, runAudioEncoderTest, runAudioSamplesTest } from "./audio.ts";
import {
  runVideoDecoderTest,
  runVideoEncoderReconfigureTest,
  runVideoEncoderTest,
} from "./video.ts";
import type { CodecTestName, CodecTestResult, CodecTestResultMap } from "./types.ts";

declare global {
  interface Window {
    // Playwright の page.evaluate から呼び出すテスト実行関数
    runCodecTest: <Name extends CodecTestName>(name: Name) => Promise<CodecTestResultMap[Name]>;
  }
}

/**
 * テスト名とテスト本体の対応
 *
 * テスト本体は useWorker (直接モード / Worker モード) だけが異なる。
 */
const CODEC_TESTS: { [Name in CodecTestName]: () => Promise<CodecTestResultMap[Name]> } = {
  videoEncoderDirect: () => runVideoEncoderTest(false),
  videoEncoderWorker: () => runVideoEncoderTest(true),
  videoDecoderDirect: () => runVideoDecoderTest(false),
  videoDecoderWorker: () => runVideoDecoderTest(true),
  audioEncoderDirect: () => runAudioEncoderTest(false),
  audioEncoderWorker: () => runAudioEncoderTest(true),
  audioDecoderDirect: () => runAudioDecoderTest(false),
  audioDecoderWorker: () => runAudioDecoderTest(true),
  audioSamples: () => runAudioSamplesTest(),
  videoEncoderReconfigureDirect: () => runVideoEncoderReconfigureTest(false),
  videoEncoderReconfigureWorker: () => runVideoEncoderReconfigureTest(true),
};

/**
 * テスト名に対応するテストを実行する
 */
async function runCodecTest<Name extends CodecTestName>(
  name: Name,
): Promise<CodecTestResultMap[Name]> {
  const codecTest = CODEC_TESTS[name];
  if (codecTest === undefined) {
    throw new Error(`unknown codec test: ${name}`);
  }
  // 戻り値の Promise をそのまま返す (await して返し直す必要はない)
  return codecTest();
}

/**
 * 実行結果をページ上とコンソールへ記録する
 *
 * 結果の全体はページの DOM に残し (headed 実行時の確認用)、
 * コンソールへは進行だけを出してログを膨らませない。
 */
function reportResult(name: string, result: CodecTestResult): void {
  const statusElement = document.getElementById("codec-test-status");
  if (statusElement !== null) {
    statusElement.textContent = `${name}\n${JSON.stringify(result, null, 2)}`;
  }
  console.log(`codec test finished: ${name}`);
}

window.runCodecTest = async <Name extends CodecTestName>(
  name: Name,
): Promise<CodecTestResultMap[Name]> => {
  console.log(`codec test started: ${name}`);
  const result = await runCodecTest(name);
  reportResult(name, result);
  return result;
};
