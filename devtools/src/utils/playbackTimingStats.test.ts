import { test, assert } from "vite-plus/test";
import {
  DISPLAY_STALL_FACTOR,
  EMPTY_PLAYBACK_TIMING,
  MAX_RECENT_STALLS,
  PLAYBACK_TIMING_WINDOW_MS,
  PlaybackTimingStats,
  formatStallCauseTotal,
  formatStallEvent,
  formatTimingSummary,
  summarizeTimings,
  type StallEvent,
} from "./playbackTimingStats";

// 30 fps のフレーム間隔 (マイクロ秒)
const FRAME_MICROS = 33_333;

// ============================================================================
// 分布の要約
// ============================================================================

// 百分位は nearest-rank 法で求める (値を昇順に並べて ceil(p * n) 番目)。
// 1 から 100 の 100 個なら p50 は 50、p95 は 95 になる
test("summarizeTimings: nearest-rank 法で p50 / p95 / max を求める", () => {
  const values = Array.from({ length: 100 }, (_, index) => 100 - index);
  assert.deepEqual(summarizeTimings(values), { p50: 50, p95: 95, max: 100 });
});

test("summarizeTimings: 1 個なら p50 / p95 / max はその値、空なら null", () => {
  assert.deepEqual(summarizeTimings([7]), { p50: 7, p95: 7, max: 7 });
  assert.isNull(summarizeTimings([]));
});

test("formatTimingSummary: p50 / p95 / max を小数 1 桁で並べ、値が無ければ - にする", () => {
  assert.equal(formatTimingSummary({ p50: 1.25, p95: 12, max: 123.456 }), "1.3 / 12.0 / 123.5");
  assert.equal(formatTimingSummary(null), "-");
});

// 原因ごとの累積は回数と、時間を整数の ms に丸めて並べる
test("formatStallCauseTotal: 回数と時間 (ms) を並べる", () => {
  assert.equal(formatStallCauseTotal({ count: 3, ms: 412.6 }), "3 / 413 ms");
});

// 止まりは UTC の時刻、原因、長さ、位置、TIMESTAMP の差を 1 行に並べる。位置の記録が
// 無ければ position=- にする
test("formatStallEvent: 止まりを時刻、原因、長さ、位置、TIMESTAMP の差の 1 行にする", () => {
  const stall = {
    wallClockMs: Date.UTC(2026, 8, 25, 7, 12, 34, 567),
    durationMs: 183.4,
    cause: "arrival" as const,
    groupId: "45",
    objectId: "12",
    mediaStepMs: 33.3,
  };
  assert.equal(
    formatStallEvent(stall),
    "2026-09-25T07:12:34.567Z arrival 183 ms group=45 object=12 step=33 ms",
  );
  assert.equal(
    formatStallEvent({ ...stall, cause: "unknown", groupId: null, objectId: null }),
    "2026-09-25T07:12:34.567Z unknown 183 ms position=- step=33 ms",
  );
});

// ============================================================================
// 到着の揺らぎと遅延
// ============================================================================

// 到着の揺らぎは「到着時刻 - メディア時刻」の窓の中の最小値からの差で求める。
// 送信側と受信側の時計がずれていても、ずれは全ての値に同じだけ乗るため差には残らない
test("recordArrival: 到着の揺らぎは窓の中で最も早く届いたフレームからの遅れになる", () => {
  const stats = new PlaybackTimingStats();
  // 3 フレーム目だけ 40 ms 遅れて届く
  stats.recordArrival(1_000, 0, null);
  stats.recordArrival(1_033.333, FRAME_MICROS, null);
  stats.recordArrival(1_106.666, FRAME_MICROS * 2, null);
  const snapshot = stats.snapshot(1_200);
  assert.isNotNull(snapshot.arrivalJitterMs);
  assert.closeTo(snapshot.arrivalJitterMs?.p50 ?? Number.NaN, 0, 0.01);
  assert.closeTo(snapshot.arrivalJitterMs?.max ?? Number.NaN, 40, 0.01);
});

