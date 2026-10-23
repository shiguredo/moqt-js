/**
 * 再生の入口 (`MediaPlayout`) の単体テスト
 *
 * WebCodecs の `AudioData` / `VideoFrame` はブラウザにしか無いため、このファイルでは
 * 「時間軸・計器・セッションの組み立て」「統計」「設定」「ライフサイクル」を実クラスで
 * 検証する。実 `AudioData` / `VideoFrame` / `AudioContext` を使う再生の経路は
 * tests/e2e の playout のスペックが担当する。
 */

import { test, assert } from "vite-plus/test";
import { AudioPlayoutTimingStats } from "./audioPlayoutTimingStats";
import { createMediaPlayout, MediaPlayout } from "./mediaPlayout";
import type { AudioPlayoutContext } from "./audioPlayoutSession";
import type { VideoPlayoutOutput } from "./videoPlayoutSession";

/**
 * 映像の出し先
 *
 * このファイルでは `VideoFrame` を作れない (Node に WebCodecs が無い) ため、表示まで進む
 * 経路は検証しない。出し先が呼ばれたら、検証していない経路へ進んだことが分かるようにする。
 */
function createVideoOutput(): VideoPlayoutOutput {
  return {
    isAvailable: () => false,
    present: () => {
      throw new Error("video output must not be used in unit tests");
    },
  };
}

/** 映像を表示する構成 (音声なし) の入口を作る */
function createVideoPlayout(): MediaPlayout {
  return createMediaPlayout({ video: { output: createVideoOutput() } });
}

test("createMediaPlayout: 音声も映像も指定しないとエラーになる", () => {
  // 何もしない入口を作ると、呼び出し側は再生しているつもりで気付かない
  assert.throws(() => createMediaPlayout({}), /at least one of audio or video must be specified/);
});

test("createMediaPlayout: 音声の context だけを指定するとエラーになる", () => {
  // 片方だけでは鳴らせない。黙って鳴らさない設定へ倒すと、呼び出し側は気付かない。
  // コンストラクタは AudioContext のメソッドを呼ばないため、構造だけ満たす値で確かめられる
  const context = {} as AudioPlayoutContext;
  assert.throws(
    () => createMediaPlayout({ audio: { context } }),
    /audio context and destination must be specified together/,
  );
});

test("getStats: 音声だけの構成では映像と同期の推定値を返さない", () => {
  const playout = createMediaPlayout({ audio: {} });
  const stats = playout.getStats();
  // 音声の統計は返す (鳴らす先が無くても計器は持つ)
  assert.isNotNull(stats.audio);
  assert.isNull(stats.video);
  // 揃える相手がいないため、同期の推定値は作らない
  assert.isNull(stats.avSync);
});

test("getStats: 映像だけの構成では音声を返さない", () => {
  const playout = createVideoPlayout();
  const stats = playout.getStats();
  assert.isNull(stats.audio);
  assert.isNotNull(stats.video);
  // 表示待ちは空であり、表示の遅れもまだ観測していない
  assert.strictEqual(stats.video?.queuedFrames, 0);
  assert.isNull(stats.video?.playoutDelayMs);
  assert.isNull(stats.avSync);
});

test("getStats: 時間軸を使わない構成では同期の推定値を返さない", () => {
  // jitter buffer を無効にすると、時間軸へ記録しないため同期の推定値を出せない
  const playout = createMediaPlayout({
    audio: {},
    video: { output: createVideoOutput() },
    jitterBuffer: false,
  });
  assert.isNull(playout.getStats().avSync);
});

test("getStats: 音声と映像の両方で時間軸を使うときは同期の推定値を返す", () => {
  const playout = createMediaPlayout({
    audio: {},
    video: { output: createVideoOutput() },
  });
  const avSync = playout.getStats().avSync;
  assert.isNotNull(avSync);
  // まだ何も観測していないため、基準と表示の遅れは決まっていない
  assert.isNull(avSync?.skewMs);
  assert.isNull(avSync?.presentationDelayMs);
  assert.isNull(avSync?.targetLatencyMs);
  assert.strictEqual(avSync?.targetLatencyLimitedMs, 0);
  // 音声を鳴らしていないため、時計の代用も起きていない
  assert.isFalse(avSync?.audioClockFallback);
  // 遅延の内訳は常に返す (遅延の解析に使う)
  assert.isNotNull(avSync?.delays);
});

