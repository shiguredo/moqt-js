/**
 * session/objectStateTracking.ts の単体テスト
 *
 * draft-ietf-moq-transport-23 §2.1.2 (Object States) / §3.2.2 (Gaps in a Fetch
 * Stream) / §12.1 (Malformed Tracks) 条件 10 の判定に使う、受信済み位置と確定した
 * 非存在範囲の区間管理を検証する。
 *
 * 対象:
 * - 区間の統合 (隣接する受信位置・非存在範囲は 1 件へまとめる)
 * - 保持件数の上限と最古の記録の破棄 (破棄後に誤検出しないこと)
 * - 実 Object と非存在通知の前後両方向の矛盾判定
 * - Object Status / End of Group / End of Track が通知する範囲の組み立て
 * - FETCH 応答の暗黙 gap / End of Non-Existent Range / 末尾 gap の区間分解
 *   (Ascending / Descending / Group 境界 / 要求範囲のクランプ)
 *
 * 追跡状態は実配列で作り、モックやスタブは使わない。
 */

import { test, assert } from "vite-plus/test";
import { MalformedTrackError } from "../error";
import { GroupOrder, type Location } from "../message";
import { MAX_VARINT } from "../varint";
import {
  assertAndRegisterNonExistentRange,
  assertNoReceivedObjectInRange,
  assertObjectNotInNonExistentRange,
  buildFetchTrailingGapRanges,
  buildFetchTraversalGapRanges,
  createObjectStateTracking,
  getFetchTraversalBoundaries,
  registerNonExistentRange,
  registerReceivedObjectLocation,
  trackLocationRangeAfterFinalObject,
  type ObjectStateTracking,
} from "./objectStateTracking";

// ============================================================================
// 共通ヘルパー
// ============================================================================

/** Location を作る (テストの可読性のため) */
function location(group: bigint, object: bigint): Location {
  return { group, object };
}

/** 区間を `Group:Object-Group:Object` の文字列にして比較しやすくする */
function describeRange(range: { start: Location; end: Location }): string {
  return `${range.start.group}:${range.start.object}-${range.end.group}:${range.end.object}`;
}

/** 受信位置を 1 件登録する */
function receive(state: ObjectStateTracking, groupId: bigint, objectId: bigint): void {
  registerReceivedObjectLocation(state, groupId, objectId);
}

// ============================================================================
// 受信済み区間の管理
// ============================================================================

/**
 * 連続する Object の受信は 1 つの区間へ統合され、Object ごとの配列にならない。
 * draft-ietf-moq-transport-23 §2.1.2 末尾: 非存在は連続した範囲として通知される
 * ため、区間で保持して Object 数に比例した保持量を避ける。
 */
test("registerReceivedObjectLocation: 連続する受信位置を 1 つの区間へ統合する", () => {
  const state = createObjectStateTracking();

  receive(state, 10n, 5n);
  receive(state, 10n, 6n);
  receive(state, 10n, 7n);

  assert.deepEqual(
    state.receivedRanges.map((range) => describeRange(range)),
    ["10:5-10:7"],
  );
});

/** 離れた受信位置は別の区間になり、後から埋めると隣接区間が統合される */
test("registerReceivedObjectLocation: 離れた位置は別区間にし、間が埋まると統合する", () => {
  const state = createObjectStateTracking();

  receive(state, 10n, 1n);
  receive(state, 10n, 3n);
  assert.deepEqual(
    state.receivedRanges.map((range) => describeRange(range)),
    ["10:1-10:1", "10:3-10:3"],
  );

  // 間の Object 2 を受信すると 1 つの区間になる
  receive(state, 10n, 2n);
  assert.deepEqual(
    state.receivedRanges.map((range) => describeRange(range)),
    ["10:1-10:3"],
  );
});

/**
 * Object ID 2^64-1 の次は次の Group の先頭である。Group 境界をまたぐ受信位置も
 * 辞書式順序で隣接するため 1 つの区間に統合される。
 */
test("registerReceivedObjectLocation: Group 境界をまたぐ隣接位置も統合する", () => {
  const state = createObjectStateTracking();

  receive(state, 10n, MAX_VARINT);
  receive(state, 11n, 0n);

  assert.deepEqual(
    state.receivedRanges.map((range) => describeRange(range)),
    ["10:18446744073709551615-11:0"],
  );
});

