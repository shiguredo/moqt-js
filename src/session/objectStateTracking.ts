/**
 * Track 単位の Object 状態追跡 (受信済み位置と確定した非存在範囲)
 *
 * draft-ietf-moq-transport-23 §2.1.2 (Object States) は Object の状態を
 * Unknown / Exists / Gone / Does Not Exist の 4 種に分け、Does Not Exist を
 * 永続的な状態と定める。同節は「元の publisher が配送できず、存在するかどうかも
 * 分からない」Gone と、「存在しないと確定した」Does Not Exist を区別し、Gone /
 * Unknown として記録した位置に実 Object が後から届いても矛盾ではないとする。
 * §12.1 (Malformed Tracks) 条件 10 は、実 Object と非存在通知の両方向の矛盾
 * (「非存在として記録済みの Object の受信」と「受信済み Object を非存在として
 * 通知すること」) を malformed Track とする。
 *
 * 本モジュールはその判定に必要な「受信済み位置」と「確定した非存在範囲」を
 * Location (Group ID と Object ID の辞書式順序) の閉区間として保持する。
 * 仕様は非存在を連続した Location の範囲として通知する (§2.1.2 末尾) ため、
 * Object ごとの配列へ展開せず区間として持つ。広い範囲 (Object ID は最大 2^64-1)
 * を展開すると受信経路が停止するため、区間の加算・統合だけで扱う。
 *
 * 保持件数には上限があり、超過時は最も古い記録から破棄する。破棄した記録は
 * 受信済み / 非存在の根拠に使わないため、誤検出は生まず、破棄した履歴との矛盾を
 * 検出できなくなる (検出漏れのみ) 制限がある。
 *
 * 節番号・語彙は将来のドラフト改訂で変わり得るため、改訂時は引用を更新する。
 */

import { MalformedTrackError } from "../error";
import type { Location } from "../message";
import { GroupOrder } from "../message/types";
import { MAX_VARINT } from "../varint";
import { compareLocations } from "./params";

/**
 * Track の受信済み区間の上限
 *
 * 超過時は最も古い区間から破棄する。Track ごとの保持量を長寿命 Track でも
 * 抑えるための値であり、外部へ公開しない (テストはこの値と一致する件数で検証する)。
 */
const MAX_TRACKED_RECEIVED_RANGES = 1024;

/**
 * Track の確定済み非存在区間の上限
 *
 * 超過時は最も古い区間から破棄する。Track ごとの保持量を長寿命 Track でも
 * 抑えるための値であり、外部へ公開しない (テストはこの値と一致する件数で検証する)。
 */
const MAX_TRACKED_NON_EXISTENT_RANGES = 1024;

/**
 * Location の閉区間 (Group ID と Object ID の辞書式順序)
 *
 * draft-ietf-moq-transport-23 §2.1.2: 非存在は「連続した範囲」として通知される
 * ため、範囲の両端だけで表現する。start は end 以下である。
 */
export interface TrackLocationRange {
  readonly start: Location;
  readonly end: Location;
}

/**
 * Track ごとの Object 状態追跡
 *
 * receivedRanges と nonExistentRanges は受信順 (配列の先頭が最も古い) であり、
 * 上限を超えたときに最も古い記録から破棄するために使う。
 */
export interface ObjectStateTracking {
  /**
   * 実 Object を受信した位置の区間
   *
   * §12.1 条件 10 の「受信済み Object を非存在として通知すること」の判定に使う。
   * 隣接・重複する位置は 1 つの区間に統合する。
   */
  readonly receivedRanges: TrackLocationRange[];
  /**
   * 非存在が確定した位置の区間
   *
   * §12.1 条件 10 の「非存在として記録済みの Object の受信」の判定に使う。
   * 非存在の通知はすべて権威的である (§2.1.2)。隣接・重複する範囲は統合する。
   */
  readonly nonExistentRanges: TrackLocationRange[];
}

/** 空の Object 状態追跡を作る */
export function createObjectStateTracking(): ObjectStateTracking {
  return {
    receivedRanges: [],
    nonExistentRanges: [],
  };
}

/** Location を作る */
function locationOf(groupId: bigint, objectId: bigint): Location {
  return { group: groupId, object: objectId };
}

/**
 * Location の直後の位置を返す
 *
 * Object ID が 2^64-1 のときは次の Group の先頭 ({Group + 1, 0}) になる。
 * Group ID も 2^64-1 の場合は後続が存在しないため undefined を返す。
 */
