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
  { seconds, capturedSamples, audioCount, videoCount, pairCount },
  minimumPairsPerSecond = 15,
) {
  // 先頭 1 秒は音声と映像の初期化を含むため、呼び出し側も集計から除外している。
  const observedSeconds = seconds - 1;
  return (
    [seconds, capturedSamples, audioCount, videoCount, pairCount, minimumPairsPerSecond].every(
      (value) => Number.isFinite(value),
    ) &&
    seconds >= 2 &&
    minimumPairsPerSecond > 0 &&
    capturedSamples >= 48000 * (seconds - 1) &&
    audioCount >= observedSeconds * 30 &&
    videoCount >= observedSeconds * 15 &&
    pairCount >= observedSeconds * minimumPairsPerSecond
  );
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
