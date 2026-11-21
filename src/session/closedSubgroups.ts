/**
 * 購読ごとに、既に閉じた Subgroup の Group ID を保持する。
 *
 * 送信側は Group ごとに 1 つの Subgroup を使う。連続する 64 個の ID を
 * 1 つのビット集合に格納し、離れた ID の間は領域を確保しない。
 */
const GROUP_BLOCK_SHIFT = 6n;
const GROUP_BLOCK_MASK = (1n << GROUP_BLOCK_SHIFT) - 1n;

export class ClosedGroupIds {
  private readonly blocks = new Map<bigint, bigint>();

  has(groupId: bigint): boolean {
    const bits = this.blocks.get(groupId >> GROUP_BLOCK_SHIFT) ?? 0n;
    return (bits & (1n << (groupId & GROUP_BLOCK_MASK))) !== 0n;
  }

  add(groupId: bigint): void {
    const block = groupId >> GROUP_BLOCK_SHIFT;
    const bit = 1n << (groupId & GROUP_BLOCK_MASK);
    this.blocks.set(block, (this.blocks.get(block) ?? 0n) | bit);
  }

  delete(groupId: bigint): void {
    const block = groupId >> GROUP_BLOCK_SHIFT;
    const current = this.blocks.get(block);
    if (current === undefined) return;
    const remaining = current & ~(1n << (groupId & GROUP_BLOCK_MASK));
    if (remaining === 0n) {
      this.blocks.delete(block);
    } else {
      this.blocks.set(block, remaining);
    }
  }

  get isEmpty(): boolean {
    return this.blocks.size === 0;
  }
}

export type ClosedSubgroupTracking = Map<bigint, ClosedGroupIds>;

/** Group を登録し、その購読の記録を返す。終了処理は返された記録を使って取り消す。 */
export function rememberClosedSubgroup(
  tracking: ClosedSubgroupTracking,
  trackAlias: bigint,
  groupId: bigint,
): ClosedGroupIds {
  let groups = tracking.get(trackAlias);
  if (groups === undefined) {
    groups = new ClosedGroupIds();
    tracking.set(trackAlias, groups);
  }
  groups.add(groupId);
  return groups;
}
