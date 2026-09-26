/**
 * AudioPlayoutScheduler と AudioClockBridge の単体テスト
 *
 * 復号した音声を鳴らす時刻 (AudioContext.currentTime の秒) を決める。目標の時刻 (映像と
 * 共有する時間軸が決めた開始時刻) を守るときは、目標を過ぎて届いた音・並べすぎの音・
 * 前の音と重なる音を捨て、基準を取り直さない。目標を使わないとき (壁時計の TIMESTAMP を
 * 持たない音、音声だけを購読しているとき) は到着基準で並べ、届かなければ基準を取り直す。
 * AudioClockBridge は AudioContext の時計と performance.now() の対応を保つ。
 *
 * 個々の規則 (目標の上下限、捨てる理由、基準の取り直し、時計の不感帯と変更の上限) を
 * ここで固定する。鳴らす音が重ならない、今 + 余裕以上、遅れは再生の遅れ + 余裕以下という
 * 性質は audioPlayout.prop.ts が固定する。
 */

import { test, assert } from "vite-plus/test";
import {
  AUDIO_CLOCK_DEADBAND_MS,
  AUDIO_CLOCK_MAX_CHANGE_MS,
  AUDIO_PLAYOUT_BACKLOG_SECONDS,
  AUDIO_PLAYOUT_DELAY_SECONDS,
  AUDIO_PLAYOUT_MAX_DELAY_SECONDS,
  AUDIO_PLAYOUT_MIN_LEAD_SECONDS,
  AudioClockBridge,
  AudioPlayoutScheduler,
  type AudioPlayoutDecision,
  type AudioPlayoutTarget,
} from "./audioPlayout";

/** Opus の 1 フレーム (20 ms) */
const FRAME_SECONDS = 0.02;
const FRAME_MICROSECONDS = 20_000;

/** 浮動小数点の誤差を許す幅 (秒) */
const EPSILON = 1e-9;

/** 鳴らすと決めた時刻を取り出す (捨てると決めたときは失敗にする) */
function startAtOf(decision: AudioPlayoutDecision): number {
  if (decision.kind !== "play") {
    throw new Error(`expected play, got ${decision.kind}`);
  }
  return decision.startAt;
}

/** 換算した値を取り出す (対応が無くて null のときは失敗にする) */
function valueOf(value: number | null): number {
  if (value === null) {
    throw new Error("expected a value, got null");
  }
  return value;
}

/** 目標を守るとき (映像も購読しているとき) の目標 */
function enforcedTarget(targetStartSeconds: number): AudioPlayoutTarget {
  return {
    targetStartSeconds,
    enforceTarget: true,
    delaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
    presentationDelaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
  };
}

/**
 * 到着基準の並べ方になる 2 つの目標 (どちらも同じ規則で並ぶ)
 *
 * - 目標が無い: 壁時計の TIMESTAMP を持たない音。映像を購読していても目標を作れない
 * - 目標はあるが守らない: 音声だけを購読していて揃える相手がいない。届かなければ
 *   基準を取り直して鳴らす (捨てない)
 */
const arrivalTargets: {
  label: string;
  make: (targetStartSeconds: number) => AudioPlayoutTarget;
}[] = [
  {
    label: "目標が無い",
    make: () => ({
      targetStartSeconds: null,
      enforceTarget: true,
      delaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
      presentationDelaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
    }),
  },
  {
    label: "目標はあるが守らない",
    make: (targetStartSeconds) => ({
      targetStartSeconds,
      enforceTarget: false,
      delaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
      presentationDelaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
    }),
  },
];

// 既定の値: 再生の遅れ 80 ms、合計の上限 300 ms、並べすぎの余裕 220 ms (300 - 80)、
// 鳴らす時刻の下限 10 ms (描画の 1 単位 128 フレームより大きい)、時計の不感帯 30 ms、
// 時計の変更の上限 80 ms
test("既定の値: 再生の遅れ、上限、余裕、時計の不感帯と変更の上限", () => {
  assert.equal(AUDIO_PLAYOUT_DELAY_SECONDS, 0.08);
  assert.equal(AUDIO_PLAYOUT_MAX_DELAY_SECONDS, 0.3);
  assert.equal(AUDIO_PLAYOUT_MIN_LEAD_SECONDS, 0.01);
  assert.closeTo(AUDIO_PLAYOUT_BACKLOG_SECONDS, 0.22, EPSILON);
  assert.equal(AUDIO_CLOCK_DEADBAND_MS, 30);
  assert.equal(AUDIO_CLOCK_MAX_CHANGE_MS, 80);
});

