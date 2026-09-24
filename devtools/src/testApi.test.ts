import { test, assert } from "vite-plus/test";
import { buildSubscriberStats } from "./testApi";
import { createSubscriberInstance } from "./signals/subscriber";
import { EMPTY_PLAYBACK_TIMING } from "./utils/playbackTimingStats";

// 公開する統計は「値が無い」を null で表すが、level 0 (最大音量) と
// voiceActivity false (無音) は値があるため、null に潰してはいけない。
test("buildSubscriberStats: Audio Level の 0 と false を保持する", () => {
  const instance = createSubscriberInstance("stats-audio-1");
  instance.audioLastLevel.value = { level: 0, voiceActivity: false };

  const stats = buildSubscriberStats(instance);

  assert.equal(stats.audioLastLevel, 0);
  assert.equal(stats.audioLastVoiceActivity, false);
});

test("buildSubscriberStats: Audio Level が無いときは null にする", () => {
  const instance = createSubscriberInstance("stats-audio-2");
  instance.audioLastLevel.value = null;

  const stats = buildSubscriberStats(instance);

  assert.equal(stats.audioLastLevel, null);
  assert.equal(stats.audioLastVoiceActivity, null);
});

test("buildSubscriberStats: 復号前のレベルは null、復号後は dBFS を返す", () => {
  const instance = createSubscriberInstance("stats-audio-3");
  assert.equal(buildSubscriberStats(instance).audioPeakDbfs, null);
  assert.equal(buildSubscriberStats(instance).audioRmsDbfs, null);

  instance.audioPeakDbfs.value = -6;
  instance.audioRmsDbfs.value = -9;

  const stats = buildSubscriberStats(instance);
  assert.equal(stats.audioPeakDbfs, -6);
  assert.equal(stats.audioRmsDbfs, -9);
});

test("buildSubscriberStats: Group の順序と欠落で捨てた映像フレーム数を返す", () => {
  // 前の Group の遅着 Object (stale) と、参照先が欠けてキーフレームを待つ間の Object
  // (missing-reference) を分けて数える。E2E はこの値で受信した映像の並びを確かめる
  const instance = createSubscriberInstance("dropped-frames");
  instance.staleFramesDropped.value = 5;
  instance.missingReferenceFramesDropped.value = 7;
  const stats = buildSubscriberStats(instance);
  assert.equal(stats.staleFramesDropped, 5);
  assert.equal(stats.missingReferenceFramesDropped, 7);
});

test("buildSubscriberStats: 受信から表示までの時間の統計を返す", () => {
  // 到着の揺らぎ・遅延・復号時間・表示間隔の分布と、止まり・表示キューのあふれの累積を
  // そのまま出す。E2E と実測スクリプトはこの値でかくつきの原因を切り分ける
  const instance = createSubscriberInstance("playback-timing");
  const timing = {
    ...EMPTY_PLAYBACK_TIMING,
    arrivalJitterMs: { p50: 1, p95: 20, max: 300 },
    latencyMs: { p50: 45, p95: 80, max: 1_200 },
    displayFps: 30,
    displayStalls: 4,
    displayStallMs: 900,
    displayQueueDrops: 2,
    playoutDelayMs: 40,
    lateFramesDropped: 3,
  };
  instance.playbackTiming.value = timing;
  assert.deepEqual(buildSubscriberStats(instance).playbackTiming, timing);
  // 購読前は何も記録していない値を返す
  assert.deepEqual(
    buildSubscriberStats(createSubscriberInstance("playback-timing-empty")).playbackTiming,
    EMPTY_PLAYBACK_TIMING,
  );
});
