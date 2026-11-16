/**
 * 音声と映像の復号前の遅延の同期を、実物の Subscriber と段で検証する。
 * 時計、タイマー、デコーダーは差し替えず、タイマーが発火する前に期限と通知を確認する。
 */
import { test, assert } from "vite-plus/test";
import { MediaSubscriberImpl } from "./createMediaSubscriber";
import type { AudioDelivery } from "./codec/types";
import type { MoqtObject } from "./dataStream";
import { PRE_DECODE_QUEUE_MAX_OBJECTS, type PreDecodeDelayQueue } from "./playout/preDecodeDelay";
import type { PreDecodeDelayStage } from "./playout/preDecodeDelayStage";

interface PendingAudio {
  object: MoqtObject;
  delivery: AudioDelivery;
  arrivalWallClockMs: number;
}

/** 内部の実物の段だけを読む制御口。代わりの実装は注入しない。 */
interface SubscriberStages {
  audioPreDecodeStage: PreDecodeDelayStage<PendingAudio>;
  videoPreDecodeStage: PreDecodeDelayStage<MoqtObject>;
}

function createStages(): SubscriberStages {
  const subscriber = new MediaSubscriberImpl("moqt://example.com/live", {
    namespace: ["live"],
    audio: {},
    video: {},
    preDecodeDelayMs: 30_000,
  });
  return subscriber as unknown as SubscriberStages;
}

/** デコーダーへ渡す前に取り消すため、内容の復号は行わない。 */
function makeObject(objectId: bigint): MoqtObject {
  return { groupId: 0n, objectId, status: 0, payload: new Uint8Array([1]) };
}

/** 既定の上限と本体の同期コールバックをそのまま通す。 */
function overflowVideo(stage: PreDecodeDelayStage<MoqtObject>): void {
  for (let index = 0; index <= PRE_DECODE_QUEUE_MAX_OBJECTS; index++)
    stage.push(makeObject(BigInt(index)));
}

test("復号前の短縮通知は相手に保持している入力の期限も前倒しする", () => {
  const { audioPreDecodeStage: audio, videoPreDecodeStage: video } = createStages();
  try {
    audio.push({
      object: makeObject(0n),
      delivery: "subgroup",
      arrivalWallClockMs: performance.timeOrigin + performance.now(),
    });
    const latestEnqueuedMs = performance.now();
    overflowVideo(video);
    assert.isAbove(video.delayShortenMs, 0, "既定の件数上限で短縮されること");
    assert.equal(audio.delayShortenMs, video.delayShortenMs, "本体の通知で短縮量が一致すること");
    // 保持期限を読むだけであり、時計を動かしたりタイマーを手動発火させたりしない。
    const audioQueue = Reflect.get(audio, "queue") as PreDecodeDelayQueue<PendingAudio>;
    assert.isAtMost(
      audioQueue.nextDueMs() ?? Infinity,
      latestEnqueuedMs + 30_000 - audio.delayShortenMs,
      "保持中の音声にも映像と同じ実効遅延を適用すること",
    );
  } finally {
    audio.stop();
    video.stop();
  }
});

for (const stream of ["audio", "video"] as const) {
  for (const operation of ["stop", "flush"] as const) {
    test(`${stream} の復号前の段を ${operation} したら両側の短縮を解除する`, () => {
      const { audioPreDecodeStage: audio, videoPreDecodeStage: video } = createStages();
      try {
        overflowVideo(video);
        assert.isAbove(video.delayShortenMs, 0);
        assert.equal(audio.delayShortenMs, video.delayShortenMs);
        // 片側のデコーダーエラーや flush で段を空にした後、同じ段を再利用する。
        // 通知済みの値だけを 0 に戻すと、通常の push では解除の通知が復活しない。
        const stage = stream === "audio" ? audio : video;
        stage[operation]();
        assert.equal(audio.delayShortenMs, 0, "音声の短縮も解除すること");
        assert.equal(video.delayShortenMs, 0, "映像の短縮も解除すること");
        const beforePushMs = performance.now();
        if (stream === "audio") {
          audio.push({
            object: makeObject(0n),
            delivery: "subgroup",
            arrivalWallClockMs: performance.timeOrigin + performance.now(),
          });
        } else {
          video.push(makeObject(0n));
        }
        const queue = Reflect.get(stage, "queue") as PreDecodeDelayQueue<unknown>;
        assert.isAtLeast(
          queue.nextDueMs() ?? -Infinity,
          beforePushMs + 30_000,
          "再利用後の入力は元の遅延で保持すること",
        );
      } finally {
        audio.stop();
        video.stop();
      }
    });
  }
}
