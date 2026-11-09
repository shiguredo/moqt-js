/** 予約は計画と確定を分離し、実際に投入した PCM だけが次の予約を動かす。 */
import { test, assert } from "vite-plus/test";
import {
  AudioPlayoutScheduler,
  AudioClockBridge,
  AUDIO_CLOCK_MAX_CHANGE_MS,
  AUDIO_CLOCK_STALL_MS,
  type AudioPlayoutDecision,
  type AudioPlayoutTarget,
} from "./audioPlayout";

const EPSILON = 1e-9;
function valueOf(value: number | null): number {
  assert.isNotNull(value);
  return value ?? 0;
}
function target(now: number, timestamp: number | null = null): AudioPlayoutTarget {
  return {
    arrivalSeconds: now,
    targetStartSeconds: timestamp,
    enforceTarget: timestamp !== null,
    delaySeconds: 0.05,
    arrivalDelaySeconds: 0.05,
    presentationDelaySeconds: 0.05,
  };
}
function play(decision: AudioPlayoutDecision): Extract<AudioPlayoutDecision, { kind: "play" }> {
  assert.equal(decision.kind, "play");
  if (decision.kind !== "play") throw new Error("再生計画が必要です");
  return decision;
}

test("投入に失敗した計画は予約位置・時間伸縮・再同期の実績を変更しない", () => {
  const scheduler = new AudioPlayoutScheduler();
  const failed = play(scheduler.schedule(1, 0, 0.02, target(1)));
  const accepted = play(scheduler.schedule(1, 20000, 0.02, target(1)));
  assert.equal(accepted.startAt, failed.startAt);
  assert.equal(scheduler.compressed, 0);
  assert.equal(scheduler.rebases, 0);
  assert.throws(() => scheduler.commit(failed, { startAt: failed.startAt, playedSeconds: 0.02 }));
  scheduler.commit(accepted, { startAt: accepted.startAt, playedSeconds: 0.02 });
  assert.throws(() =>
    scheduler.commit(accepted, { startAt: accepted.startAt, playedSeconds: 0.02 }),
  );
  assert.closeTo(play(scheduler.schedule(1, 40000, 0.02, target(1))).startAt, 1.07, EPSILON);
});

test("実際の開始と長さを一度に確定し、サンプル丸めと媒体の欠落を保つ", () => {
  const scheduler = new AudioPlayoutScheduler();
  const first = play(scheduler.schedule(1, 0, 0.02, target(1)));
  const actualStart = first.startAt + 0.012;
  const actualDuration = 881 / 44100;
  scheduler.commit(first, { startAt: actualStart, playedSeconds: actualDuration });
  const next = play(scheduler.schedule(1, 40000, 0.02, target(1)));
  assert.closeTo(next.startAt, actualStart + actualDuration + 0.02, EPSILON);
  assert.closeTo(next.totalGapSeconds, 0.02, EPSILON);
});

test("過去の 10 秒分を一括投入しても圧縮の成功を仮定せず終端を 300 ms 以内に保つ", () => {
  for (const timestampBasis of [false, true]) {
    const scheduler = new AudioPlayoutScheduler();
    let end = 20;
    for (let index = 0; index < 1000; index++) {
      const decision = scheduler.schedule(
        20,
        index * 10000,
        0.01,
        target(20, timestampBasis ? 10 + index * 0.01 : null),
      );
      if (decision.kind === "drop") continue;
      end = decision.startAt + 0.01;
      assert.isAtMost(end, 20.3 + EPSILON);
      scheduler.commit(decision, { startAt: decision.startAt, playedSeconds: 0.01 });
    }
    assert.isAbove(scheduler.drops, 0);
    assert.equal(scheduler.schedule(end, 10000000, 0.01, target(end)).kind, "play");
  }
});

test("終端超過で破棄した音は到着基準を移動しない", () => {
  const scheduler = new AudioPlayoutScheduler();
  const first = play(scheduler.schedule(0, 0, 0.02, target(0)));
  scheduler.commit(first, { startAt: first.startAt, playedSeconds: 0.02 });
  assert.equal(scheduler.schedule(0, 10000000, 0.02, target(0.24)).kind, "drop");
  assert.equal(scheduler.rebases, 0);
  assert.closeTo(play(scheduler.schedule(0, 20000, 0.02, target(0))).startAt, 0.07, EPSILON);
});

test("到着基準と時刻基準の両方で実適用した圧縮量だけを引き継ぐ", () => {
  for (const timestampBasis of [false, true]) {
    const scheduler = new AudioPlayoutScheduler();
    const first = play(scheduler.schedule(1, 0, 0.02, target(1, 1.2)));
    scheduler.commit(first, { startAt: first.startAt, playedSeconds: 0.02 });
    const second = play(
      scheduler.schedule(1.02, 20000, 0.02, target(1.02, timestampBasis ? 1.07 : null)),
    );
    assert.isAbove(second.compressSeconds, 0);
    scheduler.commit(second, { startAt: second.startAt, playedSeconds: 0.015 });
    assert.closeTo(scheduler.compressed, 0.005, EPSILON);
    assert.closeTo(
      play(scheduler.schedule(1.04, 40000, 0.02, target(1.04, timestampBasis ? 1.09 : null)))
        .startAt,
      1.235,
      EPSILON,
    );
  }
});

