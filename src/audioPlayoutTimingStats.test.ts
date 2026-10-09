import { test, assert } from "vite-plus/test";
import {
  AUDIO_PLAYOUT_TIMING_WINDOW_MS,
  AudioPlayoutTimingStats,
  EMPTY_AUDIO_PLAYOUT_TIMING,
  MAX_RECENT_AUDIO_MISSES,
  formatAudioMissEvent,
} from "./audioPlayoutTimingStats";

// 完了条件: 鳴らすと決めた音の、再生予定時刻・到着時刻・鳴り始める時刻と、予定に対する
// 余裕・鳴るまでの時間・予定からの遅れを、直近の値と分布 (p50 / p95 / max) の両方で返す。
// 音声が聞こえないとき、間に合わなかったのかどうかを数値で読むための値である
test("recordPlay: 直近の値と、余裕・鳴るまでの時間・遅れの分布を返す", () => {
  const stats = new AudioPlayoutTimingStats(AUDIO_PLAYOUT_TIMING_WINDOW_MS, 1_000);
  // 余裕 80 ms (予定 180 - 到着 100)、鳴るまで 90 ms、予定から 10 ms 遅れ
  stats.recordPlay(100, 180, 190, 20);
  // 余裕 20 ms、鳴るまで 30 ms、予定から 10 ms 遅れ
  stats.recordPlay(200, 220, 230, 20);
  // 予定を過ぎて届いた音 (余裕 -20 ms)。鳴るまで 10 ms、予定から 30 ms 遅れ
  stats.recordPlay(300, 280, 310, 20);

  const snapshot = stats.snapshot(400);
  assert.equal(snapshot.lastTargetMs, 280, "直近の再生予定時刻を返すこと");
  assert.equal(snapshot.lastArrivalMs, 300, "直近の到着時刻を返すこと");
  assert.equal(snapshot.lastStartMs, 310, "直近に鳴り始める時刻を返すこと");
  assert.equal(snapshot.lastSlackMs, -20, "直近の余裕 (負は間に合っていない) を返すこと");
  assert.equal(snapshot.lastStartDelayMs, 10, "直近の鳴るまでの時間を返すこと");
  assert.equal(snapshot.lastLatenessMs, 30, "直近の予定からの遅れを返すこと");
  // 昇順に並べて nearest-rank 法で求める (3 件なら p50 は 2 番目、p95 と max は 3 番目)
  assert.deepEqual(snapshot.slackMs, { p50: 20, p95: 80, max: 80 });
  assert.deepEqual(snapshot.startDelayMs, { p50: 30, p95: 90, max: 90 });
  assert.deepEqual(snapshot.latenessMs, { p50: 10, p95: 30, max: 30 });
  assert.equal(snapshot.playedFrames, 3, "鳴らすと決めた音の数を数えること");
  assert.equal(snapshot.playedMs, 60, "鳴らすと決めた音の長さを足すこと");
  assert.equal(snapshot.unplannedFrames, 0);
  assert.equal(snapshot.missedFrames, 0);
  assert.equal(snapshot.missedMs, 0);
});

// 完了条件: 再生予定時刻を決められない音 (壁時計の TIMESTAMP を持たない、jitter buffer が
// 無効) は、余裕と遅れを持たないため分布へ入れず、鳴るまでの時間だけを数える
test("recordPlay: 予定を持たない音は余裕を持たず、unplannedFrames に数える", () => {
  const stats = new AudioPlayoutTimingStats(AUDIO_PLAYOUT_TIMING_WINDOW_MS, 0);
  stats.recordPlay(100, null, 110, 20);

  const snapshot = stats.snapshot(200);
  assert.isNull(snapshot.lastTargetMs);
  assert.isNull(snapshot.lastSlackMs, "予定が無ければ余裕は null であること");
  assert.isNull(snapshot.lastLatenessMs, "予定が無ければ遅れは null であること");
  assert.deepEqual(snapshot.startDelayMs, { p50: 10, p95: 10, max: 10 });
  assert.isNull(snapshot.slackMs, "予定を持たない音を分布へ入れないこと");
  assert.isNull(snapshot.latenessMs);
  assert.equal(snapshot.unplannedFrames, 1);
  assert.equal(snapshot.playedFrames, 1);
  assert.equal(snapshot.playedMs, 20);
});

