/**
 * 受信した映像 Object を復号してよいかを、Group の順序と欠落から決める
 *
 * draft-ietf-moq-transport-21 Section 2.1: "Objects can be delivered out of order"。
 * Group ごとに別の stream で届くため、前の Group の末尾が次の Group の先頭より後に
 * 届くことがある。次の Group のキーフレームを復号した後に前の Group の delta を
 * 復号すると、参照フレームが壊れて映像が崩れる。Group 内で Object が欠けた後の
 * delta も、参照するフレームが無いまま復号することになる。
 *
 * このクラスは復号してよい Object だけを通す。
 *
 * - 復号中の Group より古い Group の Object は捨てる
 * - キーフレームは、復号中の Group より新しい Group なら復号を始め直す
 * - 同じ Group の delta は、直前に復号した Object の次の Object ID のときだけ通す
 * - 間の Object ID が欠けている場合は、Prior Object ID Gap (Section 10.9) がその分の
 *   Object の非存在を示すときに限り連続とみなす。Section 2.1 は「A gap in the observed
 *   Object IDs does not by itself convey any information about the skipped Objects」
 *   とするため、示されない欠けは欠落として扱い、次のキーフレームまで delta を捨てる
 *
 * 1 Group の Object を 1 本の Subgroup で送る publisher を前提とする。1 Group を
 * 複数の Subgroup に分ける publisher の Object ID の飛びも欠落として扱う。どの Object
 * を参照しているかを受信側は判断できないため、崩れた映像ではなくキーフレーム待ちに倒す。
 *
 * 根拠の仕様はドラフトであり、将来変更される可能性がある。
 */

import { parseProperties } from "./properties";

/**
 * 復号しない理由
 *
 * - `stale`: 復号中の Group より古い Group の Object、または直前に復号した Object 以前の
 *   Object ID (重複か遅着)
 * - `missing-reference`: 参照するフレームが欠けているため、キーフレームを待っている
 */
export type VideoObjectDropReason = "stale" | "missing-reference";

/**
 * Object を復号してよいかの判定結果
 */
export type VideoObjectAdmission =
  | { readonly decode: true }
  | { readonly decode: false; readonly reason: VideoObjectDropReason };

/**
 * 判定に使う Object の位置と種別
 */
export interface VideoObjectPosition {
  readonly groupId: bigint;
  readonly objectId: bigint;
  readonly isKeyFrame: boolean;
  /**
   * Prior Object ID Gap (Section 10.9) が示す、この Object の直前にある存在しない
   * Object の数。Property が無い Object は 0 とする
   */
  readonly priorObjectIdGap: bigint;
}

const DECODE: VideoObjectAdmission = { decode: true };

/**
 * Object Properties から Prior Object ID Gap の値を取り出す。Property が無ければ 0
 *
 * draft-ietf-moq-transport-21 Section 10.9: Prior Object ID Gap は、この Object の直前に
 * ある存在しない Object の数を示す。Properties の malformed 判定 (同じ Property の重複など)
 * は受信時に済んでいるため、ここでは値だけを読む。
 */
export function priorObjectIdGapOf(properties: Uint8Array | undefined): bigint {
  if (properties === undefined || properties.length === 0) {
    return 0n;
  }
  return parseProperties(properties).priorObjectIdGap?.gap ?? 0n;
}

/**
 * 映像 Object の復号順を判定する状態機械
 *
 * 購読 (decoder) ごとに 1 つ持つ。decoder を作り直したら `reset` で初期化する。
 */
export class VideoDecodeOrder {
  /**
   * 復号中の Group。復号を始めていなければ null
   *
   * 欠落の後でキーフレームを待っている間も、欠落を検出した Group を保持する。
   * それより古い Group の Object を古いとして捨てるためである。
   */
  private decodingGroupId: bigint | null = null;

  /**
   * 復号中の Group で最後に復号した Object ID。キーフレームを待っている間は null
   */
  private lastDecodedObjectId: bigint | null = null;

  /**
   * 復号の開始前と、欠落を検出した後は true。キーフレームを通すまで delta を捨てる
   */
  private awaitingKeyFrame = true;

  /**
   * Object を復号してよいかを判定し、復号する場合は状態を進める
   */
  admit(position: VideoObjectPosition): VideoObjectAdmission {
    const { groupId, objectId } = position;

    // 復号中の Group より古い Group の Object は、どれも復号しない
    if (this.decodingGroupId !== null && groupId < this.decodingGroupId) {
      return { decode: false, reason: "stale" };
    }

    // 同じ Group で直前に復号した Object 以前の Object ID は、重複か遅着である
    if (
      groupId === this.decodingGroupId &&
      this.lastDecodedObjectId !== null &&
      objectId <= this.lastDecodedObjectId
    ) {
      return { decode: false, reason: "stale" };
    }

    if (position.isKeyFrame) {
      // キーフレームは参照を持たないため、ここまで来れば復号を始められる
      this.startDecoding(groupId, objectId);
      return DECODE;
    }

    if (this.decodingGroupId === null || groupId > this.decodingGroupId) {
      // 新しい Group のキーフレームを受けないまま、その Group の delta が届いた。
      // 前の Group の残りは古くなるため、この Group でキーフレームを待つ
      this.awaitMissingReference(groupId);
      return { decode: false, reason: "missing-reference" };
    }

    if (this.awaitingKeyFrame || this.lastDecodedObjectId === null) {
      return { decode: false, reason: "missing-reference" };
    }

    // 直前に復号した Object との間の Object ID の欠けが、Prior Object ID Gap で
    // 非存在と示された範囲に収まるときだけ連続とみなす
    const skipped = objectId - this.lastDecodedObjectId - 1n;
    if (skipped > position.priorObjectIdGap) {
      this.awaitMissingReference(groupId);
      return { decode: false, reason: "missing-reference" };
    }

    this.lastDecodedObjectId = objectId;
    return DECODE;
  }

  /**
   * 初期状態に戻す。次のキーフレームから復号を始める
   */
  reset(): void {
    this.decodingGroupId = null;
    this.lastDecodedObjectId = null;
    this.awaitingKeyFrame = true;
  }

  private startDecoding(groupId: bigint, objectId: bigint): void {
    this.decodingGroupId = groupId;
    this.lastDecodedObjectId = objectId;
    this.awaitingKeyFrame = false;
  }

  private awaitMissingReference(groupId: bigint): void {
    this.decodingGroupId = groupId;
    this.lastDecodedObjectId = null;
    this.awaitingKeyFrame = true;
  }
}
