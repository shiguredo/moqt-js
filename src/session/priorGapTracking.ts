/**
 * Track 単位の Prior Group ID Gap / Prior Object ID Gap 追跡
 *
 * draft-ietf-moq-transport-21 §10.8 (Prior Group ID Gap) / §10.9 (Prior Object
 * ID Gap) の malformed Track 条件のうち、同一 Track の複数 Object と過去の受信
 * 状態を必要とする次の 5 条件を判定する。単一 Object の情報だけで判定できる
 * 「同一 Object 内の複数出現」と「gap が Group ID / Object ID より大きい」は
 * src/properties.ts の assertPriorIdGapInObjectProperties が先に検証する。
 *
 * - §10.8: 同一 Group 内で異なる値の Prior Group ID Gap を持つ Object の受信
 * - §10.8: 過去に受信した Object を覆う Prior Group ID Gap を持つ Object の受信
 * - §10.8: 過去に通知された gap 内の Group ID を持つ Object の受信
 * - §10.9: 過去に受信した Object を覆う Prior Object ID Gap を持つ Object の受信
 * - §10.9: 過去に通知された gap 内の Object ID を持つ Object の受信
 *
 * 追跡は Full Track Name 単位で行う。同一 Track の複数購読 / FETCH をまたいで
 * 判定する必要があるため、購読単位ではなく Track 単位で状態を保持する。
 * 状態のキーは fullTrackNameKey が生成する比較キーである。
 *
 * 対象範囲:
 * - 判定は発生した Object の受信経路に依存しない。subgroup / datagram / FETCH の
 *   どこから届いても同じ状態を更新し、同じ条件で判定する。
 * - datagram 経路は Track Alias と購読が特定できた場合だけ検証する。alias が
 *   不明な datagram、購読が 1 つも無い alias の datagram は対象外である。
 */

import { MalformedTrackError } from "../error";
import type { FullTrackNameKey } from "../fullTrackName";
import { MOQTPropertyId, decodeObjectPropertiesTolerant, type Property } from "../properties";

/**
 * Track ごとに保持する受信済み Group ID の上限
 *
 * 超過時は最も古い Group から破棄する。
 */
const MAX_TRACKED_GROUP_IDS = 1024;

/**
 * Group ごとに保持する受信済み Object ID の上限
 *
 * 超過時は最も古い Object ID から破棄する。Group の受信済み Object ID は
 * Prior Object ID Gap の覆い判定 (§10.9) にだけ使う。
 */
const MAX_TRACKED_OBJECT_IDS_PER_GROUP = 1024;

/**
 * Track ごとに保持する通知済み gap 範囲の上限
 *
 * Prior Group ID Gap と Prior Object ID Gap で別々に数える。超過時は最も古い
 * 範囲から破棄する。
 */
const MAX_TRACKED_GAP_RANGES = 1024;

/**
 * セッションで追跡する Track エントリの上限
 *
 * 超過時は最も古い Track エントリから破棄する。
 */
const MAX_TRACKED_TRACKS = 1024;

/**
 * 通知済み Prior Group ID Gap の範囲
 *
 * draft-ietf-moq-transport-21 §10.8:
 * Prior Group ID Gap = gap を持つ Group G の Object は「Group
 * [G - gap, G - 1] が存在しない」ことを通知する。1 次元の範囲と 2 要素の
 * Location を比較しないよう、Group ID の閉区間として保持する。
 */
export interface PriorGroupIdGapRange {
  start: bigint;
  end: bigint;
}

/**
 * 通知済み Prior Object ID Gap の範囲
 *
 * draft-ietf-moq-transport-21 §10.9:
 * Prior Object ID Gap = gap を持つ Object O は「同じ Group の Object
 * [O - gap, O - 1] が存在しない」ことを通知する。Object ID の範囲は通知元の
 * Group の中でだけ意味を持つため、通知元の Group ID と対応付けて保持する。
 */
export interface PriorObjectIdGapRange {
  group: bigint;
  start: bigint;
  end: bigint;
}

/**
 * Track 単位の追跡状態
 *
 * 保持する値は受信順 (Set / Map は挿入順、配列は push 順) であり、上限を
 * 超えたときに最も古いものから破棄するために使う。
 */