/**
 * 分断した区間が増えても保持件数は上限を超えない。超過時は最も古い区間を破棄し、
 * 破棄した位置は受信済みの根拠にしない。
 * 上限は実装内部の MAX_TRACKED_RECEIVED_RANGES = 1024 と一致する件数で検証する
 * (定数は外部へ公開しないため、テストは同じ値を使う)。
 */
test("registerReceivedObjectLocation: 分断区間が上限を超えると最古の区間を破棄する", () => {
  const state = createObjectStateTracking();

  // 1 つおきに受信して 1024 件の分断区間を作る
  for (let index = 0; index < 1024; index++) {
    receive(state, 10n, BigInt(index) * 2n);
  }
  assert.equal(state.receivedRanges.length, 1024);
  assert.equal(
    describeRange(state.receivedRanges[0] ?? { start: location(0n, 0n), end: location(0n, 0n) }),
    "10:0-10:0",
  );

  // 1025 件目で最古の区間 (10:0) が破棄される
  receive(state, 10n, 2048n);
  assert.equal(state.receivedRanges.length, 1024);
  assert.equal(
    describeRange(state.receivedRanges[0] ?? { start: location(0n, 0n), end: location(0n, 0n) }),
    "10:2-10:2",
  );
  assert.isTrue(state.receivedRanges.some((range) => range.start.object === 2048n));
});

// ============================================================================
// 非存在区間の管理
// ============================================================================

/** 重複・隣接する非存在範囲は 1 つに統合される */
test("registerNonExistentRange: 重複・隣接する範囲を 1 つに統合する", () => {
  const state = createObjectStateTracking();

  registerNonExistentRange(state, { start: location(10n, 5n), end: location(10n, 8n) });
  registerNonExistentRange(state, { start: location(10n, 9n), end: location(10n, 12n) });
  registerNonExistentRange(state, { start: location(10n, 7n), end: location(10n, 10n) });

  assert.deepEqual(
    state.nonExistentRanges.map((range) => describeRange(range)),
    ["10:5-10:12"],
  );
});

/**
 * 空の範囲 (start > end) は通知として意味を持たないため、検証も記録もしない。
 * 空区間の判定は assertAndRegisterNonExistentRange に集約しており、受信済み区間と
 * 交差しないため誤検出もしない。
 */
test("assertAndRegisterNonExistentRange: 空の範囲は検証も記録もしない", () => {
  const state = createObjectStateTracking();
  // 受信済み区間が空区間の両端をまたいでいても、空区間は矛盾にならない
  receive(state, 10n, 7n);

  assert.doesNotThrow(() =>
    assertAndRegisterNonExistentRange(state, {
      start: location(10n, 9n),
      end: location(10n, 5n),
    }),
  );

  assert.equal(state.nonExistentRanges.length, 0);
});

/**
 * 非存在区間にも上限があり、超過時は最も古い範囲から破棄する。破棄した範囲は
 * 判定に使わないため、その範囲の Object を受信しても誤検出しない。
 * 上限は実装内部の MAX_TRACKED_NON_EXISTENT_RANGES = 1024 と一致する件数で検証する
 * (定数は外部へ公開しないため、テストは同じ値を使う)。
 */
test("registerNonExistentRange: 上限を超えると最古の範囲を破棄し、破棄後は誤検出しない", () => {
  const state = createObjectStateTracking();

  for (let index = 0; index < 1025; index++) {
    registerNonExistentRange(state, {
      start: location(BigInt(index), 0n),
      end: location(BigInt(index), 5n),
    });
  }

  assert.equal(state.nonExistentRanges.length, 1024);
  // 最古の Group 0 の範囲は破棄されているため、その中の Object は拒否しない
  assert.doesNotThrow(() => assertObjectNotInNonExistentRange(state, 0n, 3n));
  // 保持している直近の範囲の Object は拒否する
  assert.throws(() => assertObjectNotInNonExistentRange(state, 1024n, 3n), MalformedTrackError);
});

// ============================================================================
// 実 Object と非存在通知の前後両方向の矛盾判定
// ============================================================================

/**
 * draft-ietf-moq-transport-23 §12.1 条件 10:
 * "An Object is received after it has been recorded as not existing"
 * 非存在範囲内の Object を受信したら malformed Track である。範囲の境界 (両端) と
 * 外側を検証する。
 */
