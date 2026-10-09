/**
 * AudioPlayoutScheduler と AudioClockBridge の単体テスト
 *
 * 復号した音声を鳴らす時刻 (AudioContext.currentTime の秒) を決める。目標の時刻 (映像と
 * 共有する時間軸が決めた開始時刻) を守るときは、目標を過ぎて届いた音も前の音と重なる音も
 * 捨てず、今から鳴らせる最も早い時刻へずらして詰める。捨てるのは並べすぎの音だけである。
 * 目標を使わないとき (壁時計の TIMESTAMP を持たない音、音声だけを購読しているとき) は、
 * 到着基準の小さな遅れ (`arrivalDelaySeconds`) で並べる。目標から離れすぎたときも、音が
 * まだ鳴っている (連続している) 間は到着基準へ並べ直さず、遅れたまま鳴らし続ける。並べ直す
 * (媒体時刻を跳ばす) のは、音が本当に途切れたときだけである。AudioClockBridge は
 * AudioContext の時計と performance.now() の対応を保つ。
 *
 * 個々の規則 (目標の上下限、捨てる理由、基準の取り直し、時計の不感帯と変更の上限) を
 * ここで固定する。鳴らす音が重ならない、今 + 余裕以上、遅れは再生の遅れ + 余裕以下という
 * 性質は audioPlayout.prop.ts が固定する。実測のログ相当の入力 (TIMESTAMP の段差) での
 * 受け入れ条件は audioPlayoutFallback.test.ts が固定する。
 */

import { test, assert } from "vite-plus/test";
import {
  AUDIO_CLOCK_DEADBAND_MS,
  AUDIO_CLOCK_MAX_CHANGE_MS,
  AUDIO_PLAYOUT_ARRIVAL_DELAY_SECONDS,
  AUDIO_PLAYOUT_BACKLOG_SECONDS,
  AUDIO_PLAYOUT_CONCEAL_END_GAIN,
  AUDIO_PLAYOUT_DELAY_SECONDS,
  AUDIO_PLAYOUT_MAX_CONCEAL_SECONDS,
  AUDIO_PLAYOUT_MAX_DELAY_SECONDS,
  AUDIO_PLAYOUT_MAX_LATENESS_SECONDS,
  AUDIO_PLAYOUT_MIN_CONCEAL_SECONDS,
  AUDIO_PLAYOUT_MIN_LEAD_SECONDS,
  arrivalPlayoutDelaySeconds,
  AudioClockBridge,
  AudioPlayoutScheduler,
  concealmentEndGain,
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
  return playDecisionOf(decision).startAt;
}

/** 鳴らすと決めた決定を取り出す (捨てると決めたときは失敗にする) */
function playDecisionOf(
  decision: AudioPlayoutDecision,
): Extract<AudioPlayoutDecision, { kind: "play" }> {
  if (decision.kind !== "play") {
    throw new Error(`expected play, got ${decision.kind}`);
  }
  return decision;
}

/**
 * 最初の音 (目標 10 秒) を鳴らし、詰めた分を確定する
 *
 * 隙間を測るテストの下ごしらえ。呼び出し側は実際の再生と同じ順で `confirmStretch` を
 * 呼ぶため、次に並べる音の `lastEnd` が確定する
 */
function playFirst(
  scheduler: AudioPlayoutScheduler,
): Extract<AudioPlayoutDecision, { kind: "play" }> {
  const first = playDecisionOf(scheduler.schedule(10, 0, FRAME_SECONDS, enforcedTarget(10)));
  scheduler.confirmStretch(first.compressSeconds);
  return first;
}

/** 換算した値を取り出す (対応が無くて null のときは失敗にする) */
function valueOf(value: number | null): number {
  if (value === null) {
    throw new Error("expected a value, got null");
  }
  return value;
}

/**
 * 目標を守るとき (映像も購読しているとき) の目標
 *
 * `arrivalSeconds` は到着基準へ並べ直すとき (目標から離れすぎて届き、音が途切れていたとき)
 * だけ使う。到着基準そのものを確かめるテストは、この値を到着の時刻にして明示する
 *
 * @param targetStartSeconds - 目標の開始時刻
 * @param arrivalSeconds - 到着した音がまだ鳴っていない位置。省略すると目標の時刻と同じにする
 */
function enforcedTarget(
  targetStartSeconds: number,
  arrivalSeconds: number = targetStartSeconds,
): AudioPlayoutTarget {
  return {
    targetStartSeconds,
    arrivalSeconds,
    enforceTarget: true,
    delaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
    arrivalDelaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
    presentationDelaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
  };
}

/**
 * 到着基準の並べ方になる 2 つの目標 (どちらも同じ規則で並ぶ)
 *
 * - 目標が無い: 壁時計の TIMESTAMP を持たない音。映像を購読していても目標を作れない
 * - 目標はあるが守らない: 音声だけを購読していて揃える相手がいない。鳴らす時刻を過ぎて
 *   届いた音は基準を取り直して鳴らす (捨てない)
 *
 * 到着基準の並びを決めるのは到着した音がまだ鳴っていない位置 (`arrivalSeconds`) だけであり、
 * 目標の時刻は使わない。引数は `arrivalSeconds` (到着の時刻) にする
 */
