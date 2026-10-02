/**
 * src/session/requests.ts のデバッグログ用ヘルパのテスト
 */

import { test, assert } from "vite-plus/test";
import { requestsDescribeLocationFilter } from "./requests";

/**
 * draft-ietf-moq-transport-22 §9.20.9 Table 6:
 * Location Filter Type ごとの表現をデバッグログ用の文字列に要約する。
 * 0x00 (None) は reset、0x05 (Next Object) はフィールドを持たないため種別名だけ、
 * それ以外は Type に続くフィールドを列挙する。
 */
test("requestsDescribeLocationFilter: Location Filter Type ごとに要約する", () => {
  assert.isUndefined(requestsDescribeLocationFilter(undefined));
  assert.equal(requestsDescribeLocationFilter({ reset: true }), "reset");
  assert.equal(requestsDescribeLocationFilter({ nextObject: true }), "nextObject");
  assert.equal(requestsDescribeLocationFilter({ startGroup: 3n }), "startGroup=3");
  assert.equal(
    requestsDescribeLocationFilter({ startGroup: 1n, startObject: 2n }),
    "startGroup=1, startObject=2",
  );
  assert.equal(
    requestsDescribeLocationFilter({ startGroup: 1n, startObject: 2n, endGroupDelta: 3n }),
    "startGroup=1, startObject=2, endGroupDelta=3",
  );
  assert.equal(
    requestsDescribeLocationFilter({
      startGroup: 1n,
      startObject: 2n,
      endGroupDelta: 3n,
      endObject: 4n,
    }),
    "startGroup=1, startObject=2, endGroupDelta=3, endObject=4",
  );
});