function locationSuccessor(location: Location): Location | undefined {
  if (location.object < MAX_VARINT) {
    return locationOf(location.group, location.object + 1n);
  }
  if (location.group < MAX_VARINT) {
    return locationOf(location.group + 1n, 0n);
  }
  return undefined;
}

/** start が end の直後以下か (end が最大位置なら常に true) */
function isStartAtOrBeforeSuccessor(start: Location, end: Location): boolean {
  const successor = locationSuccessor(end);
  if (successor === undefined) {
    return true;
  }
  return compareLocations(start, successor) <= 0;
}

/**
 * 2 つの区間が重複または隣接するか
 *
 * 隣接 (例: [{0,0}-{0,5}] と [{0,6}-{0,9}]) も 1 つの区間へ統合できるため
 * 「接している」とみなす。
 */
function rangesOverlapOrAdjacent(a: TrackLocationRange, b: TrackLocationRange): boolean {
  return isStartAtOrBeforeSuccessor(a.start, b.end) && isStartAtOrBeforeSuccessor(b.start, a.end);
}

/** 2 つの区間が重複するか (隣接は含まない) */
function rangesOverlap(a: TrackLocationRange, b: TrackLocationRange): boolean {
  return compareLocations(a.start, b.end) <= 0 && compareLocations(b.start, a.end) <= 0;
}

/**
 * 区間を配列へ登録し、重複・隣接する区間を 1 件に統合する
 *
 * 統合した区間は最初に統合対象となった区間の位置に置き、残りの統合対象を除く。
 * これにより配列の先頭ほど古い記録であるという性質を保ち、上限超過時に最も古い
 * 記録から破棄できる。上限を超えた場合は最も古い区間から破棄する。
 */
function registerRange(
  ranges: TrackLocationRange[],
  range: TrackLocationRange,
  maxRanges: number,
): void {
  const mergedIndices: number[] = [];
  let mergedStart = range.start;
  let mergedEnd = range.end;
  for (let index = 0; index < ranges.length; index++) {
    const existing = ranges[index];
    if (existing === undefined) {
      continue;
    }
    if (!rangesOverlapOrAdjacent(existing, { start: mergedStart, end: mergedEnd })) {
      continue;
    }
    mergedIndices.push(index);
    if (compareLocations(existing.start, mergedStart) < 0) {
      mergedStart = existing.start;
    }
    if (compareLocations(existing.end, mergedEnd) > 0) {
      mergedEnd = existing.end;
    }
  }

  if (mergedIndices.length === 0) {
    // 上限を超える場合は最も古い区間から破棄して 1 件分の空きを作る
    while (ranges.length >= maxRanges) {
      ranges.shift();
    }
    ranges.push({ start: mergedStart, end: mergedEnd });
    return;
  }

  // 統合対象を後ろから除去し、最初の統合対象の位置へ統合結果を挿入する
  for (let index = mergedIndices.length - 1; index >= 0; index--) {
    const removeIndex = mergedIndices[index];
    if (removeIndex !== undefined) {
      ranges.splice(removeIndex, 1);
    }
  }
  const insertIndex = Math.min(mergedIndices[0] ?? ranges.length, ranges.length);
  ranges.splice(insertIndex, 0, { start: mergedStart, end: mergedEnd });
  while (ranges.length > maxRanges) {
    ranges.shift();
  }
}

/**
 * 実 Object を受信した位置を記録する
 *
 * 検証 (非存在範囲との矛盾判定) を通った Object だけが呼ぶ。同じ Object や隣接
 * する Object の反復受信は 1 つの区間へ統合されるため、Object 数に比例した
 * 保持件数にならない。
 */
export function registerReceivedObjectLocation(
  state: ObjectStateTracking,
  groupId: bigint,
  objectId: bigint,
): void {
  const location = locationOf(groupId, objectId);
  registerRange(
    state.receivedRanges,
    { start: location, end: location },
    MAX_TRACKED_RECEIVED_RANGES,
  );
}

/**
 * 確定した非存在範囲を記録する
 *
 * 呼び出し側は事前に assertNoReceivedObjectInRange で「非存在の通知が受信済み
 * Object を覆わないこと」を検証する。start <= end の範囲を渡す前提であり、
 * 空の範囲 (start > end) の除外は assertAndRegisterNonExistentRange が行う。
 */
