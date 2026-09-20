import { test, assert } from "vite-plus/test";
import { buildSubscriberStats } from "./testApi";
import { createSubscriberInstance } from "./signals/subscriber";

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
