import { test, assert } from "vite-plus/test";
import {
  EMPTY_PUBLISH_TIMING,
  PUBLISH_TIMING_WINDOW_MS,
  PublishTimingStats,
} from "./publishTimingStats";

// 30 fps のフレームの timestamp の間隔 (マイクロ秒)
const FRAME_MICROS = 33_333;

// 読んでから encoder の出力までを符号化、出力から sendObject の完了までを送信の時間にする。
// 3 枚のフレームを読み、それぞれ 2 / 3 / 4 ms で出力し、1 / 1 / 5 ms で送り終えた
test("snapshot: 符号化と送信の時間をフレームごとに対応づけて求める", () => {
  const stats = new PublishTimingStats();
  const encodeMs = [2, 3, 4];
  const sendMs = [1, 1, 5];
  for (let index = 0; index < 3; index++) {
    const timestampMicros = index * FRAME_MICROS;
    const readAtMs = 1_000 + index * 33;
    stats.recordRead(timestampMicros, readAtMs);
    const encodedAtMs = readAtMs + (encodeMs[index] ?? 0);
    stats.recordEncoded(timestampMicros, encodedAtMs);
    stats.recordSent(timestampMicros, encodedAtMs + (sendMs[index] ?? 0));
  }

  const snapshot = stats.snapshot(1_100);
  assert.deepEqual(snapshot.encodeMs, { p50: 3, p95: 4, max: 4 });
  assert.deepEqual(snapshot.sendMs, { p50: 1, p95: 5, max: 5 });
  assert.equal(snapshot.encodeQueueDrops, 0);
});

// encoder の待ちが上限を超えて符号化せずに捨てたフレームを数える。捨てたフレームの
// 読んだ時刻は残さない
test("recordEncodeQueueDrop: 符号化せずに捨てたフレームを数える", () => {
  const stats = new PublishTimingStats();
  stats.recordRead(0, 1_000);
  stats.recordEncodeQueueDrop(0);
  stats.recordRead(FRAME_MICROS, 1_033);
  stats.recordEncodeQueueDrop(FRAME_MICROS);
  // 捨てたフレームの出力は来ない。来ても対応づけない
  stats.recordEncoded(0, 1_040);

  const snapshot = stats.snapshot(1_040);
  assert.equal(snapshot.encodeQueueDrops, 2);
  assert.isNull(snapshot.encodeMs);
});

// 読んだ記録や出力の記録が無いフレームは対応づけない
test("recordEncoded / recordSent: 前の記録が無いフレームは数えない", () => {
  const stats = new PublishTimingStats();
  stats.recordEncoded(0, 1_000);
  stats.recordSent(0, 1_001);
  const snapshot = stats.snapshot(1_001);
  assert.isNull(snapshot.encodeMs);
  assert.isNull(snapshot.sendMs);
});

// 窓より前の記録は分布に含めず、対応づけられなかった記録も窓を過ぎたら捨てる
test("snapshot: 窓より前の記録を分布に含めず、古い記録を捨てる", () => {
  const stats = new PublishTimingStats();
  stats.recordRead(0, 0);
  stats.recordEncoded(0, 2);
  stats.recordSent(0, 3);
  // 窓を過ぎた後に読んだフレームを記録すると、出力されなかった古い記録を捨てる
  stats.recordRead(FRAME_MICROS, 5);
  stats.recordRead(FRAME_MICROS * 2, PUBLISH_TIMING_WINDOW_MS + 100);
  stats.recordEncoded(FRAME_MICROS, PUBLISH_TIMING_WINDOW_MS + 101);

  const snapshot = stats.snapshot(PUBLISH_TIMING_WINDOW_MS + 101);
  assert.isNull(snapshot.encodeMs, "窓より前の符号化の時間と、捨てた記録を含めないこと");
  assert.isNull(snapshot.sendMs);
});

// 配信を始め直したときは、前の配信の記録を持ち越さない
test("reset: 記録をすべて捨てる", () => {
  const stats = new PublishTimingStats();
  stats.recordRead(0, 1_000);
  stats.recordEncoded(0, 1_002);
  stats.recordSent(0, 1_003);
  stats.recordRead(FRAME_MICROS, 1_033);
  stats.recordEncodeQueueDrop(FRAME_MICROS);
  stats.reset();
  assert.deepEqual(stats.snapshot(1_040), EMPTY_PUBLISH_TIMING);
});
