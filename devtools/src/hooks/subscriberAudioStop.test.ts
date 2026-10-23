/**
 * SubscriberAudioStop (moqt-devtools の停止時の音声 drain) の単体テスト
 *
 * ブラウザ API の無い環境で、停止の順序 (flush → drain → AudioContext.close)、二重停止で
 * AudioContext を 1 回だけ閉じること、flush した Object と復号の出力を通し番号で対応させて
 * 待つこと (残りの数と、復号器が捨てたときの扱い)、停止中の表示用の文言が固定されている
 * ことを検証する。対象は記録用のオブジェクトで駆動し、実時間は使わない。
 */

import { test, assert } from "vite-plus/test";
import {
  SUBSCRIBER_AUDIO_STOPPING_STATUS_MESSAGE,
  SubscriberAudioStop,
  type SubscriberAudioStopTarget,
} from "./subscriberAudioStop";

type DrainRequest = Parameters<SubscriberAudioStopTarget["drain"]>[0];

/** 停止の呼び出し順を記録する対象を作る (drain は渡された条件を記録してすぐ終わる) */
function makeStopTarget(options: { flushed?: number } = {}): {
  target: SubscriberAudioStopTarget;
  order: string[];
  drainRequests: DrainRequest[];
  flushCalls: () => number;
  closeCalls: () => number;
} {
  const order: string[] = [];
  const drainRequests: DrainRequest[] = [];
  let flushCalls = 0;
  let closeCalls = 0;
  const target: SubscriberAudioStopTarget = {
    flushAudio: () => {
      flushCalls++;
      order.push("flush");
      return options.flushed ?? 0;
    },
    drain: async (request) => {
      drainRequests.push(request);
      order.push("drain");
    },
    closeAudioContext: async () => {
      closeCalls++;
      order.push("close");
    },
    onStopped: () => {
      order.push("stopped");
    },
  };
  return {
    target,
    order,
    drainRequests,
    flushCalls: () => flushCalls,
    closeCalls: () => closeCalls,
  };
}

test("SubscriberAudioStop: flush → drain → close の順に止め、待ちの初期値を渡す", async () => {
  const recorder = makeStopTarget({ flushed: 2 });
  const stop = new SubscriberAudioStop();
  let initial: {
    maxWaitMs: number;
    flushedObjects: number;
    settled: boolean;
    remaining: number;
  } | null = null;

  await stop.stop({
    ...recorder.target,
    drain: async (request) => {
      initial = {
        maxWaitMs: request.maxWaitMs,
        flushedObjects: request.flushedObjects,
        settled: request.isFlushSettled(),
        remaining: request.remainingFlushedObjects(),
      };
      recorder.order.push("drain");
    },
  });

  assert.deepEqual(recorder.order, ["flush", "drain", "close", "stopped"]);
  // flush した 2 件はまだ復号へ渡っておらず、出力も届いていないため待ち続ける
  assert.deepEqual(initial, {
    maxWaitMs: 300,
    flushedObjects: 2,
    settled: false,
    remaining: 2,
  });
  assert.equal(recorder.flushCalls(), 1);
  assert.equal(recorder.closeCalls(), 1);
});

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

test("SubscriberAudioStop: flush した復号の出力を通し番号で対応させて待つ", async () => {
  const recorder = makeStopTarget({ flushed: 3 });
  const stop = new SubscriberAudioStop();

  await stop.stop({
    ...recorder.target,
    drain: async (request) => {
      assert.equal(request.flushedObjects, 3);
      assert.isFalse(request.isFlushSettled(), "flush の直後はまだ待つこと");
      // flush した 3 件が復号へ渡る。出力は投入順に届く
      stop.noteAudioDecode(true);
      stop.noteAudioDecode(true);
      stop.noteAudioDecode(true);
      assert.isFalse(request.isFlushSettled(), "復号へ渡っただけでは待ち終えないこと");
      stop.noteAudioDecoded();
      stop.noteAudioDecoded();
      assert.isFalse(request.isFlushSettled(), "2 つ届いてもまだ待つこと");
      stop.noteAudioDecoded();
      assert.isTrue(request.isFlushSettled(), "すべて届いたら待ち終えること");
      recorder.order.push("drain");
    },
  });

  assert.deepEqual(recorder.order, ["flush", "drain", "close", "stopped"]);
});