export interface PriorGapTracking {
  /**
   * 検証を通った Object の Group ID
   *
   * §10.8 の「過去に受信した Object を覆う Prior Group ID Gap」の判定に使う。
   */
  readonly receivedGroupIds: Set<bigint>;
  /**
   * Group ID ごとの、検証を通った Object の Object ID
   *
   * §10.9 の「過去に受信した Object を覆う Prior Object ID Gap」の判定に使う。
   * Object ID の範囲は現在の Group の中でだけ意味を持つため Group 単位で持つ。
   */
  readonly receivedObjectIdsByGroup: Map<bigint, Set<bigint>>;
  /**
   * 通知済み Prior Group ID Gap の範囲
   *
   * §10.8 の「過去に通知された gap 内の Group ID」の判定に使う。
   */
  readonly priorGroupIdGapRanges: PriorGroupIdGapRange[];
  /**
   * 通知済み Prior Object ID Gap の範囲
   *
   * §10.9 の「過去に通知された gap 内の Object ID」の判定に使う。
   */
  readonly priorObjectIdGapRanges: PriorObjectIdGapRange[];
  /**
   * Group ID ごとに最初に観測した Prior Group ID Gap の値
   *
   * §10.8 の「同一 Group 内で異なる値の Prior Group ID Gap」の判定に使う。
   * 記録するのは 5 条件すべての検証を通った Object の値だけである。malformed と
   * 判定した Object の値まで記録すると、以降の正当な Object を同じ条件で
   * 誤検出する。
   */
  readonly firstPriorGroupIdGapByGroup: Map<bigint, bigint>;
}

/**
 * 追跡対象の Track を指す参照
 *
 * 受信経路は Track Alias (subgroup / datagram) か Fetcher (FETCH) しか持たない
 * ため、経路ごとに比較キーへ解決した結果をこの形で引き渡す。
 */
export interface PriorGapTrackingTarget {
  readonly trackingByTrack: Map<FullTrackNameKey, PriorGapTracking>;
  readonly trackKey: FullTrackNameKey;
}

/** 空の追跡状態を作る */
function createPriorGapTracking(): PriorGapTracking {
  return {
    receivedGroupIds: new Set<bigint>(),
    receivedObjectIdsByGroup: new Map<bigint, Set<bigint>>(),
    priorGroupIdGapRanges: [],
    priorObjectIdGapRanges: [],
    firstPriorGroupIdGapByGroup: new Map<bigint, bigint>(),
  };
}

/**
 * Track の追跡状態を取り出す (未登録なら作る)
 *
 * 上限を超えた場合は最も古い Track エントリから破棄する。破棄された Track では
 * それまでの受信履歴を失うため、以降の覆い判定 (§10.8 / §10.9 の条件 2) と
 * 同一 Group 内の gap 値の比較 (§10.8 の条件 1) ができなくなる。
 */
export function getOrCreatePriorGapTracking(
  trackingByTrack: Map<FullTrackNameKey, PriorGapTracking>,
  trackKey: FullTrackNameKey,
): PriorGapTracking {
  const existing = trackingByTrack.get(trackKey);
  if (existing !== undefined) {
    return existing;
  }
  // Map の反復順は挿入順であり、先頭が最も古い Track エントリである
  while (trackingByTrack.size >= MAX_TRACKED_TRACKS) {
    const oldest = trackingByTrack.keys().next();
    if (oldest.done === true) {
      break;
    }
    trackingByTrack.delete(oldest.value);
  }
  const created = createPriorGapTracking();
  trackingByTrack.set(trackKey, created);
  return created;
}

/**
 * Track の追跡状態を破棄する
 *
 * 破棄してよいのは、その Track の購読と FETCH が 1 つも残っていない時点だけ
 * である。判定は呼び出し側 (bidi 層) が購読 / FETCH の残存を確認して行う。
 */
export function clearPriorGapTracking(
  trackingByTrack: Map<FullTrackNameKey, PriorGapTracking>,
  trackKey: FullTrackNameKey,
): void {
  trackingByTrack.delete(trackKey);
}

