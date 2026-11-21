/**
 * MOQT Session のデータストリーム処理
 *
 * SessionImpl から抽出した受信データストリームの処理。
 * 統計更新や handleObject 呼び出しはコールバック経由で行う。
 */

import type {
  FetchObjectContext,
  FetchObjectLocation,
  MoqtObject,
  SubgroupHeader,
} from "../dataStream";
import { decodeFetchStreamObjectFields } from "../dataStream/fetch";
import type { PendingObjectProperties } from "../dataStream/moqtObject";
import { decodeSubgroupStreamObjectFields } from "../dataStream/subgroup";
import { IncompleteDataError, MalformedTrackError } from "../error";
import { ObjectStatus } from "../message";
import type { GroupOrder, Location } from "../message/types";
import type { SubscriberImpl } from "../subscriber";
import {
  assertPriorIdGapInObjectProperties,
  readDeliveryTimeoutObjectProperties,
} from "../properties";
import {
  buildFetchTraversalGapRanges,
  buildFetchTraversalIntervalRanges,
  getFetchTraversalBoundaries,
  type FetchTraversalEndpoint,
  type TrackLocationRange,
} from "./objectStateTracking";
import {
  assertAndRecordFetchNonExistentRange,
  assertAndRecordFetchNonExistentRanges,
  assertNoObjectAfterFetchEnd,
  assertNoPriorIdGapTrackViolation,
  recordFetchObjectEnd,
  type PriorGapTrackingTarget,
} from "./priorGapTracking";
import { receivedPriority } from "./receivedPriority";

const EMPTY_BYTES = new Uint8Array(0);
const EMPTY_FETCH_GAP_RANGES: readonly TrackLocationRange[] = [];

interface StreamStatsUpdate {
  incrementObjectsReceived(subscribePath: boolean): void;
  incrementBytesReceived(subscribePath: boolean, bytes: number): void;
}

/**
 * Fetch オブジェクトの配送先
 *
 * 通常 FETCH は FetcherImpl、fill fetch ストリームは購読へのアダプタが入る。
 * どちらも active でなければ受け取らない契約は受け側が持つ。
 */
export interface FetchObjectSink {
  handleObject(object: MoqtObject): void;
  /** 配送コールバック中に購読が解除されたときは、同じチャンクの処理を止める。 */
  isReceiving?: () => boolean;
  /**
   * End of Track indicator (0x81) を受理したことを通知する
   *
   * draft-ietf-moq-transport-23 §11.4.1 (Fetch Header) / Table 8 / §11.4.2.2:
   * 0x81 は追加フィールドを持たない indicator で、直前の実 Object が Track の
   * 最終 Object であることを示す。通常の FETCH では FetcherImpl が受け取り
   * Fetcher.endOfTrack を true にする。fill fetch ストリームには対応する
   * Fetcher が無いため、受け側は何もしない。
   */
  handleEndOfTrack(): void;
}

// ============================================================================
// processFetchObjects
// ============================================================================

/**
 * FETCH 応答の暗黙 gap を非存在として解釈するための要求範囲の情報
 *
 * draft-ietf-moq-transport-23 §3.2.2 (Gaps in a Fetch Stream):
 * Range Filter を含まない要求では、応答内のマークされていない gap は存在しない
 * Object を示す。Range Filter を含む要求では Unknown 状態を示すため、非存在と
 * みなさない。Start / End Location は gap の境界 (先頭・末尾と、Descending で
 * Group をまたぐ場合の期待位置) を決めるのに使う。
 *
 * 要求範囲を保持していない fill fetch ではこの情報を渡さない (暗黙 gap を
 * 推論しない。検出漏れのみで誤検出は生まない)。
 */
export interface FetchGapSemantics {
  /** 要求した Start Location (含む) */
  readonly startLocation: Location;
  /** 応答がカバーする inclusive な上限 (End Location) */
  readonly endLocation: Location;
  /**
   * Range Filter を含む要求か
   *
   * true のとき、マークされていない gap は Unknown 状態の Object を示す
   * (§3.2.2)。非存在と誤認しないよう、gap を記録しない。
   */
  readonly rangeFiltersPresent: boolean;
}

