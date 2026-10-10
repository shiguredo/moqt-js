/**
 * 前提から外れた状態の検出の単体テスト
 *
 * 判定の境目 (閾値ちょうど、続いた時間、窓の長さ) を固定する。閾値を動かすときは、この
 * テストが「何が変わったか」を示す。閾値そのものは実装の定数を import して使う
 * (数値を書き写すと、実装を変えたときにテストだけが古い値を守り続ける)。
 */

import { test, assert } from "vite-plus/test";
import type { AudioPublishCatchUpStats } from "../../../src/audioPublishCatchUp.ts";
import type { AudioTimestampOffsetStats } from "../../../src/audioTimestampClock.ts";
import {
  PLAYOUT_BASE_UNSHARED_HOLD_MS,
  PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS,
} from "../../../src/playbackTimeline.ts";
import { EMPTY_AV_SYNC, type AvSyncSnapshot } from "../signals/subscriber.ts";
import {
  CATCH_UP_WARN_STARTS,
  CATCH_UP_WARN_WINDOW_MS,
  EMPTY_PUBLISHER_WARNING_STATE,
  SYNC_PINNED_MIN_MS,
  SYNC_PINNED_TOLERANCE_MS,
  TIMESTAMP_SLOPE_MIN_SAMPLES,
  TIMESTAMP_SLOPE_WARN_MS_PER_SECOND,
  UNSHARED_HOLD_WARN_MS,
  detectPublisherWarnings,
  detectSubscriberWarnings,
  formatPreconditionWarning,
  type PublisherWarningState,
} from "./preconditionWarnings";

/** 上限に張り付いている状態の最小の補償量 (ミリ秒) */
const PINNED_EXTRA_MS = PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS - SYNC_PINNED_TOLERANCE_MS;

/** 内訳を上書きした同期の推定値を作る (既定値は未観測のまま) */
function avSyncWith(options: {
  sharingBases?: boolean;
  unsharedReason?: AvSyncSnapshot["delays"]["unsharedReason"];
  audioExtraMs?: number;
  videoExtraMs?: number;
  baseDifferenceMs?: number | null;
  baseDriftMsPerSecond?: number | null;
  baseUnsharedReturnMs?: number | null;
  presentationDelayCapMs?: number;
}): AvSyncSnapshot {
  return {
    ...EMPTY_AV_SYNC,
    delays: {
      ...EMPTY_AV_SYNC.delays,
      audio: { ...EMPTY_AV_SYNC.delays.audio, syncExtraDelayMs: options.audioExtraMs ?? 0 },
      video: { ...EMPTY_AV_SYNC.delays.video, syncExtraDelayMs: options.videoExtraMs ?? 0 },
      sharingBases: options.sharingBases ?? true,
      unsharedReason: options.unsharedReason ?? "none",
      baseDifferenceMs: options.baseDifferenceMs ?? null,
      baseDriftMsPerSecond: options.baseDriftMsPerSecond ?? null,
      baseUnsharedReturnMs: options.baseUnsharedReturnMs ?? null,
      presentationDelayCapMs: options.presentationDelayCapMs ?? 400,
    },
  };
}

/** 配信側の TIMESTAMP の補正の観測を作る */
function offsetWith(options: {
  samples?: number;
  slope60sMsPerSecond?: number | null;
  slope10sMsPerSecond?: number | null;
}): AudioTimestampOffsetStats {
  return {
    currentMs: 100,
    minMs: 90,
    maxMs: 110,
    // null (傾きを出せるだけの観測が無い) と 0 (動いていない) を区別する
    slope10sMsPerSecond:
      options.slope10sMsPerSecond === undefined ? 0 : options.slope10sMsPerSecond,
    slope60sMsPerSecond:
      options.slope60sMsPerSecond === undefined ? 0 : options.slope60sMsPerSecond,
    appliedMs: 95,
    samples: options.samples ?? TIMESTAMP_SLOPE_MIN_SAMPLES,
  };
}

/** 配信側の追いつきの観測を作る */
function catchUpWith(options: {
  catchUpStarts: number;
  policy?: AudioPublishCatchUpStats["policy"];
  droppedFrames?: number;
  droppedMs?: number;
}): AudioPublishCatchUpStats {
  return {
    policy: options.policy ?? "drop",
    droppedFrames: options.droppedFrames ?? options.catchUpStarts * 3,
    droppedMs: options.droppedMs ?? options.catchUpStarts * 60,
    lagMs: 120,
    floorMs: 30,
    maxLagMs: 130,
    pendingMs: 0,
    readLagMs: 0,
    pendingFrames: 0,
    catchingUp: false,
    catchUpStarts: options.catchUpStarts,
  };
}

