/**
 * 音声の目標遅延を、実際に鳴った結果から閉ループで決める規則
 *
 * `src/playout/audioDelayFeedback.ts` の規則 (増減の条件、速さ、上下限、`targetLatencyMs` との
 * 関係) を固定する。実測に相当する入力を時間軸と鳴らす時刻の決定へ通した受け入れ条件は
 * `src/playout/audioDelayClosedLoop.test.ts` にある。
 *
 * 観測は購読側 (`AudioPlayoutTimingStats.audioDelayFeedback`) が作る値と同じ形の
 * オブジェクトを直接渡す。時刻はミリ秒で、`performance.now()` と同じ軸である。
 */

import { test, assert } from "vite-plus/test";
import {
  AUDIO_DELAY_FEEDBACK_ARTIFACT_CEILING_MS,
  AUDIO_DELAY_FEEDBACK_DECREASE_MS_PER_SECOND,
  AUDIO_DELAY_FEEDBACK_INTERVAL_MS,
  AUDIO_DELAY_FEEDBACK_MAX_MS,
  AUDIO_DELAY_FEEDBACK_MAX_STEP_MS,
  AUDIO_DELAY_FEEDBACK_MIN_MS,
  AUDIO_DELAY_FEEDBACK_START_MS,
  AUDIO_DELAY_FEEDBACK_TOLERANCE_MS,
  AudioDelayFeedback,
  type AudioDelayFeedbackObservation,
  AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS,
} from "./audioDelayFeedback";
import { summarizeTimings } from "./timingSummary";

/**
 * 観測を 1 つ作る
 *
 * `jitterTargetMs` の既定は適用の上限 (100 ms) であり、「経路は 100 ms 以内で足りている」
 * ことを意味する (上限を 100 ms へ戻してよい状態)
 *
 * @param atMs - 観測した時刻 (ミリ秒)
 * @param latenessP50Ms - 予定を過ぎて鳴った量の p50 (ミリ秒)。観測が無いときは null
 * @param options.backlogMisses - 並べすぎで捨てた音の数 (累積)
 * @param options.backlogMs - 並べすぎで捨てた長さ (ミリ秒、累積)
 * @param options.compressionMs - 前の観測から増えた圧縮 (ミリ秒)。既定は 0 (圧縮なし)
 * @param options.jitterTargetMs - 揺らぎだけから求めた目標 (NetEq、ミリ秒)
 */
function observation(
  atMs: number,
  latenessP50Ms: number | null,
  options: {
    backlogMisses?: number;
    backlogMs?: number;
    compressionMs?: number;
    jitterTargetMs?: number;
  } = {},
): AudioDelayFeedbackObservation {
  const latenessMs = summarizeTimings(latenessP50Ms === null ? [] : [latenessP50Ms]);
  const startDelayMs = summarizeTimings([120]);
  const slackMs = summarizeTimings([20]);
  return {
    atMs,
    latenessMs,
    startDelayMs,
    slackMs,
    backlogMisses: options.backlogMisses ?? 0,
    backlogMs: options.backlogMs ?? 0,
    compressionMs: options.compressionMs ?? 0,
    jitterTargetMs: options.jitterTargetMs ?? AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS,
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
  assert.equal(
    feedback.targetDelayMs(300),
    AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS,
    "揺らぎだけの目標をそのまま使うこと",
  );

  // 観測を 1 つ受けたら、閉ループの目標 (初期値 100 ms) と大きい方を使う
  feedback.update(observation(0, AUDIO_DELAY_FEEDBACK_TOLERANCE_MS));
  assert.equal(
    feedback.targetDelayMs(0),
    AUDIO_DELAY_FEEDBACK_START_MS,
    "観測後は初期値を使うこと",
  );
  assert.equal(
    feedback.targetDelayMs(300),
    AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS,
    "揺らぎだけの目標の方が大きければそれを使うこと",
  );
});

/**
 * 遅れが許容の中に収まっている観測だけを与えて、目標を下限まで下げる
 *
 * 内部目標は、実際に適用される上限 (`AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS` = 100 ms) で切る
 * (欠陥 5)。初期値もこの上限と同じ 100 ms であるため、増える向きの規則を確かめるには、
 * まず下げて余地を作る必要がある。最初の観測は前回が無いため動かず、以降は毎秒 10 ms ずつ
 * 下がるので、6 回 (5 秒) で下限 (50 ms) へ届く
 *
 * @param feedback - 下げる対象
 */
