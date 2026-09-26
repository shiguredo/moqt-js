import { test, assert } from "vite-plus/test";
import { pruneLogIds, pruneMapByLogId, pruneViewModes } from "./logRowState";

// どちらの関数も「落とすものがあるときだけ新しい Set / Map を作る」ことが重要である。
// 同じ参照が返れば、呼び出し側 (DebugPanel) の setState は再描画を起こさない

test("pruneLogIds: 残っている最も古い連番より小さい連番を落とす", () => {
  const values = new Set([1, 2, 3, 10, 11]);
  assert.deepEqual(
    [...pruneLogIds(values, 10)].sort((a, b) => a - b),
    [10, 11],
  );
  // 元の Set は変えない
  assert.equal(values.size, 5);
});

test("pruneLogIds: 落とすものが無ければ同じ参照を返す", () => {
  const values = new Set([10, 11]);
  assert.equal(pruneLogIds(values, 10), values);

  const empty = new Set<number>();
  assert.equal(pruneLogIds(empty, 10), empty);
  // ログが 1 つも無いとき (上限も無い) は何もしない
  assert.equal(pruneLogIds(values, null), values);
  assert.equal(pruneLogIds(empty, null), empty);
});

test("pruneLogIds: 上限ちょうどの連番は残す", () => {
  // 境界 (古い連番 = 残っている最も古い連番) は残す
  const values = new Set([9, 10]);
  assert.deepEqual([...pruneLogIds(values, 10)], [10]);
});

test("pruneViewModes: 捨てられたログの表示モードを落とす", () => {
  const viewModes = new Map<number, "data" | "binary">([
    [1, "binary"],
    [5, "data"],
    [10, "binary"],
  ]);
  const pruned = pruneViewModes(viewModes, 5);
  assert.deepEqual(
    [...pruned],
    [
      [5, "data"],
      [10, "binary"],
    ],
  );
  // 元の Map は変えない
  assert.equal(viewModes.size, 3);
});

test("pruneViewModes: 落とすものが無ければ同じ参照を返す", () => {
  const viewModes = new Map<number, "data" | "binary">([[10, "binary"]]);
  assert.equal(pruneViewModes(viewModes, 10), viewModes);

  const empty = new Map<number, "data" | "binary">();
  assert.equal(pruneViewModes(empty, 10), empty);
  assert.equal(pruneViewModes(viewModes, null), viewModes);
  assert.equal(pruneViewModes(empty, null), empty);
});

test("pruneMapByLogId: 捨てられたログの値を落とし、落とすものが無ければ同じ Map を返す", () => {
  // 表示モードと行の vnode のキャッシュで使う。落とすものが無いときに同じ参照を返す
  // ことが、無駄な再描画を起こさないための条件になる
  const values = new Map<number, string>([
    [1, "old"],
    [5, "keep"],
    [10, "keep"],
  ]);

  const pruned = pruneMapByLogId(values, 5);
  assert.deepEqual(
    [...pruned],
    [
      [5, "keep"],
      [10, "keep"],
    ],
  );
  // 元の Map は変えない
  assert.equal(values.size, 3);

  assert.equal(pruneMapByLogId(values, 1), values);
  assert.equal(pruneMapByLogId(values, null), values);

  const empty = new Map<number, string>();
  assert.equal(pruneMapByLogId(empty, 5), empty);
});
