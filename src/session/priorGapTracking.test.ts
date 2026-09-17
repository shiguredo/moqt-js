/**
 * session/priorGapTracking.ts の単体テスト
 *
 * draft-ietf-moq-transport-21 §10.8 (Prior Group ID Gap) / §10.9 (Prior Object
 * ID Gap) の malformed Track 条件のうち、同一 Track の複数 Object と過去の受信
 * 状態を必要とする 5 条件の判定と、追跡状態の上限を検証する。
 *
 * 追跡状態は実 Map、Object Properties は encodeProperties が作る実バイト列を
 * 使う。判定はすべて実装本体の assertNoPriorIdGapTrackViolation を呼んで行う。
 */

import { test, assert } from "vite-plus/test";
import { MalformedTrackError } from "../error";
import { fullTrackNameKey, type FullTrackNameKey } from "../fullTrackName";
import { MOQTPropertyId, encodeProperties } from "../properties";
import { priorGroupIdGapProperties, priorObjectIdGapProperties } from "../testSupport/helpers";
import {
  assertNoPriorIdGapTrackViolation,
  getOrCreatePriorGapTracking,
  type PriorGapTrackingTarget,
} from "./priorGapTracking";

/**
 * テストで使う Track の比較キーを作る
 *
 * 追跡は Full Track Name 単位であり、Track 名を変えると別の追跡状態になる。
 */
function trackKeyOf(trackName = "track"): FullTrackNameKey {
  return fullTrackNameKey(["test"], trackName);
}

/** 追跡マップと対象 Track を持つ検証対象を作る */
function trackingTarget(trackName = "track"): PriorGapTrackingTarget {
  return { trackingByTrack: new Map(), trackKey: trackKeyOf(trackName) };
}

/** Object 1 件分の追跡検証を呼ぶ (properties 省略は gap を持たない Object) */
function receive(
  target: PriorGapTrackingTarget,
  groupId: bigint,
  objectId: bigint,
  properties?: Uint8Array,
): void {
  assertNoPriorIdGapTrackViolation(target, groupId, objectId, properties);
}

// ============================================================================
// 5 条件の検出
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §10.8:
 * "A Group contains more than one Object with different values for
 *  Prior Group ID Gap."
 * 同じ Group の 2 件目が異なる Prior Group ID Gap を持つ場合は malformed。
 */
test("assertNoPriorIdGapTrackViolation: 同一 Group 内で異なる Prior Group ID Gap 値は MalformedTrackError", () => {
  const target = trackingTarget();

  // 1 件目 (gap = 2) がこの Group の最初の観測値になる
  receive(target, 10n, 0n, priorGroupIdGapProperties(2n));

  assert.throws(() => receive(target, 10n, 1n, priorGroupIdGapProperties(3n)), MalformedTrackError);
});

/**
 * draft-ietf-moq-transport-21 §10.8:
 * 最初の観測値として記録するのは 5 条件すべてを通った Object の gap 値だけである。
 * malformed と判定した Object の値まで記録すると、以降の正当な Object を同じ
 * 条件で誤検出する。
 */
test("assertNoPriorIdGapTrackViolation: malformed と判定した Object の gap 値は最初の観測値にしない", () => {
  const target = trackingTarget();
  receive(target, 10n, 0n, priorGroupIdGapProperties(2n));

  assert.throws(() => receive(target, 10n, 1n, priorGroupIdGapProperties(3n)), MalformedTrackError);

  // malformed だった gap = 3 は記録されず、gap = 2 が最初の観測値のまま残る
  const tracking = getOrCreatePriorGapTracking(target.trackingByTrack, target.trackKey);
  assert.equal(tracking.firstPriorGroupIdGapByGroup.get(10n), 2n);
  assert.doesNotThrow(() => receive(target, 10n, 2n, priorGroupIdGapProperties(2n)));
});

/**
 * draft-ietf-moq-transport-21 §10.8:
 * "An endpoint receives an Object with a Prior Group ID Gap covering
 *  an Object it previously received."
 * Prior Group ID Gap = 2 の Group 10 の Object は Group 8 と 9 が存在しないことを
 * 通知するため、受信済みの Group 9 を覆う場合は malformed。
 */
