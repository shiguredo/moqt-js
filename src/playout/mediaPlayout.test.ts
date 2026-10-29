/**
 * 再生の入口 (`MediaPlayout`) の単体テスト
 *
 * WebCodecs の `AudioData` / `VideoFrame` はブラウザにしか無いため、このファイルでは
 * 「時間軸・計器・セッションの組み立て」「統計」「設定と検証」「状態の破棄」「ライフサイクル」を
 * 実クラスで検証する。実 `AudioData` / `VideoFrame` / `AudioContext` を使う再生の経路は
 * tests/e2e の playout のスペックが担当する。
 */

import { test, assert } from "vite-plus/test";
import {
  playoutAudioClockOf,
  playoutInternalsOf,
  playoutVideoSessionOf,
} from "../testSupport/mediaPlayoutInternals";
import type { AudioPlayoutContext } from "./audioPlayoutSession";
import { AudioPlayoutTimingStats } from "./audioPlayoutTimingStats";
import { createMediaPlayout, type MediaPlayout } from "./mediaPlayout";
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

/** 映像を構成する入口 (音声なし) */
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

test("createMediaPlayout: 範囲外の数値オプションはエラーになる", () => {
  // 負の maxQueuedFrames は PlayoutBuffer の追い出しが終わらず、最初の pushVideo で
  // 固まる。数値の設定は入口で弾く (preDecodeDelayMs の検証と同じ方針)
  assert.throws(
    () => createMediaPlayout({ audio: {}, maxQueuedFrames: -1 }),
    /maxQueuedFrames must be an integer >= 1, got -1/,
  );
  assert.throws(
    () => createMediaPlayout({ audio: {}, maxQueuedFrames: 0 }),
    /maxQueuedFrames must be an integer >= 1/,
  );
  assert.throws(
    () => createMediaPlayout({ audio: {}, maxQueuedFrames: 1.5 }),
    /maxQueuedFrames must be an integer >= 1/,
  );
  assert.throws(
    () => createMediaPlayout({ audio: {}, maxQueuedFrames: Number.NaN }),
    /maxQueuedFrames must be an integer >= 1/,
  );
  assert.throws(
    () => createMediaPlayout({ audio: {}, decodeInputs: { maxTracked: 0 } }),
    /decodeInputs.maxTracked must be an integer >= 1/,
  );
  assert.throws(
    () => createMediaPlayout({ audio: {}, intentionalDelayMs: -1 }),
    /intentionalDelayMs must be a finite number >= 0/,
  );
  assert.throws(
    () => createMediaPlayout({ audio: {}, targetLatencyMs: -5 }),
    /targetLatencyMs must be a finite number >= 0/,
  );
});