test("assertObjectNotInNonExistentRange: 非存在範囲内の Object だけを拒否する", () => {
  const state = createObjectStateTracking();
  registerNonExistentRange(state, { start: location(10n, 5n), end: location(10n, 8n) });

  assert.throws(() => assertObjectNotInNonExistentRange(state, 10n, 5n), MalformedTrackError);
  assert.throws(() => assertObjectNotInNonExistentRange(state, 10n, 7n), MalformedTrackError);
  assert.throws(() => assertObjectNotInNonExistentRange(state, 10n, 8n), MalformedTrackError);

  // 範囲の前後の位置は存在しても矛盾しない
  assert.doesNotThrow(() => assertObjectNotInNonExistentRange(state, 10n, 4n));
  assert.doesNotThrow(() => assertObjectNotInNonExistentRange(state, 10n, 9n));
  // 同じ Object ID でも Group が違えば別の Location である
  assert.doesNotThrow(() => assertObjectNotInNonExistentRange(state, 11n, 7n));
});

/**
 * draft-ietf-moq-transport-23 §2.1.2:
 * Gone / Unknown / Timed-Out は非存在の断定ではないため、このモジュールには
 * 非存在範囲として登録しない。それらの後に実 Object が届いても拒否しない。
 * (Gone / Unknown / Timed-Out の受理は FETCH 経路のテストで検証する)
 */
test("assertObjectNotInNonExistentRange: 記録していない位置は受理する", () => {
  const state = createObjectStateTracking();

  // 何も記録していない状態で任意の位置を受信しても malformed にならない
  assert.doesNotThrow(() => assertObjectNotInNonExistentRange(state, 0n, 0n));
  assert.doesNotThrow(() => assertObjectNotInNonExistentRange(state, MAX_VARINT, MAX_VARINT));
});

/**
 * draft-ietf-moq-transport-23 §12.1 条件 10:
 * "or is signalled as not existing after it was received"
 * 受信済み Object を含む非存在範囲の通知は malformed Track である。
 */
test("assertNoReceivedObjectInRange: 受信済み Object を含む非存在通知を拒否する", () => {
  const state = createObjectStateTracking();
  receive(state, 10n, 7n);

  // 受信済みの 10:7 を覆う範囲は矛盾
  assert.throws(
    () =>
      assertNoReceivedObjectInRange(state, { start: location(10n, 5n), end: location(10n, 8n) }),
    MalformedTrackError,
  );
  assert.throws(
    () =>
      assertNoReceivedObjectInRange(state, { start: location(10n, 7n), end: location(10n, 7n) }),
    MalformedTrackError,
  );

  // 受信済みの位置を含まない範囲は矛盾しない (隣接は含まない)
  assert.doesNotThrow(() =>
    assertNoReceivedObjectInRange(state, { start: location(10n, 8n), end: location(10n, 9n) }),
  );
  assert.doesNotThrow(() =>
    assertNoReceivedObjectInRange(state, { start: location(10n, 5n), end: location(10n, 6n) }),
  );
});

/**
 * 受信済み区間が上限で破棄された後は、その位置を覆う非存在通知を誤って拒否しない
 * (検出漏れのみで誤検出は生まない)。
 */
test("assertNoReceivedObjectInRange: 破棄した受信済み区間を根拠に誤検出しない", () => {
  const state = createObjectStateTracking();

  // 上限まで分断区間を作り、最古の 10:0 を破棄させる
  for (let index = 0; index < 1025; index++) {
    receive(state, 10n, BigInt(index) * 2n);
  }
  assert.isFalse(state.receivedRanges.some((range) => range.start.object === 0n));

  // 破棄済みの位置を覆う非存在通知は受理する
  assert.doesNotThrow(() =>
    assertNoReceivedObjectInRange(state, { start: location(10n, 0n), end: location(10n, 0n) }),
  );
  // 保持中の位置を覆う通知は拒否する
  assert.throws(
    () =>
      assertNoReceivedObjectInRange(state, { start: location(10n, 2n), end: location(10n, 2n) }),
    MalformedTrackError,
  );
});

