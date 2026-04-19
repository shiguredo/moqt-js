/**
 * MediaSubscriber の純粋関数ロジックのプロパティテスト
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { computeAudioPlaybackSchedule } from "./createMediaSubscriber";

// 時間軸は秒単位で正の実数、NaN/Infinity を除外する
const timeArb = fc.double({ min: 0, max: 1e6, noNaN: true, noDefaultInfinity: true });
const positiveDurationArb = fc.double({
  min: Math.fround(0.001),
  max: 1,
  noNaN: true,
  noDefaultInfinity: true,
});
const jitterArb = fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });
const driftArb = fc.double({
  min: Math.fround(0.01),
  max: 5,
  noNaN: true,
  noDefaultInfinity: true,
});

test("startAt は常に currentTime 以上かつ nextPlaybackTime を超えない", () => {
  fc.assert(
    fc.property(
      timeArb,
      fc.option(timeArb, { nil: null }),
      positiveDurationArb,
      jitterArb,
      driftArb,
      (currentTime, nextPlaybackTime, frameDurationSec, jitterBufferSec, maxDriftSec) => {
        const result = computeAudioPlaybackSchedule({
          currentTime,
          nextPlaybackTime,
          frameDurationSec,
          jitterBufferSec,
          maxDriftSec,
        });
        assert.isAtLeast(result.startAt, currentTime);
        assert.isAtLeast(result.nextPlaybackTime, result.startAt);
      },
    ),
  );
});

test("resynced=true の場合 startAt = currentTime + jitterBufferSec になる", () => {
  fc.assert(
    fc.property(
      timeArb,
      fc.option(timeArb, { nil: null }),
      positiveDurationArb,
      jitterArb,
      driftArb,
      (currentTime, nextPlaybackTime, frameDurationSec, jitterBufferSec, maxDriftSec) => {
        const result = computeAudioPlaybackSchedule({
          currentTime,
          nextPlaybackTime,
          frameDurationSec,
          jitterBufferSec,
          maxDriftSec,
        });
        if (result.resynced) {
          assert.closeTo(result.startAt, currentTime + jitterBufferSec, 1e-9);
        }
      },
    ),
  );
});

test("resynced=false の場合 startAt は与えた nextPlaybackTime と等しい", () => {
  fc.assert(
    fc.property(
      timeArb,
      timeArb,
      positiveDurationArb,
      jitterArb,
      driftArb,
      (currentTime, nextPlaybackTime, frameDurationSec, jitterBufferSec, maxDriftSec) => {
        const result = computeAudioPlaybackSchedule({
          currentTime,
          nextPlaybackTime,
          frameDurationSec,
          jitterBufferSec,
          maxDriftSec,
        });
        if (!result.resynced) {
          assert.closeTo(result.startAt, nextPlaybackTime, 1e-9);
          assert.closeTo(result.nextPlaybackTime, nextPlaybackTime + frameDurationSec, 1e-9);
        }
      },
    ),
  );
});

test("next nextPlaybackTime と currentTime の差は maxDriftSec + frameDurationSec を超えない", () => {
  fc.assert(
    fc.property(
      timeArb,
      fc.option(timeArb, { nil: null }),
      positiveDurationArb,
      jitterArb,
      driftArb,
      (currentTime, nextPlaybackTime, frameDurationSec, jitterBufferSec, maxDriftSec) => {
        const result = computeAudioPlaybackSchedule({
          currentTime,
          nextPlaybackTime,
          frameDurationSec,
          jitterBufferSec,
          maxDriftSec,
        });
        // 再同期が効いている場合 nextPlaybackTime - currentTime は jitterBufferSec + frameDurationSec
        // 連続再生の場合 nextPlaybackTime - currentTime は maxDriftSec + frameDurationSec 以下に抑えられている
        const drift = result.nextPlaybackTime - currentTime;
        assert.isAtMost(drift, Math.max(jitterBufferSec, maxDriftSec) + frameDurationSec + 1e-9);
      },
    ),
  );
});
