import { test, assert } from "vite-plus/test";
import {
  DISPLAY_STALL_FACTOR,
  EMPTY_PLAYBACK_TIMING,
  PLAYBACK_TIMING_WINDOW_MS,
  PlaybackTimingStats,
  formatTimingSummary,
  summarizeTimings,
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

// jitter buffer が表示時刻を過ぎたフレームのうち最新以外を捨てた数 (間に合わなかった数)
test("recordLateDrop: 間に合わずに捨てたフレームを数える", () => {
  const stats = new PlaybackTimingStats();
  stats.recordLateDrop();
  stats.recordLateDrop();
  stats.recordLateDrop();
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
  stats.recordQueueDrop();
  stats.recordQueueDrop();
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
  stats.recordQueueDrop();
  stats.recordLateDrop();
  stats.recordPlayoutDelay(40);
  stats.reset();
  assert.deepEqual(stats.snapshot(400), EMPTY_PLAYBACK_TIMING);

  // リセットの前に渡したフレームの出力は、リセット後の復号時間に含めない
  stats.recordDecodeOutput(410, FRAME_MICROS);
  assert.isNull(stats.snapshot(420).decodeTimeMs);
});