/** assertAndRegisterNonExistentRange は検証に通った範囲だけを記録する */
test("assertAndRegisterNonExistentRange: 矛盾する範囲は記録しない", () => {
  const state = createObjectStateTracking();
  receive(state, 10n, 7n);

  assert.throws(
    () =>
      assertAndRegisterNonExistentRange(state, {
        start: location(10n, 5n),
        end: location(10n, 8n),
      }),
    MalformedTrackError,
  );
  assert.equal(state.nonExistentRanges.length, 0);

  assert.doesNotThrow(() =>
    assertAndRegisterNonExistentRange(state, { start: location(10n, 8n), end: location(10n, 9n) }),
  );
  assert.deepEqual(
    state.nonExistentRanges.map((range) => describeRange(range)),
    ["10:8-10:9"],
  );
});

// ============================================================================
// Object Status / End of Group / End of Track が通知する範囲
// draft-ietf-moq-transport-23 §11.1.1 / §11.4.2.2 / §12.1
// ============================================================================

/**
 * End of Group は同じ Group の指定 Object ID より後が存在しないことを通知する。
 * 最終 Object が Group の末尾 (Object ID 2^64-1) なら後続は無い。
 */
test("trackLocationRangeAfterFinalObject: End of Group は同じ Group の残りを通知する", () => {
  assert.deepEqual(
    describeRange(
      trackLocationRangeAfterFinalObject("end_of_group", 10n, 5n) ?? {
        start: location(0n, 0n),
        end: location(0n, 0n),
      },
    ),
    "10:6-10:18446744073709551615",
  );
  assert.isUndefined(trackLocationRangeAfterFinalObject("end_of_group", 10n, MAX_VARINT));
});

/**
 * End of Track は Track 全体の指定 Location より後が存在しないことを通知する。
 * Track の末尾 (Group / Object ID とも 2^64-1) なら後続は無い。
 */
test("trackLocationRangeAfterFinalObject: End of Track は Track の残りを通知する", () => {
  assert.deepEqual(
    describeRange(
      trackLocationRangeAfterFinalObject("end_of_track", 10n, 5n) ?? {
        start: location(0n, 0n),
        end: location(0n, 0n),
      },
    ),
    "10:6-18446744073709551615:18446744073709551615",
  );
  assert.isUndefined(trackLocationRangeAfterFinalObject("end_of_track", MAX_VARINT, MAX_VARINT));
});

// ============================================================================
// FETCH 応答の traversal order 上の境界
// draft-ietf-moq-transport-23 §3.2.2
// ============================================================================

/**
 * Ascending と、Start / End が同じ Group の Descending では、Start Location が
 * 最初の境界、End Location が最後の境界である。
 */
test("getFetchTraversalBoundaries: Ascending と同一 Group の Descending は Start / End が境界になる", () => {
  const start = location(10n, 5n);
  const end = location(12n, 3n);

  assert.deepEqual(getFetchTraversalBoundaries(GroupOrder.ASCENDING, start, end), {
    first: start,
    last: end,
  });
  // 同一 Group の Descending では Group 内の Object ID 昇順で並ぶため同じ境界
  assert.deepEqual(
    getFetchTraversalBoundaries(GroupOrder.DESCENDING, location(10n, 5n), location(10n, 9n)),
    { first: location(10n, 5n), last: location(10n, 9n) },
  );
});

/**
 * Start / End が異なる Group の Descending では、最初の期待位置が
 * {End Group, 0}、最後の期待位置が {Start Group, 2^64-1} である。
 */
test("getFetchTraversalBoundaries: Group をまたぐ Descending は期待位置が変わる", () => {
  const boundaries = getFetchTraversalBoundaries(
    GroupOrder.DESCENDING,
    location(10n, 5n),
    location(12n, 3n),
  );

  assert.deepEqual(boundaries.first, location(12n, 0n));
  assert.deepEqual(boundaries.last, location(10n, MAX_VARINT));
});

// ============================================================================
// FETCH 応答の暗黙 gap / End of Non-Existent Range の区間分解
// draft-ietf-moq-transport-23 §3.2.2
// ============================================================================

/** テスト用の FETCH 要求範囲 (Ascending) */
const ascendingRange = {
  groupOrder: GroupOrder.ASCENDING,
  startLocation: location(10n, 0n),
  endLocation: location(12n, 3n),
};