export function registerNonExistentRange(
  state: ObjectStateTracking,
  range: TrackLocationRange,
): void {
  registerRange(state.nonExistentRanges, range, MAX_TRACKED_NON_EXISTENT_RANGES);
}

/**
 * 受信した Object が非存在が確定した位置に無いことを検証する
 *
 * draft-ietf-moq-transport-23 §12.1 条件 10:
 * "An Object is received after it has been recorded as not existing"
 * draft-ietf-moq-transport-23 §2.1.2: "All signals that an Object does not exist
 *  are authoritative."
 * 保存している非存在区間 (履歴) のどれかに含まれる Object は malformed Track
 * である。上限で破棄した区間は判定に使わないため、破棄済みの位置では検出できない
 * (検出漏れのみで誤検出は生まない)。
 *
 * @throws MalformedTrackError 非存在区間内の Object だった場合
 */
export function assertObjectNotInNonExistentRange(
  state: ObjectStateTracking,
  groupId: bigint,
  objectId: bigint,
): void {
  const location = locationOf(groupId, objectId);
  for (const range of state.nonExistentRanges) {
    if (
      compareLocations(range.start, location) <= 0 &&
      compareLocations(location, range.end) <= 0
    ) {
      throw new MalformedTrackError(
        `malformed track: object ${groupId}:${objectId} is in a range signalled as not existing ` +
          `(${range.start.group}:${range.start.object}-${range.end.group}:${range.end.object})`,
      );
    }
  }
}

/**
 * 非存在として通知された範囲が受信済み Object を含まないことを検証する
 *
 * draft-ietf-moq-transport-23 §12.1 条件 10:
 * "or is signalled as not existing after it was received"
 * 通知された区間と、保存している受信済み区間の交差を調べる。交差した場合は
 * malformed Track である。上限で破棄した受信済み区間は判定に使わないため、
 * 破棄済みの履歴との矛盾は検出できない (検出漏れのみで誤検出は生まない)。
 *
 * @throws MalformedTrackError 通知範囲が受信済み Object を覆った場合
 */
export function assertNoReceivedObjectInRange(
  state: ObjectStateTracking,
  range: TrackLocationRange,
): void {
  for (const received of state.receivedRanges) {
    if (!rangesOverlap(received, range)) {
      continue;
    }
    throw new MalformedTrackError(
      `malformed track: range ${range.start.group}:${range.start.object}-` +
        `${range.end.group}:${range.end.object} is signalled as not existing but includes ` +
        `already received object in ${received.start.group}:${received.start.object}-` +
        `${received.end.group}:${received.end.object}`,
    );
  }
}

/**
 * 非存在範囲を検証してから記録する
 *
 * 通知の受理経路 (End of Non-Existent Range / 暗黙 gap / 終端宣言) で使う。
 * 空の範囲 (start > end) は通知として意味を持たないため、検証も記録もせずに
 * 無視する。空区間の判定はこの関数に集約する。
 *
 * @throws MalformedTrackError 通知範囲が受信済み Object を覆った場合
 */
export function assertAndRegisterNonExistentRange(
  state: ObjectStateTracking,
  range: TrackLocationRange,
): void {
  if (compareLocations(range.start, range.end) > 0) {
    return;
  }
  assertNoReceivedObjectInRange(state, range);
  registerNonExistentRange(state, range);
}

/**
 * 指定 Location より後の非存在範囲を作る (Object Status / End of Group / End of Track)
 *
 * draft-ietf-moq-transport-23 §11.1.1 (Object Status) は End of Group (0x3) を
 * 「指定した Group ID と指定した Object ID 以上の Object が Group 内に存在しない」
 * こと、End of Track (0x4) を「指定した Location 以上の Object が存在しない」
 * ことの通知とする。ただし Status を持つ Object 自身は実在する Object であり
 * (§12.1 条件 4 は「Object Status が END_OF_GROUP の Object」を Group の最終
 * Object とする)、非存在になるのはその位置より後である。
 * draft-ietf-moq-transport-23 §11.4.2.2 の End of Group / End of Track
 * indicator も「直前の実 Object が Group / Track の最後の Object」を意味するため、
 * 同じ区間を通知するものとして扱う。
 *
 * @param kind - "end_of_group" は同じ Group の残り、"end_of_track" は Track の残り
 * @returns 非存在区間。通知位置より後が存在しない場合は undefined
 */
