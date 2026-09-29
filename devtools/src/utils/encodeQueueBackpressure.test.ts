import { test, assert } from "vite-plus/test";
import { MAX_VIDEO_ENCODE_QUEUE_SIZE, shouldDropFrame } from "./encodeQueueBackpressure";

// 上限ちょうどまでは投入し、超えた分だけを破棄する。境界を 1 つずらすと、キューに余裕が
// あるフレームまで捨てるか、超過を 1 件見逃して Worker へ送り続けることになる
test("shouldDropFrame: 上限を超えたときだけ破棄する", () => {
  for (let encodeQueueSize = 0; encodeQueueSize <= MAX_VIDEO_ENCODE_QUEUE_SIZE; encodeQueueSize++) {
    assert.isFalse(
      shouldDropFrame(encodeQueueSize),
      `送信中のフレーム数が ${encodeQueueSize} のときは投入すること`,
    );
  }
  assert.isTrue(
    shouldDropFrame(MAX_VIDEO_ENCODE_QUEUE_SIZE + 1),
    `送信中のフレーム数が ${MAX_VIDEO_ENCODE_QUEUE_SIZE + 1} のときは破棄すること`,
  );
});

// 上限は送信中のフレーム数の閾値であるため、0 以上の整数でなければ判定が成立しない
// (0 は未設定、または送信中 0 件のときの値であり、有効な上限である)
test("MAX_VIDEO_ENCODE_QUEUE_SIZE: 0 以上の整数である", () => {
  assert.isTrue(Number.isInteger(MAX_VIDEO_ENCODE_QUEUE_SIZE));
  assert.isAtLeast(MAX_VIDEO_ENCODE_QUEUE_SIZE, 0);
});

// 上限はライブラリの配信側 (src/createMediaPublisher.ts の processVideoFrames) が使う 2 と
// 同じ値でなければならない。片方だけを変えると、devtools とライブラリで破棄され始める
// タイミングがずれる。値そのものを固定しておかないと、境界のテストが定数に追随して
// 通ってしまい、ずれに気づけない
test("MAX_VIDEO_ENCODE_QUEUE_SIZE: ライブラリの配信側と同じ 2 である", () => {
  assert.equal(MAX_VIDEO_ENCODE_QUEUE_SIZE, 2);
});