// 目標を守るとき: 目標の時刻が今 + 余裕より先なら、その時刻に鳴らすと決める。
// 前後させると映像とずれるため、目標の時刻をそのまま使う
test("schedule: 目標を守るときは目標の時刻に鳴らす", () => {
  const scheduler = new AudioPlayoutScheduler();
  const decision = scheduler.schedule(10, 1_000_000, FRAME_SECONDS, enforcedTarget(10.05));
  assert.equal(startAtOf(decision), 10.05);
  assert.equal(scheduler.drops, 0);
  assert.equal(scheduler.rebases, 0);
});

// 目標を守るとき: 目標の時刻が今 + 余裕ちょうどなら鳴らす (境界。AudioContext は 128
// フレームずつ描くため、その分と予約の遅れを見込んだ下限が余裕である)
test("schedule: 目標の時刻が今 + 余裕ちょうどなら鳴らす", () => {
  const scheduler = new AudioPlayoutScheduler();
  const startAt = 10 + AUDIO_PLAYOUT_MIN_LEAD_SECONDS;
  assert.equal(
    startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, enforcedTarget(startAt))),
    startAt,
  );
});

// 目標を守るとき: 目標の時刻を過ぎて届いた音は捨てる。基準を取り直すと音声だけが後ろへ
// ずれて共有の時間軸を使う映像とずれるため、取り直さない (捨てた分は 1 フレームで戻る)
test("schedule: 目標の時刻を過ぎて届いた音は捨て、基準を取り直さない", () => {
  const scheduler = new AudioPlayoutScheduler();
  // 目標 10.04 の音が 10.05 に届く (今 + 余裕より前)
  const decision = scheduler.schedule(10.05, 0, FRAME_SECONDS, enforcedTarget(10.04));
  assert.equal(decision.kind, "drop");
  assert.equal(scheduler.drops, 1);
  assert.equal(scheduler.rebases, 0);
});

// 目標を守るとき: 並べすぎ (目標 - 今 > 再生の遅れ + 余裕) の音は捨てる。上限の 1 フレーム
// 手前は鳴らす (絶対値の上限ではなく、共有の時間軸が決めた再生の遅れに対する余裕で判定する)
test("schedule: 並べすぎの音は捨てる", () => {
  const nowSeconds = 10;
  const limit = AUDIO_PLAYOUT_DELAY_SECONDS + AUDIO_PLAYOUT_BACKLOG_SECONDS;
  const within = new AudioPlayoutScheduler();
  const inside = nowSeconds + limit - FRAME_SECONDS;
  assert.equal(
    startAtOf(within.schedule(nowSeconds, 0, FRAME_SECONDS, enforcedTarget(inside))),
    inside,
  );
  assert.equal(within.drops, 0);
  const beyond = new AudioPlayoutScheduler();
  const outside = nowSeconds + limit + FRAME_SECONDS;
  assert.equal(beyond.schedule(nowSeconds, 0, FRAME_SECONDS, enforcedTarget(outside)).kind, "drop");
  assert.equal(beyond.drops, 1);
  assert.equal(beyond.rebases, 0);
});

// 目標を守るとき: 前の音と重なる (目標が前の音の終わりより前) 音は捨てる。前の音の終わり
// ちょうどは鳴らす (重ねると音が足されてノイズになる)
test("schedule: 前の音と重なる音は捨てる", () => {
  const scheduler = new AudioPlayoutScheduler();
  const first = startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, enforcedTarget(10.08)));
  const endOfFirst = first + FRAME_SECONDS;
  // 前の音の終わり (10.10) の 1 ms 前の目標
  const overlapped = scheduler.schedule(
    10.05,
    FRAME_MICROSECONDS,
    FRAME_SECONDS,
    enforcedTarget(endOfFirst - 0.001),
  );
  assert.equal(overlapped.kind, "drop");
  assert.equal(scheduler.drops, 1);
  assert.equal(scheduler.rebases, 0);
  assert.equal(
    startAtOf(
      scheduler.schedule(10.05, 2 * FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(endOfFirst)),
    ),
    endOfFirst,
  );
});

