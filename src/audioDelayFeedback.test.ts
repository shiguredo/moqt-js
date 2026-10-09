/**
 * 音声の目標遅延を、実際に鳴った結果から閉ループで決める規則
 *
 * `src/audioDelayFeedback.ts` の規則 (増減の条件、速さ、上下限、`targetLatencyMs` との
 * 関係) を固定する。実測に相当する入力を時間軸と鳴らす時刻の決定へ通した受け入れ条件は
 * `src/audioDelayClosedLoop.test.ts` にある。
 *
 * 観測は購読側 (`AudioPlayoutTimingStats.audioDelayFeedback`) が作る値と同じ形の
 * オブジェクトを直接渡す。時刻はミリ秒で、`performance.now()` と同じ軸である。
 */

import { test, assert } from "vite-plus/test";
import {
  AUDIO_DELAY_FEEDBACK_DECREASE_MS_PER_SECOND,
  AUDIO_DELAY_FEEDBACK_INTERVAL_MS,
  AUDIO_DELAY_FEEDBACK_MAX_MS,
  AUDIO_DELAY_FEEDBACK_MAX_STEP_MS,
  AUDIO_DELAY_FEEDBACK_MIN_MS,
  AUDIO_DELAY_FEEDBACK_START_MS,
  AUDIO_DELAY_FEEDBACK_TOLERANCE_MS,
  AudioDelayFeedback,
  type AudioDelayFeedbackObservation,
} from "./audioDelayFeedback";
import { summarizeTimings } from "./timingSummary";

/**
 * 観測を 1 つ作る
 *
 * @param atMs - 観測した時刻 (ミリ秒)
 * @param latenessP50Ms - 予定を過ぎて鳴った量の p50 (ミリ秒)。観測が無いときは null
 * @param backlogMisses - 並べすぎで捨てた音の数 (累積)
 * @param backlogMs - 並べすぎで捨てた長さ (ミリ秒、累積)
 */
function observation(
  atMs: number,
  latenessP50Ms: number | null,
  backlogMisses = 0,
  backlogMs = 0,
): AudioDelayFeedbackObservation {
  const latenessMs = summarizeTimings(latenessP50Ms === null ? [] : [latenessP50Ms]);
  const startDelayMs = summarizeTimings([120]);
  const slackMs = summarizeTimings([20]);
  return {
    atMs,
    latenessMs,
    startDelayMs,
    slackMs,
    backlogMisses,
    backlogMs,
  };
}

// 閉ループの目標は初期値 (100 ms) から始める。ただし、実際に鳴った結果をまだ 1 つも
// 観測していない間は使わない (観測が無い間に動かすと、まだ鳴らしていない間の表示の遅れが
// 変わる)。観測を受けたら、揺らぎだけから求めた目標 (NetEq) との大きい方を使う
test("観測が無い間は閉ループの目標を使わない", () => {
  const feedback = new AudioDelayFeedback();
  const snapshot = feedback.snapshot(80);

  assert.equal(snapshot.targetMs, AUDIO_DELAY_FEEDBACK_START_MS, "初期値から始めること");
  assert.equal(snapshot.reason, "initial", "理由が初期状態であること");
  assert.equal(snapshot.adjustments, 0, "まだ動かしていないこと");
  assert.isNull(snapshot.latenessP50Ms, "観測が無いこと");
  // 観測が無い間は、既存の規則 (揺らぎだけから求めた目標) をそのまま使う
  assert.equal(feedback.targetDelayMs(0), 0, "観測が無ければ閉ループの目標を使わないこと");
  assert.equal(feedback.targetDelayMs(300), 300, "揺らぎだけの目標をそのまま使うこと");

  // 観測を 1 つ受けたら、閉ループの目標 (初期値 100 ms) と大きい方を使う
  feedback.update(observation(0, AUDIO_DELAY_FEEDBACK_TOLERANCE_MS));
  assert.equal(
    feedback.targetDelayMs(0),
    AUDIO_DELAY_FEEDBACK_START_MS,
    "観測後は初期値を使うこと",
  );
  assert.equal(feedback.targetDelayMs(300), 300, "揺らぎだけの目標の方が大きければそれを使うこと");
});

