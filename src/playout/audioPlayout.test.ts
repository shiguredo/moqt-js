/**
 * AudioPlayoutScheduler と AudioClockBridge の単体テスト
 *
 * 復号した音声を鳴らす時刻 (AudioContext.currentTime の秒) を決める。目標の時刻 (映像と
 * 共有する時間軸が決めた開始時刻) を守るときは、目標を過ぎて届いた音も前の音と重なる音も
 * 捨てず、今から鳴らせる最も早い時刻へずらして詰める。詰める量は「遅れ」「音の長さの
 * 半分」「キューの余裕 (直前の音の終わり − (今 + 余裕))」の最小値であり、キューが下限まで
 * 使い切られている (出力のバッファが下限を決めている) ときは詰めない。詰めても次の音の
 * 下限は実時間と同じ速さで進むため遅れは減らず、削った分が無音の穴になるためである。
 * 捨てるのは並べすぎの音だけである。
 * 目標を使わないとき (壁時計の TIMESTAMP を持たない音、音声だけを購読しているとき) は、
 * 到着基準の小さな遅れ (`arrivalDelaySeconds`) で並べる。目標から離れすぎたときも、音が
 * まだ鳴っている (連続している) 間は到着基準へ並べ直さず、遅れたまま鳴らし続ける。並べ直す
 * (媒体時刻を跳ばす) のは、音が本当に途切れたときだけである。AudioClockBridge は
 * AudioContext の時計と performance.now() の対応を保つ。
 *
 * 個々の規則 (目標の上下限、捨てる理由、基準の取り直し、詰める量の上限、時計の不感帯と
 * 変更の上限) をここで固定する。鳴らす音が重ならない、今 + 余裕以上、遅れは再生の遅れ +
 * 余裕以下、詰める量がキューの余裕を超えないという性質は audioPlayout.prop.ts が固定する。
 * 実測のログ相当の入力 (TIMESTAMP の段差) での受け入れ条件は audioPlayoutFallback.test.ts が
 * 固定する。
 */

