/**
 * AudioData ソースの純関数の単体テスト
 *
 * Web Audio 経路は AudioWorklet から届いたサンプルを `AudioData` へ組み立てる。組み立ての
 * 計算 (ブロックの長さ・タイムスタンプ・f32-planar の並び) がずれると、音が崩れるか
 * タイムスタンプが実際とずれるため、ここで固定する。
 *
 * テスト方針 (ブラウザ経路の扱い):
 * createAudioFrameSource は MediaStreamTrackProcessor と Web Audio のどちらも実ブラウザの
 * 基盤 (AudioContext / AudioWorklet / AudioData) を必要とする。Node.js の単体テスト環境には
 * 存在せず、グローバルを差し替えて通すのはスタブを作ることにあたるため (AGENTS.md で禁止)、
 * 単体テストは可用性判定と純関数だけを対象とする。実ブラウザの経路は Playwright の e2e
 * (Chromium / WebKit) で確かめる。
 */

import { test, assert } from "vite-plus/test";
import {
  AUDIO_FRAME_BLOCK_MS,
  audioFrameOffsetMicros,
  buildAudioDataInit,
  concatPlanarChannels,
  isAudioFrameSourceAvailable,
  resolveAudioBlockFrames,
} from "./audioSource";

// Node.js 環境には MediaStreamTrackProcessor も AudioContext も無いため false を返す
test("isAudioFrameSourceAvailable は音声を取り出す経路が無い環境で false を返す", () => {
  assert.strictEqual(isAudioFrameSourceAvailable(), false);
});

test("resolveAudioBlockFrames は 10 ms 分のフレーム数を返す", () => {
  // まとめる長さは Chromium の MediaStreamTrackProcessor がマイクから読む間隔に合わせる
  assert.strictEqual(AUDIO_FRAME_BLOCK_MS, 10);
  assert.strictEqual(resolveAudioBlockFrames(48000), 480);
  assert.strictEqual(resolveAudioBlockFrames(44100), 441);
  assert.strictEqual(resolveAudioBlockFrames(24000), 240);
  // 極端に低いサンプルレートでも 0 フレームにしない (0 だとブロックが永久に埋まらない)
  assert.strictEqual(resolveAudioBlockFrames(8000), 80);
});

test("audioFrameOffsetMicros はフレーム数をマイクロ秒へ換算する", () => {
  assert.strictEqual(audioFrameOffsetMicros(0, 48000), 0);
  // 1 秒分はちょうど 1000000 マイクロ秒になる
  assert.strictEqual(audioFrameOffsetMicros(48000, 48000), 1_000_000);
  assert.strictEqual(audioFrameOffsetMicros(44100, 44100), 1_000_000);
  // 端数は丸める (AudioData.timestamp は整数でなければならない)
  assert.strictEqual(audioFrameOffsetMicros(480, 44100), 10_884);
});

test("audioFrameOffsetMicros はブロックを重ねても丸め誤差が積み上がらない", () => {
  // 48000 Hz で 10 ms のブロックを 1 時間分 (360000 ブロック) 並べても、1 秒あたりの
  // ずれが 1 マイクロ秒を超えないこと。ブロックごとに丸めるため、誤差は各ブロックで
  // 独立に 0.5 マイクロ秒以内に収まる
  const sampleRate = 48000;
  const blockFrames = resolveAudioBlockFrames(sampleRate);
  const blocks = 360_000;
  const expectedMicros = (blocks * blockFrames * 1_000_000) / sampleRate;
  const actualMicros = audioFrameOffsetMicros(blocks * blockFrames, sampleRate);
  assert.isAtMost(Math.abs(actualMicros - expectedMicros), 1, "1 時間で 1 マイクロ秒を超えた");
});

test("concatPlanarChannels はチャンネルごとのサンプルを連結する", () => {
  const left = new Float32Array([1, 2, 3]);
  const right = new Float32Array([4, 5, 6]);
  // f32-planar はチャンネルごとに連続させる (インターリーブではない)
  assert.deepStrictEqual([...concatPlanarChannels([left, right])], [1, 2, 3, 4, 5, 6]);
  // モノラルはそのまま
  assert.deepStrictEqual([...concatPlanarChannels([left])], [1, 2, 3]);
});

test("concatPlanarChannels は長さの揃わないブロックを拒否する", () => {
  // 長さがずれたまま f32-planar として渡すと、チャンネルの境目がずれて音が崩れる
  assert.throws(
    () => concatPlanarChannels([new Float32Array([1, 2]), new Float32Array([3])]),
    /same length/,
  );
  assert.throws(() => concatPlanarChannels([]), /no channel/);
});

test("buildAudioDataInit は配列の長さからフレーム数を決める", () => {
  const planar = new Float32Array([1, 2, 3, 4]);
  const init = buildAudioDataInit({
    startFrame: 480,
    sampleRate: 48000,
    channels: 2,
    originMicros: 1_700_000_000_000_000,
    planar,
  });
  assert.strictEqual(init.format, "f32-planar");
  assert.strictEqual(init.numberOfFrames, 2, "2 チャンネル × 2 フレームになる");
  assert.strictEqual(init.numberOfChannels, 2);
  assert.strictEqual(init.sampleRate, 48000);
  // 480 フレームは 10 ms であるため、原点から 10000 マイクロ秒後になる
  assert.strictEqual(init.timestamp, 1_700_000_000_010_000);
  assert.strictEqual(init.data, planar);
});

test("buildAudioDataInit はチャンネル数で割り切れないブロックを拒否する", () => {
  // 割り切れないまま numberOfFrames を決めると、実際のサンプル数と食い違って音が崩れる
  assert.throws(
    () =>
      buildAudioDataInit({
        startFrame: 0,
        sampleRate: 48000,
        channels: 2,
        originMicros: 0,
        planar: new Float32Array([1, 2, 3]),
      }),
    /multiple of channels/,
  );
  assert.throws(
    () =>
      buildAudioDataInit({
        startFrame: 0,
        sampleRate: 48000,
        channels: 0,
        originMicros: 0,
        planar: new Float32Array(0),
      }),
    /positive integer/,
  );
});
