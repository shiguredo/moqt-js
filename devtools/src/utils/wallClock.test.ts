import { test, assert } from "vite-plus/test";
import { createWallClockAnchor, toWallClockMicroseconds } from "./wallClock";

// 2026-09-25 付近の壁時計 (ミリ秒)。performance.timeOrigin + performance.now() の値に相当する
const WALL_CLOCK_MILLIS = 1_790_263_445_102.099;

// canvas の captureStream() のフレームは stream の開始 (0) を基準にする。
// 最初のフレームを読んだときの壁時計に、フレームの timestamp の差を足して換算する
test("toWallClockMicroseconds: 基準が 0 のフレームを最初のフレームの壁時計から換算する", () => {
  const anchor = createWallClockAnchor(0, WALL_CLOCK_MILLIS);

  // 対応をとったフレーム自身は、そのときの壁時計 (マイクロ秒、整数に丸める) になる
  assert.equal(toWallClockMicroseconds(0, anchor), 1_790_263_445_102_099n);
  // 1 フレーム (33,333 マイクロ秒) 後のフレームは、その分だけ後の壁時計になる
  assert.equal(toWallClockMicroseconds(33_333, anchor), 1_790_263_445_135_432n);
});

// fake camera のフレームは performance.now() とも stream の開始とも異なる大きな値を
// 基準にする。基準に依らず、最初のフレームの壁時計からの差で換算できる
test("toWallClockMicroseconds: 基準が大きな値のフレームも最初のフレームの壁時計から換算する", () => {
  const firstFrameMicros = 289_052_241_600;
  const anchor = createWallClockAnchor(firstFrameMicros, WALL_CLOCK_MILLIS);

  assert.equal(toWallClockMicroseconds(firstFrameMicros, anchor), 1_790_263_445_102_099n);
  assert.equal(toWallClockMicroseconds(firstFrameMicros + 66_666, anchor), 1_790_263_445_168_765n);
});

// 最初のフレームより前の timestamp (取得元が巻き戻した場合など) も差をそのまま引く。
// ただし Unix epoch より前 (負) にはしない (LOC の TIMESTAMP は vi64 で負を表せない)
test("toWallClockMicroseconds: 最初のフレームより前の timestamp は差を引き、負にはしない", () => {
  const anchor = createWallClockAnchor(1_000_000, WALL_CLOCK_MILLIS);
  assert.equal(toWallClockMicroseconds(0, anchor), 1_790_263_444_102_099n);

  const nearEpoch = createWallClockAnchor(1_000_000, 0.5);
  assert.equal(toWallClockMicroseconds(0, nearEpoch), 0n);
});
