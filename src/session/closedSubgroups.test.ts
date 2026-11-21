import { assert, test } from "vite-plus/test";
import { MAX_VARINT } from "../varint";
import { ClosedGroupIds } from "./closedSubgroups";

test("閉じた Group の取り消しは他のビットと 64 ビット境界を越えた記録に影響しない", () => {
  const groups = new ClosedGroupIds();
  const ids = [0n, 31n, 32n, 63n, 64n, 65n, MAX_VARINT];
  for (const groupId of ids) groups.add(groupId);
  groups.add(63n);

  // 同じブロック内とブロック境界の両方で、対象の ID だけを取り消す。
  groups.delete(63n);
  groups.delete(63n);
  groups.delete(64n);
  assert.isFalse(groups.has(63n));
  assert.isFalse(groups.has(64n));
  assert.isFalse(groups.has(MAX_VARINT - 1n));
  for (const groupId of [0n, 31n, 32n, 65n, MAX_VARINT]) assert.isTrue(groups.has(groupId));

  // 残りのビットが消えたブロックは解放する。
  for (const groupId of ids) groups.delete(groupId);
  assert.isTrue(groups.isEmpty);
});
