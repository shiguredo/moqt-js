/**
 * MOQT Fetch Stream
 * draft-ietf-moq-transport-23 Section 11.4 (Fetch Streams)
 *
 * Fetch Header (Section 11.4.1) と Fetch Object fields (Figure 29) の
 * エンコードとデコードを扱う。Fetch Object は Subgroup / Datagram と異なり
 * 前オブジェクトからの delta でフィールドを省略する (§11.4.1.1 Table 9 / 10)
 * ため、直前の値を持つ FetchObjectContext を引き回す。
 * 同一 Group の Object ID は prior Object ID + Object ID Delta + 2 であり、
 * Delta 省略時は prior Object ID + 1 である (§11.4.1.1)。
 *
 * End of Range indicator (§11.4.2) の ID は通常 Object と別式である。
 * FETCH_HEADER 直後の先頭エントリーだけが Group ID / Object ID の絶対値で、
 * それ以外は直前の Object または End of Range indicator の復号値に対する
 * Group ID Delta / Object ID Delta になる (§11.4.2.1)。Group ID は通常 Object の
 * +1 を加えず Ascending で prior + Group ID Delta、Descending で
 * prior - Group ID Delta であり、Group ID Delta が 0 なら Object ID は
 * prior + Object ID Delta + 1、非 0 なら新しい Group の絶対 Object ID である。
 * 通常 Object の +2 と End of Range の +1 を共通化しない。
 *
 * End of Group (0x80) / End of Track (0x81) は追加フィールドを持たない
 * indicator であり、直前の実 Object を Group / Track の最終 Object として
 * 参照する (§11.4.2.2)。終端位置は算術用の prior Object ID からではなく、
 * 最後の実 Object の位置を別に保持して求め、受理後は後続エントリーの ID 復元に
 * 使う prior Object ID を 2^64-1 にする (同節)。
 *
 * 節番号・語彙は将来のドラフト改訂で変わり得るため、改訂時は引用を更新する。
 *
 * Object の Delivery Mode (Subgroup か Datagram か) は Original Publisher が最初の
 * 送信方法で決める (draft-ietf-moq-transport-23 §2.1.1)。Fetch では Delivery Mode が
 * 適用されない (§3.2.1) ため、Fetch Object の DATAGRAM ビット (0x40) は Delivery Mode
 * ではなく「Subgroup ID フィールドを持たない」ことだけを示す。
 */

import { decodeVarint, encodeVarint, MAX_VARINT } from "../varint";
import { GroupOrder } from "../message/types";
import {
  IncompleteDataError,
  MalformedTrackError,
  ProtocolViolationError,
  SessionErrorCode,
} from "../error";
import {
  assertKnownPropertyValueInObjectProperties,
  assertNoMandatoryTrackPropertyInObjectProperties,
  assertPriorIdGapInObjectProperties,
} from "../properties";
import { concatUint8Arrays } from "../bytes";
import { validatePublisherPriority } from "./moqtObject";

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
      SessionErrorCode.INVALID_STREAM_HEADER,
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
 * draft-ietf-moq-transport-23 §11.4.1.1 Table 9: Subgroup ID encoding (bits 0-1)
 * | Bitmask (flags & 0x03) | Meaning |
 * | 0x00 | Subgroup ID is zero |
 * | 0x01 | Subgroup ID is prior Object's Subgroup ID |
 * | 0x02 | Subgroup ID is prior Object's Subgroup ID + 1 |
 * | 0x03 | Subgroup ID field is present |
 *
 * draft-ietf-moq-transport-23 §11.4.1.1 Table 10: Flags (independent flag bits)
 * | Bitmask | Condition if set |
 * | 0x04 | Object ID Delta is present (else prior + 1) |
 * | 0x08 | Group ID Delta is present (else prior Group ID) |
 * | 0x10 | Priority field is present (else prior Priority) |
 * | 0x20 | Properties field is present |
 * | 0x40 | Datagram: Subgroup ID の 2 ビットを無視 |
 *
 * 0x04 が立つ Object ID Delta は、Group ID Delta が無い場合に限り
 * prior Object ID + Delta + 2 を表す (§11.4.1.1)。Delta 省略時は Group ID の
 * 有無に関わらず prior Object ID + 1 である。
 *
 * End of Range (draft-ietf-moq-transport-23 §11.4.2):
 * | 0x8C  | End of Non-Existent Range |
 * | 0x10C | End of Unknown Range      |
 * | 0x20C | End of Timed-Out Range    |
 * | 0x40C | End of Gone Range         |
 *
 * End of Group / End of Track (draft-ietf-moq-transport-23 §11.4.1 Table 8 /
 * §11.4.2.2):
 * | 0x80 | End of Group |
 * | 0x81 | End of Track |
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
   *
   * draft-ietf-moq-transport-22 §11.4.1.1 (Flags) / §2.1.1 (Delivery Mode):
   * Datagram として送る Object は Subgroup ID を持たないため、送信側はこのビットを
   * 立てなければならず (MUST)、立てるときは下位 2 ビットを 0 にするのが望ましい
   * (SHOULD)。受信側は下位 2 ビットを無視しなければならない (MUST)。
   */
  DATAGRAM: 0x40,

  /**
   * End of Group (draft-ietf-moq-transport-23 §11.4.1 (Fetch Header) /
   * Table 8 / §11.4.2.2 (Prior Object Fields))
   *
   * draft-ietf-moq-transport-23 §11.4.2.2:
   * "When Serialization Flags is 0x80 (End of Group) or 0x81 (End of Track),
   *  no other fields are present. The prior Object is the last Object in its
   *  Group, or in the Track, respectively."
   * Serialization Flags だけを持つ indicator であり、直前の実 Object が
   * Group の最終 Object であることを示す。Group ID Delta / Object ID Delta などの
   * 追加フィールドを持たない。
   */
  END_OF_GROUP: 0x80,
  /**
   * End of Track (draft-ietf-moq-transport-23 §11.4.1 (Fetch Header) /
   * Table 8 / §11.4.2.2 (Prior Object Fields))
   *
   * draft-ietf-moq-transport-23 §11.4.2.2:
   * "The prior Object is the last Object in its Group, or in the Track,
   *  respectively. End of Track also indicates End of Group."
   * Serialization Flags だけを持つ indicator であり、直前の実 Object が
   * Track の最終 Object であることを示す。Group の終端も意味する。
   */
  END_OF_TRACK: 0x81,

  /**
   * End of Non-Existent Range (draft-ietf-moq-transport-23 §11.4.2)
   *
   * draft-ietf-moq-transport-23 §11.4.2:
   * 指定した Location までの Object が存在しないことを示す。
   * Group ID Delta と Object ID Delta フィールドが常に存在する
   * (FETCH_HEADER 直後の先頭エントリーでは絶対値、それ以外は delta)。
   * Subgroup ID, Priority, Properties は存在しない。
   *
   * publisher は Object を直列化しない範囲を分割する目的以外で End of Non-Existent
   * Range を使うべきではない (§3.2.2 の SHOULD NOT)。
   */
  END_OF_NON_EXISTENT_RANGE: 0x8c,
  /**
   * End of Unknown Range (draft-ietf-moq-transport-23 §11.4.2)
   *
   * draft-ietf-moq-transport-23 §11.4.2:
   * 指定した Location までの Object のステータスが不明であることを示す。
   * Group ID Delta と Object ID Delta フィールドが常に存在する
   * (FETCH_HEADER 直後の先頭エントリーでは絶対値、それ以外は delta)。
   * Subgroup ID, Priority, Properties は存在しない。
   */
  END_OF_UNKNOWN_RANGE: 0x10c,
  /**
   * End of Timed-Out Range (draft-ietf-moq-transport-23 §11.4.2)
   *
   * draft-ietf-moq-transport-23 §11.4.2:
   * Fill Timeout の失効により放棄された Object の範囲を示す。
   * Group ID Delta と Object ID Delta フィールドが常に存在する
   * (FETCH_HEADER 直後の先頭エントリーでは絶対値、それ以外は delta)。
   * Subgroup ID, Priority, Properties は存在しない。
   */
  END_OF_TIMED_OUT_RANGE: 0x20c,
  /**
   * End of Gone Range (draft-ietf-moq-transport-23 §11.4.2)
   *
   * draft-ietf-moq-transport-23 §11.4.1 (Fetch Header) / Table 8 / §11.4.2 / §2.1.2:
   * 元の publisher が配送できず、Object の存在も知らない範囲を示す。
   * Group ID Delta と Object ID Delta フィールドが常に存在する
   * (FETCH_HEADER 直後の先頭エントリーでは絶対値、それ以外は delta)。
   * Subgroup ID, Priority, Properties は存在しない。
   *
   * Unknown / Timed-Out / Non-Existent と区別する。§2.1.2 のとおり Gone は
   * 「存在しない」の断定ではなく、別の配信元が Object を保持している可能性が
   * あるため、Gone と記録した位置に実 Object が後から届いても矛盾ではない。
   * このモジュールは範囲の種別を復号して返すだけで、End of Range の範囲の保存・
   * 突き合わせは行わない (未実装)。
   */
  END_OF_GONE_RANGE: 0x40c,
} as const;

