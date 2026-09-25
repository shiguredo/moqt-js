/**
 * AudioPlayoutScheduler の単体テスト
 *
 * 復号した音声を鳴らす時刻 (AudioContext.currentTime の秒) を決める。最初の音で基準を決め、
 * 以降の音は timestamp の間隔どおりに並べる。個々の規則 (音の抜け、timestamp が進まない音、
 * 鳴らす時刻を過ぎて届いた音、遅れが上限を超えた音、基準の作り直し) をここで固定する。
 * 重ならない、今 + 余裕以上、遅れは上限以下という性質は audioPlayout.prop.ts が固定する。
 */

import { test, assert } from "vite-plus/test";
import {
  AUDIO_PLAYOUT_DELAY_SECONDS,
  AUDIO_PLAYOUT_MAX_DELAY_SECONDS,
  AUDIO_PLAYOUT_MIN_LEAD_SECONDS,
  AudioPlayoutScheduler,
  type AudioPlayoutDecision,
} from "./audioPlayout";

/** Opus の 1 フレーム (20 ms) */
const FRAME_SECONDS = 0.02;
const FRAME_MICROSECONDS = 20_000;

/** 鳴らすと決めた時刻を取り出す (捨てると決めたときは失敗にする) */
function startAtOf(decision: AudioPlayoutDecision): number {
  if (decision.kind !== "play") {
    throw new Error(`expected play, got ${decision.kind}`);
  }
  return decision.startAt;
}

// 既定の値: 再生の遅れ 80 ms、上限 300 ms、余裕 10 ms (描画の 1 単位 128 フレームより大きい)
test("既定の値: 再生の遅れ 80 ms、上限 300 ms、余裕 10 ms", () => {
  assert.equal(AUDIO_PLAYOUT_DELAY_SECONDS, 0.08);
  assert.equal(AUDIO_PLAYOUT_MAX_DELAY_SECONDS, 0.3);
  assert.equal(AUDIO_PLAYOUT_MIN_LEAD_SECONDS, 0.01);
});

// 最初の音は今 + 再生の遅れに鳴らす
test("schedule: 最初の音は今 + 再生の遅れに鳴らす", () => {
  const scheduler = new AudioPlayoutScheduler();
  const startAt = startAtOf(scheduler.schedule(10, 1_000_000, FRAME_SECONDS));
  assert.closeTo(startAt, 10 + AUDIO_PLAYOUT_DELAY_SECONDS, 1e-9);
});

// 届く間隔が揺れても、timestamp の間隔どおりに途切れなく並べる (届いたその場で鳴らすと、
// 前の音と重なるか隙間が空いてノイズになる)
test("schedule: 届く間隔が揺れても timestamp の間隔どおりに並べる", () => {
  const scheduler = new AudioPlayoutScheduler();
  const arrivals = [10, 10.032, 10.041, 10.075, 10.08];
  const starts = arrivals.map((now, index) =>
    startAtOf(scheduler.schedule(now, index * FRAME_MICROSECONDS, FRAME_SECONDS)),
  );
  for (const [index, startAt] of starts.entries()) {
    assert.closeTo(startAt, 10 + AUDIO_PLAYOUT_DELAY_SECONDS + index * FRAME_SECONDS, 1e-9);
  }
  assert.equal(scheduler.rebases, 0);
  assert.equal(scheduler.drops, 0);
});

// 音が抜けたときは、その分の無音を残して後の音の時刻を保つ
test("schedule: 音が抜けたときはその分の無音を残す", () => {
  const scheduler = new AudioPlayoutScheduler();
  const first = startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS));
  // 20 ms の音が 1 つ抜けて、40 ms 後の音が届く
  const third = startAtOf(scheduler.schedule(10.04, 2 * FRAME_MICROSECONDS, FRAME_SECONDS));
  assert.closeTo(third - first, 2 * FRAME_SECONDS, 1e-9);
});

// timestamp が前の音より進んでいない (TIMESTAMP が無く 0 のまま、同じ値など) ときは、
// 前の音のすぐ後ろに並べる
test("schedule: timestamp が進まない音は前の音のすぐ後ろに並べる", () => {
  const scheduler = new AudioPlayoutScheduler();
  const first = startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS));
  const second = startAtOf(scheduler.schedule(10.02, 0, FRAME_SECONDS));
  const third = startAtOf(scheduler.schedule(10.04, 0, FRAME_SECONDS));
  assert.closeTo(second, first + FRAME_SECONDS, 1e-9);
  assert.closeTo(third, second + FRAME_SECONDS, 1e-9);
});