function lowerToMinimum(feedback: AudioDelayFeedback): void {
  for (let index = 0; index < 6; index++) {
    feedback.update(observation(index * AUDIO_DELAY_FEEDBACK_INTERVAL_MS, 0));
  }
}

// 遅れが続くなら目標を増やす。増やす量は「遅れ - 許容 + 余白」であり、1 回の上限までにする。
// 許容のすぐ上で往復しないよう余白を足す
test("遅れが続くなら、遅れの分だけ目標を増やす", () => {
  // 遅れ 20 ms: 20 - 10 + 20 = 30 だけ増やす
  const gentle = new AudioDelayFeedback();
  lowerToMinimum(gentle);
  assert.equal(gentle.feedbackTargetMs, AUDIO_DELAY_FEEDBACK_MIN_MS, "まず下限まで下げること");

  gentle.update(observation(6_000, 20));
  assert.equal(
    gentle.feedbackTargetMs,
    AUDIO_DELAY_FEEDBACK_MIN_MS + 30,
    "遅れに応じた分だけ増やすこと",
  );
  // 理由は遅れである
  assert.equal(gentle.snapshot(40).reason, "lateness", "理由が遅れであること");

  // 遅れ 60 ms: 60 - 10 + 20 = 70 だが、1 回の上限 (40) までにする
  const steep = new AudioDelayFeedback();
  lowerToMinimum(steep);
  steep.update(observation(6_000, 60));
  assert.equal(
    steep.feedbackTargetMs,
    AUDIO_DELAY_FEEDBACK_MIN_MS + AUDIO_DELAY_FEEDBACK_MAX_STEP_MS,
    "1 回の増加は上限までにすること",
  );
});

// 目標を動かすのは間隔ごとに 1 回だけである。増やした結果が観測へ現れる前に増やし続けると、
// 上限に張り付いて遅延だけが増える
test("間隔が空いていなければ目標を動かさない", () => {
  const feedback = new AudioDelayFeedback();
  lowerToMinimum(feedback);

  feedback.update(observation(6_000, 100));
  const afterFirst = feedback.feedbackTargetMs;
  assert.isAbove(afterFirst, AUDIO_DELAY_FEEDBACK_MIN_MS, "まず増やすこと");

  feedback.update(observation(6_000 + AUDIO_DELAY_FEEDBACK_INTERVAL_MS - 1, 100));
  assert.equal(feedback.feedbackTargetMs, afterFirst, "間隔の途中では動かさないこと");
  assert.equal(feedback.snapshot(100).reason, "waiting", "動かしていないことが分かること");

  feedback.update(observation(6_000 + AUDIO_DELAY_FEEDBACK_INTERVAL_MS, 100));
  assert.isAbove(feedback.feedbackTargetMs, afterFirst, "間隔が空いたら動かすこと");
});

