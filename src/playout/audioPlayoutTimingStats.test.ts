import { test, assert } from "vite-plus/test";
import {
  AUDIO_PLAYOUT_BOUNDARY_STEP_THRESHOLD,
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
  stats.recordPlay(100, 180, 190, 20, "timestamp");
  // 余裕 20 ms、鳴るまで 30 ms、予定から 10 ms 遅れ
  stats.recordPlay(200, 220, 230, 20, "timestamp");
  // 予定を過ぎて届いた音 (余裕 -20 ms)。鳴るまで 10 ms、予定から 30 ms 遅れ
  stats.recordPlay(300, 280, 310, 20, "timestamp");

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
  assert.equal(snapshot.arrivalPlannedFrames, 0, "時間軸の予定で鳴らした音を数えないこと");
  assert.equal(snapshot.unplannedFrames, 0);
  assert.equal(snapshot.missedFrames, 0);
  assert.equal(snapshot.missedMs, 0);
});

// 完了条件: 到着基準の計画で鳴らした音 (壁時計の TIMESTAMP を持たない、jitter buffer が
// 無効、トラックの基準が共有されていない) は、余裕と遅れを持たないため分布へ入れず、
// arrivalPlannedFrames に数える。計画には載っているため unplannedFrames には数えない
test("recordPlay: 到着基準で鳴らした音は arrivalPlannedFrames に数える", () => {
  const stats = new AudioPlayoutTimingStats(AUDIO_PLAYOUT_TIMING_WINDOW_MS, 0);
  stats.recordPlay(100, null, 110, 20, "arrival");

  const snapshot = stats.snapshot(200);
  assert.isNull(snapshot.lastTargetMs);
  assert.isNull(snapshot.lastSlackMs, "予定が無ければ余裕は null であること");
  assert.isNull(snapshot.lastLatenessMs, "予定が無ければ遅れは null であること");
  assert.deepEqual(snapshot.startDelayMs, { p50: 10, p95: 10, max: 10 });
  assert.isNull(snapshot.slackMs, "到着基準の計画の音を分布へ入れないこと");
  assert.isNull(snapshot.latenessMs);
  assert.equal(snapshot.arrivalPlannedFrames, 1);
  assert.equal(snapshot.unplannedFrames, 0, "計画に載っているため数えないこと");
  assert.equal(snapshot.playedFrames, 1);
  assert.equal(snapshot.playedMs, 20);
});

// 完了条件: 到着基準の計画も持たないまま鳴らした音は unplannedFrames に数える。どちらの
// 計画も渡さなかった呼び出し側の取りこぼしであり、通常は 0 になる
test("recordPlay: 計画を持たない音は unplannedFrames に数える", () => {
  const stats = new AudioPlayoutTimingStats(AUDIO_PLAYOUT_TIMING_WINDOW_MS, 0);
  stats.recordPlay(100, null, 110, 20, "timestamp");

  const snapshot = stats.snapshot(200);
  assert.equal(snapshot.arrivalPlannedFrames, 0);
  assert.equal(snapshot.unplannedFrames, 1);
  assert.equal(snapshot.playedFrames, 1);
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
      reason: "backlog",
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
  stats.recordPlay(0, null, 100, 20, "arrival");
  stats.recordPlay(0, null, 200, 20, "arrival");
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
  stats.recordPlay(0, null, 250, 20, "arrival");
  stats.recordStopped(260);
  assert.equal(stats.snapshot(300).missedMs, 10, "残りの 10 ms だけを数えること");
});

// 完了条件: 分布は直近の窓 (既定 10 秒) の値から求める。窓より古い記録は分布から落ちるが、
// 累積の数と直近の値は残る
test("snapshot: 窓より古い記録は分布から落ち、累積は残る", () => {
  const stats = new AudioPlayoutTimingStats(1_000, 0);
  stats.recordPlay(0, 10, 20, 20, "timestamp");
  stats.recordPlay(500, 510, 520, 20, "timestamp");
  const snapshot = stats.snapshot(2_000);
  assert.isNull(snapshot.slackMs, "窓の外の値だけになれば null になること");
  assert.isNull(snapshot.startDelayMs);
  assert.equal(snapshot.playedFrames, 2);
  assert.equal(snapshot.lastTargetMs, 510, "直近の値は窓に関係なく残ること");
});