/**
 * 先頭 Object より前の gap は Start Location から最初の Object の前までである。
 * 要求範囲の下限でクランプする。
 */
test("buildFetchTraversalGapRanges: Ascending の先頭 gap を Start Location から求める", () => {
  const ranges = buildFetchTraversalGapRanges({
    ...ascendingRange,
    from: { location: location(10n, 0n), inclusive: true },
    to: { location: location(10n, 5n), inclusive: false },
  });

  assert.deepEqual(
    ranges.map((range) => describeRange(range)),
    ["10:0-10:4"],
  );
});

/** 同じ Group の Object 間の gap は直前の Object の次から次の Object の前まで */
test("buildFetchTraversalGapRanges: 同じ Group の Object 間 gap を求める", () => {
  const ranges = buildFetchTraversalGapRanges({
    ...ascendingRange,
    from: { location: location(10n, 5n), inclusive: false },
    to: { location: location(10n, 9n), inclusive: false },
  });

  assert.deepEqual(
    ranges.map((range) => describeRange(range)),
    ["10:6-10:8"],
  );
});

/**
 * End of Non-Existent Range の範囲端は通知された Location を含む。
 * 直前の Object は含まない。
 */
test("buildFetchTraversalGapRanges: End of Non-Existent Range は範囲端を含む", () => {
  const ranges = buildFetchTraversalGapRanges({
    ...ascendingRange,
    from: { location: location(10n, 5n), inclusive: false },
    to: { location: location(10n, 9n), inclusive: true },
  });

  assert.deepEqual(
    ranges.map((range) => describeRange(range)),
    ["10:6-10:9"],
  );
});

/**
 * Ascending で Group をまたぐ gap は、直前 Group の残り・間の Group 全体・
 * 次の Group の先頭に分かれる。Group を 1 つずつ展開せず最大 3 件の区間になる。
 */
test("buildFetchTraversalGapRanges: Ascending で Group をまたぐ gap を 3 件へ分解する", () => {
  const ranges = buildFetchTraversalGapRanges({
    groupOrder: GroupOrder.ASCENDING,
    startLocation: location(10n, 0n),
    endLocation: location(1000000n, MAX_VARINT),
    from: { location: location(10n, 5n), inclusive: false },
    to: { location: location(1000000n, 3n), inclusive: false },
  });

  assert.deepEqual(
    ranges.map((range) => describeRange(range)),
    ["10:6-10:18446744073709551615", "11:0-999999:18446744073709551615", "1000000:0-1000000:2"],
  );
});

/**
 * Descending で Group をまたぐ gap は、直前 Group の残り・間の Group 全体・
 * 次の Group の先頭 (Start Location の Object ID でクランプ) に分かれる。
 */
test("buildFetchTraversalGapRanges: Group をまたぐ Descending の gap を分解する", () => {
  const ranges = buildFetchTraversalGapRanges({
    groupOrder: GroupOrder.DESCENDING,
    startLocation: location(10n, 5n),
    endLocation: location(12n, 3n),
    // 12:2 の後に 10:5 が続く (Group 12 の残り・Group 11 全体)
    from: { location: location(12n, 2n), inclusive: false },
    to: { location: location(10n, 5n), inclusive: false },
  });

  assert.deepEqual(
    ranges.map((range) => describeRange(range)),
    ["12:3-12:3", "11:0-11:18446744073709551615"],
  );
});

/**
 * Descending の先頭 gap は {End Group, 0} から最初の Object の前までである。
 * 要求範囲の上限 (End Location の Object ID) でクランプする。
 */
test("buildFetchTraversalGapRanges: Descending の先頭 gap を期待位置から求める", () => {
  const ranges = buildFetchTraversalGapRanges({
    groupOrder: GroupOrder.DESCENDING,
    startLocation: location(10n, 5n),
    endLocation: location(12n, 3n),
    from: { location: location(12n, 0n), inclusive: true },
    to: { location: location(12n, 2n), inclusive: false },
  });

  assert.deepEqual(
    ranges.map((range) => describeRange(range)),
    ["12:0-12:1"],
  );
});

/**
 * traversal order と矛盾する入力 (Ascending で Group が後退、同じ Group で
 * Object ID が後退) では区間を作らない。要求範囲外の位置を端点にした区間も
 * 推測しない。誤った非存在範囲を記録して後の受信を誤検出しないための防御である。
 */
