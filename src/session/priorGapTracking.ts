/**
 * Track 単位の Prior Group ID Gap / Prior Object ID Gap と Object 状態の追跡
 *
 * draft-ietf-moq-transport-22 §10.8 (Prior Group ID Gap) / §10.9 (Prior Object
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
 * draft-ietf-moq-transport-23 §12.1 (Malformed Tracks) 条件 4 / 5:
 * FETCH の End of Group / End of Track indicator が確定した Group / Track の
 * 最終 Object も、同じ Track 単位の状態として保持する。indicator は追加
 * フィールドを持たず直前の実 Object を終端として参照するため、記録するのは
 * decode 側が保持した最後の実 Object の位置であり、End of Range の範囲端や
 * 算術用の prior Object ID (2^64-1) ではない。
 *
 * draft-ietf-moq-transport-23 §2.1.2 (Object States) / §12.1 条件 10:
 * 実 Object と非存在通知の両方向の矛盾を Track 全体で検出するため、受信済み
 * 位置と確定した非存在範囲を objectState に区間で保持する。対象となる非存在の
 * 通知は次のとおりであり、Gone / Unknown / Timed-Out は非存在の断定ではないため
 * 含めない (§2.1.2)。
 * - Object Status の END_OF_GROUP / END_OF_TRACK (通常購読 / Datagram)
 * - FETCH の End of Group / End of Track indicator が確定した終端
 * - FETCH の End of Non-Existent Range が復号した範囲と、Range Filter が無い
 *   FETCH 応答の暗黙 gap (§3.2.2)
 *
 * 節番号・語彙は将来のドラフト改訂で変わり得るため、改訂時は引用を更新する。
 *
 * 追跡は Full Track Name 単位で行う。同一 Track の複数購読 / FETCH をまたいで
 * 判定する必要があるため、購読単位ではなく Track 単位で状態を保持する。
 * 状態のキーは fullTrackNameKey が生成する比較キーである。
 *
 * 対象範囲:
 * - 判定は発生した Object の受信経路に依存しない。subgroup / datagram / FETCH の
 *   どこから届いても同じ状態を更新し、同じ条件で判定する。
 * - ただし FETCH の終端 (fetchGroupFinalObjectIds / fetchTrackEnd) を記録するのは
 *   FETCH の End of Group / End of Track indicator だけであり、subgroup / datagram は
 *   記録済みの終端に対する検証だけを行う。
 * - datagram 経路は Track Alias と購読が特定できた場合だけ検証する。alias が
 *   不明な datagram、購読が 1 つも無い alias の datagram は対象外である。
 * - FETCH の暗黙 gap は要求範囲 (Start / End Location) と Range Filter の有無が
 *   分かる通常の FETCH だけを対象とする。fill fetch は fill 範囲を保持していない
 *   ため暗黙 gap を推論しない (検出漏れのみで誤検出は生まない)。
 * - Subgroup Header の END_OF_GROUP ビットと FIN による Group 最終 Object の確定は
 *   Object Status END_OF_GROUP と同じ意味を持つが、FIN を観測するデータストリーム
 *   側の状態であり、この追跡の非存在通知には含めない。含めない場合も検出漏れのみで
 *   誤検出は生まない。
 */

import type { FetchStreamEnd } from "../dataStream";
import { MalformedTrackError } from "../error";
import type { FullTrackNameKey } from "../fullTrackName";
import { ObjectStatus } from "../message";
import type { GroupOrder, Location } from "../message/types";
import { MOQTPropertyId, decodeObjectPropertiesTolerant, type Property } from "../properties";
import {
  assertAndRegisterNonExistentRange,
  assertNoReceivedObjectInRange,
  assertObjectNotInNonExistentRange,
  buildFetchTrailingGapRanges,
  createObjectStateTracking,
  registerNonExistentRange,
  registerReceivedObjectLocation,
  trackLocationRangeAfterFinalObject,
  type ObjectStateTracking,
  type TrackLocationRange,
} from "./objectStateTracking";

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
 * Track ごとに保持する FETCH の Group 終端の上限
 *
 * 超過時は最も古い Group の記録から破棄する。破棄した Group では既知の最終
 * Object が無いため §12.1 条件 4 の判定を行わない (検出漏れのみで誤検出は生まない)。
 */
const MAX_TRACKED_FETCH_GROUP_ENDS = 1024;

