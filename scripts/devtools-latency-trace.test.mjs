/** 起動時の遅れを除外せず、実出力の記録を集計できることを確かめる。 */
import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { summarizeTimingTrace } from "./devtools-latency-trace.mjs";

test("起動と定常の境界で標本を落としたり二重に数えたりしない", () => {
  // 分布は実測記録と同じ形式の数値列であり、音声出力 API の代用品は使わない。
  fc.assert(
    fc.property(fc.array(fc.integer({ min: 0, max: 10000 }), { minLength: 1 }), (times) => {
      const presentations = times.map((time) => ({
        stream: "audio",
        atMs: 100 + time,
        timestampMs: time,
        presentedMs: time + 80,
        delayMs: 80,
      }));
      const summary = summarizeTimingTrace({ presentations, arrivals: [], startedMs: 0 });
      assert.equal(summary.audio.whole.count, times.length);
      assert.equal(summary.audio.startup.count + summary.audio.steady.count, times.length);
    }),
  );
  const presentations = [0, 2999, 3000].map((time) => ({
    stream: "audio",
    atMs: time,
    timestampMs: time,
    presentedMs: time + 80,
    delayMs: 80,
  }));
  const summary = summarizeTimingTrace({ presentations, arrivals: [], startedMs: 0 });
  assert.equal(summary.audio.startup.count, 2);
  assert.equal(summary.audio.steady.count, 1);
});

test("無い記録や非有限の時刻を良好な分布として採用しない", () => {
  assert.isFalse(summarizeTimingTrace({ presentations: [], arrivals: [], startedMs: 0 }).valid);
  const record = {
    stream: "audio",
    atMs: 0,
    timestampMs: 0,
    presentedMs: 80,
    delayMs: 80,
  };
  for (const field of ["atMs", "timestampMs", "presentedMs", "delayMs"])
    assert.isFalse(
      summarizeTimingTrace({
        presentations: [{ ...record, [field]: Number.NaN }],
        arrivals: [],
        startedMs: 0,
      }).valid,
    );
});

test("音声と映像の媒体時刻の差を補正して同じ媒体時刻の同期を比較する", () => {
  // 音声は 20 ms、映像は 33 ms 間隔でも、表示の差は一定の 5 ms とする。
  const audio = Array.from({ length: 250 }, (_, index) => ({
    stream: "audio",
    atMs: index * 20,
    timestampMs: index * 20,
    presentedMs: index * 20 + 80,
    delayMs: 80,
  }));
  const video = Array.from({ length: 150 }, (_, index) => ({
    stream: "video",
    atMs: index * 33,
    timestampMs: index * 33,
    presentedMs: index * 33 + 85,
    delayMs: 85,
  }));
  const summary = summarizeTimingTrace({
    presentations: [...audio, ...video],
    arrivals: [],
    startedMs: 0,
  });
  assert.isTrue(summary.valid);
  assert.equal(summary.skew.whole.count, video.length);
  assert.equal(summary.skew.whole.p95, 5);
  assert.equal(summary.absoluteSkew.whole.p95, 5);
  assert.equal(summary.audio.whole.over200, 0);
  // 映像が音声より先に出る負のずれも、絶対値では同じ大きさとして検査する。
  for (const frame of video) frame.delayMs = 75;
  const leading = summarizeTimingTrace({
    presentations: [...audio, ...video],
    arrivals: [],
    startedMs: 0,
  });
  assert.equal(leading.skew.whole.p95, -5);
  assert.equal(leading.absoluteSkew.whole.p95, 5);
});

test("未来の音声予約も出力時刻で区切り、観測時刻と初回出力を区別する", () => {
  const trace = {
    startedMs: 0,
    stoppedMs: 5000,
    timeOriginMs: 100000,
    arrivals: [],
    presentations: [
      { stream: "audio", atMs: 50, timestampMs: 100000, presentedMs: 100100, delayMs: 100 },
      { stream: "video", atMs: 100, timestampMs: 100000, presentedMs: 100100, delayMs: 100 },
      { stream: "audio", atMs: 2900, timestampMs: 102880, presentedMs: 103200, delayMs: 320 },
      { stream: "video", atMs: 3200, timestampMs: 102880, presentedMs: 103200, delayMs: 320 },
      // 停止後が出力時刻になる予約は、まだ鳴った標本として扱わない。
      { stream: "audio", atMs: 4900, timestampMs: 104880, presentedMs: 105100, delayMs: 220 },
    ],
  };
  const summary = summarizeTimingTrace(trace);
  assert.isTrue(summary.valid);
  assert.equal(summary.firstObservationAfterSubscribeMs, 50);
  assert.equal(summary.firstOutputAfterSubscribeMs, 100);
  assert.equal(summary.pendingAudioReservations, 1);
  assert.equal(summary.audio.whole.count, 2);
  assert.equal(summary.audio.startup.count, 1);
  assert.equal(summary.audio.steady.count, 1);
  assert.equal(summary.video.startup.count, 1);
  assert.equal(summary.absoluteSkew.steady.count, 1);
});
