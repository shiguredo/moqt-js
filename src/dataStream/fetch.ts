/**
 * MOQT Fetch Stream
 * draft-ietf-moq-transport-21 Section 11.4 (Fetch Streams)
 *
 * Fetch Header (Section 11.4.1) と Fetch Object fields (Figure 28) の
 * エンコードとデコードを扱う。Fetch Object は Subgroup / Datagram と異なり
 * 前オブジェクトからの delta でフィールドを省略する (§11.4.1.1 Table 8 / 9)
 * ため、直前の値を持つ FetchObjectContext を引き回す。
 */

import { decodeVarint, encodeVarint, MAX_VARINT } from "../varint";
import { GroupOrder } from "../message/types";
import { IncompleteDataError, MalformedTrackError, ProtocolViolationError } from "../error";
import {
  assertKnownPropertyValueInObjectProperties,
  assertNoMandatoryTrackPropertyInObjectProperties,
  assertPriorIdGapInObjectProperties,
} from "../properties";
import { concatUint8Arrays } from "../bytes";
import { validatePublisherPriority } from "./common";

/**
 * Fetch Header (Section 11.4.1)
 *
 * FETCH_HEADER {
 *   Type (i) = 0x05,
 *   Request ID (i),
 * }
 */
export const FetchHeaderType = 0x05;

export interface FetchHeader {
  type: typeof FetchHeaderType;
  requestId: bigint;
}

/**
 * Encode a Fetch Header
 *
 * リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
export function encodeFetchHeader(header: FetchHeader): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeVarint(header.type));
  parts.push(encodeVarint(header.requestId));

  return concatUint8Arrays(parts);
}

/**
 * Decode a Fetch Header
 */
