/**
 * 同じ収録時計の PCM を局所的に照合する。伸縮がある出力へ全体で 1 個の遅延を当てない。
 * 相関は波形の一致度であり、聴感品質や MOS の推定値ではない。
 */
export function readFloat32Pcm(bytes, expectedSamples) {
  if (
    !Number.isInteger(expectedSamples) ||
    expectedSamples <= 0 ||
    bytes.byteLength !== expectedSamples * 4
  )
    throw new Error(
      `Float32 recording length mismatch: expected=${expectedSamples * 4}, actual=${bytes.byteLength}`,
    );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = Float32Array.from({ length: expectedSamples }, (_, index) =>
    view.getFloat32(index * 4, true),
  );
  if (!samples.every((value) => Number.isFinite(value)))
    throw new Error("Float32 recording contains non-finite samples");
  return samples;
}

function distribution(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  return { p10: at(0.1), p50: at(0.5), p90: at(0.9), p95: at(0.95) };
}

function moments(samples, start, length) {
  let sum = 0;
  let squares = 0;
  for (let index = start; index < start + length; index++) {
    const value = samples[index];
    sum += value;
    squares += value * value;
  }
  return { mean: sum / length, variance: Math.max(0, squares - (sum * sum) / length) };
}

function correlation(reference, start, output, delay, length, referenceMoments) {
  let sum = 0;
  let squares = 0;
  let product = 0;
  for (let index = 0; index < length; index++) {
    const value = output[start + delay + index];
    sum += value;
    squares += value * value;
    product += reference[start + index] * value;
  }
  const covariance = product - referenceMoments.mean * sum;
  const variance = Math.max(0, squares - (sum * sum) / length);
  const normalizer = Math.sqrt(referenceMoments.variance * variance);
  return {
    correlation: normalizer > 1e-20 ? covariance / normalizer : 0,
    gain: referenceMoments.variance > 1e-20 ? covariance / referenceMoments.variance : 0,
  };
}

/** 粗い探索だけに平均化した信号を使い、採用する遅延と相関は元の全サンプルで求める。 */
function reduce(samples, stride) {
  const result = new Float64Array(Math.floor(samples.length / stride));
  for (let index = 0; index < result.length; index++) {
    let sum = 0;
    for (let offset = 0; offset < stride; offset++) sum += samples[index * stride + offset];
    result[index] = sum / stride;
  }
  return result;
}

/** 完全無音の区間を調べ、近傍で一意に照合できた原音も活動している場合だけ区別して数える。 */
function zeroIntervals(reference, output, rate, accepted, minimumRms) {
  if (accepted.length === 0) return [];
  const prefixSum = new Float64Array(reference.length + 1);
  const prefixSquares = new Float64Array(reference.length + 1);
  for (let index = 0; index < reference.length; index++) {
    prefixSum[index + 1] = prefixSum[index] + reference[index];
    prefixSquares[index + 1] = prefixSquares[index] + reference[index] ** 2;
  }
  const first = Math.max(0, Math.min(...accepted.map((window) => window.outputStartSample)));
  const last = Math.min(
    output.length,
    Math.max(...accepted.map((window) => window.outputEndSample)),
  );
  const result = [];
  const anchors = accepted
    .filter((window) => window.correlation >= 0.95)
    .sort((left, right) => left.outputCenterSample - right.outputCenterSample);
  let runStart = null;
  for (let index = first; index <= last; index++) {
    if (index < last && Math.abs(output[index]) < 1e-7) {
      runStart ??= index;
      continue;
    }
    if (runStart === null) continue;
    const length = index - runStart;
    if (length >= Math.ceil(rate * 0.0005)) {
      // 無音の中の相関は定義できない。前後の高相関の区間で可能な遅延の範囲を作る。
      // その範囲のどこへ対応させても原音が活動している場合だけ、活動中の完全無音とする。
      const intervalStart = runStart;
      const before = anchors.findLast((window) => window.outputCenterSample <= intervalStart);
      const after = anchors.find((window) => window.outputCenterSample >= index);
      const firstReference =
        before && after
          ? runStart - Math.max(before.delaySamples, after.delaySamples) - Math.ceil(rate * 0.002)
          : -1;
      const lastReference =
        before && after
          ? runStart - Math.min(before.delaySamples, after.delaySamples) + Math.ceil(rate * 0.002)
          : -1;
      const supported =
        before !== undefined &&
        after !== undefined &&
        runStart - before.outputCenterSample <= rate * 0.25 &&
        after.outputCenterSample - index <= rate * 0.25 &&
        firstReference >= 0 &&
        lastReference + length <= reference.length;
      let minimumReferenceRms = Infinity;
      let maximumReferenceRms = 0;
      if (supported)
        for (let start = firstReference; start <= lastReference; start++) {
          const sum = prefixSum[start + length] - prefixSum[start];
          const squares = prefixSquares[start + length] - prefixSquares[start];
          const rms = Math.sqrt(Math.max(0, squares / length - (sum / length) ** 2));
          minimumReferenceRms = Math.min(minimumReferenceRms, rms);
          maximumReferenceRms = Math.max(maximumReferenceRms, rms);
        }
      result.push({
        startSeconds: runStart / rate,
        durationMs: (length / rate) * 1000,
        minimumReferenceRms: supported ? minimumReferenceRms : null,
        maximumReferenceRms: supported ? maximumReferenceRms : null,
        activity: !supported
          ? "unknown"
          : minimumReferenceRms >= minimumRms
            ? "active"
            : maximumReferenceRms < minimumRms
              ? "quiet"
              : "unknown",
      });
    }
    runStart = null;
  }
  return result;
}

