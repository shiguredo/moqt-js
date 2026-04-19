/**
 * MediaSubscriber の純粋関数ロジックのテスト
 */

import { test, assert } from "vite-plus/test";
import { computeAudioPlaybackSchedule } from "./createMediaSubscriber";

test("初回呼び出し (nextPlaybackTime=null) は currentTime + jitterBuffer から開始し resynced=true を返す", () => {
  const result = computeAudioPlaybackSchedule({
    currentTime: 10,
    nextPlaybackTime: null,
    frameDurationSec: 0.02,
    jitterBufferSec: 0.06,
    maxDriftSec: 0.5,
  });
  assert.closeTo(result.startAt, 10.06, 1e-9);
  assert.closeTo(result.nextPlaybackTime, 10.08, 1e-9);
  assert.isTrue(result.resynced);
});

test("連続呼び出しは nextPlaybackTime からスケジュールし resynced=false を返す", () => {
  const result = computeAudioPlaybackSchedule({
    currentTime: 10,
    nextPlaybackTime: 10.06,
    frameDurationSec: 0.02,
    jitterBufferSec: 0.06,
    maxDriftSec: 0.5,
  });
  assert.closeTo(result.startAt, 10.06, 1e-9);
  assert.closeTo(result.nextPlaybackTime, 10.08, 1e-9);
  assert.isFalse(result.resynced);
});

test("nextPlaybackTime が currentTime 未満なら再同期する", () => {
  const result = computeAudioPlaybackSchedule({
    currentTime: 10,
    nextPlaybackTime: 9.5,
    frameDurationSec: 0.02,
    jitterBufferSec: 0.06,
    maxDriftSec: 0.5,
  });
  assert.closeTo(result.startAt, 10.06, 1e-9);
  assert.closeTo(result.nextPlaybackTime, 10.08, 1e-9);
  assert.isTrue(result.resynced);
});

test("nextPlaybackTime が maxDriftSec を超えて先行しているなら再同期する", () => {
  const result = computeAudioPlaybackSchedule({
    currentTime: 10,
    nextPlaybackTime: 10.8,
    frameDurationSec: 0.02,
    jitterBufferSec: 0.06,
    maxDriftSec: 0.5,
  });
  assert.closeTo(result.startAt, 10.06, 1e-9);
  assert.closeTo(result.nextPlaybackTime, 10.08, 1e-9);
  assert.isTrue(result.resynced);
});

test("nextPlaybackTime が currentTime と等しければ連続再生として扱う", () => {
  const result = computeAudioPlaybackSchedule({
    currentTime: 10,
    nextPlaybackTime: 10,
    frameDurationSec: 0.02,
    jitterBufferSec: 0.06,
    maxDriftSec: 0.5,
  });
  assert.closeTo(result.startAt, 10, 1e-9);
  assert.closeTo(result.nextPlaybackTime, 10.02, 1e-9);
  assert.isFalse(result.resynced);
});

test("jitterBufferSec = 0 でも正しく動作する", () => {
  const result = computeAudioPlaybackSchedule({
    currentTime: 10,
    nextPlaybackTime: null,
    frameDurationSec: 0.02,
    jitterBufferSec: 0,
    maxDriftSec: 0.5,
  });
  assert.closeTo(result.startAt, 10, 1e-9);
  assert.closeTo(result.nextPlaybackTime, 10.02, 1e-9);
  assert.isTrue(result.resynced);
});