const arrivalTargets: {
  label: string;
  /** @param arrivalSeconds - 到着した音がまだ鳴っていない位置 (到着の時刻) */
  make: (arrivalSeconds: number) => AudioPlayoutTarget;
}[] = [
  {
    label: "目標が無い",
    make: (arrivalSeconds) => ({
      targetStartSeconds: null,
      arrivalSeconds,
      enforceTarget: true,
      delaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
      arrivalDelaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
      presentationDelaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
    }),
  },
  {
    label: "目標はあるが守らない",
    make: (arrivalSeconds) => ({
      targetStartSeconds: arrivalSeconds,
      arrivalSeconds,
      enforceTarget: false,
      delaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
      arrivalDelaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
      presentationDelaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
    }),
  },
];

// 既定の値: 再生の遅れ 80 ms、合計の上限 300 ms、並べすぎの余裕 220 ms (300 - 80)、
// 鳴らす時刻の下限 10 ms (描画の 1 単位 128 フレームより大きい)、補間の下限 5 ms と
// 上限 100 ms、時計の不感帯 30 ms、時計の変更の上限 80 ms
test("既定の値: 再生の遅れ、上限、余裕、補間の下限と上限、時計の不感帯と変更の上限", () => {
  assert.equal(AUDIO_PLAYOUT_DELAY_SECONDS, 0.08);
  assert.equal(AUDIO_PLAYOUT_MAX_DELAY_SECONDS, 0.3);
  assert.equal(AUDIO_PLAYOUT_MIN_LEAD_SECONDS, 0.01);
  assert.closeTo(AUDIO_PLAYOUT_BACKLOG_SECONDS, 0.22, EPSILON);
  assert.equal(AUDIO_PLAYOUT_MIN_CONCEAL_SECONDS, 0.005);
  assert.equal(AUDIO_PLAYOUT_MAX_CONCEAL_SECONDS, 0.1);
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

// 目標を守るとき: 目標の時刻を過ぎて届いた音は捨てず、今から鳴らせる最も早い時刻へ
// ずらして鳴らし、ずらした分を波形の周期を使って詰める (NetEq の accelerate と同じ)。
// 取り直すと音声だけが後ろへずれて共有の時間軸を使う映像とずれるため、取り直さない
test("schedule: 目標の時刻を過ぎて届いた音は捨てずに詰めて目標へ戻す", () => {
  const scheduler = new AudioPlayoutScheduler();
  // 目標 10.04 の音が 10.05 に届く (今 + 余裕より前)
  const decision = scheduler.schedule(10.05, 0, FRAME_SECONDS, enforcedTarget(10.04));
  assert.equal(decision.kind, "play", "捨てないこと");
  if (decision.kind !== "play") {
    return;
  }
  const expectedStart = 10.05 + AUDIO_PLAYOUT_MIN_LEAD_SECONDS;
  assert.closeTo(decision.startAt, expectedStart, EPSILON);
  // ずらした分 (今 + 余裕 - 目標 = 20 ms) のうち、音の長さの半分 (10 ms) までを詰める
  const latenessSeconds = expectedStart - 10.04;
  assert.closeTo(scheduler.lateness, latenessSeconds, EPSILON);
  assert.closeTo(decision.compressSeconds, FRAME_SECONDS / 2, EPSILON);
  assert.equal(scheduler.drops, 0);
  assert.equal(scheduler.rebases, 0);
  // 波形しだいで詰められないときは、詰められなかった分が遅れとして残る
  scheduler.confirmStretch(0);
  assert.equal(scheduler.compressed, 0);
  assert.closeTo(scheduler.lateness, latenessSeconds, EPSILON);
});

// 目標を守るとき: 詰めた分だけ遅れが減り、数フレームで目標へ戻る。詰められる量は
// 音の長さの半分までである (1 つの音で詰めすぎない)
test("schedule: 詰めた分だけ遅れが減り、目標へ戻る", () => {
  const scheduler = new AudioPlayoutScheduler();
  // 1 つ目の音は目標を 20 ms 過ぎて届く
  let target = 10.04;
  const first = scheduler.schedule(10.05, 0, FRAME_SECONDS, enforcedTarget(target));
  assert.equal(first.kind, "play");
  if (first.kind !== "play") {
    return;
  }
  assert.closeTo(scheduler.lateness, 0.02, EPSILON);
  scheduler.confirmStretch(first.compressSeconds);
  assert.closeTo(scheduler.compressed, FRAME_SECONDS / 2, EPSILON);
  // 2 つ目は 10 ms の遅れが残る
  target += FRAME_SECONDS;
  const second = scheduler.schedule(
    target - 0.05,
    FRAME_MICROSECONDS,
    FRAME_SECONDS,
    enforcedTarget(target),
  );
  assert.equal(second.kind, "play");
  if (second.kind !== "play") {
    return;
  }
  assert.closeTo(scheduler.lateness, 0.01, EPSILON, "詰めた分だけ遅れが減ること");
  scheduler.confirmStretch(second.compressSeconds);
  // 3 つ目は目標どおりに鳴る
  target += FRAME_SECONDS;
  const third = scheduler.schedule(
    target - 0.05,
    2 * FRAME_MICROSECONDS,
    FRAME_SECONDS,
    enforcedTarget(target),
  );
  assert.equal(third.kind, "play");
  if (third.kind !== "play") {
    return;
  }
  assert.closeTo(scheduler.lateness, 0, EPSILON, "目標へ戻ること");
  assert.closeTo(third.startAt, target, EPSILON);
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
  const dropped = beyond.schedule(nowSeconds, 0, FRAME_SECONDS, enforcedTarget(outside));
  assert.equal(dropped.kind, "drop");
  // 観測値でどちらの理由で捨てたかを分けて数えるため、並べすぎは backlog として返す
  if (dropped.kind === "drop") {
    assert.equal(dropped.reason, "backlog");
  }
  assert.equal(beyond.drops, 1);
  assert.equal(beyond.rebases, 0);
});

// 目標から離れすぎて届いた音でも、音がまだ鳴っている (連続している) 間は捨てないし、
// 到着基準へも並べ直さない。鳴らせる最も早い時刻 (前の音の終わり) に繋げて鳴らし、順序と
// 連続性を保つ。並べ直すと媒体時刻が跳び、鳴っている音の続きが前へずれる。
// 実測では、音声の TIMESTAMP が 600 ms 段差でずれた直後に並べ直しが続けて起き (段差入力を
// 模した audioPlayoutFallback.test.ts では 9 回)、到着から鳴り始めるまでの時間が 178 ms に
// 膨らんでいた (並べ直しのたびに余分な遅れが積み上がるため)
test("schedule: 目標から離れすぎて届いた音も、音が続いている間は並べ直さずに鳴らす", () => {
  const scheduler = new AudioPlayoutScheduler();
  // 到着基準へ並べ直すときに使う、小さな再生の遅れを渡しておく (並べ直さないことを確かめる)
  const target = (targetStartSeconds: number): AudioPlayoutTarget => ({
    ...enforcedTarget(targetStartSeconds),
    arrivalDelaySeconds: AUDIO_PLAYOUT_ARRIVAL_DELAY_SECONDS,
  });
  // 直前の音は今 (10.02) より後 (10.07) まで鳴っている
  startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, target(10.05)));
  // 目標は 600 ms 前に過ぎている。今から鳴らせる最も早い時刻へずらしても
  // 上限 (AUDIO_PLAYOUT_MAX_LATENESS_SECONDS = 500 ms) を超える
  const decision = playDecisionOf(
    scheduler.schedule(10.02, FRAME_MICROSECONDS, FRAME_SECONDS, target(9.42)),
  );
  assert.equal(decision.basis, "timestamp", "到着基準へ並べ直さないこと");
  assert.closeTo(
    decision.startAt,
    10.05 + FRAME_SECONDS,
    EPSILON,
    "前の音の終わりに繋げて鳴らすこと",
  );
  assert.equal(scheduler.drops, 0, "捨てないこと");
  assert.equal(scheduler.rebases, 0, "基準を取り直さないこと");
  // 遅れは残る。詰められる分 (音の長さの半分) だけ詰めて目標へ近づける
  assert.isAbove(scheduler.lateness, AUDIO_PLAYOUT_MAX_LATENESS_SECONDS, "遅れは残ること");
  assert.closeTo(decision.compressSeconds, FRAME_SECONDS / 2, EPSILON);
  // 実際の再生と同じ順で、詰めた分を確定する (確定しないと、前の音の終わりが詰めた分だけ
  // 後ろへ伸びたものとして扱われる)
  scheduler.confirmStretch(decision.compressSeconds);
  // 次の音も鳴る (順序と連続性を保つ)
  const next = playDecisionOf(
    scheduler.schedule(10.04, 2 * FRAME_MICROSECONDS, FRAME_SECONDS, target(9.44)),
  );
  assert.equal(next.basis, "timestamp");
  assert.closeTo(
    next.startAt,
    decision.startAt + FRAME_SECONDS / 2,
    EPSILON,
    "詰めた分だけ早まった前の音の終わりに繋がること",
  );
  assert.equal(scheduler.drops, 0);
  assert.equal(scheduler.rebases, 0);
});