// 補償が上限に達していない (差が上限 + 不感帯より小さい) 間は、残るずれが上限の分では
// ないため警告を出さない。張り付きとみなす幅の境目を固定する
test("detectSubscriberWarnings: 補償が上限の手前のうちは警告を出さない", () => {
  const update = detectSubscriberWarnings(
    null,
    avSyncWith({ videoExtraMs: PINNED_EXTRA_MS - 0.1 }),
    0,
  );
  assert.deepEqual(update.warnings, []);
  // 一度も張り付いていないため、状態も数えていない
  assert.isNull(update.state.syncPinnedSinceMs);
});

// 上限の手前まで達したら数え始める。閾値そのものは実装の値を使う
test("detectSubscriberWarnings: 補償が上限に達したら数え始める", () => {
  const update = detectSubscriberWarnings(
    null,
    avSyncWith({ videoExtraMs: PINNED_EXTRA_MS }),
    1_000,
  );
  assert.deepEqual(update.warnings, []);
  assert.equal(update.state.syncPinnedSinceMs, 1_000);
});

// 張り付いたまま `SYNC_PINNED_MIN_MS` 続いたときだけ警告を出す。境目の前後で分ける
test("detectSubscriberWarnings: 上限に張り付いたままの時間が境目を超えたら警告を出す", () => {
  const pinned = avSyncWith({ videoExtraMs: PINNED_EXTRA_MS, baseDifferenceMs: 250 });
  const before = detectSubscriberWarnings(null, pinned, 1_000);
  const almost = detectSubscriberWarnings(before.state, pinned, 1_000 + SYNC_PINNED_MIN_MS - 1);
  assert.deepEqual(almost.warnings, []);

  const over = detectSubscriberWarnings(almost.state, pinned, 1_000 + SYNC_PINNED_MIN_MS);
  assert.lengthOf(over.warnings, 1);
  const [warning] = over.warnings;
  assert.equal(warning?.id, "syncExtraDelayPinnedAtLimit");
  // 見直す判断 (定数名) と、判定に使った計器の値が入っていること
  assert.equal(warning?.decision, "PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS");
  assert.include(warning?.values.join(", "), `limitMs=${PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS}`);
  assert.include(warning?.values.join(", "), "baseDifferenceMs=250.0 ms");
  assert.include(warning?.message, "A/V skew");
});

// 一過性 (上限に達してすぐ戻った) では警告を出さない。状態も消して次に数え直す
test("detectSubscriberWarnings: 上限から戻ったら数え直す", () => {
  const pinned = detectSubscriberWarnings(
    null,
    avSyncWith({ videoExtraMs: PINNED_EXTRA_MS }),
    1_000,
  );
  const released = detectSubscriberWarnings(pinned.state, avSyncWith({ videoExtraMs: 10 }), 3_000);
  assert.isNull(released.state.syncPinnedSinceMs);

  const again = detectSubscriberWarnings(
    released.state,
    avSyncWith({ videoExtraMs: PINNED_EXTRA_MS }),
    5_000,
  );
  assert.isNull(again.warnings[0] ?? null);
  assert.equal(again.state.syncPinnedSinceMs, 5_000);
});

// 基準を共有していない間は、足した分を戻すため上限に留まらない。上限に達していても
// 「上限のため A/V のずれが残る」状態ではないため警告を出さない
test("detectSubscriberWarnings: 基準を共有していない間は上限の張り付きとみなさない", () => {
  const update = detectSubscriberWarnings(
    null,
    avSyncWith({
      sharingBases: false,
      unsharedReason: "drift",
      videoExtraMs: PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS,
    }),
    0,
  );
  assert.deepEqual(update.warnings, []);
  assert.isNull(update.state.syncPinnedSinceMs);
});

// 保持 (hold) が `UNSHARED_HOLD_WARN_MS` 続いたときだけ警告を出す
test("detectSubscriberWarnings: 共有の解除の保持が長く続いたら警告を出す", () => {
  const holding = avSyncWith({
    sharingBases: false,
    unsharedReason: "hold",
    baseDifferenceMs: 180,
    presentationDelayCapMs: 400,
  });
  const start = detectSubscriberWarnings(null, holding, 10_000);
  const before = detectSubscriberWarnings(start.state, holding, 10_000 + UNSHARED_HOLD_WARN_MS - 1);
  assert.deepEqual(before.warnings, []);

  const over = detectSubscriberWarnings(before.state, holding, 10_000 + UNSHARED_HOLD_WARN_MS);
  assert.lengthOf(over.warnings, 1);
  const [warning] = over.warnings;
  assert.equal(warning?.id, "unsharedHoldContinues");
  assert.equal(warning?.decision, "PLAYOUT_BASE_UNSHARED_HOLD_MS");
  assert.include(warning?.values.join(", "), `heldMs=${UNSHARED_HOLD_WARN_MS}`);
  // 警告を出す時間は保持そのもの (30 秒) より短い。満了を待つと、見直す前に戻ってしまう
  assert.isBelow(UNSHARED_HOLD_WARN_MS, PLAYOUT_BASE_UNSHARED_HOLD_MS);
});

