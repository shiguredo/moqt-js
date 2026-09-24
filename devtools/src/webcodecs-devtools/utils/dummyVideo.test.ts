/**
 * dummy の映像の次に描くフレームの決め方 (nextDummyFrame) の単体テスト
 *
 * 境界 (時刻どおり、1 周期未満の遅れ、1 周期以上の遅れ) を固定する。任意のタイマーの
 * 遅れでずれが積み上がらないことは dummyVideo.prop.ts の PBT が固定する。
 * canvas と captureStream を使う createDummyVideoStream はブラウザで確かめる。
 */

import { test, assert } from "vite-plus/test";
import { nextDummyFrame } from "./dummyVideo";

// 25 fps のフレーム間隔 (ミリ秒)。整数にして浮動小数点の誤差を避ける
const FRAME_INTERVAL_MS = 40;

// フレーム 0 を 0 ms に描いた直後は、フレーム 1 を 40 ms に描く
test("nextDummyFrame: 次のフレームの時刻まで待つ", () => {
  assert.deepEqual(nextDummyFrame(0, FRAME_INTERVAL_MS, 0, 1), { frameIndex: 1, delayMs: 39 });
});

// フレーム 1 を 3 ms 遅れて (43 ms に) 描いても、フレーム 2 は 80 ms に描く。描いた時刻
// から 40 ms 待つと 83 ms になり、遅れが積み上がる
test("nextDummyFrame: タイマーの遅れを積み上げない", () => {
  assert.deepEqual(nextDummyFrame(0, FRAME_INTERVAL_MS, 1, 43), { frameIndex: 2, delayMs: 37 });
});

// フレーム 2 の時刻 (80 ms) を 1 周期未満過ぎた 100 ms では、待たずにフレーム 2 を描く
test("nextDummyFrame: 1 周期未満の遅れは待たずに描いて追いつく", () => {
  assert.deepEqual(nextDummyFrame(0, FRAME_INTERVAL_MS, 1, 100), { frameIndex: 2, delayMs: 0 });
});

// フレーム 1 を描いた後、130 ms まで止まった。フレーム 2 (80 ms) と 3 (120 ms) は描かずに
// 飛ばし、フレーム 4 を 160 ms に描く
test("nextDummyFrame: 1 周期以上遅れたら過ぎたフレームを飛ばす", () => {
  assert.deepEqual(nextDummyFrame(0, FRAME_INTERVAL_MS, 1, 130), { frameIndex: 4, delayMs: 30 });
});

// 最初のフレームを描いた時刻が 0 でなくても、そこからの経過で決める
test("nextDummyFrame: 最初のフレームを描いた時刻からの経過で決める", () => {
  assert.deepEqual(nextDummyFrame(1_000, FRAME_INTERVAL_MS, 9, 1_390), {
    frameIndex: 10,
    delayMs: 10,
  });
});