import { test, assert } from "vite-plus/test";
import { compressSamples } from "./audioTimeStretch";
import {
  AUDIO_CLOCK_DEADBAND_MS,
  AUDIO_CLOCK_MAX_CHANGE_MS,
  AUDIO_CLOCK_STALL_MS,
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

test("confirmPlayoutEnd: サンプルへの丸めで早く終わる音の次にも隙間を残さない", () => {
  const scheduler = new AudioPlayoutScheduler();
  const first = startAtOf(scheduler.schedule(0, 0, FRAME_SECONDS, arrivalTarget(0)));
  scheduler.confirmPlayoutEnd(first + FRAME_SECONDS - 0.000008);
  const next = startAtOf(
    scheduler.schedule(0, FRAME_MICROSECONDS, FRAME_SECONDS, arrivalTarget(0)),
  );
  assert.closeTo(
    next,
    first + FRAME_SECONDS - 0.000008,
    EPSILON,
    "実際の前の音の終わりから続けること",
  );
});

test("schedule: 到着が遅れた音を再び目標の深さだけ待たせない", () => {
  const scheduler = new AudioPlayoutScheduler();
  const target = { ...arrivalTarget(0), arrivalDelaySeconds: 0.05 };
  scheduler.schedule(0, 0, FRAME_SECONDS, target);
  const decision = scheduler.schedule(0.11, 20_000, FRAME_SECONDS, {
    ...target,
    arrivalSeconds: 0.1,
  });
  assert.closeTo(
    startAtOf(decision),
    0.11 + AUDIO_PLAYOUT_MIN_LEAD_SECONDS,
    EPSILON,
    "既に遅れた音は予約できる最も早い時刻に置き、さらに 50 ms の待ちを足さないこと",
  );
});

// 一度の到着の停滞で基準を後ろへ動かしても、回復後まで遅延を残さない。
// 実際の周期圧縮の結果を返し、圧縮を要求しただけで回復したことにしない。
test("schedule: 到着基準でも停滞後の余分な遅延を音を捨てずに回復する", () => {
  const scheduler = new AudioPlayoutScheduler();
  const samples = Float32Array.from(
    { length: 960 },
    (_, index) => 0.3 * Math.sin((2 * Math.PI * 200 * index) / 48000),
  );
  let finalDelaySeconds = 0;
  let gapsAfterRecovery = 0;
  for (let index = 0; index < 300; index++) {
    const mediaSeconds = 10 + index * FRAME_SECONDS;
    const arrivalSeconds = index >= 50 && index < 59 ? 11.18 : mediaSeconds;
    const decision = playDecisionOf(
      scheduler.schedule(arrivalSeconds + 0.03, index * FRAME_MICROSECONDS, FRAME_SECONDS, {
        targetStartSeconds: null,
        enforceTarget: false,
        arrivalSeconds,
        delaySeconds: 0.14,
        arrivalDelaySeconds: 0.14,
        presentationDelaySeconds: 0.14,
      }),
    );
    const compressed = compressSamples(
      [samples],
      48000,
      Math.round(decision.compressSeconds * 48000),
    );
    scheduler.confirmStretch(-compressed.lengthChangeSamples / 48000);
    finalDelaySeconds = decision.startAt - arrivalSeconds;
    if (index > 59 && decision.totalGapSeconds > EPSILON) gapsAfterRecovery++;
  }
  assert.isAtMost(finalDelaySeconds, 0.16 + EPSILON, "140 ms の下限と 20 ms の不感帯まで戻ること");
  assert.equal(gapsAfterRecovery, 0, "追いつくための圧縮で新しい穴を作らないこと");
  assert.equal(scheduler.drops, 0, "音を捨てて追いつかないこと");
});

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
 * 呼ぶため、次に並べる音の `lastEnd` が確定する。この音はキューが空 (直前の音が無い) ため、
 * 目標を 10 ms 過ぎていても詰めない (`compressSeconds` は 0 になり、終わりは 10.03 になる)。
 * 詰めが起きる状態は、キューに余裕を作ってから確かめる
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

// 既定の値: 再生の遅れ 50 ms (実リレーの実測で決めた下限)、合計の上限 300 ms、並べすぎの
// 余裕 250 ms (300 - 50)、鳴らす時刻の下限 10 ms (描画の 1 単位 128 フレームより大きい)、
// 補間の下限 5 ms と上限 100 ms、時計の不感帯 30 ms、時計の変更の上限 80 ms
test("既定の値: 再生の遅れ、上限、余裕、補間の下限と上限、時計の不感帯と変更の上限", () => {
  assert.equal(AUDIO_PLAYOUT_DELAY_SECONDS, 0.05);
  assert.equal(AUDIO_PLAYOUT_MAX_DELAY_SECONDS, 0.3);
  assert.equal(AUDIO_PLAYOUT_MIN_LEAD_SECONDS, 0.01);
  assert.closeTo(AUDIO_PLAYOUT_BACKLOG_SECONDS, 0.25, EPSILON);
  assert.equal(AUDIO_PLAYOUT_MIN_CONCEAL_SECONDS, 0.0005);
  assert.equal(AUDIO_PLAYOUT_MAX_CONCEAL_SECONDS, 0.1);
  assert.equal(AUDIO_CLOCK_DEADBAND_MS, 30);
  assert.equal(AUDIO_CLOCK_MAX_CHANGE_MS, 80);
});

// 目標を守るとき: 目標の時刻が今 + 余裕より先なら、その時刻に鳴らすと決める。
// 前後させると映像とずれるため、目標の時刻をそのまま使う
test("schedule: 目標を守るときは目標の時刻に鳴らす", () => {
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
  const decision = scheduler.schedule(10, 1_000_000, FRAME_SECONDS, enforcedTarget(10.05));
  assert.equal(startAtOf(decision), 10.05);
  assert.equal(scheduler.drops, 0);
  assert.equal(scheduler.rebases, 0);
});

// 目標を守るとき: 目標の時刻が今 + 余裕ちょうどなら鳴らす (境界。AudioContext は 128
// フレームずつ描くため、その分と予約の遅れを見込んだ下限が余裕である)
test("schedule: 目標の時刻が今 + 余裕ちょうどなら鳴らす", () => {
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
  const startAt = 10 + AUDIO_PLAYOUT_MIN_LEAD_SECONDS;
  assert.equal(
    startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, enforcedTarget(startAt))),
    startAt,
  );
});