// 完了条件: 目標遅延を閉ループで決めるための観測は、表示用の 10 秒の窓ではなく短い窓
// (既定 1 秒) の分布を返す。目標を増やした結果が 10 秒の窓へ現れるまでには数秒かかるため、
// 制御には短い窓を使う。捨てた量は累積のまま返し、差を取るのは使う側の仕事にする
test("audioDelayFeedback: 短い窓の分布と、累積の捨てた量を返す", () => {
  const stats = new AudioPlayoutTimingStats(AUDIO_PLAYOUT_TIMING_WINDOW_MS, 0);
  // 窓 (1 秒) より古い音。余裕 100 / 鳴るまで 110 / 遅れ 10。分布へ入れない
  stats.recordPlay(1_000, 1_100, 1_110, 20, "timestamp");
  // 直近 (時刻 5,000〜6,000) の音。余裕 30 / 鳴るまで 40 / 遅れ 10
  stats.recordPlay(5_100, 5_130, 5_140, 20, "timestamp");
  // 余裕 10 / 鳴るまで 20 / 遅れ 10
  stats.recordPlay(5_500, 5_510, 5_520, 20, "timestamp");
  stats.recordMiss({
    atMs: 5_600,
    reason: "backlog",
    durationMs: 20,
    targetMs: 5_700,
    arrivalMs: 5_500,
  });

  const feedback = stats.audioDelayFeedback(6_000);
  assert.equal(feedback.atMs, 6_000, "観測した時刻を返すこと");
  assert.deepEqual(feedback.latenessMs, { p50: 10, p95: 10, max: 10 }, "短い窓の遅れを返すこと");
  assert.deepEqual(feedback.startDelayMs, { p50: 20, p95: 40, max: 40 });
  assert.deepEqual(feedback.slackMs, { p50: 10, p95: 30, max: 30 });
  assert.equal(feedback.backlogMisses, 1, "累積の捨てた数を返すこと");
  assert.equal(feedback.backlogMs, 20, "累積の捨てた長さを返すこと");

  // 表示用の窓 (10 秒) より外に出れば null になる
  const later = stats.audioDelayFeedback(20_000);
  assert.isNull(later.latenessMs, "窓の外の値だけになれば null になること");
  assert.equal(later.backlogMisses, 1, "累積は窓に関係なく残ること");
});

// 完了条件: reset で、すべての記録を捨てて初期状態へ戻す。購読をやり直すときに使う
test("reset: すべての記録を捨てて初期状態へ戻す", () => {
  const stats = new AudioPlayoutTimingStats(AUDIO_PLAYOUT_TIMING_WINDOW_MS, 0);
  stats.recordPlay(0, 10, 20, 20, "timestamp");
  stats.recordMiss({
    atMs: 30,
    reason: "error",
    durationMs: 20,
    targetMs: 10,
    arrivalMs: 0,
  });
  stats.recordStopped(40);
  // 穴・予約の追い越し・境界の段差も reset で消えること (記録していないと、
  // 消し忘れても 0 のままで通ってしまう)
  stats.recordGap({ uncoveredMs: 5, unrecoverableMs: 2 });
  stats.recordLateStart(3);
  stats.recordBoundaryStep(0.2);
  stats.reset();
  assert.deepEqual(stats.snapshot(100), EMPTY_AUDIO_PLAYOUT_TIMING);
});

// 完了条件: 前の音の終わりへ揃えるスナップで予定より最大 0.5 ms 早く鳴っても、
// 遅れは負にしない (playout 側の遅れと同じ丸めにする)
test("recordPlay: 予定より早く鳴った音の遅れを 0 にする", () => {
  const stats = new AudioPlayoutTimingStats(AUDIO_PLAYOUT_TIMING_WINDOW_MS, 0);
  stats.recordPlay(0, 100, 99.6, 20, "timestamp");
  const snapshot = stats.snapshot(0);
  assert.equal(snapshot.lastLatenessMs, 0, "遅れを負にしないこと");
  assert.equal(snapshot.latenessMs?.max, 0, "分布にも負の値を入れないこと");
});