export function decodeFetchHeader(data: Uint8Array, offset = 0): [FetchHeader, number] {
  let totalConsumed = 0;

  const [type, typeConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += typeConsumed;

  if (Number(type) !== FetchHeaderType) {
    throw new ProtocolViolationError(
      `invalid fetch header type: ${type}, expected ${FetchHeaderType}`,
    );
  }

  const [requestId, requestIdConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += requestIdConsumed;

  return [
    {
      type: FetchHeaderType,
      requestId,
    },
    totalConsumed,
  ];
}

/**
 * Serialization Flags for Fetch Object (Section 11.4.1)
 *
 * Section 11.4.1.1 Table 8: Subgroup ID encoding (bits 0-1)
 * | Bitmask (flags & 0x03) | Meaning |
 * | 0x00 | Subgroup ID is zero |
 * | 0x01 | Subgroup ID is prior Object's Subgroup ID |
 * | 0x02 | Subgroup ID is prior Object's Subgroup ID + 1 |
 * | 0x03 | Subgroup ID field is present |
 *
 * Section 11.4.1.1 Table 9: Additional flags
 * | Bitmask | Condition if set |
 * | 0x04 | Object ID Delta is present (else prior + 1) |
 * | 0x08 | Group ID Delta is present (else prior Group ID) |
 * | 0x10 | Priority field is present (else prior Priority) |
 * | 0x20 | Properties field is present |
 * | 0x40 | Datagram: Subgroup ID の 2 ビットを無視 |
 *
 * End of Range (Section 11.4.1.2):
 * | 0x8C  | End of Non-Existent Range |
 * | 0x10C | End of Unknown Range      |
 * | 0x20C | End of Timed-Out Range    |
 */
export const FetchSerializationFlags = {
  // Subgroup ID encoding
  SUBGROUP_ZERO: 0x00,
  SUBGROUP_SAME: 0x01,
  SUBGROUP_PLUS_ONE: 0x02,
  SUBGROUP_PRESENT: 0x03,
  SUBGROUP_MASK: 0x03,

  // Additional flags
  OBJECT_ID_PRESENT: 0x04,
  GROUP_ID_PRESENT: 0x08,
  PRIORITY_PRESENT: 0x10,
  PROPERTIES_PRESENT: 0x20,
  /**
   * Datagram フラグ (0x40)
   * Subgroup ID フィールドが存在しないため、下位 2 ビットを無視する
   */
  DATAGRAM: 0x40,

  /**
   * End of Non-Existent Range (Section 11.4.1.2)
   *
   * draft-ietf-moq-transport-21:
   * 指定した Location までの Object が存在しないことを示す。
   * Group ID と Object ID フィールドが存在する。
   * Subgroup ID, Priority, Properties は存在しない。
   * draft-ietf-moq-transport-21 Section 11.4.1.2
   */
  END_OF_NON_EXISTENT_RANGE: 0x8c,
  /**
   * End of Unknown Range (Section 11.4.1.2)
   *
   * draft-ietf-moq-transport-21:
   * 指定した Location までの Object のステータスが不明であることを示す。
   * Group ID と Object ID フィールドが存在する。
   * Subgroup ID, Priority, Properties は存在しない。
   * draft-ietf-moq-transport-21 Section 11.4.1.2
   */
  END_OF_UNKNOWN_RANGE: 0x10c,
  /**
   * End of Timed-Out Range (Section 11.4.1.2)
   *
   * draft-ietf-moq-transport-21:
   * Fill Timeout の失効により放棄された Object の範囲を示す。
   * Group ID と Object ID フィールドが存在する。
   * Subgroup ID, Priority, Properties は存在しない。
   * draft-ietf-moq-transport-21 Section 11.4.1.2
   */
  END_OF_TIMED_OUT_RANGE: 0x20c,
} as const;

/**
 * Fetch Object Fields (Figure 28 in Section 11.4.1)
 */
// draft-ietf-moq-transport-21 Section 11.1.2:
// "The Object Status is a field that is only present in objects that are
// delivered via a SUBSCRIPTION, and is absent in Objects delivered via a FETCH."
export interface FetchObjectFields {
  serializationFlags: number;
  groupId?: bigint;
  subgroupId?: bigint;
  objectId?: bigint;
  publisherPriority?: number;
  properties?: Uint8Array;
  /**
   * Object Payload Length。
   *
   * draft-ietf-moq-transport-21 §11.4.1:
   * 通常 Object のフィールドであり、End of Range indicator の wire には存在しない。
   * End of Range では無視される。
   */
  payloadLength: bigint;
  payload?: Uint8Array;
}

/**
 * End of Range の種別
 *
 * draft-ietf-moq-transport-21 Section 11.4.1.2:
 * FETCH レスポンス内で Object が存在しない/不明/タイムアウト失効した範囲を示す。
 */
export type EndOfRangeType = "non_existent" | "unknown" | "timed_out";

/**
 * Decoded Fetch Object with resolved values
 */
export interface DecodedFetchObject {
  groupId: bigint;
  subgroupId: bigint;
  objectId: bigint;
  publisherPriority: number;
  properties?: Uint8Array;
  /**
   * Object Payload Length。
   *
   * draft-ietf-moq-transport-21 §11.4.1:
   * End of Range indicator は Object Payload Length を持たないため、EOR の場合は 0n。
   */
  payloadLength: bigint;
  /**
   * End of Range indicator (Section 11.4.1.2)
   *
   * draft-ietf-moq-transport-21:
   * 設定されている場合、この Object は実際のデータではなく
   * 指定した Location までの範囲を示す End of Range indicator。
   */
  endOfRange?: EndOfRangeType;
}

/**
 * Context for decoding Fetch Objects (tracks prior object's values)
 */
export interface FetchObjectContext {
  groupId: bigint;
  subgroupId: bigint;
  objectId: bigint;
  /**
   * 直近の実オブジェクト (Datagram を含む) の Publisher Priority。
   * draft-ietf-moq-transport-21 §11.4.1.1 Table 9 の「Priority is the prior
   * Object's Priority」の規定に従い、0x10 省略時の継承値に使う (prior Object
   * には Datagram も含まれる)。
   */
  publisherPriority: number;
  /**
   * 直近の Subgroup オブジェクトの Publisher Priority。
   * draft-ietf-moq-transport-21 §12.1 の比較対象
   * ("the previous Object with the same Subgroup ID") に使う値であり、
   * Subgroup オブジェクトでのみ更新される (Datagram / End of Range では
   * 保持する。Subgroup を持たないオブジェクトは比較対象外のため)。
   * optional (undefined) は publisherPriority を代用する (ハードコード
   * されたテストコンテキストとの互換)。
   */
  subgroupPublisherPriority?: number;
  /**
   * 現在の Group 内に先行する Subgroup オブジェクトが存在するか。
   * 存在しない場合 (まだ Subgroup オブジェクトが出現していない・Group を
   * 横断した直後) は、Priority 比較の対象が無いため比較しない。
   * optional (undefined) は「先行する Subgroup オブジェクトあり」として
   * 扱う (ハードコードされたテストコンテキストとの互換)。
   */
  hasPriorSubgroup?: boolean;
  /**
   * 直前 (End of Range indicator を含む) までに実 Object が 1 つ以上あるか。
   *
   * draft-ietf-moq-transport-21 §11.4.1.2 (End of Range):
   * "Prior Subgroup ID: The Subgroup ID from the last actual Object before the
   *  End of Range indicator. If there was no prior Object, using a flag that
   *  references the prior Subgroup ID is a PROTOCOL_VIOLATION."
   * "Prior Priority: The Priority from the last actual Object before the End
   *  of Range indicator. If there was no prior Object, using a flag that
   *  references the prior Priority is a PROTOCOL_VIOLATION."
   * End of Range indicator 自体は実 Object ではないため、先頭レコードが
   * End of Range の場合は false を引き継ぎ、後続 Object が prior Subgroup ID /
   * prior Priority を参照したら PROTOCOL_VIOLATION とする。
   * optional (undefined) は「先行する実 Object あり」として扱う
   * (ハードコードされたテストコンテキストとの互換)。
   */
  hasPriorActualObject?: boolean;
  /**
   * 現在の Group 内の Subgroup ID ごとの直近の Publisher Priority。
   * draft-ietf-moq-transport-21 §12.1 の比較対象
   * ("the previous Object with the same Subgroup ID") を Subgroup が
   * 交互に出現する場合も追跡するために使う。Subgroup オブジェクトを
   * デコードするたびに解決後の Priority で更新し、Datagram では更新しない
   * (Subgroup に属さないため)。Group 変更時は捨てる。
   * optional (undefined) は従来の単一コンテキスト比較
   * (subgroupPublisherPriority / hasPriorSubgroup) に委ねる
   * (ハードコードされたテストコンテキストとの互換。委譲はそのコンテキストを
   * 通る最初の比較のみで、以後の更新で Map 追跡に移行する)。
   *
   * 内部の状態オブジェクトで、Map 追跡なしを明示的に undefined として保持するため
   * `| undefined` を付ける
   */
  subgroupPriorities?: Map<bigint, number> | undefined;
}

/**
 * Serialization Flags が End of Range (Section 11.4.1.2) かを判定する
 *
 * draft-ietf-moq-transport-21 §11.4.1 Table 7:
 * 0x8C (End of Non-Existent Range) / 0x10C (End of Unknown Range) /
 * 0x20C (End of Timed-Out Range) が定義されている。
 */
function isEndOfRangeFlags(flags: number): boolean {
  return (
    flags === FetchSerializationFlags.END_OF_NON_EXISTENT_RANGE ||
    flags === FetchSerializationFlags.END_OF_UNKNOWN_RANGE ||
    flags === FetchSerializationFlags.END_OF_TIMED_OUT_RANGE
  );
}

/**
 * Encode Fetch Object Fields
 * draft-ietf-moq-transport-21 Section 11.4.1 Figure 28
 *
 * リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。
 * PBT（Property-Based Testing）でのラウンドトリップテストで使用。
 */
export function encodeFetchObjectFields(
  fields: FetchObjectFields,
  includePayload = false,
  context: FetchObjectContext | null = null,
  groupOrder: GroupOrder = GroupOrder.ASCENDING,
): Uint8Array {
  const parts: Uint8Array[] = [];

  // Serialization Flags (varint)
  // draft-ietf-moq-transport-21: vi64 としてエンコード
  parts.push(encodeVarint(fields.serializationFlags));

  // End of Range の場合は Group ID と Object ID のみ
  // draft-ietf-moq-transport-21 §11.4.1.2: End of Range indicator は通常 Object と
  // 異なり Object Payload Length / Object Payload を持たない。
  // FetchObjectFields.payloadLength は通常 Object 用であり、ここでは wire に書かない。
  if (isEndOfRangeFlags(fields.serializationFlags)) {
    if (fields.groupId === undefined || fields.objectId === undefined) {
      throw new Error("Group ID and Object ID required for End of Range");
    }
    parts.push(encodeVarint(fields.groupId));
    parts.push(encodeVarint(fields.objectId));

    return concatUint8Arrays(parts);
  }

  // Group ID (フラグ 0x08 がセットされている場合)
  // draft-ietf-moq-transport-21 §11.4.1.1 Table 9:
  // "If the Group Order is Ascending (default), the Group ID is the prior
  //  Object's Group ID plus the Group ID Delta + 1."
  // "If the Group Order is Descending, the Group ID is the prior
  //  Object's Group ID minus the (Group ID Delta + 1)."
  // エンコード時:
  //   Ascending: delta = currentGroupId - priorGroupId - 1n
  //   Descending: delta = priorGroupId - currentGroupId - 1n
  // 先頭オブジェクトまたは context 無しの場合は delta = currentGroupId (絶対値)
  if (fields.serializationFlags & FetchSerializationFlags.GROUP_ID_PRESENT) {
    if (fields.groupId === undefined) {
      throw new Error("Group ID required when GROUP_ID_PRESENT flag is set");
    }
    if (context === null) {
      parts.push(encodeVarint(fields.groupId));
    } else {
      const delta =
        groupOrder === GroupOrder.DESCENDING
          ? context.groupId - fields.groupId - 1n
          : fields.groupId - context.groupId - 1n;
      parts.push(encodeVarint(delta));
    }
  }

  // Subgroup ID (flags & 0x03 == 0x03 の場合)
  // Datagram 時 (0x40) は Subgroup ID フィールドをエンコードしない
  // draft-ietf-moq-transport-21 §11.4.1.1:
  // "the object has no Subgroup ID. The publisher MUST SET bit 0x40 to '1'."
  if (
    !(fields.serializationFlags & FetchSerializationFlags.DATAGRAM) &&
    (fields.serializationFlags & FetchSerializationFlags.SUBGROUP_MASK) ===
      FetchSerializationFlags.SUBGROUP_PRESENT
  ) {
    if (fields.subgroupId === undefined) {
      throw new Error("Subgroup ID required when SUBGROUP_PRESENT is set");
    }
    parts.push(encodeVarint(fields.subgroupId));
  }

  // Object ID (フラグ 0x04 がセットされている場合)
  // draft-ietf-moq-transport-21 §11.4.1.1 Table 9:
  // "When the Group ID Delta field is not present, the Object ID is the
  //  prior Object's ID plus the Object ID Delta if present."
  // エンコード時:
  //   - Group 不変 (!GROUP_ID_PRESENT) かつ context あり: delta = currentObjectId - priorObjectId
  //   - それ以外（先頭または Group 変化）: delta = currentObjectId (絶対値)
  if (fields.serializationFlags & FetchSerializationFlags.OBJECT_ID_PRESENT) {
    if (fields.objectId === undefined) {
      throw new Error("Object ID required when OBJECT_ID_PRESENT flag is set");
    }
    if (
      !(fields.serializationFlags & FetchSerializationFlags.GROUP_ID_PRESENT) &&
      context !== null
    ) {
      const delta = fields.objectId - context.objectId;
      parts.push(encodeVarint(delta));
    } else {
      parts.push(encodeVarint(fields.objectId));
    }
  }

  // Publisher Priority (フラグ 0x10 がセットされている場合)
  if (fields.serializationFlags & FetchSerializationFlags.PRIORITY_PRESENT) {
    if (fields.publisherPriority === undefined) {
      throw new Error("Publisher Priority required when PRIORITY_PRESENT flag is set");
    }
    validatePublisherPriority(fields.publisherPriority);
    parts.push(new Uint8Array([fields.publisherPriority]));
  }

  // プロパティ (フラグ 0x20 がセットされている場合)
  if (fields.serializationFlags & FetchSerializationFlags.PROPERTIES_PRESENT) {
    const extLen = fields.properties?.length ?? 0;
    parts.push(encodeVarint(extLen));
    if (fields.properties && fields.properties.length > 0) {
      parts.push(fields.properties);
    }
  }

  // Object Payload Length
  parts.push(encodeVarint(fields.payloadLength));

  // draft-ietf-moq-transport-21 Section 11.1.2:
  // "The Object Status is a field that is only present in objects that are
  // delivered via a SUBSCRIPTION, and is absent in Objects delivered via a FETCH."
  // Fetch Object には Object Status を含めない

  // Object Payload (オプション、指定時のみ含める)
  if (includePayload && fields.payload && fields.payloadLength > 0n) {
    parts.push(fields.payload);
  }

  return concatUint8Arrays(parts);
}

/**
 * End of Range レコードをデコードする
 *
 * draft-ietf-moq-transport-21 §11.4.1.2: Group ID と Object ID のみが存在する。
 */
function decodeEndOfRange(
  data: Uint8Array,
  startOffset: number,
  flags: number,
  context: FetchObjectContext | null,
): [DecodedFetchObject, number, FetchObjectContext] {
  let consumed = 0;

  const [groupId, gidConsumed] = decodeVarint(data, startOffset + consumed);
  consumed += gidConsumed;

  const [objectId, oidConsumed] = decodeVarint(data, startOffset + consumed);
  consumed += oidConsumed;

  // draft-ietf-moq-transport-21 §11.4.1.2:
  // End of Range indicator は Group ID と Object ID のみで、Object Payload Length を持たない。
  // 呼び出し側 (processFetchObjects) が payload 0 バイトとして扱えるように 0n を返す。
  const payloadLength = 0n;

  const endOfRange: EndOfRangeType =
    flags === FetchSerializationFlags.END_OF_NON_EXISTENT_RANGE
      ? "non_existent"
      : flags === FetchSerializationFlags.END_OF_TIMED_OUT_RANGE
        ? "timed_out"
        : "unknown";

  // End of Range は常に Group ID を明示する。Group が変更された場合は
  // 先行する Subgroup オブジェクトの存在をリセットし、同一 Group 内の
  // End of Range では引き継ぐ (後続の同一 Subgroup オブジェクトの比較
  // 対象が直前の Subgroup オブジェクトになり得るため)。
  // publisherPriority / subgroupPublisherPriority は End of Range の前の
  // 実オブジェクトの値を保持する (§11.4.1.2 の「The Priority from the
  // last actual Object before the End of Range indicator」)。
  const sameGroup = context !== null && groupId === context.groupId;
  const newContext: FetchObjectContext = {
    groupId,
    subgroupId: context?.subgroupId ?? 0n,
    objectId,
    publisherPriority: context?.publisherPriority ?? 0,
    subgroupPublisherPriority:
      context?.subgroupPublisherPriority ?? context?.publisherPriority ?? 0,
    hasPriorSubgroup: sameGroup ? (context?.hasPriorSubgroup ?? true) : false,
    // draft-ietf-moq-transport-21 §11.4.1.2:
    // End of Range indicator は実 Object ではないため、先行する実 Object の
    // 有無を引き継ぐ (先頭レコードが End of Range なら false)。
    hasPriorActualObject: context === null ? false : (context.hasPriorActualObject ?? true),
    // 同一 Group 内では Subgroup ごとの追跡を引き継ぎ、Group 変更時は捨てる。
    // 引き継ぎは参照共有とし、更新時は decodeFetchObjectFields 側で
    // コピーして置き換える (呼び出し元の再利用を壊さない)。
    subgroupPriorities: sameGroup ? context?.subgroupPriorities : new Map<bigint, number>(),
  };

  return [
    {
      groupId,
      subgroupId: context?.subgroupId ?? 0n,
      objectId,
      publisherPriority: context?.publisherPriority ?? 0,
      payloadLength,
      endOfRange,
    },
    consumed,
    newContext,
  ];
}

/**
 * Fetch Object の Subgroup ID をデコードする
 *
 * draft-ietf-moq-transport-21 §11.4.1.1:
 * "When encoding an Object with a Forwarding Preference of 'Datagram' ... the
 *  object has no Subgroup ID. The publisher MUST SET bit 0x40 to '1'. When
 *  0x40 is set, it SHOULD set the two least significant bits to zero and the
 *  subscriber MUST ignore the bits."
 *
 * @returns subgroupId, isDatagram, and extra bytes consumed
 */
function decodeFetchSubgroupId(
  data: Uint8Array,
  flags: number,
  offset: number,
  isFirst: boolean,
  context: FetchObjectContext | null,
): { subgroupId: bigint; isDatagram: boolean; consumed: number } {
  const isDatagram = (flags & FetchSerializationFlags.DATAGRAM) !== 0;

  // draft-ietf-moq-transport-21 §11.4.1.1:
  // DATAGRAM ビットが立つ Object は Subgroup ID を持たない。下位 2 ビットの値に
  // 関わらず Subgroup ID フィールドは存在しないため、1 バイトも消費せず
  // subgroupId = 0 を返す。
  if (isDatagram) {
    return { subgroupId: 0n, isDatagram: true, consumed: 0 };
  }

  const subgroupEncoding = flags & FetchSerializationFlags.SUBGROUP_MASK;
  switch (subgroupEncoding) {
    case FetchSerializationFlags.SUBGROUP_ZERO:
      return { subgroupId: 0n, isDatagram: false, consumed: 0 };
    case FetchSerializationFlags.SUBGROUP_SAME:
      if (isFirst || context === null) {
        throw new ProtocolViolationError("first object cannot use SUBGROUP_SAME");
      }
      // draft-ietf-moq-transport-21 §11.4.1.2:
      // 先頭レコードが End of Range indicator の場合、参照できる prior Subgroup ID
      // (最後の実 Object の Subgroup ID) が存在しないため PROTOCOL_VIOLATION。
      if (context.hasPriorActualObject === false) {
        throw new ProtocolViolationError(
          "cannot reference prior subgroup id before any actual object",
        );
      }
      return { subgroupId: context.subgroupId, isDatagram: false, consumed: 0 };
    case FetchSerializationFlags.SUBGROUP_PLUS_ONE:
      if (isFirst || context === null) {
        throw new ProtocolViolationError("first object cannot use SUBGROUP_PLUS_ONE");
      }
      // draft-ietf-moq-transport-21 §11.4.1.2: 同上 (prior Subgroup ID 参照)。
      if (context.hasPriorActualObject === false) {
        throw new ProtocolViolationError(
          "cannot reference prior subgroup id before any actual object",
        );
      }
      return { subgroupId: context.subgroupId + 1n, isDatagram: false, consumed: 0 };
    case FetchSerializationFlags.SUBGROUP_PRESENT: {
      const [sid, sidConsumed] = decodeVarint(data, offset);
      return { subgroupId: sid, isDatagram: false, consumed: sidConsumed };
    }
    default:
      throw new ProtocolViolationError(`invalid subgroup encoding: ${subgroupEncoding}`);
  }
}

/**
 * 同一 Group・同一 Subgroup の直近の Subgroup オブジェクトとの Publisher
 * Priority の一致を検証する
 *
 * draft-ietf-moq-transport-21 §12.1 (Malformed Tracks):
 * "An Object with a particular Subgroup ID is received, but its Publisher
 *  Priority is different from that of the previous Object with the same
 *  Subgroup ID."
 * 同一 Group・同一 Subgroup 内のオブジェクトは同じ Publisher Priority を
 * 持つ必要がある。異なる Priority を検出した場合は MalformedTrackError を
 * throw する。上位ハンドラはこれを FETCH キャンセル (セッション終了ではない)
 * に変換する。
 *
 * 検出は Group スコープで行う。draft-ietf-moq-transport-21 §2.2:
 * "The scope of a Subgroup ID is a Group, so Subgroups from different Groups
 *  MAY share a Subgroup ID without implying any relationship between them."
 * 異なる Group の同一 Subgroup ID は無関係であり、Priority が異なっても合法。
 * 比較対象は「同一 Group・同一 Subgroup の直近の Subgroup オブジェクト」であり、
 * 前オブジェクトが Datagram / End of Range の場合はその前の Subgroup
 * オブジェクトを対象にする (Datagram は Subgroup に属さないため比較対象外。
 * Group が横断された場合 (hasPriorSubgroup = false) は比較対象が無いため
 * 比較しない)。
 * Subgroup ID ごとの追跡 (subgroupPriorities) を持つコンテキストでは、
 * 直前オブジェクトと異なる Subgroup ID の場合も同一 Subgroup ID の直近値と
 * 比較する (Subgroup の交互出現に対応)。追跡を持たないコンテキストでは
 * 従来どおり直前オブジェクトとの比較に委ねる。
 */
function checkSubgroupPriorityMismatch(
  context: FetchObjectContext | null,
  isDatagram: boolean,
  groupId: bigint,
  subgroupId: bigint,
  publisherPriority: number,
): void {
  if (!isDatagram && context !== null && groupId === context.groupId) {
    if (context.subgroupPriorities !== undefined) {
      const expected = context.subgroupPriorities.get(subgroupId);
      if (expected !== undefined && publisherPriority !== expected) {
        throw new MalformedTrackError(
          `malformed track: different priorities in same subgroup ` +
            `(group=${groupId}, subgroup=${subgroupId}, expected=${expected}, actual=${publisherPriority})`,
        );
      }
      return;
    }
    if (subgroupId === context.subgroupId && (context.hasPriorSubgroup ?? true)) {
      const expected = context.subgroupPublisherPriority ?? context.publisherPriority;
      if (publisherPriority !== expected) {
        throw new MalformedTrackError(
          `malformed track: different priorities in same subgroup ` +
            `(group=${groupId}, subgroup=${subgroupId}, expected=${expected}, actual=${publisherPriority})`,
        );
      }
    }
  }
}

/**
 * §12.1 条件 1 用に Subgroup ID ごとの直近 Priority の追跡を更新する
 *
 * draft-ietf-moq-transport-21 §12.1 (Malformed Tracks):
 * "An Object with a particular Subgroup ID is received, but its Publisher
 *  Priority is different from that of the previous Object with the same
 *  Subgroup ID."
 * Group 変更時は追跡を捨て、Datagram では更新しない (Subgroup に属さない
 * ため)。更新時はコピーして置き換え、呼び出し元が保持する旧コンテキストの
 * 再利用を壊さない。
 * PRIORITY_PRESENT 省略時は比較対象外とする (従来の寛容解釈を維持) が、
 * 追跡自体は解決後の継承値で更新する (後続の明示値との比較基準にするため)。
 */
function updateSubgroupPriorities(
  context: FetchObjectContext | null,
  groupChanged: boolean,
  isDatagram: boolean,
  subgroupId: bigint,
  publisherPriority: number,
): Map<bigint, number> | undefined {
  if (groupChanged) {
    const fresh = new Map<bigint, number>();
    if (!isDatagram) {
      fresh.set(subgroupId, publisherPriority);
    }
    return fresh;
  }
  if (isDatagram) {
    return context?.subgroupPriorities;
  }
  const updated = new Map(context?.subgroupPriorities);
  updated.set(subgroupId, publisherPriority);
  return updated;
}

/**
 * PRIORITY_PRESENT が設定された Fetch Object の Publisher Priority バイトを読む
 *
 * Priority は 8 bit 固定 (draft-ietf-moq-transport-21 §11.4.1.1) のため、
 * バッファが Priority バイトで切れている場合は範囲外アクセス (undefined 取得)
 * による誤検出を避け、IncompleteDataError で次のチャンクを待つ。
 *
 * @param data - デコード対象のバイト列
 * @param priorityOffset - Priority バイトの位置
 */
function readFetchObjectPublisherPriority(data: Uint8Array, priorityOffset: number): number {
  if (priorityOffset >= data.length) {
    throw new IncompleteDataError("incomplete fetch object fields: publisher priority");
  }
  const priorityByte = data[priorityOffset];
  if (priorityByte === undefined) {
    // 上の priorityOffset >= data.length の検証により到達しない
    // (noUncheckedIndexedAccess で型上 undefined を含むための防御)
    throw new IncompleteDataError("incomplete fetch object fields: publisher priority");
  }
  return priorityByte;
}

/**
 * PRIORITY_PRESENT が未設定の Fetch Object の Priority を解決する
 *
 * draft-ietf-moq-transport-21 §11.4.1.1 Table 9:
 * 0x10 未設定は「直近の実オブジェクト (Datagram を含む) の Priority を
 * 継承する」ことを意味する。
 *
 * draft-ietf-moq-transport-21 §11.4.1.2 (End of Range):
 * "Prior Priority: The Priority from the last actual Object before the End of
 *  Range indicator. If there was no prior Object, using a flag that references
 *  the prior Priority is a PROTOCOL_VIOLATION."
 * 先頭オブジェクト (context null) と、先頭レコードが End of Range indicator で
 * 実 Object が 1 つも無い場合 (hasPriorActualObject === false) は継承元が無い
 * ため PROTOCOL_VIOLATION とする。
 */
function resolvePriorFetchPublisherPriority(context: FetchObjectContext | null): number {
  if (context === null) {
    throw new ProtocolViolationError("first object must have PRIORITY_PRESENT flag set");
  }
  if (context.hasPriorActualObject === false) {
    throw new ProtocolViolationError("cannot reference prior priority before any actual object");
  }
  return context.publisherPriority;
}

/**
 * Decode Fetch Object Fields
 * draft-ietf-moq-transport-21 Section 11.4.1 Figure 28
 *
 * @param data - Data buffer
 * @param context - Context with prior object's values (required after first object)
 * @param offset - Starting offset in buffer
 * @param isFirst - Whether this is the first object (no prior context allowed)
 * @param groupOrder - Group Order (GroupOrder.ASCENDING or GroupOrder.DESCENDING)
 */
export function decodeFetchObjectFields(
  data: Uint8Array,
  context: FetchObjectContext | null,
  offset = 0,
  isFirst = false,
  groupOrder: GroupOrder = GroupOrder.ASCENDING,
): [DecodedFetchObject, number, FetchObjectContext] {
  let totalConsumed = 0;

  // Serialization Flags (varint)
  // draft-ietf-moq-transport-21: vi64 としてエンコードされる
  const [flagsRaw, flagsConsumed] = decodeVarint(data, offset + totalConsumed);
  const flags = Number(flagsRaw);
  totalConsumed += flagsConsumed;

  // End of Range チェック (Section 11.4.1.2)
  if (isEndOfRangeFlags(flags)) {
    const [result, consumed, newContext] = decodeEndOfRange(
      data,
      offset + totalConsumed,
      flags,
      context,
    );
    return [result, totalConsumed + consumed, newContext];
  }

  // draft-ietf-moq-transport-21 Section 11.4.1 Table 7:
  // 「When less than 128, the bits represent flags described below.
  //  The following additional values are defined: 0x8C (End of Non-Existent Range),
  //  0x10C (End of Unknown Range), 0x20C (End of Timed-Out Range).
  //  Any other value is a PROTOCOL_VIOLATION.」
  // 0x8C / 0x10C / 0x20C は上の End of Range チェックで処理済み。
  // それ以外の 128 以上の値は不正。
  if (flags >= 128) {
    throw new ProtocolViolationError(
      `invalid fetch serialization flags: 0x${flags.toString(16)}, expected flags < 128, 0x8C, 0x10C, or 0x20C`,
    );
  }

  // Group ID
  // draft-ietf-moq-transport-21 §11.4.1.1 Table 9:
  // Ascending: "The Group ID is the prior Object's Group ID plus the Group ID Delta + 1."
  // Descending: "The Group ID is the prior Object's Group ID minus the (Group ID Delta + 1)."
  // "If the computed Group ID would be less than 0 or greater than 2^64-1, the Subscriber MUST close the Session with error 'PROTOCOL_VIOLATION'."
  // 先頭オブジェクト (isFirst) の場合は delta が絶対値と等価。
  let groupId: bigint;
  if (flags & FetchSerializationFlags.GROUP_ID_PRESENT) {
    const [delta, deltaConsumed] = decodeVarint(data, offset + totalConsumed);
    if (isFirst || context === null) {
      groupId = delta;
    } else if (groupOrder === GroupOrder.DESCENDING) {
      groupId = context.groupId - delta - 1n;
    } else {
      groupId = context.groupId + delta + 1n;
    }
    totalConsumed += deltaConsumed;
  } else {
    if (isFirst || context === null) {
      throw new ProtocolViolationError("first object must have GROUP_ID_PRESENT flag set");
    }
    groupId = context.groupId;
  }

  // Group ID の範囲検証: 0 以上 2^64-1 以下
  // draft-ietf-moq-transport-21 §11.4.1.1 Table 9:
  // "If the computed Group ID would be less than 0 or greater than 2^64-1,
  //  the Subscriber MUST close the Session with error 'PROTOCOL_VIOLATION'."
  // 上限は varint の最大値と同一のため MAX_VARINT を使う。
  if (groupId < 0n || groupId > MAX_VARINT) {
    throw new ProtocolViolationError(
      `computed group id out of range: ${groupId}, expected 0 to 2^64-1`,
    );
  }

  // Subgroup ID をデコード（DATAGRAM フラグの処理を含む）
  // draft-ietf-moq-transport-21 §11.4.1.1:
  // "When encoding an Object with a Forwarding Preference of 'Datagram' ... the
  //  object has no Subgroup ID. ... When 0x40 is set, it SHOULD set the two
  //  least significant bits to zero and the subscriber MUST ignore the bits."
  const {
    subgroupId,
    isDatagram,
    consumed: subgroupConsumed,
  } = decodeFetchSubgroupId(data, flags, offset + totalConsumed, isFirst, context);
  totalConsumed += subgroupConsumed;

  // Object ID
  // draft-ietf-moq-transport-21 §11.4.1.1 Table 9:
  // "When the Group ID Delta field is not present, the Object ID is the
  //  prior Object's ID plus the Object ID Delta if present."
  // Group 不変時 (!GROUP_ID_PRESENT) かつ非先頭の場合、delta は prior + delta。
  // 先頭オブジェクトまたは Group 変化時は delta が絶対値。
  let objectId: bigint;
  if (flags & FetchSerializationFlags.OBJECT_ID_PRESENT) {
    const [delta, deltaConsumed] = decodeVarint(data, offset + totalConsumed);
    if (!(flags & FetchSerializationFlags.GROUP_ID_PRESENT) && !isFirst && context !== null) {
      objectId = context.objectId + delta;
    } else {
      objectId = delta;
    }
    totalConsumed += deltaConsumed;
  } else {
    if (isFirst || context === null) {
      throw new ProtocolViolationError("first object must have OBJECT_ID_PRESENT flag set");
    }
    objectId = context.objectId + 1n;
  }

  // Object ID の範囲検証: 0 以上 2^64-1 以下
  // draft-ietf-moq-transport-21 §11.4.1.1 Table 9:
  // "If the computed Object ID would be greater than 2^64-1, the
  //  Subscriber MUST close the Session with error 'PROTOCOL_VIOLATION'."
  // 上限は varint の最大値と同一のため MAX_VARINT を使う。
  if (objectId > MAX_VARINT) {
    throw new ProtocolViolationError(
      `computed object id out of range: ${objectId}, expected 0 to 2^64-1`,
    );
  }

  // Publisher Priority
  let publisherPriority: number;
  if (flags & FetchSerializationFlags.PRIORITY_PRESENT) {
    publisherPriority = readFetchObjectPublisherPriority(data, offset + totalConsumed);
    totalConsumed += 1;

    checkSubgroupPriorityMismatch(context, isDatagram, groupId, subgroupId, publisherPriority);
  } else {
    // draft-ietf-moq-transport-21 §11.4.1.1 Table 9:
    // 0x10 未設定は「直近の実オブジェクト (Datagram を含む) の Priority を
    // 継承する」ことを意味する。
    publisherPriority = resolvePriorFetchPublisherPriority(context);
  }

  // Properties
  let properties: Uint8Array | undefined;
  if (flags & FetchSerializationFlags.PROPERTIES_PRESENT) {
    const [extLen, extLenConsumed] = decodeVarint(data, offset + totalConsumed);
    totalConsumed += extLenConsumed;

    if (extLen > 0) {
      // Properties 本体が宣言バイト数に満たない場合は切り詰めず
      // IncompleteDataError で次のチャンクを待つ (decodeSubgroupHeader の
      // Priority バイト境界チェックと同方式。切り詰めると totalConsumed が
      // 実バイト数を超えて後続フィールドを誤読する)。
      // draft-ietf-moq-transport-21 Section 11.4.1.1:
      // 節番号は仕様将来版で変わる可能性がある。
      const propertiesLength = Number(extLen);
      if (offset + totalConsumed + propertiesLength > data.length) {
        throw new IncompleteDataError("incomplete fetch object fields: properties");
      }
      properties = data.slice(offset + totalConsumed, offset + totalConsumed + propertiesLength);
      totalConsumed += propertiesLength;

      // draft-ietf-moq-transport-21 §3.6:
      // Mandatory Track Property を Object Property として含む Object は malformed
      assertNoMandatoryTrackPropertyInObjectProperties(properties);
      // draft-ietf-moq-transport-21 §8.3:
      // 既知 Type の Value が serialization に一致しない場合は
      // KEY_VALUE_FORMATTING_ERROR でセッションを閉じる
      assertKnownPropertyValueInObjectProperties(properties);

      // draft-ietf-moq-transport-21 §10.8 / §10.9:
      // Prior Group ID Gap / Prior Object ID Gap のうち単一 Object で判定できる
      // malformed 条件 (gap が Group ID / Object ID より大きい) を検証する。
      assertPriorIdGapInObjectProperties(groupId, objectId, properties);
    }
  }

  // Object Payload Length
  const [payloadLength, payloadLenConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += payloadLenConsumed;

  // draft-ietf-moq-transport-21 Section 11.1.2:
  // "The Object Status is a field that is only present in objects that are
  // delivered via a SUBSCRIPTION, and is absent in Objects delivered via a FETCH."
  // Fetch Object には Object Status は存在しない

  // 次のオブジェクトのためにコンテキストを更新
  // Datagram オブジェクトは Subgroup ID を持たないため、
  // コンテキストには Datagram 以前の実際の Subgroup ID を伝搬させる。
  // publisherPriority は直近の実オブジェクトの値として全オブジェクトで更新する
  // (§11.4.1.1 Table 9 の 0x10 省略時の継承値)。§12.1 比較専用の
  // subgroupPublisherPriority は Subgroup オブジェクトでのみ更新する。
  const groupChanged = (flags & FetchSerializationFlags.GROUP_ID_PRESENT) !== 0 || context === null;
  const subgroupPriorities = updateSubgroupPriorities(
    context,
    groupChanged,
    isDatagram,
    subgroupId,
    publisherPriority,
  );
  const newContext: FetchObjectContext = {
    groupId,
    subgroupId: isDatagram ? (context?.subgroupId ?? 0n) : subgroupId,
    objectId,
    publisherPriority,
    // 直近の Subgroup オブジェクトの Priority (Datagram / End of Range では保持)
    subgroupPublisherPriority: isDatagram
      ? (context?.subgroupPublisherPriority ?? context?.publisherPriority ?? 0)
      : publisherPriority,
    // 現在の Group 内に先行する Subgroup オブジェクトが存在するか。
    // Group が変更された場合はリセットし、Datagram は存在を加算しない
    // (非 Datagram ではこのオブジェクト自身が先行 Subgroup として数える)。
    // ハードコードされたコンテキストとの互換のため、undefined は「あり」扱い。
    hasPriorSubgroup: isDatagram
      ? groupChanged
        ? false
        : (context?.hasPriorSubgroup ?? true)
      : true,
    // このオブジェクト自身が実 Object であるため、後続の prior Subgroup ID /
    // prior Priority 参照は常に有効になる (§11.4.1.2)。
    hasPriorActualObject: true,
    subgroupPriorities,
  };
  return [
    {
      groupId,
      subgroupId,
      objectId,
      publisherPriority,
      // exactOptionalPropertyTypes では optional な properties に undefined を渡せないため、
      // 値がある場合だけ載せる
      ...(properties !== undefined ? { properties } : {}),
      payloadLength,
    },
    totalConsumed,
    newContext,
  ];
}

/**
 * Create serialization flags for first Fetch object
 * First object must have all fields present
 *
 * @param hasExtensions - Whether the object has extension properties
 * @param isDatagram - Whether the object uses Datagram forwarding preference
 */
export function createFirstFetchObjectFlags(hasExtensions = false, isDatagram = false): number {
  let flags =
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;

  if (isDatagram) {
    // Datagram 時は Subgroup ID フィールドなし、DATAGRAM ビットを設定
    // draft-ietf-moq-transport-21 §11.4.1.1:
    // "the publisher MUST SET bit 0x40 to '1'"
    // 下位 2 ビットは SUBGROUP_ZERO (0x00) が推奨
    flags |= FetchSerializationFlags.DATAGRAM;
  } else {
    flags |= FetchSerializationFlags.SUBGROUP_PRESENT;
  }

  if (hasExtensions) {
    flags |= FetchSerializationFlags.PROPERTIES_PRESENT;
  }

  return flags;
}

/**
 * Create serialization flags based on delta from prior object
 */
export function createFetchObjectFlags(
  current: { groupId: bigint; subgroupId: bigint; objectId: bigint; publisherPriority: number },
  prior: FetchObjectContext,
  hasExtensions = false,
): number {
  let flags = 0;

  // Group ID
  if (current.groupId !== prior.groupId) {
    flags |= FetchSerializationFlags.GROUP_ID_PRESENT;
  }

  // Subgroup ID
  if (current.subgroupId === 0n) {
    flags |= FetchSerializationFlags.SUBGROUP_ZERO;
  } else if (current.subgroupId === prior.subgroupId) {
    flags |= FetchSerializationFlags.SUBGROUP_SAME;
  } else if (current.subgroupId === prior.subgroupId + 1n) {
    flags |= FetchSerializationFlags.SUBGROUP_PLUS_ONE;
  } else {
    flags |= FetchSerializationFlags.SUBGROUP_PRESENT;
  }

  // Object ID
  if (current.objectId !== prior.objectId + 1n) {
    flags |= FetchSerializationFlags.OBJECT_ID_PRESENT;
  }

  // Publisher Priority
  if (current.publisherPriority !== prior.publisherPriority) {
    flags |= FetchSerializationFlags.PRIORITY_PRESENT;
  }

  // Properties
  if (hasExtensions) {
    flags |= FetchSerializationFlags.PROPERTIES_PRESENT;
  }

  return flags;
}