/**
 * FETCH の End of Group / End of Track indicator が確定した終端
 *
 * End of Track は Group の終端も意味する (§11.4.2.2) ため、Group の終端としても
 * 記録する。Track の終端は Track ごとに 1 件だけ保持する。
 */
interface FetchTrackEnd {
  /** Track の最終 Object の Group ID */
  groupId: bigint;
  /** Track の最終 Object の Object ID */
  objectId: bigint;
}

/**
 * 通知済み Prior Group ID Gap の範囲
 *
 * draft-ietf-moq-transport-22 §10.8:
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
 * draft-ietf-moq-transport-22 §10.9:
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
 * draft-ietf-moq-transport-22 §10.8 / §10.9 の Prior ID Gap 条件を判定する
 * 受信済み Group / Object と通知済み gap に加え、次の状態も同じ Track 単位で
 * 保持する。すべての判定が同じ Track の履歴を共有することで、購読 / Subgroup /
 * Datagram / FETCH の受信経路をまたいだ矛盾を検出できる。
 *
 * - draft-ietf-moq-transport-23 §12.1 条件 4 / 5: FETCH の End of Group /
 *   End of Track indicator が確定した Group / Track の最終 Object
 *   (fetchGroupFinalObjectIds / fetchTrackEnd)
 * - draft-ietf-moq-transport-23 §2.1.2 / §12.1 条件 10: 受信済み位置と確定した
 *   非存在範囲の区間 (objectState)。実 Object の受信時と非存在通知の受理時に
 *   両方向の矛盾を判定する
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
  /**
   * FETCH の End of Group / End of Track indicator が確定した Group の最終 Object ID
   *
   * draft-ietf-moq-transport-23 §12.1 条件 4:
   * "An Object is received in a Group whose Object ID is larger than the final
   *  Object in the Group."
   * キーは Group ID、値は最後の実 Object の Object ID である。indicator は
   * 追加フィールドを持たず直前の実 Object を終端として参照するため、End of Range
   * の範囲端ではなく decode 側が保持した実 Object の位置を記録する。
   */
  readonly fetchGroupFinalObjectIds: Map<bigint, bigint>;
  /**
   * FETCH の End of Track indicator が確定した Track の最終 Object
   *
   * draft-ietf-moq-transport-23 §12.1 条件 5:
   * "An Object is received whose Group and Object ID are larger than the final
   *  Object in the Track."
   * Track の終端は 1 件だけ保持する。End of Track をまだ受理していない場合は
   * undefined である。End of Range の範囲端や算術用の 2^64-1 を実 Object の
   * 終端として登録しない。
   */
  fetchTrackEnd: FetchTrackEnd | undefined;
  /**
   * 受信済み位置と確定した非存在範囲 (区間)
   *
   * draft-ietf-moq-transport-23 §2.1.2 / §12.1 条件 10 の両方向の矛盾検出に使う。
   * 区間ごとの上限と破棄の制限は objectStateTracking.ts の JSDoc を参照する。
   */
  readonly objectState: ObjectStateTracking;
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
    fetchGroupFinalObjectIds: new Map<bigint, bigint>(),
    fetchTrackEnd: undefined,
    objectState: createObjectStateTracking(),
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
 * 受信した Object が Track 横断の malformed 条件に違反しないか検証し、
 * 違反しなければ受信状態として記録する
 *
 * 判定する Prior ID Gap の 5 条件と順序は次のとおりである。いずれも bigint の
 * 比較だけで判定し、スキップされた ID を配列として実体化しない。gap は varint で
 * 最大 2^64-1 であり、配列にすると受信経路が停止する。
 *
 * 1. §10.8: 同一 Group 内で異なる値の Prior Group ID Gap
 * 2. §10.8: 過去に受信した Group ID を覆う Prior Group ID Gap
 * 3. §10.9: 同一 Group で過去に受信した Object ID を覆う Prior Object ID Gap
 * 4. §10.8: 過去に通知された gap 内の Group ID
 * 5. §10.9: 過去に通知された gap 内の Object ID
 *
 * draft-ietf-moq-transport-23 §2.1.2 (Object States) / §12.1 条件 10:
 * Prior ID Gap に加えて、Track 全体で確定した非存在範囲との矛盾も判定する。
 * - 受信した Object が保存済みの非存在区間内にある
 *   ("An Object is received after it has been recorded as not existing")
 * - status が END_OF_GROUP / END_OF_TRACK の場合、その位置より後が存在しない
 *   という通知が、他の経路で受信済みの Object を覆う
 *   ("... or is signalled as not existing after it was received")
 * Gone / Unknown / Timed-Out は非存在の断定ではないため (§2.1.2)、この判定の
 * 対象に含めない。
 *
 * FETCH の End of Group / End of Track indicator が確定した終端の記録と検証は
 * recordFetchObjectEnd / assertNoObjectAfterFetchEnd が同じ Track 単位の追跡
 * 状態を使って行う (この関数は受信する Object 側の検証を担当する)。
 *
 * 単一 Object の検証 (同一 Object 内の複数出現、gap > Group ID / gap > Object ID)
 * は呼び出し側が assertPriorIdGapInObjectProperties で先に済ませている前提である。
 * gap > Group ID の Object では範囲の下限が負になり、追跡判定が成立しない。
 *
 * malformed と判定した Object は受信済みとして登録しない。すべての条件を
 * 通った Object だけが、以降の判定に使う受信状態と通知済み gap、非存在範囲を残す。
 *
 * @param status - Object Status。省略時は Normal (FETCH の実 Object は Status を
 *   持たないため Normal として扱う)。
 * @throws MalformedTrackError いずれかの条件に違反した場合
 */