/**
 * FETCH の暗黙 gap または明示された非存在範囲を、要求範囲内の区間へ分解する。
 * draft-ietf-moq-transport-23 §3.2.2 / §11.4.2: 直前のエントリーの次から端点までを扱う。
 */
function fetchGapRanges(
  groupOrder: GroupOrder,
  fetchGap: FetchGapSemantics,
  previousEntry: FetchObjectLocation | undefined,
  to: FetchTraversalEndpoint,
): TrackLocationRange[] {
  const from: FetchTraversalEndpoint =
    previousEntry === undefined
      ? {
          location: getFetchTraversalBoundaries(
            groupOrder,
            fetchGap.startLocation,
            fetchGap.endLocation,
          ).first,
          inclusive: true,
        }
      : {
          location: { group: previousEntry.groupId, object: previousEntry.objectId },
          inclusive: false,
        };
  return buildFetchTraversalGapRanges({
    groupOrder,
    startLocation: fetchGap.startLocation,
    endLocation: fetchGap.endLocation,
    from,
    to,
  });
}

/**
 * 明示された非存在範囲を、要求範囲の境界を使わずに記録する
 *
 * draft-ietf-moq-transport-23 §11.4.2: End of Non-Existent Range の復号位置は
 * 非存在範囲に含まれる。直前のエントリーから見た traversal order の次の位置を
 * 始点にし、要求範囲を保持しない fill FETCH でも範囲を求められるようにする。
 *
 * Descending では traversal order の Group が降順になるため、直前のエントリーの
 * Group が復号位置の Group より大きくなり得る。要求範囲の Start / End として
 * この 2 点を渡すと辞書式順序の前提 (start <= end) が崩れて区間が消えるため、
 * 要求範囲を持たない区間として分解する。Group をまたぐ場合は、直前 Group の
 * 残り・間の Group 全体・復号位置の Group の先頭の 3 件になる。
 *
 * @throws MalformedTrackError 区間が受信済み Object を覆った場合
 */
function recordMarkedNonExistentRange(
  target: PriorGapTrackingTarget,
  groupOrder: GroupOrder,
  previousEntryLocation: Location,
  endLocation: Location,
): void {
  // 直前のエントリーを traversal order の始点とし、そこから復号位置までを辿る。
  // 要求範囲を持たないため、要求範囲によるクランプは行わない。
  const ranges = buildFetchTraversalIntervalRanges({
    groupOrder,
    from: { location: previousEntryLocation, inclusive: false },
    to: { location: endLocation, inclusive: true },
  });
  assertAndRecordFetchNonExistentRanges(target, ranges);
}

/**
 * @param groupOrder - Group Order (GroupOrder.ASCENDING or GroupOrder.DESCENDING)
 *   draft-ietf-moq-transport-23 §11.4.1.1 / §9.19.8
 * @param priorGap - Track 単位の追跡対象。Prior ID Gap の 5 条件に加え、FETCH の
 *   End of Group / End of Track indicator が確定した終端の記録と検証、End of
 *   Non-Existent Range と暗黙 gap の非存在範囲の記録に使う。
 *   FETCH は Fetcher が持つ比較キー、fill fetch は購読が持つ比較キーで解決した
 *   結果を渡す。Track を特定できない場合は省略し、追跡検証を行わない。
 * @param context - 前回の戻り値。処理中はこのストリームだけが使用し、Priority 追跡表を再利用する。
 * @param fetchGap - FETCH 要求の範囲と Range Filter の有無。通常の FETCH だけが
 *   渡し、fill fetch と要求範囲を特定できない経路では省略する。省略時は暗黙 gap
 *   の推論を行わない。
 */