/**
 * Fetch Object Fields (Figure 29 in Section 11.4.1)
 */
// draft-ietf-moq-transport-22 Section 11.1.1:
// "The Object Status is a field that is only present in objects that are
// delivered via a SUBSCRIPTION, and is absent in Objects delivered via a FETCH."
export interface FetchObjectFields {
  serializationFlags: number;
  groupId?: bigint;
  subgroupId?: bigint;
  /**
   * Object ID。
   *
   * draft-ietf-moq-transport-23 §11.4.1.1:
   * 通常 Object では OBJECT_ID_PRESENT が立つ場合だけ wire に書かれ、Group ID
   * Delta が無ければ prior Object ID + Object ID Delta + 2、Group ID Delta が
   * あれば絶対値として復号される。OBJECT_ID_PRESENT が立たない場合は Group ID
   * Delta の有無に関わらず prior Object ID + 1 として復号されるため、指定する
   * ならその値でなければならない (encodeFetchObjectFields が非先頭で送信前に
   * 検証する)。先頭 Object は createFirstFetchObjectFlags が両フラグを立てる。
   * End of Range indicator では §11.4.2.1 の別規則により、フラグに関係なく
   * Group ID とともに常に書かれる。先頭エントリーなら絶対値、それ以外は
   * 直前の Object / indicator に対する delta (Group ID Delta が 0 なら
   * prior + Object ID Delta + 1、非 0 なら絶対値) である。
   */
  objectId?: bigint;
  publisherPriority?: number;
  properties?: Uint8Array;
  /**
   * Object Payload Length。
   *
   * draft-ietf-moq-transport-23 §11.4.1 (Fetch Header) / Figure 29:
   * 通常 Object のフィールドであり、End of Range / End of Group / End of Track の
   * indicator の wire には存在しない。これらの indicator では無視される。
   */
  payloadLength: bigint;
  payload?: Uint8Array;
}

/**
 * End of Range の種別
 *
 * draft-ietf-moq-transport-23 §3.2.2 (Gaps in a Fetch Stream) / §11.4.2:
 * FETCH レスポンス内で Object が存在しない/不明/タイムアウト失効した/Gone の
 * 範囲を示す。ギャップは「Object が存在しない」「subscriber のフィルタで除外された」
 * 「状態を判定できない (リレーが一時的に Original Publisher と遮断された場合など)」
 * で起こり、デフォルトと異なる原因の範囲が End of Range indicator でマークされる。
 *
 * draft-ietf-moq-transport-23 §2.1.2: "gone" は元の publisher が配送できず、
 * Object の存在も知らない状態であり、"non_existent" (存在しない) とは異なる。
 * Gone / Unknown と記録した位置に実 Object が後から届いても矛盾ではない。
 */
export type EndOfRangeType = "non_existent" | "unknown" | "timed_out" | "gone";

/**
 * End of Range indicator の Serialization Flags と種別の対応
 *
 * 判定 (isEndOfRangeFlags) と種別変換の両方をこの 1 つの表から導き、追加時に
 * 片方だけ更新して未知の種別が "unknown" に落ちるのを防ぐ。
 */
const END_OF_RANGE_TYPES: ReadonlyMap<number, EndOfRangeType> = new Map<number, EndOfRangeType>([
  [FetchSerializationFlags.END_OF_NON_EXISTENT_RANGE, "non_existent"],
  [FetchSerializationFlags.END_OF_UNKNOWN_RANGE, "unknown"],
  [FetchSerializationFlags.END_OF_TIMED_OUT_RANGE, "timed_out"],
  [FetchSerializationFlags.END_OF_GONE_RANGE, "gone"],
]);

/**
 * End of Group / End of Track indicator の種別
 *
 * draft-ietf-moq-transport-23 §11.4.1 (Fetch Header) / Table 8 / §11.4.2.2:
 * 0x80 は End of Group、0x81 は End of Track である。End of Track は
 * Group の終端も意味する。
 */
export type FetchStreamEndKind = "end_of_group" | "end_of_track";

/**
 * End of Group / End of Track indicator が示す終端
 *
 * draft-ietf-moq-transport-23 §11.4.2.2 (Prior Object Fields):
 * "The prior Object is the last Object in its Group, or in the Track,
 *  respectively."
 * indicator 自身は追加フィールドを持たず ID を持たないため、終端となる
 * 実 Object の位置を最後の実 Object の保持値から求めて格納する。算術用の
 * prior Object ID (受理後は 2^64-1) や End of Range の範囲端を終端位置として
 * 使わない。
 */