// 理由が hold から変わったら数え直す。ドリフトの判定が出ている間は、保持ではなく
// 「差が動き続けている」ことが原因であり、見直す判断が変わる
test("detectSubscriberWarnings: 共有できない理由が変わったら数え直す", () => {
  const holding = detectSubscriberWarnings(
    null,
    avSyncWith({ sharingBases: false, unsharedReason: "hold" }),
    0,
  );
  const drifted = detectSubscriberWarnings(
    holding.state,
    avSyncWith({ sharingBases: false, unsharedReason: "drift", baseDriftMsPerSecond: 40 }),
    UNSHARED_HOLD_WARN_MS,
  );
  assert.deepEqual(drifted.warnings, []);
  assert.isNull(drifted.state.unsharedHoldSinceMs);
});

// 傾きが閾値の手前のうちは警告を出さない。負の向き (音声の時計が遅れる) も同じ大きさで見る
test("detectPublisherWarnings: 補正の傾きが閾値の手前のうちは警告を出さない", () => {
  const under = detectPublisherWarnings(
    null,
    {
      timestampOffset: offsetWith({
        slope60sMsPerSecond: TIMESTAMP_SLOPE_WARN_MS_PER_SECOND - 0.1,
      }),
      catchUp: catchUpWith({ catchUpStarts: 0 }),
    },
    0,
  );
  assert.deepEqual(under.warnings, []);

  const exactly = detectPublisherWarnings(
    under.state,
    {
      timestampOffset: offsetWith({ slope60sMsPerSecond: TIMESTAMP_SLOPE_WARN_MS_PER_SECOND }),
      catchUp: catchUpWith({ catchUpStarts: 0 }),
    },
    1_000,
  );
  assert.lengthOf(exactly.warnings, 1);
  assert.equal(exactly.warnings[0]?.id, "timestampOffsetKeepsMoving");

  const negative = detectPublisherWarnings(
    null,
    {
      timestampOffset: offsetWith({ slope60sMsPerSecond: -TIMESTAMP_SLOPE_WARN_MS_PER_SECOND }),
      catchUp: catchUpWith({ catchUpStarts: 0 }),
    },
    2_000,
  );
  assert.lengthOf(negative.warnings, 1);
  assert.include(negative.warnings[0]?.values.join(", "), "slope60sMsPerSecond=-5.0 ms");
});

// 観測が窓を埋めるまで (10 秒分) は判定しない。配信を始めた直後の傾きは安定していない
test("detectPublisherWarnings: 観測が窓を埋めるまでは傾きを判定しない", () => {
  const update = detectPublisherWarnings(
    null,
    {
      timestampOffset: offsetWith({
        slope60sMsPerSecond: TIMESTAMP_SLOPE_WARN_MS_PER_SECOND * 4,
        samples: TIMESTAMP_SLOPE_MIN_SAMPLES - 1,
      }),
      catchUp: catchUpWith({ catchUpStarts: 0 }),
    },
    0,
  );
  assert.deepEqual(update.warnings, []);
});

// 60 秒の傾きが無いときは 10 秒の傾きで見る (60 秒の窓を埋める前でも、動き続けていれば
// 早く気づける)。どちらも無ければ判定しない
test("detectPublisherWarnings: 60 秒の傾きが無いときは 10 秒の傾きで判定する", () => {
  const update = detectPublisherWarnings(
    null,
    {
      timestampOffset: offsetWith({
        slope60sMsPerSecond: null,
        slope10sMsPerSecond: TIMESTAMP_SLOPE_WARN_MS_PER_SECOND + 1,
      }),
      catchUp: catchUpWith({ catchUpStarts: 0 }),
    },
    0,
  );
  assert.lengthOf(update.warnings, 1);
  assert.equal(update.warnings[0]?.id, "timestampOffsetKeepsMoving");

  const none = detectPublisherWarnings(
    null,
    {
      timestampOffset: offsetWith({ slope60sMsPerSecond: null, slope10sMsPerSecond: null }),
      catchUp: catchUpWith({ catchUpStarts: 0 }),
    },
    0,
  );
  assert.deepEqual(none.warnings, []);
});