// 目標を守るとき: 出力のバッファが下限を決めているときは詰めない。開始が「今 + 余裕」で
// 決まる状態では、詰めても次の音の下限は実時間と同じ速さで進むため遅れは 1 ms も減らず、
// 削った分がそのまま無音の穴になる。実測 (Lead の再現と同じ入力: 出力のリード 95.5 ms、
// 表示の遅れ 66 ms、10 ms の音 100 フレーム) では、100 件すべてが圧縮を要求し、5 ms ずつ
// 削れて 99 件・495 ms の穴 (当時は 5 ms 以下を補間しないため無音) が空き、遅れは 39.5 ms のまま
// 変わらなかった。修正後は圧縮の要求 0 件・穴 0 件で、遅れは 39.5 ms のままである
test("schedule: 出力のバッファが下限を決めているときは詰めない", () => {
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
  // 復号の出力 (10 ms の音) は 10 ms ごとに届く。AudioContext の時計は実際に鳴る位置より
  // 出力のリード (95.5 ms) だけ先に進む
  const outputLeadSeconds = 0.0955;
  // 目標は「到着 + 66 ms」であり、今 (到着 + 95.5 ms) + 余裕 (10 ms) より 29.5 ms 過去になる
  const presentationSeconds = 0.066;
  const frameSeconds = 0.01;
  const firstNowSeconds = 100;
  const firstStartAt = firstNowSeconds + AUDIO_PLAYOUT_MIN_LEAD_SECONDS;
  let previousEnd: number | null = null;
  let requests = 0;
  let silentGapSeconds = 0;
  for (let index = 0; index < 100; index++) {
    const nowSeconds = firstNowSeconds + index * frameSeconds;
    const arrivalSeconds = nowSeconds - outputLeadSeconds;
    const decision = playDecisionOf(
      scheduler.schedule(nowSeconds, index * 10_000, frameSeconds, {
        ...enforcedTarget(arrivalSeconds + presentationSeconds, arrivalSeconds),
        delaySeconds: presentationSeconds,
        presentationDelaySeconds: presentationSeconds,
      }),
    );
    if (decision.compressSeconds > 0) {
      requests += 1;
    }
    // 前の音の終わりから今回の開始までに空いた分を数える。0.5 ms 以下の隙間は
    // snapToPreviousEnd が前の音の終わりに揃えるため穴にならない (揃えられないときは無音として計器に出る。揃わない 0.5 ms 超の
    // 隙間は補間され、gapSeconds に入る)
    if (previousEnd !== null && decision.startAt > previousEnd && decision.gapSeconds === 0) {
      silentGapSeconds += decision.startAt - previousEnd;
    }
    // 遅れは目標と今の位置の差で決まり、詰めても減らない (100 フレームすべてで変わらない)
    assert.closeTo(scheduler.lateness, 0.0395, EPSILON, `${index} 番目の遅れ`);
    scheduler.confirmStretch(decision.compressSeconds);
    previousEnd = decision.startAt + frameSeconds - decision.compressSeconds;
  }
  assert.equal(requests, 0, "圧縮を要求しないこと");
  assert.equal(scheduler.compressed, 0, "詰めていないこと");
  assert.equal(silentGapSeconds, 0, "削った分の穴が空かないこと");
  // 鳴らす音は 1 フレームも削られておらず、100 フレーム分 (1 秒) が並んでいる
  assert.closeTo(
    (previousEnd ?? 0) - firstStartAt,
    100 * frameSeconds,
    1e-9,
    "削られた分が無いこと",
  );
});

