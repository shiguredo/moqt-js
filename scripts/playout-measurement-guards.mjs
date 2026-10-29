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
  return (
    [seconds, capturedSamples, audioCount, videoCount, pairCount, minimumPairsPerSecond].every(
      (value) => Number.isFinite(value),
    ) &&
    seconds >= 2 &&
    minimumPairsPerSecond > 0 &&
    capturedSamples >= 48000 * (seconds - 1) &&
    audioCount >= seconds * 30 &&
    videoCount >= seconds * 15 &&
    pairCount >= seconds * minimumPairsPerSecond
  );
}
