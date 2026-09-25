/**
 * dummy の映像の次に描くフレームの決め方 (nextDummyFrame) の単体テスト
 *
 * 境界 (時刻どおり、1 周期未満の遅れ、1 周期以上の遅れ) を固定する。任意のタイマーの
 * 遅れでずれが積み上がらないことは dummyVideo.prop.ts の PBT が固定する。
 * canvas と captureStream を使う createDummyVideoStream はブラウザで確かめる。
 */

import { test, assert } from "vite-plus/test";
import {
  nextDummyFrame,
  formatDummyElapsed,
  formatDummyStartDateTime,
  dummyCenterFontSize,
} from "./dummyVideo";

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

// Sora-DevTools のフェイク映像と同じ、中央の経過時間
test("formatDummyElapsed: 経過時間を mmmm:ss.SSS にする", () => {
  assert.equal(formatDummyElapsed(0), "0000:00.000");
  assert.equal(formatDummyElapsed(61_234), "0001:01.234");
  assert.equal(formatDummyElapsed(3_661_009), "0061:01.009");
});

// 上部に出す開始日時。ローカル時刻
test("formatDummyStartDateTime: ローカル時刻を YYYY-MM-DD HH:mm:ss にする", () => {
  assert.equal(formatDummyStartDateTime(new Date(2026, 8, 25, 23, 55, 7)), "2026-09-25 23:55:07");
});

// 中央の文字は短い辺の 15%。11 文字を超えたらその分だけ縮める
test("dummyCenterFontSize: 11 文字までは短い辺の 15% で、超えたら縮む", () => {
  assert.equal(dummyCenterFontSize(1280, 720, 11), 108);
  assert.equal(dummyCenterFontSize(1280, 720, 22), 54);
});