// 目標を守るとき: 目標の時刻を過ぎて届いた音は捨てず、今から鳴らせる最も早い時刻へ
// ずらして鳴らし、ずらした分を波形の周期を使って詰める (NetEq の accelerate と同じ)。
// 取り直すと音声だけが後ろへずれて共有の時間軸を使う映像とずれるため、取り直さない。
// 詰めるのは、既に並べてある音が下限より先にある (キューの余裕がある) ときだけである
test("schedule: 目標の時刻を過ぎて届いた音は捨てずに詰めて目標へ戻す", () => {
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
  // 先に目標が未来の音 (10.1) を並べておく。直前の音の終わりは 10.12 であり、今 + 余裕
  // (10.05 + 0.01 = 10.06) より後ろにある = キューの余裕は 60 ms
  startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, enforcedTarget(10.1)));
  // 目標 10.04 の音が 10.05 に届く
  const decision = playDecisionOf(
    scheduler.schedule(10.05, FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(10.04)),
  );
  // 前の音の終わり (10.12) へずらして鳴らす (今 + 余裕の 10.06 では前の音と重なる)
  assert.closeTo(decision.startAt, 10.12, EPSILON);
  // ずらした分 (10.12 - 10.04 = 80 ms) のうち、音の長さの半分 (10 ms) までを詰める。
  // キューの余裕 (60 ms) はこの量より大きいため、切られるのは音の長さの半分である
  const latenessSeconds = decision.startAt - 10.04;
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
// 「遅れ」「音の長さの半分」「キューの余裕」の最小値までである (1 つの音で詰めすぎない)。
// 旧挙動はキューが空でも遅れの分だけ詰めていたため、1 つ目の遅れが 10 ms ずつ減っていた。
// 余裕で切る規則では、詰められるのは余裕があるときだけなので、余裕を作る音を先に並べる
test("schedule: 詰めた分だけ遅れが減り、目標へ戻る", () => {
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
  // 目標が 10.3 の音を先に並べる。直前の音の終わりは 10.32 であり、今 + 余裕 (10.21) より
  // 110 ms 先にある = キューの余裕は 110 ms
  startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, enforcedTarget(10.3)));
  // 1 つ目の音は目標を 20 ms 過ぎて届く (前の音の終わり 10.32 に繋がる)
  const first = playDecisionOf(
    scheduler.schedule(10.2, FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(10.3)),
  );
  assert.closeTo(scheduler.lateness, 0.02, EPSILON);
  scheduler.confirmStretch(first.compressSeconds);
  assert.closeTo(scheduler.compressed, FRAME_SECONDS / 2, EPSILON);
  // 2 つ目は 10 ms の遅れが残る
  const second = playDecisionOf(
    scheduler.schedule(10.22, 2 * FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(10.32)),
  );
  assert.closeTo(scheduler.lateness, 0.01, EPSILON, "詰めた分だけ遅れが減ること");
  scheduler.confirmStretch(second.compressSeconds);
  // 3 つ目は目標どおりに鳴る
  const third = playDecisionOf(
    scheduler.schedule(10.24, 3 * FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(10.34)),
  );
  assert.closeTo(scheduler.lateness, 0, EPSILON, "目標へ戻ること");
  assert.closeTo(third.startAt, 10.34, EPSILON);
});

// 目標を守るとき: 並べすぎ (目標 - 今 > 再生の遅れ + 余裕) の音は捨てる。上限の 1 フレーム
// 手前は鳴らす (絶対値の上限ではなく、共有の時間軸が決めた再生の遅れに対する余裕で判定する)
test("schedule: 並べすぎの音は捨てる", () => {
  const nowSeconds = 10;
  const limit = AUDIO_PLAYOUT_DELAY_SECONDS + AUDIO_PLAYOUT_BACKLOG_SECONDS;
  const within = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
  const inside = nowSeconds + limit - FRAME_SECONDS;
  assert.equal(
    startAtOf(within.schedule(nowSeconds, 0, FRAME_SECONDS, enforcedTarget(inside))),
    inside,
  );
  assert.equal(within.drops, 0);
  const beyond = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
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
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
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
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
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
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
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
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
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
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
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
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
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

// 目標を守るとき: 遅れて届いた音も鳴り、詰めた分だけ遅れが減って目標へ戻る (遅れが連鎖
// しない)。キューが下限まで使い切られている (前の音の終わりが今 + 余裕以下) ときは詰めない
// ため、1 つ後の音は前の音の終わりに繋がる。その音はキューに余裕ができており、詰めた分だけ
// 遅れが減る。旧挙動ではキューが空でも詰めていたため、この音が目標どおり 10.12 に鳴っていた
test("schedule: 遅れて届いた音も鳴り、遅れが連鎖せずに目標へ戻る", () => {
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
  startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, enforcedTarget(10.08)));
  // 目標 10.10 の音が 10.10 に届く (今 + 余裕 (10.11) より前 = 目標を過ぎている)
  const late = playDecisionOf(
    scheduler.schedule(10.1, FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(10.1)),
  );
  assert.closeTo(late.startAt, 10.11, EPSILON);
  // 直前の音の終わり (10.10) が今 + 余裕 (10.11) より前であり、キューの余裕が無いため詰めない
  assert.equal(late.compressSeconds, 0, "余裕が無いときは詰めないこと");
  scheduler.confirmStretch(late.compressSeconds);
  // 次の音は前の音の終わり (10.13) に繋がる。遅れは 10 ms 残るが、直前の音の終わりが
  // 今 + 余裕 (10.11) より後ろにあるため、詰めて遅れを減らせる
  const next = playDecisionOf(
    scheduler.schedule(10.1, 2 * FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(10.12)),
  );
  assert.closeTo(next.startAt, 10.13, EPSILON);
  assert.closeTo(next.compressSeconds, FRAME_SECONDS / 2, EPSILON);
  scheduler.confirmStretch(next.compressSeconds);
  // その次は目標どおりに鳴る (遅れが連鎖しない)
  assert.closeTo(
    startAtOf(
      scheduler.schedule(10.12, 3 * FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(10.14)),
    ),
    10.14,
    EPSILON,
  );
  assert.equal(scheduler.drops, 0);
  assert.equal(scheduler.rebases, 0);
});

