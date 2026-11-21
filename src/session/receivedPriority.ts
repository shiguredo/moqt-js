import type { SubscriberImpl } from "../subscriber";

/** §3.1.3 / §10.4: 共有 Alias で省略された Priority には複数の候補があり得る。 */
export type ReceivedPriority = number | ReadonlySet<number>;

// 共有 Alias の購読が閉じても、その購読の Datagram は遅れて到着し得る (§3.1.3)。
// 配列が作り直された Alias には以前の候補を引き継がない。保持済み集合は書き換えない。
const sharedAliasPriorities = new WeakMap<readonly SubscriberImpl[], ReadonlySet<number>>();

export function registerSharedAliasPriority(
  subscribers: readonly SubscriberImpl[],
  subscriber: SubscriberImpl,
): void {
  const previous = receivedPriority(undefined, subscribers);
  const next = subscriber.getDefaultPublisherPriority();
  if (typeof previous === "number") {
    if (previous !== next) {
      sharedAliasPriorities.set(subscribers, new Set([previous, next]));
    }
  } else if (!previous.has(next)) {
    sharedAliasPriorities.set(subscribers, new Set([...previous, next]));
  }
}

/** 同一 Track の追跡に使う Priority の候補を求める。 */
export function receivedPriority(
  explicitPriority: number | undefined,
  subscribers: readonly SubscriberImpl[],
): ReceivedPriority {
  if (explicitPriority !== undefined) {
    return explicitPriority;
  }
  const known = sharedAliasPriorities.get(subscribers);
  if (known !== undefined) {
    return known;
  }
  const first = subscribers[0]?.getDefaultPublisherPriority() ?? 128;
  let candidates: Set<number> | undefined;
  for (let index = 1; index < subscribers.length; index++) {
    const candidate = subscribers[index]!.getDefaultPublisherPriority();
    if (candidate !== first) {
      candidates ??= new Set([first]);
      candidates.add(candidate);
    }
  }
  return candidates ?? first;
}

/** §7.1 / §12.1: 以前と現在の両方に整合する Priority を残す。 */
export function intersectReceivedPriorities(
  previous: ReceivedPriority,
  current: ReceivedPriority,
): ReceivedPriority | undefined {
  if (previous === current) {
    return previous;
  }
  if (typeof previous === "number") {
    return typeof current !== "number" && current.has(previous) ? previous : undefined;
  }
  if (typeof current === "number") {
    return previous.has(current) ? current : undefined;
  }
  const matching = new Set<number>();
  for (const candidate of previous) {
    if (current.has(candidate)) {
      matching.add(candidate);
    }
  }
  if (matching.size <= 1) {
    return matching.values().next().value;
  }
  return matching.size === previous.size ? previous : matching;
}
