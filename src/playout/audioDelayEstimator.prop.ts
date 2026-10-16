/**
 * AudioDelayEstimator の Property-Based Tests
 *
 * libwebrtc の NetEq (`delay_manager.cc` / `histogram.cc` / `packet_arrival_history.cc`) を
 * 移植した、到着の遅れの分布から音声の jitter buffer の目標遅延を決める処理が満たすべき性質
 * を、任意の到着列で確かめる。この値は、揺らぎから求めた目標として共有の時間軸へ入り
 * (`timeline.ts`)、閉ループの目標と大きい方が実際に使われる。
 *
 * - 観測が無いうちは初期値 (`AUDIO_DELAY_START_MS`) を返す
 * - 目標遅延は常にバケットの幅の倍数であり、観測した相対遅延の最大値 + バケット 1 つ分を
 *   超えない (分布の 0.95 分位を取るため)
 * - 揺らぎの無い到着列では下限のバケットまで下がる (経路が静かなときに遅延を積まない)
 * - 同じ到着列なら同じ目標になり、`reset` で初期状態へ戻る
 * - 到着の遅れは 0 に丸められる (負の遅れを作らない)
 *
 * 具体的なバケット数・分位点・忘れ方は libwebrtc の定数であり、値そのものの検証は
 * src/playout/timeline.test.ts と createMediaSubscriber.test.ts が実測値との一致で担う。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  AUDIO_DELAY_BUCKETS,
  AUDIO_DELAY_BUCKET_MS,
  AUDIO_DELAY_START_MS,
  AudioDelayEstimator,
} from "./audioDelayEstimator";

/** Opus の 1 フレーム (20 ms) */
const FRAME_MS = 20;

/**
 * 到着の遅れの列を、復号の出力の時刻と TIMESTAMP にして渡す
 *
 * @param estimator - 駆動する推定器
 * @param frameCount - 音の数
 * @param delayMsOf - 送信側の時計からの遅れ (受信側の時計のずれと経路の遅れ。ミリ秒)
 */
function observeSeries(
  estimator: AudioDelayEstimator,
  frameCount: number,
  delayMsOf: (index: number) => number,
): void {
  for (let index = 0; index < frameCount; index++) {
    const captureMs = index * FRAME_MS;
    estimator.observe(captureMs + delayMsOf(index), captureMs);
  }
}

test("AudioDelayEstimator: 観測が無いうちは初期値を返す", () => {
  const estimator = new AudioDelayEstimator();
  assert.equal(estimator.targetDelayMs, AUDIO_DELAY_START_MS, "初期値を返すこと");
  // reset の後も同じである
  observeSeries(estimator, 100, () => 50);
  estimator.reset();
  assert.equal(estimator.targetDelayMs, AUDIO_DELAY_START_MS, "reset で初期値へ戻ること");
});

test("AudioDelayEstimator: 目標はバケットの倍数で、観測した遅れの最大 + 1 バケットを超えない", () => {
  fc.assert(
    fc.property(
      // 音の数は、ヒストグラムへ入れる区間 (500 ms) を必ず 1 回以上またぐ数にする
      // (それ未満では初期値のままになり、学習した値の性質を確かめられない)
      fc.integer({ min: 50, max: 400 }),
      fc.array(fc.integer({ min: 0, max: 1_500 }), { minLength: 1, maxLength: 400 }),
      (frameCount, delays) => {
        const estimator = new AudioDelayEstimator();
        const delayOf = (index: number): number => delays[index % delays.length] ?? 0;
        observeSeries(estimator, frameCount, delayOf);
        let maximum = 0;
        for (let index = 0; index < frameCount; index++) {
          // 相対の遅れは「最も早く届いた音」との差であり、観測した遅れの最大を超えない
          maximum = Math.max(maximum, delayOf(index));
        }
        const target = estimator.targetDelayMs;
        assert.equal(
          target % AUDIO_DELAY_BUCKET_MS,
          0,
          `目標がバケットの幅 (${AUDIO_DELAY_BUCKET_MS} ms) の倍数であること`,
        );
        assert.isAtLeast(target, AUDIO_DELAY_BUCKET_MS, "下限のバケット以上であること");
        assert.isAtMost(
          target,
          maximum + AUDIO_DELAY_BUCKET_MS,
          `目標 (${target} ms) が観測した遅れの最大 (${maximum} ms) + 1 バケットを超えないこと`,
        );
        assert.isAtMost(
          target,
          AUDIO_DELAY_BUCKETS * AUDIO_DELAY_BUCKET_MS,
          "バケットの範囲を超えないこと",
        );
      },
    ),
    { numRuns: 200 },
  );
});

test("AudioDelayEstimator: 揺らぎの無い到着列では下限のバケットまで下がる", () => {
  fc.assert(
    fc.property(
      // 送信側と受信側の時計のずれと、経路と復号の最小遅延 (一定)
      fc.integer({ min: 0, max: 2_000 }),
      fc.integer({ min: 50, max: 400 }),
      (constantDelayMs, frameCount) => {
        const estimator = new AudioDelayEstimator();
        observeSeries(estimator, frameCount, () => constantDelayMs);
        // 相対の遅れが常に 0 であるため、分布は最初のバケットだけになる
        assert.equal(
          estimator.targetDelayMs,
          AUDIO_DELAY_BUCKET_MS,
          "一定の遅れで届く音だけなら下限のバケットになること",
        );
      },
    ),
    { numRuns: 100 },
  );
});

test("AudioDelayEstimator: 同じ到着列なら同じ目標になり、reset でやり直せる", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 0, max: 600 }), { minLength: 1, maxLength: 200 }),
      fc.integer({ min: 1, max: 200 }),
      (delays, frameCount) => {
        const delayOf = (index: number): number => delays[index % delays.length] ?? 0;
        const first = new AudioDelayEstimator();
        observeSeries(first, frameCount, delayOf);
        // 同じ到着列をもう一度与えると、同じ目標になる (学習の過程も含めて決定的である)
        const second = new AudioDelayEstimator();
        observeSeries(second, frameCount, delayOf);
        assert.equal(second.targetDelayMs, first.targetDelayMs, "同じ到着列なら同じ目標になること");
        // reset してから同じ到着列を与えても、同じ目標になる
        first.reset();
        observeSeries(first, frameCount, delayOf);
        assert.equal(
          first.targetDelayMs,
          second.targetDelayMs,
          "reset の後の学習が同じ結果になること",
        );
      },
    ),
    { numRuns: 100 },
  );
});
