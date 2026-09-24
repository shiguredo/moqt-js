/**
 * 前の Group の stream が開いている間、次の Group の Object を保留する
 *
 * draft-ietf-moq-transport-21 Section 2.1: "Objects can be delivered out of order"。
 * Group ごとに別の Subgroup の stream で届くため、前の Group の末尾が次の Group の先頭より
 * 後にアプリへ渡ることがある。経路での並び替えや再送のほか、ブラウザ上でも起きる
 * (stream ごとの読み取りは非同期であり、複数の stream のデータが同時に読める状態に
 * なると、アプリへ渡る順は読み取りが解決する順で決まる)。映像では、次の Group の
 * キーフレームを復号した後に前の Group の Object が届くと、その Object は復号できず
 * (VideoDecodeOrder が古い Group として捨てる)、前の Group の末尾が表示されない。
 *
 * このクラスは、次の Group の Object が届いたとき、それより前の Group の stream が
 * まだ開いていれば (Object が届いたが終わりが通知されていなければ)、次の Group の
 * Object を保留する。前の Group の stream がすべて終わるか、保留の上限の時間を
 * 過ぎたら、保留した Object を Group の古い順に (同じ Group の中では届いた順に) 渡す。
 * 保留中に届いた前の Group の Object は先に渡す。
 *
 * 前の Group の stream が先に終わっていれば保留しない。前の stream を FIN してから次の
 * stream を開く publisher では、保留は前の stream の終わり (FIN) の処理を待つ間だけで
 * 終わる。まだ Object が 1 つも届いていない stream はここからは見えないため、stream が
 * Group の順に始まる (relay は Group の順に stream を開く) ことを前提にする。Group ID の
 * 飛び (届いていない Group) では保留しない。飛ばす publisher で毎回上限まで待たないため
 * である。
 *
 * 時刻は呼び出し側が引数で渡す (`performance.now()`)。ブラウザ API に依存しない。
 * 根拠の仕様はドラフトであり、将来変更される可能性がある。
 */

/**
 * 保留の上限 (ミリ秒)
 *
 * 前の Group の stream の終わりの処理を待つ (通常は数 ms 以内) だけでなく、経路で前の
 * Group の末尾が遅れて届く (再送は 1 RTT 程度) 場合も吸収できる長さにする。一方で、
 * 前の Group の stream を開いたままにする publisher では、Group の切り替えごとに
 * 次の Group の先頭の復号がこの時間だけ遅れるため、短くする。moqt-devtools の jitter
 * buffer の再生遅延 (配備環境で 40 ms 前後) と同程度であり、その範囲では表示に響かない
 */
export const GROUP_SWITCH_HOLD_MS = 50;

/** 保留している Group */
interface HeldGroup<T> {
  readonly items: T[];
  // この Group の Object を最初に保留した時刻
  readonly heldAtMs: number;
}

/** Subgroup ID を Map のキーにする */
function subgroupKey(subgroupId: bigint): string {
  return subgroupId.toString();
}

/**
 * 購読 (映像のトラック) ごとに 1 つ持つ
 */
export class GroupSwitchGate<T> {
  private readonly maxHoldMs: number;
  // アプリへ渡した Object の最大の Group。まだ渡していなければ null
  private currentGroupId: bigint | null = null;
  // Object が届き、終わりが通知されていない Subgroup の stream (Group ごと)
  private readonly openSubgroups = new Map<bigint, Set<string>>();
  // 保留している Object (Group ごと)
  private readonly heldGroups = new Map<bigint, HeldGroup<T>>();

  /**
   * @param maxHoldMs - 保留の上限 (ミリ秒)
   */
  constructor(maxHoldMs: number = GROUP_SWITCH_HOLD_MS) {
    this.maxHoldMs = maxHoldMs;
  }

  /** 保留の期限 (`performance.now()` の時間軸)。保留していなければ null */
  get holdDeadlineMs(): number | null {
    let earliest: number | null = null;
    for (const held of this.heldGroups.values()) {
      if (earliest === null || held.heldAtMs < earliest) {
        earliest = held.heldAtMs;
      }
    }
    return earliest === null ? null : earliest + this.maxHoldMs;
  }