export function processFetchObjects(
  buffer: Uint8Array,
  sink: FetchObjectSink,
  context: FetchObjectContext | null,
  isFirst: boolean,
  stats: StreamStatsUpdate,
  groupOrder: GroupOrder,
  priorGap?: PriorGapTrackingTarget,
  fetchGap?: FetchGapSemantics,
): {
  remainingBuffer: Uint8Array;
  minimumBytes: number;
  pendingProperties: PendingObjectProperties | undefined;
  context: FetchObjectContext | null;
  isFirst: boolean;
} {
  let offset = 0;
  // 未完了 Object の先頭から次回の処理に必要なバイト数。長さが未確定なら次の追記で再試行する。
  let minimumBytes = 1;
  let pendingProperties: PendingObjectProperties | undefined;
  let currentContext = context;
  let currentIsFirst = isFirst;

  while (offset < buffer.length) {
    try {
      // draft-ietf-moq-transport-23 §3.2.2:
      // gap の開始位置は「直前にシリアライズされたエントリーの次」である。
      // 復号でコンテキストが更新される前に、直前エントリーの位置を控える。
      const previousEntry = currentContext?.lastSerializedLocation;
      const decoded = decodeFetchStreamObjectFields(
        buffer,
        currentContext,
        offset,
        currentIsFirst,
        groupOrder,
      );
      if (!Array.isArray(decoded)) {
        if (typeof decoded === "number") {
          minimumBytes = decoded;
        } else {
          decoded.check(buffer, offset);
          minimumBytes = decoded.minimumBytes;
          pendingProperties = decoded;
        }
        break;
      }

      const [fields, fieldsConsumed, newContext] = decoded;
      const payloadLength = Number(fields.payloadLength);
      offset += fieldsConsumed;

      const payload = buffer.slice(offset, offset + payloadLength);
      offset += payloadLength;

      currentContext = newContext;
      currentIsFirst = false;

      // draft-ietf-moq-transport-23 §3.2.2 / §11.4.2:
      // End of Range レコードは実際のオブジェクトデータを含まないためスキップする。
      // Group ID / Object ID は直前の Object / indicator を基準にした delta として
      // 既に復号され、newContext に入っている (§11.4.2.1)。後続の Object はその
      // 復号位置を prior として ID を復元する (§11.4.2.2)。
      // End of Range は Object ではないため、Track 横断の追跡検証も通さない。
      // Gone / Unknown / Timed-Out は非存在の断定ではないため (§2.1.2)、実 Object が
      // 後から届いても拒否しない。End of Non-Existent Range だけが範囲の非存在を
      // 通知するため、Track 単位の非存在区間として記録する (§12.1 条件 10)。
      //
      // §3.2.2 のギャップの意味論: ギャップは「Object が存在しない」「subscriber の
      // フィルタで除外された」「状態を判定できない」で起こり、Range Filter を送っていなければ
      // マークされていないギャップは存在しない Object を、送っていれば状態が不明な Object を
      // 示す。デフォルトと異なる原因の範囲は End of Range indicator でマークされる
      // (種別の意味は dataStream/fetch.ts の EndOfRangeType)。ストリーム末尾のギャップは
      // FIN でのみ検出できる。アプリへのギャップの通知は仕様が求めていないため行わない
      // (要求されたら別途対応する)。
      if (fields.endOfRange) {
        // End of Non-Existent Range は「マークされた」非存在通知であり、Range Filter
        // の有無に関わらず非存在として記録する (§3.2.2 の "unmarked gaps" の既定則は
        // マークされていない gap にだけ適用される)。要求範囲が分かる通常 FETCH では
        // traversal order の境界でクランプし、fill fetch など要求範囲が分からない
        // 経路では直前のエントリーから復号位置までを記録する。
        if (fields.endOfRange === "non_existent" && priorGap !== undefined) {
          const endLocation = { group: fields.groupId, object: fields.objectId };
          if (fetchGap !== undefined) {
            const ranges = fetchGapRanges(groupOrder, fetchGap, previousEntry, {
              location: endLocation,
              inclusive: true,
            });
            assertAndRecordFetchNonExistentRanges(priorGap, ranges);
          } else if (previousEntry !== undefined) {
            recordMarkedNonExistentRange(
              priorGap,
              groupOrder,
              {
                group: previousEntry.groupId,
                object: previousEntry.objectId,
              },
              endLocation,
            );
          } else {
            // §11.4.2: fill FETCH の先頭でも、復号した終点は非存在だと確定している。
            assertAndRecordFetchNonExistentRange(priorGap, {
              start: endLocation,
              end: endLocation,
            });
          }
        }
        continue;
      }

      // draft-ietf-moq-transport-23 §11.4.2.2 (Prior Object Fields):
      // End of Group (0x80) / End of Track (0x81) は追加フィールドを持たない
      // indicator であり、直前の実 Object を Group / Track の最終 Object として
      // 参照する。Object ではないため配送も統計計上もせず、確定した終端を Track
      // 単位の追跡へ記録する。0x81 は Track の終端も確定するため、通常 FETCH の
      // Fetcher に通知して endOfTrack を true にする (FIN では変更しない)。
      // End of Range の範囲端や算術用の 2^64-1 は終端として登録しない。
      if (fields.streamEnd) {
        if (priorGap !== undefined) {
          recordFetchObjectEnd(priorGap, fields.streamEnd);
        }
        if (fields.streamEnd.kind === "end_of_track") {
          sink.handleEndOfTrack();
        }
        continue;
      }

      // §11.4.1.1: 復号結果の代替値 0n を、追跡やアプリへの配送には使わない。
      const subgroupId = fields.isDatagram ? undefined : fields.subgroupId;

      // draft-ietf-moq-transport-23 §10.8 / §10.9:
      // Prior Group ID Gap / Prior Object ID Gap のうち、同一 Track の複数 Object と
      // 過去の受信状態を必要とする条件を配送前に検証する。単一 Object の条件は
      // フィールドの復号時に検証済みのため、ここでは重複して呼ばない。
      if (priorGap !== undefined) {
        // draft-ietf-moq-transport-23 §12.1 条件 4 / 5 (FETCH の終端 indicator)。
        // 詳細は assertNoObjectAfterFetchEnd の JSDoc を参照する。
        assertNoObjectAfterFetchEnd(priorGap, fields.groupId, fields.objectId);
        // draft-ietf-moq-transport-23 §12.1 条件 10:
        // 確定済みの非存在範囲内の Object を拒否し、非存在の根拠にしないよう
        // malformed と判定した Object は受信済みとして登録しない。
        // §3.2.2: Range Filter の無い要求の暗黙 gap は、Object と同時に検証する。
        // 同じ Group で Object ID が連続する場合、両端を除いた区間は空になる。
        const gapRanges =
          fetchGap === undefined || fetchGap.rangeFiltersPresent
            ? undefined
            : previousEntry?.groupId === fields.groupId &&
                previousEntry.objectId + 1n === fields.objectId
              ? EMPTY_FETCH_GAP_RANGES
              : fetchGapRanges(groupOrder, fetchGap, previousEntry, {
                  location: { group: fields.groupId, object: fields.objectId },
                  inclusive: false,
                });
        const options = {
          object: {
            priority: fields.publisherPriority,
            payload,
            subgroupId,
          },
          ...(gapRanges === undefined ? {} : { fetchGapRanges: gapRanges }),
        };
        assertNoPriorIdGapTrackViolation(
          priorGap,
          fields.groupId,
          fields.objectId,
          fields.properties,
          options,
        );
      }

      // draft-ietf-moq-transport-23 Section 11.1.1:
      // Fetch Object には Object Status が存在しないため NORMAL として扱う
      // exactOptionalPropertyTypes では optional な properties に undefined を渡せないため、
      // 値がある場合だけ載せる
      const object: MoqtObject = {
        groupId: fields.groupId,
        ...(subgroupId === undefined ? {} : { subgroupId }),
        objectId: fields.objectId,
        publisherPriority: fields.publisherPriority,
        status: ObjectStatus.NORMAL,
        payload,
        ...(fields.properties !== undefined && fields.properties.length > 0
          ? { properties: fields.properties }
          : {}),
      };

      stats.incrementObjectsReceived(false);
      stats.incrementBytesReceived(false, payload.byteLength);

      sink.handleObject(object);
      if (sink.isReceiving?.() === false) break;
    } catch (err) {
      if (err instanceof IncompleteDataError) {
        break;
      }
      throw err;
    }
  }

  return {
    // 未消費の部分は受信バッファ内のビューを返す。配信済みの本文は上でコピー済み。
    remainingBuffer: offset === buffer.byteLength ? EMPTY_BYTES : buffer.subarray(offset),
    minimumBytes,
    pendingProperties,
    context: currentContext,
    isFirst: currentIsFirst,
  };
}