export interface FetchStreamEnd {
  /** End of Group (0x80) か End of Track (0x81) か */
  kind: FetchStreamEndKind;
  /** 終端となる直前の実 Object の Group ID */
  groupId: bigint;
  /** 終端となる直前の実 Object の Object ID */
  objectId: bigint;
}

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
   * draft-ietf-moq-transport-23 §11.4.2 は End of Range / End of Group /
   * End of Track indicator のフィールドについて Object Payload Length を明文で
   * 挙げていないが、通常 Object の形式 (Figure 29) との対比から持たないものとして
   * 扱うため、indicator の場合は 0n。
   */
  payloadLength: bigint;
  /**
   * End of Range indicator (draft-ietf-moq-transport-23 §11.4.2)
   *
   * 設定されている場合、この Object は実際のデータではなく
   * 指定した Location までの範囲を示す End of Range indicator。
   * "gone" は §2.1.2 の Gone 状態を示し、その後の実 Object の受信を
   * 矛盾としない。
   */
  endOfRange?: EndOfRangeType;
  /**
   * End of Group / End of Track indicator (draft-ietf-moq-transport-23 §11.4.2.2)
   *
   * 設定されている場合、このエントリーは実 Object ではなく、直前の実 Object を
   * Group (0x80) または Track (0x81) の終端として宣言する indicator である。
   * groupId / objectId は indicator が参照する最後の実 Object の位置であり、
   * 算術用の prior Object ID ではない。End of Range indicator とは異なり、
   * 追加フィールドを持たないため payloadLength は常に 0n である。
   */
  streamEnd?: FetchStreamEnd;
}

/**
 * Context for decoding Fetch Objects (tracks prior object's values)
 *
 * draft-ietf-moq-transport-23 §11.4.2.1:
 * "the prior Group ID and prior Object ID are the decoded IDs of the most recent
 *  preceding Object or End of Range indicator."
 * このため groupId / objectId は実 Object だけでなく End of Range indicator の
 * 復号値でも更新する。一方、subgroupId と publisherPriority は
 * §11.4.2.2 の "the last actual Object before the End of Range indicator" に
 * 従い、実 Object でのみ更新する (indicator は引き継ぐ)。
 */