// 並べすぎで捨てたなら、捨てた長さぶんを吸収できるだけ増やす (捨てた長さ + 余白、1 回の上限まで)
test("並べすぎで捨てたなら、捨てた長さぶん増やす", () => {
  const feedback = new AudioDelayFeedback();
  lowerToMinimum(feedback);

  feedback.update(observation(6_000, 0, { backlogMisses: 5, backlogMs: 100 }));
  assert.equal(
    feedback.feedbackTargetMs,
    AUDIO_DELAY_FEEDBACK_MIN_MS + 40,
    "捨てた長さと余白の合計を上限で切って増やすこと",
  );
  assert.equal(feedback.snapshot(40).reason, "backlog", "理由が並べすぎであること");

  // 捨てが続いていない (累積が増えていない) なら、遅れの判断へ移る
  feedback.update(observation(7_000, 0, { backlogMisses: 5, backlogMs: 100 }));
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

// 目標は下限 (50 ms) から、実際に適用される上限 (100 ms) の間に収める。下限より下げると
// 揺らぎを吸収できず、上限より上げると常に大きく遅れて鳴る。適用は
// `AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS` で切られるため、内部目標もそこで切る (欠陥 5)
test("目標を下限と上限の中に収める", () => {
  const feedback = new AudioDelayFeedback();

  // 十分な回数を減らしても下限を下回らない
  for (let index = 0; index < 100; index++) {
    feedback.update(observation(index * AUDIO_DELAY_FEEDBACK_INTERVAL_MS, 0));
  }
  assert.equal(feedback.feedbackTargetMs, AUDIO_DELAY_FEEDBACK_MIN_MS, "下限で止まること");

  // 十分な回数を増やしても、適用される上限を超えない
  for (let index = 0; index < 100; index++) {
    feedback.update(observation(1_000_000 + index * AUDIO_DELAY_FEEDBACK_INTERVAL_MS, 400));
  }
  assert.equal(
    feedback.feedbackTargetMs,
    AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS,
    "適用される上限で止まること",
  );
});

// 内部目標は、実際に適用される上限 (min(AUDIO_DELAY_FEEDBACK_MAX_MS, ceilingMs,
// AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS)) で止まる (欠陥 5)。実測では内部目標が 198.4 ms まで
// 巻き上がり、適用は 100 ms のままで、乖離した分を減らし切るまで復帰に 20 秒以上かかった
test("内部目標は、実際に適用される上限で止まる", () => {
  // 明示設定が無いときは、絶対上限 (300 ms) ではなく適用される上限 (100 ms) で止まる
  const automatic = new AudioDelayFeedback();
  for (let index = 0; index < 120; index++) {
    automatic.update(observation(index * AUDIO_DELAY_FEEDBACK_INTERVAL_MS, 400));
  }
  assert.isBelow(
    AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS,
    AUDIO_DELAY_FEEDBACK_MAX_MS,
    "適用される上限が絶対上限より小さいこと",
  );
  assert.equal(
    automatic.feedbackTargetMs,
    AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS,
    "明示設定が無いときは適用される上限で止まること",
  );
  // 実際に使う値と乖離しない (乖離が無ければ、遅れが収まった時点でそのまま下がる)
  assert.equal(
    automatic.snapshot(0).appliedMs,
    automatic.feedbackTargetMs,
    "内部目標と実際に使う値が一致すること",
  );

  // 明示設定が適用される上限より大きいときも、適用される上限で止まる
  const largeCeiling = new AudioDelayFeedback();
  largeCeiling.setCeilingMs(AUDIO_DELAY_FEEDBACK_MAX_MS);
  for (let index = 0; index < 120; index++) {
    largeCeiling.update(observation(index * AUDIO_DELAY_FEEDBACK_INTERVAL_MS, 400));
  }
  assert.equal(
    largeCeiling.feedbackTargetMs,
    AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS,
    "大きい明示設定でも適用される上限で止まること",
  );

  // 明示設定が適用される上限より小さいときは、その値で止まる
  for (const ceilingMs of [90, 70, 60]) {
    const capped = new AudioDelayFeedback();
    capped.setCeilingMs(ceilingMs);
    for (let index = 0; index < 120; index++) {
      capped.update(observation(index * AUDIO_DELAY_FEEDBACK_INTERVAL_MS, 400));
    }
    assert.equal(capped.feedbackTargetMs, ceilingMs, `明示設定 ${ceilingMs} ms で止まること`);
  }
});

// 明示設定 (`targetLatencyMs`) は、自動で決める目標の上限として尊重する。
// 値が変わった時点で、既に超えていればその場で収める
test("明示設定を上限として尊重する", () => {
  const feedback = new AudioDelayFeedback();
  // 明示設定が無いときは、適用される上限 (100 ms) まで上がる
  for (let index = 0; index < 10; index++) {
    feedback.update(observation(index * AUDIO_DELAY_FEEDBACK_INTERVAL_MS, 400));
  }
  assert.equal(
    feedback.feedbackTargetMs,
    AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS,
    "明示が無ければ適用される上限まで上がること",
  );

  // 適用される上限より小さい明示設定は、その場で収める
  feedback.setCeilingMs(60);
  assert.equal(feedback.feedbackTargetMs, 60, "上限に収めること");
  assert.equal(feedback.ceiling, 60, "上限を保持すること");

  // 上限より大きい値へは増えない
  for (let index = 0; index < 10; index++) {
    feedback.update(observation(1_000_000 + index * AUDIO_DELAY_FEEDBACK_INTERVAL_MS, 400));
  }
  assert.equal(feedback.feedbackTargetMs, 60, "上限を超えないこと");

  // 上限を外すと、また自動で増える (適用される上限まで)
  feedback.setCeilingMs(null);
  feedback.update(observation(2_000_000, 400));
  assert.isAbove(feedback.feedbackTargetMs, 60, "上限が無ければ増えること");
  assert.isAtMost(
    feedback.feedbackTargetMs,
    AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS,
    "適用される上限は超えないこと",
  );
});

// 揺らぎだけから求めた目標 (NetEq) の方が大きいときは、それを使う。上限は自動で決める分に
// だけ掛け、NetEq の値には掛けない (既存の揺らぎの吸収を変えないため)
test("揺らぎだけから求めた目標の方が大きければ、それを使う", () => {
  const feedback = new AudioDelayFeedback();
  feedback.setCeilingMs(90);
  // 観測を受けて、閉ループの目標を使い始めさせる (遅れが続いているため上限まで増える)
  feedback.update(observation(0, 100));

  assert.equal(feedback.targetDelayMs(20), 90, "閉ループの目標 (上限まで) を使うこと");
  assert.equal(
    feedback.targetDelayMs(260),
    AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS,
    "NetEq の値の方が大きければそれを使うこと",
  );

  const snapshot = feedback.snapshot(260);
  assert.equal(snapshot.jitterTargetMs, 260, "揺らぎだけの目標を出すこと");
  assert.equal(snapshot.appliedMs, AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS, "実際に使う値を出すこと");
  assert.equal(snapshot.ceilingMs, 90, "明示された上限を出すこと");
});

// 購読のやり直しで累積の捨てが 0 に戻っても、負の差で増やさない。
// 観測が無い (まだ鳴らしていない) ときは目標を動かさない
test("累積が戻っても増やさず、観測が無ければ動かさない", () => {
  const feedback = new AudioDelayFeedback();
  feedback.update(observation(0, 0, { backlogMisses: 5, backlogMs: 100 }));
  assert.equal(feedback.snapshot(40).reason, "backlog", "捨てで増えること");

  // 購読のやり直しで累積が 0 に戻る
  feedback.update(observation(AUDIO_DELAY_FEEDBACK_INTERVAL_MS, 0));
  assert.equal(feedback.snapshot(140).reason, "settled", "捨ての差が負でも増やさないこと");

  // 遅れの観測が無いときは動かさない
  const before = feedback.feedbackTargetMs;
  feedback.update(observation(AUDIO_DELAY_FEEDBACK_INTERVAL_MS * 2, null));
  assert.equal(feedback.feedbackTargetMs, before, "観測が無ければ動かさないこと");
  assert.equal(feedback.snapshot(100).reason, "waiting", "理由が待ちであること");
});

/**
 * 経路へ渡した目標から、その 1 秒に出る圧縮 (時間圧縮) を模す
 *
 * 経路が必要とする遅延 (`pathMs`) に適用する目標が届いていなければ毎秒 20 ms 詰める
 * (実測の圧縮は毎秒 9〜17 ms であり、同じ向きの入力である)。目標が届けば詰めない
 */
function compressionFor(appliedMs: number, pathMs: number): number {
  return appliedMs < pathMs ? 20 : 0;
}

// 圧縮 (粗さ) が続くときだけ上限を 160 ms へ広げる。実測 (2026-10-16、実リレー 60 秒) では
// 揺らぎだけの目標 (NetEq) が 100〜340 ms に育ち、上限 100 ms が常時拘束されて時間圧縮が
// 60 秒で 550〜1000 ms (静かな回でも 556〜996 ms) 続いた。上限を上げれば、遅れて届いて
// いた音が収まって圧縮が止まる
test("圧縮が続くときだけ上限を 160 ms へ広げ、圧縮を止める", () => {
  const feedback = new AudioDelayFeedback();
  // 経路は 160 ms を必要とする (実測の jitterTargetMs の下限側)
  const pathMs = AUDIO_DELAY_FEEDBACK_ARTIFACT_CEILING_MS;
  const step = (second: number): number => {
    const appliedMs = feedback.targetDelayMs(pathMs);
    const compressionMs = compressionFor(appliedMs, pathMs);
    feedback.update(
      observation(second * AUDIO_DELAY_FEEDBACK_INTERVAL_MS, 0, {
        compressionMs,
        jitterTargetMs: pathMs,
      }),
    );
    return compressionMs;
  };

  // 1 秒目と 2 秒目は既定の上限 (100 ms) のままで、詰め続けている
  assert.equal(step(0), 20, "最初の 1 秒は詰めていること");
  assert.equal(step(1), 20, "2 秒目も詰めていること");
  assert.equal(
    feedback.snapshot(pathMs).appliedCeilingMs,
    AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS,
    "1 秒では広げないこと",
  );
  assert.equal(feedback.snapshot(pathMs).compressionMsPerSecond, 20, "圧縮の速さを観測すること");

  // 2 秒続いたため 3 秒目には 160 ms まで使い、圧縮が止まる
  assert.equal(step(2), 20, "広げる直前までは詰めていること");
  const raised = feedback.snapshot(pathMs);
  assert.equal(
    raised.appliedCeilingMs,
    AUDIO_DELAY_FEEDBACK_ARTIFACT_CEILING_MS,
    "圧縮が 2 秒続いたら 160 ms へ広げること",
  );
  assert.equal(raised.appliedMs, pathMs, "適用する目標が 100 ms を超えて 160 ms になること");
  for (let second = 3; second <= 60; second++) {
    assert.equal(step(second), 0, `${second + 1} 秒目に圧縮が止まること`);
    assert.equal(
      feedback.snapshot(pathMs).appliedCeilingMs,
      AUDIO_DELAY_FEEDBACK_ARTIFACT_CEILING_MS,
      "経路が 160 ms を必要とする間は広げたままにすること",
    );
  }
});

// 経路が静かになったら 15 秒で上限を 100 ms へ戻す。圧縮が 0 になっただけでは戻さない
// (揺らぎが 100 ms を超えている経路では、戻した直後に圧縮が再発して往復する)
test("経路が静かになったら、15 秒で上限を 100 ms へ戻す", () => {
  const feedback = new AudioDelayFeedback();
  const pathMs = AUDIO_DELAY_FEEDBACK_ARTIFACT_CEILING_MS;
  // 0〜9 秒: 経路は 160 ms を必要とし、遅れも続く (内部の目標が広げた上限まで育つ)
  for (let second = 0; second <= 9; second++) {
    const appliedMs = feedback.targetDelayMs(pathMs);
    feedback.update(
      observation(second * AUDIO_DELAY_FEEDBACK_INTERVAL_MS, 40, {
        compressionMs: compressionFor(appliedMs, pathMs),
        jitterTargetMs: pathMs,
      }),
    );
  }
  assert.equal(
    feedback.snapshot(pathMs).appliedCeilingMs,
    AUDIO_DELAY_FEEDBACK_ARTIFACT_CEILING_MS,
    "まず 160 ms へ広げること",
  );
  assert.equal(feedback.snapshot(pathMs).appliedMs, pathMs);

  // 10 秒目から経路が静かになる (推定 90 ms、圧縮 0、遅れも収まる)。14 秒ぶんでは戻さない
  for (let second = 10; second <= 23; second++) {
    feedback.update(
      observation(second * AUDIO_DELAY_FEEDBACK_INTERVAL_MS, 0, { jitterTargetMs: 90 }),
    );
    assert.equal(
      feedback.snapshot(90).appliedCeilingMs,
      AUDIO_DELAY_FEEDBACK_ARTIFACT_CEILING_MS,
      `${second + 1} 秒目ではまだ戻さないこと`,
    );
  }
  // 15 秒ぶん続いた時点で戻す。適用する値は 100 ms 以下になり、内部の目標は既存の速さ
  // (毎秒 10 ms) で下限まで下がっている
  feedback.update(observation(24 * AUDIO_DELAY_FEEDBACK_INTERVAL_MS, 0, { jitterTargetMs: 90 }));
  assert.equal(
    feedback.snapshot(90).appliedCeilingMs,
    AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS,
    "15 秒で 100 ms へ戻すこと",
  );
  assert.isAtMost(feedback.snapshot(90).appliedMs, AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS);
  assert.equal(feedback.feedbackTargetMs, AUDIO_DELAY_FEEDBACK_MIN_MS, "内部の目標も下がること");
});

// 圧縮が無ければ上限を広げない (遅延を増やさない)。揺らぎだけの目標が 160 ms でも同じである
test("圧縮が無ければ上限を広げない", () => {
  const feedback = new AudioDelayFeedback();
  for (let second = 0; second <= 60; second++) {
    feedback.update(
      observation(second * AUDIO_DELAY_FEEDBACK_INTERVAL_MS, 0, { jitterTargetMs: 160 }),
    );
  }
  const snapshot = feedback.snapshot(160);
  assert.equal(snapshot.appliedCeilingMs, AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS, "広げないこと");
  assert.equal(snapshot.appliedMs, AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS, "遅延を増やさないこと");
});

// 揺らぎが 100 ms を超えている間は上限を戻さない (往復しない)。圧縮が 0 になっても、経路が
// 100 ms を必要としている間は 160 ms のままでよい (戻せば 2 秒でまた広げることになる)
test("揺らぎが 100 ms を超えている間は上限を戻さない", () => {
  const feedback = new AudioDelayFeedback();
  const pathMs = 120;
  for (let second = 0; second <= 60; second++) {
    const appliedMs = feedback.targetDelayMs(pathMs);
    feedback.update(
      observation(second * AUDIO_DELAY_FEEDBACK_INTERVAL_MS, 0, {
        compressionMs: compressionFor(appliedMs, pathMs),
        jitterTargetMs: pathMs,
      }),
    );
    if (second >= 3) {
      assert.equal(
        feedback.snapshot(pathMs).appliedCeilingMs,
        AUDIO_DELAY_FEEDBACK_ARTIFACT_CEILING_MS,
        `${second + 1} 秒目も 160 ms のままであること`,
      );
    }
  }
  assert.equal(feedback.snapshot(pathMs).compressionMsPerSecond, 0, "圧縮は止まっていること");
  assert.equal(feedback.snapshot(pathMs).appliedMs, pathMs, "推定の分だけ使うこと");
});

// 一時的な圧縮では上限を広げない。到着が一度乱れただけで 40 ms の遅延を払い続けないよう、
// 2 秒続くまで待つ
test("一時的な圧縮では上限を広げない", () => {
  const feedback = new AudioDelayFeedback();
  feedback.update(observation(0, 0, { compressionMs: 20, jitterTargetMs: 160 }));
  for (let second = 1; second <= 30; second++) {
    feedback.update(
      observation(second * AUDIO_DELAY_FEEDBACK_INTERVAL_MS, 0, { jitterTargetMs: 160 }),
    );
    assert.equal(
      feedback.snapshot(160).appliedCeilingMs,
      AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS,
      `${second + 1} 秒目も広げないこと`,
    );
  }
});

// 明示設定 (`targetLatencyMs`) があるときは、広げる分をその値で切る。明示設定は利用者が
// 宣言した遅延の予算である。ただし既定の上限 (100 ms) は下回らない (既存の規則では
// 揺らぎだけの目標に明示設定を掛けないため、下回らせると適用する値が既定より小さくなる)
test("明示設定があるときは、広げる分をその値で切る", () => {
  /** 圧縮が 2 秒以上続く入力で 10 秒回した閉ループを作る */
  const driven = (ceilingMs: number | null): AudioDelayFeedback => {
    const feedback = new AudioDelayFeedback();
    feedback.setCeilingMs(ceilingMs);
    for (let second = 0; second <= 10; second++) {
      feedback.update(
        observation(second * AUDIO_DELAY_FEEDBACK_INTERVAL_MS, 400, {
          compressionMs: 20,
          jitterTargetMs: 160,
        }),
      );
    }
    return feedback;
  };

  // 明示設定が無いときは 160 ms まで広がる
  assert.equal(
    driven(null).snapshot(160).appliedCeilingMs,
    AUDIO_DELAY_FEEDBACK_ARTIFACT_CEILING_MS,
  );
  // 明示設定 120 ms のときは 120 ms まで
  assert.equal(driven(120).snapshot(160).appliedCeilingMs, 120);
  assert.equal(driven(120).snapshot(160).appliedMs, 120, "適用も明示設定までにすること");
  // 明示設定 90 ms のときは広げない (適用の上限は既定の 100 ms のまま)
  assert.equal(
    driven(90).snapshot(160).appliedCeilingMs,
    AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS,
    "既定の上限を下回らせないこと",
  );
  assert.equal(driven(90).snapshot(160).appliedMs, AUDIO_DELAY_FEEDBACK_MAX_TARGET_MS);
  // 明示設定 200 ms のときは、絶対上限 (160 ms) が優先する
  assert.equal(
    driven(200).snapshot(160).appliedCeilingMs,
    AUDIO_DELAY_FEEDBACK_ARTIFACT_CEILING_MS,
  );
  // 閉ループが決めた目標は、明示設定があるときはその値で切る (既存の規則)
  assert.equal(driven(120).snapshot(160).targetMs, 120);
  assert.equal(driven(90).snapshot(160).targetMs, 90);
});
