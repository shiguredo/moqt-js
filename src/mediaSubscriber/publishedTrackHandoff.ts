import type { MoqtObject } from "../dataStream";
import { type Location, ObjectStatus } from "../message";
import type { PublishDoneInfo, SubgroupStreamEnd } from "../session";
import { compareLocations } from "../session/params";
import { SubscriberImpl, type Subscriber } from "../subscriber";

const MAX_HELD_OBJECTS = 2048;
const MAX_HELD_BYTES = 16 * 1024 * 1024;

type Delivery = "subgroup" | "datagram";

interface Options {
  canStart(object: MoqtObject): boolean;
  onResume(subscriber: Subscriber): void;
  onObject(object: MoqtObject, delivery: Delivery): void;
  onSubgroupEnd?(end: SubgroupStreamEnd): void;
  onEnd?(done: PublishDoneInfo): void;
  onError?(error: Error): void;
  requireNewGroup?: boolean;
}

interface Received {
  readonly object: MoqtObject;
  readonly delivery: Delivery;
}

interface Candidate {
  readonly held: Received[];
  bytes: number;
  subscriber: Subscriber | null;
}

function locationOf(object: MoqtObject): Location {
  return { group: object.groupId, object: object.objectId };
}

/** 旧購読の drain 中に先着した再配信を、独立して復号できる位置から引き継ぐ。 */
export class PublishedTrackHandoff {
  private primaryEnded = false;
  private lastLocation: Location | null = null;
  private standby: Candidate | null = null;
  private active: Candidate | null = null;

  constructor(private readonly options: Options) {}

  open() {
    const candidate: Candidate = { held: [], bytes: 0, subscriber: null };
    if (this.standby !== null) this.clear(this.standby);
    this.standby = candidate;
    return {
      object: (object: MoqtObject, delivery: Delivery = "subgroup") => {
        if (candidate === this.active) {
          this.options.onObject(object, delivery);
        } else if (candidate === this.standby) {
          this.hold(candidate, { object, delivery });
          this.tryResume();
        }
      },
      establish: (subscriber: Subscriber) => {
        candidate.subscriber = subscriber;
        this.tryResume();
      },
      subgroupEnd: (end: SubgroupStreamEnd) => {
        if (candidate === this.active) this.options.onSubgroupEnd?.(end);
      },
      end: (done?: PublishDoneInfo) => {
        this.finish(candidate, done);
        this.tryResume();
      },
      error: (error: Error) => {
        const wasActive = candidate === this.active;
        this.finish(candidate);
        if (wasActive) this.options.onError?.(error);
        this.tryResume();
      },
    };
  }

  endPrimary(location: Location | null): void {
    if (this.primaryEnded) return;
    this.primaryEnded = true;
    this.lastLocation = location;
    this.tryResume();
  }

  reset(): void {
    if (this.standby !== null) this.clear(this.standby);
    this.standby = null;
    this.active = null;
    this.primaryEnded = false;
    this.lastLocation = null;
  }

  private finish(candidate: Candidate, done?: PublishDoneInfo): void {
    if (this.standby === candidate) {
      this.clear(candidate);
      this.standby = null;
    }
    if (this.active !== candidate) return;
    this.active = null;
    this.lastLocation = candidate.subscriber?.largestReceivedLocation ?? this.lastLocation;
    if (done !== undefined) this.options.onEnd?.(done);
  }

  private clear(candidate: Candidate): void {
    candidate.held.length = 0;
    candidate.bytes = 0;
  }

  private hold(candidate: Candidate, received: Received): void {
    const { object } = received;
    if (object.status !== ObjectStatus.NORMAL || object.payload.byteLength === 0) return;
    const first = candidate.held[0]?.object;
    if (first === undefined || object.groupId > first.groupId) {
      // 最新の Group だけを保留する。映像の delta 単体からは復帰できない。
      if (!this.options.canStart(object)) return;
      this.clear(candidate);
    } else if (object.groupId < first.groupId || object.objectId < first.objectId) {
      return;
    }
    const bytes = object.payload.byteLength + (object.properties?.byteLength ?? 0);
    if (candidate.held.length >= MAX_HELD_OBJECTS || candidate.bytes + bytes > MAX_HELD_BYTES) {
      this.clear(candidate);
      return;
    }
    candidate.held.push(received);
    candidate.bytes += bytes;
  }

  private tryResume(): void {
    const candidate = this.standby;
    if (!this.primaryEnded || this.active !== null || candidate === null) return;
    const subscriber = candidate.subscriber;
    if (
      subscriber?.state !== "active" ||
      (subscriber instanceof SubscriberImpl && subscriber.isDrainingPublishDone)
    ) {
      return;
    }
    const start = candidate.held[0]?.object;
    if (start === undefined) return;
    const boundary = this.lastLocation;
    if (
      boundary !== null &&
      (this.options.requireNewGroup
        ? start.groupId <= boundary.group
        : compareLocations(locationOf(start), boundary) <= 0)
    ) {
      this.clear(candidate);
      return;
    }
    this.standby = null;
    this.active = candidate;
    this.options.onResume(subscriber);
    // 複数の Subgroup を経由して到着した Object も、保留した分は Object ID 順に渡す。
    candidate.held.sort(({ object: left }, { object: right }) =>
      left.objectId === right.objectId ? 0 : left.objectId < right.objectId ? -1 : 1,
    );
    for (const { object, delivery } of candidate.held) {
      if (this.active !== candidate) break;
      this.options.onObject(object, delivery);
    }
    this.clear(candidate);
  }
}