// 音が途切れていたとき (経路の停止など) は、キューが空であるため到着基準へ並べ直す。
// 予定 (TIMESTAMP から決まる時刻) の方が過去にずれているだけであり、待っても予定は
// 現在へ戻らない。捨てると語尾が切れるため、鳴らす方を選ぶ
test("schedule: 目標から離れすぎて届き、音が途切れていた音は到着基準へ並べ直して鳴らす", () => {
  const scheduler = new AudioPlayoutScheduler();
  // 直前の音は 2 秒前に鳴り終わっている (経路が止まっていた)
  startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, enforcedTarget(10.05)));
  const decision = playDecisionOf(
    scheduler.schedule(12, FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(11.4, 12)),
  );
  assert.equal(decision.basis, "arrival", "到着基準へ並べ直すこと");
  assert.closeTo(decision.startAt, 12 + AUDIO_PLAYOUT_DELAY_SECONDS, EPSILON);
  assert.equal(scheduler.drops, 0, "捨てないこと");
  assert.equal(scheduler.rebases, 1, "基準を取り直すこと");
  // 並べ直した後は、その続きから鳴る (重ならない)
  const next = playDecisionOf(
    scheduler.schedule(12.02, 2 * FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(11.42, 12.02)),
  );
  assert.closeTo(next.startAt, decision.startAt + FRAME_SECONDS, EPSILON);
  assert.equal(scheduler.drops, 0);
});