/**
 * 受信した Object が Track 横断の Prior ID Gap 条件に違反しないか検証し、
 * 違反しなければ受信状態として記録する
 *
 * 判定する 5 条件と順序は次のとおりである。いずれも bigint の比較だけで判定し、
 * スキップされた ID を配列として実体化しない。gap は varint で最大 2^64-1 で
 * あり、配列にすると受信経路が停止する。
 *
 * 1. §10.8: 同一 Group 内で異なる値の Prior Group ID Gap
 * 2. §10.8: 過去に受信した Group ID を覆う Prior Group ID Gap
 * 3. §10.9: 同一 Group で過去に受信した Object ID を覆う Prior Object ID Gap
 * 4. §10.8: 過去に通知された gap 内の Group ID
 * 5. §10.9: 過去に通知された gap 内の Object ID
 *
 * 単一 Object の検証 (同一 Object 内の複数出現、gap > Group ID / gap > Object ID)
 * は呼び出し側が assertPriorIdGapInObjectProperties で先に済ませている前提である。
 * gap > Group ID の Object では範囲の下限が負になり、追跡判定が成立しない。
 *
 * malformed と判定した Object は受信済みとして登録しない。5 条件すべてを
 * 通った Object だけが、以降の判定に使う受信状態と通知済み gap を残す。
 *
 * @throws MalformedTrackError 5 条件のいずれかに違反した場合
 */
export function assertNoPriorIdGapTrackViolation(
  target: PriorGapTrackingTarget,
  groupId: bigint,
  objectId: bigint,
  properties: Uint8Array | undefined,
): void {
  const tracking = getOrCreatePriorGapTracking(target.trackingByTrack, target.trackKey);
  const gaps = readPriorIdGaps(properties);

  // 条件 1: 同一 Group 内で異なる Prior Group ID Gap 値
  // draft-ietf-moq-transport-21 §10.8:
  // "A Group contains more than one Object with different values for
  //  Prior Group ID Gap."
  if (gaps.priorGroupIdGap !== undefined) {
    const observed = tracking.firstPriorGroupIdGapByGroup.get(groupId);
    if (observed !== undefined && observed !== gaps.priorGroupIdGap) {
      throw new MalformedTrackError(
        `prior group id gap differs within group: group=${groupId}, observed=${observed}, received=${gaps.priorGroupIdGap}`,
      );
    }
  }

  // 条件 2: 過去に受信した Object を覆う Prior Group ID Gap
  // draft-ietf-moq-transport-21 §10.8:
  // "An endpoint receives an Object with a Prior Group ID Gap covering
  //  an Object it previously received."
  // gap が覆う範囲は [現在の Group ID - gap, 現在の Group ID - 1] である。
  if (gaps.priorGroupIdGap !== undefined && gaps.priorGroupIdGap > 0n) {
    const start = groupId - gaps.priorGroupIdGap;
    const end = groupId - 1n;
    for (const receivedGroupId of tracking.receivedGroupIds) {
      if (receivedGroupId >= start && receivedGroupId <= end) {
        throw new MalformedTrackError(
          `prior group id gap covers received group: gap=${gaps.priorGroupIdGap}, group=${groupId}, received=${receivedGroupId}`,
        );
      }
    }
  }

  // 条件 3: 同じ Group で過去に受信した Object を覆う Prior Object ID Gap
  // draft-ietf-moq-transport-21 §10.9:
  // "An endpoint receives an Object with a Prior Object ID Gap covering
  //  an Object it previously received."
  // gap が覆う範囲は [現在の Object ID - gap, 現在の Object ID - 1] であり、
  // 同じ Group の受信済み Object ID とだけ比較する (Group をまたいで比較すると
  // 同じ Object ID を持つ別 Group の Object を誤検出する)。
  if (gaps.priorObjectIdGap !== undefined && gaps.priorObjectIdGap > 0n) {
    const start = objectId - gaps.priorObjectIdGap;
    const end = objectId - 1n;
    const receivedObjectIds = tracking.receivedObjectIdsByGroup.get(groupId);
    if (receivedObjectIds !== undefined) {
      for (const receivedObjectId of receivedObjectIds) {
        if (receivedObjectId >= start && receivedObjectId <= end) {
          throw new MalformedTrackError(
            `prior object id gap covers received object: gap=${gaps.priorObjectIdGap}, group=${groupId}, object=${objectId}, received=${receivedObjectId}`,
          );
        }
      }
    }
  }

  // 条件 4: 過去に通知された gap 内の Group ID
  // draft-ietf-moq-transport-21 §10.8:
  // "An endpoint receives an Object with a Group ID within a previously
  //  communicated gap."
  for (const range of tracking.priorGroupIdGapRanges) {
    if (groupId >= range.start && groupId <= range.end) {
      throw new MalformedTrackError(
        `group id within previously communicated prior group id gap: group=${groupId}, gap=${range.start}-${range.end}`,
      );
    }
  }

  // 条件 5: 過去に通知された gap 内の Object ID
  // draft-ietf-moq-transport-21 §10.9:
  // "An endpoint receives an Object with an Object ID within a
  //  previously communicated gap."
  // 通知元の Group と一致する場合だけ比較する。
  for (const range of tracking.priorObjectIdGapRanges) {
    if (range.group === groupId && objectId >= range.start && objectId <= range.end) {
      throw new MalformedTrackError(
        `object id within previously communicated prior object id gap: group=${groupId}, object=${objectId}, gap=${range.start}-${range.end}`,
      );
    }
  }

  // ここまでで 5 条件すべてを通った。この Object だけを受信済みとして登録し、
  // この Object が通知した gap を記録する。
  registerReceivedLocation(tracking, groupId, objectId);
  if (gaps.priorGroupIdGap !== undefined) {
    // 最初に観測した値だけを保持する (条件 1 の比較対象)
    if (!tracking.firstPriorGroupIdGapByGroup.has(groupId)) {
      tracking.firstPriorGroupIdGapByGroup.set(groupId, gaps.priorGroupIdGap);
    }
    registerPriorGroupIdGapRange(tracking, groupId, gaps.priorGroupIdGap);
  }
  if (gaps.priorObjectIdGap !== undefined) {
    registerPriorObjectIdGapRange(tracking, groupId, objectId, gaps.priorObjectIdGap);
  }
}