export function trackLocationRangeAfterFinalObject(
  kind: "end_of_group" | "end_of_track",
  groupId: bigint,
  objectId: bigint,
): TrackLocationRange | undefined {
  const start = locationSuccessor(locationOf(groupId, objectId));
  if (start === undefined) {
    return undefined;
  }
  if (kind === "end_of_group") {
    // 最終 Object が Group の末尾 (Object ID 2^64-1) の場合、Group 内に後続は無い
    if (start.group !== groupId) {
      return undefined;
    }
    return { start, end: locationOf(groupId, MAX_VARINT) };
  }
  return { start, end: locationOf(MAX_VARINT, MAX_VARINT) };
}

/**
 * FETCH 応答の traversal order 上の区間端点
 *
 * inclusive は端点自身を区間に含めるかどうかを表す。FETCH の gap は「直前の
 * エントリーの次」から「次のエントリーの前」までであり、End of Range の範囲端は
 * 含み、暗黙 gap の両端は含まない、という違いをこのフラグで表現する。
 */
export interface FetchTraversalEndpoint {
  readonly location: Location;
  readonly inclusive: boolean;
}

/**
 * FETCH 応答の区間を求める入力
 *
 * draft-ietf-moq-transport-23 §3.2.2 (Gaps in a Fetch Stream):
 * - Start Location / End Location は要求範囲の両端 (End Location は LARGEST_OBJECT
 *   が要求範囲内ならその位置、そうでなければ要求 End Location)
 * - Group Order が Ascending のときは Group を昇順、Descending のときは Group を
 *   降順に辿る。Group 内の Object ID は常に昇順である
 * - 最初の Group では Start Location の Object ID が下限、最後の Group では
 *   End Location の Object ID が上限になる
 */
export interface FetchTraversalGapOptions {
  /** FETCH 要求の Group Order */
  readonly groupOrder: GroupOrder;
  /** 要求した Start Location (含む) */
  readonly startLocation: Location;
  /** 応答がカバーする inclusive な上限 (End Location) */
  readonly endLocation: Location;
  /** 区間の始点 (traversal order で前側) */
  readonly from: FetchTraversalEndpoint;
  /** 区間の終点 (traversal order で後側) */
  readonly to: FetchTraversalEndpoint;
}

/**
 * FETCH 応答の traversal order 上の境界を返す
 *
 * draft-ietf-moq-transport-23 §3.2.2:
 * - Ascending と、Start / End Location が同じ Group の Descending では、
 *   Start Location が最初の境界、End Location が最後の境界である
 * - Start / End Location が異なる Group の Descending では、最初に期待される
 *   Object が {End Location.Group, 0}、最後に期待される Object が
 *   {Start Location.Group, 2^64-1} である
 */
export function getFetchTraversalBoundaries(
  groupOrder: GroupOrder,
  startLocation: Location,
  endLocation: Location,
): { first: Location; last: Location } {
  if (groupOrder === GroupOrder.DESCENDING && startLocation.group !== endLocation.group) {
    return {
      first: locationOf(endLocation.group, 0n),
      last: locationOf(startLocation.group, MAX_VARINT),
    };
  }
  return { first: startLocation, last: endLocation };
}

/** 区間の始点側を「含む/含まない」から最初の Object ID へ変換する */
function resolveFromObjectId(endpoint: FetchTraversalEndpoint): bigint | undefined {
  if (endpoint.inclusive) {
    return endpoint.location.object;
  }
  if (endpoint.location.object === MAX_VARINT) {
    // この Group には後続の Object ID が無い (traversal order では次の Group へ進む)
    return undefined;
  }
  return endpoint.location.object + 1n;
}

/** 区間の終点側を「含む/含まない」から最後の Object ID へ変換する */
function resolveToObjectId(endpoint: FetchTraversalEndpoint): bigint | undefined {
  if (endpoint.inclusive) {
    return endpoint.location.object;
  }
  if (endpoint.location.object === 0n) {
    return undefined;
  }
  return endpoint.location.object - 1n;
}