// 経路の停止が終わった後も、鳴らす方へ戻る。停止中は鳴らさなかった音を捨て続けると
// 音が永久に途切れるため、停止後の最初の音を到着基準で並べ直し、目標が今の近くに
// 戻ったら目標の時刻どおりに鳴らす
test("schedule: 経路が止まった後は到着基準で並べ直し、目標が戻れば目標どおりに鳴る", () => {
  const scheduler = new AudioPlayoutScheduler();
  startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, enforcedTarget(10.05)));
  // 2 秒後に届いた、目標より 600 ms 遅れた音は、到着基準へ並べ直して鳴らす
  const rebased = playDecisionOf(
    scheduler.schedule(12, FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(11.4, 12)),
  );
  assert.equal(rebased.basis, "arrival");
  assert.equal(scheduler.drops, 0, "捨てないこと");
  // 続けて届く遅れた音も鳴る (前の音の終わりに繋げる)。無音にならないこと
  const stillLate = playDecisionOf(
    scheduler.schedule(12.02, 2 * FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(11.42, 12.02)),
  );
  assert.closeTo(
    stillLate.startAt,
    rebased.startAt + FRAME_SECONDS,
    EPSILON,
    "並べ直した続きから鳴ること",
  );
  assert.equal(scheduler.drops, 0);
  // 目標が今の近くに戻ったら、目標の時刻どおりに鳴らす
  const recovered = playDecisionOf(
    scheduler.schedule(13, 3 * FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(13.1)),
  );
  assert.equal(recovered.basis, "timestamp");
  assert.closeTo(recovered.startAt, 13.1, EPSILON);
});

// 目標を守るとき: 前の音と重なる音は捨てず、前の音の終わりに繋げて鳴らす (重ねない)。
// 繋げた分は遅れとして数え、波形の周期を使って詰めることで目標へ戻す
test("schedule: 前の音と重なる音は前の音の終わりに繋げて鳴らす", () => {
  const scheduler = new AudioPlayoutScheduler();
  const first = startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, enforcedTarget(10.08)));
  const endOfFirst = first + FRAME_SECONDS;
  // 前の音の終わり (10.10) の 1 フレーム前の目標
  const overlapped = scheduler.schedule(
    10.05,
    FRAME_MICROSECONDS,
    FRAME_SECONDS,
    enforcedTarget(endOfFirst - FRAME_SECONDS),
  );
  assert.equal(overlapped.kind, "play", "捨てないこと");
  if (overlapped.kind !== "play") {
    return;
  }
  assert.closeTo(overlapped.startAt, endOfFirst, EPSILON, "前の音の終わりに繋げること");
  assert.closeTo(scheduler.lateness, FRAME_SECONDS, EPSILON, "繋げた分が遅れになること");
  assert.closeTo(
    overlapped.compressSeconds,
    FRAME_SECONDS / 2,
    EPSILON,
    "遅れの半分まで詰めること",
  );
  assert.equal(scheduler.drops, 0);
  assert.equal(scheduler.rebases, 0);
  // 3 つ目も鳴る。前の音は詰められているため、その終わり以降に繋がる
  const third = startAtOf(
    scheduler.schedule(10.05, 2 * FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(endOfFirst)),
  );
  assert.isAtLeast(third, endOfFirst);
  assert.equal(scheduler.drops, 0);
});

// 目標を守るとき: 目標の間隔と音の長さが同じとき (Opus の 20 ms を 20 ms ごとに並べるとき)、
// 目標の開始時刻は浮動小数点の誤差 (10^-13 秒程度) で前の音の終わりよりわずかに前に出る。
// これを重なりとみなして捨てると、音が 1 つおきに欠けるため、前の音の終わりに繋げて鳴らす
test("schedule: 浮動小数点の誤差の分の重なりは捨てずに繋げて鳴らす", () => {
  const scheduler = new AudioPlayoutScheduler();
  // 実測と同じ形の値 (目標の間隔が 20 ms ちょうどになる)。値は実測から取り、倍精度で
  // 表せる範囲に丸める (丸めは目標の間隔には影響しない)
  const timeOrigin = 1_790_779_578_123;
  const offsetMs = -8_029.1;
  const delayMs = 117.2;
  let played = 0;
  for (let index = 0; index < 10; index++) {
    const timestampMicroseconds = 1_790_779_753_000_700 + 20_000 * index;
    const wallClockMicros = BigInt(Math.round(timestampMicroseconds + delayMs * 1_000));
    const presentationMs = Number(wallClockMicros) / 1_000 - timeOrigin;
    const targetSeconds = (presentationMs + offsetMs) / 1_000;
    const decision = scheduler.schedule(
      // 復号の出力は目標の 50 ms 前 (余裕 10 ms より後、並べすぎの上限より前)
      targetSeconds - 0.05,
      timestampMicroseconds,
      FRAME_SECONDS,
      enforcedTarget(targetSeconds),
    );
    assert.equal(decision.kind, "play", `${index} 番目の音を捨てないこと`);
    played += 1;
  }
  assert.equal(played, 10);
  assert.equal(scheduler.drops, 0);
});

// 目標を守るとき: 基準がわずかに前に動いた分の重なりは、前の音の終わりに繋げて鳴らす
test("schedule: わずかな重なりは前の音の終わりに繋げる", () => {
  const scheduler = new AudioPlayoutScheduler();
  const first = startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, enforcedTarget(10.08)));
  const endOfFirst = first + FRAME_SECONDS;
  const decision = scheduler.schedule(
    10.05,
    FRAME_MICROSECONDS,
    FRAME_SECONDS,
    enforcedTarget(endOfFirst - 0.003),
  );
  assert.equal(decision.kind, "play");
  assert.closeTo(startAtOf(decision), endOfFirst, EPSILON);
  assert.equal(scheduler.drops, 0);
});