// 目標を守るとき: 並べすぎで捨てた後、今が進んで目標が上限に収まれば、その目標どおりに鳴る
test("schedule: 並べすぎで捨てた後も目標どおりに鳴る", () => {
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
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
    const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
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
    const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
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
    const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
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
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
  const first = playFirst(scheduler);
  assert.equal(first.gapSeconds, 0, "最初の音には隙間が無い");
  // 1 つ目の音はキューが空のため詰めない。前の音の終わりは 10.03 になる (旧挙動では 10 ms
  // 詰めて 10.02 になっていた)
  const previousEnd = first.startAt + FRAME_SECONDS - first.compressSeconds;
  assert.closeTo(previousEnd, 10.03, EPSILON);
  // 40 ms 後の timestamp の音が、前の音の終わりより 30 ms 先の目標で届く
  const second = playDecisionOf(
    scheduler.schedule(10, 2 * FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(10.06)),
  );
  assert.closeTo(second.gapStartSeconds, previousEnd, EPSILON);
  assert.closeTo(second.gapSeconds, 0.03, EPSILON);
  scheduler.confirmConcealment(second.gapSeconds);
  assert.equal(scheduler.concealments, 1);
  assert.closeTo(scheduler.concealed, 0.03, EPSILON);
});

// 補間する長さは上限 (100 ms) で切る。超えた分は無音のまま残す
test("schedule: 補間する隙間は上限で切る", () => {
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
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

// 下限 (0.5 ms) 以下の隙間は、前の音の終わりに揃えて穴を作らない。目標の表示時刻の更新や
// 浮動小数点の丸めで 20 µs〜0.5 ms だけ後ろへずれることがあり、これを穴として扱うと
// 1〜2 サンプルのデジタル無音が残って段差になるためである
test("schedule: 下限以下の隙間は前の音の終わりに揃える", () => {
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
  const first = playFirst(scheduler);
  const previousEnd = first.startAt + FRAME_SECONDS - first.compressSeconds;
  const second = playDecisionOf(
    scheduler.schedule(10, FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(previousEnd + 0.0004)),
  );
  assert.equal(second.startAt, previousEnd, "前の音の終わりに揃えること");
  assert.equal(second.gapSeconds, 0);
  assert.equal(second.gapStartSeconds, 0);
  assert.equal(second.totalGapSeconds, 0);
  assert.equal(second.unrecoverableGapSeconds, 0);
  assert.equal(scheduler.concealments, 0);
  // 揃えた分だけ目標より早く鳴るが、遅れの計器は負にしない
  assert.equal(scheduler.lateness, 0, "遅れを負にしないこと");
});

// 前のフレームの目標から 20 µs〜0.4 ms だけ後ろにずれた入力でも、出力にゼロサンプルを
// 挟まず、段差の計器を増やさない
test("schedule: 20 µs〜0.4 ms の前進を前の音の終わりに揃えて吸収する", () => {
  for (const offsetSeconds of [0.00002, 0.0001, 0.0004]) {
    const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
    const first = playFirst(scheduler);
    const previousEnd = first.startAt + FRAME_SECONDS - first.compressSeconds;
    const second = playDecisionOf(
      scheduler.schedule(
        10,
        FRAME_MICROSECONDS,
        FRAME_SECONDS,
        enforcedTarget(previousEnd + offsetSeconds),
      ),
    );
    assert.equal(second.startAt, previousEnd, "前の音の終わりに揃えること");
    assert.equal(second.gapSeconds, 0);
    assert.equal(second.totalGapSeconds, 0);
    assert.equal(scheduler.lateness, 0);
  }
});

// 隙間がちょうど下限 (0.5 ms) なら前の音の終わりに揃える (境界)。前の音の終わりを 0 に
// するため duration 0 の音を使い、計算誤差の無い引き算で下限ちょうどを作る
test("schedule: 隙間がちょうど下限なら前の音の終わりに揃える", () => {
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
  assert.equal(second.startAt, 0, "前の音の終わりに揃えること");
  assert.equal(second.gapSeconds, 0);
  assert.equal(second.gapStartSeconds, 0);
});

// 前の音の終わりが今より過去のときは過去へ予約しないため揃えず、0.5 ms 以下の隙間でも
// 無音として返す (呼び出し側が無音として数え、先頭をフェードする)
test("schedule: 前の音の終わりが今より過去なら下限以下の隙間を無音として返す", () => {
  const scheduler = new AudioPlayoutScheduler({ minLeadSeconds: 0 });
  // 長さ 0 の音で前の音の終わりを 0 にし、次を 0.1 ms 後に予約する (隙間 0.2 ms)
  assert.equal(scheduler.schedule(0, 0, 0, enforcedTarget(0)).kind, "play");
  const second = playDecisionOf(
    scheduler.schedule(0.0001, FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(0.0002)),
  );
  assert.closeTo(second.totalGapSeconds, second.startAt, EPSILON);
  assert.equal(second.gapSeconds, 0, "下限以下は補間しないこと");
  assert.equal(second.gapStartSeconds, 0);
  assert.isAbove(second.unrecoverableGapSeconds, 0, "揃えられない分は無音として返すこと");
});

// 下限のすぐ上 (6 ms) の隙間は補間する
test("schedule: 下限のすぐ上の隙間は補間する", () => {
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
  const first = playFirst(scheduler);
  const previousEnd = first.startAt + FRAME_SECONDS - first.compressSeconds;
  const second = playDecisionOf(
    scheduler.schedule(10, FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(previousEnd + 0.006)),
  );
  assert.closeTo(second.gapSeconds, 0.006, EPSILON);
  assert.closeTo(second.gapStartSeconds, previousEnd, EPSILON);
});

// 前の音の終わりが今 + 余裕より前でも、今回の開始がその先なら、未来の分だけは補間する。
// 今 + 余裕より前の分 (既に過去の分と、未来でも余裕に満たない分) は予約できないため
// unrecoverableGapSeconds として返す
test("schedule: 隙間の先頭が今 + 余裕より前でも予約できる未来の分は補間する", () => {
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
  const first = playFirst(scheduler);
  const previousEnd = first.startAt + FRAME_SECONDS - first.compressSeconds;
  // 前の音の終わり (10.03) が今 + 余裕 (10.021 + 0.01 = 10.031) より前になる
  const nowSeconds = 10.021;
  const second = playDecisionOf(
    scheduler.schedule(nowSeconds, FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(10.06)),
  );
  // 補間の開始は予約できる最も早い時刻 (今 + 余裕) になる
  assert.closeTo(second.gapStartSeconds, nowSeconds + AUDIO_PLAYOUT_MIN_LEAD_SECONDS, EPSILON);
  assert.closeTo(second.gapSeconds, 10.06 - (nowSeconds + AUDIO_PLAYOUT_MIN_LEAD_SECONDS), EPSILON);
  // 今 + 余裕より前の分 (前の音の終わりから今 + 余裕まで) は補間しない。この例の前の音の
  // 終わりは今より未来であり、「既に過去」ではなく余裕に満たない分である
  assert.isAbove(previousEnd, nowSeconds, "この例の unrecoverable は未来の分であること");
  assert.closeTo(
    second.unrecoverableGapSeconds,
    nowSeconds + AUDIO_PLAYOUT_MIN_LEAD_SECONDS - previousEnd,
    EPSILON,
  );
  assert.closeTo(second.totalGapSeconds, second.startAt - previousEnd, EPSILON);
  assert.isAtLeast(second.startAt - nowSeconds, AUDIO_PLAYOUT_MIN_LEAD_SECONDS - EPSILON);
});

// 補間の統計: 実際に補間できた長さだけを数える。要求より多ければ要求までに切る
test("confirmConcealment: 実際に補間した長さだけを数える", () => {
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
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
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
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
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
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
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
  const first = playFirst(scheduler);
  // 前の音の終わり (10.03) が今 + 余裕 (10.02 + 0.01) と同じになる
  const second = playDecisionOf(
    scheduler.schedule(10.02, FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(10.07)),
  );
  assert.closeTo(
    second.gapStartSeconds,
    first.startAt + FRAME_SECONDS - first.compressSeconds,
    1e-9,
  );
  assert.closeTo(second.gapSeconds, 0.04, 1e-9);
});

// 隙間がちょうど上限 (100 ms) なら切らずに補間する (境界)
test("schedule: 隙間がちょうど上限なら切らずに補間する", () => {
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
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
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
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
  // 1 つ目の音はキューが空のため詰めず、前の音の終わりは 10.03 になる (旧挙動では 10 ms
  // 詰めて 10.02 になっていた)
  assert.closeTo(third.gapSeconds, 0.03, 1e-9);
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
    const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
    startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, make(10)));
    // 2 つ目の音は 10.10 に鳴らすはずが、10.2 に届く (目標 10.05 はとっくに過ぎている)
    const late = startAtOf(scheduler.schedule(10.2, FRAME_MICROSECONDS, FRAME_SECONDS, make(10.2)));
    assert.closeTo(late, 10.2 + AUDIO_PLAYOUT_MIN_LEAD_SECONDS, EPSILON, label);
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
    const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
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
    const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
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
    const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
    const first = startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, make(10)));
    const second = startAtOf(scheduler.schedule(10.01, 10_000, FRAME_SECONDS, make(10.01)));
    assert.closeTo(second, first + FRAME_SECONDS, EPSILON, label);
  }
});