/**
 * traversal order の区間を辞書式順序の区間へ分解する
 *
 * draft-ietf-moq-transport-23 §3.2.2: Group Order が Ascending のときは Group を
 * 昇順、Descending のときは Group を降順に辿り、Group 内の Object ID は常に昇順で
 * ある。Group をまたぐ区間は、始点側の Group の残り・間の Group 全体・終点側の
 * Group の先頭に分かれる。Group 内の上下限は呼び出し元が関数で与え、要求範囲が
 * 無い経路では全体 (0 から 2^64-1) を渡す。
 *
 * @param groupOrder - FETCH 要求の Group Order
 * @param from - 区間の始点 (traversal order で前側、含まない)
 * @param to - 区間の終点 (traversal order で後側、含む)
 * @param minObjectIdOf - Group ごとの下限 Object ID
 * @param maxObjectIdOf - Group ごとの上限 Object ID
 * @returns 非存在とみなせる区間の配列。traversal order と矛盾する入力では空
 */
function decomposeTraversalInterval(
  groupOrder: GroupOrder,
  from: FetchTraversalEndpoint,
  to: FetchTraversalEndpoint,
  minObjectIdOf: (groupId: bigint) => bigint,
  maxObjectIdOf: (groupId: bigint) => bigint,
): TrackLocationRange[] {
  if (from.location.group !== to.location.group) {
    // Ascending は Group 昇順、Descending は Group 降順に辿る
    const groupOrderViolated =
      groupOrder === GroupOrder.DESCENDING
        ? from.location.group < to.location.group
        : from.location.group > to.location.group;
    if (groupOrderViolated) {
      return [];
    }
  } else if (from.location.object > to.location.object) {
    // Group 内の Object ID は Group Order に関わらず昇順
    return [];
  }

  const ranges: TrackLocationRange[] = [];
  const resolvedFrom = resolveFromObjectId(from);
  const resolvedTo = resolveToObjectId(to);

  if (from.location.group === to.location.group) {
    if (resolvedFrom === undefined || resolvedTo === undefined) {
      return ranges;
    }
    const lower =
      resolvedFrom > minObjectIdOf(from.location.group)
        ? resolvedFrom
        : minObjectIdOf(from.location.group);
    const upper =
      resolvedTo < maxObjectIdOf(from.location.group)
        ? resolvedTo
        : maxObjectIdOf(from.location.group);
    if (lower <= upper) {
      ranges.push({
        start: locationOf(from.location.group, lower),
        end: locationOf(from.location.group, upper),
      });
    }
    return ranges;
  }

  // 始点側の Group の残り。始点が Group 末尾 (Object ID 2^64-1) で排他なら残りは無い
  if (resolvedFrom !== undefined) {
    const lower =
      resolvedFrom > minObjectIdOf(from.location.group)
        ? resolvedFrom
        : minObjectIdOf(from.location.group);
    const upper = maxObjectIdOf(from.location.group);
    if (lower <= upper) {
      ranges.push({
        start: locationOf(from.location.group, lower),
        end: locationOf(from.location.group, upper),
      });
    }
  }

  // 間の Group 全体 (昇順・降順のどちらでも同じ Group 集合になる)
  const lowerMiddleGroup =
    (from.location.group < to.location.group ? from.location.group : to.location.group) + 1n;
  const upperMiddleGroup =
    (from.location.group > to.location.group ? from.location.group : to.location.group) - 1n;
  if (lowerMiddleGroup <= upperMiddleGroup) {
    ranges.push({
      start: locationOf(lowerMiddleGroup, 0n),
      end: locationOf(upperMiddleGroup, MAX_VARINT),
    });
  }

  // 終点側の Group の先頭
  if (resolvedTo !== undefined) {
    const lower = minObjectIdOf(to.location.group);
    const upper =
      resolvedTo < maxObjectIdOf(to.location.group) ? resolvedTo : maxObjectIdOf(to.location.group);
    if (lower <= upper) {
      ranges.push({
        start: locationOf(to.location.group, lower),
        end: locationOf(to.location.group, upper),
      });
    }
  }

  return ranges;
}

/**
 * FETCH 応答の traversal order 上の区間を、Location の辞書式順序の区間へ分解する
 *
 * draft-ietf-moq-transport-23 §3.2.2: Group Order が Descending で Group を
 * またぐ場合、traversal order の連続区間は辞書式順序の連続区間にならない
 * (直前行の残り・間の Group 全体・次の行の先頭に分かれる)。その場合は最大 3 件の
 * 辞書式区間へ分解して返す。要求範囲外の位置は区間に含めない (先頭 Group の下限と
 * 末尾 Group の上限でクランプする)。
 *
 * @returns 非存在とみなせる区間の配列。traversal order と矛盾する入力では空
 */
