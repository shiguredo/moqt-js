/** 実測の採否を決める条件を、不完全な入力で検査する。 */
import { test, assert } from "vite-plus/test";
import { requireAudioFrame, hasAvCoverage } from "./playout-measurement-guards.mjs";

test("欠落、順序ずれ、短い復号出力、非有限のサンプルを拒否する", () => {
  for (const frame of [
    undefined,
    { packetIndex: 2, samples: new Float32Array(960) },
    { packetIndex: 1, samples: new Float32Array(120) },
    { packetIndex: 1, samples: new Float32Array(960).fill(Number.NaN) },
  ]) {
    assert.throws(() => requireAudioFrame(frame, 1, 960));
  }
  const samples = new Float32Array(960).fill(0.3);
  assert.equal(requireAudioFrame({ packetIndex: 1, samples }, 1, 960), samples);
});

test("収録時間と実再生、実表示、対応する A/V の組をすべて要求する", () => {
  const complete = {
    seconds: 10,
    capturedSamples: 480000,
    audioCount: 450,
    videoCount: 270,
    pairCount: 270,
  };
  assert.equal(hasAvCoverage(complete), true);
  for (const field of ["capturedSamples", "audioCount", "videoCount", "pairCount"])
    assert.equal(hasAvCoverage({ ...complete, [field]: 0 }), false, field);
  assert.equal(hasAvCoverage({ ...complete, seconds: Number.NaN }), false);
  assert.equal(hasAvCoverage({ ...complete, pairCount: Infinity }), false);
  // 同一時刻だけで照合する 50 fps / 30 fps の測定は、共通する 10 fps の半分を必要とする。
  assert.equal(hasAvCoverage({ ...complete, pairCount: 90 }, 5), true);
  assert.equal(hasAvCoverage({ ...complete, pairCount: 0 }, 5), false);
});