// 完了条件: 鳴らさなかった音を理由ごとに数え、長さも足す。理由ごとの和は合計に一致し、
// 直近の一覧には新しい順ではなく古い順 (追加順) で残る
test("recordMiss: 理由ごとの件数と長さを数え、直近の一覧に残す", () => {
  const stats = new AudioPlayoutTimingStats(AUDIO_PLAYOUT_TIMING_WINDOW_MS, 1_000);
  stats.recordMiss({
    atMs: 100,
    reason: "backlog",
    durationMs: 20,
    targetMs: 500,
    arrivalMs: 100,
  });
  // 予定も到着も分からない (追いつきの途中の音)
  stats.recordMiss({
    atMs: 200,
    reason: "catchUp",
    durationMs: 20,
    targetMs: null,
    arrivalMs: null,
  });

  const snapshot = stats.snapshot(300);
  assert.equal(snapshot.missedFrames, 2, "鳴らさなかった音の数を数えること");
  assert.equal(snapshot.missedMs, 40, "鳴らさなかった音の長さを足すこと");
  assert.deepEqual(snapshot.missedByReason.backlog, { count: 1, ms: 20 });
  assert.deepEqual(snapshot.missedByReason.catchUp, { count: 1, ms: 20 });
  assert.deepEqual(snapshot.missedByReason.lateness, { count: 0, ms: 0 });
  assert.deepEqual(snapshot.missedByReason.error, { count: 0, ms: 0 });
  assert.deepEqual(snapshot.missedByReason.stopped, { count: 0, ms: 0 });
  assert.equal(snapshot.recentMisses.length, 2);
  assert.equal(snapshot.recentMisses[0]?.wallClockMs, 1_100, "記録の時刻を壁時計へ換算すること");
  assert.equal(snapshot.recentMisses[0]?.reason, "backlog");
  assert.equal(snapshot.recentMisses[0]?.durationMs, 20);
  assert.equal(snapshot.recentMisses[0]?.slackMs, 400, "捨てた時点の余裕を残すこと");
  assert.isNull(snapshot.recentMisses[1]?.slackMs, "予定が無ければ余裕は null であること");
});

// 完了条件: 直近の一覧は上限 (30 件) を超えたら古い方から捨てる。累積の数は捨てない
test("recordMiss: 直近の一覧は上限を超えたら古い方から捨てる", () => {
  const stats = new AudioPlayoutTimingStats(AUDIO_PLAYOUT_TIMING_WINDOW_MS, 0);
  for (let index = 0; index < MAX_RECENT_AUDIO_MISSES + 5; index++) {
    stats.recordMiss({
      atMs: index,
      reason: "lateness",
      durationMs: 20,
      targetMs: null,
      arrivalMs: null,
    });
  }
  const snapshot = stats.snapshot(100);
  assert.equal(snapshot.recentMisses.length, MAX_RECENT_AUDIO_MISSES);
  // 最初の 5 件は捨てられ、6 件目の時刻から残る
  assert.equal(snapshot.recentMisses[0]?.wallClockMs, 5);
  assert.equal(snapshot.missedFrames, MAX_RECENT_AUDIO_MISSES + 5, "累積の数は捨てないこと");
  assert.equal(snapshot.missedMs, (MAX_RECENT_AUDIO_MISSES + 5) * 20);
});