// 追いつきの開始回数は、窓 (60 秒) の中で増えた分で見る。観測は 1 秒ごと
// (signals/preconditionWatch.ts と同じ間隔) に行い、窓が埋まる前と、増加が閾値の手前の
// うちは警告を出さない
test("detectPublisherWarnings: 追いつきの回数が窓の中で閾値に達したら警告を出す", () => {
  const input = (catchUpStarts: number) => ({
    timestampOffset: offsetWith({}),
    catchUp: catchUpWith({ catchUpStarts }),
  });
  // 1 秒ごとに観測した結果を次へ渡す
  let state: PublisherWarningState | null = null;
  const observe = (nowMs: number, catchUpStarts: number) => {
    const update = detectPublisherWarnings(state, input(catchUpStarts), nowMs);
    state = update.state;
    return update.warnings;
  };

  observe(0, 0);
  for (let nowMs = 1_000; nowMs < CATCH_UP_WARN_WINDOW_MS; nowMs += 1_000) {
    assert.deepEqual(observe(nowMs, 0), []);
  }
  // 窓 (60 秒) がちょうど埋まった時点でも、増加が閾値の手前なら出さない
  assert.deepEqual(observe(CATCH_UP_WARN_WINDOW_MS, CATCH_UP_WARN_STARTS - 1), []);

  const over = observe(CATCH_UP_WARN_WINDOW_MS + 1_000, CATCH_UP_WARN_STARTS);
  assert.lengthOf(over, 1);
  const [warning] = over;
  assert.equal(warning?.id, "catchUpKeepsStarting");
  assert.equal(warning?.decision, "AUDIO_PUBLISH_CATCH_UP_GROWTH_MS");
  assert.include(warning?.values.join(", "), `startsInWindow=${CATCH_UP_WARN_STARTS}`);
  assert.include(warning?.values.join(", "), "policy=drop");
  // 窓の中だけを持ち、観測のたびに古い記録を捨てる
  assert.equal(
    (state as PublisherWarningState | null)?.catchUpSamples.length,
    CATCH_UP_WARN_WINDOW_MS / 1_000 + 1,
  );
});

// 配信をやり直すと累積の回数は 0 に戻る。減ったら記録を捨て、やり直した後の分だけで数える。
// 捨てないと、前の配信の回数と比べて増加が負になり、やり直しが警告として現れない
test("detectPublisherWarnings: 配信をやり直したら追いつきの記録を捨てる", () => {
  const input = (catchUpStarts: number) => ({
    timestampOffset: null,
    catchUp: catchUpWith({ catchUpStarts }),
  });
  const before = detectPublisherWarnings(null, input(10), 0);
  const restarted = detectPublisherWarnings(before.state, input(0), 30_000);
  assert.deepEqual(restarted.warnings, []);
  assert.deepEqual(restarted.state.catchUpSamples, [{ atMs: 30_000, starts: 0 }]);
});

// 窓の外の記録は捨てる。捨てないと、窓の中で増えていないのに前の増加が残り続ける
test("detectPublisherWarnings: 窓の外の記録は捨てる", () => {
  const input = {
    timestampOffset: null,
    catchUp: catchUpWith({ catchUpStarts: 0 }),
  };
  let state: PublisherWarningState | null = EMPTY_PUBLISHER_WARNING_STATE;
  for (let nowMs = 0; nowMs <= CATCH_UP_WARN_WINDOW_MS; nowMs += 1_000) {
    state = detectPublisherWarnings(state, input, nowMs).state;
  }
  // 60 秒 + 1 回分だけ残る (1 秒ごとに観測するため)
  assert.equal(state?.catchUpSamples.length, CATCH_UP_WARN_WINDOW_MS / 1_000 + 1);
});

// 画面 1 行は識別子で始まり、判定に使った値を括弧の中に並べる。どの計器を見ればよいかを
// 行だけで分かるようにする
test("formatPreconditionWarning: 識別子と本文と値を 1 行にする", () => {
  const line = formatPreconditionWarning({
    id: "catchUpKeepsStarting",
    decision: "AUDIO_PUBLISH_CATCH_UP_GROWTH_MS",
    message: "Audio catch-up started 3 times.",
    values: ["catchUpStarts=7", "startsInWindow=3"],
  });
  assert.equal(
    line,
    "catchUpKeepsStarting: Audio catch-up started 3 times. (catchUpStarts=7, startsInWindow=3)",
  );
});