// 遅延は壁時計 - 送信側の壁時計の TIMESTAMP で求める。TIMESTAMP が壁時計でない
// (Timescale がある) Object では求めない
test("recordArrival: 壁時計の TIMESTAMP のときだけ遅延を求める", () => {
  const stats = new PlaybackTimingStats();
  // 送信側の壁時計 1,790,000,000,000 ms のフレームが 45 ms 後に届く
  stats.recordArrival(500, 1_790_000_000_000_000, 1_790_000_000_045);
  assert.deepEqual(stats.snapshot(600).latencyMs, { p50: 45, p95: 45, max: 45 });

  const mediaTimeOnly = new PlaybackTimingStats();
  mediaTimeOnly.recordArrival(500, 90_000, null);
  assert.isNull(mediaTimeOnly.snapshot(600).latencyMs);
});

// 窓 (既定 10 秒) より前の値は分布に含めない。古い遅れが残ると、いま起きていない
// 揺らぎを出し続けてしまう
test("snapshot: 窓より前に記録した値を分布に含めない", () => {
  const stats = new PlaybackTimingStats();
  // 最初のフレームは 500 ms 遅れて届き、その後は遅れなく届く
  stats.recordArrival(500, 0, 500);
  stats.recordArrival(
    PLAYBACK_TIMING_WINDOW_MS + 1_000,
    PLAYBACK_TIMING_WINDOW_MS * 1_000 + 1_000_000,
    PLAYBACK_TIMING_WINDOW_MS + 1_000,
  );
  const snapshot = stats.snapshot(PLAYBACK_TIMING_WINDOW_MS + 1_000);
  assert.deepEqual(snapshot.latencyMs, { p50: 0, p95: 0, max: 0 });
  assert.deepEqual(snapshot.arrivalJitterMs, { p50: 0, p95: 0, max: 0 });
});

// ============================================================================
// 復号時間
// ============================================================================

// decoder に渡した時刻と出力された時刻を timestamp で対応づける
test("recordDecodeOutput: 同じ timestamp の開始からの経過を復号時間にする", () => {
  const stats = new PlaybackTimingStats();
  stats.recordDecodeStart(100, 0);
  stats.recordDecodeStart(110, FRAME_MICROS);
  // 出力の順は decode の順と異なってよい
  stats.recordDecodeOutput(125, FRAME_MICROS);
  stats.recordDecodeOutput(130, 0);
  assert.deepEqual(stats.snapshot(200).decodeTimeMs, { p50: 15, p95: 30, max: 30 });
});

// 対応する開始が無い出力 (リセット前に渡したフレームなど) は数えない
test("recordDecodeOutput: 開始の記録が無い出力は数えない", () => {
  const stats = new PlaybackTimingStats();
  stats.recordDecodeOutput(130, 0);
  assert.isNull(stats.snapshot(200).decodeTimeMs);
});

// 出力されなかったフレーム (decoder のエラーで捨てられたなど) の開始は窓を過ぎたら
// 捨てる。同じ timestamp の後の出力と誤って対応づけない
test("recordDecodeStart: 窓を過ぎた開始の記録は後の出力と対応づけない", () => {
  const stats = new PlaybackTimingStats();
  stats.recordDecodeStart(0, 0);
  stats.recordDecodeStart(PLAYBACK_TIMING_WINDOW_MS + 1, FRAME_MICROS);
  stats.recordDecodeOutput(PLAYBACK_TIMING_WINDOW_MS + 2, 0);
  assert.isNull(stats.snapshot(PLAYBACK_TIMING_WINDOW_MS + 3).decodeTimeMs);
});

// ============================================================================
// 表示
// ============================================================================

// フレーム間隔 (描いたフレームのメディア時刻の差の中央値) の 1.5 倍を超える表示間隔を
// 止まりとして数え、その表示間隔を合計する
test("recordDisplay: フレーム間隔の 1.5 倍を超えた表示間隔を止まりとして数える", () => {
  const stats = new PlaybackTimingStats();
  const displays = [0, 33.3, 66.7, 100, 200, 233.3];
  displays.forEach((nowMs, index) => {
    stats.recordDisplay(nowMs, index * FRAME_MICROS);
  });
  const snapshot = stats.snapshot(240);
  assert.equal(snapshot.displayStalls, 1);
  assert.closeTo(snapshot.displayStallMs, 100, 0.01);
  assert.equal(DISPLAY_STALL_FACTOR, 1.5);
  assert.closeTo(snapshot.displayIntervalMs?.max ?? Number.NaN, 100, 0.01);
});

