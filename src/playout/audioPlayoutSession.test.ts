/**
 * Session の状態と停止待ちを実クラス・実時計で検証する。
 * AudioData / Web Audio は tests/e2e/media-playout-audio.spec.ts で実 API を使う。
 * 予約・圧縮・補間の境界値は各処理の単体テストと PBT が担当する。
 */
import { assert, test } from "vite-plus/test";
import { AudioPlayoutSession } from "./audioPlayoutSession";
import { AudioPlayoutTimingStats } from "./audioPlayoutTimingStats";

function createSession(): { session: AudioPlayoutSession; timing: AudioPlayoutTimingStats } {
  const timing = new AudioPlayoutTimingStats(10_000, performance.timeOrigin);
  return { session: new AudioPlayoutSession({ timing }), timing };
}

// 出力時計と予約は AudioContext ごとに異なる。次の Context へ以前の予約位置を
// 持ち越さないことを、実 scheduler の状態で確かめる。
test("drainReserved: コールバックが throw しても結果を返す", async () => {
  // 注入されたコールバックは throw しない契約だが、throw しても drain を失敗させず、
  // 記録 (lastDrain) を残す。待ち終えた / 残り 0 として扱う
  const { session } = createSession();
  const result = await session.drainReserved({
    maxWaitMs: 30,
    flushedObjects: 1,
    isFlushSettled: () => {
      throw new Error("isFlushSettled failed");
    },
    remainingFlushedObjects: () => {
      throw new Error("remainingFlushedObjects failed");
    },
  });
  assert.strictEqual(result.flushedObjects, 1);
  assert.strictEqual(result.undecodedFlushedObjects, 0);
  assert.strictEqual(result.requestedMs, 30);
});

test("reset: 予約と出力時計と追いつきの状態を取り直す", () => {
  const { session } = createSession();
  session.clock.update({ contextTime: 10, performanceTime: 1_000 }, 10, 1_000);
  session.playout.schedule(10, 0, 0.02, {
    targetStartSeconds: 10.1,
    enforceTarget: true,
    delaySeconds: 0.1,
    arrivalSeconds: 10,
    arrivalDelaySeconds: 0.1,
    presentationDelaySeconds: 0.1,
  });
  session.catchUp.observe({ nowMs: 1_000, lagMs: 100, durationMs: 20, timestampMicros: 900_000 });
  session.reset();
  assert.isNull(session.clock.currentOffsetMs);
  assert.isNull(session.catchUp.snapshot().lagMs);
  const decision = session.playout.schedule(0, 0, 0.02, {
    targetStartSeconds: 0.1,
    enforceTarget: true,
    delaySeconds: 0.1,
    arrivalSeconds: 0,
    arrivalDelaySeconds: 0.1,
    presentationDelaySeconds: 0.1,
  });
  assert.equal(decision.kind, "play");
  if (decision.kind === "play")
    assert.closeTo(decision.startAt, 0.1, 1e-9, "旧 Context の終端を使わないこと");
});

test("releaseAudioContext: 出力時計を消し、累積の計器を残す", () => {
  const { session, timing } = createSession();
  timing.recordPlay(0, 50, 50, 20, "timestamp");
  session.clock.update({ contextTime: 10, performanceTime: 1_000 }, 10, 1_000);
  session.releaseAudioContext();
  assert.isNull(session.clock.currentOffsetMs);
  assert.equal(timing.snapshot(0).playedFrames, 1);
});

// 実時計で未来の予約を待つ。時計や sleep は置き換えない。
test("drainReserved: 実時計で予約の終わりまで待つ", async () => {
  const { session, timing } = createSession();
  const nowMs = performance.now();
  timing.recordPlay(nowMs, nowMs + 20, nowMs + 20, 20, "timestamp");
  const result = await session.drainReserved();
  assert.equal(result.cutMs, 0);
  assert.closeTo(result.playedMs, 20, 1e-6, "実時計の浮動小数点の丸めだけを許すこと");
  assert.equal(timing.snapshot(performance.now()).missedByReason.stopped.count, 0);
});

test("drainReserved: 待つ上限で打ち切り、予約の残りを stopped にする", async () => {
  const { session, timing } = createSession();
  const nowMs = performance.now();
  timing.recordPlay(nowMs, nowMs + 10_000, nowMs + 10_000, 20, "timestamp");
  const result = await session.drainReserved({ maxWaitMs: 5 });
  assert.equal(result.cutMs, 20);
  assert.equal(result.requestedMs, 5);
  assert.equal(timing.snapshot(performance.now()).missedByReason.stopped.ms, 20);
});

test("drainReserved: 実際の非同期完了を待ってから終了する", async () => {
  const { session } = createSession();
  let settled = false;
  const completion = new Promise<void>((resolve) => {
    setTimeout(() => {
      settled = true;
      resolve();
    }, 20);
  });
  const result = await session.drainReserved({ isFlushSettled: () => settled, flushedObjects: 1 });
  assert.isTrue(settled, "非同期の完了を待つこと");
  assert.equal(result.flushedObjects, 1);
  assert.equal(result.cutMs, 0);
  await completion;
});

test("drainReserved: 待ち時間内に終わらなかった処理の件数を残す", async () => {
  const { session } = createSession();
  let remaining = 3;
  const completion = new Promise<void>((resolve) => {
    setTimeout(() => {
      remaining = 0;
      resolve();
    }, 100);
  });
  const result = await session.drainReserved({
    maxWaitMs: 5,
    isFlushSettled: () => remaining === 0,
    remainingFlushedObjects: () => remaining,
    flushedObjects: 3,
  });
  assert.equal(result.undecodedFlushedObjects, 3);
  assert.equal(result.cutMs, 0);
  await completion;
});

test("drainReserved: 予約も未完了処理も無ければ待たない", async () => {
  const { session } = createSession();
  const result = await session.drainReserved();
  assert.equal(result.cutMs, 0);
  assert.equal(result.playedMs, 0);
});