test("getStats: 音声だけの構成では映像と同期の推定値を返さない", () => {
  const playout = createMediaPlayout({ audio: {} });
  const stats = playout.getStats();
  // 音声を構成していれば、鳴らす先が無くても計器と統計は返す
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

test("maxQueuedFrames: 映像の表示待ちのキューの上限へ渡す", () => {
  // 公開オプションの上限が時間軸だけでなく映像のキューにも効くことを固定する。片方だけに
  // 渡すと、devtools が jitter buffer 無効時に指定する 12 枚が効かなくなる
  const playout = createMediaPlayout({
    video: { output: createVideoOutput() },
    maxQueuedFrames: 2,
  });
  const session = playoutVideoSessionOf(playout);
  // 表示待ちのバッファをテストの中だけで直接駆動する (VideoFrame は Node に無いため、
  // バッファが読む timestamp と close だけを持つ最小のオブジェクトを渡す)
  const buffer = session.playout;
  const evicted: VideoFrame[] = [];
  for (let index = 0; index < 3; index++) {
    const frame = {
      timestamp: 1_000_000 + index,
      close: () => undefined,
    } as unknown as VideoFrame;
    evicted.push(...buffer.enqueue(frame, null));
  }
  // 上限 2 枚を超えた 1 枚が追い出される (既定 24 のままなら 3 枚とも残る)
  assert.strictEqual(buffer.size, 2);
  assert.strictEqual(evicted.length, 1);
});

test("drainAudio: 待ちの条件と flush の件数をセッションへ渡す", async () => {
  // 上限と flush の待ち条件がセッションへ届くことを固定する。上限の転送が落ちると
  // 既定の 300 ms まで待つ (返り値の requestedMs で見る)
  const playout = createMediaPlayout({ audio: {} });
  const result = await playout.drainAudio({
    maxWaitMs: 40,
    flushedObjects: 2,
    isFlushSettled: () => false,
    remainingFlushedObjects: () => 1,
  });
  assert.strictEqual(result.flushedObjects, 2);
  assert.strictEqual(result.undecodedFlushedObjects, 1);
  // ここでは maxWaitMs: 40 を指定しているため、返る上限も 40 になる
  assert.strictEqual(result.requestedMs, 40);
  assert.isAtLeast(result.waitedMs, 20);
  assert.strictEqual(result.pendingMsAtStart, 0);
});

test("decodeInputs: 上限と重複の扱いを音声と映像の対応表へ渡す", () => {
  // 既定値を固定する変異で全テストが通らないよう、上限と forgetOnDuplicate が両方の
  // 対応表へ届くことを固定する
  const playout = createMediaPlayout({
    audio: {},
    video: { output: createVideoOutput() },
    decodeInputs: { maxTracked: 2, forgetOnDuplicate: true },
  });
  const internals = playoutInternalsOf(playout);
  for (let index = 0; index < 3; index++) {
    playout.trackAudioDecodeInput(1_000_000 + index, { timestampKind: "wallClock" });
  }
  for (let index = 0; index < 3; index++) {
    playout.trackVideoDecodeInput(2_000_000 + index, {
      timestampKind: "wallClock",
      location: { group: BigInt(index), object: 1n },
    });
  }
  // 上限 2 件を超えた分は古い方から忘れる
  assert.strictEqual(internals.audioInputs.size, 2);
  assert.strictEqual(internals.videoInputs.size, 2);
  // 同じ TIMESTAMP の記録が重なったら、その TIMESTAMP の分を忘れる (音声・映像とも)
  playout.trackAudioDecodeInput(1_000_002, { timestampKind: "mediaTime" });
  assert.strictEqual(internals.audioInputs.size, 1);
  playout.trackVideoDecodeInput(2_000_002, {
    timestampKind: "mediaTime",
    location: { group: 2n, object: 2n },
  });
  assert.strictEqual(internals.videoInputs.size, 1);
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

test("setTargetLatencyMs: catalog の目標を保持し、未観測の出力先行量を捏造しない", () => {
  const playout = createMediaPlayout({
    audio: {},
    video: { output: createVideoOutput() },
    targetLatencyMs: 300,
  });
  // 構築時に渡した値が同期の推定値と表示の下限へ入る
  assert.strictEqual(playout.getStats().avSync?.targetLatencyMs, 300);
  assert.isNull(playout.getStats().audio?.delay.outputLeadMs);

  // 購読の途中で catalog の値が変わったときも同じ経路で変えられる
  playout.setTargetLatencyMs(500);
  assert.strictEqual(playout.getStats().avSync?.targetLatencyMs, 500);
  assert.isNull(playout.getStats().audio?.delay.outputLeadMs);

  // null は目標を使わない (宣言が無い) ことを意味する
  playout.setTargetLatencyMs(null);
  assert.isNull(playout.getStats().avSync?.targetLatencyMs);
  assert.equal(playout.getStats().audio?.delay.targetMs, 50);

  // 負の値は受け付けない (表示の遅れが負になる)
  assert.throws(
    () => playout.setTargetLatencyMs(-1),
    /targetLatencyMs must be a finite number >= 0, got -1/,
  );
});

test("drainAudio: 音声を使わない構成では待たずに 0 を返す", async () => {
  const playout = createVideoPlayout();
  const result = await playout.drainAudio();
  assert.strictEqual(result.pendingMsAtStart, 0);
  assert.strictEqual(result.cutMs, 0);
  assert.strictEqual(result.waitedMs, 0);
});

test("drainAudio: 待ちの上限の不正な値はエラーになる", async () => {
  // NaN を通すと待ちの判定が常に偽になり、停止が返らなくなる
  const playout = createMediaPlayout({ audio: {} });
  // Chai の assert には rejects が無いため、reject を捕まえて確かめる
  const capture = async (run: () => Promise<unknown>): Promise<Error | null> => {
    try {
      await run();
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  };
  const nanError = await capture(() => playout.drainAudio({ maxWaitMs: Number.NaN }));
  assert.isNotNull(nanError);
  assert.match(nanError?.message ?? "", /maxWaitMs must be a finite number >= 0/);
  const negativeError = await capture(() => playout.drainAudio({ maxWaitMs: -1 }));
  assert.isNotNull(negativeError);
  assert.match(negativeError?.message ?? "", /maxWaitMs must be a finite number >= 0/);
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

test("clearAll: 時間軸・復号入力の対応表・映像待ちを捨て、計器の累積は残す", () => {
  const timing = new AudioPlayoutTimingStats(10_000, performance.timeOrigin);
  const playout = createMediaPlayout({
    audio: { timing },
    video: { output: createVideoOutput() },
  });
  const internals = playoutInternalsOf(playout);
  playout.trackAudioDecodeInput(1_000_000, { timestampKind: "wallClock" });
  playout.trackVideoDecodeInput(2_000_000, {
    timestampKind: "wallClock",
    location: { group: 1n, object: 2n },
  });
  // 表示待ちに実フレームを 1 枚積む (Node に VideoFrame が無いため最小のオブジェクト)
  let closed = 0;
  const frame = {
    timestamp: 2_000_000,
    close: () => {
      closed++;
    },
  } as unknown as VideoFrame;
  const session = playoutVideoSessionOf(playout);
  session.playout.enqueue(frame, null);
  timing.recordPlay(0, 50, 50, 20, "timestamp");
  // 時間軸の世代を進めておく (observe の有無を世代で観測できる)
  internals.timeline.observe("audio", 10_000, 1_000_000);
  const generation = internals.timeline.generation;

  playout.clearAll();

  // 復号へ渡した入力の対応表・時間軸・表示待ちが初期化される
  assert.strictEqual(internals.audioInputs.size, 0);
  assert.strictEqual(internals.videoInputs.size, 0);
  assert.strictEqual(session.playout.size, 0);
  assert.strictEqual(closed, 1);
  assert.notStrictEqual(internals.timeline.generation, generation);
  // 計器の累積は停止直後の統計として残る
  assert.strictEqual(playout.getStats().audio?.timing.playedFrames, 1);
});

test("resetPlayout: 映像の対応表と時間軸・追いつきの観測を取り直す", () => {
  const playout = createMediaPlayout({
    audio: {},
    video: { output: createVideoOutput() },
  });
  const internals = playoutInternalsOf(playout);
  playout.trackVideoDecodeInput(2_000_000, {
    timestampKind: "wallClock",
    location: { group: 1n, object: 2n },
  });
  // 追いつきの観測を 1 件入れる (観測は lagMs に現れる)
  internals.audio?.session.catchUp.observe({
    nowMs: 1_000,
    lagMs: 100,
    durationMs: 20,
    timestampMicros: 900_000,
  });
  const generation = internals.timeline.generation;

  playout.resetPlayout();

  assert.strictEqual(internals.videoInputs.size, 0);
  assert.notStrictEqual(internals.timeline.generation, generation);
  assert.isNull(playout.getStats().audio?.catchUp.lagMs);
});

test("resetAudioPlayback: 音声の予約の基準と追いつきの観測を取り直す", () => {
  const playout = createMediaPlayout({ audio: {} });
  const internals = playoutInternalsOf(playout);
  internals.audio?.session.catchUp.observe({
    nowMs: 1_000,
    lagMs: 100,
    durationMs: 20,
    timestampMicros: 900_000,
  });
  assert.strictEqual(playout.getStats().audio?.catchUp.lagMs, 100);

  const clock = playoutAudioClockOf(playout);
  clock.update({ contextTime: 10, performanceTime: 1_000 }, 10, 1_000);
  assert.strictEqual(clock.currentOffsetMs, 9_000);

  playout.resetAudioPlayback();

  assert.isNull(playout.getStats().audio?.catchUp.lagMs);
  // 予約の基準 (時計の対応) も取り直す
  assert.isNull(clock.currentOffsetMs);
  assert.isFalse(clock.usingFallback);
});

test("track*: 構成していない media への記録は何もしない", () => {
  // 映像なしの入口では映像の記録を残さず、音声なしの入口では音声の記録を残さない
  const audioOnly = createMediaPlayout({ audio: {} });
  audioOnly.trackAudioDecodeInput(1_000_000, { timestampKind: "wallClock" });
  audioOnly.trackVideoDecodeInput(2_000_000, {
    timestampKind: "wallClock",
    location: { group: 1n, object: 2n },
  });
  const audioInternals = playoutInternalsOf(audioOnly);
  assert.strictEqual(audioInternals.audioInputs.size, 1);
  assert.strictEqual(audioInternals.videoInputs.size, 0);

  const videoOnly = createVideoPlayout();
  videoOnly.trackAudioDecodeInput(1_000_000, { timestampKind: "wallClock" });
  videoOnly.trackVideoDecodeInput(2_000_000, {
    timestampKind: "wallClock",
    location: { group: 1n, object: 2n },
  });
  const videoInternals = playoutInternalsOf(videoOnly);
  assert.strictEqual(videoInternals.audioInputs.size, 0);
  assert.strictEqual(videoInternals.videoInputs.size, 1);
});

test("pushVideo: 映像を構成していない入口ではフレームを閉じて skipped を返す", () => {
  // 映像を使わない入口でも、呼び出し側が渡したフレームの所有権は入口が引き取る
  const playout = createMediaPlayout({ audio: {} });
  let closed = 0;
  const frame = {
    timestamp: 1_000_000,
    close: () => {
      closed++;
    },
  } as unknown as VideoFrame;

  const result = playout.pushVideo(frame);

  assert.strictEqual(result.status, "skipped");
  assert.strictEqual(closed, 1);
  assert.strictEqual(playoutInternalsOf(playout).videoInputs.size, 0);
});

test("setAudioOutput(null): 閉じた AudioContext の時計の対応を捨てる", () => {
  // 閉じた Context の時計の対応を残すと、次に鳴らすときに古い対応で予約する。null を
  // 渡したときに releaseAudioContext が呼ばれていることを固定する
  const playout = createMediaPlayout({
    audio: { context: {} as AudioPlayoutContext, destination: {} as AudioNode },
  });
  const clock = playoutAudioClockOf(playout);
  clock.update({ contextTime: 10, performanceTime: 1_000 }, 10, 1_000);
  assert.strictEqual(clock.currentOffsetMs, 9_000);

  playout.setAudioOutput(null);

  assert.isNull(clock.currentOffsetMs);
  assert.isFalse(clock.usingFallback);
  assert.isNull(clock.toAudioSeconds(5_000));
});

test("resetAudioPlayback: 映像の表示待ちを残し、resetPlayout は捨てる", () => {
  // devtools は音声だけを止めるときに resetAudioPlayback を選び、映像を止めない
  const playout = createMediaPlayout({
    audio: {},
    video: { output: createVideoOutput() },
  });
  const session = playoutVideoSessionOf(playout);
  let closed = 0;
  const frame = {
    timestamp: 1_000_000,
    close: () => {
      closed++;
    },
  } as unknown as VideoFrame;
  session.playout.enqueue(frame, null);
  assert.strictEqual(session.playout.size, 1);

  playout.resetAudioPlayback();

  // 音声の状態だけを取り直すため、映像の表示待ちは残る
  assert.strictEqual(session.playout.size, 1);
  assert.strictEqual(closed, 0);

  playout.resetPlayout();

  // 映像の表示待ちは捨て、フレームを閉じる
  assert.strictEqual(session.playout.size, 0);
  assert.strictEqual(closed, 1);
});

test("setAudioOutput: 音声を構成していない入口ではエラーになる", () => {
  // 音声を構成していないのに出力を付けても、pushAudio は何もしない。黙って受け取らずに
  // 設定の誤りとして返す
  const playout = createVideoPlayout();
  assert.throws(
    () => playout.setAudioOutput(null),
    /audio is not configured: pass MediaPlayoutOptions.audio/,
  );
});

test("setIntentionalDelayMs: 負の値はエラーになる", () => {
  const playout = createMediaPlayout({ audio: {} });
  assert.throws(
    () => playout.setIntentionalDelayMs(-1),
    /intentionalDelayMs must be a finite number >= 0/,
  );
  // 0 以上は受け付ける
  assert.doesNotThrow(() => playout.setIntentionalDelayMs(0));
  assert.doesNotThrow(() => playout.setIntentionalDelayMs(250));
});

test("getStats: 未観測の揺らぎと出力時計は null、音声のみの予算は 50 ms である", () => {
  const playout = createMediaPlayout({ audio: {} });
  assert.deepEqual(playout.getStats().audio?.delay, {
    jitterMs: null,
    outputLeadMs: null,
    targetMs: 50,
  });
});
