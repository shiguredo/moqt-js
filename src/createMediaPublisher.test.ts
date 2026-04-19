/**
 * MediaPublisher の純粋関数ロジックのテスト
 */

import { test, assert } from "vite-plus/test";
import { computeAudioGroupTransition } from "./createMediaPublisher";

test("初回呼び出し (groupStartTimestamp=null) は現在の groupId と objectId=0 で group を開始する", () => {
  const result = computeAudioGroupTransition({
    groupId: 0,
    objectId: 0,
    groupStartTimestamp: null,
    chunkTimestamp: 12345n,
    groupDurationUs: 1_000_000n,
  });
  assert.equal(result.groupId, 0);
  assert.equal(result.nextObjectId, 1);
  assert.equal(result.objectIdToUse, 0);
  assert.equal(result.groupStartTimestamp, 12345n);
  assert.isTrue(result.groupChanged);
});

test("group 期間未満の連続呼び出しでは groupId が変わらず objectId が単調増加する", () => {
  const result = computeAudioGroupTransition({
    groupId: 3,
    objectId: 7,
    groupStartTimestamp: 1_000_000n,
    chunkTimestamp: 1_500_000n,
    groupDurationUs: 1_000_000n,
  });
  assert.equal(result.groupId, 3);
  assert.equal(result.objectIdToUse, 7);
  assert.equal(result.nextObjectId, 8);
  assert.equal(result.groupStartTimestamp, 1_000_000n);
  assert.isFalse(result.groupChanged);
});

test("group 期間を跨いだ呼び出しで groupId が +1 され objectId が 0 にリセットされる", () => {
  const result = computeAudioGroupTransition({
    groupId: 3,
    objectId: 50,
    groupStartTimestamp: 1_000_000n,
    chunkTimestamp: 2_100_000n,
    groupDurationUs: 1_000_000n,
  });
  assert.equal(result.groupId, 4);
  assert.equal(result.objectIdToUse, 0);
  assert.equal(result.nextObjectId, 1);
  assert.equal(result.groupStartTimestamp, 2_100_000n);
  assert.isTrue(result.groupChanged);
});

test("chunkTimestamp が後退した場合も新 group として再同期する", () => {
  const result = computeAudioGroupTransition({
    groupId: 5,
    objectId: 3,
    groupStartTimestamp: 5_000_000n,
    chunkTimestamp: 4_000_000n,
    groupDurationUs: 1_000_000n,
  });
  assert.equal(result.groupId, 6);
  assert.equal(result.objectIdToUse, 0);
  assert.equal(result.nextObjectId, 1);
  assert.equal(result.groupStartTimestamp, 4_000_000n);
  assert.isTrue(result.groupChanged);
});

test("ちょうど group 期間と等しい timestamp はまだ同じ group として扱う", () => {
  const result = computeAudioGroupTransition({
    groupId: 0,
    objectId: 10,
    groupStartTimestamp: 0n,
    chunkTimestamp: 1_000_000n,
    groupDurationUs: 1_000_000n,
  });
  assert.equal(result.groupId, 0);
  assert.equal(result.objectIdToUse, 10);
  assert.equal(result.nextObjectId, 11);
  assert.equal(result.groupStartTimestamp, 0n);
  assert.isFalse(result.groupChanged);
});

test("group 期間を僅か (1 μs) 超えたら新 group になる", () => {
  const result = computeAudioGroupTransition({
    groupId: 0,
    objectId: 10,
    groupStartTimestamp: 0n,
    chunkTimestamp: 1_000_001n,
    groupDurationUs: 1_000_000n,
  });
  assert.equal(result.groupId, 1);
  assert.equal(result.objectIdToUse, 0);
  assert.equal(result.nextObjectId, 1);
  assert.equal(result.groupStartTimestamp, 1_000_001n);
  assert.isTrue(result.groupChanged);
});