// ============================================================================
// processSubgroupObjects
// ============================================================================

/**
 * subgroup 配送時のアプリ例外の通知と継続のためのフック
 *
 * `incomingHandleDatagram` と同形の防御を `processSubgroupObjects` で行うため、
 * 呼び出し側 (incoming 層) がセッション由来のコールバックを注入する。
 * `recordCallbackError` は throw してはならない
 * (incoming 層の実装がデバッグ記録の失敗を握り潰す)。
 */
export interface SubgroupDeliveryHooks {
  /**
   * アプリ例外を当該 subscriber の error コールバックへ通知する。
   * Error 正規化は注入側の責務とする (datagram 経路と同形)。
   */
  notifyError: (subscriber: SubscriberImpl, error: unknown) => void;
  /**
   * error コールバック自体の throw をデバッグ記録する。
   * payload は当該オブジェクト単位 (datagram 経路の data 全体と異なる)。
   */
  recordCallbackError: (payload: Uint8Array, error: unknown) => void;
}

export function processSubgroupObjects(
  buffer: Uint8Array,
  subscribers: SubscriberImpl[],
  header: SubgroupHeader,
  previousObjectId: bigint,
  stats: StreamStatsUpdate,
  delivery: SubgroupDeliveryHooks,
  resolvedSubgroupId?: bigint,
  endOfGroup?: { finalObjectId?: bigint },
  priorGap?: PriorGapTrackingTarget,
  priority = receivedPriority(header.publisherPriority, subscribers),
): {
  remainingBuffer: Uint8Array;
  minimumBytes: number;
  pendingProperties: PendingObjectProperties | undefined;
  previousObjectId: bigint;
  resolvedSubgroupId: bigint | undefined;
  updatedEndOfGroupFinalObjectId: bigint | undefined;
} {
  let offset = 0;
  // 未完了 Object の先頭から次回の処理に必要なバイト数。長さが未確定なら次の追記で再試行する。
  let minimumBytes = 1;
  let pendingProperties: PendingObjectProperties | undefined;
  let currentPreviousObjectId = previousObjectId;
  // draft-ietf-moq-transport-23 Section 11.3.1:
  // Subgroup ID = First Object ID の場合、最初のオブジェクトの Object ID を
  // Subgroup ID として使用する。呼び出し側で保持した値を優先し、
  // 未保持時のみヘッダ由来値から初期化する (feed 間の状態引き継ぎ)。
  // 同一ストリームの同一 header の連続 feed を前提とする。
  let currentResolvedSubgroupId = resolvedSubgroupId ?? header.subgroupId;
  // draft-ietf-moq-transport-23 §12.1 条件 4:
  // Object Status が END_OF_GROUP の Object は Group の最終 Object である。
  // 既知の最終 Object ID はセッションが Group 単位で保持し、呼び出し側から
  // 受け取る。これにより Subgroup ストリーム (呼び出し) をまたいだ追跡ができる。
  // 新たに確定した値は戻り値で返し、呼び出し側が更新する。
  let endOfGroupFinalObjectId = endOfGroup?.finalObjectId;

  while (offset < buffer.length) {
    // この subgroup で最初のオブジェクトかどうかをデコード直前に捕捉する。
    // 同一 subgroup の 2 件目以降は currentPreviousObjectId が進むため false になる。
    // 仮引数 previousObjectId (バッチ先頭値) を使うとバッチ全体が先頭扱いになる。
    // 送信側 src/session/publish.ts の isFirstInSubgroup と対称。
    // 呼び出し側が previousObjectId を feed 間で引き継ぐことが前提。
    // draft-ietf-moq-transport-23 §5.2 / §10.1 / §10.2:
    // 先頭オブジェクトのみ上書きし、先頭以外は無視する。
    const isFirstInSubgroup = currentPreviousObjectId < 0n;
    try {
      const decoded = decodeSubgroupStreamObjectFields(
        buffer,
        header.type,
        offset,
        currentPreviousObjectId,
      );
      if (!Array.isArray(decoded)) {
        decoded.check(buffer, offset);
        minimumBytes = decoded.minimumBytes;
        pendingProperties = decoded;
        break;
      }
      const [fields, fieldsConsumed, objectId] = decoded;

      const payloadLength = Number(fields.payloadLength);
      if (payloadLength > buffer.byteLength - offset - fieldsConsumed) {
        // 安全な整数の上限を超える長さは、数値化しても TypedArray の長さに収まらない。
        minimumBytes = fieldsConsumed + payloadLength;
        break;
      }

      offset += fieldsConsumed;
      currentPreviousObjectId = objectId;

      // draft-ietf-moq-transport-23 §10.8 / §10.9:
      // Prior Group ID Gap / Prior Object ID Gap のうち単一 Object で判定できる
      // malformed 条件 (gap が Group ID / Object ID より大きい) を検証する。
      assertPriorIdGapInObjectProperties(header.groupId, objectId, fields.properties);

      // draft-ietf-moq-transport-23 §10.8 / §10.9:
      // Prior Group ID Gap / Prior Object ID Gap のうち、同一 Track の複数 Object と
      // 過去の受信状態を必要とする 5 条件を配送前に検証する。単一 Object の条件は
      // 上の assertPriorIdGapInObjectProperties が先に検証しており、重複して呼ばない。
      // draft-ietf-moq-transport-23 §12.1 条件 4:
      // "An Object is received in a Group whose Object ID is larger than the
      //  final Object in the Group. The final Object in a Group is the Object
      //  with Status END_OF_GROUP, or the last Object before a FIN in a
      //  Subgroup which has the END_OF_GROUP bit set."
      // Group の最終 Object が既知 (他 Subgroup で END_OF_GROUP を検出済み) なら、
      // それより大きい Object ID を持つ Object は malformed である。この既知情報は
      // セッションが Track Alias と Group ID の 2 段 Map で保持するため、Subgroup
      // ストリームをまたいでも検出できる。
      //
      // 対象範囲: Object Status が END_OF_GROUP の Object による確定だけを扱う。
      // Subgroup Header の END_OF_GROUP ビットは「FIN 前の最後の Object が Group
      // 最終 Object」を意味し、FIN を観測して初めて確定する。FIN は
      // processSubgroupObjects の外 (呼び出し側のループ) で観測されるため、
      // この経路は対象外とする (endOfGroup ビット自体は SubgroupHeader で公開済み)。
      // assertNoPriorIdGapTrackViolation は通過した Object を受信状態へ登録するため、
      // 条件 4 / 5 の判定はその呼び出しより前に済ませる。
      if (endOfGroupFinalObjectId !== undefined && objectId > endOfGroupFinalObjectId) {
        throw new MalformedTrackError(
          `malformed track: object id ${objectId} exceeds final object ${endOfGroupFinalObjectId} in group ${header.groupId}`,
        );
      }

      currentResolvedSubgroupId ??= objectId;
      const payload = buffer.slice(offset, offset + payloadLength);
      offset += payloadLength;

      if (priorGap !== undefined) {
        // draft-ietf-moq-transport-23 §12.1 条件 4 / 5 (FETCH の終端 indicator):
        // 同じ Track の FETCH で End of Group / End of Track indicator が確定した
        // Group / Track の終端より後の Object は malformed である。詳細は
        // assertNoObjectAfterFetchEnd の JSDoc を参照する。
        if (fields.status === ObjectStatus.NORMAL) {
          assertNoObjectAfterFetchEnd(priorGap, header.groupId, objectId);
        }
        // §11.1.1 / §12.1 条件 10: 終端 Status が通知する非存在範囲を Track 全体で追跡する。
        assertNoPriorIdGapTrackViolation(priorGap, header.groupId, objectId, fields.properties, {
          status: fields.status,
          object: {
            deliveryMode: "subgroup",
            subgroupId: currentResolvedSubgroupId,
            priority,
            payload,
          },
        });
      }
      if (fields.status === ObjectStatus.END_OF_GROUP) {
        if (endOfGroupFinalObjectId !== undefined && objectId < endOfGroupFinalObjectId) {
          // 同じ Group について既知の最終 Object より小さい Object が
          // END_OF_GROUP を主張した。§12.1 条件 3 が禁じる
          // 「同一 Subgroup が複数のストリームで異なる最終 Object を持つ」状態と
          // 同じく、Group の最終 Object が二者に分かれる矛盾である。
          throw new MalformedTrackError(
            `malformed track: end of group object id ${objectId} is smaller than known final object ${endOfGroupFinalObjectId} in group ${header.groupId}`,
          );
        }
        endOfGroupFinalObjectId = objectId;
      }

      // exactOptionalPropertyTypes では optional な publisherPriority / properties に
      // undefined を渡せないため、値がある場合だけ載せる
      const object: MoqtObject = {
        groupId: header.groupId,
        subgroupId: currentResolvedSubgroupId,
        objectId,
        status: fields.status,
        payload,
        ...(header.publisherPriority !== undefined
          ? { publisherPriority: header.publisherPriority }
          : {}),
        ...(fields.properties.length > 0 ? { properties: fields.properties } : {}),
      };

      // draft-ietf-moq-transport-23 Section 5.2 / §10.1 / §10.2:
      // Object Property による delivery timeout の上書きは「subgroup の最初の
      // Object」にのみ適用され、それ以外の Object では ignore する
      // (PROTOCOL_VIOLATION にはしない)。§2.2 の FIRST_OBJECT ビット (0x40) は
      // ストリーム先頭 Object が「その subgroup で最初に publish された Object」
      // であることを示すため、中継が subgroup 途中から転送したストリームでは
      // ビットが立たず、上書きは適用されない。isFirstInSubgroup (ストリーム先頭)
      // だけでは中継転送を区別できないため、両方を要求する。
      if (isFirstInSubgroup && header.firstObject && fields.properties.length > 0) {
        const timeouts = readDeliveryTimeoutObjectProperties(fields.properties);
        if (timeouts.objectDeliveryTimeout !== undefined) {
          object.objectDeliveryTimeout = timeouts.objectDeliveryTimeout;
        }
        if (timeouts.subgroupDeliveryTimeout !== undefined) {
          object.subgroupDeliveryTimeout = timeouts.subgroupDeliveryTimeout;
        }
      }

      stats.incrementObjectsReceived(true);
      stats.incrementBytesReceived(true, payload.byteLength);

      // draft-ietf-moq-transport-23 §3.1: 同一 alias の全 subscription に配送
      // (filter 再適用は各 handleObject 内)。
      // アプリ例外は当該 subscriber の error コールバックへ通知し、
      // 残りの配送と同一ストリームの後続処理を継続する。セッションは閉じない。
      // 複数のときだけ購読を複製し、コールバック内の unsubscribe() による変更を隔離する。
      const count = subscribers.length;
      const recipients = count > 1 ? subscribers.slice() : subscribers;
      for (let index = 0; index < count; index++) {
        const sub = recipients[index]!;
        try {
          sub.handleObject(object, index + 1 < count);
        } catch (err) {
          // error コールバック自体の throw はデバッグ記録に残し、
          // 残りの配送を継続する。
          try {
            delivery.notifyError(sub, err);
          } catch (callbackError) {
            delivery.recordCallbackError(payload, callbackError);
          }
        }
      }
      // アプリが最後の購読を解除したら、このチャンクの残りの Object は処理しない。
      if (count > 0 && subscribers.length === 0) break;
    } catch (err) {
      if (err instanceof IncompleteDataError) {
        break;
      }
      throw err;
    }
  }

  return {
    // 未消費の部分は受信バッファ内のビューを返す。配信済みの本文は上でコピー済み。
    remainingBuffer: offset === buffer.byteLength ? EMPTY_BYTES : buffer.subarray(offset),
    minimumBytes,
    pendingProperties,
    previousObjectId: currentPreviousObjectId,
    resolvedSubgroupId: currentResolvedSubgroupId,
    updatedEndOfGroupFinalObjectId: endOfGroupFinalObjectId,
  };
}

// ============================================================================
// concatChunks
// ============================================================================

export function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

// ============================================================================
// cancelStreamQuiet
// ============================================================================

export async function cancelStreamQuiet(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: string,
): Promise<void> {
  try {
    await reader.cancel(reason);
  } catch {
    // ignore
  }
}
