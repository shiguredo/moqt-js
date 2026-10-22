import { assert, test } from "vite-plus/test";
import * as fc from "fast-check";
import { AudioDelayFeedback } from "./audioDelayFeedback";

// 穴より前に上限を設定しても、保持中に下げても、次の適用値は同じ予算に収まる。
// jitter が内部目標より大きい場合を通し、内部目標だけの切り下げでは通らない検証にする。
test("穴の保持中も現在の明示上限を適用する", () => {
  fc.assert(
    fc.property(fc.integer({ min: 100, max: 159 }), (ceilingMs) => {
      const feedback = new AudioDelayFeedback();
      for (let index = 0; index < 2; index++)
        feedback.update({
          atMs: index * 1_000,
          jitterTargetMs: 160,
          latenessMs: null,
          startDelayMs: null,
          slackMs: null,
          backlogMisses: 0,
          backlogMs: 0,
          gapCount: index,
          gapMs: index * 60,
        });
      assert.equal(feedback.targetDelayMs(160), 160);
      feedback.setCeilingMs(ceilingMs);
      assert.equal(
        feedback.targetDelayMs(160),
        ceilingMs,
        "保持中の穴の上限にも新しい予算を使うこと",
      );
    }),
  );
});