export interface FetchObjectContext {
  /**
   * 直前の Object / indicator の復号済み Group ID (§11.4.2.1 の prior Group ID)
   *
   * End of Group / End of Track indicator の受理では変更しない (§11.4.2.2)。
   */
  groupId: bigint;
  /**
   * 直前の実 Object の Subgroup ID
   *
   * draft-ietf-moq-transport-23 §11.4.2.2: End of Range indicator の後の
   * Object が prior Subgroup ID を参照する場合、対象は indicator より前の
   * 最後の実 Object の Subgroup ID である。Datagram は Subgroup ID を
   * 持たないため、直前の Subgroup オブジェクトの値を保持する。
   */
  subgroupId: bigint;
  /**
   * 直前の Object / indicator の復号済み Object ID (§11.4.2.1 の prior Object ID)
   *
   * End of Range indicator では復号値、End of Group / End of Track indicator の
   * 受理後は §11.4.2.2 により 2^64-1 (算術上限) になる。終端となる実 Object の
   * 位置は lastActualObject が保持する。
   */
  objectId: bigint;
  /**
   * 直近の実オブジェクト (Datagram を含む) の Publisher Priority。
   * draft-ietf-moq-transport-22 §11.4.1.1 Table 10 の「Priority is the prior
   * Object's Priority」の規定に従い、0x10 省略時の継承値に使う (prior Object
   * には Datagram も含まれる)。
   */
  publisherPriority: number;
  /**
   * 直近の Subgroup オブジェクトの Publisher Priority。
   * draft-ietf-moq-transport-22 §12.1 の比較対象
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
   * draft-ietf-moq-transport-23 §11.4.2.2 (Prior Object Fields):
   * "Prior Subgroup ID: The Subgroup ID from the last actual Object before the
   *  End of Range indicator. If there was no prior Object, an endpoint that
   *  receives a flag referencing the prior Subgroup ID MUST close the session
   *  with MALFORMED_OBJECT."
   * "Prior Priority: The Priority from the last actual Object before the End
   *  of Range indicator. If there was no prior Object, an endpoint that receives
   *  a flag referencing the prior Priority MUST close the session with
   *  MALFORMED_OBJECT."
   * End of Range indicator 自体は実 Object ではないため、先頭レコードが
   * End of Range の場合は false を引き継ぎ、後続 Object が prior Subgroup ID /
   * prior Priority を参照したら MALFORMED_OBJECT で拒否する (§11.4.2.2)。
   * optional (undefined) は「先行する実 Object あり」として扱う
   * (ハードコードされたテストコンテキストとの互換)。
   */
  hasPriorActualObject?: boolean;
  /**
   * 最後に受信した実 Object の位置
   *
   * draft-ietf-moq-transport-23 §11.4.2.2 (Prior Object Fields):
   * "The prior Object is the last Object in its Group, or in the Track,
   *  respectively."
   * End of Group / End of Track indicator は追加フィールドを持たないため、終端と
   * なる実 Object の位置をここから取る。groupId / objectId は End of Range
   * indicator でも更新される算術用の prior であり、indicator や連続する終端
   * indicator を挟むと最後の実 Object の位置ではなくなるため、別に保持する。
   * End of Range / End of Group / End of Track では更新せず引き継ぐ。
   * optional (undefined) は「実 Object の位置を保持していない」ことを表し、
   * ハードコードされたテストコンテキストとの互換のため許容する。この場合
   * 終端 indicator は参照先を解決できないため拒否する。
   */
  lastActualObject?: { groupId: bigint; objectId: bigint };
  /**
   * 直前にシリアライズされたエントリー (実 Object または End of Range indicator) の位置
   *
   * draft-ietf-moq-transport-23 §3.2.2 (Gaps in a Fetch Stream):
   * 暗黙 gap は「直前のエントリーの次」から「次のエントリーの前」までであり、
   * ストリーム末尾では「最後のエントリーの次」から End Location までである。
   * その開始位置を決めるために、実 Object は自身の位置、End of Range indicator は
   * 復号した位置で更新する。End of Group / End of Track indicator は自身の位置を
   * 持たないため、直前の実 Object の位置を引き継ぐ。
   * lastActualObject と異なり、End of Range indicator でも更新される。
   * optional (undefined) は「まだ 1 件もシリアライズされていない」ことを表し、
   * ハードコードされたテストコンテキストとの互換のため許容する。
   */
  lastSerializedLocation?: { groupId: bigint; objectId: bigint };
  /**
   * 現在の Group 内の Subgroup ID ごとの直近の Publisher Priority。
   * draft-ietf-moq-transport-22 §12.1 の比較対象
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
 * 送信する Object ID が varint の範囲 (0 以上 2^64-1 以下) かを検証する
 *
 * 通常 Object と End of Range indicator の両方の送信前検証で使う。受信側では
 * 上限超過を DELTA_ENCODING_OVERFLOW として拒否する (§11.4.1.1 / §11.4.2.1) が、
 * この関数は送信側のため受信側の分類には関与せず plain Error を投げる
 * (ローカル API の誤用を表す)。
 *
 * @throws Error 範囲外の場合
 */
function validateObjectIdRange(objectId: bigint): void {
  if (objectId < 0n || objectId > MAX_VARINT) {
    throw new Error(`object id out of range: ${objectId}, expected 0 to 2^64-1`);
  }
}

/**
 * Serialization Flags が End of Range (draft-ietf-moq-transport-23 §11.4.2) かを判定する
 *
 * draft-ietf-moq-transport-23 §11.4.1 (Fetch Header) / Table 8:
 * 0x8C (End of Non-Existent Range) / 0x10C (End of Unknown Range) /
 * 0x20C (End of Timed-Out Range) / 0x40C (End of Gone Range) が定義されている。
 * これらは Object ではなく範囲 indicator であり、Group ID Delta / Object ID Delta
 * だけを持つ。§11.4.2 は Subgroup ID / Priority / Properties を持たないと明記し、
 * Object Payload Length には触れていないが、通常 Object の形式 (Figure 29) との
 * 対比から持たないものとして扱う。
 */
function isEndOfRangeFlags(flags: number): boolean {
  return END_OF_RANGE_TYPES.has(flags);
}

/**
 * End of Group / End of Track indicator の Serialization Flags と種別の対応
 *
 * draft-ietf-moq-transport-23 §11.4.1 (Fetch Header) / Table 8 / §11.4.2.2:
 * どちらも追加フィールドを持たない indicator である。判定と種別変換を同じ表から
 * 導き、追加時に片方だけ更新して未知の種別に落ちるのを防ぐ
 * (END_OF_RANGE_TYPES と同じ形)。
 */
const FETCH_STREAM_END_KINDS: ReadonlyMap<number, FetchStreamEndKind> = new Map<
  number,
  FetchStreamEndKind
>([
  [FetchSerializationFlags.END_OF_GROUP, "end_of_group"],
  [FetchSerializationFlags.END_OF_TRACK, "end_of_track"],
]);

/**
 * End of Range indicator の Group ID Delta / Object ID Delta をエンコードする
 *
 * draft-ietf-moq-transport-23 §11.4.2.1 (ID Decoding):
 * - FETCH_HEADER 直後の先頭エントリー (context なし) は両方とも絶対値。
 * - それ以外の Group ID は prior Group ID に Group ID Delta を加算 (Ascending)
 *   または減算 (Descending) した値である。通常 Object の Group ID Delta が
 *   表す +1 は End of Range には無い。
 * - Group ID Delta が 0 のときの Object ID は prior Object ID +
 *   Object ID Delta + 1 である (通常 Object の +2 ではない)。
 * - Group ID Delta が非 0 のときの Object ID Delta は新しい Group の絶対
 *   Object ID である。
 *
 * 受信側の式と対称になるよう、送信できない組み合わせ (Group Order と逆方向の
 * Group 移動、同一 Group で増分 1 未満の Object ID) は送信前に拒否する。
 */
function encodeEndOfRangeIds(
  groupId: bigint,
  objectId: bigint,
  context: FetchObjectContext | null,
  groupOrder: GroupOrder,
): Uint8Array[] {
  if (groupId < 0n || groupId > MAX_VARINT) {
    throw new Error(`group id out of range: ${groupId}, expected 0 to 2^64-1`);
  }
  validateObjectIdRange(objectId);

  // FETCH_HEADER 直後の先頭エントリーは Group ID / Object ID とも絶対値
  if (context === null) {
    return [encodeVarint(groupId), encodeVarint(objectId)];
  }

  const groupDelta =
    groupOrder === GroupOrder.DESCENDING ? context.groupId - groupId : groupId - context.groupId;
  if (groupDelta < 0n) {
    throw new Error(
      `end of range group id delta cannot be negative: current=${groupId}, ` +
        `prior=${context.groupId}, groupOrder=${groupOrder === GroupOrder.DESCENDING ? "descending" : "ascending"}`,
    );
  }

  if (groupDelta === 0n) {
    const objectDelta = objectId - context.objectId - 1n;
    if (objectDelta < 0n) {
      throw new Error(
        `end of range object id delta cannot represent object id: current=${objectId}, ` +
          `prior=${context.objectId}, expected current >= prior + 1 when group id delta is 0`,
      );
    }
    return [encodeVarint(groupDelta), encodeVarint(objectDelta)];
  }

  // Group が変わるときの Object ID Delta は新しい Group の絶対 Object ID
  return [encodeVarint(groupDelta), encodeVarint(objectId)];
}

/**
 * Encode Fetch Object Fields
 * draft-ietf-moq-transport-23 §11.4.1 Figure 29
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
  // draft-ietf-moq-transport-22: vi64 としてエンコード
  parts.push(encodeVarint(fields.serializationFlags));

  // End of Group / End of Track は Serialization Flags だけを持つ indicator である
  // (draft-ietf-moq-transport-23 §11.4.2.2 "no other fields are present")。
  // 受信側の decodeFetchObjectFields と対称になるよう、他のフィールドを書かない。
  if (FETCH_STREAM_END_KINDS.has(fields.serializationFlags)) {
    return concatUint8Arrays(parts);
  }

  // End of Range の場合は Group ID Delta と Object ID Delta のみ
  // draft-ietf-moq-transport-23 §11.4.2:
  // End of Range indicator は通常 Object と異なり Subgroup ID / Priority /
  // Properties / Object Payload Length / Object Payload を持たない。
  // Group ID Delta と Object ID Delta は常に存在し、先頭エントリーなら絶対値、
  // それ以外は直前の Object / indicator を基準にした delta である
  // (§11.4.2.1)。FetchObjectFields.payloadLength は通常 Object 用であり、
  // ここでは wire に書かない。
  if (isEndOfRangeFlags(fields.serializationFlags)) {
    if (fields.groupId === undefined || fields.objectId === undefined) {
      throw new Error("Group ID and Object ID required for End of Range");
    }
    parts.push(...encodeEndOfRangeIds(fields.groupId, fields.objectId, context, groupOrder));

    return concatUint8Arrays(parts);
  }

  // Group ID (フラグ 0x08 がセットされている場合)
  // draft-ietf-moq-transport-22 §11.4.1.1 Table 10:
  // "If the Group Order is Ascending, the Group ID is the prior Object's
  //  Group ID plus the Group ID Delta + 1."
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
  // draft-ietf-moq-transport-22 §11.4.1.1:
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
  // draft-ietf-moq-transport-23 §11.4.1.1:
  // "When the Group ID Delta field is present, the Object ID is the value of
  //  Object ID Delta if present. When the Group ID Delta field is not present,
  //  the Object ID is the prior Object's ID plus the Object ID Delta + 2 if
  //  present. If Object ID Delta is not present, the Object ID is the prior
  //  Object's ID plus one, regardless of which group it belongs to."
  // エンコード時:
  //   - Group 不変 (!GROUP_ID_PRESENT) かつ context あり:
  //       delta = currentObjectId - priorObjectId - 2n
  //     明示 Delta は prior + 2 以上の増分だけを表せる。増分 1 は Delta 省略
  //     (prior + 1) で表すため、増分 0 / 1 を明示 Delta で送ろうとした場合は
  //     送信前に拒否する。
  //   - それ以外 (先頭または Group 変化): delta は絶対値。Delta 省略時は
  //     Group ID Delta の有無に関わらず prior + 1 である。
  // Object ID は varint の範囲 (0 以上 2^64-1 以下) でなければならない。
  // 受信側は上限超過を DELTA_ENCODING_OVERFLOW として拒否する (§11.4.1.1)。
  // フラグの有無に関わらず、指定された Object ID は送信前に検証する。
  if (fields.objectId !== undefined) {
    validateObjectIdRange(fields.objectId);
  }
  if (fields.serializationFlags & FetchSerializationFlags.OBJECT_ID_PRESENT) {
    if (fields.objectId === undefined) {
      throw new Error("Object ID required when OBJECT_ID_PRESENT flag is set");
    }
    if (
      !(fields.serializationFlags & FetchSerializationFlags.GROUP_ID_PRESENT) &&
      context !== null
    ) {
      const delta = fields.objectId - context.objectId - 2n;
      if (delta < 0n) {
        throw new Error(
          `object id delta cannot represent increment: current=${fields.objectId}, ` +
            `prior=${context.objectId}, expected current >= prior + 2 when OBJECT_ID_PRESENT is set ` +
            `(increment 0 cannot be represented; increment 1 omits OBJECT_ID_PRESENT)`,
        );
      }
      parts.push(encodeVarint(delta));
    } else {
      parts.push(encodeVarint(fields.objectId));
    }
  } else if (context !== null) {
    // Delta 省略時は Group ID Delta の有無に関わらず prior Object ID + 1 で復号
    // される (§11.4.1.1)。暗黙の +1 が 2^64-1 を超える場合は受信側が
    // DELTA_ENCODING_OVERFLOW で拒否するため、送信前に拒否する。
    const impliedObjectId = context.objectId + 1n;
    if (impliedObjectId > MAX_VARINT) {
      throw new Error(
        `object id overflow when OBJECT_ID_PRESENT is not set: prior=${context.objectId}, ` +
          `implied=${impliedObjectId} exceeds 2^64-1`,
      );
    }
    // 指定された Object ID と一致しない場合は、要求した ID と異なる ID を
    // 送ることになるため送信前に拒否する。
    if (fields.objectId !== undefined && fields.objectId !== impliedObjectId) {
      throw new Error(
        `object id mismatch when OBJECT_ID_PRESENT is not set: current=${fields.objectId}, ` +
          `prior=${context.objectId}, expected ${impliedObjectId}`,
      );
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

  // draft-ietf-moq-transport-22 Section 11.1.1:
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
 * draft-ietf-moq-transport-23 §11.4.2 (End of Range) / §11.4.2.1 (ID Decoding):
 * Group ID Delta と Object ID Delta のみが存在し、Subgroup ID / Priority /
 * Properties は持たない (§11.4.2)。Object Payload Length も同節に明文は無いが、
 * 通常 Object の形式 (Figure 29) との対比から持たないものとして扱う。
 * FETCH_HEADER 直後の先頭エントリーだけが両方とも絶対 ID で、それ以外は
 * 直前の Object または直前の End of Range indicator の復号値を基準にした delta
 * である。
 * 先頭エントリーかどうかは context が null かで判定する (processFetchObjects は
 * isFirst と context を同時に管理しており、両者は一致する)。
 */
function decodeEndOfRange(
  data: Uint8Array,
  startOffset: number,
  endOfRange: EndOfRangeType,
  context: FetchObjectContext | null,
  groupOrder: GroupOrder,
): [DecodedFetchObject, number, FetchObjectContext] {
  let consumed = 0;

  const [groupIdDelta, gidConsumed] = decodeVarint(data, startOffset + consumed);
  consumed += gidConsumed;

  const [objectIdDelta, oidConsumed] = decodeVarint(data, startOffset + consumed);
  consumed += oidConsumed;

  let groupId: bigint;
  let objectId: bigint;
  if (context === null) {
    // §11.4.2.1: FETCH_HEADER 直後の先頭エントリーは両フィールドが絶対 ID
    groupId = groupIdDelta;
    objectId = objectIdDelta;
  } else {
    // §11.4.2.1: Group ID は Ascending なら prior + Group ID Delta、Descending なら
    // prior - Group ID Delta である。通常 Object の Group ID Delta が表す +1 は
    // End of Range indicator には無い (§11.4.1.1 と同じ式にしない)。
    groupId =
      groupOrder === GroupOrder.DESCENDING
        ? context.groupId - groupIdDelta
        : context.groupId + groupIdDelta;
    if (groupIdDelta === 0n) {
      // §11.4.2.1: Group ID Delta が 0 のときの Object ID は
      // prior Object ID + Object ID Delta + 1 である (通常 Object の +2 ではない)。
      objectId = context.objectId + objectIdDelta + 1n;
    } else {
      // §11.4.2.1: Group が変わるときの Object ID Delta は新しい Group の
      // 絶対 Object ID である。
      objectId = objectIdDelta;
    }
  }

  // §11.4.2.1: "If either decoded ID is less than zero or greater than 2^64-1,
  // the Subscriber MUST close the Session with DELTA_ENCODING_OVERFLOW."
  // 負数は Descending の減算でのみ生じ、上限超過は Ascending の Group 加算と
  // 同一 Group の prior + Object ID Delta + 1 の加算で生じる。
  if (groupId < 0n || groupId > MAX_VARINT) {
    throw new ProtocolViolationError(
      `computed end of range group id out of range: ${groupId}, expected 0 to 2^64-1`,
      SessionErrorCode.DELTA_ENCODING_OVERFLOW,
    );
  }
  if (objectId < 0n || objectId > MAX_VARINT) {
    throw new ProtocolViolationError(
      `computed end of range object id out of range: ${objectId}, expected 0 to 2^64-1`,
      SessionErrorCode.DELTA_ENCODING_OVERFLOW,
    );
  }

  // draft-ietf-moq-transport-23 §11.4.2 は End of Range indicator のフィールドとして
  // Group ID Delta と Object ID Delta だけを挙げ、Subgroup ID / Priority /
  // Properties を持たないと定める。Object Payload Length についての明文は無いが、
  // 通常 Object の形式 (Figure 29) と対比して持たないものとして扱う。
  // 呼び出し側 (processFetchObjects) が payload 0 バイトとして扱えるように 0n を返す。
  const payloadLength = 0n;

  // End of Range は直前の Object / indicator の復号位置を引き継ぎ、後続の
  // Object / indicator の ID 復元基準にする (§11.4.2.1)。
  // Group が変更された場合は先行する Subgroup オブジェクトの存在をリセットし、
  // 同一 Group 内の End of Range では引き継ぐ (後続の同一 Subgroup オブジェクトの
  // 比較対象が直前の Subgroup オブジェクトになり得るため)。
  // publisherPriority / subgroupPublisherPriority は End of Range の前の
  // 実オブジェクトの値を保持する (§11.4.2.2 の "The Priority from the last
  // actual Object before the End of Range indicator")。
  const sameGroup = context !== null && groupId === context.groupId;
  const inheritedPublisherPriority = context?.publisherPriority ?? 0;
  const newContext: FetchObjectContext = {
    groupId,
    subgroupId: context?.subgroupId ?? 0n,
    objectId,
    publisherPriority: inheritedPublisherPriority,
    subgroupPublisherPriority:
      context?.subgroupPublisherPriority ?? context?.publisherPriority ?? 0,
    hasPriorSubgroup: sameGroup ? (context?.hasPriorSubgroup ?? true) : false,
    // draft-ietf-moq-transport-23 §11.4.2.2:
    // End of Range indicator は実 Object ではないため、先行する実 Object の
    // 有無を引き継ぐ (先頭レコードが End of Range なら false)。
    hasPriorActualObject: context === null ? false : (context.hasPriorActualObject ?? true),
    // 最後の実 Object の位置も引き継ぐ。後続の End of Group / End of Track
    // indicator は、間に End of Range を挟んでもこの位置を終端として参照する
    // (§11.4.2.2)。
    ...(context?.lastActualObject !== undefined
      ? { lastActualObject: context.lastActualObject }
      : {}),
    // draft-ietf-moq-transport-23 §3.2.2:
    // 暗黙 gap の開始位置は「直前にシリアライズされたエントリーの次」である。
    // End of Range indicator は復号した位置をエントリーの位置として引き継ぐ。
    lastSerializedLocation: { groupId, objectId },
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
      publisherPriority: inheritedPublisherPriority,
      payloadLength,
      endOfRange,
    },
    consumed,
    newContext,
  ];
}

