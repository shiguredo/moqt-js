import { assert, test } from "vite-plus/test";
import type { MoqtObject } from "../dataStream";
import { ObjectStatus } from "../message";
import { SubscriberImpl } from "../subscriber";
import { PublishedTrackHandoff } from "./publishedTrackHandoff";

function object(groupId: bigint, objectId: bigint): MoqtObject {
  return { groupId, objectId, status: ObjectStatus.NORMAL, payload: Uint8Array.of(1) };
}

test("旧購読の終了より早く届いた再配信を、保存したキーから再生する", () => {
  const events: Array<string | bigint> = [];
  const handoff = new PublishedTrackHandoff({
    requireNewGroup: true,
    canStart: ({ objectId }) => objectId === 0n,
    onResume: () => events.push("再開"),
    onObject: ({ objectId }) => events.push(objectId),
  });
  const candidate = handoff.open();
  candidate.object(object(2n, 0n));
  candidate.establish(new SubscriberImpl(["live"], "video", 1n, 1n, () => {}));
  // 別の Subgroup が先着した場合も、保留した delta は Object ID 順に返す。
  candidate.object(object(2n, 2n));
  candidate.object(object(2n, 1n));
  assert.isEmpty(events);

  handoff.endPrimary({ group: 1n, object: 10n });
  candidate.object(object(2n, 3n));
  assert.deepEqual(events, ["再開", 0n, 1n, 2n, 3n]);
});

test("旧 Group の候補と終了した候補を再配信に選ばない", () => {
  const seen: bigint[] = [];
  const handoff = new PublishedTrackHandoff({
    requireNewGroup: true,
    canStart: ({ objectId }) => objectId === 0n,
    onResume: () => {},
    onObject: ({ groupId }) => seen.push(groupId),
  });
  const old = handoff.open();
  old.establish(new SubscriberImpl(["live"], "video", 1n, 1n, () => {}));
  old.object(object(1n, 0n));
  handoff.endPrimary({ group: 1n, object: 10n });
  assert.isEmpty(seen);

  const ended = handoff.open();
  ended.object(object(2n, 0n));
  ended.end();
  ended.establish(new SubscriberImpl(["live"], "video", 3n, 2n, () => {}));
  assert.isEmpty(seen);

  const next = handoff.open();
  next.establish(new SubscriberImpl(["live"], "video", 5n, 3n, () => {}));
  next.object(object(3n, 0n));
  old.object(object(1n, 11n));
  assert.deepEqual(seen, [3n]);
});
