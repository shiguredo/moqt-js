/**
 * 棄却で飛んだ境目のフェード (`fadeSpliceEdge`) の単体テスト
 *
 * 端が 0 になり、落とす長さの外は元のままであること、元の配列を変えないことを固定する。
 * 符号化へ渡す直前の使い方 (1 フレームの先読み) は devtools の配信経路が持つ
 */

import { test, assert } from "vite-plus/test";
import { AUDIO_SPLICE_FADE_MS, fadeSpliceEdge } from "./audioSpliceFade";
import type { AudioSamples } from "./audioTimeStretch";

/** Opus の 1 フレーム (8 ms、16 kHz) */
const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 128;

/** 一定値のフレームを作る (端の変化を読みやすくする) */
function constantFrame(value = 0.5): AudioSamples {
  const samples = new Float32Array(FRAME_SAMPLES);
  samples.fill(value);
  return samples;
}

// 落とす長さ (2 ms = 32 サンプル)。この分だけ端が 0 へ向かう
const FADE_SAMPLES = Math.round((AUDIO_SPLICE_FADE_MS / 1_000) * SAMPLE_RATE);

test("fadeSpliceEdge: 先頭を 0 から立ち上げ、落とす長さの外は元のまま", () => {
  const faded = fadeSpliceEdge([constantFrame()], SAMPLE_RATE, "head")[0] ?? new Float32Array(0);
  assert.equal(faded[0], 0, "先頭が 0 になること");
  assert.closeTo(faded[FADE_SAMPLES] ?? 0, 0.5, 1e-6, "落とす長さの外は元の値");
  assert.equal(faded[FRAME_SAMPLES - 1], 0.5, "末尾は元のまま");
  assert.equal(faded.length, FRAME_SAMPLES, "長さが変わらないこと");
});

test("fadeSpliceEdge: 末尾を 0 へ落とし、落とす長さの外は元のまま", () => {
  const faded = fadeSpliceEdge([constantFrame()], SAMPLE_RATE, "tail")[0] ?? new Float32Array(0);
  assert.equal(faded[FRAME_SAMPLES - 1], 0, "末尾が 0 になること");
  assert.closeTo(faded[FRAME_SAMPLES - 1 - FADE_SAMPLES] ?? 0, 0.5, 1e-6, "落とす長さの外は元の値");
  assert.equal(faded[0], 0.5, "先頭は元のまま");
});

test("fadeSpliceEdge: 元の配列を変えず、チャンネルごとに同じ長さを返す", () => {
  const frame = constantFrame();
  const faded = fadeSpliceEdge([frame, frame], SAMPLE_RATE, "head");
  assert.equal(frame[0], 0.5, "元の配列は変わらないこと");
  assert.equal(faded.length, 2, "チャンネル数が変わらないこと");
  assert.equal(faded[1]?.[0], 0, "すべてのチャンネルの先頭が 0 になること");
});
