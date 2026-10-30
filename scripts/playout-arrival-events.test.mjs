/** 保存した到着時刻を、時計の原点だけ変えて実再生へ投入する。 */
import { test, assert } from "vite-plus/test";
import { createArrivalEvents } from "./playout-arrival-events.mjs";

test("記録した媒体時刻と到着の差、欠落とトラック間の差を保つ", () => {
  const arrivals = [
    { stream: "video", timestampMs: 10000, wallClockMs: 10040 },
    { stream: "audio", timestampMs: 10010, wallClockMs: 10060 },
    { stream: "audio", timestampMs: 10030, wallClockMs: 10230 },
    { stream: "video", timestampMs: 10066, wallClockMs: 10306 },
    // 元の音声の 1 フレーム分が存在しない場合も、投入するフレーム番号を詰めない。
    { stream: "audio", timestampMs: 10070, wallClockMs: 10310 },
  ];
  const { events } = createArrivalEvents("recorded", 10, 500, 20000000, arrivals);
  assert.deepEqual(
    events.map((row) => row.mediaMs),
    [0, 10, 30, 66, 70],
  );
  assert.deepEqual(
    events.map((row) => row.arrivalMs),
    [540, 560, 730, 806, 810],
  );
  assert.deepEqual(
    events.filter((row) => row.stream === "audio").map((row) => row.index),
    [0, 1, 3],
  );
  assert.deepEqual(
    events.map((row) => row.timestamp),
    [20000000, 20010000, 20030000, 20066000, 20070000],
  );
  // 公開用に媒体時刻を相対化した短い記録も、同じ到着列として再投入する。
  const triples = arrivals.map((row) => [row.stream, row.timestampMs, row.wallClockMs]);
  assert.deepEqual(createArrivalEvents("recorded", 10, 500, 20000000, triples).events, events);
});

test("不完全な記録や、未来の媒体時刻より早く届いた記録を無効にする", () => {
  for (const arrivals of [
    [],
    [{ stream: "audio", timestampMs: 10000, wallClockMs: 10040 }],
    [
      { stream: "audio", timestampMs: 10000, wallClockMs: Number.NaN },
      { stream: "video", timestampMs: 10000, wallClockMs: 10040 },
    ],
    [
      { stream: "audio", timestampMs: 10000, wallClockMs: 9990 },
      { stream: "video", timestampMs: 10000, wallClockMs: 10040 },
    ],
  ])
    assert.throws(() => createArrivalEvents("recorded", 10, 500, 20000000, arrivals));
});
