import { assert, test } from "vite-plus/test";
import * as fc from "fast-check";
import { videoSelectionTargetMs } from "./audioOutputSync";
import { PlayoutBuffer } from "./buffer";
import { PlayoutTimeline } from "./timeline";

const TIME_ORIGIN_MS = 1_790_000_000_000;
const ORIGIN_TIMESTAMP = TIME_ORIGIN_MS * 1000;

// 期限内の候補を独立に並べて最小値を求める。キューは媒体時刻順で、同じ時刻も許す。
test("出力位置による補正は範囲内で、映像選択は許容した候補の中で距離を最小にする", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 1, maxLength: 24 }),
      fc.integer({ min: -10, max: 110 }),
      fc.option(fc.integer({ min: -100, max: 100 }), { nil: null }),
      fc.integer({ min: 1, max: 67 }),
      (mediaTimes, baseMs, audioDeltaMs, refreshMs) => {
        const timeline = new PlayoutTimeline({ timeOriginMs: TIME_ORIGIN_MS, maxQueuedFrames: 24 });
        timeline.observe("video", TIME_ORIGIN_MS, ORIGIN_TIMESTAMP);
        const buffer = new PlayoutBuffer<number>(24, timeline);
        const candidates = [...mediaTimes]
          .sort((left, right) => left - right)
          .map((mediaMs, index) => {
            const timestamp = ORIGIN_TIMESTAMP + mediaMs * 1000;
            buffer.enqueue(index, timestamp);
            const presentationMs = buffer.presentationTimeMs(timestamp);
            if (presentationMs === null) throw new Error("映像の基準提示時刻が得られない");
            return { index, presentationMs };
          });
        const audioMs = audioDeltaMs === null ? null : baseMs + audioDeltaMs;
        const targetMs = videoSelectionTargetMs(baseMs, audioMs, refreshMs);
        const toleranceMs = refreshMs / 2;
        const maxLateMs = Math.max(20, refreshMs);
        const correction = targetMs - baseMs;
        assert.isAtMost(Math.abs(correction), Math.min(20, toleranceMs));
        if (audioDeltaMs === null) assert.equal(correction, 0);
        else {
          assert.isAtMost(Math.abs(targetMs - (baseMs + audioDeltaMs)), Math.abs(audioDeltaMs));
          assert.isAtMost(Math.abs(correction), Math.abs(audioDeltaMs));
        }

        const closest = candidates
          .filter(
            ({ presentationMs }) =>
              baseMs - maxLateMs <= presentationMs && presentationMs <= targetMs + toleranceMs,
          )
          .sort(
            (left, right) =>
              Math.abs(left.presentationMs - targetMs) -
                Math.abs(right.presentationMs - targetMs) || left.index - right.index,
          )[0];
        assert.equal(
          buffer.selectNearest(baseMs, toleranceMs, maxLateMs, targetMs).draw,
          closest?.index ?? null,
        );
      },
    ),
    { numRuns: 500 },
  );
});
