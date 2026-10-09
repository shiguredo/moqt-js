/**
 * 音声の TIMESTAMP を配信側の壁時計から作る規則の単体テスト
 *
 * マイクの `AudioData.timestamp` は壁時計ではないため (issues/0754)、そのままでは送れない。
 * 読み出した時刻を基準にし、記録が無いときだけ従来の換算へ落とす
 */

import { test, assert } from "vite-plus/test";
import { AUDIO_WALL_CLOCK_MAX_ENTRIES, AudioWallClockTimeline } from "./audioWallClock";

// 配信側の壁時計 (Unix epoch ミリ秒)
const EPOCH_MS = 1_790_263_445_000;

test("wallClockMicrosOf: 読み出しの壁時計をそのまま返す", () => {
  const timeline = new AudioWallClockTimeline();
  timeline.record(1_000_000, EPOCH_MS);
  // 1_000_000 マイクロ秒 = 1 秒ぶんの壁時計
  assert.equal(timeline.wallClockMicrosOf(1_000_000), BigInt(EPOCH_MS) * 1_000n);
});

// マイクの timestamp が壁時計から 300 ms ずれていても、送る値は読み出しの壁時計になる。
// ずれた timestamp をそのまま使うと、受信側が「音声が 300 ms 遅れている」と解釈して
// 映像をその分だけ遅らせる
test("wallClockMicrosOf: timestamp が壁時計からずれていても読み出しの壁時計を使う", () => {
  const timeline = new AudioWallClockTimeline();
  const shiftedTimestampMicros = 5_000_000 - 300_000;
  timeline.record(shiftedTimestampMicros, EPOCH_MS);
  assert.equal(timeline.wallClockMicrosOf(shiftedTimestampMicros), BigInt(EPOCH_MS) * 1_000n);
});

// 記録が無い (符号化されなかった、既に忘れた) ときは null を返し、呼び出し側が従来の
// 換算へ落とせるようにする
test("wallClockMicrosOf: 記録が無ければ null を返す", () => {
  const timeline = new AudioWallClockTimeline();
  assert.isNull(timeline.wallClockMicrosOf(1_000_000));
  timeline.record(1_000_000, EPOCH_MS);
  assert.isNull(timeline.wallClockMicrosOf(2_000_000));
});

// 符号化へ渡してから出力されるまでの間だけ覚える。上限を超えたら古い方から忘れる
test("record: 上限を超えたら古い記録から忘れる", () => {
  const timeline = new AudioWallClockTimeline();
  for (let index = 0; index < AUDIO_WALL_CLOCK_MAX_ENTRIES + 1; index++) {
    timeline.record(index * 1_000, EPOCH_MS + index);
  }
  assert.isNull(timeline.wallClockMicrosOf(0));
  assert.isNotNull(timeline.wallClockMicrosOf(AUDIO_WALL_CLOCK_MAX_ENTRIES * 1_000));
});

test("clear: 記録を消す (停止、やり直し)", () => {
  const timeline = new AudioWallClockTimeline();
  timeline.record(1_000_000, EPOCH_MS);
  timeline.clear();
  assert.isNull(timeline.wallClockMicrosOf(1_000_000));
});