/**
 * End of Group (0x80) / End of Track (0x81) indicator をデコードする
 *
 * draft-ietf-moq-transport-23 §11.4.2.2 (Prior Object Fields):
 * "When Serialization Flags is 0x80 (End of Group) or 0x81 (End of Track),
 *  no other fields are present. The prior Object is the last Object in its
 *  Group, or in the Track, respectively. End of Track also indicates End of
 *  Group. The prior Object ID becomes 2^64-1."
 *
 * 追加フィールドを持たないため、消費するのは Serialization Flags だけである
 * (呼び出し元が Flags を読み終えた位置から呼び、追加の消費バイトは 0)。
 * 終端位置は算術用の prior Object ID からではなく、最後の実 Object の位置を
 * 保持した lastActualObject から取る。End of Range indicator や先の終端
 * indicator を挟んでいても参照先は最後の実 Object のままである。
 *
 * 受理後は後続エントリーの ID 復元に使う prior Object ID を 2^64-1 にする
 * (§11.4.2.2)。同節は「prior Object ID becomes 2^64-1」と Object ID だけを定め、
 * prior Group ID には触れていないため、Group ID は直前までの復号値を維持する。
 * このため Group ID Delta が非 0 の End of Range indicator を挟んだ場合、
 * 復号文脈の Group ID は EOR の復号値、終端位置 (lastActualObject) は最後の実
 * Object の Group になり、両者は一致しないことがある。EOG の直後に別 Group の
 * Object が続くのは正常な FETCH 応答であり、この差はそのまま許容される
 * (同じ Group の Object が続く場合だけが §12.1 条件 4 の malformed になる)。
 * End of Track は Group の終端も意味するが、どちらの値も lastActualObject から
 * 求められるため、ここでは種別だけを返して呼び出し側に委ねる。
 *
 * 前提となる実 Object を受信していない場合、存在しない prior Object への参照
 * として MALFORMED_OBJECT で拒否する (§12.2 の例)。
 *
 * @param kind - 復号した indicator の種別 (end_of_group / end_of_track)
 * @param context - 直前までの復号文脈 (実 Object の位置を保持している必要がある)
 */