export function assertNoPriorIdGapTrackViolation(
  target: PriorGapTrackingTarget,
  groupId: bigint,
  objectId: bigint,
  properties: Uint8Array | undefined,
  status: ObjectStatus = ObjectStatus.NORMAL,
): void {
  const tracking = getOrCreatePriorGapTracking(target.trackingByTrack, target.trackKey);
  const gaps = readPriorIdGaps(properties);
  // draft-ietf-moq-transport-23 §11.1.1 / §11.4.2.2:
  // END_OF_GROUP / END_OF_TRACK は「通知位置より後が存在しない」ことを示す。
  // 受信済み Object を覆う場合は Track の矛盾なので、登録より前に検証する。
  const nonExistentRange = nonExistentRangeOfStatus(status, groupId, objectId);

  // 条件 1: 同一 Group 内で異なる Prior Group ID Gap 値
  // draft-ietf-moq-transport-22 §10.8:
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
  // draft-ietf-moq-transport-22 §10.8:
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
  // draft-ietf-moq-transport-22 §10.9:
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
  // draft-ietf-moq-transport-22 §10.8:
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
  // draft-ietf-moq-transport-22 §10.9:
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

  // draft-ietf-moq-transport-23 §12.1 条件 10:
  // 受信した Object が、確定済みの非存在区間 (End of Non-Existent Range /
  // 暗黙 gap / Object Status / End of Group / End of Track) に含まれないことを
  // 検証する。Gone / Unknown / Timed-Out は非存在区間として記録しないため、
  // それらの後の実 Object はここで拒否されない (§2.1.2)。
  assertObjectNotInNonExistentRange(tracking.objectState, groupId, objectId);

  // draft-ietf-moq-transport-23 §12.1 条件 10 の逆方向:
  // この Object が終端 (END_OF_GROUP / END_OF_TRACK) を通知する場合、通知する
  // 範囲が受信済み Object を覆わないことを登録より前に検証する。
  if (nonExistentRange !== undefined) {
    assertNoReceivedObjectInRange(tracking.objectState, nonExistentRange);
  }

  // ここまでで全条件を通った。この Object だけを受信済みとして登録し、
  // この Object が通知した gap と非存在範囲を記録する。
  registerReceivedLocation(tracking, groupId, objectId);
  registerReceivedObjectLocation(tracking.objectState, groupId, objectId);
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
  if (nonExistentRange !== undefined) {
    registerNonExistentRange(tracking.objectState, nonExistentRange);
  }
}

/**
 * Object Status が通知する非存在範囲を求める
 *
 * draft-ietf-moq-transport-23 §11.1.1 (Object Status): END_OF_GROUP は同じ Group
 * の指定 Object ID より後、END_OF_TRACK は指定 Location より後が存在しないことを
 * 示す。Normal は非存在を通知しないため undefined を返す。
 */