// 目標を守るとき: 捨てた後も次の音は目標どおりに鳴る (捨てが連鎖しない)。目標は timestamp の
// 間隔で進むため、1 つ捨てても次の音の目標は今より先にある
test("schedule: 捨てた後も次の音は目標どおりに鳴る", () => {
  const scheduler = new AudioPlayoutScheduler();
  startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, enforcedTarget(10.08)));
  // 目標 10.10 の音が 10.10 に届く (今 + 余裕より前)
  assert.equal(
    scheduler.schedule(10.1, FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(10.1)).kind,
    "drop",
  );
  assert.equal(
    startAtOf(
      scheduler.schedule(10.1, 2 * FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(10.12)),
    ),
    10.12,
  );
  assert.equal(scheduler.drops, 1);
  assert.equal(scheduler.rebases, 0);
});

// 目標を守るとき: 並べすぎで捨てた後、今が進んで目標が上限に収まれば、その目標どおりに鳴る
test("schedule: 並べすぎで捨てた後も目標どおりに鳴る", () => {
  const scheduler = new AudioPlayoutScheduler();
  const limit = AUDIO_PLAYOUT_DELAY_SECONDS + AUDIO_PLAYOUT_BACKLOG_SECONDS;
  const over = 10 + limit + FRAME_SECONDS;
  assert.equal(scheduler.schedule(10, 0, FRAME_SECONDS, enforcedTarget(over)).kind, "drop");
  // 今が 2 フレーム進めば、同じ目標でも上限に収まる
  const next = startAtOf(
    scheduler.schedule(
      10 + 2 * FRAME_SECONDS,
      FRAME_MICROSECONDS,
      FRAME_SECONDS,
      enforcedTarget(over),
    ),
  );
  assert.equal(next, over);
  assert.equal(scheduler.drops, 1);
  assert.equal(scheduler.rebases, 0);
});

// 目標を使わないとき: 最初の音は今 + 再生の遅れに鳴らす。目標は使わないため、過去の目標でも
// 未来の目標でも同じ時刻になる
test("schedule: 目標を使わないときは最初の音を今 + 再生の遅れに鳴らす", () => {
  for (const { label, make } of arrivalTargets) {
    const scheduler = new AudioPlayoutScheduler();
    const startAt = startAtOf(scheduler.schedule(10, 1_000_000, FRAME_SECONDS, make(10.02)));
    assert.closeTo(startAt, 10 + AUDIO_PLAYOUT_DELAY_SECONDS, EPSILON, label);
    assert.equal(scheduler.drops, 0, label);
    assert.equal(scheduler.rebases, 0, label);
  }
});

// 目標を使わないとき: 届く間隔が揺れても、timestamp の間隔どおりに途切れなく並べる
// (届いたその場で鳴らすと、前の音と重なるか隙間が空いてノイズになる)
test("schedule: 目標を使わないときは timestamp の間隔どおりに並べる", () => {
  for (const { label, make } of arrivalTargets) {
    const scheduler = new AudioPlayoutScheduler();
    const arrivals = [10, 10.032, 10.041, 10.075, 10.08];
    const starts = arrivals.map((now, index) =>
      startAtOf(scheduler.schedule(now, index * FRAME_MICROSECONDS, FRAME_SECONDS, make(10.01))),
    );
    for (const [index, startAt] of starts.entries()) {
      assert.closeTo(
        startAt,
        10 + AUDIO_PLAYOUT_DELAY_SECONDS + index * FRAME_SECONDS,
        EPSILON,
        label,
      );
    }
    assert.equal(scheduler.rebases, 0, label);
    assert.equal(scheduler.drops, 0, label);
  }
});

