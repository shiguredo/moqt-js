import { test, assert } from "vite-plus/test";
import { LATENCY_SEGMENTS, LatencyBreakdown } from "./latencyBreakdown";

// 受信側の performance.timeOrigin (壁時計、Unix epoch ミリ秒)
const TIME_ORIGIN_MS = 1_790_263_445_000;
// 区間の時間を残す窓 (ミリ秒)
const WINDOW_MS = 10_000;

/** 受信側の時刻 atMs (performance.now()) の壁時計を TIMESTAMP (マイクロ秒) にする */
function timestampAt(atMs: number): number {
  return (TIME_ORIGIN_MS + atMs) * 1_000;
}

// 1 枚のフレームの時刻から区間ごとの時間を求める。publisher が読んだ時刻 (TIMESTAMP) は
// 受信側の 950 ms、受け取りは 1,000 ms (到着 50 ms)、保留を出たのは 1,010 ms (保留 10 ms)、
// decoder に渡したのは 1,012 ms (復号待ち 2 ms)、出力は 1,015 ms (復号 3 ms)、描いたのは
// 1,045 ms (表示待ち 30 ms)。表示の遅延は 95 ms で、区間の和と一致する
test("recordDisplayed: 描いたフレームの区間ごとの時間を記録し、和が表示の遅延になる", () => {
  const breakdown = new LatencyBreakdown(WINDOW_MS, TIME_ORIGIN_MS);
  const timestampMicros = timestampAt(950);
  breakdown.recordReceived(timestampMicros, 1_000, true);
  breakdown.recordReleased(timestampMicros, 1_010);
  breakdown.recordDecodeStart(timestampMicros, 1_012);
  breakdown.recordDecodeOutput(timestampMicros, 1_015);
  breakdown.recordDisplayed(timestampMicros, 1_045);

  const values = breakdown.current(1_045);
  assert.deepEqual(values, {
    arrival: [50],
    hold: [10],
    decodeWait: [2],
    decode: [3],
    displayWait: [30],
    displayLatency: [95],
  });
});

// TIMESTAMP が壁時計でないフレーム (Timescale あり) は、TIMESTAMP を使う区間 (到着と
// 表示の遅延) を求めない。受信側の時刻だけで求まる区間は記録する
test("recordDisplayed: 壁時計でないフレームは到着と表示の遅延を求めない", () => {
  const breakdown = new LatencyBreakdown(WINDOW_MS, TIME_ORIGIN_MS);
  breakdown.recordReceived(90_000, 1_000, false);
  breakdown.recordReleased(90_000, 1_000);
  breakdown.recordDecodeStart(90_000, 1_001);
  breakdown.recordDecodeOutput(90_000, 1_004);
  breakdown.recordDisplayed(90_000, 1_020);

  const values = breakdown.current(1_020);
  assert.deepEqual(values.arrival, []);
  assert.deepEqual(values.displayLatency, []);
  assert.deepEqual(values.hold, [0]);
  assert.deepEqual(values.decodeWait, [1]);
  assert.deepEqual(values.decode, [3]);
  assert.deepEqual(values.displayWait, [16]);
});

// 時刻が揃っていないフレーム (保留を出た記録が無い、受け取りの記録が無い) は加えない。
// 加えると区間の和が表示の遅延と一致しなくなる
test("recordDisplayed: 時刻が揃っていないフレームは加えない", () => {
  const breakdown = new LatencyBreakdown(WINDOW_MS, TIME_ORIGIN_MS);
  // 保留を出た記録が無い
  const first = timestampAt(900);
  breakdown.recordReceived(first, 1_000, true);
  breakdown.recordDecodeStart(first, 1_002);
  breakdown.recordDecodeOutput(first, 1_005);
  breakdown.recordDisplayed(first, 1_030);
  // 受け取りの記録が無い
  const second = timestampAt(933);
  breakdown.recordReleased(second, 1_033);
  breakdown.recordDecodeStart(second, 1_034);
  breakdown.recordDecodeOutput(second, 1_036);
  breakdown.recordDisplayed(second, 1_063);

  const values = breakdown.current(1_063);
  for (const segment of LATENCY_SEGMENTS) {
    assert.deepEqual(values[segment], [], `${segment} に加えないこと`);
  }
});

// 描かなかったフレームの時刻は窓を過ぎたら捨てる。窓を過ぎてから描いても加えない
test("recordReceived: 窓より前に受け取ったフレームの時刻を捨てる", () => {
  const breakdown = new LatencyBreakdown(WINDOW_MS, TIME_ORIGIN_MS);
  const old = timestampAt(0);
  breakdown.recordReceived(old, 10, true);
  breakdown.recordReleased(old, 10);
  breakdown.recordDecodeStart(old, 11);
  breakdown.recordDecodeOutput(old, 12);
  // 窓を過ぎた後に別のフレームを受け取ると、古いフレームの時刻を捨てる
  breakdown.recordReceived(timestampAt(WINDOW_MS + 100), WINDOW_MS + 150, true);
  breakdown.recordDisplayed(old, WINDOW_MS + 160);

  assert.deepEqual(breakdown.current(WINDOW_MS + 160).displayLatency, []);
});

// 区間の時間は直近の窓の分だけを返す
test("current: 窓より前に描いたフレームの時間を返さない", () => {
  const breakdown = new LatencyBreakdown(WINDOW_MS, TIME_ORIGIN_MS);
  for (const atMs of [1_000, 12_000]) {
    const timestampMicros = timestampAt(atMs - 50);
    breakdown.recordReceived(timestampMicros, atMs, true);
    breakdown.recordReleased(timestampMicros, atMs);
    breakdown.recordDecodeStart(timestampMicros, atMs);
    breakdown.recordDecodeOutput(timestampMicros, atMs + 2);
    breakdown.recordDisplayed(timestampMicros, atMs + 20);
  }
  assert.deepEqual(breakdown.current(12_020).displayLatency, [70]);
});

// 購読を始め直したときは、前の購読の記録を持ち越さない
test("reset: 記録をすべて捨てる", () => {
  const breakdown = new LatencyBreakdown(WINDOW_MS, TIME_ORIGIN_MS);
  const timestampMicros = timestampAt(950);
  breakdown.recordReceived(timestampMicros, 1_000, true);
  breakdown.recordReleased(timestampMicros, 1_000);
  breakdown.recordDecodeStart(timestampMicros, 1_000);
  breakdown.recordDecodeOutput(timestampMicros, 1_003);
  breakdown.recordDisplayed(timestampMicros, 1_020);
  const pending = timestampAt(983);
  breakdown.recordReceived(pending, 1_033, true);
  breakdown.reset();

  // リセットの前に受け取ったフレームを描いても加えない
  breakdown.recordReleased(pending, 1_033);
  breakdown.recordDecodeStart(pending, 1_034);
  breakdown.recordDecodeOutput(pending, 1_036);
  breakdown.recordDisplayed(pending, 1_053);
  const values = breakdown.current(1_053);
  for (const segment of LATENCY_SEGMENTS) {
    assert.deepEqual(values[segment], [], `${segment} を捨てること`);
  }
});
