/**
 * session/endOfGroupTracking.ts の単体テスト
 *
 * draft-ietf-moq-transport-22 §12.1 (Malformed Track) の条件 4:
 * "An Object is received in a Group whose Object ID is larger than the final
 *  Object in the Group."
 * の判定に使う Group 単位の最終 Object ID 追跡について、記録・取得・上書き・
 * Track Alias 単位の破棄と、上限を超えたときの破棄順を検証する。
 *
 * 追跡状態は実 Map を使い、操作はすべて実装本体の関数を呼んで行う。
 */

import { test, assert } from "vite-plus/test";
import {
  clearEndOfGroupTracking,
  getEndOfGroupFinalObjectId,
  recordEndOfGroupFinalObjectId,
  type EndOfGroupTracking,
} from "./endOfGroupTracking";

/** 空の追跡状態を作る */
function createTracking(): EndOfGroupTracking {
  return new Map<bigint, Map<bigint, bigint>>();
}

// ============================================================================
// 記録と取得
// ============================================================================

/**
 * 記録した Group の最終 Object ID は Track Alias と Group ID の組で取得できる。
 * 未登録の Group と未登録の Track Alias は undefined になる。
 */
test("recordEndOfGroupFinalObjectId: 記録した最終 Object ID を Track Alias と Group から取得できる", () => {
  const tracking = createTracking();

  recordEndOfGroupFinalObjectId(tracking, 1n, 10n, 5n);
  recordEndOfGroupFinalObjectId(tracking, 1n, 11n, 3n);
  recordEndOfGroupFinalObjectId(tracking, 2n, 10n, 99n);

  assert.equal(getEndOfGroupFinalObjectId(tracking, 1n, 10n), 5n);
  assert.equal(getEndOfGroupFinalObjectId(tracking, 1n, 11n), 3n);
  // 同じ Group ID でも Track Alias が違えば別のエントリである
  assert.equal(getEndOfGroupFinalObjectId(tracking, 2n, 10n), 99n);
  // 未登録の Group は undefined
  assert.isUndefined(getEndOfGroupFinalObjectId(tracking, 1n, 12n));
  // 未登録の Track Alias は undefined
  assert.isUndefined(getEndOfGroupFinalObjectId(tracking, 3n, 10n));
});

/**
 * 同じ Track Alias と同じ Group の記録は新規挿入ではなく上書きである。Group ごとの
 * エントリは増えず、最終 Object ID だけが新しい値になる。
 */
test("recordEndOfGroupFinalObjectId: 同じ Group の記録は最終 Object ID を上書きする", () => {
  const tracking = createTracking();

  recordEndOfGroupFinalObjectId(tracking, 1n, 10n, 5n);
  recordEndOfGroupFinalObjectId(tracking, 1n, 10n, 7n);

  assert.equal(getEndOfGroupFinalObjectId(tracking, 1n, 10n), 7n);
  assert.equal(tracking.get(1n)?.size, 1);
});

/**
 * 上限まで埋まった Track Alias で既存 Group を上書きしても、他の Group は破棄
 * されない。破棄ループを新しい Group を挿入するときだけ回す根拠である。
 */
test("recordEndOfGroupFinalObjectId: 既存 Group の上書きでは他の Group を破棄しない", () => {
  const tracking = createTracking();

  // 上限 (1024) 分の Group を 0 から挿入順に登録する
  for (let index = 0; index < 1024; index++) {
    recordEndOfGroupFinalObjectId(tracking, 1n, BigInt(index), BigInt(index));
  }

  // 最も新しい Group 1023 を上書きする。上書きでも破棄ループを回すと、最も古い
  // Group 0 が破棄されてしまう
  recordEndOfGroupFinalObjectId(tracking, 1n, 1023n, 9999n);

  assert.equal(tracking.get(1n)?.size, 1024);
  assert.equal(getEndOfGroupFinalObjectId(tracking, 1n, 0n), 0n);
  assert.equal(getEndOfGroupFinalObjectId(tracking, 1n, 1023n), 9999n);
});

// ============================================================================
// 追跡状態の上限
// §12.1 条件 4 の判定は確定済みの最終 Object ID を必要とするため、上限を超えた
// 場合は最も古いエントリを破棄する (破棄した範囲では判定できない)。
// ============================================================================

/**
 * 1 つの Track Alias の Group 数が上限を超えると、最も古い Group から破棄される。
 * 破棄した Group は未登録になり、最終 Object ID を取得できない。上限は Track
 * Alias ごとであり、別の Track Alias の Group は影響を受けない。
 */