// 目標を使わないとき: 音が抜けたときは、その分の無音を残して後の音の時刻を保つ
test("schedule: 目標を使わないときは音が抜けた分の無音を残す", () => {
  for (const { label, make } of arrivalTargets) {
    const scheduler = new AudioPlayoutScheduler();
    const first = startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, make(10)));
    // 20 ms の音が 1 つ抜けて、40 ms 後の音が届く
    const third = startAtOf(
      scheduler.schedule(10.04, 2 * FRAME_MICROSECONDS, FRAME_SECONDS, make(10.04)),
    );
    assert.closeTo(third - first, 2 * FRAME_SECONDS, EPSILON, label);
  }
});

// 目標を使わないとき: 過ぎてから届いた音は捨てずに基準を取り直して鳴らす。揃える相手が
// いないため音の連続性を優先する (目標を守るときは捨てる)
test("schedule: 目標を使わないときは過ぎてから届いた音で基準を取り直す", () => {
  for (const { label, make } of arrivalTargets) {
    const scheduler = new AudioPlayoutScheduler();
    startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, make(10)));
    // 2 つ目の音は 10.10 に鳴らすはずが、10.2 に届く (目標 10.05 はとっくに過ぎている)
    const late = startAtOf(
      scheduler.schedule(10.2, FRAME_MICROSECONDS, FRAME_SECONDS, make(10.05)),
    );
    assert.closeTo(late, 10.2 + AUDIO_PLAYOUT_DELAY_SECONDS, EPSILON, label);
    assert.equal(scheduler.rebases, 1, label);
    assert.equal(scheduler.drops, 0, label);
    // 取り直した基準から timestamp の間隔どおりに並ぶ
    const next = startAtOf(
      scheduler.schedule(10.21, 2 * FRAME_MICROSECONDS, FRAME_SECONDS, make(10.21)),
    );
    assert.closeTo(next, late + FRAME_SECONDS, EPSILON, label);
  }
});

// 目標を使わないとき: 並べすぎの音は捨てる。捨てた音の枠に次の音を入れて基準を前に寄せる
// 旧挙動はやめた (timestamp の間隔どおりの位置を保つ)。捨てるときは取り直しもしない
test("schedule: 目標を使わないときは並べすぎの音を捨て、捨てた音の枠に前に寄せない", () => {
  for (const { label, make } of arrivalTargets) {
    const scheduler = new AudioPlayoutScheduler();
    const now = 10;
    // 同じ今にまとまって届いた音を、前の音の終わりが「今 + 上限」を超えるまで並べる
    let timestamp = 0;
    let lastStart = startAtOf(scheduler.schedule(now, timestamp, FRAME_SECONDS, make(now)));
    timestamp += FRAME_MICROSECONDS;
    let rebasesBefore = scheduler.rebases;
    let decision = scheduler.schedule(now, timestamp, FRAME_SECONDS, make(now));
    while (decision.kind === "play") {
      lastStart = decision.startAt;
      timestamp += FRAME_MICROSECONDS;
      rebasesBefore = scheduler.rebases;
      decision = scheduler.schedule(now, timestamp, FRAME_SECONDS, make(now));
    }
    // 並べすぎになった 1 音を捨てる。捨てるときは基準を取り直さない
    assert.equal(scheduler.drops, 1, label);
    assert.equal(scheduler.rebases, rebasesBefore, label);
    assert.isAtMost(lastStart - now, AUDIO_PLAYOUT_MAX_DELAY_SECONDS + EPSILON, label);
    // 捨てた音の次の音が 50 ms 後に届く。基準を 1 音の長さだけ前に寄せていたら、この音は
    // 捨てた音の枠 (前の音の終わり) に入る。timestamp の間隔どおりの位置に鳴らす
    const rebasesAfterDrop = scheduler.rebases;
    const next = startAtOf(
      scheduler.schedule(
        now + 0.05,
        timestamp + FRAME_MICROSECONDS,
        FRAME_SECONDS,
        make(now + 0.05),
      ),
    );
    assert.closeTo(next, lastStart + 2 * FRAME_SECONDS, EPSILON, label);
    assert.equal(scheduler.drops, 1, label);
    assert.equal(scheduler.rebases, rebasesAfterDrop, label);
  }
});