// 目標を守るとき: 遅れて届いた音も鳴り、詰めた分だけ次の音が目標へ戻る (遅れが連鎖しない)
test("schedule: 遅れて届いた音も鳴り、次の音は目標へ戻る", () => {
  const scheduler = new AudioPlayoutScheduler();
  startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, enforcedTarget(10.08)));
  // 目標 10.10 の音が 10.10 に届く (今 + 余裕より前 = 目標を過ぎている)
  const late = scheduler.schedule(10.1, FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(10.1));
  assert.equal(late.kind, "play", "捨てないこと");
  if (late.kind !== "play") {
    return;
  }
  assert.closeTo(late.startAt, 10.11, EPSILON);
  scheduler.confirmStretch(late.compressSeconds);
  // 次の音は詰めた分だけ前の音の終わりが早くなり、目標どおりに鳴る
  assert.closeTo(
    startAtOf(
      scheduler.schedule(10.1, 2 * FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(10.12)),
    ),
    10.12,
    EPSILON,
  );
  assert.equal(scheduler.drops, 0);
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
    const startAt = startAtOf(scheduler.schedule(10, 1_000_000, FRAME_SECONDS, make(10)));
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
      startAtOf(scheduler.schedule(now, index * FRAME_MICROSECONDS, FRAME_SECONDS, make(now))),
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

// 目標を使わないとき: 音が抜けたときは、その分の隙間を補間の対象として返し、後の音の
// 時刻は timestamp の間隔どおりに保つ
test("schedule: 目標を使わないときは音が抜けた分の隙間を返す", () => {
  for (const { label, make } of arrivalTargets) {
    const scheduler = new AudioPlayoutScheduler();
    const first = playDecisionOf(scheduler.schedule(10, 0, FRAME_SECONDS, make(10)));
    // 20 ms の音が 1 つ抜けて、40 ms 後の音が届く
    const third = playDecisionOf(
      scheduler.schedule(10.04, 2 * FRAME_MICROSECONDS, FRAME_SECONDS, make(10.04)),
    );
    assert.closeTo(third.startAt - first.startAt, 2 * FRAME_SECONDS, EPSILON, label);
    assert.closeTo(third.gapStartSeconds, first.startAt + FRAME_SECONDS, EPSILON, label);
    assert.closeTo(third.gapSeconds, FRAME_SECONDS, EPSILON, label);
    scheduler.confirmConcealment(third.gapSeconds);
    assert.equal(scheduler.concealments, 1, label);
    assert.closeTo(scheduler.concealed, FRAME_SECONDS, EPSILON, label);
  }
});

// 目標を守るとき: 前の音の終わりと次の音の開始の間に空いた分を補間の対象として返す
test("schedule: 目標を守るときは空いた隙間を補間の対象として返す", () => {
  const scheduler = new AudioPlayoutScheduler();
  const first = playFirst(scheduler);
  assert.equal(first.gapSeconds, 0, "最初の音には隙間が無い");
  // 40 ms 後の timestamp の音が、前の音の終わりより 40 ms 先の目標で届く
  const second = playDecisionOf(
    scheduler.schedule(10, 2 * FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(10.06)),
  );
  assert.closeTo(
    second.gapStartSeconds,
    first.startAt + FRAME_SECONDS - first.compressSeconds,
    EPSILON,
  );
  assert.closeTo(second.gapSeconds, 2 * FRAME_SECONDS, EPSILON);
  scheduler.confirmConcealment(second.gapSeconds);
  assert.equal(scheduler.concealments, 1);
  assert.closeTo(scheduler.concealed, 2 * FRAME_SECONDS, EPSILON);
});

// 補間する長さは上限 (100 ms) で切る。超えた分は無音のまま残す
test("schedule: 補間する隙間は上限で切る", () => {
  const scheduler = new AudioPlayoutScheduler();
  const first = playFirst(scheduler);
  const second = playDecisionOf(
    scheduler.schedule(10, FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(first.startAt + 0.2)),
  );
  assert.closeTo(
    second.gapStartSeconds,
    first.startAt + FRAME_SECONDS - first.compressSeconds,
    EPSILON,
  );
  assert.equal(second.gapSeconds, AUDIO_PLAYOUT_MAX_CONCEAL_SECONDS);
});

// 5 ms 以下の隙間は補間しない (継ぎ目が耳につく)。隙間の情報も返さない
test("schedule: 5 ms 以下の隙間は補間しない", () => {
  const scheduler = new AudioPlayoutScheduler();
  const first = playFirst(scheduler);
  const second = playDecisionOf(
    scheduler.schedule(
      10,
      FRAME_MICROSECONDS,
      FRAME_SECONDS,
      enforcedTarget(first.startAt + FRAME_SECONDS - first.compressSeconds + 0.004),
    ),
  );
  assert.equal(second.gapSeconds, 0);
  assert.equal(second.gapStartSeconds, 0);
  assert.equal(scheduler.concealments, 0);
});

// 隙間がちょうど下限 (5 ms) なら補間しない (境界)。前の音の終わりを 0 にするため
// duration 0 の音を使い、計算誤差の無い引き算で下限ちょうどを作る
test("schedule: 隙間がちょうど下限なら補間しない", () => {
  const scheduler = new AudioPlayoutScheduler({ minLeadSeconds: 0 });
  assert.equal(scheduler.schedule(0, 0, 0, enforcedTarget(0)).kind, "play");
  const second = playDecisionOf(
    scheduler.schedule(
      0,
      FRAME_MICROSECONDS,
      FRAME_SECONDS,
      enforcedTarget(AUDIO_PLAYOUT_MIN_CONCEAL_SECONDS),
    ),
  );
  assert.equal(second.gapSeconds, 0);
  assert.equal(second.gapStartSeconds, 0);
});