// 止まりを数えるとき原因を 1 つ決め、原因ごとの回数と時間に加え、直近の止まりとして残す。
// 25 fps (40 ms 間隔) で Object 0 から 2 を間隔どおりに表示し、Object 3 は表示の時刻
// (1,120 ms) を過ぎた 1,190 ms に届いて 1,200 ms に表示した。経路の遅れである
test("recordDisplay: 止まりの原因を数え、直近の止まりとして残す", () => {
  const timeOriginMs = 1_790_263_445_000;
  const stats = new PlaybackTimingStats(PLAYBACK_TIMING_WINDOW_MS, timeOriginMs);
  const frameMicros = 40_000;
  const receivedAt = [995, 1_035, 1_075, 1_190];
  const displayedAt = [1_000, 1_040, 1_080, 1_200];
  let stall: StallEvent | null = null;
  for (let index = 0; index < 4; index++) {
    const timestampMicros = index * frameMicros;
    const receivedAtMs = receivedAt[index] ?? 0;
    stats.recordObjectReceived(
      { groupId: 7n, objectId: BigInt(index), priorObjectIdGap: 0n },
      0n,
      timestampMicros,
      receivedAtMs,
    );
    stats.recordObjectReleased(timestampMicros, receivedAtMs);
    stats.recordDecodeStart(receivedAtMs, timestampMicros);
    stats.recordDecodeOutput(receivedAtMs + 2, timestampMicros);
    stall = stats.recordDisplay(displayedAt[index] ?? 0, timestampMicros);
    if (index < 3) {
      assert.isNull(stall, `Object ${index} の表示は止まりではないこと`);
    }
  }

  const expected: StallEvent = {
    wallClockMs: timeOriginMs + 1_200,
    durationMs: 120,
    cause: "arrival",
    groupId: "7",
    objectId: "3",
    mediaStepMs: 40,
  };
  assert.deepEqual(stall, expected, "止まりを返すこと");
  const snapshot = stats.snapshot(1_200);
  assert.deepEqual(snapshot.stallCauses.arrival, { count: 1, ms: 120 }, "原因ごとに数えること");
  assert.deepEqual(snapshot.recentStalls, [expected], "直近の止まりに残すこと");
});

// 直近の止まりは MAX_RECENT_STALLS 回だけ古い順に残す (原因ごとの累積は全て数える)
test("recordDisplay: 直近の止まりは上限の回数だけ残す", () => {
  const stats = new PlaybackTimingStats();
  let nowMs = 0;
  let timestampMicros = 0;
  // 間隔どおりの表示 2 回でフレーム間隔を覚え、以降は表示ごとに 100 ms 止まる
  for (let index = 0; index < MAX_RECENT_STALLS + 5 + 3; index++) {
    stats.recordDisplay(nowMs, timestampMicros);
    nowMs += index < 2 ? 33.3 : 100;
    timestampMicros += FRAME_MICROS;
  }
  const snapshot = stats.snapshot(nowMs);
  assert.equal(snapshot.displayStalls, MAX_RECENT_STALLS + 5);
  assert.equal(snapshot.recentStalls.length, MAX_RECENT_STALLS);
  // 記録の無いフレームの止まりは原因を決められない
  assert.equal(snapshot.stallCauses.unknown.count, MAX_RECENT_STALLS + 5);
});

// 受信の欠けと、Group の切り替えの保留が上限で解けた回数を出す
test("snapshot: 受信の欠けと保留の期限切れを出す", () => {
  const stats = new PlaybackTimingStats();
  stats.recordObjectReceived({ groupId: 0n, objectId: 0n, priorObjectIdGap: 0n }, 0n, null, 0);
  stats.recordObjectReceived({ groupId: 0n, objectId: 2n, priorObjectIdGap: 0n }, 0n, null, 0);
  stats.recordObjectReceived({ groupId: 2n, objectId: 0n, priorObjectIdGap: 0n }, 0n, null, 0);
  stats.recordSubgroupEnd(0n, 0n, "reset");
  stats.recordGroupSwitchHoldExpired();

  const snapshot = stats.snapshot(0);
  assert.equal(snapshot.missingObjects, 1);
  assert.equal(snapshot.missingGroups, 1);
  assert.equal(snapshot.subgroupStreamResets, 1);
  assert.equal(snapshot.groupSwitchHoldExpirations, 1);
});