// 目標を使わないとき: timestamp が進んでいない音 (TIMESTAMP が無く 0 のまま、同じ値など) は
// 前の音のすぐ後ろに並べる
test("schedule: timestamp が進まない音は前の音のすぐ後ろに並べる", () => {
  for (const { label, make } of arrivalTargets) {
    const scheduler = new AudioPlayoutScheduler();
    const first = startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, make(10)));
    const second = startAtOf(scheduler.schedule(10.02, 0, FRAME_SECONDS, make(10.02)));
    const third = startAtOf(scheduler.schedule(10.04, 0, FRAME_SECONDS, make(10.04)));
    assert.closeTo(second, first + FRAME_SECONDS, EPSILON, label);
    assert.closeTo(third, second + FRAME_SECONDS, EPSILON, label);
  }
});

// 目標を使わないとき: timestamp の間隔が音の長さより短くても、前の音の終わりより前には
// 鳴らさない (重ねない)
test("schedule: 目標を使わないときも前の音の終わりより前には鳴らさない", () => {
  for (const { label, make } of arrivalTargets) {
    const scheduler = new AudioPlayoutScheduler();
    const first = startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, make(10)));
    const second = startAtOf(scheduler.schedule(10.01, 10_000, FRAME_SECONDS, make(10.01)));
    assert.closeTo(second, first + FRAME_SECONDS, EPSILON, label);
  }
});

// 目標を使わないとき: 並べる音が溜まっていないのに timestamp が大きく飛んだ音 (送る側の
// 再起動、長い抜けなど) は、捨て続けないよう基準を取り直して鳴らす
test("schedule: 目標を使わないときは timestamp が大きく飛んだ音で基準を取り直す", () => {
  for (const { label, make } of arrivalTargets) {
    const scheduler = new AudioPlayoutScheduler();
    const first = startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, make(10)));
    // 10 秒先の timestamp の音が、20 ms 後に届く
    const jumped = startAtOf(scheduler.schedule(10.02, 10_000_000, FRAME_SECONDS, make(10.02)));
    assert.closeTo(jumped, first + FRAME_SECONDS, EPSILON, label);
    assert.equal(scheduler.rebases, 1, label);
    assert.equal(scheduler.drops, 0, label);
    const next = startAtOf(scheduler.schedule(10.04, 10_020_000, FRAME_SECONDS, make(10.04)));
    assert.closeTo(next, jumped + FRAME_SECONDS, EPSILON, label);
  }
});

// 目標が上限 (500 ms) 先でも鳴らす。並べすぎの上限は「表示に使う遅れ
// (max(targetLatency, 再生遅延)) + 余裕」から決まる。揺らぎから求めた再生遅延だけを
// 上限にすると、targetLatency が大きいときに鳴らす音をすべて捨てて無音になる
test("schedule: 目標が 500 ms 先でも鳴らす", () => {
  const scheduler = new AudioPlayoutScheduler();
  const target: AudioPlayoutTarget = {
    targetStartSeconds: 10.5,
    enforceTarget: true,
    delaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
    presentationDelaySeconds: AUDIO_PLAYOUT_MAX_DELAY_SECONDS + 0.2,
  };
  const decision = scheduler.schedule(10, 0, FRAME_SECONDS, target);
  assert.deepEqual(decision, { kind: "play", startAt: 10.5 });
  assert.equal(scheduler.drops, 0);
});

// 目標を使わないときの再生の遅れは目標から受け取る。共有の時間軸が再生遅延を決めるため、
// 旧実装のような固定の 80 ms ではない
test("schedule: 目標を使わないときの再生の遅れは目標から受け取る", () => {
  const delaySeconds = AUDIO_PLAYOUT_MAX_DELAY_SECONDS;
  const target: AudioPlayoutTarget = {
    targetStartSeconds: null,
    enforceTarget: false,
    delaySeconds,
    presentationDelaySeconds: delaySeconds,
  };
  const scheduler = new AudioPlayoutScheduler();
  assert.closeTo(
    startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, target)),
    10 + delaySeconds,
    EPSILON,
  );
  // 過ぎてから届いたときの取り直し先も、受け取った再生の遅れになる
  const late = startAtOf(scheduler.schedule(20, FRAME_MICROSECONDS, FRAME_SECONDS, target));
  assert.closeTo(late, 20 + delaySeconds, EPSILON);
  assert.equal(scheduler.rebases, 1);
});

