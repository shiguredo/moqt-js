import { test, assert } from "vite-plus/test";
import { CatchUpGate } from "./catchUpGate";

// cache から追いつく途中かどうかの判定 (CatchUpGate) の境界値
//
// 境界は SUBSCRIBE_OK の LARGEST_OBJECT (draft-ietf-moq-transport-21 Section 9.20.18) である。
// 境界と同じ位置の Object も cache から配られた分であり、再生しない。辞書順の一般則
// (Group ID と Object ID の比較) は catchUpGate.prop.ts が確かめる。

test("CatchUpGate: 境界が無いときはすべての位置を再生する", () => {
  // 購読の時点で Object が無く LARGEST_OBJECT が省略された場合、cache から配られる分は無い
  const gate = new CatchUpGate();
  const decision = gate.evaluate({ group: 0n, object: 0n });
  assert.isTrue(decision.live, "境界が無いのに再生しないと判定した");
  // 境界を越えたわけではないため、ログや画面の更新の契機にはしない
  assert.isFalse(decision.boundaryReached, "境界が無いのに境界を越えたと判定した");
  assert.isTrue(gate.catchUpCompleted, "境界が無いのに追いつき中と判定した");
});

test("CatchUpGate: 境界と同じ位置は再生しない", () => {
  // LARGEST_OBJECT 自体も購読より前に publish された分であり、relay の cache から配られる
  const gate = new CatchUpGate();
  gate.setBoundary({ group: 5n, object: 3n });
  const decision = gate.evaluate({ group: 5n, object: 3n });
  assert.isFalse(decision.live, "境界と同じ位置を再生すると判定した");
  assert.isFalse(gate.catchUpCompleted, "境界を越えていないのに追いつきを終えたと判定した");
});

test("CatchUpGate: 境界より前の位置は再生しない", () => {
  const gate = new CatchUpGate();
  gate.setBoundary({ group: 5n, object: 3n });
  // 前の Group は、Object ID が大きくても境界より前である
  assert.isFalse(
    gate.evaluate({ group: 4n, object: 99n }).live,
    "前の Group の位置を再生すると判定した",
  );
  // 同じ Group で Object ID が小さい位置も境界より前である
  assert.isFalse(
    gate.evaluate({ group: 5n, object: 2n }).live,
    "同じ Group の前の Object を再生すると判定した",
  );
});

test("CatchUpGate: 境界より後は再生し、境界を越えたことを最初の 1 回だけ知らせる", () => {
  const gate = new CatchUpGate();
  gate.setBoundary({ group: 5n, object: 3n });

  const first = gate.evaluate({ group: 5n, object: 4n });
  assert.isTrue(first.live, "境界より後の同じ Group の Object を再生しないと判定した");
  assert.isTrue(first.boundaryReached, "境界を越えたことを知らせなかった");
  assert.isTrue(gate.catchUpCompleted, "境界を越えたのに追いつき中と判定した");

  const second = gate.evaluate({ group: 6n, object: 0n });
  assert.isTrue(second.live, "境界より後の Group の Object を再生しないと判定した");
  assert.isFalse(second.boundaryReached, "境界を越えたことを 2 回知らせた");
});

test("CatchUpGate: 境界を越えた後に遅着した境界以前の位置は再生しない", () => {
  // draft-ietf-moq-transport-21 Section 2.1 により Object は順不同で届きうる。
  // 一度 live になった後でも、cache から届いた分は再生しない
  const gate = new CatchUpGate();
  gate.setBoundary({ group: 5n, object: 3n });
  assert.isTrue(gate.evaluate({ group: 7n, object: 0n }).live, "境界より後の Object を再生しない");

  const late = gate.evaluate({ group: 5n, object: 1n });
  assert.isFalse(late.live, "遅着した境界以前の Object を再生すると判定した");
  assert.isFalse(late.boundaryReached, "再生しない判定で境界を越えたと知らせた");
});

test("CatchUpGate: 位置が分からない Object を知らせると追いつきを終える", () => {
  // TIMESTAMP を持たない publisher では復号の出力から位置を引けず、境界と比べられない。
  // 判定できないまま「Catching up」を出し続けないよう、その Track は追いつきを終える
  const gate = new CatchUpGate();
  gate.setBoundary({ group: 5n, object: 3n });
  assert.isFalse(gate.catchUpCompleted, "境界を越える前に追いつきを終えたと判定した");

  gate.markPositionUnknown();

  assert.isTrue(gate.catchUpCompleted, "位置が分からない Object を知らせても追いつき中と判定した");
  // 境界は消さないため、位置が分かる Object の判定は続く
  assert.isFalse(
    gate.evaluate({ group: 5n, object: 3n }).live,
    "位置が分からない Object を知らせた後に、境界以前の位置を再生すると判定した",
  );
  assert.isFalse(
    gate.evaluate({ group: 5n, object: 4n }).boundaryReached,
    "終えた追いつきの境界を越えたと 2 回知らせた",
  );
});

test("CatchUpGate: reset で境界が消え、すべての位置を再生する", () => {
  // 購読をやり直すと、前の購読の LARGEST_OBJECT は使えない
  const gate = new CatchUpGate();
  gate.setBoundary({ group: 5n, object: 3n });
  gate.reset();

  assert.isTrue(gate.catchUpCompleted, "reset したのに追いつき中と判定した");
  const decision = gate.evaluate({ group: 0n, object: 0n });
  assert.isTrue(decision.live, "reset したのに再生しないと判定した");
  assert.isFalse(decision.boundaryReached, "reset したのに境界を越えたと知らせた");
});

test("CatchUpGate: 境界を null にすると追いつく対象が無いものとして扱う", () => {
  // LARGEST_OBJECT が省略された SUBSCRIBE_OK、または音声トラックを持たない catalog の場合
  const gate = new CatchUpGate();
  gate.setBoundary({ group: 5n, object: 3n });
  gate.setBoundary(null);

  assert.isTrue(gate.catchUpCompleted, "境界を null にしたのに追いつき中と判定した");
  assert.isTrue(
    gate.evaluate({ group: 0n, object: 0n }).live,
    "境界が無いのに再生しないと判定した",
  );
});
