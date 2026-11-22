import { assert, test } from "vite-plus/test";
import {
  describeLiveAudio,
  judgeLiveAudio,
  LIVE_AUDIO_LAG_MS,
  LIVE_AUDIO_START_DELAY_MS,
  type LiveAudioSample,
} from "./liveAudio";

/** 実リレーの成功時に近い観測値 */
const BASE: LiveAudioSample = {
  playbackEnabled: true,
  lagMs: 169,
  startDelayMs: 81,
  receiveDelayMs: 170,
};

/** 窓内のサンプルを作る (指定した値だけを上書きする) */
function sample(overrides: Partial<LiveAudioSample>): LiveAudioSample {
  return { ...BASE, ...overrides };
}

test("受信遅れが 1 点だけ跳ねても、復号済み音声が新しければ live", () => {
  const judgement = judgeLiveAudio([sample({ receiveDelayMs: 359 })]);
  assert.isTrue(judgement.live);
  assert.equal(judgement.reason, "live");
  // 受信の遅れは捨てず、失敗時の診断に使えるよう結果へ残す
  assert.equal(judgement.receiveDelayMs, 359);
});

test("復号済み音声が古い系列は cache の再生として live ではない", () => {
  const judgement = judgeLiveAudio(
    Array.from({ length: 5 }, () => sample({ lagMs: 6_000, receiveDelayMs: 170 })),
  );
  assert.isFalse(judgement.live);
  assert.equal(judgement.reason, "decodedAudioIsOld");
});

test("窓の中の 1 点だけ古い復号結果でも、中央値が新しければ live", () => {
  const lags = [6_000, 169, 169, 169, 169];
  const judgement = judgeLiveAudio(lags.map((lagMs) => sample({ lagMs })));
  assert.isTrue(judgement.live);
  assert.equal(judgement.lagMs, 169);
});

test("再生していない、復号していない、鳴り始めが遅い系列は live ではない", () => {
  const notPlaying = judgeLiveAudio([sample({ playbackEnabled: false })]);
  assert.isFalse(notPlaying.live);
  assert.equal(notPlaying.reason, "notPlaying");

  const noDecodedAudio = judgeLiveAudio([sample({ lagMs: null })]);
  assert.isFalse(noDecodedAudio.live);
  assert.equal(noDecodedAudio.reason, "noDecodedAudio");

  const lateStart = judgeLiveAudio([sample({ startDelayMs: LIVE_AUDIO_START_DELAY_MS })]);
  assert.isFalse(lateStart.live);
  assert.equal(lateStart.reason, "startIsLate");

  const unknownStart = judgeLiveAudio([sample({ startDelayMs: null })]);
  assert.isFalse(unknownStart.live);
  assert.equal(unknownStart.reason, "startIsLate");

  const empty = judgeLiveAudio([]);
  assert.isFalse(empty.live);
  assert.equal(empty.reason, "notPlaying");
});

test("判定の説明に、判定に使った中央値と診断値の受信遅れを出す", () => {
  const judgement = judgeLiveAudio([sample({ lagMs: LIVE_AUDIO_LAG_MS, receiveDelayMs: 359 })]);
  assert.equal(
    describeLiveAudio(judgement),
    "reason=decodedAudioIsOld, lagMs=300.0, startDelayMs=81.0, receiveDelayMs=359.0",
  );
});