  /**
   * Object を受け取り、アプリへ渡してよい Object を返す
   *
   * @param subgroupId - Object が届いた Subgroup の ID。stream で届かない Object
   *   (Datagram) は undefined とし、開いている stream として数えない (終わりが通知
   *   されないため、数えると次の Group で毎回上限まで保留してしまう)
   * @param nowMs - 届いた時刻 (`performance.now()`)
   */
  push(item: T, groupId: bigint, subgroupId: bigint | undefined, nowMs: number): T[] {
    if (subgroupId !== undefined) {
      let open = this.openSubgroups.get(groupId);
      if (open === undefined) {
        open = new Set();
        this.openSubgroups.set(groupId, open);
      }
      open.add(subgroupKey(subgroupId));
    }
    if (this.currentGroupId === null) {
      this.currentGroupId = groupId;
      return [item];
    }
    // 渡した Group 以前の Object はそのまま渡す (復号できるかは受け取った側が決める)
    if (groupId <= this.currentGroupId) {
      return [item];
    }
    const held = this.heldGroups.get(groupId);
    if (held === undefined) {
      this.heldGroups.set(groupId, { items: [item], heldAtMs: nowMs });
    } else {
      held.items.push(item);
    }
    return this.drain();
  }

  /**
   * Subgroup の stream の終わり (FIN / RESET_STREAM) を受け取り、アプリへ渡してよく
   * なった Object を返す
   *
   * @param nowMs - 終わりを受け取った時刻 (`performance.now()`)
   */
  endSubgroup(groupId: bigint, subgroupId: bigint | undefined, _nowMs: number): T[] {
    if (subgroupId !== undefined) {
      const open = this.openSubgroups.get(groupId);
      open?.delete(subgroupKey(subgroupId));
      if (open?.size === 0) {
        this.openSubgroups.delete(groupId);
      }
    }
    return this.drain();
  }

  /**
   * 保留の上限を過ぎた Group の Object を返す
   *
   * 上限を過ぎた Group より前の Group の stream はあきらめる (以降に届いたその Object は
   * そのまま渡すが、復号できるかは受け取った側が決める)。
   *
   * @param nowMs - 現在の時刻 (`performance.now()`)
   */
  expire(nowMs: number): T[] {
    const released: T[] = [];
    for (const groupId of this.heldGroupIds()) {
      const held = this.heldGroups.get(groupId);
      if (held === undefined || held.heldAtMs + this.maxHoldMs > nowMs) {
        break;
      }
      released.push(...this.release(groupId));
    }
    released.push(...this.drain());
    return released;
  }

  /** 保留している Object を Group の古い順にすべて返し、初期状態に戻す */
  reset(): T[] {
    const released: T[] = [];
    for (const groupId of this.heldGroupIds()) {
      released.push(...(this.heldGroups.get(groupId)?.items ?? []));
    }
    this.heldGroups.clear();
    this.openSubgroups.clear();
    this.currentGroupId = null;
    return released;
  }

  /**
   * 保留している Group を古い順に見て、それより前の Group の stream がすべて終わって
   * いれば渡す
   */
  private drain(): T[] {
    const released: T[] = [];
    for (const groupId of this.heldGroupIds()) {
      if (this.hasOpenSubgroupBefore(groupId)) {
        break;
      }
      released.push(...this.release(groupId));
    }
    return released;
  }

  /** Group の保留を解いて渡す Group にする */
  private release(groupId: bigint): T[] {
    const held = this.heldGroups.get(groupId);
    this.heldGroups.delete(groupId);
    this.currentGroupId = groupId;
    // 渡した Group より前の Group の stream は、以降の保留の判定に使わない
    for (const openGroupId of this.openSubgroups.keys()) {
      if (openGroupId < groupId) {
        this.openSubgroups.delete(openGroupId);
      }
    }
    return held?.items ?? [];
  }

  /** 渡した Group から groupId の前までの Group に、開いている stream があるか */
  private hasOpenSubgroupBefore(groupId: bigint): boolean {
    const currentGroupId = this.currentGroupId;
    for (const openGroupId of this.openSubgroups.keys()) {
      if (openGroupId < groupId && (currentGroupId === null || openGroupId >= currentGroupId)) {
        return true;
      }
    }
    return false;
  }

  /** 保留している Group の ID を古い順に返す */
  private heldGroupIds(): bigint[] {
    return [...this.heldGroups.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
}
