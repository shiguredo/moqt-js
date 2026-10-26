import type { Location } from "../../../src/message/types.ts";
import { compareLocations } from "../../../src/session/params.ts";

/** 最近見た Location を覚えておく既定の件数 (src の重複排除と同じ) */
export const AUDIO_RECEIVE_ORDER_WINDOW = 256;

/** Group ID の差を number へ安全に変換するときの上限 (Number.MAX_SAFE_INTEGER) */
const MAX_SAFE_GROUP_DISTANCE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * 音声 Object の受信順を観測した結果
 *
 * `outOfOrder` は順序逆転として数えるべき Object かどうか、`duplicate` は同じ Location を
 * 既に見たかどうかを表す。`duplicate` は計器の重複排除ではなく、受信入口で同じ Object の
 * copy を順序逆転として数えないための情報である
 */
export interface AudioReceiveOrderObservation {
  /** 受信済みの最大 Location より前の Location で届いた (順序逆転) */
  outOfOrder: boolean;
  /** 境界より後の同じ Location を既に見た (冗長化の copy など) */
  duplicate: boolean;
  /** 順序逆転したときの、最大 Group ID との差 (それ以外は 0) */
  groupDistance: number;
}

/**
 * 音声 Object の受信順を購読ごとに観測する
 *
 * datagram は並び順を保証しないため、音声の受信側は到着順に復号する。ここでは、
 * 同じ購読の中で受信済みの最大 Location と比べて Location が戻った Object を数え、
 * その戻り幅 (Group ID の差) を記録する。SUBSCRIBE_OK の LARGEST_OBJECT 以下の
 * Location は relay の cache から replay された Object であり、順序逆転ではないため
 * 数えない。
 *
 * 比較は Group ID → Object ID の順である (draft-ietf-moq-transport-22 §8.2 の Location
 * 比較)。音声は 1 Object = 1 Group であり、Group ID の差がそのまま戻り幅の目安になる。
 */
export class AudioReceiveOrderTracker {
  /** SUBSCRIBE_OK の LARGEST_OBJECT 境界。null は境界が無い (cache が無い) ことを表す */
  private boundary: Location | null = null;
  /** 境界が確定したか。確定するまでは cache と live を区別できない */
  private boundaryKnown = false;
  /** 受信済みの最大 Location */
  private largest: Location | null = null;
  /** 最近見た Location のキー (境界確定前も含む) */
  private readonly recentKeys = new Set<string>();
  private readonly recentKeyOrder: string[] = [];

  /**
   * @param windowSize - 最近見た Location を覚えておく件数
   */
  constructor(private readonly windowSize = AUDIO_RECEIVE_ORDER_WINDOW) {}

  /**
   * SUBSCRIBE_OK の LARGEST_OBJECT を境界として設定する
   *
   * @param boundary - 境界。null なら cache が無い (すべて live) として扱う
   */
  markBoundary(boundary: Location | null): void {
    this.boundary = boundary;
    this.boundaryKnown = true;
  }

  /**
   * 受信した音声 Object の Location を観測する
   *
   * @param location - 受信した Object の Location
   * @returns 順序逆転・重複の観測結果
   */
  observe(location: Location): AudioReceiveOrderObservation {
    const key = `${location.group.toString()}:${location.object.toString()}`;
    const duplicate = this.recentKeys.has(key);
    // 境界が確定する前もキーを記録する。境界確定後に同じ Object の copy が届いたときに、
    // 重複を順序逆転として数えないためである。境界が決まるまで最大 Location の更新だけを
    // 行うのは、cache と live を区別できないためである
    if (!this.boundaryKnown) {
      if (!duplicate) {
        this.remember(key);
      }
      this.updateLargest(location);
      return { outOfOrder: false, duplicate, groupDistance: 0 };
    }
    // 境界以下は relay の cache から replay された Object であり、順序逆転ではない。
    // cache の Location は窓へ記録しない (live の Location を追い出さないため)
    if (this.boundary !== null && compareLocations(location, this.boundary) <= 0) {
      return { outOfOrder: false, duplicate, groupDistance: 0 };
    }
    // 同じ Location の 2 個目以降 (冗長化の copy) は同じ Object であるため、順序逆転として
    // 数えない
    if (duplicate) {
      return { outOfOrder: false, duplicate: true, groupDistance: 0 };
    }
    this.remember(key);
    if (this.largest === null || compareLocations(location, this.largest) > 0) {
      this.largest = location;
      return { outOfOrder: false, duplicate, groupDistance: 0 };
    }
    // 最大 Location と同じ Location は順序逆転ではない。window から最大 Location のキーが
    // 追い出された後に同じ Location が届く場合があるため、等値もここで除く
    if (compareLocations(location, this.largest) === 0) {
      return { outOfOrder: false, duplicate: true, groupDistance: 0 };
    }
    // 受信済みの最大 Location より前の Object が届いた (順序逆転)
    return {
      outOfOrder: true,
      duplicate,
      groupDistance: groupDistance(this.largest.group, location.group),
    };
  }

  private updateLargest(location: Location): void {
    if (this.largest === null || compareLocations(location, this.largest) > 0) {
      this.largest = location;
    }
  }

  private remember(key: string): void {
    this.recentKeys.add(key);
    this.recentKeyOrder.push(key);
    if (this.recentKeyOrder.length > this.windowSize) {
      const oldest = this.recentKeyOrder.shift();
      if (oldest !== undefined) {
        this.recentKeys.delete(oldest);
      }
    }
  }
}

/**
 * Group ID の差を、安全に number へ変換する
 *
 * Group ID は varint (最大 2^64-1) であり、number へそのまま変換すると倍精度の整数精度を
 * 超えて値が変わる。順序逆転の戻り幅は目安として読む値であるため、Number.MAX_SAFE_INTEGER
 * を超える差はその値で頭打ちにする。
 *
 * @param largestGroup - 受信済みの最大 Group ID
 * @param group - 順序逆転した Object の Group ID
 */
function groupDistance(largestGroup: bigint, group: bigint): number {
  const distance = largestGroup - group;
  return distance > MAX_SAFE_GROUP_DISTANCE ? Number.MAX_SAFE_INTEGER : Number(distance);
}