test("recordEndOfGroupFinalObjectId: 1 Track Alias の Group 数が上限を超えると最古の Group を破棄する", () => {
  const tracking = createTracking();

  // 上限 (1024) 分の Group を 0 から挿入順に登録する
  for (let index = 0; index < 1024; index++) {
    recordEndOfGroupFinalObjectId(tracking, 1n, BigInt(index), BigInt(index));
  }
  // 1025 件目で最古の Group 0 が破棄される
  recordEndOfGroupFinalObjectId(tracking, 1n, 1024n, 1024n);

  assert.equal(tracking.get(1n)?.size, 1024);
  assert.isUndefined(getEndOfGroupFinalObjectId(tracking, 1n, 0n));
  assert.equal(getEndOfGroupFinalObjectId(tracking, 1n, 1024n), 1024n);

  // 別の Track Alias は同じ上限を独立に持つ
  for (let index = 0; index < 1024; index++) {
    recordEndOfGroupFinalObjectId(tracking, 2n, BigInt(index), BigInt(index));
  }
  assert.equal(tracking.get(2n)?.size, 1024);
  assert.equal(getEndOfGroupFinalObjectId(tracking, 2n, 0n), 0n);
});

/**
 * Track Alias 数が上限を超えると、最も古い Track Alias のエントリが丸ごと破棄
 * される。その Track Alias が持っていた Group ごとのエントリもまとめて消える。
 *
 * 最古の Track Alias には Group を複数登録しておく。Group が 1 件だけだと、
 * 内側の Map ごと破棄したのか Group を 1 件破棄しただけなのかを区別できない。
 */
test("recordEndOfGroupFinalObjectId: Track Alias 数が上限を超えると最古の Track Alias を破棄する", () => {
  const tracking = createTracking();

  // 上限 (1024) 分の Track Alias を 0 から挿入順に登録する
  for (let index = 0; index < 1024; index++) {
    recordEndOfGroupFinalObjectId(tracking, BigInt(index), 0n, 0n);
  }
  // 最古の Track Alias 0 に 2 件目の Group を登録する。Group 数の上限には
  // 達していないため、この時点では何も破棄されない
  recordEndOfGroupFinalObjectId(tracking, 0n, 1n, 11n);
  assert.equal(tracking.size, 1024);
  assert.equal(tracking.get(0n)?.size, 2);

  // 1025 件目で最古の Track Alias 0 が破棄される
  recordEndOfGroupFinalObjectId(tracking, 1024n, 0n, 0n);

  assert.equal(tracking.size, 1024);
  // エントリそのものが消える (内側の Map が残らない)
  assert.isFalse(tracking.has(0n));
  assert.isUndefined(tracking.get(0n));
  // 内側の Map が持っていた Group ごとのエントリもまとめて消える
  assert.isUndefined(getEndOfGroupFinalObjectId(tracking, 0n, 0n));
  assert.isUndefined(getEndOfGroupFinalObjectId(tracking, 0n, 1n));
  assert.isTrue(tracking.has(1n));
  assert.equal(getEndOfGroupFinalObjectId(tracking, 1024n, 0n), 0n);
});

// ============================================================================
// Track Alias 単位の破棄
// ============================================================================

/**
 * Track Alias の購読が尽きた時点で、その Track Alias のエントリをまとめて破棄
 * する。他の Track Alias のエントリは残り、未登録の Track Alias の破棄は何も
 * 変えない。破棄した後に同じ Track Alias を再登録できる。
 */
test("clearEndOfGroupTracking: Track Alias のエントリをまとめて破棄し他の Track Alias を残す", () => {
  const tracking = createTracking();

  recordEndOfGroupFinalObjectId(tracking, 1n, 10n, 5n);
  recordEndOfGroupFinalObjectId(tracking, 1n, 11n, 6n);
  recordEndOfGroupFinalObjectId(tracking, 2n, 10n, 7n);

  clearEndOfGroupTracking(tracking, 1n);

  // Track Alias 1 の Group ごとのエントリもまとめて消える
  assert.isFalse(tracking.has(1n));
  assert.isUndefined(getEndOfGroupFinalObjectId(tracking, 1n, 10n));
  assert.isUndefined(getEndOfGroupFinalObjectId(tracking, 1n, 11n));
  // Track Alias 2 のエントリは残る
  assert.equal(getEndOfGroupFinalObjectId(tracking, 2n, 10n), 7n);

  // 未登録の Track Alias の破棄は何も変えない
  clearEndOfGroupTracking(tracking, 3n);
  assert.equal(tracking.size, 1);

  // 破棄した後に同じ Track Alias を再登録できる
  recordEndOfGroupFinalObjectId(tracking, 1n, 12n, 8n);
  assert.equal(getEndOfGroupFinalObjectId(tracking, 1n, 12n), 8n);
});