// 下限のすぐ上 (6 ms) の隙間は補間する
test("schedule: 下限のすぐ上の隙間は補間する", () => {
  const scheduler = new AudioPlayoutScheduler();
  const first = playFirst(scheduler);
  const previousEnd = first.startAt + FRAME_SECONDS - first.compressSeconds;
  const second = playDecisionOf(
    scheduler.schedule(10, FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(previousEnd + 0.006)),
  );
  assert.closeTo(second.gapSeconds, 0.006, EPSILON);
  assert.closeTo(second.gapStartSeconds, previousEnd, EPSILON);
});

// 隙間の開始が今 + 余裕より前なら予約できないため補間しない
test("schedule: 隙間の開始が今 + 余裕より前なら補間しない", () => {
  const scheduler = new AudioPlayoutScheduler();
  playFirst(scheduler);
  // 前の音の終わり (10.02) が今 + 余裕 (10.015 + 0.01 = 10.025) より前になる
  const second = playDecisionOf(
    scheduler.schedule(10.015, FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(10.05)),
  );
  assert.equal(second.gapSeconds, 0);
  assert.equal(second.gapStartSeconds, 0);
  assert.isAtLeast(second.startAt - 10.015, AUDIO_PLAYOUT_MIN_LEAD_SECONDS - EPSILON);
});

// 補間の統計: 実際に補間できた長さだけを数える。要求より多ければ要求までに切る
test("confirmConcealment: 実際に補間した長さだけを数える", () => {
  const scheduler = new AudioPlayoutScheduler();
  playFirst(scheduler);
  const second = playDecisionOf(
    scheduler.schedule(10, FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(10.06)),
  );
  // 要求より少なくしか補間できなかった
  scheduler.confirmConcealment(second.gapSeconds / 2);
  assert.equal(scheduler.concealments, 1);
  assert.closeTo(scheduler.concealed, second.gapSeconds / 2, EPSILON);
  // 要求より多く返しても要求までに切る
  const third = playDecisionOf(
    scheduler.schedule(10.02, 2 * FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(10.12)),
  );
  scheduler.confirmConcealment(third.gapSeconds * 2);
  assert.equal(scheduler.concealments, 2);
  assert.closeTo(scheduler.concealed, second.gapSeconds / 2 + third.gapSeconds, EPSILON);
});

// 補間の統計: 要求が無いときは数えない
test("confirmConcealment: 要求が無いときは数えない", () => {
  const scheduler = new AudioPlayoutScheduler();
  scheduler.confirmConcealment(0.05);
  assert.equal(scheduler.concealments, 0);
  assert.equal(scheduler.concealed, 0);
  // 隙間が無い音のあとに確認しても数えない
  playFirst(scheduler);
  playDecisionOf(
    scheduler.schedule(10.01, FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(10.02)),
  );
  scheduler.confirmConcealment(0.05);
  assert.equal(scheduler.concealments, 0);
});

// 補間の統計: 確認せずに次の音へ進むと、前の要求は適用されなかったものとして消える
test("confirmConcealment: 確認しなかった要求は次で消える", () => {
  const scheduler = new AudioPlayoutScheduler();
  playFirst(scheduler);
  const second = playDecisionOf(
    scheduler.schedule(10, FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(10.06)),
  );
  assert.isAbove(second.gapSeconds, 0);
  // 確認せずに、隙間の無い次の音を並べる
  playDecisionOf(scheduler.schedule(10.03, 0, FRAME_SECONDS, enforcedTarget(10.08)));
  scheduler.confirmConcealment(second.gapSeconds);
  assert.equal(scheduler.concealments, 0);
});

// 隙間の開始が今 + 余裕ちょうどなら補間する (境界)
test("schedule: 隙間の開始が今 + 余裕ちょうどなら補間する", () => {
  const scheduler = new AudioPlayoutScheduler();
  const first = playFirst(scheduler);
  // 前の音の終わり (10.02) が今 + 余裕 (10.01 + 0.01) と同じになる
  const second = playDecisionOf(
    scheduler.schedule(10.01, FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(10.06)),
  );
  assert.closeTo(
    second.gapStartSeconds,
    first.startAt + FRAME_SECONDS - first.compressSeconds,
    1e-9,
  );
  assert.closeTo(second.gapSeconds, 2 * FRAME_SECONDS, 1e-9);
});

// 隙間がちょうど上限 (100 ms) なら切らずに補間する (境界)
test("schedule: 隙間がちょうど上限なら切らずに補間する", () => {
  const scheduler = new AudioPlayoutScheduler();
  const first = playFirst(scheduler);
  const previousEnd = first.startAt + FRAME_SECONDS - first.compressSeconds;
  const second = playDecisionOf(
    scheduler.schedule(10, FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(previousEnd + 0.1)),
  );
  // 浮動小数点の誤差はあるが上限で切られていない
  assert.closeTo(second.gapSeconds, AUDIO_PLAYOUT_MAX_CONCEAL_SECONDS, EPSILON);
  assert.isAbove(second.gapSeconds, AUDIO_PLAYOUT_MAX_CONCEAL_SECONDS - EPSILON);
});