/**
 * Object Property 列から Prior Group ID Gap / Prior Object ID Gap を取り出す
 *
 * draft-ietf-moq-transport-21 §10.7 (Immutable Properties):
 * "When looking for the value of a property, processors MUST search both the
 *  mutable properties and the contents of Immutable Properties."
 * mutable list と IMMUTABLE_PROPERTIES 配下の双方を探索する。同一 Object 内の
 * 複数出現は assertPriorIdGapInObjectProperties の経路が先に malformed とする
 * ため、ここでは最初に見つけた値を保持する。
 *
 * 不完全・不正な KVP は decodeObjectPropertiesTolerant の契約どおり読み飛ばす。
 */
function readPriorIdGaps(properties: Uint8Array | undefined): {
  priorGroupIdGap?: bigint;
  priorObjectIdGap?: bigint;
} {
  const collected: { priorGroupIdGap?: bigint; priorObjectIdGap?: bigint } = {};
  if (properties === undefined || properties.length === 0) {
    return collected;
  }
  collectPriorIdGaps(decodeObjectPropertiesTolerant(properties).properties, collected);
  return collected;
}

/** Property 列を再帰的に走査して Prior ID Gap を集める */
function collectPriorIdGaps(
  properties: ReadonlyArray<Property>,
  collected: { priorGroupIdGap?: bigint; priorObjectIdGap?: bigint },
): void {
  for (const property of properties) {
    if (property.id === MOQTPropertyId.PRIOR_GROUP_ID_GAP && property.value !== undefined) {
      collected.priorGroupIdGap ??= property.value;
    } else if (property.id === MOQTPropertyId.PRIOR_OBJECT_ID_GAP && property.value !== undefined) {
      collected.priorObjectIdGap ??= property.value;
    } else if (property.id === MOQTPropertyId.IMMUTABLE_PROPERTIES && property.data !== undefined) {
      // draft-ietf-moq-transport-21 §10.7 の「双方を検索する」に従い、
      // IMMUTABLE_PROPERTIES (0x0B) の内側も探索する。内側の 0x0B は
      // 再帰ネストとして先に malformed になるため、深さは 1 段で足りる。
      collectPriorIdGaps(decodeObjectPropertiesTolerant(property.data).properties, collected);
    }
  }
}