// timestamp の間隔が音の長さより短くても、前の音の終わりより前には鳴らさない (重ねない)
test("schedule: 前の音の終わりより前には鳴らさない", () => {
  const scheduler = new AudioPlayoutScheduler();
  const first = startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS));
  const second = startAtOf(scheduler.schedule(10.01, 10_000, FRAME_SECONDS));
  assert.closeTo(second, first + FRAME_SECONDS, 1e-9);
});

// 鳴らす時刻を過ぎて届いた音 (今 + 余裕より前になる) では、基準を取り直して今 + 再生の遅れに
// 鳴らす。後の音はその基準から timestamp の間隔どおりに並べる
test("schedule: 鳴らす時刻を過ぎて届いた音で基準を取り直す", () => {
  const scheduler = new AudioPlayoutScheduler();
  startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS));
  // 2 つ目の音は 10.1 に鳴らすはずが、10.2 に届く
  const late = startAtOf(scheduler.schedule(10.2, FRAME_MICROSECONDS, FRAME_SECONDS));
  assert.closeTo(late, 10.2 + AUDIO_PLAYOUT_DELAY_SECONDS, 1e-9);
  assert.equal(scheduler.rebases, 1);
  const next = startAtOf(scheduler.schedule(10.21, 2 * FRAME_MICROSECONDS, FRAME_SECONDS));
  assert.closeTo(next, late + FRAME_SECONDS, 1e-9);
});

// 遅れが上限を超える音は捨て、基準をその音の長さだけ前に寄せる。次の音は捨てた音の時刻に
// 入るため、途切れずに遅れが縮む
test("schedule: 遅れが上限を超える音は捨て、次の音を捨てた音の時刻に入れる", () => {
  const scheduler = new AudioPlayoutScheduler();
  const first = startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS));
  // 同じ時刻にまとまって届いた音を並べると、遅れが上限に達する
  let lastStart = first;
  let index = 1;
  let decision = scheduler.schedule(10, index * FRAME_MICROSECONDS, FRAME_SECONDS);
  while (decision.kind === "play") {
    lastStart = decision.startAt;
    index += 1;
    decision = scheduler.schedule(10, index * FRAME_MICROSECONDS, FRAME_SECONDS);
  }
  assert.equal(scheduler.drops, 1);
  // 鳴らすと決めた音の遅れ (鳴らす時刻 - 今) は上限以下に収まる
  assert.isAtMost(lastStart - 10, AUDIO_PLAYOUT_MAX_DELAY_SECONDS + 1e-9);
  // 次の音は、捨てた音が入るはずだった時刻 (直前に鳴らすと決めた音の終わり) に鳴らす
  const next = startAtOf(scheduler.schedule(10.2, (index + 1) * FRAME_MICROSECONDS, FRAME_SECONDS));
  assert.closeTo(next, lastStart + FRAME_SECONDS, 1e-9);
});

// 並べる音が溜まっていないのに timestamp が大きく飛んだ (送る側の再起動、長い抜けなど) 音は、
// 捨て続けないよう基準を取り直して鳴らす
test("schedule: timestamp が大きく飛んだ音は基準を取り直して鳴らす", () => {
  const scheduler = new AudioPlayoutScheduler();
  const first = startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS));
  // 10 秒先の timestamp の音が、20 ms 後に届く
  const jumped = startAtOf(scheduler.schedule(10.02, 10_000_000, FRAME_SECONDS));
  assert.closeTo(jumped, first + FRAME_SECONDS, 1e-9);
  assert.equal(scheduler.rebases, 1);
  assert.equal(scheduler.drops, 0);
  const next = startAtOf(scheduler.schedule(10.04, 10_020_000, FRAME_SECONDS));
  assert.closeTo(next, jumped + FRAME_SECONDS, 1e-9);
});

// reset の後は、次の音で基準を作り直す (Play Audio の入れ直し、購読し直しなど)
test("reset: 次の音で基準を作り直す", () => {
  const scheduler = new AudioPlayoutScheduler();
  startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS));
  scheduler.reset();
  const startAt = startAtOf(scheduler.schedule(20, 5_000_000, FRAME_SECONDS));
  assert.closeTo(startAt, 20 + AUDIO_PLAYOUT_DELAY_SECONDS, 1e-9);
});

// 再生の遅れ、上限、余裕は指定できる
test("constructor: 再生の遅れ、上限、余裕を指定できる", () => {
  const scheduler = new AudioPlayoutScheduler({
    delaySeconds: 0.05,
    maxDelaySeconds: 0.1,
    minLeadSeconds: 0.005,
  });
  const startAt = startAtOf(scheduler.schedule(10, 0, FRAME_SECONDS));
  assert.closeTo(startAt, 10.05, 1e-9);
});