test("SubscriberAudioStop: remainingFlushedObjects は復号へ渡る前の flush 分も数える", async () => {
  const recorder = makeStopTarget({ flushed: 2 });
  const stop = new SubscriberAudioStop();

  await stop.stop({
    ...recorder.target,
    drain: async (request) => {
      assert.equal(request.remainingFlushedObjects(), 2, "復号へ渡る前の 2 件が残ること");
      stop.noteAudioDecode(true);
      assert.equal(request.remainingFlushedObjects(), 2, "復号へ渡っても出力までは残ること");
      stop.noteAudioDecoded();
      assert.equal(request.remainingFlushedObjects(), 1, "出力が届いた分だけ減ること");
    },
  });
});

test("SubscriberAudioStop: discardFlushedOutputs は待ちを外し、届かなかった分を数える", async () => {
  const recorder = makeStopTarget({ flushed: 2 });
  const stop = new SubscriberAudioStop();

  await stop.stop({
    ...recorder.target,
    drain: async (request) => {
      stop.noteAudioDecode(true);
      stop.noteAudioDecode(true);
      assert.isFalse(request.isFlushSettled());
      // 復号器の reset・error で未到着の出力が捨てられた
      stop.discardFlushedOutputs();
      assert.isTrue(request.isFlushSettled(), "捨てた flush 分では待ち続けないこと");
      assert.equal(
        request.remainingFlushedObjects(),
        2,
        "届かなかった分は undecodedFlushedObjects に数えること",
      );
      // 捨てたあとに古い出力が届いても、待ちにも残りにも影響しない
      stop.noteAudioDecoded();
      assert.equal(request.remainingFlushedObjects(), 2);
    },
  });
});

test("SubscriberAudioStop: 前の停止の flush 分は次の停止の待ちに含めない", async () => {
  const stop = new SubscriberAudioStop();
  // 1 回目の停止: flush した 1 件が復号へ渡るが、出力が届かないまま待ちが終わる (上限で切れた)
  await stop.stop({
    flushAudio: () => 1,
    drain: async () => {
      stop.noteAudioDecode(true);
    },
    closeAudioContext: async () => {},
  });

  // 2 回目の停止: flush は 0 件。前の停止の flush 分 (通し番号 0) は今の停止の待ちに含めない
  await stop.stop({
    flushAudio: () => 0,
    drain: async (request) => {
      assert.isTrue(request.isFlushSettled(), "前の停止の flush 分で待ち続けないこと");
      assert.equal(request.remainingFlushedObjects(), 0);
    },
    closeAudioContext: async () => {},
  });

  // 前の停止の flush 分の出力が遅れて届いても、通し番号の対応は保たれる
  stop.noteAudioDecoded();
  assert.isTrue(stop.isFlushSettled);
});

test("SubscriberAudioStop: resetDrainTracking で通し番号と待ちを初期化する", () => {
  const stop = new SubscriberAudioStop();
  assert.equal(stop.noteAudioDecode(false), 0, "通し番号は 0 から採番すること");
  assert.equal(stop.noteAudioDecode(true), 1);
  stop.discardFlushedOutputs();
  stop.resetDrainTracking();
  assert.equal(stop.noteAudioDecode(false), 0, "購読を始めたら 0 から採番し直すこと");
  assert.isTrue(stop.isFlushSettled);
  assert.equal(stop.remainingFlushedObjects, 0);
});

test("SubscriberAudioStop: drain が失敗しても AudioContext を閉じる", async (): Promise<void> => {
  const recorder = makeStopTarget();
  const stop = new SubscriberAudioStop();

  await stop.stop({
    ...recorder.target,
    drain: async () => {
      recorder.order.push("drain");
      throw new Error("drain failed");
    },
  });

  assert.deepEqual(recorder.order, ["flush", "drain", "close", "stopped"]);
  assert.equal(recorder.closeCalls(), 1);
});

test("SubscriberAudioStop: 停止中だけ isStopping が true になる", async (): Promise<void> => {
  const recorder = makeStopTarget();
  const stop = new SubscriberAudioStop();
  assert.isFalse(stop.isStopping);

  await stop.stop({
    ...recorder.target,
    drain: async (request) => {
      assert.isTrue(stop.isStopping, "drain の間は停止中であること");
      assert.isTrue(request.isFlushSettled());
    },
  });
  assert.isFalse(stop.isStopping, "停止が終わったら戻ること");
  // flush 待ちが無いときに出力が届いても数を負にしない
  stop.noteAudioDecoded();
  assert.isFalse(stop.isStopping);
});

test("SubscriberAudioStop: 停止中の表示文言を持つ", (): void => {
  assert.equal(SUBSCRIBER_AUDIO_STOPPING_STATUS_MESSAGE, "Finishing audio playback...");
});
