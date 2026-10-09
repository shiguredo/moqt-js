/**
 * A/V 同期の状態遷移の検出の単体テスト
 *
 * 「基準を共有できているか」と「できていない理由」が変わった時点だけを 1 件にする。
 * この 1 件が、A/V のずれが広がった時点を relay のログと突き合わせるための手掛かりになる。
 */

import { test, assert } from "vite-plus/test";
import { EMPTY_AV_SYNC, type AvSyncSnapshot } from "../signals/subscriber";
import { detectAvSyncTransition, type AvSyncState } from "./avSyncTransition";

/** 内訳を上書きした snapshot を作る (既定値は未観測のまま) */
function snapshotWith(options: {
  sharingBases: boolean;
  unsharedReason: AvSyncSnapshot["delays"]["unsharedReason"];
  skewMs?: number | null;
  baseDifferenceMs?: number | null;
  baseDriftMsPerSecond?: number | null;
}): AvSyncSnapshot {
  return {
    ...EMPTY_AV_SYNC,
    skewMs: options.skewMs ?? null,
    delays: {
      ...EMPTY_AV_SYNC.delays,
      sharingBases: options.sharingBases,
      unsharedReason: options.unsharedReason,
      baseDifferenceMs: options.baseDifferenceMs ?? null,
      baseDriftMsPerSecond: options.baseDriftMsPerSecond ?? null,
    },
  };
}

// 最初の 1 回は「変わったとき」ではないため、ログを出さない。状態だけを次へ渡す
test("detectAvSyncTransition: 最初の 1 回はログを出さず、状態だけを返す", () => {
  const transition = detectAvSyncTransition(
    null,
    snapshotWith({ sharingBases: false, unsharedReason: "drift", baseDriftMsPerSecond: 48 }),
    "sub-1",
  );
  assert.isNull(transition.log);
  assert.deepEqual(transition.state, { sharing: false, reason: "drift" });
});

// 同じ状態が続く間はログを出さない。500 ms ごとに読むため、毎回出すとログが埋まる
test("detectAvSyncTransition: 状態が変わらなければログを出さない", () => {
  const previous: AvSyncState = { sharing: true, reason: "none" };
  const transition = detectAvSyncTransition(
    previous,
    snapshotWith({ sharingBases: true, unsharedReason: "none" }),
    "sub-1",
  );
  assert.isNull(transition.log);
  assert.deepEqual(transition.state, previous);
});

// ドリフトで共有が切れた時点は、A/V のずれが広がり得るため warn にし、数値を一緒に残す。
// 数値が無いと、ずれが時計のずれによるものか経路の遅れによるものかをログから辿れない
test("detectAvSyncTransition: 共有が切れたら数値付きの warn を出す", () => {
  const transition = detectAvSyncTransition(
    { sharing: true, reason: "none" },
    snapshotWith({
      sharingBases: false,
      unsharedReason: "drift",
      skewMs: 419.6,
      baseDifferenceMs: 1302,
      baseDriftMsPerSecond: 48,
    }),
    "sub-2",
  );
  assert.isNotNull(transition.log);
  assert.equal(transition.log?.level, "warn");
  assert.equal(transition.log?.message, "[sub-2] A/V sync bases shared -> unshared");
  assert.deepEqual(transition.log?.data, {
    reason: "drift",
    skewMs: 419.6,
    baseDifferenceMs: 1302,
    baseDriftMsPerSecond: 48,
    audio: EMPTY_AV_SYNC.delays.audio,
    video: EMPTY_AV_SYNC.delays.video,
  });
});

// 理由だけが変わったとき (差が上限を超えた -> 動き続けている) も、状態が変わったため残す
test("detectAvSyncTransition: 理由だけが変わったときもログを出す", () => {
  const transition = detectAvSyncTransition(
    { sharing: false, reason: "difference" },
    snapshotWith({ sharingBases: false, unsharedReason: "drift" }),
    "sub-3",
  );
  assert.isNotNull(transition.log);
  assert.equal(transition.log?.level, "warn");
  assert.equal(transition.log?.message, "[sub-3] A/V sync bases unshared -> unshared");
});

// 共有が戻った時点は、原因が収まった手掛かりになるため info にする
test("detectAvSyncTransition: 共有が戻ったら info を出す", () => {
  const transition = detectAvSyncTransition(
    { sharing: false, reason: "difference" },
    snapshotWith({ sharingBases: true, unsharedReason: "none" }),
    "sub-4",
  );
  assert.isNotNull(transition.log);
  assert.equal(transition.log?.level, "info");
  assert.equal(transition.log?.message, "[sub-4] A/V sync bases unshared -> shared");
});