// 捨てた音の後は、最後に鳴った音の終わりから次の音までの隙間を補間する
test("schedule: 捨てた音の後も最後に鳴った音から隙間を測る", () => {
  const scheduler = new AudioPlayoutScheduler();
  const first = playFirst(scheduler);
  // 並べすぎの音は捨てる (lastEnd は据え置き)
  assert.equal(
    scheduler.schedule(10, FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(10.5)).kind,
    "drop",
  );
  const third = playDecisionOf(
    scheduler.schedule(10.01, 2 * FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(10.06)),
  );
  assert.closeTo(
    third.gapStartSeconds,
    first.startAt + FRAME_SECONDS - first.compressSeconds,
    1e-9,
  );
  assert.closeTo(third.gapSeconds, 2 * FRAME_SECONDS, 1e-9);
});

// 補間の減衰: 隙間が長いほど末尾の振幅を下げ、上限で `AUDIO_PLAYOUT_CONCEAL_END_GAIN` になる
test("concealmentEndGain: 隙間が長いほど末尾の振幅を下げる", () => {
  assert.equal(concealmentEndGain(0), 1);
  assert.closeTo(
    concealmentEndGain(AUDIO_PLAYOUT_MAX_CONCEAL_SECONDS / 2),
    (1 + AUDIO_PLAYOUT_CONCEAL_END_GAIN) / 2,
    EPSILON,
  );
  assert.equal(
    concealmentEndGain(AUDIO_PLAYOUT_MAX_CONCEAL_SECONDS),
    AUDIO_PLAYOUT_CONCEAL_END_GAIN,
  );
  // 上限を超えても下げすぎない
  assert.equal(concealmentEndGain(1), AUDIO_PLAYOUT_CONCEAL_END_GAIN);
});

// 目標を使わないとき: 過ぎてから届いた音は捨てずに基準を取り直して鳴らす。揃える相手が
// いない (または目標を作れない) ため音の連続性を優先する (目標を守るときは今から鳴らせる
// 最も早い時刻へずらして詰める)
test("schedule: 目標を使わないときは過ぎてから届いた音で基準を取り直す", () => {
  for (const { label, make } of arrivalTargets) {
    const scheduler = new AudioPlayoutScheduler();
    startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, make(10)));
    // 2 つ目の音は 10.10 に鳴らすはずが、10.2 に届く (目標 10.05 はとっくに過ぎている)
    const late = startAtOf(scheduler.schedule(10.2, FRAME_MICROSECONDS, FRAME_SECONDS, make(10.2)));
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
    arrivalSeconds: 10,
    enforceTarget: true,
    delaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
    arrivalDelaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
    presentationDelaySeconds: AUDIO_PLAYOUT_MAX_DELAY_SECONDS + 0.2,
  };
  const decision = scheduler.schedule(10, 0, FRAME_SECONDS, target);
  assert.deepEqual(decision, {
    kind: "play",
    startAt: 10.5,
    basis: "timestamp",
    compressSeconds: 0,
    gapStartSeconds: 0,
    gapSeconds: 0,
  });
  assert.equal(scheduler.drops, 0);
});

// 目標を使わないときの再生の遅れは arrivalDelaySeconds から受け取る。共有の時間軸が学習
// した delaySeconds は TIMESTAMP のずれで大きく育つため、到着基準では使わない
// (呼び出し側が arrivalPlayoutDelaySeconds で上限を掛けた値を渡す)
test("schedule: 目標を使わないときの再生の遅れは arrivalDelaySeconds から受け取る", () => {
  // 学習した再生の遅れは上限 (300 ms) まで育っているが、到着基準では小さな値を使う
  const delaySeconds = AUDIO_PLAYOUT_MAX_DELAY_SECONDS;
  const arrivalDelaySeconds = AUDIO_PLAYOUT_ARRIVAL_DELAY_SECONDS;
  // 到着した音がまだ鳴っていない位置は、その音が届いた時刻である
  const targetAt = (arrivalSeconds: number): AudioPlayoutTarget => ({
    targetStartSeconds: null,
    arrivalSeconds,
    enforceTarget: false,
    delaySeconds,
    arrivalDelaySeconds,
    presentationDelaySeconds: delaySeconds,
  });
  const scheduler = new AudioPlayoutScheduler();
  assert.closeTo(
    startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, targetAt(10))),
    10 + arrivalDelaySeconds,
    EPSILON,
    "学習した遅れではなく到着基準の遅れで並べること",
  );
  // 過ぎてから届いたときの取り直し先も、到着基準の再生の遅れになる
  const late = startAtOf(scheduler.schedule(20, FRAME_MICROSECONDS, FRAME_SECONDS, targetAt(20)));
  assert.closeTo(late, 20 + arrivalDelaySeconds, EPSILON);
  assert.equal(scheduler.rebases, 1);
});

