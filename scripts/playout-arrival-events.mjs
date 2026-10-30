/** 追加の到着の揺らぎ。音を代替せず、実 AudioData / VideoFrame を渡す時刻だけを変える。 */
function extraDelay(pattern, stream, mediaMs, index) {
  if (pattern === "startup-stall" && mediaMs >= 100 && mediaMs < 320) return 320 - mediaMs;
  if (
    (pattern === "both-stall" || (pattern === "audio-stall" && stream === "audio")) &&
    mediaMs >= 2000 &&
    mediaMs < 2180
  )
    return 2180 - mediaMs;
  if (pattern === "video-step" && stream === "video" && mediaMs >= 2000 && mediaMs < 5000)
    return 120;
  if (pattern === "jitter") return ((index * 1664525 + 1013904223) >>> 0) % 31;
  // 短い窓で静かな区間だけを学ぶと、次の揺らぎを毎回未経験として扱う条件。
  if (pattern === "recurring-jitter" && stream === "audio" && mediaMs % 1200 < 80) return 60;
  if (pattern === "recurring-jitter120" && stream === "audio" && mediaMs % 1200 < 80) return 120;
  if (pattern === "recurring-jitter180" && stream === "audio" && mediaMs % 1200 < 80) return 180;
  return 0;
}

/** 媒体時刻から到着列を作り、実際に注入する音声欠落の数を記録する。 */
export function createArrivalEvents(pattern, seconds, originMs, epoch, trace = null) {
  if (pattern === "recorded") return recordedEvents(trace, seconds, originMs, epoch);
  const events = [];
  let randomState = 0x74219;
  let injectedAudioLoss = 0;
  for (const stream of ["audio", "video"]) {
    const frequency = stream === "audio" ? 50 : 30;
    let previousArrivalMs = -Infinity;
    for (let index = 0; index < seconds * frequency; index++) {
      const mediaMs = (index * 1000) / frequency;
      randomState = (randomState * 1664525 + 1013904223) >>> 0;
      if (stream === "audio" && pattern === "loss5" && randomState / 4294967296 < 0.05) {
        injectedAudioLoss++;
        continue;
      }
      // 復号済みの入口ではトラック内の出力順を保つ。復号前の順序逆転とは分ける。
      const arrivalMs = Math.max(
        previousArrivalMs + 0.1,
        originMs + mediaMs + 20 + extraDelay(pattern, stream, mediaMs, index),
      );
      previousArrivalMs = arrivalMs;
      events.push({
        stream,
        index,
        mediaMs,
        timestamp: epoch + Math.round(mediaMs * 1000),
        arrivalMs,
      });
    }
  }
  events.sort((left, right) => left.arrivalMs - right.arrivalMs || left.mediaMs - right.mediaMs);
  return { events, injectedAudioLoss };
}

/** 保存した復号出力の到着列を、媒体時刻との差を変えずに再投入する。 */
function recordedEvents(trace, seconds, originMs, epoch) {
  // 相対時刻の公開 fixture は、配信内容や接続先を含まない 3 要素の列として保存する。
  if (Array.isArray(trace))
    trace = trace.map((row) =>
      Array.isArray(row) ? { stream: row[0], timestampMs: row[1], wallClockMs: row[2] } : row,
    );
  if (
    !Array.isArray(trace) ||
    !trace.every(
      (row) =>
        ["audio", "video"].includes(row.stream) &&
        Number.isFinite(row.timestampMs) &&
        Number.isFinite(row.wallClockMs) &&
        row.wallClockMs >= row.timestampMs,
    )
  )
    throw new Error("Invalid recorded arrival trace");
  const starts = {};
  for (const stream of ["audio", "video"]) {
    const timestamps = trace.filter((row) => row.stream === stream).map((row) => row.timestampMs);
    if (timestamps.length === 0)
      throw new Error("Recorded arrival trace must contain audio and video");
    starts[stream] = Math.min(...timestamps);
  }
  const mediaOriginMs = Math.min(starts.audio, starts.video);
  const events = trace
    .filter((row) => row.timestampMs - mediaOriginMs < seconds * 1000)
    .map((row) => {
      const mediaMs = row.timestampMs - mediaOriginMs;
      const frequency = row.stream === "audio" ? 50 : 30;
      return {
        stream: row.stream,
        index: Math.round(((row.timestampMs - starts[row.stream]) * frequency) / 1000),
        mediaMs,
        timestamp: epoch + Math.round(mediaMs * 1000),
        arrivalMs: originMs + row.wallClockMs - mediaOriginMs,
      };
    });
  events.sort((left, right) => left.arrivalMs - right.arrivalMs);
  return { events, injectedAudioLoss: 0 };
}