// 完了条件: 鳴り終わった音は数えず、まだ鳴り始めていない音だけを「鳴らさずに止めた」として
// 長さ付きで数える。AudioContext を閉じたときに切り捨てられる分である
test("recordStopped: 鳴り終わった音は数えず、まだ鳴っていない音を長さ付きで数える", () => {
  const stats = new AudioPlayoutTimingStats(AUDIO_PLAYOUT_TIMING_WINDOW_MS, 0);
  // 100 から 120 まで鳴る音 (止めたときには鳴り終わっている) と、200 から 220 まで鳴る音
  stats.recordPlay(0, null, 100, 20);
  stats.recordPlay(0, null, 200, 20);
  // 130 で止める。既に鳴り終わった 1 つ目は数えず、2 つ目は 20 ms すべてが鳴らなかった
  stats.recordStopped(130);

  const snapshot = stats.snapshot(200);
  assert.equal(snapshot.missedFrames, 1, "鳴り終わった音を数えないこと");
  assert.equal(snapshot.missedMs, 20);
  assert.deepEqual(snapshot.missedByReason.stopped, { count: 1, ms: 20 });
  // 一覧を消した後の停止では数えない (二重に数えないこと)
  stats.recordStopped(300);
  assert.equal(stats.snapshot(300).missedFrames, 1);
});

// 完了条件: 鳴り始めている音は、止めた時点からの残りだけを数える。既に聞こえた分は
// 鳴らなかったとはみなさない
test("recordStopped: 鳴り始めている音は残りの長さだけを数える", () => {
  const stats = new AudioPlayoutTimingStats(AUDIO_PLAYOUT_TIMING_WINDOW_MS, 0);
  stats.recordPlay(0, null, 250, 20);
  stats.recordStopped(260);
  assert.equal(stats.snapshot(300).missedMs, 10, "残りの 10 ms だけを数えること");
});

// 完了条件: 分布は直近の窓 (既定 10 秒) の値から求める。窓より古い記録は分布から落ちるが、
// 累積の数と直近の値は残る
test("snapshot: 窓より古い記録は分布から落ち、累積は残る", () => {
  const stats = new AudioPlayoutTimingStats(1_000, 0);
  stats.recordPlay(0, 10, 20, 20);
  stats.recordPlay(500, 510, 520, 20);
  const snapshot = stats.snapshot(2_000);
  assert.isNull(snapshot.slackMs, "窓の外の値だけになれば null になること");
  assert.isNull(snapshot.startDelayMs);
  assert.equal(snapshot.playedFrames, 2);
  assert.equal(snapshot.lastTargetMs, 510, "直近の値は窓に関係なく残ること");
});

// 完了条件: reset で、すべての記録を捨てて初期状態へ戻す。購読をやり直すときに使う
test("reset: すべての記録を捨てて初期状態へ戻す", () => {
  const stats = new AudioPlayoutTimingStats(AUDIO_PLAYOUT_TIMING_WINDOW_MS, 0);
  stats.recordPlay(0, 10, 20, 20);
  stats.recordMiss({
    atMs: 30,
    reason: "error",
    durationMs: 20,
    targetMs: 10,
    arrivalMs: 0,
  });
  stats.recordStopped(40);
  stats.reset();
  assert.deepEqual(stats.snapshot(100), EMPTY_AUDIO_PLAYOUT_TIMING);
});

// 完了条件: 鳴らさなかった 1 件を、UTC の ISO 8601 (ミリ秒まで)・理由・長さ・余裕の
// 1 行にする。映像の止まりの一覧と同じ形にして、relay のログと突き合わせられるようにする
test("formatAudioMissEvent: UTC の時刻と理由と長さを 1 行にする", () => {
  assert.equal(
    formatAudioMissEvent({
      wallClockMs: 0,
      reason: "lateness",
      durationMs: 20.4,
      slackMs: -12.6,
    }),
    "1970-01-01T00:00:00.000Z lateness 20 ms slack=-13 ms",
  );
  // 予定が無いときは余裕を "-" にする
  assert.equal(
    formatAudioMissEvent({
      wallClockMs: 1_000,
      reason: "catchUp",
      durationMs: 20,
      slackMs: null,
    }),
    "1970-01-01T00:00:01.000Z catchUp 20 ms slack=-",
  );
});
