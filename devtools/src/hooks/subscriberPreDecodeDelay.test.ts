/**
 * SubscriberPreDecodeDelay (moqt-devtools の復号前の再生遅延) の単体テスト
 *
 * 決定的な時計を渡し、実時間を待たずに次を確かめる。
 *
 * - 購読の開始で段を作り、停止で段とタイマーを破棄する
 * - 遅延 0 では段を持たず、Object を積まない (呼び出し側が直接復号へ流せる)
 * - 購読中に 0 から増やすと段を作り、増減すると保持中の Object の期限を計算し直す
 * - 0 に戻すと保持中の Object を待たずに通知し、段をやめる
 * - 上限超過はメディアごとに 1 回だけ通知する
 * - 音声と映像の段は独立して動く
 */

import { test, assert } from "vite-plus/test";
import {
  SubscriberPreDecodeDelay,
  type SubscriberPreDecodeDelayOverflow,
} from "./subscriberPreDecodeDelay";
import { FakePreDecodeDelayClock } from "../../../src/testSupport/fakeClock";

/** テストで積む Object */
interface TestItem {
  readonly id: number;
  readonly bytes: number;
}

const bytesOfItem = (item: TestItem): number => item.bytes;

/** 遅延の管理と、期限の通知・上限超過の記録を作る */
function makeDelay(
  options: {
    maxBytes?: number;
    maxObjects?: number;
    bytesOfVideo?: (item: TestItem) => number;
    bytesOfAudio?: (item: TestItem) => number;
  } = {},
): {
  delay: SubscriberPreDecodeDelay<TestItem, TestItem>;
  clock: FakePreDecodeDelayClock;
  videoDue: TestItem[][];
  audioDue: TestItem[][];
  overflows: SubscriberPreDecodeDelayOverflow[];
} {
  const clock = new FakePreDecodeDelayClock();
  const videoDue: TestItem[][] = [];
  const audioDue: TestItem[][] = [];
  const overflows: SubscriberPreDecodeDelayOverflow[] = [];
  const delay = new SubscriberPreDecodeDelay<TestItem, TestItem>({
    bytesOfVideo: options.bytesOfVideo ?? bytesOfItem,
    bytesOfAudio: options.bytesOfAudio ?? bytesOfItem,
    onVideoDue: (items) => {
      videoDue.push([...items]);
    },
    onAudioDue: (items) => {
      audioDue.push([...items]);
    },
    onOverflow: (overflow) => {
      overflows.push(overflow);
    },
    clock,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.maxObjects === undefined ? {} : { maxObjects: options.maxObjects }),
  });
  return { delay, clock, videoDue, audioDue, overflows };
}

/** 1 件分の Object を作る */
function makeItem(id: number): TestItem {
  return { id, bytes: 10 };
}

// 遅延 0 で開始したときは段を持たず、Object を積まない。
test("SubscriberPreDecodeDelay: 遅延 0 では段を持たず積まない", () => {
  const { delay } = makeDelay();
  delay.start(0);

  assert.isFalse(delay.isActive);
  assert.equal(delay.delayMs, 0);
  assert.isFalse(delay.pushVideo(makeItem(0)), "映像を積まないこと");
  assert.isFalse(delay.pushAudio(makeItem(0)), "音声を積まないこと");
  assert.equal(delay.videoSize, 0);
  assert.equal(delay.audioSize, 0);
});

// 購読の開始で段を作り、期限が来たら音声と映像を別々に通知する。
test("SubscriberPreDecodeDelay: 購読の開始で段を作り期限で通知する", () => {
  const { delay, clock, videoDue, audioDue } = makeDelay();
  delay.start(100);

  assert.isTrue(delay.isActive);
  assert.isTrue(delay.pushVideo(makeItem(0)));
  assert.isTrue(delay.pushAudio(makeItem(1)));
  assert.equal(delay.videoSize, 1);
  assert.equal(delay.audioSize, 1);

  clock.advance(99);
  assert.deepEqual(videoDue, [], "期限前は通知しないこと");
  assert.deepEqual(audioDue, [], "期限前は通知しないこと");

  clock.advance(1);
  assert.deepEqual(videoDue, [[makeItem(0)]], "映像を期限で通知すること");
  assert.deepEqual(audioDue, [[makeItem(1)]], "音声を期限で通知すること");
});

// 購読の停止で段とタイマーを破棄し、期限が来ても通知しない。
test("SubscriberPreDecodeDelay: stop で段とタイマーを破棄する", () => {
  const { delay, clock, videoDue, audioDue } = makeDelay();
  delay.start(100);
  delay.pushVideo(makeItem(0));
  delay.pushAudio(makeItem(1));

  delay.stop();

  assert.isFalse(delay.isActive);
  assert.equal(delay.videoSize, 0);
  assert.equal(delay.audioSize, 0);
  clock.advance(1_000);
  assert.deepEqual(videoDue, [], "停止後に通知しないこと");
  assert.deepEqual(audioDue, [], "停止後に通知しないこと");
});

// 購読中に 0 から増やすと段を作り、その時点から受信する Object を保持して通知する。
test("SubscriberPreDecodeDelay: 0 から増やすと段を作る", () => {
  const { delay, clock, videoDue } = makeDelay();
  delay.start(0);

  delay.setDelayMs(100);
  assert.isTrue(delay.isActive);
  assert.equal(delay.delayMs, 100);
  assert.isTrue(delay.pushVideo(makeItem(0)));

  clock.advance(100);
  assert.deepEqual(videoDue, [[makeItem(0)]], "新しい遅延で通知すること");
});