// 到着基準の再生の遅れ: 学習した遅れを上限 (100 ms) で切り、下限 (80 ms) で持ち上げる。
// ずれの分だけ育った学習値 (316〜500 ms) をそのまま使うと、その分だけ音が遅れて鳴る
test("arrivalPlayoutDelaySeconds: 学習した遅れを小さな上限で切る", () => {
  assert.equal(AUDIO_PLAYOUT_ARRIVAL_DELAY_SECONDS, 0.1);
  // ずれの分だけ育った学習値でも、到着基準では上限まで
  assert.equal(arrivalPlayoutDelaySeconds(AUDIO_PLAYOUT_MAX_DELAY_SECONDS), 0.1);
  assert.equal(arrivalPlayoutDelaySeconds(0.316), 0.1);
  assert.equal(arrivalPlayoutDelaySeconds(0.1), 0.1);
  // 学習値が小さいときは、既存の下限 (80 ms) を使う
  assert.equal(arrivalPlayoutDelaySeconds(0.02), AUDIO_PLAYOUT_DELAY_SECONDS);
  assert.equal(
    arrivalPlayoutDelaySeconds(AUDIO_PLAYOUT_DELAY_SECONDS),
    AUDIO_PLAYOUT_DELAY_SECONDS,
  );
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

// reset: 再生の統計 (取り直し / 捨て / 補間 / 詰め) は消えず、今の遅れだけ 0 に戻る
test("reset: 再生の統計は消えず、今の遅れだけ 0 に戻る", () => {
  const scheduler = new AudioPlayoutScheduler();
  const first = playFirst(scheduler);
  // 40 ms 空けた音で補間を作る
  const second = playDecisionOf(
    scheduler.schedule(10, FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(10.06)),
  );
  scheduler.confirmConcealment(second.gapSeconds);
  // 目標を使わない並べ方で、過ぎてから届いた音の基準を取り直す
  const arrivalTargetAt = (arrivalSeconds: number): AudioPlayoutTarget => ({
    targetStartSeconds: null,
    arrivalSeconds,
    enforceTarget: false,
    delaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
    arrivalDelaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
    presentationDelaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
  });
  scheduler.schedule(100, 0, FRAME_SECONDS, arrivalTargetAt(100));
  scheduler.schedule(200, FRAME_MICROSECONDS, FRAME_SECONDS, arrivalTargetAt(200));
  // 並べすぎの音を捨てる
  scheduler.schedule(300, 0, FRAME_SECONDS, enforcedTarget(300.5));
  // 目標を過ぎて届いた音で今の遅れと詰めを作る
  const late = playDecisionOf(
    scheduler.schedule(300.6, 2 * FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(300.5)),
  );
  assert.isAbove(late.compressSeconds, 0);
  assert.isAbove(scheduler.lateness, 0);
  scheduler.confirmStretch(late.compressSeconds);
  assert.equal(scheduler.rebases, 1);
  assert.equal(scheduler.drops, 1);
  scheduler.reset();
  assert.equal(scheduler.lateness, 0);
  assert.equal(scheduler.rebases, 1);
  assert.equal(scheduler.drops, 1);
  assert.equal(scheduler.concealments, 1);
  assert.closeTo(scheduler.concealed, second.gapSeconds, EPSILON);
  assert.closeTo(scheduler.compressed, first.compressSeconds + late.compressSeconds, EPSILON);
});

// reset: 目標を守るときも、前の音の重なりの判定を消す (購読のやり直しで前の音の記録が
// 消えるため、消した後に届いた音は重ならない)
test("reset: 目標を守るときも前の音の重なりの判定を消す", () => {
  const scheduler = new AudioPlayoutScheduler();
  const first = startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, enforcedTarget(10.08)));
  const overlapped = first + FRAME_SECONDS / 2;
  // 前の音と重なる音は、前の音の終わりに繋げて鳴らす (遅れとして詰める)
  const played = scheduler.schedule(
    10.05,
    FRAME_MICROSECONDS,
    FRAME_SECONDS,
    enforcedTarget(overlapped),
  );
  assert.equal(played.kind, "play");
  if (played.kind !== "play") {
    return;
  }
  assert.isAbove(scheduler.lateness, 0, "重なった分が遅れになること");
  scheduler.reset();
  assert.equal(scheduler.lateness, 0, "遅れも消えること");
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
  // 同じ目標でも、既定の下限 (10 ms) なら目標を過ぎているため、遅れとして詰める
  const defaultMinLead = new AudioPlayoutScheduler();
  const lateDecision = defaultMinLead.schedule(
    10,
    0,
    FRAME_SECONDS,
    enforcedTarget(10 + minLeadSeconds),
  );
  assert.equal(lateDecision.kind, "play");
  if (lateDecision.kind === "play") {
    assert.isAbove(lateDecision.compressSeconds, 0, "遅れを詰めること");
  }
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

// AudioClockBridge: reset で対応と代用の印を消し、次の予約で取り直す (影響は reset の
// JSDoc を参照)
test("AudioClockBridge: reset で対応と代用の印を消す", () => {
  const bridge = new AudioClockBridge();
  // 代用 (currentTime と performance.now の差) で対応を作る
  bridge.update(null, 12.5, 4_000);
  assert.isTrue(bridge.usingFallback);
  assert.isNotNull(bridge.currentOffsetMs);

  bridge.reset();

  // 対応が無くなり、換算もできなくなること
  assert.isNull(bridge.currentOffsetMs);
  assert.isFalse(bridge.usingFallback);
  assert.isNull(bridge.toAudioSeconds(5_000));
  assert.isNull(bridge.toPerformanceMs(12.5));

  // 次の予約で取り直すこと (古い対応との差の補正を待たない)
  bridge.update({ contextTime: 500, performanceTime: 400_000 }, 500, 400_000);
  assert.isFalse(bridge.usingFallback);
  assert.closeTo(valueOf(bridge.currentOffsetMs), 100_000, EPSILON);
  assert.closeTo(valueOf(bridge.toAudioSeconds(401_000)), 501, EPSILON);
});
