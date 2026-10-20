/**
 * SubscriberAudioStop (moqt-devtools の停止時の音声 drain) の単体テスト
 *
 * ブラウザ API の無い環境で、停止の順序 (flush → drain → AudioContext.close) と、
 * 二重停止で AudioContext を 1 回だけ閉じること、flush した Object の復号出力を待つこと、
 * 停止中の表示用の文言が固定されていることを検証する。対象は記録用のオブジェクトで
 * 駆動し、実時間は使わない。
 */

import { test, assert } from "vite-plus/test";
import {
  SUBSCRIBER_AUDIO_STOPPING_STATUS_MESSAGE,
  SubscriberAudioStop,
  type SubscriberAudioStopTarget,
} from "./subscriberAudioStop";

/** 停止の呼び出し順と、drain に渡った条件を記録する対象を作る */
function makeStopTarget(
  options: {
    flushed?: number;
    onDrain?: (settle: () => void) => Promise<void>;
  } = {},
): {
  target: SubscriberAudioStopTarget;
  order: string[];
  drainCalls: Array<{ maxWaitMs: number; flushedObjects: number }>;
  flushCalls: () => number;
  closeCalls: () => number;
} {
  const order: string[] = [];
  const drainCalls: Array<{ maxWaitMs: number; flushedObjects: number }> = [];
  let flushCalls = 0;
  let closeCalls = 0;
  let flushPending = options.flushed ?? 0;
  const target: SubscriberAudioStopTarget = {
    flushAudio: () => {
      flushCalls++;
      order.push("flush");
      flushPending = options.flushed ?? 0;
      return flushPending;
    },
    drain: async (request) => {
      drainCalls.push({
        maxWaitMs: request.maxWaitMs,
        flushedObjects: request.flushedObjects,
      });
      order.push("drain");
      // flush した分の復号出力が届いたことにする (呼び出し側が 1 つずつ減らす)
      while (!request.isFlushSettled() && flushPending > 0) {
        flushPending--;
        if (flushPending === 0) {
          break;
        }
      }
      if (options.onDrain !== undefined) {
        await options.onDrain(() => {
          flushPending = 0;
        });
      }
    },
    closeAudioContext: async () => {
      closeCalls++;
      order.push("close");
    },
    onStopped: () => {
      order.push("stopped");
    },
  };
  return { target, order, drainCalls, flushCalls: () => flushCalls, closeCalls: () => closeCalls };
}

/**
 * 完了条件: 停止は flush → drain → AudioContext.close → 後始末の順に行い、
 * drain の待ちの上限と flush した件数を渡す。
 */
test("SubscriberAudioStop: flush → drain → close の順に止める", async (): Promise<void> => {
  const recorder = makeStopTarget({ flushed: 2 });
  const stop = new SubscriberAudioStop();

  await stop.stop(recorder.target);

  assert.deepEqual(recorder.order, ["flush", "drain", "close", "stopped"]);
  assert.deepEqual(recorder.drainCalls, [{ maxWaitMs: 300, flushedObjects: 2 }]);
  assert.equal(recorder.flushCalls(), 1);
  assert.equal(recorder.closeCalls(), 1);
});

/**
 * 完了条件: 二重に呼ばれた停止は同じ Promise を共有し、flush も AudioContext.close も
 * 1 回だけ行う。
 */
test("SubscriberAudioStop: 二重停止は 1 回にまとめる", async (): Promise<void> => {
  const recorder = makeStopTarget();
  const stop = new SubscriberAudioStop();

  const first = stop.stop(recorder.target);
  const second = stop.stop(recorder.target);

  assert.strictEqual(second, first, "同じ Promise を返すこと");
  await first;
  assert.equal(recorder.flushCalls(), 1);
  assert.equal(recorder.closeCalls(), 1);
  // 停止が終わったあとは再度停止できる (次の購読の停止)
  await stop.stop(recorder.target);
  assert.equal(recorder.flushCalls(), 2, "完了後の停止は新しく行うこと");
  assert.equal(recorder.closeCalls(), 2);
});

/**
 * 完了条件: flush した Object の復号の出力が届くまで drain が終わらないよう、
 * flush した件数を減らした残りを drain に渡す。
 */
test("SubscriberAudioStop: flush した復号の出力を待つ", async (): Promise<void> => {
  const recorder = makeStopTarget({ flushed: 3 });
  const stop = new SubscriberAudioStop();

  // drain の待ちの途中で復号の出力が 2 つ届き、最後の 1 つは drain の側で届く
  const draining = stop.stop({
    ...recorder.target,
    drain: async (request) => {
      assert.equal(request.flushedObjects, 3);
      assert.isFalse(request.isFlushSettled(), "flush の直後はまだ待つこと");
      stop.noteDecodedOutput();
      stop.noteDecodedOutput();
      assert.isFalse(request.isFlushSettled(), "2 つ届いてもまだ待つこと");
      stop.noteDecodedOutput();
      assert.isTrue(request.isFlushSettled(), "すべて届いたら待ち終えること");
    },
  });
  await draining;
  assert.equal(recorder.closeCalls(), 1);
});

/**
 * 完了条件: drain が失敗しても AudioContext を閉じ、後始末まで行う (停止を失敗させない)。
 */
test("SubscriberAudioStop: drain が失敗しても AudioContext を閉じる", async (): Promise<void> => {
  const recorder = makeStopTarget({
    onDrain: async () => {
      throw new Error("drain failed");
    },
  });
  const stop = new SubscriberAudioStop();

  await stop.stop(recorder.target);

  assert.deepEqual(recorder.order, ["flush", "drain", "close", "stopped"]);
  assert.equal(recorder.closeCalls(), 1);
});

/**
 * 完了条件: 停止中は isStopping が true になり、遅れて届く音声 Object を積まない
 * 判断に使える。停止が終わると false に戻る。
 */
test("SubscriberAudioStop: 停止中だけ isStopping が true になる", async (): Promise<void> => {
  const recorder = makeStopTarget();
  const stop = new SubscriberAudioStop();
  assert.isFalse(stop.isStopping);

  const draining = stop.stop({
    ...recorder.target,
    drain: async (request) => {
      assert.isTrue(stop.isStopping, "drain の間は停止中であること");
      assert.isTrue(request.isFlushSettled());
    },
  });
  await draining;
  assert.isFalse(stop.isStopping, "停止が終わったら戻ること");
  // flush 待ちが無いときに出力が届いても数を負にしない
  stop.noteDecodedOutput();
  assert.isFalse(stop.isStopping);
});

/**
 * 完了条件: 停止中であることを画面へ出す文言が決まっていること。
 */
test("SubscriberAudioStop: 停止中の表示文言を持つ", (): void => {
  assert.equal(SUBSCRIBER_AUDIO_STOPPING_STATUS_MESSAGE, "Finishing audio playback...");
});