function decodeFetchStreamEnd(
  kind: FetchStreamEndKind,
  context: FetchObjectContext | null,
): [DecodedFetchObject, FetchObjectContext] {
  // 実 Object を受信していれば lastActualObject が設定されている。ここでは
  // lastActualObject の有無だけを見る (hasPriorActualObject は End of Range の
  // prior Subgroup ID / Priority 判定に使う別の状態)。context === null の比較は
  // TypeScript の絞り込みに必要である。
  const lastActualObject = context?.lastActualObject;
  if (context === null || lastActualObject === undefined) {
    // 参照先の実 Object が無い終端 indicator を拒否する根拠:
    // draft-ietf-moq-transport-23 §11.4.2.2 は「prior Object は Group / Track の
    // 最後の Object」と定め、§12.2 (MALFORMED_OBJECT) は prior Object を参照する
    // フラグが存在しない Object を指す場合を例に挙げる。
    throw new ProtocolViolationError(
      `${kind === "end_of_track" ? "end of track" : "end of group"} indicator requires a prior actual object`,
      SessionErrorCode.MALFORMED_OBJECT,
    );
  }

  // draft-ietf-moq-transport-23 §11.4.2.2: "The prior Object ID becomes 2^64-1."
  // 後続エントリーが prior Object ID を参照した場合は 2^64-1 を使う。
  // 最後の実 Object の位置は終端の参照先として別に保持し続ける。
  const newContext: FetchObjectContext = {
    ...context,
    objectId: MAX_VARINT,
    hasPriorActualObject: true,
    lastActualObject,
  };

  return [
    {
      groupId: lastActualObject.groupId,
      subgroupId: context.subgroupId,
      objectId: lastActualObject.objectId,
      publisherPriority: context.publisherPriority,
      // indicator は Object Payload Length を持たないため 0
      payloadLength: 0n,
      streamEnd: {
        kind,
        groupId: lastActualObject.groupId,
        objectId: lastActualObject.objectId,
      },
    },
    newContext,
  ];
}

