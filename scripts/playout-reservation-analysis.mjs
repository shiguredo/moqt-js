/** 短い配列や NaN を、比較回数 0 の正常一致として採用しない。 */
export function comparePcmSamples(actual, expected) {
  if (
    actual.length === 0 ||
    actual.length !== expected.length ||
    !actual.every((value) => Number.isFinite(value)) ||
    !expected.every((value) => Number.isFinite(value))
  )
    throw new Error("PCM comparison requires equally sized finite nonempty samples");
  let maximumError = 0;
  let differingSamples = 0;
  for (let index = 0; index < actual.length; index++) {
    const error = Math.abs(actual[index] - expected[index]);
    maximumError = Math.max(maximumError, error);
    if (error > 1e-6) differingSamples++;
  }
  return { maximumError, differingSamples };
}

/** 保存した実測の採否と形式を確かめ、到着間隔と PCM を変更せずに再利用する。 */
export function audioReplayFrames(trace) {
  if (
    trace?.valid !== true ||
    !Array.isArray(trace.audio) ||
    !Array.isArray(trace.decodedFrames) ||
    trace.audio.length !== trace.decodedFrames.length ||
    trace.audio.length < 2
  )
    throw new Error("Audio trace must contain valid matching arrivals and decoded frames");
  const frames = trace.decodedFrames.map((frame, index) => {
    const atMs = trace.audio[index].atMs;
    if (
      !Number.isFinite(atMs) ||
      !Number.isFinite(frame.timestamp) ||
      frame.sampleRate !== 48000 ||
      frame.channels !== 1 ||
      frame.samples?.length !== 960 ||
      !Array.from(frame.samples).every((value) => Number.isFinite(value)) ||
      (index > 0 &&
        (atMs < trace.audio[index - 1].atMs ||
          frame.timestamp <= trace.decodedFrames[index - 1].timestamp))
    )
      throw new Error(`Invalid decoded PCM arrival at frame ${index}`);
    return { timestamp: frame.timestamp, samples: frame.samples, atMs: atMs - trace.audio[0].atMs };
  });
  if (frames.at(-1).atMs <= 0 || frames.at(-1).atMs > 120000)
    throw new Error("Audio trace duration must be between 0 and 120000 ms");
  return frames;
}

/** 予約区間と独立した実出力の信号を照合し、原音の無音を音切れに数えない。 */
export function analyseReservationCoverage({
  reservations,
  samples,
  coverage,
  sampleRate,
  firstFrame,
  minLeadSeconds = 0.01,
}) {
  if (
    reservations.length === 0 ||
    samples.length !== coverage.length ||
    ![sampleRate, firstFrame, minLeadSeconds].every((value) => Number.isFinite(value)) ||
    sampleRate <= 0 ||
    !samples.every((value) => Number.isFinite(value)) ||
    !coverage.every((value) => Number.isFinite(value))
  )
    throw new Error("Invalid reservation coverage input");
  const ordered = reservations.toSorted((left, right) => left.startSeconds - right.startSeconds);
  const expected = new Int32Array(coverage.length);
  const boundary = new Uint8Array(coverage.length);
  const gaps = [];
  let endSeconds = null;
  let truncatedReservationSamples = 0;
  for (const reservation of ordered) {
    const { startSeconds, observedAtSeconds } = reservation;
    if (
      ![startSeconds, reservation.endSeconds, observedAtSeconds].every((value) =>
        Number.isFinite(value),
      ) ||
      reservation.endSeconds <= startSeconds
    )
      throw new Error("Invalid reservation interval");
    const first = Math.ceil(startSeconds * sampleRate - firstFrame);
    const last = Math.ceil(reservation.endSeconds * sampleRate - firstFrame);
    truncatedReservationSamples += Math.max(0, -first) + Math.max(0, last - coverage.length);
    for (let index = Math.max(0, first); index < Math.min(last, expected.length); index++)
      expected[index]++;
    // 境界の量子化は別に残す。2 サンプルを超える内部の不一致を許容しない。
    for (const edge of [first, last])
      for (let offset = -2; offset <= 2; offset++) {
        const index = edge + offset;
        if (index >= 0 && index < boundary.length) boundary[index] = 1;
      }
    if (endSeconds !== null && startSeconds - endSeconds > 1e-9) {
      const duration = startSeconds - endSeconds;
      const past = Math.max(0, Math.min(startSeconds, observedAtSeconds) - endSeconds);
      const safety = Math.max(
        0,
        Math.min(startSeconds, observedAtSeconds + minLeadSeconds) -
          Math.max(endSeconds, observedAtSeconds),
      );
      const gap = {
        startSeconds: endSeconds,
        endSeconds: startSeconds,
        observedAtSeconds,
        durationMs: duration * 1000,
        pastMs: past * 1000,
        safetyLeadMs: safety * 1000,
        laterMs: Math.max(0, duration - past - safety) * 1000,
        interiorSamples: 0,
        nonzeroInteriorSamples: 0,
      };
      for (
        let index = Math.max(0, Math.ceil(endSeconds * sampleRate - firstFrame) + 2);
        index < Math.min(samples.length, Math.floor(startSeconds * sampleRate - firstFrame) - 2);
        index++
      ) {
        gap.interiorSamples++;
        if (Math.abs(samples[index]) > 1e-7) gap.nonzeroInteriorSamples++;
      }
      gaps.push(gap);
    }
    endSeconds = Math.max(endSeconds ?? -Infinity, reservation.endSeconds);
  }
  let coverageMismatchSamples = 0;
  for (let index = 0; index < coverage.length; index++) {
    if (boundary[index] === 0 && Math.abs(coverage[index] - expected[index]) > 1e-6)
      coverageMismatchSamples++;
  }
  const first = Math.max(0, Math.ceil(ordered[0].startSeconds * sampleRate - firstFrame));
  const last = Math.min(coverage.length, Math.ceil(endSeconds * sampleRate - firstFrame));
  let zeroSamples = 0;
  const observedGaps = [];
  let gapStart = null;
  for (let index = first; index < last; index++) {
    if (coverage[index] < 0.5) {
      zeroSamples++;
      gapStart ??= index;
    } else if (gapStart !== null) {
      observedGaps.push({ first: gapStart, last: index });
      gapStart = null;
    }
  }
  if (gapStart !== null) observedGaps.push({ first: gapStart, last });
  return {
    gaps,
    observedGaps,
    coverageMismatchSamples,
    truncatedReservationSamples,
    expectedGapMs: gaps.reduce((sum, gap) => sum + gap.durationMs, 0),
    observedGapMs: (zeroSamples * 1000) / sampleRate,
    maskedBoundarySamples: boundary.reduce((sum, value) => sum + value, 0),
  };
}