// 遅れが続くなら目標を増やす。増やす量は「遅れ - 許容 + 余白」であり、1 回の上限までにする。
// 許容のすぐ上で往復しないよう余白を足す
test("遅れが続くなら、遅れの分だけ目標を増やす", () => {
  const feedback = new AudioDelayFeedback();

  // 遅れ 60 ms: 60 - 10 + 20 = 70 だが、1 回の上限 (40) までにする
  feedback.update(observation(0, 60));
  assert.equal(feedback.feedbackTargetMs, AUDIO_DELAY_FEEDBACK_START_MS + 40, "上限まで増やすこと");
  // 理由は遅れである
  assert.equal(feedback.snapshot(40).reason, "lateness", "理由が遅れであること");

  // 遅れ 20 ms: 20 - 10 + 20 = 30 だけ増やす
  feedback.update(observation(AUDIO_DELAY_FEEDBACK_INTERVAL_MS, 20));
  assert.equal(
    feedback.feedbackTargetMs,
    AUDIO_DELAY_FEEDBACK_START_MS + AUDIO_DELAY_FEEDBACK_MAX_STEP_MS + 30,
    "遅れに応じた分だけ増やすこと",
  );
});

// 目標を動かすのは間隔ごとに 1 回だけである。増やした結果が観測へ現れる前に増やし続けると、
// 上限に張り付いて遅延だけが増える
test("間隔が空いていなければ目標を動かさない", () => {
  const feedback = new AudioDelayFeedback();

  feedback.update(observation(0, 100));
  const afterFirst = feedback.feedbackTargetMs;
  assert.isAbove(afterFirst, AUDIO_DELAY_FEEDBACK_START_MS, "まず増やすこと");

  feedback.update(observation(AUDIO_DELAY_FEEDBACK_INTERVAL_MS - 1, 100));
  assert.equal(feedback.feedbackTargetMs, afterFirst, "間隔の途中では動かさないこと");
  assert.equal(feedback.snapshot(100).reason, "waiting", "動かしていないことが分かること");

  feedback.update(observation(AUDIO_DELAY_FEEDBACK_INTERVAL_MS, 100));
  assert.isAbove(feedback.feedbackTargetMs, afterFirst, "間隔が空いたら動かすこと");
});

// 並べすぎで捨てたなら、捨てた長さぶんを吸収できるだけ増やす (捨てた長さ + 余白、1 回の上限まで)
test("並べすぎで捨てたなら、捨てた長さぶん増やす", () => {
  const feedback = new AudioDelayFeedback();

  feedback.update(observation(0, 0, 5, 100));
  assert.equal(
    feedback.feedbackTargetMs,
    AUDIO_DELAY_FEEDBACK_START_MS + 40,
    "捨てた長さと余白の合計を上限で切って増やすこと",
  );
  assert.equal(feedback.snapshot(40).reason, "backlog", "理由が並べすぎであること");

  // 捨てが続いていない (累積が増えていない) なら、遅れの判断へ移る
  feedback.update(observation(AUDIO_DELAY_FEEDBACK_INTERVAL_MS, 0, 5, 100));
  assert.equal(feedback.snapshot(140).reason, "settled", "捨てが無ければ減らす判断へ移ること");
});

// 遅れが許容の中に収まり、捨てが無いなら目標を減らす。減らす速さは時間に比例させ、
// 観測が疎でも速さを変えない
test("遅れが許容の中に収まっていれば、毎秒の速さで目標を減らす", () => {
  const feedback = new AudioDelayFeedback();
  feedback.update(observation(0, 100));
  const increased = feedback.feedbackTargetMs;

  feedback.update(observation(AUDIO_DELAY_FEEDBACK_INTERVAL_MS, AUDIO_DELAY_FEEDBACK_TOLERANCE_MS));
  assert.equal(
    feedback.feedbackTargetMs,
    increased - AUDIO_DELAY_FEEDBACK_DECREASE_MS_PER_SECOND,
    "1 秒ぶん減らすこと",
  );

  // 2 秒空いたら 2 秒ぶん減らす (速さは変わらない)
  feedback.update(
    observation(AUDIO_DELAY_FEEDBACK_INTERVAL_MS * 3, AUDIO_DELAY_FEEDBACK_TOLERANCE_MS),
  );
  assert.equal(
    feedback.feedbackTargetMs,
    increased - AUDIO_DELAY_FEEDBACK_DECREASE_MS_PER_SECOND * 3,
    "空いた時間の分だけ減らすこと",
  );
});

// 目標は下限 (80 ms) から上限 (300 ms) の間に収める。下限より下げると揺らぎを吸収できず、
// 上限より上げると常に大きく遅れて鳴る
test("目標を下限と上限の中に収める", () => {
  const feedback = new AudioDelayFeedback();

  // 十分な回数を減らしても下限を下回らない
  for (let index = 0; index < 100; index++) {
    feedback.update(observation(index * AUDIO_DELAY_FEEDBACK_INTERVAL_MS, 0));
  }
  assert.equal(feedback.feedbackTargetMs, AUDIO_DELAY_FEEDBACK_MIN_MS, "下限で止まること");

  // 十分な回数を増やしても上限を超えない
  for (let index = 0; index < 100; index++) {
    feedback.update(observation(1_000_000 + index * AUDIO_DELAY_FEEDBACK_INTERVAL_MS, 400));
  }
  assert.equal(feedback.feedbackTargetMs, AUDIO_DELAY_FEEDBACK_MAX_MS, "上限で止まること");
});