test("assertNoPriorIdGapTrackViolation: Prior Group ID Gap が受信済み Group を覆うと MalformedTrackError", () => {
  const target = trackingTarget();

  // 先に Group 9 を受信しておく (Gap を持たない Object も受信済みとして登録する)
  receive(target, 9n, 0n);

  assert.throws(() => receive(target, 10n, 0n, priorGroupIdGapProperties(2n)), MalformedTrackError);

  // malformed と判定した Object は受信済みとして登録しない
  const tracking = getOrCreatePriorGapTracking(target.trackingByTrack, target.trackKey);
  assert.isFalse(tracking.receivedGroupIds.has(10n));
});

/**
 * draft-ietf-moq-transport-21 §10.9:
 * "An endpoint receives an Object with a Prior Object ID Gap covering
 *  an Object it previously received."
 * Object ID の範囲は現在の Group の中でだけ意味を持つため、同じ Group の
 * 受信済み Object ID とだけ比較する。
 */
test("assertNoPriorIdGapTrackViolation: Prior Object ID Gap が同じ Group の受信済み Object を覆うと MalformedTrackError", () => {
  const target = trackingTarget();

  // 同じ Group 3 で Object 8 を先に受信しておく
  receive(target, 3n, 8n);

  // Object 10 の Prior Object ID Gap = 2 は Object 8 と 9 が存在しないと通知する
  assert.throws(
    () => receive(target, 3n, 10n, priorObjectIdGapProperties(2n)),
    MalformedTrackError,
  );
});

/**
 * draft-ietf-moq-transport-21 §10.8:
 * "An endpoint receives an Object with a Group ID within a previously
 *  communicated gap."
 */
test("assertNoPriorIdGapTrackViolation: 通知済み Prior Group ID Gap 内の Group ID は MalformedTrackError", () => {
  const target = trackingTarget();

  // Group 10 の Object が Group 8 と 9 の不在を通知する
  receive(target, 10n, 0n, priorGroupIdGapProperties(2n));

  // 通知済みの不在 Group 9 の Object を受信した
  assert.throws(() => receive(target, 9n, 0n), MalformedTrackError);

  // 通知元と同じ Group 10 の後続 Object は誤検出しない
  assert.doesNotThrow(() => receive(target, 10n, 1n));
});

/**
 * draft-ietf-moq-transport-21 §10.9:
 * "An endpoint receives an Object with an Object ID within a
 *  previously communicated gap."
 */
test("assertNoPriorIdGapTrackViolation: 通知済み Prior Object ID Gap 内の Object ID は MalformedTrackError", () => {
  const target = trackingTarget();

  // Group 3 の Object 10 が同じ Group の Object 8 と 9 の不在を通知する
  receive(target, 3n, 10n, priorObjectIdGapProperties(2n));

  // 通知済みの不在 Object 9 を受信した
  assert.throws(() => receive(target, 3n, 9n), MalformedTrackError);

  // 同じ Object ID でも Group が違えば通知済み範囲と比較しない
  assert.doesNotThrow(() => receive(target, 4n, 9n));
});

/**
 * draft-ietf-moq-transport-21 §10.7 (Immutable Properties):
 * "When looking for the value of a property, processors MUST search both the
 *  mutable properties and the contents of Immutable Properties."
 * gap の値は mutable list と IMMUTABLE_PROPERTIES 配下の双方から取り出す。
 */
test("assertNoPriorIdGapTrackViolation: IMMUTABLE_PROPERTIES 配下の Prior Group ID Gap も通知済み gap に使う", () => {
  const target = trackingTarget();
  // IMMUTABLE_PROPERTIES (0x0B) の内側に Prior Group ID Gap = 2 を入れる
  const inner = encodeProperties([{ id: MOQTPropertyId.PRIOR_GROUP_ID_GAP, value: 2n }]);
  const properties = encodeProperties([{ id: MOQTPropertyId.IMMUTABLE_PROPERTIES, data: inner }]);

  receive(target, 10n, 0n, properties);

  assert.throws(() => receive(target, 9n, 0n), MalformedTrackError);
});

// ============================================================================
// 誤検出しないこと
// ============================================================================

/**
 * draft-ietf-moq-transport-21 §10.9:
 * Object ID の範囲は通知元の Group の中でだけ意味を持つ。Group が異なれば同じ
 * Prior Object ID Gap 値でも、受信済み Object ID との比較も通知済み範囲との
 * 比較も行わない。
 */