function nonExistentRangeOfStatus(
  status: ObjectStatus,
  groupId: bigint,
  objectId: bigint,
): TrackLocationRange | undefined {
  if (status === ObjectStatus.END_OF_GROUP) {
    return trackLocationRangeAfterFinalObject("end_of_group", groupId, objectId);
  }
  if (status === ObjectStatus.END_OF_TRACK) {
    return trackLocationRangeAfterFinalObject("end_of_track", groupId, objectId);
  }
  return undefined;
}

/**
 * FETCH の End of Group / End of Track indicator が確定した終端を記録する
 *
 * draft-ietf-moq-transport-23 §11.4.2.2 (Prior Object Fields) / §12.1 条件 4 / 5:
 * indicator は追加フィールドを持たず、直前の実 Object を Group / Track の最終
 * Object として参照する。渡す groupId / objectId は decode 側が保持した最後の
 * 実 Object の位置であり、End of Range の範囲端や算術用の prior Object ID
 * (2^64-1) ではない。End of Track は Group の終端も意味するため、Group と Track の
 * 両方の終端として記録する。
 *
 * draft-ietf-moq-transport-23 §2.1.2 (Object States) / §12.1 条件 10:
 * 終端宣言は「その位置より後が存在しない」という非存在の通知でもあるため、
 * 宣言する範囲を受信済み位置と突き合わせる。同じ Track の別購読 / FETCH で
 * 宣言より後の Object を先に受信していれば malformed Track である。
 * 逆方向 (宣言より後の Object の受信) は assertNoObjectAfterFetchEnd が判定する。
 */
export function recordFetchObjectEnd(target: PriorGapTrackingTarget, end: FetchStreamEnd): void {
  const tracking = getOrCreatePriorGapTracking(target.trackingByTrack, target.trackKey);

  // draft-ietf-moq-transport-23 §11.4.2.2:
  // End of Group は Group の残り、End of Track は Track の残りが存在しないことを
  // 意味する。End of Track の範囲は Group の残りも含むため、Group 終端の範囲を
  // 別に記録しない (fetchGroupFinalObjectIds は条件 4 の判定用に記録する)。
  const nonExistentRange = trackLocationRangeAfterFinalObject(end.kind, end.groupId, end.objectId);
  if (nonExistentRange !== undefined) {
    // 受信済み Object を覆う宣言は malformed であり、その場合は終端の記録も
    // 行わない (malformed と判定した宣言を受信状態の根拠にしない)。
    assertAndRegisterNonExistentRange(tracking.objectState, nonExistentRange);
  }

  // 同じ Group の記録の上書きは Map の挿入順を変えないため、上限で破棄するのは
  // 新しい Group を追加するときだけ回す。
  if (!tracking.fetchGroupFinalObjectIds.has(end.groupId)) {
    while (tracking.fetchGroupFinalObjectIds.size >= MAX_TRACKED_FETCH_GROUP_ENDS) {
      const oldest = tracking.fetchGroupFinalObjectIds.keys().next();
      if (oldest.done === true) {
        break;
      }
      tracking.fetchGroupFinalObjectIds.delete(oldest.value);
    }
  }
  tracking.fetchGroupFinalObjectIds.set(end.groupId, end.objectId);

  if (end.kind === "end_of_track") {
    tracking.fetchTrackEnd = { groupId: end.groupId, objectId: end.objectId };
  }
}

/**
 * FETCH 応答で確定した非存在範囲を検証して記録する
 *
 * draft-ietf-moq-transport-23 §3.2.2 (Gaps in a Fetch Stream) /
 * §11.4.2 (End of Range):
 * End of Non-Existent Range が明示した範囲と、Range Filter が無い FETCH 応答の
 * 暗黙 gap を非存在として記録する。Gone / Unknown / Timed-Out の End of Range は
 * 非存在の断定ではないため (§2.1.2)、この関数に渡さない。空の範囲
 * (start > end) は assertAndRegisterNonExistentRange が無視する。
 *
 * @throws MalformedTrackError 範囲が受信済み Object を覆った場合
 */
export function assertAndRecordFetchNonExistentRange(
  target: PriorGapTrackingTarget,
  range: TrackLocationRange,
): void {
  const tracking = getOrCreatePriorGapTracking(target.trackingByTrack, target.trackKey);
  assertAndRegisterNonExistentRange(tracking.objectState, range);
}