// 明示設定 (`targetLatencyMs`) は、自動で決める目標の上限として尊重する。
// 値が変わった時点で、既に超えていればその場で収める
test("明示設定を上限として尊重する", () => {
  const feedback = new AudioDelayFeedback();
  for (let index = 0; index < 10; index++) {
    feedback.update(observation(index * AUDIO_DELAY_FEEDBACK_INTERVAL_MS, 400));
  }
  assert.isAbove(feedback.feedbackTargetMs, 120, "まず自動で増えること");

  feedback.setCeilingMs(120);
  assert.equal(feedback.feedbackTargetMs, 120, "上限に収めること");
  assert.equal(feedback.ceiling, 120, "上限を保持すること");

  // 上限より大きい値へは増えない
  for (let index = 0; index < 10; index++) {
    feedback.update(observation(1_000_000 + index * AUDIO_DELAY_FEEDBACK_INTERVAL_MS, 400));
  }
  assert.equal(feedback.feedbackTargetMs, 120, "上限を超えないこと");

  // 上限を外すと、また自動で増える
  feedback.setCeilingMs(null);
  feedback.update(observation(2_000_000, 400));
  assert.isAbove(feedback.feedbackTargetMs, 120, "上限が無ければ増えること");
});

// 揺らぎだけから求めた目標 (NetEq) の方が大きいときは、それを使う。上限は自動で決める分に
// だけ掛け、NetEq の値には掛けない (既存の揺らぎの吸収を変えないため)
test("揺らぎだけから求めた目標の方が大きければ、それを使う", () => {
  const feedback = new AudioDelayFeedback();
  feedback.setCeilingMs(90);
  // 観測を受けて、閉ループの目標を使い始めさせる (遅れが続いているため上限まで増える)
  feedback.update(observation(0, 100));

  assert.equal(feedback.targetDelayMs(20), 90, "閉ループの目標 (上限まで) を使うこと");
  assert.equal(feedback.targetDelayMs(260), 260, "NetEq の値の方が大きければそれを使うこと");

  const snapshot = feedback.snapshot(260);
  assert.equal(snapshot.jitterTargetMs, 260, "揺らぎだけの目標を出すこと");
  assert.equal(snapshot.appliedMs, 260, "実際に使う値を出すこと");
  assert.equal(snapshot.ceilingMs, 90, "明示された上限を出すこと");
});

// 購読のやり直しで累積の捨てが 0 に戻っても、負の差で増やさない。
// 観測が無い (まだ鳴らしていない) ときは目標を動かさない
test("累積が戻っても増やさず、観測が無ければ動かさない", () => {
  const feedback = new AudioDelayFeedback();
  feedback.update(observation(0, 0, 5, 100));
  assert.equal(feedback.snapshot(40).reason, "backlog", "捨てで増えること");

  // 購読のやり直しで累積が 0 に戻る
  feedback.update(observation(AUDIO_DELAY_FEEDBACK_INTERVAL_MS, 0, 0, 0));
  assert.equal(feedback.snapshot(140).reason, "settled", "捨ての差が負でも増やさないこと");

  // 遅れの観測が無いときは動かさない
  const before = feedback.feedbackTargetMs;
  feedback.update(observation(AUDIO_DELAY_FEEDBACK_INTERVAL_MS * 2, null));
  assert.equal(feedback.feedbackTargetMs, before, "観測が無ければ動かさないこと");
  assert.equal(feedback.snapshot(100).reason, "waiting", "理由が待ちであること");
});

// 学習を消すと初期状態に戻る (テストと、購読を作り直す呼び出し側のためのもの)
test("学習を消すと初期状態に戻る", () => {
  const feedback = new AudioDelayFeedback();
  feedback.setCeilingMs(200);
  feedback.update(observation(0, 100));
  feedback.reset();

  const snapshot = feedback.snapshot(80);
  assert.equal(snapshot.targetMs, AUDIO_DELAY_FEEDBACK_START_MS, "初期値へ戻ること");
  assert.equal(snapshot.reason, "initial", "理由も戻ること");
  assert.equal(snapshot.adjustments, 0, "回数も戻ること");
  assert.isNull(snapshot.latenessP50Ms, "観測も消えること");
  // 明示設定の上限は残す (呼び出し側が決めた値である)
  assert.equal(feedback.ceiling, 200, "明示設定は残ること");
});