/**
 * 検証を通った Object の位置を受信済みとして登録する
 *
 * Group を先に登録し、Group 単位の状態 (Object ID 集合・最初の観測 gap) を
 * まとめて破棄できるようにする。
 */
function registerReceivedLocation(
  tracking: PriorGapTracking,
  groupId: bigint,
  objectId: bigint,
): void {
  if (!tracking.receivedGroupIds.has(groupId)) {
    // 上限を超えた場合は最も古い Group から破棄する。破棄した Group では
    // 以降の覆い判定 (条件 2) と条件 1 の比較ができない。
    while (tracking.receivedGroupIds.size >= MAX_TRACKED_GROUP_IDS) {
      const oldest = tracking.receivedGroupIds.values().next();
      if (oldest.done === true) {
        break;
      }
      tracking.receivedGroupIds.delete(oldest.value);
      tracking.receivedObjectIdsByGroup.delete(oldest.value);
      tracking.firstPriorGroupIdGapByGroup.delete(oldest.value);
    }
    tracking.receivedGroupIds.add(groupId);
  }

  let receivedObjectIds = tracking.receivedObjectIdsByGroup.get(groupId);
  if (receivedObjectIds === undefined) {
    receivedObjectIds = new Set<bigint>();
    tracking.receivedObjectIdsByGroup.set(groupId, receivedObjectIds);
  }
  if (receivedObjectIds.has(objectId)) {
    return;
  }
  // 上限を超えた場合は最も古い Object ID から破棄する。破棄した Object は
  // 以降の覆い判定 (条件 3) で検出できない。
  while (receivedObjectIds.size >= MAX_TRACKED_OBJECT_IDS_PER_GROUP) {
    const oldest = receivedObjectIds.values().next();
    if (oldest.done === true) {
      break;
    }
    receivedObjectIds.delete(oldest.value);
  }
  receivedObjectIds.add(objectId);
}

/**
 * 通知済み Prior Group ID Gap の範囲を記録する
 *
 * 空の範囲 (gap = 0) は保持しない。同じ範囲の再通知は集合として 1 件にまとめ、
 * 同じ gap の反復で上限を消費しないようにする。上限を超えた場合は最も古い
 * 範囲から破棄し、破棄した範囲では「過去に通知された gap 内の ID」の判定
 * (条件 4) ができない。
 */
function registerPriorGroupIdGapRange(
  tracking: PriorGapTracking,
  groupId: bigint,
  gap: bigint,
): void {
  if (gap <= 0n) {
    return;
  }
  const start = groupId - gap;
  const end = groupId - 1n;
  if (tracking.priorGroupIdGapRanges.some((range) => range.start === start && range.end === end)) {
    return;
  }
  while (tracking.priorGroupIdGapRanges.length >= MAX_TRACKED_GAP_RANGES) {
    tracking.priorGroupIdGapRanges.shift();
  }
  tracking.priorGroupIdGapRanges.push({ start, end });
}

/**
 * 通知済み Prior Object ID Gap の範囲を記録する
 *
 * 空の範囲 (gap = 0) は保持しない。同じ Group の同じ範囲の再通知は集合として
 * 1 件にまとめる。上限を超えた場合は最も古い範囲から破棄し、破棄した範囲では
 * 「過去に通知された gap 内の ID」の判定 (条件 5) ができない。
 */
function registerPriorObjectIdGapRange(
  tracking: PriorGapTracking,
  groupId: bigint,
  objectId: bigint,
  gap: bigint,
): void {
  if (gap <= 0n) {
    return;
  }
  const start = objectId - gap;
  const end = objectId - 1n;
  if (
    tracking.priorObjectIdGapRanges.some(
      (range) => range.group === groupId && range.start === start && range.end === end,
    )
  ) {
    return;
  }
  while (tracking.priorObjectIdGapRanges.length >= MAX_TRACKED_GAP_RANGES) {
    tracking.priorObjectIdGapRanges.shift();
  }
  tracking.priorObjectIdGapRanges.push({ group: groupId, start, end });
}
