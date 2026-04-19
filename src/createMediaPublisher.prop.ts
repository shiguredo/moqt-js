/**
 * MediaPublisher の純粋関数ロジックのプロパティテスト
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { computeAudioGroupTransition } from "./createMediaPublisher";

// varint の最大値相当
const MAX_TIMESTAMP = 4611686018427387903n;

const groupIdArb = fc.integer({ min: 0, max: 1_000_000 });
const objectIdArb = fc.integer({ min: 0, max: 1_000_000 });
const timestampArb = fc.bigInt({ min: 0n, max: MAX_TIMESTAMP });
const durationArb = fc.bigInt({ min: 1n, max: 10_000_000n });

test("groupId は入力と比較して +1 以下 (単調非減少) しか増えない", () => {
  fc.assert(
    fc.property(
      groupIdArb,
      objectIdArb,
      fc.option(timestampArb, { nil: null }),
      timestampArb,
      durationArb,
      (groupId, objectId, groupStartTimestamp, chunkTimestamp, groupDurationUs) => {
        const result = computeAudioGroupTransition({
          groupId,
          objectId,
          groupStartTimestamp,
          chunkTimestamp,
          groupDurationUs,
        });
        assert.isAtLeast(result.groupId, groupId);
        assert.isAtMost(result.groupId - groupId, 1);
      },
    ),
  );
});

test("group 継続時は objectIdToUse = objectId、groupChanged=false、nextObjectId = objectId+1", () => {
  fc.assert(
    fc.property(
      groupIdArb,
      objectIdArb,
      timestampArb,
      timestampArb,
      durationArb,
      (groupId, objectId, groupStartTimestamp, chunkTimestamp, groupDurationUs) => {
        const result = computeAudioGroupTransition({
          groupId,
          objectId,
          groupStartTimestamp,
          chunkTimestamp,
          groupDurationUs,
        });
        if (!result.groupChanged) {
          assert.equal(result.groupId, groupId);
          assert.equal(result.objectIdToUse, objectId);
          assert.equal(result.nextObjectId, objectId + 1);
          assert.equal(result.groupStartTimestamp, groupStartTimestamp);
        }
      },
    ),
  );
});

test("group 切替時は objectIdToUse=0、nextObjectId=1、新しい groupStartTimestamp は chunkTimestamp に等しい", () => {
  fc.assert(
    fc.property(
      groupIdArb,
      objectIdArb,
      fc.option(timestampArb, { nil: null }),
      timestampArb,
      durationArb,
      (groupId, objectId, groupStartTimestamp, chunkTimestamp, groupDurationUs) => {
        const result = computeAudioGroupTransition({
          groupId,
          objectId,
          groupStartTimestamp,
          chunkTimestamp,
          groupDurationUs,
        });
        if (result.groupChanged) {
          assert.equal(result.objectIdToUse, 0);
          assert.equal(result.nextObjectId, 1);
          assert.equal(result.groupStartTimestamp, chunkTimestamp);
        }
      },
    ),
  );
});