test("setTargetLatencyMs: 目標の遅延と音声の閉ループの上限へ反映する", () => {
  const playout = createMediaPlayout({
    audio: {},
    video: { output: createVideoOutput() },
    targetLatencyMs: 300,
  });
  // 構築時に渡した値が同期の推定値と閉ループの上限の両方へ入る
  // (draft-ietf-moq-msf-01 §5.2.8 の MUST: 同じ render group の track は同じ値)
  assert.strictEqual(playout.getStats().avSync?.targetLatencyMs, 300);
  assert.strictEqual(playout.getAudioDelayFeedback().ceilingMs, 300);

  // 購読の途中で catalog の値が変わったときも同じ経路で変えられる
  playout.setTargetLatencyMs(500);
  assert.strictEqual(playout.getStats().avSync?.targetLatencyMs, 500);
  assert.strictEqual(playout.getAudioDelayFeedback().ceilingMs, 500);

  // null は目標を使わない (宣言が無い) ことを意味する
  playout.setTargetLatencyMs(null);
  assert.isNull(playout.getStats().avSync?.targetLatencyMs);
  assert.isNull(playout.getAudioDelayFeedback().ceilingMs);
});

test("getAudioDelayFeedback: 音声を観測していないときは初期値の内訳を返す", () => {
  const playout = createMediaPlayout({ audio: {} });
  const feedback = playout.getAudioDelayFeedback();
  // 目標を動かした回数は 0、上限の指定は無い
  assert.strictEqual(feedback.adjustments, 0);
  assert.isNull(feedback.ceilingMs);
  // 適用する目標は、揺らぎから求めた値以上になる (初期値でも 0 未満にはならない)
  assert.isAtLeast(feedback.appliedMs, 0);
});

test("drainAudio: 音声を使わない構成では待たずに 0 を返す", async () => {
  const playout = createVideoPlayout();
  const result = await playout.drainAudio();
  assert.strictEqual(result.pendingMsAtStart, 0);
  assert.strictEqual(result.cutMs, 0);
  assert.strictEqual(result.waitedMs, 0);
});

test("drainAudio: 音声を使って予約が無いときはすぐに終わる", async () => {
  const playout = createMediaPlayout({ audio: {} });
  const result = await playout.drainAudio();
  assert.strictEqual(result.pendingMsAtStart, 0);
  assert.strictEqual(result.cutMs, 0);
  assert.strictEqual(result.undecodedFlushedObjects, 0);
});

test("getStats: 渡した計器へ記録した内容を同じ窓で返す", () => {
  const timing = new AudioPlayoutTimingStats(10_000, performance.timeOrigin);
  const playout = createMediaPlayout({ audio: { timing } });
  // 呼び出し側が計器へ記録した内容 (鳴った音) を、統計の同じ窓から読める
  timing.recordPlay(0, 50, 50, 20, "timestamp");
  const stats = playout.getStats();
  assert.strictEqual(stats.audio?.timing.playedFrames, 1);
  // 再生の累積は共有実装の予約から読む。まだ 1 件も鳴らしていない
  assert.strictEqual(stats.audio?.rebases, 0);
  assert.strictEqual(stats.audio?.drops, 0);
  assert.strictEqual(stats.audio?.concealments, 0);
  assert.strictEqual(stats.audio?.compressedMs, 0);
  assert.strictEqual(stats.audio?.concealedMs, 0);
  assert.strictEqual(stats.audio?.latenessMs, 0);
  // 受信側の追いつきもまだ観測していない
  assert.isNull(stats.audio?.catchUp.lagMs);
});

test("reset: 計器と時間軸の状態を持ったまま呼んでも壊れない", () => {
  const timing = new AudioPlayoutTimingStats(10_000, performance.timeOrigin);
  const playout = createMediaPlayout({
    audio: { timing },
    video: { output: createVideoOutput() },
  });
  // 復号前の遅延を変えたときの基準の取り直しは、実際に観測がある状態で呼ばれる。
  // ここでは、観測が無い状態でも例外を投げず、消えるものが消えることだけを確かめる
  assert.doesNotThrow(() => {
    playout.reset();
    playout.resetAudioStream();
    playout.recordAudioStopped();
    playout.clearVideo();
    playout.releaseAudioContext();
    playout.setAudioOutput(null);
  });
  // 計器の累積は reset では消えない (購読の統計として引き継ぐ)
  assert.strictEqual(timing.snapshot(performance.now()).playedFrames, 0);
});