/**
 * FETCH 応答の末尾 gap を検証して記録する
 *
 * draft-ietf-moq-transport-23 §3.2.2 (Gaps in a Fetch Stream):
 * "Gaps at the end of a stream are only detectable when the stream is terminated
 *  by a FIN." 応答の FIN 時点で、最後にシリアライズされた位置から End Location
 * までの無印の範囲を非存在として扱う。Range Filter がある要求では無印の gap は
 * Unknown であるため記録しない。
 *
 * 対象は要求範囲 (Start / End Location) が確定している通常の FETCH だけである。
 * fill fetch は fill 範囲を保持していないため、呼び出し側がこの関数を呼ばない。
 *
 * @throws MalformedTrackError 末尾 gap が受信済み Object を覆った場合
 */
export function assertAndRecordFetchTrailingGap(
  target: PriorGapTrackingTarget,
  options: {
    readonly groupOrder: GroupOrder;
    readonly startLocation: Location;
    readonly endLocation: Location;
    readonly lastSerializedLocation?: Location;
    readonly rangeFiltersPresent: boolean;
  },
): void {
  // draft-ietf-moq-transport-23 §3.2.2:
  // Range Filter を含む要求では、マークされていない gap は Unknown 状態の
  // Object を示す。非存在とみなさない。
  if (options.rangeFiltersPresent) {
    return;
  }
  const ranges = buildFetchTrailingGapRanges({
    groupOrder: options.groupOrder,
    startLocation: options.startLocation,
    endLocation: options.endLocation,
    ...(options.lastSerializedLocation !== undefined
      ? { lastSerializedLocation: options.lastSerializedLocation }
      : {}),
  });
  if (ranges.length === 0) {
    return;
  }
  const tracking = getOrCreatePriorGapTracking(target.trackingByTrack, target.trackKey);
  for (const range of ranges) {
    assertAndRegisterNonExistentRange(tracking.objectState, range);
  }
}

/**
 * 実 Object が FETCH で確定した Group / Track の終端を超えていないか検証する
 *
 * draft-ietf-moq-transport-23 §12.1 (Malformed Tracks):
 * 条件 4 "An Object is received in a Group whose Object ID is larger than the
 *  final Object in the Group."
 * 条件 5 "An Object is received whose Group and Object ID are larger than the
 *  final Object in the Track."
 * Location の大小は Group ID、同じ Group では Object ID で比較する。Track の最終
 * Object より後の位置の Object は、配信順 (Group Order) に関わらず Track に
 * 存在しない。
 * §12.1 が列挙する final Object の定義は Object Status の END_OF_GROUP /
 * END_OF_TRACK と Subgroup の FIN であり、FETCH の End of Group / End of Track
 * indicator は列挙されていない。§11.4.2.2 が prior Object を Group / Track の
 * 最後の Object と定めるため、同じ最終 Object として適用する (§12.1 も条件の
 * 列挙は網羅的でないとしている)。
 *
 * 対象は FETCH の End of Group / End of Track indicator が確定した終端だけである。
 * End of Range indicator の範囲端は、Object が存在しない / Unknown / Gone /
 * timed out である範囲を示す通知であり、実 Object の終端ではないため登録しない。
 *
 * @throws MalformedTrackError 条件 4 または条件 5 に違反した場合
 */
export function assertNoObjectAfterFetchEnd(
  target: PriorGapTrackingTarget,
  groupId: bigint,
  objectId: bigint,
): void {
  const tracking = getOrCreatePriorGapTracking(target.trackingByTrack, target.trackKey);

  const groupFinalObjectId = tracking.fetchGroupFinalObjectIds.get(groupId);
  if (groupFinalObjectId !== undefined && objectId > groupFinalObjectId) {
    throw new MalformedTrackError(
      `malformed track: object id ${objectId} exceeds final object ${groupFinalObjectId} in group ${groupId}`,
    );
  }

  const trackEnd = tracking.fetchTrackEnd;
  if (
    trackEnd !== undefined &&
    (groupId > trackEnd.groupId || (groupId === trackEnd.groupId && objectId > trackEnd.objectId))
  ) {
    throw new MalformedTrackError(
      `malformed track: object ${groupId}:${objectId} is after final object ${trackEnd.groupId}:${trackEnd.objectId} in track`,
    );
  }
}

/**
 * Object Property 列から Prior Group ID Gap / Prior Object ID Gap を取り出す
 *
 * draft-ietf-moq-transport-22 §10.7 (Immutable Properties):
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
      // draft-ietf-moq-transport-22 §10.7 の「双方を検索する」に従い、
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
