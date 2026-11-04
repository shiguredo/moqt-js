/**
 * session/priorGapTracking.ts の単体テスト
 *
 * draft-ietf-moq-transport-23 §10.8 (Prior Group ID Gap) / §10.9 (Prior Object
 * ID Gap) の malformed Track 条件のうち、同一 Track の複数 Object と過去の受信
 * 状態を必要とする 5 条件の判定と、追跡状態の上限を検証する。
 *
 * 追跡状態は実 Map、Object Properties は encodeProperties が作る実バイト列を
 * 使う。判定はすべて実装本体の assertNoPriorIdGapTrackViolation を呼んで行う。
 */

import { test, assert } from "vite-plus/test";
import { MalformedTrackError } from "../error";
import { fullTrackNameKey, type FullTrackNameKey } from "../fullTrackName";
import { ObjectStatus } from "../message";
import { GroupOrder } from "../message/types";
import { MOQTPropertyId, encodeProperties } from "../properties";
import { priorGroupIdGapProperties, priorObjectIdGapProperties } from "../testSupport/helpers";
import {
  assertAndRecordFetchNonExistentRange,
  assertAndRecordFetchTrailingGap,
  assertNoObjectAfterFetchEnd,
  assertNoPriorIdGapTrackViolation,
  clearPriorGapTracking,
  getOrCreatePriorGapTracking,
  recordFetchObjectEnd,
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
 * draft-ietf-moq-transport-23 §10.8:
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
 * draft-ietf-moq-transport-23 §10.8:
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
 * draft-ietf-moq-transport-23 §10.8:
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
 * draft-ietf-moq-transport-23 §10.9:
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
 * draft-ietf-moq-transport-23 §10.8:
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
 * draft-ietf-moq-transport-23 §10.9:
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
 * draft-ietf-moq-transport-23 §10.7 (Immutable Properties):
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
 * draft-ietf-moq-transport-23 §10.9:
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
 * draft-ietf-moq-transport-23 §10.8 / §10.9:
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
 * draft-ietf-moq-transport-23 §10.8:
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
 * draft-ietf-moq-transport-23 §10.8:
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
// draft-ietf-moq-transport-23 §10.8 / §10.9 の判定は過去の受信状態を必要とする
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

// ============================================================================
// draft-ietf-moq-transport-23 §11.4.2.2 / §12.1 条件 4 / 5:
// FETCH の End of Group / End of Track indicator が確定した終端の追跡
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §11.4.2.2:
 * End of Group / End of Track indicator が確定した終端を記録する。End of Track は
 * Group の終端も意味するため、Group と Track の両方の終端として記録される。
 * End of Range の範囲端は実 Object の終端ではないため、この関数の入力にならない。
 */
test("recordFetchObjectEnd: End of Group は Group 終端だけ、End of Track は Track 終端も記録する", () => {
  const target = trackingTarget();

  // End of Group は Group の最終 Object だけを記録する
  recordFetchObjectEnd(target, { kind: "end_of_group", groupId: 10n, objectId: 5n });
  const afterGroup = getOrCreatePriorGapTracking(target.trackingByTrack, target.trackKey);
  assert.equal(afterGroup.fetchGroupFinalObjectIds.get(10n), 5n);
  // End of Group は Track の終端ではない
  assert.isUndefined(afterGroup.fetchTrackEnd);

  // End of Track は Group と Track の両方の終端を記録する
  recordFetchObjectEnd(target, { kind: "end_of_track", groupId: 10n, objectId: 5n });
  assert.equal(afterGroup.fetchGroupFinalObjectIds.get(10n), 5n);
  assert.deepEqual(afterGroup.fetchTrackEnd, { groupId: 10n, objectId: 5n });
});

/**
 * draft-ietf-moq-transport-23 §12.1 条件 4 / 5:
 * 終端より後の Object は追跡状態へ登録されない。後続の判定が違反 Object を
 * 既知の受信位置として使わないことを検証する。
 */
test("assertNoObjectAfterFetchEnd: 終端より後の Object は受信状態に登録されない", () => {
  const target = trackingTarget();
  recordFetchObjectEnd(target, { kind: "end_of_track", groupId: 10n, objectId: 5n });
  const tracking = getOrCreatePriorGapTracking(target.trackingByTrack, target.trackKey);
  const groupsBefore = new Set(tracking.receivedGroupIds);
  const objectsBefore = new Set(tracking.receivedObjectIdsByGroup.get(10n));
  assert.isTrue(tracking.fetchTrackEnd !== undefined);

  // 終端より後の Object は条件 4 / 5 で拒否される
  assert.throws(
    () => assertNoObjectAfterFetchEnd(target, 10n, 6n),
    MalformedTrackError,
    /exceeds final object/,
  );
  // 受信状態は変化しない (登録は assertNoPriorIdGapTrackViolation が行う)
  assert.deepEqual(new Set(tracking.receivedGroupIds), groupsBefore);
  assert.deepEqual(new Set(tracking.receivedObjectIdsByGroup.get(10n)), objectsBefore);
});

/**
 * draft-ietf-moq-transport-23 §12.1 条件 4:
 * "An Object is received in a Group whose Object ID is larger than the final
 *  Object in the Group."
 * 確定した Group の最終 Object と同じ Object ID までは許容し、超える Object を
 * malformed とする。
 */
test("assertNoObjectAfterFetchEnd: Group の最終 Object を超える Object は MalformedTrackError", () => {
  const target = trackingTarget();
  recordFetchObjectEnd(target, { kind: "end_of_group", groupId: 10n, objectId: 5n });

  // 最終 Object ちょうどまでは許容する
  assert.doesNotThrow(() => assertNoObjectAfterFetchEnd(target, 10n, 5n));
  assert.doesNotThrow(() => assertNoObjectAfterFetchEnd(target, 10n, 4n));
  // 超える Object は malformed
  assert.throws(
    () => assertNoObjectAfterFetchEnd(target, 10n, 6n),
    MalformedTrackError,
    /exceeds final object 5 in group 10/,
  );
  // 別 Group は Group 終端の制約を受けない (Track 終端は未確定)
  assert.doesNotThrow(() => assertNoObjectAfterFetchEnd(target, 11n, 0n));
});

/**
 * draft-ietf-moq-transport-23 §12.1 条件 5:
 * "An Object is received whose Group and Object ID are larger than the final
 *  Object in the Track."
 * Location の大小は Group ID、同じ Group では Object ID で比較する。
 */
test("assertNoObjectAfterFetchEnd: Track の最終 Object より後の Object は MalformedTrackError", () => {
  const target = trackingTarget();
  recordFetchObjectEnd(target, { kind: "end_of_track", groupId: 10n, objectId: 5n });

  // 最終 Object と同じ位置、および手前の位置は許容する
  assert.doesNotThrow(() => assertNoObjectAfterFetchEnd(target, 10n, 5n));
  assert.doesNotThrow(() => assertNoObjectAfterFetchEnd(target, 10n, 4n));
  assert.doesNotThrow(() => assertNoObjectAfterFetchEnd(target, 9n, 100n));
  // 後の Group は malformed
  assert.throws(
    () => assertNoObjectAfterFetchEnd(target, 11n, 0n),
    MalformedTrackError,
    /is after final object 10:5 in track/,
  );
  // 同じ Group でも後ろの Object ID は malformed
  assert.throws(
    () => assertNoObjectAfterFetchEnd(target, 10n, 6n),
    MalformedTrackError,
    /exceeds final object 5 in group 10/,
  );
});

/**
 * draft-ietf-moq-transport-23 §12.1 条件 4:
 * 追跡する Group 終端の上限を超えると最古の Group の記録から破棄される。破棄した
 * Group では既知の最終 Object が無いため超過を検出できない (検出漏れのみ)。
 */
test("recordFetchObjectEnd: Group 終端の上限を超えると最古の Group を破棄する", () => {
  const target = trackingTarget();

  // 上限 (1024) 分の Group 終端を記録する
  for (let index = 0; index < 1024; index++) {
    recordFetchObjectEnd(target, {
      kind: "end_of_group",
      groupId: BigInt(index),
      objectId: 0n,
    });
  }
  // 1025 件目で Group 0 の記録が破棄される
  recordFetchObjectEnd(target, { kind: "end_of_group", groupId: 1024n, objectId: 0n });

  const tracking = getOrCreatePriorGapTracking(target.trackingByTrack, target.trackKey);
  assert.equal(tracking.fetchGroupFinalObjectIds.size, 1024);
  assert.isFalse(tracking.fetchGroupFinalObjectIds.has(0n));
  assert.isTrue(tracking.fetchGroupFinalObjectIds.has(1024n));
  // 破棄した Group 0 では超過を検出しない
  assert.doesNotThrow(() => assertNoObjectAfterFetchEnd(target, 0n, 1n));
});

// ============================================================================
// draft-ietf-moq-transport-23 §2.1.2 (Object States) / §12.1 条件 10:
// 実 Object と非存在通知の両方向の矛盾検出
// ============================================================================

/** Object Status 付きの受信として追跡検証を呼ぶ */
function receiveWithStatus(
  target: PriorGapTrackingTarget,
  groupId: bigint,
  objectId: bigint,
  status: ObjectStatus,
  properties?: Uint8Array,
): void {
  assertNoPriorIdGapTrackViolation(target, groupId, objectId, properties, status);
}

/**
 * draft-ietf-moq-transport-23 §11.1.1 (Object Status) / §12.1 条件 10:
 * END_OF_GROUP の Object は「同じ Group のその Object ID より後が存在しない」ことを
 * 通知する。通知より後の Object の受信は malformed であり、通知より前の Object や
 * 別 Group の Object は矛盾しない。
 */
test("Object Status END_OF_GROUP: 通知より後の Object は MalformedTrackError", () => {
  const target = trackingTarget();

  // Group 10 の Object 5 が Group 10 の最終 Object であることを通知する
  assert.doesNotThrow(() => receiveWithStatus(target, 10n, 5n, ObjectStatus.END_OF_GROUP));

  // 同じ Group の後続 Object は非存在として記録済み
  assert.throws(() => receive(target, 10n, 6n), MalformedTrackError);
  assert.throws(() => receive(target, 10n, 100n), MalformedTrackError);

  // 通知より前の Object と別 Group の Object は矛盾しない
  assert.doesNotThrow(() => receive(target, 10n, 4n));
  assert.doesNotThrow(() => receive(target, 11n, 0n));
});

/**
 * draft-ietf-moq-transport-23 §12.1 条件 10:
 * "or is signalled as not existing after it was received"
 * 実 Object を先に受信している場合、その位置を覆う END_OF_GROUP は malformed。
 */
test("Object Status END_OF_GROUP: 受信済み Object を覆う通知は MalformedTrackError", () => {
  const target = trackingTarget();

  // 同じ Group の Object 7 を先に受信しておく
  receive(target, 10n, 7n);

  // Object 5 を最終 Object とする END_OF_GROUP は受信済みの 7 を覆う
  assert.throws(
    () => receiveWithStatus(target, 10n, 5n, ObjectStatus.END_OF_GROUP),
    MalformedTrackError,
  );

  // malformed と判定した Object は受信済みとして登録しない
  const tracking = getOrCreatePriorGapTracking(target.trackingByTrack, target.trackKey);
  assert.isFalse(tracking.objectState.receivedRanges.some((range) => range.start.object === 5n));
});

/**
 * draft-ietf-moq-transport-23 §11.1.1 / §12.1 条件 10:
 * END_OF_TRACK は Track 全体の指定 Location より後が存在しないことを通知する。
 * 後の Group の Object も矛盾する。
 */
test("Object Status END_OF_TRACK: 通知より後の Object は MalformedTrackError", () => {
  const target = trackingTarget();

  assert.doesNotThrow(() => receiveWithStatus(target, 10n, 5n, ObjectStatus.END_OF_TRACK));

  // 同じ Group の後続だけでなく、後の Group の Object も Track に存在しない
  assert.throws(() => receive(target, 10n, 6n), MalformedTrackError);
  assert.throws(() => receive(target, 11n, 0n), MalformedTrackError);
  // 手前の位置は矛盾しない
  assert.doesNotThrow(() => receive(target, 10n, 4n));
  assert.doesNotThrow(() => receive(target, 9n, 100n));
});

/**
 * draft-ietf-moq-transport-23 §12.1 条件 10:
 * END_OF_TRACK を後から通知する場合も、受信済み Object を覆えば malformed である。
 */
test("Object Status END_OF_TRACK: 受信済み Object を覆う通知は MalformedTrackError", () => {
  const target = trackingTarget();
  receive(target, 11n, 0n);

  assert.throws(
    () => receiveWithStatus(target, 10n, 5n, ObjectStatus.END_OF_TRACK),
    MalformedTrackError,
  );
});

/**
 * draft-ietf-moq-transport-23 §11.4.2.2 / §12.1 条件 10:
 * FETCH の End of Group indicator が宣言する範囲も、同じ Track の別経路で受信済みの
 * Object と突き合わせる。同じ終端を再宣言することは矛盾しない。
 */
test("recordFetchObjectEnd: 受信済み Object を覆う End of Group は MalformedTrackError", () => {
  const target = trackingTarget();
  receive(target, 10n, 7n);

  assert.throws(
    () => recordFetchObjectEnd(target, { kind: "end_of_group", groupId: 10n, objectId: 5n }),
    MalformedTrackError,
  );

  // 通知より前の位置だけを受信していれば矛盾しない
  const allowed = trackingTarget("track-allowed");
  receive(allowed, 10n, 4n);
  assert.doesNotThrow(() =>
    recordFetchObjectEnd(allowed, { kind: "end_of_group", groupId: 10n, objectId: 5n }),
  );
});

/**
 * draft-ietf-moq-transport-23 §11.4.2.2 / §12.1 条件 10:
 * FETCH の End of Track indicator が宣言する範囲も、受信済み Object と突き合わせる。
 */
test("recordFetchObjectEnd: 受信済み Object を覆う End of Track は MalformedTrackError", () => {
  const target = trackingTarget();
  receive(target, 11n, 0n);

  assert.throws(
    () => recordFetchObjectEnd(target, { kind: "end_of_track", groupId: 10n, objectId: 5n }),
    MalformedTrackError,
  );

  // 手前の Group の Object だけなら矛盾しない
  const allowed = trackingTarget("track-allowed");
  receive(allowed, 9n, 100n);
  assert.doesNotThrow(() =>
    recordFetchObjectEnd(allowed, { kind: "end_of_track", groupId: 10n, objectId: 5n }),
  );
});

/**
 * draft-ietf-moq-transport-23 §12.1 条件 10:
 * 記録した End of Group の終端より後の Object の受信は malformed である。
 */
test("recordFetchObjectEnd: 記録した End of Group 終端より後の Object は MalformedTrackError", () => {
  const target = trackingTarget();
  recordFetchObjectEnd(target, { kind: "end_of_group", groupId: 10n, objectId: 5n });

  assert.throws(() => receive(target, 10n, 6n), MalformedTrackError);
  // 終端ちょうど、手前、別 Group は矛盾しない
  assert.doesNotThrow(() => receive(target, 10n, 5n));
  assert.doesNotThrow(() => receive(target, 10n, 4n));
  assert.doesNotThrow(() => receive(target, 11n, 0n));
});

/**
 * draft-ietf-moq-transport-23 §3.2.2 / §12.1 条件 10:
 * FETCH の End of Non-Existent Range が明示した範囲を非存在として記録し、
 * その範囲内の Object の受信を拒否する。記録した範囲を覆う実 Object が先に
 * 受信済みなら、範囲の記録自体を拒否する。
 */
test("assertAndRecordFetchNonExistentRange: 非存在範囲と実 Object の両方向の矛盾を検出する", () => {
  const target = trackingTarget();

  // 記録した範囲内の Object は拒否する
  assertAndRecordFetchNonExistentRange(target, {
    start: { group: 10n, object: 6n },
    end: { group: 10n, object: 9n },
  });
  assert.throws(() => receive(target, 10n, 7n), MalformedTrackError);
  assert.doesNotThrow(() => receive(target, 10n, 5n));
  assert.doesNotThrow(() => receive(target, 10n, 10n));

  // 受信済み Object を覆う範囲の記録は拒否する
  const reversed = trackingTarget("track-reversed");
  receive(reversed, 10n, 7n);
  assert.throws(
    () =>
      assertAndRecordFetchNonExistentRange(reversed, {
        start: { group: 10n, object: 6n },
        end: { group: 10n, object: 9n },
      }),
    MalformedTrackError,
  );
});

/**
 * draft-ietf-moq-transport-23 §3.2.2:
 * FIN 時に推論した末尾 gap を非存在として記録し、その範囲内の Object の受信を
 * 拒否する。Range Filter を含む要求では無印の gap は Unknown であるため、
 * 範囲を記録せず Object の受信も拒否しない。
 */
test("assertAndRecordFetchTrailingGap: 末尾 gap を記録し、Range Filter 時は記録しない", () => {
  const target = trackingTarget();
  assertAndRecordFetchTrailingGap(target, {
    groupOrder: GroupOrder.ASCENDING,
    startLocation: { group: 10n, object: 0n },
    endLocation: { group: 11n, object: 3n },
    lastSerializedLocation: { group: 10n, object: 5n },
    rangeFiltersPresent: false,
  });

  // 末尾 gap 内の Object は非存在として拒否する
  assert.throws(() => receive(target, 10n, 6n), MalformedTrackError);
  assert.throws(() => receive(target, 11n, 0n), MalformedTrackError);
  // シリアライズ済みの位置は矛盾しない
  assert.doesNotThrow(() => receive(target, 10n, 5n));

  // Range Filter を含む要求では非存在とみなさない
  const filtered = trackingTarget("track-filtered");
  assertAndRecordFetchTrailingGap(filtered, {
    groupOrder: GroupOrder.ASCENDING,
    startLocation: { group: 10n, object: 0n },
    endLocation: { group: 11n, object: 3n },
    lastSerializedLocation: { group: 10n, object: 5n },
    rangeFiltersPresent: true,
  });
  // 範囲を記録しないため追跡エントリ自体も作らない
  assert.isFalse(filtered.trackingByTrack.has(filtered.trackKey));
  assert.doesNotThrow(() => receive(filtered, 10n, 6n));
});

/**
 * draft-ietf-moq-transport-23 §12.1 条件 10:
 * 末尾 gap を推論する時点で、同じ Track の別購読 / FETCH がその範囲の Object を
 * 受信済みなら malformed である。
 */
test("assertAndRecordFetchTrailingGap: 受信済み Object を覆う末尾 gap は MalformedTrackError", () => {
  const target = trackingTarget();
  receive(target, 11n, 0n);

  assert.throws(
    () =>
      assertAndRecordFetchTrailingGap(target, {
        groupOrder: GroupOrder.ASCENDING,
        startLocation: { group: 10n, object: 0n },
        endLocation: { group: 11n, object: 3n },
        lastSerializedLocation: { group: 10n, object: 5n },
        rangeFiltersPresent: false,
      }),
    MalformedTrackError,
  );
});

/**
 * 追跡は Full Track Name 単位である。別 Track で受信済みの位置を、この Track の
 * 非存在通知の根拠にしない。
 */
test("objectState: 別 Track と同じ Location を混同しない", () => {
  const first = trackingTarget("track-a");
  const second = trackingTarget("track-b");

  // Track A で Object 7 を受信し、Track B でその位置を非存在として通知する
  receive(first, 10n, 7n);
  assert.doesNotThrow(() => receiveWithStatus(second, 10n, 5n, ObjectStatus.END_OF_TRACK));
  // Track B の非存在範囲内の Object は Track A の受信状態と無関係に Track B で拒否する
  assert.throws(() => receive(second, 10n, 7n), MalformedTrackError);
  // Track A の受信済み位置は Track B の通知で矛盾しない
  assert.doesNotThrow(() => receive(first, 10n, 7n));
});

// ============================================================================
// 追跡状態の上限と解放
// draft-ietf-moq-transport-23 §2.1.2 / §12.1 条件 10
// ============================================================================

/**
 * 非存在区間の上限を超えると最も古い範囲が破棄される。破棄した範囲では検出
 * できなくなるが、誤検出は生まない (検出漏れのみの制限)。
 * 上限は実装内部の MAX_TRACKED_NON_EXISTENT_RANGES = 1024 と一致する件数で
 * 検証する (定数は外部へ公開しないため、テストは同じ値を使う)。
 */
test("objectState: 非存在区間の上限を超えると最古の範囲を破棄し誤検出しない", () => {
  const target = trackingTarget();

  // 1025 個の Group について End of Group を通知し、非存在区間を 1025 件作る
  for (let index = 0; index < 1025; index++) {
    recordFetchObjectEnd(target, {
      kind: "end_of_group",
      groupId: BigInt(index),
      objectId: 0n,
    });
  }

  const tracking = getOrCreatePriorGapTracking(target.trackingByTrack, target.trackKey);
  assert.equal(tracking.objectState.nonExistentRanges.length, 1024);
  // 最古の Group 0 の非存在範囲は破棄済みのため、その後の Object を検出しない
  assert.doesNotThrow(() => receive(target, 0n, 1n));
  // 保持している直近の Group 1024 の範囲は検出できる
  assert.throws(() => receive(target, 1024n, 1n), MalformedTrackError);
});

/**
 * 受信済み区間の上限を超えると最も古い区間が破棄される。破棄した位置を覆う
 * 非存在通知は誤って拒否しない (検出漏れのみの制限)。
 * 上限は実装内部の MAX_TRACKED_RECEIVED_RANGES = 1024 と一致する件数で検証する
 * (定数は外部へ公開しないため、テストは同じ値を使う)。
 */
test("objectState: 受信済み区間の上限を超えると最古の区間を破棄し誤検出しない", () => {
  const target = trackingTarget();

  // 分断した受信位置を 1025 件作り、最古の Object 0 を破棄させる
  for (let index = 0; index < 1025; index++) {
    receive(target, 10n, BigInt(index) * 2n);
  }

  const tracking = getOrCreatePriorGapTracking(target.trackingByTrack, target.trackKey);
  assert.equal(tracking.objectState.receivedRanges.length, 1024);
  // 破棄済みの位置を覆う非存在通知は受理する
  assert.doesNotThrow(() =>
    assertAndRecordFetchNonExistentRange(target, {
      start: { group: 10n, object: 0n },
      end: { group: 10n, object: 0n },
    }),
  );
  // 保持中の位置を覆う通知は拒否する
  assert.throws(
    () =>
      assertAndRecordFetchNonExistentRange(target, {
        start: { group: 10n, object: 2n },
        end: { group: 10n, object: 2n },
      }),
    MalformedTrackError,
  );
});

/**
 * 追跡状態は Track の購読と FETCH が尽きた時点で clearPriorGapTracking が破棄する。
 * 破棄後は新しい空の状態になり、以前の受信位置 / 非存在範囲を根拠にしない。
 */
test("clearPriorGapTracking: 追跡状態を破棄すると Object 状態も残らない", () => {
  const target = trackingTarget();
  receive(target, 10n, 7n);
  receiveWithStatus(target, 11n, 5n, ObjectStatus.END_OF_TRACK);
  assert.isTrue(target.trackingByTrack.has(target.trackKey));

  clearPriorGapTracking(target.trackingByTrack, target.trackKey);

  // Map のエントリごと消えるため、区間も残らない
  assert.isFalse(target.trackingByTrack.has(target.trackKey));
  const tracking = getOrCreatePriorGapTracking(target.trackingByTrack, target.trackKey);
  assert.equal(tracking.objectState.receivedRanges.length, 0);
  assert.equal(tracking.objectState.nonExistentRanges.length, 0);
  // 破棄後の受信は以前の非存在範囲と比較しない
  assert.doesNotThrow(() => receive(target, 10n, 7n));
  assert.doesNotThrow(() => receive(target, 11n, 6n));
});