// フレーム間隔がまだ分からない (表示が 2 枚目まで) うちは止まりを判定しない
test("recordDisplay: フレーム間隔が分かる前の表示間隔は止まりにしない", () => {
  const stats = new PlaybackTimingStats();
  stats.recordDisplay(0, 0);
  stats.recordDisplay(500, FRAME_MICROS);
  assert.equal(stats.snapshot(600).displayStalls, 0);
});

// 表示 fps は直近 1 秒に描いたフレーム数である
test("snapshot: 表示 fps は直近 1 秒に描いたフレーム数になる", () => {
  const stats = new PlaybackTimingStats();
  for (let index = 0; index < 90; index++) {
    stats.recordDisplay(index * (1_000 / 30), index * FRAME_MICROS);
  }
  // 最後の表示は 2966.7 ms。直近 1 秒 (1966.7 ms より後) には 30 枚ある
  assert.equal(stats.snapshot(89 * (1_000 / 30)).displayFps, 30);
});

// jitter buffer が表示時刻を過ぎたフレームのうち、最新とその 1 つ前より古いものを捨てた数
// (間に合わなかった数)
test("recordLateDrop: 間に合わずに捨てたフレームを数える", () => {
  const stats = new PlaybackTimingStats();
  stats.recordLateDrop(0, 0);
  stats.recordLateDrop(FRAME_MICROS, 33.3);
  stats.recordLateDrop(FRAME_MICROS * 2, 66.7);
  assert.equal(stats.snapshot(0).lateFramesDropped, 3);
});

// 現在の再生遅延は jitter buffer が決め、統計はその最後の値を出す。
// jitter buffer が働いていない (無効 / 壁時計の TIMESTAMP が無い) ときは null
test("recordPlayoutDelay: 最後に記録した再生遅延を出す", () => {
  const stats = new PlaybackTimingStats();
  assert.isNull(stats.snapshot(0).playoutDelayMs);
  stats.recordPlayoutDelay(40);
  stats.recordPlayoutDelay(55);
  assert.equal(stats.snapshot(0).playoutDelayMs, 55);
  stats.recordPlayoutDelay(null);
  assert.isNull(stats.snapshot(0).playoutDelayMs);
});

test("recordQueueDrop: 表示キューがあふれて捨てたフレームを数える", () => {
  const stats = new PlaybackTimingStats();
  stats.recordQueueDrop(0);
  stats.recordQueueDrop(FRAME_MICROS);
  assert.equal(stats.snapshot(0).displayQueueDrops, 2);
});

// ============================================================================
// リセット
// ============================================================================

// 購読を始め直したときは、前の購読の値を持ち越さない
test("reset: 分布と累積の値を初期状態に戻す", () => {
  const stats = new PlaybackTimingStats();
  stats.recordArrival(0, 0, 10);
  stats.recordDecodeStart(0, 0);
  stats.recordDecodeOutput(5, 0);
  stats.recordDisplay(0, 0);
  stats.recordDisplay(33.3, FRAME_MICROS);
  stats.recordDisplay(66.7, FRAME_MICROS * 2);
  stats.recordDisplay(300, FRAME_MICROS * 3);
  stats.recordQueueDrop(FRAME_MICROS * 4);
  stats.recordLateDrop(FRAME_MICROS * 5, 330);
  stats.recordPlayoutDelay(40);
  stats.recordObjectReceived({ groupId: 0n, objectId: 0n, priorObjectIdGap: 0n }, 0n, 0, 0);
  stats.recordObjectReceived({ groupId: 0n, objectId: 3n, priorObjectIdGap: 0n }, 0n, null, 10);
  stats.recordSubgroupEnd(0n, 0n, "reset");
  stats.recordGroupSwitchHoldExpired();
  stats.reset();
  assert.deepEqual(stats.snapshot(400), EMPTY_PLAYBACK_TIMING);

  // リセットの前に渡したフレームの出力は、リセット後の復号時間に含めない
  stats.recordDecodeOutput(410, FRAME_MICROS);
  assert.isNull(stats.snapshot(420).decodeTimeMs);
});
