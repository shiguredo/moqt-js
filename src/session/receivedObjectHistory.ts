/**
 * 受信した実 Object の同一性の追跡
 *
 * draft-ietf-moq-transport-23 §7.1 / §12.1 条件 6・7:
 * 同じ Full Track Name と Location の実 Object は、配送方法、Subgroup ID、
 * Publisher Priority、Payload、Immutable Properties が変わらない。
 * §3.2.1 の FETCH は配送方法を適用しないため、購読からの観測だけで比較する。
 *
 * セッションごとに最新 4096 件、バイト列は最大 8 MiB を保持する。
 * この上限で破棄した Object は再照合できない。単体で上限を超える Payload は
 * 長さと他のフィールドを比較し、内容のコピーは省く。
 */

import { bytesEqual } from "../bytes";
import { MalformedTrackError } from "../error";
import type { FullTrackNameKey } from "../fullTrackName";
import { intersectReceivedPriorities, type ReceivedPriority } from "./receivedPriority";

const MAX_OBJECTS = 4096;
const MAX_BYTES = 8 * 1024 * 1024;

export interface ReceivedObjectIdentity {
  readonly deliveryMode?: "subgroup" | "datagram";
  readonly subgroupId?: bigint | undefined;
  readonly priority: ReceivedPriority;
  readonly payload: Uint8Array;
}

interface ObjectRecord {
  readonly trackKey: FullTrackNameKey;
  deliveryMode: ReceivedObjectIdentity["deliveryMode"];
  readonly subgroupId: bigint | undefined;
  priority: ReceivedPriority;
  readonly payloadLength: number;
  readonly payload: Uint8Array | undefined;
  readonly immutableProperties: Uint8Array | undefined;
  readonly bytes: number;
}

const histories = new WeakMap<object, ReceivedObjectHistory>();

/** 追跡 Map をキーにすると、既存のセッション境界で比較履歴も分離できる。 */
export function getReceivedObjectHistory(tracking: object): ReceivedObjectHistory {
  let history = histories.get(tracking);
  if (history === undefined) {
    history = new ReceivedObjectHistory();
    histories.set(tracking, history);
  }
  return history;
}

export function clearReceivedObjectHistory(tracking: object, trackKey?: FullTrackNameKey): void {
  if (trackKey === undefined) {
    histories.delete(tracking);
  } else {
    histories.get(tracking)?.deleteTrack(trackKey);
  }
}

export class ReceivedObjectHistory {
  private readonly entries = new Map<string, ObjectRecord>();
  private retainedBytes = 0;

  objectKey(trackKey: FullTrackNameKey, groupId: bigint, objectId: bigint): string {
    // 十進の ID に ":" は入らない。末尾の Track Key に含まれる区切り文字もそのまま使える。
    return `${groupId}:${objectId}:${trackKey}`;
  }

  /** 検証中は履歴を変更しない。 */
  assertMatches(
    key: string,
    object: ReceivedObjectIdentity,
    immutable: Uint8Array | undefined,
    priority = object.priority,
  ): ReceivedPriority {
    const previous = this.entries.get(key);
    if (previous === undefined) return priority;

    if (
      previous.deliveryMode !== undefined &&
      object.deliveryMode !== undefined &&
      previous.deliveryMode !== object.deliveryMode
    ) {
      throw new MalformedTrackError("duplicate object has a different delivery mode");
    }
    if (previous.subgroupId !== object.subgroupId) {
      throw new MalformedTrackError("duplicate object has a different subgroup id");
    }
    const matchingPriority = intersectReceivedPriorities(previous.priority, priority);
    if (matchingPriority === undefined) {
      throw new MalformedTrackError("duplicate object has a different publisher priority");
    }
    if (
      previous.payloadLength !== object.payload.byteLength ||
      (previous.payload !== undefined && !bytesEqual(previous.payload, object.payload))
    ) {
      throw new MalformedTrackError("duplicate object has a different payload");
    }
    if (previous.immutableProperties === undefined || immutable === undefined) {
      if (previous.immutableProperties === immutable) return matchingPriority;
    } else if (bytesEqual(previous.immutableProperties, immutable)) {
      return matchingPriority;
    }
    throw new MalformedTrackError("duplicate object has different immutable properties");
  }

  /** すべての検証を通った Object の情報を配送前に保存する。 */
  remember(
    key: string,
    trackKey: FullTrackNameKey,
    object: ReceivedObjectIdentity,
    immutable: Uint8Array | undefined,
    priority: ReceivedPriority,
  ): void {
    const known = this.entries.get(key);
    if (known !== undefined) {
      // 先に FETCH で観測した場合、購読で初めて配送方法が分かる。
      known.deliveryMode ??= object.deliveryMode;
      known.priority = priority;
      return;
    }

    const immutableBytes = immutable?.byteLength ?? 0;
    const keepPayload = object.payload.byteLength <= MAX_BYTES - immutableBytes;
    const bytes = immutableBytes + (keepPayload ? object.payload.byteLength : 0);
    while (this.entries.size >= MAX_OBJECTS || this.retainedBytes + bytes > MAX_BYTES) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      const removed = this.entries.get(oldest.value);
      this.entries.delete(oldest.value);
      this.retainedBytes -= removed?.bytes ?? 0;
    }

    this.entries.set(key, {
      trackKey,
      deliveryMode: object.deliveryMode,
      subgroupId: object.subgroupId,
      priority,
      payloadLength: object.payload.byteLength,
      // アプリへの配送とデコーダーのバッファ再利用のどちらからも隔離する。
      payload: keepPayload ? object.payload.slice() : undefined,
      // properties の読み取り時点でワイヤから切り出した独立のバイト列。
      immutableProperties: immutable,
      bytes,
    });
    this.retainedBytes += bytes;
  }

  deleteTrack(trackKey: FullTrackNameKey): void {
    for (const [key, entry] of this.entries) {
      if (entry.trackKey !== trackKey) continue;
      this.entries.delete(key);
      this.retainedBytes -= entry.bytes;
    }
  }
}