test("buildFetchTraversalGapRanges: traversal order と矛盾する入力では区間を作らない", () => {
  // Ascending で Group が後退している
  assert.deepEqual(
    buildFetchTraversalGapRanges({
      ...ascendingRange,
      from: { location: location(12n, 0n), inclusive: false },
      to: { location: location(10n, 5n), inclusive: false },
    }),
    [],
  );
  // 同じ Group で Object ID が後退している
  assert.deepEqual(
    buildFetchTraversalGapRanges({
      ...ascendingRange,
      from: { location: location(10n, 9n), inclusive: false },
      to: { location: location(10n, 5n), inclusive: false },
    }),
    [],
  );
  // 要求範囲の外側を端点にしている
  assert.deepEqual(
    buildFetchTraversalGapRanges({
      ...ascendingRange,
      from: { location: location(10n, 5n), inclusive: false },
      to: { location: location(13n, 0n), inclusive: false },
    }),
    [],
  );
  // 隣接するエントリー間に gap は無い
  assert.deepEqual(
    buildFetchTraversalGapRanges({
      ...ascendingRange,
      from: { location: location(10n, 5n), inclusive: false },
      to: { location: location(10n, 6n), inclusive: false },
    }),
    [],
  );
});

// ============================================================================
// FETCH 応答の末尾 gap
// draft-ietf-moq-transport-23 §3.2.2 ("Gaps at the end of a stream are only
// detectable when the stream is terminated by a FIN.")
// ============================================================================

/**
 * Ascending で FIN を迎えたとき、最後にシリアライズされた位置から End Location
 * までを非存在範囲にする。要求範囲の上限でクランプする。
 */
test("buildFetchTrailingGapRanges: Ascending の末尾 gap を End Location まで求める", () => {
  const ranges = buildFetchTrailingGapRanges({
    groupOrder: GroupOrder.ASCENDING,
    startLocation: location(10n, 0n),
    endLocation: location(12n, 3n),
    lastSerializedLocation: location(10n, 5n),
  });

  assert.deepEqual(
    ranges.map((range) => describeRange(range)),
    ["10:6-10:18446744073709551615", "11:0-11:18446744073709551615", "12:0-12:3"],
  );
});

/**
 * Descending で Group をまたぐ要求の末尾 gap は、最後の Object の後ろから
 * {Start Group, 2^64-1} までである。Start Location の Object ID でクランプする。
 */
test("buildFetchTrailingGapRanges: Group をまたぐ Descending の末尾 gap を求める", () => {
  const ranges = buildFetchTrailingGapRanges({
    groupOrder: GroupOrder.DESCENDING,
    startLocation: location(10n, 5n),
    endLocation: location(12n, 3n),
    lastSerializedLocation: location(12n, 2n),
  });

  assert.deepEqual(
    ranges.map((range) => describeRange(range)),
    ["12:3-12:3", "11:0-11:18446744073709551615", "10:5-10:18446744073709551615"],
  );
});

/**
 * FIN までに 1 件もシリアライズされなかった場合、要求範囲全体が gap になる
 * (§3.2.1: 要求範囲に Object が無ければ FETCH_HEADER だけで FIN する)。
 */
test("buildFetchTrailingGapRanges: シリアライズ済み位置が無ければ要求範囲全体を返す", () => {
  const ranges = buildFetchTrailingGapRanges({
    groupOrder: GroupOrder.ASCENDING,
    startLocation: location(10n, 2n),
    endLocation: location(11n, 3n),
    lastSerializedLocation: undefined,
  });

  assert.deepEqual(
    ranges.map((range) => describeRange(range)),
    ["10:2-10:18446744073709551615", "11:0-11:3"],
  );
});

/**
 * 最後のエントリーが既に End Location までを覆っている場合は末尾 gap が空になる。
 * 既に非存在と確定した位置を重複して記録しない。
 */
test("buildFetchTrailingGapRanges: 最後の位置が End Location なら末尾 gap は空", () => {
  const ranges = buildFetchTrailingGapRanges({
    groupOrder: GroupOrder.ASCENDING,
    startLocation: location(10n, 0n),
    endLocation: location(10n, 9n),
    lastSerializedLocation: location(10n, 9n),
  });

  assert.deepEqual(ranges, []);
});