test("到着が途切れた後は即時に再開し、伸長を実適用した場合だけ深さを戻す", () => {
  const scheduler = new AudioPlayoutScheduler();
  const first = play(scheduler.schedule(0, 0, 0.02, target(0)));
  scheduler.commit(first, { startAt: first.startAt, playedSeconds: 0.02 });
  const recovery = play(scheduler.schedule(0.2, 20000, 0.02, target(0.2)));
  assert.closeTo(recovery.startAt, 0.21, EPSILON);
  assert.isAbove(recovery.expandSeconds ?? 0, 0);
  scheduler.commit(recovery, { startAt: recovery.startAt, playedSeconds: 0.025 });
  assert.closeTo(scheduler.expanded, 0.005, EPSILON);
  assert.equal(scheduler.rebases, 1);
  assert.closeTo(play(scheduler.schedule(0.22, 40000, 0.02, target(0.22))).startAt, 0.235, EPSILON);
});

test("現在の出力先行量が下限なら圧縮による穴を作らない", () => {
  const scheduler = new AudioPlayoutScheduler();
  for (let index = 0; index < 100; index++) {
    const now = 1 + index * 0.02;
    const decision = play(scheduler.schedule(now, index * 20000, 0.02, target(now, now - 0.03)));
    assert.equal(decision.compressSeconds, 0);
    scheduler.commit(decision, { startAt: decision.startAt, playedSeconds: 0.02 });
  }
});

test("微小な目標移動は前の終端に接続し、大きな媒体の隙間は残す", () => {
  const scheduler = new AudioPlayoutScheduler();
  const first = play(scheduler.schedule(0, 0, 0.02, target(0, 0.05)));
  scheduler.commit(first, { startAt: first.startAt, playedSeconds: 0.02 });
  const next = play(scheduler.schedule(0.02, 20000, 0.02, target(0.02, 0.0704)));
  assert.closeTo(next.startAt, 0.07, EPSILON);
  assert.equal(next.totalGapSeconds, 0);
});

test("reset は未確定の計画を失効させるが累積実績を消さない", () => {
  const scheduler = new AudioPlayoutScheduler();
  const old = play(scheduler.schedule(0, 0, 0.02, target(0)));
  scheduler.recordRenderedConcealment(0.01, 1);
  scheduler.reset();
  assert.throws(() => scheduler.commit(old, { startAt: old.startAt, playedSeconds: 0.02 }));
  assert.equal(scheduler.concealed, 0.01);
  assert.equal(scheduler.concealments, 1);
  assert.closeTo(play(scheduler.schedule(1, 1000000, 0.02, target(1))).startAt, 1.05, EPSILON);
});

test("AudioClockBridge: 代用と実出力時計の切り替えでは不感帯を適用しない", () => {
  const clock = new AudioClockBridge();
  clock.update(null, 1, 1000);
  // 有効な出力時計は代用より 20 ms 遅い。不感帯未満でも初回の実測値を採用する。
  clock.update({ contextTime: 1, performanceTime: 1020 }, 1.02, 1020);
  assert.isFalse(clock.usingFallback);
  assert.equal(clock.toPerformanceMs(1), 1020);
  // 実時計が一時的に失われた場合も、代用という表示と対応の値を一致させる。
  clock.update(null, 1.04, 1040);
  assert.isTrue(clock.usingFallback);
  assert.equal(clock.toPerformanceMs(1.04), 1040);
});

test("AudioClockBridge: 対応を取る前は換算できない", () => {
  const bridge = new AudioClockBridge();
  assert.isNull(bridge.currentOffsetMs);
  assert.isNull(bridge.toAudioSeconds(0));
  assert.isNull(bridge.toPerformanceMs(0));
});

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

test("AudioClockBridge: 小さな実時計の変化も 1 秒以内に 1 ms 未満へ収束する", () => {
  // 30 ms 未満の恒常誤差を残さず、急な 20 ms の変更も一度に予約へ反映しない。
  for (const offsetMs of [-20, 20]) {
    const bridge = new AudioClockBridge();
    bridge.update({ contextTime: 1, performanceTime: 1000 }, 1.03, 1000);
    for (let elapsed = 10; elapsed <= 1000; elapsed += 10) {
      bridge.update(
        { contextTime: (1000 + elapsed + offsetMs) / 1000, performanceTime: 1000 + elapsed },
        (1030 + elapsed) / 1000,
        1000 + elapsed,
      );
      const actual = valueOf(bridge.currentOffsetMs);
      assert.isAtMost(Math.abs(actual), Math.abs(offsetMs));
      if (elapsed === 10) assert.isBelow(Math.abs(actual), 5);
    }
    assert.closeTo(valueOf(bridge.currentOffsetMs), offsetMs, 1);
  }
});

test("AudioClockBridge: 同じ出力観測を再読しても重みを増やさない", () => {
  const bridge = new AudioClockBridge();
  bridge.update({ contextTime: 1, performanceTime: 1000 }, 1.03, 1000);
  bridge.update({ contextTime: 1.03, performanceTime: 1020 }, 1.05, 1020);
  const offset = bridge.currentOffsetMs;
  // 音声投入と描画通知が同じ getOutputTimestamp を読む場合も 1 観測として扱う。
  for (let repeat = 0; repeat < 20; repeat++)
    bridge.update(
      { contextTime: 1.03, performanceTime: 1020 },
      1.05 + repeat / 1000,
      1020 + repeat,
    );
  assert.equal(bridge.currentOffsetMs, offset);
  bridge.update({ contextTime: 1.5, performanceTime: 1010 }, 1.08, 1050);
  assert.equal(bridge.currentOffsetMs, offset, "古い対応を採らないこと");
});

test("AudioClockBridge: 1 回の観測で動かす幅は上限を越えない", () => {
  const bridge = new AudioClockBridge();
  bridge.update({ contextTime: 1, performanceTime: 1000 }, 1.03, 1000);
  bridge.update({ contextTime: 2, performanceTime: 1020 }, 1.05, 1020);
  assert.isAbove(valueOf(bridge.currentOffsetMs), 0);
  assert.isAtMost(valueOf(bridge.currentOffsetMs), AUDIO_CLOCK_MAX_CHANGE_MS);
});

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
