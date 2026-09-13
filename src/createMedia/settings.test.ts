import { test, assert } from "vite-plus/test";
import {
  DEFAULT_AUDIO_TRACK_NAME,
  DEFAULT_VIDEO_TRACK_NAME,
  resolveAudioPublishSettings,
  resolveVideoPublishSettings,
} from "./settings";
import {
  DEFAULT_AUDIO_CHANNELS,
  DEFAULT_AUDIO_SAMPLE_RATE,
  DEFAULT_VIDEO_FRAMERATE,
} from "../codec/config";

// トラック名・コーデック文字列・既定値の解決を固定する。
// Catalog とエンコーダーが同じ値を使うための解決ロジックであり、
// ここが変わると両者の整合が崩れる。
test("resolveAudioPublishSettings: 省略時は既定値を使う", () => {
  const settings = resolveAudioPublishSettings({ codec: "opus", bitrate: 64000 });
  assert.equal(settings.trackName, DEFAULT_AUDIO_TRACK_NAME);
  assert.equal(settings.codec, "opus");
  assert.equal(settings.codecString, "opus");
  assert.equal(settings.bitrate, 64000);
  assert.equal(settings.sampleRate, DEFAULT_AUDIO_SAMPLE_RATE);
  assert.equal(settings.channels, DEFAULT_AUDIO_CHANNELS);
});

// 明示値はそのまま反映され、aac の codec 文字列は mp4a.40.2 になる。
test("resolveAudioPublishSettings: 明示値と aac の codec 文字列", () => {
  const settings = resolveAudioPublishSettings({
    codec: "aac",
    bitrate: 128000,
    sampleRate: 16000,
    channels: 1,
    trackName: "audio-1",
  });
  assert.equal(settings.trackName, "audio-1");
  assert.equal(settings.codecString, "mp4a.40.2");
  assert.equal(settings.sampleRate, 16000);
  assert.equal(settings.channels, 1);
});

// トラックが無い場合は 640x480 / 既定 framerate にフォールバックする。
test("resolveVideoPublishSettings: トラック未指定は 640x480 にフォールバックする", () => {
  const settings = resolveVideoPublishSettings({ codec: "vp8", bitrate: 1000000 }, undefined);
  assert.equal(settings.trackName, DEFAULT_VIDEO_TRACK_NAME);
  assert.equal(settings.codecString, "vp8");
  assert.equal(settings.width, 640);
  assert.equal(settings.height, 480);
  assert.equal(settings.framerate, DEFAULT_VIDEO_FRAMERATE);
});

// 明示値はトラック設定より優先される。
test("resolveVideoPublishSettings: 明示値が優先される", () => {
  const settings = resolveVideoPublishSettings(
    { codec: "h264", bitrate: 2000000, width: 1280, height: 720, framerate: 15 },
    undefined,
  );
  assert.equal(settings.codecString, "avc1.42001f");
  assert.equal(settings.width, 1280);
  assert.equal(settings.height, 720);
  assert.equal(settings.framerate, 15);
});