test("assertNoPriorIdGapTrackViolation: Group をまたいで Object ID を比較しない", () => {
  const target = trackingTarget();

  // Group 3 で Object 10 を受信済みにする
  receive(target, 3n, 10n);
  // Group 9 の Object 12 の Prior Object ID Gap = 2 は Group 9 の [10, 11] を覆う。
  // Group 3 の受信済み Object 10 と比較すると誤検出になるが、Group が違うため malformed ではない
  assert.doesNotThrow(() => receive(target, 9n, 12n, priorObjectIdGapProperties(2n)));

  // Group 3 の Object 10 が通知した範囲 [8, 9] は別 Group の Object 9 と比較しない
  receive(target, 5n, 10n, priorObjectIdGapProperties(2n));
  assert.doesNotThrow(() => receive(target, 6n, 9n));
});

/**
 * draft-ietf-moq-transport-21 §10.8 / §10.9:
 * "An Object has a Prior Group ID Gap larger than the Group ID." /
 * "An Object has a Prior Object ID Gap larger than the Object ID."
 * 単一 Object 検証の境界 (gap = Group ID / gap = Object ID) と gap = 0 では、
 * 覆う範囲が受信済みの位置を含まない限り malformed にしない。
 */
test("assertNoPriorIdGapTrackViolation: gap = Group ID / gap = Object ID の境界値と gap = 0 で誤検出しない", () => {
  const target = trackingTarget();

  // Group 5 の gap = 5 は Group 0 から 4 の不在を通知する境界値。まだどの Group も
  // 受信していないため、追跡検証でも malformed にならない
  assert.doesNotThrow(() => receive(target, 5n, 0n, priorGroupIdGapProperties(5n)));

  // Group 6 の Object 5 の gap = 5 も同じ境界値。Group 6 ではまだ Object を
  // 受信していないため malformed にならない
  assert.doesNotThrow(() => receive(target, 6n, 5n, priorObjectIdGapProperties(5n)));

  // gap = 0 は空の範囲であり、通知済み gap としても覆い判定にも影響しない
  assert.doesNotThrow(() => receive(target, 7n, 0n, priorGroupIdGapProperties(0n)));
  assert.doesNotThrow(() => receive(target, 7n, 1n, priorObjectIdGapProperties(0n)));

  // gap = 0 は範囲として保持しない
  const tracking = getOrCreatePriorGapTracking(target.trackingByTrack, target.trackKey);
  assert.equal(tracking.priorGroupIdGapRanges.length, 1);
  assert.equal(tracking.priorObjectIdGapRanges.length, 1);
});

/**
 * draft-ietf-moq-transport-21 §10.8:
 * gap を持たない Object は最初の観測値の比較対象にも記録対象にもならない。
 * 途中に挟まっても、以降の同じ gap 値を持つ Object を誤検出しない。
 */
test("assertNoPriorIdGapTrackViolation: gap を持たない Object が挟まっても誤検出しない", () => {
  const target = trackingTarget();

  receive(target, 10n, 0n, priorGroupIdGapProperties(2n));
  // gap を持たない Object は受信済みとしてだけ登録される
  receive(target, 10n, 1n);
  assert.doesNotThrow(() => receive(target, 10n, 2n, priorGroupIdGapProperties(2n)));
});

/**
 * draft-ietf-moq-transport-21 §10.8:
 * 同じ gap 値の反復は同一 Group 内で矛盾しない。通知済み範囲も同一の範囲を
 * 重複して保持しない (同じ gap の反復で上限を消費しない)。
 */
test("assertNoPriorIdGapTrackViolation: 同じ gap 値の反復で誤検出せず範囲も重複しない", () => {
  const target = trackingTarget();

  receive(target, 10n, 0n, priorGroupIdGapProperties(2n));
  assert.doesNotThrow(() => receive(target, 10n, 1n, priorGroupIdGapProperties(2n)));
  assert.doesNotThrow(() => receive(target, 10n, 2n, priorGroupIdGapProperties(2n)));

  const tracking = getOrCreatePriorGapTracking(target.trackingByTrack, target.trackKey);
  assert.equal(tracking.priorGroupIdGapRanges.length, 1);
});

/**
 * 追跡は Full Track Name 単位である。別 Track の受信履歴や通知済み gap を
 * 共有しない。
 */
test("assertNoPriorIdGapTrackViolation: 別 Track とは追跡状態を共有しない", () => {
  const first = trackingTarget("track-a");
  const second = trackingTarget("track-b");

  // Track A の Group 10 が Group 8 と 9 の不在を通知する
  receive(first, 10n, 0n, priorGroupIdGapProperties(2n));

  // Track B の Group 9 は Track A の通知済み gap と比較しない
  assert.doesNotThrow(() => receive(second, 9n, 0n));
});