// reset: 目標を使わないときは、次の音で基準を作り直す (購読のやり直し、AudioContext の
// 作り直し)
test("reset: 目標を使わないときは次の音で基準を作り直す", () => {
  for (const { label, make } of arrivalTargets) {
    const scheduler = new AudioPlayoutScheduler();
    startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, make(10)));
    scheduler.reset();
    const startAt = startAtOf(scheduler.schedule(20, 5_000_000, FRAME_SECONDS, make(20)));
    assert.closeTo(startAt, 20 + AUDIO_PLAYOUT_DELAY_SECONDS, EPSILON, label);
  }
});

// reset: 目標を守るときも、前の音の重なりの判定を消す (購読のやり直しで前の音の記録が
// 消えるため、消した後に届いた音は重ならない)
test("reset: 目標を守るときも前の音の重なりの判定を消す", () => {
  const scheduler = new AudioPlayoutScheduler();
  const first = startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, enforcedTarget(10.08)));
  const overlapped = first + FRAME_SECONDS / 2;
  assert.equal(
    scheduler.schedule(10.05, FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(overlapped)).kind,
    "drop",
  );
  scheduler.reset();
  assert.equal(
    startAtOf(
      scheduler.schedule(10.05, 2 * FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(overlapped)),
    ),
    overlapped,
  );
});

// 並べすぎの余裕と、鳴らす時刻の下限は指定できる。上限は「目標の再生の遅れ + 余裕」である
test("constructor: 並べすぎの余裕と鳴らす時刻の下限を指定できる", () => {
  const backlogSeconds = AUDIO_PLAYOUT_BACKLOG_SECONDS / 2;
  const minLeadSeconds = AUDIO_PLAYOUT_MIN_LEAD_SECONDS / 2;
  const limit = AUDIO_PLAYOUT_DELAY_SECONDS + backlogSeconds;
  // 指定した上限の 1 フレーム手前は鳴らす
  const within = new AudioPlayoutScheduler({ backlogSeconds });
  const inside = 10 + limit - FRAME_SECONDS;
  assert.equal(startAtOf(within.schedule(10, 0, FRAME_SECONDS, enforcedTarget(inside))), inside);
  // 指定した上限を超える目標は捨てる
  const beyond = new AudioPlayoutScheduler({ backlogSeconds });
  const outside = 10 + limit + FRAME_SECONDS;
  assert.equal(beyond.schedule(10, 0, FRAME_SECONDS, enforcedTarget(outside)).kind, "drop");
  // 同じ目標でも、既定の余裕なら鳴る (余裕の指定が効いていること)
  const defaultBacklog = new AudioPlayoutScheduler();
  assert.equal(
    startAtOf(defaultBacklog.schedule(10, 0, FRAME_SECONDS, enforcedTarget(outside))),
    outside,
  );
  // 指定した下限ちょうどは鳴らす
  const atMinLead = new AudioPlayoutScheduler({ minLeadSeconds });
  assert.equal(
    startAtOf(atMinLead.schedule(10, 0, FRAME_SECONDS, enforcedTarget(10 + minLeadSeconds))),
    10 + minLeadSeconds,
  );
  // 同じ目標でも、既定の下限なら捨てる (下限の指定が効いていること)
  const defaultMinLead = new AudioPlayoutScheduler();
  assert.equal(
    defaultMinLead.schedule(10, 0, FRAME_SECONDS, enforcedTarget(10 + minLeadSeconds)).kind,
    "drop",
  );
});

// AudioClockBridge: update をまだ呼んでいなければ、対応が無いため換算できない
test("AudioClockBridge: 対応を取る前は換算できない", () => {
  const bridge = new AudioClockBridge();
  assert.isNull(bridge.currentOffsetMs);
  assert.isNull(bridge.toAudioSeconds(0));
  assert.isNull(bridge.toPerformanceMs(0));
});