// 購読中に小さくすると、保持中の Object の期限も新しい値で計算し直す。
test("SubscriberPreDecodeDelay: 遅延を小さくすると期限を計算し直す", () => {
  const { delay, clock, videoDue } = makeDelay();
  delay.start(500);
  delay.pushVideo(makeItem(0));

  clock.advance(100);
  delay.setDelayMs(50);

  clock.advance(50);
  assert.deepEqual(videoDue, [[makeItem(0)]], "新しい期限で通知すること");
});

// 購読中に大きくすると、保持中の Object の期限も後ろへ伸びる。
test("SubscriberPreDecodeDelay: 遅延を大きくすると期限を後ろへ伸ばす", () => {
  const { delay, clock, videoDue } = makeDelay();
  delay.start(100);
  delay.pushVideo(makeItem(0));

  clock.advance(50);
  delay.setDelayMs(1_000);

  // 積んだ時刻 (0 ms) から 1,000 ms が新しい期限である
  clock.advance(949);
  assert.deepEqual(videoDue, [], "変更後の期限前は通知しないこと");

  clock.advance(1);
  assert.deepEqual(videoDue, [[makeItem(0)]], "変更後の期限で通知すること");
});

// 0 に戻すと、保持中の Object を待たずに通知して段をやめる。
test("SubscriberPreDecodeDelay: 0 に戻すと保持分を流して段をやめる", () => {
  const { delay, clock, videoDue, audioDue } = makeDelay();
  delay.start(10_000);
  delay.pushVideo(makeItem(0));
  delay.pushAudio(makeItem(1));

  delay.setDelayMs(0);

  assert.isFalse(delay.isActive, "段をやめること");
  assert.deepEqual(videoDue, [[makeItem(0)]], "映像を待たずに通知すること");
  assert.deepEqual(audioDue, [[makeItem(1)]], "音声を待たずに通知すること");
  assert.isFalse(delay.pushVideo(makeItem(2)), "段が無いので積まないこと");
  clock.advance(20_000);
  assert.equal(videoDue.length, 1, "再度通知しないこと");
});

// 上限超過はメディアごとに 1 回だけ通知し、どちらのメディアかを含める。
test("SubscriberPreDecodeDelay: 上限超過をメディアごとに 1 回だけ通知する", () => {
  const clock = new FakePreDecodeDelayClock();
  const overflows: SubscriberPreDecodeDelayOverflow[] = [];
  const delay = new SubscriberPreDecodeDelay<TestItem, TestItem>({
    bytesOfVideo: bytesOfItem,
    bytesOfAudio: bytesOfItem,
    onVideoDue: () => {},
    onAudioDue: () => {},
    onOverflow: (overflow) => {
      overflows.push(overflow);
    },
    clock,
    // 保持できるのは 1 件だけにする
    maxObjects: 1,
  });
  delay.start(100);

  delay.pushVideo(makeItem(0));
  delay.pushVideo(makeItem(1));
  delay.pushVideo(makeItem(2));

  assert.equal(overflows.length, 1, "映像の上限超過を 1 回だけ通知すること");
  assert.equal(overflows[0]?.media, "video");
  assert.equal(overflows[0]?.dropped, 1);

  // 音声は別の段であり、メディアごとに 1 回通知する
  delay.pushAudio(makeItem(3));
  delay.pushAudio(makeItem(4));

  assert.equal(overflows.length, 2, "音声の上限超過も 1 回通知すること");
  assert.equal(overflows[1]?.media, "audio");
  assert.equal(delay.videoSize, 1);
  assert.equal(delay.audioSize, 1);
});

// 音声と映像の段は独立している (片方だけ遅延を変えることは無いが、積んだ件数は別々)。
test("SubscriberPreDecodeDelay: 音声と映像の件数を別々に持つ", () => {
  const { delay, clock } = makeDelay();
  delay.start(100);
  delay.pushVideo(makeItem(0));
  delay.pushAudio(makeItem(1));
  delay.pushAudio(makeItem(2));

  assert.equal(delay.videoSize, 1);
  assert.equal(delay.audioSize, 2);
  clock.advance(100);
  assert.equal(delay.videoSize, 0);
  assert.equal(delay.audioSize, 0);
});

// start する前の setDelayMs は値を覚えるだけで、段を作らない。
test("SubscriberPreDecodeDelay: start 前の setDelayMs は段を作らない", () => {
  const { delay } = makeDelay();
  delay.setDelayMs(100);
  assert.isFalse(delay.isActive, "購読していない間は段を作らないこと");
  assert.equal(delay.delayMs, 100, "設定値は覚えること");
  assert.isFalse(delay.pushVideo(makeItem(0)));

  delay.start(100);
  assert.isTrue(delay.isActive, "start で段を作ること");
  assert.isTrue(delay.pushVideo(makeItem(0)));
});

// 上限超過による短縮は音声と映像で揃える (片方だけ短くなると A/V の表示時刻がずれる)。
test("SubscriberPreDecodeDelay: 上限超過の短縮を音声と映像で揃える", () => {
  // 1 件 20 バイトで 50 バイトまでしか保持できない
  const { delay, clock, videoDue, audioDue } = makeDelay({
    maxBytes: 50,
    bytesOfVideo: () => 20,
    bytesOfAudio: () => 20,
  });
  delay.start(1_000);

  // 映像だけ上限超過させる (3 件目で 60 バイトになる)
  delay.pushVideo(makeItem(0));
  delay.pushVideo(makeItem(1));
  delay.pushVideo(makeItem(2));
  delay.pushAudio(makeItem(3));

  // 映像の短縮に音声も揃うため、音声も元の期限 (1,000 ms) より前に通知される
  clock.advance(10);
  assert.isAbove(audioDue.flat().length, 0, "音声の期限も前倒しされること");
  assert.isAbove(videoDue.flat().length, 0, "映像の期限も前倒しされること");
  assert.isBelow(clock.now(), 1_000, "元の期限より前に通知すること");
});