// 目標を使わないとき: 並べる音が溜まっていないのに timestamp が大きく飛んだ音 (送る側の
// 再起動、長い抜けなど) は、捨て続けないよう基準を取り直して鳴らす
test("schedule: 目標を使わないときは timestamp が大きく飛んだ音で基準を取り直す", () => {
  for (const { label, make } of arrivalTargets) {
    const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
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
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
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
    totalGapSeconds: 0,
    unrecoverableGapSeconds: 0,
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
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
  assert.closeTo(
    startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, targetAt(10))),
    10 + arrivalDelaySeconds,
    EPSILON,
    "学習した遅れではなく到着基準の遅れで並べること",
  );
  // 過ぎてから届いた音には初期の待ちを再度足さず、直ちに再開する。
  const late = startAtOf(scheduler.schedule(20, FRAME_MICROSECONDS, FRAME_SECONDS, targetAt(20)));
  assert.closeTo(late, 20 + AUDIO_PLAYOUT_MIN_LEAD_SECONDS, EPSILON);
  assert.equal(scheduler.rebases, 1);
});

// 到着基準の再生の遅れ: 学習した遅れを上限 (100 ms) で切り、下限 (50 ms) で持ち上げる。
// ずれの分だけ育った学習値 (316〜500 ms) をそのまま使うと、その分だけ音が遅れて鳴る
test("arrivalPlayoutDelaySeconds: 学習した遅れを小さな上限で切る", () => {
  assert.equal(AUDIO_PLAYOUT_ARRIVAL_DELAY_SECONDS, 0.1);
  // ずれの分だけ育った学習値でも、到着基準では上限まで
  assert.equal(arrivalPlayoutDelaySeconds(AUDIO_PLAYOUT_MAX_DELAY_SECONDS), 0.1);
  assert.equal(arrivalPlayoutDelaySeconds(0.316), 0.1);
  assert.equal(arrivalPlayoutDelaySeconds(0.1), 0.1);
  // 学習値が小さいときは、既存の下限 (50 ms) を使う
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
    const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
    startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS, make(10)));
    scheduler.reset();
    const startAt = startAtOf(scheduler.schedule(20, 5_000_000, FRAME_SECONDS, make(20)));
    assert.closeTo(startAt, 20 + AUDIO_PLAYOUT_DELAY_SECONDS, EPSILON, label);
  }
});