/**
 * Fetch Object の Subgroup ID をデコードする
 *
 * draft-ietf-moq-transport-22 §11.4.1.1 (Flags):
 * "When encoding an Object with a Delivery Mode of "Datagram" ... the object
 *  has no Subgroup ID. The publisher MUST SET bit 0x40 to '1'. When 0x40 is
 *  set, it SHOULD set the two least significant bits to zero and the subscriber
 *  MUST ignore the bits."
 *
 * Fetch Object には Delivery Mode が適用されない (§3.2.1)。DATAGRAM ビットは符号化の
 * 指示であり、「Subgroup ID フィールドを持たない」ことだけを表す。Delivery Mode の
 * 定義は §2.1.1 にある。
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

  // draft-ietf-moq-transport-22 §11.4.1.1:
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
        throw new ProtocolViolationError(
          "first object cannot use SUBGROUP_SAME",
          SessionErrorCode.MALFORMED_OBJECT,
        );
      }
      // draft-ietf-moq-transport-23 §11.4.2.2:
      // 先頭レコードが End of Range indicator の場合、参照できる prior Subgroup ID
      // (最後の実 Object の Subgroup ID) が存在しないため MALFORMED_OBJECT で
      // 拒否する (§11.4.2.2)。
      if (context.hasPriorActualObject === false) {
        throw new ProtocolViolationError(
          "cannot reference prior subgroup id before any actual object",
          SessionErrorCode.MALFORMED_OBJECT,
        );
      }
      return { subgroupId: context.subgroupId, isDatagram: false, consumed: 0 };
    case FetchSerializationFlags.SUBGROUP_PLUS_ONE:
      if (isFirst || context === null) {
        throw new ProtocolViolationError(
          "first object cannot use SUBGROUP_PLUS_ONE",
          SessionErrorCode.MALFORMED_OBJECT,
        );
      }
      // draft-ietf-moq-transport-23 §11.4.2.2: 同上 (prior Subgroup ID 参照)。
      if (context.hasPriorActualObject === false) {
        throw new ProtocolViolationError(
          "cannot reference prior subgroup id before any actual object",
          SessionErrorCode.MALFORMED_OBJECT,
        );
      }
      return { subgroupId: context.subgroupId + 1n, isDatagram: false, consumed: 0 };
    case FetchSerializationFlags.SUBGROUP_PRESENT: {
      const [sid, sidConsumed] = decodeVarint(data, offset);
      return { subgroupId: sid, isDatagram: false, consumed: sidConsumed };
    }
    default:
      throw new ProtocolViolationError(
        `invalid subgroup encoding: ${subgroupEncoding}`,
        SessionErrorCode.MALFORMED_OBJECT,
      );
  }
}

/**
 * 同一 Group・同一 Subgroup の直近の Subgroup オブジェクトとの Publisher
 * Priority の一致を検証する
 *
 * draft-ietf-moq-transport-22 §12.1 (Malformed Tracks):
 * "An Object with a particular Subgroup ID is received, but its Publisher
 *  Priority is different from that of the previous Object with the same
 *  Subgroup ID."
 * 同一 Group・同一 Subgroup 内のオブジェクトは同じ Publisher Priority を
 * 持つ必要がある。異なる Priority を検出した場合は MalformedTrackError を
 * throw する。上位ハンドラはこれを FETCH キャンセル (セッション終了ではない)
 * に変換する。
 *
 * 検出は Group スコープで行う。draft-ietf-moq-transport-22 §2.2:
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
 * draft-ietf-moq-transport-22 §12.1 (Malformed Tracks):
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
 * Priority は 8 bit 固定 (draft-ietf-moq-transport-22 §11.4.1.1) のため、
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
 * draft-ietf-moq-transport-22 §11.4.1.1 Table 10:
 * 0x10 未設定は「直近の実オブジェクト (Datagram を含む) の Priority を
 * 継承する」ことを意味する。
 *
 * draft-ietf-moq-transport-23 §11.4.2.2 (End of Range):
 * "Prior Priority: The Priority from the last actual Object before the End of
 *  Range indicator. If there was no prior Object, an endpoint that receives a
 *  flag referencing the prior Priority MUST close the session with
 *  MALFORMED_OBJECT."
 * 先頭オブジェクト (context null) と、先頭レコードが End of Range indicator で
 * 実 Object が 1 つも無い場合 (hasPriorActualObject === false) は継承元が無い
 * ため MALFORMED_OBJECT で拒否する (§11.4.2.2)。
 */
function resolvePriorFetchPublisherPriority(context: FetchObjectContext | null): number {
  if (context === null) {
    throw new ProtocolViolationError(
      "first object must have PRIORITY_PRESENT flag set",
      SessionErrorCode.MALFORMED_OBJECT,
    );
  }
  if (context.hasPriorActualObject === false) {
    throw new ProtocolViolationError(
      "cannot reference prior priority before any actual object",
      SessionErrorCode.MALFORMED_OBJECT,
    );
  }
  return context.publisherPriority;
}

