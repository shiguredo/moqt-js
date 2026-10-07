// dummy の映像のフレーム間隔を刻む DedicatedWorker

// タブが hidden のとき、ブラウザは main thread のタイマーを 1 秒間隔に絞る
// (Chrome 88 以降は 5 分以上 hidden で 1 分間隔)。1 コールバック = 1 フレームの dummy の
// 映像はその影響をそのまま受け、配信の fps が 1 になる。Dedicated Worker のタイマーは
// 絞られないため (Chromium の BlinkSchedulerWorkerThrottling は既定で無効)、フレームの
// 間隔を刻むことだけをこの Worker に任せる。描画と requestFrame は main thread が行う。
//
// タブが freeze されたときは Worker のタイマーも止まる (HTML Standard の timers は
// "worker is not suspended" の間だけ待つ)。freeze は対象外である。

// 間隔の決め方は main thread 側と共有する (規則を 2 か所に書かない)
import {
  nextDummyFrame,
  type DummyVideoTickerRequest,
  type DummyVideoTickerTick,
} from "../utils/dummyVideo";

// 予約したタイマー。stop で消す
let timerId: ReturnType<typeof setTimeout> | null = null;
// 動いているか。stop の後にコールバックが走っても送らないためのフラグ
let running = false;
// 最初のフレーム (番号 0) の時刻。main thread が start の直後に描くため、その時刻を基準にする
let startMs = 0;
// フレーム間隔 (ミリ秒)
let frameIntervalMs = 0;
// 直前に描いたフレームの番号 (main thread が描いた番号を Worker が引き継ぐ)
let frameIndex = 0;

/**
 * 次のフレームの時刻まで待ち、時刻になったら tick を送る
 *
 * 次に描くフレームの番号は `nextDummyFrame` が決める。タイマーが遅れても間隔は
 * 積み上がらず、1 周期以上過ぎていた場合は過ぎたフレームを飛ばす。
 */
function scheduleNextFrame(): void {
  const next = nextDummyFrame(startMs, frameIntervalMs, frameIndex, performance.now());
  frameIndex = next.frameIndex;
  // 予定した時刻を絶対時刻で送る。window と Worker の performance.timeOrigin は同じ値
  // ではないため、main thread が予定と実際を比べられるよう絶対時刻へ変換する
  const scheduledAbsoluteMs = performance.timeOrigin + startMs + frameIndex * frameIntervalMs;
  timerId = setTimeout(() => {
    timerId = null;
    if (!running) {
      return;
    }
    const tick: DummyVideoTickerTick = { type: "tick", scheduledAbsoluteMs };
    self.postMessage(tick);
    scheduleNextFrame();
  }, next.delayMs);
}

self.onmessage = (event: MessageEvent<DummyVideoTickerRequest>) => {
  const message = event.data;

  if (message.type === "start") {
    running = true;
    frameIntervalMs = message.frameIntervalMs;
    // フレーム 0 は main thread が start の直後に描く。その時刻を基準にする
    startMs = performance.now();
    frameIndex = 0;
    scheduleNextFrame();
    return;
  }

  running = false;
  if (timerId !== null) {
    clearTimeout(timerId);
    timerId = null;
  }
};