// reset: 再生の統計 (取り直し / 捨て / 補間 / 詰め) は消えず、今の遅れだけ 0 に戻る
test("reset: 再生の統計は消えず、今の遅れだけ 0 に戻る", () => {
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
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
  // 目標を過ぎて届いた音で今の遅れと詰めを作る。詰めるにはキューの余裕が要るため、先に
  // 目標が未来の音を並べて作る (直前の音の終わりは 300.22 になる)
  scheduler.schedule(300, 0, FRAME_SECONDS, enforcedTarget(300.2));
  const late = playDecisionOf(
    scheduler.schedule(300.2, 2 * FRAME_MICROSECONDS, FRAME_SECONDS, enforcedTarget(300.2)),
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
  const scheduler = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
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
  const defaultBacklog = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
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
  // 同じ目標でも、既定の下限 (10 ms) なら目標を過ぎているため、遅れとして詰める。詰める
  // にはキューの余裕が要るため、先に目標が未来の音を並べて作る (直前の音の終わりは 10.22)
  const defaultMinLead = new AudioPlayoutScheduler({ stretchMinSeconds: 0 });
  startAtOf(defaultMinLead.schedule(10, 0, FRAME_SECONDS, enforcedTarget(10.2)));
  const lateDecision = defaultMinLead.schedule(
    10.2,
    FRAME_MICROSECONDS,
    FRAME_SECONDS,
    enforcedTarget(10 + minLeadSeconds),
  );
  assert.equal(lateDecision.kind, "play");
  if (lateDecision.kind === "play") {
    // ここは不感帯 0 で回しているため、遅れはそのまま詰める (不感帯そのものの効きは
    // src/playout/audioPlayout.prop.ts が既定値との関係で確かめる)
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

// AudioClockBridge: AudioContext が停止していたときは、段差を上限までずつ補正せず、対応を
// そのまま取り直す。停止中は currentTime が止まり performance.now() だけが進むため、
// 再開後の対応は数百 ms ずれる。80 ms ずつ補正すると、再開直後の予約が未来になって破棄される
test("AudioClockBridge: 停止を検出したら対応をそのまま取り直す", () => {
  const bridge = new AudioClockBridge();
  bridge.update({ contextTime: 1, performanceTime: 2_000 }, 1, 2_000);
  assert.closeTo(valueOf(bridge.currentOffsetMs), -1_000, EPSILON);

  // 1 秒の停止: currentTime は 1 秒のまま、performance.now() だけが 3,000 ms へ進む
  bridge.update({ contextTime: 1, performanceTime: 3_000 }, 1, 3_000);
  assert.closeTo(
    valueOf(bridge.currentOffsetMs),
    -2_000,
    EPSILON,
    "停止の段差を上限まで分割せず、観測値をそのまま採ること",
  );
  // 停止を検出した幅は 250 ms 以上であること (閾値を下回ると 80 ms/回の補正に戻る)
  assert.isAtLeast(AUDIO_CLOCK_STALL_MS, AUDIO_CLOCK_MAX_CHANGE_MS * 2);
  // 再開直後の予約 (performance 軸で 3,090 ms) が未来にならないこと
  assert.closeTo(valueOf(bridge.toAudioSeconds(3_090)), 1.09, EPSILON);

  // 停止していない (2 つの時計が同じだけ進んだ) ときは対応を変えない
  bridge.update({ contextTime: 2, performanceTime: 4_000 }, 2, 4_000);
  assert.closeTo(valueOf(bridge.currentOffsetMs), -2_000, EPSILON);
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

/**
 * 到着基準で並べるときの目標
 *
 * 目標の開始時刻を持たないため、前の音の終わりや到着 + 再生の遅れで並ぶ。
 */
function arrivalTarget(arrivalSeconds: number): AudioPlayoutTarget {
  return {
    targetStartSeconds: null,
    arrivalSeconds,
    enforceTarget: false,
    delaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
    arrivalDelaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
    presentationDelaySeconds: AUDIO_PLAYOUT_DELAY_SECONDS,
  };
}