// ============================================================================
// 追跡状態の上限
// draft-ietf-moq-transport-21 §10.8 / §10.9 の判定は過去の受信状態を必要とする
// ため、上限を超えた場合は最古のエントリを破棄する (破棄した範囲では判定できない)。
// ============================================================================

/** 受信済み Group の上限を超えると最古の Group が破棄される */
test("assertNoPriorIdGapTrackViolation: 受信済み Group の上限を超えると最古の Group を破棄する", () => {
  const target = trackingTarget();

  // 上限 (1024) 分の Group を 0 から受信順に登録する
  for (let index = 0; index < 1024; index++) {
    receive(target, BigInt(index), 0n);
  }
  // 1025 件目で最古の Group 0 が破棄される
  receive(target, 1024n, 0n);

  const tracking = getOrCreatePriorGapTracking(target.trackingByTrack, target.trackKey);
  assert.equal(tracking.receivedGroupIds.size, 1024);
  assert.isFalse(tracking.receivedGroupIds.has(0n));
  assert.isTrue(tracking.receivedGroupIds.has(1024n));
  // Group 単位の状態も一緒に破棄される
  assert.isFalse(tracking.receivedObjectIdsByGroup.has(0n));
});

/** Group ごとの受信済み Object の上限を超えると最古の Object が破棄される */
test("assertNoPriorIdGapTrackViolation: 受信済み Object の上限を超えると最古の Object を破棄する", () => {
  const target = trackingTarget();

  // 上限 (1024) 分の Object を同じ Group へ 0 から受信順に登録する
  for (let index = 0; index < 1024; index++) {
    receive(target, 3n, BigInt(index));
  }
  // 1025 件目で最古の Object 0 が破棄される
  receive(target, 3n, 1024n);

  const tracking = getOrCreatePriorGapTracking(target.trackingByTrack, target.trackKey);
  const receivedObjectIds = tracking.receivedObjectIdsByGroup.get(3n);
  assert.isDefined(receivedObjectIds);
  assert.equal(receivedObjectIds.size, 1024);
  assert.isFalse(receivedObjectIds.has(0n));
  assert.isTrue(receivedObjectIds.has(1024n));
});

/** 通知済み gap 範囲の上限を超えると最古の範囲が破棄され、覆い判定ができなくなる */
test("assertNoPriorIdGapTrackViolation: 通知済み gap 範囲の上限を超えると最古の範囲を破棄する", () => {
  const target = trackingTarget();

  // Group 100, 200, ... に Prior Group ID Gap = 10 を付けて 1025 件通知する。
  // 各 Group の通知済み範囲は [Group - 10, Group - 1] であり、互いに重ならない
  for (let index = 0; index < 1025; index++) {
    receive(target, BigInt(index) * 100n + 100n, 0n, priorGroupIdGapProperties(10n));
  }

  // 最古の範囲 [90, 99] は破棄済みのため、その中の Group 95 は検出できない
  assert.doesNotThrow(() => receive(target, 95n, 0n));
  // 直近の範囲 [102490, 102499] は残っており、その中の Group 102495 は検出できる
  assert.throws(() => receive(target, 102495n, 0n), MalformedTrackError);
});

/** Track エントリの上限を超えると最古の Track の追跡状態が破棄される */
test("assertNoPriorIdGapTrackViolation: Track エントリの上限を超えると最古の Track を破棄する", () => {
  const target = trackingTarget();
  const firstKey = trackKeyOf("track-0");

  // 上限 (1024) 分の Track を登録する
  for (let index = 0; index < 1024; index++) {
    receive(
      { trackingByTrack: target.trackingByTrack, trackKey: trackKeyOf(`track-${index}`) },
      0n,
      0n,
    );
  }
  assert.equal(target.trackingByTrack.size, 1024);

  // 1025 件目で最古の Track エントリが破棄される
  const extraKey = trackKeyOf("track-extra");
  receive({ trackingByTrack: target.trackingByTrack, trackKey: extraKey }, 0n, 0n);

  assert.equal(target.trackingByTrack.size, 1024);
  assert.isFalse(target.trackingByTrack.has(firstKey));
  assert.isTrue(target.trackingByTrack.has(extraKey));
});
