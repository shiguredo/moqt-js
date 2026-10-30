/** 実際の時間軸への観測と出力予約を記録する。元の処理と返り値は維持する。 */
export async function installTimingTrace({ moduleUrl, stallMs = 0 }) {
  const { PlayoutTimeline } = await import(moduleUrl);
  const trace = {
    timeOriginMs: performance.timeOrigin,
    startedMs: null,
    stoppedMs: null,
    arrivals: [],
    presentations: [],
    leads: [],
  };
  const originals = new Map();
  const observation = { stallTimer: undefined, audioCount: 0 };
  const prototype = PlayoutTimeline.prototype;
  const active = () => trace.startedMs !== null && trace.stoppedMs === null;
  for (const name of ["observe", "recordPresentation", "observeAudioOutputLead"]) {
    const original = prototype[name];
    originals.set(name, original);
    prototype[name] = function recordObservedTiming(...arguments_) {
      const result = Reflect.apply(original, this, arguments_);
      if (!active()) return result;
      const atMs = performance.now();
      if (name === "observe") {
        const [stream, wallClockMs, timestampMicros] = arguments_;
        trace.arrivals.push({ stream, atMs, timestampMs: timestampMicros / 1000, wallClockMs });
      } else if (name === "recordPresentation") {
        const [stream, timestampMicros, presentedMicros, targetMicros] = arguments_;
        trace.presentations.push({
          stream,
          atMs,
          timestampMs: timestampMicros / 1000,
          presentedMs: Number(presentedMicros) / 1000,
          delayMs: Number(presentedMicros - BigInt(Math.round(timestampMicros))) / 1000,
          targetDelayMs:
            targetMicros === undefined
              ? null
              : Number(targetMicros - BigInt(Math.round(timestampMicros))) / 1000,
        });
        if (stream === "audio" && ++observation.audioCount === 5 && stallMs > 0) {
          // API を置き換えず、起動時のメインスレッド負荷を実際に発生させる。
          observation.stallTimer = setTimeout(() => {
            const startedMs = performance.now();
            while (performance.now() - startedMs < stallMs) {
              // 指定時間だけ処理を占有する。音声のレンダリングと QUIC の Worker は動き続ける。
            }
            trace.stall = { startedMs, endedMs: performance.now(), requestedMs: stallMs };
          }, 0);
        }
      } else trace.leads.push({ atMs, leadMs: arguments_[0] });
      return result;
    };
  }
  window.devtoolsTimingTrace = {
    start() {
      trace.startedMs = performance.now();
    },
    stop() {
      clearTimeout(observation.stallTimer);
      trace.stoppedMs = performance.now();
      for (const [name, original] of originals) prototype[name] = original;
      return trace;
    },
  };
}

/** 異なる周期の実出力を、直前の音声から同じ媒体時刻へ換算して照合する。 */
export function pairPresentationDelays(audio, video) {
  const orderedAudio = audio.toSorted((left, right) => left.timestampMs - right.timestampMs);
  let audioIndex = 0;
  const pairs = [];
  for (const frame of video.toSorted((left, right) => left.timestampMs - right.timestampMs)) {
    while (orderedAudio[audioIndex + 1]?.timestampMs <= frame.timestampMs) audioIndex++;
    const sound = orderedAudio[audioIndex];
    // 遠い媒体時刻の音声で欠落区間の同期まで測ったことにしない。
    if (
      sound &&
      frame.timestampMs >= sound.timestampMs &&
      frame.timestampMs - sound.timestampMs <= 40
    )
      pairs.push({
        atMs: frame.atMs,
        presentedMs: frame.presentedMs,
        timestampMs: frame.timestampMs,
        delayMs: frame.delayMs - sound.delayMs,
      });
  }
  return pairs;
}

/** 空の区間を 0 ms と表示せず、全標本と起動 3 秒、定常を分ける。 */
export function summarizeTimingTrace(trace) {
  const records = trace.presentations;
  const finite = records.every(
    (record) =>
      ["audio", "video"].includes(record.stream) &&
      [record.atMs, record.timestampMs, record.presentedMs, record.delayMs].every((value) =>
        Number.isFinite(value),
      ),
  );
  const stopWallMs =
    Number.isFinite(trace.timeOriginMs) && Number.isFinite(trace.stoppedMs)
      ? trace.timeOriginMs + trace.stoppedMs
      : null;
  // 予約を記録しただけで出力時刻がまだ来ていない音声は、停止時の分布から分ける。
  const completed = finite
    ? records.filter((record) => stopWallMs === null || record.presentedMs <= stopWallMs)
    : [];
  const firstMs = completed.length === 0 ? null : Math.min(...completed.map((r) => r.presentedMs));
  const distribution = (values) => {
    const sorted = values.toSorted((left, right) => left - right);
    const percentile = (point) => sorted[Math.max(0, Math.ceil(sorted.length * point) - 1)] ?? null;
    return {
      count: values.length,
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      max: sorted.at(-1) ?? null,
      over200: values.filter((value) => value > 200).length,
    };
  };
  const phases = (samples, value = (record) => record.delayMs) => ({
    whole: distribution(samples.map((record) => value(record))),
    startup: distribution(
      samples.filter((r) => r.presentedMs < firstMs + 3000).map((record) => value(record)),
    ),
    steady: distribution(
      samples.filter((r) => r.presentedMs >= firstMs + 3000).map((record) => value(record)),
    ),
  });
  const audio = completed.filter((r) => r.stream === "audio");
  const video = completed.filter((r) => r.stream === "video");
  const pairs = pairPresentationDelays(audio, video);
  return {
    valid: finite && audio.length > 0 && video.length > 0 && pairs.length >= video.length * 0.9,
    phaseBoundaryMs: 3000,
    firstObservationAfterSubscribeMs:
      records.length === 0 || !finite
        ? null
        : Math.min(...records.map((r) => r.atMs)) - trace.startedMs,
    firstOutputAfterSubscribeMs:
      firstMs === null || !Number.isFinite(trace.timeOriginMs)
        ? null
        : firstMs - trace.timeOriginMs - trace.startedMs,
    pendingAudioReservations:
      stopWallMs === null
        ? null
        : records.filter((r) => r.stream === "audio" && r.presentedMs > stopWallMs).length,
    audio: phases(audio),
    video: phases(video),
    skew: phases(pairs),
    absoluteSkew: phases(pairs, (record) => Math.abs(record.delayMs)),
    seconds: Array.from(
      {
        length:
          firstMs === null
            ? 0
            : Math.floor((Math.max(...completed.map((r) => r.presentedMs)) - firstMs) / 1000) + 1,
      },
      (_, second) => ({
        second,
        audio: distribution(
          audio
            .filter(
              (r) =>
                r.presentedMs >= firstMs + second * 1000 &&
                r.presentedMs < firstMs + (second + 1) * 1000,
            )
            .map((r) => r.delayMs),
        ),
        video: distribution(
          video
            .filter(
              (r) =>
                r.presentedMs >= firstMs + second * 1000 &&
                r.presentedMs < firstMs + (second + 1) * 1000,
            )
            .map((r) => r.delayMs),
        ),
      }),
    ),
  };
}
