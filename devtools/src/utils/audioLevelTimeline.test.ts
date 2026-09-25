/**
 * AudioLevelTimeline の単体テスト
 *
 * RFC 6464 Section 3 は audio level を「ペイロードが符号化するサンプルの RMS」で -dBov
 * として測ると定める。符号化へ渡したサンプルを時刻つきで記録し、符号化された chunk の
 * 時間の範囲に重なる分から LOC Audio Level (draft-ietf-moq-loc-04 Section 2.3.3.2) を
 * 求める。
 */

import { test, assert } from "vite-plus/test";
import { AudioLevelTimeline } from "./audioLevelTimeline";
import { AUDIO_LEVEL_SILENCE, summarizeToneLevel } from "../webcodecs-devtools/utils/dummyAudio";

/** 振幅 amplitude の方形波 (RMS = amplitude) を count サンプル作る */
function square(amplitude: number, count: number): Float32Array {
  return Float32Array.from({ length: count }, (_value, index) =>
    index % 2 === 0 ? amplitude : -amplitude,
  );
}

// 10 ms の AudioData を 2 つ記録し、20 ms の chunk はその両方の RMS から求める
test("levelFor: chunk の範囲に重なる記録の RMS から -dBov を求める", () => {
  const timeline = new AudioLevelTimeline();
  const first = square(0.1, 480);
  const second = square(0.5, 480);
  timeline.record(0, 10_000, first);
  timeline.record(10_000, 10_000, second);

  const joined = new Float32Array([...first, ...second]);
  assert.deepEqual(timeline.levelFor(0, 20_000), summarizeToneLevel(joined));
});

// 範囲の外の記録は使わない (前の chunk の音や次の chunk の音を混ぜない)
test("levelFor: chunk の範囲の外の記録は使わない", () => {
  const timeline = new AudioLevelTimeline();
  timeline.record(0, 10_000, square(0.9, 480));
  timeline.record(10_000, 10_000, square(0.01, 480));
  timeline.record(20_000, 10_000, square(0.9, 480));

  assert.deepEqual(timeline.levelFor(10_000, 10_000), summarizeToneLevel(square(0.01, 480)));
});

// 無音と、記録が無い範囲は 127 (デジタル無音) にする
test("levelFor: 無音と記録の無い範囲は 127 にする", () => {
  const timeline = new AudioLevelTimeline();
  timeline.record(0, 10_000, new Float32Array(480));
  assert.equal(timeline.levelFor(0, 10_000).level, AUDIO_LEVEL_SILENCE);
  assert.equal(timeline.levelFor(50_000, 10_000).level, AUDIO_LEVEL_SILENCE);
});

// duration が分からない chunk は 20 ms とみなす
test("levelFor: duration が無い chunk は 20 ms の範囲で求める", () => {
  const timeline = new AudioLevelTimeline();
  timeline.record(0, 10_000, square(0.5, 480));
  timeline.record(10_000, 10_000, square(0.5, 480));
  timeline.record(20_000, 10_000, square(0.001, 480));

  assert.deepEqual(timeline.levelFor(0, null), summarizeToneLevel(square(0.5, 960)));
});

// chunk を求めた後は、その chunk より前に終わる記録を捨てる (記録を際限なく溜めない)
test("levelFor: 求めた chunk より前に終わる記録を捨てる", () => {
  const timeline = new AudioLevelTimeline();
  timeline.record(0, 10_000, square(0.5, 480));
  timeline.record(10_000, 10_000, square(0.5, 480));
  timeline.levelFor(10_000, 10_000);
  assert.equal(timeline.size, 1);
  assert.equal(timeline.levelFor(0, 10_000).level, AUDIO_LEVEL_SILENCE);
});

// chunk が出てこない (符号化が止まった) 間も記録は上限までしか溜めない
test("record: 記録は上限までしか溜めない", () => {
  const timeline = new AudioLevelTimeline(4);
  for (let index = 0; index < 10; index++) {
    timeline.record(index * 10_000, 10_000, square(0.5, 480));
  }
  assert.equal(timeline.size, 4);
});
