import { test, assert } from "vite-plus/test";
import { GROUP_SWITCH_HOLD_MS, GroupSwitchGate } from "./groupSwitchGate";

/** 検証用の Object (Group ID と Object ID の組を文字列にする) */
function label(groupId: bigint, objectId: number): string {
  return `${groupId}:${objectId}`;
}

// 後から購読した直後の cache からの追い上げでは、前の Group (1) の最後の Object と
// 次の Group (2) の先頭 (キーフレーム) が別の stream でほぼ同時に届き、アプリへ渡る順が
// 入れ替わることがある。前の Group の stream が開いている間は次の Group の Object を
// 保留し、前の Group の Object を先に渡す
test("push: 前の Group の stream が開いている間は次の Group の Object を保留する", () => {
  const gate = new GroupSwitchGate<string>();
  assert.deepEqual(gate.push(label(1n, 0), 1n, 0n, 0), ["1:0"]);
  assert.deepEqual(gate.push(label(1n, 1), 1n, 0n, 1), ["1:1"]);
  // Group 2 の先頭が Group 1 の最後の Object より先に届く
  assert.deepEqual(gate.push(label(2n, 0), 2n, 0n, 2), []);
  assert.equal(gate.holdDeadlineMs, 2 + GROUP_SWITCH_HOLD_MS);
  // 保留中に届いた Group 1 の Object は先に渡す
  assert.deepEqual(gate.push(label(1n, 2), 1n, 0n, 2.3), ["1:2"]);
  // 保留中に届いた Group 2 の後続も保留する
  assert.deepEqual(gate.push(label(2n, 1), 2n, 0n, 3), []);
  // Group 1 の stream が終わったら、保留した Object を届いた順に渡す
  assert.deepEqual(gate.endSubgroup(1n, 0n, 4), ["2:0", "2:1"]);
  assert.isNull(gate.holdDeadlineMs);
  assert.deepEqual(gate.push(label(2n, 2), 2n, 0n, 5), ["2:2"]);
});

// 前の Group の stream が先に終わっていれば保留しない (前の stream を FIN してから
// 次の stream を開く publisher では、通常は保留しない)
test("push: 前の Group の stream が終わっていれば保留しない", () => {
  const gate = new GroupSwitchGate<string>();
  gate.push(label(1n, 0), 1n, 0n, 0);
  assert.deepEqual(gate.endSubgroup(1n, 0n, 1), []);
  assert.deepEqual(gate.push(label(2n, 0), 2n, 0n, 2), ["2:0"]);
  assert.isNull(gate.holdDeadlineMs);
});

// 前の Group の stream が上限の時間を過ぎても終わらなければ、保留した Object を渡す
// (前の Group の stream を開いたままにする publisher で止まり続けない)
test("expire: 保留の上限を過ぎたら保留した Object を渡す", () => {
  const gate = new GroupSwitchGate<string>(50);
  gate.push(label(1n, 0), 1n, 0n, 0);
  gate.push(label(2n, 0), 2n, 0n, 10);
  assert.deepEqual(gate.expire(59.9), []);
  assert.deepEqual(gate.expire(60), ["2:0"]);
  assert.isNull(gate.holdDeadlineMs);
  // 解放の後に届いた前の Group の Object もそのまま渡す (復号するかは受け取った側が決める)
  assert.deepEqual(gate.push(label(1n, 1), 1n, 0n, 61), ["1:1"]);
  // 解放した Group 2 が現在の Group になり、その後の stream の終わりでは何も渡さない
  assert.deepEqual(gate.endSubgroup(1n, 0n, 62), []);
  assert.deepEqual(gate.push(label(2n, 1), 2n, 0n, 63), ["2:1"]);
});

// Subgroup ID を持たない Object (Datagram) は stream の終わりが通知されないため、
// 開いている stream として数えない。数えると次の Group で毎回上限まで保留してしまう
test("push: Subgroup ID を持たない Object は開いている stream として数えない", () => {
  const gate = new GroupSwitchGate<string>();
  gate.push(label(1n, 0), 1n, undefined, 0);
  assert.deepEqual(gate.push(label(2n, 0), 2n, undefined, 1), ["2:0"]);
});

// 1 Group を複数の Subgroup で送る publisher では、前の Group のすべての Subgroup の
// stream が終わるまで保留する
test("endSubgroup: 前の Group のすべての Subgroup の stream が終わるまで保留する", () => {
  const gate = new GroupSwitchGate<string>();
  gate.push(label(1n, 0), 1n, 0n, 0);
  gate.push(label(1n, 1), 1n, 1n, 0);
  assert.deepEqual(gate.push(label(2n, 0), 2n, 0n, 1), []);
  assert.deepEqual(gate.endSubgroup(1n, 0n, 2), []);
  assert.deepEqual(gate.endSubgroup(1n, 1n, 3), ["2:0"]);
});

// 保留は Group ごとに行い、古い Group から順に渡す。Group 2 の stream が開いている間は、
// Group 1 の stream が終わっても Group 3 の Object は保留したままにする
test("endSubgroup: 保留した Object を Group の古い順に、前の Group の stream が終わってから渡す", () => {
  const gate = new GroupSwitchGate<string>();
  gate.push(label(1n, 0), 1n, 0n, 0);
  assert.deepEqual(gate.push(label(3n, 0), 3n, 0n, 1), []);
  // Group 3 より後に届いた Group 2 は、Group 3 より先に渡す
  assert.deepEqual(gate.push(label(2n, 0), 2n, 0n, 2), []);
  assert.deepEqual(gate.endSubgroup(1n, 0n, 3), ["2:0"]);
  // Group 2 の後続は現在の Group としてそのまま渡す
  assert.deepEqual(gate.push(label(2n, 1), 2n, 0n, 4), ["2:1"]);
  assert.deepEqual(gate.endSubgroup(2n, 0n, 5), ["3:0"]);
});

// 購読をやめたときなどは、保留している Object を返して初期状態に戻す
test("reset: 保留している Object を返して初期状態に戻す", () => {
  const gate = new GroupSwitchGate<string>();
  gate.push(label(1n, 0), 1n, 0n, 0);
  gate.push(label(2n, 0), 2n, 0n, 1);
  assert.deepEqual(gate.reset(), ["2:0"]);
  assert.isNull(gate.holdDeadlineMs);
  // 初期状態なので、どの Group の Object もそのまま渡す
  assert.deepEqual(gate.push(label(5n, 0), 5n, 0n, 2), ["5:0"]);
});
