/**
 * object モードの Group 内 Object を Object ID 順に並べ直す
 *
 * draft-02 §4.1.1 の `streamMapping=object` では、各 Object が別の MOQT Subgroup に載る。
 * Subgroup どうしの到着順は保証されないため、同じ Group の Object が Object ID の順に
 * 届くとは限らない。映像の復号順の判定は Object ID の連続性を前提にしているので、
 * 復号へ渡す前にここで並べ直す。
 *
 * §6.2: Object ID MUST be zero for the first Object within a Group and then MUST increase
 * monotonically by one within that Group. したがって Group の先頭から購読していれば
 * Object ID 0 から順に取り出せる。Group の途中から購読した場合は、最初に届いた Object ID を
 * 起点にする (それより小さい Object が後から届いても、その Group では取り出さない)。
 */

import type { MoqtObject } from "./dataStream";

/**
 * Group 内の Object を Object ID 順に並べ直す buffer
 *
 * `push` は「今すぐ復号へ渡せる Object」を返す。Group が変わったら、前の Group に
 * 残っていた Object を Object ID 順で吐き出してから新しい Group を始める
 * (取りこぼした Object を捨てない)。
 */
export class GroupObjectOrderer {
  /** 現在並べ直している Group。未開始なら null */
  private groupId: bigint | null = null;

  /** 次に取り出す Object ID */
  private expectedObjectId = 0n;

  /** 到着済みで順番待ちの Object (Object ID をキーにする) */
  private readonly pending = new Map<bigint, MoqtObject>();

  /**
   * Object を受け取り、順番が揃った分を返す
   *
   * @param obj - 受信した Object
   * @returns 復号へ渡してよい Object (Object ID の昇順)
   */
  push(obj: MoqtObject): MoqtObject[] {
    if (this.groupId !== null && obj.groupId !== this.groupId) {
      const flushed = this.flushPending();
      return [...flushed, ...this.startGroup(obj)];
    }
    if (this.groupId === null) {
      return this.startGroup(obj);
    }
    this.pending.set(obj.objectId, obj);
    return this.drain();
  }

  /** 購読を終えたときに保持を捨てる */
  reset(): void {
    this.groupId = null;
    this.expectedObjectId = 0n;
    this.pending.clear();
  }

  /** まだ取り出していない Object の数 (テストと診断用) */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * 新しい Group の並べ直しを始める
   *
   * 最初に届いた Object ID を起点にする。Group の先頭 (Object ID 0) から購読していれば
   * 0 から順に取り出せる。
   */
  private startGroup(obj: MoqtObject): MoqtObject[] {
    this.groupId = obj.groupId;
    this.expectedObjectId = obj.objectId;
    this.pending.set(obj.objectId, obj);
    return this.drain();
  }

  /** expectedObjectId から連続して揃った分を取り出す */
  private drain(): MoqtObject[] {
    const ordered: MoqtObject[] = [];
    while (true) {
      const next = this.pending.get(this.expectedObjectId);
      if (next === undefined) {
        return ordered;
      }
      this.pending.delete(this.expectedObjectId);
      ordered.push(next);
      this.expectedObjectId += 1n;
    }
  }

  /** 保持している Object を Object ID 順に吐き出して捨てる */
  private flushPending(): MoqtObject[] {
    const flushed = [...this.pending.values()].sort((left, right) =>
      left.objectId < right.objectId ? -1 : left.objectId > right.objectId ? 1 : 0,
    );
    this.pending.clear();
    return flushed;
  }
}