export function compareOutputPcm({
  reference,
  output,
  sampleRate,
  minimumDelayMs = 0,
  maximumDelayMs = 400,
  windowMs = 120,
  stepMs = 40,
  minimumRms = 0.003,
  minimumCorrelation = 0.8,
  minimumPeakMargin = 0.015,
}) {
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate < 8000 ||
    sampleRate > 96000 ||
    reference?.length !== output?.length ||
    !reference?.length ||
    !reference.every((value) => Number.isFinite(value)) ||
    !output.every((value) => Number.isFinite(value)) ||
    ![
      minimumDelayMs,
      maximumDelayMs,
      windowMs,
      stepMs,
      minimumRms,
      minimumCorrelation,
      minimumPeakMargin,
    ].every((value) => Number.isFinite(value)) ||
    minimumDelayMs > maximumDelayMs ||
    windowMs <= 0 ||
    stepMs <= 0 ||
    minimumRms <= 0 ||
    minimumCorrelation < 0 ||
    minimumCorrelation > 1 ||
    minimumPeakMargin < 0
  )
    throw new Error("Expected finite matching PCM recordings and valid comparison parameters");
  const stride = Math.max(1, Math.round(sampleRate / 4000));
  const reducedReference = reduce(reference, stride);
  const reducedOutput = reduce(output, stride);
  const coarseLength = Math.round((sampleRate * windowMs) / 1000 / stride);
  const coarseStep = Math.max(1, Math.round((sampleRate * stepMs) / 1000 / stride));
  const minimumDelay = Math.ceil((sampleRate * minimumDelayMs) / 1000 / stride);
  const maximumDelay = Math.floor((sampleRate * maximumDelayMs) / 1000 / stride);
  const windows = [];
  for (let start = 0; start + coarseLength <= reducedReference.length; start += coarseStep) {
    const referenceMoments = moments(reducedReference, start, coarseLength);
    const rms = Math.sqrt(referenceMoments.variance / coarseLength);
    if (rms < minimumRms) continue;
    const minimum = Math.max(minimumDelay, -start);
    const maximum = Math.min(maximumDelay, reducedOutput.length - start - coarseLength);
    if (minimum > maximum) continue;
    const candidates = [];
    let best = { correlation: -Infinity, delay: minimum };
    for (let delay = minimum; delay <= maximum; delay++) {
      const candidate = correlation(
        reducedReference,
        start,
        reducedOutput,
        delay,
        coarseLength,
        referenceMoments,
      );
      candidates.push({ ...candidate, delay });
      if (candidate.correlation > best.correlation) best = { ...candidate, delay };
    }
    // 3 ms より離れた別のピークが同程度なら、周期の何個分ずれたかは確定できない。
    const competing = candidates.filter(
      (candidate) => Math.abs(candidate.delay - best.delay) * stride > sampleRate * 0.003,
    );
    const peakMargin =
      competing.length === 0
        ? 0
        : best.correlation - Math.max(...competing.map((candidate) => candidate.correlation));
    const rawStart = start * stride;
    const rawLength = coarseLength * stride;
    const rawMoments = moments(reference, rawStart, rawLength);
    let refined = { correlation: -Infinity, gain: 0, delay: best.delay * stride };
    // 粗い信号では周期内の位相により隣の小ピークが勝つ場合がある。
    // 別ピークと区別しない 3 ms の範囲全体を、元のサンプルで探索し直す。
    const refinementRadius = Math.ceil(sampleRate * 0.003);
    const first = Math.max(
      Math.ceil((sampleRate * minimumDelayMs) / 1000),
      -rawStart,
      best.delay * stride - refinementRadius,
    );
    const last = Math.min(
      Math.floor((sampleRate * maximumDelayMs) / 1000),
      output.length - rawStart - rawLength,
      best.delay * stride + refinementRadius,
    );
    for (let delay = first; delay <= last; delay++) {
      const candidate = correlation(reference, rawStart, output, delay, rawLength, rawMoments);
      if (candidate.correlation > refined.correlation) refined = { ...candidate, delay };
    }
    const accepted = refined.correlation >= minimumCorrelation && peakMargin >= minimumPeakMargin;
    windows.push({
      referenceStartSample: rawStart,
      outputStartSample: rawStart + refined.delay,
      outputEndSample: rawStart + refined.delay + rawLength,
      outputCenterSample: rawStart + refined.delay + rawLength / 2,
      delaySamples: refined.delay,
      delayMs: (refined.delay / sampleRate) * 1000,
      correlation: refined.correlation,
      gain: refined.gain,
      peakMargin,
      referenceRms: rms,
      accepted,
    });
  }
  const accepted = windows.filter((window) => window.accepted);
  const zeros = zeroIntervals(reference, output, sampleRate, accepted, minimumRms);
  return {
    parameters: {
      sampleRate,
      minimumDelayMs,
      maximumDelayMs,
      windowMs,
      stepMs,
      minimumRms,
      minimumCorrelation,
      minimumPeakMargin,
    },
    activeWindows: windows.length,
    acceptedWindows: accepted.length,
    rejectedWindows: windows.length - accepted.length,
    delayMs: distribution(accepted.map((window) => window.delayMs)),
    correlation: distribution(accepted.map((window) => window.correlation)),
    allCandidateCorrelations: distribution(windows.map((window) => window.correlation)),
    gain: distribution(accepted.map((window) => window.gain)),
    activeZeroMs: zeros
      .filter((interval) => interval.activity === "active")
      .reduce((sum, interval) => sum + interval.durationMs, 0),
    quietZeroMs: zeros
      .filter((interval) => interval.activity === "quiet")
      .reduce((sum, interval) => sum + interval.durationMs, 0),
    unknownZeroMs: zeros
      .filter((interval) => interval.activity === "unknown")
      .reduce((sum, interval) => sum + interval.durationMs, 0),
    zeros,
    windows,
  };
}
