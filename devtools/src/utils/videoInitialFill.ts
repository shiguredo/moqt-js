import type { MoqtObject } from "../../../src/dataStream";
import type { Location } from "../../../src/message";
import { compareLocations } from "../../../src/session/params";

export interface ReceivedVideoObject {
  readonly object: MoqtObject;
  readonly receivedAtMs: number;
}

// SUBSCRIBE_OK や fill を待つ間に積める映像を制限する。
const MAX_HELD_BYTES = 16 * 1024 * 1024;
const MAX_HELD_OBJECTS = 2048;

function locationOf({ object }: ReceivedVideoObject): Location {
  return { group: object.groupId, object: object.objectId };
}

/**
 * draft-ietf-moq-transport-23 §3.4 / §3.5 の初回 fill と Next Object のライブをつなぐ。
 * fill は閉じた範囲を Object ID 順に運ぶ。ライブは別ストリームのため先着しうる。
 * この仕様は将来の版で変わり得る。
 */
export class VideoInitialFill {
  private boundary: Location | null | undefined;
  private phase: "filling" | "waiting-for-key" | "live" = "filling";
  private endedBeforeResponse = false;
  private cancelRequested = false;
  private lastReleased: Location | null = null;
  private readonly held = new Map<string, ReceivedVideoObject>();
  private heldBytes = 0;

  constructor(private readonly isKeyFrame: (object: MoqtObject) => boolean) {}

  get pending(): boolean {
    return this.phase === "filling";
  }

  takeCancelRequest(): boolean {
    const requested = this.cancelRequested;
    this.cancelRequested = false;
    return requested;
  }

  /** SUBSCRIBE_OK までは Track Properties も境界も確定していない。 */
  start(boundary: Location | null): ReceivedVideoObject[] {
    this.boundary = boundary;
    if (boundary === null) this.phase = "live";
    const ready = this.takeHeld().flatMap((item) => this.push(item));
    if (this.endedBeforeResponse) ready.push(...this.finish());
    return ready;
  }

  push(item: ReceivedVideoObject): ReceivedVideoObject[] {
    const object = item.object;
    if (object.payload.byteLength === 0) return [];
    if (this.boundary === undefined) {
      if (this.pending) this.hold(item);
      return [];
    }
    const location = locationOf(item);
    if (this.phase === "live") {
      if (object.fillDelivered) return [];
      // 合流した Group の重複を省く。その次の Group からは通常の復号順の判定に任せる。
      if (this.lastReleased?.group !== location.group) return [item];
      if (location.object <= this.lastReleased.object) return [];
      this.lastReleased = location;
      return [item];
    }
    if (this.lastReleased !== null && compareLocations(location, this.lastReleased) <= 0) {
      return [];
    }
    const boundary = this.boundary;
    if (boundary === null) return [];
    if (object.fillDelivered) {
      if (!this.pending || location.group !== boundary.group || location.object > boundary.object) {
        return [];
      }
      const ready = this.release([item]);
      if (location.object === boundary.object) ready.push(...this.finish());
      return ready;
    }
    if (compareLocations(location, boundary) <= 0) return [];
    if (location.group > boundary.group && this.isKeyFrame(object)) {
      if (this.pending) this.cancelRequested = true;
      this.phase = "live";
      // 参照を持つ旧 Group を捨てる。先着した同じ Group の delta はキーフレームの後に使う。
      return this.release([
        item,
        ...this.takeHeld().filter(
          (held) =>
            held.object.groupId === location.group && held.object.objectId > location.object,
        ),
      ]);
    }
    if (this.pending || location.group > boundary.group) this.hold(item);
    return [];
  }

  /** FIN では Largest Object が状態だけの場合もある。復号順の検査は後段で行う。 */
  finish(): ReceivedVideoObject[] {
    if (!this.pending) return [];
    if (this.boundary === undefined) {
      this.endedBeforeResponse = true;
      return [];
    }
    this.phase = "live";
    const held = this.takeHeld();
    const group = this.boundary?.group;
    return [
      ...this.release(held.filter(({ object }) => object.groupId === group)),
      ...held.filter(({ object }) => object.groupId !== group),
    ];
  }

  abandon(): void {
    if (this.phase === "live") return;
    if (this.pending) this.cancelRequested = true;
    this.phase = "waiting-for-key";
    this.takeHeld();
  }

  private hold(item: ReceivedVideoObject): void {
    const { object } = item;
    const key = `${object.groupId}:${object.objectId}`;
    if (this.held.has(key)) return;
    const bytes = object.payload.byteLength + (object.properties?.byteLength ?? 0);
    if (this.held.size >= MAX_HELD_OBJECTS || this.heldBytes + bytes > MAX_HELD_BYTES) {
      this.abandon();
      return;
    }
    this.held.set(key, item);
    this.heldBytes += bytes;
  }

  private takeHeld(): ReceivedVideoObject[] {
    const items = [...this.held.values()];
    this.held.clear();
    this.heldBytes = 0;
    return items;
  }

  private release(items: ReceivedVideoObject[]): ReceivedVideoObject[] {
    if (items.length > 1)
      items.sort((left, right) => compareLocations(locationOf(left), locationOf(right)));
    return items.filter((item) => {
      const location = locationOf(item);
      if (this.lastReleased !== null && compareLocations(location, this.lastReleased) <= 0) {
        return false;
      }
      this.lastReleased = location;
      return true;
    });
  }
}
