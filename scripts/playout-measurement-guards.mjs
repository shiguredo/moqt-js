/** 欠けた入力や不十分な A/V の収録を、正常な測定として採用しない。 */
export function requireAudioFrame(frame, index, frames) {
  if (
    frame?.packetIndex !== index ||
    frame.samples?.length !== frames ||
    !frame.samples.every(Number.isFinite)
  ) {
    throw new Error(`Missing or invalid decoded audio frame: ${index}`);
  }
  return frame.samples;
}

/** コールバックだけでなく、実表示と音声に対応する組を必要とする。 */
export function hasAvCoverage(
  { seconds, capturedSamples, audioCount, videoCount, pairCount, captureErrors = [] },
  minimumPairsPerSecond = 15,
) {
  // 先頭 1 秒は音声と映像の初期化を含むため、呼び出し側も集計から除外している。
  const observedSeconds = seconds - 1;
  return (
    [seconds, capturedSamples, audioCount, videoCount, pairCount, minimumPairsPerSecond].every(
      (value) => Number.isFinite(value),
    ) &&
    seconds >= 2 &&
    captureErrors.length === 0 &&
    minimumPairsPerSecond > 0 &&
    capturedSamples >= 48000 * (seconds - 1) &&
    audioCount >= observedSeconds * 30 &&
    videoCount >= observedSeconds * 15 &&
    pairCount >= observedSeconds * minimumPairsPerSecond
  );
}

/** ページ例外へ届かない収録器の停止も検出する (Web Audio §1.32.4.2、策定中の仕様)。 */
export function watchProcessorErrors(node) {
  const errors = [];
  node.onprocessorerror = (event) => {
    errors.push(event.message ?? "AudioWorklet processor failed");
  };
  return errors;
}

/** Worklet 内の収録位置を検査し、メッセージの欠落を連続した PCM と取り違えない。 */
export function joinCaptureBlocks(blocks, sampleRate) {
  const samples = new Float32Array(blocks.reduce((sum, block) => sum + block.samples.length, 0));
  let position = 0;
  let expectedFrame = null;
  let missingFrames = 0;
  let discontinuities = 0;
  let stepMax = 0;
  const gaps = [];
  for (const block of blocks) {
    if (expectedFrame !== null && block.frame !== expectedFrame) {
      discontinuities++;
      missingFrames += Math.max(0, block.frame - expectedFrame);
      gaps.push({ expectedFrame, frame: block.frame });
    }
    samples.set(block.samples, position);
    position += block.samples.length;
    expectedFrame = block.frame + block.samples.length;
  }
  for (let index = 1; index < samples.length; index++)
    stepMax = Math.max(stepMax, Math.abs(samples[index] - samples[index - 1]));
  return {
    gaps,
    samples,
    missingFrames,
    missingMs: (missingFrames * 1000) / sampleRate,
    discontinuities,
    stepMax,
  };
}

/** 1 件の測定中の未処理例外を記録し、正常な出力だけで失敗を隠さない。 */
export async function measurePage(page, evaluate, argument) {
  const pageErrors = [];
  const onError = (error) => pageErrors.push(error.message);
  page.on("pageerror", onError);
  try {
    const result = await page.evaluate(evaluate, argument);
    return { ...result, valid: result.valid !== false && pageErrors.length === 0, pageErrors };
  } finally {
    page.off("pageerror", onError);
  }
}