// AudioClockBridge: 対応 (contextTime と performanceTime) から換算し、元の軸へ戻せる。
// 対応が無いときの代用 (currentTime と performance.now の差) とは別の値になる
test("AudioClockBridge: 対応から換算して元の軸へ戻す", () => {
  const bridge = new AudioClockBridge();
  // 対応: AudioContext の 100 秒が performance.now() の 5000 ms である
  bridge.update({ contextTime: 100, performanceTime: 5_000 }, 100, 5_000);
  assert.isFalse(bridge.usingFallback);
  assert.closeTo(valueOf(bridge.currentOffsetMs), 95_000, EPSILON);
  const presentationMs = 5_250;
  const audioSeconds = valueOf(bridge.toAudioSeconds(presentationMs));
  assert.closeTo(audioSeconds, 100.25, EPSILON);
  assert.closeTo(valueOf(bridge.toPerformanceMs(audioSeconds)), presentationMs, EPSILON);
});

// AudioClockBridge: 対応が無い (null) ときは currentTime と performanceNowMs の差で代用し、
// 代用中であることが usingFallback で分かる。対応が取れたら代用をやめる
test("AudioClockBridge: 対応が無いときは currentTime で代用する", () => {
  const bridge = new AudioClockBridge();
  // 代用: AudioContext の 12.5 秒が performance.now() の 4000 ms である
  bridge.update(null, 12.5, 4_000);
  assert.isTrue(bridge.usingFallback);
  assert.closeTo(valueOf(bridge.currentOffsetMs), 8_500, EPSILON);
  assert.closeTo(valueOf(bridge.toAudioSeconds(5_000)), 13.5, EPSILON);
  // 対応が取れると同じ値のまま代用をやめる
  bridge.update({ contextTime: 12.51, performanceTime: 4_010 }, 12.51, 4_010);
  assert.isFalse(bridge.usingFallback);
  assert.closeTo(valueOf(bridge.currentOffsetMs), 8_500, EPSILON);
});

// AudioClockBridge: 直前の値との差が不感帯 (30 ms) 未満なら動かさない。読み取りごとの数 ms の
// 揺れで対応を書き換えると、その分が A/V のずれとして残る
test("AudioClockBridge: 不感帯未満の差では動かない", () => {
  const bridge = new AudioClockBridge();
  bridge.update({ contextTime: 100, performanceTime: 5_000 }, 100, 5_000);
  assert.closeTo(valueOf(bridge.currentOffsetMs), 95_000, EPSILON);
  // 不感帯の半分 (15 ms) だけ動いた対応
  const movedSeconds = 100 + AUDIO_CLOCK_DEADBAND_MS / 2 / 1_000;
  bridge.update({ contextTime: movedSeconds, performanceTime: 5_000 }, movedSeconds, 5_000);
  assert.closeTo(valueOf(bridge.currentOffsetMs), 95_000, EPSILON);
});

// AudioClockBridge: 差が大きくても 1 回の変更は上限 (80 ms) まで。段差のある補正で音が
// 飛ばないようにする。逆向きの差でも同じだけ動く
test("AudioClockBridge: 1 回の変更は上限までにする", () => {
  const bridge = new AudioClockBridge();
  bridge.update({ contextTime: 100, performanceTime: 5_000 }, 100, 5_000);
  // 上限の 10 倍 (800 ms) 動いた対応
  const aheadSeconds = 100 + (AUDIO_CLOCK_MAX_CHANGE_MS * 10) / 1_000;
  bridge.update({ contextTime: aheadSeconds, performanceTime: 5_000 }, aheadSeconds, 5_000);
  assert.closeTo(valueOf(bridge.currentOffsetMs), 95_000 + AUDIO_CLOCK_MAX_CHANGE_MS, EPSILON);
  // 逆向き (オフセットが小さくなる向き) でも同じだけ動く
  const behindSeconds = 100 - (AUDIO_CLOCK_MAX_CHANGE_MS * 10) / 1_000;
  bridge.update({ contextTime: behindSeconds, performanceTime: 5_000 }, behindSeconds, 5_000);
  assert.closeTo(valueOf(bridge.currentOffsetMs), 95_000, EPSILON);
});