// 完了条件: 鳴らさなかった 1 件を、UTC の ISO 8601 (ミリ秒まで)・理由・長さ・余裕の
// 1 行にする。映像の止まりの一覧と同じ形にして、relay のログと突き合わせられるようにする
test("formatAudioMissEvent: UTC の時刻と理由と長さを 1 行にする", () => {
  assert.equal(
    formatAudioMissEvent({
      wallClockMs: 0,
      reason: "backlog",
      durationMs: 20.4,
      slackMs: -12.6,
    }),
    "1970-01-01T00:00:00.000Z backlog 20 ms slack=-13 ms",
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

// 完了条件: 補間で埋まらなかった無音の穴・予約の追い越し・バッファ境界の段差を累積で数える。
// しきい値以下の段差は回数に数えず最大だけ残す
test("recordGap / recordLateStart / recordBoundaryStep: 穴と追い越しと段差を数える", () => {
  const stats = new AudioPlayoutTimingStats(AUDIO_PLAYOUT_TIMING_WINDOW_MS, 0);
  stats.recordGap({ uncoveredMs: 20, unrecoverableMs: 20 });
  stats.recordGap({ uncoveredMs: 8, unrecoverableMs: 0 });
  stats.recordGap({ uncoveredMs: 0, unrecoverableMs: 0 });
  // 予約できなかった長さが穴の長さを超えても、穴の長さまでに切り詰める
  stats.recordGap({ uncoveredMs: 4, unrecoverableMs: 10 });
  // 非有限・負値は記録しない (NaN が集計へ入ると閉ループの目標まで NaN になる)
  stats.recordGap({ uncoveredMs: Number.NaN, unrecoverableMs: 0 });
  stats.recordGap({ uncoveredMs: -1, unrecoverableMs: 0 });
  stats.recordLateStart(2);
  stats.recordLateStart(0.5);
  stats.recordLateStart(0);
  stats.recordLateStart(Number.NaN);
  stats.recordBoundaryStep(0.2);
  stats.recordBoundaryStep(0.04);
  // しきい値ちょうどは「超えた」ではないため数えない
  stats.recordBoundaryStep(AUDIO_PLAYOUT_BOUNDARY_STEP_THRESHOLD);
  stats.recordBoundaryStep(Number.NaN);
  // 負の段差は絶対値を取る
  stats.recordBoundaryStep(-0.3);
  const snapshot = stats.snapshot(0);
  assert.equal(snapshot.gapCount, 3, "無音の穴を数えること");
  assert.equal(snapshot.gapMs, 32, "穴の合計を数えること");
  assert.equal(snapshot.gapMaxMs, 20, "穴の最大を数えること");
  assert.equal(snapshot.unrecoverableGapCount, 2, "予約できない穴を数えること");
  assert.equal(snapshot.unrecoverableGapMs, 24, "予約できない長さを数えること");
  assert.equal(snapshot.lateStartCount, 2, "追い越した回数を数えること");
  assert.equal(snapshot.lateStartMaxMs, 2, "追い越した最大を残すこと");
  assert.equal(snapshot.boundaryStepCount, 2, "しきい値を超えた段差だけ数えること");
  assert.closeTo(snapshot.boundaryStepMax, 0.3, 1e-9, "段差の最大は残すこと");
  // 目標遅延の閉ループへ穴の累積を渡す
  const feedback = stats.audioDelayFeedback(0);
  assert.equal(feedback.gapCount, 3);
  assert.equal(feedback.gapMs, 32);
});

/**
 * 完了条件: 停止時の drain が、予約済みの最後の終わり (pendingEndMs) と残りの長さ
 * (pendingMs) を読めること。時刻を過ぎた予約は数えない。
 */
test("pendingEndMs / pendingMs: 鳴り終わっていない予約の最後と残りを返す", (): void => {
  const stats = new AudioPlayoutTimingStats(AUDIO_PLAYOUT_TIMING_WINDOW_MS, 0);
  assert.isNull(stats.pendingEndMs(0), "予約が無ければ null");
  assert.equal(stats.pendingMs(0), 0);

  // [100, 120] と [140, 160] の 2 つを予約する (時刻は performance.now 軸のミリ秒)
  stats.recordPlay(0, 100, 100, 20, "timestamp");
  stats.recordPlay(0, 140, 140, 20, "timestamp");

  assert.equal(stats.pendingEndMs(0), 160, "最後に鳴り終わる時刻を返すこと");
  assert.equal(stats.pendingMs(0), 40, "残りの合計を返すこと");
  // 1 つ目の途中では、1 つ目の残りと 2 つ目を含める
  assert.equal(stats.pendingEndMs(110), 160);
  assert.equal(stats.pendingMs(110), 30);
  // すべて鳴り終わった後は何も残らない
  assert.isNull(stats.pendingEndMs(200));
  assert.equal(stats.pendingMs(200), 0);
});

/**
 * 完了条件: drain の結果 (鳴らせた量・切った量・待ち時間・flush 件数) を計器に残す。
 * `missedByReason.stopped` の意味 (切った量) は変えない。
 */
test("recordDrain: drain の結果を lastDrain に残す", (): void => {
  const stats = new AudioPlayoutTimingStats(AUDIO_PLAYOUT_TIMING_WINDOW_MS, 0);
  stats.recordPlay(0, 100, 100, 20, "timestamp");
  // drain の間に 1 つ鳴らせた (予約を追加した) ことにする
  stats.recordPlay(10, 120, 120, 20, "timestamp");
  const cutMs = stats.pendingMs(150);
  stats.recordStopped(150);
  stats.recordDrain({
    pendingMsAtStart: 40,
    requestedMs: 100,
    waitedMs: 100,
    playedMs: 20,
    cutMs,
    flushedObjects: 2,
    undecodedFlushedObjects: 0,
  });

  const snapshot = stats.snapshot(150);
  assert.deepEqual(snapshot.lastDrain, {
    pendingMsAtStart: 40,
    requestedMs: 100,
    waitedMs: 100,
    playedMs: 20,
    cutMs: 0,
    flushedObjects: 2,
    undecodedFlushedObjects: 0,
  });
  // 予約は [100, 120] と [120, 140] であり、150 では両方鳴り終わっているため
  // stopped (切った量) は 0 のまま
  assert.equal(snapshot.missedByReason.stopped.ms, cutMs);
  // reset で前の購読の drain を残さない
  stats.reset();
  assert.isNull(stats.snapshot(150).lastDrain);
});

/**
 * 完了条件: 停止時の drain が、予約済みの最後の終わり (pendingEndMs) と残りの長さ
 * (pendingMs) を読めること。時刻を過ぎた予約は数えない。
 */
test("pendingEndMs / pendingMs: 鳴り終わっていない予約の最後と残りを返す", (): void => {
  const stats = new AudioPlayoutTimingStats(AUDIO_PLAYOUT_TIMING_WINDOW_MS, 0);
  assert.isNull(stats.pendingEndMs(0), "予約が無ければ null");
  assert.equal(stats.pendingMs(0), 0);

  // [100, 120] と [140, 160] の 2 つを予約する (時刻は performance.now 軸のミリ秒)
  stats.recordPlay(0, 100, 100, 20, "timestamp");
  stats.recordPlay(0, 140, 140, 20, "timestamp");

  assert.equal(stats.pendingEndMs(0), 160, "最後に鳴り終わる時刻を返すこと");
  assert.equal(stats.pendingMs(0), 40, "残りの合計を返すこと");
  // 1 つ目の途中では、1 つ目の残りと 2 つ目を含める
  assert.equal(stats.pendingEndMs(110), 160);
  assert.equal(stats.pendingMs(110), 30);
  // すべて鳴り終わった後は何も残らない
  assert.isNull(stats.pendingEndMs(200));
  assert.equal(stats.pendingMs(200), 0);
});

/**
 * 完了条件: drain の結果 (鳴らせた量・切った量・待ち時間・flush 件数) を計器に残す。
 * `missedByReason.stopped` の意味 (切った量) は変えない。
 */
test("recordDrain: drain の結果を lastDrain に残す", (): void => {
  const stats = new AudioPlayoutTimingStats(AUDIO_PLAYOUT_TIMING_WINDOW_MS, 0);
  stats.recordPlay(0, 100, 100, 20, "timestamp");
  // drain の間に 1 つ鳴らせた (予約を追加した) ことにする
  stats.recordPlay(10, 120, 120, 20, "timestamp");
  const cutMs = stats.pendingMs(150);
  stats.recordStopped(150);
  stats.recordDrain({
    pendingMsAtStart: 40,
    requestedMs: 100,
    waitedMs: 100,
    playedMs: 20,
    cutMs,
    flushedObjects: 2,
  });

  const snapshot = stats.snapshot(150);
  assert.deepEqual(snapshot.lastDrain, {
    pendingMsAtStart: 40,
    requestedMs: 100,
    waitedMs: 100,
    playedMs: 20,
    cutMs: 0,
    flushedObjects: 2,
  });
  // 予約は [100, 120] と [120, 140] であり、150 では両方鳴り終わっているため
  // stopped (切った量) は 0 のまま
  assert.equal(snapshot.missedByReason.stopped.ms, cutMs);
  // reset で前の購読の drain を残さない
  stats.reset();
  assert.isNull(stats.snapshot(150).lastDrain);
});