/**
 * Decode Fetch Object Fields
 * draft-ietf-moq-transport-23 §11.4.1 Figure 29
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
  // draft-ietf-moq-transport-22: vi64 としてエンコードされる
  const [flagsRaw, flagsConsumed] = decodeVarint(data, offset + totalConsumed);
  const flags = Number(flagsRaw);
  totalConsumed += flagsConsumed;

  // End of Range チェック (draft-ietf-moq-transport-23 §11.4.2)
  // 種別の判定と変換は同じ END_OF_RANGE_TYPES から引き、decodeEndOfRange には
  // 確定した種別を渡す。
  const endOfRangeType = END_OF_RANGE_TYPES.get(flags);
  if (endOfRangeType !== undefined) {
    const [result, consumed, newContext] = decodeEndOfRange(
      data,
      offset + totalConsumed,
      endOfRangeType,
      context,
      groupOrder,
    );
    return [result, totalConsumed + consumed, newContext];
  }

  // End of Group / End of Track チェック (draft-ietf-moq-transport-23 §11.4.2.2)
  // 追加フィールドを持たない indicator であり、消費するのは Flags だけである。
  // 直前の実 Object の位置を終端として返し、後続の prior Object ID を 2^64-1 にする。
  // 種別の判定と変換は同じ FETCH_STREAM_END_KINDS から引き、decodeFetchStreamEnd には
  // 確定した種別を渡す (未知値を EOG に誤分類する余地を残さない)。
  const streamEndKind = FETCH_STREAM_END_KINDS.get(flags);
  if (streamEndKind !== undefined) {
    const [result, newContext] = decodeFetchStreamEnd(streamEndKind, context);
    return [result, totalConsumed, newContext];
  }

  // draft-ietf-moq-transport-23 §11.4.1 (Fetch Header) / Table 8:
  // "When less than 128, the bits represent flags described in Section 11.4.1.1.
  //  When 128 or greater, the value signals an indicator."
  // Table 8 の定義値は End of Non-Existent Range (0x8C) / End of Unknown Range
  // (0x10C) / End of Timed-Out Range (0x20C) / End of Gone Range (0x40C) /
  // End of Group (0x80) / End of Track (0x81) である。"If an endpoint receives any
  //  other value greater than 127, it MUST close the session with
  //  MALFORMED_OBJECT."
  // 定義値はすべて上の各チェックで処理済みであり、ここでは未定義の 128 以上の値
  // として MALFORMED_OBJECT で拒否する (§11.4.1 Table 8)。
  if (flags >= 128) {
    throw new ProtocolViolationError(
      `invalid fetch serialization flags: 0x${flags.toString(16)}, expected flags < 128, 0x8C, 0x10C, 0x20C, 0x40C, 0x80, or 0x81`,
      SessionErrorCode.MALFORMED_OBJECT,
    );
  }

  // Group ID
  // draft-ietf-moq-transport-23 §11.4.1.1 Table 10:
  // Ascending: "The Group ID is the prior Object's Group ID plus the Group ID Delta + 1."
  // Descending: "The Group ID is the prior Object's Group ID minus the (Group ID Delta + 1)."
  // "If the computed Group ID would be less than 0 or greater than 2^64-1, the
  //  Subscriber MUST close the Session with error 'DELTA_ENCODING_OVERFLOW'."
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
      throw new ProtocolViolationError(
        "first object must have GROUP_ID_PRESENT flag set",
        SessionErrorCode.MALFORMED_OBJECT,
      );
    }
    groupId = context.groupId;
  }

  // Group ID の範囲検証: 0 以上 2^64-1 以下
  // draft-ietf-moq-transport-23 §11.4.1.1:
  // "If the computed Group ID would be less than 0 or greater than 2^64-1,
  //  the Subscriber MUST close the Session with DELTA_ENCODING_OVERFLOW."
  // 上限は varint の最大値と同一のため MAX_VARINT を使う。
  if (groupId < 0n || groupId > MAX_VARINT) {
    throw new ProtocolViolationError(
      `computed group id out of range: ${groupId}, expected 0 to 2^64-1`,
      SessionErrorCode.DELTA_ENCODING_OVERFLOW,
    );
  }

  // Subgroup ID をデコード（DATAGRAM フラグの処理を含む）
  const {
    subgroupId,
    isDatagram,
    consumed: subgroupConsumed,
  } = decodeFetchSubgroupId(data, flags, offset + totalConsumed, isFirst, context);
  totalConsumed += subgroupConsumed;

  // Object ID
  // draft-ietf-moq-transport-23 §11.4.1.1:
  // "When the Group ID Delta field is present, the Object ID is the value of
  //  Object ID Delta if present. When the Group ID Delta field is not present,
  //  the Object ID is the prior Object's ID plus the Object ID Delta + 2 if
  //  present. If Object ID Delta is not present, the Object ID is the prior
  //  Object's ID plus one, regardless of which group it belongs to."
  // 先頭 Object は Group ID Delta と Object ID Delta を必ず持ち、両方とも絶対値。
  // Group 変化時 (GROUP_ID_PRESENT) に Object ID Delta があれば絶対値。
  // Group 不変時の Object ID Delta は prior + delta + 2 を指す。Delta 省略時は
  // Group ID Delta の有無に関わらず prior + 1。End of Range indicator の ID は
  // §11.4.2.1 の別式であり、この +2 を共通化しない。
  let objectId: bigint;
  if (flags & FetchSerializationFlags.OBJECT_ID_PRESENT) {
    const [delta, deltaConsumed] = decodeVarint(data, offset + totalConsumed);
    if (!(flags & FetchSerializationFlags.GROUP_ID_PRESENT) && context !== null) {
      objectId = context.objectId + delta + 2n;
    } else {
      objectId = delta;
    }
    totalConsumed += deltaConsumed;
  } else {
    if (isFirst || context === null) {
      throw new ProtocolViolationError(
        "first object must have OBJECT_ID_PRESENT flag set",
        SessionErrorCode.MALFORMED_OBJECT,
      );
    }
    objectId = context.objectId + 1n;
  }

  // Object ID の範囲検証: 0 以上 2^64-1 以下
  // draft-ietf-moq-transport-23 §11.4.1.1:
  // "If the computed Object ID would be greater than 2^64-1, the Subscriber
  //  MUST close the Session with DELTA_ENCODING_OVERFLOW."
  // 上限は varint の最大値と同一のため MAX_VARINT を使う。
  if (objectId > MAX_VARINT) {
    throw new ProtocolViolationError(
      `computed object id out of range: ${objectId}, expected 0 to 2^64-1`,
      SessionErrorCode.DELTA_ENCODING_OVERFLOW,
    );
  }

  // Publisher Priority
  let publisherPriority: number;
  if (flags & FetchSerializationFlags.PRIORITY_PRESENT) {
    publisherPriority = readFetchObjectPublisherPriority(data, offset + totalConsumed);
    totalConsumed += 1;

    checkSubgroupPriorityMismatch(context, isDatagram, groupId, subgroupId, publisherPriority);
  } else {
    // draft-ietf-moq-transport-22 §11.4.1.1 Table 10:
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
      // draft-ietf-moq-transport-22 Section 11.4.1.1:
      // 節番号は仕様将来版で変わる可能性がある。
      const propertiesLength = Number(extLen);
      if (offset + totalConsumed + propertiesLength > data.length) {
        throw new IncompleteDataError("incomplete fetch object fields: properties");
      }
      properties = data.slice(offset + totalConsumed, offset + totalConsumed + propertiesLength);
      totalConsumed += propertiesLength;

      // draft-ietf-moq-transport-22 §3.7:
      // Mandatory Track Property を Object Property として含む Object は malformed
      assertNoMandatoryTrackPropertyInObjectProperties(properties);
      // draft-ietf-moq-transport-22 §8.3:
      // 既知 Type の Value が serialization に一致しない場合は
      // MALFORMED_KEY_VALUE でセッションを閉じる
      assertKnownPropertyValueInObjectProperties(properties);

      // draft-ietf-moq-transport-22 §10.8 / §10.9:
      // Prior Group ID Gap / Prior Object ID Gap のうち単一 Object で判定できる
      // malformed 条件 (gap が Group ID / Object ID より大きい) を検証する。
      assertPriorIdGapInObjectProperties(groupId, objectId, properties);
    }
  }

  // Object Payload Length
  const [payloadLength, payloadLenConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += payloadLenConsumed;

  // draft-ietf-moq-transport-22 Section 11.1.1:
  // "The Object Status is a field that is only present in objects that are
  // delivered via a SUBSCRIPTION, and is absent in Objects delivered via a FETCH."
  // Fetch Object には Object Status は存在しない

  // 次のオブジェクトのためにコンテキストを更新
  // Datagram オブジェクトは Subgroup ID を持たないため、
  // コンテキストには Datagram 以前の実際の Subgroup ID を伝搬させる。
  // publisherPriority は直近の実オブジェクトの値として全オブジェクトで更新する
  // (§11.4.1.1 Table 10 の 0x10 省略時の継承値)。§12.1 比較専用の
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
    // prior Priority 参照は常に有効になる (§11.4.2.2)。
    hasPriorActualObject: true,
    // draft-ietf-moq-transport-23 §11.4.2.2: End of Group / End of Track
    // indicator は追加フィールドを持たず、直前の実 Object を終端として参照する。
    // End of Range indicator は算術用の prior を更新するが実 Object ではないため、
    // 終端の参照先として使える最後の実 Object の位置を別に保持する。
    lastActualObject: { groupId, objectId },
    // draft-ietf-moq-transport-23 §3.2.2:
    // 暗黙 gap の開始位置となる「直前にシリアライズされたエントリーの位置」。
    // 実 Object では自身の位置になる。
    lastSerializedLocation: { groupId, objectId },
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
 * draft-ietf-moq-transport-23 §11.4.1.1:
 * "The first Object MUST include a Group ID Delta and Object ID Delta, and
 *  these values are the absolute Group ID and Object ID."
 *
 * @param hasExtensions - Whether the object has extension properties
 * @param isDatagram - Whether the DATAGRAM bit (0x40) is set (no Subgroup ID)
 */
export function createFirstFetchObjectFlags(hasExtensions = false, isDatagram = false): number {
  let flags =
    FetchSerializationFlags.GROUP_ID_PRESENT |
    FetchSerializationFlags.OBJECT_ID_PRESENT |
    FetchSerializationFlags.PRIORITY_PRESENT;

  if (isDatagram) {
    // Datagram 時は Subgroup ID フィールドなし、DATAGRAM ビットを設定
    // draft-ietf-moq-transport-22 §11.4.1.1:
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
 *
 * draft-ietf-moq-transport-23 §11.4.1.1:
 * Group ID Delta が無い場合の Object ID は prior Object ID + Object ID Delta + 2
 * であり、Delta 省略時は prior Object ID + 1 である。Group ID Delta の有無は
 * Object ID の +1 の式に影響しない。
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
  // 増分 1 は Group の有無に関わらず Delta 省略 (prior + 1) で表すため、
  // そのときだけ OBJECT_ID_PRESENT を立てない。同一 Group で増分 2 以上は
  // 明示 Delta (増分 - 2) で表し、Group 変更時に明示する場合は絶対 Object ID を
  // 書く。増分 0 以下は同一 Group 内で Object ID が増加しない不正な状態であり、
  // Delta でも表現できないため、ここでは OBJECT_ID_PRESENT を立てて
  // encodeFetchObjectFields の送信前検証に委ねる。
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