export function buildFetchTraversalGapRanges(
  options: FetchTraversalGapOptions,
): TrackLocationRange[] {
  const { groupOrder, startLocation, endLocation, from, to } = options;
  const startGroup = startLocation.group;
  const endGroup = endLocation.group;
  if (startGroup > endGroup) {
    // 要求範囲の Start が End より後になることはない (§3.2 の要求範囲の検証済み)
    return [];
  }
  if (
    from.location.group < startGroup ||
    from.location.group > endGroup ||
    to.location.group < startGroup ||
    to.location.group > endGroup
  ) {
    // 要求範囲外の位置を端点にした区間は推測せず扱わない
    return [];
  }

  // Group ごとの要求範囲の下限 / 上限。Start Location の Group では Start の
  // Object ID が下限、End Location の Group では End の Object ID が上限になる
  const minObjectIdOf = (groupId: bigint): bigint =>
    groupId === startGroup ? startLocation.object : 0n;
  const maxObjectIdOf = (groupId: bigint): bigint =>
    groupId === endGroup ? endLocation.object : MAX_VARINT;

  return decomposeTraversalInterval(groupOrder, from, to, minObjectIdOf, maxObjectIdOf);
}

/**
 * traversal order 上の区間を、要求範囲でクランプせずに辞書式区間へ分解する
 *
 * draft-ietf-moq-transport-23 §11.4.2 (End of Non-Existent Range):
 * "All Objects with Locations between the last serialized Object, if any, and the
 *  Location decoded from this indicator, inclusive, either do not exist ..."
 * fill fetch は要求範囲 (Start / End Location) を保持しないため暗黙 gap は
 * 推論しないが、この indicator が明示した範囲は要求範囲に依存せず、直前の
 * エントリーと復号位置の traversal order 上の区間そのものである。そのため
 * 要求範囲によるクランプを行わず、from の次から to までを返す。Descending で
 * Group をまたぐ場合も、辞書式順序では Group 単位に分かれる。
 *
 * @returns 非存在とみなせる区間の配列。traversal order と矛盾する入力では空
 */
export function buildFetchTraversalIntervalRanges(options: {
  readonly groupOrder: GroupOrder;
  readonly from: FetchTraversalEndpoint;
  readonly to: FetchTraversalEndpoint;
}): TrackLocationRange[] {
  return decomposeTraversalInterval(
    options.groupOrder,
    options.from,
    options.to,
    () => 0n,
    () => MAX_VARINT,
  );
}

/**
 * FETCH 応答の末尾 gap (最後にシリアライズされた位置から End Location まで) を求める
 *
 * draft-ietf-moq-transport-23 §3.2.2 (Gaps in a Fetch Stream):
 * "gaps include ranges ... between the last object in the stream and the End
 *  Location." / "Gaps at the end of a stream are only detectable when the stream
 *  is terminated by a FIN."
 * 最後のエントリーが無い (FIN までに 1 件もシリアライズされていない) 場合は、
 * 要求範囲全体が gap になる (§3.2.1 の「要求範囲に Object が無い場合」)。
 * lastSerializedLocation には直前の実 Object だけでなく End of Range indicator の
 * 復号位置も入るため、indicator が明示した範囲の後ろから推論できる。
 *
 * @returns 非存在とみなせる区間の配列。範囲が空、または traversal order と
 *   矛盾する入力では空
 */
export function buildFetchTrailingGapRanges(options: {
  readonly groupOrder: GroupOrder;
  readonly startLocation: Location;
  readonly endLocation: Location;
  readonly lastSerializedLocation?: Location;
}): TrackLocationRange[] {
  const boundaries = getFetchTraversalBoundaries(
    options.groupOrder,
    options.startLocation,
    options.endLocation,
  );
  const from: FetchTraversalEndpoint =
    options.lastSerializedLocation === undefined
      ? { location: boundaries.first, inclusive: true }
      : { location: options.lastSerializedLocation, inclusive: false };
  return buildFetchTraversalGapRanges({
    groupOrder: options.groupOrder,
    startLocation: options.startLocation,
    endLocation: options.endLocation,
    from,
    to: { location: boundaries.last, inclusive: true },
  });
}
